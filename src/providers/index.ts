import * as vscode from 'vscode';
import { AIProvider } from './types';
import { DeepSeekProvider } from './deepseek';
import { ChatGPTProvider } from './chatgpt';
import { GeminiProvider } from './gemini';
import { ClaudeProvider } from './claude';
import { OllamaProvider, ollamaBaseUrl, detectOllamaCli, listOllamaModelsDetailed } from './ollama';
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
  /** Portul CDP configurat (freekit.cdpPort). */
  port: number;
  /** URL-ul Ollama configurat (freekit.ollamaUrl). */
  ollamaUrl: string;
  /** v2.0.2: binarul `ollama` există pe mașină (chiar dacă serverul nu răspunde). */
  ollamaCli: boolean;
  /** v2.0.2: detaliile modelelor instalate (nume + dimensiune pe disc). */
  ollamaModelDetails: Array<{ name: string; sizeBytes: number }>;
}

/**
 * v2.0.2: starea instalării Ollama, pentru butonul „Install Ollama".
 *  - `running`   — serverul răspunde (nimic de instalat);
 *  - `installed` — binarul există, dar serverul nu rulează („ollama serve");
 *  - `missing`   — nimic instalat → are sens pagina de download.
 */
export type OllamaInstallState = 'running' | 'installed' | 'missing';

export function ollamaInstallState(info: ProviderStatusInfo): OllamaInstallState {
  if (info.ollama) return 'running';
  return info.ollamaCli ? 'installed' : 'missing';
}

/** Starea tuturor providerilor: browser (CDP), logare DeepSeek, Ollama + modele. */
export async function getProviderStatus(): Promise<ProviderStatusInfo> {
  const config = vscode.workspace.getConfiguration('freekit');
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
  let ollamaModelDetails: ProviderStatusInfo['ollamaModelDetails'] = [];

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
    ollamaModelDetails = await listOllamaModelsDetailed();
    ollamaModels = ollamaModelDetails.map((m) => m.name);
  }

  // v2.0.2: binarul poate exista chiar dacă serverul nu rulează (deci „Install"
  // nu mai are sens, dar „start ollama serve" da) — proba e cache-uită 60 s.
  const ollamaCli = await detectOllamaCli();

  return {
    browser,
    ollama,
    deepseekLoggedIn,
    ollamaModels,
    port,
    ollamaUrl,
    ollamaCli,
    ollamaModelDetails
  };
}
