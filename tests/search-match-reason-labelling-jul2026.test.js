/**
 * Search UX — match_reason labelling + correction/intent notices — July 2026
 * ==========================================================================
 *
 * The spec (search-ux-frontend-spec-jul2026.md)
 * ---------------------------------------------
 * /api/search/smart stamps a provenance tag on rows that aren't a literal
 * keyword hit (`match_reason`: semantic | fuzzy | compatibility | null) and can
 * set `corrected_from` (an auto-corrected query) and `intent` (brand/category/
 * source). The frontend's job is to make WHY a result set looks the way it does
 * legible. The compatibility chip, did-you-mean banner, recovery rails, printer
 * hero and savings pill already shipped; this suite pins the three gaps closed
 * here:
 *
 *   §1  semantic  → "Best matches for your search" notice when ALL rows are
 *                   semantic; a per-card "Suggested" chip when only SOME are.
 *       fuzzy     → "Showing results similar to '<matched_token>'" banner.
 *   §2  corrected_from + did_you_mean → "Showing results for X. Search instead
 *                   for Y." with the link re-running the ORIGINAL raw query.
 *   §5  intent    → a non-filtering brand/category/source chip row.
 *
 * Never surface the raw enum; escape every dynamic string.
 *
 * Run: node --test tests/search-match-reason-labelling-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHOP_JS_PATH   = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const SEARCH_CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'search.css');

const SHOP_SRC   = fs.readFileSync(SHOP_JS_PATH, 'utf8');
const SEARCH_CSS = fs.readFileSync(SEARCH_CSS_PATH, 'utf8');

// Strip comments so a literal inside a comment can't satisfy a source assertion.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure helpers out of shop-page.js (only top-level declarations run on
// load — the DrilldownNav methods never execute). Mirrors
// tests/compat-search-badge-jul2026.test.js.
// ─────────────────────────────────────────────────────────────────────────────
function loadShopHelpers() {
    const doc = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} },
        documentElement: { style: {} },
        cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    const helpers = sandbox.window._searchParityHelpers;
    assert.ok(helpers, 'shop-page.js must expose window._searchParityHelpers');
    return helpers;
}

// ═════════════════════════════════════════════════════════════════════════════
// summarizeMatchReasons — the labelling decision function
// ═════════════════════════════════════════════════════════════════════════════
test('summarizeMatchReasons — exported on the parity hook', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    assert.equal(typeof summarizeMatchReasons, 'function');
});

test('summarizeMatchReasons — all rows semantic → allSemantic true', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    const s = summarizeMatchReasons([
        { sku: 'a', match_reason: 'semantic' },
        { sku: 'b', match_reason: 'semantic' },
    ]);
    assert.equal(s.total, 2);
    assert.equal(s.semantic, 2);
    assert.equal(s.allSemantic, true);
    assert.equal(s.hasSemantic, true);
});

test('summarizeMatchReasons — partial semantic → hasSemantic true, allSemantic false', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    const s = summarizeMatchReasons([
        { sku: 'a', match_reason: 'semantic' },
        { sku: 'b', match_reason: null },           // a literal hit
        { sku: 'c' },                                // no reason at all
    ]);
    assert.equal(s.semantic, 1);
    assert.equal(s.hasSemantic, true);
    assert.equal(s.allSemantic, false,
        'a single non-semantic row must break the all-semantic header path');
});

test('summarizeMatchReasons — fuzzyToken is taken from the first fuzzy row', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    const s = summarizeMatchReasons([
        { sku: 'a', match_reason: 'fuzzy', matched_token: 'tn2540' },
        { sku: 'b', match_reason: 'fuzzy', matched_token: 'tn2550' },
    ]);
    assert.equal(s.fuzzy, 2);
    assert.equal(s.fuzzyToken, 'tn2540');
    assert.equal(s.allSemantic, false);
});

test('summarizeMatchReasons — compatibility rows counted, not mistaken for semantic', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    const s = summarizeMatchReasons([
        { sku: 'a', match_reason: 'compatibility', matched_token: 'VP6000' },
    ]);
    assert.equal(s.compatibility, 1);
    assert.equal(s.semantic, 0);
    assert.equal(s.hasSemantic, false);
    assert.equal(s.allSemantic, false);
    assert.equal(s.fuzzyToken, null);
});

test('summarizeMatchReasons — safe on null / empty / malformed input', () => {
    const { summarizeMatchReasons } = loadShopHelpers();
    for (const bad of [null, undefined, 'nope', 42, {}]) {
        const s = summarizeMatchReasons(bad);
        assert.equal(s.total, 0);
        assert.equal(s.allSemantic, false);
        assert.equal(s.hasSemantic, false);
        assert.equal(s.fuzzyToken, null);
    }
    // Array with holes/nulls must not throw and must not count the holes.
    const s = summarizeMatchReasons([null, undefined, { match_reason: 'semantic' }]);
    assert.equal(s.total, 1);
    assert.equal(s.semantic, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// loadSearchResults — per-row "Suggested" tagging + corrected_from sanity-drop
// ═════════════════════════════════════════════════════════════════════════════
test('loadSearchResults — computes a reasonSummary from the final product set', () => {
    assert.match(SHOP_CODE, /const\s+reasonSummary\s*=\s*summarizeMatchReasons\(products\)/);
});

test('loadSearchResults — _suggestedChip tagging is gated on partial-semantic', () => {
    // Isolate the tagging block and confirm it only fires when hasSemantic AND
    // NOT allSemantic (an all-semantic set gets a section notice, not chips).
    const m = SHOP_CODE.match(/if\s*\(reasonSummary\.hasSemantic\s*&&\s*!reasonSummary\.allSemantic\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, 'the partial-semantic guard must exist');
    assert.match(m[1], /p\.match_reason\s*===\s*['"]semantic['"]/,
        'only semantic rows may be tagged');
    assert.match(m[1], /p\._suggestedChip\s*=\s*true/,
        'tagged rows must set _suggestedChip');
});

test('loadSearchResults — sanity-drop nulls BOTH did_you_mean and corrected_from', () => {
    // When /smart kept products that literally match the query, the correction
    // is a misfire — drop both banners so we never claim a swap we didn't make.
    const m = SHOP_CODE.match(/bannerData\s*=\s*Object\.assign\(\{\}\,\s*smartData\,\s*\{([^}]*)\}\)/);
    assert.ok(m, 'the bannerData clone must exist');
    assert.match(m[1], /did_you_mean:\s*null/, 'did_you_mean must be nulled');
    assert.match(m[1], /corrected_from:\s*null/, 'corrected_from must be nulled too');
});

// ═════════════════════════════════════════════════════════════════════════════
// renderSearchBanners — §2 correction banner
// ═════════════════════════════════════════════════════════════════════════════
test('renderSearchBanners — correction banner requires BOTH corrected_from and did_you_mean', () => {
    assert.match(SHOP_CODE, /if\s*\(correctedFrom\s*&&\s*didYouMean\)/,
        'the "Showing results for X" banner must be gated on corrected_from + did_you_mean');
    assert.match(SHOP_CODE, /search-correction-banner/,
        'the correction banner must use the .search-correction-banner class');
});

test('renderSearchBanners — the "search instead" link re-runs the ORIGINAL raw query in exact mode', () => {
    // href must carry corrected_from (the original), not did_you_mean (the swap),
    // AND exact=1 so re-running it shows literal results / an honest zero-state
    // instead of looping back through /smart's autocorrect.
    assert.match(SHOP_CODE, /search-correction-banner__link[\s\S]*?href="\/search\?q=\$\{encodeURIComponent\(correctedFrom\)\}&exact=1"/,
        'the search-instead link must point at /search?q=<corrected_from>&exact=1');
});

// ═════════════════════════════════════════════════════════════════════════════
// exact mode — "Search instead" honours the raw query without re-correcting
// ═════════════════════════════════════════════════════════════════════════════
test('parseURLState — reads exact=1 into state.exact', () => {
    assert.match(SHOP_CODE, /this\.state\.exact\s*=\s*params\.get\(['"]exact['"]\)\s*===\s*['"]1['"]/);
});

test('updateURL — preserves exact across in-app navigation', () => {
    assert.match(SHOP_CODE, /if\s*\(this\.state\.search\s*&&\s*this\.state\.exact\)\s*params\.set\(['"]exact['"]\s*,\s*['"]1['"]\)/);
});

test('loadSearchResults — exact mode forces the literal path and prefers it unconditionally', () => {
    assert.match(SHOP_CODE, /const\s+exactMode\s*=\s*!!this\.state\.exact/);
    assert.match(SHOP_CODE, /if\s*\(hardMiss\s*\|\|\s*softMiss\s*\|\|\s*hijack\s*\|\|\s*exactMode\)/,
        'exact mode must trigger the literal fetch');
    const m = SHOP_CODE.match(/const\s+shouldUseFallback\s*=([\s\S]*?);/);
    assert.ok(m, 'shouldUseFallback must exist');
    assert.match(m[1], /exactMode\s*\?\s*true/,
        'exact mode must always prefer the literal set (even when empty → honest zero-state)');
});

test('renderSearchBanners — correction banner escapes both terms', () => {
    // did_you_mean shown as the corrected term, corrected_from as the raw query.
    const seg = SHOP_CODE.match(/if\s*\(correctedFrom\s*&&\s*didYouMean\)\s*\{([\s\S]*?)\}\s*else\s+if\s*\(didYouMean\)/);
    assert.ok(seg, 'correction branch must be followed by the did-you-mean-alone branch');
    assert.match(seg[1], /Security\.escapeHtml\(didYouMean\)/);
    assert.match(seg[1], /Security\.escapeHtml\(correctedFrom\)/);
});

test('renderSearchBanners — did-you-mean-alone branch is preserved', () => {
    assert.match(SHOP_CODE, /\}\s*else\s+if\s*\(didYouMean\)\s*\{[\s\S]*?search-did-you-mean/,
        'a did_you_mean without corrected_from must still render "Did you mean X?"');
});

// ═════════════════════════════════════════════════════════════════════════════
// renderSearchBanners — §1 fuzzy banner + semantic notice
// ═════════════════════════════════════════════════════════════════════════════
test('renderSearchBanners — fuzzy banner fires on a fuzzy token and is escaped', () => {
    assert.match(SHOP_CODE, /const\s+reasons\s*=\s*summarizeMatchReasons\(smartData\.products\)/,
        'banners must summarise the row match_reasons');
    const m = SHOP_CODE.match(/if\s*\(reasons\.fuzzyToken\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, 'the fuzzy-token guard must exist');
    assert.match(m[1], /search-similar-banner/, 'fuzzy banner uses .search-similar-banner');
    assert.match(m[1], /Security\.escapeHtml\(reasons\.fuzzyToken\)/, 'the token must be escaped');
});

test('renderSearchBanners — "Best matches" notice fires only when allSemantic', () => {
    const m = SHOP_CODE.match(/if\s*\(reasons\.allSemantic\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, 'the allSemantic guard must exist');
    assert.match(m[1], /search-best-matches/, 'notice uses .search-best-matches');
    assert.match(m[1], /Best matches for your search/, 'notice copy must be the spec label');
});

// ═════════════════════════════════════════════════════════════════════════════
// renderSearchBanners — §5 intent chip row
// ═════════════════════════════════════════════════════════════════════════════
test('renderSearchBanners — intent chips render brand/category/source, brand is a link', () => {
    const m = SHOP_CODE.match(/const\s+intent\s*=\s*smartData\.intent;([\s\S]*?)if\s*\(!wrap\.firstChild\)/);
    assert.ok(m, 'the intent chip block must exist before the mount guard');
    const seg = m[1];
    assert.match(seg, /intent\.matched_brand_slug/, 'brand chip keys on matched_brand_slug');
    assert.match(seg, /this\.brandInfo\[brandSlug\]/, 'brand name resolves via brandInfo');
    assert.match(seg, /search-intent-chip--brand[\s\S]*?href="\/shop\?brand=/, 'brand chip links to /shop?brand=');
    assert.match(seg, /intent\.category/, 'category chip keys on intent.category');
    assert.match(seg, /intent\.source\s*===\s*['"]genuine['"]/, 'source chip keys on intent.source');
    assert.match(seg, /Security\.escapeHtml\(brand\.name\)/, 'brand name must be escaped');
});

test('renderSearchBanners — banner wrapper is only mounted when a notice exists', () => {
    assert.match(SHOP_CODE, /if\s*\(!wrap\.firstChild\)\s*return;/,
        'an empty banner wrapper must not be inserted into the DOM');
    // The old unconditional early-return on (!matchedPrinter && !didYouMean) must
    // be gone — otherwise fuzzy/semantic/intent-only sets would render nothing.
    assert.doesNotMatch(SHOP_CODE, /if\s*\(!matchedPrinter\s*&&\s*!didYouMean\)\s*return;/,
        'the pre-fuzzy early return must be removed');
});

// ═════════════════════════════════════════════════════════════════════════════
// createProductCard — the "Suggested" chip
// ═════════════════════════════════════════════════════════════════════════════
test('createProductCard — suggestedBadge is gated on _suggestedChip', () => {
    const m = SHOP_CODE.match(/const\s+suggestedBadge\s*=([\s\S]*?);\n/);
    assert.ok(m, 'suggestedBadge must be defined in createProductCard');
    assert.match(m[1], /product\._suggestedChip/, 'chip must be gated on _suggestedChip');
    assert.match(m[1], /product-card__badge--suggested/, 'chip must carry the suggested CSS class');
});

test('createProductCard — chip-stack emits all three badges and appears when any exists', () => {
    assert.match(
        SHOP_CODE,
        /\(fitsPrinterBadge\s*\|\|\s*compatMatchBadge\s*\|\|\s*suggestedBadge\)\s*\?\s*`<div class="product-card__chip-stack">\$\{fitsPrinterBadge\}\$\{compatMatchBadge\}\$\{suggestedBadge\}<\/div>`/,
        'the chip-stack must include suggestedBadge and gate on any of the three'
    );
});

// ═════════════════════════════════════════════════════════════════════════════
// CSS
// ═════════════════════════════════════════════════════════════════════════════
test('search.css — defines every new selector', () => {
    assert.match(SEARCH_CSS, /\.product-card__badge--suggested\s*\{/, 'suggested badge style');
    assert.match(SEARCH_CSS, /\.search-similar-banner\s*\{/, 'fuzzy banner style');
    assert.match(SEARCH_CSS, /\.search-best-matches\s*\{/, 'best-matches notice style');
    assert.match(SEARCH_CSS, /\.search-intent-chips\s*\{/, 'intent chip row style');
    assert.match(SEARCH_CSS, /\.search-intent-chip\s*\{/, 'intent chip style');
});
