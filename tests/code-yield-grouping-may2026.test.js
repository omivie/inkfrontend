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

test('rowBreakIndices flags every (familyKey, yieldTier) transition', () => {
    const sorted = ProductSort.byCodeThenColor(TN645_SCRAMBLED);
    const breaks = ProductSort.rowBreakIndices(sorted);
    // 12 cards in 3 yield groups of 4 → breaks before cards 4 and 8.
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

test('rowBreakIndices fires between families at the same yield tier', () => {
    // Brother std (yield 0) immediately followed by HP std (yield 0) — different
    // family means a row break still belongs there.
    const sorted = [
        { sku: 'B1', name: 'Brother Genuine TN645BK Toner Cartridge Black', color: 'Black', brand: { name: 'Brother' } },
        { sku: 'B2', name: 'Brother Genuine TN645C Toner Cartridge Cyan',   color: 'Cyan',  brand: { name: 'Brother' } },
        { sku: 'H1', name: 'HP Genuine 975A Ink Cartridge Black',           color: 'Black', brand: { name: 'HP' } }
    ];
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [2]);
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
