// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Route and render the documentation site's pages from JSON registries and Markdown.
/* HippoCampus Robotics docs — hash router + renderers.
   Zero-build: this file, marked.min.js (vendored, MIT), and JSON/Markdown content.
   Slug rule mirrors tools/rst_convert.py slugify() — keep them in sync.
   Every content read goes through HC (js/source.js: same-origin fetch, or the
   CMS preview bridge inside a preview frame), and every rendered Markdown page
   through HCSanitize (js/sanitize.js). Both load before this file. */
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
  function fetchJSON(path) {
    return HC.fetchJSON(path);
  }
  async function fetchMD(path) {
    if (mdCache[path]) return mdCache[path];
    const text = await HC.fetchText(path);
    mdCache[path] = text;
    return text;
  }
  function setTitle(parts) {
    document.title = [...parts, 'HippoCampus Robotics'].filter(Boolean).join(' · ');
  }
  /* E1: the not-found view and the error panel. notFoundAdvice, isNotFound and redirectFor are pure
     (window.HCRoute, tested under node). The serve.sh / file:// advice is for a developer running the
     site locally, so it shows only there; the public site gets the way back instead. */
  function notFoundAdvice(loc) {
    if (!loc) return false;
    return loc.protocol === 'file:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  }
  function isNotFound(err) {
    if (!err) return false;
    if (err.notFound === true) return true;
    return /^(No (setup page|project|tool)|Unknown page)/.test(String(err.message || ''));
  }
  // old addresses that moved (J8: the run guide is now a section of Learning to Swim)
  const REDIRECTS = Object.freeze({
    '/projects/learning-to-swim-run-guide': '#/projects/learning-to-swim@simulation-run-guide',
  });
  function redirectFor(path) {
    const key = String(path || '');
    return Object.prototype.hasOwnProperty.call(REDIRECTS, key) ? REDIRECTS[key] : null;
  }
  window.HCRoute = Object.freeze({ notFoundAdvice, isNotFound, redirectFor, REDIRECTS });

  const WAY_BACK = `<a href="#/setup">Setup</a>, <a href="#/projects">Projects</a> or <a href="#/team">Team</a>`;

  function errorPanel(err) {
    setTitle(['Page could not be loaded']);
    const advice = notFoundAdvice(location)
      ? `<p>If you are running locally, serve the site with
       <code>./tools/serve.sh</code> (plain <code>file://</code> cannot fetch content).</p>`
      : `<p>The page could not be loaded. Reload, or go to ${WAY_BACK}.</p>`;
    content.innerHTML =
      `<div class="error-panel"><h1>Something broke</h1>
       <p>${esc(err && err.message ? err.message : String(err))}</p>
       ${advice}</div>`;
  }

  function viewNotFound(path) {
    navHighlight(null);
    sidebar.innerHTML = '';
    setTitle(['Page not found']);
    content.innerHTML = `
      <section class="not-found">
        <p class="kicker">404</p>
        <h1>Page not found</h1>
        <p class="lead">There is no page at <code>${esc(path || '/')}</code>. It may have moved, or the link has a typo.</p>
        <form class="not-found-search" role="search">
          <label class="visually-hidden" for="not-found-input">Search the site</label>
          <input id="not-found-input" type="search" autocomplete="off" placeholder="Search the site">
          <button type="submit" class="hc-btn">Search</button>
        </form>
        <p>Or go to ${WAY_BACK}.</p>
      </section>`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    const form = content.querySelector('.not-found-search');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = form.querySelector('input');
        const q = input && input.value ? input.value.trim() : '';
        if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
      });
    }
  }

  // ---------- markdown rendering + enhancement ----------
  function renderMarkdown(md) {
    marked.use({ mangle: false, headerIds: false });
    const html = HCSanitize.clean(marked.parse(md));   // allowlist first, enhance() after
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
      btn.setAttribute('aria-label', 'Copy code');
      btn.addEventListener('click', () => {
        // innerText keeps the logical lines: a long line wrapped on screen (P2) copies as one line
        navigator.clipboard.writeText(copyText(pre.innerText)).then(() => {
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
    // external links in new tabs. The scheme's case is free (HCSanitize keeps
    // HTTPS://…), so the match ignores it: an outside link that opened in place
    // would load a foreign page inside the Editor's frame.
    root.querySelectorAll('a[href^="http" i]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener';
    });
  }

  function scrollToAnchor(anchor) {
    if (!anchor) { window.scrollTo(0, 0); return; }
    const target = document.getElementById(anchor);
    if (target) target.scrollIntoView();
  }

  // ---------- setup pages: pure helpers (uiux unit SETUP; window.HCSetup, tested under node) ----------
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TOC_MIN = 3;        // fewer h2/h3 headings than this: no "On this page" list (P1)

  /* [{tag, id, text}] -> [{id, text, level}] for the h2/h3 headings that have an id,
     or [] when there are fewer than TOC_MIN of them. */
  function tocModel(headings) {
    const out = [];
    (Array.isArray(headings) ? headings : []).forEach((h) => {
      if (!h || typeof h !== 'object') return;
      const tag = String(h.tag || '').toLowerCase();
      const level = tag === 'h2' ? 2 : (tag === 'h3' ? 3 : 0);
      const id = typeof h.id === 'string' ? h.id : '';
      const text = String(h.text == null ? '' : h.text).replace(/\s+/g, ' ').trim();
      if (level && id && text) out.push({ id, text, level });
    });
    return out.length >= TOC_MIN ? out : [];
  }

  /* data/graph/page-authors.json's day for one page ('setup/<id>'): pages[key].last_commit when it
     is a plain YYYY-MM-DD (the GitHub layer writes it, unit M), else null. Every read is guarded. */
  function pageDate(authorsDoc, pageKey) {
    const pages = authorsDoc && typeof authorsDoc === 'object' ? authorsDoc.pages : null;
    if (!pages || typeof pages !== 'object' || !Object.prototype.hasOwnProperty.call(pages, pageKey)) return null;
    const entry = pages[pageKey];
    const day = entry && typeof entry === 'object' ? entry.last_commit : null;
    return typeof day === 'string' && DAY_RE.test(day) ? day : null;
  }

  // the setup pages in reading order, and the index of this one -> {prev, next}: {id, title, href} | null
  function pageNavModel(flat, i) {
    const list = Array.isArray(flat) ? flat : [];
    const at = (j) => {
      const p = j >= 0 && j < list.length ? list[j] : null;
      return p ? { id: p.id, title: p.title, href: `#/setup/${p.id}` } : null;
    };
    return { prev: at(i - 1), next: at(i + 1) };
  }

  // what a code block's copy button copies: "$ " prompts stripped when the block has them, no trailing space
  function copyText(text) {
    let t = String(text == null ? '' : text);
    if (/^\$ /m.test(t)) t = t.split('\n').map((l) => l.replace(/^\$ /, '')).join('\n');
    return t.trimEnd();
  }

  window.HCSetup = Object.freeze({ tocModel, pageDate, pageNavModel, copyText });

  // ---------- setup pages: the "On this page" list (P1/P3), the date (P10), prev/next (P9) ----------
  function tocList(entries, pageId) {
    const ol = document.createElement('ol');
    let sub = null;
    entries.forEach((e) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#/setup/${pageId}@${e.id}`;
      a.textContent = e.text;
      a.setAttribute('data-toc-id', e.id);
      li.appendChild(a);
      const parent = ol.lastElementChild;
      if (e.level === 3 && parent) {
        if (!sub || sub.parentNode !== parent) { sub = document.createElement('ol'); parent.appendChild(sub); }
        sub.appendChild(li);
      } else {
        ol.appendChild(li);
        sub = null;
      }
    });
    return ol;
  }

  /* The side list (nav.page-toc) and the fold-out (details.page-toc-fold) from the rendered body's
     headings; CSS shows one of them by the content box's width. null when the page is too short.
     Headings inside tabs or a <details> are left out: a link to a hidden heading goes nowhere. */
  function buildToc(body, pageId) {
    const heads = Array.from(body.querySelectorAll('h2, h3'))
      .filter((h) => !(h.closest && h.closest('.tabs, details')))
      .map((h) => {
        const c = h.cloneNode(true);
        c.querySelectorAll('.heading-anchor').forEach((a) => a.remove());
        return { tag: h.tagName, id: h.id, text: c.textContent };
      });
    const entries = tocModel(heads);
    if (!entries.length) return null;
    const nav = document.createElement('nav');
    nav.className = 'page-toc';
    nav.setAttribute('aria-label', 'On this page');
    const title = document.createElement('p');
    title.className = 'page-toc-title';
    title.textContent = 'On this page';
    nav.append(title, tocList(entries, pageId));
    const fold = document.createElement('details');
    fold.className = 'page-toc-fold';
    const summary = document.createElement('summary');
    summary.textContent = 'On this page';
    fold.append(summary, tocList(entries, pageId));
    return { nav, fold, entries };
  }

  /* Marks the link of the heading being read (aria-current="true"): the last heading whose top has
     passed the top 30 % of the window under the header. The observer (and scrollend) only say WHEN to
     look again; none passed yet (the page top) marks nothing. Both stop once the route moves on. */
  function watchToc(root, entries, epoch) {
    if (typeof IntersectionObserver !== 'function') return;
    const heads = entries.map((e) => document.getElementById(e.id)).filter(Boolean);
    if (!heads.length) return;
    const links = Array.from(root.querySelectorAll('a[data-toc-id]'));
    const header = document.querySelector('.site-header');
    const top = Math.round((header && header.offsetHeight) || 56);
    const update = () => {
      const line = top + (window.innerHeight - top) * 0.3;
      let id = null;
      heads.forEach((h) => { if (h.getBoundingClientRect().top <= line) id = h.id; });
      links.forEach((a) => {
        if (id && a.getAttribute('data-toc-id') === id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    };
    // a smooth scroll can end after the observer's last report: look once more when it settles
    const settle = () => { if (epoch !== routeEpoch || !root.isConnected) stop(); else update(); };
    const io = new IntersectionObserver(settle, { rootMargin: `-${top}px 0px -70% 0px` });
    function stop() { io.disconnect(); window.removeEventListener('scrollend', settle); }
    window.addEventListener('scrollend', settle, { passive: true });
    heads.forEach((h) => io.observe(h));
  }

  let authorsDocP = null;   // data/graph/page-authors.json, read once per session (null when unreadable)
  function showPageDate(body, pageId, epoch) {
    authorsDocP = authorsDocP || Promise.resolve().then(() => fetchJSON('data/graph/page-authors.json')).catch(() => null);
    return authorsDocP.then((doc) => {
      if (epoch !== routeEpoch || !body.isConnected || body.querySelector('.page-meta')) return;
      const day = pageDate(doc, `setup/${pageId}`);
      const h1 = body.querySelector('h1');
      if (!day || !h1) return;
      const p = document.createElement('p');
      p.className = 'page-meta';
      const time = document.createElement('time');
      time.setAttribute('datetime', day);
      time.textContent = day;
      p.append('Updated ', time);
      h1.after(p);
    });
  }

  function pageNavHTML(model) {
    const card = (p, rel) => (p ? `<a class="page-nav-${rel}" href="${esc(p.href)}" rel="${rel}">
        <span class="page-nav-label">${rel === 'prev' ? '← Previous' : 'Next →'}</span>
        <span class="page-nav-title">${esc(p.title)}</span></a>` : '<span></span>');
    return card(model.prev, 'prev') + card(model.next, 'next');
  }

  // ---------- sidebar ----------
  /* The setup sidebar as data (uiux P5, P6): one entry per group, `open` only
     for the active page's group, and a page's `label` carries " · <group>"
     only when its title appears in more than one group ("Pre-built
     Packages" under Getting started and under Raspberry Pi setup). Pure:
     window.HCShell exports both for tools/tests/test_app_guest.mjs. */
  function dupTitleSet(setup) {
    const groupsOf = new Map();
    for (const sec of (setup && setup.sections) || []) {
      for (const p of sec.pages || []) {
        if (!groupsOf.has(p.title)) groupsOf.set(p.title, new Set());
        groupsOf.get(p.title).add(sec);
      }
    }
    return new Set([...groupsOf].filter(([, g]) => g.size > 1).map(([t]) => t));
  }
  function sidebarModel(setup, activeId) {
    const dups = dupTitleSet(setup);
    return ((setup && setup.sections) || []).map((sec) => {
      const pages = (sec.pages || []).map((p) => {
        const suffix = dups.has(p.title) ? sec.title : null;
        return { id: p.id, title: p.title, label: suffix ? `${p.title} · ${suffix}` : p.title, suffix, active: p.id === activeId };
      });
      return { title: sec.title, open: pages.some((p) => p.active), pages };
    });
  }
  function sidebarSetup(activeId) {
    sidebar.innerHTML = sidebarModel(DATA.setup, activeId).map((g) => {
      const links = g.pages.map((p) =>
        `<a href="#/setup/${p.id}"${p.active ? ' class="active" aria-current="page"' : ''}>${esc(p.title)}${
          p.suffix ? `<span class="sb-suffix"> · ${esc(p.suffix)}</span>` : ''}</a>`
      ).join('');
      return `<details class="sb-group"${g.open ? ' open' : ''}><summary>${esc(g.title)}</summary>${links}${newPageLink(g.title)}</details>`;
    }).join('');
    const act = sidebar.querySelector('a.active');
    // only where the sidebar is its own scroller beside the page; in the phone drawer the
    // drawer's open() brings the active link into view
    if (act && !drawerMode()) act.scrollIntoView({ block: 'nearest' });
  }
  /* U6 (plan D11, ED51): "+ New page" at the end of each group, shown in Editor mode only (css/site.css
     body.hc-editor-on .sb-new-page). data/setup.json is generated by tools/rst_convert.py and never edited by
     hand, so the item opens a prefilled issue on the lab repo, in a new tab. */
  const NEW_PAGE_ISSUE = 'https://github.com/desert-mango/hippocampus-docs/issues/new';
  function newPageLink(group) {
    const title = `New setup page in ${group}: <page title>`;
    const body = [`Please add a new setup page to the group "${group}".`, '',
      'Title: <page title>', '', 'What it should cover: <say what the page is for>', '',
      '(The setup pages are listed in data/setup.json, which tools/rst_convert.py writes, so a maintainer adds the page.)'].join('\n');
    const href = `${NEW_PAGE_ISSUE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    return `<a class="sb-new-page" href="${esc(href)}" target="_blank" rel="noopener noreferrer">+ New page<span class="visually-hidden"> (opens GitHub in a new tab)</span></a>`;
  }
  function sidebarList(title, items, base, activeId) {
    sidebar.innerHTML = `<h3>${esc(title)}</h3>` + items.map((it) =>
      `<a href="#${base}/${it.id}" class="${it.id === activeId ? 'active' : ''}">${esc(it.name || it.title)}</a>`
    ).join('');
  }

  function navHighlight(section) {
    document.querySelectorAll('.site-nav a').forEach((a) => {
      const on = a.dataset.nav === section;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');   // WCAG-9: the state, not only the look
      else a.removeAttribute('aria-current');
    });
  }

  // ---------- views ----------
  /* HOME — direction A: the search field IS the front door.

     The hero's box is not a second search. It calls the very same
     HCSearch.query(q, {onLocal}) entry viewSearch uses below, gets the same
     ranking in the same order, and renders the same rows in a panel six deep
     instead of a whole page; Enter hands the query to #/search for the full
     list. There is no index in this file — a homepage search that lied about
     what the site contains would be worse than no homepage search.

     The four section cards keep their registry entries and their routes; they
     are simply demoted to a quiet row under a divider, because a reader who
     already knows where they are going clicks past the box. */
  const HERO_LIMIT = 6;          // rows in the hero panel before "see all"
  const HERO_DEBOUNCE_MS = 180;  // one query per pause, not one per keystroke
  // F4: below 640 px the long example placeholder is cut off, so phones get a short one.
  const HERO_PHONE_QUERY = '(max-width: 639px)';

  /* Pure helpers (uiux H5, F4), exported as window.HCHome.
     heroPlaceholder(narrow) -> the placeholder for a phone (narrow) or a wider screen.
     heroImage(site, narrow) -> {src, width, height, alt} | null: the vehicle photo of
       data/site.json `hero` (a guarded read: no hero, or an image that is not an https
       URL, gives null), as a Cloudinary rendition cut for the width: 21:9 at 1200 px wide,
       16:9 at 750 px for phones. width/height are the rendition's own, so the page does
       not jump when the photo arrives. */
  const heroPlaceholder = (narrow) => (narrow ? 'Search the docs…'
    : 'e.g. how do I flash PX4 on the HippoCampus?');
  function heroImage(site, narrow) {
    const hero = site && typeof site === 'object' ? site.hero : null;
    if (!hero || typeof hero !== 'object') return null;
    const image = typeof hero.image === 'string' ? hero.image.trim() : '';
    if (!/^https:\/\/[^\s"<>]+$/i.test(image)) return null;
    const cut = narrow
      ? { tx: 'w_750,c_fill,ar_16:9,g_auto,f_auto,q_auto', width: 750, height: 422 }
      : { tx: 'w_1200,c_fill,ar_21:9,g_auto,f_auto,q_auto', width: 1200, height: 514 };
    return {
      src: cloudinaryTx(image, cut.tx), width: cut.width, height: cut.height,
      alt: typeof hero.alt === 'string' ? hero.alt : '',
    };
  }
  const isPhoneWidth = () => typeof window.matchMedia === 'function'
    && window.matchMedia(HERO_PHONE_QUERY).matches;
  // The picture: phones take the 16:9 source, every wider screen the 21:9 img. Above the
  // fold, so never lazy.
  function heroPictureHTML(site) {
    const wide = heroImage(site, false);
    if (!wide) return '';
    const narrow = heroImage(site, true);
    return `
        <picture class="hero-pic">
          <source media="${HERO_PHONE_QUERY}" srcset="${esc(narrow.src)}" width="${narrow.width}" height="${narrow.height}">
          <img class="hero-img" src="${esc(wide.src)}" width="${wide.width}" height="${wide.height}"
               alt="${esc(wide.alt)}" fetchpriority="high" decoding="async">
        </picture>`;
  }

  const heroHitRow = (r) => `
        <a class="hit" href="${esc(r.href)}"${r.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>
          <span class="t"><span class="kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span>${esc(r.title)}</span>
          <span class="p">${esc(HCSearch.hitPath(r))}</span>
        </a>`;

  function viewHome() {
    sidebar.innerHTML = '';
    setTitle([]);
    const s = DATA.site;
    const chips = HCSearch.exampleQueries(s);
    content.innerHTML = `
      <section class="hero">
        <p class="kicker">${esc(s.kicker)}</p>
        <h1>${esc(s.title)}</h1>
        <p class="lead">${esc(s.lead)}</p>${heroPictureHTML(s)}
        <div class="askbox">
          <form id="hero-search-form" role="search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4.5-4.5"/></svg>
            <label class="visually-hidden" for="hero-search-input">Search the lab documentation</label>
            <input id="hero-search-input" type="search" autocomplete="off"
                   aria-describedby="hero-search-status"
                   placeholder="${esc(heroPlaceholder(isPhoneWidth()))}">
            <kbd aria-hidden="true">/</kbd>
          </form>${chips.length ? `
          <div class="ask-chips" role="group" aria-label="Example searches">
            ${chips.map((c, i) => `<button type="button" class="ask-chip" data-chip="${i}">${esc(c.label)}</button>`).join('')}
          </div>` : ''}
          <div class="results" id="hero-results" role="region" aria-label="Search results" hidden>
            <div class="head"><span class="dot" aria-hidden="true"></span>
              <span id="hero-search-status" role="status" aria-live="polite"></span></div>
            <div id="hero-hits"></div>
          </div>
        </div>
      </section>
      <div class="home-sections">
        <div class="sep">or go straight to</div>
        <div class="quietgrid">
          ${s.home_cards.map((c) => `
            <a class="quiet" href="${esc(c.href)}">
              <span class="n">${esc(c.title)} <span class="arrow">→</span></span>
              <span class="d">${esc(c.text)}</span>
            </a>`).join('')}
        </div>
      </div>`;
    wireHero(chips);
  }

  /* The hero's listeners live on nodes viewHome just created, so they die with
     the markup on the next navigation — nothing to tear down. Two guards keep a
     slow answer from painting over a newer one: `token` (the newest keystroke
     owns the panel) and the route epoch (this hero belongs to this navigation). */
  function wireHero(chips) {
    const form = $('#hero-search-form');
    const input = $('#hero-search-input');
    const panel = $('#hero-results');
    const list = $('#hero-hits');
    const status = $('#hero-search-status');
    if (!form || !input || !panel || !list || !status) return;
    const epoch = routeEpoch;
    let token = 0;
    let timer = null;

    // F4: the placeholder follows the width. The media query outlives this markup, so the
    // listener drops itself on the first change after the reader has left this hero.
    if (typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(HERO_PHONE_QUERY);
      const onWidth = (e) => {
        if (epoch !== routeEpoch) {
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onWidth);
          return;
        }
        input.placeholder = heroPlaceholder(Boolean(e && e.matches));
      };
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onWidth);
    }

    const paint = (mine, query, res) => {
      if (mine !== token || epoch !== routeEpoch) return;
      const rows = HCSearch.heroHits(res, HERO_LIMIT);
      // Same rule as viewSearch: a multi-word query the keyword index answered
      // with nothing is still out with the librarian, so do not call it empty.
      const waiting = !res.results.length && /\s/.test(query) && !HCSearch.librarianLatched();
      status.textContent = HCSearch.heroStatus(res, rows.length, waiting);
      const more = res.results.length > rows.length ? `
        <a class="hit more" href="#/search?q=${encodeURIComponent(query)}">
          <span class="t">See all ${res.results.length} results <span class="arrow">→</span></span>
        </a>` : '';
      // An empty panel says what to try instead — the same advice viewSearch
      // gives — and drops the green dot, which would otherwise report health
      // over a miss. A query still out with the librarian says nothing yet.
      const miss = (rows.length || waiting) ? '' :
        '<p class="miss">Try a symbol name, a part name, a setup topic, or a project.</p>';
      list.innerHTML = rows.length ? rows.map(heroHitRow).join('') + more : miss;
      panel.classList.toggle('empty', !rows.length);
      panel.hidden = false;
    };

    const run = (query) => {
      const mine = (token += 1);
      if (!query) {
        panel.hidden = true;
        list.innerHTML = '';
        status.textContent = '';
        return;
      }
      status.textContent = 'searching…';
      list.innerHTML = '';
      panel.hidden = false;
      HCSearch.query(query, { onLocal: (res) => paint(mine, query, res) })
        .then((res) => paint(mine, query, res))
        .catch(() => {
          if (mine !== token || epoch !== routeEpoch) return;
          status.textContent = 'the search index did not load — reload the page';
        });
    };

    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (timer) clearTimeout(timer);
      // The keystroke itself retires whatever is in flight. Waiting for the
      // debounce to do it would leave a window in which a slow answer about the
      // PREVIOUS text still counts as current and paints over a box that now
      // reads something else; the rows already on screen simply stay until the
      // new answer lands.
      token += 1;
      if (!query) { run(''); return; }
      timer = setTimeout(() => run(query), HERO_DEBOUNCE_MS);
    });
    // Enter hands the query to the full results page, exactly as the header box does.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (query) location.hash = `#/search?q=${encodeURIComponent(query)}`;
    });
    // A chip's label is what a reader recognises; its `q` is the term the index
    // knows. The index into `chips` stays in the DOM, never the query itself.
    content.querySelectorAll('.ask-chip').forEach((button) => {
      button.addEventListener('click', () => {
        const chip = chips[Number(button.dataset.chip)];
        if (!chip) return;
        input.value = chip.q;
        input.focus();
        if (timer) clearTimeout(timer);
        run(chip.q);
      });
    });
  }

  window.HCHome = Object.freeze({ heroPlaceholder, heroImage });

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
    // prev / next as two cards (P9)
    const nav = document.createElement('nav');
    nav.className = 'page-nav';
    nav.setAttribute('aria-label', 'Previous and next page');
    nav.innerHTML = pageNavHTML(pageNavModel(flat, flat.indexOf(page)));
    body.appendChild(nav);
    // the article, then the side "On this page" list; the fold-out copy is the article's first child,
    // ahead of the Markdown's first block (the Editor frame groups blocks from there on)
    const layout = document.createElement('div');
    layout.className = 'setup-layout';
    layout.appendChild(body);
    const toc = buildToc(body, page.id);
    if (toc) {
      layout.classList.add('has-toc');
      body.insertBefore(toc.fold, body.firstChild);
      layout.appendChild(toc.nav);
    }
    content.appendChild(layout);
    if (window.HCLab) HCLab.renderAuthors(body, `setup/${page.id}`);
    showPageDate(body, page.id, epoch);
    if (toc) watchToc(layout, toc.entries, epoch);
    scrollToAnchor(anchor);
  }

  function statusBadge(status) {
    return `<span class="badge ${esc(status)}">${esc(status)}</span>`;
  }

  // ---------- projects: groups, the status filter, key facts (uiux unit J) ----------
  // J12: the list is grouped. A facts file's optional "group" picks the section;
  // a missing or unknown one lands in "Other", last.
  const PROJECT_GROUPS = [
    ['vehicles', 'Vehicles'], ['software', 'Software'], ['research', 'Research'],
    ['lab', 'Lab infrastructure'], ['teaching', 'Teaching'], ['fun', 'Fun'],
  ];
  const PROJECT_STATUSES = ['active', 'maintained', 'legacy', 'archive'];

  function groupProjects(projects, status) {
    const list = Array.isArray(projects) ? projects : [];
    const known = new Map(PROJECT_GROUPS.map(([id, title]) => [id, { id, title, projects: [] }]));
    const other = { id: 'other', title: 'Other', projects: [] };
    list.forEach((p) => {
      if (!p || (status && p.status !== status)) return;
      (known.get(p.group || null) || other).projects.push(p);
    });
    return [...known.values(), other].filter((g) => g.projects.length);
  }

  // '#/projects?status=legacy' -> 'legacy'; anything else -> null (All)
  // allowed: the statuses the data holds (statusList); the fixed four when not given
  function statusFilter(hash, allowed) {
    const h = typeof hash === 'string' ? hash : '';
    const q = h.split('@')[0].split('?')[1] || '';
    const s = new URLSearchParams(q).get('status');
    const ok = Array.isArray(allowed) ? allowed : PROJECT_STATUSES;
    return s && ok.includes(s) ? s : null;
  }

  // J12: one filter chip per status the data holds: the fixed order first, any other
  // status after them alphabetically, each with its count.
  function statusList(projects) {
    const counts = new Map();
    (Array.isArray(projects) ? projects : []).forEach((p) => {
      const s = p && typeof p.status === 'string' ? p.status : '';
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    });
    const rank = (s) => { const i = PROJECT_STATUSES.indexOf(s); return i < 0 ? PROJECT_STATUSES.length : i; };
    return [...counts.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
      .map((status) => ({ status, count: counts.get(status) }));
  }

  // J11: the key-facts row. people: the contributors file's rows plus its
  // "truncated" rest (null when that file is missing); lastActivity: the newest
  // pushed_at among the project's repositories in data/graph/github-repos.json.
  function keyFacts(p, contributorsEntry, reposDoc) {
    const repos = (p && Array.isArray(p.repos)) ? p.repos : [];
    const rows = (contributorsEntry && Array.isArray(contributorsEntry.contributors))
      ? contributorsEntry.contributors : null;
    const people = rows ? rows.length + (Number(contributorsEntry.truncated) || 0) : null;
    const raw = reposDoc && reposDoc.repos;
    const byName = new Map();
    if (Array.isArray(raw)) raw.forEach((r) => { if (r && r.name) byName.set(r.name, r); });
    else if (raw && typeof raw === 'object') Object.keys(raw).forEach((k) => byName.set(k, raw[k]));
    let lastActivity = null;
    repos.forEach((r) => {
      const hit = r && byName.get(r.name);
      const at = hit && typeof hit.pushed_at === 'string' ? hit.pushed_at : null;
      if (at && (!lastActivity || at > lastActivity)) lastActivity = at;
    });
    return { status: (p && p.status) || null, people, repos: repos.length, lastActivity };
  }

  // J11: the first three setup links become "start here" cards; the rest stay in See also.
  function startHere(links) {
    const start = [];
    const rest = [];
    (Array.isArray(links) ? links : []).forEach((l) => {
      const setup = l && typeof l.href === 'string' && l.href.startsWith('#/setup/');
      if (setup && start.length < 3) start.push(l); else if (l) rest.push(l);
    });
    return { start, rest };
  }

  // the GitHub layer behind the key facts, read once and guarded: missing means "unknown"
  let projectGraph = null;
  function loadProjectGraph() {
    if (!projectGraph) {
      const soft = (path) => fetchJSON(path).catch(() => null);
      projectGraph = Promise.all([soft('data/graph/contributors.json'), soft('data/graph/github-repos.json')])
        .then(([contributors, repos]) => {
          // review J advisory: cache only a result where a file loaded, so a blip is retried on the next visit
          if (!contributors && !repos) projectGraph = null;
          return { contributors, repos };
        });
    }
    return projectGraph;
  }

  function projectInitials(name) {
    const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    return (words.slice(0, 2).map((w) => Array.from(w)[0]).join('') || '?').toUpperCase();
  }

  // an animated GIF becomes its first frame: a still card, no motion in a grid
  const stillTx = (url) => (/\.gif$/i.test(url) ? ',pg_1' : '');

  function projectCard(p) {
    const n = Array.isArray(p.repos) ? p.repos.length : 0;
    const img = typeof p.image === 'string' ? safeHttpUrl(p.image) : null;
    const pic = img
      ? `<img class="card-img" src="${esc(cloudinaryTx(img, `w_640,c_fill,ar_16:9,g_auto${stillTx(img)},f_auto,q_auto`))}"
           width="640" height="360" loading="lazy" decoding="async" alt="">`
      : `<span class="card-img card-tile" aria-hidden="true">${esc(projectInitials(p.name))}</span>`;
    return `
      <a class="card project-card" href="#/projects/${esc(p.id)}">
        ${pic}
        <span class="card-body">
          <h3><span class="card-name">${esc(p.name)}</span> ${statusBadge(p.status)}</h3>
          <p>${esc(p.tagline)}</p>
          ${n ? `<span class="card-meta">${n} ${n === 1 ? 'repository' : 'repositories'}</span>` : ''}
        </span>
      </a>`;
  }

  function viewProjects() {
    sidebar.innerHTML = '';                 // J6: the cards are the list; no copy beside them
    setTitle(['Projects']);
    const all = DATA.projects.projects;
    const statuses = statusList(all);
    const status = statusFilter(location.hash, statuses.map((x) => x.status));
    const chip = (s, label, n) => `<a class="filter-chip" href="#/projects${s ? `?status=${encodeURIComponent(s)}` : ''}"${
      s === status ? ' aria-current="true"' : ''}>${esc(label)} <span class="filter-n">${n}</span></a>`;
    const filters = [chip(null, 'All', all.length),
      ...statuses.map((x) => chip(x.status, x.status.charAt(0).toUpperCase() + x.status.slice(1), x.count))].join('');
    const groups = groupProjects(all, status).map((g) => `
      <section class="project-group" aria-labelledby="pg-${g.id}">
        <h2 id="pg-${g.id}">${esc(g.title)}</h2>
        <div class="project-grid">${g.projects.map(projectCard).join('')}</div>
      </section>`).join('');
    content.innerHTML = `
      <div class="page-body projects-page">
        <p class="kicker">The team's work</p>
        <h1>Projects</h1>
        <p class="lead">${esc(DATA.projects.intro)}</p>
        <nav class="project-filter" aria-label="Filter by status">${filters}</nav>
        ${groups || '<p class="empty-note">No project has this status.</p>'}
        <div class="project-grid project-new-row" hidden><button type="button" class="card project-card project-new" data-hc-new-project>
          <span class="card-img card-tile" aria-hidden="true">+</span>
          <span class="card-body"><span class="card-h3"><span class="card-name">New project</span></span><span class="card-p">Add a project: its name, one line and status.</span></span>
        </button></div>
        <p class="provenance">Coverage rule: every repository in the
        <a href="https://github.com/HippoCampusRobotics">HippoCampusRobotics org</a> belongs to exactly
        one project above (in its own file under <code>data/projects/</code>, or listed with a reason in the
        exclusions inside <code>data/projects.json</code>); <code>tools/check.py</code> enforces this.</p>
      </div>`;
  }

  function keyFactsHTML(f) {
    const item = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return `<dl class="key-facts">
      <div><dt>Status</dt><dd data-hc-fact="status" data-hc-value="${esc(f.status || 'unknown')}">${statusBadge(f.status || 'unknown')}</dd></div>
      ${f.people ? item('People', String(f.people)) : ''}
      ${f.repos ? item('Repositories', String(f.repos)) : ''}
      ${f.lastActivity ? item('Last activity', `<time datetime="${esc(f.lastActivity)}">${esc(f.lastActivity)}</time>`) : ''}
    </dl>`;
  }

  async function viewProjectDetail(id, anchor) {
    const p = DATA.projects.projects.find((x) => x.id === id);
    if (!p) throw new Error(`No project “${id}”`);
    sidebarList('Projects', DATA.projects.projects, '/projects', id);
    setTitle([p.name, 'Projects']);
    const epoch = routeEpoch;
    const [md, graph] = await Promise.all([fetchMD(p.file), loadProjectGraph()]);
    if (epoch !== routeEpoch) return;
    const entry = graph.contributors && graph.contributors.projects ? graph.contributors.projects[p.id] : null;
    const facts = keyFacts(p, entry || null, graph.repos);
    const repos = Array.isArray(p.repos) ? p.repos : [];
    const repoRows = repos.map((r) => `
      <li class="repo-row"><a class="chip" href="${esc(r.url)}">${esc(r.name)}</a>
      <span class="role">${esc(r.role || '')}</span></li>`).join('');
    const hwList = Array.isArray(p.hardware) ? p.hardware : [];
    const hw = hwList.map((h) => `<li>${esc(h)}</li>`).join('');
    const links = startHere(p.links);
    const docs = links.rest.map((l) => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`).join('');
    const sectionOf = new Map();
    DATA.setup.sections.forEach((s) => s.pages.forEach((pg) => sectionOf.set(`#/setup/${pg.id}`, s.title)));
    const start = links.start.map((l) => `
      <a class="start-card" href="${esc(l.href)}">
        <span class="start-sec">${esc(sectionOf.get(l.href.split('@')[0]) || 'Setup')}</span>
        <span class="start-title">${esc(l.label)}</span>
      </a>`).join('');
    const img = typeof p.image === 'string' ? safeHttpUrl(p.image) : null;
    const hero = img ? `<img class="project-hero" src="${esc(cloudinaryTx(img, `w_1400,c_fill,ar_21:9,g_auto${stillTx(img)},f_auto,q_auto`))}"
      width="1400" height="600" alt="" decoding="async">` : '';
    content.innerHTML = `
      <div class="project-page">
        <a class="back-link" href="#/projects">← All projects</a>
        <h1 style="margin-top:0.8rem" data-hc-fact="name">${esc(p.name)}</h1>
        <p class="lead" data-hc-fact="tagline">${esc(p.tagline)}</p>
        ${hero}
        ${keyFactsHTML(facts)}
        <div id="project-people" class="project-people"></div>
        ${start ? `<section class="start-here" aria-labelledby="start-here-h">
          <h2 id="start-here-h">Start here</h2><div class="start-grid">${start}</div></section>` : ''}
        <div class="detail-wrap">
          <div class="detail-grid">
            <aside class="detail-aside"><div class="aside-box" data-hc-surface="project-access" data-hc-project="${esc(p.id)}">
              ${repoRows ? `<div data-hc-fact="repos" data-hc-value="${esc(repos.map((r) => r.name).join(' '))}"><h3>Repositories (${repos.length})</h3><ul>${repoRows}</ul></div>` : ''}
              ${hw ? `<div><h3>Hardware (${hwList.length})</h3><ul>${hw}</ul></div>` : ''}
              ${docs ? `<div><h3>See also</h3><ul>${docs}</ul></div>` : ''}
            </div></aside>
            <div class="detail-main" id="project-md"></div>
          </div>
        </div>
      </div>`;
    const body = renderMarkdown(md);
    $('#project-md').appendChild(body);
    if (img) dropHeroTwin($('#project-md'), img, $('.project-hero', content));
    if (window.HCGraph) HCGraph.renderContributors(id, $('.aside-box'), $('#project-people'));
    if (window.HCLab) { HCLab.renderRepoCards($('.aside-box')); HCLab.renderAuthors($('#project-md .page-body'), `projects/${id}`); }
    scrollToAnchor(anchor);
  }

  // J10: when the story opens with the hero's own picture, the hero takes its alt text
  // and the story's copy goes, so the page never shows the same image twice.
  function dropHeroTwin(root, url, hero) {
    if (!root || !hero || typeof root.querySelectorAll !== 'function') return;
    const twin = Array.from(root.querySelectorAll('img')).find((im) => im.getAttribute('src') === url);
    if (!twin) return;
    hero.setAttribute('alt', twin.getAttribute('alt') || '');
    const para = twin.parentElement;
    if (para && para.tagName === 'P' && para.textContent.trim() === '' && para.children.length === 1) para.remove();
    else twin.remove();
  }

  // the projects helpers, pure (uiux unit J; tools/tests/test_projects_ui.mjs)
  window.HCProjects = Object.freeze({ groupProjects, statusFilter, statusList, keyFacts, startHere });

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
      <div class="page-body">
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
    if (window.HCLab) HCLab.renderAuthors($('.page-body', content), `tools/${id}`);
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
  // pass through untouched. cloudinaryTx(url, tx) puts the transformation `tx` in front of
  // the asset; people cards ask for 'w_320,f_auto,q_auto'.
  function cloudinaryTx(url, tx) {
    const m = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/.exec(url);
    if (!m) return url;
    const first = m[2].split('/')[0];
    // A transformation segment is comma-joined `key_value` pairs. `v1234` is a version,
    // and anything ending in a file extension is a public_id, not a transform.
    const transformed = !/^v\d+$/.test(first) && /^[a-z]+_[^/]+$/.test(first)
      && !/\.[a-z0-9]{2,4}$/i.test(first);
    return transformed ? url : `${m[1]}${tx}/${m[2]}`;
  }
  function initials(name) {
    const letters = name.trim().split(/\s+/).slice(0, 2)
      .map((word) => Array.from(word)[0] || '').join('');
    return letters.toUpperCase() || '?';
  }
  /* Round 2 (R5, Kyle 2026-10-15): the WHOLE card is the person's link — photo, name and title. A highlighted
     title (people.json `highlight: true`) is in the site's accent; an optional `subtitle` is a second, plain
     title line under it (Kyle 2026-10-21).
     M5 (uiux 2026-10, R1-4): a plain click opens the person's profile dialog (js/lab.js), which holds the link;
     a linked card stays an <a href> (cmd/ctrl/middle click still open the page in a new tab); a link-less card is a focusable role="button" div. Both carry data-hc-person.
     entry = HCLab.splitTeam's {person, linked, active, pinned} (or a bare person); the data-* attributes are
     what Editor mode's card tools read (js/editor-people.js). */
  function personCardHTML(entry) {
    const person = entry && entry.person ? entry.person : entry;
    const name = (person && typeof person.name === 'string') ? person.name.trim() : '';
    if (!name) return '';
    const photo = safeHttpUrl(person.photo);
    const media = photo
      ? `<img class="person-photo" src="${esc(cloudinaryTx(photo, 'w_320,f_auto,q_auto'))}" alt="" loading="lazy">`
      : `<div class="person-initials" aria-hidden="true">${esc(initials(name))}</div>`;
    const hl = person.highlight === true ? ' is-highlight' : '';
    const title = (typeof person.title === 'string' && person.title.trim())
      ? `<span class="person-title${hl}">${esc(person.title)}</span>` : '';
    const sub = (typeof person.subtitle === 'string' && person.subtitle.trim())
      ? `<span class="person-title person-subtitle">${esc(person.subtitle)}</span>` : '';
    const inner = `${media}<span class="person-name">${esc(name)}</span>${title}${sub}`;
    const link = safeHttpUrl(person.link);
    const flags = entry && entry.person
      ? ` data-linked="${entry.linked ? 1 : 0}" data-active="${entry.active ? 1 : 0}" data-pinned="${entry.pinned ? 1 : 0}"` : '';
    // U5 (editor UI/UX build): the person's one public GitHub login, when the GitHub layer knows it (read-only)
    const login = entry && typeof entry.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(entry.login) ? ` data-hc-login="${esc(entry.login)}"` : '';
    const data = ` data-hc-name="${esc(name)}" data-link="${link ? 1 : 0}"${flags}${login} data-hc-person="${esc(name)}" aria-haspopup="dialog"`;
    return link
      ? `<a class="person-card" href="${esc(link)}" target="_blank" rel="noopener"${data}>${inner}</a>`
      : `<div class="person-card is-static" role="button" tabindex="0"${data}>${inner}</div>`;
  }
  /* Round 2 (R5): two lists, the current team and the alumni, sorted by js/lab.js splitTeam (GitHub work in the
     last 30 days or an admin's pin; unlinked people where an admin put them). Without the GitHub layer (or
     lab.js) the registry's own groups stand. Throws on a malformed roster. */
  const today = () => new Date().toISOString().slice(0, 10);
  function teamLists(data, pub) {
    if (!data || !Array.isArray(data.groups)) throw new Error('data/people.json is malformed');
    // U5: roster name -> the one public login people-public.json maps to it (two logins: none)
    const logins = new Map();
    const pp = pub && typeof pub === 'object' && pub.people && typeof pub.people === 'object' ? pub.people : {};
    for (const k of Object.keys(pp)) {
      const r = pp[k] && typeof pp[k].roster === 'string' ? pp[k].roster : null;
      if (r) logins.set(r, logins.has(r) ? null : k);
    }
    const withLogin = (l) => l.map((x) => (logins.get(x.person && x.person.name) ? Object.assign({}, x, { login: logins.get(x.person.name) }) : x));
    if (window.HCLab && typeof HCLab.splitTeam === 'function') {
      const s = HCLab.splitTeam(data, pub, today());
      return [['team', 'Current team', withLogin(s.team)], ['alumni', 'Alumni', withLogin(s.alumni)]];
    }
    return data.groups.map((g) => [g.id === 'active' ? 'team' : 'alumni', g.id === 'active' ? 'Current team' : (g.title || 'Alumni'),
      withLogin((Array.isArray(g.people) ? g.people : []).map((person) => ({ person })))]);
  }
  /* M1/M6/M7/M14/M15/M16 (uiux 2026-10): the Team page, as ONE string — the h1, the people first (the current
     team, then the alumni, each an h2 over cards of one size), then "Lab activity" with "· GitHub data as of
     <day>" on its line. lists: teamLists' [[id, title, entries]] (null: no roster, no people mount); asOf: the
     GitHub layer's read_at day, or null. viewTeam writes exactly this, then puts the rendered about.md around the
     people mount and the Lab activity body into .team-lab-body. */
  function teamSkeleton(lists, asOf) {
    const groups = Array.isArray(lists) ? lists.map(([id, title, list]) => {
      // an empty list keeps its place: Editor mode adds people to it
      return `<div class="people-group" data-hc-list="${esc(id)}">
        <h2>${esc(title)}</h2>
        <div class="people-grid">${list.map(personCardHTML).join('')}</div>
      </div>`;
    }).join('') : null;
    const day = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : null;
    return `<div class="page-body hc-team">
      <h1>Team</h1>
      <section class="team-people" aria-label="People">${groups === null ? '' : `<div id="people-root">${groups}</div>`}</section>
      <section class="team-lab" aria-labelledby="team-lab-h">
        <div class="hc-lab-head"><h2 id="team-lab-h">Lab activity</h2>${day ? ` <span class="hc-asof-inline">· GitHub data as of ${day}</span>` : ''}</div>
        <div class="team-lab-body"></div>
      </section>
    </div>`;
  }

  /* Round 2 (R5, Kyle 2026-10-15): #/team replaces About and Lab (both redirect here). M1/M16 (uiux 2026-10): the
     people first — the current team, then the alumni — then Lab activity. content/about.md holds only the people
     mount (the "Who can edit what" rule is docs/maintainer-protocols.md §2b). No "who wrote this" here (M15). */
  async function viewTeam(anchor) {
    sidebar.innerHTML = '';
    setTitle(['Team']);
    const epoch = routeEpoch;
    // The roster and the GitHub layer are page-local extras: never let a failure take the page down.
    const [md, people, pub, act] = await Promise.all([
      fetchMD('content/about.md').catch(() => '<div id="people-root"></div>\n'),
      fetchJSON('data/people.json').catch((err) => err),
      fetchJSON('data/graph/people-public.json').catch(() => null),
      fetchJSON('data/graph/org-activity.json').catch(() => null),
    ]);
    if (epoch !== routeEpoch) return;
    let lists = null;
    try {
      if (people instanceof Error) throw people;
      lists = teamLists(people, pub);
    } catch (err) {
      console.warn('People section skipped —', err.message || err);
    }
    const asOf = act && typeof act === 'object' && typeof act.read_at === 'string' ? act.read_at.slice(0, 10) : null;
    content.innerHTML = '';
    const page = el(teamSkeleton(lists, asOf)).firstElementChild;   // the element: it is used after it is appended
    // about.md's own text, if it ever has any, sits around the people: its mount is replaced by the filled one
    const body = renderMarkdown(md);
    const mount = body && body.querySelector('#people-root');
    const filled = page.querySelector('#people-root');
    if (mount) mount.replaceWith(filled || document.createComment('people'));
    const people_ = page.querySelector('.team-people');
    if (body && (mount || body.textContent.trim())) people_.appendChild(body);
    content.appendChild(page);
    if (window.HCLab) {
      HCLab.renderLab(page.querySelector('.team-lab-body'), () => epoch === routeEpoch, { embedded: true })
        .catch((err) => console.warn('Lab activity skipped —', (err && err.message) || err));
      HCLab.wirePeople(body && body.isConnected ? body : people_);
    }
    scrollToAnchor(anchor);
  }

  // the Team page's string builders, read by tools/tests/test_views.mjs; cloudinaryTx also sizes js/lab.js's
  // profile photo
  window.HCTeam = Object.freeze({ teamSkeleton, personCardHTML, teamLists, cloudinaryTx });

  function viewSetupIndex() {
    // #/setup routes to the "start" landing page
    return viewSetupPage('start/index', null);
  }

  // ---------- search (precomputed static index; see js/search.js) ----------
  const KIND_LABEL = { page: 'page', class: 'class', fn: 'function', file: 'file', cad: 'CAD part', fork: 'fork file', repo: 'repository' };

  /* One result row (S4, S6): a kind badge, the title and the plain-text
     snippet with the query's words marked. highlightParts splits the text
     into segments and EACH segment goes through esc(), so a <mark> is the
     only markup this row adds to model- or index-authored text. `why` is the
     librarian's one-line reason for a row: MODEL-authored text about a
     user-controlled, URL-shareable query, so it is the least trusted string
     on this page and goes through esc() like every other field. */
  function searchRow(r, terms) {
    const hl = (text) => HCSearch.highlightParts(text, terms)
      .map((p) => (p.hit ? `<mark class="hl">${esc(p.text)}</mark>` : esc(p.text))).join('');
    const snippet = HCSearch.plainSnippet(r.snippet);
    return `
      <div class="result">
        <span class="kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span><a class="title" href="${esc(r.href)}"${r.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${hl(r.title)}</a>
        ${r.where ? `<span class="where">${esc(r.where)}</span>` : ''}${snippet ? `
        <p>${hl(snippet)}</p>` : ''}${r.why ? `
        <p class="why">${esc(r.why)}</p>` : ''}
      </div>`;
  }

  /* Two paints, one view. The local ranking lands the moment it exists, so a
     search is as instant as it has always been; if the librarian answers, the
     same view is repainted with its picks on top. Both paints are guarded by
     the route epoch, and the repaint is skipped when nothing actually changed
     (a single-word query, or a host with no librarian at all).

     The one exception is the WAITING paint: every multi-word query is still
     out with the librarian after the local paint, so that paint says so (S5:
     "The librarian is still looking…", above the rows or inside the empty
     block). It must ALWAYS be replaced — including on a host with no function
     at all, where the final answer is the same array by reference and the
     skip guard would otherwise leave the waiting line up forever — so a
     waiting paint bypasses the guard.

     S3: the librarian's picks lead; below them a tab row (Pages / Code / CAD /
     All, with counts) splits the local rows. The tabs are real links, so the
     URL holds the tab; switching re-routes, and a hash that names a tab reuses
     the last finished answer for the same query instead of asking again. */
  async function viewSearch(query) {
    sidebar.innerHTML = '';
    setTitle([`Search: ${query}`]);
    const hash = location.hash || '';
    const tabbed = /[?&]kind=/.test(hash);   // a tab link, not a fresh search
    // WCAG-6: one visually hidden status line tells a screen reader what the search found
    const statusP = (text) => `<p class="search-status visually-hidden" role="status" aria-live="polite">${esc(text)}</p>`;
    content.innerHTML = `<div class="search-results"><h1>Search</h1><p class="lead">Searching…</p>${statusP('Searching…')}</div>`;
    const epoch = routeEpoch;
    const terms = HCSearch.queryTerms(query);
    const TAB_NAMES = { page: 'Pages', code: 'Code', cad: 'CAD', all: 'All' };
    const TAB_EMPTY = { page: 'No pages', code: 'No code', cad: 'No CAD parts', all: 'No results' };
    let painted = null;

    const paint = (res, opts) => {
      if (epoch !== routeEpoch) return;             // a newer navigation owns the view
      if (painted && !painted.waiting
          && painted.results === res.results
          && painted.librarianCount === res.librarianCount
          && painted.notice === res.notice) return;  // nothing changed: no repaint
      const first = !painted;
      // A multi-word query is still out with the librarian after the local
      // paint, unless the librarian has latched off on this host.
      const waiting = first && !(opts && opts.final) && /\s/.test(String(query).trim())
        && !HCSearch.librarianLatched();
      painted = {
        results: res.results, librarianCount: res.librarianCount,
        notice: res.notice, waiting,
      };
      const picks = res.librarianCount > 0 ? res.results.slice(0, res.librarianCount) : [];
      const rest = res.results.slice(picks.length);
      const groups = HCSearch.groupResults(rest);
      const tab = HCSearch.searchTab(hash, groups);
      const shown = tab === 'all' ? rest : groups[tab];
      const count = { page: groups.page.length, code: groups.code.length, cad: groups.cad.length, all: rest.length };
      const tabs = `
        <nav class="search-tabs" aria-label="Result types">${['page', 'code', 'cad', 'all'].map((k) => `
          <a href="${esc(HCSearch.searchTabHref(query, k))}"${k === tab ? ' aria-current="page"' : ''}>${TAB_NAMES[k]} <span class="count">${count[k]}</span></a>`).join('')}
        </nav>`;
      const pickBlock = picks.length ? `
        <section class="search-picks" aria-label="Librarian picks">
          <p class="result-divider search-picks-label">Librarian picks</p>
          ${picks.map((r) => searchRow(r, terms)).join('')}
        </section>` : '';
      const waitLine = waiting
        ? '<p class="search-waiting">The librarian is still looking…</p>' : '';   // the news is in the one status line
      let body;
      if (shown.length) {
        body = shown.map((r) => searchRow(r, terms)).join('');
      } else {
        const m = HCSearch.noResultsModel({ results: rest }, DATA.site, waiting);
        body = `
        <div class="search-empty">
          <p>${TAB_EMPTY[tab]} for “${esc(query)}”${tab === 'all' ? '' : ` — <a href="${esc(HCSearch.searchTabHref(query, 'all'))}">see all results</a>`}.</p>${m.chips.length ? `
          <p class="search-empty-h">Try an example search</p>
          <div class="search-chips">
            ${m.chips.map((c) => `<a class="search-chip" href="${esc(c.href)}">${esc(c.label)}</a>`).join('')}
          </div>` : ''}${m.nearest.length ? `
          <p class="search-empty-h">Nearest pages</p>
          ${m.nearest.map((r) => searchRow(r, terms)).join('')}` : ''}
          <p class="search-empty-tip">Try a symbol name, a part name, a setup topic, or a project.</p>
        </div>`;
      }
      const notice = res.notice ? `<p class="search-notice">${esc(res.notice)}</p>` : '';
      const all = HCSearch.groupResults(res.results);
      const byKind = [[all.page.length, 'page', 'pages'], [all.code.length, 'code', 'code'], [all.cad.length, 'CAD', 'CAD']]
        .filter((k) => k[0] > 0).map((k) => `${k[0]} ${k[0] === 1 ? k[1] : k[2]}`).join(', ');
      const statusText = (res.results.length
        ? `${res.results.length} result${res.results.length === 1 ? '' : 's'} for “${query}”${byKind ? `: ${byKind}` : ''}.`
        : `No results for “${query}”.`)
        + (waiting ? ' The librarian is still looking…' : '');
      content.innerHTML = `
      <div class="search-results">
        <h1>Search</h1>
        <p class="lead">${res.results.length ? res.results.length : 'No'} result${res.results.length === 1 ? '' : 's'} for
        “${esc(query)}” across ${res.total.toLocaleString()} indexed pages, code symbols, CAD parts, and files.</p>
        ${statusP(statusText)}${waitLine}${pickBlock}${tabs}
        <div class="search-tabpanel">${body}</div>
        ${notice}
      </div>`;
      // a live region that arrives already filled is not reliably read: fill it a moment after it lands
      const live = content.querySelector('.search-status');
      if (live && typeof live.textContent === 'string' && live.textContent) {
        live.textContent = '';
        setTimeout(() => { if (epoch === routeEpoch && live.isConnected) live.textContent = statusText; }, 60);
      }
      // This view owns its own scroll (route() skips the search route): the
      // jump to the top belongs to the FIRST paint, so a slow librarian cannot
      // leave fresh results sitting at the old offset — and the later repaint
      // must NOT yank a reader who has already scrolled into the list. A tab
      // switch keeps keyboard focus on the tab row instead.
      if (first) {
        if (opts && opts.fromTab) {
          const current = content.querySelector('.search-tabs [aria-current="page"]');
          if (current && current.focus) current.focus();
        } else {
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
    };

    const memo = tabbed ? HCSearch.lastAnswer(query) : null;
    if (memo) { paint(memo, { final: true, fromTab: true }); return; }
    let res;
    try {
      res = await HCSearch.query(query, { onLocal: paint });
    } catch (err) {
      if (epoch === routeEpoch) errorPanel(err);
      return;
    }
    paint(res);
  }

  // ---------- the footer's Editor entry ----------
  /* One footer link, for a signed-in reader only (uiux P4/H2: a guest's one
     sign-in entry is the header's button, #signin-btn). Signed in, it is
     "Edit this page", pointed at
     the page on screen with ?editor=changes — the Editor entry (plan D-H,
     D-I): js/editor.js reads the parameter on hashchange, turns Editor mode
     on and opens the tray's Changes tab. The page id is site-mcp's
     page_index id — setup/<id>, project/<id>, tool/<id>, about — which is
     also the id the editor's page list uses; lists, home and search have
     none, and there the signed-in link hides. A preview frame (HC.preview)
     never shows it. */
  function editPageId(seg) {
    if (seg[0] === 'setup') return seg.length === 1 ? 'setup/start/index' : `setup/${seg.slice(1).join('/')}`;
    if (seg[0] === 'projects' && seg.length === 2) return `project/${seg[1]}`;
    if (seg[0] === 'tools' && seg.length === 2) return `tool/${seg[1]}`;
    if ((seg[0] === 'about' || seg[0] === 'team') && seg.length === 1) return 'about';
    return null;
  }
  let editRoute = null;                     // the page route the link points at, or null
  function setEditLink(route) {
    editRoute = route;
    const link = $('#edit-page');
    if (!link) return;
    link.removeAttribute('role');
    if (HC.preview || !editor.signedIn) {
      link.removeAttribute('href');
      link.hidden = true;
    } else if (route) {
      link.setAttribute('href', `#${route}?editor=changes`);
      link.textContent = 'Edit this page';
      link.hidden = false;
    } else {
      link.removeAttribute('href');
      link.hidden = true;
    }
  }

  // ---------- Editor mode: loaded for a session or the sign-in click only (plan D-C) ----------
  /* Guests load no editor code and make no GitHub request: index.html has no
     tag for js/cms-core.js, js/editor-dock.js, js/editor.js or css/editor.css. This file injects
     them, and only (1) when the sign-in marker cookie hc_in=1 is present and
     the resume call (GET /api/auth?session=1, api/auth.js's sealed httpOnly
     cookie, U1/D20) hands back a token — anonymous visitors never call it — or
     (2) on the header's "Sign in" click (#signin-btn), which opens the GitHub
     window FIRST — synchronously inside the click, because a window opened
     after an await is blocked — then injects, then hands that window to the
     editor's sign-in. A preview frame (HC.preview) never reads the cookie or
     storage and never loads the editor; every cookie and storage access sits
     in try/catch, because a sandboxed frame throws on them.
     The literals repeat HCCore's (this file must not load HCCore first);
     tools/tests/test_app_guest.mjs proves them equal.
     window.HCApp.loadEditor(opts) is the test seam (opts.fetch, opts.session or
     opts.resumed: the localhost walk's fake GitHub and its in-memory session, never
     kept anywhere but page memory); HC is frozen by js/source.js, so the seam is
     its own frozen object. */
  const MARKER_RE = /(?:^|;\s*)hc_in=1(?:;|$)/;
  const RESUME_URL = '/api/auth?session=1';
  const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
  const CALLBACK_PATH = '/cms/callback.html';
  const SAME_TAB_KEY = 'hc-signin-same-tab';    // js/cms-callback.js reads it back
  const POPUP_NAME = 'hc-signin';
  const POPUP_FEATURES = 'popup=yes,width=620,height=720';
  const EDITOR_FILES = [
    ['link', { rel: 'stylesheet', href: 'css/editor.css' }],
    ['script', { src: 'js/cms-core.js' }],
    ['script', { src: 'js/editor-dock.js' }],
    ['script', { src: 'js/editor.js' }],
  ];
  const editor = { loading: null, loaded: new Set(), signedIn: false, session: false, status: null, prompt: false, sessionKnown: false,
    boot: null };   // U1: bootSession's resume -> Promise<boolean> (the editor started from the cookie), or null

  /* The marker says a sign-in may be resumed; it holds no secret (the token is
     sealed in the httpOnly hc_s cookie, which this page cannot read). */
  function signedInMarker() {
    if (HC.preview) return false;
    try { return MARKER_RE.test(String(document.cookie || '')); } catch (e) { return false; }
  }

  /* -> Promise<{token, expiresIn} | null>, never rejects. The custom header makes
     any cross-origin caller preflight, which api/auth.js never grants. */
  function resumeSession() {
    return Promise.resolve()
      .then(() => window.fetch(RESUME_URL, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'X-HC-Session': '1' } }))
      .then((res) => (res && res.ok ? res.json() : null))
      .then((body) => {
        if (!body || typeof body.token !== 'string' || !body.token) return null;
        const at = Number(body.expires_at);
        const left = Number.isFinite(at) ? Math.floor((at - Date.now()) / 1000) : null;
        if (left !== null && left <= 0) return null;
        return { token: body.token, expiresIn: left };
      })
      .catch(() => null);
  }

  /* The line beside the footer link: sign-in progress and failures, as text. It sits after the
     link, so it shows on its own while a guest's link is hidden. */
  function footerStatus(text, kind) {
    const link = $('#edit-page');
    if (!link) return;
    if (!editor.status) {
      editor.status = document.createElement('span');
      editor.status.className = 'edit-status';
      editor.status.setAttribute('role', 'status');
      link.after(editor.status);
    }
    editor.status.textContent = text || '';
    editor.status.hidden = !text;
    editor.status.classList.toggle('is-error', kind === 'error');
  }

  /* The ?editor= bootstrap (plan D-H, D-I: /cms/'s old links land on
     #/<route>?editor=<tab>). With a session, js/editor.js is loaded at boot
     and reads (and strips) the parameter itself. A guest cannot be signed
     in without a click, so the footer line asks for one; the parameter stays in
     the address for the editor to read once the sign-in starts. */
  function editorParamPrompt(hash) {
    const want = !HC.preview && !editor.session && !editor.signedIn && !editor.loading
      && /[?&]editor=/.test(String(hash).split('@')[0]);
    if (want) { editor.prompt = true; footerStatus('Sign in (top right) to open the Editor.'); }
    else if (editor.prompt) { editor.prompt = false; footerStatus(''); }
  }

  function onEditorSession(signedIn) {
    editor.signedIn = Boolean(signedIn);
    if (!signedIn) editor.session = false;   // signed out, or the stored session ended: a guest again
    setEditLink(editRoute);
    syncSignIn();
  }

  /* One element into <head>, resolved when it loaded. A file that loaded
     once is never injected again; one that failed is removed, so a later
     click tries it afresh. */
  function inject(tag, attrs) {
    const name = attrs.src || attrs.href;
    if (editor.loaded.has(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const node = document.createElement(tag);
      for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
      node.addEventListener('load', () => { editor.loaded.add(name); resolve(); });
      node.addEventListener('error', () => { node.remove(); reject(new Error(`${name} did not load`)); });
      document.head.appendChild(node);
    });
  }

  function injectEditor() {
    if (!editor.loading) {
      editor.loading = EDITOR_FILES.reduce((chain, [tag, attrs]) => chain.then(() => inject(tag, attrs)),
        Promise.resolve()).then(() => {
        if (!window.HCEditor || typeof window.HCEditor.start !== 'function') throw new Error('js/editor.js did not start');
      });
      editor.loading.catch(() => { editor.loading = null; });
    }
    return editor.loading;
  }

  /* Inject, then start the editor. opts.popup: the window the sign-in click
     opened. -> Promise<boolean> (the editor started or signs in). */
  function loadEditor(opts) {
    const o = opts || {};
    if (HC.preview) return Promise.resolve(false);
    return injectEditor().then(() => window.HCEditor.start({
      fetch: typeof o.fetch === 'function' ? o.fetch : undefined,
      session: o.session && typeof o.session === 'object' ? o.session : undefined,
      resumed: o.resumed && typeof o.resumed === 'object' ? o.resumed : undefined,
      popup: o.popup || undefined,
      status: typeof o.status === 'function' ? o.status : footerStatus,
      onSession: onEditorSession,
    }) === true).catch(() => {
      if (o.popup) { try { o.popup.close(); } catch (e) { /* already gone */ } }
      (typeof o.status === 'function' ? o.status : footerStatus)(
        'The editor could not be loaded. Check the connection and try again.', 'error');
      return false;
    });
  }

  function initEditorEntry() {
    const link = $('#edit-page');
    if (link && !HC.preview) link.addEventListener('click', signInClick);   // signed in: a plain link
    initSignIn();
  }

  /* The guest's sign-in (uiux P4, F3): one quiet button, the header's last item. It shows only
     for a guest with no stored session (never in a preview frame, never once signed in), and
     slides out past the header's right edge while the reader scrolls down, back on any upward
     scroll of 24 px or at the top (recedeState, pure). A focused button never recedes. The slide
     is css/site.css's (body.hc-signin-hidden); the header clips it, so it adds no scroll width. */
  function recedeState(prev, move) {
    const hidden = Boolean(prev && prev.hidden);
    const y = Number(move && move.y) || 0;
    const dy = Number(move && move.dy) || 0;
    if (y <= 0 || dy <= -24) return { hidden: false };
    if (y > 80 && dy > 0) return { hidden: true };
    return { hidden };
  }
  let recede = { hidden: false };
  function initSignIn() {
    const btn = $('#signin-btn');
    if (!btn || HC.preview) return;
    btn.addEventListener('click', signInClick);
    let last = 0;
    let peak = 0;                            // where the current upward run began
    window.addEventListener('scroll', () => {
      const y = Math.max(0, window.scrollY || 0);
      const d = y - last;
      last = y;
      if (d > 0) peak = y;
      const next = recedeState(recede, { y, dy: d > 0 ? d : y - peak });
      if (next.hidden && document.activeElement === btn) return;   // a focused button stays
      if (next.hidden === recede.hidden) return;
      recede = next;
      document.body.classList.toggle('hc-signin-hidden', recede.hidden);
    }, { passive: true });
  }
  function syncSignIn() {
    const btn = $('#signin-btn');
    if (!btn) return;
    btn.hidden = HC.preview || !editor.sessionKnown || editor.signedIn || editor.session;
    if (!btn.hidden && recede.hidden) {      // a guest again (signed out) while scrolled down: show it now
      recede = { hidden: false };
      document.body.classList.remove('hc-signin-hidden');
    }
  }

  /* U1 (D19, ED1): the sign-in speaks where the click was — a polite live line
     right after the clicked control (the header button, or the footer link),
     as text. One line per control, hidden while empty. */
  const signInLines = new Map();
  const signInNext = new WeakMap();   // a new line's words, set on the next frame
  function signInLine(anchor) {
    const at = anchor && typeof anchor.after === 'function' ? anchor : ($('#signin-btn') || $('#edit-page'));
    return (text, kind) => {
      if (!at) return;
      let line = signInLines.get(at);
      const put = (l, t, k) => {
        l.textContent = t || '';
        l.hidden = !t;
        l.classList.toggle('is-error', k === 'error');
      };
      if (!line) {
        // WCAG 4.1.3 (fixes pass B11): the live line goes in EMPTY; its words come on the next frame, so a screen
        // reader hears them as a change
        line = document.createElement('span');
        line.className = 'edit-status hc-signin-status';
        line.setAttribute('role', 'status');
        line.setAttribute('aria-live', 'polite');
        at.after(line);
        signInLines.set(at, line);
        const fresh = line;
        signInNext.set(fresh, { text, kind });
        const later = typeof window.requestAnimationFrame === 'function' ? (fn) => window.requestAnimationFrame(fn) : (fn) => window.setTimeout(fn, 16);
        later(() => { const n = signInNext.get(fresh); signInNext.delete(fresh); if (n) put(fresh, n.text, n.kind); });
        return;
      }
      if (signInNext.has(line)) { signInNext.set(line, { text, kind }); return; }   // its first words are on their way
      put(line, text, kind);
    };
  }

  /* The pop-up was blocked (or this browser opens none, e.g. an embedded pane):
     sign in in THIS tab. The `state` (the CSRF guard) and the route to come
     back to go to sessionStorage, which survives the trip to GitHub in this
     tab; cms/callback.html, finding no opener, checks the state, POSTs the
     code to /api/auth itself (which sets the session cookie) and returns
     here, where the boot resumes from the cookie. */
  function sameTabSignIn(say) {
    say('Pop-ups are blocked here, so sign-in continues in this tab…');
    return Promise.resolve()
      .then(() => window.fetch('/api/auth?app=editor',
        { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' }))
      .then((res) => Promise.resolve(res.json()).catch(() => null).then((body) => ({ res, body })))
      .then(({ res, body }) => {
        if (!res.ok || !body || typeof body.client_id !== 'string' || !body.client_id) {
          say(body && typeof body.error === 'string' ? `Sign-in is not available here: ${body.error}.`
            : 'Sign-in needs this site\'s server functions, which this host does not run.', 'error');
          return;
        }
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        try {
          window.sessionStorage.setItem(SAME_TAB_KEY,
            JSON.stringify({ state, route: String(location.hash || '#/'), at: Date.now() }));
        } catch (err) {
          say('This browser blocks both pop-ups and site storage, so sign-in cannot finish here. '
            + 'Allow pop-ups for this site and try again.', 'error');
          return;
        }
        const q = new URLSearchParams({ client_id: body.client_id, redirect_uri: location.origin + CALLBACK_PATH, state });
        location.assign(`${AUTHORIZE_URL}?${q.toString()}`);
      })
      .catch(() => say('Sign-in could not reach this site\'s server. Check the connection and try again.', 'error'));
  }

  function signInClick(e) {
    if (editor.signedIn) return;               // "Edit this page": a plain link
    e.preventDefault();
    // first, before anything else: the browser allows this window only
    // inside the click itself
    const popup = window.open('about:blank', POPUP_NAME, POPUP_FEATURES);
    const say = signInLine(e.currentTarget || e.target);
    editor.prompt = false;
    footerStatus('');
    if (!popup) { sameTabSignIn(say); return; }
    say('');
    loadEditor({ popup, status: say });
  }

  // the shell's pure helpers, for tools/tests/test_app_guest.mjs (uiux P5, P6, F3)
  window.HCShell = Object.freeze({ sidebarModel, dupTitleSet, recedeState });

  window.HCApp = Object.freeze({
    loadEditor(opts) {
      const o = opts || {};
      // U1: resumed {token, expiresIn} — the walk's ?auth=cookie mode, after the real /api/auth handshake.
      // When the boot is resuming from the cookie (a reload, a second tab), its start is the answer: the editor
      // starts once, and the seam is true when that start was; only a resume the server turned down starts anew.
      const own = () => loadEditor({ fetch: o.fetch, session: o.session, resumed: o.resumed });
      return editor.boot ? editor.boot.then((started) => started || own()) : own();
    },
  });

  // ---------- the header search box, and who owns search on this route ----------
  /* On #/ the hero owns search, so the header's own box closes into its right
     edge; every other route has it. The motion is one class and a CSS width
     transition (css/site.css, "the header search box" block) — no per-frame
     script, no library.

     hc-anim is what keeps a COLD load still. It is added one frame after the
     first route, so the very first class toggle happens with no transition
     declared: a deep link paints the box at full size and #/ paints it already
     closed, neither of them animating. Every later navigation sweeps. */
  let animReady = false;
  function setHeaderSearch(hash) {
    document.body.classList.toggle('hc-hero-search', HCSearch.isHomeHash(hash));
    if (animReady) return;
    animReady = true;
    requestAnimationFrame(() => document.body.classList.add('hc-anim'));
  }

  // ---------- router ----------
  let routed = false;        // a page has been drawn (the first route() call)
  async function route() {
    let hash = location.hash || '#/';
    // WCAG-1: a hash that is not "#/…" is an in-page anchor (the skip link's #content), not a
    // route: leave the page as it is. Only a first load on such a hash draws the home page.
    if (!hash.startsWith('#/')) {
      if (routed) return;
      hash = '#/';
    }
    routed = true;
    routeEpoch += 1;
    const epoch = routeEpoch;
    const [pathPart, anchor] = hash.slice(1).split('@');
    const [path, queryStr] = pathPart.split('?');
    const seg = path.split('/').filter(Boolean);
    setEditLink(null);                      // no stale link while the next page loads
    editorParamPrompt(hash);
    setHeaderSearch(hash);                  // the home route hands search to the hero
    try {
      const moved = redirectFor(path);
      if (moved) {                          // an old address (J8), same shape as about/lab below:
        const [to, toAnchor] = moved.split('@');   // its ?query (an old ?editor= link) comes along (codex r1)
        location.replace(`${to}${queryStr ? `?${queryStr}` : ''}${toAnchor ? `@${toAnchor}` : ''}`);
        return;
      }
      if (seg.length === 0) { navHighlight(null); viewHome(); }
      else if (seg[0] === 'setup' && seg.length === 1) { navHighlight('setup'); await viewSetupIndex(); }
      else if (seg[0] === 'setup') { navHighlight('setup'); await viewSetupPage(seg.slice(1).join('/'), anchor); }
      else if (seg[0] === 'projects' && seg.length === 1) { navHighlight('projects'); viewProjects(); }
      else if (seg[0] === 'projects') { navHighlight('projects'); await viewProjectDetail(seg[1], anchor); }
      else if (seg[0] === 'tools' && seg.length === 1) { navHighlight('tools'); viewTools(); }
      else if (seg[0] === 'tools') { navHighlight('tools'); await viewToolPage(seg[1], anchor); }
      else if (seg[0] === 'team' && seg.length === 1) { navHighlight('team'); await viewTeam(anchor); }
      else if ((seg[0] === 'about' || seg[0] === 'lab') && seg.length === 1) {
        // round 2 (R5): About and Lab became the Team page; the old addresses land there
        // (its ?query — an old ?editor= link — and its @anchor come along, codex r1)
        location.replace(`#/team${queryStr ? `?${queryStr}` : ''}${anchor ? `@${anchor}` : ''}`);
        return;
      }
      else if (seg[0] === 'search') {
        navHighlight(null);
        const q = new URLSearchParams(queryStr || '').get('q') || '';
        await viewSearch(q);
      } else { viewNotFound(path); return; }
      // viewSearch scrolls on its own first paint, so it is excluded here —
      // otherwise this would fire only after the optional librarian round trip.
      if (!anchor && seg[0] !== 'search') window.scrollTo({ top: 0, behavior: 'instant' });
      if (epoch === routeEpoch) setEditLink(editPageId(seg) ? `/${seg.join('/')}` : null);
    } catch (err) {
      if (epoch !== routeEpoch) return;     // a later navigation owns the page now
      if (isNotFound(err)) viewNotFound(path);
      else errorPanel(err);
    }
  }

  // ---------- boot ----------
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('hc-theme'); } catch (e) { /* private mode */ }
    if (saved === 'light') document.documentElement.dataset.theme = 'light';
    const btn = $('#theme-toggle');
    // WCAG-8: the toggle says its state: pressed = the light theme is on
    const pressed = () => btn.setAttribute('aria-pressed', document.documentElement.dataset.theme === 'light' ? 'true' : 'false');
    pressed();
    btn.addEventListener('click', () => {
      const light = document.documentElement.dataset.theme === 'light';
      if (light) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = 'light';
      pressed();
      try { localStorage.setItem('hc-theme', light ? 'dark' : 'light'); } catch (e) { /* ok */ }
    });
  }

  function initSearchBox() {
    const input = $('#search-input');
    const toggle = $('#search-toggle');
    /* Below 768 px the header's box is an icon button (uiux F4): the button opens the form
       over the nav row, full width, focused; Esc, a submit, or leaving it empty closes it. */
    const openSearch = (on) => {
      document.body.classList.toggle('hc-search-open', on);
      if (toggle) toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) input.focus();
    };
    if (toggle) {
      toggle.addEventListener('click', () => openSearch(!document.body.classList.contains('hc-search-open')));
    }
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !document.body.classList.contains('hc-search-open')) return;
      openSearch(false);
      if (toggle) toggle.focus();
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim() && document.body.classList.contains('hc-search-open')) openSearch(false);
    });
    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) location.hash = `#/search?q=${encodeURIComponent(input.value.trim())}`;
      openSearch(false);
    });
    // "/" focuses whichever box is on screen: the hero's on #/, where the
    // header's own box is closed, and the header's on every other route.
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input &&
          !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        const hero = $('#hero-search-input');
        if (!hero && drawerMode('(max-width: 767px)')) openSearch(true);   // the phone's box is closed: open it
        else (hero || input).focus();
      }
    });
  }

  /* boot() is split in four (uiux plan 1b) so no function has two owners: bootEntry and bootSession
     belong to the header/sign-in code, bootData and boot to the router. */
  /* WCAG-1: the skip link moves focus into the page itself; its #content hash would otherwise
     reach the router (which now ignores it anyway) and change the address. */
  function initSkipLink() {
    const link = $('.skip-link');
    if (!link || !content) return;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      content.focus({ preventScroll: true });
      content.scrollIntoView({ block: 'start' });
    });
  }

  function bootEntry() {
    initSkipLink();
    initSearchBox();
    initEditorEntry();
    initDrawer();
    setEditLink(null);
  }

  /* The phone drawer (uiux F1). Below 900 px the sidebar is a fixed panel off the left edge;
     #sidebar-toggle ("Contents", shown only when the sidebar has links) slides it in. Open: focus
     moves to the active link (or the first), Tab stays inside, the page behind does not scroll,
     and a backdrop on <body> (never inside #content: plan ground rule 10) dims it. Esc, the
     backdrop, the toggle and any navigation close it; focus returns to the toggle. */
  function drawerMode(query) {
    try { return Boolean(window.matchMedia && window.matchMedia(query || '(max-width: 900px)').matches); } catch (e) { return false; }
  }
  function initDrawer() {
    const toggle = $('#sidebar-toggle');
    if (!toggle || !sidebar || !document.body) return;
    toggle.hidden = false;                   // css/site.css decides where it shows
    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);
    // WCAG-11: the drawer's own visible way out, its first item while it is open
    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('type', 'button');
    closeBtn.className = 'drawer-close';
    closeBtn.textContent = 'Close';
    const isOpen = () => document.body.classList.contains('hc-drawer-open');
    // a closed group's links are not reachable (Chrome keeps their boxes, so ask the details itself)
    const focusables = () => Array.from(sidebar.querySelectorAll('a[href], summary, button'))
      .filter((n) => (n.tagName === 'SUMMARY' || !n.closest('details:not([open])')) && n.getClientRects().length);
    const close = (refocus) => {
      if (!isOpen()) return;
      const inside = sidebar.contains(document.activeElement);
      document.body.classList.remove('hc-drawer-open');
      toggle.setAttribute('aria-expanded', 'false');
      sidebar.removeAttribute('role');
      sidebar.removeAttribute('aria-modal');
      closeBtn.remove();
      if (refocus || inside) toggle.focus({ preventScroll: true });
    };
    const open = () => {
      document.body.classList.add('hc-drawer-open');
      toggle.setAttribute('aria-expanded', 'true');
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
      sidebar.prepend(closeBtn);
      // the active link is brought into view; focus lands on Close, the drawer's first item
      const target = sidebar.querySelector('a.active');
      if (target) target.scrollIntoView({ block: 'center' });
      closeBtn.focus({ preventScroll: true });
    };
    toggle.addEventListener('click', () => (isOpen() ? close(true) : open()));
    closeBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', () => close(true));
    window.addEventListener('hashchange', () => close(false));
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    });
    // back to a wide window: the sidebar is a column again, so the drawer state goes
    try {
      const mq = window.matchMedia('(max-width: 900px)');
      const wide = () => { if (!mq.matches) close(false); };
      if (mq.addEventListener) mq.addEventListener('change', wide); else if (mq.addListener) mq.addListener(wide);
    } catch (e) { /* no matchMedia: nothing to follow */ }
  }

  // the registries into DATA; false (after the error panel) when one could not be read
  async function bootData() {
    try {
      const [site, setup, projects, tools] = await Promise.all([
        fetchJSON('data/site.json'), fetchJSON('data/setup.json'),
        HC.fetchProjects(), fetchJSON('data/tools.json'),   // the project index + each project's facts file
      ]);
      Object.assign(DATA, { site, setup, projects, tools });
      return true;
    } catch (err) {
      errorPanel(err);
      return false;
    }
  }

  function bootSession() {
    editor.session = signedInMarker();      // the one cookie read (guarded); no storage read
    editor.sessionKnown = true;
    syncSignIn();
    // a marker the server turns down (expired, signed out elsewhere) or an editor that does not start: a guest
    // after all, so "Sign in" shows. Nothing is injected before the resume answers, so the first route() paints first.
    if (editor.session) {
      editor.boot = resumeSession()
        .then((resumed) => (resumed ? loadEditor({ resumed }) : false))
        .then((started) => { if (!started) { editor.session = false; syncSignIn(); } return started; });
    }
  }

  async function boot() {
    initTheme();
    bootEntry();
    if (!(await bootData())) return;
    bootSession();
    window.addEventListener('hashchange', route);
    route();
  }

  boot();
}());
