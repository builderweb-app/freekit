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
