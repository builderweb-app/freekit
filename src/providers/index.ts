import * as vscode from 'vscode';
import { AIProvider } from './types';
import { DeepSeekProvider } from './deepseek';
import { ChatGPTProvider } from './chatgpt';
import { GeminiProvider } from './gemini';
import { ClaudeProvider } from './claude';
import { OllamaProvider, ollamaBaseUrl } from './ollama';
import { MistralProvider } from './mistral';
import { QwenProvider } from './qwen';
import { KimiProvider } from './kimi';

export const PROVIDER_IDS: string[] = [
  'auto',
  'deepseek',
  'chatgpt',
  'gemini',
  'claude',
  'mistral',
  'qwen',
  'kimi',
  'ollama'
];

export const PROVIDER_LABELS: Record<string, string> = {
  auto: 'Auto (Browser → Ollama)',
  deepseek: 'DeepSeek',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  mistral: 'Mistral (Vibe)',
  qwen: 'Qwen',
  kimi: 'Kimi',
  ollama: 'Ollama (local)'
};

/** Providerii web (prin Chrome/CDP) — folosiți și de lanțul Auto. */
export const BROWSER_PROVIDER_IDS: string[] = [
  'deepseek',
  'chatgpt',
  'gemini',
  'claude',
  'mistral',
  'qwen',
  'kimi'
];

/** Creează adaptorul pentru providerul dat (fallback: DeepSeek). */
export function createProvider(id: string): AIProvider {
  switch (id) {
    case 'chatgpt':
      return new ChatGPTProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'claude':
      return new ClaudeProvider();
    case 'mistral':
      return new MistralProvider();
    case 'qwen':
      return new QwenProvider();
    case 'kimi':
      return new KimiProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      return new DeepSeekProvider();
  }
}

/* =========================================================================
 * v0.4.0 — verificări de disponibilitate + status combinat (folosite de
 * badge-ul din toolbar și de comanda "Show Provider Status").
 * ========================================================================= */

/** Verifică dacă portul CDP al Chrome răspunde (max 2s). */
export async function checkBrowserAvailable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Verifică dacă Ollama răspunde (max 2s). */
export async function checkOllamaAvailable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ProviderStatusInfo {
  browser: boolean;
  ollama: boolean;
  deepseekLoggedIn: boolean;
  ollamaModels: string[];
  /** Portul CDP configurat (aiBridge.cdpPort). */
  port: number;
  /** URL-ul Ollama configurat (aiBridge.ollamaUrl). */
  ollamaUrl: string;
}

/** Starea tuturor providerilor: browser (CDP), logare DeepSeek, Ollama + modele. */
export async function getProviderStatus(): Promise<ProviderStatusInfo> {
  const config = vscode.workspace.getConfiguration('aiBridge');
  const rawPort = Number(config.get<number>('cdpPort', 9222));
  const port =
    Number.isFinite(rawPort) && rawPort >= 1024 && rawPort <= 65535
      ? Math.floor(rawPort)
      : 9222;
  const ollamaUrl = ollamaBaseUrl();

  const browser = await checkBrowserAvailable(port);
  const ollama = await checkOllamaAvailable(ollamaUrl);

  let deepseekLoggedIn = false;
  let ollamaModels: string[] = [];

  if (browser) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const tabs = (await res.json()) as any[];
      deepseekLoggedIn = tabs.some(
        (t: any) =>
          t.url &&
          t.url.startsWith('https://chat.deepseek.com') &&
          !t.url.includes('sign_in')
      );
    } catch {
      /* ignoră */
    }
  }

  if (ollama) {
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`);
      const data = (await res.json()) as any;
      ollamaModels = (data.models || []).map((m: any) => m.name);
    } catch {
      /* ignoră */
    }
  }

  return { browser, ollama, deepseekLoggedIn, ollamaModels, port, ollamaUrl };
}
