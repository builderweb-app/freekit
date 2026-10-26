import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOpenFolderPath,
  expandHome,
  findPathCandidates,
  isAbsolutePathLike,
  isPathUsableOnHost,
  pathFlavor,
  planOpenFolder
} from '../directCommands';

const TARGET = 'C:\\Users\\Lanon\\Desktop\\brandidentity.agency-src';

// Cazurile obligatorii din spec: același folder, cerut în mai multe limbi.
const OPEN_COMMANDS = [
  `deschide proiectul ${TARGET}`,
  `open project ${TARGET}`,
  `abre el proyecto ${TARGET}`,
  `ouvre le projet ${TARGET}`,
  `öffne das Projekt ${TARGET}`,
  `apri il progetto ${TARGET}`,
  `abrir o projeto ${TARGET}`,
  `открой проект ${TARGET}`,
  `打开项目 ${TARGET}`,
  `deschide "${TARGET}"`,
  TARGET
];

test('extractOpenFolderPath: verb de deschidere în 9 limbi + ghilimele + doar calea', () => {
  for (const input of OPEN_COMMANDS) {
    assert.equal(extractOpenFolderPath(input), TARGET, 'pentru: ' + input);
  }
});

test('extractOpenFolderPath: ghilimele simple și backtick', () => {
  assert.equal(extractOpenFolderPath(`open '${TARGET}'`), TARGET);
  assert.equal(extractOpenFolderPath('open `' + TARGET + '`'), TARGET);
});

test('extractOpenFolderPath: cale cu spații, între ghilimele', () => {
  assert.equal(
    extractOpenFolderPath('deschide "C:\\Program Files\\My App"'),
    'C:\\Program Files\\My App'
  );
});

test('extractOpenFolderPath: cale cu spații, fără ghilimele', () => {
  assert.equal(
    extractOpenFolderPath('deschide C:\\Program Files\\My App'),
    'C:\\Program Files\\My App'
  );
});

test('extractOpenFolderPath: UNC, Unix și home', () => {
  assert.equal(
    extractOpenFolderPath('open \\\\server\\share\\proiect'),
    '\\\\server\\share\\proiect'
  );
  assert.equal(extractOpenFolderPath('open /home/user/proiect'), '/home/user/proiect');
  assert.equal(extractOpenFolderPath('deschide ~/proiecte/foo'), '~/proiecte/foo');
});

test('extractOpenFolderPath: nu confundă întrebările cu o comandă', () => {
  assert.equal(extractOpenFolderPath('ce este un folder?'), null);
  assert.equal(extractOpenFolderPath('how do I open a folder in VS Code?'), null);
  assert.equal(extractOpenFolderPath('deschide folderul?'), null);
  assert.equal(extractOpenFolderPath(''), null);
  assert.equal(extractOpenFolderPath('Salut!'), null);
});

test('extractOpenFolderPath: calea relativă nu declanșează deschiderea', () => {
  assert.equal(extractOpenFolderPath('deschide src/index.ts'), null);
  assert.equal(extractOpenFolderPath('open project folder'), null);
  assert.equal(extractOpenFolderPath('open ./src'), null);
  assert.equal(extractOpenFolderPath('open .\\src'), null);
});

test('extractOpenFolderPath: scoate punctuația de final', () => {
  assert.equal(extractOpenFolderPath(`deschide ${TARGET}.`), TARGET);
});

test('expandHome: ~/ devine calea din home, absolutele rămân neatinse', () => {
  const home = expandHome('~/proiecte/foo');
  assert.ok(home.includes('proiecte'), home);
  assert.ok(!home.startsWith('~'), home);
  assert.equal(expandHome('C:\\x'), 'C:\\x');
});

/* ---------------------------------------------------- v2.9.3: universale --- */

test('detecție fără verb: mesajul e doar calea → se deschide direct', () => {
  const plan = planOpenFolder(TARGET);
  assert.ok(plan);
  assert.equal(plan.path, TARGET);
  assert.equal(plan.blocked, undefined);
  assert.equal(plan.explicit, true);
  assert.deepEqual(plan.candidates, [TARGET]);
});

test('detecție fără verb: cale existentă în alt context → cere confirmare', () => {
  const plan = planOpenFolder(`analizează proiectul ${TARGET}`);
  assert.ok(plan);
  assert.equal(plan.path, TARGET);
  assert.equal(plan.blocked, undefined);
  assert.equal(plan.explicit, false);
});

test('verb de deschidere în orice poziție → fără confirmare', () => {
  for (const input of [`${TARGET} deschide`, `te rog deschide ${TARGET}`, `open ${TARGET}`]) {
    const plan = planOpenFolder(input);
    assert.ok(plan, input);
    assert.equal(plan.explicit, true, input);
  }
});

test('întrebările blochează execuția automată (?, how, ce, de ce, cum, explain)', () => {
  const inputs = [
    `ce este în ${TARGET}?`,
    `how do I open ${TARGET}?`,
    `${TARGET} cum funcționează?`,
    `de ce nu merge ${TARGET}`,
    `explain the layout of ${TARGET}`,
    `what is inside ${TARGET}`
  ];
  for (const input of inputs) {
    const plan = planOpenFolder(input);
    assert.ok(plan, input);
    assert.equal(plan.blocked, 'question', input);
    assert.equal(plan.explicit, false, input);
    assert.equal(extractOpenFolderPath(input), null, input);
  }
});

test('verbele distructive blochează execuția automată', () => {
  const inputs = [
    `șterge ${TARGET}`,
    `sterge folderul ${TARGET}`,
    `delete ${TARGET} folder`,
    `remove the old copy at ${TARGET}`,
    `mută ${TARGET} pe Desktop`
  ];
  for (const input of inputs) {
    const plan = planOpenFolder(input);
    assert.ok(plan, input);
    assert.equal(plan.blocked, 'destructive', input);
    assert.equal(extractOpenFolderPath(input), null, input);
  }
});

test('cuvintele din interiorul căii nu declanșează blocarea', () => {
  // „how" / „delete" sunt nume de foldere, nu marcaje de intenție.
  const plan = planOpenFolder('deschide C:\\how\\delete-me');
  assert.ok(plan);
  assert.equal(plan.path, 'C:\\how\\delete-me');
  assert.equal(plan.blocked, undefined);
  assert.equal(plan.explicit, true);
});

test('ghilimele tipografice, Unicode, diacritice și caractere non-latine', () => {
  assert.equal(
    extractOpenFolderPath('deschide „C:\\Program Files\\My App”'),
    'C:\\Program Files\\My App'
  );
  assert.equal(
    extractOpenFolderPath('deschide C:\\Utilizatori\\Ștefan\\Proiecte\\ăâîșț'),
    'C:\\Utilizatori\\Ștefan\\Proiecte\\ăâîșț'
  );
  assert.equal(extractOpenFolderPath('打开项目 D:\\项目\\测试'), 'D:\\项目\\测试');
  assert.equal(extractOpenFolderPath('öffne ~/Dokumente/Über'), '~/Dokumente/Über');
});

test('mai multe căi în mesaj → prima cale este ținta', () => {
  const candidates = findPathCandidates('compare C:\\a with C:\\b');
  assert.deepEqual(
    candidates.map((c) => c.path),
    ['C:\\a', 'C:\\b']
  );
  const plan = planOpenFolder('compare C:\\a with C:\\b');
  assert.ok(plan);
  assert.equal(plan.path, 'C:\\a');
  assert.deepEqual(plan.candidates, ['C:\\a']);
});

test('coada de frază e tăiată: „deschide C:\\x și rulează testele"', () => {
  const plan = planOpenFolder('deschide C:\\work\\app și rulează testele');
  assert.ok(plan);
  assert.deepEqual(plan.candidates, ['C:\\work\\app și rulează testele', 'C:\\work\\app']);
  assert.equal(plan.explicit, true);
});

test('flavor-urile de cale sunt detectate după formă', () => {
  assert.equal(pathFlavor('C:\\x'), 'windows');
  assert.equal(pathFlavor('c:/x'), 'windows');
  assert.equal(pathFlavor('\\\\server\\share'), 'unc');
  assert.equal(pathFlavor('/home/user'), 'posix');
  assert.equal(pathFlavor('~/proiect'), 'home');
  assert.equal(pathFlavor('./src'), 'relative');
  assert.equal(pathFlavor('src/index.ts'), 'relative');
  assert.equal(isAbsolutePathLike('D:\\proiect'), true);
  assert.equal(isAbsolutePathLike('proiect'), false);
});

test('un path Windows nu e valid pe macOS/Linux și invers', () => {
  assert.equal(isPathUsableOnHost('windows', 'win32'), true);
  assert.equal(isPathUsableOnHost('windows', 'linux'), false);
  assert.equal(isPathUsableOnHost('windows', 'darwin'), false);
  assert.equal(isPathUsableOnHost('unc', 'darwin'), false);
  assert.equal(isPathUsableOnHost('posix', 'linux'), true);
  assert.equal(isPathUsableOnHost('posix', 'win32'), false);
  assert.equal(isPathUsableOnHost('home', 'win32'), true);
  assert.equal(isPathUsableOnHost('home', 'darwin'), true);
  assert.equal(isPathUsableOnHost('relative', 'linux'), false);
});

test('mesajele fără cale absolută nu produc plan', () => {
  assert.equal(planOpenFolder('Salut, ce faci?'), null);
  assert.equal(planOpenFolder(''), null);
  assert.equal(planOpenFolder('deschide folderul'), null);
});
