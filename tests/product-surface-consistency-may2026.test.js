/**
 * Product surface consistency — May 2026
 * =======================================
 *
 * Pins two regressions reported on 2026-05-11:
 *
 *   1. /shop?brand=canon&category=ink&code=PGI650 dropped CPGI650KCMY (and
 *      every other compatible value-pack: CCLI671KCMY, CPGI670KCMY,
 *      CPGI520KCMY, CPGI525KCMY, CPGI5KCMY, CCLI681KCMY) because the
 *      compat-recovery sidecar was firing against `/api/shop?source=compatible`,
 *      which silently filters out `pack_type=value_pack` rows. Customers
 *      drilling brand→ink→PGI650 saw only the black single, never the colour
 *      pack — even though the colour pack ships under that series.
 *
 *      Fix: sidecar fires against /api/products instead. /api/products keeps
 *      the value-packs (verified live: 106 vs /api/shop's 99 for canon+ink+
 *      compatible). _enrichSeriesCodes derives PGI650 / CLI651 from the
 *      multipack's name so the merge matches the wanted code.
 *
 *   2. /search?q=650 returned 15 cartridges, none of which were the Canon
 *      PGI650 series — every one had "(650 pages)" in its yield copy. Smart's
 *      ranker happily returned that wall of irrelevant hits and the storefront
 *      had no way to recover. The earlier fallback only fired on a hard miss
 *      (zero results), so the soft miss (small set of off-topic hits) was a
 *      dead end.
 *
 *      Fix: when smart returns 1–49 products AND the query contains digits AND
 *      smart has neither matched_printer nor did_you_mean, refire
 *      /api/products?search=q in parallel and prefer it if it strictly beats
 *      smart's count. /api/products does substring matching on name+sku, which
 *      reliably surfaces "PGI650" for the query "650" because the SKU contains
 *      it as a token.
 *
 * Run: node --test tests/product-surface-consistency-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'api.js'), 'utf8');
const SHOP_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const API_CODE = stripComments(API_JS);
const SHOP_CODE = stripComments(SHOP_PAGE_JS);

// ─────────────────────────────────────────────────────────────────────────────
// Bug #1 — compat-recovery sidecar must hit /api/products, not /api/shop
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData sidecar fires against /api/products (recovers value-packs)', () => {
    // Find the eligibleForRecovery sidecarPromise assignment block and assert
    // it points at /api/products.
    const idx = API_CODE.indexOf('eligibleForRecovery');
    assert.ok(idx !== -1, 'eligibleForRecovery branch not found in api.js');
    const slice = API_CODE.slice(idx, idx + 1500);
    assert.match(slice, /sidecarPromise\s*=\s*this\.getWithSWR\(`\/api\/products\?\$\{/,
        'sidecar must fetch /api/products (was /api/shop, which drops pack_type=value_pack rows)');
});

test('getShopData sidecar still passes brand+category+source=compatible+limit', () => {
    const idx = API_CODE.indexOf('eligibleForRecovery');
    const slice = API_CODE.slice(idx, idx + 1500);
    assert.match(slice, /fbQs\.append\(['"]brand['"],\s*params\.brand\)/);
    assert.match(slice, /fbQs\.append\(['"]category['"],\s*params\.category\)/);
    assert.match(slice, /fbQs\.append\(['"]source['"],\s*['"]compatible['"]\)/);
    assert.match(slice, /fbQs\.append\(['"]limit['"],\s*['"]200['"]\)/);
});

test('_enrichSeriesCodes derives PGI650 from CPGI650KCMY value-pack', () => {
    // Run the actual function via vm so we test the live regex, not a copy.
    // Build a minimal sandbox with the symbols _enrichSeriesCodes uses.
    const sandbox = { console, RegExp, String, Set, Array };
    vm.createContext(sandbox);

    // Extract just the API object for the test. We can't easily eval the
    // whole api.js (network/global deps), so we inline-test the function by
    // stamping it onto a local API stub.
    const fnStart = API_CODE.indexOf('_enrichSeriesCodes(product) {');
    assert.ok(fnStart !== -1, '_enrichSeriesCodes not found');
    // Find matching closing brace by scanning balanced braces from fnStart.
    let depth = 0, end = -1;
    for (let i = fnStart; i < API_CODE.length; i++) {
        if (API_CODE[i] === '{') depth++;
        else if (API_CODE[i] === '}') {
            depth--;
            if (depth === 0) { end = i + 1; break; }
        }
    }
    const fnSrc = API_CODE.slice(fnStart, end);
    const wrap = `const fn = function ${fnSrc}; fn(product); product`;
    const product = {
        sku: 'CPGI650KCMY',
        name: 'PGI650KCMY Compatible Ink Cartridge for Canon PGI650 CLI651 KCMY 4-Pack (300 pages)',
        series_codes: [],
    };
    const result = vm.runInContext(wrap, vm.createContext({ product, RegExp, String, Set, Array }));
    assert.ok(Array.isArray(result.series_codes), 'series_codes should be populated');
    assert.ok(result.series_codes.includes('PGI650'),
        `series_codes should include 'PGI650', got ${JSON.stringify(result.series_codes)}`);
});

test('_enrichSeriesCodes also derives PGI650 from CCLI671KCMY-style multipack name', () => {
    const fnStart = API_CODE.indexOf('_enrichSeriesCodes(product) {');
    let depth = 0, end = -1;
    for (let i = fnStart; i < API_CODE.length; i++) {
        if (API_CODE[i] === '{') depth++;
        else if (API_CODE[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const fnSrc = API_CODE.slice(fnStart, end);
    const wrap = `const fn = function ${fnSrc}; fn(product); product`;
    const product = {
        sku: 'CCLI671KCMY',
        name: 'CLI671XLKCMY Compatible Ink Cartridge for Canon CLI671XL KCMY 4-Pack',
        series_codes: [],
    };
    const result = vm.runInContext(wrap, vm.createContext({ product, RegExp, String, Set, Array }));
    assert.ok(result.series_codes.includes('CLI671XL') || result.series_codes.includes('CLI671'),
        `series_codes should include CLI671XL or CLI671, got ${JSON.stringify(result.series_codes)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2 — soft-miss fallback when smart returns few off-topic hits for a digit query
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page declares queryHasDigits + soft/hard miss conditions', () => {
    assert.match(SHOP_CODE, /const\s+queryHasDigits\s*=\s*\/\\d\/\.test/);
    assert.match(SHOP_CODE, /const\s+softMiss\s*=\s*queryHasDigits/);
    assert.match(SHOP_CODE, /const\s+hardMiss\s*=\s*products\.length\s*===\s*0/);
});

test('soft-miss threshold is 50 and the branch checks for missing matched_printer + did_you_mean', () => {
    assert.match(SHOP_CODE, /SOFT_MISS_THRESHOLD\s*=\s*50/);
    // The soft-miss must NOT fire when smart already matched a printer or
    // proposed a did_you_mean — those signals mean smart knows what to do.
    const idx = SHOP_CODE.indexOf('const softMiss');
    const slice = SHOP_CODE.slice(idx, idx + 600);
    assert.match(slice, /!smartData\?\.matched_printer/);
    assert.match(slice, /!smartData\?\.did_you_mean/);
});

test('soft-miss only swaps when the literal set strictly beats smart count', () => {
    // The whole point of the soft miss: don't swap if the literal set
    // doesn't have strictly more results — otherwise the swap costs us
    // smart's relevance ranking with no upside. (The hard-miss / hijack
    // branch swaps on any literal hit; the soft-miss branch is the `:` arm.)
    // search-results-parity-may2026 folded the soft-miss swap into a shared
    // reconcile that also covers hijack, and renamed `fallbackProducts` →
    // `merged` (dropdown shortlist unioned with the full literal set).
    // Jun 2026: digit queries filter `merged` → `mergedUsed` (off-topic flood
    // strip) before this comparison; the strict-beat rule is unchanged.
    // Jul 2026 (search-ux-frontend §2): an `exactMode ? true :` arm was prepended
    // for the "Search instead" flow, but the hijack/hardMiss vs soft-miss
    // strict-beat structure below it is unchanged.
    assert.match(SHOP_CODE,
        /shouldUseFallback\s*=\s*exactMode[\s\S]{0,80}\(hijack\s*\|\|\s*hardMiss\)[\s\S]{0,150}mergedUsed\.length\s*>\s*smartCount/);
});

test('fallback path still uses SEARCH_PAGE_SIZE + page so pagination keeps working', () => {
    // The fallback fetches /api/products with the same page+limit so a user
    // landing on page 3 of soft-miss results doesn't accidentally jump back
    // to page 1.
    const idx = SHOP_CODE.indexOf('hardMiss || softMiss');
    assert.ok(idx !== -1, 'fallback gate not found');
    const slice = SHOP_CODE.slice(idx, idx + 1500);
    assert.match(slice, /API\.getProducts\(\{\s*search:\s*searchQuery,\s*limit:\s*SEARCH_PAGE_SIZE,\s*page:\s*requestedPage\s*\}\)/);
});

test('fallback path normalises /api/products meta into the shared pagination shape', () => {
    const idx = SHOP_CODE.indexOf('hardMiss || softMiss');
    const slice = SHOP_CODE.slice(idx, idx + 3000);
    assert.match(slice, /total_pages:\s*fallback\.meta\.total_pages/);
    assert.match(slice, /has_next:\s*!!fallback\.meta\.has_next/);
    assert.match(slice, /has_prev:\s*!!fallback\.meta\.has_prev/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-surface invariant: every list-view branch passes through
// renderSearchPagination so the pager doesn't disappear when the soft-miss
// swap fires.
// ─────────────────────────────────────────────────────────────────────────────

test('renderSearchPagination is reachable from both render branches in loadSearchResults', () => {
    // A regression that shipped a soft-miss swap but forgot to re-emit the
    // pager would silently cap the result set at 100 again. We assert the
    // pager render is wired in BOTH the products-rendered branch AND the
    // empty-results branch.
    const calls = SHOP_CODE.match(/this\.renderSearchPagination\(/g) || [];
    assert.ok(calls.length >= 2,
        `expected renderSearchPagination called at least twice in shop-page, got ${calls.length}`);
});
