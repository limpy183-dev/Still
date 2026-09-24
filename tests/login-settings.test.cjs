const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');

test('every preference save persists, but login settings change only on startup/value/path changes', async () => {
  const settings = [], writes = [];
  const context = vm.createContext({ preferences: { launchAtLogin: false }, demo: false,
    process: { argv: [], env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Still.exe' }, execPath: 'C:\\temp\\Still.exe' },
    app: { isPackaged: true, getPath: () => 'C:\\test', setLoginItemSettings: value => settings.push(value) },
    path: require('node:path'), validatePreferences: value => value,
    fs: { mkdir: async () => {}, writeFile: async (_path, value) => writes.push(value), rename: async () => {} }
  });
  vm.runInContext(source.slice(source.indexOf('let loginSettings;'), source.indexOf('function registerHandlers()')), context);
  context.reconcileLoginSettings(); assert.equal(settings.length, 1);
  for (const text of ['a', 'ab', 'abc']) await context.savePreferences({ launchAtLogin: false, todos: [{ text }] });
  assert.equal(writes.length, 3); assert.equal(settings.length, 1);
  await context.savePreferences({ launchAtLogin: true }); assert.equal(settings.length, 2);
  context.process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Moved\\Still.exe';
  await context.savePreferences({ launchAtLogin: true }); assert.equal(settings.length, 3);
  assert.equal(settings[2].path, 'C:\\Moved\\Still.exe');
});
