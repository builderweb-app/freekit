/**
 * v2.5.1 — ERORI DE PROVIDER (detecție + mesaje clare).
 *
 * Când Claude/ChatGPT/DeepSeek/Gemini/Mistral returnează erori cunoscute („You
 * are out of free messages until 6:20 PM”, rate limit, CAPTCHA, sesiune
 * expirată), textul apare ca banner în pagină — NU în selectorii de răspuns.
 * Fără detecție, Freekit raporta „Timeout: no stable response … after 150s” și
 * utilizatorul credea că extensia e stricată.
 */

export interface ProviderError {
  kind:
    | 'out_of_messages'
    | 'login_required'
    | 'rate_limit'
    | 'captcha'
    | 'model_missing'
    /** v2.5.15 (bug #41): contextul chatului s-a epuizat (ChatGPT „Chat memory full"). */
    | 'memory_full'
    | 'unknown';
  message: string;
  resetTime?: string;
  upgradeUrl?: string;
  /** v2.5.11 (bug #24/#25): modelul local care lipsește (Ollama). */
  model?: string;
  /** v2.5.11 (bug #24/#25): modelele Ollama instalate, pentru cardul din chat. */
  availableModels?: string[];
}

/** Codul purtat de eroarea aruncată către chatView (pentru afișare dedicată). */
export const PROVIDER_ERROR_CODE = 'FREEKIT_PROVIDER_ERROR';

/** Etichete prietenoase pentru mesajul afișat utilizatorului. */
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  mistral: 'Mistral',
  qwen: 'Qwen'
};

/**
 * v2.5.11 (bug #24/#25): eroarea „model Ollama neinstalat", cu lista celor
 * instalate — folosită de `OllamaProvider` (validare în `open` + 404 în `send`).
 */
export function ollamaModelMissing(
  model: string,
  available: string[]
): ProviderError {
  return {
    kind: 'model_missing',
    message: model
      ? 'Model "' + model + '" is not installed in Ollama.'
      : 'The configured Ollama model is not installed.',
    model: model || undefined,
    availableModels: available
  };
}

/**
 * v2.5.15 (bug #41): textul afișat de ChatGPT când contextul chatului s-a
 * epuizat („Chat memory full — continue in a new chat", „memory limit
 * reached"). Folosit atât de detecția din `detectProviderError` (scanul de
 * pagină), cât și direct de `sendAndWait` pe textul citit din răspuns.
 */
export function isMemoryFullText(text: string): boolean {
  return /chat memory full|continue in a new chat|memory limit reached/i.test(
    String(text ?? '')
  );
}

/**
 * v2.5.1: detectează erorile cunoscute în textul brut (răspuns extras din DOM
 * sau textul paginii). Întoarce `null` dacă nu recunoaște nicio eroare.
 */
export function detectProviderError(
  rawText: string,
  providerId: string
): ProviderError | null {
  if (!rawText) return null;

  // v2.5.15 (bug #41): contextul chatului s-a epuizat (ChatGPT free ~8k
  // tokens). Bannerul nu intră în selectorii de răspuns, deci fără detecție
  // agentic loop-ul continua să trimită nudges într-un chat care nu mai poate
  // răspunde, până la timeout.
  if (isMemoryFullText(rawText)) {
    return { kind: 'memory_full', message: 'Chat context limit reached.' };
  }

  // v2.5.11 (bug #25): Ollama — modelul cerut nu e instalat.
  // Corpul răspunsului: `{"error":"model \"x\" not found, try pulling it first"}`.
  if (providerId === 'ollama') {
    const notFound = rawText.match(
      /model\s+["']?([^"'\n,]+?)["']?\s+not found|try pulling it first/i
    );
    if (notFound) {
      return ollamaModelMissing((notFound[1] || '').trim(), []);
    }
  }

  // Out of messages / usage limit
  // v2.5.1: terminator tolerant — bannerele pot termina cu „.”, „!”, newline
  // sau direct la finalul textului (fără punctuație).
  const outMatch = rawText.match(
    /out of (free )?messages?( until (.+?))?(?:[.\n!]|$)/i
  );
  if (outMatch) {
    return {
      kind: 'out_of_messages',
      message: outMatch[0].trim(),
      resetTime: outMatch[3]?.trim(),
      upgradeUrl:
        providerId === 'claude'
          ? 'https://claude.ai/upgrade'
          : providerId === 'chatgpt'
          ? 'https://chat.openai.com/upgrade'
          : undefined
    };
  }

  // Login required
  if (/please log ?in|sign in to continue|log in to continue/i.test(rawText)) {
    return { kind: 'login_required', message: 'You need to log in.' };
  }

  // Rate limit
  if (/rate limit|too many requests|try again in/i.test(rawText)) {
    return { kind: 'rate_limit', message: 'Rate limit reached.' };
  }

  // CAPTCHA
  if (/captcha|verify you are human|are you a robot/i.test(rawText)) {
    return { kind: 'captcha', message: 'CAPTCHA detected.' };
  }

  return null;
}

/**
 * v2.5.1: eroare specifică, cu datele detecției — chatView o afișează ca mesaj
 * clar în chat (și, cu FIX 2, ca card cu buton Retry).
 */
export class DetectedProviderError extends Error {
  readonly code = PROVIDER_ERROR_CODE;
  constructor(
    readonly providerId: string,
    readonly details: ProviderError
  ) {
    super(providerErrorMessage(providerId, details));
    this.name = 'DetectedProviderError';
  }
}

/** Mesaj uman, clar, pentru o eroare de provider detectată. */
export function providerErrorMessage(
  providerId: string,
  e: ProviderError
): string {
  const name = PROVIDER_LABELS[providerId] || providerId || 'The provider';
  switch (e.kind) {
    case 'out_of_messages':
      return (
        name +
        ' is out of free messages' +
        (e.resetTime ? ' until ' + e.resetTime : '') +
        '. ' +
        (e.upgradeUrl
          ? 'Upgrade for more messages: ' + e.upgradeUrl
          : 'Wait for the limit to reset, or switch to another model.')
      );
    case 'login_required':
      return (
        'You are logged out of ' + name + '. Log in through the Chrome window, then retry.'
      );
    case 'rate_limit':
      return (
        name + ' is rate-limiting requests right now. Wait a minute, then retry.'
      );
    case 'captcha':
      return (
        name +
        ' requires CAPTCHA verification ("I\'m not a robot"). Solve it in the Chrome window, then retry.'
      );
    case 'memory_full':
      return (
        name +
        ' reached its context limit ("Chat memory full"), so it stopped answering. ' +
        'Start a new chat and continue the task there.'
      );
    case 'model_missing':
      return (
        (e.model ? 'Model "' + e.model + '"' : 'The configured Ollama model') +
        ' is not installed in Ollama.' +
        (e.availableModels?.length
          ? ' Installed: ' + e.availableModels.join(', ') + '.'
          : '') +
        ' Download it from the model menu (⋯ → model chip).'
      );
    default:
      return name + ': ' + e.message;
  }
}
