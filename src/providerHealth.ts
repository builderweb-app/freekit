import * as fs from 'fs';
import * as path from 'path';
import { logLine } from './log';

/* =========================================================================
 * v2.5.56 (FIX 3/4) — FIABILITATEA PROVIDERILOR
 *
 * Fiecare răspuns care epuizează reluările de „malformed tool call" este un
 * eșec de protocol al providerului respectiv; fiecare mesaj încheiat cu un
 * răspuns final e un succes. Statisticile se persistă în globalStorage
 * (provider-reliability.json):
 *   { "deepseek": { "malformed": 15, "success": 42 } }
 *
 * La un task nou, o rată de eșec peste 20% declanșează o sugestie de switch;
 * la 3 eșecuri consecutive pe ACELAȘI mesaj, chatView trece automat pe
 * următorul provider din `PROVIDER_SWITCH_ORDER`.
 * ========================================================================= */

/**
 * v2.5.56 (FIX 3): ordinea în care se încearcă ceilalți provideri când unul
 * eșuează repetat — chatgpt > claude > qwen > gemini > mistral > deepseek.
 * Ollama nu intră în lanț (model local, fără chat web).
 */
export const PROVIDER_SWITCH_ORDER: readonly string[] = [
  'chatgpt',
  'claude',
  'qwen',
  'gemini',
  'mistral',
  'deepseek'
];

export interface ProviderHealthEntry {
  malformed: number;
  success: number;
  /**
   * v2.5.74 (FIX 5): de câte ori providerul a rămas MUT (input acceptat, dar
   * niciun răspuns până la bugetul de așteptare) — ex: Qwen pe „Salut!".
   */
  noResponse?: number;
  /** v2.5.74 (FIX 5): momentul ultimei „mut" (epoch ms); 0 = niciodată. */
  unhealthyAt?: number;
}

/** v2.5.74 (FIX 5): cât timp un provider rămâne marcat „unhealthy". */
export const UNHEALTHY_TTL_MS = 30 * 60 * 1000;

export type ProviderHealthMap = Record<string, ProviderHealthEntry>;

const FILE_NAME = 'provider-reliability.json';

/** Calea fișierului de statistici din globalStorage. */
export function providerHealthFile(root: string): string {
  return path.join(root, FILE_NAME);
}

/** Citește statisticile (best-effort: fișier lipsă/corupt ⇒ obiect gol). */
export function readProviderHealth(root: string): ProviderHealthMap {
  try {
    if (!root) return {};
    const parsed = JSON.parse(fs.readFileSync(providerHealthFile(root), 'utf8'));
    const map: ProviderHealthMap = {};
    for (const [name, raw] of Object.entries(parsed ?? {})) {
      const malformed = Math.floor(Number((raw as any)?.malformed));
      const success = Math.floor(Number((raw as any)?.success));
      if (!Number.isFinite(malformed) && !Number.isFinite(success)) continue;
      // v2.5.74 (FIX 5): câmpurile de „mut" sunt opționale (fișiere vechi)
      const noResponse = Math.floor(Number((raw as any)?.noResponse));
      const unhealthyAt = Math.floor(Number((raw as any)?.unhealthyAt));
      map[name] = {
        malformed: Number.isFinite(malformed) && malformed > 0 ? malformed : 0,
        success: Number.isFinite(success) && success > 0 ? success : 0,
        noResponse: Number.isFinite(noResponse) && noResponse > 0 ? noResponse : 0,
        unhealthyAt: Number.isFinite(unhealthyAt) && unhealthyAt > 0 ? unhealthyAt : 0
      };
    }
    return map;
  } catch {
    return {};
  }
}

function writeProviderHealth(root: string, map: ProviderHealthMap): void {
  try {
    if (!root) return;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      providerHealthFile(root),
      JSON.stringify(map, null, 2) + '\n',
      'utf8'
    );
  } catch (e: any) {
    logLine('provider-health', 'write failed: ' + (e?.message ?? String(e)));
  }
}

function bump(root: string, name: string, field: keyof ProviderHealthEntry): void {
  if (!root || !name) return;
  const map = readProviderHealth(root);
  const entry = map[name] ?? { malformed: 0, success: 0 };
  entry[field] = (Number(entry[field]) || 0) + 1;
  map[name] = entry;
  writeProviderHealth(root, map);
}

/** Un mesaj al providerului a epuizat reluările de „malformed tool call". */
export function recordProviderMalformed(root: string, name: string): void {
  bump(root, name, 'malformed');
}

/** Un mesaj încheiat cu răspuns final (fără eșec de protocol). */
export function recordProviderSuccess(root: string, name: string): void {
  bump(root, name, 'success');
  // v2.5.74 (FIX 5): un răspuns reușit scoate providerul din starea „unhealthy"
  clearProviderUnhealthy(root, name);
}

/**
 * v2.5.74 (FIX 5): providerul a rămas MUT (input acceptat, dar niciun răspuns)
 * — intră în statistici ca „noResponse" și e marcat `unhealthy`, ca mesajele
 * următoare să nu-l mai aștepte degeaba. Log: `[provider-health] <name> marked
 * unhealthy …`.
 */
export function recordProviderNoResponse(root: string, name: string): void {
  if (!root || !name) return;
  const map = readProviderHealth(root);
  const entry = map[name] ?? { malformed: 0, success: 0 };
  entry.noResponse = (entry.noResponse ?? 0) + 1;
  entry.unhealthyAt = Date.now();
  map[name] = entry;
  writeProviderHealth(root, map);
  logLine(
    'provider-health',
    name + ' marked unhealthy (no response ' + entry.noResponse + 'x)'
  );
}

/** v2.5.74 (FIX 5): `true` dacă providerul e marcat „unhealthy" (recent). */
export function isProviderUnhealthy(
  root: string,
  name: string,
  withinMs = UNHEALTHY_TTL_MS
): boolean {
  const entry = readProviderHealth(root)[name];
  if (!entry?.unhealthyAt) return false;
  return Date.now() - entry.unhealthyAt < withinMs;
}

/** v2.5.74 (FIX 5): scoate marcajul „unhealthy" (ex: după un răspuns reușit). */
export function clearProviderUnhealthy(root: string, name: string): void {
  if (!root || !name) return;
  const map = readProviderHealth(root);
  const entry = map[name];
  if (!entry?.unhealthyAt) return;
  entry.unhealthyAt = 0;
  map[name] = entry;
  writeProviderHealth(root, map);
}

/** Rata de eșecuri malformed (0..1); 0 când încă nu există date. */
export function malformedRate(entry: ProviderHealthEntry | undefined): number {
  const malformed = entry?.malformed ?? 0;
  const success = entry?.success ?? 0;
  const total = malformed + success;
  return total > 0 ? malformed / total : 0;
}

/** Următorul provider din ordinea de rezervă (ciclic). */
export function nextProviderInOrder(name: string): string {
  const idx = PROVIDER_SWITCH_ORDER.indexOf(name);
  if (idx < 0) return PROVIDER_SWITCH_ORDER[0];
  return PROVIDER_SWITCH_ORDER[(idx + 1) % PROVIDER_SWITCH_ORDER.length];
}
