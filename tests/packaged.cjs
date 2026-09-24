const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
async function run() {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  await fs.mkdir('test-results', { recursive: true });
  const application = await electron.launch({ executablePath: path.resolve(process.env.STILL_TEST_EXECUTABLE || 'release/win-unpacked/Still.exe'), args: ['--test'], env: environment, timeout: 60000 });
  try {
    const window = await application.firstWindow();
    const errors = []; window.on('pageerror', error => errors.push(error.message));
    window.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await window.waitForFunction(() => !!window.still);
    const initial = await window.evaluate(() => window.still.bootstrap());
    assert.equal(!!initial.demo, false, 'Packaged app defaults to real mode');
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
    await window.evaluate(() => document.fonts.ready);
    await window.waitForTimeout(600);
    await window.screenshot({ path: 'test-results/windows-app.png', fullPage: true });
    await window.locator('#add-apps').click();
    await window.waitForSelector('#picker-list .app-row', { timeout: 60000 });
    const discovered = await window.locator('#picker-list .app-row').count();
    assert.ok(discovered > 0, 'Packaged PowerShell discovery returns actual installed apps');
    await window.screenshot({ path: 'test-results/windows-app-picker.png', fullPage: true });
    await window.locator('#picker-search').fill('zzzz-no-such-application');
    assert.equal(await window.locator('#picker-list .app-row').count(), 0);
    await window.locator('#picker-search').fill('');
    const first = window.locator('#picker-list .app-row').first();
    await first.click(); await window.locator('#picker-done').click();
    assert.equal(await window.locator('#selected-count').innerText(), '1');
    await window.locator('#start-button').click();
    assert.ok((await window.locator('#confirm-body').innerText()).includes(initial.installed ? 'Save any open work' : 'administrator approval'));
    await window.locator('#confirm-cancel').click();
    const final = await window.evaluate(() => window.still.status());
    assert.equal(final.installed, initial.installed, 'Smoke test does not install a service');
    assert.deepEqual(errors, []);
    const resources = await application.evaluate(() => process.resourcesPath);
    await fs.access(path.join(resources, 'guard/Still.Guard.exe'));
    await fs.access(path.join(resources, 'guard/policy.ps1'));
    console.log(`Passed: packaged app, bundled resources/font, ${discovered} discovered Windows apps, selection/search, and setup prompt. No protection installed or rules applied.`);
  } finally { await application.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
