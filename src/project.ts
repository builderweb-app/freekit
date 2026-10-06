import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { MAX_CHARS_TOTAL, clipPayload } from './payload';

const execFileAsync = promisify(execFile);

/* =========================================================================
 * FAZA III (F) — DETECȚIE AUTOMATĂ DE PROIECT
 * + runner partajat pentru npm/pnpm/yarn (FAZA II B) și git (FAZA II C).
 * Folosește doar Node API (fs/child_process), ca să fie testabil și în afara
 * procesului VS Code.
 * ========================================================================= */

export interface ProjectInfo {
  root: string;
  /** 'node' | 'python' | 'rust' | 'go' | 'php' | 'ruby' | 'unknown' */
  type: string;
  language: string;
  /** 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'poetry' | ... */
  packageManager: string;
  frameworks: string[];
  scripts: Record<string, string>;
  git: boolean;
}

const LOCKFILE_PM: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm']
];

const KNOWN_FRAMEWORKS = [
  'astro', 'next', 'nuxt', 'react', 'vue', 'svelte', 'solid-js', 'angular',
  'express', 'fastify', '@nestjs/core', 'vite', 'webpack', 'esbuild',
  'rollup', 'tailwindcss', 'playwright', 'jest', 'vitest', 'mocha',
  'electron', 'typescript', 'eslint', 'prettier'
];

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readUtf8(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const info: ProjectInfo = {
    root,
    type: 'unknown',
    language: '',
    packageManager: '',
    frameworks: [],
    scripts: {},
    git: await exists(path.join(root, '.git'))
  };

  const pkgRaw = await readUtf8(path.join(root, 'package.json'));
  if (pkgRaw) {
    info.type = 'node';
    info.language = 'javascript';
    if (await exists(path.join(root, 'tsconfig.json'))) {
      info.language = 'typescript';
    }

    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
        for (const [k, v] of Object.entries<string>(pkg.scripts)) {
          if (typeof v === 'string') info.scripts[k] = v;
        }
      }
      const deps: Record<string, unknown> = {
        ...((pkg?.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg?.devDependencies as Record<string, unknown>) ?? {})
      };
      for (const f of KNOWN_FRAMEWORKS) {
        if (deps[f]) info.frameworks.push(f === '@nestjs/core' ? 'nestjs' : f);
      }
    } catch {
      /* package.json invalid — continuăm cu ce avem */
    }

    for (const [file, pm] of LOCKFILE_PM) {
      if (await exists(path.join(root, file))) {
        info.packageManager = pm;
        break;
      }
    }
    if (!info.packageManager) info.packageManager = 'npm';

    if (
      info.frameworks.indexOf('astro') < 0 &&
      ((await exists(path.join(root, 'astro.config.mjs'))) ||
        (await exists(path.join(root, 'astro.config.ts'))) ||
        (await exists(path.join(root, 'astro.config.js'))))
    ) {
      info.frameworks.push('astro');
    }
    return info;
  }

  if (
    (await exists(path.join(root, 'pyproject.toml'))) ||
    (await exists(path.join(root, 'requirements.txt')))
  ) {
    info.type = 'python';
    info.language = 'python';
    info.packageManager = (await exists(path.join(root, 'poetry.lock')))
      ? 'poetry'
      : 'pip';
    return info;
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    info.type = 'rust';
    info.language = 'rust';
    info.packageManager = 'cargo';
    return info;
  }
  if (await exists(path.join(root, 'go.mod'))) {
    info.type = 'go';
    info.language = 'go';
    info.packageManager = 'go';
    return info;
  }
  if (await exists(path.join(root, 'composer.json'))) {
    info.type = 'php';
    info.language = 'php';
    info.packageManager = 'composer';
    return info;
  }
  if (await exists(path.join(root, 'Gemfile'))) {
    info.type = 'ruby';
    info.language = 'ruby';
    info.packageManager = 'bundler';
    return info;
  }

  return info;
}

/** Textul trimis AI-ului cu informații despre proiect (secțiunea PROJECT INFO). */
export function formatProjectInfo(info: ProjectInfo): string {
  const lines: string[] = [];
  lines.push(
    'Type: ' + info.type + (info.language ? ' (' + info.language + ')' : '')
  );
  if (info.packageManager) lines.push('Package manager: ' + info.packageManager);
  if (info.frameworks.length) {
    lines.push('Frameworks/libraries: ' + info.frameworks.join(', '));
  }
  lines.push('Git: ' + (info.git ? 'yes' : 'no'));
  const scripts = Object.keys(info.scripts);
  if (scripts.length) {
    lines.push('Scripts: ' + scripts.join(', '));
    if (info.type === 'node') {
      lines.push(
        'Run: "' + info.packageManager + ' install", then "' +
          info.packageManager + ' run <script>" (prefer the run_npm tool)'
      );
    }
  }
  return lines.join('\n');
}

/** Numele comenzii npm/pnpm/yarn pe platforma curentă. */
export function packageManagerBin(pm: string): string {
  if (process.platform !== 'win32') return pm;
  if (pm === 'bun') return 'bun.exe';
  return pm + '.cmd';
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  /** v0.6.0: stdout separat (folosit de terminal self-correction). */
  stdout: string;
  /** v0.6.0: stderr separat (folosit de terminal self-correction). */
  stderr: string;
  /** v0.6.0: durata execuției în ms. */
  duration: number;
}

/** Execută un program cu argumente și captează output-ul.
 * Pe Windows, npm/pnpm/yarn sunt fișiere .cmd și au nevoie de `shell: true`
 * (altfel Node aruncă EINVAL din cauza CVE-2024-27980). Argumentele folosite
 * cu shell-ul sunt strict validate înainte de apel, iar comanda se construiește
 * ca un singur string (fără DEP0190). */
export async function runProgram(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; shell?: boolean }
): Promise<RunResult> {
  const baseOpts = {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  };
  const started = Date.now();
  try {
    let stdout: string;
    let stderr: string;
    if (opts.shell === true) {
      const r = await execFileAsync([bin, ...args].join(' '), {
        ...baseOpts,
        shell: true
      });
      stdout = String(r.stdout ?? '');
      stderr = String(r.stderr ?? '');
    } else {
      const r = await execFileAsync(bin, args, baseOpts);
      stdout = String(r.stdout ?? '');
      stderr = String(r.stderr ?? '');
    }
    // v2.5.23 (bug #54): bugetul comun de payload (cap+coadă) — output-ul brut
    // al comenzilor ajunge la AI fie direct (git), fie prin formatCommandOutcome.
    const output = stdout + (stderr ? '\n[stderr]\n' + stderr : '');
    return {
      ok: true,
      code: 0,
      output: clipPayload(output, MAX_CHARS_TOTAL),
      timedOut: false,
      stdout: clipPayload(stdout, MAX_CHARS_TOTAL),
      stderr: clipPayload(stderr, MAX_CHARS_TOTAL),
      duration: Date.now() - started
    };
  } catch (e: any) {
    const stdout = e?.stdout ? String(e.stdout) : '';
    const stderr = e?.stderr ? String(e.stderr) : '';
    const output =
      stdout + (stderr ? '\n[stderr]\n' + stderr : '') ||
      e?.message ||
      String(e);
    const code = typeof e?.code === 'number' ? e.code : null;
    const timedOut = e?.killed === true;
    return {
      ok: false,
      code,
      output: clipPayload(String(output), MAX_CHARS_TOTAL),
      timedOut,
      stdout: clipPayload(stdout, MAX_CHARS_TOTAL),
      stderr: clipPayload(stderr, MAX_CHARS_TOTAL),
      duration: Date.now() - started
    };
  }
}
