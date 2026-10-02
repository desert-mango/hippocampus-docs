// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 2 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Prove the /cms/ parity table: every retired /cms/ route and action names a green Editor-mode test.
/* /cms/ is retired (U8): js/cms.js, css/cms.css and
   tools/tests/test_cms_editor.mjs are gone, and cms/index.html only sends
   the old addresses on to the site (js/cms-redirect.js). Before they went,
   every route and action /cms/ offered was given an Editor-mode home and a
   test. docs/cms-v2-plan.md, "Revision 4", holds that table between
   <!-- parity-table:start --> and <!-- parity-table:end -->:

     | `/cms/` route or action | Its Editor-mode home | `file.mjs`: test name<br>… |

   This file holds the table to account:
     - every route of HCCore's route table (the hash routes /cms/ had) has a
       row, and so has each action the plan lists beside them (sign-in and
       its state check, drafts across the move, the beforeunload prompt,
       several open proposals on one page);
     - every row names at least one test, in tools/tests/test_editor.mjs,
       test_members_gating.mjs or test_cms_redirect.mjs, and no row says
       "untested";
     - every test a row names EXISTS and is GREEN: the three files are run
       (node --test, TAP) and each named test must be reported "ok";
     - every row of the retired test files is re-homed BY NAME: the rows
       that tested js/cms-core.js alone keep their names, the js/cms.js rows
       are named "js/editor.js …", and each of them is green too.

     node --test tools/tests/test_parity_table.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const PLAN = 'docs/cms-v2-plan.md';
const START = '<!-- parity-table:start -->';
const END = '<!-- parity-table:end -->';
const FILES = ['test_editor.mjs', 'test_members_gating.mjs', 'test_cms_redirect.mjs'];

/* The rows: [{what, home, tests: [{file, name}]}]. */
function parityRows() {
  const doc = fs.readFileSync(path.join(ROOT, PLAN), 'utf8');
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  assert.ok(a >= 0 && b > a, `${PLAN} holds the parity table between its two markers`);
  assert.equal(doc.indexOf(START, a + 1), -1, 'one table');
  const lines = doc.slice(a + START.length, b).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  assert.ok(lines.length > 2, 'a header, its rule and rows');
  assert.match(lines[1], /^\|(\s*-+\s*\|){3}$/, 'three columns');
  return lines.slice(2).map((line) => {
    assert.ok(line.endsWith('|'), line);
    const cells = line.slice(1, -1).split(/\s\|\s/).map((c) => c.trim());
    assert.equal(cells.length, 3, `three cells: ${line}`);
    const tests = cells[2].split('<br>').map((t) => t.trim()).filter(Boolean).map((t) => {
      const m = /^`([a-z_]+\.mjs)`: (.+)$/.exec(t);
      assert.ok(m, `a test is "\`file.mjs\`: name": ${t}`);
      return { file: m[1], name: m[2] };
    });
    return { what: cells[0], home: cells[1], tests };
  });
}

/* Runs the three files once; -> {ok: Set of "file: name", bad: Set}. */
let results = null;
function runSuites() {
  if (results) return results;
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;      // a fresh runner, reporting to its own stdout
  const ok = new Set();
  const bad = new Set();
  for (const f of FILES) {
    const out = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(ROOT, 'tools', 'tests', f)],
      { env, encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    for (const line of String(out.stdout).split('\n')) {
      const m = /^(not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(line);
      if (!m) continue;
      const name = m[2].replace(/\\n/g, '\n').replace(/\\([\\#])/g, '$1');
      const skipped = / # (SKIP|TODO)/.test(line);
      (m[1] || skipped ? bad : ok).add(`${f}: ${name}`);
    }
  }
  results = { ok, bad };
  return results;
}

/* HCCore's routes (the /cms/ hash routes), as the table's first column
   writes them; a new route without a row here fails the first test. */
const ROUTE_ROWS = {
  home: ['`#/`'],
  review: ['`#/review`'],
  'review-pr': ['`#/review/<n>`'],
  help: ['`#/help`'],
  pages: ['`#/pages`'],
  edit: ['`#/edit/<page>`', '`#/edit/data/<registry>`'],
  new: ['`#/new/project`', '`#/new/person`'],
  media: ['`#/media`'],
  private: ['`#/private`'],
};
// the actions the plan's U8 lists beside the routes
const ACTION_ROWS = ['sign-in popup', '`state` check', 'drafts across the move', '`beforeunload`',
  'several open proposals on one page', 'any other `/cms/` address'];

test('the parity table: every /cms/ route of HCCore.ROUTES, and every action the plan lists, has a row', () => {
  const rows = parityRows();
  assert.deepEqual(C.ROUTES.map((r) => r.name).sort(), Object.keys(ROUTE_ROWS).sort(),
    'every /cms/ route has its rows here (a new route needs a row and a test)');
  for (const [name, starts] of Object.entries(ROUTE_ROWS)) {
    for (const s of starts) {
      assert.ok(rows.some((r) => r.what.startsWith(s)), `${name}: a row starting ${s}`);
    }
  }
  for (const a of ACTION_ROWS) assert.ok(rows.some((r) => r.what.includes(a)), `a row for ${a}`);
  assert.ok(rows.length >= 30, `${rows.length} rows`);
});

test('every row names at least one test, in an Editor-mode test file, and none says "untested"', () => {
  for (const r of parityRows()) {
    assert.ok(r.tests.length >= 1, r.what);
    assert.ok(r.home.length > 0, `${r.what}: its Editor-mode home is named`);
    assert.ok(!/untested/i.test(`${r.what} ${r.home}`), r.what);
    for (const t of r.tests) assert.ok(FILES.indexOf(t.file) >= 0, `${r.what}: ${t.file} is one of ${FILES.join(', ')}`);
  }
});

test('every test the table names exists and is green', () => {
  const { ok, bad } = runSuites();
  assert.ok(ok.size > 100, `the three files ran (${ok.size} green)`);
  const named = new Set(parityRows().flatMap((r) => r.tests.map((t) => `${t.file}: ${t.name}`)));
  for (const k of named) {
    assert.ok(!bad.has(k), `not green: ${k}`);
    assert.ok(ok.has(k), `no such green test: ${k}`);
  }
});

/* Every row of the retired test files, by its old name. */
const RETIRED = [
  // test_cms_editor.mjs
  'page tree: exactly the registries\' pages — every setup page, project, tool, and About',
  'page tree: a broken or missing registry lists nothing from it, never a guessed page',
  'JSON problems carry line and column, in words, for the two rules that bite',
  'locked ids: a draft that drops or renames an existing id is refused with the rule\'s words',
  'formatLike: today\'s projects and people registries round-trip byte for byte',
  'snippets: note, warning and tabs in the site\'s dialect, wrapped around the selection',
  'drafts: kept in memory and in sessionStorage, keyed by page; broken storage never throws',
  'js/cms.js page tree (#/pages): one edit link per page and registry, plus New project / New person',
  'js/cms.js editor: a heading change reaches the preview frame through the draft, fresh nonce per reload',
  'js/cms.js editor: snippet buttons and the internal link picker insert into the draft',
  'js/cms.js raw-JSON editor: a trailing comma is refused with line and column; an id change with the rule',
  'js/cms.js editor: Read-only sees the page and its preview, view-only, with the pencil link',
  'js/cms.js editor: leaving a page with a draft that is not proposed asks first',
  'branch names: cms/<login>/<slug>-<yymmdd>, slugged to lowercase letters, digits and dashes',
  'forbidden paths: the editor writes only content/*.md and data/*.json, never the machinery or derived files',
  'PR body: summary, the pages, "Made in the site editor.", and the review link once it is known',
  'new project: exactly two files — the registry entry with the six keys, and content/projects/<id>.md',
  'new person: exactly name/title/photo/link in the chosen group; photo and link optional',
  'my open proposals: open, mine, on a cms/<login>/ branch of this repository, based on main',
  'collectProposal: every changed file of the drafts that go in; two drafts on one path, a bad registry or a forbidden path refuse',
  'Propose: blobs -> one tree on main\'s tree -> one commit -> one ref -> one PR, in order, then the review link',
  'Propose: adding to my own open proposal is one more commit on its branch and a ref move — no new PR',
  'Propose: a taken branch name retries -2 … -5; a file changed on GitHub since it was opened is refused before any write',
  'Propose: a 401 anywhere stops at once and says so; a refused path or branch sends nothing',
  'js/cms.js Propose from a setup page: exactly blobs -> tree -> commit -> ref -> PR, then #/review/<n>',
  'js/cms.js Propose: starting from my own proposal adds one commit and moves its branch — no new PR',
  'js/cms.js New project: a form -> one draft of two files -> Propose sends one tree with both paths',
  'js/cms.js New person: the form adds one person to the people draft and opens it',
  'js/cms.js New project can start from my open proposal: one more commit on its branch',
  'js/cms.js New person can start from my open proposal: the person joins its branch, one more commit',
  'js/cms.js New person: with a people draft already open, the person joins that draft on its base',
  'js/cms.js Propose: a 401 after the PR opened keeps it proposed (drafts gone) and ends the session',
  // test_cms_core.mjs
  'js/cms.js reaches GitHub only through cms-core; every write is an allowlisted review or Propose request',
  'cms/index.html: local scripts in order, noindex, and a way back to the site',
  'js/cms.js: a refresh that lands after sign-out and a new sign-in changes nothing',
  'js/cms.js: a "no access" answer that lands after sign-out leaves the signed-out page alone',
  'js/cms.js: an old session\'s 401 does not end the session that replaced it',
  'js/cms.js: a 401 for a list the old session asked for does not end the new session',
  'js/cms.js: "Recently merged" finds a merge on the second page of closed PRs',
  'js/cms.js Review list: mine first, author, age, files count, both badges; a title stays text',
  'js/cms.js Review PR: green ✓, the diff as text, Vercel\'s comment, and the preview at the PR head',
  'js/cms.js Review PR: a proposal that changes the site\'s code labels its preview "content only"',
  'js/cms.js Review PR: red ✗ with each annotation as "file, line, what to fix" and a link to the run',
  'js/cms.js Review PR: no finished run yet is "still checking", and asks for no annotations',
  'js/cms.js Review PR: Merge sends exactly one PUT pinned to the shown sha; a 409 says reload',
  'js/cms.js Review PR: approving your own proposal shows GitHub\'s refusal in the tab\'s words',
  'js/cms.js Review PR: request changes needs a comment; close and update send their one write',
  'js/cms.js Review PR: Read-only sees the proposal and its preview, and no button at all',
  'js/cms.js Review PR: a merged proposal offers one button, Undo on GitHub, and nothing else',
  'js/cms.js home: each recently merged proposal links to its Review page (where Undo is)',
  // test_cms_media.mjs
  'js/cms.js #/media: the images with c_limit,w_240 thumbnails, "on the site" marks, and a next page on next_cursor',
  'js/cms.js #/media: delete of an image the site uses says the verbatim line and calls nothing; a free one asks, then deletes',
  'js/cms.js #/media: a 409 from the gateway (the site started using it) shows the same line; rename sends {from, to}',
  'js/cms.js editor: Image from Media uploads (sign -> Cloudinary), adds ONE manifest entry, inserts ![alt](url), proposes both files',
  'js/cms.js editor: a duplicate (same sha256 as a site image) offers the site\'s URL and uploads nothing',
  'js/cms.js editor: an image the site has can be picked without uploading; a file over 5 MB is refused before any call',
  'js/cms.js New person: Photo from Media sets the photo to a site image',
  'js/cms.js #/media: read-only people see why they cannot manage images, and no gateway call is made',
  'js/cms.js New person on my open proposal: an image already proposed on that branch can be picked as the photo',
];
const SHELL_OLD = 'cms/index.html: local scripts in order, noindex, and a way back to the site';
const SHELL_NEW = 'cms/index.html: the redirect page loads only js/cms-redirect.js — no cms.js, no cms-core.js, '
  + 'no cms.css — noindex, and a way back to the site';
const rehomed = (old) => (old === SHELL_OLD ? SHELL_NEW : old.replace(/^js\/cms\.js/, 'js/editor.js'));

test('every row of the retired test files is re-homed by name in test_editor.mjs, and green', () => {
  assert.equal(RETIRED.length, 59, '32 + 18 + 9 rows');
  assert.equal(new Set(RETIRED).size, RETIRED.length);
  for (const gone of ['tools/tests/test_cms_editor.mjs', 'js/cms.js', 'css/cms.css']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} is deleted`);
  }
  const { ok } = runSuites();
  for (const old of RETIRED) assert.ok(ok.has(`test_editor.mjs: ${rehomed(old)}`), `re-homed and green: ${rehomed(old)}`);
  // and gone from the files that still run: nothing tests js/cms.js any more
  for (const f of ['test_cms_core.mjs', 'test_cms_media.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'tests', f), 'utf8');
    assert.ok(!/^test\('js\/cms\.js/m.test(src), `${f} has no js/cms.js row`);
    assert.ok(!/js', 'cms\.js'|\['cms-core\.js', 'cms\.js'\]/.test(src), `${f} never loads js/cms.js`);
  }
});
