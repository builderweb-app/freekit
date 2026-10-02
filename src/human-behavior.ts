import { Locator, Page } from 'playwright';
// IMPORTANT: `vscode` doar ca TIP — la runtime require-ul e lazy (teste Node safe).
import type * as vscode from 'vscode';
import { logLine } from './log';

const log = (msg: string) => logLine('human', msg);

/* =========================================================================
 * v0.8.0 — HUMAN BEHAVIOR (anti-detect)
 *
 * Tastare caracter-cu-caracter cu întârzieri aleatorii, pauze la punctuație
 * și burst-uri rapide ocazionale + mișcări mici de mouse și scroll înainte
 * de acțiuni. Feature-urile sunt configurabile din setări:
 *   freekit.humanTyping   (implicit true) — tastarea "umană"
 *   freekit.humanBehavior (implicit true) — mouse/scroll
 * ========================================================================= */

export interface HumanTypingOptions {
  minDelay: number;          // ms între caractere (default 15)
  maxDelay: number;          // ms (default 50)
  punctuationPause: number;  // ms după . ! ? , (default 150)
  burstProbability: number;  // 0-1, șansa de "burst" rapid (default 0.15)
  burstLength: number;       // caractere consecutive rapide (default 8)
}

const DEFAULT_OPTIONS: HumanTypingOptions = {
  minDelay: 15,
  maxDelay: 50,
  punctuationPause: 150,
  burstProbability: 0.15,
  burstLength: 8
};

/**
 * Tastează text ca un om: delay aleatoriu, pauze la punctuație, burst-uri ocazionale.
 * `signal` (opțional): la anulare aruncă '__ABORTED__' — ca restul fluxului.
 */
export async function humanType(
  page: Page,
  text: string,
  options: Partial<HumanTypingOptions> = {},
  signal?: AbortSignal
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  log('typing ' + text.length + ' chars with human delay');

  let i = 0;
  while (i < text.length) {
    if (signal?.aborted) throw new Error('__ABORTED__');

    // Verifică dacă suntem într-un burst rapid
    const inBurst = Math.random() < opts.burstProbability;
    const burstEnd = inBurst
      ? Math.min(i + opts.burstLength, text.length)
      : i + 1;

    // Tastează caracter cu caracter
    for (; i < burstEnd; i++) {
      if (signal?.aborted) throw new Error('__ABORTED__');
      const char = text[i];
      await page.keyboard.insertText(char);

      if (inBurst) {
        // Burst: delay foarte mic
        await sleep(randInt(2, 8));
      } else {
        // Delay normal
        await sleep(randInt(opts.minDelay, opts.maxDelay));
      }
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

  log('typing finished');
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
    const el =
      typeof target === 'string' ? page.locator(target).first() : target.first();
    const box = await el.boundingBox();
    if (!box) return;

    // Poziție aleatorie în interiorul elementului
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);

    // Mișcare în 2-3 pași
    const steps = randInt(2, 4);
    for (let i = 1; i <= steps; i++) {
      const stepX = x * (i / steps);
      const stepY = y * (i / steps);
      await page.mouse.move(stepX, stepY);
      await sleep(randInt(5, 20));
    }
  } catch (e: any) {
    log('humanMoveToElement failed: ' + (e?.message ?? String(e)));
    // Fallback: click direct (fără mișcare de mouse)
  }
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
