import { Locator, Page } from 'playwright';
// IMPORTANT: `vscode` doar ca TIP — la runtime se cere lazy (require), ca
// modulul să poată fi încărcat și în teste Node (fără VS Code).
import type * as vscode from 'vscode';
import rawConfig from './selectors.json';
import { logLine } from './log';

const log = (msg: string) => logLine('selectors', msg);

/* =========================================================================
 * FAZA I — SELECTOARE MODULARE + AUTO-REPARARE
 *
 * selectors.json  = sursa de adevăr (editabilă manual, versionată)
 * SelectorStore   = citește configul + overlay cu selectorii învățați
 *                   (persistați în globalState => supraviețuiesc sesiunilor)
 * healSlot()      = caută elementul după "fingerprint" când selectoarele
 *                   cunoscute nu mai găsesc nimic, apoi salvează rezultatul
 * ========================================================================= */

export type SlotName = 'input' | 'response' | 'newChat' | 'stopButton';

export const SLOTS: SlotName[] = ['input', 'response', 'newChat', 'stopButton'];

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
}

export interface SelectorConfig {
  version: string;
  updated: string;
  /** Notă scurtă despre ce s-a reparat (afișată la update-ul remote). */
  changelog?: string;
  providers: Record<string, ProviderConfig>;
}

export type LearnHow = 'alternative' | 'fingerprint' | 'ai';

export interface LearnedSelector {
  provider: string;
  slot: SlotName;
  selector: string;
  how: LearnHow;
  at: number;
  /** v0.9.5: metadate din descoperirea AI (copiate și în selectors-user.json). */
  confidence?: number;
  reasoning?: string;
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
  return {
    version: overlay.version,
    updated: overlay.updated || base.updated,
    changelog: overlay.changelog,
    providers: { ...base.providers, ...overlay.providers }
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
  'reward', 'referral', 'coupon', 'discount', 'trial'
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

function isUsableSelector(sel: string): boolean {
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

export class SelectorStore {
  private overrides = new Map<string, LearnedSelector>();
  private memento?: vscode.Memento;
  private notifier?: (info: LearnedSelector) => void;
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

  /** Ordinea de încercare: override învățat -> primary -> alternatives. */
  candidates(providerId: string, slot: SlotName): string[] {
    const learned = this.overrides.get(this.key(providerId, slot))?.selector;
    const list = [...this.staticCandidates(providerId, slot)];
    if (learned && !list.includes(learned)) list.unshift(learned);
    return list;
  }

  learned(providerId: string, slot: SlotName): LearnedSelector | undefined {
    return this.overrides.get(this.key(providerId, slot));
  }

  listLearned(): LearnedSelector[] {
    return Array.from(this.overrides.values());
  }

  /**
   * Marchează selectorul care a funcționat. Dacă e un selector static
   * (primary/alternative) nu avem ce învăța; dacă e unul nou (reparat prin
   * fingerprint) îl salvăm pentru sesiunile viitoare.
   */
  note(providerId: string, slot: SlotName, selector: string) {
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
    const key = this.key(providerId, slot);
    const existing = this.overrides.get(key);
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
    log('selector repaired: ' + key + ' -> ' + selector + ' (' + how + ')');
    void this.persist();
    try {
      this.notifier?.(entry);
    } catch (e: any) {
      log('notifier failed: ' + (e?.message ?? String(e)));
    }
    return true;
  }

  /** Uită un singur override (ex: repararea a fost respinsă de provider). */
  forget(providerId: string, slot: SlotName): boolean {
    const key = this.key(providerId, slot);
    if (!this.overrides.delete(key)) return false;
    log('override removed: ' + key);
    void this.persist();
    return true;
  }

  /** Șterge override-urile (toate, sau doar pentru un provider). */
  reset(providerId?: string): number {
    let removed = 0;
    for (const [key, entry] of Array.from(this.overrides.entries())) {
      if (providerId && entry.provider !== providerId) continue;
      this.overrides.delete(key);
      removed++;
    }
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

    if (fp.hasChildren) {
      let hits = 0;
      for (const c of fp.hasChildren) {
        if (el.querySelector(c)) hits++;
      }
      if (hits) {
        s += 2 * Math.min(hits, 3);
        why.push('children:' + hits);
      }
    }

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
      if (echoText.length >= 40) {
        const textNorm = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (textNorm.indexOf(echoText) >= 0) return null;
      }
      if (fp.minTextLength && text.length < fp.minTextLength) return null;
      if (text.length > 12000) return null;
      if (el.querySelector('textarea, [contenteditable="true"]')) return null;
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
}

const readLastText = (args: ReadArgs): string => {
  const textOf = (el: Element): string =>
    (((el as HTMLElement).innerText || el.textContent || '') as string).trim();

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  for (const sel of args.sels) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const text = textOf(nodes[i]);
      if (text) return text;
    }
  }

  if (!args.fallback) return '';

  // Ultima variantă: cel mai probabil bloc de mesaj, fără selectori.
  const pool = document.querySelectorAll(
    'div, article, section, p, message-content, model-response'
  );
  const candidates: Element[] = [];
  for (let i = 0; i < pool.length; i++) {
    const el = pool[i];
    const text = textOf(el);
    if (text.length < 40 || text.length > 20000) continue;
    if (!isVisible(el)) continue;
    if (el.querySelector('textarea, [contenteditable="true"]')) continue;
    if (!el.querySelector('p, li, pre, code') && text.length < 120) continue;
    candidates.push(el);
  }

  // păstrăm doar cele mai "interioare" (fără un copil-candidat aproape la fel de mare)
  const inner = candidates.filter((el) => {
    const own = textOf(el).length;
    return !candidates.some(
      (child) => child !== el && el.contains(child) && textOf(child).length >= own * 0.7
    );
  });

  const last = inner.length ? inner[inner.length - 1] : null;
  return last ? textOf(last) : '';
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

/** Reparare prin fingerprint: caută elementul după semnale "moi".
 *  v0.9.4: `echoText` = mesajul tocmai trimis — candidații de response care
 *  încep cu el (containere de conversație) sunt respinși la scanare. */
export async function healSlot(
  page: Page,
  providerId: string,
  slot: SlotName,
  echoText?: string
): Promise<string | null> {
  const fp = selectors.fingerprint(providerId, slot);
  if (!fp) {
    log('heal: ' + providerId + '.' + slot + ' has no fingerprint defined');
    return null;
  }
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
      keywords
    });
  } catch (e: any) {
    log('heal evaluate failed (' + providerId + '.' + slot + '): ' + (e?.message ?? String(e)));
    return null;
  }

  const usable = (found || []).filter(
    (c) => isUsableSelector(c.selector) && !isPersistBlocked(slot, c.selector)
  );
  // FIX v2: preferăm selectorii stabili; nth-of-type doar ca ultimă variantă.
  const best = usable.find((c) => !isFragileSelector(c.selector)) ?? usable[0];
  if (!best) {
    // v0.9.5: fallback AI — healer-ul clasic a eșuat complet
    if (aiFinderFn) {
      try {
        log('heal: no candidate for ' + providerId + '.' + slot + ' — trying AI finder');
        const aiSel = await aiFinderFn(page, providerId, slot, echoText);
        if (aiSel) {
          log('heal ' + providerId + '.' + slot + ' -> ' + aiSel + ' (AI)');
          return aiSel;
        }
        log('AI finder: no usable selector for ' + providerId + '.' + slot);
      } catch (e: any) {
        log('AI finder failed for ' + providerId + '.' + slot + ': ' + (e?.message ?? String(e)));
      }
    } else {
      log('heal: no candidate for ' + providerId + '.' + slot);
    }
    return null;
  }

  log(
    'heal ' +
      providerId +
      '.' +
      slot +
      ' -> ' +
      best.selector +
      ' (scor ' +
      best.score +
      ' | ' +
      best.why.join(', ') +
      ')'
  );
  selectors.learn(providerId, slot, best.selector, 'fingerprint');
  return best.selector;
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

const anyMatch = (args: { sels: string[] }): boolean => {
  for (const sel of args.sels) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (let i = 0; i < nodes.length; i++) {
      const text = (((nodes[i] as HTMLElement).innerText || '') as string).trim();
      if (text) return true;
    }
  }
  return false;
};

/** true dacă măcar un selector prinde un element cu text (deci nu trebuie reparat). */
export async function anySelectorMatches(page: Page, sels: string[]): Promise<boolean> {
  try {
    return await page.evaluate<boolean, { sels: string[] }>(anyMatch, { sels });
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

/** Textul ultimului răspuns (ultimul element non-gol din primul selector valid). */
export async function getLastResponseText(
  page: Page,
  sels: string[],
  fallback = false
): Promise<string> {
  try {
    return await page.evaluate<string, ReadArgs>(readLastText, { sels, fallback });
  } catch (e: any) {
    log('reading the response failed: ' + (e?.message ?? String(e)));
    return '';
  }
}

export function configInfo(): SelectorInfo {
  return selectors.info();
}
