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
  /** freekit.dismissPromoPopups - inchide overlay-urile promo/upsell. */
  dismissPromos: boolean;
}

const DEFAULT_SETTINGS: PopupSettings = { enabled: true, dismissPromos: true };

/** Setările popup-urilor (require lazy de vscode — teste Node safe). */
export function popupSettings(): PopupSettings {
  try {
    const v = require('vscode') as typeof import('vscode');
    const cfg = v.workspace.getConfiguration('freekit');
    return {
      enabled: cfg.get<boolean>('autoAcceptPopups', true),
      dismissPromos: cfg.get<boolean>('dismissPromoPopups', true)
    };
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

/* =========================================================================
 * v2.9.6 - INCHIDE OVERLAY-URILE PROMO / UPSELL ("publicitate")
 *
 * ChatGPT deschide un modal de pricing ("Try Plus free for 1 month", cu
 * "Ad supported" la planul Free) cand se apasa "Free offer" / "Claim offer"
 * sau cand pagina e reluata cu `#pricing` in URL. Modalul acopera composerul,
 * iar `autoAcceptPopups` NU il atinge: butonul lui are `aria-label="Close
 * pricing"`, iar "close" e exclus intentionat la consimtamant. Aici il
 * inchidem tintit:
 *   - doar overlay-uri VIZIBILE si mari (dialog / aria-modal / pricing);
 *   - doar daca textul overlay-ului suna a promo (upgrade/pricing/offer/...);
 *   - doar controale de inchidere ("Close pricing", "Dismiss", "Not now"...);
 *     CTA-urile de cumparare ("Claim offer", "Upgrade"...) nu sunt apasate;
 *   - maximum 2 click-uri, plus Escape o singura data daca nu exista buton.
 * Setarea `freekit.dismissPromoPopups` (implicit true) dezactiveaza totul.
 * ========================================================================= */

/** Semnaturile de text care arata ca un dialog este promo/upsell. */
export const PROMO_CONTEXT_REGEX_SOURCE =
  '(?:upgrade|pricing|free offer|claim offer|special offer|limited time|' +
  'free trial|subscri\\w*|ad[ -]supported|no ads|billing|promo\\w*|discount|' +
  'your plan|see all plans|compare plans|ofert\\w*|reducere|abonament|publicitate)';

/** Anunturi de functii noi ("Now you can make GIFs with ChatGPT"). */
export const ANNOUNCEMENT_CONTEXT_REGEX_SOURCE =
  '(?:what s new|whats new|new feature|introducing|now you can|you can now|' +
  'available now|now available|just launched|is here|are here|rolling out|' +
  'say hello to)';

/** "GIF" singur e prea larg; cere si un verb de actiune in acelasi dialog. */
export const GIF_CONTEXT_REGEX_SOURCE = '\\bgifs?\\b';
export const GIF_ACTION_REGEX_SOURCE =
  '\\b(?:make|create|generate|try|new|now|with chatgpt)\\b';

/** Texte exacte (normalizate, ASCII) care inchid un overlay promo. */
export const PROMO_DISMISS_TEXTS = [
  'close',
  'close dialog',
  'close popup',
  'dismiss',
  'dismiss banner',
  'not now',
  'no thanks',
  'no thank you',
  'maybe later',
  'later',
  'remind me later',
  'not right now',
  'skip',
  'skip for now',
  'stay on free plan',
  'continue with free',
  'continue with free plan',
  'got it',
  'ok',
  'okay',
  'inchide',
  'nu acum',
  'nu multumesc',
  'mai tarziu'
];

/** Pliere ASCII pentru potrivire, ca lista sa ramana fara diacritice. */
function foldAscii(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0103\u00e2]/g, 'a')
    .replace(/\u00ee/g, 'i')
    .replace(/[\u0219\u015f]/g, 's')
    .replace(/[\u021b\u0163]/g, 't');
}

/** true daca textul (brut) arata a promo/upsell sau anunt de functie noua. */
export function isPromoDialogText(raw: string): boolean {
  const text = foldAscii(normalizePopupText(raw));
  if (!text) return false;
  if (new RegExp(PROMO_CONTEXT_REGEX_SOURCE, 'i').test(text)) return true;
  if (new RegExp(ANNOUNCEMENT_CONTEXT_REGEX_SOURCE, 'i').test(text)) return true;
  return (
    new RegExp(GIF_CONTEXT_REGEX_SOURCE, 'i').test(text) &&
    new RegExp(GIF_ACTION_REGEX_SOURCE, 'i').test(text)
  );
}

/** true daca textul e un control sigur de inchidere a unui overlay promo. */
export function promoDismissIntent(rawText: string): boolean {
  const text = foldAscii(normalizePopupText(rawText));
  if (!text) return false;
  if (PROMO_DISMISS_TEXTS.includes(text)) return true;
  return (
    /^(close|dismiss)\b/.test(text) &&
    !/\b(claim|upgrade|buy|subscribe|purchase)\b/.test(text)
  );
}

interface PromoScanArgs {
  dismissTexts: string[];
  promoSource: string;
  announceSource: string;
  gifSource: string;
  gifActionSource: string;
}

interface PromoOutcome {
  /** Textul butonului apasat, sau null cand overlay-ul nu are buton vizibil. */
  closed: string | null;
  /** true cand a fost gasit un overlay promo vizibil. */
  overlay: boolean;
  /** Inceputul textului overlay-ului (pentru log). */
  text: string;
}

/**
 * Ruleaza IN PAGINA: gaseste overlay-ul promo vizibil si apasa butonul lui de
 * inchidere. Intoarce ce a apasat (sau doar faptul ca overlay-ul exista).
 * (Serializata de Playwright - toate constantele vin prin `args`.)
 */
const scanPromoPopupsInPage = (args: PromoScanArgs): PromoOutcome | null => {
  const norm = (s: string): string =>
    String(s ?? '')
      .toLowerCase()
      .replace(/[\u0103\u00e2]/g, 'a')
      .replace(/\u00ee/g, 'i')
      .replace(/[\u0219\u015f]/g, 's')
      .replace(/[\u021b\u0163]/g, 't')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = window.getComputedStyle(el as HTMLElement);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const promoRe = new RegExp(args.promoSource, 'i');
  const announceRe = new RegExp(args.announceSource, 'i');
  const gifRe = new RegExp(args.gifSource, 'i');
  const gifActionRe = new RegExp(args.gifActionSource, 'i');
  const isPromoContext = (text: string): boolean =>
    promoRe.test(text) ||
    announceRe.test(text) ||
    (gifRe.test(text) && gifActionRe.test(text));
  const overlaySel =
    '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog,' +
    '[data-codex-pricing-overlay],[role="status"],[role="alert"],' +
    '[class*="pricing" i],[class*="upsell" i],[class*="paywall" i],' +
    '[class*="modal" i],[class*="overlay" i],[class*="popup" i],' +
    '[class*="announce" i],[class*="whats-new" i],[class*="whatsnew" i],' +
    '[class*="composerbanner" i],[class*="toast" i],' +
    '[data-radix-popper-content-wrapper]';

  const all = Array.prototype.slice.call(
    document.querySelectorAll(overlaySel)
  ) as HTMLElement[];
  const overlays: HTMLElement[] = [];
  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    // Doar dialoguri reale, straturi fixed mari sau containere de anunt; un
    // card promo inline din sidebar nu trebuie confundat cu un modal.
    const roleOverlay = el.matches(
      '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog,' +
        '[data-codex-pricing-overlay],[role="status"],[role="alert"]'
    );
    const announceEl = el.matches(
      '[class*="announce" i],[class*="whats-new" i],[class*="whatsnew" i],' +
        '[class*="composerbanner" i],[class*="toast" i],' +
        '[data-testid*="announce" i],[data-radix-popper-content-wrapper]'
    );
    // Bannerele de anunt pot fi joase (o linie + buton); restul trebuie sa
    // fie suficient de mari cat sa fie un popup, nu un tooltip.
    if (r.width < 220 || r.height < (announceEl ? 40 : 120)) continue;
    const style = window.getComputedStyle(el);
    const fixedOverlay =
      style.position === 'fixed' &&
      r.width >= window.innerWidth * 0.4 &&
      r.height >= window.innerHeight * 0.3;
    if (!roleOverlay && !fixedOverlay && !announceEl) continue;
    let nested = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (overlays.indexOf(p as HTMLElement) >= 0) {
        nested = true;
        break;
      }
    }
    if (!nested) overlays.push(el);
  }

  let overlay: HTMLElement | null = null;
  let overlayText = '';
  for (const el of overlays) {
    const text = norm(el.innerText);
    if (!text || !isPromoContext(text)) continue;
    overlay = el;
    overlayText = text;
    break;
  }
  if (!overlay) return null;

  const controls = Array.prototype.slice.call(
    overlay.querySelectorAll(
      'button,[role="button"],a,input[type="button"],input[type="submit"]'
    )
  ) as HTMLElement[];
  const candidates: Array<{ el: HTMLElement; text: string; score: number }> = [];
  for (const el of controls) {
    if ((el as unknown as { disabled?: boolean }).disabled) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    // Marcaj cu timestamp: acelasi buton nu e apasat de doua ori in acelasi
    // apel, dar un modal redeschis mai tarziu poate fi inchis din nou.
    const markedAt = Number(el.getAttribute('data-freekit-dismissed') ?? 0);
    if (markedAt && Date.now() - markedAt < 3000) continue;
    if (!isVisible(el)) continue;
    const textLabel = norm(el.innerText);
    const ariaLabel = norm(el.getAttribute('aria-label') ?? '');
    const titleLabel = norm(el.getAttribute('title') ?? '');
    let chosen = '';
    for (const n of [textLabel, ariaLabel, titleLabel]) {
      if (!n) continue;
      const exact = args.dismissTexts.indexOf(n) >= 0;
      const closePrefix =
        /^(close|dismiss)\b/.test(n) &&
        !/\b(claim|upgrade|buy|subscribe|purchase)\b/.test(n);
      if (exact || closePrefix) {
        chosen = n;
        break;
      }
    }
    if (!chosen) continue;
    const isButton =
      el.tagName === 'BUTTON' ||
      el.tagName === 'INPUT' ||
      el.getAttribute('role') === 'button';
    // Butonul-iconita cu aria-label ("Close pricing") e cel mai sigur.
    candidates.push({
      el,
      text: chosen,
      score: (!textLabel && ariaLabel ? 10 : 0) + (isButton ? 5 : 0)
    });
  }

  if (!candidates.length) {
    return { closed: null, overlay: true, text: overlayText.slice(0, 200) };
  }
  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];
  // Marcam INAINTE de click: acelasi buton nu mai e apasat la runda urmatoare.
  winner.el.setAttribute('data-freekit-dismissed', String(Date.now()));
  try {
    winner.el.click();
  } catch {
    return { closed: null, overlay: true, text: overlayText.slice(0, 200) };
  }
  return { closed: winner.text, overlay: true, text: overlayText.slice(0, 200) };
};

/**
 * Inchide overlay-urile promo/upsell vizibile (publicitate, pricing, "Try
 * Plus free for 1 month"). Intoarce textele butoanelor apasate. Nu arunca.
 */
export async function dismissPromoPopups(
  page: Page,
  opts: AutoAcceptOptions = {}
): Promise<string[]> {
  const dismissed: string[] = [];
  try {
    if (!popupSettings().dismissPromos) return dismissed;
    const args: PromoScanArgs = {
      dismissTexts: PROMO_DISMISS_TEXTS,
      promoSource: PROMO_CONTEXT_REGEX_SOURCE,
      announceSource: ANNOUNCEMENT_CONTEXT_REGEX_SOURCE,
      gifSource: GIF_CONTEXT_REGEX_SOURCE,
      gifActionSource: GIF_ACTION_REGEX_SOURCE
    };
    for (let round = 0; round < 2; round++) {
      let found: PromoOutcome | null = null;
      for (const frame of page.frames()) {
        try {
          const res = await frame.evaluate(scanPromoPopupsInPage, args);
          if (res && res.overlay) {
            found = res;
            break;
          }
        } catch {
          /* frame detasat / navigare in curs */
        }
      }
      if (!found) break;
      if (found.closed) {
        dismissed.push(found.closed);
        opts.log?.('promo popup inchis: "' + found.closed + '"');
        await sleep(700);
        continue;
      }
      // Fara buton vizibil: Escape inchide dialogul Radix; o singura incercare.
      await page.keyboard.press('Escape').catch(() => {});
      opts.log?.('promo popup inchis cu Escape (fara buton vizibil)');
      break;
    }
  } catch (e: any) {
    opts.log?.('dismissPromoPopups a esuat: ' + (e?.message ?? String(e)));
  }
  return dismissed;
}
