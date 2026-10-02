import { logLine } from '../log';

/* =========================================================================
 * v1.10.0 — EMBEDDINGS LOCALE (Ollama)
 * Vorbește direct cu API-ul de embeddings al Ollama (implicit
 * http://localhost:11434), FĂRĂ nicio dependență npm nouă (doar `fetch`).
 * Modelul implicit este `nomic-embed-text` (768 dimensiuni).
 * ========================================================================= */

const log = (msg: string) => logLine('indexer', msg);

export interface EmbedOptions {
  ollamaUrl: string;
  model: string;
  timeoutMs?: number;
}

/** Verifică rapid dacă serverul Ollama răspunde (folosit pentru mesaje clare). */
export async function ollamaAvailable(ollamaUrl: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ollamaUrl.replace(/\/+$/, '') + '/api/tags', {
      signal: controller.signal
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Extrage vectorul dintr-un răspuns Ollama (suportă ambele API-uri). */
function readEmbedding(data: any): number[] | null {
  if (Array.isArray(data?.embedding)) return data.embedding;
  // API-ul nou (/api/embed) întoarce { embeddings: [[...]] }
  if (Array.isArray(data?.embeddings) && Array.isArray(data.embeddings[0])) {
    return data.embeddings[0];
  }
  return null;
}

/**
 * Transformă un text în vector cu Ollama. Întoarce `null` la orice eroare
 * (server oprit, model lipsă, timeout) — apelantul decide cum raportează.
 */
export async function embedText(
  text: string,
  opts: EmbedOptions
): Promise<number[] | null> {
  const clean = text.slice(0, 8000).trim();
  if (!clean) return null;

  const url = opts.ollamaUrl.replace(/\/+$/, '');

  const attempt = async (
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; data: any }> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs || 30000
    );
    try {
      const res = await fetch(url + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* corp fără JSON */
      }
      return { status: res.status, data };
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    // API-ul clasic; nomic-embed-text & co. îl suportă în continuare.
    let r = await attempt('/api/embeddings', { model: opts.model, prompt: clean });
    // Ollama nou (0.3+) expune /api/embed cu `input`; fallback pentru servere
    // care au scos ruta veche.
    if (r.status === 404) {
      r = await attempt('/api/embed', { model: opts.model, input: clean });
    }

    if (r.status < 200 || r.status >= 300) {
      log('embed HTTP ' + r.status);
      return null;
    }

    const vector = readEmbedding(r.data);
    if (!vector) {
      log('no embedding in response');
      return null;
    }
    return vector;
  } catch (e: any) {
    log('embed failed: ' + (e?.message ?? String(e)));
    return null;
  }
}

/** Similaritate cosinus între doi vectori (0 când dimensiunile diferă). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
