/* =========================================================================
 * v2.5.11 FIX (bug #33) — Circuit breaker pe eșecuri consecutive
 * Un tool care eșuează repetat (write_file, edit_file, run_command) ținea
 * bucla agentică până la 40/40 de iterații, consumând CPU/RAM/timp masiv
 * (mai ales Ollama local pe hardware slab). Aici ținem contorul de eșecuri
 * CONSECUTIVE ale ACELUIAȘI tool: un succes (al oricărui tool) resetează
 * contorul (e progres real); la 3 eșecuri consecutive bucla se oprește.
 * ========================================================================= */

/** Câte eșecuri consecutive ale aceluiași tool opresc bucla agentică. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Rezultatul înregistrării unui tool call. */
export interface CircuitBreakerOutcome {
  /** Eșecurile consecutive ale tool-ului curent (0 după un succes). */
  consecutiveFailures: number;
  /** true exact la al 2-lea eșec consecutiv (log de transparență). */
  warn: boolean;
  /** true când s-a atins pragul — apelantul oprește bucla agentică. */
  triggered: boolean;
}

/** Contor de eșecuri consecutive per tool. O instanță = o buclă agentică
 *  (un mesaj nou ⇒ instanță nouă ⇒ contorul pornește de la 0). */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailedTool = '';

  /** Înregistrează rezultatul unui tool call:
   *  succes ⇒ reset (chiar dacă e alt tool sau același);
   *  eșec al ACELUIAȘI tool ⇒ increment;
   *  eșecul ALTUI tool ⇒ numărătoare nouă, pentru acel tool. */
  record(toolName: string, ok: boolean): CircuitBreakerOutcome {
    if (ok) {
      this.consecutiveFailures = 0;
      this.lastFailedTool = '';
      return { consecutiveFailures: 0, warn: false, triggered: false };
    }
    if (toolName === this.lastFailedTool) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 1;
      this.lastFailedTool = toolName;
    }
    return {
      consecutiveFailures: this.consecutiveFailures,
      warn: this.consecutiveFailures === 2,
      triggered: this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD
    };
  }
}

/* =========================================================================
 * v2.5.29 FIX 2 (bug #67) — Loop detection per FIȘIER editat
 * Circuit breaker-ul de mai sus numără doar eșecuri CONSECUTIVE ale ACELUIAȘI
 * tool, iar un succes (al oricărui tool) resetează contorul — deci bucla
 * „edit_file (reușit) → run_command (eșuat) → edit_file (reușit) → …" nu-l
 * declanșează deloc (7 iterații pierdute pe tsconfig.json în logul v2.5.28).
 * Aici numărăm separat, per fișier, CÂTE ÎNCERCĂRI de editare a primit în
 * același mesaj (reușite sau nu): de la 4 încercări pe același fișier, eroarea
 * de la tsc aproape sigur NU se rezolvă editând acel fișier, deci trimitem un
 * nudge de strategie (vezi buildEditLoopNudge).
 * ========================================================================= */

/** Câte încercări de editare pe ACELAȘI fișier declanșează nudge-ul. */
export const EDIT_LOOP_THRESHOLD = 4;
/** Nudge-ul se repetă din 2 în 2 încercări peste prag (nu la fiecare pas). */
export const EDIT_LOOP_NUDGE_EVERY = 2;
/** Uneltele care modifică fișiere (fiecare = o „încercare de editare"). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit_file',
  'write_file',
  'write_files'
]);

export interface EditLoopOutcome {
  /** Câte încercări de editare a primit fișierul în mesajul curent. */
  count: number;
  /** Setat doar când s-a atins pragul — nudge-ul de strategie pentru AI. */
  nudge?: string;
}

/** Cheia de comparație a căilor (separatori uniformi, case-insensitive). */
function editKey(rel: string): string {
  return String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
    .toLowerCase();
}

/** Nudge-ul de strategie trimis AI-ului când tot editează același fișier. */
export function buildEditLoopNudge(file: string, count: number): string {
  return (
    '⚠️ You have edited ' +
    file +
    ' ' +
    count +
    ' times. The tsc error is probably not fixable by editing this file.\n' +
    'Try: (1) read the error carefully, (2) check if the error is in another ' +
    'file, (3) check the tsconfig include/exclude, (4) if you cannot fix it, ' +
    'report the error and stop.'
  );
}

/**
 * Contor de încercări de editare per fișier. O instanță = o buclă agentică
 * (un mesaj nou ⇒ instanță nouă ⇒ contoarele pornesc de la 0).
 *
 * Reset:
 *  - mesaj nou (instanță nouă / `reset()`);
 *  - `run_command` REUȘIT după o editare REUȘITĂ = succes real ⇒ se șterge
 *    contorul fișierului editat.
 * NU se resetat la editarea ALTUI fișier — contoarele sunt per fișier, deci
 * întoarcerea la un fișier deja editat continuă numărătoarea lui.
 */
export class EditLoopDetector {
  private attempts = new Map<string, number>();
  /** Ultimul fișier editat CU SUCCES (pentru regula de „succes real"). */
  private lastEditedFile?: string;

  /** Înregistrează o ÎNCERCARE de editare (reușită sau nu) pe un fișier. */
  recordAttempt(file: string): EditLoopOutcome {
    const key = editKey(file);
    if (!key) return { count: 0 };
    const count = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, count);
    if (
      count >= EDIT_LOOP_THRESHOLD &&
      (count - EDIT_LOOP_THRESHOLD) % EDIT_LOOP_NUDGE_EVERY === 0
    ) {
      return { count, nudge: buildEditLoopNudge(file, count) };
    }
    return { count };
  }

  /** Editare REUȘITĂ — reținem fișierul pentru regula de „succes real". */
  recordEditSuccess(file: string): void {
    const key = editKey(file);
    if (key) this.lastEditedFile = key;
  }

  /**
   * `run_command` REUȘIT după o editare reușită = succes real ⇒ contorul
   * fișierului editat se resetează. Întoarce calea resetată (pentru log).
   */
  recordCommandSuccess(): string | undefined {
    const file = this.lastEditedFile;
    this.lastEditedFile = undefined;
    if (!file) return undefined;
    this.attempts.delete(file);
    return file;
  }

  /** Câte încercări de editare are fișierul în mesajul curent. */
  count(file: string): number {
    return this.attempts.get(editKey(file)) ?? 0;
  }

  /** Reset complet (mesaj nou). */
  reset(): void {
    this.attempts.clear();
    this.lastEditedFile = undefined;
  }
}

/** Mesajul clar afișat în chat când circuit breaker-ul se declanșează:
 *  numele tool-ului, ultima eroare (max 500 de caractere) și 3 sugestii. */
export function buildCircuitBreakerMessage(
  toolName: string,
  error?: string
): string {
  const lastError = (error || 'unknown error').slice(0, 500);
  return (
    '⛔ **Stopped — the AI is stuck.**\n\n' +
    'The tool `' + toolName + '` failed **' +
    CIRCUIT_BREAKER_THRESHOLD +
    ' times in a row**.\n\n' +
    '**Last error:**\n' +
    '```\n' + lastError + '\n```\n\n' +
    '**Try:**\n' +
    '- Break the task into smaller steps (one file at a time)\n' +
    '- Switch to a different provider (⋯ → model chip)\n' +
    '- Check that the file paths exist and are writable'
  );
}
