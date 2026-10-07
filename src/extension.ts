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
import { ollamaBaseUrl, OLLAMA_DOWNLOAD_URL } from './providers/ollama';
import { getProviderStatus, ollamaInstallState } from './providers';
import { ReportingService } from './reporting';
import { isRestricted, promptForTrust, showRestrictedNotification } from './trust';

/** v0.3.0 (P0.1): opțiunile browserului, citite live din setări. */
function browserOptionsFromConfig(ctx: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('freekit');
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

/**
 * v2.0.0 (rebranding AI Bridge -> Freekit): cheile din globalState au trecut
 * de la prefixul `aiBridge.` la `freekit.`. Copiem o singură dată valorile
 * existente, ca istoricul conversațiilor, checkpoint-urile și preferințele
 * să nu se piardă la upgrade. Cheile vechi NU sunt șterse (rollback sigur).
 */
async function migrateLegacyBrandState(state: vscode.Memento): Promise<void> {
  const NEW_PREFIX = 'freekit.';
  const LEGACY_PREFIX = 'ai' + 'Bridge.';
  const keys = [
    'history',
    'autoApprove',
    'lastBrowserProvider',
    'noAskFiles',
    'verboseMode',
    'checkpoints',
    'conversations',
    'activeConversationId',
    'selectorsAutoCheck',
    'selectorOverrides',
    'remoteSelectors'
  ];
  for (const key of keys) {
    try {
      const legacy = state.get(LEGACY_PREFIX + key);
      if (legacy !== undefined && state.get(NEW_PREFIX + key) === undefined) {
        await state.update(NEW_PREFIX + key, legacy);
      }
    } catch {
      // fail-open: migrarea nu trebuie să blocheze activarea extensiei
    }
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  initLogChannel();
  logLine('extension', 'activated — container: freekit, view: freekit.chatView');
  // v2.4.1 — Restricted Mode (fără Workspace Trust): extensia se activează
  // LIMITAT (doar citire) și îi spune explicit utilizatorului ce are de făcut.
  if (isRestricted()) {
    logLine('trust', 'Restricted Mode: read-only features only until the folder is trusted');
  }
  // v2.4.1: „Trust This Workspace” — comanda din Command Palette + butonul din notificare
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.trustWorkspace', () => promptForTrust())
  );
  // v2.0.0: migrează starea din globalState de dinainte de rebranding
  await migrateLegacyBrandState(ctx.globalState);
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
  // (comanda manuală „Freekit: Update Selectors” ocolește limita).
  const selUrl = selectorsUrlFromSettings();
  if (
    selUrl &&
    vscode.workspace.getConfiguration('freekit').get<boolean>('checkSelectorsOnStartup', true)
  ) {
    if (shouldAutoCheck(ctx.globalState, selUrl)) {
      void checkAndApplyRemote(selUrl, ctx.globalState).then((r) => {
        if (r.status === 'updated') {
          vscode.window.showInformationMessage(
            'Freekit: the selectors were updated automatically to v' +
              r.version +
              '.' +
              (r.changelog ? ' ' + r.changelog : '')
          );
        }
      });
    } else {
      logLine(
        'extension',
        'selectors: automatic check skipped (last check < 24h ago) — use “Freekit: Update Selectors” for a manual one'
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

  // v2.4.0 — integrare self-maintaining cu serverul de raportare:
  // register la prima pornire, health check periodic (selectorii stricați
  // sunt reparați local sau raportați) și fetch periodic de selectori.
  const reporting = new ReportingService(ctx, {
    browser,
    notify: (text) => chatView.postNotice(text)
  });
  ctx.subscriptions.push(reporting);

  // v2.4.1: serviciile care scriu în globalState, vorbesc cu serverul de
  // raportare sau pornesc procese MCP nu pornesc în Restricted Mode; ele sunt
  // activate automat în momentul în care Trust-ul e acordat.
  const startTrustedFeatures = () => {
    reporting.start();
    void mcp.init(ctx, (text) => chatView.postNotice(text));
  };

  // v2.4.0: starea integrării + acțiuni de control
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.reportingStatus', async () => {
      const text = 'Freekit reporting — ' + reporting.client.statusText();
      logLine('reporting', 'status: ' + reporting.client.statusText());
      const pick = await vscode.window.showInformationMessage(
        text,
        'Run health check now',
        'Reset registration'
      );
      if (pick === 'Run health check now') {
        await vscode.commands.executeCommand('freekit.reportingCheckNow');
      } else if (pick === 'Reset registration') {
        await vscode.commands.executeCommand('freekit.reportingReset');
      }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.reportingCheckNow', async () => {
      // v2.4.1: verificarea deschide tab-uri și trimite rapoarte — doar cu Trust
      if (isRestricted()) {
        showRestrictedNotification(true);
        return;
      }
      const client = reporting.client;
      if (!client.enabled) {
        vscode.window.showWarningMessage(
          'Freekit: reporting is disabled (freekit.reporting.enabled).'
        );
        return;
      }
      const key = await client.ensureRegistered();
      if (!key) {
        vscode.window.showWarningMessage(
          'Freekit: could not reach the reporting server (' +
            client.endpoint +
            '). Check your connection or the freekit.reporting.endpoint setting.'
        );
        return;
      }
      const out = await reporting.runHealthCheck(true);
      if (!out.checkedProviders.length) {
        vscode.window.showInformationMessage(
          'Freekit: no web AI chat tab is open, so there was nothing to check — open a provider in Chrome first.'
        );
        return;
      }
      vscode.window.showInformationMessage(
        'Freekit: health check done — ' +
          out.checkedProviders.join(', ') +
          '. ' +
          (out.failures.length
            ? out.failures.length + ' selector failure(s) were reported to the server.'
            : 'All selectors are healthy.')
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.reportingReset', async () => {
      const pick = await vscode.window.showWarningMessage(
        'Freekit: remove the local reporting identity? The extension will register again as a new installation on the next start.',
        { modal: true },
        'Reset'
      );
      if (pick !== 'Reset') return;
      await reporting.client.resetIdentity();
      vscode.window.showInformationMessage('Freekit: reporting identity reset.');
    })
  );

  // v1.6.0: limba voice input (butonul 🎤 din chat)
  // v1.7.3: limba e citită de extensie la momentul transcrierii — nu mai
  // trebuie trimisă webview-ului la schimbarea setării (captarea rulează în host)

  // v1.7.2: setup Whisper local — descarcă binarele whisper.cpp + modelul
  // ggml-base în globalStorage (o singură dată), pentru voice input offline
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.setupWhisper', async () => {
      const gs = ctx.globalStorageUri.fsPath;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Freekit: local Whisper setup (offline STT)',
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
            vscode.window.showInformationMessage('Freekit: ' + msg);
            chatView.postNotice('🎤 ' + msg);
          } else {
            vscode.window.showErrorMessage(
              'Freekit: local Whisper setup failed — ' + (res.error ?? 'unknown error')
            );
            chatView.postNotice(
              '🎤 ⚠️ Local Whisper setup failed: ' + (res.error ?? 'unknown error')
            );
          }
        }
      );
    })
  );

  // v2.0.2: „Install Ollama" — butonul care duce la pagina oficială de download.
  // Dacă Ollama e deja prezent, nu mai deschidem pagina: spunem ce lipsește
  // (serverul pornit cu „ollama serve").
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.installOllama', async () => {
      const state = ollamaInstallState(await getProviderStatus());
      if (state === 'running') {
        vscode.window.showInformationMessage(
          'Freekit: Ollama is already running at ' + ollamaBaseUrl() + '.'
        );
        return;
      }
      if (state === 'installed') {
        vscode.window.showInformationMessage(
          'Freekit: Ollama is installed but not running — start the server with "ollama serve".'
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
      vscode.window.showInformationMessage(
        'Freekit: install Ollama from the page that just opened, then run "ollama serve".'
      );
      chatView.postNotice(
        '🦙 Ollama is not installed — the download page was opened. After installing it, run "ollama serve".'
      );
    })
  );

  // v2.5.11 (bug #21): „Open Browser" și „Show Chrome" făceau lucruri aproape
  // identice (ambele porneau Chrome, dar „Open Browser" îl lăsa ascuns), ceea ce
  // crea confuzie. Comanda rămâne înregistrată ca alias ascuns pentru
  // back-compat (nu mai e listată în Command Palette), dar face exact ce face
  // „Show Browser": pornește Chrome dacă e nevoie ȘI îl aduce pe ecran.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.openBrowser', () =>
      chatView.showChrome()
    )
  );

  // v0.3.0 (P0.3): Close Browser chiar închide procesul
  // (CDP Browser.close, cu fallback kill pe PID-ul care ascultă pe port)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.closeBrowser', async () => {
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
    vscode.commands.registerCommand('freekit.resetSelectors', async () => {
      const removed = selectors.reset();
      // v2.5.44 (bug #101): selecțiile scrise manual (user-locked) se păstrează
      const kept = selectors.lockedCount();
      if (removed === 0 && kept === 0) {
        vscode.window.showInformationMessage(
          'Freekit: no saved repaired selectors were found.'
        );
      } else {
        vscode.window.showInformationMessage(
          'Freekit: removed ' +
            removed +
            ' saved repaired selectors. The configured selectors are being used again' +
            ' (bundled or remote, if enabled).' +
            (kept
              ? ' Kept ' +
                kept +
                ' manual (user-locked) selector(s) — edit selectors-user.json to change them.'
              : '')
        );
      }
    })
  );

  // v0.7.0: update manual al selectorilor din Gist-ul configurat
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.updateSelectors', async () => {
      const url = selectorsUrlFromSettings();
      if (!url) {
        vscode.window.showWarningMessage(
          'Freekit: set the "freekit.selectorsUrl" value first (the raw Gist URL for selectors.json).'
        );
        return;
      }
      // v0.7.1: și verificarea manuală resetează ceasul de 24h
      const r = await checkAndApplyRemote(url, ctx.globalState);
      if (r.status === 'updated') {
        const from = r.previousVersion ? ' (v' + r.previousVersion + ' → v' + r.version + ')' : '';
        vscode.window.showInformationMessage(
          'Freekit: the selectors were updated' +
            from +
            '.' +
            (r.changelog ? ' ' + r.changelog : '')
        );
      } else if (r.status === 'up-to-date') {
        vscode.window.showInformationMessage(
          'Freekit: the selectors are already up to date (v' + (r.activeVersion ?? '?') + ').'
        );
      } else {
        vscode.window.showErrorMessage(
          'Freekit: updating the selectors failed — ' + (r.message ?? 'unknown error')
        );
      }
    })
  );

  // v0.3.0 (P0.5): comanda Diagnostics
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.diagnostics', () =>
      runDiagnostics(browser, ctx)
    )
  );

  // v0.4.0: Show Browser — aduce fereastra offscreen (-32000,-32000) în față
  // v2.5.11 (bug #21): singurul buton vizibil pentru aducerea browserului pe ecran
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.showChrome', () =>
      chatView.showChrome()
    )
  );

  // v0.4.0: raport detaliat al providerilor (browser CDP / DeepSeek / Ollama)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.showProviderStatus', () =>
      chatView.showProviderStatusReport()
    )
  );

  // v0.5.0: golește lista „nu mai întreba" pentru aprobările de fișiere
  // (fișierele aprobate cu „Accept (nu mai întreba)" în diff-ul nativ)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.clearNoAsk', () =>
      chatView.clearNoAskFiles()
    )
  );

  // v1.8.1: oprește toate serverele de dezvoltare pornite de AI într-un
  // terminal VS Code (scripturi/comenzi dev, start, serve, watch, preview —
  // ex. „npm run dev”): Ctrl+C grațios, apoi închiderea terminalului
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.stopDevServers', async () => {
      const report = await stopDevServers();
      const total = report.stopped.length + report.failed.length;
      if (!total) {
        vscode.window.showInformationMessage(
          'Freekit: no development server started by Freekit is currently running.'
        );
        return;
      }
      if (report.failed.length) {
        vscode.window.showWarningMessage(
          'Freekit: ' +
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
          'Freekit: ' +
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
    vscode.commands.registerCommand('freekit.indexWorkspace', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'Freekit: open a folder (workspace) before indexing.'
        );
        return;
      }
      const cfg = semanticConfig();
      if (!(await isOllamaUp())) {
        const msg =
          'Ollama is not reachable at ' + ollamaBaseUrl() + '. Start it with "ollama serve".';
        vscode.window.showErrorMessage('Freekit: ' + msg);
        chatView.postNotice('🔎 ⚠️ Semantic index: ' + msg);
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Freekit: indexing workspace with ' + cfg.model,
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
              vscode.window.showWarningMessage('Freekit: indexing cancelled — ' + summary);
            } else {
              vscode.window.showInformationMessage('Freekit: semantic index ready — ' + summary);
            }
            chatView.postNotice('🔎 Semantic index: ' + summary);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            logLine('indexer', 'index workspace failed: ' + msg);
            vscode.window.showErrorMessage('Freekit: indexing failed — ' + msg);
            chatView.postNotice('🔎 ⚠️ Indexing failed: ' + msg);
          } finally {
            sub.dispose();
          }
        }
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.indexStatus', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'Freekit: open a folder (workspace) to see the index status.'
        );
        return;
      }
      const text = await indexStatusText(root);
      logLine('indexer', text.replace(/\n/g, ' | '));
      vscode.window.showInformationMessage(
        'Freekit: ' + text.split('\n').slice(0, 4).join(' · ')
      );
      chatView.postNotice('🔎 ' + text.split('\n').join('\n'));
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.clearIndex', async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showWarningMessage(
          'Freekit: open a folder (workspace) first.'
        );
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        'Freekit: delete the semantic index for "' +
          path.basename(root) +
          '"? The vector store is removed from globalStorage; you can rebuild it anytime with "Index Workspace".',
        { modal: true },
        'Delete Index'
      );
      if (answer !== 'Delete Index') return;
      const removed = await clearIndex(root);
      if (removed) {
        vscode.window.showInformationMessage('Freekit: semantic index deleted.');
        chatView.postNotice('🔎 Semantic index deleted.');
      } else {
        vscode.window.showInformationMessage(
          'Freekit: there was no semantic index to delete.'
        );
      }
    })
  );

  // v1.10.0: indexare incrementală la salvare (opțional, freekit.semanticIndex.onSave)
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
  // .vscode/mcp.json sau în freekit.mcpServers, descoperă uneltele lor și le
  // expune AI-ului ca „mcp_<server>_<tool>”. Reîncărcare automată la
  // modificarea configului; UI de gestionare în comanda dedicată.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('freekit.mcpManage', () => {
      // v2.4.1: MCP pornește procese externe — doar cu Workspace Trust
      if (isRestricted()) {
        showRestrictedNotification(true);
        return;
      }
      return mcp.showManagerUi();
    })
  );

  // v2.4.1: activarea completă (reporting + MCP) cere Workspace Trust. În
  // Restricted Mode rămân doar funcțiile de citire, iar utilizatorul primește
  // notificarea-imposibil-de-ratat cu butonul „Trust Workspace”.
  if (isRestricted()) {
    showRestrictedNotification();
    logLine('trust', 'deferred features until trust: reporting, MCP');
  } else {
    startTrustedFeatures();
  }

  // Trust acordat fără reload (ex. din dialogul nativ): pornim serviciile
  // amânate și confirmăm în chat că modul complet e activ.
  ctx.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (isRestricted()) return;
      logLine('trust', 'workspace trust granted — enabling reporting + MCP');
      startTrustedFeatures();
      chatView.postNotice(
        '✅ Workspace trusted — Freekit full mode enabled (file writes, commands and MCP tools unlocked).'
      );
    })
  );

  // v1.8.1: serverele de dezvoltare pornite în terminale VS Code (run_npm /
  // run_command cu scripturi dev/serve/watch) sunt oprite best-effort la
  // închiderea ferestrei — altfel ar rămâne procese orfane pe care comanda
  // Stop Dev Servers nu le mai poate găsi (registrul e în memorie).
  ctx.subscriptions.push({ dispose: () => void stopDevServers() });

  // la dezactivare doar deconectăm — NU omorâm Chrome (poate fi folosit în continuare)
  ctx.subscriptions.push({ dispose: () => browser.disconnect() });
}

export function deactivate() {}