// Live integration check: blocks only the compiled harmless SessionTests fixture.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
async function run() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath: path.resolve('release/win-unpacked/Still.exe'), args: ['--test'], env });
  let window, bundledGuard, hiddenGuard, sessionId, sourceHidden = false, released = false;
  try {
    const resourcesPath = await application.evaluate(() => process.resourcesPath);
    bundledGuard = path.join(resourcesPath, 'guard');
    hiddenGuard = path.join(resourcesPath, `guard-hidden-${process.pid}`);
    window = await application.firstWindow();
    await window.waitForFunction(() => window.still && typeof state !== 'undefined' && state.installed);
    const cachedGuard = path.join(await application.evaluate(({ app }) => app.getPath('userData')), 'guard');
    await fs.access(path.join(cachedGuard, 'Still.Guard.exe'));
    await fs.access(path.join(cachedGuard, 'policy.ps1'));
    // Match the installed service so this check does not request administrator approval for an update.
    await fs.copyFile(path.join(process.env.ProgramFiles, 'Still Guard', 'Still.Guard.exe'), path.join(cachedGuard, 'Still.Guard.exe'));
    assert.equal((await window.evaluate(() => window.still.status())).session, null);
    await window.evaluate(target => {
      apps = [target]; selected = new Set([target.path]);
      prefs.duration = 1; prefs.delayEnabled = false;
      renderApps(); renderSession();
    }, { name: 'Harmless session test', path: path.resolve('native/bin/SessionTests.exe') });
    await fs.rename(bundledGuard, hiddenGuard);
    sourceHidden = true;
    await window.locator('#start-button').click();
    await window.locator('#confirm-accept').click();
    await window.waitForFunction(() => state.session?.phase === 'active', null, { timeout: 60000 });
    const active = await window.evaluate(() => state.session);
    sessionId = active.id;
    assert.equal(active.phase, 'active');
    assert.equal(active.unlockDelayMinutes, 0);
    await window.screenshot({ path: 'test-results/focus-session-started.png' });
    const finished = await window.evaluate(() => window.still.end());
    released = true;
    assert.equal(finished.session, null);
    console.log('PASS: packaged Start focusing → Start my session → active Windows-protected session → release.');
  } catch (error) {
    if (window) console.error(await window.locator('body').innerText());
    throw error;
  } finally {
    try {
      if (sourceHidden) await fs.rename(hiddenGuard, bundledGuard);
      if (window && sessionId && !released) await window.evaluate(() => window.still.end());
    } finally {
      await application.close();
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
