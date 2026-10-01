import { Page } from 'playwright';
import { AIProvider, SendOptions } from './types';
import { clickStop, newChatVia, openProvider, sendAndWait } from './base';
import { selectors } from '../selectors';

// Toți selectorii sunt în src/selectors.json (auto-reparați la nevoie).
const ID = 'kimi';

export class KimiProvider implements AIProvider {
  readonly name = ID;
  /** v1.7.1: thinking-ul modelului (blocul toolcall-content) → pasul „Thinking" din chat. */
  onThinking?: (text: string) => void;

  get url() {
    return selectors.url(ID);
  }

  async open(page: Page) {
    await openProvider(page, ID, 'Kimi');
  }

  async newChat(page: Page) {
    await newChatVia(page, ID, 'Kimi');
  }

  async send(
    page: Page,
    message: string,
    signal?: AbortSignal,
    opts?: SendOptions
  ): Promise<string> {
    return sendAndWait(page, message, {
      providerId: ID,
      label: 'Kimi',
      signal,
      ...opts,
      // v1.7.1: thinking-ul modelului → pasul „Thinking" din chat (verbose)
      onThinking: this.onThinking
    });
  }

  async stop(page: Page): Promise<boolean> {
    return clickStop(page, ID);
  }
}
