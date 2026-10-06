import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { logLine } from './log';

const log = (msg: string) => logLine('stt', msg);

/* =========================================================================
 * v1.7.2 — VOICE INPUT CU WHISPER LOCAL (offline)
 * Webview-ul înregistrează audio (MediaRecorder), îl convertește în WAV
 * 16 kHz mono (în pagină) și îl trimite aici (base64); modulul salvează
 * fișierul în temp și îl transcrie cu whisper.cpp (CLI) — 100% offline,
 * fără servicii Google (Web Speech API nu funcționează în Electron).
 *
 * De ce whisper.cpp direct (nu nodejs-whisper): nodejs-whisper construiește
 * whisper.cpp prin CMake la runtime (necesită toolchain de build); folosim
 * binarele prebuilt oficiale ale ACELUIAȘI motor + modelul ggml, descărcate
 * o singură dată în globalStorage (comanda „Freekit: Setup Local Whisper”).
 * ========================================================================= */

/** Asset-uri pinnuite (release stabil whisper.cpp v1.9.2, build BLAS x64). */
export const WHISPER_BIN_ZIP_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-blas-bin-x64.zip';
export const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

/** Subfolderul din globalStorage care găzduiește binarele + modelele. */
export const WHISPER_DIR_NAME = 'whisper';

export interface WhisperAssets {
  ok: boolean;
  cliPath?: string;
  modelPath?: string;
  source?: string;
  error?: string;
  hints: string[];
}

export interface SttResult {
  ok: boolean;
  text?: string;
  error?: string;
  engine?: string;
  seconds?: number;
  hints?: string[];
}

/** Limba setării freekit.sttLanguage → codul whisper.cpp. */
export function mapSttLanguage(value: string): string {
  const v = String(value || '').toLowerCase();
  if (v.startsWith('ro')) return 'ro';
  if (v.startsWith('en')) return 'en';
  if (v.startsWith('auto')) return 'auto';
  return 'en';
}

/** Curăță transcrierea: fără markeri de tăcere, spații colapsate. */
export function cleanTranscript(text: string): string {
  return String(text || '')
    .replace(/\[(BLANK_AUDIO|SILENCE|MUSIC|SOUND)\]/gi, ' ')
    .replace(/\((?:silence|muzică|music)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function existsFile(p?: string): boolean {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Caută recursiv un executabil sub un director (adâncime limitată). */
export function findExecutable(
  dir: string,
  name: string,
  depth = 4
): string | undefined {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  // întâi fișierele (potrivirea de la nivelul curent câștigă)
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) {
      return path.join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findExecutable(path.join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Primul element existent dintr-o listă de căi candidate. */
function firstExisting(cands: Array<string | undefined>): string | undefined {
  for (const c of cands) {
    if (existsFile(c)) return c;
  }
  return undefined;
}

/** Modele ggml-*.bin dintr-un director (base are prioritate, apoi small/tiny). */
function findModelIn(dir: string): string | undefined {
  try {
    const bins = fs
      .readdirSync(dir)
      .filter((f) => /^ggml-.*\.bin$/i.test(f))
      .sort((a, b) => {
        const pri = (n: string) =>
          n.includes('base') ? 0 : n.includes('small') ? 1 : n.includes('tiny') ? 2 : 3;
        return pri(a) - pri(b);
      });
    if (bins.length) return path.join(dir, bins[0]);
  } catch {
    /* director inexistent */
  }
  return undefined;
}

/** Caută un executabil în PATH (`where` pe Windows, `which` pe Unix). */
async function whichLookup(name: string): Promise<string | undefined> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [name], { windowsHide: true });
      let out = '';
      child.stdout?.on('data', (d) => (out += String(d)));
      child.on('error', () => resolve(undefined));
      child.on('close', (code) => {
        if (code !== 0) return resolve(undefined);
        const first = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)[0];
        resolve(first && existsFile(first) ? first : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Rezolvă perechea CLI + model:
 * setări → globalStorage/whisper (setup) → locații whisper.cpp uzuale → PATH.
 */
export async function resolveWhisper(
  globalStorageRoot: string
): Promise<WhisperAssets> {
  const cfg = vscode.workspace.getConfiguration('freekit');
  const cliSetting = String(cfg.get<string>('whisperCliPath', '') || '').trim();
  const modelSetting = String(cfg.get<string>('whisperModelPath', '') || '').trim();

  const wsDir = path.join(globalStorageRoot, WHISPER_DIR_NAME);
  const home = os.homedir();
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const isWin = process.platform === 'win32';

  const cliCandidates: Array<string | undefined> = [
    cliSetting || undefined,
    findExecutable(path.join(wsDir, 'bin'), exe),
    ...(isWin
      ? [
          path.join(home, 'whisper.cpp', 'build', 'bin', 'Release', exe),
          path.join(home, 'whisper.cpp', 'build', 'bin', exe),
          path.join('C:\\', 'whisper.cpp', 'build', 'bin', 'Release', exe),
          path.join('C:\\', 'whisper.cpp', 'build', 'bin', exe)
        ]
      : [
          path.join(home, 'whisper.cpp', 'build', 'bin', exe),
          path.join('/usr/local/bin', exe),
          path.join('/usr/bin', exe)
        ])
  ];

  let cliPath = firstExisting(cliCandidates);
  let source =
    cliSetting && cliPath === cliSetting
      ? 'setarea freekit.whisperCliPath'
      : 'detectat automat';
  if (!cliPath) {
    const fromPath = await whichLookup('whisper-cli');
    if (fromPath) {
      cliPath = fromPath;
      source = 'PATH';
    }
  }

  const cliDir = cliPath ? path.dirname(cliPath) : '';
  const modelCandidates: Array<string | undefined> = [
    modelSetting || undefined,
    findModelIn(path.join(wsDir, 'models')),
    cliDir ? findModelIn(path.join(cliDir, 'models')) : undefined,
    cliDir ? findModelIn(cliDir) : undefined,
    findModelIn(path.join(home, 'whisper.cpp', 'models')),
    isWin ? findModelIn('C:\\whisper.cpp\\models') : undefined
  ];
  const modelPath = firstExisting(modelCandidates);

  if (!cliPath || !modelPath) {
    const hints: string[] = [
      'Run the "Freekit: Setup Local Whisper" command (downloads whisper.cpp + the ggml-base model once, ~160 MB).',
      'Or set freekit.whisperCliPath and freekit.whisperModelPath manually.'
    ];
    if (!cliPath) {
      return { ok: false, error: 'Whisper CLI (whisper-cli) was not found.', hints };
    }
    return { ok: false, error: 'The Whisper ggml model was not found.', hints };
  }
  log('rezolvat: cli=' + cliPath + ' (' + source + '), model=' + modelPath);
  return { ok: true, cliPath, modelPath, source, hints: [] };
}

/** Descarcă un URL într-un fișier (fetch cu progres; urmează redirectările). */
async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (pct: number, label: string) => void,
  label = ''
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error('HTTP ' + res.status + ' for ' + url);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const st = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let lastPct = -5;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      got += value.byteLength;
      if (!st.write(Buffer.from(value))) {
        await new Promise<void>((r) => st.once('drain', () => r()));
      }
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (onProgress && pct >= lastPct + 5) {
        lastPct = pct;
        onProgress(pct, label);
      }
    }
  } finally {
    await new Promise<void>((resolve) => st.end(() => resolve()));
  }
  if (total && got < total) {
    throw new Error('Incomplete download (' + got + '/' + total + ' bytes).');
  }
}

/** Extrage un zip (Expand-Archive pe Windows, unzip pe Unix). */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'powershell' : 'unzip';
  const esc = (s: string) => s.replace(/'/g, "''");
  const args = isWin
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`
      ]
    : ['-o', zipPath, '-d', destDir];
  await new Promise<void>((resolve, reject) => {
    const ch = spawn(cmd, args, { windowsHide: true });
    let err = '';
    ch.stderr?.on('data', (d) => (err += String(d)));
    ch.on('error', reject);
    ch.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              'Zip extraction failed (code ' + code + ')' +
                (err ? ': ' + err.trim().slice(-300) : '')
            )
          )
    );
  });
}

/**
 * Setup o singură dată: descarcă binarele whisper.cpp + modelul ggml-base în
 * globalStorage (sare peste ce există deja). Folosit de comanda dedicată.
 */
export async function setupWhisperAssets(
  globalStorageRoot: string,
  onProgress?: (pct: number, label: string) => void
): Promise<WhisperAssets & { downloaded: boolean }> {
  const wsDir = path.join(globalStorageRoot, WHISPER_DIR_NAME);
  const binDir = path.join(wsDir, 'bin');
  const modelsDir = path.join(wsDir, 'models');
  let downloaded = false;
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(modelsDir, { recursive: true });

    const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
    if (!findExecutable(binDir, exe)) {
      log('setup: descarc binarele whisper.cpp...');
      const zipPath = path.join(binDir, 'whisper-bin.zip');
      await downloadFile(WHISPER_BIN_ZIP_URL, zipPath, onProgress, 'whisper.cpp binaries');
      await extractZip(zipPath, binDir);
      try {
        fs.unlinkSync(zipPath);
      } catch {
        /* curățarea e best-effort */
      }
    } else {
      log('setup: binarele există deja — sar peste descărcare');
    }

    const modelFile = path.join(modelsDir, 'ggml-base.bin');
    if (!existsFile(modelFile) || fs.statSync(modelFile).size < 10 * 1024 * 1024) {
      log('setup: descarc modelul ggml-base.bin...');
      await downloadFile(WHISPER_MODEL_URL, modelFile, onProgress, 'ggml-base model');
    } else {
      log('setup: modelul există deja — sar peste descărcare');
    }

    downloaded = true;
    const res = await resolveWhisper(globalStorageRoot);
    log('setup: ' + (res.ok ? 'OK (' + res.cliPath + ')' : 'eșec — ' + res.error));
    return { ...res, downloaded };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log('setup: eroare — ' + msg);
    return {
      ok: false,
      error: 'Whisper setup failed: ' + msg,
      hints: [],
      downloaded
    };
  }
}

/**
 * Transcrie un fișier audio (ideal WAV 16 kHz mono) cu whisper.cpp local.
 * Nu aruncă niciodată pentru erori de engine — întoarce { ok:false, error }.
 */
export async function transcribeAudioFile(
  audioFile: string,
  opts: { globalStorageRoot: string; language: string; timeoutMs?: number }
): Promise<SttResult> {
  const assets = await resolveWhisper(opts.globalStorageRoot);
  if (!assets.ok || !assets.cliPath || !assets.modelPath) {
    return {
      ok: false,
      error: assets.error ?? 'Whisper is unavailable.',
      hints: assets.hints
    };
  }
  const cliPath = assets.cliPath;
  const modelPath = assets.modelPath;
  const timeoutMs = Math.max(10_000, opts.timeoutMs ?? 180_000);
  const lang = mapSttLanguage(opts.language);

  const dir = path.join(os.tmpdir(), 'freekit-stt');
  fs.mkdirSync(dir, { recursive: true });
  const outBase = path.join(
    dir,
    'out-' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
  );
  const args = [
    '-m',
    modelPath,
    '-f',
    audioFile,
    '-l',
    lang,
    '-otxt',
    '-of',
    outBase,
    '-np'
  ];

  log(
    'transcriu (' + lang + '): ' + path.basename(audioFile) +
      ' → ' + path.basename(cliPath)
  );
  const started = Date.now();
  const res = await new Promise<{ code: number | null; stderr: string; killed: boolean }>(
    (resolve) => {
      const ch = spawn(cliPath, args, {
        cwd: path.dirname(cliPath),
        windowsHide: true
      });
      let stderr = '';
      ch.stderr?.on('data', (d) => (stderr += String(d)));
      ch.stdout?.on('data', () => {
        /* logs de progres — ignorate */
      });
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try {
          ch.kill();
        } catch {
          /* procesul poate fi deja încheiat */
        }
      }, timeoutMs);
      ch.on('error', (e: any) => {
        clearTimeout(timer);
        resolve({ code: -1, stderr: String(e?.message ?? e), killed });
      });
      ch.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, killed });
      });
    }
  );
  const seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;

  let text = '';
  try {
    text = fs.readFileSync(outBase + '.txt', 'utf8');
  } catch {
    /* fără fișier de output */
  }
  try {
    fs.unlinkSync(outBase + '.txt');
  } catch {
    /* curățarea e best-effort */
  }

  if (res.killed) {
    return {
      ok: false,
      error:
        'Transcription exceeded ' + Math.round(timeoutMs / 1000) + 's (timeout).',
      hints: []
    };
  }
  if (res.code !== 0) {
    const tail = res.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
    return {
      ok: false,
      error:
        'whisper-cli exited with code ' + res.code + (tail ? ': ' + tail : ''),
      hints: []
    };
  }

  const clean = cleanTranscript(text);
  log('transcriere gata în ' + seconds + 's: „' + clean.slice(0, 80) + '”');
  return {
    ok: true,
    text: clean,
    engine: 'whisper.cpp (' + path.basename(modelPath) + ')',
    seconds
  };
}
