import { Locator, Page } from 'playwright';
import {
  anySelectorMatches,
  anySelectorPresent,
  countAssistantResponses,
  getLastResponseRead,
  getLastResponseText,
  healSlot,
  inputAvailable,
  inputRepair,
  notifyNotReady,
  resolveSlot,
  selectors,
  SlotName
} from '../selectors';
import { SendOptions } from './types';
import {
  humanBehaviorEnabled,
  humanClickButton,
  humanScroll,
  humanSettings,
  humanType
} from '../human-behavior';
import { installMutationTracker, waitForAbort, waitStep } from '../mutation';
import { autoAcceptPopups } from '../popups';
import { logLine } from '../log';
import { isProviderCurrentlyUnhealthy, UNHEALTHY_TTL_MS } from '../providerHealth';
import {
  DetectedProviderError,
  detectProviderError,
  isMemoryFullText,
  isPlanLimitText,
  isProviderPromoNoise,
  limitSignalCount,
  LimitSignals,
  ProviderError
} from '../providerErrors';

const log = (msg: string) => console.log('[Freekit]', msg);

/** Momentele (ms de la trimitere) la care verificăm dacă e nevoie de reparare. */
const HEAL_CHECKPOINTS = [4000, 9000, 20000, 40000];

/** v0.8.0: bugetul total de așteptare + pragul de stabilitate a textului. */
/**
 * v2.5.35 (bug #86): 150s era prea scurt pentru răspunsuri lungi (Gemini).
 * v2.5.60: 300s era prea LUNG când providerul e blocat — testul din 8 Oct 2026
 * a pierdut 5 minute pe un DeepSeek care nu răspundea deloc (18:38:41 → 18:43:42).
 * Implicitul scade la 90s, iar detecția adaptivă (STUCK_CHECKPOINTS) oprește
 * la 60s când pagina nu dă NICIUN semn de activitate.
 */
const DEFAULT_PROVIDER_TIMEOUT_S = 90;
const MIN_PROVIDER_TIMEOUT_S = 10;
const MAX_PROVIDER_TIMEOUT_S = 1800;
const STABLE_MS = 2000;

/**
 * v2.5.60: bugetul de așteptare a unui răspuns, din setarea
 * `freekit.providerTimeout` (secunde, implicit 90; înlocuiește vechea
 * `freekit.responseTimeoutMs`, în ms). Citit o dată per mesaj.
 */
export function providerTimeoutMs(): number {
  try {
    // require lazy — în teste Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    const raw = Number(
      v.workspace
        .getConfiguration('freekit')
        .get<number>('providerTimeout', DEFAULT_PROVIDER_TIMEOUT_S)
    );
    const seconds = Number.isFinite(raw)
      ? Math.floor(raw)
      : DEFAULT_PROVIDER_TIMEOUT_S;
    return (
      Math.min(
        MAX_PROVIDER_TIMEOUT_S,
        Math.max(MIN_PROVIDER_TIMEOUT_S, seconds)
      ) * 1000
    );
  } catch {
    return DEFAULT_PROVIDER_TIMEOUT_S * 1000;
  }
}

/**
 * v2.5.60 — DETECȚIE ADAPTIVĂ („providerul lucrează sau e blocat?").
 * La 15s/30s/60s/90s de la trimitere (`STUCK_CHECKPOINTS`): butonul de Stop
 * vizibil (= generează), text de stare thinking/generating/reasoning/stop
 * generating, răspuns nou, URL schimbat (chat nou) — plus scanul de erori de
 * pagină (rate limit / limit reached). La 90s (`STUCK_ABORT_MS`), fără NICIUN
 * semn de viață, abandonăm cu eroare clară — nu se mai așteaptă bugetul întreg.
 */
const STUCK_CHECKPOINTS = [15_000, 30_000, 60_000, 90_000];
/**
 * v2.5.60: pragul de la care „zero activitate" = provider blocat.
 * v2.5.70 (FIX 2): 60s era prea agresiv — un model care „gândește" (fără buton
 * de Stop și fără text de stare în pagină) era abandonat înainte de a apuca să
 * răspundă. Pragul urcă la 90s, aliniat cu bugetul implicit
 * (`freekit.providerTimeout` = 90s).
 */
const STUCK_ABORT_MS = 90_000;

/**
 * v2.5.74 (FIX 5): plafon de așteptare per provider. Qwen rămâne mut pe
 * mesaje simple („Salut!" → nimic, apoi switch pe Mistral), deci îl așteptăm
 * doar 30s — dacă n-a început să răspundă până atunci, îl declarăm „fără
 * răspuns" mai repede și reîncercăm/commutăm. Restul providerilor păstrează
 * bugetul din setări.
 */
const PROVIDER_TIMEOUT_OVERRIDE_MS: Record<string, number> = {
  qwen: 30_000
};

/**
 * v2.7 (FIX 2 — audit H1): plafonul de așteptare pentru un provider marcat
 * „unhealthy" (mut la un mesaj recent — vezi `recordProviderNoResponse`).
 * `unhealthyAt` era scris, dar niciodată citit: mesajele următoare așteptau
 * din nou tot bugetul (până la 90s) pentru un provider despre care știam deja
 * că nu răspunde. Același raționament ca override-ul de mai sus pentru Qwen.
 */
const UNHEALTHY_WAIT_MS = 30_000;

/** v2.7 (FIX 2): providerii pentru care am anunțat deja plafonul în chat. */
const unhealthyNoticesShown = new Set<string>();

/**
 * v2.8.6 (FIX 2): cât așteptăm „ack"-ul din protocolul de prompt împărțit
 * (msg 1 = system prompt-ul, msg 2 = task-ul userului). Ack-ul NU e răspunsul
 * task-ului: dacă nu vine nimic în acest interval (ecou, model mut), mergem mai
 * departe cu msg 2 — fără card de eroare și fără reîncercări.
 */
const ACK_WAIT_MS = 30_000;

/** v2.5.74 (FIX 5): promptul SIMPLU pentru reîncercarea unui provider mut. */
const SIMPLE_RETRY_PROMPT =
  'Please reply with one short sentence.';

/**
 * v2.5.70 (FIX 3): promptul de reîncercare automată după un timeout. Înainte de
 * a arunca eroarea (și de a arăta cardul Retry/Switch) cerem o dată un răspuns
 * mai scurt, ca modelul să nu mai „gândească" până la expirarea bugetului.
 */
const TIMEOUT_RETRY_PROMPT =
  'Previous response timed out. Reply with a shorter answer.';

/**
 * v2.5.60: la 90s, fără buton de Stop / text de stare / răspuns nou și fără
 * URL schimbat → providerul e blocat.
 */
export function isProviderStuck(
  working: boolean,
  sawResponse: boolean,
  urlChanged: boolean
): boolean {
  return !working && !sawResponse && !urlChanged;
}

/** v2.5.15 (bug #41): câte continuări „new chat" acceptăm per mesaj. */
const MAX_MEMORY_FULL_RESTARTS = 3;

/** Comparație tolerantă la spații (folosită ca să nu confundăm mesajul nostru). */
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** v0.9.3: prefixul de ecou se aplică doar mesajelor lungi (anti false-positive). */
const ECHO_PREFIX_MIN_CHARS = 40;

/**
 * v0.9.3 FIX Kimi: true dacă `text` este ecoul mesajului trimis. Egalitatea
 * simplă NU e suficientă: bula utilizatorului include etichetele butoanelor de
 * acțiuni („Edit/Copy/Share”), deci textul citit = mesaj + sufix → scăpa de
 * gardă și era declarat „răspuns stabil” (bugul raportat). Acoperim egalitatea
 * normalizată + prefix în AMBELE direcții (doar pentru mesaje lungi — în
 * practică promptul include SYSTEM_PROMPT, deci e mereu > 40 de caractere).
 */
export function isEchoOf(text: string, message: string): boolean {
  const t = normalize(text || '');
  const m = normalize(message || '');
  if (!t || !m) return false;
  if (t === m) return true;
  if (m.length < ECHO_PREFIX_MIN_CHARS) return false;
  return t.startsWith(m) || m.startsWith(t);
}

/**
 * v2.5.3 FIX 7: unii provideri (DeepSeek) ecouază promptul la începutul
 * răspunsului, apoi adaugă tool call-ul — `isEchoOf` respinge tot răspunsul
 * (e prefix), deci tool call-ul se pierde. Aici tăiem DOAR prefixul ecou și
 * păstrăm restul, tolerant la spații (DOM-ul normalizează whitespace-ul).
 *
 * Întoarce răspunsul neschimbat dacă nu recunoaște un ecou.
 */
export function stripEchoedUserMessage(reply: string, message: string): string {
  const raw = String(reply ?? '');
  const msg = String(message ?? '');
  if (!raw || !msg) return raw;

  // gardă: primele ~100 de caractere trebuie să se potrivească (normalizat)
  const head = normalize(msg.slice(0, 100));
  if (!head || !normalize(raw).startsWith(head)) return raw;

  // consumăm mesajul din reply ignorând diferențele de whitespace
  let i = 0;
  let j = 0;
  while (i < raw.length && j < msg.length) {
    if (raw[i] === msg[j]) {
      i++;
      j++;
      continue;
    }
    if (/\s/.test(msg[j])) {
      j++;
      continue;
    }
    if (/\s/.test(raw[i])) {
      i++;
      continue;
    }
    return raw; // divergență reală → nu e ecou, nu atingem răspunsul
  }
  if (j < msg.length) return raw; // mesajul nu a fost consumat integral
  return raw.slice(i).replace(/^\s+/, '');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { getLastResponseText };

/* =========================================================================
 * v0.8.0 — HUMAN BEHAVIOR (anti-detect)
 * ========================================================================= */

/**
 * v2.0.6: pregătește căsuța de input pentru tastare — scroll ocazional (ca un om
 * care verifică pagina) și click "uman" (mișcare + down/up cu pauză).
 */
async function clickInput(page: Page, input: Locator): Promise<void> {
  if (humanBehaviorEnabled() && Math.random() < 0.25) await humanScroll(page);
  await humanClickButton(page, input, 15000);
}

/** Curăță căsuța de input (best-effort) după o anulare în timpul tastării. */
async function clearInputBestEffort(page: Page): Promise<void> {
  try {
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await sleep(150);
  } catch {
    /* curățarea e best-effort */
  }
}

/**
 * Găsește căsuța de input. FAZA I: selectorii vin din selectors.json, iar dacă
 * niciunul nu mai funcționează se încearcă auto-repararea prin fingerprint.
 * Aruncă doar dacă nu există absolut nimic care să accepte text.
 */
export async function findInput(
  page: Page,
  providerId: string,
  label: string,
  timeoutMs = 15000
): Promise<Locator> {
  const found = await resolveSlot(page, providerId, 'input', timeoutMs);
  if (found) {
    log(
      label +
        ': input via ' +
        found.selector +
        // v2.5.45 (bug #102): inputul care a trunchiat un mesaj în sesiunea
        // curentă rămâne „suspect" până se dovedește că scrie corect.
        (isInputSuspect(providerId) ? ' (suspect — truncated a message earlier)' : '')
    );
    return found.locator;
  }
  // v2.0.4: inputul lipsește — dacă pagina e de fapt una de login, semnalăm
  // „login required" (chatView aduce Chrome în față + oferă butonul Retry) în
  // loc de eroarea seacă „could not find the input box".
  if (await detectLoginPage(page)) {
    const url = page.url();
    log(label + ': input missing, login page detected (' + url + ')');
    // Login pages are not valid targets for selector healing.
    notifyNotReady(providerId, 'login page?');
    throw loginError(providerId, url);
  }
  // v2.5.45 (bug #102): CAPTCHA / chat gol = tot „nu e gata", nu „selector stricat".
  if (await detectCaptcha(page)) notifyNotReady(providerId, 'CAPTCHA challenge');
  notifyNotReady(providerId, 'no chat input in the DOM');
  // v2.5.61 (FIX 7): toate tier-urile au fost încercate înainte de a ajunge aici
  // (bundled → user → healer → AI Finder → backup); abia acum cerem ceva
  // utilizatorului, printr-un card minimal cu Retry / Switch provider.
  logLine(
    'selectors',
    'tier 6/7: every repair tier failed for ' + providerId + '.input — asking the user'
  );
  throw new SelectorsBrokenError(
    providerId,
    'input not found (tried: ' + selectors.candidates(providerId, 'input').join(', ') + ')'
  );
}

/**
 * Check bundled selectors quickly; only missing slots enter the healer path.
 * v2.5.75 (FIX 1): verifică TOȚI candidații slotului (nu doar `primary`) — vezi
 * comentariul de mai jos. Exportată pentru testele de integrare.
 */
export async function validateConnectSelectors(
  page: Page,
  providerId: string,
  label: string
): Promise<void> {
  // Response selectors need real assistant content for functional validation.
  // Repair them reactively after sending, never against an empty chat.
  const slots: SlotName[] = ['input', 'newChat'];
  const missing = await Promise.all(
    slots.map(async (slot) => {
      // v2.5.75 (FIX 1): verificăm TOȚI candidații slotului, nu doar `primary`.
      // La Claude, `newChat` e un <a href="/new"> (o alternativă), în timp ce
      // `primary` era butonul cu aria-label — dacă lipsea, healer-ul rula degeaba
      // și rezultatul lui se pierdea, deși un candidat cunoscut funcționa.
      const candidates = selectors.candidates(providerId, slot);
      if (!candidates.length) return { slot, present: false };
      for (const sel of candidates) {
        const locator = page.locator(sel).first();
        try {
          if (
            (await locator.count()) > 0 &&
            (await locator.isVisible()) &&
            (await locator.isEnabled())
          ) {
            return { slot, present: true };
          }
        } catch {
          /* selector invalid / tranziție — încercăm următorul */
        }
      }
      return { slot, present: false };
    })
  );
  if (missing.every((item) => item.present)) {
    logLine('ai-finder', 'skip ' + providerId + ' — bundled selectors work');
    return;
  }
  for (const item of missing) {
    if (item.present) continue;
    log(label + ': bundled ' + item.slot + ' selector missing — trying fingerprint healer');
    const healed = await healSlot(page, providerId, item.slot);
    if (!healed) {
      log(
        label + ': could not repair ' + item.slot +
          ' automatically; run "Freekit: Repair Selectors"'
      );
    }
  }
}

/* =========================================================================
 * v0.9.1 — LOGIN ASSIST
 * Când pagina cere autentificare nu mai blocăm cu o eroare seacă: chatView
 * aduce fereastra Chrome în față, așteaptă login-ul utilizatorului, apoi
 * ascunde fereastra la loc și reia automat operația.
 * ========================================================================= */

/**
 * URL de login/auth (Claude, ChatGPT, Mistral etc. redirecționează aici când
 * nu ești logat). v2.0.4: acoperă `sign_in` / `sign-in` / `signin` / `login` și
 * tokenul `auth` — fără false pozitive pe „oauth" / „author".
 */
export const isLoginUrl = (url: string) =>
  /sign[-_]?in|signin|login|(^|[^a-z])auth([^a-z]|$)/i.test(url || '');

/** Marcaj pe eroare — chatView îl recunoaște și pornește asistentul de login. */
export const LOGIN_REQUIRED_CODE = 'AI_BRIDGE_LOGIN_REQUIRED';

export class LoginRequiredError extends Error {
  readonly code = LOGIN_REQUIRED_CODE;
  constructor(readonly providerId: string, readonly loginUrl: string) {
    super(
      'You are not logged in to ' +
        (providerId || 'this provider') +
        ' (' +
        loginUrl +
        '). Log in through the Chrome window, then press Retry — ' +
        'the flow resumes automatically after login.'
    );
    this.name = 'LoginRequiredError';
  }
}

/** true dacă eroarea cere login manual (robust la copii/instanțe diferite). */
export function isLoginRequiredError(e: any): boolean {
  return !!e && (e.code === LOGIN_REQUIRED_CODE || e instanceof LoginRequiredError);
}

const loginError = (providerId: string, url: string) =>
  new LoginRequiredError(providerId, url);

/* =========================================================================
 * v2.5.61 (FIX 7) — „SELECTORII NU SE MAI POT REPARA"
 *
 * Tier 7 din cascadă: bundled → user-locked → healer → AI Finder (browser) →
 * backup → alt provider au fost toate încercate și niciun selector nu a
 * funcționat. Abia ACUM cerem ceva utilizatorului, cu un card minimal în chat
 * (providers/base.ts nu mai aruncă o eroare seacă plină de selectori încercați).
 * ========================================================================= */

/** Codul purtat de eroarea de selectori stricați (cardul minimal din chat). */
export const SELECTORS_BROKEN_CODE = 'FREEKIT_SELECTORS_BROKEN';

export class SelectorsBrokenError extends Error {
  readonly code = SELECTORS_BROKEN_CODE;
  constructor(readonly providerId: string, readonly detail?: string) {
    super('I can not continue. Check that you are logged in to Chrome.');
    this.name = 'SelectorsBrokenError';
  }
}

/** true dacă toate tier-urile de reparare au eșuat pentru acest provider. */
export function isSelectorsBrokenError(e: any): boolean {
  return !!e && (e.code === SELECTORS_BROKEN_CODE || e instanceof SelectorsBrokenError);
}

/**
 * v2.0.4: rulează ÎN PAGINĂ — true dacă DOM-ul arată ca o pagină de login: un
 * input de parolă vizibil SAU un buton de submit cu text „Sign in"/„Log in".
 * Detecția e conservatoare (doar elemente vizibile), ca să nu confundăm
 * chatul deschis cu o pagină de autentificare.
 */
const scanLoginPage = (): boolean => {
  try {
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = window.getComputedStyle(el as HTMLElement);
      return (
        s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
      );
    };
    const pw = document.querySelector('input[type="password"]');
    if (pw && visible(pw)) return true;
    const btns = Array.prototype.slice.call(
      document.querySelectorAll(
        'button[type="submit"], input[type="submit"], button, [role="button"]'
      )
    ) as Element[];
    for (const b of btns) {
      if (!visible(b)) continue;
      const text = String(
        (b as HTMLElement).innerText ||
          (b as HTMLInputElement).value ||
          b.textContent ||
          ''
      ).trim();
      if (/^(sign|log)[\s-]?(in|on)$/i.test(text)) return true;
    }
    return false;
  } catch {
    return false;
  }
};

/** true dacă pagina curentă pare o pagină de login (URL sau DOM). Best-effort. */
export async function detectLoginPage(page: Page): Promise<boolean> {
  try {
    if (isLoginUrl(page.url())) return true;
    return await page.evaluate(scanLoginPage);
  } catch (e: any) {
    log('detectLoginPage failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

/* =========================================================================
 * v2.5.12 (bug #35) — GUEST MODE („Log in" vizibil, dar composer funcțional)
 * ChatGPT fără cont păstrează composerul activ (câteva mesaje gratuite), deci
 * `findInput` reușește și verificarea de login (doar pe ramura „input lipsă")
 * nu se execută niciodată. Aici detectăm CTA-ul de „nelogat" prin selectorii
 * `loggedOut` din selectors.json (ex: butonul „Log in" din header/sidebar) —
 * prezența lui vizibilă înseamnă sesiune neautentificată, chiar și cu input.
 * Providerii fără slot `loggedOut` nu sunt afectați (lista e goală → false).
 * ========================================================================= */

/** Selectorii `loggedOut` ai providerului (gol dacă nu are detecție configurată). */
export function loggedOutSelectors(providerId: string): string[] {
  try {
    return selectors.candidates(providerId, 'loggedOut');
  } catch {
    return [];
  }
}

/** true dacă pagina afișează un indicator VIZIBIL de sesiune neautentificată. */
export async function detectLoggedOut(
  page: Page,
  providerId: string
): Promise<boolean> {
  for (const sel of loggedOutSelectors(providerId)) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
    } catch (e: any) {
      log('detectLoggedOut: selector failed (' + sel + '): ' + (e?.message ?? String(e)));
    }
  }
  return false;
}

/**
 * v2.5.14 (bug #38): sesiunea e „gata" = URL non-login + fără indicator vizibil
 * de „logged out" + composer renderizat. Un singur eșantion NU e suficient: în
 * tranziția post-login (redirect/reload) header-ul și composerul lipsesc
 * temporar, iar reluarea prematură trimitea mesajul în sesiunea veche —
 * ChatGPT răspundea „the tools … are not available in this session".
 */
export async function isSessionReady(
  page: Page,
  providerId: string
): Promise<boolean> {
  try {
    if (isLoginUrl(page.url())) return false;
    if (await detectLoggedOut(page, providerId)) return false;
    return await inputAvailable(page, providerId, 0);
  } catch {
    return false;
  }
}

/* =========================================================================
 * v1.8.0 — DETECȚIE CAPTCHA
 * Paginile cu verificare „I'm not a robot” (reCAPTCHA challenge / hCaptcha /
 * Cloudflare „Just a moment”) nu pot fi rezolvate automat — chatView aduce
 * fereastra Chrome în față (ca la login) și așteaptă ca utilizatorul să le
 * rezolve, apoi continuă singur.
 * Detecția e CONSERVATOARE (fără false pozitive pe badge-ul reCAPTCHA v3 /
 * widget-uri invizibile): doar challenge-uri reale, vizibile.
 * ========================================================================= */

/** Selectori cu challenge-uri CAPTCHA vizibile (size-ul minim filtrează badge-urile). */
export const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"][src*="bframe"]',
  'iframe[src*="hcaptcha.com"][src*="challenge"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '#challenge-stage',
  '#challenge-running',
  '#cf-please-wait',
  'form#challenge-form',
  'iframe[src*="captcha-delivery.com"]'
];

/** Rulează ÎN PAGINĂ: true dacă există un challenge CAPTCHA vizibil. */
const scanCaptcha = (sels: string[]): boolean => {
  try {
    // regex-ul de titlu e in-linat: funcția e serializată în pagină (vezi selectors.ts)
    if (/just a moment|attention required|verifying you are human|unusual traffic/i.test(document.title || '')) {
      return true;
    }
    if (location.pathname.startsWith('/sorry')) return true;
    for (const sel of sels) {
      let els: Element[] = [];
      try {
        els = Array.prototype.slice.call(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 40) continue; // badge-uri / widget-uri ascunse
        const s = window.getComputedStyle(el as HTMLElement);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) continue;
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
};

/** true dacă pagina curentă cere rezolvarea unui CAPTCHA (best-effort). */
export async function detectCaptcha(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(scanCaptcha, CAPTCHA_SELECTORS);
  } catch (e: any) {
    log('detectCaptcha failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

/* =========================================================================
 * v2.5.1 — ERORI DE PROVIDER („out of free messages”, rate limit, CAPTCHA…)
 * Când chatul web afișează o eroare în loc de răspuns, textul ei NU ajunge în
 * selectorii de răspuns: fără detecție, utilizatorul aștepta 150s și primea
 * „Timeout: no stable response…”. Aici recunoaștem eroarea și aruncăm un mesaj
 * clar (chatView îl afișează ca eroare; login-ul intră pe fluxul dedicat).
 * ========================================================================= */

/**
 * Rulează ÎN PAGINĂ: adună textul vizibil de tip banner/alertă/toast plus coada
 * paginii (bannerele fără rol/clasă evidentă stau spre finalul DOM-ului).
 * Exclude codul și căsuța de input, ca o discuție despre „rate limit” să nu
 * fie confundată cu o eroare reală.
 */
/**
 * v2.5.74 (FIX 3): textul de eroare se citește DOAR din zona de chat — ultimele
 * mesaje ale asistentului, containerul de răspuns și bannerele/alertele care
 * apar PESTE zona de chat. Sidebar-ul, bannerele de upsell, tooltip-urile și
 * cardurile de „Upgrade for more" NU mai intră în scan: un cont Pro cu un banner
 * de upsell în sidebar producea un `plan_limit` fals („Mistral reached its
 * temporary limit").
 */
export const scanProviderErrorText = (args: { responseSels: string[] }): string => {
  const parts: string[] = [];
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const usable = (el: Element): boolean =>
    !el.closest('pre, code, textarea, input, [contenteditable="true"]');
  // zonele de chrome excluse explicit (sidebar / upsell / tooltip / promo)
  const chromeSel =
    'aside, nav, [role="navigation"], [role="complementary"], header, [role="banner"], ' +
    '[class*="sidebar" i], [class*="upsell" i], [class*="promo" i], ' +
    '[class*="paywall" i], [class*="tooltip" i], [class*="upgrade" i], ' +
    '[class*="banner" i]';
  const inChrome = (el: Element): boolean => {
    try {
      return el.closest(chromeSel) !== null;
    } catch {
      return false;
    }
  };
  const push = (el: Element, max = 600): void => {
    if (!visible(el) || !usable(el) || inChrome(el)) return;
    const t = String((el as HTMLElement).innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t && t.length <= max && parts.indexOf(t) < 0) parts.push(t);
  };

  // (a) mesajele de răspuns (ultimele două) — aici apare bannerul de limită
  for (const sel of args.responseSels || []) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els.slice(-2)) push(el, 2000);
  }
  // (b) alerte/toast-uri de eroare, doar dacă nu stau în chrome-ul paginii
  const sels = ['[role="alert"]', '[role="status"]', '[class*="error" i]', '[class*="alert" i]'];
  for (const sel of sels) {
    if (parts.length >= 40) break;
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) push(el);
  }
  return parts.join('\n');
};

/**
 * v2.5.74 (FIX 3): semnalele care confirmă o limită reală — input dezactivat și
 * butonul de trimitere ascuns. Se citesc din zona de chat.
 *
 * Notă: textul e „în chat" prin construcție la ambele apeluri (scanul citește
 * doar zona de chat, iar al doilea apel pornește de la răspunsul citit).
 */
export const scanLimitSignals = (): { inputDisabled: boolean; sendHidden: boolean } => {
  const enabled = (el: Element): boolean => {
    const node = el as HTMLElement;
    if ((node as HTMLInputElement).disabled) return false;
    if (node.getAttribute('aria-disabled') === 'true') return false;
    if (node.getAttribute('readonly') !== null) return false;
    const s = window.getComputedStyle(node);
    return s.pointerEvents !== 'none' && s.display !== 'none' && s.visibility !== 'hidden';
  };
  let inputDisabled = false;
  let sendHidden = true;
  for (const sel of ['textarea', '[contenteditable="true"]', 'div[role="textbox"]']) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) continue; // nu e căsuța de chat
      if (!enabled(el)) inputDisabled = true;
    }
  }
  const sendSels = [
    'button[data-testid*="send" i]',
    'button[aria-label*="send" i]',
    'button[type="submit"]',
    '[class*="send-button" i]'
  ];
  for (const sel of sendSels) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8) {
        sendHidden = false;
        break;
      }
    }
    if (!sendHidden) break;
  }
  return { inputDisabled, sendHidden };
};

/**
 * v2.5.43 (bug #100): rulează ÎN PAGINĂ — primul link de upgrade/plans/pricing
 * (butonul pe care site-ul îl arată când s-a atins limita planului gratuit).
 * Preferă un element vizibil; altfel primul găsit. Întoarce URL absolut.
 */
const scanUpgradeLink = (): string => {
  const sels = [
    'a[href*="/upgrade"]',
    'a[href*="/plans"]',
    'a[href*="/pricing"]'
  ];
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    return (
      s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
    );
  };
  let fallback = '';
  for (const sel of sels) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const href = String((el as HTMLAnchorElement).href || '');
      if (!href) continue;
      if (visible(el)) return href;
      if (!fallback) fallback = href;
    }
  }
  return fallback;
};

/** v2.5.43 (bug #100): citește (best-effort) linkul de upgrade din pagină. */
async function readUpgradeLink(page: Page): Promise<string | undefined> {
  try {
    const href = await page.evaluate<string>(scanUpgradeLink);
    return href || undefined;
  } catch (e: any) {
    log('scanUpgradeLink failed: ' + (e?.message ?? String(e)));
    return undefined;
  }
}

/** Scoate ecoul mesajului trimis din textul paginii (anti false-positive). */
const stripEcho = (text: string, message: string): string => {
  const m = normalize(message);
  if (!m || m.length < ECHO_PREFIX_MIN_CHARS) return text;
  return text.split(m).join(' ');
};

/** Detectează o eroare de provider în textul paginii (banner/toast/coadă). */
async function detectProviderErrorOnPage(
  page: Page,
  providerId: string,
  message: string
): Promise<ProviderError | null> {
  try {
    // v2.5.74 (FIX 3): scanul acoperă DOAR zona de chat (ultimele răspunsuri +
    // alertele care nu stau în sidebar/upsell), nu toată pagina.
    const responseSels = selectors.candidates(providerId, 'response');
    const text = await page.evaluate<string, { responseSels: string[] }>(
      scanProviderErrorText,
      { responseSels }
    );
    // v2.5.43 (bug #100): butonul de upgrade/plans/pricing din pagină — semn de
    // plan gratuit / cotă atinsă, și sursa URL-ului real de pe cardul din chat.
    const upgradeUrl = await readUpgradeLink(page);
    // v2.5.74 (FIX 3): semnalele care confirmă limita (2 din 3).
    const extra = await page
      .evaluate<{ inputDisabled: boolean; sendHidden: boolean }>(scanLimitSignals)
      .catch(() => ({ inputDisabled: false, sendHidden: false }));
    const stripped = stripEcho(text, message);
    const inChat = isPlanLimitText(stripped) || /rate limit|too many requests/i.test(stripped);
    const signals: LimitSignals = {
      textInChat: inChat,
      inputDisabled: extra.inputDisabled,
      sendHidden: extra.sendHidden
    };
    const detected = detectProviderError(stripped, providerId, upgradeUrl, signals);
    if (!detected) {
      // v2.5.74 (FIX 3): text de limită văzut, dar neconfirmat de celelalte
      // semnale (banner/upsell într-un cont care funcționează normal) — nu
      // raportăm eroare; utilizatorul cu cont Pro era blocat degeaba.
      if (isProviderPromoNoise(stripped)) {
        logLine(
          'chat',
          'noticed "limit" text in a banner/promo — ignoring (banner, not chat)'
        );
      } else if (inChat && limitSignalCount(signals) < 2) {
        logLine(
          'chat',
          'noticed "limit" text but only ' + limitSignalCount(signals) +
            '/3 signals — ignoring (banner, not chat)'
        );
      }
      return null;
    }
    if (isEchoOf(detected.message, message)) return null;
    return detected;
  } catch (e: any) {
    log('detectProviderErrorOnPage failed: ' + (e?.message ?? String(e)));
    return null;
  }
}

/** Aruncă eroarea specifică; login-ul folosește fluxul existent (Chrome + Retry). */
function throwProviderError(providerId: string, detected: ProviderError, page: Page): never {
  log('provider error detected (' + detected.kind + '): ' + detected.message);
  if (detected.kind === 'login_required') {
    throw loginError(providerId, page.url());
  }
  throw new DetectedProviderError(providerId, detected);
}

/** Deschide providerul în pagină: refolosește tab-ul dacă e deja pe domeniu. */
export async function openProvider(page: Page, providerId: string, label: string) {
  const url = selectors.url(providerId);
  const host = selectors.host(providerId);
  const current = page.url();

  if (isLoginUrl(current)) {
    throw loginError(providerId, current);
  }

  if (current.startsWith(host)) {
    // v1.8.0: popup-uri de consimțământ care pot bloca inputul
    await autoAcceptPopups(page, { log }).catch(() => []);
    await validateConnectSelectors(page, providerId, label);
    if (await inputAvailable(page, providerId, 200)) {
      return;
    }
    log(label + ': input not found on ' + current + ', navigating to ' + url);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // v1.8.0: acceptă automat popup-urile de cookie/terms după încărcare
  await autoAcceptPopups(page, { log }).catch(() => []);
  // FIX v2: dacă aterizăm tot pe login (ex: Claude fără sesiune), nu mai
  // lăsăm healer-ul să rătăcească prin pagina de login (#email).
  if (isLoginUrl(page.url())) {
    notifyNotReady(providerId, 'login page?');
    throw loginError(providerId, page.url());
  }
  await validateConnectSelectors(page, providerId, label);
  await findInput(page, providerId, label, 200);
}

/** Chat nou: buton dedicat -> auto-reparare (DOAR dacă butonul nu mai există) -> navigare. */
export async function newChatVia(page: Page, providerId: string, label: string) {
  // v1.8.0: popup-uri de consimțământ care pot acoperi butonul de chat nou
  await autoAcceptPopups(page, { log }).catch(() => []);
  // v2.5.10 (bug #20): URL-ul dinainte de click — dacă se schimbă, chatul nou
  // a fost creat și nu mai insistăm cu alți candidați.
  const beforeUrl = page.url();
  for (const sel of selectors.candidates(providerId, 'newChat')) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) === 0 || !(await btn.isVisible())) continue;
      await humanClickButton(page, btn);
      await sleep(1200);
      // FIX v2: 5s erau prea puțini (ex: DeepSeek — tranziția spre chatul nou e lentă)
      if (await inputAvailable(page, providerId, 8000)) {
        selectors.note(providerId, 'newChat', sel);
        log(label + ': new chat via ' + sel);
        return;
      }
      // v2.5.10 (bug #20): dacă URL-ul s-a schimbat, click-ul chiar a produs
      // chatul nou — NU mai apăsăm și alți candidați (altfel rămâneau
      // conversații goale în sidebar-ul site-ului).
      if (page.url() !== beforeUrl) {
        try {
          await autoAcceptPopups(page, { log }).catch(() => []);
          await findInput(page, providerId, label, 15000);
          selectors.note(providerId, 'newChat', sel);
          log(label + ': new chat via ' + sel + ' (URL changed)');
          return;
        } catch (e) {
          if (isLoginRequiredError(e)) throw e;
          /* altfel: următorul candidat / navigarea de fallback */
        }
      }
    } catch (e) {
      if (isLoginRequiredError(e)) throw e;
      /* încearcă următorul selector */
    }
  }

  // FIX v2 — "heal doar când e stricat": reparăm butonul DOAR dacă niciun
  // candidat cunoscut nu mai există în DOM. Dacă butonul există (chiar dacă
  // click-ul nu a confirmat încă), NU învățăm un selector fragil de tip
  // nth-of-type (ex: DeepSeek) — trecem direct la navigare.
  const known = selectors.candidates(providerId, 'newChat');
  if (await anySelectorPresent(page, known)) {
    log(label + ': the new chat button is still in the DOM — no auto-repair, falling back to navigation');
  } else {
    const healed = await healSlot(page, providerId, 'newChat');
    if (healed) {
      const btn = page.locator(healed).first();
      try {
        await humanClickButton(page, btn);
        await sleep(1200);
        if (await inputAvailable(page, providerId, 8000)) {
          log(label + ': new chat via repaired selector (' + healed + ')');
          return;
        }
      } catch {
        /* cădem pe navigare */
      }
    }
  }

  const url = selectors.url(providerId);
  log(label + ': new chat fallback, navigating to ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // v1.8.0: popup-uri de cookie/terms după navigarea proaspătă
  await autoAcceptPopups(page, { log }).catch(() => []);
  // v0.9.1: sesiunea poate expira între open() și newChat() — același răspuns
  // ca la openProvider (chatView aduce Chrome în față și așteaptă login-ul).
  if (isLoginUrl(page.url())) throw loginError(providerId, page.url());
  await findInput(page, providerId, label, 30000);
}

/**
 * v2.5.10 (bug #20): normalizare tolerantă de URL (fără query/hash, fără „/" final).
 */
const normalizeNavUrl = (u: string): string =>
  String(u || '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** true dacă URL-ul e chiar pagina de start a providerului (nu o conversație). */
export function isProviderRootUrl(url: string, providerId: string): boolean {
  const u = normalizeNavUrl(url);
  if (!u) return true;
  try {
    return u === normalizeNavUrl(selectors.url(providerId));
  } catch {
    return false;
  }
}

/**
 * v2.5.10 (bug #20): reia conversația deja începută în browser (URL-ul salvat
 * pentru conversația activă din VS Code) — NU se mai deschide un chat nou la
 * fiecare mesaj. Aruncă dacă URL-ul nu poate fi folosit (chat șters de pe site,
 * sesiune expirată): apelantul pornește atunci un chat nou.
 */
export async function resumeConversation(
  page: Page,
  providerId: string,
  url: string,
  label: string
): Promise<void> {
  await autoAcceptPopups(page, { log }).catch(() => []);
  if (normalizeNavUrl(page.url()) !== normalizeNavUrl(url)) {
    log(label + ': resuming the browser conversation at ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await autoAcceptPopups(page, { log }).catch(() => []);
    // v0.9.1: sesiunea poate expira între mesaje — același flux de login ca la open()
    if (isLoginUrl(page.url())) {
      notifyNotReady(providerId, 'login page?');
      throw loginError(providerId, page.url());
    }
  }
  await findInput(page, providerId, label, 30000);
}

/* =========================================================================
 * v2.8.3 (FIX 1) — ROTIREA CHATULUI (chat NOU, nu retry în același chat)
 *
 * Un model care a ecouat system prompt-ul rămâne blocat pe ecou dacă îl
 * re-întrebăm în ACELAȘI chat: istoricul conține deja mesajul userului
 * (promptul de sistem) + propriul ecou, deci îl repetă (log real: același
 * răspuns de 164 de caractere). Rotirea închide conversația poluată și
 * pornește una goală, unde promptul original are șanse să fie executat.
 * ========================================================================= */

/**
 * v2.8.3 (FIX 1): chat NOU în browser (închide conversația curentă) și așteaptă
 * composerul. Întoarce URL-ul noului chat. Best-effort pe repararea butonului
 * (vezi `newChatVia`); dacă tot rămânem pe aceeași conversație, navigăm direct
 * la pagina de start a providerului (chat nou garantat).
 */
export async function rotateChatVia(
  page: Page,
  providerId: string,
  label: string
): Promise<string> {
  const before = page.url();
  await newChatVia(page, providerId, label);
  // butonul poate exista fără să fi produs un chat nou (SPA lenes) — dacă URL-ul
  // e neschimbat și nu suntem deja pe pagina de start, forțăm navigarea
  const stillSameChat =
    !isProviderRootUrl(page.url(), providerId) &&
    normalizeNavUrl(page.url()) === normalizeNavUrl(before);
  if (stillSameChat) {
    log(label + ': rotate — still on the same conversation, navigating to a fresh chat');
    await page.goto(selectors.url(providerId), { waitUntil: 'domcontentloaded' });
    await autoAcceptPopups(page, { log }).catch(() => []);
    if (isLoginUrl(page.url())) {
      notifyNotReady(providerId, 'login page?');
      throw loginError(providerId, page.url());
    }
    await findInput(page, providerId, label, 30000);
  }
  log(label + ': rotate — fresh chat ready at ' + page.url());
  return page.url();
}

/* =========================================================================
 * v2.8.3 (FIX 2/3) — CÂT DE POLLUAT E CHATUL DIN BROWSER
 *
 * La primul mesaj după restartul VS Code reluăm conversația din browser
 * salvată în globalState. Dacă acolo a rămas un ecou al system prompt-ului
 * („Before executing, generate a numbered plan…"), acela e și contextul cu
 * care modelul ar răspunde din nou — deci chatul trebuie rotit ÎNAINTE de
 * trimitere. Numărătoarea user/asistent e doar diagnostic (log FIX 3).
 * ========================================================================= */

/** Mesajele utilizatorului din chatul web (ChatGPT, Claude, DeepSeek…). */
export const USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '[data-testid="user-message"]',
  '[data-testid^="user-turn"]',
  '[data-testid^="human-turn"]',
  '[data-testid^="user-message"]'
];

/** Rezumatul citit din DOM al chatului web activ. */
export interface BrowserChatHistory {
  userMessages: number;
  assistantMessages: number;
  /** Textul ultimului răspuns al asistentului ('' dacă nu există). */
  lastAssistantText: string;
}

/** Rulează în pagină: numără mesajele user/asistent (fără dubluri). */
const scanChatHistory = (args: {
  userSels: string[];
  assistantSels: string[];
}): BrowserChatHistory => {
  const collect = (sels: string[]): Element[] => {
    const seen = new Set<Element>();
    const out: Element[] = [];
    for (const sel of sels) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      nodes.forEach((n) => {
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      });
    }
    return out;
  };
  const users = collect(args.userSels);
  const assistants = collect(args.assistantSels);
  const lastAssistantText = assistants.length
    ? ((assistants[assistants.length - 1] as HTMLElement).innerText || '').trim()
    : '';
  return {
    userMessages: users.length,
    assistantMessages: assistants.length,
    lastAssistantText
  };
};

/** Selectorii de răspuns ai providerului + variantele generice. */
function assistantMessageSelectors(providerId: string): string[] {
  const sels = ['[data-message-author-role="assistant"]'];
  try {
    for (const sel of selectors.candidates(providerId, 'response')) {
      if (!sels.includes(sel)) sels.push(sel);
    }
  } catch {
    /* provider fără slot `response` configurat */
  }
  return sels;
}

/**
 * v2.8.3 (FIX 3): ce conține chatul web activ — pentru logul de diagnostic și
 * pentru detectarea chatului poluat. Fail-open: 0/0 pe orice eroare de DOM.
 */
export async function readBrowserChatHistory(
  page: Page,
  providerId: string
): Promise<BrowserChatHistory> {
  const empty: BrowserChatHistory = {
    userMessages: 0,
    assistantMessages: 0,
    lastAssistantText: ''
  };
  try {
    return await page.evaluate<
      BrowserChatHistory,
      { userSels: string[]; assistantSels: string[] }
    >(scanChatHistory, {
      userSels: USER_MESSAGE_SELECTORS,
      assistantSels: assistantMessageSelectors(providerId)
    });
  } catch (e: any) {
    log('reading the browser chat history failed: ' + (e?.message ?? String(e)));
    return empty;
  }
}

/** Apasă butonul de Stop al site-ului (best-effort, folosit la anulare). */
export async function clickStop(page: Page, providerId: string): Promise<boolean> {
  for (const sel of selectors.candidates(providerId, 'stopButton')) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) === 0 || !(await btn.isVisible())) continue;
      await humanClickButton(page, btn, 1500);
      selectors.note(providerId, 'stopButton', sel);
      log('stop pressed via ' + sel);
      return true;
    } catch {
      /* încearcă următorul */
    }
  }
  return false;
}

/* =========================================================================
 * v2.5.14 (bug #39) — COMPOSERUL: DRAFTURI RĂMASE + VERIFICARE ÎNAINTE DE ENTER
 * Pe ChatGPT un `insertText('\n')` izolat echivalează cu Enter: mesajul pleacă
 * trunchiat la primul newline, iar restul rămâne DRAFT în composer și se
 * lipește la mesajul următor (context poluat — dovedit live). Aici: golim
 * orice draft înainte de tastare și verificăm că în composer e exact mesajul
 * intenționat înainte de Enter (altfel îl relipim dintr-o bucată).
 * ========================================================================= */

/**
 * v2.8.6 (FIX 5): composerul ChatGPT, în ordinea din spec — id-ul propriu are
 * prioritate, apoi `data-testid`-ul. `div[contenteditable="true"]` prinde uneori
 * ALT element din pagină (alt editor), deci e doar rezervă (ULTIMUL div editabil
 * din document — vezi `composerLocator`).
 */
const CHATGPT_COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]'
];

/** v2.8.6 (FIX 5): rezerva pentru composerul ChatGPT (ultimul div editabil). */
const CHATGPT_COMPOSER_FALLBACK = 'div[contenteditable="true"]';

/**
 * v2.8.6 (FIX 5): elementul din care se CITEȘTE composerul. La ChatGPT întoarce
 * `#prompt-textarea` (id propriu); dacă nu există, ULTIMUL `div[contenteditable=
 * "true"]` din pagină (composerul stă jos — primul element găsit putea fi un alt
 * editor, iar lungimea citită din el nu avea legătură cu mesajul). La restul
 * providerilor întoarce locatorul primit.
 */
export async function composerLocator(
  page: Page,
  providerId: string,
  input: Locator
): Promise<Locator> {
  if (providerId !== 'chatgpt') return input;
  for (const sel of CHATGPT_COMPOSER_SELECTORS) {
    const cand = page.locator(sel).first();
    try {
      if ((await cand.count()) > 0) return cand;
    } catch {
      /* selector respins pe acest DOM — trecem la următorul */
    }
  }
  try {
    const editables = page.locator(CHATGPT_COMPOSER_FALLBACK);
    const count = await editables.count();
    if (count > 0) return editables.nth(count - 1);
  } catch {
    /* păstrăm locatorul primit */
  }
  return input;
}

/**
 * Textul curent din composer (innerText pentru contenteditable, value pentru
 * input/textarea).
 * v2.8.6 (FIX 5): cu `page` + `providerId`, textul se citește din composerul
 * corect al providerului (ChatGPT: `#prompt-textarea`) — vezi `composerLocator`.
 */
export async function readComposerText(
  input: Locator,
  opts?: { page?: Page; providerId?: string }
): Promise<string | null> {
  try {
    const target =
      opts?.page && opts.providerId
        ? await composerLocator(opts.page, opts.providerId, input)
        : input;
    return await target.evaluate((el) => {
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        return String((el as HTMLTextAreaElement).value || '');
      }
      return String((el as HTMLElement).innerText || '');
    });
  } catch (e: any) {
    log('readComposerText failed: ' + (e?.message ?? String(e)));
    return null;
  }
}

/** Comparație tolerantă la whitespace (DOM-ul normalizează newline-urile). */
export const composerTextMatches = (actual: string, expected: string): boolean =>
  normalize(actual) === normalize(expected);

/** v2.8.6.1 (FIX 3): câte încercări de golire (prima + 2 retry-uri, cum cere spec-ul). */
const COMPOSER_CLEAR_ATTEMPTS = 3;

/**
 * v2.8.6.1 (FIX 1): selectează TOT textul din composer prin JS. Ctrl+A + Backspace
 * NU e fiabil în ProseMirror (composerul ChatGPT e `div[contenteditable]`, iar un
 * draft de ~18k caractere rămânea în căsuță după „golire") — un Range peste
 * conținutul elementului e metoda sigură; `document.execCommand('selectAll')`
 * rămâne rezerva (retry). La input/textarea selecția se face nativ (`select()`).
 */
async function selectAllInComposer(target: Locator, viaExecCommand = false): Promise<boolean> {
  try {
    return await target.evaluate((el, useCommand) => {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const field = el as HTMLTextAreaElement;
        field.focus();
        field.select();
        return true;
      }
      const node = el as HTMLElement;
      node.focus();
      const sel = window.getSelection();
      if (!sel) return false;
      if (useCommand) return document.execCommand('selectAll', false, undefined);
      const range = document.createRange();
      range.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.rangeCount > 0 && !sel.isCollapsed;
    }, viaExecCommand);
  } catch (e: any) {
    log('selectAllInComposer failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

/**
 * v2.8.6.1 (FIX 3): lungimea conținutului composerului (`textContent` pentru
 * contenteditable, `value` pentru input/textarea) — `0` = căsuța chiar e goală.
 */
async function composerContentLength(target: Locator): Promise<number | null> {
  try {
    return await target.evaluate((el) => {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        return String((el as HTMLTextAreaElement).value || '').length;
      }
      return String((el as HTMLElement).textContent || '').length;
    });
  } catch (e: any) {
    log('composerContentLength failed: ' + (e?.message ?? String(e)));
    return null;
  }
}

/**
 * Golește composerul (best-effort) — un draft rămas nu are voie să plece.
 *
 * v2.8.6.1 (FIX 1): Ctrl+A + Backspace NU e fiabil în ProseMirror (composerul
 * ChatGPT e `div[contenteditable]`) — draftul de 18.556 de caractere rămânea în
 * căsuță, iar paste-ul de peste el „reușea" (vechea verificare doar limita de
 * jos). Acum: click pe composer, select all prin JS (Range peste conținut) +
 * Delete, iar la nevoie retry cu `ControlOrMeta+A` + Delete și apoi cu
 * `execCommand('selectAll')` + Delete.
 * v2.8.6.1 (FIX 3): după golire se verifică `textContent().length === 0` — log
 * `[human] composer cleared: 0 chars`, altfel warning + retry (max. 2).
 */
export async function clearComposer(
  page: Page,
  input: Locator,
  label: string,
  providerId?: string
): Promise<void> {
  try {
    const target =
      page && providerId ? await composerLocator(page, providerId, input) : input;
    const current = await readComposerText(input, { page, providerId });
    if (current === null) return; // nu putem citi → nu riscăm un Ctrl+A orb
    if (!current.trim()) return; // nimic de curățat
    log(label + ': clearing the leftover draft from the composer (' + current.length + ' chars)');
    let left: number | null = null;
    for (let attempt = 1; attempt <= COMPOSER_CLEAR_ATTEMPTS; attempt++) {
      await humanClickButton(page, target, 5000);
      if (attempt === 1) {
        await selectAllInComposer(target);
      } else if (attempt === 2) {
        await page.keyboard.press('ControlOrMeta+A');
      } else {
        await selectAllInComposer(target, true);
      }
      await page.keyboard.press('Delete');
      await sleep(150);
      left = await composerContentLength(target);
      if (left === 0) break;
      logLine(
        'human',
        'composer still has ' + (left === null ? 'unreadable' : left + ' chars') +
          ' after clear attempt ' + attempt + '/' + COMPOSER_CLEAR_ATTEMPTS + ' — retrying'
      );
    }
    if (left === 0) {
      logLine('human', 'composer cleared: 0 chars');
    } else {
      logLine(
        'human',
        'WARNING: composer NOT cleared after ' + COMPOSER_CLEAR_ATTEMPTS + ' tries (' +
          (left === null ? 'unreadable' : left + ' chars') + ' left)'
      );
    }
  } catch (e: any) {
    log(label + ': composer clear failed — ' + (e?.message ?? String(e)));
  }
}

/**
 * v2.8.6 (FIX 1): câte caractere are composerul ACUM (`null` = nu a putut fi
 * citit). Folosit la verificarea „chat NOU, composer gol" dinainte de a trimite
 * system prompt-ul: sub 50 de caractere căsuța e goală (placeholder-ul nu
 * contează).
 */
export async function composerCharCount(
  page: Page,
  providerId: string,
  label: string
): Promise<number | null> {
  try {
    const input = await findInput(page, providerId, label, 15000);
    const text = await readComposerText(input, { page, providerId });
    return text === null ? null : text.length;
  } catch (e: any) {
    log(
      label + ': composer not readable for the empty-chat check — ' +
        (e?.message ?? String(e))
    );
    return null;
  }
}

/** v2.8.6 (FIX 1): golește un draft rămas în composerul unui chat nou (best-effort). */
export async function clearComposerDraft(
  page: Page,
  providerId: string,
  label: string
): Promise<void> {
  try {
    const input = await findInput(page, providerId, label, 15000);
    await clearComposer(page, input, label, providerId);
  } catch (e: any) {
    log(
      label + ': could not clear the leftover composer draft — ' +
        (e?.message ?? String(e))
    );
  }
}

/**
 * v2.5.45 (bug #102): providerii la care composerul a trunchiat un mesaj în
 * sesiunea curentă — inputul lor rămâne „suspect" (se vede în log la
 * următoarea folosire), iar AI finder-ul e chemat SPECIFIC pe el, imediat.
 */
const suspectInput = new Set<string>();

/** true dacă în sesiunea curentă composerul a trunchiat un mesaj la providerul dat. */
export function isInputSuspect(providerId: string): boolean {
  return suspectInput.has(providerId);
}

/**
 * v2.5.45 (bug #102): cere AI finder-ului un input nou pentru sesiunea curentă
 * (fără să așteptăm ca alt slot să cadă) și întoarce selectorul găsit, dacă a
 * fost validat în pagină. Implementarea stă în ai-selector-finder.ts și vine
 * prin hook (importul direct ar închide un ciclu de module).
 */
async function repairInput(
  page: Page,
  providerId: string,
  label: string
): Promise<string | null> {
  const repair = inputRepair();
  if (!repair) return null;
  try {
    const r = await repair(page, providerId);
    if (r.selector) {
      log(label + ': input repaired by the AI finder -> ' + r.selector);
      return r.selector;
    }
    log(label + ': input repair found nothing — ' + r.reason);
    // v2.5.61 (FIX 6): reparația selectorilor e complet automată — nu arătăm
    // niciun card pe drum. Dacă mesajul tot nu poate fi trimis, tier-ul 7 ridică
    // un singur card minimal (SelectorsBrokenError), cu Retry / Switch provider.
    if (r.gaveUp) {
      logLine('selectors', 'input repair gave up for ' + providerId + ' — tier 7 will report');
    }
    return null;
  } catch (e: any) {
    log(label + ': input repair failed — ' + (e?.message ?? String(e)));
    return null;
  }
}

/**
 * Verifică înainte de Enter că în composer e exact `message`; la nepotrivire
 * (mesaj trunchiat, paste pierdut) golește și relipește mesajul dintr-o bucată.
 *
 * v2.5.45 (bug #102): dacă nici după relipire composerul nu conține mesajul
 * întreg, inputul e marcat „suspect" pentru sesiunea curentă și AI finder-ul
 * caută IMEDIAT un altul (doar pe input — nu așteptăm ca alt slot să cadă), ca
 * mesajul să poată fi retrimis în căsuța corectă. Întoarce locatorul în care se
 * află mesajul (cel primit sau cel reparat).
 */
export async function ensureComposerHasMessage(
  page: Page,
  providerId: string,
  input: Locator,
  message: string,
  label: string,
  onNotice?: (text: string) => void
): Promise<Locator> {
  const actual = await readComposerText(input, { page, providerId });
  if (actual === null) return input; // nu putem verifica — mergem ca înainte
  if (composerTextMatches(actual, message)) {
    suspectInput.delete(providerId); // scrie corect → inputul nu mai e suspect
    return input;
  }

  log(
    label + ': composer mismatch — ' + actual.length + '/' + message.length +
      ' chars in the box, re-pasting the whole message'
  );
  onNotice?.(
    '⚠️ The chat composer did not contain the full message (truncated or a leftover draft) — ' +
      'the whole message was re-pasted before sending.'
  );
  await clearComposer(page, input, label, providerId);
  await page.keyboard.insertText(message);
  await sleep(200);
  const after = await readComposerText(input, { page, providerId });
  if (after !== null && composerTextMatches(after, message)) {
    log(label + ': composer verified after re-paste');
    return input;
  }

  log(
    label + ': composer STILL mismatched after re-paste (' +
      (after === null ? 'unreadable' : after.length + '/' + message.length) + ')'
  );
  suspectInput.add(providerId);
  const repaired = await repairInput(page, providerId, label);
  if (!repaired) return input;

  const replacement = page.locator(repaired).first();
  try {
    await humanClickButton(page, replacement, 15000);
    await clearComposer(page, replacement, label, providerId);
    await page.keyboard.insertText(message);
    await sleep(200);
    const retry = await readComposerText(replacement, { page, providerId });
    if (retry !== null && !composerTextMatches(retry, message)) {
      log(label + ': composer STILL mismatched with the repaired input — sending what is in the box');
    } else {
      log(label + ': composer verified with the repaired input (' + repaired + ')');
    }
    return replacement;
  } catch (e: any) {
    log(label + ': using the repaired input failed — ' + (e?.message ?? String(e)));
    return input;
  }
}

/* =========================================================================
 * v2.8.5 — FAST PASTE VERIFICAT (LUNGIME) + SPLIT ÎN CHUNK-URI
 * Un paste „instant" de peste ~6k caractere e trunchiat de composer (dovedit
 * live pe ChatGPT: 10.234 de caractere trimise → 5.847 în căsuță). Verificarea
 * de dinainte de Enter relipea TOT mesajul dintr-o bucată — la fel de trunchiat —
 * iar promptul incomplet pleca mai departe (modelul răspundea la fragmente, cu
 * ecou în loc de tool call). Aici: după fiecare paste verificăm LUNGIMEA,
 * reîncercăm o dată, iar dacă tot nu încape împărțim mesajul în chunk-uri de
 * ~3000 de caractere, lipite pe rând în ACEEAȘI căsuță (fără Enter), apoi
 * trimitem o singură dată.
 * v2.8.6.1 (FIX 2): verificarea are AMBELE limite — un composer mai LUNG decât
 * mesajul (draft vechi rămas sub paste) nu mai trece ca „ok"; e golit și
 * relipit (înainte era verificată doar limita de jos, deci 19.109 caractere
 * „confirmau" un mesaj de 37).
 * ========================================================================= */

/** v2.8.5: sub această diferență (caractere) mesajul din composer e „întreg". */
const FAST_PASTE_TOLERANCE = 50;

/**
 * v2.8.6.1 (FIX 2): peste această diferență (caractere) composerul are
 * LEFT-OVER — un draft vechi rămas sub mesaj (lungimea „prea mare" nu mai e
 * acceptată ca „mesajul e întreg").
 */
const FAST_PASTE_LEFTOVER_TOLERANCE = 300;

/** v2.8.5: câte caractere se lipesc într-un chunk când composerul trunchiază. */
const FAST_PASTE_CHUNK_SIZE = 3000;

/** v2.8.5: câte lipiri dintr-o bucată încercăm înainte de a împărți mesajul. */
const FAST_PASTE_ATTEMPTS = 2;

/**
 * v2.8.5: împarte textul în bucăți de cel mult `size` caractere, preferând
 * sfârșitul de cuvânt (tăierea pe spațiu). `chunks.join('') === text` exact.
 */
export function splitIntoChunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size; // fără spațiu util → tăiem fix la `size`
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * v2.8.5: lipește `text` în căsuța dată, verifică LUNGIMEA din composer și —
 * dacă site-ul trunchiază — reîncearcă o dată, apoi împarte mesajul în chunk-uri.
 *
 * Întoarce true când mesajul a ajuns (verificat pe lungime) sau când composerul
 * nu poate fi citit (atunci rămâne lipirea simplă, ca înainte); false când nici
 * chunk-urile nu au încăput — apelantul lasă mai departe verificarea/relipirea
 * din `ensureComposerHasMessage`.
 *
 * v2.8.6.1 (FIX 2): verificarea are AMBELE limite — un composer mai LUNG decât
 * mesajul (draft vechi sub paste) e tratat ca eșec („composer has leftover") și
 * golit, nu ca „ok".
 */
export async function fastPasteVerified(
  page: Page,
  input: Locator,
  text: string,
  label: string,
  providerId?: string
): Promise<boolean> {
  const expected = text.length;
  const read = () => readComposerText(input, { page, providerId });
  const withinBounds = (actual: string | null, len: number): boolean =>
    actual !== null &&
    actual.length >= len - FAST_PASTE_TOLERANCE &&
    actual.length <= len + FAST_PASTE_LEFTOVER_TOLERANCE;
  const verified = (actual: string | null): boolean => withinBounds(actual, expected);

  for (let attempt = 1; attempt <= FAST_PASTE_ATTEMPTS; attempt++) {
    await page.keyboard.insertText(text);
    await sleep(400);
    const actual = await read();
    if (actual === null) {
      logLine('human', 'composer unreadable — keeping the single paste (cannot verify)');
      return true;
    }
    if (verified(actual)) {
      logLine(
        'human',
        'paste attempt ' + attempt + ': ' + expected + ' chars → composer has ' +
          actual.length + ' — ok'
      );
      return true;
    }
    // v2.8.6.1 (FIX 2): composerul mai LUNG decât mesajul = draft vechi sub paste
    const leftover = actual.length > expected + FAST_PASTE_LEFTOVER_TOLERANCE;
    if (leftover) {
      logLine(
        'human',
        'composer has leftover (' + actual.length + ' chars, expected ' + expected +
          ') — clearing again'
      );
    } else {
      logLine(
        'human',
        'paste attempt ' + attempt + ': ' + expected + ' chars → composer has ' + actual.length
      );
    }
    if (attempt === FAST_PASTE_ATTEMPTS) break;
    if (!leftover) {
      logLine('human', 'paste truncated — clearing and re-pasting the whole message');
    }
    await clearComposer(page, input, label, providerId);
  }

  const chunks = splitIntoChunks(text, FAST_PASTE_CHUNK_SIZE);
  logLine('human', 'paste truncated — splitting into ' + chunks.length + ' chunks');
  await clearComposer(page, input, label, providerId);

  let done = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Cursorul trebuie să fie la FINALUL textului, altfel chunk-ul următor intră
    // la mijloc (după un paste, caretul nu rămâne garantat la capăt).
    if (i > 0) await page.keyboard.press('ControlOrMeta+End').catch(() => {});
    await page.keyboard.insertText(chunk);
    await sleep(250);
    done += chunk.length;
    let actual = await read();
    let ok = withinBounds(actual, done);
    // v2.8.6.1 (FIX 2): retry doar când LIPSEȘTE text (chunk pierdut) — un
    // composer prea LUNG are draft vechi sub mesaj, nu un chunk pierdut
    // (reîncercarea ar adăuga chunk-ul de două ori).
    if (!ok && (actual === null || actual.length < done - FAST_PASTE_TOLERANCE)) {
      // un chunk pierdut (focus/caret) — o singură reîncercare, apoi mergem mai departe
      await page.keyboard.press('ControlOrMeta+End').catch(() => {});
      await page.keyboard.insertText(chunk);
      await sleep(250);
      actual = await read();
      ok = withinBounds(actual, done);
    }
    logLine(
      'human',
      'chunk ' + (i + 1) + '/' + chunks.length + ': ' + chunk.length + ' chars → ' +
        (ok ? 'ok' : 'composer has ' + (actual === null ? 'unreadable' : actual.length))
    );
    if (!ok && actual !== null && actual.length > done + FAST_PASTE_LEFTOVER_TOLERANCE) {
      // v2.8.6.1 (FIX 2): draft vechi sub chunk-uri — nu mai adăugăm bucăți peste el
      logLine(
        'human',
        'composer has leftover (' + actual.length + ' chars, expected ' + done +
          ') — stopping the chunk split'
      );
      break;
    }
  }

  const final = await read();
  if (verified(final)) {
    logLine('human', 'composer verified: ' + final!.length + ' chars');
    return true;
  }
  logLine(
    'human',
    'composer STILL ' +
      (final !== null && final.length > expected + FAST_PASTE_LEFTOVER_TOLERANCE
        ? 'has leftover'
        : 'truncated') +
      ' after ' + chunks.length + ' chunks (' +
      (final === null ? 'unreadable' : final.length + '/' + expected) + ')'
  );
  return false;
}

/**
 * Trimitere generică: scrie în input (v0.8.0: tastare "umană" caracter-cu-caracter
 * pe mesaje scurte, insertText pe cele lungi — nu `type`, altfel \n devine Enter),
 * apasă Enter, apoi așteaptă ca ultimul răspuns să se stabilizeze (~2s neschimbat).
 * v0.8.0: finalul generării e detectat instant prin MutationObserver.
 */
export interface SendConfig extends SendOptions {
  providerId: string;
  label: string;
  signal?: AbortSignal;
  /** v1.7.1: callback pentru thinking-ul modelului (extras din pagină, best-effort). */
  onThinking?: (text: string) => void;
}

/* =========================================================================
 * v1.7.1 — THINKING / REASONING (transparență)
 * Modelele „thinking" afișează raționamentul într-un bloc separat de răspuns
 * (DeepSeek-R1, Claude extended thinking, Gemini, Qwen, Kimi, …). Extragem
 * textul după ce răspunsul s-a stabilizat și îl raportăm prin `cfg.onThinking`
 * — chatView îl afișează ca pasul „Thinking" (doar cu Verbose mode activ).
 * Extragerea e best-effort: fără bloc găsit, nu se întâmplă nimic.
 * ========================================================================= */

/** Selectori per provider pentru blocul de raționament (best-effort). */
const THINKING_SELECTORS: Record<string, string[]> = {
  deepseek: ['div.ds-think-content', '.ds-markdown--think'],
  claude: ['div[class*="thinking"]', '[data-testid*="thinking"]'],
  gemini: ['div[class*="thought"]', '[class*="thinking"]'],
  qwen: ['div[class*="think"]'],
  chatgpt: ['div[class*="think"]', '[class*="reasoning"]'],
  mistral: ['div[class*="think"]']
};

/** Selectori generici, încercați după cei specifici providerului. */
const GENERIC_THINKING_SELECTORS = ['[class*="think"]', '[class*="reason"]'];

/**
 * v2.5.60: rulează ÎN PAGINĂ (serializat — fără closure-uri!) — providerul dă
 * semne de viață ACUM?
 *   1) butonul de Stop (`selectors.json` → `stopButton`) — apare doar cât timp
 *      providerul generează; e semnalul principal, deci e verificat primul;
 *   2) text de stare vizibil: /thinking|generating|reasoning|stop generating/i;
 *   3) (în buclă) schimbarea de URL.
 * Elementele ascunse (getClientRects gol / visibility:hidden) sunt ignorate.
 */
export const scanProviderWorking = (args: {
  thinkingSels: string[];
  stopSels: string[];
}): boolean => {
  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (!he.getClientRects().length) return false;
    const st = window.getComputedStyle(he);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const visibleAny = (sels: string[]): boolean => {
    for (const sel of sels) {
      let els: Element[] = [];
      try {
        els = Array.prototype.slice.call(document.querySelectorAll(sel));
      } catch {
        continue;
      }
      for (const el of els) {
        if (isVisible(el)) return true;
      }
    }
    return false;
  };

  // 1) butonul de Stop — apare doar cât timp providerul generează
  if (visibleAny(args.stopSels)) return true;

  // 2) text de stare („Thinking…", „Generating…", „Stop generating")
  const re = /thinking|generating|reasoning|stop generating/i;
  for (const sel of args.thinkingSels) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      if (!isVisible(el)) continue;
      if (re.test(String((el as HTMLElement).innerText || ''))) return true;
    }
  }
  const body = document.body as HTMLElement | null;
  return !!body && re.test(String(body.innerText || ''));
};

/**
 * v2.5.60: „lucrează acum?" — un singur scan în pagină, cu timeout de
 * siguranță (o pagină înghețată nu are voie să blocheze verificarea).
 */
async function providerWorking(page: Page, providerId: string): Promise<boolean> {
  try {
    const probe = page
      .evaluate<boolean, { thinkingSels: string[]; stopSels: string[] }>(
        scanProviderWorking,
        {
          thinkingSels: [
            ...(THINKING_SELECTORS[providerId] || []),
            ...GENERIC_THINKING_SELECTORS
          ],
          stopSels: selectors.candidates(providerId, 'stopButton')
        }
      )
      .catch(() => false);
    return (await Promise.race([probe, sleep(4000).then(() => false)])) === true;
  } catch (e: any) {
    log('activity probe failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

/**
 * Rulează ÎN PAGINĂ: întoarce textul ultimului bloc de raționament vizibil
 * (ultimul din DOM = răspunsul cel mai recent). Filtrează butoane/inputuri și
 * blocurile prea scurte sau prea lungi.
 */
const scanThinkingText = (sels: string[]): string | null => {
  let best: string | null = null;
  for (const sel of sels) {
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'INPUT') continue;
      if (el.closest('button')) continue;
      if ((el as HTMLElement).isContentEditable) continue;
      const t = String(el.textContent || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (t.length < 20 || t.length > 20000) continue;
      best = t; // ultimul din DOM câștigă
    }
  }
  return best;
};

/** Extrage thinking-ul din pagină (best-effort; ecoul mesajului e respins). */
async function extractThinking(
  page: Page,
  providerId: string,
  message: string
): Promise<string> {
  try {
    const sels = [
      ...(THINKING_SELECTORS[providerId] || []),
      ...GENERIC_THINKING_SELECTORS
    ];
    const text = await page.evaluate<string | null, string[]>(
      scanThinkingText,
      sels
    );
    if (!text || isEchoOf(text, message)) return '';
    return text;
  } catch (e: any) {
    log('extractThinking failed: ' + (e?.message ?? String(e)));
    return '';
  }
}

/** Raportează thinking-ul către chatView (nu blochează niciodată trimiterea). */
async function emitThinking(
  page: Page,
  providerId: string,
  message: string,
  cfg: SendConfig,
  label: string
): Promise<void> {
  if (!cfg.onThinking) return;
  try {
    const text = await extractThinking(page, providerId, message);
    if (text) {
      log(label + ': thinking extras (' + text.length + ' chars)');
      cfg.onThinking(text);
    }
  } catch (e: any) {
    log(label + ': thinking emit failed — ' + (e?.message ?? String(e)));
  }
}

/* =========================================================================
 * v2.5.20 (bug #44/#58) — „RĂSPUNSUL NU E ÎNCĂ RANDAT" ≠ „SELECTOR STRICAT"
 * La 4s după Enter bila AI nu există încă în DOM (site-urile o randează în
 * 2–10s) → `anySelectorMatches` = false, dar asta NU înseamnă „selector
 * stricat": healer-ul pleca pe „no candidate" și chema AI finder-ul pe un
 * snapshot FĂRĂ răspuns (45–120s arși pe un slot care funcționa perfect;
 * răspunsul real apărea la 6s și era citit abia după ce finder-ul renunța).
 * Repararea slotului `response` pornește abia de la checkpoint-ul de 20s (se
 * reia la 40s). Verificarea erorilor de pagină (rate limit / memory full /
 * CAPTCHA) rămâne la toate checkpoint-urile, inclusiv 4s și 9s.
 * ========================================================================= */

/** v2.5.20 (bug #44/#58): sub acest prag `response` NU se repară. */
const RESPONSE_HEAL_MIN_MS = 20_000;

export async function sendAndWait(
  page: Page,
  message: string,
  cfg: SendConfig
): Promise<string> {
  const { providerId, label, signal } = cfg;

  /**
   * v2.5.46 FIX (bug #105): citirea răspunsului trece printr-un singur loc, ca
   * să raportăm și câte caractere de „thinking" au fost ignorate. Blocurile de
   * raționament NU sunt răspuns: la testul Qwen (17:06) selectorul prinsese
   * întâi blocul de thinking, se citeau 93 de caractere („Thinking completed")
   * și tool call-ul trimis corect de model se pierdea. Logăm doar când rezultatul
   * se schimbă relevant (a apărut text SAU s-au ignorat alte caractere), ca să nu
   * umplem Output-ul la fiecare pas de polling.
   */
  let lastIgnoredChars = -1;
  let lastHadText = false;
  let lastWasDeduplicated = false;
  let lastFilteredParagraphs = 0;
  const readResponse = async (sels: string[], fallback = false): Promise<string> => {
    const read = await getLastResponseRead(page, sels, fallback);
    const hasText = read.text.length > 0;
    if (read.ignored !== lastIgnoredChars || hasText !== lastHadText) {
      lastIgnoredChars = read.ignored;
      lastHadText = hasText;
      log(
        label +
          ': [read] response: ' +
          read.text.length +
          ' chars (thinking: ' +
          read.ignored +
          ' chars ignored)'
      );
    }
    if (read.deduplicated && !lastWasDeduplicated) {
      logLine('read', 'deduplicated thinking from response');
    }
    lastWasDeduplicated = Boolean(read.deduplicated);
    // v2.5.66 (FIX 4): paragrafele de „thinking" rămase în elementul de răspuns
    // (același slot ca răspunsul) sunt scoase în selectors.ts — logăm câte au
    // fost, o singură dată per schimbare, ca să nu umplem Output-ul la polling.
    const filteredParagraphs = read.filtered ?? 0;
    if (filteredParagraphs > 0 && filteredParagraphs !== lastFilteredParagraphs) {
      logLine('read', 'filtered ' + filteredParagraphs + ' thinking paragraphs');
    }
    lastFilteredParagraphs = filteredParagraphs;
    return read.text;
  };

  // v2.0.5: NU mai aducem tab-ul/fereastra în prim-plan la fiecare mesaj — asta
  // făcea fereastra Chrome să sară peste VS Code. Randarea rămâne activă în
  // fundal prin flag-urile de lansare + override-ul de vizibilitate (browser.ts).
  // Aducerea în față rămâne doar pentru login/CAPTCHA (BrowserManager.show()).

  // v1.8.0: închide popup-urile de consimțământ care ar putea bloca căsuța de input
  const popupsClosed = await autoAcceptPopups(page, { log }).catch(() => []);
  if (popupsClosed.length) {
    cfg.onNotice?.('🍪 Popup closed automatically: “' + popupsClosed.join('”, “') + '”.');
  }

  // FAZA II (A): fișierele (imagini/binare) se încarcă în chat ÎNAINTE de text
  if (cfg.files && cfg.files.length) {
    const ok = await uploadChatFiles(page, providerId, cfg.files, label);
    if (ok) {
      cfg.onNotice?.(
        '📎 ' + cfg.files.length + ' file(s) uploaded to the web chat.'
      );
    } else {
      cfg.onNotice?.(
        '⚠️ The attached files could not be uploaded to the web chat ' +
          '(the attach button was not found) — the AI only sees their description.'
      );
    }
  }

  let responseSelectors = selectors.candidates(providerId, 'response');
  let beforeText = await readResponse(responseSelectors);
  let beforeFallbackText = await readResponse(responseSelectors, true);
  // v2.5.12 FIX (bug #36): numărul de răspunsuri existente ÎNAINTE de trimitere —
  // sentinela pentru „a apărut un răspuns nou", independentă de conținutul lui.
  let beforeCount = await countAssistantResponses(page, responseSelectors);
  log(
    label + ': send() START, beforeLen=' + beforeText.length +
      ', beforeCount=' + beforeCount
  );

  // v2.5.43 (bug #100): linkul de upgrade/plans/pricing din pagină, citit o
  // singură dată per mesaj (memoizat) — întărește detecția „free plan" și dă
  // URL-ul real pentru cardul din chat.
  let upgradeLinkCache: string | undefined;
  const upgradeLink = async (): Promise<string | undefined> => {
    if (upgradeLinkCache === undefined) {
      upgradeLinkCache = (await readUpgradeLink(page)) ?? '';
    }
    return upgradeLinkCache || undefined;
  };

  // v0.8.0: setările de humanizare (citite o dată per mesaj)
  const human = humanSettings();

  /**
   * v2.5.15 (bug #41): compune mesajul în composer și îl trimite (Enter).
   * Extras ca să fie refolosit la continuarea într-un chat nou după „Chat
   * memory full" — comportamentul e identic cu blocul inline de dinainte.
   */
  const composeAndSend = async (text: string): Promise<Locator> => {
    const box = await findInput(page, providerId, label, 15000);
    await clickInput(page, box);

    // v2.5.14 (bug #39): un mesaj trunchiat de site lasă restul ca DRAFT în
    // composer; următoarea trimitere l-ar lipi la mesajul nou (context poluat —
    // dovedit live pe ChatGPT). Golim înainte de tastare.
    await clearComposer(page, box, label, providerId);

    // v0.8.0: tastare "umană" (evenimente reale de tastatură); v2.0.6: mesajele
    // lungi tastează natural doar începutul, restul se lipește — vezi humanType.
    // v2.5.48: providerii rapizi (DeepSeek/Gemini/Ollama) primesc paste
    // instant chiar și cu tastarea „umană" pornită — typing-ul caracter-cu-
    // caracter încetinea vizibil trimiterea; ChatGPT/Claude păstrează
    // tastarea umană (stealth).
    // v2.8.5: `fastPaste` e citit și după tastare (log „sending with Enter"),
    // deci îl calculăm înainte de try.
    const fastPaste =
      providerId === 'deepseek' ||
      providerId === 'gemini' ||
      providerId === 'ollama' ||
      providerId === 'chatgpt' ||
      providerId === 'claude' ||
      providerId === 'mistral' ||
      providerId === 'qwen';
    try {
      if (human.typing && !fastPaste) {
        await humanType(page, text, {}, signal);
      } else if (fastPaste) {
        logLine('human', 'fast paste for ' + providerId);
        // v2.8.5: paste-ul „instant" e verificat pe LUNGIME înainte de Enter —
        // composerul care trunchiază primește mesajul în chunk-uri, nu întreg
        // (altfel promptul incomplet pleca mai departe).
        await fastPasteVerified(page, box, text, label, providerId);
      } else {
        await page.keyboard.insertText(text);
      }
    } catch (e: any) {
      if ((e?.message ?? String(e)) === '__ABORTED__') {
        // nu lăsa text parțial în căsuța de input după anulare
        await clearInputBestEffort(page);
      }
      throw e;
    }
    await sleep(400);

    // v2.5.14 (bug #39): verificăm că în composer e EXACT mesajul, înainte de
    // Enter — altfel (trunchiere/draft/paste pierdut) îl relipim dintr-o bucată.
    // v2.5.45 (bug #102): întoarce căsuța în care se află mesajul — poate fi una
    // reparată de AI finder după un composer trunchiat (Enter merge în ea, iar
    // re-trimiterea de la 25s folosește același locator).
    const target = await ensureComposerHasMessage(
      page,
      providerId,
      box,
      text,
      label,
      cfg.onNotice
    );

    if (fastPaste) logLine('human', 'sending with Enter');
    await page.keyboard.press('Enter');
    return target;
  };

  let input = await findInput(page, providerId, label, 15000);
  // v2.5.12 (bug #35): ChatGPT fără cont păstrează composerul funcțional
  // (guest mode), deci findInput reușește și verificarea de login din el
  // (ramura „input lipsă") nu se execută. Întrebăm utilizatorul înainte de a
  // trimite — NU blocăm: „Continue as guest" merge exact ca înainte.
  if (cfg.onLoggedOut && (await detectLoggedOut(page, providerId))) {
    const decision = await cfg.onLoggedOut(providerId);
    if (decision !== 'continue') throw new Error('__ABORTED__');
  }
  /**
   * v2.5.60 — DETECȚIE ADAPTIVĂ („providerul lucrează sau e blocat?"):
   * `stuckIndex` = următorul checkpoint (15s/30s/60s/90s); `lastUrlSeen` = URL-ul
   * dinainte de Enter, actualizat la fiecare verificare (o schimbare între
   * verificări = chat/răspuns nou); `sawResponseText` = am citit deja text REAL
   * de răspuns (post-ecou). La 90s, fără niciunul dintre semnale → eroare clară.
   */
  let stuckIndex = 0;
  let lastUrlSeen = page.url();
  let sawResponseText = false;
  input = await composeAndSend(message);
  log(label + ': message sent, waiting for the response...');

  // v0.8.0: MutationObserver — "liniștea" din DOM încheie așteptarea instant;
  // cu setarea oprită rămâne polling-ul clasic la 500ms.
  let observerOk = human.observer ? await installMutationTracker(page) : false;
  const aborted = signal ? waitForAbort(signal) : undefined;

  let previousText = '';
  let lastChangeAt = Date.now();
  let healIndex = 0;
  let responseRepairPending = false;
  let responseRepairAttempted = false;
  const firstReplyInSession = beforeCount === 0 && !beforeFallbackText;
  let lastErrorCheckpoint = 0;
  let enterRetried = false;
  let lastStreamAt = 0;
  // v2.5.12 FIX (bug #36): true după ce am văzut un răspuns NOU (count crescut
  // sau text schimbat) — folosit de „rescue" ca să accepte și un răspuns identic.
  let sawNewResponse = false;
  // v2.5.35 (bug #86): bugetul de așteptare din setări, citit o dată per mesaj.
  // v2.5.60: `freekit.providerTimeout` (secunde, implicit 90) — iar detecția
  // adaptivă de mai jos oprește la 60s un provider fără niciun semn de viață.
  // v2.5.74 (FIX 5): bugetul efectiv = setarea utilizatorului, plafonată de
  // override-ul per provider (Qwen: 30s).
  const configuredTimeoutMs = providerTimeoutMs();
  const overrideMs = PROVIDER_TIMEOUT_OVERRIDE_MS[providerId];
  // v2.7 (FIX 2 — audit H1): un provider marcat „unhealthy" (mut la un mesaj
  // recent) nu mai consumă tot bugetul. `unhealthyAt` era scris de
  // `recordProviderNoResponse`, dar niciodată citit — promisiunea „mesajele
  // următoare nu-l mai așteaptă degeaba" nu exista în cod.
  const unhealthyMs = isProviderCurrentlyUnhealthy(providerId)
    ? UNHEALTHY_WAIT_MS
    : undefined;
  if (unhealthyMs && !unhealthyNoticesShown.has(providerId)) {
    unhealthyNoticesShown.add(providerId);
    log(
      label + ': marked unhealthy in the last ' +
        Math.round(UNHEALTHY_TTL_MS / 60_000) + ' min — capping the wait at ' +
        Math.round(UNHEALTHY_WAIT_MS / 1000) + 's'
    );
    cfg.onNotice?.(
      '⏱️ ' + label + ' was unresponsive recently — waiting at most ' +
        Math.round(UNHEALTHY_WAIT_MS / 1000) + 's before retrying.'
    );
  }
  const hardTimeoutMs = Math.min(
    configuredTimeoutMs,
    overrideMs ?? Number.POSITIVE_INFINITY,
    unhealthyMs ?? Number.POSITIVE_INFINITY,
    // v2.8.6 (FIX 2): „ack mode" (system prompt-ul din protocolul de prompt
    // împărțit) așteaptă mult mai puțin — vezi ramura de expirare din buclă
    cfg.ack ? ACK_WAIT_MS : Number.POSITIVE_INFINITY
  );
  // pragul de „provider blocat" nu poate depăși bugetul efectiv
  const stuckAbortMs = Math.min(STUCK_ABORT_MS, hardTimeoutMs);
  let started = Date.now();
  // v2.5.15 (bug #41): textul trimis efectiv în chat (poate include prefixul de
  // handoff după o continuare) — gardele de ecou se raportează la el.
  let sentText = message;
  let memoryFullRestarts = 0;

  /**
   * v2.5.15 (bug #41): „Chat memory full" — contextul chatului s-a epuizat și
   * providerul nu mai răspunde. Întreabă utilizatorul (cardul din chat); la
   * „continue" deschide un chat nou, retrimite mesajul curent cu prefixul de
   * handoff primit de la chatView și resetează sentinelele, ca bucla agentică
   * să continue acolo. La „cancel" aruncă eroarea tipizată (mesaj clar în chat).
   */
  const restartInNewChat = async (): Promise<void> => {
    memoryFullRestarts++;
    const decision =
      cfg.onMemoryFull && memoryFullRestarts <= MAX_MEMORY_FULL_RESTARTS
        ? await cfg.onMemoryFull(providerId)
        : ({ action: 'cancel' } as const);
    if (decision.action !== 'continue') {
      throw new DetectedProviderError(providerId, {
        kind: 'memory_full',
        message: 'Chat context limit reached.'
      });
    }
    const prefix = decision.prefix?.trim();
    log(label + ': chat memory full — starting a new chat and resending the pending message');
    cfg.onNotice?.(
      '🆕 ' + label + ' reached its context limit — continuing in a new chat.'
    );
    await newChatVia(page, providerId, label);
    sentText = prefix ? prefix + '\n\n' + message : message;
    // v2.5.60: baseline nou pentru detecția adaptivă (chat nou, buclă nouă)
    lastUrlSeen = page.url();
    stuckIndex = 0;
    sawResponseText = false;
    input = await composeAndSend(sentText);
    // chat nou → sentinelele repornesc (alt DOM, altă numărătoare de răspunsuri)
    beforeText = await readResponse(responseSelectors);
    beforeFallbackText = await readResponse(responseSelectors, true);
    beforeCount = await countAssistantResponses(page, responseSelectors);
    previousText = '';
    sawNewResponse = false;
    lastChangeAt = Date.now();
    enterRetried = false;
    healIndex = 0;
    lastErrorCheckpoint = 0;
    started = Date.now();
    if (human.observer) observerOk = await installMutationTracker(page);
    log(label + ': message sent in the new chat, waiting for the response...');
  };

  /**
   * v2.5.70 (FIX 3) — AUTO-RETRY după un timeout. Înainte de a arunca eroarea
   * (și de a arăta cardul Retry/Switch), o SINGURĂ dată îi cerem modelului un
   * răspuns mai scurt și așteptăm din nou bugetul întreg. Un chat rămas agățat
   * sau un model care „gândește" peste buget primește astfel o a doua șansă
   * fără intervenția utilizatorului. Întoarce `true` când am retrimis
   * (apelantul face `continue` în buclă), `false` când reîncercarea a fost deja
   * consumată.
   */
  let timeoutRetried = false;
  const autoRetryAfterTimeout = async (reason: string): Promise<boolean> => {
    if (timeoutRetried) return false;
    timeoutRetried = true;
    // v2.5.71 FIX 5: log-ul cerut de spec, în canalul chat.
    logLine('chat', 'timeout — auto-retry 1/1');
    log(
      label + ': ' + reason + ' — auto-retry 1/1 with a shorter-answer request'
    );
    // v2.5.74 (FIX 5): providerii cu plafon propriu (Qwen) primesc un prompt
    // SIMPLU, nu doar unul „mai scurt" — un model mut nu pornește deloc.
    const simple = overrideMs !== undefined;
    if (simple) {
      logLine(
        'chat',
        providerId + ': no response after ' +
          Math.round(hardTimeoutMs / 1000) + 's — retrying with simpler prompt'
      );
    }
    cfg.onNotice?.(
      '🔁 No response from ' + label + ' (' + reason +
        ') — retrying once: asking the model for a shorter answer.'
    );
    sentText = simple ? SIMPLE_RETRY_PROMPT : TIMEOUT_RETRY_PROMPT;
    // buclă nouă: sentinelele repornesc, ca răspunsul reîncercării să fie
    // detectat ca răspuns NOU și checkpoint-urile să pornească de la zero
    try {
      input = await composeAndSend(sentText);
    } catch (e: any) {
      if ((e?.message ?? String(e)) === '__ABORTED__') throw e;
      // nu am putut nici măcar retrimite (input dispărut, Enter blocat) →
      // lăsăm apelantul să raporteze timeout-ul original, nu o eroare nouă
      log(
        label + ': retry message could not be sent — ' +
          (e?.message ?? String(e))
      );
      return false;
    }
    beforeText = await readResponse(responseSelectors);
    beforeFallbackText = await readResponse(responseSelectors, true);
    beforeCount = await countAssistantResponses(page, responseSelectors);
    previousText = '';
    lastChangeAt = Date.now();
    sawNewResponse = false;
    sawResponseText = false;
    stuckIndex = 0;
    lastUrlSeen = page.url();
    healIndex = 0;
    lastErrorCheckpoint = 0;
    enterRetried = false;
    lastStreamAt = 0;
    started = Date.now();
    log(label + ': retry message sent, waiting for the response...');
    return true;
  };

  /**
   * v2.5.60: RESCUE — ultima șansă înainte de timeout/abort: extragere
   * generică (fallback) a ultimului răspuns; întoarce textul doar dacă arată
   * ca un răspuns real (nu ecou, suficient de lung, diferit de starea dinainte
   * de trimitere). Poate RELUA într-un chat nou (memory full) — de aceea
   * rezultatul e un marcaj, nu direct textul.
   */
  const rescueRead = async (): Promise<
    { kind: 'restart' } | { kind: 'reply'; text: string } | { kind: 'none' }
  > => {
    const rescuedRaw = await readResponse(
      selectors.candidates(providerId, 'response'),
      true
    );
    const rescued = stripEchoedUserMessage(rescuedRaw, sentText);
    if (rescued !== rescuedRaw) {
      log(label + ': stripped echoed user message from AI reply (rescue)');
    }
    if (
      !rescued ||
      rescued.length < 20 ||
      (!sawNewResponse && rescued === beforeText) ||
      isEchoOf(rescued, sentText)
    ) {
      return { kind: 'none' };
    }
    log(label + ': RESCUE generic, ' + rescued.length + ' chars');
    // v2.5.1: și textul de la „rescue” poate fi un mesaj de eroare al site-ului
    const detected = detectProviderError(
      rescued,
      providerId,
      await upgradeLink()
    );
    if (detected?.kind === 'memory_full') {
      await restartInNewChat();
      return { kind: 'restart' };
    }
    if (detected) throwProviderError(providerId, detected, page);
    // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
    await emitThinking(page, providerId, sentText, cfg, label);
    return { kind: 'reply', text: rescued };
  };

  for (;;) {
    // v2.5.15 (bug #41): bugetul de așteptare s-a consumat → RESCUE + scanul
    // final de erori. O continuare într-un chat nou (memory full) resetează
    // `started` și reia bucla.
    if (Date.now() - started >= hardTimeoutMs) {
      /**
       * v2.8.6 (FIX 2): în „ack mode" (msg 1 = system prompt-ul, dintr-un
       * prompt ÎMPĂRȚIT) expirarea NU e o eroare — ack-ul nu e răspunsul
       * task-ului. Întoarcem ce s-a citit (de obicei ecoul promptului, sau ''
       * dacă modelul tace) și apelantul trimite imediat task-ul (msg 2): fără
       * card de eroare, fără RESCUE, fără reîncercarea automată.
       */
      if (cfg.ack) {
        const partial = await readResponse(responseSelectors);
        log(
          label + ': ack wait expired (' + Math.round(ACK_WAIT_MS / 1000) + 's) — ' +
            (partial
              ? 'continuing with the task (partial reply: ' + partial.length + ' chars)'
              : 'sending the task (no reply)')
        );
        return stripEchoedUserMessage(partial, sentText);
      }
      // RESCUE: ultima șansă — extragere generică, ca să nu blocăm utilizatorul
      const rescued = await rescueRead();
      if (rescued.kind === 'restart') continue;
      if (rescued.kind === 'reply') return rescued.text;

      // v2.5.1: înainte de timeout-ul sec, verificăm dacă pagina afișează o eroare
      // cunoscută (banner care nu intră în selectorii de răspuns) — ex: limita de
      // mesaje gratuite la Claude/ChatGPT.
      const pageError = await detectProviderErrorOnPage(page, providerId, sentText);
      if (pageError?.kind === 'memory_full') {
        await restartInNewChat();
        continue;
      }
      if (pageError) throwProviderError(providerId, pageError, page);

      // v2.5.70 (FIX 3): înainte de a renunța, o singură reîncercare automată
      // cu cerere de răspuns mai scurt — cardul Retry/Switch vine abia după ea.
      if (await autoRetryAfterTimeout('no response within the budget')) continue;

      // v2.5.70 (FIX 2): bugetul s-a consumat. Cu pragul de „stuck" urcat la
      // 90s (= bugetul implicit), checkpoint-ul nu mai apucă să ruleze înaintea
      // acestei ramuri — dacă pagina nu arată NICIUN semn de activitate,
      // raportăm „provider stuck" (card Retry/Switch) în loc de un timeout sec.
      if (
        isProviderStuck(
          await providerWorking(page, providerId),
          sawResponseText,
          page.url() !== lastUrlSeen
        )
      ) {
        log(
          label +
            ': no activity at the end of the budget — reporting provider stuck'
        );
        throwProviderError(
          providerId,
          {
            kind: 'no_response',
            message:
              'no response after ' + Math.round(hardTimeoutMs / 1000) + 's'
          },
          page
        );
      }

      throw new Error(
        'Timeout: no stable response from ' + label + ' after ' +
          Math.round(hardTimeoutMs / 1000) + 's.'
      );
    }

    if (observerOk) {
      await waitStep(page, { quietMs: 900, maxWaitMs: 2500, abort: aborted });
    } else {
      // fallback (setare oprită sau fără MutationObserver): polling clasic
      await sleep(500);
    }

    if (signal?.aborted) {
      log(label + ': ABORTED by user');
      throw new Error('__ABORTED__');
    }

    const elapsed = Date.now() - started;

    // v2.5.60 — DETECȚIE ADAPTIVĂ: la 15s/30s/60s/90s verificăm dacă providerul
    // dă vreun semn de viață (buton de Stop vizibil, text de stare
    // thinking/generating/reasoning/stop generating, răspuns nou sau URL
    // schimbat) ori afișează un banner de „rate limit”/„limit reached”. La 90s
    // (v2.5.70: era 60s) fără NIMIC: rescue (poate răspunsul există dar nu e
    // selectat), o reîncercare automată și apoi eroare clară de „provider
    // stuck” — nu mai așteptăm bugetul întreg (era 300s; testul din 8 Oct:
    // 5 minute pierdute).
    if (
      // v2.8.6 (FIX 2): în „ack mode" nu are sens „provider stuck" — ack-ul
      // poate lipsi complet, iar expirarea e tratată la începutul buclei
      // (întoarce textul parțial, fără card de eroare)
      !cfg.ack &&
      stuckIndex < STUCK_CHECKPOINTS.length &&
      elapsed >= STUCK_CHECKPOINTS[stuckIndex]
    ) {
      const checkpoint = STUCK_CHECKPOINTS[stuckIndex];
      stuckIndex++;

      // „rate limit” / „limit reached” / CAPTCHA / memory full în pagină →
      // card clar imediat (același scan ca la checkpoint-urile de reparare).
      const pageError = await detectProviderErrorOnPage(page, providerId, sentText);
      if (pageError?.kind === 'memory_full') {
        await restartInNewChat();
        continue;
      }
      if (pageError) throwProviderError(providerId, pageError, page);

      // v2.5.60: buton de Stop vizibil (= generează) SAU text de stare
      // /thinking|generating|reasoning|stop generating/i SAU răspuns nou SAU
      // URL schimbat → providerul lucrează; altfel, la 60s e BLOCAT.
      const generating = await providerWorking(page, providerId);
      const currentUrl = page.url();
      const urlChanged = currentUrl !== lastUrlSeen;
      lastUrlSeen = currentUrl;
      const seconds = Math.round(checkpoint / 1000);
      log(
        '[stuck-check] ' + label + ' @' + seconds + 's: generating=' + generating +
          ', response=' + sawResponseText + ', urlChanged=' + urlChanged
      );

      if (
        checkpoint >= stuckAbortMs &&
        isProviderStuck(generating, sawResponseText, urlChanged)
      ) {
        log(
          label + ': provider stuck — no activity at ' + seconds +
            's — aborting early (was waiting the whole budget)'
        );
        const rescued = await rescueRead();
        if (rescued.kind === 'restart') continue;
        if (rescued.kind === 'reply') return rescued.text;
        // v2.5.70 (FIX 3): o singură reîncercare automată înainte de card.
        if (await autoRetryAfterTimeout('no activity for ' + seconds + 's')) {
          continue;
        }
        throwProviderError(
          providerId,
          { kind: 'no_response', message: 'no response after ' + seconds + 's' },
          page
        );
      }
    }

    // 1) dacă selectoarele de răspuns nu prind nimic, repară-le (checkpoint-uri)
    if (healIndex < HEAL_CHECKPOINTS.length && elapsed > HEAL_CHECKPOINTS[healIndex]) {
      const checkpoint = HEAL_CHECKPOINTS[healIndex];
      healIndex++;
      if (checkpoint < RESPONSE_HEAL_MIN_MS) {
        // v2.5.20 (bug #44/#58): prea devreme — la 4s/9s bila AI poate fi doar
        // nerandată; lipsa unui match NU dovedește un selector stricat.
        log(
          label + ': response heal skipped at ' + checkpoint +
          'ms (the reply may still be rendering)'
        );
      } else if (await anySelectorMatches(page, responseSelectors)) {
        if (checkpoint === RESPONSE_HEAL_MIN_MS) {
          log(label + ': response selectors work, waiting for the stream');
        }
      } else {
        responseRepairPending = true;
      }
    }

    // v2.5.1: la fiecare checkpoint verificăm și erorile afișate în pagină —
    // „out of free messages” / rate limit / CAPTCHA opresc imediat, cu mesaj
    // clar, în loc să așteptăm tot bugetul de așteptare pentru un timeout sec.
    if (healIndex > lastErrorCheckpoint) {
      lastErrorCheckpoint = healIndex;
      const pageError = await detectProviderErrorOnPage(page, providerId, sentText);
      // v2.5.15 (bug #41): context epuizat („Chat memory full") — nu e o eroare
      // terminală: întrebăm dacă reluăm într-un chat nou.
      if (pageError?.kind === 'memory_full') {
        await restartInNewChat();
        continue;
      }
      if (pageError) throwProviderError(providerId, pageError, page);
    }

    if (responseRepairPending && !responseRepairAttempted) {
      const fallbackText = await readResponse(
        selectors.candidates(providerId, 'response'),
        true
      );
      const newReply = stripEchoedUserMessage(fallbackText, sentText);
      if (
        newReply.length >= 60 &&
        fallbackText !== beforeFallbackText &&
        !isEchoOf(newReply, sentText)
      ) {
        responseRepairAttempted = true;
        if (firstReplyInSession) {
          logLine('ai-finder', 'deferred repair — running after first reply');
        }
        const healed = await healSlot(page, providerId, 'response', sentText);
        if (healed) {
          const probe = await readResponse(
            selectors.candidates(providerId, 'response')
          );
          if (probe && isEchoOf(probe, sentText)) {
            log(label + ': repair rejected (it caught our message) — falling back to JSON');
            selectors.forget(providerId, 'response');
          } else {
            responseSelectors = selectors.candidates(providerId, 'response');
            previousText = '';
            lastChangeAt = Date.now();
            log(label + ': response selector repaired -> ' + healed);
            // v2.5.65 (FIX 4): reparația „deferred" trebuie SĂ ȘI PERSISTE.
            // Fără scrierea explicită, selectorul nou rămânea doar în memorie
            // (sau în globalState la `learn()`), dar nu apărea în
            // `selectors-user.json` — deci se pierdea la următoarea curățenie.
            const saved = selectors.saveUserFile();
            const persisted = selectors.learned(providerId, 'response')?.selector === healed;
            logLine(
              'selectors',
              saved && persisted
                ? 'saved ' + providerId + '.response via deferred repair'
                : 'could not save ' + providerId +
                  '.response after deferred repair (' + healed + ')'
            );
          }
        }
      }
    }

    // 2) la ~25s: al doilea Enter (uneori primul nu pleacă mesajul)
    // v0.9.3: re-focus pe căsuța de input ÎNAINTE de Enter — altfel tasta poate
    // ajunge în alt element și mesajul rămâne în composer (reproducere: Kimi).
    if (!enterRetried && elapsed > 25000) {
      enterRetried = true;
      try {
        await humanClickButton(page, input, 2000);
        await sleep(150);
        await page.keyboard.press('Enter');
        log(label + ': Enter re-sent (the message did not go out?)');
      } catch {
        /* ignorăm */
      }
    }

    const currentText = await readResponse(responseSelectors);
    if (!currentText) continue;

    // v2.5.15 (bug #41): bannerul „Chat memory full" (ChatGPT) poate ajunge în
    // textul citit — contextul e epuizat, așteptarea normală nu mai poate reuși.
    if (isMemoryFullText(currentText)) {
      await restartInNewChat();
      continue;
    }

    // v2.5.43 (bug #100): același lucru pentru bannerul de plan/cotă („You've
    // reached your free plan limit") — oprește imediat, cu card clar în chat.
    // Bannerul e SCURT, deci cerem și o limită de lungime: un răspuns normal
    // care doar pomenește „limit reached" nu trebuie confundat cu o eroare.
    // v2.5.74 (FIX 3): textul vine din ZONA DE CHAT (răspunsul citit), deci
    // rămâne o dovadă validă — spre deosebire de bannerul de upsell din sidebar,
    // care nu mai intră deloc în scan (vezi scanProviderErrorText).
    if (isPlanLimitText(currentText) && currentText.length <= 500) {
      const planErr = detectProviderError(
        currentText,
        providerId,
        await upgradeLink()
      );
      if (planErr) throwProviderError(providerId, planErr, page);
    }

    // v2.5.12 FIX (bug #36): „răspuns nou" = a apărut o bulă în plus în DOM
    // (count mai mare) SAU textul diferă de cel de dinainte de trimitere. Cu
    // doar textul ca sentinelă, un răspuns IDENTIC cu precedentul (exact același
    // tool call repetat) era confundat cu „încă nimic" → buclă până la timeout.
    const currentCount = await countAssistantResponses(page, responseSelectors);
    if (currentCount <= beforeCount && currentText === beforeText) continue;
    sawNewResponse = true;

    // v2.5.3 FIX 7: providerii care ecouază promptul (DeepSeek) trimit
    // „<mesaj user> \n TOOL: …” — tăiem prefixul ecou ÎNAINTE de isEchoOf, ca
    // tool call-ul de după el să nu mai fie respins (și pierdut) ca ecou.
    const visible = stripEchoedUserMessage(currentText, sentText);
    if (visible !== currentText) {
      log(label + ': stripped echoed user message from AI reply');
    }
    if (!visible) continue;

    // v0.8.0: ecoul propriului mesaj nu e răspuns — nu îl declarăm "stabil".
    // v0.9.3: extins cu sufixele de acțiuni (Kimi „Edit/Copy/Share”) — vezi isEchoOf.
    if (isEchoOf(visible, sentText)) continue;

    // v2.5.60: avem text REAL de răspuns — sentința detecției adaptive
    // („la 60s fără thinking ȘI fără răspuns → provider blocat”).
    sawResponseText = true;

    // FAZA III (E): progres vizibil — trimitem și textul parțial (throttled).
    if (
      cfg.onProgress &&
      visible !== previousText &&
      Date.now() - lastStreamAt > 900
    ) {
      lastStreamAt = Date.now();
      try {
        cfg.onProgress(visible);
      } catch {
        /* progresul nu trebuie să strice trimiterea */
      }
    }

    if (visible === previousText) {
      // v0.8.0: stabil = text neschimbat STABLE_MS (echiv. vechiului 4×500ms),
      // independent de ritmul pașilor (quiet/timeout).
      if (Date.now() - lastChangeAt >= STABLE_MS) {
        log(
          label +
            ': stable response after ' +
            (Date.now() - started) +
            'ms (' +
            visible.length +
            ' chars)'
        );
        // v2.5.1: răspunsul „stabil” poate fi de fapt mesajul de eroare al
        // site-ului (ex: „You are out of free messages until 6:20 PM.”).
        const detected = detectProviderError(
          visible,
          providerId,
          await upgradeLink()
        );
        if (detected?.kind === 'memory_full') {
          await restartInNewChat();
          continue;
        }
        if (detected) throwProviderError(providerId, detected, page);
        // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
        await emitThinking(page, providerId, sentText, cfg, label);
        return visible;
      }
    } else {
      previousText = visible;
      lastChangeAt = Date.now();
    }
  }
}

/* =========================================================================
 * FAZA II (A): upload de fișiere în chatul web (imagini / binare)
 * ========================================================================= */

/** Cuvinte care indică un input de upload ce NU e al chatului. */
const UPLOAD_ANCESTOR_BLACKLIST = [
  'avatar', 'profile', 'account', 'menu', 'nav', 'header', 'logo',
  'banner', 'emoji', 'theme', 'setting'
];

interface UploadScanArgs {
  sels: string[];
  keywords: string[];
}

/**
 * Rulează ÎN PAGINĂ: alege input[type=file] cel mai apropiat de căsuța de
 * chat (composer) și îl marchează cu data-freekit-fileinput="1".
 * Acceptă și inputuri ascunse (setInputFiles nu are nevoie de vizibilitate).
 */
const markUploadInput = (args: UploadScanArgs): boolean => {
  const inputs = Array.prototype.slice.call(
    document.querySelectorAll('input[type="file"]')
  ) as HTMLInputElement[];
  if (!inputs.length) return false;

  const isBad = (hay: string): boolean => {
    const h = String(hay).toLowerCase();
    for (const kw of args.keywords) {
      if (h.indexOf(kw) >= 0) return true;
    }
    return false;
  };

  // căsuța de chat (composer) — pentru scorul de proximitate
  let composer: Element | null = null;
  for (const sel of args.sels) {
    try {
      composer = document.querySelector(sel);
    } catch {
      composer = null;
    }
    if (composer) break;
  }

  const stepsTo = (el: Element): number => {
    if (!composer) return 99;
    let steps = 0;
    let n: Element | null = composer;
    while (n && steps < 12) {
      if (n.contains(el)) return steps;
      n = n.parentElement;
      steps++;
    }
    return 99;
  };

  const ancestryText = (el: Element): string => {
    let hay = '';
    let n: Element | null = el;
    let d = 0;
    while (n && d < 8) {
      const cls = (n as HTMLElement).className;
      hay += ' ' + (typeof cls === 'string' ? cls : '') + ' ' + (n.id || '');
      n = n.parentElement;
      d++;
    }
    return hay;
  };

  let best: HTMLInputElement | null = null;
  let bestScore = -1;
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    if (isBad(ancestryText(el))) continue;
    let s = 0;
    const accept = String(el.getAttribute('accept') || '').toLowerCase();
    if (!accept) s += 2;
    if (accept.indexOf('image') >= 0) s += 2;
    if (accept.indexOf('pdf') >= 0 || accept.indexOf('text') >= 0) s += 1;
    if (el.multiple) s += 2;
    const steps = stepsTo(el);
    if (steps < 99) s += Math.max(0, 6 - steps);
    if (s >= bestScore) {
      bestScore = s;
      best = el; // la scor egal, ultimul din DOM (composerul e spre final)
    }
  }

  if (!best) return false;
  best.setAttribute('data-freekit-fileinput', '1');
  return true;
};

/**
 * Încarcă fișierele în chatul web prin input[type=file].
 * Returnează true dacă inputul a fost găsit și setInputFiles a reușit.
 */
export async function uploadChatFiles(
  page: Page,
  providerId: string,
  files: string[],
  label: string
): Promise<boolean> {
  try {
    const marked = await page.evaluate<boolean, UploadScanArgs>(markUploadInput, {
      sels: selectors.candidates(providerId, 'input'),
      keywords: UPLOAD_ANCESTOR_BLACKLIST
    });
    if (!marked) {
      log(label + ': no input[type=file] found for the chat');
      return false;
    }
    const loc = page
      .locator('input[type="file"][data-freekit-fileinput="1"]')
      .first();
    await loc.setInputFiles(files, { timeout: 15000 });
    // lăsăm site-ul să proceseze atașamentele înainte de trimiterea textului
    await sleep(2500);
    log(label + ': ' + files.length + ' file(s) uploaded to the chat');
    return true;
  } catch (e: any) {
    log(label + ': upload failed — ' + (e?.message ?? String(e)));
    return false;
  } finally {
    try {
      await page.evaluate(() => {
        const els = document.querySelectorAll('[data-freekit-fileinput]');
        for (let i = 0; i < els.length; i++) {
          els[i].removeAttribute('data-freekit-fileinput');
        }
      });
    } catch {
      /* curățarea nu e critică */
    }
  }
}
