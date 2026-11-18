const assert = require('node:assert/strict');
const { launch } = require('./rust-launch.cjs');

async function run() {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#preview-banner:not([hidden])');
    const cdp = await app.context.newCDPSession(page);
    const sidebar = page.locator('.sidebar');
    const main = page.locator('main');
    const scrollTop = pane => pane.evaluate(el => el.scrollTop);
    const gesture = async (pane, xDistance, yDistance) => {
      const box = await pane.boundingBox();
      await cdp.send('Input.synthesizeScrollGesture', {
        x: box.x + 12, y: box.y + 20, xDistance, yDistance,
        gestureSourceType: 'mouse', speed: 1800, preventFling: true
      });
    };
    const checkWindow = async () => {
      const position = await page.locator('.titlebar').boundingBox();
      assert.equal(position.x, 0);
      assert.equal(position.y, 0);
      assert.deepEqual(await page.evaluate(() => [scrollX, scrollY, visualViewport.offsetLeft, visualViewport.offsetTop]), [0, 0, 0, 0]);
    };

    // Drag diagonally past the top edge on initial load.
    await gesture(main, -240, 240);
    await checkWindow();
    assert.equal(await scrollTop(main), 0);

    for (const height of [480, 760]) {
      await app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0].setContentSize(1000, h), height);
      await page.waitForFunction(h => Math.abs(innerHeight - h) <= 2, height);
      await gesture(main, 0, -180);
      const mainOffset = await scrollTop(main);
      assert.ok(mainOffset > 0, 'Main content scrolls under the pointer');
      const sidebarMax = await sidebar.evaluate(el => el.scrollHeight - el.clientHeight);
      assert.equal(sidebarMax > 0, height === 480, 'Exercise both an overflowing and a fitting sidebar');
      await gesture(sidebar, 0, -500);
      assert.ok(Math.abs(await scrollTop(sidebar) - sidebarMax) < 1, 'Sidebar reaches its bottom at fractional display scaling');
      await gesture(sidebar, -180, -160);
      assert.equal(await scrollTop(main), mainOffset, 'Scrolling past the sidebar bottom stays in the sidebar');
      await gesture(sidebar, 0, 500);
      await gesture(sidebar, 180, 160);
      assert.equal(await scrollTop(sidebar), 0);
      assert.equal(await scrollTop(main), mainOffset, 'Scrolling past the sidebar top stays in the sidebar');
      await checkWindow();
      await page.locator('[data-page="library"]').click();
      assert.equal(await scrollTop(main), 0, 'Navigation opens the new page at the top');
      await page.locator('[data-page="focus"]').click();
    }
    console.log('Window and pane scrolling checks passed');
  } finally {
    await app.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
