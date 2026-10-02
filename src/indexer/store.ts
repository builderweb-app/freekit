import * as fs from 'fs/promises';
import * as path from 'path';

/* =========================================================================
 * v1.10.0 — VECTOR STORE LOCAL
 * Indexul semantic e un singur fișier JSON în globalStorage
 * (`<globalStorage>/semantic-index/<hash-workspace>.json`) — ZERO dependențe
 * npm noi. Scrierea e atomică (temp + rename) ca un index corupt să nu
 * rămână niciodată pe disc.
 * ========================================================================= */

export const INDEX_VERSION = 1;

/** Metadatele unui fișier indexat (pentru indexarea incrementală). */
export interface IndexedFile {
  /** sha1 al conținutului — dacă hash-ul nu s-a schimbat, fișierul e sărit. */
  hash: string;
  size: number;
  mtimeMs: number;
  chunks: number;
  /** Motivul pentru care fișierul a fost sărit (prea mare / binar / fără vectori). */
  skipped?: string;
}

/** Un fragment (chunk) de cod + vectorul lui. */
export interface IndexChunk {
  /** calea relativă la rădăcina workspace-ului (cu `/`). */
  path: string;
  /** linia de început (1-based, inclusiv). */
  start: number;
  /** linia de sfârșit (1-based, inclusiv). */
  end: number;
  text: string;
  vector: number[];
}

export interface IndexData {
  version: number;
  /** modelul de embeddings folosit (indexul e invalidat dacă se schimbă). */
  model: string;
  dim: number;
  root: string;
  createdAt: string;
  updatedAt: string;
  files: Record<string, IndexedFile>;
  chunks: IndexChunk[];
}

export function emptyIndex(root: string, model: string): IndexData {
  const now = new Date().toISOString();
  return {
    version: INDEX_VERSION,
    model,
    dim: 0,
    root,
    createdAt: now,
    updatedAt: now,
    files: {},
    chunks: []
  };
}

/** Citește indexul de pe disc; `null` dacă lipsește / e corupt / e altă versiune. */
export async function loadIndex(file: string): Promise<IndexData | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw) as IndexData;
    if (!data || data.version !== INDEX_VERSION) return null;
    if (!data.files || !Array.isArray(data.chunks)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Scrie indexul atomic (temp + rename), ca un crash să nu lase JSON trunchiat. */
export async function saveIndex(file: string, data: IndexData): Promise<void> {
  data.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, file);
}

/** Șterge indexul de pe disc. Întoarce true dacă exista ceva de șters. */
export async function deleteIndex(file: string): Promise<boolean> {
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}
