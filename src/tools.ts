import * as vscode from 'vscode';
import * as path from 'path';
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
import { RESTRICTED_TOOL_ERROR } from './trust';

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
  note?: string
): ToolResult {
  const seconds = (res.duration / 1000).toFixed(1);
  const attemptTag = 'attempt ' + attempt + '/' + MAX_COMMAND_ATTEMPTS;

  if (res.ok) {
    const note = attempt > 1 ? ' — ✓ fixed after ' + attempt + ' attempts' : '';
    return {
      ok: true,
      result: (
        '✓ ' + toolLabel + ': ' + command + ' (exit 0, ' + seconds + 's' + note + ')\n' +
        res.combined
      ).slice(0, 20000),
      commandRun: {
        command,
        attempt,
        max: MAX_COMMAND_ATTEMPTS,
        exitCode: 0,
        duration: res.duration,
        final: false
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

  const parts: string[] = [];
  if (res.stdout.trim()) {
    parts.push('--- STDOUT ---\n' + res.stdout.trim().slice(0, 12000));
  }
  if (res.stderr.trim()) {
    parts.push('--- STDERR ---\n' + res.stderr.trim().slice(0, 12000));
  }
  if (!parts.length) {
    parts.push((res.combined.trim() || '(no output)').slice(0, 12000));
  }

  return {
    ok: false,
    error: (
      '✗ ' + toolLabel + ': ' + command + '\n' +
      'COMMAND FAILED — exit ' + res.exitCode +
      (res.exitCode === 124 ? ' [TIMEOUT — the process was stopped]' : '') +
      ', ' + seconds + 's (' + attemptTag + ')\n\n' +
      (note ? note + '\n\n' : '') +
      directive + '\n\n' + parts.join('\n\n')
    ).slice(0, 24000),
    commandRun: {
      command,
      attempt,
      max: MAX_COMMAND_ATTEMPTS,
      exitCode: res.exitCode,
      duration: res.duration,
      final
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
}

export type ApprovalFn = (
  tool: string,
  path: string,
  diff: string,
  /** v0.5.0: preview per fișier pentru diff-ul nativ (opțional). */
  changes?: FileChangePreview[]
) => Promise<boolean>;

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
}

function recordWriteCall(): void {
  writeOpsTotal++;
}

/* =========================================================================
 * v1.1.2 — SYSTEM_PROMPT rescris (tool calls forțate)
 * AI-ul e obligat să răspundă la orice cerere de ACȚIUNE cu un SINGUR tool
 * call JSON pe o linie („NO introductions, NO explanations, ONLY JSON"), cu
 * exemple concrete de workflow. PROJECT INFO / PROJECT STRUCTURE se
 * injectează prin placeholder-ele {PROJECT_INFO} / {PROJECT_STRUCTURE}.
 * ========================================================================= */

export const SYSTEM_PROMPT = `You are an autonomous coding agent in VS Code.

## CRITICAL RULE
When the user asks you to DO something (change, fix, search, create, delete,
modify, add, remove, rename, update, find, etc.), you MUST respond with a
TOOL CALL JSON on a SINGLE LINE. NO introductions. NO explanations. ONLY JSON.

Your FIRST response to any action request is ALWAYS a tool call.

## TOOL CALL FORMAT (STRICT)
{"tool": "TOOL_NAME", "args": {...}}

## WRITING FILES — MARKER FORMAT (MANDATORY)
When creating or modifying files, ALWAYS use the marker format
(do NOT wrap content in JSON strings):

TOOL: write_file
PATH: <relative path>
CONTENT:
<raw file content, no escaping needed>
END_CONTENT

TOOL: edit_file
PATH: <relative path>
OLD_TEXT:
<exact old text>
END_OLD_TEXT
NEW_TEXT:
<new text>
END_NEW_TEXT

TOOL: write_files
---FILE---
PATH: <relative path>
CONTENT:
<raw file content>
END_CONTENT
---FILE---
PATH: <another relative path>
CONTENT:
<raw file content>
END_CONTENT

Each marker (TOOL:, PATH:, CONTENT:, END_CONTENT, ...) sits ALONE on its line.
The text between the markers is RAW: quotes, braces, backslashes, emoji and
newlines are written EXACTLY as they must appear in the file — never escaped,
never truncated, never JSON-quoted.

For ALL OTHER tools (read_file, read_files, list_files, search_files,
search_semantic, run_command, run_npm, git_*, project_info, open_workspace),
use the JSON format:
{"tool":"NAME","args":{...}}

## Available tools:
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
10. write_files(files) - batch write (one approval)
11. project_info() - detected project info
12. search_semantic(query) - semantic code search (if indexed)
13. open_workspace(path) - open folder in new window

## WORKFLOW EXAMPLES

USER: "change the title from X to Y"
YOU: {"tool": "search_files", "args": {"pattern": "X"}}
(after result, you know which files contain X)
YOU: {"tool": "read_file", "args": {"path": "src/file.ts"}}
(after result, you see the exact text)
YOU: TOOL: edit_file
PATH: src/file.ts
OLD_TEXT:
X
END_OLD_TEXT
NEW_TEXT:
Y
END_NEW_TEXT

USER: "create a file named foo.ts"
YOU: TOOL: write_file
PATH: foo.ts
CONTENT:
...
END_CONTENT

USER: "add a comment at the beginning of the main.js file"
YOU: {"tool": "read_file", "args": {"path": "main.js"}}
YOU: TOOL: edit_file
PATH: main.js
OLD_TEXT:
first line
END_OLD_TEXT
NEW_TEXT:
// comment
first line
END_NEW_TEXT

USER: "run the tests"
YOU: {"tool": "run_npm", "args": {"action": "script", "script": "test"}}

## STRICT RULES
- Your first response to an action request is ALWAYS a tool call (marker format for file writes, JSON otherwise).
- NEVER write "Analyzing...", "Let me...", "I'll...", "I will..." before a tool call.
- NEVER explain what you're going to do. JUST DO IT.
- ONE tool call per message.
- JSON tool calls: a SINGLE LINE, no markdown fences. The marker blocks for write_file / edit_file / write_files are multi-line, exactly as shown above.
- Args ALWAYS an object (use {} if empty).
- Paths relative to workspace root.
- When the task is complete, respond with PLAIN TEXT (not JSON).
- After every edit_file / write_file / write_files the system AUTO-VERIFIES the project (astro check / tsc / build). If you receive "VERIFICATION FAILED", fix the ROOT CAUSE — you get max 3 auto-repair attempts; if it still fails, your changes are ROLLED BACK automatically. Never claim success while a verification is failing.
- Long-running commands (dev / start / serve / watch / preview — e.g. "npm run dev", "vite", "nodemon") start the server in a VISIBLE VS Code terminal automatically (the user watches the live output there): you receive "✅ Server started in the VS Code TERMINAL …" + the live URL + the first seconds of output IMMEDIATELY. NEVER wait for such a command and NEVER re-run it; the server keeps running until stopped (Ctrl+C in its terminal or the command "Freekit: Stop Dev Servers"). If the early output shows a startup error (port in use, syntax error) — or you are told the process exited — fix the root cause and re-run the command once.

## WHEN TO USE PLAIN TEXT (no tool)
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
10. write_files(files) — array of {"path": "...", "content": "..."}; ONE call for ALL files
11. project_info()
12. search_semantic(query) — find code by MEANING (e.g. "where do we validate login"); works only if the workspace was indexed (command "Freekit: Index Workspace")

For git you may also use the short names "git_status", "git_diff", "git_log", "git_commit", "git_branch", "git_revert".

CRITICAL WRITE RULES (the system REJECTS violations with an error):
- Write each file ONLY ONCE. First compose the COMPLETE final content, then call write_file ONE time.
- NEVER write the same file twice to "add" something. NEVER append functions one by one.
- Example: "write a Python function that adds 2 numbers" → ONE write_file call with the complete script, then STOP. Do NOT also add subtract/multiply/divide unless the user asked.
- Write ONLY what the user asked for. No extra functions, files, tests or docs.
- Several files → ONE write_files call with all of them.
- Hard limits: max 3 writes per file, max 15 write operations per message. If you get an ANTI-SPAM error, do NOT retry — reply with plain text instead.
- Dev/start/serve/watch commands (npm run dev, npm start, vite, nodemon, ...) run in a VISIBLE VS Code terminal: you get "✅ Server started in the VS Code TERMINAL …" + the first seconds of output immediately. Do NOT wait for them, do NOT re-run them; if the first seconds show an error — or the process exited — fix it and re-run once.
- If run_command / run_npm fails: read the FULL error, fix the code, re-run the SAME command (max 5 tries; after that it is blocked and you must reply with text).
- After every write the system RE-CHECKS the project: if you receive "VERIFICATION FAILED", fix the reported error (max 3 repair attempts — then ALL changes are rolled back automatically). Never claim success while a verification is failing.
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

/** Nudge trimis modelului când răspunsul nu conține niciun tool call valid. */
export const TEXT_RETRY_NUDGE = `SYSTEM NOTICE — NO TOOL CALL DETECTED.

Your previous reply contained NO valid tool call (plain text description and/or invalid JSON).
The task is NOT complete yet. Do NOT describe what you will do — DO it.

Reply NOW with EXACTLY ONE tool call, as a SINGLE-LINE JSON object, and nothing else:
{"tool": "NAME", "args": {...}}

Examples:
{"tool": "search_files", "args": {"pattern": "text to find"}}
{"tool": "read_file", "args": {"path": "src/index.ts"}}
{"tool": "edit_file", "args": {"path": "src/index.ts", "old_text": "old text", "new_text": "new text"}}

Rules: NO markdown fences, args ALWAYS an object (use {} if empty), one line only.
Only if the task is already FULLY complete (or the user only asked a question), reply with your final plain-text answer instead.`;

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
  if (/\{\s*["']tool["']\s*:/.test(text)) return true;
  const head = text.slice(0, 240);
  if (RETRY_EXPLAIN_RE.test(head)) return false;
  return RETRY_INTENT_RE.test(head);
}

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
  approve: ApprovalFn
): Promise<ToolResult> {
  log('executing tool: ' + call.tool);
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
        return await readFile(call.args.path, workspaceRoot);

      case 'write_file': {
        // v0.2.1: anti-spam — verificăm ÎNAINTE de cardul de aprobare
        const limitErr = checkWriteLimit(call.args.path);
        if (limitErr) return { ok: false, error: limitErr };
        // v0.5.0: preview pentru diff-ul nativ (conținut vechi + nou)
        const oldInfo = await tryReadInfo(call.args.path, workspaceRoot);
        const newContent = call.args.content as string;
        const diff = makeDiff(call.args.path, oldInfo.content, newContent);
        const changes: FileChangePreview[] = [
          {
            label: call.args.path,
            oldContent: oldInfo.content,
            newContent,
            isNew: !oldInfo.exists
          }
        ];
        if (!(await approve('write_file', call.args.path, diff, changes))) {
          return { ok: false, error: 'User rejected' };
        }
        const res = await writeFile(call.args.path, newContent, workspaceRoot);
        if (res.ok) {
          recordWrite(call.args.path);
          recordWriteCall();
        }
        return res;
      }

      case 'edit_file': {
        // v0.2.1: anti-spam — și editările contează ca scriere
        const limitErr = checkWriteLimit(call.args.path);
        if (limitErr) return { ok: false, error: limitErr };
        const oldContent = (
          await tryReadInfo(call.args.path, workspaceRoot)
        ).content;
        if (!oldContent.includes(call.args.old_text)) {
          return {
            ok: false,
            error: 'old_text not found in ' + call.args.path
          };
        }
        const updated = oldContent.replace(
          call.args.old_text,
          call.args.new_text
        );
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
        if (isCommandBlocked(normCommandKey(call.args.command))) {
          return blockedCommandResult(call.args.command);
        }
        // v1.8.1: comenzile long-running (dev/serve/start/watch) pornesc
        // vizibil, într-un terminal VS Code dedicat (nu mai rămân invizibile)
        const lrNote = isLongRunningCommand(call.args.command)
          ? '\n(long-running command — development server: starts in a VISIBLE VS Code TERMINAL; you immediately get the URL + the first seconds of output)'
          : '';
        if (
          !(await approve(
            'run_command',
            call.args.command,
            call.args.command + lrNote
          ))
        ) {
          return { ok: false, error: 'User rejected' };
        }
        return await runCommand(call.args.command);
      }

      case 'search_files':
        return await searchFiles(call.args.pattern, workspaceRoot);

      case 'run_npm':
        return await runNpmTool(call.args, workspaceRoot, approve, log);

      case 'git':
        return await gitTool(call.args, workspaceRoot, approve, log);

      case 'read_files':
        return await readFilesBatch(call.args, workspaceRoot);

      case 'write_files':
        return await writeFilesBatch(call.args, workspaceRoot, approve);

      case 'project_info':
        return await projectInfoTool(workspaceRoot);

      case 'search_semantic':
        return await searchSemanticTool(call.args?.query, workspaceRoot);

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

function safePath(rel: string, root: string): string {
  const abs = path.resolve(root, rel);
  const normalized = path.normalize(abs);
  if (!normalized.startsWith(path.normalize(root))) {
    throw new Error('Path outside workspace: ' + rel);
  }
  return normalized;
}

async function readFile(rel: string, root: string): Promise<ToolResult> {
  const abs = safePath(rel, root);
  const content = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
  const text = Buffer.from(content).toString('utf8');
  const MAX = 8000;
  const truncated =
    text.length > MAX
      ? text.slice(0, MAX) +
        '\n\n[...truncat, ' +
        (text.length - MAX) +
        ' caractere omise...]'
      : text;
  return { ok: true, result: truncated };
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

  if (!content.includes(oldText)) {
    return { ok: false, error: 'old_text not found in ' + rel };
  }

  const updated = content.replace(oldText, newText);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(abs),
    Buffer.from(updated, 'utf8')
  );
  return { ok: true, result: 'Edited ' + rel };
}

async function listFiles(rel: string, root: string): Promise<ToolResult> {
  const abs = safePath(rel, root);
  const entries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(abs)
  );
  const out = entries
    .map(([name, type]) =>
      type === vscode.FileType.Directory ? name + '/' : name
    )
    .join('\n');
  return { ok: true, result: out || '(empty dir)' };
}

async function runCommand(command: string): Promise<ToolResult> {
  // v0.6.0: fiecare rulare a unei comenzi consumă o încercare de auto-reparare
  const key = normCommandKey(command);
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
      attempt
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
      attempt
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
    return { ok: false, error: text };
  }
  return { ok: true, result: text };
}

/* =========================================================================
 * FAZA II (D) — multi-fișier: un singur approval pentru mai multe fișiere
 * ========================================================================= */

const MAX_BATCH_WRITE_FILES = 20;
const MAX_BATCH_READ_FILES = 12;
const READ_PER_FILE = 6000;
const READ_TOTAL = 40000;

async function readFilesBatch(
  args: Record<string, any>,
  root: string
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
  for (const rel of limited) {
    try {
      const abs = safePath(rel, root);
      const content = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(abs))
      ).toString('utf8');
      const clipped =
        content.length > READ_PER_FILE
          ? content.slice(0, READ_PER_FILE) +
            '\n[...truncated, ' +
            (content.length - READ_PER_FILE) +
            ' characters omitted...]'
          : content;
      sections.push('--- FILE: ' + rel + ' ---\n' + clipped);
    } catch (e: any) {
      sections.push(
        '--- FILE: ' + rel + ' ---\n(error: ' + (e?.message ?? String(e)) + ')'
      );
    }
  }

  let out = sections.join('\n\n');
  if (out.length > READ_TOTAL) {
    out = out.slice(0, READ_TOTAL) + '\n[...truncated...]';
  }
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
  approve: ApprovalFn
): Promise<ToolResult> {
  const raw = Array.isArray(args.files) ? args.files : [];
  const files = raw.filter(
    (f: any) =>
      f && typeof f.path === 'string' && typeof f.content === 'string'
  ) as Array<{ path: string; content: string }>;

  if (!files.length) {
    return {
      ok: false,
      error: 'write_files: args.files is missing (array of {"path","content"})'
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
      isNew: !oldInfo.exists
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

  if (!(await approve('write_files', summary, diff, changes))) {
    return { ok: false, error: 'User rejected' };
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
                  line.trim()
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

  return {
    ok: true,
    result:
      results.slice(0, 100).join('\n').slice(0, 6000) || '(no matches)'
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
      if (!r.ok) return { ok: false, error: r.output };
      return {
        ok: true,
        result: 'git status:\n' + (r.output.trim() || '(clean)')
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
      if (!r.ok) return { ok: false, error: r.output };
      return { ok: true, result: r.output.trim() || '(no changes)' };
    }

    case 'log': {
      const n = Math.min(
        Math.max(parseInt(String(args.n ?? '20'), 10) || 20, 1),
        100
      );
      const r = await run(['log', '--oneline', '--no-color', '-n', String(n)]);
      if (!r.ok) return { ok: false, error: r.output };
      return { ok: true, result: r.output.trim() || '(no commits)' };
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
      if (!r.ok) return { ok: false, error: r.output };
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
        if (!r.ok) return { ok: false, error: r.output };
        return { ok: true, result: r.output.trim() };
      }
      const cur = await run(['branch', '--show-current']);
      const list = await run(['branch', '--list', '-vv']);
      return {
        ok: true,
        result:
          'current: ' +
          (cur.output.trim() || '?') +
          '\n' +
          (list.output.trim() || '(no branches)')
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
      if (!r.ok) return { ok: false, error: r.output };
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
      if (!r.ok) return { ok: false, error: r.output };
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