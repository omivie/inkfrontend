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

// Strip JS comments so regression-guard regexes can't match docstring/comment
// mentions of code patterns we're about to forbid (e.g. a comment reading
// "the previous `.from('printer_models')` lookup was deleted" should not
// trigger a regex that bans the live call).
function stripComments(src) {
    return src
        // Block comments — non-greedy
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // Line comments — to end of line
        .replace(/\/\/[^\n]*/g, '');
}

// Cached source reads. The *_CODE variants have comments stripped.
const SEARCH_NORMALIZE_JS = READ('search-normalize.js');
const SHOP_PAGE_JS        = READ('shop-page.js');
const MAIN_JS             = READ('main.js');
const INK_FINDER_JS       = READ('ink-finder.js');
const ACCOUNT_JS          = READ('account.js');

const SEARCH_NORMALIZE_CODE = stripComments(SEARCH_NORMALIZE_JS);
const SHOP_PAGE_CODE        = stripComments(SHOP_PAGE_JS);
const MAIN_CODE             = stripComments(MAIN_JS);
const INK_FINDER_CODE       = stripComments(INK_FINDER_JS);
const ACCOUNT_CODE          = stripComments(ACCOUNT_JS);

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
        assert.doesNotMatch(SEARCH_NORMALIZE_CODE, re,
            `search-normalize.js must not contain ${re} — it was dead code; backend already does this work`);
    }
    // The one survivor:
    assert.match(SEARCH_NORMALIZE_CODE, /\bfunction\s+detectProductType\b/,
        'detectProductType stays as a shim until backend ships data.intent (see backend-passover task 1)');
});

test('shop-page.js — _inferCorrectedTerm heuristic is deleted', () => {
    // The heuristic counted brand frequencies across the result set to guess
    // a correction term when backend returned `corrected_from` without
    // `did_you_mean`. That guess was often wrong AND it hid the real backend
    // bug (missing field). Backend now owns the correction copy entirely.
    assert.doesNotMatch(SHOP_PAGE_CODE, /\b_inferCorrectedTerm\b/,
        '_inferCorrectedTerm removed — backend always populates did_you_mean when corrected_from is set (passover task 2)');
});

// Extract just the loadSearchResults function body — these tests are scoped
// to the search-bar refactor; other level-loaders (loadBrandProducts etc.)
// have their own duplicate copies of the same anti-patterns that this audit
// did NOT touch (they're tracked separately, see end of SEARCH_AUDIT.md).
function loadSearchResultsBody() {
    const m = SHOP_PAGE_CODE.match(/async\s+loadSearchResults\s*\([^)]*\)\s*\{[\s\S]+?\n\s{8}\},\s*\n/);
    assert.ok(m, 'expected loadSearchResults function in shop-page.js');
    return m[0];
}

test('shop-page.js loadSearchResults — brand text-match filter is replaced by direct brand.slug read', () => {
    const body = loadSearchResultsBody();
    // The previous implementation walked every product, lowercased and
    // stripped its name, and substring-matched against every brand keyword.
    // Replaced with `product.brand?.slug` reads inside the search-results path.
    assert.doesNotMatch(body, /\bnameNoSpace\b/,
        'loadSearchResults: brand-detection-by-string-match deleted — read product.brand.slug instead');
    assert.doesNotMatch(body, /\bbrandNameNoSpace\b/,
        'loadSearchResults: brand-detection-by-string-match deleted — read product.brand.slug instead');
    assert.match(body, /product\.brand\?\.slug|p\.brand\?\.slug/,
        'loadSearchResults must read brand.slug directly from each product');
});

test('shop-page.js loadSearchResults — isCompatibleProduct trusts product.source (no name-substring fallback)', () => {
    const body = loadSearchResultsBody();
    // The previous implementation fell back to `name.includes(this.compatiblePrefix)`
    // for legacy data. That data no longer exists; the substring fallback
    // would silently mislabel any future product whose name happens to match.
    const m = body.match(/const\s+isCompatibleProduct\s*=\s*[\s\S]+?;/);
    assert.ok(m, 'expected an isCompatibleProduct definition inside loadSearchResults');
    assert.doesNotMatch(m[0], /compatiblePrefix/,
        'loadSearchResults isCompatibleProduct must not fall back to name-substring matching');
    assert.match(m[0], /\.source\s*===\s*['"]compatible['"]/,
        'loadSearchResults isCompatibleProduct must read source === "compatible"');
});

test('main.js — initBasicAutocomplete and its DOM are deleted', () => {
    // SmartSearch (search.js) is loaded synchronously before main.js on every
    // page that has a search form. The basic-autocomplete fallback was
    // unreachable in practice and ~210 lines of duplicated logic.
    assert.doesNotMatch(MAIN_CODE, /\bfunction\s+initBasicAutocomplete\b/);
    assert.doesNotMatch(MAIN_CODE, /API\.getAutocomplete\b/,
        'main.js: basic fallback used /api/search/autocomplete — gone, SmartSearch uses /api/search/suggest');
});

test('api.js — dead autocomplete wrappers stay deleted (getAutocomplete, getAutocompleteRich)', () => {
    // initBasicAutocomplete was deleted; nothing in the storefront calls
    // /api/search/autocomplete any more. Suggest is the typeahead endpoint
    // (invoked directly by search.js's fetchSuggest), smart is the results
    // endpoint (via API.smartSearch).
    //
    // searchByPart was previously listed here as "never called" — it's now
    // restored intentionally for the May 2026 search-enrichment contract
    // (search-enrichment-may2026.md). Symmetric pair with searchByPrinter,
    // both go through _normalizeRpcSearchResponse so RPC-path products with
    // `product_id` instead of `id` get normalized for the renderer.
    const API_CODE = stripComments(READ('api.js'));
    assert.doesNotMatch(API_CODE, /\basync\s+getAutocomplete\s*\(/,
        'api.js: getAutocomplete was unused after basic-autocomplete deletion');
    assert.doesNotMatch(API_CODE, /\basync\s+getAutocompleteRich\s*\(/,
        'api.js: getAutocompleteRich was never called');
    // Confirm the survivors:
    assert.match(API_CODE, /\basync\s+smartSearch\s*\(/,
        'smartSearch is canonical; must stay');
    assert.match(API_CODE, /\basync\s+searchByPrinter\s*\(/,
        'searchByPrinter wraps /api/search/by-printer; must stay');
    assert.match(API_CODE, /\basync\s+searchByPart\s*\(/,
        'searchByPart wraps /api/search/by-part; must stay (May 2026 enrichment)');
});

test('api.js — dead `searchConfig` fallback in smartSearch is deleted', () => {
    // The previous code: `(typeof searchConfig !== 'undefined' ? searchConfig.apiUrl : '/api/search/smart')`
    // — `searchConfig` was never defined anywhere; the right-hand fallback was
    // the only branch ever taken. Inlined to its actual value.
    const API_CODE = stripComments(READ('api.js'));
    assert.doesNotMatch(API_CODE, /typeof\s+searchConfig\s*!==/,
        'api.js: dead searchConfig defensive check deleted');
    // Sanity: smartSearch still hits /api/search/smart.
    assert.match(API_CODE, /['"`]\/api\/search\/smart\?\$\{params\}['"`]|\/api\/search\/smart/,
        'api.js: smartSearch still calls /api/search/smart');
});

test('shop-page.js — `compatiblePrefix` field and all four duplicate substring fallbacks are deleted', () => {
    // The 2026-05-03 audit removed the search-results substring fallback
    // first. The four remaining duplicates (loadCategoryProducts /
    // loadCodeProducts / loadPrinterProducts / and the paper-products inline)
    // all checked `name.includes(this.compatiblePrefix)` for legacy data shape
    // that no longer exists. Sweeping all five turns isCompatibleProduct into
    // a one-liner everywhere and lets us delete the now-orphan
    // `compatiblePrefix` config field.
    assert.doesNotMatch(SHOP_PAGE_CODE, /\bcompatiblePrefix\s*:\s*['"]/,
        'shop-page.js: compatiblePrefix config field deleted (no remaining callers)');
    assert.doesNotMatch(SHOP_PAGE_CODE, /this\.compatiblePrefix/,
        'shop-page.js: no isCompatibleProduct may reference this.compatiblePrefix');
    // Every isCompatibleProduct definition must be the one-liner shape now.
    const defs = SHOP_PAGE_CODE.match(/const\s+isCompatibleProduct\s*=\s*[^;]+;/g) || [];
    assert.ok(defs.length >= 1, 'expected at least one isCompatibleProduct definition');
    for (const d of defs) {
        assert.match(d, /\.source\s*===\s*['"]compatible['"]/,
            `isCompatibleProduct must read .source === "compatible". Got: ${d}`);
    }
});

test('shop-page.js loadBrandProducts — brand text-match fallback is replaced by direct brand.slug filter', () => {
    // The previous filterByBrand walked every product, lowercased and stripped
    // both name and brand-name, substring-matched against brandNameNoSpace,
    // and even tried `name.replace(/^(compatible|genuine)\s+/, '')` to handle
    // names with the source prefix. All workarounds for a data shape that no
    // longer exists. Replaced with `p.brand?.slug === brandSlug`.
    assert.doesNotMatch(SHOP_PAGE_CODE, /\bbrandNameNoSpace\b/,
        'shop-page.js loadBrandProducts: collapsed brand-keyword matching deleted');
    assert.doesNotMatch(SHOP_PAGE_CODE, /\bnameWithoutPrefix\b/,
        'shop-page.js loadBrandProducts: source-prefix stripping fallback deleted');
});

test('html — search-normalize.js loads only on shop.html (the one consumer)', () => {
    // search-normalize.js is consumed by shop-page.js's loadSearchResults
    // exclusively. Loading it on every other page was wasted bandwidth.
    const fs = require('node:fs');
    const path = require('node:path');
    function listHtml(dir, acc = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.vercel') continue;
                listHtml(path.join(dir, e.name), acc);
            } else if (e.name.endsWith('.html')) acc.push(path.join(dir, e.name));
        }
        return acc;
    }
    const htmls = listHtml(path.join(ROOT, 'inkcartridges'));
    const loaders = htmls.filter(p => /<script[^>]*src="\/js\/search-normalize\.js/.test(fs.readFileSync(p, 'utf8')));
    const rels = loaders.map(p => path.relative(path.join(ROOT, 'inkcartridges'), p)).sort();
    assert.deepStrictEqual(rels, ['html/shop.html'],
        `Only shop.html should load search-normalize.js. Found loaders: ${rels.join(', ')}`);
});

test('ink-finder.js — direct Supabase query path is deleted', () => {
    // The browser shouldn't be reaching into Supabase tables — schema names
    // were leaking into the bundle (`brands.id`, `printer_models.brand_id`).
    // Single API round-trip via /api/printers/search now.
    assert.doesNotMatch(INK_FINDER_CODE, /supabaseClient\.from\(/,
        'ink-finder.js must not query Supabase directly');
    assert.doesNotMatch(INK_FINDER_CODE, /\.from\(\s*['"]printer_models['"]\s*\)/,
        'ink-finder.js must not reference the printer_models table directly');
    assert.doesNotMatch(INK_FINDER_CODE, /\.from\(\s*['"]brands['"]\s*\)/,
        'ink-finder.js must not reference the brands table directly');
});

test('account.js — direct Supabase query path is deleted', () => {
    // Same change as ink-finder.js — printer registration tab.
    assert.doesNotMatch(ACCOUNT_CODE, /\.from\(\s*['"]printer_models['"]\s*\)/,
        'account.js must not reference the printer_models table directly');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bucket C forward-compat — backend response fields are read when present
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — reads smartData.intent.matched_brand_slug for brand narrowing', () => {
    // When backend ships `data.intent.matched_brand_slug`, shop-page.js
    // should prefer it over the first-product heuristic.
    assert.match(SHOP_PAGE_CODE, /smartData\?\.intent\?\.matched_brand_slug/,
        'shop-page.js must prefer intent.matched_brand_slug from backend (passover task 1) over local heuristic');
});

test('shop-page.js — re-fires getRibbons only when smartData.intent.type === "ribbon"', () => {
    // The intent-driven re-fire is a forward-compat shim. Once backend ships
    // task 4 (ribbons in /smart natively), this branch becomes unreachable.
    // Asserting on the literal string locks the contract field name.
    assert.match(SHOP_PAGE_CODE, /smartData\?\.intent\?\.type\s*===\s*['"]ribbon['"]/,
        'shop-page.js must read intent.type === "ribbon" from backend response (passover task 1)');
});

test('shop-page.js — reads smartData.recovery.rails when present', () => {
    // Forward-compat for backend-passover task 3: backend tells frontend
    // which zero-result rails to fire so we don't probe with looksLikeSku.
    assert.match(SHOP_PAGE_CODE, /smartData\?\.recovery\?\.rails/,
        'shop-page.js must read recovery.rails from backend (passover task 3) before falling back to looksLikeSku');
    // Sanity: looksLikeSku still exists as the fallback path.
    assert.match(SHOP_PAGE_CODE, /\blooksLikeSku\b/,
        'looksLikeSku stays as the legacy heuristic until backend ships recovery.rails');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bucket A — UX-only behaviors stay on frontend (sanity check)
// ─────────────────────────────────────────────────────────────────────────────

test('search.js — debounce / abort / recent-cache / trending-cache stay on frontend', () => {
    const SEARCH_CODE = stripComments(READ('search.js'));
    assert.match(SEARCH_CODE, /DEBOUNCE_MS\s*=\s*250/,
        'debounce stays on frontend — UX-only, server can\'t do this');
    assert.match(SEARCH_CODE, /AbortController/,
        'AbortController stays on frontend — cancels stale inflight requests');
    assert.match(SEARCH_CODE, /RECENT_KEY/,
        'recent searches in localStorage stay on frontend — user-private, no round-trip needed');
    assert.match(SEARCH_CODE, /TRENDING_CACHE_KEY/,
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

test('main.js — slimmed (initBasicAutocomplete deletion takes ~210 lines)', () => {
    const lines = MAIN_JS.split('\n').length;
    assert.ok(lines <= 520,
        `main.js is ${lines} lines; expected ≤520 after deleting initBasicAutocomplete.`);
});
