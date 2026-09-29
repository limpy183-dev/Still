// Live check for "Alarms after you quit": registers a real Task Scheduler task ("Still Alerts Test"),
// quits Still, and waits for Windows to reopen it in the tray and ring the alert. Takes about two minutes.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const task = 'Still Alerts Test';
const query = () => { try { return execFileSync('schtasks.exe', ['/Query', '/TN', task, '/XML'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const until = async (check, ms, what) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500))) { const value = await check(); if (value) return value; } throw Error('Timed out waiting for ' + what); };
const pad = n => String(n).padStart(2, '0');
async function run() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.', '--test'], env });
  const window = await application.firstWindow();
  const data = await application.evaluate(({ app }) => app.getPath('userData'));
  await window.waitForFunction(() => typeof prefs !== 'undefined' && document.querySelector('#alerts-after-quit').onchange);
  // Ring at the first whole minute at least 75 s away, so the task (30 s early) fires after Still quits.
  const start = new Date(Math.ceil((Date.now() + 75000) / 60000) * 60000);
  const alert = { title: 'Wake test', note: '', date: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, time: `${pad(start.getHours())}:${pad(start.getMinutes())}`, repeat: 'once', lengthMode: 'duration', durationMinutes: 5, endTime: '00:00', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 0, sound: 'chime', volume: 20, enabled: true };
  await window.evaluate(value => window.still.saveAlert(value), alert);
  const toggle = on => window.evaluate(on => { const box = document.querySelector('#alerts-after-quit'); box.checked = on; box.onchange(); }, on);
  try {
    assert.equal(query(), null, 'No task while the toggle is off');
    await toggle(true);
    const xml = await until(query, 15000, 'the wake task');
    const boundary = new Date(+start - 30000);
    assert.ok(xml.includes(`${pad(boundary.getHours())}:${pad(boundary.getMinutes())}:${pad(boundary.getSeconds())}</StartBoundary>`), xml);
    assert.ok(xml.includes('--alarm-wake'));
    await toggle(false);
    await until(() => query() === null, 15000, 'the task to be removed');
    await toggle(true);
    await until(query, 15000, 'the task to return');
    await application.evaluate(({ app }) => app.quit());
    console.log(`Still quit. Waiting for Windows to reopen it at ${boundary.toLocaleTimeString()} and ring at ${start.toLocaleTimeString()}…`);
    const record = await until(async () => {
      const [saved] = JSON.parse(await fs.readFile(path.join(data, 'alerts.json'), 'utf8'));
      return saved.lastOccurrence === +start && saved;
    }, +start - Date.now() + 60000, 'the relaunched Still to ring the alert');
    assert.match(record.lastResult, /^Reminder delivered/);
    console.log('Alert rang after quit:', record.lastResult);
    await new Promise(r => setTimeout(r, 3000));
    await fs.mkdir('test-results', { recursive: true });
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; [System.Drawing.Graphics]::FromImage($i).CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${path.resolve('test-results/alerts-wake.png').replace(/'/g, "''")}')`]);
    console.log('Desktop captured in test-results/alerts-wake.png');
  } finally {
    try { execFileSync('schtasks.exe', ['/Delete', '/TN', task, '/F'], { stdio: 'ignore' }); } catch {}
    // Close the Still that Task Scheduler reopened for this test profile.
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*--alarm-wake*' -and $_.CommandLine.Contains('${data.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
    await application.close().catch(() => {});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
