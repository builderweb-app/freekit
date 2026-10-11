import { Locator, Page } from 'playwright';
// IMPORTANT: `vscode` doar ca TIP — la runtime se cere lazy (require), ca
// modulul să poată fi încărcat și în teste Node (fără VS Code).
import type * as vscode from 'vscode';
import rawConfig from './selectors.json';
import { logLine, logWarnLine } from './log';

const log = (msg: string) => logLine('selectors', msg);
/** v2.5.72 (FIX 2): auto-unlock-ul e un eveniment WARN, nu informativ. */
const logWarn = (msg: string) => logWarnLine('selectors', msg);
/** v2.5.44 (bug #101): mesajele healer-ului, ca să fie ușor de filtrat în Output. */
const healLog = (msg: string) => logLine('healer', msg);
/** v2.5.68 (FIX 3): log-urile citirii răspunsului (același tag ca în providers/base.ts). */
const readLog = (msg: string) => logLine('read', msg);

/**
 * v2.5.68 (FIX 3): ultimul număr de potriviri raportat — logăm doar când se
 * SCHIMBĂ (citirea rulează la fiecare pas de polling, nu vrem linii identice).
 */
let lastLoggedMatches = 0;

/* =========================================================================
 * FAZA I — SELECTOARE MODULARE + AUTO-REPARARE
 *
 * selectors.json  = sursa de adevăr (editabilă manual, versionată)
 * SelectorStore   = citește configul + overlay cu selectorii învățați
 *                   (persistați în globalState => supraviețuiesc sesiunilor)
 * healSlot()      = caută elementul după "fingerprint" când selectoarele
 *                   cunoscute nu mai găsesc nimic, apoi salvează rezultatul
 * ========================================================================= */

export type SlotName = 'input' | 'response' | 'newChat' | 'stopButton' | 'loggedOut';

/**
 * Sloturile care pot fi auto-reparate / învățate (healer, AI finder, override-uri).
 * v2.5.12 (bug #35): `loggedOut` NU e aici, intenționat — un false positive
 * ar bloca/întreba greșit utilizatorul, deci rămâne doar din config-ul verificat.
 * (`as const` păstrează tipul restrâns la aceste 4 sloturi, nu tot SlotName.)
 */
export const SLOTS = ['input', 'response', 'newChat', 'stopButton'] as const;

/** Semnale "moi" folosite când selectorii CSS nu mai funcționează. */
export interface Fingerprint {
  /** Tag-uri candidate (ex: ["textarea", "div"]). */
  tags?: string[];
  /** Atribute a căror prezență crește scorul (orice valoare). */
  attributes?: string[];
  /** Text din element / părinte / atribute (placeholder, aria-label...). */
  nearbyText?: string[];
  /** Poziția pe ecran. */
  position?: 'top' | 'bottom';
  /** Selectori care trebuie să existe în interior (ex: ["p","pre"]). */
  hasChildren?: string[];
  /** Valoarea exactă a atributului role. */
  role?: string;
  /** true = elementul trebuie să accepte text (textarea/contenteditable/input). */
  editable?: boolean;
  /** Lungime minimă de text acceptată (doar pentru slotul `response`). */
  minTextLength?: number;
}

export interface SlotConfig {
  primary: string;
  alternatives?: string[];
  fingerprint?: Fingerprint;
  /**
   * v0.9.0: cuvinte-cheie preferate pentru slot (ex: ["assistant","message"]).
   * La auto-reparare, candidații care le conțin în atributele proprii
   * (class/id/aria-label/placeholder/...) primesc un bonus de scor.
   */
  preferredKeywords?: string[];
}

export interface ProviderConfig {
  url: string;
  input: SlotConfig;
  response: SlotConfig;
  newChat: SlotConfig;
  stopButton?: SlotConfig;
  /**
   * v2.5.12 (bug #35): elemente care apar DOAR când sesiunea nu e autentificată
   * (ex: CTA-ul „Log in"/„Sign up" din header/sidebar la ChatGPT). Opțional —
   * providerii fără intrare aici nu au detecție de guest mode. NU se auto-repară.
   */
  loggedOut?: SlotConfig;
}

export interface SelectorConfig {
  version: string;
  updated: string;
  /** Notă scurtă despre ce s-a reparat (afișată la update-ul remote). */
  changelog?: string;
  providers: Record<string, ProviderConfig>;
}

export type LearnHow = 'alternative' | 'fingerprint' | 'ai' | 'server' | 'user' | 'fragile';

export interface LearnedSelector {
  provider: string;
  slot: SlotName;
  selector: string;
  how: LearnHow;
  at: number;
  /** v0.9.5: metadate din descoperirea AI (copiate și în selectors-user.json). */
  confidence?: number;
  reasoning?: string;
  /**
   * v2.5.44 (bug #101): selector scris/adăugat MANUAL de utilizator în
   * selectors-user.json. Healer-ul (fingerprint), AI finder-ul și
   * override-urile de la server NU îl suprascriu și NU îl șterg niciodată —
   * utilizatorul are ultimul cuvânt pe acel slot. Vezi learn()/learnLocked().
   */
  locked?: boolean;
}

/** Configul "bundled" din selectors.json — baza de comparație + fallback. */
const BUNDLED_CONFIG = rawConfig as unknown as SelectorConfig;
const OVERRIDES_KEY = 'freekit.selectorOverrides';
const REMOTE_CACHE_KEY = 'freekit.remoteSelectors';
const FALLBACK_PROVIDER = 'deepseek';

/* =========================================================================
 * v0.7.0 — REMOTE SELECTOR CONFIG (Gist GitHub)
 *
 * Un config remote (publicat într-un Gist) poate înlocui selectoarele
 * bundled la runtime: este descărcat de remoteSelectors.ts, validat acolo,
 * apoi aplicat aici DOAR dacă versiunea lui e mai nouă decât cea activă.
 * Cache-ul persistă în globalState; dacă Gist-ul dispare, revine bundled.
 * ========================================================================= */

/** Cache-ul remote din globalState (scris la ultima aplicare reușită). */
export interface RemoteSelectorsCache {
  url: string;
  fetchedAt: number;
  version: string;
  updated?: string;
  /** Configul complet în momentul descărcării (deja merge-uit cu bundled). */
  data: SelectorConfig;
}

export interface SelectorInfo {
  version: string;
  updated: string;
  changelog?: string;
  providers: string[];
  /** 'remote' = config din Gist (cache); 'bundled' = cel din .vsix */
  source: 'bundled' | 'remote';
  remoteUrl?: string;
  remoteFetchedAt?: number;
  bundledVersion: string;
}

/** Compară versiuni "1.2.3" (numeric, bucată cu bucată): -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v || '')
      .split(/[.\-+]/)
      .map((p) => parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** URL-ul Gist-ului configurat de utilizator (gol = remote dezactivat). */
export function selectorsUrlFromSettings(): string {
  try {
    // require lazy — în teste Node modulul 'vscode' poate lipsi
    const v = require('vscode') as typeof import('vscode');
    return String(
      v.workspace.getConfiguration('freekit').get<string>('selectorsUrl', '') || ''
    ).trim();
  } catch {
    return '';
  }
}

/** Suprapune un config peste altul (providerii se merge-uiesc per cheie). */
function mergeConfigs(base: SelectorConfig, overlay: SelectorConfig): SelectorConfig {
  const providers: Record<string, ProviderConfig> = { ...base.providers, ...overlay.providers };
  // v2.5.12 (bug #35): un remote mai vechi (fără slotul `loggedOut`) nu are
  // voie să șteargă detecția de guest mode livrată local.
  for (const [pid, cfg] of Object.entries(providers)) {
    const local = base.providers[pid];
    if (local?.loggedOut && !cfg.loggedOut) {
      providers[pid] = { ...cfg, loggedOut: local.loggedOut };
    }
  }
  return {
    version: overlay.version,
    updated: overlay.updated || base.updated,
    changelog: overlay.changelog,
    providers
  };
}

/** Forma stabilă a unui slot — detectează ce s-a schimbat într-un update. */
function slotShape(cfg: ProviderConfig | undefined, slot: SlotName): string {
  const s = cfg?.[slot];
  if (!s) return '';
  return JSON.stringify([s.primary, ...(s.alternatives ?? [])]);
}

/** Selectori prea generici ca să merite salvați (ar prinde orice element). */
const TOO_GENERIC = new Set([
  '*',
  'body',
  'main',
  'div',
  'span',
  'p',
  'a',
  'button',
  'section',
  'article',
  'textarea',
  'input'
]);

/* =========================================================================
 * FIX HEALER — elemente false-positive (disclaimer / cookie / footer)
 *
 * Bug real (Gemini): healer-ul a ales `div.capabilities-disclaimer` în loc de
 * conținutul răspunsului (message-content / .model-response-text). Cauza:
 * fingerprint-ul se potrivește pe prea multe elemente, iar un bloc static
 * așezat "jos" în pagină câștiga la scor.
 * => blacklist de cuvinte verificat pe atributele elementului
 *    (class, id, role, aria-label, placeholder, data-testid, name, title).
 * ========================================================================= */
const BLACKLIST_KEYWORDS = [
  'disclaimer', 'cookie', 'gdpr', 'privacy', 'terms', 'legal',
  'footer', 'banner', 'advertisement', 'sponsor', 'promo',
  'sidebar', 'navigation', 'breadcrumb', 'capabilities',
  // FIX HEALER v2 — UI chrome, nu conține niciodată conținut de chat:
  'avatar', 'user-info', 'user-profile', 'account-', 'profile-',
  'menu', 'dropdown', 'popover', 'tooltip', 'modal', 'overlay',
  'attach', 'upload', 'add-photo', 'add-file', 'file-input',
  'login', 'signin', 'sign-in', 'signup', 'sign-up', 'email',
  'password', 'auth', 'oauth', 'captcha', 'recaptcha',
  'toolbar', 'tool-bar', 'action-', 'control-', 'button-group',
  'voice', 'microphone', 'camera', 'photo-picker', 'image-picker',
  // v0.9.1 FIX Mistral: healer-ul alesese butonul de temă ca „newChat” și un
  // bloc „text-subtle” ca răspuns → temă/comutatoare UI + texte secundare.
  // ('dark'/'light'/'mode' au gardă de token — vezi guardedHit.)
  'theme', 'toggle', 'dark', 'light', 'mode', 'subtle',
  // v0.9.3 FIX Kimi: pe un chat încă gol healer-ul alegea `div.header-left`
  // (header-ul paginii) ca răspuns → chrome de pagină, nu conținut de chat.
  'header',
  // v0.9.4 FIX Kimi: cardurile promoționale (ex: `div.resource-placement-card__content`
  // cu „Invite to Earn / Get Membership Benefits”) au text + <p> și câștigau
  // fingerprint-ul de response → reader-ul returna reclama în loc de răspuns.
  // ('earn'/'plan'/'cta'/'trial' au gardă de început de cuvânt — vezi
  // noLetterBeforeHit — ca 'learn', 'explanation', 'octagon' sau 'industrial'
  // să NU fie respinse greșit; 'promo' și 'banner' erau deja în listă.)
  'invite', 'earn', 'membership', 'benefit', 'offer', 'upgrade', 'premium',
  'subscribe', 'pricing', 'plan', 'resource-placement', 'cta', 'call-to-action',
  'reward', 'referral', 'coupon', 'discount', 'trial',
  // v2.5.13 FIX (bug #37): zone de NAVIGAȚIE/sidebar — Gemini ține lista de
  // conversații „Recents” în `div.chat-history-list` (în `bard-sidenav`), iar
  // cardurile de start în `div.suggestion-container`. Healer-ul le învățase ca
  // `response` cât timp răspunsul AI nu era încă în DOM. Tokenii de aici le
  // resping la învățare/persistare; init() curăță și override-urile deja salvate.
  'chat-history', 'suggestion', 'sidenav', 'side-nav',
  // blocul de „zero state” (ecranul gol cu salut + sugestii) — nu e răspuns
  'zero-state'
];

/**
 * v0.9.4 FIX Kimi (continuare): frazele de marketing verificate în TEXTUL
 * candidaților de response — unele blocuri promo nu au nicio clasă suspectă
 * (ex: caruselul Kimi `div.rat-carousel__track` cu „Invite to Earn / Get
 * Membership Benefits”), deci blacklist-ul de atribute nu le prinde.
 * Doar fraze multi-cuvânt, ca un răspuns tehnic care pomenește „premium”,
 * „upgrade” sau „membership” să NU fie respins; RESCUE-ul generic din
 * base.ts rămâne plasa de siguranță pentru răspunsuri care chiar conțin
 * o astfel de frază (ex: utilizatorul cere copy de marketing).
 */
const PROMO_TEXT_PHRASES = [
  'invite to earn', 'invite friends', 'invite a friend', 'refer a friend',
  'membership benefits', 'get membership', 'become a member',
  'upgrade to pro', 'upgrade to plus', 'upgrade to premium', 'upgrade your plan',
  'claim your reward', 'claim reward', 'limited time offer', 'special offer',
  'exclusive offer', 'earn rewards', 'earn points', 'referral bonus',
  'referral reward', 'go premium', 'try premium', 'unlock premium'
];

/** Sloturi unde un element din blacklist e ÎNTOTDEAUNA un false-positive. */
const CONTENT_SLOTS: SlotName[] = ['response', 'input'];

/**
 * FIX v2: 'auth' NU trebuie confundat cu 'author' — ChatGPT folosește
 * data-message-author-role în selectorii de răspuns, iar un blacklist naiv
 * pe substring ar respinge tocmai selectorul corect.
 */
function authOnlyHit(hay: string): boolean {
  let i = hay.indexOf('auth');
  while (i >= 0) {
    if (hay.slice(i, i + 6) !== 'author') return true;
    i = hay.indexOf('auth', i + 4);
  }
  return false;
}

/** v0.9.1: 'mode' ca token — 'model'/'models'/'modern' NU sunt „temă”. */
function modeOnlyHit(hay: string): boolean {
  let i = hay.indexOf('mode');
  while (i >= 0) {
    if (!/[a-z0-9]/.test(hay.charAt(i + 4))) return true;
    i = hay.indexOf('mode', i + 4);
  }
  return false;
}

/**
 * v0.9.1: 'dark'/'light' doar ca TOKEN întreg — altfel am respinge elemente
 * reale, doar stilizate: clase Tailwind `dark:...` (în selector scrisă
 * `dark\\:...`), `font-light`, `highlight`, `bg-light-100` etc.
 * (`theme-light` rămâne prins oricum de „theme”.)
 */
function tokenOnlyHit(hay: string, word: string): boolean {
  let i = hay.indexOf(word);
  while (i >= 0) {
    const prev = i > 0 ? hay.charAt(i - 1) : '';
    const next = hay.charAt(i + word.length);
    if (!/[a-z0-9-:]/.test(prev) && !/[a-z0-9-:\\]/.test(next)) return true;
    i = hay.indexOf(word, i + word.length);
  }
  return false;
}

/** v0.9.5: verificare Node-side a frazelor promo (refolosită de AI finder).
 *  În scanul din pagină lista se pasează ca argument (vezi promoText). */
export function promoPhraseHit(text: string): string | null {
  const hay = String(text || '').toLowerCase();
  for (const phrase of PROMO_TEXT_PHRASES) {
    if (hay.indexOf(phrase) >= 0) return phrase;
  }
  return null;
}

/**
 * v0.9.4: 'earn' / 'plan' / 'cta' / 'trial' doar la ÎNCEPUT de cuvânt — altfel
 * cuvinte legitime ar fi respinse greșit: 'learn'/'learn-more' (conține 'earn'),
 * 'explanation' și 'planet' ('plan'), 'octagon' ('cta'), 'industrial' ('trial').
 * Orice prefix care nu e literă (start de șir, spațiu, '-', '_', '.', ':') e OK.
 */
function noLetterBeforeHit(hay: string, word: string): boolean {
  let i = hay.indexOf(word);
  while (i >= 0) {
    if (i === 0 || !/[a-z]/.test(hay.charAt(i - 1))) return true;
    i = hay.indexOf(word, i + word.length);
  }
  return false;
}

/** Verifică un keyword din blacklist cu garda lui de token (dacă are una). */
function guardedHit(hay: string, kw: string): boolean {
  if (kw === 'auth') return authOnlyHit(hay);
  if (kw === 'mode') return modeOnlyHit(hay);
  if (kw === 'dark' || kw === 'light') return tokenOnlyHit(hay, kw);
  // v0.9.4: promo cu gardă de început (earn ≠ learn, plan ≠ explanation, ...)
  if (kw === 'earn' || kw === 'plan' || kw === 'cta' || kw === 'trial') {
    return noLetterBeforeHit(hay, kw);
  }
  return hay.indexOf(kw) >= 0;
}

/** Primul cuvânt din blacklist găsit în text (lowercase), altfel null. */
function blacklistHit(text: string): string | null {
  const hay = String(text || '').toLowerCase();
  for (const kw of BLACKLIST_KEYWORDS) {
    if (guardedHit(hay, kw)) return kw;
  }
  return null;
}

/**
 * v0.9.1: tokeni interziși la PERSISTARE pentru ORICE slot (nu doar
 * response/input). La newChat/stopButton blacklist-ul general nu se aplică,
 * dar butoanele de temă sunt 100% false-positive (ex: Mistral
 * `button[aria-label="Toggle theme"]` învățat drept „newChat”).
 */
const FORBIDDEN_SELECTOR_KEYWORDS = ['toggle', 'theme', 'dark', 'light', 'mode'];

/** Primul token interzis găsit în selectorul învățat, altfel null. */
function forbiddenSelectorHit(selector: string): string | null {
  const hay = String(selector || '').toLowerCase();
  for (const kw of FORBIDDEN_SELECTOR_KEYWORDS) {
    if (guardedHit(hay, kw)) return kw;
  }
  return null;
}

/** true dacă un selector învățat trebuie refuzat/curățat (slot de conținut). */
function isBlacklistedSelector(slot: SlotName, selector: string): boolean {
  if (slot === 'response' && responseLooksLikeInput(selector)) return true;
  return CONTENT_SLOTS.indexOf(slot) >= 0 && blacklistHit(selector) !== null;
}

/**
 * v2.5.13 FIX (bug #37): zonele de NAVIGAȚIE (sidebar/nav/aside) conțin doar
 * chrome de aplicație, niciodată răspunsul AI — la Gemini, lista „Recents”
 * (`div.chat-history-list`) a fost returnată ca răspuns după ce healer-ul a
 * învățat-o ca selector de `response` (răspunsul nu era încă în DOM la primul
 * checkpoint). Excluderea se aplică DOAR slotului `response`: butonul „New
 * chat” al Gemini stă chiar în sidebar, deci la `newChat`/`stopButton` zonele
 * astea rămân valide. Lista se trimite ca argument funcțiilor care rulează în
 * pagină (sursă unică de adevăr — ca la `blacklist`/`promoText`).
 *
 * v2.5.47 (bug #106): exportată și pentru validarea de conținut a selectorului
 * de răspuns din ai-selector-finder.ts — aceeași listă, aceeași excludere.
 */
export const NAV_SELECTORS = [
  'nav',
  'aside',
  '[role="navigation"]',
  '[role="complementary"]',
  'bard-sidenav',
  'side-navigation-content',
  '.chat-history-list'
];

/**
 * v0.9.3 FIX Kimi: un selector pentru slotul `response` care indică evident
 * căsuța de input (composer) nu poate fi un răspuns valid. Cazul real:
 * healer-ul a învățat `div[role="textbox"]` (composer-ul Lexical al Kimi)
 * drept „răspuns” → reader-ul returna mesajul UTILIZATORULUI.
 * Folosit la init() (purge), learn() și filtrarea din healSlot().
 */
function responseLooksLikeInput(selector: string): boolean {
  return /textbox|composer|contenteditable|textarea|(^|[^a-z])input([^a-z]|$)/i.test(
    String(selector || '')
  );
}

/** Blocat la învățare/persistare: blacklist de conținut SAU token UI interzis. */
function isPersistBlocked(slot: SlotName, selector: string): boolean {
  return isBlacklistedSelector(slot, selector) || forbiddenSelectorHit(selector) !== null;
}

/**
 * v2.5.47 (bug #106): exportată și pentru AI finder — candidații de răspuns
 * propuși de el (părinte/fallback) se filtrează cu ACEEAȘI regulă cu care
 * `learn()` îi respinge la salvare, ca să nu raportăm „validat" pentru un
 * selector care nu se poate stoca.
 */
export function isUsableSelector(sel: string): boolean {
  if (!sel) return false;
  const bare = sel.trim().toLowerCase();
  if (bare.length > 400) return false;
  if (TOO_GENERIC.has(bare)) return false;
  return true;
}

/**
 * FIX v2: selectori fragili — fie conțin nth-of-type, fie sunt doar lanțuri
 * poziționale de tag-uri (ex: "div > div") fără nicio ancoră (#, ., [).
 * Se pot folosi o singură dată în sesiunea curentă, dar nu se persistă.
 */
function isFragileSelector(sel: string): boolean {
  if (sel.indexOf(':nth-of-type') >= 0) return true;
  return sel.indexOf(' > ') >= 0 && !/[#.\[]/.test(sel);
}

/** v2.5.61 (FIX 4): câte eșecuri consecutive expiră un selector salvat automat. */
const FAILURE_EXPIRY_COUNT = 2;

/**
 * v2.5.72 (FIX 1/2): câte eșecuri consecutive ale testului funcțional
 * declanșează auto-unlock-ul unui selector user-locked (scris manual). La
 * prag, selectorul iese din `_meta.locked`, AI Finder-ul e întrebat, iar la
 * succes noul selector e re-lockuit pentru utilizator.
 */
export const USER_LOCK_FAILURE_THRESHOLD = 3;

/** v2.5.72 (FIX 5): notificările de selector (chat + log), emise uniform. */
export type SelectorAlertKind = 'failed' | 'unlocked' | 'repaired';

export interface SelectorAlert {
  kind: SelectorAlertKind;
  /** Cheia „<provider>.<slot>". */
  key: string;
  /** Eșecuri consecutive (pentru `failed`/`unlocked`). */
  count?: number;
  /** Noul selector (pentru `repaired`). */
  selector?: string;
}

let selectorAlertFn: ((alert: SelectorAlert) => void) | null = null;

/** Înregistrează notificarea de selector (chat). null = dezactivată. */
export function setSelectorAlertNotifier(fn: ((alert: SelectorAlert) => void) | null) {
  selectorAlertFn = fn;
}

/** Emite o notificare de selector (fail-open: nu are voie să strice fluxul). */
export function notifySelectorAlert(alert: SelectorAlert): void {
  try {
    selectorAlertFn?.(alert);
  } catch (e: any) {
    log('selector alert notifier failed: ' + (e?.message ?? String(e)));
  }
}

/** v2.5.61 (FIX 1): câți candidați de healer trec prin testul funcțional. */
const HEALER_MAX_FUNCTIONAL_TRIES = 3;

/**
 * v2.5.65 (FIX 2): sub acest scor healer-ul NU salvează candidatul — un scor
 * mic (ex: `#base-ui-_r_4e_` cu 7 la `claude.newChat`) înseamnă „ghiceală pe
 * un id instabil", iar salvarea lui bloca cascada: AI Finder-ul (tier 4) nu
 * mai apuca să caute. Candidatul slab se sare, se continuă cu următorii, iar
 * dacă niciunul nu trece pragul cascada merge mai departe (tier 4 → 5 → 6).
 */
const MIN_HEALER_SCORE = 10;

/**
 * v2.5.74 (FIX 1): pragul pentru `newChat` e mai mare — un buton de chat nou
 * trebuie să poarte semnalul lui explicit („new chat"/„chat nou"), nu doar tag +
 * poziție. Fără el, `button[aria-label="Dismiss upgrade banner"]` (Claude)
 * câștiga scanul și era învățat ca buton de chat nou.
 */
const NEWCHAT_MIN_SCORE = 25;

/** v2.5.74 (FIX 1): pragul de salvare al unui candidat, per slot. */
function minHealerScore(slot: SlotName): number {
  return slot === 'newChat' ? NEWCHAT_MIN_SCORE : MIN_HEALER_SCORE;
}

export class SelectorStore {
  private overrides = new Map<string, LearnedSelector>();
  /** v2.5.61 (FIX 4): eșecuri consecutive per slot (doar în sesiunea curentă). */
  private failures = new Map<string, number>();
  /**
   * v2.5.72 (FIX 1): eșecuri consecutive per selector user-locked, persistate
   * în `selectors-user.json` (`_meta.failures`). Separat de `failures` (care
   * expiră override-urile auto) — un selector scris manual nu se șterge automat.
   */
  private lockFailures = new Map<string, number>();
  /** Sloturi deblocate automat (user-lock expirat) — vezi isAutoUnlocked(). */
  private unlockedUserLocks = new Set<string>();
  /**
   * v2.5.72 (FIX 2/4): handlerul de auto-unlock (înregistrat de AI finder).
   * Rulează ÎNAINTE de scoaterea selectorului din `_meta.locked`, ca să poată
   * salva backup-ul timestampat al fișierului; dacă lipsește, store-ul face
   * unlock-ul singur (fără backup).
   */
  private userLockFailureHandler?: (providerId: string, slot: SlotName, count: number) => void;
  private memento?: vscode.Memento;
  private notifier?: (info: LearnedSelector) => void;
  private userFileWriter?: () => void;
  /** v0.7.0: configul activ (bundled sau remote din cache). */
  private active: SelectorConfig = BUNDLED_CONFIG;
  /** v0.7.0: de unde vine configul activ (setat când se aplică/citește remote). */
  private remoteMeta?: { url: string; fetchedAt: number };

  /** Se apelează o dată, la activarea extensiei. */
  init(memento: vscode.Memento, notifier?: (info: LearnedSelector) => void) {
    this.memento = memento;
    this.notifier = notifier;
    // v0.7.0: activează configul remote din cache (dacă e mai nou decât bundled)
    this.loadRemoteCache();
    const saved = memento.get<LearnedSelector[]>(OVERRIDES_KEY, []);
    let purged = 0;
    for (const item of saved) {
      if (!(item && item.provider && item.slot && item.selector)) continue;
      // v2.5.44 (bug #101): intrările scrise manual de utilizator se încarcă
      // neatinse — nu trec prin filtrele euristice (fragil/generic/blacklist),
      // altfel o reparație manuală corectă ar fi „curățată" de healer.
      if (item.locked) {
        this.overrides.set(this.key(item.provider, item.slot), item);
        continue;
      }
      // FIX healer: override-urile care indică disclaimer/cookie/footer
      // (ex: div.capabilities-disclaimer ales greșit de Gemini) sunt eliminate.
      // v0.9.1: + selectori de temă/UI chrome (ex: „Toggle theme” → newChat)
      // și texte secundare (ex: „text-subtle” → response).
      if (isPersistBlocked(item.slot, item.selector)) {
        purged++;
        log('blocked override (blacklist/UI chrome) ignored: ' + item.provider + '.' + item.slot + ' -> ' + item.selector);
        continue;
      }
      // FIX v2: override-urile fragili (poziționale/nth-of-type) sunt prea
      // fragile ca să fie persistate (ex: DeepSeek newChat reparat greșit).
      if (isFragileSelector(item.selector)) {
        purged++;
        log('fragile (positional) override ignored: ' + item.provider + '.' + item.slot + ' -> ' + item.selector);
        continue;
      }
      this.overrides.set(this.key(item.provider, item.slot), item);
    }
    if (saved.length) {
      log('overrides loaded: ' + (saved.length - purged));
    }
    if (purged) void this.persist();
  }

  setNotifier(notifier: (info: LearnedSelector) => void) {
    this.notifier = notifier;
  }

  setUserFileWriter(writer: (() => void) | null) {
    this.userFileWriter = writer ?? undefined;
  }

  /** v2.5.72 (FIX 2): înregistrează handlerul de auto-unlock (AI finder). */
  setUserLockFailureHandler(
    fn: ((providerId: string, slot: SlotName, count: number) => void) | null
  ) {
    this.userLockFailureHandler = fn ?? undefined;
  }

  /**
   * v2.5.65 (FIX 4): scrie ACUM `selectors-user.json` din override-urile din
   * memorie. Reparația „deferred" din providers/base.ts învață un selector nou,
   * dar fără acest apel el trăia doar în memorie (și în globalState) — în
   * fișier nu apărea, deci nu se vedea în `selectors-user.json`.
   */
  saveUserFile(): boolean {
    if (!this.userFileWriter) return false;
    try {
      this.userFileWriter();
      return true;
    } catch (e: any) {
      log('scrierea selectors-user.json a eșuat: ' + (e?.message ?? String(e)));
      return false;
    }
  }

  private persistUserFile() {
    try {
      this.userFileWriter?.();
    } catch (e: any) {
      log('writing selectors-user.json failed: ' + (e?.message ?? String(e)));
    }
  }

  private key(provider: string, slot: SlotName) {
    return provider + '.' + slot;
  }

  config(providerId: string): ProviderConfig {
    const cfg = this.active.providers[providerId];
    if (cfg) return cfg;
    log('unknown provider ("' + providerId + '") — using ' + FALLBACK_PROVIDER);
    return this.active.providers[FALLBACK_PROVIDER];
  }

  url(providerId: string): string {
    return this.config(providerId).url;
  }

  host(providerId: string): string {
    try {
      return new URL(this.url(providerId)).origin;
    } catch {
      return this.url(providerId);
    }
  }

  /** v2.5.45 (bug #102): providerii cunoscuți în configul activ. */
  providerIds(): string[] {
    return Object.keys(this.active.providers);
  }

  /**
   * v2.5.45 (bug #102): providerul căruia îi aparține URL-ul dat — folosit de
   * comanda „Freekit: Re-discover Selectors", care pornește de la tab-ul
   * deschis în Chrome (nu știe ce provider e activ).
   */
  providerIdForUrl(url: string): string | null {
    let host = '';
    try {
      host = new URL(String(url || '')).origin;
    } catch {
      return null;
    }
    for (const pid of this.providerIds()) {
      try {
        if (new URL(this.url(pid)).origin === host) return pid;
      } catch {
        /* URL invalid în config — trecem la următorul provider */
      }
    }
    return null;
  }

  slotConfig(providerId: string, slot: SlotName): SlotConfig | undefined {
    return this.config(providerId)[slot];
  }

  primary(providerId: string, slot: SlotName): string | undefined {
    return this.slotConfig(providerId, slot)?.primary;
  }

  fingerprint(providerId: string, slot: SlotName): Fingerprint | undefined {
    return this.slotConfig(providerId, slot)?.fingerprint;
  }

  /** Selectorii statici din JSON (fără override-uri). */
  staticCandidates(providerId: string, slot: SlotName): string[] {
    const cfg = this.slotConfig(providerId, slot);
    if (!cfg) return [];
    return [cfg.primary, ...(cfg.alternatives ?? [])].filter(Boolean);
  }

  /**
   * Ordinea de încercare: override învățat -> primary -> alternatives.
   * v2.5.75 (FIX 2): un selector-fallback FRAGIL (pozițional) are un singur rost —
   * să prindă elementul când nimic stabil nu mai există — deci stă la COADĂ, ca
   * să nu umbrească selectorii statici (buni) de dinaintea lui.
   */
  candidates(providerId: string, slot: SlotName): string[] {
    const learned = this.overrides.get(this.key(providerId, slot));
    const list = [...this.staticCandidates(providerId, slot)];
    if (learned && !list.includes(learned.selector)) {
      if (learned.how === 'fragile') list.push(learned.selector);
      else list.unshift(learned.selector);
    }
    return list;
  }

  learned(providerId: string, slot: SlotName): LearnedSelector | undefined {
    return this.overrides.get(this.key(providerId, slot));
  }

  listLearned(): LearnedSelector[] {
    return Array.from(this.overrides.values());
  }

  /**
   * v2.5.44 (bug #101): true dacă slotul are un selector scris MANUAL de
   * utilizator („user-locked"). Healer-ul verifică asta înainte de orice
   * reparație automată (vezi healSlot()).
   */
  isLocked(providerId: string, slot: SlotName): boolean {
    return this.overrides.get(this.key(providerId, slot))?.locked === true;
  }

  /** v2.5.44 (bug #101): câte override-uri sunt user-locked (pentru mesaje/log). */
  lockedCount(): number {
    let n = 0;
    for (const entry of this.overrides.values()) if (entry.locked) n++;
    return n;
  }

  /** v2.5.72 (FIX 3): cheile user-locked („<provider>.<slot>"), pentru comenzi. */
  lockedKeys(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.overrides.entries()) if (entry.locked) out.push(key);
    return out;
  }

  /* ---------------- v2.5.72: contoare de eșec per selector user-locked ---------------- */

  /** Eșecurile consecutive ale unui selector user-locked (persistate). */
  lockFailureCount(providerId: string, slot: SlotName): number {
    return this.lockFailures.get(this.key(providerId, slot)) ?? 0;
  }

  /** Eșecurile consecutive pentru o cheie „<provider>.<slot>" (pentru fișier). */
  lockFailureCountForKey(key: string): number {
    return this.lockFailures.get(key) ?? 0;
  }

  /** Snapshot-ul contoarelor (doar valorile > 0), pentru `_meta.failures`. */
  lockFailuresSnapshot(): Array<[string, number]> {
    return Array.from(this.lockFailures.entries());
  }

  /** Încarcă contoarele persistate din `selectors-user.json`. */
  hydrateLockFailures(record: Record<string, number>): void {
    for (const [key, value] of Object.entries(record)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) this.lockFailures.set(key, Math.floor(n));
    }
  }

  /**
   * v2.5.72 (FIX 6): resetează contoarele de eșec. Fără `providerId` → toate;
   * cu `providerId` → doar selectorii acelui provider. Întoarce câte chei au
   * fost resetate.
   */
  resetLockFailures(providerId?: string): number {
    if (!providerId) {
      const n = this.lockFailures.size;
      this.lockFailures.clear();
      return n;
    }
    const prefix = providerId + '.';
    let removed = 0;
    for (const key of Array.from(this.lockFailures.keys())) {
      if (key.startsWith(prefix)) {
        this.lockFailures.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** v2.5.72 (FIX 2): slotul a fost scos din `_meta.locked` în această sesiune? */
  isAutoUnlocked(providerId: string, slot: SlotName): boolean {
    return this.unlockedUserLocks.has(this.key(providerId, slot));
  }

  /**
   * v2.5.72 (FIX 2/3): scoate un selector din `_meta.locked` PĂSTRÂNDU-l ca
   * override obișnuit (unlocked), ca AI Finder-ul să poată propune unul nou.
   * Nu atinge contorul de eșecuri (rămâne pentru „next retry").
   */
  unlockUserLock(providerId: string, slot: SlotName): boolean {
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
    if (!existing || !existing.locked) return false;
    existing.locked = false;
    if (existing.how === 'user') existing.how = 'ai';
    this.unlockedUserLocks.add(key);
    void this.persist();
    return true;
  }

  /**
   * v2.5.72 (FIX 2): auto-unlock după pragul de eșecuri — unlock + log WARN +
   * notificare în chat. Întoarce true dacă selectorul a fost efectiv deblocat.
   */
  autoUnlockUserLock(providerId: string, slot: SlotName, count: number): boolean {
    const key = this.key(providerId, slot);
    if (!this.unlockUserLock(providerId, slot)) return false;
    logWarn(
      'auto-unlocked ' + key + ' after ' + count + ' failures' +
        ' — AI Finder can repair it now'
    );
    notifySelectorAlert({ kind: 'unlocked', key, count });
    return true;
  }

  /**
   * v2.5.44 (bug #101): înregistrează un selector scris MANUAL de utilizator
   * (inclusiv migrarea fișierelor vechi, v1). Îl marchează `locked` și NU îl
   * trece prin filtrele euristice (fragil / prea generic / blacklist / UI
   * chrome): pe acel slot decizia userului e suverană. Se ignoră doar ce nu
   * poate fi folosit deloc (gol sau absurd de lung).
   */
  learnLocked(providerId: string, slot: SlotName, selector: string): boolean {
    const sel = String(selector || '').trim();
    if (!sel || sel.length > 400) return false;
    const key = this.key(providerId, slot);
    this.failures.delete(key);
    this.unlockedUserLocks.delete(key);
    // v2.5.72 (FIX 2): re-lock-ul (după reparație) repornește contorul de eșecuri
    this.lockFailures.delete(key);
    if (this.overrides.get(key)?.selector === sel) {
      this.overrides.get(key)!.locked = true;
      return true;
    }
    this.overrides.set(key, {
      provider: providerId,
      slot,
      selector: sel,
      how: 'user',
      at: Date.now(),
      locked: true
    });
    log('user-locked selector: ' + key + ' -> ' + sel + ' (healer will not touch it)');
    void this.persist();
    return true;
  }

  /**
   * Marchează selectorul care a funcționat. Dacă e un selector static
   * (primary/alternative) nu avem ce învăța; dacă e unul nou (reparat prin
   * fingerprint) îl salvăm pentru sesiunile viitoare.
   */
  note(providerId: string, slot: SlotName, selector: string) {
    // v2.5.61 (FIX 4): selectorul chiar a funcționat în pagină
    this.recordSuccess(providerId, slot);
    if (this.staticCandidates(providerId, slot).includes(selector)) return;
    this.learn(providerId, slot, selector, 'fingerprint');
  }

  /**
   * Învață/repară un selector. Întoarce true dacă selectorul e STOCAT (acum
   * sau deja) și false dacă a fost respins (generic/fragil/blacklist/UI chrome).
   * v0.9.5: `meta` = detalii din descoperirea AI (confidence/reasoning).
   */
  learn(
    providerId: string,
    slot: SlotName,
    selector: string,
    how: LearnHow,
    meta?: { confidence?: number; reasoning?: string }
  ): boolean {
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
    // v2.5.44 (bug #101): un selector scris manual de utilizator e „locked" —
    // NICIUN learn automat (fingerprint/healer, AI finder, server remote) nu-l
    // suprascrie. Fără asta, reparația automată cădea exact peste selecția
    // manuală (ex: mistral.newChat → cookie banner / id Radix instabil).
    if (existing?.locked) {
      if (existing.selector === selector) return true;
      healLog(
        'skip ' + providerId + ':' + slot + ' — user-locked (keeping "' + existing.selector +
          '", refused "' + selector + '" from ' + how + ')'
      );
      return false;
    }
    if (!isUsableSelector(selector)) {
      log('ignoring overly generic selector for ' + providerId + '.' + slot + ': ' + selector);
      return false;
    }
    // FIX v2: selectorii fragili (poziționali/nth-of-type) se pot folosi o dată
    // în sesiunea curentă, dar nu se salvează — se rup la prima schimbare de DOM.
    if (isFragileSelector(selector)) {
      log('ignoring fragile (positional) selector for ' + providerId + '.' + slot + ': ' + selector);
      return false;
    }
    // FIX healer: nu salvăm niciodată selectori de disclaimer/cookie/footer
    // (v0.9.1) sau de temă/comutatoare UI, pentru niciun slot.
    if (isPersistBlocked(slot, selector)) {
      log('ignoring blocked selector (blacklist/UI chrome) for ' + providerId + '.' + slot + ': ' + selector);
      return false;
    }
    if (existing && existing.selector === selector) return true;

    const entry: LearnedSelector = {
      provider: providerId,
      slot,
      selector,
      how,
      at: Date.now()
    };
    if (meta?.confidence !== undefined) entry.confidence = meta.confidence;
    if (meta?.reasoning) entry.reasoning = meta.reasoning;
    this.overrides.set(key, entry);
    // v2.5.61 (FIX 4): un selector nou șters din eșecuri începe cu contorul la 0
    this.failures.delete(key);
    this.unlockedUserLocks.delete(key);
    log('selector repaired: ' + key + ' -> ' + selector + ' (' + how + ')');
    void this.persist();
    try {
      this.notifier?.(entry);
    } catch (e: any) {
      log('notifier failed: ' + (e?.message ?? String(e)));
    }
    return true;
  }

  /**
   * v2.5.75 (FIX 2): salvează un selector pozițional („fragil") ca FALLBACK de
   * ultimă instanță. Se folosește doar când healer-ul nu a putut compune niciun
   * selector stabil (ex: un <a> fără href/aria-label în sidebar-ul Claude), iar
   * elementul chiar funcționează în pagină. E marcat `how: 'fragile'`, deci:
   *   - stă la coada `candidates()` (nu umbrește selectorii statici);
   *   - nu trece prin filtrele obișnuite (altfel ar fi respins ca fragil);
   *   - se poate șterge oricând cu „Reset Repaired Selectors".
   */
  learnFallback(providerId: string, slot: SlotName, selector: string): boolean {
    const sel = String(selector || '').trim();
    if (!sel || sel.length > 400) return false;
    if (!isUsableSelector(sel)) return false;
    // chiar și ca fallback, un disclaimer/cookie/UI chrome e interzis
    if (isPersistBlocked(slot, sel)) return false;
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
    if (existing?.locked) return false;
    if (existing?.selector === sel) return true;
    this.overrides.set(key, {
      provider: providerId,
      slot,
      selector: sel,
      how: 'fragile',
      at: Date.now()
    });
    this.failures.delete(key);
    this.unlockedUserLocks.delete(key);
    // fallback-ul nu e o „reparare" — nu anunțăm în chat (vezi `notifier`)
    log('saved fragile fallback: ' + key + ' -> ' + sel);
    void this.persist();
    return true;
  }

  /** Uită un singur override (ex: repararea a fost respinsă de provider). */
  forget(providerId: string, slot: SlotName): boolean {
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
    // v2.5.44 (bug #101): curățenia automată (dropStaleOverride, reparații
    // respinse) nu are voie să șteargă o selecție scrisă manual.
    if (existing?.locked) {
      healLog(
        'skip ' + providerId + ':' + slot + ' — user-locked (keeping "' + existing.selector + '")'
      );
      return false;
    }
    if (!this.overrides.delete(key)) return false;
    log('override removed: ' + key);
    void this.persist();
    return true;
  }

  /* ---------------- v2.5.61 / v2.5.62: expirarea selectorilor greșiți ----------------
   *
   * Un selector salvat (în selectors-user.json) care nu mai găsește elementul de
   * DOUĂ ori la rând e șters automat — altfel rămâne „lipit" peste slot și
   * fiecare task următor eșuează la fel. Se resetează la prima folosire reușită.
   * Un selector user-locked este deblocat după două eșecuri ale testului
   * funcțional și șters la al treilea eșec consecutiv.
   * ------------------------------------------------------------------------------ */

  /**
   * Eșecul unui selector salvat. v2.5.72 (FIX 1/2): selectoarele user-locked au
   * un contor PERSISTENT per selector (nu per provider) în `_meta.failures`; la
   * al treilea eșec consecutiv ies din `_meta.locked` (auto-unlock) și AI
   * Finder-ul poate propune un înlocuitor (re-lockuit la succes).
   */
  recordFailure(providerId: string, slot: SlotName): number {
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
    // fără override salvat nu avem ce expira (bundled-ul nu se atinge de aici)
    if (!existing) return 0;

    if (existing.locked) {
      const count = (this.lockFailures.get(key) ?? 0) + 1;
      this.lockFailures.set(key, count);
      log(
        'user-locked ' + key + ' failed (failure ' + count +
          '/' + USER_LOCK_FAILURE_THRESHOLD + ')'
      );
      notifySelectorAlert({ kind: 'failed', key, count });
      void this.persist();
      if (count >= USER_LOCK_FAILURE_THRESHOLD) {
        // v2.5.72 (FIX 2/4): handlerul (AI finder) salvează backup-ul și scoate
        // selectorul din `_meta.locked`; fără handler, facem unlock-ul local.
        if (this.userLockFailureHandler) {
          try {
            this.userLockFailureHandler(providerId, slot, count);
          } catch (e: any) {
            log('user-lock unlock handler failed: ' + (e?.message ?? String(e)));
            this.autoUnlockUserLock(providerId, slot, count);
            this.persistUserFile();
          }
        } else {
          this.autoUnlockUserLock(providerId, slot, count);
          this.persistUserFile();
        }
      } else {
        this.persistUserFile();
      }
      return count;
    }

    const count = (this.failures.get(key) ?? 0) + 1;
    if (count >= FAILURE_EXPIRY_COUNT) {
      this.failures.delete(key);
      this.unlockedUserLocks.delete(key);
      this.overrides.delete(key);
      log('removed failing ' + key + ' (' + FAILURE_EXPIRY_COUNT + ' failures)');
      void this.persist();
      this.persistUserFile();
      return count;
    }
    this.failures.set(key, count);
    log('selector failed ' + count + '/' + FAILURE_EXPIRY_COUNT + ': ' + key);
    return count;
  }

  /** Un selector a funcționat — contorul de eșecuri consecutive se resetează. */
  recordSuccess(providerId: string, slot: SlotName) {
    const key = this.key(providerId, slot);
    this.failures.delete(key);
    this.unlockedUserLocks.delete(key);
    // v2.5.72 (FIX 2): succesul unui selector user-locked resetează contorul
    // persistent (și îl salvează, ca `_meta.failures` să reflecte realitatea).
    if (this.lockFailures.delete(key)) this.persistUserFile();
  }

  /** Pentru teste/diagnostics: câte eșecuri consecutive are slotul dat. */
  failureCount(providerId: string, slot: SlotName): number {
    return this.failures.get(this.key(providerId, slot)) ?? 0;
  }

  /** Șterge override-urile (toate, sau doar pentru un provider). */
  reset(providerId?: string): number {
    if (!providerId) {
      this.failures.clear();
      this.unlockedUserLocks.clear();
      // v2.5.72: „uită selectorii" resetează și contoarele user-lock
      this.lockFailures.clear();
    }
    let removed = 0;
    let kept = 0;
    for (const [key, entry] of Array.from(this.overrides.entries())) {
      if (providerId && entry.provider !== providerId) continue;
      if (providerId) {
        this.failures.delete(key);
        this.unlockedUserLocks.delete(key);
      }
      // v2.5.44 (bug #101): reselecțiile manuale ale utilizatorului rămân —
      // altfel „uită selectorii învățați" ar șterge exact reparația lui.
      if (entry.locked) {
        kept++;
        continue;
      }
      this.overrides.delete(key);
      removed++;
    }
    if (kept) log('reset: kept ' + kept + ' user-locked selector(s)');
    if (removed) void this.persist();
    return removed;
  }

  /* ---------------- v0.7.0: remote selectors ---------------- */

  private loadRemoteCache() {
    try {
      const url = selectorsUrlFromSettings();
      if (!url) return;
      const cache = this.memento?.get<RemoteSelectorsCache>(REMOTE_CACHE_KEY);
      if (!cache || typeof cache.version !== 'string' || !cache.data || !cache.data.providers) {
        return;
      }
      if (cache.url !== url) {
        log('remote cache ignored: the configured URL changed');
        return;
      }
      const merged = mergeConfigs(BUNDLED_CONFIG, cache.data);
      if (compareVersions(merged.version, BUNDLED_CONFIG.version) <= 0) {
        log(
          'remote cache (v' + merged.version + ') is not newer than bundled (v' +
            BUNDLED_CONFIG.version + ') — ignored'
        );
        return;
      }
      this.active = merged;
      this.remoteMeta = { url, fetchedAt: cache.fetchedAt || 0 };
      log('remote selectors active from cache: v' + merged.version + ' (' + url + ')');
    } catch (e: any) {
      log('remote cache invalid — ignored: ' + (e?.message ?? String(e)));
    }
  }

  /** Starea configului activ (pentru diagnostics / comenzi / log). */
  info(): SelectorInfo {
    return {
      version: this.active.version,
      updated: this.active.updated || '',
      changelog: this.active.changelog,
      providers: Object.keys(this.active.providers),
      source: this.remoteMeta ? 'remote' : 'bundled',
      remoteUrl: this.remoteMeta?.url,
      remoteFetchedAt: this.remoteMeta?.fetchedAt,
      bundledVersion: BUNDLED_CONFIG.version
    };
  }

  /**
   * Aplică un config remote (validat deja de remoteSelectors.ts):
   * - providerii lipsă din remote se păstrează din configul activ (merge);
   * - override-urile învățate pentru sloturile MODIFICATE de remote se șterg,
   *   ca reparația venită de la developer să aibă efect imediat;
   * - cache-ul se persistă în globalState (fallback la repornire).
   */
  applyRemote(
    remote: SelectorConfig,
    url: string
  ): { applied: boolean; version: string; cleared: string[] } {
    if (compareVersions(remote.version, this.active.version) <= 0) {
      log('applyRemote ignored: v' + remote.version + ' <= active v' + this.active.version);
      return { applied: false, version: this.active.version, cleared: [] };
    }
    const merged = mergeConfigs(this.active, remote);
    const cleared: string[] = [];
    for (const [pid, next] of Object.entries(merged.providers)) {
      const prev = this.active.providers[pid];
      for (const slot of SLOTS) {
        if (slotShape(prev, slot) === slotShape(next, slot)) continue;
        const key = this.key(pid, slot);
        if (this.overrides.delete(key)) cleared.push(key);
      }
    }
    this.active = merged;
    this.remoteMeta = { url, fetchedAt: Date.now() };
    if (cleared.length) void this.persist();
    void this.persistRemoteCache();
    log(
      'remote selectors applied: v' + merged.version + ' (' + url + ')' +
        (cleared.length ? ' — overrides replaced: ' + cleared.join(', ') : '')
    );
    return { applied: true, version: merged.version, cleared };
  }

  private async persistRemoteCache() {
    if (!this.memento || !this.remoteMeta) return;
    try {
      const payload: RemoteSelectorsCache = {
        url: this.remoteMeta.url,
        fetchedAt: this.remoteMeta.fetchedAt,
        version: this.active.version,
        updated: this.active.updated,
        data: this.active
      };
      await this.memento.update(REMOTE_CACHE_KEY, payload);
    } catch (e: any) {
      log('persisting remote cache failed: ' + (e?.message ?? String(e)));
    }
  }

  private async persist() {
    if (!this.memento) return;
    try {
      await this.memento.update(OVERRIDES_KEY, Array.from(this.overrides.values()));
    } catch (e: any) {
      log('persisting overrides failed: ' + (e?.message ?? String(e)));
    }
  }
}

export const selectors = new SelectorStore();

/* =========================================================================
 * Cod care rulează ÎN PAGINĂ (page.evaluate) — trebuie să fie autonom,
 * fără referințe la variabile din afara funcției.
 * ========================================================================= */

interface ScanArgs {
  fp: Fingerprint;
  slot: SlotName;
  /** Blacklist-ul de false-positive — trimis ca argument ca să rămână o
   * singură sursă de adevăr (funcția rulează serializată în pagină). */
  blacklist?: string[];
  /** v0.9.4: fraze de marketing verificate în TEXTUL candidaților (nu doar
   * în atribute) — vezi PROMO_TEXT_PHRASES. */
  promoText?: string[];
  /** v0.9.4: mesajul tocmai trimis (normalizat în pagină) — candidații care
   * ÎNCEP cu el sunt containere de conversație, nu răspunsuri (ex: Kimi
   * `div.chat-content-list` pe un chat nou). Vezi și isEchoOf din base.ts. */
  echoText?: string;
  /** v0.9.0: preferredKeywords (bonus la scor) — vezi SlotConfig. */
  keywords?: string[];
  /** v2.5.13: zonele de navigație excluse la `response` — vezi NAV_SELECTORS. */
  navSels?: string[];
}

interface ScanResult {
  selector: string;
  score: number;
  why: string[];
  preview: string;
}

const scanCandidates = (args: ScanArgs): ScanResult[] => {
  const fp: any = args.fp || {};
  const slot: string = args.slot;
  const blacklist: string[] = (args.blacklist || []).map((k) => String(k).toLowerCase());
  // v0.9.4: frazele promo verificate în textul candidaților (normalizate o dată per scan)
  const promoText: string[] = (args.promoText || [])
    .map((p) => String(p).toLowerCase().trim())
    .filter(Boolean);
  // v0.9.4: mesajul trimis, normalizat — gardă anti-container de conversație
  const echoText = String(args.echoText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  // v0.9.0: cuvintele-cheie preferate (normalizate o singură dată per scan)
  const keywords: string[] = (args.keywords || [])
    .map((k) => String(k).toLowerCase().trim())
    .filter(Boolean);

  // v2.5.67 (FIX 1): „chat" singur NU mai e semnal de chat NOU — `button[aria-label="Rename chat"]`
  // primea bonusul și healer-ul îl învăța ca `newChat`. Bonusul merge doar pe fraza completă,
  // iar acțiunile pe un chat EXISTENT sunt penalizate. (Funcția e serializată în pagină.)
  const NEW_CHAT_PHRASES = [
    'new chat',
    'start chat',
    'create chat',
    'chat nou',
    'nou chat',
    'new conversation'
  ];
  const CHAT_ITEM_ACTIONS = [
    'rename',
    'delete',
    'edit',
    'copy',
    'share',
    'archive',
    'hide',
    'mute'
  ];
  // v2.5.74 (FIX 1): butoanele de banner / chrome (upgrade, dismiss, close,
  // cancel) nu sunt butonul de chat nou — vezi scorul de `newChat`.
  const NEWCHAT_CHROME_TOKENS = ['dismiss', 'close', 'upgrade', 'cancel'];
  // clasele/id-urile folosesc cratime (`new-chat-button`) — le tratăm ca spații la fraze
  const phraseHay = (s: string): string => s.replace(/[-_]+/g, ' ');

  // FIX v2: 'auth' fără 'author' (ChatGPT: data-message-author-role).
  // v0.9.1: aceleași garduri de token ca în Node (funcția e serializată în
  // pagină, deci logica se duplică intenționat): 'mode' ≠ 'model', iar
  // 'dark'/'light' doar ca token întreg (Tailwind `dark:...`, `font-light`).
  // v0.9.4: la fel și garda de început pentru 'earn'/'plan'/'cta'/'trial'.
  const kwHit = (hay: string, kw: string): boolean => {
    if (kw === 'auth') {
      let i = hay.indexOf('auth');
      while (i >= 0) {
        if (hay.slice(i, i + 6) !== 'author') return true;
        i = hay.indexOf('auth', i + 4);
      }
      return false;
    }
    if (kw === 'mode') {
      let i = hay.indexOf('mode');
      while (i >= 0) {
        if (!/[a-z0-9]/.test(hay.charAt(i + 4))) return true;
        i = hay.indexOf('mode', i + 4);
      }
      return false;
    }
    if (kw === 'dark' || kw === 'light') {
      let i = hay.indexOf(kw);
      while (i >= 0) {
        const prev = i > 0 ? hay.charAt(i - 1) : '';
        const next = hay.charAt(i + kw.length);
        if (!/[a-z0-9-:]/.test(prev) && !/[a-z0-9-:]/.test(next)) return true;
        i = hay.indexOf(kw, i + kw.length);
      }
      return false;
    }
    // v0.9.4: promo (earn/plan/cta/trial) doar la început de cuvânt — gardul
    // e duplicat intenționat (funcția rulează serializată în pagină).
    if (kw === 'earn' || kw === 'plan' || kw === 'cta' || kw === 'trial') {
      let i = hay.indexOf(kw);
      while (i >= 0) {
        if (i === 0 || !/[a-z]/.test(hay.charAt(i - 1))) return true;
        i = hay.indexOf(kw, i + kw.length);
      }
      return false;
    }
    return hay.indexOf(kw) >= 0;
  };

  const isElement = (n: Element | null): n is HTMLElement => !!n && n.nodeType === 1;

  // v2.5.13 FIX (bug #37): funcția e serializată în pagină, deci lista vine ca
  // argument (sursă unică de adevăr: NAV_SELECTORS din Node).
  const inNav = (el: Element): boolean => {
    const list = args.navSels || [];
    for (let i = 0; i < list.length; i++) {
      try {
        if (el.closest(list[i]) !== null) return true;
      } catch {
        /* selector invalid — îl ignorăm */
      }
    }
    return false;
  };

  const isVisible = (el: Element): boolean => {
    if (!isElement(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') return false;
    if (parseFloat(st.opacity || '1') < 0.05) return false;
    return true;
  };

  const textOf = (el: Element): string =>
    ((el as HTMLElement).innerText || el.textContent || '').trim();

  const signalText = (el: Element): string => {
    const parts: string[] = [];
    for (const a of [
      'placeholder',
      'aria-label',
      'title',
      'data-testid',
      'data-test-id',
      'name',
      'role',
      'class',
      'id'
    ]) {
      const v = a === 'class' ? (el as HTMLElement).className : el.getAttribute(a);
      if (v) parts.push(String(v));
    }
    return parts.join(' ');
  };

  const escapeSel = (value: string): string => {
    const css: any = (window as any).CSS;
    if (css && typeof css.escape === 'function') return css.escape(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  /** Selectori posibili pentru un element, de la cel mai stabil la cel mai fragil. */
  const selectorCandidates = (el: Element): string[] => {
    const list: string[] = [];
    const tag = el.tagName.toLowerCase();

    const id = el.getAttribute('id');
    if (id) list.push('#' + escapeSel(id));

    for (const a of [
      'data-testid',
      'data-test-id',
      'data-message-author-role',
      'data-role',
      'aria-label',
      'placeholder',
      'name',
      'role'
    ]) {
      const v = el.getAttribute(a);
      if (!v) continue;
      list.push(tag + '[' + a + '="' + v.replace(/"/g, '\\"') + '"]');
    }

    // v2.5.75 (FIX 2): `href` — butonul „New chat" al Claude e un <a href="/new">
    // cu doar clase utilitare (underline-offset-2), deci fără asta singurul
    // selector propus era lanțul pozițional (fragil, ignorat la salvare).
    // Acceptăm doar href-uri relative sau absolute scurte (fără query lung).
    const href = el.tagName === 'A' ? String((el as HTMLAnchorElement).getAttribute('href') || '') : '';
    if (href && href.length <= 120 && !/\s/.test(href) && !/^javascript:/i.test(href)) {
      list.push(tag + '[href="' + href.replace(/"/g, '\\"') + '"]');
    }

    const classes = String((el as HTMLElement).className || '')
      .split(/\s+/)
      .filter((c) => c && c.length < 40 && !/[^a-zA-Z0-9_-]/.test(c));
    for (let take = Math.min(classes.length, 2); take > 0; take--) {
      list.push(tag + '.' + classes.slice(0, take).map(escapeSel).join('.'));
    }

    // ultima variantă: drum pozițional (nth-of-type), din ce în ce mai lung
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c: Element) => c.tagName === node!.tagName
        );
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      list.push(parts.join(' > '));
      node = parent;
    }

    return list;
  };

  /**
   * Verifică un selector pe elementul găsit. Pentru slotul `response` acceptăm
   * și selectori care prind mai multe blocuri (citirea ia ULTIMUL potrivit — e
   * mult mai stabil decât un drum pozițional).
   */
  const verify = (el: Element, sel: string, loose: boolean): boolean => {
    let ok = false;
    try {
      el.setAttribute('data-freekit-probe', '1');
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0 && nodes.length <= 40) {
        const last = nodes[nodes.length - 1];
        ok = last.getAttribute('data-freekit-probe') === '1' && (nodes.length === 1 || loose);
      }
    } catch {
      ok = false;
    }
    try {
      el.removeAttribute('data-freekit-probe');
    } catch {
      /* ignorăm */
    }
    return ok;
  };

  const isEditable = (el: Element): boolean =>
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'INPUT' ||
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute('contenteditable') === 'true';

  /* ---- colectarea candidaților ---- */
  const tags: string[] = (fp.tags && fp.tags.length ? fp.tags : ['div', 'textarea']).map(
    (t: string) => String(t).toLowerCase()
  );

  const collect = (list: string[]): Element[] => {
    const out: Element[] = [];
    const seen = new Set<Element>();
    for (const t of list) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = document.querySelectorAll(t);
      } catch {
        continue;
      }
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  };

  let pool = collect(tags);
  if (pool.length === 0) {
    pool =
      slot === 'input'
        ? collect(['textarea', 'input', '[contenteditable="true"]'])
        : collect(['div', 'article', 'section', 'message-content', 'model-response']);
  }
  if (slot === 'input') {
    // uneori inputul e o <div contenteditable> în interiorul unui wrapper
    pool = pool.concat(collect(['textarea', 'input', '[contenteditable="true"]']));
  }

  const unique = new Set<Element>(pool);
  pool = Array.from(unique);

  /* ---- scor ---- */
  const score = (el: Element): { score: number; why: string[] } | null => {
    const tag = el.tagName.toLowerCase();
    if (!isVisible(el)) return null;

    /* v0.9.3 FIX Kimi: slotul `response` NU poate fi căsuța de input.
       Healer-ul alesese `div.chat-input-editor[role="textbox"]` (composer-ul
       Lexical) drept „răspuns” → reader-ul returna mesajul utilizatorului.
       Reguli pentru response: elementul în sine nu are voie să fie editabil
       sau role=textbox, iar niciun strămoş (max 6 niveluri) nu poate avea
       tokenul „user” în class/id (bula userului: `.user-content`,
       `.segment-user`, `.chat-content-item-user` etc.). */
    if (slot === 'response') {
      // tag-uri semantice de chrome — un răspuns nu trăiește niciodată aici
      if (tag === 'header' || tag === 'nav' || tag === 'footer' || tag === 'aside') return null;
      if (isEditable(el)) return null;
      if (el.getAttribute('role') === 'textbox') return null;
      let up: Element | null = el;
      let ud = 0;
      while (up && ud < 6) {
        const ucls =
          typeof (up as HTMLElement).className === 'string' ? (up as HTMLElement).className : '';
        const uids = up.getAttribute('id') || '';
        if (/(^|[\s_-])user([\s_-]|$)/i.test(ucls + ' ' + uids)) return null;
        up = up.parentElement;
        ud++;
      }
    }

    let s = 0;
    const why: string[] = [];
    const id = el.getAttribute('id') || '';
    if (
      id &&
      (/^base-ui-/i.test(id) ||
        /^_r_/i.test(id) ||
        /^:r[^:]*:/i.test(id) ||
        /\d/.test(id))
    ) {
      s -= 50;
      why.push('unstable-id');
    }
    /* v2.5.65 (FIX 1): butoanele din bara de acțiuni a mesajelor (Copy, Edit,
       Share, …) au data-testid/aria-label STABILE, dar funcție greșită.
       Bonusul lor de „stabilitate" făcea healer-ul să aleagă
       `button[data-testid="action-bar-copy"]` drept „chat nou" (scor 23).
       În interiorul unei bare de acțiuni testid/aria-label nu mai e semnal. */
    let inActionBar = false;
    if (typeof (el as Element).closest === 'function') {
      try {
        inActionBar = el.closest('[data-testid*="action-bar"]') !== null;
      } catch {
        /* selector invalid — ignorăm */
      }
    }
    if (el.hasAttribute('data-testid') && !inActionBar) {
      s += 10;
      why.push('stable-testid');
    }
    if (el.hasAttribute('aria-label') && !inActionBar) {
      s += 10;
      why.push('stable-aria-label');
    }
    if (el.classList.contains('font-claude-message')) {
      s += 8;
      why.push('stable-claude-message-class');
    }

    if (tags.indexOf(tag) >= 0) {
      s += 3;
      why.push('tag:' + tag);
    }

    const editable = isEditable(el);
    if (fp.editable) {
      if (!editable) return null;
      s += 6;
      why.push('editable');
    }

    if (fp.attributes) {
      for (const a of fp.attributes) {
        if (el.hasAttribute(a)) {
          s += 2;
          why.push('@' + a);
        }
      }
    }

    if (fp.role && el.getAttribute('role') === fp.role) {
      s += 4;
      why.push('role');
    }

    let childHits = 0;
    if (fp.hasChildren) {
      for (const c of fp.hasChildren) {
        if (el.querySelector(c)) childHits++;
      }
      if (childHits) {
        s += 2 * Math.min(childHits, 3);
        why.push('children:' + childHits);
      }
    }

    /* v2.5.13 FIX (bug #37): sidebar/nav/aside nu sunt niciodată răspuns —
       healer-ul învățase lista „Recents” a Gemini (`div.chat-history-list`)
       pe un chat încă gol și reader-ul returna titlurile conversațiilor. */
    if (slot === 'response' && inNav(el)) return null;

    const own = signalText(el);

    /* FIX healer: disclaimer / cookie banner / footer / sidebar nu sunt
     * niciodată conținut de chat. La `response` le excludem complet (peste
     * un astfel de element a ales greșit Gemini: div.capabilities-disclaimer);
     * la `input` aplicăm doar penalizare. */
    if (blacklist.length && (slot === 'response' || slot === 'input')) {
      const ownHay = own.toLowerCase();
      const bad: string[] = [];
      for (const kw of blacklist) {
        if (kwHit(ownHay, kw)) bad.push(kw);
      }
      if (bad.length) {
        if (slot === 'response') return null;
        s -= 10 * Math.min(bad.length, 3);
        why.push('blacklist:' + bad.join(','));
      }
    }

    const parent = el.parentElement;
    const near = (parent ? signalText(parent) : '') + ' ' + own;
    if (fp.nearbyText) {
      const hay = own.toLowerCase();
      const nearHay = near.toLowerCase();
      for (const t of fp.nearbyText) {
        const needle = String(t).toLowerCase();
        if (!needle) continue;
        if (hay.indexOf(needle) >= 0) {
          s += 2;
          why.push('text:' + t);
        } else if (nearHay.indexOf(needle) >= 0) {
          s += 1;
          why.push('near:' + t);
        }
      }
    }

    // v0.9.0: bonus pentru cuvintele-cheie preferate (ex: „assistant”,
    // „markdown”, „chat”) — întărește candidații potriviți, fără să
    // penalizeze absența lor.
    if (keywords.length) {
      const ownHay = own.toLowerCase();
      const hitList: string[] = [];
      for (const kw of keywords) {
        if (ownHay.indexOf(kw) >= 0) hitList.push(kw);
      }
      if (hitList.length) {
        s += 2 * Math.min(hitList.length, 3);
        why.push('kw:' + hitList.slice(0, 3).join(','));
      }
    }

    if (fp.position) {
      const r = el.getBoundingClientRect();
      const mid = window.innerHeight * 0.5;
      const bottomish = r.top > mid;
      if ((fp.position === 'bottom' && bottomish) || (fp.position === 'top' && !bottomish)) {
        s += 2;
        why.push('pos:' + fp.position);
      }
    }

    // bonus de adâncime: un bloc de conținut e mai de încredere decât containerul lui
    let depth = 0;
    let up: Element | null = el.parentElement;
    while (up && depth < 4) {
      if (tags.indexOf(up.tagName.toLowerCase()) >= 0) depth++;
      up = up.parentElement;
    }
    if (depth) {
      s += 2 * Math.min(depth, 3);
      why.push('depth:' + depth);
    }

    const text = textOf(el);
    if (slot === 'response') {
      if (!text) return null;
      // v0.9.4 FIX Kimi: blocuri promo cu TEXT de marketing (clase inocente) —
      // ex: caruselul `div.rat-carousel__track` → „Invite to Earn / Get
      // Membership Benefits”. Doar fraze multi-cuvânt (vezi PROMO_TEXT_PHRASES),
      // ca un răspuns tehnic care pomenește „premium”/„upgrade” să nu fie respins.
      if (promoText.length) {
        const promoHay = text.toLowerCase();
        for (const phrase of promoText) {
          if (promoHay.indexOf(phrase) >= 0) return null;
        }
      }
      // v0.9.4: container de conversație care CONȚINE mesajul tocmai trimis
      // (ex: div.chat-content-list) — nu e un răspuns, chiar dacă are și
      // istoric înaintea mesajului (v0.9.5: startWith -> contains); gardă
      // similară cu isEchoOf din base.ts; doar mesaje lungi (≥40), ca
      // mesaje scurte („OK”) să nu respingă răspunsuri care doar le conțin.
      const textNorm = text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (echoText.length >= 40) {
        if (textNorm.indexOf(echoText) >= 0) return null;
      } else if (echoText && textNorm === echoText) {
        // v2.5.13 FIX (bug #37): nici bula UTILIZATORULUI nu e răspuns — pe un
        // chat încă gol healer-ul învăța `div.query-text` (mesajul nostru).
        // Garda de mai sus prinde doar ecourile lungi (≥40); egalitatea exactă
        // e sigură aici: un răspuns identic cu mesajul e refuzat oricum de
        // isEchoOf() în base.ts.
        return null;
      }
      if (fp.minTextLength && text.length < fp.minTextLength) return null;
      if (text.length > 12000) return null;
      if (el.querySelector('textarea, [contenteditable="true"]')) return null;
      /* v2.5.13 FIX (bug #37): un răspuns real are conținut structurat (p/ol/ul/
         pre/code — exact ce declară fingerprint.hasChildren); blocurile de chrome
         fără niciun astfel de copil (sidebar „Recents”, carduri de sugestii,
         „zero state”) câștigau scanul pe un chat încă gol doar prin tag+depth+pos
         și erau învățate ca `response`. Fără semnal de conținut nu învățăm nimic:
         staticul funcționează, iar răspunsul nu e încă în pagină. */
      if (fp.hasChildren && fp.hasChildren.length && childHits === 0) return null;
      if (el.querySelector('p, li, pre, code')) {
        s += 2;
        why.push('blocks');
      }
      // un mesaj e mai mic decât tot istoricul: penalizăm containerele mari
      s -= Math.min(3, text.length / 2000);
      if (s <= 0) return null;
    }

    if (slot === 'input' && !editable && !el.querySelector('textarea, [contenteditable="true"]')) {
      return null;
    }

    if ((slot === 'newChat' || slot === 'stopButton') && el.querySelector('svg, img')) {
      s += 1;
      why.push('icon');
    }

    /* v2.5.61 (FIX 5) — penalizări/bonusuri pe textul de semnal.
     * Healer-ul alegea `button[user-message-retry]` pentru `newChat` la Claude:
     * există, e vizibil, dar e butonul de „retry" al unui mesaj. Acțiunile din
     * interiorul mesajelor și butoanele de retry/regenerate/edit/delete sunt
     * penalizate; „new"/„chat" + zona de header/sidebar + iconița plus/creion
     * (exact ce are un buton de chat nou) primesc bonus. */
    {
      const labelHay = own.toLowerCase();
      for (const bad of ['retry', 'regenerate', 'edit', 'delete', 'remove']) {
        if (labelHay.indexOf(bad) >= 0) {
          s -= 6;
          why.push('penal:' + bad);
        }
      }
      // „user-message-*" = acțiunile mesajelor utilizatorului, nu chrome-ul paginii
      if (/(^|[\s_\-."'])user[-_]?(message|query|prompt)/i.test(labelHay)) {
        s -= 8;
        why.push('penal:user-message');
      }
      if (slot === 'newChat') {
        // v2.5.67 (FIX 1): bonus DOAR pe fraza completă de „chat nou" — tokenul
        // „chat" singur era suficient ca „Rename chat" să câștige scanul.
        // v2.5.74 (FIX 1): bonusul urcă la +15 (pragul de newChat e 25) — un
        // buton de chat nou trebuie să poarte fraza, nu doar iconița/poziția.
        const labelFlat = phraseHay(labelHay);
        if (NEW_CHAT_PHRASES.some((p) => labelFlat.indexOf(p) >= 0)) {
          s += 15;
          why.push('bonus:chat-new');
        }
        // v2.5.74 (FIX 1): butoanele de banner/promo („Dismiss upgrade banner",
        // „Close", „Cancel", „Upgrade") NU sunt niciodată butonul de chat nou —
        // healer-ul le alegea pentru că există în header, lângă butonul real.
        for (const bad of NEWCHAT_CHROME_TOKENS) {
          if (labelHay.indexOf(bad) >= 0) {
            s -= 20;
            why.push('penal:newchat-' + bad);
          }
        }
        // v2.5.67 (FIX 1): acțiunile pe un chat EXISTENT nu sunt „chat nou".
        for (const bad of CHAT_ITEM_ACTIONS) {
          if (labelHay.indexOf(bad) >= 0) {
            s -= 40;
            why.push('penal:' + bad);
          }
        }
        try {
          if (el.closest('header, [role="banner"], aside, nav, [class*="sidebar" i]')) {
            s += 3;
            why.push('bonus:header/sidebar');
          }
          // v2.5.67 (FIX 1): linkul explicit „/new" e mereu un buton de chat nou.
          if (
            tag === 'a' &&
            /\/(new|nou)\/?$/i.test((el.getAttribute('href') || '').split(/[?#]/)[0])
          ) {
            s += 20;
            why.push('bonus:href-new');
          }
          const icon = el.querySelector('svg, img');
          if (icon && /plus|add|compose|pen|pencil|new[-_]?chat/i.test(icon.outerHTML || '')) {
            s += 2;
            why.push('bonus:icon');
          }
        } catch {
          /* closest/outerHTML pot arunca pe noduri detașate — ignorăm */
        }
      }
    }

    /* v2.5.65 (FIX 1) — tokenii funcției, nu ai „stabilității".
     * Healer-ul a ales `button[data-testid="action-bar-copy"]` pentru
     * `claude.newChat` (scor 23) pentru că testid-ul e stabil — dar e butonul
     * Copy. Un element de acțiune (buton/link, sau orice element din bara de
     * acțiuni) care poartă tokeni de acțiune pe mesaj e respins cu -50; pentru
     * `newChat`, tokenii de „chat nou" primesc +30. Regula se aplică doar
     * sloturilor de acțiune / elementelor de tip buton, ca `.chat-input-editor`
     * (input) sau `div`-urile de răspuns să nu fie respinse din greșeală. */
    {
      const hay = (signalText(el) + ' ' + textOf(el)).toLowerCase();
      const isActionEl =
        tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button';
      if (slot === 'newChat' || slot === 'stopButton' || isActionEl || inActionBar) {
        for (const bad of [
          'copy',
          'edit',
          'delete',
          'retry',
          'regenerate',
          'share',
          'download',
          'feedback',
          'thumbs',
          'action-bar',
          'message-actions',
          // v2.5.67 (FIX 1): acțiuni pe un chat existent — nu „chat nou".
          'rename',
          'archive',
          'hide',
          'mute'
        ]) {
          if (hay.indexOf(bad) >= 0) {
            s -= 50;
            why.push('reject:' + bad);
          }
        }
        if (slot === 'newChat') {
          // v2.5.67 (FIX 1): tokenul „chat" singur NU mai e acceptat — „Rename
          // chat" lua +30 și ajungea „chat nou". Semnalul e fraza completă.
          for (const good of ['new', 'create', 'plus', 'compose']) {
            if (hay.indexOf(good) >= 0) {
              s += 30;
              why.push('accept:' + good);
            }
          }
          const hayFlat = phraseHay(hay);
          if (NEW_CHAT_PHRASES.some((p) => hayFlat.indexOf(p) >= 0)) {
            s += 30;
            why.push('accept:chat');
          }
        }
      }
    }

    if (s <= 0) return null;
    return { score: s, why };
  };

  interface ScanItem {
    el: Element;
    idx: number;
    score: number;
    why: string[];
    preview: string;
    len: number;
  }

  const items: ScanItem[] = [];
  for (let i = 0; i < pool.length; i++) {
    const el = pool[i];
    const r = score(el);
    if (!r) continue;
    const text = textOf(el);
    items.push({
      el,
      idx: i,
      score: r.score,
      why: r.why,
      preview: text.slice(0, 60) || signalText(el).slice(0, 60),
      len: text.length
    });
  }

  // păstrăm doar elementele cele mai "interioare": dacă un element conține un
  // alt candidat aproape la fel de mare, el e doar un container (nu un mesaj)
  let shortlist = items.filter(
    (it) =>
      !items.some(
        (other) =>
          other !== it && it.el.contains(other.el) && other.len >= it.len * 0.7
      )
  );
  if (shortlist.length === 0) shortlist = items;

  shortlist.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // pentru răspuns ne interesează ULTIMUL mesaj, pentru input primul câmp
    return slot === 'response' ? b.idx - a.idx : a.idx - b.idx;
  });

  const loose = slot === 'response';
  const out: ScanResult[] = [];
  for (const item of shortlist.slice(0, 8)) {
    const sel = selectorCandidates(item.el).find((c) => verify(item.el, c, loose));
    if (!sel) continue;
    out.push({
      selector: sel,
      score: item.score,
      why: item.why,
      preview: item.preview
    });
  }
  return out;
};

interface ReadArgs {
  sels: string[];
  fallback: boolean;
  /** v2.5.13: zonele de navigație excluse — vezi NAV_SELECTORS. */
  navSels?: string[];
}

/**
 * v2.5.46 (bug #105): rezultatul unei citiri de răspuns.
 * `text` = răspunsul final (fără blocul de raționament), `ignored` = câte
 * caractere de „thinking" au fost sărite (pentru log), `count` = câte răspunsuri
 * non-goale sunt în DOM (doar în modul `count`).
 */
export interface ResponseRead {
  text: string;
  ignored: number;
  count: number;
  deduplicated?: boolean;
  /** v2.5.66 (FIX 4): paragrafele de „thinking" scoase din text după citire. */
  filtered?: number;
  /**
   * v2.5.68 (FIX 3): câte elemente a prins selectorul care a dat răspunsul —
   * se citește DOAR ultimul (log `[read] using last of N assistant messages`).
   */
  matches?: number;
}

/**
 * v2.5.66 (FIX 4) / v2.5.67 (FIX 2): „Thinking" poate fi un PARAGRAF de sine
 * stătător în ACELAȘI element cu răspunsul (nu un bloc separat), deci nici
 * filtrarea pe atribute, nici deduplicarea nu îl scot.
 *
 * v2.5.66 scotea doar paragrafele de LA ÎNCEPUT; v2.5.67 verifică TOATE
 * paragrafele — modelul strecoară uneori raționamentul LA MIJLOC:
 *   „Bine, mulțumesc!\n\nFormularea unui răspuns scurt și casual.\n\nBine, mulțumesc!"
 * Scoaterea se face doar pentru paragrafe SCURTE (< 150 caractere) care ÎNCEP cu
 * un cuvânt de raționament (un paragraf lung poate fi răspuns real care doar
 * pomenește termenul). Paragrafele de la început se scot fără limita de lungime
 * (paritate cu v2.5.66). Dacă nu rămâne nimic, păstrăm textul original — paritate
 * cu versiunile anterioare, ca sentinelele din sendAndWait să nu vadă „răspuns" gol.
 */
const THINKING_PARAGRAPH_RE =
  /^(thinking|thought(\s+for)?|reasoning|cogitating|picturing|formularea|preg[ăa]tirea|r[ăa]spunz[âa]nd|se g[âa]nde|analiz[âa]nd|consider[âa]nd|ra[tț]ionament)\b/i;

/** v2.5.67 (FIX 2): peste această lungime un paragraf nu mai e „thinking". */
const THINKING_PARAGRAPH_MAX_LEN = 150;

function isThinkingParagraph(flat: string): boolean {
  return THINKING_PARAGRAPH_RE.test(flat);
}

export function filterThinkingParagraphs(text: string): { text: string; filtered: number } {
  const src = String(text ?? '');
  if (!src) return { text: src, filtered: 0 };
  const paragraphs = src.split(/\n{2,}/);
  const flatOf = (p: string): string => p.replace(/\s+/g, ' ').trim();
  // v2.5.66: paragrafele de la început (goale sau de raționament) sunt scoase
  // indiferent de lungime — până la primul paragraf de conținut.
  let start = 0;
  while (start < paragraphs.length) {
    const flat = flatOf(paragraphs[start]);
    if (!flat || isThinkingParagraph(flat)) {
      start++;
      continue;
    }
    break;
  }
  const kept: string[] = [];
  let filtered = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const flat = flatOf(paragraphs[i]);
    const leading = i < start;
    // v2.5.67: ORICE paragraf scurt de raționament (și orice paragraf de la
    // început) e scos — nu doar cele leading.
    const shortThinking = flat.length > 0 && flat.length < THINKING_PARAGRAPH_MAX_LEN && isThinkingParagraph(flat);
    if (leading || shortThinking) {
      filtered++;
      continue;
    }
    kept.push(paragraphs[i]);
  }
  if (filtered === 0) return { text: src, filtered: 0 };
  const out = kept.join('\n\n').trim();
  if (!out) return { text: src, filtered: 0 };
  return { text: out, filtered };
}

interface ResponseScanArgs extends ReadArgs {
  /** 'text' (implicit) = citește ultimul răspuns; 'count' = numără răspunsurile. */
  mode: 'text' | 'count';
}

/**
 * v2.5.46 FIX (bug #105): CITIREA RĂSPUNSULUI OCOLEȘTE BLOCURILE DE „THINKING".
 *
 * Test Qwen (7 Oct 2026, 17:06): modelul a trimis corect tool call-ul
 * (ACTION: write_files, 5 fișiere), dar selectorul de răspuns prinsese ÎNTÂI
 * blocul de raționament — s-au citit 93 de caractere („Thinking completed") în
 * loc de răspuns, deci tool call-ul s-a pierdut. Același risc la
 * DeepSeek/Claude/Gemini/Kimi, care afișează și ele raționamentul separat.
 *
 * Reguli (identice pentru citire ȘI numărare, ca sentinelele din sendAndWait să
 * rămână consistente):
 *  1. ultimul element al unui selector (ca înainte) și, dacă selectorul prinde
 *     DOAR thinking, trecem la următorul selector (nu ne oprim la primul match);
 *  2. elementele marcate „thinking" (class, id, data-testid/role, aria-label
 *     care conțin thinking|reason|thought) și textele-marker scurte („Thinking",
 *     „Thinking completed", „Thought for 12s", „Reasoning") sunt ignorate, iar
 *     caracterele lor se raportează în `ignored` → log `[read] response: N chars
 *     (thinking: M chars ignored)` în providers/base.ts;
 *  3. dacă elementul e un CONTAINER, păstrăm TOATE blocurile copil care nu sunt
 *     thinking (concatenate); fără copii-thinking textul rămâne EXACT ca în
 *     v2.5.45 (zero regresii pentru providerii care nu afișează raționament);
 *  4. dacă niciun selector nu dă text non-thinking, reluăm citirea FĂRĂ filtrul
 *     de atribute (doar markerii de text rămân filtrați) — paritate cu versiunea
 *     anterioară, ca să nu răspundem „gol" unde înainte citeam ceva.
 *
 * Rulează ÎN PAGINĂ (prin page.evaluate) — toate utilitarele sunt definite
 * local, fiindcă funcția e serializată.
 */
const scanResponses = (args: ResponseScanArgs): ResponseRead => {
  const textOf = (el: Element): string => {
    const liveText = (el as HTMLElement).innerText;
    if (el.isConnected && liveText) return liveText.trim();
    const collect = (node: Node): string => {
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      const element = node as HTMLElement;
      if (element.tagName === 'BR') return '\n';
      const text = Array.prototype.map
        .call(element.childNodes, (child: Node) => collect(child))
        .join('');
      return /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL)$/.test(
        element.tagName
      )
        ? '\n\n' + text + '\n\n'
        : text;
    };
    return collect(el).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  // v2.5.13 FIX (bug #37): sidebar-ul nu e răspuns, chiar dacă un selector
  // (override învățat greșit) îl prinde — trecem la următorul nod/selector.
  const inNav = (el: Element): boolean => {
    const list = args.navSels || [];
    for (let i = 0; i < list.length; i++) {
      try {
        if (el.closest(list[i]) !== null) return true;
      } catch {
        /* selector invalid — îl ignorăm */
      }
    }
    return false;
  };

  /* ---- v2.5.46 (bug #105): thinking ≠ răspuns --------------------------- */
  // v2.5.68 (FIX 2): `data-step-key` („thinking-0") = blocul de raționament al
  // lui Claude, inclusiv în timpul generării („Claude is thinking").
  const THINKING_ATTRS = ['class', 'id', 'data-testid', 'data-role', 'data-step-key', 'aria-label'];
  const THINKING_ATTR_RE = /think|reason|thought/i;
  const THINKING_MARKER_RE =
    /^(thinking|thought(\s+for)?|reasoning|se g[âa]nde[șs]te|ra[tț]ionament)/i;
  /** Peste atâtea caractere, textul nu mai poate fi un marker scurt de thinking. */
  const THINKING_MARKER_MAX = 160;

  /**
   * v2.5.68 (FIX 1): TEXTUL „DOAR PENTRU SCREEN READER" NU E RĂSPUNS.
   *
   * Claude pune în `div[data-testid='assistant-message']` un titlu ascuns care
   * copiază începutul răspunsului:
   *   `<h2 class="sr-only select-none">Claude responded: Salut, Laurentiu!</h2>`
   * Citit ca „copil" al containerului, după ce `finish()` tăia prefixul
   * „Claude responded:" rămânea un paragraf-fantomă, iar răspunsul ieșea
   * duplicat: „Salut, Laurentiu!\n\nSalut, Laurentiu! Cu te pot ajuta în proiect?".
   * Același tipar la ChatGPT (`<h6 class="sr-only">ChatGPT said:</h6>`).
   */
  const SR_ONLY_RE =
    /\b(?:sr-only|sr_only|visually-hidden|screen-reader-only|screenreader-only|a11y-hidden)\b/i;

  /**
   * v2.5.68 (FIX 2): Claude randează raționamentul/starea ca „TurnStatus"
   * (`data-cds`/`data-testid="TurnStatus"`, `data-step-key="thinking-0"`); în
   * timpul generării același bloc afișează „Cogitating / Claude is thinking".
   * Nici starea, nici rezumatul raționamentului nu sunt răspunsul.
   */
  const STATUS_ATTR_RE = /^(?:turn-?status|thinking)$/i;
  const isStatusEl = (el: Element): boolean =>
    STATUS_ATTR_RE.test(el.getAttribute('data-cds') || '') ||
    STATUS_ATTR_RE.test(el.getAttribute('data-testid') || '');

  const classOf = (el: Element): string => {
    const c = (el as HTMLElement).className;
    return typeof c === 'string' ? c : '';
  };

  const isThinkingEl = (el: Element): boolean => {
    for (let i = 0; i < THINKING_ATTRS.length; i++) {
      const v = el.getAttribute(THINKING_ATTRS[i]);
      if (v && THINKING_ATTR_RE.test(v)) return true;
    }
    return false;
  };

  /**
   * v2.5.68 (FIX 1/2): „chrome" care nu poate fi niciodată răspunsul — textul de
   * screen reader și blocul de STARE („TurnStatus"). Regula se aplică în AMBELE
   * treceri (cu/fără filtrul de atribute), fiindcă nu depinde de marcarea
   * raționamentului, care în trecerea „relaxed" rămâne citit (paritate bug #105).
   */
  const isNonAnswerChrome = (el: Element): boolean =>
    SR_ONLY_RE.test(classOf(el)) || isStatusEl(el);

  const isThinkingMarker = (text: string): boolean => {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat || flat.length > THINKING_MARKER_MAX) return false;
    return THINKING_MARKER_RE.test(flat);
  };

  /**
   * Textul „de răspuns" al unui element + câte caractere de thinking au fost
   * scoase. `useAttrFilter` = false → ignorăm doar markerii de text.
   */
  const resolveAnswer = (
    el: Element,
    useAttrFilter: boolean
  ): { text: string; ignored: number; deduplicated: boolean } => {
    const original = textOf(el);
    if (!original) return { text: '', ignored: 0, deduplicated: false };
    if (isNonAnswerChrome(el)) {
      return { text: '', ignored: original.length, deduplicated: false };
    }
    if (useAttrFilter && isThinkingEl(el)) {
      return { text: '', ignored: original.length, deduplicated: false };
    }

    const clean = el.cloneNode(true) as Element;
    let ignored = 0;

    // v2.5.68 (FIX 1/2): textul de screen reader + blocul de stare se scot în
    // AMBELE treceri — nu sunt niciodată răspunsul.
    const chrome = Array.prototype.slice.call(clean.querySelectorAll('*')) as Element[];
    for (const node of chrome) {
      if (!clean.contains(node)) continue;
      if (isNonAnswerChrome(node)) {
        ignored += textOf(node).length;
        node.remove();
      }
    }

    if (useAttrFilter) {
      const descendants = Array.prototype.slice.call(clean.querySelectorAll('*')) as Element[];
      for (const node of descendants) {
        if (!clean.contains(node)) continue;
        const className = classOf(node);
        if (
          /\b(?:thinking|reasoning|extended-thinking)\b/i.test(className) ||
          isThinkingEl(node)
        ) {
          ignored += textOf(node).length;
          node.remove();
        }
      }
      const details = Array.prototype.slice.call(clean.querySelectorAll('details')) as Element[];
      if (clean.tagName.toLowerCase() === 'details') details.unshift(clean);
      for (const detail of details) {
        const summary = detail.querySelector('summary');
        if (summary && /\bthinking\b/i.test(textOf(summary))) {
          ignored += textOf(detail).length;
          detail.remove();
        }
      }
    }

    const full = textOf(clean);
    if (!full) return { text: '', ignored: original.length, deduplicated: false };
    const kids = Array.prototype.slice.call(clean.children) as Element[];
    let sawThinkingChild = false;
    const kept: string[] = [];
    for (let i = 0; i < kids.length; i++) {
      const t = textOf(kids[i]);
      if (!t) continue;
      if (isThinkingMarker(t)) {
        sawThinkingChild = true;
        ignored += t.length;
        continue;
      }
      kept.push(t);
    }
    const finish = (value: string, ignoredChars: number) => {
      let text = value.trim().replace(/^(?:Claude\s+responded:\s*)/i, '');
      const paragraphs = text.split(/\n{2,}/);
      const seen = new Set<string>();
      const finalParagraphs: string[] = [];
      let deduplicated = false;
      let duplicateChars = 0;
      for (let i = paragraphs.length - 1; i >= 0; i--) {
        const paragraph = paragraphs[i].trim();
        if (!paragraph) continue;
        if (seen.has(paragraph)) {
          deduplicated = true;
          duplicateChars += paragraph.length;
          continue;
        }
        seen.add(paragraph);
        finalParagraphs.unshift(paragraph);
      }
      if (deduplicated) text = finalParagraphs.join('\n\n');
      return { text, ignored: ignoredChars + duplicateChars, deduplicated };
    };
    if (sawThinkingChild) {
      const text = kept.join('\n\n').trim();
      if (!text) return finish('', ignored);
      if (isThinkingMarker(text)) return finish('', ignored + text.length);
      return finish(text, ignored);
    }

    if (kids.length === 0) {
      if (isThinkingMarker(full)) return finish('', ignored + full.length);
      return finish(full, ignored);
    }

    // „Thinking completed\n\n<răspuns>”: scoatem doar linia-marker de la început
    const nl = full.indexOf('\n');
    if (nl > 0) {
      const head = full.slice(0, nl).trim();
      const rest = full.slice(nl + 1).trim();
      if (rest && isThinkingMarker(head)) return finish(rest, ignored + head.length);
    }
    return finish(full, ignored);
  };

  let ignoredTotal = 0;

  const matched = (sel: string): Element[] => {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      return [];
    }
    return Array.prototype.slice.call(nodes) as Element[];
  };

  const readFromSelectors = (
    useAttrFilter: boolean
  ): { text: string; ignored: number; deduplicated: boolean; matches: number } | null => {
    for (const sel of args.sels) {
      const nodes = matched(sel);
      // v2.5.68 (FIX 3): ultimul element e răspunsul curent — elementele
      // anterioare sunt mesaje VECHI (nu se concatenează). Numărul de potriviri
      // se raportează în `matches`, ca să fie vizibil în log.
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (inNav(nodes[i])) continue;
        const r = resolveAnswer(nodes[i], useAttrFilter);
        ignoredTotal += r.ignored;
        if (r.text) return { ...r, matches: nodes.length };
      }
    }
    return null;
  };

  const countFromSelectors = (useAttrFilter: boolean): number => {
    for (const sel of args.sels) {
      const nodes = matched(sel);
      let count = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (inNav(nodes[i])) continue;
        const r = resolveAnswer(nodes[i], useAttrFilter);
        ignoredTotal += r.ignored;
        if (r.text) count++;
      }
      if (count) return count;
    }
    return 0;
  };

  if (args.mode === 'count') {
    const strict = countFromSelectors(true);
    // paritate cu v2.5.45 pentru paginile fără blocuri de thinking detectabile
    const count = strict || countFromSelectors(false);
    return { text: '', ignored: ignoredTotal, count, deduplicated: false };
  }

  /**
   * Ultima variantă: cel mai probabil bloc de mesaj, fără selectori (aceeași
   * euristică de „cel mai interior bloc” ca în v2.5.45, doar că textul trece
   * prin resolveAnswer, deci blocurile de thinking sunt scoase).
   */
  const pickGeneric = (
    useAttrFilter: boolean
  ): { text: string; ignored: number; deduplicated: boolean } | null => {
    const pool = document.querySelectorAll(
      'div, article, section, p, message-content, model-response'
    );
    const candidates: Element[] = [];
    const resolved = new Map<Element, { text: string; deduplicated: boolean }>();
    let ignored = 0;
    for (let i = 0; i < pool.length; i++) {
      const el = pool[i];
      const full = textOf(el);
      if (full.length < 40 || full.length > 20000) continue;
      if (!isVisible(el)) continue;
      if (inNav(el)) continue;
      if (el.querySelector('textarea, [contenteditable="true"]')) continue;
      if (!el.querySelector('p, li, pre, code') && full.length < 120) continue;
      const r = resolveAnswer(el, useAttrFilter);
      ignored += r.ignored;
      if (!r.text) continue;
      resolved.set(el, { text: r.text, deduplicated: r.deduplicated });
      candidates.push(el);
    }

    // păstrăm doar cele mai "interioare" (fără un copil-candidat aproape la fel de mare)
    const inner = candidates.filter((el) => {
      const own = (resolved.get(el) as { text: string }).text;
      return !candidates.some(
        (child) =>
          child !== el &&
          el.contains(child) &&
          (resolved.get(child) as { text: string }).text.length >= own.length * 0.7
      );
    });

    const last = inner.length ? inner[inner.length - 1] : null;
    if (!last) return null;
    const answer = resolved.get(last) as { text: string; deduplicated: boolean };
    return { text: answer.text, ignored, deduplicated: answer.deduplicated };
  };

  const strict = readFromSelectors(true);
  if (strict) {
    return {
      text: strict.text,
      ignored: ignoredTotal,
      count: 0,
      deduplicated: strict.deduplicated,
      matches: strict.matches
    };
  }

  const ignoredStrict = ignoredTotal;

  // pas 2 (doar la rescue): scanul generic, tot cu filtrarea blocurilor de
  // thinking — preferat înaintea „parității", ca tool call-ul să nu fie pierdut
  // în favoarea textului de raționament rămas pe ecran
  const genericStrict = args.fallback ? pickGeneric(true) : null;
  if (genericStrict) {
    return {
      text: genericStrict.text,
      ignored: ignoredStrict + genericStrict.ignored,
      count: 0,
      deduplicated: genericStrict.deduplicated
    };
  }

  // pas 3: paritate cu v2.5.45 — reluăm citirea fără filtrul de atribute, ca să
  // nu răspundem „gol" acolo unde versiunea anterioară citea ceva
  const relaxed = readFromSelectors(false);
  if (relaxed) {
    return {
      text: relaxed.text,
      ignored: ignoredStrict + relaxed.ignored,
      count: 0,
      deduplicated: relaxed.deduplicated,
      matches: relaxed.matches
    };
  }

  // pas 4 (doar la rescue): scan generic fără filtrul de atribute
  const genericRelaxed = args.fallback ? pickGeneric(false) : null;
  if (genericRelaxed) {
    return {
      text: genericRelaxed.text,
      ignored: ignoredStrict + genericRelaxed.ignored,
      count: 0,
      deduplicated: genericRelaxed.deduplicated
    };
  }

  return { text: '', ignored: ignoredStrict, count: 0, deduplicated: false };
};

/* =========================================================================
 * API public
 * ========================================================================= */

/* =========================================================================
 * v0.9.5 — AI-POWERED SELECTOR DISCOVERY (hook)
 *
 * Când healer-ul clasic nu găsește NICIUN candidat valid (sau toate sunt
 * eliminate de blacklist/fragile), îl lăsăm pe fallback-ul AI (implementat
 * în ai-selector-finder.ts, înregistrat din activate()) să propună selectori
 * pe baza unui snapshot DOM. Fără înregistrare, comportamentul e cel vechi.
 * ========================================================================= */
export type AIFinderFn = (
  page: Page,
  providerId: string,
  slot: SlotName,
  echoText?: string
) => Promise<string | null>;

let aiFinderFn: AIFinderFn | null = null;

/** Înregistrează fallback-ul AI (null = dezactivat). */
export function setAIFinder(fn: AIFinderFn | null) {
  aiFinderFn = fn;
}

/* -------------------------------------------------------------------------
 * v2.5.61 (FIX 1) — VALIDARE FUNCȚIONALĂ (hook)
 *
 * Healer-ul nu mai salvează un candidat doar pentru că are scorul cel mai bun:
 * îl testează în pagină (click/type/read) înainte de `learn()`. Implementarea
 * stă în ai-selector-finder.ts (are deja validatoarele stricte) și se
 * înregistrează din initAISelectorFinder() — importul direct ar închide un ciclu
 * de module (ai-selector-finder importă selectors).
 * ------------------------------------------------------------------------- */

export type SlotFunctionalValidatorFn = (
  page: Page,
  providerId: string,
  slot: SlotName,
  selector: string
) => Promise<boolean>;

let functionalValidatorFn: SlotFunctionalValidatorFn | null = null;

/** Înregistrează testul funcțional al candidaților (null = dezactivat). */
export function setFunctionalValidator(fn: SlotFunctionalValidatorFn | null) {
  functionalValidatorFn = fn;
}

/* -------------------------------------------------------------------------
 * v2.5.72 (FIX 2) — REPARAREA UNUI SELECTOR USER-LOCKED AUTO-UNLOCKED (hook)
 *
 * Când un selector user-locked pică de 3 ori la rând, iese din `_meta.locked`
 * și, imediat, AI Finder-ul e întrebat pentru acel slot (implementarea stă în
 * ai-selector-finder.ts, înregistrată din initAISelectorFinder()). La succes,
 * finder-ul re-lockuiește noul selector pentru utilizator.
 * ------------------------------------------------------------------------- */

export type UserLockRepairFn = (
  page: Page,
  providerId: string,
  slot: SlotName
) => Promise<string | null>;

let userLockRepairFn: UserLockRepairFn | null = null;

/** Înregistrează repararea selectorilor user-locked auto-unlocked. */
export function setUserLockRepair(fn: UserLockRepairFn | null) {
  userLockRepairFn = fn;
}

/* -------------------------------------------------------------------------
 * v2.5.45 (bug #102) — DESCOPERIRE PROACTIVĂ + REPARAREA INPUTULUI (hook-uri)
 *
 * Aceleași două funcții sunt implementate în ai-selector-finder.ts și
 * înregistrate din initAISelectorFinder(). Nu le importăm direct din
 * providers/base.ts: ai-selector-finder importă providers/index (etichetele
 * providerilor), care importă providers/base — un import invers ar închide un
 * ciclu de module.
 * ------------------------------------------------------------------------- */

/** Rezultatul unei descoperiri proactive (bug #102). */
export interface DiscoveryOutcome {
  /** S-a rulat analiza AI? (false = nu era momentul / pagina nu e gata) */
  ran: boolean;
  /** Ce s-a salvat: „slot=selector" pentru fiecare slot validat. */
  applied: string[];
  /** Motivul (pentru log/comandă): poate fi și motivul pentru care nu s-a rulat. */
  reason: string;
  /** Login/CAPTCHA page; retry only after the user is ready. */
  pending?: boolean;
}

export type ProactiveDiscoveryFn = (
  page: Page,
  providerId: string,
  opts?: { force?: boolean }
) => Promise<DiscoveryOutcome>;

/** Rezultatul unei reparații țintite a căsuței de chat (bug #102). */
export interface InputRepairResult {
  /** Selectorul nou, validat în pagină (null = n-a găsit nimic). */
  selector: string | null;
  /** true = au fost epuizate încercările din sesiune → card în chat. */
  gaveUp: boolean;
  reason: string;
}

export type InputRepairFn = (page: Page, providerId: string) => Promise<InputRepairResult>;

/** v2.5.45 (bug #102): pagina nu e gata (login/CAPTCHA/chat gol). */
export type NotReadyFn = (providerId: string, reason: string) => void;

let proactiveDiscoveryFn: ProactiveDiscoveryFn | null = null;
let inputRepairFn: InputRepairFn | null = null;
let notReadyFn: NotReadyFn | null = null;

/** Înregistrează descoperirea proactivă (null = dezactivată). */
export function setProactiveDiscovery(fn: ProactiveDiscoveryFn | null) {
  proactiveDiscoveryFn = fn;
}

/** Înregistrează repararea țintită a inputului (null = dezactivată). */
export function setInputRepair(fn: InputRepairFn | null) {
  inputRepairFn = fn;
}

/** Înregistrează notificarea „pagina nu e gata" (null = dezactivată). */
export function setNotReadyNotifier(fn: NotReadyFn | null) {
  notReadyFn = fn;
}

/** Descoperirea completă înregistrată (sau null); folosită de reparația manuală. */
export function proactiveDiscovery(): ProactiveDiscoveryFn | null {
  return proactiveDiscoveryFn;
}

/** Repararea de input înregistrată (sau null). */
export function inputRepair(): InputRepairFn | null {
  return inputRepairFn;
}

/**
 * Fix 2 (bug #102): pagina nu e gata (login/CAPTCHA/chat gol) — AI finder-ul
 * ține minte că descoperirea e datorată și o reia la următoarea conectare.
 */
export function notifyNotReady(providerId: string, reason: string): void {
  try {
    notReadyFn?.(providerId, reason);
  } catch {
    /* fail-open: semnalarea nu are voie să strice fluxul de conectare */
  }
}

/** Reparare prin fingerprint: caută elementul după semnale "moi".
 *  v0.9.4: `echoText` = mesajul tocmai trimis — candidații de response care
 *  încep cu el (containere de conversație) sunt respinși la scanare. */
export async function healSlot(
  page: Page,
  providerId: string,
  slot: SlotName,
  echoText?: string
): Promise<string | null> {
  const slotKey = providerId + '.' + slot;
  let failureRecorded = false;
  if (selectors.isLocked(providerId, slot)) {
    const locked = selectors.learned(providerId, slot);
    let ok = false;
    if (locked && functionalValidatorFn) {
      try {
        ok = await functionalValidatorFn(page, providerId, slot, locked.selector);
      } catch (e: any) {
        log(
          'functional test errored for user-locked ' + slotKey + ' (' + locked.selector + '): ' +
            (e?.message ?? String(e))
        );
      }
    }
    if (ok) {
      selectors.recordSuccess(providerId, slot);
      healLog('user-locked ' + slotKey + ' passed functional test — keeping the user selector');
      return null;
    }
    if (!functionalValidatorFn || !locked) {
      healLog('skip ' + providerId + ':' + slot + ' — user-locked');
      log('tier 2 (user) locked for ' + slotKey + ' — keeping the user selector');
      return null;
    }
    selectors.recordFailure(providerId, slot);
    failureRecorded = true;
    if (selectors.isLocked(providerId, slot)) return null;
    // v2.5.72 (FIX 2): selectorul tocmai a fost auto-unlocked (al 3-lea eșec) —
    // întrebăm AI Finder-ul acum; la succes, finder-ul îl re-lockuiește pentru
    // utilizator. Dacă nu găsește nimic, rămâne unlocked pentru următoarea
    // încercare (cascada normală nu mai rulează în acest apel).
    if (selectors.isAutoUnlocked(providerId, slot) && userLockRepairFn) {
      try {
        log('auto-unlock repair via AI Finder for ' + slotKey + '...');
        const repaired = await userLockRepairFn(page, providerId, slot);
        if (repaired) return repaired;
      } catch (e: any) {
        log('auto-unlock repair failed for ' + slotKey + ': ' + (e?.message ?? String(e)));
      }
      log('auto-unlock failed for ' + slotKey + ' — leaving unlocked for next retry');
      return null;
    }
  }

  // v2.5.61 (FIX 3): reparația pornește la PRIMUL eșec — nu așteptăm trei.
  log('immediate repair triggered for ' + slotKey);
  // v2.5.61 (FIX 7): selectorii bundled au fost deja încercați (resolveSlot) iar
  // unul salvat (dacă exista) tocmai a picat. FIX 4: al doilea eșec consecutiv
  // al unui selector salvat îl șterge automat.
  log('tier 1 (bundled) failed for ' + slotKey);
  const learned = selectors.learned(providerId, slot);
  if (learned && !failureRecorded) {
    log('tier 2 (user) failed for ' + slotKey);
    selectors.recordFailure(providerId, slot);
  }

  const fp = selectors.fingerprint(providerId, slot);
  if (!fp) {
    log('heal: ' + slotKey + ' has no fingerprint defined');
  } else {
    // v0.9.0: preferredKeywords (dacă sunt definite) întăresc scorul candidaților
    const keywords = selectors.slotConfig(providerId, slot)?.preferredKeywords ?? [];
    let found: ScanResult[] = [];
    try {
      found = await page.evaluate<ScanResult[], ScanArgs>(scanCandidates, {
        fp,
        slot,
        blacklist: BLACKLIST_KEYWORDS,
        promoText: PROMO_TEXT_PHRASES,
        echoText,
        keywords,
        navSels: NAV_SELECTORS
      });
    } catch (e: any) {
      log('heal evaluate failed (' + slotKey + '): ' + (e?.message ?? String(e)));
      found = [];
    }

    const usable = (found || []).filter(
      (c) => isUsableSelector(c.selector) && !isPersistBlocked(slot, c.selector)
    );
    // FIX v2: preferăm selectorii stabili; nth-of-type doar ca ultimă variantă.
    const stable = usable.filter((c) => !isFragileSelector(c.selector));
    const ordered = [...stable, ...usable.filter((c) => isFragileSelector(c.selector))];
    log('tier 3 (healer) trying for ' + slotKey + ' (' + ordered.length + ' candidate(s))');

    // v2.5.61 (FIX 1): candidatul se TESTEAZĂ funcțional înainte de `learn()`.
    for (const candidate of ordered.slice(0, HEALER_MAX_FUNCTIONAL_TRIES)) {
      // v2.5.65 (FIX 2): un candidat slab nu se salvează (vezi MIN_HEALER_SCORE).
      // v2.5.74 (FIX 1): pentru `newChat` pragul e mai mare (NEWCHAT_MIN_SCORE).
      const minScore = minHealerScore(slot);
      if (candidate.score < minScore) {
        healLog(
          'candidate rejected: ' + candidate.selector + ' (score ' + candidate.score +
            ' < ' + minScore + ')'
        );
        continue;
      }
      if (functionalValidatorFn) {
        let ok = false;
        try {
          ok = await functionalValidatorFn(page, providerId, slot, candidate.selector);
        } catch (e: any) {
          log(
            'functional test errored for ' + slotKey + ' (' + candidate.selector + '): ' +
              (e?.message ?? String(e))
          );
          ok = false;
        }
        if (!ok) {
          healLog('candidate rejected: ' + candidate.selector + ' (functional test failed)');
          continue;
        }
      }
      log(
        'heal ' +
          slotKey +
          ' -> ' +
          candidate.selector +
          ' (scor ' +
          candidate.score +
          ' | ' +
          candidate.why.join(', ') +
          ')'
      );
      selectors.recordSuccess(providerId, slot);
      // v2.5.75 (FIX 2): un selector pozițional (fragil) nu trece prin `learn()`
      // — dar dacă e singurul care a trecut testul funcțional, îl păstrăm ca
      // FALLBACK (la coada candidaților), nu îl aruncăm. Altfel slotul rămânea
      // fără niciun selector până la următoarea rulare.
      if (isFragileSelector(candidate.selector)) {
        if (selectors.learnFallback(providerId, slot, candidate.selector)) {
          log(
            'keeping fragile fallback for ' + slotKey + ' -> ' + candidate.selector +
              ' (no stable selector available)'
          );
        }
      } else {
        selectors.learn(providerId, slot, candidate.selector, 'fingerprint');
      }
      return candidate.selector;
    }
    if (ordered.length) {
      log(
        'tier 3 (healer) found no candidate that passed the score/functional test for ' + slotKey
      );
    } else {
      log('tier 3 (healer) found no candidate for ' + slotKey);
    }
  }

  // Tier 4 (AI Finder: browser/ollama) + tier 5 (backup) — implementate în
  // ai-selector-finder.ts și înregistrate prin setAIFinder().
  if (aiFinderFn) {
    try {
      log('tier 4 (AI Finder) for ' + slotKey + '...');
      const aiSel = await aiFinderFn(page, providerId, slot, echoText);
      if (aiSel) {
        log('heal ' + slotKey + ' -> ' + aiSel + ' (AI)');
        return aiSel;
      }
      log('tier 4/5: no usable selector for ' + slotKey);
    } catch (e: any) {
      log('AI finder failed for ' + slotKey + ': ' + (e?.message ?? String(e)));
    }
  } else {
    log('tier 4 (AI Finder) unavailable for ' + slotKey + ' — hook not registered');
  }

  log('tier 6/7: no automatic repair for ' + slotKey);
  return null;
}

/**
 * Găsește un element pentru un slot: override -> primary -> alternatives,
 * iar dacă nimic nu se potrivește, repară prin fingerprint. Nu aruncă niciodată.
 */
export async function resolveSlot(
  page: Page,
  providerId: string,
  slot: SlotName,
  timeoutMs: number
): Promise<{ locator: Locator; selector: string } | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const healAfter = Math.min(6000, Math.max(2000, timeoutMs / 3));
  const started = Date.now();
  let healed = false;

  while (true) {
    for (const sel of selectors.candidates(providerId, slot)) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          // v2.5.61 (FIX 4): slotul a funcționat — eșecurile consecutive se resetează
          selectors.recordSuccess(providerId, slot);
          selectors.note(providerId, slot, sel);
          return { locator: loc, selector: sel };
        }
      } catch {
        /* selector invalid sau pagină în tranziție — încercăm următorul */
      }
    }

    const now = Date.now();
    if (!healed && now - started > healAfter) {
      healed = true;
      const sel = await healSlot(page, providerId, slot);
      if (sel) {
        const loc = page.locator(sel).first();
        try {
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            selectors.recordSuccess(providerId, slot);
            return { locator: loc, selector: sel };
          }
        } catch {
          /* continuăm */
        }
      }
    }

    if (now >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** true dacă inputul e disponibil (folosit la open()/newChat()). */
export async function inputAvailable(
  page: Page,
  providerId: string,
  timeoutMs: number
): Promise<boolean> {
  return (await resolveSlot(page, providerId, 'input', timeoutMs)) !== null;
}

const anyMatch = (args: { sels: string[]; navSels?: string[] }): boolean => {
  // v2.5.13 FIX (bug #37): un „match” doar în sidebar nu înseamnă că selectorii
  // de răspuns funcționează — altfel un override greșit bloca auto-repararea.
  const inNav = (el: Element): boolean => {
    const list = args.navSels || [];
    for (let i = 0; i < list.length; i++) {
      try {
        if (el.closest(list[i]) !== null) return true;
      } catch {
        /* selector invalid — îl ignorăm */
      }
    }
    return false;
  };

  for (const sel of args.sels) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (let i = 0; i < nodes.length; i++) {
      if (inNav(nodes[i])) continue;
      const text = (((nodes[i] as HTMLElement).innerText || '') as string).trim();
      if (text) return true;
    }
  }
  return false;
};

/** true dacă măcar un selector prinde un element cu text (deci nu trebuie reparat). */
export async function anySelectorMatches(page: Page, sels: string[]): Promise<boolean> {
  try {
    return await page.evaluate<boolean, { sels: string[]; navSels: string[] }>(anyMatch, {
      sels,
      navSels: NAV_SELECTORS
    });
  } catch {
    return false;
  }
}

const anyPresent = (args: { sels: string[] }): boolean => {
  for (const sel of args.sels) {
    try {
      if (document.querySelector(sel)) return true;
    } catch {
      /* selector invalid — îl ignorăm */
    }
  }
  return false;
};

/** FIX v2: true dacă vreunul dintre selectori există în DOM (fără test de text/vizibilitate). */
export async function anySelectorPresent(page: Page, sels: string[]): Promise<boolean> {
  try {
    return await page.evaluate<boolean, { sels: string[] }>(anyPresent, { sels });
  } catch {
    return false;
  }
}

/**
 * v2.5.46 (bug #105): citirea completă a răspunsului — textul + câte caractere
 * de „thinking" au fost ignorate (pentru log-ul `[read] response: …`).
 * v2.5.68 (FIX 3): când selectorul prinde mai multe mesaje, se citește DOAR
 * ultimul (răspunsul curent); numărul de potriviri apare în log o singură dată
 * per schimbare (`[read] using last of N assistant messages`).
 */
export async function getLastResponseRead(
  page: Page,
  sels: string[],
  fallback = false
): Promise<ResponseRead> {
  try {
    const read = await page.evaluate<ResponseRead, ResponseScanArgs>(scanResponses, {
      sels,
      fallback,
      navSels: NAV_SELECTORS,
      mode: 'text'
    });
    const matches = read.matches ?? 0;
    if (matches !== lastLoggedMatches) {
      lastLoggedMatches = matches;
      if (matches > 1) {
        readLog('using last of ' + matches + ' assistant messages');
      }
    }
    // v2.5.66 (FIX 4): scoate paragrafele de „thinking" rămase în elementul de
    // răspuns (același slot ca răspunsul, nu bloc separat) — vezi helper-ul.
    const cleaned = filterThinkingParagraphs(read.text);
    if (cleaned.filtered) {
      return { ...read, text: cleaned.text, filtered: cleaned.filtered };
    }
    return read;
  } catch (e: any) {
    log('reading the response failed: ' + (e?.message ?? String(e)));
    return { text: '', ignored: 0, count: 0 };
  }
}

/**
 * Textul ultimului răspuns (ultimul element non-gol din primul selector valid),
 * FĂRĂ blocurile de raționament — vezi scanResponses (v2.5.46, bug #105).
 */
export async function getLastResponseText(
  page: Page,
  sels: string[],
  fallback = false
): Promise<string> {
  return (await getLastResponseRead(page, sels, fallback)).text;
}

/**
 * v2.5.12 FIX (bug #36): numărul de răspunsuri vizibile în DOM pentru slotul
 * `response` (aceeași logică/selectori ca getLastResponseText, deci și aceeași
 * excludere a blocurilor de thinking — bug #105). O creștere a acestui număr =
 * a apărut un răspuns NOU, indiferent de conținutul lui.
 */
export async function countAssistantResponses(
  page: Page,
  sels: string[]
): Promise<number> {
  try {
    const read = await page.evaluate<ResponseRead, ResponseScanArgs>(scanResponses, {
      sels,
      fallback: false,
      navSels: NAV_SELECTORS,
      mode: 'count'
    });
    return read.count;
  } catch (e: any) {
    log('counting the responses failed: ' + (e?.message ?? String(e)));
    return 0;
  }
}

export function configInfo(): SelectorInfo {
  return selectors.info();
}
