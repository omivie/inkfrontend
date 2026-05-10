/**
 * Catalog sort hierarchy — frontend contract tests (May 2026)
 * ===========================================================
 *
 * Pins the 22-position colour rank that supersedes the pre-May-2026
 * 8-tier bucket model. Mirror of the backend's productSort.js spec
 * shipped 2026-05-10.
 *
 *   Within a single (yieldTier, seriesBase) group:
 *
 *     0   Black            (K)            ─┐
 *     1   Cyan             (C)             │ standard singles
 *     2   Magenta          (M)             │
 *     3   Yellow           (Y)            ─┘
 *     4   Photo Black      (PB)           ─┐
 *     5   Matte Black      (MB)            │
 *     6   Light Cyan       (LC)            │
 *     6.5 Photo Cyan       (PC)            │
 *     7   Light Magenta    (LM)            │
 *     7.5 Photo Magenta    (PM)            │ specialty singles
 *     8   Vivid Light Magenta (VLM)        │
 *     9   Grey                             │
 *     10  Violet                           │
 *     11  Tri-Colour (single cartridge)    │
 *     12  Red                              │
 *     13  Blue                              │
 *     14  Green                             │
 *     15  Orange                            │
 *     16  White                             │
 *     17  Black/Red (legacy)              ─┘
 *     19  Unknown single
 *     20  CMY 3-Pack                      ─┐ packs
 *     21  KCMY 4-Pack / CMYK / BCMY       ─┘
 *
 * Sort key: (accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)
 *
 * What this file guards against:
 *
 *   - COLOR_RANK losing entries or drifting from the spec table.
 *   - Pack-name regex fallback failing (KCMY pack mislabeled as color="Black"
 *     would inherit colorOrder=0 and rank ahead of the K single).
 *   - colorOrder() returning the wrong rank for any spec-listed colour.
 *   - packRank tiebreaker failing when two rows tie on colorOrder.
 *   - accessoryTier failing to push paper / drum / printer rows below ink.
 *   - sortByCatalogOrder / sortByRelevance not exposed or returning
 *     non-arrays.
 *   - Real-world Epson 46S regression: pack ahead of specialty PB single.
 *
 * Spec: readfirst/sort-hierarchy-may2026.md
 *       Backend mirror: src/utils/productSort.js (spec dated 2026-05-10)
 *
 * Run: node --test tests/sort-hierarchy-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);

const { ProductSort } = require(JS('utils.js'));

// ─────────────────────────────────────────────────────────────────────────────
// 1. COLOR_RANK — the 22-position table
// ─────────────────────────────────────────────────────────────────────────────

test('COLOR_RANK: standard singles K/C/M/Y at ranks 0/1/2/3', () => {
    const r = ProductSort.COLOR_RANK;
    assert.equal(r['black'],   0);
    assert.equal(r['cyan'],    1);
    assert.equal(r['magenta'], 2);
    assert.equal(r['yellow'],  3);
});

test('COLOR_RANK: specialty singles slot between standards (4-17)', () => {
    const r = ProductSort.COLOR_RANK;
    assert.equal(r['photo black'],         4);
    assert.equal(r['matte black'],         5);
    assert.equal(r['light cyan'],          6);
    assert.equal(r['photo cyan'],          6.5);
    assert.equal(r['light magenta'],       7);
    assert.equal(r['photo magenta'],       7.5);
    assert.equal(r['vivid light magenta'], 8);
    assert.equal(r['grey'],                9);
    assert.equal(r['gray'],                9);
    assert.equal(r['violet'],             10);
    assert.equal(r['tri-colour'],         11);
    assert.equal(r['tri-color'],          11);
    assert.equal(r['red'],                12);
    assert.equal(r['blue'],               13);
    assert.equal(r['green'],              14);
    assert.equal(r['orange'],             15);
    assert.equal(r['white'],              16);
    assert.equal(r['black/red'],          17);
});

test('COLOR_RANK: packs (CMY=20, KCMY/CMYK/BCMY=21)', () => {
    const r = ProductSort.COLOR_RANK;
    assert.equal(r['cmy'],    20);
    assert.equal(r['kcmy'],   21);
    assert.equal(r['cmyk'],   21);
    assert.equal(r['bcmy'],   21);
    assert.equal(r['3-pack'], 20);
    assert.equal(r['4-pack'], 21);
});

test('COLOR_RANK: short aliases match their canonical names', () => {
    const r = ProductSort.COLOR_RANK;
    assert.equal(r['k'], r['black']);
    assert.equal(r['c'], r['cyan']);
    assert.equal(r['m'], r['magenta']);
    assert.equal(r['y'], r['yellow']);
    assert.equal(r['pb'], r['photo black']);
    assert.equal(r['mb'], r['matte black']);
    assert.equal(r['lc'], r['light cyan']);
    assert.equal(r['pc'], r['photo cyan']);
    assert.equal(r['lm'], r['light magenta']);
    assert.equal(r['pm'], r['photo magenta']);
    assert.equal(r['vlm'], r['vivid light magenta']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. colorOrder — primary sort key per product
// ─────────────────────────────────────────────────────────────────────────────

test('colorOrder: every spec-table colour resolves to its declared rank', () => {
    const expected = [
        ['Black',                0],
        ['Cyan',                 1],
        ['Magenta',              2],
        ['Yellow',               3],
        ['Photo Black',          4],
        ['Matte Black',          5],
        ['Light Cyan',           6],
        ['Photo Cyan',           6.5],
        ['Light Magenta',        7],
        ['Photo Magenta',        7.5],
        ['Vivid Light Magenta',  8],
        ['Grey',                 9],
        ['Gray',                 9],
        ['Violet',              10],
        ['Tri-Colour',          11],
        ['Red',                 12],
        ['Blue',                13],
        ['Green',               14],
        ['Orange',              15],
        ['White',               16],
        ['Black/Red',           17]
    ];
    for (const [color, rank] of expected) {
        assert.equal(ProductSort.colorOrder({ color }), rank,
            `colorOrder('${color}') must equal ${rank}`);
    }
});

test('colorOrder: unknown / missing colour → RANK_UNKNOWN_SINGLE (19)', () => {
    assert.equal(ProductSort.colorOrder({}), ProductSort.RANK_UNKNOWN_SINGLE);
    assert.equal(ProductSort.colorOrder({ color: '' }), ProductSort.RANK_UNKNOWN_SINGLE);
    assert.equal(ProductSort.colorOrder({ color: 'Plasma' }), ProductSort.RANK_UNKNOWN_SINGLE);
    assert.equal(ProductSort.RANK_UNKNOWN_SINGLE, 19,
        'unknown single sits between specialty (≤17) and packs (≥20)');
});

test('colorOrder: CMY value-pack → 20, KCMY value-pack → 21', () => {
    assert.equal(ProductSort.colorOrder({ color: 'CMY',  pack_type: 'value_pack' }), 20);
    assert.equal(ProductSort.colorOrder({ color: 'KCMY', pack_type: 'value_pack' }), 21);
    assert.equal(ProductSort.colorOrder({ color: 'CMYK', pack_type: 'value_pack' }), 21);
    assert.equal(ProductSort.colorOrder({ color: 'BCMY', pack_type: 'value_pack' }), 21);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pack-name regex fallback — defends against mislabeled feed rows
// ─────────────────────────────────────────────────────────────────────────────

test('pack-name regex: KCMY 4-Pack with color="Black" still ranks 21 (not 0)', () => {
    // Real failure mode: supplier feed lists value packs with the SKU's
    // primary colour in the `color` field. Without the name-first regex,
    // a "Brother Genuine LC3317 KCMY 4-Pack" with color="Black" would
    // inherit colorOrder=0 and rank ahead of the K single.
    const row = {
        sku: 'GP-BR-LC3317-KCMY',
        name: 'Brother Genuine LC3317 KCMY 4-Pack',
        color: 'Black',                  // ← mislabeled by supplier feed
        pack_type: 'value_pack'
    };
    assert.equal(ProductSort.colorOrder(row), 21,
        'KCMY in name must dominate the color="Black" feed bug');
});

test('pack-name regex: "4-Pack" / "4-Colour" alone trigger rank 21', () => {
    assert.equal(ProductSort.colorOrder({
        name: 'Generic 4-Pack',  color: 'Black'
    }), 21);
    assert.equal(ProductSort.colorOrder({
        name: 'Generic 4 colour pack',  color: 'Black'
    }), 21);
    assert.equal(ProductSort.colorOrder({
        name: 'Generic 4 color pack',  color: 'Black'
    }), 21);
});

test('pack-name regex: "CMY" / "3-Pack" / "3-Colour" alone trigger rank 20', () => {
    assert.equal(ProductSort.colorOrder({
        name: 'Brother LC3317 Value Pack CMY 3-Pack',  color: 'Black'
    }), 20);
    assert.equal(ProductSort.colorOrder({
        name: 'Brother 3-Pack Tri-Colour',  color: 'Black'
    }), 20);
    assert.equal(ProductSort.colorOrder({
        name: 'Brother 3 colour pack',  color: 'Black'
    }), 20);
});

test('pack-name regex: KCMY beats CMY when both could match', () => {
    // "KCMY" contains "CMY" as a substring. The regex MUST short-circuit
    // on the 4-token branch before testing the 3-token branch.
    assert.equal(ProductSort.colorOrder({
        name: 'Brother Genuine LC3317 KCMY 4-Pack',
        color: 'Black',
        pack_type: 'value_pack'
    }), 21);
});

test('pack-name regex: word-boundary anchored — "OCM Y" or "ACMY" do not false-match', () => {
    // Random text with substring "CMY" or "KCMY" but not as a standalone
    // token must NOT trip the regex.
    assert.equal(ProductSort.colorOrder({
        name: 'Acme Tracmy Cyan',  color: 'Cyan'
    }), 1, 'embedded CMY must not promote a Cyan single to a pack');
});

test('pack-name regex: case insensitive', () => {
    assert.equal(ProductSort.colorOrder({
        name: 'brother lc3317 kcmy 4-pack',  color: 'Black'
    }), 21);
    assert.equal(ProductSort.colorOrder({
        name: 'BROTHER LC3317 cmy 3-pack',  color: 'Black'
    }), 20);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. accessoryTier — cartridges before paper / drums / printers
// ─────────────────────────────────────────────────────────────────────────────

test('accessoryTier: ink + toner cartridges land in tier 0', () => {
    assert.equal(ProductSort.accessoryTier({ category: 'ink' }),   0);
    assert.equal(ProductSort.accessoryTier({ category: 'toner' }), 0);
    assert.equal(ProductSort.accessoryTier({
        name: 'HP Genuine 975A Ink Cartridge Black'
    }), 0);
});

test('accessoryTier: drum units / paper / printers all rank below cartridges', () => {
    assert.ok(ProductSort.accessoryTier({ category: 'drum' }) >= 1);
    assert.ok(ProductSort.accessoryTier({ category: 'paper' }) >= 2);
    assert.ok(ProductSort.accessoryTier({ name: 'HP LaserJet Printer' }) >= 1);
});

test('sortByCatalogOrder: cartridge sorts ahead of paper at the same brand level', () => {
    const input = [
        { sku: 'PAPER-1',     name: 'HP Photo Paper A4',           category: 'paper' },
        { sku: 'INK-BK',      name: 'HP Genuine 975A Ink Black',   category: 'ink', color: 'Black' },
        { sku: 'INK-CY',      name: 'HP Genuine 975A Ink Cyan',    category: 'ink', color: 'Cyan' }
    ];
    const sorted = ProductSort.sortByCatalogOrder(input);
    assert.equal(sorted[0].sku, 'INK-BK', 'ink lands ahead of paper');
    assert.equal(sorted[sorted.length - 1].sku, 'PAPER-1', 'paper lands last');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. packRank — final tiebreaker after colorOrder
// ─────────────────────────────────────────────────────────────────────────────

test('packRank: single (0) < value_pack (1) < multipack (2)', () => {
    assert.equal(ProductSort.packRank({}), 0);
    assert.equal(ProductSort.packRank({ pack_type: 'single' }), 0);
    assert.equal(ProductSort.packRank({ pack_type: 'value_pack' }), 1);
    assert.equal(ProductSort.packRank({ pack_type: 'multipack' }), 2);
});

test('packRank: tiebreaks two rows that resolve to the same colorOrder', () => {
    // Two rows both detected as KCMY (rank 21) — one a value_pack, one a
    // multipack. value_pack should land ahead of multipack via packRank.
    const a = { name: 'Brother LC3317 KCMY 4-Pack', color: 'KCMY', pack_type: 'value_pack' };
    const b = { name: 'Brother LC3317 KCMY 4-Pack Bundle', color: 'KCMY', pack_type: 'multipack' };
    assert.equal(ProductSort.colorOrder(a), 21);
    assert.equal(ProductSort.colorOrder(b), 21);
    assert.ok(ProductSort.packRank(a) < ProductSort.packRank(b));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. seriesBase — alphanumeric MPN family extraction
// ─────────────────────────────────────────────────────────────────────────────

test('seriesBase: returns the bare base for a Brother TN645 family', () => {
    const base = ProductSort.seriesBase({
        name: 'Brother Genuine TN645BK Toner Cartridge Black',
        brand: { name: 'Brother' }
    });
    assert.equal(base, 'TN645');
});

test('seriesBase: collapses XL / XXL / HY suffixes onto the same base', () => {
    const std = ProductSort.seriesBase({
        name: 'Brother Genuine TN645BK Toner Cartridge Black',
        brand: { name: 'Brother' }
    });
    const xl = ProductSort.seriesBase({
        name: 'Brother Genuine TN645XLBK Toner Cartridge Black',
        brand: { name: 'Brother' }
    });
    const xxl = ProductSort.seriesBase({
        name: 'Brother Genuine TN645XXLBK Toner Cartridge Black',
        brand: { name: 'Brother' }
    });
    assert.equal(xl, std);
    assert.equal(xxl, std);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. sortByCatalogOrder — full 6-tuple application
// ─────────────────────────────────────────────────────────────────────────────

test('sortByCatalogOrder: Epson 46S regression — PB single sorts before CMY pack', () => {
    // Pre-May 2026 contract bucketed Photo Black with K (rank 0). When
    // the API returned a CMY pack alongside, the pack ranked 4 (CMY tier)
    // and PB ranked 0 (K tier), so PB came first — but in the legacy
    // `colorTier` view, packs at 4 came BETWEEN K (0) and specialty (6).
    // The new contract makes packs the LAST rank (20-21), so every
    // single — including PB at 4 — sorts before the pack.
    const input = [
        { sku: 'PACK',  name: 'Epson 46S CMY 3-Pack',         color: 'CMY',         pack_type: 'value_pack', category: 'ink' },
        { sku: 'PB',    name: 'Epson 46S Ink Cartridge Photo Black', color: 'Photo Black', pack_type: 'single',   category: 'ink' },
        { sku: 'BK',    name: 'Epson 46S Ink Cartridge Black',       color: 'Black',       pack_type: 'single',   category: 'ink' }
    ];
    const sorted = ProductSort.sortByCatalogOrder(input);
    assert.deepEqual(sorted.map(p => p.sku), ['BK', 'PB', 'PACK'],
        'Black (0) → Photo Black (4) → CMY 3-Pack (20)');
});

test('sortByCatalogOrder: full series with std + XL yields stacks std before XL', () => {
    const input = [
        { sku: 'XL-K',  name: 'Brother Genuine TN645XLBK Toner Cartridge Black',  color: 'Black',   pack_type: 'single', category: 'toner' },
        { sku: 'STD-Y', name: 'Brother Genuine TN645Y Toner Cartridge Yellow',    color: 'Yellow',  pack_type: 'single', category: 'toner' },
        { sku: 'STD-K', name: 'Brother Genuine TN645BK Toner Cartridge Black',    color: 'Black',   pack_type: 'single', category: 'toner' },
        { sku: 'XL-C',  name: 'Brother Genuine TN645XLC Toner Cartridge Cyan',    color: 'Cyan',    pack_type: 'single', category: 'toner' }
    ];
    const sorted = ProductSort.sortByCatalogOrder(input);
    // Same series, std (yield 0) before XL (yield 1); within each yield
    // K (0) before C (1) before Y (3).
    assert.deepEqual(sorted.map(p => p.sku), ['STD-K', 'STD-Y', 'XL-K', 'XL-C']);
});

test('sortByCatalogOrder: returns NEW array, never mutates input', () => {
    const input = [
        { color: 'Yellow' }, { color: 'Black' }, { color: 'Cyan' }
    ];
    const before = JSON.stringify(input);
    const out = ProductSort.sortByCatalogOrder(input);
    assert.notStrictEqual(out, input);
    assert.equal(JSON.stringify(input), before);
});

test('sortByCatalogOrder: edge cases — null / undefined / non-array / single', () => {
    assert.deepEqual(ProductSort.sortByCatalogOrder(null), []);
    assert.deepEqual(ProductSort.sortByCatalogOrder(undefined), []);
    assert.deepEqual(ProductSort.sortByCatalogOrder('not-array'), []);
    assert.deepEqual(ProductSort.sortByCatalogOrder([]), []);
    assert.deepEqual(ProductSort.sortByCatalogOrder([{ color: 'Cyan' }]), [{ color: 'Cyan' }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. sortByRelevance — score-aware variant (smart-search mirror)
// ─────────────────────────────────────────────────────────────────────────────

test('sortByRelevance: cross-family — score wins', () => {
    const scoreMap = new Map([
        ['HP-A',  10.0],
        ['BR-A',   2.0]
    ]);
    const input = [
        { sku: 'BR-A', name: 'Brother Genuine TN645BK Toner Cartridge Black', color: 'Black', brand: { name: 'Brother' }, category: 'toner' },
        { sku: 'HP-A', name: 'HP Genuine 975A Ink Cartridge Cyan',            color: 'Cyan',  brand: { name: 'HP' },      category: 'ink' }
    ];
    const sorted = ProductSort.sortByRelevance(input, scoreMap);
    assert.equal(sorted[0].sku, 'HP-A',
        'higher relevance score promotes HP-A above the lower-scored Brother row');
});

test('sortByRelevance: within a family — colour hierarchy overrides score', () => {
    // Two HP 975A genuines (same family + yield). Even if smart-search
    // happens to score Cyan higher than Black due to RPC variance, the
    // contract demands K before C.
    const scoreMap = new Map([
        ['HP-K', 1.0],
        ['HP-C', 5.0]   // Cyan happens to score higher
    ]);
    const input = [
        { sku: 'HP-C', name: 'HP Genuine 975A Ink Cartridge Cyan',  color: 'Cyan',  brand: { name: 'HP' }, category: 'ink' },
        { sku: 'HP-K', name: 'HP Genuine 975A Ink Cartridge Black', color: 'Black', brand: { name: 'HP' }, category: 'ink' }
    ];
    const sorted = ProductSort.sortByRelevance(input, scoreMap);
    assert.equal(sorted[0].sku, 'HP-K',
        'within-family colour hierarchy must beat per-row score variance');
});

test('sortByRelevance: handles missing scoreMap gracefully', () => {
    const input = [
        { sku: 'A', name: 'HP Genuine 975A Ink Cartridge Cyan',  color: 'Cyan',  brand: { name: 'HP' }, category: 'ink' },
        { sku: 'B', name: 'HP Genuine 975A Ink Cartridge Black', color: 'Black', brand: { name: 'HP' }, category: 'ink' }
    ];
    const sorted = ProductSort.sortByRelevance(input);
    // No scores → falls back to catalog order (K → C).
    assert.equal(sorted[0].sku, 'B');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Public API — exported helpers
// ─────────────────────────────────────────────────────────────────────────────

test('ProductSort exports the new spec helpers', () => {
    const required = [
        'COLOR_RANK', 'RANK_UNKNOWN_SINGLE',
        'PACK_NAME_REGEX_3', 'PACK_NAME_REGEX_4',
        'accessoryTier', 'yieldTier', 'sourceTier',
        'seriesBase', 'packRank',
        'colorOrder', 'colorIndex', 'colorTier',
        'resolveColorName', 'familyKey',
        'byColor', 'byCodeThenColor', 'byYieldAndColor',
        'rowBreakIndices', 'groupByFamilyScored',
        'sortByCatalogOrder', 'sortByRelevance'
    ];
    for (const name of required) {
        assert.ok(name in ProductSort,
            `ProductSort.${name} must be exported so call-sites can use the spec API`);
    }
});

test('COLOR_RANK is frozen — accidental mutation is caught at runtime', () => {
    assert.ok(Object.isFrozen(ProductSort.COLOR_RANK),
        'mutating COLOR_RANK at runtime would silently break ordering — must be frozen');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. End-to-end ordering invariants — readable assertions across the table
// ─────────────────────────────────────────────────────────────────────────────

test('every standard single ranks below every specialty single', () => {
    const standards = ['Black', 'Cyan', 'Magenta', 'Yellow'];
    const specialty = ['Photo Black', 'Matte Black', 'Light Cyan', 'Light Magenta',
                       'Photo Cyan', 'Photo Magenta', 'Vivid Light Magenta',
                       'Grey', 'Violet', 'Tri-Colour', 'Red', 'Blue', 'Green',
                       'Orange', 'White', 'Black/Red'];
    for (const std of standards) {
        for (const spec of specialty) {
            assert.ok(
                ProductSort.colorOrder({ color: std }) <
                ProductSort.colorOrder({ color: spec }),
                `${std} (${ProductSort.colorOrder({ color: std })}) must rank below ${spec} (${ProductSort.colorOrder({ color: spec })})`
            );
        }
    }
});

test('every single (standard or specialty) ranks below every pack', () => {
    const singles = [
        'Black', 'Cyan', 'Magenta', 'Yellow',
        'Photo Black', 'Matte Black', 'Light Cyan', 'Photo Cyan',
        'Light Magenta', 'Photo Magenta', 'Vivid Light Magenta',
        'Grey', 'Violet', 'Tri-Colour',
        'Red', 'Blue', 'Green', 'Orange', 'White', 'Black/Red'
    ];
    const cmyPack  = { color: 'CMY',  pack_type: 'value_pack' };
    const kcmyPack = { color: 'KCMY', pack_type: 'value_pack' };
    for (const c of singles) {
        const single = { color: c };
        assert.ok(ProductSort.colorOrder(single) < ProductSort.colorOrder(cmyPack),
            `${c} must rank below CMY 3-Pack`);
        assert.ok(ProductSort.colorOrder(single) < ProductSort.colorOrder(kcmyPack),
            `${c} must rank below KCMY 4-Pack`);
    }
});

test('CMY 3-Pack ranks below KCMY 4-Pack', () => {
    assert.ok(
        ProductSort.colorOrder({ color: 'CMY',  pack_type: 'value_pack' }) <
        ProductSort.colorOrder({ color: 'KCMY', pack_type: 'value_pack' })
    );
});

test('Tri-Colour single (rank 11) ranks BELOW the Red specialty (rank 12)', () => {
    // Important distinction: Tri-Colour is a SINGLE cartridge that prints
    // three colours (HP 22, Canon CL-541), NOT a 3-pack of separate
    // cartridges. CMY 3-Pack (three cartridges) sits at rank 20.
    assert.equal(ProductSort.colorOrder({ color: 'Tri-Colour' }), 11);
    assert.equal(ProductSort.colorOrder({ color: 'Red' }),        12);
    // And both of these specialty singles still rank ahead of the CMY pack:
    assert.ok(ProductSort.colorOrder({ color: 'Tri-Colour' }) <
              ProductSort.colorOrder({ color: 'CMY', pack_type: 'value_pack' }));
});
