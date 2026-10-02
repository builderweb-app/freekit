import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * v2.0.2: detectare hardware (RAM / CPU / VRAM) + recomandare de modele Ollama.
 * Modul pur Node (NU importă `vscode`), ca să poată fi testat izolat.
 *
 * Surse de VRAM, în ordine:
 *   1. `nvidia-smi` — exact, pe toate platformele (NVIDIA);
 *   2. Windows: `Win32_VideoController` + `HardwareInformation.qwMemorySize` din
 *      registry (`AdapterRAM` e un câmp pe 32 de biți și se plafonează la ~4 GB);
 *   3. macOS: `system_profiler SPDisplaysDataType -json`;
 *   4. Linux: `mem_info_vram_total` din sysfs (AMD amdgpu).
 */

/** Detectarea nu trebuie să blocheze UI-ul: fiecare sondă are timeout scurt. */
const PROBE_TIMEOUT_MS = 4000;

export interface GpuInfo {
  name: string;
  /** VRAM în GB; `null` = necunoscut (proba nu a putut fi citită). */
  vramGb: number | null;
}

export interface HardwareInfo {
  platform: NodeJS.Platform;
  cpuModel: string;
  cpuCores: number;
  /** RAM totală, în GB (o zecimală). */
  ramGb: number;
  /** Plăcile video detectate, sortate descrescător după VRAM. */
  gpus: GpuInfo[];
  /** VRAM-ul celei mai mari plăci detectate (GB) sau `null`. */
  vramGb: number | null;
  /** `true` dacă VRAM-ul vine dintr-o sursă exactă (`nvidia-smi`). */
  vramExact: boolean;
  /** Explicație scurtă când VRAM-ul lipsește. */
  note?: string;
}

export interface ModelRecommendation {
  /** Id-ul Ollama, ex. `qwen2.5-coder:7b`. */
  id: string;
  /** Dimensiunea parametrilor, ex. `7B`. */
  size: string;
  /** Memorie aproximativă necesară (GB, cuantizare Q4_K_M). */
  needGb: number;
  /** `true` dacă modelul încape integral în VRAM (rulează pe GPU). */
  fitsVram: boolean;
  /** De ce a fost recomandat (text scurt pentru UI). */
  why: string;
}

/* =========================================================================
 * Detectare
 * ========================================================================= */

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

async function run(cmd: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8'
  });
  return String(stdout ?? '');
}

/** `powershell.exe -EncodedCommand` evită complet problemele de escaping. */
function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const WIN_GPU_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$class = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
$props = Get-ChildItem $class | ForEach-Object { Get-ItemProperty -Path $_.PSPath }
$out = @()
foreach ($c in Get-CimInstance Win32_VideoController) {
  $name = $c.Name
  if (-not $name) { continue }
  $vram = [uint64]0
  $hit = $props | Where-Object { $_.DriverDesc -eq $name -and $_.'HardwareInformation.qwMemorySize' } | Select-Object -First 1
  if ($hit) { $vram = [uint64]$hit.'HardwareInformation.qwMemorySize' }
  elseif ($c.AdapterRAM) { $vram = [uint64]$c.AdapterRAM }
  $out += [pscustomobject]@{ name = $name; vramBytes = $vram }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`;

/** Adaptoarele virtuale (RDP / stream / display-uri false) nu interesează. */
const VIRTUAL_GPU = /basic display|virtual|remote|parsec|spacedesk|oray|meta |idd|reflector/i;

async function detectNvidia(): Promise<GpuInfo[]> {
  const stdout = await run('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits'
  ]);
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, mb] = trimmed.split(',').map((p) => p.trim());
    if (!name) continue;
    const mib = Number(mb);
    gpus.push({
      name,
      vramGb: Number.isFinite(mib) && mib > 0 ? gb(mib * 1024 ** 2) : null
    });
  }
  return gpus;
}

async function detectWindowsGpus(): Promise<GpuInfo[]> {
  const stdout = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(WIN_GPU_SCRIPT)
  ]);
  const raw = stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((item) => item as { name?: string; vramBytes?: number })
    .filter((item) => !!item?.name)
    .map((item) => {
      const bytes = Number(item.vramBytes);
      return {
        name: String(item.name),
        vramGb: Number.isFinite(bytes) && bytes > 0 ? gb(bytes) : null
      };
    });
}

function parseVramText(text: string | undefined): number | null {
  if (!text) return null;
  const m = /([\d.]+)\s*(GB|MB)/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return m[2].toUpperCase() === 'MB' ? Math.round((value / 1024) * 10) / 10 : value;
}

async function detectMacGpus(): Promise<GpuInfo[]> {
  const stdout = await run('system_profiler', ['SPDisplaysDataType', '-json'], 15000);
  const parsed = JSON.parse(stdout) as {
    SPDisplaysDataType?: Array<Record<string, string>>;
  };
  return (parsed.SPDisplaysDataType ?? [])
    .map((d) => ({
      name: d.sppci_model ?? d._name ?? 'GPU',
      vramGb: parseVramText(d.spdisplays_vram ?? d.spdisplays_vram_shared)
    }))
    .filter((g) => !!g.name);
}

async function detectLinuxGpus(): Promise<GpuInfo[]> {
  const gpus: GpuInfo[] = [];
  let entries: string[] = [];
  try {
    entries = (await fs.promises.readdir('/sys/class/drm')).filter((d) =>
      /^card\d+$/.test(d)
    );
  } catch {
    return [];
  }
  for (const card of entries) {
    const base = `/sys/class/drm/${card}/device`;
    try {
      const total = Number((await fs.promises.readFile(`${base}/mem_info_vram_total`, 'utf8')).trim());
      if (!Number.isFinite(total) || total <= 0) continue;
      let driver = 'GPU';
      try {
        const uevent = await fs.promises.readFile(`${base}/uevent`, 'utf8');
        driver = /DRIVER=(\S+)/.exec(uevent)?.[1] ?? driver;
      } catch {
        /* numele rămâne generic */
      }
      gpus.push({ name: `${driver} (${card})`, vramGb: gb(total) });
    } catch {
      /* placa nu expune VRAM în sysfs */
    }
  }
  return gpus;
}

async function detectGpus(platform: NodeJS.Platform): Promise<{
  gpus: GpuInfo[];
  vramExact: boolean;
  note?: string;
}> {
  try {
    const nvidia = await detectNvidia();
    if (nvidia.length) return { gpus: nvidia, vramExact: true };
  } catch {
    /* nvidia-smi lipsește sau nu răspunde */
  }

  try {
    if (platform === 'win32') return { gpus: await detectWindowsGpus(), vramExact: false };
    if (platform === 'darwin') return { gpus: await detectMacGpus(), vramExact: false };
    if (platform === 'linux') return { gpus: await detectLinuxGpus(), vramExact: false };
  } catch {
    /* proba specifică platformei a eșuat */
  }

  return { gpus: [], vramExact: false, note: 'no GPU probe available on this system' };
}

/** Sortează plăcile după VRAM (cele virtuale raportează de obicei 0 → cad la coadă). */
function sortGpus(gpus: GpuInfo[]): GpuInfo[] {
  const real = gpus.filter((g) => !VIRTUAL_GPU.test(g.name));
  return [...(real.length ? real : gpus)].sort(
    (a, b) => (b.vramGb ?? -1) - (a.vramGb ?? -1)
  );
}

async function detect(): Promise<HardwareInfo> {
  const platform = os.platform();
  const cpus = os.cpus();
  const { gpus, vramExact, note } = await detectGpus(platform);
  const sorted = sortGpus(gpus);
  return {
    platform,
    cpuModel: (cpus[0]?.model ?? 'unknown CPU').trim(),
    cpuCores: cpus.length,
    ramGb: gb(os.totalmem()),
    gpus: sorted,
    vramGb: sorted[0]?.vramGb ?? null,
    vramExact,
    note: sorted.length ? undefined : note
  };
}

let cache: Promise<HardwareInfo> | null = null;

/**
 * Hardware-ul nu se schimbă între două refresh-uri de status → rezultatul e
 * memorat pentru sesiune. `force = true` reia probele (ex. eGPU conectat ulterior).
 */
export function detectHardware(force = false): Promise<HardwareInfo> {
  if (force || !cache) {
    cache = detect().catch(
      (): HardwareInfo => ({
        platform: os.platform(),
        cpuModel: (os.cpus()[0]?.model ?? 'unknown CPU').trim(),
        cpuCores: os.cpus().length,
        ramGb: gb(os.totalmem()),
        gpus: [],
        vramGb: null,
        vramExact: false,
        note: 'hardware detection failed'
      })
    );
  }
  return cache;
}

/* =========================================================================
 * Recomandare de modele
 * ========================================================================= */

interface CatalogEntry {
  id: string;
  size: string;
  /** Memorie aproximativă necesară (GB) la cuantizarea implicită Q4_K_M. */
  needGb: number;
}

/** Catalogul din care se alege recomandarea (modele de cod + generale). */
const MODEL_CATALOG: CatalogEntry[] = [
  { id: 'qwen2.5-coder:1.5b', size: '1.5B', needGb: 1.5 },
  { id: 'qwen2.5-coder:3b', size: '3B', needGb: 2.4 },
  { id: 'qwen2.5-coder:7b', size: '7B', needGb: 4.8 },
  { id: 'llama3.1:8b', size: '8B', needGb: 5.0 },
  { id: 'qwen3:8b', size: '8B', needGb: 5.5 },
  { id: 'gemma2:9b', size: '9B', needGb: 6.0 },
  { id: 'qwen2.5-coder:14b', size: '14B', needGb: 9.0 },
  { id: 'gpt-oss:20b', size: '20B', needGb: 13.0 },
  { id: 'qwen3:30b', size: '30B', needGb: 19.0 },
  { id: 'qwen2.5-coder:32b', size: '32B', needGb: 20.0 }
];

/** Cât din RAM poate fi folosită de model (restul rămâne sistemului / VS Code). */
const RAM_BUDGET_RATIO = 0.7;

/** Bugetul de memorie al mașinii, în GB. */
function ramBudgetGb(hw: HardwareInfo): number {
  return (hw.ramGb > 0 ? hw.ramGb : 8) * RAM_BUDGET_RATIO;
}

/**
 * Cele mai mari modele care încap în memoria mașinii (primele = cele mai bune).
 * `limit` = câte recomandări se întorc.
 */
export function recommendModels(hw: HardwareInfo, limit = 3): ModelRecommendation[] {
  const budgetGb = ramBudgetGb(hw);
  const fitting = MODEL_CATALOG.filter((m) => m.needGb <= budgetGb);
  const pool = fitting.length ? fitting : [MODEL_CATALOG[0]];
  const vram = hw.vramGb;

  return [...pool]
    .sort((a, b) => b.needGb - a.needGb)
    .slice(0, Math.max(1, limit))
    .map((m) => {
      const fitsVram = vram != null && m.needGb <= vram;
      let why: string;
      if (fitsVram) {
        why = `fits in ${vram} GB VRAM — runs on the GPU`;
      } else if (vram != null) {
        why = `partial GPU offload on ${vram} GB VRAM, the rest on the CPU`;
      } else {
        why = 'runs on the CPU (no usable GPU VRAM detected)';
      }
      return { id: m.id, size: m.size, needGb: m.needGb, fitsVram, why };
    });
}

/**
 * `true` dacă modelul (din catalog) încape în memoria mașinii — folosit pentru
 * eticheta „recommended" de pe modelele deja instalate.
 */
export function fitsThisMachine(model: string, hw: HardwareInfo): boolean {
  const wanted = model.trim().toLowerCase();
  const entry = MODEL_CATALOG.find((m) => m.id.toLowerCase() === wanted);
  return !!entry && entry.needGb <= ramBudgetGb(hw);
}

/** Text scurt pentru UI / raport: „RTX 4060 · 8 GB VRAM · 32 GB RAM". */
export function hardwareSummary(hw: HardwareInfo): string {
  const parts: string[] = [];
  const gpu = hw.gpus[0];
  if (gpu) {
    parts.push(gpu.vramGb != null ? `${gpu.name} · ${gpu.vramGb} GB VRAM` : gpu.name);
  } else {
    parts.push('no GPU detected');
  }
  parts.push(`${hw.ramGb} GB RAM`);
  return parts.join(' · ');
}
