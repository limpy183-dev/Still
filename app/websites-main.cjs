const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { app, dialog, nativeImage, shell } = require('electron');
const Websites = require('./websites.js');
const execute = promisify(execFile);
function setupWebsites({ handle, getWindow }) {
  const cache = new Map();
  async function logo(target) {
    if (!Websites.allowedWebsite(target)) throw Error('Invalid website.');
    const host = target.path.slice(8);
    if (cache.has(host)) return cache.get(host);
    const pending = (async () => {
      const file = path.join(app.getPath('userData'), 'website-icons', host + '.png');
      try { return nativeImage.createFromBuffer(await fs.readFile(file)).toDataURL(); } catch { /* First visit. */ }
      try {
        const response = await fetch('https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(host), { signal: AbortSignal.timeout(5000) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return '';
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > 262144) throw Error('Icon too large.'); chunks.push(chunk); }
        const image = nativeImage.createFromBuffer(Buffer.concat(chunks)); if (image.isEmpty()) return '';
        const small = image.resize({ width: 48, height: 48 });
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, small.toPNG());
        return small.toDataURL();
      } catch { return ''; }
    })();
    cache.set(host, pending); return pending;
  }
  handle('websiteTarget', async value => { const target = Websites.target(value); return { ...target, icon: await logo(target) }; });
  handle('websiteIcons', async targets => {
    if (!Array.isArray(targets) || targets.length > 300) throw Error('Invalid website list.');
    const result = [];
    // Bound concurrent downloads and decode only small cached thumbnails.
    for (let index = 0; index < targets.length; index += 4) result.push(...await Promise.all(targets.slice(index, index + 4).map(async target => ({ ...target, icon: await logo(target) }))));
    return result;
  });
  handle('websiteImage', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: 'Choose a website block-screen image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (result.canceled) return null;
    if ((await fs.stat(result.filePaths[0])).size > 10 * 1024 * 1024) throw Error('Choose an image smaller than 10 MB.');
    const image = nativeImage.createFromBuffer(await fs.readFile(result.filePaths[0]));
    if (image.isEmpty()) throw Error('This image could not be opened. Try a JPG or PNG.');
    const { width, height } = image.getSize();
    for (const max of [1000, 750, 500, 320]) {
      const small = image.resize(width >= height ? { width: Math.min(width, max) } : { height: Math.min(height, max) });
      const uri = 'data:image/jpeg;base64,' + small.toJPEG(75).toString('base64');
      if (uri.length <= 180000) return uri;
    }
    throw Error('Choose a smaller image.');
  });
  const directory = path.join(app.getPath('userData'), 'browser-companion');
  // Store-published companion IDs (npm run build:extension packs it). Add each ID once the store assigns it.
  const storeIds = [];
  async function copyCompanion() {
    await fs.mkdir(path.join(directory, 'icons'), { recursive: true });
    // Copy files individually: Electron's Windows ASAR support cannot recursively cp a directory.
    const source = path.join(__dirname, 'browser-extension');
    await Promise.all(['background.js', 'blocked.html', 'blocked.css', 'blocked.js', ...['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'].map(icon => path.join('icons', icon))].map(file => fs.copyFile(path.join(source, file), path.join(directory, file))));
    await fs.copyFile(path.join(__dirname, 'websites.js'), path.join(directory, 'websites.js'));
    // The manifest goes last: the companion reloads itself once its version_name on disk changes.
    const manifest = { ...JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')), version_name: app.getVersion() };
    await fs.writeFile(path.join(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2));
    await fs.rename(path.join(directory, 'manifest.json.tmp'), path.join(directory, 'manifest.json'));
    // Rewritten on every refresh so an update's new store IDs reach users who set up earlier.
    const id = require('node:crypto').createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    const origins = [id, ...storeIds].map(extension => `chrome-extension://${extension}/`);
    await fs.writeFile(path.join(directory, 'native-host.json'), JSON.stringify({ name: 'app.still.focus', description: 'Still focus sessions', path: path.join(process.env.ProgramFiles, 'Still Guard', 'Still.Guard.exe'), type: 'stdio', allowed_origins: origins }));
  }
  handle('websiteSetup', async () => {
    await copyCompanion();
    const hostFile = path.join(directory, 'native-host.json');
    const reg = path.join(process.env.SystemRoot, 'System32', 'reg.exe');
    for (const browser of ['Google\\Chrome', 'Microsoft\\Edge']) await execute(reg, ['add', `HKCU\\Software\\${browser}\\NativeMessagingHosts\\app.still.focus`, '/ve', '/t', 'REG_SZ', '/d', hostFile, '/f'], { windowsHide: true });
    // With a store listing the folder is only a fallback, so don't pop it open.
    const store = storeIds.length ? `https://chromewebstore.google.com/detail/${storeIds[0]}` : '';
    if (!store) { const error = await shell.openPath(directory); if (error) throw Error(error); }
    return { directory, store };
  });
  // After an update, bring an already set-up companion up to date without asking the user to set it up again.
  return fs.access(directory).then(copyCompanion, () => {}).catch(error => console.warn('Browser companion refresh:', error.message));
}
module.exports = { setupWebsites };
