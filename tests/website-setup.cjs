const { _electron: electron } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ ...(process.env.STILL_TEST_EXECUTABLE ? { executablePath: path.resolve(process.env.STILL_TEST_EXECUTABLE), args: ['--demo', '--test'] } : { args: ['.', '--demo', '--test'] }), env });
  try {
    const result = await application.evaluate(async ({ app, nativeImage, dialog }) => {
      const fs = process.getBuiltinModule('fs').promises, path = process.getBuiltinModule('path'), vm = process.getBuiltinModule('vm');
      const sourceFile = path.join(app.getAppPath(), 'app', 'websites-main.cjs');
      const requireFromApp = process.getBuiltinModule('module').createRequire(sourceFile);
      const module = { exports: {} }, registrations = [], handlers = {};
      const context = {
        module, __dirname: path.dirname(sourceFile), process, Buffer, fetch, AbortSignal,
        require: name => name === 'electron' ? { app, nativeImage, dialog, shell: { openPath: async () => '' } }
          : name === 'node:child_process' ? { execFile: (_file, args, _options, callback) => { registrations.push(args); callback(null, ''); } }
          : requireFromApp(name)
      };
      vm.runInNewContext(await fs.readFile(sourceFile, 'utf8'), context);
      module.exports.setupWebsites({ handle: (name, handler) => { handlers[name] = handler; }, getWindow: () => null });
      const directory = await handlers.websiteSetup();
      const host = JSON.parse(await fs.readFile(path.join(directory, 'native-host.json'), 'utf8'));
      // Simulate an app update: stale companion files are refreshed on the next start, without setup.
      await fs.writeFile(path.join(directory, 'background.js'), 'stale');
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version_name: '0.0.1' }));
      await module.exports.setupWebsites({ handle: () => {}, getWindow: () => null });
      const refreshed = (await fs.readFile(path.join(directory, 'background.js'), 'utf8')) !== 'stale';
      const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
      return { packaged: app.isPackaged, files: await fs.readdir(directory), icons: await fs.readdir(path.join(directory, 'icons')), registrations, host, refreshed, stamp: manifest.version_name, name: manifest.name, version: app.getVersion() };
    });
    for (const file of ['background.js', 'blocked.html', 'blocked.css', 'blocked.js', 'manifest.json', 'websites.js', 'native-host.json']) assert.ok(result.files.includes(file), file);
    for (const file of ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) assert.ok(result.icons.includes(file), `icons/${file}`);
    assert.equal(result.registrations.length, 2);
    assert.match(result.host.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);
    assert.match(result.host.path, /Still Guard\\Still.Guard.exe$/);
    assert.equal(result.host.type, 'stdio');
    assert.ok(result.refreshed, 'companion files are refreshed on start');
    assert.equal(result.stamp, result.version); assert.equal(result.name, 'Still · Website focus');
    console.log(`Browser setup passed (${result.packaged ? 'packaged ASAR' : 'source'}): extracted companion, stable identity, both native-host registrations and refresh after updates. Registry calls were stubbed; live browser settings unchanged.`);
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
