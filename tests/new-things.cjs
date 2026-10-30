const { _electron: electron } = require('./rust-launch.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const screenshot = require('./screenshot.cjs');

// Something new: plan or log a new thing, see it on both calendars, and keep it after a reload.
async function run() {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const app = await electron.launch({ ...(packaged ? { executablePath: path.resolve('release/win-unpacked/Still.exe') } : {}), args: [...(packaged ? [] : ['.']), '--demo', '--test'], env: environment });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('#preview-banner:not([hidden])');
    await page.locator('[data-page=new]').click();
    assert.equal(await page.locator('#page-crumb').innerText(), 'Something new');
    assert.match(await page.locator('#page-new h1').innerText(), /What new thing will you do today\?/);
    const rows = page.locator('#page-new .new-row'), days = page.locator('#page-new .calendar-day');

    // Empty input adds nothing; a plan lands on today, unticked.
    await page.getByRole('button', { name: 'I’ll do it' }).click();
    assert.equal(await rows.count(), 0);
    await page.locator('#new-text').fill('  Try a new <b>recipe</b>  ');
    await page.locator('#new-text').press('Enter');
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().locator('span').innerText(), 'Try a new <b>recipe</b>');
    assert.equal(await page.locator('#page-new .new-row b').count(), 0, 'Text is never interpreted as HTML');
    assert.equal(await rows.first().locator('[data-new-toggle]').getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#page-new .calendar-day.has-session').count(), 1);

    // Something already done goes on a past day; the future refuses "already did it" but accepts a plan.
    const today = await page.locator('#page-new .calendar-day[aria-current=date]').innerText();
    const past = Number(today) > 1 ? Number(today) - 1 : null, future = Number(today) < 28 ? Number(today) + 1 : null;
    if (past) {
      await days.nth(past - 1).click();
      await page.locator('#new-text').fill('Visit the new museum');
      await page.getByRole('button', { name: 'I already did it' }).click();
      assert.equal(await rows.count(), 1);
      assert.equal(await rows.first().locator('[data-new-toggle]').getAttribute('aria-checked'), 'true', 'Already done is ticked');
      await rows.first().locator('[data-new-toggle]').click();
      assert.equal(await rows.first().locator('[data-new-toggle]').getAttribute('aria-checked'), 'false');
    }
    if (future) {
      await days.nth(future - 1).click();
      await page.locator('#new-text').fill('Learn to juggle');
      await page.getByRole('button', { name: 'I already did it' }).click();
      assert.equal(await rows.count(), 0, 'A future day cannot hold something already done');
      assert.equal(await page.locator('#new-text').inputValue(), 'Learn to juggle', 'The text stays so it can be planned instead');
      await page.getByRole('button', { name: 'I’ll do it' }).click();
      assert.equal(await rows.count(), 1);
    }
    await page.waitForFunction(() => document.querySelector('#todo-save-status').textContent === 'Saved on this PC');

    // Your progress shows the same month, day and entries, and edits there show here.
    const month = await page.locator('#page-new .calendar-navigation strong').innerText();
    await page.locator('[data-page=history]').click();
    const progress = page.locator('#page-history [data-new-view]');
    assert.equal(await progress.locator('.calendar-navigation strong').innerText(), month);
    assert.equal(await progress.locator('.calendar-day.has-session').count(), await page.locator('#page-new .calendar-day.has-session').count(), 'Calendars mark the same days');
    await progress.locator('[data-new-month="1"]').click();
    await page.locator('[data-page=new]').click();
    assert.notEqual(await page.locator('#page-new .calendar-navigation strong').innerText(), month, 'Browsing a month on one calendar moves the other');
    await page.locator('#page-new [data-new-month="-1"]').click();
    await screenshot(app, page, 'test-results/new-things.png');
    await page.locator('[data-page=history]').click();
    await progress.scrollIntoViewIfNeeded();
    await screenshot(app, page, 'test-results/new-things-progress.png');
    const before = await page.evaluate(async () => (await window.still.bootstrap()).preferences.newThings.length);
    await progress.locator('.calendar-day.has-session').first().click();
    await progress.locator('[data-new-delete]').first().click();
    await page.waitForFunction(() => document.querySelector('#todo-save-status').textContent === 'Saved on this PC');

    // Saved with the preferences, so it survives a reload.
    const saved = await page.evaluate(async () => (await window.still.bootstrap()).preferences.newThings);
    assert.equal(saved.length, before - 1);
    assert.ok(saved.every(item => /^\d{4}-\d{2}-\d{2}$/.test(item.day) && typeof item.done === 'boolean'));
    await page.reload();
    await page.waitForSelector('#preview-banner:not([hidden])');
    await page.locator('[data-page=new]').click();
    assert.ok(await page.locator('#page-new .calendar-day.has-session').count() >= 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');
    assert.deepEqual(errors, []);
    console.log('Passed: planning and logging new things, shared calendars on both pages, deletion, persistence, and safe text.');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exit(1); });
