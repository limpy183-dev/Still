// Out of sight (minimized, or shown but covered by another window) the page's endless animations hold still, so WebView2
// stops drawing; back in sight they carry on at once, with the timer and focus ring already current.
const { launch } = require('./rust-launch.cjs');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

// An ordinary app window (captioned, topmost) laid over Still's window for a few seconds, as another app's would be.
function cover(pid, seconds) {
  const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class Dwm { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, int[] r, int s); }'
[Dwm]::SetProcessDPIAware() | Out-Null
$r = New-Object int[] 4; [Dwm]::DwmGetWindowAttribute((Get-Process -Id ${pid}).MainWindowHandle, 9, $r, 16) | Out-Null
$f = New-Object System.Windows.Forms.Form; $f.Text = 'Covering Still'; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.Bounds = New-Object System.Drawing.Rectangle(($r[0] - 40), ($r[1] - 60), ($r[2] - $r[0] + 80), ($r[3] - $r[1] + 100))
$t = New-Object System.Windows.Forms.Timer; $t.Interval = ${seconds * 1000}; $t.add_Tick({ $f.Close() }); $t.Start()
[System.Windows.Forms.Application]::Run($f)`;
  return spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore' });
}

(async () => {
  const application = await launch();
  try {
    const page = await application.firstWindow();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => typeof presentationCovered !== 'undefined' && document.querySelector('#selected-apps .app-row'));
    await page.evaluate(async () => {
      applyStatus(await still.install());
      applyStatus(await still.start({ durationMinutes: 50, unlockDelayMinutes: 5, intention: 'Background check', apps: apps.filter(a => selected.has(a.path)).map(({ name, path }) => ({ name, path })) }));
    });
    const running = () => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
    const allRunning = n => page.waitForFunction(n => document.getAnimations().filter(a => a.playState === 'running').length === n, n, { polling: 10, timeout: 1000 });
    // How far the focus ring is from where the session's elapsed time puts it, in ms.
    const ringLag = () => page.evaluate(() => { const s = state.session; return Math.abs(ringAnimations[0].currentTime - (s.durationMinutes * 60000 - (s.endsAt - now()))); });
    await page.waitForFunction(() => ringAnimations.length === 3); await page.waitForTimeout(1500);
    const all = await running();
    assert.ok(all >= 4, 'a running session animates (ring, pulse, breathe, leaf)');

    await page.evaluate(() => still.window('minimize'));
    await page.waitForFunction(() => !presentationVisible);
    assert.equal(await running(), 0, 'minimized: nothing animates');
    await page.evaluate(() => still.showWindow());
    await page.waitForFunction(() => presentationVisible); await allRunning(all);

    const covering = cover(application.pid, 6);
    await page.waitForFunction(() => presentationCovered, null, { timeout: 15000 });
    assert.equal(await running(), 0, 'covered: nothing animates');
    await page.waitForTimeout(2500);
    assert.ok(await ringLag() < 1500, 'covered: the held ring is kept current');
    await new Promise(resolve => covering.exitCode !== null ? resolve() : covering.on('exit', resolve));
    const uncovered = Date.now();
    await allRunning(all);
    const resumeMs = Date.now() - uncovered;
    assert.equal(await page.evaluate(() => presentationCovered), false);
    assert.ok(await ringLag() < 150, 'uncovered: the ring carries on from the right place');

    // Settings > Animation frame rate: at 30 fps the slow ambient animations are held and moved on 30 times a second.
    await page.waitForFunction(() => displayHz > 0);
    const hz = await page.evaluate(() => displayHz);
    assert.ok(hz >= 24 && hz <= 500, `the display's rate is measured (${hz})`);
    assert.equal(await page.locator('#animation-fps option[value="0"]').textContent(), `Your display (${hz} fps)`);
    const choose = fps => page.evaluate(fps => { const select = document.querySelector('#animation-fps'); select.value = String(fps); select.dispatchEvent(new Event('change')); }, fps);
    await choose(30);
    await page.waitForFunction(async () => (await still.bootstrap()).preferences.animationFps === 30);
    assert.equal(await running(), 0, 'stepped: nothing animates on its own');
    const leaf = await page.evaluate(() => new Promise(done => {
      const float = document.getAnimations().find(a => a.animationName === 'float'), start = float.currentTime, began = performance.now();
      let last = start, steps = 0;
      const poll = setInterval(() => { if (float.currentTime !== last) { last = float.currentTime; steps++; } }, 1);
      setTimeout(() => { clearInterval(poll); done({ steps, moved: float.currentTime - start, wall: performance.now() - began }); }, 1000);
    }));
    assert.ok(leaf.steps >= 25 && leaf.steps <= 32, `stepped: about 30 steps a second (${leaf.steps})`);
    assert.ok(Math.abs(leaf.moved - leaf.wall) < 80, `stepped: the leaf keeps real time (${Math.round(leaf.moved)} of ${Math.round(leaf.wall)} ms)`);
    assert.ok(await ringLag() < 150, 'stepped: the ring is current');
    // Back to the display's rate, everything runs on its own again, and out of sight it still holds.
    await choose(0); await allRunning(all);
    await page.evaluate(() => still.window('minimize'));
    await page.waitForFunction(() => !presentationVisible);
    assert.equal(await running(), 0, 'after stepping, minimized still holds every animation');
    await page.evaluate(() => still.showWindow());
    await page.waitForFunction(() => presentationVisible); await allRunning(all);
    assert.deepEqual(errors, []);
    console.log(`Passed: minimized and covered hold every animation; uncovered resumes in ${resumeMs} ms with the ring current; at 30 fps the leaf steps ${leaf.steps} times a second on a ${hz} Hz display.`);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exit(1); });
