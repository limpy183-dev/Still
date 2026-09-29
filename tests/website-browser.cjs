const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'Still-browser-test-'));
  const extension = path.join(root, 'extension');
  await fs.cp(path.resolve('app/browser-extension'), extension, { recursive: true });
  await fs.copyFile('app/websites.js', path.join(extension, 'websites.js'));
  // Keep every service worker, including one restarted by a reload, away from an installed Still Guard.
  const background = path.join(extension, 'background.js');
  await fs.writeFile(background, "chrome.runtime.connectNative = () => { throw Error('Isolated test'); };\n" + await fs.readFile(background, 'utf8'));
  let executablePath = process.env.STILL_TEST_BROWSER;
  if (!executablePath) {
    const directory = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
    const builds = (await fs.readdir(directory)).filter(name => /^chromium-\d+$/.test(name)).sort().reverse();
    executablePath = path.join(directory, builds[0], 'chrome-win64', 'chrome.exe');
  }
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), { executablePath, headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await context.route('https://**/*', route => route.fulfill({ contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<h1>Allowed page</h1>' }));
    const page = await context.newPage(); await page.goto('https://www.youtube.com/watch');
    await worker.evaluate(async () => {
      clearTimeout(retryTimer); port = null; // This isolated browser test does not contact the installed guard.
      await apply({ sessionId: 'test', websites: ['youtube.com'], screen: { mode: 'custom', title: '<Focus first>', text: 'Keep this time.' }, endsAt: Date.now() + 600000 });
    });
    await page.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
    await page.waitForFunction(() => document.querySelector('h1').textContent === '<Focus first>');
    assert.equal(await page.locator('h1 *').count(), 0);
    await page.screenshot({ path: 'test-results/website-block-page.png' });
    const blocked = await context.newPage();
    await blocked.goto('https://m.youtube.com/watch').catch(() => {});
    await blocked.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
    const allowed = await context.newPage(); await allowed.goto('https://notyoutube.com/');
    assert.equal(await allowed.locator('h1').innerText(), 'Allowed page');
    assert.equal(await allowed.evaluate(() => fetch('https://example.com/resource').then(() => true, () => false)), true);
    assert.equal(await allowed.evaluate(() => fetch('https://m.youtube.com/resource').then(() => true, () => false)), false, 'Subresources are blocked as well as pages');
    await worker.evaluate(() => {
      chrome.webNavigation.onCommitted.removeListener(navigation);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(navigation);
      chrome.webNavigation.onErrorOccurred.removeListener(navigation);
    });
    for (const url of ['https://YOUTUBE.com/watch', 'https://youtube.com./watch', 'https://%79outube.com/watch']) {
      await blocked.goto(url).catch(() => {});
      await blocked.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
    }
    // Match a real browser DNR request, independently of the navigation listener.
    const matches = await worker.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      return rules.map(rule => ({ type: rule.action.type, domains: rule.condition.requestDomains }));
    });
    assert.equal(matches.length, 2); assert.deepEqual(matches[1], { type: 'block', domains: ['youtube.com'] });
    await worker.evaluate(() => apply({ sessionId: 'test', websites: ['youtube.com'], screen: { mode: 'redirect', redirect: 'https://example.com/work' }, endsAt: Date.now() + 600000 }));
    await blocked.goto('https://youtube.com').catch(() => {}); await blocked.waitForURL('https://example.com/work');
    // An app update rewrites the companion on disk; the running companion reloads itself and keeps its rules.
    // Like a real setup (Load unpacked needs Developer mode); without it Chromium disables the companion when it reloads.
    const settings = await context.newPage(); await settings.goto('chrome://extensions');
    await settings.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })); await settings.close();
    const manifestFile = path.join(extension, 'manifest.json');
    await fs.writeFile(manifestFile, JSON.stringify({ ...JSON.parse(await fs.readFile(manifestFile, 'utf8')), version_name: '9.9.9' }));
    await worker.evaluate(() => reloadIfUpdated()).catch(() => {}); // The old worker ends mid-call.
    let updated;
    for (let wait = 0; !updated; wait += 100) {
      if (wait > 15000) throw Error('The companion did not reload after its files changed.');
      await new Promise(resolve => setTimeout(resolve, 100));
      updated = context.serviceWorkers().find(candidate => candidate !== worker);
    }
    assert.equal(await updated.evaluate(() => chrome.runtime.getManifest().version_name), '9.9.9');
    assert.equal((await updated.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length, 2, 'Blocking rules survive the reload');
    await updated.evaluate(() => apply({ sessionId: null, websites: [], screen: null, endsAt: 0 }));
    await blocked.goto('https://youtube.com'); assert.equal(await blocked.locator('h1').innerText(), 'Allowed page');
    // Without the app: the settings page starts a session of the extension's own, with its own block screen, and ends it.
    const settings2 = await context.newPage(); await settings2.goto(`chrome-extension://${extensionId}/still.html`);
    await settings2.fill('#site', 'https://www.youtube.com/watch'); await settings2.click('#add-site button');
    await settings2.getByRole('listitem').filter({ hasText: 'youtube.com' }).waitFor();
    await settings2.check('input[value=custom]'); await settings2.fill('#title', 'Mine first'); assert.equal(await settings2.locator('#shot-title').innerText(), 'Mine first', 'The preview follows the headline'); await settings2.click('#screen .primary');
    await settings2.getByText('Saved.').waitFor();
    await settings2.fill('#limit-site', 'reddit.com'); await settings2.click('#add-limit button');
    await settings2.getByText('reddit.com · 30 min a day').waitFor();
    await settings2.click('#start'); await settings2.getByText(/on hold until/).waitFor();
    await blocked.waitForURL(`chrome-extension://${extensionId}/blocked.html?by=me`);
    await blocked.waitForFunction(() => document.querySelector('h1').textContent === 'Mine first');
    await blocked.screenshot({ path: 'test-results/website-own-block-page.png' }); await settings2.screenshot({ path: 'test-results/website-settings.png', fullPage: true });
    // With the app too: both sessions hold at once, and neither side's release frees what the other holds.
    const ruleCount = () => updated.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then(rules => rules.length));
    const until = async (check, message) => { for (let wait = 0; !(await check()); wait += 100) { if (wait > 5000) throw Error(message); await new Promise(resolve => setTimeout(resolve, 100)); } };
    await updated.evaluate(() => apply({ sessionId: 'app', websites: ['x.com'], screen: { mode: 'garden' }, endsAt: Date.now() + 600000 }));
    assert.equal(await ruleCount(), 4);
    await settings2.getByText('Still for Windows is holding 1 website').waitFor();
    const other = await context.newPage(); await other.goto('https://x.com/home').catch(() => {}); await other.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
    await updated.evaluate(() => apply({ sessionId: null, websites: [], screen: null, endsAt: 0 }));
    assert.equal(await ruleCount(), 2, 'Releasing the app session keeps the extension session');
    await blocked.goto('https://youtube.com').catch(() => {}); await blocked.waitForURL(`chrome-extension://${extensionId}/blocked.html?by=me`);
    await updated.evaluate(() => apply({ sessionId: 'app', websites: ['x.com'], screen: { mode: 'garden' }, endsAt: Date.now() + 600000 }));
    await settings2.click('#stop'); await settings2.locator('#start').waitFor();
    await until(async () => await ruleCount() === 2, 'Ending the extension session did not release only its own rules.');
    await other.goto('https://x.com/home').catch(() => {}); await other.waitForURL(`chrome-extension://${extensionId}/blocked.html`);
    await updated.evaluate(() => apply({ sessionId: null, websites: [], screen: null, endsAt: 0 }));
    await until(async () => await ruleCount() === 0, 'Ending both sessions did not release their rules.');
    await blocked.goto('https://youtube.com'); assert.equal(await blocked.locator('h1').innerText(), 'Allowed page');
    await other.goto('https://x.com/home'); assert.equal(await other.locator('h1').innerText(), 'Allowed page');
    console.log('Real Chromium extension passed: existing tabs, subdomains, custom text, redirect, unrelated domains, self-reload after updates, release, standalone sessions from the settings page, and both sessions together.');
  } finally {
    await context.close();
    // Unique temporary directory created above, never a user browser profile.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('Still-browser-test-')) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
run().catch(error => { console.error(error); process.exit(1); });
