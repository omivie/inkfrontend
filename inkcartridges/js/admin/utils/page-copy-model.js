/**
 * PAGE-COPY-MODEL.JS
 * ==================
 * Parse / serialize the editable regions of the static content pages
 * (html/about.html, terms, privacy, returns, shipping, faq,
 * genuine-vs-compatible) into a small, closed block model.
 *
 * WHY A HAND-WRITTEN SCANNER AND NOT THE DOM
 * ------------------------------------------
 * Two reasons, both load-bearing.
 *
 * 1. This module is the shared contract between the admin editor (browser)
 *    and the save-time guard (node --test today, the backend commit endpoint
 *    tomorrow). A DOM-dependent parser could not run in either of the latter.
 *
 * 2. contentEditable and innerHTML are *lossy* against this markup in ways
 *    that would degrade the pages one save at a time:
 *      - RichTextEditor.sanitizeHTML() strips every `class` attribute and
 *        unwraps attribute-less <span>s, which destroys div.policy-callout.
 *      - Any innerHTML round-trip decodes `&rsquo;` / `&sect;` / `&ndash;` to
 *        literal characters and re-orders / re-quotes attributes.
 *    So the editor never serializes from `editor.innerHTML`. It serializes
 *    from THIS model, which preserves text runs — entities and all — byte for
 *    byte, and only ever normalises whitespace *between* and *inside* blocks.
 *
 * THE CANONICAL FORM
 * ------------------
 * serializeRegion(parseRegion(x)) is idempotent, and is asserted byte-identical
 * against every editable region of the shipped pages by
 * tests/page-copy-editor-jul2026.test.js. That is what keeps a real copy edit's
 * diff down to the sentence that changed instead of a whole-file reflow.
 *
 * The canonical form is deliberately minimal:
 *   - one block per line, indented to the block indent
 *   - list items one per line, indented one step further
 *   - inline whitespace collapsed to single spaces, block edges trimmed
 *   - text runs otherwise VERBATIM (entities preserved, never decoded)
 *   - attributes re-emitted in source order, double-quoted
 *
 * FAIL CLOSED
 * -----------
 * parseRegion returns `null` for anything it cannot classify. A null region is
 * rendered read-only by the editor with an explanation. It is never "parsed as
 * best we can and written back" — that is precisely how a markup-mangling bug
 * ships silently. Unknown tag, unknown class, stray text at block level,
 * unbalanced markup: all null.
 */

/* ─────────────────────────── vocabulary ─────────────────────────── */

/** Elements with no closing tag. */
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);

/** Inline elements allowed inside an editable block. */
const INLINE_TAGS = new Set(['strong', 'em', 'u', 'a', 'br', 'span', 'small', 'sup', 'sub', 'abbr', 'code']);

/**
 * Block-level elements we understand well enough to round-trip and edit.
 * Anything outside this set nullifies the region.
 */
const EDITABLE_BLOCK_TAGS = new Set(['p', 'h3', 'ul', 'ol', 'div']);

/**
 * Block-level elements we can round-trip byte-exactly but will never let the
 * owner edit: they carry structure the block model cannot express (definition
 * lists of bound facts, data tables, inline SVG cards, FAQ accordions,
 * postal addresses). They serialize verbatim from source and are presented
 * read-only. Their presence does NOT nullify the region — the rest of it
 * stays editable.
 */
const VERBATIM_BLOCK_TAGS = new Set(['address', 'dl', 'table', 'figure', 'blockquote', 'details', 'svg']);

/** `class` values permitted on an editable block. Anything else → null. */
const ALLOWED_BLOCK_CLASSES = new Set([
    'legal-page__disambiguation',
    'about-business-details__verify',
    'policy-callout',
    'policy-callout policy-callout--ok',
    'policy-callout policy-callout--warn',
    'policy-callout__title',
]);

/**
 * `class` values that mark a <div> as a verbatim (read-only) block rather than
 * a callout. These wrap structures the model does not model.
 */
const VERBATIM_DIV_CLASSES = new Set([
    'about-values',
    'policy-table-wrap',
    'faq-list',
    'about-business-details',
]);

/* ─────────────────────────── entities ─────────────────────────── */

/**
 * Text is DECODED on parse and RE-ENCODED on serialize, using this table.
 *
 * This is not cosmetic. There are two ways text reaches the model — read from
 * the file (where `’` is written `&rsquo;`) and read from contentEditable
 * (which hands back the literal character) — and they must converge on the
 * same bytes, or the same sentence would serialize differently depending on
 * whether the owner happened to touch that paragraph.
 *
 * The direction matters too: the shipped files use named entities throughout,
 * and tests/genuine-vs-compatible-warranty.test.js normalises `&rsquo;` before
 * matching its vetted sentences. Writing a literal `’` there would leave the
 * page reading identically and turn CI red. So the canonical form is the
 * entity, and every literal is encoded on the way out.
 *
 * Keep this table bijective. A character mapped to an entity here must decode
 * back to exactly that character, or serialize(parse(x)) stops converging.
 */
const ENTITY_TO_CHAR = {
    // nbsp is written as an escape on purpose: a literal U+00A0 here is invisible
    // in an editor and indistinguishable from a plain space — and if it ever got
    // typo'd into one, encodeText() would rewrite EVERY space on the site as &nbsp;.
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
    ndash: '–', mdash: '—', hellip: '…', sect: '§',
    copy: '©', reg: '®', trade: '™', deg: '°',
    times: '×', minus: '−', middot: '·', bull: '•',
    para: '¶', dagger: '†', permil: '‰', prime: '′',
    frac12: '½', frac14: '¼', pound: '£', euro: '€',
};

/**
 * Characters we write back as named entities, longest-lived first. `&` MUST be
 * encoded before anything else or we would double-escape our own output.
 */
const CHAR_TO_ENTITY = (() => {
    const map = new Map();
    // `apos` and `quot` are deliberately omitted. A bare ' or " needs no escaping
    // in text, and encoding them would rewrite punctuation the pages already ship
    // as literals — churn in every diff for no correctness gain. The one place a
    // " genuinely must be escaped is inside a double-quoted attribute, which
    // encodeAttrValue() handles on its own.
    for (const [name, ch] of Object.entries(ENTITY_TO_CHAR)) {
        if (name === 'apos' || name === 'quot') continue;
        if (!map.has(ch)) map.set(ch, name);
    }
    return map;
})();

/** Decode named and numeric character references. Unknown names pass through. */
function decodeEntities(text) {
    return String(text)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => (
            Object.prototype.hasOwnProperty.call(ENTITY_TO_CHAR, name) ? ENTITY_TO_CHAR[name] : m
        ));
}

/** Encode a decoded text run back to canonical named entities. */
function encodeText(text) {
    let out = String(text).replace(/&/g, '&amp;');
    for (const [ch, name] of CHAR_TO_ENTITY) {
        if (ch === '&') continue;                       // already done, and doing it again would nest
        out = out.split(ch).join(`&${name};`);
    }
    return out;
}

/** Encode an attribute value for a double-quoted attribute. */
function encodeAttrValue(value) {
    return encodeText(value).replace(/"/g, '&quot;');
}

/* ─────────────────────────── scanner ─────────────────────────── */

/**
 * Split `html` into tokens, respecting quoted attribute values so a `>` inside
 * an attribute cannot terminate a tag early. Returns null on malformed input.
 *
 * Token shapes:
 *   { type:'text',    raw, start, end }
 *   { type:'comment', raw, start, end }
 *   { type:'open'|'close'|'self', name, attrsRaw, raw, start, end }
 */
function tokenize(html) {
    const tokens = [];
    let i = 0;

    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) {
            tokens.push({ type: 'text', raw: html.slice(i), start: i, end: html.length });
            break;
        }
        if (lt > i) tokens.push({ type: 'text', raw: html.slice(i, lt), start: i, end: lt });

        if (html.startsWith('<!--', lt)) {
            const close = html.indexOf('-->', lt);
            if (close === -1) return null;
            tokens.push({ type: 'comment', raw: html.slice(lt, close + 3), start: lt, end: close + 3 });
            i = close + 3;
            continue;
        }
        // Doctypes / processing instructions have no business inside a region.
        if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) return null;

        let j = lt + 1;
        let quote = null;
        while (j < html.length) {
            const c = html[j];
            if (quote) {
                if (c === quote) quote = null;
            } else if (c === '"' || c === "'") {
                quote = c;
            } else if (c === '>') {
                break;
            }
            j++;
        }
        if (j >= html.length) return null;   // unterminated tag

        const raw = html.slice(lt, j + 1);
        const inner = raw.slice(1, -1).trim();
        const isClose = inner.startsWith('/');
        const isSelf = inner.endsWith('/');
        const body = inner.replace(/^\//, '').replace(/\/$/, '').trim();
        const m = /^([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(body);
        if (!m) return null;

        tokens.push({
            type: isClose ? 'close' : (isSelf ? 'self' : 'open'),
            name: m[1].toLowerCase(),
            attrsRaw: m[2].trim(),
            raw,
            start: lt,
            end: j + 1,
        });
        i = j + 1;
    }

    return tokens;
}

/**
 * Parse an attribute string into an ordered list of { name, value }.
 * Valueless attributes (e.g. `hidden`) carry value === null.
 * Returns null if the string cannot be parsed cleanly.
 */
function parseAttrs(attrsRaw) {
    const out = [];
    if (!attrsRaw) return out;

    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let consumed = 0;
    let m;
    while ((m = re.exec(attrsRaw)) !== null) {
        // Anything between matches that isn't whitespace means we mis-parsed.
        if (attrsRaw.slice(consumed, m.index).trim() !== '') return null;
        consumed = m.index + m[0].length;
        const value = m[2] !== undefined ? m[2]
            : m[3] !== undefined ? m[3]
                : m[4] !== undefined ? m[4]
                    : null;
        out.push({ name: m[1].toLowerCase(), value });
    }
    if (attrsRaw.slice(consumed).trim() !== '') return null;
    return out;
}

/** Re-emit attributes in source order, double-quoted and entity-encoded. */
function serializeAttrs(attrs) {
    if (!attrs || !attrs.length) return '';
    return ' ' + attrs
        .map(a => (a.value === null ? a.name : `${a.name}="${encodeAttrValue(a.value)}"`))
        .join(' ');
}

/** Look up one attribute value, or null. */
function attr(node, name) {
    const found = (node.attrs || []).find(a => a.name === name);
    return found ? found.value : null;
}

/**
 * Build a tree from tokens. Returns null on any unbalanced or stray close tag —
 * we would rather refuse the region than guess at the author's intent.
 */
function buildTree(tokens, source) {
    const root = { type: 'root', children: [] };
    const stack = [root];

    for (const t of tokens) {
        const top = stack[stack.length - 1];

        if (t.type === 'text' || t.type === 'comment') {
            top.children.push({ type: t.type, raw: t.raw, start: t.start, end: t.end });
            continue;
        }

        if (t.type === 'close') {
            // Only ever close the element actually open. Mismatch → refuse.
            if (top.type !== 'element' || top.name !== t.name) return null;
            top.end = t.end;
            top.innerEnd = t.start;
            stack.pop();
            continue;
        }

        const attrs = parseAttrs(t.attrsRaw);
        if (attrs === null) return null;

        const el = {
            type: 'element',
            name: t.name,
            attrs,
            children: [],
            start: t.start,
            innerStart: t.end,
            innerEnd: t.end,
            end: t.end,
            selfClosing: t.type === 'self' || VOID_TAGS.has(t.name),
        };
        top.children.push(el);
        if (!el.selfClosing) stack.push(el);
    }

    if (stack.length !== 1) return null;   // something never closed
    root.source = source;
    return root;
}

/** True when a node is text consisting only of whitespace. */
function isBlank(node) {
    return node.type === 'text' && node.raw.trim() === '';
}

/* ─────────────────────────── inline model ─────────────────────────── */

/**
 * Convert child nodes into inline model nodes. Returns null if any child is a
 * block-level element or an inline tag outside the allowlist.
 *
 * Text runs are stored DECODED, and attribute values with them. See the entity
 * table above: the file says `&rsquo;` and contentEditable says `’`, so the
 * model normalises to the character and serialize() puts the entity back. Both
 * input paths then produce identical bytes.
 */
function toInline(children) {
    const out = [];
    for (const node of children) {
        if (node.type === 'comment') return null;
        if (node.type === 'text') {
            out.push({ type: 'text', raw: decodeEntities(node.raw) });
            continue;
        }
        if (node.type !== 'element') return null;
        if (!INLINE_TAGS.has(node.name)) return null;

        const attrs = (node.attrs || []).map(a => ({
            name: a.name,
            value: a.value === null ? null : decodeEntities(a.value),
        }));
        if (node.selfClosing) {
            out.push({ type: 'element', name: node.name, attrs, children: [], void: true });
            continue;
        }
        const kids = toInline(node.children);
        if (kids === null) return null;
        out.push({ type: 'element', name: node.name, attrs, children: kids });
    }
    return out;
}

/** Serialize inline nodes, collapsing whitespace runs to a single space. */
function serializeInline(nodes) {
    let out = '';
    for (const n of nodes) {
        if (n.type === 'text') {
            // Collapse ASCII whitespace only, then encode. `\s` also matches
            // U+00A0 in JavaScript, so collapsing with it would silently eat the
            // very non-breaking spaces an author inserted on purpose.
            out += encodeText(n.raw.replace(/[ \t\n\r\f\v]+/g, ' '));
        } else if (n.void) {
            out += `<${n.name}${serializeAttrs(n.attrs)}>`;
        } else {
            out += `<${n.name}${serializeAttrs(n.attrs)}>${serializeInline(n.children)}</${n.name}>`;
        }
    }
    return out;
}

/** Serialize inline nodes and trim the block's outer edges. */
function serializeInlineBlock(nodes) {
    return serializeInline(nodes).trim();
}

/** Walk inline nodes, calling `fn` for every element. */
function walkInline(nodes, fn) {
    for (const n of nodes) {
        if (n.type !== 'element') continue;
        fn(n);
        if (n.children) walkInline(n.children, fn);
    }
}

/** The plain text of an inline tree, with entities left encoded. */
function inlineText(nodes) {
    let out = '';
    for (const n of nodes) {
        if (n.type === 'text') out += n.raw;
        else if (n.children) out += inlineText(n.children);
    }
    return out;
}

/* ─────────────────────────── block model ─────────────────────────── */

/** The `class` attribute of an element, or '' — normalised for comparison. */
function classOf(el) {
    return (attr(el, 'class') || '').trim().replace(/\s+/g, ' ');
}

/**
 * Classify one block-level element. Returns a block, or null to nullify the
 * whole region.
 *
 * Block shapes:
 *   { type:'paragraph',  className, inline }
 *   { type:'subheading', inline }
 *   { type:'list',       ordered, items:[inline] }
 *   { type:'callout',    className, title:inline|null, body:[inline] }
 *   { type:'verbatim',   raw }                      — read-only, byte-exact
 */
function classifyBlock(el, source) {
    const cls = classOf(el);

    if (VERBATIM_BLOCK_TAGS.has(el.name)) {
        return { type: 'verbatim', raw: source.slice(el.start, el.end) };
    }

    if (!EDITABLE_BLOCK_TAGS.has(el.name)) return null;

    if (el.name === 'div') {
        if (VERBATIM_DIV_CLASSES.has(cls)) {
            return { type: 'verbatim', raw: source.slice(el.start, el.end) };
        }
        if (!cls.startsWith('policy-callout')) return null;
        if (!ALLOWED_BLOCK_CLASSES.has(cls)) return null;

        let title = null;
        const body = [];
        for (const child of el.children) {
            if (isBlank(child)) continue;
            if (child.type !== 'element' || child.name !== 'p') return null;
            const inline = toInline(child.children);
            if (inline === null) return null;
            const childCls = classOf(child);
            if (childCls === 'policy-callout__title') {
                if (title !== null) return null;     // two titles → we don't model it
                title = inline;
            } else if (childCls === '') {
                body.push(inline);
            } else {
                return null;
            }
        }
        return { type: 'callout', className: cls, title, body };
    }

    if (el.name === 'ul' || el.name === 'ol') {
        if (cls !== '') return null;
        const items = [];
        for (const child of el.children) {
            if (isBlank(child)) continue;
            if (child.type !== 'element' || child.name !== 'li') return null;
            if (classOf(child) !== '') return null;
            const inline = toInline(child.children);
            if (inline === null) return null;
            items.push(inline);
        }
        if (!items.length) return null;
        return { type: 'list', ordered: el.name === 'ol', items };
    }

    if (el.name === 'h3') {
        if (cls !== '') return null;
        const inline = toInline(el.children);
        if (inline === null) return null;
        return { type: 'subheading', inline };
    }

    // <p>
    if (cls !== '' && !ALLOWED_BLOCK_CLASSES.has(cls)) return null;
    const inline = toInline(el.children);
    if (inline === null) return null;
    return { type: 'paragraph', className: cls, inline };
}

/**
 * Parse a region's inner HTML (everything inside <section> after its <h2>)
 * into blocks. Returns null when the markup falls outside the model.
 */
function parseRegion(html) {
    if (typeof html !== 'string') return null;

    const tokens = tokenize(html);
    if (tokens === null) return null;

    const tree = buildTree(tokens, html);
    if (tree === null) return null;

    const blocks = [];
    for (const node of tree.children) {
        if (isBlank(node)) continue;
        if (node.type === 'text') return null;      // stray prose outside a block
        if (node.type === 'comment') return null;   // we don't round-trip comments
        const block = classifyBlock(node, html);
        if (block === null) return null;
        blocks.push(block);
    }
    if (!blocks.length) return null;
    return blocks;
}

/**
 * Render blocks back to HTML in canonical form.
 * @param {Array} blocks
 * @param {number} indent  Column the blocks sit at (spaces).
 */
function serializeRegion(blocks, indent) {
    const pad = ' '.repeat(indent);
    const pad2 = ' '.repeat(indent + 4);
    const lines = [];

    for (const b of blocks) {
        if (b.type === 'verbatim') {
            // Byte-exact, including its own internal indentation.
            lines.push(pad + b.raw);
            continue;
        }
        if (b.type === 'paragraph') {
            const cls = b.className ? ` class="${b.className}"` : '';
            lines.push(`${pad}<p${cls}>${serializeInlineBlock(b.inline)}</p>`);
            continue;
        }
        if (b.type === 'subheading') {
            lines.push(`${pad}<h3>${serializeInlineBlock(b.inline)}</h3>`);
            continue;
        }
        if (b.type === 'list') {
            const tag = b.ordered ? 'ol' : 'ul';
            lines.push(`${pad}<${tag}>`);
            for (const item of b.items) lines.push(`${pad2}<li>${serializeInlineBlock(item)}</li>`);
            lines.push(`${pad}</${tag}>`);
            continue;
        }
        if (b.type === 'callout') {
            lines.push(`${pad}<div class="${b.className}">`);
            if (b.title) lines.push(`${pad2}<p class="policy-callout__title">${serializeInlineBlock(b.title)}</p>`);
            for (const p of b.body) lines.push(`${pad2}<p>${serializeInlineBlock(p)}</p>`);
            lines.push(`${pad}</div>`);
            continue;
        }
        throw new Error(`page-copy-model: unknown block type "${b.type}"`);
    }

    return lines.join('\n');
}

/* ─────────────────────────── document surgery ─────────────────────────── */

/**
 * Locate every `<section class="policy-section" id="…">` in a full page.
 *
 * Returns [{ id, heading, indent, innerStart, innerEnd, bodyStart, bodyEnd }]
 * where `bodyStart..bodyEnd` is the editable extent — everything after the
 * leading <h2> and before </section>.
 *
 * The <h2> is deliberately OUTSIDE the editable extent: buildTOC() in
 * js/legal-page.js derives the whole table of contents from
 * `.policy-section[id] > h2`, and the section ids are public deep-link
 * fragments. Neither may move.
 */
function findSections(html) {
    const out = [];
    const re = /([ \t]*)<section class="policy-section" id="([a-z0-9-]+)"\s*>/g;
    let m;

    while ((m = re.exec(html)) !== null) {
        const indentStr = m[1];
        const id = m[2];
        const openEnd = m.index + m[0].length;

        // Balanced scan for this section's </section>.
        const tokens = tokenize(html.slice(openEnd));
        if (tokens === null) continue;
        let depth = 0;
        let innerEnd = -1;
        for (const t of tokens) {
            if (t.type === 'open' && t.name === 'section') depth++;
            else if (t.type === 'close' && t.name === 'section') {
                if (depth === 0) { innerEnd = openEnd + t.start; break; }
                depth--;
            }
        }
        if (innerEnd === -1) continue;

        const inner = html.slice(openEnd, innerEnd);
        const h2 = /<h2[^>]*>[\s\S]*?<\/h2>/.exec(inner);
        if (!h2) continue;

        out.push({
            id,
            heading: h2[0],
            indent: indentStr.length + 4,
            innerStart: openEnd,
            innerEnd,
            bodyStart: openEnd + h2.index + h2[0].length,
            bodyEnd: innerEnd,
        });
    }

    return out;
}

/** The raw body HTML of one section, ready for parseRegion. */
function regionSource(html, section) {
    return html.slice(section.bodyStart, section.bodyEnd);
}

/**
 * Replace one section's body with `blocks`, leaving every other byte of the
 * document untouched. Returns the new document string.
 */
function spliceRegion(html, sectionId, blocks) {
    const section = findSections(html).find(s => s.id === sectionId);
    if (!section) throw new Error(`page-copy-model: no section "${sectionId}"`);

    const body = '\n' + serializeRegion(blocks, section.indent) + '\n' + ' '.repeat(section.indent - 4);
    return html.slice(0, section.bodyStart) + body + html.slice(section.bodyEnd);
}

/** Canonicalise one section body in place — parse, re-serialize, splice. */
function canonicaliseRegion(html, sectionId) {
    const section = findSections(html).find(s => s.id === sectionId);
    if (!section) return html;
    const blocks = parseRegion(regionSource(html, section));
    if (blocks === null) return html;    // unparseable → leave byte-exact
    return spliceRegion(html, sectionId, blocks);
}

/* ─────────────────────────── introspection ─────────────────────────── */

/**
 * Every `data-legal-bind` occurrence in a block list, in document order, as
 * `tagName:key` strings. The save guard compares this multiset before and
 * after an edit: a deleted, duplicated or invented binding is rejected.
 *
 * §5 of tests/legal-cms-retired-jul2026.test.js crawls the shipped HTML for
 * bind keys and asserts js/legal-page.js implements every one. So inventing a
 * key is exactly as fatal as deleting one, and both are caught here.
 */
function collectBindings(blocks) {
    const found = [];
    const visit = (nodes) => walkInline(nodes, (el) => {
        const key = (el.attrs || []).find(a => a.name === 'data-legal-bind');
        if (key) found.push(`${el.name}:${key.value}`);
    });

    for (const b of blocks) {
        if (b.type === 'verbatim') {
            const re = /<([a-z0-9]+)[^>]*\sdata-legal-bind="([^"]*)"/gi;
            let m;
            while ((m = re.exec(b.raw)) !== null) found.push(`${m[1].toLowerCase()}:${m[2]}`);
            continue;
        }
        if (b.type === 'paragraph' || b.type === 'subheading') visit(b.inline);
        else if (b.type === 'list') b.items.forEach(visit);
        else if (b.type === 'callout') {
            if (b.title) visit(b.title);
            b.body.forEach(visit);
        }
    }
    return found;
}

/** Flattened plain text of a block list — what the banned-claim sweep reads. */
function blocksText(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (b.type === 'verbatim') parts.push(b.raw.replace(/<[^>]*>/g, ' '));
        else if (b.type === 'paragraph' || b.type === 'subheading') parts.push(inlineText(b.inline));
        else if (b.type === 'list') b.items.forEach(i => parts.push(inlineText(i)));
        else if (b.type === 'callout') {
            if (b.title) parts.push(inlineText(b.title));
            b.body.forEach(p => parts.push(inlineText(p)));
        }
    }
    return parts.join(' ');
}

/** True when a block can be edited in the UI (verbatim blocks cannot). */
function isBlockEditable(block) {
    return block.type !== 'verbatim';
}

export {
    // vocabulary (the guards import these so there is one list, not two)
    VOID_TAGS,
    INLINE_TAGS,
    EDITABLE_BLOCK_TAGS,
    VERBATIM_BLOCK_TAGS,
    ALLOWED_BLOCK_CLASSES,
    VERBATIM_DIV_CLASSES,
    // entities (ONE table — page-copy-guards.js imports these, never re-declares them)
    ENTITY_TO_CHAR,
    decodeEntities,
    encodeText,
    encodeAttrValue,
    // scanner
    tokenize,
    parseAttrs,
    serializeAttrs,
    buildTree,
    // model
    parseRegion,
    serializeRegion,
    serializeInline,
    serializeInlineBlock,
    inlineText,
    walkInline,
    // document surgery
    findSections,
    regionSource,
    spliceRegion,
    canonicaliseRegion,
    // introspection
    collectBindings,
    blocksText,
    isBlockEditable,
};
