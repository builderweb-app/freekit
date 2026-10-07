import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * v2.0.2: detectare hardware (RAM / CPU / VRAM) + recomandare de modele Ollama.
 * v2.1.0: detecție completă (toate GPU-urile, vendor/tip/bandwidth, disc liber,
 * VM) + tier de mașină (T0-T6) + catalog extins de modele.
 * Modul pur Node (NU importă `vscode`), ca să poată fi testat izolat.
 *
 * Surse de VRAM, în ordine:
 *   1. `nvidia-smi` — exact, pe toate platformele (NVIDIA); dă și bus width +
 *      memory clock, din care calculăm bandwidth-ul real;
 *   2. Windows: `Win32_VideoController` + `HardwareInformation.qwMemorySize` din
 *      registry (`AdapterRAM` e un câmp pe 32 de biți și se plafonează la ~4 GB);
 *   3. macOS: `system_profiler SPDisplaysDataType -json`;
 *   4. Linux: `mem_info_vram_total` din sysfs (AMD amdgpu).
 */

/** Detectarea nu trebuie să blocheze UI-ul: fiecare sondă are timeout scurt. */
const PROBE_TIMEOUT_MS = 4000;

export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown';

/**
 * `consumer` = placă de consum, `workstation` = Quadro/RTX A/Radeon Pro,
 * `server` = Tesla/Instinct/A100/H100, `igpu` = integrată sau memorie unificată.
 */
export type GpuType = 'consumer' | 'workstation' | 'server' | 'igpu';

export interface GpuInfo {
  name: string;
  /** VRAM în GB; `null` = necunoscut (proba nu a putut fi citită). */
  vramGb: number | null;
  vendor: GpuVendor;
  type: GpuType;
  /** Lățimea de bandă estimată (GB/s), când o putem deduce. */
  bandwidthGbps?: number;
}

/**
 * v2.1.0: tier de mașină — cât de mare e cel mai mare model rulabil „bine".
 * Capacitatea folosită la clasificare (vezi `TIER_CAPACITY_GB`):
 *   T0 < 4 GB · T1 < 12 · T2 < 24 · T3 < 48 · T4 < 96 · T5 < 192 · T6 ≥ 192.
 */
export type HardwareTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';

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
  /** Suma VRAM-ului plăcilor discrete (iGPU-urile nu se pun — împart RAM-ul). */
  totalVramGb: number;
  /** v2.1.0: memorie unificată folosibilă de model (Apple Silicon), altfel 0. */
  unifiedMemoryGb: number;
  /** `true` dacă VRAM-ul vine dintr-o sursă exactă (`nvidia-smi`). */
  vramExact: boolean;
  /** v2.1.0: tier-ul mașinii, derivat din VRAM + RAM. */
  tier: HardwareTier;
  /** v2.1.0: spațiu liber pe discul unde stau modelele Ollama (GB; 0 = necunoscut). */
  freeDiskGb: number;
  /** v2.1.0: `true` dacă rulăm într-o mașină virtuală. */
  isVM: boolean;
  /** v2.1.0: momentul detecției (epoch ms). */
  detectedAt: number;
  /** Explicație scurtă când VRAM-ul lipsește. */
  note?: string;
}

/** Cât de bine rulează un model pe mașina detectată. */
export type ModelSpeed = 'fast' | 'medium' | 'slow';

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
  /** v2.1.0: etichete (`code`, `reasoning`, `vision`, `general`, `moe`). */
  tags: string[];
  /** v2.1.0: viteza estimată PE MAȘINA asta. */
  speed: ModelSpeed;
  /** v2.1.0: tier-ul minim de la care modelul rulează confortabil. */
  minTier: HardwareTier;
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

/* =========================================================================
 * v2.1.0 — clasificare GPU (vendor / tip / bandwidth)
 * ========================================================================= */

/** Tipar → vendor. Ordinea contează: Apple primul (nume de tip „Apple M2 Max”). */
const VENDOR_PATTERNS: Array<[GpuVendor, RegExp]> = [
  ['apple', /apple\s+m\d/i],
  [
    'nvidia',
    /nvidia|geforce|quadro|tesla|instinct|a100|h100|h200|\bl40s?\b|\bl4\b|\bv100\b|\bp100\b|\bp40\b|\bgtx\b|\brtx\b|\bmx\d{3}\b|\bt\d{4}\b/i
  ],
  ['amd', /amd|radeon|advanced micro devices|instinct|\brx\s?\d{3,4}\b|firepro|\bvega\b/i],
  ['intel', /intel|\biris\b|\buhd\b|\bhd graphics\b|\barc\b|\bgma\b/i]
];

export function gpuVendor(name: string): GpuVendor {
  for (const [vendor, pattern] of VENDOR_PATTERNS) {
    if (pattern.test(name)) return vendor;
  }
  return 'unknown';
}

/** Plăci de datacenter (nu stau în desktop-uri). */
const SERVER_GPU = /\b(instinct|tesla|a100|h100|h200|\bv100\b|\bp100\b|\bp40\b|\bl40s?\b|\bl4\b|mi\d{2,3}|gaudi)\b/i;
/**
 * Plăci profesionale. `rtx\s+(2000|3000|4000|4500|5000|6000|8000)` acoperă
 * Quadro-urile Turing/Ampere/Ada — `\b` după cifre garantează că „RTX 4060”
 * (consumer) nu e confundat cu „RTX 4000” (workstation).
 */
const WORKSTATION_GPU =
  /\b(quadro|radeon\s+pro|firepro|rtx\s+a\d{4}|rtx\s+(?:2000|3000|4000|4500|5000|6000|8000|4000\s+ada|4500\s+ada|5000\s+ada|6000\s+ada)\b|\bw[5-9]\d{3}\b|radeon\s+pro\s+w)/i;
/** Integrate: împart RAM-ul cu sistemul, nu au VRAM proprie reală. */
const IGPU =
  /\b(intel|iris|uhd|hd graphics|radeon\s+graphics|radeon\s+vega|vega\s+\d+\s+graphics|integrated|gma\b|apple\s+m\d)/i;

export function gpuType(name: string, vendor: GpuVendor, vramGb: number | null): GpuType {
  if (vendor === 'apple') return 'igpu'; // memorie unificată, nu VRAM dedicată
  if (SERVER_GPU.test(name)) return 'server';
  if (WORKSTATION_GPU.test(name)) return 'workstation';
  if (IGPU.test(name)) return 'igpu';
  if (vendor === 'intel') return 'igpu';
  if (vramGb != null && vramGb <= 1.5) return 'igpu';
  return 'consumer';
}

/**
 * Lățimea de bandă Apple Silicon (GB/s), pe familie. Memoria unificată e
 * partajată, dar bandwidth-ul e cel care decide cât de repede rulează modelul;
 * valorile sunt cele publicate de Apple (variantele binned iau valoarea maximă).
 */
const APPLE_BANDWIDTH: Array<[RegExp, number]> = [
  [/m4\s+max/i, 546],
  [/m4\s+pro/i, 273],
  [/m4\s+ultra/i, 819],
  [/m4/i, 120],
  [/m3\s+ultra/i, 819],
  [/m3\s+max/i, 400],
  [/m3\s+pro/i, 150],
  [/m3/i, 100],
  [/m2\s+ultra/i, 800],
  [/m2\s+max/i, 400],
  [/m2\s+pro/i, 200],
  [/m2/i, 100],
  [/m1\s+ultra/i, 800],
  [/m1\s+max/i, 400],
  [/m1\s+pro/i, 200],
  [/m1/i, 68]
];

/** Bandwidth estimat din numele plăcii (doar Apple — restul vin din nvidia-smi). */
function appleBandwidth(name: string): number | undefined {
  for (const [pattern, gbps] of APPLE_BANDWIDTH) {
    if (pattern.test(name)) return gbps;
  }
  return undefined;
}

/** Completează vendor/tip/bandwidth pentru plăcile venite din probele generice. */
function describeGpu(name: string, vramGb: number | null): GpuInfo {
  const vendor = gpuVendor(name);
  const type = gpuType(name, vendor, vramGb);
  const bandwidthGbps = vendor === 'apple' ? appleBandwidth(name) : undefined;
  return bandwidthGbps === undefined
    ? { name, vramGb, vendor, type }
    : { name, vramGb, vendor, type, bandwidthGbps };
}

async function detectNvidia(): Promise<GpuInfo[]> {
  // Bus width + memory clock dau bandwidth-ul real: bits × MHz × 2 / 8000 = GB/s
  const fields = ['name', 'memory.total', 'memory.bus_width', 'clocks.max.memory'];
  let stdout: string;
  let withBandwidth = true;
  try {
    stdout = await run('nvidia-smi', [
      `--query-gpu=${fields.join(',')}`,
      '--format=csv,noheader,nounits'
    ]);
  } catch {
    // drivere vechi nu expun clocks.max.memory — reluăm doar nume + memorie
    withBandwidth = false;
    stdout = await run('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits'
    ]);
  }
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    const [name, mb, busWidth, memClock] = parts;
    if (!name) continue;
    const mib = Number(mb);
    const vramGb = Number.isFinite(mib) && mib > 0 ? gb(mib * 1024 ** 2) : null;
    const gpu = describeGpu(name, vramGb);
    const bits = Number(busWidth);
    const mhz = Number(memClock);
    if (withBandwidth && Number.isFinite(bits) && bits > 0 && Number.isFinite(mhz) && mhz > 0) {
      gpu.bandwidthGbps = Math.round((bits * mhz) / 40) / 100;
    }
    gpus.push(gpu);
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
      const vramGb = Number.isFinite(bytes) && bytes > 0 ? gb(bytes) : null;
      return describeGpu(String(item.name), vramGb);
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
    .map((d) => {
      const name = d.sppci_model ?? d._name ?? 'GPU';
      // Apple Silicon: memoria e unificată (nu are VRAM dedicată), deci o
      // raportăm prin `unifiedMemoryGb`, nu ca VRAM de placă.
      const isApple = /apple\s+m\d/i.test(name);
      const vramGb = isApple
        ? null
        : parseVramText(d.spdisplays_vram ?? d.spdisplays_vram_shared);
      return describeGpu(name, vramGb);
    })
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
      // Numele din uevent e doar driverul (`amdgpu`, `nvidia`), deci vendorul
      // se deduce din el; tipul rămâne „consumer” până știm mai multe.
      gpus.push(describeGpu(`${driver} (${card})`, gb(total)));
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

/* =========================================================================
 * v2.1.0 — tier, disc liber, mașină virtuală
 * ========================================================================= */

/**
 * Capacitatea fiecărui tier (GB): peste atâta memorie treci la tier-ul următor.
 * T0 = sub 4 GB folosibili (deci ~4-5 GB RAM reali) — un 8 GB intră deja în T1,
 * unde un model de 7-8B rulează acceptabil pe CPU.
 */
const TIER_CAPACITY_GB: Array<[HardwareTier, number]> = [
  ['T0', 4],
  ['T1', 12],
  ['T2', 24],
  ['T3', 48],
  ['T4', 96],
  ['T5', 192]
];

/** Capacitatea maximă (GB) a unui tier — „cât încape bine" la nivelul acela. */
export function tierCapacityGb(tier: HardwareTier): number {
  const hit = TIER_CAPACITY_GB.find(([t]) => t === tier);
  return hit ? hit[1] : Number.POSITIVE_INFINITY; // T6 = fără limită practică
}

/** Tier-ul minim de la care un model de `needGb` GB rulează confortabil. */
export function minTierFor(needGb: number): HardwareTier {
  for (const [tier, capacity] of TIER_CAPACITY_GB) {
    if (needGb <= capacity) return tier;
  }
  return 'T6';
}

/** Capacitatea mașinii (GB) = memoria maximă în care poate rula un model. */
export function capacityGb(hw: HardwareInfo): number {
  const budget = modelMemoryBudget(hw);
  return Math.max(budget.vram, budget.total);
}

/** Tier-ul mașinii, din memoria totală folosibilă pentru model. */
export function machineTier(hw: HardwareInfo): HardwareTier {
  const capacity = capacityGb(hw);
  for (const [tier, limit] of TIER_CAPACITY_GB) {
    if (capacity < limit) return tier;
  }
  return 'T6';
}

/** Procesorul raportează explicit un hypervisor → mașină virtuală. */
const VM_CPU = /qemu virtual|virtualbox|vmware virtual|microsoft hv|kvm|virtual cpu|bhyve|parallels/i;
/** Numele producătorului/modelului de placă de bază → mașină virtuală. */
const VM_MACHINE =
  /vmware|virtualbox|innotek|qemu|kvm|xen|hyper-v|virtual machine|bhyve|parallels|bochs|openstack|amazon ec2|google compute|digitalocean|microsoft corporation.*virtual/i;

/**
 * `true` dacă rulăm într-o mașină virtuală. Best-effort: fiecare platformă are
 * o probă proprie, iar modelul CPU e un indiciu gratuit valabil peste tot.
 */
async function detectIsVM(platform: NodeJS.Platform, cpuModel: string): Promise<boolean> {
  if (VM_CPU.test(cpuModel)) return true;

  try {
    if (platform === 'linux') {
      // systemd-detect-virt iese cu 0 și tipărește tipul când e virtualizat
      const out = (await run('systemd-detect-virt', ['--vm'], 3000)).trim();
      if (out && out !== 'none') return true;
      const vendor = await fs.promises.readFile('/sys/class/dmi/id/sys_vendor', 'utf8');
      const product = await fs.promises.readFile('/sys/class/dmi/id/product_name', 'utf8');
      return VM_MACHINE.test(vendor + ' ' + product);
    }
    if (platform === 'darwin') {
      const out = (await run('sysctl', ['-n', 'kern.hv_vmm_present'], 3000)).trim();
      if (out === '1') return true;
      const model = (await run('sysctl', ['-n', 'hw.model'], 3000)).trim();
      return VM_MACHINE.test(model);
    }
    if (platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodePowerShell(WIN_VM_SCRIPT)
      ]);
      return VM_MACHINE.test(out.trim());
    }
  } catch {
    /* proba a eșuat — rămâne fals (nu blocăm nimic) */
  }
  return false;
}

const WIN_VM_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
"$($cs.Manufacturer) | $($cs.Model) | $($bios.Manufacturer)"
`;

/**
 * Spațiul liber (GB) de pe discul unde stau modelele Ollama. `0` = necunoscut.
 * `fs.statfs` e cross-platform (Node ≥ 18.15); cădem pe `df` dacă lipsește.
 */
async function detectFreeDiskGb(): Promise<number> {
  const target =
    process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const candidates = [target, os.homedir(), os.tmpdir()];

  for (const dir of candidates) {
    const free = await freeSpaceGb(dir);
    if (free != null) return free;
  }
  return 0;
}

/** `statfs` pe cel mai apropiat director existent (calea poate să nu existe încă). */
async function freeSpaceGb(dir: string): Promise<number | null> {
  let probe = dir;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.promises.access(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }

  const statfs = (fs.promises as unknown as {
    statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
  }).statfs;
  if (typeof statfs === 'function') {
    try {
      const stats = await statfs(probe);
      const bytes = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(bytes) && bytes > 0) return gb(bytes);
    } catch {
      /* cădem pe `df` */
    }
  }

  try {
    // `df -Pk` (POSIX) → a doua linie, coloana a 4-a = blocuri liberi de 1 KiB
    const out = await run('df', ['-Pk', probe], 3000);
    const line = out.trim().split(/\r?\n/)[1];
    const available = Number((line ?? '').trim().split(/\s+/)[3]);
    if (Number.isFinite(available) && available > 0) return gb(available * 1024);
  } catch {
    /* fără informație de disc */
  }
  return null;
}

async function detect(): Promise<HardwareInfo> {
  const platform = os.platform();
  const cpus = os.cpus();
  const cpuModel = (cpus[0]?.model ?? 'unknown CPU').trim();
  const ramGb = gb(os.totalmem());

  const [{ gpus, vramExact, note }, freeDiskGb, isVM] = await Promise.all([
    detectGpus(platform),
    detectFreeDiskGb(),
    detectIsVM(platform, cpuModel)
  ]);

  const sorted = sortGpus(gpus);
  // iGPU-urile împart RAM-ul cu sistemul → nu intră în suma de VRAM
  const totalVramGb =
    Math.round(sorted.filter((g) => g.type !== 'igpu').reduce((sum, g) => sum + (g.vramGb ?? 0), 0) * 10) / 10;
  const apple = sorted.find((g) => g.vendor === 'apple');
  // Apple Silicon: ~70% din RAM poate fi folosită de GPU/model (limita de wired memory)
  const unifiedMemoryGb = apple ? Math.round(ramGb * 0.7 * 10) / 10 : 0;

  const info: HardwareInfo = {
    platform,
    cpuModel,
    cpuCores: cpus.length,
    ramGb,
    gpus: sorted,
    vramGb: sorted[0]?.vramGb ?? null,
    totalVramGb,
    unifiedMemoryGb,
    vramExact,
    tier: 'T0',
    freeDiskGb,
    isVM,
    detectedAt: Date.now(),
    note: sorted.length ? undefined : note
  };
  info.tier = machineTier(info);
  return info;
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
        totalVramGb: 0,
        unifiedMemoryGb: 0,
        vramExact: false,
        tier: 'T0',
        freeDiskGb: 0,
        isVM: false,
        detectedAt: Date.now(),
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
  /** Memorie aproximativă necesară (GB) — Q4_K_M + KV cache la ~8-16k context. */
  needGb: number;
  /** Rating de calitate curat (0-100), comparabil în interiorul catalogului. */
  quality: number;
  tags: string[];
  /** Parametri activi (B), doar la modelele MoE — cheia vitezei pe CPU. */
  activeB?: number;
}

/**
 * v2.1.0: catalog extins (~50 de modele, de la 0.5B la 671B), ca recomandarea
 * să fie corectă pe orice mașină — de la un laptop de 4 GB până la o
 * stație de lucru cu 8×H100.
 *
 * `needGb` = blob-ul real Q4_K_M (verificat în registry-ul Ollama) + rezerva
 * pentru KV cache/context. Id-urile sunt tag-uri Ollama existente.
 * `quality` e un rating intern comparabil (capacitate de cod/raționament).
 */
const MODEL_CATALOG: CatalogEntry[] = [
  // — până în 2 GB: rulează pe orice, inclusiv pe CPU fără GPU —
  { id: 'qwen2.5-coder:0.5b', size: '0.5B', needGb: 0.8, quality: 22, tags: ['code'] },
  { id: 'llama3.2:1b', size: '1B', needGb: 1.6, quality: 28, tags: ['general'] },
  { id: 'qwen2.5-coder:1.5b', size: '1.5B', needGb: 1.3, quality: 34, tags: ['code'] },
  { id: 'deepseek-r1:1.5b', size: '1.5B', needGb: 1.4, quality: 30, tags: ['reasoning'] },
  { id: 'qwen3:1.7b', size: '1.7B', needGb: 1.7, quality: 38, tags: ['general', 'reasoning'] },
  // — 2-4 GB: punctul de intrare pe CPU —
  { id: 'granite3.1-moe:3b', size: '3B MoE', needGb: 2.3, quality: 40, tags: ['general', 'moe'], activeB: 0.8 },
  { id: 'qwen2.5-coder:3b', size: '3B', needGb: 2.2, quality: 46, tags: ['code'] },
  { id: 'llama3.2:3b', size: '3B', needGb: 2.3, quality: 45, tags: ['general'] },
  { id: 'phi4-mini:3.8b', size: '3.8B', needGb: 2.7, quality: 44, tags: ['reasoning'] },
  { id: 'qwen3:4b', size: '4B', needGb: 2.7, quality: 52, tags: ['general', 'reasoning'] },
  { id: 'gemma3:4b', size: '4B', needGb: 3.5, quality: 50, tags: ['general', 'vision'] },
  // — 4-6 GB: clasa „8B pe CPU", cea mai răspândită —
  { id: 'qwen2.5-coder:7b', size: '7B', needGb: 4.8, quality: 62, tags: ['code'] },
  { id: 'llama3.1:8b', size: '8B', needGb: 5.0, quality: 56, tags: ['general'] },
  { id: 'yi-coder:9b', size: '9B', needGb: 5.1, quality: 52, tags: ['code'] },
  { id: 'qwen3:8b', size: '8B', needGb: 5.3, quality: 66, tags: ['general', 'reasoning'] },
  { id: 'deepseek-r1:8b', size: '8B', needGb: 5.3, quality: 58, tags: ['reasoning'] },
  { id: 'gemma2:9b', size: '9B', needGb: 5.5, quality: 54, tags: ['general'] },
  { id: 'glm4:9b', size: '9B', needGb: 5.5, quality: 53, tags: ['general'] },
  // — 8-10 GB: intră pe o placă de 8-12 GB VRAM —
  { id: 'llama3.2-vision:11b', size: '11B', needGb: 7.7, quality: 55, tags: ['vision', 'general'] },
  { id: 'gemma3:12b', size: '12B', needGb: 8.0, quality: 62, tags: ['general', 'vision'] },
  { id: 'deepseek-coder-v2:16b', size: '16B MoE', needGb: 8.7, quality: 58, tags: ['code', 'moe'], activeB: 2.4 },
  { id: 'qwen2.5-coder:14b', size: '14B', needGb: 8.8, quality: 70, tags: ['code'] },
  { id: 'phi4:14b', size: '14B', needGb: 8.8, quality: 63, tags: ['reasoning'] },
  { id: 'starcoder2:15b', size: '15B', needGb: 8.8, quality: 48, tags: ['code'] },
  { id: 'qwen3:14b', size: '14B', needGb: 9.0, quality: 72, tags: ['general', 'reasoning'] },
  { id: 'deepseek-r1:14b', size: '14B', needGb: 8.8, quality: 66, tags: ['reasoning'] },
  // — 12-18 GB: 16 GB VRAM / 32 GB RAM —
  { id: 'codestral:22b', size: '22B', needGb: 12.1, quality: 68, tags: ['code'] },
  { id: 'gpt-oss:20b', size: '20B MoE', needGb: 13.3, quality: 78, tags: ['general', 'reasoning', 'moe'], activeB: 3.6 },
  { id: 'devstral:24b', size: '24B', needGb: 13.8, quality: 74, tags: ['code'] },
  { id: 'magistral:24b', size: '24B', needGb: 13.8, quality: 72, tags: ['reasoning'] },
  { id: 'mistral-small3.2:24b', size: '24B', needGb: 14.5, quality: 70, tags: ['general', 'vision'] },
  { id: 'gemma3:27b', size: '27B', needGb: 16.6, quality: 72, tags: ['general', 'vision'] },
  { id: 'qwen3:30b-a3b', size: '30B MoE', needGb: 17.7, quality: 80, tags: ['general', 'reasoning', 'moe'], activeB: 3.3 },
  { id: 'qwen3-coder:30b', size: '30B MoE', needGb: 17.7, quality: 82, tags: ['code', 'moe'], activeB: 3.3 },
  // — 18-48 GB: 24 GB VRAM sau 64 GB RAM —
  { id: 'command-r:35b', size: '35B', needGb: 17.8, quality: 60, tags: ['general'] },
  { id: 'qwen2.5-coder:32b', size: '32B', needGb: 18.9, quality: 78, tags: ['code'] },
  { id: 'qwen3:32b', size: '32B', needGb: 19.2, quality: 80, tags: ['general', 'reasoning'] },
  { id: 'deepseek-r1:32b', size: '32B', needGb: 18.9, quality: 76, tags: ['reasoning'] },
  { id: 'qwen2.5:32b', size: '32B', needGb: 18.9, quality: 74, tags: ['general'] },
  { id: 'deepseek-r1:70b', size: '70B', needGb: 42.8, quality: 84, tags: ['reasoning'] },
  { id: 'llama3.3:70b', size: '70B', needGb: 42.8, quality: 82, tags: ['general'] },
  { id: 'qwen2.5:72b', size: '72B', needGb: 47.7, quality: 80, tags: ['general'] },
  // — 60-74 GB: 2×24 GB VRAM sau 128 GB RAM —
  { id: 'command-r-plus:104b', size: '104B', needGb: 59.6, quality: 72, tags: ['general'] },
  { id: 'gpt-oss:120b', size: '120B MoE', needGb: 65.8, quality: 88, tags: ['general', 'reasoning', 'moe'], activeB: 5.1 },
  { id: 'llama4:scout', size: '109B MoE', needGb: 67.8, quality: 80, tags: ['general', 'vision', 'moe'], activeB: 17 },
  { id: 'mistral-large:123b', size: '123B', needGb: 73.6, quality: 78, tags: ['general'] },
  // — 143 GB: 192 GB RAM sau 2×80 GB VRAM —
  { id: 'qwen3:235b-a22b', size: '235B MoE', needGb: 143.0, quality: 90, tags: ['general', 'reasoning', 'moe'], activeB: 22 },
  // — peste 192 GB: stații de lucru —
  { id: 'llama4:maverick', size: '400B MoE', needGb: 246.3, quality: 86, tags: ['general', 'vision', 'moe'], activeB: 17 },
  { id: 'qwen3-coder:480b', size: '480B MoE', needGb: 291.8, quality: 92, tags: ['code', 'moe'], activeB: 35 },
  { id: 'deepseek-r1:671b', size: '671B MoE', needGb: 406.8, quality: 94, tags: ['reasoning', 'moe'], activeB: 37 },
  { id: 'deepseek-v3.1:671b', size: '671B MoE', needGb: 406.8, quality: 92, tags: ['general', 'code', 'moe'], activeB: 37 }
];

/** Cât din RAM poate fi folosită de model (restul rămâne sistemului / VS Code). */
const RAM_BUDGET_RATIO = 0.7;

/** Ce poate rula „bine" o mașină din fiecare tier (text pentru UI/raport). */
const TIER_TARGET: Record<HardwareTier, string> = {
  T0: '0.5-1.5B on the CPU',
  T1: '3-8B on the CPU',
  T2: '7-14B on the GPU, up to 20B on the CPU',
  T3: '14-32B on the GPU, up to 70B on the CPU',
  T4: '32-70B on the GPU, up to 120B MoE',
  T5: '70B-235B MoE',
  T6: '235B+ MoE (workstation class)'
};

export function tierTarget(tier: HardwareTier): string {
  return TIER_TARGET[tier];
}

export interface MemoryBudget {
  /** Memoria care rulează modelul integral pe GPU (VRAM dedicată / unificată). */
  vram: number;
  /** Totalul folosibil (VRAM + partea de RAM disponibilă pentru model). */
  total: number;
}

/**
 * Bugetul de memorie al mașinii. Pe Apple Silicon memoria e unificată, deci
 * modelul trebuie să încapă în aceeași memorie (nu se adună cu RAM-ul).
 */
export function modelMemoryBudget(hw: HardwareInfo): MemoryBudget {
  const ram = hw.ramGb > 0 ? hw.ramGb : 8;
  if (hw.unifiedMemoryGb > 0) {
    return { vram: hw.unifiedMemoryGb, total: hw.unifiedMemoryGb };
  }
  return { vram: hw.totalVramGb, total: hw.totalVramGb + ram * RAM_BUDGET_RATIO };
}

interface Scored {
  entry: CatalogEntry;
  fitsVram: boolean;
  speed: ModelSpeed;
  score: number;
}

/**
 * Evaluează un model pe mașina dată. `null` = nu încape deloc.
 *
 * Ideea: un model care intră integral în VRAM e „fast"; un MoE cu puțini
 * parametri activi e „medium" chiar și parțial pe CPU (ex: gpt-oss:20b, care
 * rulează bine pe 32 GB RAM); un model dens împins în RAM e „slow" — util,
 * dar de 5-10 ori mai lent, deci nu trebuie să bată variantele rapide.
 */
function scoreEntry(entry: CatalogEntry, hw: HardwareInfo): Scored | null {
  const budget = modelMemoryBudget(hw);
  if (entry.needGb > budget.total) return null;

  const fitsVram = budget.vram > 0 && entry.needGb <= budget.vram;
  if (fitsVram) return { entry, fitsVram, speed: 'fast', score: entry.quality };

  if (entry.activeB) {
    const cpuFriendly = entry.activeB <= 10;
    return {
      entry,
      fitsVram,
      speed: cpuFriendly ? 'medium' : 'slow',
      score: entry.quality * (cpuFriendly ? 0.9 : 0.75)
    };
  }
  return { entry, fitsVram, speed: 'slow', score: entry.quality * 0.55 };
}

/** Clasă de mărime — folosită ca recomandările să nu fie trei variante apropiate. */
function sizeClass(needGb: number): 0 | 1 | 2 | 3 {
  if (needGb < 8) return 0;
  if (needGb < 24) return 1;
  if (needGb < 64) return 2;
  return 3;
}

/** Viteza întâi, apoi calitatea: un model rapid e mai util decât unul mai bun dar lent. */
const SPEED_RANK: Record<ModelSpeed, number> = { fast: 0, medium: 1, slow: 2 };

function bySpeedThenScore(a: Scored, b: Scored): number {
  return SPEED_RANK[a.speed] - SPEED_RANK[b.speed] || b.score - a.score;
}

function whyText(s: Scored, hw: HardwareInfo): string {
  const budget = modelMemoryBudget(hw);
  const mem =
    hw.unifiedMemoryGb > 0 ? `${budget.vram} GB of unified memory` : `${budget.vram} GB VRAM`;
  if (s.speed === 'fast') return `fits in ${mem} — runs on the GPU`;
  if (s.speed === 'medium') {
    return budget.vram > 0
      ? `partly on the GPU; MoE with ${s.entry.activeB}B active params keeps the CPU part fast`
      : `MoE with ${s.entry.activeB}B active params — CPU-friendly, much faster than its size suggests`;
  }
  return budget.vram > 0
    ? `only partly in ${mem} — the rest runs on the CPU (slow, but it works)`
    : `fits in RAM and runs on the CPU (slow)`;
}

/**
 * v2.1.0: cele mai potrivite modele pentru mașina detectată. Ordinea e „întâi
 * viteza, apoi calitatea", iar din listă se alege câte un model pe clasă de
 * mărime, ca să nu primești trei variante apropiate: cel mai bun, o alternativă
 * de altă talie și o variantă rapidă. Se ține cont și de spațiul liber pe disc
 * (modelul trebuie și descărcat).
 */
export function recommendModels(hw: HardwareInfo, limit = 3): ModelRecommendation[] {
  const budget = modelMemoryBudget(hw);
  const fits = (m: CatalogEntry) => m.needGb <= budget.total;
  // ~20% peste mărimea modelului: blob-ul se descarcă înainte de a fi folosit
  const diskOk = (m: CatalogEntry) => hw.freeDiskGb <= 0 || m.needGb * 1.2 <= hw.freeDiskGb;

  let pool = MODEL_CATALOG.filter((m) => fits(m) && diskOk(m));
  if (!pool.length) pool = MODEL_CATALOG.filter(fits); // discul e prea mic — ignorăm filtrul
  if (!pool.length) pool = [MODEL_CATALOG[0]]; // mașină sub orice minim

  const scored = pool
    .map((m) => scoreEntry(m, hw))
    .filter((s): s is Scored => !!s)
    .sort(bySpeedThenScore);

  const picked: Scored[] = [];
  const usedClasses = new Set<number>();
  for (const s of scored) {
    const cls = sizeClass(s.entry.needGb);
    if (usedClasses.has(cls)) continue;
    usedClasses.add(cls);
    picked.push(s);
    if (picked.length >= limit) break;
  }
  for (const s of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(s)) picked.push(s);
  }

  return picked
    .sort(bySpeedThenScore)
    .slice(0, Math.max(1, limit))
    .map((s) => ({
      id: s.entry.id,
      size: s.entry.size,
      needGb: s.entry.needGb,
      fitsVram: s.fitsVram,
      why: whyText(s, hw),
      tags: [...s.entry.tags],
      speed: s.speed,
      minTier: minTierFor(s.entry.needGb)
    }));
}

/** Viteza estimată a unui model oarecare pe mașina dată (best-effort). */
export function modelSpeed(model: string, hw: HardwareInfo): ModelSpeed | null {
  const wanted = model.trim().toLowerCase();
  const entry = MODEL_CATALOG.find((m) => m.id.toLowerCase() === wanted);
  if (!entry) return null;
  return scoreEntry(entry, hw)?.speed ?? null;
}

/**
 * `true` dacă modelul (din catalog) încape în memoria mașinii — folosit pentru
 * eticheta „recommended" de pe modelele deja instalate. Vezi `modelSpeed`
 * pentru a afla și CÂT de repede rulează.
 */
export function fitsThisMachine(model: string, hw: HardwareInfo): boolean {
  const wanted = model.trim().toLowerCase();
  const entry = MODEL_CATALOG.find((m) => m.id.toLowerCase() === wanted);
  return !!entry && scoreEntry(entry, hw) !== null;
}

/**
 * v2.5.11 (bug #28): modelele de embeddings nu pot ține o conversație —
 * folosite doar de indexul semantic (`freekit.semanticIndex.model`).
 */
export function isEmbeddingModel(model: string): boolean {
  // v2.5.40 (bug #93): `bge-*` (BAAI General Embedding) lipsea din listă.
  return /embed|nomic|bge/i.test(String(model ?? ''));
}

/** Sub pragul ăsta modelul scrie prost cod real (improvizează, trunchiază). */
export const WEAK_MODEL_QUALITY = 45;
/** Și sub atâția parametri — indiferent de rating-ul din catalog. */
export const WEAK_MODEL_PARAMS_B = 3;

export interface ModelQuality {
  /** Eticheta de mărime din catalog: `1.5B`, `7B`, `3B MoE`. */
  size: string;
  /** Memoria aproximativă necesară (GB, Q4_K_M) — 0 dacă modelul nu e în catalog. */
  needGb: number;
  /** Rating de calitate comparabil (0-100) — 0 dacă modelul nu e în catalog. */
  quality: number;
  /** Numărul de parametri dedus din `size` (ex. `3B MoE` → 3). */
  paramsB: number;
  /** Prea mic pentru cod real: sub 3B sau calitate sub `WEAK_MODEL_QUALITY`. */
  weak: boolean;
  /** Model doar de embeddings (fără suport de conversație). */
  embedding: boolean;
}

/**
 * v2.5.11 (bug #28): „recommended" însemna doar „încape pe mașină" — un model
 * de 1.5B apărea recomandat, deși scrie prost. Întoarce rating-ul din catalog
 * (sau `embedding: true` pentru un id de embeddings necunoscut), ca UI-ul să
 * poată avertiza. `null` = model necunoscut, fără date.
 */
export function modelQuality(model: string): ModelQuality | null {
  const id = String(model ?? '').trim();
  if (!id) return null;
  const embedding = isEmbeddingModel(id);
  const wanted = id.toLowerCase();
  let entry = MODEL_CATALOG.find((m) => m.id.toLowerCase() === wanted);
  if (!entry && !wanted.includes(':')) {
    // id fără tag („llama3.2") → singurul tag din catalog cu acel prefix
    const prefixed = MODEL_CATALOG.filter((m) =>
      m.id.toLowerCase().startsWith(wanted + ':')
    );
    if (prefixed.length === 1) entry = prefixed[0];
  }
  if (!entry) {
    return embedding
      ? { size: '', needGb: 0, quality: 0, paramsB: 0, weak: false, embedding: true }
      : null;
  }
  const p = /^([\d.]+)B/.exec(entry.size.trim());
  const paramsB = p ? Number(p[1]) : 0;
  return {
    size: entry.size,
    needGb: entry.needGb,
    quality: entry.quality,
    paramsB,
    weak: !embedding && (paramsB < WEAK_MODEL_PARAMS_B || entry.quality < WEAK_MODEL_QUALITY),
    embedding
  };
}

/** Text scurt pentru UI / raport: „RTX 4060 · 8 GB VRAM · 32 GB RAM · T2". */
export function hardwareSummary(hw: HardwareInfo): string {
  const parts: string[] = [];
  const gpu = hw.gpus[0];
  if (gpu && hw.unifiedMemoryGb > 0) {
    parts.push(`${gpu.name} · ${hw.unifiedMemoryGb} GB unified`);
  } else if (gpu) {
    parts.push(gpu.vramGb != null ? `${gpu.name} · ${gpu.vramGb} GB VRAM` : gpu.name);
    if (hw.gpus.length > 1) parts.push(`${hw.totalVramGb} GB VRAM total`);
  } else {
    parts.push('no GPU detected');
  }
  parts.push(`${hw.ramGb} GB RAM`);
  parts.push(hw.tier);
  return parts.join(' · ');
}

/**
 * v2.5.11 (bug #29): mașinile fără GPU (T0/T1 sau VRAM 0) rulează modelele pe
 * CPU/RAM — greu, cu ventilator și baterie. Avertizează și indică providerii
 * web (cont gratuit, în browser) ca alternativă ușoară. `null` = hardware ok.
 */
export function hardwareAdvice(hw: HardwareInfo): string | null {
  if (hw.tier !== 'T0' && hw.tier !== 'T1' && hw.vramGb !== 0) return null;
  return (
    '⚠️ Local models run on CPU/RAM — heavy load, fan, shorter battery. ' +
    'For a lighter setup, use a web provider (DeepSeek, ChatGPT, Claude, ' +
    'Gemini, Mistral, Qwen) — free account, runs in browser, no CPU load.'
  );
}

/** v2.1.0: linii detaliate pentru raportul de status (toate GPU-urile, disc, VM). */
export function hardwareReport(hw: HardwareInfo): string[] {
  const budget = modelMemoryBudget(hw);
  const lines: string[] = [];
  lines.push(`  Tier: ${hw.tier} — ${tierTarget(hw.tier)}`);
  lines.push(`  CPU: ${hw.cpuModel} (${hw.cpuCores} threads)`);
  lines.push(
    `  RAM: ${hw.ramGb} GB (≈${Math.round(budget.total * 10) / 10} GB usable for a model)`
  );
  if (!hw.gpus.length) {
    lines.push('  GPU: none detected');
  } else {
    for (const g of hw.gpus) {
      const vram = g.vramGb != null ? `${g.vramGb} GB` : 'VRAM unknown';
      const bw = g.bandwidthGbps ? ` · ~${g.bandwidthGbps} GB/s` : '';
      lines.push(`  GPU: ${g.name} · ${vram} · ${g.vendor}/${g.type}${bw}`);
    }
    if (hw.gpus.length > 1) {
      lines.push(`  Total VRAM (discrete): ${hw.totalVramGb} GB`);
    }
    if (hw.unifiedMemoryGb > 0) {
      lines.push(`  Unified memory usable by a model: ${hw.unifiedMemoryGb} GB`);
    }
  }
  lines.push(
    hw.freeDiskGb > 0
      ? `  Disk free (Ollama models): ${hw.freeDiskGb} GB`
      : '  Disk free: unknown'
  );
  lines.push(`  Environment: ${hw.isVM ? 'virtual machine' : 'bare metal'}`);
  if (hw.note) lines.push(`  Note: ${hw.note}`);
  return lines;
}
