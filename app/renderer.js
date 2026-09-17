'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sampleApps = [
  { name: 'Discord', path: 'C:\\StillPreview\\Discord.exe', category: 'Social & communication' },
  { name: 'Steam', path: 'C:\\StillPreview\\steam.exe', category: 'Games & entertainment' },
  { name: 'Google Chrome', path: 'C:\\StillPreview\\chrome.exe', category: 'Browser' },
  { name: 'Spotify', path: 'C:\\StillPreview\\Spotify.exe', category: 'Music & entertainment' },
  { name: 'Epic Games Launcher', path: 'C:\\StillPreview\\EpicGamesLauncher.exe', category: 'Games & entertainment' },
  { name: 'Minecraft', path: 'C:\\StillPreview\\Minecraft.exe', category: 'Games & entertainment' }
];
// The browser preview is explicitly labelled and never connects to Windows protection.
function browserPreview() {
  const current = { installed: false, demo: true, session: null, history: [], now: Date.now() };
  const status = async () => {
    if (current.session && Date.now() >= current.session.endsAt) { current.history.unshift({ ...current.session, finishedAt: Date.now(), outcome: 'completed' }); current.session = null; }
    return { ...current, now: Date.now() };
  };
  return {
    updateHistory: async (id, action) => {
      const record = current.history.find(s => s.id === id);
      if (!record) throw Error('Saved session not found.');
      if (action === 'delete') current.history = current.history.filter(s => s.id !== id);
      else record.archived = action === 'archive';
      return status();
    },
    bootstrap: async () => ({ ...(await status()), preferences: {}, apps: sampleApps }), status,
    savePreferences: async value => value, discover: async () => sampleApps, browse: async () => [],
    install: async () => { current.installed = true; return status(); },
    uninstall: async () => { current.installed = false; return status(); },
    start: async data => {
      if (current.session) throw Error('A session is already running.');
      current.session = { ...data, id: 'preview-' + Date.now(), startedAt: Date.now(), endsAt: Date.now() + data.durationMinutes * 60000, unlockAt: 0, phase: 'active' };
      return status();
    },
    requestUnlock: async () => { if (!current.session.unlockAt) current.session.unlockAt = Date.now() + current.session.unlockDelayMinutes * 60000; return status(); },
    cancelUnlock: async () => { current.session.unlockAt = 0; return status(); },
    end: async () => {
      if (current.session.unlockDelayMinutes && (!current.session.unlockAt || Date.now() < current.session.unlockAt)) throw Error('The release waiting period has not finished.');
      current.history.unshift({ ...current.session, finishedAt: Date.now(), outcome: 'ended-early' }); current.session = null; return status();
    },
    window: async () => {}, exportHistory: async () => { throw Error('History export is available in the Windows app.'); },
    onStatus: callback => { setInterval(async () => callback(await status()), 2000); }, openGuide: async () => {}
  };
}
const api = window.still || browserPreview();
let apps = [], selected = new Set(), groups = [], page = 'focus', busy = false, scanning = false, toastTimer, saveQueue = Promise.resolve();
let state = { installed: false, session: null, history: [], demo: !window.still, error: null, unavailable: false };
let prefs = { duration: 50, delay: 5, delayEnabled: true, intention: '', notifications: true, reducedMotion: false, launchAtLogin: false };
let historyFilter = 'active';
let offset = 0, lastSignature = '', pickerSelection = new Set(), confirmAction;
const now = () => Date.now() + offset;
const formatClock = milliseconds => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const readableTime = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ''}`.trim() : `${minutes}m`;
function toast(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `toast visible${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), error ? 8000 : 4000);
}
async function act(fn, button) {
  if (busy) return;
  busy = true; if (button) { button.classList.add('busy'); button.disabled = true; }
  try { return await fn(); } catch (error) { toast(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
  finally { busy = false; if (button) { button.classList.remove('busy'); button.disabled = false; } renderSession(); }
}
function save() {
  const value = { ...prefs, todos: (prefs.todos || []).map(item => ({ ...item })), apps: apps.map(({ name, path }) => ({ name, path })), selected: [...selected], groups };
  $('#todo-save-status').textContent = 'Saving…';
  saveQueue = saveQueue.catch(() => {}).then(() => api.savePreferences(value)).then(() => { $('#todo-save-status').textContent = window.still ? 'Saved on this PC' : 'Preview only · not saved'; }).catch(() => { $('#todo-save-status').textContent = 'Not saved · edit again to retry'; toast('Your preferences could not be saved. Check available disk space.', true); });
}
function showPage(next) {
  page = next;
  $$('.page').forEach(el => el.classList.toggle('active', el.id === `page-${next}`));
  $$('.nav-item[data-page]').forEach(el => { el.classList.toggle('active', el.dataset.page === next); el.setAttribute('aria-current', el.dataset.page === next ? 'page' : 'false'); });
  $('#page-crumb').textContent = { focus: 'Focus space', todos: 'To-do list', library: 'App library', history: 'Your progress', settings: 'Settings' }[next];
  closeTodoMenu();
  if (next === 'library') renderLibrary(); if (next === 'history') renderHistory();
  window.scrollTo({ top: 0 });
}
document.addEventListener('error', event => {
  if (event.target.matches?.('.app-icon img')) event.target.parentElement.innerHTML = icon('grid');
}, true);
function appIcon(target, index) {
  return `<span class="app-icon tone-${index % 5}">${target.icon && /^data:image\//.test(target.icon) ? `<img src="${escapeHtml(target.icon)}" alt="">` : icon('grid')}</span>`;
}
function category(target) {
  if (target.category) return target.category;
  if (target.path.startsWith('appx:')) return 'Microsoft Store app';
  if (/steam|epic|game|minecraft|riot|battle|ubisoft|xbox/i.test(target.name)) return 'Games & entertainment';
  if (/discord|slack|teams|telegram|whatsapp/i.test(target.name)) return 'Social & communication';
  if (/chrome|firefox|edge|opera|brave/i.test(target.name)) return 'Browser';
  if (/spotify|music|vlc/i.test(target.name)) return 'Music & entertainment';
  return 'Desktop application';
}
function appRow(target, index, checked, context, locked = false) {
  return `<button class="app-row${checked ? ' selected' : ''}${locked && checked ? ' locked' : ''}" data-app="${escapeHtml(target.path)}" data-context="${context}" ${locked ? 'disabled' : ''} role="checkbox" aria-checked="${checked}" aria-label="${escapeHtml(target.name)}${locked ? checked ? ', blocked for this session' : ', not part of this session' : ''}" title="${escapeHtml(target.path)}">${appIcon(target, index)}<span class="app-info"><span class="app-name">${escapeHtml(target.name)}</span><span class="app-subtitle">${escapeHtml(context === 'selected' ? category(target) : target.path)}</span></span><span class="check-box">${icon(locked && checked ? 'lock' : 'check')}</span></button>`;
}
function empty(title, description, symbol = 'leaf') {
  return `<div class="empty-state">${icon(symbol)}<strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
}
function mergeApps(incoming) {
  const all = new Map(apps.map(a => [a.path.toLowerCase(), a]));
  for (const target of incoming) if (target?.path && target?.name) all.set(target.path.toLowerCase(), { ...all.get(target.path.toLowerCase()), ...target });
  apps = [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function renderApps() {
  const visible = state.session ? state.session.apps.map(a => ({ ...apps.find(b => b.path.toLowerCase() === a.path.toLowerCase()), ...a })) : apps.filter(a => selected.has(a.path));
  $('#selected-count').textContent = visible.length;
  $('#library-count').textContent = apps.length;
  $('#selected-apps').innerHTML = visible.length ? visible.map((a, i) => appRow(a, i, true, 'selected', !!state.session)).join('') : empty('A little less distraction starts here.', 'Choose the apps and games you’d like to put on hold.', 'grid');
  $('#choose-apps').innerHTML = state.session ? `${icon('lock')} Your selection is fixed for this session` : `${icon('plus')} ${visible.length ? 'Add apps & games' : 'Choose apps & games'}`;
  $('#choose-apps').disabled = !!state.session; $('#add-apps').disabled = !!state.session;
  $('#group-row').innerHTML = groups.slice(0, 4).map((g, i) => `<button class="group-chip" data-group="${i}" ${state.session ? 'disabled' : ''}>${icon('folder')}${escapeHtml(g.name)}</button>`).join('');
  if (page === 'library') renderLibrary();
}
function renderLibrary() {
  const search = $('#library-search').value.toLowerCase();
  const visible = apps.filter(a => `${a.name} ${a.path}`.toLowerCase().includes(search));
  $('#library-list').innerHTML = visible.length ? visible.map((a, i) => appRow(a, i, state.session ? state.session.apps.some(s => s.path.toLowerCase() === a.path.toLowerCase()) : selected.has(a.path), 'library', !!state.session)).join('') : empty(apps.length ? 'Nothing by that name.' : 'Your collection starts with one app.', apps.length ? 'Try another search, or add the executable yourself.' : 'Add the apps that tend to pull your attention away.', 'grid');
  $('#saved-groups').innerHTML = groups.map((g, i) => `<div class="saved-group"><button data-group="${i}" ${state.session ? 'disabled' : ''}>${icon('folder')}${escapeHtml(g.name)}<small>${g.paths.length} apps</small></button><button class="icon-button" data-delete-group="${i}" aria-label="Delete group ${escapeHtml(g.name)}" ${state.session ? 'disabled' : ''}>${icon('close')}</button></div>`).join('');
  $('#library-add').disabled = !!state.session; $('#save-group').disabled = !!state.session;
}
function renderPicker() {
  const search = $('#picker-search').value.toLowerCase();
  const visible = apps.filter(a => `${a.name} ${a.path}`.toLowerCase().includes(search));
  $('#picker-list').innerHTML = scanning && !apps.length ? '<div class="empty-state"><span class="spinner"></span><strong>Finding your applications…</strong><p>A little less noise is on its way.</p></div>' : visible.length ? visible.map((a, i) => appRow(a, i, pickerSelection.has(a.path), 'picker')).join('') : empty('Nothing here just yet.', 'Browse to an .exe file, or rescan your installed apps.', 'search');
  $('#picker-count').textContent = `${pickerSelection.size} application${pickerSelection.size === 1 ? '' : 's'} selected`;
  $('#refresh-apps').classList.toggle('busy', scanning);
}
async function scan() {
  if (scanning) return; scanning = true; renderPicker();
  try { mergeApps(state.demo ? sampleApps : await api.discover()); save(); renderApps(); }
  catch (error) { toast(error.message, true); }
  finally { scanning = false; renderPicker(); }
}
function openPicker() {
  if (state.session) return;
  pickerSelection = new Set(selected); $('#picker-search').value = ''; renderPicker(); $('#picker-dialog').showModal();
  if (!apps.length) scan();
}
function confirmation(title, body, label, fn) {
  $('#confirm-title').textContent = title; $('#confirm-body').innerHTML = body;
  $('#confirm-accept').innerHTML = `${escapeHtml(label)} ${icon('arrow')}`; confirmAction = fn;
  $('#confirm-cancel').hidden = !fn;
  $('#confirm-dialog').showModal();
}
function applyStatus(value) {
  if (typeof value.now === 'number') offset = value.now - Date.now();
  if (value.unavailable) {
    state = { ...state, installed: false, unavailable: true, error: value.error };
  } else state = { ...state, ...value, unavailable: false };
  const signature = JSON.stringify([state.installed, state.unavailable, state.session, state.error, state.history]);
  if (signature !== lastSignature) { lastSignature = signature; renderSession(); renderApps(); renderStats(); if (page === 'history') renderHistory(); }
  updateTimer();
}
function renderSession() {
  const session = state.session;
  $('.focus-card').classList.toggle('running', !!session);
  $('#session-setup').hidden = !!session; $('#active-details').hidden = !session;
  $('#session-title').textContent = session ? 'Right here. Right now.' : 'Settle into focus';
  $('#session-tag').innerHTML = `<span class="tiny-dot"></span> ${session ? (state.unavailable ? 'CONNECTION LOST' : session.phase === 'releasing' ? 'RELEASING APPS' : 'FOCUS IN PROGRESS') : 'YOUR NEXT SESSION'}`;
  $('#timer-top').textContent = session ? 'ONE THING AT A TIME' : 'TIME FOR YOURSELF';
  $('#timer-bottom').innerHTML = `<span class="tiny-dot"></span> ${session ? 'You’re making room for what matters' : 'A fresh start awaits'}`;
  $('#start-caption').innerHTML = `${icon(session ? 'shield' : 'lock')} ${session ? 'Closing this window won’t end your session.' : 'Your selected apps will be closed and blocked.'}`;
  $('#delay-enabled').disabled = !!session; $('#delay').disabled = !!session || !prefs.delayEnabled;
  if (session) {
    $('#delay-enabled').checked = session.unlockDelayMinutes > 0;
    $('#delay').value = session.unlockDelayMinutes || prefs.delay;
    $('#active-intention').textContent = session.intention || 'Space for what matters.';
    $('#active-description').textContent = `${session.apps.length} application${session.apps.length === 1 ? '' : 's'} on hold. Your attention is yours again.`;
    $('#active-end').textContent = `Until ${new Date(session.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    $('#unlock-info').hidden = !session.unlockAt;
  } else { $('#delay-enabled').checked = prefs.delayEnabled; $('#delay').value = prefs.delay; }
  const statusText = session ? state.unavailable ? 'Check protection' : 'Focus protected' : state.installed ? 'Protection ready' : 'Set up protection';
  $('#protection-status').innerHTML = `<span class="tiny-dot"></span><span>${statusText}</span>${icon(state.installed ? 'shield' : 'arrow')}`;
  $('#protection-status').className = `status-pill${state.installed ? ' ready' : ''}${session && state.installed ? ' live' : ''}`;
  $('#settings-status').textContent = state.installed ? 'GUARD CONNECTED' : 'GUARD NOT CONNECTED';
  $('#install-guard').hidden = state.installed; $('#remove-guard').hidden = !state.installed;
  $('#remove-guard').disabled = !!session;
  $('#delay-note').textContent = session ? (session.unlockDelayMinutes ? 'Your waiting period is locked for this session.' : 'No waiting period for this session.') : prefs.delayEnabled ? 'Set before you start. Fixed while you focus.' : 'You can end your session immediately.';
  $('#connection-banner').hidden = !(state.error || (state.unavailable && session));
  $('#connection-banner').textContent = state.unavailable && session ? 'Still can’t reach Windows protection. This is the last known session; the block status is unverified. Reconnect the guard before making changes.' : state.error || '';
  $('#preview-banner').hidden = !state.demo;
  $('#start-button').disabled = busy || (!!session && (state.unavailable || session.phase !== 'active'));
  updateTimer();
}
function updateTimer() {
  const session = state.session;
  const remaining = session ? session.endsAt - now() : prefs.duration * 60000;
  const [minutes, seconds] = formatClock(remaining).split(':');
  $('#timer-number').innerHTML = `${minutes}<span>:${seconds}</span>`;
  const fraction = session ? Math.max(0, Math.min(1, remaining / (session.durationMinutes * 60000))) : 1;
  $('#ring-progress').style.strokeDashoffset = String(754 * (1 - fraction));
  const label = $('#start-button span');
  if (!session) label.textContent = 'Start focusing';
  else if (session.phase === 'releasing') label.textContent = 'Releasing your applications…';
  else if (session.unlockAt && now() < session.unlockAt) label.textContent = `Release available in ${formatClock(session.unlockAt - now())}`;
  else if (session.unlockAt || !session.unlockDelayMinutes) label.textContent = 'End focus session';
  else label.textContent = `Request to end · ${session.unlockDelayMinutes} min wait`;
  if (session?.unlockAt) {
    $('#unlock-countdown').textContent = now() < session.unlockAt ? formatClock(session.unlockAt - now()) : 'You can end your session now.';
    $('#start-button').disabled = busy || state.unavailable || session.phase !== 'active' || now() < session.unlockAt;
  }
}
function focusMilliseconds(session, from = 0, to = now()) {
  if (!session || ['failed', 'interrupted', 'recovered'].includes(session.outcome)) return 0;
  return Math.max(0, Math.min(session.finishedAt || now(), session.endsAt, to) - Math.max(session.startedAt, from));
}
function renderStats() {
  const records = [...state.history, ...(state.session ? [state.session] : [])];
  const day = new Date(now()); day.setHours(0, 0, 0, 0);
  $('#today-minutes').textContent = Math.floor(records.reduce((sum, s) => sum + focusMilliseconds(s, +day), 0) / 60000);
  const days = Array.from({ length: 7 }, (_, i) => { const start = new Date(day); start.setDate(start.getDate() - (6 - i)); const end = new Date(start); end.setDate(end.getDate() + 1); return { date: start, minutes: Math.floor(records.reduce((sum, s) => sum + focusMilliseconds(s, +start, +end), 0) / 60000) }; });
  const max = Math.max(30, ...days.map(d => d.minutes));
  $('#week-bars').innerHTML = days.map((d, i) => `<span class="mini-bar${i === 6 ? ' today' : ''}" title="${d.date.toLocaleDateString([], { weekday: 'long' })}: ${d.minutes} minutes"></span>`).join('');
  $$('.mini-bar').forEach((bar, i) => bar.style.height = `${Math.max(4, days[i].minutes / max * 38)}px`);
  const total = Math.floor(records.reduce((sum, s) => sum + focusMilliseconds(s), 0) / 60000);
  $('#total-time').textContent = readableTime(total);
  $('#total-completed').textContent = state.history.filter(s => s.outcome === 'completed').length;
  const weekStart = new Date(day); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  renderProgress();
  $('#week-time').textContent = readableTime(Math.floor(records.reduce((sum, s) => sum + focusMilliseconds(s, +weekStart), 0) / 60000));
}
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

function renderSessionCalendar() {
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const records = [...state.history, ...(state.session ? [state.session] : [])];
  const counts = new Map();
  for (const record of records) {
    const date = new Date(record.startedAt);
    if (date.getFullYear() === year && date.getMonth() === month) counts.set(date.getDate(), (counts.get(date.getDate()) || 0) + 1);
  }
  $('#calendar-month').textContent = calendarMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => '<span class="calendar-weekday">' + day + '</span>').join('');
  const blanks = '<span aria-hidden="true"></span>'.repeat((calendarMonth.getDay() + 6) % 7);
  const today = new Date(now()).toDateString();
  const dates = Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => {
    const day = i + 1, count = counts.get(day) || 0, date = new Date(year, month, day);
    const label = escapeHtml(date.toLocaleDateString([], { dateStyle: 'long' }) + ': ' + count + ' focus session' + (count === 1 ? '' : 's') + ' created');
    return '<span class="calendar-day' + (count ? ' has-session' : '') + '" title="' + label + '" aria-label="' + label + '"' + (date.toDateString() === today ? ' aria-current="date"' : '') + '>' + day + (count ? '<span class="session-dot" aria-hidden="true"></span>' : '') + '</span>';
  }).join('');
  $('#progress-calendar').innerHTML = weekdays + blanks + dates;
}

for (const [id, offset] of [['calendar-previous', -1], ['calendar-next', 1]]) {
  $('#' + id).onclick = () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
    renderSessionCalendar();
  };
}

function renderProgress() {
  const count = prefs.progressDays || 30, goal = prefs.dailyGoal || 60;
  const today = new Date(now()); today.setHours(0, 0, 0, 0);
  const records = [...state.history, ...(state.session ? [state.session] : [])];
  const days = Array.from({ length: count }, (_, i) => {
    const start = new Date(today); start.setDate(start.getDate() - count + 1 + i);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start: +start, end: +end, label: start.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      minutes: records.reduce((sum, r) => sum + focusMilliseconds(r, +start, +end), 0) / 60000,
      sessions: state.history.filter(r => r.outcome === 'completed' && r.finishedAt >= +start && r.finishedAt < +end).length };
  });
  const finished = state.history.filter(r => r.finishedAt >= days[0].start && r.finishedAt <= now() && ['completed', 'ended-early'].includes(r.outcome));
  const completed = finished.filter(r => r.outcome === 'completed').length;
  const activeDays = days.filter(d => d.minutes > 0).length;
  const goalDays = days.filter(d => d.minutes >= goal).length;
  const average = finished.length ? Math.floor(finished.reduce((sum, r) => sum + focusMilliseconds(r), 0) / finished.length / 60000) : 0;
  $('#progress-summary').innerHTML = [[`${activeDays}/${count}`, 'Days with focus'], [`${goalDays}`, 'Daily goals met'], [finished.length ? `${Math.round(completed / finished.length * 100)}%` : ' - ', 'Completion rate'], [readableTime(average), 'Average finished session']].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join('');
  const metric = prefs.progressMetric || 'minutes';
  const max = Math.max(1, ...days.map(d => d[metric]));
  $('#trend-title').textContent = metric === 'minutes' ? 'Daily focus minutes' : 'Daily completed sessions';
  $('#trend-scale').textContent = `0 - ${Math.ceil(max)} ${metric}  -  ${days[0].label} - ${days.at(-1).label}`;
  $('#progress-chart').innerHTML = days.map(d => `<div class="trend-day"><div class="trend-track"><button class="trend-bar" aria-label="${d.label}: ${Math.floor(d[metric])} ${metric}" title="${d.label}: ${Math.floor(d[metric])} ${metric}"></button></div></div>`).join('');
  $$('.trend-bar').forEach((bar, i) => { bar.style.height = `${Math.max(2, days[i][metric] / max * 100)}%`; });
  renderSessionCalendar();
  const intentions = new Map();
  for (const r of records) { const minutes = focusMilliseconds(r, days[0].start) / 60000; if (minutes > 0) intentions.set(r.intention || 'Time to focus', (intentions.get(r.intention || 'Time to focus') || 0) + minutes); }
  const ranked = [...intentions].sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#progress-intentions').hidden = prefs.showIntentions === false;
  $('#progress-intentions').innerHTML = '<h3>Where your attention went</h3>' + (ranked.length ? ranked.map(([label, minutes]) => `<div class="intention-progress"><span>${escapeHtml(label)}</span><progress max="${ranked[0][1]}" value="${minutes}" aria-label="${escapeHtml(label)}"></progress><strong>${readableTime(Math.floor(minutes))}</strong></div>`).join('') : '<p class="progress-note">Give your next session an intention to see your focus take shape here.</p>');
}
$('#history-filter').onchange = event => { historyFilter = event.target.value; renderHistory(); };
for (const [id, key] of [['progress-days', 'progressDays'], ['progress-metric', 'progressMetric'], ['daily-goal', 'dailyGoal'], ['show-intentions', 'showIntentions']]) {
  $(`#${id}`).onchange = event => {
    if (!event.target.checkValidity()) { event.target.reportValidity(); return; }
    prefs[key] = event.target.type === 'checkbox' ? event.target.checked : key === 'progressMetric' ? event.target.value : Number(event.target.value);
    renderProgress(); save();
  };
}
function renderHistory() {
  renderStats();
  const visible = state.history.filter(s => historyFilter === 'all' || !!s.archived === (historyFilter === 'archived'));
  $('#history-count').textContent = `${visible.length} sessions`;
  $('#history-list').innerHTML = visible.length ? visible.map(s => `<div class="history-row"><span class="history-symbol">${icon(s.outcome === 'completed' ? 'check' : 'clock')}</span><div><h3>${escapeHtml(s.intention || 'Time to focus')}</h3><p>${new Date(s.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${s.apps.length} apps put on hold</p></div><strong>${Math.floor(focusMilliseconds(s) / 60000)}m</strong><span class="history-outcome${s.outcome !== 'completed' ? ' early' : ''}">${escapeHtml(({ completed: 'Completed', 'ended-early': 'Ended early', failed: 'Not started', interrupted: 'Interrupted', recovered: 'Recovered' })[s.outcome] || s.outcome)}</span><div class="history-actions"><button class="text-button" data-history-action="${s.archived ? 'restore' : 'archive'}" data-id="${escapeHtml(s.id)}" ${state.unavailable ? 'disabled' : ''}>${s.archived ? 'Restore' : 'Archive'}</button><button class="text-button danger" data-history-action="delete" data-id="${escapeHtml(s.id)}" ${state.unavailable ? 'disabled' : ''}>Delete</button></div></div>`).join('') : empty('No sessions in this view.', 'Your saved sessions will appear here. Try another view to find archived sessions.', 'leaf');
}
function setupProtection() {
  if (state.installed) { showPage('settings'); return; }
  confirmation('Make a little room for focus.', `<p>${state.demo ? 'This is a preview. Enabling protection here will simulate the experience without blocking any apps.' : 'Windows will ask for administrator approval to install Still Guard. The service keeps your sessions protected after closing Still and across restarts.'}</p><p>Still supports desktop apps and games on an updated, unmanaged Windows PC. Existing application-control policies are left alone.</p>`, state.demo ? 'Enable preview' : 'Enable protection', async () => {
    const result = await api.install(); applyStatus(result);
    if (!result.installed) throw new Error('The guard did not connect. Open Settings or consult the guidance to check the service.');
    toast(state.demo ? 'Preview protection is ready. No real apps will be blocked.' : 'Windows protection is ready. Your next session is yours.');
  });
}
function startOrEnd() {
  const session = state.session;
  if (session) {
    if (session.unlockAt && now() < session.unlockAt) return;
    if (session.unlockDelayMinutes && !session.unlockAt) {
      confirmation('Give the urge a little space.', `<p>Your apps will stay blocked for another <strong>${session.unlockDelayMinutes} minutes</strong> before you can end this session early. If your session ends sooner, apps are released at the original end time.</p><p>You can cancel the request and keep focusing at any point.</p>`, 'Start the waiting period', async () => { applyStatus(await api.requestUnlock()); });
    } else confirmation('Ready to come back?', '<p>Your apps will be available again. The time you made for yourself still counts.</p>', 'End session', async () => { applyStatus(await api.end()); toast('A little focus goes a long way. Welcome back.'); });
    return;
  }
  if (!selected.size) { openPicker(); return; }
  if (!Number.isInteger(prefs.duration) || prefs.duration < 1 || prefs.duration > 1440) { toast('Choose a whole number from 1 to 1,440 minutes.', true); $('#duration').focus(); return; }
  if (prefs.delayEnabled && (!Number.isInteger(prefs.delay) || prefs.delay < 1 || prefs.delay > 120)) { toast('Choose a waiting period from 1 to 120 minutes.', true); $('#delay').focus(); return; }
  if (!state.installed) { setupProtection(); return; }
  confirmation('A small commitment to yourself.', `<p>${state.demo ? 'This preview will simulate a focus session. No applications will be closed or blocked.' : 'Save any open work in your selected apps. Still will close them and block them from launching for this session.'}</p><div class="confirm-detail"><span>Time to focus</span><strong>${prefs.duration} minutes</strong></div><div class="confirm-detail"><span>Apps put on hold</span><strong>${selected.size} applications</strong></div><div class="confirm-detail"><span>Wait before ending early</span><strong>${prefs.delayEnabled ? `${prefs.delay} minutes` : 'No waiting period'}</strong></div><p>Closing this window won’t end your session. The duration, selection, and waiting period stay fixed until it ends.</p>`, 'Start my session', async () => {
    const response = await api.start({ durationMinutes: prefs.duration, unlockDelayMinutes: prefs.delayEnabled ? prefs.delay : 0, intention: prefs.intention || 'Space for what matters.', apps: apps.filter(a => selected.has(a.path)).map(({ name, path }) => ({ name, path })) });
    applyStatus(response); toast('Take a breath. You’re right where you need to be.');
  });
}

document.addEventListener('click', event => {
  const historyAction = event.target.closest('[data-history-action]');
  if (historyAction) {
    const { id, historyAction: action } = historyAction.dataset;
    const update = async () => { applyStatus(await api.updateHistory(id, action)); toast(action === 'delete' ? 'Session deleted. Progress updated.' : action === 'archive' ? 'Session archived. Your progress still counts.' : 'Session restored.'); };
    if (action === 'delete') {
      const record = state.history.find(s => s.id === id);
      confirmation('Permanently delete this session?', `<p><strong>${escapeHtml(record?.intention || 'Time to focus')}</strong></p><p>This removes the session and its contribution to all progress charts, totals, and goals. This cannot be undone. Archive it instead to keep its progress.</p>`, 'Delete permanently', update);
    } else act(update, historyAction);
  }
  const nav = event.target.closest('[data-page]'); if (nav) showPage(nav.dataset.page);
  const windowButton = event.target.closest('[data-window]'); if (windowButton) api.window(windowButton.dataset.window);
  const close = event.target.closest('[data-close]'); if (close) close.closest('dialog').close();
  const duration = event.target.closest('[data-duration]'); if (duration && !state.session) {
    prefs.duration = Number(duration.dataset.duration); $('#duration').value = prefs.duration;
    $$('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === prefs.duration)); updateTimer(); save();
  }
  const row = event.target.closest('[data-app]');
  if (row && !state.session) {
    const collection = row.dataset.context === 'picker' ? pickerSelection : selected;
    if (collection.has(row.dataset.app)) collection.delete(row.dataset.app);
    else { if (collection.size >= 100) return toast('A session can contain up to 100 applications.', true); collection.add(row.dataset.app); }
    // Keep keyboard focus on the same row when its checked state changes.
    if (row.dataset.context === 'picker') { row.classList.toggle('selected', collection.has(row.dataset.app)); row.setAttribute('aria-checked', collection.has(row.dataset.app)); $('#picker-count').textContent = `${collection.size} applications selected`; }
    else { const target = row.dataset.app; const context = row.dataset.context; renderApps(); save(); if (context === 'library') $$('#library-list [data-app]').find(el => el.dataset.app === target)?.focus(); }
  }
  const group = event.target.closest('[data-group]'); if (group && !state.session) { selected = new Set(groups[Number(group.dataset.group)].paths.filter(p => apps.some(a => a.path === p))); renderApps(); save(); toast('Your focus group is selected.'); }
  const deleteGroup = event.target.closest('[data-delete-group]'); if (deleteGroup && !state.session) { groups.splice(Number(deleteGroup.dataset.deleteGroup), 1); renderApps(); save(); }
});
$('.brand').addEventListener('click', event => { event.preventDefault(); showPage('focus'); });
$('#add-apps').onclick = $('#choose-apps').onclick = $('#library-add').onclick = openPicker;
$('#picker-search').oninput = renderPicker; $('#library-search').oninput = renderLibrary;
$('#refresh-apps').onclick = scan;
$('#browse-apps').onclick = () => act(async () => {
  if (!window.still) { toast('The native file picker is available in the Windows app.'); return; }
  const added = await api.browse(); mergeApps(added);
  for (const target of added) if (pickerSelection.size < 100) pickerSelection.add(target.path);
  renderPicker(); renderApps(); save();
}, $('#browse-apps'));
$('#picker-done').onclick = () => { if (state.session) return; selected = new Set(pickerSelection); $('#picker-dialog').close(); renderApps(); save(); };
$('#duration').oninput = () => { prefs.duration = Number($('#duration').value); $$('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === prefs.duration)); if (prefs.duration > 0 && prefs.duration <= 1440) updateTimer(); };
$('#duration').onchange = save;
$('#intention').oninput = () => { prefs.intention = $('#intention').value; }; $('#intention').onchange = save;
$('#delay').oninput = () => { prefs.delay = Number($('#delay').value); }; $('#delay').onchange = save;
$('#delay-enabled').onchange = () => { prefs.delayEnabled = $('#delay-enabled').checked; renderSession(); save(); };
$('#start-button').onclick = startOrEnd;
$('#cancel-unlock').onclick = () => act(async () => { applyStatus(await api.cancelUnlock()); toast('A little more time for you. Keep going.'); }, $('#cancel-unlock'));
$('#protection-status').onclick = () => state.installed ? showPage('settings') : setupProtection();
$('#install-guard').onclick = setupProtection;
$('#remove-guard').onclick = () => confirmation('Remove Windows protection?', '<p>This removes Still Guard and its focus rules. Your preferences and history files stay on this PC. You can enable protection again whenever you’re ready.</p>', 'Remove protection', async () => { applyStatus(await api.uninstall()); toast('The protection service has been removed.'); });
$('#confirm-accept').onclick = () => { const action = confirmAction; $('#confirm-dialog').close(); if (action) act(action, $('#start-button')); };
$('#confirm-cancel').onclick = () => $('#confirm-dialog').close();
$('#save-group').onclick = () => { if (!selected.size) return toast('Select at least one application first.'); if (groups.length >= 20) return toast('You can save up to 20 groups.', true); $('#group-name').value = ''; $('#group-dialog').showModal(); };
$('#group-save').onclick = () => {
  const name = $('#group-name').value.trim(); if (!name) return $('#group-name').focus();
  groups.push({ name, paths: [...selected] }); $('#group-dialog').close(); renderApps(); save(); toast('A little less setup for next time. Group saved.');
};
$('#group-name').onkeydown = event => { if (event.key === 'Enter') $('#group-save').click(); };
for (const [id, key] of [['notifications', 'notifications'], ['reduced-motion', 'reducedMotion'], ['launch-at-login', 'launchAtLogin']]) {
  $(`#${id}`).onchange = () => { prefs[key] = $(`#${id}`).checked; document.body.classList.toggle('reduced-motion', prefs.reducedMotion); save(); if (key === 'launchAtLogin' && state.demo) toast('Sign-in preferences are available in the packaged Windows app.'); };
}
$('#export-history').onclick = () => act(async () => { if (await api.exportHistory()) toast('Your session history has been exported.'); }, $('#export-history'));
function showGuide() {
  confirmation('A little guidance.', '<p><strong>1. Choose your distractions.</strong> Add desktop apps or game executables. Select each game as well as its launcher.</p><p><strong>2. Set your own pace.</strong> Choose 1–1,440 minutes of focus and an optional 1–120 minute delay before ending early.</p><p><strong>3. Make room.</strong> Enable Windows protection once, save your work, and start. Your selection and delay stay fixed for the session.</p><p>Closing Still or restarting Windows won’t reset the timer. Blocks expire automatically. A release request starts the waiting period; you’ll still choose whether to end when it’s over.</p><p>Protection uses Windows AppLocker for your account. Administrators can override it; other accounts and modified desktop files are outside its coverage. Installed Store apps are protected by package identity. Setup is unavailable on managed PCs or PCs with existing application-control rules.</p>', 'Got it', null);
}
$('#help-button').onclick = $('#blocking-info').onclick = showGuide;
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) openPicker(); } });
for (const modal of $$('dialog')) modal.addEventListener('click', event => { if (event.target === modal) { const rect = modal.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close(); } });
$('#date-label').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
async function init() {
  try {
    const initial = await api.bootstrap(); prefs = { ...prefs, ...initial.preferences }; apps = initial.apps || [];
    if (initial.demo && !apps.length) { apps = [...sampleApps]; prefs.selected = sampleApps.slice(0, 3).map(a => a.path); }
    selected = new Set((prefs.selected || []).filter(p => apps.some(a => a.path === p))); groups = prefs.groups || [];
    $('#duration').value = prefs.duration; $('#delay').value = prefs.delay; $('#delay-enabled').checked = prefs.delayEnabled; $('#intention').value = prefs.intention;
    $('#notifications').checked = prefs.notifications; $('#reduced-motion').checked = prefs.reducedMotion; $('#launch-at-login').checked = prefs.launchAtLogin;
    document.body.classList.toggle('reduced-motion', prefs.reducedMotion);
    $$('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === prefs.duration));
    $('#progress-days').value = prefs.progressDays || 30;
    $('#progress-metric').value = prefs.progressMetric || 'minutes';
    $('#daily-goal').value = prefs.dailyGoal || 60;
    $('#show-intentions').checked = prefs.showIntentions !== false;
    initTodos(); applyStatus(initial); renderApps(); renderStats();
    api.onStatus(value => { if (!busy) applyStatus(value); });
    setInterval(updateTimer, 1000); setInterval(renderStats, 30000);
  } catch (error) { toast('Still could not load: ' + error.message, true); }
}
init();
