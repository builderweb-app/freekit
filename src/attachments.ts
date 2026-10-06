import * as path from 'path';
import * as fs from 'fs/promises';
import { logLine } from './log';
import {
  MAX_CHARS_PER_FILE,
  MAX_CHARS_TOTAL,
  MAX_LINES_PER_FILE,
  clipPayload,
  truncateContent
} from './payload';

const log = (msg: string) => logLine('attachments', msg);

/* =========================================================================
 * FAZA II (A) — ATAȘAMENTE
 *
 * Utilizatorul poate atașa fișiere / imagini / foldere în chat (drag & drop
 * sau butonul 📎). Acest modul:
 *   - descrie un path (nume, tip, dimensiune, cale relativă)
 *   - pregătește blocul de text lipit în mesajul trimis AI-ului
 *     (conținutul fișierelor text + arborele folderelor)
 *   - decide ce fișiere se încarcă prin upload în chatul web (imagini/binare)
 * ========================================================================= */

export type AttachmentKind = 'text' | 'image' | 'folder' | 'binary';

export interface Attachment {
  id: string;
  name: string;
  /** Cale relativă la workspace (sau absolută, dacă e în afara lui). */
  relPath: string;
  absPath: string;
  kind: AttachmentKind;
  size: number;
}

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.tiff'
]);

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.md', '.mdx', '.txt', '.css', '.scss', '.less', '.html', '.htm',
  '.astro', '.vue', '.svelte', '.py', '.rb', '.php', '.go', '.rs',
  '.java', '.kt', '.kts', '.cs', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.graphql', '.gql', '.xml', '.csv', '.log', '.diff', '.patch'
]);

const TEXT_NAMES = new Set([
  'dockerfile', 'makefile', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.prettierrc', '.eslintrc', '.babelrc', 'license', 'readme',
  'procfile', 'rakefile', 'gemfile'
]);

export function newAttachmentId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function classifyPath(name: string, isDir: boolean): AttachmentKind {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  const base = path.basename(name).toLowerCase();
  if (TEXT_NAMES.has(base) || (base.startsWith('.') && !ext)) return 'text';
  return 'binary';
}

/** Citește metadatele unui path. Returnează null dacă nu există/e inaccesibil. */
export async function describePath(
  absPath: string,
  root: string
): Promise<Attachment | null> {
  try {
    const st = await fs.stat(absPath);
    const isDir = st.isDirectory();
    const rel = root ? path.relative(root, absPath) : '';
    const inside = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    return {
      id: newAttachmentId(),
      name: path.basename(absPath) || absPath,
      relPath: inside ? rel : absPath,
      absPath,
      kind: classifyPath(absPath, isDir),
      size: isDir ? 0 : st.size
    };
  } catch (e: any) {
    log('describePath eșuat: ' + absPath + ' — ' + (e?.message ?? String(e)));
    return null;
  }
}

/* =========================================================================
 * Pregătirea conținutului pentru mesajul trimis AI-ului
 * ========================================================================= */

/* v2.5.23 (bug #54): bugetul de atașamente era 30k/fișier și 150k total — un
 * paste uriaș procesat minute întregi de web app. Aliniat la bugetul comun
 * (6000/fișier, 12000 total), cu trunchiere cap+coadă. */
const MAX_PER_FILE = MAX_CHARS_PER_FILE;
const MAX_TOTAL = MAX_CHARS_TOTAL;
/** Sub acest rest de buget nu mai are sens să includem conținut — marcăm SKIPPED. */
const MIN_PER_FILE = 1500;
const SKIPPED_NOTE = '[SKIPPED: payload limit reached]';
const FOLDER_MAX_ENTRIES = 200;

const FOLDER_EXCLUDE = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.next', '.cache',
  'coverage', 'chrome-profile', '.vscode', '__pycache__', 'target', '.idea'
]);

export interface PreparedAttachments {
  /** Blocul text care se lipește în mesaj (fișiere text + listing foldere). */
  block: string;
  /** Căi absolute pentru upload prin browser (imagini / binare). */
  uploads: string[];
}

export async function prepareAttachments(
  root: string,
  atts: Attachment[]
): Promise<PreparedAttachments> {
  const parts: string[] = [];
  const uploads: string[] = [];
  let used = 0;
  /** Restul de buget disponibil (niciodată negativ). */
  const remaining = () => Math.max(0, MAX_TOTAL - used);

  for (const a of atts) {
    try {
      if (a.kind === 'folder') {
        const listing = await folderTree(a.absPath);
        if (remaining() < MIN_PER_FILE) {
          parts.push('--- FOLDER: ' + a.relPath + '/ ---\n' + SKIPPED_NOTE);
          continue;
        }
        const chunk = clipPayload(
          '--- FOLDER: ' + a.relPath + '/ ---\n' + listing +
            '\n(listing folder — folosește read_file / read_files pentru conținut)',
          Math.min(MAX_PER_FILE, remaining())
        );
        used += chunk.length;
        parts.push(chunk);
      } else if (a.kind === 'text') {
        const content = await readTextSafe(a.absPath);
        if (content === null) {
          uploads.push(a.absPath);
          parts.push(
            '--- FILE: ' + a.relPath + ' ---\n' +
              '(fișier netextual — încărcat ca atașament în chatul web)'
          );
          continue;
        }
        if (remaining() < MIN_PER_FILE) {
          parts.push('--- FILE: ' + a.relPath + ' ---\n' + SKIPPED_NOTE);
          continue;
        }
        const clipped = truncateContent(
          content,
          MAX_LINES_PER_FILE,
          Math.min(MAX_PER_FILE, remaining())
        );
        const chunk =
          '--- FILE: ' + a.relPath + ' (' + content.length + ' bytes) ---\n' +
          '```' + langFor(a.relPath) + '\n' + clipped + '\n```';
        used += chunk.length;
        parts.push(chunk);
      } else {
        // image / binary → upload real în chatul web
        uploads.push(a.absPath);
        parts.push(
          '--- ATTACHED FILE: ' + a.relPath + ' ---\n' +
            '(fișier încărcat în chatul web ca atașament)'
        );
      }
    } catch (e: any) {
      parts.push(
        '--- FILE: ' + a.relPath + ' ---\n(eroare la citire: ' +
          (e?.message ?? String(e)) + ')'
      );
    }
  }

  // plasă de siguranță: chiar dacă un element a depășit bugetul (ex. antetul
  // lung al unui fișier), blocul final rămâne în buget (cap+coadă).
  return { block: clipPayload(parts.join('\n\n'), MAX_TOTAL), uploads };
}

async function readTextSafe(abs: string): Promise<string | null> {
  const buf = await fs.readFile(abs);
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  if (probe.includes(0)) return null; // conține NUL → binar
  return buf.toString('utf8');
}

async function folderTree(absDir: string): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, depth: number, prefix: string) {
    if (depth > 4 || count >= FOLDER_MAX_ENTRIES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((e) => !(e.isDirectory() && FOLDER_EXCLUDE.has(e.name)))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < visible.length; i++) {
      if (count >= FOLDER_MAX_ENTRIES) {
        lines.push(prefix + '... (trunchiat la ' + FOLDER_MAX_ENTRIES + ' intrări)');
        return;
      }
      const e = visible[i];
      const isLast = i === visible.length - 1;
      lines.push(prefix + (isLast ? '└── ' : '├── ') + e.name + (e.isDirectory() ? '/' : ''));
      count++;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), depth + 1, prefix + (isLast ? '    ' : '│   '));
      }
    }
  }

  await walk(absDir, 1, '');
  return lines.join('\n') || '(folder gol)';
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js',
  '.cjs': 'js', '.json': 'json', '.md': 'md', '.mdx': 'md', '.css': 'css',
  '.scss': 'scss', '.html': 'html', '.astro': 'astro', '.vue': 'vue',
  '.svelte': 'svelte', '.py': 'python', '.rb': 'ruby', '.php': 'php',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.cs': 'csharp',
  '.sh': 'bash', '.ps1': 'powershell', '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml', '.sql': 'sql', '.xml': 'xml'
};

function langFor(p: string): string {
  return LANG_MAP[path.extname(p).toLowerCase()] || '';
}
