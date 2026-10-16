'use strict';

// "Something new": one new thing a day, planned or already done. Only tracked, never blocks anything.
// The Something new page and Your progress draw the same list, month and chosen day, so they always agree.
const newView = { month: null, day: null };
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayDate = key => new Date(key + 'T00:00:00');
const chevron = (step, label, path) => `<button type="button" class="icon-button" data-new-month="${step}" aria-label="${label}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg></button>`;

function renderNewThings(from, focus) {
  const { month, day } = newView, year = month.getFullYear(), index = month.getMonth(), today = dayKey(new Date(now()));
  const byDay = Map.groupBy(prefs.newThings, item => item.day);
  const monthItems = prefs.newThings.filter(item => item.day.startsWith(`${year}-${String(index + 1).padStart(2, '0')}-`)), monthDone = monthItems.filter(item => item.done).length;
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(name => `<span class="calendar-weekday">${name}</span>`).join('');
  const dates = Array.from({ length: new Date(year, index + 1, 0).getDate() }, (_, i) => {
    const date = new Date(year, index, i + 1), key = dayKey(date), items = byDay.get(key) || [];
    const label = escapeHtml(`${date.toLocaleDateString([], { dateStyle: 'long' })}: ${items.length} new thing${items.length === 1 ? '' : 's'}`);
    const dots = items.slice(0, 3).map(item => `<span class="session-dot" data-color="${item.done ? 'lime' : 'sand'}"></span>`).join('');
    return `<button type="button" class="calendar-day${items.length ? ' has-session' : ''}" data-new-day="${key}" aria-pressed="${key === day}" title="${label}" aria-label="${label}"${key === today ? ' aria-current="date"' : ''}>${i + 1}${items.length ? `<span class="session-dots" aria-hidden="true">${dots}</span>` : ''}</button>`;
  }).join('');
  const rows = (byDay.get(day) || []).map(item => {
    const at = prefs.newThings.indexOf(item), text = escapeHtml(item.text);
    return `<li class="new-row${item.done ? ' done' : ''}"><button type="button" class="todo-check circle" role="checkbox" aria-checked="${item.done}" aria-label="Done: ${text}" data-new-toggle="${at}">${item.done ? icon('check') : ''}</button><span>${text}</span><button type="button" class="todo-delete icon-button" aria-label="Delete ${text}" data-new-delete="${at}">${icon('close')}</button></li>`;
  }).join('');
  const html = `<section class="session-calendar" aria-label="Calendar of new things"><div class="calendar-navigation">${chevron(-1, 'Previous month', 'm12 5-5 5 5 5')}<strong aria-live="polite">${month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</strong>${chevron(1, 'Next month', 'm8 5 5 5-5 5')}</div>`
    + `<div class="progress-calendar">${weekdays}${'<span aria-hidden="true"></span>'.repeat((month.getDay() + 6) % 7)}${dates}</div>`
    + `<p class="progress-note">${monthItems.length ? `${monthDone} done · ${monthItems.length - monthDone} still to do this month` : 'No new things this month yet.'}</p></section>`
    + `<div class="new-day"><h3>${dayDate(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}${day === today ? ' · Today' : ''}</h3>${rows ? `<ul class="new-list">${rows}</ul>` : `<p class="progress-note">${day === today ? 'Nothing yet. What will you try today?' : 'Nothing for this day.'}</p>`}</div>`;
  $$('[data-new-view]').forEach(view => setMarkup(view, html));
  $('#new-target').textContent = day === today ? 'Adding to today. Choose another day on the calendar to add to that day.' : `Adding to ${dayDate(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}.`;
  from?.querySelector(focus)?.focus();
}

function initNewThings() {
  prefs.newThings = prefs.newThings || [];
  const today = new Date(now());
  newView.month = new Date(today.getFullYear(), today.getMonth(), 1); newView.day = dayKey(today);
  renderNewThings();
  const add = done => {
    const input = $('#new-text'), text = input.value.trim();
    if (!text) return input.focus();
    if (done && newView.day > dayKey(new Date(now()))) return toast('That day hasn’t come yet. Choose “I’ll do it” to plan it.', true);
    if (prefs.newThings.length >= 3000) return toast('Your calendar has room for 3,000 new things.', true);
    prefs.newThings.push({ text, day: newView.day, done });
    input.value = '';
    const date = dayDate(newView.day); newView.month = new Date(date.getFullYear(), date.getMonth(), 1);
    renderNewThings(); save();
    toast(done ? 'Lovely. One more new thing.' : 'Planned. Enjoy it.');
  };
  $('#new-form').onsubmit = event => { event.preventDefault(); add(false); };
  $('#new-done').onclick = () => add(true);
  document.addEventListener('click', event => {
    const view = event.target.closest('[data-new-view]'), target = view && event.target.closest('[data-new-day],[data-new-month],[data-new-toggle],[data-new-delete]');
    if (!target) return;
    const { newDay, newMonth, newToggle, newDelete } = target.dataset;
    if (newDay) { newView.day = newDay; renderNewThings(view, `[data-new-day="${newDay}"]`); return; }
    if (newMonth) { newView.month = new Date(newView.month.getFullYear(), newView.month.getMonth() + Number(newMonth), 1); renderNewThings(view, `[data-new-month="${newMonth}"]`); return; }
    if (newToggle) { const item = prefs.newThings[Number(newToggle)]; item.done = !item.done; renderNewThings(view, `[data-new-toggle="${newToggle}"]`); }
    else { prefs.newThings.splice(Number(newDelete), 1); renderNewThings(view, `[data-new-day="${newView.day}"]`); }
    save();
  });
}
