// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Allowlist-sanitize the HTML that Markdown renders to, on the live site and in CMS previews.
/* HCSanitize.clean(html) -> html

   js/app.js renders every Markdown page as
       enhance(el(HCSanitize.clean(marked.parse(md))))
   so nothing a content file says reaches the page unless this allowlist names
   it. The same code runs on the live site and inside the CMS preview frame.

   How it parses: the browser's own DOMParser in 'text/html' mode, which builds
   an INERT document — no script runs, no image loads, no stylesheet applies.
   The tree is walked and pruned, and the body is serialized back with
   innerHTML. Node has no DOMParser; tools/tests/test_sanitize.mjs installs a
   small parser shim on globalThis and runs this same, unforked code.

   The policy (the CMS v2 plan, unit U4 — keep the two in step):

   ELEMENTS kept: p br hr h1-h6 ul ol li blockquote pre code em strong b i u s
     del sup sub a img table thead tbody tr th td div span details summary kbd
     dl dt dd figure figcaption.
   DROP_WHOLE — removed together with everything inside them: executable,
     embedding, form, raw-text and foreign-namespace (svg, math) elements.
   Any OTHER element is unwrapped: its tag goes, its (cleaned) children stay,
     so an author's unknown tag costs styling, never text.
   Comments, doctypes and processing instructions are removed.

   ATTRIBUTES kept (everything else is dropped, every on* handler and style
   included):
     any element: class (token-filtered, below), id, title, data-label
     a:      href — http:, https:, a '#' fragment, or a same-origin relative
             URL under assets/ (no scheme, no leading '/' or '//', no '..'
             segment, no backslash, whitespace or control character). That is
             what keeps the lab-marker download links (assets/setup/*.stl,
             *.3mf, cutout.pdf) working on every host, Pages' subpath included.
     img:    src (https://res.cloudinary.com/ only), alt, width/height (digits),
             loading (lazy|eager)
     th, td: align (left|center|right — marked emits it for aligned table
             columns), colspan/rowspan (digits)

   CLASS tokens kept: the content dialect (adm, adm-*, tabs, tab, adm-title,
   page-body), the content classes css/site.css styles (provenance,
   figcaption, img-grid, math), the classes js/app.js emits, and
   language-* (marked's own class on fenced code blocks). graph.js's
   overlay classes (hc-*, xref, contrib-*) are deliberately NOT here: content
   must not be able to dress itself up as the site's popovers and modals. */
(function () {
  'use strict';

  const HTML_NS = 'http://www.w3.org/1999/xhtml';

  const ELEMENTS = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
    'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'sup', 'sub', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'details', 'summary', 'kbd',
    'dl', 'dt', 'dd', 'figure', 'figcaption',
  ]);

  const DROP_WHOLE = new Set([
    'script', 'style', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'applet', 'param', 'noscript', 'noembed', 'noframes', 'svg', 'math', 'form', 'input',
    'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'title',
    'xmp', 'plaintext', 'listing', 'link', 'meta', 'base', 'head', 'canvas', 'audio',
    'video', 'source', 'track', 'portal', 'fencedframe', 'dialog', 'slot', 'map', 'area',
  ]);

  const CLASS_EXACT = new Set([
    // the content dialect
    'adm', 'tabs', 'tab', 'adm-title', 'page-body',
    // content classes css/site.css styles
    'provenance', 'figcaption', 'img-grid', 'math',
    // classes js/app.js emits
    'active', 'arrow', 'aside-box', 'back-link', 'badge', 'card', 'card-grid', 'chip',
    'chips', 'code-wrap', 'compact', 'copy-btn', 'detail-aside', 'detail-grid',
    'detail-main', 'error-panel', 'heading-anchor', 'is-static', 'kicker', 'lead',
    'page-nav', 'people-grid', 'people-group', 'person-card', 'person-initials',
    'person-name', 'person-photo', 'person-title', 'repo-row', 'result', 'result-divider',
    'role', 'search-notice', 'search-results', 'table-wrap', 'tabbar', 'title', 'where',
    'why', 'maintained', 'legacy', 'archive',
  ]);
  const CLASS_PATTERNS = [/^adm-[a-z0-9-]+$/, /^language-[A-Za-z0-9_+#.-]+$/];

  const DIGITS = /^\d{1,4}$/;
  const keepText = (v) => v;
  const digits = (v) => (DIGITS.test(v) ? v : null);
  const oneOf = (...allowed) => (v) => (allowed.includes(v.toLowerCase()) ? v : null);

  function cleanClass(value) {
    const kept = value.split(/[\t\n\f\r ]+/).filter((token) => token
      && (CLASS_EXACT.has(token) || CLASS_PATTERNS.some((re) => re.test(token))));
    return kept.length ? kept.join(' ') : null;
  }

  // Characters that make a relative URL mean something other than it looks:
  // the URL parser strips tab/newline anywhere, treats '\' as '/', and trims
  // leading/trailing C0 and space.
  const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f\\]/;

  function safeHref(value) {
    if (typeof value !== 'string') return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.charAt(0) === '#') return value;
    if (!/^assets\/./.test(value) || UNSAFE_URL_CHARS.test(value)) return null;
    const pathPart = value.split(/[?#]/)[0];
    if (/%2f|%5c/i.test(pathPart)) return null;              // an encoded separator
    const segments = pathPart.split('/');
    for (const seg of segments) {
      if (/^(\.|%2e){1,2}$/i.test(seg)) return null;          // '.', '..', '%2e%2e', '.%2E', …
    }
    return value;
  }

  function safeSrc(value) {
    if (typeof value !== 'string') return null;
    return /^https:\/\/res\.cloudinary\.com\//.test(value) && !UNSAFE_URL_CHARS.test(value)
      ? value : null;
  }

  const GLOBAL_ATTRS = { class: cleanClass, id: keepText, title: keepText, 'data-label': keepText };
  const CELL_ATTRS = { align: oneOf('left', 'center', 'right'), colspan: digits, rowspan: digits };
  const ELEMENT_ATTRS = {
    a: { href: safeHref },
    img: { src: safeSrc, alt: keepText, width: digits, height: digits, loading: oneOf('lazy', 'eager') },
    th: CELL_ATTRS,
    td: CELL_ATTRS,
  };

  function cleanAttributes(el, name) {
    const own = ELEMENT_ATTRS[name] || {};
    for (const attr of Array.from(el.attributes)) {
      const attrName = String(attr.name).toLowerCase();
      const rule = Object.prototype.hasOwnProperty.call(own, attrName) ? own[attrName]
        : Object.prototype.hasOwnProperty.call(GLOBAL_ATTRS, attrName) ? GLOBAL_ATTRS[attrName]
          : null;
      const kept = rule ? rule(String(attr.value)) : null;
      if (kept === null) el.removeAttribute(attr.name);
      else if (kept !== attr.value) el.setAttribute(attr.name, kept);
    }
  }

  function unwrap(el) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function cleanChildren(parent) {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) continue;                        // text
      if (node.nodeType !== 1) { parent.removeChild(node); continue; }
      const name = String(node.localName || '').toLowerCase();
      if (node.namespaceURI !== HTML_NS || DROP_WHOLE.has(name)) {
        parent.removeChild(node);
      } else if (ELEMENTS.has(name)) {
        cleanAttributes(node, name);
        cleanChildren(node);
      } else {
        cleanChildren(node);                                    // children first, then lift them
        unwrap(node);
      }
    }
  }

  function clean(html) {
    if (html === null || html === undefined) return '';
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    if (!doc || !doc.body) return '';
    cleanChildren(doc.body);
    return doc.body.innerHTML;
  }

  const API = { clean, safeHref, safeSrc };

  if (typeof window !== 'undefined') window.HCSanitize = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
