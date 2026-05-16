/**
 * Search-results ⇄ dropdown parity — May 2026
 * ============================================
 *
 * Pins the reconciliation that keeps the full results page (/search?q=…,
 * rendered by shop-page.js → /api/search/smart) showing the SAME products
 * as the typeahead dropdown (search.js → /api/search/suggest).
 *
 * The bug this fixes
 * ------------------
 * The two surfaces hit different backend endpoints. /api/search/suggest does
 * a plain literal-substring match. /api/search/smart classifies "intent" and
 * will autocorrect a query it judges ambiguous. For numeric cartridge codes
 * /smart misfires hard — verified live 2026-05-16:
 *
 *   /api/search/suggest?q=511  → 13 rows: Canon CL511, CL511CLR Tri-Colour,
 *                                Fuji Xerox CT3511xx … (what the user wants)
 *   /api/search/smart?q=511    → corrected_from:"511",
 *                                did_you_mean:"Lexmark MX 511",
 *                                4 Lexmark 603/500Z products that contain
 *                                "511" NOWHERE.
 *
 * So the dropdown showed the right products and the results page showed an
 * unrelated wall of Lexmark toner. The old soft-miss fallback in
 * loadSearchResults was gated behind `!smartData?.did_you_mean`, so the
 * moment /smart attached its bogus did_you_mean the fallback never ran.
 *
 * The fix (inkcartridges/js/shop-page.js + js/api.js)
 * --------------------------------------------------
 *   1. shop-page.js gains pure helpers — productMatchesQuery (literal match,
 *      the dropdown's notion of "match") and mergeLiteralResults (union the
 *      dropdown shortlist with the full literal set, dedup, dropdown order
 *      first). Exposed on window._searchParityHelpers for these tests.
 *   2. loadSearchResults detects a "hijack": /smart corrected the query AND
 *      none of its products literally match the input → fall back to the
 *      literal path. A genuine typo also trips it, but the literal endpoints
 *      return zero rows for a typo so the swap is declined.
 *   3. The fallback fires /api/products?search= (full, paginated) and
 *      /api/search/suggest (dropdown shortlist) in parallel and unions them.
 *   4. api.js gains API.searchSuggest — the dropdown's endpoint, surfaced so
 *      the results page can reconcile against it. Never throws → [] on miss.
 *   5. A stale did_you_mean banner is dropped when /smart's own products
 *      literally match the query (q=664 case).
 *
 * Run: node --test tests/search-results-parity-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHOP_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const API_JS_PATH  = path.join(ROOT, 'inkcartridges', 'js', 'api.js');

const SHOP_SRC = fs.readFileSync(SHOP_JS_PATH, 'utf8');
const API_SRC  = fs.readFileSync(API_JS_PATH, 'utf8');

// Strip comments so a literal inside a comment can't satisfy a source assertion.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const SHOP_CODE = stripComments(SHOP_SRC);
const API_CODE  = stripComments(API_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure reconciliation helpers out of shop-page.js. Only top-level
// declarations run on load (the DrilldownNav methods never execute), so a
// minimal sandbox is enough.
// ─────────────────────────────────────────────────────────────────────────────
function loadShopHelpers() {
    // shop-page.js builds its DrilldownNav.elements map eagerly with
    // document.getElementById(...) at load, so the DOM stub has to be
    // permissive — null nodes are fine, the methods just have to exist.
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

function loadApi() {
    const sandbox = {
        console,
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
        setTimeout, clearTimeout, AbortController,
        Headers: globalThis.Headers, URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon',
            settings: { FREE_SHIPPING_THRESHOLD: 100, GST_RATE: 0.15 },
            getSetting(key, fallback) { return this.settings[key] != null ? this.settings[key] : fallback; },
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: {
            _data: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
            setItem(k, v) { this._data[k] = String(v); },
            removeItem(k) { delete this._data[k]; },
        },
        document: { cookie: '' },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
    return sandbox;
}

// Live-verified fixtures (curl'd 2026-05-16). Trimmed to the shape the
// helpers actually read: id, sku, name, price/retail_price, is_genuine/source.
const SUGGEST_511 = [
    { id: 'd5cb47a7', sku: 'GCL511',    name: 'Canon Genuine CL511 Ink Cartridge Colour (244 pages)', price: 53.49, is_genuine: true },
    { id: 'b52475f7', sku: '165-11',    name: 'Olivetti ET121 / Panasonic JetWriter Compatible Typewriter Ribbon 165.11', price: 33.99, is_genuine: false },
    { id: '824c6ef1', sku: 'CCL511CLR', name: 'CL511CLR Compatible Ink Cartridge for Canon CL511 Tri-Colour', price: 61.49, is_genuine: false },
];
const PRODUCTS_511 = [
    { id: '824c6ef1', sku: 'CCL511CLR', name: 'CL511CLR Compatible Ink Cartridge for Canon CL511 Tri-Colour', retail_price: 61.49, source: 'compatible', canonical_url: 'https://x/p/CCL511CLR' },
    { id: 'd5cb47a7', sku: 'GCL511',    name: 'Canon Genuine CL511 Ink Cartridge Colour (244 pages)', retail_price: 53.49, source: 'genuine', canonical_url: 'https://x/p/GCL511' },
    { id: 'gct1',     sku: 'GCT351100BK', name: 'Fuji Xerox Genuine CT351100BK Drum Unit CT351100 Black (50,000 pages)', retail_price: 135.49, source: 'genuine' },
];
const LEXMARK_SMART_511 = [
    { id: 'lx1', sku: 'G603BK',  name: 'Lexmark Genuine 603BK Toner Cartridge 603 Black (2,500 pages)', source: 'genuine' },
    { id: 'lx2', sku: 'G500ZBK', name: 'Lexmark Genuine 500ZBK Drum Unit 500Z Black (60,000 pages)', source: 'genuine' },
];

// Values returned from the vm sandbox belong to a different realm, so
// assert.deepStrictEqual fails its prototype check against host literals.
// Re-home arrays into the host realm before comparing.
const isEmptyArray = (v) => Array.isArray(v) && v.length === 0;
const skuList = (arr) => Array.from(arr, (p) => p.sku);

// ═════════════════════════════════════════════════════════════════════════════
// productMatchesQuery — the literal-match gate
// ═════════════════════════════════════════════════════════════════════════════
test('productMatchesQuery — CL511 product matches the query "511"', () => {
    const { productMatchesQuery } = loadShopHelpers();
    assert.equal(productMatchesQuery(SUGGEST_511[0], '511'), true);
    assert.equal(productMatchesQuery(SUGGEST_511[2], '511'), true);
});

test('productMatchesQuery — Lexmark 603/500Z does NOT match "511" (the bug)', () => {
    const { productMatchesQuery } = loadShopHelpers();
    assert.equal(productMatchesQuery(LEXMARK_SMART_511[0], '511'), false);
    assert.equal(productMatchesQuery(LEXMARK_SMART_511[1], '511'), false);
    // → smartHasLiteralMatch is false for q=511, so loadSearchResults treats
    //   /smart's result set as a hijack and reconciles to the literal path.
});

test('productMatchesQuery — matches across punctuation (CT-351101 vs "351101")', () => {
    const { productMatchesQuery } = loadShopHelpers();
    assert.equal(productMatchesQuery({ name: 'Fuji Xerox CT-351101 Drum', sku: '' }, '351101'), true);
    assert.equal(productMatchesQuery({ name: 'CL511 Tri-Colour', sku: '' }, 'CL-511'), true);
});

test('productMatchesQuery — matches on SKU when the name does not carry the code', () => {
    const { productMatchesQuery } = loadShopHelpers();
    assert.equal(productMatchesQuery({ name: 'Generic Black Cartridge', sku: 'GCL511' }, '511'), true);
});

test('productMatchesQuery — a genuine typo finds no literal match anywhere', () => {
    const { productMatchesQuery } = loadShopHelpers();
    // "cannon" never appears literally — only "canon" does. The hijack guard
    // still trips, but the literal endpoints return 0 rows so the swap is
    // declined and /smart's autocorrect ("Canon") is kept.
    const canon = { name: 'BCI3BK Compatible Ink Cartridge for Canon BCI3 Black', sku: 'CBCI3BK' };
    assert.equal(productMatchesQuery(canon, 'cannon'), false);
});

test('productMatchesQuery — multi-token query needs every token present', () => {
    const { productMatchesQuery } = loadShopHelpers();
    const p = { name: 'Brother Genuine LC133BK Ink Cartridge LC133 Black', sku: 'GLC133BK' };
    assert.equal(productMatchesQuery(p, 'brother lc133'), true);
    assert.equal(productMatchesQuery(p, 'brother lc999'), false);
    assert.equal(productMatchesQuery(p, 'canon lc133'), false);
});

test('productMatchesQuery — empty / null query never matches', () => {
    const { productMatchesQuery } = loadShopHelpers();
    assert.equal(productMatchesQuery(SUGGEST_511[0], ''), false);
    assert.equal(productMatchesQuery(SUGGEST_511[0], null), false);
    assert.equal(productMatchesQuery(null, '511'), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// adaptSuggestProduct — /suggest payload → card shape
// ═════════════════════════════════════════════════════════════════════════════
test('adaptSuggestProduct — maps price→retail_price and is_genuine→source', () => {
    const { adaptSuggestProduct } = loadShopHelpers();
    const genuine = adaptSuggestProduct({ name: 'X', price: 9.5, is_genuine: true });
    assert.equal(genuine.retail_price, 9.5);
    assert.equal(genuine.source, 'genuine');
    const compat = adaptSuggestProduct({ name: 'Y', price: 4, is_genuine: false });
    assert.equal(compat.source, 'compatible');
});

test('adaptSuggestProduct — keeps an explicit source/retail_price untouched', () => {
    const { adaptSuggestProduct } = loadShopHelpers();
    const p = adaptSuggestProduct({ name: 'Z', retail_price: 12, source: 'genuine', price: 99 });
    assert.equal(p.retail_price, 12);
    assert.equal(p.source, 'genuine');
});

// ═════════════════════════════════════════════════════════════════════════════
// mergeLiteralResults — union dropdown shortlist + full literal set
// ═════════════════════════════════════════════════════════════════════════════
test('mergeLiteralResults — dedups the overlap (q=511: 3 suggest + 3 products → 4)', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(SUGGEST_511, PRODUCTS_511);
    // CCL511CLR and GCL511 appear in both lists; the ribbon (suggest-only)
    // and the CT351100BK drum (products-only) appear once each → 4 total.
    assert.equal(merged.length, 4);
    assert.deepEqual(skuList(merged).sort(), ['165-11', 'CCL511CLR', 'GCL511', 'GCT351100BK']);
});

test('mergeLiteralResults — dropdown order is preserved at the front', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(SUGGEST_511, PRODUCTS_511);
    // First three follow /suggest order exactly; products-only rows append.
    assert.deepEqual(skuList(merged).slice(0, 3), ['GCL511', '165-11', 'CCL511CLR']);
    assert.equal(merged[3].sku, 'GCT351100BK');
});

test('mergeLiteralResults — keeps a suggest-only row the products search missed', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(SUGGEST_511, PRODUCTS_511);
    // The "165.11" ribbon matches q=511 only on /suggest's looser digit
    // matching; without the union the results page would silently drop it.
    assert.ok(merged.some(p => p.sku === '165-11'), 'suggest-only ribbon must survive the merge');
});

test('mergeLiteralResults — the richer /products object wins a shared slot', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(SUGGEST_511, PRODUCTS_511);
    const clr = merged.find(p => p.sku === 'CCL511CLR');
    // /suggest omits canonical_url; /api/products carries it. The merged row
    // must be the richer one so the card links to the canonical product URL.
    assert.equal(clr.canonical_url, 'https://x/p/CCL511CLR');
});

test('mergeLiteralResults — suggest rows are adapted to card shape', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults(SUGGEST_511, []);
    for (const p of merged) {
        assert.ok(p.retail_price != null, `${p.sku} must carry retail_price`);
        assert.ok(p.source === 'genuine' || p.source === 'compatible', `${p.sku} must carry a source`);
    }
});

test('mergeLiteralResults — dedups by name when ids/skus differ', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const a = [{ id: 'a', sku: 'AAA', name: 'Canon CL511 Ink', price: 1, is_genuine: true }];
    const b = [{ id: 'b', sku: 'BBB', name: 'Canon CL511 Ink', retail_price: 1, source: 'genuine' }];
    assert.equal(mergeLiteralResults(a, b).length, 1);
});

test('mergeLiteralResults — handles empty / missing inputs', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    assert.ok(isEmptyArray(mergeLiteralResults([], [])));
    assert.ok(isEmptyArray(mergeLiteralResults(null, null)));
    assert.equal(mergeLiteralResults([], PRODUCTS_511).length, 3);
    assert.equal(mergeLiteralResults(SUGGEST_511, []).length, 3);
});

test('mergeLiteralResults — products-only rows keep their order after suggest', () => {
    const { mergeLiteralResults } = loadShopHelpers();
    const merged = mergeLiteralResults([], PRODUCTS_511);
    assert.deepEqual(skuList(merged), ['CCL511CLR', 'GCL511', 'GCT351100BK']);
});

// ═════════════════════════════════════════════════════════════════════════════
// API.searchSuggest — the dropdown endpoint, surfaced for reconciliation
// ═════════════════════════════════════════════════════════════════════════════
test('API.searchSuggest — exists and is async', () => {
    const sb = loadApi();
    assert.equal(typeof sb.API.searchSuggest, 'function');
});

test('API.searchSuggest — hits /api/search/suggest and returns the rows array', async () => {
    const sb = loadApi();
    let calledUrl = null;
    sb.API.get = async (url) => {
        calledUrl = url;
        return { ok: true, data: { suggestions: SUGGEST_511 } };
    };
    const rows = await sb.API.searchSuggest('511', 20);
    assert.match(calledUrl, /\/api\/search\/suggest\?/);
    assert.match(calledUrl, /q=511/);
    assert.match(calledUrl, /limit=20/);
    assert.equal(rows.length, 3);
});

test('API.searchSuggest — returns [] for queries shorter than 2 chars', async () => {
    const sb = loadApi();
    let called = false;
    sb.API.get = async () => { called = true; return { ok: true, data: { suggestions: [] } }; };
    assert.ok(isEmptyArray(await sb.API.searchSuggest('5')));
    assert.ok(isEmptyArray(await sb.API.searchSuggest('')));
    assert.equal(called, false, 'must not hit the network for a 1-char query');
});

test('API.searchSuggest — never throws; yields [] when the endpoint fails', async () => {
    const sb = loadApi();
    sb.API.get = async () => { throw new Error('network down'); };
    assert.ok(isEmptyArray(await sb.API.searchSuggest('511')));
    sb.API.get = async () => ({ ok: false, error: { message: 'boom' } });
    assert.ok(isEmptyArray(await sb.API.searchSuggest('511')));
    sb.API.get = async () => ({ ok: true, data: {} });
    assert.ok(isEmptyArray(await sb.API.searchSuggest('511')));
});

// ═════════════════════════════════════════════════════════════════════════════
// loadSearchResults — source-pattern guards (the wiring can't silently revert)
// ═════════════════════════════════════════════════════════════════════════════
test('shop-page.js — loadSearchResults computes a hijack flag', () => {
    assert.match(SHOP_CODE, /const\s+hijack\s*=/, 'hijack flag must exist');
    assert.match(SHOP_CODE, /smartHasLiteralMatch/, 'literal-match probe must exist');
    assert.match(SHOP_CODE,
        /const\s+smartHasLiteralMatch\s*=\s*products\.some\(\s*p\s*=>\s*productMatchesQuery\(p,\s*searchQuery\)\s*\)/,
        'smartHasLiteralMatch must scan /smart products with productMatchesQuery');
});

test('shop-page.js — fallback fires on hardMiss OR softMiss OR hijack', () => {
    assert.match(SHOP_CODE, /if\s*\(\s*hardMiss\s*\|\|\s*softMiss\s*\|\|\s*hijack\s*\)/);
});

test('shop-page.js — the !did_you_mean gate no longer blocks the hijack path', () => {
    // softMiss may still carry the legacy !did_you_mean guard, but the hijack
    // branch must be reachable independently of did_you_mean — that gate was
    // the exact reason q=511 never recovered.
    const hijackDef = SHOP_CODE.slice(SHOP_CODE.indexOf('const hijack ='),
                                      SHOP_CODE.indexOf('const hijack =') + 200);
    assert.doesNotMatch(hijackDef, /did_you_mean/,
        'the hijack flag must not depend on did_you_mean');
});

test('shop-page.js — fallback unions /api/products with API.searchSuggest', () => {
    assert.match(SHOP_CODE, /API\.searchSuggest\(\s*searchQuery\s*,\s*20\s*\)/);
    assert.match(SHOP_CODE, /API\.getProducts\(\{\s*search:\s*searchQuery/);
    assert.match(SHOP_CODE, /mergeLiteralResults\(\s*suggestList\s*,\s*fallbackProducts\s*\)/);
});

test('shop-page.js — suggest is fetched only on page 1', () => {
    assert.match(SHOP_CODE, /requestedPage\s*===\s*1\s*\?\s*API\.searchSuggest/);
});

test('shop-page.js — taking the fallback nulls smartData (kills the bad banner)', () => {
    const idx = SHOP_CODE.indexOf('shouldUseFallback');
    const slice = SHOP_CODE.slice(idx, idx + 400);
    assert.match(slice, /products\s*=\s*merged/);
    assert.match(slice, /smartData\s*=\s*null/);
});

test('shop-page.js — a stale did_you_mean banner is suppressed on literal hits', () => {
    assert.match(SHOP_CODE, /let\s+bannerData\s*=\s*smartData/);
    assert.match(SHOP_CODE,
        /Object\.assign\(\{\}\s*,\s*smartData\s*,\s*\{\s*did_you_mean:\s*null\s*\}\)/,
        'must clone smartData (never mutate the SWR cache) when dropping did_you_mean');
    assert.match(SHOP_CODE, /this\.renderSearchBanners\(\s*bannerData\s*,\s*searchQuery\s*\)/);
});

test('shop-page.js — exposes the parity helpers for testing', () => {
    assert.match(SHOP_CODE, /window\._searchParityHelpers\s*=/);
});

test('api.js — searchSuggest is documented against /api/search/suggest', () => {
    assert.match(API_CODE, /async\s+searchSuggest\(/);
    assert.match(API_CODE, /\/api\/search\/suggest\?/);
});
