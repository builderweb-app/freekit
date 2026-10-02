import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { logLine } from './log';
import { OllamaProvider } from './providers/ollama';
import { PROVIDER_LABELS } from './providers';
import { promoPhraseHit, selectors, setAIFinder, SLOTS, SlotName } from './selectors';

const log = (msg: string) => logLine('ai-finder', msg);

/* =========================================================================
 * v0.9.5 — AI-POWERED SELECTOR DISCOVERY
 *
 * Când healer-ul clasic (fingerprint) nu găsește NICIUN candidat valid —
 * sau toate sunt eliminate de blacklist/fragile — extinderea:
 *   1. capturează un snapshot DOM curățat al paginii;
 *   2. îl trimite la Ollama (local, fără cost) cu un prompt de expert;
 *   3. parsează JSON-ul cu selectorii propuși;
 *   4. îi validează în pagina reală (există, vizibil, nu prea generic,
 *      editabil pentru input, text pentru response) + ACELEAȘI garduri de
 *      siguranță ca healer-ul (blacklist/fragile/promo/ecou/user);
 *   5. îi salvează (learn + selectors-user.json) și îi folosește imediat.
 *
 * Fail-open: orice eroare => null, fluxul normal continuă. Rate limiting:
 * cel mult o încercare per provider/slot/site la fiecare 5 minute.
 * ========================================================================= */

export interface DiscoveredSelectors {
  input?: string;
  response?: string;
  newChat?: string;
  stopButton?: string;
  confidence: number;
  reasoning: string;
}

/** Butoanele de „acțiune” nu sunt niciodată newChat/stop (gardă simplă). */
const NON_ACTION_RE = /(^|[^a-z])(sign|signin|sign-in|signup|sign-up|login|log-in|logout|upgrade|premium|invite|subscribe|purchase|checkout|download)([^a-z]|$)/i;

/**
 * Limita de caractere a snapshot-ului. Ollama rulează implicit cu
 * num_ctx 8192 (vezi providers/ollama.ts), deci păstrăm DOM-ul sub ~7k
 * tokeni: head + tail (zonele utile sunt de obicei capul și coada paginii).
 */
export const DOM_MAX_CHARS = 18000;

const AI_RETRY_MS = 5 * 60 * 1000;

interface FinderSettings {
  enabled: boolean;
  timeoutMs: number;
}

function finderSettings(): FinderSettings {
  try {
    // require lazy — în teste Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    const cfg = v.workspace.getConfiguration('freekit');
    const enabled = cfg.get<boolean>('aiSelectorFinder', true);
    const secs = Number(cfg.get<number>('aiFinderTimeoutSeconds', 45));
    const safe = Number.isFinite(secs) ? Math.min(300, Math.max(5, secs)) : 45;
    return { enabled, timeoutMs: safe * 1000 };
  } catch {
    return { enabled: true, timeoutMs: 45000 };
  }
}

/* ---------------- 1) snapshot DOM curățat ---------------- */

export async function captureCleanDom(page: Page): Promise<string> {
  return page.evaluate<string, number>((max) => {
    const clone = (document.body ? document.body.cloneNode(true) : document.createElement('body')) as HTMLElement;

    // zgomot: scripturi, stiluri, media, cookie/GDPR/ads
    clone
      .querySelectorAll(
        'script, style, noscript, iframe, svg, link, meta, template, canvas, video, audio, [class*="cookie"], [class*="gdpr"], [class*="consent"], [class*="advert"]'
      )
      .forEach((el) => el.remove());

    // atribute irelevante (style, on*, data-react*, payload-uri de imagine)
    clone.querySelectorAll('*').forEach((el) => {
      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        const n = attr.name;
        if (
          n === 'style' ||
          n.startsWith('on') ||
          n.startsWith('data-react') ||
          n === 'srcset' ||
          n === 'sizes'
        ) {
          el.removeAttribute(n);
        }
      }
    });

    // valorile din input pot conține date sensibile (parole etc.)
    clone.querySelectorAll('input, textarea').forEach((el) => el.removeAttribute('value'));

    let html = clone.outerHTML;
    if (html.length > max) {
      html = html.slice(0, max / 2) + '\n...[truncat]...\n' + html.slice(-max / 2);
    }
    return html;
  }, DOM_MAX_CHARS);
}

/* ---------------- 2) prompt + apel Ollama ---------------- */

function buildPrompt(providerName: string, url: string, missingSlots: string[], dom: string): string {
  return `You are a DOM analysis expert. Find CSS selectors for a website UI.

WEBSITE: ${providerName}
URL: ${url}

I need selectors for these elements: ${missingSlots.join(', ')}

Element meanings:
- input: the text box where the user types a message
- response: the container holding the AI assistant's LATEST reply (NOT the user's message bubble, NOT the input box, NOT promo/marketing cards)
- newChat: button to start a new conversation
- stopButton: button to stop AI generation (visible only while generating)

DOM SNAPSHOT (cleaned):
\`\`\`html
${dom}
\`\`\`

INSTRUCTIONS:
1. Find each requested element in the snapshot.
2. Use STABLE selectors: prefer data-testid > id > aria-label > role > semantic tag > class. Use at most 1-2 classes; NEVER :nth-child / :nth-of-type / positional paths.
3. AVOID: deeply nested CSS, obfuscated/hashed classes, cookie banners, sidebars, headers, footers, promotional/upsell cards.
4. If an element does not exist in the snapshot, return null for it.
5. Respond with ONLY one JSON object (no markdown fences, no explanation):
{
  "input": "css selector or null",
  "response": "css selector or null",
  "newChat": "css selector or null",
  "stopButton": "css selector or null",
  "confidence": 0.0,
  "reasoning": "short explanation"
}`;
}

/** Extrage primul obiect JSON echilibrat din text (ignoră string-urile). */
function extractJsonObject(text: string): string | null {
  const t = String(text || '');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence?.[1] ?? '', t];
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return c.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseAIResponse(reply: string): DiscoveredSelectors | null {
  const raw = extractJsonObject(reply);
  if (!raw) {
    log('niciun JSON găsit în răspunsul AI');
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    log('JSON invalid în răspunsul AI: ' + (e?.message ?? String(e)));
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const pick = (k: string): string | undefined => {
    const v = parsed[k];
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    if (!s || s.length > 300) return undefined;
    const low = s.toLowerCase();
    if (low === 'null' || low === 'none' || low === 'n/a') return undefined;
    return s;
  };
  const conf = Number(parsed.confidence);
  const result: DiscoveredSelectors = {
    input: pick('input'),
    response: pick('response'),
    newChat: pick('newChat'),
    stopButton: pick('stopButton'),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
    reasoning:
      typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 300) : ''
  };
  return result;
}

/**
 * Trimite snapshot-ul DOM la Ollama și întoarce selectorii propuși (sau null).
 */
export async function findSelectorsWithAI(
  page: Page,
  providerName: string,
  missingSlots: string[]
): Promise<DiscoveredSelectors | null> {
  log('caut selectori cu AI pentru ' + providerName + ' (lipsesc: ' + missingSlots.join(',') + ')');

  let url = '';
  try {
    url = page.url();
  } catch {
    /* pagină închisă — mergem mai departe cu URL gol */
  }

  let dom = '';
  try {
    dom = await captureCleanDom(page);
  } catch (e: any) {
    log('captura DOM a eșuat: ' + (e?.message ?? String(e)));
    return null;
  }
  log('DOM capturat: ' + dom.length + ' caractere');

  const prompt = buildPrompt(providerName, url, missingSlots, dom);
  const settings = finderSettings();
  const ollama = new OllamaProvider();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await ollama.open();
      return await ollama.send(undefined, prompt, controller.signal);
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout după ' + Math.round(settings.timeoutMs / 1000) + 's'));
      }, settings.timeoutMs);
    });
    const reply = await Promise.race([work, timeout]);
    log('răspuns AI: ' + reply.length + ' caractere');
    return parseAIResponse(reply);
  } catch (e: any) {
    log('analiza AI a eșuat: ' + (e?.message ?? String(e)));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------- 3) validare în pagina reală ---------------- */

interface SlotProbe {
  count: number;
  visible?: boolean;
  text?: string;
  editable?: boolean;
  role?: string | null;
  userAncestor?: boolean;
}

export interface ValidateOptions {
  /** Mesajul tocmai trimis — respinge selectori de response care îl citesc (ecou). */
  echoText?: string;
}

function normText(t: string): string {
  return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Textul NU are voie să conțină mesajul tocmai trimis (containere de
 *  conversație, inclusiv cu istoric înainte) — ca garda din scan / isEchoOf.
 *  Doar mesaje lungi (≥40), ca cele scurte să nu respingă răspunsuri. */
function echoContains(text: string, message: string): boolean {
  const m = normText(message);
  if (m.length < 40) return false;
  return normText(text).indexOf(m) >= 0;
}

function assignSlot(target: DiscoveredSelectors, slot: SlotName, selector: string) {
  if (slot === 'input') target.input = selector;
  else if (slot === 'response') target.response = selector;
  else if (slot === 'newChat') target.newChat = selector;
  else target.stopButton = selector;
}

/**
 * Validează selectorii propuși de AI în pagina reală (fără să învețe nimic).
 * Aplică aceleași reguli de siguranță ca scanul healer-ului: nu acceptăm
 * căsuța de input ca „response”, bula userului, texte promo sau ecouri.
 */
export async function validateSelectors(
  page: Page,
  discovered: DiscoveredSelectors,
  opts: ValidateOptions = {}
): Promise<DiscoveredSelectors> {
  const valid: DiscoveredSelectors = {
    confidence: discovered.confidence,
    reasoning: discovered.reasoning
  };

  for (const slot of SLOTS) {
    const sel = discovered[slot];
    if (!sel) continue;
    try {
      const probe = await page.evaluate<SlotProbe, { s: string; sl: string }>(
        (args) => {
          let nodes: NodeListOf<Element>;
          try {
            nodes = document.querySelectorAll(args.s);
          } catch {
            return { count: -1 };
          }
          const count = nodes.length;
          if (count === 0 || count > 20) return { count };
          const el = (args.sl === 'response' ? nodes[count - 1] : nodes[0]) as HTMLElement;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          const visible =
            r.width >= 6 && r.height >= 6 && st.visibility !== 'hidden' && st.display !== 'none';
          const text = ((el.innerText || el.textContent || '') as string).trim();
          const editable =
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'INPUT' ||
            el.isContentEditable === true ||
            el.getAttribute('contenteditable') === 'true';
          let userAncestor = false;
          let up: Element | null = el;
          let depth = 0;
          while (up && depth < 6) {
            const cls = typeof (up as HTMLElement).className === 'string' ? (up as HTMLElement).className : '';
            const ids = up.getAttribute('id') || '';
            if (/(^|[\s_-])user([\s_-]|$)/i.test(cls + ' ' + ids)) {
              userAncestor = true;
              break;
            }
            up = up.parentElement;
            depth++;
          }
          return { count, visible, text, editable, role: el.getAttribute('role'), userAncestor };
        },
        { s: sel, sl: slot }
      );

      if (!probe || probe.count === -1) {
        log('respins ' + slot + ' (selector invalid): ' + sel);
        continue;
      }
      if (probe.count === 0) {
        log('respins ' + slot + ' (0 potriviri): ' + sel);
        continue;
      }
      if (probe.count > 20) {
        log('respins ' + slot + ' (prea generic, ' + probe.count + ' potriviri): ' + sel);
        continue;
      }
      if (!probe.visible) {
        log('respins ' + slot + ' (invizibil): ' + sel);
        continue;
      }
      if (slot === 'input' && !probe.editable) {
        log('respins input (nu e editabil): ' + sel);
        continue;
      }
      if (slot === 'response') {
        if (probe.editable || probe.role === 'textbox') {
          log('respins response (e căsuța de input): ' + sel);
          continue;
        }
        if (probe.userAncestor) {
          log('respins response (bulă de user): ' + sel);
          continue;
        }
        const text = String(probe.text || '');
        if (text.length < 8) {
          log('respins response (fără text de răspuns): ' + sel);
          continue;
        }
        const phrase = promoPhraseHit(text);
        if (phrase) {
          log('respins response (text promo „' + phrase + '”): ' + sel);
          continue;
        }
        if (opts.echoText && echoContains(text, opts.echoText)) {
          log('respins response (conține mesajul trimis): ' + sel);
          continue;
        }
      }
      if ((slot === 'newChat' || slot === 'stopButton') && NON_ACTION_RE.test(sel)) {
        log('respins ' + slot + ' (buton non-acțiune): ' + sel);
        continue;
      }
      assignSlot(valid, slot, sel);
      log('validat ' + slot + ': ' + sel + ' (' + probe.count + ' potriviri)');
    } catch (e: any) {
      log('respins ' + slot + ' (' + (e?.message ?? String(e)) + '): ' + sel);
    }
  }
  return valid;
}

/* ---------------- 4) selectors-user.json (globalStorage) ---------------- */

const USER_FILE_NAME = 'selectors-user.json';
let storageDir: string | null = null;

export function userSelectorsFilePath(): string | null {
  return storageDir ? path.join(storageDir, USER_FILE_NAME) : null;
}

/** Rescrie fișierul din override-urile învățate cu how='ai' (sursa de adevăr). */
export function saveUserSelectors(): void {
  const file = userSelectorsFilePath();
  if (!file) return;
  const providers: Record<string, Record<string, unknown>> = {};
  let count = 0;
  for (const item of selectors.listLearned()) {
    if (item.how !== 'ai') continue;
    if (!providers[item.provider]) providers[item.provider] = {};
    providers[item.provider][item.slot] = {
      selector: item.selector,
      how: item.how,
      at: item.at,
      confidence: item.confidence,
      reasoning: item.reasoning
    };
    count++;
  }
  const payload = { version: 1, updated: new Date().toISOString(), providers };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    log('selectors-user.json salvat (' + count + ' selectori AI)');
  } catch (e: any) {
    log('scrierea selectors-user.json a eșuat: ' + (e?.message ?? String(e)));
  }
}

/** Încarcă selectors-user.json la pornire (intrările invalide se șterg). */
function loadUserSelectorsFromDisk(): void {
  const file = userSelectorsFilePath();
  if (!file || !fs.existsSync(file)) return;
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    log('selectors-user.json invalid — ignorat: ' + (e?.message ?? String(e)));
    return;
  }
  const providers = data?.providers;
  if (!providers || typeof providers !== 'object') return;

  let loaded = 0;
  let pruned = 0;
  for (const [pid, slots] of Object.entries<any>(providers)) {
    if (!slots || typeof slots !== 'object') continue;
    for (const slot of SLOTS) {
      const entry = slots[slot];
      const sel = typeof entry === 'string' ? entry : entry?.selector;
      if (typeof sel !== 'string' || !sel.trim()) continue;
      const meta =
        entry && typeof entry === 'object'
          ? { confidence: Number(entry.confidence), reasoning: String(entry.reasoning || '') }
          : undefined;
      const ok = selectors.learn(pid, slot, sel.trim(), 'ai', meta);
      if (ok) {
        loaded++;
      } else {
        pruned++;
        log('selectors-user.json: „' + pid + '.' + slot + '” respins la încărcare — ' + sel);
      }
    }
  }
  if (loaded) log('selectors-user.json: ' + loaded + ' selectori încărcați');
  if (pruned) saveUserSelectors(); // rescrie fără intrările respinse
}

/* ---------------- 5) adaptorul pentru healSlot ---------------- */

const recentAttempts = new Map<string, number>();
const inFlight = new Set<string>();

/** Doar pentru teste: resetează rate limiting-ul. */
export function resetAIFinderCache(): void {
  recentAttempts.clear();
  inFlight.clear();
}

async function discoverForHealer(
  page: Page,
  providerId: string,
  slot: SlotName,
  echoText?: string
): Promise<string | null> {
  const settings = finderSettings();
  if (!settings.enabled) {
    log('AI finder dezactivat (freekit.aiSelectorFinder=false)');
    return null;
  }

  let host = '?';
  try {
    host = new URL(page.url()).origin;
  } catch {
    /* URL nevalid — folosim cheia '?' */
  }
  const key = providerId + ':' + slot + ':' + host;
  const last = recentAttempts.get(key) ?? 0;
  if (Date.now() - last < AI_RETRY_MS) {
    log('AI finder: încercare recentă pentru ' + key + ' — sar peste');
    return null;
  }
  if (inFlight.has(key)) {
    log('AI finder: deja în curs pentru ' + key);
    return null;
  }
  inFlight.add(key);
  recentAttempts.set(key, Date.now());
  try {
    const label = PROVIDER_LABELS[providerId] || providerId;
    const discovered = await findSelectorsWithAI(page, label, [slot]);
    if (!discovered) return null;

    const validated = await validateSelectors(page, discovered, { echoText });
    const applied: string[] = [];
    let found: string | null = null;
    for (const s of SLOTS) {
      const sel = validated[s];
      if (!sel) continue;
      const stored = selectors.learn(providerId, s, sel, 'ai', {
        confidence: validated.confidence,
        reasoning: validated.reasoning
      });
      if (stored) {
        applied.push(s + '=' + sel);
        if (s === slot) found = sel;
      } else {
        log('AI finder: respins la salvare (' + s + '): ' + sel);
      }
    }
    if (applied.length) {
      saveUserSelectors();
      log(
        'AI finder: salvat ' +
          applied.join(', ') +
          ' (încredere ' +
          validated.confidence +
          ', „' +
          validated.reasoning +
          '”)'
      );
    }
    return found;
  } catch (e: any) {
    log('AI finder a eșuat: ' + (e?.message ?? String(e)));
    return null;
  } finally {
    inFlight.delete(key);
  }
}

/** Înregistrează fallback-ul AI + încarcă selectors-user.json (la activate()). */
export function initAISelectorFinder(storageFsPath: string): void {
  storageDir = storageFsPath || null;
  setAIFinder(discoverForHealer);
  loadUserSelectorsFromDisk();
  log(
    'AI selector finder pregătit — fișier: ' +
      (userSelectorsFilePath() || '(fără globalStorage)')
  );
}
