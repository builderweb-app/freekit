import * as vscode from 'vscode';
import * as path from 'path';
import { BrowserManager } from './browser';
import { ChatViewProvider } from './chatView';
import { configInfo, selectors, selectorsUrlFromSettings } from './selectors';
import { initLogChannel, logLine } from './log';
import { runDiagnostics } from './diagnostics';
import { checkAndApplyRemote, shouldAutoCheck } from './remoteSelectors';
import { initAISelectorFinder } from './ai-selector-finder';
import { mcp } from './mcp/manager';
import { setupWhisperAssets } from './stt';
import { stopDevServers } from './devServers';
import {
  clearIndex,
  indexSingleFile,
  indexStatusText,
  indexWorkspace,
  initIndexer,
  isOllamaUp,
  isSemanticEnabled,
  semanticConfig,
  workspaceRoot
} from './indexer';
import { ollamaBaseUrl } from './providers/ollama';

/** v0.3.0 (P0.1): opțiunile browserului, citite live din setări. */
function browserOptionsFromConfig(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('aiBridge');
  const rawPort = Number(cfg.get<number>('cdpPort', 9222));
  const port =
    Number.isFinite(rawPort) && rawPort >= 1024 && rawPort <= 65535
      ? Math.floor(rawPort)
      : 9222;
  const chromePath = String(cfg.get<string>('chromePath', '') || '').trim();
  return {
    port,
    // P0.1: profilul stă în globalStorage (NU în folderul proiectului)
    profileDir: path.join(ctx.globalStorageUri.fsPath, 'chrome-profile'),
    chromePath: chromePath || undefined
  };
}

export async function activate(ctx: vscode.ExtensionContext) {
  initLogChannel();
  logLine('extension', 'activated — container: aiBridge, view: aiBridge.chatView');
  // v1.10.0: indexarea semantică (vector store JSON în globalStorage)
  initIndexer(ctx.globalStorageUri.fsPath);
  const browser = new BrowserManager(() => browserOptionsFromConfig(ctx));

  // FAZA I: cache-ul de selectori (override-urile reparate în globalState)
  selectors.init(ctx.globalState);
  // v0.9.5: AI selector discovery (fallback pe Ollama) + selectors-user.json
  initAISelectorFinder(ctx.globalStorageUri.fsPath);
  const cfg = configInfo();
  logLine(
    'extension',
    'selectors v' +
      cfg.version +
      ' (' +
      cfg.updated +
      ', source: ' +
      cfg.source +
      (cfg.remoteUrl ? ' — ' + cfg.remoteUrl : '') +
      ') — providers: ' +
      cfg.providers.join(', ') +
      ' — saved overrides: ' +
      selectors.listLearned().length
  );

  // v0.7.0: verificare automată a selectorilor remote la pornire (opțional)
  // v0.7.1: rate limiting 24h — cel mult o verificare automată pe zi
  // (comanda manuală „AI Bridge: Update Selectors” ocolește limita).
  const selUrl = selectorsUrlFromSettings();
  if (
    selUrl &&
    vscode.workspace.getConfiguration('aiBridge').get<boolean>('checkSelectorsOnStartup', true)
  ) {
    if (shouldAutoCheck(ctx.globalState, selUrl)) {
      void checkAndApplyRemote(selUrl, ctx.globalState).then((r) => {
        if (r.status === 'updated') {
          vscode.window.showInformationMessage(
            'AI Bridge: the selectors were updated automatically to v' +
              r.version +
              '.' +
              (r.changelog ? ' ' + r.changelog : '')
          );
        }
      });
    } else {
      logLine(
        'extension',
        'selectors: automatic check skipped (last check < 24h ago) — use “AI Bridge: Update Selectors” for a manual one'
      );
    }
  }

  const chatView = new ChatViewProvider(
    ctx.extensionUri,
    browser,
    ctx.globalState,
    // v1.7.2: asset-urile Whisper (voice input offline) stau în globalStorage
    ctx.globalStorageUri.fsPath
  );
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView)
  );

  // v1.6.0: limba voice input (butonul 🎤 din chat)
  // v1.7.3: limba e citită de extensie la momentul transcrierii — nu mai
  // trebuie trimisă webview-ului la schimbarea setării (captarea rulează în host)

  // v1.7.2: setup Whisper local — descarcă binarele whisper.cpp + modelul
  // ggml-base în globalStorage (o singură dată), pentru voice input offline
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.setupWhisper', async () => {
      const gs = ctx.globalStorageUri.fsPath;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AI Bridge: setup Whisper local (offline STT)',
          cancellable: false
        },
        async (prog) => {
          const res = await setupWhisperAssets(gs, (pct, label) =>
            prog.report({
              message: label + (pct >= 0 ? ' — ' + pct + '%' : '…')
            })
          );
          if (res.ok) {
            const msg =
              'Local Whisper is ready ✓ — ' +
              path.basename(res.cliPath ?? '') +
              ' + ' +
              path.basename(res.modelPath ?? '');
            vscode.window.showInformationMessage('AI Bridge: ' + msg);
            chatView.postNotice('🎤 ' + msg);
          } else {
            vscode.window.showErrorMessage(
              'AI Bridge: local Whisper setup failed — ' + (res.error ?? 'unknown error')
            );
            chatView.postNotice(
              '🎤 ⚠️ Local Whisper setup failed: ' + (res.error ?? 'unknown error')
            );
          }
        }
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.openBrowser', async () => {
      await browser.ensureOpen();
      vscode.window.showInformationMessage('Connected to Chrome (AI Bridge profile).');
    })
  );

  // v0.3.0 (P0.3): Close Browser chiar închide procesul
  // (CDP Browser.close, cu fallback kill pe PID-ul care ascultă pe port)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.closeBrowser', async () => {
      const closed = await browser.close();
      if (closed) {
        vscode.window.showInformationMessage('Chrome closed.');
      } else {
        vscode.window.showWarningMessage(
          'I could not close Chrome — please close it manually from Task Manager.'
        );
      }
    })
  );

  // FAZA I: uită selectorii învățați (revin la cei din selectors.json)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.resetSelectors', async () => {
      const removed = selectors.reset();
      if (removed === 0) {
        vscode.window.showInformationMessage(
          'AI Bridge: no saved repaired selectors were found.'
        );
      } else {
        vscode.window.showInformationMessage(
          'AI Bridge: removed ' +
            removed +
            ' saved repaired selectors. The configured selectors are being used again' +
            ' (bundled or remote, if enabled).'
        );
      }
    })
  );

  // v0.7.0: update manual al selectorilor din Gist-ul configurat
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.updateSelectors', async () => {
      const url = selectorsUrlFromSettings();
      if (!url) {
        vscode.window.showWarningMessage(
          'AI Bridge: set the "aiBridge.selectorsUrl" value first (the raw Gist URL for selectors.json).'
        );
        return;
      }
      // v0.7.1: și verificarea manuală resetează ceasul de 24h
      const r = await checkAndApplyRemote(url, ctx.globalState);
      if (r.status === 'updated') {
        const from = r.previousVersion ? ' (v' + r.previousVersion + ' → v' + r.version + ')' : '';
        vscode.window.showInformationMessage(
          'AI Bridge: the selectors were updated' +
            from +
            '.' +
            (r.changelog ? ' ' + r.changelog : '')
        );
      } else if (r.status === 'up-to-date') {
        vscode.window.showInformationMessage(
          'AI Bridge: the selectors are already up to date (v' + (r.activeVersion ?? '?') + ').'
        );
      } else {
        vscode.window.showErrorMessage(
          'AI Bridge: updating the selectors failed — ' + (r.message ?? 'unknown error')
        );
      }
    })
  );

  // v0.3.0 (P0.5): comanda Diagnostics
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.diagnostics', () =>
      runDiagnostics(browser, ctx)
    )
  );

  // v0.4.0: Show Chrome — aduce fereastra offscreen (-32000,-32000) în față
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.showChrome', () =>
      chatView.showChrome()
    )
  );

  // v0.4.0: raport detaliat al providerilor (browser CDP / DeepSeek / Ollama)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.showProviderStatus', () =>
      chatView.showProviderStatusReport()
    )
  );

  // v0.5.0: golește lista „nu mai întreba" pentru aprobările de fișiere
  // (fișierele aprobate cu „Accept (nu mai întreba)" în diff-ul nativ)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.clearNoAsk', () =>
      chatView.clearNoAskFiles()
    )
  );

  // v1.8.1: oprește toate serverele de dezvoltare pornite de AI într-un
  // terminal VS Code (scripturi/comenzi dev, start, serve, watch, preview —
  // ex. „npm run dev”): Ctrl+C grațios, apoi închiderea terminalului
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.stopDevServers', async () => {
      const report = await stopDevServers();
      const total = report.stopped.length + report.failed.length;
      if (!total) {
        vscode.window.showInformationMessage(
          'AI Bridge: no development server started by AI Bridge is currently running.'
        );
        return;
      }
      if (report.failed.length) {
        vscode.window.showWarningMessage(
          'AI Bridge: ' +
            report.stopped.length +
            ' development server(s) stopped, ' +
            report.failed.length +
            ' could not be stopped (' +
            report.failed
              .map((f) => f.terminalName || 'PID ' + f.pid)
              .join(', ') +
            ').'
        );
      } else {
        vscode.window.showInformationMessage(
          'AI Bridge: ' +
            report.stopped.length +
            ' development server(s) stopped: ' +
            report.stopped
              .map((s) => s.command + ' (terminal “' + s.terminalName + '”)')
              .join('; ')
        );
      }
      logLine(
        'devServers',
        'Stop Dev Servers: ' +
          report.stopped.length +
          ' stopped' +
          (report.stopped.length
            ? ' (' +
              report.stopped
                .map((s) => s.terminalName + ': ' + s.command)
                .join(', ') +
              ')'
            : '') +
          (report.failed.length ? ' — ' + report.failed.length + ' failed' : '')
      );
    })
  );

  /* =======================================================================
   * v1.10.0 — INDEXARE SEMANTICĂ (embeddings Ollama + vector store local)
   * Trei comenzi: Index Workspace / Index Status / Clear Index. Indexarea
   * rulează cu progres anulabil în bara de notificări; căutarea semantică e
   * expusă AI-ului prin unealta `search_semantic`.
   * ===================================================================== */

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.indexWorkspace', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'AI Bridge: open a folder (workspace) before indexing.'
        );
        return;
      }
      const cfg = semanticConfig();
      if (!(await isOllamaUp())) {
        const msg =
          'Ollama is not reachable at ' + ollamaBaseUrl() + '. Start it with "ollama serve".';
        vscode.window.showErrorMessage('AI Bridge: ' + msg);
        chatView.postNotice('🔎 ⚠️ Semantic index: ' + msg);
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AI Bridge: indexing workspace with ' + cfg.model,
          cancellable: true
        },
        async (prog, token) => {
          const ac = new AbortController();
          const sub = token.onCancellationRequested(() => ac.abort());
          try {
            const stats = await indexWorkspace(root, {
              signal: ac.signal,
              onProgress: (p) =>
                prog.report({ message: p.done + '/' + p.total + ' — ' + p.file })
            });
            const summary =
              stats.indexed +
              ' files indexed, ' +
              stats.unchanged +
              ' unchanged, ' +
              stats.removed +
              ' removed, ' +
              stats.chunks +
              ' chunks' +
              (stats.skipped ? ', ' + stats.skipped + ' skipped' : '') +
              (stats.failed ? ', ' + stats.failed + ' chunks failed' : '') +
              (stats.cancelled ? ' — cancelled' : '') +
              ' (' +
              Math.round(stats.durationMs / 1000) +
              's)';
            if (stats.cancelled) {
              vscode.window.showWarningMessage('AI Bridge: indexing cancelled — ' + summary);
            } else {
              vscode.window.showInformationMessage('AI Bridge: semantic index ready — ' + summary);
            }
            chatView.postNotice('🔎 Semantic index: ' + summary);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            logLine('indexer', 'index workspace failed: ' + msg);
            vscode.window.showErrorMessage('AI Bridge: indexing failed — ' + msg);
            chatView.postNotice('🔎 ⚠️ Indexing failed: ' + msg);
          } finally {
            sub.dispose();
          }
        }
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.indexStatus', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'AI Bridge: open a folder (workspace) to see the index status.'
        );
        return;
      }
      const text = await indexStatusText(root);
      logLine('indexer', text.replace(/\n/g, ' | '));
      vscode.window.showInformationMessage(
        'AI Bridge: ' + text.split('\n').slice(0, 4).join(' · ')
      );
      chatView.postNotice('🔎 ' + text.split('\n').join('\n'));
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.clearIndex', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'AI Bridge: open a folder (workspace) first.'
        );
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        'AI Bridge: delete the semantic index for "' +
          path.basename(root) +
          '"? The vector store is removed from globalStorage; you can rebuild it anytime with "Index Workspace".',
        { modal: true },
        'Delete Index'
      );
      if (answer !== 'Delete Index') return;
      const removed = await clearIndex(root);
      if (removed) {
        vscode.window.showInformationMessage('AI Bridge: semantic index deleted.');
        chatView.postNotice('🔎 Semantic index deleted.');
      } else {
        vscode.window.showInformationMessage(
          'AI Bridge: there was no semantic index to delete.'
        );
      }
    })
  );

  // v1.10.0: indexare incrementală la salvare (opțional, aiBridge.semanticIndex.onSave)
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingSaves = new Set<string>();
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      if (!isSemanticEnabled() || !semanticConfig().onSave) return;
      const root = workspaceRoot();
      if (!root) return;
      const abs = doc.uri.fsPath;
      if (!abs.startsWith(root)) return;
      pendingSaves.add(abs);
      if (saveTimer) clearTimeout(saveTimer);
      // debounce: mai multe salvări rapide => o singură trecere
      saveTimer = setTimeout(() => {
        const files = Array.from(pendingSaves);
        pendingSaves.clear();
        void (async () => {
          for (const f of files) {
            try {
              await indexSingleFile(root, f);
            } catch (e: any) {
              logLine('indexer', 'on-save indexing failed: ' + (e?.message ?? String(e)));
            }
          }
        })();
      }, 1500);
    })
  );

  // v1.1.0 — MCP (Model Context Protocol): pornește serverele configurate în
  // .vscode/mcp.json sau în aiBridge.mcpServers, descoperă uneltele lor și le
  // expune AI-ului ca „mcp_<server>_<tool>”. Reîncărcare automată la
  // modificarea configului; UI de gestionare în comanda dedicată.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.mcpManage', () =>
      mcp.showManagerUi()
    )
  );
  void mcp.init(ctx, (text) => chatView.postNotice(text));

  // v1.8.1: serverele de dezvoltare pornite în terminale VS Code (run_npm /
  // run_command cu scripturi dev/serve/watch) sunt oprite best-effort la
  // închiderea ferestrei — altfel ar rămâne procese orfane pe care comanda
  // Stop Dev Servers nu le mai poate găsi (registrul e în memorie).
  ctx.subscriptions.push({ dispose: () => void stopDevServers() });

  // la dezactivare doar deconectăm — NU omorâm Chrome (poate fi folosit în continuare)
  ctx.subscriptions.push({ dispose: () => browser.disconnect() });
}

export function deactivate() {}