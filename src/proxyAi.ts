/** Selector analysis through the hosted Freekit proxy. */
import { logLine } from './log';

export const PROXY_AI_TIMEOUT_MS = 30_000;
/**
 * v2.6.1 (FIX 1): proxy-ul întoarce uneori răspunsul TRUNCHIAT. Măsurat cu
 * proxy-ul real (DOM 12k, prompt de selector): stream-ul de la providerul
 * upstream e închis după ~4s și worker-ul trimite ce a apucat —
 * `{"newChat": "button[aria-label` (string neînchis, JSON invalid), 71-98 de
 * caractere în loc de 200-400. Log-ul utilizatorului arăta exact asta:
 * `proxy got reply (78 chars, 4.3s)` → `proxy raw (78 chars)` → „niciun JSON
 * găsit", deși selectorul era corect. Corpul se citește acum COMPLET, iar
 * răspunsul rupt se reia în loc să omoare reparația.
 */
export const PROXY_MAX_ATTEMPTS = 3;
/** v2.6.1 (FIX 1): reîncercarea e scurtă — trunchierea se vede la ~4-5s. */
export const PROXY_RETRY_TIMEOUT_MS = 10_000;
/**
 * v2.5.66 (FIX 2/3): DOM-ul trimis la proxy e plafonat. Peste asta proxy-ul
 * răspundea 400 („payload too large") pentru snapshot-uri de 18000 de caractere;
 * cu promptul fix (~2,5k) rămânem sub limita de 30000 a proxy-ului.
 */
export const PROXY_MAX_DOM_CHARS = 12_000;
/**
 * v2.5.69 (FIX 2): gazda corectă a proxy-ului. Vechea `freekit-proxy` (cu
 * cratimă) răspundea 404 „error code: 1042", deci `api-proxy` eșua mereu și
 * cădea pe browser (15-30s) — de aici lentoarea raportată.
 */
export const PROXY_AI_DEFAULT_URL = 'https://freekitproxy.identitate-brand.workers.dev';

/** v2.5.69 (FIX 4): URL-ul proxy-ului, configurabil prin `freekit.aiFinderProxyUrl`. */
export function proxyAiUrl(): string {
  try {
    // require lazy — în testele Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    const raw = String(
      v.workspace.getConfiguration('freekit').get<string>('aiFinderProxyUrl', PROXY_AI_DEFAULT_URL) ?? ''
    ).trim();
    // doar http(s), fără spații; o valoare invalidă cade înapoi pe default
    if (/^https?:\/\/\S+$/i.test(raw)) return raw.replace(/\/+$/, '');
  } catch {
    /* fără 'vscode' (teste) — folosim default-ul */
  }
  return PROXY_AI_DEFAULT_URL;
}

/** Gazda apelată, pentru logul din Output → Freekit. */
export function proxyAiHost(): string {
  const url = proxyAiUrl();
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface ProxyEnvelope {
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown };
    text?: unknown;
  }>;
}

/** Textul dintr-un envelope OpenAI-compatible (`message`/`delta`/`text`). */
function envelopeContent(value: unknown): string | null {
  const choices = (value as ProxyEnvelope | null)?.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const choice = choices[0];
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text;
  return typeof content === 'string' ? content : null;
}

/**
 * v2.6.1 (FIX 1): textul răspunsului, oricum ar veni corpul: JSON de proxy,
 * SSE (`data: {...}` — răspunsul vine `transfer-encoding: chunked`), string
 * JSON dublu serializat sau corp brut (stream tăiat). Exportată pentru
 * verificare izolată în Node (modulul nu depinde de VS Code).
 */
export function parseProxyBody(raw: string): string {
  const body = String(raw ?? '');
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    const content = envelopeContent(parsed);
    if (content !== null) return content;
  } catch {
    /* nu e JSON complet — poate fi SSE sau un corp rupt */
  }
  if (/^data:/m.test(body)) {
    let acc = '';
    for (const line of body.split(/\r?\n/)) {
      const match = /^data:\s*(.+)$/.exec(line.trim());
      if (!match || match[1].trim() === '[DONE]') continue;
      try {
        acc += envelopeContent(JSON.parse(match[1])) ?? '';
      } catch {
        /* linie ruptă (stream tăiat la mijloc) — o ignorăm */
      }
    }
    if (acc) return acc;
  }
  return body;
}

/**
 * v2.6.1 (FIX 1): `true` când textul începe un obiect JSON dar NU îl termină
 * (acoladă sau string neînchis) — semnătura stream-ului tăiat. Un răspuns
 * complet sau unul în proză nu se ating: se reîncearcă doar ce e rupt.
 * Exportată pentru verificare izolată în Node.
 */
export function isTruncatedJsonReply(reply: string): boolean {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  if (start < 0) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return false;
    }
  }
  return true;
}

/**
 * v2.6.1 (FIX 1): reîncercarea nu repetă cererea identică — proxy-ul ține
 * cache pe cerere (același prompt → același răspuns, măsurat), deci ar primi
 * exact textul trunchiat de dinainte. Linia adăugată schimbă cererea și cere
 * răspunsul complet.
 */
function retryPrompt(prompt: string, attempt: number): string {
  return (
    prompt +
    '\n\n(Retry ' + attempt + ': the previous reply was cut off before the JSON ended. ' +
    'Reply with the complete JSON object only, no explanation.)'
  );
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

/**
 * Un singur POST către proxy, cu timeout propriu. Blocul `catch` păstrează
 * mesajul de timeout de dinainte („proxy timeout after 30s") — apelanții îl
 * caută cu `/timeout after \d+s/i`.
 */
async function proxyAttempt(
  prompt: string,
  dom: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const res = await fetch(proxyAiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, dom }),
      signal: controller.signal
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const reason = proxyErrorReason(raw, prompt, dom);
      // v2.5.66 (FIX 4): motivul exact al refuzului, vizibil în Output → Freekit
      logLine('proxy', res.status + ' reason: ' + (reason || '(empty body)'));
      // v2.5.66 (FIX 2): dimensiunile cererii respinse (fără conținut sensibil)
      logLine(
        'proxy',
        'request rejected — prompt=' + prompt.length + ' chars, dom=' + dom.length + ' chars'
      );
      throw new Error('proxy error ' + res.status + (reason ? ' — ' + reason : ''));
    }
    // v2.6.1 (FIX 1): citim TOT corpul (`text()`), apoi îl desfacem noi — un
    // corp rupt trebuie să ajungă la detecția de trunchiere, nu într-o excepție
    // de parsare fără dimensiuni.
    const raw = await res.text();
    const reply = parseProxyBody(raw);
    logLine(
      'proxy',
      'body ' + raw.length + ' chars -> reply ' + reply.length + ' chars (HTTP ' + res.status + ')'
    );
    return reply;
  } catch (e) {
    if (timedOut) throw new Error('proxy timeout after ' + Math.round(timeoutMs / 1000) + 's');
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Întreabă proxy-ul și întoarce răspunsul COMPLET al modelului.
 *
 * v2.6.1 (FIX 1): un răspuns trunchiat (stream tăiat de proxy) nu mai e
 * livrat ca atare — se reia de până la `PROXY_MAX_ATTEMPTS` ori, iar dacă
 * totul rămâne rupt se aruncă, ca apelantul să cadă pe canalul de browser
 * (înainte reparația se termina cu „niciun selector", deși proxy-ul era viu).
 */
export async function askProxyServer(
  prompt: string,
  dom: string,
  signal?: AbortSignal
): Promise<string> {
  // v2.5.66 (FIX 1): trunchiem DOM-ul ÎNAINTE de POST — acesta era cauza 400.
  const safeDom =
    dom.length > PROXY_MAX_DOM_CHARS ? dom.slice(0, PROXY_MAX_DOM_CHARS) : dom;

  let reply = '';
  for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
    const first = attempt === 1;
    reply = await proxyAttempt(
      first ? prompt : retryPrompt(prompt, attempt),
      safeDom,
      first ? PROXY_AI_TIMEOUT_MS : PROXY_RETRY_TIMEOUT_MS,
      signal
    );
    const truncated = isTruncatedJsonReply(reply);
    if (reply.trim() && !truncated) return reply;
    if (attempt >= PROXY_MAX_ATTEMPTS) break;
    logLine(
      'proxy',
      (truncated
        ? 'răspuns TRUNCHIAT (' +
          reply.length +
          ' caractere, se termină cu „' +
          reply.slice(-40).replace(/\s+/g, ' ') +
          '")'
        : 'răspuns gol') +
        ' — reîncerc (încercarea ' + attempt + '/' + PROXY_MAX_ATTEMPTS + ')'
    );
  }
  if (isTruncatedJsonReply(reply)) {
    throw new Error(
      'proxy reply truncated after ' + PROXY_MAX_ATTEMPTS + ' attempts (' + reply.length + ' chars)'
    );
  }
  return reply;
}
