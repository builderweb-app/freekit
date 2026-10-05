import { Page } from 'playwright';
import { AIProvider, SendOptions } from './types';
import { clickStop, newChatVia, openProvider, sendAndWait } from './base';
import { selectors } from '../selectors';

// Toți selectorii sunt în src/selectors.json (auto-reparați la nevoie).
const ID = 'claude';

export class ClaudeProvider implements AIProvider {
  readonly name = ID;
  /** v1.7.1: thinking-ul modelului (extended thinking) → pasul „Thinking" din chat. */
  onThinking?: (text: string) => void;

  get url() {
    return selectors.url(ID);
  }

  async open(page: Page) {
    await openProvider(page, ID, 'Claude');
  }

  async newChat(page: Page) {
    await newChatVia(page, ID, 'Claude');
  }

  async send(
    page: Page,
    message: string,
    signal?: AbortSignal,
    opts?: SendOptions
  ): Promise<string> {
    return sendAndWait(page, message, {
      providerId: ID,
      label: 'Claude',
      signal,
      ...opts,
      // v2.5.1: erorile site-ului (out of messages / rate limit / CAPTCHA) sunt
      // detectate central în sendAndWait — vezi src/providerErrors.ts.
      // v1.7.1: thinking-ul modelului → pasul „Thinking" din chat (verbose)
      onThinking: this.onThinking
    });
  }

  async stop(page: Page): Promise<boolean> {
    return clickStop(page, ID);
  }
}
