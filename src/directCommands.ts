import * as os from 'os';
import * as path from 'path';
import { logLine } from './log';
// IMPORTANT: `vscode` doar ca TIP — la runtime se cere lazy, ca modulul să
// poată fi încărcat în testele Node (fără VS Code).
import type * as vscode from 'vscode';

const log = (msg: string) => logLine('router', msg);
const chatLog = (msg: string) => logLine('chat', msg);

/* =========================================================================
 * v2.9.3 — DETECTARE UNIVERSALĂ DE CĂI + SIGURANȚĂ
 *
 * v2.9.2 recunoștea doar „verb de deschidere + cale". Acum decizia NU mai
 * depinde de verbe: întâi se detectează TOATE căile din mesaj (Windows `C:\`,
 * `C:/`, UNC `\\server\share`, Unix `/`, home `~/`, plus cele relative `./`),
 * apoi se verifică pe filesystem (prin `vscode.workspace.fs`, deci corect și
 * în Remote) dacă vreuna este folder.
 *
 *   - doar calea  SAU  verb de deschidere  → open_folder, fără confirmare
 *   - altfel (cale existentă în alt context) → cerem confirmarea utilizatorului
 *   - întrebare (?, cum/how/why/de ce/explain) sau verb distructiv
 *     (șterge/delete/remove) → NU se execută nimic automat
 *
 * Verbele rămân doar un semnal pentru „sari peste confirmare", nu criteriul de
 * decizie. Mesajele de UI sunt în engleza de bază a VS Code — nu presupunem
 * limba utilizatorului.
 * ========================================================================= */

/** Verbele de deschidere acceptate (mai multe limbi). Doar sar confirmarea. */
export const OPEN_VERBS =
  /(?:deschide|deschideți|deschideti|open|abre|abrir|ouvre|ouvrir|öffne|oeffne|öffnen|apri|aprire|открой|открыть|打开项目|打开|開く|열기)/iu;

/* ---------------------------------------------------------------- cale --- */

/** Tipul căii, după FORMĂ (nu după sistemul de operare al mașinii). */
export type PathFlavor = 'windows' | 'unc' | 'posix' | 'home' | 'relative';

/** Ghilimelele tipografice devin drepte, ca o singură expresie să le acopere. */
function normalizeQuotes(text: string): string {
  return String(text || '')
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'");
}

/** Scoate ghilimelele de la capete și punctuația de final de propoziție. */
function cleanPath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

export function pathFlavor(value: string): PathFlavor {
  const v = cleanPath(value);
  if (/^[A-Za-z]:[\\/]/.test(v)) return 'windows';
  if (/^\\\\/.test(v)) return 'unc';
  if (v === '~' || /^~[\\/]/.test(v)) return 'home';
  if (/^[\\/]/.test(v)) return 'posix';
  return 'relative';
}

/**
 * Windows (`C:\`, `C:/`), UNC (`\\server\share`), Unix (`/`) sau home (`~/`).
 * Căile relative nu sunt acceptate — „src/index.ts" nu e o comandă de deschidere.
 */
export function isAbsolutePathLike(value: string): boolean {
  return pathFlavor(value) !== 'relative';
}

/** `~/proiecte/foo` → `C:\Users\X\proiecte\foo` (calea absolută rămâne neatinsă). */
export function expandHome(value: string): string {
  const v = String(value || '').trim();
  if (!/^~[\\/]/.test(v)) return v;
  const rest = v.slice(2);
  return rest ? path.join(os.homedir(), rest) : os.homedir();
}

/**
 * Început de cale absolută, la graniță de cuvânt: nu prinde `/` din „and/or"
 * sau din „https://", nici `C:` din „file:///C:/x".
 */
const ABS_START_SOURCE = '(?<![\\p{L}\\p{N}_.\\\\/:~-])(?:[A-Za-z]:[\\\\/]|\\\\\\\\|/|~[\\\\/])';

export interface DetectedPath {
  /** textul căii (fără ghilimele) */
  path: string;
  flavor: PathFlavor;
  quoted: boolean;
  /** poziția de început în textul normalizat */
  start: number;
  /** sfârșitul rulării (următoarea cale sau finalul textului) */
  end: number;
}

function inAnySpan(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([from, to]) => index >= from && index < to);
}

/**
 * Toate căile dintr-un mesaj, în ordinea apariției. Întâi cele dintre ghilimele
 * (acceptă spații: `"C:\Program Files\My App"`), apoi cele neghiilimitate, unde
 * candidatul se întinde până la următoarea cale sau până la finalul mesajului
 * (tăierea la conectori de frază se face mai târziu, pe variante).
 */
export function findPathCandidates(text: string): DetectedPath[] {
  const norm = normalizeQuotes(String(text || ''));
  if (!norm.trim()) return [];

  const quotedSpans: Array<[number, number]> = [];
  const quoted: DetectedPath[] = [];
  const quotedRe = /(["'])([^"']*)\1/g;
  let qm: RegExpExecArray | null;
  while ((qm = quotedRe.exec(norm)) !== null) {
    const inner = qm[2];
    const value = cleanPath(inner);
    if (value && isAbsolutePathLike(value)) {
      quotedSpans.push([qm.index, qm.index + qm[0].length]);
      quoted.push({
        path: value,
        flavor: pathFlavor(value),
        quoted: true,
        start: qm.index + 1,
        end: qm.index + qm[0].length - 1
      });
    }
  }

  const starts: number[] = [];
  const startRe = new RegExp(ABS_START_SOURCE, 'gu');
  let sm: RegExpExecArray | null;
  while ((sm = startRe.exec(norm)) !== null) {
    if (!inAnySpan(sm.index, quotedSpans)) starts.push(sm.index);
  }

  const plain: DetectedPath[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const cutAtNextPath = i + 1 < starts.length;
    const end = cutAtNextPath ? starts[i + 1] : norm.length;
    const firstLine = norm.slice(start, end).split(/[\r\n]/)[0];
    // „C:\a with C:\b" — între cele două căi e doar text de legătură.
    const value = cleanPath(cutAtNextPath ? stripTrailingConnectors(firstLine) : firstLine);
    if (!value || !isAbsolutePathLike(value)) continue;
    plain.push({ path: value, flavor: pathFlavor(value), quoted: false, start, end });
  }

  return [...quoted, ...plain].sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------- variante --- */

/**
 * Cuvinte care semnalează că s-a terminat calea și începe altă instrucțiune
 * („deschide C:\x ȘI rulează testele"). Doar pe ele tăiem candidatul, ca să nu
 * confundăm un nume de folder care conține spații cu o continuare de frază.
 */
const PROSE_CONNECTORS = new Set([
  'si', 'și', 'apoi', 'dupa', 'după', 'then', 'and', 'please', 'te', 'rog',
  'et', 'puis', 'und', 'y', 'e', 'depois', 'então', 'entao', 'затем', '然后',
  'after', 'potem', 'dan', 'en', 'run', 'ruleaza', 'rulează', 'with', 'cu',
  'versus', 'vs', 'against', 'pentru', 'for', 'from', 'din', 'into', 'to', 'la'
]);

/** „C:\a with" → „C:\a" (doar conectori de frază, nu segmente de cale). */
function stripTrailingConnectors(value: string): string {
  let words = value.trim().split(/\s+/);
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase().replace(/[.,;:!?"'`]+/g, '');
    if (!PROSE_CONNECTORS.has(last)) break;
    words = words.slice(0, -1);
  }
  return words.join(' ');
}

/** Cuvântul care încheie calea: conector de frază sau marcaj de intenție. */
function endsPath(word: string): boolean {
  return (
    PROSE_CONNECTORS.has(word) || QUESTION_WORD_ONE.test(word) || DESTRUCTIVE_ONE.test(word)
  );
}

/** Prefixele candidate, tăiate la conectori de frază (cel mai lung primele). */
function trimAtProse(candidate: string): string[] {
  const out: string[] = [];
  let current = candidate;
  for (;;) {
    const words = current.split(/\s+/);
    let cut = -1;
    for (let i = 1; i < words.length; i++) {
      const word = words[i].toLowerCase().replace(/[.,;:!?"'`]+/g, '');
      if (endsPath(word)) {
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

/** Variantele de încercat pe FS pentru o cale detectată, cea mai lungă prima. */
function buildVariants(candidate: DetectedPath): string[] {
  if (candidate.quoted) return [candidate.path];
  const out = [candidate.path];
  const sentenceCut = candidate.path.split(/[.!?]\s+/)[0].trim();
  if (sentenceCut && sentenceCut !== candidate.path) out.push(sentenceCut);
  for (const base of [...out]) out.push(...trimAtProse(base));
  return [...new Set(out.map((v) => cleanPath(v)).filter(Boolean))];
}

/* ---------------------------------------------------------- intenție --- */

/** Marcaje de întrebare: semne + cuvinte-cheie în mai multe limbi. */
const QUESTION_SIGNS = /[?？¿]/;
const QUESTION_WORDS =
  /(?<![\p{L}\p{N}_])(?:how|what|why|which|where|when|who|whose|explain|difference|cum|ce|care|unde|când|cand|explic[ăa]|de\s+ce|comment|pourquoi|quoi|quel|quelle|wie|warum|was|welche|c[óo]mo|como|por\s+qu[eé]|perch[ée]|qual|quale|как|почему|зачем|что|怎么|为什么|什么|如何|어떻게|왜|무엇)(?![\p{L}\p{N}_])/iu;

/** Verbe distructive: pe un mesaj cu cale NU se execută nimic automat. */
const DESTRUCTIVE_VERBS =
  /(?<![\p{L}\p{N}_])(?:delete|remove|erase|unlink|rmdir|rm|wipe|destroy|format|truncate|overwrite|move|rename|șterge|sterge|șterg|sterg|șters|sters|elimin[ăa]|mut[ăa]|redenume[șs]te|supprimer|effacer|[ée]craser|l[öo]schen|entfernen|verschieben|eliminar|borrar|renombrar|mover|rimuovi|cancella|sposta|excluir|apagar|remover|удалить|удали|удаление|переместить|删除|刪除|削除|移動|삭제|이동)(?![\p{L}\p{N}_])/iu;

/** Aceleași liste, dar pentru UN singur cuvânt (tăierea cozii de frază). */
const QUESTION_WORD_ONE = new RegExp('^(?:' + QUESTION_WORDS.source + ')$', 'iu');
const DESTRUCTIVE_ONE = new RegExp('^(?:' + DESTRUCTIVE_VERBS.source + ')$', 'iu');

export type BlockReason = 'question' | 'destructive';

export interface OpenFolderPlan {
  /** calea așa cum a scris-o utilizatorul (fără ghilimele / punctuație) */
  path: string;
  /** variante de încercat pe filesystem, cea mai lungă prima */
  candidates: string[];
  /** doar calea sau verb de deschidere ⇒ se execută fără confirmare */
  explicit: boolean;
  /** setat când mesajul NU trebuie executat automat */
  blocked?: BlockReason;
}

/** Textul mesajului fără cale — pe el căutăm întrebări / verbe distructive. */
function buildResidual(norm: string, candidate: DetectedPath, variants: string[]): string {
  const shortest = variants[variants.length - 1] || candidate.path;
  const found = norm.indexOf(shortest, candidate.start);
  const start = found >= 0 ? found : candidate.start;
  const end = found >= 0 ? found + shortest.length : candidate.end;
  // Un „?" lipit de cale, la finalul mesajului, nu transformă comanda în întrebare.
  return (norm.slice(0, start) + ' ' + norm.slice(end)).replace(/\s*[?？]+\s*$/, ' ');
}

/** Mesajul e doar calea, sau conține un verb de deschidere cunoscut. */
function isExplicitOpenRequest(residual: string): boolean {
  const rest = residual.replace(/["'`]/g, '').replace(/[\s.,;:!?\-–—>]+/g, '');
  if (!rest) return true;
  return OPEN_VERBS.test(residual);
}

/**
 * Decide ce facem cu un mesaj care conține o cale — fără să atingem FS-ul:
 * `null` = mesajul nu conține nicio cale absolută (nu e treaba noastră),
 * altfel planul (blocat = întrebare / verb distructiv).
 */
export function planOpenFolder(text: string): OpenFolderPlan | null {
  const norm = normalizeQuotes(String(text || '')).trim();
  if (!norm) return null;

  const target = findPathCandidates(norm).find((c) => c.flavor !== 'relative');
  if (!target) return null;

  const variants = buildVariants(target);
  const residual = buildResidual(norm, target, variants);
  const blocked: BlockReason | undefined = DESTRUCTIVE_VERBS.test(residual)
    ? 'destructive'
    : QUESTION_SIGNS.test(residual) || QUESTION_WORDS.test(residual)
      ? 'question'
      : undefined;

  const plan: OpenFolderPlan = {
    path: target.path,
    candidates: variants.map(expandHome),
    explicit: !blocked && isExplicitOpenRequest(residual)
  };
  if (blocked) plan.blocked = blocked;
  return plan;
}

/**
 * Extrage calea unui folder dintr-un mesaj de tip comandă.
 * Întoarce `null` când mesajul nu cere deschiderea unui folder (întrebare,
 * verb distructiv, mesaj fără cale absolută).
 */
export function extractOpenFolderPath(text: string): string | null {
  const plan = planOpenFolder(text);
  return plan && !plan.blocked ? plan.path : null;
}

/** Pentru mesaje de tip „deschide <path>", fără să atingem FS-ul (clasificare). */
export function isOpenFolderCommand(text: string): boolean {
  return extractOpenFolderPath(text) !== null;
}

/* --------------------------------------------------------- execuție --- */

type StatKind = 'dir' | 'file' | 'missing' | 'denied' | 'unknown';

/** Existența se verifică prin `vscode.workspace.fs` — corect și în Remote. */
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

/** Platforma pe care rulează de fapt extension host-ul (local sau Remote). */
export function hostPlatform(): string {
  try {
    return process.platform;
  } catch {
    return 'unknown';
  }
}

export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/** Un path Windows nu se poate deschide pe macOS/Linux (și invers). */
export function isPathUsableOnHost(flavor: PathFlavor, platform: string): boolean {
  if (flavor === 'windows' || flavor === 'unc') return platform === 'win32';
  if (flavor === 'posix') return platform !== 'win32';
  if (flavor === 'home') return true;
  return false;
}

function incompatiblePathMessage(
  flavor: PathFlavor,
  target: string,
  remoteName: string | undefined
): string {
  const host = platformLabel(hostPlatform());
  const where = remoteName ? 'the remote host (' + remoteName + ' · ' + host + ')' : host;
  if (flavor === 'windows' || flavor === 'unc') {
    return (
      'Freekit: cannot open "' + target + '" — it is a Windows path, but VS Code is running on ' +
      where + '. Use the equivalent local path instead.'
    );
  }
  return (
    'Freekit: cannot open "' + target + '" — it is a Unix path, but VS Code is running on ' +
    where + '. Use a Windows path instead (e.g. C:\\Users\\me\\project).'
  );
}

function folderFailureMessage(reason: StatKind, target: string): string {
  if (reason === 'denied') return 'Freekit: permission denied for folder: ' + target;
  if (reason === 'file') return 'Freekit: that path is a file, not a folder: ' + target;
  if (reason === 'unknown') return 'Freekit: cannot access folder: ' + target;
  return 'Freekit: folder does not exist: ' + target;
}

/** URI-ul folderului, mapat pe Remote când fereastra e într-un Remote. */
function folderUri(vscode: typeof import('vscode'), target: string): vscode.Uri {
  const uri = vscode.Uri.file(target);
  const remoteName = vscode.env?.remoteName;
  if (!remoteName || uri.scheme !== 'file') return uri;
  try {
    return uri.with({ scheme: 'vscode-remote', authority: remoteName });
  } catch {
    return uri;
  }
}

/** Folderul e deja deschis în fereastra curentă? (case-insensitive pe Windows) */
function isAlreadyOpen(vscode: typeof import('vscode'), target: string): boolean {
  const norm = (value: string) => path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
  const wanted = norm(target);
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.some((f) => norm(f.uri.fsPath) === wanted);
}

/**
 * Deschide folderul. Fără `explicit`, întâi cere confirmarea (dialog modal,
 * în engleza de bază a VS Code). Întoarce `true` doar când folderul a fost
 * efectiv deschis; refuzul utilizatorului lasă mesajul în fluxul normal.
 */
async function openFolder(
  vscode: typeof import('vscode'),
  target: string,
  plan: OpenFolderPlan
): Promise<boolean> {
  if (!plan.explicit) {
    const OPEN = 'Open Folder';
    const answer = await vscode.window.showWarningMessage(
      'Open this folder in the current window?',
      { modal: true, detail: target },
      OPEN
    );
    if (answer !== OPEN) {
      log('direct open_folder declined path=' + target);
      return false;
    }
  }

  chatLog('executing vscode.openFolder');
  try {
    await vscode.commands.executeCommand('vscode.openFolder', folderUri(vscode, target), {
      forceReuseWindow: true
    });
    chatLog('opened folder: ' + target);
    return true;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log('openFolder failed for ' + target + ': ' + msg);
    vscode.window.showErrorMessage('Freekit: could not open folder ' + target + ' (' + msg + ')');
    return true;
  }
}

/**
 * Deschide folderul cerut, dacă mesajul este o comandă de deschidere.
 * Întoarce `true` când mesajul a fost TRATAT (deschis, refuzat prin
 * confirmare sau eroare afișată) — atunci nu mai are rost să fie trimis la LLM.
 */
export async function tryDirectOpenFolder(text: string): Promise<boolean> {
  const plan = planOpenFolder(text);
  if (!plan) return false;

  if (plan.blocked) {
    // Întrebare sau verb distructiv: nu executăm nimic automat, mesajul merge
    // mai departe pe fluxul normal (modelul poate răspunde / cere confirmare).
    log('direct open_folder blocked reason=' + plan.blocked + ' path=' + plan.path);
    return false;
  }

  const vscode = require('vscode') as typeof import('vscode');
  const host = hostPlatform();
  const remoteName = typeof vscode.env?.remoteName === 'string' ? vscode.env.remoteName : undefined;
  if (remoteName) log('remote host: ' + remoteName + ' (' + platformLabel(host) + ')');

  const flavor = pathFlavor(plan.path);
  if (!isPathUsableOnHost(flavor, host)) {
    log(
      'direct open_folder incompatible flavor=' + flavor + ' host=' + host + ' path=' + plan.path
    );
    // Fără intenție de deschidere, mesajul nu e al nostru: îl lăsăm modelului.
    if (!plan.explicit) return false;
    vscode.window.showErrorMessage(incompatiblePathMessage(flavor, plan.path, remoteName));
    return true;
  }

  let failed = plan.path;
  let reason: StatKind = 'missing';
  for (const candidate of plan.candidates) {
    if (!isPathUsableOnHost(pathFlavor(candidate), host)) continue;
    const kind = await statKind(candidate);
    if (kind === 'dir') {
      if (isAlreadyOpen(vscode, candidate)) {
        // Folderul e deja rădăcina ferestrei: nu reîncărcăm fereastra degeaba,
        // lăsăm mesajul (eventual și restul cererii) pe fluxul normal.
        log('direct open_folder already open path=' + candidate);
        return false;
      }
      log('direct open_folder path=' + candidate + ' explicit=' + plan.explicit);
      return openFolder(vscode, candidate, plan);
    }
    if (kind !== 'missing') {
      failed = candidate;
      reason = kind;
    }
  }

  log('direct open_folder failed path=' + failed + ' reason=' + reason);
  // Doar o cerere explicită de deschidere merită o eroare afișată; dacă
  // utilizatorul doar a pomenit calea, mesajul merge la model.
  if (!plan.explicit) return false;
  vscode.window.showErrorMessage(folderFailureMessage(reason, failed));
  return true;
}
