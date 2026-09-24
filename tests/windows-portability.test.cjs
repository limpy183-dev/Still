const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { sameFileUrl } = require('../app/domain.cjs');

test('Chromium and Node file-URL escaping identifies the same page without admitting other pages', () => {
  const expected = pathToFileURL(path.resolve("O'Brien & 100% [Ł李]", 'index.html')).href;
  assert.ok(sameFileUrl(expected.replaceAll("'", '%27'), expected));
  for (const url of [expected.replace('index.html', 'alarm.html'), expected + '?x=1', expected + '#x', 'https://example.com/index.html', 'invalid', 'file:///%ZZ'])
    assert.equal(sameFileUrl(url, expected), false, url);
});

test('window fits laptop/high-DPI work areas and keeps the compact layout available', () => {
  const source = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');
  for (const area of [{ width: 1920, height: 1040 }, { width: 1366, height: 728 }, { width: 800, height: 560 }, { width: 600, height: 420 }]) {
    let options;
    const context = vm.createContext({ screen: { getPrimaryDisplay: () => ({ workArea: area }) }, path, uiUrl: pathToFileURL(path.resolve('app/index.html')).href,
      __dirname: path.resolve('app'), BrowserWindow: function(value) {
        options = value;
        return { webContents: { setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {} } }, loadURL(url) { assert.equal(require('node:url').fileURLToPath(url), path.resolve('app/index.html')); }, on() {} };
      }
    });
    vm.runInContext(source.slice(source.indexOf('function makeWindow()'), source.indexOf('if (!app.requestSingleInstanceLock())')), context);
    context.makeWindow();
    assert.ok(options.width <= area.width && options.height <= area.height);
    assert.ok(options.minWidth <= Math.min(640, area.width) && options.minHeight <= area.height);
  }
});
