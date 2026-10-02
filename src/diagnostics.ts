import * as vscode from 'vscode';
import { BrowserManager, detectBrowserPath } from './browser';
import { selectors } from './selectors';
import { initLogChannel, logLine } from './log';
import { ollamaBaseUrl } from './providers/ollama';
import { mcp } from './mcp/manager';
import { voiceBackendInfo } from './voiceRecorder';

/* =========================================================================
 * v0.3.0 (P0.5) — comanda "Freekit: Diagnostics"
 * Verifică: browser detectat, port CDP, profil, Ollama, selectori reparați,
 * workspace trust. Scrie totul în canalul de log "Freekit".
 * ========================================================================= */

async function fetchJson(url: string, timeoutMs: number): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function runDiagnostics(
  browser: BrowserManager,
  ctx: vscode.ExtensionContext
): Promise<void> {
  const channel = initLogChannel();
  const opts = browser.options();
  const lines: string[] = [];

  lines.push('===== Freekit Diagnostics — ' + new Date().toLocaleString() + ' =====');
  lines.push(
    'Extension: ' +
      ctx.extension.packageJSON.version +
      ' | VS Code: ' +
      vscode.version +
      ' | ' +
      process.platform +
      ' ' +
      process.arch +
      ' | Node ' +
      process.version
  );
  lines.push(
    'Workspace trust: ' +
      (vscode.workspace.isTrusted ? 'TRUSTED' : 'RESTRICTED (the extension will not run tools)') +
      ' | folder: ' +
      (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(none open)')
  );

  const chrome = await detectBrowserPath(opts.chromePath);
  lines.push(
    'Chrome/Edge: ' +
      (chrome ??
        'NOT FOUND — install Chrome or Edge, or set freekit.chromePath')
  );

  const running = await browser.isRunning();
  const version = running ? await browser.chromeVersion() : null;
  lines.push(
    'CDP: port ' +
      opts.port +
      (running
        ? ' — responds (' + (version ?? 'unknown version') + ')'
        : ' — not responding (the browser is not running now)')
  );
  lines.push('Profil Chrome: ' + opts.profileDir);

  const ollamaUrl = ollamaBaseUrl();
  const ollama = await fetchJson(ollamaUrl + '/api/tags', 2500);
  if (ollama) {
    const models = Array.isArray(ollama.models)
      ? ollama.models.map((m: any) => m?.name).filter(Boolean)
      : [];
    lines.push('Ollama: OK — models: ' + (models.join(', ') || '(none)'));
  } else {
    lines.push(
      'Ollama: not responding at ' + ollamaUrl + ' (optional — local mode only)'
    );
  }

  const selInfo = selectors.info();
  lines.push(
    'Active selectors: v' +
      selInfo.version +
      ' — source: ' +
      selInfo.source +
      (selInfo.remoteUrl
        ? ' (' +
          selInfo.remoteUrl +
          (selInfo.remoteFetchedAt
            ? ', downloaded at ' + new Date(selInfo.remoteFetchedAt).toLocaleString()
            : '') +
          ')'
        : '') +
      ' | bundled: v' +
      selInfo.bundledVersion
  );

  const learned = selectors.listLearned();
  lines.push('Auto-repaired selectors (overrides): ' + learned.length);
  for (const l of learned) {
    lines.push('  - ' + l.provider + '.' + l.slot + ' → ' + l.selector);
  }

  // v1.1.0: starea serverelor MCP (active, unelte expuse, erori de pornire)
  lines.push(...mcp.statusLines());

  // v1.7.3: captarea audio pentru voice input (rulează în Extension Host)
  lines.push('Voice input (captare): ' + (await voiceBackendInfo()));

  for (const line of lines) logLine('diagnostics', line);
  channel.show();
  vscode.window.showInformationMessage(
    'Freekit: diagnostics were written to Output → Freekit.'
  );
}
