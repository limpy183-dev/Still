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
let presentationVisible = true, historySignature = '', lastStatsSignature = '';
function setText(element, value) { const text = String(value); if (element.textContent !== text) element.textContent = text; }
function setMarkup(element, value) { if (element.innerHTML !== value) element.innerHTML = value; }
function setPresentationVisible(visible) {
  presentationVisible = visible;
  if (visible) { refreshStatus(); renderStats(); }
}
let apps = [], selected = new Set(), groups = [], page = 'focus', busy = false, scanning = false, toastTimer, saveQueue = Promise.resolve();

let state = { installed: false, session: null, history: [], demo: !window.still, error: null, unavailable: false };

let prefs = { duration: 50, delay: 5, delayEnabled: true, intention: '', notifications: true, reducedMotion: false, launchAtLogin: false };

let historyFilter = 'active';

let pickerKind = 'all';
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

  $('#page-crumb').textContent = { focus: 'Focus space', todos: 'To-do list', alerts: 'Alerts', library: 'Apps & websites', limits: 'Time limits', history: 'Your progress', settings: 'Settings' }[next];
  closeTodoMenu();
  if (next === 'library') renderLibrary(); if (next === 'history') renderHistory();
  if (next === 'alerts') renderAlerts();
  renderStats(); updateTimer();
  window.scrollTo({ top: 0 });

}

document.addEventListener('error', event => {
  if (event.target.matches?.('.app-icon img')) event.target.parentElement.innerHTML = icon('grid');
}, true);
function appIcon(target, index) {

  return `<span class="app-icon tone-${index % 5}">${target.icon && /^data:image\//.test(target.icon) ? `<img src="${escapeHtml(target.icon)}" alt="">` : Websites.isWebsite(target) ? `<span class="website-monogram">${escapeHtml(target.name.slice(0, 1).toUpperCase())}</span>` : icon('grid')}</span>`;
}

function category(target) {

  if (Websites.isWebsite(target)) return 'Website · includes subdomains';
  if (target.category) return target.category;

  if (target.path.startsWith('appx:')) return 'Microsoft Store app';

  if (/steam|epic|game|minecraft|riot|battle|ubisoft|xbox/i.test(target.name)) return 'Games & entertainment';

  if (/discord|slack|teams|telegram|whatsapp/i.test(target.name)) return 'Social & communication';

  if (/chrome|firefox|edge|opera|brave/i.test(target.name)) return 'Browser';

  if (/spotify|music|vlc/i.test(target.name)) return 'Music & entertainment';

  return 'Desktop application';

}

function appRow(target, index, checked, context, locked = false) {

  return `<button class="app-row${checked ? ' selected' : ''}${locked && checked ? ' locked' : ''}" data-app="${escapeHtml(target.path)}" data-context="${context}" ${locked ? 'disabled' : ''} role="checkbox" aria-checked="${checked}" aria-label="${escapeHtml(target.name)}${locked ? checked ? ', blocked for this session' : ', not part of this session' : ''}" title="${escapeHtml(Websites.isWebsite(target) ? target.path.slice(8) : target.path)}">${appIcon(target, index)}<span class="app-info"><span class="app-name">${escapeHtml(target.name)}</span><span class="app-subtitle">${escapeHtml(context === 'selected' ? category(target) : Websites.isWebsite(target) ? target.path.slice(8) : target.path)}</span></span><span class="check-box">${icon(locked && checked ? 'lock' : 'check')}</span></button>`;
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

  $('#selected-apps').innerHTML = visible.length ? visible.map((a, i) => appRow(a, i, true, 'selected', !!state.session)).join('') : empty('A little less distraction starts here.', 'Choose the apps and websites you’d like to put on hold.', 'grid');
  $('#choose-apps').innerHTML = state.session ? `${icon('lock')} Your selection is fixed for this session` : `${icon('plus')} ${visible.length ? 'Add apps & websites' : 'Choose apps & websites'}`;
  $('#choose-apps').disabled = !!state.session; $('#add-apps').disabled = !!state.session;

  $('#group-row').innerHTML = groups.slice(0, 4).map((g, i) => `<button class="group-chip" data-group="${i}" ${state.session ? 'disabled' : ''}>${icon('folder')}${escapeHtml(g.name)}</button>`).join('');

  if (page === 'library') renderLibrary();

}

function renderLibrary() {

  const search = $('#library-search').value.toLowerCase();

  const visible = apps.filter(a => `${a.name} ${a.path}`.toLowerCase().includes(search));

  $('#library-list').innerHTML = visible.length ? visible.map((a, i) => appRow(a, i, state.session ? state.session.apps.some(s => s.path.toLowerCase() === a.path.toLowerCase()) : selected.has(a.path), 'library', !!state.session)).join('') : empty(apps.length ? 'Nothing by that name.' : 'Your collection starts with one app.', apps.length ? 'Try another search, or add the executable yourself.' : 'Add the apps that tend to pull your attention away.', 'grid');

  $('#saved-groups').innerHTML = groups.map((g, i) => `<div class="saved-group"><button data-group="${i}" ${state.session ? 'disabled' : ''}>${icon('folder')}${escapeHtml(g.name)}<small>${g.paths.length} distractions</small></button><button class="icon-button" data-delete-group="${i}" aria-label="Delete group ${escapeHtml(g.name)}" ${state.session ? 'disabled' : ''}>${icon('close')}</button></div>`).join('');
  $('#library-add').disabled = !!state.session; $('#save-group').disabled = !!state.session;

}

function renderPicker() {

  const search = $('#picker-search').value.toLowerCase();

  const visible = apps.filter(a => (pickerKind === 'all' || Websites.isWebsite(a) === (pickerKind === 'websites')) && `${a.name} ${a.path}`.toLowerCase().includes(search));
  $('#picker-list').innerHTML = scanning && !apps.length ? '<div class="empty-state"><span class="spinner"></span><strong>Finding your applications…</strong><p>A little less noise is on its way.</p></div>' : visible.length ? visible.map((a, i) => appRow(a, i, pickerSelection.has(a.path), 'picker')).join('') : empty('Nothing here just yet.', 'Browse to an .exe file, or rescan your installed apps.', 'search');

  $('#picker-count').textContent = `${pickerSelection.size} apps / websites selected`;
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
  if (value.historyRevision && !value.history && value.historyRevision !== historySignature && !value.unavailable) {
    // A bootstrap or busy dialog may have missed the first snapshot of a revision.
    api.status().then(applyStatus).catch(error => toast(error.message, true));
    return;
  }
  if (typeof value.now === 'number') offset = value.now - Date.now();

  if (value.unavailable) {

    state = { ...state, installed: false, unavailable: true, error: value.error };

  } else state = { ...state, ...value, unavailable: false };

  if (!value.unavailable && value.history) historySignature = value.historyRevision || JSON.stringify(value.history);
  refreshStatus();
}
function refreshStatus() {
  if (!presentationVisible) return;
  const signature = JSON.stringify([state.installed, state.unavailable, state.session, state.error, historySignature]);
  if (signature !== lastSignature) { lastSignature = signature; renderSession(); renderApps(); if (page === 'history') renderHistory(); else renderStats(); }
  updateTimer();

  if (typeof renderAlerts === 'function') renderAlerts();
}

function renderSession() {
  updateWebsiteLock();
  const session = state.session;

  $('.focus-card').classList.toggle('running', !!session);

  $('#session-setup').hidden = !!session; $('#active-details').hidden = !session;

  $('#session-title').textContent = session ? 'Right here. Right now.' : 'Settle into focus';

  $('#session-tag').innerHTML = `<span class="tiny-dot"></span> ${session ? (state.unavailable ? 'CONNECTION LOST' : session.phase === 'releasing' ? 'RELEASING APPS' : 'FOCUS IN PROGRESS') : 'YOUR NEXT SESSION'}`;

  $('#timer-top').textContent = session ? 'ONE THING AT A TIME' : 'TIME FOR YOURSELF';

  $('#timer-bottom').innerHTML = `<span class="tiny-dot"></span> ${session ? 'You’re making room for what matters' : 'A fresh start awaits'}`;

  $('#start-caption').innerHTML = `${icon(session ? 'shield' : 'lock')} ${session ? 'Closing this window won’t end your session.' : 'Selected apps close; selected websites go on hold.'}`;
  $('#delay-enabled').disabled = !!session; $('#delay').disabled = !!session || !prefs.delayEnabled;

  if (session) {

    $('#delay-enabled').checked = session.unlockDelayMinutes > 0;

    $('#delay').value = session.unlockDelayMinutes || prefs.delay;

    $('#active-intention').textContent = session.intention || 'Space for what matters.';

    $('#active-description').textContent = `${session.apps.length} apps / websites on hold. Your attention is yours again.`;
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
  if (!presentationVisible) return;
  setText($('#date-label'), new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }));
  if (page !== 'focus') return;
  const session = state.session;

  const remaining = session ? session.endsAt - now() : prefs.duration * 60000;

  const [minutes, seconds] = formatClock(remaining).split(':');

  setMarkup($('#timer-number'), `${minutes}<span>:${seconds}</span>`);
  const fraction = session ? Math.max(0, Math.min(1, remaining / (session.durationMinutes * 60000))) : 1;

  const stroke = String(754 * (1 - fraction));
  if ($('#ring-progress').style.strokeDashoffset !== stroke) $('#ring-progress').style.strokeDashoffset = stroke;
  const label = $('#start-button span');

  if (!session) setText(label, 'Start focusing');
  else if (session.phase === 'releasing') setText(label, 'Releasing your distractions…');
  else if (session.unlockAt && now() < session.unlockAt) setText(label, `Release available in ${formatClock(session.unlockAt - now())}`);
  else if (session.unlockAt || !session.unlockDelayMinutes) setText(label, 'End focus session');
  else setText(label, `Request to end · ${session.unlockDelayMinutes} min wait`);
  if (session?.unlockAt) {

    setText($('#unlock-countdown'), now() < session.unlockAt ? formatClock(session.unlockAt - now()) : 'You can end your session now.');
    $('#start-button').disabled = busy || state.unavailable || session.phase !== 'active' || now() < session.unlockAt;

  }

}

function focusMilliseconds(session, from = 0, to = now()) {

  if (!session || ['failed', 'interrupted', 'recovered'].includes(session.outcome)) return 0;

  return Math.max(0, Math.min(session.finishedAt || now(), session.endsAt, to) - Math.max(session.startedAt, from));

}

function renderStats() {
  if (!presentationVisible || !['focus', 'history'].includes(page)) return;
  const signature = JSON.stringify([page, historySignature, state.session, new Date(now()).toDateString(), new Date(now()).getTimezoneOffset(), state.session ? Math.floor(now() / 30000) : null, prefs.progressDays, prefs.progressMetric, prefs.dailyGoal, prefs.showIntentions]);
  if (signature === lastStatsSignature) return;
  lastStatsSignature = signature;
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
let selectedDay = null, colorPickerFor = null;
const INTENTION_COLORS = ['sage', 'moss', 'lime', 'sky', 'lavender', 'rose', 'clay', 'sand'];
const intentionLabel = record => record.intention || 'Time to focus';
// Unpicked tasks get a stable colour from their name, so the list is distinct out of the box.
const intentionColor = label => (prefs.intentionColors || {})[label] || INTENTION_COLORS[[...label].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % INTENTION_COLORS.length];
const dayEnd = start => { const end = new Date(start); end.setDate(end.getDate() + 1); return +end; };

function renderSessionCalendar() {
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const records = [...state.history, ...(state.session ? [state.session] : [])];
  const byDay = new Map();
  for (const record of records) {
    const date = new Date(record.startedAt);
    if (date.getFullYear() !== year || date.getMonth() !== month) continue;
    const entry = byDay.get(date.getDate()) || { count: 0, labels: new Set() };
    entry.count++; entry.labels.add(intentionLabel(record));
    byDay.set(date.getDate(), entry);
  }
  $('#calendar-month').textContent = calendarMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => '<span class="calendar-weekday">' + day + '</span>').join('');
  const blanks = '<span aria-hidden="true"></span>'.repeat((calendarMonth.getDay() + 6) % 7);
  const today = new Date(now()).toDateString();
  const dates = Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => {
    const day = i + 1, { count = 0, labels = new Set() } = byDay.get(day) || {}, date = new Date(year, month, day);
    const label = escapeHtml(date.toLocaleDateString([], { dateStyle: 'long' }) + ': ' + count + ' focus session' + (count === 1 ? '' : 's') + ' created');
    const dots = [...labels].slice(0, 3).map(name => '<span class="session-dot" data-color="' + intentionColor(name) + '"></span>').join('');
    return '<button type="button" class="calendar-day' + (count ? ' has-session' : '') + '" data-calendar-day="' + +date + '" aria-pressed="' + (+date === selectedDay) + '" title="' + label + '" aria-label="' + label + '"' + (date.toDateString() === today ? ' aria-current="date"' : '') + '>' + day + (count ? '<span class="session-dots" aria-hidden="true">' + dots + '</span>' : '') + '</button>';
  }).join('');
  $('#progress-calendar').innerHTML = weekdays + blanks + dates;
}

for (const [id, offset] of [['calendar-previous', -1], ['calendar-next', 1]]) {
  $('#' + id).onclick = () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + offset, 1);
    renderSessionCalendar();
  };
}

$('#progress-calendar').onclick = event => {
  const day = event.target.closest('[data-calendar-day]');
  if (!day) return;
  selectedDay = Number(day.dataset.calendarDay) === selectedDay ? null : Number(day.dataset.calendarDay);
  renderProgress();
};

const intentionSorters = {
  time: (a, b) => b.minutes - a.minutes || b.last - a.last,
  recent: (a, b) => b.last - a.last,
  sessions: (a, b) => b.sessions - a.sessions || b.minutes - a.minutes,
  name: (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
};

function renderIntentions(records, rangeStart) {
  const container = $('#progress-intentions');
  container.hidden = prefs.showIntentions === false;
  const allTime = prefs.intentionScope === 'all', from = selectedDay ?? (allTime ? 0 : rangeStart), to = selectedDay === null ? now() : dayEnd(selectedDay);
  const groups = new Map();
  for (const record of records) {
    const minutes = focusMilliseconds(record, from, to) / 60000;
    // A chosen day also lists sessions started that day, so every marked calendar day has something to show.
    if (minutes <= 0 && !(selectedDay !== null && record.startedAt >= from && record.startedAt < to)) continue;
    const label = intentionLabel(record), group = groups.get(label) || { label, minutes: 0, sessions: 0, last: 0 };
    group.minutes += minutes; group.sessions++; group.last = Math.max(group.last, record.startedAt);
    groups.set(label, group);
  }
  const sort = intentionSorters[prefs.intentionSort] ? prefs.intentionSort : 'time';
  const list = [...groups.values()].sort(intentionSorters[sort]), timed = list.filter(group => group.minutes > 0);
  const total = list.reduce((sum, group) => sum + group.minutes, 0), max = Math.max(1, ...list.map(group => group.minutes));
  const scope = selectedDay === null ? [['range', `Last ${prefs.progressDays || 30} days`], ['all', 'All time']].map(([value, text]) => `<button type="button" data-intention-scope="${value}" aria-pressed="${(value === 'all') === allTime}">${text}</button>`).join('') : new Date(selectedDay).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const when = time => selectedDay === null ? new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' }) : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const options = [['time', 'Most time'], ['recent', 'Most recent'], ['sessions', 'Most sessions'], ['name', 'Name (A–Z)']].map(([value, text]) => `<option value="${value}"${value === sort ? ' selected' : ''}>${text}</option>`).join('');
  const rows = list.map(group => {
    const color = intentionColor(group.label), picking = colorPickerFor === group.label, name = escapeHtml(group.label);
    const picker = picking ? `<div class="swatch-picker" role="group" aria-label="Colours for ${name}">${INTENTION_COLORS.map(option => `<button type="button" data-color="${option}" data-set-color="${option}" data-label="${name}" aria-label="${option}" aria-pressed="${option === color}"></button>`).join('')}</div>` : '';
    return `<li class="attention-row" data-color="${color}"><button type="button" class="attention-swatch" data-intention-color="${name}" aria-expanded="${picking}" aria-label="Change colour for ${name}" title="Change colour"></button><div class="attention-name"><strong title="${name}">${name}</strong><small>${group.sessions} session${group.sessions === 1 ? '' : 's'} · ${selectedDay === null ? 'last' : 'started'} ${when(group.last)}</small></div><div class="attention-track"><span></span></div><strong class="attention-time">${readableTime(Math.floor(group.minutes))}</strong>${picker}</li>`;
  }).join('');
  container.innerHTML = `<div class="attention-heading"><div><h3>Where your attention went</h3><p>${selectedDay === null ? `<span class="attention-scopes" role="group" aria-label="Period">${scope}</span>` : `<span class="attention-scope">${escapeHtml(scope)}</span><button type="button" class="attention-clear" data-intention-clear>Show all days ×</button>`}</p></div><label class="attention-sort">Sort by<select id="intention-sort">${options}</select></label></div>` + (list.length
    ? `<div class="attention-total"><strong>${readableTime(Math.floor(total))}</strong><span>across ${list.length} focus task${list.length === 1 ? '' : 's'}</span></div><div class="attention-stack" aria-hidden="true">${timed.map(group => `<span data-color="${intentionColor(group.label)}"></span>`).join('')}</div><ul class="attention-list">${rows}</ul>`
    : `<p class="progress-note">${selectedDay === null ? 'Give your next session an intention to see your focus take shape here.' : 'No focus sessions on this day. Pick a marked day to see what you worked on.'}</p>`);
  const fills = $$('.attention-track>span'), segments = $$('.attention-stack>span');
  list.forEach((group, i) => { fills[i].style.width = `${group.minutes / max * 100}%`; });
  timed.forEach((group, i) => { segments[i].style.flexGrow = group.minutes; });
  $('#intention-sort').onchange = event => { prefs.intentionSort = event.target.value; renderProgress(); save(); };
}

$('#progress-intentions').onclick = event => {
  const target = event.target.closest('[data-intention-color],[data-set-color],[data-intention-clear],[data-intention-scope]');
  if (!target) return;
  if (target.dataset.intentionClear !== undefined) selectedDay = null;
  else if (target.dataset.intentionScope) { prefs.intentionScope = target.dataset.intentionScope; save(); }
  else if (target.dataset.setColor) { prefs.intentionColors = { ...prefs.intentionColors, [target.dataset.label]: target.dataset.setColor }; colorPickerFor = null; save(); }
  else colorPickerFor = colorPickerFor === target.dataset.intentionColor ? null : target.dataset.intentionColor;
  renderProgress();
};

function renderProgress() {
  if (!presentationVisible || page !== 'history') return;
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
  renderIntentions(records, days[0].start);

}

$('#history-filter').onchange = event => { historyFilter = event.target.value; historyView.page = 0; renderHistoryList(); };

for (const [id, key] of [['progress-days', 'progressDays'], ['progress-metric', 'progressMetric'], ['daily-goal', 'dailyGoal'], ['show-intentions', 'showIntentions']]) {

  $(`#${id}`).onchange = event => {

    if (!event.target.checkValidity()) { event.target.reportValidity(); return; }

    prefs[key] = event.target.type === 'checkbox' ? event.target.checked : key === 'progressMetric' ? event.target.value : Number(event.target.value);

    renderProgress(); save();

  };

}

function renderHistory() {

  renderStats();
  renderHistoryList();

}

const historyView = { search: '', days: 0, outcome: 'all', sort: 'newest', page: 0 };
const historySorters = { newest: (a, b) => b.startedAt - a.startedAt, oldest: (a, b) => a.startedAt - b.startedAt, longest: (a, b) => focusMilliseconds(b) - focusMilliseconds(a) || b.startedAt - a.startedAt };

function renderHistoryList() {
  const { search, days, outcome, sort } = historyView, query = search.trim().toLowerCase(), since = days ? now() - days * 86400000 : 0;
  const visible = state.history.filter(s => (historyFilter === 'all' || !!s.archived === (historyFilter === 'archived'))
    && (!query || intentionLabel(s).toLowerCase().includes(query))
    && s.startedAt >= since
    && (outcome === 'all' || (outcome === 'other' ? !['completed', 'ended-early'].includes(s.outcome) : s.outcome === outcome))).sort(historySorters[sort]);
  const size = prefs.historyPageSize ?? 10, pages = size ? Math.max(1, Math.ceil(visible.length / size)) : 1;
  historyView.page = Math.min(historyView.page, pages - 1);
  const first = size ? historyView.page * size : 0, shown = size ? visible.slice(first, first + size) : visible;
  const filtered = query || days || outcome !== 'all';
  $('#history-count').textContent = `${visible.length} session${visible.length === 1 ? '' : 's'}`;
  $('#history-clear').hidden = !filtered;
  $$('[data-history-days]').forEach(button => button.setAttribute('aria-pressed', Number(button.dataset.historyDays) === days));
  $('#history-pager').hidden = pages < 2;
  $('#history-page').textContent = `${first + 1}–${first + shown.length} of ${visible.length} · Page ${historyView.page + 1} of ${pages}`;
  $('#history-previous').disabled = historyView.page === 0; $('#history-next').disabled = historyView.page >= pages - 1;
  $('#history-list').innerHTML = shown.length ? shown.map(s => `<div class="history-row"><span class="history-symbol" data-color="${intentionColor(intentionLabel(s))}">${icon(s.outcome === 'completed' ? 'check' : 'clock')}</span><div><h3>${escapeHtml(s.intention || 'Time to focus')}</h3><p>${new Date(s.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${s.apps.length} apps / websites put on hold</p></div><strong>${Math.floor(focusMilliseconds(s) / 60000)}m</strong><span class="history-outcome${s.outcome !== 'completed' ? ' early' : ''}">${escapeHtml(({ completed: 'Completed', 'ended-early': 'Ended early', failed: 'Not started', interrupted: 'Interrupted', recovered: 'Recovered' })[s.outcome] || s.outcome)}</span><div class="history-actions"><button class="text-button" data-history-action="${s.archived ? 'restore' : 'archive'}" data-id="${escapeHtml(s.id)}" ${state.unavailable ? 'disabled' : ''}>${s.archived ? 'Restore' : 'Archive'}</button><button class="text-button danger" data-history-action="delete" data-id="${escapeHtml(s.id)}" ${state.unavailable ? 'disabled' : ''}>Delete</button></div></div>`).join('') : filtered ? empty('No sessions match these filters.', 'Try a different search, period, or outcome.', 'leaf') : empty('No sessions in this view.', 'Your saved sessions will appear here. Try another view to find archived sessions.', 'leaf');
}

const refreshHistory = () => { historyView.page = 0; renderHistoryList(); };
$('#history-search').oninput = event => { historyView.search = event.target.value; refreshHistory(); };
$('#history-outcome').onchange = event => { historyView.outcome = event.target.value; refreshHistory(); };
$('#history-sort').onchange = event => { historyView.sort = event.target.value; refreshHistory(); };
$('#history-page-size').onchange = event => { prefs.historyPageSize = Number(event.target.value); refreshHistory(); save(); };
$('#history-period').onclick = event => { const button = event.target.closest('[data-history-days]'); if (button) { historyView.days = Number(button.dataset.historyDays); refreshHistory(); } };
$('#history-clear').onclick = () => { Object.assign(historyView, { search: '', days: 0, outcome: 'all' }); $('#history-search').value = ''; $('#history-outcome').value = 'all'; refreshHistory(); };
for (const [id, step] of [['history-previous', -1], ['history-next', 1]]) $('#' + id).onclick = () => { historyView.page += step; renderHistoryList(); };

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

      confirmation('Give the urge a little space.', `<p>Your apps and websites will stay blocked for another <strong>${session.unlockDelayMinutes} minutes</strong> before you can end this session early. If your session ends sooner, apps are released at the original end time.</p><p>You can cancel the request and keep focusing at any point.</p>`, 'Start the waiting period', async () => { applyStatus(await api.requestUnlock()); });
    } else confirmation('Ready to come back?', '<p>Your apps and websites will be available again. The time you made for yourself still counts.</p>', 'End session', async () => { applyStatus(await api.end()); toast('A little focus goes a long way. Welcome back.'); });
    return;

  }

  if (!selected.size) { openPicker(); return; }

  if (!Number.isInteger(prefs.duration) || prefs.duration < 1 || prefs.duration > 1440) { toast('Choose a whole number from 1 to 1,440 minutes.', true); $('#duration').focus(); return; }

  if (prefs.delayEnabled && (!Number.isInteger(prefs.delay) || prefs.delay < 1 || prefs.delay > 120)) { toast('Choose a waiting period from 1 to 120 minutes.', true); $('#delay').focus(); return; }

  if (!state.installed) { setupProtection(); return; }

  confirmation('A small commitment to yourself.', `<p>${state.demo ? 'This preview will simulate a focus session. No apps or websites will be blocked.' : 'Save any open work in your selected apps. Still will close them and block them from launching for this session. Websites and their subdomains are blocked in Chrome and Edge; install the Still companion in every profile for immediate blocking and custom screens. Browser policies are a fallback and may take time to refresh.'}</p><div class="confirm-detail"><span>Time to focus</span><strong>${prefs.duration} minutes</strong></div><div class="confirm-detail"><span>Distractions put on hold</span><strong>${selected.size} apps / websites</strong></div><div class="confirm-detail"><span>Wait before ending early</span><strong>${prefs.delayEnabled ? `${prefs.delay} minutes` : 'No waiting period'}</strong></div><p>Closing this window won’t end your session. The duration, selection, and waiting period stay fixed until it ends.</p>`, 'Start my session', async () => {
    const response = await api.start({ durationMinutes: prefs.duration, unlockDelayMinutes: prefs.delayEnabled ? prefs.delay : 0, blockScreen: prefs.blockScreen, intention: prefs.intention || 'Space for what matters.', apps: apps.filter(a => selected.has(a.path)).map(({ name, path }) => ({ name, path })) });
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

    if (row.dataset.context === 'picker') { row.classList.toggle('selected', collection.has(row.dataset.app)); row.setAttribute('aria-checked', collection.has(row.dataset.app)); $('#picker-count').textContent = `${collection.size} apps / websites selected`; }
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

$('#save-group').onclick = () => { if (!selected.size) return toast('Select at least one app or website first.'); if (groups.length >= 20) return toast('You can save up to 20 groups.', true); $('#group-name').value = ''; $('#group-dialog').showModal(); };
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

  confirmation('A little guidance.', '<p><strong>1. Choose your distractions.</strong> Add desktop apps, game executables, or website domains. Website blocks cover the domain and its subdomains in Chrome and Edge. Set up the browser companion in Settings for immediate blocking and custom screens. Select each game as well as its launcher.</p><p><strong>2. Set your own pace.</strong> Choose 1–1,440 minutes of focus and an optional 1–120 minute delay before ending early.</p><p><strong>3. Make room.</strong> Enable Windows protection once, save your work, and start. Your selection and delay stay fixed for the session.</p><p>Closing Still or restarting Windows won’t reset the timer. Blocks expire automatically. A release request starts the waiting period; you’ll still choose whether to end when it’s over.</p><p>Protection uses Windows AppLocker for your account. Administrators can override it; other accounts and modified desktop files are outside its coverage. Installed Store apps are protected by package identity. Setup is unavailable on managed PCs or PCs with existing application-control rules.</p>', 'Got it', null);
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

    $('#duration').value = prefs.duration; $('#delay').value = prefs.delay; $('#delay-enabled').checked = prefs.delayEnabled; $('#intention').value = prefs.intention; $('#history-page-size').value = String(prefs.historyPageSize ?? 10);

    $('#notifications').checked = prefs.notifications; $('#reduced-motion').checked = prefs.reducedMotion; $('#launch-at-login').checked = prefs.launchAtLogin;

    document.body.classList.toggle('reduced-motion', prefs.reducedMotion);

    $$('[data-duration]').forEach(button => button.classList.toggle('selected', Number(button.dataset.duration) === prefs.duration));

    $('#progress-days').value = prefs.progressDays || 30;

    $('#progress-metric').value = prefs.progressMetric || 'minutes';

    $('#daily-goal').value = prefs.dailyGoal || 60;

    $('#show-intentions').checked = prefs.showIntentions !== false;

    initWebsites(); initTodos(); applyStatus(initial); renderApps(); renderStats(); await initAlerts();
    api.onStatus(value => { if (!busy) applyStatus(value); });
    api.onPresentation?.(setPresentationVisible);
    setInterval(updateTimer, 1000); setInterval(renderStats, 30000);

  } catch (error) { toast('Still could not load: ' + error.message, true); }
  finally { await api.showWindow?.(); }
  // Artwork is cosmetic: Windows discovery must never hold up the usable UI.
  api.appIcons?.().then(enriched => {
    const icons = new Map(enriched.map(target => [target.path, target]));
    apps = apps.map(target => ({ ...target, ...icons.get(target.path) }));
    renderApps();
  }).catch(() => {});
}

init();

