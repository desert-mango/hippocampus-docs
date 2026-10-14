// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: A small HTML parser and DOM for node tests of browser code that walks a DOM (sanitizer, editor serializer).
/* The DOM shim the node tests share. Node has no DOMParser, and the browser code must not grow a
   node-only path, so a test installs this SMALL HTML parser + serializer as globalThis.DOMParser and
   runs the unmodified browser code against it. It is a test fixture, not a second HTML parser for
   the site: it knows void and raw-text elements, quoted and unquoted attributes, character
   references (including the `&colon;` / `&#x09;` tricks), comments, the svg/math namespaces and the
   one implied end tag (`<p>` closed by a block) that marked's output needs. Serialization follows
   the HTML spec's escaping rules (text: & < > and U+00A0; attribute values: & " and U+00A0), which
   is what `innerHTML` does in every browser. Moved here from test_sanitize.mjs (2026-10-14) so the
   editor serializer's tests (test_editor_md.mjs) run on the same shim. */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'source', 'track', 'wbr', 'param']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed',
  'noframes']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', Tab: '\t',
  NewLine: '\n', sol: '/', lpar: '(', rpar: ')', period: '.', comma: ',', excl: '!', num: '#',
};

function decode(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);?/g, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X'
        ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code) : '\ufffd';
    }
    if (Object.prototype.hasOwnProperty.call(NAMED, ref)) {
      const legacy = ['amp', 'lt', 'gt', 'quot'].includes(ref);
      return (m.endsWith(';') || legacy) ? NAMED[ref] : m;
    }
    return m;
  });
}

class ShimNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (at < 0) throw new Error('insertBefore: ref is not a child');
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const at = this.childNodes.indexOf(node);
    if (at < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(at, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

class ShimText extends ShimNode {
  constructor(data) { super(3); this.data = data; }
  get nodeValue() { return this.data; }
  get textContent() { return this.data; }
}

class ShimComment extends ShimNode {
  constructor(data) { super(8); this.data = data; }
}

class ShimElement extends ShimNode {
  constructor(localName, namespaceURI) {
    super(1);
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this._attrs = [];
  }
  get nodeName() { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  get tagName() { return this.nodeName; }
  get attributes() { return this._attrs; }
  getAttribute(name) {
    const a = this._attrs.find((x) => x.name === name);
    return a ? a.value : null;
  }
  hasAttribute(name) { return this._attrs.some((x) => x.name === name); }
  setAttribute(name, value) {
    const a = this._attrs.find((x) => x.name === name);
    if (a) a.value = String(value); else this._attrs.push({ name, value: String(value) });
  }
  removeAttribute(name) { this._attrs = this._attrs.filter((x) => x.name !== name); }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  get textContent() { return this.childNodes.filter((c) => c.nodeType !== 8).map((c) => c.textContent).join(''); }
}

function escText(s) {
  return s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/"/g, '&quot;');
}
function serialize(node) {
  if (node.nodeType === 3) {
    const p = node.parentNode;
    const raw = p && p.nodeType === 1 && ['script', 'style', 'xmp', 'iframe', 'noembed',
      'noframes'].includes(p.localName);
    return raw ? node.data : escText(node.data);
  }
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  const attrs = node.attributes.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('');
  if (node.namespaceURI === HTML_NS && VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.innerHTML}</${node.localName}>`;
}

function parseHTML(html) {
  const body = new ShimElement('body', HTML_NS);
  const stack = [body];
  const top = () => stack[stack.length - 1];
  const addText = (s) => {
    if (!s) return;
    const parent = top();
    const last = parent.childNodes[parent.childNodes.length - 1];
    if (last && last.nodeType === 3) last.data += s;
    else parent.appendChild(new ShimText(s));
  };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? html.length : end;
      top().appendChild(new ShimComment(html.slice(i + 4, stop)));
      i = end < 0 ? html.length : end + 3;
    } else if (html[i] === '<' && html[i + 1] === '!') {
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;             // doctype / bogus comment
    } else if (html[i] === '<' && html[i + 1] === '/' && /[A-Za-z]/.test(html[i + 2] || '')) {
      const m = /^<\/([A-Za-z][^\s/>]*)[^>]*>?/.exec(html.slice(i));
      const name = m[1].toLowerCase();
      i += m[0].length;
      for (let d = stack.length - 1; d > 0; d -= 1) {
        if (stack[d].localName === name) { stack.length = d; break; }
      }
    } else if (html[i] === '<' && /[A-Za-z]/.test(html[i + 1] || '')) {
      let j = i + 1;
      while (j < html.length && !/[\s/>]/.test(html[j])) j += 1;
      const name = html.slice(i + 1, j).toLowerCase();
      const attrs = [];
      for (;;) {
        while (j < html.length && /[\s/]/.test(html[j])) j += 1;
        if (j >= html.length || html[j] === '>') { j += 1; break; }
        let k = j;
        while (k < html.length && !/[\s/>=]/.test(html[k])) k += 1;
        if (k === j) k += 1;                            // a stray '=' starts a name
        const attrName = html.slice(j, k).toLowerCase();
        j = k;
        while (j < html.length && /\s/.test(html[j])) j += 1;
        let value = '';
        if (html[j] === '=') {
          j += 1;
          while (j < html.length && /\s/.test(html[j])) j += 1;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            const stop = end < 0 ? html.length : end;
            value = html.slice(j + 1, stop);
            j = stop + 1;
          } else {
            let e = j;
            while (e < html.length && !/[\s>]/.test(html[e])) e += 1;
            value = html.slice(j, e);
            j = e;
          }
        }
        if (!attrs.some((a) => a.name === attrName)) attrs.push({ name: attrName, value: decode(value) });
      }
      const parentNs = top().namespaceURI;
      const ns = name === 'svg' ? SVG_NS : name === 'math' ? MATHML_NS
        : (parentNs === SVG_NS || parentNs === MATHML_NS) ? parentNs : HTML_NS;
      if (ns === HTML_NS && CLOSES_P.has(name) && top().localName === 'p') stack.pop();
      const el = new ShimElement(name, ns);
      attrs.forEach((a) => el.setAttribute(a.name, a.value));
      top().appendChild(el);
      i = j;
      if (ns === HTML_NS && RAW_TEXT.has(name)) {
        const close = html.toLowerCase().indexOf(`</${name}`, i);
        const stop = close < 0 ? html.length : close;
        const raw = html.slice(i, stop);
        if (raw) el.appendChild(new ShimText(name === 'textarea' || name === 'title' ? decode(raw) : raw));
        const gt = close < 0 ? -1 : html.indexOf('>', close);
        i = gt < 0 ? html.length : gt + 1;
      } else if (!(ns === HTML_NS && VOID.has(name))) {
        stack.push(el);
      }
    } else {
      const next = html.indexOf('<', i + 1);
      const stop = next < 0 ? html.length : next;
      addText(decode(html.slice(i, stop)));
      i = stop;
    }
  }
  return { body };
}

class ShimDOMParser {
  parseFromString(html, type) {
    if (type !== 'text/html') throw new Error('the sanitizer must parse as text/html');
    return parseHTML(String(html));
  }
}

export { HTML_NS, SVG_NS, MATHML_NS, VOID, decode, ShimNode, ShimText, ShimComment, ShimElement, escText, escAttr, serialize, parseHTML, ShimDOMParser };
