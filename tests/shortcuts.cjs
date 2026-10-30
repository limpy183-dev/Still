// The keyboard shortcuts of Electron's default menu, which the original kept in its frameless windows:
// Ctrl+Plus / Ctrl+- / Ctrl+0 zoom by half a level, Ctrl+W hides to the tray, Ctrl+M minimizes, F11 toggles full screen,
// Ctrl+R reloads, and keys the page handles itself (Ctrl+K) stay the page's.
const { launch } = require('./rust-launch.cjs');
const assert = require('node:assert/strict');

(async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForSelector('#preview-banner:not([hidden])');
    const base = await window.evaluate(() => devicePixelRatio);
    const zoom = async expected => {
      await window.waitForFunction(([base, expected]) => Math.abs(devicePixelRatio / base - expected) < 0.01, [base, expected]);
    };
    const main = async () => (await application.windowStates())[0];
    await window.locator('h1').first().click();
    await window.keyboard.press('Control+Shift+Equal'); await zoom(1.2 ** 0.5);
    await window.keyboard.press('Control+Shift+Equal'); await zoom(1.2);
    await window.keyboard.press('Control+0'); await zoom(1);
    await window.keyboard.press('Control+Minus'); await zoom(1.2 ** -0.5);
    await window.keyboard.press('Control+0'); await zoom(1);
    await window.keyboard.press('Control+Equal'); await window.waitForTimeout(300); await zoom(1); // Ctrl+= was never a shortcut

    await window.keyboard.press('F11');
    for (let i = 0; i < 20 && !(await main()).fullscreen; i++) await window.waitForTimeout(100);
    assert.equal((await main()).fullscreen, true, 'F11 enters full screen');
    await window.keyboard.press('F11');
    for (let i = 0; i < 20 && (await main()).fullscreen; i++) await window.waitForTimeout(100);
    assert.equal((await main()).fullscreen, false, 'F11 leaves full screen');

    await window.keyboard.press('Control+m');
    await window.waitForFunction(() => !presentationVisible);
    await window.evaluate(() => window.still.showWindow());
    await window.waitForFunction(() => presentationVisible);

    // Typing in a field does not stop the window shortcuts, as with Electron's menu.
    await window.locator('#intention').focus();
    await window.keyboard.press('Control+w');
    for (let i = 0; i < 20 && (await main()).visible; i++) await window.waitForTimeout(100);
    assert.equal((await main()).visible, false, 'Ctrl+W hides the window to the tray');
    await window.evaluate(() => window.still.showWindow());
    for (let i = 0; i < 20 && !(await main()).visible; i++) await window.waitForTimeout(100);

    await window.keyboard.press('Control+k');
    await window.waitForSelector('#picker-dialog[open]');
    assert.equal((await main()).visible, true, "the page's own shortcut does not reach the menu roles");
    await window.keyboard.press('Escape');

    // Ctrl+Shift+I opens DevTools (the browser's own F12 stays off, as in Electron).
    const targets = () => new Promise(resolve => require('node:http').get({ host: '127.0.0.1', port: application.port, path: '/json' }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body))); }));
    const devtools = async () => (await targets()).some(t => t.url.startsWith('devtools://'));
    await window.keyboard.press('Control+Shift+I');
    for (let i = 0; i < 30 && !(await devtools()); i++) await window.waitForTimeout(100);
    assert.equal(await devtools(), true, 'Ctrl+Shift+I opens DevTools');
    await window.bringToFront(); await window.locator('h1').first().click();

    await window.evaluate(() => { window.beforeReload = true; });
    await Promise.all([window.waitForEvent('load'), window.keyboard.press('Control+r')]);
    await window.waitForSelector('#preview-banner:not([hidden])');
    assert.equal(await window.evaluate(() => window.beforeReload), undefined, 'Ctrl+R reloads the screen');
    console.log('Passed: zoom in/out/reset by half levels, F11 full screen, Ctrl+M minimize, Ctrl+W hide to tray (also from a text field), page shortcuts first, DevTools, Ctrl+R reload.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
