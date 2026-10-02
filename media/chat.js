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
  showChrome: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3C4.5 3 2 6 1 8c1 2 3.5 5 7 5s6-3 7-5c-1-2-3.5-5-7-5zM8 4c2.8 0 4.8 2.3 5.8 4-1 1.7-3 4-5.8 4-2.8 0-4.8-2.3-5.8-4 1-1.7 3-4 5.8-4zM8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z"/></svg>`,
  newConversation: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2 2h12v9H8l-3 3v-3H2zM3 3v7h3v1.6L7.6 10H13V3zM7.5 4h1v2h2v1h-2v2h-1V7h-2V6h2z"/></svg>`,
  conversationsList: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h2v2H2zM6 3.5h8v1H6zM2 7h2v2H2zM6 7.5h8v1H6zM2 11h2v2H2zM6 11.5h8v1H6z"/></svg>`,
  verboseMode: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 2h14v12H1zM2 3v10h12V3zM3.7 5.4l.7-.7L7.7 8l-3.3 3.3-.7-.7L6.3 8zM8.5 10h3v1h-3z"/></svg>`,
  settings: `<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M9.2 3.15A5 5 0 0 1 10.58 3.72L12.1 2.2 13.8 3.9 12.28 5.42A5 5 0 0 1 12.85 6.8H15v2.4h-2.15A5 5 0 0 1 12.28 10.58L13.8 12.1 12.1 13.8 10.58 12.28A5 5 0 0 1 9.2 12.85V15H6.8v-2.15A5 5 0 0 1 5.42 12.28L3.9 13.8 2.2 12.1 3.72 10.58A5 5 0 0 1 3.15 9.2H1V6.8h2.15A5 5 0 0 1 3.72 5.42L2.2 3.9 3.9 2.2 5.42 3.72A5 5 0 0 1 6.8 3.15V1h2.4zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z"/></svg>`
};

// starea „oprit" (dictare / citire cu voce tare) — nu are corespondent în ICONS
const ICON_STOP =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>';

const messages = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const clearBtn = document.getElementById('clear');
const providerSel = document.getElementById('provider');
const jumpBtn = document.getElementById('jump');
// v0.4.0: badge de status + butonul Show Chrome
const statusBadge = document.getElementById('status-badge');
const showChromeBtn = document.getElementById('show-chrome');
// FIX v0.1.1: două butoane separate (fișiere / foldere)
const attachFileBtn = document.getElementById('attach-file');
const attachFolderBtn = document.getElementById('attach-folder');
// v1.6.0: butonul de voice input
const micBtn = document.getElementById('mic-btn');
// v1.7.1: butonul Verbose mode
const verboseBtn = document.getElementById('verbose-toggle');
// v1.9.0: bara conversațiilor (dropdown + conversație nouă + șterge)
const convSel = document.getElementById('conversation');
const convNewBtn = document.getElementById('conv-new');
const convDelBtn = document.getElementById('conv-delete');
const attsEl = document.getElementById('attachments');
const inputArea = document.getElementById('input-area');

// v1.9.2: toate butoanele din HTML își primesc pictograma SVG din ICONS
// (sursă unică — HTML-ul nu mai conține nici emoji, nici SVG inline)
function applyStaticIcons() {
  if (verboseBtn) verboseBtn.innerHTML = ICONS.verboseMode;
  if (showChromeBtn) showChromeBtn.innerHTML = ICONS.showChrome;
  if (clearBtn) clearBtn.innerHTML = ICONS.clear;
  if (convNewBtn) convNewBtn.innerHTML = ICONS.newConversation;
  if (convDelBtn) convDelBtn.innerHTML = ICONS.clear;
  if (attachFileBtn) attachFileBtn.innerHTML = ICONS.attachFile;
  if (attachFolderBtn) attachFolderBtn.innerHTML = ICONS.attachFolder;
  if (micBtn) micBtn.innerHTML = ICONS.microphone;
  if (sendBtn) sendBtn.innerHTML = ICONS.send;
}

applyStaticIcons();

// ===== v0.2.1: Auto-approve toggle =====
const autoApproveCb = document.getElementById('auto-approve');
const autoApproveLabel = autoApproveCb?.closest('.auto-approve-toggle');

autoApproveCb?.addEventListener('change', () => {
  const enabled = autoApproveCb.checked;
  autoApproveLabel?.classList.toggle('active', enabled);
  vscode.postMessage({ type: 'set_auto_approve', enabled });
});

function setAutoApproveUi(enabled) {
  if (autoApproveCb) autoApproveCb.checked = !!enabled;
  if (autoApproveLabel) autoApproveLabel.classList.toggle('active', !!enabled);
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

verboseBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'set_verbose', enabled: !verboseOn });
});

function setVerboseUi(enabled) {
  verboseOn = enabled === true;
  if (!verboseBtn) return;
  verboseBtn.classList.toggle('active', verboseOn);
  verboseBtn.title = verboseOn
    ? 'Verbose mode ON — shows every AI step. Click to turn off.'
    : 'Verbose mode: shows every AI step in the chat (Thinking / Executing / Result / Decision)';
}

let pendingEl = null;
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

function setConversations(items, activeId) {
  if (!convSel) return;
  convSel.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— no conversations —';
    convSel.appendChild(opt);
    convSel.disabled = true;
    return;
  }
  convSel.disabled = false;
  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = convLabel(c);
    opt.title =
      (c.title || 'Conversation') +
      (typeof c.count === 'number' ? ' (' + c.count + ' messages)' : '');
    if (c.id === activeId) opt.selected = true;
    convSel.appendChild(opt);
  }
}

convSel?.addEventListener('change', () => {
  if (convSel.value) {
    vscode.postMessage({ type: 'switch_conversation', id: convSel.value });
  }
});

convNewBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'new_conversation' });
});

convDelBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'delete_conversation' });
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
  wrap.className = 'msg ' + role;
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
  sendBtn.disabled = value;
  stopBtn.hidden = !value;
  attachFileBtn.disabled = value;
  attachFolderBtn.disabled = value;
}

function setPendingText(text) {
  if (!pendingEl) return;
  pendingEl.classList.remove('md');
  pendingEl.classList.remove('streaming');
  msgBody(pendingEl).textContent = text;
}

// FAZA I: notificare discretă când un selector a fost reparat automat
function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = '🛠️ ' + text;
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

  el = document.createElement('div');
  el.className = 'vstep vstep-' + kindClass;
  el.dataset.stepId = step.id;

  const head = document.createElement('div');
  head.className = 'vstep-head';
  head.title = 'Click: collapse / expand details';

  const icon = document.createElement('span');
  icon.className = 'vstep-icon';
  icon.textContent = meta.icon;
  const label = document.createElement('span');
  label.className = 'vstep-label';
  label.textContent = meta.label;
  const title = document.createElement('span');
  title.className = 'vstep-title';
  const status = document.createElement('span');
  status.className = 'vstep-status';

  head.appendChild(icon);
  head.appendChild(label);
  head.appendChild(title);
  head.appendChild(status);
  head.onclick = () => el.classList.toggle('collapsed');
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

  if (typeof step.title === 'string' && step.title) {
    titleEl.textContent = '— ' + step.title;
    titleEl.title = step.title;
  }
  if (typeof step.text === 'string' && step.text) {
    if (step.append && body.textContent) {
      body.textContent += '\n\n' + step.text;
    } else {
      body.textContent = step.text;
    }
  }
  if (step.status) {
    el.classList.remove('status-running', 'status-done', 'status-error');
    el.classList.add('status-' + step.status);
    statusEl.textContent = VSTEP_STATUS[step.status] || '';
    if (step.status === 'running') {
      el.classList.remove('collapsed');
    } else if (step.kind === 'thinking' || step.kind === 'result') {
      // pașii lungi se pliază automat la terminare (rămân în istoricul vizual)
      el.classList.add('collapsed');
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
  if (state === 'idle') console.log('[AI Bridge] STT idle');
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
  console.log('[AI Bridge] STT stop requested');
}

// (v1.7.2: conversia MediaRecorder → WAV din pagină a fost eliminată în v1.7.3 — captarea rulează în extensie)

function updateMicButton() {
  if (!micBtn) return;
  micBtn.classList.toggle('recording', sttState === 'recording');
  micBtn.classList.toggle(
    'transcribing',
    sttState === 'starting' || sttState === 'transcribing'
  );
  micBtn.innerHTML = sttState === 'recording' ? ICON_STOP : ICONS.microphone;
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
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

function addApprovalCard(toolName, path, diff, onApprove, onReject) {
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
// Fallback pentru notificarea VS Code (poate fi ascunsă / expirată /
// nerandată): butoanele din chat decid ACELAȘI review ca notificarea —
// prima decizie câștigă, ambele căi ajung la aceeași promisiune din extensie.
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

  const hint = document.createElement('div');
  hint.className = 'approval-hint';
  hint.textContent = 'You can also decide from the VS Code notification — the decision is the same.';
  card.appendChild(hint);

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
clearBtn.addEventListener('click', () => {
  if (busy) vscode.postMessage({ type: 'stop' });
  vscode.postMessage({ type: 'clear' });
  stopSpeaking(); // v1.5.0
  if (sttState === 'recording' || sttState === 'starting') stopDictation(); // v1.6.0/v1.7.3
  messages.innerHTML = '';
  pendingEl = null;
  verboseSteps.clear(); // v1.7.1
  setBusy(false);
  stick = true;
  jumpBtn.hidden = true;
});

// ===== Provider =====
providerSel.addEventListener('change', () => {
  vscode.postMessage({ type: 'set_provider', value: providerSel.value });
});

// ===== v0.4.0: badge de status provideri (🟢🟡🔴) + Show Chrome =====
const BADGE_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴' };

function setStatusBadge(color, title) {
  if (!statusBadge) return;
  statusBadge.textContent = BADGE_EMOJI[color] || '⚪';
  if (title) statusBadge.title = title;
}

statusBadge?.addEventListener('click', () => {
  vscode.postMessage({ type: 'show_status_report' });
});

showChromeBtn?.addEventListener('click', () => {
  vscode.postMessage({ type: 'show_chrome' });
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

vscode.postMessage({ type: 'ready' });
renderAttachments();

window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'reply') {
    if (pendingEl) {
      pendingEl.classList.remove('streaming');
      renderMarkdown(pendingEl, msg.text || '(empty)');
      addCopyButton(pendingEl, msg.text || '');
      addSpeakButton(pendingEl, msg.text || ''); // v1.5.0
    }
    pendingEl = null;
    setBusy(false);
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'stopped') {
    if (pendingEl) setPendingText(msg.text || '(stopped)');
    pendingEl = null;
    setBusy(false);
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'error') {
    if (pendingEl) setPendingText('⚠️ ' + msg.text);
    pendingEl = null;
    setBusy(false);
    if (!stick) jumpBtn.hidden = false;
  } else if (msg.type === 'status') {
    if (pendingEl) setPendingText(msg.text);
    keepBottom();
  } else if (msg.type === 'notice') {
    addNotice(msg.text || '');
  } else if (msg.type === 'heal') {
    addHeal(msg.text || '');
  } else if (msg.type === 'verbose') {
    // v1.7.1: pas verbose (thinking / executing / result / decision)
    addVerboseStep(msg.step);
  } else if (msg.type === 'verbose_mode') {
    setVerboseUi(msg.enabled === true);
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
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
        input.scrollTop = input.scrollHeight;
        input.focus();
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
      const t = String(msg.text || '');
      const disp = t.length > 6000 ? '…\n' + t.slice(-6000) : t;
      renderMarkdown(pendingEl, disp);
      pendingEl.classList.add('streaming');
    }
    keepBottom();
  } else if (msg.type === 'provider_status') {
    setStatusBadge(msg.color, msg.title);
  } else if (msg.type === 'history') {
    renderHistory(msg.items);
  } else if (msg.type === 'provider') {
    providerSel.value = msg.text;
  } else if (msg.type === 'approval_request') {
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    addApprovalCard(
      msg.tool,
      msg.path,
      msg.diff,
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
    // notificarea VS Code (care poate să nu apară deloc)
    addDiffReviewCard(msg);
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