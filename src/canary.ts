import type * as vscode from 'vscode';
import type { Page } from 'playwright';
// `BrowserManager` e folosit doar ca tip — importul e elidat, ca modulul să
// rămână încărcabil în testele Node (fără VS Code / Playwright).
import type { BrowserManager } from './browser';
import { logLine } from './log';
import {
  ProviderConfig,
  SelectorConfig,
  SlotConfig,
  SlotName,
  healSlot,
  selectors,
  selectorsUrlFromSettings
} from './selectors';
import { isAppPage, normalizeHost } from './selectorHealth';
import { fetchRemoteSelectorsText, parseRemoteConfig } from './remoteSelectors';

const log = (msg: string) => logLine('canary', msg);

/* =========================================================================
 * v2.9.0 — CANARY HEALTH CHECK + HIVE-MIND PUBLISHING
 *
 * Problema: selectorii se strică des și aflăm prea târziu (health check-ul din
 * reporting.ts verifică doar tab-urile deja deschise, iar reparațiile AI rămân
 * pe mașina care le-a descoperit).
 *
 * Canary-ul rulează în fundal, la un interval configurabil (implicit 6h):
 *   1) deschide UN tab dedicat în profilul Freekit (chat-ul în lucru nu e
 *      atins) și navighează pe pagina fiecărui provider din selectors.json;
 *   2) verifică `input`, `newChat` și `response` (doar citire — nu trimite
 *      mesaje);
 *   3) slotul lipsă → healer local (fingerprint) → AI Finder;
 *   4) reparația care vine de la AI Finder e publicată automat în Gist-ul
 *      configurat (`freekit.selectorsUrl`), ca să ajungă la toți clienții.
 *
 * SIGURANȚĂ (de ce nu se publică orice):
 *   - Chrome nu e pornit niciodată de canary — dacă nu rulează, check-ul se sare;
 *   - un provider aflat pe altă pagină (login / landing / eroare) sau fără
 *     NICIUN slot critic în DOM e SĂRIT complet — nu se repară și nu se
 *     publică nimic pentru el (altfel AI Finder ar „inventa" selectori pe
 *     pagina de login și i-ar trimite tuturor);
 *   - `response` se verifică doar când pagina chiar conține o conversație
 *     (selectorul e dependent de conținut — un chat gol ar părea „stricat");
 *   - se publică exclusiv reparația salvată de AI Finder (`how='ai'`), nu
 *     ghicirile healer-ului și nu selectorii user-locked;
 *   - Gist-ul e re-citit și re-validat înainte de PATCH; dacă nu poate fi
 *     citit sau conținutul lui nu e valid, publicarea e abandonată (nu se
 *     suprascrie un fișier bun cu unul ghicit).
 * ========================================================================= */

export const CANARY_SLOTS: SlotName[] = ['input', 'newChat', 'response'];
export const DEFAULT_CANARY_HOURS = 6;
/** Cheia din SecretStorage pentru tokenul GitHub (scope „gist"). */
export const GIST_TOKEN_KEY = 'freekit.canary.gistToken';

const LAST_RUN_KEY = 'freekit.canary.lastRun';
const NAV_TIMEOUT_MS = 20_000;
const RENDER_WAIT_MS = 8_000;
const POLL_MS = 400;
const GIST_PATCH_TIMEOUT_MS = 15_000;
const GIST_FILE = 'selectors.json';
/** Un text mai scurt de atât nu poate fi o conversație (e chrome de UI). */
const CONVERSATION_MIN_CHARS = 80;

/**
 * Markeri de conversație INDEPENDENȚI de selectorii testați — dacă am folosi
 * chiar `selectors.candidates(provider, 'response')`, un selector stricat ar
 * ascunde și dovada că există o conversație.
 */
const CONVERSATION_MARKERS = [
  '[data-message-author-role]',
  '[data-testid="assistant-message"]',
  '[data-testid="user-message"]',
  'model-response',
  'user-query',
  '.ds-assistant-message-main-content',
  '[class*="assistant-message"]',
  '[class*="user-message"]'
];

/* ---------------- tipuri ---------------- */

export type CanarySlotStatus = 'ok' | 'healed' | 'broken' | 'skipped';

export interface CanarySlotOutcome {
  slot: SlotName;
  status: CanarySlotStatus;
  /** Selectorul care a funcționat sau cel propus de reparație. */
  selector?: string;
  /** Cine a reparat slotul: healer-ul local sau AI Finder. */
  fixedBy?: 'healer' | 'ai';
  /** true doar când reparația a ajuns în Gist-ul remote. */
  published?: boolean;
  reason?: string;
}

export interface CanaryProviderOutcome {
  provider: string;
  url: string;
  /** Setat când providerul a fost sărit complet (fără verificări, fără publicare). */
  skipped?: string;
  slots: CanarySlotOutcome[];
}

export interface CanaryOutcome {
  startedAt: number;
  durationMs: number;
  providers: CanaryProviderOutcome[];
  healed: number;
  broken: number;
  published: number;
  /** Motivul pentru care rularea întreagă a fost sărită. */
  skipped?: string;
}

export interface CanaryFix {
  provider: string;
  slot: SlotName;
  selector: string;
}

export interface CanaryPublishResult {
  ok: boolean;
  reason?: string;
  version?: string;
  published: CanaryFix[];
}

export interface GistTarget {
  id: string;
  file: string;
}

/* ---------------- configurare ---------------- */

function cfg() {
  // require lazy — în testele Node modulul 'vscode' lipsește
  const v = require('vscode') as typeof import('vscode');
  return v.workspace.getConfiguration('freekit');
}

export function canaryEnabled(): boolean {
  return cfg().get<boolean>('canary.enabled', true);
}

export function canaryPublishEnabled(): boolean {
  return cfg().get<boolean>('canary.publishToGist', true);
}

export function canaryHours(): number {
  const hours = Number(cfg().get<number>('canary.intervalHours', DEFAULT_CANARY_HOURS));
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) return DEFAULT_CANARY_HOURS;
  return hours;
}

export function canaryIntervalMs(): number {
  return canaryHours() * 60 * 60 * 1000;
}

export function canaryLastRunAt(ctx: vscode.ExtensionContext): number {
  return ctx.globalState.get<number>(LAST_RUN_KEY, 0);
}

/** true dacă a trecut cel puțin o perioadă de la ultima rulare. */
export function shouldRunCanary(ctx: vscode.ExtensionContext, now = Date.now()): boolean {
  return now - canaryLastRunAt(ctx) >= canaryIntervalMs();
}

async function markCanaryRun(ctx: vscode.ExtensionContext, now = Date.now()): Promise<void> {
  try {
    await ctx.globalState.update(LAST_RUN_KEY, now);
  } catch (e: any) {
    log('could not persist the last run: ' + (e?.message ?? String(e)));
  }
}

/* ---------------- helpers ---------------- */

function errMsg(e: any): string {
  return e?.message ?? String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/** Elementul există ȘI e vizibil (un composer ascuns sub un modal e stricat). */
async function selectorUsable(page: Page, selector: string): Promise<boolean> {
  const sel = String(selector || '').trim();
  if (!sel) return false;
  try {
    const loc = page.locator(sel);
    const count = await loc.count();
    if (count === 0) return false;
    // Un selector poate potrivi și elemente ascunse (meniu mobil, copie în
    // sidebar): e utilizabil dacă MĂCAR unul e vizibil.
    const limit = Math.min(count, 5);
    for (let i = 0; i < limit; i++) {
      if (await loc.nth(i).isVisible()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Primul selector utilizabil din listă (poll până la `waitMs`). */
async function anySelectorUsable(
  page: Page,
  sels: string[],
  waitMs = 0
): Promise<string | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    for (const sel of sels) {
      if (await selectorUsable(page, sel)) return sel;
    }
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function countMatches(page: Page, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

/**
 * Pagina conține o conversație reală? Se bazează pe markeri generici (nu pe
 * selectorii testați) + un minim de text, ca să nu confundăm chrome-ul de UI
 * (sidebar, „New chat", upsell) cu o conversație.
 */
async function conversationPresent(page: Page): Promise<boolean> {
  let found = 0;
  for (const sel of CONVERSATION_MARKERS) {
    found += await countMatches(page, sel);
    if (found >= 2) break;
  }
  if (!found) return false;
  try {
    const chars = await page.evaluate(() => {
      const main = document.querySelector('main') ?? document.body;
      return ((main as HTMLElement | null)?.innerText ?? '').length;
    });
    return Number(chars) >= CONVERSATION_MIN_CHARS;
  } catch {
    return false;
  }
}

/* ---------------- publicare în Gist ---------------- */

/**
 * Extrage id-ul Gist-ului + numele fișierului dintr-un URL raw de Gist:
 *   https://gist.githubusercontent.com/<user>/<id>/raw[/<rev>]/selectors.json
 *   https://gist.github.com/<user>/<id>
 */
export function gistTargetFromUrl(rawUrl: string): GistTarget | null {
  const value = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  let id = '';
  if (host === 'gist.githubusercontent.com') {
    id = parts[1] ?? '';
  } else if (host === 'gist.github.com') {
    // /<user>/<id> (forma modernă) sau /<id> (forma veche)
    id = parts.length >= 2 ? parts[1] : parts[0] ?? '';
  } else {
    return null;
  }
  if (!/^[a-f0-9]{6,64}$/i.test(id)) return null;
  const rawIdx = parts.indexOf('raw');
  const candidate = rawIdx >= 0 ? parts[parts.length - 1] : '';
  const file = candidate && candidate.includes('.') && candidate !== 'raw' ? candidate : GIST_FILE;
  return { id, file };
}

/** Următoarea versiune: patch +1, garantat mai mare decât cea existentă. */
export function bumpConfigVersion(version: string, now = new Date()): string {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (m) return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1);
  // Versiune fără trei părți numerice: creștem prima componentă existentă și
  // adăugăm un timestamp. `compareVersions` completează părțile lipsă cu 0,
  // deci rezultatul e garantat mai mare (altfel `applyRemote` ar ignora fix-ul).
  const parts = String(version || '')
    .split(/[.\-+]/)
    .map((p) => parseInt(p, 10));
  const head = (Number.isFinite(parts[0]) ? parts[0] : 0) + 1;
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 12);
  return head + '.' + stamp.slice(0, 6) + '.' + stamp.slice(6);
}

function slotConfigWithPrimary(current: SlotConfig, selector: string): SlotConfig {
  const next: SlotConfig = { primary: selector };
  const alternatives = (current.alternatives ?? []).filter((s) => s !== selector);
  if (alternatives.length) next.alternatives = alternatives;
  if (current.fingerprint) next.fingerprint = current.fingerprint;
  if (current.preferredKeywords?.length) next.preferredKeywords = current.preferredKeywords;
  return next;
}

/**
 * Aplică reparațiile peste configul Gist-ului: fiecare slot primește noul
 * selector ca `primary`, versiunea crește o dată per publicare (altfel clienții
 * ar ignora fișierul — `applyRemote` cere o versiune strict mai mare).
 */
export function applyCanaryFixes(
  config: SelectorConfig,
  fixes: CanaryFix[],
  now = new Date()
): { config: SelectorConfig; applied: CanaryFix[]; skipped: CanaryFix[] } {
  const providers: Record<string, ProviderConfig> = { ...config.providers };
  const applied: CanaryFix[] = [];
  const skipped: CanaryFix[] = [];

  for (const fix of fixes) {
    const provider = providers[fix.provider];
    if (!provider) {
      skipped.push(fix);
      continue;
    }
    const current = provider[fix.slot];
    if (!current) {
      skipped.push(fix);
      continue;
    }
    if (current.primary === fix.selector) {
      skipped.push(fix); // deja publicat
      continue;
    }
    providers[fix.provider] = {
      ...provider,
      [fix.slot]: slotConfigWithPrimary(current, fix.selector)
    };
    applied.push(fix);
  }

  if (!applied.length) return { config, applied, skipped };

  const next: SelectorConfig = {
    version: bumpConfigVersion(config.version, now),
    updated: now.toISOString().slice(0, 10),
    changelog:
      'canary: ' + applied.map((f) => f.provider + '.' + f.slot).join(', ') + ' repaired by the AI Finder',
    providers
  };
  return { config: next, applied, skipped };
}

/** Avertismentele „nu e configurat" se loghează o singură dată per sesiune. */
let warnedPublishSetup = '';
function warnOnce(key: string, msg: string): void {
  if (warnedPublishSetup === key) return;
  warnedPublishSetup = key;
  log(msg);
}

/**
 * Publică reparațiile AI în Gist-ul configurat (un singur PATCH per rulare).
 * Nu aruncă niciodată — orice problemă e raportată în `reason`.
 */
export async function publishCanaryFixes(
  ctx: vscode.ExtensionContext,
  fixes: CanaryFix[]
): Promise<CanaryPublishResult> {
  if (!fixes.length) return { ok: false, reason: 'nothing to publish', published: [] };
  if (!canaryPublishEnabled()) {
    return { ok: false, reason: 'freekit.canary.publishToGist is off', published: [] };
  }
  const rawUrl = selectorsUrlFromSettings();
  const target = gistTargetFromUrl(rawUrl);
  if (!target) {
    warnOnce(
      'no-gist',
      'publish skipped — freekit.selectorsUrl does not point to a GitHub Gist (nothing to publish to)'
    );
    return { ok: false, reason: 'no Gist configured in freekit.selectorsUrl', published: [] };
  }
  const token = await ctx.secrets.get(GIST_TOKEN_KEY);
  if (!token) {
    warnOnce(
      'no-token',
      'publish skipped — no GitHub token stored; run “Freekit: Set Gist Token” to enable hive-mind publishing'
    );
    return { ok: false, reason: 'no GitHub token stored', published: [] };
  }

  // Re-citim Gist-ul imediat înainte de scriere: nu suprascriem reparații
  // publicate între timp de alt client. Query-ul `v=` ocolește cache-ul CDN
  // (raw Gist-urile stau în cache câteva minute — altfel am citi o versiune
  // veche și am rescrie peste un fix proaspăt).
  const readUrl = rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
  let remote: SelectorConfig;
  try {
    remote = parseRemoteConfig(await fetchRemoteSelectorsText(readUrl, GIST_PATCH_TIMEOUT_MS));
  } catch (e: any) {
    log('publish skipped — could not read the Gist: ' + errMsg(e));
    return { ok: false, reason: 'could not read the Gist: ' + errMsg(e), published: [] };
  }

  const { config, applied, skipped } = applyCanaryFixes(remote, fixes);
  if (!applied.length) {
    log(
      'publish skipped — the Gist already has these selectors' +
        (skipped.length ? ' (' + skipped.map((f) => f.provider + '.' + f.slot).join(', ') + ')' : '')
    );
    return { ok: false, reason: 'already up to date', published: [] };
  }

  // Nu trimitem niciodată un config pe care validatorul remote l-ar refuza.
  try {
    parseRemoteConfig(JSON.stringify(config));
  } catch (e: any) {
    log('publish refused — the merged config is invalid: ' + errMsg(e));
    return { ok: false, reason: 'refusing to publish an invalid config', published: [] };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GIST_PATCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.github.com/gists/' + encodeURIComponent(target.id), {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: { [target.file]: { content: JSON.stringify(config, null, 2) + '\n' } }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? ' (the token needs the “gist” scope and write access to this Gist)'
          : '';
      log('publish failed — GitHub answered HTTP ' + res.status + hint);
      return { ok: false, reason: 'GitHub answered HTTP ' + res.status, published: [] };
    }
    warnedPublishSetup = '';
    log(
      'published v' +
        config.version +
        ' to the Gist (' +
        target.id.slice(0, 8) +
        '…): ' +
        applied.map((f) => f.provider + '.' + f.slot).join(', ') +
        (skipped.length
          ? ' — skipped: ' + skipped.map((f) => f.provider + '.' + f.slot).join(', ')
          : '')
    );
    return { ok: true, version: config.version, published: applied };
  } catch (e: any) {
    log('publish error: ' + errMsg(e));
    return { ok: false, reason: errMsg(e), published: [] };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- verificarea propriu-zisă ---------------- */

/**
 * Repară un slot: healer local (fingerprint) cu fallback pe AI Finder (cele
 * două sunt deja înlănțuite în `healSlot`). Întoarce și SURSA reparației —
 * doar cea de la AI Finder se publică în Gist.
 */
async function repairSlot(
  page: Page,
  provider: string,
  slot: SlotName
): Promise<CanarySlotOutcome> {
  let healed: string | null = null;
  try {
    healed = await healSlot(page, provider, slot);
  } catch (e: any) {
    log('repair failed for ' + provider + '.' + slot + ': ' + errMsg(e));
  }
  if (!healed) {
    return { slot, status: 'broken', reason: 'the healer and the AI Finder found nothing' };
  }
  if (!(await selectorUsable(page, healed))) {
    return {
      slot,
      status: 'broken',
      selector: healed,
      reason: 'the proposed selector is not usable in the page'
    };
  }
  const learned = selectors.learned(provider, slot);
  const fixedBy: 'ai' | 'healer' =
    learned && learned.selector === healed && learned.how === 'ai' ? 'ai' : 'healer';
  log(provider + '.' + slot + ' healed by ' + fixedBy + ' -> ' + healed);
  return { slot, status: 'healed', selector: healed, fixedBy };
}

/** Tab-ul cu o conversație în care are sens să verifici `response`. */
async function conversationPageFor(
  browser: BrowserManager,
  canaryPage: Page,
  provider: string
): Promise<Page | null> {
  if (await conversationPresent(canaryPage)) return canaryPage;
  try {
    const host = normalizeHost(selectors.host(provider));
    if (!host) return null;
    const userPage = await browser.pageForHost(host);
    if (!userPage || userPage === canaryPage) return null;
    return (await conversationPresent(userPage)) ? userPage : null;
  } catch {
    return null;
  }
}

/**
 * Verifică un provider pe un tab dedicat. Nu aruncă niciodată — orice eroare
 * devine `skipped` (rețea, redirect, provider indisponibil).
 */
async function probeProvider(
  browser: BrowserManager,
  page: Page,
  provider: string
): Promise<CanaryProviderOutcome> {
  const url = selectors.url(provider);
  const out: CanaryProviderOutcome = { provider, url, slots: [] };
  if (!url) {
    out.skipped = 'no URL in selectors.json';
    return out;
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (e: any) {
    out.skipped = 'navigation failed: ' + errMsg(e);
    return out;
  }

  // Așteaptă SPA-ul să randeze. Un redirect pe ALT host (login Google etc.)
  // înseamnă imediat „nu e pagina aplicației"; o altă RUTĂ pe același host
  // (ex. Claude `/chat/<id>`) e acceptată dacă input-ul apare — aceeași
  // excepție ca în health check-ul din reporting.ts.
  const appHost = normalizeHost(selectors.host(provider));
  let inputHit: string | null = null;
  let leftHost = false;
  const deadline = Date.now() + RENDER_WAIT_MS;
  for (;;) {
    const current = safeUrl(page);
    if (appHost && normalizeHost(current) !== appHost) {
      leftHost = true;
      break;
    }
    inputHit = await anySelectorUsable(page, selectors.candidates(provider, 'input'), 0);
    if (inputHit) break;
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }

  if (leftHost || (!inputHit && !isAppPage(safeUrl(page), url))) {
    out.skipped = 'not the app page (' + (safeUrl(page) || 'unknown') + ')';
    return out;
  }
  const newChatHit = await anySelectorUsable(page, selectors.candidates(provider, 'newChat'), 2_000);
  if (!inputHit && !newChatHit) {
    // Fără NICIUN slot critic nu putem distinge „selector stricat" de „login
    // wall / pagină de mentenanță" — nu reparăm și nu publicăm nimic.
    out.skipped =
      'neither input nor newChat exists in the DOM — wrong page, signed out, or the app did not render';
    return out;
  }

  out.slots.push(
    inputHit
      ? { slot: 'input', status: 'ok', selector: inputHit }
      : await repairSlot(page, provider, 'input')
  );
  out.slots.push(
    newChatHit
      ? { slot: 'newChat', status: 'ok', selector: newChatHit }
      : await repairSlot(page, provider, 'newChat')
  );

  const responsePage = await conversationPageFor(browser, page, provider);
  if (!responsePage) {
    out.slots.push({
      slot: 'response',
      status: 'skipped',
      reason: 'no conversation to read — the response selector cannot be verified without one'
    });
    return out;
  }
  // Cât timp modelul generează, DOM-ul se schimbă sub noi: nu validăm acum.
  const stopHit = await anySelectorUsable(
    responsePage,
    selectors.candidates(provider, 'stopButton'),
    0
  );
  if (stopHit) {
    out.slots.push({
      slot: 'response',
      status: 'skipped',
      reason: 'the model is still generating on that page'
    });
    return out;
  }
  const candidates = selectors.candidates(provider, 'response');
  const responseHit = await anySelectorUsable(responsePage, candidates, 0);
  out.slots.push(
    responseHit
      ? { slot: 'response', status: 'ok', selector: responseHit }
      : await repairSlot(responsePage, provider, 'response')
  );
  return out;
}

/**
 * Rularea canary: verifică toți providerii din selectors.json și publică în
 * Gist reparațiile făcute de AI Finder. Best-effort — nu aruncă niciodată.
 */
export async function runCanaryCheck(
  browser: BrowserManager,
  context: vscode.ExtensionContext,
  opts: { force?: boolean } = {}
): Promise<CanaryOutcome> {
  const startedAt = Date.now();
  const outcome: CanaryOutcome = {
    startedAt,
    durationMs: 0,
    providers: [],
    healed: 0,
    broken: 0,
    published: 0
  };

  if (!canaryEnabled()) {
    outcome.skipped = 'disabled (freekit.canary.enabled = false)';
    log('disabled by setting — skipped');
    return outcome;
  }
  if (!opts.force && !shouldRunCanary(context)) {
    outcome.skipped = 'not due yet';
    log('not due yet — skipped');
    return outcome;
  }
  if (!(await browser.isRunning())) {
    // Canary-ul NU pornește Chrome: ar fi o acțiune vizibilă, nesolicitată.
    outcome.skipped = 'the browser is not running';
    log('browser is not running — skipped (the canary never starts Chrome)');
    return outcome;
  }
  await markCanaryRun(context);

  let page: Page | null = null;
  try {
    page = await browser.newPage();
  } catch (e: any) {
    outcome.skipped = 'could not open a background tab: ' + errMsg(e);
    log('could not open a background tab: ' + errMsg(e));
    return outcome;
  }

  const fixes: CanaryFix[] = [];
  try {
    for (const provider of selectors.providerIds()) {
      let result: CanaryProviderOutcome;
      try {
        result = await probeProvider(browser, page, provider);
      } catch (e: any) {
        // Un provider nu trebuie să oprească restul rulării.
        result = { provider, url: '', slots: [], skipped: errMsg(e) };
      }
      outcome.providers.push(result);
      if (result.skipped) log(provider + ' skipped — ' + result.skipped);
      for (const slot of result.slots) {
        if (slot.status === 'healed') {
          outcome.healed++;
          if (slot.fixedBy === 'ai' && slot.selector) {
            fixes.push({ provider, slot: slot.slot, selector: slot.selector });
          }
        } else if (slot.status === 'broken') {
          outcome.broken++;
        }
      }
    }
  } catch (e: any) {
    log('canary error: ' + errMsg(e));
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* tab-ul poate fi deja închis */
      }
    }
  }

  if (fixes.length) {
    const published = await publishCanaryFixes(context, fixes);
    if (published.ok) {
      outcome.published = published.published.length;
      for (const fix of published.published) {
        const providerOutcome = outcome.providers.find((p) => p.provider === fix.provider);
        const slotOutcome = providerOutcome?.slots.find((s) => s.slot === fix.slot);
        if (slotOutcome) slotOutcome.published = true;
      }
    }
  }

  outcome.durationMs = Date.now() - startedAt;
  const checked = outcome.providers.filter((p) => !p.skipped);
  log(
    'done in ' + Math.round(outcome.durationMs / 1000) + 's — providers checked: ' +
      (checked.map((p) => p.provider).join(', ') || 'none') +
      ', healed: ' + outcome.healed +
      ', still broken: ' + outcome.broken +
      ', published: ' + outcome.published
  );
  return outcome;
}

/* ---------------- serviciul periodic ---------------- */

/** Cat de des se verifică dacă perioada configurată a trecut (nu check-ul în sine). */
const TICK_MS = 30 * 60 * 1000;
/** Prima rulare după pornire — devreme, dar nu în timpul pornirii VS Code. */
const FIRST_DELAY_MS = 3 * 60 * 1000;

/**
 * Programează canary-ul. Intervalul e verificat la fiecare 30 de minute
 * (setInterval cu 720h ar depăși limita de 32 de biți a timerelor Node).
 */
export class CanaryService implements vscode.Disposable {
  private timers: NodeJS.Timeout[] = [];
  private disposed = false;
  private started = false;
  private running = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly browser: BrowserManager
  ) {}

  start(): void {
    if (this.disposed || this.started) return;
    if (!canaryEnabled()) {
      log('disabled by setting — not starting');
      return;
    }
    this.started = true;
    this.timers.push(setTimeout(() => void this.tick(), FIRST_DELAY_MS));
    this.timers.push(setInterval(() => void this.tick(), TICK_MS));
    log('scheduled — every ' + canaryHours() + 'h, first check ~3 min after startup');
  }

  /** Rulare manuală (comanda „Run Canary Check Now"), fără rate limiting. */
  async runNow(): Promise<CanaryOutcome> {
    if (this.running) {
      return {
        startedAt: Date.now(),
        durationMs: 0,
        providers: [],
        healed: 0,
        broken: 0,
        published: 0,
        skipped: 'a canary check is already running'
      };
    }
    this.running = true;
    try {
      return await runCanaryCheck(this.browser, this.ctx, { force: true });
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.running) return;
    if (!shouldRunCanary(this.ctx)) return;
    this.running = true;
    try {
      await runCanaryCheck(this.browser, this.ctx);
    } catch (e: any) {
      log('tick error: ' + errMsg(e));
    } finally {
      this.running = false;
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

/** O linie despre stare, pentru Diagnostics / status. */
export async function canaryStatusText(ctx: vscode.ExtensionContext): Promise<string> {
  if (!canaryEnabled()) return 'disabled (freekit.canary.enabled = false)';
  const last = canaryLastRunAt(ctx);
  const target = gistTargetFromUrl(selectorsUrlFromSettings());
  let publish = 'off (freekit.canary.publishToGist = false)';
  if (canaryPublishEnabled()) {
    if (!target) publish = 'no Gist configured';
    else if (await ctx.secrets.get(GIST_TOKEN_KEY)) publish = 'Gist ' + target.id.slice(0, 8) + '…';
    else publish = 'Gist ' + target.id.slice(0, 8) + '… — no token (run “Freekit: Set Gist Token”)';
  }
  return (
    'every ' + canaryHours() + 'h | last run: ' +
    (last ? new Date(last).toLocaleString() : 'never') +
    ' | publish: ' + publish
  );
}
