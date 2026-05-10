/**
 * Series-base merge — frontend contract tests
 * ===========================================
 *
 * Pins the May 2026 fix that collapses XL/XXL/XXXL yield variants into
 * their base series chip on /shop. Without this, the storefront splits
 * "604" and "604XL" into two tiles (Epson example, live 2026-05-10),
 * doubling the customer's hunt across every brand whose backend ships
 * separate yield-suffix chips.
 *
 * Customer expectation:
 *   one chip per series, count summed across yield levels, every product
 *   under that chip when clicked (regardless of yield).
 *
 * What this file guards:
 *
 *   - SeriesCodes.collapseYieldSuffix preserves non-yield suffixes (N/S/ML)
 *     and strips X{1,3}L from canonical codes.
 *   - SeriesCodes.collapseChipList sums counts across collapsed siblings,
 *     preserves first-seen order, and stamps `aliases` on each chip.
 *   - shop-page.js bumps the chip cache to v7 (so v6 caches don't serve
 *     stale split chips after deploy) and ALWAYS funnels chips through
 *     SeriesCodes.collapseChipList before render.
 *   - shop-page.js URL parser collapses `?code=604XL` → state.code='604'
 *     so deep-links survive the chip merge.
 *   - shop-page.js loadProducts fans out to chip aliases on click, so a
 *     unified "604" tile pulls both /api/shop?code=604 AND ?code=604XL.
 *   - utils.js exports SeriesCodes via both `window.SeriesCodes` and the
 *     CommonJS module shape (so the Node test runner can import it).
 *
 * Spec: readfirst/series-base-merge-may2026.md
 *
 * Run: node --test tests/series-base-merge-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const SHOP_CODE = stripComments(READ(JS('shop-page.js')));
const UTILS_CODE = stripComments(READ(JS('utils.js')));

const utilsExports = require(JS('utils.js'));
const { SeriesCodes } = utilsExports;

// ─────────────────────────────────────────────────────────────────────────────
// 1. SeriesCodes.collapseYieldSuffix — single-code collapse
// ─────────────────────────────────────────────────────────────────────────────

test('SeriesCodes is exported from utils.js (window + CommonJS)', () => {
    assert.ok(SeriesCodes, 'utils.js must export SeriesCodes via module.exports');
    assert.equal(typeof SeriesCodes.collapseYieldSuffix, 'function');
    assert.equal(typeof SeriesCodes.collapseChipList, 'function');
    assert.equal(typeof SeriesCodes.collapseList, 'function');
    assert.match(UTILS_CODE, /window\.SeriesCodes\s*=\s*SeriesCodes/,
        'utils.js must expose SeriesCodes on window so non-module callers (api.js, shop-page.js) can use it');
});

test('collapseYieldSuffix strips XL on bare-numeric Epson codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('200XL'), '200');
    assert.equal(SeriesCodes.collapseYieldSuffix('212XL'), '212');
    assert.equal(SeriesCodes.collapseYieldSuffix('220XL'), '220');
    assert.equal(SeriesCodes.collapseYieldSuffix('252XL'), '252');
    assert.equal(SeriesCodes.collapseYieldSuffix('273XL'), '273');
    assert.equal(SeriesCodes.collapseYieldSuffix('604XL'), '604');
    assert.equal(SeriesCodes.collapseYieldSuffix('676XL'), '676');
});

test('collapseYieldSuffix strips XXL/XXXL', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('812XXL'), '812');
    assert.equal(SeriesCodes.collapseYieldSuffix('200XXL'), '200');
    assert.equal(SeriesCodes.collapseYieldSuffix('TN645XXL'), 'TN645');
    assert.equal(SeriesCodes.collapseYieldSuffix('TN645XXXL'), 'TN645');
});

test('collapseYieldSuffix strips XL on T-series Epson codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('T312XL'), 'T312');
    assert.equal(SeriesCodes.collapseYieldSuffix('T200XL'), 'T200');
    assert.equal(SeriesCodes.collapseYieldSuffix('T0731XL'), 'T0731');
});

test('collapseYieldSuffix strips XL on Brother LC/TN/DR codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('LC133XL'), 'LC133');
    assert.equal(SeriesCodes.collapseYieldSuffix('LC139XL'), 'LC139');
    assert.equal(SeriesCodes.collapseYieldSuffix('TN240XL'), 'TN240');
    assert.equal(SeriesCodes.collapseYieldSuffix('TN3340XL'), 'TN3340');
});

test('collapseYieldSuffix strips XL on Canon ink codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('PG645XL'), 'PG645');
    assert.equal(SeriesCodes.collapseYieldSuffix('CL646XL'), 'CL646');
    assert.equal(SeriesCodes.collapseYieldSuffix('PGI645XXL'), 'PGI645');
    assert.equal(SeriesCodes.collapseYieldSuffix('CLI651XL'), 'CLI651');
});

test('collapseYieldSuffix strips XL on HP numeric codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('62XL'), '62');
    assert.equal(SeriesCodes.collapseYieldSuffix('63XL'), '63');
    assert.equal(SeriesCodes.collapseYieldSuffix('564XL'), '564');
    assert.equal(SeriesCodes.collapseYieldSuffix('953XL'), '953');
});

test('collapseYieldSuffix preserves non-yield suffixes (N / S / ML)', () => {
    // Epson regional codes — N is part of the name, NOT a yield indicator
    assert.equal(SeriesCodes.collapseYieldSuffix('73N'), '73N');
    assert.equal(SeriesCodes.collapseYieldSuffix('81N'), '81N');
    // S = standard yield only; not collapsed (would lose meaning)
    assert.equal(SeriesCodes.collapseYieldSuffix('46S'), '46S');
    // ML = volume size, not yield
    assert.equal(SeriesCodes.collapseYieldSuffix('26ML'), '26ML');
    assert.equal(SeriesCodes.collapseYieldSuffix('80ML'), '80ML');
});

test('collapseYieldSuffix is idempotent on already-collapsed codes', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('604'), '604');
    assert.equal(SeriesCodes.collapseYieldSuffix('T312'), 'T312');
    assert.equal(SeriesCodes.collapseYieldSuffix('LC133'), 'LC133');
    assert.equal(SeriesCodes.collapseYieldSuffix('PGI645'), 'PGI645');
});

test('collapseYieldSuffix normalizes whitespace/hyphens/case', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix('  604xl '), '604');
    assert.equal(SeriesCodes.collapseYieldSuffix('lc-133-xl'), 'LC133');
    assert.equal(SeriesCodes.collapseYieldSuffix('pg 645xl'), 'PG645');
});

test('collapseYieldSuffix returns "" on falsy input', () => {
    assert.equal(SeriesCodes.collapseYieldSuffix(null), '');
    assert.equal(SeriesCodes.collapseYieldSuffix(undefined), '');
    assert.equal(SeriesCodes.collapseYieldSuffix(''), '');
    assert.equal(SeriesCodes.collapseYieldSuffix('   '), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SeriesCodes.collapseList — array dedupe
// ─────────────────────────────────────────────────────────────────────────────

test('collapseList dedupes XL into base across an array', () => {
    assert.deepEqual(
        SeriesCodes.collapseList(['604', '604XL', '676', '676XL']),
        ['604', '676']
    );
    assert.deepEqual(
        SeriesCodes.collapseList(['200XL', '200', '200XL']),
        ['200']
    );
});

test('collapseList preserves order of first appearance', () => {
    assert.deepEqual(
        SeriesCodes.collapseList(['676XL', '604', '604XL', '676']),
        ['676', '604']
    );
});

test('collapseList survives empty / non-array input', () => {
    assert.deepEqual(SeriesCodes.collapseList(null), []);
    assert.deepEqual(SeriesCodes.collapseList(undefined), []);
    assert.deepEqual(SeriesCodes.collapseList('not an array'), []);
    assert.deepEqual(SeriesCodes.collapseList([]), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SeriesCodes.collapseChipList — the /shop chip aggregator
// ─────────────────────────────────────────────────────────────────────────────

test('collapseChipList sums counts across yield siblings (Epson live evidence)', () => {
    // From /api/shop?brand=epson + compat-recovery merge (2026-05-10):
    //   primary  604 count=18,   200 count=16,   220 count=15
    //   compat   604XL count=6,  200XL count=4,  220XL count=4
    const chips = [
        { code: '200', count: 16 },
        { code: '200XL', count: 4 },
        { code: '604', count: 18 },
        { code: '604XL', count: 6 },
        { code: '220', count: 15 },
        { code: '220XL', count: 4 }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    const byCode = Object.fromEntries(merged.map(c => [c.code, c]));
    assert.equal(byCode['200'].count, 20);
    assert.equal(byCode['604'].count, 24);
    assert.equal(byCode['220'].count, 19);
    // No XL chip should survive
    assert.ok(!byCode['200XL'], '200XL chip must collapse into 200');
    assert.ok(!byCode['604XL'], '604XL chip must collapse into 604');
    assert.ok(!byCode['220XL'], '220XL chip must collapse into 220');
});

test('collapseChipList stamps aliases for click-time fan-out', () => {
    const chips = [
        { code: '604', count: 18 },
        { code: '604XL', count: 6 }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].code, '604');
    // Aliases must include BOTH raw codes so loadProducts can fan out to
    // /api/shop?code=604 AND /api/shop?code=604XL — backend filters series_codes
    // strictly so we have to request each yield variant explicitly.
    assert.deepEqual(merged[0].aliases.sort(), ['604', '604XL']);
});

test('collapseChipList preserves N/S codes as standalone chips', () => {
    const chips = [
        { code: '73N', count: 8 },
        { code: '81N', count: 10 },
        { code: '46S', count: 8 }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map(c => c.code).sort(), ['46S', '73N', '81N']);
    // Each preserves itself as the sole alias
    for (const m of merged) assert.deepEqual(m.aliases, [m.code]);
});

test('collapseChipList preserves first-appearance order', () => {
    const chips = [
        { code: '604', count: 18 },
        { code: '212', count: 19 },
        { code: '212XL', count: 6 },
        { code: '604XL', count: 6 }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    assert.deepEqual(merged.map(c => c.code), ['604', '212']);
});

test('collapseChipList merges per-chip products by id/sku', () => {
    // Legacy extractProductCodes path packs `products: [...]` on each chip
    const chips = [
        { code: '604', count: 2, products: [{ id: 1, sku: 'A1' }, { id: 2, sku: 'A2' }] },
        { code: '604XL', count: 2, products: [{ id: 3, sku: 'A3' }, { id: 1, sku: 'A1' }] }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].count, 4);
    // Dedup by id: A1 only once
    assert.equal(merged[0].products.length, 3);
    const ids = merged[0].products.map(p => p.id).sort();
    assert.deepEqual(ids, [1, 2, 3]);
});

test('collapseChipList survives malformed / missing-code input', () => {
    const chips = [
        null,
        { count: 5 },              // no code
        { code: '', count: 5 },    // empty code
        { code: '604', count: 18 }
    ];
    const merged = SeriesCodes.collapseChipList(chips);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].code, '604');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. shop-page.js wiring — chip cache version + collapse application
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js bumps chip cache to v7 (invalidates v6 split chips)', () => {
    // The active cache key written in loadProductCodes
    assert.match(SHOP_CODE, /codes-v7['`]/,
        'shop-page.js must write the v7 cache key after collapsing chips');
    // Read-side fallback chain: v7 first, then v6/v5/v4 for backward compat
    assert.match(SHOP_CODE, /codes-v7-final[\s\S]*codes-v6-final[\s\S]*codes-v5-final[\s\S]*codes-v4-final/,
        'loadProducts must read v7 cache first, fall through to legacy versions');
});

test('shop-page.js feeds the chip list through SeriesCodes.collapseChipList', () => {
    assert.match(SHOP_CODE, /SeriesCodes\.collapseChipList\(codes\)/,
        'shop-page.js must call SeriesCodes.collapseChipList on the chips array before caching/render');
});

test('shop-page.js URL parser collapses ?code=604XL → state.code=604', () => {
    // Look for the collapse on params.get('code') so deep-links match the
    // collapsed chip's `code` field (not its raw alias).
    assert.match(SHOP_CODE, /params\.get\(['"]code['"]\)[\s\S]{0,400}SeriesCodes\.collapseYieldSuffix/,
        'shop-page.js must collapse the URL ?code= param using SeriesCodes.collapseYieldSuffix');
});

test('shop-page.js loadProducts fans out across chip aliases', () => {
    // _codeAliasesFor must exist and consult the v7 cache
    assert.match(SHOP_CODE, /_codeAliasesFor\s*\(/,
        'shop-page.js must define _codeAliasesFor for click-time alias lookup');
    // Promise.all over alias map → one /api/shop call per yield variant
    assert.match(SHOP_CODE, /aliases\.map\(alias\s*=>[\s\S]{0,400}API\.getShopData\(/,
        'loadProducts must Promise.all across alias→API.getShopData for fan-out');
    // De-dupe by id/sku across alias responses
    assert.match(SHOP_CODE, /seenIds\.has\(key\)[\s\S]{0,40}continue/,
        'fan-out must dedupe products across alias responses');
});
