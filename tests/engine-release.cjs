// While Still sits in the tray its web engine (the browser processes behind the window) is released, and opening Still again starts a new one.
// Runs the app in preview mode on a temporary profile with a short hide timer, and prints the memory with the window open, in the tray and
// after reopening, and how long the reopening takes. usage: node tests/engine-release.cjs [cycles]
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const exe = process.env.STILL_EXE || path.resolve(__dirname, '..', 'target', process.env.STILL_PROFILE || 'debug', 'Still.exe');
const cycles = Number(process.argv[2]) || 2, releaseAfter = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const up = port => new Promise(res => http.get({ host: '127.0.0.1', port, path: '/json' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const memory = pid => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tree-memory.ps1'), '-RootPid', String(pid)]).toString());

(async () => {
  const port = 9300 + Math.floor(Math.random() * 90), data = fs.mkdtempSync(path.join(os.tmpdir(), 'still-release-'));
  const args = ['--demo', '--test', `--test-data=${data}`];
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, STILL_ENGINE_RELEASE_SECS: String(releaseAfter) };
  const child = spawn(exe, args, { env, stdio: 'ignore' });
  const results = [];
  const attach = async () => {
    for (let i = 0; i < 300 && !(await up(port)); i++) await sleep(50);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page; for (let i = 0; i < 300 && !(page = browser.contexts()[0].pages().find(p => p.url().endsWith('/index.html'))); i++) await sleep(50);
    await page.waitForSelector('#selected-apps .app-row');
    return { browser, page };
  };
  const report = page => page.evaluate(async () => { window.__testResult = undefined; window.ipc.postMessage(JSON.stringify({ name: '__test:windows', args: [] })); while (window.__testResult === undefined) await new Promise(r => setTimeout(r, 10)); return window.__testResult[0]; });
  const visible = async page => (await report(page))?.visible;
  try {
    let { browser, page } = await attach();
    await sleep(2500);
    const open = memory(child.pid);
    const headline = await page.locator('h1').first().innerText();
    for (let cycle = 1; cycle <= cycles; cycle++) {
      // The window comes back where the user left it: resized in the first cycle, maximized in the second.
      if (cycle === 1) { await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ name: '__test:resize', args: [1000, 700] }))); await sleep(300); }
      if (cycle === 2) { await page.evaluate(() => window.still.window('maximize')); await sleep(500); }
      const before = await report(page);
      // Close to the tray (the test hook does what the title bar's close button does), then wait for the engine to go.
      await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ name: '__test:hide', args: [] })));
      const hiddenAt = performance.now();
      await browser.close().catch(() => {});
      let released;
      for (let i = 0; i < 60; i++) { await sleep(500); released = memory(child.pid); if (released.count === 1) break; }
      const goneAfter = (performance.now() - hiddenAt) / 1000;
      assert.equal(child.exitCode, null, 'Still keeps running in the tray');
      assert.equal(released.count, 1, 'only the Still process is left once the engine is released');
      await sleep(1000);
      const inTray = memory(child.pid);

      // Opening Still again (a second launch asks the first one to show itself, as the tray menu does).
      const asked = performance.now();
      spawn(exe, args, { env, stdio: 'ignore' });
      ({ browser, page } = await attach());
      const rendered = performance.now() - asked;
      let shown; while (!(await visible(page))) { if (performance.now() - asked > 15000) throw new Error('the window never came back'); await sleep(20); }
      shown = performance.now() - asked;
      assert.equal(await page.locator('h1').first().innerText(), headline, 'the reopened page is the Focus screen again');
      const after = await report(page);
      assert.deepEqual([after.bounds, after.maximized], [before.bounds, before.maximized], 'the window comes back where it was');
      await page.waitForFunction(() => window.still.bootstrap().then(state => !!state.preferences));
      await sleep(2500);
      const reopened = memory(child.pid);
      results.push({ cycle, goneAfter, inTray, rendered, shown, reopened });
    }
    console.log(`window open:        ${open.privateMB} MB private, ${open.count} processes`);
    for (const r of results) {
      console.log(`cycle ${r.cycle}: engine gone ${r.goneAfter.toFixed(1)} s after hiding (timer ${releaseAfter} s) | in the tray ${r.inTray.privateMB} MB, ${r.inTray.count} process | reopened: page rendered after ${Math.round(r.rendered)} ms, window shown after ${Math.round(r.shown)} ms, then ${r.reopened.privateMB} MB, ${r.reopened.count} processes`);
    }
    console.log('Passed: the engine is released in the tray and comes back, with the same screen, when Still is opened again.');
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(800); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
