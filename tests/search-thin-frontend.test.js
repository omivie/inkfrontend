/**
 * Search — thin-frontend contract tests
 * ======================================
 *
 * Pins the contract documented in
 *   readfirst/SEARCH_AUDIT.md (frontend audit, 2026-05-03)
 *   readfirst/backend-passover.md ("Search — thin-frontend contract")
 *
 * Every test below is a *regression guard* for the audit's outcome:
 *
 *   - Dead code (SearchNormalize.normalize / correctSpelling /
 *     detectPrinterModel / getSpellingAlternative, _inferCorrectedTerm,
 *     initBasicAutocomplete) stays deleted.
 *   - Backend response fields (`data.intent`, `data.recovery`) are read
 *     when present, with the local shim used only as a fallback.
 *   - Direct Supabase queries from ink-finder/account stay deleted —
 *     printer-by-brand goes through the API exclusively.
 *
 * Run with: node --test tests/search-thin-frontend.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

// Cached source reads.
const SEARCH_NORMALIZE_JS = READ('search-normalize.js');
const SHOP_PAGE_JS        = READ('shop-page.js');
const MAIN_JS             = READ('main.js');
const INK_FINDER_JS       = READ('ink-finder.js');
const ACCOUNT_JS          = READ('account.js');

// ─────────────────────────────────────────────────────────────────────────────
// Bucket B regression guards — dead code stays deleted
// ─────────────────────────────────────────────────────────────────────────────

test('search-normalize.js — dead code (normalize, correctSpelling, detectPrinterModel, getSpellingAlternative) is deleted', () => {
    // The full audit lives in readfirst/SEARCH_AUDIT.md. These four functions
    // were never called from anywhere in the codebase yet shipped on every
    // one of 42 HTML pages. detectProductType is the only one that stays
    // (until backend-passover task 1 ships `data.intent`).
    const banned = [
        /\bfunction\s+normalize\b/,
        /\bfunction\s+correctSpelling\b/,
        /\bfunction\s+detectPrinterModel\b/,
        /\bfunction\s+getSpellingAlternative\b/,
        /\bdamerauLevenshtein\b/,
        /\bMISSPELLINGS\b/,
        /\bSPELLING_PAIRS\b/,
        /\bCODE_PATTERNS\b/,
        /\bABBREVIATIONS\b/,
    ];
    for (const re of banned) {
        assert.doesNotMatch(SEARCH_NORMALIZE_JS, re,
            `search-normalize.js must not contain ${re} — it was dead code; backend already does this work`);
    }
    // The one survivor:
    assert.match(SEARCH_NORMALIZE_JS, /\bfunction\s+detectProductType\b/,
        'detectProductType stays as a shim until backend ships data.intent (see backend-passover task 1)');
});

test('shop-page.js — _inferCorrectedTerm heuristic is deleted', () => {
    // The heuristic counted brand frequencies across the result set to guess
    // a correction term when backend returned `corrected_from` without
    // `did_you_mean`. That guess was often wrong AND it hid the real backend
    // bug (missing field). Backend now owns the correction copy entirely.
    assert.doesNotMatch(SHOP_PAGE_JS, /\b_inferCorrectedTerm\b/,
        '_inferCorrectedTerm removed — backend always populates did_you_mean when corrected_from is set (passover task 2)');
});

test('shop-page.js — brand text-match filter is replaced by direct brand.slug read', () => {
    // The previous implementation walked every product, lowercased and
    // stripped its name, and substring-matched against every brand keyword.
    // Replaced with `product.brand?.slug` reads.
    //
    // Regression guard: the most distinctive shape of the old code was the
    // `nameNoSpace` variable used to do collapsed substring matching.
    assert.doesNotMatch(SHOP_PAGE_JS, /\bnameNoSpace\b/,
        'shop-page.js: brand-detection-by-string-match deleted — read product.brand.slug instead');
    assert.doesNotMatch(SHOP_PAGE_JS, /\bbrandNameNoSpace\b/,
        'shop-page.js: brand-detection-by-string-match deleted — read product.brand.slug instead');
});

test('shop-page.js — isCompatibleProduct trusts product.source (no name-substring fallback)', () => {
    // The previous implementation fell back to `name.includes(this.compatiblePrefix)`
    // for legacy data. That data no longer exists; the substring fallback
    // would silently mislabel any future product whose name happens to match.
    const m = SHOP_PAGE_JS.match(/const\s+isCompatibleProduct\s*=\s*\([^)]*\)\s*=>\s*[^;]+;/);
    assert.ok(m, 'expected an isCompatibleProduct definition in shop-page.js');
    assert.doesNotMatch(m[0], /compatiblePrefix/,
        'isCompatibleProduct must not fall back to name-substring matching against this.compatiblePrefix');
    assert.match(m[0], /product\.source\s*===\s*['"]compatible['"]/,
        'isCompatibleProduct must read product.source === "compatible"');
});

test('main.js — initBasicAutocomplete and its DOM are deleted', () => {
    // SmartSearch (search.js) is loaded synchronously before main.js on every
    // page that has a search form. The basic-autocomplete fallback was
    // unreachable in practice and ~210 lines of duplicated logic.
    assert.doesNotMatch(MAIN_JS, /\bfunction\s+initBasicAutocomplete\b/);
    assert.doesNotMatch(MAIN_JS, /API\.getAutocomplete\b/,
        'main.js: basic fallback used /api/search/autocomplete — gone, SmartSearch uses /api/search/suggest');
});

test('ink-finder.js — direct Supabase query path is deleted', () => {
    // The browser shouldn't be reaching into Supabase tables — schema names
    // were leaking into the bundle (`brands.id`, `printer_models.brand_id`).
    // Single API round-trip via /api/printers/search now.
    assert.doesNotMatch(INK_FINDER_JS, /supabaseClient\.from\(/,
        'ink-finder.js must not query Supabase directly');
    assert.doesNotMatch(INK_FINDER_JS, /\.from\(\s*['"]printer_models['"]\s*\)/,
        'ink-finder.js must not reference the printer_models table directly');
    assert.doesNotMatch(INK_FINDER_JS, /\.from\(\s*['"]brands['"]\s*\)/,
        'ink-finder.js must not reference the brands table directly');
});

test('account.js — direct Supabase query path is deleted', () => {
    // Same change as ink-finder.js — printer registration tab.
    assert.doesNotMatch(ACCOUNT_JS, /\.from\(\s*['"]printer_models['"]\s*\)/,
        'account.js must not reference the printer_models table directly');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bucket C forward-compat — backend response fields are read when present
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — reads smartData.intent.matched_brand_slug for brand narrowing', () => {
    // When backend ships `data.intent.matched_brand_slug`, shop-page.js
    // should prefer it over the first-product heuristic.
    assert.match(SHOP_PAGE_JS, /smartData\?\.intent\?\.matched_brand_slug/,
        'shop-page.js must prefer intent.matched_brand_slug from backend (passover task 1) over local heuristic');
});

test('shop-page.js — re-fires getRibbons only when smartData.intent.type === "ribbon"', () => {
    // The intent-driven re-fire is a forward-compat shim. Once backend ships
    // task 4 (ribbons in /smart natively), this branch becomes unreachable.
    // Asserting on the literal string locks the contract field name.
    assert.match(SHOP_PAGE_JS, /smartData\?\.intent\?\.type\s*===\s*['"]ribbon['"]/,
        'shop-page.js must read intent.type === "ribbon" from backend response (passover task 1)');
});

test('shop-page.js — reads smartData.recovery.rails when present', () => {
    // Forward-compat for backend-passover task 3: backend tells frontend
    // which zero-result rails to fire so we don't probe with looksLikeSku.
    assert.match(SHOP_PAGE_JS, /smartData\?\.recovery\?\.rails/,
        'shop-page.js must read recovery.rails from backend (passover task 3) before falling back to looksLikeSku');
    // Sanity: looksLikeSku still exists as the fallback path.
    assert.match(SHOP_PAGE_JS, /\blooksLikeSku\b/,
        'looksLikeSku stays as the legacy heuristic until backend ships recovery.rails');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bucket A — UX-only behaviors stay on frontend (sanity check)
// ─────────────────────────────────────────────────────────────────────────────

test('search.js — debounce / abort / recent-cache / trending-cache stay on frontend', () => {
    const SEARCH_JS = READ('search.js');
    assert.match(SEARCH_JS, /DEBOUNCE_MS\s*=\s*250/,
        'debounce stays on frontend — UX-only, server can\'t do this');
    assert.match(SEARCH_JS, /AbortController/,
        'AbortController stays on frontend — cancels stale inflight requests');
    assert.match(SEARCH_JS, /RECENT_KEY/,
        'recent searches in localStorage stay on frontend — user-private, no round-trip needed');
    assert.match(SEARCH_JS, /TRENDING_CACHE_KEY/,
        'trending cache stays on frontend — bandwidth optimization (1 h TTL)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavior — the slimmed search-normalize.js still works for its one caller
// ─────────────────────────────────────────────────────────────────────────────

function loadSearchNormalize() {
    // search-normalize.js writes the global as `window.SearchNormalize = ...`,
    // so we read it back from the sandbox's `window`. We then JSON-roundtrip
    // any returned object so it crosses the vm context boundary cleanly
    // (otherwise deepStrictEqual fails on differing prototypes).
    const sandbox = { window: {}, console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SEARCH_NORMALIZE_JS, sandbox, { filename: 'search-normalize.js' });
    const SN = sandbox.window.SearchNormalize;
    return {
        detectProductType: (q) => {
            const r = SN.detectProductType(q);
            return r == null ? r : JSON.parse(JSON.stringify(r));
        },
        keys: () => Object.keys(SN).sort(),
    };
}

test('SearchNormalize.detectProductType — single-word ribbon matches', () => {
    const SN = loadSearchNormalize();
    const got = SN.detectProductType('ribbon');
    assert.deepStrictEqual(got, { keyword: 'ribbon', productParams: { type: 'ribbon' }, fetchRibbons: true });
});

test('SearchNormalize.detectProductType — single-word toner matches', () => {
    const SN = loadSearchNormalize();
    const got = SN.detectProductType('toner');
    assert.deepStrictEqual(got, { keyword: 'toner', productParams: { category: 'toner' }, fetchRibbons: false });
});

test('SearchNormalize.detectProductType — multi-word query returns null (not a type keyword)', () => {
    const SN = loadSearchNormalize();
    assert.equal(SN.detectProductType('brother toner'), null);
    assert.equal(SN.detectProductType('hp ink'), null);
});

test('SearchNormalize.detectProductType — non-keyword returns null', () => {
    const SN = loadSearchNormalize();
    assert.equal(SN.detectProductType('canon'), null);
    assert.equal(SN.detectProductType('brother mfc-l2750dw'), null);
});

test('SearchNormalize.detectProductType — empty / nullish input returns null', () => {
    const SN = loadSearchNormalize();
    assert.equal(SN.detectProductType(''), null);
    assert.equal(SN.detectProductType(null), null);
    assert.equal(SN.detectProductType(undefined), null);
    assert.equal(SN.detectProductType(123), null);
});

test('SearchNormalize.detectProductType — case insensitive', () => {
    const SN = loadSearchNormalize();
    const got = SN.detectProductType('RIBBON');
    assert.equal(got?.keyword, 'ribbon');
});

test('SearchNormalize — only detectProductType is exported (everything else deleted)', () => {
    const SN = loadSearchNormalize();
    assert.deepStrictEqual(SN.keys(), ['detectProductType'],
        'SearchNormalize should export only detectProductType after the audit');
});

// ─────────────────────────────────────────────────────────────────────────────
// File-size sanity — the slim search-normalize.js should be ~80 lines, not 481
// ─────────────────────────────────────────────────────────────────────────────

test('search-normalize.js — slimmed to ≤120 lines (was 481 before audit)', () => {
    const lines = SEARCH_NORMALIZE_JS.split('\n').length;
    assert.ok(lines <= 120,
        `search-normalize.js is ${lines} lines; expected ≤120 after the audit. ` +
        `If you added back logic that backend should own, see readfirst/SEARCH_AUDIT.md.`);
});
