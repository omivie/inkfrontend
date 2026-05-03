/**
 * API.getProduct fallback contract
 * =================================
 *
 * The backend's singular product endpoint (GET /api/products/<sku>) has been
 * observed to return 500 INTERNAL_ERROR for specific product families (the
 * Epson Genuine 200 ink series, see errors.md). When that happens, the user
 * lands on a "Failed to load product" page even though the product clearly
 * exists (the search dropdown surfaces it; the same SKU's /related endpoint
 * works; /api/search/smart returns a complete payload).
 *
 * api.js's getProduct wraps the singular endpoint with a fallback that hits
 * /api/search/smart?q=<sku> and picks the matching suggestion. This test
 * pins five contract invariants:
 *
 *   1. Happy path: primary endpoint returns 200 → fallback never fires.
 *   2. Primary throws (5xx/network) → fallback fires AND succeeds when
 *      smart returns a matching SKU.
 *   3. Primary returns ok:false NOT_FOUND envelope → fallback does NOT fire
 *      (genuine "this SKU doesn't exist" must not be shadowed).
 *   4. Primary throws + smart has no matching SKU → return ok:false with the
 *      "temporarily unavailable" error message (NOT "not found", which would
 *      mislead).
 *   5. Empty SKU input → ok:false without any network calls.
 *
 * Plus a few sanity checks on payload mapping (smart's `description` field
 * is mapped onto `description_html` so the existing renderer can use it).
 *
 * Run with: node --test tests/api-getproduct-fallback.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');

/**
 * Load api.js into an isolated `vm` context with a fakeable `fetch` and the
 * minimum of globals it needs to evaluate its IIFE module.
 *
 * Returns the constructed `API` global plus a recorder that captures every
 * URL the code under test fetches.
 */
function loadApi({ fetchImpl } = {}) {
    const calls = [];
    const fetchSpy = async (url, opts) => {
        calls.push({ url, opts });
        return fetchImpl(url, opts, calls);
    };
    const sandbox = {
        console,
        fetch: fetchSpy,
        setTimeout,
        clearTimeout,
        AbortController,
        Headers: globalThis.Headers,
        URL,
        URLSearchParams,
        encodeURIComponent,
        Map,
        Promise,
        Date,
        JSON,
        Error,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Symbol,
        // Minimum module-level deps api.js reaches for at definition time:
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        // Auth left undefined (NOT null) — `typeof Auth !== 'undefined'` is the
        // guard in api.js. Setting it to null here would make typeof === 'object'
        // and trigger Auth.session reads on null.
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

    return { API: sandbox.API, calls };
}

/**
 * Helper: build a minimal Response-shaped object for the fake fetch.
 */
function mockResponse({ status = 200, body = {}, ok }) {
    return {
        ok: ok != null ? ok : (status >= 200 && status < 300),
        status,
        headers: { get: () => null },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract tests
// ─────────────────────────────────────────────────────────────────────────────

test('getProduct — happy path: primary returns 200, fallback never fires', async () => {
    const product = {
        id: 'uuid-1',
        sku: '314LOT',
        slug: 'olivetti-314lot',
        name: '314LOT Olivetti Compatible Correction Ribbon Tape',
        retail_price: 8.96,
    };
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/314LOT')) {
                return mockResponse({ status: 200, body: { ok: true, data: product } });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    });
    const resp = await API.getProduct('314LOT');
    assert.equal(resp.ok, true);
    assert.equal(resp.data.sku, '314LOT');
    assert.equal(resp.source, undefined,
        'happy path must NOT tag the result with source:search-smart-fallback');
    assert.equal(calls.length, 1, 'expected exactly one network call (the primary)');
    assert.match(calls[0].url, /\/api\/products\/314LOT$/);
});

test('getProduct — primary 500 + smart has matching SKU → fallback succeeds', async () => {
    const smartProduct = {
        id: '02730a2b-ef39-4df1-a9b5-3f147556458e',
        sku: 'G-EPS-200-INK-YL',
        slug: 'epson-genuine-200-ink-cartridge-yellow-165-pages',
        name: 'Epson Genuine 200 Ink Cartridge Yellow (165 Pages)',
        retail_price: 23.99,
        color: 'Yellow',
        image_url: 'https://example/epson200yl.png',
        in_stock: true,
        stock_quantity: 5,
        source: 'genuine',
        pack_type: 'single',
        brand: { name: 'Epson', slug: 'epson' },
        category: { name: 'Ink', slug: 'ink' },
        description: '<p>Yellow ink for Epson printers.</p>',
    };
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('/api/products/G-EPS-200-INK-YL') && !url.includes('/related')) {
                // Reproduce the live backend regression: 500 + INTERNAL_ERROR
                return mockResponse({
                    status: 500,
                    body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
                });
            }
            if (url.includes('/api/search/smart')) {
                return mockResponse({ status: 200, body: { ok: true, data: { products: [smartProduct] } } });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    });
    const resp = await API.getProduct('G-EPS-200-INK-YL');
    assert.equal(resp.ok, true, 'fallback must recover the product');
    assert.equal(resp.data.sku, 'G-EPS-200-INK-YL');
    assert.equal(resp.source, 'search-smart-fallback',
        'fallback recoveries must be tagged so callers/telemetry can spot the regression');
    assert.equal(calls.length, 2, 'expected two calls: primary then fallback');
    assert.match(calls[1].url, /\/api\/search\/smart\?q=G-EPS-200-INK-YL/);
});

test('getProduct — fallback maps smart `description` onto description_html', async () => {
    // The product page renderer reads description_html. The smart endpoint
    // returns the same content under `description`. The mapping must happen
    // so the page doesn't render a blank description on the fallback path.
    const smartProduct = {
        sku: 'G-EPS-200-INK-MG',
        name: 'Epson Genuine 200 Ink Cartridge Magenta',
        retail_price: 23.99,
        description: '<p>Magenta ink.</p>',
    };
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/G-EPS-200-INK-MG')) throw new Error('boom');
            if (url.includes('/api/search/smart')) {
                return mockResponse({ status: 200, body: { ok: true, data: { products: [smartProduct] } } });
            }
            return mockResponse({ status: 404, body: { ok: false } });
        },
    });
    const resp = await API.getProduct('G-EPS-200-INK-MG');
    assert.equal(resp.ok, true);
    assert.equal(resp.data.description_html, '<p>Magenta ink.</p>',
        'fallback must mirror description → description_html for the renderer');
    // Original `description` should still be present (don't destroy data).
    assert.equal(resp.data.description, '<p>Magenta ink.</p>');
});

test('getProduct — fallback does NOT clobber description_html when already present', async () => {
    const smartProduct = {
        sku: 'X',
        description: '<p>from description</p>',
        description_html: '<p>from description_html</p>',
    };
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/X')) throw new Error('boom');
            return mockResponse({ status: 200, body: { ok: true, data: { products: [smartProduct] } } });
        },
    });
    const resp = await API.getProduct('X');
    assert.equal(resp.data.description_html, '<p>from description_html</p>',
        'pre-existing description_html wins over derived mapping');
});

test('getProduct — primary returns ok:false NOT_FOUND → fallback does NOT fire', async () => {
    // Critical contract: a genuine 404 must not trigger the fallback,
    // because the fallback could surface a fuzzy near-match suggestion and
    // mislead the user into thinking they reached a real product page.
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/DOES-NOT-EXIST')) {
                // request() in api.js converts non-ok HTTP+envelope to a thrown
                // Error in most cases — but for soft-fail returns it can pass
                // through ok:false. Test BOTH: here we simulate a 404 with an
                // envelope that has no special-case code so request() throws.
                return mockResponse({
                    status: 404,
                    body: { ok: false, error: { code: 'NOT_FOUND', message: 'Product not found' } },
                });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    });
    const resp = await API.getProduct('DOES-NOT-EXIST');
    // Either the throw path returns the unavailable message (since primary
    // threw), OR the soft-fail path returns the envelope verbatim. Both are
    // acceptable contracts; what's NOT acceptable is the fallback firing and
    // returning a fuzzy-matched neighbor product.
    if (resp.source === 'search-smart-fallback') {
        assert.fail('fallback fired for a genuine 404 — must not shadow real "not found" results');
    }
    assert.equal(resp.ok, false);
    // Single network call: the primary. Fallback never attempted.
    assert.equal(calls.length, 1, 'fallback must not fire on 404 — got extra calls: ' + JSON.stringify(calls.map(c => c.url)));
});

test('getProduct — primary throws + smart has no matching SKU → temporarily-unavailable error', async () => {
    // Both endpoints failing must produce a clear "temporarily unavailable"
    // signal so the UI can render the right copy + Try Again button rather
    // than the misleading "Product not found".
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('/api/products/G-EPS-200-INK-BK')) {
                return mockResponse({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
            }
            if (url.includes('/api/search/smart')) {
                // Smart returns no match for this SKU.
                return mockResponse({ status: 200, body: { ok: true, data: { products: [] } } });
            }
            throw new Error(`unexpected: ${url}`);
        },
    });
    const resp = await API.getProduct('G-EPS-200-INK-BK');
    assert.equal(resp.ok, false);
    assert.match(resp.error, /temporarily unavailable/i,
        'spec: must distinguish backend hiccup from genuine missing SKU');
});

test('getProduct — primary throws + smart returns wrong SKU → does NOT fuzzy-match', async () => {
    // The smart endpoint may return suggestions that share a prefix with the
    // requested SKU but aren't the exact match. The fallback must require an
    // exact SKU match — never accept a near-neighbor as a stand-in.
    const wrongProduct = { sku: 'G-EPS-200-INK-CY', name: 'Cyan' };
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('/api/products/G-EPS-200-INK-BK')) {
                return mockResponse({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR' } } });
            }
            if (url.includes('/api/search/smart')) {
                return mockResponse({ status: 200, body: { ok: true, data: { products: [wrongProduct] } } });
            }
            throw new Error('unexpected');
        },
    });
    const resp = await API.getProduct('G-EPS-200-INK-BK');
    assert.equal(resp.ok, false,
        'fallback must require exact SKU match — got a fuzzy near-neighbor instead');
    assert.match(resp.error, /temporarily unavailable/i);
});

test('getProduct — empty SKU returns ok:false without any network call', async () => {
    const { API, calls } = loadApi({
        fetchImpl: () => { throw new Error('should not be called'); },
    });
    const r1 = await API.getProduct('');
    const r2 = await API.getProduct(null);
    const r3 = await API.getProduct(undefined);
    for (const r of [r1, r2, r3]) {
        assert.equal(r.ok, false);
        assert.match(r.error, /No SKU provided/i);
    }
    assert.equal(calls.length, 0, 'empty input must short-circuit before any fetch');
});

test('getProduct — SKU is URL-encoded in both primary and fallback paths', async () => {
    // Defensive: although our SKUs are alphanumeric+hyphen today, encode them
    // anyway so a future SKU containing &, %, or # can't break the URL.
    const weirdSku = 'A&B/C 123';
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('/api/products/')) throw new Error('boom');
            if (url.includes('/api/search/smart')) {
                return mockResponse({ status: 200, body: { ok: true, data: { products: [] } } });
            }
            return mockResponse({ status: 404, body: { ok: false } });
        },
    });
    await API.getProduct(weirdSku);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/products\/A%26B%2FC%20123$/,
        'primary must encode special chars: &, /, space');
    assert.match(calls[1].url, /\/api\/search\/smart\?q=A%26B%2FC%20123/,
        'fallback must encode the same way');
});

test('getProduct — fallback only fetches /api/search/smart, never anything else', async () => {
    // Regression guard: a tempting "improvement" is to chain the fallback to
    // also try /api/products?sku=... or /api/products/by-slug/... — but those
    // either ignore the filter or 302 back to the broken singular endpoint.
    // Pin the chosen fallback shape so it can't drift.
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/G-EPS-200-INK-YL')) throw new Error('boom');
            if (url.includes('/api/search/smart')) {
                return mockResponse({ status: 200, body: { ok: true, data: { products: [{ sku: 'G-EPS-200-INK-YL', name: 'X' }] } } });
            }
            throw new Error(`fallback hit unexpected url: ${url}`);
        },
    });
    const resp = await API.getProduct('G-EPS-200-INK-YL');
    assert.equal(resp.ok, true);
    const fallbackUrls = calls.slice(1).map(c => c.url);
    for (const u of fallbackUrls) {
        assert.match(u, /\/api\/search\/smart/,
            `fallback only allowed to call /api/search/smart, got: ${u}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-grep guards
// ─────────────────────────────────────────────────────────────────────────────

const API_SRC = fs.readFileSync(API_JS_PATH, 'utf8');

test('api.js — getProduct URL-encodes the SKU on the primary path', () => {
    // Pin against future drift: someone "simplifying" back to `/api/products/${sku}`
    // (no encode) would silently break SKUs with reserved URL characters.
    const m = API_SRC.match(/async getProduct\(sku\)[\s\S]+?\n {4}\}/);
    assert.ok(m, 'expected getProduct definition in api.js');
    assert.match(m[0], /encodeURIComponent\(sku\)/,
        'getProduct must encodeURIComponent the SKU before substituting into the URL');
});

test('api.js — getProduct fallback hits /api/search/smart, not any other endpoint', () => {
    const m = API_SRC.match(/async getProduct\(sku\)[\s\S]+?\n {4}\}/);
    assert.match(m[0], /\/api\/search\/smart\?q=/,
        'fallback is documented to use /api/search/smart — pin against drift');
    assert.doesNotMatch(m[0], /\/api\/products\/by-slug/,
        'by-slug 302s back to the broken singular endpoint — not a viable fallback');
    assert.doesNotMatch(m[0], /\/api\/products\?sku=/,
        '/api/products?sku= ignores the filter (returns first product alphabetically) — not a viable fallback');
});

test('api.js — getProduct fallback requires exact SKU match (no fuzzy)', () => {
    const m = API_SRC.match(/async getProduct\(sku\)[\s\S]+?\n {4}\}/);
    assert.match(m[0], /products\.find\(p => p && p\.sku === sku\)/,
        'fallback must use === for SKU match — fuzzy/startsWith/etc would surface neighbor products');
});

test('product-detail-page.js — surfaces API.getProduct error message (not always "Product not found")', () => {
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8');
    // The "if (!response.ok || !response.data)" block must read response.error
    // so the temporarily-unavailable copy reaches the user.
    const block = src.match(/if \(!response\.ok \|\| !response\.data\)[\s\S]+?return;\s*\}/);
    assert.ok(block, 'expected the response-check block in product-detail-page.js init()');
    assert.match(block[0], /response\.error/,
        'must surface response.error so "temporarily unavailable" reaches the UI when both endpoints fail');
});

test('product-detail-page.js — normalizeCategory accepts non-string inputs', () => {
    // The smart endpoint returns category as { name, slug } (object), but the
    // canonical detail endpoint returns it as a string code. The renderer
    // must handle both shapes — otherwise a fallback-recovered product crashes
    // with "raw.toLowerCase is not a function" before rendering.
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8');
    const m = src.match(/normalizeCategory\(raw\)[\s\S]+?return null;\s*\}/);
    assert.ok(m, 'expected normalizeCategory definition');
    assert.match(m[0], /typeof raw === 'string'/,
        'normalizeCategory must coerce non-string inputs (regression guard for fallback payload)');
});

test('product-detail-page.js — resolveSkuFromSlug has search-smart fallback for broken by-slug', () => {
    // The /api/products/by-slug/<slug> endpoint 302s into /api/products/<sku>.
    // When the canonical endpoint is broken (e.g. Epson 200 family), the
    // chain produces 500 and the by-slug call returns res.ok=false. Without a
    // fallback, /product/<slug> URLs for those products redirect to /shop?q=
    // instead of rendering the product page. The fallback uses /api/search/smart
    // with the slug-as-query and exact-slug match.
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8');
    const m = src.match(/async resolveSkuFromSlug\(slug\)[\s\S]+?return null;\s*\}/);
    assert.ok(m, 'expected resolveSkuFromSlug definition');
    assert.match(m[0], /\/api\/search\/smart/,
        'resolveSkuFromSlug must include the search-smart fallback for when by-slug 302-chains into a 500');
    assert.match(m[0], /p\.slug === slug/,
        'fallback must use exact slug match — fuzzy/startsWith would surface the wrong product');
});

test('serve.json — /p/** rewrite is present (local dev parity with vercel.json /p/:sku)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'serve.json'), 'utf8'));
    const rule = (cfg.rewrites || []).find(r => r.source === 'p/**');
    assert.ok(rule, 'expected p/** rewrite for the /p/<sku> short-link path — vercel.json has it, serve.json must mirror');
    assert.match(rule.destination, /product/,
        'p/** must rewrite to the product page so product-detail-page.js can pick up the SKU from the URL');
});
