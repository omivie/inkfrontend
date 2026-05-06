/**
 * Code → yield → color grouping — frontend contract tests
 * =======================================================
 *
 * Pins the May 2026 storefront override that supersedes the colour-only
 * sort. Every product list rendered on a customer-facing surface is sorted
 * into:
 *
 *   familyKey (incoming order) → yieldTier (std → XL → XXL) → colorTier (K → KCMY)
 *
 * and a row-break element is spliced between (familyKey, yieldTier) groups
 * so each yield-code physically starts on a new row in the wrapping flex
 * container.
 *
 * Live evidence motivating this (2026-05-06, /search?q=tn645):
 *   row 1: 645 BK, 645XL BK, 645XXL BK, 645 C, 645XL C, 645XXL C
 *   row 2: 645 M, 645XL M, 645XXL M, 645 Y, 645XL Y, 645XXL Y
 *
 * Customer expectation:
 *   row 1: 645    K, C, M, Y, CMY, KCMY
 *   row 2: 645XL  K, C, M, Y, CMY, KCMY
 *   row 3: 645XXL K, C, M, Y, CMY, KCMY
 *
 * What this file guards against:
 *
 *   - byCodeThenColor losing the (familyKey, yieldTier, colorTier) ordering.
 *   - rowBreakIndices missing or fabricating boundaries.
 *   - The three render surfaces (shop grid, products.renderCards, PDP
 *     buildTypeGrid) dropping their byCodeThenColor pass or row-break splice.
 *   - The .products-row__break CSS rule disappearing or losing flex-basis.
 *   - familyKey regressing on long suffixes like TN645XXLBK.
 *
 * Spec: readfirst/code-yield-grouping-may2026.md
 *
 * Run: node --test tests/code-yield-grouping-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS  = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const CSS = (rel) => path.join(ROOT, 'inkcartridges', 'css', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const SHOP_CODE     = stripComments(READ(JS('shop-page.js')));
const PDP_CODE      = stripComments(READ(JS('product-detail-page.js')));
const PRODUCTS_CODE = stripComments(READ(JS('products.js')));
const PAGES_CSS     = READ(CSS('pages.css'));

const { ProductSort } = require(JS('utils.js'));

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures — real backend SKUs / names from /search?q=tn645 (2026-05-06)
// ─────────────────────────────────────────────────────────────────────────────

const TN645_SCRAMBLED = [
    // Backend currently emits color-major / yield-minor — packs interleaved.
    { sku: 'G-BR-TN645BK',     name: 'Brother Genuine TN645BK Toner Cartridge Black',     color: 'Black',   brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XLBK',   name: 'Brother Genuine TN645XLBK Toner Cartridge Black',   color: 'Black',   brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XXLBK',  name: 'Brother Genuine TN645XXLBK Toner Cartridge Black',  color: 'Black',   brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645C',      name: 'Brother Genuine TN645C Toner Cartridge Cyan',       color: 'Cyan',    brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XLC',    name: 'Brother Genuine TN645XLC Toner Cartridge Cyan',     color: 'Cyan',    brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XXLC',   name: 'Brother Genuine TN645XXLC Toner Cartridge Cyan',    color: 'Cyan',    brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645M',      name: 'Brother Genuine TN645M Toner Cartridge Magenta',    color: 'Magenta', brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XLM',    name: 'Brother Genuine TN645XLM Toner Cartridge Magenta',  color: 'Magenta', brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XXLM',   name: 'Brother Genuine TN645XXLM Toner Cartridge Magenta', color: 'Magenta', brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645Y',      name: 'Brother Genuine TN645Y Toner Cartridge Yellow',     color: 'Yellow',  brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XLY',    name: 'Brother Genuine TN645XLY Toner Cartridge Yellow',   color: 'Yellow',  brand: { name: 'Brother' } },
    { sku: 'G-BR-TN645XXLY',   name: 'Brother Genuine TN645XXLY Toner Cartridge Yellow',  color: 'Yellow',  brand: { name: 'Brother' } }
];

const TN645_EXPECTED_ORDER = [
    'G-BR-TN645BK',     'G-BR-TN645C',     'G-BR-TN645M',     'G-BR-TN645Y',     // 645 std
    'G-BR-TN645XLBK',   'G-BR-TN645XLC',   'G-BR-TN645XLM',   'G-BR-TN645XLY',   // 645XL
    'G-BR-TN645XXLBK',  'G-BR-TN645XXLC',  'G-BR-TN645XXLM',  'G-BR-TN645XXLY'   // 645XXL
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. familyKey — collapses XL/XXL/HY suffixes onto the base code
// ─────────────────────────────────────────────────────────────────────────────

test('familyKey collapses TN645 / TN645XL / TN645XXL onto the same base', () => {
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'Brother' } });
    const base = fk('Brother Genuine TN645BK Toner Cartridge Black');
    assert.equal(fk('Brother Genuine TN645XLBK Toner Cartridge Black'),  base);
    assert.equal(fk('Brother Genuine TN645XXLBK Toner Cartridge Black'), base);
    assert.equal(fk('Brother Genuine TN645XLC Toner Cartridge Cyan'),    base);
    assert.equal(fk('Brother Genuine TN645XXLM Toner Cartridge Magenta'),base);
    // Sanity: the base key is what we expect.
    assert.equal(base, 'B:BROTHER:TN645');
});

test('familyKey strips XL+single-color suffix without confusing LC/LM (Light Cyan/Magenta)', () => {
    // `XLC` must parse as XL + C (Cyan), NOT X + LC (Light Cyan).
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'Brother' } });
    assert.equal(fk('Brother Genuine TN645XLC Toner Cartridge Cyan'), 'B:BROTHER:TN645');
    assert.equal(fk('Brother Genuine TN645XLM Toner Cartridge Magenta'), 'B:BROTHER:TN645');
    assert.equal(fk('Brother Genuine TN645XLY Toner Cartridge Yellow'), 'B:BROTHER:TN645');
});

test('familyKey collapses Canon CART069 / CART069H / CART069HK onto base', () => {
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'Canon' } });
    const base = fk('Canon Genuine CART069 Toner Cartridge Black');
    assert.equal(fk('Canon Genuine CART069H Value Pack KCMY 4-Pack'), base);
    assert.equal(fk('Canon Genuine CART069HK Toner Cartridge Black'),  base);
    assert.equal(fk('Canon Genuine CART069HC Toner Cartridge Cyan'),   base);
    assert.equal(base, 'B:CANON:CART069');
});

test('familyKey collapses single-digit Canon BCI6 series (B/C/M/Y/R/PC + pack) onto base', () => {
    // Live bug 2026-05-06: \d{2,} required two digits, so BCI6 (one digit)
    // fell through to the colour-stripped name fallback. Page-count parens
    // like "(280 Pages)" were then picked up by the bare-numeric regex and
    // every product got family=B:CANON:280 / B:CANON:100. Black landed on
    // its own row because its page count (280) differed from the rest (100).
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'Canon' } });
    const base = fk('Canon Genuine BCI6B Ink Cartridge Black (280 Pages)');
    assert.equal(base, 'B:CANON:BCI6');
    assert.equal(fk('Canon Genuine BCI6C Ink Cartridge Cyan (100 Pages)'),    base);
    assert.equal(fk('Canon Genuine BCI6M Ink Cartridge Magenta (100 Pages)'), base);
    assert.equal(fk('Canon Genuine BCI6Y Ink Cartridge Yellow (100 Pages)'),  base);
    assert.equal(fk('Canon Genuine BCI6R Ink Cartridge Red (100 Pages)'),     base);
    assert.equal(fk('Canon Genuine BCI6PC Ink Cartridge Photo Cyan (100 Pages)'), base,
        'BCI6PC must collapse to BCI6 — multi-letter PC color suffix gets stripped before single-letter C');
    assert.equal(fk('Canon Genuine BCI6 Value Pack KCMY 4-Pack'), base,
        'BCI6 with no colour suffix must still collapse to BCI6');
});

test('familyKey picks the LAST product code for compatibles that list multiple', () => {
    // Compatible names like "BCI3 BCI6 Cyan" cover both Canon BCI3 and BCI6.
    // The LAST code is the more modern / specific one and is the canonical
    // grouping for the customer-facing row. (When the customer searches
    // "bci6" they expect the row to live with BCI6, not BCI3.)
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'Canon' } });
    const base = fk('Compatible Ink Cartridge Replacement for Canon BCI6 Black');
    assert.equal(fk('Compatible Ink Cartridge Replacement for Canon BCI6 KCMY 4-Pack'), base);
    assert.equal(fk('Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Cyan'),    base);
    assert.equal(fk('Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Magenta'), base);
    assert.equal(fk('Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Yellow'),  base);
    assert.equal(fk('Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 CMY 3-Pack'), base);
    assert.equal(base, 'B:CANON:BCI6');
});

test('familyKey ignores trailing page-count parens for bare-numeric codes (HP)', () => {
    // "HP Genuine 975A Ink Cartridge Black (450 Pages)" must pick 975A,
    // not 450. Bare-numeric pass uses the FIRST match for exactly this reason.
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'HP' } });
    assert.equal(fk('HP Genuine 975A Ink Cartridge Black (450 Pages)'), 'B:HP:975A');
    assert.equal(fk('HP Genuine 975X Ink Cartridge Cyan (1500 Pages)'), 'B:HP:975X');
});

test('colorTier maps Photo Cyan / Photo Magenta into C / M tiers (not specialty)', () => {
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Photo Cyan' }),    t.C,
        'Photo Cyan belongs in the C tier so BCI6PC sits right after BCI6C in the row');
    assert.equal(ProductSort.colorTier({ color: 'Photo Magenta' }), t.M);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. byCodeThenColor — sort
// ─────────────────────────────────────────────────────────────────────────────

test('byCodeThenColor sorts TN645 family into 3 yield groups, K→C→M→Y inside each', () => {
    const sorted = ProductSort.byCodeThenColor(TN645_SCRAMBLED);
    assert.deepEqual(sorted.map(p => p.sku), TN645_EXPECTED_ORDER);
});

test('byCodeThenColor preserves family appearance order from the input', () => {
    // Two families in the input — Brother first, HP second. Output must keep
    // Brother before HP even though HP's standard yield is also tier 0.
    const input = [
        { sku: 'G-BR-TN645BK', name: 'Brother Genuine TN645BK Toner Cartridge Black', color: 'Black', brand: { name: 'Brother' } },
        { sku: 'G-HP-975A-INK-BK', name: 'HP Genuine 975A Ink Cartridge Black',       color: 'Black', brand: { name: 'HP' } },
        { sku: 'G-BR-TN645C',  name: 'Brother Genuine TN645C Toner Cartridge Cyan',   color: 'Cyan',  brand: { name: 'Brother' } }
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    // Brother family first (both Brother SKUs together), then HP.
    assert.deepEqual(sorted.map(p => p.sku), [
        'G-BR-TN645BK', 'G-BR-TN645C',  // Brother family, K then C
        'G-HP-975A-INK-BK'              // HP family
    ]);
});

test('byCodeThenColor renders BCI6 series (B/C/M/Y/R/PC + KCMY pack) on a single row', () => {
    // Live bug 2026-05-06 (/search?q=bci6): BCI6B Black landed on its own
    // row because the family key was page-count-derived (B:CANON:280 vs
    // B:CANON:100). After the single-digit + page-count fix, all 7 BCI6
    // products share family B:CANON:BCI6 and yield 0 — one row, no breaks.
    const input = [
        { sku: 'G-CAN-BCI6B',  name: 'Canon Genuine BCI6B Ink Cartridge Black (280 Pages)',     color: 'Black',       brand: { name: 'Canon' } },
        { sku: 'G-CAN-BCI6C',  name: 'Canon Genuine BCI6C Ink Cartridge Cyan (100 Pages)',      color: 'Cyan',        brand: { name: 'Canon' } },
        { sku: 'G-CAN-BCI6M',  name: 'Canon Genuine BCI6M Ink Cartridge Magenta (100 Pages)',   color: 'Magenta',     brand: { name: 'Canon' } },
        { sku: 'G-CAN-BCI6Y',  name: 'Canon Genuine BCI6Y Ink Cartridge Yellow (100 Pages)',    color: 'Yellow',      brand: { name: 'Canon' } },
        { sku: 'G-CAN-BCI6R',  name: 'Canon Genuine BCI6R Ink Cartridge Red (100 Pages)',       color: 'Red',         brand: { name: 'Canon' } },
        { sku: 'G-CAN-BCI6PC', name: 'Canon Genuine BCI6PC Ink Cartridge Photo Cyan (100 Pages)', color: 'Photo Cyan', brand: { name: 'Canon' } },
        { sku: 'GP-CAN-BCI6-KCMY', name: 'Canon Genuine BCI6 Value Pack KCMY 4-Pack', color: 'KCMY', brand: { name: 'Canon' }, pack_type: 'value_pack' }
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    // K → C → PC (also C tier) → M → Y → KCMY → R (specialty)
    assert.deepEqual(sorted.map(p => p.sku), [
        'G-CAN-BCI6B', 'G-CAN-BCI6C', 'G-CAN-BCI6PC', 'G-CAN-BCI6M', 'G-CAN-BCI6Y',
        'GP-CAN-BCI6-KCMY', 'G-CAN-BCI6R'
    ]);
    // Every product shares (familyKey, yieldTier) → no row breaks at all.
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [],
        'BCI6 row must NOT split — all 7 products belong on one row');
});

test('byCodeThenColor renders BCI6 compatibles (mixed BCI3/BCI6 names) on a single row', () => {
    // Compatible names "BCI3 BCI6 …" must still group with BCI6-only names
    // because the LAST product code wins.
    const input = [
        { sku: 'C-CAN-BCI6-BK',   name: 'Compatible Ink Cartridge Replacement for Canon BCI6 Black',         color: 'Black',   brand: { name: 'Canon' }, source: 'compatible' },
        { sku: 'C-CAN-BCI3BCI6-CY', name: 'Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Cyan',    color: 'Cyan',    brand: { name: 'Canon' }, source: 'compatible' },
        { sku: 'C-CAN-BCI3BCI6-MG', name: 'Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Magenta', color: 'Magenta', brand: { name: 'Canon' }, source: 'compatible' },
        { sku: 'C-CAN-BCI3BCI6-YL', name: 'Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 Yellow',  color: 'Yellow',  brand: { name: 'Canon' }, source: 'compatible' },
        { sku: 'C-CAN-BCI3BCI6-CMY',name: 'Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 CMY 3-Pack', color: 'CMY',  brand: { name: 'Canon' }, source: 'compatible', pack_type: 'value_pack' },
        { sku: 'C-CAN-BCI6-KCMY', name: 'Compatible Ink Cartridge Replacement for Canon BCI6 KCMY 4-Pack',   color: 'KCMY',    brand: { name: 'Canon' }, source: 'compatible', pack_type: 'value_pack' }
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    assert.deepEqual(sorted.map(p => p.sku), [
        'C-CAN-BCI6-BK', 'C-CAN-BCI3BCI6-CY', 'C-CAN-BCI3BCI6-MG', 'C-CAN-BCI3BCI6-YL',
        'C-CAN-BCI3BCI6-CMY', 'C-CAN-BCI6-KCMY'
    ]);
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [],
        'BCI6 compatible row must NOT split — BCI3+BCI6 names belong with BCI6-only names');
});

test('byCodeThenColor places CMY/KCMY packs after singles within their yield', () => {
    const input = [
        { sku: 'P-CMY',  name: 'Brother Genuine TN645 Value Pack CMY 3-Pack',  color: 'CMY',  brand: { name: 'Brother' }, pack_type: 'value_pack' },
        { sku: 'P-KCMY', name: 'Brother Genuine TN645 Value Pack KCMY 4-Pack', color: 'KCMY', brand: { name: 'Brother' }, pack_type: 'value_pack' },
        { sku: 'S-K',    name: 'Brother Genuine TN645BK Toner Cartridge Black', color: 'Black', brand: { name: 'Brother' } },
        { sku: 'S-C',    name: 'Brother Genuine TN645C Toner Cartridge Cyan',  color: 'Cyan',  brand: { name: 'Brother' } }
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    assert.deepEqual(sorted.map(p => p.sku), ['S-K', 'S-C', 'P-CMY', 'P-KCMY']);
});

test('byCodeThenColor returns a NEW array (does not mutate input)', () => {
    const input = TN645_SCRAMBLED.slice();
    const before = input.map(p => p.sku).join(',');
    const out = ProductSort.byCodeThenColor(input);
    assert.notStrictEqual(out, input, 'must be a new array');
    assert.equal(input.map(p => p.sku).join(','), before, 'input must be untouched');
});

test('byCodeThenColor handles edge cases: empty, single-item, null, non-array', () => {
    assert.deepEqual(ProductSort.byCodeThenColor([]), []);
    assert.deepEqual(ProductSort.byCodeThenColor([{ color: 'Cyan' }]), [{ color: 'Cyan' }]);
    assert.deepEqual(ProductSort.byCodeThenColor(null), []);
    assert.deepEqual(ProductSort.byCodeThenColor(undefined), []);
    assert.deepEqual(ProductSort.byCodeThenColor('not an array'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. rowBreakIndices — boundary detection
// ─────────────────────────────────────────────────────────────────────────────

test('rowBreakIndices flags every (familyKey, yieldTier) transition when groups are dense', () => {
    const sorted = ProductSort.byCodeThenColor(TN645_SCRAMBLED);
    const breaks = ProductSort.rowBreakIndices(sorted);
    // 12 cards in 3 yield groups of 4 → both sides ≥ 2 at every boundary,
    // so breaks fire before cards 4 and 8.
    assert.deepEqual(breaks, [4, 8]);
});

test('rowBreakIndices returns [] for arrays with one yield-code', () => {
    const oneYield = TN645_SCRAMBLED.filter(p => ProductSort.yieldTier(p) === 0);
    const sorted = ProductSort.byCodeThenColor(oneYield);
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), []);
});

test('rowBreakIndices returns [] for empty / single-item input', () => {
    assert.deepEqual(ProductSort.rowBreakIndices([]), []);
    assert.deepEqual(ProductSort.rowBreakIndices([{ name: 'X', color: 'Black' }]), []);
});

test('rowBreakIndices fires between families at the same yield tier when both sides ≥ 2', () => {
    // Brother std followed by HP std — different family, both with ≥2 cards
    // → a break belongs there. The default threshold is met on both sides.
    const sorted = [
        { sku: 'B1', name: 'Brother Genuine TN645BK Toner Cartridge Black', color: 'Black',   brand: { name: 'Brother' } },
        { sku: 'B2', name: 'Brother Genuine TN645C Toner Cartridge Cyan',   color: 'Cyan',    brand: { name: 'Brother' } },
        { sku: 'H1', name: 'HP Genuine 975A Ink Cartridge Black',           color: 'Black',   brand: { name: 'HP' } },
        { sku: 'H2', name: 'HP Genuine 975A Ink Cartridge Cyan',            color: 'Cyan',    brand: { name: 'HP' } }
    ];
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [2]);
});

test('rowBreakIndices SKIPS the break when either adjacent group has only 1 card (CL586 case)', () => {
    // Live evidence /search?q=cl586 (2026-05-06): 1 std card + 1 XL card.
    // Forcing a row break wastes a full row of vertical space for nothing —
    // the customer should see both cards on the same row instead of having
    // to scroll. The default threshold (minGroupSize=2) skips this break.
    const sorted = ProductSort.byCodeThenColor([
        { sku: 'G-CAN-CL586',   name: 'Canon Genuine CL586 Ink Cartridge Fine Colour',   color: 'CMY', brand: { name: 'Canon' }, pack_type: 'value_pack' },
        { sku: 'G-CAN-CL586XL', name: 'Canon Genuine CL586XL Ink Cartridge Fine Colour', color: 'CMY', brand: { name: 'Canon' }, pack_type: 'value_pack' }
    ]);
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [],
        'CL586 std + CL586XL must share a single row — no forced break for 1-card groups');
});

test('rowBreakIndices SKIPS the break for sparse-on-either-side transitions (3 + 1 + 3)', () => {
    // Three families, sizes 3 / 1 / 3. The lonely middle group makes BOTH
    // adjacent boundaries fail the threshold (threshold=2 needs both sides
    // ≥ 2). Result: zero breaks, all 7 cards flow into the natural wrap.
    const sorted = ProductSort.byCodeThenColor([
        { sku: 'A1', name: 'Brother Genuine TN111BK Toner Cartridge Black',   color: 'Black',   brand: { name: 'Brother' } },
        { sku: 'A2', name: 'Brother Genuine TN111C Toner Cartridge Cyan',     color: 'Cyan',    brand: { name: 'Brother' } },
        { sku: 'A3', name: 'Brother Genuine TN111M Toner Cartridge Magenta',  color: 'Magenta', brand: { name: 'Brother' } },
        { sku: 'B1', name: 'Brother Genuine TN222BK Toner Cartridge Black',   color: 'Black',   brand: { name: 'Brother' } },
        { sku: 'C1', name: 'Brother Genuine TN333BK Toner Cartridge Black',   color: 'Black',   brand: { name: 'Brother' } },
        { sku: 'C2', name: 'Brother Genuine TN333C Toner Cartridge Cyan',     color: 'Cyan',    brand: { name: 'Brother' } },
        { sku: 'C3', name: 'Brother Genuine TN333M Toner Cartridge Magenta',  color: 'Magenta', brand: { name: 'Brother' } }
    ]);
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), []);
});

test('rowBreakIndices respects an explicit minGroupSize override', () => {
    // Caller can opt into the strict "always break" behaviour by passing
    // minGroupSize: 1 — useful for tests / debugging.
    const sorted = ProductSort.byCodeThenColor([
        { sku: 'G-CAN-CL586',   name: 'Canon Genuine CL586 Ink Cartridge Fine Colour',   color: 'CMY', brand: { name: 'Canon' }, pack_type: 'value_pack' },
        { sku: 'G-CAN-CL586XL', name: 'Canon Genuine CL586XL Ink Cartridge Fine Colour', color: 'CMY', brand: { name: 'Canon' }, pack_type: 'value_pack' }
    ]);
    assert.deepEqual(ProductSort.rowBreakIndices(sorted, { minGroupSize: 1 }), [1],
        'minGroupSize:1 reverts to "always break" — useful for diagnostics');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Render-surface wiring — every product list runs through byCodeThenColor
// ─────────────────────────────────────────────────────────────────────────────

test('Shop.renderProducts uses ProductSort.byCodeThenColor + inserts row breaks', () => {
    const m = SHOP_CODE.match(/renderProducts\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'expected renderProducts method body in shop-page.js');
    const body = m[1];
    assert.match(body, /ProductSort\.byCodeThenColor\s*\(\s*products\s*\)/,
        'renderProducts must apply ProductSort.byCodeThenColor — code-yield-grouping-may2026.md');
    assert.match(body, /ProductSort\.rowBreakIndices\s*\(/,
        'renderProducts must request rowBreakIndices to know where to splice breaks');
    assert.match(body, /products-row__break/,
        'renderProducts must emit the .products-row__break breaker element');
    assert.doesNotMatch(body, /\bbyYieldAndColor\b/i,
        'renderProducts must not call byYieldAndColor (legacy)');
    assert.doesNotMatch(body, /products\.sort\s*\(/,
        'renderProducts must not call .sort() directly on products');
});

test('Products.renderCards uses ProductSort.byCodeThenColor + inserts row-break HTML', () => {
    const m = PRODUCTS_CODE.match(/renderCards\s*\(\s*products\s*\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'expected Products.renderCards method body in products.js');
    const body = m[1];
    assert.match(body, /ProductSort\.byCodeThenColor\s*\(\s*products\s*\)/,
        'renderCards must apply ProductSort.byCodeThenColor');
    assert.match(body, /ProductSort\.rowBreakIndices\s*\(/,
        'renderCards must request rowBreakIndices');
    assert.match(body, /products-row__break/,
        'renderCards must emit the .products-row__break breaker HTML');
});

test('PDP renderRelatedProducts uses byCodeThenColor for compatibles + genuines', () => {
    const compatibleAssign = PDP_CODE.match(/const\s+compatibles\s*=\s*([^;]+);/);
    const genuineAssign    = PDP_CODE.match(/const\s+genuines\s*=\s*([^;]+);/);
    assert.ok(compatibleAssign && genuineAssign,
        'compatibles/genuines assignments must exist in renderRelatedProducts');
    for (const [label, src] of [['compatibles', compatibleAssign[1]], ['genuines', genuineAssign[1]]]) {
        assert.match(src, /sortByCodeThenColor\s*\(|ProductSort\.byCodeThenColor\s*\(/,
            `${label} must apply ProductSort.byCodeThenColor (code-yield-grouping-may2026.md)`);
    }
});

test('PDP buildTypeGrid splices row-breaks into the related-products grid', () => {
    // The buildTypeGrid closure sits inside renderRelatedProducts → buildSection.
    // Look for the breaker HTML + rowBreakIndices request in the file overall;
    // a tighter match would over-couple to whitespace/order.
    assert.match(PDP_CODE, /products-row__break/,
        'PDP buildTypeGrid must emit the .products-row__break breaker');
    assert.match(PDP_CODE, /ProductSort\.rowBreakIndices\s*\(/,
        'PDP buildTypeGrid must request rowBreakIndices');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CSS — the breaker rule must keep its row-break behaviour
// ─────────────────────────────────────────────────────────────────────────────

test('.products-row__break CSS rule exists with flex-basis:100% and zero height', () => {
    // The rule must work in the .products-row flex container.
    const rule = PAGES_CSS.match(/\.products-row__break\s*\{([\s\S]*?)\}/);
    assert.ok(rule, 'expected .products-row__break rule in pages.css');
    const body = rule[1];
    assert.match(body, /flex-basis:\s*100%/,
        'breaker must be flex-basis:100% so wrapping flex container drops to next row');
    assert.match(body, /height:\s*0/,
        'breaker must be height:0 so it does not visually push cards apart');
});

test('.product-grid > .products-row__break uses grid-column: 1 / -1', () => {
    // CSS Grid containers (PDP related products .product-grid) ignore
    // flex-basis — the breaker has to span every column.
    const m = PAGES_CSS.match(/\.product-grid\s*>\s*\.products-row__break\s*\{([\s\S]*?)\}/);
    assert.ok(m, 'expected .product-grid > .products-row__break rule for CSS-Grid containers');
    assert.match(m[1], /grid-column:\s*1\s*\/\s*-1/,
        'breaker must span all grid columns to act as a row break in CSS Grid');
});
