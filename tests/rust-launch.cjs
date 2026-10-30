// Starts the Rust app (preview mode, temporary profile) and attaches Playwright to its WebView2 over the DevTools port.
// The original Electron tests drive the page through Playwright, so they run against this launcher with one changed line.
// `evaluate` stands in for the few Electron main-process calls those tests make (window sizes, stubbed file dialogs).
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const exe = process.env.STILL_EXE || path.join(__dirname, '..', 'target', process.env.STILL_PROFILE || 'debug', 'Still.exe');

function ready(port) {
  return new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/json' }, res => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false)));
}

async function launch(extraArgs = []) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'still-test-'));
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  const child = spawn(exe, ['--demo', '--test', `--test-data=${dataDir}`, ...extraArgs], { env, stdio: 'ignore' });
  const deadline = Date.now() + 30000;
  while (!(await ready(port))) {
    if (child.exitCode !== null) throw new Error('Still exited early with code ' + child.exitCode);
    if (Date.now() > deadline) { child.kill(); throw new Error('Still did not open its window'); }
    await new Promise(r => setTimeout(r, 200));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const isApp = page => page.url().endsWith('/index.html');
  const application = {
    pid: child.pid,
    port,
    dataDir,
    context,
    async firstWindow() {
      for (let i = 0; i < 100; i++) { const page = context.pages().find(isApp); if (page) return page; await new Promise(r => setTimeout(r, 100)); }
      throw new Error('No app window');
    },
    windows: () => context.pages(),
    waitForEvent: name => context.waitForEvent(name === 'window' ? 'page' : name),
    // The native windows, asked of the app itself (it answers only in --test runs).
    async windowStates() {
      const page = context.pages().find(isApp);
      await page.evaluate(() => { window.__testResult = undefined; window.ipc.postMessage(JSON.stringify({ name: '__test:windows', args: [] })); });
      await page.waitForFunction(() => window.__testResult !== undefined);
      return page.evaluate(() => window.__testResult);
    },
    async evaluate(fn, arg) {
      const captured = {};
      const dialog = new Proxy({}, { set(_, key, value) { captured[key] = value; return true; } });
      const resize = async (w, h) => context.pages().find(isApp).evaluate(size => window.ipc.postMessage(JSON.stringify({ name: '__test:resize', args: size })), [w, h]);
      const hide = () => context.pages().find(isApp).evaluate(() => window.ipc.postMessage(JSON.stringify({ name: '__test:hide', args: [] })));
      const states = await application.windowStates();
      const windows = states.map(s => ({ webContents: { getURL: () => 'https://still.localhost' + new URL(s.url).pathname }, isAlwaysOnTop: () => s.alwaysOnTop, isFullScreen: () => s.fullscreen, isVisible: () => s.visible, setSize: resize, setContentSize: resize, getContentSize: () => [1350, 900], hide }));
      const result = await fn({ dialog, BrowserWindow: { getAllWindows: () => windows }, app: { getPath: () => dataDir } }, arg);
      if (captured.showOpenDialog) {
        const picked = await captured.showOpenDialog();
        fs.writeFileSync(path.join(dataDir, 'test-pick.txt'), (picked.filePaths || []).join('\n'));
      }
      return result;
    },
    // WebView2's processes can outlive Still.exe (and leave its process tree) while holding files in the test profile:
    // end every process whose command line names this profile, then delete it.
    async close() {
      await browser.close().catch(() => {});
      const mine = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dataDir.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      try { execFileSync('powershell.exe', ['-NoProfile', '-Command', mine], { stdio: 'ignore' }); } catch { /* none left */ }
      await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  return application;
}

// Drop-in for Playwright's _electron: the launch options are Electron-specific and ignored.
const _electron = { launch: () => launch() };

module.exports = { launch, exe, _electron };
