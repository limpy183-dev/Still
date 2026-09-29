'use strict';
const params = new URLSearchParams(location.search), why = params.get('why'), site = params.get('site') || 'This website', mine = params.get('by') === 'me';
function render({ snapshot, app, privateReady, limits, own }) {
  own = Websites.own(own);
  if (why === 'limit' || why === 'bedtime') {
    // Limits from Still for Windows come first, then this extension's own; the stricter one is what holds the site.
    const sides = [Websites.limits(limits), own.limits].map(config => ({ config, site: config.sites.find(s => s.domain === site) })), now = new Date();
    const setBy = sides.findIndex(side => why === 'bedtime' ? side.site?.bedtime && side.config.bedtime.on && Websites.inBedtime(side.config.bedtime, now) : side.site?.minutes);
    const to = sides[Math.max(0, setBy)].config.bedtime.to, minutes = Math.min(...sides.map(side => side.site?.minutes).filter(Boolean));
    document.body.className = why === 'bedtime' ? 'dusk' : 'garden';
    document.getElementById('title').textContent = why === 'bedtime' ? 'Time to rest.' : 'That’s enough for today.';
    document.getElementById('text').textContent = why === 'bedtime' ? `${site} is asleep until ${to}. Tomorrow will be here soon.` : `You’ve spent your ${minutes} minutes on ${site} today. It opens again at midnight.`;
    document.getElementById('status').textContent = setBy === 1 ? 'You set this limit in the Still extension. Change it there if your plans change.' : 'You set this limit in Still. Change it there if your plans change.';
    document.getElementById('image').hidden = true; document.querySelector('.footnote').hidden = true;
    return;
  }
  const config = (mine ? own.screen : snapshot?.screen) || { mode: 'garden' }, preset = Websites.presets[config.mode] || Websites.presets.garden;
  document.body.className = ['garden', 'dusk', 'paper', 'custom'].includes(config.mode) ? config.mode : 'garden';
  document.getElementById('title').textContent = config.mode === 'custom' ? config.title || preset.title : preset.title;
  document.getElementById('text').textContent = config.mode === 'custom' ? config.text || preset.text : preset.text;
  const img = document.getElementById('image'); img.hidden = config.mode !== 'custom' || !config.image; if (!img.hidden) img.src = config.image;
  const until = at => 'On hold until ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('status').textContent = mine ? (own.session?.endsAt > Date.now() ? until(own.session.endsAt) : 'This session has ended.') : app === 'lost' ? 'Connection lost. Existing blocks remain until Windows protection confirms release.' : privateReady === false ? 'Open extension details and enable Allow in incognito / InPrivate, then restart this browser.' : snapshot?.websites?.length ? until(snapshot.endsAt) : 'No websites are currently on hold.';
  if (mine) document.querySelector('.footnote').textContent = 'You started this session in the Still extension. Click its toolbar icon to end it early.';
}
const keys = ['snapshot', 'app', 'privateReady', 'limits', 'own'];
chrome.storage.local.get(keys).then(render);
chrome.storage.onChanged.addListener(() => chrome.storage.local.get(keys).then(render));
