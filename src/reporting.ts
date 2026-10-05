import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { Page } from 'playwright';
import { logLine } from './log';
import { BrowserManager } from './browser';
import { SLOTS, SlotName, anySelectorPresent, healSlot, selectors } from './selectors';
import { captureCleanDom } from './ai-selector-finder';
// v2.5.11 (bug #34): logica pură (URL + clasificare rapoarte) trăiește în
// selectorHealth.ts, fără `vscode`/Playwright, ca să poată fi testată izolat.
import {
  HealthSlot,
  ReportPayload,
  SlotProbe,
  buildProbeReports,
  isAppPage,
  normalizeHost,
  waitForAny
} from './selectorHealth';

export type { FailureType, ReportPayload } from './selectorHealth';
export { normalizeHost };

const log = (msg: string) => logLine('reporting', msg);

/* =========================================================================
 * v2.4.0 — FREEKIT REPORTING SERVER (self-maintaining integration)
 *
 * Extensia vorbește cu serverul de raportare (implicit api.builderweb.app):
 *   1) înregistrare o singură dată  → apiKey (globalState), idempotent;
 *   2) health check periodic        → verifică selectorii pe tab-urile deja
 *      deschise, repară local (fingerprint + AI) și, dacă tot eșuează,
 *      trimite un raport către server;
 *   3) fetch periodic de selectori   → aplică ce a învățat serverul din
 *      raportările celorlalți clienți.
 *
 * Toate operațiile sunt best-effort: nicio eroare de rețea nu afectează
 * funcționarea normală a extensiei.
 * ========================================================================= */

const KEYS = {
  installationId: 'freekit.reporting.installationId',
  apiKey: 'freekit.reporting.apiKey',
  lastSelectorsRevision: 'freekit.reporting.lastSelectorsRevision',
  lastHealthCheck: 'freekit.reporting.lastHealthCheck',
  lastSelectorFetch: 'freekit.reporting.lastSelectorFetch'
};

export const DEFAULT_ENDPOINT = 'https://api.builderweb.app';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_HOURS = 6;
const DEFAULT_SELECTORS_HOURS = 24;
const MAX_DOM_SNAPSHOT_CHARS = 12_000;
/** Sloturile verificate de health check (response e dependent de conținut,
 *  stopButton există doar în timpul generării → nu au sens aici). */
const HEALTH_SLOTS: HealthSlot[] = ['input', 'newChat'];

/** v2.5.11 (bug #34): cât așteptăm SPA-ul să randeze input-ul înainte de raport. */
const HEALTH_WAIT_MS = 5000;
/** v2.5.11 (bug #34): timeout pentru navigarea la pagina aplicației. */
const APP_NAV_TIMEOUT_MS = 10_000;

export interface AppliedSelector {
  provider: string;
  slot: SlotName;
  selector: string;
}

/* ---------------- helpers ---------------- */

function cfg() {
  return vscode.workspace.getConfiguration('freekit');
}

function clampHours(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 24 * 30) return fallback;
  return n;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function hostOfUrl(url: string): string {
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return normalizeHost(url);
  }
}

/** URL-ul paginii, fără excepție dacă pagina e în tranziție. */
function pageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/** Tab-urile deja deschise în Chrome (CDP /json) — fără a porni browserul. */
async function openTabHosts(port: number): Promise<Set<string>> {
  const hosts = new Set<string>();
  try {
    const res = await request('http://127.0.0.1:' + port + '/json', {}, 3000);
    if (!res.ok) return hosts;
    const tabs = (await res.json()) as Array<{ url?: string }>;
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const host = hostOfUrl(String(tab?.url || ''));
      if (host) hosts.add(host);
    }
  } catch {
    /* CDP indisponibil — health check-ul se sare peste */
  }
  return hosts;
}

/* ---------------- aplicarea selectorilor veniți de la server ---------------- */

function pickSelector(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = pickSelector(item);
      if (s) return s;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return pickSelector(o.selector ?? o.value ?? o.css ?? o.primary);
  }
  return null;
}

/** Extrage perechile (slot, selector) dintr-o intrare a serverului. */
function slotsFromEntry(entry: Record<string, any>): Array<{ slot: SlotName; selector: string }> {
  const out: Array<{ slot: SlotName; selector: string }> = [];
  const direct = pickSelector(entry.selector ?? entry.value ?? entry.css);
  if (direct && SLOTS.includes(entry.slot)) {
    out.push({ slot: entry.slot as SlotName, selector: direct });
  }
  const map =
    entry.selectors && typeof entry.selectors === 'object' && !Array.isArray(entry.selectors)
      ? (entry.selectors as Record<string, unknown>)
      : (entry as Record<string, unknown>);
  for (const slot of SLOTS) {
    if (out.some((o) => o.slot === slot)) continue;
    const sel = pickSelector(map?.[slot]);
    if (sel) out.push({ slot, selector: sel });
  }
  return out;
}

function providerForDomain(domain: string): string | null {
  const d = normalizeHost(domain);
  if (!d) return null;
  for (const pid of selectors.info().providers) {
    const h = normalizeHost(selectorUrl(pid));
    if (!h) continue;
    if (h === d || h.endsWith('.' + d) || d.endsWith('.' + h)) return pid;
  }
  return null;
}

function selectorUrl(providerId: string): string {
  try {
    return selectors.url(providerId);
  } catch {
    return '';
  }
}

/**
 * Aplică lista de selectori primită de la server (best-effort).
 * Acceptă atât intrări `{ domain, slot, selector }`, cât și `{ domain, input,
 * response, newChat, stopButton }` sau `{ provider, selectors: {...} }`.
 * Validarea (fragil/blacklist/UI chrome) rămâne în `selectors.learn()`.
 */
export function applyServerSelectors(list: unknown): AppliedSelector[] {
  const applied: AppliedSelector[] = [];
  if (!Array.isArray(list) || !list.length) return applied;
  const known = selectors.info().providers;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, any>;
    let pid: string | null =
      typeof entry.provider === 'string' && known.includes(entry.provider)
        ? entry.provider
        : null;
    const domain =
      typeof entry.domain === 'string'
        ? entry.domain
        : typeof entry.host === 'string'
          ? entry.host
          : '';
    if (!pid && domain) pid = providerForDomain(domain);
    if (!pid) {
      log('selectors: server entry ignored — unknown domain "' + domain + '"');
      continue;
    }
    for (const { slot, selector } of slotsFromEntry(entry)) {
      if (selectors.learn(pid, slot, selector, 'server')) {
        applied.push({ provider: pid, slot, selector });
      }
    }
  }
  if (applied.length) {
    log(
      'selectors: applied ' +
        applied.length +
        ' server update(s): ' +
        applied.map((a) => a.provider + '.' + a.slot).join(', ')
    );
  }
  return applied;
}

/* ---------------- health check ---------------- */

async function selectorUsable(page: Page, selector: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    return await loc.isVisible();
  } catch {
    return false;
  }
}

async function anyUsable(page: Page, sels: string[]): Promise<boolean> {
  for (const sel of sels) {
    if (await selectorUsable(page, sel)) return true;
  }
  return false;
}

/**
 * Verifică selectorii unui provider pe pagina dată: dacă sloturile critice nu
 * se rezolvă, încearcă repararea locală (fingerprint + AI) și, dacă nici așa
 * nu există un selector funcțional, întoarce rapoartele de trimis la server.
 *
 * v2.5.11 (bug #34): `waitMs` = cât așteptăm SPA-ul să randeze (echivalentul
 * `page.waitForSelector`), iar clasificarea trece prin `buildProbeReports`:
 * dacă NICIUN slot critic nu există în DOM → un singur `wrong_page`, nu două
 * rapoarte `not_found`.
 */
export async function probeProviderSelectors(
  page: Page,
  providerId: string,
  opts: { shareDomSnapshot?: boolean; waitMs?: number } = {}
): Promise<ReportPayload[]> {
  const url = pageUrl(page);
  const domain = hostOfUrl(url);
  let snapshot: string | undefined;
  let snapshotTaken = false;
  const snapshotOnce = async (): Promise<string | undefined> => {
    if (!opts.shareDomSnapshot) return undefined;
    if (!snapshotTaken) {
      snapshotTaken = true;
      try {
        snapshot = (await captureCleanDom(page)).slice(0, MAX_DOM_SNAPSHOT_CHARS);
      } catch (e: any) {
        log('dom snapshot failed: ' + (e?.message ?? String(e)));
      }
    }
    return snapshot;
  };

  const probes: SlotProbe[] = [];
  for (const slot of HEALTH_SLOTS) {
    const sels = selectors.candidates(providerId, slot);
    if (!sels.length) continue;

    // v2.5.11 (bug #34): SPA-ul poate avea nevoie de câteva secunde — nu
    // declarăm slotul lipsă cât timp pagina se încarcă.
    if (await waitForAny(() => anyUsable(page, sels), opts.waitMs ?? 0)) {
      probes.push({ slot, candidates: sels, usable: true, present: true });
      continue;
    }

    // auto-heal local: exact aceeași cale ca la rularea normală
    let healed: string | null = null;
    try {
      healed = await healSlot(page, providerId, slot);
    } catch (e: any) {
      log('heal failed (' + providerId + '.' + slot + '): ' + (e?.message ?? String(e)));
    }
    if (healed && (await selectorUsable(page, healed))) {
      probes.push({ slot, candidates: sels, usable: true, present: true, healed });
      continue;
    }

    probes.push({
      slot,
      candidates: sels,
      usable: false,
      present: await anySelectorPresent(page, sels),
      healed
    });
  }

  const reports = buildProbeReports({ domain, providerId, url, slots: probes });
  for (const r of reports) {
    // v2.5.11 (bug #34): snapshot-ul se atașează doar rapoartelor per-slot — un
    // snapshot de pe o pagină non-app (`wrong_page`) nu are ce învăța serverul.
    if (r.failureType !== 'wrong_page') r.domSnapshot = await snapshotOnce();
  }
  return reports;
}

export interface HealthCheckOutcome {
  checkedProviders: string[];
  failures: ReportPayload[];
}

/* ---------------- clientul de raportare ---------------- */

export class ReportingClient {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** URL-ul serverului (freekit.reporting.endpoint). */
  get endpoint(): string {
    return String(
      cfg().get<string>('reporting.endpoint', DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT
    ).replace(/\/+$/, '');
  }

  get enabled(): boolean {
    return cfg().get<boolean>('reporting.enabled', true);
  }

  get shareDomSnapshot(): boolean {
    return cfg().get<boolean>('reporting.shareDomSnapshot', false);
  }

  get healthCheckEnabled(): boolean {
    return cfg().get<boolean>('reporting.healthCheck', true);
  }

  get healthCheckIntervalMs(): number {
    const hours = clampHours(
      cfg().get<number>('reporting.healthCheckIntervalHours', DEFAULT_HEALTH_HOURS),
      DEFAULT_HEALTH_HOURS
    );
    return hours * 60 * 60 * 1000;
  }

  get selectorsIntervalMs(): number {
    const hours = clampHours(
      cfg().get<number>('reporting.selectorsIntervalHours', DEFAULT_SELECTORS_HOURS),
      DEFAULT_SELECTORS_HOURS
    );
    return hours * 60 * 60 * 1000;
  }

  get hasApiKey(): boolean {
    return !!this.ctx.globalState.get<string>(KEYS.apiKey);
  }

  get installationIdValue(): string | undefined {
    return this.ctx.globalState.get<string>(KEYS.installationId);
  }

  get lastHealthCheckAt(): number {
    return this.ctx.globalState.get<number>(KEYS.lastHealthCheck, 0);
  }

  get lastSelectorFetchAt(): number {
    return this.ctx.globalState.get<number>(KEYS.lastSelectorFetch, 0);
  }

  get selectorsRevision(): number {
    return this.ctx.globalState.get<number>(KEYS.lastSelectorsRevision, 0);
  }

  private async getOrCreateInstallationId(): Promise<string> {
    let id = this.ctx.globalState.get<string>(KEYS.installationId);
    if (!id) {
      id = crypto.randomUUID();
      await this.ctx.globalState.update(KEYS.installationId, id);
      log('created installationId');
    }
    return id;
  }

  /** Register cu serverul. Salvează apiKey. Idempotent. */
  async ensureRegistered(): Promise<string | null> {
    if (!this.enabled) return null;
    const apiKey = this.ctx.globalState.get<string>(KEYS.apiKey);
    if (apiKey) return apiKey;

    try {
      const installationId = await this.getOrCreateInstallationId();
      const version =
        vscode.extensions.getExtension('builderweb.freekit')?.packageJSON.version ??
        this.ctx.extension.packageJSON.version;
      const res = await request(`${this.endpoint}/api/v1/extensions/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId, name: vscode.env.appName, version })
      });
      if (!res.ok) {
        log(`register failed: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { apiKey: string; extensionId: string; rotated?: boolean };
      if (!data?.apiKey) {
        log('register failed: response has no apiKey');
        return null;
      }
      await this.ctx.globalState.update(KEYS.apiKey, data.apiKey);
      log(`registered: extensionId=${data.extensionId}${data.rotated ? ' (rotated)' : ''}`);
      return data.apiKey;
    } catch (e: any) {
      log(`register error: ${e.message}`);
      return null;
    }
  }

  /** Șterge identitatea locală (apiKey + installationId) → re-înregistrare. */
  async resetIdentity(): Promise<void> {
    await this.ctx.globalState.update(KEYS.apiKey, undefined);
    await this.ctx.globalState.update(KEYS.installationId, undefined);
    log('identity reset (apiKey + installationId removed)');
  }

  /** Trimite un raport pentru selector stricat. Best-effort. */
  async report(payload: ReportPayload): Promise<void> {
    if (!this.enabled) return;
    const apiKey = await this.ensureRegistered();
    if (!apiKey) return;

    try {
      const body: any = {
        reports: [
          {
            domain: payload.domain,
            selector: payload.selector,
            failureType: payload.failureType,
            message: payload.message,
            url: payload.url,
            // v2.5.11 (bug #34): sloturile vizate (opționale — serverele vechi
            // le ignoră; `undefined` dispare la JSON.stringify)
            slot: payload.slot,
            slots: payload.slots
          }
        ]
      };
      if (payload.domSnapshot) body.reports[0].domSnapshot = payload.domSnapshot;
      const res = await request(`${this.endpoint}/api/v1/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-freekit-key': apiKey
        },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        log(`reported: ${JSON.stringify(data).slice(0, 120)}`);
      } else {
        log(`report failed: ${res.status}`);
      }
    } catch (e: any) {
      log(`report error: ${e.message}`);
    }
  }

  /**
   * Fetch selectori noi de la server (max 1× per intervală, implicit 24h).
   * Returnează lista nouă sau null.
   */
  async fetchUpdatedSelectors(force = false): Promise<any[] | null> {
    if (!this.enabled) return null;
    const last = this.ctx.globalState.get<number>(KEYS.lastSelectorFetch, 0);
    if (!force && Date.now() - last < this.selectorsIntervalMs) return null;

    const apiKey = await this.ensureRegistered();
    if (!apiKey) return null;

    try {
      const since = this.ctx.globalState.get<number>(KEYS.lastSelectorsRevision, 0);
      const res = await request(`${this.endpoint}/api/v1/selectors?since=${since}`, {
        headers: { 'x-freekit-key': apiKey }
      });
      await this.ctx.globalState.update(KEYS.lastSelectorFetch, Date.now());
      if (res.status === 304) {
        log('selectors: up to date');
        return null;
      }
      if (!res.ok) {
        log(`selectors fetch failed: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { revision: number; count?: number; selectors: any[] };
      await this.ctx.globalState.update(KEYS.lastSelectorsRevision, data.revision);
      log(`selectors: fetched revision=${data.revision}, count=${data.selectors?.length ?? 0}`);
      return Array.isArray(data.selectors) ? data.selectors : null;
    } catch (e: any) {
      log(`selectors fetch error: ${e.message}`);
      return null;
    }
  }

  shouldHealthCheck(now = Date.now()): boolean {
    return now - this.lastHealthCheckAt >= this.healthCheckIntervalMs;
  }

  async markHealthCheck(now = Date.now()): Promise<void> {
    await this.ctx.globalState.update(KEYS.lastHealthCheck, now);
  }

  /** Text scurt despre starea integrării (pentru diagnostics / comandă). */
  statusText(): string {
    if (!this.enabled) return 'disabled (freekit.reporting.enabled = false)';
    const last = this.lastHealthCheckAt;
    return (
      (this.hasApiKey ? 'registered' : 'not registered yet') +
      ' | endpoint: ' +
      this.endpoint +
      ' | revision: ' +
      this.selectorsRevision +
      ' | last health check: ' +
      (last ? new Date(last).toLocaleString() : 'never') +
      ' | last selectors fetch: ' +
      (this.lastSelectorFetchAt ? new Date(this.lastSelectorFetchAt).toLocaleString() : 'never') +
      ' | DOM snapshot: ' +
      (this.shareDomSnapshot ? 'on' : 'off')
    );
  }
}

/* ---------------- serviciul periodic ---------------- */

export interface ReportingServiceOptions {
  browser: BrowserManager;
  /** Notificări în chat (ex: selectori noi aplicați) — best-effort. */
  notify?: (text: string) => void;
}

/**
 * Programează integrarea: înregistrare la pornire, health check la 6h și
 * fetch de selectori la 24h (intervalele sunt configurabile). Toate
 * operațiile sunt best-effort și nu blochează activarea extensiei.
 */
export class ReportingService {
  readonly client: ReportingClient;
  private readonly browser: BrowserManager;
  private readonly notify: (text: string) => void;
  private timers: NodeJS.Timeout[] = [];
  private disposed = false;
  private healthRunning = false;

  constructor(ctx: vscode.ExtensionContext, opts: ReportingServiceOptions) {
    this.client = new ReportingClient(ctx);
    this.browser = opts.browser;
    this.notify = opts.notify ?? (() => {});
  }

  start(): void {
    if (this.disposed) return;
    if (!this.client.enabled) {
      log('integration disabled by setting — not starting');
      return;
    }

    void this.client.ensureRegistered();

    if (this.client.healthCheckEnabled) {
      const healthMs = this.client.healthCheckIntervalMs;
      // prima verificare devreme, dar nu în timpul pornirii VS Code
      this.timers.push(setTimeout(() => void this.healthTick(), Math.min(healthMs, 3 * 60_000)));
      this.timers.push(setInterval(() => void this.healthTick(), healthMs));
    }

    const selMs = this.client.selectorsIntervalMs;
    this.timers.push(setTimeout(() => void this.selectorTick(), Math.min(selMs, 60_000)));
    this.timers.push(setInterval(() => void this.selectorTick(), selMs));
  }

  /** Descarcă (dacă e cazul) și aplică selectorii noi de la server. */
  async fetchSelectors(force = false): Promise<AppliedSelector[]> {
    if (this.disposed) return [];
    const list = await this.client.fetchUpdatedSelectors(force);
    if (!list || !list.length) return [];
    return applyServerSelectors(list);
  }

  /**
   * v2.5.11 (bug #34): aduce tab-ul pe pagina aplicației providerului înainte
   * de probă (timeout scurt). Eșecul duce la skip — nu la rapoarte false.
   */
  private async openAppPage(page: Page, appUrl: string): Promise<boolean> {
    if (!appUrl) return false;
    try {
      await page.goto(appUrl, {
        waitUntil: 'domcontentloaded',
        timeout: APP_NAV_TIMEOUT_MS
      });
      return true;
    } catch (e: any) {
      log('health: navigation to ' + appUrl + ' failed — ' + (e?.message ?? String(e)));
      return false;
    }
  }

  /**
   * Verifică selectorii pe tab-urile deja deschise: repară local și, dacă
   * reparația eșuează, trimite rapoartele către server.
   */
  async runHealthCheck(force = false): Promise<HealthCheckOutcome> {
    const outcome: HealthCheckOutcome = { checkedProviders: [], failures: [] };
    if (this.disposed || !this.client.enabled) return outcome;
    if (this.healthRunning) return outcome;
    if (!force && !this.client.shouldHealthCheck()) return outcome;

    this.healthRunning = true;
    try {
      await this.client.markHealthCheck();
      if (!(await this.browser.isRunning())) {
        log('health: browser is not running — skipped');
        return outcome;
      }
      const apiKey = await this.client.ensureRegistered();
      if (!apiKey) {
        log('health: not registered — skipped');
        return outcome;
      }
      const hosts = await openTabHosts(this.browser.options().port);
      if (!hosts.size) {
        log('health: no tab open — skipped');
        return outcome;
      }

      for (const pid of selectors.info().providers) {
        const appUrl = selectorUrl(pid);
        const host = normalizeHost(appUrl);
        if (!host || !hosts.has(host)) continue;

        let page: Page;
        try {
          page = await this.browser.ensureOpen(host);
        } catch (e: any) {
          log('health: could not open the page for ' + pid + ': ' + (e?.message ?? String(e)));
          continue;
        }
        // siguranță: nu verificăm un tab greșit (fals-pozitive)
        if (!page || normalizeHost(hostOfUrl(pageUrl(page))) !== host) continue;

        // v2.5.11 (bug #34): verifică PAGINA aplicației, nu doar hostul — un
        // tab pe landing / `/share/...` / eroare (același host) nu are niciun
        // element al aplicației și producea 2 rapoarte `not_found` false.
        // Excepție: alte rute valide ale aplicației (ex. Claude `/chat/<id>`,
        // care nu e `selectors.url`) — dacă input-ul e deja utilizabil acolo,
        // NU mutăm tab-ul utilizatorului.
        if (!isAppPage(pageUrl(page), appUrl)) {
          const inputSels = selectors.candidates(pid, 'input');
          const looksLikeApp =
            inputSels.length > 0 && (await anyUsable(page, inputSels));
          if (!looksLikeApp) {
            const moved = await this.openAppPage(page, appUrl);
            if (!moved || !isAppPage(pageUrl(page), appUrl)) {
              log(
                'health check: skipping ' + pid + ' — wrong page (' + pageUrl(page) + ')'
              );
              continue;
            }
          }
        }

        outcome.checkedProviders.push(pid);
        const found = await probeProviderSelectors(page, pid, {
          shareDomSnapshot: this.client.shareDomSnapshot,
          waitMs: HEALTH_WAIT_MS
        });
        for (const failure of found) {
          log('health: ' + pid + ' → ' + failure.failureType + ' (' + failure.selector + ')');
          outcome.failures.push(failure);
          await this.client.report(failure);
        }
      }
      log(
        'health check done — providers checked: ' +
          (outcome.checkedProviders.join(', ') || 'none') +
          ', failures: ' +
          outcome.failures.length
      );
      return outcome;
    } catch (e: any) {
      log('health check error: ' + (e?.message ?? String(e)));
      return outcome;
    } finally {
      this.healthRunning = false;
    }
  }

  private async healthTick(): Promise<void> {
    try {
      await this.runHealthCheck();
    } catch (e: any) {
      log('health tick error: ' + (e?.message ?? String(e)));
    }
  }

  private async selectorTick(): Promise<void> {
    try {
      const applied = await this.fetchSelectors();
      if (applied.length) {
        this.notify(
          '☁️ Freekit: ' +
            applied.length +
            ' selector fix(es) received from the server (' +
            applied.map((a) => a.provider + '.' + a.slot).join(', ') +
            ').'
        );
      }
    } catch (e: any) {
      log('selector tick error: ' + (e?.message ?? String(e)));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers = [];
  }
}
