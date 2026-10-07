/**
 * v2.5.40 (bug #93) — alegerea modelului Ollama pentru AI selector finder.
 *
 * Înainte, finder-ul folosea orbire `freekit.ollamaModel`: dacă acolo era un
 * model neinstalat (ex. `gemma3:12b`), analiza nu mai pornea deloc, deși pe
 * mașină existau modele perfect utilizabile (`qwen2.5-coder:7b`), iar
 * utilizatorul rămânea să scoată selectorii manual din DevTools.
 *
 * Modul pur Node (fără `vscode`), ca politica de selecție să poată fi testată
 * izolat. Când `freekit.aiFinderModel` e `auto`, preferăm `gemma3:12b` și, dacă
 * nu e instalat, primul model de chat după preferință:
 * qwen2.5-coder > qwen-coder > qwen > llama > mistral > orice alt model.
 * Modelele de embeddings sunt excluse — nu pot analiza un DOM.
 */
import { isEmbeddingModel } from './hardware';

/** Modelul preferat când setarea e `auto` (folosit dacă e instalat). */
export const AI_FINDER_PREFERRED_MODEL = 'gemma3:12b';

/** Valoarea `auto` a setării `freekit.aiFinderModel`. */
export const AI_FINDER_MODEL_AUTO = 'auto';

/** Ordinea de preferință (regex pe numele complet, case-insensitive). */
const AI_FINDER_MODEL_TIERS: RegExp[] = [
  /^qwen2\.5-coder/,
  /^qwen-coder/,
  /^qwen/,
  /^llama/,
  /^mistral/
];

export interface AiFinderModelChoice {
  model: string;
  /** Motivul alegerii, pentru log: ex. `auto, gemma3:12b not available`. */
  reason: string;
}

/** `true` dacă setarea cere alegerea automată (goală sau `auto`). */
export function isAutoAiFinderModel(setting: string): boolean {
  const v = String(setting ?? '')
    .trim()
    .toLowerCase();
  return !v || v === AI_FINDER_MODEL_AUTO;
}

/** Doar modelele de chat (embeddings excluse), în ordinea primită. */
export function chatCapableModels(installed: string[]): string[] {
  return (installed || [])
    .map((m) => String(m ?? '').trim())
    .filter((m) => !!m && !isEmbeddingModel(m));
}

/** Dimensiunea (B) din tag: `qwen2.5-coder:7b` → 7; 0 = necunoscută. */
function paramsB(name: string): number {
  const m = /:(\d+(?:\.\d+)?)b(?:$|[-.])/i.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Cel mai mic model din listă — analiza de DOM are un timeout de 30 s per
 * încercare (freekit.aiFinderTimeoutSeconds), deci un model mic e alegerea sigură când
 * tier-ul conține mai multe variante de mărimi. Numele fără tag (`:…b`) trece
 * ultimul, dar rămâne candidat.
 */
function smallest(models: string[]): string {
  return [...models].sort((a, b) => {
    const da = paramsB(a) || Number.POSITIVE_INFINITY;
    const db = paramsB(b) || Number.POSITIVE_INFINITY;
    return da - db || a.localeCompare(b);
  })[0];
}

/**
 * Alege modelul pentru AI finder dintr-o listă de modele instalate.
 * `null` = niciun model de chat disponibil (listă goală sau doar embeddings).
 */
export function pickAiFinderModel(installed: string[]): AiFinderModelChoice | null {
  const models = chatCapableModels(installed);
  if (!models.length) return null;

  const preferred = models.find((m) =>
    m.toLowerCase().startsWith(AI_FINDER_PREFERRED_MODEL)
  );
  if (preferred) {
    return { model: preferred, reason: 'auto, ' + AI_FINDER_PREFERRED_MODEL + ' available' };
  }

  const unavailable = 'auto, ' + AI_FINDER_PREFERRED_MODEL + ' not available';
  for (const tier of AI_FINDER_MODEL_TIERS) {
    const matches = models.filter((m) => tier.test(m.toLowerCase()));
    if (matches.length) return { model: smallest(matches), reason: unavailable };
  }
  return { model: smallest(models), reason: unavailable };
}
