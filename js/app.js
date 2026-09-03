/* HippoCampus Robotics docs — hash router + renderers.
   Zero-build: this file, marked.min.js (vendored, MIT), and JSON/Markdown content.
   Slug rule mirrors tools/rst_convert.py slugify() — keep them in sync. */
(function () {
  'use strict';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const content = $('#content');
  const sidebar = $('#sidebar');
  const DATA = {};          // site, setup, projects, tools
  const mdCache = {};       // path -> markdown text
  let routeEpoch = 0;       // bumped per navigation; async views must not paint stale

  // ---------- utilities ----------
  function slugify(text) {
    return (text.toLowerCase().replace(/[^\w\s-]/g, '').trim()
      .replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '')) || 'section';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  }
  async function fetchJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
  async function fetchMD(path) {
    if (mdCache[path]) return mdCache[path];
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const text = await r.text();
    mdCache[path] = text;
    return text;
  }
  function setTitle(parts) {
    document.title = [...parts, 'HippoCampus Robotics'].filter(Boolean).join(' · ');
  }
  function errorPanel(err) {
    content.innerHTML =
      `<div class="error-panel"><h1>Something broke</h1>
       <p>${esc(err.message || String(err))}</p>
       <p>If you are running locally, serve the site with
       <code>./tools/serve.sh</code> (plain <code>file://</code> cannot fetch content).</p></div>`;
  }

  // ---------- markdown rendering + enhancement ----------
  function renderMarkdown(md) {
    marked.use({ mangle: false, headerIds: false });
    const html = marked.parse(md);
    const frag = el(`<div class="page-body">${html}</div>`);
    const body = frag.firstElementChild;
    enhance(body);
    return body;
  }

  function enhance(root) {
    if (window.HCGraph) HCGraph.applyTo(root);   // cross-refs first: before anchors/tabs/buttons exist
    // heading ids + anchors (h2+; h1 is the page itself)
    const assigned = new Set();
    root.querySelectorAll('h2, h3, h4').forEach((h) => {
      if (!h.id) {
        const base = slugify(h.textContent);
        let id = base;
        for (let n = 2; assigned.has(id); n += 1) id = `${base}-${n}`;
        h.id = id;
      }
      assigned.add(h.id);
      const a = document.createElement('a');
      a.className = 'heading-anchor';
      a.href = location.hash.split('@')[0] + '@' + h.id;
      a.textContent = '#';
      a.setAttribute('aria-label', 'Link to this section');
      h.appendChild(a);
    });
    // tabs
    root.querySelectorAll('.tabs').forEach((tabs) => {
      const panes = Array.from(tabs.children).filter((c) => c.classList.contains('tab'));
      if (!panes.length) return;
      const bar = document.createElement('div');
      bar.className = 'tabbar';
      bar.setAttribute('role', 'tablist');
      panes.forEach((pane, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'tab');
        btn.textContent = pane.dataset.label || `Tab ${i + 1}`;
        btn.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        btn.addEventListener('click', () => {
          panes.forEach((p) => p.classList.remove('active'));
          bar.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', 'false'));
          pane.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
        });
        bar.appendChild(btn);
        if (i === 0) pane.classList.add('active');
      });
      tabs.prepend(bar);
    });
    // code copy buttons (strip "$ " prompts when copying console blocks)
    root.querySelectorAll('pre').forEach((pre) => {
      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = 'copy';
      btn.addEventListener('click', () => {
        let text = pre.innerText;
        if (/^\$ /m.test(text)) {
          text = text.split('\n').map((l) => l.replace(/^\$ /, '')).join('\n');
        }
        navigator.clipboard.writeText(text.trimEnd()).then(() => {
          btn.textContent = 'copied';
          setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        });
      });
      wrap.appendChild(btn);
    });
    // tables scroll on small screens
    root.querySelectorAll('table').forEach((t) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });
    // external links in new tabs
    root.querySelectorAll('a[href^="http"]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  function scrollToAnchor(anchor) {
    if (!anchor) { window.scrollTo(0, 0); return; }
    const target = document.getElementById(anchor);
    if (target) target.scrollIntoView();
  }

  // ---------- sidebar ----------
  function sidebarSetup(activeId) {
    const parts = DATA.setup.sections.map((sec) => {
      const links = sec.pages.map((p) =>
        `<a href="#/setup/${p.id}" class="${p.id === activeId ? 'active' : ''}">${esc(p.title)}</a>`
      ).join('');
      return `<h3>${esc(sec.title)}</h3>${links}`;
    });
    sidebar.innerHTML = parts.join('');
    const act = sidebar.querySelector('a.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function sidebarList(title, items, base, activeId) {
    sidebar.innerHTML = `<h3>${esc(title)}</h3>` + items.map((it) =>
      `<a href="#${base}/${it.id}" class="${it.id === activeId ? 'active' : ''}">${esc(it.name || it.title)}</a>`
    ).join('');
  }

  function navHighlight(section) {
    document.querySelectorAll('.site-nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.nav === section);
    });
  }

  // ---------- views ----------
  function viewHome() {
    sidebar.innerHTML = '';
    setTitle([]);
    const s = DATA.site;
    content.innerHTML = `
      <div class="page-body" style="max-width:52rem">
        <p class="kicker">${esc(s.kicker)}</p>
        <h1>${esc(s.title)}</h1>
        <p class="lead">${esc(s.lead)}</p>
        <div class="card-grid">
          ${s.home_cards.map((c) => `
            <a class="card" href="${c.href}">
              <h3>${esc(c.title)} <span class="arrow">→</span></h3>
              <p>${esc(c.text)}</p>
            </a>`).join('')}
        </div>
        <p style="margin-top:2.5rem" class="lead">Looking for something specific?
        Use the search box above — it covers setup pages, projects, tools, every code
        repository's classes and functions, and the CAD part list.</p>
      </div>`;
  }

  async function viewSetupPage(pageId, anchor) {
    const flat = DATA.setup.sections.flatMap((s) => s.pages);
    const page = flat.find((p) => p.id === pageId);
    if (!page) throw new Error(`No setup page “${pageId}”`);
    sidebarSetup(pageId);
    setTitle([page.title, 'Setup']);
    const epoch = routeEpoch;
    const md = await fetchMD(page.file);
    if (epoch !== routeEpoch) return;
    content.innerHTML = '';
    const body = renderMarkdown(md);
    // prev / next
    const i = flat.indexOf(page);
    const nav = document.createElement('nav');
    nav.className = 'page-nav';
    nav.innerHTML =
      (i > 0 ? `<a href="#/setup/${flat[i - 1].id}">← ${esc(flat[i - 1].title)}</a>` : '<span></span>') +
      (i < flat.length - 1 ? `<a href="#/setup/${flat[i + 1].id}" style="text-align:right">${esc(flat[i + 1].title)} →</a>` : '<span></span>');
    body.appendChild(nav);
    content.appendChild(body);
    scrollToAnchor(anchor);
  }

  function statusBadge(status) {
    return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
  }

  function viewProjects() {
    sidebarList('Projects', DATA.projects.projects, '/projects', null);
    setTitle(['Projects']);
    const cards = DATA.projects.projects.map((p) => `
      <a class="card" href="#/projects/${p.id}">
        <h3>${esc(p.name)} ${statusBadge(p.status)}<span class="arrow">→</span></h3>
        <p>${esc(p.tagline)}</p>
        <div class="chips">${p.repos.slice(0, 5).map((r) => `<span class="chip">${esc(r.name)}</span>`).join('')}
        ${p.repos.length > 5 ? `<span class="chip">+${p.repos.length - 5} more</span>` : ''}</div>
      </a>`).join('');
    content.innerHTML = `
      <div class="page-body" style="max-width:64rem">
        <p class="kicker">The team's work</p>
        <h1>Projects</h1>
        <p class="lead">${esc(DATA.projects.intro)}</p>
        <div class="card-grid">${cards}</div>
        <p class="provenance">Coverage rule: every repository in the
        <a href="https://github.com/HippoCampusRobotics">HippoCampusRobotics org</a> belongs to exactly
        one project above (or is listed with a reason in the exclusions inside
        <code>data/projects.json</code>); <code>tools/check.py</code> enforces this.</p>
      </div>`;
  }

  async function viewProjectDetail(id, anchor) {
    const p = DATA.projects.projects.find((x) => x.id === id);
    if (!p) throw new Error(`No project “${id}”`);
    sidebarList('Projects', DATA.projects.projects, '/projects', id);
    setTitle([p.name, 'Projects']);
    const epoch = routeEpoch;
    const md = await fetchMD(p.file);
    if (epoch !== routeEpoch) return;
    const repoRows = p.repos.map((r) => `
      <li class="repo-row"><a class="chip" href="${esc(r.url)}">${esc(r.name)}</a>
      <span class="role">${esc(r.role || '')}</span></li>`).join('');
    const hw = (p.hardware || []).map((h) => `<li>${esc(h)}</li>`).join('');
    const docs = (p.links || []).map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join('');
    content.innerHTML = `
      <div style="max-width:64rem">
        <a class="back-link" href="#/projects">← All projects</a>
        <h1 style="margin-top:0.8rem">${esc(p.name)}</h1>
        <p class="lead">${esc(p.tagline)} ${statusBadge(p.status)}</p>
        <div class="detail-grid">
          <aside class="detail-aside"><div class="aside-box">
            <div><h3>Repositories</h3><ul>${repoRows}</ul></div>
            ${hw ? `<div><h3>Hardware</h3><ul>${hw}</ul></div>` : ''}
            ${docs ? `<div><h3>See also</h3><ul>${docs}</ul></div>` : ''}
          </div></aside>
          <div class="detail-main" id="project-md"></div>
        </div>
      </div>`;
    $('#project-md').appendChild(renderMarkdown(md));
    if (window.HCGraph) HCGraph.renderContributors(id, $('.aside-box'));
    scrollToAnchor(anchor);
  }

  function viewTools() {
    sidebarList('Agent tools', DATA.tools.tools, '/tools', null);
    setTitle(['Agent tools']);
    const cards = DATA.tools.tools.map((t) => `
      <a class="card" href="#/tools/${t.id}">
        <h3>${esc(t.name)} <span class="arrow">→</span></h3>
        <p>${esc(t.tagline)}</p>
        <div class="chips">${(t.chips || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      </a>`).join('');
    content.innerHTML = `
      <div class="page-body" style="max-width:64rem">
        <p class="kicker">Agents in the lab</p>
        <h1>Agent tools</h1>
        <p class="lead">${esc(DATA.tools.intro)}</p>
        <div class="card-grid">${cards}</div>
      </div>`;
  }

  async function viewToolPage(id, anchor) {
    const t = DATA.tools.tools.find((x) => x.id === id);
    if (!t) throw new Error(`No tool “${id}”`);
    sidebarList('Agent tools', DATA.tools.tools, '/tools', id);
    setTitle([t.name, 'Agent tools']);
    const epoch = routeEpoch;
    const md = await fetchMD(t.file);
    if (epoch !== routeEpoch) return;
    content.innerHTML = '';
    content.appendChild(el(`<a class="back-link" href="#/tools">← All tools</a>`));
    content.appendChild(renderMarkdown(md));
    scrollToAnchor(anchor);
  }

  // ---------- people (about page) ----------
  // Only http(s) URLs are trusted: esc() makes a value attribute-safe, but it would
  // happily let a `javascript:` href through. data/people.json is hand-edited.
  function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    return /^https?:\/\//i.test(url) ? url : null;
  }
  // data/people.json stores canonical Cloudinary manifest URLs (the rule for editors is
  // "paste the manifest url"); cards are ~160px wide, so ask the CDN for a card-sized
  // rendition instead of the original asset. Non-Cloudinary and already-transformed URLs
  // pass through untouched.
  const CARD_PHOTO_TX = 'w_320,f_auto,q_auto';
  function cardPhotoUrl(url) {
    const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/.exec(url);
    if (!m) return url;
    const first = m[2].split('/')[0];
    // A transformation segment is comma-joined `key_value` pairs. `v1234` is a version,
    // and anything ending in a file extension is a public_id, not a transform.
    const transformed = !/^v\d+$/.test(first) && /^[a-z]+_[^/]+$/.test(first)
      && !/\.[a-z0-9]{2,4}$/i.test(first);
    return transformed ? url : `${m[1]}${CARD_PHOTO_TX}/${m[2]}`;
  }
  function initials(name) {
    const letters = name.trim().split(/\s+/).slice(0, 2)
      .map((word) => Array.from(word)[0] || '').join('');
    return letters.toUpperCase() || '?';
  }
  function personCardHTML(person) {
    const name = (person && typeof person.name === 'string') ? person.name.trim() : '';
    if (!name) return '';
    const photo = safeHttpUrl(person.photo);
    const media = photo
      ? `<img class="person-photo" src="${esc(cardPhotoUrl(photo))}" alt="" loading="lazy">`
      : `<div class="person-initials" aria-hidden="true">${esc(initials(name))}</div>`;
    const title = (typeof person.title === 'string' && person.title.trim())
      ? `<span class="person-title">${esc(person.title)}</span>` : '';
    const inner = `${media}<span class="person-name">${esc(name)}</span>${title}`;
    const link = safeHttpUrl(person.link);
    return link
      ? `<a class="person-card" href="${esc(link)}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="person-card is-static">${inner}</div>`;
  }
  // Fills the `<div id="people-root">` mount that content/about.md declares. Throws on a
  // malformed roster so the caller can warn and leave the rest of the page intact.
  function mountPeople(body, data) {
    const root = body.querySelector('#people-root');
    if (!root) return;
    if (!data || !Array.isArray(data.groups)) throw new Error('data/people.json is malformed');
    const html = data.groups.map((group) => {
      const people = Array.isArray(group.people) ? group.people : [];
      const cards = people.map(personCardHTML).join('');
      if (!cards) return '';
      const compact = group.id === 'active' ? '' : ' compact';
      return `<div class="people-group">
        <h3>${esc(group.title || '')}</h3>
        <div class="people-grid${compact}">${cards}</div>
      </div>`;
    }).join('');
    if (!html) { root.remove(); return; }
    root.appendChild(el(html));
  }

  async function viewAbout(anchor) {
    sidebar.innerHTML = '';
    setTitle(['About']);
    const epoch = routeEpoch;
    // The roster is a page-local extra: never let its failure take the About page down.
    const [md, people] = await Promise.all([
      fetchMD('content/about.md'),
      fetchJSON('data/people.json').catch((err) => err),
    ]);
    if (epoch !== routeEpoch) return;
    content.innerHTML = '';
    const body = renderMarkdown(md);
    try {
      if (people instanceof Error) throw people;
      mountPeople(body, people);
    } catch (err) {
      console.warn('People section skipped —', err.message || err);
      const root = body.querySelector('#people-root');
      if (root) root.remove();   // no stray empty mount under the heading
    }
    content.appendChild(body);
    scrollToAnchor(anchor);
  }

  function viewSetupIndex() {
    // #/setup routes to the "start" landing page
    return viewSetupPage('start/index', null);
  }

  // ---------- search (precomputed static index; see js/search.js) ----------
  const KIND_LABEL = { page: 'page', class: 'class', fn: 'function', file: 'file', cad: 'CAD part', fork: 'fork file' };

  const searchRow = (r) => `
      <div class="result">
        <a class="title" href="${esc(r.href)}"${r.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${esc(r.title)}</a>
        <span class="where">${esc(r.where)} · ${esc(KIND_LABEL[r.kind] || r.kind)}</span>
        <p>${esc(r.snippet)}</p>
      </div>`;

  /* Two paints, one view. The local ranking lands the moment it exists, so a
     search is as instant as it has always been; if the librarian answers, the
     same view is repainted with its picks on top. Both paints are guarded by
     the route epoch, and the repaint is skipped when nothing actually changed
     (a single-word query, or a host with no librarian at all). */
  async function viewSearch(query) {
    sidebar.innerHTML = '';
    setTitle([`Search: ${query}`]);
    content.innerHTML = '<div class="search-results"><h1>Search</h1><p class="lead">Searching…</p></div>';
    const epoch = routeEpoch;
    let painted = null;

    const paint = (res) => {
      if (epoch !== routeEpoch) return;             // a newer navigation owns the view
      if (painted && painted.results === res.results
          && painted.librarianCount === res.librarianCount
          && painted.notice === res.notice) return;  // nothing changed: no repaint
      const first = !painted;
      painted = res;
      // The librarian's picks lead; the divider marks where the plain local
      // index takes over. Both are absent on a host with no function, which is
      // what the GitHub Pages copy looks like — and it looks unchanged.
      const picks = res.librarianCount > 0 ? res.results.slice(0, res.librarianCount) : [];
      const rest = res.results.slice(picks.length);
      // The divider is a boundary, not a heading: it only earns its place when
      // there is actually something on the far side of it. A narrow query where
      // the librarian picked every local hit gets no divider at all.
      const divider = (picks.length && rest.length)
        ? '<p class="result-divider">More from the local index</p>' : '';
      const notice = res.notice ? `<p class="search-notice">${esc(res.notice)}</p>` : '';
      const rows = picks.map(searchRow).join('') + divider + rest.map(searchRow).join('');
      content.innerHTML = `
      <div class="search-results">
        <h1>Search</h1>
        <p class="lead">${res.results.length ? res.results.length : 'No'} result${res.results.length === 1 ? '' : 's'} for
        “${esc(query)}” across ${res.total.toLocaleString()} indexed pages, code symbols, CAD parts, and files.</p>
        ${res.results.length ? rows : '<p>Try a symbol name, a part name, a setup topic, or a project.</p>'}
        ${notice}
      </div>`;
      // This view owns its own scroll (route() skips the search route): the
      // jump to the top belongs to the FIRST paint, so a slow librarian cannot
      // leave fresh results sitting at the old offset — and the later repaint
      // must NOT yank a reader who has already scrolled into the list.
      if (first) window.scrollTo({ top: 0, behavior: 'instant' });
    };

    let res;
    try {
      res = await HCSearch.query(query, { onLocal: paint });
    } catch (err) {
      if (epoch === routeEpoch) errorPanel(err);
      return;
    }
    paint(res);
  }

  // ---------- router ----------
  async function route() {
    routeEpoch += 1;
    const hash = location.hash || '#/';
    const [pathPart, anchor] = hash.slice(1).split('@');
    const [path, queryStr] = pathPart.split('?');
    const seg = path.split('/').filter(Boolean);
    try {
      if (seg.length === 0) { navHighlight(null); viewHome(); }
      else if (seg[0] === 'setup' && seg.length === 1) { navHighlight('setup'); await viewSetupIndex(); }
      else if (seg[0] === 'setup') { navHighlight('setup'); await viewSetupPage(seg.slice(1).join('/'), anchor); }
      else if (seg[0] === 'projects' && seg.length === 1) { navHighlight('projects'); viewProjects(); }
      else if (seg[0] === 'projects') { navHighlight('projects'); await viewProjectDetail(seg[1], anchor); }
      else if (seg[0] === 'tools' && seg.length === 1) { navHighlight('tools'); viewTools(); }
      else if (seg[0] === 'tools') { navHighlight('tools'); await viewToolPage(seg[1], anchor); }
      else if (seg[0] === 'about') { navHighlight('about'); await viewAbout(anchor); }
      else if (seg[0] === 'search') {
        navHighlight(null);
        const q = new URLSearchParams(queryStr || '').get('q') || '';
        await viewSearch(q);
      } else { throw new Error(`Unknown page: ${path}`); }
      // viewSearch scrolls on its own first paint, so it is excluded here —
      // otherwise this would fire only after the optional librarian round trip.
      if (!anchor && seg[0] !== 'search') window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (err) {
      errorPanel(err);
    }
  }

  // ---------- boot ----------
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('hc-theme'); } catch (e) { /* private mode */ }
    if (saved === 'light') document.documentElement.dataset.theme = 'light';
    $('#theme-toggle').addEventListener('click', () => {
      const light = document.documentElement.dataset.theme === 'light';
      if (light) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = 'light';
      try { localStorage.setItem('hc-theme', light ? 'dark' : 'light'); } catch (e) { /* ok */ }
    });
  }

  function initSearchBox() {
    const input = $('#search-input');
    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input &&
          !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  async function boot() {
    initTheme();
    initSearchBox();
    try {
      const [site, setup, projects, tools] = await Promise.all([
        fetchJSON('data/site.json'), fetchJSON('data/setup.json'),
        fetchJSON('data/projects.json'), fetchJSON('data/tools.json'),
      ]);
      Object.assign(DATA, { site, setup, projects, tools });
    } catch (err) {
      errorPanel(err);
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
}());
