const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const source = fs.readFileSync(require.resolve('../app/alerts-main.cjs'), 'utf8');
const base = { id: 'saved-alert', title: 'Focus', note: '', date: '2026-09-23', time: '09:00', repeat: 'once', lengthMode: 'duration', durationMinutes: 20, endTime: '10:00', style: 'card', blockMode: 'custom', apps: [{ name: 'Game', path: 'C:\\StillPreview\\Game.exe' }], unlockDelayMinutes: 0, sound: 'silent', volume: 65, enabled: true };

async function scheduler(saved = [], preferences = { apps: base.apps, selected: [base.apps[0].path] }) {
  let now = +new Date('2026-09-23T09:00:00'), interval, stored = JSON.stringify(saved), preparations = 0, reads = 0, opened = 0;
  const handlers = {}, windows = [], starts = [], events = [], notifications = [], timers = new Map();
  const guard = { installed: true, scheduledAlerts: true, snoozeAlerts: true, session: null };
  class Window {
    constructor() {
      this.webContents = { mainFrame: { url: pathToFileURL(path.resolve('app/alarm.html')).href }, send: (name, value) => { this[name] = value; }, setWindowOpenHandler() {}, on() {}, once: (_name, fn) => { this.loaded = fn; } };
      windows.push(this);
    }
    loadFile() { this.loaded(); }
    on() {} setAlwaysOnTop() {} show() {} focus() {}
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const screen = { getCursorScreenPoint() {}, getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close'); }
  }
  const electron = { app: { getPath: () => '/test', on() {} }, BrowserWindow: Window, Notification, screen, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, protocol: { registerSchemesAsPrivileged() {}, handle() {} } };
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.resolve('app'), structuredClone, console,
    Date: class extends Date { static now() { return now; } },
    require: name => name === 'electron' ? electron : name === 'node:fs/promises' ? { mkdir: async () => {}, readFile: async () => stored, writeFile: async (_file, value) => { stored = value; }, rename: async () => {} } : name.startsWith('./') ? require(path.resolve('app', name)) : require(name),
    setInterval: fn => { interval = fn; return { unref() {} }; }, setTimeout: (fn, delay) => { const token = {}; timers.set(token, { fn, delay }); return token; }, clearTimeout: token => timers.delete(token)
  });
  vm.runInContext(source, context);
  await context.module.exports.setupAlerts({
    handle: (name, fn) => { handlers[name] = fn; }, getWindow: () => ({ isDestroyed: () => false, webContents: { send: (name, value) => events.push({ name, value }) } }),
    showWindow: () => { opened++; },
    getPreferences: () => preferences,
    status: async () => { reads++; if (guard.session?.endsAt <= now) guard.session = null; return { ...guard, now }; },
    prepare: async () => { preparations++; if (guard.unavailable) throw Error('Setup cancelled'); guard.scheduledAlerts = true; },
    snooze: async id => { if (guard.unavailable) throw Error('Release failed'); if (guard.session?.id === id) guard.session = null; },
    start: async request => { assert.equal(guard.session, null); starts.push(request); guard.session = { ...request, id: 'session-' + starts.length, phase: 'active', endsAt: request.scheduledEndsAt }; return guard; }
  });
  return { handlers, guard, starts, events, windows, notifications, reads: () => reads, opened: () => opened,
    timeout: delay => { for (const [token, timer] of [...timers]) if (timer.delay === delay) { timers.delete(token); timer.fn(); } },
    tick: () => interval(), advance: ms => { now += ms; }, list: () => handlers['alerts:list'](), preparations: () => preparations,
    snooze: () => { const window = windows.at(-1); return handlers['alarm-action']({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'snooze'); }
  };
}

test('running → five-minute snooze → running keeps the exact selected apps and deadline', async () => {
  const s = await scheduler();
  await s.handlers['alerts:save'](base);
  assert.equal(s.preparations(), 1);
  await s.tick();
  assert.equal(s.list()[0].ringing, true);
  assert.equal(s.list()[0].sessionId, s.guard.session.id);
  const deadline = s.guard.session.endsAt;
  await s.snooze();
  assert.equal(s.guard.session, null, 'snooze releases apps immediately');
  assert.equal(s.list()[0].ringing, false);
  assert.equal(s.list()[0].nextAt, s.list()[0].snoozeAt);
  s.advance(5 * 60000); await s.tick();
  assert.equal(s.list()[0].ringing, true);
  assert.equal(s.list()[0].snoozeAt, 0);
  assert.equal(s.guard.session.endsAt, deadline);
  assert.equal(s.guard.session.apps[0].path, base.apps[0].path);
  assert.equal(s.starts.length, 2, 'snooze restarts protection');
  assert.match(s.windows.at(-1)['alarm-message'], /Started a focus session/);
  await s.snooze(); s.advance(5 * 60000); await s.tick();
  assert.equal(s.starts.length, 3, 'repeated snooze restarts protection');
});

test('snooze limits survive reload, reset daily, and failed release keeps the alarm open', async () => {
  const s = await scheduler([{ ...base, snoozeLimit: 1, repeat: 'daily', unlockDelayMinutes: 30 }]);
  await s.tick(); s.guard.unavailable = true;
  await assert.rejects(s.snooze(), /Release failed/);
  assert.equal(s.list()[0].ringing, true); assert.equal(s.list()[0].snoozeCount, 0);
  s.guard.unavailable = false; await s.snooze();
  assert.equal(s.guard.session, null);
  const reloaded = await scheduler(s.list()); reloaded.advance(5 * 60000); await reloaded.tick();
  await assert.rejects(reloaded.snooze(), /No snoozes remaining/);
  assert.equal(reloaded.list()[0].ringing, true);
  reloaded.timeout(5 * 60000); reloaded.advance(24 * 3600000); await reloaded.tick();
  assert.equal(reloaded.list()[0].snoozeCount, 0);
});

test('snoozing a pending alarm preserves another session and waits before retrying', async () => {
  const s = await scheduler([base]);
  s.guard.session = { id: 'other', phase: 'active', endsAt: +new Date('2026-09-23T09:02:00') };
  await s.tick(); await s.snooze();
  assert.equal(s.guard.session.id, 'other');
  s.advance(3 * 60000); await s.tick(); assert.equal(s.starts.length, 0);
  s.advance(2 * 60000); await s.tick(); assert.equal(s.starts.length, 1);
});

test('zero snoozes and hidden dismiss are enforced by the alarm handler', async () => {
  const s = await scheduler([{ ...base, snoozeLimit: 0, showDismiss: false }]); await s.tick();
  await assert.rejects(s.snooze(), /No snoozes remaining/);
  const window = s.windows.at(-1);
  await assert.rejects(s.handlers['alarm-action']({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'dismiss'), /Dismiss is hidden/);
});

test('silent notifications retain queue, click, dismissal and ten-second lifetime without windows', async () => {
  const s = await scheduler([{ ...base, id: 'silent', style: 'notification', blockMode: 'none' }, { ...base, id: 'muted', style: 'notification', sound: 'chime', volume: 0, blockMode: 'none' }]);
  await s.tick();
  assert.equal(s.windows.length, 0); assert.equal(s.notifications.length, 1);
  assert.equal(s.list()[0].ringing, true); assert.equal(s.list()[1].queued, true);
  s.notifications[0].emit('click'); assert.equal(s.opened(), 1); assert.equal(s.list()[0].ringing, false);
  s.timeout(150); assert.equal(s.notifications.length, 2); assert.equal(s.list()[1].ringing, true);
  s.timeout(10000); assert.equal(s.list()[1].ringing, false); assert.equal(s.notifications[1].closed, true);
  await s.handlers['alerts:preview']({ ...base, style: 'notification', blockMode: 'none' });
  s.notifications.at(-1).emit('close'); assert.equal(s.windows.length, 0);
});

test('audible notification still creates its audio window', async () => {
  const s = await scheduler([{ ...base, style: 'notification', sound: 'chime', blockMode: 'none' }]);
  await s.tick(); assert.equal(s.windows.length, 1); assert.equal(s.windows[0]['alarm-data'].audible, true);
});

test('pending alerts share an active status in one pass and refresh after expiry and starts', async () => {
  const s = await scheduler(Array.from({ length: 10 }, (_, i) => ({ ...base, id: 'pending-' + i })));
  s.guard.session = { id: 'existing', phase: 'active', endsAt: +new Date('2026-09-23T09:01:00') };
  await s.tick(); assert.equal(s.reads(), 1); assert.equal(s.starts.length, 0);
  s.advance(60001); await s.tick();
  assert.equal(s.starts.length, 1); assert.equal(s.reads(), 3, 'read expired status, then refresh after start');
  assert.equal(s.starts[0].scheduledEndsAt, +new Date('2026-09-23T09:20:00'));
});

test('expired snooze is clearly a reminder and never claims blocking is active', async () => {
  const s = await scheduler([{ ...base, durationMinutes: 1 }]);
  await s.tick(); await s.snooze(); s.advance(5 * 60000); await s.tick();
  assert.match(s.windows.at(-1)['alarm-data'].message, /window has ended/);
  assert.equal(s.starts.length, 1, 'fixed end time must not be extended');
});

test('old protection stays pending and recovers after preparation within the focus window', async () => {
  const s = await scheduler([base]); s.guard.scheduledAlerts = false;
  await s.tick();
  assert.equal(s.starts.length, 0);
  assert.ok(s.list()[0].pending);
  assert.match(s.list()[0].lastResult, /NOT blocked/);
  await s.snooze(); s.guard.scheduledAlerts = true;
  s.advance(5 * 60000); await s.tick();
  assert.equal(s.starts.length, 1);
  assert.equal(s.guard.session.apps[0].path, base.apps[0].path);
  assert.equal(s.guard.session.endsAt, +new Date('2026-09-23T09:20:00'));
  assert.match(s.windows.at(-1)['alarm-message'], /Started a focus session/);
});

test('failed setup never saves or re-enables a blocking alert', async () => {
  const s = await scheduler([{ ...base, enabled: false }]); s.guard.unavailable = true;
  await assert.rejects(s.handlers['alerts:toggle'](base.id), /Setup cancelled/);
  assert.equal(s.list()[0].enabled, false);
  await assert.rejects(s.handlers['alerts:save']({ ...base, id: undefined }), /Setup cancelled/);
  assert.equal(s.list().length, 1);
});


test('website alerts preserve domains through pending and snooze, and inherit the selected block screen', async () => {
  const website = { name: 'youtube.com', path: 'website:youtube.com' };
  const s = await scheduler([{ ...base, blockMode: 'current' }], { apps: [website], selected: [website.path], blockScreen: { mode: 'dusk' } });
  await s.tick(); assert.equal(s.starts.length, 0); assert.ok(s.list()[0].pending, 'old guards cannot drop website selections');
  s.guard.websiteBlocking = true; await s.tick();
  assert.deepEqual(s.starts[0].apps, [website]); assert.equal(s.starts[0].blockScreen.mode, 'dusk');
  const deadline = s.starts[0].scheduledEndsAt;
  await s.snooze(); s.advance(5 * 60000); await s.tick();
  assert.deepEqual(s.starts[1].apps, [website]); assert.equal(s.starts[1].scheduledEndsAt, deadline);
});
