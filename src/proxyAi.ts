/** Selector analysis through the hosted Freekit proxy. */
import { logLine } from './log';

export const PROXY_AI_TIMEOUT_MS = 30_000;
/**
 * v2.5.66 (FIX 2/3): DOM-ul trimis la proxy e plafonat. Peste asta proxy-ul
 * răspundea 400 („payload too large") pentru snapshot-uri de 18000 de caractere;
 * cu promptul fix (~2,5k) rămânem sub limita de 30000 a proxy-ului.
 */
export const PROXY_MAX_DOM_CHARS = 12_000;
const PROXY_AI_URL = 'https://freekit-proxy.identitate-brand.workers.dev';

interface ProxyResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

/**
 * v2.5.66 (FIX 4): corpul de eroare al proxy-ului e logat în Output, dar fără
 * date sensibile — dacă răspunsul conține promptul sau DOM-ul trimis (deci
 * conversația utilizatorului) îl înlocuim cu `(redacted)`.
 */
function proxyErrorReason(raw: string, prompt: string, dom: string): string {
  const body = String(raw || '');
  if (!body) return '';
  const probes = [prompt.slice(0, 80), dom.slice(0, 80)].filter((p) => p.length >= 20);
  for (const probe of probes) {
    if (body.indexOf(probe) >= 0) return '(redacted)';
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function askProxyServer(
  prompt: string,
  dom: string,
  signal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROXY_AI_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // v2.5.66 (FIX 1): trunchiem DOM-ul ÎNAINTE de POST — acesta era cauza 400.
  const safeDom =
    dom.length > PROXY_MAX_DOM_CHARS ? dom.slice(0, PROXY_MAX_DOM_CHARS) : dom;

  try {
    const res = await fetch(PROXY_AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, dom: safeDom }),
      signal: controller.signal
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const reason = proxyErrorReason(raw, prompt, safeDom);
      // v2.5.66 (FIX 4): motivul exact al refuzului, vizibil în Output → Freekit
      logLine('proxy', res.status + ' reason: ' + (reason || '(empty body)'));
      // v2.5.66 (FIX 2): dimensiunile cererii respinse (fără conținut sensibil)
      logLine(
        'proxy',
        'request rejected — prompt=' + prompt.length + ' chars, dom=' + safeDom.length + ' chars'
      );
      throw new Error('proxy error ' + res.status + (reason ? ' — ' + reason : ''));
    }
    const data = (await res.json()) as ProxyResponse;
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch (e) {
    if (timedOut) throw new Error('proxy timeout after 30s');
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}
