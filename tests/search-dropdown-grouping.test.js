/**
 * Search Dropdown ⇄ Product/Shop Grid — Organization Parity
 * =========================================================
 *
 * The typeahead dropdown must present products the same way the product/shop
 * grid does: up to 40 cards, grouped by cartridge code → yield → colour, with
 * each (familyKey, yieldTier) family broken onto its own row. This pins
 * the change that drove the dropdown off the literal /api/search/suggest
 * endpoint (backend hard-capped at 24, raw order) onto /api/search/smart
 * (limit 40, full enriched envelope) and applied ProductSort.byCodeThenColor +
 * ProductSort.rowBreakIndices — the exact functions the shop/results grid uses
 * (see js/utils.js, shop-page.js renderProducts).
 *
 * Run with: node --test tests/search-dropdown-grouping.test.js
 *
 * Source-grep style (mirrors the Pass-B guards in the sibling dropdown tests):
 * cheap, dependency-free, and catches a silent regression that strips the
 * grouping or reverts the endpoint/limit.
 *
 * SOURCE GREPS CANNOT SEE A BOX MODEL. Sep-2026 turned the two stacked
 * sections into two side-by-side columns — Compatible left, Genuine right,
 * three cards per row in each, six across the panel — and a grep can only
 * confirm the rules were written, never that the browser painted two columns
 * of three. `npm run probe:search-columns` measures the real rects (ERR-224 is
 * the precedent: 21 green source greps over a layout that was wrong on screen).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

const SEARCH_JS = READ('js/search.js');
const SEARCH_CSS = READ('css/search.css');

test('search.js — dropdown drives off /api/search/smart (not the 24-capped /suggest)', () => {
    const m = SEARCH_JS.match(/const\s+ENDPOINT\s*=\s*['"`]([^'"`]+)['"`]/);
    assert.ok(m, 'expected an ENDPOINT constant in search.js');
    assert.equal(m[1], '/api/search/smart',
        'spec: dropdown must use /smart — /suggest is backend-capped at 24 and cannot reach 40');
});

test('search.js — dropdown LIMIT is 40', () => {
    const m = SEARCH_JS.match(/const\s+LIMIT\s*=\s*(\d+)\s*;/);
    assert.ok(m, 'expected a LIMIT constant in search.js');
    assert.equal(Number(m[1]), 40,
        'spec: dropdown shows up to 40 products (user requirement)');
});

test('search.js — fetchSmart reads /smart\'s data.products into the results slot', () => {
    // /smart returns the result set under `products`; /suggest used
    // `suggestions`. The mapping must prefer products so the 40-card set
    // actually surfaces.
    // ERR-144: the function was renamed fetchSuggest → fetchSmart on
    // 2026-08-04. The old name outlived the endpoint it described and helped
    // convince the backend this dropdown still fed off /api/search/suggest.
    assert.match(SEARCH_JS, /Array\.isArray\(data\.products\)/,
        'fetchSmart must read data.products from the /smart envelope');
    assert.match(SEARCH_JS, /async function fetchSmart\(/,
        'the fetcher is named for the endpoint it calls — see ERR-144');
});

test('search.js — renderResults applies the product-grid grouping (byCodeThenColor + rowBreakIndices)', () => {
    assert.match(SEARCH_JS, /ProductSort\.byCodeThenColor\(/,
        'dropdown must sort with the same byCodeThenColor used by the shop/results grid');
    assert.match(SEARCH_JS, /ProductSort\.rowBreakIndices\(/,
        'dropdown must compute row-breaks with the same rowBreakIndices used by the grid');
});

test('search.js — renderResults injects the .products-row__break element between families', () => {
    assert.match(SEARCH_JS, /class="products-row__break"/,
        'dropdown must emit .products-row__break so each (familyKey, yieldTier) group starts a fresh row');
});

test('search.css — dropdown grid is 6-up across the panel', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__grid\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/,
        'spec: a single-source result set runs six cards across the 1120px panel');
    assert.doesNotMatch(SEARCH_CSS, /grid-template-columns:\s*repeat\(7,/,
        'the 7-up grid is gone — six across, or two three-up columns');
});

test('search.css — a split panel is two columns of three, six across in total', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__sections--split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
        'spec: --split lays the two sections side by side, Compatible left / Genuine right');
    assert.match(SEARCH_CSS, /\.smart-ac__sections--single\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
        'spec: --single gives the surviving section the whole panel width');
    assert.match(SEARCH_CSS, /\.smart-ac__sections--split\s+\.smart-ac__grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
        'spec: three cards per row inside each column — K C M / Y CMY KCMY');
});

test('search.css — the stacked-section separator is gone, not merely unused', () => {
    // The sections used to be stacked and the second one drew a border-top.
    // Side by side, that rule can only ever draw a line in the wrong place —
    // and in --single there is exactly one section for it to match against.
    assert.doesNotMatch(SEARCH_CSS, /\.smart-ac__section \+ \.smart-ac__section \.smart-ac__section-head/,
        'the stacked separator must be removed, not left to match nothing');
    assert.match(SEARCH_CSS, /\.smart-ac__sections--split\s*>\s*\.smart-ac__section \+ \.smart-ac__section\s*\{[^}]*border-left/,
        'the divider between the two columns is a border-left');
});

test('search.css — the .product-card flex legacy is neutralised inside the dropdown grid', () => {
    // pages.css gives .product-card min-width:140px / max-width:185px from its
    // flex era. Against explicit grid tracks the min-width overflows a narrow
    // column and the max-width leaves a wide one half empty. pages.css already
    // neutralises both inside .product-grid at <=640px; the dropdown's tracks
    // are explicit at EVERY width, so it has to hold at every width here.
    const m = SEARCH_CSS.match(/\.smart-ac__grid \.product-card \{([^}]*)\}/);
    assert.ok(m, 'expected a .smart-ac__grid .product-card rule');
    assert.match(m[1], /min-width:\s*0/, 'min-width must not overflow a narrow column');
    assert.match(m[1], /max-width:\s*none/, 'max-width must not leave a wide track half empty');
});

test('search.css — grid honors the row-break (grid-column: 1 / -1, since flex-basis is ignored in a grid)', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__grid\s+\.products-row__break\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
        'spec: a CSS grid ignores flex-basis:100%; the break must span the full row via grid-column: 1 / -1');
});

test('search.js — dropdown splits into Compatible + Genuine sections (source === "compatible"), never one mixed grid', () => {
    // The product/shop page partitions on source and renders two labelled
    // sections; the dropdown must copy that so genuine + compatible variants of
    // the same code don't interleave.
    //
    // ERR-157: the predicate is now BrandSource.isCompatible rather than an
    // inline `(p.source || (p.is_genuine ? 'genuine' : 'compatible'))`. The old
    // expression INVENTED 'compatible' for a row carrying neither field.
    // Partition behaviour is unchanged for real payloads — /smart ships
    // `source`, /suggest ships `is_genuine` as a real boolean — and a row with
    // neither now lands in the non-compatible group instead of being asserted
    // third-party on the way in.
    assert.match(SEARCH_JS, /BrandSource\.isCompatible\s*\(\s*p\s*\)/,
        'dropdown must partition through the one brand-source vocabulary');
    assert.doesNotMatch(SEARCH_JS, /is_genuine\s*\?\s*['"]genuine['"]\s*:\s*['"]compatible['"]/,
        'dropdown must not invent a source from a missing is_genuine flag');
    assert.match(SEARCH_JS, /products-section__badge--compatible/,
        'dropdown must render a Compatible section badge (reuses the page chip)');
    assert.match(SEARCH_JS, /products-section__badge--genuine/,
        'dropdown must render a Genuine section badge (reuses the page chip)');
});

test('search.js — Compatible section renders before Genuine (page order)', () => {
    const ci = SEARCH_JS.indexOf("'products-section__badge--compatible'");
    const gi = SEARCH_JS.indexOf("'products-section__badge--genuine'");
    assert.ok(ci !== -1 && gi !== -1, 'both section badges must be present');
    assert.ok(ci < gi,
        'spec: Compatible section composed before Genuine, matching shop.html #compatible-section before #genuine-section');
});

// ─────────────────────────────────────────────────────────────────────────────
// Two columns: the split/single decision
// ─────────────────────────────────────────────────────────────────────────────

test('search.js — the split/single decision is made in JS, from the section counts', () => {
    // Not a CSS :has(). One place counts how many sources came back, so
    // "no genuine => compatible takes the whole width" is a decision recorded
    // in the DOM rather than a coincidence of selector matching — and a probe
    // measuring the painted panel can read which layout was chosen.
    assert.match(SEARCH_JS, /const\s+sectionCount\s*=\s*\(compatibleItems\.length\s*\?\s*1\s*:\s*0\)\s*\+\s*\(genuineItems\.length\s*\?\s*1\s*:\s*0\)/,
        'the wrapper class must be chosen from how many sections actually have rows');
    assert.match(SEARCH_JS, /sectionCount === 2[\s\S]{0,120}smart-ac__sections--split/,
        'two populated sections => --split');
    assert.match(SEARCH_JS, /smart-ac__sections--single/,
        'one populated section => --single (it takes the whole panel width)');
    assert.doesNotMatch(SEARCH_CSS, /:has\(\.smart-ac__section/,
        'the layout must not be inferred with :has() — search.js owns the decision');
});

test('search.js — the sections wrapper is emitted only when a section exists', () => {
    // renderSection already returns '' for an empty group. An empty wrapper
    // would still paint its grid gap and border above a no-results panel.
    assert.match(SEARCH_JS, /const\s+sectionsHTML\s*=\s*sectionCount\s*\n?\s*\?/,
        'sectionsHTML must be gated on sectionCount, not emitted unconditionally');
});

test('search.js — wrapping the sections did not disturb the painted-order contract', () => {
    // KEYBOARD-NAV CONTRACT: state.results must stay in the order the browser
    // paints .product-card elements, because setActive(i) highlights DOM card i
    // while Enter navigates state.results[i]. Two visual COLUMNS do not change
    // the DOM: it is still Compatible's cards then Genuine's, in one list.
    const push = SEARCH_JS.indexOf('renderedOrder.push(p)');
    const render = SEARCH_JS.indexOf('Products.renderCard(adaptForCard(p), i)');
    assert.ok(push !== -1 && render !== -1, 'both halves of the contract must be present');
    assert.ok(render - push > 0 && render - push < 400,
        'renderedOrder.push must stay adjacent to the card emission it records');
    assert.match(SEARCH_JS, /state\.results\s*=\s*renderedOrder/,
        'state.results must be re-pointed at the painted order');
});
