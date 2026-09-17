const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run() {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.argv.includes('--packaged');
  const app = await electron.launch({ ...(packaged ? { executablePath: path.resolve('release/win-unpacked/Still.exe') } : {}), args: [...(packaged ? [] : ['.']), '--demo', '--test'], env: environment });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('#preview-banner:not([hidden])');
    await page.locator('[data-page=todos]').click();
    const lines = page.locator('.todo-input');
    await lines.first().fill('Write the outline /circle');
    assert.equal(await page.getByRole('option').count(), 1);
    await lines.first().press('Enter');
    assert.equal(await lines.first().inputValue(), 'Write the outline ');
    assert.equal(await page.locator('.todo-check.circle').count(), 1);
    await lines.first().press('Enter');
    await lines.nth(1).fill('/heading');
    await page.getByRole('option', { name: /Heading/ }).click();
    await lines.nth(1).fill('For later');
    await lines.nth(1).press('End');
    await lines.nth(1).press('Enter');
    assert.equal(await page.locator('.todo-row.checkbox').count(), 1, 'Heading continues into a task');
    await lines.nth(2).fill('/');
    assert.equal(await page.getByRole('option').count(), 6);
    await lines.nth(2).press('ArrowDown');
    await lines.nth(2).press('ArrowDown');
    await lines.nth(2).press('Enter');
    await lines.nth(2).fill('A useful idea');
    assert.equal(await page.locator('.todo-row.bullet').count(), 1);
    for (const format of ['number', 'note', 'checkbox']) {
      await page.locator('#todo-add').click();
      await lines.last().fill('/' + format);
      await lines.last().press('Enter');
      await lines.last().fill(format === 'checkbox' ? '<img src=x onerror=alert(1)>' : format + ' text');
    }
    await page.locator('[data-todo-check]').first().click();
    assert.equal(await page.locator('#todo-progress').innerText(), '1 OF 2 COMPLETE');
    await lines.last().fill('Keep /unknown');
    assert.equal(await page.getByRole('option').count(), 0);
    await lines.last().press('Escape');
    assert.equal(await lines.last().inputValue(), 'Keep /unknown');
    await lines.last().fill('<img src=x onerror=alert(1)>');
    await page.waitForFunction(() => document.querySelector('#todo-save-status').textContent === 'Saved on this PC');
    const saved = await page.evaluate(async () => (await window.still.bootstrap()).preferences.todos);
    assert.equal(saved.length, 6);
    await page.reload();
    await page.waitForSelector('#preview-banner:not([hidden])');
    await page.locator('[data-page=todos]').click();
    assert.equal(await lines.count(), 6);
    assert.equal(await page.locator('[data-todo-check]').first().getAttribute('aria-checked'), 'true');
    assert.equal(await lines.last().inputValue(), '<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#todo-rows img').count(), 0, 'List text is never interpreted as HTML');
    await page.locator('#todo-add').click();
    await lines.last().press('Backspace');
    assert.equal(await lines.count(), 6);
    await page.locator('[data-todo-delete]').last().click();
    assert.equal(await lines.count(), 5);
    await fs.mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/todos.png', fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await lines.last().fill('/');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/todos-menu.png', fullPage: true });
    assert.deepEqual(errors, [], 'No renderer or CSP errors');
    console.log('Passed: all six formats, keyboard and mouse selection, completion, safe text, local persistence, deletion, and compact layout.');
  } finally { await app.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
