// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Fetch site content same-origin, or through the CMS preview bridge inside a preview frame.
/* HC — the content-source seam. js/app.js, js/search.js and js/graph.js read
   every content/, data/ and search/ file through it instead of calling fetch:

     HC.fetchText(path)          -> Promise<string>
     HC.fetchJSON(path)          -> Promise<value>
     HC.callFunction(url, init)  -> Promise<Response-like>   (api/* POSTs)
     HC.preview                  -> true only inside a CMS preview frame

   A failed read rejects with an Error whose message is "<path>: HTTP <status>"
   and whose .status is that status. On the live site all three are plain
   same-origin fetch. Inside a preview frame they are the preview bridge
   below. This file must load before js/app.js (index.html orders the tags),
   because it reads and rewrites the URL fragment before the router looks.

   ====================================================================
   THE PREVIEW PROTOCOL — the parent side (js/cms.js, unit U7a) is written
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
               '/projects/uvms', '/about', '/search?q=controller',
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
      HC.preview is true. */
(function () {
  'use strict';

  const PREVIEW_PREFIX = '#preview=';
  const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const BRIDGE_PATH_RE = /^(content\/[A-Za-z0-9_./-]+\.md|data\/[A-Za-z0-9_./-]+\.json|search\/[A-Za-z0-9_.-]+\.json)$/;
  const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
  const BRIDGE_TIMEOUT_MS = 20000;

  function httpError(path, status, detail) {
    const err = new Error(`${path}: HTTP ${status}` + (detail ? ` (${detail})` : ''));
    err.status = status;
    return err;
  }

  function isBridgePath(path) {
    if (typeof path !== 'string' || !BRIDGE_PATH_RE.test(path)) return false;
    return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  }

  function safeRoute(route) {
    return (typeof route === 'string' && /^\/(?!\/)/.test(route) && !CONTROL_CHARS.test(route))
      ? route : '/';
  }

  function previewFragment(nonce, route) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new Error('previewFragment: the nonce must be 16-128 characters of [A-Za-z0-9_-]');
    }
    const r = safeRoute(route === undefined ? '/' : route);
    return PREVIEW_PREFIX + nonce + (r === '/' ? '' : '&route=' + encodeURIComponent(r));
  }

  // null when the fragment is not a preview fragment at all; otherwise
  // {nonce, route}, where a malformed nonce is null (and the fragment must
  // still be stripped, so the router never sees it).
  function parsePreviewFragment(hash) {
    if (typeof hash !== 'string' || hash.indexOf(PREVIEW_PREFIX) !== 0) return null;
    let params;
    try { params = new URLSearchParams(hash.slice(1)); } catch (e) { return { nonce: null, route: '/' }; }
    const nonce = params.get('preview');
    return {
      nonce: (nonce && NONCE_RE.test(nonce)) ? nonce : null,
      route: safeRoute(params.get('route')),
    };
  }

  function rewriteFragment(win, hash) {
    try {
      win.history.replaceState(null, '', hash);
    } catch (e) {
      try { win.location.replace(hash); } catch (e2) { /* the router will report it */ }
    }
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

    function onMessage(event) {
      if (!event || event.source !== win.parent || event.origin !== origin) return;
      const d = event.data;
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

    return Object.freeze({ preview: Boolean(nonce), fetchText, fetchJSON, callFunction });
  }

  if (typeof window !== 'undefined') window.HC = create(window);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      create, previewFragment, parsePreviewFragment, isBridgePath,
      BRIDGE_PATH_RE, BRIDGE_TIMEOUT_MS,
    };
  }
}());
