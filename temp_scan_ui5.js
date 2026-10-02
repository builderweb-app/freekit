const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = 'C:/Users/Lanon/ai-bridge';
const RO_FUNC = /\b(?:de|la|cu|pe|din|nu|sau|prin|sub|peste|dintre|fara|f\u0103r\u0103|nevoie|ajutor|exemplu|valoare|modificare|setare|scriere|citire|stare|lista|linia|coloana|fiecare|astfel|doar|foarte|trebuie|poate|facute|facut|pus|scos|dat|luat)\b/i;

const TARGET = new Set([
  'src/diagnostics.ts',
  'src/extension.ts',
  'src/providers/ollama.ts',
  'src/providers/base.ts',
  'src/providers/index.ts',
  'src/selectors.ts',
  'src/remoteSelectors.ts',
  'src/tools.ts',
  'src/chatView.ts',
  'media/chat.js'
]);

const hits = [];

function scanFile(full) {
  const text = fs.readFileSync(full, 'utf8');
  const kind = full.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    let t = null;
    if (ts.isStringLiteralLike(node)) t = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) t = node.text;
    if (t !== null && RO_FUNC.test(t)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      hits.push(path.relative(ROOT, full).replace(/\\/g, '/') + ':' + (line + 1) + ' ' + t.replace(/\s+/g, ' ').slice(0, 120));
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(ts|js)$/.test(e.name)) continue;
    if (/^temp_/.test(e.name)) continue;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (TARGET.has(rel)) scanFile(full);
  }
}

walk(path.join(ROOT, 'src'));
const mediaChat = path.join(ROOT, 'media', 'chat.js');
if (fs.existsSync(mediaChat)) scanFile(mediaChat);

const report = '==== FUNC-WORD HITS (' + hits.length + ') ====\n' + hits.join('\n') + '\n';
fs.writeFileSync(path.join(ROOT, 'ui-context-report4.txt'), report, 'utf8');
console.log('Func-word hits: ' + hits.length);
console.log('Report: ui-context-report4.txt');
