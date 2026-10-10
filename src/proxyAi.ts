/** Selector analysis through the hosted Freekit proxy. */
export const PROXY_AI_TIMEOUT_MS = 30_000;
const PROXY_AI_URL = 'https://freekit-proxy.identitate-brand.workers.dev';

interface ProxyResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
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

  try {
    const res = await fetch(PROXY_AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, dom }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error('proxy error ' + res.status);
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
