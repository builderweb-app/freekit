import type * as vscode from 'vscode';
import { McpClient, McpServerConfig, McpTool } from './client';
import type { ApprovalFn, ToolCall, ToolResult } from '../tools';
import { logLine } from '../log';

const log = (msg: string) => logLine('mcp', msg);

/* =========================================================================
 * v1.1.0 — MCP MANAGER
 *
 * Ține un singur McpClient pentru toată extensia și oferă:
 *  - pornirea/oprirea/repornirea serverelor + reîncărcare la schimbarea
 *    configului (`.vscode/mcp.json` sau `aiBridge.mcpServers`);
 *  - catalogul de unelte expus AI-ului ca `mcp_<server>_<tool>`;
 *  - execuția apelurilor MCP prin ACELAȘI flux de aprobare ca uneltele
 *    normale (auto-approve funcționează identic);
 *  - secțiunea de prompt + rapoartele de status/diagnostics;
 *  - UI de gestionare (`AI Bridge: MCP Servers`).
 * ========================================================================= */

export interface McpToolEntry {
  /** Numele expus AI-ului: mcp_<server>_<tool> (sanitizat). */
  id: string;
  serverName: string;
  toolName: string;
  description?: string;
  /** Numele parametrilor din inputSchema (pentru prompt). */
  params: string[];
}

const MAX_PROMPT_TOOLS = 60;
const MAX_PROMPT_CHARS = 6500;
const LOCAL_MAX_PROMPT_TOOLS = 25;
const LOCAL_MAX_PROMPT_CHARS = 2800;
const TOOL_RESULT_MAX = 20000;
const RELOAD_DEBOUNCE_MS = 800;

function sanitizeId(s: string): string {
  return String(s)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'x';
}

function safeJson(v: any): string {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return String(v);
  }
}

export class McpManager {
  readonly client = new McpClient();
  private notify: (text: string) => void = () => undefined;
  private initialized = false;
  private reloadTimer?: NodeJS.Timeout;

  /** chatView-ul se înregistrează ca sink pentru notice-uri. */
  setNotify(fn: (text: string) => void): void {
    this.notify = fn ?? (() => undefined);
  }

  hasServers(): boolean {
    return this.client.serverNames().length > 0;
  }

  /* ------------------------------------------------------------------ *
   * Catalogul de unelte expuse AI-ului
   * ------------------------------------------------------------------ */

  /** Reconstruiește catalogul din uneltele curente (ieftin, la cerere). */
  catalog(): McpToolEntry[] {
    const used = new Set<string>();
    const out: McpToolEntry[] = [];
    for (const tool of this.client.getTools()) {
      let id = 'mcp_' + sanitizeId(tool.serverName) + '_' + sanitizeId(tool.name);
      while (used.has(id)) id += '_';
      used.add(id);
      const schema = tool.inputSchema;
      const params =
        schema && typeof schema === 'object' && schema.properties &&
        typeof schema.properties === 'object'
          ? Object.keys(schema.properties)
          : [];
      out.push({
        id,
        serverName: tool.serverName,
        toolName: tool.name,
        description: tool.description,
        params
      });
    }
    return out;
  }

  /** Potrivește un nume de unealtă (exact, apoi case-insensitive). */
  resolveTool(name: string): McpToolEntry | null {
    const cat = this.catalog();
    const direct = cat.find((t) => t.id === name);
    if (direct) return direct;
    const lower = String(name).toLowerCase();
    return cat.find((t) => t.id.toLowerCase() === lower) ?? null;
  }

  /* ------------------------------------------------------------------ *
   * Secțiunea de prompt (uneltele MCP expuse modelului)
   * ------------------------------------------------------------------ */

  promptSection(local: boolean): string {
    const cat = this.catalog();
    if (!cat.length) return '';
    const maxTools = local ? LOCAL_MAX_PROMPT_TOOLS : MAX_PROMPT_TOOLS;
    const maxChars = local ? LOCAL_MAX_PROMPT_CHARS : MAX_PROMPT_CHARS;

    const lines: string[] = [
      'MCP TOOLS (external Model Context Protocol servers — call them exactly like the built-in tools):'
    ];
    for (const t of cat.slice(0, maxTools)) {
      const params = '(' + (t.params.length ? t.params.join(', ') : '') + ')';
      const desc = (t.description || '').replace(/\s+/g, ' ').slice(0, 140);
      lines.push(
        '- ' + t.id + params + (desc ? ': ' + desc : '') +
          ' [server: ' + t.serverName + ']'
      );
    }
    if (cat.length > maxTools) {
      lines.push(
        '… +' + (cat.length - maxTools) +
          ' more MCP tools (not listed here — stick to the listed ones).'
      );
    }
    lines.push(
      'Call format: {"tool": "mcp_<server>_<tool>", "args": {...}} — args must match the tool\'s input schema.',
      'MCP calls require user approval (unless auto-approve is on); if a server is down the call fails — do not retry in a loop.'
    );
    let out = lines.join('\n');
    if (out.length > maxChars) {
      out = out.slice(0, maxChars) + '\n… (MCP tool list truncated)';
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Execuția apelurilor MCP (integrare în bucla agentică)
   * ------------------------------------------------------------------ */

  /**
   * Dacă `call` este un apel MCP, îl execută (cu aprobare) și întoarce
   * rezultatul; altfel întoarce null (unealta nu e a noastră).
   */
  async executeToolCall(
    call: ToolCall,
    approve: ApprovalFn,
    logFn: (msg: string) => void
  ): Promise<ToolResult | null> {
    const name = String(call?.tool ?? '');
    if (!name.startsWith('mcp_') && name !== 'mcp_call') return null;

    let entry: McpToolEntry | null = null;
    let args: Record<string, any> = {};

    if (name === 'mcp_call') {
      // alias generic: {"tool":"mcp_call","args":{"server","tool","arguments"}}
      const serverName = String(call.args?.server ?? '');
      const toolName = String(call.args?.tool ?? '');
      const rawArgs = call.args?.arguments ?? call.args?.args ?? {};
      args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      entry =
        this.catalog().find(
          (t) => t.serverName === serverName && t.toolName === toolName
        ) ??
        (serverName && toolName
          ? { id: name, serverName, toolName, params: [] }
          : null);
    } else {
      entry = this.resolveTool(name);
      args = call.args && typeof call.args === 'object' ? call.args : {};
    }

    if (!entry) {
      const cat = this.catalog();
      return {
        ok: false,
        error:
          'Unknown MCP tool: "' + name + '". ' +
          (cat.length
            ? 'Available MCP tools: ' + cat.slice(0, 40).map((t) => t.id).join(', ')
            : 'No MCP server is currently running (use the "AI Bridge: MCP Servers" command to check).') +
          ' Do NOT invent MCP tool names — use the built-in tools instead.'
      };
    }

    const pretty = entry.serverName + '/' + entry.toolName;
    const preview = safeJson(args);
    logFn('mcp: ' + pretty + ' ' + preview.slice(0, 160).replace(/\s+/g, ' '));

    const approved = await approve(
      'mcp',
      pretty,
      'MCP tool call → ' + pretty + '\n\n' + preview.slice(0, 4000)
    );
    if (!approved) return { ok: false, error: 'Respins de utilizator' };

    try {
      const res = await this.client.callToolDetailed({
        serverName: entry.serverName,
        toolName: entry.toolName,
        args
      });
      const text = (res.text || '(fără rezultat)').slice(0, TOOL_RESULT_MAX);
      if (res.isError) {
        return {
          ok: false,
          error:
            '✗ MCP ' + pretty + ' a raportat o eroare:\n' + text
        };
      }
      return { ok: true, result: '✓ MCP ' + pretty + '\n' + text };
    } catch (e: any) {
      return {
        ok: false,
        error:
          '✗ MCP ' + pretty + ' a eșuat: ' + (e?.message ?? String(e)) +
          '\n(Poți verifica serverele cu comanda „AI Bridge: MCP Servers”. Nu reîncerca în buclă.)'
      };
    }
  }

  /* ------------------------------------------------------------------ *
   * Status (raportul de provideri + diagnostics)
   * ------------------------------------------------------------------ */

  statusLines(): string[] {
    const infos = this.client.getServerInfos();
    if (!infos.length) {
      return [
        this.hasServers()
          ? 'MCP: servere configurate dar ne pornite — folosește „AI Bridge: MCP Servers”.'
          : 'MCP: niciun server configurat (.vscode/mcp.json sau aiBridge.mcpServers).'
      ];
    }
    const running = infos.filter((i) => i.state === 'running');
    const failed = infos.filter((i) => i.state === 'failed');
    const tools = this.client.getTools().length;
    const out: string[] = [
      'MCP: 🟢 ' + running.length + '/' + infos.length + ' servere, ' + tools +
        ' unelte — ' +
        (running.map((i) => i.name + ' (' + i.tools + ')').join(', ') || '—')
    ];
    for (const f of failed) {
      out.push('  🔴 ' + f.name + ': ' + (f.error || 'nu a pornit'));
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Ciclu de viață (apelat din extension.ts)
   * ------------------------------------------------------------------ */

  async init(
    ctx: vscode.ExtensionContext,
    notify: (text: string) => void
  ): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setNotify(notify);
    try {
      const v = require('vscode') as typeof vscode;
      const cfg = v.workspace.getConfiguration('aiBridge');
      if (!cfg.get<boolean>('mcpEnabled', true)) {
        log('MCP dezactivat (aiBridge.mcpEnabled = false)');
        return;
      }
      const toolSecs = Number(cfg.get<number>('mcpToolTimeoutSeconds', 60));
      if (Number.isFinite(toolSecs)) this.client.setToolTimeoutMs(toolSecs * 1000);

      await this.client.loadConfig();
      const names = this.client.serverNames();
      if (!names.length) {
        log('MCP: niciun server configurat');
        return;
      }

      this.notify('🔌 MCP: pornesc ' + names.length + ' server(e): ' + names.join(', '));
      await this.client.startAll();
      const infos = this.client.getServerInfos();
      const running = infos.filter((i) => i.state === 'running');
      this.notify(
        '🔌 MCP: ' + running.length + '/' + infos.length + ' servere active, ' +
          this.client.getTools().length + ' unelte expuse AI-ului.'
      );

      // reîncărcare la modificarea configurilor
      const folder = v.workspace.workspaceFolders?.[0];
      if (folder) {
        try {
          const watcher = v.workspace.createFileSystemWatcher(
            new v.RelativePattern(folder, '.vscode/mcp.json')
          );
          watcher.onDidChange(() => this.scheduleReload());
          watcher.onDidCreate(() => this.scheduleReload());
          watcher.onDidDelete(() => this.scheduleReload());
          ctx.subscriptions.push(watcher);
        } catch (e: any) {
          log('watcher setup failed: ' + (e?.message ?? String(e)));
        }
      }
      ctx.subscriptions.push(
        v.workspace.onDidChangeConfiguration((e) => {
          if (
            e.affectsConfiguration('aiBridge.mcpEnabled') ||
            e.affectsConfiguration('aiBridge.mcpServers') ||
            e.affectsConfiguration('aiBridge.mcpToolTimeoutSeconds')
          ) {
            this.scheduleReload();
          }
        })
      );
      ctx.subscriptions.push({ dispose: () => void this.stopAll() });
    } catch (e: any) {
      log('init failed: ' + (e?.message ?? String(e)));
    }
  }

  /** Reîncărcare cu debounce (watcher + setări). */
  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, RELOAD_DEBOUNCE_MS);
    if (typeof this.reloadTimer.unref === 'function') this.reloadTimer.unref();
  }

  /** Repornește tot din configul curent (după schimbări de config). */
  async reload(): Promise<void> {
    log('reload: repornesc serverele MCP');
    try {
      const v = require('vscode') as typeof vscode;
      if (!v.workspace.getConfiguration('aiBridge').get<boolean>('mcpEnabled', true)) {
        await this.stopAll();
        this.notify('🔌 MCP dezactivat — serverele au fost oprite.');
        return;
      }
      const toolSecs = Number(
        v.workspace.getConfiguration('aiBridge').get<number>('mcpToolTimeoutSeconds', 60)
      );
      if (Number.isFinite(toolSecs)) this.client.setToolTimeoutMs(toolSecs * 1000);
    } catch {
      /* fără vscode */
    }
    await this.client.stopAll();
    await this.client.loadConfig();
    const names = this.client.serverNames();
    if (!names.length) {
      this.notify('🔌 MCP: nicio configurație de servere — am oprit tot.');
      return;
    }
    await this.client.startAll();
    const infos = this.client.getServerInfos();
    const running = infos.filter((i) => i.state === 'running');
    this.notify(
      '🔌 MCP reîncărcat: ' + running.length + '/' + infos.length +
        ' servere active, ' + this.client.getTools().length + ' unelte.'
    );
  }

  async restartAll(): Promise<void> {
    await this.client.stopAll();
    await this.client.startAll();
    const infos = this.client.getServerInfos();
    const running = infos.filter((i) => i.state === 'running');
    this.notify(
      '🔌 MCP: repornit — ' + running.length + '/' + infos.length +
        ' servere active, ' + this.client.getTools().length + ' unelte.'
    );
  }

  async stopAll(): Promise<void> {
    await this.client.stopAll();
  }

  /* ------------------------------------------------------------------ *
   * UI de gestionare: "AI Bridge: MCP Servers" (QuickPick)
   * ------------------------------------------------------------------ */

  async showManagerUi(): Promise<void> {
    const v = require('vscode') as typeof vscode;
    const infos = this.client.getServerInfos();
    const cat = this.catalog();
    const icon = (s: string) =>
      s === 'running' ? '🟢' : s === 'failed' ? '🔴' : '⚪';

    type Item = vscode.QuickPickItem & { action: string; server?: string };
    const items: Item[] = [];
    for (const i of infos) {
      items.push({
        label: icon(i.state) + ' $(server-process) ' + i.name,
        description: i.state + ' — ' + i.tools + ' unelte',
        detail: i.error ? 'eroare: ' + i.error : i.command,
        action: 'server',
        server: i.name
      });
    }
    if (!infos.length) {
      items.push({
        label: '$(info) Niciun server MCP pornit',
        description: 'adaugă servere în .vscode/mcp.json sau în aiBridge.mcpServers',
        action: 'noop'
      });
    }
    items.push({
      label: '$(refresh) Repornește toate serverele',
      description: this.client.serverNames().length + ' configurate',
      action: 'restart-all'
    });
    items.push({
      label: '$(tools) Arată toate uneltele MCP (' + cat.length + ')',
      action: 'tools'
    });
    items.push({
      label: '$(json) Deschide .vscode/mcp.json',
      description: 'îl creează cu un exemplu dacă nu există',
      action: 'config'
    });
    items.push({
      label: '$(gear) Setarea aiBridge.mcpServers',
      action: 'settings'
    });

    const pick = await v.window.showQuickPick(items, {
      title: 'AI Bridge — MCP Servers',
      placeHolder: 'Alege un server sau o acțiune'
    });
    if (!pick) return;

    switch (pick.action) {
      case 'restart-all':
        await this.restartAll();
        v.window.showInformationMessage('AI Bridge: serverele MCP au fost repornite.');
        break;
      case 'tools':
        await v.window.showQuickPick(
          cat.map((t) => ({
            label: t.id,
            description: 'server: ' + t.serverName,
            detail: t.description
          })),
          { title: 'Unelte MCP disponibile (' + cat.length + ')' }
        );
        break;
      case 'config':
        await this.openConfigFile();
        break;
      case 'settings':
        await v.commands.executeCommand(
          'workbench.action.openSettings',
          'aiBridge.mcpServers'
        );
        break;
      case 'server':
        if (pick.server) await this.serverMenu(pick.server);
        break;
      default:
        break;
    }
  }

  private async serverMenu(name: string): Promise<void> {
    const v = require('vscode') as typeof vscode;
    const pick = await v.window.showQuickPick(
      [
        { label: '$(refresh) Repornește serverul', action: 'restart' },
        { label: '$(stop) Oprește serverul', action: 'stop' },
        { label: '$(tools) Arată uneltele serverului', action: 'tools' }
      ],
      { title: 'MCP: ' + name }
    );
    if (!pick) return;

    if (pick.action === 'restart') {
      try {
        await this.client.restartServer(name);
        v.window.showInformationMessage('AI Bridge: serverul MCP „' + name + '” a fost repornit.');
        this.notify('🔌 MCP: „' + name + '” repornit — ' + this.client.getTools().filter((t) => t.serverName === name).length + ' unelte.');
      } catch (e: any) {
        v.window.showErrorMessage(
          'AI Bridge: „' + name + '” nu a pornit — ' + (e?.message ?? String(e))
        );
      }
    } else if (pick.action === 'stop') {
      await this.client.stopServer(name);
      v.window.showInformationMessage('AI Bridge: serverul MCP „' + name + '” a fost oprit.');
    } else if (pick.action === 'tools') {
      const tools = this.catalog().filter((t) => t.serverName === name);
      await v.window.showQuickPick(
        tools.map((t) => ({
          label: t.id,
          description: t.params.length ? '(' + t.params.join(', ') + ')' : '(fără parametri)',
          detail: t.description
        })),
        { title: 'Uneltele serverului ' + name + ' (' + tools.length + ')' }
      );
    }
  }

  /** Deschide (sau creează cu un exemplu) `.vscode/mcp.json`. */
  private async openConfigFile(): Promise<void> {
    const v = require('vscode') as typeof vscode;
    const folder = v.workspace.workspaceFolders?.[0];
    if (!folder) {
      await v.commands.executeCommand(
        'workbench.action.openSettings',
        'aiBridge.mcpServers'
      );
      return;
    }
    const uri = v.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
    let exists = true;
    try {
      await v.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      const template = JSON.stringify(
        {
          servers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
            }
          }
        },
        null,
        2
      );
      try {
        await v.workspace.fs.createDirectory(v.Uri.joinPath(folder.uri, '.vscode'));
        await v.workspace.fs.writeFile(uri, Buffer.from(template, 'utf8'));
        v.window.showInformationMessage(
          'AI Bridge: am creat .vscode/mcp.json cu un server exemplu — editează-l, apoi rulează „AI Bridge: MCP Servers” → Repornește.'
        );
      } catch (e: any) {
        v.window.showErrorMessage(
          'AI Bridge: nu am putut crea .vscode/mcp.json — ' + (e?.message ?? String(e))
        );
        return;
      }
    }
    const doc = await v.workspace.openTextDocument(uri);
    await v.window.showTextDocument(doc);
  }
}

/** Singleton-ul folosit de chatView / extension / diagnostics. */
export const mcp = new McpManager();
