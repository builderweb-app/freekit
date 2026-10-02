import { Locator, Page } from 'playwright';
// IMPORTANT: `vscode` doar ca TIP — la runtime require-ul e lazy (teste Node safe).
import type * as vscode from 'vscode';
import { logLine } from './log';

const log = (msg: string) => logLine('human', msg);

/* =========================================================================
 * v0.8.0 — HUMAN BEHAVIOR (anti-detect)
 *
 * Tastare cu întârzieri aleatorii, pauze la punctuație și burst-uri rapide
 * ocazionale + mișcări mici de mouse și scroll înainte de acțiuni. Feature-urile
 * sunt configurabile din setări:
 *   freekit.humanTyping   (implicit true) — tastarea "umană"
 *   freekit.humanBehavior (implicit true) — mouse/scroll
 *
 * v2.0.6: caracterele sunt tastate cu evenimente reale de tastatură
 * (keydown/keypress/keyup), nu lipite cu `insertText`. Mesajele peste 200 de
 * caractere tastează natural doar primele 30-50 (vezi `humanType`).
 * ========================================================================= */

export interface HumanTypingOptions {
  minDelay: number;          // ms între caractere (default 5)
  maxDelay: number;          // ms (default 15)
  punctuationPause: number;  // ms după . ! ? , (default 150)
  burstProbability: number;  // 0-1, șansa de "burst" rapid (default 0.15)
  burstLength: number;       // caractere consecutive rapide (default 8)
}

const DEFAULT_OPTIONS: HumanTypingOptions = {
  minDelay: 5,
  maxDelay: 15,
  punctuationPause: 150,
  burstProbability: 0.15,
  burstLength: 8
};

/**
 * v2.0.6: până la acest prag mesajul se tastează integral „natural”; peste el
 * (prompturi uriașe) doar începutul, restul fiind lipit dintr-o singură bucată.
 */
export const NATURAL_TYPING_MAX_CHARS = 200;

/** v2.0.6: câte caractere de la începutul unui mesaj lung se tastează natural. */
const NATURAL_HEAD_MIN_CHARS = 30;
const NATURAL_HEAD_MAX_CHARS = 50;

/**
 * Tastează text ca un om: delay aleatoriu, pauze la punctuație, burst-uri ocazionale.
 * `signal` (opțional): la anulare aruncă '__ABORTED__' — ca restul fluxului.
 *
 * v2.0.6: caracterele trec prin `page.keyboard.type()`, deci Chrome primește
 * evenimente REALE de keydown/keypress/keyup (anti-detect-ul care numără doar
 * `insertText` nu mai vede o lipire instantă). Mesajele lungi rămân rapide:
 * se tastează natural doar primele 30-50 de caractere, restul se lipește.
 */
export async function humanType(
  page: Page,
  text: string,
  options: Partial<HumanTypingOptions> = {},
  signal?: AbortSignal
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!text) return;

  const headLength =
    text.length <= NATURAL_TYPING_MAX_CHARS
      ? text.length
      : randInt(NATURAL_HEAD_MIN_CHARS, Math.min(NATURAL_HEAD_MAX_CHARS, text.length));
  log('typing ' + headLength + '/' + text.length + ' chars with human delay');

  await typeNaturally(page, text.slice(0, headLength), opts, signal);

  // Restul (doar la mesajele lungi): o singură lipire — un om nu tastează
  // 5000 de caractere, iar caracter-cu-caracter ar dura minute întregi.
  if (headLength < text.length) {
    if (signal?.aborted) throw new Error('__ABORTED__');
    const rest = text.slice(headLength);
    await page.keyboard.insertText(rest);
    log('pasted the remaining ' + rest.length + ' chars');
  }

  log('typing finished');
}

/**
 * v2.0.6: tastează un fragment cu evenimente reale de tastatură. `\n` NU are
 * voie să treacă prin `type()` — Playwright îl trimite ca tasta Enter, iar în
 * composerul de chat Enter = „trimite mesajul”. Newline-ul se scrie ca text.
 */
async function typeChunk(page: Page, chunk: string, delay: number): Promise<void> {
  for (const part of chunk.split(/(\r?\n)/)) {
    if (!part) continue;
    if (part === '\n' || part === '\r\n') {
      await page.keyboard.insertText(part);
      continue;
    }
    await page.keyboard.type(part, { delay });
  }
}

/** Bucla de tastare „umană” (burst-uri + pauze de punctuație / gândire). */
async function typeNaturally(
  page: Page,
  text: string,
  opts: HumanTypingOptions,
  signal?: AbortSignal
): Promise<void> {
  let i = 0;
  while (i < text.length) {
    if (signal?.aborted) throw new Error('__ABORTED__');

    // Verifică dacă suntem într-un burst rapid
    const inBurst = Math.random() < opts.burstProbability;
    const burstEnd = inBurst
      ? Math.min(i + opts.burstLength, text.length)
      : i + 1;

    const chunk = text.slice(i, burstEnd);
    i = burstEnd;

    if (inBurst) {
      // Burst: delay foarte mic între caractere
      await typeChunk(page, chunk, randInt(2, 8));
      await sleep(randInt(2, 8));
    } else {
      // Delay normal între caractere
      await typeChunk(page, chunk, randInt(opts.minDelay, opts.maxDelay));
    }

    // Pauză după punctuație
    const lastChar = text[i - 1];
    if (lastChar && /[.!?,;:]/.test(lastChar)) {
      await sleep(opts.punctuationPause + randInt(0, 100));
    }

    // Pauză ocazională mai lungă (ca și cum te gândești)
    if (Math.random() < 0.05) {
      await sleep(randInt(200, 500));
    }
  }
}

/** Ultima poziție cunoscută a cursorului (Playwright nu o expune). */
let mousePos: { x: number; y: number } | null = null;

/** Poziție aleatorie în interiorul unui element, sau null dacă nu are casetă. */
async function randomPointIn(
  page: Page,
  target: string | Locator
): Promise<{ x: number; y: number } | null> {
  const el =
    typeof target === 'string' ? page.locator(target).first() : target.first();
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch {
    /* elementul poate fi deja vizibil — continuăm oricum */
  }
  const box = await el.boundingBox();
  if (!box) return null;
  return {
    x: box.x + box.width * (0.3 + Math.random() * 0.4),
    y: box.y + box.height * (0.3 + Math.random() * 0.4)
  };
}

/**
 * Mișcă mouse-ul în 2-4 pași scurți, pornind din poziția curentă a cursorului
 * (nu din colțul ecranului — altfel prima mișcare ar fi un salt vizibil).
 */
async function moveMouseInSteps(page: Page, x: number, y: number): Promise<void> {
  const from = mousePos;
  if (!from) {
    await page.mouse.move(x, y);
    mousePos = { x, y };
    return;
  }
  const steps = randInt(2, 4);
  for (let i = 1; i <= steps; i++) {
    const stepX = from.x + (x - from.x) * (i / steps);
    const stepY = from.y + (y - from.y) * (i / steps);
    await page.mouse.move(stepX, stepY);
    mousePos = { x: stepX, y: stepY };
    await sleep(randInt(5, 20));
  }
}

/**
 * Mișcă mouse-ul ușor înainte de a da click (anti-detect).
 * `target`: selector CSS (string) sau un Locator existent.
 */
export async function humanMoveToElement(
  page: Page,
  target: string | Locator
): Promise<void> {
  try {
    const point = await randomPointIn(page, target);
    if (!point) return;
    await moveMouseInSteps(page, point.x, point.y);
  } catch (e: any) {
    log('humanMoveToElement failed: ' + (e?.message ?? String(e)));
    // Fallback: click direct (fără mișcare de mouse)
  }
}

/**
 * v2.0.6: click „uman” — mișcare în pași, `mouse.down()`, o pauză scurtă de
 * 50-150ms cât butonul e apăsat, apoi `mouse.up()`. Întoarce `false` dacă
 * elementul nu are casetă (absent/ascuns), ca apelantul să poată face fallback
 * la click-ul normal al Playwright.
 */
export async function humanClick(
  page: Page,
  target: string | Locator
): Promise<boolean> {
  try {
    const point = await randomPointIn(page, target);
    if (!point) return false;
    await moveMouseInSteps(page, point.x, point.y);
    await page.mouse.down();
    await sleep(randInt(50, 150));
    await page.mouse.up();
    return true;
  } catch (e: any) {
    log('humanClick failed: ' + (e?.message ?? String(e)));
    return false;
  }
}

/** v2.0.6: click cu fallback — folosit de provideri în locul lui `.click()`. */
export async function humanClickButton(
  page: Page,
  target: Locator,
  timeoutMs = 2000
): Promise<void> {
  if (humanBehaviorEnabled() && (await humanClick(page, target))) return;
  await target.click({ timeout: timeoutMs });
}

/**
 * Scroll ușor aleatoriu (ca și cum utilizatorul verifică pagina).
 */
export async function humanScroll(page: Page): Promise<void> {
  try {
    const scrollY = randInt(-50, 100);
    await page.evaluate((delta) => {
      window.scrollBy({ top: delta, behavior: 'smooth' });
    }, scrollY);
    await sleep(randInt(100, 300));
  } catch {
    /* ignore */
  }
}

/* ---------------- setări (require lazy de vscode — teste Node safe) ---------------- */

export interface HumanSettings {
  /** Tastare "umană" caracter-cu-caracter (freekit.humanTyping). */
  typing: boolean;
  /** Mouse/scroll "uman" înainte de acțiuni (freekit.humanBehavior). */
  behavior: boolean;
  /** Final de generare instant via MutationObserver (freekit.mutationObserver). */
  observer: boolean;
}

// v0.8.1: observer = false (Chrome offscreen suspendă JS-ul → MutationObserver flaky;
// polling-ul clasic la 500ms e fiabil — vezi base.ts).
const DEFAULT_SETTINGS: HumanSettings = { typing: true, behavior: true, observer: false };

export function humanSettings(): HumanSettings {
  try {
    const v = require('vscode') as typeof vscode;
    const cfg = v.workspace.getConfiguration('freekit');
    return {
      typing: cfg.get<boolean>('humanTyping', true),
      behavior: cfg.get<boolean>('humanBehavior', true),
      observer: cfg.get<boolean>('mutationObserver', false)
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const humanTypingEnabled = (): boolean => humanSettings().typing;
export const humanBehaviorEnabled = (): boolean => humanSettings().behavior;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
