const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch();
  try {
    for (const [width, reducedMotion] of [[320, 'no-preference'], [390, 'no-preference'], [390, 'reduce'], [1440, 'no-preference']]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700, reducedMotion
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../website/features.html')).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      const ids = await page.locator('[data-spy] a').evaluateAll(links => links.map(a => a.hash.slice(1)));
      // Exercise section changes in both directions, without clicking the tabs.
      for (const id of [...ids, ...ids.slice(0, -1).reverse()]) {
        const before = await page.evaluate(id => {
          window.scrollTo({ top: document.getElementById(id).getBoundingClientRect().top + scrollY + 100, behavior: 'instant' });
          return scrollY;
        }, id);
        await page.waitForFunction(id => document.querySelector('[data-spy] a.on')?.hash === `#${id}`, id);
        await page.waitForTimeout(650);
        const state = await page.evaluate(() => {
          const nav = document.querySelector('[data-spy]');
          const active = nav.querySelector('a.on');
          const bounds = nav.getBoundingClientRect(), tab = active?.getBoundingClientRect();
          return { y: scrollY, hash: active?.hash, visible: tab && tab.left >= bounds.left - 1 && tab.right <= bounds.right + 1 };
        });
        assert.ok(Math.abs(state.y - before) <= 1, `${width}px/${reducedMotion}/${id}: scrollspy moved the page from ${before} to ${state.y}`);
        assert.equal(state.hash, `#${id}`);
        assert.ok(state.visible, `${id}: active tab is visible`);
      }
      // A deliberate tap/click must still navigate to the chosen section.
      await page.locator('[data-spy] a[href="#library"]').click();
      await page.waitForTimeout(1200);
      assert.equal(new URL(page.url()).hash, '#library');
      const top = await page.locator('#library').evaluate(el => el.getBoundingClientRect().top);
      assert.ok(Math.abs(top - 96) <= 2, `Anchor navigation lands at the scroll padding: ${top}`);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${width}px, ${reducedMotion}: vertical scrolling, tab visibility and anchor navigation`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
