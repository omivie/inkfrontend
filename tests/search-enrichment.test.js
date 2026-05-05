/**
 * Search-response enrichment contract — May 2026
 * ================================================
 *
 * Pins the storefront's adoption of the new fields on `/api/search/smart`,
 * `/api/search/by-printer`, `/api/search/by-part`. Spec:
 *   readfirst/search-enrichment-may2026.md
 *
 * The new fields:
 *   - price_includes_gst : true        (constant)
 *   - gst_amount         : number
 *   - canonical_url      : string      (absolute URL)
 *   - waitlist_available : boolean
 *   - original_price     : number      (only when discounted)
 *   - discount_amount    : number      (only when discounted)
 *   - discount_percent   : integer     (only when discounted)
 *
 * Why these tests exist:
 *   - The /by-printer + /by-part RPC path emits `product_id` instead of `id`
 *     and may omit `slug`, `canonical_url`, `original_price`, `discount_*`.
 *     The fallback path returns the full smart-search shape.
 *   - We normalize on the client (api.js → _normalizeRpcSearchResponse) so
 *     downstream renderers see one shape. If anyone reverts that or a
 *     renderer starts reading raw fields, these tests fail.
 *
 * Run: node --test tests/search-enrichment.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH      = path.join(ROOT, 'inkcartridges', 'js', 'api.js');
const PRODUCTS_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'products.js');
const SHOP_JS_PATH     = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox loader — same pattern as free-shipping-pill.test.js
// ─────────────────────────────────────────────────────────────────────────────

function loadApi() {
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
            settings: { FREE_SHIPPING_THRESHOLD: 100, GST_RATE: 0.15 },
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
    return sandbox;
}

// ─────────────────────────────────────────────────────────────────────────────
// _normalizeRpcSearchResponse — id ← product_id, optional fields untouched
// ─────────────────────────────────────────────────────────────────────────────

test('_normalizeRpcSearchResponse — maps product_id → id when id is missing', () => {
    const sb = loadApi();
    const input = {
        ok: true,
        data: {
            products: [
                { product_id: 'abc-1', sku: 'SKU-A', name: 'A' },
                { product_id: 'abc-2', sku: 'SKU-B', name: 'B' },
            ],
        },
    };
    const out = sb._normalizeRpcSearchResponse(input);
    assert.equal(out.data.products[0].id, 'abc-1');
    assert.equal(out.data.products[1].id, 'abc-2');
    // product_id preserved (caller may want it for analytics)
    assert.equal(out.data.products[0].product_id, 'abc-1');
});

test('_normalizeRpcSearchResponse — does not clobber an existing id (fallback path)', () => {
    const sb = loadApi();
    const input = {
        ok: true,
        data: {
            products: [
                { id: 'real-id', product_id: 'rpc-id', sku: 'SKU-A' },
            ],
        },
    };
    const out = sb._normalizeRpcSearchResponse(input);
    assert.equal(out.data.products[0].id, 'real-id',
        'when both id and product_id are present, id wins (fallback path supplies the full shape)');
});

test('_normalizeRpcSearchResponse — leaves optional fields untouched', () => {
    const sb = loadApi();
    const input = {
        ok: true,
        data: {
            products: [{
                product_id: 'p1',
                sku: 'X',
                retail_price: 29.99,
                gst_amount: 3.91,
                canonical_url: 'https://www.inkcartridges.co.nz/products/foo/X',
                waitlist_available: false,
                original_price: 39.99,
                discount_amount: 10.00,
                discount_percent: 25,
                price_includes_gst: true,
            }],
        },
    };
    const out = sb._normalizeRpcSearchResponse(input);
    const p = out.data.products[0];
    assert.equal(p.gst_amount, 3.91);
    assert.equal(p.canonical_url, 'https://www.inkcartridges.co.nz/products/foo/X');
    assert.equal(p.waitlist_available, false);
    assert.equal(p.original_price, 39.99);
    assert.equal(p.discount_amount, 10.00);
    assert.equal(p.discount_percent, 25);
    assert.equal(p.price_includes_gst, true);
});

test('_normalizeRpcSearchResponse — RPC-path products with omitted optional fields stay omitted', () => {
    const sb = loadApi();
    const input = {
        ok: true,
        data: {
            products: [{
                product_id: 'p1',
                sku: 'X',
                retail_price: 29.99,
                // No canonical_url, no slug, no original_price, no discount_*
            }],
        },
    };
    const out = sb._normalizeRpcSearchResponse(input);
    const p = out.data.products[0];
    assert.equal(p.id, 'p1');
    assert.equal(p.canonical_url, undefined);
    assert.equal(p.slug, undefined);
    assert.equal(p.original_price, undefined);
    assert.equal(p.discount_percent, undefined);
});

test('_normalizeRpcSearchResponse — passes through non-OK envelopes unchanged', () => {
    const sb = loadApi();
    const input = { ok: false, error: { code: 'BOOM' } };
    assert.deepEqual(sb._normalizeRpcSearchResponse(input), input);
});

test('_normalizeRpcSearchResponse — handles malformed envelopes safely', () => {
    const sb = loadApi();
    assert.deepEqual(sb._normalizeRpcSearchResponse(null), null);
    assert.deepEqual(sb._normalizeRpcSearchResponse({}), {});
    assert.deepEqual(sb._normalizeRpcSearchResponse({ ok: true }), { ok: true });
    assert.deepEqual(
        sb._normalizeRpcSearchResponse({ ok: true, data: {} }),
        { ok: true, data: {} },
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateGST — fallback when gst_amount is missing on legacy responses
// ─────────────────────────────────────────────────────────────────────────────

test('calculateGST — extracts 15% GST from a GST-inclusive amount', () => {
    const sb = loadApi();
    // 29.99 inclusive → GST = 29.99 * 0.15 / 1.15 ≈ 3.911...
    const g = sb.calculateGST(29.99);
    assert.ok(Math.abs(g - 3.911) < 0.01, `expected ~3.91, got ${g}`);
});

test('calculateGST — null/undefined/NaN inputs return 0 (no NaN leakage to UI)', () => {
    const sb = loadApi();
    assert.equal(sb.calculateGST(null), 0);
    assert.equal(sb.calculateGST(undefined), 0);
    assert.equal(sb.calculateGST(NaN), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// API.searchByPrinter / searchByPart — both endpoints exist & route correctly
// ─────────────────────────────────────────────────────────────────────────────

test('API.searchByPrinter — exists and calls /api/search/by-printer', async () => {
    const sb = loadApi();
    let called = '';
    sb.fetch = async (url) => {
        called = url;
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
                ok: true,
                data: { products: [{ product_id: 'p1', sku: 'X' }] },
            }),
        };
    };
    const res = await sb.API.searchByPrinter('brother mfc-l2750dw', { limit: 6 });
    assert.match(called, /\/api\/search\/by-printer\?/);
    assert.match(called, /q=brother\+mfc-l2750dw/);
    assert.match(called, /limit=6/);
    // Normalization happened on the way out
    assert.equal(res.data.products[0].id, 'p1');
});

test('API.searchByPart — exists and calls /api/search/by-part', async () => {
    const sb = loadApi();
    let called = '';
    sb.fetch = async (url) => {
        called = url;
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({
                ok: true,
                data: { products: [{ product_id: 'p1', sku: 'LC233' }] },
            }),
        };
    };
    const res = await sb.API.searchByPart('LC233', { limit: 12, page: 2 });
    assert.match(called, /\/api\/search\/by-part\?/);
    assert.match(called, /q=LC233/);
    assert.match(called, /limit=12/);
    assert.match(called, /page=2/);
    assert.equal(res.data.products[0].id, 'p1');
});

// ─────────────────────────────────────────────────────────────────────────────
// Static guards on render code — make sure the new fields are wired in.
// If a future refactor drops them, these guards fail loudly.
// ─────────────────────────────────────────────────────────────────────────────

test('products.js renderCard — reads original_price + discount_percent + discount_amount', () => {
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    assert.match(src, /product\.original_price/, 'must read original_price');
    assert.match(src, /product\.discount_percent/, 'must read discount_percent');
    assert.match(src, /product\.discount_amount/, 'must read discount_amount');
});

test('products.js renderCard — renders static "Incl. GST" trust label, never the dollar breakdown', () => {
    // Authoritative pin lives in tests/inc-gst-amount-removed.test.js. The
    // dollar-amount trust line was retired May 2026 in favour of the cleaner
    // "Incl. GST" label that already sits beside the PDP price.
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    assert.match(src, /Incl\. GST/, 'card must render the "Incl. GST" trust label');
    assert.doesNotMatch(src, /Inc\. GST \$/,
        'card must not render the legacy "Inc. GST $X" dollar breakdown');
    assert.doesNotMatch(src, /Inc\. GST \$\{/,
        'card must not interpolate a GST dollar amount into the trust line');
});

test('products.js renderCard — prefers canonical_url over local URL construction', () => {
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    // canonical_url branch must come before the slug/sku reconstruction branch.
    const canonIdx = src.indexOf('product.canonical_url');
    const localIdx = src.indexOf('/products/${encodeURIComponent(product.slug)');
    assert.ok(canonIdx > -1, 'must reference product.canonical_url');
    assert.ok(localIdx > -1, 'must keep slug/sku fallback for legacy responses');
    assert.ok(canonIdx < localIdx, 'canonical_url branch must precede slug/sku fallback');
});

// The May 2026 enrichment payload still ships `waitlist_available`
// (additive) but `contact-button-may2026.md` says the storefront must
// IGNORE that field. The OOS CTA collapses to a single primary
// "Contact us" link to /contact in every render path. Authoritative
// pin is in tests/contact-button-may2026.test.js.

test('products.js renderCard — OOS branch renders Contact us → /contact and ignores waitlist_available', () => {
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    assert.doesNotMatch(src, /product\.waitlist_available/,
        'products.js must not branch on waitlist_available (contact-button-may2026.md)');
    assert.doesNotMatch(src, /Notify me/,
        'products.js must not retain superseded "Notify me" copy');
    assert.match(src, /Contact us/, 'products.js must render "Contact us" CTA on OOS cards');
    assert.match(src, /data-action=["']contact["']/,
        'products.js OOS button must be marked data-action="contact"');
});

test('shop-page.js createProductCard — has same enrichment wiring (canonical_url, discount) and OOS Contact-us CTA', () => {
    const src = fs.readFileSync(SHOP_JS_PATH, 'utf8');
    assert.match(src, /product\.original_price/);
    assert.match(src, /product\.discount_percent/);
    assert.match(src, /product\.canonical_url/);
    assert.match(src, /Incl\. GST/, 'shop renderer must show the "Incl. GST" trust label');
    assert.doesNotMatch(src, /Inc\. GST \$/,
        'shop renderer must not render the legacy "Inc. GST $X" dollar breakdown');
    assert.doesNotMatch(src, /product\.waitlist_available/,
        'shop-page.js must not branch on waitlist_available (contact-button-may2026.md)');
    assert.doesNotMatch(src, /Notify me/,
        'shop-page.js must not retain superseded "Notify me" copy');
    assert.match(src, /Contact us/, 'shop renderer must show "Contact us" CTA on OOS cards');
});

test('Products.attachCardListeners + Products.bindAddToCartEvents — handle contact buttons in BOTH binders', () => {
    const src = fs.readFileSync(PRODUCTS_JS_PATH, 'utf8');
    // Both listener binders must branch on data-action="contact" and
    // navigate to /contact (the wrapping card-link <a> would otherwise
    // send the user to the PDP).
    const guards = src.match(/btn\.dataset\.action\s*===\s*['"]contact['"]/g) || [];
    assert.ok(guards.length >= 2,
        `expected attachCardListeners + bindAddToCartEvents to handle "contact"; found ${guards.length}`);
    assert.match(src, /window\.location\.href\s*=\s*['"]\/contact['"]/,
        'contact handler must navigate to /contact');
});

test('api.js — exposes _normalizeRpcSearchResponse as a test hook', () => {
    const src = fs.readFileSync(API_JS_PATH, 'utf8');
    assert.match(src, /window\._normalizeRpcSearchResponse\s*=\s*_normalizeRpcSearchResponse/);
});

test('api.js — searchByPrinter and searchByPart both run through _normalizeRpcSearchResponse', () => {
    const src = fs.readFileSync(API_JS_PATH, 'utf8');
    // Match the normalized return on each call site.
    const sbpMatch = src.match(/async\s+searchByPrinter[\s\S]*?_normalizeRpcSearchResponse\(res\)/);
    const sbptMatch = src.match(/async\s+searchByPart[\s\S]*?_normalizeRpcSearchResponse\(res\)/);
    assert.ok(sbpMatch, 'searchByPrinter must normalize the RPC response');
    assert.ok(sbptMatch, 'searchByPart must normalize the RPC response');
});
