// Live check for "Alarms after you quit" (the original's tests/alerts-wake.cjs): registers a real Task Scheduler task
// ("Still Alerts Test"), quits Still, and waits for Windows to reopen it in the tray and ring the alert. Then quits inside the
// last 30 s before an alert (after the task's time) and checks Still reopens itself. Takes about three minutes.
// Test profile only (--test, a temporary folder); the alert reminds and blocks nothing.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const exe = process.env.STILL_EXE || path.resolve(__dirname, '..', 'target', process.env.STILL_PROFILE || 'debug', 'Still.exe');
const task = 'Still Alerts Test';
const query = () => { try { return execFileSync('schtasks.exe', ['/Query', '/TN', task, '/XML'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const until = async (check, ms, what) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500))) { const value = await check(); if (value) return value; } throw Error('Timed out waiting for ' + what); };
const up = port => new Promise(res => http.get({ host: '127.0.0.1', port, path: '/json' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const pad = n => String(n).padStart(2, '0');
async function run(late) {
  const port = 9600 + Math.floor(Math.random() * 90), data = await fs.mkdtemp(path.join(os.tmpdir(), 'still-wake-'));
  const child = spawn(exe, ['--test', `--test-data=${data}`], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: 'ignore' });
  await until(() => up(port), 30000, 'Still to open');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const window = await until(() => browser.contexts()[0].pages().find(p => p.url().endsWith('/index.html')), 10000, 'the window');
  await window.waitForFunction(() => typeof prefs !== 'undefined' && document.querySelector('#alerts-after-quit').onchange);
  if (late) await until(() => { const left = 60000 - Date.now() % 60000; return left > 12000 && left < 25000; }, 60000, 'the last 25 s of a minute');
  // Ring at the first whole minute at least 75 s away, so the task (30 s early) fires after Still quits,
  // or (late) at the next minute, already inside the task's 30 s lead.
  const start = new Date(Math.ceil((Date.now() + (late ? 1000 : 75000)) / 60000) * 60000);
  const alert = { title: 'Wake test', note: '', date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, time: `${pad(start.getHours())}:${pad(start.getMinutes())}`, repeat: 'once', lengthMode: 'duration', durationMinutes: 5, endTime: '00:00', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 0, sound: 'chime', volume: 20, enabled: true };
  await window.evaluate(value => window.still.saveAlert(value), alert);
  const toggle = on => window.evaluate(on => { const box = document.querySelector('#alerts-after-quit'); box.checked = on; box.onchange(); }, on);
  try {
    assert.equal(query(), null, 'No task while the toggle is off');
    await toggle(true);
    const xml = await until(query, 15000, 'the wake task');
    const boundary = new Date(+start - 30000);
    if (!late) {
      assert.ok(xml.includes(`${pad(boundary.getHours())}:${pad(boundary.getMinutes())}:${pad(boundary.getSeconds())}</StartBoundary>`), xml);
      assert.ok(xml.includes('--alarm-wake'));
      await toggle(false);
      await until(() => query() === null, 15000, 'the task to be removed');
      await toggle(true);
      await until(query, 15000, 'the task to return');
    }
    await window.evaluate(() => window.ipc.postMessage(JSON.stringify({ name: '__test:quit', args: [] }))).catch(() => {});
    await until(() => child.exitCode !== null, 15000, 'Still to quit');
    console.log(late ? `Still quit after the task's time. Waiting for it to reopen itself and ring at ${start.toLocaleTimeString()}…` : `Still quit. Waiting for Windows to reopen it at ${boundary.toLocaleTimeString()} and ring at ${start.toLocaleTimeString()}…`);
    const record = await until(async () => {
      const [saved] = JSON.parse(await fs.readFile(path.join(data, 'alerts.json'), 'utf8'));
      return saved.lastOccurrence === +start && saved;
    }, +start - Date.now() + 60000, 'the relaunched Still to ring the alert');
    assert.match(record.lastResult, /^Reminder delivered/); // Not "Late reminder".
    console.log('Alert rang after quit:', record.lastResult);
    await new Promise(r => setTimeout(r, 3000));
    await fs.mkdir('test-results', { recursive: true });
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${path.resolve(`test-results/alerts-wake${late ? '-late' : ''}.png`).replace(/'/g, "''")}')`]);
  } finally {
    try { execFileSync('schtasks.exe', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore' }); } catch {}
    await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    // Close the Still that Task Scheduler (or Still itself) reopened for this test profile.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='Still.exe'" | Where-Object { $_.CommandLine -like '*--alarm-wake*' -and $_.CommandLine.Contains('${data.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1000));
    await fs.rm(data, { recursive: true, force: true }).catch(() => {});
  }
}
run(false).then(() => run(true)).then(() => console.log('Passed: Windows reopened Still for the alert after it quit, and Still reopened itself when it quit inside the last 30 s.')).catch(error => { console.error(error); process.exitCode = 1; });
