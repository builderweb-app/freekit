/* =========================================================================
 * v2.5.23 (bug #54) — BUGETUL DE PAYLOAD CĂTRE AI
 *
 * Un paste mare către web app (ChatGPT/Claude/Gemini) NU e lent din cauza
 * modelului, ci a aplicației web care procesează textul (2+ min pentru ~40k
 * caractere). Toate uneltele care întorc text către AI trec prin constanțele
 * și helper-ele de aici, ca payload-ul să rămână mic și constant:
 *   - MAX_CHARS_TOTAL  = 12000 (bugetul unui rezultat de unealtă / al unui batch)
 *   - MAX_CHARS_PER_FILE = 6000 (bugetul unui singur fișier sau stream)
 *   - MAX_LINES_PER_FILE = 500
 *
 * Trunchierea păstrează ÎNCEPUTUL ȘI SFÂRȘITUL: capul are declarațiile /
 * import-urile / primele erori, coada are încheierea logică / sumarul erorilor
 * (tsc, build) — exact ce lipsește dintr-o tăiere „doar cap".
 * ========================================================================= */

export const MAX_CHARS_TOTAL = 12000;
export const MAX_CHARS_PER_FILE = 6000;
export const MAX_LINES_PER_FILE = 500;

const HEAD_RATIO = 0.6;
const TAIL_RATIO = 0.3;

/** Marker comun pentru tot ce a fost trunchiat (consistent în toate uneltele). */
export function truncationMarker(omittedChars: number): string {
  return '\n\n... [truncated ' + omittedChars + ' chars] ...\n\n';
}

/**
 * Trunchiază un text simplu păstrând ~60% din cap și ~30% din coadă, cu un
 * marker la mijloc. Se folosește pentru output-uri fără structură de linii
 * (rezultate de comenzi, listinguri, diff-uri, rezultate MCP).
 */
export function clipPayload(
  text: string,
  maxChars: number = MAX_CHARS_TOTAL
): string {
  if (text.length <= maxChars) return text;
  // markerul intră în buget (rezultatul nu depășește NICIODATĂ maxChars)
  const markerLen = truncationMarker(text.length).length;
  const budget = Math.max(0, maxChars - markerLen);
  const headChars = Math.floor(budget * HEAD_RATIO);
  const tailChars = Math.max(1, Math.floor(budget * TAIL_RATIO));
  return (
    text.slice(0, headChars) +
    truncationMarker(text.length - headChars - tailChars) +
    text.slice(-tailChars)
  );
}

/**
 * Trunchiază un fișier păstrând ~60% din cap și ~30% din coadă (cu marker la
 * mijloc). Se aplică întâi limita de linii, apoi cea de caractere — un fișier
 * cu multe linii poate depăși bugetul de caractere chiar după tăierea liniilor;
 * markerul final cumulează ce s-a omis („N lines + M chars”).
 */
export function truncateContent(
  text: string,
  maxLines: number = MAX_LINES_PER_FILE,
  maxChars: number = MAX_CHARS_PER_FILE
): string {
  const lines = text.split('\n');
  const notes: string[] = [];
  let head = text;
  let tail = '';
  if (lines.length > maxLines) {
    const headCount = Math.floor(maxLines * 0.6);
    const tailCount = Math.max(1, Math.floor(maxLines * 0.3));
    notes.push(lines.length - headCount - tailCount + ' lines');
    head = lines.slice(0, headCount).join('\n');
    tail = lines.slice(-tailCount).join('\n');
  }
  let out =
    tail === ''
      ? head
      : head + '\n\n... [truncated ' + notes.join(' + ') + '] ...\n\n' + tail;
  if (out.length > maxChars) {
    const headChars = Math.floor(maxChars * 0.6);
    const tailChars = Math.max(1, Math.floor(maxChars * 0.3));
    notes.push(out.length - headChars - tailChars + ' chars');
    out =
      out.slice(0, headChars) +
      '\n\n... [truncated ' + notes.join(' + ') + '] ...\n\n' +
      out.slice(-tailChars);
  }
  return out;
}
