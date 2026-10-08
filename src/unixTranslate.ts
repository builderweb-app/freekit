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

/* =========================================================================
 * v2.5.55 FIX 2 — traducere extinsă (find / grep / pwd / head / tail) și
 * EROARE CLARĂ când comanda nu poate fi tradusă.
 * Raportul din 8 Oct 2026: AI-ul a căutat pluginul WordPress „seo-orase-pro"
 * cu `find . -name seo-orase-pro` pe Windows; aceeași comandă a eșuat de 3 ori
 * la rând („not recognized"), circuit breaker-ul a oprit task-ul, iar pluginul
 * (care exista în a doua rădăcină a workspace-ului, Z:\…\wp-content\plugins)
 * nu a fost găsit niciodată. Acum:
 *   find <dir> -name X  → dir /s /b <dir>\X
 *   find . -iname X     → dir /s /b *X*
 *   grep X file         → findstr X file
 *   grep -r X .         → findstr /s /i X *.*
 *   pwd                 → cd
 *   head -N file        → powershell -NoProfile -Command "Get-Content … -TotalCount N"
 *   tail -N file        → powershell -NoProfile -Command "Get-Content … -Tail N"
 * O comandă Unix care NU poate fi tradusă (predicate `find` necunoscute,
 * wildcard la `rm`, pipe/redirect) NU se mai execută orbește: întoarce
 * `blockedUnix`, iar tools.ts răspunde cu eroarea clară + tabelul de
 * echivalențe (vezi buildUnixBlockedError).
 * ========================================================================= */

/** Tabelul de echivalențe Unix → Windows, folosit în hint-uri și în erori. */
export const UNIX_TO_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['find', 'dir /s /b <dir>\\<name>   (e.g. dir /s /b wp-content\\plugins\\*seo*)'],
  ['grep', 'findstr /s /i <pattern> *.*'],
  ['ls', 'dir'],
  ['pwd', 'cd'],
  ['cat', 'type <file>'],
  ['rm', 'del <file>   (folders: rmdir /s /q <dir>)'],
  ['cp', 'copy <src> <dst>'],
  ['mv', 'move <src> <dst>'],
  ['touch', 'echo. > <file>'],
  ['mkdir -p', 'mkdir <dir>   (Windows creates the parents anyway)'],
  ['head', 'powershell -NoProfile -Command "Get-Content -TotalCount 20 <file>"'],
  ['tail', 'powershell -NoProfile -Command "Get-Content -Tail 20 <file>"']
];

/** Liniile „- unix → windows" pentru comenzile date (ordinea din tabel). */
export function unixToWindowsLines(names: string[]): string {
  const set = new Set(names.map((n) => String(n).toLowerCase()));
  return UNIX_TO_WINDOWS.filter(([unix]) => set.has(unix))
    .map(([unix, win]) => '- ' + unix + ' → ' + win)
    .join('\n');
}

/** Comenzile care NU există în cmd/PowerShell (nume fără flaguri). */
const UNIX_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'find',
  'grep',
  'ls',
  'pwd',
  'cat',
  'rm',
  'cp',
  'mv',
  'touch',
  'head',
  'tail'
]);

/** `mkdir -p` (sau `-pv`): pe Windows folderele-părinte se creează oricum. */
const MKDIR_PARENTS_ANY_RE = /^(?:-[A-Za-z]*p[A-Za-z]*|--parents)$/i;

export interface UnixTranslation {
  /** Comanda care trebuie executată (tradusă pe Windows, altfel neschimbată). */
  command: string;
  /** true dacă cel puțin o comandă a fost înlocuită. */
  translated: boolean;
  /** Descrieri pentru log, ex. `rm → del (bootcamp-test2/test.ts)`. */
  notes: string[];
  /**
   * v2.5.55 (FIX 2): comenzi Unix care nu pot fi traduse (predicate `find`
   * necunoscute, wildcard la `rm`, pipe/redirect) — comanda trebuie BLOCATĂ
   * (nu executată), iar modelul primește tabelul de echivalențe.
   */
  blockedUnix?: string[];
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

/** Argument cmd.exe sigur (fără ghilimele când nu e nevoie). */
function cmdArg(value: string): string {
  return SAFE_ARG_RE.test(value) ? value : DQ + value + DQ;
}

function cmdPath(token: SegToken): string {
  return cmdArg(unquote(token.raw).replace(/\//g, '\\'));
}

/**
 * v2.5.55: segmentele unei linii de comandă, separate de `&&`, `&`, `;`, `|` și
 * EOL (în afara ghilimelelor). Folosit DOAR pentru detecția comenzilor Unix
 * (pipe-urile rămân netraduse — vezi hasUnquotedShellMeta).
 */
function splitCommandSegments(command: string): string[] {
  const parts: string[] = [];
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
    if (ch === '&' || ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.filter((p) => p.trim().length > 0);
}

/** Numele comenzii (primul token, fără `sudo`), lowercase, fără `.exe`. */
function segmentCommandName(seg: string): string {
  const tokens = tokenize(seg.trim());
  let i = 0;
  if (tokens[i] && /^sudo(?:\.exe)?$/i.test(unquote(tokens[i].raw))) i++;
  const cmd = tokens[i];
  if (!cmd) return '';
  return unquote(cmd.raw).toLowerCase().replace(/\.exe$/, '');
}

/**
 * v2.5.55 (FIX 2): comenzile Unix dintr-o linie (inclusiv după pipe), pentru
 * hint-ul de eroare și pentru blocarea comenzilor netranslatabile.
 * Întoarce etichete distincte, în ordinea apariției (ex. `['find']`).
 */
export function findUnixCommands(command: string): string[] {
  const out: string[] = [];
  for (const seg of splitCommandSegments(String(command ?? ''))) {
    const tokens = tokenize(seg.trim());
    let i = 0;
    if (tokens[i] && /^sudo(?:\.exe)?$/i.test(unquote(tokens[i].raw))) i++;
    const name = segmentCommandName(seg);
    let label = '';
    if (name === 'mkdir') {
      if (tokens.slice(i + 1).some((t) => MKDIR_PARENTS_ANY_RE.test(unquote(t.raw)))) {
        label = 'mkdir -p';
      }
    } else if (UNIX_ONLY_COMMANDS.has(name)) {
      label = name;
    }
    if (label && out.indexOf(label) < 0) out.push(label);
  }
  return out;
}

/**
 * `find` este POSIX doar dacă are un predicat cu `-` (`-name`, `-type`, …) sau un
 * prim argument NEghilimat care nu e un switch Windows: Windows are propriul
 * `find.exe` (`find /i "x" file.txt`), pe care NU îl blocăm.
 */
function isPosixFind(rest: SegToken[]): boolean {
  if (rest.some((t) => !t.quoted && t.raw.startsWith('-'))) return true;
  // `find <dir>` (fără predicate): pe Windows `find` are nevoie de un șir de
  // căutare și citește din stdin — deci doar primul argument neghilimat și fără
  // switch-uri Windows (`/i`, `/c`, `/v`, `/n`) e POSIX.
  const first = rest[0];
  if (!first || first.quoted || first.raw.startsWith('/')) return false;
  return true;
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

/** Valoarea PowerShell (ghilimele simple; `'` se dublează). */
function psLiteral(value: string): string {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** Prefixul de folder pentru un `dir`/`findstr` recursiv (`''` pentru `.`). */
function dirPrefix(dir: string): string {
  const clean = String(dir ?? '').trim();
  if (!clean || clean === '.' || clean === './') return '';
  return clean.replace(/\//g, '\\').replace(/\\+$/, '') + '\\';
}

/** `pwd` → `cd` (fără argumente, `cd` afișează folderul curent). */
function planPwd(rest: SegToken[]): Swap | undefined {
  if (rest.length) return undefined;
  return { command: 'cd', note: 'pwd → cd' };
}

/**
 * `find <dir> [-name|-iname PATTERN] [-type f|d] [-maxdepth N]` → `dir /s /b`.
 * Orice alt predicat (`-exec`, `-mtime`, `-size`, …) ⇒ netranslatabil: o căutare
 * parțială luată drept completă e mai rea decât o eroare clară.
 */
function planFind(rest: SegToken[]): Swap | undefined {
  if (!isPosixFind(rest)) return undefined; // `find /i "x" file` e find.exe (Windows)
  const dirTok = rest[0];
  if (!dirTok || (!dirTok.quoted && dirTok.raw.startsWith('-'))) return undefined;
  const dir = unquote(dirTok.raw);
  let pattern = '';
  let insensitive = false;
  let type = '';
  let maxDepth: number | undefined;
  for (let i = 1; i < rest.length; i++) {
    const flag = unquote(rest[i].raw);
    const value = i + 1 < rest.length ? unquote(rest[i + 1].raw) : '';
    if (flag === '-name' || flag === '-iname') {
      if (!value) return undefined;
      pattern = value;
      insensitive = flag === '-iname';
      i++;
    } else if (flag === '-type') {
      if (value !== 'f' && value !== 'd') return undefined;
      type = value;
      i++;
    } else if (flag === '-maxdepth') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return undefined;
      maxDepth = n;
      i++;
    } else {
      return undefined;
    }
  }
  if (!pattern) return undefined;
  // `-iname` e case-insensitive; `dir` e deja case-insensitive pe Windows, iar
  // căutarea utilă e cea „conține" (`*X*`) — exact ce cere raportul.
  if (insensitive && !WILDCARD_RE.test(pattern)) pattern = '*' + pattern + '*';
  const recursive = maxDepth !== 0 && maxDepth !== 1;
  const switches = [
    'dir',
    recursive ? '/s' : '',
    '/b',
    type === 'f' ? '/a-d' : type === 'd' ? '/ad' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const spec = dirPrefix(dir) + pattern;
  return {
    command: switches + ' ' + cmdArg(spec),
    note: 'find → ' + switches + ' (' + spec + ')'
  };
}

/**
 * `grep [-r] [-i] [-n] PATTERN [PATH…]` → `findstr [/s] [/i] [/n] PATTERN PATH…`.
 * Cu `-r` și fără cale (sau calea `.`) căutăm în tot arborele: `*.*`.
 */
function planGrep(rest: SegToken[]): Swap | undefined {
  let recursive = false;
  let ignoreCase = false;
  let lineNumber = false;
  let i = 0;
  for (; i < rest.length; i++) {
    const t = rest[i];
    if (t.quoted || !t.raw.startsWith('-') || t.raw === '-') break;
    const flag = t.raw;
    if (flag === '--') {
      i++;
      break;
    }
    if (flag.startsWith('--')) {
      if (flag === '--recursive') recursive = true;
      else if (flag === '--ignore-case') ignoreCase = true;
      else if (flag === '--line-number') lineNumber = true;
      else return undefined;
      continue;
    }
    for (const letter of flag.slice(1)) {
      if (letter === 'r' || letter === 'R') recursive = true;
      else if (letter === 'i') ignoreCase = true;
      else if (letter === 'n') lineNumber = true;
      else return undefined;
    }
  }
  const patternTok = rest[i];
  if (!patternTok) return undefined; // grep fără pattern citește din stdin
  const paths = rest.slice(i + 1);
  if (!recursive && !paths.length) return undefined;
  const pattern = patternTok.quoted
    ? patternTok.raw
    : cmdArg(unquote(patternTok.raw));
  const switches = [
    'findstr',
    recursive ? '/s' : '',
    ignoreCase ? '/i' : '',
    lineNumber ? '/n' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const targets = recursive
    ? (paths.length ? paths : [{ raw: '.', quoted: false }]).map((p) =>
        cmdArg(dirPrefix(unquote(p.raw)) + '*.*')
      )
    : paths.map(cmdPath);
  return {
    command: switches + ' ' + pattern + ' ' + targets.join(' '),
    note: 'grep → ' + switches + ' (' + pattern + ' ' + targets.join(' ') + ')'
  };
}

/**
 * `head -N FILE` / `tail -N FILE` → PowerShell (`Get-Content -TotalCount/-Tail`),
 * singurul mod de a păstra EXACT semantica primei/ultimei linii (`more` nu
 * limitează nimic când output-ul nu merge la consolă).
 */
function planHeadTail(name: string, rest: SegToken[]): Swap | undefined {
  let count = 10; // implicit POSIX
  const files: SegToken[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const raw = t.raw;
    const long = /^--lines=(\d+)$/.exec(unquote(raw));
    if (long) {
      count = Number(long[1]);
      continue;
    }
    if (!t.quoted && /^-\d+$/.test(raw)) {
      count = Number(raw.slice(1));
      continue;
    }
    if (!t.quoted && (raw === '-n' || raw === '--lines')) {
      const value = i + 1 < rest.length ? unquote(rest[i + 1].raw) : '';
      if (!/^\d+$/.test(value)) return undefined;
      count = Number(value);
      i++;
      continue;
    }
    if (!t.quoted && raw.startsWith('-')) return undefined;
    files.push(t);
  }
  if (files.length !== 1) return undefined;
  const file = unquote(files[0].raw).replace(/\//g, '\\');
  const flag = name === 'head' ? '-TotalCount' : '-Tail';
  return {
    command:
      'powershell -NoProfile -Command "Get-Content -LiteralPath ' +
      psLiteral(file) +
      ' ' +
      flag +
      ' ' +
      count +
      '"',
    note: name + ' → powershell Get-Content ' + flag + ' ' + count + ' (' + file + ')'
  };
}

/**
 * v2.5.55: planificatorul comenzilor care au nevoie de tokenii BRUȚI (nu de
 * `splitFlags`). `undefined` = comanda nu e din această familie; `{ swap }` fără
 * `swap` = comandă Unix recunoscută, dar netranslatabilă (⇒ blocată cu eroare).
 */
function planComplexSwap(
  name: string,
  argsTokens: SegToken[]
): { swap?: Swap } | undefined {
  switch (name) {
    case 'pwd':
      return { swap: planPwd(argsTokens) };
    case 'find':
      // `find /i "x" file` este find.exe (Windows) — nu e treaba noastră
      return isPosixFind(argsTokens) ? { swap: planFind(argsTokens) } : undefined;
    case 'grep':
      return { swap: planGrep(argsTokens) };
    case 'head':
    case 'tail':
      return { swap: planHeadTail(name, argsTokens) };
    default:
      return undefined;
  }
}

/** Numele blocabil pentru o comandă Unix netranslatabilă (altfel `undefined`). */
function blockedUnixName(
  name: string,
  flags: string[],
  argsTokens: SegToken[]
): string | undefined {
  if (name === 'find') return isPosixFind(argsTokens) ? 'find' : undefined;
  if (name === 'mkdir') {
    return flags.some((f) => MKDIR_PARENTS_FLAG_RE.test(f)) ? 'mkdir -p' : undefined;
  }
  return UNIX_ONLY_COMMANDS.has(name) ? name : undefined;
}

/** Traducerea unui segment (fără separatori): doar primul token e o comandă. */
function translateSegment(
  seg: string,
  isDir: (target: string) => boolean
): { out: string; note?: string; blocked?: string } {
  const leadMatch = /^[ \t]*/.exec(seg);
  const lead = leadMatch ? leadMatch[0] : '';
  const trailMatch = /[ \t]*$/.exec(seg);
  const trail = trailMatch ? trailMatch[0] : '';
  const body = seg.slice(lead.length, seg.length - trail.length);
  if (!body) return { out: seg };
  const tokens = tokenize(body);
  // `sudo` e doar un prefix (`sudo rm -f x` ≡ `rm -f x`)
  let idx = 0;
  if (tokens[idx] && /^sudo(?:\.exe)?$/i.test(unquote(tokens[idx].raw))) idx++;
  const cmd = tokens[idx];
  // comanda trebuie să fie primul token și NEghilimat (`"rm" x`, `git commit -m "rm x"`)
  if (!cmd || cmd.quoted) {
    const name = cmd ? unquote(cmd.raw).toLowerCase() : '';
    const blocked = blockedUnixName(name, [], tokens.slice(idx + 1));
    return blocked ? { out: seg, blocked } : { out: seg };
  }
  const name = unquote(cmd.raw).toLowerCase().replace(/\.exe$/, '');
  const argsTokens = tokens.slice(idx + 1);
  const complex = planComplexSwap(name, argsTokens);
  if (complex) {
    if (complex.swap) {
      return { out: lead + complex.swap.command + trail, note: complex.swap.note };
    }
    return { out: seg, blocked: name };
  }
  const { flags, rest } = splitFlags(argsTokens);
  const swap = planSwap(name, flags, rest, isDir);
  if (swap) return { out: lead + swap.command + trail, note: swap.note };
  const blocked = blockedUnixName(name, flags, argsTokens);
  return blocked ? { out: seg, blocked } : { out: seg };
}

/** Comanda nu poate rula pe Windows ⇒ NU se execută; modelul primește tabelul. */
function blockedTranslation(original: string, blockedUnix: string[]): UnixTranslation {
  return { command: original, translated: false, notes: [], blockedUnix };
}

/**
 * v2.5.38 FIX (bug #89): `rm`/`ls`/`cp`/`mv`/`cat`/`touch`/`mkdir -p` →
 * echivalentele Windows, ÎNAINTE de execuție.
 * v2.5.55 (FIX 2): + `find`/`grep`/`pwd`/`head`/`tail`, iar comenzile Unix pe
 * care NU le putem traduce întorc `blockedUnix` (nu se execută orbește).
 * Pe non-Windows comanda e returnată neschimbată (`translated: false`).
 */
export function translateUnixCommandToWindows(
  command: string,
  options: UnixTranslateOptions = {}
): UnixTranslation {
  const original = String(command ?? '');
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !original.trim()) return unchanged(original);
  // pipe/redirect: nu traducem (comanda rămâne a modelului, hint #78 o explică),
  // dar o comandă Unix care nu poate rula pe Windows este BLOCATĂ, nu executată.
  if (hasUnquotedShellMeta(original)) {
    const blocked = findUnixCommands(original);
    return blocked.length ? blockedTranslation(original, blocked) : unchanged(original);
  }

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
  const blocked: string[] = [];
  let out = '';
  for (const part of splitSegments(original)) {
    const res = translateSegment(part.seg, isDir);
    if (res.note) notes.push(res.note);
    if (res.blocked && blocked.indexOf(res.blocked) < 0) blocked.push(res.blocked);
    out += res.out + part.sep;
  }
  if (blocked.length) return blockedTranslation(original, blocked);
  if (!notes.length) return unchanged(original);
  return { command: out, translated: true, notes };
}
