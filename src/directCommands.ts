import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logLine } from './log';
// IMPORTANT: `vscode` doar ca TIP — la runtime se cere lazy, ca modulul să
// poată fi încărcat în testele Node (fără VS Code).
import type * as vscode from 'vscode';

const log = (msg: string) => logLine('router', msg);
const chatLog = (msg: string) => logLine('chat', msg);

/* =========================================================================
 * v2.9.2 — ROUTER DETERMINIST PENTRU „DESCHIDE PROIECTUL <path>"
 *
 * Bug raportat: „deschide proiectul C:\...\brandidentity.agency-src" era
 * clasificat drept ÎNTREBARE, primea promptul scurt fără unelte și modelul
 * răspundea textual („no valid tool call, final answer") în loc să deschidă
 * folderul. Clasificarea depindea de un LLM care nu are acces la filesystem.
 *
 * Acum comenzile de deschidere sunt recunoscute DETERMINIST, înainte de
 * clasificare, și executate direct cu `vscode.openFolder` — fără LLM.
 * ========================================================================= */

/** Verbele de deschidere acceptate (mai multe limbi, conform spec-ului). */
export const OPEN_VERBS =
  /(?:deschide|deschideți|deschideti|open|abre|abrir|ouvre|ouvrir|öffne|oeffne|öffnen|apri|aprire|открой|открыть|打开项目|打开|開く|열기)/i;

/** Cuvintele care pot sta între verb și cale („deschide PROIECTUL <path>"). */
export const PROJECT_WORDS =
  /(?:el proyecto|le projet|das projekt|den ordner|der ordner|il progetto|o projeto|the project|the folder|la carpeta|el dossier|le dossier|das verzeichnis|proiectul|proiectului|proiect|folderul|directorul|workspace-ul|project|projekt|proyecto|progetto|projeto|projet|проект|项目|folder|director|workspace|dossier|carpeta)/i;

/**
 * O cale absolută: Windows (`C:\`, `C:/`), UNC (`\\server\share`), Unix (`/`)
 * sau home (`~/`, `~\`). Căile relative nu sunt acceptate — un mesaj obișnuit
 * care conține „src/index.ts" nu trebuie să declanșeze deschiderea unui folder.
 */
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])/;

export function isAbsolutePathLike(value: string): boolean {
  return ABS_PATH_RE.test(String(value || '').trim());
}

/** Scoate ghilimelele de la capete și punctuația de final de propoziție. */
function cleanPath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^["'`«»„”]+/, '')
    .replace(/["'`«»„”]+$/, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/**
 * Cuvinte care semnalează că s-a terminat calea și începe altă instrucțiune
 * („deschide C:\x ȘI rulează testele"). Doar pe ele tăiem candidatul, ca să nu
 * confundăm un nume de folder care conține spații cu o continuare de frază.
 */
const PROSE_CONNECTORS = new Set([
  'si', 'și', 'apoi', 'dupa', 'după', 'then', 'and', 'please', 'te', 'rog',
  'et', 'puis', 'und', 'y', 'e', 'depois', 'então', 'entao', 'затем', '然后',
  'after', 'potem', 'dan', 'en', 'and', 'run', 'ruleaza', 'rulează'
]);

/** Prefixele candidate, de la cel mai lung la cel mai scurt, tăiate la conectori. */
function trimAtProse(candidate: string): string[] {
  const out: string[] = [];
  let current = candidate;
  for (;;) {
    const words = current.split(/\s+/);
    let cut = -1;
    for (let i = 1; i < words.length; i++) {
      const word = words[i].toLowerCase().replace(/[.,;:!?"'`]+/g, '');
      if (PROSE_CONNECTORS.has(word)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) break;
    current = words.slice(0, cut).join(' ').trim();
    if (current) out.push(current);
  }
  return out;
}

/**
 * Extrage calea unui folder dintr-un mesaj de tip comandă.
 * Întoarce `null` când mesajul nu e o comandă de deschidere (ex. „ce este un folder?").
 */
export function extractOpenFolderPath(text: string): string | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // 1. cale între ghilimele (acceptă spații: "C:\Program Files\My App")
  const quoted = raw.match(/(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])[^"'`]*)\1/);
  if (quoted) {
    const value = cleanPath(quoted[2]);
    if (isAbsolutePathLike(value)) return value;
  }

  // 2. verb de deschidere + (cuvânt-proiect opțional) + cale
  const verbRe = new RegExp(
    '(?<![\\p{L}\\p{N}_])(?:' + OPEN_VERBS.source + ')\\s+(?:(?:' + PROJECT_WORDS.source + ')\\s+)?(.+)$',
    'iu'
  );
  const m = raw.match(verbRe);
  if (m) {
    const candidate = cleanPath(m[1]);
    if (isAbsolutePathLike(candidate)) return candidate;
  }

  // 3. mesajul este doar o cale absolută
  const only = cleanPath(raw);
  if (isAbsolutePathLike(only)) return only;

  return null;
}

/** `~/proiecte/foo` → `C:\Users\X\proiecte\foo` (calea relativă rămâne neatinsă). */
export function expandHome(value: string): string {
  const v = String(value || '').trim();
  if (!/^~[\\/]/.test(v)) return v;
  const rest = v.slice(2);
  return rest ? path.join(os.homedir(), rest) : os.homedir();
}

type StatKind = 'dir' | 'file' | 'missing' | 'denied' | 'unknown';

async function statKind(target: string): Promise<StatKind> {
  try {
    const vscode = require('vscode') as typeof import('vscode');
    const st = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return st.type & vscode.FileType.Directory ? 'dir' : 'file';
  } catch (e: any) {
    const code = String(e?.code ?? '');
    if (code === 'FileNotFound' || code === 'ENOENT') return 'missing';
    if (code === 'NoPermissions' || code === 'EACCES' || code === 'EPERM') return 'denied';
    return 'unknown';
  }
}

/**
 * Deschide folderul cerut, dacă mesajul este o comandă de deschidere.
 * Întoarce `true` când mesajul a fost TRATAT (deschis sau eroare afișată) —
 * atunci nu mai are rost să fie trimis la LLM.
 */
export async function tryDirectOpenFolder(text: string): Promise<boolean> {
  const found = extractOpenFolderPath(text);
  if (!found) return false;

  const vscode = require('vscode') as typeof import('vscode');
  const first = expandHome(found);
  const candidates = [first, ...trimAtProse(first)]
    .map((c) => cleanPath(c))
    .filter(Boolean);

  let failed = first;
  let reason: StatKind = 'missing';
  for (const candidate of candidates) {
    const kind = await statKind(candidate);
    if (kind !== 'dir') {
      if (kind !== 'missing') {
        failed = candidate;
        reason = kind;
      }
      continue;
    }
    log('direct open_folder path=' + candidate);
    chatLog('executing vscode.openFolder');
    try {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(candidate), {
        forceReuseWindow: true
      });
      chatLog('done');
      return true;
    } catch (e: any) {
      log('openFolder failed for ' + candidate + ': ' + (e?.message ?? String(e)));
      vscode.window.showErrorMessage(
        'Nu am putut deschide folderul: ' + candidate + ' (' + (e?.message ?? String(e)) + ')'
      );
      return true;
    }
  }

  log('direct open_folder failed path=' + failed + ' reason=' + reason);
  vscode.window.showErrorMessage(
    reason === 'denied'
      ? 'Nu am acces la folderul: ' + failed
      : reason === 'file'
        ? 'Calea nu este un folder: ' + failed
        : 'Folderul nu există: ' + failed
  );
  return true;
}

/** Pentru mesaje de tip „deschide <path>", fără să atingem FS-ul (clasificare). */
export function isOpenFolderCommand(text: string): boolean {
  return extractOpenFolderPath(text) !== null;
}
