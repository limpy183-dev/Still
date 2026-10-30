// "Alarms after you quit": with the setting on and an alert coming up, Still keeps one Task Scheduler entry just before it;
// turning the setting off removes it. Runs in --test mode, which uses the task name "Still Alerts Test" (never the real
// "Still Alerts" task) and a temporary profile. The alert only reminds; it blocks nothing.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const exe = path.resolve(__dirname, '..', 'target', process.env.STILL_PROFILE || 'debug', 'Still.exe');
const task = 'Still Alerts Test';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const up = port => new Promise(res => http.get({ host: '127.0.0.1', port, path: '/json' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const query = () => { try { return execFileSync('schtasks', ['/Query', '/TN', task, '/XML'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; } };
const remove = () => { try { execFileSync('schtasks', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore' }); } catch { /* none */ } };
const day = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

(async () => {
  remove();
  const port = 9900 + Math.floor(Math.random() * 90), data = fs.mkdtempSync(path.join(os.tmpdir(), 'still-wake-'));
  // Not --demo: the wake task is a real-mode feature. It is a test profile, so no real data or protection is involved.
  const child = spawn(exe, ['--test', `--test-data=${data}`], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 200 && !(await up(port)); i++) await sleep(100);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page; for (let i = 0; i < 100 && !(page = browser.contexts()[0].pages().find(p => p.url().endsWith('/index.html'))); i++) await sleep(100);
    await page.waitForFunction(() => window.still && typeof window.still.savePreferences === 'function');
    const tomorrow = new Date(Date.now() + 86400000);
    await page.evaluate(async date => {
      const { preferences } = await window.still.bootstrap();
      await window.still.savePreferences({ ...preferences, alertsAfterQuit: true });
      await window.still.saveAlert({ title: 'Wake test', note: '', date, time: '09:00', repeat: 'once', lengthMode: 'duration', durationMinutes: 5, endTime: '10:00', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 0, sound: 'chime', volume: 50, enabled: true });
    }, day(tomorrow));
    let xml; for (let i = 0; i < 40 && !(xml = query()); i++) await sleep(250);
    assert.ok(xml, 'a wake task is registered while "Alarms after you quit" is on');
    assert.match(xml, new RegExp(`<StartBoundary>${day(tomorrow)}T08:59:30`), 'it fires 30 seconds before the alert');
    assert.match(xml, /--alarm-wake/); assert.match(xml, /--test/); assert.match(xml, /<StartWhenAvailable>true/);
    assert.ok(fs.existsSync(path.join(data, 'alerts-wake-task.xml')));
    await page.evaluate(async () => { const { preferences } = await window.still.bootstrap(); await window.still.savePreferences({ ...preferences, alertsAfterQuit: false }); });
    for (let i = 0; i < 40 && query(); i++) await sleep(250);
    assert.equal(query(), null, 'turning the setting off removes the task');
    await browser.close().catch(() => {});
    console.log('Passed: the wake task is created 30 seconds before the next alert and removed when the setting is turned off.');
  } finally {
    child.kill(); remove(); await sleep(500); fs.rmSync(data, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
