import * as vscode from 'vscode';
import { Page } from 'playwright';
import { AIProvider, SendOptions } from './types';
import { logLine } from '../log';

const log = (msg: string) => logLine('ollama', msg);

/** v0.4.0: URL-ul de bază Ollama (setarea aiBridge.ollamaUrl; fără slash final). */
export function ollamaBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('aiBridge');
  const raw = String(cfg.get<string>('ollamaUrl', '') || '').trim();
  return (raw || 'http://localhost:11434').replace(/\/+$/, '');
}

/**
 * FAZA IV.1: provider local — vorbește direct cu API-ul Ollama
 * (localhost:11434), FĂRĂ browser / Playwright.
 * `page` e ignorat complet (chatView sare peste Chrome când vede `local`).
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  /** v1.7.1: thinking-ul modelului (câmpul `thinking` din API) → callback chatView. */
  onThinking?: (text: string) => void;
  /** v0.4.0: configurabil prin aiBridge.ollamaUrl (implicit localhost:11434). */
  get url(): string {
    return ollamaBaseUrl();
  }
  /** Marchează providerul ca local: fără Chrome/CDP, fără selectori. */
  readonly local = true;

  private history: Array<{ role: string; content: string }> = [];

  async open(_page?: Page): Promise<void> {
    // Verifică că Ollama rulează
    const ok = await this.isAvailable();
    if (!ok) {
      throw new Error(
        'Ollama is not running at ' + this.url + '. Start it with "ollama serve".'
      );
    }
    const models = await this.listModels();
    log('Ollama available, models: ' + (models.join(', ') || '(none)'));
  }

  async newChat(_page?: Page): Promise<void> {
    this.history = [];
    log('history reset');
  }

  async send(
    _page: Page | undefined,
    message: string,
    signal?: AbortSignal,
    opts?: SendOptions
  ): Promise<string> {
    const config = vscode.workspace.getConfiguration('aiBridge');
    const model = config.get<string>('ollamaModel', 'qwen2.5-coder:7b');

    // Local nu există „upload în chat": binarele/imaginite nu pot pleca.
    // Conținutul text al atașamentelor e deja inclus în `message`.
    if (opts?.files && opts.files.length) {
      opts.onNotice?.(
        '⚠️ Ollama runs locally: binary files/images cannot be sent — ' +
          'only the text content of attachments reaches the model.'
      );
    }

    log('send to ' + model + ', length=' + message.length);
    this.history.push({ role: 'user', content: message });

    const response = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: this.history,
        stream: false,
        options: {
          temperature: 0.3,
          num_ctx: 8192
        }
      }),
      signal
    });

    if (!response.ok) {
      // Ollama pune detaliul în JSON (ex: model negăsit -> 404)
      let detail = '';
      try {
        const err = (await response.json()) as any;
        if (err?.error) detail = ' — ' + err.error;
      } catch {
        /* corp fără JSON */
      }
      throw new Error(
        'Ollama error: ' + response.status + ' ' + response.statusText + detail
      );
    }

    const data = (await response.json()) as any;
    const reply = data.message?.content || '';
    // v1.7.1: thinking separat (modele R1 / Qwen3 / etc.) → callback chatView
    const thinking = data.message?.thinking ?? data.message?.reasoning_content;
    if (typeof thinking === 'string' && thinking.trim()) {
      try {
        this.onThinking?.(thinking);
      } catch {
        /* callback-ul nu trebuie să strice trimiterea */
      }
    }
    log('got reply, length=' + reply.length);

    this.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.url}/api/tags`);
      const data = (await res.json()) as any;
      return (data.models || []).map((m: any) => m.name);
    } catch {
      return [];
    }
  }
}
