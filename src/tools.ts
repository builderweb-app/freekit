import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  detectProject,
  formatProjectInfo,
  packageManagerBin,
  runProgram
} from './project';
import {
  DEFAULT_GRACE_MS,
  findRunningDevServer,
  formatDevServerStartResult,
  isLongRunningCommand,
  isLongRunningScript,
  startDevServer
} from './devServers';
import { formatSearchResults, isSemanticEnabled } from './indexer';
import {
  MAX_CHARS_PER_FILE,
  MAX_CHARS_TOTAL,
  MAX_LINES_PER_FILE,
  clipPayload,
  truncateContent
} from './payload';
import { RESTRICTED_TOOL_ERROR } from './trust';
import {
  ScreenshotOptions,
  VisualToolContext,
  captureScreenshot,
  compareVisual,
  toTargetUrl
} from './visual';
import {
  findUnixCommands,
  translateUnixCommandToWindows,
  unixToWindowsLines
} from './unixTranslate';
import { commandErrorFiles } from './verifier';
import { logLine } from './log';
import {
  TS_ALIAS_NOTE,
  isTypeScriptPath,
  mapToolCallAliases,
  toAiPath
} from './tsAlias';

// Pending approvals: id -> resolver
export const pendingApprovals = new Map<string, (ok: boolean) => void>();

export function newApprovalId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const execAsync = promisify(exec);

export interface ToolCall {
  tool: string;
  args: Record<string, any>;
}

export interface ToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  /** v0.6.0: informații de auto-reparare pentru run_command / run_npm. */
  commandRun?: CommandRunInfo;
  /** v2.5.6: mesaj afișat utilizatorului în chat (ex: fișier trunchiat). */
  userNotice?: string;
  /** v2.5.6 (bug #10): cel puțin un fișier pare scris „din imaginație". */
  divergent?: boolean;
}

/* =========================================================================
 * v0.6.0 — Terminal Self-Correction (auto-healing)
 * Când o comandă (run_command / run_npm) eșuează, modelul primește output-ul
 * COMPLET (stdout + stderr separat, exit code, durată) + o directivă de
 * auto-reparare: analizează eroarea → repară codul → re-rulează aceeași
 * comandă. Max MAX_COMMAND_ATTEMPTS încercări per comandă per mesaj; după
 * atâtea eșecuri comanda e BLOCATĂ și modelul trebuie să răspundă cu text.
 * ========================================================================= */

export const MAX_COMMAND_ATTEMPTS = 5;

/** Output structurat al unei comenzi (terminal self-correction). */
export interface CommandResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr (păstrat pentru context complet). */
  combined: string;
  /** durata execuției în ms */
  duration: number;
}

/** Info de auto-reparare atașată rezultatului unei comenzi. */
export interface CommandRunInfo {
  /** Comanda (cheia normalizată a contorului de încercări). */
  command: string;
  /** Încercarea curentă (1-based). */
  attempt: number;
  max: number;
  exitCode: number;
  duration: number;
  /** true = ultima încercare permisă (comanda a eșuat definitiv). */
  final: boolean;
  /** true = comanda NU a fost executată (încercările erau deja epuizate). */
  blocked?: boolean;
  /** v2.5.38 (bug #89): comanda Unix a modelului, când cea executată e tradusă. */
  translatedFrom?: string;
}

// contoare de încercări per comandă (normalizată), resetate per mesaj
const commandRuns = new Map<string, number>();

/** v0.6.0: resetează contoarele de auto-reparare (la începutul fiecărui mesaj). */
export function resetCommandLimits(): void {
  commandRuns.clear();
}

/** Cheia contorului: comandă lowercased, spații colapsate. */
function normCommandKey(cmd: string): string {
  return String(cmd).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** true dacă toate încercările au fost consumate (comanda nu se mai rulează). */
function isCommandBlocked(key: string): boolean {
  return (commandRuns.get(key) ?? 0) >= MAX_COMMAND_ATTEMPTS;
}

/** Înregistrează o rulare nouă; întoarce numărul încercării (1-based). */
function beginCommandAttempt(key: string): number {
  const n = (commandRuns.get(key) ?? 0) + 1;
  commandRuns.set(key, n);
  return n;
}

/** Un succes resetează seria de eșecuri a comenzii. */
function commandSucceeded(key: string): void {
  commandRuns.delete(key);
}

/** Rezultat BLOCAT: comanda nu mai este executată (limita de încercări atinsă). */
function blockedCommandResult(command: string): ToolResult {
  return {
    ok: false,
    error:
      '⛔ BLOCKED BY SELF-CORRECTION: "' +
      command +
      '" already failed ' +
      MAX_COMMAND_ATTEMPTS +
      ' times in this message — it will NOT be executed again.\n' +
      'Do NOT retry it (not even with small variations). Either fix the root cause differently ' +
      '(re-read the errors above) or reply with PLAIN TEXT explaining what still fails and why.',
    commandRun: {
      command,
      attempt: MAX_COMMAND_ATTEMPTS,
      max: MAX_COMMAND_ATTEMPTS,
      exitCode: -1,
      duration: 0,
      final: true,
      blocked: true
    }
  };
}

function combinedOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout;
  return (
    stdout +
    (stdout && !stdout.endsWith('\n') ? '\n' : '') +
    '[stderr]\n' +
    stderr
  );
}

/**
 * Formatează rezultatul unei comenzi: succesul e scurt (cu durată și, dacă e
 * cazul, numărul de încercări); eșecul include output-ul COMPLET (stdout și
 * stderr separat) + directiva de auto-reparare (analizează → repară →
 * re-rulează) sau, la ultima încercare, directiva de stop (răspunde cu text).
 */
function formatCommandOutcome(
  toolLabel: string,
  command: string,
  res: CommandResult,
  attempt: number,
  /** v1.7.4: notă suplimentară (ex. dev server oprit imediat după pornire). */
  note?: string,
  /** v2.5.38 (bug #89): comanda Unix originală, când cea executată e tradusă. */
  translatedFrom?: string
): ToolResult {
  const seconds = (res.duration / 1000).toFixed(1);
  const attemptTag = 'attempt ' + attempt + '/' + MAX_COMMAND_ATTEMPTS;
  const trNote = translatedFrom
    ? '(⚙️ auto-translated from Unix: ' + translatedFrom + ')'
    : '';

  if (res.ok) {
    const note = attempt > 1 ? ' — ✓ fixed after ' + attempt + ' attempts' : '';
    return {
      ok: true,
      // v2.5.23: buget de payload (cap+coadă) — un build verbos nu mai trimite
      // 20k caractere către web app (răspuns lent la toate modelele).
      result: clipPayload(
        '✓ ' + toolLabel + ': ' + command + ' (exit 0, ' + seconds + 's' + note + ')\n' +
          (trNote ? trNote + '\n' : '') +
          res.combined,
        MAX_CHARS_TOTAL
      ),
      commandRun: {
        command,
        attempt,
        max: MAX_COMMAND_ATTEMPTS,
        exitCode: 0,
        duration: res.duration,
        final: false,
        ...(translatedFrom ? { translatedFrom } : {})
      }
    };
  }

  const final = attempt >= MAX_COMMAND_ATTEMPTS;
  const directive = final
    ? '⛔ SELF-CORRECTION LIMIT REACHED (' +
      MAX_COMMAND_ATTEMPTS +
      '/' +
      MAX_COMMAND_ATTEMPTS +
      '): "' +
      command +
      '" failed ' +
      MAX_COMMAND_ATTEMPTS +
      ' times — it will be BLOCKED if retried.\n' +
      'STOP running it. Reply with PLAIN TEXT (no tool JSON): what you tried, the last error, and what still needs fixing manually.'
    : '⟳ SELF-CORRECTION (' +
      attempt +
      '/' +
      MAX_COMMAND_ATTEMPTS +
      '): the FULL error output is below.\n' +
      '1) Read the error and find the ROOT CAUSE.\n' +
      '2) Fix it in the source with edit_file / write_file.\n' +
      '3) Re-run the SAME command to verify the fix.\n' +
      'Never re-run a failing command before changing code.';

  // v2.5.23: fiecare stream pe buget de fișier, mesajul final pe buget total —
  // cap+coadă, ca directivele de la început și ultimele erori să supraviețuiască.
  const parts: string[] = [];
  if (res.stdout.trim()) {
    parts.push('--- STDOUT ---\n' + clipPayload(res.stdout.trim(), MAX_CHARS_PER_FILE));
  }
  if (res.stderr.trim()) {
    parts.push('--- STDERR ---\n' + clipPayload(res.stderr.trim(), MAX_CHARS_PER_FILE));
  }
  if (!parts.length) {
    parts.push(clipPayload(res.combined.trim() || '(no output)', MAX_CHARS_PER_FILE));
  }

  return {
    ok: false,
    error: clipPayload(
      '✗ ' + toolLabel + ': ' + command + '\n' +
      'COMMAND FAILED — exit ' + res.exitCode +
      (res.exitCode === 124 ? ' [TIMEOUT — the process was stopped]' : '') +
      ', ' + seconds + 's (' + attemptTag + ')\n\n' +
      (trNote ? trNote + '\n\n' : '') +
      (note ? note + '\n\n' : '') +
      directive + '\n\n' + parts.join('\n\n'),
      MAX_CHARS_TOTAL
    ),
    commandRun: {
      command,
      attempt,
      max: MAX_COMMAND_ATTEMPTS,
      exitCode: res.exitCode,
      duration: res.duration,
      final,
      ...(translatedFrom ? { translatedFrom } : {})
    }
  };
}

/* =========================================================================
 * v0.5.0 — Diff & Review nativ
 * Fiecare scriere de fișier trimite și un preview structurat (conținutul
 * vechi + cel nou), ca chatView-ul să poată deschide un diff NATIV VS Code
 * în locul cardului text din chat. Când `changes` lipsește (comenzi, git),
 * aprobarea rămâne pe cardul clasic din webview.
 * ========================================================================= */

export interface FileChangePreview {
  /** Calea relativă afișată în titlul diff-ului. */
  label: string;
  /** Conținutul actual al fișierului ('' dacă nu există încă). */
  oldContent: string;
  /** Conținutul propus (scris doar după acceptare). */
  newContent: string;
  /** true = fișier nou (nu există pe disc). */
  isNew: boolean;
  /** v2.5.6 (bug #10): conținutul pare scris „din imaginație" față de prompt. */
  divergent?: boolean;
}

export type ApprovalFn = (
  tool: string,
  path: string,
  diff: string,
  /** v0.5.0: preview per fișier pentru diff-ul nativ (opțional). */
  changes?: FileChangePreview[]
) => Promise<boolean>;

/* =========================================================================
 * v2.5.30 FIX 1 (bug #68) — Scope-limited auto-approve
 * Auto-approve aproba ORICE scriere, inclusiv în codul extensiei (src/*) și în
 * fișierele critice de configurare, deși task-ul era „repară erorile din
 * bootcamp-test/". Aici detectăm scope-ul task-ului din PRIMUL mesaj al
 * utilizatorului (folderele / fișierele menționate explicit) și verificăm dacă
 * o cale e în acel scope. În afara scope-ului, chatView cere confirmare
 * manuală chiar dacă auto-approve e ON. Scope nedeterminat ⇒ null ⇒ orice
 * fișier e tratat ca în afara scope-ului (fail-closed).
 * ========================================================================= */

/**
 * Căile care modifică fișiere (target-ul aprobării = o cale de fișier).
 * v2.5.42 (bug #98): și ștergerile intră aici — sunt tot operații distructive
 * cu o singură cale, deci trec prin aceleași garduri de scope (bug #68).
 */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'write_files',
  'edit_file',
  // v2.5.50 FIX 3: copy_file scrie în destinație — trece prin aceleași
  // garduri de scope (ținta de aprobare = `to`, vezi FileChangePreview)
  'copy_file',
  'delete_file',
  'delete_directory'
]);

/** Extensiile considerate „fișier" la scanarea textului task-ului. */
const SCOPE_FILE_EXTS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|astro|html|htm|css|scss|' +
  'sass|less|py|pyi|go|rs|java|kt|kts|rb|php|vue|svelte|yaml|yml|toml|ini|' +
  'txt|sh|bash|ps1|bat|cmd|cs|c|cc|cpp|h|hpp|sql|xml|svg|lock|env';

/** `bootcamp-test/src/a.ts`, `./src/x/y`, `src/chatView.ts` etc. */
const SCOPE_SLASH_PATH_RE =
  /(?:^|[\s"'`(\[<,])((?:\.{1,2}\/)?[\w.@~+-]+(?:\/[\w.@~+-]+)+)/g;
/** Folder cu bară finală: `bootcamp-test/`, `src/`, `.git/`. */
const SCOPE_TRAILING_FOLDER_RE =
  /(?:^|[\s"'`(\[<,])((?:\.{1,2}\/|[\w.@~+-]+\/))(?=[\s"'`)\]}>,.;:!?]|$)/g;
/** Fișier cu extensie cunoscută, fără folder: `tsconfig.json`, `package.json`. */
const SCOPE_FILE_RE = new RegExp(
  '(?:^|[\\s"\'`(\\[<,])([\\w.@~+-]+\\.(?:' + SCOPE_FILE_EXTS + '))\\b',
  'g'
);
/** Dotfile: `.gitignore`, `.vscodeignore`, `.env`. */
const SCOPE_DOTFILE_RE = /(?:^|[\s"'`(\[<,])(\.[\w-]+)\b/g;

/** Token care pare URL (domeniu), nu cale de proiect. */
const SCOPE_URL_LIKE_RE =
  /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|app|co|me|edu|gov)(?:\/|$)/i;

/**
 * v2.5.42 (bug #97): formulările care INTERZIC atingerea unei căi. O cale
 * menționată într-o propoziție negativă („Nu folosi src/") NU e o țintă a
 * task-ului: inclusă fiind în scope, warning-ul de post-task (bug #91) raporta
 * „folderul src/ încă există (52 fișiere)" după fiecare task cu cleanup.
 */
const SCOPE_NEGATION_RE = new RegExp(
  '(?:^|[^\\w])(?:' +
    'nu\\s+(?:folosi|folosi[tț]i|utiliza|utiliza[tț]i|modifica|modifica[tț]i|' +
    'atinge|atinge[tț]i|edita|edita[tț]i|schimba|schimba[tț]i|[sș]terge|[sș]terge[tț]i|' +
    'crea|crea[tț]i|rescrie|rescrie[tț]i)' +
    "|(?:do\\s+not|don'?t|never)\\s+(?:use|modify|touch|edit|change|delete|remove|create|rewrite)" +
    '|leave\\s+(?:it\\s+)?alone' +
    '|avoid' +
    '|f[ăa]r[ăa]' +
    ')' +
    '(?:\\s+(?:the|a|an|any|this|that|folder|file|dir|directory|' +
    'folderul|fisierul|fi[sș]ierul|directorul|din|from))*' +
    '\\s*[:,\\-–]?\\s*["\'`(\\[<]?\\s*$',
  'i'
);

/** v2.5.42 (bug #97): mențiunea de la `pathStart` vine după o interdicție? */
function isNegatedScopeMention(text: string, pathStart: number): boolean {
  return SCOPE_NEGATION_RE.test(text.slice(0, pathStart));
}

/** Indexul din text unde începe chiar calea (nu separatorul prins de regex). */
function scopePathStart(m: RegExpExecArray): number {
  return m.index + m[0].length - m[1].length;
}

/** Normalizează o cale pentru comparații (separatori, `./`, bară finală, caz). */
function normalizeScopePath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .replace(/\s+$/, '')
    .toLowerCase();
}

/** Ultimul segment al unei căi (`a/b/c.ts` → `c.ts`). */
function scopeBasename(p: string): string {
  const n = String(p ?? '');
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

/** Intrarea pare FIȘIER (ultimul segment are o extensie cunoscută), nu folder. */
function looksLikeFileEntry(p: string): boolean {
  return new RegExp('\\.(?:' + SCOPE_FILE_EXTS + ')$', 'i').test(
    scopeBasename(p)
  );
}

/**
 * v2.5.30 FIX 1 (bug #68): scope-ul task-ului = folderele / căile menționate
 * explicit în text (de regulă primul mesaj al utilizatorului). Întoarce o listă
 * normalizată de căi, sau `null` când nu se poate determina niciuna.
 *
 * v2.5.32 FIX (bug #80): scope-ul era prea permisiv — „repară erorile din
 * bootcamp-test/" + fișierele enumerate în prompt dădeau scope
 * `[bootcamp-test, index.ts, utils.ts, test.js, test.ts, changelog.md, …]`,
 * adică TOATE fișierele cu acel nume din proiect (auto-approve scria oriunde).
 * Acum: dacă textul menționează un FOLDER, scope-ul e redus la folderul
 * rădăcină (`bootcamp-test/` → `bootcamp-test`) și numele de fișiere FĂRĂ cale
 * (`index.ts`, `test.ts`, `changelog.md`, `package.json`, `tsconfig.json`) sunt
 * ignorate — sunt fișierele din folderul deja inclus, nu ținte separate.
 *
 * v2.5.42 FIX (bug #97): căile menționate NEGATIV („Nu folosi src/", „do not
 * modify src/", „avoid src/") nu mai intră în scope — altfel „Lucrează în
 * bootcamp-test2/. Nu folosi src/" dădea scope `[bootcamp-test2, src]` și
 * verificarea post-task (bug #91) raporta fals „folderul src/ încă există
 * (52 fișiere)". Scope-ul se extrage doar din instrucțiunea principală.
 */
export function detectTaskScope(userText: string): string[] | null {
  const text = String(userText ?? '');
  if (!text.trim()) return null;

  const folderRoots: string[] = [];
  const filePaths: string[] = [];
  const bareNames: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (list: string[], n: string) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    list.push(n);
  };

  // 1. căi cu separator (`bootcamp-test/index.ts`, `bootcamp-test/src`) și
  //    foldere cu bară finală (`bootcamp-test/`)
  for (const source of [SCOPE_SLASH_PATH_RE, SCOPE_TRAILING_FOLDER_RE]) {
    const re = new RegExp(source.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1];
      if (SCOPE_URL_LIKE_RE.test(raw)) continue;
      // v2.5.42 (bug #97): „Nu folosi src/" nu face din src o țintă a task-ului
      if (isNegatedScopeMention(text, scopePathStart(m))) continue;
      const n = normalizeScopePath(raw);
      if (!n || n === '.' || n === '..' || n === '/') continue;
      if (looksLikeFileEntry(n)) {
        pushUnique(filePaths, n);
      } else {
        // folder: păstrăm doar segmentul rădăcină (`bootcamp-test/src` → `bootcamp-test`)
        const rootSeg = n.split('/')[0];
        if (rootSeg && rootSeg !== '.' && rootSeg !== '..') {
          pushUnique(folderRoots, rootSeg);
        }
      }
    }
  }

  // 2. nume de fișiere fără cale (ignorate când există un folder rădăcină)
  for (const source of [SCOPE_FILE_RE, SCOPE_DOTFILE_RE]) {
    const re = new RegExp(source.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1];
      if (SCOPE_URL_LIKE_RE.test(raw)) continue;
      // v2.5.42 (bug #97): nici un nume de fișier negat nu e o țintă
      if (isNegatedScopeMention(text, scopePathStart(m))) continue;
      const n = normalizeScopePath(raw);
      if (!n || n === '.' || n === '..' || n === '/') continue;
      // „index.ts" extras din „bootcamp-test/index.ts" nu e o țintă separată
      const base = scopeBasename(n);
      if (
        folderRoots.includes(base) ||
        filePaths.some((f) => scopeBasename(f) === base)
      ) {
        continue;
      }
      pushUnique(bareNames, n);
    }
  }

  const found = folderRoots.slice();
  for (const f of filePaths) {
    // căile deja acoperite de un folder rădăcină nu se mai adaugă separat
    if (folderRoots.some((r) => f === r || f.startsWith(r + '/'))) continue;
    found.push(f);
  }
  if (!folderRoots.length) {
    for (const b of bareNames) found.push(b);
  }

  return found.length ? found : null;
}

/**
 * v2.5.30 FIX 1 (bug #68): calea `file` e în scope? O intrare de scope acoperă
 * fișierul însuși și tot ce e sub el (`scope/folder/…`). Scope `null`/gol ⇒
 * `false` (nu se poate confirma ⇒ cerem confirmare).
 */
export function isPathInScope(
  file: string,
  scope: string[] | null | undefined
): boolean {
  if (!scope || !scope.length) return false;
  const f = normalizeScopePath(file);
  if (!f) return false;
  for (const s of scope) {
    const n = normalizeScopePath(s);
    if (!n) continue;
    if (f === n || f.startsWith(n + '/')) return true;
  }
  return false;
}

export interface ScopeCheck {
  /** true ⇒ confirmarea manuală e obligatorie (unul sau mai multe fișiere ies din scope). */
  blocked: boolean;
  /** Căile din afara scope-ului task-ului. */
  outside: string[];
}

/**
 * v2.5.30 FIX 1 (bug #68): verifică dacă auto-approve poate acoperi operația.
 * Doar scrierile de fișiere sunt verificate; comenzile/git nu au o cale țintă
 * de urmărit aici. Dacă nu se poate determina lista de fișiere (fără `changes`
 * și fără target de cale), operația e blocată (fail-closed).
 */
export function checkAutoApproveScope(
  tool: string,
  target: string,
  changes: FileChangePreview[] | undefined,
  scope: string[] | null
): ScopeCheck {
  if (!FILE_WRITE_TOOLS.has(tool)) return { blocked: false, outside: [] };
  const files =
    changes && changes.length
      ? changes.map((c) => c.label).filter((l) => !!l)
      : target
        ? [target]
        : [];
  if (!files.length) return { blocked: true, outside: [] };
  const outside = files.filter((f) => !isPathInScope(f, scope));
  return { blocked: outside.length > 0, outside };
}

/* =========================================================================
 * v2.5.39 FIX (bug #91) — verificarea „adevărului" după task
 * În testul v2.5.37 modelul a ratat pasul 9 (cleanup-ul `rm bootcamp-test2/…`)
 * și a raportat totuși „10/10", deși folderul rămăsese pe disc cu 7 fișiere:
 * raportul final e doar text și nimeni nu verifica realitatea. Aici detectăm
 * din cerința utilizatorului intenția de cleanup („șterge", "delete", "remove",
 * "rm", "del", "cleanup") și, la final, ce a mai rămas din scope-ul task-ului.
 * chatView afișează un avertisment — NU blochează nimic.
 * ========================================================================= */

/** Verbele de cleanup din cerință (RO + EN, cu diacritice sau fără). */
const CLEANUP_INTENT_RE =
  /(?:șterg\w*|sterg\w*|delete\w*|remov(?:e|es|ed|ing)\b|\brmdir\b|\bcleanup\b|\bclean-up\b|\brm\b|\bdel\b)/i;

/** true când cerința utilizatorului vorbește despre ștergere / curățare. */
export function hasCleanupIntent(userText: string): boolean {
  return CLEANUP_INTENT_RE.test(String(userText ?? ''));
}

/** Literele cu semnificație specială într-un regex. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * v2.5.39 (bug #91): verbul de cleanup LIPIT de chiar calea dată
 * („delete bootcamp-test2/test.ts", „șterge folderul bootcamp-test2"). Pentru
 * FIȘIERE cuvântul singur nu e destul: „remove the unused import from src/x.ts"
 * nu cere ștergerea fișierului, iar fișierul rămâne (corect) pe disc — acolo un
 * avertisment ar fi o alarmă falsă.
 */
export function cleanupTargetsPath(userText: string, relPath: string): boolean {
  const text = String(userText ?? '').replace(/\\/g, '/');
  const full = escapeRe(relPath.replace(/\\/g, '/').replace(/\/+$/, ''));
  if (!full) return false;
  const base = escapeRe(scopeBasename(relPath).replace(/\/+$/, ''));
  const re = new RegExp(
    // `[^\w]` în loc de `\b`: verbele românești încep cu diacritice („șterge"),
    // care nu sunt caractere de cuvânt pentru \b, deci \b ar rata la început.
    '(?:^|[^\\w])(?:șterg\\w*|sterg\\w*|delete\\w*|remov\\w*|rmdir|rm|del|cleanup|clean-up)' +
      '(?:[ \\t]*-[A-Za-z]+)*' +
      '(?:[ \\t]+(?:the|this|that|all|a|an|my|our|file|files|fisier|fișier|fisierul|fișierul|folder|folders|folderul|dir|directory|subfolder|and|then))*' +
      '[ \\t]*[:,-]?[ \\t]*(?:["\'`])?(?:' + full + '|' + base + ')',
    'i'
  );
  return re.test(text);
}

/**
 * v2.5.39 (bug #91): merită verificat cleanup-ul pentru intrarea rămasă în
 * scope? Folderele: orice verb de cleanup din cerință (cerința bug #91).
 * Fișierele: doar când verbul vizează exact acea cale (anti-alarmă-falsă).
 */
export function cleanupIntentTargets(
  userText: string,
  leftover: ScopeLeftover
): boolean {
  if (leftover.directory) return hasCleanupIntent(userText);
  return cleanupTargetsPath(userText, leftover.path);
}

/** Ce a mai rămas din scope-ul task-ului după ce AI-ul a declarat „gata". */
export interface ScopeLeftover {
  /** Intrarea din scope care încă există (cale relativă la root). */
  path: string;
  /** true = folder, false = fișier. */
  directory: boolean;
  /** Fișiere găsite în folder (recursiv), sau 1 pentru un fișier. */
  files: number;
}

/** Plafon de siguranță la numărătoarea fișierelor rămase. */
const SCOPE_COUNT_LIMIT = 2000;

/** Foldere ignorate la numărătoare (nu sunt „rezultatul" task-ului). */
const SCOPE_IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** Câte fișiere (recursiv) sunt în folderul `dir`, cu un buget de siguranță. */
function countFilesIn(dir: string, budget: { left: number }): number {
  if (budget.left <= 0) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (budget.left <= 0) break;
    budget.left--;
    if (entry.isDirectory()) {
      if (SCOPE_IGNORED_DIRS.has(entry.name)) continue;
      count += countFilesIn(path.join(dir, entry.name), budget);
    } else {
      count++;
    }
  }
  return count;
}

/**
 * v2.5.39 (bug #91): avertismentul din chat când scope-ul task-ului încă
 * există după un task care cerea cleanup. `claim` = scorul declarat de AI
 * („10/10"), dacă există în răspunsul final.
 */
export function buildPostTaskWarning(
  leftover: ScopeLeftover,
  claim?: string
): string {
  const target = leftover.path.replace(/\\/g, '/');
  const found =
    leftover.files === 1 ? '1 fișier' : leftover.files + ' fișiere';
  const what = leftover.directory
    ? 'folderul ' + target + '/ încă există (' + found + ')'
    : 'fișierul ' + target + ' încă există';
  return (
    '⚠️ Verificare post-task: ' +
    what +
    ' — AI-ul a declarat ' +
    (claim ?? 'task-ul terminat') +
    ', dar cleanup-ul nu s-a executat.'
  );
}

/**
 * v2.5.39 (bug #91): ce a mai rămas din scope-ul task-ului. Intrările dispărute
 * sunt rezultatul bun (cleanup reușit) și se sar; rădăcina proiectului nu e
 * niciodată raportată. `null` = nimic rămas (sau scope nedeterminat).
 */
export function inspectScopeLeftover(
  root: string,
  scope: string[] | null | undefined
): ScopeLeftover | null {
  if (!scope || !scope.length) return null;
  const rootAbs = path.resolve(root);
  for (const entry of scope) {
    const rel = String(entry ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    if (!rel) continue;
    const abs = path.resolve(rootAbs, rel);
    // scope-ul e mereu în interiorul root-ului; rădăcina însăși nu e „rămasă"
    if (abs === rootAbs || !abs.startsWith(rootAbs + path.sep)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // șters — exact ce trebuia să se întâmple
    }
    if (stat.isDirectory()) {
      const files = countFilesIn(abs, { left: SCOPE_COUNT_LIMIT });
      if (files > 0) return { path: rel, directory: true, files };
      continue; // folder gol: nu-l raportăm ca „rămas cu fișiere"
    }
    return { path: rel, directory: false, files: 1 };
  }
  return null;
}

/** Eticheta scope-ului pentru log/notificări. */
export function scopeLabel(scope: string[] | null | undefined): string {
  return scope && scope.length ? scope.join(', ') : 'not detected';
}

/**
 * v2.5.30 FIX 2 (bug #69): când o comandă (tsc/build) eșuează, fișierele din
 * eroare pot fi în AFARA scope-ului task-ului (ex: task în bootcamp-test/, dar
 * erorile rămase în src/). Adăugăm un hint explicit ca modelul să NU modifice
 * acele fișiere și să raporteze blocajul în loc să improvizeze.
 */
export function buildOutsideScopeHint(
  errorOutput: string,
  scope: string[] | null
): string {
  const outside = commandErrorFiles(errorOutput).filter(
    (f) => !isPathInScope(f, scope)
  );
  if (!outside.length) return '';
  const shown = outside.slice(0, 5).join(', ');
  return (
    '\n\n⚠️ The errors are in ' +
    shown +
    '. Do NOT modify these files — they are outside your task scope (' +
    scopeLabel(scope) +
    '). If the task cannot be completed without modifying them, STOP and ' +
    'report the issue.'
  );
}

/**
 * v2.5.31 (bug #72): comanda rulează deja în folderul scope-ului (`cd X && …`)?
 * Căutăm poziția folderului și verificăm doar vecinătatea (fără regex pe cale).
 */
function commandRunsInFolder(command: string, folder: string): boolean {
  const cmd = String(command ?? '').toLowerCase();
  const dir = String(folder ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!cmd || !dir) return false;
  const idx = cmd.indexOf(dir);
  if (idx < 0) return false;
  const before = cmd.slice(0, idx);
  const after = cmd.slice(idx + dir.length);
  return /\bcd\s+["']?$/.test(before) && /^["']?\s*(&&|;)/.test(after);
}

/** Folderul unei căi de scope (`bootcamp-test` din `bootcamp-test/index.ts`). */
function scopeFolder(p: string): string {
  const n = String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const i = n.lastIndexOf('/');
  return i > 0 ? n.slice(0, i) : n;
}

/**
 * v2.5.31 FIX (bug #72) — „tsc din root ignoră tsconfig.json din subfolder".
 * Task în `bootcamp-test/`: AI-ul își făcea acolo un tsconfig.json, dar comanda
 * `npx tsc --noEmit` rula din root, deci tsc folosea tsconfig.json din ROOT și
 * ignora configul din subfolder — erorile veniră din configul din root, iar
 * modelul edita la infinit `bootcamp-test/tsconfig.json` fără niciun efect.
 * Aici spunem explicit de unde vin erorile și cum se rezolvă. Se aplică doar
 * comenzilor `tsc` (și nu celor care rulează deja în scope, `cd X && …`).
 */
export function buildRootTsconfigHint(
  command: string,
  errorOutput: string,
  scope: string[] | null,
  scopeTsconfigRel: string | null
): string {
  if (!/\btsc\b/i.test(String(command ?? ''))) return '';
  if (!scope || !scope.length) return '';

  const outside = commandErrorFiles(String(errorOutput ?? '')).filter(
    (f) => !isPathInScope(f, scope)
  );
  if (!outside.length && !scopeTsconfigRel) return '';

  const folder = scopeTsconfigRel
    ? scopeFolder(scopeTsconfigRel)
    : scopeFolder(outside[0] ?? scope[0]);
  if (!folder) return '';
  if (
    commandRunsInFolder(command, folder) ||
    scope.some((s) => commandRunsInFolder(command, s))
  ) {
    return '';
  }

  if (scopeTsconfigRel) {
    return (
      '\n\n⚠️ The error comes from the ROOT tsconfig.json, not from ' +
      folder +
      '/tsconfig.json — tsc was started from the project root, which ignores the config inside ' +
      folder +
      '/.\nFixes: (1) run tsc from inside the scope: `cd ' +
      folder +
      ' && npx tsc --noEmit`, (2) OR add "' +
      folder +
      '" to "exclude" in the root tsconfig.json.\nDo NOT keep editing ' +
      folder +
      '/tsconfig.json — tsc run from the root ignores it.'
    );
  }

  return (
    '\n\n⚠️ tsc was started from the project ROOT and used the ROOT tsconfig.json (not ' +
    folder +
    '/) — these errors do not come from your scope (' +
    scopeLabel(scope) +
    ').\nFixes: (1) add "' +
    folder +
    '" to "exclude" in the root tsconfig.json, or (2) run tsc from inside the scope: `cd ' +
    folder +
    ' && npx tsc --noEmit`.\nDo NOT keep editing scope files to silence errors that come from outside the scope.'
  );
}

/* =========================================================================
 * v2.5.32 FIX (bug #78) — comenzi Unix pe Windows
 * Modelul (antrenat pe Unix) rulează `rm -rf bootcamp-test`, `ls`, `cp`, `mv`,
 * `cat <file>`, `touch`, `mkdir -p` pe Windows: comanda eșuează cu „not
 * recognized as an internal or external command", iar modelul reîncearcă
 * aceeași comandă până se termină încercările. La eșecul unei `run_command`
 * adăugăm un hint explicit cu echivalentele Windows (sau Node), ca modelul să
 * treacă direct la varianta corectă.
 * v2.5.38 (bug #89): comenzile simple sunt acum TRADUSE automat înainte de
 * execuție (src/unixTranslate.ts), deci hint-ul rămâne doar pentru cazurile
 * neacoperite (pipe, redirect, wildcard, flaguri necunoscute) — acolo comanda
 * ajunge la shell neschimbată și eșecul chiar vine din „comandă Unix".
 * v2.5.55 (FIX 2): detecția vine din `findUnixCommands` (o singură sursă de
 * adevăr cu traducerea), tabelul de echivalențe din `unixToWindowsLines`, iar
 * comenzile care NU pot fi traduse sunt blocate cu `buildUnixBlockedError`
 * (vezi cazul `run_command`) — nu mai ajung la shell.
 * ========================================================================= */

/**
 * v2.5.32 FIX (bug #78): hint-ul Unix → Windows pentru o comandă eșuată.
 * v2.5.55: listează DOAR comenzile găsite în comandă, din tabelul comun.
 * Întoarce '' pe non-Windows sau când comanda nu folosește utilitare Unix.
 */
export function buildUnixCommandHint(command: string): string {
  if (process.platform !== 'win32') return '';
  const found = findUnixCommands(command);
  if (!found.length) return '';
  return (
    '\n\n⚠️ You are on Windows: ' +
    found.join(', ') +
    ' is a Unix command, not available in cmd/PowerShell (this is why the command failed).\n' +
    'Use instead:\n' +
    unixToWindowsLines(found) +
    "\nOR use Node: require('fs').unlinkSync('<file>'), require('fs').mkdirSync('<dir>', { recursive: true }), " +
    "require('fs').readFileSync('<file>', 'utf8').\n" +
    'OR use the built-in tools: search_files(pattern), list_files(dir), read_file(path).'
  );
}

/**
 * v2.5.55 (FIX 2): eroarea clară pentru o comandă Unix pe care traducerea
 * automată NU o poate acoperi (`find` cu predicate, `rm` cu wildcard,
 * pipe/redirect cu utilitare Unix). Comanda NU se execută: raportul din
 * 8 Oct 2026 arăta exact 3 eșecuri identice până la circuit breaker.
 */
export function buildUnixBlockedError(command: string, blocked: string[]): string {
  const names = blocked.join(', ');
  return (
    '⛔ NOT EXECUTED — Unix command on Windows: "' + command + '"\n' +
    names +
    (blocked.length > 1 ? ' are Unix commands that do' : ' is a Unix command that does') +
    ' not exist in cmd/PowerShell, so this command cannot work here. It was blocked instead of run (and failed) again.\n' +
    'This is a WINDOWS environment. Use the Windows equivalent:\n' +
    unixToWindowsLines(blocked) +
    '\nOr use the built-in tools: search_files(pattern), list_files(dir), read_file(path) — they accept an ABSOLUTE path too, so they work in every workspace folder (see PROJECT STRUCTURE).\n' +
    'Example (searching another workspace folder for a plugin): ' +
    '{"action":"run_command","args":{"command":"dir /s /b \\"Z:\\\\path\\\\to\\\\wp-content\\\\plugins\\\\*seo*\\""}}'
  );
}

/* =========================================================================
 * v0.2.1 — Anti-spam la scrierea fișierelor
 * Modelul poate scrie fiecare fișier de max 3 ori și poate face max 15
 * operații de scriere per mesaj (un batch write_files = o singură operație).
 * Contorul se resetează la fiecare mesaj nou (chatView apelează
 * resetWriteLimits() la începutul buclei agentice).
 * ========================================================================= */

export const MAX_WRITES_PER_FILE = 3;
export const MAX_WRITES_TOTAL = 15;

let fileWriteCounts = new Map<string, number>();
let writeOpsTotal = 0;

export function resetWriteLimits(): void {
  fileWriteCounts = new Map();
  writeOpsTotal = 0;
  resetTruncationRetries();
  resetWriteFailures();
}

function writeKey(rel: string): string {
  return path.normalize(String(rel)).toLowerCase();
}

/** null = OK; altfel mesajul de eroare anti-spam trimis înapoi modelului. */
function checkWriteLimit(rel: string): string | null {
  const count = fileWriteCounts.get(writeKey(rel)) ?? 0;
  if (count >= MAX_WRITES_PER_FILE) {
    return (
      'ANTI-SPAM LIMIT: "' +
      rel +
      '" was already written ' +
      count +
      ' times in this message (max ' +
      MAX_WRITES_PER_FILE +
      ' per file). Write the COMPLETE file content in ONE write_file call ' +
      'instead of adding pieces one by one. If the file is already written, ' +
      'STOP and reply with the final answer.'
    );
  }
  if (writeOpsTotal >= MAX_WRITES_TOTAL) {
    return (
      'ANTI-SPAM LIMIT: maximum ' +
      MAX_WRITES_TOTAL +
      ' file write operations per message reached. ' +
      'Stop writing files and reply with the final answer.'
    );
  }
  return null;
}

function recordWrite(rel: string): void {
  const key = writeKey(rel);
  fileWriteCounts.set(key, (fileWriteCounts.get(key) ?? 0) + 1);
  // v2.5.6: o scriere reușită resetează retry-urile de trunchiere ale fișierului
  truncationRetries.delete(key);
}

function recordWriteCall(): void {
  writeOpsTotal++;
}

/* =========================================================================
 * v2.5.29 FIX 3 (bug #67) — Anti-spam, nivel 2: `write_file` EȘUAT
 * Anti-spam-ul de mai sus numără scrierile REUȘITE (max 3/fișier). Aici
 * numărăm EȘECURILE lui `write_file` pe același fișier: la al doilea eșec,
 * mesajul standard primește un adaos explicit (append ⇒ edit_file cu
 * OLD_TEXT/NEW_TEXT; înlocuire completă ⇒ UN singur write_file cu tot
 * conținutul), ca modelul să nu repete aceeași scriere nereușită.
 * ========================================================================= */

/** Al câtelea eșec pe același fișier primește mesajul suplimentar. */
export const WRITE_FAILURES_BEFORE_WARNING = 2;

/** Mesajul de nivel 2 ({file} = calea fișierului). */
export const WRITE_FAILURE_WARNING =
  '⚠️ write_file failed twice on {file}. If you are trying to append, use ' +
  'edit_file with OLD_TEXT/NEW_TEXT. If the file needs to be replaced ' +
  'entirely, send ONE write_file with the full content.';

/** Câte `write_file` au EȘUAT pe fiecare fișier, în mesajul curent. */
const writeFileFailures = new Map<string, number>();

function resetWriteFailures(): void {
  writeFileFailures.clear();
}

/**
 * Înregistrează un `write_file` eșuat. Întoarce mesajul de nivel 2 exact la al
 * doilea eșec pe același fișier, altfel null.
 */
export function noteWriteFileFailure(rel: string): string | null {
  const key = writeKey(rel);
  const count = (writeFileFailures.get(key) ?? 0) + 1;
  writeFileFailures.set(key, count);
  if (count !== WRITE_FAILURES_BEFORE_WARNING) return null;
  return WRITE_FAILURE_WARNING.replace('{file}', rel);
}

/* =========================================================================
 * v2.5.6 — Truncation Guard (Bug #11)
 * Modelul poate încheia scrierea la jumătate (ex: DeepSeek scrie un layout
 * Astro fără <header> / <footer> și fără </html>), iar utilizatorul rămâne cu
 * un fișier incomplet fără să știe. Verificăm conținutul ÎNAINTE de a-l scrie:
 * dacă pare trunchiat, fișierul NU se scrie — modelul primește un nudge să-l
 * rescrie COMPLET (max MAX_TRUNCATION_RETRIES), apoi utilizatorul e anunțat în
 * chat că modelul s-a oprit la jumătate.
 * ========================================================================= */

export const MAX_TRUNCATION_RETRIES = 2;

/** Câte scrieri trunchiate a primit fiecare fișier în mesajul curent. */
const truncationRetries = new Map<string, number>();

function resetTruncationRetries(): void {
  truncationRetries.clear();
}

/** true când `content` pare scris doar parțial (lipsesc închideri). */
export function isLikelyTruncated(path: string, content: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  const trimmed = content.trimEnd();

  switch (ext) {
    case 'astro':
    case 'html': {
      // Doar documentele complete se încheie cu </html>. Paginile care folosesc
      // un layout (<BaseLayout>...</BaseLayout>) și componentele NU conțin
      // <html> — sunt valide fără el, deci pentru ele verificăm acoladele.
      const isFullDocument =
        /<html[\s>]/i.test(content) || /<!doctype\s+html/i.test(content);
      if (!isFullDocument) {
        const docOpens = (content.match(/\{/g) || []).length;
        const docCloses = (content.match(/\}/g) || []).length;
        return docOpens !== docCloses;
      }
      return !trimmed.toLowerCase().endsWith('</html>');
    }
    case 'json':
      return !trimmed.endsWith('}') && !trimmed.endsWith(']');
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx': {
      // Verifică balanța acoladelor
      const opens = (content.match(/\{/g) || []).length;
      const closes = (content.match(/\}/g) || []).length;
      return opens !== closes;
    }
    case 'css': {
      const cssOpens = (content.match(/\{/g) || []).length;
      const cssCloses = (content.match(/\}/g) || []).length;
      return cssOpens !== cssCloses;
    }
    case 'mjs': {
      // La fel ca js
      const mo = (content.match(/\{/g) || []).length;
      const mc = (content.match(/\}/g) || []).length;
      return mo !== mc;
    }
    default:
      return false;
  }
}

/**
 * Verifică un conținut înainte de scriere. Când întoarce ceva, fișierul NU se
 * scrie: `error` merge la model (nudge de rescriere completă), iar
 * `userNotice` — doar după epuizarea retry-urilor — e afișat în chat.
 */
function checkTruncation(
  toolName: string,
  rel: string,
  content: string
): { error: string; userNotice?: string } | null {
  if (!isLikelyTruncated(rel, content)) return null;

  const key = writeKey(rel);
  const attempts = (truncationRetries.get(key) ?? 0) + 1;
  truncationRetries.set(key, attempts);

  if (attempts > MAX_TRUNCATION_RETRIES) {
    return {
      error:
        'TRUNCATION LIMIT REACHED for "' +
        rel +
        '" (' +
        toolName +
        '): the content was still incomplete after ' +
        MAX_TRUNCATION_RETRIES +
        ' retries, so the file was NOT written. Do not try again — reply with ' +
        'plain text and let the user decide how to continue.',
      userNotice:
        '⚠️ File ' +
        rel +
        ' appears truncated after ' +
        MAX_TRUNCATION_RETRIES +
        ' attempts. The AI may have hit a length limit. Try: (a) smaller file, ' +
        '(b) different provider, (c) split into multiple files.'
    };
  }

  return {
    error:
      'Your previous ' +
      toolName +
      ' for ' +
      rel +
      ' appears TRUNCATED. ' +
      'You must write the COMPLETE file. Do not stop in the middle. ' +
      'Write the entire content, including the closing tags/braces. ' +
      'Try again with the FULL content.'
  };
}

/* =========================================================================
 * v2.5.6 — Divergence Guard (Bug #10)
 * Modelul poate scrie cu totul altceva decât i s-a cerut (ex: i se dă
 * brand.coral = '#ff564a' și scrie configul Tailwind default, albastru), iar
 * utilizatorul aprobă un fișier greșit fără să știe. Comparăm conținutul scris
 * cu fragmentul de cod din ultimul mesaj al utilizatorului; dacă seamănă prea
 * puțin, marcăm fișierul ca divergent. WARNING ONLY — fără retry (retry-ul
 * poate produce tot un răspuns improvizat) și fără blocarea acceptării.
 * ========================================================================= */

export const DIVERGENCE_THRESHOLD = 0.5;

/**
 * Linie normalizată pentru comparație: fără spații la capete, lowercase și
 * fără virgula/punct-virgula finală (modelul scrie des `brand: x,` iar
 * promptul `brand: x` — nu e o diferență de conținut).
 */
function normalizeLine(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/[,;]+$/, '')
    .trim();
}

/** Liniile „semnificative" ale unui text (normalizate, fără liniile triviale). */
function significantLines(text: string): Set<string> {
  return new Set(
    String(text ?? '')
      .split('\n')
      .map(normalizeLine)
      .filter((l) => l.length > 3)
  );
}

/** Blocurile de cod (```) din text, cu poziția lor în text. */
function matchCodeFences(text: string): Array<{ content: string; index: number }> {
  const out: Array<{ content: string; index: number }> = [];
  const regex = /```[\w]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    out.push({ content: m[1].trim(), index: m.index });
  }
  return out;
}

/** Conținutul fiecărui bloc de cod (```) din text. */
export function extractCodeFences(text: string): string[] {
  return matchCodeFences(String(text ?? '')).map((f) => f.content);
}

/** Similaritate Jaccard pe linii normalizate (trim + lowercase). */
export function contentSimilarity(a: string, b: string): number {
  const linesA = significantLines(a);
  const linesB = significantLines(b);
  if (linesA.size === 0 && linesB.size === 0) return 1;
  const intersection = new Set([...linesA].filter((l) => linesB.has(l)));
  const union = new Set([...linesA, ...linesB]);
  return intersection.size / union.size;
}

/**
 * Cât din referință (liniile cerute) apare efectiv în conținutul scris,
 * ponderat cu lungimea liniei: liniile lungi și specifice (ex:
 * `brand: { coral: '#ff564a' }`) cântăresc mai mult decât scheletul comun
 * (`theme: {`, `colors: {`) — altfel un config Tailwind default ar „conține"
 * aparent aproape tot ce s-a cerut, doar pentru că are aceeași structură.
 */
function fenceContainment(reference: string, content: string): number {
  const wanted = significantLines(reference);
  if (!wanted.size) return 1;
  const written = significantLines(content);
  let total = 0;
  let found = 0;
  for (const line of wanted) {
    total += line.length;
    if (written.has(line)) found += line.length;
  }
  return total ? found / total : 1;
}

/** Token care arată ca un nume de fișier (ex: `tailwind.config.mjs`). */
const FILE_TOKEN_RE =
  /(?:^|[\s"'`([{<])[\w.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|astro|html|htm|css|scss|sass|less|md|mdx|ya?ml|py|go|rs|java|rb|php|sh|ps1|sql|txt|env)\b/i;

/**
 * true când `content` pare scris „din imaginație": seamănă prea puțin cu
 * fragmentul relevant din prompt (Jaccard < DIVERGENCE_THRESHOLD) ȘI lipsește
 * o parte semnificativă din liniile cerute (containment ponderat < prag).
 * Al doilea test evită avertismentele false când modelul scrie fișierul
 * COMPLET pornind de la un fragment din prompt (toate liniile cerute apar).
 */
export function isDivergentFromPrompt(
  userText: string | undefined,
  filePath: string,
  content: string
): boolean {
  const text = String(userText ?? '');
  if (!text.trim() || !String(content ?? '').trim()) return false;

  const fences = matchCodeFences(text);
  if (!fences.length) return false;

  const base = path.basename(filePath).toLowerCase();
  const lowerText = text.toLowerCase();

  // 1) un bloc care numește fișierul (ex: „// tailwind.config.mjs")
  let reference = fences.find((f) => f.content.toLowerCase().includes(base));

  // 2) blocul care urmează menționării numelui fișierului în prompt
  //    („fă-mi tailwind.config.mjs:\n```…```")
  if (!reference) {
    const at = lowerText.indexOf(base);
    if (at !== -1) reference = fences.find((f) => f.index > at);
  }

  // 3) promptul nu numește NICIUN fișier și are un singur bloc → blocul e
  //    referința („creează fișierul:\n```…```"). Dacă promptul vorbește despre
  //    alte fișiere, blocul nu e al acestui fișier — compararea ar da
  //    avertismente false pe fiecare fișier scris.
  if (!reference && fences.length === 1 && !FILE_TOKEN_RE.test(text)) {
    reference = fences[0];
  }

  // nu putem ști la ce se referă promptul → nu avertizăm (anti false-positive)
  if (!reference) return false;

  if (contentSimilarity(reference.content, content) >= DIVERGENCE_THRESHOLD) {
    return false;
  }
  return fenceContainment(reference.content, content) < DIVERGENCE_THRESHOLD;
}

/* =========================================================================
 * v1.1.2 — SYSTEM_PROMPT rescris (tool calls forțate)
 * AI-ul e obligat să răspundă la orice cerere de ACȚIUNE cu un SINGUR tool
 * call JSON pe o linie („NO introductions, NO explanations, ONLY JSON"), cu
 * exemple concrete de workflow. PROJECT INFO / PROJECT STRUCTURE se
 * injectează prin placeholder-ele {PROJECT_INFO} / {PROJECT_STRUCTURE}.
 * v2.5.26 (bug #51) — REFRAMING: cuvântul „tool" declanșa la ChatGPT free
 * auto-identificarea „sunt un chatbot, nu am unelte native", deci modelul
 * refuza protocolul („the tools aren't actually exposed to me here").
 * Promptul vorbește acum de „actions" (ca un API de function calling: clientul
 * execută, modelul doar emite), interzice explicit refuzul și include exemple
 * few-shot cu replicile clientului. Parserul acceptă AMBELE forme
 * (`ACTION:` / `TOOL:`, `{"action":...}` / `{"tool":...}`) — vezi
 * src/toolCallParser.ts.
 * ========================================================================= */

/**
 * v2.5.55 (FIX 4): nota de mediu din system prompt. Modelul (antrenat pe Unix)
 * scria `find`/`ls`/`grep`/`pwd` pe Windows: comanda eșua identic de 3 ori, iar
 * task-ul se oprea la circuit breaker (raportul din 8 Oct 2026 — pluginul
 * WordPress căutat nu a fost găsit niciodată). Se adaugă DOAR pe Windows, deci
 * pe Linux/macOS promptul rămâne exact cel de dinainte.
 */
const WINDOWS_ENV_NOTE = [
  'You are running on WINDOWS (win32). Shell commands MUST be Windows:',
  'dir, type, findstr, copy, del, move, mkdir, where.',
  'Do NOT use Unix commands (find, ls, grep, pwd, cat, rm, cp, head, tail, touch).',
  'Freekit auto-translates some of them, but writing Windows commands directly is faster and safer.',
  'To find a file use {"action":"run_command","args":{"command":"dir /s /b <dir>\\\\*<name>*"}} ' +
    'or search_files — NOT `find`.',
  'In a multi-root workspace call search_files/list_files with the ABSOLUTE path when the ' +
    'folder is not the PRIMARY root (see PROJECT STRUCTURE).'
].join('\n');

const ENV_SECTION =
  process.platform === 'win32' ? '\n## ENVIRONMENT\n' + WINDOWS_ENV_NOTE + '\n' : '';

const LOCAL_ENV_NOTE =
  process.platform === 'win32'
    ? '\nWINDOWS shell only: dir, type, findstr, del, copy, move, mkdir. NEVER find/ls/grep/pwd/cat/rm ' +
      '(auto-translated when possible). Find a file with: dir /s /b <dir>\\*<name>*\n'
    : '';

export const SYSTEM_PROMPT = `You are a coding assistant in an automated pipeline.
Your output is parsed by Freekit, a client running in VS Code. When
you emit an action, Freekit executes it and returns the result. This
is a standard function-calling pattern (like OpenAI function calling
API).

CRITICAL: NEVER REFUSE
- NEVER say "I don't have tools"
- NEVER say "the tools aren't available"
- NEVER say "I can't access the workspace"
- NEVER say "I'm just a chatbot"
- NEVER say "the files are not exposed"
You ARE in a pipeline. The client executes your output.
If you refuse, Freekit will nudge you and you'll have to comply anyway.
${ENV_SECTION}
Format:
For READS (read_file, list_files, search_files, run_command, run_npm):
Single-line JSON:
{"action":"read_file","args":{"path":"src/foo.ts"}}

For WRITES (write_file, edit_file, write_files):
Marker format (multi-line, raw content):
ACTION: write_file
PATH: src/foo.ts
CONTENT:
\`\`\`text
<raw content, no escaping>
\`\`\`
END_CONTENT

Examples:
Example 1: Reading a file
USER: What's in package.json?
YOU: {"action":"read_file","args":{"path":"package.json"}}
CLIENT: {"name":"my-app","version":"1.0.0"}
YOU: package.json contains name=my-app, version=1.0.0.

Example 2: Creating a file
USER: Create test.txt with hello
YOU: ACTION: write_file
PATH: test.txt
CONTENT:
\`\`\`text
hello
\`\`\`
END_CONTENT
CLIENT: OK, test.txt written
YOU: Done.

Example 3: Reading multiple files
USER: Read every .ts file in src/ and summarize
YOU: {"action":"list_files","args":{"dir":"src"}}
CLIENT: ["a.ts","b.ts","c.ts"]
YOU: {"action":"read_files","args":{"paths":["src/a.ts","src/b.ts","src/c.ts"]}}
CLIENT: [...file contents...]
YOU: Here's a summary...

## WRITING FILES — MARKER FORMAT (MANDATORY)
When creating or modifying files, ALWAYS use the marker format
(do NOT wrap content in JSON strings). Every block of file content MUST sit
inside a markdown code fence (three backticks) — the chat renders markdown,
and only a code block preserves characters like #, *, _, > and backticks
byte-for-byte. If the content itself contains a triple-backtick line, wrap it
in a LONGER fence (four or more backticks).

ACTION: write_file
PATH: <relative path>
CONTENT:
\`\`\`text
<raw file content, no escaping needed>
\`\`\`
END_CONTENT

ACTION: edit_file
PATH: <relative path>
OLD_TEXT:
\`\`\`text
<exact old text>
\`\`\`
END_OLD_TEXT
NEW_TEXT:
\`\`\`text
<new text>
\`\`\`
END_NEW_TEXT

ACTION: write_files
---FILE---
PATH: <relative path>
CONTENT:
\`\`\`text
<raw file content>
\`\`\`
END_CONTENT
---FILE---
PATH: <another relative path>
CONTENT:
\`\`\`text
<raw file content>
\`\`\`
END_CONTENT

Each marker (ACTION:, PATH:, CONTENT:, END_CONTENT, ...) sits ALONE on its line.
The opening fence sits ALONE on the line right after CONTENT: (or OLD_TEXT: /
NEW_TEXT:), and the closing fence ALONE on the line right before the END_
marker. The text between the fences is RAW: quotes, braces, backslashes, emoji
and newlines are written EXACTLY as they must appear in the file — never
escaped, never truncated, never JSON-quoted. The fences themselves are NOT
part of the file — the chat UI hides them when rendering.

For ALL OTHER actions (read_file, read_files, list_files, search_files,
search_semantic, run_command, run_npm, copy_file, delete_file,
delete_directory, git_*, project_info, open_workspace, screenshot,
compare_visual), use the JSON format:
{"action":"NAME","args":{...}}

## Available actions:
1. read_file(path) - read a file
2. write_file(path, content) - write/overwrite a file
3. edit_file(path, old_text, new_text) - find and replace in a file
4. list_files(dir) - list files in a directory
5. search_files(pattern) - search for text across files
6. run_command(command) - shell command (needs approval); dev/serve/watch commands start in a VISIBLE VS Code terminal and return immediately with the live URL + first seconds of output
7. run_npm(action, script) - npm/pnpm/yarn commands; scripts named dev/start/serve/watch/preview start in a VISIBLE VS Code terminal and return immediately with the live URL + first seconds of output
8. git_status(), git_diff(file?), git_log(n?), git_commit(message, files?),
   git_branch(action, name?), git_revert(commit)
9. read_files(paths) - batch read (max 12)
10. write_files(files) - batch write (one approval). args.files is MANDATORY —
    the array of files is nested INSIDE args.files, never passed as args itself:
    {"action":"write_files","args":{"files":[{"path":"a.ts","content":"..."},{"path":"b.ts","content":"..."}]}}
11. project_info() - detected project info
12. search_semantic(query) - semantic code search (if indexed)
13. open_workspace(path) - open folder in new window
14. delete_file(path) - delete ONE file (needs approval)
    {"action":"delete_file","args":{"path":"bootcamp-test2/test.ts"}}
15. delete_directory(path, recursive?) - delete a folder (needs approval);
    recursive:true deletes the folder WITH all its contents (only when the
    task asks for it)
    {"action":"delete_directory","args":{"path":"bootcamp-test2","recursive":true}}
16. copy_file(from, to, replace?) - copy ONE file 1:1 (needs approval);
    "replace" is an optional list of {old, new} simple replacements applied
    to the copied content before writing
    {"action":"copy_file","args":{"from":"src/pages/a.astro","to":"src/pages/b.astro","replace":[{"old":"old text","new":"new text"}]}}
17. screenshot(url, full_page?, viewport?, selector?, description?) - capture a page
    (or ONE element) to docs/screenshots/<timestamp>.png; \`url\` also accepts a
    local path and an address without a scheme ("localhost:4321/"). \`full_page\`
    defaults to TRUE (the WHOLE page — errors below the fold are included); pass
    \`"full_page": false\` for the viewport only. \`description\` captures ONE element
    described in words (e.g. "the CTA button", "the price cards") — it is matched
    by element type, visible text, id/class, label, alt, title or aria-label; use
    \`selector\` when you know the exact CSS selector.
    {"action":"screenshot","args":{"url":"http://localhost:4321/affordable-websites/"}}
    {"action":"screenshot","args":{"url":"http://localhost:4321/","description":"the CTA button"}}
18. compare_visual(url1, url2, provider?) - screenshot both pages and ask a
    provider WITH VISION to list ALL the differences; writes the report to
    docs/screenshots/compare-<timestamp>.md
    {"action":"compare_visual","args":{"url1":"https://identitatebrand.ro/creare-site/","url2":"http://localhost:4321/affordable-websites/"}}

## COPYING A FILE (copy_file)
- When the user asks "make page X exactly like page Y" (or "copy this file
  and change ..."), use copy_file instead of write_file. copy_file takes the
  source, the destination and optional simple replacements — you do NOT have
  to write out the whole content.
- "from" and "to" are relative paths; "to" is overwritten if it exists.
- "replace" is OPTIONAL: omit it for an exact copy. Each "old" must appear
  exactly ONCE in the copied file; if it is missing or ambiguous you get a
  warning and the remaining replacements are still applied (the file is
  still written).
- Do NOT use copy_file for generated content — for new content the model
  writes, use write_file.

## VISUAL VERIFICATION (screenshot / compare_visual)
- When the user asks you to visually replicate a page, or when you finish
  building a page, use compare_visual to check the result against the
  original. Do NOT assume it is correct — verify.
- For compare_visual and complex visual analysis, Qwen3-VL
  (qwen3-vl-235b-a22b) is the best. Recommend it when the user asks for
  precise visual replication.
- compare_visual screenshots url1 (the ORIGINAL) and url2 (the REPLICA), sends
  both images to a provider with vision and writes the differences to
  docs/screenshots/compare-<timestamp>.md. Only providers with vision can
  receive the screenshots — if the current one cannot, Freekit switches
  automatically to one that can (the log says which).
- Both tools save the PNGs in docs/screenshots/ and open them in the editor
  (screenshot: \`freekit.screenshotOpenMode\`; compare_visual: side by side).
  \`full_page\` defaults to TRUE (the WHOLE page — not just the viewport); pass
  \`"full_page": false\` for the viewport only. Use \`selector\` (exact CSS) or
  \`description\` (a short description like "the CTA button") to capture ONE
  element (with 10px padding around it).
- The dev server must already be running before you screenshot a localhost URL
  (start it with run_npm / run_command and use the URL you were given).

## DELETING FILES AND FOLDERS
- Use delete_file / delete_directory — NEVER run_command with "rm", "del",
  "rmdir" or "Remove-Item" to delete.
- Delete ONLY inside the task scope (the paths the user named); a deletion
  outside it is refused by the client.
- delete_file works on files only (on a folder you get a hint to use
  delete_directory); delete_directory without recursive fails on a non-empty
  folder — pass recursive:true to delete the folder with its contents.
- If a deletion is refused or rejected, STOP and report it — do not look for
  another way to delete the same path.

NOTE (TypeScript): .ts / .tsx / .mts / .cts files are shown to you with a ".txt"
suffix (e.g. "src/file.ts.txt") because web chat backends refuse plain ".ts"
files. The file on disk is still "src/file.ts": reading works with either path,
and when you write/edit it use the SAME path you were shown (the ".txt" suffix
is stripped automatically before writing to disk).

## WORKFLOW EXAMPLES

USER: "change the title from X to Y"
YOU: {"action":"search_files","args":{"pattern":"X"}}
(after result, you know which files contain X)
YOU: {"action":"read_file","args":{"path":"src/file.ts"}}
(after result, you see the exact text)
YOU: ACTION: edit_file
PATH: src/file.ts
OLD_TEXT:
\`\`\`text
X
\`\`\`
END_OLD_TEXT
NEW_TEXT:
\`\`\`text
Y
\`\`\`
END_NEW_TEXT

USER: "create a file named foo.ts"
YOU: ACTION: write_file
PATH: foo.ts
CONTENT:
\`\`\`text
...
\`\`\`
END_CONTENT

USER: "add a comment at the beginning of the main.js file"
YOU: {"action":"read_file","args":{"path":"main.js"}}
YOU: ACTION: edit_file
PATH: main.js
OLD_TEXT:
\`\`\`text
first line
\`\`\`
END_OLD_TEXT
NEW_TEXT:
\`\`\`text
// comment
first line
\`\`\`
END_NEW_TEXT

USER: "run the tests"
YOU: {"action":"run_npm","args":{"action":"script","script":"test"}}

## STRICT RULES
- Your first response to an action request is ALWAYS an action (marker format for file writes, JSON otherwise).
- NEVER write "Analyzing...", "Let me...", "I'll...", "I will..." before an action.
- NEVER explain what you're going to do. JUST DO IT.
- ONE action per message.
- JSON actions: a SINGLE LINE, no markdown fences. For write_file / edit_file / write_files use the marker format, with the file content inside a markdown code fence, exactly as shown above.
- Args ALWAYS an object (use {} if empty).
- Paths relative to workspace root.
- When the task is complete, respond with PLAIN TEXT (not JSON).
- After every edit_file / write_file / write_files the system AUTO-VERIFIES the project (astro check / tsc / build). If you receive "VERIFICATION FAILED", you get a DIAGNOSTIC with the parsed error, the exact location, the ROOT CAUSE traced to the data source and the EXACT required fix — apply it with ONE edit_file. Never claim success while a verification is failing, and never hide the symptom with "?.", "|| []" or "if (!x) return": a band-aid fix is REJECTED and you will be asked again. You get max 3 repair cycles; after that the changes are ROLLED BACK automatically (and if there is no verified-good state, you are told honestly that the error is still there).
- Long-running commands (dev / start / serve / watch / preview — e.g. "npm run dev", "vite", "nodemon") start the server in a VISIBLE VS Code terminal automatically (the user watches the live output there): you receive "✅ Server started in the VS Code TERMINAL …" + the live URL + the first seconds of output IMMEDIATELY. NEVER wait for such a command and NEVER re-run it; the server keeps running until stopped (Ctrl+C in its terminal or the command "Freekit: Stop Dev Servers"). If the early output shows a startup error (port in use, syntax error) — or you are told the process exited — fix the root cause and re-run the command once.

## WHEN TO USE PLAIN TEXT (no action)
- User asks a question ("what does this do?", "explain X")
- User asks for advice/opinion
- Task is complete — give a short summary
- You need clarification from user

## PROJECT INFO
{PROJECT_INFO}

## PROJECT STRUCTURE
{PROJECT_STRUCTURE}`;

/* =========================================================================
 * v0.2.1 — prompt pentru modelele LOCALE (Ollama)
 * Mai strict: cere scrierea COMPLETĂ a fișierului într-un singur apel și
 * interzice completările „câte o funcție pe rând” (anti-spam write_file).
 * ========================================================================= */

export const SYSTEM_PROMPT_LOCAL = `AI coding assistant in VS Code. You are a LOCAL model (small context): follow the rules EXACTLY and be concise.
${LOCAL_ENV_NOTE}
To use a tool, respond with ONLY this JSON (single line, nothing else):
{"tool": "NAME", "args": {...}}

Tools:
1. read_file(path)
2. write_file(path, content) — writes the WHOLE file once: content REPLACES the file
3. edit_file(path, old_text, new_text)
4. list_files(dir)
5. search_files(pattern)
6. run_command(command) — raw shell command
7. run_npm(action, script) — "install" or a script name from package.json
8. git(action, ...) — "status", "diff", "log", "commit" (message, add?), "branch" (name?), "revert" (commit), "restore" (path)
9. read_files(paths) — batch read: up to 12 files in ONE call
10. write_files(files) — ONE call for ALL files: {"tool": "write_files", "args": {"files": [{"path": "a.ts", "content": "..."}, {"path": "b.ts", "content": "..."}]}} — args.files is MANDATORY (the array goes INSIDE args.files, never as args directly)
11. project_info()
12. search_semantic(query) — find code by MEANING (e.g. "where do we validate login"); works only if the workspace was indexed (command "Freekit: Index Workspace")
13. copy_file(from, to, replace?) — copy ONE file 1:1 ("make page X exactly like page Y"); replace is an optional list of {old, new} applied to the copy — use it instead of write_file when you would otherwise repeat a whole existing file
14. screenshot(url, full_page?, selector?, description?) — capture a page (or ONE described element, with 10px padding) to docs/screenshots/<timestamp>.png. full_page is TRUE by default.
15. compare_visual(url1, url2, provider?) — screenshot the original and the replica, ask a provider WITH VISION to list ALL the differences, and write the report to docs/screenshots/compare-<timestamp>.md. Use it when you replicate a page visually or when you finish building a page — do NOT assume it is correct, verify. For visual work Qwen3-VL (qwen3-vl-235b-a22b) is the best.

For git you may also use the short names "git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_revert".

NOTE (TypeScript): .ts / .tsx / .mts / .cts files are shown to you with a ".txt"
suffix (e.g. "src/file.ts.txt"); the real file on disk is "src/file.ts" (the
suffix is stripped automatically when you write or edit).

CRITICAL WRITE RULES (the system REJECTS violations with an error):
- Write each file ONLY ONCE. First compose the COMPLETE final content, then call write_file ONE time.
- NEVER write the same file twice to "add" something. NEVER append functions one by one.
- Example: "write a Python function that adds 2 numbers" → ONE write_file call with the complete script, then STOP. Do NOT also add subtract/multiply/divide unless the user asked.
- Write ONLY what the user asked for. No extra functions, files, tests or docs.
- Several files → ONE write_files call with all of them.
- Hard limits: max 3 writes per file, max 15 write operations per message. If you get an ANTI-SPAM error, do NOT retry — reply with plain text instead.
- Dev/start/serve/watch commands (npm run dev, npm start, vite, nodemon, ...) run in a VISIBLE VS Code terminal: you get "✅ Server started in the VS Code TERMINAL …" + the first seconds of output immediately. Do NOT wait for them, do NOT re-run them; if the first seconds show an error — or the process exited — fix it and re-run once.
- If run_command / run_npm fails: read the FULL error, fix the code, re-run the SAME command (max 5 tries; after that it is blocked and you must reply with text).
- After every write the system RE-CHECKS the project: if you receive "VERIFICATION FAILED" you also get a DIAGNOSTIC (parsed error + ROOT CAUSE + the exact fix). Apply it with ONE edit_file. Never hide the error with "?.", "|| []" or "if (!x) return" — band-aids are rejected. Max 3 repair cycles, then ALL changes are rolled back automatically. Never claim success while a verification is failing.
- After the task is done, reply with plain text (short summary). No JSON.

Args must ALWAYS be an object (empty {} if no args).
Paths are relative to the workspace root. Always read a file before editing it.`;

/* =========================================================================
 * v1.1.2 — Auto-retry: text în loc de tool call
 * Când modelul răspunde cu o DESCRIERE a intenției („Analyzing...",
 * „Let me...") sau cu un fragment de tool call JSON invalid — în loc să
 * execute o unealtă — chatView îi trimite automat TEXT_RETRY_NUDGE și
 * așteaptă un SINGUR tool call valid (max MAX_TEXT_RETRIES per mesaj).
 * ========================================================================= */

export const MAX_TEXT_RETRIES = 2;

/**
 * Nudge trimis modelului când răspunsul nu conține nicio action validă.
 * v2.5.26 (bug #51): aceleași exemple, în vocabularul „action" (parserul
 * acceptă și `{"tool": ...}`).
 */
export const TEXT_RETRY_NUDGE = `SYSTEM NOTICE — NO ACTION DETECTED.

Your previous reply contained NO valid action (plain text description and/or invalid JSON).
The task is NOT complete yet. Do NOT describe what you will do — DO it.

Reply NOW with EXACTLY ONE action, as a SINGLE-LINE JSON object, and nothing else:
{"action":"NAME","args":{...}}

Examples:
{"action":"search_files","args":{"pattern":"text to find"}}
{"action":"read_file","args":{"path":"src/index.ts"}}

Rules: NO markdown fences, args ALWAYS an object (use {} if empty), one line only.
Only if the task is already FULLY COMPLETE (or the user only asked a question), reply with your final plain-text answer instead.`;

// Început de răspuns care descrie o ACȚIUNE viitoare (nu un răspuns final).
// Ex.: „Analyzing the project structure...", „Let me find the file", „Voi căuta...".
const RETRY_INTENT_RE =
  /(?:^|[.!?]\s+|\n)\s*(?:(?:first|next|now|then|also|finally)[,:]?\s+)?(?:analyzing\b|analizez\b|let me\b(?!\s+know\b)|let['’]s\b|hai să(?=\s|$|[.,;:!?])|i['’]ll\b|i will\b|i['’]m going to\b|i am going to\b|i['’]m checking\b|i am checking\b|i need to\b|i should\b|i want to\b|i['’]d like to\b|checking\b|reading\b|scanning\b|searching\b|examining\b|inspecting\b|looking at\b|încep (?:prin|cu)(?=\s|$|[.,;:!?])|voi (?:căuta|analiza|verifica|modifica|schimba|crea|edita|actualiza)(?=\s|$|[.,;:!?])|o să (?:caut|verific|analizez|modific|schimb|cre|editez|actualizez)(?=\s|$|[.,;:!?])|(?:sure|okay|ok|certainly|of course|alright|great)[!,.]?\s+(?:let me\b(?!\s+know\b)|let['’]s\b|i['’]ll\b|i will\b|i['’]m going to\b|i am going to\b))/i;

// Excepție: intenție de EXPLICARE („Let me explain...") = răspuns final, nu acțiune.
const RETRY_EXPLAIN_RE =
  /^\s*(?:(?:first|next|now|then|also|finally)[,:]?\s+)?(?:let me|let['’]s|i['’]ll|i will|i['’]m going to|i am going to)\s+(?:explain|walk you through|summarize|sum up|clarify|describe|show you how)\b/i;

/**
 * true când răspunsul pare o DESCRIERE de intenție („Analyzing...", „Let
 * me...") sau conține un fragment de tool call JSON (invalid) — merită un
 * retry cu TEXT_RETRY_NUDGE. false pentru răspunsuri care par finale.
 */
export function looksLikeIntentOnly(reply: string): boolean {
  const text = String(reply ?? '').trim();
  if (!text) return false;
  // fragment de tool call (chiar și invalid) — nu poate fi răspuns final
  // v2.5.26 (bug #51): și forma nouă {"action": ...}
  if (/\{\s*["'](?:tool|action)["']\s*:/.test(text)) return true;
  const head = text.slice(0, 240);
  if (RETRY_EXPLAIN_RE.test(head)) return false;
  return RETRY_INTENT_RE.test(head);
}

/* =========================================================================
 * v2.5.14 (bug #38) — REFUZ AL PROTOCOLULUI DE UNELTE
 * v2.5.16 (bug #43) — variante EN/RO suplimentare
 * Modelul răspunde uneori ca un chat obișnuit în loc să execute protocolul:
 * „the VS Code workspace tools you specified are not available in this
 * session", „Nu pot executa modificarea în workspace-ul VS Code din această
 * conversație: instrumentele … nu sunt disponibile în mediul meu actual".
 * Cauza tipică: sesiunea providerului nu era complet autentificată când a
 * plecat mesajul. Un astfel de refuz NU se afișează ca răspuns final: îi cerem
 * explicit, o singură dată, să trimită tool call-ul (uneltele rulează în
 * clientul VS Code, nu la model).
 * ========================================================================= */

/** v2.5.14 (bug #38): câte reluări facem când modelul refuză protocolul (max 1). */
export const MAX_REFUSAL_RETRIES = 1;

/**
 * Refuzuri tipice: unelte/workspace indisponibile, fără acces la proiect.
 * v2.5.16 (bug #43): formulările variază mult de la un model la altul
 * („tools you specified are not available", „not available in my current
 * environment", „Nu pot executa…", „instrumentele … nu sunt disponibile") —
 * fiecare variantă EN/RO are pattern-ul ei.
 * v2.5.17 (bug #43): adverbul dintre negație și „available" rupea pattern-ul
 * („the VS Code workspace tools you specified (read_file, list_files, etc.)
 * are not ACTUALLY available in this chat session").
 * Doar pentru răspunsuri scurte (un refuz real e scurt) — nu prindem
 * explicații lungi și legitime despre unelte.
 */
const TOOL_REFUSAL_RES: RegExp[] = [
  // EN — unelte/workspace indisponibile sau lipsa accesului
  /(?:tools?|connectors?)[^.!?\n]{0,60}(?:are |is )?(?:not|aren['’]?t) (?:available|mounted)/i,
  // v2.5.17 (bug #43): „… are not actually available" / „… are actually not available"
  /(?:tools?|connectors?)[^.!?\n]{0,80}(?:(?:are|is)\s+(?:not|actually\s+not)|aren['’]?t)\s+(?:actually\s+)?available/i,
  /not (?:actually )?available (?:in (?:this|my)|here)/i,
  // v2.5.26 (bug #51): „The tools aren't actually exposed to me here" /
  // „The current workspace files are not exposed through the available
  // file-reading tool in this turn." — refuzul tipic al ChatGPT free.
  /(?:tools?|files?|workspace)[^.!?\n]{0,60}(?:not|aren['’]?t|isn['’]?t)\s+(?:actually\s+)?exposed/i,
  /(?:not|aren['’]?t|isn['’]?t)\s+(?:actually\s+)?exposed\s+(?:to me|here|in this)/i,
  // v2.5.17 (bug #43): uneltele sunt enumerate nominal, apoi declarate indisponibile
  /(?:read_file|write_file|list_files|edit_file|run_npm)\b[\s\S]{0,160}?\bnot\s+(?:actually\s+)?available/i,
  /(?:cannot|can['’]?t|can not|unable to)[^.!?\n]{0,40}\b(?:access|execute|modify|edit|use|open|read|write)\b[^.!?\n]{0,40}\b(?:workspace|project|files?|repo(?:sitory)?)/i,
  /(?:don['’]?t|do not|doesn['’]?t) have (?:any )?access to/i,
  /(?:can['’]?t|cannot|can not)\s+(?:read|write|edit)\s+files?/i,
  /(?:don['’]?t|do not)\s+(?:have|possess)\s+(?:any\s+|the\s+)?(?:ability|tools?)/i,
  /(?:workspace|project|repo(?:sitory)?) files?[^.!?\n]{0,20}not (?:mounted|available|accessible|attached)/i,
  // RO — aceleași situații, formulări românești
  /nu pot\s+(?:executa|accesa|modifica)/i,
  /(?:unelte(?:le)?|instrumentele)[\s\S]{0,200}nu sunt disponibile/i,
  // v2.5.17 (bug #43): „instrumentele … nu sunt DE FAPT disponibile"
  /(?:unelte(?:le)?|instrumentele)[\s\S]{0,200}nu sunt de fapt disponibile/i,
  /nu am acces\s+(?:la|[îi]n)/i,
  /nu pot\s+(?:citi|scrie|edita)\s+fi(?:ș|s)iere/i,
  /nu sunt disponibile [îi]n mediul meu/i
];

/** true când răspunsul e un REFUZ al protocolului de unelte (nu un răspuns final). */
export function looksLikeToolRefusal(reply: string): boolean {
  const text = String(reply ?? '').trim();
  if (!text || text.length > 1500) return false;
  // e o ÎNCERCARE de action, nu un refuz — are fluxul lui (malformed)
  if (/\{\s*["'](?:tool|action)["']\s*:/.test(text)) return false;
  return TOOL_REFUSAL_RES.some((re) => re.test(text));
}

/**
 * Nudge trimis când modelul refuză protocolul (v2.5.14, bug #38).
 * v2.5.26 (bug #51): rescris în vocabularul „action" — „tool" declanșa exact
 * auto-identificarea de chatbot pe care o contracarăm.
 */
export const TOOL_REFUSAL_NUDGE = `You refused the pipeline protocol. This is WRONG.
You are NOT a generic chatbot. You are in a pipeline running in VS Code.
When you emit an action, Freekit executes it and returns the result.
DO NOT refuse. DO NOT say "I don't have tools". DO NOT say "the tools
aren't available". DO NOT say "I can't access the workspace".
Reply ONLY with an action:
For reads: {"action":"read_file","args":{"path":"..."}}
For writes: ACTION: write_file
PATH: ...
CONTENT:
\`\`\`text
...
\`\`\`
END_CONTENT
Try again NOW. The user's request is valid and the pipeline will
execute your output.`;

/** v2.0.1: peste câte linii renunțăm la LCS (fișiere foarte mari → euristică). */
const DIFF_LCS_MAX_LINES = 3000;

/** v2.0.1: liniile unui text, fără „\n"-ul final (care nu e o linie reală). */
function diffLines(text: string): string[] {
  const lines = String(text ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * v2.0.1: statistici de diff (linii adăugate / șterse) pentru rândul inline de
 * „file change" din chat. LCS pe linii cu memorie O(min(n,m)); pentru fișiere
 * foarte mari (> DIFF_LCS_MAX_LINES) cade pe o euristică liniară, ca să nu
 * încetinească bucla agentică.
 */
export function computeDiffStats(
  before: string,
  after: string
): { added: number; removed: number } {
  const a = diffLines(before);
  const b = diffLines(after);
  if (!a.length) return { added: b.length, removed: 0 };
  if (!b.length) return { added: 0, removed: a.length };

  if (a.length > DIFF_LCS_MAX_LINES || b.length > DIFF_LCS_MAX_LINES) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let kept = 0;
    for (const line of b) {
      const left = counts.get(line) ?? 0;
      if (left > 0) {
        counts.set(line, left - 1);
        kept++;
      }
    }
    return { added: b.length - kept, removed: a.length - kept };
  }

  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      cur[j] =
        a[i] === b[j]
          ? prev[j + 1] + 1
          : Math.max(prev[j], cur[j + 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  const lcs = prev[0];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/* =========================================================================
 * v2.4.1 — Restricted Mode (Workspace Trust)
 * Uneltele care scriu în workspace sau rulează cod sunt blocate când folderul
 * nu e de încredere; cele read-only rămân disponibile (graceful degradation).
 * ========================================================================= */

/** Unelte care necesită Workspace Trust (scriu fișiere / rulează comenzi). */
const TRUST_REQUIRED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_files',
  // v2.5.50 FIX 3: copy_file scrie un fișier nou
  'copy_file',
  'delete_file',
  'delete_directory',
  'run_command',
  'run_npm'
]);

/** Acțiuni git care modifică starea — status/diff/log rămân permise. */
const TRUST_REQUIRED_GIT_ACTIONS = new Set(['commit', 'branch', 'revert', 'restore']);

/** True dacă unealta scrie în workspace, rulează cod sau apelează un server MCP. */
export function isToolTrustRequired(tool: string, args?: Record<string, any>): boolean {
  const name = String(tool ?? '').toLowerCase();
  if (TRUST_REQUIRED_TOOLS.has(name)) return true;
  // MCP: serverele sunt procese externe care pot face orice
  if (name.startsWith('mcp_') || name === 'mcp_call') return true;
  if (name.startsWith('git_')) return TRUST_REQUIRED_GIT_ACTIONS.has(name.slice(4));
  if (name === 'git') return TRUST_REQUIRED_GIT_ACTIONS.has(String(args?.action ?? '').toLowerCase());
  return false;
}

export async function executeTool(
  call: ToolCall,
  workspaceRoot: string,
  log: (msg: string) => void,
  approve: ApprovalFn,
  /** v2.5.6 (bug #10): ultimul mesaj al utilizatorului — referința față de care
   *  detectăm conținutul scris „din imaginație" (opțional). */
  userText?: string,
  /** v2.5.51: browser + puntea de trimitere către un provider cu vision —
   *  necesare doar pentru `screenshot` / `compare_visual`. */
  visual?: VisualToolContext
): Promise<ToolResult> {
  log('executing tool: ' + call.tool);
  // v2.5.27 (bug #63): dacă AI-ul trimite calea-alias `.ts.txt` (cea pe care a
  // văzut-o la citire), o traducem înapoi în calea reală ÎNAINTE de aprobare,
  // diff, verificarea de trunchiere și scrierea pe disc. Parserul face deja
  // asta (Fix 2) — aici e plasa de siguranță pentru apelurile care o ocolesc.
  const mapped = mapToolCallAliases(call.tool, call.args);
  if (mapped.mappings.length) {
    for (const m of mapped.mappings) {
      log('mapped ' + m.alias + ' → ' + m.original + ' for ' + m.op);
    }
    call = { tool: call.tool, args: mapped.args ?? {} };
  }
  if (!vscode.workspace.isTrusted && isToolTrustRequired(call.tool, call.args)) {
    log('blocked by Restricted Mode: ' + call.tool);
    return { ok: false, error: RESTRICTED_TOOL_ERROR };
  }
  try {
    // FIX v0.1.1: acceptă și numele compuse "git_status" / "git_diff" / ...
    // (parserul le produce din formatul scurt {"tool":"git","action":"status"})
    if (call.tool.startsWith('git_')) {
      const action = call.tool.slice(4);
      return await gitTool(
        { ...(call.args || {}), action },
        workspaceRoot,
        approve,
        log
      );
    }
    switch (call.tool) {
      case 'read_file':
        return await readFile(call.args.path, workspaceRoot, log);

      case 'write_file': {
        // v2.5.29 FIX 3 (bug #67): al doilea `write_file` eșuat pe același
        // fișier primește un mesaj suplimentar (append ⇒ edit_file).
        const wres = await writeFileTool(
          call.args,
          workspaceRoot,
          approve,
          userText
        );
        if (!wres.ok && wres.error !== 'User rejected') {
          const warn = noteWriteFileFailure(call.args.path);
          if (warn) {
            log(
              'anti-spam level 2: write_file failed twice on ' + call.args.path
            );
            return { ...wres, error: String(wres.error ?? '') + '\n\n' + warn };
          }
        }
        return wres;
      }

      case 'edit_file': {
        // v0.2.1: anti-spam — și editările contează ca scriere
        const limitErr = checkWriteLimit(call.args.path);
        if (limitErr) return { ok: false, error: limitErr };
        // v2.5.43 (bug #99): fișier lipsă ≠ „old_text not found" (mesajul vechi
        // trimitea modelul să caute diferențe într-un fișier inexistent).
        const oldInfo = await tryReadInfo(call.args.path, workspaceRoot);
        if (!oldInfo.exists) {
          logLine('tool', 'edit_file failed: file not found: ' + call.args.path);
          return {
            ok: false,
            error:
              'File not found: ' +
              call.args.path +
              '. Use read_file to check the path, or write_file to create the file.'
          };
        }
        const oldContent = oldInfo.content;
        // v2.5.43 (bug #99): potrivire exactă, apoi tolerantă (EOL / whitespace
        // / ghilimele tipografice). Eșecul nu mai e mut: log explicit + o eroare
        // care arată cea mai apropiată zonă din fișier, ca modelul să se repare.
        const match = findTolerantMatch(oldContent, call.args.old_text);
        if (!match) {
          logEditFailure(call.args.path, call.args.old_text, oldContent);
          return {
            ok: false,
            error: editFailureError(
              call.args.path,
              call.args.old_text,
              oldContent
            )
          };
        }
        if (match.strategy !== 'exact') {
          logLine(
            'tool',
            'edit_file: tolerant match (' +
              match.strategy +
              ') in ' +
              call.args.path
          );
        }
        const updated =
          oldContent.slice(0, match.start) +
          call.args.new_text +
          oldContent.slice(match.end);
        const diff = makeDiff(call.args.path, oldContent, updated);
        // v0.5.0: preview pentru diff-ul nativ (fișier existent, deci isNew=false)
        const changes: FileChangePreview[] = [
          {
            label: call.args.path,
            oldContent,
            newContent: updated,
            isNew: false
          }
        ];
        if (!(await approve('edit_file', call.args.path, diff, changes))) {
          return { ok: false, error: 'User rejected' };
        }
        const res = await editFile(
          call.args.path,
          call.args.old_text,
          call.args.new_text,
          workspaceRoot
        );
        if (res.ok) {
          recordWrite(call.args.path);
          recordWriteCall();
        }
        return res;
      }

      case 'list_files':
        return await listFiles(call.args.dir || '.', workspaceRoot);

      case 'run_command': {
        // v0.6.0: dacă limita de auto-reparare e atinsă, comanda nu mai rulează
        // (cheia e comanda ORIGINALĂ a modelului, tradusă sau nu — vezi runCommand)
        if (isCommandBlocked(normCommandKey(call.args.command))) {
          return blockedCommandResult(call.args.command);
        }
        // v2.5.38 FIX (bug #89): traducere automată Unix → Windows ÎNAINTE de
        // aprobare (utilizatorul vede exact ce se execută) și de execuție.
        // v2.5.55 (FIX 2): `find`/`grep`/`pwd`/`head`/`tail` sunt traduse acum;
        // comenzile care NU pot fi traduse sunt BLOCATE cu eroare clară — nu se
        // mai execută orbește (raportul din 8 Oct: 3 eșecuri identice ⇒ circuit
        // breaker ⇒ task oprit fără ca pluginul căutat să fie găsit vreodată).
        const tr = translateUnixCommandToWindows(call.args.command, {
          cwd: workspaceRoot
        });
        if (tr.blockedUnix?.length) {
          beginCommandAttempt(normCommandKey(call.args.command));
          log(
            '[run] blocked Unix command on Windows (' +
              tr.blockedUnix.join(', ') +
              '): ' +
              call.args.command
          );
          return {
            ok: false,
            error: buildUnixBlockedError(call.args.command, tr.blockedUnix),
            userNotice:
              '⛔ Not executed: „' +
              call.args.command +
              '" is a Unix command (' +
              tr.blockedUnix.join(', ') +
              ') — Freekit blocked it on Windows and told the AI to use the equivalent.'
          };
        }
        if (tr.translated) {
          log(
            '[run] auto-translated Unix to Windows: ' +
              call.args.command +
              ' → ' +
              tr.command +
              ' (' +
              tr.notes.join('; ') +
              ')'
          );
        }
        const execCommand = tr.command;
        // v1.8.1: comenzile long-running (dev/serve/start/watch) pornesc
        // vizibil, într-un terminal VS Code dedicat (nu mai rămân invizibile)
        const lrNote = isLongRunningCommand(execCommand)
          ? '\n(long-running command — development server: starts in a VISIBLE VS Code TERMINAL; you immediately get the URL + the first seconds of output)'
          : '';
        const trNote = tr.translated
          ? '\n\n⚙️ Auto-translated for Windows: ' + execCommand
          : '';
        if (
          !(await approve(
            'run_command',
            call.args.command,
            call.args.command + trNote + lrNote
          ))
        ) {
          return { ok: false, error: 'User rejected' };
        }
        return await runCommand(
          execCommand,
          tr.translated ? call.args.command : undefined
        );
      }

      case 'search_files':
        return await searchFiles(call.args.pattern, workspaceRoot);

      case 'run_npm':
        return await runNpmTool(call.args, workspaceRoot, approve, log);

      case 'git':
        return await gitTool(call.args, workspaceRoot, approve, log);

      case 'read_files':
        return await readFilesBatch(call.args, workspaceRoot, log);

      case 'write_files':
        return await writeFilesBatch(call.args, workspaceRoot, approve, userText);

      // v2.5.50 FIX 3: copiere 1:1 a unui fișier (opțional cu înlocuiri simple)
      case 'copy_file':
        return await copyFileTool(call.args, workspaceRoot, approve, log);

      // v2.5.42 (bug #98): ștergerea de fișiere/foldere — cu scope + aprobare
      case 'delete_file':
        return await deleteFileTool(
          call.args.path,
          workspaceRoot,
          approve,
          log,
          userText
        );

      case 'delete_directory':
        return await deleteDirectoryTool(
          call.args.path,
          call.args.recursive === true,
          workspaceRoot,
          approve,
          log,
          userText
        );

      case 'project_info':
        return await projectInfoTool(workspaceRoot);

      case 'search_semantic':
        return await searchSemanticTool(call.args?.query, workspaceRoot);

      // v2.5.51 FIX 1/2: capturi de ecran + comparație vizuală (vision)
      case 'screenshot':
        return await screenshotTool(call.args, workspaceRoot, visual, log);

      case 'compare_visual':
        return await compareVisualTool(call.args, workspaceRoot, visual, log);

      default:
        return { ok: false, error: 'Unknown tool: ' + call.tool };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** v0.5.0: ca tryRead, dar spune și dacă fișierul exista (pentru diff-ul nativ). */
async function tryReadInfo(
  rel: string,
  root: string
): Promise<{ exists: boolean; content: string }> {
  try {
    const abs = safePath(rel, root);
    const content = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
    return { exists: true, content: Buffer.from(content).toString('utf8') };
  } catch {
    return { exists: false, content: '' };
  }
}

function makeDiff(filePath: string, oldText: string, newText: string): string {
  if (!oldText) {
    return '📄 New file: ' + filePath + '\n\n' + newText.slice(0, 3000);
  }
  if (oldText === newText) {
    return '(no changes)';
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Găsim prefixul comun
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  // Găsim sufixul comun
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const out: string[] = [];
  const contextLines = 2;

  // Context înainte
  const ctxStart = Math.max(0, prefix - contextLines);
  if (ctxStart > 0) out.push('  ...');
  for (let i = ctxStart; i < prefix; i++) {
    out.push('  ' + oldLines[i]);
  }

  // Linii șterse
  const removedEnd = oldLines.length - suffix;
  for (let i = prefix; i < removedEnd; i++) {
    out.push('- ' + oldLines[i]);
  }

  // Linii adăugate
  const addedEnd = newLines.length - suffix;
  for (let i = prefix; i < addedEnd; i++) {
    out.push('+ ' + newLines[i]);
  }

  // Context după
  const ctxEnd = Math.min(
    newLines.length,
    newLines.length - suffix + contextLines
  );
  for (let i = newLines.length - suffix; i < ctxEnd; i++) {
    out.push('  ' + newLines[i]);
  }
  if (ctxEnd < newLines.length) out.push('  ...');

  return out.join('\n') || '(no changes)';
}

/**
 * v2.5.48: rădăcinile acceptate = rădăcina principală + TOATE folderele
 * deschise în workspace (multi-root). Un folder adăugat cu „Add Folder to
 * Workspace" (ex: Z:\ proiectat prin RaiDrive) devine astfel accesibil.
 */
/**
 * v2.5.49 (FIX 1) — acces la path-uri externe.
 *
 * Rădăcinile acceptate = rădăcina primară + TOATE folderele deschise în
 * workspace (multi-root) + `freekit.allowExternalPaths` (ex. `Z:\home`,
 * un WordPress proiectat prin RaiDrive). Comparația e CANONICĂ
 * (`path.resolve` + `path.normalize`, plus case-insensitive pe Windows), deci
 * `Z:\home\x`, `Z:/home/x` și `z:\HOME\X` sunt aceeași cale.
 */

/** Cheia canonică de comparație: separatori + trailing separator + caz. */
export function canonPath(p: string): string {
  let s = path.normalize(String(p ?? '').trim());
  const rootLen = path.parse(s).root.length;
  if (s.length > rootLen) s = s.replace(/[\\/]+$/, '');
  if (!s) s = path.sep;
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** v2.5.49 (FIX 1): path-urile externe permise de utilizator. */
export function externalRoots(): string[] {
  let raw: unknown = [];
  try {
    raw = vscode.workspace
      .getConfiguration('freekit')
      .get<string[]>('allowExternalPaths', []);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .map((p) => path.normalize(p));
}

/** Rădăcinile acceptate (deduplicate canonic), în ordine de prioritate. */
function allowedRoots(primary: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (p?: string) => {
    const value = String(p ?? '').trim();
    if (!value) return;
    const key = canonPath(value);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(path.normalize(value));
  };
  push(primary);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    push(folder.uri.fsPath);
  }
  for (const extra of externalRoots()) push(extra);
  return roots;
}

function isInsideRoot(target: string, root: string): boolean {
  const t = canonPath(target);
  const r = canonPath(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** v2.5.49: comparație de încadrare în rădăcină, case-insensitive pe Windows. */
export function isPathInsideRoot(target: string, root: string): boolean {
  return isInsideRoot(target, root);
}

/** Path-urile externe, ca set canonic (pentru logging-ul dedicat). */
function externalKeySet(): Set<string> {
  return new Set(externalRoots().map((p) => canonPath(p)));
}

function safePath(rel: string, root: string): string {
  const requested = String(rel ?? '').trim() || '.';
  const primary = path.normalize(root);
  const roots = allowedRoots(primary);
  const normalized = path.normalize(path.resolve(primary, requested));

  const owner = roots.find((r) => isInsideRoot(normalized, r));
  if (owner) {
    if (externalKeySet().has(canonPath(owner))) {
      // FIX 1: citire/scriere într-un path extern permis explicit
      logLine('scope', 'allowed external path: ' + normalized);
    } else if (canonPath(owner) !== canonPath(primary)) {
      logLine(
        'scope',
        'allowed path outside primary root: ' +
          normalized +
          ' (multi-root workspace)'
      );
    }
    return normalized;
  }

  logLine(
    'scope',
    'refused: ' + normalized + ' — not in workspace or allowExternalPaths'
  );
  throw new Error(
    'Path outside workspace: ' +
      requested +
      ' — not in workspace or allowExternalPaths. Allowed: ' +
      roots.join(' ; ') +
      ' (add the folder to the freekit.allowExternalPaths setting to allow it).'
  );
}

/** v2.5.49 (FIX 1): rădăcinile permise, pentru log/erori/teste. */
export function workspaceRoots(): string[] {
  const primary = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return allowedRoots(primary ?? '.');
}


async function readFile(
  rel: string,
  root: string,
  log?: (msg: string) => void
): Promise<ToolResult> {
  const abs = safePath(rel, root);
  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
  const text = Buffer.from(content).toString('utf8');
  // v2.5.22 (bug #54): trunchiere head+tail, nu doar capul (vezi truncateContent).
  const body = truncateContent(text, MAX_LINES_PER_FILE, MAX_CHARS_PER_FILE);
  // v2.5.27 (bug #63): fișierele TypeScript pleacă spre AI etichetate `.txt`
  // (ChatGPT refuză `.ts`), cu note în antet; calea reală rămâne în registru.
  if (isTypeScriptPath(rel)) {
    const alias = toAiPath(rel);
    log?.(
      'read_file: sent ' + rel + ' as ' + alias + ' (.ts → .txt for AI compatibility)'
    );
    return {
      ok: true,
      result: '--- FILE: ' + alias + ' ---\n' + TS_ALIAS_NOTE + '\n' + body
    };
  }
  return { ok: true, result: body };
}

async function writeFile(
  rel: string,
  content: string,
  root: string
): Promise<ToolResult> {
  const abs = safePath(rel, root);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(abs),
    Buffer.from(content, 'utf8')
  );
  return { ok: true, result: 'Written ' + content.length + ' bytes to ' + rel };
}

/* =========================================================================
 * v2.5.37 (bug #88) — strip defensiv al antetului copiat de model la scriere
 *
 * Fișierele TypeScript pleacă spre AI cu antetul din read_file
 * (`--- FILE: src/foo.ts.txt ---` + nota „(TypeScript file, sent as .txt for
 * compatibility)"), iar eticheta de limbaj e randată de chatul web. Unele
 * modele (Gemini, testul HARD MODE din 7 Oct 2026) copiază antetul ca PRIMELE
 * linii ale fișierului scris ⇒ `error TS2304: Cannot find name 'TypeScript'`
 * și modelul se învârte rescriind fișierele. Antetul din read_file rămâne
 * NESCHIMBAT (DeepSeek funcționează perfect cu el, 10/10) — curățăm doar la
 * scriere, ca plasă de siguranță.
 * ========================================================================= */

/** Câte linii de antet recunoscute se elimină cel mult de la început. */
export const MAX_AI_HEADER_LINES = 5;

/** `--- FILE: src/foo.ts ---` (antetul din read_file/read_files) sau nota lui. */
const AI_HEADER_LINE_RE =
  /^(?:-{2,}\s*FILE\b[^\n]*|\([^()]{0,80}\bfile\b[^()]{0,80}\))$/i;

/** Eticheta de limbaj rămasă singură pe rând („TypeScript", „Plaintext", …). */
const AI_LANGUAGE_LINE_RE = new RegExp(
  '^(?:typescript|javascript|plaintext|json|python|text|ts|js|tsx|jsx|astro|' +
    'markdown|md|css|scss|html|jsonc|yaml|yml|xml|sql|bash|shell|sh|java|c|' +
    'cpp|go|rust|php|ruby)$',
  'i'
);

/** Gard de cod markdown izolat pe rând: ``` / ```ts / ~~~ (eticheta opțională). */
const AI_OPEN_FENCE_RE = /^(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_.+#-]*$/;

/** Gard de închidere, fără etichetă de limbaj (``` / ~~~). */
const AI_CLOSE_FENCE_RE = /^(?:`{3,}|~{3,})[ \t]*$/;

/** Fișiere la care un ``` final poate fi conținut legitim (README, .txt, …). */
const DOC_FILE_RE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

/**
 * Curăță de la începutul conținutului primit de la AI liniile de antet pe care
 * modelul le copiază din prompt (antetul Freekit, nota lui, eticheta de limbaj,
 * gardul de cod) plus gardul de închidere rămas la final. Restul conținutului
 * rămâne neatins: un fișier curat iese identic (`stripped` = 0).
 */
export function stripAiFileHeader(
  content: string,
  rel: string
): { content: string; stripped: number } {
  const text = String(content ?? '');
  if (!text.trim()) return { content: text, stripped: 0 };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const skipBlanks = (from: number): number => {
    let j = from;
    while (j < lines.length && !lines[j].trim()) j++;
    return j;
  };

  let stripped = 0;
  let start = 0;

  // 1) antetul + eticheta de limbaj de la început (rândurile goale dintre ele
  //    intră în același „antet"); fără nicio linie recunoscută nu atingem nimic.
  let headers = 0;
  let j = 0;
  while (headers < MAX_AI_HEADER_LINES && j < lines.length) {
    const line = lines[j].trim();
    if (!line) {
      j++;
      continue;
    }
    if (!AI_HEADER_LINE_RE.test(line) && !AI_LANGUAGE_LINE_RE.test(line)) break;
    headers++;
    j++;
  }
  if (headers) {
    start = skipBlanks(j);
    stripped += headers;
  }

  // 2) gardul de cod de la început (``` / ```ts), cu rândurile goale de dinainte
  const open = skipBlanks(start);
  let fenceStripped = false;
  if (open < lines.length && AI_OPEN_FENCE_RE.test(lines[open].trim())) {
    fenceStripped = true;
    stripped++;
    start = skipBlanks(open + 1);
  }

  // 3) gardul de închidere rămas la final: îl scoatem când e perechea gardului
  //    de la început sau când fișierul e de cod (într-un .md/README un ``` final
  //    poate fi conținut legitim — acolo nu-l atingem)
  let end = lines.length;
  let last = lines.length - 1;
  while (last >= start && !lines[last].trim()) last--;
  if (
    last >= start &&
    AI_CLOSE_FENCE_RE.test(lines[last].trim()) &&
    (fenceStripped || !DOC_FILE_RE.test(rel))
  ) {
    end = last;
    stripped++;
  }

  if (!stripped) return { content: text, stripped: 0 };

  let out = lines.slice(start, end);
  if (end < lines.length) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length && /\r?\n$/.test(text)) out.push('');
  }

  logLine(
    'write',
    'stripped ' + stripped + ' language marker line(s) from ' + rel
  );
  return { content: out.length ? out.join(eol) : '', stripped };
}

/**
 * v2.5.29 FIX 3 (bug #67): corpul uneltei `write_file`, extras din `executeTool`
 * ca să putem adăuga avertismentul de nivel 2 al anti-spam-ului (al doilea
 * eșec pe același fișier) fără să duplicăm fiecare punct de ieșire.
 */
async function writeFileTool(
  args: Record<string, any>,
  workspaceRoot: string,
  approve: ApprovalFn,
  userText?: string
): Promise<ToolResult> {
  // v0.2.1: anti-spam — verificăm ÎNAINTE de cardul de aprobare
  const limitErr = checkWriteLimit(args.path);
  if (limitErr) return { ok: false, error: limitErr };
  // v2.5.37 (bug #88): strip defensiv — modelul poate copia antetul Freekit
  // („--- FILE: … ---", nota, „TypeScript") ca primele linii ale fișierului
  const newContent = stripAiFileHeader(
    args.content as string,
    String(args.path)
  ).content;
  // v2.5.6: truncation guard — nu scriem (și nu cerem aprobare pentru)
  // un fișier scris doar parțial; cerem modelului conținutul COMPLET
  const truncErr = checkTruncation('write_file', args.path, newContent);
  if (truncErr) {
    return {
      ok: false,
      error: truncErr.error,
      userNotice: truncErr.userNotice
    };
  }
  // v0.5.0: preview pentru diff-ul nativ (conținut vechi + nou)
  const oldInfo = await tryReadInfo(args.path, workspaceRoot);
  const diff = makeDiff(args.path, oldInfo.content, newContent);
  // v2.5.6 (bug #10): WARNING ONLY — semnalăm că modelul a scris altceva
  // decât fragmentele din prompt, dar NU blocăm și NU reîncercăm
  const divergent = isDivergentFromPrompt(userText, args.path, newContent);
  const changes: FileChangePreview[] = [
    {
      label: args.path,
      oldContent: oldInfo.content,
      newContent,
      isNew: !oldInfo.exists,
      divergent
    }
  ];
  if (!(await approve('write_file', args.path, diff, changes))) {
    return { ok: false, error: 'User rejected', divergent };
  }
  const res = await writeFile(args.path, newContent, workspaceRoot);
  if (res.ok) {
    recordWrite(args.path);
    recordWriteCall();
  }
  return divergent ? { ...res, divergent: true } : res;
}

/* =========================================================================
 * v2.5.43 (bug #99) — `edit_file`: potrivire TOLERANTĂ + diagnostic de eșec
 * În testul Mistral (14:28–14:30) `edit_file` a răspuns `ok=false` de patru ori,
 * iar în log apărea doar „old_text not found": nu se putea spune dacă textul
 * trimis de model era trunchiat, scris cu alt whitespace, cu ghilimele
 * tipografice sau cu alt EOL. Aici aceeași diferență nu mai blochează editarea
 * (trepte de normalizare), iar când chiar nu se potrivește, logul și eroarea
 * trimisă modelului spun exact ce s-a căutat și ce e mai aproape în fișier.
 * ========================================================================= */

/** Treptele de normalizare, aplicate IDENTIC pe conținut și pe `old_text`. */
interface NormalizeOpts {
  /** spații/tab-uri consecutive → un singur spațiu */
  collapse?: boolean;
  /** ghilimele tipografice → drepte, cratime → „-", spații speciale → „ " */
  typo?: boolean;
  /** ignoră spațiile de la capetele liniilor (și liniile goale consecutive) */
  trimLines?: boolean;
}

/**
 * Normalizează `src` (cu EOL unificat la `\n`) păstrând, pentru fiecare
 * caracter din rezultat, indexul caracterului ORIGINAL — necesar ca potrivirea
 * făcută pe textul normalizat să poată fi tradusă înapoi în intervalul real
 * din fișier (altfel am scrie la alt offset decât cel citit).
 */
function normalizeWithMap(
  src: string,
  opts: NormalizeOpts
): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  const push = (ch: string, at: number) => {
    out.push(ch);
    map.push(at);
  };
  const trans = (ch: string): string => {
    if (!opts.typo) return ch;
    switch (ch) {
      case '\u2018':
      case '\u2019':
      case '\u201A':
      case '\u201B':
        return "'";
      case '\u201C':
      case '\u201D':
      case '\u201E':
      case '\u201F':
        return '"';
      case '\u2013':
      case '\u2014':
      case '\u2212':
        return '-';
      case '\u00A0':
      case '\u2007':
      case '\u202F':
        return ' ';
      default:
        return ch;
    }
  };
  const isH = (ch: string): boolean =>
    ch === ' ' ||
    ch === '\t' ||
    ch === '\f' ||
    ch === '\v' ||
    (!!opts.typo && ch === '\u00A0');

  // împărțim în linii, păstrând offset-ul original al fiecăreia
  const lines: Array<{ text: string; at: number }> = [];
  let lineStart = 0;
  for (let i = 0; i <= src.length; i++) {
    if (i !== src.length && src[i] !== '\n' && src[i] !== '\r') continue;
    lines.push({ text: src.slice(lineStart, i), at: lineStart });
    if (i < src.length && src[i] === '\r' && src[i + 1] === '\n') i++;
    lineStart = i + 1;
  }

  let pendingBreak = false;
  let pendingBreakAt = 0;
  for (const line of lines) {
    if (pendingBreak) {
      // cu `trimLines` liniile goale consecutive se topesc într-una singură:
      // sărim peste break, dar îl lăsăm „în așteptare" pentru linia următoare.
      if (!(opts.trimLines && line.text.trim() === '')) {
        push('\n', pendingBreakAt);
        pendingBreak = false;
      }
    }

    const end = line.at + line.text.length;
    let from = line.at;
    let to = end;
    if (opts.trimLines) {
      while (from < to && isH(src[from])) from++;
      while (to > from && isH(src[to - 1])) to--;
    }
    let k = from;
    while (k < to) {
      if (isH(src[k])) {
        let j = k;
        while (j < to && isH(src[j])) j++;
        if (opts.collapse || opts.trimLines) {
          push(' ', k);
        } else {
          for (let q = k; q < j; q++) push(src[q], q);
        }
        k = j;
        continue;
      }
      for (const c of trans(src[k])) push(c, k);
      k++;
    }

    if (end < src.length) {
      pendingBreak = true;
      pendingBreakAt = end;
    }
  }
  return { text: out.join(''), map };
}

/** Treptele de potrivire, de la cea mai strictă la cea mai tolerantă. */
const EDIT_MATCH_LADDER: Array<{ name: string; opts: NormalizeOpts }> = [
  { name: 'eol', opts: {} },
  { name: 'whitespace', opts: { collapse: true } },
  { name: 'typography', opts: { collapse: true, typo: true } },
  { name: 'line-trim', opts: { collapse: true, typo: true, trimLines: true } }
];

/** Sfârșitul real al unei potriviri care se termină chiar pe un line break. */
function matchEndAt(content: string, at: number): number {
  if (content[at] === '\r' && content[at + 1] === '\n') return at + 2;
  return at + 1;
}

/**
 * Caută `oldText` în `content`: întâi exact (bit-cu-bit), apoi prin treptele de
 * normalizare. Întoarce intervalul REAL (indexuri în `content`) sau `null`.
 */
function findTolerantMatch(
  content: string,
  oldText: string
): { start: number; end: number; strategy: string } | null {
  const needle = String(oldText ?? '');
  if (!needle) return null;
  const exact = content.indexOf(needle);
  if (exact >= 0) {
    return { start: exact, end: exact + needle.length, strategy: 'exact' };
  }
  for (const step of EDIT_MATCH_LADDER) {
    const hay = normalizeWithMap(content, step.opts);
    const pin = normalizeWithMap(needle, step.opts);
    // un `old_text` doar din spații s-ar potrivi oriunde — nu-l acceptăm
    if (!pin.text || !pin.text.trim()) continue;
    const idx = hay.text.indexOf(pin.text);
    if (idx < 0) continue;
    return {
      start: hay.map[idx],
      end: matchEndAt(content, hay.map[idx + pin.text.length - 1]),
      strategy: step.name
    };
  }
  return null;
}

/** Eșantion scurt, cu EOL/whitespace vizibile, pentru linia de log. */
function sampleForLog(text: string, max = 20): string {
  return String(text ?? '')
    .slice(0, max)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u00A0\u2007\u202F]/g, '\\u00a0');
}

/**
 * Cel mai apropiat loc din fișier pentru `old_text`: încearcă fiecare linie
 * ne-goală a textului căutat ca „ancoră" (cele lungi întâi — mai puține
 * potriviri întâmplătoare) și se oprește la prima care există în fișier, cu
 * 3 linii de context. `null` dacă nicio linie nu apare în fișier.
 */
function nearestMatchSnippet(content: string, oldText: string): string | null {
  const lines = content.split(/\r?\n/);
  const wanted = String(oldText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length);
  let hit = -1;
  for (const anchor of wanted) {
    const needle = anchor.slice(0, 60);
    hit = lines.findIndex((l) => l.includes(needle));
    if (hit < 0) hit = lines.findIndex((l) => l.trim() === anchor);
    if (hit >= 0) break;
  }
  if (hit < 0) return null;
  const from = Math.max(0, hit - 1);
  const to = Math.min(lines.length - 1, hit + 1);
  const body: string[] = [];
  for (let i = from; i <= to; i++) {
    body.push(String(i + 1).padStart(4, ' ') + ' | ' + lines[i]);
  }
  return 'Nearest match, around line ' + (hit + 1) + ':\n' + body.join('\n');
}

/** Log explicit la eșec (altfel `ok=false` rămânea fără nicio explicație). */
function logEditFailure(rel: string, oldText: string, content: string): void {
  logLine(
    'tool',
    'edit_file failed: old_text not found in ' +
      rel +
      ' (len=' +
      String(oldText ?? '').length +
      ', first20=' +
      sampleForLog(oldText) +
      ')'
  );
  const near = nearestMatchSnippet(content, oldText);
  if (near) {
    logLine('tool', 'edit_file: ' + near.split('\n').join(' ⏎ '));
  }
}

/** Eroarea trimisă modelului: motiv + context (3 linii) + hint de retry. */
function editFailureError(rel: string, oldText: string, content: string): string {
  const parts = ['old_text not found in ' + rel + '.'];
  const near = nearestMatchSnippet(content, oldText);
  if (near) parts.push(near);
  parts.push(
    'Hint: read the file again with read_file and copy the OLD_TEXT block exactly ' +
      'as it is on disk (indentation, trailing spaces, line endings and quotes ' +
      'must match), then retry edit_file.'
  );
  return parts.join('\n\n');
}

async function editFile(
  rel: string,
  oldText: string,
  newText: string,
  root: string
): Promise<ToolResult> {
  const abs = safePath(rel, root);
  const content = Buffer.from(
    await vscode.workspace.fs.readFile(vscode.Uri.file(abs))
  ).toString('utf8');

  const match = findTolerantMatch(content, oldText);
  if (!match) {
    return { ok: false, error: 'old_text not found in ' + rel };
  }

  const updated =
    content.slice(0, match.start) + newText + content.slice(match.end);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(abs),
    Buffer.from(updated, 'utf8')
  );
  return {
    ok: true,
    result:
      'Edited ' +
      rel +
      (match.strategy === 'exact'
        ? ''
        : ' (tolerant match: ' + match.strategy + ')')
  };
}

/* =========================================================================
 * v2.5.42 (bug #98) — ȘTERGEREA ca unealtă de primă clasă
 * În testul din 13:29:07 AI-ul a cerut `delete_file` de două ori (unealtă
 * inexistentă ⇒ „Unknown tool"), apoi a trecut pe `run_command` cu `rm` —
 * funcțional, dar ineficient și fără gardurile de scope/trust ale scrierilor.
 * Aici adăugăm delete_file (un fișier) și delete_directory (un folder, opțional
 * recursiv), cu aceleași reguli ca write_file: Workspace Trust, scope-ul
 * task-ului (bug #68) și aprobare manuală când auto-approve nu acoperă.
 * ========================================================================= */

/**
 * v2.5.42 (bug #98): ștergerea e distructivă, deci NU se face în afara
 * scope-ului task-ului. Scope nedeterminat (prompt fără nicio cale) ⇒ `null`:
 * nu blocăm aici, aprobarea utilizatorului rămâne gardul (fail-closed, ca la
 * scrieri).
 */
function deleteScopeRefusal(rel: string, userText?: string): string | null {
  const scope = detectTaskScope(String(userText ?? ''));
  if (!scope || isPathInScope(rel, scope)) return null;
  return (
    'Refusing to delete "' + rel + '": it is outside the task scope (' +
    scopeLabel(scope) +
    '). Delete only inside the task scope, or ask the user.'
  );
}

async function deleteFileTool(
  rel: string,
  root: string,
  approve: ApprovalFn,
  log: (msg: string) => void,
  userText?: string
): Promise<ToolResult> {
  const refusal = deleteScopeRefusal(rel, userText);
  if (refusal) return { ok: false, error: refusal };

  let abs: string;
  try {
    abs = safePath(rel, root);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, error: 'delete_file: "' + rel + '" does not exist.' };
  }
  if (stat.isDirectory()) {
    return {
      ok: false,
      error: 'delete_file: "' + rel + '" is a directory — use delete_directory.'
    };
  }
  if (!(await approve('delete_file', rel, '🗑️ Delete file: ' + rel))) {
    return { ok: false, error: 'User rejected' };
  }
  try {
    fs.unlinkSync(abs); // cross-platform
  } catch (e: any) {
    return { ok: false, error: 'delete_file failed: ' + (e?.message ?? String(e)) };
  }
  log('[tool] delete_file ' + rel);
  return { ok: true, result: 'Deleted file ' + rel };
}

async function deleteDirectoryTool(
  rel: string,
  recursive: boolean,
  root: string,
  approve: ApprovalFn,
  log: (msg: string) => void,
  userText?: string
): Promise<ToolResult> {
  const refusal = deleteScopeRefusal(rel, userText);
  if (refusal) return { ok: false, error: refusal };

  let abs: string;
  try {
    abs = safePath(rel, root);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  if (abs === path.resolve(root)) {
    return {
      ok: false,
      error: 'delete_directory: refusing to delete the workspace root.'
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return {
      ok: false,
      error: 'delete_directory: "' + rel + '" does not exist.'
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: 'delete_directory: "' + rel + '" is a file — use delete_file.'
    };
  }

  // ne-recursiv = doar un folder GOL; altfel cerem explicit recursive: true
  if (!recursive) {
    let entries: string[];
    try {
      entries = fs.readdirSync(abs);
    } catch (e: any) {
      return {
        ok: false,
        error: 'delete_directory failed: ' + (e?.message ?? String(e))
      };
    }
    if (entries.length) {
      return {
        ok: false,
        error:
          'delete_directory: "' + rel + '" is not empty — pass recursive: true ' +
          'to delete it with all its contents.'
      };
    }
  }

  const label =
    '🗑️ Delete folder' + (recursive ? ' (recursive)' : '') + ': ' + rel;
  if (!(await approve('delete_directory', rel, label))) {
    return { ok: false, error: 'User rejected' };
  }
  try {
    // fs.rmSync cu recursive:false refuză orice folder (ERR_FS_EISDIR), deci
    // folderul gol confirmat mai sus se șterge cu rmdirSync.
    if (recursive) fs.rmSync(abs, { recursive: true, force: false });
    else fs.rmdirSync(abs);
  } catch (e: any) {
    return {
      ok: false,
      error: 'delete_directory failed: ' + (e?.message ?? String(e))
    };
  }
  log('[tool] delete_directory ' + rel + (recursive ? ' (recursive)' : ''));
  return {
    ok: true,
    result: 'Deleted folder ' + rel + (recursive ? ' (recursive)' : '')
  };
}

// v2.5.23: un director cu mii de intrări (ex. `out/`, `node_modules/`) nu mai
// poate trimite un listing uriaș către AI.
const MAX_LIST_ENTRIES = 1000;

async function listFiles(rel: string, root: string): Promise<ToolResult> {
  const abs = safePath(rel, root);
  const entries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(abs)
  );
  const shown = entries.slice(0, MAX_LIST_ENTRIES);
  let out = shown
    .map(([name, type]) =>
      type === vscode.FileType.Directory ? name + '/' : name
    )
    .join('\n');
  if (entries.length > shown.length) {
    out +=
      '\n… (' + (entries.length - shown.length) + ' more entries not shown)';
  }
  return {
    ok: true,
    result: clipPayload(out, MAX_CHARS_TOTAL) || '(empty dir)'
  };
}

async function runCommand(
  command: string,
  /** v2.5.38 (bug #89): comanda scrisă de model, când cea executată e tradusă. */
  translatedFrom?: string
): Promise<ToolResult> {
  // v0.6.0: fiecare rulare a unei comenzi consumă o încercare de auto-reparare
  // v2.5.38: contorul rămâne pe comanda ORIGINALĂ a modelului (aceeași cheie pe
  // care o verifică `isCommandBlocked`), ca anti-bucla să funcționeze și după
  // traducerea automată (rm → del).
  const key = normCommandKey(translatedFrom ?? command);
  const attempt = beginCommandAttempt(key);
  const started = Date.now();
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // v1.8.1: comenzile long-running (dev/serve/start/watch/preview) NU se
  // așteaptă — pornesc într-un TERMINAL VS Code VIZIBIL (răspuns imediat:
  // URL + primele secunde de output)
  if (isLongRunningCommand(command)) {
    return await runDevServerCommand('run_command', command, cwd, key, attempt);
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    commandSucceeded(key);
    return formatCommandOutcome(
      'run_command',
      command,
      {
        ok: true,
        exitCode: 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        combined: combinedOutput(String(stdout ?? ''), String(stderr ?? '')),
        duration: Date.now() - started
      },
      attempt,
      undefined,
      translatedFrom
    );
  } catch (e: any) {
    // v0.6.0: eroarea COMPLETĂ (stdout + stderr + exit code + durată) — nu
    // doar „exit code 1” — ajunge la model împreună cu directiva de reparare
    const stdout = e?.stdout ? String(e.stdout) : '';
    const stderr = e?.stderr ? String(e.stderr) : '';
    let exitCode = 1;
    if (e?.killed === true) exitCode = 124; // timeout
    else if (typeof e?.code === 'number') exitCode = e.code;
    else if (typeof e?.code === 'string' && /ENOENT/i.test(e.code)) exitCode = 127;
    return formatCommandOutcome(
      'run_command',
      command,
      {
        ok: false,
        exitCode,
        stdout,
        stderr,
        combined: combinedOutput(stdout, stderr) || e?.message || String(e),
        duration: Date.now() - started
      },
      attempt,
      undefined,
      translatedFrom
    );
  }
}

/* =========================================================================
 * v1.8.1 — DEV SERVER în TERMINAL VS Code: vizibil + răspuns imediat
 * Pornește comanda într-un terminal dedicat, VIZIBIL (utilizatorul vede
 * output-ul live și poate apăsa Ctrl+C), așteaptă doar primele ~3s de output
 * (URL + erorile rapide de pornire ajung la AI) și lasă serverul pornit până
 * la Ctrl+C sau comanda „Freekit: Stop Dev Servers”.
 * ========================================================================= */

async function runDevServerCommand(
  toolLabel: string,
  command: string,
  cwd: string | undefined,
  key: string,
  attempt: number
): Promise<ToolResult> {
  // anti-dublare: același server (comandă + folder) nu se pornește de două ori
  const existing = findRunningDevServer(command, cwd);
  if (existing) {
    commandSucceeded(key);
    return {
      ok: true,
      result:
        '✅ The server is already running in the VS Code terminal “' +
        existing.terminalName + '”\n' +
        'tool: ' + toolLabel + ' — command: ' + command + '\n' +
        'I did not start a second instance. Continue with your task or reply ' +
        'with the final answer — do NOT wait for this command.',
      commandRun: {
        command,
        attempt,
        max: MAX_COMMAND_ATTEMPTS,
        exitCode: 0,
        duration: 0,
        final: false
      }
    };
  }

  const res = await startDevServer(command, { cwd });
  if (res.running) {
    commandSucceeded(key);
    return {
      ok: true,
      result: formatDevServerStartResult(toolLabel, command, res, {
        cwd,
        graceMs: DEFAULT_GRACE_MS
      }),
      commandRun: {
        command,
        attempt,
        max: MAX_COMMAND_ATTEMPTS,
        exitCode: 0,
        duration: res.durationMs,
        final: false
      }
    };
  }

  return formatCommandOutcome(
    toolLabel,
    command,
    {
      ok: false,
      exitCode: res.exitCode ?? 1,
      stdout: res.stdout,
      stderr: res.stderr,
      combined: res.output,
      duration: res.durationMs
    },
    attempt,
    'DEV-SERVER NOTE: this command was started in a VISIBLE VS Code terminal (“' +
      (res.terminalName || '?') +
      '”), but the process exited immediately after ' +
      (res.durationMs / 1000).toFixed(1) +
      's — usually a startup error (port in use, syntax error, missing script, missing dependencies). The terminal stays open with the full output. Read the output above, fix the ROOT CAUSE and re-run the command.'
  );
}

/* =========================================================================
 * FAZA II (B) — npm/pnpm/yarn cu verificare
 * Folosește package manager-ul detectat din lockfile și validează scripts
 * contra package.json. Output-ul complet (stdout+stderr) ajunge la AI.
 * ========================================================================= */

async function runNpmTool(
  args: Record<string, any>,
  root: string,
  approve: ApprovalFn,
  log: (msg: string) => void
): Promise<ToolResult> {
  const info = await detectProject(root);
  if (info.type !== 'node') {
    return {
      ok: false,
      error:
        'This is not a Node project (package.json is missing). Use run_command if needed.'
    };
  }

  const pm = info.packageManager || 'npm';
  const action = String(args.action || 'script').toLowerCase();

  let desc: string;
  let cmdArgs: string[];
  let timeoutMs: number;
  // v1.8.1: scripturile long-running (dev/serve/start/watch/preview) nu se
  // așteaptă — rulează vizibil, într-un terminal VS Code dedicat
  let longRunning = false;

  if (action === 'install') {
    desc = pm + ' install';
    cmdArgs = ['install'];
    timeoutMs = 300000;
  } else {
    const script = String(args.script ?? args.name ?? '');
    if (!script) {
      return {
        ok: false,
        error:
          'run_npm: args.script is missing. Available scripts: ' +
          (Object.keys(info.scripts).join(', ') || '(none)')
      };
    }
    if (!info.scripts[script]) {
      return {
        ok: false,
        error:
          'The script "' + script + '" does not exist in package.json. Available: ' +
          (Object.keys(info.scripts).join(', ') || '(none)')
      };
    }
    // numele ajunge în linia de comandă (shell pe Windows) — îl ținem strict
    if (!/^[A-Za-z0-9:_.\-]{1,60}$/.test(script)) {
      return {
        ok: false,
        error:
          'run_npm: script name "' + script + '" contains unusual characters — use run_command.'
      };
    }
    desc = pm + ' run ' + script;
    cmdArgs = ['run', script];
    timeoutMs = 180000;
    longRunning = isLongRunningScript(script);
  }

  // v0.6.0: auto-repair — comanda blocată după MAX_COMMAND_ATTEMPTS încercări
  const key = normCommandKey(desc);
  if (isCommandBlocked(key)) {
    return blockedCommandResult(desc);
  }

  if (
    !(await approve(
      'run_npm',
      desc,
      '> ' + desc +
        (longRunning
          ? '\n(development server — starts in a VISIBLE VS Code TERMINAL: you immediately get the URL + the first seconds of output; it stays running until Ctrl+C or “Freekit: Stop Dev Servers”)'
          : '')
    ))
  ) {
    return { ok: false, error: 'User rejected' };
  }

  log('run_npm: ' + desc);
  const attempt = beginCommandAttempt(key);

  // v1.8.1: script long-running → terminal VS Code vizibil (nu se așteaptă)
  if (longRunning) {
    return await runDevServerCommand('run_npm', desc, root, key, attempt);
  }

  const res = await runProgram(packageManagerBin(pm), cmdArgs, {
    cwd: root,
    timeoutMs,
    // pe Windows npm/pnpm/yarn sunt .cmd → au nevoie de shell
    shell: process.platform === 'win32'
  });
  if (res.ok) commandSucceeded(key);

  const exitCode = res.ok
    ? 0
    : res.timedOut
      ? 124
      : typeof res.code === 'number'
        ? res.code
        : 1;

  return formatCommandOutcome(
    'run_npm',
    desc,
    {
      ok: res.ok,
      exitCode,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      combined: res.output,
      duration: res.duration ?? 0
    },
    attempt
  );
}

/* =========================================================================
 * FAZA III (F) — info despre proiect (tip, package manager, scripts)
 * ========================================================================= */

async function projectInfoTool(root: string): Promise<ToolResult> {
  const info = await detectProject(root);
  return { ok: true, result: formatProjectInfo(info) };
}

/* =========================================================================
 * v1.10.0 — search_semantic: căutare de cod după SENS
 * Folosește indexul semantic local (embeddings Ollama, vezi src/indexer).
 * E read-only (fără aprobare). Dacă indexul lipsește, întoarce un mesaj clar
 * care îi spune AI-ului să ruleze comanda „Freekit: Index Workspace".
 * ========================================================================= */

async function searchSemanticTool(
  query: unknown,
  root: string
): Promise<ToolResult> {
  const q = String(query ?? '').trim();
  if (!q) {
    return {
      ok: false,
      error: 'search_semantic requires a non-empty "query" argument.'
    };
  }
  if (!isSemanticEnabled()) {
    return {
      ok: false,
      error:
        'Semantic search is disabled (setting freekit.semanticIndex.enabled). Use search_files instead.'
    };
  }
  const text = await formatSearchResults(root, q);
  if (text.startsWith('Semantic search error:')) {
    return { ok: false, error: clipPayload(text, MAX_CHARS_TOTAL) };
  }
  // v2.5.23: fragmentele semantice au un buget de payload (cap+coadă).
  return { ok: true, result: clipPayload(text, MAX_CHARS_TOTAL) };
}

/* =========================================================================
 * FAZA II (D) — multi-fișier: un singur approval pentru mai multe fișiere
 * ========================================================================= */

const MAX_BATCH_WRITE_FILES = 20;
const MAX_BATCH_READ_FILES = 12;

/* v2.5.22 (bug #54) / v2.5.23: bugetul de payload stă acum în src/payload.ts
 * (MAX_LINES_PER_FILE / MAX_CHARS_PER_FILE / MAX_CHARS_TOTAL + truncateContent),
 * ca să fie folosit de TOATE uneltele care întorc text către AI, nu doar de
 * read_file / read_files. */

async function readFilesBatch(
  args: Record<string, any>,
  root: string,
  log?: (msg: string) => void
): Promise<ToolResult> {
  const paths: string[] = Array.isArray(args.paths)
    ? args.paths.filter((p: any) => typeof p === 'string' && p)
    : [];
  if (!paths.length) {
    return {
      ok: false,
      error: 'read_files: args.paths is missing (array of paths)'
    };
  }

  const limited = paths.slice(0, MAX_BATCH_READ_FILES);
  const sections: string[] = [];
  let total = 0;
  for (const rel of limited) {
    // v2.5.27 (bug #63): fișierele TypeScript se trimit ca `X.ts.txt`
    const aiRel = toAiPath(rel);
    const isTs = aiRel !== rel;
    if (isTs) {
      log?.(
        'read_files: sent ' + rel + ' as ' + aiRel + ' (.ts → .txt for AI compatibility)'
      );
    }
    try {
      const abs = safePath(rel, root);
      const content = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(abs))
      ).toString('utf8');
      const clipped = truncateContent(
        content,
        MAX_LINES_PER_FILE,
        MAX_CHARS_PER_FILE
      );
      // v2.5.22 (bug #54): buget total pe batch — fișierele care nu mai încap
      // se sar (nu se trimit la model), ca payload-ul să rămână mic.
      if (total + clipped.length > MAX_CHARS_TOTAL) {
        sections.push(
          '--- FILE: ' + aiRel + ' ---\n[SKIPPED: payload limit reached]'
        );
        continue;
      }
      sections.push(
        '--- FILE: ' + aiRel + ' ---\n' +
          (isTs ? TS_ALIAS_NOTE + '\n' : '') +
          clipped
      );
      total += clipped.length;
    } catch (e: any) {
      sections.push(
        '--- FILE: ' + aiRel + ' ---\n(error: ' + (e?.message ?? String(e)) + ')'
      );
    }
  }

  let out = sections.join('\n\n');
  if (paths.length > limited.length) {
    out +=
      '\n\n(' +
      (paths.length - limited.length) +
      ' paths ignored — max ' +
      MAX_BATCH_READ_FILES +
      ' per call)';
  }
  return { ok: true, result: out };
}

async function writeFilesBatch(
  args: Record<string, any>,
  root: string,
  approve: ApprovalFn,
  /** v2.5.6 (bug #10): referința pentru detectarea conținutului improvizat. */
  userText?: string
): Promise<ToolResult> {
  const raw = Array.isArray(args.files) ? args.files : [];
  const files = (
    raw.filter(
      (f: any) =>
        f && typeof f.path === 'string' && typeof f.content === 'string'
    ) as Array<{ path: string; content: string }>
    // v2.5.37 (bug #88): strip defensiv al antetului Freekit copiat de model
  ).map((f) => ({ ...f, content: stripAiFileHeader(f.content, f.path).content }));

  if (!files.length) {
    return {
      ok: false,
      error:
        'write_files: args.files is missing or empty. Expected ' +
        '{"action":"write_files","args":{"files":[{"path":"...","content":"..."}]}} ' +
        '(one item per file; the array goes INSIDE args.files).'
    };
  }
  if (files.length > MAX_BATCH_WRITE_FILES) {
    return {
      ok: false,
      error:
        'write_files: max ' +
        MAX_BATCH_WRITE_FILES +
        ' files per call (' +
        files.length +
        ' requested)'
    };
  }

  // validăm toate căile ÎNAINTE de aprobare (nu aprobăm ceva ce oricum eșuează)
  for (const f of files) {
    safePath(f.path, root);
  }

  // v2.5.6: truncation guard — un singur fișier incomplet respinge TOT batch-ul
  // (înainte de aprobare); modelul trebuie să rescrie conținutul COMPLET
  for (const f of files) {
    const truncErr = checkTruncation('write_files', f.path, f.content);
    if (truncErr) {
      return {
        ok: false,
        error:
          'write_files REJECTED (no file was written): ' + truncErr.error,
        userNotice: truncErr.userNotice
      };
    }
  }

  // un singur diff combinat (text, pentru fallback-ul din chat) + preview
  // structurat per fișier (pentru diff-ul nativ multi-fișier, v0.5.0)
  const diffParts: string[] = [];
  const changes: FileChangePreview[] = [];
  let diffBudget = 8000;
  for (const f of files) {
    const oldInfo = await tryReadInfo(f.path, root);
    changes.push({
      label: f.path,
      oldContent: oldInfo.content,
      newContent: f.content,
      isNew: !oldInfo.exists,
      // v2.5.6 (bug #10): WARNING ONLY — conținut impropriat față de prompt
      divergent: isDivergentFromPrompt(userText, f.path, f.content)
    });
    const d = makeDiff(f.path, oldInfo.content, f.content);
    const piece =
      d.length > 1600 ? d.slice(0, 1600) + '\n[...diff trunchiat...]' : d;
    if (diffBudget <= 0) {
      diffParts.push('… (remaining files: diff omitted)');
      break;
    }
    diffBudget -= piece.length;
    diffParts.push(piece);
  }

  const summary =
    files
      .slice(0, 3)
      .map((f) => f.path)
      .join(', ') +
    (files.length > 3 ? ' (+' + (files.length - 3) + ')' : '');
  const diff = (
    files.length +
    ' files:\n\n' +
    diffParts.join('\n\n')
  ).slice(0, 10000);

  // v2.5.6 (bug #10): cel puțin un fișier pare scris „din imaginație"
  const divergent = changes.some((c) => c.divergent);

  if (!(await approve('write_files', summary, diff, changes))) {
    return { ok: false, error: 'User rejected', divergent };
  }

  const written: string[] = [];
  const blocked: string[] = [];
  for (const f of files) {
    // v0.2.1: anti-spam — verificăm per fișier (prinde și duplicatele din batch)
    const limitErr = checkWriteLimit(f.path);
    if (limitErr) {
      blocked.push(f.path);
      continue;
    }
    try {
      const abs = safePath(f.path, root);
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(path.dirname(abs))
      );
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(abs),
        Buffer.from(f.content, 'utf8')
      );
      written.push(f.path);
      recordWrite(f.path);
    } catch (e: any) {
      return {
        ok: false,
        error:
          'Written ' +
          written.length +
          '/' +
          files.length +
          ': ' +
          (written.join(', ') || '—') +
          '\nError writing ' +
          f.path +
          ': ' +
          (e?.message ?? String(e))
      };
    }
  }

  if (!written.length) {
    return {
      ok: false,
      error:
        'ANTI-SPAM LIMIT: all ' +
        files.length +
        ' files reached the write limit (max ' +
        MAX_WRITES_PER_FILE +
        '/file, ' +
        MAX_WRITES_TOTAL +
        '/message): ' +
        blocked.join(', ') +
        '. Do not rewrite them — reply with text.'
    };
  }
  recordWriteCall();
  return {
    ok: true,
    divergent,
    result:
      'Written ' +
      written.length +
      ' files: ' +
      written.join(', ') +
      (blocked.length
        ? '\nBLOCKED by the anti-spam limit (do not write them again): ' +
          blocked.join(', ')
        : '')
  };
}

/* =========================================================================
 * v2.5.50 FIX 3 — `copy_file`: copiere 1:1 a unui fișier
 *
 * Când utilizatorul cere „fă pagina X exact ca pagina Y", modelul trebuia să
 * scrie tot conținutul (12 KB) prin `write_file`: pe Gemini ajungea un tool
 * call malformat, pe restul providerilor un output uriaș (split lent). Aici
 * modelul numește doar SURSA, DESTINAȚIA și (opțional) câteva înlocuiri
 * simple, iar Freekit citește fișierul și îl scrie la destinație.
 *
 * `replace` e o listă de perechi {old, new}; `old` trebuie să apară EXACT o
 * dată în fișier (potrivire tolerantă la EOL, ca `edit_file`) — altfel doar un
 * warning și se continuă cu celelalte perechi.
 * ========================================================================= */

/** Aplică înlocuirile `replace` pe conținutul copiat (tolerant la EOL). */
function applyCopyReplacements(
  content: string,
  replace: unknown,
  log: (msg: string) => void
): { content: string; applied: number; warnings: string[] } {
  const list = Array.isArray(replace) ? replace : [];
  const warnings: string[] = [];
  let out = content;
  let applied = 0;

  for (let i = 0; i < list.length; i++) {
    const r: any = list[i];
    if (
      !r ||
      typeof r.old !== 'string' ||
      typeof r.new !== 'string' ||
      !r.old.trim()
    ) {
      warnings.push(
        'replace[' + i + ']: expected {old, new} (non-empty strings) — skipped'
      );
      continue;
    }
    // numără aparițiile pe textul normalizat la EOL (aceeași treaptă „eol"
    // folosită de `findTolerantMatch`), ca `old` găsit de două ori să nu
    // înlocuiască orbeste doar prima apariție
    const hay = normalizeWithMap(out, {}).text;
    const needle = normalizeWithMap(r.old, {}).text;
    let count = 0;
    let at = needle ? hay.indexOf(needle) : -1;
    while (at >= 0) {
      count++;
      at = hay.indexOf(needle, at + needle.length);
    }
    if (count !== 1) {
      warnings.push(
        'replace[' +
          i +
          ']: old text found ' +
          count +
          ' time(s) — skipped (it must appear exactly once)'
      );
      continue;
    }
    const match = findTolerantMatch(out, r.old);
    if (!match) {
      warnings.push('replace[' + i + ']: old text not found — skipped');
      continue;
    }
    if (match.strategy !== 'exact') {
      log(
        '[copy] replace[' + i + ']: tolerant match (' + match.strategy + ')'
      );
    }
    out = out.slice(0, match.start) + r.new + out.slice(match.end);
    applied++;
  }

  return { content: out, applied, warnings };
}

async function copyFileTool(
  args: Record<string, any>,
  root: string,
  approve: ApprovalFn,
  log: (msg: string) => void
): Promise<ToolResult> {
  const from = typeof args.from === 'string' ? args.from.trim() : '';
  const to = typeof args.to === 'string' ? args.to.trim() : '';
  if (!from || !to) {
    return {
      ok: false,
      error:
        'copy_file: args.from and args.to are required. Expected ' +
        '{"action":"copy_file","args":{"from":"src/a.astro","to":"src/b.astro",' +
        '"replace":[{"old":"old text","new":"new text"}]}}'
    };
  }
  if (from === to) {
    return {
      ok: false,
      error: 'copy_file: args.from and args.to are the same path (' + from + ')'
    };
  }
  // ambele căi validate (workspace / allowExternalPaths) ÎNAINTE de citire
  const absFrom = safePath(from, root);
  safePath(to, root);

  let source: string;
  try {
    source = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.file(absFrom))
    ).toString('utf8');
  } catch (e: any) {
    logLine('tool', 'copy_file failed: cannot read source ' + from);
    return {
      ok: false,
      error:
        'copy_file: cannot read source "' +
        from +
        '": ' +
        (e?.message ?? String(e)) +
        '. Check the path with list_files / read_file.'
    };
  }

  const replaced = applyCopyReplacements(source, args.replace, log);
  const bytes = Buffer.byteLength(replaced.content, 'utf8');
  log('[copy] ' + from + ' → ' + to + ' (' + bytes + ' bytes)');
  if (Array.isArray(args.replace)) {
    log(
      '[copy] applied ' +
        replaced.applied +
        ' replacement' +
        (replaced.applied === 1 ? '' : 's')
    );
  }
  for (const w of replaced.warnings) log('[copy] warning: ' + w);

  // anti-spam: aceeași limită ca write_file/edit_file, verificată ÎNAINTE de card
  const limitErr = checkWriteLimit(to);
  if (limitErr) return { ok: false, error: limitErr };

  const oldInfo = await tryReadInfo(to, root);
  const diff = makeDiff(to, oldInfo.content, replaced.content);
  const changes: FileChangePreview[] = [
    {
      label: to,
      oldContent: oldInfo.content,
      newContent: replaced.content,
      isNew: !oldInfo.exists
    }
  ];
  if (!(await approve('copy_file', to, diff, changes))) {
    return { ok: false, error: 'User rejected' };
  }

  const res = await writeFile(to, replaced.content, root);
  if (!res.ok) return res;
  recordWrite(to);
  recordWriteCall();

  const parts = [
    'Copied ' +
      from +
      ' → ' +
      to +
      ' (' +
      bytes +
      ' bytes' +
      (Array.isArray(args.replace)
        ? ', ' +
          replaced.applied +
          ' replacement' +
          (replaced.applied === 1 ? '' : 's') +
          ' applied'
        : '') +
      ')'
  ];
  if (replaced.warnings.length) {
    parts.push('WARNINGS:\n- ' + replaced.warnings.join('\n- '));
  }
  return { ok: true, result: parts.join('\n') };
}

/* =========================================================================
 * v2.5.51 FIX 1/2 — `screenshot` și `compare_visual`
 * Capturile merg în `docs/screenshots/`; comparația vizuală e trimisă unui
 * provider cu vision (FIX 3 — comutarea o face puntea din chatView).
 * ========================================================================= */

/** `viewport` / `full_page` / `description` vin din args-ul modelului, deci validăm strict. */
function screenshotOptionsFrom(args: any): ScreenshotOptions {
  const vp = args?.viewport;
  const viewport =
    vp && Number(vp.width) > 0 && Number(vp.height) > 0
      ? { width: Number(vp.width), height: Number(vp.height) }
      : undefined;
  const description = args?.description ?? args?.element;
  return {
    // v2.5.54 (FIX 9): full_page implicit TRUE — doar `false` explicit capturează viewport-ul
    fullPage: !(args?.full_page === false || args?.fullPage === false),
    viewport,
    selector: typeof args?.selector === 'string' && args.selector ? args.selector : undefined,
    description:
      typeof description === 'string' && description ? description : undefined
  };
}

/** v2.5.54 (FIX 12): cum se deschide rezultatul unei capturi. */
type ScreenshotOpenMode = 'preview' | 'beside' | 'none';

function screenshotOpenMode(): ScreenshotOpenMode {
  const raw = vscode.workspace
    .getConfiguration('freekit')
    .get<string>('screenshotOpenMode', 'preview');
  return raw === 'beside' || raw === 'none' ? raw : 'preview';
}

export interface VisualArtifact {
  absPath: string;
  relPath: string;
  label: string;
}

/** Dimensiunea maximă a unui thumbnail trimis în webview (base64 ~1.33×). */
const MAX_THUMB_BYTES = 1_500_000;

/**
 * v2.5.54 (FIX 11/12/13) — UX după o captură:
 *  1) FIX 12: deschide rezultatul în VS Code (`freekit.screenshotOpenMode`:
 *     preview / beside / none), respectiv side-by-side la `compare_visual`;
 *  2) FIX 11: readu Chrome în fundal (fereastra nu mai rămâne în față);
 *  3) FIX 13: trimite thumbnail-urile (base64) în chat.
 */
async function revealVisualResult(
  items: VisualArtifact[],
  tag: 'screenshot' | 'compare',
  visual: VisualToolContext | undefined
): Promise<void> {
  const mode = screenshotOpenMode();
  if (mode !== 'none' && items.length) {
    if (tag === 'compare' && items.length > 1) {
      await openVisualFile(items[0].absPath, undefined, tag);
      await openVisualFile(items[1].absPath, vscode.ViewColumn.Beside, tag);
      logLine('compare', 'opened side by side');
    } else {
      await openVisualFile(
        items[0].absPath,
        mode === 'beside' ? vscode.ViewColumn.Beside : undefined,
        tag
      );
    }
  }

  if (visual) {
    await visual.browser.hideOffscreen().catch(() => undefined);
    logLine(tag, 'browser hidden after capture');
  }

  if (visual?.thumbnails) {
    const thumbs = items
      .map((item) => {
        try {
          const buffer = fs.readFileSync(item.absPath);
          if (buffer.length > MAX_THUMB_BYTES) return undefined;
          return {
            label: item.label,
            relPath: item.relPath,
            dataUri: 'data:image/png;base64,' + buffer.toString('base64')
          };
        } catch {
          return undefined;
        }
      })
      .filter((t): t is { label: string; relPath: string; dataUri: string } => !!t);
    if (thumbs.length) {
      visual.thumbnails(thumbs);
      logLine(tag, 'thumbnails rendered in chat');
    }
  }
}

/** Deschide un fișier în editor (preview), opțional într-o coloană anume. */
async function openVisualFile(
  absPath: string,
  column: vscode.ViewColumn | undefined,
  tag: string
): Promise<void> {
  try {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath), {
      preview: true,
      ...(column !== undefined ? { viewColumn: column } : {})
    });
    logLine(tag, 'opened in VS Code preview — ' + path.basename(absPath));
  } catch (e: any) {
    logLine(tag, 'could not open the file in the editor: ' + (e?.message ?? String(e)));
  }
}

function visualUnavailable(tool: string): ToolResult {
  return {
    ok: false,
    error:
      tool +
      ' is unavailable here (no browser context). Run it from the chat, not from direct-write mode.'
  };
}

async function screenshotTool(
  args: any,
  root: string,
  visual: VisualToolContext | undefined,
  log: (msg: string) => void
): Promise<ToolResult> {
  if (!visual) return visualUnavailable('screenshot');
  const raw = String(args?.url ?? args?.path ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      error:
        'screenshot: args.url is required. Expected ' +
        '{"action":"screenshot","args":{"url":"http://localhost:4321/","description":"the CTA button"}} ' +
        '(full_page defaults to true)'
    };
  }
  try {
    const url = toTargetUrl(raw, root);
    const shot = await captureScreenshot(
      visual.browser,
      url,
      root,
      screenshotOptionsFrom(args)
    );
    const kb = Math.max(1, Math.round(shot.bytes / 1024));
    log('screenshot saved: ' + shot.relPath);
    // v2.5.54 (FIX 11/12/13): deschide PNG-ul + readu Chrome în fundal + thumbnail
    await revealVisualResult(
      [{ absPath: shot.absPath, relPath: shot.relPath, label: 'screenshot' }],
      'screenshot',
      visual
    );
    return {
      ok: true,
      result:
        'Screenshot saved to ' +
        shot.relPath +
        ' (' +
        shot.width +
        'x' +
        shot.height +
        ', ' +
        kb +
        ' KB) for ' +
        url +
        (shot.element
          ? ' — element: ' + shot.element + (shot.selector ? ' → ' + shot.selector : '')
          : ' — full page'),
      userNotice:
        '📸 Screenshot: ' + shot.relPath + (shot.element ? ' (' + shot.selector + ')' : '')
    };
  } catch (e: any) {
    return { ok: false, error: 'screenshot failed: ' + (e?.message ?? String(e)) };
  }
}

async function compareVisualTool(
  args: any,
  root: string,
  visual: VisualToolContext | undefined,
  log: (msg: string) => void
): Promise<ToolResult> {
  if (!visual) return visualUnavailable('compare_visual');
  const url1 = String(args?.url1 ?? '').trim();
  const url2 = String(args?.url2 ?? '').trim();
  if (!url1 || !url2) {
    return {
      ok: false,
      error:
        'compare_visual: args.url1 and args.url2 are required. Expected ' +
        '{"action":"compare_visual","args":{"url1":"https://example.com/page/","url2":"http://localhost:4321/page/"}}'
    };
  }
  try {
    const target1 = toTargetUrl(url1, root);
    const target2 = toTargetUrl(url2, root);
    const res = await compareVisual(visual, root, target1, target2, {
      // v2.5.54: implicit FULL page (ca la screenshot)
      fullPage: !(args?.full_page === false || args?.fullPage === false),
      provider: typeof args?.provider === 'string' ? args.provider : undefined
    });
    log('compare saved: ' + res.relPath + ' (' + res.differences + ' differences)');
    // v2.5.54 (FIX 13): side-by-side în VS Code + thumbnail-uri în chat + Chrome în fundal
    await revealVisualResult(
      [
        { absPath: res.original.absPath, relPath: res.original.relPath, label: 'original' },
        { absPath: res.replica.absPath, relPath: res.replica.relPath, label: 'replica' }
      ],
      'compare',
      visual
    );
    return {
      ok: true,
      result:
        'Visual comparison (' +
        res.provider +
        ') found ' +
        res.differences +
        ' differences. Screenshots: ' +
        res.original.relPath +
        ', ' +
        res.replica.relPath +
        '. Report: ' +
        res.relPath +
        '\n\n' +
        res.reply,
      userNotice:
        '🔍 compare_visual: ' +
        res.differences +
        ' differences found — report: ' +
        res.relPath
    };
  } catch (e: any) {
    return {
      ok: false,
      error: 'compare_visual failed: ' + (e?.message ?? String(e))
    };
  }
}

const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_LINE = 400;

async function searchFiles(
  pattern: string,
  root: string
): Promise<ToolResult> {
  const results: string[] = [];

  async function walk(dir: string) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(dir)
      );
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (
        name === 'node_modules' ||
        name === '.git' ||
        name === 'out' ||
        name === '.vscode'
      ) {
        continue;
      }

      const full = path.join(dir, name);

      if (type === vscode.FileType.File) {
        try {
          const content = Buffer.from(
            await vscode.workspace.fs.readFile(vscode.Uri.file(full))
          ).toString('utf8');
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (line.includes(pattern)) {
              results.push(
                path.relative(root, full) +
                  ':' +
                  (i + 1) +
                  ': ' +
                  // v2.5.23: o linie minificată poate avea 100k+ caractere
                  line.trim().slice(0, MAX_SEARCH_LINE)
              );
            }
          });
        } catch {
          /* skip binary */
        }
      } else if (type === vscode.FileType.Directory) {
        await walk(full);
      }

      if (results.length > 200) return;
    }
  }

  await walk(root);

  // v2.5.23: buget de payload pe rezultatul căutării (cap+coadă).
  return {
    ok: true,
    result:
      clipPayload(
        results.slice(0, MAX_SEARCH_MATCHES).join('\n'),
        MAX_CHARS_TOTAL
      ) || '(no matches)'
  };
}

/* =========================================================================
 * FAZA II (C) — operații git
 * Citire (status/diff/log) = fără aprobare; scriere (commit/branch/revert/
 * restore) = cu aprobarea utilizatorului. Fără shell — argumente separate.
 * ========================================================================= */

const GIT_HASH_RE = /^[0-9a-f]{4,40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;

async function gitTool(
  args: Record<string, any>,
  root: string,
  approve: ApprovalFn,
  log: (msg: string) => void
): Promise<ToolResult> {
  const action = String(args.action || 'status').toLowerCase();
  const run = (cmdArgs: string[], timeoutMs = 60000) =>
    runProgram('git', cmdArgs, { cwd: root, timeoutMs });
  const rejected: ToolResult = { ok: false, error: 'User rejected' };

  switch (action) {
    case 'status': {
      const r = await run([
        'status',
        '--porcelain=v1',
        '-b',
        '--untracked-files=all'
      ]);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      // v2.5.23: buget de payload și pe git (status/diff/log pot fi uriașe)
      return {
        ok: true,
        result: clipPayload(
          'git status:\n' + (r.output.trim() || '(clean)'),
          MAX_CHARS_TOTAL
        )
      };
    }

    case 'diff': {
      const cmdArgs = ['diff', '--no-color'];
      if (args.staged) cmdArgs.push('--cached');
      if (args.path) {
        safePath(String(args.path), root); // validare în workspace
        cmdArgs.push('--', String(args.path).replace(/\\/g, '/'));
      }
      const r = await run(cmdArgs);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      return {
        ok: true,
        result: clipPayload(r.output.trim() || '(no changes)', MAX_CHARS_TOTAL)
      };
    }

    case 'log': {
      const n = Math.min(
        Math.max(parseInt(String(args.n ?? '20'), 10) || 20, 1),
        100
      );
      const r = await run(['log', '--oneline', '--no-color', '-n', String(n)]);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      return {
        ok: true,
        result: clipPayload(r.output.trim() || '(no commits)', MAX_CHARS_TOTAL)
      };
    }

    case 'commit': {
      const message = String(args.message ?? '').trim();
      if (!message) {
        return { ok: false, error: 'git commit: args.message is missing' };
      }
      const addAll = args.add === true;
      const approved = await approve(
        'git',
        'commit: ' + message,
        'git commit -m "' +
          message +
          '"' +
          (addAll ? '\n(with git add -A first)' : '')
      );
      if (!approved) return rejected;
      if (addAll) {
        const add = await run(['add', '-A']);
        if (!add.ok) {
          return { ok: false, error: 'git add -A failed:\n' + add.output };
        }
      }
      const r = await run(['commit', '-m', message]);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      return { ok: true, result: r.output.trim() };
    }

    case 'branch': {
      const name = String(args.name ?? '').trim();
      if (name) {
        if (!BRANCH_RE.test(name)) {
          return { ok: false, error: 'Invalid branch name: ' + name };
        }
        const approved = await approve(
          'git',
          'branch: ' + name,
          'git checkout -b ' + name
        );
        if (!approved) return rejected;
        let r = await run(['checkout', '-b', name]);
        if (!r.ok && /already exists/i.test(r.output)) {
          r = await run(['checkout', name]);
        }
        if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
        return { ok: true, result: r.output.trim() };
      }
      const cur = await run(['branch', '--show-current']);
      const list = await run(['branch', '--list', '-vv']);
      return {
        ok: true,
        result: clipPayload(
          'current: ' +
            (cur.output.trim() || '?') +
            '\n' +
            (list.output.trim() || '(no branches)'),
          MAX_CHARS_TOTAL
        )
      };
    }

    case 'revert': {
      const commit = String(args.commit ?? '').trim();
      if (!GIT_HASH_RE.test(commit)) {
        return {
          ok: false,
          error:
            'git revert: args.commit must be a hash (4-40 hex characters)'
        };
      }
      const approved = await approve(
        'git',
        'revert ' + commit,
        'git revert --no-edit ' +
          commit +
          '\n(creates a new commit that reverts ' +
          commit +
          ')'
      );
      if (!approved) return rejected;
      const r = await run(['revert', '--no-edit', commit]);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      return { ok: true, result: r.output.trim() };
    }

    case 'restore': {
      const rel = String(args.path ?? '').trim();
      if (!rel) {
        return { ok: false, error: 'git restore: args.path is missing' };
      }
      const abs = safePath(rel, root);
      const approved = await approve(
        'git',
        'restore ' + rel,
        'git checkout -- ' +
          rel +
          '\n(WARNING: discards the local changes in the file)'
      );
      if (!approved) return rejected;
      const r = await run([
        'checkout',
        '--',
        path.relative(root, abs).replace(/\\/g, '/')
      ]);
      if (!r.ok) return { ok: false, error: clipPayload(r.output, MAX_CHARS_TOTAL) };
      return { ok: true, result: 'Restored: ' + rel };
    }

    default:
      return {
        ok: false,
        error:
          'git: unknown action "' +
          action +
          '". Use: status, diff, log, commit, branch, revert, restore.'
      };
  }
}