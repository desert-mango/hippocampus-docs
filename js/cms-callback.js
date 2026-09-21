// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Hand the GitHub sign-in code from the popup to the CMS window that opened it.
/* The sign-in popup's landing page script (cms/callback.html).

   It does ONE thing: post {type: "hc-code", code, state} to the window that
   opened this popup — addressed to this site's own origin only — and close.
   It never touches storage, never calls /api/auth, and never sees a token.
   The opener (js/cms.js) checks that the message came from the popup it
   opened and that `state` matches its own copy, then does the exchange.

   The code is also scrubbed from the address bar straight away, so it does
   not linger in this window's history. */
(function () {
  'use strict';

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

  if (!code) {
    // GitHub sends ?error=access_denied when the person clicks Cancel.
    say('Sign-in did not finish. You can close this window and try again from the editor.');
    return;
  }
  var opener = window.opener;
  if (!opener || opener.closed) {
    say('Sign-in could not reach the editor tab. You can close this window and sign in again from the editor.');
    return;
  }
  opener.postMessage({ type: 'hc-code', code: code, state: state }, window.location.origin);
  window.close();
}());
