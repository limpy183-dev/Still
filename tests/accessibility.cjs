// Settings > Made to fit you: every option applies, persists, and leaves the layout intact.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const screenshot = require('./screenshot.cjs');
const pages = ['focus', 'library', 'todos', 'alerts', 'limits', 'history', 'settings'];
const options = [['high-contrast', 'high-contrast', 'highContrast'], ['readable-font', 'readable-font', 'readableFont'], ['strong-focus', 'strong-focus', 'strongFocus'], ['reduced-motion', 'reduced-motion', 'reducedMotion']];
// Runs in the page: sideways scrolling, controls cut off past the right edge outside a scroller, or buttons clipping their label.
const layoutProblems = () => {
  const problems = [];
  if (document.documentElement.scrollWidth > innerWidth) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
  for (const el of document.querySelectorAll('.page.active button, .page.active input, .page.active select, .page.active h1, .page.active h2, .page.active h3')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || el.closest('[hidden]')) continue;
    let scroller = false;
    for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { scroller = true; break; } }
    if (!scroller && rect.right > innerWidth + 1) problems.push(`${el.tagName}#${el.id || el.className} runs off the right edge (${Math.round(rect.right)} > ${innerWidth})`);
  }
  for (const el of document.querySelectorAll('.page.active button')) {
    if (getComputedStyle(el).overflow !== 'visible' && el.scrollWidth > el.clientWidth + 2) problems.push(`button "${el.textContent.trim().slice(0, 20)}" clips its label`);
  }
  return problems;
};
// Runs in the page: WCAG contrast of every visible text node in the active page against its nearest opaque background.
const lowContrast = min => {
  const parse = c => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }) => [r, g, b].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const mix = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const backdrop = el => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.backgroundImage !== 'none') return null;
      const c = parse(style.backgroundColor); if (c.a > 0) { layers.push(c); if (c.a === 1) break; }
    }
    return layers.reduceRight((under, top) => mix(top, under), { r: 255, g: 255, b: 255, a: 1 });
  };
  const out = [];
  const walker = document.createTreeWalker(document.querySelector('.page.active') || document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement, text = node.textContent.trim();
    if (!text || el.closest('[hidden],script,style,svg') || getComputedStyle(el).visibility === 'hidden' || el.closest(':disabled')) continue;
    const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
    const bg = backdrop(el); if (!bg) continue;
    const fg = mix(parse(getComputedStyle(el).color), bg), [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + .05) / (b + .05);
    if (ratio < min) out.push(`${ratio.toFixed(2)} "${text.slice(0, 28)}" <${el.tagName.toLowerCase()} class="${el.className}">`);
  }
  return out;
};
async function run() {
  await fs.mkdir('test-results', { recursive: true });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.', '--demo', '--test'], env: environment, timeout: 60000 });
  const window = await application.firstWindow();
  const errors = [];
  window.on('pageerror', error => errors.push(error.message));
  window.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const resize = (w, h) => application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [w, h]);
  let baseRatio;
  const zoom = async () => Math.round(await window.evaluate(() => devicePixelRatio) / baseRatio * 100) / 100;
  const hasClass = cls => window.evaluate(c => document.body.classList.contains(c), cls);
  const stored = (key, value) => window.waitForFunction(async ([key, value]) => (await window.still.bootstrap()).preferences[key] === value, [key, value]);
  const page = async name => { await window.locator(`[data-page="${name}"]`).click(); await window.waitForTimeout(320); };
  try {
    await window.waitForSelector('#preview-banner:not([hidden])');
    await window.evaluate(() => document.fonts.ready);
    baseRatio = await window.evaluate(() => devicePixelRatio);
    await page('settings');

    // The section is the last panel of Settings, and Reduce motion moved into it.
    assert.equal(await window.locator('#page-settings > section:last-of-type').getAttribute('aria-labelledby'), 'accessibility-title');
    assert.equal(await window.locator('#page-settings .accessibility-settings #reduced-motion').count(), 1);
    assert.equal(await window.locator('label[for="text-size"]').count(), 1, 'Text size dropdown has a visible label');
    assert.deepEqual(await window.locator('#text-size option').evaluateAll(o => o.map(x => x.value)), ['100', '115', '130', '150', '175']);

    // Each switch toggles its body class, saves, and switches back off.
    for (const [id, cls, key] of options) {
      await window.locator('#' + id).check({ force: true });
      assert.equal(await hasClass(cls), true, id + ' on'); await stored(key, true);
      await window.locator('#' + id).uncheck({ force: true });
      assert.equal(await hasClass(cls), false, id + ' off'); await stored(key, false);
    }
    assert.ok((await window.evaluate(() => getComputedStyle(document.body).fontFamily)).startsWith('Manrope'));
    await window.locator('#readable-font').check({ force: true });
    assert.ok((await window.evaluate(() => getComputedStyle(document.body).fontFamily)).startsWith('Verdana'), 'Verdana replaces Manrope');
    await window.locator('#readable-font').uncheck({ force: true });

    // Strong focus: a keyboard-focused button gets a thicker outline only when switched on.
    const outline = async () => { await window.locator('#check-updates').focus(); await window.keyboard.press('Shift+Tab'); await window.keyboard.press('Tab'); return parseFloat(await window.evaluate(() => getComputedStyle(document.activeElement).outlineWidth)); };
    const normal = await outline();
    await window.locator('#strong-focus').check({ force: true });
    assert.ok(await outline() >= normal * 1.4, 'Strong focus draws a thicker outline');
    await window.locator('#strong-focus').uncheck({ force: true });

    // High contrast lifts every visible text on every page to WCAG AAA (7:1).
    await window.locator('#high-contrast').check({ force: true });
    for (const name of pages) { await page(name); assert.deepEqual(await window.evaluate(lowContrast, 7), [], `High contrast text on ${name}`); }
    await page('settings');
    await screenshot(application, window, 'test-results/accessibility-high-contrast.png');
    await window.locator('#high-contrast').uncheck({ force: true });

    // Text size is page zoom: it changes, saves, and every page still fits at each window size.
    assert.equal(await zoom(), 1);
    for (const size of [115, 130, 150, 175]) {
      await window.locator('#text-size').selectOption(String(size)); await stored('textSize', size);
      assert.equal(await zoom(), size / 100, `zoom at ${size}%`);
      for (const [w, h] of [[1350, 900], [1000, 700], [640, 480]]) {
        await resize(w, h); await window.waitForTimeout(150);
        for (const name of pages) { await page(name); assert.deepEqual(await window.evaluate(layoutProblems), [], `${size}% at ${w}x${h} on ${name}`); }
        // The sidebar scrolls when the window is too short for it, so Settings and guidance must stay reachable.
        await window.locator('#help-button').scrollIntoViewIfNeeded();
        const help = await window.evaluate(() => { const r = document.querySelector('#help-button').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
        assert.ok(help.top >= 0 && help.bottom <= help.height + 1, `Guidance reachable at ${size}% ${w}x${h}: ${JSON.stringify(help)}`);
      }
    }
    await resize(1000, 700); await page('settings');
    await window.locator('.accessibility-settings').scrollIntoViewIfNeeded();
    await window.waitForTimeout(400);
    // Playwright's own capture comes back blank under page zoom, so ask Electron for the window contents.
    const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile('test-results/accessibility-175.png', Buffer.from(png, 'base64'));

    // Everything on together at the largest size, then a reload keeps it all.
    for (const [id] of options) await window.locator('#' + id).check({ force: true });
    for (const [w, h] of [[1350, 900], [640, 480]]) {
      await resize(w, h); await window.waitForTimeout(150);
      for (const name of pages) { await page(name); assert.deepEqual(await window.evaluate(layoutProblems), [], `all options at ${w}x${h} on ${name}`); }
    }
    await window.reload(); await window.waitForSelector('#preview-banner:not([hidden])');
    assert.equal(await zoom(), 1.75, 'Text size survives a reload');
    for (const [, cls] of options) assert.equal(await hasClass(cls), true, cls + ' survives a reload');
    await page('settings');
    assert.equal(await window.locator('#text-size').inputValue(), '175');

    // Alarm screens are separate windows: they take the same text size, contrast, font and focus options.
    await page('alerts'); await window.locator('#alert-add').click(); await window.locator('#alert-title').fill('Stretch');
    const [alarm] = await Promise.all([application.waitForEvent('window'), window.locator('#alert-preview').evaluate(button => button.click())]);
    await alarm.waitForSelector('#alarm-title:has-text("Stretch")');
    for (const [, cls] of options) assert.equal(await alarm.evaluate(c => document.body.classList.contains(c), cls), true, 'alarm ' + cls);
    assert.equal(Math.round(await alarm.evaluate(() => devicePixelRatio) / baseRatio * 100) / 100, 1.75, 'alarm text size');
    await alarm.evaluate(() => window.alarm.action('dismiss')).catch(() => {});
    if (await window.locator('#alert-dialog[open]').count()) await window.keyboard.press('Escape');
    await page('settings');

    // Reset returns everything to the defaults.
    await window.locator('#accessibility-reset').click(); await stored('textSize', 100);
    for (const [, , key] of options) await stored(key, false);
    assert.equal(await zoom(), 1); assert.equal(await window.locator('#text-size').inputValue(), '100');
    assert.equal(await window.evaluate(() => document.body.className.trim()), '');
    assert.deepEqual(errors, []);
    console.log('PASS: accessibility options apply, persist, reset, and keep the layout intact');
  } finally { await application.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
