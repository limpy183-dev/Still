(function (root) {
  'use strict';
  const presets = {
    garden: { title: 'Make room for what matters.', text: 'Let this distraction wait. Your next small step deserves your attention.' },
    dusk: { title: 'Stay with your intention.', text: 'You chose this time for yourself. Take a breath, then begin again.' },
    paper: { title: 'One thing at a time.', text: 'You don’t need to do everything. Just the thing in front of you.' }
  };
  function domain(value) {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\*]/.test(value)) throw Error('Enter a website such as youtube.com or paste its URL.');
    let url;
    try { url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : 'https://' + value); } catch { throw Error('Enter a valid website address.'); }
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(host) || /\.(localhost|local|internal|test|invalid)$/.test(host)) throw Error('Use a public website domain, without credentials, wildcards, or an IP address.');
    return host;
  }
  const isWebsite = target => typeof target?.path === 'string' && target.path.startsWith('website:');
  function allowedWebsite(target) {
    try { return isWebsite(target) && typeof target.name === 'string' && domain(target.path.slice(8)) === target.path.slice(8); } catch { return false; }
  }
  function target(value) { const host = domain(value.trim()); return { name: host, path: 'website:' + host }; }
  function matches(host, blocked) { host = host.toLowerCase().replace(/\.$/, ''); return host === blocked || host.endsWith('.' + blocked); }
  function screen(value = {}, targets = []) {
    if (!value || typeof value !== 'object') throw Error('Choose a website block screen.');
    const mode = value.mode || 'garden';
    if (![...Object.keys(presets), 'custom', 'redirect'].includes(mode)) throw Error('Choose a website block screen.');
    const result = { mode, title: String(value.title || '').slice(0, 120), text: String(value.text || '').slice(0, 1000), image: '', redirect: '' };
    if (value.image) {
      if (typeof value.image !== 'string' || value.image.length > 180000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.image)) throw Error('Choose a block-screen image using the image picker.');
      result.image = value.image;
    }
    if (mode === 'redirect') {
      let url; try { url = new URL(value.redirect); } catch { throw Error('Enter a full redirect URL, beginning with https://.'); }
      const host = domain(url.href);
      if (url.protocol !== 'https:' || url.href.length > 2048 || targets.filter(isWebsite).some(t => matches(host, t.path.slice(8)))) throw Error('Choose an HTTPS destination outside your blocked websites.');
      result.redirect = url.href;
    }
    return result;
  }
  const api = { presets, domain, target, isWebsite, allowedWebsite, matches, screen };
  if (typeof module !== 'undefined') module.exports = api; else root.Websites = api;
})(globalThis);
