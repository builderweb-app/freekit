import { logLine } from './log';
// IMPORTANT: `vscode` doar ca TIP — modulul trebuie să rămână încărcabil în
// testele Node, fără VS Code (require-ul real e lazy, în selectors.ts).
import type * as vscode from 'vscode';
import {
  ProviderConfig,
  SlotConfig,
  SlotName,
  SelectorConfig,
  Fingerprint,
  compareVersions,
  selectors
} from './selectors';

const log = (msg: string) => logLine('remote', msg);

/* =========================================================================
 * v0.7.0 — REMOTE SELECTOR CONFIG (Gist GitHub public)
 *
 * Scop: reparațiile de selectori publicate de developer într-un Gist public
 * ajung la TOȚI clienții fără update de extensie.
 *
 * Flux: aiBridge.selectorsUrl (URL raw Gist) -> fetch (10s timeout) ->
 * validare + sanitizare strictă -> dacă version > versiunea activă =>
 * selectors.ts îl aplică (merge cu configul activ) și îl salvează în
 * cache-ul din globalState. ORICE eroare lasă configul activ neatins —
 * fallback garantat la bundled.
 *
 * v0.7.1: verificarea automată de la pornire are rate limiting 24h
 * (shouldAutoCheck / markAutoCheck) — cel mult un fetch pe zi; comanda
 * manuală „Update Selectors" funcționează oricând, la cerere.
 * ========================================================================= */

export const REMOTE_MAX_CHARS = 300_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SELECTOR_LEN = 1000;
const MAX_VERSION_LEN = 40;

/** v0.7.1: verificarea automată de la pornire rulează cel mult o dată pe zi. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_CHECK_STATE_KEY = 'aiBridge.selectorsAutoCheck';

export interface RemoteCheckResult {
  status: 'updated' | 'up-to-date' | 'disabled' | 'error';
  /** Versiunea citită din Gist (dacă s-a putut citi/parsa). */
  version?: string;
  /** Versiunea activă dinainte de verificare. */
  previousVersion?: string;
  /** Versiunea activă după verificare. */
  activeVersion?: string;
  /** Sloturi "provider.slot" ale căror reparații locale au fost înlocuite. */
  cleared?: string[];
  changelog?: string;
  /** Detaliu (eroare / motiv) când status e 'error' sau 'disabled'. */
  message?: string;
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > max) return undefined;
  return s;
}

function strList(v: unknown, maxItems = 40, maxLen = 200): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v.slice(0, maxItems)) {
    const s = str(item, maxLen);
    if (s) out.push(s);
  }
  return out.length ? out : undefined;
}

function normalizeFingerprint(raw: any): Fingerprint | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const fp: Fingerprint = {};
  const tags = strList(raw.tags, 20, 60);
  if (tags) fp.tags = tags.map((t) => t.toLowerCase());
  const attributes = strList(raw.attributes, 20, 60);
  if (attributes) fp.attributes = attributes;
  const nearbyText = strList(raw.nearbyText, 30, 80);
  if (nearbyText) fp.nearbyText = nearbyText;
  if (raw.position === 'top' || raw.position === 'bottom') fp.position = raw.position;
  const hasChildren = strList(raw.hasChildren, 20, 60);
  if (hasChildren) fp.hasChildren = hasChildren;
  const role = str(raw.role, 60);
  if (role) fp.role = role;
  if (typeof raw.editable === 'boolean') fp.editable = raw.editable;
  const minText = Number(raw.minTextLength);
  if (Number.isFinite(minText) && minText >= 0 && minText <= 100_000) {
    fp.minTextLength = Math.floor(minText);
  }
  return Object.keys(fp).length ? fp : undefined;
}

function normalizeSlot(
  raw: any,
  slot: SlotName,
  pid: string,
  errors: string[],
  optional = false
): SlotConfig | undefined {
  if (raw === undefined || raw === null) {
    if (!optional) errors.push(pid + '.' + slot + ': lipsește');
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(pid + '.' + slot + ': nu este obiect');
    return undefined;
  }
  const primary = str(raw.primary, MAX_SELECTOR_LEN);
  if (!primary) {
    errors.push(pid + '.' + slot + ': „primary” lipsește sau e invalid');
    return undefined;
  }
  const out: SlotConfig = { primary };
  const alternatives = strList(raw.alternatives);
  if (alternatives) out.alternatives = alternatives;
  const fingerprint = normalizeFingerprint(raw.fingerprint);
  if (fingerprint) out.fingerprint = fingerprint;
  // v0.9.0: preferredKeywords (bonus la auto-reparare) — aceleași limite ca nearbyText
  const preferredKeywords = strList(raw.preferredKeywords, 30, 40);
  if (preferredKeywords) {
    out.preferredKeywords = preferredKeywords.map((k) => k.toLowerCase());
  }
  return out;
}

/**
 * Validează + sanitizează configul remote (aruncă Error cu detaliile).
 * Se acceptă DOAR câmpurile cunoscute; orice altceva este eliminat.
 */
export function normalizeRemoteConfig(raw: any): SelectorConfig {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('selectors remote invalide: rădăcina nu este un obiect JSON');
  }
  const version = str(raw.version, MAX_VERSION_LEN);
  if (!version) errors.push('lipsește câmpul „version” (string, max ' + MAX_VERSION_LEN + ' caractere)');

  const providersRaw = raw.providers;
  if (!providersRaw || typeof providersRaw !== 'object' || Array.isArray(providersRaw)) {
    throw new Error(
      'selectors remote invalide: ' + errors.concat('lipsește obiectul „providers”').join('; ')
    );
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [pid, praw] of Object.entries(providersRaw as Record<string, any>)) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(pid)) {
      errors.push('nume de provider invalid: „' + pid + '”');
      continue;
    }
    if (!praw || typeof praw !== 'object' || Array.isArray(praw)) {
      errors.push(pid + ': nu este obiect');
      continue;
    }
    const url = str(praw.url, 300);
    const urlOk = !!url && /^https?:\/\//i.test(url);
    if (!urlOk) errors.push(pid + ': câmpul „url” lipsește sau nu e http(s)');

    const cfg: Partial<ProviderConfig> = {};
    if (urlOk) cfg.url = url;
    const input = normalizeSlot(praw.input, 'input', pid, errors);
    const response = normalizeSlot(praw.response, 'response', pid, errors);
    const newChat = normalizeSlot(praw.newChat, 'newChat', pid, errors);
    const stopButton = normalizeSlot(praw.stopButton, 'stopButton', pid, errors, true);
    if (input) cfg.input = input;
    if (response) cfg.response = response;
    if (newChat) cfg.newChat = newChat;
    if (stopButton) cfg.stopButton = stopButton;
    if (cfg.url && cfg.input && cfg.response && cfg.newChat) {
      providers[pid] = cfg as ProviderConfig;
    }
  }
  if (!Object.keys(providers).length && !errors.length) {
    errors.push('niciun provider valid');
  }
  if (errors.length) {
    throw new Error('selectors remote invalide: ' + errors.slice(0, 5).join('; '));
  }
  return {
    version: version || '',
    updated: str(raw.updated, MAX_VERSION_LEN) || '',
    changelog: str(raw.changelog, 500),
    providers
  };
}

/** Parsează + validează textul JSON al configului remote. */
export function parseRemoteConfig(text: string): SelectorConfig {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new Error('JSON invalid: ' + (e?.message ?? String(e)));
  }
  return normalizeRemoteConfig(raw);
}

/** Descarcă textul configului de la URL-ul dat (http/https, cu timeout). */
export async function fetchRemoteSelectorsText(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error('URL invalid (trebuie http/https): ' + (clean || '(gol)'));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(clean, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
    }
    const text = await res.text();
    if (text.length > REMOTE_MAX_CHARS) {
      throw new Error(
        'răspuns prea mare (' + text.length + ' > ' + REMOTE_MAX_CHARS + ' caractere)'
      );
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Starea rate-limiting-ului pentru verificarea automată (în globalState). */
export interface AutoCheckState {
  url: string;
  at: number;
}

/**
 * v0.7.1 — rate limiting 24h pentru verificarea automată de la pornire:
 * întoarce true doar dacă nu s-a mai verificat niciodată, dacă URL-ul
 * configurat s-a schimbat, sau dacă au trecut `intervalMs` de la ultima
 * verificare (manuală SAU automată). Fail-open la orice eroare de citire.
 */
export function shouldAutoCheck(
  memento: vscode.Memento | undefined,
  url: string,
  now = Date.now(),
  intervalMs = AUTO_CHECK_INTERVAL_MS
): boolean {
  if (!memento) return true;
  try {
    const rec = memento.get<AutoCheckState>(AUTO_CHECK_STATE_KEY);
    if (!rec || typeof rec.at !== 'number' || rec.url !== String(url || '').trim()) {
      return true;
    }
    return now - rec.at >= intervalMs;
  } catch {
    return true;
  }
}

/** Consemnează momentul ultimei verificări de selectori remote. */
export function markAutoCheck(
  memento: vscode.Memento | undefined,
  url: string,
  now = Date.now()
): void {
  if (!memento) return;
  const rec: AutoCheckState = { url: String(url || '').trim(), at: now };
  try {
    void Promise.resolve(memento.update(AUTO_CHECK_STATE_KEY, rec)).catch((e: any) => {
      log('persist auto-check a eșuat: ' + (e?.message ?? String(e)));
    });
  } catch (e: any) {
    log('persist auto-check a eșuat: ' + (e?.message ?? String(e)));
  }
}

/**
 * Verifică Gist-ul și aplică update-ul dacă versiunea e mai nouă.
 * Nu aruncă niciodată — întoarce mereu un RemoteCheckResult.
 * Cu `memento`, orice verificare (reușită SAU eșuată) resetează ceasul
 * de 24h al verificării automate (rate limiting în shouldAutoCheck).
 */
export async function checkAndApplyRemote(
  url: string,
  memento?: vscode.Memento
): Promise<RemoteCheckResult> {
  const clean = String(url || '').trim();
  if (!clean) {
    return { status: 'disabled', message: 'aiBridge.selectorsUrl nu este setat' };
  }
  const before = selectors.info();
  log('verific ' + clean + ' (activ: v' + before.version + ' — ' + before.source + ')');
  try {
    const text = await fetchRemoteSelectorsText(clean);
    const config = parseRemoteConfig(text);
    if (compareVersions(config.version, before.version) <= 0) {
      log('la zi: remote v' + config.version + ' <= activ v' + before.version);
      return {
        status: 'up-to-date',
        version: config.version,
        previousVersion: before.version,
        activeVersion: before.version,
        changelog: config.changelog
      };
    }
    const applied = selectors.applyRemote(config, clean);
    return {
      status: applied.applied ? 'updated' : 'up-to-date',
      version: config.version,
      previousVersion: before.version,
      activeVersion: applied.version,
      cleared: applied.cleared,
      changelog: config.changelog
    };
  } catch (e: any) {
    let msg = e?.message ?? String(e);
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      msg = 'timeout la descărcarea Gist-ului';
    }
    log('EROARE la verificarea remote: ' + msg);
    return {
      status: 'error',
      message: msg,
      previousVersion: before.version,
      activeVersion: before.version
    };
  } finally {
    // v0.7.1: rate limiting 24h — orice verificare (reușită SAU eșuată)
    // pornește ceasul, ca pornirile repetate ale VS Code să nu bombardeze
    // Gist-ul. Comanda manuală rămâne mereu disponibilă.
    markAutoCheck(memento, clean);
  }
}
