/* =========================================================================
 * v2.5.25 (bug #62) — HANDOFF-UL DE ROTIRE PĂSTREAZĂ FIȘIERELE CITITE
 *
 * Rotirea proactivă a chatului web (v2.5.23) deschide un chat NOU, complet gol:
 * acolo NU ajung rezultatele uneltelor (fișierele citite rămân în chatul vechi).
 * Handoff-ul ducea doar rezumatul task-ului + pașii făcuți, așa că AI-ul din
 * chatul nou cerea re-citirea fișierelor („trimite batch-ul").
 *
 * Aici stau bucățile pure (fără `vscode`), ca logica să fie ușor de verificat:
 *   - isReadEverythingTask() — „citește TOATE fișierele și rezumă" (un astfel de
 *     task oricum nu încape într-un chat: rotirea l-ar obliga pe cel nou să
 *     re-citească tot → nu rotim, lăsăm „Chat memory full" să decidă);
 *   - recordReadFiles() / invalidateTouchedFiles() — ce fișiere a văzut chatul;
 *   - formatReadFilesList() / formatReadFilesExcerpts() — ce primește chatul nou.
 * ========================================================================= */

import type { ToolCall, ToolResult } from './tools';
import { stripTsAliasPath, toAiPath, TS_ALIAS_NOTE } from './tsAlias';

/** câte fișiere ținem minte per chat de browser (handoff-ul rămâne mărginit) */
const MAX_TRACKED_FILES = 120;
/** conținutul păstrat per fișier (read_file întoarce deja max 6000, vezi payload.ts) */
const MAX_TRACKED_CHARS = 6000;
/** câte căi intră în lista „Already read: …" */
const MAX_LISTED_PATHS = 60;
/** lungimea maximă a listei inline de căi (cap pentru chatul nou) */
const MAX_PATH_LIST_CHARS = 1200;
/** extrasul per fișier trimis chatului nou (head + tail) */
const MAX_EXCERPT_PER_FILE = 500;
/** bugetul total al extraselor (peste asta, restul fișierelor nu mai primesc conținut) */
const MAX_EXCERPT_TOTAL = 2000;
/** sub atât nu mai are sens să începem un extras nou */
const MIN_EXCERPT_BUDGET = 200;

/**
 * v2.5.25 (bug #62): task care citește MULTE fișiere și le rezumă/analizează
 * („read every .ts file in src/ and summarize", „read all files and explain",
 * „summarize the whole codebase"). Un astfel de task nu încape oricum într-un
 * singur chat web (fiecare citire e un paste mare), iar rotirea NU ajută:
 * chatul nou ar porni fără rezultate și ar cere re-citirea tuturor fișierelor.
 * Nu rotim pentru el — „Chat memory full" (care are card + handoff) decide.
 */
export function isReadEverythingTask(text: string): boolean {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  const verb =
    /\b(read|reading|review|scan|analy[sz]e|inspect|summari[sz]e|summarise|document|audit|map|walk|understand|explain|list|go\s+through)\b/i;
  const all = /\b(all|every|each|entire|whole|full)\b/i;
  const target =
    /\b(files?|sources?|modules?|components?|classes?|functions?|codebase|project|repo|repository|workspace|folder|directory|src)\b|\.(ts|tsx|js|jsx|mjs|cjs|py|go|cs|java|rb|php|rs|kt|swift|vue|svelte)\b/i;
  return verb.test(t) && all.test(t) && target.test(t);
}

/** Fișierele ale căror conținut a ajuns la AI într-un rezultat de unealtă. */
export function extractReadFiles(
  call: ToolCall,
  result: ToolResult
): Array<[string, string]> {
  if (!result.ok) return [];
  const out = String(result.result ?? '');
  if (!out) return [];
  const args: any = call.args ?? {};
  if (call.tool === 'read_file') {
    const p = typeof args.path === 'string' ? args.path : '';
    return p ? [[p, out]] : [];
  }
  if (call.tool !== 'read_files') return [];
  // read_files lipește secțiuni „--- FILE: <path> ---\n<conținut>"
  const files: Array<[string, string]> = [];
  for (const part of out.split(/^--- FILE: /m).slice(1)) {
    const sep = part.indexOf(' ---');
    if (sep <= 0) continue;
    // v2.5.27 (bug #63): antetul poate purta aliasul `.ts.txt` trimis AI-ului —
    // în mapă ținem calea reală (`.ts`), ca invalidarea după scriere să nimerească
    const p = stripTsAliasPath(part.slice(0, sep).trim());
    const body = part.slice(sep + 4).trim();
    // fișierele SĂRITE (buget de payload) sau eronate NU au ajuns la AI
    if (!p || body.startsWith('[SKIPPED:') || body.startsWith('(error:')) continue;
    files.push([p, body]);
  }
  return files;
}

/** Reține fișierele citite (cele mai noi înlocuiesc versiunea veche). */
export function recordReadFiles(
  files: Map<string, string>,
  call: ToolCall,
  result: ToolResult
): void {
  for (const [p, content] of extractReadFiles(call, result)) {
    if (!files.has(p) && files.size >= MAX_TRACKED_FILES) continue;
    files.set(
      p,
      content.length > MAX_TRACKED_CHARS
        ? content.slice(0, MAX_TRACKED_CHARS)
        : content
    );
  }
}

/** Fișierele atinse de o scriere/ștergere — extrasul lor devine învechit. */
export function extractTouchedFiles(call: ToolCall): string[] {
  const args: any = call.args ?? {};
  if (
    call.tool === 'write_file' ||
    call.tool === 'edit_file' ||
    // v2.5.42 (bug #98): și fișierele șterse ies din handoff
    call.tool === 'delete_file' ||
    call.tool === 'delete_directory'
  ) {
    return typeof args.path === 'string' && args.path ? [args.path] : [];
  }
  if (call.tool === 'write_files' && Array.isArray(args.files)) {
    return args.files
      .map((f: any) => (typeof f?.path === 'string' ? f.path : ''))
      .filter((p: string) => !!p);
  }
  return [];
}

/** Scoate din handoff fișierele modificate (conținutul citit e depășit). */
export function invalidateTouchedFiles(
  files: Map<string, string>,
  call: ToolCall
): void {
  for (const p of extractTouchedFiles(call)) {
    files.delete(p);
    // v2.5.42 (bug #98): un folder șters duce cu el tot ce era sub el
    if (call.tool === 'delete_directory') {
      const prefix = p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      for (const key of [...files.keys()]) {
        if (key.replace(/\\/g, '/').startsWith(prefix)) files.delete(key);
      }
    }
  }
}

/**
 * Lista inline „Already read: …" — intră în corpul handoff-ului (deci
 * supraviețuiește trunchierii lui), ca modelul să nu ceară re-citirea.
 * v2.5.27 (bug #63): căile TS apar cu aliasul `.ts.txt` (cum le-a văzut AI-ul).
 */
export function formatReadFilesList(files: Map<string, string>): string {
  if (!files.size) return '';
  const shown: string[] = [];
  let chars = 0;
  for (const p of files.keys()) {
    const aiPath = toAiPath(p);
    if (shown.length >= MAX_LISTED_PATHS) break;
    if (chars + aiPath.length > MAX_PATH_LIST_CHARS) break;
    shown.push(aiPath);
    chars += aiPath.length + 2;
  }
  if (!shown.length) return '';
  const rest = files.size - shown.length;
  return (
    'Already read in this task — do NOT re-read these files: ' +
    shown.join(', ') +
    (rest > 0 ? ', … (+' + rest + ' more)' : '') +
    '.'
  );
}

/** Trunchiere head+tail (ca payload.ts): începutul + sfârșitul, nu doar capul. */
function headTail(text: string, max: number): string {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  const marker = '\n…\n';
  const head = Math.max(1, Math.floor((max - marker.length) * 0.6));
  const tail = Math.max(1, max - marker.length - head);
  return t.slice(0, head) + marker + t.slice(-tail);
}

/**
 * Extrasele (head+tail) ale fișierelor citite — așa chatul nou primește chiar
 * conținutul, nu doar numele fișierelor. Buget total mărginit, ca paste-ul de
 * la rotire să rămână mic.
 * v2.5.27 (bug #63): fișierele TS se trimit și aici ca `.ts.txt` (+ notă).
 */
export function formatReadFilesExcerpts(
  files: Map<string, string>,
  maxTotal: number = MAX_EXCERPT_TOTAL,
  maxPerFile: number = MAX_EXCERPT_PER_FILE
): string {
  if (!files.size) return '';
  const parts: string[] = [];
  let budget = maxTotal;
  for (const [p, content] of files) {
    if (budget < MIN_EXCERPT_BUDGET) break;
    const body = headTail(content, Math.min(maxPerFile, budget));
    if (!body) continue;
    const aiPath = toAiPath(p);
    const block =
      '--- FILE: ' + aiPath + ' ---' +
      (aiPath === p ? '' : '\n' + TS_ALIAS_NOTE) +
      '\n' + body;
    parts.push(block);
    budget -= block.length;
  }
  if (!parts.length) return '';
  return (
    'Excerpts (head + tail, as read in the previous chat) of the files already read:\n' +
    parts.join('\n\n')
  );
}
