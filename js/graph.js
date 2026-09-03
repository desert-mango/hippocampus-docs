/* HippoCampus Robotics docs — semantic graph UI layer.
   Zero-build, no dependencies. Three features, all additive and all optional:

     1. cross-reference linkifier — rewrites page prose in the DOM (never the
        Markdown sources) so allow-listed terms point at the node that owns them;
     2. a popover that previews the target node instead of navigating away;
     3. a "Primary contributors" block on project pages, where only people who
        already publish a link in data/people.json become clickable — and even then
        only behind a visit-confirm modal.

   Every data file loads independently and every failure degrades to silence: a
   missing data/graph/*.json costs you the feature, never the page. The pure
   helpers at the top are exported for tools/tests/test_graph_ui.mjs. */
(function () {
  'use strict';

  const BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

  // ==================================================================
  //  pure helpers (unit-tested under node; no DOM, no globals)
  // ==================================================================

  // Word chars for the linkifier's boundary test: letters, digits, `_` and `-`.
  // That is what makes `hippo_control` refuse to match inside `hippo_control_msgs`
  // and `hippo-release` refuse to match inside `hippo-release-2`.
  const WORD_RE = (function () {
    try { return new RegExp('[\\p{L}\\p{N}_-]', 'u'); } catch (e) { return /[0-9A-Za-z_-]/; }
  }());
  function isWordChar(ch) {
    return typeof ch === 'string' && ch !== '' && WORD_RE.test(ch);
  }

  // Only http(s) URLs are ever trusted with an href or window.open — mirrors the
  // same guard in js/app.js, which exists because a `javascript:` value survives
  // HTML escaping perfectly well.
  function safeHttpUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    return /^https?:\/\//i.test(url) ? url : null;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // terms: { "<term>": "<node id>" }. Longest-first ordering is this client's job
  // (data/graph/xref-terms.json says so): JS alternation is leftmost-*first*, so the
  // order of the branches is what makes the longest term win at a given position.
  function buildTermMatcher(terms) {
    const byLower = new Map();
    const list = [];
    if (terms && typeof terms === 'object') {
      Object.keys(terms).forEach((key) => {
        const term = String(key);
        const nodeId = terms[key];
        if (!term.trim() || typeof nodeId !== 'string' || !nodeId) return;
        const lower = term.toLowerCase();
        if (byLower.has(lower)) return;
        byLower.set(lower, { term: term, nodeId: nodeId });
        list.push(term);
      });
    }
    list.sort(function (a, b) {
      if (b.length !== a.length) return b.length - a.length;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    let regex = null;
    if (list.length) {
      regex = new RegExp('(?:' + list.map(escapeRegExp).join('|') + ')', 'gi');
    }
    return { terms: list, byLower: byLower, regex: regex };
  }

  // opts: { used: Set<lowercased term>, selfId: string }. `used` is mutated so a
  // caller can share one set across every text node of a root — at most one link
  // per term per root, first occurrence wins.
  function findMatches(text, matcher, opts) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    if (!matcher || !matcher.regex || !matcher.byLower) return out;
    const o = opts || {};
    const used = (typeof Set !== 'undefined' && o.used instanceof Set) ? o.used : new Set();
    const selfId = typeof o.selfId === 'string' && o.selfId ? o.selfId : null;
    const re = matcher.regex;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hit = m[0];
      const start = m.index;
      if (!hit.length) { re.lastIndex = start + 1; continue; }
      const end = start + hit.length;
      const before = start > 0 ? text.charAt(start - 1) : '';
      const after = end < text.length ? text.charAt(end) : '';
      const boundaryOk =
        !(isWordChar(before) && isWordChar(hit.charAt(0))) &&
        !(isWordChar(after) && isWordChar(hit.charAt(hit.length - 1)));
      if (!boundaryOk) { re.lastIndex = start + 1; continue; }
      const lower = hit.toLowerCase();
      const entry = matcher.byLower.get(lower);
      if (!entry) { re.lastIndex = start + 1; continue; }
      re.lastIndex = end;                 // the span is claimed, linked or not
      if (used.has(lower)) continue;
      used.add(lower);
      if (selfId && entry.nodeId === selfId) continue;   // never link a page to itself
      out.push({ start: start, end: end, text: hit, term: entry.term, nodeId: entry.nodeId });
    }
    return out;
  }

  // '#/setup/a/b@anchor' -> 'setup/a/b'. Landing views map to the index nodes the
  // wiki graph uses, and '#/setup' resolves to the start page it actually renders.
  function currentNodeId(hash) {
    let h = typeof hash === 'string' ? hash : '';
    if (h.charAt(0) === '#') h = h.slice(1);
    h = h.split('@')[0].split('?')[0];
    const seg = h.split('/').filter(Boolean);
    if (!seg.length) return 'index:home';
    if (seg[0] === 'setup') {
      return seg.length === 1 ? 'setup/start/index' : 'setup/' + seg.slice(1).join('/');
    }
    if (seg[0] === 'projects') return seg.length === 1 ? 'index:projects' : 'projects/' + seg[1];
    if (seg[0] === 'tools') return seg.length === 1 ? 'index:tools' : 'tools/' + seg[1];
    if (seg[0] === 'about') return 'about';
    return null;
  }

  // Page/index nodes resolve against the document URL so the link survives a
  // subpath deploy (/hippocampus-docs/); repo nodes carry their own GitHub URL.
  function hrefFor(node, baseHref) {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'repo' || (!node.route && node.url)) return safeHttpUrl(node.url);
    if (typeof node.route !== 'string' || !node.route) return null;
    try {
      const abs = new URL(node.route, baseHref || '').href;
      return safeHttpUrl(abs) || node.route;
    } catch (e) {
      return node.route;                  // file:// and friends: the hash still works
    }
  }

  function normName(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function commitLabel(n) {
    const count = Number(n) || 0;
    return count + ' commit' + (count === 1 ? '' : 's');
  }

  function truncatedLabel(n) {
    const count = Number(n);
    if (!isFinite(count) || count <= 0) return null;
    return '+' + Math.round(count) + ' more on GitHub';
  }

  // name -> published link, from data/people.json. Only non-null http(s) links get in.
  function peopleLinkIndex(people) {
    const index = new Map();
    const groups = (people && Array.isArray(people.groups)) ? people.groups : [];
    groups.forEach(function (group) {
      const list = (group && Array.isArray(group.people)) ? group.people : [];
      list.forEach(function (person) {
        if (!person || typeof person.name !== 'string') return;
        const key = normName(person.name);
        const url = safeHttpUrl(person.link);
        if (!key || !url || index.has(key)) return;
        index.set(key, url);
      });
    });
    return index;
  }

  // A contributor becomes clickable only when the build marked them as roster AND
  // data/people.json already publishes a link for that exact name. GitHub profile
  // URLs are deliberately never used.
  function contributorRows(projectEntry, people) {
    const rows = [];
    const list = (projectEntry && Array.isArray(projectEntry.contributors))
      ? projectEntry.contributors : [];
    if (!list.length) return rows;
    const index = peopleLinkIndex(people);
    list.forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const login = typeof row.login === 'string' ? row.login.trim() : '';
      const label = name || login;
      if (!label) return;
      const count = Number(row.contributions) || 0;
      const linkUrl = (row.roster === true && name) ? (index.get(normName(name)) || null) : null;
      rows.push({
        login: login, label: label, count: count,
        countLabel: commitLabel(count), linkUrl: linkUrl,
      });
    });
    return rows;
  }

  // ==================================================================
  //  browser runtime
  // ==================================================================

  const SOURCES = {
    wiki: 'data/graph/wiki.json',
    xref: 'data/graph/xref-terms.json',
    repos: 'data/graph/repos-index.json',
    contributors: 'data/graph/contributors.json',
  };
  const PEOPLE_SRC = 'data/people.json';

  const DATA = { wiki: null, xref: null, repos: null, contributors: null };
  let readyPromise = null;
  let ready = false;
  let nodeIndex = null;      // node id -> node
  let repoIndex = null;      // repo name -> repos-index entry
  let matcher = null;        // built from the terms whose target node exists
  let peoplePromise = null;
  const pendingRoots = [];
  const pendingSeen = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;

  function info(message) {
    try {
      if (typeof console !== 'undefined' && console && console.info) {
        console.info('HCGraph: ' + message);
      }
    } catch (e) { /* console is not worth a crash */ }
  }

  // Every file is optional: a 404, a network error or malformed JSON all resolve
  // to null so one missing file can never take the others (or the page) down.
  function loadJSON(path) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch(path)
      .then(function (r) { return (r && r.ok) ? r.json() : null; })
      .catch(function () { return null; });
  }

  function loadPeople() {
    if (!peoplePromise) peoplePromise = loadJSON(PEOPLE_SRC);
    return peoplePromise;
  }

  function isConnected(el) {
    if (!el) return false;
    if ('isConnected' in el) return !!el.isConnected;
    const doc = el.ownerDocument;
    return !!(doc && doc.body && doc.body.contains && doc.body.contains(el));
  }

  function defer(fn) {
    if (!BROWSER) { fn(); return; }
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 600 });
    } else {
      setTimeout(fn, 0);
    }
  }

  function buildIndexes() {
    nodeIndex = new Map();
    const nodes = (DATA.wiki && Array.isArray(DATA.wiki.nodes)) ? DATA.wiki.nodes : [];
    nodes.forEach(function (n) {
      if (n && typeof n.id === 'string') nodeIndex.set(n.id, n);
    });
    repoIndex = new Map();
    const repos = (DATA.repos && Array.isArray(DATA.repos.repos)) ? DATA.repos.repos : [];
    repos.forEach(function (r) {
      if (r && typeof r.name === 'string') repoIndex.set(r.name, r);
    });
    const terms = (DATA.xref && DATA.xref.terms && typeof DATA.xref.terms === 'object')
      ? DATA.xref.terms : null;
    const usable = {};
    if (terms) {
      Object.keys(terms).forEach(function (t) {
        if (nodeIndex.has(terms[t])) usable[t] = terms[t];   // no link without a target
      });
    }
    matcher = buildTermMatcher(usable);
  }

  function flushPending() {
    const roots = pendingRoots.splice(0, pendingRoots.length);
    roots.forEach(function (root) {
      try {
        if (isConnected(root)) applyTo(root);
      } catch (e) { info('deferred linkify skipped'); }
    });
  }

  // Resolves ALWAYS, with nulls for the parts that failed to load.
  function ensureLoad() {
    if (readyPromise) return readyPromise;
    if (!BROWSER) {
      readyPromise = Promise.resolve({ wiki: null, xref: null, repos: null, contributors: null });
      return readyPromise;
    }
    readyPromise = new Promise(function (resolve) {
      defer(function () {
        Promise.all([
          loadJSON(SOURCES.wiki), loadJSON(SOURCES.xref),
          loadJSON(SOURCES.repos), loadJSON(SOURCES.contributors),
        ]).then(function (parts) {
          DATA.wiki = parts[0];
          DATA.xref = parts[1];
          DATA.repos = parts[2];
          DATA.contributors = parts[3];
          try {
            buildIndexes();
          } catch (e) {
            matcher = null;
            info('graph index unavailable');
          }
          ready = true;
          resolve({
            wiki: DATA.wiki, xref: DATA.xref,
            repos: DATA.repos, contributors: DATA.contributors,
          });
          try { flushPending(); } catch (e) { info('deferred linkify skipped'); }
        });
      });
    });
    return readyPromise;
  }

  function whenReady() { return ensureLoad(); }

  // ---------- linkifier ----------

  const SKIP_TAGS = {
    A: 1, CODE: 1, PRE: 1, H1: 1, H2: 1, H3: 1, H4: 1,
    BUTTON: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1,
  };
  const SKIP_CLASS = ['tabbar', 'heading-anchor', 'xref', 'hc-popover'];

  function inSkippedContext(textNode, root) {
    let el = textNode.parentNode;
    while (el && el.nodeType === 1) {
      if (SKIP_TAGS[el.tagName]) return true;
      const cl = el.classList;
      if (cl && cl.contains) {
        for (let i = 0; i < SKIP_CLASS.length; i += 1) {
          if (cl.contains(SKIP_CLASS[i])) return true;
        }
      }
      if (el === root) break;
      el = el.parentNode;
    }
    return false;
  }

  function mark(root) {
    try {
      if (root.dataset) root.dataset.hcXref = '1';
      else if (root.setAttribute) root.setAttribute('data-hc-xref', '1');
    } catch (e) { /* nothing to do */ }
  }
  function marked(root) {
    if (root.dataset) return root.dataset.hcXref === '1';
    return !!(root.getAttribute && root.getAttribute('data-hc-xref') === '1');
  }

  function linkify(root) {
    if (typeof document.createTreeWalker !== 'function') return;
    const showText = (typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT) || 4;
    const selfId = currentNodeId(location.hash);
    const base = location.href;
    const used = new Set();
    const walker = document.createTreeWalker(root, showText, null, false);
    const texts = [];
    let n = walker.nextNode();
    while (n) {
      const v = n.nodeValue;
      if (v && v.length >= 2 && /\S/.test(v) && !inSkippedContext(n, root)) texts.push(n);
      n = walker.nextNode();
    }
    texts.forEach(function (node) {
      const text = node.nodeValue;
      const hits = findMatches(text, matcher, { used: used, selfId: selfId });
      if (!hits.length) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      hits.forEach(function (hit) {
        const target = nodeIndex ? nodeIndex.get(hit.nodeId) : null;
        if (!target) return;
        const href = hrefFor(target, base);
        if (!href) return;
        if (hit.start > last) frag.appendChild(document.createTextNode(text.slice(last, hit.start)));
        const a = document.createElement('a');
        a.className = 'xref';
        a.setAttribute('data-node', hit.nodeId);
        a.setAttribute('href', href);
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = hit.text;
        frag.appendChild(a);
        last = hit.end;
      });
      if (!last) return;                 // nothing usable here; leave the text alone
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      if (node.parentNode) node.parentNode.replaceChild(frag, node);
    });
  }

  // Idempotent: a root is linkified at most once. Called before the rest of the
  // enhance() pipeline runs, so anchors/tabs/copy buttons are never walked.
  function applyTo(root) {
    if (!BROWSER) return;
    try {
      if (!root || root.nodeType !== 1) return;
      if (marked(root)) return;
      if (!ready) {
        if (!pendingSeen || !pendingSeen.has(root)) {
          if (pendingSeen) pendingSeen.add(root);
          pendingRoots.push(root);
        }
        ensureLoad();
        return;
      }
      mark(root);
      if (!matcher || !matcher.terms.length || !nodeIndex) return;
      linkify(root);
    } catch (err) {
      info('linkify skipped — ' + ((err && err.message) || err));
    }
  }

  // ---------- popover ----------

  const KIND_LABEL = {
    setup: 'Setup page', project: 'Project', tool: 'Agent tool',
    about: 'Page', index: 'Section', repo: 'Repository',
  };

  let popover = null;
  let popoverAnchor = null;

  function closePopover() {
    if (popover && popover.parentNode) popover.parentNode.removeChild(popover);
    popover = null;
    popoverAnchor = null;
  }

  function cleanSummary(text) {
    let s = String(text || '').replace(/\s+/g, ' ').replace(/[`*]/g, '').trim();
    if (s.length > 220) s = s.slice(0, 219).replace(/\s+\S*$/, '') + '…';
    return s;
  }

  function repoNameOf(node) {
    if (!node || node.kind !== 'repo') return null;
    if (typeof node.id === 'string' && node.id.indexOf('repo:') === 0) return node.id.slice(5);
    return typeof node.title === 'string' ? node.title : null;
  }

  function positionPopover() {
    if (!popover || !popoverAnchor || !popoverAnchor.getBoundingClientRect) return;
    const r = popoverAnchor.getBoundingClientRect();
    const w = popover.offsetWidth || 320;
    const h = popover.offsetHeight || 160;
    const vw = window.innerWidth || (document.documentElement || {}).clientWidth || 0;
    const vh = window.innerHeight || (document.documentElement || {}).clientHeight || 0;
    const pad = 8;
    let left = r.left;
    if (left + w + pad > vw) left = vw - w - pad;
    if (left < pad) left = pad;
    let top = r.bottom + 6;
    if (top + h + pad > vh) {
      // Flip above the anchor only when the whole card actually fits there —
      // an anchor scrolled out of view would otherwise push the card off-screen.
      const above = r.top - h - 6;
      top = (above >= pad && above + h + pad <= vh) ? above : (vh - h - pad);
    }
    if (top < pad) top = pad;
    popover.style.left = Math.round(left) + 'px';
    popover.style.top = Math.round(top) + 'px';
  }

  function openXrefPopover(anchorEl, nodeId) {
    if (!BROWSER) return;
    try {
      closePopover();
      const node = nodeIndex ? nodeIndex.get(nodeId) : null;
      if (!node || !anchorEl) return;
      const title = (typeof node.title === 'string' && node.title) ? node.title : String(nodeId);
      const isRepo = node.kind === 'repo';
      const repo = isRepo && repoIndex ? repoIndex.get(repoNameOf(node)) : null;

      const box = document.createElement('div');
      box.className = 'hc-popover';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', title + ' — cross reference');

      const kind = document.createElement('p');
      kind.className = 'hc-pop-kind';
      kind.textContent = isRepo ? 'Repository'
        : ((typeof node.where === 'string' && node.where) || KIND_LABEL[node.kind] || 'Page');
      box.appendChild(kind);

      const heading = document.createElement('p');
      heading.className = 'hc-pop-title';
      heading.textContent = title;
      box.appendChild(heading);

      const summary = cleanSummary((repo && repo.oneliner) || node.summary || '');
      if (summary) {
        const p = document.createElement('p');
        p.className = 'hc-pop-summary';
        p.textContent = summary;
        box.appendChild(p);
      }

      if (repo && Array.isArray(repo.god_nodes) && repo.god_nodes.length) {
        const chips = document.createElement('div');
        chips.className = 'chips hc-pop-chips';
        repo.god_nodes.slice(0, 5).forEach(function (g) {
          if (typeof g !== 'string' || !g.trim()) return;
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = g.trim();
          chips.appendChild(chip);
        });
        if (chips.childNodes.length) box.appendChild(chips);
      }

      const href = hrefFor(node, location.href);
      if (href) {
        const open = document.createElement('a');
        open.className = 'hc-pop-open';
        open.setAttribute('href', href);
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = isRepo ? 'Open on GitHub →' : 'Open page →';
        box.appendChild(open);
      }

      document.body.appendChild(box);
      popover = box;
      popoverAnchor = anchorEl;
      positionPopover();
    } catch (err) {
      info('popover skipped — ' + ((err && err.message) || err));
      closePopover();
    }
  }

  // ---------- visit-confirm modal ----------

  let modal = null;   // { backdrop, trigger }

  function closeModal() {
    if (!modal) return;
    const trigger = modal.trigger;
    if (modal.backdrop && modal.backdrop.parentNode) {
      modal.backdrop.parentNode.removeChild(modal.backdrop);
    }
    modal = null;
    if (trigger && typeof trigger.focus === 'function') {
      try { trigger.focus(); } catch (e) { /* element went away */ }
    }
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch (e) { return url; }
  }

  // Mirrors the portfolio site's visit-confirm: nobody leaves the docs by accident.
  function confirmVisit(name, url) {
    if (!BROWSER) return;
    const safe = safeHttpUrl(url);
    if (!safe) return;
    closeModal();
    closePopover();
    const trigger = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'hc-modal-backdrop';
    const dialog = document.createElement('div');
    dialog.className = 'hc-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'hc-modal-title');

    const heading = document.createElement('h2');
    heading.className = 'hc-modal-title';
    heading.id = 'hc-modal-title';
    heading.textContent = 'Visit ' + String(name || 'this page').trim() + '’s page?';
    dialog.appendChild(heading);

    const dest = document.createElement('p');
    dest.className = 'hc-modal-dest';
    dest.textContent = 'This opens ' + hostOf(safe) + ' in a new tab.';
    dialog.appendChild(dest);

    const actions = document.createElement('div');
    actions.className = 'hc-modal-actions';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'hc-btn';
    back.textContent = 'Back';
    back.addEventListener('click', function () { closeModal(); });
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'hc-btn hc-btn-primary';
    go.textContent = 'Continue';
    go.addEventListener('click', function () {
      try { window.open(safe, '_blank', 'noopener'); } catch (e) { info('popup blocked'); }
      closeModal();
    });
    actions.appendChild(back);
    actions.appendChild(go);
    dialog.appendChild(actions);

    // Keep Tab inside the dialog: two buttons, so cycling is a two-case swap.
    dialog.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' && e.keyCode !== 9) return;
      e.preventDefault();
      const target = (document.activeElement === back) ? go : back;
      try { target.focus(); } catch (err) { /* ignore */ }
    });

    backdrop.appendChild(dialog);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();      // backdrop click = Back
    });
    document.body.appendChild(backdrop);
    modal = { backdrop: backdrop, trigger: trigger };
    try { back.focus(); } catch (e) { /* ignore */ }
  }

  // ---------- contributors ----------

  function buildContributorsBlock(rows, truncated) {
    const wrap = document.createElement('div');
    wrap.className = 'hc-contributors';
    const h = document.createElement('h3');
    h.textContent = 'Primary contributors';
    wrap.appendChild(h);
    const ul = document.createElement('ul');
    rows.forEach(function (row) {
      const li = document.createElement('li');
      li.className = 'contrib-row';
      if (row.linkUrl) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'contrib-link';
        btn.textContent = row.label;
        btn.addEventListener('click', function () { confirmVisit(row.label, row.linkUrl); });
        li.appendChild(btn);
      } else {
        const span = document.createElement('span');
        span.className = 'contrib-name';
        span.textContent = row.label;
        li.appendChild(span);
      }
      const count = document.createElement('span');
      count.className = 'contrib-count';
      count.textContent = row.countLabel;
      li.appendChild(count);
      ul.appendChild(li);
    });
    const more = truncatedLabel(truncated);
    if (more) {
      const li = document.createElement('li');
      li.className = 'contrib-more';
      li.textContent = more;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }

  // Renders nothing at all when the data is missing or empty — no heading, no
  // placeholder. data/people.json is only fetched when a roster row exists.
  function renderContributors(projectId, asideBox) {
    if (!BROWSER) return;
    if (!asideBox || !asideBox.querySelector) return;
    if (typeof projectId !== 'string' || !projectId) return;
    if (asideBox.querySelector('.hc-contributors')) return;
    ensureLoad().then(function (data) {
      const all = (data && data.contributors && data.contributors.projects);
      const entry = (all && typeof all === 'object') ? all[projectId] : null;
      if (!entry || !Array.isArray(entry.contributors) || !entry.contributors.length) return null;
      if (!isConnected(asideBox) || asideBox.querySelector('.hc-contributors')) return null;
      const needPeople = entry.contributors.some(function (r) { return r && r.roster === true; });
      return (needPeople ? loadPeople() : Promise.resolve(null)).then(function (people) {
        if (!isConnected(asideBox) || asideBox.querySelector('.hc-contributors')) return;
        const rows = contributorRows(entry, people);
        if (!rows.length) return;
        asideBox.appendChild(buildContributorsBlock(rows, entry.truncated));
      });
    }).catch(function (err) {
      info('contributors skipped — ' + ((err && err.message) || err));
    });
  }

  // ---------- wiring ----------

  function onDocumentClick(e) {
    try {
      const t = e.target;
      if (!t || typeof t.closest !== 'function') { closePopover(); return; }
      if (t.closest('.hc-modal-backdrop')) return;    // the modal owns its own clicks
      if (t.closest('.hc-popover')) return;
      const a = t.closest('a.xref');
      if (a) {
        e.preventDefault();
        openXrefPopover(a, a.getAttribute('data-node'));
        return;
      }
      closePopover();
    } catch (err) {
      closePopover();
    }
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc' && e.keyCode !== 27) return;
    if (modal) { closeModal(); return; }
    if (popover) closePopover();
  }

  if (BROWSER) {
    document.addEventListener('click', onDocumentClick, false);
    document.addEventListener('keydown', onKeyDown, false);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) closePopover();           // gone when the tab comes back
    }, false);
    window.addEventListener('hashchange', closePopover, false);
    window.addEventListener('resize', positionPopover, false);
    window.addEventListener('scroll', positionPopover, true);
  }

  const API = {
    // features
    applyTo: applyTo,
    renderContributors: renderContributors,
    openXrefPopover: openXrefPopover,
    closePopover: closePopover,
    confirmVisit: confirmVisit,
    whenReady: whenReady,
    // pure helpers (exported for tools/tests/test_graph_ui.mjs)
    buildTermMatcher: buildTermMatcher,
    findMatches: findMatches,
    currentNodeId: currentNodeId,
    hrefFor: hrefFor,
    contributorRows: contributorRows,
    commitLabel: commitLabel,
    truncatedLabel: truncatedLabel,
    safeHttpUrl: safeHttpUrl,
  };

  if (typeof window !== 'undefined') window.HCGraph = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
