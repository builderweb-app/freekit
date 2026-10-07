import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { logLine } from './log';
import { listOllamaModelsDetailed, OllamaProvider } from './providers/ollama';
import { PROVIDER_LABELS } from './providers';
import { AI_FINDER_MODEL_AUTO, isAutoAiFinderModel, pickAiFinderModel } from './aiFinderModel';
import { isEmbeddingModel } from './hardware';
import {
  AIFinderStatus,
  publishAIFinderStatus
} from './ai-finder-events';
import {
  configInfo,
  DiscoveryOutcome,
  getLastResponseText,
  inputAvailable,
  InputRepairResult,
  isUsableSelector,
  NAV_SELECTORS,
  promoPhraseHit,
  selectors,
  setAIFinder,
  setInputRepair,
  setNotReadyNotifier,
  setProactiveDiscovery,
  SLOTS,
  SlotName
} from './selectors';

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
  finderId?: string;
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
export const AI_FINDER_MAX_ATTEMPTS = 2;
const AI_FINDER_ATTEMPT_TIMEOUT_MS = 30_000;
const AI_FINDER_GLOBAL_TIMEOUT_MS = 60_000;

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
 * Timeout per încercare, plafonat suplimentar de timeout-ul global de 60s.
 */
export const DEFAULT_AI_FINDER_TIMEOUT_SECONDS = 30;

const AI_RETRY_MS = 5 * 60 * 1000;

/* Manual full discovery is explicitly requested through Repair Selectors. */

/** Fix 5 (bug #102): cât timp considerăm o descoperire „proaspătă". */
const DISCOVERY_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

/** Fix 1 (bug #102): selectorii bundled mai vechi de atât ⇒ descoperire nouă. */
const DISCOVERY_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Fix 2 (bug #102): cel mult atâtea descoperiri proactive per sesiune/provider. */
export const MAX_PROACTIVE_ATTEMPTS = 3;

/** Fix 3 (bug #102): atâtea reparații de input ratate înainte de cardul din chat. */
export const MAX_INPUT_REPAIR_FAILURES = 3;

/** Fix 5: data ultimei descoperiri per provider (persistată în `_meta.discoveryDate`). */
const discoveryDates = new Map<string, number>();
/** Fix 1: ultima verificare a eșuat → descoperirea se reia fără să aștepte cache-ul. */
const discoveryFailed = new Set<string>();
/** Fix 2: provider cu descoperire amânată (login/CAPTCHA/input lipsă) → reîncercare. */
const pendingDiscovery = new Map<string, number>();
/** Fix 2: câte descoperiri chiar au rulat în sesiunea curentă, per provider. */
const proactiveAttempts = new Map<string, number>();
/** Fix 3: câte reparații de input au eșuat în sesiunea curentă, per provider. */
const inputRepairFailures = new Map<string, number>();
/** Fix 3: cardul „fix manual" se afișează o singură dată per sesiune. */
const inputRepairGaveUp = new Set<string>();

interface FinderSettings {
  enabled: boolean;
  timeoutMs: number;
}

function finderSettings(): FinderSettings {
  try {
    // require lazy — în teste Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    const cfg = v.workspace.getConfiguration('freekit');
    const enabled = cfg.get<boolean>('aiSelectorFinder', false);
    const secs = Number(
      cfg.get<number>('aiFinderTimeoutSeconds', DEFAULT_AI_FINDER_TIMEOUT_SECONDS)
    );
    const safe = Number.isFinite(secs)
      ? Math.min(30, Math.max(5, secs))
      : DEFAULT_AI_FINDER_TIMEOUT_SECONDS;
    return { enabled, timeoutMs: safe * 1000 };
  } catch {
    return { enabled: false, timeoutMs: DEFAULT_AI_FINDER_TIMEOUT_SECONDS * 1000 };
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
  /**
   * v2.5.45 (bug #102): reparație țintită (composerul trunchiază mesajul) —
   * promptul cere doar căsuța de chat, cu criteriile ei, fără restul sloturilor.
   */
  inputOnly?: boolean;
  /**
   * v2.5.45 (bug #102): descoperirea proactivă — pagina unui provider nou, cu
   * TOATE sloturile cerute într-o singură trecere (sloturile fără selector
   * sigur pot rămâne null).
   */
  onboarding?: boolean;
}

/**
 * v2.5.41 (bug #96): promptul spune exact ce e căsuța de chat (jos, vizibilă,
 * activă, acceptă text), cum se citește lista de candidați și ce NU are voie să
 * aleagă (inputuri ascunse, upload, căutare, „Line wrap" etc.). La reîncercare
 * primește și motivul respingerii, ca să nu repete același element.
 *
 * v2.5.45 (bug #102): `ctx.onboarding` = descoperirea proactivă la conectare
 * (toate sloturile dintr-o trecere), `ctx.inputOnly` = reparația căsuței de chat
 * după un mesaj trunchiat.
 */
export function buildPrompt(ctx: PromptContext): string {
  const lines: string[] = [
    'You are a DOM analysis expert. Find CSS selectors for a website UI.',
    '',
    'WEBSITE: ' + ctx.providerName,
    'URL: ' + ctx.url,
    'I need selectors for these elements: ' + ctx.missingSlots.join(', '),
    ''
  ];

  if (ctx.onboarding) {
    lines.push(
      'ONBOARDING: you are wiring up a NEW AI chat provider — find ALL the selectors listed',
      'above in ONE pass.',
      ''
    );
  }

  lines.push(
    'Element meanings:',
    '- input: THE CHAT INPUT — the text box where the user types a message. It sits in the',
    "  BOTTOM HALF of the page and it is VISIBLE, ENABLED and accepts typed text: a <textarea>,",
    '  an <input type="text">/<input type="search">, a <div contenteditable="true"> (often with',
    '  class ProseMirror or ql-editor) or an element with role="textbox".',
    "- response: the container holding the AI assistant's LATEST reply (NOT the user's message bubble, NOT the input box, NOT promo/marketing cards).",
    '  It must be the WHOLE reply: reading that element has to return the full reply text — every',
    '  paragraph, every code fence and any `ACTION:` / `TOOL:` block it contains. A fragment of the',
    '  reply, an inner "thinking"/"reasoning" block or a single paragraph is WRONG.',
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
  );

  if (ctx.attempt > 1 && ctx.failureReason) {
    lines.push(
      '',
      'ATTEMPT ' + ctx.attempt + ' OF ' + AI_FINDER_MAX_ATTEMPTS + ' — YOUR PREVIOUS ANSWER WAS REJECTED:',
      '- rejected selector: ' + (ctx.rejectedSelector || '(none)'),
      '- why it was rejected: ' + ctx.failureReason
    );
    if (ctx.missingSlots.indexOf('input') >= 0) {
      lines.push(
        'That element is NOT the chat input. Read INTERACTIVE CANDIDATES again and answer with a',
        'DIFFERENT element that satisfies rule 1 (visible=yes, enabled=yes, acceptsText=yes,',
        'inViewport=yes, largest y).'
      );
    }
    if (ctx.missingSlots.indexOf('response') >= 0) {
      lines.push(
        'That element does NOT return the whole reply. Answer with the CONTAINER of the latest',
        'assistant reply — reading it must give the FULL reply text (all paragraphs, code fences and',
        'any ACTION:/TOOL: block), not a fragment and not the inner "thinking" block.'
      );
    }
    lines.push('If no candidate qualifies, return null.');
  }

  if (ctx.inputOnly) {
    lines.push(
      '',
      'FOCUS — the message was TRUNCATED in the composer, so the stored input is suspect:',
      'Where is the CHAT INPUT (text composer)? It is visible, enabled, accepts text and sits in the',
      'BOTTOM half of the screen. Reject hidden, disabled, search and file inputs, and every helper',
      'input (spellcheck, "Line wrap", upload). Answer with the composer in "input" and null for the',
      'other slots.'
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
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const work = (async () => {
      await ollama.open();
      if (controller.signal.aborted) throw new Error('AI finder aborted');
      return await ollama.send(undefined, prompt, controller.signal);
    })();
    // v2.5.17 (bug #44): la timeout promisiunea pierzătoare e abandonată —
    // fără handler, reject-ul ei ajunge „unhandled rejection" în extension host.
    work.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('timeout after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (timedOut) {
        throw new Error('timeout after ' + Math.round(timeoutMs / 1000) + 's');
      }
      throw e;
    }
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * v2.5.41 (bug #95): verifică strict sloturile cerute. Doar căsuța de chat are
 * criterii proprii (vizibil, activ, acceptă text, în viewport, în jumătatea de
 * jos); restul sloturilor trec mai departe de regulile generale din
 * validateSelectors().
 *
 * v2.5.45 (bug #102): `required` = sloturile fără de care răspunsul e inutil
 * (pentru healer: slotul cerut; pentru descoperirea proactivă: doar `input`).
 * Un slot opțional rămas null NU mai respinge toată analiza — exact așa își
 * cere promptul „return null if you can't find a reliable selector".
 */
async function checkRequestedSlots(
  page: Page,
  discovered: DiscoveredSelectors,
  missingSlots: string[],
  required: string[],
  opts: { echoText?: string } = {}
): Promise<{ ok: true } | { ok: false; reason: string; selector?: string }> {
  for (const slot of SLOTS) {
    if (missingSlots.indexOf(slot) < 0) continue;
    const sel = discovered[slot];
    if (!sel) {
      if (slot === 'response') {
        // v2.5.47 (bug #106): AI-ul n-a propus nimic, dar fallback-ul generic
        // (data-message-author-role etc.) poate prinde totuși răspunsul.
        const check = await validateResponseSelector(page, '', opts);
        if (check.ok) {
          discovered.response = check.selector;
          continue;
        }
        // fără text de răspuns în DOM nu insistăm — descoperirea se amână
        return check.retryable ? { ok: false, reason: check.reason } : { ok: true };
      }
      if (required.indexOf(slot) < 0) continue;
      return { ok: false, reason: 'the AI answered null for "' + slot + '"' };
    }
    if (slot === 'input') {
      const check = await validateChatInputSelector(page, sel);
      if (!check.ok) return { ok: false, reason: String(check.reason), selector: sel };
      continue;
    }
    if (slot === 'response') {
      const check = await validateResponseSelector(page, sel, opts);
      if (check.ok) {
        // selectorul validat poate fi un părinte (Fix 3) sau fallback-ul (Fix 4)
        discovered.response = check.selector;
        continue;
      }
      if (check.retryable) return { ok: false, reason: check.reason, selector: sel };
      // fragment de răspuns, dar în pagină nu există text mai bun de măsurat:
      // slotul rămâne null (healer-ul va relua când chiar există un răspuns)
      delete discovered.response;
      continue;
    }
  }
  return { ok: true };
}

interface ActiveFinder {
  controller: AbortController;
  cancelled: boolean;
  status: Pick<AIFinderStatus, 'id' | 'providerId' | 'providerName'>;
}

const activeFinders = new Map<string, ActiveFinder>();
let cancelledFinderCount = 0;

export function getAIFinderCancellationCount(): number {
  return cancelledFinderCount;
}

export function cancelAIFinder(id: string): boolean {
  const active = activeFinders.get(id);
  if (!active || active.controller.signal.aborted) return false;
  active.cancelled = true;
  cancelledFinderCount++;
  log('cancelled by user');
  publishAIFinderStatus({
    ...active.status,
    phase: 'cancelled',
    message: 'Repair cancelled. Bundled selectors remain active.'
  });
  active.controller.abort();
  return true;
}

async function isLoginOrCaptchaPage(page: Page): Promise<boolean> {
  let url = '';
  try {
    url = page.url().toLowerCase();
  } catch {
    return false;
  }
  if (/\/(sign_in|login|signin|auth|register|signup|captcha)(?:[/?#]|$)/i.test(url)) {
    return true;
  }
  try {
    return await page.evaluate(() => {
      if (document.querySelector('input[type="password"]')) return true;
      const text = document.body?.innerText || '';
      return /\b(?:sign in|log in|verify you are human)\b/i.test(text);
    });
  } catch (e: any) {
    log('login/CAPTCHA probe failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

export async function findSelectorsWithAI(
  page: Page,
  providerName: string,
  missingSlots: string[],
  opts: {
    required?: string[];
    inputOnly?: boolean;
    onboarding?: boolean;
    providerId?: string;
    echoText?: string;
    statusId?: string;
    /** Apelantul a verificat deja că în DOM există un răspuns de măsurat. */
    replyPresent?: boolean;
  } = {}
): Promise<DiscoveredSelectors | null> {
  if (await isLoginOrCaptchaPage(page)) {
    const providerId = opts.providerId || providerName;
    log('skip ' + providerId + ' — login/CAPTCHA page detected');
    if (opts.providerId) noteProviderNotReady(opts.providerId, 'login/CAPTCHA page');
    return null;
  }

  const id = opts.statusId || crypto.randomBytes(8).toString('hex');
  const statusBase: Pick<AIFinderStatus, 'id' | 'providerId' | 'providerName'> = {
    id,
    providerId: opts.providerId || providerName,
    providerName
  };
  const active: ActiveFinder = {
    controller: new AbortController(),
    cancelled: false,
    status: statusBase
  };
  activeFinders.set(id, active);
  publishAIFinderStatus({
    ...statusBase,
    phase: 'running',
    attempt: 1,
    maxAttempts: AI_FINDER_MAX_ATTEMPTS,
    message: 'Preparing the page for selector analysis…'
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let resolveAbort!: (value: null) => void;
  const aborted = new Promise<null>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort(null);
  active.controller.signal.addEventListener('abort', onAbort, { once: true });
  const work = runFindSelectorsWithAI(page, providerName, missingSlots, {
    ...opts,
    signal: active.controller.signal,
    statusId: id
  });
  work.catch(() => undefined);
  const globalTimeout = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      log('global timeout (60s) — aborting');
      publishAIFinderStatus({
        ...statusBase,
        phase: 'timeout',
        message: 'AI finder timed out after 60s. Bundled selectors are not working.'
      });
      active.controller.abort();
      resolve(null);
    }, AI_FINDER_GLOBAL_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([work, aborted, globalTimeout]);
    if (timedOut || active.cancelled) return null;
    if (result) {
      result.finderId = id;
      const accepted = [
        result.input && 'input=' + result.input,
        result.response && 'response=' + result.response,
        result.newChat && 'newChat=' + result.newChat,
        result.stopButton && 'stopButton=' + result.stopButton
      ].filter((value): value is string => Boolean(value));
      publishAIFinderStatus({
        ...statusBase,
        phase: 'success',
        selectors: accepted,
        message: 'Selectors repaired: ' + (accepted.join(', ') || 'validated')
      });
    } else {
      publishAIFinderStatus({
        ...statusBase,
        phase: 'failed',
        message: 'Repair failed. Manual intervention required.'
      });
    }
    return result;
  } catch (e: any) {
    if (!active.cancelled && !timedOut) {
      log('selector analysis failed: ' + (e?.message ?? String(e)));
      publishAIFinderStatus({
        ...statusBase,
        phase: 'failed',
        message: 'Repair failed. Manual intervention required.'
      });
    }
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    active.controller.signal.removeEventListener('abort', onAbort);
    activeFinders.delete(id);
  }
}

/**
 * Trimite snapshot-ul DOM la Ollama și întoarce selectorii propuși (sau null).
 *
 * v2.5.41 (bug #95): ce s-a propus e verificat în pagină înainte de a fi
 * întors; dacă pică, analiza se reia cu un prompt care spune ce a fost respins
 * (max AI_FINDER_MAX_ATTEMPTS). După ultima încercare nu se întoarce nimic.
 * Timeout-ul pe încercare se poate reîncerca o singură dată; timeout-ul global
 * și anularea utilizatorului opresc imediat fluxul.
 *
 * v2.5.45 (bug #102): `opts.required` (implicit = toate sloturile cerute) spune
 * care sloturi rămase null resping analiza, iar `opts.inputOnly` adaugă în
 * prompt blocul „căutăm doar căsuța de chat" (reparația de composer trunchiat).
 *
 * v2.5.47 (bug #106): `opts.providerId`/`opts.echoText` permit verificarea
 * „există răspuns în DOM?"; fără el, slotul `response` nu se cere deloc — vezi
 * deferral-ul de mai jos. `opts.replyPresent` sare peste verificare (apelantul
 * a dovedit-o deja).
 */
async function runFindSelectorsWithAI(
  page: Page,
  providerName: string,
  missingSlots: string[],
  opts: {
    required?: string[];
    inputOnly?: boolean;
    onboarding?: boolean;
    providerId?: string;
    echoText?: string;
    /** Apelantul a verificat deja că în DOM există un răspuns de măsurat. */
    replyPresent?: boolean;
    signal?: AbortSignal;
    statusId?: string;
  } = {}
): Promise<DiscoveredSelectors | null> {
  log('caut selectori cu AI pentru ' + providerName + ' (lipsesc: ' + missingSlots.join(',') + ')');

  // v2.5.45 (bug #102): fără `required` explicit, toate sloturile cerute sunt
  // obligatorii (comportamentul de dinainte, folosit de healer pe un singur slot).
  const required = opts.required ?? missingSlots;

  // v2.5.47 (bug #106): fără răspuns în DOM nu cerem (și nu acceptăm) un
  // selector de `response` — AI-ul ar ghici un container parțial, exact ca la
  // Qwen. Amânăm slotul pentru prima reparare reactivă, când există un răspuns
  // real de măsurat (validateResponseSelector are nevoie de conținut).
  let wanted = missingSlots;
  if (missingSlots.indexOf('response') >= 0) {
    const replyPresent =
      opts.replyPresent ??
      (opts.providerId !== undefined
        ? await hasResponseContentToFind(page, opts.providerId, opts.echoText)
        : false);
    if (!replyPresent) {
      wanted = missingSlots.filter((s) => s !== 'response');
      log('no reply in the DOM yet — deferring the response selector');
      if (!wanted.length) return null;
    }
  }
  const wantedRequired = required.filter((s) => wanted.indexOf(s) >= 0);

  // v2.5.40 (bug #93): modelul se rezolvă ÎNAINTE de capturarea DOM-ului — cu
  // doar embeddings instalate nu mai plătim snapshot-ul degeaba.
  const model = await resolveAiFinderModel();
  if (opts.signal?.aborted) return null;
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
    dom = await captureCleanDom(page, { includeText: wanted.indexOf('response') >= 0 });
  } catch (e: any) {
    log('captura DOM a eșuat: ' + (e?.message ?? String(e)));
    return null;
  }
  if (opts.signal?.aborted) return null;
  log('DOM capturat: ' + dom.length + ' caractere');

  const settings = finderSettings();
  const attemptTimeoutMs = Math.min(settings.timeoutMs, AI_FINDER_ATTEMPT_TIMEOUT_MS);
  const ollama = new OllamaProvider({ model });
  let failureReason: string | undefined;
  let rejectedSelector: string | undefined;

  for (let attempt = 1; attempt <= AI_FINDER_MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) return null;
    if (opts.statusId) {
      publishAIFinderStatus({
        id: opts.statusId,
        providerId: opts.providerId || providerName,
        providerName,
        phase: 'attempt',
        attempt,
        maxAttempts: AI_FINDER_MAX_ATTEMPTS,
        message:
          attempt === 1
            ? 'Analyzing DOM (attempt 1/2) — up to 30s per attempt, 60s max.'
            : 'Attempt 2/2 — retrying with a more specific prompt…'
      });
    }
    let reply = '';
    try {
      // fără istoric între încercări: promptul conține deja tot ce trebuie
      // (altfel cele 18k caractere de snapshot s-ar aduna peste num_ctx 8192)
      await ollama.newChat();
      if (opts.signal?.aborted) return null;
      reply = await askOllama(
        ollama,
        buildPrompt({
          providerName,
          url,
          missingSlots: wanted,
          dom,
          attempt,
          failureReason,
          rejectedSelector,
          inputOnly: opts.inputOnly,
          onboarding: opts.onboarding
        }),
        attemptTimeoutMs,
        opts.signal
      );
    } catch (e: any) {
      if (opts.signal?.aborted) return null;
      const reason = e?.message ?? String(e);
      if (/timeout after \d+s/i.test(reason)) {
        log(
          attempt < AI_FINDER_MAX_ATTEMPTS
            ? 'attempt timeout (' + Math.ceil(attemptTimeoutMs / 1000) + 's) — retrying'
            : 'attempt timeout (' + Math.ceil(attemptTimeoutMs / 1000) + 's) — maximum attempts reached'
        );
        if (attempt >= AI_FINDER_MAX_ATTEMPTS) return null;
        failureReason =
          'the previous analysis timed out; keep the answer concise and return only the required JSON selectors';
        continue;
      }
      log('analiza AI a eșuat: ' + reason);
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

    const verdict = await checkRequestedSlots(page, parsed, wanted, wantedRequired, {
      echoText: opts.echoText
    });
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

/* -------------------------------------------------------------------------
 * v2.5.47 (bug #106) — SELECTORUL DE RĂSPUNS E VALIDAT PE CONȚINUT
 *
 * Test Qwen (7 Oct 2026, 17:20): AI finder-ul a propus `div.chat-response-message`
 * pentru `qwen.response`, iar validarea de dinainte (bug #95: există, vizibil,
 * jos) a trecut — dar citirea dădea doar 67 de caractere, în timp ce în browser
 * răspunsul era complet (ACTION: write_files + 5 fișiere) ⇒ tool call pierdut.
 * Cauza: se verifica EXISTENȚA elementului, nu CONȚINUTUL lui; un container
 * parțial (fragment de răspuns sau blocul de raționament) era acceptat.
 *
 * Reguli (toate măsurate cu reader-ul real — getLastResponseText, care scoate
 * și blocurile de thinking, vezi scanResponses):
 *  1. selectorul trebuie să dea ≥ RESPONSE_MIN_CHARS (200) caractere de text;
 *  2. dacă în pagină există un tool call (ACTION:/TOOL:/```/---FILE---) pe care
 *     selectorul nu-l citește, selectorul e respins (Fix 2);
 *  3. un selector prea specific urcă la părintele cu de 2x mai mult text (Fix 3);
 *  4. dacă tot nu iese nimic: fallback `[data-message-author-role="assistant"]`,
 *     apoi ultimul bloc mare de text din DOM (Fix 4);
 *  5. fără text de răspuns în DOM nu se acceptă NIMIC și nu se reîncearcă —
 *     descoperirea se amână pentru prima reparare reactivă, când există un
 *     răspuns real de măsurat (vezi și deferral-ul din findSelectorsWithAI).
 * ------------------------------------------------------------------------- */

/** Sub atâtea caractere de text real, „răspunsul" e doar un fragment. */
export const RESPONSE_MIN_CHARS = 200;

/** Markerii unui tool call: dacă sunt în pagină, selectorul trebuie să-i prindă. */
export const RESPONSE_TOOL_MARKERS = ['ACTION:', 'TOOL:', '```', '---FILE---'];

/** Părintele înlocuiește selectorul prea specific doar dacă are de atâtea ori text. */
export const RESPONSE_PARENT_TEXT_RATIO = 2;

/** Peste atâtea caractere, un „bloc" nu mai poate fi răspunsul (e tot chatul). */
const RESPONSE_MAX_CHARS = 20000;

/** Câți strămoși inspectăm (containerul de răspuns e aproape de fragment). */
const RESPONSE_MAX_ANCESTORS = 3;

/**
 * Numărul maxim de potriviri acceptat pentru selectorul propus de AI.
 * v2.5.47 (bug #106): mare intenționat — un selector de răspuns CORECT prinde
 * sute de noduri într-o conversație lungă (`[data-message-author-role="assistant"]`
 * e chiar selectorul static de la ChatGPT, iar citirea ia oricum ULTIMUL nod).
 * Plasa de siguranță pentru `response` e CONȚINUTUL (≥ 200 caractere, tool call
 * prins, fără promo/ecou), nu numărul de potriviri.
 */
const RESPONSE_MAX_MATCHES = 500;

/** Fix 4: containerul standard de răspuns al asistentului (ca la ChatGPT). */
export const RESPONSE_FALLBACK_SELECTORS = ['[data-message-author-role="assistant"]'];

export type ResponseSelectorSource = 'ai' | 'parent' | 'fallback';

export interface ResponseContentCheck {
  ok: boolean;
  /** Motivul respingerii (ajunge în promptul de reîncercare și în log). */
  reason: string;
  /** Selectorul de folosit: propunerea AI, părintele sau fallback-ul generic. */
  selector: string;
  source: ResponseSelectorSource | 'none';
  /** Câte caractere dă propunerea AI (0 dacă nu a propus nimic). */
  chars: number;
  /** Cel mai lung text găsit în pagină (hotărăște dacă merită reîncercat). */
  bestChars: number;
  /** true = există text de răspuns în DOM, deci alt selector poate reuși. */
  retryable: boolean;
}

interface ResponseProbeArgs {
  s: string;
  navSels: string[];
  markers: string[];
  minChars: number;
  maxChars: number;
  maxAncestors: number;
  maxMatches: number;
  /** Mesajul tocmai trimis — ancorează „textul NOU" (Fix 4b). */
  echo: string;
}

interface ResponseProbe {
  /** Selector cu sintaxă invalidă. */
  invalid: boolean;
  count: number;
  visible: boolean;
  editable: boolean;
  role: string | null;
  userAncestor: boolean;
  /**
   * Unde e ultimul bloc de tool call din pagină față de ultimul nod potrivit:
   * `inside` = e prins de selector, `after` = e mai nou (selectorul îl ratează),
   * `before` = e un mesaj mai vechi (nu ne interesează), `none` = nu există.
   */
  markerBlock: 'none' | 'inside' | 'after' | 'before';
  /** Strămoșii ultimului nod potrivit (inner → outer), cu selector stabil. */
  parentCandidates: string[];
  /** Blocul generic de răspuns (Fix 4): cel mai complet, apoi sămânța. */
  genericCandidates: string[];
}

/**
 * Citește din pagină tot ce trebuie pentru validarea de conținut: starea
 * ultimului nod potrivit, poziția tool call-ului, strămoșii folosibili ca
 * selector (Fix 3) și ultimul bloc mare de text (Fix 4). Rulează ÎN PAGINĂ
 * (page.evaluate) — toate utilitarele sunt definite local (funcția e
 * serializată), iar constantele vin prin `args`.
 */
async function probeResponseElement(
  page: Page,
  selector: string,
  opts: { minChars: number; maxChars: number; maxAncestors: number; maxMatches: number; echo?: string }
): Promise<ResponseProbe> {
  return page.evaluate<ResponseProbe, ResponseProbeArgs>(
    (args) => {
      /**
       * textContent (nu innerText): scanul trece prin toate blocurile paginii,
       * iar innerText ar forța un reflow pentru fiecare. Măsurarea „reală" se
       * face oricum în Node, cu reader-ul paginii.
       */
      const textOf = (el: Element): string => String(el.textContent || '').trim();

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return false;
        const st = window.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };

      // v2.5.13 (bug #37): sidebar-ul nu e răspuns — aceeași listă ca la citire.
      const inNav = (el: Element): boolean => {
        for (let i = 0; i < args.navSels.length; i++) {
          try {
            if (el.closest(args.navSels[i]) !== null) return true;
          } catch {
            /* selector invalid — îl ignorăm */
          }
        }
        return false;
      };

      /** Composer-ul (sau un copil al lui) nu e niciodată „răspuns". */
      const inComposer = (el: Element): boolean =>
        el.closest('textarea, input, [contenteditable="true"], [role="textbox"]') !== null;

      const hasMarker = (t: string): boolean => {
        for (let i = 0; i < args.markers.length; i++) {
          if (t.indexOf(args.markers[i]) >= 0) return true;
        }
        return false;
      };

      const escapeSel = (v: string): string => v.replace(/[^a-zA-Z0-9_-]/g, '\\$&');

      /**
       * Selector STABIL pentru un element (id > data-* > aria-label/role >
       * tag.clasă; tag-uri custom gen <chat-message>). Fără drumuri
       * poziționale — learn() le respinge oricum (isFragileSelector).
       */
      const simpleSelector = (el: Element): string | null => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'html' || tag === 'body') return null;
        const matches = (sel: string): boolean => {
          try {
            const n = document.querySelectorAll(sel).length;
            return n > 0 && n <= args.maxMatches;
          } catch {
            return false;
          }
        };
        const id = el.getAttribute('id');
        if (id && /^[A-Za-z_][\w-]*$/.test(id) && matches('#' + escapeSel(id))) return '#' + id;
        const attrs = [
          'data-testid',
          'data-test-id',
          'data-message-author-role',
          'data-role',
          'aria-label',
          'role'
        ];
        for (let i = 0; i < attrs.length; i++) {
          const v = el.getAttribute(attrs[i]);
          if (!v || v.length > 60) continue;
          const sel = tag + '[' + attrs[i] + '="' + v.replace(/"/g, '\\"') + '"]';
          if (matches(sel)) return sel;
        }
        const classes = String((el as HTMLElement).className || '')
          .split(/\s+/)
          .filter((c: string) => c && c.length < 40 && !/[^a-zA-Z0-9_-]/.test(c));
        if (classes.length) {
          const sel = tag + '.' + escapeSel(classes[0]);
          if (matches(sel)) return sel;
        }
        return /-/.test(tag) ? tag : null;
      };

      const empty: ResponseProbe = {
        invalid: true,
        count: 0,
        visible: false,
        editable: false,
        role: null,
        userAncestor: false,
        markerBlock: 'none',
        parentCandidates: [],
        genericCandidates: []
      };

      let nodes: Element[] = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll(args.s)) as Element[];
      } catch {
        return empty;
      }
      const count = nodes.length;
      const node = count ? (nodes[count - 1] as HTMLElement) : null;
      const rect = node ? node.getBoundingClientRect() : null;
      const style = node ? window.getComputedStyle(node) : null;
      const visible = !!(
        node &&
        rect &&
        style &&
        rect.width >= 6 &&
        rect.height >= 6 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
      const editable = !!(
        node &&
        (node.tagName === 'TEXTAREA' ||
          node.tagName === 'INPUT' ||
          node.isContentEditable === true ||
          node.getAttribute('contenteditable') === 'true')
      );
      let userAncestor = false;
      let up: Element | null = node;
      let depth = 0;
      while (up && depth < 6) {
        const cls =
          typeof (up as HTMLElement).className === 'string' ? (up as HTMLElement).className : '';
        const ids = up.getAttribute('id') || '';
        if (/(^|[\s_-])user([\s_-]|$)/i.test(cls + ' ' + ids)) {
          userAncestor = true;
          break;
        }
        up = up.parentElement;
        depth++;
      }

      const pool = Array.prototype.slice.call(
        document.querySelectorAll('div, p, pre, code, li, article, section, blockquote, span')
      ) as Element[];

      /**
       * Fix 4b: „text NOU" = tot ce vine DUPĂ mesajul tocmai trimis. Fără
       * ancora lui, ultimul bloc mare din DOM poate fi un răspuns VECHI (dacă
       * răspunsul nou e scurt) sau un mesaj al userului.
       */
      let anchor: Element | null = null;
      const echoFlat = String(args.echo || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (echoFlat.length >= 40) {
        const head = echoFlat.slice(0, 60);
        for (let i = pool.length - 1; i >= 0; i--) {
          const el = pool[i];
          if (inNav(el) || inComposer(el)) continue;
          const raw = el.textContent || '';
          if (raw.length > args.maxChars) continue;
          const flat = raw.replace(/\s+/g, ' ').trim().toLowerCase();
          if (flat.indexOf(head) >= 0) {
            anchor = el;
            break;
          }
        }
      }
      const isNew = (el: Element): boolean => {
        if (!anchor) return true;
        if (anchor === el || anchor.contains(el)) return true;
        // 4 = Node.DOCUMENT_POSITION_FOLLOWING
        return (anchor.compareDocumentPosition(el) & 4) !== 0;
      };

      // Fix 2: ultimul bloc care conține un marker de tool call. Copiii vin
      // DUPĂ părinți în ordinea documentului, deci primul găsit mergând invers
      // e cel mai interior; un marker dintr-un mesaj mai VECHI e înaintea
      // ancorei, deci nu poate produce un fals „after".
      let markerEl: Element | null = null;
      for (let i = pool.length - 1; i >= 0; i--) {
        const el = pool[i];
        const t = textOf(el);
        if (!t || t.length > args.maxChars || !hasMarker(t)) continue;
        if (!isVisible(el) || inNav(el) || inComposer(el) || !isNew(el)) continue;
        markerEl = el;
        break;
      }
      let markerBlock: ResponseProbe['markerBlock'] = 'none';
      if (markerEl && node) {
        if (node === markerEl || node.contains(markerEl)) markerBlock = 'inside';
        else {
          // 4 = Node.DOCUMENT_POSITION_FOLLOWING
          markerBlock = node.compareDocumentPosition(markerEl) & 4 ? 'after' : 'before';
        }
      }

      // Fix 3: strămoșii ultimului nod potrivit, inner → outer.
      const parentCandidates: string[] = [];
      let parent: Element | null = node ? node.parentElement : null;
      let levels = 0;
      while (parent && levels < args.maxAncestors) {
        levels++;
        if (textOf(parent).length <= args.maxChars && isVisible(parent) && !inNav(parent) && !inComposer(parent)) {
          const sel = simpleSelector(parent);
          if (sel) parentCandidates.push(sel);
        }
        parent = parent.parentElement;
      }

      // Fix 4b: ultimul bloc mare de text din DOM + urcarea „2x" până la
      // containerul de mesaj (peste el, textul crește prea puțin — e chatul).
      const genericCandidates: string[] = [];
      let seed: Element | null = null;
      for (let i = pool.length - 1; i >= 0; i--) {
        const el = pool[i];
        const t = textOf(el);
        if (t.length < args.minChars || t.length > args.maxChars) continue;
        if (!isVisible(el) || inNav(el) || inComposer(el) || !isNew(el)) continue;
        seed = el;
        break;
      }
      if (seed) {
        let cur: Element = seed;
        let curLen = textOf(seed).length;
        for (let step = 0; step <= args.maxAncestors; step++) {
          const above: Element | null = cur.parentElement;
          if (!above) break;
          const aboveLen = textOf(above).length;
          if (aboveLen > args.maxChars || inNav(above) || inComposer(above)) break;
          if (aboveLen < curLen * 2) break;
          cur = above;
          curLen = aboveLen;
        }
        const topSel = simpleSelector(cur);
        const seedSel = simpleSelector(seed);
        if (topSel) genericCandidates.push(topSel);
        if (seedSel && seedSel !== topSel) genericCandidates.push(seedSel);
      }

      return {
        invalid: false,
        count,
        visible,
        editable,
        role: node ? node.getAttribute('role') : null,
        userAncestor,
        markerBlock,
        parentCandidates,
        genericCandidates
      };
    },
    {
      s: selector,
      navSels: NAV_SELECTORS,
      markers: RESPONSE_TOOL_MARKERS,
      minChars: opts.minChars,
      maxChars: opts.maxChars,
      maxAncestors: opts.maxAncestors,
      maxMatches: opts.maxMatches,
      echo: String(opts.echo || '')
    }
  );
}

function hasToolMarker(text: string): boolean {
  for (const m of RESPONSE_TOOL_MARKERS) {
    if (text.indexOf(m) >= 0) return true;
  }
  return false;
}

/** Textul pe care îl dă un selector azi, cu ACELAȘI reader ca la rulare. */
async function readResponseText(page: Page, selector: string): Promise<string> {
  try {
    return await getLastResponseText(page, [selector]);
  } catch (e: any) {
    log('reading a candidate response failed (' + selector + '): ' + (e?.message ?? String(e)));
    return '';
  }
}

/**
 * v2.5.47 (bug #106): validează CONȚINUTUL unui selector de răspuns (vezi
 * blocul de mai sus). Întoarce `ok` + selectorul de folosit — care poate fi
 * propunerea AI, un părinte mai bogat (Fix 3) sau fallback-ul generic (Fix 4).
 */
export async function validateResponseSelector(
  page: Page,
  selector: string,
  opts: { echoText?: string } = {}
): Promise<ResponseContentCheck> {
  const want = String(selector || '').trim();
  let probe: ResponseProbe | null = null;
  if (want) {
    try {
      probe = await probeResponseElement(page, want, {
        minChars: RESPONSE_MIN_CHARS,
        maxChars: RESPONSE_MAX_CHARS,
        maxAncestors: RESPONSE_MAX_ANCESTORS,
        maxMatches: RESPONSE_MAX_MATCHES,
        echo: opts.echoText
      });
    } catch (e: any) {
      log('probe of the proposed response failed (' + want + '): ' + (e?.message ?? String(e)));
      probe = null;
    }
  }

  let reason = 'the AI answered null for "response"';
  let chars = 0;
  let bestChars = 0;
  let needMarker = false;
  /** Propunerea AI a trecut de verificările structurale (nu e input/bulă/etc.). */
  let structurallyOk = false;
  /** Cel mai mult text dat de părinți/fallback-uri (baza excepției de mai jos). */
  let bestOther = 0;

  if (want && probe) {
    let structural: string | null = null;
    if (probe.invalid) structural = 'invalid selector';
    else if (probe.count === 0) structural = 'no element matches';
    else if (probe.count > RESPONSE_MAX_MATCHES)
      structural = 'too generic (' + probe.count + ' matches)';
    else if (!probe.visible) structural = 'not visible';
    else if (probe.editable || probe.role === 'textbox') structural = 'it matches the chat input';
    else if (probe.userAncestor) structural = 'it matches the user message bubble';
    // ce nu se poate stoca nu se acceptă nici aici (learn() îl refuză oricum):
    // altfel am raporta „validat" pentru un selector care moare la salvare
    else if (!isUsableSelector(want)) structural = 'overly generic selector (' + want + ')';

    if (structural) {
      reason = structural;
      // măsurăm și propunerea respinsă structural: `chars` e baza regulii 2x
      // pentru părinți (altfel orice părinte ar trece drept „mai bogat")
      if (probe.count > 0) {
        const text = await readResponseText(page, want);
        chars = text.length;
        bestChars = chars;
      }
    } else {
      structurallyOk = true;
      const text = await readResponseText(page, want);
      chars = text.length;
      bestChars = chars;
      // Fix 2: un tool call din pagină care nu ajunge în textul citit = pierdut.
      const markerRequired = probe.markerBlock === 'after' || probe.markerBlock === 'inside';
      if (!hasToolMarker(text) && markerRequired) {
        needMarker = true;
        log('response selector missed tool call markers');
        reason = 'response selector missed tool call markers';
      } else if (chars < RESPONSE_MIN_CHARS) {
        // Fix 1: fragment de răspuns, nu răspunsul întreg.
        log('response selector rejected: only ' + chars + ' chars (need >' + RESPONSE_MIN_CHARS + ')');
        reason = 'only ' + chars + ' chars (need >' + RESPONSE_MIN_CHARS + ')';
      } else {
        const phrase = promoPhraseHit(text);
        if (phrase) {
          log('response selector rejected (promo text „' + phrase + '"): ' + want);
          reason = 'the text is a promo card ("' + phrase + '")';
        } else if (opts.echoText && echoContains(text, opts.echoText)) {
          log('response selector rejected (it contains the message we just sent): ' + want);
          reason = 'it contains the message we just sent';
        } else {
          return {
            ok: true,
            reason: 'ok',
            selector: want,
            source: 'ai',
            chars,
            bestChars: chars,
            retryable: false
          };
        }
      }
    }
  }

  // Fix 3 + Fix 4: părintele cu de 2x mai mult text, apoi fallback-ul generic.
  const candidates: Array<{ selector: string; source: ResponseSelectorSource }> = [];
  if (probe) {
    for (const p of probe.parentCandidates) candidates.push({ selector: p, source: 'parent' });
  }
  for (const f of RESPONSE_FALLBACK_SELECTORS) candidates.push({ selector: f, source: 'fallback' });
  // Fix 4b doar când știm că tocmai s-a trimis un mesaj (ancora = mesajul
  // nostru, deci „text nou"): la descoperirea proactivă, de pe un ecran de
  // bun-venit, un bloc generic de 200+ caractere poate fi marketing sau
  // istoric, nu răspuns (Fix 5: mai bine amânăm decât să învățăm ceva greșit).
  if (probe && opts.echoText) {
    for (const g of probe.genericCandidates) candidates.push({ selector: g, source: 'fallback' });
  }

  const tried = new Set<string>(want ? [want] : []);
  for (const c of candidates) {
    if (!c.selector || tried.has(c.selector) || !isUsableSelector(c.selector)) continue;
    tried.add(c.selector);
    const text = await readResponseText(page, c.selector);
    const n = text.length;
    if (n > bestChars) bestChars = n;
    if (n > bestOther) bestOther = n;
    if (n < RESPONSE_MIN_CHARS) continue;
    if (c.source === 'parent' && n <= Math.max(chars, 1) * RESPONSE_PARENT_TEXT_RATIO) continue;
    if (needMarker && !hasToolMarker(text)) continue;
    if (promoPhraseHit(text)) continue;
    if (opts.echoText && echoContains(text, opts.echoText)) continue;
    log(
      (c.source === 'parent'
        ? 'response selector upgraded to parent: '
        : 'response selector fallback: ') + c.selector
    );
    return {
      ok: true,
      reason: 'ok',
      selector: c.selector,
      source: c.source,
      chars: n,
      bestChars,
      retryable: false
    };
  }

  // Fix 1 (excepție): un răspuns CHIAR scurt (sub 200 de caractere) nu e un
  // fragment. Dacă propunerea a trecut verificările structurale, nu pierde
  // niciun tool call și în pagină nu există text semnificativ mai mare, e cea
  // mai bună variantă — altfel am refuza orice răspuns scurt („Ok, gata.")
  // exact când selectorul static e rupt. Doar în reparația reactivă: `echoText`
  // e mesajul tocmai trimis, deci știm că un răspuns există.
  if (
    structurallyOk &&
    chars > 0 &&
    chars < RESPONSE_MIN_CHARS &&
    !needMarker &&
    opts.echoText &&
    bestOther < Math.max(chars * RESPONSE_PARENT_TEXT_RATIO, RESPONSE_MIN_CHARS)
  ) {
    log('response selector accepted as-is (short reply, ' + chars + ' chars)');
    return {
      ok: true,
      reason: 'ok',
      selector: want,
      source: 'ai',
      chars,
      bestChars,
      retryable: false
    };
  }

  // Fix 1.5/Fix 5: reîncercăm doar dacă ÎN PAGINĂ există text de răspuns de
  // măsurat — altfel AI-ul ar ghici iar un container parțial (bug #106).
  return {
    ok: false,
    reason,
    selector: '',
    source: 'none',
    chars,
    bestChars,
    retryable: bestChars >= RESPONSE_MIN_CHARS
  };
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
    if (slot === 'response') {
      // v2.5.47 (bug #106): conținutul, nu doar existența — vezi
      // validateResponseSelector (≥200 caractere, tool call prins, părinte,
      // fallback generic).
      const check = await validateResponseSelector(page, sel, { echoText: opts.echoText });
      if (!check.ok) {
        log('respins response (' + check.reason + '): ' + sel);
        continue;
      }
      assignSlot(valid, slot, check.selector);
      log('validat ' + slot + ': ' + check.selector + ' (' + check.chars + ' caractere)');
      continue;
    }
    try {
      // v2.5.47 (bug #106): aici rămân doar `newChat`/`stopButton` — `response`
      // are propriul drum, cu validare de conținut (validateResponseSelector).
      const probe = await page.evaluate<SlotProbe, { s: string }>(
        (args) => {
          let nodes: NodeListOf<Element>;
          try {
            nodes = document.querySelectorAll(args.s);
          } catch {
            return { count: -1 };
          }
          const count = nodes.length;
          if (count === 0 || count > 20) return { count };
          const el = nodes[0] as HTMLElement;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          const visible =
            r.width >= 6 && r.height >= 6 && st.visibility !== 'hidden' && st.display !== 'none';
          return { count, visible };
        },
        { s: sel }
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
 *
 * v2.5.45 (bug #102), fișier v3: `_meta.auto` = copia plată a selectorilor
 * descoperiți automat („<provider>.<slot>": selector), iar
 * `_meta.discoveryDate.<provider>` = data ultimei descoperiri (cache 7 zile,
 * vezi DISCOVERY_CACHE_MS). Ambele sunt scrise de noi; la încărcare `_meta.auto`
 * e doar o a doua sursă pentru sloturile care lipsesc din `providers`.
 */
const USER_FILE_VERSION = 3;

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
  // v2.5.45 (bug #102): `_meta.auto` = aceiași selectori descoperiți automat,
  // dar într-o listă plată „<provider>.<slot>": ușor de citit/șters de mână și
  // explicit „auto" (nu „locked", ca cheile plate din rădăcină).
  const auto: Record<string, string> = {};
  for (const [pid, slots] of Object.entries(providers)) {
    for (const [slot, entry] of Object.entries(slots as Record<string, unknown>)) {
      const sel = (entry as { selector?: unknown })?.selector;
      if (typeof sel === 'string' && sel) auto[pid + '.' + slot] = sel;
    }
  }
  const meta: Record<string, unknown> = { locked: Object.keys(locked) };
  if (count) meta.auto = auto;
  if (discoveryDates.size) {
    const dates: Record<string, string> = {};
    for (const [pid, at] of discoveryDates) dates[pid] = new Date(at).toISOString();
    meta.discoveryDate = dates;
  }
  // amprenta se calculează ÎNAINTE de a adăuga `_meta` (altfel s-ar auto-include)
  payload._meta = { ...meta, writtenHash: hashUserPayload(payload) };
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

  // v2.5.45 (bug #102): data ultimei descoperiri (cache-ul de 7 zile).
  if (meta.discoveryDate && typeof meta.discoveryDate === 'object') {
    for (const [pid, when] of Object.entries<string>(meta.discoveryDate)) {
      const t = Date.parse(String(when));
      if (Number.isFinite(t)) discoveryDates.set(pid, t);
    }
  }

  let loaded = 0;
  let auto = 0;
  let pruned = 0;
  const handled = new Set<string>();

  // (a) chei plate „provider.slot" = selecții scrise manual → locked implicit
  for (const [key, value] of Object.entries<any>(data)) {
    if (USER_FILE_RESERVED.has(key)) continue;
    const parsed = splitSlotKey(key);
    if (!parsed) continue;
    const sel = typeof value === 'string' ? value : value?.selector;
    if (typeof sel !== 'string' || !sel.trim()) continue;
    if (selectors.learnLocked(parsed.provider, parsed.slot, sel)) {
      loaded++;
      handled.add(parsed.provider + '.' + parsed.slot);
    }
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
        handled.add(pid + '.' + slot);
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

  // (c) v2.5.45 (bug #102): `_meta.auto` — lista plată a descoperirilor
  // automate, pentru sloturile care lipsesc din `providers`. Un fișier editat
  // manual nu resuscitează nimic prin ea.
  if (!userEdited && meta.auto && typeof meta.auto === 'object') {
    for (const [key, value] of Object.entries<string>(meta.auto)) {
      const parsed = splitSlotKey(key);
      if (!parsed || handled.has(key)) continue;
      const sel = typeof value === 'string' ? value.trim() : '';
      if (!sel) continue;
      if (selectors.learn(parsed.provider, parsed.slot, sel, 'ai')) {
        loaded++;
        auto++;
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

async function bundledPrimarySelectorsWork(
  page: Page,
  providerId: string,
  slots: SlotName[]
): Promise<boolean> {
  for (const slot of slots) {
    const selector = selectors.primary(providerId, slot);
    if (!selector) return false;
    try {
      const locator = page.locator(selector).first();
      if (
        (await locator.count()) === 0 ||
        !(await locator.isVisible()) ||
        !(await locator.isEnabled())
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
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
  if (await isLoginOrCaptchaPage(page)) {
    log('skip ' + providerId + ' — login/CAPTCHA page detected');
    noteProviderNotReady(providerId, 'login/CAPTCHA page');
    return null;
  }
  if (await bundledPrimarySelectorsWork(page, providerId, [slot])) {
    log('skip ' + providerId + ' — bundled ' + slot + ' selector works');
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
  const cancellationsBefore = getAIFinderCancellationCount();
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
    const discovered = await findSelectorsWithAI(page, label, [slot], {
      providerId,
      echoText,
      // conținutul de răspuns a fost verificat mai sus (hasResponseContentToFind)
      replyPresent: slot === 'response' ? true : undefined
    });
    if (!discovered) {
      if (getAIFinderCancellationCount() === cancellationsBefore) {
        dropStaleOverride(providerId, slot);
      }
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
    if (!found) {
      if (discovered.finderId) {
        publishAIFinderStatus({
          id: discovered.finderId,
          providerId,
          providerName: label,
          phase: 'failed',
          message: 'Repair failed. Manual intervention required.'
        });
      }
      dropStaleOverride(providerId, slot);
    }
    return found;
  } catch (e: any) {
    log('AI finder a eșuat: ' + (e?.message ?? String(e)));
    dropStaleOverride(providerId, slot);
    return null;
  } finally {
    inFlight.delete(key);
  }
}

/* =========================================================================
 * v2.5.45 (bug #102) — DESCOPERIRE PROACTIVĂ + REPARAREA INPUTULUI
 *
 * Intrarea reactivă (discoverForHealer, de mai sus) rămâne pentru cazul „un
 * slot a căzut". Aici e a doua intrare, cerută de providers/base.ts:
 *   - la conectare (pagină încărcată + logat) → TOATE sloturile dintr-o dată;
 *   - la composer trunchiat → DOAR inputul, imediat, fără să așteptăm alt slot.
 * Rezultatele se salvează ca override-uri auto (how='ai', NU locked), deci o
 * descoperire ulterioară le poate înlocui; sloturile cu selecție manuală sunt
 * sărite (bug #101).
 * ========================================================================= */

/** Data configului de selectori activ (bundled/remote); 0 = necunoscută. */
function selectorConfigDate(): number {
  try {
    const t = Date.parse(configInfo().updated || '');
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Fix 1 / Fix 5 (bug #102): e momentul pentru o descoperire proactivă?
 * Declanșatorii: prima conectare la provider, selectorii (bundled/remote) mai
 * vechi de 30 de zile, o verificare anterioară eșuată sau o descoperire rămasă
 * în așteptare după login (Fix 2). Cache-ul de 7 zile (Fix 5) oprește
 * repetarea cât timp selectoarele încă funcționează.
 */
function discoveryDue(providerId: string, now: number): { due: boolean; reason: string } {
  if (discoveryFailed.has(providerId)) {
    return { due: true, reason: 'the last verification failed' };
  }
  if (pendingDiscovery.has(providerId)) {
    return { due: true, reason: 'pending after login' };
  }
  const last = discoveryDates.get(providerId);
  if (!last) return { due: true, reason: 'first connect' };
  const configDate = selectorConfigDate();
  if (configDate && now - configDate >= DISCOVERY_STALE_MS) {
    return { due: true, reason: 'the selectors are older than 30 days' };
  }
  const age = now - last;
  if (age >= DISCOVERY_CACHE_MS) {
    return { due: true, reason: 'the discovery cache expired (7 days)' };
  }
  return {
    due: false,
    reason: 'discovered ' + Math.round(age / 3600000) + 'h ago (cache: 7 days)'
  };
}

/**
 * Fix 2 (bug #102): pagina nu e încă gata (login, CAPTCHA, chat gol) — nu
 * consumăm analiza AI, dar ținem minte că descoperirea e datorată: la
 * următoarea conectare (după login / schimbarea URL-ului) se reia singură.
 * Cel mult MAX_PROACTIVE_ATTEMPTS încercări per sesiune.
 */
export function noteProviderNotReady(providerId: string, reason: string): void {
  const seen = pendingDiscovery.get(providerId) ?? 0;
  if (seen >= MAX_PROACTIVE_ATTEMPTS) return;
  pendingDiscovery.set(providerId, seen + 1);
  const label = PROVIDER_LABELS[providerId] || providerId;
  log(label + ' not ready (' + reason + ') — will retry after login');
}

/** Marchează descoperirea reușită: data (persistată) + curăță flagurile de eșec. */
function markDiscovered(providerId: string, at = Date.now()): void {
  discoveryDates.set(providerId, at);
  discoveryFailed.delete(providerId);
  pendingDiscovery.delete(providerId);
  inputRepairFailures.delete(providerId);
  saveUserSelectors();
}

/** v2.5.45 (bug #102): data ultimei descoperiri pentru un provider (sau null). */
export function discoveryDateFor(providerId: string): number | null {
  return discoveryDates.get(providerId) ?? null;
}

/** Doar pentru teste: uită cache-ul de descoperire din sesiune. */
export function resetDiscoveryState(): void {
  discoveryDates.clear();
  discoveryFailed.clear();
  pendingDiscovery.clear();
  proactiveAttempts.clear();
  inputRepairFailures.clear();
  inputRepairGaveUp.clear();
}

/**
 * Full discovery for Repair Selectors asks for all slots (input required,
 * other slots optional), validates them in the page and saves valid overrides
 * auto. Întoarce ce s-a rulat/salvat, ca apelantul (și comanda manuală) să
 * poată raporta. Fail-open: orice eroare lasă fluxul normal neatins.
 */
export async function proactiveDiscover(
  page: Page,
  providerId: string,
  opts: { force?: boolean; statusId?: string } = {}
): Promise<DiscoveryOutcome> {
  const label = PROVIDER_LABELS[providerId] || providerId;
  const skip = (reason: string, pending = false): DiscoveryOutcome => ({
    ran: false,
    applied: [],
    reason,
    pending: pending || undefined
  });

  if (await isLoginOrCaptchaPage(page)) {
    log('skip ' + providerId + ' — login/CAPTCHA page detected');
    noteProviderNotReady(providerId, 'login/CAPTCHA page');
    return skip('login/CAPTCHA page detected', true);
  }
  if (
    !opts.force &&
    (await bundledPrimarySelectorsWork(page, providerId, [
      'input',
      'response',
      'newChat'
    ]))
  ) {
    log('skip ' + providerId + ' — bundled selectors work');
    return skip('bundled selectors work');
  }

  const settings = finderSettings();
  if (!settings.enabled && !opts.force) {
    log('AI finder dezactivat (freekit.aiSelectorFinder=false)');
    return skip('the AI finder is disabled (freekit.aiSelectorFinder)');
  }

  // Fix 4 (bug #101): sloturile cu selecție manuală rămân ale utilizatorului.
  const slots: SlotName[] = [];
  for (const s of SLOTS) {
    if (selectors.isLocked(providerId, s)) {
      log('skip ' + providerId + ':' + s + ' — user-locked');
      continue;
    }
    slots.push(s);
  }
  if (!slots.length) {
    log('skip ' + providerId + ' — every slot is user-locked');
    return skip('every slot is user-locked');
  }

  const now = Date.now();
  const due = discoveryDue(providerId, now);
  if (!opts.force && !due.due) {
    log('skip proactive discovery for ' + label + ' — ' + due.reason);
    return skip(due.reason);
  }

  // Fix 2: cel mult MAX_PROACTIVE_ATTEMPTS descoperiri per sesiune (o comandă
  // manuală explicită nu e limitată de asta).
  const attempts = proactiveAttempts.get(providerId) ?? 0;
  if (!opts.force && attempts >= MAX_PROACTIVE_ATTEMPTS) {
    log(
      'skip proactive discovery for ' + label + ' — ' + attempts + '/' +
        MAX_PROACTIVE_ATTEMPTS + ' attempts already used in this session'
    );
    return skip('the attempt limit for this session was reached');
  }

  // Fix 2: fără căsuță de chat în DOM nu avem ce descoperi (login/CAPTCHA) —
  // lăsăm descoperirea „în așteptare" și o reluăm după autentificare.
  if (!opts.force && !(await inputAvailable(page, providerId, 3000))) {
    noteProviderNotReady(providerId, 'login page?');
    return skip('the provider is not ready (login page?)');
  }

  proactiveAttempts.set(providerId, attempts + 1);
  log('running selector discovery for ' + label + (opts.force ? ' (manual)' : ''));

  try {
    const discovered = await findSelectorsWithAI(page, label, slots, {
      required: ['input'],
      onboarding: true,
      providerId,
      statusId: opts.statusId
    });
    if (!discovered) {
      discoveryFailed.add(providerId);
      log('proactive discovery failed for ' + label + ' — nothing usable');
      return { ran: true, applied: [], reason: 'the AI answered no usable selector' };
    }

    const validated = await validateSelectors(page, discovered);
    const applied: string[] = [];
    for (const s of SLOTS) {
      const sel = validated[s];
      if (!sel) continue;
      const stored = selectors.learn(providerId, s, sel, 'ai', {
        confidence: validated.confidence,
        reasoning: validated.reasoning
      });
      if (stored) applied.push(s + '=' + sel);
      else log('AI finder: respins la salvare (' + s + '): ' + sel);
    }
    if (!applied.length) {
      discoveryFailed.add(providerId);
      log('proactive discovery found nothing valid for ' + label + ' — manual fix may be needed');
      if (discovered.finderId) {
        publishAIFinderStatus({
          id: discovered.finderId,
          providerId,
          providerName: label,
          phase: 'failed',
          message: 'Repair failed. Manual intervention required.'
        });
      }
      return { ran: true, applied: [], reason: 'no selector passed validation' };
    }

    markDiscovered(providerId);
    log('discovered ' + label + ' selectors: ' + applied.join(', '));
    return { ran: true, applied, reason: 'ok' };
  } catch (e: any) {
    discoveryFailed.add(providerId);
    log('proactive discovery failed for ' + label + ': ' + (e?.message ?? String(e)));
    return { ran: true, applied: [], reason: e?.message ?? String(e) };
  }
}

/**
 * Fix 3 (bug #102): composerul a trunchiat mesajul → inputul e suspect pentru
 * sesiunea curentă. Căutăm SPECIFIC căsuța de chat (fără să așteptăm ca alt
 * slot să pice) și, dacă găsim unul valid, îl salvăm ca override auto și îl
 * întoarcem apelantului pentru retrimiterea mesajului. După
 * MAX_INPUT_REPAIR_FAILURES eșecuri din sesiune ridicăm mâna (`gaveUp`) ca
 * chatView-ul să afișeze cardul „fix manual".
 */
export async function repairChatInput(
  page: Page,
  providerId: string
): Promise<InputRepairResult> {
  const label = PROVIDER_LABELS[providerId] || providerId;
  if (await isLoginOrCaptchaPage(page)) {
    log('skip ' + providerId + ' — login/CAPTCHA page detected');
    noteProviderNotReady(providerId, 'login/CAPTCHA page');
    return { selector: null, gaveUp: false, reason: 'login/CAPTCHA page detected' };
  }
  if (await bundledPrimarySelectorsWork(page, providerId, ['input'])) {
    log('skip ' + providerId + ' — bundled input selector works');
    return { selector: null, gaveUp: false, reason: 'bundled input selector works' };
  }
  // Fix 4 (bug #101): inputul cu selecție manuală nu se atinge.
  if (selectors.isLocked(providerId, 'input')) {
    log('skip ' + providerId + ':input — user-locked');
    return { selector: null, gaveUp: false, reason: 'input is user-locked' };
  }
  const settings = finderSettings();
  if (!settings.enabled) {
    return { selector: null, gaveUp: false, reason: 'the AI finder is disabled' };
  }

  let host = '?';
  try {
    host = new URL(page.url()).origin;
  } catch {
    /* URL nevalid — folosim cheia '?' */
  }
  const key = providerId + ':input-repair:' + host;
  if (inFlight.has(key)) {
    log('input repair already running for ' + key);
    return { selector: null, gaveUp: false, reason: 'a repair is already running' };
  }
  inFlight.add(key);
  const cancellationsBefore = getAIFinderCancellationCount();
  log('input suspect for ' + label + ' — asking the AI finder for the composer');
  try {
    const discovered = await findSelectorsWithAI(page, label, ['input'], { inputOnly: true });
    const sel = discovered?.input;
    if (sel) {
      // aceeași validare strictă ca la descoperire (vizibil, activ, acceptă
      // text, în viewport, în jumătatea de jos)
      const check = await validateChatInputSelector(page, sel);
      if (check.ok) {
        const stored = selectors.learn(providerId, 'input', sel, 'ai', {
          confidence: discovered?.confidence,
          reasoning: discovered?.reasoning
        });
        if (stored) {
          discoveryFailed.delete(providerId);
          pendingDiscovery.delete(providerId);
          inputRepairFailures.delete(providerId);
          saveUserSelectors();
          log('input repaired for ' + label + ': ' + sel);
          return { selector: sel, gaveUp: false, reason: 'ok' };
        }
        log('input repair refused at save time (' + sel + ')');
      } else {
        log('input repair rejected (' + check.reason + '): ' + sel);
      }
    } else {
      log('input repair found nothing for ' + label);
    }
  } catch (e: any) {
    log('input repair failed for ' + label + ': ' + (e?.message ?? String(e)));
  } finally {
    inFlight.delete(key);
  }

  if (getAIFinderCancellationCount() !== cancellationsBefore) {
    return { selector: null, gaveUp: false, reason: 'repair cancelled by user' };
  }

  // Fix 3: au fost AI_FINDER_MAX_ATTEMPTS încercări de analiză pentru input,
  // toate ratate — numărăm eșecul de sesiune și, la al treilea, ridicăm mâna.
  const failures = (inputRepairFailures.get(providerId) ?? 0) + 1;
  inputRepairFailures.set(providerId, failures);
  const gaveUp = failures >= MAX_INPUT_REPAIR_FAILURES && !inputRepairGaveUp.has(providerId);
  if (gaveUp) {
    inputRepairGaveUp.add(providerId);
    log(
      'giving up on the input for ' + label + ' after ' + failures +
        '/' + MAX_INPUT_REPAIR_FAILURES + ' failed repairs — manual fix required'
    );
  }
  return {
    selector: null,
    gaveUp,
    reason: 'no valid chat input found (' + failures + '/' + MAX_INPUT_REPAIR_FAILURES + ' failures)'
  };
}

/**
 * Fix 5 (bug #102): comanda manuală „Freekit: Repair Selectors" — pentru
 * providerul care are chatul deschis în Chrome, cu cache-ul ocolit.
 */
export async function rediscoverSelectors(
  page: Page,
  statusId?: string
): Promise<{ providerId: string | null; outcome: DiscoveryOutcome | null }> {
  let providerId: string | null = null;
  try {
    providerId = selectors.providerIdForUrl(page.url());
  } catch {
    /* pagină închisă */
  }
  if (!providerId) {
    if (statusId) {
      publishAIFinderStatus({
        id: statusId,
        providerId: '',
        providerName: 'provider',
        phase: 'failed',
        message: 'Repair failed. Open a supported provider chat and try again.'
      });
    }
    return { providerId: null, outcome: null };
  }
  const outcome = await proactiveDiscover(page, providerId, {
    force: true,
    statusId
  });
  if (statusId && !outcome.ran) {
    publishAIFinderStatus({
      id: statusId,
      providerId,
      providerName: PROVIDER_LABELS[providerId] || providerId,
      phase: 'failed',
      message: outcome.reason
    });
  }
  return { providerId, outcome };
}

/** Înregistrează fallback-ul AI + încarcă selectors-user.json (la activate()). */
export function initAISelectorFinder(storageFsPath: string): void {
  storageDir = storageFsPath || null;
  setAIFinder(discoverForHealer);
  // Reactive input repair is called by providers/base.ts; full discovery is
  // available only through the explicit Repair Selectors command.
  setProactiveDiscovery(proactiveDiscover);
  setInputRepair(repairChatInput);
  setNotReadyNotifier(noteProviderNotReady);
  loadUserSelectorsFromDisk();
  log(
    'AI selector finder pregătit — fișier: ' +
      (userSelectorsFilePath() || '(fără globalStorage)')
  );
}
