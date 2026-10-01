import * as vscode from 'vscode';
import { BrowserManager, detectBrowserPath } from './browser';
import { selectors } from './selectors';
import { initLogChannel, logLine } from './log';
import { ollamaBaseUrl } from './providers/ollama';
import { mcp } from './mcp/manager';
import { voiceBackendInfo } from './voiceRecorder';

/* =========================================================================
 * v0.3.0 (P0.5) — comanda "AI Bridge: Diagnostics"
 * Verifică: browser detectat, port CDP, profil, Ollama, selectori reparați,
 * workspace trust. Scrie totul în canalul de log "AI Bridge".
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

  lines.push('===== AI Bridge Diagnostics — ' + new Date().toLocaleString() + ' =====');
  lines.push(
    'Extensie: ' +
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
      (vscode.workspace.isTrusted ? 'TRUSTED' : 'RESTRICTED (extensia nu va executa unelte)') +
      ' | folder: ' +
      (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(niciunul deschis)')
  );

  const chrome = await detectBrowserPath(opts.chromePath);
  lines.push(
    'Chrome/Edge: ' +
      (chrome ??
        'NEGĂSIT — instalează Chrome sau Edge, ori setează aiBridge.chromePath')
  );

  const running = await browser.isRunning();
  const version = running ? await browser.chromeVersion() : null;
  lines.push(
    'CDP: portul ' +
      opts.port +
      (running
        ? ' — răspunde (' + (version ?? 'versiune necunoscută') + ')'
        : ' — nu răspunde (browserul nu rulează acum)')
  );
  lines.push('Profil Chrome: ' + opts.profileDir);

  const ollamaUrl = ollamaBaseUrl();
  const ollama = await fetchJson(ollamaUrl + '/api/tags', 2500);
  if (ollama) {
    const models = Array.isArray(ollama.models)
      ? ollama.models.map((m: any) => m?.name).filter(Boolean)
      : [];
    lines.push('Ollama: OK — modele: ' + (models.join(', ') || '(niciunul)'));
  } else {
    lines.push(
      'Ollama: nu răspunde pe ' + ollamaUrl + ' (opțional — doar pentru modul local)'
    );
  }

  const selInfo = selectors.info();
  lines.push(
    'Selectori activi: v' +
      selInfo.version +
      ' — sursă: ' +
      selInfo.source +
      (selInfo.remoteUrl
        ? ' (' +
          selInfo.remoteUrl +
          (selInfo.remoteFetchedAt
            ? ', descărcați la ' + new Date(selInfo.remoteFetchedAt).toLocaleString()
            : '') +
          ')'
        : '') +
      ' | bundled: v' +
      selInfo.bundledVersion
  );

  const learned = selectors.listLearned();
  lines.push('Selectori reparați automat (override-uri): ' + learned.length);
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
    'AI Bridge: diagnostice scrise în Output → AI Bridge.'
  );
}
