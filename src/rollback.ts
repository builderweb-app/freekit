import * as fs from 'fs';
import * as path from 'path';
import { logLine } from './log';

const log = (msg: string) => logLine('rollback', msg);

/* =========================================================================
 * v1.3.0 — ROLLBACK AUTOMAT LA ULTIMA STARE VERIFICATĂ OK
 * Înainte de prima editare a fiecărui fișier dintr-un mesaj, chatView păstrează
 * o copie a conținutului original (snapshot). După fiecare verificare TRECUTĂ
 * se marchează starea curentă ca „bună”. Dacă auto-repair-ul verificării
 * eșuează definitiv, rollback() readuce fiecare fișier atins la ultima stare
 * bună (sau la starea de dinainte de mesaj, dacă nu a existat nicio verificare
 * trecută) și șterge fișierele noi create.
 *
 * Modul Node pur (fs) — testabil fără VS Code.
 * ========================================================================= */

export interface RollbackOutcome {
  /** Fișiere existente restaurate la conținutul de referință. */
  restored: string[];
  /** Fișiere noi (create de AI) care au fost șterse. */
  deleted: string[];
  /** Fișiere la care rollback-ul a eșuat. */
  failed: Array<{ abs: string; error: string }>;
}

interface SnapshotEntry {
  abs: string;
  existed: boolean;
  content: string;
}

export class EditRollback {
  /** Starea dinainte de prima atingere a fiecărui fișier (per mesaj). */
  private initial = new Map<string, SnapshotEntry>();
  /** Starea fiecărui fișier la ultima verificare TRECUTĂ (checkpoint). */
  private good = new Map<string, SnapshotEntry>();

  private static key(abs: string): string {
    return path.normalize(abs).toLowerCase();
  }

  /** Golește tot (se apelează la începutul fiecărui mesaj). */
  reset(): void {
    this.initial.clear();
    this.good.clear();
  }

  /** Câte fișiere sunt urmărite în mesajul curent. */
  get size(): number {
    return this.initial.size;
  }

  hasSnapshots(): boolean {
    return this.initial.size > 0;
  }

  /**
   * Salvează starea dinainte de prima atingere a fiecărui fișier
   * (fișierele deja urmărite în acest mesaj sunt ignorate).
   */
  snapshot(absPaths: string[]): void {
    for (const abs of absPaths) {
      const key = EditRollback.key(abs);
      if (this.initial.has(key)) continue;
      try {
        if (!fs.existsSync(abs)) {
          this.initial.set(key, { abs, existed: false, content: '' });
          continue;
        }
        if (fs.statSync(abs).isDirectory()) {
          log('snapshot: sar peste directorul ' + abs);
          continue;
        }
        this.initial.set(key, {
          abs,
          existed: true,
          content: fs.readFileSync(abs, 'utf8')
        });
      } catch (e: any) {
        log('snapshot eșuat pentru ' + abs + ': ' + (e?.message ?? String(e)));
      }
    }
  }

  /**
   * După o verificare TRECUTĂ: starea actuală de pe disc a tuturor fișierelor
   * urmărite devine „ultima stare bună” (ținta rollback-ului).
   */
  markGood(): void {
    for (const [key, entry] of this.initial) {
      try {
        if (!fs.existsSync(entry.abs)) continue;
        this.good.set(key, {
          abs: entry.abs,
          existed: true,
          content: fs.readFileSync(entry.abs, 'utf8')
        });
      } catch (e: any) {
        log('markGood eșuat pentru ' + entry.abs + ': ' + (e?.message ?? String(e)));
      }
    }
  }

  /**
   * Readuce fiecare fișier urmărit la ultima stare bună (sau, dacă nu există
   * checkpoint, la starea de dinainte de mesaj) și șterge fișierele noi.
   * La final starea internă este golită.
   */
  rollback(): RollbackOutcome {
    const out: RollbackOutcome = { restored: [], deleted: [], failed: [] };

    for (const [key, entry] of this.initial) {
      const target = this.good.get(key) ?? entry;
      try {
        if (target.existed) {
          const current = fs.existsSync(target.abs)
            ? fs.readFileSync(target.abs, 'utf8')
            : null;
          if (current !== target.content) {
            fs.mkdirSync(path.dirname(target.abs), { recursive: true });
            fs.writeFileSync(target.abs, target.content, 'utf8');
            out.restored.push(target.abs);
          }
        } else if (fs.existsSync(target.abs)) {
          fs.rmSync(target.abs, { force: true });
          out.deleted.push(target.abs);
        }
      } catch (e: any) {
        out.failed.push({ abs: target.abs, error: e?.message ?? String(e) });
      }
    }

    log(
      'rollback: ' +
        out.restored.length +
        ' restaurate, ' +
        out.deleted.length +
        ' șterse, ' +
        out.failed.length +
        ' eșuate'
    );
    this.reset();
    return out;
  }
}
