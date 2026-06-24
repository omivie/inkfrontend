/**
 * Search-results pagination contract — May 2026
 * ================================================
 *
 * Pins the page-walking pager added to `/search?q=...` so a regression
 * can't re-cap the result set at 100 (the backend's per-request limit).
 *
 * Symptom that motivated this: typing `compat` returned 633 products on
 * the backend, but the storefront rendered only the first 100 — every
 * card after that was unreachable because shop-page never read the
 * pagination envelope and never wired a pager.
 *
 * The fix lives in inkcartridges/js/shop-page.js + css/search.css:
 *   1. `state.page` is parsed from / written to the URL (?q=…&page=N).
 *   2. loadSearchResults passes `page` + `limit: 100` (SEARCH_PAGE_SIZE)
 *      to whichever API path the query lands on (smartSearch, getProducts
 *      with `source=`, getProducts with `type=`, the empty-result fallback).
 *   3. renderSearchPagination paints a prev/next/numbered pager into
 *      #level-products with id="search-pagination" and class
 *      "pagination search-pagination".
 *   4. CSS for `.search-pagination` lives in css/search.css.
 *
 * Run: node --test tests/search-pagination.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHOP_PAGE = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
const SEARCH_CSS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'css', 'search.css'), 'utf8');

// Strip JS comments so a literal in a `// the previous limit: 200` comment
// doesn't trip a regex banning `limit: 200` in the live code.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_PAGE);

// ─────────────────────────────────────────────────────────────────────────────
// State + URL plumbing
// ─────────────────────────────────────────────────────────────────────────────

test('state default includes page: 1', () => {
    const matches = SHOP_CODE.match(/page:\s*1\b/g) || [];
    assert.ok(matches.length >= 2,
        `expected at least 2 occurrences of 'page: 1' in shop-page.js; got ${matches.length}`);
});

test('parseURLState reads ?page=N into state.page', () => {
    assert.match(SHOP_CODE,
        /this\.state\.page\s*=\s*\(Number\.isInteger\([^)]+\)\s*&&\s*[^)]+>\s*0\)\s*\?\s*[A-Za-z]+\s*:\s*1/);
    assert.match(SHOP_CODE, /params\.get\(['"]page['"]\)/);
});

test('updateURL writes page only on search-results level beyond p1', () => {
    assert.match(SHOP_CODE,
        /this\.state\.search\s*&&\s*this\.state\.level\s*===\s*['"]search-results['"]\s*&&\s*this\.state\.page\s*>\s*1[\s\S]{0,200}params\.set\(['"]page['"]/);
});

test('removeFilter("search") resets page to 1', () => {
    const idx = SHOP_CODE.indexOf("case 'search':");
    assert.ok(idx !== -1, 'case for search filter not found');
    const slice = SHOP_CODE.slice(idx, idx + 400);
    assert.match(slice, /this\.state\.page\s*=\s*1/);
});

// ─────────────────────────────────────────────────────────────────────────────
// API calls — page is threaded into every search branch
// ─────────────────────────────────────────────────────────────────────────────

test('loadSearchResults declares a SEARCH_PAGE_SIZE constant of 100', () => {
    assert.match(SHOP_CODE, /const\s+SEARCH_PAGE_SIZE\s*=\s*100/);
});

test('loadSearchResults computes requestedPage with a >=1 floor', () => {
    assert.match(SHOP_CODE,
        /const\s+requestedPage\s*=\s*Math\.max\(\s*1\s*,\s*parseInt\(this\.state\.page,\s*10\)\s*\|\|\s*1\s*\)/);
});

test('smartSearch call passes page + limit', () => {
    const callIdx = SHOP_CODE.indexOf('API.smartSearch(searchQuery,');
    assert.ok(callIdx !== -1, 'API.smartSearch call not found');
    const slice = SHOP_CODE.slice(callIdx, callIdx + 400);
    assert.match(slice, /limit:\s*SEARCH_PAGE_SIZE/);
    assert.match(slice, /page:\s*requestedPage/);
});

// Pre-2026-05-11 the loader had typeDetect/sourceKeyword preflight branches
// that fired API.getProducts({type:…}) and API.getProducts({source:…}) before
// /smart. Backend `data.intent` retired both shims (verified live: `q=ribbon`
// returns 116 inline, `q=genuine`/`q=compatible` return source-filtered sets).
// The only surviving API.getProducts path is the digit-query soft-miss fallback.

test('soft-miss fallback getProducts call passes page + limit', () => {
    const re = /API\.getProducts\(\{\s*search:\s*searchQuery,\s*limit:\s*SEARCH_PAGE_SIZE,\s*page:\s*requestedPage\s*\}\)/;
    assert.match(SHOP_CODE, re);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination capture from each response shape
// ─────────────────────────────────────────────────────────────────────────────

test('smart-search pagination is read from data.pagination', () => {
    assert.match(SHOP_CODE, /smartData\.pagination[\s\S]{0,80}pagination\s*=\s*smartData\.pagination/);
});

test('getProducts pagination is read from .meta on the soft-miss fallback', () => {
    // /smart returns pagination on data.pagination; /api/products returns it
    // on the top-level meta envelope. The soft-miss fallback (digit queries)
    // hits /products, so we read fallback.meta.*.
    assert.match(SHOP_CODE, /fallback\.meta\.total_pages\s*!=\s*null/);
    assert.match(SHOP_CODE, /total_pages:\s*fallback\.meta\.total_pages/);
    assert.match(SHOP_CODE, /has_next:\s*!!fallback\.meta\.has_next/);
});

// ─────────────────────────────────────────────────────────────────────────────
// renderSearchPagination — render contract
// ─────────────────────────────────────────────────────────────────────────────

test('renderSearchPagination is defined on DrilldownNav', () => {
    assert.match(SHOP_CODE, /renderSearchPagination\s*\(\s*pagination\s*\)\s*\{/);
});

test('renderSearchPagination tears down any existing #search-pagination', () => {
    assert.match(SHOP_CODE,
        /document\.getElementById\(['"]search-pagination['"]\)[\s\S]{0,80}\.remove\(\)/);
});

test('renderSearchPagination hides itself on single-page or null pagination', () => {
    assert.match(SHOP_CODE, /total_pages\s*<=\s*1/);
});

test('pagination button click updates state.page, URL, and re-fetches', () => {
    assert.match(SHOP_CODE, /this\.state\.page\s*=\s*targetPage/);
    assert.match(SHOP_CODE, /this\.updateURL\(\)/);
    assert.match(SHOP_CODE, /this\.loadSearchResults\(/);
});

test('renderSearchPagination is invoked from loadSearchResults render branches', () => {
    const calls = SHOP_CODE.match(/this\.renderSearchPagination\(/g) || [];
    assert.ok(calls.length >= 2,
        `expected renderSearchPagination called at least twice; got ${calls.length}`);
});

test('pagination is mounted into #level-products (auto-clears on navigation)', () => {
    const bodyIdx = SHOP_CODE.indexOf('renderSearchPagination(pagination) {');
    assert.ok(bodyIdx !== -1, 'renderSearchPagination body not found');
    const body = SHOP_CODE.slice(bodyIdx, bodyIdx + 6000);
    assert.match(body, /this\.elements\.levelProducts\.appendChild/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS — the pager has matching styles so it's not unstyled markup
// ─────────────────────────────────────────────────────────────────────────────

test('search.css carries .search-pagination styles', () => {
    assert.match(SEARCH_CSS, /\.search-pagination\s*\{/);
    assert.match(SEARCH_CSS, /\.search-pagination\s+\.pagination__btn\s*\{/);
    assert.match(SEARCH_CSS, /\.search-pagination\s+\.pagination__btn\.active/);
    assert.match(SEARCH_CSS, /\.search-pagination\s+\.pagination__btn:disabled/);
});

test('search.css responsive collapse hides Prev/Next labels under 640px', () => {
    assert.match(SEARCH_CSS,
        /@media\s*\(max-width:\s*640px\)[\s\S]*?\.search-pagination\s+\.pagination__btn--prev\s+span[\s\S]*?display:\s*none/);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML — the cache key is bumped so the new CSS lands for returning visitors
// ─────────────────────────────────────────────────────────────────────────────

test('shop.html bumps the search.css cache key so the pager CSS lands', () => {
    const shopHtml = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
    // The cache key rides forward with every CSS rollout. It was
    // search-pagination-may2026 when the pager shipped; the 4-line title
    // clamp release bumped it; the out-of-stock pill copy release
    // (stock-enquiry-may2026) bumped it; the mobile-parity audit bumped it
    // again (mobile-parity-may2026); the four-row buy-box release
    // (buybox-may2026) bumped it; the loading-state rework (loading-spinner-jun2026)
    // bumped it again; the loyalty points styles (loyalty-points-jun2026) bumped it
    // again. The guarantee here is simply that shop.html requests the
    // *current* search.css build.
    assert.match(shopHtml, /search\.css\?v=loyalty-points-jun2026/);
    assert.doesNotMatch(shopHtml, /search\.css\?v=search-pagination-may2026/);
});
