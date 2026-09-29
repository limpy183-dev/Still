'use strict';
importScripts('websites.js');
let port, retryTimer, finalTick, queue = Promise.resolve(), latest, own = Websites.own(), limited = {}, app = 'none';
const ruleBase = 10000, limitBase = 20000;
// Sessions from Still for Windows (latest) and sessions started in this extension (own) both hold at once.
// Each only adds blocks, so neither can release a site the other holds.
const ownActive = () => own.session?.endsAt > Date.now();
function blocked(snapshot = latest) {
  const apps = snapshot?.websites || [], mine = ownActive() ? own.websites.filter(domain => !apps.includes(domain)) : [];
  const entries = [...apps.map(domain => ({ domain, screen: snapshot.screen, page: '/blocked.html' })), ...mine.map(domain => ({ domain, screen: own.screen, page: '/blocked.html?by=me' }))];
  // A redirect into a site the other side holds would bounce between them; show the block page instead.
  for (const entry of entries) entry.url = entry.screen?.mode === 'redirect' && !entries.some(other => Websites.matches(hostOf(entry.screen.redirect) || '', other.domain)) ? entry.screen.redirect : null;
  return entries;
}
function rulesFor(snapshot) {
  return blocked(snapshot).flatMap(({ domain, url, page }, index) => [
    { id: ruleBase + index * 2, priority: 2, action: { type: 'redirect', redirect: url ? { url } : { extensionPath: page } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame'] } },
    { id: ruleBase + index * 2 + 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: [domain] } }
  ]);
}
// Daily limits and bedtime only hold top-level pages; embeds elsewhere keep working.
const limitPage = domain => '/blocked.html?' + new URLSearchParams({ why: limited[domain], site: domain });
const limitRules = () => Object.keys(limited).map((domain, index) => ({ id: limitBase + index, priority: 1, action: { type: 'redirect', redirect: { extensionPath: limitPage(domain) } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame'] } }));
async function syncRules(snapshot = latest) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.filter(rule => rule.id >= ruleBase).map(rule => rule.id), addRules: [...rulesFor(snapshot), ...limitRules()] });
}
const hostOf = url => { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : null; } catch { return null; } };
const limitedDomain = url => { const host = hostOf(url); return host && Object.keys(limited).find(domain => Websites.matches(host, domain)); };
const held = url => { const host = hostOf(url); return host && blocked().find(entry => Websites.matches(host, entry.domain)); };
function destination(url) {
  const entry = held(url); if (entry) return entry.url || chrome.runtime.getURL(entry.page.slice(1));
  const domain = limitedDomain(url); return domain ? chrome.runtime.getURL(limitPage(domain).slice(1)) : null;
}
// A limited site's clock runs while any tab has it open, in any window, focused or not.
// Checked every 30 s, on tab/window/page changes, and once more exactly when a site runs out.
// Limits set in Still for Windows and in this extension both apply; a site rests when either says so.
async function tickLimits() {
  const stored = await chrome.storage.local.get(['limits', 'usage', 'lastTick', 'lastSites', 'own']), configs = [Websites.limits(stored.limits), Websites.limits(stored.own?.limits)], now = Date.now(), day = new Date().toDateString();
  const sites = configs.flatMap(config => config.sites.filter(item => item.minutes));
  const usage = stored.usage?.day === day ? stored.usage : { day, seconds: {} };
  // Time since the last tick belongs to the sites open then (one clock per site, however many tabs). Sleep/gaps count at most 60 s.
  const elapsed = stored.lastTick && usage === stored.usage ? Math.min(60, Math.max(0, (now - stored.lastTick) / 1000)) : 0;
  for (const domain of stored.lastSites || []) usage.seconds[domain] = (usage.seconds[domain] || 0) + elapsed;
  const hosts = (await chrome.tabs.query({})).map(tab => hostOf(tab.url)).filter(Boolean);
  const open = [...new Set(sites.filter(item => hosts.some(host => Websites.matches(host, item.domain))).map(item => item.domain))];
  await chrome.storage.local.set({ usage, lastTick: now, lastSites: open });
  const next = Object.assign({}, ...configs.map(config => Websites.limitBlocks(config, usage.seconds, new Date(now))));
  // Check again exactly when the next open site runs out, instead of up to 30 s later.
  clearTimeout(finalTick);
  const left = Math.min(...sites.filter(item => open.includes(item.domain) && !next[item.domain]).map(item => item.minutes * 60 - (usage.seconds[item.domain] || 0)));
  if (left < 30) finalTick = setTimeout(tick, left * 1000 + 250);
  if (JSON.stringify(next) === JSON.stringify(limited)) return;
  limited = next; await chrome.storage.local.set({ limited });
  await syncRules();
  for (const open of await chrome.tabs.query({})) { const target = limitedDomain(open.url) && destination(open.url); if (target) await chrome.tabs.update(open.id, { url: target }).catch(() => {}); }
}
const tick = () => { queue = queue.catch(() => {}).then(tickLimits).catch(console.error); return queue; };
async function badge() {
  const privateReady = await chrome.extension.isAllowedIncognitoAccess(), on = blocked().length > 0;
  const [text, title] = app === 'lost' ? ['!', 'Still · reconnect Windows protection; existing blocks stay in place']
    : app === 'failed' ? ['!', 'Still · couldn’t apply Windows protection’s websites; existing blocks stay in place']
    // Private-window access is required for the app's sessions ('!'); on its own it's optional, so only the tooltip mentions it.
    : !privateReady ? [app === 'connected' ? '!' : on ? 'ON' : '', 'Still · to block websites in private windows, turn on “Allow in Incognito” (Edge: “Allow in InPrivate”) in this extension’s Details']
    : on ? ['ON', 'Still · websites blocked'] : ['', app === 'connected' ? 'Still · connected, ready to focus' : 'Still · Website focus'];
  await chrome.action.setBadgeText({ text }); await chrome.action.setTitle({ title });
  return privateReady;
}
// Existing tabs (including cached pages) must leave a held website too.
async function redirectTabs() {
  if (!blocked().length) return;
  for (const tab of await chrome.tabs.query({})) if (held(tab.url) || held(tab.pendingUrl)) await chrome.tabs.update(tab.id, { url: destination(tab.url) || destination(tab.pendingUrl) }).catch(() => {});
}
// Re-applies this extension's own session after its settings change or it ends.
async function refresh() {
  await syncRules(); await redirectTabs(); await badge();
  if (ownActive()) chrome.alarms.create('own-session', { when: own.session.endsAt });
}
const queueRefresh = () => { queue = queue.catch(() => {}).then(refresh).catch(console.error); };
async function apply(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.websites) || snapshot.websites.length > 100 || snapshot.websites.some(host => Websites.domain(host) !== host)) throw Error('Invalid guard state');
  snapshot.screen = Websites.screen(snapshot.screen || {}, snapshot.websites.map(host => Websites.target(host)));
  // A missing value means preferences were unreadable; keep the last limits.
  if (snapshot.limits) await chrome.storage.local.set({ limits: Websites.limits(snapshot.limits) });
  delete snapshot.limits;
  await syncRules(snapshot);
  latest = snapshot; app = 'connected';
  const privateReady = await badge();
  await chrome.storage.local.set({ snapshot, app, privateReady });
  await redirectTabs();
  if (snapshot.sessionId && snapshot.websites.length && privateReady) port?.postMessage({ ready: snapshot.sessionId });
  tick();
}
function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  try {
    port = chrome.runtime.connectNative('app.still.focus');
    // A message means the connection works, even if this snapshot can't be applied; say which it is instead of "reconnect".
    port.onMessage.addListener(snapshot => { queue = queue.catch(() => {}).then(() => apply(snapshot)).catch(error => { console.error(error); app = 'failed'; return badge(); }).catch(console.error); });
    port.onDisconnect.addListener(() => {
      // No registered host means Still for Windows isn't set up here: work on our own and check again every 30 s.
      const missing = /not found/i.test(chrome.runtime.lastError?.message || ''), wasLost = app === 'lost'; port = null;
      if (app !== (app = missing ? 'none' : 'lost')) chrome.storage.local.set({ app });
      badge().catch(() => {});
      // Retry quickly once (an app update or restart), then only on the 30 s alarm, so a host that can't start isn't relaunched every 5 s.
      if (!missing && !wasLost) retryTimer = setTimeout(connect, 5000);
      chrome.alarms.create('reconnect', { delayInMinutes: 0.5 });
    });
  } catch { retryTimer = setTimeout(connect, 5000); }
}
// Still rewrites this unpacked companion on disk when the app updates; reload to run the new files.
// Blocking rules and storage persist across the reload.
async function reloadIfUpdated() {
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (onDisk.version_name !== chrome.runtime.getManifest().version_name) chrome.runtime.reload();
  } catch { /* Mid-update or unreadable; the next alarm checks again. */ }
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') connect(); if (alarm.name === 'own-session') queueRefresh(); if (alarm.name === 'limits') { tick(); reloadIfUpdated(); } });
chrome.alarms.get('limits').then(alarm => { if (!alarm) chrome.alarms.create('limits', { periodInMinutes: 0.5 }); }).catch(() => {});
chrome.tabs.onActivated?.addListener(() => tick());
chrome.tabs.onRemoved?.addListener(() => tick());
chrome.windows?.onFocusChanged.addListener(() => tick());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(details => { connect(); if (details?.reason === 'install') chrome.runtime.openOptionsPage(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
// The settings page writes the extension's own settings; everything else follows from storage.
chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes.own) { own = Websites.own(changes.own.newValue); queueRefresh(); tick(); } });
// Also replaces the managed-policy error page, and covers cached/history navigation.
function navigation(details) {
  const target = details.error !== 'net::ERR_ABORTED' && details.frameId === 0 && destination(details.url);
  if (target) chrome.tabs.update(details.tabId, { url: target }).catch(() => {});
}
// A full page load starts (or stops) the clock now rather than at the next 30 s check.
chrome.webNavigation.onCommitted.addListener(details => { if (details.frameId === 0) tick(); });
chrome.webNavigation.onCommitted.addListener(navigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigation);
chrome.webNavigation.onErrorOccurred.addListener(navigation);
// Also releases a session of our own that ended while the browser was closed.
chrome.storage.local.get(['snapshot', 'limited', 'own']).then(value => { if (!latest) latest = value.snapshot; limited = value.limited || {}; own = Websites.own(value.own); queueRefresh(); connect(); });
