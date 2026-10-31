// Installs, reinstalls and uninstalls Still through the installer's own screens, entirely inside a sandbox folder:
// STILL_SETUP_SANDBOX redirects the install folder, shortcuts and registry key, so the real installation is never touched.
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const version = fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8').match(/^version = "(.+)"/m)[1];
const setup = path.join(root, 'dist', `Still-Setup-${version}.exe`);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'still-sandbox-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const up = port => new Promise(res => http.get({ host: '127.0.0.1', port, path: '/json' }, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const registry = () => { try { return execFileSync('reg', ['query', 'HKCU\\Software\\StillSetupSandbox', '/s'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };

async function open(exe) {
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(exe, [], { env: { ...process.env, STILL_SETUP_SANDBOX: sandbox, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: 'ignore' });
  for (let i = 0; i < 200 && !(await up(port)); i++) await sleep(100);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page; for (let i = 0; i < 100 && !(page = browser.contexts()[0].pages()[0]); i++) await sleep(100);
  await page.waitForSelector('#heading:not(:empty)');
  return { child, browser, page, exited: new Promise(r => child.on('exit', r)) };
}
const heading = page => page.locator('#heading').innerText();

(async () => {
  const install = path.join(sandbox, 'Programs', 'Still');
  try {
    // 1. First install.
    let app = await open(setup);
    assert.equal(await heading(app.page), 'Make room for focus.');
    assert.equal(await app.page.locator('#locationText').innerText(), install);
    assert.equal(await app.page.locator('#title').innerText(), [...`STILL · SETUP ${version}`].join(' '));
    await app.page.locator('#primary').click();
    await app.page.waitForFunction(() => document.querySelector('#heading').textContent === 'All set.', null, { timeout: 60000 });
    for (const file of ['Still.exe', 'guard/Still.Guard.exe', 'guard/policy.ps1', 'Uninstall Still.exe', 'LICENSE']) assert.ok(fs.existsSync(path.join(install, file)), file + ' is installed');
    assert.ok(fs.existsSync(path.join(sandbox, 'Start Menu', 'Still Focus.lnk')) && fs.existsSync(path.join(sandbox, 'Desktop', 'Still.lnk')), 'shortcuts');
    const key = registry();
    assert.match(key, new RegExp(`DisplayVersion\\s+REG_SZ\\s+${version.replaceAll('.', '\\.')}`));
    assert.ok(key.includes('InstallLocation') && key.includes('UninstallString') && key.includes('EstimatedSize'), 'uninstall entry');
    // The installed uninstaller is byte-for-byte this program without the app attached.
    assert.ok(fs.statSync(path.join(install, 'Uninstall Still.exe')).size < fs.statSync(setup).size / 1.5);
    await app.page.locator('#launch').uncheck({ force: true }); // never start the sandboxed copy against real data
    await app.page.locator('#primary').click(); // Finish
    await app.exited; await app.browser.close().catch(() => {});

    // 2. Installing the same version again offers a repair and keeps the files.
    app = await open(setup);
    assert.equal(await heading(app.page), 'Already here.');
    assert.equal(await app.page.locator('#primary').innerText(), 'Reinstall');
    await app.page.locator('#primary').click();
    await app.page.waitForFunction(() => document.querySelector('#heading').textContent === 'Up to date.', null, { timeout: 60000 });
    assert.ok(fs.existsSync(path.join(install, 'Still.exe')));
    await app.page.locator('#launch').uncheck({ force: true });
    await app.page.locator('#primary').click();
    await app.exited; await app.browser.close().catch(() => {});

    // 3. The installed program starts in preview mode from its install folder.
    const preview = spawn(path.join(install, 'Still.exe'), ['--demo', '--test', `--test-data=${path.join(sandbox, 'preview')}`], { stdio: 'ignore' });
    await sleep(4000);
    assert.equal(preview.exitCode, null, 'the installed app keeps running');
    preview.kill();

    // 4. Uninstall.
    app = await open(path.join(install, 'Uninstall Still.exe'));
    assert.equal(await heading(app.page), 'Leaving so soon?');
    assert.equal(await app.page.locator('#rowGuard').isHidden(), true, 'no protection to remove');
    await app.page.locator('#primary').click();
    await app.page.waitForFunction(() => document.querySelector('#heading').textContent === 'Goodbye for now.', null, { timeout: 60000 });
    assert.ok(!fs.existsSync(path.join(sandbox, 'Start Menu', 'Still Focus.lnk')) && !fs.existsSync(path.join(sandbox, 'Desktop', 'Still.lnk')), 'shortcuts removed');
    assert.ok(!registry().includes('DisplayVersion'), 'uninstall entry removed');
    await app.page.locator('#primary').click(); // Close
    await app.exited; await app.browser.close().catch(() => {});
    for (let i = 0; i < 40 && fs.existsSync(install); i++) await sleep(250);
    assert.ok(!fs.existsSync(install), 'the install folder, including the uninstaller itself, is gone');
    console.log('Passed: install, repair, installed app start-up and uninstall, in a sandbox.');
  } finally {
    try { execFileSync('reg', ['delete', 'HKCU\\Software\\StillSetupSandbox', '/f'], { stdio: 'ignore' }); } catch { /* already gone */ }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); }); // exit: a Setup left running would keep this process alive
