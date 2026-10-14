// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the allowlist HTML sanitizer that every rendered Markdown page passes through.
/* Unit tests for js/sanitize.js (HCSanitize.clean).

   Node has no DOMParser, and the browser code must not grow a node-only path,
   so this file installs a SMALL HTML parser + serializer on globalThis as
   `DOMParser` and runs the unmodified browser code against it. The shim is a
   test fixture, not a second HTML parser for the site: it knows void and
   raw-text elements, quoted and unquoted attributes, character references
   (including the `&colon;` / `&#x09;` tricks), comments, the svg/math
   namespaces and the one implied end tag (`<p>` closed by a block) that
   marked's output needs. Serialization follows the HTML spec's escaping rules
   (text: & < > and U+00A0; attribute values: & " and U+00A0), which is what
   `innerHTML` does in every browser, so the expected strings below hold in
   both. The same cases were re-run against Chrome's real DOMParser in the
   browser pass (see the unit report).

     node --test tools/tests/test_sanitize.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SANITIZE_JS = path.join(ROOT, 'js', 'sanitize.js');

// ------------------------------------------------------------ DOMParser shim --

import { HTML_NS, SVG_NS, MATHML_NS, parseHTML, ShimDOMParser } from './fixtures/dom_shim.mjs';

// The unsanitized baseline: what the browser would build from the same HTML,
// serialized back — comments are dropped because the sanitizer drops them.
function roundTrip(html) {
  const doc = parseHTML(html);
  const strip = (node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 8) node.removeChild(c); else if (c.nodeType === 1) strip(c);
    }
  };
  strip(doc.body);
  return doc.body.innerHTML;
}

// ----------------------------------------------------------------- loading --

// Taken before the shim goes in: node itself must offer no DOMParser, or the
// shim would not be what the sanitizer is running against.
const NATIVE_DOMPARSER = typeof globalThis.DOMParser;

test('js/sanitize.js loads under plain node with no window and no DOMParser', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(NATIVE_DOMPARSER, 'undefined');
  delete require.cache[require.resolve(SANITIZE_JS)];
  const mod = require(SANITIZE_JS);
  assert.equal(typeof mod.clean, 'function');
  assert.equal(typeof mod.safeHref, 'function');
  assert.equal(typeof mod.safeSrc, 'function');
});

globalThis.DOMParser = ShimDOMParser;
const S = require(SANITIZE_JS);
const clean = (html) => S.clean(html);

// ------------------------------------------------------------ scripts, handlers --

test('a script tag is dropped together with its body', () => {
  assert.equal(clean('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
  assert.equal(clean('<p>x<script src="https://res.cloudinary.com/x.js"></script></p>'), '<p>x</p>');
  assert.equal(clean('<SCRIPT>alert(1)</SCRIPT>ok'), 'ok');
});

test('onerror and every other on* handler are dropped, the element stays', () => {
  const src = 'https://res.cloudinary.com/dr76gues0/image/upload/v1/hippocampus-docs/x.png';
  assert.equal(
    clean(`<img src="${src}" onerror="alert(1)" alt="pic">`),
    `<img src="${src}" alt="pic">`,
  );
  assert.equal(clean('<a href="#/about" onclick="steal()" onmouseover="x()">about</a>'),
    '<a href="#/about">about</a>');
  assert.equal(clean('<p onload=alert(1) class="lead">t</p>'), '<p class="lead">t</p>');
});

test('style attributes and dangerous elements vanish with their contents', () => {
  assert.equal(clean('<p style="position:fixed;inset:0">x</p>'), '<p>x</p>');
  for (const html of [
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example/"></iframe>',
    '<object data="x.swf"></object>',
    '<embed src="x.swf">',
    '<form action="https://evil.example/"><input name="p"><button>go</button></form>',
    '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
    '<math><mtext><a href="javascript:alert(1)">x</a></mtext></math>',
    '<template><img src="x" onerror="alert(1)"></template>',
    '<noscript><p>hidden</p></noscript>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<textarea><img src=x onerror=alert(1)></textarea>',
    '<video src="https://evil.example/v.mp4"></video>',
  ]) {
    assert.equal(clean(`<p>before</p>${html}<p>after</p>`), '<p>before</p><p>after</p>', html);
  }
});

test('comments are dropped', () => {
  assert.equal(clean('<p>a<!-- note --></p><!-- <script>x</script> -->'), '<p>a</p>');
});

test('an unknown but inert element is unwrapped: its text survives, its tag does not', () => {
  assert.equal(clean('<section><p>kept</p></section>'), '<p>kept</p>');
  assert.equal(clean('<p><font color="red">red</font> <mark>m</mark></p>'), '<p>red m</p>');
  assert.equal(clean('<center><a href="javascript:x">t</a></center>'), '<a>t</a>');
});

// ------------------------------------------------------------------ href rule --

test('javascript: hrefs are dropped in every spelling', () => {
  for (const href of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)',
    'java&#x09;script:alert(1)', 'javascript&colon;alert(1)', '&#106;avascript:alert(1)',
    'jav&#x0A;ascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>',
    'mailto:someone@example.org', 'file:///etc/passwd',
  ]) {
    assert.equal(clean(`<a href="${href}">x</a>`), '<a>x</a>', href);
  }
});

test('protocol-relative, absolute-path, parent and non-assets relative hrefs are dropped', () => {
  for (const href of [
    '//evil.example/x', '../x', '/assets/setup/cutout.pdf', 'assets/../index.html',
    'assets/setup/../../x', 'assets/%2e%2e/x', 'assets/.%2E/x', 'assets\\..\\x',
    'assets/setup/x%2F..%2Fy', 'content/setup/lab-marker/design.md', 'assets',
    'assets/ setup/x.stl', 'assets/setup/\tx.stl', './assets/setup/cutout.pdf', 'https:evil.example',
    'http:/evil.example',
  ]) {
    assert.equal(clean(`<a href="${href}">x</a>`), '<a>x</a>', href);
  }
});

test('http(s), fragment and assets/ hrefs are kept verbatim', () => {
  for (const href of [
    'https://github.com/HippoCampusRobotics', 'http://example.org/a?b=c&d=e', 'HTTPS://EXAMPLE.ORG/',
    '#/setup/lab-marker/design', '#/about@people', '#top',
    'assets/setup/cutout.pdf', 'assets/setup/13mm_Bottom_Part.stl', 'assets/setup/a%20b.stl',
    'assets/setup/x.stl?dl=1#frag',
  ]) {
    const out = clean(`<a href="${href.replace(/&/g, '&amp;')}">x</a>`);
    assert.equal(out, `<a href="${href.replace(/&/g, '&amp;')}">x</a>`, href);
  }
});

test('the seven relative assets/setup download links in design.md survive verbatim', () => {
  const { marked } = require(path.join(ROOT, 'js', 'marked.min.js'));
  marked.use({ mangle: false, headerIds: false });
  const md = fs.readFileSync(path.join(ROOT, 'content/setup/lab-marker/design.md'), 'utf8');
  const expected = [...md.matchAll(/\]\((assets\/setup\/[^)\s]+)\)/g)].map((m) => m[1]);
  assert.equal(expected.length, 7, 'design.md carries exactly seven assets/setup links');
  assert.deepEqual(expected.filter((h) => /\.stl$/.test(h)).length, 4);
  assert.deepEqual(expected.filter((h) => /\.3mf$/.test(h)).length, 2);
  assert.ok(expected.includes('assets/setup/cutout.pdf'));
  const out = clean(marked.parse(md));
  const kept = [...out.matchAll(/href="(assets\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kept, expected);
});

// ------------------------------------------------------------------- src rule --

test('a foreign img src is dropped; only https://res.cloudinary.com/ survives', () => {
  for (const src of [
    'https://evil.example/x.png', 'http://res.cloudinary.com/x.png', '//res.cloudinary.com/x.png',
    'https://res.cloudinary.com.evil.example/x.png', 'https://evil.example/https://res.cloudinary.com/',
    'assets/hippo.svg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', ' https://res.cloudinary.com/x.png',
  ]) {
    assert.equal(clean(`<img src="${src}" alt="a">`), '<img alt="a">', src);
  }
  const ok = 'https://res.cloudinary.com/dr76gues0/image/upload/v1/hippocampus-docs/a.jpg';
  assert.equal(clean(`<img src="${ok}" alt="a" srcset="https://evil.example/x 2x">`),
    `<img src="${ok}" alt="a">`);
});

test('img keeps alt, title, numeric width/height and a valid loading value', () => {
  const ok = 'https://res.cloudinary.com/dr76gues0/image/upload/v1/hippocampus-docs/a.jpg';
  assert.equal(
    clean(`<img src="${ok}" alt="a" title="t" width="320" height="200" loading="lazy">`),
    `<img src="${ok}" alt="a" title="t" width="320" height="200" loading="lazy">`,
  );
  assert.equal(clean(`<img src="${ok}" width="100%;x" loading="soon">`), `<img src="${ok}">`);
});

// -------------------------------------------------------------- tables, align --

test('<td align="center"> is kept, and marked tables come through untouched', () => {
  assert.equal(clean('<table><tbody><tr><td align="center">c</td></tr></tbody></table>'),
    '<table><tbody><tr><td align="center">c</td></tr></tbody></table>');
  const { marked } = require(path.join(ROOT, 'js', 'marked.min.js'));
  const html = marked.parse('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n');
  assert.match(html, /align="center"/);
  assert.equal(clean(html), roundTrip(html));
  assert.equal(clean('<td align="javascript:x">c</td>'.replace(/^/, '<table><tbody><tr>') + '</tr></tbody></table>'),
    '<table><tbody><tr><td>c</td></tr></tbody></table>');
});

test('align is kept only on th/td; colspan/rowspan must be numbers', () => {
  assert.equal(clean('<p align="center">x</p>'), '<p>x</p>');
  assert.equal(
    clean('<table><thead><tr><th align="right" colspan="2" rowspan="x">h</th></tr></thead></table>'),
    '<table><thead><tr><th align="right" colspan="2">h</th></tr></thead></table>',
  );
});

// ------------------------------------------------------------ dialect, headings --

test('admonition blocks are kept intact', () => {
  const adm = '<div class="adm adm-note"><p class="adm-title">Note</p><p>Body <code>x</code>.</p></div>';
  assert.equal(clean(adm), adm);
  for (const kind of ['attention', 'hint', 'important', 'seealso', 'tip', 'todo', 'warning',
    'caution', 'danger', 'error']) {
    const block = `<div class="adm adm-${kind}"><p class="adm-title">${kind}</p></div>`;
    assert.equal(clean(block), block);
  }
});

test('tabs keep their classes and data-label', () => {
  const tabs = '<div class="tabs"><div class="tab" data-label="Ubuntu"><p>u</p></div>'
    + '<div class="tab" data-label="macOS"><pre><code class="language-sh">$ ls\n</code></pre></div></div>';
  assert.equal(clean(tabs), tabs);
});

test('class tokens outside the allowlist are removed, allowed ones kept', () => {
  assert.equal(clean('<div class="adm evil adm-note">x</div>'), '<div class="adm adm-note">x</div>');
  assert.equal(clean('<div class="hc-modal-backdrop">x</div>'), '<div>x</div>');
  assert.equal(clean('<p class="provenance">p</p><p class="figcaption">f</p>'),
    '<p class="provenance">p</p><p class="figcaption">f</p>');
  assert.equal(clean('<div class="img-grid"><span class="math"><code>T</code></span></div>'),
    '<div class="img-grid"><span class="math"><code>T</code></span></div>');
  assert.equal(clean('<pre><code class="language-c++">x</code></pre>'),
    '<pre><code class="language-c++">x</code></pre>');
});

test('headings h1-h6 are kept with their ids; name and other attributes are not', () => {
  const hs = [1, 2, 3, 4, 5, 6].map((n) => `<h${n} id="s${n}">Head ${n}</h${n}>`).join('');
  assert.equal(clean(hs), hs);
  assert.equal(clean('<h2 name="x" id="y" dir="rtl">t</h2>'), '<h2 id="y">t</h2>');
  assert.equal(clean('<div id="people-root"></div>'), '<div id="people-root"></div>');
});

test('the remaining allowlisted elements are kept', () => {
  const html = '<p>a<br>b</p><hr><ul><li>x</li></ul><ol><li>y</li></ol><blockquote><p>q</p></blockquote>'
    + '<p><em>e</em><strong>s</strong><b>b</b><i>i</i><u>u</u><s>s</s><del>d</del><sup>1</sup>'
    + '<sub>2</sub><kbd>k</kbd><span>sp</span></p><details><summary>More</summary><p>d</p></details>'
    + '<dl><dt>t</dt><dd>d</dd></dl><figure><figcaption>c</figcaption></figure>';
  assert.equal(clean(html), html);
});

test('external-link attributes the site adds itself are not accepted from content', () => {
  assert.equal(clean('<a href="https://example.org" target="_top" rel="opener">x</a>'),
    '<a href="https://example.org">x</a>');
});

// ------------------------------------------------------------------ corpus --

test('every content page renders byte-identically through the sanitizer', () => {
  const { marked } = require(path.join(ROOT, 'js', 'marked.min.js'));
  marked.use({ mangle: false, headerIds: false });
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'content'));
  assert.ok(files.length >= 90, `expected the whole corpus, found ${files.length} files`);
  for (const f of files) {
    const html = marked.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(clean(html), roundTrip(html), path.relative(ROOT, f));
  }
});

test('clean() is idempotent and tolerates empty input', () => {
  assert.equal(clean(''), '');
  assert.equal(clean(null), '');
  assert.equal(clean(undefined), '');
  for (const html of [
    '<p>a &amp; b &lt;c&gt; &nbsp;</p>',
    '<a href="https://example.org/?a=1&amp;b=&quot;2&quot;">q</a>',
    '<div class="adm adm-note evil"><p class="adm-title" onclick="x">N</p></div>',
  ]) {
    const once = clean(html);
    assert.equal(clean(once), once, html);
  }
});

test('text that looks like markup stays text', () => {
  assert.equal(clean('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(clean('<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>'),
    '<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>');
});

// ------------------------------------------------------------- the helpers --

test('safeHref and safeSrc answer the same questions directly', () => {
  assert.equal(S.safeHref('assets/setup/cutout.pdf'), 'assets/setup/cutout.pdf');
  assert.equal(S.safeHref('//evil.example/x'), null);
  assert.equal(S.safeHref('../x'), null);
  assert.equal(S.safeHref(42), null);
  assert.equal(S.safeSrc('https://res.cloudinary.com/a/b.png'), 'https://res.cloudinary.com/a/b.png');
  assert.equal(S.safeSrc('https://evil.example/b.png'), null);
});
