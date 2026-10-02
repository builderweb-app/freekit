import { Page } from 'playwright';
import { logLine } from './log';

const log = (msg: string) => logLine('mutation', msg);

/* =========================================================================
 * v0.8.0 — MUTATIONOBSERVER (final de generare detectat instant)
 *
 * Vechea așteptare verifica textul la fiecare 500ms (polling fix — consumă
 * CPU). Acum un MutationObserver rulează ÎN PAGINĂ și ține minte momentul
 * ultimei schimbări din DOM; "liniștea" (quietMs fără mutații) încheie pasul
 * de așteptare imediat. Cât timp stream-ul lucrează (mutații continue),
 * pasul e limitat la maxWaitMs, ca progresul, checkpoint-urile de reparare
 * a selectorilor și retrimiterea Enter să funcționeze neschimbate.
 * ========================================================================= */

/** Rulează ÎN PAGINĂ (serializat): instalează (o dată) tracker-ul de mutații. */
const installTrackerInPage = (reset: boolean): boolean => {
  const w = window as any;
  let t = w.__freekitTracker;
  if (!t || !t.observer) {
    t = { lastMutation: Date.now() };
    try {
      const obs = new MutationObserver(() => {
        t.lastMutation = Date.now();
      });
      obs.observe(document.body || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true
      });
      t.observer = obs;
    } catch {
      /* fără MutationObserver rămâne doar fallback-ul pe timp */
    }
    w.__freekitTracker = t;
  }
  if (reset) t.lastMutation = Date.now();
  return !!t.observer;
};

/**
 * Instalează (idempotent) tracker-ul de mutații și resetează ceasul de
 * "liniște". Returnează false dacă pagina nu are MutationObserver sau
 * evaluarea a eșuat (atunci se folosește polling-ul clasic).
 */
export async function installMutationTracker(page: Page): Promise<boolean> {
  try {
    const ok = await page.evaluate(installTrackerInPage, true);
    log('tracker de mutații ' + (ok ? 'instalat (reset)' : 'indisponibil — fallback pe timp'));
    return ok;
  } catch (e: any) {
    log('installMutationTracker a eșuat: ' + (e?.message ?? String(e)));
    return false;
  }
}

/** Rulează ÎN PAGINĂ: pagina a fost liniștită `quietMs`? */
const waitQuietInPage = (quietMs: number): boolean => {
  const t = (window as any).__freekitTracker;
  return !!t && Date.now() - t.lastMutation >= quietMs;
};

export interface WaitStepOptions {
  /** Cât timp fără mutații = "liniște" (implicit 900ms). */
  quietMs?: number;
  /** Cât așteptăm MAXIM un pas, cât timp stream-ul lucrează (implicit 2500ms). */
  maxWaitMs?: number;
  /** Promisiune unică (per trimitere) care se rezolvă la anulare — waitForAbort. */
  abort?: Promise<'aborted'>;
}

/**
 * Un "pas" de așteptare înaintea fiecărei verificări:
 *   - 'quiet'   = pagina a fost liniștită quietMs (generarea probabil s-a terminat);
 *   - 'timeout' = încă se întâmplă mutații (stream activ) — verificăm oricum.
 * La anulare aruncă '__ABORTED__'.
 */
export async function waitStep(
  page: Page,
  opts: WaitStepOptions = {}
): Promise<'quiet' | 'timeout'> {
  const quietMs = opts.quietMs ?? 900;
  const maxWaitMs = opts.maxWaitMs ?? 2500;
  const quiet: Promise<'quiet' | 'timeout'> = page
    .waitForFunction(waitQuietInPage, quietMs, { polling: 100, timeout: maxWaitMs })
    .then(() => 'quiet' as const)
    .catch(() => 'timeout' as const);
  if (!opts.abort) return quiet;
  const winner = await Promise.race([quiet, opts.abort]);
  if (winner === 'aborted') throw new Error('__ABORTED__');
  return winner as 'quiet' | 'timeout';
}

/** Promisiune unică per trimitere: se rezolvă când `signal` este anulat. */
export function waitForAbort(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}
