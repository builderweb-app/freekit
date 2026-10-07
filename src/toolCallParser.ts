import type { ToolCall } from './tools';
import { mapToolCallAliases, queueAliasLog } from './tsAlias';

/* =========================================================================
 * v2.5.32 FIX (bug #79) — TAB într-o cale din comandă (bug de parser)
 * `"del bootcamp-test\test.ts"` e JSON INVALID-valid: `\t` e interpretat ca
 * TAB, deci comanda ajunge la execuție ca `del bootcamp-test<TAB>est.ts` —
 * fișierul nu există și comanda eșuează („cannot find the file"). Aici
 * reconstruim secvența originală: TAB-ul ține locul lui `\` + `t` (separator +
 * litera „t" înghițită de escape), deci TAB → `\t` pe Windows, `t` precedat de
 * `/` pe Unix (`/test.ts`).
 * ========================================================================= */

/** Log-urile parserului (drenate de chatView, ca la tsAlias). */
const pendingLogs: string[] = [];
const loggedMessages = new Set<string>();

function queueParserLog(msg: string, dedupe = true): void {
  if (dedupe) {
    if (loggedMessages.has(msg)) return;
    loggedMessages.add(msg);
  }
  pendingLogs.push(msg);
}

/** Mesajele de log acumulate de parser (le golește). */
export function drainParserLogs(): string[] {
  return pendingLogs.splice(0, pendingLogs.length);
}

/**
 * v2.5.32 FIX (bug #79): reconstruiește TAB-urile suspecte dintr-o comandă.
 * Un TAB precedat de un caracter non-alb e aproape sigur un `\t` din JSON
 * (indentarea cu TAB, adică TAB la început de segment, rămâne neatinsă).
 */
export function reconstructCommandTabs(command: string): string {
  const text = String(command ?? '');
  if (!text.includes('\t')) return text;
  const sep = process.platform === 'win32' ? '\\' : '/';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\t') {
      out += ch;
      continue;
    }
    const prev = i > 0 ? text[i - 1] : '';
    out += prev && !/\s/.test(prev) ? sep + 't' : ch;
  }
  return out;
}

/** Aplică reconstrucția TAB-urilor pe `args.command` (dacă există). */
function withCommandTabsFixed(call: ToolCall): ToolCall {
  const args = call.args as Record<string, any> | undefined;
  if (!args || typeof args.command !== 'string') return call;
  const fixed = reconstructCommandTabs(args.command);
  if (fixed === args.command) return call;
  queueParserLog('parser: reconstructed tab in command: ' + fixed);
  return { tool: call.tool, args: { ...args, command: fixed } };
}

/* =========================================================================
 * v2.4.8 — Extractor robust de tool call
 * Parser-ul vechi (chatView.parseToolCall) presupunea că răspunsul întreg e
 * JSON-ul tool call-ului: orice text în plus (proză, fence markdown) sau un
 * `content` cu acolade nested + ghilimele escapate => „NO TOOL CALL DETECTED".
 * Extractorul de aici caută obiectul JSON al tool call-ului în interiorul
 * răspunsului, cu acolade ECHILIBRATE (ignoră acoladele din string-uri și
 * respectă escape-ul \"):
 *   1. conținutul blocurilor ```...``` (fence markdown);
 *   2. obiectele echilibrate care încep cu cheia „tool";
 *   3. ultimul {...} echilibrat din text;
 *   4. tot textul (după eliminarea unui fence de la început).
 * Fiecare candidat e încercat cu JSON.parse, apoi cu reparații tolerante
 * pentru caracterele de control reale (newline/TAB) și ghilimelele
 * neescapatе din valori. Dacă nimic nu parsează, apelantul primește
 * MALFORMED_TOOL_CALL_ERROR ca mesaj clar pentru utilizator.
 * v2.4.9: pentru uneltele cu conținut liber (write_file / edit_file /
 * write_files) există și formatul marker-based (`TOOL: ... / CONTENT: ...
 * END_CONTENT`), verificat PRIORITAR — vezi secțiunea dedicată de mai jos.
 * v2.5.26 (bug #51): promptul cere „ACTION:" (cuvântul „tool" declanșa refuzul
 * ChatGPT); parserul acceptă ambele prefixe, iar JSON-ul cu cheia „action" e
 * normalizat la {tool, args} — vechiul `{"tool": ...}` rămâne valid.
 * ========================================================================= */

/** Mesaj afișat utilizatorului când răspunsul e clar o încercare de tool call
 *  care nu poate fi parsat nici după reparațiile tolerante. */
export const MALFORMED_TOOL_CALL_ERROR =
  'Model returned malformed tool call. Try again or switch provider.';

/** v2.5.26 (bug #51): promptul vorbește de „actions" (ca ChatGPT să nu refuze),
 *  dar parserul acceptă în continuare și vechiul prefix „TOOL:" (retrocompat). */
const MARKER_PREFIX = '(?:TOOL|ACTION)';

/** v2.5.3 FIX 7: câte reluări facem înainte de a afișa MALFORMED_TOOL_CALL_ERROR. */
export const MAX_MALFORMED_RETRIES = 1;

/**
 * v2.5.3 FIX 7: nudge trimis modelului când răspunsul conține `TOOL:` /
 * `ACTION:` dar nu poate fi parsat (ex: DeepSeek ecouază promptul și strivesc
 * conținutul pe o singură linie). Cerem explicit formatul marker cu conținut
 * în code fence.
 * v2.5.26 (bug #51): nudge-ul folosește același vocabular ca promptul nou
 * („action"), altfel cuvântul „tool" reintroduce refuzul pe care îl reparăm.
 */
export const MALFORMED_TOOL_CALL_NUDGE = `SYSTEM NOTICE — MALFORMED ACTION CALL.

Your previous response was malformed. Try again.
Use ACTION: write_file with content in a code fence, one item per line:

ACTION: write_file
PATH: <relative path>
CONTENT:
\`\`\`text
<file content — one line per line>
\`\`\`
END_CONTENT

Do NOT echo the user message. Do NOT explain. Reply with EXACTLY ONE action and nothing else.`;

/** Început de obiect JSON cu cheia „tool” (acceptă și spații în plus). */
const TOOL_MARKER_HEAD_RE = /^\{\s*["']?tool["']?\s*:/;

/** v2.5.26 (bug #51): început de obiect JSON cu cheia „action" (promptul nou). */
const ACTION_MARKER_HEAD_RE = /^\{\s*["']?action["']?\s*:/;

/** Cât ne uităm înainte la începutul unui obiect când căutăm cheia „tool”. */
const TOOL_HEAD_WINDOW = 64;

interface ObjectSpan {
  start: number;
  end: number;
}

/**
 * Parcurge textul o singură dată (string-aware, respectă `\"`) și întoarce
 * toate obiectele `{...}` încheiate, în ordinea închiderii. Acoladele din
 * interiorul string-urilor sunt ignorate — exact ce rupea regex-ul naiv pe
 * `content` cu JSON nested.
 */
function scanObjects(text: string): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      stack.push(i);
    } else if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: i });
    }
  }

  return spans;
}

/** Conținutul blocurilor ```...``` (fence markdown), în ordine. */
function fencedBodies(text: string): string[] {
  const bodies: string[] = [];
  const re = /```[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[1].trim()) bodies.push(m[1]);
  }
  return bodies;
}

/** Textul fără un eventual fence markdown de la început / final. */
function stripLeadingFence(text: string): string {
  return text
    .replace(/^\s*```[ \t]*[a-zA-Z0-9_-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim();
}

/** Primul caracter care nu e spațiu alb, de la `from` înainte. */
function nextNonSpace(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) {
    if (!/\s/.test(text[i])) return text[i];
  }
  return undefined;
}

/**
 * Escapează caracterele de control REALE (newline / CR / TAB) din interiorul
 * string-urilor JSON — providerii web le emit des așa în `content`, ceea ce
 * face `JSON.parse` să eșueze. În afara string-urilor textul rămâne neatins.
 */
function repairControlChars(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') {
      out += '\\r';
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Re-escapează ghilimelele din interiorul valorilor string (modelele le emit
 * des neescapate: `"content": "{"a": 1}"`). O ghilimele închide string-ul doar
 * dacă urmează `:` / `,` / `}` / `]` sau sfârșitul textului.
 */
function repairUnescapedQuotes(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const ch = json[i];

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch !== '"') {
      out += ch;
      continue;
    }

    if (!inString) {
      inString = true;
      out += ch;
      continue;
    }

    const next = nextNonSpace(json, i + 1);
    if (
      next === ':' ||
      next === ',' ||
      next === '}' ||
      next === ']' ||
      next === undefined
    ) {
      inString = false;
      out += ch;
    } else {
      out += '\\"';
    }
  }

  return out;
}

/** Obiectul JSON parsat din `raw`, cu reparații tolerante succesive. */
function tryParseJsonObject(raw: string): any | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;

  const controlFixed = repairControlChars(trimmed);
  const attempts = [
    trimmed,
    controlFixed,
    repairUnescapedQuotes(trimmed),
    repairUnescapedQuotes(controlFixed)
  ];

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // strategia următoare
    }
  }

  return null;
}

/** Candidatele de JSON tool call, în ordinea priorității, fără duplicate. */
function collectCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const body of fencedBodies(text)) push(body);

  const spans = scanObjects(text);
  const startsWithToolKey = (span: ObjectSpan) =>
    TOOL_MARKER_HEAD_RE.test(
      text.slice(span.start, span.start + TOOL_HEAD_WINDOW)
    );

  for (const span of spans) {
    if (startsWithToolKey(span)) push(text.slice(span.start, span.end + 1));
  }

  // fallback: ultimul obiect echilibrat din text (apoi, descrescător, restul)
  for (let i = spans.length - 1; i >= 0; i--) {
    push(text.slice(spans[i].start, spans[i].end + 1));
  }

  push(stripLeadingFence(text));
  return out;
}

/**
 * v2.5.28 (bug #65): `write_files` trimis cu array-ul direct ca `args`
 * (`{"action":"write_files","args":[{"path":"...","content":"..."}]}`) — o
 * formă pe care modelul o produce natural, dar care era respinsă cu „args.files
 * is missing". O normalizăm la `{ files: [...] }`; restul uneltelor rămân
 * neatinse.
 */
function normalizeWriteFilesArgs(tool: string, args: any): any {
  if (tool === 'write_files' && Array.isArray(args)) return { files: args };
  return args;
}

/** Normalizează obiectul parsat la {tool, args} (inclusiv forma legacy „action"). */
function normalizeToolCall(parsed: any): ToolCall | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  if (typeof parsed.tool === 'string') {
    if (parsed.args && typeof parsed.args === 'object') {
      return {
        tool: parsed.tool,
        args: normalizeWriteFilesArgs(parsed.tool, parsed.args)
      };
    }

    if (typeof parsed.action === 'string') {
      const { tool, action, ...rest } = parsed;
      const name = `${tool}_${action}`;
      return { tool: name, args: normalizeWriteFilesArgs(name, rest) };
    }

    // v2.5.39 (bug #90): args-urile pot veni „pe verticală" — cheile de args stau
    // direct lângă „tool": `{"tool":"run_command","command":"rm x"}` sau
    // `{"tool":"write_files","files":[…]}` (înainte args ieșea gol ⇒ respins).
    const { tool, ...rest } = parsed;
    return { tool, args: normalizeWriteFilesArgs(tool, rest) };
  }

  // v2.5.26 (bug #51): promptul vorbește de „actions", deci modelele trimit
  // {"action":"read_file","args":{...}} — aceeași formă, doar cheia diferă.
  if (typeof parsed.action === 'string') {
    const { action, args, ...rest } = parsed;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      return { tool: action, args };
    }
    // v2.5.28 (bug #65): args ca array direct (write_files) → args.files
    if (Array.isArray(args)) {
      return { tool: action, args: normalizeWriteFilesArgs(action, args) };
    }
    return { tool: action, args: rest };
  }

  return null;
}

/* =========================================================================
 * v2.4.9 — Format marker-based pentru uneltele cu conținut liber
 * `{"tool":"write_file","args":{"content":"... ghilimele neescapeate ..."}}`
 * e JSON AMBIGUU: nu se poate ști unde se termină string-ul `content`, deci
 * niciun parser nu-l poate repara. Pentru write_file / edit_file / write_files
 * modelul scrie conținutul RAW, între markeri pe linii separate:
 *
 *   TOOL: write_file
 *   PATH: package.json
 *   CONTENT:
 *   { "name": "builderweb-app" }
 *   END_CONTENT
 *
 * Marker-based e OPȚIONAL și PRIORITAR: dacă blocul nu e valid (marker de
 * închidere lipsă, PATH lipsă, alt tool) cădem înapoi pe parserul JSON.
 * v2.5.26 (bug #51): prefixul poate fi `TOOL:` (vechi) sau `ACTION:` (nou).
 * ========================================================================= */

/** `TOOL: nume` / `ACTION: nume` singur pe linie (case-insensitive, whitespace ignorat). */
const MARKER_TOOL_LINE_RE = new RegExp(
  '^[ \\t]*' + MARKER_PREFIX + '[ \\t]*:[ \\t]*([A-Za-z_][A-Za-z0-9_]*)[ \\t]*$',
  'i'
);

/** Uneltele cu conținut liber care acceptă formatul marker-based. */
const MARKER_TOOLS = new Set(['write_file', 'edit_file', 'write_files']);

/** Separatorul opțional dintre fișiere în formatul lui write_files. */
const MARKER_FILE_SEPARATOR_RE = /^[ \t]*-{3,}[ \t]*FILE[ \t]*-{3,}[ \t]*$/i;

interface MarkerHit {
  index: number;
  /** Textul de după `NUME:` (poate fi gol — conținutul începe pe linia următoare). */
  rest: string;
}

/** Prima linie `NAME: ...` de la `from` înainte (oprit de `stop`, dacă e dat). */
function findMarker(
  lines: string[],
  name: string,
  from: number,
  stop?: RegExp
): MarkerHit | null {
  const re = new RegExp('^[ \\t]*' + name + '[ \\t]*:(.*)$', 'i');
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (stop && stop.test(lines[i])) return null;
    const m = re.exec(lines[i]);
    if (m) return { index: i, rest: m[1] };
  }
  return null;
}

/** Indexul liniei `END_NAME` (acceptă și `END_NAME:`), sau -1. */
function findMarkerEnd(
  lines: string[],
  name: string,
  from: number,
  stop?: RegExp
): number {
  const re = new RegExp('^[ \\t]*' + name + '[ \\t]*:?[ \\t]*$', 'i');
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (stop && stop.test(lines[i])) return -1;
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * v2.5.1 — FIX B1: conținutul e scris de model într-un code fence markdown
 * (cerut în prompt, ca #, *, _ să supraviețuiască randării din chatul web).
 * Când textul e integral înconjurat de un fence (```…``` sau mai lung),
 * gardurile se scot; fence-urile interioare rămân neatinse. Dacă randarea
 * markdown a consumat deja fence-urile (calea normală în browser), textul
 * rămâne neschimbat.
 */
function stripWrappingFence(text: string): string {
  const lines = text.split('\n');
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  if (first >= last) return text;
  const open = /^[ \t]*(`{3,})[ \t]*[A-Za-z0-9_.+-]*[ \t]*$/.exec(lines[first]);
  const close = /^[ \t]*(`{3,})[ \t]*$/.exec(lines[last]);
  if (!open || !close || close[1].length < open[1].length) return text;
  return lines.slice(first + 1, last).join('\n');
}

/**
 * v2.5.3 FIX 7: unii provideri (DeepSeek) strivesc conținutul pe o singură
 * linie. Normalizăm DOAR când nu există niciun newline real:
 *  - `\n` / `\r\n` literal (backslash+n) → newline real;
 *  - conținut cu tag-uri HTML de închidere, tot pe o linie → introducem (brute
 *    force) un newline după fiecare tag de închidere.
 * Textul care are deja newline-uri reale rămâne neatins (nu stricăm un
 * „a\\nb" dintr-un string de cod) — normalizăm doar când nu există niciun
 * newline real.
 */
function normalizeContentNewlines(text: string): string {
  if (!text || text.includes('\n')) return text;
  if (/\\r\\n|\\n/.test(text)) {
    return text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
  if (/<\/[a-zA-Z][\w:-]*\s*>/.test(text)) {
    return text.replace(/(<\/[a-zA-Z][\w:-]*\s*>)/g, '$1\n').replace(/\n+$/, '');
  }
  return text;
}

/**
 * v2.5.4 FIX 8 / v2.5.5 FIX 8b: UI-ul din chatul web (DeepSeek) adaugă artefacte
 * la începutul conținutului extras dintr-un code block: eticheta limbajului,
 * „Copy”, „Download” (uneori „Copy code”). Le eliminăm ca fișierul scris să nu fie
 * corupt; doar începutul blocului e curățat (regexele nu au flag `m`).
 * v2.5.5: antetul era ratat când înaintea lui existau newline-uri/spații (bloc de
 * cod cu primul rând gol) — curățăm și leading whitespace/BOM, apoi repetăm
 * pașii, ca antetele combinate să fie eliminate toate.
 */
function stripUiArtifacts(text: string): string {
  const patterns = [
    /^(?:astro|javascript|typescript|python|css|html|json|bash|shell|text|plaintext|markdown|md|yaml|xml|sql|java|cpp|c|go|rust|php|ruby|js|ts|jsx|tsx|sh)\s*[\r\n]+\s*Copy\s*[\r\n]+\s*Download\s*[\r\n]+/i,
    /^Copy\s*[\r\n]+\s*Download\s*[\r\n]+/i,
    /^Copy code\s*[\r\n]+/i,
    /^Download\s*[\r\n]+/i,
  ];

  let result = text;
  let changed = true;
  let iter = 0;
  while (changed && iter < 5) {
    changed = false;
    iter++;
    for (const pattern of patterns) {
      // Leading whitespace/newlines/BOM se ignoră la căutarea antetului, dar
      // indentația reală a primului rând rămâne intactă dacă nu urmează artefact.
      const lead = /^[\s\uFEFF\u200B]+/.exec(result)?.[0] ?? '';
      const body = lead ? result.slice(lead.length) : result;
      if (lead && !pattern.test(body)) continue;
      const next = body.replace(pattern, '');
      if (next !== result) {
        result = next;
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Conținutul RAW dintre linia markerului și linia lui `END_...`. Newline-ul
 * de dinaintea terminatorului nu face parte din conținut (un rând gol în plus
 * înainte de `END_...` rămâne, însă, păstrat).
 */
function readMarkerBlock(
  lines: string[],
  start: MarkerHit,
  endName: string,
  stop?: RegExp
): { text: string; next: number } | null {
  const end = findMarkerEnd(lines, endName, start.index + 1, stop);
  if (end < 0) return null;
  const body = lines.slice(start.index + 1, end);
  // `CONTENT: valoare` (fără rând nou) e acceptat: primul rând e restul liniei.
  const inline = start.rest.trim() ? [start.rest.replace(/^[ \t]/, '')] : [];
  const text = inline.concat(body).join('\n');
  return {
    text: stripUiArtifacts(normalizeContentNewlines(stripWrappingFence(text))),
    next: end + 1,
  };
}

function parseWriteFileMarkers(lines: string[], from: number): ToolCall | null {
  const path = findMarker(lines, 'PATH', from);
  if (!path) return null;
  const content = findMarker(lines, 'CONTENT', path.index + 1);
  if (!content) return null;
  const block = readMarkerBlock(lines, content, 'END_CONTENT');
  if (!block) return null;
  const filePath = path.rest.trim();
  if (!filePath) return null;
  return { tool: 'write_file', args: { path: filePath, content: block.text } };
}

function parseEditFileMarkers(lines: string[], from: number): ToolCall | null {
  const path = findMarker(lines, 'PATH', from);
  if (!path) return null;
  const oldStart = findMarker(lines, 'OLD_TEXT', path.index + 1);
  if (!oldStart) return null;
  const oldBlock = readMarkerBlock(lines, oldStart, 'END_OLD_TEXT');
  if (!oldBlock) return null;
  const newStart = findMarker(lines, 'NEW_TEXT', oldBlock.next);
  if (!newStart) return null;
  const newBlock = readMarkerBlock(lines, newStart, 'END_NEW_TEXT');
  if (!newBlock) return null;
  const filePath = path.rest.trim();
  if (!filePath) return null;
  return {
    tool: 'edit_file',
    args: {
      path: filePath,
      old_text: oldBlock.text,
      new_text: newBlock.text
    }
  };
}

function parseWriteFilesMarkers(lines: string[], from: number): ToolCall | null {
  const files: Array<{ path: string; content: string }> = [];
  let cursor = from;
  while (cursor < lines.length) {
    // sărim peste separatoarele `---FILE---` și liniile goale dintre fișiere
    while (
      cursor < lines.length &&
      (MARKER_FILE_SEPARATOR_RE.test(lines[cursor]) || !lines[cursor].trim())
    ) {
      cursor++;
    }
    const path = findMarker(lines, 'PATH', cursor, MARKER_FILE_SEPARATOR_RE);
    if (!path) break;
    const content = findMarker(
      lines,
      'CONTENT',
      path.index + 1,
      MARKER_FILE_SEPARATOR_RE
    );
    if (!content) break;
    const block = readMarkerBlock(
      lines,
      content,
      'END_CONTENT',
      MARKER_FILE_SEPARATOR_RE
    );
    if (!block) break;
    const filePath = path.rest.trim();
    if (!filePath) break;
    files.push({ path: filePath, content: block.text });
    cursor = block.next;
  }
  if (!files.length) return null;
  return { tool: 'write_files', args: { files } };
}

/**
 * v2.5.27 (bug #63) FIX 2: căile-alias `.ts.txt` primite de la AI (eticheta pe
 * care a văzut-o la citire) se traduc înapoi în căile reale (`.ts`) — astfel
 * aprobarea, diff-ul, verificarea de trunchiere și scrierea pe disc lucrează
 * pe fișierul ORIGINAL. Traducerile se loghează prin tsAlias (drenate de
 * chatView, care are canalul Output).
 */
function withResolvedPaths(call: ToolCall): ToolCall {
  const { args, mappings } = mapToolCallAliases(call.tool, call.args);
  if (!mappings.length || !args) return call;
  for (const m of mappings) queueAliasLog(m);
  return { tool: call.tool, args };
}

/**
 * Extrage un tool call din formatul marker-based (conținut RAW, fără escape).
 * Întoarce null pentru orice alt tool sau bloc incomplet → fallback pe JSON.
 */
export function parseMarkerToolCall(text: string): ToolCall | null {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_TOOL_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const tool = m[1].toLowerCase();
    if (!MARKER_TOOLS.has(tool)) return null;
    if (tool === 'write_file') {
      const call = parseWriteFileMarkers(lines, i + 1);
      return call ? withCommandTabsFixed(withResolvedPaths(call)) : null;
    }
    if (tool === 'edit_file') {
      const call = parseEditFileMarkers(lines, i + 1);
      return call ? withCommandTabsFixed(withResolvedPaths(call)) : null;
    }
    const call = parseWriteFilesMarkers(lines, i + 1);
    return call ? withCommandTabsFixed(withResolvedPaths(call)) : null;
  }
  return null;
}

/** true când textul conține un `TOOL:` / `ACTION:` pentru o unealtă cu conținut liber. */
export function looksLikeMarkerToolCallAttempt(text: string): boolean {
  return String(text ?? '')
    .split(/\r?\n/)
    .some((line) => {
      const m = MARKER_TOOL_LINE_RE.exec(line);
      return !!m && MARKER_TOOLS.has(m[1].toLowerCase());
    });
}

/* =========================================================================
 * v2.5.39 FIX (bug #90) — recuperarea tool call-urilor „malformed"
 * În testul v2.5.37 (Gemini) pașii 1–8 au mers, dar la pasul 9 modelul a
 * trimis `TOOL: run_command` urmat de JSON-ul pe linia următoare:
 *
 *     TOOL: run_command
 *     {"command": "rm bootcamp-test2/test.ts"}
 *
 * Markerul era recunoscut doar pentru uneltele cu conținut liber (write_file /
 * edit_file / write_files), iar JSON-ul fără cheia „tool" era respins ⇒ apelul
 * PERFECT VALID ajungea la auto-retry, modelul renunța, iar cleanup-ul nu se
 * mai făcea (raport final fals „10/10"). Aici, DUPĂ ce formatul exact a
 * eșuat, căutăm tolerant în tot răspunsul:
 *   1. un marker `TOOL:` / `ACTION: <nume>` urmat de un obiect JSON (pe linia
 *      următoare, în fence ```json sau lipit de nume);
 *   2. obiectul JSON respectiv poate avea el însuși forma `{"tool"/"action":
 *      …, "args": {…}}` sau cheile de args direct (`{"command": "…"}`);
 * textul dinaintea / de după JSON e ignorat, indentarea nu contează.
 * Dacă nici așa nu iese un apel valid ⇒ comportamentul de dinainte (auto-retry
 * + MALFORMED_TOOL_CALL_ERROR).
 * ========================================================================= */

/** Câte caractere după marker căutăm JSON-ul (payload-ul e oricum mic). */
const RECOVERY_JSON_WINDOW = 4000;

/**
 * `TOOL: nume` / `ACTION: nume` — tolerant la text după nume pe aceeași linie
 * (`TOOL: run_command {"command": "…"}`), spre deosebire de
 * MARKER_TOOL_LINE_RE, care cere linia să se termine după nume.
 */
const MARKER_TOOL_HEAD_RE = new RegExp(
  '^[ \\t]*' + MARKER_PREFIX + '[ \\t]*:[ \\t]*([A-Za-z_][A-Za-z0-9_]*)\\b',
  'im'
);

/** Args obligatorii ale uneltelor cu conținut liber (vezi MARKER_TOOLS). */
const RECOVERY_REQUIRED_ARGS: Record<string, string[]> = {
  write_file: ['path', 'content'],
  edit_file: ['path', 'old_text', 'new_text'],
  write_files: ['files']
};

/** Primul obiect JSON echilibrat din text, parsat tolerant (sau null). */
function firstJsonObject(text: string): any | null {
  const spans = scanObjects(text);
  if (!spans.length) return null;
  let first = spans[0];
  for (const span of spans) {
    if (span.start < first.start) first = span;
  }
  return tryParseJsonObject(text.slice(first.start, first.end + 1));
}

/** Args-urile dintr-un payload JSON: `{"args": {…}}` sau cheile directe. */
function payloadArgs(parsed: any): any {
  const args = parsed?.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (Array.isArray(args)) return args; // write_files trimis ca array (bug #65)
  const { tool, action, ...rest } = parsed ?? {};
  return rest;
}

/** true când uneltele cu conținut liber au TOATE args-urile obligatorii. */
function hasRequiredArgs(tool: string, args: any): boolean {
  const required = RECOVERY_REQUIRED_ARGS[tool];
  if (!required) return true;
  if (!args || typeof args !== 'object') return false;
  return required.every((key) => (args as Record<string, unknown>)[key] !== undefined);
}

/**
 * Recuperează apelul din forma `TOOL: <nume>` + JSON. Întoarce null când nu
 * există un JSON valid după marker sau când lipsesc args-urile obligatorii
 * (atunci răspunsul rămâne tratat ca malformed, ca înainte).
 */
function recoverToolCallFromMarker(text: string): ToolCall | null {
  const m = MARKER_TOOL_HEAD_RE.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const after = text.slice(
    m.index + m[0].length,
    m.index + m[0].length + RECOVERY_JSON_WINDOW
  );
  const parsed = firstJsonObject(after);
  if (!parsed) return null;

  // JSON-ul poate conține el însuși apelul (`TOOL: x` + `{"tool":"y", …}`)
  const inner = normalizeToolCall(parsed);
  if (inner) return hasRequiredArgs(inner.tool, inner.args) ? inner : null;

  const args = normalizeWriteFilesArgs(name, payloadArgs(parsed));
  if (!hasRequiredArgs(name, args)) return null;
  return { tool: name, args };
}

/**
 * true când textul are un marker `TOOL: <nume>` urmat de începutul unui JSON
 * (chiar dacă acel JSON e trunchiat și nu poate fi recuperat) — tot o
 * ÎNCERCARE de tool call, deci merită auto-retry-ul de „malformed".
 */
function looksLikeMarkerPayloadAttempt(text: string): boolean {
  const m = MARKER_TOOL_HEAD_RE.exec(text);
  if (!m) return false;
  return text.slice(m.index + m[0].length).includes('{');
}

/**
 * Extrage tool call-ul din răspunsul modelului, oricât de mult text l-ar
 * înconjura (proză, fence markdown, JSON nested în `content`).
 * v2.4.9: întâi formatul marker-based (conținut RAW, fără escape), apoi JSON.
 * v2.5.39 (bug #90): dacă ambele eșuează, încercăm recuperarea tolerantă
 * (`TOOL: <nume>` + JSON oriunde în răspuns) înainte de a declara malformed.
 */
export function parseToolCallText(text: string): ToolCall | null {
  const src = String(text ?? '');
  if (!src.trim()) return null;

  const markerCall = parseMarkerToolCall(src);
  if (markerCall) return markerCall;

  for (const candidate of collectCandidates(src)) {
    const parsed = tryParseJsonObject(candidate);
    if (!parsed) continue;
    const call = normalizeToolCall(parsed);
    if (call) return withCommandTabsFixed(withResolvedPaths(call));
  }

  const recovered = recoverToolCallFromMarker(src);
  if (recovered) {
    queueParserLog(
      '[parser] recovered tool call from malformed input: ' + recovered.tool,
      false
    );
    return withCommandTabsFixed(withResolvedPaths(recovered));
  }

  return null;
}

/**
 * true când răspunsul e clar o ÎNCERCARE de tool call (începe cu `{"tool":` /
 * `{"action":`, eventual în fence markdown — sau conține un bloc marker-based
 * `TOOL:` / `ACTION:`) care nu a putut fi parsat — merită un mesaj de eroare
 * clar, nu afișarea JSON-ului brut ca răspuns final.
 * v2.5.39 (bug #90): și `TOOL: <nume necunoscut>` + JSON e tot o încercare.
 */
export function looksLikeToolCallAttempt(text: string): boolean {
  const src = String(text ?? '');
  const head = stripLeadingFence(src);
  return (
    TOOL_MARKER_HEAD_RE.test(head) ||
    ACTION_MARKER_HEAD_RE.test(head) ||
    looksLikeMarkerToolCallAttempt(src) ||
    looksLikeMarkerPayloadAttempt(src)
  );
}
