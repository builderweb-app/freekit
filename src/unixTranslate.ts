import * as fs from 'fs';
import * as path from 'path';

/* =========================================================================
 * v2.5.38 FIX (bug #89) — auto-traducere Unix → Windows înainte de execuție
 * Modelul (antrenat pe Unix) trimite `rm bootcamp-test2/test.ts`, `ls`, `cp`,
 * `mv`, `cat`, `touch`, `mkdir -p` pe Windows, iar fix-ul #78 (v2.5.32) doar
 * ATENȚIONA modelul DUPĂ eșec. În testul HARD MODE din 7 Oct 2026 (10:26–10:28)
 * Gemini a ignorat avertismentul și a declarat task-ul „gata" fără să ruleze
 * pașii de cleanup (`rm bootcamp-test2/test.ts` → „not recognized", pasul 9
 * pierdut, scor 7/10). Acum comanda este tradusă automat în echivalentul
 * Windows ÎNAINTE de aprobare (utilizatorul vede exact ce se execută) și de
 * execuție; hint-ul #78 rămâne pentru cazurile neacoperite (pipe, redirect,
 * wildcard, flaguri necunoscute) — acolo comanda NU este modificată.
 *
 * Nu traducem în interiorul string-urilor: `git commit -m "rm bug"` rămâne
 * neschimbat (primul token al segmentului este `git`).
 * ========================================================================= */

export interface UnixTranslation {
  /** Comanda care trebuie executată (tradusă pe Windows, altfel neschimbată). */
  command: string;
  /** true dacă cel puțin o comandă a fost înlocuită. */
  translated: boolean;
  /** Descrieri pentru log, ex. `rm → del (bootcamp-test2/test.ts)`. */
  notes: string[];
}

export interface UnixTranslateOptions {
  /** Platforma pentru care traducem (implicit cea pe care rulează extensia). */
  platform?: NodeJS.Platform;
  /** Folderul de lucru față de care verificăm țintele `rm -r`. */
  cwd?: string;
  /** Injectabil (teste): true doar dacă ținta e un FOLDER existent. */
  isDir?: (target: string) => boolean;
}

/** Token de segment: textul brut (cu ghilimele, dacă are) + dacă e ghilimat. */
interface SegToken {
  raw: string;
  quoted: boolean;
}

const DQ = '"';
const SQ = "'";

/** `rm -f`, `-r`, `-rf`, `-Rf`, `--force`, `--recursive` — singurele acceptate. */
const RM_LONG_FLAG_RE = /^--(?:force|recursive)$/i;
const RM_SHORT_FLAG_RE = /^-[frR]+$/;
/** `mkdir -p` / `--parents` (POSIX; pe Windows folderele-părinte se creează). */
const MKDIR_PARENTS_FLAG_RE = /^(?:-p|--parents)$/i;
const WILDCARD_RE = /[*?]/;

function unchanged(command: string): UnixTranslation {
  return { command, translated: false, notes: [] };
}

/** Pipe/redirect (în afara ghilimelelor) ⇒ comanda rămâne pe seama hint-ului #78. */
function hasUnquotedShellMeta(text: string): boolean {
  let quote = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === DQ || ch === SQ) {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === '>' || ch === '<' || ch === '`') return true;
  }
  return false;
}

/**
 * Împarte comanda în segmente, PĂSTRÂND separatorii (`&&`, `&`, `;`, EOL) —
 * fiecare segment începe cu o comandă nouă (`cd x && rm y` → `cd x`, `rm y`).
 * Separatorii din interiorul ghilimelelor nu contează.
 */
function splitSegments(command: string): { seg: string; sep: string }[] {
  const parts: { seg: string; sep: string }[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === DQ || ch === SQ) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '&' || ch === ';' || ch === '\n' || ch === '\r') {
      let sep = ch;
      if (ch === '&' && command[i + 1] === '&') {
        sep = '&&';
        i++;
      } else if (ch === '\r' && command[i + 1] === '\n') {
        sep = '\r\n';
        i++;
      }
      parts.push({ seg: cur, sep });
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push({ seg: cur, sep: '' });
  return parts;
}

/** Tokenii unui segment; ghilimelele rămân în `raw` (ca să nu stricăm căile cu spații). */
function tokenize(seg: string): SegToken[] {
  const tokens: SegToken[] = [];
  let cur = '';
  let quote = '';
  let quoted = false;
  const flush = () => {
    if (cur) tokens.push({ raw: cur, quoted });
    cur = '';
    quoted = false;
  };
  for (const ch of seg) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === DQ || ch === SQ) {
      quote = ch;
      quoted = true;
      cur += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return tokens;
}

/** Conținutul unui token, fără ghilimelele de delimitare. */
function unquote(raw: string): string {
  if (raw.length >= 2) {
    const q = raw[0];
    if ((q === DQ || q === SQ) && raw[raw.length - 1] === q) return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Argument de cale pentru cmd.exe: slash-urile inverse sunt obligatorii (builtin-urile
 * `del`/`rmdir`/`dir`/`copy`/`move`/`type`/`mkdir` citesc `/x` ca pe un switch:
 * `del C:/tmp/a.txt` ⇒ „Invalid switch - "tmp""), iar ghilimelele simple nu sunt
 * ghilimele pentru cmd ⇒ le rescriem ca ghilimele duble.
 */
const SAFE_ARG_RE = /^[\w\-.\\:~+]+$/;

function cmdPath(token: SegToken): string {
  const value = unquote(token.raw).replace(/\//g, '\\');
  return SAFE_ARG_RE.test(value) ? value : DQ + value + DQ;
}

function splitFlags(tokens: SegToken[]): { flags: string[]; rest: SegToken[] } {
  const flags: string[] = [];
  const rest: SegToken[] = [];
  for (const t of tokens) {
    if (t.quoted || !t.raw.startsWith('-')) rest.push(t);
    else if (t.raw === '--') continue; // sfârșitul flagurilor (POSIX) — îl omitem
    else flags.push(t.raw);
  }
  return { flags, rest };
}

interface Swap {
  command: string;
  note: string;
}

/**
 * Traducerea unei singure comenzi. Întoarce `undefined` când comanda nu e
 * Unix sau când o traducem „pe ghicite" (flaguri necunoscute, wildcard, număr
 * neașteptat de argumente) — acolo hint-ul #78 e mai sigur.
 */
function planSwap(
  name: string,
  flags: string[],
  rest: SegToken[],
  isDir: (target: string) => boolean
): Swap | undefined {
  const label = flags.length ? name + ' ' + flags.join(' ') : name;
  const args = rest.map(cmdPath);
  const target = args.join(' ');

  switch (name) {
    case 'rm': {
      const known = flags.every(
        (f) => RM_LONG_FLAG_RE.test(f) || RM_SHORT_FLAG_RE.test(f)
      );
      if (!known || !rest.length) return undefined;
      if (args.some((a) => WILDCARD_RE.test(a))) return undefined;
      const recursive = flags.some((f) => /[rR]/.test(f));
      if (!recursive) {
        return { command: 'del ' + target, note: label + ' → del (' + target + ')' };
      }
      // `rm -rf <folder>` ⇒ rmdir /s /q; `rm -rf <file|inexistent>` ⇒ del
      // (rmdir pe un fișier dă exit 267, iar `rm -rf` pe o cale lipsă e fără
      // eroare în Unix — `del` pe o cale lipsă întoarce 0).
      const commands: string[] = [];
      const notes: string[] = [];
      rest.forEach((t, i) => {
        const dir = isDir(unquote(t.raw));
        commands.push((dir ? 'rmdir /s /q ' : 'del ') + args[i]);
        notes.push((dir ? 'rmdir /s /q' : 'del') + ' (' + args[i] + ')');
      });
      return { command: commands.join(' & '), note: label + ' → ' + notes.join(', ') };
    }
    case 'ls': {
      const rest2 = args.length ? 'dir ' + target : 'dir';
      return {
        command: rest2,
        note: label + ' → dir' + (args.length ? ' (' + target + ')' : '')
      };
    }
    case 'cp': {
      if (flags.length || rest.length !== 2) return undefined;
      return { command: 'copy ' + target, note: label + ' → copy (' + target + ')' };
    }
    case 'mv': {
      if (flags.length || rest.length !== 2) return undefined;
      return { command: 'move ' + target, note: label + ' → move (' + target + ')' };
    }
    case 'cat': {
      if (flags.length || rest.length !== 1) return undefined;
      return { command: 'type ' + target, note: label + ' → type (' + target + ')' };
    }
    case 'touch': {
      if (flags.length || rest.length !== 1) return undefined;
      return {
        command: 'echo. > ' + target,
        note: label + ' → echo. > (' + target + ')'
      };
    }
    case 'mkdir': {
      // doar `mkdir -p` (POSIX) se traduce; `mkdir <dir>` funcționează deja pe Windows
      const parentsOk =
        flags.length > 0 && flags.every((f) => MKDIR_PARENTS_FLAG_RE.test(f));
      if (!parentsOk || !args.length) return undefined;
      // `mkdir -p` e idempotent în Unix; `mkdir` pe un folder existent dă exit 1
      // ⇒ păstrăm semantica cu `if not exist`.
      const commands = rest.map(
        (t, i) => 'if not exist ' + args[i] + ' mkdir ' + args[i]
      );
      return { command: commands.join(' & '), note: label + ' → mkdir (' + target + ')' };
    }
    default:
      return undefined;
  }
}

/** Traducerea unui segment (fără separatori): doar primul token e o comandă. */
function translateSegment(
  seg: string,
  isDir: (target: string) => boolean
): { out: string; note?: string } {
  const leadMatch = /^[ \t]*/.exec(seg);
  const lead = leadMatch ? leadMatch[0] : '';
  const trailMatch = /[ \t]*$/.exec(seg);
  const trail = trailMatch ? trailMatch[0] : '';
  const body = seg.slice(lead.length, seg.length - trail.length);
  if (!body) return { out: seg };
  const tokens = tokenize(body);
  const cmd = tokens[0];
  // comanda trebuie să fie primul token și NEghilimat (`"rm" x`, `git commit -m "rm x"`)
  if (!cmd || cmd.quoted) return { out: seg };
  const { flags, rest } = splitFlags(tokens.slice(1));
  const swap = planSwap(cmd.raw.toLowerCase(), flags, rest, isDir);
  if (!swap) return { out: seg };
  return { out: lead + swap.command + trail, note: swap.note };
}

/**
 * v2.5.38 FIX (bug #89): `rm`/`ls`/`cp`/`mv`/`cat`/`touch`/`mkdir -p` →
 * echivalentele Windows, ÎNAINTE de execuție. Pe non-Windows comanda e
 * returnată neschimbată (`translated: false`, `notes` gol).
 */
export function translateUnixCommandToWindows(
  command: string,
  options: UnixTranslateOptions = {}
): UnixTranslation {
  const original = String(command ?? '');
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !original.trim()) return unchanged(original);
  // pipe/redirect: nu traducem (comanda rămâne a modelului, hint #78 o explică)
  if (hasUnquotedShellMeta(original)) return unchanged(original);

  const base = options.cwd ?? process.cwd();
  const isDir =
    options.isDir ??
    ((target: string) => {
      try {
        return fs.statSync(path.resolve(base, target)).isDirectory();
      } catch {
        // inexistent (sau inaccesibil) ⇒ `del` (exit 0, ca `rm -rf` fără țintă)
        return false;
      }
    });

  const notes: string[] = [];
  let out = '';
  for (const part of splitSegments(original)) {
    const res = translateSegment(part.seg, isDir);
    if (res.note) notes.push(res.note);
    out += res.out + part.sep;
  }
  if (!notes.length) return unchanged(original);
  return { command: out, translated: true, notes };
}
