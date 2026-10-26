// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Fetch site content same-origin, or through the CMS preview bridge inside a preview frame.
/* HC — the content-source seam. js/app.js, js/search.js and js/graph.js read
   every content/, data/ and search/ file through it instead of calling fetch:

     HC.fetchText(path)          -> Promise<string>
     HC.fetchJSON(path)          -> Promise<value>
     HC.callFunction(url, init)  -> Promise<Response-like>   (api/* POSTs)
     HC.preview                  -> true only inside a CMS preview frame
     HC.post(type, data)         -> boolean  (Editor mode, frame -> parent; 9)
     HC.onEditor(fn)             -> boolean  (Editor mode, parent -> frame; 9)
     HC.blockPrefix              -> this load's sentinel prefix, or null (9)

   A failed read rejects with an Error whose message is "<path>: HTTP <status>"
   and whose .status is that status. On the live site all three are plain
   same-origin fetch. Inside a preview frame they are the preview bridge
   below. This file must load before js/app.js (index.html orders the tags),
   because it reads and rewrites the URL fragment before the router looks.

   ====================================================================
   THE PREVIEW PROTOCOL — the parent side (js/editor.js; first U7a) is written
   against this comment; tools/tests/test_preview_bridge.mjs pins it.
   ====================================================================

   1. The frame. The CMS page embeds the real site:
        <iframe sandbox="allow-scripts allow-popups"
                src="index.html#preview=<nonce>&route=<route>">
      never with allow-same-origin, so the frame's origin is opaque and it
      can reach no cookie, storage or token of the CMS. Build the fragment
      with previewFragment(nonce, route) (exported below):
        nonce  fresh per load, 16-128 characters of [A-Za-z0-9_-]
               (e.g. 32 hex characters from crypto.getRandomValues);
        route  the site route to open WITHOUT its leading '#', exactly as it
               would appear in the site's own hash: '/setup/lab-marker/design',
               '/projects/uvms', '/team', '/search?q=controller',
               '/setup/x@some-heading'. It rides URI-encoded in `route=`;
               omitted means '/'. Anything that does not start with a single
               '/' (or holds a control character) is replaced by '/'.
      The nonce travels in the fragment, never in window.name (which would
      survive a navigation of the frame).

   2. Load. This file reads the fragment ONCE, at load, before js/app.js
      runs: it keeps the nonce in memory and rewrites the fragment to
      '#' + route (history.replaceState; location.replace when that is
      refused), so the router only ever sees '#/…' routes. Links inside the
      frame then navigate '#/…' routes as usual, and keep the same nonce.
      The frame is in preview mode only when the nonce is well formed, the
      page really is framed (window.parent !== window) and its URL origin
      is http(s); a '#preview=' fragment on a top-level page is stripped
      and ignored.

   3. Re-load. A fragment carrying 'preview=' is never read again. To show
      another route or a changed draft, the parent loads the frame again
      with a FRESH nonce — set iframe.src to a new previewFragment URL, or
      replace the iframe element. Because a src that differs only in its
      fragment is a same-document navigation, the frame turns any later
      '#preview=' fragment into location.reload(), so the new nonce is read
      by a fresh load (and the router never sees that fragment).

   4. Request, frame -> parent:
        window.parent.postMessage({type: 'hc-fetch', nonce, id, path},
                                  location.origin)
      id is a positive integer, unique within this load. path is always
      one of the allowlist in 5; the frame refuses anything else itself
      (403, nothing is posted). The targetOrigin is the site's own origin
      (location.origin is the URL's origin even in an opaque-origin
      document), so a page on any other origin that frames the site never
      receives a request.

   5. Answer, parent -> frame:
        iframe.contentWindow.postMessage(
          {type: 'hc-file', nonce, id, ok, status, text}, '*')
      '*' because the frame's origin is opaque ("null") and no other
      targetOrigin matches it. Echo the request's nonce and id. ok is true
      for a 2xx status; text is the file body as a string ('' when !ok).
      The parent answers only when event.source === iframe.contentWindow,
      the nonce is the one it generated for the current load, and path
      matches BRIDGE_PATH_RE with no '.', '..' or empty segment — the same
      test as isBridgePath() below; everything else is answered
      {ok: false, status: 403}. It reads the file at the previewed ref (or
      from the in-memory draft) through the GitHub Contents API; the token
      never enters the frame, and no message carries it.
      The frame accepts an answer only when event.source === window.parent,
      event.origin === its own location.origin, type is 'hc-file', the
      nonce is its own and the id is still pending. Everything else is
      ignored — which is also what keeps a late answer from the PREVIOUS
      load (same ids, other nonce) out of the new one.

   6. Errors. !ok rejects the caller with that status (404 stays 404, 403
      stays 403). An ok answer without a string body is a 502. A request
      the parent never answers rejects with 504 after BRIDGE_TIMEOUT_MS.

   7. Functions. There are no serverless functions in a preview:
      HC.callFunction answers 405 locally and posts nothing, so the search
      librarian latches off exactly as it does on GitHub Pages.

   8. Chrome. js/app.js hides the footer's "Edit this page" link when
      HC.preview is true.

   9. Editor mode (plan D-D; the parent side is js/editor.js, the frame side
      js/editor-frame.js). Four more messages, frame -> parent, each sent
      with HC.post(type, data) as
        window.parent.postMessage({type, nonce, ...fields}, location.origin)
      and only in preview mode:
        hc-ready         {}                  the frame has loaded
        hc-route         {route}             the reader followed a link in
                                             the frame (route as in 1)
        hc-block-select  {index}             a block was picked
        hc-block-insert  {index, kind}       "+" at the boundary before
                                             block `index`; kind is one of
                                             BLOCK_INSERT_KINDS
        hc-block-move    {index, to}         an image block was dragged (or moved
                                             with Alt+arrow) to the boundary
                                             before block `to` (V2, 2026-10-14);
                                             the parent moves it in MY draft
                                             only, and only an image block
        hc-block-state   {index, editor,     the open block is typed in the
                          reason}            page ('visual' | 'code' |
                                             'box'), is edited in the
                                             in-place Markdown box ('mdbox'),
                                             needs the tray's Markdown box
                                             ('markdown'), or was closed
                                             ('closed'); reason is
                                             plain text, at most 300 characters
        hc-block-md      {index, md}         the open block's Markdown after
                                             typing (the editor redesign, U2):
                                             a string of at most
                                             MAX_BLOCK_MD characters, never HTML.
                                             The parent accepts it ONLY for the
                                             one block it marked open, in
                                             author mode, and shows the changed
                                             text itself before any write.
        hc-history       {index, snap}       the frame took restore point `snap` of block
                                             `index` before the edit that follows (R2b)
        hc-key           {op}                'undo' | 'redo': the keys, pressed in the frame;
                                             'redraw': a restore point was missing
        hc-people        {op: 'order', team,  the Team page's lists as shown after a drag
                          alumni} |           or a card-menu move or pin: [{name, pinned}]
                         {op: 'add', group}  (names only, at most 500), or "+" on the
                                             'team' / 'alumni' list (round 2, R5)
        hc-block-rects   {rects, view}       where the MARKED blocks are on screen
                                             (U5b, the review rail): rects =
                                             [{index, top, height}] in the
                                             frame's viewport, view = its height;
                                             numbers only. The parent only lines
                                             its own cards up with them; a card's
                                             text and buttons come from the
                                             parent's data, never from this.
      index is a whole number 0..100000. HC.post builds the message itself
      (frameMessage below): an unknown type or a bad field posts nothing.
      The parent acts on one only when event.source is ITS frame's window
      and the nonce is the one of the current load (as in 5).
      One message parent -> frame:
        iframe.contentWindow.postMessage(
          {type: 'hc-editor', nonce, on, settings, theme, selected, overlay, open, hot, tint, people, locked}, '*')
        on        true: draw the block marks (false: draw none)
        locked    true: a project page the person may not edit (the edit gate, 2026-10-21): no "+" rails and no
                  pick affordance; the parent refuses a pick or an insert anyway
        settings  {suggestions, diff: 'inline'|'side', compact, outlines}
        theme     'light' | 'dark' | absent: the site's theme now (the frame sets
                  data-theme on its <html>; the first load gets it in the
                  fragment as &theme=light)
        selected  a block index, or null
        overlay   [{index, mark: 'add'|'del'|'change'|'conflict'}]
        hot       a block index to light (its review card is hovered or active), or null (U5b)
        tint      the drawn proposal's proposer colour slot, a whole number 0..5 (0: the viewer's own,
                  blue; else 0) — round 2, R1
        people    {edit, marks, focus}: on the Team page (round 2, R5), edit = the card tools are on; marks =
                  [{name, mark: add|del|move|pin|unpin|edit, group, title}] for the people a draft or a
                  proposal changes (names at most 200 characters, at most 500 marks); focus = the
                  person to scroll back to after a reload (a name, or null)
        cmd       {n, op: 'restore', index, snap, save} | null (round 2, R2b): put block `index` back to restore
                  point `snap`, keeping what it shows now as `save`; acted on once per n
        open      {index, md, kind, as} | null: the block to type in, its Markdown
                  (a string of at most MAX_BLOCK_MD characters), its
                  HCCore.splitBlocks kind (OPEN_KINDS), and as: 'markdown' when
                  the person chose the in-place Markdown box (else null); the
                  frame renders the Markdown itself, so no HTML crosses
      The frame accepts it only when event.source === window.parent,
      event.origin === its own location.origin and the nonce is its own
      (as in 5), and cleans it field by field (editorMessage below); a
      listener registered with HC.onEditor(fn) gets the cleaned copy (and,
      when it registers late, the last one at once). No message in either
      direction carries HTML, a token or a storage value.
      Block marks. The parent serves the page's Markdown with an id-sentinel
      <div id="hcb-<prefix>-<i>"></div> before block i, where <prefix> is
      sentinelPrefix(nonce): the first 16 characters of THIS load's nonce,
      exposed to the frame as HC.blockPrefix. Content cannot guess it, so a
      content file cannot fake a mark. */
(function () {
  'use strict';

  const PREVIEW_PREFIX = '#preview=';
  const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const BRIDGE_PATH_RE = /^(content\/[A-Za-z0-9_./-]+\.md|data\/[A-Za-z0-9_./-]+\.json|search\/[A-Za-z0-9_.-]+\.json)$/;
  const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
  const BRIDGE_TIMEOUT_MS = 20000;
  const MAX_BLOCK_INDEX = 100000;
  const BLOCK_INSERT_KINDS = Object.freeze(['note', 'warning', 'tabs', 'image', 'attention', 'video', 'repo']);
  const OVERLAY_MARKS = Object.freeze(['add', 'del', 'change', 'conflict']);
  const MAX_OVERLAY = 5000;
  const MAX_TINT = 5;
  // round 2 (R5): the Team page's people tools
  const MAX_PEOPLE = 500;
  const PEOPLE_MARKS = Object.freeze(['add', 'del', 'move', 'pin', 'unpin', 'edit']);
  const PEOPLE_LISTS = Object.freeze(['team', 'alumni']);
  // round 2 (R2b): undo restore points — the frame's DOM snapshot ids ('f<load>-<n>') and the parent's ('u<n>')
  const SNAP_RE = /^[a-z][a-z0-9-]{0,39}$/;
  const personName = (v) => (typeof v === 'string' && v.trim() && v.length <= 200 ? v : null);              // css/editor.css --hc-p1..--hc-p5 (HCCore.PROPOSER_SLOTS)
  const MAX_PX = 1e7;                // a block rectangle's coordinates (hc-block-rects), in CSS pixels
  const DIFF_STYLES = Object.freeze(['inline', 'side']);
  const BLOCK_EDITORS = Object.freeze(['visual', 'code', 'box', 'mdbox', 'markdown', 'closed']);
  const OPEN_KINDS = Object.freeze(['paragraph', 'heading', 'list', 'code', 'wrapper', 'image', 'table', 'html']);
  const MAX_BLOCK_MD = 200000;
  // U4 (D6, D8, D11): the marks, notes and site images that cross the bridge
  const MAX_MARKS_HTML = 200000;
  const NOTE_MAX = 2000;
  const MAX_NOTES = 500;
  const MAX_MEDIA = 500;
  const isImageUrl = (u) => typeof u === 'string' && u.length <= 2000 && /^https:\/\/res\.cloudinary\.com\/[^\s"'<>\\]+$/.test(u);

  function httpError(path, status, detail) {
    const err = new Error(`${path}: HTTP ${status}` + (detail ? ` (${detail})` : ''));
    err.status = status;
    return err;
  }

  /* The index merged with each project's facts (factsList[i] for entry i): an entry keeps the index's id, add
     and remove first (a facts file cannot change them, nor the old `owners`), then the facts. js/cms-core.js
     mergeProjects is the same. */
  const INDEX_KEYS = ['id', 'add', 'remove'];
  const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
  function mergeProjects(index, factsList) {
    if (!index || typeof index !== 'object' || !Array.isArray(index.projects)) return index;
    const facts = Array.isArray(factsList) ? factsList : [];
    return Object.assign({}, index, { projects: index.projects.map((e, i) => {
      if (!e || typeof e !== 'object') return e;
      const f = facts[i] && typeof facts[i] === 'object' && !Array.isArray(facts[i]) ? facts[i] : {};
      const out = {};
      INDEX_KEYS.forEach((k) => { if (k in e) out[k] = e[k]; });
      Object.keys(f).forEach((k) => { if (INDEX_KEYS.indexOf(k) < 0 && k !== 'owners') out[k] = f[k]; });
      return Object.assign(out, e);
    }) });
  }

  function isBridgePath(path) {
    if (typeof path !== 'string' || !BRIDGE_PATH_RE.test(path)) return false;
    return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  }

  function safeRoute(route) {
    return (typeof route === 'string' && /^\/(?!\/)/.test(route) && !CONTROL_CHARS.test(route))
      ? route : '/';
  }

  /* theme: 'light' adds &theme=light (the sandboxed frame cannot read the site's stored theme; dark is the
     site's default, so it adds nothing). */
  function previewFragment(nonce, route, theme) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new Error('previewFragment: the nonce must be 16-128 characters of [A-Za-z0-9_-]');
    }
    const r = safeRoute(route === undefined ? '/' : route);
    return PREVIEW_PREFIX + nonce + (r === '/' ? '' : '&route=' + encodeURIComponent(r))
      + (theme === 'light' ? '&theme=light' : '');
  }

  // null when the fragment is not a preview fragment at all; otherwise
  // {nonce, route}, where a malformed nonce is null (and the fragment must
  // still be stripped, so the router never sees it).
  function parsePreviewFragment(hash) {
    if (typeof hash !== 'string' || hash.indexOf(PREVIEW_PREFIX) !== 0) return null;
    let params;
    try { params = new URLSearchParams(hash.slice(1)); } catch (e) { return { nonce: null, route: '/' }; }
    const nonce = params.get('preview');
    const out = {
      nonce: (nonce && NONCE_RE.test(nonce)) ? nonce : null,
      route: safeRoute(params.get('route')),
    };
    if (params.get('theme') === 'light') out.theme = 'light';
    return out;
  }

  function rewriteFragment(win, hash) {
    try {
      win.history.replaceState(null, '', hash);
    } catch (e) {
      try { win.location.replace(hash); } catch (e2) { /* the router will report it */ }
    }
  }

  // The first 16 characters of a load's nonce: the id-sentinels' prefix (9).
  function sentinelPrefix(nonce) {
    return (typeof nonce === 'string' && NONCE_RE.test(nonce)) ? nonce.slice(0, 16) : null;
  }

  const isIndex = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_BLOCK_INDEX;

  /* A frame -> parent editor message (9), built from checked fields only:
     -> {type, ...fields} | null. The nonce is added by HC.post. */
  function frameMessage(type, data) {
    const d = (data && typeof data === 'object') ? data : {};
    if (type === 'hc-ready') return { type };
    if (type === 'hc-route') {
      if (typeof d.route !== 'string') return null;
      return { type, route: safeRoute(d.route) };
    }
    if (type === 'hc-block-select') return isIndex(d.index) ? { type, index: d.index } : null;
    if (type === 'hc-block-insert') {
      return (isIndex(d.index) && BLOCK_INSERT_KINDS.indexOf(d.kind) >= 0)
        ? { type, index: d.index, kind: d.kind } : null;
    }
    if (type === 'hc-block-move') {
      return (isIndex(d.index) && isIndex(d.to) && d.to !== d.index) ? { type, index: d.index, to: d.to } : null;
    }
    if (type === 'hc-block-state') {
      if (!isIndex(d.index) || BLOCK_EDITORS.indexOf(d.editor) < 0) return null;
      return { type, index: d.index, editor: d.editor, reason: typeof d.reason === 'string' ? d.reason.slice(0, 300) : '' };
    }
    if (type === 'hc-block-md') {
      return (isIndex(d.index) && typeof d.md === 'string' && d.md.length <= MAX_BLOCK_MD)
        ? { type, index: d.index, md: d.md } : null;
    }
    if (type === 'hc-history') {
      // round 2 (R2b): the frame took a restore point of block `index` (as it was before the edit that follows)
      return isIndex(d.index) && typeof d.snap === 'string' && SNAP_RE.test(d.snap) ? { type, index: d.index, snap: d.snap } : null;
    }
    // Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z; 'redraw': a restore point is gone, the parent draws the page from its text
    if (type === 'hc-key') return d.op === 'undo' || d.op === 'redo' || d.op === 'redraw' ? { type, op: d.op } : null;
    if (type === 'hc-people') {
      // round 2 (R5): the Team page in Editor mode — the lists as shown after a drag or a card-menu move or pin
      // (names and pins only; the parent checks the names are exactly the draft's), or "+" on a list
      if (d.op === 'add') return PEOPLE_LISTS.indexOf(d.group) >= 0 ? { type, op: 'add', group: d.group } : null;
      if (d.op !== 'order' || !Array.isArray(d.team) || !Array.isArray(d.alumni)
        || d.team.length + d.alumni.length > MAX_PEOPLE) return null;
      const clean = (list) => {
        const out = [];
        for (const x of list) {
          const name = x && typeof x === 'object' ? personName(x.name) : null;
          if (!name) return null;
          out.push({ name, pinned: x.pinned === true });
        }
        return out;
      };
      const team = clean(d.team);
      const alumni = clean(d.alumni);
      // focus: the person just moved (the page comes back to them after it reloads), or null
      return team && alumni ? { type, op: 'order', team, alumni, focus: personName(d.focus) } : null;
    }
    if (type === 'hc-block-rects') {
      // U5b: where the MARKED blocks are on screen (the parent's review rail lines its cards up with
      // them). Numbers only, rounded; one bad entry drops the whole message.
      const num = (v, lo) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= MAX_PX;
      if (!Array.isArray(d.rects) || d.rects.length > MAX_OVERLAY || !num(d.view, 0)) return null;
      const rects = [];
      for (const r of d.rects) {
        if (!r || typeof r !== 'object' || !isIndex(r.index) || !num(r.top, -MAX_PX) || !num(r.height, 0)) return null;
        rects.push({ index: r.index, top: Math.round(r.top), height: Math.round(r.height) });
      }
      return { type, rects, view: Math.round(d.view) };
    }
    /* Per-unit blocks (editor UI/UX build, U0): a new frame -> parent message kind goes in its unit's block. */
    /* ---- U4 ---- */
    // D6: the open block's marked HTML after an edit ('' = no marks left); the parent keeps it, the frame
    // sanitises it (js/sanitize.js, marks mode) and checks it both ways before it paints it again
    if (type === 'hc-marks') {
      return isIndex(d.index) && typeof d.html === 'string' && d.html.length <= MAX_MARKS_HTML ? { type, index: d.index, html: d.html } : null;
    }
    // D8: Comment — the note on block `index` ('' removes it); plain text, capped
    if (type === 'hc-note') {
      return isIndex(d.index) && typeof d.text === 'string' && d.text.length <= NOTE_MAX ? { type, index: d.index, text: d.text } : null;
    }
    // D11: the "+" Image tile asks for the site's images; then puts one in at the "+" `index`
    if (type === 'hc-media-list') return { type };
    if (type === 'hc-image-use') return isIndex(d.index) && isImageUrl(d.url) ? { type, index: d.index, url: d.url } : null;

    /* ---- U5 ---- */

    /* ---- U6 ---- */
    return null;
  }

  /* The parent's hc-editor message (9), cleaned field by field: wrong types
     fall back to off / the defaults / nothing. -> {on, settings, selected,
     overlay} | null (not an hc-editor message at all). */
  function editorMessage(m) {
    if (!m || typeof m !== 'object' || m.type !== 'hc-editor') return null;
    const s = (m.settings && typeof m.settings === 'object') ? m.settings : {};
    const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
    const overlay = [];
    if (Array.isArray(m.overlay)) {
      for (const e of m.overlay.slice(0, MAX_OVERLAY)) {
        if (e && typeof e === 'object' && isIndex(e.index) && OVERLAY_MARKS.indexOf(e.mark) >= 0) {
          overlay.push({ index: e.index, mark: e.mark });
        }
      }
    }
    return {
      on: m.on === true,
      settings: {
        suggestions: bool(s.suggestions, true),
        diff: DIFF_STYLES.indexOf(s.diff) >= 0 ? s.diff : 'inline',
        compact: bool(s.compact, false),
        outlines: bool(s.outlines, true),
      },
      selected: isIndex(m.selected) ? m.selected : null,
      overlay,
      theme: m.theme === 'light' || m.theme === 'dark' ? m.theme : null,
      open: (m.open && typeof m.open === 'object' && isIndex(m.open.index) && typeof m.open.md === 'string'
        && m.open.md.length <= MAX_BLOCK_MD && OPEN_KINDS.indexOf(m.open.kind) >= 0)
        ? { index: m.open.index, md: m.open.md, kind: m.open.kind, as: m.open.as === 'markdown' ? 'markdown' : null } : null,
      hot: isIndex(m.hot) ? m.hot : null,          // U5b: the block whose review card is hovered or active
      locked: m.locked === true,                   // the edit gate: a project page this person may not edit
      // round 2 (R1): the drawn proposal's proposer colour slot, 0 = the viewer's own (blue)
      tint: Number.isInteger(m.tint) && m.tint >= 0 && m.tint <= MAX_TINT ? m.tint : 0,
      // round 2 (R5): on the Team page — the card tools on/off, and each changed person's mark
      people: (() => {
        const p = m.people && typeof m.people === 'object' ? m.people : {};
        const marks = [];
        for (const x of Array.isArray(p.marks) ? p.marks.slice(0, MAX_PEOPLE) : []) {
          const name = x && typeof x === 'object' ? personName(x.name) : null;
          if (!name || PEOPLE_MARKS.indexOf(x.mark) < 0) continue;
          marks.push({ name, mark: x.mark, group: PEOPLE_LISTS.concat(['active']).indexOf(x.group) >= 0 ? x.group : null,
            title: typeof x.title === 'string' ? x.title.slice(0, 300) : '' });
        }
        return { edit: p.edit === true, marks, focus: personName(p.focus) };
      })(),
      // round 2 (R2b): put block `index` back to restore point `snap`, first keeping what it shows now as `save`
      cmd: (() => {
        const c = m.cmd && typeof m.cmd === 'object' ? m.cmd : null;
        if (!c || !Number.isInteger(c.n) || c.n < 1 || c.op !== 'restore' || !isIndex(c.index)) return null;
        if (typeof c.snap !== 'string' || !SNAP_RE.test(c.snap) || typeof c.save !== 'string' || !SNAP_RE.test(c.save)) return null;
        return { n: c.n, op: 'restore', index: c.index, snap: c.snap, save: c.save };
      })(),
      /* Per-unit blocks (editor UI/UX build, U0): a new hc-editor field goes in its unit's block. */
      /* ---- U3 ---- */
      // the block to scroll into view, once per n (the first change of a proposal opened from its review row)
      focus: (() => {
        const f = m.focus && typeof m.focus === 'object' ? m.focus : null;
        return f && Number.isInteger(f.n) && f.n >= 1 && isIndex(f.index) ? { n: f.n, index: f.index } : null;
      })(),
      // the blocks a margin note card sits beside: reported in hc-block-rects like the marked ones
      anchors: Array.isArray(m.anchors) ? m.anchors.filter(isIndex).slice(0, 500) : [],    // at most 500 note cards on one page
      /* ---- U4 ---- */
      // D6: the blocks my draft changed after a load: kept marked HTML ('' = none), the draft's text, the base's
      // text ('' for an added block) and the block kind; one bad entry is dropped, never guessed. D8: my notes
      // beside their blocks (plain text). D11: the site's images for "Pick one the site has" (Cloudinary only).
      // Each field is there only when the parent sent it.
      ...(Array.isArray(m.marks) ? { marks: m.marks.slice(0, MAX_OVERLAY).filter((x) => x && typeof x === 'object' && isIndex(x.index)
        && typeof x.html === 'string' && x.html.length <= MAX_MARKS_HTML && typeof x.md === 'string' && x.md.length <= MAX_BLOCK_MD
        && typeof x.orig === 'string' && x.orig.length <= MAX_BLOCK_MD && OPEN_KINDS.indexOf(x.kind) >= 0)
        .map((x) => ({ index: x.index, html: x.html, md: x.md, orig: x.orig, kind: x.kind })) } : {}),
      ...(Array.isArray(m.notes) ? { notes: m.notes.slice(0, MAX_NOTES).filter((x) => x && typeof x === 'object' && isIndex(x.index)
        && typeof x.text === 'string' && x.text.length <= NOTE_MAX).map((x) => ({ index: x.index, text: x.text })) } : {}),
      ...(Array.isArray(m.media) ? { media: m.media.slice(0, MAX_MEDIA).filter((x) => x && typeof x === 'object' && isImageUrl(x.url))
        .map((x) => ({ url: x.url, label: typeof x.label === 'string' ? x.label.slice(0, 300) : '' })) } : {}),

      /* ---- U5 ---- */

      /* ---- U6 ---- */
    };
  }

  const fakeResponse = (status) => ({
    ok: false, status,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve(''),
  });

  function create(win, opts) {
    const o = opts || {};
    const fetchImpl = o.fetch || ((url, init) => fetch(url, init));
    const timeoutMs = o.timeoutMs || BRIDGE_TIMEOUT_MS;
    const origin = String((win.location && win.location.origin) || '');
    const framed = Boolean(win.parent) && win.parent !== win;
    const parsed = parsePreviewFragment(win.location.hash);
    const nonce = (parsed && parsed.nonce && framed && /^https?:\/\/[^/]+$/.test(origin))
      ? parsed.nonce : null;
    if (parsed) rewriteFragment(win, '#' + parsed.route);
    // the parent's theme, before the site draws (js/app.js only ever sets light from storage, which a
    // sandboxed frame cannot read)
    if (nonce && parsed.theme === 'light' && win.document && win.document.documentElement) {
      win.document.documentElement.dataset.theme = 'light';
    }

    // (3) a later preview fragment is a new load, never a route and never a nonce.
    win.addEventListener('hashchange', (event) => {
      if (String(win.location.hash).indexOf(PREVIEW_PREFIX) !== 0) return;
      if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      win.location.reload();
    });

    function liveText(path) {
      return Promise.resolve(fetchImpl(path)).then((r) => {
        if (!r || !r.ok) throw httpError(path, r ? r.status : 0);
        return r.text();
      });
    }

    const pending = new Map();
    let nextId = 1;

    function bridgeText(path) {
      if (!isBridgePath(path)) return Promise.reject(httpError(path, 403));
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(httpError(path, 504, 'the preview bridge did not answer'));
        }, timeoutMs);
        pending.set(id, { path, resolve, reject, timer });
        try {
          win.parent.postMessage({ type: 'hc-fetch', nonce, id, path }, origin);
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(httpError(path, 502, 'the preview bridge is unreachable'));
        }
      });
    }

    // (9) the editor's messages
    const editorListeners = [];
    let lastEditor = null;

    function post(type, data) {
      if (!nonce) return false;
      const msg = frameMessage(type, data);
      if (!msg) return false;
      msg.nonce = nonce;
      try {
        win.parent.postMessage(msg, origin);
      } catch (e) {
        return false;
      }
      return true;
    }

    function onEditor(fn) {
      if (!nonce || typeof fn !== 'function') return false;
      editorListeners.push(fn);
      if (lastEditor) fn(lastEditor);
      return true;
    }

    function onEditorMessage(d) {
      const clean = editorMessage(d);
      if (!clean) return;
      lastEditor = clean;
      for (const fn of editorListeners.slice()) {
        try { fn(clean); } catch (e) { /* one listener must not silence the rest */ }
      }
    }

    function onMessage(event) {
      if (!event || event.source !== win.parent || event.origin !== origin) return;
      const d = event.data;
      if (d && typeof d === 'object' && d.type === 'hc-editor' && d.nonce === nonce) {
        onEditorMessage(d);
        return;
      }
      if (!d || typeof d !== 'object' || d.type !== 'hc-file' || d.nonce !== nonce) return;
      if (typeof d.id !== 'number' || !pending.has(d.id)) return;
      const req = pending.get(d.id);
      pending.delete(d.id);
      clearTimeout(req.timer);
      if (d.ok === true) {
        if (typeof d.text === 'string') req.resolve(d.text);
        else req.reject(httpError(req.path, 502, 'the preview answer had no text'));
      } else {
        const status = (Number.isInteger(d.status) && d.status > 0) ? d.status : 502;
        req.reject(httpError(req.path, status));
      }
    }
    if (nonce) win.addEventListener('message', onMessage);

    const fetchText = nonce ? bridgeText : liveText;

    function fetchJSON(path) {
      return fetchText(path).then((text) => {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error(`${path}: invalid JSON (${e.message})`);
        }
      });
    }

    function callFunction(url, init) {
      return nonce ? Promise.resolve(fakeResponse(405)) : Promise.resolve(fetchImpl(url, init));
    }

    /* The project registry (2026-10-14): data/projects.json lists {id, add, remove} in order; each project's facts
       are in data/projects/<id>.json. -> the merged document every page reads (mergeProjects). */
    function fetchProjects() {
      return fetchJSON('data/projects.json').then((index) => {
        const rows = index && typeof index === 'object' && Array.isArray(index.projects) ? index.projects : [];
        return Promise.all(rows.map((e) => (e && typeof e.id === 'string' && PROJECT_ID_RE.test(e.id)
          ? fetchJSON(`data/projects/${e.id}.json`).catch(() => null) : Promise.resolve(null))))
          .then((facts) => mergeProjects(index, facts));
      });
    }

    return Object.freeze({
      preview: Boolean(nonce), fetchText, fetchJSON, fetchProjects, callFunction,
      blockPrefix: sentinelPrefix(nonce), post, onEditor,
    });
  }

  if (typeof window !== 'undefined') window.HC = create(window);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      create, previewFragment, parsePreviewFragment, isBridgePath, mergeProjects,
      BRIDGE_PATH_RE, BRIDGE_TIMEOUT_MS,
      sentinelPrefix, frameMessage, editorMessage, BLOCK_INSERT_KINDS, OVERLAY_MARKS, BLOCK_EDITORS, OPEN_KINDS, MAX_BLOCK_MD,
    };
  }
}());
