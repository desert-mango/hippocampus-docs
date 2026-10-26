// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: A fake GitHub sign-in exchange for api/auth.js under tools/dev_site.mjs, for local browser runs only.
/* DEV ONLY, localhost only (U1, D20). Never deployed as a function: Vercel runs api/*.js and nothing
   else, and this file needs tools/dev_site.mjs to be loaded at all:

     node tools/dev_site.mjs --handler-deps tools/tests/dev_auth_fake.mjs
     # in Docker: --host 0.0.0.0, with -p 127.0.0.1:8131:8131 so the Mac listens on loopback only

   Its default export is the `deps` object api/auth.js's handler takes:
     env    a fake App: client id "dev-fake-client-id", a client secret and a seal key made fresh
            for this process (random; never a real credential, never printed), so a restart
            signs everyone out
     fetch  answers exactly two GitHub addresses and refuses every other one (no network):
              POST github.com/login/oauth/access_token -> a fake token "dev-fake-token-<hex>",
                   expires_in 28800, for any code
              DELETE api.github.com/applications/<id>/token -> 204 (the sign-out revoke)
   The fake token opens nothing at GitHub: the page's own GitHub calls (/user and the rest) need the
   walk's fake GitHub (tools/tests/fake_github.js) or they fail with a real 401. */
import { randomBytes } from 'node:crypto';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REVOKE_RE = /^https:\/\/api\.github\.com\/applications\/dev-fake-client-id\/token$/;

const reply = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
  json: async () => payload,
});

const calls = [];

async function fakeFetch(url, init) {
  const u = String(url);
  const method = String((init && init.method) || 'GET').toUpperCase();
  calls.push({ url: u, method });
  if (u === TOKEN_URL && method === 'POST') {
    return reply(200, { access_token: `dev-fake-token-${randomBytes(8).toString('hex')}`, token_type: 'bearer',
      scope: '', expires_in: 28800 });
  }
  if (REVOKE_RE.test(u) && method === 'DELETE') return reply(204);
  throw new Error('dev_auth_fake answers only the token exchange and the revoke');
}

export default Object.freeze({
  env: Object.freeze({
    GH_APP_CLIENT_ID: 'dev-fake-client-id',
    GH_APP_CLIENT_SECRET: `dev-fake-${randomBytes(24).toString('hex')}`,
    HC_SESSION_KEY: randomBytes(32).toString('hex'),
  }),
  fetch: fakeFetch,
  calls,
});
