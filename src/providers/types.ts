import { Page } from 'playwright';

/** Opțiuni suplimentare la trimitere (FAZA II/III). */
export interface SendOptions {
  /** Căi absolute de fișiere de încărcat în chatul web (imagini/binare). */
  files?: string[];
  /** Apelat cu textul parțial al răspunsului (progres vizibil). */
  onProgress?: (partial: string) => void;
  /** Mesaje de tip notice pentru utilizator (ex: upload eșuat). */
  onNotice?: (text: string) => void;
}

/**
 * Interfața comună pentru toți furnizorii AI.
 * Providerii web primesc `page` (Playwright) și vorbesc prin browser.
 * FAZA IV.1: providerii locali (ex: Ollama) primesc `undefined` și vorbesc
 * direct cu API-ul lor — vezi `local`.
 */
export interface AIProvider {
  readonly name: string;
  readonly url: string;
  /** FAZA IV.1: true = API local, fără browser (ex: Ollama). */
  readonly local?: boolean;
  /**
   * v1.7.1: callback pentru „thinking"-ul modelului (DeepSeek-R1, Claude
   * extended thinking, Gemini thinking, Ollama `message.thinking`). Setat de
   * chatView înainte de trimitere; providerul îl apelează cu textul de
   * raționament, separat de răspunsul final (best-effort — poate lipsi).
   */
  onThinking?: (text: string) => void;
  open(page: Page | undefined): Promise<void>;
  newChat(page: Page | undefined): Promise<void>;
  /** Trimite mesajul și așteaptă răspunsul stabil. `signal` opțional pentru Stop. */
  send(
    page: Page | undefined,
    message: string,
    signal?: AbortSignal,
    opts?: SendOptions
  ): Promise<string>;
  /**
   * FAZA I: opțional — apasă butonul de Stop al site-ului (best-effort).
   * Se folosește la anulare, ca pagina să rămână într-o stare curată.
   */
  stop?(page: Page): Promise<boolean>;
}
