/**
 * Ribbon PDP related products — prefix-tolerant SKU resolution
 * ============================================================
 *
 * The bug (ERR-084, Jul 2026): 307.11's curated `related_product_skus` were
 * ["141LOT","143LOT"] but the real tapes are C141LOT / C143LOT, so an exact
 * `.in('sku', …)` resolved nothing and the rail was a bare heading. The PDP then
 * resolved exact-first over C-/G- candidates with a direct Supabase read.
 *
 * Since BF-092 (ERR-299, 2026-09-29) the SERVER does that resolution:
 * GET /api/ribbons/:sku returns `related_products` in saved order, active +
 * public only, a bare code trying its C- then G- form after the exact SKU,
 * duplicates and the ribbon itself dropped. Measured: 307.11 → C141LOT, C143LOT;
 * 153.11 → C143LOT; 72200.01 → 72200.02. probe:four-replies §V re-measures it.
 *
 * What the PDP still owns, and this file pins by RUNNING it
 * (`ribbonRelatedCards`): keep the server's order, rename the card fields
 * Products.renderCard reads, and tell a failed lookup from an empty one.
 *
 * Run: node --test tests/pdp-related-sku-prefix-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PDP_PATH = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');
const PDP_SRC = fs.readFileSync(PDP_PATH, 'utf8');

// stripComments now has ONE owner (ERR-253). Every test file used to carry its
// own two-regex copy that removed block comments first, so a line comment
// containing a starred path silently deleted live code — 22,251 characters of
// it across 35 suites. See tests/helpers/strip-comments.js.
const stripComments = require('./helpers/strip-comments');
const PDP_CODE = stripComments(PDP_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure helper out of product-detail-page.js. Only top-level
// declarations + event-listener registrations run at load, so a permissive
// document/window stub is enough. Mirrors the shop-page helper test.
// ─────────────────────────────────────────────────────────────────────────────
function loadPdpHelpers() {
    const noop = () => {};
    const docStub = {
        addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, setAttribute: noop, appendChild: noop }),
        body: { appendChild: noop }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        addEventListener: noop, removeEventListener: noop,
        document: docStub,
        location: { search: '', pathname: '/ribbon/307.11', href: 'http://localhost/ribbon/307.11' },
        history: { replaceState: noop, pushState: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        IntersectionObserver: function () { return { observe: noop, disconnect: noop }; },
        MutationObserver: function () { return { observe: noop, disconnect: noop }; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(PDP_SRC, ctx, { filename: 'product-detail-page.js' });
    const helpers = sandbox.window._pdpRelatedHelpers;
    assert.ok(helpers, 'product-detail-page.js must expose window._pdpRelatedHelpers');
    return helpers;
}

// The /api/ribbons/:sku `related_products` for 307.11, measured 2026-09-29
// (quantity_breaks and timestamps trimmed).
const LIVE_307 = [
    { id: '20e3c4a5', sku: 'C141LOT', name: 'IBM Compatible 141LOT Correction Ribbon Tape', brand: 'IBM',
      product_type: 'correction_tape', color: null, sale_price: 11.95, stock_quantity: 100, is_active: true,
      image_url: 'https://x/141lot.webp', in_stock: true, stock_status: 'in_stock' },
    { id: '36224f3d', sku: 'C143LOT', name: 'Olympia Compatible 143LOT Correction Ribbon Tape', brand: 'Olympia',
      product_type: 'correction_tape', color: null, sale_price: 11.95, stock_quantity: 95, is_active: true,
      image_url: 'https://x/143lot.webp', in_stock: true, stock_status: 'in_stock' },
];
const plain = (v) => JSON.parse(JSON.stringify(v));

test('307.11: the server-resolved cards render in the server\'s (saved) order', () => {
    const { ribbonRelatedCards } = loadPdpHelpers();
    const out = ribbonRelatedCards({ sku: '307.11', related_product_skus: ['141LOT', '143LOT'], related_products: LIVE_307 });
    assert.equal(out.failed, false);
    assert.deepEqual(out.cards.map((c) => c.sku), ['C141LOT', 'C143LOT'], 'bare codes resolved server-side (ERR-084 rule)');
});

test('card fields are RENAMED for Products.renderCard — never computed', () => {
    const { ribbonRelatedCards } = loadPdpHelpers();
    const [c] = plain(ribbonRelatedCards({ related_products: LIVE_307 }).cards);
    assert.equal(c.retail_price, 11.95, 'retail_price is the server\'s sale_price, unchanged');
    assert.deepEqual(c.brand, { name: 'IBM' }, 'renderCard reads brand.name');
    assert.equal(c.stock_status, 'in_stock');
    assert.equal(c.sale_price, 11.95, 'the original field is kept');
    const [d] = plain(ribbonRelatedCards({ related_products: [{ sku: 'X', retail_price: 5, sale_price: 4, brand: { name: 'B' } }] }).cards);
    assert.equal(d.retail_price, 5, 'a retail_price the server sends wins');
    assert.deepEqual(d.brand, { name: 'B' });
    const [e] = plain(ribbonRelatedCards({ related_products: [{ sku: 'Y' }] }).cards);
    assert.equal(e.retail_price, null, 'no price is a missing price, never 0');
});

test('[] is "nothing to show"; null is "the server\'s lookup FAILED"', () => {
    const { ribbonRelatedCards } = loadPdpHelpers();
    assert.deepEqual(plain(ribbonRelatedCards({ related_product_skus: ['ZZZ'], related_products: [] })), { failed: false, cards: [] });
    assert.equal(ribbonRelatedCards({ related_product_skus: [], related_products: null }).failed, true);
});

test('ABSENT related_products with a curated list is unmeasured — failed, not empty', () => {
    const { ribbonRelatedCards } = loadPdpHelpers();
    assert.equal(ribbonRelatedCards({ related_product_skus: ['141LOT'] }).failed, true,
        'an older backend or the fallback product path: never claim the owner curated nothing');
    assert.equal(ribbonRelatedCards({ related_product_skus: [] }).failed, false, 'nothing curated, nothing to fail');
    assert.equal(ribbonRelatedCards({}).failed, false);
});

test('a card without a sku is dropped (it could not be linked)', () => {
    const { ribbonRelatedCards } = loadPdpHelpers();
    assert.deepEqual(ribbonRelatedCards({ related_products: [null, { name: 'no sku' }, LIVE_307[0]] }).cards.map((c) => c.sku), ['C141LOT']);
});

test('renderRelatedProducts — the ribbon branch uses ribbonRelatedCards and makes NO Supabase read', () => {
    const ribbonBranch = PDP_CODE.slice(
        PDP_CODE.indexOf("if (info.category === 'ribbon') {"),
        PDP_CODE.indexOf('} else {', PDP_CODE.indexOf("if (info.category === 'ribbon') {"))
    );
    assert.match(ribbonBranch, /ribbonRelatedCards\(info\)/);
    assert.match(ribbonBranch, /fetchFailed = true/);
    assert.doesNotMatch(ribbonBranch, /sb\.from|Auth\.supabase|\.in\('sku'/, 'the server resolves the list now (BF-092)');
    assert.doesNotMatch(PDP_CODE, /relatedSkuCandidates/, 'the client-side resolver is gone');
});
