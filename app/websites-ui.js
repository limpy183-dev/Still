'use strict';
let websiteDraft;
const popularWebsites = ['youtube.com', 'reddit.com', 'instagram.com', 'facebook.com', 'x.com', 'tiktok.com', 'twitch.tv', 'netflix.com'];
async function addWebsite(context, address) {
  const input = $('#' + context + '-website-address'), button = $('#' + context + '-website-add');
  const selection = context === 'alert' ? alertApps : pickerSelection;
  const candidate = Websites.target(address || input.value);
  if (selection.size >= 100 && !selection.has(candidate.path)) throw Error('Choose up to 100 apps or websites.');
  button.disabled = true;
  try {
    // Select immediately. A slow icon download must not hold up the picker.
    mergeApps([candidate]);
    if (context === 'alert') {
      alertApps.set(candidate.path, candidate);
      alertChoices = [...new Map([...alertChoices, candidate].map(a => [a.path, a])).values()]; renderAlertApps();
    } else { pickerSelection.add(candidate.path); renderPicker(); }
    input.value = ''; save();
    api.websiteTarget?.(candidate.name).then(target => {
      mergeApps([target]);
      if (context === 'alert') { alertChoices = alertChoices.map(a => a.path === target.path ? target : a); renderAlertApps(); }
      else if ($('#picker-dialog').open) renderPicker();
      renderApps();
    }).catch(() => {});
  } finally { button.disabled = false; }
}
function renderWebsiteScreen() {
  const config = websiteDraft, preset = Websites.presets[config.mode] || Websites.presets.garden;
  const preview = $('#website-screen-preview'); preview.className = 'website-screen-preview ' + config.mode;
  $('#website-preview-title').textContent = config.mode === 'redirect' ? 'A more intentional destination.' : config.mode === 'custom' ? config.title || preset.title : preset.title;
  $('#website-preview-text').textContent = config.mode === 'redirect' ? config.redirect || 'Choose where your attention goes next.' : config.mode === 'custom' ? config.text || preset.text : preset.text;
  $('#website-custom-fields').hidden = config.mode !== 'custom'; $('#website-redirect-field').hidden = config.mode !== 'redirect';
  const img = $('#website-preview-image'); img.hidden = config.mode !== 'custom' || !config.image; if (!img.hidden) img.src = config.image;
  $('#website-image-remove').hidden = !config.image;
  $$('[name="website-screen"]').forEach(input => input.checked = input.value === config.mode);
}
function commitWebsiteScreen() {
  if (state.session) return;
  try {
    prefs.blockScreen = Websites.screen(websiteDraft, apps.filter(a => selected.has(a.path)));
    $('#website-screen-error').textContent = ''; save();
  } catch (error) { $('#website-screen-error').textContent = 'Not saved. ' + error.message; }
}
function updateWebsiteLock() {
  $('#website-screen-fields').disabled = !!state.session;
  $('#website-setup').disabled = !!state.session;
  $('#website-screen-locked').hidden = !state.session;
}
function initWebsites() {
  websiteDraft = { ...Websites.screen(prefs.blockScreen) };
  $('#website-screen-title').value = websiteDraft.title; $('#website-screen-text').value = websiteDraft.text; $('#website-redirect').value = websiteDraft.redirect;
  renderWebsiteScreen(); updateWebsiteLock();
  for (const context of ['picker', 'alert']) {
    const input = $('#' + context + '-website-address');
    $('#' + context + '-website-add').onclick = () => addWebsite(context).catch(error => toast(error.message, true));
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('#' + context + '-website-add').click(); } };
  }
  $('#website-suggestions').innerHTML = popularWebsites.map(host => `<button type="button" class="group-chip" data-website="${host}">${host.replace('.com', '').replace('.tv', '')}</button>`).join('');
  $('#website-suggestions').onclick = event => { const button = event.target.closest('[data-website]'); if (button) addWebsite('picker', button.dataset.website).catch(error => toast(error.message, true)); };
  $$('[data-picker-kind]').forEach(button => button.onclick = () => {
    pickerKind = button.dataset.pickerKind;
    $$('[data-picker-kind]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', item === button ? 'true' : 'false'); });
    renderPicker();
  });
  $$('[name="website-screen"]').forEach(input => input.onchange = () => { websiteDraft.mode = input.value; renderWebsiteScreen(); commitWebsiteScreen(); });
  for (const [id, field] of [['website-screen-title', 'title'], ['website-screen-text', 'text'], ['website-redirect', 'redirect']]) {
    $('#' + id).oninput = () => { websiteDraft[field] = $('#' + id).value; renderWebsiteScreen(); };
    $('#' + id).onchange = commitWebsiteScreen;
  }
  $('#website-image-pick').onclick = () => act(async () => {
    if (!api.websiteImage) throw Error('Choose an image in the Windows app.');
    const image = await api.websiteImage(); if (!image) return;
    websiteDraft.image = image; renderWebsiteScreen(); commitWebsiteScreen();
  }, $('#website-image-pick'));
  $('#website-image-remove').onclick = () => { websiteDraft.image = ''; renderWebsiteScreen(); commitWebsiteScreen(); };
  $('#website-setup').onclick = () => act(async () => {
    if (!api.websiteSetup || state.demo) throw Error('Browser setup is available in the installed Windows app, outside preview mode.');
    if (!state.installed || !state.websiteBlocking) applyStatus(await api.install());
    const directory = await api.websiteSetup();
    $('#website-setup-path').textContent = directory;
    $('#website-setup-steps').hidden = false;
  }, $('#website-setup'));
  api.websiteIcons?.(apps.filter(Websites.isWebsite)).then(enriched => { mergeApps(enriched); renderApps(); }).catch(() => {});
}
