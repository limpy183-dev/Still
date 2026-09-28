// Playwright's fullPage capture renders past the window, where the fixed sidebar doesn't reach.
// Grow the window to the page height instead, capture it, then put the window back.
module.exports = async function screenshot(application, window, file) {
  const size = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
  const height = await window.evaluate(() => document.documentElement.scrollHeight);
  const resize = target => application.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setContentSize(...target), target);
  await resize([size[0], Math.max(size[1], height)]);
  await window.waitForFunction(height => innerHeight >= height - 2, height);
  await window.waitForTimeout(150);
  await window.screenshot({ path: file });
  await resize(size);
  await window.waitForFunction(height => Math.abs(innerHeight - height) <= 2, size[1]);
};
