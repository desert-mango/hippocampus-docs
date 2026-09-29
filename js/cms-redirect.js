// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 29 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Send the retired /cms/ editor's routes to the site page they now live on, in Editor mode.
/* HCRedirect — the /cms/ redirect map (plan D-I). The editor moved from
   /cms/ into the site itself (Editor mode, D-H: #/<route>?editor=<tab>).
   legacyRoute(cmsHash) maps each old hash route to its new home:

     #/  #/review          -> /#/?editor=proposals
     #/review/N            -> /#/?editor=proposals&pr=N
     #/edit/<pageId>       -> that page's site route + ?editor=changes
                              (setup/<id>, project/<id>, tool/<id>, about;
                              #/edit/data/<x> -> /#/about?editor=changes&data=<x>)
     #/new/project         -> /#/projects?editor=changes&new=project
     #/new/person          -> /#/about?editor=changes&new=person
     #/media               -> /#/?editor=media
     #/help  #/private     -> /#/?editor=guide
     #/pages               -> /#/setup?editor=changes
     anything else         -> /#/?editor=proposals

   The answer is always a same-site '/#/…' route built from checked pieces
   (the same id rules as js/cms-core.js's routes, copied, because this file
   must not load cms-core). Loaded on /cms/ (or /cms/index.html) it sends the
   page there at once with location.replace; on any other page — the GitHub
   App's /cms/callback.html, which stays where it is, or the site — it only
   defines window.HCRedirect. Node loads it for tools/tests/test_cms_redirect.mjs. */
(function () {
  'use strict';

  const HOME = '/#/?editor=proposals';
  const PAGE_ID_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
  const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
  const DATA_RE = /^[a-z0-9][a-z0-9-]*$/;
  const PULL_RE = /^\/review\/([1-9][0-9]{0,8})\/?$/;
  const FIXED = Object.freeze({
    '/': HOME,
    '/review': HOME,
    '/new/project': '/#/projects?editor=changes&new=project',
    '/new/person': '/#/about?editor=changes&new=person',
    '/media': '/#/?editor=media',
    '/help': '/#/?editor=guide',
    '/private': '/#/?editor=guide',
    '/pages': '/#/setup?editor=changes',
  });

  function editRoute(pageId) {
    if (!PAGE_ID_RE.test(pageId)) return null;
    if (pageId === 'about') return '/#/about?editor=changes';
    const [kind, ...rest] = pageId.split('/');
    const id = rest.join('/');
    if (kind === 'setup' && id) return `/#/setup/${id}?editor=changes`;
    if (kind === 'project' && SLUG_RE.test(id)) return `/#/projects/${id}?editor=changes`;
    if (kind === 'tool' && SLUG_RE.test(id)) return `/#/tools/${id}?editor=changes`;
    if (kind === 'data' && DATA_RE.test(id)) return `/#/about?editor=changes&data=${id}`;
    return null;
  }

  function legacyRoute(cmsHash) {
    let h = typeof cmsHash === 'string' ? cmsHash : '';
    if (/[\x00-\x1f\x7f\\]/.test(h)) return HOME;
    if (h.charAt(0) === '#') h = h.slice(1);
    h = h.split('?')[0];
    if (h === '') h = '/';
    if (h.length > 1) h = h.replace(/\/$/, '');
    if (Object.prototype.hasOwnProperty.call(FIXED, h)) return FIXED[h];
    const pr = PULL_RE.exec(h);
    if (pr) return `${HOME}&pr=${pr[1]}`;
    if (h.indexOf('/edit/') === 0) return editRoute(h.slice(6)) || HOME;
    return HOME;
  }

  const api = Object.freeze({ legacyRoute });
  if (typeof window !== 'undefined') {
    window.HCRedirect = api;
    const loc = window.location;
    if (loc && /\/cms\/(index\.html)?$/.test(String(loc.pathname || ''))) loc.replace(legacyRoute(loc.hash));
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
