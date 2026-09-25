#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 3 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Convert the earlier Sphinx documentation into the site's Markdown and setup registry.
"""One-shot migration: convert the old Sphinx docs (RST) into this site's Markdown.

Reads  : a clone of HippoCampusRobotics/docs (--src) and data/setup-structure.json
Writes : content/setup/<group>/<slug>.md, assets/setup/*, data/setup.json,
         docs/setup-parity.md
Run    : python3 tools/rst_convert.py --src /path/to/docs-clone

Not a runtime or deploy dependency — the converted Markdown is committed.
Stdlib only. Every construct it cannot convert is WARNED about, never dropped
silently; warnings are summarized at exit and per-page in the parity table.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUNCT = set('#*=-^"~+.`:\'_')
# Images are served from Cloudinary (see data/cloudinary-manifest.json); other
# downloads (.stl/.3mf/.pdf) stay local. Same set as the upload skill's imageExt
# and as IMAGE_EXTS in tools/check.py — widen all three together, or a format
# the converter treats as "not an image" sails past a gate that disagrees.
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp',
                  '.tiff', '.tif', '.avif', '.heic', '.heif'}
ADMONITIONS = {
    'note': 'Note', 'warning': 'Warning', 'attention': 'Attention',
    'hint': 'Hint', 'important': 'Important', 'tip': 'Tip', 'error': 'Error',
    'caution': 'Caution', 'danger': 'Danger', 'todo': 'To do',
    'seealso': 'See also',
}
CODE_ALIASES = {'console': 'console', 'sh': 'sh', 'bash': 'bash', 'shell': 'sh',
                'cpp': 'cpp', 'c++': 'cpp', 'python': 'python', 'py': 'python',
                'yaml': 'yaml', 'xml': 'xml', 'ini': 'ini', 'cmake': 'cmake',
                'text': 'text', 'none': 'text', '': 'text'}

warnings = []  # (page, message)


def warn(page, msg):
    warnings.append((page, msg))


def load_cloudinary_manifest():
    """site-relative source path -> hosted url. Tolerant on purpose: a missing
    or unreadable manifest means a pre-migration checkout, where every asset is
    simply local (exactly the old behaviour)."""
    try:
        data = json.loads((ROOT / 'data' / 'cloudinary-manifest.json')
                          .read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {a['source']: a['url'] for a in data.get('assets', [])
            if isinstance(a, dict) and a.get('source') and a.get('url')}


def slugify(text):
    """Heading anchor slugs — MUST match slugify() in js/app.js."""
    text = re.sub(r'[^\w\s-]', '', text.lower().strip())
    return re.sub(r'[\s_]+', '-', text).strip('-') or 'section'


def dedent_block(lines):
    indents = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
    if not indents:
        return []
    cut = min(indents)
    return [l[cut:] if l.strip() else '' for l in lines]


class Converter:
    def __init__(self, src, structure):
        self.src = src
        self.structure = structure
        self.old_to_new = {}   # old path (no .rst) -> "group/slug"
        for g in structure['groups']:
            for p in g['pages']:
                self.old_to_new[p['old']] = f"{g['id']}/{p['slug']}"
        self.dropped = {d['old'] for d in structure['dropped']}
        self.labels = {}       # explicit .. _label: -> (old_page, heading_text|None)
        self.page_titles = {}  # old page -> title
        self.assets = {}       # source Path -> emitted url (local or Cloudinary)
        self.asset_names = {}  # basename -> source Path (collision check)
        self.cloudinary = load_cloudinary_manifest()
        self.needs_upload = []  # images with no manifest entry yet

    # ---------- pre-pass: labels + titles over the whole corpus ----------
    def prepass(self):
        for rst in sorted(self.src.glob('contents/**/*.rst')) + [self.src / 'index.rst']:
            old = str(rst.relative_to(self.src)).removesuffix('.rst')
            lines = rst.read_text(encoding='utf-8').splitlines()
            pending = []
            title_seen = False
            for i, line in enumerate(lines):
                m = re.match(r'^\.\. _([^:]+):\s*$', line)
                if m:
                    pending.append(m.group(1).strip())
                    continue
                m = re.match(r'^\s+:name:\s+(\S+)\s*$', line)
                if m:  # :name: option on a directive — a numref/ref target
                    self.labels.setdefault(m.group(1), (old, None))
                    continue
                if self._is_heading_text(lines, i):
                    text = line.strip()
                    if not title_seen:
                        self.page_titles[old] = text
                        title_seen = True
                        target = None  # top of page
                    else:
                        target = text
                    for lab in pending:
                        self.labels[lab] = (old, target)
                    pending = []
                elif line.strip():
                    # a directive or paragraph absorbs pending labels (page-top anchor)
                    if not re.match(r'^\.\. _', line):
                        for lab in pending:
                            self.labels[lab] = (old, None)
                        pending = []

    @staticmethod
    def _is_heading_text(lines, i):
        """lines[i] is heading text if the next line is a punctuation underline."""
        if i + 1 >= len(lines):
            return False
        text, under = lines[i], lines[i + 1]
        if not text.strip() or text.startswith((' ', '\t', '..')):
            return False
        u = under.strip()
        return (len(u) >= 3 and len(set(u)) == 1 and u[0] in PUNCT
                and len(u) >= len(text.strip()) and not text.strip()[0] in PUNCT)

    # ---------- link resolution ----------
    def route_for_old(self, old, anchor_text=None):
        """Return a site href for an old page path, or the old-site URL if dropped."""
        old = old.strip('/').removesuffix('.rst')
        if old in self.old_to_new:
            href = f"#/setup/{self.old_to_new[old]}"
            if anchor_text:
                href += f"@{slugify(anchor_text)}"
            return href
        base = self.structure['source']['old_base_url']
        warn(self.page, f"link to unmigrated page '{old}' kept as old-site URL")
        return f"{base}/{old}.html"

    def resolve_ref(self, target, page):
        """:ref:`label` / :ref:`text <label>` / :ref:`doc/path:Heading`"""
        text = None
        m = re.match(r'^(.*)<([^<>]+)>\s*$', target)
        if m:
            text, target = m.group(1).strip(), m.group(2).strip()
        if ':' in target and '/' in target:            # autosectionlabel form
            doc, heading = target.rsplit(':', 1)
            href = self.route_for_old(doc, heading)
            return f"[{text or heading}]({href})"
        if target in self.labels:
            old, heading = self.labels[target]
            href = self.route_for_old(old, heading)
            label_text = text or heading or self.page_titles.get(old, target)
            return f"[{label_text}]({href})"
        warn(page, f"unresolved :ref:`{target}` — kept as plain text")
        return text or target

    # ---------- assets ----------
    def copy_asset(self, spec, page_old):
        """Copy an image/file into assets/setup; return the url to emit.

        Images are served from Cloudinary, so a copied image whose local path is
        in data/cloudinary-manifest.json emits the hosted URL instead (the local
        copy stays as the upload source and the fallback). Non-images and images
        not yet uploaded keep the local path; the latter are collected in
        self.needs_upload and printed loudly at the end of the run.
        """
        if spec.startswith('/'):
            src = self.src / spec.lstrip('/')
        else:
            src = (self.src / page_old).parent / spec
        src = src.resolve()
        if not src.exists():
            warn(self.page, f"asset not found: {spec}")
            return spec
        if src in self.assets:
            return self.assets[src]
        name = src.name
        if name in self.asset_names and self.asset_names[name] != src:
            name = f"{src.parent.name}-{name}"
        self.asset_names[name] = src
        dest = ROOT / 'assets' / 'setup' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        local = f"assets/setup/{name}"
        url = local
        if Path(name).suffix.lower() in IMAGE_SUFFIXES:
            hosted = self.cloudinary.get(local)
            if hosted:
                url = hosted
            elif name not in self.needs_upload:
                self.needs_upload.append(name)
        self.assets[src] = url
        return url

    def download_href(self, spec, page_old):
        """:download:`...` target — copy small local files, link big/binary to old site."""
        if spec.startswith(('http://', 'https://')):
            return spec
        if spec.startswith('/res/misc/') or spec.startswith('/res/manuals/'):
            # binaries / .debs / vendor manuals stay on the old site (logged decision)
            warn(self.page, f"download '{spec}' linked to old site (binary/vendor file not committed)")
            return self.structure['source']['old_base_url'] + spec
        return self.copy_asset(spec, page_old)

    # ---------- inline markup ----------
    def inline(self, text):
        page = self.page
        stash = []

        def keep(s):
            stash.append(s)
            return f"\x00{len(stash) - 1}\x00"

        # double-backtick literals first
        text = re.sub(r'``(.+?)``', lambda m: keep(f"`{m.group(1)}`"), text)
        # roles
        def role(m):
            name, body = m.group(1), m.group(2)
            if name in ('code', 'file', 'kbd', 'command', 'program', 'envvar'):
                return keep(f"`{body}`")
            if name == 'guilabel':
                return keep(f"**{body}**")
            if name == 'math':
                return keep(f"<span class=\"math\">`{body}`</span>")
            if name == 'ref' or name == 'numref':
                return keep(self.resolve_ref(body, page))
            if name == 'download':
                m2 = re.match(r'^(.*)<([^<>]+)>\s*$', body)
                if m2:
                    label, target = m2.group(1).strip(), m2.group(2).strip()
                else:
                    label, target = body, body
                return keep(f"[{label}]({self.download_href(target, self.page_old)})")
            if name == 'doc':
                return keep(self.resolve_ref(body if ':' in body else body.strip('/') + ':', page)
                            if False else f"[{body}]({self.route_for_old(body.strip('/'))})")
            warn(page, f"unknown role :{name}: kept as code")
            return keep(f"`{body}`")

        text = re.sub(r':([a-zA-Z0-9_+-]+):`([^`]+)`', role, text)
        # external links `text <url>`_ or `text <url>`__
        def ext_link(m):
            label, url = m.group(1).strip(), m.group(2).strip()
            if not re.match(r'^[a-z]+:', url) and re.match(r'^[\w.-]+\.[a-z]{2,}(/|$)', url):
                url = 'https://' + url   # scheme-less domain (old site had these too)
            return keep(f"[{label}]({url})")
        text = re.sub(r'`([^`<>]+?)\s*<([^`<>]+)>`__?', ext_link, text)
        # single-backtick interpreted text (default role) -> code
        text = re.sub(r'(?<!`)`([^`]+)`(?!`)(?!_)', lambda m: keep(f"`{m.group(1)}`"), text)
        # reference to a collected label:  Name_
        def named_ref(m):
            name = m.group(1)
            if name in self.labels:
                return keep(self.resolve_ref(name, page))
            return m.group(0)
        text = re.sub(r'\b([A-Za-z][\w.+-]*)_\b(?!_)', named_ref, text)
        # escape stray html
        text = text.replace('<', '&lt;').replace('>', '&gt;')
        # restore stash
        for i, s in enumerate(stash):
            text = text.replace(f"\x00{i}\x00", s)
        return text

    # ---------- block parsing ----------
    def convert_page(self, old, group_id, slug):
        self.page = f"{group_id}/{slug}"
        self.page_old = old + '.rst'
        rst = self.src / self.page_old
        lines = rst.read_text(encoding='utf-8').splitlines()
        self.heading_order = []          # per-page underline-char order -> level
        body = self.blocks(lines, top=True)
        # provenance footer
        old_url = f"{self.structure['source']['old_base_url']}/{old}.html"
        body += (f"\n\n<p class=\"provenance\">Migrated from the previous docs site: "
                 f"<a href=\"{old_url}\">{old}</a>.</p>\n")
        return body

    def heading_level(self, ch, has_over):
        key = (ch, has_over)
        if key not in self.heading_order:
            self.heading_order.append(key)
        return self.heading_order.index(key) + 1

    def blocks(self, lines, top=False):
        out = []
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            stripped = line.strip()
            if not stripped:
                out.append('')
                i += 1
                continue
            # ---- directive ----
            m = re.match(r'^\s*\.\.\s+([a-zA-Z0-9_-]+)::\s*(.*)$', line)
            if m:
                name, arg = m.group(1).lower(), m.group(2).strip()
                base_indent = len(line) - len(line.lstrip())
                j = i + 1
                block = []
                while j < n and (not lines[j].strip()
                                 or len(lines[j]) - len(lines[j].lstrip()) > base_indent):
                    block.append(lines[j])
                    j += 1
                opts, content = self.split_options(dedent_block(block))
                out.extend(self.directive(name, arg, opts, content))
                i = j
                continue
            # ---- explicit label / comment ----
            if re.match(r'^\s*\.\.($|\s)', line):
                base_indent = len(line) - len(line.lstrip())
                j = i + 1
                while j < n and (not lines[j].strip()
                                 or len(lines[j]) - len(lines[j].lstrip()) > base_indent):
                    j += 1
                i = j
                continue
            # ---- heading (with optional overline) ----
            over = (i > 0 and lines[i - 1].strip()
                    and len(set(lines[i - 1].strip())) == 1
                    and lines[i - 1].strip()[0] in PUNCT
                    and len(lines[i - 1].strip()) >= 3)
            if self._is_heading_text(lines, i):
                ch = lines[i + 1].strip()[0]
                level = self.heading_level(ch, over)
                text = self.inline(stripped)
                out.append(f"{'#' * min(level, 6)} {text}")
                out.append('')
                i += 2
                continue
            if (len(set(stripped)) == 1 and stripped[0] in PUNCT and len(stripped) >= 3):
                i += 1  # overline or stray rule
                continue
            # ---- grid table ----
            if re.match(r'^\s*\+[-=+]+\+\s*$', line):
                j = i
                tbl = []
                while j < n and (re.match(r'^\s*[+|]', lines[j]) and lines[j].strip()):
                    tbl.append(lines[j])
                    j += 1
                out.extend(self.grid_table(tbl))
                i = j
                continue
            # ---- bullet / enumerated list ----
            lm = re.match(r'^(\s*)([-*+]|\#\.|\d+[.)])\s+(.*)$', line)
            if lm:
                out.extend(self.list_block(lines, i))
                # list_block consumed until the first line it couldn't own
                i = self._list_end
                continue
            # ---- paragraph (maybe ending :: for a literal block) ----
            base_indent = len(line) - len(line.lstrip())
            para = [stripped]
            j = i + 1
            while j < n and lines[j].strip() and \
                    len(lines[j]) - len(lines[j].lstrip()) == base_indent and \
                    not re.match(r'^\s*([-*+]|\#\.|\d+[.)])\s', lines[j]) and \
                    not self._is_heading_text(lines, j) and \
                    not re.match(r'^\s*\.\.($|\s)', lines[j]) and \
                    not re.match(r'^\s*\+[-=+]+\+\s*$', lines[j]):
                para.append(lines[j].strip())
                j += 1
            text = ' '.join(para)
            literal_next = text.endswith('::')
            if literal_next:
                text = text[:-2].rstrip()
                if text:
                    text += ':'
            if text:
                out.append(self.inline(text))
                out.append('')
            i = j
            if literal_next:
                # consume following indented block as code
                block = []
                while i < n and (not lines[i].strip()
                                 or len(lines[i]) - len(lines[i].lstrip()) > base_indent):
                    block.append(lines[i])
                    i += 1
                code = dedent_block(block)
                while code and not code[-1].strip():
                    code.pop()
                if code:
                    out.append('```text')
                    out.extend(self.scrub_code(code))
                    out.append('```')
                    out.append('')
        return '\n'.join(out) if top else out

    def split_options(self, block):
        opts = {}
        i = 0
        while i < len(block):
            l = block[i]
            m = re.match(r'^:([a-zA-Z-]+):\s*(.*)$', l.strip())
            if m and not l.startswith('  :'):
                opts[m.group(1)] = m.group(2)
                i += 1
            elif not l.strip() and i == 0:
                i += 1
            else:
                break
        content = block[i:]
        while content and not content[0].strip():
            content.pop(0)
        return opts, content

    # ---------- directives ----------
    def scrub_code(self, lines):
        """Never republish credentials or personal key material, even when the
        old site did. Values become placeholders; each scrub is warned."""
        out, prev_placeholder = [], False
        for l in lines:
            m = re.match(r'^(\s*)(["\']?)(plain_text_passwd|password|passwd|pwd)(["\']?\s*[:=]\s*)(.+)$',
                         l, re.IGNORECASE)
            if m and not re.match(r'^[<$]|^["\']?(true|false|none|null)["\']?\s*$|^["\']{2}\s*$',
                                  m.group(5).strip(), re.IGNORECASE):
                # commented out on purpose: a copy-pasted example must FAIL until the
                # reader sets a real value — a live placeholder would itself be a
                # publicly documented working password.
                out.append(f"{m.group(1)}# {m.group(2)}{m.group(3)}{m.group(4)}\"<set-your-own-password>\"")
                warn(self.page, f"scrubbed literal {m.group(3)} value from a code block (line commented out)")
                prev_placeholder = False
                continue
            m = re.match(r'^(\s*(?:-\s+)?)ssh-(?:rsa|ed25519|ecdsa|dss)\s+[A-Za-z0-9+/=]{30,}.*$', l)
            if m:
                if not prev_placeholder:
                    out.append(f"{m.group(1)}<your-ssh-public-key>")
                    warn(self.page, "replaced a personal SSH public key with a placeholder")
                prev_placeholder = True
                continue
            prev_placeholder = False
            out.append(l)
        return out

    def directive(self, name, arg, opts, content):
        out = []
        if name in ('code-block', 'code', 'sourcecode', 'highlight'):
            lang = CODE_ALIASES.get(arg.lower(), arg.lower() or 'text')
            while content and not content[-1].strip():
                content = content[:-1]
            content = self.scrub_code(content)
            out += [f"```{lang}"] + content + ["```", '']
        elif name in ADMONITIONS:
            out.append(f'<div class="adm adm-{name}"><p class="adm-title">{ADMONITIONS[name]}</p>')
            out.append('')
            if arg:
                content = [arg, ''] + content
            out.extend(self.blocks(content))
            out += ['', '</div>', '']
        elif name in ('tabs', 'tab-set'):
            out.append('<div class="tabs">')
            out.append('')
            out.extend(self.blocks(content))
            out += ['', '</div>', '']
        elif name in ('tab', 'tab-item'):
            out.append(f'<div class="tab" data-label="{arg}">')
            out.append('')
            out.extend(self.blocks(content))
            out += ['', '</div>', '']
        elif name in ('code-tab',):
            parts = arg.split(None, 1)
            lang = CODE_ALIASES.get(parts[0].lower() if parts else '', 'text')
            label = parts[1] if len(parts) > 1 else (parts[0] if parts else 'tab')
            out.append(f'<div class="tab" data-label="{label}">')
            out.append('')
            while content and not content[-1].strip():
                content = content[:-1]
            content = self.scrub_code(content)
            out += [f"```{lang}"] + content + ["```"]
            out += ['', '</div>', '']
        elif name in ('figure', 'image'):
            url = self.copy_asset(arg, self.page_old)
            alt = opts.get('alt', Path(arg).stem.replace('_', ' '))
            out.append(f"![{alt}]({url})")
            if name == 'figure' and content:
                cap = ' '.join(l.strip() for l in content if l.strip())
                out.append('')
                out.append(f"<p class=\"figcaption\">{self.inline(cap)}</p>")
            out.append('')
        elif name == 'list-table':
            out.extend(self.list_table(arg, opts, content))
        elif name == 'table':
            # body is a grid table
            sub = [l for l in content if l.strip()]
            out.extend(self.grid_table(sub))
        elif name == 'container':
            if 'toggle' in arg:
                out.append('<details><summary>Details</summary>')
                out.append('')
                out.extend(self.blocks(content))
                out += ['', '</details>', '']
            else:
                out.extend(self.blocks(content))
        elif name == 'rubric':
            out += [f"**{self.inline(arg)}**", '']
        elif name == 'sectionauthor':
            pass  # personal emails are not copied onto the new site
        elif name == 'toctree':
            links = []
            for l in content:
                t = l.strip()
                if not t or t.startswith(':'):
                    continue
                target = re.sub(r'^/', '', t)
                if not target.startswith('contents/') and '/' not in target:
                    target = str(Path(self.page_old).parent / target)
                title = self.page_titles.get(target, Path(target).stem.replace('_', ' '))
                links.append(f"- [{title}]({self.route_for_old(target)})")
            if links:
                out += links + ['']
        elif name == 'math':
            out += ['```latex'] + content + ['```', '']
        elif name == 'only':
            out.extend(self.blocks(content))
        elif name in ('raw',):
            warn(self.page, f"raw directive ({arg}) dropped")
        elif name in ('asciinema',):
            base = self.structure['source']['old_base_url']
            out += [f"[Terminal recording on the old site]({base}/{Path(self.page_old).with_suffix('.html')})", '']
            warn(self.page, "asciinema recording linked to old site")
        else:
            warn(self.page, f"unhandled directive '{name}' rendered as code block")
            out += [f"```text", f".. {name}:: {arg}"] + content + ["```", '']
        return out

    def list_table(self, arg, opts, content):
        # rows: '* - cell' then '  - cell'
        rows, cur = [], None
        base = None
        for l in content:
            m = re.match(r'^(\s*)\*\s+-\s?(.*)$', l)
            if m:
                if cur is not None:
                    rows.append(cur)
                cur = [[m.group(2)]]
                base = len(m.group(1))
                continue
            m = re.match(r'^(\s*)-\s?(.*)$', l)
            if m and cur is not None and len(m.group(1)) > (base or 0):
                cur.append([m.group(2)])
                continue
            if cur is not None and l.strip():
                cur[-1].append(l.strip())
        if cur is not None:
            rows.append(cur)
        if not rows:
            return []
        has_image = any('image::' in c for row in rows for cell in row for c in cell)
        if has_image:
            out = ['<div class="img-grid">', '']
            for row in rows:
                for cell in row:
                    for c in cell:
                        m = re.match(r'^\s*\.\.\s+image::\s+(\S+)', c)
                        if m:
                            url = self.copy_asset(m.group(1), self.page_old)
                            out.append(f"![{Path(m.group(1)).stem}]({url})")
                            out.append('')
            out += ['</div>', '']
            return out
        header_rows = int(opts.get('header-rows', 0) or 0)
        md_rows = [[self.inline(' '.join(x.strip() for x in cell if x.strip())) or ' '
                    for cell in row] for row in rows]
        width = max(len(r) for r in md_rows)
        for r in md_rows:
            r += [' '] * (width - len(r))
        out = []
        if arg:
            out += [f"**{self.inline(arg)}**", '']
        if header_rows >= 1:
            head, body = md_rows[0], md_rows[1:]
        else:
            head, body = [' '] * width, md_rows
        out.append('| ' + ' | '.join(head) + ' |')
        out.append('|' + '---|' * width)
        for r in body:
            out.append('| ' + ' | '.join(r) + ' |')
        out.append('')
        return out

    def grid_table(self, tbl):
        """Parse a simple RST grid table into a Markdown table."""
        try:
            sep_rows = [k for k, l in enumerate(tbl) if re.match(r'^\s*\+[-=+]+\+\s*$', l)]
            header_sep = next((k for k, l in enumerate(tbl) if '=' in l and l.strip().startswith('+')), None)
            rows, cur = [], []
            for k, l in enumerate(tbl):
                if k in sep_rows:
                    if cur:
                        cells = [' '.join(p) for p in cur]
                        rows.append((cells, header_sep is not None and k <= header_sep))
                        cur = []
                    continue
                parts = [p.strip() for p in l.strip().strip('|').split('|')]
                if not cur:
                    cur = [[p] if p else [] for p in parts]
                else:
                    for idx, p in enumerate(parts[:len(cur)]):
                        if p:
                            cur[idx].append(p)
            if not rows:
                raise ValueError('no rows')
            width = max(len(r) for r, _ in rows)
            out = []
            head = rows[0][0] if rows[0][1] or header_sep else [' '] * width
            body = rows[1:] if (rows[0][1] or header_sep) else rows
            head += [' '] * (width - len(head))
            out.append('| ' + ' | '.join(self.inline(c) for c in head) + ' |')
            out.append('|' + '---|' * width)
            for r, _ in body:
                r = r + [' '] * (width - len(r))
                out.append('| ' + ' | '.join(self.inline(c) for c in r) + ' |')
            out.append('')
            return out
        except Exception as e:  # never lose content
            warn(self.page, f"grid table kept as preformatted block ({e})")
            return ['```text'] + tbl + ['```', '']

    def list_block(self, lines, i):
        out = []
        n = len(lines)
        m0 = re.match(r'^(\s*)([-*+]|\#\.|\d+[.)])\s+', lines[i])
        indent = len(m0.group(1))
        ordered = m0.group(2) not in '-*+'
        counter = 0
        while i < n:
            line = lines[i]
            if not line.strip():
                # blank — belongs to list if a further item/continuation follows
                k = i
                while k < n and not lines[k].strip():
                    k += 1
                if k < n and (len(lines[k]) - len(lines[k].lstrip()) > indent
                              or re.match(r'^(\s{%d})([-*+]|\#\.|\d+[.)])\s+' % indent, lines[k])):
                    out.append('')
                    i = k
                    continue
                break
            cur_indent = len(line) - len(line.lstrip())
            m = re.match(r'^(\s*)([-*+]|\#\.|\d+[.)])\s+(.*)$', line)
            if m and cur_indent == indent:
                counter += 1
                marker = f"{counter}." if ordered else '-'
                # collect the item's own block (continuation lines indented deeper)
                item = [m.group(3)]
                j = i + 1
                while j < n and (not lines[j].strip()
                                 or len(lines[j]) - len(lines[j].lstrip()) > indent):
                    item.append(lines[j])
                    j += 1
                first, *rest = item
                rest = dedent_block(rest)
                inner = self.blocks([first] + rest)
                pad = ' ' * 4
                text_lines = []
                for k, l in enumerate(inner):
                    if k == 0:
                        text_lines.append(f"{marker} {l}")
                    else:
                        text_lines.append(f"{pad}{l}" if l else '')
                out.extend(text_lines)
                i = j
            elif cur_indent > indent:
                # stray continuation (shouldn't happen; handled per-item)
                i += 1
            else:
                break
        out.append('')
        self._list_end = i
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, type=Path)
    args = ap.parse_args()

    structure = json.loads((ROOT / 'data' / 'setup-structure.json').read_text())
    conv = Converter(args.src.resolve(), structure)
    conv.prepass()

    manifest = {'sections': []}
    parity = []
    for g in structure['groups']:
        sec = {'id': g['id'], 'title': g['title'], 'pages': []}
        for p in g['pages']:
            pid = f"{g['id']}/{p['slug']}"
            dest = ROOT / 'content' / 'setup' / g['id'] / f"{p['slug']}.md"
            old_url = f"{structure['source']['old_base_url']}/{p['old']}.html"
            title = conv.page_titles.get(p['old'], p['slug'].replace('-', ' ').title())
            if p.get('manual'):
                if not dest.exists():
                    warn(pid, 'manual page missing — write it by hand')
                title = 'Setup'
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                md = conv.convert_page(p['old'], g['id'], p['slug']).lstrip()
                if not md.startswith('# '):
                    # a page whose RST had no title heading — prepend one
                    md = f"# {title}\n\n{md}"
                dest.write_text(md, encoding='utf-8')
            sec['pages'].append({'id': pid, 'title': title,
                                 'file': str(dest.relative_to(ROOT)),
                                 'old': p['old'], 'old_url': old_url,
                                 **({'note': p['note']} if p.get('note') else {})})
            parity.append((p['old'], f"migrated -> #/setup/{pid}", p.get('note', '')))
        manifest['sections'].append(sec)
    reason = structure['dropped_reason_default']
    for d in structure['dropped']:
        parity.append((d['old'], 'dropped', d.get('reason', reason)))

    (ROOT / 'data' / 'setup.json').write_text(
        json.dumps(manifest, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')

    # parity table (done-bar 2 artifact)
    migrated = sum(1 for _, s, _ in parity if s.startswith('migrated'))
    dropped = sum(1 for _, s, _ in parity if s == 'dropped')
    lines = [
        '# Setup parity table',
        '',
        f"*Generated by `tools/rst_convert.py` — do not edit by hand. Source: "
        f"{structure['source']['repo']} cloned {structure['source']['commit_date_cloned']}.*",
        '',
        f"**Pages found: {len(parity)} · migrated: {migrated} · dropped: {dropped}**",
        '',
        'Old pages are relative to the old site root '
        f"({structure['source']['old_base_url']}/<page>.html).",
        '',
        '| Old page | Disposition | Note |',
        '|---|---|---|',
    ]
    for old, status, note in parity:
        lines.append(f"| `{old}` | {status} | {note} |")
    per_page = {}
    for pg, msg in warnings:
        per_page.setdefault(pg, []).append(msg)
    if per_page:
        lines += ['', '## Conversion warnings (per page)', '']
        for pg in sorted(per_page):
            for msg in per_page[pg]:
                lines.append(f"- `{pg}`: {msg}")
    (ROOT / 'docs' / 'setup-parity.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print(f"pages: {len(parity)}  migrated: {migrated}  dropped: {dropped}")
    print(f"assets copied: {len(conv.assets)}")
    if conv.needs_upload:
        print('')
        print('!' * 70)
        print(f"{len(conv.needs_upload)} new images need upload — run the Phase A "
              f"upload step:")
        for n in conv.needs_upload:
            print(f"  assets/setup/{n}")
        print("Until they are uploaded and added to data/cloudinary-manifest.json,")
        print("tools/check.py will fail on the local image references above.")
        print('!' * 70)
        print('')
    print(f"warnings: {len(warnings)}")
    for pg, msg in warnings[:40]:
        print(f"  {pg}: {msg}")
    if len(warnings) > 40:
        print(f"  ... and {len(warnings) - 40} more (see docs/setup-parity.md)")


if __name__ == '__main__':
    main()
