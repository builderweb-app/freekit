import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenFolderPath, expandHome } from '../directCommands';

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
