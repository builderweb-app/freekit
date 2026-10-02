import { chromium, BrowserContext, Page, CDPSession } from 'playwright';
import * as vscode from 'vscode';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logLine } from './log';
import { setChromeTaskbarHidden, winWindowSupported } from './winwindow';

const execFileAsync = promisify(execFile);
const log = (msg: string) => logLine('browser', msg);

// Domenii de chat AI cunoscute (pentru a reutiliza tab-ul potrivit)
const CHAT_HOSTS = [
  'chat.deepseek.com',
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'claude.ai'
];

/* =========================================================================
 * v0.3.0 (P0.1) — PORTABILITATE
 * Nimic specific utilizatorului nu mai e hardcodat:
 *   - executabilul Chrome/Edge e detectat automat per platformă
 *     (sau setat manual din freekit.chromePath)
 *   - profilul stă în globalStorage-ul extensiei, NU în folderul proiectului
 *   - portul CDP e configurabil (freekit.cdpPort, implicit 9222)
 * ========================================================================= */

/** Opțiunile browserului — injectate din extension.ts (citite live din setări). */
export interface BrowserOptions {
  /** Portul CDP (implicit 9222). */
  port: number;
  /** Directorul profilului dedicat (globalStorage). */
  profileDir: string;
  /** Override manual pentru executabil (gol = detectare automată). */
  chromePath?: string;
}

type OptionsProvider = () => BrowserOptions;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** v0.9.1: bounds pentru fereastra vizibilă (login) și pentru cea ascunsă. */
type WindowBounds = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState: 'normal' | 'minimized';
};

const ONSCREEN_BOUNDS: WindowBounds = {
  left: 60,
  top: 60,
  width: 1280,
  height: 900,
  windowState: 'normal'
};

/**
 * v1.8.0: starea „în fundal” — fereastra e MINIMIZATĂ (nu doar mutată
offscreen, care lăsa un buton vizibil în taskbar). Pe Windows butonul din
taskbar dispare complet prin WS_EX_TOOLWINDOW (vezi winwindow.ts).
 */
const MINIMIZED_BOUNDS: WindowBounds = {
  windowState: 'minimized'
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Candidații per platformă (Chrome întâi, apoi Edge). */
function platformCandidates(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'];
    const list = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe')
    ];
    if (local) {
      list.splice(2, 0, path.join(local, 'Google\\Chrome\\Application\\chrome.exe'));
    }
    return list;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  return [];
}

/** Echivalentul `which <nume>` pentru Linux (și fallback prin scanarea PATH). */
async function whichAny(names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync('which', [name]);
      const found = stdout.trim();
      if (found) return found;
    } catch {
      /* `which` lipsește sau binarul nu există — încercăm următorul */
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Detectează executabilul Chrome/Edge.
 * Windows: Program Files / Program Files (x86) / LOCALAPPDATA.
 * macOS: /Applications.
 * Linux: `which google-chrome / chromium / microsoft-edge` (+ scanare PATH).
 */
export async function detectBrowserPath(override?: string): Promise<string | null> {
  if (override) {
    if (await fileExists(override)) return override;
    log('freekit.chromePath nu există pe disc: ' + override + ' — trec la detectare automată');
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    for (const candidate of platformCandidates()) {
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  }
  return whichAny([
    'google-chrome',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'microsoft-edge-stable'
  ]);
}

/* =========================================================================
 * v2.0.5 — ANTI-THROTTLING LA NIVEL DE PAGINĂ
 * Fereastra Chrome stă minimizată în fundal, iar site-urile SPA își opresc
 * streaming-ul și timer-ele când `document.visibilityState` devine `hidden`
 * sau când pagina nu are focus. Din cauza asta, versiunile anterioare ridicau
 * fereastra în față la fiecare mesaj. Aici forțăm pagina să se creadă
 * vizibilă/focusată — per pagină, best-effort.
 * ========================================================================= */

/** Rulează ÎN PAGINĂ: raportează mereu pagina ca vizibilă și focusată. */
const forceVisibleInPage = (): void => {
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    });
    Object.defineProperty(Document.prototype, 'hidden', {
      configurable: true,
      get: () => false
    });
  } catch {
    /* suprapunerea nu e permisă — ignorăm */
  }
};

/** Sesiunile CDP rămân atașate: Chrome resetează suprapunerile la detașare. */
const visibilitySessions = new WeakMap<Page, CDPSession>();
/** Paginile cu init script-ul deja instalat (anti-duplicare). */
const visibilityScripts = new WeakSet<Page>();

/**
 * v2.0.5: forțează pagina să se comporte ca „vizibilă și activă” chiar și cu
 * fereastra minimizată. CDP nu expune un override direct al lui
 * `visibilityState` (nu există `Emulation.setPageVisibilityOverride`), așa că
 * folosim `Emulation.setFocusEmulationEnabled` (pagina se crede focusată și
 * activă), `Page.setWebLifecycleState: active` (împotriva înghețului) și un
 * override JS pentru `document.visibilityState` / `document.hidden`.
 */
export async function enableVisibilityOverride(pg: Page): Promise<void> {
  if (visibilitySessions.has(pg)) return;
  try {
    if (!visibilityScripts.has(pg)) {
      visibilityScripts.add(pg);
      await pg.addInitScript(forceVisibleInPage);
      await pg.evaluate<void, undefined>(forceVisibleInPage, undefined);
    }
    const cdp = await pg.context().newCDPSession(pg);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    // păstrăm sesiunea deschisă intenționat (vezi comentariul de mai sus)
    visibilitySessions.set(pg, cdp);
    log('visibility override activat (pagina rămâne activă în fundal)');
  } catch (e: any) {
    log('visibility override a eșuat (non-fatal): ' + (e?.message ?? String(e)));
  }
}

export class BrowserManager {
  private context?: BrowserContext;
  private page?: Page;
  /** v0.9.1: ascunderea automată programată de showTemporarily(). */
  private hideTimer?: NodeJS.Timeout;

  constructor(private readonly optsProvider: OptionsProvider) {}

  /** Opțiunile curente (citite live din setări la fiecare apel). */
  options(): BrowserOptions {
    return this.optsProvider();
  }

  private cdpUrl(): string {
    return 'http://127.0.0.1:' + this.options().port;
  }

  /** True dacă portul CDP răspunde. */
  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(this.cdpUrl() + '/json/version');
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Versiunea browserului conectat (ex: "Chrome/126.0..."), din /json/version. */
  async chromeVersion(): Promise<string | null> {
    try {
      const res = await fetch(this.cdpUrl() + '/json/version');
      if (!res.ok) return null;
      const data = (await res.json()) as { Browser?: string };
      return data?.Browser ?? null;
    } catch {
      return null;
    }
  }

  private async launchChrome(): Promise<void> {
    const opts = this.options();
    const exe = await detectBrowserPath(opts.chromePath);
    if (!exe) {
      throw new Error(
        'I could not find Chrome or Edge on this system. Install one of them or set the path manually in the freekit.chromePath setting.'
      );
    }
    await fs.mkdir(opts.profileDir, { recursive: true });

    const args = [
      '--remote-debugging-port=' + opts.port,
      '--user-data-dir=' + opts.profileDir,
      // Offscreen: dacă fereastra ajunge vizibilă (login/CAPTCHA), poziția e departe de ecran
      '--window-position=-32000,-32000',
      '--window-size=1280,900',
      // v1.8.0: pornește minimizat. ATENȚIE: cu --no-startup-window, fereastra
      // e creată mai târziu de Playwright și flag-ul e ignorat — minimizarea
      // reală se face după conectare, prin CDP (applyHiddenState, vezi ensureOpen).
      '--start-minimized',
      // Nu porni cu tab în față
      '--no-startup-window',
      '--no-first-run',
      '--no-default-browser-check',
      // Reduce zgomotul
      // v2.0.5: CalculateNativeWinOcclusion oprește detecția de ocluzie de pe
      // Windows (fereastra minimizată nu mai e tratată ca ascunsă). Stă în
      // ACELAȘI --disable-features: Chrome păstrează doar ultima valoare a
      // flag-ului, deci un al doilea --disable-features ar re-activa Translate.
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
      '--disable-background-networking',
      // v2.0.5: păstrează randarea/timer-ele active cât fereastra e în fundal —
      // de-aia NU mai e nevoie s-o aducem în față la fiecare mesaj.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      // Anti-detect (păstrat din implementarea existentă)
      '--disable-blink-features=AutomationControlled'
    ];

    log('lansez ' + exe + ' pe portul ' + opts.port + ' (profil: ' + opts.profileDir + ')');
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Așteptăm până portul răspunde (max 20 secunde)
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await this.isRunning()) return;
    }
    throw new Error(
      'Chrome did not respond on port ' + opts.port + ' within 20 seconds ' +
        '(the port may be occupied by another process — change freekit.cdpPort).'
    );
  }

  async ensureOpen(preferHost?: string): Promise<Page> {
    if (
      this.page &&
      !this.page.isClosed() &&
      (!preferHost || this.page.url().includes(preferHost))
    ) {
      // v2.0.5: reafirmă anti-throttling-ul (ieftin — no-op dacă e deja activ)
      await enableVisibilityOverride(this.page);
      return this.page;
    }

    let launched = false;
    if (!(await this.isRunning())) {
      vscode.window.showInformationMessage(
        'Starting Chrome with the Freekit profile (running in the background)...'
      );
      await this.launchChrome();
      launched = true;
    }

    try {
      const browser = await chromium.connectOverCDP(this.cdpUrl());
      this.context = browser.contexts()[0];
      if (!this.context) throw new Error('No browser context');

      const pages = this.context.pages();
      let existing = preferHost
        ? pages.find((p) => p.url().includes(preferHost))
        : undefined;
      if (!existing) {
        existing = pages.find((p) =>
          CHAT_HOSTS.some((h) => p.url().includes(h))
        );
      }
      if (!existing) {
        existing = pages.find(
          (p) => p.url().startsWith('http') && !p.url().includes('sign_in')
        );
      }
      const page =
        existing ?? pages[pages.length - 1] ?? (await this.context.newPage());
      this.page = page;
      if (launched) {
        // v1.8.0: aplică starea „în fundal” abia acum — fereastra există, deci
        // poate fi minimizată (CDP) și scoasă din taskbar (Windows).
        await this.applyHiddenState(page).catch((e) =>
          log('applyHiddenState a eșuat: ' + (e?.message ?? String(e)))
        );
      }
      // v2.0.5: fereastra poate sta în fundal — randarea rămâne activă
      await enableVisibilityOverride(page);
      return page;
    } catch (e: any) {
      const msg = 'Chrome connection error: ' + (e?.message ?? String(e));
      vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }
  }

  /**
   * v0.3.0 (P0.3): închide REAL browserul.
   * browser.close() pe connectOverCDP doar deconectează — așa că:
   *   1) încercăm CDP `Browser.close` (închidere grațioasă);
   *   2) dacă portul tot răspunde, omorâm procesul care ascultă pe port
   *      (netstat+taskkill pe Windows; lsof/fuser pe macOS/Linux).
   * 
   * @returns true dacă browserul e închis (sau nu rula deloc).
   */
  async close(): Promise<boolean> {
    const opts = this.options();
    this.cancelScheduledHide();
    this.context = undefined;
    this.page = undefined;

    if (!(await this.isRunning())) {
      log('close: Chrome nu rula pe portul ' + opts.port);
      return true;
    }

    // 1) închidere grațioasă prin CDP
    try {
      const browser = await chromium.connectOverCDP(this.cdpUrl());
      const ctx = browser.contexts()[0];
      if (ctx) {
        const pg = ctx.pages()[0] ?? (await ctx.newPage().catch(() => undefined));
        if (pg) {
          const cdp = await pg.context().newCDPSession(pg);
          await cdp.send('Browser.close');
          log('Browser.close trimis prin CDP');
        }
      }
    } catch (e: any) {
      log('Browser.close a eșuat: ' + (e?.message ?? String(e)));
    }
    if (await this.waitUntilClosed(3000)) {
      log('Chrome închis (CDP)');
      return true;
    }

    // 2) fallback dur: procesul care ascultă pe portul CDP
    log('fallback: închid procesul de pe portul ' + opts.port);
    if (process.platform === 'win32') {
      await killByPortWindows(opts.port);
    } else {
      await killByPortUnix(opts.port);
    }
    const closed = await this.waitUntilClosed(4000);
    log(closed ? 'Chrome închis (kill pe port)' : 'Chrome încă rulează după kill');
    return closed;
  }

  /** Doar deconectare (la dezactivarea extensiei) — NU omorâm browserul. */
  disconnect(): void {
    this.cancelScheduledHide();
    this.context = undefined;
    this.page = undefined;
  }

  /* ========================================================================
   * v0.4.0 — Show Chrome: aduce fereastra din fundal (minimizată / la
   * -32000,-32000) înapoi în ecran și o activează. Pornește Chrome dacă nu
   * rulează (apoi o mută).
   * ======================================================================== */

  /** Aduce fereastra Chrome în față. Nu aruncă — întoarce { ok, message }. */
  async show(): Promise<{ ok: boolean; message: string }> {
    const opts = this.options();
    const wasRunning = await this.isRunning();
    try {
      if (!wasRunning) {
        log('show: Chrome nu rula — îl pornesc pe portul ' + opts.port);
        await this.launchChrome();
      }
      const browser = await chromium.connectOverCDP(this.cdpUrl());
      const ctx = browser.contexts()[0];
      if (!ctx) {
        return {
          ok: false,
          message: 'Chrome rulează, dar nu are nicio fereastră (context) disponibilă.'
        };
      }
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const pg = pages[0] ?? (await ctx.newPage());
      const moved = await this.bringWindowOnScreen(pg);
      if (!moved) {
        return {
          ok: false,
          message: 'CDP nu a putut muta fereastra Chrome în ecran.'
        };
      }
      log('show: fereastra adusă în față');
      return {
        ok: true,
        message: wasRunning
          ? 'The Chrome window was brought to the front.'
          : 'Chrome was started and the window is now visible.'
      };
    } catch (e: any) {
      const msg = 'Nu am putut afișa Chrome: ' + (e?.message ?? String(e));
      log(msg);
      return { ok: false, message: msg };
    }
  }

  /* ========================================================================
   * v0.9.1 — showTemporarily / hideOffscreen: asistentul de LOGIN/CAPTCHA.
   * Când un provider cere autentificare (sau rezolvarea unui CAPTCHA),
   * fereastra din fundal e adusă în față pentru utilizator, iar la final e
   * trimisă înapoi în fundal (minimizată + fără buton în taskbar, v1.8.0).
   * ======================================================================== */

  /** Aduce fereastra în față și o ascunde automat (fundal) după `ms`. */
  async showTemporarily(ms = 30000): Promise<{ ok: boolean; message: string }> {
    const res = await this.show();
    if (res.ok) {
      this.scheduleHide(ms);
      log('showTemporarily: fereastra rămâne vizibilă cel mult ' + ms + 'ms');
    }
    return res;
  }

  /** Ascunde imediat fereastra în fundal (minimizată) — anulează ascunderea programată. */
  async hideOffscreen(): Promise<{ ok: boolean; message: string }> {
    this.cancelScheduledHide();
    return this.hideToBackground();
  }

  private scheduleHide(ms: number): void {
    this.cancelScheduledHide();
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      void this.hideToBackground();
    }, Math.max(1000, ms));
    // nu ține procesul Node în viață doar pentru acest timer
    this.hideTimer.unref?.();
  }

  private cancelScheduledHide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
    }
  }

  /**
   * v1.8.0: fereastra trece în fundal — minimizată via CDP, iar pe Windows
   * butonul dispare complet din taskbar (WS_EX_TOOLWINDOW). Înlocuiește vechea
   * mutare la -32000,-32000, care lăsa un buton vizibil în taskbar.
   */
  private async hideToBackground(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!(await this.isRunning())) {
        return { ok: true, message: 'Chrome is not running.' };
      }
      const browser = await chromium.connectOverCDP(this.cdpUrl());
      const ctx = browser.contexts()[0];
      if (!ctx) {
        return {
          ok: false,
          message: 'Chrome rulează, dar nu are nicio fereastră (context).'
        };
      }
      const pages = ctx.pages().filter((p) => !p.isClosed());
      const pg = pages[0] ?? (await ctx.newPage());
      await this.applyHiddenState(pg);
      log('hideToBackground: fereastra minimizată (fundal)');
      return { ok: true, message: 'The Chrome window has returned to the background (minimized).' };
    } catch (e: any) {
      const msg = 'Nu am putut ascunde Chrome: ' + (e?.message ?? String(e));
      log(msg);
      return { ok: false, message: msg };
    }
  }

  /**
   * v1.8.0: starea „în fundal” = minimizat (CDP) + fără buton în taskbar
   * (Windows, best-effort). Fereastra continuă să randeze pagina normal —
   * verificat: JS-ul rulează, visibilityState rămâne 'visible'.
   */
  private async applyHiddenState(pg: Page): Promise<void> {
    const minimized = await this.setWindowBounds(pg, MINIMIZED_BOUNDS, false);
    if (!minimized) log('applyHiddenState: CDP nu a putut minimiza fereastra');
    if (winWindowSupported()) {
      const pid = await this.listenerPid();
      if (pid) {
        const hidden = await setChromeTaskbarHidden(pid, true);
        if (!hidden) {
          log('applyHiddenState: scoaterea din taskbar a eșuat (fereastra rămâne minimizată)');
        }
      }
    }
  }

  /** v1.8.0: PID-ul procesului care ascultă pe portul CDP (Windows; pentru taskbar). */
  private async listenerPid(): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (
          parts.length >= 5 &&
          parts[0].toUpperCase().startsWith('TCP') &&
          parts[1].endsWith(':' + this.options().port) &&
          parts[3].toUpperCase() === 'LISTENING'
        ) {
          const pid = Number(parts[4]);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
    } catch (e: any) {
      log('listenerPid a eșuat: ' + (e?.message ?? String(e)));
    }
    return null;
  }

  /**
   * Mută fereastra în ecran (CDP Browser.getWindowForTarget +
   * Browser.setWindowBounds) și activează tab-ul. v1.8.0: readuce întâi
   * butonul în taskbar (Windows) și „de-minimizează” fereastra.
   */
  private async bringWindowOnScreen(pg: Page): Promise<boolean> {
    if (winWindowSupported()) {
      const pid = await this.listenerPid();
      if (pid) {
        // best-effort: dacă eșuează, fereastra apare oricum (doar fără buton)
        await setChromeTaskbarHidden(pid, false);
      }
    }
    return this.setWindowBounds(pg, ONSCREEN_BOUNDS, true);
  }

  /**
   * Setează bounds-ul ferestrei care conține pagina `pg`. Încearcă întâi
   * sesiunea CDP a paginii; dacă Browser.* nu e permisă acolo, folosește o
   * sesiune la nivel de browser + Target.getTargets.
   */
  private async setWindowBounds(
    pg: Page,
    bounds: WindowBounds,
    bringToFront: boolean
  ): Promise<boolean> {
    try {
      const cdp = await pg.context().newCDPSession(pg);
      try {
        const { windowId } = (await cdp.send('Browser.getWindowForTarget', {})) as {
          windowId: number;
        };
        // adapter: metoda e dinamică („Browser.setWindowBounds” în ambii pași),
        // dar Playwright tipizează send() pe chei concrete
        const sendAny = (m: string, p?: object): Promise<unknown> =>
          (cdp.send as unknown as (m: string, p?: object) => Promise<unknown>)(m, p);
        await this.applyBoundsVia(sendAny, windowId, bounds);
        if (bringToFront) {
          try {
            await cdp.send('Page.bringToFront');
          } catch {
            /* focus best-effort */
          }
        }
        return true;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch (e: any) {
      log('setWindowBounds (sesiune pagină) a eșuat: ' + (e?.message ?? String(e)));
    }

    try {
      const browser = pg.context().browser();
      if (!browser) return false;
      const bcdp = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = (await bcdp.send('Target.getTargets')) as {
          targetInfos: Array<{ targetId: string; type: string }>;
        };
        const target = (targetInfos || []).find((t) => t.type === 'page');
        if (!target) return false;
        const { windowId } = (await bcdp.send('Browser.getWindowForTarget', {
          targetId: target.targetId
        })) as { windowId: number };
        const sendAny = (m: string, p?: object): Promise<unknown> =>
          (bcdp.send as unknown as (m: string, p?: object) => Promise<unknown>)(m, p);
        await this.applyBoundsVia(sendAny, windowId, bounds);
        return true;
      } finally {
        await bcdp.detach().catch(() => undefined);
      }
    } catch (e: any) {
      log('setWindowBounds (sesiune browser) a eșuat: ' + (e?.message ?? String(e)));
      return false;
    }
  }

  /**
   * v1.8.0: aplică bounds-ul în doi pași — CDP interzice combinarea lui
   * `windowState` cu geometria ({left, top, width, height}). Întâi starea
   * (normal / minimized), apoi poziția + dimensiunea (restaurarea din
   * minimized funcționează doar așa; verificat E2E).
   */
  private async applyBoundsVia(
    send: (method: string, params?: object) => Promise<unknown>,
    windowId: number,
    bounds: WindowBounds
  ): Promise<void> {
    if (bounds.windowState === 'minimized') {
      await send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' }
      });
      return;
    }
    await send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' }
    });
    const geometry: Record<string, number> = {};
    if (bounds.left !== undefined) geometry.left = bounds.left;
    if (bounds.top !== undefined) geometry.top = bounds.top;
    if (bounds.width !== undefined) geometry.width = bounds.width;
    if (bounds.height !== undefined) geometry.height = bounds.height;
    if (Object.keys(geometry).length) {
      await send('Browser.setWindowBounds', { windowId, bounds: geometry });
    }
  }

  private async waitUntilClosed(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isRunning())) return true;
      await sleep(250);
    }
    return !(await this.isRunning());
  }
}

/* =========================================================================
 * v0.3.0 (P0.3): închidere forțată a procesului care ascultă pe portul CDP
 * ========================================================================= */

async function killByPortWindows(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (
        parts.length >= 5 &&
        parts[0].toUpperCase().startsWith('TCP') &&
        parts[1].endsWith(':' + port) &&
        parts[3].toUpperCase() === 'LISTENING'
      ) {
        pids.add(parts[4]);
      }
    }
    if (!pids.size) {
      log('niciun proces LISTENING pe portul ' + port);
      return;
    }
    for (const pid of pids) {
      log('taskkill /PID ' + pid + ' /T /F');
      try {
        await execFileAsync('taskkill', ['/PID', pid, '/T', '/F']);
      } catch (e: any) {
        log('taskkill a eșuat: ' + (e?.message ?? String(e)));
      }
    }
  } catch (e: any) {
    log('netstat a eșuat: ' + (e?.message ?? String(e)));
  }
}

async function killByPortUnix(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-ti', 'tcp:' + port]);
    const pids = stdout.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      log('kill -9 ' + pid);
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* proces deja mort */
      }
    }
    if (pids.length) return;
  } catch {
    /* lsof lipsește — încercăm fuser */
  }
  try {
    await execFileAsync('fuser', ['-k', port + '/tcp']);
  } catch (e: any) {
    log('fuser a eșuat: ' + (e?.message ?? String(e)));
  }
}