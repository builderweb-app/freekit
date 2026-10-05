/* =========================================================================
 * v2.5.7 (bug #13) — Direct write mode
 * Când promptul cere explicit „fișierul X cu EXACT acest conținut: ```…```",
 * scriem fișierul DIRECT din prompt, fără să mai apelăm AI-ul: providerii
 * (mai ales DeepSeek) pot improviza, ignora sau trunchia conținutul cerut,
 * iar utilizatorul rămâne cu un fișier greșit.
 *
 * Detecția e intenționat CONSERVATOARE: cerem (a) o cerere explicită de
 * conținut exact, (b) EXACT un bloc de cod și (c) o cale de fișier clară.
 * Orice altă combinație → flux normal (AI).
 * ========================================================================= */

/** Fișierul + conținutul extras direct din prompt. */
export interface DirectWriteRequest {
  path: string;
  content: string;
}

/**
 * v2.5.7 (bug #13): detectează un prompt de tip „scrie fișierul X cu EXACT
 * acest conținut: ```...```" și extrage path + content direct din prompt, ca să
 * scriem fișierul fără să mai apelăm AI-ul.
 */
export function detectDirectWrite(text: string): DirectWriteRequest | null {
  const prompt = String(text ?? '');

  // Doar dacă user a cerut explicit conținut exact
  if (!/\b(EXACT|exact)\b|cu acest con[țt]inut|cu exact acest/i.test(prompt)) {
    return null;
  }

  // Trebuie EXACT un code fence (nu 2+, nu 0)
  const fences = [...prompt.matchAll(/```[\w]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (fences.length !== 1) return null;

  // Trebuie o cale de fișier clară
  const pathMatch = prompt.match(
    /(?:fi[șs]ierul|file|create|scrie|scrii|creeaz[ăa])\s+[`"']?([\w./\\-]+\.[\w]+)[`"']?/i
  );
  if (!pathMatch) return null;

  return { path: pathMatch[1], content: fences[0][1] };
}
