const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ ...(process.env.STILL_EXECUTABLE ? { executablePath: process.env.STILL_EXECUTABLE, args: ['--demo', '--test'] } : { args: ['.', '--demo', '--test'] }), env });
  try {
    const window = await application.firstWindow();
    const errors = []; window.on('pageerror', error => errors.push(error.message));
    await window.waitForFunction(() => document.querySelector('#alert-add').onclick && typeof presentationVisible !== 'undefined');
    await window.evaluate(() => {
      window.optimizationMutations = { alerts: 0, timer: 0, chart: 0 };
      for (const [name, id] of [['alerts', 'alerts-list'], ['timer', 'timer-number'], ['chart', 'progress-chart']])
        new MutationObserver(items => { window.optimizationMutations[name] += items.length; }).observe(document.getElementById(id), { childList: true });
    });
    await window.waitForTimeout(10000);
    const mutations = await window.evaluate(() => window.optimizationMutations);
    assert.deepEqual(mutations, { alerts: 0, timer: 0, chart: 0 }, 'unchanged UI must retain its DOM');
    const benchmarks = await window.evaluate(() => {
      const original = { ...state }, originalAlerts = alerts;
      const history = Array.from({ length: 500 }, (_, i) => ({ id: 'sample-' + i, intention: 'Example focus', startedAt: Date.now() - (i + 1) * 86400000, endsAt: Date.now() - (i + 1) * 86400000 + 1800000, finishedAt: Date.now() - (i + 1) * 86400000 + 1800000, durationMinutes: 30, outcome: 'completed', apps: [{ name: 'Example', path: 'C:\\Example\\Game.exe' }] }));
      alerts = Array.from({ length: 100 }, (_, i) => ({ id: 'alert-' + i, title: 'Example alert', date: '2099-01-01', time: '09:00', repeat: 'daily', durationMinutes: 20, style: 'card', blockMode: 'none', apps: [], enabled: true, nextAt: Date.now() + 86400000 }));
      const full = { installed: true, session: null, history, historyRevision: 'synthetic', error: null, now: Date.now() };
      applyStatus(full);
      const { history: _, ...compact } = full;
      const times = []; for (let i = 0; i < 25; i++) { const start = performance.now(); applyStatus(compact); times.push(performance.now() - start); }
      times.sort((a, b) => a - b);
      const result = { medianUnchangedStatusMs: times[12], fullBytes: new TextEncoder().encode(JSON.stringify(full)).length, compactBytes: new TextEncoder().encode(JSON.stringify(compact)).length };
      alerts = originalAlerts; applyStatus(original); return result;
    });
    await window.locator('[data-page="alerts"]').click();
    await window.locator('#alert-add').click();
    await window.locator('#alert-title').fill('Keep this unfinished edit');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await window.waitForFunction(() => !presentationVisible);
    await window.evaluate(() => {
      window.restoreStatus = { ...state };
      applyStatus({ ...state, historyRevision: 'hidden-change', history: [{ id: 'hidden', intention: 'Hidden completion', startedAt: Date.now() - 60000, endsAt: Date.now(), finishedAt: Date.now(), outcome: 'completed', apps: [] }] });
    });
    assert.equal(await window.evaluate(() => state.history[0].id), 'hidden', 'hidden status is still processed');
    await window.evaluate(() => window.still.showWindow());
    assert.equal(await window.locator('#alert-title').inputValue(), 'Keep this unfinished edit');
    assert.equal(await window.locator('#alert-dialog').evaluate(el => el.open), true);
    await window.evaluate(() => { document.querySelector('#alert-dialog').close(); applyStatus(window.restoreStatus); showPage('focus'); });
    await window.evaluate(() => {
      const original = { ...state };
      const start = Date.now();
      applyStatus({ ...state, now: start, session: { id: 'countdown', startedAt: start, endsAt: start + 60000, durationMinutes: 1, unlockDelayMinutes: 1, unlockAt: start + 5000, phase: 'active', apps: [] } });
      if (!document.querySelector('#start-button').disabled) throw Error('Release must remain locked');
      offset += 6000; updateTimer();
      if (document.querySelector('#start-button').disabled) throw Error('Release deadline must update');
      applyStatus({ ...original, now: Date.now() });
      showPage('history'); if (!document.querySelector('#progress-chart').children.length) throw Error('Progress must render on entry');
    });
    assert.deepEqual(errors, []);
    const report = { mutationsInTenSeconds: mutations, ...benchmarks };
    await fs.writeFile('test-results/optimization-checks.json', JSON.stringify(report, null, 2));
    console.log('Passed: unchanged DOM, compact history, hidden-state processing, restored edits, release countdown, visible charts. ' + JSON.stringify(report));
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
