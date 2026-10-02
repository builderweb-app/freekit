import { Locator, Page } from 'playwright';
import {
  anySelectorMatches,
  anySelectorPresent,
  getLastResponseText,
  healSlot,
  inputAvailable,
  resolveSlot,
  selectors
} from '../selectors';
import { SendOptions } from './types';
import {
  humanBehaviorEnabled,
  humanMoveToElement,
  humanScroll,
  humanSettings,
  humanType
} from '../human-behavior';
import { installMutationTracker, waitForAbort, waitStep } from '../mutation';
import { autoAcceptPopups } from '../popups';

const log = (msg: string) => console.log('[Freekit]', msg);

/** Momentele (ms de la trimitere) la care verificăm dacă e nevoie de reparare. */
const HEAL_CHECKPOINTS = [4000, 9000, 20000, 40000];

/** v0.8.0: peste atâtea caractere renunțăm la tastarea "umană" (lipire directă). */
const HUMAN_TYPING_MAX_CHARS = 1500;

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

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { getLastResponseText };

/* =========================================================================
 * v0.8.0 — HUMAN BEHAVIOR (anti-detect)
 * ========================================================================= */

/** Mișcare de mouse "umană" înainte de un click (doar dacă e activată). */
async function humanClickPrep(page: Page, target: string | Locator): Promise<void> {
  if (!humanBehaviorEnabled()) return;
  await humanMoveToElement(page, target);
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
  for (const sel of selectors.candidates(providerId, 'newChat')) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) === 0 || !(await btn.isVisible())) continue;
      await humanClickPrep(page, btn);
      await btn.click({ timeout: 2000 });
      await sleep(1200);
      // FIX v2: 5s erau prea puțini (ex: DeepSeek — tranziția spre chatul nou e lentă)
      if (await inputAvailable(page, providerId, 8000)) {
        selectors.note(providerId, 'newChat', sel);
        log(label + ': new chat via ' + sel);
        return;
      }
    } catch {
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
        await humanClickPrep(page, btn);
        await btn.click({ timeout: 2000 });
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

/** Apasă butonul de Stop al site-ului (best-effort, folosit la anulare). */
export async function clickStop(page: Page, providerId: string): Promise<boolean> {
  for (const sel of selectors.candidates(providerId, 'stopButton')) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) === 0 || !(await btn.isVisible())) continue;
      await humanClickPrep(page, btn);
      await btn.click({ timeout: 1500 });
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
  kimi: ['div.toolcall-content-text', '[class*="toolcall-content"]'],
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
  log(label + ': send() START, beforeLen=' + beforeText.length);

  // v0.8.0: setările de humanizare (citite o dată per mesaj)
  const human = humanSettings();

  const input = await findInput(page, providerId, label, 15000);
  if (human.behavior) {
    // mișcare mică de mouse spre căsuța de input + scroll ocazional
    await humanMoveToElement(page, input);
    if (Math.random() < 0.25) await humanScroll(page);
  }
  await input.click();

  // v0.8.0: tastare "umană" (char-cu-char); mesajele foarte lungi se lipesc
  // direct — un om nu tastează 100k caractere (ex: atașamente embed-uite).
  try {
    if (human.typing && message.length <= HUMAN_TYPING_MAX_CHARS) {
      await humanType(page, message, {}, signal);
    } else {
      if (human.typing) {
        log(
          label + ': message of ' + message.length +
            ' chars — direct paste (over the typing limit)'
        );
      }
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
  let enterRetried = false;
  let lastStreamAt = 0;
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

    // 2) la ~25s: al doilea Enter (uneori primul nu pleacă mesajul)
    // v0.9.3: re-focus pe căsuța de input ÎNAINTE de Enter — altfel tasta poate
    // ajunge în alt element și mesajul rămâne în composer (reproducere: Kimi).
    if (!enterRetried && elapsed > 25000) {
      enterRetried = true;
      try {
        await input.click({ timeout: 2000 });
        await sleep(150);
        await page.keyboard.press('Enter');
        log(label + ': Enter re-sent (the message did not go out?)');
      } catch {
        /* ignorăm */
      }
    }

    const currentText = await getLastResponseText(page, responseSelectors);
    if (!currentText || currentText === beforeText) continue;

    // v0.8.0: ecoul propriului mesaj nu e răspuns — nu îl declarăm "stabil".
    // v0.9.3: extins cu sufixele de acțiuni (Kimi „Edit/Copy/Share”) — vezi isEchoOf.
    if (isEchoOf(currentText, message)) continue;

    // FAZA III (E): progres vizibil — trimitem și textul parțial (throttled).
    if (
      cfg.onProgress &&
      currentText !== previousText &&
      Date.now() - lastStreamAt > 900
    ) {
      lastStreamAt = Date.now();
      try {
        cfg.onProgress(currentText);
      } catch {
        /* progresul nu trebuie să strice trimiterea */
      }
    }

    if (currentText === previousText) {
      // v0.8.0: stabil = text neschimbat STABLE_MS (echiv. vechiului 4×500ms),
      // independent de ritmul pașilor (quiet/timeout).
      if (Date.now() - lastChangeAt >= STABLE_MS) {
        log(
          label +
            ': stable response after ' +
            (Date.now() - started) +
            'ms (' +
            currentText.length +
            ' chars)'
        );
        // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
        await emitThinking(page, providerId, message, cfg, label);
        return currentText;
      }
    } else {
      previousText = currentText;
      lastChangeAt = Date.now();
    }
  }

  // RESCUE: ultima șansă — extragere generică, ca să nu blocăm utilizatorul
  const rescued = await getLastResponseText(
    page,
    selectors.candidates(providerId, 'response'),
    true
  );
  if (rescued && rescued.length >= 20 && rescued !== beforeText && !isEchoOf(rescued, message)) {
    log(label + ': RESCUE generic, ' + rescued.length + ' chars');
    // v1.7.1: thinking-ul modelului (best-effort, înainte de return)
    await emitThinking(page, providerId, message, cfg, label);
    return rescued;
  }

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
