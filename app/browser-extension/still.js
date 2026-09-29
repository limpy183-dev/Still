'use strict';
// Settings for sessions, limits and the block screen made in the extension itself. The worker applies whatever is saved in storage.own.
const $ = id => document.getElementById(id), time = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
let image = '', timer;
const read = async () => { const value = await chrome.storage.local.get(['own', 'snapshot', 'limits', 'app']); return { ...value, own: Websites.own(value.own) }; };
async function save(change) {
  const { own } = await read(); change(own);
  Websites.screen(own.screen, own.websites.map(Websites.target)); // A saved redirect can't point into a held website.
  await chrome.storage.local.set({ own });
}
const act = handler => async event => {
  event.preventDefault(); $('error').textContent = '';
  try { await handler(event); } catch (error) { $('error').textContent = error.message; }
};
// Website logos come from Google's favicon service, as in Still for Windows. Each domain is fetched once and kept in this browser;
// until then, or if it fails, the row keeps its letter.
const logos = {};
function logo(domain) {
  logos[domain] ||= (async () => {
    const { icons: saved = {} } = await chrome.storage.local.get('icons');
    if (saved[domain]) return saved[domain];
    const response = await fetch('https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(domain), { signal: AbortSignal.timeout(5000) });
    const blob = await response.blob();
    if (!response.ok || !blob.type.startsWith('image/') || blob.size > 50000) return '';
    const uri = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
    const { icons: latest = {} } = await chrome.storage.local.get('icons');
    await chrome.storage.local.set({ icons: { ...latest, [domain]: uri } });
    return uri;
  })().catch(() => { delete logos[domain]; return ''; });
  return logos[domain];
}
function list(element, items) {
  element.replaceChildren(...items.map(({ text, tag, remove, label }) => {
    const item = document.createElement('li'), icon = document.createElement('span'), name = document.createElement('span');
    icon.className = 'icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = label[0]; name.textContent = text; item.append(icon, name);
    logo(label).then(uri => { if (uri) { const image = new Image(); image.alt = ''; image.src = uri; icon.replaceChildren(image); } });
    if (tag) { const note = document.createElement('small'); note.textContent = tag; item.append(note); }
    if (remove) { const button = document.createElement('button'); button.className = 'remove'; button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', 'Remove ' + label); button.onclick = act(remove); item.append(button); }
    return item;
  }));
}
const describe = site => `${site.domain} · ${site.minutes ? site.minutes + ' min a day' : 'no daily limit'}${site.bedtime ? ' · rests at bedtime' : ''}`;
async function render() {
  const { own, snapshot, limits, app } = await read(), active = own.session?.endsAt > Date.now();
  $('app').textContent = app === 'connected' ? 'Connected to Still for Windows' : app === 'lost' ? 'Still for Windows isn’t responding. Its blocks stay in place until it’s back.' : app === 'other' ? 'Still for Windows doesn’t recognise this copy' : 'Working on its own in this browser';
  $('other').hidden = app !== 'other';
  $('app').classList.toggle('ready', app === 'connected');
  $('pitch').hidden = ['connected', 'lost', 'other'].includes(app);
  $('private').hidden = await chrome.extension.isAllowedIncognitoAccess();
  const appSites = snapshot?.websites?.length || 0;
  $('app-session').hidden = !appSites;
  $('app-session').textContent = `Still for Windows is holding ${appSites} website${appSites === 1 ? '' : 's'} until ${time(snapshot?.endsAt)}. Only Still can end that session.`;
  list($('sites'), own.websites.map(domain => ({ text: domain, label: domain, remove: () => save(value => { value.websites = value.websites.filter(host => host !== domain); }) })));
  $('idle').hidden = active; $('running').hidden = !active; $('start').disabled = !own.websites.length;
  $('until').textContent = active ? `Your websites are on hold until ${time(own.session.endsAt)}.` : '';
  clearTimeout(timer); if (active) timer = setTimeout(render, own.session.endsAt - Date.now() + 500);
  list($('limits'), [
    ...own.limits.sites.map(site => ({ text: describe(site), label: site.domain, remove: () => save(value => { value.limits.sites = value.limits.sites.filter(item => item.domain !== site.domain); }) })),
    ...Websites.limits(limits).sites.map(site => ({ text: describe(site), label: site.domain, tag: 'Set in Still for Windows' }))
  ]);
  const bedtime = own.limits.bedtime;
  if (document.activeElement !== $('bed-from')) $('bed-from').value = bedtime.from;
  if (document.activeElement !== $('bed-to')) $('bed-to').value = bedtime.to;
  $('bed-on').checked = bedtime.on;
}
function showScreen(screen) {
  document.querySelector(`input[name="mode"][value="${screen.mode}"]`).checked = true;
  $('title').value = screen.title; $('text').value = screen.text; $('redirect').value = screen.redirect; image = screen.image;
  showMode();
}
// Shows the choice the way the block page will, like the preview in Still's Settings.
function showMode() {
  const mode = new FormData($('screen')).get('mode'), preset = Websites.presets[mode] || Websites.presets.garden, custom = mode === 'custom';
  $('custom').hidden = !custom; $('redirect-row').hidden = mode !== 'redirect';
  $('no-image').hidden = !image; $('image-name').textContent = image ? 'Your image is ready.' : 'JPG, PNG or WebP · resized and kept in this browser';
  $('shot').className = 'shot ' + (Websites.presets[mode] ? mode : 'garden');
  $('preview').hidden = !custom || !image; if (custom && image) $('preview').src = image;
  $('shot-title').textContent = mode === 'redirect' ? 'Off somewhere better.' : custom && $('title').value.trim() || preset.title;
  $('shot-text').textContent = mode === 'redirect' ? 'Visits go to ' + ($('redirect').value.trim() || 'the page you choose') + '.' : custom && $('text').value.trim() || preset.text;
}
// Same size budget as the app's image picker: a JPEG data URL of at most 180 KB.
async function shrink(file) {
  if (file.size > 10 * 1024 * 1024) throw Error('Choose an image smaller than 10 MB.');
  const bitmap = await createImageBitmap(file).catch(() => { throw Error('This image could not be opened. Try a JPG or PNG.'); });
  for (const max of [1000, 750, 500, 320]) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height)), canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale))), context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    const uri = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
    if (uri.length <= 180000) return uri;
  }
  throw Error('Choose a smaller image.');
}
$('add-site').onsubmit = act(async () => {
  const domain = Websites.domain($('site').value.trim());
  await save(value => { if (!value.websites.includes(domain) && value.websites.length >= 100) throw Error('You can hold up to 100 websites.'); value.websites = [...new Set([...value.websites, domain])]; });
  $('site').value = '';
});
$('start').onclick = act(() => save(value => { if (!value.websites.length) throw Error('Add a website first.'); value.session = { endsAt: Date.now() + Number(document.querySelector('input[name="minutes"]:checked').value) * 60000 }; }));
$('stop').onclick = act(() => save(value => { value.session = null; }));
$('add-limit').onsubmit = act(async () => {
  const domain = Websites.domain($('limit-site').value.trim()), minutes = Math.max(0, Math.min(1440, Math.round(Number($('limit-minutes').value) || 0))), bedtime = $('limit-bedtime').checked;
  if (!minutes && !bedtime) throw Error('Give it some minutes a day, or let it rest at bedtime.');
  await save(value => {
    const others = value.limits.sites.filter(site => site.domain !== domain);
    if (others.length >= 100) throw Error('You can limit up to 100 websites.');
    value.limits.sites = [...others, { domain, minutes, bedtime }];
  });
  $('limit-site').value = '';
});
const saveBedtime = act(() => { if ($('bed-from').value && $('bed-to').value) return save(value => { value.limits.bedtime = { on: $('bed-on').checked, from: $('bed-from').value, to: $('bed-to').value }; }); });
for (const id of ['bed-on', 'bed-from', 'bed-to']) $(id).onchange = saveBedtime;
$('screen').oninput = showMode;
$('pick').onclick = () => $('image').click();
$('image').onchange = act(async () => { const file = $('image').files[0]; $('image').value = ''; if (file) { image = await shrink(file); showMode(); } });
$('no-image').onclick = () => { image = ''; showMode(); };
$('screen').onsubmit = act(async () => {
  const screen = { mode: new FormData($('screen')).get('mode'), title: $('title').value, text: $('text').value, image, redirect: $('redirect').value.trim() };
  await save(value => { value.screen = Websites.screen(screen, value.websites.map(Websites.target)); });
  $('saved').textContent = 'Saved.'; setTimeout(() => { $('saved').textContent = ''; }, 2500);
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && ['own', 'snapshot', 'limits', 'app'].some(key => key in changes)) render(); });
read().then(({ own }) => showScreen(own.screen));
render();
