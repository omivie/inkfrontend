/**
 * Search Dropdown ⇄ Product/Shop Grid — Organization Parity
 * =========================================================
 *
 * The typeahead dropdown must present products the same way the product/shop
 * grid does: up to 40 cards, grouped by cartridge code → yield → colour, with
 * each (familyKey, yieldTier) family broken onto its own 7-up row. This pins
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

test('search.js — fetchSuggest reads /smart\'s data.products into the results slot', () => {
    // /smart returns the result set under `products`; /suggest used
    // `suggestions`. The mapping must prefer products so the 40-card set
    // actually surfaces.
    assert.match(SEARCH_JS, /Array\.isArray\(data\.products\)/,
        'fetchSuggest must read data.products from the /smart envelope');
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

test('search.css — dropdown grid is 7-up to match the product page rows', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__grid\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*1fr\)/,
        'spec: dropdown grid is 7 columns, matching the product/shop grid');
});

test('search.css — grid honors the row-break (grid-column: 1 / -1, since flex-basis is ignored in a grid)', () => {
    assert.match(SEARCH_CSS, /\.smart-ac__grid\s+\.products-row__break\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
        'spec: a CSS grid ignores flex-basis:100%; the break must span the full row via grid-column: 1 / -1');
});

test('search.js — dropdown splits into Compatible + Genuine sections (source === "compatible"), never one mixed grid', () => {
    // The product/shop page partitions on source and renders two labelled
    // sections; the dropdown must copy that so genuine + compatible variants of
    // the same code don't interleave.
    assert.match(SEARCH_JS, /source\s*\|\|[^\n]*\)\s*===\s*['"]compatible['"]/,
        'dropdown must partition on the canonical source field like shop-page.js');
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
