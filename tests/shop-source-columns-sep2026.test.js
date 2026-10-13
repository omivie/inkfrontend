/**
 * Shop / search results — Compatible ON TOP, Genuine underneath, six-up
 * ======================================================================
 *
 * Sep-2026 put the two sources side by side (three cards a column). The owner
 * reversed it on 2026-10-13 (ERR-327): each section is full width again, six
 * cards to a row from 1100px, Compatible first, and a cyan "View Genuine
 * products" button (#source-jump) in the header scrolls to Genuine. The button
 * shows only when BOTH sources have rows.
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

test('shop.html loading skeleton mirrors the stacked shape it is standing in for', () => {
    const skel = SHOP_HTML.slice(SHOP_HTML.indexOf('id="skeleton-products"'));
    const end = skel.indexOf('drilldown-empty');
    const block = skel.slice(0, end === -1 ? undefined : end);
    assert.match(block, /class="products-sections products-sections--split"/,
        'the skeleton must show both sections, as the loaded page will');
    // Six per section = one clean six-up row per stacked section.
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

test('pages.css — the sections STACK: one track, whatever the modifier', () => {
    const wrap = ruleBody(PAGES_CSS, '.products-sections {');
    assert.ok(wrap, 'expected the .products-sections rule');
    assert.match(wrap, /display:\s*grid/);
    assert.match(wrap, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
        'one track: Compatible above Genuine');
    assert.doesNotMatch(PAGES_CSS, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
        'no two-track source grid may come back');
    assert.doesNotMatch(PAGES_CSS, /\.products-sections--(?:split|single)[^{]*\{/,
        'the modifiers are a JS signal now; a CSS rule on them would re-split the layout');
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
    for (const sel of PAGES_CSS.match(/\.products-sections[ .][^{]*\{/g) || []) {
        if (!/product-card/.test(sel)) continue;
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

test('pages.css — six-up defers to the global ladder below 1100px', () => {
    // The scoped selector is (0,3,0) and the ladder's bare .product-card is
    // (0,1,0), so an unmediated rule would win at every width and freeze a
    // phone at six-up.
    const i = PAGES_CSS.indexOf('.products-sections .products-row .product-card {');
    assert.ok(i !== -1, 'expected the six-up card rule');
    assert.match(PAGES_CSS.slice(i, i + 120), /flex:\s*0 0 calc\(16\.666% - var\(--spacing-sm\)\)/);
    const before = PAGES_CSS.slice(Math.max(0, i - 200), i);
    assert.match(before, /@media \(min-width:\s*1100px\)/,
        'six-up must be guarded by a min-width so the existing 6/5/2 ladder still applies below it');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The "View Genuine products" jump (ERR-327)
// ─────────────────────────────────────────────────────────────────────────────

test('shop.html — #source-jump sits in the header between the title and the shipping pill', () => {
    const header = SHOP_HTML.indexOf('class="drilldown-header"');
    const left = SHOP_HTML.indexOf('class="drilldown-header__left"', header);
    const btn = SHOP_HTML.indexOf('id="source-jump"', header);
    const right = SHOP_HTML.indexOf('class="drilldown-header__right-group"', header);
    assert.ok(header !== -1 && left < btn && btn < right, 'button must be between __left and __right-group');
    assert.match(SHOP_HTML, /<button type="button" class="source-jump" id="source-jump" hidden>/,
        'ships hidden: a single-source page must never flash a dead button');
});

test('shop-page.js — _syncSourceColumns is the ONE writer of the button\'s hidden state', () => {
    const m = SHOP_JS.match(/_syncSourceColumns\(\)\s*\{([\s\S]*?)\n        \},/);
    assert.match(m[1], /sourceJump\.hidden = shown !== 2/);
    assert.equal((SHOP_JS.match(/sourceJump\.hidden\s*=/g) || []).length, 1);
});

test('shop-page.js — the click scrolls to #genuine-section, no URL hash', () => {
    const i = SHOP_JS.indexOf("sourceJump.addEventListener('click'");
    assert.ok(i !== -1, 'expected one click binding');
    const body = SHOP_JS.slice(i, i + 400);
    assert.match(body, /genuineSection[\s\S]*scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
    assert.doesNotMatch(body, /location\.hash/, 'the route lives in the query string');
});

test('pages.css — Genuine lands with a gap, button uses the Genuine badge cyan', () => {
    assert.match(ruleBody(PAGES_CSS, '#genuine-section {') || '', /scroll-margin-top:/);
    const btn = ruleBody(PAGES_CSS, '.source-jump {');
    assert.ok(btn, 'expected the .source-jump rule');
    assert.match(btn, /background:\s*var\(--cyan-primary\)/);
    assert.match(btn, /color:\s*var\(--white-primary\)/);
    assert.match(ruleBody(PAGES_CSS, '.source-jump[hidden] {') || '', /display:\s*none/,
        '.source-jump declares display, so [hidden] needs its own rule');
});
