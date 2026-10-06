import { Locator, Page } from 'playwright';
import {
  anySelectorMatches,
  anySelectorPresent,
  countAssistantResponses,
  getLastResponseText,
  healSlot,
  inputAvailable,
  resolveSlot,
  selectors
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
import {
  DetectedProviderError,
  detectProviderError,
  ProviderError
} from '../providerErrors';

const log = (msg: string) => console.log('[Freekit]', msg);

/** Momentele (ms de la trimitere) la care verificăm dacă e nevoie de reparare. */
const HEAL_CHECKPOINTS = [4000, 9000, 20000, 40000];

/** v0.8.0: bugetul total de așteptare + pragul de stabilitate a textului. */
const HARD_TIMEOUT_MS = 150_000;
const STABLE_MS = 2000;

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
    log(label + ': input via ' + found.selector);
    return found.locator;
  }
  // v2.0.4: inputul lipsește — dacă pagina e de fapt una de login, semnalăm
  // „login required" (chatView aduce Chrome în față + oferă butonul Retry) în
  // loc de eroarea seacă „could not find the input box".
  if (await detectLoginPage(page)) {
    const url = page.url();
    log(label + ': input missing, login page detected (' + url + ')');
    throw loginError(providerId, url);
  }
  throw new Error(
    'I could not find the input box for ' +
      label +
      ' (selectors tried: ' +
      selectors.candidates(providerId, 'input').join(', ') +
      '). Are you logged in to Chrome with the Freekit profile?'
  );
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
    const detected = detectProviderError(stripEcho(text, message), providerId);
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
    if (await inputAvailable(page, providerId, 20000)) return;
    log(label + ': input not found on ' + current + ', navigating to ' + url);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // v1.8.0: acceptă automat popup-urile de cookie/terms după încărcare
  await autoAcceptPopups(page, { log }).catch(() => []);
  // FIX v2: dacă aterizăm tot pe login (ex: Claude fără sesiune), nu mai
  // lăsăm healer-ul să rătăcească prin pagina de login (#email).
  if (isLoginUrl(page.url())) {
    throw loginError(providerId, page.url());
  }
  await findInput(page, providerId, label, 60000);
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
    if (isLoginUrl(page.url())) throw loginError(providerId, page.url());
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

export async function sendAndWait(
  page: Page,
  message: string,
  cfg: SendConfig
): Promise<string> {
  const { providerId, label, signal } = cfg;

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
  let beforeText = await getLastResponseText(page, responseSelectors);
  // v2.5.12 FIX (bug #36): numărul de răspunsuri existente ÎNAINTE de trimitere —
  // sentinela pentru „a apărut un răspuns nou", independentă de conținutul lui.
  let beforeCount = await countAssistantResponses(page, responseSelectors);
  log(
    label + ': send() START, beforeLen=' + beforeText.length +
      ', beforeCount=' + beforeCount
  );

  // v0.8.0: setările de humanizare (citite o dată per mesaj)
  const human = humanSettings();

  let input = await findInput(page, providerId, label, 15000);
  // v2.5.12 (bug #35): ChatGPT fără cont păstrează composerul funcțional
  // (guest mode), deci findInput reușește și verificarea de login din el
  // (ramura „input lipsă") nu se execută. Întrebăm utilizatorul înainte de a
  // trimite — NU blocăm: „Continue as guest" merge exact ca înainte.
  if (cfg.onLoggedOut && (await detectLoggedOut(page, providerId))) {
    const decision = await cfg.onLoggedOut(providerId);
    if (decision !== 'continue') throw new Error('__ABORTED__');
    // după login pagina se poate reîncărca → re-resolve composerul
    input = await findInput(page, providerId, label, 15000);
  }
  await clickInput(page, input);

  // v0.8.0: tastare "umană" (evenimente reale de tastatură); v2.0.6: mesajele
  // lungi tastează natural doar începutul, restul se lipește — vezi humanType.
  try {
    if (human.typing) {
      await humanType(page, message, {}, signal);
    } else {
      await page.keyboard.insertText(message);
    }
  } catch (e: any) {
    if ((e?.message ?? String(e)) === '__ABORTED__') {
      // nu lăsa text parțial în căsuța de input după anulare
      await clearInputBestEffort(page);
    }
    throw e;
  }
  await sleep(400);
  await page.keyboard.press('Enter');
  log(label + ': message sent, waiting for the response...');

  // v0.8.0: MutationObserver — "liniștea" din DOM încheie așteptarea instant;
  // cu setarea oprită rămâne polling-ul clasic la 500ms.
  const observerOk = human.observer ? await installMutationTracker(page) : false;
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
  const started = Date.now();

  while (Date.now() - started < HARD_TIMEOUT_MS) {
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
      healIndex++;
      if (await anySelectorMatches(page, responseSelectors)) {
        if (healIndex === 1) {
          log(label + ': response selectors work, waiting for the stream');
        }
      } else {
        const healed = await healSlot(page, providerId, 'response', message);
        if (healed) {
          const probe = await getLastResponseText(
            page,
            selectors.candidates(providerId, 'response')
          );
          if (probe && isEchoOf(probe, message)) {
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
    // clar, în loc să așteptăm 150s pentru un timeout sec.
    if (healIndex > lastErrorCheckpoint) {
      lastErrorCheckpoint = healIndex;
      const pageError = await detectProviderErrorOnPage(page, providerId, message);
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

    const currentText = await getLastResponseText(page, responseSelectors);
    if (!currentText) continue;

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
    const visible = stripEchoedUserMessage(currentText, message);
    if (visible !== currentText) {
      log(label + ': stripped echoed user message from AI reply');
    }
    if (!visible) continue;

    // v0.8.0: ecoul propriului mesaj nu e răspuns — nu îl declarăm "stabil".
    // v0.9.3: extins cu sufixele de acțiuni (Kimi „Edit/Copy/Share”) — vezi isEchoOf.
    if (isEchoOf(visible, message)) continue;

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
        const detected = detectProviderError(visible, providerId);
        if (detected) throwProviderError(providerId, detected, page);
        // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
        await emitThinking(page, providerId, message, cfg, label);
        return visible;
      }
    } else {
      previousText = visible;
      lastChangeAt = Date.now();
    }
  }

  // RESCUE: ultima șansă — extragere generică, ca să nu blocăm utilizatorul
  const rescuedRaw = await getLastResponseText(
    page,
    selectors.candidates(providerId, 'response'),
    true
  );
  const rescued = stripEchoedUserMessage(rescuedRaw, message);
  if (rescued !== rescuedRaw) {
    log(label + ': stripped echoed user message from AI reply (rescue)');
  }
  if (
    rescued &&
    rescued.length >= 20 &&
    (sawNewResponse || rescued !== beforeText) &&
    !isEchoOf(rescued, message)
  ) {
    log(label + ': RESCUE generic, ' + rescued.length + ' chars');
    // v2.5.1: și textul de la „rescue” poate fi un mesaj de eroare al site-ului
    const detected = detectProviderError(rescued, providerId);
    if (detected) throwProviderError(providerId, detected, page);
    // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
    await emitThinking(page, providerId, message, cfg, label);
    return rescued;
  }

  // v2.5.1: înainte de timeout-ul sec, verificăm dacă pagina afișează o eroare
  // cunoscută (banner care nu intră în selectorii de răspuns) — ex: limita de
  // mesaje gratuite la Claude/ChatGPT.
  const pageError = await detectProviderErrorOnPage(page, providerId, message);
  if (pageError) throwProviderError(providerId, pageError, page);

  throw new Error(
    'Timeout: no stable response from ' + label + ' after 150s.'
  );
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
