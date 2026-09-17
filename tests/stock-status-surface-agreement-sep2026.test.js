/**
 * Stock vocabulary — PDP and product cards must agree (ERR-263)
 * =============================================================
 *
 * A shopper saw an Epson 273HY 4-Pack card reading "Contact Us For Stock
 * Enquiries" while the PDP for the same SKU, opened seconds later, read
 * "In Stock · Only 1 left · Add to Cart". The cause of THAT report was a
 * 15-minute Cloudflare edge cache sitting between the admin stock write and
 * the shopper (see backend-docs/outbox/search-edge-cache-stock-staleness-
 * backend-brief-sep2026.md) — the payloads were correct and so was the card.
 *
 * But the investigation surfaced a second, structural problem underneath it:
 * the pill and the button were computed by TWO DIFFERENT EXPRESSIONS with
 * INVERTED precedence.
 *
 *   • getStockStatus() (the pill)  read stock_status → in_stock → quantity
 *   • the card CTA, duplicated byte-identically in products.js and
 *     shop-page.js, read in_stock → stock_status → quantity
 *
 * Layered on a measured field asymmetry — /api/products and /api/search/smart
 * send in_stock + stock_quantity but NO stock_status; /api/products/:sku sends
 * all three; /api/search/suggest sends stock_quantity alone — this meant the
 * card NEVER evaluated stock_status and product-detail-page.js NEVER mentioned
 * in_stock. The two surfaces read different columns and agreed only because the
 * backend happened to keep them consistent.
 *
 * This file pins the repair: ONE precedence order in getStockStatus(), every
 * CTA derived from it, and absence of all three fields treated as a THIRD
 * STATE rather than silently as zero.
 *
 * Run with: node --test tests/stock-status-surface-agreement-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (f) => path.join(ROOT, 'inkcartridges', 'js', f);

const PRODUCTS_CODE = fs.readFileSync(JS('products.js'), 'utf8');
const SHOP_CODE = fs.readFileSync(JS('shop-page.js'), 'utf8');
const CART_CODE = fs.readFileSync(JS('cart.js'), 'utf8');

// Load api.js into a vm sandbox and hand back getStockStatus plus whatever
// DebugLog recorded, so the absence branch can be checked for loudness.
function loadApi() {
    const logged = [];
    const sandbox = {
        console,
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
        setTimeout, clearTimeout, AbortController,
        Headers: globalThis.Headers, URL, URLSearchParams, encodeURIComponent,
        Map, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon',
            settings: { GST_RATE: 0.15 },
            getSetting(key, fallback) { return this.settings[key] != null ? this.settings[key] : fallback; },
        },
        DebugLog: { log() {}, warn() {}, error(...a) { logged.push(a.join(' ')); } },
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
    vm.runInContext(fs.readFileSync(JS('api.js'), 'utf8'), ctx, { filename: 'api.js' });
    return { getStockStatus: sandbox.getStockStatus, logged };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the row matrix. One row per payload shape we actually receive.
// ─────────────────────────────────────────────────────────────────────────────

const OOS = 'contact-us';
const OK = 'in-stock';

const MATRIX = [
    // [label, row, expected class]
    ['list/search row, one unit left — THE ROW FROM THE REPORT',
        { sku: 'G273HYKCMY', in_stock: true, stock_quantity: 1 }, OK],
    ['list/search row, genuinely out of stock',
        { sku: 'G273HYCMY', in_stock: false, stock_quantity: 0 }, OOS],
    ['PDP row carrying all three fields',
        { sku: 'G273HYKCMY', in_stock: true, stock_quantity: 1, stock_status: 'in_stock' }, OK],
    ['/api/search/suggest row — stock_quantity only, no in_stock',
        { sku: 'G273HYKCMY', stock_quantity: 1 }, OK],
    ['/api/search/suggest row at zero',
        { sku: 'G273HYCMY', stock_quantity: 0 }, OOS],
    ['deliberate contact_us product that still has units on the shelf',
        { sku: 'X', stock_status: 'contact_us', in_stock: true, stock_quantity: 9 }, OOS],
    ['out_of_stock status',
        { sku: 'X', stock_status: 'out_of_stock', stock_quantity: 3 }, OOS],
    ['the contradiction: stock_status says in_stock, in_stock says false',
        { sku: 'X', stock_status: 'in_stock', in_stock: false }, OOS],
    ['a positive quantity NEVER overrides an explicit in_stock:false',
        { sku: 'X', in_stock: false, stock_quantity: 5 }, OOS],
];

for (const [label, row, expected] of MATRIX) {
    test(`§1 ${label} → ${expected}`, () => {
        const { getStockStatus } = loadApi();
        assert.equal(getStockStatus(row).class, expected);
    });
}

test('§1 in_stock:false + stock_quantity:5 must never become buyable', () => {
    // The one direction that costs real money: offering a unit the backend has
    // already said we do not have. in_stock is backend-derived and was measured
    // false on exactly the rows at quantity 0 across 300 products, so a row that
    // disagrees with itself is resolved toward NOT selling.
    const { getStockStatus } = loadApi();
    const s = getStockStatus({ in_stock: false, stock_quantity: 5 });
    assert.equal(s.class, 'contact-us');
    assert.equal(s.text, 'Contact Us For Stock Enquiries');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — absence is a THIRD STATE, not a zero
// ─────────────────────────────────────────────────────────────────────────────

test('§2 a row with no stock fields at all stays buyable and says so out loud', () => {
    // `undefined > 0` is false, and that false is indistinguishable from a real
    // out-of-stock. search.js adaptForCard backfills no stock field, so a
    // /api/search/suggest payload that ever stopped sending stock_quantity would
    // otherwise pull the buy button off EVERY dropdown card silently.
    const { getStockStatus, logged } = loadApi();
    const s = getStockStatus({ sku: 'MYSTERY' });
    assert.equal(s.class, 'in-stock', 'absence must not be read as zero');
    assert.equal(s.known, false, 'the partial-ness must ride in the RETURN VALUE');
    assert.ok(logged.some(l => /MYSTERY/.test(l)),
        'the unknown row must be logged, naming the row — a silent fallback is the bug');
});

test('§2 a real zero is still a zero, and is known', () => {
    const { getStockStatus } = loadApi();
    const s = getStockStatus({ sku: 'X', stock_quantity: 0 });
    assert.equal(s.class, 'contact-us');
    assert.equal(s.known, true, '0 is a measured count, not an absence');
});

test('§2 present-but-null counts as absent, not as zero', () => {
    const { getStockStatus } = loadApi();
    const s = getStockStatus({ sku: 'X', stock_status: null, in_stock: null, stock_quantity: null });
    assert.equal(s.class, 'in-stock');
    assert.equal(s.known, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — no surface may re-derive the decision from raw fields
// ─────────────────────────────────────────────────────────────────────────────

const RENDERERS = [
    ['products.js', PRODUCTS_CODE],
    ['shop-page.js', SHOP_CODE],
    ['cart.js', CART_CODE],
];

for (const [name, code] of RENDERERS) {
    test(`§3 ${name} derives its CTA from getStockStatus, not from raw fields`, () => {
        // The exact expression that was duplicated byte-identically across
        // products.js and shop-page.js. Two copies is two vocabularies, and two
        // vocabularies drift — that is what put an "In Stock" pill above a
        // "Contact us" button on the same card.
        assert.doesNotMatch(code, /product\.in_stock === false\s*\n\s*\|\|\s*product\.stock_status === 'out_of_stock'/,
            `${name} must not carry a local copy of the OOS expression`);
        assert.doesNotMatch(code, /\(product\.in_stock === undefined && \(product\.stock_quantity \|\| 0\) <= 0\)/,
            `${name} must not re-derive stock from stock_quantity — absence is not zero`);
    });
}

test('§3 the OOS expression exists in exactly one place: getStockStatus in api.js', () => {
    const apiCode = fs.readFileSync(JS('api.js'), 'utf8');
    for (const [name, code] of RENDERERS) {
        assert.doesNotMatch(code, /stock_status === 'contact_us'/,
            `${name} must not test stock_status itself — api.js owns the tri-state`);
    }
    assert.match(apiCode, /stock_status === 'contact_us'/,
        'api.js getStockStatus must be the one place that reads the tri-state');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — pill and button, on the same card, read the same object
// ─────────────────────────────────────────────────────────────────────────────

test('§4 products.js renders pill and CTA from the single stockInfo object', () => {
    assert.match(PRODUCTS_CODE, /const stockInfo = getStockStatus\(product\)/,
        'products.js must compute the status once');
    assert.match(PRODUCTS_CODE, /const oos = stockInfo\.class === 'contact-us'/,
        'the CTA must read the same object the pill rendered from');
});

test('§4 shop-page.js renders pill and CTA from the single stockStatus object', () => {
    assert.match(SHOP_CODE, /const stockStatus = getStockStatus\(product\)/,
        'shop-page.js must compute the status once');
    assert.match(SHOP_CODE, /const inStock = stockStatus\.class === 'in-stock'/,
        'shop-page.js must derive inStock from that object');
    assert.match(SHOP_CODE, /const oos = !inStock/,
        'the CTA must be the negation of the same value the pill used');
});

test('§4 the PDP branches on the same class vocabulary', () => {
    // product-detail-page.js never mentions in_stock at all — it reads
    // getStockStatus(...).class. That is now the SAME function the cards use,
    // which is the whole point of this file.
    const pdp = fs.readFileSync(JS('product-detail-page.js'), 'utf8');
    assert.match(pdp, /getStockStatus\(info\)/, 'PDP must call the shared helper');
    assert.match(pdp, /stockStatus\.class === 'contact-us'/,
        'PDP must branch on the shared class vocabulary');
});
