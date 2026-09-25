/* Still — website behaviour. No dependencies. */
(() => {
  'use strict';
  const REPO = 'limpy183-dev/Still';
  // Used until GitHub answers (or if it can't be reached). Update on release.
  const FALLBACK = {
    version: '1.0.3', date: '2026-09-25T16:04:11Z', size: 145888256,
    url: `https://github.com/${REPO}/releases/download/v1.0.3/Still-Setup-1.0.3.exe`,
    sha: '65240fac3c2c2e4279c2b1dbaa897d7489d4695b5899c5703577d24e6fdf7b20',
    page: `https://github.com/${REPO}/releases/latest`
  };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ——— Icon sprite (shared by every page) ——— */
  const icons = {
    focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="4"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    chart: '<path d="M4 4v16h17M9 15v-4m5 4V7m5 8v-5"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    leaf: '<path d="M20 3C9 3 3 7 3 13a7 7 0 0 0 7 7c6 0 10-6 10-17ZM4 20l10-10"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h18"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9m10 0c0-5-10-5-10-9s10-4 10-9"/>',
    refresh: '<path d="M20 8a8 8 0 1 0 0 8m0-13v5h-5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 4h4"/>',
    windows: '<path d="M3 5.5 10.5 4.5v7H3zM13 4.2 21 3v8.5h-8zM3 13h7.5v7L3 19zM13 13h8v8l-8-1.2z"/>',
    github: '<path d="M9 19c-4 1.4-4-2-6-2.5m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.8 3.3 5.8 3.6 5.8 3.6a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.4 10c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5Z"/>',
    eye: '<path d="M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 5 9 7a8 8 0 0 1-2.2 3.3M6.6 6.6C4.4 8 3 10.4 3 12c0 2 4 7 9 7a9 9 0 0 0 4.4-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
    alert: '<path d="M12 4 2.5 20h19L12 4Zm0 6v4m0 3h.01"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    tray: '<path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6l2-8Z"/>',
    heart: '<path d="M12 20s-8-4.6-8-10.3A4.7 4.7 0 0 1 12 7a4.7 4.7 0 0 1 8 2.7C20 15.4 12 20 12 20Z"/>',
    external: '<path d="M14 4h6v6m0-6-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    sparkle: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6"/>',
    export: '<path d="M12 15V3m-5 5 5-5 5 5M4 14v6h16v-6"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2"/>',
    power: '<path d="M12 3v8m6.4-4.4a8 8 0 1 1-12.8 0"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    wand: '<path d="m4 20 11-11m2-6v3m0 6v3m-6-9h3m6 0h3m-8.5-2.5 2 2m4 4 2 2m0-8-2 2"/>'
  };
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.setAttribute('class', 'symbols'); sprite.setAttribute('aria-hidden', 'true');
  sprite.innerHTML = '<defs>' + Object.entries(icons).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') + '</defs>';
  document.body.prepend(sprite);

  /* ——— Toast ——— */
  const toastEl = Object.assign(document.createElement('div'), { className: 'toast', role: 'status' });
  toastEl.setAttribute('aria-live', 'polite');
  document.body.append(toastEl);
  let toastTimer;
  const toast = msg => {
    toastEl.textContent = msg; toastEl.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 3600);
  };

  /* ——— Header, progress, menu, nav pill ——— */
  const header = $('.site-header'), bar = $('.progress-bar');
  const onScroll = () => {
    const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
    header?.classList.toggle('scrolled', y > 8);
    bar?.style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : 0);
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  const toggle = $('.menu-toggle');
  toggle?.addEventListener('click', () => {
    const open = document.body.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', open);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('menu-open')) toggle.click(); });

  const nav = $('.nav');
  if (nav) {
    const pill = Object.assign(document.createElement('span'), { className: 'nav-pill' });
    nav.prepend(pill);
    const to = a => { pill.style.width = a.offsetWidth + 'px'; pill.style.transform = `translateX(${a.offsetLeft}px)`; pill.style.opacity = 1; };
    $$('a', nav).forEach(a => a.addEventListener('pointerenter', () => to(a)));
    nav.addEventListener('pointerleave', () => { pill.style.opacity = 0; });
  }

  /* ——— Split headings into words ——— */
  $$('.split').forEach(el => {
    let i = 0;
    const walk = node => [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part) return;
          if (/^\s+$/.test(part)) return frag.append(part);
          const w = document.createElement('span'); w.className = 'w';
          const s = document.createElement('span'); s.textContent = part; s.style.setProperty('--i', i++);
          w.append(s); frag.append(w);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1) walk(n);
    });
    walk(el); el.classList.add('ready');
  });

  /* ——— Reveal on scroll ——— */
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px', threshold: .12 });
  $$('[data-reveal], [data-inview]').forEach(el => io.observe(el));
  $$('[data-stagger]').forEach(group => $$(':scope > [data-reveal]', group).forEach((c, i) => c.style.setProperty('--i', i)));

  // Runs `fn(visible)` whenever an element enters/leaves the viewport.
  const watch = (el, fn, threshold = .25) => {
    if (!el) return;
    new IntersectionObserver(([e]) => fn(e.isIntersecting), { threshold }).observe(el);
  };

  /* ——— Spotlight + ripple ——— */
  document.addEventListener('pointermove', e => {
    const s = e.target.closest?.('.spot'); if (!s) return;
    const r = s.getBoundingClientRect();
    s.style.setProperty('--mx', e.clientX - r.left + 'px'); s.style.setProperty('--my', e.clientY - r.top + 'px');
  }, { passive: true });
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest('.btn'); if (!b || reduced) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
    const s = Object.assign(document.createElement('span'), { className: 'ripple' });
    Object.assign(s.style, { width: d + 'px', height: d + 'px', left: e.clientX - r.left - d / 2 + 'px', top: e.clientY - r.top - d / 2 + 'px' });
    b.append(s); setTimeout(() => s.remove(), 700);
  });

  /* ——— Counters ——— */
  $$('[data-count]').forEach(el => watch(el, vis => {
    if (!vis || el.dataset.done) return;
    el.dataset.done = 1;
    const end = +el.dataset.count, pre = el.dataset.prefix || '', suf = el.dataset.suffix || '';
    if (reduced) { el.textContent = pre + end.toLocaleString('en-US') + suf; return; }
    const t0 = performance.now(), dur = 1600;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur), v = Math.round(end * (1 - Math.pow(1 - p, 4)));
      el.textContent = pre + v.toLocaleString('en-US') + suf;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, .6));

  /* ——— Latest release (download buttons, version, size, hash, changelog) ——— */
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmtSize = b => (b / 1048576).toFixed(0) + ' MB';
  const apply = rel => {
    $$('[data-dl]').forEach(a => { a.href = rel.url; a.setAttribute('download', ''); });
    $$('[data-version]').forEach(e => e.textContent = rel.version);
    $$('[data-size]').forEach(e => e.textContent = fmtSize(rel.size));
    $$('[data-date]').forEach(e => e.textContent = fmtDate(rel.date));
    $$('[data-sha]').forEach(e => e.textContent = rel.sha || 'Listed on the GitHub release');
    $$('[data-release-page]').forEach(a => a.href = rel.page);
  };
  apply(FALLBACK);

  const fetchReleases = async () => {
    try {
      const hit = JSON.parse(sessionStorage.getItem('still-releases') || 'null');
      if (hit && Date.now() - hit.t < 6e5) return hit.data;
    } catch {}
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(res.status);
    const data = (await res.json()).filter(r => !r.draft).map(r => ({
      tag: r.tag_name, name: r.name, body: r.body || '', date: r.published_at, url: r.html_url, pre: r.prerelease,
      assets: r.assets.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || '', count: a.download_count }))
    }));
    try { sessionStorage.setItem('still-releases', JSON.stringify({ t: Date.now(), data })); } catch {}
    return data;
  };
  const setupAsset = r => r.assets.find(a => /^Still-Setup-.*\.exe$/i.test(a.name));
  const releases = fetchReleases().catch(() => null);
  releases.then(list => {
    const r = list?.find(x => !x.pre && setupAsset(x));
    if (!r) return;
    const a = setupAsset(r);
    apply({ version: r.tag.replace(/^v/, ''), date: r.date, size: a.size, url: a.url, sha: a.digest.replace(/^sha256:/, ''), page: r.url });
  });

  $$('[data-dl]').forEach(a => a.addEventListener('click', () => {
    toast('Your download is starting. A fresh start awaits.');
    const after = $('#after');
    if (after) setTimeout(() => after.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }), 900);
    else setTimeout(() => { location.href = '/download#after'; }, 1400);
  }));

  /* ——— Changelog ——— */
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noopener">$2</a>')
    .replace(/@([\w-]+)/g, '<a href="https://github.com/$1" rel="noopener">@$1</a>');
  // Minimal Markdown for GitHub release notes: headings, lists, paragraphs.
  const markdown = md => {
    let html = '', list = false, para = [];
    const flush = () => { if (para.length) html += `<p>${inline(para.join(' '))}</p>`; para = []; };
    for (const raw of md.replace(/\r/g, '').split('\n')) {
      const line = raw.trim(), h = line.match(/^(#{1,4})\s+(.*)/), li = line.match(/^[-*]\s+(.*)/);
      if (!li && list) { html += '</ul>'; list = false; }
      if (!line) { flush(); continue; }
      if (h) { flush(); html += `<h${Math.min(4, h[1].length + 2)}>${inline(h[2])}</h${Math.min(4, h[1].length + 2)}>`; }
      else if (li) { flush(); if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; }
      else para.push(line);
    }
    flush(); if (list) html += '</ul>';
    return html;
  };
  // Hand-written notes stay; releases GitHub knows about that aren't on the page yet are added on top.
  const log = $('#releases');
  if (log) releases.then(list => {
    const known = new Set($$('[data-tag]', log).map(e => e.dataset.tag));
    const fresh = (list || []).filter(r => !known.has(r.tag));
    if (!fresh.length) return;
    $$('.release.latest', log).forEach(e => { e.classList.remove('latest'); e.querySelector('.pill')?.remove(); });
    log.insertAdjacentHTML('afterbegin', fresh.map((r, i) => {
      const a = setupAsset(r);
      return `<article class="panel release${i === 0 ? ' latest' : ''}" data-tag="${esc(r.tag)}" data-reveal>
        <div class="release-head"><h2>${esc(r.name || r.tag)}</h2>${i === 0 ? '<span class="pill"><span class="tiny-dot"></span>Latest</span>' : ''}${r.pre ? '<span class="pill">Pre-release</span>' : ''}<span class="muted small">${fmtDate(r.date)}</span></div>
        <div class="release-body">${markdown(r.body) || '<p>No notes for this release.</p>'}</div>
        <div class="release-foot">${a ? `<a class="btn btn-primary btn-sm" href="${esc(a.url)}"><svg><use href="#i-download"/></svg>${esc(a.name)} · ${fmtSize(a.size)}</a>` : ''}<a class="btn btn-secondary btn-sm" href="${esc(r.url)}" rel="noopener"><svg><use href="#i-github"/></svg>View on GitHub</a></div>
      </article>`;
    }).join(''));
    $$('[data-reveal]:not(.is-in)', log).forEach(el => io.observe(el));
  });

  /* ——— Copy buttons ——— */
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const src = b.dataset.copy.startsWith('#') ? $(b.dataset.copy)?.textContent : b.dataset.copy;
    try { await navigator.clipboard.writeText(src.trim()); } catch { return toast('Copy isn’t available here. Select the text instead.'); }
    const label = b.querySelector('span'), old = label?.textContent;
    b.classList.add('done'); if (label) label.textContent = 'Copied';
    setTimeout(() => { b.classList.remove('done'); if (label) label.textContent = old; }, 1600);
  });

  /* ——— Hero window: tilt on scroll + a looping focus session ——— */
  const stage = $('.stage'), win = $('.window', stage || undefined);
  if (stage && win && !reduced) {
    const tilt = () => {
      const r = stage.getBoundingClientRect(), vh = innerHeight;
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * .75)));
      win.style.setProperty('--tilt', (16 * (1 - p)).toFixed(2) + 'deg');
      win.style.setProperty('--zoom', (.93 + .07 * p).toFixed(3));
    };
    addEventListener('scroll', tilt, { passive: true }); addEventListener('resize', tilt); tilt();
  }
  const hero = $('#hero-demo');
  if (hero) {
    const num = $('.t-num', hero), prog = $('.prog', hero), eb = $('.t-eb', hero), cap = $('.t-cap', hero), btn = $('.w-btn span', hero),
      title = $('[data-h-title]', hero), tag = $('[data-h-tag]', hero), pill = $('.win-pill', hero), toastM = $('.toast-mock', hero),
      rows = $$('.w-row', hero), presets = $$('.presets span', hero), wbtn = $('.w-btn', hero);
    const show = s => { num.innerHTML = `${String(Math.floor(s / 60)).padStart(2, '0')}<span>:${String(s % 60).padStart(2, '0')}</span>`; };
    let running = false, run = 0;
    const loop = async id => {
      while (running && id === run) {
        // Setup
        rows.forEach(r => r.classList.remove('locked'));
        prog.style.setProperty('--off', 0); show(3000);
        eb.textContent = 'TIME FOR YOURSELF'; cap.textContent = 'A fresh start awaits'; btn.textContent = 'Start focusing';
        title.textContent = 'Settle into focus'; tag.textContent = 'YOUR NEXT SESSION'; pill.textContent = 'Protection ready'; wbtn.classList.remove('waiting');
        for (const [i, m] of [[0, 1500], [1, 3000], [2, 5400], [1, 3000]]) {
          presets.forEach((p, j) => p.classList.toggle('on', j === i)); show(m);
          await sleep(900); if (id !== run) return;
        }
        // Start
        wbtn.animate([{ transform: 'scale(1)' }, { transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 300 });
        await sleep(250);
        toastM.textContent = 'Settle in. Your focus is protected.'; toastM.classList.add('show');
        title.textContent = 'Right here. Right now.'; tag.textContent = 'FOCUS IN PROGRESS'; pill.textContent = 'Focus protected';
        eb.textContent = 'ONE THING AT A TIME'; cap.textContent = 'You’re making room for what matters'; btn.textContent = 'Request early release'; wbtn.classList.add('waiting');
        for (const r of rows) { r.classList.add('locked'); await sleep(220); }
        setTimeout(() => toastM.classList.remove('show'), 2200);
        const t0 = performance.now();
        while (running && id === run) {
          const e = (performance.now() - t0) / 1000; if (e > 10) break;
          const left = Math.max(0, Math.round(3000 - e * 60));
          show(left); prog.style.setProperty('--off', (754 * (1 - left / 3000)).toFixed(1));
          await sleep(100);
        }
        await sleep(600);
      }
    };
    if (reduced) show(3000);
    else watch(hero, vis => { running = vis; if (vis) loop(++run); }, .2);
  }

  /* ——— Tabs showcase ——— */
  $$('[data-tabs]').forEach(root => {
    const tabs = $$('[role=tab]', root), panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));
    const list = $('[role=tablist]', root);
    const pill = Object.assign(document.createElement('span'), { className: 'tab-pill', innerHTML: '<i></i>' });
    list.prepend(pill);
    const bar = pill.firstChild, DUR = 7000;
    let cur = 0, timer, auto = !reduced, visible = false;
    const place = () => { const t = tabs[cur]; pill.style.width = t.offsetWidth + 'px'; pill.style.transform = `translateX(${t.offsetLeft - 5}px)`; };
    const arm = () => {
      clearTimeout(timer); bar.classList.remove('run'); void bar.offsetWidth;
      if (auto && visible) { bar.style.setProperty('--dur', DUR + 'ms'); bar.classList.add('run'); timer = setTimeout(() => select((cur + 1) % tabs.length), DUR); }
    };
    const select = (i, focus) => {
      cur = i;
      tabs.forEach((t, j) => { t.setAttribute('aria-selected', j === i); t.tabIndex = j === i ? 0 : -1; });
      panels.forEach((p, j) => { p.classList.toggle('on', j === i); p.toggleAttribute('inert', j !== i); });
      if (focus) tabs[i].focus();
      place(); arm();
      root.dispatchEvent(new CustomEvent('tabchange', { detail: panels[i] }));
    };
    tabs.forEach((t, i) => t.addEventListener('click', () => { auto = false; select(i); }));
    list.addEventListener('keydown', e => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!d) return;
      auto = false; select((cur + d + tabs.length) % tabs.length, true); e.preventDefault();
    });
    root.addEventListener('pointerenter', () => { clearTimeout(timer); bar.style.animationPlayState = 'paused'; });
    root.addEventListener('pointerleave', () => { bar.style.animationPlayState = ''; arm(); });
    addEventListener('resize', place);
    document.fonts?.ready.then(place);
    watch(root, v => { visible = v; arm(); }, .3);
    select(0);
  });

  /* ——— To-do mockup: tick items and open the "/" menu ——— */
  $$('[data-todo-demo]').forEach(root => {
    const lines = $$('.todo-line[data-tick]', root), menu = $('.slash-menu', root), opts = $$('span', menu), typed = $('[data-typed]', root);
    let running = false, run = 0;
    const loop = async id => {
      while (running && id === run) {
        lines.forEach(l => l.classList.remove('done')); menu.classList.remove('show'); typed.textContent = '';
        await sleep(900);
        for (const l of lines) { if (id !== run) return; l.classList.add('done'); await sleep(900); }
        typed.textContent = '/'; await sleep(400); menu.classList.add('show');
        for (let i = 0; i < opts.length; i++) { opts.forEach((o, j) => o.classList.toggle('on', j === i)); await sleep(520); }
        for (const ch of 'Call the dentist') { if (id !== run) return; menu.classList.remove('show'); typed.textContent = typed.textContent === '/' ? ch : typed.textContent + ch; await sleep(55); }
        await sleep(2600);
      }
    };
    if (reduced) lines.forEach(l => l.classList.add('done'));
    else watch(root, v => { running = v; if (v) loop(++run); });
  });

  /* ——— Library mockup: typing search + toggles ——— */
  $$('[data-library-demo]').forEach(root => {
    $$('.lrow', root).forEach(r => $('.chk', r)?.addEventListener('click', () => r.classList.toggle('sel')));
    const q = $('[data-typed]', root); if (!q || reduced) return;
    let running = false, run = 0;
    const loop = async id => {
      while (running && id === run) {
        for (const word of ['steam', 'youtube.com', 'discord']) {
          for (const ch of word) { if (id !== run) return; q.textContent += ch; await sleep(90); }
          await sleep(1400);
          while (q.textContent) { if (id !== run) return; q.textContent = q.textContent.slice(0, -1); await sleep(35); }
          await sleep(300);
        }
      }
    };
    watch(root, v => { running = v; if (v) loop(++run); });
  });

  /* ——— A pause before you quit (60× faster demo) ——— */
  const pause = $('#pause-demo');
  if (pause) {
    const range = $('input[type=range]', pause), val = $('.delay-val', pause), box = $('.unlock', pause), cd = $('.unlock-time', pause),
      btn = $('.demo-btn', pause), label = $('span', btn), keep = $('.linklike', pause);
    let wait = +range.value, timer = null, state = 'idle';
    const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const paint = () => {
      val.textContent = `${wait} min`;
      range.style.setProperty('--fill', ((wait - 1) / 119 * 100) + '%');
    };
    const reset = () => {
      clearInterval(timer); state = 'idle'; box.classList.remove('open'); range.disabled = false;
      btn.classList.remove('waiting', 'ready'); label.textContent = 'Request early release';
    };
    range.addEventListener('input', () => { wait = +range.value; paint(); });
    btn.addEventListener('click', () => {
      if (state === 'idle') {
        state = 'waiting'; range.disabled = true; box.classList.add('open'); btn.classList.add('waiting');
        let left = wait * 60; cd.textContent = fmt(left); label.textContent = `Release available in ${fmt(left)}`;
        timer = setInterval(() => {
          left = Math.max(0, left - 60 / 10 * (wait > 20 ? wait / 10 : 1));
          left = Math.round(left); cd.textContent = fmt(left); label.textContent = `Release available in ${fmt(left)}`;
          if (!left) { clearInterval(timer); state = 'ready'; btn.classList.replace('waiting', 'ready'); label.textContent = 'End focus session'; }
        }, 100);
      } else if (state === 'ready') { reset(); toast('Session ended. Every minute you gave it still counts.'); }
    });
    keep.addEventListener('click', () => { reset(); toast('Take a breath. You’re right where you need to be.'); });
    paint();
  }

  /* ——— Block screens ——— */
  $$('[data-screens]').forEach(root => {
    const opts = $$('.screen-opt', root), screens = $$('.bscreen', root), url = $('[data-url]', root);
    const urls = ['youtube.com', 'instagram.com', 'reddit.com'];
    let cur = 0, timer, visible = false, auto = !reduced;
    const select = i => {
      cur = i;
      opts.forEach((o, j) => { o.setAttribute('aria-pressed', j === i); const b = $('.bar i', o); if (b) { b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''; } });
      screens.forEach((s, j) => s.classList.toggle('on', j === i));
      if (url) url.textContent = urls[i % urls.length];
      clearTimeout(timer); if (auto && visible) timer = setTimeout(() => select((cur + 1) % opts.length), 5000);
    };
    opts.forEach((o, i) => o.addEventListener('click', () => { auto = false; select(i); }));
    watch(root, v => { visible = v; select(cur); });
    select(0);
  });

  /* ——— Toggle switches in mockups ——— */
  $$('.switch[role=switch]').forEach(s => s.addEventListener('click', () => s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true')));

  /* ——— Installer + SmartScreen mockups ——— */
  const setup = $('#setup-demo');
  if (setup) {
    const eb = $('.eb', setup), h = $('h4', setup), rows = $('.setup-rows', setup), prog = $('.setup-progress', setup), pct = $('[data-pct]', setup),
      status = $('[data-status]', setup), btn = $('.setup-foot .btn span', setup), fill = $('.setup-progress i', setup);
    let running = false, run = 0;
    const loop = async id => {
      while (running && id === run) {
        eb.textContent = 'A QUIETER SPACE FOR YOUR ATTENTION'; h.textContent = 'Make room for Still.'; rows.hidden = false; prog.hidden = true; status.textContent = 'No account. No analytics. Everything stays on this PC.'; btn.textContent = 'Install Still'; pct.textContent = ''; fill.style.setProperty('--w', '0%');
        await sleep(3200); if (id !== run) return;
        rows.hidden = true; prog.hidden = false; eb.textContent = 'SETTLING IN'; btn.textContent = 'Installing…'; btn.parentElement.style.opacity = .45;
        for (const [p, s] of [[8, 'Getting ready…'], [34, 'Copying Still…'], [62, 'Copying Still…'], [86, 'Putting everything in place…'], [100, 'Putting everything in place…']]) {
          h.textContent = s; fill.style.setProperty('--w', p + '%'); pct.textContent = p + '%'; await sleep(800); if (id !== run) return;
        }
        eb.textContent = 'ALL SET'; h.textContent = 'Still is ready when you are.'; status.textContent = 'You’ll also find it in the Start menu as Still Focus.'; btn.textContent = 'Open Still'; btn.parentElement.style.opacity = '';
        await sleep(3200);
      }
    };
    if (!reduced) watch(setup, v => { running = v; if (v) loop(++run); });
  }
  const smart = $('#smart-demo');
  if (smart) {
    const more = $('[data-more]', smart), runB = $('.run', smart);
    let running = false, run = 0;
    const loop = async id => {
      while (running && id === run) {
        smart.classList.remove('expanded'); more.classList.remove('hl'); runB.classList.remove('hl');
        await sleep(1400); more.classList.add('hl'); await sleep(1000); if (id !== run) return;
        more.classList.remove('hl'); smart.classList.add('expanded'); await sleep(1000);
        runB.classList.add('hl'); await sleep(2600);
      }
    };
    if (reduced) smart.classList.add('expanded');
    else watch(smart, v => { running = v; if (v) loop(++run); });
  }

  /* ——— FAQ search + filters ——— */
  const faq = $('#faq-list');
  if (faq) {
    const input = $('#faq-search'), chips = $$('.chips button'), items = $$('details', faq), empty = $('#faq-empty');
    let cat = 'all';
    const filter = () => {
      const q = input.value.trim().toLowerCase(); let shown = 0;
      items.forEach(d => {
        const ok = (cat === 'all' || d.dataset.cat === cat) && (!q || d.textContent.toLowerCase().includes(q));
        d.hidden = !ok; if (ok) shown++;
        if (q && ok && q.length > 2) d.open = true;
      });
      empty.hidden = shown > 0;
    };
    input.addEventListener('input', filter);
    chips.forEach(c => c.addEventListener('click', () => { cat = c.dataset.cat; chips.forEach(x => x.setAttribute('aria-pressed', x === c)); filter(); }));
    const target = location.hash && $(location.hash);
    if (target?.tagName === 'DETAILS') target.open = true;
  }

  /* ——— Scrollspy for tables of contents ——— */
  $$('[data-spy]').forEach(navEl => {
    const links = $$('a[href^="#"]', navEl), map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
    const spy = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      links.forEach(a => a.classList.remove('on'));
      const a = map.get(e.target.id); a?.classList.add('on');
      if (a && navEl.scrollWidth > navEl.clientWidth) {
        // Scroll only the tab strip; scrollIntoView also moves the page vertically.
        const tab = a.getBoundingClientRect(), nav = navEl.getBoundingClientRect();
        navEl.scrollBy({ left: tab.left - nav.left + tab.width / 2 - navEl.clientWidth / 2, behavior: reduced ? 'auto' : 'smooth' });
      }
    }), { rootMargin: '-35% 0px -60% 0px' });
    map.forEach((_, id) => { const s = document.getElementById(id); if (s) spy.observe(s); });
  });

  /* ——— Screenshot lightbox ——— */
  const lb = $('#lightbox');
  if (lb) {
    const img = $('img', lb), cap = $('p', lb);
    $$('[data-lightbox]').forEach(b => b.addEventListener('click', () => {
      const src = $('img', b);
      img.src = b.dataset.lightbox; img.alt = src.alt; cap.textContent = src.alt;
      lb.showModal();
    }));
    lb.addEventListener('click', e => { if (e.target === lb || e.target.closest('.close')) lb.close(); });
  }

  /* ——— Footer year ——— */
  $$('[data-year]').forEach(e => e.textContent = new Date().getFullYear());
})();
