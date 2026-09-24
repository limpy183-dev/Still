const { app, BrowserWindow, Notification, dialog, screen, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { validateAlert, dueOccurrence, nextOccurrence, MEDIA_FILE } = require('./alert-domain.cjs');
const { validateSession, sameFileUrl } = require('./domain.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'still-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

async function setupAlerts({ handle, getWindow, showWindow, getPreferences, status, getStatusGeneration = () => 0, start, snooze, prepare }) {
  const directory = path.join(app.getPath('userData'), 'alert-media');
  const store = path.join(app.getPath('userData'), 'alerts.json');
  await fs.mkdir(directory, { recursive: true });
  let records = [], queue = Promise.resolve(), ticking = false, active = null, presentations = [];
  try {
    const saved = JSON.parse(await fs.readFile(store, 'utf8'));
    if (!Array.isArray(saved)) throw Error('Invalid alerts file.');
    records = saved.slice(0, 100).map(record => ({ ...record, ...validateAlert(record) }));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Retain malformed data for recovery instead of silently overwriting it.
      await fs.copyFile(store, store + '.recovery-' + Date.now());
      console.warn('Saved alerts could not be loaded. A recovery copy was retained.', error);
    }
  }
  const list = () => records.map(record => {
    const next = Math.min(record.snoozeAt || Infinity, nextOccurrence(record, Date.now()) || Infinity);
    return { ...record, nextAt: record.enabled && Number.isFinite(next) ? next : null,
      ringing: active?.item.alert.id === record.id && !active.item.preview,
      queued: presentations.some(item => item.alert.id === record.id && !item.preview)
    };
  });
  let committedRecords = structuredClone(records);
  const notify = () => { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('alerts-changed', list()); };
  async function persist(next = records) {
    try {
      await fs.writeFile(store + '.tmp', JSON.stringify(next, null, 2));
      await fs.rename(store + '.tmp', store);
      records = next; committedRecords = structuredClone(next); notify();
    } catch (error) { records = structuredClone(committedRecords); throw error; }
  }
  function serial(action) { const result = queue.then(action); queue = result.catch(error => console.warn('Alert operation failed:', error.message)); return result; }
  protocol.handle('still-media', async request => {
    const url = new URL(request.url), file = url.pathname.slice(1);
    if (url.hostname !== 'local' || !MEDIA_FILE.test(file)) return new Response('Not found', { status: 404 });
    try { return await net.fetch(pathToFileURL(path.join(directory, file)).href, { headers: request.headers }); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  const alarmUrl = pathToFileURL(path.join(__dirname, 'alarm.html')).href;
  function sendAlarmStatus(text) {
    if (!active) return;
    active.item.message = text;
    for (const window of active.windows) if (!window.isDestroyed()) window.webContents.send('alarm-message', text);
  }
  function closePresentation() {
    if (!active) return;
    const previous = active; active = null;
    clearTimeout(previous.timeout);
    previous.notification?.close();
    for (const window of previous.windows) if (!window.isDestroyed()) window.destroy();
    notify();
    setTimeout(showNext, 150);
  }
  function showNext() {
    if (active || !presentations.length) return;
    const item = presentations.shift();
    if (!item.preview) item.message = item.occurrence.end <= Date.now() ? 'This focus window has ended. This is a reminder only; scheduled blocking has ended.' : records.find(record => record.id === item.alert.id)?.lastResult || item.message;
    const current = active = { item, windows: [] };
    notify();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const quiet = item.alert.style === 'notification';
    const silent = quiet && (item.alert.sound === 'silent' || item.alert.volume === 0);
    const displays = silent ? [] : item.alert.style === 'full' ? screen.getAllDisplays() : [display];
    for (const [index, target] of displays.entries()) {
      const area = target.workArea;
      const window = new BrowserWindow({
        ...(item.alert.style === 'full' ? target.bounds : { x: area.x + Math.max(0, area.width - 460 - 16), y: area.y + Math.max(0, area.height - 610 - 16), width: Math.min(460, area.width), height: Math.min(610, area.height) }),
        frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
        backgroundColor: '#f5f6f1', webPreferences: { preload: path.join(__dirname, 'alarm-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false }
      });
      current.windows.push(window);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.on('close', event => { event.preventDefault(); closePresentation(); });
      window.webContents.once('did-finish-load', () => {
        window.webContents.send('alarm-data', { ...item, audible: index === 0, reducedMotion: getPreferences().reducedMotion });
        if (!quiet) { if (item.alert.style === 'full') window.setFullScreen(true); if (item.alert.onTop === false) window.showInactive(); else { window.setAlwaysOnTop(true, 'screen-saver'); window.show(); window.focus(); } }
      });
      window.loadURL(alarmUrl);
    }
    if (quiet && Notification.isSupported()) {
      current.notification = new Notification({ title: item.preview ? `Preview · ${item.alert.title}` : item.alert.title, body: [item.alert.note, item.message].filter(Boolean).join('\n'), silent: true, icon: path.join(__dirname, '..', 'assets', 'still.ico') });
      current.notification.on('click', () => { showWindow(); if (active === current) closePresentation(); });
      current.notification.on('close', () => { if (active === current) closePresentation(); });
      current.notification.on('failed', (_event, error) => { console.warn('Notification failed:', error); getWindow().webContents.send('alert-error', 'Windows could not show the notification. Check Windows notification settings.'); closePresentation(); });
      current.notification.show();
    } else if (quiet) getWindow().webContents.send('alert-error', 'Notifications are unavailable on this computer. Choose a focus card or full-screen alarm.');
    current.timeout = setTimeout(() => { if (active === current) closePresentation(); }, quiet ? 10000 : 5 * 60000);
  }
  function present(alert, occurrence, message, preview = false) {
    if (preview && presentations.length >= 10) throw Error('Close an alarm preview before opening another.');
    presentations.push({ alert: { ...alert }, occurrence, message, preview }); showNext();
  }
  function trustedAlarm(event) {
    if (!active?.windows.some(window => window.webContents === event.sender) || event.senderFrame !== event.sender.mainFrame || !sameFileUrl(event.senderFrame.url, alarmUrl)) throw Error('Untrusted alarm request.');
  }
  ipcMain.handle('alarm-action', async (event, action) => {
    trustedAlarm(event);
    const presentation = active;
    if (!['dismiss', 'snooze', 'open'].includes(action)) throw Error('Unknown alarm action.');
    if (action === 'dismiss' && !presentation.item.preview && presentation.item.alert.showDismiss === false) throw Error('Dismiss is hidden for this alarm.');
    if (action === 'snooze' && !active.item.preview) {
      const item = active.item;
      await serial(async () => {
        if (active !== presentation) return;
        const record = records.find(record => record.id === item.alert.id);
        if (!record) throw Error('Alert not found.');
        if (record.snoozeLimit !== null && (record.snoozeCount || 0) >= record.snoozeLimit) throw Error('No snoozes remaining.');
        if (record.sessionId) await snooze(record.sessionId);
        const next = records.map(record => record.id === item.alert.id ? { ...record, snoozeCount: (record.snoozeCount || 0) + 1, sessionId: null, pending: null, snoozeAt: Date.now() + 5 * 60000, snoozeEnd: item.occurrence.end, lastResult: 'Snoozed · this alarm’s apps are unblocked.' } : record);
        await persist(next);
      });
    }
    if (action === 'open') await showWindow();
    if (active === presentation) closePresentation(); return true;
  });
  handle('alerts:list', list);
  handle('alerts:save', value => serial(async () => {
    const alert = validateAlert(value), existing = records.find(record => record.id === value.id);
    if (!existing && records.length >= 100) throw Error('You can save up to 100 alerts.');
    if (alert.enabled && alert.repeat === 'once' && !nextOccurrence({ ...alert, lastOccurrence: 0 }, Date.now())) throw Error('Choose a future time or a time range that is still active.');
    for (const asset of [alert.soundFile, alert.banner].filter(Boolean)) await fs.access(path.join(directory, asset.file));
    if (alert.enabled && alert.blockMode !== 'none') await prepare();
    const scheduleChanged = existing && ['date', 'time', 'repeat', 'lengthMode', 'durationMinutes', 'endTime'].some(key => existing[key] !== alert[key]);
    const record = { ...existing, ...alert, id: existing?.id || randomUUID(), lastOccurrence: scheduleChanged ? 0 : existing?.lastOccurrence || 0, snoozeAt: 0, pending: null, lastResult: existing?.lastResult || '' };
    await persist(existing ? records.map(item => item.id === record.id ? record : item) : [...records, record]);
    return list();
  }));
  handle('alerts:toggle', id => serial(async () => {
    const record = records.find(record => record.id === id);
    if (!record) throw Error('Alert not found.');
    if (!record.enabled && record.blockMode !== 'none') await prepare();
    await persist(records.map(record => record.id === id ? { ...record, enabled: !record.enabled, snoozeAt: 0, pending: null } : record));
    return list();
  }));
  handle('alerts:delete', id => serial(async () => { await persist(records.filter(record => record.id !== id)); presentations = presentations.filter(item => item.alert.id !== id); if (active?.item.alert.id === id) closePresentation(); return list(); }));
  handle('alerts:preview', value => { const alert = validateAlert(value); present(alert, { start: Date.now(), end: Date.now() + alert.durationMinutes * 60000 }, 'Preview only · no apps or websites will be blocked.', true); return true; });
  handle('alerts:media', async kind => {
    if (!['sound', 'banner'].includes(kind)) throw Error('Unknown media type.');
    const extensions = kind === 'sound' ? ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'webm'] : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'];
    const result = await dialog.showOpenDialog(getWindow(), { title: kind === 'sound' ? 'Choose an alarm sound' : 'Choose an image, GIF or video', properties: ['openFile'], filters: [{ name: kind === 'sound' ? 'Audio & video' : 'Images & videos', extensions }] });
    if (result.canceled) return null;
    const source = result.filePaths[0], ext = path.extname(source).slice(1).toLowerCase();
    if (!extensions.includes(ext)) throw Error('This file type is not supported.');
    if ((await fs.stat(source)).size > 200 * 1024 * 1024) throw Error('Choose a file smaller than 200 MB.');
    // Reuse any identical file already in alert-media (same size, then same hash).
    const hashOf = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
    const size = (await fs.stat(source)).size, digest = await hashOf(source);
    for (const existing of await fs.readdir(directory)) {
      if (!MEDIA_FILE.test(existing) || path.extname(existing).slice(1).toLowerCase() !== ext) continue;
      const full = path.join(directory, existing);
      if ((await fs.stat(full)).size === size && await hashOf(full) === digest) return { file: existing, name: path.basename(source) };
    }
    const file = digest.slice(0, 36) + '.' + ext;
    await fs.copyFile(source, path.join(directory, file));
    return { file, name: path.basename(source) };
  });
  async function tick() {
    let changed = false;
    let currentStatus, readAt, statusGeneration;
    async function readStatus() {
      // Only reuse an active session in this pass, and never past its guard deadline.
      const elapsed = Date.now() - readAt;
      if (!currentStatus || currentStatus.unavailable || currentStatus.session?.phase !== 'active' ||
          statusGeneration !== getStatusGeneration() || elapsed < 0 ||
          (currentStatus.now ?? readAt) + elapsed >= currentStatus.session.endsAt) {
        readAt = Date.now(); statusGeneration = getStatusGeneration();
        currentStatus = await status();
      }
      return currentStatus;
    }
    for (const record of records) {
      if (!record.enabled) continue;
      const now = Date.now();
      if (record.snoozeAt && record.snoozeAt <= now) {
        if (record.snoozeEnd <= now) record.lastResult = 'This focus window has ended. This is a reminder only; scheduled blocking has ended.';
        else if (record.occurrenceApps?.length) {
          record.pending = { start: now, end: record.snoozeEnd, apps: record.occurrenceApps };
          record.lastResult = 'Waiting to restart blocking…';
        }
        record.snoozeAt = 0; await persist();
        present(record, { start: now, end: record.snoozeEnd }, record.snoozeEnd <= now ? 'Your focus window has ended. This is your snoozed reminder.' : record.lastResult || 'Your reminder, a little later.');
      }
      const occurrence = dueOccurrence(record, now);
      if (occurrence) {
        record.lastOccurrence = occurrence.start;
        record.snoozeCount = 0;
        record.snoozeAt = 0;
        record.sessionId = null;
        if (occurrence.end <= now) { record.lastResult = 'Missed while Still was closed or this PC was asleep.'; changed = true; continue; }
        const prefs = getPreferences();
        const apps = record.blockMode === 'none' ? [] : record.blockMode === 'current' ? (prefs.apps || []).filter(app => (prefs.selected || []).includes(app.path)) : record.apps;
        record.occurrenceApps = apps;
        record.pending = apps.length ? { ...occurrence, apps } : null;
        record.lastResult = apps.length ? 'Waiting to start blocking…' : record.blockMode === 'current' ? 'Reminder delivered · no apps or websites were selected for blocking.' : 'Reminder delivered · no apps or websites blocked.';
        await persist(); // Claim the occurrence before showing it or sending any blocking request.
        present(record, occurrence, record.lastResult);
      }
      if (record.snoozeAt || !record.pending) continue;
      const pending = record.pending;
      if (pending.end <= Date.now()) { record.pending = null; record.lastResult = 'Focus window ended before blocking could start.'; changed = true; continue; }
      const current = await readStatus();
      if (current.session) {
        const message = 'Another focus session is running. Blocking will start if time remains.';
        if (record.lastResult !== message) { record.lastResult = message; changed = true; if (active?.item.alert.id === record.id) sendAlarmStatus(message); }
        continue;
      }
      if (!current.installed || current.unavailable || (!current.demo && (!current.scheduledAlerts || !current.snoozeAlerts || (pending.apps.some(a => a.path.startsWith('website:')) && !current.websiteBlocking)))) {
        const message = 'Apps are NOT blocked. Prepare / update blocking in Alerts; blocking will start if time remains.';
        if (record.lastResult !== message) { record.lastResult = message; changed = true; }
      }
      else {
        // Clear before submitting: a disconnected reply must never replay a start request.
        record.pending = null; record.lastResult = 'Starting blocking…'; await persist();
        try {
          const result = await start({ ...validateSession({ apps: pending.apps, blockScreen: getPreferences().blockScreen, intention: record.title, durationMinutes: Math.max(1, Math.min(1440, Math.ceil((pending.end - Date.now()) / 60000))), unlockDelayMinutes: record.unlockDelayMinutes }), scheduledEndsAt: pending.end });
          if (!result.session || result.session.phase !== 'active') throw Error('Protection did not report an active session.');
          record.sessionId = result.session.id;
          record.lastResult = `Started a focus session with ${pending.apps.length} apps / websites blocked.`;
        } catch (error) { record.lastResult = 'Blocking could not be confirmed. Check Focus space. ' + error.message; }
        finally { currentStatus = null; }
        changed = true;
      }
      if (active?.item.alert.id === record.id) sendAlarmStatus(record.lastResult);
    }
    if (changed) await persist();
  }
  function scheduleTick() {
    if (ticking) return;
    ticking = true;
    return serial(tick).catch(error => getWindow()?.webContents.send('alert-error', 'Alerts could not be updated: ' + error.message)).finally(() => { ticking = false; });
  }
  setInterval(scheduleTick, 2000).unref();
  app.on('before-quit', () => { presentations = []; closePresentation(); });
}
module.exports = { setupAlerts };
