/**
 * v2.9.5 — cheile registrului de selectori nu conțin un `slot` explicit:
 * serverul le construiește ca `<domeniu>:<slug selector>` (ex.
 * `chat.deepseek.com:new-chat`). Aici transformăm cheia într-un slot DOAR când
 * sufixul e neambiguu; cheile de tip hash (`div-9a2f8e4`) rămân nemapate, ca să
 * nu aplicăm un selector în slotul greșit.
 *
 * Modulul e pur (fără `vscode`/Playwright), ca să poată fi testat izolat.
 */

/** Sloturile pe care le poate livra registrul (fără `loggedOut`). */
export type RegistrySlot = 'input' | 'response' | 'newChat' | 'stopButton';

const SLOT_NAMES: Record<string, RegistrySlot> = {
  input: 'input',
  response: 'response',
  newchat: 'newChat',
  stopbutton: 'stopButton'
};

/** Acceptă `newChat`, `new_chat`, `new-chat`, `stop-button` etc. */
export function normalizeSlotName(value: unknown): RegistrySlot | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return SLOT_NAMES[compact] ?? null;
}

const SLOT_PATTERNS: ReadonlyArray<readonly [RegistrySlot, RegExp]> = [
  ['newChat', /(?:^|[-_])(?:new[-_]?chat|temporary[-_]?chat)(?:[-_]|$)/i],
  ['stopButton', /(?:^|[-_])stop(?:[-_]|$)/i],
  [
    'response',
    /(?:^|[-_])(?:assistant[-_]?message|message[-_]?content|chat[-_]?response|model[-_]?response|markdown)(?:[-_]|$)/i
  ],
  [
    'input',
    /(?:^|[-_])(?:textarea|contenteditable|prosemirror|ql[-_]?editor|message[-_]?input)(?:[-_]|$)/i
  ]
];

/**
 * Slotul indicat de cheia registrului (`chat.deepseek.com:new-chat` →
 * `newChat`). Întoarce `null` dacă sufixul nu indică un slot sau indică mai
 * multe (ex. `assistant-message-contenteditable`) — mai bine îl ignorăm decât
 * să aplicăm un selector în slotul greșit.
 */
export function slotFromRegistryKey(key: unknown): RegistrySlot | null {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(':');
  const slug = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  if (!slug) return null;
  const slots = new Set<RegistrySlot>();
  for (const [slot, pattern] of SLOT_PATTERNS) {
    if (pattern.test(slug)) slots.add(slot);
  }
  return slots.size === 1 ? [...slots][0] : null;
}
