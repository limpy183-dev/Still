const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Websites = require('../app/websites.js');
const { validateSession, validatePreferences, allowedApp } = require('../app/domain.cjs');
const { validateAlert } = require('../app/alert-domain.cjs');

test('website addresses normalize consistently and reject unsafe/local identities', () => {
  assert.equal(Websites.domain('https://WWW.YouTube.com/watch?v=123'), 'youtube.com');
  assert.equal(Websites.domain('example.com:8080/path'), 'example.com');
  assert.equal(Websites.domain('https://bücher.de'), 'xn--bcher-kva.de');
  assert.equal(Websites.domain('reddit.com.'), 'reddit.com');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', '127.0.0.1', '[::1]', 'localhost', 'foo.local', 'https://name:password@example.com', '*.example.com', 'example.com\\evil', 'https://-bad.com', 'https://a..com', 'example.com\n']) assert.throws(() => Websites.domain(value), value);
  assert.ok(Websites.matches('a.b.example.com', 'example.com'));
  assert.ok(Websites.matches('EXAMPLE.COM.', 'example.com'));
  assert.ok(!Websites.matches('notexample.com', 'example.com'));
  assert.ok(!Websites.matches('example.com.attacker.com', 'example.com'));
});
test('website-only and mixed selections survive preferences, sessions, groups and alerts', () => {
  const website = Websites.target('https://youtube.com/watch');
  assert.equal(allowedApp(website), false, 'Discovery still accepts native apps only');
  const request = { durationMinutes: 25, unlockDelayMinutes: 5, apps: [website], intention: 'Write' };
  assert.deepEqual(validateSession(request).apps, [website]);
  assert.equal(validateSession(request).blockScreen.mode, 'garden');
  const prefs = validatePreferences({ apps: [website], selected: [website.path], groups: [{ name: 'Quiet', paths: [website.path] }], blockScreen: { mode: 'custom', title: '<hello>', text: 'Keep going', image: 'data:image/png;base64,AAAA' } });
  assert.deepEqual(prefs.apps, [website]); assert.deepEqual(prefs.groups[0].paths, [website.path]);
  assert.equal(prefs.blockScreen.title, '<hello>');
  const alert = validateAlert({ title: 'Write', date: '2026-09-24', time: '10:00', repeat: 'daily', lengthMode: 'duration', durationMinutes: 25, endTime: '11:00', style: 'card', blockMode: 'custom', apps: [website], unlockDelayMinutes: 0, sound: 'chime', volume: 50 });
  assert.deepEqual(alert.apps, [website]);
  assert.throws(() => validateSession({ ...request, apps: [{ name: 'Bad', path: 'website:localhost' }] }));
});
test('redirect loops and executable image URLs are rejected at the IPC boundary', () => {
  const targets = [Websites.target('youtube.com')];
  for (const redirect of ['https://youtube.com/', 'https://m.youtube.com/', 'https://youtube.com./', 'javascript:alert(1)', 'http://example.com/', 'https://127.0.0.1/', 'https://user:pass@example.com']) assert.throws(() => Websites.screen({ mode: 'redirect', redirect }, targets), redirect);
  assert.equal(Websites.screen({ mode: 'redirect', redirect: 'https://example.com/notes' }, targets).redirect, 'https://example.com/notes');
  assert.throws(() => Websites.screen({ image: 'data:image/svg+xml;base64,AAAA' }));
  assert.throws(() => Websites.screen({ image: 'https://example.com/image.png' }));
  assert.throws(() => Websites.screen({ image: 'data:image/png;base64,' + 'A'.repeat(180000) }));
});
test('companion installs redirects and subresource blocks, redirects open tabs, retains rules on disconnect and releases only on a guard snapshot', async () => {
  const listeners = {}, events = name => ({ addListener: listener => { listeners[name] = listener; } });
  const updates = [], storage = {}, acknowledgements = []; let dynamic = [];
  const port = { onMessage: events('message'), onDisconnect: events('disconnect'), postMessage: message => acknowledgements.push(message) };
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => true },
    runtime: { connectNative: () => port, getURL: path => 'chrome-extension://still/' + path, onStartup: events('startup'), onInstalled: events('installed') },
    storage: { local: { get: async () => storage, set: async value => Object.assign(storage, value) } },
    declarativeNetRequest: { getDynamicRules: async () => dynamic, updateDynamicRules: async value => { dynamic = value.addRules; } },
    action: { setBadgeText: async () => {}, setTitle: async () => {}, onClicked: events('click') },
    alarms: { create: () => {}, get: async () => null, onAlarm: events('alarm') },
    windows: { get: async () => ({ focused: false }), onFocusChanged: events('focus') },
    tabs: { query: async () => [{ id: 1, url: 'https://m.youtube.com/watch' }, { id: 2, url: 'https://example.com/' }], update: async (id, value) => updates.push({ id, ...value }) },
    webNavigation: { onBeforeNavigate: events('before'), onCommitted: events('committed'), onHistoryStateUpdated: events('history'), onErrorOccurred: events('error') }
  };
  const context = vm.createContext({ chrome, Websites, importScripts() {}, URL, console, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../app/browser-extension/background.js'), 'utf8'), context);
  await new Promise(setImmediate);
  listeners.message({ sessionId: 'focus', websites: ['youtube.com'], screen: { mode: 'garden' }, endsAt: Date.now() + 10000 });
  await vm.runInContext('queue', context);
  assert.equal(dynamic.length, 2); assert.equal(dynamic[0].action.redirect.extensionPath, '/blocked.html');
  assert.equal(dynamic[1].action.type, 'block'); assert.equal(updates.length, 1); assert.equal(updates[0].id, 1);
  assert.equal(acknowledgements[0].ready, 'focus');
  chrome.extension.isAllowedIncognitoAccess = async () => false;
  listeners.message({ sessionId: 'private-access-missing', websites: ['youtube.com'], screen: { mode: 'garden' }, endsAt: Date.now() + 10000 });
  await vm.runInContext('queue', context);
  assert.equal(acknowledgements.length, 1, 'Missing private-window access cannot acknowledge a protected session');
  assert.equal(storage.privateReady, false);
  chrome.extension.isAllowedIncognitoAccess = async () => true;
  listeners.disconnect(); assert.equal(dynamic.length, 2, 'Lost service connection does not release blocks');
  listeners.history({ frameId: 0, tabId: 3, url: 'https://youtube.com/' });
  assert.equal(updates.at(-1).id, 3);
  listeners.message({ sessionId: 'focus', websites: ['youtube.com'], screen: { mode: 'redirect', redirect: 'https://example.com/notes' }, endsAt: Date.now() + 10000 });
  await vm.runInContext('queue', context);
  assert.equal(dynamic[0].action.redirect.url, 'https://example.com/notes');
  listeners.message({ sessionId: null, websites: [], screen: null, endsAt: 0 });
  await vm.runInContext('queue', context); assert.equal(dynamic.length, 0);
});
test('daily limits and bedtime normalize, cross midnight, and pick the right reason', () => {
  const config = Websites.limits({ bedtime: { from: '22:00', to: '07:00' }, sites: [{ domain: 'https://www.youtube.com/watch', minutes: 30, bedtime: true }, { domain: 'youtube.com', minutes: 5 }, { domain: 'localhost', minutes: 5 }, { domain: 'reddit.com', minutes: 99999 }] });
  assert.deepEqual(config.sites, [{ domain: 'youtube.com', minutes: 30, bedtime: true }, { domain: 'reddit.com', minutes: 1440, bedtime: false }]);
  assert.deepEqual(Websites.limits({ bedtime: { from: '25:00' } }).bedtime, { on: true, from: '22:30', to: '07:00' });
  const at = time => new Date(`2026-09-24T${time}:00`);
  assert.equal(Websites.inBedtime(config.bedtime, at('23:30')), true); assert.equal(Websites.inBedtime(config.bedtime, at('06:59')), true);
  assert.equal(Websites.inBedtime(config.bedtime, at('07:00')), false); assert.equal(Websites.inBedtime({ from: '13:00', to: '14:00' }, at('13:30')), true);
  assert.deepEqual(Websites.limitBlocks(config, { 'youtube.com': 1799 }, at('12:00')), {});
  assert.deepEqual(Websites.limitBlocks(config, { 'youtube.com': 1800, 'reddit.com': 10 }, at('12:00')), { 'youtube.com': 'limit' });
  assert.deepEqual(Websites.limitBlocks(config, {}, at('23:00')), { 'youtube.com': 'bedtime' });
  assert.deepEqual(Websites.limitBlocks({ ...config, bedtime: { ...config.bedtime, on: false } }, {}, at('23:00')), {});
  assert.deepEqual(validatePreferences({ websiteLimits: { sites: [{ domain: 'x.com', minutes: 15, bedtime: true }] } }).websiteLimits.sites, [{ domain: 'x.com', minutes: 15, bedtime: true }]);
});
test('companion counts time while a limited site is open in any tab, even unfocused, blocks over-limit sites alongside session rules, and keeps limits when preferences are unreadable', async () => {
  const listeners = {}, events = name => ({ addListener: listener => { listeners[name] = listener; } });
  const updates = [], storage = {}; let dynamic = [], clock = new Date('2026-09-24T12:00:00').getTime();
  const port = { onMessage: events('message'), onDisconnect: events('disconnect'), postMessage() {} };
  const tabs = [{ id: 1, url: 'https://m.youtube.com/watch', windowId: 1 }];
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => true },
    runtime: { connectNative: () => port, getURL: path => 'chrome-extension://still/' + path, onStartup: events('startup'), onInstalled: events('installed') },
    storage: { local: { get: async () => ({ ...storage }), set: async value => Object.assign(storage, JSON.parse(JSON.stringify(value))) } },
    declarativeNetRequest: { getDynamicRules: async () => dynamic, updateDynamicRules: async value => { dynamic = value.addRules; } },
    action: { setBadgeText: async () => {}, setTitle: async () => {}, onClicked: events('click') },
    alarms: { create: () => {}, get: async () => null, onAlarm: events('alarm') },
    windows: { get: async () => ({ focused: false }), onFocusChanged: events('focus') },
    tabs: { query: async () => tabs, update: async (id, value) => updates.push({ id, ...value }), onActivated: events('activated') },
    webNavigation: { onCommitted: events('committed'), onHistoryStateUpdated: events('history'), onErrorOccurred: events('error') }
  };
  const FakeDate = class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
  const context = vm.createContext({ chrome, Websites, importScripts() {}, URL, URLSearchParams, JSON, console, Date: FakeDate, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../app/browser-extension/background.js'), 'utf8'), context);
  await new Promise(setImmediate);
  const limits = { bedtime: { from: '22:00', to: '07:00' }, sites: [{ domain: 'youtube.com', minutes: 1, bedtime: false }] };
  listeners.message({ sessionId: 'focus', websites: ['reddit.com'], screen: { mode: 'garden' }, endsAt: clock + 1e6, limits });
  await vm.runInContext('queue', context); await vm.runInContext('queue', context);
  assert.equal(dynamic.length, 2, 'Only session rules before the limit is used up');
  for (let i = 0; i < 2; i++) { clock += 30000; listeners.alarm({ name: 'limits' }); await vm.runInContext('queue', context); }
  assert.equal(storage.usage.seconds['youtube.com'], 60);
  assert.equal(dynamic.length, 3, 'Session rules survive alongside the limit rule');
  assert.match(dynamic[2].action.redirect.extensionPath, /why=limit&site=youtube\.com/);
  assert.match(updates.at(-1).url, /blocked\.html\?why=limit/); assert.equal(updates.at(-1).id, 1);
  listeners.message({ sessionId: null, websites: [], screen: null, endsAt: 0, limits: null });
  await vm.runInContext('queue', context);
  assert.equal(dynamic.length, 1, 'Unreadable preferences keep the existing limit');
  clock = new Date('2026-09-25T12:00:00').getTime(); listeners.alarm({ name: 'limits' }); await vm.runInContext('queue', context);
  assert.equal(dynamic.length, 0, 'Limits reset at midnight');
});
test('extension works on its own and alongside Still for Windows: sessions and limits combine, neither side releases the other, and redirect loops fall back to the block page', async () => {
  const listeners = {}, events = name => ({ addListener: listener => { listeners[name] = listener; } });
  const updates = [], badges = [], titles = []; let dynamic = [], clock = new Date('2026-09-24T12:00:00').getTime();
  const storage = { own: { websites: ['reddit.com', 'example.com'], screen: { mode: 'redirect', redirect: 'https://news.org/' }, session: { endsAt: clock + 600000 }, limits: { sites: [{ domain: 'youtube.com', minutes: 1 }] } } };
  const port = { onMessage: events('message'), onDisconnect: events('disconnect'), postMessage() {} };
  const chrome = {
    extension: { isAllowedIncognitoAccess: async () => false },
    runtime: { connectNative: () => port, getURL: path => 'chrome-extension://still/' + path, onStartup: events('startup'), onInstalled: events('installed') },
    storage: { local: { get: async () => ({ ...storage }), set: async value => Object.assign(storage, JSON.parse(JSON.stringify(value))) }, onChanged: events('storage') },
    declarativeNetRequest: { getDynamicRules: async () => dynamic, updateDynamicRules: async value => { dynamic = JSON.parse(JSON.stringify(value.addRules)); } },
    action: { setBadgeText: async value => badges.push(value.text), setTitle: async value => titles.push(value.title), onClicked: events('click') },
    alarms: { create: () => {}, get: async () => null, onAlarm: events('alarm') },
    tabs: { query: async () => [{ id: 1, url: 'https://old.reddit.com/' }, { id: 2, url: 'https://youtube.com/' }], update: async (id, value) => updates.push({ id, ...value }) },
    webNavigation: { onCommitted: events('committed'), onHistoryStateUpdated: events('history'), onErrorOccurred: events('error') }
  };
  const FakeDate = class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
  const context = vm.createContext({ chrome, Websites, importScripts() {}, URL, URLSearchParams, JSON, console, Date: FakeDate, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../app/browser-extension/background.js'), 'utf8'), context);
  await new Promise(setImmediate); await vm.runInContext('queue', context);
  chrome.runtime.lastError = { message: 'Specified native messaging host not found.' }; listeners.disconnect(); delete chrome.runtime.lastError;
  await new Promise(setImmediate);
  assert.equal(vm.runInContext('app', context), 'none'); assert.equal(badges.at(-1), 'ON', 'Without the app there is no warning badge, even without private-window access');
  assert.match(titles.at(-1), /Allow in Incognito/, 'The tooltip still says how to cover private windows');
  // A copy Still Guard doesn't accept (e.g. loaded unpacked from elsewhere) says so, instead of "isn't responding".
  chrome.runtime.lastError = { message: 'Access to the specified native messaging host is forbidden.' }; listeners.disconnect(); delete chrome.runtime.lastError;
  await new Promise(setImmediate);
  assert.equal(storage.app, 'other'); assert.match(titles.at(-1), /doesn’t recognise this copy/);
  chrome.runtime.lastError = { message: 'Specified native messaging host not found.' }; listeners.disconnect(); delete chrome.runtime.lastError;
  await new Promise(setImmediate); assert.equal(storage.app, 'none');
  assert.deepEqual(dynamic.map(rule => rule.condition.requestDomains[0]), ['reddit.com', 'reddit.com', 'example.com', 'example.com']);
  assert.equal(dynamic[0].action.redirect.url, 'https://news.org/'); assert.equal(updates[0].id, 1);
  // The app holds news.org (our redirect target) and reddit.com; its session wins where both hold, and our redirect falls back to the block page.
  listeners.message({ sessionId: 'focus', websites: ['news.org', 'reddit.com'], screen: { mode: 'garden' }, endsAt: clock + 1e6, limits: { sites: [{ domain: 'youtube.com', minutes: 30 }] } });
  await vm.runInContext('queue', context);
  assert.deepEqual(dynamic.filter(rule => rule.priority === 2).map(rule => [rule.condition.requestDomains[0], rule.action.redirect.extensionPath]), [['news.org', '/blocked.html'], ['reddit.com', '/blocked.html'], ['example.com', '/blocked.html?by=me']]);
  assert.equal(badges.at(-1), '!', 'Connected to the app, private-window access is required again');
  // Ending our own session never releases the app's sites.
  storage.own = { ...storage.own, session: null }; listeners.storage({ own: { newValue: storage.own } }, 'local');
  await vm.runInContext('queue', context);
  assert.deepEqual(dynamic.filter(rule => rule.priority === 2).map(rule => rule.condition.requestDomains[0]), ['news.org', 'reddit.com']);
  // Our 1-minute limit is stricter than the app's 30 minutes, so it holds youtube.com.
  for (let i = 0; i < 2; i++) { clock += 30000; listeners.alarm({ name: 'limits' }); await vm.runInContext('queue', context); }
  assert.match(dynamic.at(-1).action.redirect.extensionPath, /why=limit&site=youtube\.com/);
  // The app's session ending never releases our own session either.
  storage.own = { ...storage.own, session: { endsAt: clock + 600000 } }; listeners.storage({ own: { newValue: storage.own } }, 'local');
  listeners.message({ sessionId: null, websites: [], screen: null, endsAt: 0, limits: { sites: [] } });
  await vm.runInContext('queue', context);
  assert.deepEqual(dynamic.filter(rule => rule.priority === 2).map(rule => rule.condition.requestDomains[0]), ['reddit.com', 'example.com']);
  clock += 600000; listeners.alarm({ name: 'own-session' }); await vm.runInContext('queue', context);
  assert.equal(dynamic.filter(rule => rule.priority === 2).length, 0, 'Our session ends on time');
  // A snapshot that can't be applied says so, rather than "reconnect", and the next good one clears it.
  listeners.message({ sessionId: 'focus', websites: ['not a domain'], screen: null, endsAt: 0 }); await vm.runInContext('queue', context);
  assert.equal(vm.runInContext('app', context), 'failed'); assert.match(titles.at(-1), /couldn’t apply/);
  listeners.message({ sessionId: null, websites: [], screen: null, endsAt: 0 }); await vm.runInContext('queue', context);
  assert.equal(vm.runInContext('app', context), 'connected'); assert.match(titles.at(-1), /Allow in Incognito/);
});
test('extension settings normalize safely', () => {
  const own = Websites.own({ websites: ['https://www.YouTube.com/x', 'youtube.com', 'localhost', 42], screen: { mode: 'redirect', redirect: 'https://m.youtube.com/' }, session: { endsAt: 'soon' }, limits: { sites: [{ domain: 'x.com', minutes: 5 }] } });
  assert.deepEqual(own.websites, ['youtube.com']); assert.equal(own.screen.mode, 'garden', 'A redirect into a held site falls back');
  assert.equal(own.session, null); assert.equal(own.limits.sites[0].minutes, 5);
  assert.deepEqual(Websites.own(null), { websites: [], screen: Websites.screen({}), limits: Websites.limits(), session: null });
});
