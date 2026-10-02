const fs = require('fs');
const path = require('path');

const RO_CHARS = /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/;

function walk(dir, results) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'out'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, results);
    else if (/\.(ts|js|css)$/.test(e.name)) {
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (RO_CHARS.test(line)) {
          results.push({
            file: path.relative(process.cwd(), full),
            line: i + 1,
            text: line.trim().slice(0, 100)
          });
        }
      });
    }
  }
}

const results = [];
walk('src', results);
walk('media', results);

console.log('Total linii cu diacritice românești: ' + results.length);
console.log('');

// Grupare pe fișiere
const byFile = {};
results.forEach(r => {
  byFile[r.file] = byFile[r.file] || [];
  byFile[r.file].push(r);
});

Object.keys(byFile).forEach(f => {
  console.log('=== ' + f + ' (' + byFile[f].length + ' linii) ===');
  byFile[f].slice(0, 10).forEach(r => {
    console.log('  L' + r.line + ': ' + r.text);
  });
  if (byFile[f].length > 10) console.log('  ... (+' + (byFile[f].length - 10) + ' mai multe)');
  console.log('');
});