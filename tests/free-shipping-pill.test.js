/**
 * Free-shipping pill / qualifiesForFreeShipping contract
 * =======================================================
 *
 * Pin the rules behind the FREE SHIPPING product-card pill, the PDP
 * "Free NZ shipping included" callout, and the schema.org Offer
 * shippingRate so they cannot drift apart again.
 *
 * Background: the shop-page renderer used to gate the pill on
 * `stockStatus.class !== 'contact-us'`, which silently dropped the badge
 * for any Contact-Us product even when its retail price was well above
 * the threshold (e.g. the $522 / $528 / $679 Brother TN258 4-packs).
 * The threshold itself was hardcoded to 100 in three different places
 * (shop-page.js, products.js, product-detail-page.js), so it could
 * disagree with Config.FREE_SHIPPING_THRESHOLD without anyone noticing.
 *
 * The fix added a single helper, `qualifiesForFreeShipping(product)`, in
 * api.js. This file is the safety net: if anyone re-introduces a stock-
 * status gate or a hardcoded threshold, these tests fail.
 *
 * Run with: node --test tests/free-shipping-pill.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');
const SHOP_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const PRODUCTS_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'products.js');
const PDP_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');

// ─────────────────────────────────────────────────────────────────────────────
// Helper-level tests — load api.js into a vm sandbox and exercise
// qualifiesForFreeShipping directly.
// ─────────────────────────────────────────────────────────────────────────────

function loadApi({ threshold = 100 } = {}) {
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
            settings: { FREE_SHIPPING_THRESHOLD: threshold, GST_RATE: 0.15 },
            getSetting(key, fallback) {
                return this.settings[key] != null ? this.settings[key] : fallback;
            },
        },
        DebugLog: { log() {}, warn() {}, error() {} },
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
    vm.runInContext(fs.readFileSync(API_JS_PATH, 'utf8'), ctx, { filename: 'api.js' });
    // qualifiesForFreeShipping is exported via window.qualifiesForFreeShipping
    return { qualifies: sandbox.qualifiesForFreeShipping, sandbox };
}

test('qualifiesForFreeShipping — undefined / null product returns false', () => {
    const { qualifies } = loadApi();
    assert.equal(qualifies(undefined), false);
    assert.equal(qualifies(null), false);
    assert.equal(qualifies({}), false);
});

test('qualifiesForFreeShipping — null/undefined retail_price returns false', () => {
    const { qualifies } = loadApi();
    assert.equal(qualifies({ retail_price: null }), false);
    assert.equal(qualifies({ retail_price: undefined }), false);
    // 0 is a real number below threshold — must NOT qualify, but must not throw.
    assert.equal(qualifies({ retail_price: 0 }), false);
});

test('qualifiesForFreeShipping — below threshold returns false', () => {
    const { qualifies } = loadApi();
    assert.equal(qualifies({ retail_price: 50 }), false);
    assert.equal(qualifies({ retail_price: 99.99 }), false);
});

test('qualifiesForFreeShipping — at threshold (boundary) qualifies', () => {
    const { qualifies } = loadApi();
    // The cart progress bar renders 100/100 as "you've unlocked free shipping",
    // so a product priced exactly at the threshold must show the pill.
    assert.equal(qualifies({ retail_price: 100 }), true);
});

test('qualifiesForFreeShipping — above threshold qualifies regardless of stock', () => {
    const { qualifies } = loadApi();
    // The exact products that triggered the bug: Contact-Us 4-packs.
    // Stock status MUST NOT be a gate — the pill is a price-based offer.
    assert.equal(qualifies({ retail_price: 522.49, in_stock: false, stock_quantity: 0 }), true);
    assert.equal(qualifies({ retail_price: 528.99, in_stock: false }), true);
    assert.equal(qualifies({ retail_price: 679.99, stock_status: 'contact_us' }), true);
    assert.equal(qualifies({ retail_price: 180.99, stock_status: 'out_of_stock' }), true);
});

test('qualifiesForFreeShipping — value pack with discount qualifies on retail (not original) price', () => {
    const { qualifies } = loadApi();
    // GEN-PACK-BRO-TN258-CMY: backend reports retail_price=400.49, original_price=410.97.
    // We charge $400.49, so $400.49 is the threshold-relevant figure.
    assert.equal(qualifies({
        retail_price: 400.49,
        original_price: 410.97,
        discount_amount: 10.48,
        pack_type: 'value_pack',
    }), true);
});

test('qualifiesForFreeShipping — threshold reads from Config.getSetting', () => {
    // Bump the threshold and confirm a $120 product flips from qualifying to not.
    const lo = loadApi({ threshold: 100 });
    const hi = loadApi({ threshold: 150 });
    assert.equal(lo.qualifies({ retail_price: 120 }), true);
    assert.equal(hi.qualifies({ retail_price: 120 }), false);
});

test('qualifiesForFreeShipping — falls back to 100 when Config is missing', () => {
    // Same setup but blow away Config to confirm the safe default kicks in.
    const sandbox = {
        console, fetch: async () => ({ ok: true }),
        setTimeout, clearTimeout, AbortController,
        Headers: globalThis.Headers, URL, URLSearchParams, encodeURIComponent,
        Map, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol,
        // Config intentionally undefined.
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { cookie: '' },
        window: {},
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    // api.js references Config at module-evaluation time, so stub the bare minimum.
    sandbox.Config = { API_URL: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
    vm.runInContext(fs.readFileSync(API_JS_PATH, 'utf8'), ctx, { filename: 'api.js' });
    // Now wipe Config so the helper takes the fallback branch.
    sandbox.Config = undefined;
    assert.equal(sandbox.qualifiesForFreeShipping({ retail_price: 100 }), true);
    assert.equal(sandbox.qualifiesForFreeShipping({ retail_price: 99.99 }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Static guards on render code — keep the helper as the SINGLE site of the
// "100" comparison so the threshold cannot drift again.
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js card pill goes through qualifiesForFreeShipping', () => {
    const src = fs.readFileSync(SHOP_JS_PATH, 'utf8');
    assert.match(src, /qualifiesForFreeShipping\(product\)/,
        'shop-page.js must call qualifiesForFreeShipping for the FREE SHIPPING pill');
    assert.doesNotMatch(src, /retail_price\s*>=\s*100/,
        'shop-page.js must not hardcode the 100 threshold any more');
    assert.doesNotMatch(src, /stockStatus\.class\s*!==\s*['"]contact-us['"][\s\S]{0,80}retail_price/,
        'shop-page.js must not gate the FREE SHIPPING pill on stock status');
});

test('products.js card pill goes through qualifiesForFreeShipping', () => {
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    assert.match(src, /qualifiesForFreeShipping\(product\)/,
        'products.js must call qualifiesForFreeShipping for the FREE SHIPPING pill');
    assert.doesNotMatch(src, /retail_price[^\n]{0,40}>=\s*100/,
        'products.js must not hardcode the 100 threshold any more');
});

test('product-detail-page.js shipping note + schema use the helper', () => {
    const src = fs.readFileSync(PDP_JS_PATH, 'utf8');
    // Both surfaces switched to the helper — guard against either drifting back.
    const callsites = src.match(/qualifiesForFreeShipping\(/g) || [];
    assert.ok(callsites.length >= 2,
        `expected >= 2 calls to qualifiesForFreeShipping in PDP; got ${callsites.length}`);
    assert.doesNotMatch(src, /price\s*>=\s*100/,
        'product-detail-page.js must not hardcode price >= 100 any more');
});
