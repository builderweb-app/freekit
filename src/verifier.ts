import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { logLine } from './log';
import { clipPayload } from './payload';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const log = (msg: string) => logLine('verify', msg);

/* =========================================================================
 * v1.3.0 — AUTO-VERIFY + AUTO-REPAIR
 * După fiecare edit_file / write_file / write_files, chatView rulează
 * verificarea proiectului cu ajutorul acestui modul: detectează ce comandă
 * de verificare are sens (astro check / tsc --noEmit / build / typecheck /
 * lint) și o execută. La eșec, output-ul complet e trimis înapoi AI-ului
 * pentru auto-repair (vezi chatView.ts).
 *
 * Modulul folosește DOAR Node API (fs / child_process) — fără `vscode` —
 * ca să fie testabil și în afara procesului VS Code.
 * ========================================================================= */

export interface VerifyResult {
  ok: boolean;
  output: string;
  command: string;
  duration: number;
  /**
   * v2.5.31 (bug #72): folderul din care a rulat verificarea (diferă de root
   * când scope-ul task-ului are propriul tsconfig.json). chatView îl folosește
   * ca să nu mai adauge hint-ul „tsc din root ignoră configul din subfolder".
   */
  cwd?: string;
}

/**
 * v2.5.31 (bug #72): opțiuni de rulare a verificării.
 */
export interface VerifyOptions {
  /**
   * Folderul din care se rulează `tsc`. Când scope-ul task-ului are propriul
   * tsconfig.json, tsc TREBUIE rulat de acolo: din root, tsc citește
   * tsconfig.json din root și ignoră complet configul din subfolder (modelul
   * edita la infinit `bootcamp-test/tsconfig.json`, fără niciun efect).
   */
  cwd?: string;
}

export interface ProjectType {
  /** 'astro', 'next', 'vite', 'node', 'unknown' */
  type: string;
  /** 'npm', 'pnpm', 'yarn' */
  packageManager: string;
  /** scriptul de verificare: 'astro check', 'tsc --noEmit', 'build', ... */
  checkScript: string;
}

export const VERIFY_TIMEOUT_MS = 120000;
const VERIFY_OUTPUT_MAX = 10000;

/**
 * Alege comanda de verificare potrivită pentru proiect:
 *  - Astro (cu @astrojs/check instalat) → `astro check`
 *  - Next / Vite / orice proiect cu tsconfig + TypeScript → `tsc --noEmit`
 *  - altfel scriptul `typecheck` / `build` / `lint` din package.json
 * Întoarce null dacă nu există package.json sau nicio verificare posibilă.
 */
export async function detectVerificationCommand(
  root: string
): Promise<ProjectType | null> {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    log('package.json invalid — verificarea nu poate fi detectată');
    return null;
  }
  const scripts: Record<string, unknown> =
    (pkg && typeof pkg.scripts === 'object' && pkg.scripts) || {};
  const deps: Record<string, unknown> = {
    ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg?.devDependencies as Record<string, unknown>) ?? {})
  };

  // package manager din lockfile
  let pm = 'npm';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) pm = 'pnpm';
  else if (fs.existsSync(path.join(root, 'yarn.lock'))) pm = 'yarn';

  const hasTsconfig = fs.existsSync(path.join(root, 'tsconfig.json'));
  const haveTsc =
    !!deps.typescript ||
    fs.existsSync(path.join(root, 'node_modules', 'typescript'));

  let type = 'node';
  let checkScript = '';

  // 1) Astro — `astro check` e cel mai rapid, dar are nevoie de @astrojs/check
  if (deps.astro) {
    type = 'astro';
    if (deps['@astrojs/check']) checkScript = 'astro check';
  }

  // 2) Next / Vite — type-check rapid cu tsc (când TypeScript există)
  if (!checkScript && deps.next) {
    type = 'next';
    if (hasTsconfig && haveTsc) checkScript = 'tsc --noEmit';
  }
  if (
    !checkScript &&
    (deps.vite || deps['@vitejs/plugin-react'])
  ) {
    type = 'vite';
    if (hasTsconfig && haveTsc) checkScript = 'tsc --noEmit';
  }

  // 3) tsconfig + TypeScript instalat → tsc --noEmit (rapid, fiabil)
  if (!checkScript && hasTsconfig && haveTsc) {
    checkScript = 'tsc --noEmit';
  }

  // 4) altfel scripturile proiectului (typecheck → build → lint)
  if (!checkScript && typeof scripts.typecheck === 'string') {
    checkScript = 'typecheck';
  }
  if (!checkScript && typeof scripts.build === 'string') {
    checkScript = 'build';
  }
  if (!checkScript && typeof scripts.lint === 'string') {
    checkScript = 'lint';
  }

  if (!checkScript) return null;

  return { type, packageManager: pm, checkScript };
}

/** Construiește linia de comandă pentru verificarea detectată. */
export function verifyCommandString(project: ProjectType): string {
  const pm = project.packageManager;
  const runBin = (bin: string, rest: string): string => {
    if (pm === 'yarn') return 'yarn ' + bin + rest; // yarn rezolvă binarele locale
    if (pm === 'pnpm') return 'pnpm exec ' + bin + rest;
    return 'npx ' + bin + rest;
  };
  if (project.checkScript === 'tsc --noEmit') return runBin('tsc', ' --noEmit');
  if (project.checkScript === 'astro check') return runBin('astro', ' check');
  return pm + ' run ' + project.checkScript;
}

/**
 * v2.5.31 (bug #72): binarul local `tsc` (din folderul dat sau din root) —
 * rulat cu `node`, ca `npx tsc` pornit din subfolder să nu instaleze pachetul
 * greșit și să folosească compilatorul proiectului.
 */
function resolveTscBin(fromDir: string, root: string): string | null {
  for (const base of [fromDir, root]) {
    const bin = path.join(base, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* ignoră */
    }
  }
  return null;
}

/**
 * Rulează verificarea proiectului. Întoarce mereu un VerifyResult —
 * `command` gol înseamnă „nicio verificare configurată” (ok: true, no-op).
 * v2.5.31 (bug #72): cu `opts.cwd` (scope-ul task-ului, care are propriul
 * tsconfig.json), `tsc --noEmit` rulează pentru configul din acel folder.
 * v2.5.32 (bug #77): detecția e AUTOMATĂ și explicită — când
 * `<scope>/tsconfig.json` există, comanda devine
 * `tsc --noEmit -p <scope>/tsconfig.json` (log: „using scoped tsconfig”).
 */
export async function runVerification(
  root: string,
  opts?: VerifyOptions
): Promise<VerifyResult> {
  const project = await detectVerificationCommand(root);
  if (!project) {
    log('nicio verificare configurată pentru acest proiect');
    return {
      ok: true,
      output: '(no verification configured)',
      command: '',
      duration: 0
    };
  }

  const command = verifyCommandString(project);
  const scopeCwd =
    opts?.cwd && path.resolve(opts.cwd) !== path.resolve(root)
      ? opts.cwd
      : undefined;

  // v2.5.32 FIX (bug #77): tsconfig.json propriu în folderul scope-ului →
  // verificarea folosește EXACT acel config (`-p`). Fără `-p`, tsc pornit din
  // root citește tsconfig.json din ROOT și ignoră complet configul din subfolder.
  const scopedPath =
    scopeCwd && project.checkScript === 'tsc --noEmit'
      ? path.join(scopeCwd, 'tsconfig.json')
      : null;
  const scoped =
    scopedPath && fs.existsSync(scopedPath) ? scopedPath : null;
  const scopedRel = scoped
    ? path.relative(root, scoped).replace(/\\/g, '/')
    : '';
  if (scoped) log('verify: using scoped tsconfig at ' + scopedRel);

  const tscBin = scoped ? resolveTscBin(scopeCwd as string, root) : null;
  if (scoped && !tscBin) {
    log(
      'tsc local negăsit pentru ' + (scopeCwd as string) +
        ' — folosesc ' + project.packageManager + ' cu configul din scope'
    );
  }
  const cwd = scoped ? (scopeCwd as string) : root;
  const label = scoped
    ? (tscBin
        ? 'node ' + path.relative(root, tscBin).replace(/\\/g, '/') +
          ' --noEmit -p ' + scopedRel
        : command + ' -p ' + scopedRel)
    : command;
  const start = Date.now();
  log('rulez verificarea: ' + label);

  try {
    const run =
      scoped && tscBin
        ? execFileAsync(process.execPath, [tscBin, '--noEmit', '-p', scoped], {
            cwd: root,
            timeout: VERIFY_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true
          })
        : execAsync(
            scoped ? command + ' -p "' + scoped + '"' : command,
            {
              cwd: root,
              timeout: VERIFY_TIMEOUT_MS,
              maxBuffer: 10 * 1024 * 1024,
              windowsHide: true
            }
          );
    const { stdout, stderr } = await run;
    // v2.5.23: cap+coadă — sumarul erorilor (tsc/build) e la finalul output-ului
    const output = clipPayload(
      String(stdout ?? '') + '\n' + String(stderr ?? ''),
      VERIFY_OUTPUT_MAX
    );
    const duration = Date.now() - start;
    log('verificare TRECUTĂ în ' + duration + 'ms (' + label + ')');
    return { ok: true, output, command: label, duration, cwd };
  } catch (e: any) {
    const output = clipPayload(
      String(e?.stdout ?? '') +
        '\n' +
        String(e?.stderr ?? '') +
        '\n' +
        (e?.message ?? String(e)),
      VERIFY_OUTPUT_MAX
    );
    const duration = Date.now() - start;
    log('verificare EȘUATĂ în ' + duration + 'ms (' + label + ')');
    return { ok: false, output, command: label, duration, cwd };
  }
}

/* =========================================================================
 * v2.5.29 FIX 4 (bug #67) — context la erorile de comandă (tsc / build)
 * Când o comandă de verificare eșuează (ex. `npx tsc --noEmit`), modelul
 * primește output-ul complet — dar de multe ori editează la nesfârșit același
 * fișier, deși eroarea e în ALT fișier sau în tsconfig. Aici detectăm, din
 * output, fișierele menționate și dacă eroarea e de configurare, ca să putem
 * adăuga un hint explicit înainte de a trimite eroarea AI-ului.
 * ========================================================================= */

/** `src/a.ts(12,5)` (tsc) sau `src/a.ts:12:5` (alte unelte). */
const ERROR_FILE_RE =
  /(?:^|[\s'"`(])([\w@.\-\\/]+\.[A-Za-z][\w]{0,5})(?:\(\d+\s*,\s*\d+\)|:\d+(?::\d+)?)/gm;

/** Cale normalizată pentru comparații (separatori uniformi, fără `./`). */
function normalizeErrorPath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^~\//, '')
    .trim()
    .toLowerCase();
}

/** Căile de fișier menționate de output-ul unei comenzi (unice, în ordine). */
export function commandErrorFiles(output: string): string[] {
  const text = String(output ?? '');
  const re = new RegExp(ERROR_FILE_RE.source, 'gm');
  const files: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = normalizeErrorPath(m[1]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    files.push(m[1]);
  }
  return files;
}

/** Eroarea pare de CONFIGURARE (tsconfig / include / exclude / rootDir)? */
export function looksLikeTsconfigError(output: string): boolean {
  const text = String(output ?? '');
  return (
    /tsconfig/i.test(text) ||
    /no inputs were found in config file/i.test(text) ||
    /rootdir/i.test(text) ||
    (/\binclude\b/i.test(text) && /\bexclude\b/i.test(text))
  );
}

/**
 * Blocul de hint-uri adăugat la eroarea unei comenzi trimise AI-ului:
 *  - eroarea e în ALT fișier decât cel editat ultima dată;
 *  - eroarea e de configurare → verifică include/exclude din tsconfig.json.
 *  - v2.5.32 (bug #76): TS6059 → tsconfig.json separat în subfolder, nu editarea
 *    la infinit a tsconfig.json din ROOT.
 * Întoarce '' când nu e nimic de adăugat (comportamentul de dinainte rămâne).
 */
export function buildCommandErrorHints(
  command: string,
  output: string,
  editedFile?: string,
  scope?: string[] | null
): string {
  const text = String(output ?? '');
  if (!text.trim()) return '';

  const hints: string[] = [];
  const edited = editedFile ? normalizeErrorPath(editedFile) : '';
  if (edited) {
    const others = commandErrorFiles(text).filter(
      (f) => normalizeErrorPath(f) !== edited
    );
    if (others.length) {
      hints.push(
        'The error is in ' + others[0] + ', not in the file you edited.'
      );
    }
  }
  if (looksLikeTs6059(text)) {
    // v2.5.32 FIX (bug #76): „Check tsconfig.json include/exclude" e un sfat
    // GREȘIT aici — omul edita root tsconfig.json la nesfârșit.
    hints.push(buildTs6059Hint(text, scope));
  } else if (looksLikeTsconfigError(text)) {
    hints.push('Check tsconfig.json include/exclude.');
  }

  if (!hints.length) return '';
  return '\n\nHINT from "' + command + '":\n- ' + hints.join('\n- ');
}

/* =========================================================================
 * v2.5.32 FIX (bug #76) — hint TS6059 (rootDir + subfolder)
 * `error TS6059: File 'C:/x/bootcamp-test/index.ts' is not under 'rootDir'
 * 'C:/x/src'.` înseamnă că tsc a folosit tsconfig.json din ROOT (are `rootDir`
 * setat) și a exclus fișierele din subfolder. Modelul „repara" asta editând la
 * infinit tsconfig.json din root (sau pe cel din subfolder, fără efect când
 * comanda pornește din root). Hint-ul spune fix ce trebuie făcut: tsconfig.json
 * separat în subfolder + `tsc -p <subfolder>/tsconfig.json`.
 * ========================================================================= */

/** `File 'C:/x/bootcamp-test/index.ts' is not under 'rootDir'` (primul path). */
const TS6059_FILE_RE = /TS6059:[^\n]*?\bFile\s+['"]([^'"]+)['"]/i;

/** Eroarea asta e TS6059? */
export function looksLikeTs6059(output: string): boolean {
  return /TS6059/.test(String(output ?? ''));
}

/**
 * Folderul (relativ, cu `/`) în care trebuie creat tsconfig.json: întâi căutăm
 * o intrare din scope în calea din eroare, altfel părintele fișierului.
 */
function ts6059Folder(output: string, scope?: string[] | null): string {
  const m = TS6059_FILE_RE.exec(String(output ?? ''));
  const file = m ? String(m[1]).replace(/\\/g, '/') : '';
  const lower = file.toLowerCase();
  if (scope && scope.length) {
    for (const s of scope) {
      const n = String(s ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '');
      if (!n) continue;
      const i = lower.indexOf(n.toLowerCase());
      if (i >= 0) return file.slice(i, i + n.length);
    }
  }
  const parts = file.split('/').filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return '<scope>';
}

/** Hint-ul TS6059 (vezi secțiunea de mai sus). */
export function buildTs6059Hint(
  output: string,
  scope?: string[] | null
): string {
  const folder = ts6059Folder(output, scope);
  return (
    'TS6059 means ROOT tsconfig.json has \'rootDir\' set and excludes files outside it.\n' +
    'BEST FIX: create a separate tsconfig.json inside ' +
    folder +
    '/ and run:\n' +
    '  npx tsc --noEmit -p ' +
    folder +
    '/tsconfig.json\n' +
    'Do NOT keep editing the ROOT tsconfig.json.'
  );
}

/* =========================================================================
 * v1.4.0 — CHECKPOINT GIT PER PROMPT + RESTORE CU UN CLICK
 * Înainte de fiecare mesaj trimis, chatView creează un checkpoint git:
 * dacă working tree-ul e dirty, commit-uiește tot (mesaj-marker
 * „freekit-prompt:<id>”); altfel creează un commit gol-marker. Butonul ⟲
 * din chat readuce proiectul exact la starea de dinaintea promptului
 * (git reset --hard), cu backup automat (commit) al stării curente înainte
 * de reset. Totul e fail-open: fără git (sau fără repo), funcțiile întorc
 * null / eroare, fără să blocheze fluxul normal.
 * ========================================================================= */

export interface Checkpoint {
  /** hash-ul commit-ului de checkpoint */
  id: string;
  /** id-ul mesajului user din chat (cheia din globalState) */
  messageId: string;
  /** primele 80 de caractere din prompt */
  text: string;
  timestamp: number;
  /** true = working tree-ul era curat înainte de checkpoint */
  wasClean: boolean;
  /** v1.5.0: repo-ul git a fost inițializat automat acum (nu exista) */
  repoInitialized?: boolean;
}

const MSG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GIT_HASH_RE = /^[0-9a-f]{4,40}$/i;
const GIT_TIMEOUT_MS = 120000;

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Rulează o comandă git (FĂRĂ shell — argumente separate, fără injectări). */
async function gitRun(
  root: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS
): Promise<GitRunResult> {
  try {
    const r = await execFileAsync('git', args, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    return {
      ok: true,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? '')
    };
  } catch (e: any) {
    return {
      ok: false,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? ''),
      error: e?.message ?? String(e)
    };
  }
}

/**
 * Commit cu fallback de identitate: dacă repo-ul nu are user.name/user.email
 * configurat (sau semnarea GPG e pornită fără chei), reîncearcă cu identitatea
 * de bot „Freekit” — altfel checkpoint-ul ar eșua tăcut pe astfel de medii.
 */
async function gitCommit(
  root: string,
  message: string,
  allowEmpty: boolean
): Promise<boolean> {
  const args = ['commit', '-m', message, '--no-verify'];
  if (allowEmpty) args.push('--allow-empty');
  const first = await gitRun(root, args);
  if (first.ok) return true;
  const fallback = await gitRun(root, [
    '-c', 'user.name=Freekit',
    '-c', 'user.email=freekit@local',
    '-c', 'commit.gpgSign=false',
    ...args
  ]);
  if (!fallback.ok) {
    log('git commit a eșuat: ' + (fallback.stderr || fallback.error || ''));
  }
  return fallback.ok;
}

/** v1.5.0: folder în care am încercat deja `git init` (o singură dată). */
const INIT_ATTEMPTED = new Set<string>();

/**
 * v1.5.0 — repo-ul git există? Dacă nu, îl inițializează o singură dată
 * (`git init`), ca checkpoint-urile să funcționeze și în foldere fără git.
 * La init se scrie și un `.gitignore` minimal (doar dacă lipsește), ca
 * `git add -A` să nu înghită node_modules/dist la primul commit.
 */
export async function ensureGitRepo(
  root: string
): Promise<{ ok: boolean; initialized: boolean; error?: string }> {
  try {
    const rev = await gitRun(root, ['rev-parse', '--git-dir']);
    if (rev.ok && rev.stdout.trim()) return { ok: true, initialized: false };

    const key = path.normalize(root).toLowerCase();
    if (INIT_ATTEMPTED.has(key)) {
      return {
        ok: false,
        initialized: false,
        error: rev.error || rev.stderr || 'not a git repo'
      };
    }
    INIT_ATTEMPTED.add(key);

    const init = await gitRun(root, ['init']);
    if (!init.ok) {
      const detail = (init.stderr || init.error || '').split('\n')[0];
      log('git init a eșuat în ' + root + ': ' + detail);
      return {
        ok: false,
        initialized: false,
        error: detail || 'git init failed (is git missing?)'
      };
    }

    // .gitignore minimal la prima inițializare (nu atingem unul existent)
    const ignorePath = path.join(root, '.gitignore');
    if (!fs.existsSync(ignorePath)) {
      try {
        fs.writeFileSync(
          ignorePath,
          [
            '# creat automat de Freekit (checkpoint-uri git)',
            'node_modules/',
            'dist/',
            'build/',
            'out/',
            '.astro/',
            '.next/',
            '.cache/',
            '*.vsix',
            '*.log',
            ''
          ].join('\n'),
          'utf8'
        );
      } catch (e: any) {
        log('scrierea .gitignore a eșuat: ' + (e?.message ?? String(e)));
      }
    }

    log('git init automat în ' + root);
    return { ok: true, initialized: true };
  } catch (e: any) {
    log('ensureGitRepo a eșuat: ' + (e?.message ?? String(e)));
    return { ok: false, initialized: false, error: e?.message ?? String(e) };
  }
}

/**
 * Creează un checkpoint înainte de fiecare prompt.
 * Dacă working tree-ul nu e clean, commit-uiește tot ca checkpoint (marker
 * „freekit-prompt:<id>”); dacă e clean, creează un commit gol-marker, ca
 * fiecare prompt să aibă un id unic de restore.
 * v1.5.0: cu opts.autoInit, un folder care nu e (încă) repo git primește
 * `git init` automat — altfel funcția întorcea tăcut null și butonul ⟲
 * de restore nu apărea niciodată.
 */
export async function createPromptCheckpoint(
  root: string,
  messageId: string,
  promptText: string,
  opts?: { autoInit?: boolean }
): Promise<Checkpoint | null> {
  try {
    // 1. doar în repo-uri git; v1.5.0: init automat dacă lipsește
    let repoInitialized = false;
    const gitDir = await gitRun(root, ['rev-parse', '--git-dir']);
    if (!gitDir.ok || !gitDir.stdout.trim()) {
      if (!opts?.autoInit) return null;
      const ens = await ensureGitRepo(root);
      if (!ens.ok) {
        log('checkpoint: ensureGitRepo a eșuat — ' + (ens.error ?? 'necunoscut'));
        return null;
      }
      repoInitialized = ens.initialized;
    }

    // 2. id sigur de mesaj (ajunge în mesajul commit-ului)
    const safeId = MSG_ID_RE.test(String(messageId ?? ''))
      ? String(messageId)
      : String(messageId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) ||
        'auto' + Date.now().toString(36);

    // 3. working tree dirty?
    const status = await gitRun(root, ['status', '--porcelain']);
    if (!status.ok) return null;
    const wasClean = !status.stdout.trim();

    // 4. commit de checkpoint (tot working tree-ul sau un marker gol)
    if (!wasClean) {
      const add = await gitRun(root, ['add', '-A']);
      if (!add.ok) {
        log('checkpoint: git add a eșuat — ' + (add.stderr || add.error || ''));
        return null;
      }
    }
    // allowEmpty=true pe ambele ramuri: robust la stări „dirty” doar în
    // metadate (submodule) unde commit-ul normal nu ar avea ce stoca
    if (!(await gitCommit(root, 'freekit-prompt:' + safeId, true))) {
      return null;
    }

    // 5. hash-ul commit-ului
    const head = await gitRun(root, ['rev-parse', 'HEAD']);
    const id = head.stdout.trim();
    if (!head.ok || !GIT_HASH_RE.test(id)) return null;

    log('checkpoint ' + id.slice(0, 7) + ' (' + safeId + ', wasClean=' + wasClean + ')');
    return {
      id,
      messageId,
      text: String(promptText ?? '').slice(0, 80),
      timestamp: Date.now(),
      wasClean,
      repoInitialized
    };
  } catch (e: any) {
    log('checkpoint failed: ' + (e?.message ?? String(e)));
    return null;
  }
}

/**
 * Revine la un checkpoint. Înainte de reset, starea curentă (dacă e dirty)
 * este salvată ca backup-commit „freekit-backup-before-restore:<ts>”, deci
 * nimic nu se pierde — backupId e întors pentru a putea reveni la ea.
 * Fiindcă backup-ul înregistrează TOATE fișierele neignorate, reset --hard
 * readuce working tree-ul exact la starea checkpoint-ului: fișierele noi
 * create după checkpoint sunt șterse de reset (recuperabile din backupId).
 * Fișierele ignorate (node_modules etc.) nu sunt atinse.
 */
export async function restoreToCheckpoint(
  root: string,
  checkpointId: string
): Promise<{
  ok: boolean;
  error?: string;
  backupId?: string;
  leftoverUntracked?: string[];
}> {
  try {
    if (!GIT_HASH_RE.test(String(checkpointId ?? ''))) {
      return { ok: false, error: 'invalid checkpoint id: ' + checkpointId };
    }
    const gitDir = await gitRun(root, ['rev-parse', '--git-dir']);
    if (!gitDir.ok) return { ok: false, error: 'not a git project' };

    // 1. backup al stării curente (safety) — doar dacă working tree-ul e dirty
    let backupId: string | undefined;
    const status = await gitRun(root, ['status', '--porcelain']);
    if (status.ok && status.stdout.trim()) {
      const add = await gitRun(root, ['add', '-A']);
      if (!add.ok) {
        return { ok: false, error: 'git add -A failed: ' + (add.stderr || add.error || '') };
      }
      if (!(await gitCommit(root, 'freekit-backup-before-restore:' + Date.now(), false))) {
        return { ok: false, error: 'the backup commit failed (check git user.name/email)' };
      }
      const head = await gitRun(root, ['rev-parse', 'HEAD']);
      if (head.ok && GIT_HASH_RE.test(head.stdout.trim())) {
        backupId = head.stdout.trim();
      }
    }

    // 2. reset --hard la checkpoint (fix față de schiță: un SINGUR reset)
    const reset = await gitRun(root, ['reset', '--hard', checkpointId]);
    if (!reset.ok) {
      const detail = (reset.stderr || reset.error || '').split('\n')[0];
      return { ok: false, error: 'git reset --hard failed: ' + detail };
    }

    // 3. raportează eventualele fișiere neignorate rămase după reset
    // (de regulă 0 — reset-ul șterge tot ce nu e în checkpoint)
    const after = await gitRun(root, ['status', '--porcelain']);
    const leftoverUntracked = after.ok
      ? after.stdout
          .split('\n')
          .filter((l) => l.startsWith('?? '))
          .map((l) => l.slice(3).trim())
          .filter(Boolean)
      : [];

    log(
      'restored to checkpoint ' + checkpointId.slice(0, 7) +
        (backupId ? ' (backup ' + backupId.slice(0, 7) + ')' : '') +
        ', untracked rămase: ' + leftoverUntracked.length
    );
    return { ok: true, backupId, leftoverUntracked };
  } catch (e: any) {
    log('restore failed: ' + (e?.message ?? String(e)));
    return { ok: false, error: e?.message ?? String(e) };
  }
}
