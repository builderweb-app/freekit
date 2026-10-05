import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Page } from 'playwright';
import {
  createProvider,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  BROWSER_PROVIDER_IDS,
  getProviderStatus,
  ollamaInstallState,
  ProviderStatusInfo
} from './providers';
import { pullOllamaModel } from './providers/ollama';
import {
  detectHardware,
  fitsThisMachine,
  hardwareReport,
  hardwareSummary,
  modelSpeed,
  recommendModels,
  tierTarget
} from './hardware';
import { AIProvider } from './providers/types';
import { applyModel, browserModelKey, listModels, modelLabel } from './modelSelector';
import { configInfo, selectors } from './selectors';
import { BrowserManager } from './browser';
import {
  executeTool,
  isToolTrustRequired,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LOCAL,
  ToolCall,
  ToolResult,
  FileChangePreview,
  computeDiffStats,
  pendingApprovals,
  newApprovalId,
  resetWriteLimits,
  resetCommandLimits,
  MAX_TEXT_RETRIES,
  TEXT_RETRY_NUDGE,
  looksLikeIntentOnly
} from './tools';
import {
  MALFORMED_TOOL_CALL_ERROR,
  MALFORMED_TOOL_CALL_NUDGE,
  MAX_MALFORMED_RETRIES,
  looksLikeToolCallAttempt,
  parseToolCallText
} from './toolCallParser';
import { mcp } from './mcp/manager';
import { Attachment, describePath, prepareAttachments } from './attachments';
import { detectProject, formatProjectInfo } from './project';
import { initLogChannel, logLine } from './log';
import { detectCaptcha, isLoginRequiredError, isLoginUrl, sleep } from './providers/base';
import { DetectedProviderError } from './providerErrors';
import { runVerification, createPromptCheckpoint, restoreToCheckpoint, Checkpoint } from './verifier';
import { ConversationStore, ConversationMessage } from './conversations';
import { EditRollback } from './rollback';
import {
  RESTRICTED_BLOCKED_NOTICE,
  RESTRICTED_NOTICE,
  RESTRICTED_TOOL_ERROR,
  showRestrictedNotification
} from './trust';
import { transcribeAudioFile } from './stt';
import {
  startVoiceCapture,
  voiceTempDir,
  isTooShortVoiceWav,
  VoiceCapture,
  VoiceCaptureResult
} from './voiceRecorder';

const log = (msg: string) => logLine('chat', msg);

// FAZA III (E): bucla agentică — 40 de pași per mesaj
const MAX_ITERATIONS = 40;

// FAZA II (A): limita de atașamente simultane
const MAX_ATTACHMENTS = 20;

// FAZA D: directoare ignorate în structura trimisă AI-ului
const STRUCTURE_EXCLUDE = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.next',
  '.cache',
  'chrome-profile',
  '.vscode',
  'coverage'
]);

const STRUCTURE_MAX_ENTRIES = 300;

// FAZA E: persistență — istoricul conversației (max 100 mesaje, în globalState)
const HISTORY_KEY = 'freekit.history';
const HISTORY_MAX = 100;

// v0.2.1: auto-approve (persistat în globalState)
const AUTO_APPROVE_KEY = 'freekit.autoApprove';

// v0.4.0: ultimul provider web folosit (modul Auto îl încearcă primul)
const LAST_BROWSER_KEY = 'freekit.lastBrowserProvider';

// v0.5.0: fișiere aprobate cu „nu mai întreba" (diff nativ, persistat)
const NO_ASK_KEY = 'freekit.noAskFiles';

// v0.5.0: eticheta butonului „nu mai întreba" din notificarea de diff
const NO_ASK_LABEL = 'Accept (don\'t ask again)';

// v2.4.9: exemplu concret de format marker-based trimis modelului în prompt —
// conținutul RAW între markeri, ca să nu mai apară JSON cu ghilimele neescapeate.
// v2.5.1 — FIX B1: conținutul stă într-un code fence markdown — doar așa
// caracterele #, *, _ și backtick-urile supraviețuiesc randării din chatul web.
const MARKER_FORMAT_EXAMPLE = `Example — creating a file:
TOOL: write_file
PATH: src/hello.ts
CONTENT:
\`\`\`ts
export function hello() {
  return "salut";
}
\`\`\`
END_CONTENT`;

// v1.7.1: verbose mode — pașii AI afișați în chat (persistat în globalState)
const VERBOSE_KEY = 'freekit.verboseMode';

// v0.5.0: contor pentru nume de fișiere temporare unice
let reviewSeq = 0;

// v0.9.1: asistentul de login — cât timp ținem Chrome vizibil, pasul de
// polling al URL-ului și numărul maxim de reluări după login
const LOGIN_WAIT_MS = 5 * 60_000;
const LOGIN_POLL_MS = 2500;
const LOGIN_MAX_ASSISTS = 2;

// v1.8.0: asistentul de CAPTCHA — aceleași limite ca la login (5 min, poll 2.5s)
const CAPTCHA_WAIT_MS = 5 * 60_000;
const CAPTCHA_POLL_MS = 2500;

// v1.3.0: auto-verify — tool-urile de scriere care declanșează verificarea
const AUTO_VERIFY_TOOLS = new Set(['edit_file', 'write_file', 'write_files']);

// v1.3.0: câte auto-repair-uri încercăm înainte de rollback-ul automat
const MAX_VERIFY_REPAIRS = 3;

// v1.4.0: checkpoint-uri git per prompt (persistate în globalState)
const CHECKPOINTS_KEY = 'freekit.checkpoints';
const CHECKPOINTS_MAX = 50;

// v1.9.0: id-uri sigure de mesaj (leagă mesajul de checkpoint / conversație)
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** v2.0.2: „4.4 GB" / „512 MB" pentru dimensiunea unui model Ollama instalat. */
function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return Math.round(bytes / 1024 ** 2) + ' MB';
}

interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** v1.4.0: id-ul mesajului (leagă mesajul de checkpoint-ul git). */
  id?: string;
}

/**
 * Generează un arbore de fișiere al proiectului (max `maxDepth` niveluri,
 * max 300 intrări). Trimis AI-ului ca context, ca să știe ce fișiere
 * există fără să le citească unul câte unul.
 */
async function getProjectStructure(
  root: string,
  maxDepth = 3
): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  const rootName = path.basename(root) || root;
  lines.push(rootName + '/');

  async function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth || count >= STRUCTURE_MAX_ENTRIES) return;

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(dir)
      );
    } catch {
      return; // director inaccesibil — îl ignorăm
    }

    // directoarele primesc prioritate, apoi ordine alfabetică
    const visible = entries
      .filter(
        ([name, type]) =>
          !(type === vscode.FileType.Directory && STRUCTURE_EXCLUDE.has(name))
      )
      .sort((a, b) => {
        const aDir = a[1] === vscode.FileType.Directory ? 0 : 1;
        const bDir = b[1] === vscode.FileType.Directory ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a[0].localeCompare(b[0]);
      });

    for (let i = 0; i < visible.length; i++) {
      if (count >= STRUCTURE_MAX_ENTRIES) break;
      const [name, type] = visible[i];
      const isDir = type === vscode.FileType.Directory;
      const isLast = i === visible.length - 1;

      lines.push(
        prefix + (isLast ? '└── ' : '├── ') + name + (isDir ? '/' : '')
      );
      count++;

      if (isDir && depth < maxDepth) {
        await walk(
          path.join(dir, name),
          depth + 1,
          prefix + (isLast ? '    ' : '│   ')
        );
      }
    }
  }

  await walk(root, 1, '');

  if (count >= STRUCTURE_MAX_ENTRIES) {
    lines.push('... (truncated at ' + STRUCTURE_MAX_ENTRIES + ' entries)');
  }
  return lines.join('\n');
}

/* =========================================================================
 * FIX v1.2.1 — card inline de review (Accept / Reject în chat)
 * Notificarea VS Code poate fi ascunsă, expirată sau nerandată — utilizatorul
 * rămânea blocat în fața diff-ului. Cardul din chat e sursa principală de
 * decizie; notificarea rămâne activă ca a doua cale. Ambele ajung la aceeași
 * promisiune, iar prima decizie câștigă.
 * ========================================================================= */

/** Diff simplu (linie cu linie, max 30 de perechi) pentru cardul inline. */
export function generateDiffPreview(oldText: string, newText: string): string {
  if (!oldText) return '+ ' + newText.slice(0, 500);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  let changes = 0;
  for (let i = 0; i < max && changes < 30; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined) out.push('- ' + o);
    if (n !== undefined) out.push('+ ' + n);
    changes++;
  }
  return out.join('\n') || '(no changes)';
}

/**
 * v2.0.1: rând inline de „file change" (filename + diff stats + Approve/Reject)
 * trimis webview-ului, în paralel cu diff-ul nativ VS Code.
 */
export interface FileChangeRow {
  rowId: string;
  reviewId: string;
  filename: string;
  added: number;
  removed: number;
  isNew: boolean;
}

/** Preview combinat pentru toate fișierele unui review (cap 8000 de caractere). */
export function buildReviewPreview(changes: FileChangePreview[]): string {
  const parts = changes.map(
    (c) =>
      (changes.length > 1 ? '=== ' + c.label + ' ===\n' : '') +
      generateDiffPreview(c.oldContent, c.newContent)
  );
  const text = parts.join('\n\n');
  return text.length > 8000 ? text.slice(0, 8000) + '\n… (truncated)' : text;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'freekit.chatView';
  private view?: vscode.WebviewView;
  private abortRequested = false;
  private abortController?: AbortController;
  /** FAZA I: providerul + pagina folosite acum (pentru Stop / auto-reparare). */
  private active?: { provider: AIProvider; page?: Page };
  /** FAZA II (A): atașamentele curente (chip-urile din UI). */
  private attachments: Attachment[] = [];
  /** v2.0.4: ultimul prompt trimis — folosit de butonul Retry din cardul de login. */
  private lastUserText = '';
  /** v2.0.5: Chrome a fost adus automat în față pentru login — îl trimitem înapoi
   *  în fundal la următorul mesaj (randarea nu mai are nevoie de el vizibil). */
  private chromeShownForLogin = false;
  /** v0.2.1: aprobă automat toate operațiile care necesită confirmare. */
  private autoApprove = false;
  /** v0.4.0: guard anti-suprapunere pentru verificarea de status. */
  private statusInFlight = false;
  /** v0.5.0: deblochează diff review-ul în așteptare (Stop / auto-approve). */
  private pendingReviewResolve?: () => void;
  /**
   * v1.2.1: review de diff în așteptare — decizia din cardul inline din chat
   * (butoanele Accept / Reject). Cât timp e setat, cardul poate fi re-afișat
   * după un reload al webview-ului, iar răspunsul lui deblochează review-ul.
   */
  private pendingInlineReview?: {
    id: string;
    resolve: (d: '__inline_accept__' | '__inline_reject__') => void;
  };
  /** v1.2.1: payload-ul cardului inline (pentru re-post după reload webview). */
  private pendingInlineReviewPayload?: {
    id: string;
    tool: string;
    target: string;
    preview: string;
    /** v2.0.1: rândurile inline de „file change" (re-postate după reload). */
    rows?: FileChangeRow[];
  };
  /**
   * v2.0.1: rândurile inline de „file change" din chat — paralele cu diff-ul
   * nativ VS Code. Stochează perechile temporare ca click-ul pe numele
   * fișierului să poată redeschide diff-ul nativ.
   */
  private pendingFileRows?: {
    reviewId: string;
    single: boolean;
    title: string;
    rows: FileChangeRow[];
    pairs: Array<{ label: string; left: vscode.Uri; right: vscode.Uri }>;
  };
  /** v1.3.0: snapshot-uri pre-editare pentru rollback-ul automat. */
  private edits = new EditRollback();
  /** v1.3.0: câte auto-repair-uri am cerut pentru seria curentă de verificări eșuate. */
  private verifyRepairs = 0;
  /**
   * v2.5.0: a trecut vreodată verificarea? Fără o verificare verde nu există
   * un „verified-good state" real, iar rollback-ul ar readuce proiectul la
   * starea goală (ștergând fișierele noi, valide) — vezi doRollback().
   * Persistă peste mesaje (NU se reseta în resetVerifyState).
   */
  private hasEverVerifiedGreen = false;
  /** v1.3.0: ultima verificare eșuată (pentru mesajul de rollback). */
  private lastVerifyFailure?: {
    command: string;
    output: string;
    seconds: string;
  };
  /** v1.4.0: checkpoint-urile git per mesaj (butonul ⟲ de restore). */
  private checkpoints: Checkpoint[] = [];
  /** v1.5.0: explicația „fără checkpoint” se afișează o singură dată */
  private checkpointNoticeShown = false;
  /** v1.9.0: conversațiile multiple (fork / edit prompt) — persistate în globalState. */
  private readonly conversations: ConversationStore;
  /** v1.7.1: verbose mode — contor de id-uri + cardul „Thinking" al mesajului curent */
  private verboseSeq = 0;
  private verboseThinkId?: string;
  /** v1.10.2: tot thinking-ul afișat la promptul curent (anti-duplicare). */
  private verboseThinkText = '';
  /** v1.10.3: cardul „Thinking" e deschis (modelul încă raționează). */
  private verboseThinkOpen = false;
  /** v1.7.3: captarea audio rulează în Extension Host (webview-ul n-are microfon). */
  private voiceCapture: VoiceCapture | null = null;
  private voiceStarting = false;
  private voiceStopQueued = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly browser: BrowserManager,
    private readonly state: vscode.Memento,
    /** v1.7.2: rădăcina globalStorage (asset-urile Whisper pentru voice input). */
    private readonly globalStorageRoot: string = ''
  ) {
    // v0.2.1: starea toggle-ului Auto-approve (persistată)
    this.autoApprove = state.get<boolean>(AUTO_APPROVE_KEY, false) === true;
    log('auto-approve: ' + (this.autoApprove ? 'ON' : 'OFF'));
    // v1.4.0: istoricul de checkpoint-uri git (max CHECKPOINTS_MAX)
    this.checkpoints = state.get<Checkpoint[]>(CHECKPOINTS_KEY, []) ?? [];
    // v1.9.0: magazinul de conversații (listă + conversația activă, în globalState)
    this.conversations = new ConversationStore(state);

    // FAZA I: anunță în chat când un selector a fost reparat automat
    selectors.setNotifier((info) => {
      const text =
        'Selector repaired automatically: ' +
        info.provider +
        '.' +
        info.slot +
        ' → ' +
        info.selector;
      log(text);
      this.post('notice', text);
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    // v2.4.1: în Restricted Mode cardul rămâne vizibil în chat — notificarea
    // VS Code poate fi închisă, dar aici utilizatorul vede mereu ce are de făcut.
    if (!vscode.workspace.isTrusted) {
      this.post('notice', '🔒 ' + RESTRICTED_NOTICE);
    }
    // v1.7.3: oprește captarea audio dacă view-ul e distrus (fără finalizare)
    view.onDidDispose(() => {
      const cap = this.voiceCapture;
      this.voiceCapture = null;
      if (cap) void cap.abort();
    });
  }

  /**
   * v2.5.1: acceptă și un payload structurat (ex: `provider_error` cu
   * kind/resetTime/upgradeUrl) — câmpurile ajung direct pe mesaj, ca în
   * webview să fie citite ca `msg.kind`, `msg.message` etc.
   */
  private post(type: string, text: string | Record<string, unknown>) {
    this.view?.webview.postMessage(
      typeof text === 'string' ? { type, text } : { type, ...text }
    );
  }

  /** v1.1.0: notice public — alte module (ex: managerul MCP) scriu în chat. */
  postNotice(text: string) {
    this.post('notice', text);
  }

  /** v1.6.0: limba voice input (butonul 🎤) — din setarea freekit.sttLanguage. */
  private sttLanguage(): string {
    const v = vscode.workspace
      .getConfiguration('freekit')
      .get<string>('sttLanguage', 'ro-RO');
    return v === 'en-US' ? 'en-US' : 'ro-RO';
  }

  /* ======================================================================
   * v1.7.1 — VERBOSE MODE (transparență: pașii AI în chat)
   * Cu toggle-ul 🔍 activ, fiecare pas al buclei agentice e trimis
   * webview-ului ca mesaj `verbose` (kind: thinking | executing | result |
   * decision) și afișat colapsabil, grupat pe tip. Cu toggle-ul oprit nu se
   * trimite nimic — comportamentul rămâne cel de dinainte.
   * ==================================================================== */

  /** Starea toggle-ului Verbose mode (persistată în globalState). */
  private verboseEnabled(): boolean {
    return this.state.get<boolean>(VERBOSE_KEY, false) === true;
  }

  /** v2.0.1: nivelul de „thinking" (UI + storage; fără efect pe motor încă). */
  private thinkingLevel(): string {
    const value = vscode.workspace
      .getConfiguration('freekit')
      .get<string>('thinkingLevel', 'medium');
    return ['off', 'low', 'medium', 'high'].includes(
      String(value).toLowerCase()
    )
      ? String(value).toLowerCase()
      : 'medium';
  }

  /**
   * Trimite (sau actualizează, după `id`) un pas verbose în chat.
   * Întoarce id-ul folosit, ca apelantul să poată actualiza același card.
   */
  private postVerboseStep(step: {
    kind: 'thinking' | 'executing' | 'result' | 'decision';
    id?: string;
    title?: string;
    text?: string;
    status?: 'running' | 'done' | 'error';
    append?: boolean;
  }): string {
    // v1.10.3: orice pas care nu e „thinking" închide cardul „Thinking" activ
    if (step.kind !== 'thinking') this.finishThinking();
    const id = step.id ?? 'vs' + ++this.verboseSeq;
    if (!this.verboseEnabled()) return id;
    this.view?.webview.postMessage({
      type: 'verbose',
      step: {
        id,
        kind: step.kind,
        title: step.title ?? '',
        text: step.text ?? '',
        status: step.status ?? 'done',
        append: step.append === true
      }
    });
    return id;
  }

  /**
   * Thinking-ul raportat de provider (AIProvider.onThinking).
   * v1.10.2: providerii web citesc „ultimul bloc de raționament din pagină" la
   * FIECARE pas al buclei agentice, iar blocul pasului anterior rămâne montat —
   * același text era deci raportat (și adăugat în card) încă o dată. Afișăm
   * fiecare bloc o singură dată; dacă blocul s-a extins între timp, trimitem
   * doar diferența (webview-ul adaugă textul la cardul existent).
   */
  private handleModelThinking(text: string): void {
    const clean = String(text || '').trim();
    if (!clean || !this.verboseEnabled()) return;
    const shown = this.verboseThinkText;
    let chunk = clean;
    if (shown) {
      if (shown.includes(clean)) return; // deja afișat (identic sau ca prefix)
      if (clean.startsWith(shown)) chunk = clean.slice(shown.length).trim();
    }
    if (!chunk) return;
    this.verboseThinkText = shown
      ? clean.startsWith(shown)
        ? clean
        : shown + '\n\n' + clean
      : clean;
    if (!this.verboseThinkId) this.verboseThinkId = 'think' + ++this.verboseSeq;
    // v1.10.3: cât timp raționează, cardul rămâne deschis (text live)
    this.verboseThinkOpen = true;
    this.postVerboseStep({
      kind: 'thinking',
      id: this.verboseThinkId,
      title: 'Model thinking',
      text: chunk.length > 6000 ? chunk.slice(0, 6000) + '\n… (truncated)' : chunk,
      status: 'running',
      append: true
    });
  }

  /**
   * v1.10.3: închide cardul „Thinking" curent (modelul a trecut la răspuns sau
   * la o acțiune) — webview-ul îl pliază automat și afișează durata totală.
   */
  private finishThinking(): void {
    if (!this.verboseThinkOpen) return;
    this.verboseThinkOpen = false;
    if (!this.verboseThinkId) return;
    this.postVerboseStep({ kind: 'thinking', id: this.verboseThinkId, status: 'done' });
  }

  /** Rezumat scurt al unui tool call (pentru pașii Executing / Decision). */
  private summarizeToolCall(call: ToolCall): string {
    try {
      const a: any = call.args ?? {};
      const bits: string[] = [];
      if (typeof a.command === 'string' && a.command) bits.push('$ ' + a.command);
      if (typeof a.script === 'string' && a.script) bits.push('script: ' + a.script);
      if (typeof a.path === 'string' && a.path) bits.push(a.path);
      if (Array.isArray(a.files)) bits.push(a.files.length + ' files');
      if (typeof a.query === 'string' && a.query) bits.push('"' + a.query + '"');
      if (typeof a.url === 'string' && a.url) bits.push(a.url);
      if (!bits.length) {
        const json = JSON.stringify(a);
        bits.push(json.length > 300 ? json.slice(0, 300) + '…' : json);
      }
      return bits.join(' · ');
    } catch {
      return '';
    }
  }

  /* ======================================================================
   * v1.7.3 — VOICE INPUT: CAPTARE ÎN EXTENSION HOST + WHISPER LOCAL
   * Webview-ul NU mai înregistrează (getUserMedia → NotAllowedError în
   * sandbox-ul VS Code). Captarea rulează aici, în Node.js: nativ pe Windows
   * (PowerShell + winmm, ZERO dependențe externe) sau prin SoX unde există
   * (`rec`/`sox` în PATH). Webview-ul cere pornirea/oprirea („stt_start” /
   * „stt_stop”), primește starea („stt_state”) și rezultatul transcrierii
   * Whisper („stt_result”).
   * ==================================================================== */

  /** v1.7.2: timeout-ul de transcriere din setări (10–1200s, implicit 180). */
  private whisperTimeoutSeconds(): number {
    const raw = Number(
      vscode.workspace
        .getConfiguration('freekit')
        .get<number>('whisperTimeoutSeconds', 180)
    );
    return Number.isFinite(raw) ? Math.min(1200, Math.max(10, Math.floor(raw))) : 180;
  }

  /** v1.7.3: trimite webview-ului starea captării audio. */
  private postSttState(
    state: 'idle' | 'starting' | 'recording' | 'transcribing',
    extra?: { startedAt?: number; backend?: string }
  ): void {
    this.view?.webview.postMessage({ type: 'stt_state', state, ...(extra ?? {}) });
  }

  private postSttResult(payload: {
    ok: boolean;
    text?: string;
    error?: string;
    seconds?: number;
    engine?: string;
    stage?: 'capture' | 'short' | 'transcribe';
  }): void {
    this.postSttState('idle');
    this.view?.webview.postMessage({ type: 'stt_result', ...payload });
  }

  /** v1.7.3: pornește captarea în Extension Host (rezolvă după READY). */
  private async handleSttStart(): Promise<void> {
    if (this.voiceStarting || this.voiceCapture) return;
    this.voiceStarting = true;
    this.voiceStopQueued = false;
    this.postSttState('starting');
    const dir = path.join(voiceTempDir(), 'rec-' + Date.now());
    const outFile = path.join(dir, 'audio.wav');
    try {
      const cap = await startVoiceCapture({
        outFile,
        onLog: (m) => log('voice: ' + m)
      });
      this.voiceStarting = false;
      this.voiceCapture = cap;
      cap.onAutoStop = () => {
        log('voice: recorder stopped on its own — finishing up');
        void this.handleSttStop();
      };
      if (this.voiceStopQueued) {
        this.voiceStopQueued = false;
        void this.handleSttStop();
        return;
      }
      log('voice: recording (' + cap.kind + ') → ' + outFile);
      this.postSttState('recording', { startedAt: cap.startedAt, backend: cap.kind });
    } catch (e: any) {
      this.voiceStarting = false;
      const msg = e?.message ?? String(e);
      log('voice: start failed — ' + msg);
      this.postSttResult({
        ok: false,
        stage: 'capture',
        error:
          'Could not start the microphone: ' +
          msg +
          '\nCheck the default microphone and the Windows permission (Settings → Privacy → Microphone).'
      });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* curățarea e best-effort */
      }
    }
  }

  /** v1.7.3: oprește captarea, finalizează WAV-ul și transcrie cu Whisper. */
  private async handleSttStop(): Promise<void> {
    // dacă încă pornește, doar înregistrăm intenția — start-ul o va consuma
    if (this.voiceStarting) {
      this.voiceStopQueued = true;
      return;
    }
    const cap = this.voiceCapture;
    if (!cap) {
      this.postSttState('idle');
      return;
    }
    this.voiceCapture = null;
    this.postSttState('transcribing');
    let res: VoiceCaptureResult;
    try {
      res = await cap.stop();
    } catch (e: any) {
      res = { ok: false, error: e?.message ?? String(e) };
    }
    try {
      await this.finishStt(cap.outFile, res);
    } finally {
      try {
        fs.rmSync(path.dirname(cap.outFile), { recursive: true, force: true });
      } catch {
        /* curățarea e best-effort */
      }
    }
  }

  /** Validează înregistrarea și o transcrie cu whisper.cpp (local, offline). */
  private async finishStt(file: string, res: VoiceCaptureResult): Promise<void> {
    if (!res.ok) {
      log('voice: capture failed — ' + (res.error ?? 'unknown'));
      this.postSttResult({
        ok: false,
        stage: 'capture',
        error: res.error ?? 'audio capture failed'
      });
      return;
    }
    const bytes = res.bytes ?? 0;
    const seconds = Math.round((bytes / 32000) * 10) / 10;
    log('voice: capture OK (' + bytes + ' bytes ≈ ' + seconds + 's)');
    if (isTooShortVoiceWav(bytes)) {
      this.postSttResult({
        ok: false,
        stage: 'short',
        error: 'Recording too short — try again and speak a little longer.'
      });
      return;
    }
    try {
      const tres = await transcribeAudioFile(file, {
        globalStorageRoot: this.globalStorageRoot,
        language: this.sttLanguage(),
        timeoutMs: this.whisperTimeoutSeconds() * 1000
      });
      if (tres.ok) {
        log(
          'stt: transcribed in ' + tres.seconds + 's (' + tres.engine + '): „' +
            (tres.text ?? '').slice(0, 80) + '”'
        );
        this.postSttResult({
          ok: true,
          text: tres.text,
          seconds: tres.seconds,
          engine: tres.engine
        });
      } else {
        log('stt: failure — ' + tres.error);
        this.postSttResult({
          ok: false,
          stage: 'transcribe',
          error:
            tres.error + (tres.hints && tres.hints.length ? '\n' + tres.hints[0] : '')
        });
      }
    } catch (e: any) {
      log('stt: unexpected error — ' + (e?.message ?? String(e)));
      this.postSttResult({
        ok: false,
        stage: 'transcribe',
        error: e?.message ?? String(e)
      });
    }
  }

  private async handleMessage(msg: any) {
    // Răspuns la o cerere de aprobare
    if (msg.type === 'approval_response') {
      const resolver = pendingApprovals.get(msg.id);
      if (resolver) {
        resolver(msg.ok);
        pendingApprovals.delete(msg.id);
      }
      return;
    }

    // v1.2.1: răspunsul cardului INLINE de review (Accept / Reject din chat —
    // fallback pentru notificarea VS Code, care poate să nu apară)
    if (msg.type === 'diff_review_response') {
      const pending = this.pendingInlineReview;
      if (pending && pending.id === msg.id) {
        pending.resolve(
          msg.ok === true ? '__inline_accept__' : '__inline_reject__'
        );
      }
      return;
    }

    // v0.2.1: toggle Auto-approve (write_file/edit_file/run_command/git fără carduri)
    // v0.3.0 (P0.4): activarea cere confirmare explicită — toate operațiile
    // periculoase (scriere fișiere, shell, git) devin auto-aprobate.
    if (msg.type === 'set_auto_approve') {
      const enable = msg.enabled === true;
      if (enable && !this.autoApprove) {
        const pick = await vscode.window.showWarningMessage(
          '⚡ Auto-approve: ALL operations (file writes, shell commands, git) ' +
            'will run WITHOUT confirmation cards. Continue?',
          { modal: true },
          'Enable'
        );
        if (pick !== 'Enable') {
          // revertează bifa din UI (utilizatorul a renunțat)
          this.view?.webview.postMessage({ type: 'auto_approve', enabled: false });
          return;
        }
      }
      this.autoApprove = enable;
      await this.state.update(AUTO_APPROVE_KEY, this.autoApprove);
      if (this.autoApprove) {
        // deblochează imediat aprobările în așteptare
        for (const resolve of pendingApprovals.values()) resolve(true);
        pendingApprovals.clear();
        // v0.5.0: și diff review-ul nativ în așteptare (se acceptă automat)
        this.wakePendingReview();
        this.post(
          'notice',
          '⚡ Auto-approve ON — file writes and commands run without confirmation.'
        );
      } else {
        this.post('notice', 'Auto-approve off — operations ask for confirmation again.');
      }
      this.view?.webview.postMessage({ type: 'auto_approve', enabled: this.autoApprove });
      log('auto-approve: ' + (this.autoApprove ? 'ON' : 'OFF'));
      return;
    }

    // v1.7.1: toggle Verbose mode (transparență — pașii AI în chat)
    if (msg.type === 'set_verbose') {
      const enabled = msg.enabled === true;
      await this.state.update(VERBOSE_KEY, enabled);
      this.view?.webview.postMessage({ type: 'verbose_mode', enabled });
      this.post(
        'notice',
        enabled
          ? '🔍 Verbose mode ON — AI steps (Thinking / Executing / Result / Decision) appear in the chat.'
          : '🔍 Verbose mode off — only the final results stay visible.'
      );
      log('verbose mode: ' + (enabled ? 'ON' : 'OFF'));
      return;
    }

    // Oprește răspunsul în curs
    if (msg.type === 'stop') {
      this.abortRequested = true;
      this.abortController?.abort();
      // FAZA I: apasă și butonul de Stop al site-ului (best-effort).
      // FAZA IV.1: providerii locali nu au pagină (Stop = AbortSignal pe fetch).
      const active = this.active;
      if (active && active.provider.stop && active.page) {
        void active.provider.stop(active.page).catch(() => undefined);
      }
      // deblochează aprobările în așteptare
      for (const resolve of pendingApprovals.values()) resolve(false);
      pendingApprovals.clear();
      // v0.5.0: deblochează și un diff review nativ în așteptare
      this.wakePendingReview();
      log('stop requested');
      return;
    }

    // Schimbă providerul AI
    // v2.0.1: chip-ul de model din composer (provider + model Ollama opțional)
    if (msg.type === 'provider_change') {
      const id = PROVIDER_IDS.includes(msg.providerId)
        ? String(msg.providerId)
        : 'deepseek';
      const isBrowser = BROWSER_PROVIDER_IDS.includes(id);
      await vscode.workspace
        .getConfiguration('freekit')
        .update('provider', id, vscode.ConfigurationTarget.Global);
      // v2.2.0: providerii web își țin modelul în globalState (browserModel.<id>)
      // și e aplicat în pagină înainte de fiecare trimitere; Ollama folosește
      // în continuare setarea `ollamaModel`.
      if (isBrowser) {
        if (typeof msg.modelId === 'string') {
          const modelId = msg.modelId.trim();
          await this.state.update(browserModelKey(id), modelId || undefined);
        }
      } else if (typeof msg.modelId === 'string' && msg.modelId) {
        await vscode.workspace
          .getConfiguration('freekit')
          .update(
            'ollamaModel',
            String(msg.modelId),
            vscode.ConfigurationTarget.Global
          );
      }
      if (isBrowser) {
        await this.state.update(LAST_BROWSER_KEY, id);
      }
      log(
        'provider chip set to ' +
          id +
          (msg.modelId ? ' / ' + String(msg.modelId) : '')
      );
      this.post('provider', id);
      void this.refreshProviderStatus();
      return;
    }

    if (msg.type === 'set_provider') {
      const id = PROVIDER_IDS.includes(msg.value)
        ? String(msg.value)
        : 'deepseek';
      await vscode.workspace
        .getConfiguration('freekit')
        .update('provider', id, vscode.ConfigurationTarget.Global);
      // v0.4.0: reține ultimul provider web — lanțul Auto îl încearcă primul
      if (BROWSER_PROVIDER_IDS.includes(id)) {
        await this.state.update(LAST_BROWSER_KEY, id);
      }
      log('provider set to ' + id);
      void this.refreshProviderStatus();
      return;
    }

    // v2.5.1 — FIX 2c: butonul „Switch to …” din cardul de eroare de provider:
    // comută providerul (ca `provider_change`, dar fără model) și reia ultimul
    // prompt, ca utilizatorul să nu rămână blocat pe providerul indisponibil.
    if (msg.type === 'switch_provider') {
      const id = PROVIDER_IDS.includes(msg.providerId)
        ? String(msg.providerId)
        : 'deepseek';
      await vscode.workspace
        .getConfiguration('freekit')
        .update('provider', id, vscode.ConfigurationTarget.Global);
      if (BROWSER_PROVIDER_IDS.includes(id)) {
        await this.state.update(LAST_BROWSER_KEY, id);
      }
      log('provider error card: switching to ' + id);
      // chip-ul din composer trebuie să reflecte noul provider
      void this.refreshProviderStatus();
      if (this.abortController) return; // se generează deja
      const switchRetryText = this.lastUserText;
      if (!switchRetryText) return;
      await this.handleMessage({
        type: 'send',
        text: switchRetryText,
        msgId: 'auto' + Date.now().toString(36),
        retry: true
      });
      return;
    }

    // v2.5.1 — FIX A: butonul „Switch provider" din cardul de eroare de
    // provider nu mai forțează DeepSeek — deschide meniul de modele (chip-ul
    // din composer), iar utilizatorul alege providerul dorit.
    if (msg.type === 'open_model_menu') {
      this.post('open_model_menu', '');
      return;
    }

    // Linkurile din răspunsuri se deschid în browserul extern
    if (msg.type === 'open_link') {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
      return;
    }

    // FAZA E: butonul Clear golește și istoricul persistat
    // v1.9.0: golește conversația activă (conversația rămâne în lista de conversații)
    if (msg.type === 'clear') {
      await this.clearActiveChat();
      return;
    }

    // v2.0.2: „Clear chat" cere confirmare (modal) înainte de a executa
    if (msg.type === 'confirm_clear') {
      const pick = await vscode.window.showWarningMessage(
        'Clear this chat? The messages of the current conversation are removed ' +
          '(the conversation stays in the list). This cannot be undone.',
        { modal: true },
        'Yes, clear'
      );
      if (pick !== 'Yes, clear') return; // Cancel → nu se întâmplă nimic
      if (this.abortController) {
        this.abortRequested = true;
        this.abortController.abort();
      }
      await this.clearActiveChat();
      this.post('cleared', '');
      return;
    }

    // v2.0.2: „Reset repaired selectors" cere confirmare (modal)
    if (msg.type === 'reset_selectors') {
      const pick = await vscode.window.showWarningMessage(
        'Reset the automatically repaired selectors? Freekit forgets what it ' +
          'learned and falls back to the configured selectors (bundled or remote).',
        { modal: true },
        'Reset'
      );
      if (pick !== 'Reset') return; // Cancel → nu se întâmplă nimic
      await vscode.commands.executeCommand('freekit.resetSelectors');
      return;
    }

    // v2.0.2: acțiunile de context din meniul „⋯"
    if (msg.type === 'open_browser') {
      await vscode.commands.executeCommand('freekit.openBrowser');
      return;
    }
    if (msg.type === 'stop_dev_servers') {
      await vscode.commands.executeCommand('freekit.stopDevServers');
      return;
    }

    // v2.0.2: „Install Ollama" (meniul de model / meniul „⋯")
    if (msg.type === 'install_ollama') {
      await vscode.commands.executeCommand('freekit.installOllama');
      return;
    }

    // v2.0.2: descarcă un model recomandat pentru hardware-ul detectat
    if (msg.type === 'pull_model') {
      const model = typeof msg.modelId === 'string' ? msg.modelId.trim() : '';
      if (model) await this.pullModel(model);
      return;
    }

    // FIX v0.1.1: două butoane separate — fișiere / foldere.
    // Pe Windows, canSelectFiles + canSelectFolders simultan afișa doar un tip.
    if (msg.type === 'pick_files') {
      if (this.abortController) return; // ocupat cu un răspuns
      const isFiles = msg.kind !== 'folders';
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: isFiles,
        canSelectFolders: !isFiles,
        openLabel: isFiles ? 'Attach files' : 'Attach folders',
        title: isFiles ? 'Attach files' : 'Attach folders',
        filters: isFiles
          ? {
              'All files': ['*'],
              'Text': ['txt', 'md', 'json', 'ts', 'js', 'astro', 'html', 'css', 'yml', 'yaml'],
              'Images': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']
            }
          : undefined
      });
      if (uris && uris.length) {
        await this.addAttachments(uris.map((u) => u.fsPath));
      }
      return;
    }

    // FAZA II (A): fișiere trase prin drag & drop
    if (msg.type === 'attach_paths') {
      if (this.abortController) return;
      const paths: string[] = Array.isArray(msg.paths)
        ? msg.paths.filter((p: any) => typeof p === 'string' && p)
        : [];
      if (paths.length) await this.addAttachments(paths);
      return;
    }

    // FAZA II (A): scoate un atașament din listă
    if (msg.type === 'detach') {
      this.attachments = this.attachments.filter((a) => a.id !== msg.id);
      this.postAttachments();
      return;
    }

    // FAZA F: copierea răspunsului în clipboard
    if (msg.type === 'copy') {
      await vscode.env.clipboard.writeText(String(msg.text ?? ''));
      return;
    }

    // v1.7.3: voice input — captarea rulează în Extension Host (Node.js),
    // webview-ul doar cere pornirea/oprirea și primește starea + rezultatul.
    if (msg.type === 'stt_start') {
      await this.handleSttStart();
      return;
    }
    if (msg.type === 'stt_stop') {
      await this.handleSttStop();
      return;
    }

    // Webview-ul e gata: trimite providerul curent + istoricul salvat
    if (msg.type === 'ready') {
      const cfg = configInfo();
      log('selectors.json v' + cfg.version + ' (' + cfg.updated + ') — ' + cfg.providers.join(', '));
      this.post('provider', this.currentProviderId());
      // v1.9.0: migrează o singură dată istoricul legacy într-o conversație
      await this.ensureConversationsMigrated();
      this.postAttachments();
      this.view?.webview.postMessage({
        type: 'history',
        items: this.activeHistoryItems()
      });
      // v1.4.0: checkpoint-urile git (butoanele de restore din istoric)
      this.view?.webview.postMessage({
        type: 'checkpoints',
        items: this.checkpoints
      });
      // v0.2.1: sincronizează starea toggle-ului Auto-approve
      this.view?.webview.postMessage({
        type: 'auto_approve',
        enabled: this.autoApprove
      });
      // v1.7.1: starea toggle-ului Verbose mode
      this.view?.webview.postMessage({
        type: 'verbose_mode',
        enabled: this.verboseEnabled()
      });
      // v1.2.1: dacă un review de diff așteaptă decizia (webview reîncărcat),
      // re-afișează cardul inline ca utilizatorul să nu rămână blocat
      const pendingPayload = this.pendingInlineReviewPayload;
      if (this.pendingInlineReview && pendingPayload) {
        this.view?.webview.postMessage({
          type: 'diff_review',
          ...pendingPayload
        });
        // v2.0.1: re-afișează și rândurile inline de „file change"
        for (const row of pendingPayload.rows ?? []) {
          this.view?.webview.postMessage({ type: 'file_change_row', ...row });
        }
      }
      // v2.0.1: nivelul de „thinking" salvat (chip-ul din composer)
      this.view?.webview.postMessage({
        type: 'thinking_level',
        value: this.thinkingLevel()
      });
      // v1.9.0: lista de conversații (dropdown-ul de comutare)
      this.postConversations();
      // v2.0.2: sincronizează starea de generare (webview reîncărcat în timpul
      // unui răspuns → butonul Stop trebuie să fie vizibil)
      this.post('busy', this.abortController ? '1' : '0');
      // v0.4.0: status providers pentru badge-ul din toolbar
      void this.refreshProviderStatus();
      return;
    }

    // v0.4.0: butonul Show Chrome din toolbar — aduce fereastra Chrome în față
    if (msg.type === 'show_chrome') {
      await this.showChrome();
      return;
    }

    // v0.4.0: badge-ul de status (webview-ul cere reîmprospătarea periodic)
    if (msg.type === 'status_check') {
      await this.refreshProviderStatus();
      return;
    }

    // v0.4.0: click pe badge — raportul detaliat de status
    if (msg.type === 'show_status_report') {
      await this.showProviderStatusReport();
      return;
    }

    // v1.4.0: restore la checkpoint-ul de dinaintea unui prompt (butonul de restore)
    if (msg.type === 'restore_checkpoint') {
      await this.handleRestoreCheckpoint(String(msg.messageId ?? ''));
      return;
    }

    // v1.9.0: edit prompt, fork și conversațiile multiple (dropdown)
    if (msg.type === 'edit_prompt') {
      await this.handleEditPrompt(
        String(msg.messageId ?? ''),
        String(msg.text ?? '')
      );
      return;
    }
    if (msg.type === 'fork_conversation') {
      await this.handleForkConversation(String(msg.messageId ?? ''));
      return;
    }
    if (msg.type === 'switch_conversation') {
      await this.handleSwitchConversation(String(msg.id ?? ''));
      return;
    }
    if (msg.type === 'new_conversation') {
      await this.handleNewConversation();
      return;
    }
    if (msg.type === 'delete_conversation') {
      // v2.0.3: context menu (dreapta-click) trimite id-ul conversației alese;
      // fără id se șterge conversația activă (comportamentul vechi).
      await this.handleDeleteConversation(String(msg.id ?? ''));
      return;
    }

    // v2.0.1: rândurile inline de „file change" (Approve / Reject / vezi diff)
    if (msg.type === 'file_change_action') {
      await this.handleFileChangeAction(
        String(msg.rowId ?? ''),
        String(msg.action ?? '')
      );
      return;
    }

    // v2.0.1: nivelul de „thinking" (UI + storage; fără efect pe motor încă)
    if (msg.type === 'set_thinking_level') {
      await vscode.workspace
        .getConfiguration('freekit')
        .update(
          'thinkingLevel',
          String(msg.value ?? 'medium'),
          vscode.ConfigurationTarget.Global
        );
      return;
    }

    // v2.0.1: acțiunile din meniul „⋯" (Settings / Diagnostics / MCP servers)
    if (msg.type === 'open_settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'freekit'
      );
      return;
    }
    if (msg.type === 'run_diagnostics') {
      await vscode.commands.executeCommand('freekit.diagnostics');
      return;
    }
    if (msg.type === 'manage_mcp') {
      await vscode.commands.executeCommand('freekit.mcpManage');
      return;
    }

    // v2.0.4: butonul Retry din cardul „login required" — reia ultimul prompt
    // fără să dubleze mesajul în istoric și fără să re-consume atașamentele.
    // v2.5.1 — FIX 2c: același flux deservește și butonul „Retry" din cardul
    // de eroare de provider (`retry_message`).
    if (msg.type === 'retry_last' || msg.type === 'retry_message') {
      if (this.abortController) return; // se generează deja
      const text = this.lastUserText;
      if (!text) return;
      log('retry last prompt requested');
      await this.handleMessage({
        type: 'send',
        text,
        msgId: 'auto' + Date.now().toString(36),
        retry: true
      });
      return;
    }

    if (msg.type !== 'send') return;
    const userText: string = msg.text;
    // v2.0.4: retry = reluarea ultimului prompt (vezi mai sus)
    const isRetry = msg.retry === true;
    // v1.4.0: id-ul mesajului (generat de webview) → leagă mesajul de checkpoint
    const msgId =
      typeof msg.msgId === 'string' && MSG_ID_RE.test(msg.msgId)
        ? msg.msgId
        : 'auto' + Date.now().toString(36);
    log((isRetry ? 'retry message: ' : 'user message: ') + userText.slice(0, 60));

    // v2.4.1: Restricted Mode nu mai blochează tot chat-ul — modelul poate citi
    // și răspunde; doar uneltele care scriu/rulează sunt refuzate la execuție
    // (vezi executeTool + blocarea MCP din bucla de mai jos). Utilizatorul e
    // îndrumat clar către Trust, prin notificare + cardul din chat.
    if (!vscode.workspace.isTrusted) {
      log('message sent in Restricted Mode — tools that write or run will be blocked');
      showRestrictedNotification();
    }

    // v1.9.0: prima conversație din sesiune se creează automat (titlul = promptul)
    if (!this.conversations.getActive()) {
      await this.conversations.create(userText.slice(0, 40));
      this.postConversations();
    }
    // v2.0.4: reținem ultimul prompt, pentru butonul Retry din cardul de login
    if (!isRetry) this.lastUserText = userText;
    if (!isRetry) {
      // FAZA E: salvăm mesajul utilizatorului în istoric (NU se trimite la AI)
      await this.appendHistory('user', userText, msgId);
      // v1.9.0: primul prompt al unei conversații „Conversație nouă” o redenumește
      if (await this.conversations.retitleDefault(userText)) this.postConversations();
    }

    // FAZA II (A): consumă atașamentele curente (se trimit o singură dată);
    // v2.0.4: la Retry atașamentele au plecat deja — nu le mai re-consumăm.
    const atts = isRetry ? [] : this.attachments;
    if (!isRetry) {
      this.attachments = [];
      this.postAttachments();
    }

    this.abortRequested = false;
    this.abortController = new AbortController();
    // v2.0.2: semnal explicit de „se generează" → webview-ul arată butonul Stop
    this.post('busy', '1');
    const signal = this.abortController.signal;

    // v0.2.1: contorul anti-spam al scrierilor se resetează la fiecare mesaj
    resetWriteLimits();
    // v0.6.0: contoarele de încercări per comandă (auto-healing) se resetează
    resetCommandLimits();
    // v1.7.1: cardul „Thinking" se resetează la fiecare mesaj
    this.verboseThinkId = undefined;
    // v1.10.2: și textul de thinking deja afișat (anti-duplicare)
    this.verboseThinkText = '';
    // v1.10.3: niciun card „Thinking" deschis la începutul mesajului
    this.verboseThinkOpen = false;
    // v1.3.0: starea de auto-verify/rollback se resetează la fiecare mesaj
    this.resetVerifyState();

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('You have no folder open in VS Code.');

      // v2.0.5: fereastra adusă în față pentru login se întoarce în fundal la
      // reluarea mesajului — randarea nu mai are nevoie de ea vizibilă. Dacă
      // login-ul încă nu a reușit, asistentul de login o readuce imediat în față.
      if (this.chromeShownForLogin) {
        this.chromeShownForLogin = false;
        await this.browser.hideOffscreen().catch(() => undefined);
      }

      // v1.4.0: checkpoint git ÎNAINTE de prompt (rollback manual, un click)
      await this.createCheckpoint(root, msgId, userText);

      // v0.4.0: 'auto' = lanț de fallback (provider web → Ollama); restul =
      // providerul ales direct. Achiziția propriu-zisă are loc înainte de
      // primul mesaj (Auto încearcă pe rând până reușește).
      const selectedId = this.currentProviderId();
      const isAuto = selectedId === 'auto';
      let provider: AIProvider | undefined;
      let page: Page | undefined;

      // FAZA D: auto-context — structura proiectului, trimisă la fiecare mesaj
      let structure = '';
      try {
        structure = await getProjectStructure(root);
        log('project structure: ' + structure.split('\n').length + ' lines');
      } catch (e: any) {
        log('project structure failed: ' + (e?.message ?? String(e)));
      }

      // FAZA III (F): detecție automată a tipului de proiect
      let projInfo = '';
      try {
        projInfo = formatProjectInfo(await detectProject(root));
        log('project info: ' + projInfo.split('\n')[0]);
      } catch (e: any) {
        log('project detection failed: ' + (e?.message ?? String(e)));
      }

      // FAZA II (A): pregătește blocul de text + lista de upload pentru atașamente
      let attachBlock = '';
      let uploads: string[] = [];
      if (atts.length) {
        try {
          const prep = await prepareAttachments(root, atts);
          attachBlock = prep.block;
          uploads = prep.uploads;
          log('attachments: ' + atts.length + ' prepared, uploads=' + uploads.length);
        } catch (e: any) {
          log('preparing attachments failed: ' + (e?.message ?? String(e)));
        }
      }

      // v0.2.1: prompt special pentru providerii locali (anti-spam write_file);
      // v0.4.0: în modul Auto se alege varianta potrivită providerului care servește.
      // v1.1.2: PROJECT INFO / PROJECT STRUCTURE se injectează în promptul
      // principal prin placeholder-ele {PROJECT_INFO} / {PROJECT_STRUCTURE};
      // prompturile fără placeholder-e (SYSTEM_PROMPT_LOCAL) le primesc în
      // continuare atașate separat, ca înainte.
      const projectBlock =
        (projInfo ? '\n\n---\nPROJECT INFO:\n' + projInfo : '') +
        (structure ? '\n\n---\nPROJECT STRUCTURE:\n' + structure : '');
      const contextBlock =
        (attachBlock ? '\n\n---\nATTACHMENTS:\n' + attachBlock : '') +
        '\n\n---\nUSER MESSAGE:\n' + userText;
      // v1.1.0: uneltele MCP disponibile se adaugă la prompt (listă dinamică,
      // mai scurtă pentru modelele locale)
      const messageFor = (p: AIProvider) => {
        const mcpSection = mcp.promptSection(!!p.local);
        let prompt = p.local ? SYSTEM_PROMPT_LOCAL : SYSTEM_PROMPT;
        if (
          prompt.includes('{PROJECT_INFO}') ||
          prompt.includes('{PROJECT_STRUCTURE}')
        ) {
          prompt = prompt
            .replace('{PROJECT_INFO}', projInfo || '(not available)')
            .replace('{PROJECT_STRUCTURE}', structure || '(not available)');
        } else {
          prompt += projectBlock;
        }
        return (
          prompt +
          (p.local ? '' : '\n\n' + MARKER_FORMAT_EXAMPLE) +
          (mcpSection ? '\n\n---\n' + mcpSection : '') +
          contextBlock
        );
      };

      // FAZA III (E): progres vizibil — textul parțial al răspunsului
      const onProgress = (partial: string) => {
        // v1.10.3: răspunsul vizibil a început → pliază cardul „Thinking"
        this.finishThinking();
        this.post('stream', partial);
      };
      const onNotice = (text: string) => this.post('notice', text);

      // v0.3.0 (P0.6): buget TOTAL de timp per mesaj (implicit 20 min)
      const timeoutMinutes = Math.max(
        1,
        Number(
          vscode.workspace
            .getConfiguration('freekit')
            .get<number>('messageTimeoutMinutes', 20)
        ) || 20
      );
      const deadline = Date.now() + timeoutMinutes * 60_000;
      const sendOpts = {
        files: uploads.length ? uploads : undefined,
        onProgress,
        onNotice
      };

      // v0.4.0: primul mesaj — Auto încearcă lanțul (browser → Ollama) pe rând
      let aiReply = '';
      if (isAuto) {
        const chain = this.autoChainIds();
        const chainLabels = chain.map((id) => PROVIDER_LABELS[id] ?? id);
        // v2.0.4: păstrăm eroarea de login, ca să nu se piardă în mesajul
        // generic „Auto: all failed" — UI-ul trebuie să afișeze cardul Retry.
        let loginErr: any;
        for (let i = 0; i < chain.length; i++) {
          const id = chain[i];
          const label = chainLabels[i];
          try {
            const prep = await this.prepareProvider(id);
            provider = prep.provider;
            page = prep.page;
            const prov = prep.provider;
            // v0.9.1: dacă providerul cere login, Chrome e adus în față
            // automat, așteptăm autentificarea, apoi reluăm de la sine.
            await this.runWithLoginAssist(label, prep.page, signal, () => prov.open(prep.page));
            await this.runWithLoginAssist(label, prep.page, signal, () => prov.newChat(prep.page));
            // v1.8.0: dacă pagina cere CAPTCHA, Chrome e adus în față până e rezolvat
            await this.runWithCaptchaAssist(label, prep.page, signal);
            // v2.2.0: aplică modelul web ales în chip (best-effort)
            await this.applySelectedModel(id, prep.page, label);
            this.active = { provider, page };
            if (this.abortRequested) throw new Error('__ABORTED__');
            aiReply = await provider.send(page, messageFor(provider), signal, sendOpts);
            if (i > 0) {
              this.post('notice', '🔄 Auto: response served by ' + label + ' (fallback).');
            }
            log('auto: first response via ' + id + ' (' + aiReply.length + ' chars)');
            break;
          } catch (e: any) {
            if (this.abortRequested || e?.message === '__ABORTED__') throw e;
            if (isLoginRequiredError(e)) loginErr = e;
            const reason = e?.message ? String(e.message) : String(e);
            log('auto: ' + id + ' failed — ' + reason);
            if (i === chain.length - 1) {
              if (loginErr) throw loginErr;
              throw new Error(
                'Auto: tried ' + chainLabels.join(' → ') +
                  ', but all failed. Last error (' + label + '): ' + reason
              );
            }
            this.post('notice', '⚠️ Auto: ' + label + ' failed (' + reason.slice(0, 220) + ').');
            this.post('notice', '🔄 Auto: switching to ' + chainLabels[i + 1] + '...');
          }
        }
      } else {
        const prep = await this.prepareProvider(selectedId);
        provider = prep.provider;
        page = prep.page;
        const prov = prep.provider;
        const label = PROVIDER_LABELS[selectedId] ?? selectedId;
        // v0.9.1: login assist pentru providerul ales direct
        await this.runWithLoginAssist(label, prep.page, signal, () => prov.open(prep.page));
        await this.runWithLoginAssist(label, prep.page, signal, () => prov.newChat(prep.page));
        // v1.8.0: CAPTCHA assist (reCAPTCHA / hCaptcha / Cloudflare „Just a moment”)
        await this.runWithCaptchaAssist(label, prep.page, signal);
        // v2.2.0: aplică modelul web ales în chip (best-effort)
        await this.applySelectedModel(selectedId, prep.page, label);
        this.active = { provider, page };

        if (this.abortRequested) {
          this.post('stopped', '');
          return;
        }

        aiReply = await provider.send(page, messageFor(provider), signal, sendOpts);
        log('first AI reply length: ' + aiReply.length);
      }
      if (!provider) throw new Error('No provider available.');

      const approve = async (
        tool: string,
        target: string,
        diff: string,
        changes?: FileChangePreview[]
      ): Promise<boolean> => {
        // v0.2.1: auto-approve activ → fără card, aprobat imediat
        if (this.autoApprove) {
          log('auto-approved: ' + tool + ' → ' + target);
          this.post('notice', 'Auto-approved (no card): ' + tool + ' → ' + target);
          return true;
        }

        // v0.5.0: scrierile de fișiere → diff NATIV VS Code, nu card text
        if (changes && changes.length) {
          const skip =
            tool === 'write_files'
              ? changes.every((c) => this.isNoAskFile(c.label))
              : this.isNoAskFile(target);
          if (skip) {
            log('no-ask auto-approved: ' + tool + ' → ' + target);
            this.post(
              'notice',
              '✅ Auto-approved ("don\'t ask again"): ' + tool + ' → ' + target
            );
            return true;
          }

          this.post(
            'notice',
            '📝 Native diff opened for review: ' + target +
              ' — choose Accept / Reject from the card below or from the VS Code notification.'
          );
          const decision = await this.showDiffReview(tool, changes);
          if (decision === 'accept') {
            log('diff review accepted: ' + tool + ' → ' + target);
            this.post('notice', '✅ Accepted from diff: ' + target);
            return true;
          }
          if (decision === 'accept_no_ask') {
            await this.addNoAskFile(target);
            log('diff review accepted (no-ask): ' + tool + ' → ' + target);
            this.post(
              'notice',
              '✅ Accepted from diff (don\'t ask again): ' + target
            );
            return true;
          }
          if (decision === 'reject') {
            log('diff review rejected: ' + tool + ' → ' + target);
            this.post('notice', '❌ Rejected from diff: ' + target);
            return false;
          }
          // 'fallback' — diff-ul nu s-a putut afișa / fără webview → cardul clasic din chat
          log('diff review fallback to chat card: ' + tool + ' → ' + target);
        }

        return new Promise((resolve) => {
          const id = newApprovalId();
          pendingApprovals.set(id, resolve);
          this.view?.webview.postMessage({
            type: 'approval_request',
            id,
            tool,
            path: target,
            diff
          });
        });
      };

      let iterations = 0;
      let timedOut = false;
      // v1.1.2: auto-retry — câte nudge-uri „text în loc de tool call" am trimis
      let textRetries = 0;
      // v2.5.3 FIX 7: câte nudge-uri „tool call malformat" am trimis (max 1)
      let malformedRetries = 0;
      // v1.3.0: mesajul final de rollback (auto-repair eșuat definitiv)
      let verifyRollbackText = '';
      // v2.5.0 — FIX 3: verificarea rulează o SINGURĂ dată per răspuns complet
      // al AI (nu după fiecare fișier); flag = s-a modificat vreun fișier în tura asta
      let filesWereModifiedThisTurn = false;
      while (iterations < MAX_ITERATIONS && !this.abortRequested) {
        // v0.3.0 (P0.6): verificăm bugetul de timp înainte de fiecare pas
        if (Date.now() > deadline) {
          timedOut = true;
          log('time budget exhausted (' + timeoutMinutes + ' min) — stopping the loop');
          break;
        }
        iterations++;
        const toolCall = this.parseToolCall(aiReply);

        if (!toolCall) {
          // v1.1.2: auto-retry — modelul a răspuns cu text descriptiv
          // („Analyzing...", „Let me...") sau cu un tool call JSON invalid
          // în loc să execute o unealtă. Îi cerem explicit, din nou, un
          // SINGUR tool call (max MAX_TEXT_RETRIES per mesaj).
          if (textRetries < MAX_TEXT_RETRIES && looksLikeIntentOnly(aiReply)) {
            textRetries++;
            log(
              'text instead of tool call — auto-retry ' +
                textRetries +
                '/' +
                MAX_TEXT_RETRIES
            );
            this.post(
              'heal',
              '🔁 Auto-retry ' +
                textRetries +
                '/' +
                MAX_TEXT_RETRIES +
                ': the model replied with text instead of a tool call — asking again for the action JSON.'
            );
            // v1.7.1: verbose — decizia de auto-retry
            this.postVerboseStep({
              kind: 'decision',
              title: 'Auto-retry ' + textRetries + '/' + MAX_TEXT_RETRIES,
              text: 'Replied with text instead of a tool call — asking again for the action JSON.',
              status: 'done'
            });
            aiReply = await provider.send(page, TEXT_RETRY_NUDGE, signal, {
              onProgress
            });
            continue;
          }
          // v2.4.8: răspunsul e o ÎNCERCARE de tool call pe care extractorul
          // n-o poate recupera (JSON trunchiat, ghilimele neescapate) — în loc
          // să afișăm JSON-ul brut ca răspuns final, dăm o eroare clară.
          if (looksLikeToolCallAttempt(aiReply)) {
            // v2.5.3 FIX 7: mai întâi o singură reluare cu un nudge explicit
            // (DeepSeek ecouază promptul și strivește conținutul pe o linie) —
            // abia dacă și a doua încercare e malformată afișăm eroarea.
            if (malformedRetries < MAX_MALFORMED_RETRIES) {
              malformedRetries++;
              log(
                'malformed tool call — auto-retry ' +
                  malformedRetries +
                  '/' +
                  MAX_MALFORMED_RETRIES
              );
              this.post(
                'heal',
                '🔁 Auto-retry ' +
                  malformedRetries +
                  '/' +
                  MAX_MALFORMED_RETRIES +
                  ': the tool call was malformed — asking again for the marker format with the content in a code fence.'
              );
              this.postVerboseStep({
                kind: 'decision',
                title:
                  'Auto-retry ' +
                  malformedRetries +
                  '/' +
                  MAX_MALFORMED_RETRIES +
                  ' (malformed tool call)',
                text: 'Tool call malformed — asking again for the marker format with the content in a code fence.',
                status: 'done'
              });
              aiReply = await provider.send(
                page,
                MALFORMED_TOOL_CALL_NUDGE,
                signal,
                { onProgress }
              );
              continue;
            }
            log(
              'malformed tool call after ' +
                malformedRetries +
                ' auto-retries — surfacing an error'
            );
            this.postVerboseStep({
              kind: 'decision',
              title: 'Malformed tool call',
              text: MALFORMED_TOOL_CALL_ERROR,
              status: 'done'
            });
            this.post('error', MALFORMED_TOOL_CALL_ERROR);
            await this.appendHistory('assistant', MALFORMED_TOOL_CALL_ERROR);
            break;
          }

          // v2.5.0 — FIX 3: AI-ul a terminat răspunsul complet (fără tool
          // calls). Abia acum rulăm verificarea — o singură dată per răspuns —
          // dacă s-a modificat vreun fișier. La eșec, eroarea completă merge
          // înapoi la AI pentru auto-repair (max MAX_VERIFY_REPAIRS); dacă nici
          // așa nu trece → rollback automat (vezi autoVerify / doRollback).
          if (filesWereModifiedThisTurn && this.autoVerifyEnabled(root)) {
            filesWereModifiedThisTurn = false;
            const repairsBefore = this.verifyRepairs;
            const v = await this.autoVerify(root);
            if (v.rollbackText) {
              verifyRollbackText = v.rollbackText;
              break;
            }
            if (this.verifyRepairs > repairsBefore) {
              aiReply = await provider.send(page, v.suffix, signal, { onProgress });
              log('auto-repair reply length: ' + aiReply.length);
              continue;
            }
          }

          // v1.7.1: verbose — răspuns final, fără acțiuni
          this.postVerboseStep({
            kind: 'decision',
            title: 'Final answer',
            text: 'The model finished with text — no more actions to execute.',
            status: 'done'
          });
          log('no valid tool call, final answer (iteration ' + iterations + ')');
          break;
        }

        log('tool call #' + iterations + '/' + MAX_ITERATIONS + ': ' + toolCall.tool);
        this.post(
          'status',
          '⚙️ Pasul ' + iterations + '/' + MAX_ITERATIONS + ': ' + toolCall.tool
        );

        // v1.7.1: verbose — decizia (unealta aleasă) + execuția care începe
        const vExecId = 'exec' + iterations;
        const vSummary = this.summarizeToolCall(toolCall);
        this.postVerboseStep({
          kind: 'decision',
          id: 'dec' + iterations,
          title: 'Tool chosen: ' + toolCall.tool,
          text: vSummary,
          status: 'done'
        });
        this.postVerboseStep({
          kind: 'executing',
          id: vExecId,
          title: toolCall.tool,
          text: vSummary,
          status: 'running'
        });

        // v1.3.0: snapshot pre-editare — starea fișierelor vizate, folosită de
        // rollback-ul automat dacă auto-repair-ul verificării eșuează
        if (AUTO_VERIFY_TOOLS.has(toolCall.tool)) {
          this.snapshotEditTargets(toolCall, root);
        }

        // v1.1.0: apelurile MCP (mcp_<server>_<tool>) trec prin același flux
        // de aprobare; restul uneltelor merg pe executeTool clasic.
        // v2.4.1: în Restricted Mode uneltele care scriu/rulează (inclusiv MCP)
        // nu se execută — întoarcem o eroare clară și re-afișăm notificarea Trust.
        const blockedByTrust =
          !vscode.workspace.isTrusted && isToolTrustRequired(toolCall.tool, toolCall.args);
        let result: ToolResult;
        if (blockedByTrust) {
          log('tool blocked by Restricted Mode: ' + toolCall.tool);
          result = { ok: false, error: RESTRICTED_TOOL_ERROR };
          showRestrictedNotification(true);
          this.post('notice', '🔒 ' + RESTRICTED_BLOCKED_NOTICE);
        } else {
          const mcpResult = await mcp.executeToolCall(toolCall, approve, log);
          result = mcpResult ?? (await executeTool(toolCall, root, log, approve));
        }
        log('tool result ok=' + result.ok);

        // v1.7.1: verbose — execuția s-a încheiat + rezultatul (cap 4000)
        this.postVerboseStep({
          kind: 'executing',
          id: vExecId,
          status: result.ok ? 'done' : 'error'
        });
        const vOut = String((result.ok ? result.result : result.error) ?? '');
        this.postVerboseStep({
          kind: 'result',
          id: 'res' + iterations,
          title: result.ok ? 'OK: ' + toolCall.tool : 'Error: ' + toolCall.tool,
          text: vOut.length > 4000 ? vOut.slice(0, 4000) + '\n… (truncated)' : vOut,
          status: result.ok ? 'done' : 'error'
        });
        if (this.abortRequested) break;

        // v2.5.0 — FIX 3: NU mai verificăm după fiecare fișier. Marcăm doar că
        // s-a modificat ceva în tura curentă; verificarea (astro check / tsc /
        // build) rulează o singură dată, când AI-ul termină răspunsul complet.
        if (
          AUTO_VERIFY_TOOLS.has(toolCall.tool) &&
          (result.ok || (result.error ?? '').startsWith('Written '))
        ) {
          filesWereModifiedThisTurn = true;
        }
        if (this.abortRequested) break;

        // v0.6.0 — Terminal Self-Correction: status vizibil în chat pentru
        // comenzile eșuate (eroarea completă e deja în TOOL_ERROR, din tools.ts)
        const cr = result.commandRun;
        if (cr) {
          if (cr.blocked) {
            this.post(
              'heal',
              '⛔ Auto-healing: "' + cr.command + '" is no longer run (the limit of ' +
                cr.max + ' attempts was reached). The AI must reply with text.'
            );
          } else if (!result.ok) {
            this.post(
              'heal',
              '⟳ Auto-healing ' + cr.attempt + '/' + cr.max + ': "' + cr.command +
                '" failed (exit ' + cr.exitCode + ', ' +
                (cr.duration / 1000).toFixed(1) +
                's). Sending the full error to the AI: analyze → fix → re-run.'
            );
          } else if (cr.attempt > 1) {
            this.post(
              'heal',
              '✅ Auto-healing succeeded: "' + cr.command + '" passed after ' +
                cr.attempt + ' attempts.'
            );
          }
        }

        // v0.6.0: întărim directiva de auto-reparare în mesajul trimis AI-ului
        const selfFix = cr
          ? cr.blocked
            ? '\n\nSELF-CORRECTION: this command is BLOCKED — do not run it again; reply with PLAIN TEXT now.'
            : !result.ok
              ? '\n\nSELF-CORRECTION MODE (' + cr.attempt + '/' + cr.max +
                '): analyze the error above, fix the root cause in the code (edit_file / write_file), then re-run the SAME command.'
              : ''
          : '';

        const resultMessage = result.ok
          ? 'TOOL_RESULT for ' + toolCall.tool + ':\n' + result.result
          : 'TOOL_ERROR for ' + toolCall.tool + ':\n' + result.error;

        aiReply = await provider.send(
          page,
          resultMessage + selfFix,
          signal,
          { onProgress }
        );
        log('follow-up reply length: ' + aiReply.length);
      }

      // FAZA III (E): dacă ne-am oprit la 40 de pași și AI-ul încă voia o
      // unealtă, anunțăm utilizatorul în loc să afișăm JSON-ul brut.
      const limitHit = !this.abortRequested && this.parseToolCall(aiReply) !== null;

      if (this.abortRequested) {
        log('request aborted, posting stopped');
        this.post('stopped', '');
      } else if (timedOut) {
        log('message timeout reached (' + timeoutMinutes + ' min)');
        this.post(
          'stopped',
          '⏱ The time budget (' + timeoutMinutes +
            ' min) for this message was reached. Write "continue" to resume from where I left off.'
        );
      } else if (verifyRollbackText) {
        // v1.3.0: auto-repair eșuat definitiv — modificările au fost anulate
        log('auto-verify: rollback completed — ending with the rollback report');
        await this.appendHistory('assistant', verifyRollbackText);
        this.post('reply', verifyRollbackText);
      } else if (limitHit) {
        log('max iterations reached (' + MAX_ITERATIONS + ')');
        this.post(
          'stopped',
          '⏸ Reached the limit of ' + MAX_ITERATIONS + ' steps. Write "continue" to finish the rest.'
        );
      } else {
        // v1.3.0: AI-ul s-a oprit cu text final, dar ultima verificare e încă
        // pe roșu — nu lăsăm proiectul stricat: rollback automat + mesaj
        const lvf = this.getLastVerifyFailure();
        if (this.autoVerifyEnabled(root) && this.verifyRepairs > 0 && lvf) {
          log('auto-verify: final response while verification is red — rollback');
          const text = this.doRollback(
            root,
            'the AI stopped without fixing the error',
            lvf.command,
            lvf.output,
            lvf.seconds
          );
          await this.appendHistory('assistant', text);
          this.post('reply', text);
        } else {
          log('posting final reply, length=' + aiReply.length);
          await this.appendHistory('assistant', aiReply);
          this.post('reply', aiReply);
        }
      }
    } catch (e: any) {
      if (this.abortRequested || e?.message === '__ABORTED__') {
        log('aborted during send');
        this.post('stopped', '');
      } else if (e instanceof DetectedProviderError) {
        // v2.5.1: eroare de provider detectată (mesaje gratuite epuizate,
        // rate limit, CAPTCHA) — nu mai arătăm un timeout sec, ci un mesaj
        // clar, cu timpul de reset / link de upgrade pentru cardul din chat.
        log('provider error: ' + (e?.message ?? String(e)));
        this.post('provider_error', {
          kind: e.details.kind,
          message: e.message,
          resetTime: e.details.resetTime,
          upgradeUrl: e.details.upgradeUrl,
          providerId: e.providerId
        });
        return;
      } else if (isLoginRequiredError(e)) {
        // v2.0.4: login UX — în loc de o eroare seacă, aducem Chrome în față
        // (ca utilizatorul să se poată autentifica) și oferim în chat cardul
        // „login required" cu butonul Retry, care reia ultimul prompt.
        log('login required: ' + (e?.message ?? String(e)));
        await this.showChrome().catch(() => {});
        // v2.0.5: reținem că fereastra e vizibilă din cauza login-ului, ca s-o
        // ducem înapoi în fundal la reluarea mesajului (după autentificare).
        this.chromeShownForLogin = true;
        this.post('login_required', e?.message ?? String(e));
      } else {
        log('error: ' + (e?.message ?? String(e)));
        this.post('error', e?.message ?? String(e));
      }
    } finally {
      // v1.10.3: plasă de siguranță — cardul „Thinking" nu rămâne deschis
      this.finishThinking();
      this.abortController = undefined;
      this.active = undefined;
      // v2.0.2: generarea s-a terminat → webview-ul ascunde butonul Stop
      this.post('busy', '0');
      // v0.4.0: badge-ul de status reflectă realitatea după fiecare mesaj
      void this.refreshProviderStatus();
    }
  }

  private currentProviderId(): string {
    const id = vscode.workspace
      .getConfiguration('freekit')
      .get<string>('provider');
    return id && PROVIDER_IDS.includes(id) ? id : 'deepseek';
  }

  /**
   * v2.2.0: aplică în pagină modelul web ales pentru providerul dat (din
   * globalState). Best-effort: dacă site-ul și-a schimbat meniul, mesajul
   * continuă cu modelul curent al site-ului, iar utilizatorul vede un notice.
   */
  private async applySelectedModel(
    providerId: string,
    page: Page | undefined,
    label: string
  ): Promise<void> {
    if (!page || !BROWSER_PROVIDER_IDS.includes(providerId)) return;
    const modelId = this.state.get<string>(browserModelKey(providerId), '');
    if (!modelId) return;
    const nice = modelLabel(providerId, modelId);
    try {
      const ok = await applyModel(page, providerId, modelId);
      if (ok) {
        // succesul e doar în Output — altfel fiecare mesaj ar adăuga o notă
        log(label + ': model set to ' + modelId);
      } else {
        log(label + ': could not switch to ' + modelId);
        this.post(
          'notice',
          '⚠️ ' +
            label +
            ': could not switch to "' +
            nice +
            '" — continuing with the site\'s current model.'
        );
      }
    } catch (e: any) {
      log(label + ': model switch failed — ' + (e?.message ?? String(e)));
    }
  }

  /* ======================================================================
   * v0.4.0 — Auto (fallback browser → Ollama) + status providers
   * ==================================================================== */

  /** Lanțul Auto: ultimul provider web folosit (implicit DeepSeek) → Ollama. */
  private autoChainIds(): string[] {
    const last = this.state.get<string>(LAST_BROWSER_KEY, 'deepseek');
    const browserId =
      last && BROWSER_PROVIDER_IDS.includes(last) ? last : 'deepseek';
    return [browserId, 'ollama'];
  }

  /**
   * Creează providerul + pagina (fără open/newChat — Auto are nevoie să
   * încerce pe rând și să prindă erorile pentru fallback).
   */
  private async prepareProvider(
    id: string
  ): Promise<{ provider: AIProvider; page?: Page }> {
    const provider = createProvider(id);
    // v1.7.1: thinking-ul modelului → pasul „Thinking" din chat (verbose mode)
    provider.onThinking = (text: string) => this.handleModelThinking(text);
    // FAZA IV.1: providerii locali (Ollama) vorbesc direct cu API-ul lor —
    // nu pornim Chrome și nu folosim Playwright (page rămâne undefined).
    let page: Page | undefined;
    if (provider.local) {
      log('local provider (' + provider.name + '): no browser');
    } else {
      const host = new URL(provider.url).origin;
      page = await this.browser.ensureOpen(host);
    }
    return { provider, page };
  }

  /* ======================================================================
   * v0.9.1 — LOGIN ASSIST
   * Dacă pagina providerului cere autentificare, Chrome e adus automat în
   * față (altfel rămâne offscreen și utilizatorul nu vede pagina de login),
   * așteptăm login-ul prin polling pe URL, apoi fereastra e ascunsă la loc
   * și operația reia de la sine. Stop anulează și ascunde fereastra.
   * ==================================================================== */

  /** Rulează open()/newChat(); la „cere login" aduce Chrome în față și reia după login. */
  private async runWithLoginAssist(
    label: string,
    page: Page | undefined,
    signal: AbortSignal,
    op: () => Promise<void>
  ): Promise<void> {
    let assists = 0;
    for (;;) {
      try {
        await op();
        return;
      } catch (e: any) {
        if (!isLoginRequiredError(e) || !page || assists >= LOGIN_MAX_ASSISTS) throw e;
        assists++;
        log('login required (' + label + ') — login assistant #' + assists);
        const ok = await this.waitForLogin(label, page, signal);
        if (!ok) throw e;
      }
    }
  }

  /** Aduce Chrome în față, așteaptă login-ul utilizatorului, apoi îl ascunde. */
  private async waitForLogin(
    label: string,
    page: Page,
    signal: AbortSignal
  ): Promise<boolean> {
    this.post(
      'notice',
      '🔐 ' + label + ' requires authentication — the Chrome window was brought to the front. ' +
        'Log in there; I continue automatically after login.'
    );
    const shown = await this.browser.showTemporarily(LOGIN_WAIT_MS);
    if (!shown.ok) {
      this.post(
        'notice',
        '⚠️ ' + shown.message + ' (you can also use the 👁 Show Chrome button).'
      );
    }

    const deadline = Date.now() + LOGIN_WAIT_MS;
    let loggedIn = false;
    while (Date.now() < deadline) {
      if (this.abortRequested || signal.aborted) break;
      let url = '';
      try {
        url = page.url();
      } catch {
        /* pagina poate fi în tranziție */
      }
      if (url && !isLoginUrl(url)) {
        loggedIn = true;
        break;
      }
      await sleep(LOGIN_POLL_MS);
    }

    await this.browser.hideOffscreen();
    if (this.abortRequested || signal.aborted) throw new Error('__ABORTED__');
    if (loggedIn) {
      this.post('notice', '✅ Login detected — Chrome is back in the background, continuing.');
      return true;
    }
    this.post(
      'notice',
      '⏱ Login not detected within ' +
        Math.round(LOGIN_WAIT_MS / 60000) +
        ' min — Chrome is back in the background. Log in, then send the message again.'
    );
    return false;
  }

  /**
   * v1.8.0: dacă pagina curentă cere rezolvarea unui CAPTCHA, aduce Chrome în
   * față (ca la login), așteaptă până dispare verificarea, apoi îl ascunde la
   * loc și continuă de la sine. Stop anulează și ascunde fereastra imediat.
   */
  private async runWithCaptchaAssist(
    label: string,
    page: Page | undefined,
    signal: AbortSignal
  ): Promise<void> {
    if (!page) return;
    let detected = false;
    try {
      detected = await detectCaptcha(page);
    } catch {
      detected = false;
    }
    if (!detected) return;

    this.post(
      'notice',
      '🤖 ' + label + ' requires CAPTCHA verification ("I\'m not a robot") — the ' +
        'Chrome window was brought to the front. Solve the verification; I continue automatically after.'
    );
    const shown = await this.browser.showTemporarily(CAPTCHA_WAIT_MS);
    if (!shown.ok) {
      this.post(
        'notice',
        '⚠️ ' + shown.message + ' (you can also use the 👁 Show Chrome button).'
      );
    }

    const deadline = Date.now() + CAPTCHA_WAIT_MS;
    let solved = false;
    while (Date.now() < deadline) {
      if (this.abortRequested || signal.aborted) break;
      let still = true;
      try {
        still = await detectCaptcha(page);
      } catch {
        /* pagina poate fi în tranziție (reload după verificare) */
      }
      if (!still) {
        solved = true;
        break;
      }
      await sleep(CAPTCHA_POLL_MS);
    }

    await this.browser.hideOffscreen();
    if (this.abortRequested || signal.aborted) throw new Error('__ABORTED__');
    if (solved) {
      this.post('notice', '✅ CAPTCHA solved — Chrome is back in the background, continuing.');
    } else {
      this.post(
        'notice',
        '⏱ CAPTCHA not solved within ' +
          Math.round(CAPTCHA_WAIT_MS / 60000) +
          ' min — Chrome is back in the background. Solve the verification, then send the message again.'
      );
    }
  }

  /* ======================================================================
   * v1.3.0 / v2.5.0 — AUTO-VERIFY + AUTO-REPAIR
   * Proiectul e verificat automat O SINGURĂ DATĂ per răspuns complet al AI
   * (la finalul buclei agentice, când AI-ul nu mai cere tool-uri — v2.5.0,
   * FIX 3), dacă s-a modificat vreun fișier (astro check / tsc --noEmit /
   * build — vezi verifier.ts). La eșec, eroarea completă merge înapoi la AI
   * pentru auto-repair (max MAX_VERIFY_REPAIRS încercări); dacă verificarea
   * tot cade, modificările sunt anulate automat (rollback la ultima stare
   * verificată OK) — dar numai dacă există un verified-good state real
   * (v2.5.0, FIX 2).
   * ==================================================================== */

  /**
   * Setarea freekit.autoVerify (implicit ON) + gardă anti-rollback pe
   * proiectele noi: cât timp proiectul nu e instalat/început, verificarea
   * (npm run build) nu are ce valida și nu trebuie să anuleze fișierele
   * scrise de AI în faza de scaffolding.
   */
  private autoVerifyEnabled(root: string): boolean {
    // 1. Setare explicită OFF
    const setting = vscode.workspace
      .getConfiguration('freekit')
      .get<boolean>('autoVerify', true);
    if (setting === false) {
      log('auto-verify: disabled by setting');
      return false;
    }

    // 2. node_modules lipsește → proiectul nu e instalat
    const nodeModules = path.join(root, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      log('auto-verify: skip — node_modules missing (npm install not run yet)');
      return false;
    }

    // 3. package.json lipsește → nimic de verificat
    const pkg = path.join(root, 'package.json');
    if (!fs.existsSync(pkg)) {
      log('auto-verify: skip — package.json missing');
      return false;
    }

    // 4. src/ lipsește SAU e gol → proiect nou, nu verificăm încă
    const src = path.join(root, 'src');
    if (!fs.existsSync(src) || fs.readdirSync(src).length === 0) {
      log('auto-verify: skip — src/ empty (project scaffolding phase)');
      return false;
    }

    return true;
  }

  /** Resetează starea de auto-verify/rollback (la începutul fiecărui mesaj). */
  private resetVerifyState(): void {
    this.edits.reset();
    this.verifyRepairs = 0;
    this.lastVerifyFailure = undefined;
  }

  /**
   * Ultima verificare eșuată. Citită printr-o metodă, nu direct câmpul:
   * narrowing-ul TS al proprietății ar fi „otrăvit” de atribuirile de reset
   * din handleMessage (persistă peste apelurile de metode) și ar fi tipată
   * greșit ca `undefined`/`never` la locurile de citire.
   */
  private getLastVerifyFailure():
    | { command: string; output: string; seconds: string }
    | undefined {
    return this.lastVerifyFailure;
  }

  /** Snapshot (o singură dată per fișier) înainte de prima editare a mesajului. */
  private snapshotEditTargets(call: ToolCall, root: string): void {
    const rels: string[] = [];
    if (call.tool === 'write_files') {
      const files = Array.isArray(call.args?.files) ? call.args.files : [];
      for (const f of files) {
        if (f && typeof f.path === 'string' && f.path) rels.push(f.path);
      }
    } else if (typeof call.args?.path === 'string' && call.args.path) {
      rels.push(call.args.path);
    }
    const rootNorm = path.normalize(root);
    const abs: string[] = [];
    for (const rel of rels) {
      // căile din afara workspace-ului sunt oricum respinse de executeTool
      const absPath = path.resolve(root, rel);
      if (!path.normalize(absPath).startsWith(rootNorm)) continue;
      abs.push(absPath);
    }
    if (abs.length) this.edits.snapshot(abs);
  }

  /** Rulează verificarea după un edit → textul pentru AI + (eventual) rollback. */
  private async autoVerify(
    root: string
  ): Promise<{ suffix: string; rollbackText: string }> {
    if (!this.autoVerifyEnabled(root)) return { suffix: '', rollbackText: '' };

    const vres = await runVerification(root);
    if (!vres.command) {
      log('auto-verify: no verification detected — skipping');
      return { suffix: '', rollbackText: '' };
    }
    const seconds = (vres.duration / 1000).toFixed(1);

    if (vres.ok) {
      // checkpoint: starea actuală = ultima stare verificată OK (ținta rollback)
      this.edits.markGood();
      // v2.5.0: există acum un baseline real pentru un eventual rollback
      this.hasEverVerifiedGreen = true;
      if (this.verifyRepairs > 0) {
        this.post(
          'heal',
          '✅ Auto-verify: "' + vres.command + '" passes again (after ' +
            this.verifyRepairs +
            (this.verifyRepairs === 1 ? ' auto-repair' : ' auto-repairs') +
            ').'
        );
        // v1.7.1: verbose — decizia de recuperare
        this.postVerboseStep({
          kind: 'decision',
          title: 'Verification passes again',
          text: '"' + vres.command + '" OK.',
          status: 'done'
        });
        log('auto-verify: recovered after ' + this.verifyRepairs + ' auto-repairs');
        this.verifyRepairs = 0;
      } else {
        log('auto-verify OK: ' + vres.command + ' (' + seconds + 's)');
      }
      this.lastVerifyFailure = undefined;
      return {
        suffix:
          '\n\n✅ VERIFICATION PASSED (' + vres.command + ', ' + seconds +
          's): the project still passes its checks.',
        rollbackText: ''
      };
    }

    // eșec → auto-repair: eroarea completă merge înapoi la AI
    this.verifyRepairs++;
    const attempt = this.verifyRepairs;
    this.lastVerifyFailure = {
      command: vres.command,
      output: vres.output,
      seconds
    };
    log(
      'auto-verify FAILED (' + attempt + '/' + MAX_VERIFY_REPAIRS + '): ' + vres.command
    );

    if (attempt <= MAX_VERIFY_REPAIRS) {
      this.post(
        'heal',
        '🔧 Auto-verify ' + attempt + '/' + MAX_VERIFY_REPAIRS + ': "' +
          vres.command + '" failed (' + seconds +
          's) — sending the error to the AI for auto-repair.'
      );
      // v1.7.1: verbose — decizia de auto-repair
      this.postVerboseStep({
        kind: 'decision',
        title: 'Auto-repair ' + attempt + '/' + MAX_VERIFY_REPAIRS,
        text: '"' + vres.command + '" failed (' + seconds + 's) — the full error goes to the AI.',
        status: 'done'
      });
      return {
        suffix:
          '\n\n❌ VERIFICATION FAILED (auto-repair attempt ' + attempt + '/' +
          MAX_VERIFY_REPAIRS + ') — command: ' + vres.command + ' (' + seconds + 's)\n' +
          '--- OUTPUT ---\n' + vres.output.trim() + '\n--- END OUTPUT ---\n' +
          '⟳ AUTO-REPAIR (' + attempt + '/' + MAX_VERIFY_REPAIRS +
          '): your last edit broke the project. Read the error output above, find the ROOT CAUSE and fix it with edit_file / write_file. Do NOT run the verification command yourself and do NOT reply with a final answer yet — after your fix the system re-runs verification automatically.',
        rollbackText: ''
      };
    }

    // toate încercările epuizate → ROLLBACK automat
    // v1.7.1: verbose — decizia de rollback
    this.postVerboseStep({
      kind: 'decision',
      title: 'Automatic rollback',
      text: 'Auto-repair exhausted — changes are rolled back to the last verified-good state.',
      status: 'error'
    });
    return {
      suffix: '',
      rollbackText: this.doRollback(
        root,
        'after ' + MAX_VERIFY_REPAIRS + ' auto-repairs',
        vres.command,
        vres.output,
        seconds
      )
    };
  }

  /**
   * Anulează modificările (rollback la ultima stare verificată OK) + notifică
   * utilizatorul; întoarce mesajul final afișat în chat.
   *
   * v2.5.0 — FIX 2: dacă proiectul nu a trecut NICIODATĂ verificarea, „ultima
   * stare bună" e starea goală de la început → rollback-ul ar șterge exact
   * fișierele noi, valide, scrise de AI. În acest caz NU anulăm nimic.
   */
  private doRollback(
    root: string,
    reason: string,
    command: string,
    output: string,
    seconds: string
  ): string {
    // NU face rollback fără un verified-good state real (altfel șterge tot)
    if (!this.hasEverVerifiedGreen) {
      log('automatic rollback SKIPPED — no verified-good state yet');
      this.edits.reset();
      this.verifyRepairs = 0;
      this.lastVerifyFailure = undefined;
      // v2.5.0 — FIX 4: golim containerele verbose rămase după skip-rollback
      this.post('clear_verbose_steps', '');
      this.post(
        'heal',
        '⚠️ Automatic ROLLBACK skipped (' + reason + '): the project has never ' +
          'passed verification yet — there is no verified-good state to go back ' +
          'to, so the new files were kept.'
      );
      vscode.window.showWarningMessage(
        'Freekit: verification "' + command + '" failed — rollback skipped ' +
          '(the project has never passed verification yet); the new files were kept.'
      );
      return (
        '⛔ Auto-verify failed after ' + MAX_VERIFY_REPAIRS +
        ' repair attempts. The AI could not fix the error.\n' +
        'Options:\n' +
        '- Try a smaller step (one file at a time)\n' +
        '- Disable auto-verify: Settings → freekit.autoVerify\n' +
        '- Check the error above and fix manually\n' +
        '\n' +
        'No rollback performed (project has no verified-good state yet).'
      );
    }

    const rb = this.edits.rollback();
    // v2.5.0 — FIX 4: golim containerele verbose rămase după rollback
    this.post('clear_verbose_steps', '');
    const changed = rb.restored.length + rb.deleted.length;

    log(
      'automatic rollback (' + reason + '): ' + changed + ' files reverted, ' +
        rb.failed.length + ' errors'
    );
    this.post(
      'heal',
      '⛔ Automatic ROLLBACK (' + reason + '): ' + changed +
        ' files rolled back. The project is back to the last verified-good state.'
    );
    vscode.window.showWarningMessage(
      'Freekit: verification "' + command + '" failed — ' + reason +
        '; changes were rolled back automatically.'
    );
    this.verifyRepairs = 0;
    this.lastVerifyFailure = undefined;

    return '⛔ Auto-verify failed. Rolled back to last verified-good state.';
  }

  /* ======================================================================
   * v1.4.0 — CHECKPOINT GIT PER PROMPT + RESTORE CU UN CLICK
   * Înainte de fiecare mesaj se creează un commit de checkpoint
   * („freekit-prompt:<id>”), persistat în globalState împreună cu id-ul
   * mesajului; butonul ⟲ din chat cheamă restoreToCheckpoint (git reset
   * --hard), cu backup automat al stării curente înainte de reset.
   * ==================================================================== */

  /** Setarea freekit.promptCheckpoints (implicit ON). */
  private checkpointsEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('freekit')
        .get<boolean>('promptCheckpoints', true) !== false
    );
  }

  /** v1.5.0: setarea freekit.autoInitGit (implicit ON). */
  private autoInitGitEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('freekit')
        .get<boolean>('autoInitGit', true) !== false
    );
  }

  /** Creează checkpoint-ul git al promptului curent (fail-open). */
  private async createCheckpoint(
    root: string,
    messageId: string,
    promptText: string
  ): Promise<void> {
    if (!this.checkpointsEnabled()) return;
    // v2.4.1: un checkpoint înseamnă scrieri git (commit) — doar cu Trust
    if (!vscode.workspace.isTrusted) return;
    try {
      const cp = await createPromptCheckpoint(root, messageId, promptText, {
        // v1.5.0: folder fără git → `git init` automat, ca butonul de
        // restore să apară întotdeauna (înainte: fail tăcut, fără buton)
        autoInit: this.autoInitGitEnabled()
      });
      if (!cp) {
        log('checkpoint: unavailable (not a git project / git missing) — skipping');
        // v1.5.0: o singură explicație per sesiune (înainte: fail tăcut)
        if (!this.checkpointNoticeShown) {
          this.checkpointNoticeShown = true;
          this.post(
            'heal',
            'ℹ️ Checkpoint unavailable: the folder is not a git repo or git is not installed — ' +
              'the ⟲ restore button will not appear. Install git (or run "git init" in the project folder).'
          );
        }
        return;
      }
      if (cp.repoInitialized) {
        // v1.5.0: am creat repo-ul git (folderul nu era sub git)
        log('checkpoint: automatic git init in ' + root);
        this.post(
          'heal',
          '🔧 The folder was not a git repo — it was initialized automatically (git init + a minimal .gitignore), ' +
            'so checkpoints and the ⟲ restore button work. ' +
            'You can turn this off with the freekit.autoInitGit setting.'
        );
      }
      this.checkpoints.push(cp);
      if (this.checkpoints.length > CHECKPOINTS_MAX) {
        this.checkpoints = this.checkpoints.slice(-CHECKPOINTS_MAX);
      }
      await this.state.update(CHECKPOINTS_KEY, this.checkpoints);
      log(
        'checkpoint ' + cp.id.slice(0, 7) + ' for ' + messageId +
          ' (wasClean=' + cp.wasClean + ')'
      );
      this.view?.webview.postMessage({
        type: 'checkpoint',
        messageId: cp.messageId,
        id: cp.id,
        text: cp.text,
        timestamp: cp.timestamp,
        wasClean: cp.wasClean
      });
    } catch (e: any) {
      // fail-open: un checkpoint nereușit nu blochează mesajul
      log('checkpoint failed: ' + (e?.message ?? String(e)));
    }
  }

  /** Butonul ⟲: confirmare modală → git reset --hard la checkpoint. */
  private async handleRestoreCheckpoint(messageId: string): Promise<void> {
    // v2.4.1: restore = git reset --hard (scriere) — blocat fără Trust
    if (!vscode.workspace.isTrusted) {
      this.post('notice', '🔒 ' + RESTRICTED_BLOCKED_NOTICE);
      showRestrictedNotification(true);
      return;
    }
    const cp = this.checkpoints.find((c) => c.messageId === messageId);
    if (!cp) {
      this.post(
        'notice',
        '⚠️ Checkpoint not found for this message (it may be too old).'
      );
      return;
    }
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then restore.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post('notice', '⚠️ No folder open — cannot restore.');
      return;
    }

    const pick = await vscode.window.showWarningMessage(
      '⟲ Go back to the state before this prompt?\n\n"' + cp.text + '"\n\n' +
        'All changes made after this checkpoint will be reverted ' +
        '(git reset --hard ' + cp.id.slice(0, 7) + '). The current state is ' +
        'saved automatically as a backup (git commit) before the reset.',
      { modal: true },
      'Yes, restore'
    );
    if (pick !== 'Yes, restore') {
      this.post('notice', 'Restore cancelled.');
      return;
    }

    log('restore checkpoint ' + cp.id.slice(0, 7) + ' (message ' + messageId + ')');
    const res = await restoreToCheckpoint(root, cp.id);
    if (res.ok) {
      const left = res.leftoverUntracked ?? [];
      this.post(
        'heal',
        '⟲ Checkpoint restored: "' + cp.text +
          '" — the project is back to the state before that prompt' +
          (res.backupId
            ? '. The state before the restore is saved in commit ' +
              res.backupId.slice(0, 7)
            : '') +
          (left.length
            ? '. ℹ️ ' + left.length + ' uncommitted files were left on disk (e.g. ' + left.slice(0, 3).join(', ') + ')'
            : '') +
          '.'
      );
      vscode.window.showInformationMessage('Freekit: checkpoint restored.');
      // v1.10.1: mesajele de după checkpoint nu mai au sens în istoric — le tăiem,
      // apoi reîmprospătăm dropdown-ul și chatul. checkpoint_restored rămâne ULTIMUL
      // (webview-ul îl folosește pentru badge-ul ✓).
      await this.conversations.truncateAfter(messageId);
      this.postConversations();
      this.rerenderActive();
      this.view?.webview.postMessage({
        type: 'checkpoint_restored',
        messageId,
        id: cp.id,
        backupId: res.backupId
      });
    } else {
      log('restore failed: ' + (res.error ?? 'unknown'));
      this.post('heal', '⛔ Restore failed: ' + (res.error ?? 'unknown error'));
      vscode.window.showWarningMessage(
        'Freekit: restore failed — ' + (res.error ?? 'unknown error')
      );
    }
  }

  /* ======================================================================
   * v1.9.0 — CONVERSAȚII MULTIPLE + EDIT PROMPT (✐) + FORK (ᛉ)
   * Lista conversațiilor trăiește în globalState (vezi conversations.ts);
   * bara de deasupra chatului comută între ele. Fiecare mesaj user primește
   * la hover trei butoane: ✐ (edit prompt: restore la checkpoint + trunchiere
   * + retrimitere), ᛉ (fork: conversație nouă din acel prompt — cea veche
   * rămâne intactă) și ⟲ (restore, când există checkpoint).
   * ==================================================================== */

  /** v1.9.0: migrează o singură dată istoricul legacy (freekit.history) într-o conversație. */
  private async ensureConversationsMigrated(): Promise<void> {
    try {
      if (this.conversations.list().length > 0) return;
      const legacy = this.getHistory();
      if (!legacy.length) return;
      const now = Date.now();
      const items: ConversationMessage[] = legacy
        .slice(-HISTORY_MAX)
        .map((m, i) => ({
          role: m.role,
          text: m.text,
          ts: m.ts || now,
          messageId:
            m.id && MSG_ID_RE.test(m.id)
              ? m.id
              : 'h' + now.toString(36) + '-' + i
        }));
      const firstUser = legacy.find((m) => m.role === 'user');
      const title = (firstUser?.text || 'Imported conversation')
        .trim()
        .slice(0, 40);
      await this.conversations.importLegacy(
        items,
        title || 'Imported conversation'
      );
      // nu re-importa la următoarea pornire
      await this.state.update(HISTORY_KEY, []);
      log('conversations: legacy history migrated (' + items.length + ' messages)');
    } catch (e: any) {
      log('conversations: migration failed — ' + (e?.message ?? String(e)));
    }
  }

  /** Mesajele conversației active, în formatul StoredMessage al webview-ului. */
  private activeHistoryItems(): StoredMessage[] {
    const conv = this.conversations.getActive();
    if (!conv) return this.getHistory();
    return conv.messages.map((m) => ({
      role: m.role,
      text: m.text,
      ts: m.ts,
      id: m.messageId
    }));
  }

  /** Trimite webview-ului lista de conversații + conversația activă (dropdown). */
  private postConversations(): void {
    const items = this.conversations.list().map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      parentId: c.parentId,
      count: c.messages.length
    }));
    this.view?.webview.postMessage({
      type: 'conversations',
      items,
      activeId: this.conversations.getActiveId()
    });
  }

  /** Re-randează chatul din conversația activă (comutare / fork / edit). */
  private rerenderActive(): void {
    this.view?.webview.postMessage({
      type: 'history',
      items: this.activeHistoryItems()
    });
  }

  /**
   * v2.0.2: golește chatul (istoricul persistat + conversația activă + atașamente)
   * și reîmprospătează lista de conversații în webview.
   */
  private async clearActiveChat(): Promise<void> {
    await this.state.update(HISTORY_KEY, []);
    await this.conversations.clearActive();
    this.attachments = [];
    this.postAttachments();
    this.postConversations();
    log('history cleared');
  }

  /** v1.9.0: comută la altă conversație (dropdown-ul din bara de conversații). */
  private async handleSwitchConversation(id: string): Promise<void> {
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then switch the conversation.');
      this.postConversations();
      return;
    }
    const conv = await this.conversations.switchTo(id);
    if (!conv) {
      this.post('notice', '⚠️ Conversation not found (was it deleted?).');
      this.postConversations();
      return;
    }
    log('conversation switched → ' + id + ' (' + conv.messages.length + ' messages)');
    this.postConversations();
    this.rerenderActive();
  }

  /** v1.9.0: conversație nouă (goală) — cea curentă rămâne în listă. */
  private async handleNewConversation(): Promise<void> {
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then start a new conversation.');
      return;
    }
    const active = this.conversations.getActive();
    if (active && active.messages.length === 0) {
      this.post('notice', 'ℹ️ You are already in a new (empty) conversation.');
      this.postConversations();
      return;
    }
    const conv = await this.conversations.create('New conversation');
    log('conversation created: ' + conv.id);
    this.post('heal', '🆕 New conversation — the previous one stays in the list (dropdown).');
    this.postConversations();
    this.rerenderActive();
  }

  /**
   * v1.9.0: șterge o conversație (cu confirmare nativă).
   * v2.0.3: `id` opțional — meniul contextual din lista de conversații poate
   * șterge orice conversație, nu doar cea activă.
   */
  private async handleDeleteConversation(id = ''): Promise<void> {
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then delete the conversation.');
      this.postConversations();
      return;
    }
    const target =
      (id ? this.conversations.list().find((c) => c.id === id) : undefined) ??
      this.conversations.getActive();
    if (!target) {
      this.post('notice', 'ℹ️ There is no conversation to delete.');
      this.postConversations();
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      '🗑 Delete the conversation "' + target.title + '"? (' + target.messages.length +
        ' messages — the action cannot be undone; git checkpoints stay in their history.)',
      { modal: true },
      'Delete'
    );
    if (pick !== 'Delete') {
      this.postConversations();
      return;
    }
    const wasActive = this.conversations.getActiveId() === target.id;
    await this.conversations.deleteConversation(target.id);
    log('conversation deleted: ' + target.id);
    this.post('heal', '🗑 The conversation "' + target.title + '" was deleted.');
    this.postConversations();
    // doar conversația activă schimbă ce se vede în chat
    if (wasActive) this.rerenderActive();
  }

  /** v1.9.0: fork (ᛉ) — conversație nouă din mesajul ales; cea veche NU se șterge. */
  private async handleForkConversation(messageId: string): Promise<void> {
    if (!MSG_ID_RE.test(messageId)) return;
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then create the fork.');
      return;
    }
    const forked = await this.conversations.forkFrom(messageId);
    if (!forked) {
      this.post('notice', '⚠️ Message not found in the active conversation — fork cancelled.');
      return;
    }
    log('fork: ' + messageId + ' → ' + forked.id);
    this.post(
      'heal',
      'ᛉ Fork created from the selected message — the original conversation stays in the list. ' +
        'Continue here with a new prompt; with ⟲ on the starting message you can also bring ' +
        'the files back to the state before it.'
    );
    this.postConversations();
    this.rerenderActive();
  }

  /**
   * v1.9.0: edit prompt (✐) — Save → (1) restore la checkpoint-ul git al
   * promptului original, (2) șterge mesajul editat + tot ce a urmat din
   * conversație, (3) retrimite textul editat (webview → fluxul normal de send).
   */
  private async handleEditPrompt(messageId: string, rawText: string): Promise<void> {
    if (!MSG_ID_RE.test(messageId)) return;
    const text = String(rawText ?? '').trim();
    if (!text) {
      this.post('notice', '⚠️ The edited text is empty — edit cancelled.');
      this.view?.webview.postMessage({ type: 'edit_cancel', messageId });
      return;
    }
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then edit the prompt.');
      this.view?.webview.postMessage({ type: 'edit_cancel', messageId });
      return;
    }
    const conv = this.conversations.getActive();
    const exists = conv?.messages.some(
      (m) => m.messageId === messageId && m.role === 'user'
    );
    if (!exists) {
      this.post('notice', '⚠️ The message no longer exists in the active conversation — edit cancelled.');
      this.view?.webview.postMessage({ type: 'edit_cancel', messageId });
      return;
    }

    // 1) restore la checkpoint-ul de dinaintea promptului original
    const cp = this.checkpoints.find((c) => c.messageId === messageId);
    if (cp) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (root) {
        const res = await restoreToCheckpoint(root, cp.id);
        if (res.ok) {
          log('edit: restore checkpoint ' + cp.id.slice(0, 7) + ' OK');
          this.post(
            'heal',
            '⟲ Edit: the files are back to the state before the original prompt' +
              (res.backupId
                ? ' (the state before the restore is saved in commit ' +
                  res.backupId.slice(0, 7) + ')'
                : '') +
              '. Resending the edited prompt.'
          );
        } else {
          log('edit: restore failed — ' + (res.error ?? 'unknown'));
          this.post(
            'heal',
            '⚠️ Edit: the checkpoint restore failed (' +
              (res.error ?? 'unknown error') +
              ') — the file changes remain as they are.'
          );
        }
      }
    } else {
      this.post(
        'notice',
        'ℹ️ Edit: this message has no checkpoint (not a git repo?) — the history is truncated, but the files are not reset.'
      );
    }

    // 2) șterge mesajul editat + tot ce a urmat din conversația activă
    await this.conversations.truncateBefore(messageId);
    log('edit prompt ' + messageId + ' → „' + text.slice(0, 60) + '”');
    this.postConversations();

    // 3) webview-ul re-randează conversația și retrimite promptul editat
    this.rerenderActive();
    this.view?.webview.postMessage({ type: 'edit_resend', text });
  }

  /** v0.4.0: aduce fereastra Chrome în față (comanda + butonul 👁 din toolbar). */
  async showChrome(): Promise<void> {
    log('show chrome requested');
    const res = await this.browser.show();
    if (res.ok) {
      this.post('notice', '👁 ' + res.message);
      vscode.window.showInformationMessage('Freekit: ' + res.message);
    } else {
      this.post('notice', '⚠️ ' + res.message);
      vscode.window.showWarningMessage('Freekit: ' + res.message);
    }
    void this.refreshProviderStatus();
  }

  /** v0.4.0: reîmprospătează badge-ul 🟢🟡🔴 din toolbar. */
  private async refreshProviderStatus(): Promise<void> {
    if (this.statusInFlight) return;
    this.statusInFlight = true;
    try {
      const info = await getProviderStatus();
      const selected = this.currentProviderId();
      const label = PROVIDER_LABELS[selected] ?? selected;

      let color: 'green' | 'yellow' | 'red';
      if (selected === 'ollama') {
        // local: verde dacă Ollama răspunde; galben dacă măcar browserul merge
        color = info.ollama ? 'green' : info.browser ? 'yellow' : 'red';
      } else {
        // web + auto: verde dacă browserul răspunde; galben cu rezervă locală
        color = info.browser ? 'green' : info.ollama ? 'yellow' : 'red';
      }

      const title = [
        'Provider: ' + label,
        'Chrome (CDP ' + info.port + '): ' +
          (info.browser ? '🟢 running' : '🔴 not responding'),
        ...(info.browser
          ? [
              '  DeepSeek: ' +
                (info.deepseekLoggedIn ? 'logged in 👍' : 'login not detected')
            ]
          : []),
        'Ollama (' + info.ollamaUrl + '): ' +
          (info.ollama
            ? '🟢 OK (' + info.ollamaModels.length + ' models)'
            : '🔴 not responding'),
        'Click for the detailed report.'
      ].join('\n');

      this.view?.webview.postMessage({ type: 'provider_status', color, title });
      // v2.0.1: lista pentru meniul chip-ului de model (browser + Ollama local)
      await this.postProvidersList(info);
    } catch (e: any) {
      log('status refresh failed: ' + (e?.message ?? String(e)));
    } finally {
      this.statusInFlight = false;
    }
  }

  /**
   * v2.0.1: lista de provideri + modele Ollama pentru meniul chip-ului de model.
   * Grupare: browser (conturi web) vs local (Ollama). Punctele colorate urmează
   * starea reală: verde = browser logat, albastru = Ollama local, portocaliu =
   * necesită login / browser indisponibil.
   *
   * v2.0.2: secțiunea locală primește hardware-ul detectat (VRAM/RAM), modelele
   * recomandate pentru mașina respectivă și rândul „Install Ollama" când
   * Ollama nu e prezent.
   */
  private async postProvidersList(info: ProviderStatusInfo): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('freekit');
    const activeModel = cfg.get<string>('ollamaModel', 'qwen2.5-coder:7b');
    const selected = this.currentProviderId();

    const hw = await detectHardware();
    const recommendations = recommendModels(hw);
    const installState = ollamaInstallState(info);

    interface Row {
      id: string;
      label: string;
      sub: string;
      group: 'browser' | 'local';
      dot: 'green' | 'orange' | 'blue';
      modelId?: string;
      active?: boolean;
      /** v2.0.2: modelul instalat e recomandat pentru hardware-ul detectat. */
      recommended?: boolean;
      /** v2.1.0: cât de repede rulează modelul instalat pe mașina asta. */
      speed?: string;
      /** v2.0.2: recomandare care nu e instalată încă (rândul descarcă modelul). */
      missing?: boolean;
      /** v2.2.0: modelul web ales pentru provider (ex: „GPT-4o"), afișat pe chip. */
      modelLabel?: string;
      /** v2.2.0: modelele web ale providerului activ (sub-rânduri în meniu). */
      models?: Array<{ id: string; label: string; badge?: string; active?: boolean }>;
    }

    const browserDot = (id: string): 'green' | 'orange' => {
      if (!info.browser) return 'orange';
      if (id === 'deepseek' && !info.deepseekLoggedIn) return 'orange';
      return 'green';
    };

    const providers: Row[] = [
      {
        id: 'auto',
        label: 'Auto',
        sub: 'Browser → Ollama',
        group: 'browser',
        dot: info.browser ? 'green' : 'orange'
      }
    ];
    for (const id of BROWSER_PROVIDER_IDS) {
      const row: Row = {
        id,
        label: PROVIDER_LABELS[id] ?? id,
        sub: '',
        group: 'browser',
        dot: browserDot(id)
      };
      // v2.2.0: modelul web ales (dacă există) apare pe rând + pe chip
      const chosen = this.state.get<string>(browserModelKey(id), '');
      if (chosen) row.modelLabel = modelLabel(id, chosen);
      // Doar providerul activ își desfășoară modelele — meniul rămâne compact.
      // Primul rând readuce modelul implicit al site-ului (șterge preferința).
      if (id === selected) {
        row.models = [
          { id: '', label: 'Site default', active: !chosen },
          ...listModels(id).map((m) => ({
            id: m.id,
            label: m.label,
            badge: m.badge,
            active: !!chosen && m.id === chosen
          }))
        ];
      }
      providers.push(row);
    }

    const sizeByModel = new Map(
      info.ollamaModelDetails.map((m) => [m.name.toLowerCase(), m.sizeBytes])
    );
    const models = info.ollamaModels.length ? info.ollamaModels : [activeModel];
    for (const model of models) {
      const recommended = fitsThisMachine(model, hw);
      const speed = modelSpeed(model, hw);
      const size = formatModelSize(sizeByModel.get(model.toLowerCase()) ?? 0);
      // v2.1.0: spune și CÂT de repede rulează: VRAM = rapid, MoE pe CPU =
      // acceptabil, dens în RAM = lent (dar utilizabil).
      const verdict = !recommended
        ? ''
        : speed === 'fast'
          ? 'recommended · GPU'
          : speed === 'medium'
            ? 'recommended · CPU-friendly'
            : 'recommended · CPU (slow)';
      providers.push({
        id: 'ollama',
        label: model,
        sub: [verdict, size].filter(Boolean).join(' · '),
        group: 'local',
        dot: info.ollama ? 'blue' : 'orange',
        modelId: model,
        recommended,
        speed: speed ?? undefined
      });
    }

    // v2.0.2: recomandările care lipsesc — se descarcă direct din meniu.
    // Doar când serverul răspunde (altfel `ollama pull` nu are unde rula).
    if (info.ollama) {
      const installed = new Set(models.map((m) => m.toLowerCase()));
      for (const rec of recommendations) {
        if (installed.has(rec.id.toLowerCase())) continue;
        providers.push({
          id: 'ollama',
          label: rec.id,
          sub: [rec.size, rec.speed, 'download'].join(' · '),
          group: 'local',
          dot: 'orange',
          modelId: rec.id,
          missing: true,
          speed: rec.speed
        });
      }
    }

    for (const p of providers) {
      p.active =
        p.group === 'local'
          ? selected === 'ollama' && p.modelId === activeModel
          : p.id === selected;
    }

    this.view?.webview.postMessage({
      type: 'providers_list',
      providers,
      hardware: {
        summary: hardwareSummary(hw),
        gpu: hw.gpus[0]?.name ?? '',
        vramGb: hw.vramGb,
        ramGb: hw.ramGb,
        cpu: hw.cpuModel,
        cpuCores: hw.cpuCores,
        note: hw.note ?? '',
        // v2.1.0: tier + detecție completă (toate GPU-urile, disc, VM)
        tier: hw.tier,
        tierTarget: tierTarget(hw.tier),
        totalVramGb: hw.totalVramGb,
        unifiedMemoryGb: hw.unifiedMemoryGb,
        freeDiskGb: hw.freeDiskGb,
        isVM: hw.isVM,
        gpus: hw.gpus.map((g) => ({
          name: g.name,
          vramGb: g.vramGb,
          vendor: g.vendor,
          type: g.type,
          bandwidthGbps: g.bandwidthGbps ?? 0
        }))
      },
      recommendations,
      ollama: { state: installState, running: info.ollama, installed: info.ollamaCli }
    });
  }

  /**
   * v2.0.2: descarcă un model Ollama (`ollama pull`) cu progres în bara de
   * notificări. La reușită, modelul devine providerul activ.
   */
  private async pullModel(model: string): Promise<void> {
    const info = await getProviderStatus();
    if (!info.ollama) {
      const pick = await vscode.window.showWarningMessage(
        'Freekit: Ollama is not reachable, so "' + model + '" cannot be downloaded.',
        { modal: true },
        'Install Ollama'
      );
      if (pick === 'Install Ollama') {
        await vscode.commands.executeCommand('freekit.installOllama');
      }
      return;
    }

    const ac = new AbortController();
    let ok = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Freekit: downloading Ollama model "' + model + '"',
        cancellable: true
      },
      async (prog, token) => {
        const sub = token.onCancellationRequested(() => ac.abort());
        let lastStatus = '';
        try {
          await pullOllamaModel(
            model,
            (p) => {
              const line =
                p.status + (p.percent != null ? ' — ' + p.percent + '%' : '');
              if (line === lastStatus) return;
              lastStatus = line;
              prog.report({ message: line });
            },
            ac.signal
          );
          ok = true;
        } catch (e: any) {
          if (ac.signal.aborted) {
            vscode.window.showWarningMessage(
              'Freekit: download cancelled — "' + model + '" was not installed completely.'
            );
          } else {
            const msg = e?.message ?? String(e);
            vscode.window.showErrorMessage('Freekit: download failed — ' + msg);
            this.postNotice('🦙 ⚠️ Ollama pull failed: ' + msg);
          }
        } finally {
          sub.dispose();
        }
      }
    );

    if (!ok) return;

    await vscode.workspace
      .getConfiguration('freekit')
      .update('provider', 'ollama', vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('freekit')
      .update('ollamaModel', model, vscode.ConfigurationTarget.Global);

    log('pulled and selected model ' + model);
    this.post('provider', 'ollama');
    vscode.window.showInformationMessage(
      'Freekit: "' + model + '" is installed and selected (local Ollama).'
    );
    this.postNotice('🦙 "' + model + '" downloaded and selected ✓');
    await this.refreshProviderStatus();
  }

  /** v0.4.0: raport detaliat (comanda "Show Provider Status" + click pe badge). */
  async showProviderStatusReport(): Promise<void> {
    const info = await getProviderStatus();
    const selected = this.currentProviderId();
    const cfg = vscode.workspace.getConfiguration('freekit');
    const activeModel = cfg.get<string>('ollamaModel', 'qwen2.5-coder:7b');

    const lines: string[] = [];
    lines.push(
      '===== Freekit — Provider Status — ' + new Date().toLocaleString() + ' ====='
    );
    if (selected === 'auto') {
      const chain = this.autoChainIds();
      lines.push(
        'Selected provider: Auto — chain: ' +
          chain.map((id) => PROVIDER_LABELS[id] ?? id).join(' → ')
      );
    } else {
      lines.push('Selected provider: ' + (PROVIDER_LABELS[selected] ?? selected));
    }
    lines.push(
      'Chrome/CDP: port ' +
        info.port +
        ' — ' +
        (info.browser ? '🟢 running' : '🔴 not responding')
    );
    if (info.browser) {
      lines.push(
        '  DeepSeek: ' +
          (info.deepseekLoggedIn
            ? '🟢 chat tab found (logged in)'
            : '🟡 no logged-in tab found')
      );
    }
    lines.push(
      'Ollama: ' + info.ollamaUrl + ' — ' + (info.ollama ? '🟢 OK' : '🔴 not responding')
    );
    if (info.ollama) {
      lines.push('  Models: ' + (info.ollamaModels.join(', ') || '(none)'));
      if (info.ollamaModels.length) {
        const base = activeModel.split(':')[0];
        const has = info.ollamaModels.some(
          (m) => m === activeModel || m.split(':')[0] === base
        );
        lines.push(
          '  Configured model: ' + activeModel + (has ? ' ✓' : ' ⚠️ not in the list')
        );
      }
    } else {
      lines.push(
        info.ollamaCli
          ? '  (installed, but the server is not running — start it with "ollama serve")'
          : '  (not installed — run "Freekit: Install Ollama" for the download page)'
      );
    }

    // v2.0.2: hardware detectat + recomandări de modele locale
    // v2.1.0: raport complet (tier, toate GPU-urile, disc, VM) + viteză estimată
    const hw = await detectHardware();
    const recs = recommendModels(hw, 4);
    lines.push('Hardware: ' + hardwareSummary(hw));
    lines.push(...hardwareReport(hw));
    if (recs.length) {
      lines.push('  Recommended local models (fastest first, best per size class):');
      for (const r of recs) {
        lines.push(
          '    • ' + r.id + ' (' + r.size + ', ~' + r.needGb + ' GB, ' + r.speed +
            ', from ' + r.minTier + ') — ' + r.why
        );
      }
    }

    // v1.1.0: starea serverelor MCP + numărul de unelte expuse
    lines.push(...mcp.statusLines());
    lines.push('Recommendation: ' + this.statusRecommendation(selected, info));

    for (const line of lines) logLine('status', line);
    initLogChannel().show(true);
    this.post('notice', lines.join('\n'));
    vscode.window.showInformationMessage(
      'Freekit: provider status written to Output → Freekit (see also the chat).'
    );
  }

  private statusRecommendation(
    selected: string,
    info: ProviderStatusInfo
  ): string {
    if (selected === 'auto') {
      if (info.browser && info.ollama)
        return 'both available — Auto uses the browser, Ollama stays as the fallback.';
      if (info.browser)
        return 'the browser is available — Ollama is not responding (fallback inactive).';
      if (info.ollama)
        return 'the browser is not responding — Auto will start Chrome, and Ollama is the fallback.';
      return 'no provider available — start Chrome or Ollama.';
    }
    if (selected === 'ollama') {
      if (info.ollama) return 'Ollama is ready to work (local mode).';
      return info.browser
        ? 'Ollama is not responding — start "ollama serve" or choose a web provider.'
        : 'start Ollama with "ollama serve".';
    }
    if (info.browser) return 'the web provider can be used now.';
    return info.ollama
      ? 'the browser is not running — use "Show Chrome" / Open Browser or choose Ollama (local).'
      : 'start Chrome (Open Browser / Show Chrome) or Ollama.';
  }

  // FAZA II (A): lista de atașamente --------------------------------
  private postAttachments() {
    this.view?.webview.postMessage({
      type: 'attachments',
      items: this.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        relPath: a.relPath,
        size: a.size,
        kind: a.kind
      }))
    });
  }

  private async addAttachments(paths: string[]) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    for (const p of paths) {
      if (this.attachments.length >= MAX_ATTACHMENTS) {
        log('attachment limit reached (' + MAX_ATTACHMENTS + ')');
        break;
      }
      const norm = path.resolve(p).toLowerCase();
      if (
        this.attachments.some(
          (a) => path.resolve(a.absPath).toLowerCase() === norm
        )
      ) {
        continue; // deja atașat
      }
      const att = await describePath(p, root);
      if (!att) continue;
      this.attachments.push(att);
      log('attachment added: ' + att.relPath + ' (' + att.kind + ')');
    }
    this.postAttachments();
  }

  /* ======================================================================
   * v0.5.0 — Diff & Review nativ VS Code
   * Scrierile de fișiere nu mai folosesc cardul text din chat: se deschide
   * un tab de diff NATIV VS Code (stânga = conținutul vechi, dreapta = cel
   * nou) + o notificare cu butoanele Accept / Reject / Accept (nu mai
   * întreba). Conținuturile merg în fișiere temporare (os.tmpdir) — fișierul
   * real NU e atins până la acceptare. La închiderea notificării fără
   * alegere, aprobarea revine pe cardul clasic din chat.
   * ==================================================================== */

  /** Deblochează un diff review în așteptare (Stop / auto-approve activat). */
  private wakePendingReview(): void {
    const resolve = this.pendingReviewResolve;
    this.pendingReviewResolve = undefined;
    resolve?.();
  }

  private noAskKey(rel: string): string {
    return path.normalize(String(rel)).toLowerCase();
  }

  private getNoAskFiles(): string[] {
    return this.state.get<string[]>(NO_ASK_KEY, []) ?? [];
  }

  private isNoAskFile(rel: string): boolean {
    const key = this.noAskKey(rel);
    return this.getNoAskFiles().some((f) => this.noAskKey(f) === key);
  }

  private async addNoAskFile(rel: string): Promise<void> {
    const files = this.getNoAskFiles();
    const key = this.noAskKey(rel);
    if (files.some((f) => this.noAskKey(f) === key)) return;
    files.push(rel);
    await this.state.update(NO_ASK_KEY, files);
  }

  /** Comanda `freekit.clearNoAsk`: golește lista „nu mai întreba". */
  async clearNoAskFiles(): Promise<void> {
    const files = this.getNoAskFiles();
    await this.state.update(NO_ASK_KEY, []);
    log('no-ask list cleared (' + files.length + ' entries)');
    if (files.length) {
      vscode.window.showInformationMessage(
        'Freekit: the "don\'t ask again" list was cleared (' +
          files.length +
          ' files).'
      );
    } else {
      vscode.window.showInformationMessage(
        'Freekit: the "don\'t ask again" list was already empty.'
      );
    }
  }

  /**
   * Deschide diff-ul nativ (stânga = vechi, dreapta = nou) și cere aprobarea.
   * v1.2.1: cererea apare ÎN PARALEL în două locuri — card inline în chat
   * (sursa principală de decizie; notificarea VS Code poate fi ascunsă,
   * expirată sau nerandată) și notificarea nativă VS Code (a doua cale).
   * Prima decizie câștigă; ambele căi ajung la aceeași promisiune.
   * Întoarce 'fallback' doar când diff-ul nu se poate afișa sau chatul nu e
   * disponibil — aprobarea continuă pe cardul clasic din chat.
   */
  private async showDiffReview(
    toolName: string,
    changes: FileChangePreview[]
  ): Promise<'accept' | 'reject' | 'accept_no_ask' | 'fallback'> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 'fallback';
    if (this.abortRequested) return 'reject';

    // 1) scrie conținuturile în fișiere temporare (workspace-ul e intact)
    const tmpDir = path.join(os.tmpdir(), 'freekit-review');
    const stamp = Date.now() + '-' + ++reviewSeq;
    const pairs: Array<{
      label: string;
      left: vscode.Uri;
      right: vscode.Uri;
    }> = [];
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      changes.forEach((c, i) => {
        const base = (path.basename(c.label) || 'file').replace(
          /[^\w.\-]+/g,
          '_'
        );
        const leftPath = path.join(tmpDir, stamp + '-' + i + '-old-' + base);
        const rightPath = path.join(tmpDir, stamp + '-' + i + '-new-' + base);
        fs.writeFileSync(leftPath, c.oldContent, 'utf8');
        fs.writeFileSync(rightPath, c.newContent, 'utf8');
        pairs.push({
          label: c.label,
          left: vscode.Uri.file(leftPath),
          right: vscode.Uri.file(rightPath)
        });
      });
    } catch (e: any) {
      log(
        'diff review: could not write the temporary files — ' +
          (e?.message ?? String(e))
      );
      return 'fallback';
    }

    // promisiune de „deșteptare" — Stop sau auto-approve activat în timpul review-ului
    const wake = new Promise<void>((resolve) => {
      this.pendingReviewResolve = resolve;
    });

    // v1.2.1: id-ul review-ului + promisiunea deciziei din cardul INLINE din
    // chat (butoanele Accept / Reject). Resolver-ul e înregistrat pe instanță
    // imediat ce cardul e afișat (vezi pasul „2b" mai jos).
    const reviewId = newApprovalId();
    let resolveInline:
      | ((d: '__inline_accept__' | '__inline_reject__') => void)
      | undefined;
    const inlineDecision = new Promise<
      '__inline_accept__' | '__inline_reject__'
    >((resolve) => {
      resolveInline = resolve;
    });

    const single = changes.length === 1;
    const title = single
      ? 'Freekit: ' + toolName + ' → ' + changes[0].label
      : 'Freekit: ' + toolName + ' → ' + changes.length + ' files';
    log('diff review: ' + title + ' (' + pairs.length + ' files)');

    // 2) deschide diff-ul nativ VS Code
    try {
      if (single) {
        await vscode.commands.executeCommand(
          'vscode.diff',
          pairs[0].left,
          pairs[0].right,
          title
        );
      } else {
        // multi-diff (un singur editor cu toate fișierele)
        const resources = pairs.map((p) => [p.label, p.left, p.right]);
        await vscode.commands.executeCommand(
          'vscode.changes',
          title,
          resources
        );
      }
    } catch (e: any) {
      // fără diff vizibil nu aprobăm „pe nevăzute" — cădem pe cardul din chat
      this.pendingReviewResolve = undefined;
      log(
        'diff review: opening the diff failed — ' +
          (e?.message ?? String(e))
      );
      return 'fallback';
    }

    // v1.2.1: 2b) cardul INLINE din chat — sursa principală de decizie
    // (notificarea VS Code poate fi ascunsă, expirată sau nerandată)
    const target = single ? changes[0].label : changes.length + ' files';
    let inlineShown = false;
    if (this.view && resolveInline) {
      // v2.0.1: rândurile inline de „file change" — paralele cu diff-ul nativ
      const rows: FileChangeRow[] = changes.map((c, i) => {
        const stats = computeDiffStats(c.oldContent ?? '', c.newContent ?? '');
        return {
          rowId: reviewId + ':' + i,
          reviewId,
          filename: c.label,
          added: stats.added,
          removed: stats.removed,
          isNew: !!c.isNew
        };
      });
      const payload = {
        id: reviewId,
        tool: toolName,
        target,
        preview: buildReviewPreview(changes),
        rows
      };
      this.pendingInlineReview = { id: reviewId, resolve: resolveInline };
      this.pendingInlineReviewPayload = payload;
      this.pendingFileRows = { reviewId, single, title, rows, pairs };
      this.view.webview.postMessage({ type: 'diff_review', ...payload });
      for (const row of rows) {
        this.view.webview.postMessage({ type: 'file_change_row', ...row });
      }
      inlineShown = true;
      log(
        'diff review: inline card + ' +
          rows.length +
          ' file change row(s) sent to chat (id ' +
          reviewId +
          ')'
      );
    }

    // 3) întreabă utilizatorul (butoane nativ VS Code, în bara de jos)
    const msg = single
      ? 'Freekit: ' +
        toolName +
        ' wants to write ' +
        changes[0].label +
        ' — the diff is open in the editor.'
      : 'Freekit: ' +
        toolName +
        ' wants to write ' +
        changes.length +
        ' files — the multi-file diff is open in the editor.';
    const buttons = single
      ? ['Accept', 'Reject', NO_ASK_LABEL]
      : ['Accept', 'Reject'];

    const pick = await Promise.race([
      vscode.window.showInformationMessage(
        msg,
        { modal: false },
        ...buttons
      ),
      wake.then((): string | undefined => undefined),
      inlineDecision
    ]);
    this.pendingReviewResolve = undefined;

    // v1.2.1: oricare cale răspunde prima decide review-ul
    let via: 'notification' | 'chat' | 'stop' | 'auto' = 'notification';
    let decision: 'accept' | 'reject' | 'accept_no_ask' | 'fallback';
    if (this.abortRequested) {
      // Stop apăsat cât timp era deschis → refuz
      via = 'stop';
      decision = 'reject';
    } else if (this.autoApprove) {
      // Auto-approve activat în timpul review-ului → accept
      via = 'auto';
      decision = 'accept';
    } else if (pick === '__inline_accept__') {
      via = 'chat';
      decision = 'accept';
    } else if (pick === '__inline_reject__') {
      via = 'chat';
      decision = 'reject';
    } else if (pick === 'Accept') {
      decision = 'accept';
    } else if (pick === 'Reject') {
      decision = 'reject';
    } else if (single && pick === NO_ASK_LABEL) {
      decision = 'accept_no_ask';
    } else if (inlineShown) {
      // v1.2.1: notificarea a fost închisă fără alegere → cardul inline din
      // chat rămâne sursa de decizie (înainte se cădea pe cardul clasic)
      log('diff review: notification closed without a choice — waiting for the inline card');
      const wake2 = new Promise<void>((resolve) => {
        this.pendingReviewResolve = resolve;
      });
      const inlinePick = await Promise.race([
        inlineDecision,
        wake2.then((): undefined => undefined)
      ]);
      this.pendingReviewResolve = undefined;
      if (this.abortRequested) {
        via = 'stop';
        decision = 'reject';
      } else if (this.autoApprove) {
        via = 'auto';
        decision = 'accept';
      } else {
        via = 'chat';
        decision = inlinePick === '__inline_accept__' ? 'accept' : 'reject';
      }
    } else {
      // fără webview (nicio cale din chat) → cardul clasic de aprobare
      decision = 'fallback';
    }

    this.pendingInlineReview = undefined;
    this.pendingInlineReviewPayload = undefined;
    this.pendingFileRows = undefined;

    // v1.2.1: anunță cardul din chat despre decizia finală (oricare cale a
    // câștigat-o) — butoanele sunt înlocuite de statusul rezolvat
    // v2.0.1: același mesaj închide și rândurile inline de „file change"
    if (inlineShown) {
      this.view?.webview.postMessage({
        type: 'diff_review_done',
        id: reviewId,
        reviewId,
        decision,
        via
      });
    }

    return decision;
  }

  /**
   * v2.0.1: acțiunile rândurilor inline de „file change" din chat.
   * `view_diff` redeschide diff-ul nativ VS Code; `approve` / `reject` ajung la
   * ACEEAȘI promisiune ca cardul de diff review și notificarea VS Code — prima
   * decizie câștigă.
   */
  private async handleFileChangeAction(
    rowId: string,
    action: string
  ): Promise<void> {
    const meta = this.pendingFileRows;
    if (!meta) return;

    if (action === 'view_diff') {
      const idx = Number(String(rowId).split(':').pop());
      const pair = meta.pairs[Number.isFinite(idx) ? idx : 0];
      if (!pair) return;
      const title = meta.single
        ? meta.title
        : meta.title + ' — ' + pair.label;
      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          pair.left,
          pair.right,
          title
        );
      } catch (e: any) {
        log(
          'file change row: could not open the diff — ' +
            (e?.message ?? String(e))
        );
      }
      return;
    }

    const pending = this.pendingInlineReview;
    if (!pending || pending.id !== meta.reviewId) return;
    if (action === 'approve') {
      pending.resolve('__inline_accept__');
    } else if (action === 'reject') {
      pending.resolve('__inline_reject__');
    }
  }

  // FAZA E: istoricul persistat în globalState (v1.9.0: doar ca sursă de migrare —
  // rolul a fost preluat de conversații; vezi ensureConversationsMigrated)
  private getHistory(): StoredMessage[] {
    return this.state.get<StoredMessage[]>(HISTORY_KEY, []);
  }

  // v1.9.0: istoricul trăiește în conversația activă (persistat în globalState);
  // semnătura e neschimbată — apelanții (send / răspuns final / rollback) nu se ating.
  private async appendHistory(
    role: 'user' | 'assistant',
    text: string,
    id?: string
  ) {
    try {
      const ts = Date.now();
      if (!this.conversations.getActive()) {
        await this.conversations.create(
          String(text ?? '').slice(0, 40) || 'Conversation'
        );
      }
      const messageId =
        id ?? 'a' + ts.toString(36) + Math.random().toString(36).slice(2, 6);
      await this.conversations.appendMessage({ role, text, ts, messageId });
    } catch (e: any) {
      log('history save failed: ' + (e?.message ?? String(e)));
    }
  }

  // v2.4.8: extractorul robust (acolade echilibrate + fence markdown) trăiește
  // în src/toolCallParser.ts — vezi acolo de ce regex-ul naiv eșua pe JSON-ul
  // cu `content` nested.
  private parseToolCall(text: string): ToolCall | null {
    return parseToolCallText(text);
  }

  private getHtml(webview: vscode.Webview): string {
    const toUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', file)
      );

    const jsUri = toUri('chat.js');
    const cssUri = toUri('chat.css');
    // v2.0.3: fontul de iconițe @vscode/codicons (vendorizat în media/ — doar
    // codicon.css + codicon.ttf, ca VSIX-ul să nu care tot pachetul npm)
    const codiconUri = toUri('codicon.css');
    const markedUri = toUri('marked.min.js');
    const purifyUri = toUri('purify.min.js');

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};"/>
<link rel="stylesheet" href="${codiconUri}"/>
<link rel="stylesheet" href="${cssUri}"/>
</head><body>
<!-- v2.0.1: icon sprite (structura din mockup) — v2.0.3: redus la iconițele
     care nu sunt în meniuri (meniurile folosesc acum codicons) -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></symbol>
  <symbol id="i-more" viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.2" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></symbol>
  <symbol id="i-attach" viewBox="0 0 16 16"><path d="M13 7.2L8 12.2a3 3 0 0 1-4.2-4.2l5-5a2 2 0 0 1 2.8 2.8l-5 5a1 1 0 0 1-1.4-1.4l4.5-4.5"/></symbol>
  <symbol id="i-folder" viewBox="0 0 16 16"><path d="M1.5 3.5h4L7 5h7.5v7.5h-13z"/></symbol>
  <symbol id="i-mic" viewBox="0 0 16 16"><rect x="6" y="2" width="4" height="7" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"/></symbol>
  <symbol id="i-stop" viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/></symbol>
  <symbol id="i-send" viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4"/></symbol>
  <symbol id="i-bulb" viewBox="0 0 16 16"><path d="M6 12h4M6.5 14h3M8 2a4 4 0 0 0-2.2 7.3c.3.3.4.6.4 1V11h3.6v-.7c0-.4.1-.7.4-1A4 4 0 0 0 8 2z"/></symbol>
  <symbol id="i-file" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4zM9 2v3h3"/></symbol>
</svg>

<div class="side">

  <!-- HEADER: titlu + New chat + meniul ⋯ -->
  <header class="head">
    <span class="title">Freekit</span>
    <span class="grow"></span>
    <button class="ibtn" id="conv-new" title="New chat" aria-label="New chat"><svg class="ic"><use href="#i-plus"/></svg></button>
    <div class="pop">
      <button class="ibtn" id="moreBtn" title="More actions" aria-label="More actions" aria-haspopup="true" aria-expanded="false" data-menu="menuMore"><svg class="ic"><use href="#i-more"/></svg></button>
      <!-- v2.0.2: meniul „⋯" grupat pe secțiuni (Context / Session / Debug / Settings) -->
      <!-- v2.0.3: iconițele din meniuri sunt CODNICONS (fontul @vscode/codicons),
           nu mai folosesc sprite-ul SVG propriu; „Delete conversation" a trecut în
           meniul contextual (dreapta-click pe conversație). -->
      <div class="menu down" id="menuMore" role="menu">
        <div class="mh">Context</div>
        <button class="mi plain" id="mShowChrome" role="menuitem"><i class="codicon codicon-eye"></i>Show Chrome</button>
        <button class="mi plain" id="mOpenBrowser" role="menuitem"><i class="codicon codicon-globe"></i>Open Browser</button>
        <button class="mi plain" id="mStopDev" role="menuitem"><i class="codicon codicon-debug-stop"></i>Stop dev servers</button>
        <button class="mi plain" id="mStatus" role="menuitem"><i class="codicon codicon-pulse"></i>Provider status</button>
        <button class="mi plain" id="mInstallOllama" role="menuitem" hidden><i class="codicon codicon-cloud-download"></i>Install Ollama</button>
        <div class="sep"></div>

        <div class="mh">Session</div>
        <button class="mi plain" id="mNew" role="menuitem"><i class="codicon codicon-add"></i>New chat</button>
        <div class="mh">Conversations</div>
        <div id="conv-list"></div>
        <div class="sep"></div>

        <div class="mh">Debug</div>
        <button class="mi plain" id="mVerbose" role="menuitemcheckbox" aria-checked="false" data-toggle><i class="codicon codicon-list-flat"></i>Verbose logs<span class="sub">Off</span></button>
        <button class="mi plain" id="mDiagnostics" role="menuitem"><i class="codicon codicon-pulse"></i>Diagnostics</button>
        <button class="mi plain" id="mMcp" role="menuitem"><i class="codicon codicon-plug"></i>MCP servers</button>
        <button class="mi plain" id="mResetSelectors" role="menuitem"><i class="codicon codicon-wrench"></i>Reset repaired selectors</button>
        <div class="sep"></div>

        <div class="mh">Settings</div>
        <button class="mi plain" id="mSettings" role="menuitem"><i class="codicon codicon-settings-gear"></i>Settings</button>
        <div class="sep"></div>
        <button class="mi plain" id="mClear" role="menuitem"><i class="codicon codicon-trash"></i>Clear chat</button>
      </div>
    </div>
  </header>

  <!-- v2.0.3: meniul contextual al conversațiilor (dreapta-click pe un rând) -->
  <div class="menu ctx" id="convCtxMenu" role="menu">
    <button class="mi plain" id="convCtxDelete" role="menuitem"><i class="codicon codicon-trash"></i>Delete conversation</button>
  </div>

  <main class="chat" id="chat"></main>

  <button id="jump" class="ibtn" title="Jump to the latest" hidden><svg class="ic"><use href="#i-chev"/></svg></button>

  <footer class="composer" id="input-area">
    <div id="attachments" hidden></div>

    <!-- Rând 1: selectorii de context (model / thinking / auto) -->
    <div class="ctx">
      <div class="pop">
        <button class="chip" id="modelChip" data-menu="menuModel" aria-haspopup="true" aria-expanded="false" title="Provider and model">
          <span class="dot" id="modelDot"></span><span class="lbl" id="modelLabel">Auto</span><svg class="ic sm"><use href="#i-chev"/></svg>
        </button>
        <div class="menu up" id="menuModel" role="menu">
          <div class="mh">Browser accounts</div>
          <div id="model-browser"></div>
          <div class="sep"></div>
          <div class="mh">Local &middot; Ollama</div>
          <div id="model-local"></div>
          <div class="mnote" id="model-hw" hidden></div>
        </div>
      </div>

      <div class="pop">
        <button class="chip" id="thinkChip" data-menu="menuThink" aria-haspopup="true" aria-expanded="false" title="Thinking level">
          <svg class="ic sm"><use href="#i-bulb"/></svg><span class="lbl" id="thinkLabel">Medium</span><svg class="ic sm"><use href="#i-chev"/></svg>
        </button>
        <div class="menu up" id="menuThink" role="menu" data-radio data-label="#thinkLabel">
          <div class="mh">Thinking level</div>
          <button class="mi" role="menuitemradio" aria-checked="false" data-value="off" data-label="Off"><i class="codicon codicon-check ck"></i>Off<span class="sub">fastest</span></button>
          <button class="mi" role="menuitemradio" aria-checked="false" data-value="low" data-label="Low"><i class="codicon codicon-check ck"></i>Low<span class="sub">quick</span></button>
          <button class="mi" role="menuitemradio" aria-checked="true" data-value="medium" data-label="Medium"><i class="codicon codicon-check ck"></i>Medium<span class="sub">balanced</span></button>
          <button class="mi" role="menuitemradio" aria-checked="false" data-value="high" data-label="High"><i class="codicon codicon-check ck"></i>High<span class="sub">deepest</span></button>
        </div>
      </div>

      <span class="grow"></span>

      <button class="chip auto" id="auto" aria-pressed="false" title="Auto-approve file edits and commands">
        <span class="track"><span class="knob"></span></span><span>Auto</span>
      </button>
    </div>

    <!-- Rând 2: input full-width cu acțiuni inline -->
    <div class="box">
      <textarea id="in" rows="2" placeholder="Ask Freekit to code... (Enter to send)" aria-label="Message"></textarea>
      <div class="bar">
        <button class="ibtn" id="attach-file" title="Attach files" aria-label="Attach files"><svg class="ic"><use href="#i-attach"/></svg></button>
        <button class="ibtn" id="attach-folder" title="Attach folders" aria-label="Attach folders"><svg class="ic"><use href="#i-folder"/></svg></button>
        <span class="grow"></span>
        <button class="ibtn" id="stop" title="Stop the response" hidden><svg class="ic"><use href="#i-stop"/></svg></button>
        <button class="ibtn" id="mic-btn" title="Voice input" aria-label="Voice input"><svg class="ic"><use href="#i-mic"/></svg></button>
        <button class="send" id="send" title="Send" aria-label="Send" disabled><svg class="ic"><use href="#i-send"/></svg></button>
      </div>
    </div>
  </footer>
</div>
<script src="${markedUri}"></script>
<script src="${purifyUri}"></script>
<script src="${jsUri}"></script>
</body></html>`;
  }
}