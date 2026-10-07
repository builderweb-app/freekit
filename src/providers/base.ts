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
import {
  DetectedProviderError,
  detectProviderError,
  isMemoryFullText,
  isPlanLimitText,
  ProviderError
} from '../providerErrors';

const log = (msg: string) => console.log('[Freekit]', msg);

/** Momentele (ms de la trimitere) la care verificăm dacă e nevoie de reparare. */
const HEAL_CHECKPOINTS = [4000, 9000, 20000, 40000];

/** v0.8.0: bugetul total de așteptare + pragul de stabilitate a textului. */
/** v2.5.35 (bug #86): 150s era prea scurt pentru răspunsuri lungi (Gemini). */
const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;
const MIN_RESPONSE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_TIMEOUT_MS = 1_800_000;
const STABLE_MS = 2000;

/**
 * v2.5.35 (bug #86): bugetul de așteptare a unui răspuns, din setarea
 * `freekit.responseTimeoutMs` (implicit 300s). Citit o dată per mesaj.
 */
export function responseTimeoutMs(): number {
  try {
    // require lazy — în teste Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    const raw = Number(
      v.workspace
        .getConfiguration('freekit')
        .get<number>('responseTimeoutMs', DEFAULT_RESPONSE_TIMEOUT_MS)
    );
    if (!Number.isFinite(raw)) return DEFAULT_RESPONSE_TIMEOUT_MS;
    return Math.min(
      MAX_RESPONSE_TIMEOUT_MS,
      Math.max(MIN_RESPONSE_TIMEOUT_MS, Math.floor(raw))
    );
  } catch {
    return DEFAULT_RESPONSE_TIMEOUT_MS;
  }
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
  throw new Error(
    'I could not find the input box for ' +
      label +
      ' (selectors tried: ' +
      selectors.candidates(providerId, 'input').join(', ') +
      '). Are you logged in to Chrome with the Freekit profile? ' +
      'If the selector is broken, run "Freekit: Repair Selectors".'
  );
}

/** Check bundled selectors quickly; only missing slots enter the healer path. */
async function validateConnectSelectors(
  page: Page,
  providerId: string,
  label: string
): Promise<void> {
  const slots: SlotName[] = ['input', 'response', 'newChat'];
  const missing = await Promise.all(
    slots.map(async (slot) => {
      const primary = selectors.primary(providerId, slot);
      if (!primary) return { slot, present: false };
      const locator = page.locator(primary).first();
      try {
        return {
          slot,
          present:
            (await locator.count()) > 0 &&
            (await locator.isVisible()) &&
            (await locator.isEnabled())
        };
      } catch {
        return { slot, present: false };
      }
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
const scanProviderErrorText = (): string => {
  const parts: string[] = [];
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const usable = (el: Element): boolean =>
    !el.closest('pre, code, textarea, input, [contenteditable="true"]');
  const sels = [
    '[role="alert"]',
    '[role="status"]',
    '[class*="error" i]',
    '[class*="alert" i]',
    '[class*="toast" i]',
    '[class*="banner" i]',
    '[class*="limit" i]',
    '[class*="upsell" i]',
    '[class*="quota" i]',
    '[class*="paywall" i]'
  ];
  for (const sel of sels) {
    if (parts.length >= 40) break;
    let els: Element[] = [];
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const el of els) {
      if (!visible(el) || !usable(el)) continue;
      const t = String((el as HTMLElement).innerText || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (t && t.length <= 600 && parts.indexOf(t) < 0) parts.push(t);
    }
  }
  const body = String(document.body ? document.body.innerText : '')
    .replace(/\s+/g, ' ');
  if (body) parts.push(body.slice(-2500));
  return parts.join('\n');
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
    const text = await page.evaluate<string>(scanProviderErrorText);
    // v2.5.43 (bug #100): butonul de upgrade/plans/pricing din pagină — semn de
    // plan gratuit / cotă atinsă, și sursa URL-ului real de pe cardul din chat.
    const upgradeUrl = await readUpgradeLink(page);
    const detected = detectProviderError(
      stripEcho(text, message),
      providerId,
      upgradeUrl
    );
    if (!detected) return null;
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

/** Textul curent din composer (innerText pentru contenteditable, value pentru input/textarea). */
export async function readComposerText(input: Locator): Promise<string | null> {
  try {
    return await input.evaluate((el) => {
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

/** Golește composerul (best-effort) — un draft rămas nu are voie să plece. */
export async function clearComposer(
  page: Page,
  input: Locator,
  label: string
): Promise<void> {
  try {
    const current = await readComposerText(input);
    if (current === null) return; // nu putem citi → nu riscăm un Ctrl+A orb
    if (!current.trim()) return; // nimic de curățat
    await humanClickButton(page, input, 5000);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await sleep(150);
    log(label + ': leftover draft cleared from the composer (' + current.length + ' chars)');
  } catch (e: any) {
    log(label + ': composer clear failed — ' + (e?.message ?? String(e)));
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
  label: string,
  onNotice?: (text: string) => void
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
    if (r.gaveUp) {
      onNotice?.(
        '⚠️ ' + label + ': nu pot găsi input-ul de chat. Show Browser → DevTools → fix manual.'
      );
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
  const actual = await readComposerText(input);
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
  await clearComposer(page, input, label);
  await page.keyboard.insertText(message);
  await sleep(200);
  const after = await readComposerText(input);
  if (after !== null && composerTextMatches(after, message)) {
    log(label + ': composer verified after re-paste');
    return input;
  }

  log(
    label + ': composer STILL mismatched after re-paste (' +
      (after === null ? 'unreadable' : after.length + '/' + message.length) + ')'
  );
  suspectInput.add(providerId);
  const repaired = await repairInput(page, providerId, label, onNotice);
  if (!repaired) return input;

  const replacement = page.locator(repaired).first();
  try {
    await humanClickButton(page, replacement, 15000);
    await clearComposer(page, replacement, label);
    await page.keyboard.insertText(message);
    await sleep(200);
    const retry = await readComposerText(replacement);
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
    await clearComposer(page, box, label);

    // v0.8.0: tastare "umană" (evenimente reale de tastatură); v2.0.6: mesajele
    // lungi tastează natural doar începutul, restul se lipește — vezi humanType.
    try {
      // v2.5.48: providerii rapizi (DeepSeek/Gemini/Ollama) primesc paste
      // instant chiar și cu tastarea „umană" pornită — typing-ul caracter-cu-
      // caracter încetinea vizibil trimiterea; ChatGPT/Claude păstrează
      // tastarea umană (stealth).
      const fastPaste =
        providerId === 'deepseek' ||
        providerId === 'gemini' ||
        providerId === 'ollama';
      if (human.typing && !fastPaste) {
        await humanType(page, text, {}, signal);
      } else {
        if (fastPaste) logLine('human', 'fast paste for ' + providerId);
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
  input = await composeAndSend(message);
  log(label + ': message sent, waiting for the response...');

  // v0.8.0: MutationObserver — "liniștea" din DOM încheie așteptarea instant;
  // cu setarea oprită rămâne polling-ul clasic la 500ms.
  let observerOk = human.observer ? await installMutationTracker(page) : false;
  const aborted = signal ? waitForAbort(signal) : undefined;

  let previousText = '';
  let lastChangeAt = Date.now();
  let healIndex = 0;
  let lastErrorCheckpoint = 0;
  let enterRetried = false;
  let lastStreamAt = 0;
  // v2.5.12 FIX (bug #36): true după ce am văzut un răspuns NOU (count crescut
  // sau text schimbat) — folosit de „rescue" ca să accepte și un răspuns identic.
  let sawNewResponse = false;
  // v2.5.35 (bug #86): bugetul de așteptare din setări (implicit 300s), citit
  // o dată per mesaj.
  const hardTimeoutMs = responseTimeoutMs();
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
    input = await composeAndSend(sentText);
    // chat nou → sentinelele repornesc (alt DOM, altă numărătoare de răspunsuri)
    beforeText = await readResponse(responseSelectors);
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

  for (;;) {
    // v2.5.15 (bug #41): bugetul de așteptare s-a consumat → RESCUE + scanul
    // final de erori. O continuare într-un chat nou (memory full) resetează
    // `started` și reia bucla.
    if (Date.now() - started >= hardTimeoutMs) {
      // RESCUE: ultima șansă — extragere generică, ca să nu blocăm utilizatorul
      const rescuedRaw = await readResponse(
        selectors.candidates(providerId, 'response'),
        true
      );
      const rescued = stripEchoedUserMessage(rescuedRaw, sentText);
      if (rescued !== rescuedRaw) {
        log(label + ': stripped echoed user message from AI reply (rescue)');
      }
      if (
        rescued &&
        rescued.length >= 20 &&
        (sawNewResponse || rescued !== beforeText) &&
        !isEchoOf(rescued, sentText)
      ) {
        log(label + ': RESCUE generic, ' + rescued.length + ' chars');
        // v2.5.1: și textul de la „rescue” poate fi un mesaj de eroare al site-ului
        const detected = detectProviderError(
          rescued,
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
        return rescued;
      }

      // v2.5.1: înainte de timeout-ul sec, verificăm dacă pagina afișează o eroare
      // cunoscută (banner care nu intră în selectorii de răspuns) — ex: limita de
      // mesaje gratuite la Claude/ChatGPT.
      const pageError = await detectProviderErrorOnPage(page, providerId, sentText);
      if (pageError?.kind === 'memory_full') {
        await restartInNewChat();
        continue;
      }
      if (pageError) throwProviderError(providerId, pageError, page);

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
          }
        }
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
