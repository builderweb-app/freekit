const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = 'C:/Users/Lanon/ai-bridge';
const RO_CHARS = /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/;

function scan(file) {
  const full = path.join(ROOT, file);
  const text = fs.readFileSync(full, 'utf8');
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : (file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, kind);
  const results = [];

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (RO_CHARS.test(node.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        results.push({ line: line + 1, text: node.text.slice(0, 160) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return results;
}

const files = [
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
];

let total = 0;
for (const f of files) {
  const hits = scan(f);
  total += hits.length;
  if (hits.length) {
    console.log('\n=== ' + f + ' (' + hits.length + ') ===');
    hits.forEach(h => console.log('  L' + h.line + ': ' + h.text));
  }
}
console.log('\nTOTAL: ' + total);
