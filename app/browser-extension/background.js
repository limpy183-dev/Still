'use strict';
importScripts('websites.js');
let port, retryTimer, queue = Promise.resolve(), latest;
const ruleBase = 10000;
function rulesFor(snapshot) {
  return (snapshot.websites || []).flatMap((domain, index) => [
    { id: ruleBase + index * 2, priority: 2, action: { type: 'redirect', redirect: snapshot.screen?.mode === 'redirect' ? { url: snapshot.screen.redirect } : { extensionPath: '/blocked.html' } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame'] } },
    { id: ruleBase + index * 2 + 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: [domain] } }
  ]);
}
function isBlocked(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && latest?.websites?.some(domain => Websites.matches(parsed.hostname, domain)); } catch { return false; }
}
function destination() { return latest?.screen?.mode === 'redirect' ? latest.screen.redirect : chrome.runtime.getURL('blocked.html'); }
async function apply(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.websites) || snapshot.websites.length > 100 || snapshot.websites.some(host => Websites.domain(host) !== host)) throw Error('Invalid guard state');
  snapshot.screen = Websites.screen(snapshot.screen || {}, snapshot.websites.map(host => Websites.target(host)));
  const rules = rulesFor(snapshot), old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.filter(rule => rule.id >= ruleBase).map(rule => rule.id), addRules: rules });
  latest = snapshot;
  const privateReady = await chrome.extension.isAllowedIncognitoAccess();
  await chrome.storage.local.set({ snapshot, connected: true, privateReady });
  await chrome.action.setBadgeText({ text: !privateReady ? '!' : snapshot.websites.length ? 'ON' : '' });
  await chrome.action.setTitle({ title: !privateReady ? 'Still · enable incognito / InPrivate access in extension details' : snapshot.websites.length ? 'Still · websites blocked' : 'Still · connected, ready to focus' });
  // Existing tabs (including cached pages) must leave the blocked website too.
  if (snapshot.websites.length) for (const tab of await chrome.tabs.query({})) if (isBlocked(tab.url) || isBlocked(tab.pendingUrl)) await chrome.tabs.update(tab.id, { url: destination() }).catch(() => {});
  if (snapshot.sessionId && snapshot.websites.length && privateReady) port?.postMessage({ ready: snapshot.sessionId });
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
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('blocked.html') }));
// Also replaces the managed-policy error page, and covers cached/history navigation.
function navigation(details) {
  if (details.error !== 'net::ERR_ABORTED' && details.frameId === 0 && isBlocked(details.url)) chrome.tabs.update(details.tabId, { url: destination() }).catch(() => {});
}
chrome.webNavigation.onCommitted.addListener(navigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigation);
chrome.webNavigation.onErrorOccurred.addListener(navigation);
chrome.storage.local.get('snapshot').then(value => { if (!latest) latest = value.snapshot; connect(); });
