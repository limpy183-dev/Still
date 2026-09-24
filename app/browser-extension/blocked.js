'use strict';
const params = new URLSearchParams(location.search), why = params.get('why'), site = params.get('site') || 'This website';
function render({ snapshot, connected, privateReady, limits }) {
  if (why === 'limit' || why === 'bedtime') {
    const to = Websites.limits(limits).bedtime.to, minutes = Websites.limits(limits).sites.find(s => s.domain === site)?.minutes || 0;
    document.body.className = why === 'bedtime' ? 'dusk' : 'garden';
    document.getElementById('title').textContent = why === 'bedtime' ? 'Time to rest.' : 'That’s enough for today.';
    document.getElementById('text').textContent = why === 'bedtime' ? `${site} is asleep until ${to}. Tomorrow will be here soon.` : `You’ve spent your ${minutes} minutes on ${site} today. It opens again at midnight.`;
    document.getElementById('status').textContent = 'You set this limit in Still. Change it there if your plans change.';
    document.getElementById('image').hidden = true; document.querySelector('.footnote').hidden = true;
    return;
  }
  const config = snapshot?.screen || { mode: 'garden' }, preset = Websites.presets[config.mode] || Websites.presets.garden;
  document.body.className = ['garden', 'dusk', 'paper', 'custom'].includes(config.mode) ? config.mode : 'garden';
  document.getElementById('title').textContent = config.mode === 'custom' ? config.title || preset.title : preset.title;
  document.getElementById('text').textContent = config.mode === 'custom' ? config.text || preset.text : preset.text;
  const img = document.getElementById('image'); img.hidden = config.mode !== 'custom' || !config.image; if (!img.hidden) img.src = config.image;
  document.getElementById('status').textContent = connected === false ? 'Connection lost. Existing blocks remain until Windows protection confirms release.' : privateReady === false ? 'Open extension details and enable Allow in incognito / InPrivate, then restart this browser.' : snapshot?.websites?.length ? 'On hold until ' + new Date(snapshot.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Connected. No websites are currently on hold.';
}
chrome.storage.local.get(['snapshot', 'connected', 'privateReady', 'limits']).then(render);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(['snapshot', 'connected', 'privateReady', 'limits']).then(render));
