'use strict';
importScripts('websites.js');
let port, retryTimer, queue = Promise.resolve(), latest, limited = {};
const ruleBase = 10000, limitBase = 20000;
function rulesFor(snapshot) {
  return (snapshot?.websites || []).flatMap((domain, index) => [
    { id: ruleBase + index * 2, priority: 2, action: { type: 'redirect', redirect: snapshot.screen?.mode === 'redirect' ? { url: snapshot.screen.redirect } : { extensionPath: '/blocked.html' } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame'] } },
    { id: ruleBase + index * 2 + 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: [domain] } }
  ]);
}
// Daily limits and bedtime only hold top-level pages; embeds elsewhere keep working.
const limitPage = domain => '/blocked.html?' + new URLSearchParams({ why: limited[domain], site: domain });
const limitRules = () => Object.keys(limited).map((domain, index) => ({ id: limitBase + index, priority: 1, action: { type: 'redirect', redirect: { extensionPath: limitPage(domain) } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame'] } }));
async function syncRules(snapshot) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.filter(rule => rule.id >= ruleBase).map(rule => rule.id), addRules: [...rulesFor(snapshot), ...limitRules()] });
}
const hostOf = url => { try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : null; } catch { return null; } };
const limitedDomain = url => { const host = hostOf(url); return host && Object.keys(limited).find(domain => Websites.matches(host, domain)); };
function isBlocked(url) { const host = hostOf(url); return !!host && !!latest?.websites?.some(domain => Websites.matches(host, domain)); }
function destination(url) {
  if (isBlocked(url)) return latest?.screen?.mode === 'redirect' ? latest.screen.redirect : chrome.runtime.getURL('blocked.html');
  const domain = limitedDomain(url); return domain ? chrome.runtime.getURL(limitPage(domain).slice(1)) : null;
}
// ponytail: counts the focused window's active tab in 30 s steps, so limits are accurate to ~30 s.
async function tickLimits() {
  const stored = await chrome.storage.local.get(['limits', 'usage', 'lastTick', 'lastSite']), config = Websites.limits(stored.limits), now = Date.now(), day = new Date().toDateString();
  const usage = stored.usage?.day === day ? stored.usage : { day, seconds: {} };
  // Time since the last tick belongs to the site that was in front then. Sleep/gaps count at most 60 s.
  if (stored.lastSite && stored.lastTick && usage === stored.usage) usage.seconds[stored.lastSite] = (usage.seconds[stored.lastSite] || 0) + Math.min(60, Math.max(0, (now - stored.lastTick) / 1000));
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const focused = tab && (await chrome.windows.get(tab.windowId).catch(() => null))?.focused, host = focused && hostOf(tab.url);
  const site = host && config.sites.find(item => item.minutes && Websites.matches(host, item.domain));
  await chrome.storage.local.set({ usage, lastTick: now, lastSite: site?.domain || null });
  const next = Websites.limitBlocks(config, usage.seconds, new Date(now));
  if (JSON.stringify(next) === JSON.stringify(limited)) return;
  limited = next; await chrome.storage.local.set({ limited });
  await syncRules(latest);
  for (const open of await chrome.tabs.query({})) { const target = limitedDomain(open.url) && destination(open.url); if (target) await chrome.tabs.update(open.id, { url: target }).catch(() => {}); }
}
const tick = () => { queue = queue.catch(() => {}).then(tickLimits).catch(console.error); return queue; };
async function apply(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.websites) || snapshot.websites.length > 100 || snapshot.websites.some(host => Websites.domain(host) !== host)) throw Error('Invalid guard state');
  snapshot.screen = Websites.screen(snapshot.screen || {}, snapshot.websites.map(host => Websites.target(host)));
  // A missing value means preferences were unreadable; keep the last limits.
  if (snapshot.limits) await chrome.storage.local.set({ limits: Websites.limits(snapshot.limits) });
  delete snapshot.limits;
  await syncRules(snapshot);
  latest = snapshot;
  const privateReady = await chrome.extension.isAllowedIncognitoAccess();
  await chrome.storage.local.set({ snapshot, connected: true, privateReady });
  await chrome.action.setBadgeText({ text: !privateReady ? '!' : snapshot.websites.length ? 'ON' : '' });
  await chrome.action.setTitle({ title: !privateReady ? 'Still · enable incognito / InPrivate access in extension details' : snapshot.websites.length ? 'Still · websites blocked' : 'Still · connected, ready to focus' });
  // Existing tabs (including cached pages) must leave the blocked website too.
  if (snapshot.websites.length) for (const tab of await chrome.tabs.query({})) if (isBlocked(tab.url) || isBlocked(tab.pendingUrl)) await chrome.tabs.update(tab.id, { url: destination(tab.url) || destination(tab.pendingUrl) }).catch(() => {});
  if (snapshot.sessionId && snapshot.websites.length && privateReady) port?.postMessage({ ready: snapshot.sessionId });
  tick();
}
function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  try {
    port = chrome.runtime.connectNative('app.still.focus');
    port.onMessage.addListener(snapshot => { queue = queue.catch(() => {}).then(() => apply(snapshot)).catch(error => { console.error(error); chrome.action.setBadgeText({ text: '!' }); }); });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; port = null;
      chrome.storage.local.set({ connected: false });
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setTitle({ title: 'Still · reconnect Windows protection; existing blocks stay in place' });
      retryTimer = setTimeout(connect, 5000);
      chrome.alarms.create('reconnect', { delayInMinutes: 0.5 });
    });
  } catch { retryTimer = setTimeout(connect, 5000); }
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') connect(); if (alarm.name === 'limits') tick(); });
chrome.alarms.get('limits').then(alarm => { if (!alarm) chrome.alarms.create('limits', { periodInMinutes: 0.5 }); }).catch(() => {});
chrome.tabs.onActivated?.addListener(() => tick());
chrome.windows?.onFocusChanged.addListener(() => tick());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('blocked.html') }));
// Also replaces the managed-policy error page, and covers cached/history navigation.
function navigation(details) {
  const target = details.error !== 'net::ERR_ABORTED' && details.frameId === 0 && destination(details.url);
  if (target) chrome.tabs.update(details.tabId, { url: target }).catch(() => {});
}
chrome.webNavigation.onCommitted.addListener(navigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigation);
chrome.webNavigation.onErrorOccurred.addListener(navigation);
chrome.storage.local.get(['snapshot', 'limited']).then(value => { if (!latest) latest = value.snapshot; limited = value.limited || {}; connect(); });
