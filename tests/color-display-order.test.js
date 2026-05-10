/**
 * Canonical color display order — frontend contract tests
 * =======================================================
 *
 * Pins the May 2026 storefront secondary sort on top of the backend's
 * catalog sort (sort-hierarchy-may2026.md). The 22-rank contract:
 *
 *   K (0) → C (1) → M (2) → Y (3)              ← standard singles
 *   → PB → MB → LC → LM → VLM → grey → violet → tri-colour
 *   → R → B → G → O → W → B/R                  ← specialty singles (4-17)
 *   → unknown single (19)
 *   → CMY 3-Pack (20) → KCMY 4-Pack (21)       ← packs
 *
 * The backend's `sortByCatalogOrder` is the primary order; the FE applies
 * a stable secondary pass via `ProductSort.byColor` so customer-facing
 * rows always read K→C→M→Y→specialty→packs even when an upstream feed
 * drifts. Stability preserves the backend's `seriesBase`/`yieldTier`
 * grouping inside a colour rank.
 *
 * What this file guards against:
 *
 *   - Reordering / dropping COLOR_ORDER entries (the canonical index list).
 *   - colorTier returning the wrong bucket for K/C/M/Y singles, CMY/KCMY
 *     packs, light variants, specialty colors, or unknown rows.
 *   - byColor losing stability (same-rank rows must keep API order).
 *   - The three render surfaces (shop grid, PDP related, Products.renderCards)
 *     dropping their byColor pass.
 *
 * Spec: readfirst/sort-hierarchy-may2026.md
 *       (supersedes readfirst/color-display-order-may2026.md)
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

test('COLOR_ORDER puts standards (K→C→M→Y) before specialty before packs', () => {
    const idx = (n) => ProductSort.COLOR_ORDER.indexOf(n);
    // Standards lead.
    assert.ok(idx('black')   < idx('cyan'),    'black before cyan');
    assert.ok(idx('cyan')    < idx('magenta'), 'cyan before magenta');
    assert.ok(idx('magenta') < idx('yellow'),  'magenta before yellow');
    // Specialty singles sit between Y and packs (post-May 2026 contract).
    assert.ok(idx('yellow')  < idx('red'),     'yellow before specialty (red)');
    assert.ok(idx('red')     < idx('cmy'),     'specialty before CMY 3-Pack');
    // Packs at the end.
    assert.ok(idx('cmy')     < idx('kcmy'),    'cmy before kcmy');
});

test('COLOR_ORDER puts light variants AFTER yellow (specialty range, not parent tier)', () => {
    // The May 2026 sort-hierarchy spec moved Light Cyan / Light Magenta
    // out of the C / M tiers and into specialty (4-17). Customers see
    // standards (K→C→M→Y) first, then specialty singles, then packs.
    const idx = (n) => ProductSort.COLOR_ORDER.indexOf(n);
    assert.ok(idx('yellow') < idx('light cyan'),    'light cyan now sorts after yellow');
    assert.ok(idx('yellow') < idx('light magenta'), 'light magenta now sorts after yellow');
    assert.ok(idx('light cyan')    < idx('cmy'),    'light cyan still before packs');
    assert.ok(idx('light magenta') < idx('cmy'),    'light magenta still before packs');
});

test('colorOrder ranks the 22-position table per spec', () => {
    // Standards 0-3
    assert.equal(ProductSort.colorOrder({ color: 'Black' }),   0);
    assert.equal(ProductSort.colorOrder({ color: 'Cyan' }),    1);
    assert.equal(ProductSort.colorOrder({ color: 'Magenta' }), 2);
    assert.equal(ProductSort.colorOrder({ color: 'Yellow' }),  3);
    // Specialty singles 4-17 (sample)
    assert.equal(ProductSort.colorOrder({ color: 'Photo Black' }),    4);
    assert.equal(ProductSort.colorOrder({ color: 'Matte Black' }),    5);
    assert.equal(ProductSort.colorOrder({ color: 'Light Cyan' }),     6);
    assert.equal(ProductSort.colorOrder({ color: 'Light Magenta' }),  7);
    assert.equal(ProductSort.colorOrder({ color: 'Red' }),           12);
    assert.equal(ProductSort.colorOrder({ color: 'Blue' }),          13);
    // Packs 20-21
    assert.equal(ProductSort.colorOrder({ color: 'CMY',  pack_type: 'value_pack' }), 20);
    assert.equal(ProductSort.colorOrder({ color: 'KCMY', pack_type: 'value_pack' }), 21);
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

test('colorTier classifies Photo Black / Matte Black as SPECIALTY (not K)', () => {
    // sort-hierarchy-may2026.md §3 — PB/MB sort AFTER Y at ranks 4 and 5.
    // The legacy 8-tier `colorTier` view maps the new specialty range
    // (4-17) to TIER_SPECIALTY. Standards-only (K=0) remains the strict
    // K bucket.
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Photo Black' }), t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Matte Black' }), t.SPECIALTY);
});

test('colorTier classifies Light Cyan / Light Magenta as SPECIALTY (not C / M)', () => {
    // sort-hierarchy-may2026.md §3 — LC/LM sort AFTER Y at ranks 6 and 7.
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Light Cyan' }),    t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Light Magenta' }), t.SPECIALTY);
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

// Wiring tests for the (familyKey → yieldTier → colorTier) successor sort
// were moved to tests/code-yield-grouping-may2026.test.js once
// `byCodeThenColor` superseded `byColor` on the three render surfaces.
// `byColor` remains a standalone primitive (covered by the byColor unit
// tests above) for any caller that wants colour-only without the yield-
// code grouping.

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
