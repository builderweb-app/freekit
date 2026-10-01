import { spawn, ChildProcess } from 'child_process';
// IMPORTANT: `vscode` doar ca TIP — la runtime se cere lazy (require) în
// loadConfig(), ca modulul să poată fi încărcat și în teste Node.
import type * as vscode from 'vscode';

const log = (msg: string) => console.log('[AI Bridge][mcp]', msg);

/* =========================================================================
 * v1.1.0 — MCP (Model Context Protocol) CLIENT
 *
 * Serverele MCP sunt procese care vorbesc JSON-RPC 2.0 prin stdio
 * (mesaje delimitate prin newline — transportul stdio din spec-ul MCP).
 * Clientul: pornește serverele configurate de utilizator, face handshake-ul
 * (initialize → notifications/initialized), descoperă uneltele (tools/list,
 * cu paginare prin cursor) și le apelează (tools/call).
 *
 * Configurare: `.vscode/mcp.json` (format {"servers": {...}}) sau setarea
 * `aiBridge.mcpServers` (aceeași structură). Ambele formate clasice sunt
 * acceptate: `servers` (VS Code) și `mcpServers` (Claude Desktop).
 * ========================================================================= */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
  /** numele serverului care expune unealta */
  serverName: string;
}

export interface McpToolCall {
  serverName: string;
  toolName: string;
  args: Record<string, any>;
}

export interface McpToolCallResult {
  /** Textul rezultatului (părțile `content` concatenate). */
  text: string;
  /** true = serverul a raportat isError pe rezultat */
  isError: boolean;
  /** Rezultatul brut (pentru debugging). */
  raw: any;
}

export type McpServerState = 'starting' | 'running' | 'failed' | 'stopped';

export interface McpServerInfo {
  name: string;
  state: McpServerState;
  tools: number;
  command: string;
  error?: string;
  /** Versiunea raportată de server în handshake (serverInfo.version). */
  serverVersion?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
  method?: string;
}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  serverName: string;
  timer: NodeJS.Timeout;
}

export interface McpClientOptions {
  /** Timeout pentru request-urile de control (tools/list etc.). */
  requestTimeoutMs?: number;
  /** Timeout pentru initialize (npx poate descărca pachetul prima dată). */
  initializeTimeoutMs?: number;
  /** Timeout implicit pentru tools/call. */
  toolTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Comenzi care pe Windows sunt shim-uri .cmd/.bat (au nevoie de shell). */
const WIN_SHIM_RE = /^(npx|npm|pnpm|yarn|node|deno|bun)$/i;

/**
 * Pe Windows, fișierele .cmd/.bat NU mai pot fi spawn-uite direct din Node
 * modern (EINVAL, CVE-2024-27980) — le rulăm prin shell, cu argumente
 * citate pentru cmd.exe.
 */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"^&|<>%!]/.test(arg)) return arg;
  return (
    '"' +
    arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') +
    '"'
  );
}

function spawnServer(config: McpServerConfig): ChildProcess {
  const env = { ...process.env, ...(config.env || {}) };
  const base = {
    cwd: config.cwd,
    env,
    stdio: 'pipe' as const,
    windowsHide: true
  };
  const isWin = process.platform === 'win32';
  const needsShell =
    isWin &&
    (/\.(cmd|bat)$/i.test(config.command) || WIN_SHIM_RE.test(config.command));
  if (!needsShell) {
    return spawn(config.command, config.args || [], base);
  }
  // shell:true cu UN SINGUR string (fără array de args → fără DEP0190)
  const line = [config.command, ...(config.args || [])]
    .map(quoteForCmd)
    .join(' ');
  return spawn(line, { ...base, shell: true });
}

/** Omorâm agresiv un proces rămas (fallback după kill() grațios). */
function hardKill(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* best-effort */
  }
}

const TEXT_MAX = 20000;

/** Transformă rezultatul brut tools/call în text + flag de eroare. */
export function formatToolCallResult(result: any): McpToolCallResult {
  const parts: string[] = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const c of content) {
    if (!c || typeof c !== 'object') {
      parts.push(String(c).slice(0, 4000));
      continue;
    }
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text);
    } else if (c.type === 'image') {
      parts.push('[imagine ' + (c.mimeType || '') + ' — nu poate fi afișată în chat]');
    } else if (c.type === 'resource') {
      const uri = c.resource?.uri ?? '';
      const text = typeof c.resource?.text === 'string' ? '\n' + c.resource.text : '';
      parts.push('[resource ' + uri + ']' + text);
    } else {
      parts.push(JSON.stringify(c).slice(0, 4000));
    }
  }
  if (!parts.length && result !== undefined) {
    try {
      parts.push(JSON.stringify(result, null, 2));
    } catch {
      parts.push(String(result));
    }
  }
  const text = parts.join('\n\n').slice(0, TEXT_MAX);
  return { text, isError: result?.isError === true, raw: result };
}

/**
 * Normalizează configul brut (din `.vscode/mcp.json` sau din setări).
 * Acceptă `{ servers: {...} }` (VS Code) și `{ mcpServers: {...} }`
 * (Claude Desktop). Doar transportul stdio este suportat.
 */
export function normalizeMcpConfig(
  raw: any
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  const servers = raw?.servers ?? raw?.mcpServers;
  if (!servers || typeof servers !== 'object') return out;
  for (const [name, cfg] of Object.entries<any>(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const type = String(cfg.type ?? 'stdio').toLowerCase();
    if (type && type !== 'stdio') {
      log('skip server ' + name + ': transport "' + type + '" (doar stdio)');
      continue;
    }
    const command = typeof cfg.command === 'string' ? cfg.command.trim() : '';
    if (!command) {
      log('skip server ' + name + ': lipsește "command"');
      continue;
    }
    const args = Array.isArray(cfg.args)
      ? (cfg.args.filter((a: any) => typeof a === 'string') as string[])
      : undefined;
    let env: Record<string, string> | undefined;
    if (cfg.env && typeof cfg.env === 'object') {
      env = {};
      for (const [k, v] of Object.entries(cfg.env)) env[k] = String(v);
    }
    out[name] = {
      command,
      args,
      env,
      cwd: typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : undefined,
      disabled: cfg.disabled === true
    };
  }
  return out;
}

export class McpClient {
  private processes = new Map<string, ChildProcess>();
  private buffers = new Map<string, string>();
  private stderrTail = new Map<string, string>();
  private stopping = new Set<string>();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private tools: McpTool[] = [];
  private configs: Record<string, McpServerConfig> = {};
  private states = new Map<string, McpServerInfo>();
  private opts: Required<McpClientOptions>;

  /** Notificare de eroare la pornire (folosită de manager pentru UI). */
  onServerError?: (name: string, message: string) => void;
  /** Un proces de server s-a terminat singur (crash) în timp ce rula. */
  onServerExit?: (name: string, code: number | null) => void;
  /** Lista de unelte s-a schimbat (start/stop/restart). */
  onToolsChanged?: () => void;

  constructor(opts?: McpClientOptions) {
    this.opts = {
      requestTimeoutMs: Math.max(1000, opts?.requestTimeoutMs ?? 60000),
      initializeTimeoutMs: Math.max(
        1000,
        opts?.initializeTimeoutMs ?? 120000
      ),
      toolTimeoutMs: Math.max(1000, opts?.toolTimeoutMs ?? 60000)
    };
  }

  setToolTimeoutMs(ms: number): void {
    if (Number.isFinite(ms)) {
      this.opts.toolTimeoutMs = Math.min(600000, Math.max(1000, ms));
    }
  }

  async loadConfig(): Promise<void> {
    let mcpConfig: any = {};
    try {
      // require lazy — în teste Node modulul 'vscode' poate lipsi
      const v = require('vscode') as typeof vscode;
      // 1. .vscode/mcp.json din workspace
      const workspaceFolder = v.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const configPath = v.Uri.joinPath(
          workspaceFolder.uri,
          '.vscode',
          'mcp.json'
        );
        try {
          const content = await v.workspace.fs.readFile(configPath);
          mcpConfig = JSON.parse(Buffer.from(content).toString('utf8'));
          log('loaded .vscode/mcp.json');
        } catch {
          /* fișierul nu există sau nu e JSON valid */
        }
      }
      // 2. Fallback: settings.json
      if (
        !mcpConfig ||
        typeof mcpConfig !== 'object' ||
        Object.keys(mcpConfig).length === 0
      ) {
        const settingsConfig =
          v.workspace
            .getConfiguration('aiBridge')
            .get<any>('mcpServers', {}) || {};
        mcpConfig = { servers: settingsConfig };
        log('loaded settings aiBridge.mcpServers');
      }
    } catch {
      /* fără vscode (teste Node) — rămâne configul injectat manual */
    }
    this.configs = normalizeMcpConfig(mcpConfig);
    log('found ' + Object.keys(this.configs).length + ' MCP servers');
  }

  /** Injectare directă de config (teste / reload programatic). */
  setConfigs(configs: Record<string, McpServerConfig>): void {
    this.configs = { ...configs };
  }

  getConfigs(): Record<string, McpServerConfig> {
    return { ...this.configs };
  }

  serverNames(): string[] {
    return Object.keys(this.configs);
  }

  getServerInfos(): McpServerInfo[] {
    return Array.from(this.states.values()).map((s) => ({ ...s }));
  }

  getServerInfo(name: string): McpServerInfo | undefined {
    const s = this.states.get(name);
    return s ? { ...s } : undefined;
  }

  async startAll(): Promise<void> {
    for (const [name, config] of Object.entries(this.configs)) {
      if (config.disabled) {
        log('server ' + name + ' dezactivat — sar peste');
        continue;
      }
      try {
        await this.startServer(name, config);
      } catch (e: any) {
        const message = e?.message ?? String(e);
        log('server ' + name + ' failed: ' + message);
        this.onServerError?.(name, message);
        try {
          const v = require('vscode') as typeof vscode;
          void v.window.showWarningMessage(
            'MCP server "' + name + '" nu a pornit: ' + message
          );
        } catch {
          /* fără vscode (teste) */
        }
      }
    }
  }

  async startServer(name: string, config: McpServerConfig): Promise<void> {
    if (this.processes.has(name)) {
      await this.stopServer(name);
    }
    const commandLine =
      config.command + (config.args?.length ? ' ' + config.args.join(' ') : '');
    const info: McpServerInfo = {
      name,
      state: 'starting',
      tools: 0,
      command: commandLine
    };
    this.states.set(name, info);
    log('starting server: ' + name + ' → ' + commandLine);

    let proc: ChildProcess;
    try {
      proc = spawnServer(config);
    } catch (e: any) {
      const message = e?.message ?? String(e);
      this.states.set(name, { ...info, state: 'failed', error: message });
      throw new Error(message);
    }

    this.processes.set(name, proc);
    this.buffers.set(name, '');
    this.stderrTail.set(name, '');

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleData(name, chunk.toString());
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const tail = ((this.stderrTail.get(name) ?? '') + chunk.toString()).slice(
        -2000
      );
      this.stderrTail.set(name, tail);
      log('[' + name + ' stderr] ' + chunk.toString().slice(0, 200).trim());
    });

    proc.on('error', (err) => {
      log('server ' + name + ' spawn error: ' + err.message);
      this.states.set(name, {
        ...(this.states.get(name) ?? info),
        state: 'failed',
        error: 'spawn: ' + err.message
      });
    });

    proc.on('exit', (code, signal) => {
      log('server ' + name + ' exited with code ' + code + ' (signal ' + signal + ')');
      if (this.processes.get(name) === proc) {
        this.processes.delete(name);
      }
      // respinge request-urile rămase în așteptare pentru acest server
      for (const [id, p] of Array.from(this.pending.entries())) {
        if (p.serverName === name) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(
            new Error(
              'Serverul ' + name + ' s-a închis (code ' + code + ')'
            )
          );
        }
      }
      if (this.stopping.has(name)) return; // oprire intenționată
      const st = this.states.get(name);
      if (st && (st.state === 'running' || st.state === 'starting')) {
        const tail = this.stderrTail.get(name)?.trim() ?? '';
        this.states.set(name, {
          ...st,
          state: 'failed',
          error:
            'proces terminat (code ' + code + ')' +
            (tail ? ' — ' + tail.split('\n').pop() : '')
        });
        this.onServerExit?.(name, code);
      }
    });

    // așteaptă spawn-ul: un command inexistent eșuează IMEDIAT (nu după
    // timeout-ul de initialize)
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onErr = (err: Error) => {
          cleanup();
          reject(new Error('spawn: ' + err.message));
        };
        const cleanup = () => {
          proc.removeListener('spawn', onSpawn);
          proc.removeListener('error', onErr);
        };
        proc.once('spawn', onSpawn);
        proc.once('error', onErr);
      });
    } catch (e: any) {
      const message = e?.message ?? String(e);
      this.processes.delete(name);
      this.states.set(name, { ...info, state: 'failed', error: message });
      throw new Error(message);
    }

    // --- handshake MCP: initialize → notifications/initialized → tools/list
    try {
      const initRes: any = await this.sendRequest(
        name,
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'ai-bridge', version: '1.1.0' }
        },
        this.opts.initializeTimeoutMs
      );
      this.sendNotification(name, 'notifications/initialized');

      // descoperă uneltele (tools/list acceptă paginare prin cursor)
      this.tools = this.tools.filter((t) => t.serverName !== name);
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result: any = await this.sendRequest(
          name,
          'tools/list',
          cursor ? { cursor } : {},
          this.opts.requestTimeoutMs
        );
        const tools: any[] = Array.isArray(result?.tools) ? result.tools : [];
        for (const tool of tools) {
          if (tool && typeof tool.name === 'string') {
            this.tools.push({
              name: tool.name,
              description:
                typeof tool.description === 'string'
                  ? tool.description
                  : undefined,
              inputSchema: tool.inputSchema,
              serverName: name
            });
          }
        }
        cursor =
          typeof result?.nextCursor === 'string' && result.nextCursor
            ? result.nextCursor
            : undefined;
        if (!cursor) break;
      }

      const count = this.tools.filter((t) => t.serverName === name).length;
      this.states.set(name, {
        ...info,
        state: 'running',
        tools: count,
        serverVersion:
          typeof initRes?.serverInfo?.version === 'string'
            ? initRes.serverInfo.version
            : undefined
      });
      log('server ' + name + ' exposes ' + count + ' tools');
      this.onToolsChanged?.();
    } catch (e: any) {
      // pornirea a eșuat — nu lăsăm procesul orfan
      await this.stopServer(name);
      const message = e?.message ?? String(e);
      this.states.set(name, { ...info, state: 'failed', error: message });
      throw new Error('MCP server "' + name + '": ' + message);
    }
  }

  async restartServer(name: string): Promise<void> {
    const cfg = this.configs[name];
    if (!cfg) throw new Error('Server necunoscut: ' + name);
    await this.stopServer(name);
    await this.startServer(name, cfg);
  }

  private writeRaw(serverName: string, obj: any): void {
    const proc = this.processes.get(serverName);
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
    } catch {
      /* pipe închis */
    }
  }

  private handleData(serverName: string, chunk: string): void {
    const buf = (this.buffers.get(serverName) ?? '') + chunk;
    const lines = buf.split('\n');
    this.buffers.set(serverName, lines.pop() ?? '');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line[0] !== '{') continue; // banner/linii non-JSON
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch (e: any) {
        log('parse error from ' + serverName + ': ' + e.message);
        continue;
      }

      // răspuns la un request al nostru
      if (msg && msg.id !== undefined && !msg.method) {
        const pending = this.pending.get(msg.id as number);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.id as number);
          if (msg.error) {
            pending.reject(
              new Error(
                '[MCP ' +
                  serverName +
                  '] ' +
                  (msg.error.message || 'eroare') +
                  (msg.error.code !== undefined
                    ? ' (code ' + msg.error.code + ')'
                    : '')
              )
            );
          } else {
            pending.resolve(msg.result);
          }
        }
        continue;
      }

      // request de la server (sampling/roots/elicitation) — nu suportăm încă;
      // răspundem cu eroare ca serverul să nu aștepte la infinit
      if (msg && msg.method && msg.id !== undefined) {
        this.writeRaw(serverName, {
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32601,
            message: 'Not supported by ai-bridge: ' + msg.method
          }
        });
        continue;
      }

      // notificare de la server (log etc.)
      if (msg && msg.method) {
        log('[' + serverName + '] ' + msg.method);
      }
    }
  }

  private sendRequest(
    serverName: string,
    method: string,
    params: any,
    timeoutMs?: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const proc = this.processes.get(serverName);
      if (!proc || !proc.stdin || proc.stdin.destroyed) {
        reject(new Error('Serverul ' + serverName + ' nu rulează'));
        return;
      }

      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const t = Math.max(1000, timeoutMs ?? this.opts.requestTimeoutMs);
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              'Request timeout: ' + method + ' (' + serverName + ', ' +
                Math.round(t / 1000) + 's)'
            )
          );
        }
      }, t);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, serverName, timer });
      try {
        proc.stdin.write(JSON.stringify(req) + '\n');
      } catch (e: any) {
        const p = this.pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id);
        }
        reject(e);
      }
    });
  }

  private sendNotification(serverName: string, method: string, params?: any): void {
    const proc = this.processes.get(serverName);
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* pipe închis */
    }
  }

  getTools(): McpTool[] {
    return this.tools.map((t) => ({ ...t }));
  }

  async callTool(call: McpToolCall): Promise<string> {
    const res = await this.callToolDetailed(call);
    return res.text;
  }

  async callToolDetailed(call: McpToolCall): Promise<McpToolCallResult> {
    log('calling tool ' + call.serverName + '/' + call.toolName);
    const result: any = await this.sendRequest(
      call.serverName,
      'tools/call',
      { name: call.toolName, arguments: call.args ?? {} },
      this.opts.toolTimeoutMs
    );
    return formatToolCallResult(result);
  }

  async stopServer(name: string): Promise<void> {
    const proc = this.processes.get(name);
    this.processes.delete(name);
    this.buffers.delete(name);
    this.stopping.add(name);

    // respinge request-urile în așteptare ale acestui server
    for (const [id, p] of Array.from(this.pending.entries())) {
      if (p.serverName === name) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error('Serverul ' + name + ' a fost oprit'));
      }
    }

    if (proc) {
      log('stopping server: ' + name);
      const exited = new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        proc.once('exit', () => resolve());
      });
      try {
        proc.kill();
      } catch {
        /* deja terminat */
      }
      const hard = setTimeout(() => hardKill(proc.pid), 1500);
      await Promise.race([exited, sleep(3000)]);
      clearTimeout(hard);
    }

    this.stopping.delete(name);
    const st = this.states.get(name);
    if (st) {
      this.states.set(name, { ...st, state: 'stopped', tools: 0 });
    } else if (this.configs[name]) {
      this.states.set(name, {
        name,
        state: 'stopped',
        tools: 0,
        command: this.configs[name].command
      });
    }
    this.tools = this.tools.filter((t) => t.serverName !== name);
    this.onToolsChanged?.();
  }

  async stopAll(): Promise<void> {
    for (const name of Array.from(this.processes.keys())) {
      await this.stopServer(name);
    }
    for (const name of Object.keys(this.configs)) {
      const st = this.states.get(name);
      if (st && st.state === 'running') {
        this.states.set(name, { ...st, state: 'stopped', tools: 0 });
      }
    }
    this.tools = [];
  }
}
