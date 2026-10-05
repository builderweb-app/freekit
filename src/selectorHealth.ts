/**
 * v2.5.11 (bug #34): logica PURĂ a health check-ului de selectoare — separată
 * de Playwright / vscode ca să poată fi testată izolat (vezi test-health-check).
 *
 * Problema raportată de telemetrie: pe un tab aflat pe altă pagină de sub
 * hostul providerului (landing, `/share/…`, eroare) DOM-ul nu conține niciun
 * element al aplicației, iar check-ul trimitea DOUĂ rapoarte `not_found` false
 * (input + newChat). Acum:
 *   - se verifică URL-ul aplicației (host + path), nu doar hostul;
 *   - dacă niciun slot critic nu există în DOM → UN singur raport `wrong_page`,
 *     nu câte unul pe slot.
 *
 * Modulul NU importă `vscode` și NU atinge DOM-ul — doar compară URL-uri și
 * transformă rezultatele probelor în rapoarte.
 */

/** Sloturile verificate de health check (response e dependent de conținut). */
export type HealthSlot = 'input' | 'newChat';

export type FailureType =
  | 'not_found'
  | 'ambiguous'
  | 'hidden'
  | 'stale'
  | 'detached'
  | 'timeout'
  /** v2.5.11 (bug #34): DOM-ul nu conține niciun element al aplicației. */
  | 'wrong_page'
  | 'other';

export interface ReportPayload {
  /** Domeniul providerului, ex: 'chat.deepseek.com'. */
  domain: string;
  /** Selectorul care a eșuat (sau markerul de grup pentru `wrong_page`). */
  selector: string;
  failureType: FailureType;
  message?: string;
  url?: string;
  /** Snapshot DOM curățat — inclus doar cu `freekit.reporting.shareDomSnapshot`. */
  domSnapshot?: string;
  /** v2.5.11 (bug #34): slotul vizat, când raportul e per-slot. */
  slot?: HealthSlot;
  /** v2.5.11 (bug #34): sloturile vizate de un raport agregat (`wrong_page`). */
  slots?: HealthSlot[];
}

/** Rezultatul probei unui slot (fără DOM — vezi `buildProbeReports`). */
export interface SlotProbe {
  slot: HealthSlot;
  candidates: string[];
  /** Cel puțin un candidat e utilizabil (există și e vizibil). */
  usable: boolean;
  /** Cel puțin un candidat există în DOM (chiar dacă e ascuns). */
  present: boolean;
  /** Selectorul propus de heal-ul local, dacă a fost cazul. */
  healed?: string | null;
}

/** Host normalizat (fără protocol/port/path, fără „www.”) — pentru mapare. */
export function normalizeHost(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\/\//, '')
    .replace(/[\/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

function trimTrailingSlash(pathname: string): string {
  return String(pathname || '').replace(/\/+$/, '');
}

/**
 * `true` dacă `currentUrl` e pagina aplicației providerului (`appUrl`):
 * același host ȘI același path (sau un sub-path al lui, ex. `/app/<id>`).
 * Rădăcina (`/`) e acceptată când `appUrl` e chiar rădăcina (ex. DeepSeek).
 */
export function isAppPage(currentUrl: string, appUrl: string): boolean {
  if (!currentUrl || !appUrl) return false;
  try {
    const cur = new URL(currentUrl);
    const app = new URL(appUrl);
    if (normalizeHost(cur.host) !== normalizeHost(app.host)) return false;
    const appPath = trimTrailingSlash(app.pathname);
    const curPath = trimTrailingSlash(cur.pathname);
    if (appPath === '') return true; // provider cu aplicația pe rădăcină
    return curPath === appPath || curPath.startsWith(appPath + '/');
  } catch {
    return false;
  }
}

/**
 * Așteaptă ca `check` să întoarcă `true`, până la `timeoutMs` (poll `stepMs`).
 * Echivalentul `page.waitForSelector`-ului, dar injectabil (testabil).
 */
export async function waitForAny(
  check: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 250
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * Transformă probele în rapoarte:
 *   - toate sloturile OK → niciun raport;
 *   - NICIUN slot critic prezent în DOM → UN singur `wrong_page` (pagina nu e
 *     aplicația: landing / share / eroare / SPA nedesenată), nu 2 × not_found;
 *   - altfel → câte un raport per slot (`hidden` dacă elementul există dar nu
 *     e utilizabil, `not_found` dacă nu există deloc).
 */
export function buildProbeReports(args: {
  domain: string;
  providerId: string;
  url: string;
  slots: SlotProbe[];
}): ReportPayload[] {
  const failed = args.slots.filter((s) => !s.usable);
  if (!failed.length) return [];

  if (failed.length > 1 && failed.every((s) => !s.present)) {
    return [
      {
        domain: args.domain,
        selector: 'input + newChat',
        failureType: 'wrong_page',
        slots: failed.map((s) => s.slot),
        message:
          'health check: neither critical slot exists in the DOM (' +
          args.providerId +
          ') — wrong page or the app did not render. tried: ' +
          failed
            .map((s) => s.slot + ' [' + s.candidates.join(', ') + ']')
            .join('; '),
        url: args.url
      }
    ];
  }

  return failed.map((s) => ({
    domain: args.domain,
    selector: s.candidates[0] ?? '',
    failureType: (s.present ? 'hidden' : 'not_found') as FailureType,
    slot: s.slot,
    message:
      'health check: no working selector for ' +
      args.providerId +
      '.' +
      s.slot +
      ' (tried: ' +
      s.candidates.join(', ') +
      ')' +
      (s.healed ? '; local heal proposed: ' + s.healed : '; local heal found nothing'),
    url: args.url
  }));
}
