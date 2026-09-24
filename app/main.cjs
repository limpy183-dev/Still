const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { allowedApp, validateSession, validatePreferences } = require('./domain.cjs');
const { setupWebsites } = require('./websites-main.cjs');
const { setupAlerts } = require('./alerts-main.cjs');
const { createGuardClient } = require('./guard-client.cjs');
const guardClient = createGuardClient(guard);
const execute = promisify(execFile);
const demo = process.argv.includes('--demo');
if (demo || process.argv.includes('--test')) app.setPath('userData', path.join(app.getPath('temp'), process.argv.includes('--test') ? `Still-test-${process.pid}-${Date.now()}` : 'Still-preview'));
let win, tray, quitting = false, preferences = {}, lastSession, polling = false;
const uiUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
let nativeDir = app.isPackaged ? path.join(process.resourcesPath, 'guard') : path.join(__dirname, '..', 'native');
const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const demoState = { installed: false, session: null, history: [], historyRevision: require('node:crypto').randomUUID(), error: null, demo: true };
function powershell(script, timeout = 45000, input) {
  const result = execute(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (input !== undefined) result.child.stdin.end(input);
  return result;
}
function guard(request, timeout = 120000, attempt = 0) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection('\\\\.\\pipe\\Still.Focus.Guard.v1');
    socket.setEncoding('utf8');
    let data = '', settled = false, connected = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => finish(new Error('Windows protection is not responding. Check the service in Settings.')));
    socket.on('connect', () => { connected = true; socket.write(JSON.stringify(request) + '\n'); });
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 1024 * 1024) return finish(new Error('Invalid protection response.'));
      if (data.includes('\n')) {
        try { const result = JSON.parse(data.split('\n')[0]); finish(result.ok === false ? new Error(result.error) : null, result); }
        catch (error) { finish(error); }
      }
    });
    socket.on('error', error => {
      // Status polling can briefly occupy the pipe while the service creates its next listener.
      // Retry only before connecting; a submitted session request must never be replayed.
      if (!settled && !connected && ['ENOENT', 'EBUSY'].includes(error.code) && attempt < 10) {
        settled = true; socket.destroy();
        setTimeout(() => resolve(guard(request, timeout, attempt + 1)), 100);
      } else finish(error);
    });
    socket.on('end', () => { if (!settled) finish(new Error('Windows protection disconnected.')); });
  });
}
function finishDemo(outcome) {
  demoState.history.unshift({ ...demoState.session, finishedAt: Date.now(), outcome });
  demoState.historyRevision = require('node:crypto').randomUUID();
  demoState.session = null;
}
async function status(full = false) {
  if (demo) {
    if (demoState.session && Date.now() >= demoState.session.endsAt) finishDemo('completed');
    return { ...demoState, now: Date.now() };
  }
  try { return await guardClient.status(full); }
  catch (error) {
    return { installed: false, session: null, history: [], unavailable: true, error: ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? null : error.message, now: Date.now() };
  }
}
async function elevate(command) {
  guardClient.invalidate();
  if (demo) { demoState.installed = command === 'install'; return status(); }
  let file;
  if (command === 'install') file = app.isPackaged ? path.join(nativeDir, 'Still.Guard.exe') : path.join(nativeDir, 'bin', 'Still.Guard.exe');
  else file = path.join(process.env.ProgramFiles, 'Still Guard', 'Still.Guard.exe');
  await fs.access(file);
  if (!app.isPackaged && command === 'install') await fs.copyFile(path.join(nativeDir, 'policy.ps1'), path.join(nativeDir, 'bin', 'policy.ps1'));
  const args = command === 'install' ? "@('--install', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)" : "@('--uninstall')";
  const script = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath '${file.replaceAll("'", "''")}' -ArgumentList ${args} -Verb RunAs -WindowStyle Hidden -PassThru -Wait; if ($p.ExitCode -ne 0) { throw 'Protection setup did not finish. Check the Windows message and try again.' } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  try { await powershell(script, 180000); }
  catch (error) { throw new Error(error.stderr?.trim() || 'Windows administrator permission was cancelled or setup failed.'); }
  finally { guardClient.invalidate(); }
  for (let attempt = 0; command === 'install' && attempt < 15; attempt++) {
    const result = await status(); if (result.installed) return result;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return status();
}
async function enrich(apps) {
  const targets = apps.filter(allowedApp);
  // Preferences deliberately save identities only. Resolve installed assets again on startup.
  const installed = targets.some(a => !a.iconPaths && !a.iconFiles)
    ? await discoverApps(false, targets.filter(a => !a.path.startsWith('appx:')).map(a => a.path)).catch(() => []) : [];
  const sources = new Map(installed.map(a => [a.path.toLowerCase(), a]));
  return Promise.all(targets.map(async target => {
    const { iconPaths, iconFiles, nativeIcon, icon: oldIcon, ...result } = target;
    const source = sources.get(target.path.toLowerCase());
    if (target.path.startsWith('appx:')) {
      result.category = 'Microsoft Store app';
      for (const file of iconPaths || source?.iconPaths || []) {
        try {
          const image = nativeImage.createFromBuffer(await fs.readFile(file));
          if (!image.isEmpty()) {
            const { width, height } = image.getSize();
            return { ...result, icon: image.resize(width >= height ? { width: 48 } : { height: 48 }).toDataURL() };
          }
        } catch { /* Try the next installed logo if an asset is missing or unreadable. */ }
      }
    }
    if (nativeIcon || source?.nativeIcon) return { ...result, icon: nativeIcon || source.nativeIcon };
    // Sparse Store registrations can omit artwork that the desktop executable supplies.
    const desktop = target.path.startsWith('appx:')
      ? [...targets, ...installed].find(a => !a.path.startsWith('appx:') && a.name.toLowerCase() === target.name.toLowerCase()) : target;
    const files = [...(iconFiles || source?.iconFiles || []), ...(desktop ? [desktop.path] : [])];
    for (const file of new Set(files)) {
      try { await fs.access(file); } catch { continue; }
      for (const size of ['large', 'normal', 'small']) {
        try {
          const image = await app.getFileIcon(file, { size });
          if (!image.isEmpty()) return { ...result, icon: image.toDataURL() };
        } catch { /* Keep a visible fallback if Windows cannot supply an icon. */ }
      }
    }
    return result;
  }));
}
async function discoverApps(storeOnly = false, executables = []) {
  // Read from the bundle: portable builds may not extract resource-side scripts.
  let script;
  for (const candidate of [path.join(__dirname, 'discover.ps1'), path.join(__dirname, '..', 'native', 'discover.ps1'), path.join(nativeDir, 'discover.ps1')]) {
    try { script = await fs.readFile(candidate, 'utf8'); break; } catch { /* try the next bundled location */ }
  }
  if (!script) throw new Error('The application discovery script is unavailable. You can still browse for an executable.');
  // Send identities over stdin so large libraries do not exceed Windows' command-line limit.
  const { stdout } = await powershell(`[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & { ${script}\n } -StoreOnly:$${storeOnly ? 'true' : 'false'} -Executables @(ConvertFrom-Json ([Console]::In.ReadToEnd()))`, 45000, JSON.stringify(executables));
  let apps; try { apps = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); } catch { throw new Error('Could not read the application list. You can still browse for an executable.'); }
  return (Array.isArray(apps) ? apps : [apps]).slice(0, 300);
}
function trusted(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) throw new Error('Untrusted request.');
}
function handle(name, handler) {
  ipcMain.handle(name, async (event, ...args) => { trusted(event); return handler(...args); });
}
let loginSettings;
function reconcileLoginSettings() {
  if (!app.isPackaged || demo || process.argv.includes('--test')) return;
  const next = { openAtLogin: preferences.launchAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath };
  if (loginSettings?.openAtLogin === next.openAtLogin && loginSettings.path === next.path) return;
  app.setLoginItemSettings(next);
  loginSettings = next;
}
async function savePreferences(value) {
  preferences = validatePreferences(value);
  const file = path.join(app.getPath('userData'), 'preferences.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(preferences, null, 2));
  await fs.rename(file + '.tmp', file);
  reconcileLoginSettings();
  return preferences;
}
function registerHandlers() {
  setupWebsites({ handle, getWindow: () => win });
  handle('bootstrap', async () => {
    const current = await status(true);
    return { ...current, preferences, apps: preferences.apps || [], version: app.getVersion() };
  });
  handle('appIcons', () => enrich(preferences.apps || []));
  handle('showWindow', showWindow);
  handle('status', status);
  handle('updateHistory', async (id, action) => {
    if (typeof id !== 'string' || !id || id.length > 100 || !['archive', 'restore', 'delete'].includes(action)) throw new Error('Invalid history action.');
    if (!demo) {
      try { return await guardClient.mutate({ command: 'updateHistory', id, action }); }
      catch (error) {
        if (error.message !== 'Unknown command.') throw error;
        const current = await status();
        if (current.unavailable || current.session) throw new Error('Finish your current session, then try again to update Windows protection for session management.');
        await elevate('install');
        return guardClient.mutate({ command: 'updateHistory', id, action });
      }
    }
    guardClient.invalidate();
    const record = demoState.history.find(s => s.id === id);
    if (!record) throw new Error('Saved session not found.');
    if (action === 'delete') demoState.history = demoState.history.filter(s => s.id !== id);
    else record.archived = action === 'archive';
    demoState.historyRevision = require('node:crypto').randomUUID();
    return status();
  });
  handle('savePreferences', savePreferences);
  handle('install', () => elevate('install'));
  handle('uninstall', async () => { const s = await status(); if (s.session) throw new Error('Finish your session before removing protection.'); return elevate('uninstall'); });
  handle('discover', async () => enrich(await discoverApps()));
  handle('browse', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Choose apps or games to block', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Windows applications', extensions: ['exe'] }] });
    if (result.canceled) return [];
    const apps = result.filePaths.map(file => ({ name: path.basename(file, '.exe'), path: file }));
    if (apps.some(a => !allowedApp(a))) throw new Error('Windows components and Still cannot be blocked. Choose a desktop app or game.');
    return enrich(apps);
  });
  handle('start', startSession);
  for (const command of ['requestUnlock', 'cancelUnlock', 'end']) handle(command, async () => {
    if (!demo) return guardClient.mutate({ command });
    guardClient.invalidate();
    const s = demoState.session;
    if (!s) throw new Error('No active session.');
    if (command === 'requestUnlock' && !s.unlockAt) s.unlockAt = Date.now() + s.unlockDelayMinutes * 60000;
    if (command === 'cancelUnlock') s.unlockAt = 0;
    if (command === 'end') {
      if (s.unlockDelayMinutes > 0 && (!s.unlockAt || Date.now() < s.unlockAt)) throw new Error('The release waiting period has not finished.');
      finishDemo('ended-early');
    }
    return status();
  });
  handle('window', action => { if (action === 'minimize') win.minimize(); else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (action === 'close') win.close(); });
  handle('exportHistory', async () => {
    const current = await status(true);
    if (current.unavailable) throw new Error('Reconnect Windows protection before exporting your saved history.');
    const result = await dialog.showSaveDialog(win, { defaultPath: 'Still-sessions.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled) { await fs.writeFile(result.filePath, JSON.stringify(current.history, null, 2)); return true; }
    return false;
  });
}
async function snoozeSession(id) {
  if (!demo) return guardClient.mutate({ command: 'snooze', id });
  guardClient.invalidate();
  if (demoState.session?.id === id) {
    if (!demoState.session.scheduledEndsAt) throw Error('Only an alarm session can be snoozed.');
    finishDemo('snoozed');
  }
  return status();
}
async function startSession(request, scheduled = false) {
    guardClient.invalidate();
    const value = validateSession(request);
    if (scheduled) {
      if (!Number.isSafeInteger(request.scheduledEndsAt) || request.scheduledEndsAt <= Date.now() || request.scheduledEndsAt > Date.now() + 90000000) throw Error('The scheduled focus window has ended or is too long.');
      value.scheduledEndsAt = request.scheduledEndsAt;
    }
    if (!demo) {
      // Scheduled alerts never trigger an unattended administrator prompt.
      if (scheduled) return guardClient.mutate({ ...value, command: 'start' });
      const installedDir = path.join(process.env.ProgramFiles, 'Still Guard');
      const files = ['policy.ps1', 'Still.Guard.exe'];
      const current = await Promise.all(files.map(async file => {
        const bundled = path.join(nativeDir, !app.isPackaged && file.endsWith('.exe') ? 'bin' : '', file);
        try { return (await fs.readFile(bundled)).equals(await fs.readFile(path.join(installedDir, file))); }
        catch { return false; }
      }));
      if (current.includes(false)) await elevate('install');
      return guardClient.mutate({ ...value, command: 'start' });
    }
    if (!demoState.installed) throw new Error('Enable preview protection first.');
    if (demoState.session) throw new Error('A session is already running.');
    demoState.session = { ...value, id: require('node:crypto').randomUUID(), startedAt: Date.now(), endsAt: value.scheduledEndsAt || Date.now() + value.durationMinutes * 60000, unlockAt: 0, phase: 'active' };
    return status();
}
async function showWindow() {
  if (!win || win.isDestroyed()) return;
  // Show immediately; the show/restore events refresh the existing document.
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function makeWindow() {
  win = new BrowserWindow({ width: 1350, height: 900, minWidth: 980, minHeight: 720, frame: false, backgroundColor: '#f6f7f2', icon: path.join(__dirname, '..', 'assets', 'still.ico'), show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('close', event => { if (!quitting && tray) { event.preventDefault(); win.hide(); } });
  for (const event of ['hide', 'minimize']) win.on(event, () => win.webContents.send('presentation-visible', false));
  for (const event of ['show', 'restore']) win.on(event, () => win.webContents.send('presentation-visible', true));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    try { preferences = validatePreferences(JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'))); } catch { preferences = validatePreferences({}); }
    try { reconcileLoginSettings(); } catch (error) { console.warn('Sign-in settings:', error.message); }
    if (app.isPackaged) {
      const cachedDir = path.join(app.getPath('userData'), 'guard');
      try {
        await fs.mkdir(cachedDir, { recursive: true });
        await Promise.all(['Still.Guard.exe', 'policy.ps1'].map(file => fs.copyFile(path.join(nativeDir, file), path.join(cachedDir, file))));
        nativeDir = cachedDir;
      } catch (error) { console.warn('Could not retain Windows protection files:', error); }
    }
    app.setAppUserModelId('app.still.focus');
    if (app.isPackaged && !demo && !process.argv.includes('--test')) {
      // Portable builds have no installer to register their Windows notification identity.
      const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
      try {
        await fs.mkdir(programs, { recursive: true });
        const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        if (!shell.writeShortcutLink(path.join(programs, 'Still Focus.lnk'), { target, cwd: path.dirname(target), appUserModelId: 'app.still.focus', toastActivatorClsid: '2BB3B6B9-632E-4618-9488-990BD152DD54', description: 'Still — a space for focus' })) throw Error('Windows could not create the Still notification shortcut.');
      } catch (error) { console.warn('Notification registration:', error.message); }
    }
    registerHandlers();
    await setupAlerts({ handle, getWindow: () => win, showWindow, getPreferences: () => preferences, status, getStatusGeneration: () => guardClient.generation, start: request => startSession(request, true), snooze: snoozeSession, prepare: async () => {
      let current = await status();
      if (current.installed && !current.unavailable && (current.demo || (current.scheduledAlerts && current.snoozeAlerts && current.websiteBlocking))) return;
      if (current.session) throw Error('Finish your current focus session before updating Windows protection for alerts.');
      current = await elevate('install');
      if (!current.installed || current.unavailable || (!current.demo && (!current.scheduledAlerts || !current.snoozeAlerts || !current.websiteBlocking))) throw Error('Scheduled app blocking is not ready. Prepare / update app blocking and try saving again.');
    } });
    makeWindow();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'still.ico')));
    tray.setToolTip('Still · Make room for focus');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Still', click: showWindow }, { type: 'separator' }, { label: 'Quit Still (alerts stop; active protection continues)', click: () => { quitting = true; app.quit(); } }]));
    tray.on('double-click', showWindow);
    let sentHistoryRevision;
    setInterval(async () => {
      if (polling) return; polling = true;
      try {
        const current = await status();
        if (!current.unavailable) {
          if (lastSession && !current.session && preferences.notifications && Notification.isSupported()) new Notification({ title: 'A little more space. Well done.', body: 'Your focus session has ended. Your apps and websites are available again.' }).show();
          lastSession = current.session;
        }
        if (win && !win.isDestroyed()) {
          const { history, ...live } = current;
          win.webContents.send('guard-status', current.historyRevision && current.historyRevision === sentHistoryRevision ? live : current);
          sentHistoryRevision = current.unavailable ? undefined : current.historyRevision;
        }
      } finally { polling = false; }
    }, 2000).unref();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {});
}
