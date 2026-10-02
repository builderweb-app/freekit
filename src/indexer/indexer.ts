import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { logLine } from '../log';
import { ollamaBaseUrl } from '../providers/ollama';
import { embedText, cosineSimilarity, ollamaAvailable } from './embeddings';
import {
  IndexChunk,
  IndexData,
  IndexedFile,
  emptyIndex,
  loadIndex,
  saveIndex,
  deleteIndex
} from './store';

/* =========================================================================
 * v1.10.0 — INDEXARE SEMANTICĂ A WORKSPACE-ULUI
 * Scanează proiectul (cu excluderi inteligente), taie fișierele în chunk-uri
 * cu suprapunere, generează embeddings cu Ollama (`nomic-embed-text`) și le
 * păstrează într-un vector store JSON în globalStorage. Expune căutarea
 * semantică (`searchSemantic`) folosită de unealta `search_semantic`.
 * ========================================================================= */

const log = (msg: string) => logLine('indexer', msg);

/* ----------------------------- configurări ----------------------------- */

/** Directoare ignorate întotdeauna (build, dependențe, VCS, cache). */
const DEFAULT_EXCLUDE_DIRS = [
  'node_modules', '.git', '.hg', '.svn', 'out', 'dist', 'build', 'docs-build',
  '.next', '.nuxt', '.astro', '.svelte-kit', '.output', '.vercel', '.netlify',
  'coverage', '.nyc_output', '.cache', '.parcel-cache', '.turbo', '.gradle',
  '.idea', '.vscode-test', 'tmp', 'temp', 'bin', 'obj', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'chrome-profile', 'node_modules.old', 'pkgs', '.terraform'
];

/** Fișiere ignorate după nume (lockfile-uri, artefacte). */
const SKIP_FILE_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'go.sum',
  'pipfile.lock', '.ds_store', 'thumbs.db'
]);

/** Extensii ignorate (binare / media / arhive / fonturi / build). */
const SKIP_EXTENSIONS = new Set([
  'vsix', 'map', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'tar', '7z', 'rar', 'exe', 'dll',
  'so', 'dylib', 'node', 'class', 'jar', 'war', 'bin', 'woff', 'woff2', 'ttf',
  'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'ogg', 'flac', 'psd', 'ai',
  'db', 'sqlite', 'sqlite3', 'pyc', 'pyo', 'o', 'a', 'obj', 'pdb', 'wasm',
  'iso', 'img', 'ttc'
]);

const CHUNK_LINES = 60;
const OVERLAP_LINES = 12;
const MAX_LINE_LENGTH = 5000;
const MAX_STORED_CHARS = 8000;

/** Modelul implicit de embeddings (local, instalabil cu `ollama pull`). */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

export interface SemanticConfig {
  enabled: boolean;
  model: string;
  onSave: boolean;
  maxFileKb: number;
  topK: number;
  extraExclude: string[];
}

/** Setările `aiBridge.semanticIndex.*` (citite live, la fiecare apel). */
export function semanticConfig(): SemanticConfig {
  const cfg = vscode.workspace.getConfiguration('aiBridge');
  const rawMax = Number(cfg.get<number>('semanticIndex.maxFileKb', 256));
  const rawTop = Number(cfg.get<number>('semanticIndex.topK', 8));
  const extra = cfg.get<string[]>('semanticIndex.exclude', []) || [];
  return {
    enabled: cfg.get<boolean>('semanticIndex.enabled', true) === true,
    model:
      String(cfg.get<string>('semanticIndex.model', DEFAULT_EMBED_MODEL) || '').trim() ||
      DEFAULT_EMBED_MODEL,
    onSave: cfg.get<boolean>('semanticIndex.onSave', false) === true,
    maxFileKb: Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 256,
    topK: Number.isFinite(rawTop) && rawTop > 0 ? Math.floor(rawTop) : 8,
    extraExclude: extra.map((s) => String(s).trim()).filter(Boolean)
  };
}

/** true doar dacă unealta search_semantic e activată din setări. */
export function isSemanticEnabled(): boolean {
  return semanticConfig().enabled;
}

/* ------------------------------- căi ----------------------------------- */

let storageDir = '';

/** Inițializat o dată la activarea extensiei (în extension.ts). */
export function initIndexer(globalStorageRoot: string): void {
  storageDir = path.join(globalStorageRoot, 'semantic-index');
  log('storage dir: ' + storageDir);
}

/** Rădăcina primului workspace deschis (null dacă nu există folder). */
export function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  return folders[0].uri.fsPath;
}

/** Fișierul de index al unui workspace (nume derivat din calea rădăcină). */
export function indexFilePath(root: string): string {
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  const base = path.basename(root).replace(/[^a-z0-9._-]/gi, '_') || 'workspace';
  return path.join(storageDir, base + '-' + hash + '.json');
}

/* ------------------------- cache în memorie ---------------------------- */

let cache: { file: string; mtimeMs: number; data: IndexData } | null = null;

/** Încarcă indexul, cu cache invalidat de mtime (căutările repetate nu re-citesc JSON-ul). */
async function cachedLoad(root: string): Promise<IndexData | null> {
  const file = indexFilePath(root);
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.data;
  const data = await loadIndex(file);
  if (data) cache = { file, mtimeMs, data };
  else cache = null;
  return data;
}

/* --------------------------- scanare fișiere --------------------------- */

interface Candidate {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

async function walk(
  dir: string,
  root: string,
  exclude: Set<string>,
  out: Candidate[]
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (exclude.has(e.name.toLowerCase())) continue;
      await walk(abs, root, exclude, out);
      continue;
    }
    if (!e.isFile()) continue;

    const lower = e.name.toLowerCase();
    if (SKIP_FILE_NAMES.has(lower)) continue;
    if (lower.includes('.min.') || lower.endsWith('.d.ts')) continue;
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
    if (SKIP_EXTENSIONS.has(ext)) continue;

    let st: import('fs').Stats;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!st.size) continue;

    out.push({
      abs,
      rel: path.relative(root, abs).split(path.sep).join('/'),
      size: st.size,
      mtimeMs: st.mtimeMs
    });
  }
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** true când conținutul pare binar (NUL în primii 8 KB). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* ------------------------------ chunking ------------------------------- */

interface RawChunk {
  start: number;
  end: number;
  text: string;
}

/** Taie conținutul în chunk-uri de linii cu suprapunere (overlap). */
function chunkText(content: string): RawChunk[] {
  const lines = content.split(/\r?\n/);
  const out: RawChunk[] = [];
  const step = Math.max(1, CHUNK_LINES - OVERLAP_LINES);
  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(lines.length, i + CHUNK_LINES);
    const text = lines.slice(i, end).join('\n').trim();
    if (text) out.push({ start: i + 1, end, text: text.slice(0, MAX_STORED_CHARS) });
    if (end >= lines.length) break;
  }
  return out;
}

/* ------------------------------ statistici ----------------------------- */

export interface IndexStats {
  files: number;
  indexed: number;
  unchanged: number;
  removed: number;
  chunks: number;
  failed: number;
  skipped: number;
  cancelled: boolean;
  durationMs: number;
}

export interface IndexProgress {
  done: number;
  total: number;
  file: string;
}

export interface IndexOptions {
  /** Re-indexează tot, chiar dacă hash-ul nu s-a schimbat. */
  force?: boolean;
  /** Anulează la cerere (butonul Cancel din progres). */
  signal?: AbortSignal;
  onProgress?: (p: IndexProgress) => void;
}

/* ------------------------------- indexare ------------------------------ */

/**
 * Indexează (sau actualizează incremental) workspace-ul. Fișierele al căror
 * conținut nu s-a schimbat își păstrează vectorii existenți — doar fișierele
 * noi/modificate sunt re-embeduite. La final indexul e scris pe disc.
 */
export async function indexWorkspace(
  root: string,
  opts: IndexOptions = {}
): Promise<IndexStats> {
  const started = Date.now();
  const cfg = semanticConfig();
  const stats: IndexStats = {
    files: 0,
    indexed: 0,
    unchanged: 0,
    removed: 0,
    chunks: 0,
    failed: 0,
    skipped: 0,
    cancelled: false,
    durationMs: 0
  };

  const exclude = new Set(DEFAULT_EXCLUDE_DIRS.map((d) => d.toLowerCase()));
  for (const e of cfg.extraExclude) exclude.add(e.toLowerCase());

  const candidates: Candidate[] = [];
  await walk(root, root, exclude, candidates);
  stats.files = candidates.length;
  log('index: ' + candidates.length + ' candidate files under ' + root);

  const loaded = await cachedLoad(root);
  // Indexul e refolosit doar dacă modelul de embeddings e același.
  const base =
    loaded && loaded.model === cfg.model ? loaded : emptyIndex(root, cfg.model);
  if (loaded && loaded.model !== cfg.model) {
    log('index: model changed (' + loaded.model + ' -> ' + cfg.model + '), full re-index');
  }

  const stillPresent = new Set(candidates.map((c) => c.rel));
  const chunksByPath = new Map<string, IndexChunk[]>();
  for (const ch of base.chunks) {
    if (!stillPresent.has(ch.path)) continue;
    const arr = chunksByPath.get(ch.path);
    if (arr) arr.push(ch);
    else chunksByPath.set(ch.path, [ch]);
  }
  stats.removed = Object.keys(base.files).filter((p) => !stillPresent.has(p)).length;

  const maxBytes = cfg.maxFileKb * 1024;
  const files: Record<string, IndexedFile> = {};
  let done = 0;

  for (const cand of candidates) {
    if (opts.signal?.aborted) {
      stats.cancelled = true;
      break;
    }
    done++;
    opts.onProgress?.({ done, total: candidates.length, file: cand.rel });

    const prev = base.files[cand.rel];
    // un fișier sărit nu mai e indexat — vectorii vechi sunt eliminați
    const skipFile = (reason: string, size = cand.size, mtimeMs = cand.mtimeMs): void => {
      stats.skipped++;
      chunksByPath.delete(cand.rel);
      files[cand.rel] = { hash: '', size, mtimeMs, chunks: 0, skipped: reason };
    };

    if (cand.size > maxBytes) {
      skipFile('too large');
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(cand.abs);
    } catch {
      skipFile('unreadable');
      continue;
    }
    if (looksBinary(buf)) {
      skipFile('binary');
      continue;
    }
    const content = buf.toString('utf8');
    const longest = content.length ? Math.max(...content.split('\n', 200).map((l) => l.length)) : 0;
    if (longest > MAX_LINE_LENGTH) {
      skipFile('minified / very long lines');
      continue;
    }

    const hash = sha1(content);
    // Incremental: hash identic ȘI model identic => vectorii se păstrează.
    if (!opts.force && prev && prev.hash === hash && chunksByPath.has(cand.rel)) {
      stats.unchanged++;
      files[cand.rel] = {
        hash,
        size: cand.size,
        mtimeMs: cand.mtimeMs,
        chunks: chunksByPath.get(cand.rel)!.length
      };
      continue;
    }

    const raw = chunkText(content);
    const chunks: IndexChunk[] = [];
    let failed = 0;
    for (const rc of raw) {
      if (opts.signal?.aborted) {
        stats.cancelled = true;
        break;
      }
      const vector = await embedText(cand.rel + '\n' + rc.text, {
        ollamaUrl: ollamaBaseUrl(),
        model: cfg.model
      });
      if (!vector) {
        failed++;
        continue;
      }
      chunks.push({ path: cand.rel, start: rc.start, end: rc.end, text: rc.text, vector });
    }

    if (stats.cancelled) {
      // păstrăm vectorii vechi (dacă există) ca indexul parțial să rămână valid
      if (chunksByPath.has(cand.rel)) files[cand.rel] = { ...(prev as IndexedFile) };
      break;
    }

    if (failed) stats.failed += failed;
    chunksByPath.set(cand.rel, chunks);
    stats.indexed++;
    files[cand.rel] = {
      hash,
      size: cand.size,
      mtimeMs: cand.mtimeMs,
      chunks: chunks.length,
      ...(failed && !chunks.length ? { skipped: 'embedding failed' } : {})
    };
  }

  const chunks: IndexChunk[] = [];
  for (const arr of chunksByPath.values()) chunks.push(...arr);

  const data: IndexData = {
    ...base,
    model: cfg.model,
    dim: chunks.length ? chunks[0].vector.length : base.dim,
    files,
    chunks
  };
  // păstrăm și fișierele sărite (prea mari/binare) pentru statistici corecte
  for (const [p, f] of Object.entries(base.files)) {
    if (!files[p] && stillPresent.has(p)) files[p] = f;
  }
  data.files = files;

  await saveIndex(indexFilePath(root), data);
  cache = null;

  stats.chunks = chunks.length;
  stats.durationMs = Date.now() - started;
  log(
    'index done: ' +
      stats.indexed +
      ' indexed, ' +
      stats.unchanged +
      ' unchanged, ' +
      stats.removed +
      ' removed, ' +
      chunks.length +
      ' chunks' +
      (stats.cancelled ? ' (cancelled)' : '') +
      ' in ' +
      stats.durationMs +
      'ms'
  );
  return stats;
}

/** Indexare incrementală a unui singur fișier (la salvare). */
export async function indexSingleFile(
  root: string,
  absPath: string
): Promise<'updated' | 'unchanged' | 'skipped' | 'no-index' | 'aborted'> {
  const cfg = semanticConfig();
  if (!cfg.enabled) return 'skipped';

  const data = await cachedLoad(root);
  if (!data) return 'no-index';

  const rel = path.relative(root, absPath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return 'skipped';

  const lowerName = path.basename(absPath).toLowerCase();
  const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : '';
  if (
    SKIP_FILE_NAMES.has(lowerName) ||
    SKIP_EXTENSIONS.has(ext) ||
    lowerName.includes('.min.')
  ) {
    return 'skipped';
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(absPath);
  } catch {
    return 'skipped';
  }
  if (!buf.length || buf.length > cfg.maxFileKb * 1024 || looksBinary(buf)) return 'skipped';

  const content = buf.toString('utf8');
  const longest = Math.max(...content.split('\n', 200).map((l) => l.length));
  if (longest > MAX_LINE_LENGTH) return 'skipped';

  const hash = sha1(content);
  if (data.files[rel]?.hash === hash && data.chunks.some((c) => c.path === rel)) {
    return 'unchanged';
  }

  const chunks: IndexChunk[] = [];
  for (const rc of chunkText(content)) {
    const vector = await embedText(rel + '\n' + rc.text, {
      ollamaUrl: ollamaBaseUrl(),
      model: cfg.model
    });
    if (vector) chunks.push({ path: rel, start: rc.start, end: rc.end, text: rc.text, vector });
  }

  const kept = data.chunks.filter((c) => c.path !== rel);
  data.chunks = kept.concat(chunks);
  data.files[rel] = { hash, size: buf.length, mtimeMs: Date.now(), chunks: chunks.length };
  data.dim = data.chunks.length ? data.chunks[0].vector.length : data.dim;
  await saveIndex(indexFilePath(root), data);
  cache = null;
  log('incremental: ' + rel + ' -> ' + chunks.length + ' chunks');
  return 'updated';
}

/* ------------------------------- căutare ------------------------------- */

export interface SearchHit {
  path: string;
  start: number;
  end: number;
  score: number;
  snippet: string;
}

function makeSnippet(text: string): string {
  const lines = text.split('\n');
  const body = lines.length > 40 ? lines.slice(0, 40).join('\n') + '\n…' : text;
  return body.length > 1600 ? body.slice(0, 1600) + '…' : body;
}

/** Caută cele mai relevante chunk-uri pentru un text (query în limbaj natural). */
export async function searchSemantic(
  root: string,
  query: string,
  limit?: number
): Promise<{ hits: SearchHit[]; error?: string; model?: string; totalChunks?: number }> {
  const cfg = semanticConfig();
  if (!cfg.enabled) {
    return { hits: [], error: 'Semantic search is disabled (aiBridge.semanticIndex.enabled).' };
  }
  const q = String(query ?? '').trim();
  if (!q) return { hits: [], error: 'Empty query.' };

  const data = await cachedLoad(root);
  if (!data || !data.chunks.length) {
    return {
      hits: [],
      error:
        'No semantic index found for this workspace. Run the command "AI Bridge: Index Workspace" first.'
    };
  }
  if (data.model !== cfg.model) {
    return {
      hits: [],
      error:
        'The index was built with a different embedding model (' +
        data.model +
        '). Re-run "AI Bridge: Index Workspace".'
    };
  }

  const qvec = await embedText(q, { ollamaUrl: ollamaBaseUrl(), model: cfg.model });
  if (!qvec) {
    return {
      hits: [],
      error: 'Could not compute the query embedding — is Ollama running (' + ollamaBaseUrl() + ')?'
    };
  }

  const k = Math.min(Math.max(1, limit ?? cfg.topK), 25);
  const scored = data.chunks
    .map((c) => ({ chunk: c, score: cosineSimilarity(qvec, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return {
    hits: scored.map((s) => ({
      path: s.chunk.path,
      start: s.chunk.start,
      end: s.chunk.end,
      score: s.score,
      snippet: makeSnippet(s.chunk.text)
    })),
    model: data.model,
    totalChunks: data.chunks.length
  };
}

/** Text pregătit pentru AI / notificări: rezultatele căutării semantice. */
export async function formatSearchResults(
  root: string,
  query: string,
  limit?: number
): Promise<string> {
  const r = await searchSemantic(root, query, limit);
  if (r.error) return 'Semantic search error: ' + r.error;
  if (!r.hits.length) return 'No semantic matches for: ' + query;

  const lines: string[] = [
    'Semantic matches for "' +
      query +
      '" (' +
      r.hits.length +
      ' of ' +
      r.totalChunks +
      ' chunks, model: ' +
      r.model +
      '):'
  ];
  r.hits.forEach((h, i) => {
    lines.push(
      '\n' +
        (i + 1) +
        '. ' +
        h.path +
        ':' +
        h.start +
        '-' +
        h.end +
        '  (score ' +
        h.score.toFixed(3) +
        ')\n' +
        h.snippet
    );
  });
  return lines.join('\n');
}

/* ------------------------------ status / clear ------------------------- */

/** true dacă există un index pentru workspace. */
export async function hasIndex(root: string): Promise<boolean> {
  const data = await cachedLoad(root);
  return !!data && data.chunks.length > 0;
}

/** Rezumatul indexului (folosit de comanda „Index Status” și de AI). */
export async function indexStatusText(root: string): Promise<string> {
  const cfg = semanticConfig();
  const file = indexFilePath(root);
  const data = await loadIndex(file);
  if (!data) {
    return (
      'No semantic index for this workspace.\n' +
      'Root: ' +
      root +
      '\nModel: ' +
      cfg.model +
      '\nRun "AI Bridge: Index Workspace" to build it.'
    );
  }
  const indexedFiles = Object.values(data.files).filter((f) => f.chunks > 0).length;
  const skipped = Object.values(data.files).filter((f) => f.skipped).length;
  const sizeKb = await fs
    .stat(file)
    .then((s) => Math.round(s.size / 1024))
    .catch(() => 0);
  return (
    'Semantic index status\n' +
    'Root: ' +
    root +
    '\nModel: ' +
    data.model +
    ' (dim ' +
    data.dim +
    ')' +
    '\nFiles indexed: ' +
    indexedFiles +
    ' (skipped: ' +
    skipped +
    ')' +
    '\nChunks: ' +
    data.chunks.length +
    '\nIndex file: ' +
    file +
    ' (' +
    sizeKb +
    ' KB)' +
    '\nCreated: ' +
    data.createdAt +
    '\nUpdated: ' +
    data.updatedAt +
    '\nAuto-index on save: ' +
    (cfg.onSave ? 'ON' : 'OFF')
  );
}

/** Șterge indexul workspace-ului curent (comanda „Clear Index”). */
export async function clearIndex(root: string): Promise<boolean> {
  cache = null;
  const removed = await deleteIndex(indexFilePath(root));
  log('index cleared for ' + root + ': ' + removed);
  return removed;
}

/** true dacă Ollama răspunde (pentru mesaje de eroare clare în comenzi). */
export async function isOllamaUp(): Promise<boolean> {
  return ollamaAvailable(ollamaBaseUrl());
}
