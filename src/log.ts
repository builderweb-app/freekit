import type * as vscode from 'vscode';

/* =========================================================================
 * v0.3.0 (P0.5) — canal de log dedicat ("Freekit" în Output)
 * Toate log-urile extensiei trec prin aici: apar în Output → Freekit
 * ȘI în consola Developer Tools (pentru debugging).
 *
 * Notă: `vscode` e importat DOAR ca tip și cerut lazy la runtime — astfel
 * modulul poate fi încărcat și în teste Node, fără VS Code.
 * ========================================================================= */

let channel: vscode.LogOutputChannel | undefined;

/** Se apelează o dată, la activarea extensiei (în interiorul VS Code). */
export function initLogChannel(): vscode.LogOutputChannel {
  if (!channel) {
    const v = require('vscode') as typeof import('vscode');
    channel = v.window.createOutputChannel('Freekit', { log: true });
  }
  return channel;
}

export function logLine(tag: string, msg: string): void {
  try {
    channel?.info('[' + tag + '] ' + msg);
  } catch {
    /* canalul nu e disponibil (ex: teste fără VS Code) */
  }
  console.log('[Freekit][' + tag + '] ' + msg);
}
