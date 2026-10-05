import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Page } from 'playwright';
import { AIProvider, SendOptions } from './types';
import { logLine } from '../log';
import {
  DetectedProviderError,
  detectProviderError,
  ollamaModelMissing
} from '../providerErrors';

const log = (msg: string) => logLine('ollama', msg);

const execFileAsync = promisify(execFile);

/** v0.4.0: URL-ul de bază Ollama (setarea freekit.ollamaUrl; fără slash final). */
export function ollamaBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration('freekit');
  const raw = String(cfg.get<string>('ollamaUrl', '') || '').trim();
  return (raw || 'http://localhost:11434').replace(/\/+$/, '');
}

/** v2.0.2: pagina oficială de download (butonul „Install Ollama"). */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/** v2.0.2: locurile în care se instalează Ollama dar care nu ajung în PATH. */
const OLLAMA_CLI_CANDIDATES = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
  path.join(os.homedir(), '.ollama', 'bin', 'ollama'),
  '/usr/local/bin/ollama',
  '/usr/bin/ollama',
  '/opt/homebrew/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama'
];

/**
 * v2.0.2: există un binar `ollama` pe mașină?
 * Întâi îl rulează (`ollama --version`), apoi caută în PATH, apoi verifică
 * locațiile standard de instalare care nu sunt adăugate în PATH.
 * Rezultatul e ținut minte 60 s (statusul e reîmprospătat la fiecare 15 s).
 */
export async function detectOllamaCli(): Promise<boolean> {
  const now = Date.now();
  if (cliCache && (cliCache.value || now - cliCache.at < 60_000)) return cliCache.value;

  const value = await probeOllamaCli();
  cliCache = { value, at: now };
  log('ollama CLI ' + (value ? 'detected' : 'not found'));
  return value;
}

let cliCache: { value: boolean; at: number } | null = null;

async function probeOllamaCli(): Promise<boolean> {
  try {
    await execFileAsync('ollama', ['--version'], { timeout: 4000, windowsHide: true });
    return true;
  } catch (e: any) {
    // procesul a pornit dar a ieșit cu cod ≠ 0 → binarul există oricum
    if (e && typeof e.code === 'number') return true;
  }

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(finder, ['ollama'], { timeout: 4000, windowsHide: true });
    return true;
  } catch {
    /* nu e în PATH */
  }

  return OLLAMA_CLI_CANDIDATES.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export interface OllamaModelDetails {
  name: string;
  /** Dimensiunea pe disc, în bytes (0 = necunoscută). */
  sizeBytes: number;
}

/** v2.0.2: modelele instalate, cu dimensiune — afișate în meniul de model. */
export async function listOllamaModelsDetailed(): Promise<OllamaModelDetails[]> {
  try {
    const res = await fetch(`${ollamaBaseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = (await res.json()) as any;
    return (data.models || [])
      .map((m: any) => ({
        name: String(m?.name ?? ''),
        sizeBytes: Number(m?.size) || 0
      }))
      .filter((m: OllamaModelDetails) => !!m.name);
  } catch {
    return [];
  }
}

export interface PullProgress {
  status: string;
  /** 0–100 când Ollama raportează total; `null` altfel. */
  percent: number | null;
}

/**
 * v2.0.2: descarcă (`ollama pull`) un model, cu progres live.
 * Ollama răspunde cu NDJSON (`{"status":…,"completed":…,"total":…}`).
 */
export async function pullOllamaModel(
  model: string,
  onProgress?: (p: PullProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${ollamaBaseUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal
  });

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      const err = (await res.json()) as any;
      if (err?.error) detail = ' — ' + err.error;
    } catch {
      /* corp fără JSON */
    }
    throw new Error(`Ollama pull failed: ${res.status} ${res.statusText}${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: any;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (evt?.error) throw new Error(String(evt.error));
    const total = Number(evt?.total) || 0;
    const completed = Number(evt?.completed) || 0;
    onProgress?.({
      status: String(evt?.status ?? ''),
      percent: total > 0 ? Math.round((completed / total) * 100) : null
    });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handle(line);
    }
  }
  handle(buffer);
  log('pull finished: ' + model);
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
  /** v0.4.0: configurabil prin freekit.ollamaUrl (implicit localhost:11434). */
  get url(): string {
    return ollamaBaseUrl();
  }
  /** Marchează providerul ca local: fără Chrome/CDP, fără selectori. */
  readonly local = true;

  private history: Array<{ role: string; content: string }> = [];

  /** v2.5.11: modelul local configurat (freekit.ollamaModel). */
  private configuredModel(): string {
    return vscode.workspace
      .getConfiguration('freekit')
      .get<string>('ollamaModel', 'qwen2.5-coder:7b');
  }

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

    // v2.5.11 (bug #24/#25): modelul configurat trebuie să existe local. Fără
    // verificarea asta, `send` lovea un 404 sec, afișat ca text brut în chat.
    // Lista e deja adusă aici, deci verificarea nu costă nimic în plus.
    const configured = this.configuredModel();
    if (!models.includes(configured)) {
      throw new DetectedProviderError(
        'ollama',
        ollamaModelMissing(configured, models)
      );
    }
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
    const model = this.configuredModel();

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
      let body = '';
      try {
        const err = (await response.json()) as any;
        if (err?.error) {
          body = String(err.error);
          detail = ' — ' + body;
        }
      } catch {
        /* corp fără JSON */
      }
      // v2.5.11 (bug #25): model lipsă → eroare tipizată, ca chatView să
      // afișeze cardul dedicat (buton „Download model"), nu textul brut de 404.
      const detected = detectProviderError(body, 'ollama');
      if (detected?.kind === 'model_missing' || response.status === 404) {
        const available = await this.listModels().catch(() => []);
        throw new DetectedProviderError(
          'ollama',
          detected?.kind === 'model_missing' && detected.model
            ? { ...detected, availableModels: available }
            : ollamaModelMissing(this.configuredModel(), available)
        );
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
      const res = await fetch(`${this.url}/api/tags`, {
        // v2.5.11: același timeout ca `listOllamaModelsDetailed` — un server
        // care nu răspunde nu trebuie să blocheze fluxul de eroare.
        signal: AbortSignal.timeout(5000)
      });
      const data = (await res.json()) as any;
      return (data.models || []).map((m: any) => m.name);
    } catch {
      return [];
    }
  }
}
