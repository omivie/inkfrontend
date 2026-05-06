/**
 * Canonical color display order — frontend contract tests
 * =======================================================
 *
 * Pins the May 2026 storefront override on top of the backend's catalog
 * sort (api-changes-may2026.md §1):
 *
 *   K (Black / Photo / Matte) → C / LC → M / LM → Y → CMY → KCMY
 *   → specialty (R/B/G/grays/etc.) → unknown
 *
 * The backend's `sortByCatalogOrder` was supposed to enforce this, but
 * `/api/shop?brand=hp&category=ink&code=975` (and other shop responses)
 * still arrive with packs interleaved between Black and CMY singles —
 * so the storefront applies a stable secondary pass via
 * `ProductSort.byColor`. Stability preserves the backend's
 * `seriesBase`/`yieldTier` grouping inside a colour tier.
 *
 * What this file guards against:
 *
 *   - Reordering / dropping COLOR_ORDER entries (the canonical index list).
 *   - colorTier returning the wrong bucket for K/C/M/Y singles, CMY/KCMY
 *     packs, light variants, specialty colors, or unknown rows.
 *   - byColor losing stability (same-tier rows must keep API order).
 *   - The three render surfaces (shop grid, PDP related, Products.renderCards)
 *     dropping their byColor pass.
 *
 * Spec: readfirst/color-display-order-may2026.md
 *
 * Run: node --test tests/color-display-order.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const SHOP_CODE     = stripComments(READ('shop-page.js'));
const PDP_CODE      = stripComments(READ('product-detail-page.js'));
const PRODUCTS_CODE = stripComments(READ('products.js'));

// ─────────────────────────────────────────────────────────────────────────────
// Load utils.js into a sandboxed CommonJS context to exercise ProductSort
// directly. utils.js exports ProductSort via the CommonJS branch at EOF.
// ─────────────────────────────────────────────────────────────────────────────

const { ProductSort, ProductColors } = require(JS('utils.js'));

// ─────────────────────────────────────────────────────────────────────────────
// 1. COLOR_ORDER — canonical index list
// ─────────────────────────────────────────────────────────────────────────────

test('COLOR_ORDER puts K before C before M before Y before CMY before KCMY', () => {
    const idx = (n) => ProductSort.COLOR_ORDER.indexOf(n);
    assert.ok(idx('black')   < idx('cyan'),    'black before cyan');
    assert.ok(idx('cyan')    < idx('magenta'), 'cyan before magenta');
    assert.ok(idx('magenta') < idx('yellow'),  'magenta before yellow');
    assert.ok(idx('yellow')  < idx('cmy'),     'yellow before cmy');
    assert.ok(idx('cmy')     < idx('kcmy'),    'cmy before kcmy');
    assert.ok(idx('kcmy')    < idx('red'),     'kcmy before specialty (red)');
});

test('COLOR_ORDER groups light variants with their parent colour', () => {
    const idx = (n) => ProductSort.COLOR_ORDER.indexOf(n);
    // Light Cyan sits in the C tier (between cyan and magenta).
    assert.ok(idx('cyan') < idx('light cyan'));
    assert.ok(idx('light cyan') < idx('magenta'));
    // Light Magenta sits in the M tier (between magenta and yellow).
    assert.ok(idx('magenta') < idx('light magenta'));
    assert.ok(idx('light magenta') < idx('yellow'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. colorTier — 8-bucket classifier
// ─────────────────────────────────────────────────────────────────────────────

test('colorTier maps K/C/M/Y singles to tiers 0/1/2/3', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Black' }),   t.K);
    assert.equal(ProductSort.colorTier({ color: 'Cyan' }),    t.C);
    assert.equal(ProductSort.colorTier({ color: 'Magenta' }), t.M);
    assert.equal(ProductSort.colorTier({ color: 'Yellow' }),  t.Y);
});

test('colorTier maps CMY / KCMY packs to tiers 4 / 5', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'CMY',  pack_type: 'value_pack' }), t.CMY);
    assert.equal(ProductSort.colorTier({ color: 'KCMY', pack_type: 'value_pack' }), t.KCMY);
    assert.equal(ProductSort.colorTier({ color: 'CMYK', pack_type: 'multipack' }),  t.KCMY);
    assert.equal(ProductSort.colorTier({ color: 'BCMY', pack_type: 'value_pack' }), t.KCMY);
});

test('colorTier groups Photo Black / Matte Black with K', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Photo Black' }), t.K);
    assert.equal(ProductSort.colorTier({ color: 'Matte Black' }), t.K);
});

test('colorTier groups Light Cyan / Light Magenta with their parent tier', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Light Cyan' }),    t.C);
    assert.equal(ProductSort.colorTier({ color: 'Light Magenta' }), t.M);
});

test('colorTier maps specialty colors (red/blue/green/gray) to TIER_SPECIALTY', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Red' }),   t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Blue' }),  t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Green' }), t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Gray' }),  t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Light Grey' }), t.SPECIALTY);
});

test('colorTier returns TIER_UNKNOWN for missing/unrecognised color and no name', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({}), t.UNKNOWN);
    assert.equal(ProductSort.colorTier({ color: '' }), t.UNKNOWN);
    assert.equal(ProductSort.colorTier({ color: 'Plasma' }), t.UNKNOWN);
});

test('colorTier falls back to ProductColors.detectFromName when color field is absent', () => {
    const t = ProductSort.TIERS;
    // Compatible name format (May 2026): "Compatible … Replacement for HP 975 KCMY 4-Pack"
    assert.equal(ProductSort.colorTier({ name: 'Compatible Ink Cartridge Replacement for HP 975 KCMY 4-Pack' }), t.KCMY);
    assert.equal(ProductSort.colorTier({ name: 'HP Genuine 975A Ink Cartridge Cyan' }),  t.C);
    assert.equal(ProductSort.colorTier({ name: 'HP Genuine 975A Ink Cartridge Black' }), t.K);
});

test('colorTier promotes a single-coloured row marked as a pack into the multi tier', () => {
    // A row with color='Black' but pack_type='value_pack' is a multi-pack
    // misclassified by upstream — the pack flag dominates so it sorts with
    // CMY/KCMY rather than sneaking into the Black bucket.
    const t = ProductSort.TIERS;
    assert.equal(
        ProductSort.colorTier({ color: 'Black', pack_type: 'multipack' }),
        t.KCMY
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. byColor — stable canonical sort
// ─────────────────────────────────────────────────────────────────────────────

test('byColor sorts the HP 975 compatible group into K, C, M, Y, CMY, KCMY', () => {
    // Real /api/shop?brand=hp&category=ink&code=975 ordering observed
    // 2026-05-06 — packs are interleaved between Black and Cyan.
    const apiOrder = [
        { sku: 'C-HP-975-INK-BK',         color: 'Black',   pack_type: 'single' },
        { sku: 'COMP-PACK-HP-975-CMY',    color: 'CMY',     pack_type: 'value_pack' },
        { sku: 'COMP-PACK-HP-975-KCMY',   color: 'KCMY',    pack_type: 'value_pack' },
        { sku: 'C-HP-975-INK-CY',         color: 'Cyan',    pack_type: 'single' },
        { sku: 'C-HP-975-INK-MG',         color: 'Magenta', pack_type: 'single' },
        { sku: 'C-HP-975-INK-YL',         color: 'Yellow',  pack_type: 'single' }
    ];
    const sorted = ProductSort.byColor(apiOrder);
    assert.deepEqual(
        sorted.map(p => p.color),
        ['Black', 'Cyan', 'Magenta', 'Yellow', 'CMY', 'KCMY']
    );
});

test('byColor preserves API order WITHIN a tier (stable sort)', () => {
    // Two Cyan products from different yield tiers (975A genuine std, 975X
    // genuine HY). The backend already ordered std → HY; byColor must not
    // disturb that.
    const apiOrder = [
        { sku: 'G-HP-975A-INK-CY', color: 'Cyan', pack_type: 'single' },
        { sku: 'G-HP-975X-INK-CY', color: 'Cyan', pack_type: 'single' },
        { sku: 'G-HP-975A-INK-BK', color: 'Black', pack_type: 'single' }
    ];
    const sorted = ProductSort.byColor(apiOrder);
    assert.deepEqual(sorted.map(p => p.sku), [
        'G-HP-975A-INK-BK',  // K tier first
        'G-HP-975A-INK-CY',  // then Cyan std (incoming order preserved)
        'G-HP-975X-INK-CY'   // then Cyan HY
    ]);
});

test('byColor returns a NEW array (does not mutate input)', () => {
    const input = [
        { color: 'Yellow' }, { color: 'Black' }, { color: 'Cyan' }
    ];
    const before = input.map(p => p.color).join(',');
    const out = ProductSort.byColor(input);
    assert.notStrictEqual(out, input, 'byColor must return a new array');
    assert.equal(input.map(p => p.color).join(','), before, 'input must be untouched');
    assert.deepEqual(out.map(p => p.color), ['Black', 'Cyan', 'Yellow']);
});

test('byColor handles edge cases: empty, single-item, null, non-array', () => {
    assert.deepEqual(ProductSort.byColor([]), []);
    assert.deepEqual(ProductSort.byColor([{ color: 'Cyan' }]), [{ color: 'Cyan' }]);
    assert.deepEqual(ProductSort.byColor(null), []);
    assert.deepEqual(ProductSort.byColor(undefined), []);
    assert.deepEqual(ProductSort.byColor('not an array'), []);
});

test('byColor pushes unknown-color rows last', () => {
    const input = [
        { sku: 'X', color: 'Plasma' },          // unknown
        { sku: 'Y', color: 'Yellow' },          // Y tier
        { sku: 'K', color: 'Black' },           // K tier
        { sku: 'S', color: 'Red' }              // specialty
    ];
    const sorted = ProductSort.byColor(input);
    assert.deepEqual(sorted.map(p => p.sku), ['K', 'Y', 'S', 'X']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Render-surface wiring — every product list runs through byColor
// ─────────────────────────────────────────────────────────────────────────────

test('Shop.renderProducts calls ProductSort.byColor on the products array', () => {
    // Locate the renderProducts method body.
    const m = SHOP_CODE.match(/renderProducts\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected to find renderProducts method body in shop-page.js');
    const body = m[1];
    assert.match(body, /ProductSort\.byColor\s*\(\s*products\s*\)/,
        'renderProducts must apply ProductSort.byColor(products) — color-display-order-may2026.md');
    // Still no calls to the legacy yieldAndColor (that would override the backend's
    // primary series/yield grouping) and no naive .sort() on products.
    assert.doesNotMatch(body, /\bbyYieldAndColor\b/i,
        'renderProducts must not call byYieldAndColor — backend owns yield/series order');
    assert.doesNotMatch(body, /products\.sort\s*\(/,
        'renderProducts must not call .sort() directly on products — go through ProductSort.byColor');
});

test('PDP renderRelatedProducts applies byColor after filtering by source', () => {
    // The compatibles/genuines slices must each pass through byColor (or the
    // local sortByColor wrapper) so per-section display order is K→C→M→Y→
    // CMY→KCMY.
    const compatibleAssign = PDP_CODE.match(/const\s+compatibles\s*=\s*([^;]+);/);
    const genuineAssign    = PDP_CODE.match(/const\s+genuines\s*=\s*([^;]+);/);
    assert.ok(compatibleAssign && genuineAssign,
        'compatibles/genuines assignments must exist in renderRelatedProducts');
    for (const [label, src] of [['compatibles', compatibleAssign[1]], ['genuines', genuineAssign[1]]]) {
        assert.match(src, /sortByColor\s*\(|ProductSort\.byColor\s*\(/,
            `${label} must apply the canonical color tier (color-display-order-may2026.md)`);
    }
});

test('Products.renderCards orders the array via ProductSort.byColor before rendering', () => {
    const m = PRODUCTS_CODE.match(/renderCards\s*\(\s*products\s*\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'expected Products.renderCards method body in products.js');
    const body = m[1];
    assert.match(body, /ProductSort\.byColor\s*\(\s*products\s*\)/,
        'Products.renderCards must apply ProductSort.byColor — every grid surface inherits this helper');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Endpoint-callable color contract — every product carries a color we can
//    classify, even when `color` is missing on the row.
// ─────────────────────────────────────────────────────────────────────────────

test('every storefront product has a resolvable color tier (color field OR name fallback)', () => {
    // Mix of canonical backend rows + a legacy row missing the color field.
    const rows = [
        { sku: 'C-HP-975-INK-BK',  color: 'Black' },                                 // canonical
        { sku: 'G-HP-975A-INK-CY', color: 'Cyan' },                                  // canonical
        { sku: 'COMP-PACK-HP-975-KCMY', color: 'KCMY', pack_type: 'value_pack' },    // pack
        { sku: 'LEGACY-1', name: 'HP Genuine 975A Ink Cartridge Magenta' },          // missing `color`
        { sku: 'LEGACY-2', name: 'Compatible Ink Cartridge Replacement for HP 975 KCMY 4-Pack' }
    ];
    for (const p of rows) {
        const tier = ProductSort.colorTier(p);
        assert.notEqual(tier, ProductSort.TIERS.UNKNOWN,
            `row ${p.sku} should resolve to a known tier; got UNKNOWN. resolveColorName='${ProductSort.resolveColorName(p)}'`);
    }
});
