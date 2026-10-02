import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logLine } from './log';

const execFileAsync = promisify(execFile);
const log = (msg: string) => logLine('winwindow', msg);

/* =========================================================================
 * v1.8.0 — CHROME COMPLET ÎN FUNDAL (Windows)
 * Fereastra offscreen (-32000,-32000) rămânea vizibilă în taskbar. Soluția:
 * WS_EX_TOOLWINDOW pe fereastra principală Chrome (via user32.dll, prin
 * PowerShell + Add-Type — același tipar ca recorderul audio nativ din v1.7.3):
 *   - butonul dispare COMPLET din taskbar și din Alt+Tab;
 *   - Chrome continuă să randeze normal (fereastra rămâne „vizibilă" pentru
 *     pagina web — visibilityState rămâne 'visible', timer-ele rulează);
 *   - reversibil: flag-ul e scos când fereastra trebuie arătată (login/CAPTCHA).
 * Best-effort: orice eșec e logat și ignorat (fereastra rămâne doar minimizată).
 * ========================================================================= */

/** Versiunea scriptului PS generat (o creștem când schimbăm conținutul). */
const SCRIPT_VERSION = '1';

/**
 * Script PowerShell (ASCII-only — PowerShell 5.1 citește .ps1 fără BOM ca ANSI):
 * găsește fereastra principală Chrome printre procesele copil ale PID-ului
 * browserului și comută flag-ul WS_EX_TOOLWINDOW.
 */
const PS_SCRIPT = `param(
  [string]$Action = 'hide',
  [int]$RootPid = 0
)

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FreekitWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  // fereastra principala: fara owner, preferam titlu non-gol (fereastra reala Chrome)
  public static IntPtr FindMainWindow(int[] pids) {
    var set = new HashSet<int>(pids);
    IntPtr best = IntPtr.Zero;
    int bestScore = -1;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint procId = 0;
      GetWindowThreadProcessId(h, out procId);
      if (!set.Contains((int)procId)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int score = 0;
      if (GetWindowTextLength(h) > 0) score += 2;
      if (IsWindowVisible(h)) score += 1;
      if (score > bestScore) { bestScore = score; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@

$SWP = 0x27   # NOSIZE | NOMOVE | NOZORDER | FRAMECHANGED

function Get-Descendants([int]$Root) {
  $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[int]'
  $null = $set.Add($Root)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) {
        $null = $set.Add([int]$p.ProcessId)
        $changed = $true
      }
    }
  }
  return @($set)
}

$desc = Get-Descendants -Root $RootPid
$hwnd = [FreekitWin]::FindMainWindow([int[]]$desc)
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output (@{ ok = $false; error = 'no-window' } | ConvertTo-Json -Compress)
  exit 0
}

$ex = [FreekitWin]::GetWindowLong($hwnd, -20)
if ($Action -eq 'hide') {
  $new = ($ex -bor 0x80) -band (-bnot 0x40000)     # + WS_EX_TOOLWINDOW, - WS_EX_APPWINDOW
} else {
  $new = $ex -band (-bnot 0x80)                    # - WS_EX_TOOLWINDOW
}
[void][FreekitWin]::SetWindowLong($hwnd, -20, $new)
[void][FreekitWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, $SWP)
$ex2 = [FreekitWin]::GetWindowLong($hwnd, -20)
Write-Output ('{"ok":true,"hwnd":"0x' + $hwnd.ToInt64().ToString('X') + '","exBefore":' + $ex + ',"exAfter":' + $ex2 + '}')
`;

let scriptPath: string | null = null;

/** Scrie scriptul PS în %TEMP% (o singură dată per proces) și întoarce calea. */
function ensureScript(): string {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const dir = path.join(os.tmpdir(), 'freekit-win');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'winwindow-v' + SCRIPT_VERSION + '.ps1');
  fs.writeFileSync(file, PS_SCRIPT, 'utf8');
  scriptPath = file;
  return file;
}

/** true doar pe Windows (singura platformă unde avem nevoie de trucul de taskbar). */
export function winWindowSupported(): boolean {
  return process.platform === 'win32';
}

/**
 * Ascunde (hidden=true) sau readuce (hidden=false) butonul ferestrei Chrome
 * din taskbar. Best-effort — nu aruncă niciodată.
 */
export async function setChromeTaskbarHidden(
  rootPid: number,
  hidden: boolean,
  timeoutMs = 15000
): Promise<boolean> {
  if (!winWindowSupported() || !rootPid) return false;
  try {
    const script = ensureScript();
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-Action', hidden ? 'hide' : 'show',
        '-RootPid', String(rootPid)
      ],
      { timeout: timeoutMs, windowsHide: true }
    );
    const line = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'))
      .pop();
    if (!line) {
      log('fără răspuns JSON (hidden=' + hidden + ')');
      return false;
    }
    const res = JSON.parse(line) as { ok?: boolean; hwnd?: string; error?: string };
    if (!res.ok) {
      log('eșec (hidden=' + hidden + '): ' + (res.error ?? 'necunoscut'));
      return false;
    }
    log('ok (hidden=' + hidden + ', hwnd=' + res.hwnd + ')');
    return true;
  } catch (e: any) {
    log('setChromeTaskbarHidden a eșuat: ' + (e?.message ?? String(e)));
    return false;
  }
}
