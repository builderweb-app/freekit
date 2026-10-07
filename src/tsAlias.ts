/* =========================================================================
 * v2.5.27 (bug #63) — fișierele TypeScript se trimit AI-ului ca `.txt`
 *
 * ChatGPT refuză să proceseze fișiere `.ts` (limitare OpenAI la nivel de
 * backend), deși acceptă `.js`, `.py` etc. Când trimitem conținutul unui
 * fișier TypeScript către AI, îl etichetăm cu un alias `.txt`
 * (`src/foo.ts` → `src/foo.ts.txt`) plus o notă în antet; calea originală
 * rămâne în registrul de mai jos, iar aliasul primit înapoi de la AI
 * (read_file / write_file / edit_file / read_files / write_files / copy_file)
 * e tradus în calea reală din workspace, ca fișierul de pe disc să rămână
 * `src/foo.ts`.
 *
 * Modul pur (fără `vscode`), ca logica să fie ușor de verificat.
 * ========================================================================= */

/** Extensiile TypeScript cărora li se aplică aliasul `.txt`. */
const TS_EXT_RE = /\.(ts|tsx|mts|cts)$/i;
/** Aliasul adăugat la citire și primit înapoi de la AI. */
const ALIAS_SUFFIX = '.txt';
/** Alias complet de fișier TypeScript: `X.ts.txt`, `X.tsx.txt`, … */
const TS_ALIAS_RE = /\.(ts|tsx|mts|cts)\.txt$/i;

/** Nota din antet, ca modelul să știe că fișierul e de fapt cod TypeScript. */
export const TS_ALIAS_NOTE =
  '(TypeScript file, sent as .txt for compatibility)';

/** alias (`src/foo.ts.txt`) → calea originală (`src/foo.ts`) */
const aliasToOriginal = new Map<string, string>();

/** Mesaje de log în așteptare — drenate de chatView (care are canalul Output). */
const pendingLogs: string[] = [];
/** Aceeași traducere nu se loghează de două ori (parserul poate rula de 2 ori). */
const loggedMessages = new Set<string>();

/** Separatorii uniformizați (`\` și `/` trebuie să dea același alias). */
function normPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/');
}

export function isTypeScriptPath(p: string): boolean {
  return TS_EXT_RE.test(normPath(p));
}

/** true dacă path-ul e un alias `.txt` de TypeScript (`src/foo.ts.txt`). */
export function isTsAliasPath(p: string): boolean {
  return TS_ALIAS_RE.test(normPath(p));
}

/**
 * Calea cu care fișierul e trimis AI-ului: pentru TypeScript,
 * `src/foo.ts` → `src/foo.ts.txt` (reținută în registru); altfel calea dată.
 */
export function toAiPath(p: string): string {
  const raw = String(p ?? '');
  const rel = normPath(raw);
  if (!isTypeScriptPath(rel)) return raw;
  const alias = rel + ALIAS_SUFFIX;
  aliasToOriginal.set(alias, rel);
  return alias;
}

/** Antetul secțiunii trimise AI-ului (`--- FILE: src/foo.ts.txt ---` + notă). */
export function toAiFileHeader(p: string): string {
  const alias = toAiPath(p);
  const note = alias === p || alias === normPath(p) ? '' : '\n' + TS_ALIAS_NOTE;
  return '--- FILE: ' + alias + ' ---' + note;
}

/**
 * Traduce aliasul primit de la AI înapoi în calea din workspace:
 * `src/foo.ts.txt` → `src/foo.ts` (din registru, dacă a fost înregistrat la
 * citire, altfel prin tăierea sufixului `.txt`). Orice altă cale rămâne
 * neschimbată (separatorii originali incluși).
 */
export function stripTsAliasPath(p: string): string {
  const raw = String(p ?? '');
  if (!raw) return raw;
  const rel = normPath(raw);
  const registered = aliasToOriginal.get(rel);
  if (registered) return registered;
  if (TS_ALIAS_RE.test(rel)) return rel.slice(0, -ALIAS_SUFFIX.length);
  return raw;
}

/**
 * v2.5.27 FIX 3: elimină aliasurile din textul AFIȘAT utilizatorului (nu din
 * cel trimis AI-ului) — `src/foo.ts.txt` → `src/foo.ts`.
 */
export function stripTsAliasesInText(text: string): string {
  return String(text ?? '').replace(
    /([\w./\\-]+)\.(ts|tsx|mts|cts)\.txt/gi,
    '$1.$2'
  );
}

export interface TsAliasMapping {
  alias: string;
  original: string;
  op: 'read' | 'write';
}

/** Uneltele cu o singură cale în `args.path`. */
const PATH_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  // v2.5.42 (bug #98): AI-ul vede fișierele TS ca `.ts.txt`, deci și ștergerea
  // trebuie tradusă înapoi în calea reală
  'delete_file'
]);

/**
 * v2.5.27 (bug #63) FIX 2: traduce căile-alias primite de la AI în căile reale,
 * pentru uneltele care lucrează cu fișiere. Întoarce args noi doar când s-a
 * schimbat ceva (obiectul original rămâne neatins altfel).
 */
export function mapToolCallAliases(
  tool: string,
  args: Record<string, any> | undefined
): { args: Record<string, any> | undefined; mappings: TsAliasMapping[] } {
  const a = args ?? {};
  const op: 'read' | 'write' = tool.startsWith('read') ? 'read' : 'write';
  const mappings: TsAliasMapping[] = [];
  const fix = (p: string): string => {
    const original = stripTsAliasPath(p);
    if (original !== p) mappings.push({ alias: p, original, op });
    return original;
  };

  if (PATH_TOOLS.has(tool) && typeof a.path === 'string' && a.path) {
    const path = fix(a.path);
    return { args: path === a.path ? a : { ...a, path }, mappings };
  }

  // v2.5.50 FIX 3: copy_file are DOUĂ căi — sursa și destinația
  if (tool === 'copy_file') {
    const next: Record<string, any> = { ...a };
    let changed = false;
    for (const key of ['from', 'to']) {
      const p = a[key];
      if (typeof p !== 'string' || !p) continue;
      const original = fix(p);
      if (original !== p) {
        changed = true;
        next[key] = original;
      }
    }
    return changed ? { args: next, mappings } : { args: a, mappings };
  }

  if (tool === 'read_files' && Array.isArray(a.paths)) {
    let changed = false;
    const paths = a.paths.map((p: any) => {
      if (typeof p !== 'string' || !p) return p;
      const original = fix(p);
      if (original !== p) changed = true;
      return original;
    });
    return { args: changed ? { ...a, paths } : a, mappings };
  }

  if (tool === 'write_files' && Array.isArray(a.files)) {
    let changed = false;
    const files = a.files.map((f: any) => {
      if (!f || typeof f.path !== 'string' || !f.path) return f;
      const original = fix(f.path);
      if (original !== f.path) {
        changed = true;
        return { ...f, path: original };
      }
      return f;
    });
    return { args: changed ? { ...a, files } : a, mappings };
  }

  return { args, mappings };
}

/** Loghează (o singură dată) o traducere alias → cale reală. */
export function queueAliasLog(mapping: TsAliasMapping): void {
  const msg =
    'mapped ' + mapping.alias + ' → ' + mapping.original + ' for ' + mapping.op;
  if (loggedMessages.has(msg)) return;
  loggedMessages.add(msg);
  pendingLogs.push(msg);
}

/** Mesajele de log acumulate (le golește). */
export function drainAliasLogs(): string[] {
  return pendingLogs.splice(0, pendingLogs.length);
}
