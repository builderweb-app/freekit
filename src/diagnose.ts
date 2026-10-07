import * as fs from 'fs';
import * as path from 'path';
import { logLine } from './log';

/* =========================================================================
 * v2.5.53 — DIAGNOSTIC RIGUROS (error parser + root-cause tracer)
 *
 * Problema rezolvată: după o verificare eșuată, output-ul brut al compilatorului
 * pleca la model, care răspundea cu presupuneri („cred că e builtPageKeys"),
 * cerea un screenshot (inutil — eroarea e în cod, nu în pagină) sau punea un
 * band-aid (`?.` / `|| []`) care ascundea simptomul și lăsa cauza în loc.
 *
 * Aici: (1) parsăm eroarea în structură, (2) urmărim cauza reală până la sursa
 * de date, (3) construim un context COMPACT (FIX 3) cu fix-ul exact cerut, (4)
 * detectăm fix-urile band-aid (FIX 6) ca să le putem respinge.
 * ========================================================================= */

/** Timestamp compact, sigur ca nume de fișier (ex: 20261008-120000). */
function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/** Folderul (relativ la rădăcina workspace-ului) cu rapoartele de diagnostic. */
export const DIAGNOSTICS_DIR = 'docs/diagnostics';

/** O eroare parsată dintr-un output de compilator/build. */
export interface ParsedError {
  /** Cale relativă la rădăcina workspace-ului, cu „/". */
  file: string;
  line: number;
  col: number;
  /** „TypeError" / „TS2304" / „SyntaxError" / ... */
  type: string;
  /** Mesajul, curățat de prefixul de fișier. */
  message: string;
  /** Lanțul de acces din linia sursă (ex: „pkg.priceDetails.map"). */
  expression?: string;
  /** Variabila care e `undefined` la rulare (ex: „priceDetails"). */
  variable?: string;
  /** Deținătorul variabilei (ex: „pkg"). */
  parent?: string;
}

/* -------------------------------------------------------------------------
 * FIX 7 — biblioteca de pattern-uri (cele 10 erori frecvente + tracer-ul lor)
 * ------------------------------------------------------------------------- */

export type PatternKind =
  | 'missing-array'
  | 'missing-object'
  | 'missing-property'
  | 'module-not-found'
  | 'syntax'
  | 'type-mismatch'
  | 'missing-name'
  | 'possibly-undefined'
  | 'not-defined'
  | 'unclosed';

export interface ErrorPattern {
  kind: PatternKind;
  test: RegExp;
  /** Tracer-ul (ce căutăm) — apare în log și în contextul trimis modelului. */
  tracer: string;
}

/** Ordinea contează: pattern-urile specifice înaintea celor generice. */
export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  {
    kind: 'missing-array',
    test: /Cannot read propert(?:y|ies) of undefined \(reading '(?:map|filter|forEach|reduce|length|slice|join|find|some|every|sort|includes)'\)/,
    tracer: 'find the missing array in the data source (the collection must exist on every item)'
  },
  {
    kind: 'missing-object',
    test: /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']+)'\)/,
    tracer: 'find the missing object/field in the data source'
  },
  {
    kind: 'missing-property',
    test: /Property '([^']+)' does not exist on type '([^']+)'|Object literal may only specify known properties, and '([^']+)' does not exist in type/,
    tracer: 'add the declared field to the interface/type'
  },
  {
    kind: 'module-not-found',
    test: /(?:Cannot find module|Module not found|Failed to resolve import|Could not resolve) ['"`]?([^'"`\s)]+)/,
    tracer: 'verify the import path (exact file name + extension)'
  },
  {
    kind: 'unclosed',
    test: /Unexpected end of (?:file|input)|Unterminated/,
    tracer: 'find the unclosed brace/paren/bracket'
  },
  {
    kind: 'syntax',
    test: /Unexpected token|Expected [^,]*but found|Expression expected|Unexpected (?:identifier|character)/,
    tracer: 'check the braces/parentheses around the reported position'
  },
  {
    kind: 'type-mismatch',
    test: /Type '([^']+)' is not assignable to type '([^']+)'/,
    tracer: 'reconcile the declared type with the assigned value'
  },
  {
    kind: 'missing-name',
    test: /Cannot find name '([^']+)'/,
    tracer: 'add the missing import/declaration'
  },
  {
    kind: 'possibly-undefined',
    test: /is possibly 'undefined'|Object is possibly 'undefined'/,
    tracer: 'add a REAL null check (early return / guard), not a silent default'
  },
  {
    kind: 'not-defined',
    test: /([A-Za-z_$][\w$]*) is not defined/,
    tracer: 'declare/import the variable'
  }
];

/** Pattern-ul potrivit pentru mesajul dat (sau undefined). */
export function matchPattern(message: string): ErrorPattern | undefined {
  const msg = String(message ?? '');
  return ERROR_PATTERNS.find((p) => p.test.test(msg));
}

/* -------------------------------------------------------------------------
 * FIX 1 — PARSER (Astro/Vite, TypeScript, Node)
 * ------------------------------------------------------------------------- */

const EXT = 'astro|vue|svelte|tsx|ts|jsx|js|mjs|cjs|html';

/** Normalizează o cale (absolută / file:// / URL) la cale relativă cu „/". */
function normalizeFile(raw: string, root: string): string {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    } catch {
      /* rămâne valoarea brută */
    }
  }
  // prefix Vite („/src/..." sau „/@fs/...") → scoate-l
  value = value.replace(/^\/@fs\//, '/');
  const abs = path.isAbsolute(value) ? value : path.resolve(root, value);
  const rel = path.relative(root, abs);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : value).replace(/\\/g, '/');
}

/**
 * Parsează output-ul unei verificări. Returnează TOATE erorile găsite, în
 * ordinea apariției (prima e de obicei cauza).
 */
export function parseErrors(output: string, root = ''): ParsedError[] {
  const text = String(output ?? '');
  const lines = text.split(/\r?\n/);
  const out: ParsedError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) TypeScript: src/foo.ts(12,5): error TS2304: Cannot find name 'X'.
    const ts = line.match(
      new RegExp('^\\s*(?:[A-Za-z]:)?([^\\s(]*\\.(?:' + EXT + '))\\((\\d+),(\\d+)\\):\\s*(?:error|warning)?\\s*(TS\\d+)?:?\\s*(.*)$')
    );
    if (ts) {
      const type = ts[4] ?? 'Error';
      const message = ts[5].trim();
      out.push(
        withChain(
          {
            file: normalizeFile(ts[1], root),
            line: Number(ts[2]),
            col: Number(ts[3]),
            type,
            message
          },
          root
        )
      );
      continue;
    }

    // 2) Astro/Vite: pages/CreareSite.astro:127:33 (mesajul poate fi pe linia de dinainte)
    const vite = line.match(
      new RegExp('([^\\s(]+\\.(?:' + EXT + ')):(\\d+):(\\d+)')
    );
    if (vite) {
      const file = normalizeFile(vite[1], root);
      const message = nearestMessage(lines, i);
      const type = errorTypeOf(message);
      out.push(
        withChain(
          {
            file,
            line: Number(vite[2]),
            col: Number(vite[3]),
            type,
            message
          },
          root
        )
      );
      continue;
    }

    // 3) Node stack: at Object.<anonymous> (/abs/file.ts:12:5)
    const node = line.match(
      new RegExp('at\\s+(?:[^\\s(]+\\s+\\()?([^\\s():]+\\.(?:' + EXT + ')):(\\d+):(\\d+)')
    );
    if (node) {
      const message = nearestMessage(lines, i);
      out.push(
        withChain(
          {
            file: normalizeFile(node[1], root),
            line: Number(node[2]),
            col: Number(node[3]),
            type: errorTypeOf(message),
            message
          },
          root
        )
      );
    }
  }

  return dedupe(out);
}

/** Mesajul cel mai apropiat deasupra liniei de locație („TypeError: ..."). */
function nearestMessage(lines: string[], index: number): string {
  for (let i = index - 1; i >= 0 && i >= index - 4; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^(?:error|cause)\b/i.test(l)) continue;
    return l.replace(/^\s*(?:\d+\s*\|\s*)?/, '').trim();
  }
  return lines[index].trim();
}

/** „TypeError: Cannot read ..." → „TypeError"; „error TS2304: ..." → „TS2304". */
function errorTypeOf(message: string): string {
  const ts = message.match(/\b(TS\d{4})\b/);
  if (ts) return ts[1];
  const named = message.match(/^([A-Za-z]*Error)\b/);
  if (named) return named[1];
  return 'Error';
}

/**
 * Completează `expression` / `variable` / `parent` din linia indicată de eroare.
 * Pentru „reading 'map'" caută lanțul `.map` din linie și îl extinde spre stânga
 * („pkg.priceDetails.map" → variable „priceDetails", parent „pkg").
 */
function withChain(err: ParsedError, root: string): ParsedError {
  const prop = err.message.match(/reading '([^']+)'/)?.[1];
  if (!prop || !err.file) return err;
  const source = readSourceFile(root, err.file);
  if (!source) return err;
  const srcLine = source.split(/\r?\n/)[err.line - 1] ?? '';
  const chain = extractChain(srcLine, prop);
  if (!chain) return err;
  const parts = chain.split('.');
  const expression = parts.join('.');
  const variable = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const parent = parts[0];
  return { ...err, expression, variable, parent };
}

/** Extinde spre stânga lanțul de acces care se termină cu `.prop`. */
export function extractChain(line: string, prop: string): string | undefined {
  const needle = '.' + prop;
  const idx = line.lastIndexOf(needle);
  if (idx < 0) return undefined;
  let start = idx;
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = line[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
      start = i;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) break;
      depth--;
      start = i;
      continue;
    }
    if (depth > 0) {
      start = i;
      continue;
    }
    if (/[A-Za-z0-9_$.'"\-\s]/.test(c)) {
      start = i;
      continue;
    }
    break;
  }
  const raw = line.slice(start, idx + needle.length).trim();
  const chain = raw.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/)?.[0];
  return chain;
}

function dedupe(errors: ParsedError[]): ParsedError[] {
  const seen = new Set<string>();
  const out: ParsedError[] = [];
  for (const e of errors) {
    const key = parsedSignature(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Semnătura unei erori — pentru „aceeași eroare?" între două cicluri. */
export function parsedSignature(e: ParsedError | undefined): string {
  if (!e) return '';
  return [e.type, e.file, e.message.replace(/\s+/g, ' ').trim()].join('|');
}

/* -------------------------------------------------------------------------
 * FIX 2 / FIX 7 — ROOT CAUSE TRACER
 * ------------------------------------------------------------------------- */

export interface VariantState {
  name: string;
  /** false = array-ul lipsește complet din varianta respectivă. */
  present: boolean;
  /** true = toate elementele au câmpul căutat. */
  ok: boolean;
  elements: Array<{ index: number; ok: boolean }>;
}

export interface RootCause {
  kind: PatternKind;
  /** O linie scurtă, pentru log: „3 packages missing 'priceDetails' (en, de, fr)". */
  summary: string;
  /** Explicația trimisă modelului: „some packages in t.pret.packages are missing ...". */
  description: string;
  /** Fișierul cu sursa de date (dacă a fost găsit). */
  sourceFile?: string;
  /** Starea per variantă (limbă) — doar pentru missing-array/object. */
  variants: VariantState[];
  /** Fix-ul EXACT cerut modelului. */
  fix: string;
}

export interface Diagnosis {
  error: ParsedError;
  /** Snippet brut (cap + coadă) — păstrat pentru contexte neprevăzute. */
  raw: string;
  rootCause?: RootCause;
}

/** Citește un fișier din workspace (relativ la `root`), best-effort. */
function readSourceFile(root: string, rel: string): string | undefined {
  if (!rel) return undefined;
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

/** Rezolvă un specifier de import la un fișier real din workspace. */
function resolveModule(fromFileAbs: string, spec: string, root: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(root, 'src', spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.resolve(path.dirname(fromFileAbs), spec);
  } else if (path.isAbsolute(spec)) base = spec;
  else return undefined;

  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'].map((e) => base + e),
    ...['.ts', '.tsx', '.js'].map((e) => path.join(base, 'index' + e))
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* nu există */
    }
  }
  return undefined;
}

/** Numele unui fișier compilat (pentru log-uri): relativ la root, cu „/". */
function relOf(abs: string, root: string): string {
  const rel = path.relative(root, abs);
  return (rel.startsWith('..') ? abs : rel).replace(/\\/g, '/');
}

/* --- scanner tolerant (sare peste string-uri și comentarii) --- */

interface ScanResult {
  /** Indexul caracterului de închidere (inclusiv), sau -1. */
  end: number;
  /** Textul dintre delimitatori. */
  inner: string;
}

function scanBalanced(text: string, start: number, open: string, close: string): ScanResult {
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { end: i, inner: text.slice(start + 1, i) };
    }
  }
  return { end: -1, inner: text.slice(start + 1) };
}

/** Împarte conținutul unui array/obiect în elemente de nivel 0. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const n = inner[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start);
  if (last.trim()) parts.push(last);
  return parts;
}

/**
 * Găsește membrul `key` la nivel 0 în interiorul unui obiect și întoarce
 * textul valorii (obiectele/array-urile INCLUSIV delimitatorii), sau undefined.
 */
function findMember(objInner: string, key: string): string | undefined {
  const re = new RegExp('(?:^|[\\s,{])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(objInner))) {
    const at = m.index + m[0].length - 1;
    if (depthAt(objInner, at) !== 0) continue;
    const rest = objInner.slice(at + 1).trimStart();
    const first = rest[0];
    if (first === '{') {
      const r = scanBalanced(rest, 0, '{', '}');
      return r.end < 0 ? undefined : rest.slice(0, r.end + 1);
    }
    if (first === '[') {
      const r = scanBalanced(rest, 0, '[', ']');
      return r.end < 0 ? undefined : rest.slice(0, r.end + 1);
    }
    // scalar / identificator: până la virgulă sau acoladă de nivel 0
    const stop = rest.search(/[,}]/);
    return (stop < 0 ? rest : rest.slice(0, stop)).trim();
  }
  return undefined;
}

/** Interiorul unui obiect/array (fără delimitatori); altfel textul ca atare. */
function memberInner(value: string): string {
  const t = value.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1);
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1);
  return t;
}

/** Sare peste comentariile de la începutul unui element („/* EN *​/ en: {"). */
function stripLeadingComments(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*[\r\n]?)/, '');
    if (next === out) return out;
    out = next;
  }
}

/** Adâncimea de imbricare la poziția dată (0 = nivelul obiectului). */
function depthAt(text: string, index: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < index && i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return depth;
}

/** Obiectele „variantă" dintr-un modul de date (ex: en/de/fr/es/it). */
interface Variant {
  name: string;
  /** Textul obiectului-variantă (fără acolade). */
  obj?: string;
  /** Modulul în care trăiește varianta. */
  moduleAbs: string;
}

const LANG_KEY = /^("?)([a-z]{2}(?:-[A-Za-z]{2})?)\1$/;

/**
 * Extrage variantele dintr-un modul: fie cheile unui `Record<Lang, X>` agregat
 * (en/de/fr…), fie fiecare `export const <nume> = {…}` de la nivel superior.
 */
function collectVariants(moduleAbs: string, text: string, root: string): Variant[] {
  const variants: Variant[] = [];
  // plafon de siguranță: un modul de date are câteva variante, nu sute
  if (text.length > 400_000) return variants;
  const exportRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*[^=]*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(text))) {
    if (variants.length >= 40) break;
    const objStart = m.index + m[0].length - 1;
    const scanned = scanBalanced(text, objStart, '{', '}');
    if (scanned.end < 0) continue;
    const keys = splitTopLevel(scanned.inner)
      .map((item) =>
        stripLeadingComments(item).match(/^\s*(?:"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*:/)
      )
      .map((m) => m?.[1] ?? m?.[2])
      .filter((k): k is string => !!k);
    const langKeys = keys.filter((k) => LANG_KEY.test(k));
    if (langKeys.length >= 2) {
      // agregat Record<Lang, X> = { en: {...} / en: sharedConst, ... }
      for (const item of splitTopLevel(scanned.inner)) {
        const kv = stripLeadingComments(item).match(
          /^\s*(?:"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*:/
        );
        if (!kv) continue;
        const name = kv[1] ?? kv[2];
        const value = findMember(scanned.inner, name);
        variants.push(resolveVariant(name, value, moduleAbs, text, root));
      }
      continue;
    }
    // fiecare export e o variantă (ex: `export const en = {...}`)
    variants.push({ name: m[1], obj: scanned.inner, moduleAbs });
  }
  return variants;
}

/** Varianta poate fi un identificator importat („en: creareSiteEn"). */
function resolveVariant(
  name: string,
  value: string | undefined,
  moduleAbs: string,
  text: string,
  root: string
): Variant {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return { name, moduleAbs };
  if (trimmed.startsWith('{')) {
    return { name, obj: memberInner(trimmed), moduleAbs };
  }
  const ident = trimmed.match(/^([A-Za-z_$][\w$]*)$/)?.[1];
  if (!ident) return { name, moduleAbs };
  // identificator: definit local sau importat
  const local = text.match(
    new RegExp('(?:^|\\n)\\s*(?:export\\s+)?const\\s+' + ident + '\\s*[^=]*=\\s*\\{')
  );
  if (local) {
    const at = local.index! + local[0].length - 1;
    const scanned = scanBalanced(text, at, '{', '}');
    if (scanned.end >= 0) return { name, obj: scanned.inner, moduleAbs };
  }
  const imp = text.match(
    new RegExp("import\\s*\\{[^}]*\\b" + ident + "\\b[^}]*\\}\\s*from\\s*['\"]([^'\"]+)['\"]")
  );
  if (imp) {
    const target = resolveModule(moduleAbs, imp[1], root);
    if (target) {
      const targetText = readSourceFile(root, target) ?? '';
      const decl = targetText.match(
        new RegExp('(?:^|\\n)\\s*(?:export\\s+)?const\\s+' + ident + '\\s*[^=]*=\\s*\\{')
      );
      if (decl) {
        const at = decl.index! + decl[0].length - 1;
        const scanned = scanBalanced(targetText, at, '{', '}');
        if (scanned.end >= 0) return { name, obj: scanned.inner, moduleAbs: target };
      }
      return { name, moduleAbs: target };
    }
  }
  return { name, moduleAbs };
}

/**
 * Urmărește cauza reală a unei erori. Momentan tratează în profunzime
 * `missing-array` / `missing-object` (câmp lipsă în sursa de date) și dă
 * indicații exacte pentru celelalte pattern-uri din FIX 7.
 */
export function traceRootCause(err: ParsedError, root: string): RootCause | undefined {
  const pattern = matchPattern(err.message);
  const kind: PatternKind = pattern?.kind ?? 'missing-object';

  switch (kind) {
    case 'missing-array':
    case 'missing-object':
      return traceMissingMember(err, root, kind);
    case 'missing-property':
      return traceMissingProperty(err, root);
    case 'missing-name':
    case 'not-defined':
      return traceUndefinedName(err, root, kind);
    case 'module-not-found':
      return traceMissingModule(err, root);
    case 'unclosed':
    case 'syntax':
      return traceSyntax(err, root, kind);
    case 'type-mismatch': {
      const m = err.message.match(/Type '([^']+)' is not assignable to type '([^']+)'/);
      return {
        kind,
        summary: 'type mismatch: ' + (m?.[1] ?? '?') + ' → ' + (m?.[2] ?? '?'),
        description: pattern?.tracer ?? 'the assigned value does not match the declared type',
        variants: [],
        fix:
          'Make the value match the declared type (' + (m?.[2] ?? 'the target type') +
          ') — or widen the type honestly. Do NOT cast with `as any`.'
      };
    }
    case 'possibly-undefined':
      return {
        kind,
        summary: 'value possibly undefined',
        description: pattern?.tracer ?? 'the value may be undefined on this path',
        variants: [],
        fix:
          'Add a REAL null check on the exact value (early return / guard clause) and handle the ' +
          'missing case. Do NOT silence it with `?.` on `.map()` or with `|| []`.'
      };
    default:
      return undefined;
  }
}

/** missing-array / missing-object: câmp lipsă în elementele sursei de date. */
function traceMissingMember(
  err: ParsedError,
  root: string,
  kind: PatternKind
): RootCause | undefined {
  const fileAbs = path.join(root, err.file);
  const text = readSourceFile(root, err.file);
  if (!text) return undefined;

  const chain = err.expression ?? '';
  const parts = chain ? chain.split('.') : [];
  const container = parts[0];
  const field = err.variable ?? (parts.length >= 2 ? parts[parts.length - 2] : undefined);
  if (!container || !field) return undefined;

  // unde e legat `container`? („t.pret.packages.map((pkg, i) =>")
  const binder = new RegExp(
    '\\.map\\s*\\(\\s*\\(?\\s*' + container + '\\b',
  ).exec(text);
  const arrayExpr = binder ? expressionBefore(text, binder.index) : undefined;
  const arrayPath = arrayExpr ? stripIndexes(arrayExpr) : '';
  const arrayBase = arrayPath.split('.')[0];
  const arrayProps = arrayPath.split('.').slice(1);

  // rezolvă sursa: `const t = creareSitePage[lang]` / import
  const sourceAbs = arrayBase ? resolveBaseModule(text, fileAbs, arrayBase, root) : undefined;
  const sourceRel = sourceAbs ? relOf(sourceAbs, root) : undefined;
  const sourceText = sourceAbs ? readSourceFile(root, sourceAbs) : undefined;

  const variants: VariantState[] = [];
  if (sourceAbs && sourceText) {
    for (const v of collectVariants(sourceAbs, sourceText, root)) {
      if (!v.obj) {
        variants.push({ name: v.name, present: false, ok: false, elements: [] });
        continue;
      }
      const state = inspectVariant(v.obj, arrayProps, field);
      variants.push({ name: v.name, ...state });
    }
  }

  const missingNames = variants.filter((v) => !v.ok).map((v) => v.name);
  const elementsMissing = variants.reduce(
    (n, v) => n + v.elements.filter((e) => !e.ok).length,
    0
  );
  const absent = variants.filter((v) => !v.present).length;
  const noun = kind === 'missing-array' ? 'array' : 'field';
  const where = arrayExpr || arrayPath || container;

  let summary: string;
  let description: string;
  if (variants.length && missingNames.length) {
    if (elementsMissing) {
      summary =
        elementsMissing +
        ' package' + (elementsMissing === 1 ? '' : 's') +
        " missing '" + field + "' (" + missingNames.join(', ') + ')';
    } else {
      summary =
        absent + ' variant' + (absent === 1 ? '' : 's') +
        " missing '" + field + "' (" + missingNames.join(', ') + ')';
    }
    description = 'some items in ' + where + " are missing '" + field + "'";
  } else if (variants.length) {
    summary = "all variants have '" + field + "' — look upstream (import/typing)";
    description =
      "'" + field + "' exists in the data source; the undefined value comes from elsewhere " +
      '(wrong variant, missing import, or a different object shape).';
  } else {
    summary = 'undefined ' + (chain || where) + ' at ' + err.file + ':' + err.line;
    description =
      'the ' + noun + " '" + field + "' is undefined on '" + where + "'";
  }

  const fix = variants.length && missingNames.length
    ? "Add '" + field + "' to the missing items in " + (sourceRel ?? 'the data source') +
      " (use the same item's existing 'details' array as reference). Do NOT add ?. or || []."
    : 'Trace where ' + (arrayExpr || container) + ' comes from, and make sure ' + field +
      ' is defined for every item. Fix the SOURCE, not the access site.';

  return {
    kind,
    summary,
    description,
    sourceFile: sourceRel,
    variants,
    fix
  };
}

/** Starea unei variante: array-ul există? fiecare element are câmpul? */
function inspectVariant(
  objInner: string,
  arrayProps: string[],
  field: string
): { present: boolean; ok: boolean; elements: Array<{ index: number; ok: boolean }> } {
  let current = objInner;
  for (const prop of arrayProps) {
    const next = findMember(memberInner(current), prop);
    if (next === undefined) return { present: false, ok: false, elements: [] };
    current = next;
  }
  if (!current.trim().startsWith('[')) {
    return { present: false, ok: false, elements: [] };
  }
  const items = splitTopLevel(memberInner(current));
  const elements = items.map((item, index) => ({
    index,
    ok: new RegExp('(?:^|[\\s,{])' + field + '\\s*:').test(item)
  }));
  return { present: true, ok: elements.every((e) => e.ok), elements };
}

/** Expresia care precede un `.map(` — ex: „t.pret.packages". */
function expressionBefore(text: string, mapIndex: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', mapIndex) + 1;
  const before = text.slice(lineStart, mapIndex);
  return before.match(/[A-Za-z_$][\w$]*(?:\[[^\]]*\])?(?:\.[A-Za-z_$][\w$]*)*$/)?.[0];
}

function stripIndexes(expr: string): string {
  return expr.replace(/\[[^\]]*\]/g, '');
}

/** Rezolvă identificatorul de bază la modulul care îl exportă. */
function resolveBaseModule(
  text: string,
  fileAbs: string,
  base: string,
  root: string
): string | undefined {
  const imp = text.match(
    new RegExp("import\\s*\\{[^}]*\\b" + base + "\\b[^}]*\\}\\s*from\\s*['\"]([^'\"]+)['\"]")
  );
  if (imp) return resolveModule(fileAbs, imp[1], root);
  const impDefault = text.match(
    new RegExp("import\\s+" + base + "\\s+from\\s+['\"]([^'\"]+)['\"]")
  );
  if (impDefault) return resolveModule(fileAbs, impDefault[1], root);
  // `const t = creareSitePage[lang]` → urcă un nivel
  const local = text.match(new RegExp('const\\s+' + base + '\\s*=\\s*([A-Za-z_$][\\w$]*)'));
  if (local && local[1] !== base) return resolveBaseModule(text, fileAbs, local[1], root);
  return undefined;
}

/** TS2339 / TS2353: adaugă câmpul în interfața/tipul care îl declară. */
function traceMissingProperty(err: ParsedError, root: string): RootCause | undefined {
  const ts2339 = err.message.match(/Property '([^']+)' does not exist on type '([^']+)'/);
  const ts2353 = err.message.match(
    /Object literal may only specify known properties, and '([^']+)' does not exist in type/
  );
  const field = ts2339?.[1] ?? ts2353?.[1];
  if (!field) return undefined;

  const text = readSourceFile(root, err.file) ?? '';
  let typeName = ts2339?.[2]?.replace(/<.*>$/, '');
  const inline = !!typeName && typeName.trim().startsWith('{');
  if (!typeName || inline) {
    typeName = enclosingTypeName(text, err.line) ?? 'the object type';
  }
  const decl = new RegExp('(?:interface|type)\\s+' + typeName + '\\b[^\\{]*\\{').test(text);
  return {
    kind: 'missing-property',
    summary: "property '" + field + "' missing on type '" + typeName + "'",
    description:
      'type ' + typeName + ' does not declare ' + field +
      ', but the code reads/writes it',
    sourceFile: err.file,
    variants: [],
    fix:
      "Add '" + field + "' to the " + typeName + ' declaration' +
      (decl ? ' (it is declared in ' + err.file + ')' : '') +
      '. Match the type of the data you actually render (e.g. `string[]`). Do NOT use `as any`.'
  };
}

/** Tipul/interfacea care acoperă linia dată (cel mai apropiat nume de deasupra). */
function enclosingTypeName(text: string, line: number): string | undefined {
  const before = stripComments(
    text.split(/\r?\n/).slice(0, Math.max(0, line)).join('\n')
  );
  const record = before.match(
    /const\s+[A-Za-z_$][\w$]*\s*:\s*Record\s*<[^>]*,\s*([A-Za-z_$][\w$]*)\s*>/
  );
  if (record) return record[1];
  const simple = before.match(/const\s+[A-Za-z_$][\w$]*\s*:\s*([A-Za-z_$][\w$]*)\s*=/);
  if (simple) return simple[1];
  const decls: string[] = [];
  const re = /(?:interface|type)\s+([A-Za-z_$][\w$]*)\s*(?:\{|=[^=])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) decls.push(m[1]);
  return decls[decls.length - 1];
}

/** Scoate comentariile (tolerant la string-uri), ca regex-urile să nu le prindă. */
function stripComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/** Cannot find name / is not defined → caută un export cu acel nume. */
function traceUndefinedName(
  err: ParsedError,
  root: string,
  kind: PatternKind
): RootCause | undefined {
  const name =
    err.message.match(/Cannot find name '([^']+)'/)?.[1] ??
    err.message.match(/([A-Za-z_$][\w$]*) is not defined/)?.[1];
  if (!name) return undefined;
  const found = findExportedName(root, name);
  return {
    kind,
    summary: "'" + name + "' is not defined",
    description: found
      ? "'" + name + "' is exported by " + found + ' but is not imported here'
      : "'" + name + "' is not declared/imported in " + err.file,
    sourceFile: found ?? err.file,
    variants: [],
    fix: found
      ? "Add the missing import from '" + found + "' (exact path)."
      : "Declare or import '" + name + "'. Check for a typo first."
  };
}

/** Caută (best-effort) fișierul care exportă numele dat. */
function findExportedName(root: string, name: string): string | undefined {
  const needle = new RegExp(
    'export\\s+(?:const|let|var|function|class|interface|type|enum)\\s+' + name + '\\b'
  );
  const queue = [path.join(root, 'src')];
  const skip = new Set(['node_modules', 'dist', '.git', 'out', '.astro']);
  let visited = 0;
  while (queue.length && visited < 2000) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!/\.(?:ts|tsx|js|mjs|astro)$/.test(entry.name)) continue;
      if (++visited > 2000) break;
      try {
        if (needle.test(fs.readFileSync(full, 'utf8'))) return relOf(full, root);
      } catch {
        /* ignoră */
      }
    }
  }
  return undefined;
}

/** Module not found → propune cea mai apropiată cale existentă. */
function traceMissingModule(err: ParsedError, root: string): RootCause | undefined {
  const m = err.message.match(/['"`]([^'"`]+)['"`]/);
  const spec = m?.[1];
  if (!spec) return undefined;
  const fromAbs = path.join(root, err.file);
  const guessed = resolveModule(fromAbs, spec, root);
  return {
    kind: 'module-not-found',
    summary: "module not found: '" + spec + "'",
    description:
      "the import '" + spec + "' in " + err.file + ' does not resolve' +
      (guessed ? ' — closest existing file: ' + relOf(guessed, root) : ''),
    sourceFile: guessed ? relOf(guessed, root) : err.file,
    variants: [],
    fix: guessed
      ? "Point the import at the real path ('" + relOf(guessed, root) + "')."
      : "Verify the exact file name/extension and the relative path from " + err.file + '.'
  };
}

/** Unclosed / syntax → raportează dezechilibrul de paranteze. */
function traceSyntax(
  err: ParsedError,
  root: string,
  kind: PatternKind
): RootCause | undefined {
  const text = readSourceFile(root, err.file) ?? '';
  const balance = bracketBalance(text);
  const detail = balance
    ? 'unbalanced ' + balance.open + ' (' + balance.delta + ' more close than open)'
    : undefined;
  return {
    kind,
    summary: detail ?? 'syntax error at ' + err.file + ':' + err.line,
    description: detail
      ? 'the file has ' + detail
      : 'invalid syntax at ' + err.file + ':' + err.line,
    sourceFile: err.file,
    variants: [],
    fix:
      'Fix the code structure at the reported position' +
      (detail ? ' — close/reopen the ' + detail + '.' : '.') +
      ' Do NOT delete code to make the error disappear.'
  };
}

function bracketBalance(text: string): { open: string; delta: number } | undefined {
  const pairs: Array<[string, string, string]> = [
    ['{', '}', 'acolade'],
    ['(', ')', 'paranteze'],
    ['[', ']', 'paranteze pătrate']
  ];
  const counts = new Map<string, number>();
  for (const [open] of pairs) counts.set(open, 0);
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    for (const [open, close] of pairs) {
      if (c === open) counts.set(open, counts.get(open)! + 1);
      else if (c === close) counts.set(open, counts.get(open)! - 1);
    }
  }
  for (const [open, , label] of pairs) {
    const delta = counts.get(open)!;
    if (delta !== 0) return { open: label, delta };
  }
  return undefined;
}

/* -------------------------------------------------------------------------
 * FIX 14 — PERSISTAREA DIAGNOSTICULUI (docs/diagnostics/<timestamp>.md)
 * ------------------------------------------------------------------------- */

export interface DiagnosisRecord {
  /** Fix-urile încercate, în ordine (ex: „cycle 1: edit_file src/i18n/page.ts"). */
  attempts: string[];
  /** Rezultatul final: „FIXED in 2 cycles" / „rolled back" / „unfixed". */
  outcome: string;
}

/**
 * Scrie raportul diagnosticului în `docs/diagnostics/<timestamp>.md`:
 * eroarea originală, cauza reală, fix-urile încercate și rezultatul final.
 * Best-effort; întoarce calea relativă scrisă, sau undefined la eșec.
 */
export function writeDiagnosisReport(
  root: string,
  d: Diagnosis,
  record: DiagnosisRecord
): string | undefined {
  try {
    const e = d.error;
    const rc = d.rootCause;
    const lines: string[] = [];
    lines.push('# Diagnostic — ' + timestamp());
    lines.push('');
    lines.push('## Error');
    lines.push('');
    lines.push('- **Type:** ' + e.type);
    lines.push('- **Location:** ' + (e.file || '(unknown)') + ':' + e.line);
    if (e.expression) lines.push('- **Expression:** `' + e.expression + '`');
    lines.push('- **Message:** ' + e.message);
    lines.push('');
    lines.push('## Root cause');
    lines.push('');
    lines.push(rc ? rc.description : '(not traced)');
    if (rc?.sourceFile) lines.push('');
    if (rc?.sourceFile) lines.push('- **Source file:** `' + rc.sourceFile + '`');
    if (rc?.variants.length) {
      lines.push('');
      lines.push('| variant | state |');
      lines.push('| --- | --- |');
      for (const v of rc.variants) {
        lines.push('| ' + v.name + ' | ' + describeVariant(v, e.variable ?? 'value') + ' |');
      }
    }
    if (rc?.fix) {
      lines.push('');
      lines.push('**Required fix:** ' + rc.fix);
    }
    lines.push('');
    lines.push('## Fixes attempted');
    lines.push('');
    if (record.attempts.length) {
      for (const a of record.attempts) lines.push('- ' + a);
    } else {
      lines.push('- (none)');
    }
    lines.push('');
    lines.push('## Result');
    lines.push('');
    lines.push(record.outcome);
    lines.push('');
    lines.push('## Raw output');
    lines.push('');
    lines.push('```');
    lines.push(d.raw);
    lines.push('```');
    lines.push('');

    const rel = DIAGNOSTICS_DIR + '/' + timestamp() + '.md';
    const abs = path.join(root, DIAGNOSTICS_DIR, path.basename(rel));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.join('\n'), 'utf8');
    logLine('diagnose', 'report written to ' + rel);
    return rel;
  } catch (e: any) {
    logLine('diagnose', 'could not write the report: ' + (e?.message ?? String(e)));
    return undefined;
  }
}

/* -------------------------------------------------------------------------
 * FIX 1/2 — API-ul principal
 * ------------------------------------------------------------------------- */

/** Cap+coadă pe output-ul brut (păstrat în context ca plasă de siguranță). */
function clipRaw(output: string, max = 2600): string {
  const text = String(output ?? '').trim();
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.4));
  return head + '\n… (truncated) …\n' + tail;
}

/** Pipeline complet: parsează → urmărește cauza → întoarce diagnosticul. */
export function diagnose(
  output: string,
  root: string,
  hintFile?: string
): Diagnosis {
  const errors = parseErrors(output, root);
  let error = errors[0];
  if (!error && hintFile) {
    error = {
      file: hintFile.replace(/\\/g, '/'),
      line: 0,
      col: 0,
      type: 'Error',
      message: String(output ?? '').split(/\r?\n/).find((l) => l.trim()) ?? 'unknown error'
    };
  }
  if (!error) {
    error = {
      file: '',
      line: 0,
      col: 0,
      type: 'Error',
      message: String(output ?? '').trim().slice(0, 300) || 'unknown error'
    };
  }
  const rootCause = traceRootCause(error, root);
  return { error, raw: clipRaw(output), rootCause };
}

/** Log dedicat: `[diagnose] parsed: …` + `[diagnose] root cause: …`. */
export function logDiagnosis(d: Diagnosis): void {
  const e = d.error;
  logLine(
    'diagnose',
    'parsed: ' + e.type + ' at ' + (e.file || '(unknown)') + ':' + e.line +
      (e.expression ? ' — ' + e.message + ' [' + e.expression + ']' : ' — ' + e.message)
  );
  if (d.rootCause) {
    logLine(
      'diagnose',
      'root cause: ' + (d.rootCause.sourceFile ?? e.file) + ' — ' + d.rootCause.summary
    );
  } else {
    logLine('diagnose', 'root cause: (untraced) ' + e.message);
  }
}

/**
 * FIX 3 — contextul COMPACT trimis modelului. Conține doar ce contează:
 * eroarea, locația, expresia, cauza reală, starea sursei și fix-ul exact.
 * `instruction` permite înlocuirea ultimei linii (ex: la comenzile rulate de
 * model, unde după fix trebuie re-rulată ACEeași comandă).
 */
export function buildDiagnosisContext(
  d: Diagnosis,
  attempt: number,
  max: number,
  instruction?: string
): string {
  const e = d.error;
  const rc = d.rootCause;
  const lines: string[] = [];

  lines.push('DIAGNOSTIC (do not guess, this is the root cause):');
  lines.push('');
  lines.push('Error: ' + e.message);
  lines.push('Location: ' + (e.file || '(unknown)') + ':' + e.line);
  if (e.expression) lines.push('Expression: ' + e.expression);
  if (rc) lines.push('Root cause: ' + rc.description);
  if (rc?.sourceFile) {
    lines.push('');
    lines.push('Source file: ' + rc.sourceFile);
    if (rc.variants.length) {
      lines.push('Current state:');
      for (const v of rc.variants) {
        lines.push('  ' + v.name + ': ' + describeVariant(v, e.variable ?? 'value'));
      }
    }
  }
  lines.push('');
  lines.push('Required fix (EXACTLY this, do not add ?. or || []):');
  lines.push(rc?.fix ?? 'Fix the ROOT CAUSE at the source — do not hide the symptom at the access site.');
  lines.push('');
  lines.push(
    instruction ??
      ('Respond with ONE edit_file. No explanation. No screenshot. ' +
        '(diagnostic cycle ' +
        attempt +
        '/' +
        max +
        ')')
  );
  return lines.join('\n');
}

function describeVariant(v: VariantState, field: string): string {
  if (!v.present) return 'missing';
  if (!v.elements.length) return 'empty';
  return v.elements
    .map((e) => 'packages[' + e.index + ']=' + (e.ok ? 'ok' : 'MISSING ' + field))
    .join(', ');
}

/* -------------------------------------------------------------------------
 * FIX 6 — BLOCAREA BAND-AID FIX-URILOR
 * ------------------------------------------------------------------------- */

/**
 * Detectează un fix band-aid (ascunde simptomul, lasă cauza): `?.` pe lanțuri
 * `.map()`, `|| []` / `?? []` pe array-uri care ar trebui populate, sau
 * `if (!x) return` adăugat doar ca să nu mai crape. Întoarce motivul.
 */
export function isBandAidFix(newText: string, oldText?: string): string | undefined {
  const next = String(newText ?? '');
  const prev = String(oldText ?? '');
  if (!next) return undefined;

  const added = (re: RegExp) => re.test(next) && !re.test(prev);

  if (added(/\?\.\s*map\s*\(/) || added(/\?\.\s*(?:filter|forEach|reduce|slice|join|find|some|every|sort)\s*\(/)) {
    return 'optional chaining (`?.`) added around a collection call';
  }
  if (added(/\|\|\s*\[\s*\]/) || added(/\?\?\s*\[\s*\]/)) {
    return '`|| []` / `?? []` added to an array that should be populated';
  }
  if (added(/if\s*\(\s*!\s*[\w$.\[\]]+\s*\)\s*(?:\{\s*)?return\b/)) {
    return '`if (!x) return` guard added instead of fixing the source';
  }
  if (added(/if\s*\(\s*[\w$.\[\]]+\s*(?:===|==)\s*(?:undefined|null)\s*\)\s*(?:\{\s*)?return\b/)) {
    return '`if (x === undefined) return` guard added instead of fixing the source';
  }
  return undefined;
}
