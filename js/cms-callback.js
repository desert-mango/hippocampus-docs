// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Hand the GitHub sign-in code from the popup to the CMS window that opened it.
/* The sign-in's landing page script (cms/callback.html).

   With an opener (the sign-in pop-up) it does ONE thing: post {type:
   "hc-code", code, state} to the window that opened it — addressed to this
   site's own origin only — and close. It then never touches storage, never
   calls /api/auth, and never sees a token. The opener (js/editor.js) checks
   that the message came from the pop-up it opened and that `state` matches
   its own copy, then does the exchange.

   With NO opener (U1, D19: the pop-up was blocked, so js/app.js sent this tab
   to GitHub itself) it finishes the sign-in here: the state js/app.js kept in
   this tab's sessionStorage (hc-signin-same-tab, single use, at most 10
   minutes old) must match GitHub's; then it POSTs the code to /api/auth,
   whose answer sets the session cookie (the token in the answer's body is
   never read here), and returns to the saved page, where the boot resumes
   from the cookie. A saved page that is not a "#/..." site route returns to
   the home page.

   The code is also scrubbed from the address bar straight away, so it does
   not linger in this window's history. */
(function () {
  'use strict';

  var SAME_TAB_KEY = 'hc-signin-same-tab';
  var MAX_AGE_MS = 10 * 60 * 1000;
  var ROUTE_RE = /^#\/[A-Za-z0-9._~!$&'()*+,;=:@%\/?-]*$/;
  var status = document.getElementById('status');
  var params = new URLSearchParams(window.location.search);
  var code = params.get('code');
  var state = params.get('state');

  try {
    window.history.replaceState(null, '', window.location.pathname);
  } catch (e) { /* the scrub is a courtesy; the hand-off does not depend on it */ }

  function say(text) {
    if (status) status.textContent = text;
  }

  var opener = window.opener;
  if (opener && !opener.closed) {
    if (!code) {
      // GitHub sends ?error=access_denied when the person clicks Cancel.
      say('Sign-in did not finish. You can close this window and try again from the editor.');
      return;
    }
    opener.postMessage({ type: 'hc-code', code: code, state: state }, window.location.origin);
    window.close();
    return;
  }

  // no opener: the same-tab sign-in, or a pop-up whose editor tab is gone
  var saved = null;
  try {
    var raw = window.sessionStorage.getItem(SAME_TAB_KEY);
    window.sessionStorage.removeItem(SAME_TAB_KEY);      // single use, whatever happens next
    saved = JSON.parse(raw || 'null');
  } catch (e) { saved = null; }
  var fresh = saved && typeof saved === 'object' && typeof saved.state === 'string' && saved.state
    && typeof saved.at === 'number' && Date.now() - saved.at >= 0 && Date.now() - saved.at <= MAX_AGE_MS;
  if (!fresh) {
    say(code ? 'Sign-in could not reach the editor tab. You can close this window and sign in again from the editor.'
      : 'Sign-in did not finish. You can close this window and try again from the editor.');
    return;
  }
  function back() {
    var route = typeof saved.route === 'string' && ROUTE_RE.test(saved.route) ? saved.route : '#/';
    window.location.replace(window.location.origin + '/' + route);
  }
  if (!code) {
    say('Sign-in did not finish. Taking you back…');
    back();
    return;
  }
  if (state !== saved.state) {
    say('Sign-in could not be checked, so it was stopped. Go back to the site and sign in again.');
    return;
  }
  say('Signing you in…');
  window.fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code: code, app: 'editor' }),
    credentials: 'same-origin',
    cache: 'no-store',
  }).then(function (res) {
    if (!res || !res.ok) throw new Error('refused');
    back();
  }).catch(function () {
    say('Sign-in did not finish. Go back to the site and sign in again.');
  });
}());
