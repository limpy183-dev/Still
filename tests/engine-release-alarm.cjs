// An alert that comes due while Still sits in the tray still rings, whether or not the web engine has been released: the alarm window starts
// an engine of its own. Prints how late the alarm window is after the alert's time. usage: node tests/engine-release-alarm.cjs [kept|released]
// ("kept" runs with the release turned off, as the comparison). Preview profile only; the alert reminds and blocks nothing.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const exe = process.env.STILL_EXE || path.resolve(__dirname, '..', 'target', process.env.STILL_PROFILE || 'debug', 'Still.exe');
const kept = process.argv[2] === 'kept';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const up = port => new Promise(res => http.get({ host: '127.0.0.1', port, path: '/json' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const two = n => String(n).padStart(2, '0');

(async () => {
  const port = 9200 + Math.floor(Math.random() * 90), data = fs.mkdtempSync(path.join(os.tmpdir(), 'still-alarm-'));
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, STILL_ENGINE_RELEASE_SECS: kept ? '0' : '3' };
  const child = spawn(exe, ['--demo', '--test', `--test-data=${data}`], { env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 300 && !(await up(port)); i++) await sleep(50);
    let browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page; for (let i = 0; i < 300 && !(page = browser.contexts()[0].pages().find(p => p.url().endsWith('/index.html'))); i++) await sleep(50);
    await page.waitForSelector('#selected-apps .app-row');
    // Due at the next whole minute that is at least 20 s away.
    let due = new Date(Date.now() + 20000); due.setSeconds(0, 0); if (due.getTime() - Date.now() < 20000) due = new Date(due.getTime() + 60000);
    const date = `${due.getFullYear()}-${two(due.getMonth() + 1)}-${two(due.getDate())}`, time = `${two(due.getHours())}:${two(due.getMinutes())}`;
    await page.evaluate(async ({ date, time }) => window.still.saveAlert({ title: 'Release test', note: '', date, time, repeat: 'once', lengthMode: 'duration', durationMinutes: 2, endTime: '23:59', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 0, sound: 'silent', volume: 50, enabled: true }), { date, time });
    await page.evaluate(() => window.ipc.postMessage(JSON.stringify({ name: '__test:hide', args: [] })));
    await browser.close().catch(() => {});
    console.log(`${kept ? 'engine kept' : 'engine released after 3 s'}; alert due at ${time}:00 (in ${Math.round((due.getTime() - Date.now()) / 1000)} s)`);
    await sleep(Math.max(0, due.getTime() - Date.now() - 1500));
    // Look for the alarm window from just before the alert's time.
    let rang = null, alarm = null;
    while (!rang && Date.now() < due.getTime() + 15000) {
      if (await up(port)) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          alarm = browser.contexts()[0].pages().find(p => p.url().endsWith('/alarm.html'));
          if (alarm) { await alarm.waitForSelector('#alarm-title:has-text("Release test")', { timeout: 10000 }); rang = Date.now(); }
          else await browser.close().catch(() => {});
        } catch { /* the engine is still starting */ }
      }
      if (!rang) await sleep(20);
    }
    assert.ok(rang, 'the alarm window appeared');
    console.log(`Passed: the alarm window was ready ${rang - due.getTime()} ms after the alert's time (includes about 0.1 to 0.2 s to attach the test to the page).`);
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    await sleep(800); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
