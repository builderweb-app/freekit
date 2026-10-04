import * as vscode from 'vscode';
import { logLine } from './log';

/**
 * v2.4.1 — Trust UX.
 *
 * The extension declares `untrustedWorkspaces: limited`, so it ACTIVATES in
 * Restricted Mode instead of staying silent: read-only features keep working
 * and the user gets an unmissable notification with a "Trust Workspace" button.
 * Everything user-facing about Workspace Trust lives here, so the wording is
 * identical in the notification, in the chat card and in the tool errors.
 */

const TRUST_DOC_URL = 'https://code.visualstudio.com/docs/editor/workspace-trust';

/** Anti-spam: o acțiune blocată re-afișează notificarea cel mult o dată la 20 s. */
const RESHOW_COOLDOWN_MS = 20_000;

/** True când fereastra curentă NU are Workspace Trust acordat. */
export function isRestricted(): boolean {
  return !vscode.workspace.isTrusted;
}

/** Cardul persistent din chat (apare la deschiderea view-ului în Restricted Mode). */
export const RESTRICTED_NOTICE =
  'Restricted Mode: Freekit can read files, but writing files, running commands, ' +
  'git changes, MCP tools and the selector health check are disabled until this folder is trusted. ' +
  'Run “Freekit: Trust This Workspace” (or click “Trust Workspace” in the notification) to unlock everything.';

/** Linia scurtă din chat când o acțiune concretă e blocată. */
export const RESTRICTED_BLOCKED_NOTICE =
  'Restricted Mode — the action was blocked. Trust this folder (Command Palette → ' +
  '“Freekit: Trust This Workspace”) to unlock it.';

/** Eroarea trimisă modelului când o unealtă e blocată de Restricted Mode. */
export const RESTRICTED_TOOL_ERROR =
  'Restricted Mode: Freekit cannot write files, run commands, change git state or use MCP tools ' +
  'in an untrusted workspace. Ask the user to trust this folder — Command Palette → ' +
  '"Freekit: Trust This Workspace" (or the Trust Workspace button in the VS Code notification) — ' +
  'then retry. Read-only tools (read_file, list_files, search_files, read_files, project_info, ' +
  'search_semantic, git status/diff/log) still work.';

let shownThisSession = false;
let lastShownAt = 0;

/**
 * Notificarea de activare (imposibil de ratat). Se afișează o singură dată pe
 * sesiune; `force` o re-afișează când utilizatorul chiar încearcă o acțiune
 * blocată, cu limită de timp ca să nu devină spam.
 */
export function showRestrictedNotification(force = false): void {
  if (!isRestricted()) return;
  const now = Date.now();
  if (force) {
    if (now - lastShownAt < RESHOW_COOLDOWN_MS) return;
  } else if (shownThisSession) {
    return;
  }
  shownThisSession = true;
  lastShownAt = now;
  logLine('trust', 'Restricted Mode — showing the Workspace Trust notification');
  void vscode.window
    .showWarningMessage(
      'Freekit is running in Restricted Mode. It can read files, but writing files, running ' +
        'commands, git changes and MCP tools are disabled until this folder is trusted.',
      'Trust Workspace',
      'Learn More'
    )
    .then((pick) => {
      if (pick === 'Trust Workspace') void promptForTrust();
      else if (pick === 'Learn More')
        void vscode.env.openExternal(vscode.Uri.parse(TRUST_DOC_URL));
    });
}

/**
 * Trimite utilizatorul în fluxul nativ de Workspace Trust.
 *
 * `workspace.requestWorkspaceTrust` e încă un API *proposed*, deci folosim
 * comanda stabilă `workbench.trust.manage`: deschide pagina „Manage Workspace
 * Trust”, unde folderul are butonul „Trust” (un click → trust + reload).
 */
export async function promptForTrust(): Promise<void> {
  if (!isRestricted()) {
    vscode.window.showInformationMessage('Freekit: this workspace is already trusted.');
    return;
  }
  try {
    await vscode.commands.executeCommand('workbench.trust.manage');
  } catch (e: any) {
    logLine('trust', 'workbench.trust.manage failed: ' + (e?.message ?? String(e)));
    await vscode.env.openExternal(vscode.Uri.parse(TRUST_DOC_URL));
  }
}
