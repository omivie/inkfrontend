/**
 * Shop / search results — Compatible LEFT, Genuine RIGHT
 * ======================================================
 *
 * Sep-2026. #compatible-section used to sit ABOVE #genuine-section, each a
 * 7-across flex row, so the Genuine set began a full section down the page and
 * the two prices for the same colour were never on screen together. They are
 * columns now — three cards to a row in each, six across — collapsing to one
 * full-width six-up section when only one source has rows.
 *
 * /search, /ink-cartridges and /toner-cartridges are Vercel rewrites onto this
 * same shell (vercel.json), so these assertions cover every one of them.
 *
 * SOURCE-GREP STYLE, AND HONEST ABOUT IT. `.products-row` is a wrapping flex
 * container: how many cards land on a row is a computed flex-basis against a
 * container width, and no grep can see that. `npm run probe:shop-columns`
 * measures the real boxes at five widths on both URLs. What is pinned here is
 * the wiring a probe cannot run in CI: that the decision is made in one place,
 * that the card rules stay SCOPED, and that the [hidden] mechanism is intact.
 *
 * Run with: node --test tests/shop-source-columns-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const SHOP_HTML = READ('html/shop.html');
const SHOP_JS = READ('js/shop-page.js');
const PAGES_CSS = READ('css/pages.css');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The shell
// ─────────────────────────────────────────────────────────────────────────────

test('shop.html wraps both source sections in one .products-sections host', () => {
    const wrap = SHOP_HTML.indexOf('<div class="products-sections" id="source-sections">');
    assert.ok(wrap !== -1, 'expected a #source-sections wrapper — the grid the two columns live in');
    const compat = SHOP_HTML.indexOf('id="compatible-section"');
    const genuine = SHOP_HTML.indexOf('id="genuine-section"');
    assert.ok(wrap < compat && compat < genuine,
        'both sections must sit INSIDE the wrapper, Compatible first');
});

test('shop.html keeps Compatible before Genuine — the click beacon numbers by document order', () => {
    // search-click-beacon.js walks GRID_IDS = ['compatible-products',
    // 'genuine-products'] and reports a click's position across BOTH grids.
    // The wrapper is invisible to it because it addresses them by id, but the
    // ORDER is not: swapping the sections renumbers every genuine click.
    // Pinned independently in search-click-beacon-aug2026.test.js.
    assert.ok(SHOP_HTML.indexOf('id="compatible-products"') < SHOP_HTML.indexOf('id="genuine-products"'),
        'compatible-products must precede genuine-products in the DOM');
});

test('shop.html loading skeleton mirrors the two-column shape it is standing in for', () => {
    const skel = SHOP_HTML.slice(SHOP_HTML.indexOf('id="skeleton-products"'));
    const end = skel.indexOf('drilldown-empty');
    const block = skel.slice(0, end === -1 ? undefined : end);
    assert.match(block, /class="products-sections products-sections--split"/,
        'the skeleton must show the split shape, not a stack that jumps on load');
    // Six per section = two clean rows of three per column. Seven left a 3+3+1
    // ragged row for the whole of the load.
    const cards = (block.match(/product-card--skeleton/g) || []).length;
    assert.equal(cards, 12, 'six skeleton cards per section, two sections');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The decision
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js decides split vs single in ONE place, from the sections\' hidden state', () => {
    assert.match(SHOP_JS, /_syncSourceColumns\(\)\s*\{/,
        'expected a single function that owns the wrapper class');
    const m = SHOP_JS.match(/_syncSourceColumns\(\)\s*\{([\s\S]*?)\n        \},/);
    assert.ok(m, 'expected the _syncSourceColumns body');
    assert.match(m[1], /compatibleSection[\s\S]*genuineSection/,
        'it must read BOTH sections');
    assert.match(m[1], /\.hidden/,
        'the source of truth is the hidden attribute renderProducts already sets');
    assert.match(m[1], /products-sections--split/, 'must set the split modifier');
    assert.match(m[1], /products-sections--single/, 'must set the single modifier');
    assert.doesNotMatch(PAGES_CSS, /:has\(\s*\.products-section/,
        'the layout must not be inferred with :has() — shop-page.js owns the decision');
});

test('renderProducts syncs the columns on BOTH branches, empty and populated', () => {
    // renderProducts is the only place a source section is hidden or shown, and
    // the empty branch early-returns — so it needs its own call. A missed one
    // leaves a stale modifier and the survivor paints at half width beside an
    // empty grid track.
    //
    // Scoped to the method body on purpose: a file-wide grep for
    // `section.hidden` also catches the colour-packs grid, which has its own
    // local `section` and nothing to do with the two source columns.
    const m = SHOP_JS.match(/renderProducts\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected the renderProducts body');
    const body = m[1];
    const hidden = [...body.matchAll(/section\.hidden = (?:true|false);/g)];
    assert.equal(hidden.length, 2, 'renderProducts sets section.hidden exactly twice (empty / populated)');
    for (const h of hidden) {
        const after = body.slice(h.index + h[0].length, h.index + h[0].length + 120);
        assert.match(after, /_syncSourceColumns\(\)/,
            `each section.hidden branch must sync the columns — missing after: ${h[0]}`);
    }
});

test('renderZeroResultsRecovery syncs after hiding both sections', () => {
    const i = SHOP_JS.indexOf('async renderZeroResultsRecovery');
    assert.ok(i !== -1, 'expected renderZeroResultsRecovery');
    const head = SHOP_JS.slice(i, i + 900);
    assert.match(head, /compatibleSection\.hidden = true;[\s\S]{0,200}genuineSection\.hidden = true;[\s\S]{0,200}_syncSourceColumns\(\)/,
        'hiding both sections for the recovery rails must also clear the split modifier');
});

test('shop-page.js holds a handle to the wrapper', () => {
    assert.match(SHOP_JS, /sourceSections:\s*document\.getElementById\('source-sections'\)/,
        'the wrapper must be resolved once, alongside the other element handles');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The CSS
// ─────────────────────────────────────────────────────────────────────────────

const ruleBody = (css, selector) => {
    const i = css.indexOf(selector);
    if (i === -1) return null;
    const open = css.indexOf('{', i);
    return css.slice(open + 1, css.indexOf('}', open));
};

test('pages.css — --split is two tracks, --single is one', () => {
    const split = ruleBody(PAGES_CSS, '.products-sections--split {');
    const single = ruleBody(PAGES_CSS, '.products-sections--single {');
    assert.ok(split && single, 'both modifiers must be defined');
    assert.match(split, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
        '--split lays the two sections side by side');
    assert.match(single, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
        '--single gives the survivor the whole width');
    assert.match(ruleBody(PAGES_CSS, '.products-sections {'), /display:\s*grid/);
});

test('pages.css — .products-section carries no display, or [hidden] stops working', () => {
    // renderProducts hides an empty group with the hidden ATTRIBUTE. Any
    // `display` here beats [hidden]{display:none} on specificity grounds and
    // would paint an empty section in its column.
    const body = ruleBody(PAGES_CSS, '.products-section {');
    assert.ok(body, 'expected the .products-section rule');
    assert.doesNotMatch(body, /display\s*:/,
        '.products-section must not declare display — it would override [hidden]');
});

test('pages.css — the per-row card rules are SCOPED to .products-row', () => {
    // .product-card is global: its flex-basis is inert in the CSS-Grid parents
    // (ribbons, PDP related, cart, bought-together, favourites, landing) but
    // its max-width/min-width are not. .products-row exists only on shop.html.
    const scoped = PAGES_CSS.match(/\.products-sections--(?:split|single)[^{]*\.products-row \.product-card\s*\{/g) || [];
    assert.ok(scoped.length >= 2,
        `expected the card rules to be scoped through .products-row, found ${scoped.length}`);
    for (const sel of PAGES_CSS.match(/\.products-sections--[a-z]+ [^{]*\{/g) || []) {
        if (!/product-card|products-row/.test(sel)) continue;
        assert.match(sel, /\.products-row/,
            `a card rule must go through .products-row, not reach .product-card directly: ${sel.trim()}`);
    }
});

test('pages.css — the GLOBAL .product-card rule is left alone', () => {
    // The regression guard for the blast radius above: six other surfaces
    // inherit this rule's width clamps.
    const body = ruleBody(PAGES_CSS, '\n.product-card {');
    assert.ok(body, 'expected the base .product-card rule');
    assert.match(body, /flex:\s*0 0 calc\(14\.285% - var\(--spacing-sm\)\)/,
        'the base rule must keep its 7-up basis — scope changes, do not move it');
    assert.match(body, /max-width:\s*185px/,
        'the 185px cap is what keeps dropdown-style container-query flips away');
});

test('pages.css — --single defers to the global ladder below 1100px', () => {
    // The scoped selectors are (0,3,0) and the ladder's bare .product-card is
    // (0,1,0), so an unmediated --single rule would win at every width and
    // freeze a phone at six-up.
    const i = PAGES_CSS.indexOf('.products-sections--single .products-row .product-card');
    assert.ok(i !== -1, 'expected the --single card rule');
    const before = PAGES_CSS.slice(Math.max(0, i - 400), i);
    assert.match(before, /@media \(min-width:\s*1100px\)/,
        '--single must be guarded by a min-width so the existing 6/5/2 ladder still applies below it');
});
