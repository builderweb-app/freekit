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
      ', sursă: ' +
      cfg.source +
      (cfg.remoteUrl ? ' — ' + cfg.remoteUrl : '') +
      ') — provideri: ' +
      cfg.providers.join(', ') +
      ' — override-uri salvate: ' +
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
            'AI Bridge: selectorii au fost actualizați automat la v' +
              r.version +
              '.' +
              (r.changelog ? ' ' + r.changelog : '')
          );
        }
      });
    } else {
      logLine(
        'extension',
        'selectors: verificare automată sărită (ultima verificare < 24h) — folosește „AI Bridge: Update Selectors” pentru una manuală'
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
              'Whisper local e gata ✓ — ' +
              path.basename(res.cliPath ?? '') +
              ' + ' +
              path.basename(res.modelPath ?? '');
            vscode.window.showInformationMessage('AI Bridge: ' + msg);
            chatView.postNotice('🎤 ' + msg);
          } else {
            vscode.window.showErrorMessage(
              'AI Bridge: setup Whisper a eșuat — ' + (res.error ?? 'eroare necunoscută')
            );
            chatView.postNotice(
              '🎤 ⚠️ Setup Whisper a eșuat: ' + (res.error ?? 'eroare necunoscută')
            );
          }
        }
      );
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.openBrowser', async () => {
      await browser.ensureOpen();
      vscode.window.showInformationMessage('Conectat la Chrome (profilul AI Bridge).');
    })
  );

  // v0.3.0 (P0.3): Close Browser chiar închide procesul
  // (CDP Browser.close, cu fallback kill pe PID-ul care ascultă pe port)
  ctx.subscriptions.push(
    vscode.commands.registerCommand('aiBridge.closeBrowser', async () => {
      const closed = await browser.close();
      if (closed) {
        vscode.window.showInformationMessage('Chrome închis.');
      } else {
        vscode.window.showWarningMessage(
          'Nu am putut închide Chrome — închide-l manual din Task Manager.'
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
          'AI Bridge: nu există selectori reparați salvați.'
        );
      } else {
        vscode.window.showInformationMessage(
          'AI Bridge: am șters ' +
            removed +
            ' selectori reparați. Se folosesc din nou selectorii configurați' +
            ' (bundled sau remote, dacă e activ).'
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
          'AI Bridge: setează mai întâi „aiBridge.selectorsUrl” (URL-ul raw al Gist-ului cu selectors.json).'
        );
        return;
      }
      // v0.7.1: și verificarea manuală resetează ceasul de 24h
      const r = await checkAndApplyRemote(url, ctx.globalState);
      if (r.status === 'updated') {
        const from = r.previousVersion ? ' (v' + r.previousVersion + ' → v' + r.version + ')' : '';
        vscode.window.showInformationMessage(
          'AI Bridge: selectorii au fost actualizați' +
            from +
            '.' +
            (r.changelog ? ' ' + r.changelog : '')
        );
      } else if (r.status === 'up-to-date') {
        vscode.window.showInformationMessage(
          'AI Bridge: selectorii sunt deja la zi (v' + (r.activeVersion ?? '?') + ').'
        );
      } else {
        vscode.window.showErrorMessage(
          'AI Bridge: actualizarea selectorilor a eșuat — ' + (r.message ?? 'eroare necunoscută')
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

  // la dezactivare doar deconectăm — NU omorâm Chrome (poate fi folosit în continuare)
  ctx.subscriptions.push({ dispose: () => browser.disconnect() });
}

export function deactivate() {}