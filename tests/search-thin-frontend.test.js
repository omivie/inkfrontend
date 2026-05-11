/**
 * Search — thin-frontend contract tests
 * ======================================
 *
 * Pins the search-bar audit outcome (2026-05-03 audit + 2026-05-11 backend
 * thin-contract delivery). Durable spec lives in this file's assertions.
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
// Note: js/search-normalize.js was deleted 2026-05-11 once backend shipped
// data.intent (the last live caller went away). The deletion is asserted
// directly below — no source read needed.
const SHOP_PAGE_JS        = READ('shop-page.js');
const MAIN_JS             = READ('main.js');
const INK_FINDER_JS       = READ('ink-finder.js');
const ACCOUNT_JS          = READ('account.js');

const SHOP_PAGE_CODE        = stripComments(SHOP_PAGE_JS);
const MAIN_CODE             = stripComments(MAIN_JS);
const INK_FINDER_CODE       = stripComments(INK_FINDER_JS);
const ACCOUNT_CODE          = stripComments(ACCOUNT_JS);

// ─────────────────────────────────────────────────────────────────────────────
// Bucket B regression guards — dead code stays deleted
// ─────────────────────────────────────────────────────────────────────────────

test('search-normalize.js module is fully deleted (zero callers after backend intent shipped)', () => {
    // 2026-05-11: backend `/smart` and `/suggest` now emit `data.intent`,
    // so the last live caller in shop-page.js (`detectProductType`) was
    // removed. The whole module deletes — no FE file imports SearchNormalize
    // and no script tag loads it. This guard prevents accidental
    // resurrection.
    const file = path.join(ROOT, 'inkcartridges', 'js', 'search-normalize.js');
    assert.strictEqual(fs.existsSync(file), false,
        'inkcartridges/js/search-normalize.js must stay deleted — backend owns intent classification');
    assert.doesNotMatch(SHOP_PAGE_CODE, /\bSearchNormalize\b/,
        'shop-page.js must not reference SearchNormalize — read smartData.intent.type instead');
    const SHOP_HTML = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
    assert.doesNotMatch(SHOP_HTML, /search-normalize\.js/,
        'shop.html must not load search-normalize.js — module is deleted');
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

test('html — no page loads search-normalize.js (module deleted 2026-05-11)', () => {
    // search-normalize.js was retired once backend shipped data.intent;
    // every script tag must be gone or shop.html will 404 on load.
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
    assert.deepStrictEqual(rels, [],
        `search-normalize.js must not be loaded anywhere. Found loaders: ${rels.join(', ')}`);
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

test('shop-page.js — does NOT re-fire getRibbons on the search-results path (backend includes ribbons inline)', () => {
    // 2026-05-11: backend `/smart` returns ribbon-typed rows inline at score
    // 150 when intent.type==='ribbon'. The parallel API.getRibbons fallback
    // was deleted from loadSearchResults — the only remaining API.getRibbons
    // call is the ribbon-page count probe at the top of shop-page.js.
    const body = loadSearchResultsBody();
    assert.doesNotMatch(body, /API\.getRibbons/,
        'loadSearchResults must not call API.getRibbons — backend ships ribbons inline in /smart');
    // The looksLikeSku heuristic also retired the same day.
    assert.doesNotMatch(SHOP_PAGE_CODE, /\blooksLikeSku\b/,
        'looksLikeSku heuristic deleted — backend `data.recovery.rails` is the source of truth');
});

test('shop-page.js — reads smartData.recovery.rails as the source of truth', () => {
    // Backend `data.recovery.rails[]` lists exactly which rails to fire.
    // We trust the list directly — no probing fallback.
    assert.match(SHOP_PAGE_CODE, /smartData\?\.recovery\?\.rails/,
        'shop-page.js must read recovery.rails from backend');
    // The `compat-printers` rail ships printers inline so we skip the
    // round-trip when present.
    assert.match(SHOP_PAGE_CODE, /Array\.isArray\(rail\.printers\)/,
        'shop-page.js must use rail.printers inline when present (backend ships them in the rail payload)');
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
// File-size sanity — main.js stays slim after the autocomplete deletion
// ─────────────────────────────────────────────────────────────────────────────

test('main.js — slimmed (initBasicAutocomplete deletion takes ~210 lines)', () => {
    const lines = MAIN_JS.split('\n').length;
    // 520 floor was set after the May 2026 search-thin-frontend audit; the
    // navbar-parity rollout (May 2026) added initActiveNavLink (~33 lines)
    // so the new ceiling is 555. If main.js grows past this, audit before
    // bumping — the spirit of this test is "don't re-grow what we deleted".
    assert.ok(lines <= 555,
        `main.js is ${lines} lines; expected ≤555. If you've added a load-bearing feature, document it; if you've re-introduced deleted search logic, see readfirst/SEARCH_AUDIT.md.`);
});
