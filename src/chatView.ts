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
  ProviderStatusInfo
} from './providers';
import { AIProvider } from './providers/types';
import { configInfo, selectors } from './selectors';
import { BrowserManager } from './browser';
import {
  executeTool,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_LOCAL,
  ToolCall,
  ToolResult,
  FileChangePreview,
  pendingApprovals,
  newApprovalId,
  resetWriteLimits,
  resetCommandLimits,
  MAX_TEXT_RETRIES,
  TEXT_RETRY_NUDGE,
  looksLikeIntentOnly
} from './tools';
import { mcp } from './mcp/manager';
import { Attachment, describePath, prepareAttachments } from './attachments';
import { detectProject, formatProjectInfo } from './project';
import { initLogChannel, logLine } from './log';
import { detectCaptcha, isLoginRequiredError, isLoginUrl, sleep } from './providers/base';
import { runVerification, createPromptCheckpoint, restoreToCheckpoint, Checkpoint } from './verifier';
import { ConversationStore, ConversationMessage } from './conversations';
import { EditRollback } from './rollback';
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
const HISTORY_KEY = 'aiBridge.history';
const HISTORY_MAX = 100;

// v0.2.1: auto-approve (persistat în globalState)
const AUTO_APPROVE_KEY = 'aiBridge.autoApprove';

// v0.4.0: ultimul provider web folosit (modul Auto îl încearcă primul)
const LAST_BROWSER_KEY = 'aiBridge.lastBrowserProvider';

// v0.5.0: fișiere aprobate cu „nu mai întreba" (diff nativ, persistat)
const NO_ASK_KEY = 'aiBridge.noAskFiles';

// v0.5.0: eticheta butonului „nu mai întreba" din notificarea de diff
const NO_ASK_LABEL = 'Accept (don\'t ask again)';

// v1.7.1: verbose mode — pașii AI afișați în chat (persistat în globalState)
const VERBOSE_KEY = 'aiBridge.verboseMode';

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
const CHECKPOINTS_KEY = 'aiBridge.checkpoints';
const CHECKPOINTS_MAX = 50;

// v1.9.0: id-uri sigure de mesaj (leagă mesajul de checkpoint / conversație)
const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
  public static readonly viewType = 'aiBridge.chatView';
  private view?: vscode.WebviewView;
  private abortRequested = false;
  private abortController?: AbortController;
  /** FAZA I: providerul + pagina folosite acum (pentru Stop / auto-reparare). */
  private active?: { provider: AIProvider; page?: Page };
  /** FAZA II (A): atașamentele curente (chip-urile din UI). */
  private attachments: Attachment[] = [];
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
  };
  /** v1.3.0: snapshot-uri pre-editare pentru rollback-ul automat. */
  private edits = new EditRollback();
  /** v1.3.0: câte auto-repair-uri am cerut pentru seria curentă de verificări eșuate. */
  private verifyRepairs = 0;
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
    // v1.7.3: oprește captarea audio dacă view-ul e distrus (fără finalizare)
    view.onDidDispose(() => {
      const cap = this.voiceCapture;
      this.voiceCapture = null;
      if (cap) void cap.abort();
    });
  }

  private post(type: string, text: string) {
    this.view?.webview.postMessage({ type, text });
  }

  /** v1.1.0: notice public — alte module (ex: managerul MCP) scriu în chat. */
  postNotice(text: string) {
    this.post('notice', text);
  }

  /** v1.6.0: limba voice input (butonul 🎤) — din setarea aiBridge.sttLanguage. */
  private sttLanguage(): string {
    const v = vscode.workspace
      .getConfiguration('aiBridge')
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

  /** Thinking-ul raportat de provider (AIProvider.onThinking). */
  private handleModelThinking(text: string): void {
    const clean = String(text || '').trim();
    if (!clean || !this.verboseEnabled()) return;
    if (!this.verboseThinkId) this.verboseThinkId = 'think' + ++this.verboseSeq;
    this.postVerboseStep({
      kind: 'thinking',
      id: this.verboseThinkId,
      title: 'Model thinking',
      text: clean.length > 6000 ? clean.slice(0, 6000) + '\n… (truncated)' : clean,
      status: 'done',
      append: true
    });
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
        .getConfiguration('aiBridge')
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
    if (msg.type === 'set_provider') {
      const id = PROVIDER_IDS.includes(msg.value)
        ? String(msg.value)
        : 'deepseek';
      await vscode.workspace
        .getConfiguration('aiBridge')
        .update('provider', id, vscode.ConfigurationTarget.Global);
      // v0.4.0: reține ultimul provider web — lanțul Auto îl încearcă primul
      if (BROWSER_PROVIDER_IDS.includes(id)) {
        await this.state.update(LAST_BROWSER_KEY, id);
      }
      log('provider set to ' + id);
      void this.refreshProviderStatus();
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
      await this.state.update(HISTORY_KEY, []);
      await this.conversations.clearActive();
      this.attachments = [];
      this.postAttachments();
      this.postConversations();
      log('history cleared');
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
      }
      // v1.9.0: lista de conversații (dropdown-ul de comutare)
      this.postConversations();
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
      await this.handleDeleteConversation();
      return;
    }

    if (msg.type !== 'send') return;
    const userText: string = msg.text;
    // v1.4.0: id-ul mesajului (generat de webview) → leagă mesajul de checkpoint
    const msgId =
      typeof msg.msgId === 'string' && MSG_ID_RE.test(msg.msgId)
        ? msg.msgId
        : 'auto' + Date.now().toString(36);
    log('user message: ' + userText.slice(0, 60));

    // v0.3.0 (P0.4): refuză execuția în workspace-uri neîncrezute
    // (extensia scrie fișiere și rulează comenzi — nu e sigur în modul restrict)
    if (!vscode.workspace.isTrusted) {
      this.post(
        'error',
        'Untrusted workspace: AI Bridge can write files and run commands. ' +
          'Enable Workspace Trust for this folder ("Manage Workspace Trust"), then try again.'
      );
      return;
    }

    // v1.9.0: prima conversație din sesiune se creează automat (titlul = promptul)
    if (!this.conversations.getActive()) {
      await this.conversations.create(userText.slice(0, 40));
      this.postConversations();
    }
    // FAZA E: salvăm mesajul utilizatorului în istoric (NU se trimite la AI)
    await this.appendHistory('user', userText, msgId);
    // v1.9.0: primul prompt al unei conversații „Conversație nouă” o redenumește
    if (await this.conversations.retitleDefault(userText)) this.postConversations();

    // FAZA II (A): consumă atașamentele curente (se trimit o singură dată)
    const atts = this.attachments;
    this.attachments = [];
    this.postAttachments();

    this.abortRequested = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // v0.2.1: contorul anti-spam al scrierilor se resetează la fiecare mesaj
    resetWriteLimits();
    // v0.6.0: contoarele de încercări per comandă (auto-healing) se resetează
    resetCommandLimits();
    // v1.7.1: cardul „Thinking" se resetează la fiecare mesaj
    this.verboseThinkId = undefined;
    // v1.3.0: starea de auto-verify/rollback se resetează la fiecare mesaj
    this.resetVerifyState();

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error('You have no folder open in VS Code.');

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
          (mcpSection ? '\n\n---\n' + mcpSection : '') +
          contextBlock
        );
      };

      // FAZA III (E): progres vizibil — textul parțial al răspunsului
      const onProgress = (partial: string) => this.post('stream', partial);
      const onNotice = (text: string) => this.post('notice', text);

      // v0.3.0 (P0.6): buget TOTAL de timp per mesaj (implicit 20 min)
      const timeoutMinutes = Math.max(
        1,
        Number(
          vscode.workspace
            .getConfiguration('aiBridge')
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
            const reason = e?.message ? String(e.message) : String(e);
            log('auto: ' + id + ' failed — ' + reason);
            if (i === chain.length - 1) {
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
      // v1.3.0: mesajul final de rollback (auto-repair eșuat definitiv)
      let verifyRollbackText = '';
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
        const mcpResult = await mcp.executeToolCall(toolCall, approve, log);
        const result: ToolResult =
          mcpResult ?? (await executeTool(toolCall, root, log, approve));
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

        // v1.3.0 — AUTO-VERIFY + AUTO-REPAIR după fiecare scriere de fișiere:
        // proiectul e verificat pe loc (astro check / tsc / build); la eșec,
        // eroarea completă merge înapoi la AI (max MAX_VERIFY_REPAIRS
        // auto-repair-uri); dacă nici așa nu trece → rollback automat.
        let verifySuffix = '';
        if (
          AUTO_VERIFY_TOOLS.has(toolCall.tool) &&
          !this.abortRequested &&
          (result.ok || (result.error ?? '').startsWith('Written '))
        ) {
          const v = await this.autoVerify(root);
          verifySuffix = v.suffix;
          if (v.rollbackText) verifyRollbackText = v.rollbackText;
        }
        if (verifyRollbackText || this.abortRequested) break;

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
          resultMessage + selfFix + verifySuffix,
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
        if (this.autoVerifyEnabled() && this.verifyRepairs > 0 && lvf) {
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
      } else {
        log('error: ' + (e?.message ?? String(e)));
        this.post('error', e?.message ?? String(e));
      }
    } finally {
      this.abortController = undefined;
      this.active = undefined;
      // v0.4.0: badge-ul de status reflectă realitatea după fiecare mesaj
      void this.refreshProviderStatus();
    }
  }

  private currentProviderId(): string {
    const id = vscode.workspace
      .getConfiguration('aiBridge')
      .get<string>('provider');
    return id && PROVIDER_IDS.includes(id) ? id : 'deepseek';
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
   * v1.3.0 — AUTO-VERIFY + AUTO-REPAIR (după fiecare edit de fișiere)
   * Proiectul e verificat automat după fiecare write_file / edit_file /
   * write_files (astro check / tsc --noEmit / build — vezi verifier.ts).
   * La eșec, eroarea completă merge înapoi la AI pentru auto-repair (max
   * MAX_VERIFY_REPAIRS încercări); dacă verificarea tot cade, modificările
   * sunt anulate automat (rollback la ultima stare verificată OK).
   * ==================================================================== */

  /** Setarea aiBridge.autoVerify (implicit ON). */
  private autoVerifyEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('aiBridge')
        .get<boolean>('autoVerify', true) !== false
    );
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
    if (!this.autoVerifyEnabled()) return { suffix: '', rollbackText: '' };

    const vres = await runVerification(root);
    if (!vres.command) {
      log('auto-verify: no verification detected — skipping');
      return { suffix: '', rollbackText: '' };
    }
    const seconds = (vres.duration / 1000).toFixed(1);

    if (vres.ok) {
      // checkpoint: starea actuală = ultima stare verificată OK (ținta rollback)
      this.edits.markGood();
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
   * Anulează modificările (rollback la ultima stare verificată OK sau la
   * starea de dinainte de mesaj) + notifică utilizatorul; întoarce mesajul
   * final afișat în chat.
   */
  private doRollback(
    root: string,
    reason: string,
    command: string,
    output: string,
    seconds: string
  ): string {
    const rb = this.edits.rollback();
    const rel = (p: string) => {
      const r = path.relative(root, p);
      return r && !r.startsWith('..') ? r : p;
    };
    const lines: string[] = [];
    for (const p of rb.restored) {
      lines.push('- ↩ `' + rel(p) + '` — restored to the verified version');
    }
    for (const p of rb.deleted) {
      lines.push('- 🗑 `' + rel(p) + '` — new file, deleted');
    }
    for (const f of rb.failed) {
      lines.push('- ⚠️ `' + rel(f.abs) + '` — rollback failed: ' + f.error);
    }
    const list = lines.length
      ? lines.join('\n')
      : '- (nothing to roll back — the files were already in a good state)';
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
      'AI Bridge: verification "' + command + '" failed — ' + reason +
        '; changes were rolled back automatically.'
    );
    this.verifyRepairs = 0;
    this.lastVerifyFailure = undefined;

    return (
      '⛔ **Auto-verify: "' + command + '" failed — ' + reason +
      '; an automatic rollback was performed.**\n\n' +
      'What was rolled back:\n' + list + '\n\n' +
      'The project is back to the last state that passed verification. Last error (' +
      seconds + 's):\n\n' +
      '```\n' + output.trim().slice(0, 1500) + '\n```\n\n' +
      'You can try again, possibly with smaller steps or more specific instructions.'
    );
  }

  /* ======================================================================
   * v1.4.0 — CHECKPOINT GIT PER PROMPT + RESTORE CU UN CLICK
   * Înainte de fiecare mesaj se creează un commit de checkpoint
   * („aibridge-prompt:<id>”), persistat în globalState împreună cu id-ul
   * mesajului; butonul ⟲ din chat cheamă restoreToCheckpoint (git reset
   * --hard), cu backup automat al stării curente înainte de reset.
   * ==================================================================== */

  /** Setarea aiBridge.promptCheckpoints (implicit ON). */
  private checkpointsEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('aiBridge')
        .get<boolean>('promptCheckpoints', true) !== false
    );
  }

  /** v1.5.0: setarea aiBridge.autoInitGit (implicit ON). */
  private autoInitGitEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('aiBridge')
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
            'You can turn this off with the aiBridge.autoInitGit setting.'
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
      vscode.window.showInformationMessage('AI Bridge: checkpoint restored.');
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
        'AI Bridge: restore failed — ' + (res.error ?? 'unknown error')
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

  /** v1.9.0: migrează o singură dată istoricul legacy (aiBridge.history) într-o conversație. */
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

  /** v1.9.0: șterge conversația activă (cu confirmare nativă). */
  private async handleDeleteConversation(): Promise<void> {
    if (this.abortController) {
      this.post('notice', '⏳ Stop the current response first (Stop), then delete the conversation.');
      this.postConversations();
      return;
    }
    const active = this.conversations.getActive();
    if (!active) {
      this.post('notice', 'ℹ️ There is no conversation to delete.');
      this.postConversations();
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      '🗑 Delete the conversation "' + active.title + '"? (' + active.messages.length +
        ' messages — the action cannot be undone; git checkpoints stay in their history.)',
      { modal: true },
      'Delete'
    );
    if (pick !== 'Delete') {
      this.postConversations();
      return;
    }
    await this.conversations.deleteConversation(active.id);
    log('conversation deleted: ' + active.id);
    this.post('heal', '🗑 The conversation "' + active.title + '" was deleted.');
    this.postConversations();
    this.rerenderActive();
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
      vscode.window.showInformationMessage('AI Bridge: ' + res.message);
    } else {
      this.post('notice', '⚠️ ' + res.message);
      vscode.window.showWarningMessage('AI Bridge: ' + res.message);
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
    } catch (e: any) {
      log('status refresh failed: ' + (e?.message ?? String(e)));
    } finally {
      this.statusInFlight = false;
    }
  }

  /** v0.4.0: raport detaliat (comanda "Show Provider Status" + click pe badge). */
  async showProviderStatusReport(): Promise<void> {
    const info = await getProviderStatus();
    const selected = this.currentProviderId();
    const cfg = vscode.workspace.getConfiguration('aiBridge');
    const activeModel = cfg.get<string>('ollamaModel', 'qwen2.5-coder:7b');

    const lines: string[] = [];
    lines.push(
      '===== AI Bridge — Provider Status — ' + new Date().toLocaleString() + ' ====='
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
      lines.push('  (start Ollama with "ollama serve" for local mode)');
    }
    // v1.1.0: starea serverelor MCP + numărul de unelte expuse
    lines.push(...mcp.statusLines());
    lines.push('Recommendation: ' + this.statusRecommendation(selected, info));

    for (const line of lines) logLine('status', line);
    initLogChannel().show(true);
    this.post('notice', lines.join('\n'));
    vscode.window.showInformationMessage(
      'AI Bridge: provider status written to Output → AI Bridge (see also the chat).'
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

  /** Comanda `aiBridge.clearNoAsk`: golește lista „nu mai întreba". */
  async clearNoAskFiles(): Promise<void> {
    const files = this.getNoAskFiles();
    await this.state.update(NO_ASK_KEY, []);
    log('no-ask list cleared (' + files.length + ' entries)');
    if (files.length) {
      vscode.window.showInformationMessage(
        'AI Bridge: the "don\'t ask again" list was cleared (' +
          files.length +
          ' files).'
      );
    } else {
      vscode.window.showInformationMessage(
        'AI Bridge: the "don\'t ask again" list was already empty.'
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
    const tmpDir = path.join(os.tmpdir(), 'ai-bridge-review');
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
      ? 'AI Bridge: ' + toolName + ' → ' + changes[0].label
      : 'AI Bridge: ' + toolName + ' → ' + changes.length + ' files';
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
      const payload = {
        id: reviewId,
        tool: toolName,
        target,
        preview: buildReviewPreview(changes)
      };
      this.pendingInlineReview = { id: reviewId, resolve: resolveInline };
      this.pendingInlineReviewPayload = payload;
      this.view.webview.postMessage({ type: 'diff_review', ...payload });
      inlineShown = true;
      log('diff review: inline card sent to chat (id ' + reviewId + ')');
    }

    // 3) întreabă utilizatorul (butoane nativ VS Code, în bara de jos)
    const msg = single
      ? 'AI Bridge: ' +
        toolName +
        ' wants to write ' +
        changes[0].label +
        ' — the diff is open in the editor.'
      : 'AI Bridge: ' +
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

    // v1.2.1: anunță cardul din chat despre decizia finală (oricare cale a
    // câștigat-o) — butoanele sunt înlocuite de statusul rezolvat
    if (inlineShown) {
      this.view?.webview.postMessage({
        type: 'diff_review_done',
        id: reviewId,
        decision,
        via
      });
    }

    return decision;
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

  private parseToolCall(text: string): ToolCall | null {
    const trimmed = text.trim();
    let clean = trimmed;
    if (clean.startsWith('```')) {
      clean = clean
        .replace(/^```(?:json)?\s*\n?/, '')
        .replace(/\n?```\s*$/, '');
    }
    if (!clean.startsWith('{') || !clean.endsWith('}')) return null;

    try {
      const parsed = JSON.parse(clean);
      return this.normalizeToolCall(parsed);
    } catch {
      // Modelul poate omite escape-ul ghilimelelor din valorile string.
    }

    const repaired = this.repairJsonQuotes(clean);
    try {
      const parsed = JSON.parse(repaired);
      return this.normalizeToolCall(parsed);
    } catch {
      // Încearcă să recupereze obiectul tool call dintr-un răspuns mai larg.
    }

    const match = clean.match(/\{\s*"tool"\s*:[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(this.repairJsonQuotes(match[0]));
        return this.normalizeToolCall(parsed);
      } catch {
        // Răspunsul nu poate fi recuperat ca tool call valid.
      }
    }

    return null;
  }

  private normalizeToolCall(parsed: any): ToolCall | null {
    if (!parsed || typeof parsed.tool !== 'string') return null;

    if (parsed.args && typeof parsed.args === 'object') {
      return { tool: parsed.tool, args: parsed.args };
    }

    if (typeof parsed.action === 'string') {
      const { tool, action, ...rest } = parsed;
      return { tool: `${tool}_${action}`, args: rest };
    }

    return { tool: parsed.tool, args: {} };
  }

  private repairJsonQuotes(json: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
      const char = json[i];

      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }

      if (char === '\\') {
        result += char;
        escaped = true;
        continue;
      }

      if (char === '"') {
        if (!inString) {
          inString = true;
          result += char;
        } else {
          const nextNonSpace = json.slice(i + 1).match(/\S/)?.[0];
          if (
            nextNonSpace === ':' ||
            nextNonSpace === ',' ||
            nextNonSpace === '}' ||
            nextNonSpace === ']' ||
            nextNonSpace === undefined
          ) {
            inString = false;
            result += char;
          } else {
            result += '\\"';
          }
        }
        continue;
      }

      result += char;
    }

    return result;
  }

  private getHtml(webview: vscode.Webview): string {
    const toUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', file)
      );

    const jsUri = toUri('chat.js');
    const cssUri = toUri('chat.css');
    const markedUri = toUri('marked.min.js');
    const purifyUri = toUri('purify.min.js');

    const providerOptions = Object.entries(PROVIDER_LABELS)
      .map(([id, label]) => `<option value="${id}">${label}</option>`)
      .join('');

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};"/>
<link rel="stylesheet" href="${cssUri}"/>
</head><body>
<div id="toolbar">
  <select id="provider" title="AI Provider">${providerOptions}</select>
  <span id="status-badge" class="status-badge" title="Checking provider status...">⚪</span>
  <label class="auto-approve-toggle" id="auto-approve-toggle" title="Auto-approve: when checked, write_file / edit_file / run_command / git are approved automatically, without confirmation cards">
    <input type="checkbox" id="auto-approve"/>
    <span>⚡ Auto</span>
  </label>
  <button id="verbose-toggle" title="Verbose mode: shows every AI step in the chat (Thinking / Executing / Result / Decision)"></button>
  <button id="stop" title="Stop the response" hidden>
    <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>
  </button>
  <button id="show-chrome" title="Show the Chrome window (web providers)"></button>
  <button id="clear" title="Clear the chat"></button>
</div>
<div id="conv-bar">
  <select id="conversation" title="Conversations — switch between them (old ones stay in the list)"></select>
  <button id="conv-new" title="New conversation (the current one stays in the list)"></button>
  <button id="conv-delete" title="Delete the current conversation from the list"></button>
</div>
<div id="messages"></div>
<button id="jump" title="Jump to the latest" hidden>
  <svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8.53 13.03a.75.75 0 0 1-1.06 0l-5-5a.75.75 0 1 1 1.06-1.06L7.25 10.69V3.75a.75.75 0 0 1 1.5 0v6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-5 5Z"/></svg>
</button>
<div id="input-area">
  <div id="attachments" hidden></div>
  <div id="input-wrapper">
    <textarea id="input" rows="1" placeholder="Type a message..."></textarea>
    <button id="attach-file" title="Attach files"></button>
    <button id="attach-folder" title="Attach folders"></button>
    <button id="mic-btn" title="Speak (capture runs in the extension + local Whisper)"></button>
    <button id="send" title="Send (Enter)"></button>
  </div>
</div>
<script src="${markedUri}"></script>
<script src="${purifyUri}"></script>
<script src="${jsUri}"></script>
</body></html>`;
  }
}