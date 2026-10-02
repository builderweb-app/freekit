import type * as vscode from 'vscode';
import * as path from 'path';
import { logLine } from './log';

/* =========================================================================
 * v1.8.1 — COMENZI LONG-RUNNING (dev/serve/watch) → TERMINAL VS CODE VIZIBIL
 * Până acum `npm run dev` / `npm start` / `vite` / `nodemon` etc. porneau
 * DETAȘAT, în fundal: AI-ul nu se bloca, dar utilizatorul NU vedea nimic —
 * nici compile, nici erori, nici când serverul e gata.
 *
 * Acum fiecare comandă long-running pornește într-un TERMINAL VS Code
 * dedicat, VIZIBIL (panoul de jos):
 *   1. utilizatorul vede output-ul live (compile, warnings, erori);
 *   2. poate apăsa Ctrl+C în acel terminal să oprească serverul (normal);
 *   3. output-ul e capturat live — primele secunde (URL-ul + erorile rapide
 *      de pornire: port ocupat, syntax error) ajung la AI;
 *   4. serverul rămâne pornit după ce AI-ul termină; oprirea se face din
 *      terminal (Ctrl+C) sau cu comanda „Freekit: Stop Dev Servers”.
 *
 * CAPTURA folosește Shell Integration (API STABIL, VS Code ≥ 1.93):
 * `terminal.shellIntegration.executeCommand()` + `execution.read()`.
 * (`onDidWriteTerminalData` e încă un API PROPOSED — pentru extensiile
 * instalate din VSIX e filtrat la runtime și rămâne `undefined` dacă VS Code
 * nu e pornit cu `--enable-proposed-api`, deci nu poate susține captura.)
 * Fără shell integration comanda pornește la fel de vizibil (`sendText`), dar
 * fără captură — rezultatul îi spune explicit AI-ului acest lucru.
 * ========================================================================= */

export const LONG_RUNNING_SCRIPTS = new Set([
  'dev', 'start', 'serve', 'watch', 'preview', 'storybook',
  'develop', 'nodemon', 'hot', 'live', 'start:dev', 'dev:server'
]);

export const LONG_RUNNING_PATTERNS = [
  /\bdev\b/i,
  /\bserve\b/i,
  /\bstart\b/i,
  /\bwatch\b/i,
  /\bpreview\b/i
];

/** true dacă numele unui script (npm) e long-running: dev, start, serve, watch... */
export function isLongRunningScript(script: string): boolean {
  if (!script) return false;
  const normalized = script.toLowerCase().trim();
  if (LONG_RUNNING_SCRIPTS.has(normalized)) return true;
  return LONG_RUNNING_PATTERNS.some((p) => p.test(normalized));
}

/* -------------------------------------------------------------------------
 * Detectare la nivel de COMANDĂ (pentru run_command): npm/pnpm/yarn/bun
 * [run] <script>, lanțuri (`cd app && npm run dev`), npx + binare cunoscute
 * de dev server (vite, nodemon, next, astro, ng, uvicorn, ...).
 * ------------------------------------------------------------------------- */

const ALWAYS_LONG_BINS = new Set([
  'nodemon', 'http-server', 'live-server', 'json-server',
  'webpack-dev-server', 'gunicorn', 'uvicorn', 'serve'
]);

const CONDITIONAL_LONG_BINS = new Set([
  'vite', 'next', 'astro', 'nuxt', 'ng', 'svelte-kit', 'parcel', 'expo',
  'gatsby', 'flask', 'hugo', 'mkdocs', 'storybook', 'electron', 'webpack',
  'wrangler', 'vite-node', 'tsc', 'sass', 'less'
]);

// binare care, fără subcomandă, PORNESC DIRECT un server (vite, parcel, ...)
const BARE_LONG_BINS = new Set([
  'vite', 'parcel', 'gatsby', 'expo', 'nuxt', 'electron', 'storybook'
]);

// subcomenzi care se termină singure (nu trebuie detașate)
const ONE_SHOT_SUBCOMMANDS = new Set([
  'build', 'export', 'generate', 'check', 'lint', 'test', 'inspect',
  'optimize', 'deploy', 'publish', 'create', 'init', 'add', 'version'
]);

const DEV_ARGS_RE =
  /(^|\s)(dev|serve|server|watch|preview|start|hot|live|runserver)(\s|$)/i;

function analyzeSegment(rawSegment: string): boolean {
  const segment = rawSegment.trim();
  if (!segment) return false;
  const tokens = segment.split(/\s+/);

  // sărim peste wrapper-uri uzuale: sudo / npx / pnpx / bunx (+ flagurile lor)
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i].toLowerCase().replace(/\.(cmd|exe)$/, '');
    if (t === 'sudo' || t === 'npx' || t === 'pnpx' || t === 'bunx') {
      i++;
      continue;
    }
    break;
  }
  while (i < tokens.length && tokens[i].startsWith('-')) i++;
  if (i >= tokens.length) return false;

  const bin = tokens[i]
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(cmd|exe)$/, '');
  const rest = tokens.slice(i + 1);
  const restStr = rest.join(' ');

  // 1) npm / pnpm / yarn / bun [run] <script> — verificăm numele scriptului
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'bun') {
    const j = (rest[0] ?? '').toLowerCase() === 'run' ? 1 : 0;
    const script = (rest[j] ?? '').replace(/^["']+|["']+$/g, '');
    if (script && isLongRunningScript(script)) return true;
    // mod continuu cerut prin flaguri: npm run build -- --watch
    return (
      /--watch\b/i.test(segment) ||
      LONG_RUNNING_PATTERNS.some((p) => p.test(segment))
    );
  }

  // 2) binare cunoscute de servere de dezvoltare (vite, nodemon, next, ...)
  if (ALWAYS_LONG_BINS.has(bin)) return true;
  if (CONDITIONAL_LONG_BINS.has(bin)) {
    const positionals = rest.filter((t) => !t.startsWith('-'));
    // flask run (inclusiv „flask --app x run”)
    if (bin === 'flask' && positionals.includes('run')) return true;
    if (positionals.some((t) => ONE_SHOT_SUBCOMMANDS.has(t.toLowerCase()))) {
      return false; // ex. vite build / next build / wrangler deploy
    }
    if (BARE_LONG_BINS.has(bin)) return true; // ex. vite / vite --host
    return DEV_ARGS_RE.test(restStr) || /--watch\b/i.test(restStr);
  }

  // 3) cazuri speciale python: manage.py runserver
  if (
    (bin === 'python' || bin === 'python3' || bin === 'py') &&
    /\brunserver\b/i.test(restStr)
  ) {
    return true;
  }

  return false;
}

/** true dacă o comandă shell (run_command) e long-running și trebuie detașată. */
export function isLongRunningCommand(command: string): boolean {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  // lanțuri: „cd app && npm run dev”, „npm install && npm run dev”, „a; b”
  const segments = cmd.split(/&&|\|\||;|\|/);
  return segments.some((s) => analyzeSegment(s));
}

/* -------------------------------------------------------------------------
 * v1.8.1 — stare per server + acces lazy la `vscode`
 * `vscode` e importat doar ca TIP și cerut lazy la runtime (același pattern
 * ca în log.ts) — `out/devServers.js` rămâne încărcabil în teste Node.
 * ------------------------------------------------------------------------- */

type VsCodeApi = typeof import('vscode');

let vscodeApi: VsCodeApi | undefined;
function getVscode(): VsCodeApi {
  if (!vscodeApi) vscodeApi = require('vscode') as VsCodeApi;
  return vscodeApi;
}

/** Grația implicită: cât se așteaptă output-ul de pornire înainte de răspuns. */
export const DEFAULT_GRACE_MS = 3000;
/** Cât se așteaptă (max) activarea shell integration în terminalul nou. */
export const SHELL_INTEGRATION_WAIT_MS = 4000;
/** Ctrl+C la oprire → cât se așteaptă ieșirea grațioasă înainte de dispose. */
export const STOP_KILL_MS = 2500;
const MAX_CAPTURE = 48 * 1024;
const MAX_RESULT_TEXT = 16000;

export interface DevServerStartResult {
  /** true = procesul încă rulează după perioada de grație (server pornit). */
  running: boolean;
  /** PID-ul shell-ului din terminal (best-effort — poate lipsi). */
  pid: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr combinate (pentru afișare / self-correction). */
  output: string;
  exitCode: number | null;
  durationMs: number;
  /** URL-uri localhost/LAN detectate în output (ex. http://localhost:4321/). */
  urls: string[];
  /** v1.8.1: numele terminalului VS Code dedicat (ex. „Freekit: dev”). */
  terminalName: string;
  /** v1.8.1: true = output-ul a fost capturat live (shell integration activă). */
  captured: boolean;
  /** v1.8.1: note pentru AI (captură indisponibilă, linii aparent de eroare). */
  notes: string[];
}

export interface RunningDevServer {
  pid: number | null;
  command: string;
  cwd: string;
  startedAt: number;
  terminalName: string;
}

interface DevServerEntry {
  terminalName: string;
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  capture: boolean;
  /** output cumulat (limită MAX_CAPTURE; curățat de ANSI la citire). */
  output: string;
  /** se rezolvă când execuția s-a terminat sau terminalul a fost închis. */
  ended: Promise<void>;
  subs: vscode.Disposable[];
}

export interface DevServersStopReport {
  stopped: RunningDevServer[];
  failed: Array<{
    pid: number | null;
    command: string;
    terminalName: string;
    error: string;
  }>;
}

const registry = new Map<string, DevServerEntry>();

/** Serverele (terminale) care încă rulează (în sesiunea curentă). */
export function getRunningDevServers(): RunningDevServer[] {
  return [...registry.values()]
    .filter((e) => !e.exited && !e.closed)
    .map(({ pid, command, cwd, startedAt, terminalName }) => ({
      pid,
      command,
      cwd,
      startedAt,
      terminalName
    }));
}

/** Găsește un server care rulează deja pentru (command, cwd) — anti-dublare. */
export function findRunningDevServer(
  command: string,
  cwd?: string
): RunningDevServer | undefined {
  const cmd = String(command ?? '').trim().toLowerCase();
  const dir = String(cwd ?? '').toLowerCase();
  return getRunningDevServers().find(
    (s) =>
      s.command.trim().toLowerCase() === cmd &&
      (!dir || s.cwd.toLowerCase() === dir)
  );
}

/** „npm run dev” → „dev”; „vite --host” → „vite”; „cd app && npm start” → „start”. */
export function devServerLabel(command: string): string {
  const seg = String(command ?? '')
    .split(/&&|\|\||;|\|/)
    .pop()!
    .trim();
  const tokens = seg.split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < tokens.length &&
    (tokens[i].startsWith('-') || /^(sudo|npx|pnpx|bunx)$/i.test(tokens[i]))
  ) {
    i++;
  }
  const bin = (tokens[i] ?? 'dev')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(cmd|exe)$/i, '');
  const rest = tokens.slice(i + 1).filter((t) => !t.startsWith('-'));
  if (/^(npm|pnpm|yarn|bun)$/i.test(bin)) {
    const j = (rest[0] ?? '').toLowerCase() === 'run' ? 1 : 0;
    const script = (rest[j] ?? '').replace(/^["']+|["']+$/g, '');
    if (script) return script;
  }
  return bin || 'dev';
}

/** Nume unic de terminal: „Freekit: dev”; la conflict → „(dir)” apoi „#n”. */
function uniqueTerminalName(label: string, cwd: string): string {
  const base = 'Freekit: ' + label;
  const taken = new Set([...registry.values()].map((e) => e.terminalName));
  if (!taken.has(base)) return base;
  const dir = path.basename(cwd || '') || 'dir';
  const withDir = base + ' (' + dir + ')';
  if (!taken.has(withDir)) return withDir;
  for (let n = 2; ; n++) {
    const numbered = base + ' #' + n;
    if (!taken.has(numbered)) return numbered;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Curăță secvențele ANSI (culori, titlu OSC, cursor) + \r din output. */
function stripAnsi(text: string): string {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r/g, '');
}

/** Linii aparent de eroare în primele secunde — doar semnal de avertizare. */
function looksLikeStartupError(text: string): boolean {
  return /\b(error|EADDRINUSE|failed|not found|exception)\b/i.test(text);
}

function captureChunk(e: DevServerEntry, text: string): void {
  if (e.output.length >= MAX_CAPTURE) return;
  e.output += text.slice(0, MAX_CAPTURE - e.output.length);
}

/** Așteaptă activarea Shell Integration în terminalul nou (sau timeout). */
function waitForShellIntegration(
  vsc: VsCodeApi,
  terminal: vscode.Terminal,
  timeoutMs: number
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  const onDidChange = (vsc.window as any).onDidChangeTerminalShellIntegration;
  if (typeof onDidChange !== 'function') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (si?: vscode.TerminalShellIntegration) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sub.dispose();
      resolve(si ?? terminal.shellIntegration);
    };
    const sub = onDidChange(
      (e: {
        terminal: vscode.Terminal;
        shellIntegration?: vscode.TerminalShellIntegration;
      }) => {
        if (e.terminal === terminal && e.shellIntegration) {
          finish(e.shellIntegration);
        }
      }
    );
    const timer = setTimeout(() => finish(terminal.shellIntegration), timeoutMs);
  });
}

/** Scoate intrarea din registru + eliberează toți listener-ii ei. */
function removeEntry(e: DevServerEntry): void {
  for (const d of e.subs.splice(0)) {
    try {
      d.dispose();
    } catch {
      /* ignore */
    }
  }
  if (registry.get(e.terminalName) === e) registry.delete(e.terminalName);
}

function clip(text: string, max = MAX_RESULT_TEXT): string {
  return text.length > max ? text.slice(0, max) + '\n[...trunchiat...]' : text;
}

function isLocalUrl(url: string): boolean {
  const m = url.match(/^https?:\/\/([^/:?#]+)/i);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    return true;
  }
  if (/^\[?::1?\]?$/.test(host)) return true;
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  return false;
}

function extractUrls(text: string): string[] {
  const found = stripAnsi(text).match(/https?:\/\/[^\s"'`<>)\]}]+/gi) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const url = raw.replace(/[),.;:]+$/g, '');
    if (!isLocalUrl(url)) continue;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * v1.8.1 — pornește comanda într-un TERMINAL VS Code dedicat, VIZIBIL:
 * - `terminal.show()` → utilizatorul vede output-ul live în panoul de jos;
 * - comanda rulează în shell-ul terminalului → Ctrl+C funcționează normal;
 * - output-ul e citit live prin Shell Integration și primele `graceMs`
 *   (implicit 3s) ajung în rezultat (URL + erori rapide de pornire);
 * - procesul rămâne pornit (nu e omorât la finalul buclei agentice).
 * Fără shell integration: comanda pornește la fel (sendText), dar fără
 * captură — rezultatul marchează explicit `captured: false`.
 */
export async function startDevServer(
  command: string,
  opts: { cwd?: string; graceMs?: number; siWaitMs?: number } = {}
): Promise<DevServerStartResult> {
  const started = Date.now();
  const graceMs =
    Number.isFinite(opts.graceMs) && (opts.graceMs as number) > 0
      ? Math.min(opts.graceMs as number, 60000)
      : DEFAULT_GRACE_MS;
  const siWaitMs =
    Number.isFinite(opts.siWaitMs) && (opts.siWaitMs as number) >= 0
      ? Math.min(opts.siWaitMs as number, 60000)
      : SHELL_INTEGRATION_WAIT_MS;
  const cwd = opts.cwd ?? process.cwd();

  const fail = (
    message: string,
    terminalName = ''
  ): DevServerStartResult => ({
    running: false,
    pid: null,
    stdout: '',
    stderr: '',
    output: message,
    exitCode: null,
    durationMs: Date.now() - started,
    urls: [],
    terminalName,
    captured: false,
    notes: []
  });

  let vsc: VsCodeApi;
  try {
    vsc = getVscode();
  } catch (e: any) {
    return fail(
      'spawn error: VS Code API unavailable (' + (e?.message ?? String(e)) + ')'
    );
  }

  const name = uniqueTerminalName(devServerLabel(command), cwd);
  let terminal: vscode.Terminal;
  try {
    const options: vscode.TerminalOptions = { name, cwd, isTransient: false };
    const panel = (vsc as any).TerminalLocation?.Panel;
    if (typeof panel === 'number') options.location = panel;
    terminal = vsc.window.createTerminal(options);
  } catch (e: any) {
    return fail('spawn error: ' + (e?.message ?? String(e)), name);
  }

  logLine('dev-server', 'starting in VS Code terminal "' + name + '": ' + command);

  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  let endedDone = false;
  const markEnded = () => {
    if (endedDone) return;
    endedDone = true;
    resolveEnded();
  };

  const entry: DevServerEntry = {
    terminalName: name,
    terminal,
    command,
    cwd,
    startedAt: started,
    pid: null,
    exited: false,
    exitCode: null,
    closed: false,
    capture: false,
    output: '',
    ended,
    subs: []
  };
  registry.set(name, entry);

  // PID-ul shell-ului din terminal (best-effort, nu blochează pornirea)
  void Promise.resolve(terminal.processId)
    .then((p) => {
      if (typeof p === 'number' && p > 0) entry.pid = p;
    })
    .catch(() => {
      /* ignore */
    });

  // închiderea terminalului de către utilizator (X / dispose / kill)
  const onClose = (vsc.window as any).onDidCloseTerminal;
  if (typeof onClose === 'function') {
    entry.subs.push(
      onClose((t: vscode.Terminal) => {
        if (t !== terminal) return;
        entry.closed = true;
        removeEntry(entry);
        markEnded();
      })
    );
  }

  terminal.show(); // cerința principală: terminalul e VIZIBIL, în față

  // 1) captură live prin Shell Integration (API STABIL, VS Code ≥ 1.93)
  let execution: vscode.TerminalShellExecution | undefined;
  try {
    const si = await waitForShellIntegration(vsc, terminal, siWaitMs);
    if (si) {
      try {
        execution = si.executeCommand(command);
      } catch {
        execution = undefined;
      }
    }
  } catch {
    execution = undefined;
  }

  if (entry.closed) {
    removeEntry(entry);
    return fail('(terminal închis înainte de trimiterea comenzii)', name);
  }

  if (execution) {
    entry.capture = true;
    // sfârșitul execuției → exit code + ieșirea din registru
    const onEnd = (vsc.window as any).onDidEndTerminalShellExecution;
    if (typeof onEnd === 'function') {
      entry.subs.push(
        onEnd((e: vscode.TerminalShellExecutionEndEvent) => {
          if (e.terminal !== terminal) return;
          if (execution && e.execution !== execution) return;
          entry.exited = true;
          entry.exitCode = typeof e.exitCode === 'number' ? e.exitCode : null;
          removeEntry(entry);
          markEnded();
        })
      );
    }
    // citirea LIVE a output-ului: consumăm până la terminarea execuției
    // (altfel coada de output din VS Code crește nemărginit), dar păstrăm
    // doar MAX_CAPTURE în memorie
    void (async () => {
      try {
        for await (const chunk of execution!.read()) {
          captureChunk(entry, String(chunk));
        }
      } catch {
        /* stream închis */
      }
    })();
  } else {
    // fallback fără shell integration: la fel de vizibil, dar fără captură
    try {
      terminal.sendText(command);
    } catch (e: any) {
      removeEntry(entry);
      return fail('spawn error: ' + (e?.message ?? String(e)), name);
    }
  }

  // 2) perioada de grație: primele secunde de output (URL, erori rapide)
  const raced = await Promise.race([
    ended.then(() => 'ended' as const),
    sleep(graceMs).then(() => 'grace' as const)
  ]);

  const captured = stripAnsi(entry.output);
  const urls = extractUrls(entry.output);
  const notes: string[] = [];

  if (raced === 'grace') {
    // procesul încă rulează (sau fallback-ul nu poate ști) — server pornit
    if (!entry.capture) {
      notes.push(
        'captură live indisponibilă (shell integration nu s-a activat în acest terminal) — output-ul complet se vede doar în terminal'
      );
    } else if (looksLikeStartupError(captured)) {
      notes.push(
        'output-ul de pornire conține linii aparent de eroare — verifică în terminal dacă serverul chiar a pornit corect'
      );
    }
    return {
      running: true,
      pid: entry.pid,
      stdout: clip(captured),
      stderr: '',
      output: clip(captured),
      exitCode: null,
      durationMs: Date.now() - started,
      urls,
      terminalName: name,
      captured: entry.capture,
      notes
    };
  }

  // s-a terminat (crash / eroare de pornire) sau terminalul a fost închis
  const output = captured || (entry.closed ? '(terminal închis)' : '(fără output)');
  notes.push(
    'terminalul „' + name + '” rămâne deschis — output-ul complet e vizibil acolo'
  );
  if (!entry.capture) {
    notes.push('captură live indisponibilă (shell integration) — vezi terminalul');
  }
  return {
    running: false,
    pid: entry.pid,
    stdout: clip(output),
    stderr: '',
    output: clip(output),
    exitCode: entry.exitCode,
    durationMs: Date.now() - started,
    urls,
    terminalName: name,
    captured: entry.capture,
    notes
  };
}

/** Oprește toate serverele pornite de extensie (comanda Stop Dev Servers). */
export async function stopDevServers(): Promise<DevServersStopReport> {
  const report: DevServersStopReport = { stopped: [], failed: [] };
  const entries = [...registry.values()].filter((e) => !e.exited && !e.closed);
  for (const e of entries) {
    const rest: RunningDevServer = {
      pid: e.pid,
      command: e.command,
      cwd: e.cwd,
      startedAt: e.startedAt,
      terminalName: e.terminalName
    };
    try {
      // 1) Ctrl+C grațios în terminalul serverului (ca un Ctrl+C normal al
      //    utilizatorului — framework-urile își fac cleanup-ul obișnuit)
      let ctrlCSent = true;
      try {
        e.terminal.sendText('\x03', false);
      } catch {
        ctrlCSent = false; // terminalul e deja mort/închis
      }
      if (ctrlCSent) {
        const exited = await Promise.race([
          e.ended.then(() => true),
          sleep(STOP_KILL_MS).then(() => false)
        ]);
        if (!exited) {
          // 2) nu a răspuns la Ctrl+C → închidem terminalul (VS Code omoară
          //    procesul din el, împreună cu copiii lui)
          try {
            e.terminal.dispose();
          } catch {
            /* ignore */
          }
        }
      } else {
        try {
          e.terminal.dispose();
        } catch {
          /* ignore */
        }
      }
      removeEntry(e); // idempotent (end/close pot fi deja declanșate)
      report.stopped.push(rest);
      logLine('dev-server', 'stopped "' + e.terminalName + '": ' + e.command);
    } catch (err: any) {
      report.failed.push({
        pid: e.pid,
        command: e.command,
        terminalName: e.terminalName,
        error: err?.message ?? String(err)
      });
    }
  }
  return report;
}

/** Textul care ajunge la AI când un dev server a pornit în terminalul VS Code. */
export function formatDevServerStartResult(
  toolLabel: string,
  command: string,
  res: DevServerStartResult,
  opts: { cwd?: string; graceMs?: number } = {}
): string {
  const lines: string[] = [];
  lines.push(
    '✅ Server pornit în TERMINALUL VS Code „' +
      (res.terminalName || '?') +
      '” (vizibil în panoul de jos al VS Code)'
  );
  lines.push('tool: ' + toolLabel + ' — command: ' + command);
  if (opts.cwd) lines.push('directory: ' + opts.cwd);
  if (res.urls.length) lines.push('live URL: ' + res.urls.join(', '));
  for (const note of res.notes ?? []) lines.push('⚠️ ' + note);
  lines.push(
    'The process runs in the DEDICATED VISIBLE TERMINAL (the user watches it there and can press Ctrl+C in it) and keeps running — do NOT wait for it and do NOT re-run this command.'
  );
  const out = (res.output ?? '').trim();
  const graceSeconds = ((opts.graceMs ?? res.durationMs) / 1000).toFixed(1);
  if (out) {
    lines.push('--- output (first ' + graceSeconds + 's, captured live) ---');
    lines.push(out.slice(0, 6000));
    lines.push('--- end output ---');
  } else {
    lines.push(
      '(no output yet in the first ' + graceSeconds + 's — normal for some servers)'
    );
  }
  lines.push(
    'Next: continue with your task or reply with the final answer. The user can stop the server with Ctrl+C in its terminal or with the VS Code command "Freekit: Stop Dev Servers".'
  );
  return lines.join('\n').slice(0, 20000);
}
