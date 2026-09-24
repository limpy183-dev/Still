const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/main.cjs'), 'utf8');

test('icons resolve shortcuts, Store artwork/executables, browsed apps, and saved identities', async () => {
  const desktop = { name: 'Custom', path: 'C:\\Apps\\custom.exe', iconFiles: ['missing.lnk', 'custom.lnk'] };
  const store = { name: 'Store', path: 'appx:Store_abc', iconPaths: ['broken.png', 'wide.png'], iconFiles: ['store.exe'] };
  const sparse = { name: 'Sparse', path: 'appx:Sparse_abc', iconPaths: [], iconFiles: ['sparse.exe'] };
  const portable = { name: 'Portable', path: 'C:\\Portable\\app.exe' };
  const calls = [], sizes = [];
  let discoveries = 0;
  const context = vm.createContext({
    allowedApp: require('../app/domain.cjs').allowedApp,
    discoverApps: async () => { discoveries++; return [desktop, store, sparse]; },
    fs: {
      access: async file => { if (file === 'missing.lnk') throw Error('gone'); },
      readFile: async file => { if (file === 'broken.png') throw Error('bad asset'); return file; }
    },
    nativeImage: { createFromBuffer: () => ({
      isEmpty: () => false, getSize: () => ({ width: 100, height: 50 }),
      resize: options => { sizes.push(options); return { toDataURL: () => 'data:image/png;wide' }; }
    }) },
    app: { getFileIcon: async (file, { size }) => {
      calls.push([file, size]);
      if (file === 'sparse.exe' && size === 'large') throw Error('size unavailable');
      return { isEmpty: () => false, toDataURL: () => `data:image/png;${file}` };
    } }
  });
  vm.runInContext(source.slice(source.indexOf('async function enrich('), source.indexOf('async function discoverApps(')), context);
  const discovered = await context.enrich([desktop, store, sparse]);
  assert.equal(discoveries, 0, 'fresh discovery reuses its sources');
  assert.equal(discovered[0].icon, 'data:image/png;custom.lnk', 'custom shortcut wins over executable');
  assert.equal(discovered[1].icon, 'data:image/png;wide');
  assert.equal(JSON.stringify(sizes[0]), '{"width":48}', 'artwork keeps its aspect ratio');
  assert.equal(discovered[2].icon, 'data:image/png;sparse.exe', 'Store executable works without desktop duplicate');
  assert.ok(calls.some(([file, size]) => file === 'sparse.exe' && size === 'normal'));
  assert.ok(!calls.some(([file]) => file === 'missing.lnk'));
  const restored = await context.enrich([desktop, store, sparse, portable].map(({ name, path }) => ({ name, path })));
  assert.equal(discoveries, 1, 'one discovery restores all app types');
  assert.deepEqual(restored.slice(0, 3).map(a => a.icon), discovered.map(a => a.icon));
  assert.equal(restored[3].icon, `data:image/png;${portable.path}`);
  assert.ok(restored.every(a => !('iconFiles' in a) && !('iconPaths' in a) && !('nativeIcon' in a)));
  desktop.nativeIcon = 'data:image/png;resource';
  assert.equal((await context.enrich([desktop]))[0].icon, desktop.nativeIcon, 'extracted artwork wins over generic shell icons');
  assert.equal((await context.enrich([{ name: desktop.name, path: desktop.path }]))[0].icon, desktop.nativeIcon);
  context.discoverApps = async () => { throw Error('discovery unavailable'); };
  assert.equal((await context.enrich([portable]))[0].icon, `data:image/png;${portable.path}`);
  context.app.getFileIcon = async () => { throw Error('no icon'); };
  assert.equal((await context.enrich([portable]))[0].icon, undefined, 'unavailable icon leaves renderer fallback');
});

test('Windows extracts ICO and indexed executable resources, skipping unavailable artwork', { skip: process.platform !== 'win32' }, () => {
  const path = require('node:path');
  const script = fs.readFileSync(path.resolve('native/discover.ps1'), 'utf8').split('$items = @{}')[0];
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const icon = path.resolve('assets/still.ico');
  const exe = path.resolve('node_modules/electron/dist/electron.exe');
  const command = `${script}\n@((Get-ResourceIcon @('missing.ico', ${quote('"' + icon + '",0')})), (Get-ResourceIcon @(${quote(exe + ',99999')}, ${quote(exe + ',0')}))) | ConvertTo-Json -Compress`;
  const result = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  const icons = JSON.parse(result);
  assert.equal(icons.length, 2);
  for (const value of icons) assert.ok(value.startsWith('data:image/png;base64,iVBOR'), 'native artwork is encoded as PNG');
});
