'use strict';
function render({ snapshot, connected, privateReady }) {
  const config = snapshot?.screen || { mode: 'garden' }, preset = Websites.presets[config.mode] || Websites.presets.garden;
  document.body.className = ['garden', 'dusk', 'paper', 'custom'].includes(config.mode) ? config.mode : 'garden';
  document.getElementById('title').textContent = config.mode === 'custom' ? config.title || preset.title : preset.title;
  document.getElementById('text').textContent = config.mode === 'custom' ? config.text || preset.text : preset.text;
  const img = document.getElementById('image'); img.hidden = config.mode !== 'custom' || !config.image; if (!img.hidden) img.src = config.image;
  document.getElementById('status').textContent = connected === false ? 'Connection lost. Existing blocks remain until Windows protection confirms release.' : privateReady === false ? 'Open extension details and enable Allow in incognito / InPrivate, then restart this browser.' : snapshot?.websites?.length ? 'On hold until ' + new Date(snapshot.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Connected. No websites are currently on hold.';
}
chrome.storage.local.get(['snapshot', 'connected', 'privateReady']).then(render);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(['snapshot', 'connected', 'privateReady']).then(render));
