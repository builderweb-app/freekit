import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { logLine } from './log';
import { listOllamaModelsDetailed, OllamaProvider } from './providers/ollama';
import { PROVIDER_LABELS } from './providers';
import { AI_FINDER_MODEL_AUTO, isAutoAiFinderModel, pickAiFinderModel } from './aiFinderModel';
import { isEmbeddingModel } from './hardware';
import { getLastResponseText, promoPhraseHit, selectors, setAIFinder, SLOTS, SlotName } from './selectors';

const log = (msg: string) => logLine('ai-finder', msg);
/** v2.5.44 (bug #101): același tag ca healer-ul din selectors.ts. */
const healLog = (msg: string) => logLine('healer', msg);

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
 * v2.5.41 (bug #95/#96): pasul 1 trimite DOAR elementele interactive (plus
 * strămoșii lor) în loc de tot HTML-ul, iar pasul 4 e strict pentru căsuța de
 * chat (vizibil, activ, acceptă text, în viewport, în jumătatea de jos). Dacă
 * selectorul propus nu trece, analiza se reia cu un prompt mai specific (max
 * AI_FINDER_MAX_ATTEMPTS) și, dacă nici așa nu iese nimic, NU se salvează nimic.
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
 *
 * v2.5.41 (bug #96): lista candidaților interacți are prioritate în acest
 * buget; doar DOM-ul filtrat de după ea se trunchiază (head + tail).
 */
export const DOM_MAX_CHARS = 18000;

/**
 * v2.5.41 (bug #95): câte încercări de analiză facem pentru un set de sloturi.
 * Prima are promptul normal; următoarele primesc în plus motivul respingerii
 * („prompt mai specific"), ca modelul să nu propună din nou același element.
 */
export const AI_FINDER_MAX_ATTEMPTS = 3;

/**
 * v2.5.41 (bug #96): ce ajunge în snapshot. HTML-ul complet al unui chat
 * înseamnă mii de div-uri — modelul local se pierde în ele și alege exact ce
 * nu trebuie (ex: inputul ascuns `aria-label="Line wrap"` din ChatGPT). Trimitem
 * doar elementele interactive, plus strămoșii lor (ca modelul să poată compune
 * selectorul); butoanele rămân incluse, altfel sloturile newChat/stopButton ar
 * rămâne fără nicio informație. Textul conversației se adaugă separat, doar când
 * căutăm containerul de răspuns (acolo e chiar informația utilă).
 */
export const INTERACTIVE_FILTER = [
  'textarea',
  'input',
  'button',
  '[role="button"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[aria-label*="message" i]',
  '[aria-label*="chat" i]',
  '[aria-label*="prompt" i]',
  '[aria-label*="input" i]'
].join(', ');

/** Câți candidați interacți încăpem în prompt (restul e zgomot). */
const MAX_SNAPSHOT_CANDIDATES = 25;

/** Un nod de text mai scurt de atât nu ajută la găsirea răspunsului. */
const MIN_TEXT_CHARS = 40;

/**
 * v2.5.17 (bug #44): 45 s era insuficient pentru un snapshot de ~19k caractere
 * analizat de un model local de 7B („analiza AI a eșuat: timeout after 45s").
 * 120 s acoperă analiza pe hardware modest fără să blocheze prea mult bucla.
 * Valoarea e și default-ul setării `freekit.aiFinderTimeoutSeconds`.
 */
export const DEFAULT_AI_FINDER_TIMEOUT_SECONDS = 120;

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
    const secs = Number(
      cfg.get<number>('aiFinderTimeoutSeconds', DEFAULT_AI_FINDER_TIMEOUT_SECONDS)
    );
    const safe = Number.isFinite(secs)
      ? Math.min(300, Math.max(5, secs))
      : DEFAULT_AI_FINDER_TIMEOUT_SECONDS;
    return { enabled, timeoutMs: safe * 1000 };
  } catch {
    return { enabled: true, timeoutMs: DEFAULT_AI_FINDER_TIMEOUT_SECONDS * 1000 };
  }
}

/* ------------------- modelul Ollama pentru AI finder ------------------- */

/** v2.5.40 (bug #93): valoarea setării `freekit.aiFinderModel`. */
function aiFinderModelSetting(): string {
  try {
    const v = require('vscode') as typeof import('vscode');
    const raw = v.workspace
      .getConfiguration('freekit')
      .get<string>('aiFinderModel', AI_FINDER_MODEL_AUTO);
    return String(raw ?? '').trim();
  } catch {
    return AI_FINDER_MODEL_AUTO;
  }
}

/**
 * v2.5.40 (bug #93) — rezolvă modelul folosit de AI selector finder.
 *
 * Înainte finder-ul folosea `freekit.ollamaModel`; dacă acolo era un model
 * neinstalat (ex. `gemma3:12b`), analiza nu mai pornea deloc deși pe mașină
 * existau modele utilizabile. Acum:
 *   - `auto` (implicit) → `gemma3:12b` dacă e instalat, altfel primul model de
 *     chat după preferință (qwen2.5-coder > qwen-coder > qwen > llama >
 *     mistral > orice altul), embeddings excluse;
 *   - model explicit instalat → îl folosim;
 *   - model explicit lipsă, sau doar embeddings instalate → warning clar în log
 *     și `null` (fail-open, ca înainte, dar fără eroarea înșelătoare de 404).
 */
export async function resolveAiFinderModel(): Promise<string | null> {
  const requested = aiFinderModelSetting();
  const installed = (await listOllamaModelsDetailed()).map((m) => m.name);

  if (!isAutoAiFinderModel(requested)) {
    // Lista goală = Ollama oprit: lăsăm providerul să dea eroarea lui tipizată
    // („Ollama down"), nu una de model lipsă.
    if (installed.length && !installed.includes(requested)) {
      log(
        'model "' +
          requested +
          '" (freekit.aiFinderModel) is not installed — installed: ' +
          installed.join(', ')
      );
      return null;
    }
    log('using model ' + requested + ' (freekit.aiFinderModel)');
    return requested;
  }

  const choice = pickAiFinderModel(installed);
  if (!choice) {
    const embeddings = installed.filter((m) => isEmbeddingModel(m));
    log(
      'no chat model available for the AI analysis' +
        (embeddings.length
          ? ' — only embeddings installed: ' + embeddings.join(', ')
          : ' — installed: ' + (installed.join(', ') || 'none')) +
        '; install one (e.g. `ollama pull qwen2.5-coder:7b`) or set freekit.aiFinderModel'
    );
    return null;
  }
  log('using model ' + choice.model + ' (' + choice.reason + ')');
  return choice.model;
}

/* ---------------- 1) snapshot DOM filtrat ---------------- */

/** Datele brute ale unui element interactiv, citite din pagină (bug #95/#96). */
export interface InputCandidateProbe {
  tagName: string;
  /** `type` de <input>, lower-case; '' dacă atributul lipsește (= text). */
  type: string;
  role: string;
  contenteditable: string;
  isContentEditable: boolean;
  className: string;
  disabled: boolean;
  ariaDisabled: boolean;
  display: string;
  visibility: string;
  opacity: string;
  rect: { x: number; y: number; width: number; height: number };
  /** id/name/type/role/aria-label/placeholder/data-testid/contenteditable/class */
  attrs: string;
}

export interface InputCandidateCheck {
  visible: boolean;
  enabled: boolean;
  acceptsText: boolean;
  inViewport: boolean;
  nearBottom: boolean;
  ok: boolean;
  /** Primul criteriu picat — ajunge în log și în promptul de reîncercare. */
  reason?: string;
}

/** Tipurile de <input> care acceptă text ('' = atribut lipsă → text implicit). */
const TEXT_INPUT_TYPES = ['text', 'search', ''];

/** Editori bogați (Claude/Gemini etc.): rădăcina lor nu are contenteditable. */
const EDITOR_CLASS_RE = /ProseMirror|ql-editor|contenteditable/i;

/**
 * v2.5.41 (bug #95): „acceptă text" — singura definiție a căsuței de chat,
 * folosită și la pre-filtrarea DOM-ului (bug #96) și la validarea strictă.
 */
export function acceptsTextInput(
  p: Pick<
    InputCandidateProbe,
    'tagName' | 'type' | 'contenteditable' | 'isContentEditable' | 'className'
  >
): boolean {
  const tag = String(p.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.indexOf(p.type) >= 0;
  if (p.contenteditable === 'true' || p.isContentEditable === true) return true;
  return EDITOR_CLASS_RE.test(p.className || '');
}

/**
 * v2.5.41 (bug #95): toate criteriile unui candidat de căsuță de chat. La
 * rulare e folosit întotdeauna PRIMUL element al selectorului (vezi
 * resolveSlot), deci exact primul element trebuie să treacă de toate.
 */
export function checkInputCandidate(
  p: InputCandidateProbe,
  viewport: { width: number; height: number }
): InputCandidateCheck {
  const r = p.rect;
  const visible =
    r.width >= 6 &&
    r.height >= 6 &&
    p.display !== 'none' &&
    p.visibility !== 'hidden' &&
    Number(p.opacity) > 0;
  const enabled = !p.disabled && !p.ariaDisabled;
  const acceptsText = acceptsTextInput(p);
  const inViewport =
    r.y + r.height > 0 && r.y < viewport.height && r.x + r.width > 0 && r.x < viewport.width;
  // căsuța de chat e „lipită" de marginea de jos a paginii
  const nearBottom = r.y > viewport.height * 0.5;

  let reason: string | undefined;
  if (!visible) reason = 'not visible';
  else if (!enabled) reason = 'disabled';
  else if (!acceptsText) reason = 'does not accept text';
  else if (!inViewport) reason = 'outside the viewport';
  else if (!nearBottom) reason = 'not near the bottom of the page';

  return { visible, enabled, acceptsText, inViewport, nearBottom, ok: !reason, reason };
}

/** Linia din snapshot pe care o citește modelul pentru un candidat (bug #96). */
export function formatCandidateLine(
  n: number,
  p: InputCandidateProbe,
  viewport: { width: number; height: number }
): string {
  const c = checkInputCandidate(p, viewport);
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return (
    '#' +
    n +
    ' <' +
    String(p.tagName || '').toLowerCase() +
    '> ' +
    (p.attrs || '(fără atribute)') +
    ' | visible=' +
    yn(c.visible) +
    ' enabled=' +
    yn(c.enabled) +
    ' acceptsText=' +
    yn(c.acceptsText) +
    ' inViewport=' +
    yn(c.inViewport) +
    ' y=' +
    Math.round(p.rect.y) +
    ' x=' +
    Math.round(p.rect.x) +
    ' w=' +
    Math.round(p.rect.width) +
    ' h=' +
    Math.round(p.rect.height)
  );
}

/** Citește din pagină datele brute ale elementelor care potrivesc un selector. */
async function probeInputCandidates(
  page: Page,
  selector: string,
  limit = MAX_SNAPSHOT_CANDIDATES
): Promise<{
  count: number;
  viewport: { width: number; height: number };
  probes: InputCandidateProbe[];
}> {
  return page.evaluate<
    {
      count: number;
      viewport: { width: number; height: number };
      probes: InputCandidateProbe[];
    },
    { selector: string; limit: number }
  >(
    (args) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(args.selector);
      } catch {
        return { count: -1, viewport, probes: [] };
      }
      const attrKeys = [
        'id',
        'name',
        'type',
        'role',
        'aria-label',
        'placeholder',
        'data-testid',
        'contenteditable'
      ];
      const probes: InputCandidateProbe[] = [];
      for (let i = 0; i < nodes.length && probes.length < args.limit; i++) {
        const el = nodes[i] as HTMLElement;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const cls = typeof el.className === 'string' ? el.className : '';
        const attrs: string[] = [];
        for (const key of attrKeys) {
          const v = el.getAttribute(key);
          if (v) attrs.push(key + '="' + String(v).slice(0, 80) + '"');
        }
        if (cls) attrs.push('class="' + cls.slice(0, 120) + '"');
        probes.push({
          tagName: el.tagName,
          type: (el.getAttribute('type') || '').toLowerCase(),
          role: el.getAttribute('role') || '',
          contenteditable: el.getAttribute('contenteditable') || '',
          isContentEditable: el.isContentEditable === true,
          className: cls,
          disabled: (el as HTMLInputElement).disabled === true,
          ariaDisabled: el.getAttribute('aria-disabled') === 'true',
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          attrs: attrs.join(' ')
        });
      }
      return { count: nodes.length, viewport, probes };
    },
    { selector, limit }
  );
}

/**
 * HTML-ul curățat: doar candidații interacți (plus strămoșii lor, ca selectorul
 * să poată fi compus) și — opțional — nodurile cu text. Cu `skipFilter` întoarce
 * tot DOM-ul curățat (comportamentul dinainte de v2.5.41, folosit de raportarea
 * de bug).
 */
async function captureFilteredHtml(
  page: Page,
  opts: { includeText: boolean; skipFilter?: boolean }
): Promise<string> {
  return page.evaluate<
    string,
    { filter: string; includeText: boolean; minText: number; skipFilter: boolean }
  >(
    (cfg) => {
      const body = document.body;
      if (!body) return '(fără body)';

      const noiseTags = [
        'SCRIPT',
        'STYLE',
        'NOSCRIPT',
        'IFRAME',
        'SVG',
        'LINK',
        'META',
        'TEMPLATE',
        'CANVAS',
        'VIDEO',
        'AUDIO'
      ];
      const noiseClassRe = /cookie|gdpr|consent|advert/i;

      const clone = body.cloneNode(true) as HTMLElement;
      // cloneNode păstrează ordinea: indexul din `keep` e valabil pentru ambele
      // liste (clonatul e încă intact, nu am șters nimic)
      const live = Array.from(body.querySelectorAll('*'));
      const cloned = Array.from(clone.querySelectorAll('*'));
      const index = new Map<Element, number>();
      for (let i = 0; i < live.length; i++) index.set(live[i], i);

      const keep = new Uint8Array(live.length);
      const mark = (el: Element | null) => {
        let node: Element | null = el;
        while (node && node !== body) {
          const i = index.get(node);
          if (i === undefined || keep[i]) return;
          keep[i] = 1;
          node = node.parentElement;
        }
      };

      if (!cfg.skipFilter) {
        for (let i = 0; i < live.length; i++) {
          const el = live[i];
          if (noiseTags.indexOf(el.tagName) >= 0) continue;
          if (noiseClassRe.test(el.getAttribute('class') || '')) continue;
          let interactive = false;
          try {
            interactive = el.matches(cfg.filter);
          } catch {
            interactive = false;
          }
          if (interactive) mark(el);
        }

        if (cfg.includeText) {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          let t: Node | null = walker.nextNode();
          while (t) {
            const parent = t.parentElement;
            if (
              (t.nodeValue || '').trim().length >= cfg.minText &&
              parent &&
              noiseTags.indexOf(parent.tagName) < 0
            ) {
              mark(parent);
            }
            t = walker.nextNode();
          }
        }
      }

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

      // v2.5.41 (bug #96): aruncăm tot ce nu e candidat sau strămoș al unuia —
      // de la coadă spre cap (un nod fără descendenți păstrați nu are ce șterge)
      if (!cfg.skipFilter) {
        for (let i = cloned.length - 1; i >= 0; i--) {
          if (!keep[i]) cloned[i].remove();
        }
      }

      return clone.outerHTML;
    },
    {
      filter: INTERACTIVE_FILTER,
      includeText: opts.includeText,
      minText: MIN_TEXT_CHARS,
      skipFilter: opts.skipFilter === true
    }
  );
}

/** Marcajul de trunchiere (ține lungimea sub buget, vezi truncateHtml). */
const TRUNC_MARK = '\n...[truncat]...\n';

/** Head + tail, ca înainte: zonele utile sunt capul și coada paginii. */
function truncateHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  const half = Math.floor(Math.max(0, max - TRUNC_MARK.length) / 2);
  return html.slice(0, half) + TRUNC_MARK + html.slice(-half);
}

export interface DomCaptureOptions {
  /**
   * Păstrează și nodurile cu text (implicit `true`). Se dezactivează când
   * căutăm căsuța de input / butoanele: textul conversației e exact zgomotul
   * care face un model mic să aleagă alt element.
   */
  includeText?: boolean;
  /**
   * v2.5.41: snapshot-ul COMPLET curățat (fără pre-filtrare, fără lista de
   * candidați) — comportamentul de dinainte, folosit de raportarea de bug
   * (`probeProviderSelectors`), unde dezvoltatorul vrea toată structura
   * paginii. Analiza AI nu îl folosește niciodată.
   */
  full?: boolean;
}

/**
 * Snapshot-ul trimis modelului (bug #96): lista candidaților interacți, cu
 * vizibilitatea/poziția deja calculate (ca modelul să nu ghicească), urmată de
 * DOM-ul filtrat (candidații și strămoșii lor). Lista are prioritate la
 * trunchiere, ca să nu rămână modelul fără elementele în care trebuie să aleagă.
 */
export async function captureCleanDom(page: Page, opts: DomCaptureOptions = {}): Promise<string> {
  if (opts.full) {
    return truncateHtml(
      await captureFilteredHtml(page, { includeText: true, skipFilter: true }),
      DOM_MAX_CHARS
    );
  }
  const includeText = opts.includeText !== false;
  const snapshot = await probeInputCandidates(page, INTERACTIVE_FILTER);
  const html = await captureFilteredHtml(page, { includeText });

  const lines = snapshot.probes.map((p, i) => formatCandidateLine(i + 1, p, snapshot.viewport));
  if (snapshot.count > snapshot.probes.length) {
    lines.push(
      '... +' + (snapshot.count - snapshot.probes.length) + ' more interactive elements'
    );
  }
  const candidates =
    'VIEWPORT: ' +
    Math.round(snapshot.viewport.width) +
    'x' +
    Math.round(snapshot.viewport.height) +
    '\nINTERACTIVE CANDIDATES (' +
    Math.max(0, snapshot.count) +
    ', in DOM order):\n' +
    (lines.join('\n') || '(none)');

  const budget = Math.max(2000, DOM_MAX_CHARS - candidates.length);
  let out =
    candidates +
    '\n\nFILTERED DOM (only those candidates, their ancestors' +
    (includeText ? ' and text blocks' : '') +
    '; noise removed):\n' +
    truncateHtml(html, budget);
  if (out.length > DOM_MAX_CHARS) {
    out = out.slice(0, DOM_MAX_CHARS - TRUNC_MARK.length) + TRUNC_MARK;
  }
  return out;
}

/* ---------------- 2) prompt + apel Ollama ---------------- */

export interface PromptContext {
  providerName: string;
  url: string;
  missingSlots: string[];
  dom: string;
  /** 1 = prima încercare; 2+ = reîncercare după un selector respins. */
  attempt: number;
  /** De ce a fost respinsă încercarea anterioară („prompt mai specific"). */
  failureReason?: string;
  rejectedSelector?: string;
}

/**
 * v2.5.41 (bug #96): promptul spune exact ce e căsuța de chat (jos, vizibilă,
 * activă, acceptă text), cum se citește lista de candidați și ce NU are voie să
 * aleagă (inputuri ascunse, upload, căutare, „Line wrap" etc.). La reîncercare
 * primește și motivul respingerii, ca să nu repete același element.
 */
export function buildPrompt(ctx: PromptContext): string {
  const lines: string[] = [
    'You are a DOM analysis expert. Find CSS selectors for a website UI.',
    '',
    'WEBSITE: ' + ctx.providerName,
    'URL: ' + ctx.url,
    'I need selectors for these elements: ' + ctx.missingSlots.join(', '),
    '',
    'Element meanings:',
    '- input: THE CHAT INPUT — the text box where the user types a message. It sits in the',
    "  BOTTOM HALF of the page and it is VISIBLE, ENABLED and accepts typed text: a <textarea>,",
    '  an <input type="text">/<input type="search">, a <div contenteditable="true"> (often with',
    '  class ProseMirror or ql-editor) or an element with role="textbox".',
    "- response: the container holding the AI assistant's LATEST reply (NOT the user's message bubble, NOT the input box, NOT promo/marketing cards)",
    '- newChat: button to start a new conversation',
    '- stopButton: button to stop AI generation (visible only while generating)',
    '',
    'HOW TO READ THE SNAPSHOT:',
    '1. INTERACTIVE CANDIDATES lists the interactive elements of the page (inputs, editors,',
    '   buttons) in DOM order, with their attributes and with flags already computed for you.',
    '2. FILTERED DOM shows those elements inside their real ancestor chain — take the selector',
    '   from there (prefer id, then aria-label/data-testid, then role, then a stable class).',
    '',
    'INSTRUCTIONS:',
    '1. For "input" pick ONLY a candidate with visible=yes, enabled=yes, acceptsText=yes and',
    '   inViewport=yes, and prefer the one with the LARGEST y — the composer is at the bottom.',
    '2. NEVER pick: hidden inputs (type="hidden"), file/upload inputs, off-screen, zero-size or',
    '   disabled controls, search boxes, theme/spellcheck/"Line wrap" helpers, cookie banners,',
    '   sidebars, headers, footers or promotional cards.',
    '3. The selector must match the element in the REAL page (the snapshot comes from it):',
    '   never invent ids/classes, and do not use the candidate numbering.',
    '4. Use STABLE selectors: prefer data-testid > id > aria-label > role > semantic tag > class.',
    '   Use at most 1-2 classes; NEVER :nth-child / :nth-of-type / positional paths.',
    '5. If an element does not exist in the snapshot, return null for it.'
  ];

  if (ctx.attempt > 1 && ctx.failureReason) {
    lines.push(
      '',
      'ATTEMPT ' + ctx.attempt + ' OF ' + AI_FINDER_MAX_ATTEMPTS + ' — YOUR PREVIOUS ANSWER WAS REJECTED:',
      '- rejected selector: ' + (ctx.rejectedSelector || '(none)'),
      '- why it was rejected: ' + ctx.failureReason,
      'That element is NOT the chat input. Read INTERACTIVE CANDIDATES again and answer with a',
      'DIFFERENT element that satisfies rule 1 (visible=yes, enabled=yes, acceptsText=yes,',
      'inViewport=yes, largest y). If no candidate qualifies, return null.'
    );
  }

  lines.push(
    '',
    'DOM SNAPSHOT:',
    '```',
    ctx.dom,
    '```',
    '',
    'Respond with ONLY one JSON object (no markdown fences, no explanation):',
    '{',
    '  "input": "css selector or null",',
    '  "response": "css selector or null",',
    '  "newChat": "css selector or null",',
    '  "stopButton": "css selector or null",',
    '  "confidence": 0.0,',
    '  "reasoning": "short explanation"',
    '}'
  );
  return lines.join('\n');
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

/** Un apel complet (open + send) cu timeout-ul din setări. */
async function askOllama(
  ollama: OllamaProvider,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await ollama.open();
      return await ollama.send(undefined, prompt, controller.signal);
    })();
    // v2.5.17 (bug #44): la timeout promisiunea pierzătoare e abandonată —
    // fără handler, reject-ul ei ajunge „unhandled rejection" în extension host.
    work.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('timeout after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * v2.5.41 (bug #95): verifică strict sloturile cerute. Doar căsuța de chat are
 * criterii proprii (vizibil, activ, acceptă text, în viewport, în jumătatea de
 * jos); restul sloturilor trec mai departe de regulile generale din
 * validateSelectors().
 */
async function checkRequestedSlots(
  page: Page,
  discovered: DiscoveredSelectors,
  missingSlots: string[]
): Promise<{ ok: true } | { ok: false; reason: string; selector?: string }> {
  for (const slot of SLOTS) {
    if (missingSlots.indexOf(slot) < 0) continue;
    const sel = discovered[slot];
    if (!sel) {
      return { ok: false, reason: 'the AI answered null for "' + slot + '"' };
    }
    if (slot !== 'input') continue;
    const check = await validateChatInputSelector(page, sel);
    if (!check.ok) return { ok: false, reason: String(check.reason), selector: sel };
  }
  return { ok: true };
}

/**
 * Trimite snapshot-ul DOM la Ollama și întoarce selectorii propuși (sau null).
 *
 * v2.5.41 (bug #95): ce s-a propus e verificat în pagină înainte de a fi
 * întors; dacă pică, analiza se reia cu un prompt care spune ce a fost respins
 * (max AI_FINDER_MAX_ATTEMPTS). După ultima încercare nu se întoarce nimic.
 * Timeout-ul/eroarea de provider NU se reîncearcă (un model care nu termină în
 * 120 s nu termină nici la reluare), ca să nu blocăm fluxul de 3 ori.
 */
export async function findSelectorsWithAI(
  page: Page,
  providerName: string,
  missingSlots: string[]
): Promise<DiscoveredSelectors | null> {
  log('caut selectori cu AI pentru ' + providerName + ' (lipsesc: ' + missingSlots.join(',') + ')');

  // v2.5.40 (bug #93): modelul se rezolvă ÎNAINTE de capturarea DOM-ului — cu
  // doar embeddings instalate nu mai plătim snapshot-ul degeaba.
  const model = await resolveAiFinderModel();
  if (!model) return null;

  let url = '';
  try {
    url = page.url();
  } catch {
    /* pagină închisă — mergem mai departe cu URL gol */
  }

  let dom = '';
  try {
    // v2.5.41 (bug #96): textul conversației se păstrează doar când căutăm
    // containerul de răspuns — la input/butoane e exact zgomotul care strică.
    dom = await captureCleanDom(page, { includeText: missingSlots.indexOf('response') >= 0 });
  } catch (e: any) {
    log('captura DOM a eșuat: ' + (e?.message ?? String(e)));
    return null;
  }
  log('DOM capturat: ' + dom.length + ' caractere');

  const settings = finderSettings();
  const ollama = new OllamaProvider({ model });
  let failureReason: string | undefined;
  let rejectedSelector: string | undefined;

  for (let attempt = 1; attempt <= AI_FINDER_MAX_ATTEMPTS; attempt++) {
    let reply = '';
    try {
      // fără istoric între încercări: promptul conține deja tot ce trebuie
      // (altfel cele 18k caractere de snapshot s-ar aduna peste num_ctx 8192)
      await ollama.newChat();
      reply = await askOllama(
        ollama,
        buildPrompt({
          providerName,
          url,
          missingSlots,
          dom,
          attempt,
          failureReason,
          rejectedSelector
        }),
        settings.timeoutMs
      );
    } catch (e: any) {
      log('analiza AI a eșuat: ' + (e?.message ?? String(e)));
      return null;
    }
    log('răspuns AI: ' + reply.length + ' caractere');

    const parsed = parseAIResponse(reply);
    if (!parsed) {
      failureReason = 'your reply was not a valid JSON object';
      rejectedSelector = undefined;
      log('încercarea ' + attempt + '/' + AI_FINDER_MAX_ATTEMPTS + ' a eșuat: răspuns fără JSON');
      continue;
    }

    const verdict = await checkRequestedSlots(page, parsed, missingSlots);
    if (verdict.ok) return parsed;

    failureReason = verdict.reason;
    rejectedSelector = verdict.selector;
    log(
      'încercarea ' +
        attempt +
        '/' +
        AI_FINDER_MAX_ATTEMPTS +
        ' respinsă: ' +
        verdict.reason +
        (verdict.selector ? ' (' + verdict.selector + ')' : '')
    );
  }

  log('all proposed selectors failed validation — manual fix required');
  return null;
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
 * v2.5.41 (bug #95): validarea strictă a unui selector de căsuță de chat.
 * Testat în pagină cu `page.locator(selector)` (primul element e cel folosit și
 * la rulare, vezi resolveSlot) + criteriile din `checkInputCandidate`: vizibil
 * (nu display:none / width:0 / opacity:0), activ, acceptă text, în viewport și
 * în jumătatea de jos a paginii. Fără ele, AI-ul a salvat un input ascuns din
 * UI (`input[aria-label="Line wrap"]`) și a stricat ChatGPT până la fix manual.
 */
export async function validateChatInputSelector(
  page: Page,
  selector: string
): Promise<InputCandidateCheck & { count: number }> {
  const fail = (reason: string, count = 0): InputCandidateCheck & { count: number } => ({
    count,
    visible: false,
    enabled: false,
    acceptsText: false,
    inViewport: false,
    nearBottom: false,
    ok: false,
    reason
  });

  let count = 0;
  try {
    const loc = page.locator(selector);
    count = await loc.count();
    if (count === 0) return fail('no element matches', 0);
    if (count > 20) return fail('too generic (' + count + ' matches)', count);
    if (!(await loc.first().isVisible())) return fail('not visible', count);
    if (!(await loc.first().isEnabled())) return fail('disabled', count);
  } catch (e: any) {
    return fail('invalid selector (' + (e?.message ?? String(e)) + ')', count);
  }

  let probe: InputCandidateProbe | undefined;
  let viewport = { width: 0, height: 0 };
  try {
    const probed = await probeInputCandidates(page, selector, 1);
    probe = probed.probes[0];
    viewport = probed.viewport;
  } catch {
    /* mai jos raportăm „cannot be inspected" */
  }
  if (!probe) return fail('cannot be inspected', count);

  return { ...checkInputCandidate(probe, viewport), count };
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
    if (slot === 'input') {
      // v2.5.41 (bug #95): căsuța de chat are criterii proprii (vizibil, activ,
      // acceptă text, în viewport, în jumătatea de jos) — vezi
      // checkInputCandidate(). Regulile generale de mai jos nu se mai aplică.
      const check = await validateChatInputSelector(page, sel);
      if (!check.ok) {
        log('respins input (' + check.reason + '): ' + sel);
        continue;
      }
      assignSlot(valid, slot, sel);
      log('validat ' + slot + ': ' + sel + ' (' + check.count + ' potriviri)');
      continue;
    }
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

/**
 * v2.5.44 (bug #101): fișierul are DOUĂ categorii, clar separate.
 *
 *   - „locked"  = selectori scriși/adăugați MANUAL de utilizator. Chei plate
 *                 `"<provider>.<slot>": "<selector>"` în rădăcină, dublate în
 *                 `_meta.locked`. Healer-ul (fingerprint), AI finder-ul și
 *                 override-urile de la server NU îi ating niciodată.
 *   - „providers" = selectori descoperiți automat (how='ai') — pot fi suprascriși.
 *
 * `_meta.writtenHash` = amprenta ultimului conținut scris DE NOI. Dacă fișierul
 * de pe disc nu corespunde, înseamnă că utilizatorul l-a editat manual: toate
 * intrările lui devin „locked" (regula de migrare pentru fișierele v1, care
 * fuseseră scrise manual de utilizator).
 *
 * `_meta` e ignorat la parsare ca „provider.slot" — nu e o intrare.
 */
const USER_FILE_VERSION = 2;

/** Cheile rezervate din selectors-user.json (nu sunt „provider.slot"). */
const USER_FILE_RESERVED = new Set(['version', 'updated', 'providers', '_meta']);

/** Amprenta conținutului (fără `_meta`), ca să detectăm editarea manuală. */
function hashUserPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/**
 * v2.5.44: fișierul e editat de mână, deci acceptăm (doar ca FALLBACK, după
 * JSON.parse) și comentarii (de linie sau de bloc) ori virgula finală.
 */
function parseUserJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    /* încercăm varianta tolerantă */
  }
  try {
    return JSON.parse(stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** Scoate comentariile fără să atingă conținutul dintre ghilimele. */
function stripJsonComments(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** `"mistral.input"` → { provider: 'mistral', slot: 'input' } (sau null). */
function splitSlotKey(key: string): { provider: string; slot: SlotName } | null {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  const slot = key.slice(dot + 1);
  if (!(SLOTS as readonly string[]).includes(slot)) return null;
  return { provider: key.slice(0, dot), slot: slot as SlotName };
}

export function userSelectorsFilePath(): string | null {
  return storageDir ? path.join(storageDir, USER_FILE_NAME) : null;
}

/**
 * Rescrie fișierul: selecțiile „locked" (scrise manual) ca chei plate, cele
 * descoperite de AI (how='ai') sub `providers`.
 */
export function saveUserSelectors(): void {
  const file = userSelectorsFilePath();
  if (!file) return;
  const locked: Record<string, string> = {};
  const providers: Record<string, Record<string, unknown>> = {};
  let lockedCount = 0;
  let count = 0;
  for (const item of selectors.listLearned()) {
    if (item.locked) {
      locked[item.provider + '.' + item.slot] = item.selector;
      lockedCount++;
      continue;
    }
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
  const payload: Record<string, unknown> = {
    version: USER_FILE_VERSION,
    updated: new Date().toISOString(),
    ...locked
  };
  if (count) payload.providers = providers;
  // amprenta se calculează ÎNAINTE de a adăuga `_meta` (altfel s-ar auto-include)
  payload._meta = { locked: Object.keys(locked), writtenHash: hashUserPayload(payload) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    log(
      'selectors-user.json salvat (' +
        count +
        ' selectori AI' +
        (lockedCount ? ', ' + lockedCount + ' user-locked' : '') +
        ')'
    );
  } catch (e: any) {
    log('scrierea selectors-user.json a eșuat: ' + (e?.message ?? String(e)));
  }
}

/**
 * Încarcă selectors-user.json la pornire.
 *
 * v2.5.44 (bug #101): fișierul e tratat ca sursă de adevăr pentru selecțiile
 * MANUALE. Dacă a fost editat de utilizator (sau e un fișier v1, scris de
 * mână), tot ce conține e marcat „locked" și healer-ul nu se mai atinge de
 * acele sloturi. Intrările automate respinse de validare se șterg doar dacă
 * fișierul e al nostru (nu-l rescriem niciodată peste o editare manuală).
 */
function loadUserSelectorsFromDisk(): void {
  const file = userSelectorsFilePath();
  if (!file || !fs.existsSync(file)) return;
  let data: any;
  try {
    data = parseUserJson(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    log('selectors-user.json invalid — ignorat: ' + (e?.message ?? String(e)));
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    log('selectors-user.json invalid — ignorat (nu e un obiect JSON)');
    return;
  }

  const meta = data._meta && typeof data._meta === 'object' ? data._meta : {};
  const baseline: Record<string, unknown> = { ...data };
  delete baseline._meta;
  const storedHash = typeof meta.writtenHash === 'string' ? meta.writtenHash : '';
  // fără amprenta noastră (fișier v1) sau cu altă amprentă => scris de mână
  const userEdited = !storedHash || storedHash !== hashUserPayload(baseline);
  const declaredLocked = new Set<string>(
    Array.isArray(meta.locked) ? meta.locked.map((k: unknown) => String(k)) : []
  );

  let loaded = 0;
  let auto = 0;
  let pruned = 0;

  // (a) chei plate „provider.slot" = selecții scrise manual → locked implicit
  for (const [key, value] of Object.entries<any>(data)) {
    if (USER_FILE_RESERVED.has(key)) continue;
    const parsed = splitSlotKey(key);
    if (!parsed) continue;
    const sel = typeof value === 'string' ? value : value?.selector;
    if (typeof sel !== 'string' || !sel.trim()) continue;
    if (selectors.learnLocked(parsed.provider, parsed.slot, sel)) loaded++;
  }

  // (b) `providers` = descoperite automat; la o editare manuală devin și ele
  // locked (migrarea v1: tot ce exista în fișier fusese scris de utilizator)
  const providers = data.providers;
  if (providers && typeof providers === 'object') {
    for (const [pid, slots] of Object.entries<any>(providers)) {
      if (!slots || typeof slots !== 'object') continue;
      for (const slot of SLOTS) {
        const entry = slots[slot];
        const sel = typeof entry === 'string' ? entry : entry?.selector;
        if (typeof sel !== 'string' || !sel.trim()) continue;
        if (userEdited || entry?.locked === true || declaredLocked.has(pid + '.' + slot)) {
          if (selectors.learnLocked(pid, slot, sel)) loaded++;
          continue;
        }
        const meta2 =
          entry && typeof entry === 'object'
            ? { confidence: Number(entry.confidence), reasoning: String(entry.reasoning || '') }
            : undefined;
        if (selectors.learn(pid, slot, sel.trim(), 'ai', meta2)) {
          loaded++;
          auto++;
        } else {
          pruned++;
          log('selectors-user.json: „' + pid + '.' + slot + '” respins la încărcare — ' + sel);
        }
      }
    }
  }

  if (loaded) {
    log(
      'selectors-user.json: ' + loaded + ' selectori încărcați (' +
        (loaded - auto) + ' user-locked' + (auto ? ', ' + auto + ' auto' : '') + ')'
    );
  }
  if (userEdited) {
    log(
      'selectors-user.json editat manual — toate intrările lui sunt user-locked ' +
        '(healer-ul nu le mai atinge; șterge o intrare ca să reactivezi auto-repararea)'
    );
    saveUserSelectors(); // adaugă marcajul „locked" + amprenta
  } else if (pruned) {
    saveUserSelectors(); // rescrie fără intrările respinse
  }
}

/* ---------------- 5) adaptorul pentru healSlot ---------------- */

const recentAttempts = new Map<string, number>();
const inFlight = new Set<string>();

/** Doar pentru teste: resetează rate limiting-ul. */
export function resetAIFinderCache(): void {
  recentAttempts.clear();
  inFlight.clear();
}

/**
 * v2.5.17 (bug #44): când AI finder-ul nu produce NIMIC pentru un slot (timeout,
 * răspuns neparsabil, selector respins la validare), override-ul local rămas
 * (how='ai'/'fingerprint') e aproape sigur stale — a fost „reparat" pe un DOM
 * vechi (ex: `div.xh8yej3.x1ghz6dp` la ChatGPT) și, fiind primul în
 * `candidates()`, umbrește selectorul static din selectors.json la citirea
 * răspunsului. Îl ștergem, ca să rămână selectorul original (bundled/remote).
 * Override-urile publicate de server (how='server') NU se ating — nu sunt
 * ghicite pe DOM-ul curent. Nici cele scrise manual de utilizator (v2.5.44,
 * bug #101): „curățenia" automată nu are ce căuta peste ele.
 */
function dropStaleOverride(providerId: string, slot: SlotName): void {
  const learned = selectors.learned(providerId, slot);
  if (!learned || learned.how === 'server' || learned.locked) return;
  if (!selectors.forget(providerId, slot)) return;
  log(
    'AI finder nu a produs un selector pentru ' +
      providerId +
      '.' +
      slot +
      ' — override stale șters („' +
      learned.selector +
      '", sursă ' +
      learned.how +
      '); se folosește selectorul static'
  );
  // fișierul e rescris din listLearned() — altfel intrarea 'ai' ar reveni la
  // următoarea pornire, vezi loadUserSelectorsFromDisk()
  if (learned.how === 'ai') saveUserSelectors();
}

/**
 * v2.5.20 (bug #44/#58): există în DOM conținut de răspuns pe care selectorii
 * curenți îl ratează? (text substanțial, în afara navigației, diferit de
 * mesajul tocmai trimis). Fără el, AI finder-ul nu are ce găsi — orice apel ar
 * consuma doar timeout-ul. Acoperă exact cazul „avem deja un selector static
 * care a mers în sesiuni anterioare": dacă elementul lui e prezent dar încă
 * gol (bila se randează), nu există conținut → nu-l înlocuim. Fail-open la
 * erori de evaluare, ca un bug de probe să nu blocheze repararea reală.
 */
async function hasResponseContentToFind(
  page: Page,
  providerId: string,
  echoText?: string
): Promise<boolean> {
  try {
    const probe = await getLastResponseText(
      page,
      selectors.candidates(providerId, 'response'),
      true
    );
    const flat = String(probe || '').replace(/\s+/g, ' ').trim();
    if (flat.length < 60) return false;
    const echo = String(echoText || '').replace(/\s+/g, ' ').trim();
    // doar ecoul mesajului trimis (bula userului), nu un răspuns
    if (echo.length >= 40 && flat.includes(echo.slice(0, 40))) return false;
    return true;
  } catch (e: any) {
    log('AI finder probe failed: ' + (e?.message ?? String(e)));
    return true;
  }
}

async function discoverForHealer(
  page: Page,
  providerId: string,
  slot: SlotName,
  echoText?: string
): Promise<string | null> {
  // v2.5.44 (bug #101): slot cu selecție manuală → AI finder-ul nu propune nimic
  if (selectors.isLocked(providerId, slot)) {
    healLog('skip ' + providerId + ':' + slot + ' — user-locked');
    return null;
  }
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
  // v2.5.20 (bug #44/#58): fără conținut de răspuns în DOM nu există nimic de
  // găsit — finder-ul ar arde timeout-ul complet (45–120s) pe un snapshot fără
  // bilă AI. Se întâmplă când bila nu e încă randată (selectorul static e
  // prezent, dar gol) sau pagina e goală. Îl lăsăm pe healer-ul de fingerprint
  // să rămână singura cale de reparare până apare conținut real.
  if (slot === 'response' && !(await hasResponseContentToFind(page, providerId, echoText))) {
    log('AI finder: no response content in the DOM yet — skipping for ' + key);
    return null;
  }
  try {
    const label = PROVIDER_LABELS[providerId] || providerId;
    const discovered = await findSelectorsWithAI(page, label, [slot]);
    if (!discovered) {
      dropStaleOverride(providerId, slot);
      return null;
    }

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
        if (s === slot) {
          found = sel;
          // v2.5.41 (bug #95): linia care lipsea — se vede negru pe alb ce s-a
          // validat în pagină și s-a salvat
          log('validated selector for ' + providerId + '.' + s + ': ' + sel);
        }
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
    // nimic util pentru slotul cerut (selector respins la validare / respins la
    // salvare) → override-ul local rămas e stale, vezi dropStaleOverride()
    if (!found) dropStaleOverride(providerId, slot);
    return found;
  } catch (e: any) {
    log('AI finder a eșuat: ' + (e?.message ?? String(e)));
    dropStaleOverride(providerId, slot);
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
