const path = require('node:path');
const protectedNames = new Set(['still', 'still.guard', 'electron', 'powershell', 'pwsh', 'cmd', 'conhost', 'explorer', 'taskmgr', 'regedit', 'sc', 'services', 'mmc', 'winlogon', 'csrss', 'lsass', 'svchost', 'wininit', 'dwm', 'sihost', 'userinit', 'smss', 'consent', 'runtimebroker', 'dllhost', 'rundll32']);
function allowedApp(app) {
  if (!app || typeof app.path !== 'string' || typeof app.name !== 'string') return false;
  if (app.path.startsWith('appx:')) return /^appx:[a-z0-9._-]+_[a-z0-9]+$/i.test(app.path) && !/Microsoft\.(WindowsStore|DesktopAppInstaller|SecHealthUI|WindowsTerminal)|OpenAI\.Codex/i.test(app.path);
  const file = path.win32.parse(app.path).name.toLowerCase();
  return path.win32.isAbsolute(app.path) && /\.exe$/i.test(app.path) && !/[\r\n*?]/.test(app.path)
    && !protectedNames.has(file) && !file.startsWith('still-') && !/\\Windows(?:Apps)?\\/i.test(app.path);
}
function validateSession(request) {
  if (!request || !Number.isInteger(request.durationMinutes) || request.durationMinutes < 1 || request.durationMinutes > 1440) throw new Error('Choose a duration from 1 to 1,440 minutes.');
  if (!Number.isInteger(request.unlockDelayMinutes) || request.unlockDelayMinutes < 0 || request.unlockDelayMinutes > 120) throw new Error('Choose a release delay from 0 to 120 minutes.');
  if (!Array.isArray(request.apps) || !request.apps.length || request.apps.length > 100 || !request.apps.every(allowedApp)) throw new Error('Select between 1 and 100 desktop applications. Windows components cannot be blocked.');
  return { durationMinutes: request.durationMinutes, unlockDelayMinutes: request.unlockDelayMinutes, intention: String(request.intention || 'Time to focus').slice(0, 120), apps: request.apps.map(a => ({ name: a.name.slice(0, 100), path: a.path })) };
}
function validatePreferences(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid preferences.');
  return {
    todos: (Array.isArray(value.todos) ? value.todos : []).filter(item => item && typeof item.text === 'string').slice(0, 500).map(item => ({ text: item.text.slice(0, 2000), type: ['checkbox', 'circle', 'bullet', 'number', 'heading', 'note'].includes(item.type) ? item.type : 'checkbox', done: item.done === true })),
    apps: (Array.isArray(value.apps) ? value.apps : []).filter(allowedApp).slice(0, 300).map(a => ({ name: a.name.slice(0, 100), path: a.path })),
    selected: (Array.isArray(value.selected) ? value.selected : []).filter(s => typeof s === 'string').slice(0, 100),
    groups: (Array.isArray(value.groups) ? value.groups : []).filter(g => g && typeof g === 'object').slice(0, 20).map(g => ({ name: String(g.name).slice(0, 40), paths: (Array.isArray(g.paths) ? g.paths : []).filter(p => typeof p === 'string').slice(0, 100) })),
    duration: Math.max(1, Math.min(1440, Number(value.duration) || 50)),
    delay: Math.max(1, Math.min(120, Number(value.delay) || 5)),
    delayEnabled: value.delayEnabled !== false,
    progressDays: [7, 30, 90].includes(value.progressDays) ? value.progressDays : 30,
    progressMetric: ['minutes', 'sessions'].includes(value.progressMetric) ? value.progressMetric : 'minutes',
    dailyGoal: Math.max(1, Math.min(1440, Math.round(Number(value.dailyGoal) || 60))),
    showIntentions: value.showIntentions !== false,
    intention: String(value.intention || '').slice(0, 120),
    notifications: value.notifications !== false,
    reducedMotion: value.reducedMotion === true,
    launchAtLogin: value.launchAtLogin === true
  };
}
module.exports = { allowedApp, validateSession, validatePreferences };
