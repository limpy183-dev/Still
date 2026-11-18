const { _electron: electron } = require('./rust-launch.cjs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Export backup / Import backup: everything Still keeps goes into one zip and comes back from it (preview profile only).
const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows' own tar writes and reads zips

async function run() {
  const app = await electron.launch();
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForSelector('#preview-banner:not([hidden])');
    const call = (name, arg) => page.evaluate(([n, a]) => window.still[n](a), [name, arg]);
    const pick = file => fs.writeFileSync(path.join(app.dataDir, 'test-pick.txt'), file);
    const toast = () => page.locator('#toast');
    const prefs = async () => (await call('bootstrap')).preferences;
    const importWith = async file => {
      pick(file);
      await page.locator('#import-backup').click();
      await page.locator('#confirm-accept').click();
    };
    const reloaded = async () => { await page.waitForTimeout(2200); await page.waitForSelector('#preview-banner:not([hidden])'); await page.locator('[data-page=settings]').click(); };

    // Something to keep: a to-do and a setting, and an alert.
    await call('savePreferences', { todos: [{ text: 'Pack the laptop', type: 'checkbox', done: false }], dailyGoal: 90 });
    const stretch = { title: 'Stretch', note: '', date: '2026-09-23', time: '09:00', repeat: 'daily', lengthMode: 'duration', durationMinutes: 10, endTime: '10:00', style: 'card', blockMode: 'none', apps: [], unlockDelayMinutes: 5, sound: 'chime', volume: 65, enabled: true };
    await call('saveAlert', stretch);
    await page.locator('[data-page=settings]').click();

    // Export writes one zip with the four files.
    const moved = path.join(app.dataDir, 'moved.zip');
    pick(moved);
    await page.locator('#export-backup').click();
    await page.waitForFunction(() => /backup has been saved/.test(document.querySelector('#toast').textContent));
    const entries = execFileSync(bsdtar, ['-tf', moved]).toString().split(/\r?\n/).filter(Boolean);
    for (const name of ['manifest.json', 'preferences.json', 'alerts.json', 'history.json']) assert.ok(entries.includes(name), `${name} is in the backup`);

    // Cancelling the file dialog changes nothing.
    pick('');
    await page.locator('#export-backup').click();
    await page.waitForTimeout(300);

    // Change everything, then bring it back.
    await call('savePreferences', { todos: [], dailyGoal: 30 });
    for (const alert of await call('listAlerts')) await call('deleteAlert', alert.id);
    assert.equal((await prefs()).todos.length, 0);
    assert.equal((await call('listAlerts')).length, 0);
    await importWith(moved);
    await page.waitForFunction(() => /Backup imported: 1 alert, 0 new sessions/.test(document.querySelector('#toast').textContent));
    assert.equal((await prefs()).todos[0].text, 'Pack the laptop');
    assert.equal((await prefs()).dailyGoal, 90);
    assert.equal((await call('listAlerts')).map(a => a.title).join(), 'Stretch');
    assert.ok(fs.existsSync(path.join(app.dataDir, 'before-import.zip')), 'what was here is saved before an import');
    await reloaded();

    // A zip made by another tool, with a finished session in it: the session lands in history, once, and can be deleted.
    const folder = path.join(app.dataDir, 'made-by-hand');
    fs.mkdirSync(folder);
    const write = (name, value) => fs.writeFileSync(path.join(folder, name), JSON.stringify(value));
    write('manifest.json', { app: 'Still', format: 1 });
    write('preferences.json', { todos: [{ text: 'From another PC', type: 'checkbox', done: true }] });
    write('alerts.json', []);
    write('history.json', [{ id: 'restored-1', intention: 'Draft the report', apps: [], startedAt: Date.now() - 7200000, endsAt: Date.now() - 3600000, finishedAt: Date.now() - 3600000, durationMinutes: 60, outcome: 'completed' }, { id: '', startedAt: 1 }]);
    const byHand = path.join(app.dataDir, 'by-hand.zip');
    execFileSync(bsdtar, ['-a', '-c', '-f', byHand, '-C', folder, 'manifest.json', 'preferences.json', 'alerts.json', 'history.json']);
    const restored = async () => (await call('status')).history.filter(s => s.id === 'restored-1');
    await importWith(byHand);
    await page.waitForFunction(() => /Backup imported: 0 alerts, 1 new session\./.test(document.querySelector('#toast').textContent));
    assert.equal((await prefs()).todos[0].text, 'From another PC', 'settings are replaced');
    assert.equal((await call('listAlerts')).length, 0, 'alerts are replaced');
    assert.equal((await restored()).length, 1);
    await reloaded();
    await importWith(byHand);
    await page.waitForFunction(() => /0 alerts, 0 new sessions/.test(document.querySelector('#toast').textContent));
    assert.equal((await restored()).length, 1, 'importing it again adds nothing');
    await page.evaluate(() => window.still.updateHistory('restored-1', 'delete'));
    assert.equal((await restored()).length, 0, 'a restored session can be deleted');
    await reloaded();

    // Not a backup: refused with a clear message and nothing changes.
    const text = path.join(app.dataDir, 'notes.zip');
    fs.writeFileSync(text, 'just some text');
    await importWith(text);
    await page.waitForFunction(() => /not a Still backup/.test(document.querySelector('#toast').textContent));
    assert.match(await toast().getAttribute('class'), /error/);
    assert.equal((await prefs()).todos[0].text, 'From another PC');

    assert.deepEqual(errors, []);
    console.log('backup export/import ok');
  } finally {
    await app.close();
  }
}

run().catch(error => { console.error(error); process.exit(1); });
