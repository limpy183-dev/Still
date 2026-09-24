// NSIS does not forward Electron's inspector stderr, so attach to its child via CDP.
const { chromium } = require('playwright');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');
(async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const version = require('../package.json').version;
  const launcher = spawn(path.resolve(`release/Still-${version}-Windows.exe`), ['--demo', '--test', `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    const deadline = Date.now() + 60000;
    while (!browser && Date.now() < deadline) {
      if (launcher.exitCode !== null) throw Error(`Portable launcher exited early: ${launcher.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 300)); }
    }
    assert.ok(browser, 'Portable launcher exposes its running Electron child');
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => !!window.still && document.querySelector('#alert-add').onclick);
    assert.equal((await page.evaluate(() => window.still.bootstrap())).demo, true);
    const resources = path.dirname(path.dirname(path.dirname(fileURLToPath(page.url()))));
    await fs.access(path.join(resources, 'guard/Still.Guard.exe'));
    await fs.access(path.join(resources, 'guard/policy.ps1'));
    await page.locator('[data-page="todos"]').click();
    console.log('PASS: actual portable launcher extracts and opens the app with bundled guard resources (isolated preview).');
  } finally {
    if (browser) await browser.close();
    // Close only this test launcher's direct Electron child, allowing NSIS to clean its extraction.
    if (launcher.pid && launcher.exitCode === null) {
      const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${launcher.pid}' | Where-Object Name -eq 'Still.exe' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
