const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = 'C:/Users/Lanon/ai-bridge';
const RO_CHARS = /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/;
const RO_WORDS = /\b(?:nu|nici|niciunul|niciun|nicio|niciuna|sunt|este|fara|lipseste|lipsesc|lipsit|lipsa|eroare|eroarea|erori|esuat|esec|oprit|oprita|oprite|opreste|pornit|pornita|pornire|porneste|deschide|deschis|deschisa|inchide|inchis|inchisa|sterge|sterg|adauga|adaug|alege|ales|trimite|trimis|scrie|scris|scrise|scrisa|citeste|citire|citit|foloseste|folosit|ruleaza|verific[a-z\u0103]*|salveaz[a-z\u0103]*|salvat|salvate|incarc[a-z\u0103]*|descarc[a-z\u0103]*|instaleaz[a-z\u0103]*|daca|catre|dupa|intre|pentru|despre|pana|deja|trebuie|putut|putea|poate|fisier|fisiere|mesaj|mesaje|raspuns|raspunsuri|intrebar[a-z\u0103]*|utilizator|conversatia|conversatie|selecteaz[a-z\u0103]*|selectat|anuleaz[a-z\u0103]*|continua|incearc[a-z\u0103]*|inceput|astept[a-z\u0103]*|gasit|negasit|setar[a-z\u0103]*|setat|configurar[a-z\u0103]*|disponibil|necesar|necesita|sters|sterse|redenum[a-z\u0103]*|reincerc[a-z\u0103]*|oprire|abia|asupra|inainte|dintre|atunci|cand|chiar|doar|acest|aceste|aceasta|acesti|linii|linie|modele|necunoscut|cerute|reparat|reparare|ignorat|blocat|activ|inactiv|restaurat|extensie|navighez|dezactivat|prin|timp|nume|cale|cai|buton|butonul|butoane|pagina|pagini|rand|primul|ultimul|sfarsit|copiat|gata|nou|noua|vechi|veche|valabil|invalid|corect|gresit|liber|ocupat|intreg|intreaga|singur|singura|doar|exact|chiar|aproape|destul|prea|foarte|mult|putin|tot|toate|toata|toate)\b/i;

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

function scanFile(full) {
  const text = fs.readFileSync(full, 'utf8');
  const kind = full.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, kind);
  function visit(node) {
    const tag = isRoString(node);
    if (tag) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      const t = node.text.replace(/\s+/g, ' ').slice(0, 130);
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (TARGET.has(rel)) {
        targets.push(rel + ':' + (line + 1) + ' [' + tag + '] (' + chainOf(node) + ') ' + t);
      }
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

const report = '==== TARGET REMAINING (' + targets.length + ') ====\n' + targets.join('\n') + '\n';
fs.writeFileSync(path.join(ROOT, 'ui-context-report2.txt'), report, 'utf8');
console.log('TARGET remaining hits: ' + targets.length);
console.log('Report: ui-context-report2.txt');
