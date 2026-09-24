const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const start = Date.now();
  const application = await electron.launch({ ...(process.env.STILL_EXECUTABLE ? { executablePath: process.env.STILL_EXECUTABLE, args: ['--demo', '--test'] } : { args: ['.', '--demo', '--test'] }), env });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => document.querySelector('#alert-add').onclick);
    await application.evaluate(async ({ BrowserWindow }) => {
      while (!BrowserWindow.getAllWindows()[0].isVisible()) await new Promise(resolve => setTimeout(resolve, 20));
    });
    const coldMs = Date.now() - start;
    await window.evaluate(() => window.still.savePreferences({ apps: [{ name: 'Example', path: 'C:\\Example\\Example.exe' }], selected: ['C:\\Example\\Example.exe'] }));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const reload = Date.now();
    await window.reload();
    await window.waitForFunction(() => document.querySelector('#selected-count').textContent === '1');
    await application.evaluate(async ({ BrowserWindow }) => {
      while (!BrowserWindow.getAllWindows()[0].isVisible()) await new Promise(resolve => setTimeout(resolve, 20));
    });
    const savedAppsMs = Date.now() - reload;
    assert.equal(await window.evaluate(() => selected.has('C:\\Example\\Example.exe')), true);
    console.log(JSON.stringify({ coldMs, savedAppsMs }));
    if (!process.env.STILL_BASELINE) assert.ok(savedAppsMs < 2000, 'saved applications must not delay startup for icon discovery');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
