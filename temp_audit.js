const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const root = 'C:/Users/Lanon/ai-bridge';
const hits = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(ts|js|json)$/.test(e.name)) {
      const text = fs.readFileSync(full, 'utf8');
      const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(full) ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
      function visit(node) {
        if ((ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[ăâîșțĂÂÎȘȚ]/.test(node.text)) {
          hits.push(path.relative(root, full) + ': ' + JSON.stringify(node.text));
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
  }
}
walk(root);
const out = hits.length ? hits.join('\n') : 'NONE';
fs.writeFileSync('C:/Users/Lanon/ai-bridge/romanian-strings-actual.txt', out + '\n', 'utf8');
console.log(out);
