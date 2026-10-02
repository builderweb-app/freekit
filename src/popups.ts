import type { Page } from 'playwright';

/* =========================================================================
 * v1.8.0 — AUTO-ACCEPT POPUP-URI (cookie / terms / OK / „Got it”)
 * Închide automat bannerele de consimțământ înainte să scriem în chat și
 * după încărcarea unei pagini noi. Reguli de siguranță (nimic agresiv):
 *   - doar elemente vizibile (buton / [role=button] / input submit / link);
 *   - potrivire EXACTĂ pe textul normalizat (litere+cifre), pe 3 niveluri:
 *     strong („accept all”…) > medium („accept”, „i agree”, „got it”…) >
 *     weak („ok”, doar în dialog/banner/modal);
 *   - linkurile (<a>) se acceptă doar pentru textele strong;
 *   - orice text care sună a refuz (reject / necessary / later / close…)
 *     este ignorat complet;
 *   - maximum 3 click-uri per apel (un banner nu poate declanșa o buclă).
 * Setarea `freekit.autoAcceptPopups` (implicit true) dezactivează totul.
 * ========================================================================= */

export interface PopupSettings {
  /** freekit.autoAcceptPopups — închide automat popup-urile de consimțământ. */
  enabled: boolean;
}

const DEFAULT_SETTINGS: PopupSettings = { enabled: true };

/** Setările popup-urilor (require lazy de vscode — teste Node safe). */
export function popupSettings(): PopupSettings {
  try {
    const v = require('vscode') as typeof import('vscode');
    const cfg = v.workspace.getConfiguration('freekit');
    return { enabled: cfg.get<boolean>('autoAcceptPopups', true) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Textele pe niveluri (după normalizare). */
export const STRONG_TEXTS = [
  'accept all',
  'accept all cookies',
  'accept cookies',
  'accept all and continue',
  'agree to all',
  'allow all',
  'allow all cookies',
  'acceptă toate',
  'accept toate',
  'acceptati toate',
  'acceptați toate',
  'acceptă toate cookie urile',
  'accept toate cookie urile'
];

export const MEDIUM_TEXTS = [
  'accept',
  'acceptă',
  'accepta',
  'acceptați',
  'acceptati',
  'i accept',
  'i agree',
  'agree',
  'got it',
  'allow',
  'allow cookies',
  'de acord',
  'acord',
  'accept and continue',
  'accept și continuă',
  'accept si continua'
];

export const WEAK_TEXTS = ['ok', 'okay', 'am înțeles', 'am inteles', 'înțeleg', 'inteleg'];

/**
 * Cuvinte care descalifică un element („Reject all”, „Only necessary”,
 * „Customize”, „Not now”, „Close”…). Sursa regex e partajată cu scanarea
 * in-page (funcția serializată nu poate închide peste constante).
 */
export const EXCLUDE_REGEX_SOURCE =
  '(?:reject|decline|refus|deny|resping|refuz|anulea|renun[tț]|necessary|essential|necesar|esential|only|customiz|manage|settings|preferin|not now|no thanks|nu, mul|mul[tț]umesc|t[âa]rziu|later|skip|close|inchide|închide)';

/** Normalizare: litere mici, doar litere/cifre/spații (scoate emoji, săgeți, punctuație). */
export function normalizePopupText(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true dacă textul (deja normalizat) sună a refuz/altă acțiune — nu îl atingem. */
export function isExcludedPopupText(normalized: string): boolean {
  return new RegExp('(^|[^\\p{L}])' + EXCLUDE_REGEX_SOURCE, 'u').test(normalized);
}

/**
 * Nivelul de încredere al unui text: 3 = strong, 2 = medium, 1 = weak, 0 = nimic.
 * Pur (fără DOM) — testabil direct în Node.
 */
export function popupIntent(rawText: string): number {
  const text = normalizePopupText(rawText);
  if (!text || isExcludedPopupText(text)) return 0;
  if (STRONG_TEXTS.includes(text)) return 3;
  if (MEDIUM_TEXTS.includes(text)) return 2;
  if (WEAK_TEXTS.includes(text)) return 1;
  return 0;
}

interface ScanArgs {
  strong: string[];
  medium: string[];
  weak: string[];
  excludeSource: string;
}

interface ClickOutcome {
  text: string;
  tier: number;
}

/**
 * Rulează ÎN PAGINĂ: găsește cel mai bun buton de acceptare vizibil și dă
 * click pe el. Întoarce textul apăsat sau null. (Serializată de Playwright —
 * toate constantele vin prin `args`.)
 */
const scanPopupsInPage = (args: ScanArgs): ClickOutcome | null => {
  const norm = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const exclRe = new RegExp('(^|[^\\p{L}])' + args.excludeSource, 'u');
  const containerSel =
    '[role="dialog"],[role="alertdialog"],[role="alert"],dialog,' +
    '[class*="modal" i],[class*="cookie" i],[class*="consent" i],[class*="banner" i],' +
    '[class*="popup" i],[class*="overlay" i],[class*="notice" i],[class*="toast" i],[class*="alert" i]';
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };

  const candidates: Array<{ el: HTMLElement; tier: number; text: string; isButton: boolean }> = [];
  const els = Array.prototype.slice.call(
    document.querySelectorAll(
      'button,[role="button"],a,input[type="button"],input[type="submit"]'
    )
  ) as HTMLElement[];

  for (const el of els) {
    if ((el as unknown as { disabled?: boolean }).disabled) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    if (el.getAttribute('data-freekit-accepted')) continue; // deja apăsat de noi (anti-dublare)
    if (!isVisible(el)) continue;

    const texts = [
      el.tagName === 'INPUT' ? (el as HTMLInputElement).value : (el as HTMLElement).innerText,
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('title') ?? ''
    ];
    let tier = 0;
    let chosen = '';
    for (const raw of texts) {
      const n = norm(raw);
      if (!n || exclRe.test(n)) continue;
      const tr = args.strong.includes(n) ? 3 : args.medium.includes(n) ? 2 : args.weak.includes(n) ? 1 : 0;
      if (tr > tier) {
        tier = tr;
        chosen = n;
      }
    }
    if (!tier) continue;

    const isLink = el.tagName === 'A';
    if (isLink && tier < 3) continue; // linkurile doar pentru texte foarte sigure
    if (tier === 1 && !el.closest(containerSel)) continue; // „OK” doar în dialog/banner
    const isButton = el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button';
    candidates.push({ el, tier, text: chosen, isButton });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.tier - a.tier || Number(b.isButton) - Number(a.isButton));
  const winner = candidates[0];
  // marcăm elementul ÎNAINTE de click: același buton nu mai e apăsat a doua
  // oară în rundele următoare (bannere care nu dispar din DOM)
  winner.el.setAttribute('data-freekit-accepted', '1');
  try {
    winner.el.click();
  } catch {
    return null;
  }
  return { text: winner.text, tier: winner.tier };
};

export interface AutoAcceptOptions {
  /** Câte runde de scanare+click (implicit 3). */
  maxRounds?: number;
  /** Log opțional (ex: logLine). */
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Închide popup-urile de consimțământ găsite în pagină (inclusiv în iframe-uri:
 * consimțământul Google trăiește într-un iframe cross-origin). Întoarce
 * textele apăsate (gol = nimic găsit sau funcția dezactivată). Nu aruncă niciodată.
 */
export async function autoAcceptPopups(
  page: Page,
  opts: AutoAcceptOptions = {}
): Promise<string[]> {
  const accepted: string[] = [];
  try {
    if (!popupSettings().enabled) return accepted;
    const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 3, 5));
    const args: ScanArgs = {
      strong: STRONG_TEXTS,
      medium: MEDIUM_TEXTS,
      weak: WEAK_TEXTS,
      excludeSource: EXCLUDE_REGEX_SOURCE
    };
    for (let round = 0; round < maxRounds; round++) {
      let clicked: ClickOutcome | null = null;
      for (const frame of page.frames()) {
        try {
          const res = await frame.evaluate(scanPopupsInPage, args);
          if (res) {
            clicked = res;
            break;
          }
        } catch {
          /* frame detașat / navigare în curs */
        }
      }
      if (!clicked) break;
      accepted.push(clicked.text);
      opts.log?.('popup închis: „' + clicked.text + '" (nivel ' + clicked.tier + ')');
      await sleep(800);
    }
  } catch (e: any) {
    opts.log?.('autoAcceptPopups a eșuat: ' + (e?.message ?? String(e)));
  }
  return accepted;
}
