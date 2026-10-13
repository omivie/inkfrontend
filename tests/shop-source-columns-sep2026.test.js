/**
 * Shop / search results — Compatible ON TOP, Genuine underneath, six-up
 * ======================================================================
 *
 * Sep-2026 put the two sources side by side (three cards a column). The owner
 * reversed it on 2026-10-13 (ERR-327): each section is full width again, six
 * cards to a row from 1100px, Compatible first. Each section's head row
 * carries a jump to the other one, on the right: cyan "Click here for genuine
 * …" (#source-jump) beside the Compatible heading, yellow "Click here for
 * compatible …" (#source-jump-compatible) beside the Genuine heading. Both
 * show only when BOTH sources have rows.
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

test('shop.html — cyan #source-jump sits in Compatible\'s head row, AFTER the <h2>, not in the page header', () => {
    // Owner 2026-10-13: in line with the Compatible heading, mirroring the yellow one.
    const sec = SHOP_HTML.indexOf('id="compatible-section"');
    const head = SHOP_HTML.indexOf('class="products-section__head"', sec);
    const h2 = SHOP_HTML.indexOf('id="compatible-title"', sec);
    const h2End = SHOP_HTML.indexOf('</h2>', h2);
    const btn = SHOP_HTML.indexOf('id="source-jump"', sec);
    const grid = SHOP_HTML.indexOf('id="compatible-products"', sec);
    assert.ok(sec < head && head < h2 && h2End < btn && btn < grid,
        'outside the <h2> so the heading\'s accessible name stays the heading');
    const header = SHOP_HTML.slice(SHOP_HTML.indexOf('class="drilldown-header"'), SHOP_HTML.indexOf('id="drilldown-title"'));
    assert.doesNotMatch(header, /source-jump/, 'the jump left the page header');
    assert.match(SHOP_HTML, /<button type="button" class="source-jump" id="source-jump" hidden>/,
        'ships hidden: a single-source page must never flash a dead button');
});

test('shop-page.js — _syncSourceColumns is the ONE writer of both buttons\' hidden state', () => {
    const m = SHOP_JS.match(/_syncSourceColumns\(\)\s*\{([\s\S]*?)\n        \},/);
    assert.match(m[1], /\['sourceJump', 'sourceJumpCompatible'\]/);
    assert.match(m[1], /\.hidden = shown !== 2/);
    assert.equal((SHOP_JS.match(/\.hidden = shown !== 2/g) || []).length, 1);
    assert.doesNotMatch(SHOP_JS, /sourceJump(?:Compatible)?\.hidden\s*=/, 'no second writer by name');
});

test('shop.html — yellow "Click here for compatible" sits in Genuine\'s head row, AFTER the <h2>', () => {
    const sec = SHOP_HTML.indexOf('id="genuine-section"');
    const head = SHOP_HTML.indexOf('class="products-section__head"', sec);
    const h2 = SHOP_HTML.indexOf('id="genuine-title"', sec);
    const h2End = SHOP_HTML.indexOf('</h2>', h2);
    const btn = SHOP_HTML.indexOf('id="source-jump-compatible"', sec);
    const grid = SHOP_HTML.indexOf('id="genuine-products"', sec);
    assert.ok(sec < head && head < h2 && h2End < btn && btn < grid,
        'outside the <h2> so the heading\'s accessible name stays the heading');
    assert.match(SHOP_HTML, /class="source-jump source-jump--compatible" id="source-jump-compatible" hidden>/);
    for (const id of ['source-jump', 'source-jump-compatible']) {
        const i = SHOP_HTML.indexOf(`id="${id}"`);
        assert.match(SHOP_HTML.slice(i, i + 200), /<span class="source-jump__text">/,
            `${id} needs a .source-jump__text span — the label writer must not wipe the arrow`);
    }
    const yellow = ruleBody(PAGES_CSS, '.source-jump--compatible {');
    assert.match(yellow, /background:\s*var\(--yellow-primary\)/, 'the Compatible badge yellow');
    assert.match(yellow, /color:\s*var\(--black-primary\)/, 'the badge\'s black text — white on yellow fails contrast');
    assert.match(PAGES_CSS, /#genuine-section,\s*#compatible-section\s*\{\s*scroll-margin-top/);
});

test('shop-page.js — both jump labels are written ONLY by _setSourceJumpLabels, at all three title sites', () => {
    assert.equal((SHOP_JS.match(/querySelector\('\.source-jump__text'\)/g) || []).length, 1);
    // Owner wording 2026-10-13: "Click here for genuine LC431 ink".
    assert.match(SHOP_JS, /`Click here for genuine \$\{s\}`/);
    assert.match(SHOP_JS, /`Click here for compatible \$\{s\}`/);
    assert.doesNotMatch(SHOP_HTML, />View (?:genuine|compatible) products</i);
    // printer level, /search, displayProductInfo (code pages)
    assert.equal((SHOP_JS.match(/this\._setSourceJumpLabels\(sourceJumpSubject\(/g) || []).length, 3);
    assert.match(SHOP_JS, /matched_printer[\s\S]{0,200}printer: mp\.name, brand: mp\.brand_name/);
});

test('sourceJumpSubject — names the code or printer the shopper asked for', () => {
    const src = SHOP_JS.match(/function sourceJumpSubject\([\s\S]*?\n    \}\n/);
    assert.ok(src, 'expected the sourceJumpSubject function');
    const f = new Function(`${src[0]}; return sourceJumpSubject;`)();
    const ink = [{ product_type: 'ink_cartridge' }, { product_type: 'ink_bottle' }];
    assert.equal(f({ code: 'lc436', products: ink }), 'LC436 ink');
    assert.equal(f({ code: 'tn258', products: [{ product_type: 'toner_cartridge' }] }), 'TN258 toner');
    assert.equal(f({ code: 'tn258', products: [{ product_type: 'toner_cartridge' }, { product_type: 'drum_unit' }] }), 'TN258 cartridges');
    assert.equal(f({ code: 'LC3317', category: 'ink' }), 'LC3317 ink');
    assert.equal(f({ printer: 'Brother MFC 970', brand: 'Brother', code: 'mfc 970' }), 'MFC 970 cartridges');
    assert.equal(f({ printer: 'HL-L2375DW', brand: 'Brother' }), 'HL-L2375DW cartridges');
    assert.equal(f({}), 'products');
    assert.equal(f({ code: '  ' }), 'products');
});

test('shop-page.js — the clicks scroll to their sections, no URL hash', () => {
    // Yellow lands Compatible's head row (cyan button included) at the top.
    const i = SHOP_JS.indexOf("[['sourceJump', 'genuineSection'], ['sourceJumpCompatible', 'compatibleSection']]");
    assert.ok(i !== -1, 'expected ONE binding loop over [button, section] pairs');
    const body = SHOP_JS.slice(i, i + 600);
    assert.match(body, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
    assert.doesNotMatch(body, /location\.hash/, 'the route lives in the query string');
});

test('pages.css — Genuine lands with a gap, button uses the Genuine badge cyan', () => {
    assert.match(ruleBody(PAGES_CSS, '#genuine-section,') || '', /scroll-margin-top:/);
    const btn = ruleBody(PAGES_CSS, '.source-jump {');
    assert.ok(btn, 'expected the .source-jump rule');
    assert.match(btn, /background:\s*var\(--cyan-primary\)/);
    assert.match(btn, /color:\s*var\(--white-primary\)/);
    assert.match(ruleBody(PAGES_CSS, '.source-jump[hidden] {') || '', /display:\s*none/,
        '.source-jump declares display, so [hidden] needs its own rule');
});

test('pages.css — the jump buttons stand still; only the label pulses every 6s, off for reduced motion', () => {
    const btn = ruleBody(PAGES_CSS, '.source-jump {');
    assert.doesNotMatch(btn, /animation|background-image/, 'the button itself is the plain original (ERR-332)');
    assert.match(ruleBody(PAGES_CSS, '.source-jump__label {') || '', /animation:\s*source-jump-text-pulse 6s\b/);
    // Text and arrow scale as ONE unit; each on its own ran the text over the arrow.
    assert.equal((SHOP_HTML.match(/<span class="source-jump__label"><span class="source-jump__text">/g) || []).length, 2);
    assert.match(PAGES_CSS, /@keyframes source-jump-text-pulse/);
    assert.match(PAGES_CSS, /prefers-reduced-motion: reduce\)\s*\{\s*\.source-jump__label\s*\{\s*animation:\s*none/);
});
