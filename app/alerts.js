let alerts = [], editingAlert = null, alertSoundFile = null, alertBanner = null, alertApps = new Map(), alertChoices = [], stopAlertPreview = () => {};
const alertStyleNames = { full: 'Full attention', card: 'Focus card', notification: 'Quiet reminder' };
function alertDateString(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function alertTimeString(date) { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function alertWhen(time) { return new Date(time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function alertSession(a) { return a.sessionId && state.session?.id === a.sessionId ? state.session : null; }
let renderedAlerts, renderedAlertState;
function renderAlerts() {
  if (!presentationVisible) return;
  const websiteAlerts = alerts.some(a => a.enabled && (a.blockMode === 'current' ? apps.filter(target => selected.has(target.path)) : a.blockMode === 'custom' ? a.apps : []).some(Websites.isWebsite));
  const inputs = JSON.stringify([websiteAlerts, state.websiteBlocking, state.installed, state.unavailable, state.demo, state.scheduledAlerts, state.snoozeAlerts, state.session?.id, state.session?.phase, state.session?.endsAt, state.session?.apps.length, $('#alerts-filter').value, new Date().getTimezoneOffset()]);
  if (renderedAlerts === alerts && renderedAlertState === inputs) return;
  renderedAlerts = alerts; renderedAlertState = inputs;
  const upcoming = alerts.filter(a => a.enabled && a.nextAt).sort((a, b) => a.nextAt - b.nextAt), next = upcoming[0];
  $('#alerts-count').textContent = upcoming.length; $('#alerts-total').textContent = alerts.length;
  $('#alert-next-title').textContent = next?.title || 'A little space in your schedule.';
  $('#alert-next-detail').textContent = next ? (next.snoozeAt === next.nextAt ? 'Snoozed · alerts again ' : '') + alertWhen(next.nextAt) + ' · ' + alertStyleNames[next.style] : 'Create an alert for something that deserves your attention.';
  const running = alerts.filter(a => a.ringing || alertSession(a)).length, snoozed = alerts.filter(a => a.enabled && a.snoozeAt).length;
  $('#alert-active-count').textContent = `${running} RUNNING · ${snoozed} SNOOZED · ${upcoming.length} UPCOMING`;
  $('#alert-protection-warning').hidden = !alerts.some(a => a.enabled && a.blockMode !== 'none') || (state.installed && !state.unavailable && (state.demo || (state.scheduledAlerts && state.snoozeAlerts && (!websiteAlerts || state.websiteBlocking))));
  const filter = $('#alerts-filter').value;
  const visible = alerts.filter(a => filter === 'all' || a.enabled === (filter === 'enabled')).sort((a, b) => (a.nextAt || Infinity) - (b.nextAt || Infinity));
  $('#alerts-list').innerHTML = visible.length ? visible.map(a => {
    const repeat = { once: new Date(a.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }), daily: 'Every day', weekdays: 'Weekdays' }[a.repeat];
    const length = a.lengthMode === 'range' ? `until ${a.endTime}${a.endTime < a.time ? ' (+1 day)' : ''}` : `${a.durationMinutes} min`;
    const session = alertSession(a);
    const blocking = session ? state.unavailable ? 'Blocking status unavailable' : session.phase === 'active' ? `${session.apps.length} apps / websites blocked until ${alertWhen(session.endsAt)}` : 'Releasing apps…' : a.blockMode === 'none' ? 'Reminder only' : a.blockMode === 'current' ? 'Uses Focus space selection' : `${a.apps.length} apps / websites selected for blocking`;
    const completed = a.repeat === 'once' && !a.nextAt && a.lastOccurrence;
    const statusClass = a.enabled && a.snoozeAt ? 'snoozed' : a.ringing || session ? 'running' : '';
    const statusText = a.enabled && a.snoozeAt ? `Snoozed · alerts again ${alertWhen(a.snoozeAt)}` : a.ringing ? 'Alarm running now' : session ? 'Focus session running' : !a.enabled ? 'Paused' : a.queued ? 'Alarm waiting to display' : a.pending ? 'Waiting to block apps' : completed ? 'Delivered / finished' : 'Scheduled';
    const result = session ? '' : a.sessionId ? state.unavailable ? 'Blocking status unavailable. Check Windows protection.' : 'This alert’s focus session has ended.' : a.lastResult;
    return `<article class="alert-row panel ${statusClass}${!a.enabled ? ' paused' : ''}"><div class="alert-row-time"><strong>${escapeHtml(a.time)}</strong><span>${escapeHtml(repeat)}</span></div><div class="alert-row-content"><div class="alert-row-heading"><h3>${escapeHtml(a.title)}</h3><span class="alert-style-tag">${alertStyleNames[a.style]}</span></div><p class="alert-status ${statusClass}" role="status">${escapeHtml(statusText)}</p>${a.note ? `<p class="alert-row-note">${escapeHtml(a.note)}</p>` : ''}<div class="alert-row-meta"><span>${escapeHtml(length)}</span><span>${escapeHtml(blocking)}</span></div>${result ? `<p class="alert-last-result">${escapeHtml(result)}</p>` : ''}</div><div class="alert-row-actions"><label class="switch"><input type="checkbox" role="switch" aria-label="Enable ${escapeHtml(a.title)}" data-alert-toggle="${a.id}" ${a.enabled ? 'checked' : ''}><span></span></label><button class="text-button" data-alert-edit="${a.id}">Edit</button><button class="text-button" data-alert-preview="${a.id}">Preview</button><button class="text-button danger" data-alert-delete="${a.id}">Delete</button></div></article>`;
  }).join('') : `<div class="alerts-empty panel"><div class="little-orbit"><span></span></div><h2>${alerts.length ? 'Nothing in this view.' : 'Good intentions deserve a time.'}</h2><p>${alerts.length ? 'Try another filter to find your alerts.' : 'A quiet reminder to stretch. A full-screen call to focus.<br>Choose the kind of nudge you need.'}</p>${alerts.length ? '' : '<button class="secondary-button" id="alert-first">Create your first alert <span>↗</span></button>'}</div>`;
  $('#alert-first')?.addEventListener('click', () => openAlert());
}
function openAlert(record = null) {
  editingAlert = record;
  const soon = new Date(Date.now() + 5 * 60000), end = new Date(+soon + 50 * 60000);
  const value = record || { title: '', note: '', date: alertDateString(soon), time: alertTimeString(soon), repeat: 'once', lengthMode: 'duration', durationMinutes: 50, endTime: alertTimeString(end), style: 'card', blockMode: 'none', sound: 'chime', volume: 65, unlockDelayMinutes: prefs.delayEnabled ? prefs.delay : 0 };
  $('#alert-dialog-title').textContent = record ? 'A moment, made yours.' : 'Make room for a moment.';
  $('#alert-snooze-limit').value = value.snoozeLimit ?? '';
  $('#alert-show-dismiss').value = value.showDismiss === false ? 'hide' : 'show';
  $('#alert-on-top').value = value.onTop === false ? 'below' : 'above';
  for (const [id, key] of [['title', 'title'], ['note', 'note'], ['date', 'date'], ['time', 'time'], ['repeat', 'repeat'], ['length', 'lengthMode'], ['duration', 'durationMinutes'], ['end', 'endTime'], ['block', 'blockMode'], ['sound', 'sound'], ['volume', 'volume'], ['delay', 'unlockDelayMinutes']]) $('#alert-' + id).value = value[key];
  $(`[name="alert-style"][value="${value.style}"]`).checked = true;
  alertSoundFile = record?.soundFile || null; alertBanner = record?.banner || null;
  alertApps = new Map((record?.apps || []).map(a => [a.path, a]));
  alertChoices = [...new Map([...apps, ...alertApps.values()].map(a => [a.path, a])).values()];
  $('#alert-form-error').textContent = ''; $('#alert-app-search').value = '';
  updateAlertEditor(); renderAlertApps(); renderAlertMedia(); $('#alert-dialog').showModal();
}
function readAlertForm() {
  return { id: editingAlert?.id, title: $('#alert-title').value.trim(), note: $('#alert-note').value, date: $('#alert-date').value, time: $('#alert-time').value,
    snoozeLimit: $('#alert-snooze-limit').value === '' ? null : Number($('#alert-snooze-limit').value), showDismiss: $('#alert-show-dismiss').value === 'show', onTop: $('#alert-on-top').value === 'above',
    repeat: $('#alert-repeat').value, lengthMode: $('#alert-length').value, durationMinutes: Number($('#alert-duration').value), endTime: $('#alert-end').value,
    style: $('[name="alert-style"]:checked').value, blockMode: $('#alert-block').value, apps: [...alertApps.values()].map(({ name, path }) => ({ name, path })),
    sound: $('#alert-sound').value, volume: Number($('#alert-volume').value), unlockDelayMinutes: Number($('#alert-delay').value), soundFile: alertSoundFile, banner: alertBanner, enabled: editingAlert?.enabled !== false };
}
function updateAlertEditor() {
  const value = readAlertForm(), range = value.lengthMode === 'range';
  $('#alert-duration-field').hidden = range; $('#alert-end-field').hidden = !range; $('#alert-range-hint').hidden = !range;
  $('#alert-duration').disabled = range; $('#alert-end').disabled = !range;
  $('#alert-custom-sound').hidden = value.sound !== 'custom'; $('#alert-banner-controls').hidden = value.style === 'notification';
  $('#alert-custom-apps').hidden = value.blockMode !== 'custom'; $('#alert-current-note').hidden = value.blockMode !== 'current'; $('#alert-block-details').hidden = value.blockMode === 'none';
  $('#alert-volume-value').textContent = `${value.volume}%`;
  $('#alert-preview-title').textContent = value.title || 'Your next little beginning.';
  $('#alert-preview-note').textContent = value.note || 'A moment for what matters.';
  $('#alert-preview-time').textContent = range ? `${value.time} – ${value.endTime}` : `${value.durationMinutes} minutes of intention`;
  $('#alert-style-description').textContent = { full: 'A full-screen moment on every display, above your regular apps. Sound included.', card: 'A floating card above your apps. Room to notice, room to breathe.', notification: 'A Windows notification with your task and note. Dismiss it just like any other notification.' }[value.style];
  $('.alert-live-preview').className = 'alert-live-preview preview-' + value.style;
  $('#alert-preview-media').hidden = !alertBanner || value.style === 'notification';
}
function renderAlertMedia() {
  $('#alert-sound-name').textContent = alertSoundFile?.name || 'MP3, WAV, M4A, MOV and more · up to 200 MB';
  $('#alert-banner-name').textContent = alertBanner?.name || 'Add an image, GIF or video · up to 200 MB';
  $('#alert-banner-remove').hidden = !alertBanner;
  const container = $('#alert-preview-media'); container.replaceChildren();
  if (alertBanner) {
    const video = /\.(mp4|mov|webm)$/i.test(alertBanner.file), media = document.createElement(video ? 'video' : 'img');
    if (video) { media.muted = true; media.loop = true; media.autoplay = !prefs.reducedMotion; media.controls = true; }
    else media.alt = 'Your banner preview';
    media.src = 'still-media://local/' + alertBanner.file;
    media.onerror = () => { $('#alert-form-error').textContent = 'This banner could not play. Try a JPG, GIF, or H.264 MP4.'; };
    container.append(media);
  }
  updateAlertEditor();
}
function renderAlertApps() {
  const query = $('#alert-app-search').value.toLowerCase();
  const visible = alertChoices.filter(a => `${a.name} ${a.path}`.toLowerCase().includes(query));
  $('#alert-app-list').innerHTML = visible.length ? visible.map((a, i) => `<label class="alert-app-option"><input type="checkbox" data-alert-app="${escapeHtml(a.path)}" ${alertApps.has(a.path) ? 'checked' : ''}>${appIcon(a, i)}<span>${escapeHtml(a.name)}<small>${escapeHtml(Websites.isWebsite(a) ? a.path.slice(8) : a.path)}</small></span><span class="alert-app-state">${alertApps.has(a.path) ? 'Block' : 'Allow'}</span></label>`).join('') : '<p class="alert-hint">No matching apps or websites. Add a website, find apps, or browse for an executable.</p>';
  $('#alert-app-count').textContent = `${alertApps.size} apps / websites will be blocked. Unchecked items stay available unless another session blocks them.`;
}
async function alertAction(action, button) {
  if (button) button.disabled = true;
  $('#alert-form-error').textContent = '';
  try { return await action(); }
  catch (error) { const message = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); $('#alert-form-error').textContent = message; toast(message, true); }
  finally { if (button) button.disabled = false; }
}
async function initAlerts() {
  if (api.listAlerts) { alerts = await api.listAlerts(); api.onAlerts(value => { alerts = value; renderAlerts(); }); api.onAlertError(message => toast(message, true)); }
  renderAlerts();
  const prepare = document.createElement('button'); prepare.className = 'text-button'; prepare.type = 'button'; prepare.id = 'alert-protection'; prepare.textContent = 'Prepare / update app blocking';
  $('#alert-block-details').append(prepare);
  prepare.onclick = () => {
    if (state.session) return toast('Finish your current session before updating Windows protection.', true);
    confirmation('Prepare scheduled app blocking?', '<p>Windows will ask for administrator approval to install or update Still Guard. Scheduled sessions can then end at the exact time you chose, even if protection takes a moment to start.</p>', 'Prepare protection', async () => {
      const result = await api.install();
      applyStatus(result);
      if (!result.installed || result.unavailable || (!result.demo && (!result.scheduledAlerts || !result.snoozeAlerts))) throw Error('Windows protection has not confirmed scheduled blocking and snooze support. Try preparing protection again.');
      toast('Windows protection is ready for scheduled alerts.');
    });
  };
  $('#alert-prepare-now').onclick = prepare.onclick;
  $('#alert-add').onclick = () => openAlert(); $('#alerts-filter').onchange = renderAlerts;
  $('#alert-settings').onclick = () => showPage('settings');
  $('#alert-form').addEventListener('input', updateAlertEditor);
  $('#alert-form').addEventListener('change', event => { if (event.target.id === 'alert-sound') { stopAlertPreview(); $('#alert-listen').textContent = 'Listen'; } updateAlertEditor(); });
  $('#alert-dialog').addEventListener('close', () => { stopAlertPreview(); $('#alert-listen').textContent = 'Listen'; $('#alert-preview-media').replaceChildren(); });
  $('#alert-app-search').oninput = renderAlertApps;
  $('#alert-app-list').onchange = event => {
    const input = event.target.closest('[data-alert-app]'); if (!input) return;
    if (input.checked) { if (alertApps.size >= 100) { input.checked = false; return toast('Choose up to 100 apps or websites.', true); } const target = alertChoices.find(a => a.path === input.dataset.alertApp); alertApps.set(target.path, target); }
    else alertApps.delete(input.dataset.alertApp);
    input.closest('label').querySelector('.alert-app-state').textContent = input.checked ? 'Block' : 'Allow';
    $('#alert-app-count').textContent = `${alertApps.size} apps / websites will be blocked. Unchecked items stay available unless another session blocks them.`;
  };
  $('#alert-copy-apps').onclick = () => { alertApps = new Map(apps.filter(a => selected.has(a.path)).map(a => [a.path, a])); renderAlertApps(); };
  for (const [id, method] of [['alert-browse-apps', 'browse'], ['alert-scan-apps', 'discover']]) $('#' + id).onclick = () => alertAction(async () => {
    const found = await api[method](); alertChoices = [...new Map([...alertChoices, ...found].map(a => [a.path, a])).values()]; renderAlertApps();
  }, $('#' + id));
  for (const kind of ['sound', 'banner']) $('#alert-' + kind + '-pick').onclick = () => alertAction(async () => {
    if (!api.pickAlertMedia) throw Error('Media selection is available in the Windows app.');
    const asset = await api.pickAlertMedia(kind); if (!asset) return;
    if (kind === 'sound') { stopAlertPreview(); alertSoundFile = asset; } else alertBanner = asset;
    renderAlertMedia();
  }, $('#alert-' + kind + '-pick'));
  $('#alert-banner-remove').onclick = () => { alertBanner = null; renderAlertMedia(); };
  $('#alert-listen').onclick = () => {
    stopAlertPreview();
    if ($('#alert-listen').textContent === 'Stop') { $('#alert-listen').textContent = 'Listen'; return; }
    const alert = readAlertForm(); if (alert.sound === 'custom' && !alert.soundFile) return toast('Choose your sound file first.', true);
    $('#alert-listen').textContent = 'Stop';
    const stop = playAlertSound(alert, { onError: message => toast(message, true) });
    const timeout = setTimeout(() => { stop(); $('#alert-listen').textContent = 'Listen'; }, 6000);
    stopAlertPreview = () => { clearTimeout(timeout); stop(); };
  };
  $('#alert-preview').onclick = () => alertAction(async () => {
    if (!$('#alert-form').reportValidity()) return;
    if (!api.previewAlert) throw Error('Native alarm previews are available in the Windows app.');
    stopAlertPreview(); await api.previewAlert(readAlertForm());
  }, $('#alert-preview'));
  $('#alert-form').onsubmit = event => {
    event.preventDefault(); alertAction(async () => {
      if (!api.saveAlert) throw Error('Scheduling is available in the Windows app. This browser is a visual preview.');
      // Keep the dynamic Focus space selection saved before scheduling an alert that uses it.
      save(); await saveQueue;
      alerts = await api.saveAlert(readAlertForm()); renderAlerts(); $('#alert-dialog').close(); toast('Your alert is saved. A little intention, scheduled.');
    }, $('#alert-save'));
  };
  $('#alerts-list').addEventListener('change', event => {
    const toggle = event.target.closest('[data-alert-toggle]'); if (toggle) alertAction(async () => { alerts = await api.toggleAlert(toggle.dataset.alertToggle); renderAlerts(); }, toggle).finally(() => { renderedAlerts = null; renderAlerts(); });
  });
  $('#alerts-list').addEventListener('click', event => {
    const edit = event.target.closest('[data-alert-edit]'); if (edit) return openAlert(alerts.find(a => a.id === edit.dataset.alertEdit));
    const preview = event.target.closest('[data-alert-preview]'); if (preview) return alertAction(() => api.previewAlert(alerts.find(a => a.id === preview.dataset.alertPreview)), preview);
    const remove = event.target.closest('[data-alert-delete]');
    if (remove) confirmation('Remove this little reminder?', '<p>This deletes the scheduled alert. Any focus session already running will continue until its normal end.</p>', 'Delete alert', async () => { alerts = await api.deleteAlert(remove.dataset.alertDelete); renderAlerts(); toast('Alert deleted.'); });
  });
}
