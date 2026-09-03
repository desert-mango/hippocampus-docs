/* Unit tests for the pure helpers inside js/graph.js (the semantic-graph UI layer).
   No dependencies, no DOM: js/graph.js must load cleanly under plain node, which is
   also the smoke test that its browser wiring is properly guarded.

     node --test tools/tests/test_graph_ui.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HC = require(new URL('../../js/graph.js', import.meta.url).pathname);

const {
  buildTermMatcher, findMatches, currentNodeId, hrefFor,
  contributorRows, truncatedLabel, commitLabel, safeHttpUrl,
} = HC;

// ---------------------------------------------------------------- safeHttpUrl
test('safeHttpUrl accepts http(s) and rejects everything else', () => {
  assert.equal(safeHttpUrl('https://example.org/x'), 'https://example.org/x');
  assert.equal(safeHttpUrl('http://example.org'), 'http://example.org');
  assert.equal(safeHttpUrl('  https://example.org/y  '), 'https://example.org/y');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('JavaScript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<b>'), null);
  assert.equal(safeHttpUrl('/relative'), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl(undefined), null);
  assert.equal(safeHttpUrl(42), null);
});

// ------------------------------------------------------------ buildTermMatcher
test('buildTermMatcher orders terms longest-first', () => {
  const m = buildTermMatcher({
    hippo_control: 'repo:hippo_control',
    hippo_control_msgs: 'repo:hippo_control_msgs',
    esc: 'repo:esc',
    'Alpha Arm': 'setup/bluerov/alpha-arm',
  });
  const lens = m.terms.map((t) => t.length);
  const sorted = lens.slice().sort((a, b) => b - a);
  assert.deepEqual(lens, sorted, 'terms must be sorted longest-first');
  assert.equal(m.terms[0], 'hippo_control_msgs');
  assert.equal(m.terms[m.terms.length - 1], 'esc');
});

test('buildTermMatcher regex-escapes dots, parens and dashes', () => {
  const m = buildTermMatcher({
    'Ubuntu 24.04 Server 64bit': 'setup/raspberry-pi/ubuntu-24-04-server',
    'IP Cameras (Blick)': 'setup/lab-cameras/ip-cameras',
    'Teaching — Formulas and Vehicles': 'projects/teaching',
    'acoustic_msgs-release': 'repo:acoustic_msgs-release',
  });
  // The '.' must be literal: "24X04" must not match "24.04".
  const wild = findMatches('Flash Ubuntu 24X04 Server 64bit today', m, {});
  assert.deepEqual(wild, []);
  const real = findMatches('Flash Ubuntu 24.04 Server 64bit today', m, {});
  assert.equal(real.length, 1);
  assert.equal(real[0].nodeId, 'setup/raspberry-pi/ubuntu-24-04-server');
  assert.equal(real[0].text, 'Ubuntu 24.04 Server 64bit');

  // Parens are literal, not a capture group.
  const paren = findMatches('See IP Cameras (Blick) for the feed.', m, {});
  assert.equal(paren.length, 1);
  assert.equal(paren[0].text, 'IP Cameras (Blick)');
  assert.equal(paren[0].nodeId, 'setup/lab-cameras/ip-cameras');

  const dash = findMatches('The Teaching — Formulas and Vehicles project.', m, {});
  assert.equal(dash.length, 1);
  assert.equal(dash[0].nodeId, 'projects/teaching');

  const hy = findMatches('Use acoustic_msgs-release here.', m, {});
  assert.equal(hy.length, 1);
  assert.equal(hy[0].nodeId, 'repo:acoustic_msgs-release');
});

test('buildTermMatcher tolerates an empty term map', () => {
  const m = buildTermMatcher({});
  assert.deepEqual(m.terms, []);
  assert.deepEqual(findMatches('anything at all', m, {}), []);
  assert.deepEqual(findMatches('anything', buildTermMatcher(null), {}), []);
});

// ----------------------------------------------------------------- findMatches
const M = buildTermMatcher({
  hippo_control: 'repo:hippo_control',
  hippo_control_msgs: 'repo:hippo_control_msgs',
  esc: 'repo:esc',
  'hippo-release': 'repo:hippo-release',
  'Alpha Arm': 'setup/bluerov/alpha-arm',
  Colcon: 'setup/concepts/colcon',
});

test('findMatches respects word boundaries with underscore as a word char', () => {
  assert.equal(findMatches('the hippo_control node', M, {})[0].nodeId, 'repo:hippo_control');
  // "hippo_control" must not match inside "hippo_control_msgs" — and the longer term wins.
  const inner = findMatches('the hippo_control_msgs package', M, {});
  assert.equal(inner.length, 1);
  assert.equal(inner[0].nodeId, 'repo:hippo_control_msgs');
  assert.equal(inner[0].text, 'hippo_control_msgs');
  // With only the short term registered, the long word yields nothing at all.
  const short = buildTermMatcher({ hippo_control: 'repo:hippo_control' });
  assert.deepEqual(findMatches('the hippo_control_msgs package', short, {}), []);
  assert.deepEqual(findMatches('the my_hippo_control package', short, {}), []);
});

test('findMatches will not match a short term inside a longer word', () => {
  assert.deepEqual(findMatches('escape the room', M, {}), []);
  assert.deepEqual(findMatches('to descale', M, {}), []);
  assert.equal(findMatches('the esc board', M, {})[0].nodeId, 'repo:esc');
  assert.equal(findMatches('(esc)', M, {})[0].nodeId, 'repo:esc');
});

test('findMatches treats the hyphen as a word char', () => {
  assert.equal(findMatches('see hippo-release now', M, {})[0].nodeId, 'repo:hippo-release');
  assert.deepEqual(findMatches('see super-hippo-release now', M, {}), []);
  assert.deepEqual(findMatches('see hippo-release-2 now', M, {}), []);
});

test('findMatches is case-insensitive but reports the source text', () => {
  const hits = findMatches('Build with COLCON please', M, {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].nodeId, 'setup/concepts/colcon');
  assert.equal(hits[0].text, 'COLCON');
  assert.equal(hits[0].term, 'Colcon');
  const hits2 = findMatches('the alpha arm moves', M, {});
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].nodeId, 'setup/bluerov/alpha-arm');
  assert.equal(hits2[0].text, 'alpha arm');
});

test('findMatches links a term at most once and shares the used set across calls', () => {
  const used = new Set();
  const first = findMatches('Colcon here and Colcon again', M, { used });
  assert.equal(first.length, 1, 'first occurrence wins, later ones are dropped');
  assert.equal(first[0].start, 0);
  const second = findMatches('and Colcon a third time', M, { used });
  assert.deepEqual(second, [], 'the used set carries across text nodes');
  // A fresh set starts over.
  assert.equal(findMatches('and Colcon a third time', M, { used: new Set() }).length, 1);
});

test('findMatches never links the current page to itself', () => {
  const opts = { selfId: 'setup/concepts/colcon' };
  assert.deepEqual(findMatches('Colcon builds the workspace', M, opts), []);
  const mixed = findMatches('Colcon builds hippo_control', M, { selfId: 'setup/concepts/colcon' });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].nodeId, 'repo:hippo_control');
});

test('findMatches returns non-overlapping matches in document order', () => {
  const hits = findMatches('Colcon builds hippo_control for the Alpha Arm', M, {});
  assert.deepEqual(hits.map((h) => h.nodeId),
    ['setup/concepts/colcon', 'repo:hippo_control', 'setup/bluerov/alpha-arm']);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i].start >= hits[i - 1].end, 'matches must not overlap');
  }
  const text = 'Colcon builds hippo_control for the Alpha Arm';
  hits.forEach((h) => assert.equal(text.slice(h.start, h.end), h.text));
});

// --------------------------------------------------------------- currentNodeId
test('currentNodeId maps every route shape', () => {
  assert.equal(currentNodeId('#/'), 'index:home');
  assert.equal(currentNodeId('#'), 'index:home');
  assert.equal(currentNodeId(''), 'index:home');
  assert.equal(currentNodeId('#/projects'), 'index:projects');
  assert.equal(currentNodeId('#/tools'), 'index:tools');
  assert.equal(currentNodeId('#/setup'), 'setup/start/index');
  assert.equal(currentNodeId('#/about'), 'about');
  assert.equal(currentNodeId('#/setup/bluerov/alpha-arm'), 'setup/bluerov/alpha-arm');
  assert.equal(currentNodeId('#/setup/start/index'), 'setup/start/index');
  assert.equal(currentNodeId('#/projects/uvms'), 'projects/uvms');
  assert.equal(currentNodeId('#/tools/onshape-mcp'), 'tools/onshape-mcp');
});

test('currentNodeId strips @anchors and ?queries', () => {
  assert.equal(currentNodeId('#/setup/bluerov/alpha-arm@wiring'), 'setup/bluerov/alpha-arm');
  assert.equal(currentNodeId('#/projects/uvms@repositories'), 'projects/uvms');
  assert.equal(currentNodeId('#/about@people'), 'about');
  assert.equal(currentNodeId('#/setup?x=1'), 'setup/start/index');
  assert.equal(currentNodeId('#/tools/runpod-mcp?a=b@head'), 'tools/runpod-mcp');
  assert.equal(currentNodeId('#/setup/bluerov/alpha-arm/'), 'setup/bluerov/alpha-arm');
});

test('currentNodeId returns null for routes with no node', () => {
  assert.equal(currentNodeId('#/search?q=dvl'), null);
  assert.equal(currentNodeId('#/nonsense'), null);
  assert.equal(currentNodeId(null), 'index:home');
});

// -------------------------------------------------------------------- hrefFor
test('hrefFor builds absolute hash URLs under a subpath base', () => {
  const base = 'https://x.github.io/hippocampus-docs/';
  const node = { id: 'setup/bluerov/alpha-arm', kind: 'setup', route: '#/setup/bluerov/alpha-arm' };
  assert.equal(hrefFor(node, base), 'https://x.github.io/hippocampus-docs/#/setup/bluerov/alpha-arm');
  // A base that already carries a hash route must be replaced, not appended to.
  assert.equal(hrefFor(node, 'https://x.github.io/hippocampus-docs/#/projects/uvms'),
    'https://x.github.io/hippocampus-docs/#/setup/bluerov/alpha-arm');
  assert.equal(hrefFor({ kind: 'index', route: '#/' }, base),
    'https://x.github.io/hippocampus-docs/#/');
  assert.equal(hrefFor({ kind: 'about', route: '#/about' }, 'http://localhost:8130/'),
    'http://localhost:8130/#/about');
});

test('hrefFor uses the GitHub url for repo nodes', () => {
  const base = 'https://x.github.io/hippocampus-docs/';
  assert.equal(
    hrefFor({ id: 'repo:hippo_control', kind: 'repo', url: 'https://github.com/HippoCampusRobotics/hippo_control' }, base),
    'https://github.com/HippoCampusRobotics/hippo_control');
  assert.equal(hrefFor({ kind: 'repo', url: 'javascript:alert(1)' }, base), null);
  assert.equal(hrefFor({ kind: 'repo' }, base), null);
  assert.equal(hrefFor(null, base), null);
  assert.equal(hrefFor({ kind: 'setup' }, base), null);
});

// ------------------------------------------------------------- contributorRows
const PEOPLE = {
  groups: [
    {
      id: 'active',
      people: [
        { name: 'Nathalie Bauschmann', title: 'Research Associate', photo: null, link: 'https://www.tuhh.de/mum/team/wimi/nathalie-bauschmann' },
        { name: '  Vincent   Lenz ', title: 'Research Associate', photo: null, link: 'https://www.tuhh.de/mum/team/wimi/vincent-lenz' },
      ],
    },
    {
      id: 'alumni',
      people: [
        { name: 'Thies Lennart Alff', title: 'Research Associate', photo: null, link: 'https://www.tuhh.de/mum/team/wimi/thies-lennart-alff' },
        { name: 'Niklas Trekel', title: 'Master Student', photo: null, link: null },
        { name: 'Daniel-André Dücker', title: 'Senior Scientist (TUM)', photo: null, link: 'https://www.tuhh.de/mum/team/wimi/daniel-duecker' },
        { name: 'Evil Person', title: 'x', photo: null, link: 'javascript:alert(1)' },
      ],
    },
  ],
};

test('contributorRows links only roster rows that match a person with an http(s) link', () => {
  const entry = {
    contributors: [
      { login: 'lennartalff', name: 'Thies Lennart Alff', contributions: 735, roster: true },
      { login: 'NBauschmann', name: 'Nathalie Bauschmann', contributions: 57, roster: true },
      { login: 'ntrekel', name: 'Niklas Trekel', contributions: 12, roster: true },
      { login: 'DanielDuecker', name: 'Daniel Duecker', contributions: 1 },
      { login: 'someone', name: 'Nathalie Bauschmann', contributions: 4 },
    ],
  };
  const rows = contributorRows(entry, PEOPLE);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].label, 'Thies Lennart Alff');
  assert.equal(rows[0].linkUrl, 'https://www.tuhh.de/mum/team/wimi/thies-lennart-alff');
  assert.equal(rows[1].linkUrl, 'https://www.tuhh.de/mum/team/wimi/nathalie-bauschmann');
  assert.equal(rows[2].linkUrl, null, 'roster person without a link stays plain text');
  assert.equal(rows[3].linkUrl, null, 'a near-miss name must not match Daniel-André Dücker');
  assert.equal(rows[4].linkUrl, null, 'a non-roster row is never linked');
});

test('contributorRows normalises names by trim, case and inner whitespace', () => {
  const entry = {
    contributors: [
      { login: 'v', name: 'vincent lenz', contributions: 3, roster: true },
      { login: 'v2', name: '  Vincent    Lenz  ', contributions: 3, roster: true },
      { login: 'v3', name: 'VincentLenz', contributions: 3, roster: true },
      { login: 'v4', name: 'Vincent Lenzz', contributions: 3, roster: true },
    ],
  };
  const rows = contributorRows(entry, PEOPLE);
  assert.equal(rows[0].linkUrl, 'https://www.tuhh.de/mum/team/wimi/vincent-lenz');
  assert.equal(rows[1].linkUrl, 'https://www.tuhh.de/mum/team/wimi/vincent-lenz');
  assert.equal(rows[2].linkUrl, null);
  assert.equal(rows[3].linkUrl, null);
});

test('contributorRows rejects a non-http person link', () => {
  const entry = { contributors: [{ login: 'e', name: 'Evil Person', contributions: 9, roster: true }] };
  assert.equal(contributorRows(entry, PEOPLE)[0].linkUrl, null);
});

test('contributorRows falls back to the login and pluralises the commit count', () => {
  const entry = {
    contributors: [
      { login: 'ghost', contributions: 1 },
      { login: 'other', name: '', contributions: 2 },
      { login: 'zero', name: 'Zero One', contributions: 0 },
    ],
  };
  const rows = contributorRows(entry, PEOPLE);
  assert.equal(rows[0].label, 'ghost');
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].countLabel, '1 commit');
  assert.equal(rows[1].label, 'other');
  assert.equal(rows[1].countLabel, '2 commits');
  assert.equal(rows[2].countLabel, '0 commits');
  assert.equal(commitLabel(1), '1 commit');
  assert.equal(commitLabel(39), '39 commits');
});

test('contributorRows degrades to plain text when people.json is unavailable', () => {
  const entry = { contributors: [{ login: 'a', name: 'Thies Lennart Alff', contributions: 5, roster: true }] };
  for (const people of [null, undefined, {}, { groups: 'nope' }, { groups: [{}] }]) {
    const rows = contributorRows(entry, people);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].linkUrl, null);
    assert.equal(rows[0].label, 'Thies Lennart Alff');
  }
});

test('contributorRows returns an empty array for a missing or empty entry', () => {
  assert.deepEqual(contributorRows(null, PEOPLE), []);
  assert.deepEqual(contributorRows({}, PEOPLE), []);
  assert.deepEqual(contributorRows({ contributors: [] }, PEOPLE), []);
  assert.deepEqual(contributorRows({ contributors: 'nope' }, PEOPLE), []);
  // Rows without a usable label are dropped.
  assert.deepEqual(contributorRows({ contributors: [{ contributions: 3 }] }, PEOPLE), []);
});

test('truncatedLabel renders the "+N more on GitHub" line only when there is a remainder', () => {
  assert.equal(truncatedLabel(39), '+39 more on GitHub');
  assert.equal(truncatedLabel(1), '+1 more on GitHub');
  assert.equal(truncatedLabel(0), null);
  assert.equal(truncatedLabel(undefined), null);
  assert.equal(truncatedLabel(null), null);
  assert.equal(truncatedLabel(-3), null);
  assert.equal(truncatedLabel('nope'), null);
});
