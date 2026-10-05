import type { ToolCall } from './tools';

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
 * ========================================================================= */

/** Mesaj afișat utilizatorului când răspunsul e clar o încercare de tool call
 *  care nu poate fi parsat nici după reparațiile tolerante. */
export const MALFORMED_TOOL_CALL_ERROR =
  'Model returned malformed tool call. Try again or switch provider.';

/** v2.5.3 FIX 7: câte reluări facem înainte de a afișa MALFORMED_TOOL_CALL_ERROR. */
export const MAX_MALFORMED_RETRIES = 1;

/**
 * v2.5.3 FIX 7: nudge trimis modelului când răspunsul conține `TOOL:` dar nu
 * poate fi parsat (ex: DeepSeek ecouază promptul și strivesc conținutul pe o
 * singură linie). Cerem explicit formatul marker cu conținut în code fence.
 */
export const MALFORMED_TOOL_CALL_NUDGE = `SYSTEM NOTICE — MALFORMED TOOL CALL.

Your previous response was malformed. Try again.
Use TOOL: write_file with content in a code fence, one item per line:

TOOL: write_file
PATH: <relative path>
CONTENT:
\`\`\`text
<file content — one line per line>
\`\`\`
END_CONTENT

Do NOT echo the user message. Do NOT explain. Reply with EXACTLY ONE tool call and nothing else.`;

/** Început de obiect JSON cu cheia „tool” (acceptă și spații în plus). */
const TOOL_MARKER_HEAD_RE = /^\{\s*["']?tool["']?\s*:/;

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

/** Normalizează obiectul parsat la {tool, args} (inclusiv forma legacy „action"). */
function normalizeToolCall(parsed: any): ToolCall | null {
  if (!parsed || typeof parsed !== 'object' || typeof parsed.tool !== 'string') {
    return null;
  }

  if (parsed.args && typeof parsed.args === 'object') {
    return { tool: parsed.tool, args: parsed.args };
  }

  if (typeof parsed.action === 'string') {
    const { tool, action, ...rest } = parsed;
    return { tool: `${tool}_${action}`, args: rest };
  }

  return { tool: parsed.tool, args: {} };
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
 * ========================================================================= */

/** `TOOL: nume` singur pe linie (case-insensitive, whitespace ignorat). */
const MARKER_TOOL_LINE_RE =
  /^[ \t]*TOOL[ \t]*:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/i;

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
  return { text: normalizeContentNewlines(stripWrappingFence(text)), next: end + 1 };
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
    if (tool === 'write_file') return parseWriteFileMarkers(lines, i + 1);
    if (tool === 'edit_file') return parseEditFileMarkers(lines, i + 1);
    return parseWriteFilesMarkers(lines, i + 1);
  }
  return null;
}

/** true când textul conține un `TOOL:` pentru o unealtă cu conținut liber. */
export function looksLikeMarkerToolCallAttempt(text: string): boolean {
  return String(text ?? '')
    .split(/\r?\n/)
    .some((line) => {
      const m = MARKER_TOOL_LINE_RE.exec(line);
      return !!m && MARKER_TOOLS.has(m[1].toLowerCase());
    });
}

/**
 * Extrage tool call-ul din răspunsul modelului, oricât de mult text l-ar
 * înconjura (proză, fence markdown, JSON nested în `content`).
 * v2.4.9: întâi formatul marker-based (conținut RAW, fără escape), apoi JSON.
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
    if (call) return call;
  }

  return null;
}

/**
 * true când răspunsul e clar o ÎNCERCARE de tool call (începe cu `{"tool":`,
 * eventual în fence markdown — sau conține un bloc marker-based `TOOL:`) care
 * nu a putut fi parsat — merită un mesaj de eroare clar, nu afișarea JSON-ului
 * brut ca răspuns final.
 */
export function looksLikeToolCallAttempt(text: string): boolean {
  const src = String(text ?? '');
  return (
    TOOL_MARKER_HEAD_RE.test(stripLeadingFence(src)) ||
    looksLikeMarkerToolCallAttempt(src)
  );
}
