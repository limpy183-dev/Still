// Captures test-results/progress.png: the progress page's calendar and "Where your attention went"
// in demo mode, with a month of sample sessions.
// Demo history lives in the main process, so the sample is shown in the window only and never saved.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

// [days ago, start hour, minutes, intention, outcome]. Two spellings of "Revise chemistry" show as one task.
const SAMPLE = [
  [27, 9, 50, 'Revise chemistry'], [27, 14, 25, 'Read two chapters'], [26, 10, 50, 'Essay: first draft'],
  [24, 9, 90, 'Essay: first draft'], [23, 16, 25, 'Practise piano'], [22, 9, 50, 'Revise Chemistry'],
  [20, 11, 50, 'Plan the week'], [19, 9, 50, 'Essay: first draft', 'ended-early'], [17, 15, 25, 'Practise piano'],
  [16, 9, 90, 'Revise chemistry'], [15, 10, 50, 'Read two chapters'], [13, 9, 50, 'Essay: first draft'],
  [12, 14, 25, 'Practise piano'], [10, 9, 50, 'Revise chemistry'], [9, 13, 50, 'Plan the week'],
  [8, 9, 90, 'Essay: first draft'], [6, 10, 25, 'Read two chapters'], [5, 9, 50, 'Revise chemistry'],
  [5, 15, 25, 'Practise piano'], [3, 9, 90, 'Essay: first draft'], [2, 10, 50, 'Revise chemistry', 'ended-early'],
  [1, 9, 50, 'Read two chapters'], [1, 16, 25, 'Practise piano'], [0, 9, 50, 'Revise chemistry']
];

async function run() {
  await fs.mkdir('test-results', { recursive: true });
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: ['.', '--demo', '--test'], env: environment, timeout: 60000 });
  const window = await application.firstWindow();
  try {
    await window.waitForSelector('#preview-banner:not([hidden])');
    await window.evaluate(() => document.fonts.ready);
    await window.locator('[data-page="history"]').click();
    await window.evaluate(sample => {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      state.history = sample.map(([ago, hour, minutes, intention, outcome = 'completed'], i) => {
        const start = new Date(today); start.setDate(start.getDate() - ago); start.setHours(hour);
        const endsAt = +start + minutes * 60000;
        return { id: 'sample-' + i, intention, durationMinutes: minutes, unlockDelayMinutes: 5, apps: [], startedAt: +start, endsAt,
          finishedAt: outcome === 'completed' ? endsAt : +start + Math.round(minutes * 0.6) * 60000, unlockAt: 0, phase: 'active', outcome };
      }).filter(record => record.finishedAt <= Date.now()).sort((a, b) => b.startedAt - a.startedAt);
      // Kept in memory only, like the sample history.
      prefs.intentionColors = { 'Essay: first draft': 'moss', 'Revise chemistry': 'sand', 'Read two chapters': 'sage', 'Practise piano': 'lime', 'Plan the week': 'clay' };
      renderStats(); renderProgress(); renderHistoryList();
    }, SAMPLE);
    assert.equal(await window.locator('.attention-row', { hasText: 'Revise' }).count(), 1, 'Both spellings share one row');
    await window.waitForTimeout(800);
    // Grow the window so the whole section is on screen, then capture it with a margin.
    const height = await window.evaluate(() => document.documentElement.scrollHeight);
    await application.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setContentSize(1690, height), height);
    await window.waitForFunction(height => innerHeight >= height - 2, height);
    await window.waitForTimeout(300);
    const box = await window.locator('#progress-intentions').locator('..').boundingBox(), margin = 24;
    await window.screenshot({ path: 'test-results/progress.png', clip: { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin + 8 } });
    console.log('Saved test-results/progress.png');
  } finally {
    await application.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
