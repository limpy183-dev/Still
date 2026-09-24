const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedApp, validateSession, validatePreferences, newerVersion, updateUrl } = require('../app/domain.cjs');
const game = { name: 'A game', path: 'C:\\Games\\Example\\game.exe' };
test('accept a desktop executable and reject unsafe targets', () => {
  assert.equal(allowedApp(game), true);
  assert.equal(allowedApp({ name: 'Spotify', path: 'appx:SpotifyAB.SpotifyMusic_zpdnekdrzrea0' }), true);
  assert.equal(allowedApp({ name: 'System', path: 'appx:Microsoft.SecHealthUI_8wekyb3d8bbwe' }), false);
  for (const file of ['C:\\Windows\\System32\\notepad.exe', 'C:\\Tools\\powershell.exe', 'C:\\Tools\\POWERSHELL.EXE', 'C:\\Apps\\Still.exe', 'C:\\Games\\*.exe', 'relative.exe', 'C:\\Games\\game.cmd', 'C:\\Program Files\\WindowsApps\\game.exe']) assert.equal(allowedApp({ name: 'App', path: file }), false, file);
});
test('validate durations, delay, and app bounds at the IPC boundary', () => {
  const request = { durationMinutes: 50, unlockDelayMinutes: 5, intention: 'Write a chapter', apps: [game] };
  assert.deepEqual(validateSession(request), request);
  for (const minutes of [0, -1, 1441, NaN, 1.5, '25']) assert.throws(() => validateSession({ ...request, durationMinutes: minutes }));
  for (const delay of [-1, 121, NaN, 0.5]) assert.throws(() => validateSession({ ...request, unlockDelayMinutes: delay }));
  assert.doesNotThrow(() => validateSession({ ...request, unlockDelayMinutes: 0 }));
  assert.throws(() => validateSession({ ...request, apps: [] }));
  assert.throws(() => validateSession({ ...request, apps: Array(101).fill(game) }));
  assert.equal(validateSession({ ...request, intention: 'a'.repeat(200) }).intention.length, 120);
});
test('persist only bounded, known preferences and executable metadata', () => {
  const result = validatePreferences({ apps: [{ ...game, icon: 'untrusted', extra: true }, { path: 'evil', name: 'bad' }], duration: 9999, delay: -4, arbitraryCode: 'no', selected: [game.path, null], groups: [{ name: 'A'.repeat(50), paths: [game.path, false] }] });
  assert.deepEqual(result.apps, [game]);
  assert.equal(result.duration, 1440); assert.equal(result.delay, 1);
  assert.equal(result.arbitraryCode, undefined); assert.equal(result.groups[0].name.length, 40);
  assert.deepEqual(result.selected, [game.path]); assert.deepEqual(result.groups[0].paths, [game.path]);
});

test('persist bounded to-do text and known formats', () => {
  const todos = validatePreferences({ todos: [null, { text: 9 }, { text: 'x'.repeat(2001), type: 'script', done: 'yes' }, { text: 'Read', type: 'circle', done: true }] }).todos;
  assert.deepEqual(todos, [{ text: 'x'.repeat(2000), type: 'checkbox', done: false }, { text: 'Read', type: 'circle', done: true }]);
  assert.equal(validatePreferences({ todos: Array(501).fill({ text: '' }) }).todos.length, 500);
  assert.deepEqual(validatePreferences({}).todos, []);
});
test('compare release versions and only open Still release downloads', () => {
  assert.equal(newerVersion('v1.10.0', '1.9.3'), true);
  assert.equal(newerVersion('1.0.1', '1.0.0'), true);
  for (const [latest, current] of [['1.0.0', '1.0.0'], ['0.9.9', '1.0.0'], ['1.1.0-beta', '1.0.0'], ['', '1.0.0'], [undefined, '1.0.0']]) assert.equal(newerVersion(latest, current), false, String(latest));
  const asset = 'https://github.com/limpy183-dev/Still/releases/download/v1.1.0/Still-Setup-1.1.0.exe';
  assert.equal(updateUrl(asset), asset);
  for (const url of ['https://example.com/Still-Setup.exe', 'https://github.com/other/Still/releases/latest', 'file:///C:/x.exe', null]) assert.equal(updateUrl(url), 'https://github.com/limpy183-dev/Still/releases/latest');
});
