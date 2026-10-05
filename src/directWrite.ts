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
 *
 * v2.5.7.1 (bug #13b): v2.5.7 recunoștea doar blocuri de cod ÎNCHISE, cu
 * gardurile lipite de conținut. În practică promptul sosește deschis — ```-ul
 * final e uitat sau se pierde la copiere — deci detecția nu se declanșa
 * niciodată. Acum acceptăm și un singur gard DESCHIS (restul promptului de
 * după el e conținutul fișierului) și tolerăm spații în jurul info-string-ului.
 * ========================================================================= */

/** Fișierul + conținutul extras direct din prompt. */
export interface DirectWriteRequest {
  path: string;
  content: string;
}

/** Un conținut gol nu e un fișier cerut explicit — tratăm ca „fără detecție". */
function nonEmpty(content: string): string | null {
  return content.trim().length > 0 ? content : null;
}

/**
 * v2.5.7.1: conținutul când promptul are EXACT un bloc de cod — închis
 * (```…```) sau lăsat deschis până la finalul promptului. Întoarce null
 * pentru 0 blocuri, 2+ blocuri sau un bloc gol.
 */
function singleCodeBlock(prompt: string): string | null {
  // Bloc închis — comportamentul v2.5.7 (exact unul).
  const closed = [
    ...prompt.matchAll(
      /`{3,}[^\S\r\n]*[\w+#.-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[^\S\r\n]*`{3,}/g
    )
  ];
  if (closed.length > 1) return null;
  if (closed.length === 1) return nonEmpty(closed[0][1]);

  // Niciun bloc închis: acceptăm exact un gard deschis (``` final uitat).
  const openRuns = prompt.match(/`{3,}/g)?.length ?? 0;
  if (openRuns !== 1) return null;
  const open = prompt.match(
    /`{3,}[^\S\r\n]*[\w+#.-]*[^\S\r\n]*\r?\n([\s\S]*)$/
  );
  return open ? nonEmpty(open[1]) : null;
}

/**
 * v2.5.7 (bug #13): detectează un prompt de tip „scrie fișierul X cu EXACT
 * acest conținut: ```...```" și extrage path + content direct din prompt, ca să
 * scriem fișierul fără să mai apelăm AI-ul.
 *
 * v2.5.7.1 (bug #13b): blocul de cod poate fi și deschis (fără ``` final).
 */
export function detectDirectWrite(text: string): DirectWriteRequest | null {
  const prompt = String(text ?? '');

  // Doar dacă user a cerut explicit conținut exact
  if (!/\b(EXACT|exact)\b|cu acest con[țt]inut|cu exact acest/i.test(prompt)) {
    return null;
  }

  // Trebuie EXACT un code fence (nu 2+, nu 0)
  const content = singleCodeBlock(prompt);
  if (content === null) return null;

  // Trebuie o cale de fișier clară
  const pathMatch = prompt.match(
    /(?:fi[șs]ierul|file|create|scrie|scrii|creeaz[ăa])\s+[`"']?([\w./\\-]+\.[\w]+)[`"']?/i
  );
  if (!pathMatch) return null;

  return { path: pathMatch[1], content };
}
