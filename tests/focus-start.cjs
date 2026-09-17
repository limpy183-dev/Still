// Live integration check: blocks only the compiled harmless SessionTests fixture.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
async function run() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath: path.resolve('release/win-unpacked/Still.exe'), args: ['--test'], env });
  let window, sessionId;
  try {
    window = await application.firstWindow();
    await window.waitForFunction(() => window.still && typeof state !== 'undefined' && state.installed);
    assert.equal((await window.evaluate(() => window.still.status())).session, null);
    await window.evaluate(target => {
      apps = [target]; selected = new Set([target.path]);
      prefs.duration = 1; prefs.delayEnabled = false;
      renderApps(); renderSession();
    }, { name: 'Harmless session test', path: path.resolve('native/bin/SessionTests.exe') });
    await window.locator('#start-button').click();
    await window.locator('#confirm-accept').click();
    await window.waitForFunction(() => state.session?.phase === 'active', null, { timeout: 60000 });
    const active = await window.evaluate(() => window.still.status());
    sessionId = active.session.id;
    assert.equal(active.session.phase, 'active');
    assert.equal(active.session.unlockDelayMinutes, 0);
    await window.screenshot({ path: 'test-results/focus-session-started.png' });
    await window.evaluate(() => window.still.end());
    assert.equal((await window.evaluate(() => window.still.status())).session, null);
    console.log('PASS: packaged Start focusing → Start my session → active Windows-protected session → release.');
  } catch (error) {
    if (window) console.error(await window.locator('body').innerText());
    throw error;
  } finally {
    if (window && sessionId) {
      const current = await window.evaluate(() => window.still.status());
      if (current.session?.id === sessionId) await window.evaluate(() => window.still.end());
    }
    await application.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
