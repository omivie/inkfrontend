/**
 * PAGE SCROLLBAR VISIBILITY — Sep 2026 (ERR-267)
 * ==============================================
 * Every page is supposed to carry a permanently visible right-side scrollbar.
 * css/modern-effects.css has had a block titled "CUSTOM SCROLLBARS — Always
 * visible, clickable and draggable" for two years, and for the last of those
 * two years it rendered nothing on the page scrollbar at all.
 *
 * WHY. css-scrollbars-1 says that on any element whose computed
 * `scrollbar-width` OR `scrollbar-color` is anything other than `auto`, the UA
 * "must ignore any alternative non-standard means for authors to influence the
 * rendering of scrollbars, such as the ::-webkit-scrollbar family of
 * pseudo-elements". Chrome 121 (Jan 2024) and Safari 18.2 (Dec 2024) implement
 * that. The block opened with a bare
 *
 *     * { scrollbar-width: thin; scrollbar-color: ... }
 *
 * which names `html` — so the ::-webkit-scrollbar rules underneath it were
 * ignored on the one element that owns the page scrollbar. And an explicit
 * non-zero ::-webkit-scrollbar { width } is the ONLY thing that flips
 * Blink/WebKit out of the macOS overlay scrollbar (the one that fades out at
 * rest and reserves zero width) into a classic, always-visible one. The
 * standards-track property silently retired the vendor-prefixed block that was
 * doing the work, and the comment above it went on promising the old behaviour.
 *
 * These are string-contract tests over the stylesheet. G2 is the one that
 * matters: it fails the moment anyone "tidies" `*:not(html)` back to `*`, which
 * is exactly how the defect would return — and note that it has to reason about
 * which selectors can MATCH the root, not merely contain the token "html", or a
 * bare `*` walks straight past it. Every guard here was red-proofed against a
 * mutated source before being committed; the first draft of G2 was green on the
 * bare `*` and the red-proof is the only reason that is not still true.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'inkcartridges/css/modern-effects.css'), 'utf8');

/**
 * Quote-aware CSS comment stripper. NOT tests/helpers/strip-comments.js — that
 * one owns JS (ERR-253) and knows about line comments and regex literals, which
 * CSS does not have. What CSS does have is url("data:image/svg+xml,...") in
 * this very file, so the quote tracking is not decorative.
 *
 * Stripping is required here because the comments in the block under test
 * quote CSS rules, braces and all, and G2 parses rule blocks by brace.
 */
function stripCssComments(src) {
    let out = '';
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += src[++i] || ''; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 1;
            out += ' ';
            continue;
        }
        out += c;
    }
    return out;
}

const CSS = stripCssComments(RAW);

// Positive control (ERR-253 / ERR-186): an assertion cannot fail over code that
// is not in the string it is reading. Prove the stripper left the file behind.
test('G0 (control) the stripper removed comments and nothing else', () => {
    assert.ok(CSS.length > RAW.length * 0.5,
        `stripper ate the file: ${RAW.length} chars in, ${CSS.length} out`);
    assert.doesNotMatch(CSS, /Always visible, clickable and draggable/,
        'comments should be gone — if this text survives, the stripper is a no-op and every test below is vacuous');
    for (const live of ['overflow-x: clip', 'z-index: 9999', 'data:image/svg+xml']) {
        assert.ok(CSS.includes(live), `live declaration "${live}" was deleted by the stripper`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// G1 — the standard properties are applied to inner scrollers, not to the root
// ─────────────────────────────────────────────────────────────────────────────

test('G1 the standard scrollbar properties are scoped with *:not(html)', () => {
    const m = CSS.match(/\*:not\(html\)\s*\{([^}]*)\}/);
    assert.ok(m, 'the universal scrollbar rule must be *:not(html), never a bare * (ERR-267)');
    assert.match(m[1], /scrollbar-width:\s*thin/, 'inner scrollers keep scrollbar-width: thin');
    assert.match(m[1], /scrollbar-color:\s*var\(--steel-400\)\s+var\(--steel-50\)/,
        'inner scrollers keep the steel scrollbar-color pair');
});

// ─────────────────────────────────────────────────────────────────────────────
// G2 — THE GUARD. Nothing may hand `html` a non-auto standard scrollbar value
//      outside the Firefox-only escape hatch, because doing so suppresses every
//      ::-webkit-scrollbar rule and the page loses its bar.
// ─────────────────────────────────────────────────────────────────────────────

test('G2 no rule gives html scrollbar-width/scrollbar-color outside the Firefox @supports block', () => {
    // Cut out @supports (-moz-appearance: none) { ... } by brace matching; what
    // is left is everything Chrome and Safari will actually apply.
    const start = CSS.indexOf('@supports (-moz-appearance: none)');
    assert.notStrictEqual(start, -1,
        'the Firefox escape hatch must exist — @supports selector(::-webkit-scrollbar) stopped detecting Firefox in 153 (bug 2038877)');
    let depth = 0, end = start;
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
        if (CSS[i] === '{') depth++;
        else if (CSS[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const withoutFirefox = CSS.slice(0, start) + CSS.slice(end);

    // Walk every rule block and look at its selector.
    const RULE = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = RULE.exec(withoutFirefox)) !== null) {
        const selector = r[1].trim();
        const body = r[2];
        if (selector.startsWith('@')) continue;               // at-rule prelude
        // A selector reaches the root if it can match <html>: `html...`, or a
        // universal `*` — which is what this rule was before ERR-267, and the
        // reason this test must not merely grep for the token "html".
        // `:not(html)` is the one form that provably cannot match it.
        const targetsRoot = selector.split(',').some((s) => {
            const sel = s.trim();
            if (/:not\(\s*html\s*\)/.test(sel)) return false;
            const withoutNot = sel.replace(/:not\([^)]*\)/g, '');
            return withoutNot === '*' || /(^|[\s>+~])html\b/.test(withoutNot);
        });
        if (!targetsRoot) continue;
        assert.doesNotMatch(body, /scrollbar-(width|color)\s*:/,
            `"${selector}" specifies a standard scrollbar property on the root element. ` +
            'Chrome 121+/Safari 18.2+ then ignore every ::-webkit-scrollbar rule, ' +
            'the macOS overlay scrollbar comes back, and the page has no visible bar at rest (ERR-267).');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// G3 — the webkit rules that actually force a classic bar, mouse/trackpad only
// ─────────────────────────────────────────────────────────────────────────────

test('G3 the ::-webkit-scrollbar rules live inside @media (pointer: fine) and stay unscoped', () => {
    const start = CSS.indexOf('@media (pointer: fine)');
    assert.notStrictEqual(start, -1,
        'the webkit block must be gated on pointer: fine so touch devices keep their native overlay bar');
    let depth = 0, end = start;
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
        if (CSS[i] === '{') depth++;
        else if (CSS[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const block = CSS.slice(start, end);

    assert.match(block, /(^|[\s{])::-webkit-scrollbar\s*\{[^}]*width:\s*10px/,
        'an explicit non-zero ::-webkit-scrollbar width is the only thing that defeats the macOS overlay scrollbar');
    assert.match(block, /::-webkit-scrollbar-track\s*\{[^}]*background:\s*var\(--steel-50\)/,
        'the track keeps its steel-50 background');
    assert.match(block, /::-webkit-scrollbar-thumb\s*\{[^}]*var\(--steel-400\)[^}]*var\(--steel-500\)/,
        'the thumb keeps its steel-400 -> steel-500 gradient');
    assert.doesNotMatch(block, /html\s*::?-webkit-scrollbar/,
        'the webkit selectors stay unscoped: scoping them to html would drop the branded bar from inner scrollers on engines that predate the standard properties');
});

// ─────────────────────────────────────────────────────────────────────────────
// G4 — the reserved gutter survives
// ─────────────────────────────────────────────────────────────────────────────

test('G4 html still reserves the scrollbar gutter with overflow-y: scroll', () => {
    assert.match(CSS, /html\s*\{[^}]*overflow-y:\s*scroll/,
        'html { overflow-y: scroll } keeps the bar present on short pages too; pages.css releases it below 768px (mobile-parity S0.11)');
});
