/**
 * The backend's round-2 answer (2026-09-29) — ERR-299
 * backend-docs/inbox/fe-best-sellers-and-four-replies-round2-backend-response-sep2026.md
 *
 * Each ask the backend built retired a frontend workaround. The per-feature
 * suites carry most of the proof:
 *   BF-089/090 best sellers        tests/best-sellers-sep2026.test.js,
 *                                  tests/admin-analytics-wiring.test.js §6
 *   BF-091 counts = ?category=     tests/four-replies-backend-response-sep2026.test.js §D
 *   BF-092 ribbon related_products tests/pdp-related-sku-prefix-jul2026.test.js
 *   BF-088 chip-count view read    tests/four-replies-backend-response-sep2026.test.js §A
 * This file owns BF-093 (printer display_name), which touches five call sites,
 * and the cross-cutting "the retired reads stay retired" guards.
 *
 *   §1  PrinterName.of: the backend's display_name wins; the mirror is the
 *       fallback ONLY for rows without it (BF-094, asked)
 *   §2  every printer-row call site goes through display_name first
 *   §3  the ink finder's tiles print the backend's model name
 *   §4  retired reads stay retired (storefront + admin)
 *
 * The code is RUN where it can be (utils.js is required; the ink-finder helper is
 * evaluated). Grep-only checks are the ones where absence IS the claim.
 * Red-proof: python3 scripts/redproof-round2-sep2026.py
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const U = require('../inkcartridges/js/utils.js');

// Rows measured 2026-09-29 on /api/products/GTN2445BK and by-brand/brother.
const PDP_ROW = { model_name: 'HL L2375DW', full_name: 'Brother HL L2375DW', display_name: 'Brother HL-L2375DW', slug: 'brother-hl-l2375dw', brand: 'Brother' };
const LISTING_ROW = { slug: 'brother-hl-1110', full_name: 'Brother HL 1110' };   // /api/shop listing: no display_name (BF-094)

// ─────────────────────────────────────────────────────────────────────────────
// §1 PrinterName.of
// ─────────────────────────────────────────────────────────────────────────────

test('§1 display_name wins over the mirror', () => {
    assert.equal(U.PrinterName.of(PDP_ROW), 'Brother HL-L2375DW');
    // A name the mirror would NOT produce proves the server's string is used verbatim.
    assert.equal(U.PrinterName.of({ full_name: 'HP DESKJET 3520 E-ALL-IN-ONE-PRINTER', display_name: 'HP DeskJet 3520 e-All-in-One Printer' }),
        'HP DeskJet 3520 e-All-in-One Printer');
});

test('§1 a row without display_name falls back to the mirror (BF-094 still open)', () => {
    assert.equal(U.PrinterName.of(LISTING_ROW), 'Brother HL-1110');
    assert.equal(U.PrinterName.of({ full_name: 'Brother HL L2375DW', display_name: '   ' }), 'Brother HL-L2375DW', 'blank is absent');
    assert.equal(U.PrinterName.of({ brand: { name: 'Brother' }, model_name: 'MFC J5910DW' }), 'Brother MFC-J5910DW', 'brand object + model_name');
    assert.equal(U.PrinterName.of({ brand: 'HP', model_name: 'LASER JET 1020' }), 'HP Laser Jet 1020');
    assert.equal(U.PrinterName.of(null), '');
    assert.equal(U.PrinterName.of('Brother HL L2375DW'), '', 'a bare string is not a printer row');
});

test('§1 fitsLine reads display_name first and the mirror for a listing row', () => {
    assert.equal(U.PrinterName.fitsLine([PDP_ROW, LISTING_ROW], 5), 'Fits Brother HL-L2375DW, Brother HL-1110 +3');
    // A display_name the mirror cannot produce: only reading it verbatim passes.
    const hp = { full_name: 'HP DESKJET 3520 E-ALL-IN-ONE-PRINTER', display_name: 'HP DeskJet 3520 e-All-in-One Printer' };
    assert.equal(U.PrinterName.fitsLine([hp]), 'Fits HP DeskJet 3520 e-All-in-One Printer');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 call sites
// ─────────────────────────────────────────────────────────────────────────────

const PDP = stripComments(read('js/product-detail-page.js'));
const SHOP = stripComments(read('js/shop-page.js'));

test('§2 PDP fit checker, grouped top_models and flat list read display_name first', () => {
    assert.match(PDP, /const labelOf = \(p\) => p\.display_name\s*\|\| this\._printerLabel\(/);
    assert.match(PDP, /const shown = m\.display_name \|\| m\.full_name;/);
    assert.match(PDP, /group\.top_models\.filter\(m => m && \(m\.display_name \|\| m\.full_name\)\)/);
    assert.match(PDP, /let label = p\.display_name \|\| p\.full_name \|\| p\.name/);
});

test('§2 shop-page: the printer hub name and the landing printer search go through PrinterName.of', () => {
    assert.match(SHOP, /\(printerData && PrinterName\.of\(printerData\)\)/);
    assert.match(SHOP, /PrinterName\.of\(p\) : \(p\.full_name \|\| ''\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 ink finder tiles
// ─────────────────────────────────────────────────────────────────────────────

function modelLabel() {
    const src = read('js/ink-finder.js');
    const m = src.match(/\n    function modelLabel\(m\) \{[\s\S]*?\n    \}\n/);
    assert.ok(m, 'ink-finder.js must define modelLabel(m)');
    return vm.runInNewContext(`(${m[0].trim()})`);
}

test('§3 a tile prints the backend model name: "HL-L2375DW", not "HL L2375DW"', () => {
    const label = modelLabel();
    assert.equal(label({ model_name: 'HL L2375DW', full_name: 'Brother HL L2375DW', display_name: 'Brother HL-L2375DW' }), 'HL-L2375DW');
    assert.equal(label({ model_name: '10', full_name: 'Brother 10', display_name: 'Brother 10' }), '10');
});

test('§3 a tile falls back to model_name when the pieces do not line up', () => {
    const label = modelLabel();
    assert.equal(label({ model_name: 'HL L2375DW', full_name: 'Brother HL L2375DW' }), 'HL L2375DW', 'no display_name');
    assert.equal(label({ model_name: 'X1', full_name: 'Acme X1', display_name: 'Other X1' }), 'X1', 'prefix mismatch');
    assert.equal(label({ model_name: 'X1', full_name: 'Something else', display_name: 'Acme X1' }), 'X1', 'full_name does not end in model_name');
});

test('§3 both finder paths (grouped and flat) use it, and keep display_name as the full name', () => {
    const src = stripComments(read('js/ink-finder.js'));
    assert.equal((src.match(/name: modelLabel\((m|p)\),/g) || []).length, 2);
    assert.equal((src.match(/fullName: (m|p)\.display_name \|\| \1\.full_name,/g) || []).length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 retired reads stay retired
// ─────────────────────────────────────────────────────────────────────────────

function storefrontScripts() {
    const dir = path.join(ROOT, 'js');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

test('§4 no storefront script reads product_code_chip_counts or getCategoryTotal (BF-088, BF-091)', () => {
    for (const [f, src] of storefrontScripts()) {
        const code = stripComments(src);
        assert.doesNotMatch(code, /product_code_chip_counts/, `${f}: BF-088 — series carries every chip`);
        assert.doesNotMatch(code, /getCategoryTotal|_confirmMultiTypeZeros/, `${f}: BF-091 — counts = ?category=`);
    }
});

test('§4 the ribbon rail makes no direct products read (BF-092)', () => {
    assert.doesNotMatch(PDP, /RELATED_COLS|relatedSkuCandidates/);
});

test('§4 the admin best-sellers loader makes no catalogue read (BF-089)', () => {
    const api = stripComments(read('js/admin/api.js'));
    assert.doesNotMatch(api, /getProductMetaBySku|mergeBySku|attachCatalog/);
});

test('§4 POSITIVE CONTROL — the reads that are NOT retired are still there', () => {
    // The enrich fallback (5xx path) and the id-only compatibility read stay.
    assert.match(PDP, /rest\/v1\/products\?sku=eq\./);
    assert.match(stripComments(read('js/api.js')), /_CATEGORY_PRODUCT_TYPES:/);
    assert.match(stripComments(read('js/utils.js')), /BROTHER_PREFIX:/, 'the mirror stays until BF-094');
});
