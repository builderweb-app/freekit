const vscode = acquireVsCodeApi();

// v1.9.2: iconițe SVG monochrome (design Claude) — moștenesc culoarea din CSS
// prin `fill="currentColor"` (alb pe temă dark, negru pe temă light)
const ICONS = {
  attachFile: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M3 1h6l4 4v10H3zM4 2v12h8V5.4L8.6 2zM7.5 7.5h1v2h2v1h-2v2h-1v-2h-2v-1h2z"/></svg>`,
  attachFolder: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 3h5l1.5 1.5H15V14H1zM2 4v9h12V5.5H7.1L5.6 4zM7.5 7h1v2h2v1h-2v2h-1v-2h-2V9h2z"/></svg>`,
  microphone: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 1a2 2 0 0 0-2 2v5a2 2 0 0 0 4 0V3a2 2 0 0 0-2-2zM4 7h1v1a3 3 0 0 0 6 0V7h1v1a4 4 0 0 1-3.5 3.96V14H10v1H6v-1h1.5v-2.04A4 4 0 0 1 4 8z"/></svg>`,
  editPrompt: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.7l3 3-8.8 8.8-4 1 1-4zM3.6 11.3l-.5 1.6 1.6-.5 7.9-7.9-1.1-1.1z"/></svg>`,
  forkConversation: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2 3a2 2 0 1 0 4 0 2 2 0 1 0-4 0zM3 3a1 1 0 1 0 2 0 1 1 0 1 0-2 0zM2 13a2 2 0 1 0 4 0 2 2 0 1 0-4 0zM3 13a1 1 0 1 0 2 0 1 1 0 1 0-2 0zM10 5a2 2 0 1 0 4 0 2 2 0 1 0-4 0zM11 5a1 1 0 1 0 2 0 1 1 0 1 0-2 0zM3.5 5h1v6h-1zM11 7h1v1a3 3 0 0 1-3 3H4.5v-1H9a2 2 0 0 0 2-2z"/></svg>`,
  restoreCheckpoint: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 5.5L4.5 2v7zM4.5 5h5a3.5 3.5 0 0 1 0 7H5v-1h4.5a2.5 2.5 0 0 0 0-5h-5z"/></svg>`,
  readAloud: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2 6h2.5L8 3v10l-3.5-3H2zM10.83 5.17a4 4 0 0 1 0 5.66l-.71-.71a3 3 0 0 0 0-4.24zM12.6 3.4a6.5 6.5 0 0 1 0 9.2l-.71-.71a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M6 5h8v10H6zM7 6v8h6V6zM2 1h8v3H9V2H3v9h3v1H2z"/></svg>`,
  send: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.8L14.7 8 1.5 14.2l1.7-5.4L9 8 3.2 7.2z"/></svg>`,
  clear: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M6 1h4v2H6zM2 3h12v1H2zM3 5h10v10H3zM4 6v8h8V6zM6 8h1v4H6zM9 8h1v4H9z"/></svg>`,
  newConversation: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2 2h12v9H8l-3 3v-3H2zM3 3v7h3v1.6L7.6 10H13V3zM7.5 4h1v2h2v1h-2v2h-1V7h-2V6h2z"/></svg>`,
  conversationsList: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h2v2H2zM6 3.5h8v1H6zM2 7h2v2H2zM6 7.5h8v1H6zM2 11h2v2H2zM6 11.5h8v1H6z"/></svg>`,
  verboseMode: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 2h14v12H1zM2 3v10h12V3zM3.7 5.4l.7-.7L7.7 8l-3.3 3.3-.7-.7L6.3 8zM8.5 10h3v1h-3z"/></svg>`,
  settings: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M9.2 3.15A5 5 0 0 1 10.58 3.72L12.1 2.2 13.8 3.9 12.28 5.42A5 5 0 0 1 12.85 6.8H15v2.4h-2.15A5 5 0 0 1 12.28 10.58L13.8 12.1 12.1 13.8 10.58 12.28A5 5 0 0 1 9.2 12.85V15H6.8v-2.15A5 5 0 0 1 5.42 12.28L3.9 13.8 2.2 12.1 3.72 10.58A5 5 0 0 1 3.15 9.2H1V6.8h2.15A5 5 0 0 1 3.72 5.42L2.2 3.9 3.9 2.2 5.42 3.72A5 5 0 0 1 6.8 3.15V1h2.4zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z"/></svg>`
};

// starea „oprit" (dictare / citire cu voce tare) — nu are corespondent în ICONS
const ICON_STOP =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>';

// v2.0.1: layout nou (mockup) — #chat + composer
const messages = document.getElementById('chat');
const input = document.getElementById('in');
const boxEl = document.querySelector('.box'); // v2.4.3: border animat cât timp AI-ul generează
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const jumpBtn = document.getElementById('jump');
// v2.0.1: acțiunile din meniul „⋯" (header)
const moreBtn = document.getElementById('moreBtn');
const clearBtn = document.getElementById('mClear');
const showChromeBtn = document.getElementById('mShowChrome');
const statusReportBtn = document.getElementById('mStatus');
const verboseBtn = document.getElementById('mVerbose');
const diagBtn = document.getElementById('mDiagnostics');
const mcpBtn = document.getElementById('mMcp');
const settingsBtn = document.getElementById('mSettings');
// v2.0.2: meniul „⋯" grupat pe secțiuni — acțiuni noi (Context / Session / Debug)
const stopDevBtn = document.getElementById('mStopDev');
const resetSelBtn = document.getElementById('mResetSelectors');
const newChatBtn = document.getElementById('mNew');
// v2.0.1: chip-ul de model (înlocuiește vechiul <select id="provider">)
const modelLabel = document.getElementById('modelLabel');
const modelDot = document.getElementById('modelDot');
const modelBrowserEl = document.getElementById('model-browser');
const modelLocalEl = document.getElementById('model-local');
// v2.0.2: hardware detectat (VRAM/RAM) afișat sub lista de modele locale
const modelHwEl = document.getElementById('model-hw');
// v2.5.11 (bug #29): avertisment vizibil pe mașinile fără GPU (CPU/RAM intens)
const modelAdviceEl = document.getElementById('model-advice');
// v2.0.2: „Install Ollama" din meniul „⋯" (vizibil doar când Ollama lipsește)
const installOllamaBtn = document.getElementById('mInstallOllama');
// v2.0.1: chip-ul de „thinking level"
const thinkLabel = document.getElementById('thinkLabel');
// FIX v0.1.1: două butoane separate (fișiere / foldere)
const attachFileBtn = document.getElementById('attach-file');
const attachFolderBtn = document.getElementById('attach-folder');
// v1.6.0: butonul de voice input
const micBtn = document.getElementById('mic-btn');
// v1.9.0: conversațiile (lista din meniul „⋯")
const convListEl = document.getElementById('conv-list');
const convNewBtn = document.getElementById('conv-new');
// v2.0.3: ștergerea a trecut din meniul „⋯" în meniul contextual (dreapta-click)
const convCtxMenu = document.getElementById('convCtxMenu');
const convCtxDelete = document.getElementById('convCtxDelete');
const attsEl = document.getElementById('attachments');
const inputArea = document.getElementById('input-area');

// v2.0.1: iconițele butoanelor statice vin direct din sprite-ul SVG din HTML
// (mockup) — nu se mai injectează SVG-uri din JS.

// ===== v0.2.1: Auto-approve toggle (v2.0.1: switch cu aria-pressed) =====
const autoBtn = document.getElementById('auto');

autoBtn?.addEventListener('click', () => {
  const enabled = autoBtn.getAttribute('aria-pressed') !== 'true';
  autoBtn.setAttribute('aria-pressed', String(enabled));
  vscode.postMessage({ type: 'set_auto_approve', enabled });
});

function setAutoApproveUi(enabled) {
  if (autoBtn) autoBtn.setAttribute('aria-pressed', String(!!enabled));
}

// Cardurile de aprobare rămase deschise devin inutile când auto-approve e activ
function resolveStaleApprovals() {
  const cards = document.querySelectorAll('.msg.approval:not(.resolved)');
  for (const card of cards) {
    card.classList.add('resolved');
    const row = card.querySelector('.approval-buttons');
    if (row) row.remove();
  }
}

// ===== v1.7.1: Verbose mode (transparență — pașii AI în chat) =====
let verboseOn = false;
const verboseSteps = new Map(); // stepId -> element

// v2.0.1: toggle-ul e acum un item din meniul „⋯" (vezi handler-ul meniului);
// starea lui se reflectă în aria-checked + sub-textul „On/Off" + punctul de pe ⋯.
function setVerboseUi(enabled) {
  verboseOn = enabled === true;
  if (!verboseBtn) return;
  verboseBtn.setAttribute('aria-checked', String(verboseOn));
  const sub = verboseBtn.querySelector('.sub');
  if (sub) sub.textContent = verboseOn ? 'On' : 'Off';
  moreBtn?.classList.toggle('has-dot', verboseOn);
  verboseBtn.title = verboseOn
    ? 'Verbose mode ON — shows every AI step. Click to turn off.'
    : 'Verbose mode: shows every AI step in the chat (Thinking / Executing / Result / Decision)';
}

let pendingEl = null;
// v2.5.12 (bug #35): cardul „guest mode" activ (ChatGPT fără cont)
let guestCardEl = null;
let busy = false;
let stick = true; // true = suntem lipiți de capătul listei

// ===== v1.9.0: conversații multiple (dropdown-ul din bara de conversații) =====
function convLabel(c) {
  const d = new Date(c.updatedAt || c.createdAt || Date.now());
  const now = new Date();
  const hm =
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const stamp = sameDay
    ? hm
    : String(d.getDate()).padStart(2, '0') +
      '.' +
      String(d.getMonth() + 1).padStart(2, '0') +
      ' ' +
      hm;
  return (c.title || 'Conversation') + ' · ' + stamp;
}

// v2.0.1: conversațiile sunt o listă radio în meniul „⋯" (nu mai există <select>).
// v2.0.3: dreapta-click pe un rând deschide meniul contextual (Delete conversation).
function setConversations(items, activeId) {
  if (!convListEl) return;
  convListEl.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'mh';
    empty.textContent = 'No conversations';
    convListEl.appendChild(empty);
    return;
  }
  for (const c of list) {
    const mi = document.createElement('button');
    mi.type = 'button';
    mi.className = 'mi';
    mi.setAttribute('role', 'menuitemradio');
    mi.setAttribute('aria-checked', String(c.id === activeId));
    mi.innerHTML = '<i class="codicon codicon-check ck"></i><span class="lbl"></span>';
    const lbl = mi.querySelector('.lbl');
    lbl.textContent = convLabel(c);
    lbl.title =
      (c.title || 'Conversation') +
      (typeof c.count === 'number' ? ' (' + c.count + ' messages)' : '') +
      ' — right-click to delete';
    mi.onclick = () => {
      closeAllMenus();
      vscode.postMessage({ type: 'switch_conversation', id: c.id });
    };
    mi.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openConvCtxMenu(e.clientX, e.clientY, c.id);
    });
    convListEl.appendChild(mi);
  }
}

convNewBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'new_conversation' });
});

// v2.0.3: meniul contextual al conversațiilor
let ctxConvId = '';

function openConvCtxMenu(x, y, convId) {
  if (!convCtxMenu) return;
  ctxConvId = convId;
  closeAllMenus(convCtxMenu);
  convCtxMenu.classList.add('open');
  const rect = convCtxMenu.getBoundingClientRect();
  convCtxMenu.style.left =
    Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
  convCtxMenu.style.top =
    Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
}

convCtxMenu?.addEventListener('contextmenu', (e) => e.preventDefault());

convCtxDelete?.addEventListener('click', () => {
  closeAllMenus();
  vscode.postMessage({ type: 'delete_conversation', id: ctxConvId || undefined });
});

// ===== Iconițe + timp (FAZA F) =====
const ICON_USER =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM2.5 14a5.5 5.5 0 0 1 11 0v.5h-11V14Z"/></svg>';
const ICON_AI =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1l1.8 4.7L14.5 7.5l-4.7 1.8L8 14l-1.8-4.7L1.5 7.5l4.7-1.8L8 1Z"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

// ===== FAZA II (A): atașamente (chip-uri) =====
const KIND_ICON = { text: '📄', image: '🖼️', folder: '📁', binary: '📦' };

let attachments = [];

function humanSize(n) {
  if (typeof n !== 'number' || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderAttachments() {
  attsEl.innerHTML = '';
  if (!attachments.length) {
    attsEl.hidden = true;
    syncSendState();
    return;
  }
  attsEl.hidden = false;
  for (const a of attachments) {
    const chip = document.createElement('div');
    chip.className = 'chip';

    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.textContent = KIND_ICON[a.kind] || '📄';
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = a.name;
    name.title = a.relPath || a.name;
    chip.appendChild(name);

    const size = document.createElement('span');
    size.className = 'chip-size';
    size.textContent = a.kind === 'folder' ? 'folder' : humanSize(a.size);
    chip.appendChild(size);

    const x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = 'Remove attachment';
    x.onclick = () => vscode.postMessage({ type: 'detach', id: a.id });
    chip.appendChild(x);

    attsEl.appendChild(chip);
  }
  syncSendState();
}

// chip-uri statice pe mesajul utilizatorului (snapshot la trimitere)
function renderChipsInto(wrap, items) {
  if (!items || !items.length) return;
  const row = document.createElement('div');
  row.className = 'msg-chips';
  for (const a of items) {
    const c = document.createElement('span');
    c.className = 'chip chip-static';
    c.textContent = (KIND_ICON[a.kind] || '📄') + ' ' + a.name;
    c.title = a.relPath || a.name;
    row.appendChild(c);
  }
  wrap.appendChild(row);
}

function timeFmt(ts) {
  const d = ts ? new Date(ts) : new Date();
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

function makeHead(role, ts) {
  const head = document.createElement('div');
  head.className = 'msg-head';

  const avatar = document.createElement('span');
  avatar.className = 'avatar ' + (role === 'user' ? 'avatar-user' : 'avatar-ai');
  avatar.innerHTML = role === 'user' ? ICON_USER : ICON_AI;
  head.appendChild(avatar);

  const name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = role === 'user' ? 'You' : 'AI';
  head.appendChild(name);

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = timeFmt(ts);
  head.appendChild(time);

  return head;
}

function msgBody(el) {
  return el.querySelector('.msg-body') || el;
}

function add(role, text, ts, atts, msgId) {
  const wrap = document.createElement('div');
  // v2.0.1: clasa din mockup pentru răspunsurile AI e `.msg.ai`
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  // v1.5.0: id-ul mesajului se leagă din prima clipă (checkpoint → butonul de restore)
  if (msgId) wrap.dataset.msgId = msgId;
  wrap.appendChild(makeHead(role, ts));

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.appendChild(body);

  if (atts && atts.length) renderChipsInto(wrap, atts);

  messages.appendChild(wrap);
  // v1.5.0: re-atașează butoanele de restore la fiecare mesaj user
  // (checkpoint-ul poate ajunge înainte sau după randarea mesajului)
  if (role === 'user') attachRestoreButtons();
  scrollAfterAppend();
  return wrap;
}

function setBusy(value) {
  busy = value;
  if (boxEl) boxEl.classList.toggle('busy', !!value);
  stopBtn.hidden = !value;
  if (attachFileBtn) attachFileBtn.disabled = value;
  if (attachFolderBtn) attachFolderBtn.disabled = value;
  syncSendState();
}

/** v2.0.1: Send e activ doar când există text sau atașamente (și nu se generează). */
function syncSendState() {
  if (!sendBtn) return;
  const hasText = !!input.value.trim();
  const hasAtts = typeof attachments !== 'undefined' && attachments.length > 0;
  sendBtn.disabled = busy || (!hasText && !hasAtts);
}

function setPendingText(text) {
  if (!pendingEl) return;
  pendingEl.classList.remove('md');
  pendingEl.classList.remove('streaming');
  const body = msgBody(pendingEl);
  body.textContent = text;
  // v2.5.12 (bug #32): „Step X of N" e iterația din bucla agentică, nu un
  // contor de încercări — tooltip la hover cât timp pasul e afișat.
  const m = /(?:^|\s)Step (\d+) of (\d+)\b/.exec(String(text || ''));
  body.title = m ? 'Agentic loop iteration ' + m[1] + ' of ' + m[2] + ' max' : '';
}

/** v2.5.12 (bug #32): scoate tooltip-ul de pas când textul e înlocuit de răspuns. */
function clearPendingTip() {
  if (pendingEl) msgBody(pendingEl).title = '';
}

// FAZA I: notificare discretă când un selector a fost reparat automat
// v2.5.11 (bug #28/#29): cu `action` devine un card cu buton
// („Pick bigger model" / „Switch to web provider" → meniul de modele).
function addNotice(text, action, actionLabel) {
  const el = document.createElement('div');
  el.className = 'notice' + (action ? ' notice-actionable' : '');
  const body = document.createElement('div');
  body.className = 'notice-text';
  body.textContent = action ? text : '🛠️ ' + text;
  el.appendChild(body);
  if (action) {
    const row = document.createElement('div');
    row.className = 'notice-actions';
    const btn = document.createElement('button');
    btn.className = 'retry-btn';
    btn.textContent = actionLabel || 'Open';
    btn.addEventListener('click', () => {
      row.remove();
      if (action === 'open_model_menu') openModelMenu();
    });
    row.appendChild(btn);
    el.appendChild(row);
  }
  messages.appendChild(el);
  scrollAfterAppend();
}

// v0.6.0: notificare de auto-reparare terminal (textul are deja emoji-ul)
function addHeal(text) {
  const el = document.createElement('div');
  el.className = 'notice heal';
  el.textContent = text;
  messages.appendChild(el);
  scrollAfterAppend();
}

// v2.0.4: cardul „login required" — Chrome e adus automat în față, iar
// butoanele permit reluarea promptului (Retry) sau re-afișarea ferestrei Chrome.
function addLoginRequiredCard(text) {
  const card = document.createElement('div');
  card.className = 'notice login-required';

  const msgEl = document.createElement('div');
  msgEl.className = 'login-required-text';
  msgEl.textContent = text || 'Login required.';

  const row = document.createElement('div');
  row.className = 'login-required-actions';

  const retry = document.createElement('button');
  retry.className = 'retry-btn';
  retry.textContent = '⟳ Retry';
  retry.onclick = () => {
    card.remove();
    pendingEl = add('assistant', '', Date.now());
    showTyping(pendingEl);
    setBusy(true);
    vscode.postMessage({ type: 'retry_last' });
  };

  const show = document.createElement('button');
  show.className = 'show-chrome-btn';
  show.textContent = '🌐 Show Browser';
  show.onclick = () => vscode.postMessage({ type: 'show_chrome' });

  row.appendChild(retry);
  row.appendChild(show);
  card.appendChild(msgEl);
  card.appendChild(row);
  messages.appendChild(card);
  scrollAfterAppend();
}

// v2.5.12 (bug #35): card „guest mode" — providerul răspunde, dar sesiunea NU
// e autentificată (ChatGPT fără cont): 3 opțiuni, fără blocare.
function removeGuestModeCard() {
  if (guestCardEl) {
    guestCardEl.remove();
    guestCardEl = null;
  }
}

function addGuestModeCard(text) {
  removeGuestModeCard();
  const card = document.createElement('div');
  card.className = 'notice guest-mode';

  const msgEl = document.createElement('div');
  msgEl.className = 'guest-mode-text';
  msgEl.textContent =
    text ||
    'You are not logged in — the provider is running in guest mode (messages are not saved to an account and limits apply).';

  const row = document.createElement('div');
  row.className = 'guest-mode-actions';

  const decide = (label, choice, cls) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.onclick = () => {
      removeGuestModeCard();
      vscode.postMessage({ type: 'guest_decision', choice });
    };
    return b;
  };

  row.appendChild(decide('🌐 Show Browser', 'show', 'show-chrome-btn'));
  row.appendChild(decide('💬 Continue as guest', 'guest', 'guest-btn'));
  row.appendChild(decide('⏹ Cancel', 'cancel', 'guest-cancel-btn'));

  card.appendChild(msgEl);
  card.appendChild(row);
  messages.appendChild(card);
  guestCardEl = card;
  scrollAfterAppend();
}

// v2.5.1 — FIX 2b: card de eroare de provider (mesaje gratuite epuizate /
// rate limit / CAPTCHA) — mesaj clar + ora de reset; butoanele (FIX 2c) vin
// în .pe-actions. Construit cu textContent (fără innerHTML), ca textul venit
// din pagina providerului să nu poată injecta HTML.
const PROVIDER_NAMES = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  mistral: 'Mistral',
  qwen: 'Qwen',
  ollama: 'Ollama'
};

function addProviderErrorCard(msg) {
  const card = document.createElement('div');
  card.className = 'provider-error-card';

  // v2.5.11 (bug #24/#25): model Ollama neinstalat → card dedicat, cu buton
  // de descărcare, în locul textului brut „Ollama error: 404 …".
  const isModelMissing = msg.kind === 'model_missing';
  const modelId = typeof msg.model === 'string' ? msg.model : '';
  const available = Array.isArray(msg.availableModels) ? msg.availableModels : [];

  const title = document.createElement('b');
  title.textContent = isModelMissing
    ? '⚠️ Ollama — model not installed'
    : '⚠️ ' +
      (PROVIDER_NAMES[msg.providerId] || msg.providerId || 'Provider') +
      ' unavailable';

  const text = document.createElement('div');
  text.className = 'pe-msg';
  text.textContent = isModelMissing
    ? (modelId ? 'Model "' + modelId + '" is not installed.' : 'The selected model is not installed.') +
      (available.length ? ' Available: ' + available.join(', ') + '.' : '')
    : msg.message || '';

  const actions = document.createElement('div');
  actions.className = 'pe-actions';

  // v2.5.1 — FIX 2c: acțiuni rapide pe cardul de eroare.
  const makeBtn = (label, action, payload) => {
    const b = document.createElement('button');
    b.className = 'pe-btn';
    b.textContent = label;
    b.addEventListener('click', () => {
      vscode.postMessage(Object.assign({ type: action }, payload || {}));
    });
    return b;
  };

  if (isModelMissing) {
    // v2.5.11 (bug #24): descarcă exact modelul care lipsește (fluxul existent)
    if (modelId) {
      actions.appendChild(
        makeBtn('📥 Download ' + modelId, 'pull_model', { modelId: modelId })
      );
    }
    actions.appendChild(makeBtn('Switch to another model', 'open_model_menu'));
  } else {
    actions.appendChild(makeBtn('Show Browser', 'show_chrome'));
    actions.appendChild(makeBtn('Retry', 'retry_message'));
    actions.appendChild(makeBtn('Switch provider', 'open_model_menu'));
  }
  if (msg.upgradeUrl) {
    const a = document.createElement('a');
    a.textContent = 'Upgrade';
    a.href = msg.upgradeUrl;
    a.target = '_blank';
    a.className = 'pe-btn pe-btn-link';
    actions.appendChild(a);
  }

  card.appendChild(title);
  card.appendChild(text);
  if (msg.resetTime) {
    const reset = document.createElement('div');
    reset.textContent = 'Try again after ';
    const when = document.createElement('b');
    when.textContent = msg.resetTime;
    reset.appendChild(when);
    reset.appendChild(document.createTextNode('.'));
    card.appendChild(reset);
  }
  card.appendChild(actions);

  messages.appendChild(card);
  scrollAfterAppend();
}

// ===== v1.7.1: pași verbose (Thinking / Executing / Result / Decision) =====
const VSTEP_KINDS = {
  thinking: { icon: '🧠', label: 'Thinking' },
  executing: { icon: '⚙️', label: 'Executing' },
  result: { icon: '📄', label: 'Result' },
  decision: { icon: '🔀', label: 'Decision' }
};
const VSTEP_STATUS = { running: '⏳', done: '✓', error: '✗' };

function ensureVerboseStepEl(step) {
  let el = verboseSteps.get(step.id);
  if (el) return el;
  const meta = VSTEP_KINDS[step.kind] || {
    icon: '🔎',
    label: String(step.kind || 'Step')
  };
  const kindClass = VSTEP_KINDS[step.kind] ? step.kind : 'other';
  // v1.10.3: cardul „Thinking" e colapsabil (<details>): deschis cât timp
  // modelul raționează, pliat automat la final, cu săgeată ▼/▶ și durată.
  const isThinking = step.kind === 'thinking';

  el = document.createElement(isThinking ? 'details' : 'div');
  el.className = 'vstep vstep-' + kindClass + (isThinking ? ' thinking-card' : '');
  el.dataset.stepId = step.id;

  const head = document.createElement(isThinking ? 'summary' : 'div');
  head.className = 'vstep-head';
  head.title = 'Click: collapse / expand details';

  const icon = document.createElement('span');
  icon.className = 'vstep-icon';
  icon.textContent = meta.icon;
  const label = document.createElement('span');
  label.className = 'vstep-label';
  label.textContent = meta.label;

  if (isThinking) {
    const arrow = document.createElement('span');
    arrow.className = 'vstep-arrow';
    const duration = document.createElement('span');
    duration.className = 'thinking-duration';
    // v2.0.1: preview cu primele caractere — vizibil doar cât timp e pliat
    const prev = document.createElement('span');
    prev.className = 'prev';
    head.appendChild(arrow);
    head.appendChild(icon);
    head.appendChild(label);
    head.appendChild(duration);
    head.appendChild(prev);
    el.open = true; // deschis cât timp stream-ează
  } else {
    const title = document.createElement('span');
    title.className = 'vstep-title';
    const status = document.createElement('span');
    status.className = 'vstep-status';
    head.appendChild(icon);
    head.appendChild(label);
    head.appendChild(title);
    head.appendChild(status);
    head.onclick = () => el.classList.toggle('collapsed');
  }
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'vstep-body';
  el.appendChild(body);

  // pașii apar ÎNAINTEA bulei de răspuns în curs (ordine cronologică)
  if (pendingEl && pendingEl.parentNode === messages) {
    messages.insertBefore(el, pendingEl);
  } else {
    messages.appendChild(el);
  }
  verboseSteps.set(step.id, el);
  scrollAfterAppend();
  return el;
}

function addVerboseStep(step) {
  if (!step || !step.id) return;
  const el = ensureVerboseStepEl(step);
  const titleEl = el.querySelector('.vstep-title');
  const statusEl = el.querySelector('.vstep-status');
  const body = el.querySelector('.vstep-body');
  const isThinking = el.classList.contains('thinking-card');

  if (titleEl && typeof step.title === 'string' && step.title) {
    titleEl.textContent = '— ' + step.title;
    titleEl.title = step.title;
  }
  if (typeof step.text === 'string' && step.text) {
    if (step.append && body.textContent) {
      body.textContent += '\n\n' + step.text;
    } else {
      body.textContent = step.text;
    }
    // v2.0.1: preview-ul cardului „Thinking" (primele ~60 de caractere)
    if (isThinking) {
      const prevEl = el.querySelector('.prev');
      if (prevEl) {
        const flat = body.textContent.replace(/\s+/g, ' ').trim();
        prevEl.textContent =
          flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
      }
    }
  }
  if (step.status) {
    el.classList.remove('status-running', 'status-done', 'status-error');
    el.classList.add('status-' + step.status);

    if (isThinking) {
      // v1.10.3: expandat cât timp raționează, pliat la final + durata totală
      if (step.status === 'running') {
        el.open = true;
        if (!el.dataset.thinkStart) el.dataset.thinkStart = String(Date.now());
      } else {
        el.open = false;
        const start = Number(el.dataset.thinkStart || 0);
        if (start) {
          el.dataset.thinkElapsed = String(
            Number(el.dataset.thinkElapsed || 0) + (Date.now() - start)
          );
          el.dataset.thinkStart = '';
        }
        const secs = (Number(el.dataset.thinkElapsed || 0) / 1000).toFixed(1);
        const durationEl = el.querySelector('.thinking-duration');
        if (durationEl) durationEl.textContent = ' (' + secs + 's)';
      }
    } else if (statusEl) {
      statusEl.textContent = VSTEP_STATUS[step.status] || '';
      if (step.status === 'running') {
        el.classList.remove('collapsed');
      } else if (step.kind === 'result') {
        // pașii lungi se pliază automat la terminare (rămân în istoricul vizual)
        el.classList.add('collapsed');
      }
    }
  }
  keepBottom();
}

// „AI scrie..." — 3 puncte animate
function showTyping(el) {
  const body = msgBody(el);
  body.innerHTML =
    '<span class="typing" aria-label="AI is typing..."><i></i><i></i><i></i></span>';
}

// Markdown -> HTML sanitizat (marked + DOMPurify, ambele vendorizate local)
function renderMarkdown(el, text) {
  const body = msgBody(el);
  let html = null;
  try {
    if (window.marked) {
      marked.use({ breaks: true, gfm: true });
      html = marked.parse(text || '');
    }
  } catch {
    html = null;
  }
  if (html == null) {
    body.textContent = text || '(empty)';
    return;
  }
  if (window.DOMPurify) {
    html = DOMPurify.sanitize(html);
  }
  el.classList.add('md');
  body.innerHTML = html;
  keepBottom();
}

// Buton Copy pe răspunsurile AI (FAZA F)
function addCopyButton(el, rawText) {
  if (el.querySelector('.copy-btn')) return;
  const head = el.querySelector('.msg-head');
  if (!head) return;

  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.title = 'Copy response';
  btn.innerHTML = ICONS.copy;
  btn.onclick = () => {
    vscode.postMessage({ type: 'copy', text: rawText });
    btn.classList.add('copied');
    btn.innerHTML = ICON_CHECK;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = ICONS.copy;
    }, 1500);
  };
  head.appendChild(btn);
}

// ===== v1.5.0: text-to-speech pentru răspunsurile AI (Web Speech API) =====
const synth = window.speechSynthesis || null;
const SPEECH_LANG = 'ro-RO';
const SPEECH_MAX_CHUNK = 220;
const rawTexts = new WeakMap(); // mesaj -> textul brut (pentru citire)

// scoate markdown-ul care sună rău citit cu voce tare (cod, linkuri, emfază)
function plainTextForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' Code omitted. ')
    .replace(/~~~[\s\S]*?~~~/g, ' Code omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~|#]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .trim();
}

// împarte în bucăți scurte (unele motoare taie răspunsurile foarte lungi)
function speechChunks(text) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > SPEECH_MAX_CHUNK) {
    let cut = -1;
    for (const sep of ['. ', '! ', '? ', '; ', ', ', ' ']) {
      const ix = rest.lastIndexOf(sep, SPEECH_MAX_CHUNK);
      if (ix > 40) {
        cut = ix + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = SPEECH_MAX_CHUNK;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function pickSpeechVoice() {
  try {
    const voices = synth.getVoices() || [];
    return (
      voices.find((v) => String(v.lang || '').toLowerCase().startsWith('ro')) ||
      null
    );
  } catch {
    return null;
  }
}

let speaking = null; // { el, btn, token }

function resetSpeakBtn(btn) {
  if (!btn) return;
  btn.classList.remove('speaking');
  btn.innerHTML = ICONS.readAloud;
  btn.title = 'Read the response aloud';
}

function stopSpeaking() {
  if (!synth) return;
  if (speaking) resetSpeakBtn(speaking.btn);
  speaking = null;
  try {
    synth.cancel();
  } catch {
    /* ignoră */
  }
}

function speakEl(el, btn) {
  if (!synth) return;
  // al doilea click pe același buton = oprește lectura
  if (speaking && speaking.el === el) {
    stopSpeaking();
    return;
  }
  stopSpeaking();

  const raw = rawTexts.has(el) ? rawTexts.get(el) : msgBody(el).innerText;
  const chunks = speechChunks(plainTextForSpeech(raw));
  if (!chunks.length) return;

  const token = {};
  speaking = { el, btn, token };
  btn.classList.add('speaking');
  btn.innerHTML = ICON_STOP;
  btn.title = 'Stop reading';

  const voice = pickSpeechVoice();
  let i = 0;
  const next = () => {
    if (!speaking || speaking.token !== token) return;
    if (i >= chunks.length) {
      stopSpeaking();
      return;
    }
    const utt = new SpeechSynthesisUtterance(chunks[i++]);
    utt.lang = SPEECH_LANG;
    if (voice) utt.voice = voice;
    utt.rate = 1.05;
    utt.onend = next;
    utt.onerror = () => {
      if (speaking && speaking.token === token) stopSpeaking();
    };
    try {
      synth.speak(utt);
    } catch {
      stopSpeaking();
    }
  };
  next();
}

function addSpeakButton(el, rawText) {
  if (!synth || el.querySelector('.speak-btn')) return;
  const head = el.querySelector('.msg-head');
  if (!head) return;
  rawTexts.set(el, rawText);
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.innerHTML = ICONS.readAloud;
  btn.title = 'Read the response aloud';
  btn.onclick = () => speakEl(el, btn);
  // înaintea butonului Copy (care are margin-left:auto) — rămân lipite la dreapta
  const copyBtn = head.querySelector('.copy-btn');
  if (copyBtn) head.insertBefore(btn, copyBtn);
  else head.appendChild(btn);
}

// ===== v1.7.3: voice input — captarea rulează în EXTENSION HOST =====
// Webview-ul NU mai înregistrează: în sandbox-ul VS Code getUserMedia /
// MediaRecorder nu au acces la microfon (NotAllowedError). Extensia
// înregistrează nativ (Windows: PowerShell + winmm, zero dependențe;
// altfel SoX) și transcrie local cu Whisper. Protocol: stt_start / stt_stop
// către host; stt_state / stt_result de la host.
let sttState = 'idle'; // idle | starting | recording | transcribing
let recStartedAt = 0;
let recTimer = null;

function fmtRecTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function sttPlaceholder() {
  if (sttState === 'starting') return 'Starting the microphone…';
  if (sttState === 'recording') {
    return (
      'Recording… (' +
      fmtRecTime(Math.floor((Date.now() - recStartedAt) / 1000)) +
      ') — click the microphone to stop'
    );
  }
  if (sttState === 'transcribing') return 'Transcribing audio (local Whisper)…';
  return 'Type a message...';
}

function applySttState(state, startedAt) {
  sttState = state;
  if (typeof startedAt === 'number' && startedAt > 0) recStartedAt = startedAt;
  if (state === 'recording') {
    if (!recTimer) {
      recTimer = setInterval(() => {
        if (sttState !== 'recording') return;
        input.placeholder = sttPlaceholder();
      }, 500);
    }
  } else if (recTimer) {
    clearInterval(recTimer);
    recTimer = null;
  }
  updateMicButton();
  input.placeholder = sttPlaceholder();
  if (state === 'idle') console.log('[Freekit] STT idle');
}

function toggleRecording() {
  if (sttState === 'idle') {
    // optimist: host-ul confirmă cu 'starting'/'recording' sau trimite eroare
    applySttState('starting');
    vscode.postMessage({ type: 'stt_start' });
  } else if (sttState === 'recording') {
    stopDictation();
  }
}

function stopDictation() {
  if (sttState !== 'recording' && sttState !== 'starting') return;
  applySttState('transcribing');
  vscode.postMessage({ type: 'stt_stop' });
  console.log('[Freekit] STT stop requested');
}

// (v1.7.2: conversia MediaRecorder → WAV din pagină a fost eliminată în v1.7.3 — captarea rulează în extensie)

function updateMicButton() {
  if (!micBtn) return;
  micBtn.classList.toggle('recording', sttState === 'recording');
  micBtn.classList.toggle(
    'transcribing',
    sttState === 'starting' || sttState === 'transcribing'
  );
  // v2.0.1: iconița vine din sprite — comutăm doar referința <use>
  const micUse = micBtn.querySelector('use');
  if (micUse) {
    micUse.setAttribute('href', sttState === 'recording' ? '#i-stop' : '#i-mic');
  }
  micBtn.title =
    sttState === 'recording'
      ? 'Stop recording'
      : sttState === 'starting'
        ? 'Starting the microphone…'
        : sttState === 'transcribing'
          ? 'Transcribing audio with local Whisper…'
          : 'Speak (capture runs in the extension + local, offline Whisper)';
}

micBtn?.addEventListener('click', toggleRecording);

// ===== v1.4.0: checkpoint-uri git — butonul de restore pe mesajele user =====
// ===== v1.9.0: + butoanele de edit prompt și fork pe fiecare mesaj user =====
const restoreCheckpoints = new Map(); // messageId -> checkpoint

function userActionsBox(wrap) {
  const head = wrap.querySelector('.msg-head');
  if (!head) return null;
  let box = head.querySelector('.msg-actions');
  if (!box) {
    box = document.createElement('span');
    box.className = 'msg-actions';
    head.appendChild(box);
  }
  return box;
}

function attachRestoreButtons() {
  const wraps = messages.querySelectorAll('.msg.user[data-msg-id]');
  for (const wrap of wraps) {
    const id = wrap.dataset.msgId;
    if (!id) continue;
    const box = userActionsBox(wrap);
    if (!box) continue;

    // v1.9.0: edit prompt — pe ORICE mesaj user (checkpoint-ul e opțional)
    if (!box.querySelector('.edit-btn')) {
      const edit = document.createElement('button');
      edit.className = 'edit-btn';
      edit.innerHTML = ICONS.editPrompt;
      edit.title =
        'Edit prompt: restore the state before it, delete what followed and resend the edited text';
      edit.onclick = () => startEditPrompt(wrap);
      box.appendChild(edit);
    }

    // v1.9.0: fork — conversație nouă pornind din acest prompt
    if (!box.querySelector('.fork-btn')) {
      const fork = document.createElement('button');
      fork.className = 'fork-btn';
      fork.innerHTML = ICONS.forkConversation;
      fork.title =
        'Fork: start a new conversation from this prompt (the current conversation stays in the list)';
      fork.onclick = () => {
        if (busy) {
          addNotice('⏳ Wait for the current response to finish before creating a fork.');
          return;
        }
        vscode.postMessage({ type: 'fork_conversation', messageId: id });
      };
      box.appendChild(fork);
    }

    // v1.4.0: restore — doar dacă mesajul are checkpoint
    if (restoreCheckpoints.has(id) && !box.querySelector('.restore-btn')) {
      const cp = restoreCheckpoints.get(id);
      const btn = document.createElement('button');
      btn.className = 'restore-btn';
      btn.innerHTML = ICONS.restoreCheckpoint;
      btn.title =
        'Restore: go back to the state before "' +
        String(cp.text || '').slice(0, 60) +
        '…" (git checkpoint ' +
        String(cp.id || '').slice(0, 7) +
        ')';
      btn.onclick = () =>
        vscode.postMessage({ type: 'restore_checkpoint', messageId: id });
      box.appendChild(btn);
    }
  }
}

function markRestored(messageId) {
  const wrap = messages.querySelector(
    '.msg.user[data-msg-id="' + messageId + '"]'
  );
  const btn = wrap && wrap.querySelector('.restore-btn');
  if (btn) {
    btn.classList.add('restored');
    btn.innerHTML = ICON_CHECK;
    btn.title = 'Checkpoint restored';
  }
}

// ===== v1.9.0: edit prompt inline =====
function closeEditPrompt(messageId) {
  const wrap = messages.querySelector(
    '.msg.user[data-msg-id="' + messageId + '"]'
  );
  if (!wrap) return;
  const area = wrap.querySelector('.edit-area');
  if (area) area.remove();
  const body = wrap.querySelector('.msg-body');
  if (body) body.hidden = false;
}

function startEditPrompt(wrap) {
  if (busy) {
    addNotice('⏳ Wait for the current response to finish before editing a prompt.');
    return;
  }
  if (wrap.querySelector('.edit-area')) return; // deja în editare
  const id = wrap.dataset.msgId;
  if (!id) return;
  const body = msgBody(wrap);
  if (!body) return;

  const area = document.createElement('div');
  area.className = 'edit-area';

  const ta = document.createElement('textarea');
  ta.className = 'edit-textarea';
  ta.value = body.textContent || '';
  ta.rows = Math.min(10, Math.max(2, Math.ceil((ta.value.length || 1) / 48)));
  area.appendChild(ta);

  const row = document.createElement('div');
  row.className = 'edit-actions';

  const save = document.createElement('button');
  save.className = 'edit-save';
  save.textContent = 'Save & resend';
  save.title =
    'Restore the state before the prompt, delete what followed and resend (Ctrl+Enter)';

  const cancel = document.createElement('button');
  cancel.className = 'edit-cancel';
  cancel.textContent = 'Cancel';
  cancel.title = 'Close without changes (Esc)';

  const finish = () => {
    save.disabled = true;
    cancel.disabled = true;
    vscode.postMessage({ type: 'edit_prompt', messageId: id, text: ta.value });
  };
  save.onclick = finish;
  cancel.onclick = () => closeEditPrompt(id);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEditPrompt(id);
    }
  });

  row.appendChild(save);
  row.appendChild(cancel);
  area.appendChild(row);
  wrap.appendChild(area);
  body.hidden = true;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  keepBottom();
}

// retrimiterea după edit (host-ul a trunchiat deja conversația și a re-randat-o)
function sendEdited(text) {
  if (busy) return;
  const t = String(text || '').trim();
  if (!t) return;
  stopSpeaking();
  if (sttState === 'recording' || sttState === 'starting') stopDictation();
  stick = true;
  const msgId =
    'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  add('user', t, undefined, undefined, msgId);
  setBusy(true);
  pendingEl = add('assistant', '', Date.now());
  showTyping(pendingEl);
  vscode.postMessage({ type: 'send', text: t, msgId });
}

// ===== Scroll inteligent (FAZA F) =====
function nearBottom() {
  return (
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60
  );
}

function scrollAfterAppend() {
  if (stick) {
    messages.scrollTop = messages.scrollHeight;
    jumpBtn.hidden = true;
  } else {
    jumpBtn.hidden = false;
  }
}

function keepBottom() {
  if (stick) messages.scrollTop = messages.scrollHeight;
}

// Randarea istoricului salvat (FAZA E)
function renderHistory(items) {
  messages.innerHTML = '';
  pendingEl = null;
  verboseSteps.clear(); // v1.7.1
  fileRows.clear(); // v2.0.1
  stick = true;
  (items || []).forEach((item) => {
    if (item && item.role === 'user') {
      // v1.5.0: id-ul intră direct în add() (leagă mesajul de checkpoint)
      add('user', item.text || '', item.ts, undefined, item.id);
    } else if (item) {
      const el = add('assistant', '', item.ts);
      renderMarkdown(el, item.text || '');
      addCopyButton(el, item.text || '');
      addSpeakButton(el, item.text || ''); // v1.5.0
    }
  });
  attachRestoreButtons();
  messages.scrollTop = messages.scrollHeight;
  jumpBtn.hidden = true;
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  syncSendState();
}

// ===== v2.5.6 (bug #10): avertisment „AI-ul a improvizat" =====
// WARNING ONLY — nu blochează nimic; utilizatorul decide dacă acceptă.
const DIVERGENCE_WARNING_TEXT =
  '⚠️ The AI wrote substantially different content than your prompt ' +
  'provided. It may have improvised. Check carefully before accepting.';

function divergenceWarning() {
  const el = document.createElement('div');
  el.className = 'divergence-warning';
  el.textContent = DIVERGENCE_WARNING_TEXT;
  return el;
}

function addApprovalCard(toolName, path, diff, divergent, onApprove, onReject) {
  const card = document.createElement('div');
  card.className = 'msg approval';

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = '🔧 ' + toolName + ' → ' + path;
  card.appendChild(title);

  const pre = document.createElement('pre');
  pre.className = 'approval-diff';
  pre.textContent = diff;
  card.appendChild(pre);

  // v2.5.6 (bug #10): conținutul diferă substantial de promptul utilizatorului
  if (divergent) card.appendChild(divergenceWarning());

  const btnRow = document.createElement('div');
  btnRow.className = 'approval-buttons';

  const approve = document.createElement('button');
  approve.textContent = '✓ Approve';
  approve.className = 'approve-btn';
  approve.onclick = () => {
    card.classList.add('resolved');
    btnRow.remove();
    onApprove();
  };

  const reject = document.createElement('button');
  reject.textContent = '✗ Reject';
  reject.className = 'reject-btn';
  reject.onclick = () => {
    card.classList.add('resolved');
    btnRow.remove();
    onReject();
  };

  btnRow.appendChild(approve);
  btnRow.appendChild(reject);
  card.appendChild(btnRow);

  messages.appendChild(card);
  messages.scrollTop = messages.scrollHeight;
  return card;
}

// ===== FIX v1.2.1: card inline de review diff (Accept/Reject în chat) =====
// v2.5.11 (bug #27): cardul din chat e SINGURA suprafață de decizie.
// Notificarea VS Code (Accept/Reject) apare doar ca fallback, când cardul nu
// poate fi livrat webview-ului — nu mai rulează în paralel cu acest card.
function findDiffReviewCard(id) {
  return messages.querySelector(
    '.msg.approval.diff-review[data-review-id="' + id + '"]'
  );
}

function setDiffReviewStatus(card, text) {
  card.classList.add('resolved');
  card.classList.remove('pending-decision');
  const row = card.querySelector('.approval-buttons');
  if (row) row.remove();
  if (!card.querySelector('.approval-status')) {
    const st = document.createElement('div');
    st.className = 'approval-status';
    st.textContent = text;
    card.appendChild(st);
  }
}

function addDiffReviewCard(payload) {
  if (!payload || !payload.id) return;
  if (findDiffReviewCard(payload.id)) return; // deja afișat (re-post după reload)
  const card = document.createElement('div');
  card.className = 'msg approval diff-review';
  card.dataset.reviewId = payload.id;

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent =
    '⚖️ Review: ' + (payload.tool || '') + ' → ' + (payload.target || '');
  card.appendChild(title);

  const pre = document.createElement('pre');
  pre.className = 'approval-diff';
  pre.textContent = payload.preview || '(no changes)';
  card.appendChild(pre);

  // v2.5.6 (bug #10): cardul-fallback (review fără rânduri inline)
  if (payload.divergent) card.appendChild(divergenceWarning());

  const btnRow = document.createElement('div');
  btnRow.className = 'approval-buttons';

  function decide(okValue) {
    const btns = btnRow.querySelectorAll('button');
    for (const b of btns) b.disabled = true;
    card.classList.add('pending-decision');
    vscode.postMessage({
      type: 'diff_review_response',
      id: payload.id,
      ok: okValue
    });
  }

  const accept = document.createElement('button');
  accept.textContent = '✓ Accept';
  accept.className = 'approve-btn';
  accept.onclick = () => decide(true);

  const reject = document.createElement('button');
  reject.textContent = '✗ Reject';
  reject.className = 'reject-btn';
  reject.onclick = () => decide(false);

  btnRow.appendChild(accept);
  btnRow.appendChild(reject);
  card.appendChild(btnRow);

  messages.appendChild(card);
  messages.scrollTop = messages.scrollHeight;
}

function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text && !attachments.length) return;

  const shown = text || 'See the attached files.';
  const attsSnapshot = attachments.slice();

  // v1.4.0: id stabil al mesajului (leagă mesajul de checkpoint-ul git);
  // v1.5.0: id-ul se pasează direct în add() (setat acolo în dataset)
  const msgId =
    'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  stopSpeaking(); // v1.5.0: un mesaj nou oprește lectura anterioară
  // v1.6.0/v1.7.3: oprește și dictarea la trimitere (captarea e în extensie)
  if (sttState === 'recording' || sttState === 'starting') stopDictation();
  stick = true; // mesajul trimis de tine te duce mereu la capătul listei
  add('user', shown, undefined, attsSnapshot, msgId);
  input.value = '';
  input.style.height = 'auto';
  input.focus();
  syncSendState();

  setBusy(true);
  pendingEl = add('assistant', '', Date.now());
  showTyping(pendingEl);

  vscode.postMessage({ type: 'send', text: shown, msgId });
}

sendBtn.addEventListener('click', send);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

input.addEventListener('input', autoResize);

// ===== Stop =====
stopBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop' });
  if (pendingEl) pendingEl.textContent = '⏹ Stopping...';
});

// ===== Clear =====
// v2.0.2: nu se mai golește la primul click — Extension Host-ul cere confirmare
// (modal) și trimite înapoi „cleared" doar dacă utilizatorul confirmă.
clearBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'confirm_clear' });
});

/** v2.0.2: golește UI-ul chatului (după confirmarea din Extension Host). */
function resetChatUi() {
  stopSpeaking(); // v1.5.0
  if (sttState === 'recording' || sttState === 'starting') stopDictation(); // v1.6.0/v1.7.3
  messages.innerHTML = '';
  pendingEl = null;
  guestCardEl = null; // v2.5.12 (bug #35)
  verboseSteps.clear(); // v1.7.1
  fileRows.clear(); // v2.0.1
  setBusy(false);
  stick = true;
  jumpBtn.hidden = true;
}

// ===== v2.0.1: punctul colorat de pe chip-ul de model =====
// (înlocuiește vechiul badge emoji 🟢🟡🔴 din toolbar)
const STATUS_DOT = {
  green: 'green',
  yellow: 'orange',
  orange: 'orange',
  red: 'red',
  blue: 'blue'
};

function setStatusBadge(color, title) {
  if (!modelDot) return;
  modelDot.className = 'dot ' + (STATUS_DOT[color] || '');
  if (title) modelDot.title = title;
}

// ===== v2.0.1: acțiunile din meniul „⋯" =====
statusReportBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'show_status_report' });
});

showChromeBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'show_chrome' });
});

diagBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'run_diagnostics' });
});

mcpBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'manage_mcp' });
});

settingsBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'open_settings' });
});

// v2.0.2: acțiunile noi din meniul „⋯" grupat pe secțiuni
stopDevBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'stop_dev_servers' });
});

// Reset repaired selectors — periculos, cere confirmare modală în host
resetSelBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'reset_selectors' });
});

// „New chat" din meniu (același flux ca butonul „+" din header)
newChatBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'new_conversation' });
});

// „Install Ollama" (vizibil doar când Ollama nu e instalat) — deschide pagina
// oficială de download în browserul extern
installOllamaBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'install_ollama' });
});

// reîmprospătează periodic starea (port CDP / Ollama se pot schimba oricând)
setInterval(() => vscode.postMessage({ type: 'status_check' }), 15000);

// ===== FAZA II (A): atașare fișiere/foldere (butoane + drag & drop) =====
// FIX v0.1.1: butoane separate — Windows afișa doar foldere când
// canSelectFiles și canSelectFolders erau true simultan.
attachFileBtn.addEventListener('click', () => {
  if (!busy) vscode.postMessage({ type: 'pick_files', kind: 'files' });
});

attachFolderBtn.addEventListener('click', () => {
  if (!busy) vscode.postMessage({ type: 'pick_files', kind: 'folders' });
});

function hasFiles(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.indexOf('Files') >= 0;
}

// Path-ul unui File din webview: webUtils (VS Code nou) -> file.path (Electron)
function filePathOf(f) {
  try {
    if (window.webUtils && typeof window.webUtils.getPathForFile === 'function') {
      const p = window.webUtils.getPathForFile(f);
      if (p) return p;
    }
  } catch { /* continuă cu fallback-ul */ }
  try {
    if (f && typeof f.path === 'string' && f.path) return f.path;
  } catch { /* continuă */ }
  return '';
}

function collectDropPaths(e) {
  const out = [];
  const dt = e.dataTransfer;
  if (!dt) return out;

  // 1) Files + webUtils/file.path (merge și pentru drag din OS)
  try {
    if (dt.files) {
      for (const f of dt.files) {
        const p = filePathOf(f);
        if (p && out.indexOf(p) < 0) out.push(p);
      }
    }
  } catch { /* continuă */ }

  // 2) fallback: uri-list (drag din explorer-ul VS Code)
  if (!out.length) {
    let raw = '';
    for (const t of ['application/vnd.code.uri-list', 'text/uri-list', 'codefiles', 'text/plain']) {
      try {
        const v = dt.getData(t);
        if (v) { raw = v; break; }
      } catch { /* continuă */ }
    }
    const lines = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) lines.push(...parsed);
      else lines.push(raw);
    } catch {
      lines.push(...String(raw).split(/\r?\n/));
    }
    for (let line of lines) {
      line = String(line).trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('file://')) {
        try {
          let p = decodeURIComponent(line.replace(/^file:\/\//, ''));
          p = p.replace(/^\/([A-Za-z]:)/, '$1');
          if (out.indexOf(p) < 0) out.push(p);
        } catch { /* continuă */ }
      } else if (/^[A-Za-z]:[\\/]/.test(line)) {
        if (out.indexOf(line) < 0) out.push(line);
      }
    }
  }
  return out;
}

let dragDepth = 0;

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  inputArea.classList.add('drag-over');
});

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', () => {
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    inputArea.classList.remove('drag-over');
  }
});

document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  inputArea.classList.remove('drag-over');
  if (busy) {
    addNotice('Wait for the current response to finish before attaching files.');
    return;
  }
  const paths = collectDropPaths(e);
  if (paths.length) {
    vscode.postMessage({ type: 'attach_paths', paths });
  } else {
    addNotice('Could not determine the path of the dropped files — use the 📎 button.');
  }
});

// Linkurile din răspunsuri se deschid în browserul extern (nu în webview)
document.addEventListener('click', (e) => {
  const link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href') || '';
  if (/^https?:/i.test(href)) {
    vscode.postMessage({ type: 'open_link', url: href });
  }
});

// ===== Scroll inteligent =====
messages.addEventListener('scroll', () => {
  stick = nearBottom();
  if (stick) jumpBtn.hidden = true;
});

jumpBtn.addEventListener('click', () => {
  stick = true;
  messages.scrollTop = messages.scrollHeight;
  jumpBtn.hidden = true;
});

// ===== v2.0.1: meniuri (⋯ / chip model / chip thinking) =====
function closeAllMenus(except) {
  for (const menu of Array.from(document.querySelectorAll('.menu.open'))) {
    if (menu === except) continue;
    menu.classList.remove('open');
    const trigger = document.querySelector('[data-menu="' + menu.id + '"]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
}

/**
 * v2.3.1: meniurile nu mai au lățime fixă, deci textul lung se trunchiază cu
 * ellipsis. Punem `title` (tooltip nativ) DOAR pe elementul chiar trunchiat și
 * NU suprascriem titlurile puse intenționat (ex. rândurile de conversație, care
 * au deja „titlu (N mesaje) — right-click to delete").
 *
 * Selectorul e intenționat îngust: `.chip` e folosit și de atașamente
 * (`#attachments .chip`) și de mesaje (`.chip-static`), care nu ne privesc.
 */
const OVF_TITLE_SELECTOR = '.menu .mi, .composer .ctx .chip';

function syncOverflowTitles(root) {
  if (!root || !root.querySelectorAll) return;

  const hosts = [];
  if (root.matches && root.matches(OVF_TITLE_SELECTOR)) hosts.push(root);
  for (const host of Array.from(root.querySelectorAll(OVF_TITLE_SELECTOR))) hosts.push(host);

  for (const host of hosts) {
    const el = host.querySelector('.lbl') || host;
    const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const clipped = !!full && el.scrollWidth > el.clientWidth + 1;

    if (clipped) {
      if (!el.title) {
        el.setAttribute('title', full);
        el.dataset.ovfTitle = '1'; // titlu pus de noi → îl putem scoate la nevoie
      }
    } else if (el.dataset.ovfTitle) {
      el.removeAttribute('title');
      delete el.dataset.ovfTitle;
    }
  }
}

// lățimea se schimbă cu sidebar-ul, iar etichetele se rescriu din mesaje →
// recalculăm titlul exact când elementul devine hoverit / focusat (vizibil)
document.addEventListener('mouseover', (e) => {
  const host = e.target.closest && e.target.closest(OVF_TITLE_SELECTOR);
  if (host) syncOverflowTitles(host);
});

document.addEventListener('focusin', (e) => {
  const host = e.target.closest && e.target.closest(OVF_TITLE_SELECTOR);
  if (host) syncOverflowTitles(host);
});

/**
 * v2.5.1 — FIX A: deschide/închide meniul unui chip cu exact aceeași logică pe
 * care o rulează click-ul pe trigger — refolosit și de „Switch provider" din
 * cardul de eroare de provider.
 */
function setMenuOpen(trigger, menu, open) {
  closeAllMenus(open ? menu : null);
  menu.classList.toggle('open', open);
  trigger.setAttribute('aria-expanded', String(open));
  // v2.3.1: abia acum meniul e vizibil, deci putem măsura ce text e trunchiat
  if (open) syncOverflowTitles(menu);
}

/** v2.5.1 — FIX A: deschide meniul chip-ului de model din composer. */
function openModelMenu() {
  const trigger = document.getElementById('modelChip');
  const menu = document.getElementById('menuModel');
  if (trigger && menu) setMenuOpen(trigger, menu, true);
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-menu]');
  if (trigger) {
    const menu = document.getElementById(trigger.dataset.menu);
    if (!menu) return;
    const open = !menu.classList.contains('open');
    setMenuOpen(trigger, menu, open);
    return; // click pe trigger nu închide meniul abia deschis
  }
  if (!e.target.closest('.menu')) closeAllMenus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllMenus();
});

// meniurile radio simple (thinking level)
for (const menu of Array.from(document.querySelectorAll('.menu[data-radio]'))) {
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.mi');
    if (!item) return;
    for (const mi of Array.from(menu.querySelectorAll('.mi'))) {
      mi.setAttribute('aria-checked', String(mi === item));
    }
    if (menu.dataset.label) {
      const target = document.querySelector(menu.dataset.label);
      if (target) target.textContent = item.dataset.label || '';
    }
    closeAllMenus();
    // v2.0.1: thinking level — UI + storage (fără efect pe motor încă)
    if (menu.id === 'menuThink' && item.dataset.value) {
      setThinkingUi(item.dataset.value);
      persistThinking(item.dataset.value);
      vscode.postMessage({
        type: 'set_thinking_level',
        value: item.dataset.value
      });
    }
  });
}

// meniul „⋯": toggle-ul de verbose are logică proprie, restul închid meniul
document.getElementById('menuMore')?.addEventListener('click', (e) => {
  const item = e.target.closest('.mi');
  if (!item) return;
  if (item.hasAttribute('data-toggle')) {
    const on = item.getAttribute('aria-checked') !== 'true';
    verboseOn = on;
    setVerboseUi(on);
    vscode.postMessage({ type: 'set_verbose', enabled: on });
    return;
  }
  closeAllMenus();
});

// ===== v2.0.1: chip-ul de model (populat dinamic din `providers_list`) =====
function setModelDot(dot) {
  if (!modelDot) return;
  modelDot.className = 'dot' + (dot ? ' ' + dot : '');
}

// v2.2.0: sub-rând de model web (indentat, sub providerul activ)
function modelSubItem(parent, m, parentName) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'mi bm';
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', String(!!m.active));
  item.innerHTML =
    '<i class="codicon codicon-check ck"></i><span class="lbl"></span>' +
    (m.badge ? '<span class="sub badge"></span>' : '');
  item.querySelector('.lbl').textContent = m.label;
  if (m.badge) item.querySelector('.sub').textContent = m.badge;
  item.addEventListener('click', () => {
    for (const mi of Array.from(document.querySelectorAll('#menuModel .mi'))) {
      mi.setAttribute('aria-checked', String(mi === item));
    }
    if (modelLabel) {
      modelLabel.textContent = m.id ? parentName + ' · ' + m.label : parentName;
    }
    setModelDot(parent.dot);
    closeAllMenus();
    vscode.postMessage({
      type: 'provider_change',
      providerId: parent.id,
      // '' = revino la modelul implicit al site-ului (șterge preferința)
      modelId: m.id !== undefined ? m.id : undefined
    });
  });
  return item;
}

function renderProviderMenu(providers, payload) {
  if (!modelBrowserEl || !modelLocalEl) return;
  const ollama = (payload && payload.ollama) || {};
  modelBrowserEl.innerHTML = '';
  modelLocalEl.innerHTML = '';
  let activeLabel = '';
  let activeDot = '';

  // v2.0.2: Ollama lipsește complet → rând de instalare; instalat dar oprit → notă
  if (ollama.state === 'missing') {
    modelLocalEl.appendChild(ollamaInstallRow());
  } else if (ollama.state === 'installed') {
    modelLocalEl.appendChild(
      ollamaNote('Installed, but the server is not running — start it with "ollama serve".')
    );
  } else if (ollama.emptyModels) {
    // v2.5.11 (bug #24): serverul rulează, dar nu are niciun model instalat
    modelLocalEl.appendChild(
      ollamaNote('No local models installed — download one below.')
    );
  }

  for (const p of providers || []) {
    const name = p.label || p.id;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mi';
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(!!p.active));
    item.innerHTML =
      '<i class="codicon codicon-check ck"></i><span class="lbl"></span>' +
      (p.sub || p.modelLabel ? '<span class="sub"></span>' : '');
    item.querySelector('.lbl').textContent = name;
    if (p.sub || p.modelLabel) {
      item.querySelector('.sub').textContent = p.modelLabel || p.sub;
    }
    item.addEventListener('click', () => {
      // v2.0.2: rândurile „download" nu selectează modelul, îl descarcă
      if (p.missing) {
        closeAllMenus();
        vscode.postMessage({ type: 'pull_model', modelId: p.modelId });
        return;
      }
      for (const mi of Array.from(document.querySelectorAll('#menuModel .mi'))) {
        mi.setAttribute('aria-checked', String(mi === item));
      }
      if (modelLabel) modelLabel.textContent = name;
      setModelDot(p.dot);
      closeAllMenus();
      // v2.2.0: rând de provider → doar providerul (modelul web rămâne al lui);
      // Ollama își trimite modelul local ca înainte.
      const payload = { type: 'provider_change', providerId: p.id };
      if (p.group === 'local' && p.modelId) payload.modelId = p.modelId;
      vscode.postMessage(payload);
    });
    (p.group === 'local' ? modelLocalEl : modelBrowserEl).appendChild(item);

    // v2.2.0: sub-rândurile de model pentru providerul web activ
    for (const m of p.models || []) {
      modelBrowserEl.appendChild(modelSubItem(p, m, name));
    }

    if (p.active) {
      activeLabel = p.modelLabel ? name + ' · ' + p.modelLabel : name;
      activeDot = p.dot || '';
    }
  }

  // v2.0.2: hardware-ul detectat, sub lista de modele locale
  // v2.1.0: + tier, toate GPU-urile, disc liber + viteza fiecărei recomandări
  if (modelHwEl) {
    const hw = payload && payload.hardware;
    if (hw && hw.summary) {
      modelHwEl.textContent = hw.summary;
      const lines = [];
      if (hw.tier) {
        lines.push('Tier ' + hw.tier + ' — ' + (hw.tierTarget || 'local models'));
      }
      const gpus = hw.gpus || [];
      for (const g of gpus) {
        const vram = g.vramGb ? ' · ' + g.vramGb + ' GB' : '';
        const bw = g.bandwidthGbps ? ' · ~' + g.bandwidthGbps + ' GB/s' : '';
        lines.push('GPU: ' + g.name + vram + (g.type ? ' · ' + g.type : '') + bw);
      }
      if (gpus.length > 1 && hw.totalVramGb) {
        lines.push('Total VRAM (discrete): ' + hw.totalVramGb + ' GB');
      }
      if (hw.unifiedMemoryGb) {
        lines.push('Unified memory for a model: ' + hw.unifiedMemoryGb + ' GB');
      }
      if (hw.freeDiskGb) {
        lines.push('Disk free: ' + hw.freeDiskGb + ' GB');
      }
      if (hw.isVM) lines.push('Running in a virtual machine');
      const recs = (payload.recommendations || []).map(
        (r) =>
          '• ' + r.id + ' (' + r.size + ', ~' + r.needGb + ' GB, ' + (r.speed || '?') +
          ', from ' + (r.minTier || '?') + ') — ' + r.why
      );
      if (recs.length) {
        lines.push('', 'Recommended for this machine (fastest first):');
        lines.push.apply(lines, recs);
      }
      modelHwEl.title = lines.join('\n') || 'No local model recommendation available.';
      modelHwEl.hidden = false;
    } else {
      modelHwEl.hidden = true;
    }
  }

  // v2.5.11 (bug #29): avertisment vizibil (nu doar în tooltip) pe mașinile
  // fără GPU — inferența locală încarcă CPU/RAM, iar providerii web sunt
  // alternativa gratuită care nu consumă resursele laptopului.
  if (modelAdviceEl) {
    const advice = (payload && payload.hardware && payload.hardware.advice) || '';
    modelAdviceEl.textContent = advice;
    modelAdviceEl.hidden = !advice;
  }

  if (activeLabel && modelLabel) modelLabel.textContent = activeLabel;
  if (activeDot) setModelDot(activeDot);
  // v2.3.1: meniul a fost re-randat → recalculăm titlurile de trunchiere
  syncOverflowTitles(document);
}

/** v2.0.2: rândul „Install Ollama" din meniul de model. */
function ollamaInstallRow() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mi plain';
  btn.setAttribute('role', 'menuitem');
  btn.innerHTML =
    '<i class="codicon codicon-cloud-download"></i><span class="lbl">Install Ollama…</span>';
  btn.addEventListener('click', () => {
    closeAllMenus();
    vscode.postMessage({ type: 'install_ollama' });
  });
  return btn;
}

/** v2.0.2: notă ne-interactivă în meniu (`.mnote`). */
function ollamaNote(text) {
  const div = document.createElement('div');
  div.className = 'mnote';
  div.textContent = text;
  return div;
}

// ===== v2.0.1: chip-ul de „thinking level" =====
let thinkingLevel = 'medium';

function persistThinking(value) {
  try {
    const st = vscode.getState() || {};
    st.thinking = value;
    vscode.setState(st);
  } catch {
    /* ignoră */
  }
}

function setThinkingUi(value) {
  const v =
    ['off', 'low', 'medium', 'high'].indexOf(value) >= 0 ? value : 'medium';
  thinkingLevel = v;
  const item = document.querySelector('#menuThink .mi[data-value="' + v + '"]');
  if (!item) return;
  for (const mi of Array.from(document.querySelectorAll('#menuThink .mi'))) {
    mi.setAttribute('aria-checked', String(mi === item));
  }
  if (thinkLabel) thinkLabel.textContent = item.dataset.label || v;
}

// ===== v2.0.1: rânduri inline de „file change" (Approve / Reject / View diff) =====
const fileRows = new Map(); // rowId -> element

function addFileChangeRow(row) {
  if (!row || !row.rowId || fileRows.has(row.rowId)) return;
  // v2.5.6 (bug #10): avertismentul stă SUB rând — wrapper ca să nu strice
  // layout-ul flex al rândului `.change`
  const wrap = document.createElement('div');
  wrap.className = 'change-wrap';
  const el = document.createElement('div');
  el.className = 'change';
  el.dataset.rowId = row.rowId;
  el.innerHTML =
    '<svg class="ic"><use href="#i-file"/></svg>' +
    '<button type="button" class="fname"></button>' +
    '<span class="stats"><span class="add"></span> <span class="del"></span></span>' +
    '<span class="acts">' +
    '<button type="button" class="btn sec" data-act="reject">Reject</button>' +
    '<button type="button" class="btn" data-act="approve">Approve</button>' +
    '</span>';

  const name = el.querySelector('.fname');
  name.textContent = row.filename;
  name.title = 'Open the native VS Code diff for ' + row.filename;
  name.onclick = () => {
    vscode.postMessage({
      type: 'file_change_action',
      rowId: row.rowId,
      action: 'view_diff'
    });
  };

  el.querySelector('.add').textContent = '+' + (row.added || 0);
  el.querySelector('.del').textContent = '\u2212' + (row.removed || 0);

  const acts = el.querySelector('.acts');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled || el.classList.contains('resolved')) return;
    el.classList.add('pending');
    for (const b of Array.from(acts.querySelectorAll('button'))) {
      b.disabled = true;
    }
    vscode.postMessage({
      type: 'file_change_action',
      rowId: row.rowId,
      action: btn.dataset.act
    });
  });

  // v2.5.6 (bug #10): avertisment „AI a improvizat" sub rândul de fișier
  wrap.appendChild(el);
  if (row.divergent) wrap.appendChild(divergenceWarning());

  messages.appendChild(wrap);
  fileRows.set(row.rowId, el);
  stick = true;
  scrollAfterAppend();
}

/** v2.0.1: o singură decizie închide toate rândurile unui review. */
function resolveFileRows(reviewId, ok) {
  for (const [rowId, el] of fileRows) {
    if (rowId.indexOf(reviewId + ':') !== 0) continue;
    if (el.classList.contains('resolved')) continue;
    el.classList.remove('pending');
    el.classList.add('resolved');
    const acts = el.querySelector('.acts');
    if (!acts) continue;
    acts.innerHTML = '';
    const state = document.createElement('span');
    state.className = 'state' + (ok ? ' ok' : ' bad');
    state.textContent = ok ? 'Applied' : 'Rejected';
    acts.appendChild(state);
  }
}

// v2.0.1: nivelul de thinking salvat în workspaceState (webview)
try {
  const st0 = vscode.getState() || {};
  if (st0.thinking) setThinkingUi(st0.thinking);
} catch {
  /* ignoră */
}

vscode.postMessage({ type: 'ready' });
renderAttachments();
syncSendState();

window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'reply') {
    try {
      removeGuestModeCard(); // v2.5.12 (bug #35): răspunsul a sosit, cardul nu mai e necesar
      if (pendingEl) {
        clearPendingTip(); // v2.5.12 (bug #32)
        pendingEl.classList.remove('streaming');
        renderMarkdown(pendingEl, msg.text || '(empty)');
        addCopyButton(pendingEl, msg.text || '');
        addSpeakButton(pendingEl, msg.text || ''); // v1.5.0
      }
    } finally {
      // v2.0.2: Stop rămâne ascuns chiar dacă randarea răspunsului eșuează
      pendingEl = null;
      setBusy(false);
      if (!stick) jumpBtn.hidden = false;
    }
  } else if (msg.type === 'stopped') {
    removeGuestModeCard(); // v2.5.12 (bug #35): Stop/anulare cu cardul deschis
    try {
      if (pendingEl) setPendingText(msg.text || '(stopped)');
    } finally {
      pendingEl = null;
      setBusy(false);
      if (!stick) jumpBtn.hidden = false;
    }
  } else if (msg.type === 'error') {
    try {
      if (pendingEl) setPendingText('⚠️ ' + msg.text);
    } finally {
      pendingEl = null;
      setBusy(false);
      if (!stick) jumpBtn.hidden = false;
    }
  } else if (msg.type === 'provider_error') {
    // v2.5.1 — FIX 2b: eroare de provider detectată (mesaje gratuite epuizate,
    // rate limit, CAPTCHA) → card cu mesaj clar în loc de timeout sec.
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    addProviderErrorCard(msg);
    setBusy(false);
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'login_required') {
    // v2.0.4: Chrome a fost adus în față pentru login → card cu buton Retry
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    addLoginRequiredCard(msg.text || '');
    setBusy(false);
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'guest_mode') {
    // v2.5.12 (bug #35): sesiune neautentificată, dar composerul funcționează
    // (ChatGPT guest mode) → card cu 3 opțiuni; trimiterea așteaptă decizia.
    addGuestModeCard(msg.text || '');
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'open_model_menu') {
    // v2.5.1 — FIX A: „Switch provider" din cardul de eroare → meniul de modele
    openModelMenu();
  } else if (msg.type === 'cleared') {
    // v2.0.2: confirmarea din host a trecut — abia acum golim UI-ul
    resetChatUi();
  } else if (msg.type === 'status') {
    if (pendingEl) setPendingText(msg.text);
    keepBottom();
  } else if (msg.type === 'notice') {
    addNotice(msg.text || '', msg.action, msg.actionLabel);
  } else if (msg.type === 'heal') {
    addHeal(msg.text || '');
  } else if (msg.type === 'verbose') {
    // v1.7.1: pas verbose (thinking / executing / result / decision)
    addVerboseStep(msg.step);
  } else if (msg.type === 'verbose_mode') {
    setVerboseUi(msg.enabled === true);
  } else if (msg.type === 'clear_verbose_steps') {
    // v2.5.0 — FIX 4: după rollback / skip-rollback, containerele verbose
    // rămân goale pe ecran — le eliminăm ca să nu lase spațiu gol în chat.
    document
      .querySelectorAll('.vstep, .verbose-step, .step-container')
      .forEach((el) => el.remove());
  } else if (msg.type === 'auto_approve') {
    setAutoApproveUi(msg.enabled === true);
    if (msg.enabled === true) resolveStaleApprovals();
  } else if (msg.type === 'stt_state') {
    // v1.7.3: starea captării audio din Extension Host
    const st = ['idle', 'starting', 'recording', 'transcribing'].includes(msg.state)
      ? msg.state
      : 'idle';
    applySttState(st, msg.startedAt);
  } else if (msg.type === 'stt_result') {
    // v1.7.2/v1.7.3: rezultatul transcrierii Whisper (local, offline)
    applySttState('idle');
    if (msg.ok) {
      const text = String(msg.text || '').trim();
      if (text) {
        const current = input.value;
        const sep = current && !current.endsWith(' ') ? ' ' : '';
        input.value = current ? current + sep + text : text;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 140) + 'px';
        input.scrollTop = input.scrollHeight;
        input.focus();
        syncSendState();
      } else {
        addNotice('🎤 No speech detected in the recording.');
      }
    } else {
      const prefix = msg.stage === 'transcribe' ? '🎤 Transcription failed: ' : '🎤 ';
      addNotice(prefix + (msg.error || 'unknown error'));
    }
  } else if (msg.type === 'attachments') {
    attachments = Array.isArray(msg.items) ? msg.items : [];
    renderAttachments();
  } else if (msg.type === 'stream') {
    if (pendingEl) {
      clearPendingTip(); // v2.5.12 (bug #32)
      const t = String(msg.text || '');
      const disp = t.length > 6000 ? '…\n' + t.slice(-6000) : t;
      renderMarkdown(pendingEl, disp);
      pendingEl.classList.add('streaming');
    }
    keepBottom();
  } else if (msg.type === 'provider_status') {
    setStatusBadge(msg.color, msg.title);
  } else if (msg.type === 'busy') {
    // v2.0.2: starea reală de generare din Extension Host — sursa de adevăr
    // pentru butonul Stop (vizibil doar cât timp rulează un răspuns).
    const on = msg.text === '1';
    if (on !== busy) setBusy(on);
    // v2.5.8.1 (bug #14): „gata" trebuie să curețe și indicatorul de typing.
    // Fluxurile normale îl curăță ele (reply/stopped/error), dar direct write
    // postează doar 'notice'/'error' → cele 3 puncte rămâneau pe ecran.
    if (!on && pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
  } else if (msg.type === 'history') {
    renderHistory(msg.items);
  } else if (msg.type === 'provider') {
    // v2.0.1: chip-ul de model e actualizat de `providers_list` (nu mai există <select>)
  } else if (msg.type === 'providers_list') {
    // v2.0.1: meniul chip-ului de model (browser + Ollama local)
    // v2.0.2: + hardware detectat, recomandări și starea instalării Ollama
    renderProviderMenu(msg.providers, msg);
    if (installOllamaBtn) installOllamaBtn.hidden = (msg.ollama || {}).state !== 'missing';
  } else if (msg.type === 'thinking_level') {
    // v2.0.1: nivelul de thinking salvat de extensie
    setThinkingUi(msg.value);
  } else if (msg.type === 'file_change_row') {
    // v2.0.1: rând inline de „file change" (paralel cu diff-ul nativ)
    addFileChangeRow(msg);
  } else if (msg.type === 'approval_request') {
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    addApprovalCard(
      msg.tool,
      msg.path,
      msg.diff,
      msg.divergent,
      () => {
        vscode.postMessage({ type: 'approval_response', id: msg.id, ok: true });
        pendingEl = add('assistant', '', Date.now());
        showTyping(pendingEl);
      },
      () => {
        vscode.postMessage({ type: 'approval_response', id: msg.id, ok: false });
        pendingEl = add('assistant', '', Date.now());
        showTyping(pendingEl);
      }
    );
    setBusy(true);
  } else if (msg.type === 'diff_review') {
    // v1.2.1: cardul de review cu butoane Accept/Reject, în paralel cu
    // v2.5.11 (bug #27): acest card e suprafața principală de decizie;
    // notificarea VS Code rămâne doar fallback (webview indisponibil).
    // v2.0.1: când review-ul are rânduri inline de „file change", acelea sunt
    // UI-ul principal (diff-ul nativ rămâne deschis) — cardul mare cu preview
    // rămâne doar ca fallback pentru review-urile fără rânduri.
    if (!msg.rows || !msg.rows.length) addDiffReviewCard(msg);
  } else if (msg.type === 'diff_review_done') {
    // decizia finală (din chat, din notificare, auto-approve sau Stop)
    const card = findDiffReviewCard(msg.id);
    if (card) {
      const labels = {
        accept:
          msg.via === 'auto' ? '✅ Accepted (auto-approve)' : '✅ Accepted',
        accept_no_ask: '✅ Accepted (don\'t ask again)',
        reject: msg.via === 'stop' ? '⏹ Cancelled (Stop)' : '❌ Rejected'
      };
      setDiffReviewStatus(card, labels[msg.decision] || '⏹ Closed');
    }
    // v2.0.1: aceeași decizie închide și rândurile inline de „file change"
    resolveFileRows(
      String(msg.id || ''),
      msg.decision === 'accept' || msg.decision === 'accept_no_ask'
    );
  } else if (msg.type === 'checkpoint') {
    // v1.4.0: checkpoint creat pentru un mesaj → afișează butonul de restore
    if (msg.messageId) {
      restoreCheckpoints.set(msg.messageId, msg);
      attachRestoreButtons();
    }
  } else if (msg.type === 'checkpoints') {
    // v1.4.0: lista persistată (după reload) → re-atașează butoanele
    restoreCheckpoints.clear();
    for (const cp of msg.items || []) {
      if (cp && cp.messageId) restoreCheckpoints.set(cp.messageId, cp);
    }
    attachRestoreButtons();
  } else if (msg.type === 'checkpoint_restored') {
    if (msg.messageId) markRestored(msg.messageId);
  } else if (msg.type === 'conversations') {
    // v1.9.0: lista de conversații (dropdown-ul de comutare)
    setConversations(msg.items, msg.activeId);
  } else if (msg.type === 'edit_resend') {
    // v1.9.0: după edit — host-ul a trunchiat + re-randat; retrimit promptul editat
    sendEdited(msg.text);
  } else if (msg.type === 'edit_cancel') {
    // v1.9.0: edit respins de host (ocupat / mesaj inexistent) — închide editorul
    closeEditPrompt(String(msg.messageId || ''));
  }

  keepBottom();
});