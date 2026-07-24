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

test('familyKey collapses HP 804XL Black + Tri-Colour (CLR) onto the same base', () => {
    // Jul 2026: the 804XL colour cartridge became a proper Tri-Colour single
    // with SKU suffix CLR. Before CLR was added to the multi-letter colour
    // strip, "804XLCLR" lost only its trailing "R" → base "804CL", forking the
    // tri-colour off its "804XLBK" black sibling (base "804"). Both must land
    // on B:HP:804 so the pair shares a family row / related products.
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'HP' } });
    const base = fk('HP Genuine 804XLBK Ink Cartridge 804XL Black (600 pages)');
    assert.equal(base, 'B:HP:804');
    assert.equal(fk('HP Genuine 804XLCLR Ink Cartridge 804XL Tri-Colour (415 pages)'), base,
        'genuine tri-colour (804XLCLR) must collapse to 804, not 804CL');
    assert.equal(fk('804XLCLR Compatible Ink Cartridge for HP 804XL Tri-Colour'), base,
        'compatible tri-colour (name leads with 804XLCLR) must collapse to 804');
    assert.equal(fk('804XLBK Compatible Ink Cartridge for HP 804XL Black (600 pages)'), base);
});

test('familyKey ignores trailing page-count parens for bare-numeric codes (HP)', () => {
    // "HP Genuine 975A Ink Cartridge Black (450 Pages)" must pick 975A,
    // not 450. Bare-numeric pass uses the FIRST match for exactly this reason.
    const fk = (name) => ProductSort.familyKey({ name, brand: { name: 'HP' } });
    assert.equal(fk('HP Genuine 975A Ink Cartridge Black (450 Pages)'), 'B:HP:975A');
    assert.equal(fk('HP Genuine 975X Ink Cartridge Cyan (1500 Pages)'), 'B:HP:975X');
});

test('colorTier classifies Photo Cyan / Photo Magenta as SPECIALTY (post-May 2026)', () => {
    // sort-hierarchy-may2026.md §3 — PC/PM are specialty singles ranked
    // 6.5 / 7.5 (slotted between LC/LM and VLM). They sort AFTER Y but
    // BEFORE the multi-cartridge packs. The pre-May 2026 contract bucketed
    // them with their parent C/M tiers, but customer feedback showed that
    // pushed packs ahead of specialty singles on Epson 46S / Canon CLI42.
    const t = ProductSort.TIERS;
    assert.equal(ProductSort.colorTier({ color: 'Photo Cyan' }),    t.SPECIALTY);
    assert.equal(ProductSort.colorTier({ color: 'Photo Magenta' }), t.SPECIALTY);
    // Rank assertion: PC sits between LC (6) and VLM (8) on the sort line.
    assert.ok(ProductSort.colorOrder({ color: 'Light Cyan' }) <= ProductSort.colorOrder({ color: 'Photo Cyan' }));
    assert.ok(ProductSort.colorOrder({ color: 'Photo Cyan' })  <  ProductSort.colorOrder({ color: 'Vivid Light Magenta' }));
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
    //
    // Order under sort-hierarchy-may2026.md:
    //   K (0) → C (1) → M (2) → Y (3)
    //   → PC (6.5, specialty) → R (12, specialty)
    //   → KCMY pack (21)
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
    // Standards (K, C, M, Y) → specialty singles (PC, R) → packs (KCMY 4-Pack).
    assert.deepEqual(sorted.map(p => p.sku), [
        'G-CAN-BCI6B', 'G-CAN-BCI6C', 'G-CAN-BCI6M', 'G-CAN-BCI6Y',
        'G-CAN-BCI6PC', 'G-CAN-BCI6R',
        'GP-CAN-BCI6-KCMY'
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
// 2b. yieldTier — prefer the backend yield_tier signal (one-model-code-per-row,
//     Jun 2026). The name matcher silently failed on digit-glued HY ("200HY")
//     and HP short-series X/Y ("975X"), merging two model codes onto one row.
//     Spec: one-model-code-per-row-yield-tier-jun2026.md
// ─────────────────────────────────────────────────────────────────────────────

test('yieldTier maps backend yield_tier STD/XL/XXL → 0/1/2', () => {
    assert.equal(ProductSort.yieldTier({ yield_tier: 'STD' }), 0);
    assert.equal(ProductSort.yieldTier({ yield_tier: 'XL' }),  1);
    assert.equal(ProductSort.yieldTier({ yield_tier: 'XXL' }), 2);
    // Case-insensitive — backend is canonical upper, but guard against lower.
    assert.equal(ProductSort.yieldTier({ yield_tier: 'xl' }),  1);
});

test('yieldTier: backend signal AND FE detection both tier Epson 200HY as XL', () => {
    // The backend yield_tier:'XL' wins when present. Jun 2026: the FE detector
    // now ALSO catches digit-glued HY ("200HY", no \b between 0 and HY) on its
    // own, so the split holds even though the live API ships no yield_tier.
    const std = { name: 'Epson Genuine 200BK Ink Cartridge 200 Black',   color: 'Black', yield_tier: 'STD' };
    const xl  = { name: 'Epson Genuine 200HYBK Ink Cartridge 200HY Black', color: 'Black', yield_tier: 'XL' };
    assert.equal(ProductSort.yieldTier(std), 0);
    assert.equal(ProductSort.yieldTier(xl),  1, 'digit-glued HY must tier XL via backend signal');
    // With NO backend field the FE detector still tiers 200HY → XL (1) and
    // plain 200 → STD (0), so the rows split without backend help.
    assert.equal(ProductSort.yieldTier({ name: xl.name,  color: 'Black' }), 1,
        'FE detection tiers digit-glued 200HY as XL even without yield_tier');
    assert.equal(ProductSort.yieldTier({ name: std.name, color: 'Black' }), 0);
});

test('yieldTier: HP short-series 975X tiers XL via backend signal, 975A stays STD', () => {
    assert.equal(ProductSort.yieldTier({ name: 'HP Genuine 975A Ink Cartridge Black', color: 'Black', yield_tier: 'STD' }), 0);
    assert.equal(ProductSort.yieldTier({ name: 'HP Genuine 975X Ink Cartridge Black', color: 'Black', yield_tier: 'XL' }),  1);
});

// ── FE detection stopgap (Jun 2026): the live API ships NO yield_tier, so
//    yieldTier() must classify from name+sku+colour on its own. ───────────────
test('yieldTier FE detection (no yield_tier field) classifies the digit-glued + short-series cases', () => {
    const yt = (name, color, sku) => ProductSort.yieldTier({ name, color, sku });
    // digit-glued HY / EHY → XL
    assert.equal(yt('Epson Genuine 220HYBK Ink Cartridge 220HY Black', 'Black'), 1, '220HY → XL');
    assert.equal(yt('Epson Genuine 200HYC Ink Cartridge 200HY Cyan', 'Cyan'),    1, '200HY → XL');
    assert.equal(yt('Epson Genuine 220HYC Ink Cartridge 220HY Cyan', 'Cyan'),    1, '220HYC → XL');
    // digit-glued single H → XL (incl. the malformed "220H Yellow" row)
    assert.equal(yt('Epson Genuine 220HY Ink Cartridge 220H Yellow', 'Yellow'),  1, '220H Yellow → XL');
    assert.equal(yt('Canon Genuine CART069H Toner Cartridge Black', 'Black', 'CART069H'), 1, 'CART069H → XL');
    // HP short-series X → XL
    assert.equal(yt('HP Genuine 975X Ink Cartridge Cyan', 'Cyan'),               1, '975X → XL');
    // whole-word XL/XXL/HY still work
    assert.equal(yt('Brother Genuine TN645XLBK Toner Black', 'Black'),           1, 'XL token → XL');
    assert.equal(yt('Brother Genuine TN645XXLBK Toner Black', 'Black'),          2, 'XXL token → XXL');
    // STD must NOT be misread — bare colour Y, plain codes, page counts
    assert.equal(yt('Epson Genuine 220Y Ink Cartridge 220 Yellow (165 pages)', 'Yellow'), 0, '220Y yellow stays STD');
    assert.equal(yt('Epson Genuine 220BK Ink Cartridge 220 Black (175 pages)', 'Black'),  0, '220 stays STD');
    assert.equal(yt('HP Genuine 975A Ink Cartridge Black', 'Black'),            0, '975A stays STD');
    assert.equal(yt('Fuji Xerox Genuine 106R01220Y Toner Yellow', 'Yellow'),    0, 'embedded 1220Y stays STD');
});

test('accessoryTier: object category {name,slug} no longer stringifies to [object Object]', () => {
    // Live API sends category as an object. Tier must still resolve correctly.
    assert.equal(ProductSort.accessoryTier({ name: 'Epson Genuine 220BK Ink Cartridge 220 Black', category: { name: 'Ink', slug: 'ink' } }), 0);
    assert.equal(ProductSort.accessoryTier({ name: 'Lexmark Genuine B220Z00BK Drum Unit Black',    category: { name: 'Toner', slug: 'toner' } }), 1);
    assert.equal(ProductSort.accessoryTier({ name: 'HP Genuine 220V LaserJet Fuser Kit 220V',      category: { name: 'Toner', slug: 'toner' } }), 2);
    // object category with a drum slug also resolves via the slug now
    assert.equal(ProductSort.accessoryTier({ name: 'Some Unit', category: { name: 'Drum', slug: 'drum' } }), 1);
});

test('byCodeThenColor sinks accessory-only families below cartridge families (q=220 search merge)', () => {
    // Mirrors /search?q=220: Epson 220 inks interleaved (by relevance order)
    // with an HP fuser family and a Lexmark drum family. Cartridge family must
    // come first, then the drum family, then the fuser family — regardless of
    // the incoming order.
    const input = [
        { sku: 'HP-FUSER', name: 'HP Genuine 220V LaserJet Fuser Kit 220V', color: 'Colour', series_codes: ['220V'], brand: { name: 'HP' }, category: { slug: 'toner' } },
        { sku: 'EP-220BK', name: 'Epson Genuine 220BK Ink Cartridge 220 Black', color: 'Black', series_codes: ['220'], brand: { name: 'Epson' }, category: { slug: 'ink' } },
        { sku: 'LX-DRUM',  name: 'Lexmark Genuine B220Z00BK Drum Unit B220Z00 Black', color: 'Black', series_codes: ['B220Z00'], brand: { name: 'Lexmark' }, category: { slug: 'toner' } },
        { sku: 'EP-220C',  name: 'Epson Genuine 220C Ink Cartridge 220 Cyan', color: 'Cyan', series_codes: ['220'], brand: { name: 'Epson' }, category: { slug: 'ink' } },
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    assert.deepEqual(sorted.map(p => p.sku), ['EP-220BK', 'EP-220C', 'LX-DRUM', 'HP-FUSER'],
        'cartridge family first (K→C), then drum family, then fuser family');
});

test('yieldTier: yellow is not misread as extra-high-yield (backend keeps 200Y as STD)', () => {
    // Trailing Y in "200Y" is the Yellow colour, not a yield marker. Backend
    // uses product.color to keep it STD — the FE must trust that, not re-parse.
    assert.equal(ProductSort.yieldTier({ name: 'Epson Genuine 200Y Ink Cartridge 200 Yellow', color: 'Yellow', yield_tier: 'STD' }), 0);
});

test('yieldTier: legacy name/SKU fallback still works when yield_tier is absent', () => {
    // Pre-deploy cached payloads have no yield_tier — the name/SKU parse remains.
    assert.equal(ProductSort.yieldTier({ name: 'Brother Genuine TN645XLBK Toner Black',  color: 'Black' }), 1);
    assert.equal(ProductSort.yieldTier({ name: 'Brother Genuine TN645XXLBK Toner Black', color: 'Black' }), 2);
    assert.equal(ProductSort.yieldTier({ name: 'HP 950 High Yield Ink Black',            color: 'Black' }), 1);
    assert.equal(ProductSort.yieldTier({ sku: 'CART069H', name: 'Canon CART069H Toner',  color: 'Black' }), 1);
    assert.equal(ProductSort.yieldTier({ name: 'Brother Genuine TN645BK Toner Black',    color: 'Black' }), 0);
});

test('yieldTier: empty / non-string yield_tier falls through to the name parse', () => {
    // Defensive — a blank or unexpected value must not short-circuit to 0; it
    // should drop to the legacy parse so XL names still tier correctly.
    assert.equal(ProductSort.yieldTier({ yield_tier: '',   name: 'Brother TN645XLBK Toner', color: 'Black' }), 1);
    assert.equal(ProductSort.yieldTier({ yield_tier: null, name: 'Brother TN645XLBK Toner', color: 'Black' }), 1);
});

test('byCodeThenColor + rowBreakIndices split Epson 200 vs 200HY into separate rows via yield_tier', () => {
    // The live bug: ?code=200 rendered 200BK, 200HYBK, 200C, 200HYC … on the
    // same rows. With yield_tier the standard 200 row and the 200HY row split.
    const input = [
        { sku: 'G200BK',   name: 'Epson Genuine 200BK Ink 200 Black',     color: 'Black',   brand: { name: 'Epson' }, yield_tier: 'STD' },
        { sku: 'G200HYBK', name: 'Epson Genuine 200HYBK Ink 200HY Black', color: 'Black',   brand: { name: 'Epson' }, yield_tier: 'XL'  },
        { sku: 'G200C',    name: 'Epson Genuine 200C Ink 200 Cyan',       color: 'Cyan',    brand: { name: 'Epson' }, yield_tier: 'STD' },
        { sku: 'G200HYC',  name: 'Epson Genuine 200HYC Ink 200HY Cyan',   color: 'Cyan',    brand: { name: 'Epson' }, yield_tier: 'XL'  },
        { sku: 'G200M',    name: 'Epson Genuine 200M Ink 200 Magenta',    color: 'Magenta', brand: { name: 'Epson' }, yield_tier: 'STD' },
        { sku: 'G200HYM',  name: 'Epson Genuine 200HYM Ink 200HY Magenta',color: 'Magenta', brand: { name: 'Epson' }, yield_tier: 'XL'  },
        { sku: 'G200Y',    name: 'Epson Genuine 200Y Ink 200 Yellow',     color: 'Yellow',  brand: { name: 'Epson' }, yield_tier: 'STD' },
        { sku: 'G200HYY',  name: 'Epson Genuine 200HYY Ink 200HY Yellow', color: 'Yellow',  brand: { name: 'Epson' }, yield_tier: 'XL'  }
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    // All 200 standards first (K→C→M→Y), then all 200HY (K→C→M→Y).
    assert.deepEqual(sorted.map(p => p.sku), [
        'G200BK', 'G200C', 'G200M', 'G200Y',
        'G200HYBK', 'G200HYC', 'G200HYM', 'G200HYY'
    ]);
    // Two groups of 4 → one row break before the 200HY block.
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [4],
        '200 and 200HY must occupy separate rows');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2c. accessoryTier sub-order — a model's toners and drums must NOT interleave
//     (Jun 2026). Live bug /search?q=MC853: the OKI MC853 family rendered
//     Black-drum, Black-toner, Cyan-drum, Cyan-toner … on the same rows because
//     byCodeThenColor ordered family→yield→colour and omitted accessoryTier.
//     OKI files the "Drum Unit" rows under category 'toner', so accessoryTier
//     must read the unit type from the NAME first.
// ─────────────────────────────────────────────────────────────────────────────

test('accessoryTier reads unit type from the name even when category is toner', () => {
    // OKI/Brother file drum & fuser units under a toner category.
    assert.equal(ProductSort.accessoryTier({ name: 'OKI Genuine MC853BK Drum Unit MC853 Black', category: 'toner' }), 1,
        'a Drum Unit categorised as toner must still tier as a drum (1), not a cartridge (0)');
    assert.equal(ProductSort.accessoryTier({ name: 'OKI Genuine MC853BK Toner Cartridge MC853 Black', category: 'toner' }), 0);
    assert.equal(ProductSort.accessoryTier({ name: 'OKI Genuine 44848805 Fuser Unit', category: 'toner' }), 2);
    assert.equal(ProductSort.accessoryTier({ name: 'OKI Genuine C831N Belt Unit', category: 'toner' }), 2);
    // Cartridge < drum < other-unit ordering holds.
    assert.ok(ProductSort.accessoryTier({ name: 'X Toner Cartridge' })
        < ProductSort.accessoryTier({ name: 'X Drum Unit' }));
    assert.ok(ProductSort.accessoryTier({ name: 'X Drum Unit' })
        < ProductSort.accessoryTier({ name: 'X Fuser Unit' }));
});

test('byCodeThenColor blocks MC853 toners before drums (no colour interleave)', () => {
    // Incoming scramble exactly mirrors the live /search?q=MC853 payload:
    // drum and toner of each colour alternate.
    const oki = (name, color, drum, pack) => ({
        sku: name.replace(/\s+/g, '-'), name, color,
        series_codes: ['MC853'], brand: { name: 'OKI' },
        category: 'toner',                                   // OKI files drums under toner
        ...(pack ? { pack_type: 'value_pack' } : {})
    });
    const input = [
        oki('OKI Genuine MC853BK Drum Unit MC853 Black',   'Black'),
        oki('OKI Genuine MC853BK Toner Cartridge MC853 Black',   'Black'),
        oki('OKI Genuine MC853C Drum Unit MC853 Cyan',     'Cyan'),
        oki('OKI Genuine MC853C Toner Cartridge MC853 Cyan',     'Cyan'),
        oki('OKI Genuine MC853M Drum Unit MC853 Magenta',  'Magenta'),
        oki('OKI Genuine MC853M Toner Cartridge MC853 Magenta',  'Magenta'),
        oki('OKI Genuine MC853Y Drum Unit MC853 Yellow',   'Yellow'),
        oki('OKI Genuine MC853Y Toner Cartridge MC853 Yellow',   'Yellow'),
        oki('OKI Genuine MC853CMY Toner Cartridge MC853 CMY 3-Pack',  'CMY',  false, true),
        oki('OKI Genuine MC853KCMY Toner Cartridge MC853 KCMY 4-Pack','KCMY', false, true)
    ];
    const sorted = ProductSort.byCodeThenColor(input);
    const isDrum = (p) => /Drum Unit/.test(p.name);
    // All 6 toners (incl. packs) come before all 4 drums — no interleave.
    const firstDrum = sorted.findIndex(isDrum);
    const lastToner = sorted.map(isDrum).lastIndexOf(false);
    assert.ok(firstDrum > lastToner,
        'every toner must precede every drum within the MC853 family');
    assert.equal(firstDrum, 6, 'the 6 toners (K,C,M,Y,CMY,KCMY) lead, then the 4 drums');
    // Toner block colour order: K → C → M → Y → CMY pack → KCMY pack.
    assert.deepEqual(sorted.slice(0, 6).map(p => p.color),
        ['Black', 'Cyan', 'Magenta', 'Yellow', 'CMY', 'KCMY']);
    // Drum block colour order: K → C → M → Y.
    assert.deepEqual(sorted.slice(6).map(p => p.color),
        ['Black', 'Cyan', 'Magenta', 'Yellow']);
    // One row break before the drum block (toner seg=6, drum seg=4, both ≥2).
    assert.deepEqual(ProductSort.rowBreakIndices(sorted), [6],
        'the drum block must start on its own row');
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
