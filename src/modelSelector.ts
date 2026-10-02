import { Locator, Page } from 'playwright';
import { logLine } from './log';
import { humanBehaviorEnabled, humanClickButton, humanScroll } from './human-behavior';

const log = (msg: string) => logLine('model-selector', msg);

/* =========================================================================
 * v2.2.0 — MODEL SELECTION REAL (chip-ul din composer)
 *
 * Fiecare site are propriul dropdown de model. Modulul ăsta îl deschide,
 * citește opțiunile contului curent, apoi aplică modelul ales de utilizator
 * în chip: click pe buton → click pe opțiune → verificare.
 *
 * Totul e best-effort: dacă site-ul și-a schimbat DOM-ul, `applyModel`
 * întoarce `false` și chatul continuă cu modelul implicit al site-ului.
 * ========================================================================= */

/** Un model selectabil, așa cum e el afișat în chip-ul din composer. */
export interface ModelOption {
  /** ID intern pentru Freekit (ex: 'gpt-4o'). */
  id: string;
  /** Afișat utilizatorului (ex: 'GPT-4o'). */
  label: string;
  description?: string;
  badge?: 'fast' | 'smart' | 'reasoning';
}

/** Model din catalog + textele după care îl recunoaștem în dropdown-ul site-ului. */
interface ModelSpec extends ModelOption {
  /** Termeni (lowercase) căutați în textul opțiunii din meniul site-ului. */
  match: string[];
}

interface ProviderModelSelectors {
  /**
   * Candidatți pentru butonul care deschide dropdown-ul de model
   * (sau, la DeepSeek, toggle-ul DeepThink/Chat).
   */
  button: string[];
  /** Candidatți pentru opțiunile din dropdown-ul deschis. */
  option: string[];
  /** Candidatți pentru elementul care afișează modelul curent (pentru verificare). */
  current?: string[];
}

/* =========================================================================
 * CATALOG — modelele expuse în chip, per provider.
 * Ordinea = ordinea din meniu (cele mai bune întâi).
 * ========================================================================= */

const MODELS: Record<string, ModelSpec[]> = {
  chatgpt: [
    { id: 'gpt-4o', label: 'GPT-4o', badge: 'smart', match: ['gpt-4o', 'gpt 4o'] },
    { id: 'gpt-4-1', label: 'GPT-4.1', badge: 'smart', match: ['gpt-4.1', 'gpt 4.1'] },
    { id: 'gpt-4-1-mini', label: 'GPT-4.1 mini', badge: 'fast', match: ['gpt-4.1 mini', 'gpt 4.1 mini', '4.1 mini'] },
    { id: 'o3', label: 'o3', badge: 'reasoning', match: ['o3'] },
    { id: 'o4-mini', label: 'o4-mini', badge: 'reasoning', match: ['o4-mini', 'o4 mini'] }
  ],
  claude: [
    { id: 'claude-sonnet', label: 'Claude 3.5 Sonnet', badge: 'smart', match: ['sonnet', '3.5 sonnet'] },
    { id: 'claude-opus', label: 'Claude Opus', badge: 'reasoning', match: ['opus'] },
    { id: 'claude-haiku', label: 'Claude 3.5 Haiku', badge: 'fast', match: ['haiku'] }
  ],
  gemini: [
    { id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro', badge: 'smart', match: ['2.5 pro', '2 5 pro'] },
    { id: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash', badge: 'fast', match: ['2.5 flash', '2 5 flash'] }
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'Chat (V3)', badge: 'fast', match: ['chat (v3)', 'chat v3', 'v3', 'deepseek-chat'] },
    { id: 'deepseek-reasoner', label: 'DeepThink (R1)', badge: 'reasoning', match: ['deepthink', 'deepseek-r1', '(r1)', 'r1'] }
  ],
  mistral: [
    { id: 'mistral-large', label: 'Mistral Large', badge: 'smart', match: ['large'] },
    { id: 'mistral-medium', label: 'Mistral Medium', badge: 'smart', match: ['medium'] },
    { id: 'mistral-small', label: 'Mistral Small', badge: 'fast', match: ['small'] },
    { id: 'codestral', label: 'Codestral', badge: 'fast', match: ['codestral'] }
  ],
  qwen: [
    { id: 'qwen3-max', label: 'Qwen3-Max', badge: 'smart', match: ['qwen3-max', 'qwen3 max', 'max'] },
    { id: 'qwen3-coder', label: 'Qwen3 Coder', badge: 'fast', match: ['qwen3-coder', 'qwen3 coder', 'coder'] },
    { id: 'qwen-turbo', label: 'Qwen Turbo', badge: 'fast', match: ['turbo'] }
  ],
  kimi: [
    { id: 'kimi-k2', label: 'Kimi K2', badge: 'smart', match: ['k2'] },
    { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', badge: 'reasoning', match: ['k2 thinking', 'thinking'] },
    { id: 'kimi-latest', label: 'Kimi Latest', badge: 'fast', match: ['latest'] }
  ]
};

/* =========================================================================
 * SELECTORS — cum deschidem meniul de model și cum citim opțiunile.
 * Fiecare listă e o cascadă: se încearcă în ordine până ce unul există.
 * ========================================================================= */

const SELECTORS: Record<string, ProviderModelSelectors> = {
  chatgpt: {
    button: [
      '[data-testid="model-switcher-dropdown"]',
      'button[aria-label*="model" i]',
      'button[aria-haspopup="menu"]:has-text("GPT")',
      'button:has-text("ChatGPT")'
    ],
    option: [
      '[role="menuitemradio"]',
      '[data-testid="model-switcher-dropdown"] [role="menuitem"]',
      '[role="menu"] [role="menuitem"]',
      '[role="option"]'
    ],
    current: ['[data-testid="model-switcher-dropdown"]']
  },
  claude: {
    button: [
      'button[data-testid="model-selector-dropdown"]',
      'button[aria-label*="model" i]',
      '[data-testid*="model-selector"] button',
      'button:has-text("Claude")'
    ],
    option: [
      '[data-testid="model-selector-dropdown"] [role="option"]',
      '[role="listbox"] [role="option"]',
      '[role="menuitemradio"]',
      '[role="option"]'
    ],
    current: ['button[data-testid="model-selector-dropdown"]']
  },
  gemini: {
    button: [
      'button[data-test-id="bard-mode-menu-button"]',
      'button[aria-label*="model" i]',
      '[class*="model-selector"] button',
      '[class*="mode-menu"] button'
    ],
    option: [
      '[data-test-id="bard-mode-option"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="menuitem"]'
    ],
    current: ['button[data-test-id="bard-mode-menu-button"]']
  },
  deepseek: {
    button: [
      'div[role="button"]:has-text("DeepThink")',
      'button:has-text("DeepThink")',
      '[class*="deepthink"]',
      '[class*="think-toggle"]'
    ],
    option: [
      '[role="menuitemradio"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[class*="model-option"]'
    ]
  },
  mistral: {
    button: [
      'button[aria-haspopup="menu"]:has-text("Mistral")',
      '[data-testid*="model"] button',
      '[class*="model-selector"]',
      'button[aria-label*="model" i]'
    ],
    option: [
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[class*="model-option"]'
    ]
  },
  qwen: {
    button: [
      '[class*="model-selector"]',
      'button:has-text("Qwen")',
      'button[aria-label*="model" i]',
      '[aria-haspopup="listbox"]'
    ],
    option: [
      '[role="option"]',
      '[class*="ant-select-item-option"]',
      '[role="menuitemradio"]',
      '[role="menuitem"]'
    ]
  },
  kimi: {
    button: [
      'button:has-text("Kimi")',
      '[class*="model-select"] button',
      '[aria-haspopup="listbox"]',
      '[class*="model"]'
    ],
    option: [
      '[role="option"]',
      '[role="menuitemradio"]',
      '[role="menuitem"]',
      '[class*="model-option"]'
    ]
  }
};

/** Cheia din globalState pentru modelul ales pe un provider web. */
export function browserModelKey(providerId: string): string {
  return 'freekit.browserModel.' + providerId;
}

/** Catalogul static de modele pentru un provider (fără browser deschis). */
export function listModels(providerId: string): ModelOption[] {
  return (MODELS[providerId] ?? []).map(({ id, label, description, badge }) => ({
    id,
    label,
    description,
    badge
  }));
}

/** Găsește spec-ul (inclusiv termenii de căutare) pentru un model ales. */
export function findModel(providerId: string, modelId: string): ModelSpec | undefined {
  const wanted = normalize(modelId);
  if (!wanted) return undefined;
  return (MODELS[providerId] ?? []).find(
    (m) => normalize(m.id) === wanted || normalize(m.label) === wanted
  );
}

/** Eticheta afișată pentru un model (fallback: id-ul brut). */
export function modelLabel(providerId: string, modelId: string): string {
  return findModel(providerId, modelId)?.label ?? modelId;
}

/* =========================================================================
 * Normalizare + potrivire de text
 * ========================================================================= */

/** lowercase, fără diacritice/punctuație, spații colapsate. */
function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Termenii după care recunoaștem modelul în textul opțiunii. */
function matchTerms(spec: ModelSpec): string[] {
  const terms = new Set<string>();
  for (const raw of [spec.label, spec.id, ...spec.match]) {
    const n = normalize(raw);
    if (n) terms.add(n);
  }
  return [...terms];
}

/**
 * Tokens care marchează o VARIANTĂ diferită, nu același model. Termenul „GPT-4o"
 * nu trebuie să prindă „GPT-4o mini", iar „o3" nu trebuie să prindă „o3-mini".
 */
const VARIANT_TOKENS = new Set([
  'mini', 'nano', 'lite', 'air', 'flash', 'pro', 'max', 'ultra', 'turbo',
  'thinking', 'reasoning', 'coder', 'codex', 'plus', 'opus', 'sonnet', 'haiku',
  'r1', 'v3', 'o1', 'o3', 'o4', 'preview'
]);

/**
 * Scorul minim acceptat: token întreg (500). Sub asta textul e doar o
 * potrivire parțială („GPT-4o mini" pentru „GPT-4o") → considerăm alt model.
 */
const MATCH_MIN = 500;

/** `true` dacă `term` apare în `text` ca token întreg (nu în interiorul unui cuvânt). */
function containsToken(text: string, term: string): boolean {
  return (' ' + text + ' ').includes(' ' + term + ' ');
}

/**
 * Cât de bine se potrivește textul unei opțiuni cu termenii modelului.
 * 0 = deloc. Exact (1000) > nume + calificator ne-variantă (700) > token
 * întreg (500) > conținut (300). Termenii mai lungi bat termenii scurți, deci
 * „GPT-4.1 mini" e ales corect, nu ca „GPT-4.1".
 */
function matchScore(optionText: string, terms: string[]): number {
  const text = normalize(optionText);
  if (!text) return 0;
  let best = 0;
  for (const term of terms) {
    if (!term) continue;
    let tier = 0;
    if (text === term) {
      tier = 1000;
    } else if (text.startsWith(term + ' ')) {
      const extra = text.slice(term.length + 1).split(' ').filter(Boolean);
      // „GPT-4o" nu trebuie confundat cu „GPT-4o mini", dar „Sonnet" prinde
      // „Sonnet 4.5" — doar tokenii de variantă rup potrivirea.
      tier = extra.some((w) => VARIANT_TOKENS.has(w)) ? 0 : 700;
    } else if (containsToken(text, term)) {
      tier = 500;
    } else if (text.includes(term)) {
      tier = 300;
    }
    if (tier) tier += Math.min(term.length, 40);
    if (tier > best) best = tier;
  }
  return best;
}

/* =========================================================================
 * Citirea stării curente + deschiderea meniului
 * ========================================================================= */

async function firstVisible(page: Page, candidates: string[]): Promise<Locator | null> {
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) === 0) continue;
      if (!(await loc.isVisible())) continue;
      return loc;
    } catch {
      /* încearcă următorul */
    }
  }
  return null;
}

async function textOf(loc: Locator): Promise<string> {
  try {
    return ((await loc.innerText()) || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Modelul afișat acum de site (best-effort). `null` dacă nu-l putem citi —
 * atunci verificarea după click se face doar pe baza click-ului reușit.
 */
export async function readCurrentModel(page: Page, providerId: string): Promise<string | null> {
  const cfg = SELECTORS[providerId];
  if (!cfg) return null;
  const loc = await firstVisible(page, [...(cfg.current ?? []), ...cfg.button]);
  if (!loc) return null;
  const text = await textOf(loc);
  return text || null;
}

/**
 * Deschide dropdown-ul de model. Întoarce `true` dacă un buton a fost apăsat.
 * Popup-urile pot anima — așteptăm scurt înainte de a citi opțiunile.
 */
async function openModelMenu(page: Page, providerId: string): Promise<boolean> {
  const cfg = SELECTORS[providerId];
  if (!cfg) return false;
  if (humanBehaviorEnabled() && Math.random() < 0.2) {
    await humanScroll(page).catch(() => undefined);
  }
  for (const sel of cfg.button) {
    const btn = page.locator(sel).first();
    try {
      if ((await btn.count()) === 0 || !(await btn.isVisible())) continue;
      await humanClickButton(page, btn, 5000);
      // popup-urile animează: așteptăm puțin până apar opțiunile
      await waitForOptions(page, providerId);
      log(providerId + ': model menu opened via ' + sel);
      return true;
    } catch {
      /* încearcă următorul */
    }
  }
  log(providerId + ': no model button found (tried ' + cfg.button.join(', ') + ')');
  return false;
}

/** Așteaptă (max ~1.5s) să apară cel puțin o opțiune vizibilă în meniu. */
async function waitForOptions(page: Page, providerId: string, timeoutMs = 1500): Promise<void> {
  const cfg = SELECTORS[providerId];
  if (!cfg) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of cfg.option) {
      try {
        for (const loc of await page.locator(sel).all()) {
          if (await loc.isVisible().catch(() => false)) return;
        }
      } catch {
        /* selector invalid / element detașat */
      }
    }
    if (Date.now() >= deadline) return;
    await sleep(150);
  }
}

/** Închide meniul deschis (Escape) — ca să nu rămână agățat peste input. */
async function closeModelMenu(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* best-effort */
  }
}

/* =========================================================================
 * API public
 * ========================================================================= */

/**
 * Modelele disponibile pentru contul curent. Deschide dropdown-ul site-ului și
 * citește opțiunile reale; dacă asta nu e posibil (site schimbat, meniu animat,
 * fără browser), întoarce catalogul static — deci lista nu e niciodată goală.
 *
 * Meniul e închis (Escape) înainte de a ieși, ca pagina să rămână curată.
 */
export async function getAvailableModels(
  page: Page,
  providerId: string
): Promise<ModelOption[]> {
  const catalog = listModels(providerId);
  const cfg = SELECTORS[providerId];
  if (!cfg) return catalog;

  let opened = false;
  try {
    opened = await openModelMenu(page, providerId);
    if (!opened) return catalog;

    const options = await readModelOptions(page, providerId);
    if (!options.length) return catalog;

    // Păstrăm ordinea catalogului pentru modelele recunoscute, apoi adăugăm
    // opțiunile necunoscute (cont nou / model nou apărut pe site).
    const found: ModelOption[] = [];
    const usedSpecs = new Set<string>();
    for (const { text } of options) {
      let best: { spec: ModelSpec; score: number } | null = null;
      for (const spec of MODELS[providerId] ?? []) {
        if (usedSpecs.has(spec.id)) continue;
        const score = matchScore(text, matchTerms(spec));
        if (score >= MATCH_MIN && (!best || score > best.score)) best = { spec, score };
      }
      if (best) {
        usedSpecs.add(best.spec.id);
        found.push({
          id: best.spec.id,
          label: best.spec.label,
          description: best.spec.description,
          badge: best.spec.badge
        });
      } else {
        const id = normalize(text).replace(/ /g, '-');
        if (id && !found.some((m) => m.id === id)) found.push({ id, label: text });
      }
    }
    if (!found.length) return catalog;
    log(
      providerId +
        ': ' +
        found.length +
        ' live model(s): ' +
        found.map((m) => m.label).join(', ')
    );
    return found;
  } catch (e: any) {
    log(providerId + ': reading models failed — ' + (e?.message ?? String(e)));
    return catalog;
  } finally {
    if (opened) await closeModelMenu(page);
    await sleep(150);
  }
}

/** Opțiunile vizibile din meniul deschis, cu locatorul lor (pentru click). */
async function readModelOptions(
  page: Page,
  providerId: string
): Promise<Array<{ text: string; locator: Locator }>> {
  const cfg = SELECTORS[providerId];
  const out: Array<{ text: string; locator: Locator }> = [];
  const seen = new Set<string>();
  for (const sel of cfg.option) {
    let locs: Locator[] = [];
    try {
      locs = await page.locator(sel).all();
    } catch {
      continue;
    }
    for (const loc of locs) {
      try {
        if (!(await loc.isVisible())) continue;
        const text = await textOf(loc);
        if (!text || text.length > 80) continue;
        const key = normalize(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ text, locator: loc });
      } catch {
        /* element detașat între timp */
      }
      if (out.length >= 40) return out;
    }
  }
  return out;
}

/**
 * Aplică modelul ales pentru providerul dat. Întoarce `true` dacă modelul e
 * acum activ (sau era deja), `false` dacă nu am putut schimba.
 *
 * Pași: deja selectat? → deschide meniul → găsește opțiunea → click → verifică.
 */
export async function applyModel(
  page: Page,
  providerId: string,
  modelId: string
): Promise<boolean> {
  const cfg = SELECTORS[providerId];
  const spec = findModel(providerId, modelId);
  if (!cfg || !spec) {
    log(providerId + ': unknown model "' + modelId + '" — skipping');
    return false;
  }
  const terms = matchTerms(spec);

  // 1. Deja selectat? (evită click inutil)
  const before = await readCurrentModel(page, providerId);
  if (before && matchScore(before, terms) > 0) {
    log(providerId + ': "' + spec.label + '" already selected');
    return true;
  }

  // 2. Deschide dropdown-ul
  if (!(await openModelMenu(page, providerId))) return false;

  // 3. Găsește opțiunea cu cel mai bun scor (termenii lungi bat termenii scurți)
  const options = await readModelOptions(page, providerId);
  let target: Locator | null = null;
  let bestScore = 0;
  for (const opt of options) {
    if (await isDisabled(opt.locator)) continue;
    const score = matchScore(opt.text, terms);
    if (score > bestScore) {
      bestScore = score;
      target = opt.locator;
    }
  }

  if (!target || bestScore < MATCH_MIN) {
    log(
      providerId +
        ': option "' +
        spec.label +
        '" not found (available: ' +
        (options.map((o) => o.text).join(' | ') || 'none') +
        ')'
    );
    await closeModelMenu(page);
    return false;
  }

  // 4. Click pe opțiune
  try {
    await humanClickButton(page, target, 5000);
    await sleep(600);
  } catch (e: any) {
    log(providerId + ': click on "' + spec.label + '" failed — ' + (e?.message ?? String(e)));
    await closeModelMenu(page);
    return false;
  }

  // 5. Verifică (dacă putem citi eticheta); altfel considerăm click-ul reușit
  const after = await readCurrentModel(page, providerId);
  if (!after) {
    log(providerId + ': applied "' + spec.label + '" (label not readable — trusting the click)');
    return true;
  }
  if (matchScore(after, terms) > 0) {
    log(providerId + ': model is now "' + spec.label + '"');
    return true;
  }

  // Unele site-uri închid meniul fără să actualizeze butonul imediat.
  await sleep(500);
  const retry = await readCurrentModel(page, providerId);
  if (retry && matchScore(retry, terms) > 0) {
    log(providerId + ': model is now "' + spec.label + '" (after settle)');
    return true;
  }
  // Butonul încă arată altceva → raportăm eșec (chatul folosește implicitul).
  log(
    providerId +
      ': clicked "' +
      spec.label +
      '" but the label still reads "' +
      (retry ?? after) +
      '"'
  );
  return false;
}

async function isDisabled(loc: Locator): Promise<boolean> {
  try {
    if (await loc.isDisabled()) return true;
  } catch {
    /* unele elemente nu au stare disabled */
  }
  try {
    return (await loc.getAttribute('aria-disabled')) === 'true';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
