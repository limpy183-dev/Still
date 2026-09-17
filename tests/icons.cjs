const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

async function run() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const application = await electron.launch({
    ...(packaged ? { executablePath: path.resolve('release/win-unpacked/Still.exe') } : {}),
    args: [...(packaged ? [] : ['.']), '--test'], env, timeout: 60000
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => !!window.still);
    const apps = await window.evaluate(() => window.still.discover());
    const missing = apps.filter(a => !a.icon);
    console.log(`Icons: ${apps.length - missing.length}/${apps.length}; fallback: ${missing.map(a => a.name).join(', ') || 'none'}`);
    assert.ok(apps.some(a => a.path.startsWith('appx:') && a.icon), 'Installed Store logos load');
    assert.ok(apps.some(a => !a.path.startsWith('appx:') && a.icon), 'Desktop icons load');
    await window.evaluate(async apps => {
      const { preferences } = await window.still.bootstrap();
      await window.still.savePreferences({ ...preferences, apps });
    }, apps);
    // Bootstrap must reconstruct icons from the saved identity-only preferences.
    const restored = await window.evaluate(() => window.still.bootstrap());
    for (const app of apps.filter(a => a.icon)) {
      assert.ok(restored.apps.find(a => a.path === app.path)?.icon, `Saved icon restored: ${app.name}`);
    }
    await window.reload();
    await window.locator('[data-page="library"]').click();
    await window.waitForFunction(count => document.querySelectorAll('#library-list .app-row').length === count, apps.length);
    await window.waitForFunction(() => [...document.querySelectorAll('#library-list .app-icon img')].every(img => img.complete && img.naturalWidth > 0));
    assert.equal(await window.locator('#library-list .app-icon').count(), apps.length);
    await window.screenshot({ path: 'test-results/library-icons.png', fullPage: true });
    await window.evaluate(() => {
      const img = document.querySelector('#library-list .app-icon img');
      img.dispatchEvent(new Event('error'));
    });
    assert.ok(await window.locator('#library-list .app-icon svg').count(), 'Failed image gets a visible fallback');
    console.log('Passed: discovery, saved-library icon restoration, image decoding, and broken-image fallback.');
  } finally { await application.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
