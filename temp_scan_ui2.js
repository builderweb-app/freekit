const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = 'C:/Users/Lanon/ai-bridge';
const RO_CHARS = /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/;
const RO_WORDS = /\b(?:nu|niciunul|niciun|niciuna|sunt|este|fara|lipseste|lipsesc|lipsit|lipsa|eroare|eroarea|esuat|esec|oprit|oprite|opreste|pornit|pornita|porneste|deschide|deschis|deschisa|inchide|inchis|inchisa|sterge|sterg|adauga|adaug|alege|trimite|trimis|scrie|scrisa|citeste|citire|foloseste|ruleaza|verific[a-z\u0103]*|salveaz[a-z\u0103]*|incarc[a-z\u0103]*|descarc[a-z\u0103]*|instaleaz[a-z\u0103]*|daca|catre|dupa|intre|pentru|despre|pana|deja|trebuie|putut|fisier|fisiere|mesaj|mesaje|raspuns|raspunsuri|intrebar[a-z\u0103]*|utilizator|conversati[a-z\u0103]*|selecteaz[a-z\u0103]*|anuleaz[a-z\u0103]*|continua|incearc[a-z\u0103]*|astept[a-z\u0103]*|gasit|negasit|setar[a-z\u0103]*|configurar[a-z\u0103]*|disponibil|necesar|necesita|salvat|salvate|sters|sterse|redenum[a-z\u0103]*|reincerc[a-z\u0103]*|pornire|oprire|abia|asupra|inainte|dintre|atunci|cand|chiar|poate|putea|doar|acest|aceste|aceasta|acesti)\b/i;

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

function isRoString(node) {
  let text = null;
  if (ts.isStringLiteralLike(node)) text = node.text;
  else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) text = node.text;
  if (text === null) return null;
  if (RO_CHARS.test(text)) return 'DIAC';
  if (RO_WORDS.test(text)) return 'WORD';
  return null;
}

function chainOf(node) {
  const parts = [];
  let cur = node.parent;
  while (cur && parts.length < 6) {
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      const e = cur.expression;
      let name = '?';
      if (ts.isIdentifier(e)) name = e.text;
      else if (ts.isPropertyAccessExpression(e)) name = e.name.text;
      parts.push((ts.isNewExpression(cur) ? 'new ' : '') + name + '()');
    } else if (ts.isPropertyAssignment(cur)) {
      let n = '?';
      if (ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name)) n = cur.name.text;
      parts.push('.' + n);
    } else if (ts.isVariableDeclaration(cur)) {
      if (ts.isIdentifier(cur.name)) parts.push('var ' + cur.name.text);
    } else if (ts.isReturnStatement(cur)) parts.push('return');
    else if (ts.isThrowStatement(cur)) parts.push('throw');
    cur = cur.parent;
  }
  return parts.join(' < ');
}

const targets = [];
const others = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    if (!/\.(ts|js)$/.test(e.name)) continue;
    if (/^temp_/.test(e.name)) continue;

    const text = fs.readFileSync(full, 'utf8');
    const kind = full.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, kind);

    function visit(node) {
      const tag = isRoString(node);
      if (tag) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        const t = node.text.replace(/\s+/g, ' ').slice(0, 120);
        const entry = path.relative(ROOT, full).replace(/\\/g, '/') + ':' + (line + 1) + ' [' + tag + '] (' + chainOf(node) + ') ' + t;
        if (TARGET.has(path.relative(ROOT, full).replace(/\\/g, '/'))) targets.push(entry);
        else others.push(entry);
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
}

walk(path.join(ROOT, 'src'));
const mediaChat = path.join(ROOT, 'media', 'chat.js');
if (fs.existsSync(mediaChat)) {
  // already handled by src walk? no — media is outside src; parse here
  const text = fs.readFileSync(mediaChat, 'utf8');
  const sf = ts.createSourceFile(mediaChat, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    const tag = isRoString(node);
    if (tag) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      const t = node.text.replace(/\s+/g, ' ').slice(0, 120);
      targets.push('media/chat.js:' + (line + 1) + ' [' + tag + '] (' + chainOf(node) + ') ' + t);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}

const report = '==== TARGET (' + targets.length + ') ====\n' + targets.join('\n') +
  '\n\n==== OTHER (' + others.length + ') ====\n' + others.join('\n') + '\n';

fs.writeFileSync(path.join(ROOT, 'ui-context-report.txt'), report, 'utf8');
console.log('TARGET hits: ' + targets.length);
console.log('OTHER hits: ' + others.length);
console.log('Report written to ui-context-report.txt');
