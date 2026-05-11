/**
 * Product 404 — never paint `[object Object]`
 * =============================================
 *
 * Backend dev reported (May 2026): /api/products/<sku> returns
 *   { ok: false, error: { code: 'not_found', message: 'Product not found' } }
 * for deactivated SKUs and stale Google links. The frontend was passing
 * `response.error` (the OBJECT) straight into `showError(message)`, which
 * did `textContent = message`. JS coerced the object via .toString() and
 * the customer saw "[object Object]" in both the page title and the
 * inline error pane.
 *
 * Customer impact: trust drop, bounce rate spike, Google quality signals
 * pick up the "broken page" pattern. The bug is hit by every truly-404
 * SKU (typos, deactivations, expired links) — frequent and silent.
 *
 * This file pins the fix across three layers:
 *
 *   1. API.extractErrorMessage — the central string-coercion helper.
 *      Covers all six error envelope shapes the codebase encounters.
 *   2. API.getProduct — 404 envelope handling: lowercase `not_found` matches,
 *      response shape preserved so the page can extract `.error.message`.
 *   3. ProductPage.showError — defense-in-depth: even a caller who forgets
 *      to unwrap the envelope cannot paint "[object Object]".
 *
 * Run: node --test tests/product-404-error-render.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');
const PDP_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function loadApi({ fetchImpl } = {}) {
    const calls = [];
    const fetchSpy = async (url, opts) => {
        calls.push({ url, opts });
        return fetchImpl ? fetchImpl(url, opts, calls) : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
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
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
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
    return { API: sandbox.API, calls };
}

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
// Layer 1: API.extractErrorMessage handles every envelope shape
// ─────────────────────────────────────────────────────────────────────────────

test('extractErrorMessage — null/undefined/empty → fallback', () => {
    const { API } = loadApi();
    assert.equal(API.extractErrorMessage(null, 'fb'), 'fb');
    assert.equal(API.extractErrorMessage(undefined, 'fb'), 'fb');
    assert.equal(API.extractErrorMessage('', 'fb'), 'fb');
});

test('extractErrorMessage — plain string passes through', () => {
    const { API } = loadApi();
    assert.equal(API.extractErrorMessage('Coupon expired', 'fb'), 'Coupon expired');
});

test('extractErrorMessage — Error instance returns its message', () => {
    const { API } = loadApi();
    const err = new Error('Network down');
    assert.equal(API.extractErrorMessage(err, 'fb'), 'Network down');
});

test('extractErrorMessage — Error with no message → fallback', () => {
    const { API } = loadApi();
    const err = new Error('');
    assert.equal(API.extractErrorMessage(err, 'fb'), 'fb');
});

test('extractErrorMessage — { message } envelope', () => {
    const { API } = loadApi();
    assert.equal(
        API.extractErrorMessage({ message: 'You are not signed in' }, 'fb'),
        'You are not signed in',
    );
});

test('extractErrorMessage — { error: "<string>" } (legacy envelope)', () => {
    const { API } = loadApi();
    assert.equal(
        API.extractErrorMessage({ ok: false, error: 'Failed to subscribe' }, 'fb'),
        'Failed to subscribe',
    );
});

test('extractErrorMessage — { error: { message } } (May 2026 typed envelope)', () => {
    // THE REGRESSION: this exact shape is what the product 404 returned.
    // Without the helper, .toString() coerced the inner object to "[object Object]".
    const { API } = loadApi();
    const envelope = { ok: false, error: { code: 'not_found', message: 'Product not found' } };
    const out = API.extractErrorMessage(envelope, 'fb');
    assert.equal(out, 'Product not found');
    assert.ok(!/\[object Object\]/.test(out), 'must never coerce to "[object Object]"');
});

test('extractErrorMessage — { error: { code } } with no message → returns code, never object', () => {
    const { API } = loadApi();
    const out = API.extractErrorMessage({ error: { code: 'RATE_LIMITED' } }, 'fb');
    assert.equal(out, 'RATE_LIMITED');
    assert.ok(!/\[object Object\]/.test(out), 'must never coerce to "[object Object]"');
});

test('extractErrorMessage — opaque object → fallback (never object→string coerce)', () => {
    const { API } = loadApi();
    const opaque = { weird: { nested: 'thing' } };
    const out = API.extractErrorMessage(opaque, 'fb');
    assert.equal(out, 'fb');
    assert.ok(!/\[object Object\]/.test(out), 'must never coerce to "[object Object]"');
});

test('extractErrorMessage — defaults to a sensible fallback when no fallback passed', () => {
    const { API } = loadApi();
    const out = API.extractErrorMessage(null);
    assert.ok(typeof out === 'string' && out.length > 0);
    assert.ok(!/\[object Object\]/.test(out), 'must never coerce to "[object Object]"');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: API.getProduct 404 envelope shape + case-insensitive code match
// ─────────────────────────────────────────────────────────────────────────────

test('getProduct — 404 with lowercase `not_found` code does NOT trigger smart-fallback', async () => {
    // The backend's reported shape uses lowercase. The historical contract
    // also accepted uppercase 'NOT_FOUND'. Both must short-circuit so the
    // user does NOT get fuzzy-matched into a near-neighbor product page.
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/DEACTIVATED-SKU')) {
                return mockResponse({
                    status: 404,
                    body: { ok: false, error: { code: 'not_found', message: 'Product not found' } },
                });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    });
    const resp = await API.getProduct('DEACTIVATED-SKU');
    assert.equal(resp.ok, false);
    assert.equal(calls.length, 1, 'must NOT fall through to /api/search/smart on a real 404');
    // Envelope passed through so the page can read error.message:
    assert.equal(resp.error.code, 'not_found');
    assert.equal(resp.error.message, 'Product not found');
});

test('getProduct — uppercase NOT_FOUND code also short-circuits (legacy contract)', async () => {
    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.endsWith('/api/products/LEGACY-NF')) {
                return mockResponse({
                    status: 404,
                    body: { ok: false, error: { code: 'NOT_FOUND', message: 'Product not found' } },
                });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
    });
    const resp = await API.getProduct('LEGACY-NF');
    assert.equal(resp.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(resp.error.code, 'NOT_FOUND');
});

test('getProduct 404 → extractErrorMessage on the response yields "Product not found"', async () => {
    // End-to-end on the producer side: api.js returns the envelope, the
    // helper extracts the string. Together they replace the old
    // `response.error || fallback` anti-pattern.
    const { API } = loadApi({
        fetchImpl: () => mockResponse({
            status: 404,
            body: { ok: false, error: { code: 'not_found', message: 'Product not found' } },
        }),
    });
    const resp = await API.getProduct('GONE-SKU');
    const display = API.extractErrorMessage(resp, 'fallback');
    assert.equal(display, 'Product not found');
    assert.ok(!/\[object Object\]/.test(display), 'must never paint "[object Object]"');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: source-level invariants on product-detail-page.js
// ─────────────────────────────────────────────────────────────────────────────

test('product-detail-page.js — no raw `response.error || fallback` into showError', () => {
    // Pin the fix in source. If anyone reintroduces the bug — passing
    // `response.error` directly to a string sink — this test fails.
    const src = fs.readFileSync(PDP_JS_PATH, 'utf8');
    assert.doesNotMatch(
        src,
        /showError\s*\(\s*response\.error\s*\|\|/,
        'showError must funnel through API.extractErrorMessage; passing response.error directly recreates the [object Object] bug.',
    );
});

test('product-detail-page.js — 404 call site uses API.extractErrorMessage', () => {
    const src = fs.readFileSync(PDP_JS_PATH, 'utf8');
    assert.match(
        src,
        /showError\s*\(\s*API\.extractErrorMessage\s*\(\s*response/,
        'the 404 branch must wrap the response in API.extractErrorMessage so the renderer always receives a string',
    );
});

test('product-detail-page.js — showError() defensively re-coerces non-string input', () => {
    const src = fs.readFileSync(PDP_JS_PATH, 'utf8');
    // The hardened showError introduces a `safeMessage` local and uses it
    // for both the title and the body. If either is removed, [object Object]
    // can sneak back in.
    assert.match(src, /const\s+safeMessage\s*=/);
    assert.match(src, /product-title.+textContent\s*=\s*safeMessage/s);
    assert.match(src, /Security\.escapeHtml\(safeMessage\)/);
});

test('product-detail-page.js — showError no longer string-assigns the raw `message` to product-title', () => {
    const src = fs.readFileSync(PDP_JS_PATH, 'utf8');
    assert.doesNotMatch(
        src,
        /getElementById\(['"]product-title['"]\)\.textContent\s*=\s*message\s*;/,
        'must assign safeMessage (post-coercion), not the raw input',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4: belt-and-braces — the audit sites no longer pass raw response.error
// ─────────────────────────────────────────────────────────────────────────────

test('audit — no remaining `response.error || ` or `res.error || ` in customer-facing controllers', () => {
    // The May 2026 typed-error envelope means any `response.error || fallback`
    // can render [object Object] if the response is a 4xx/5xx with a typed
    // body. The fix is to funnel through API.extractErrorMessage at every
    // string-rendering boundary. This test pins the audit so the regression
    // cannot creep back in via a new endpoint.
    const guardedFiles = [
        'product-detail-page.js',
        'cart.js',
        'checkout-page.js',
        'payment-page.js',
        'verify-email-page.js',
        'landing.js',
    ];
    const offenders = [];
    for (const rel of guardedFiles) {
        const p = path.join(ROOT, 'inkcartridges', 'js', rel);
        const src = fs.readFileSync(p, 'utf8');
        // Match `response.error ||`, `res.error ||`, `resp.error ||` only in
        // contexts that aren't already qualified (e.g. `?.message` is fine).
        const re = /\b(response|res|resp)\.error\s*\|\|\s*['"]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            // Line lookup for a useful error message
            const before = src.slice(0, m.index);
            const line = before.split('\n').length;
            offenders.push(`${rel}:${line}  ${m[0]}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'Remaining `<resp>.error || "string"` sites — funnel them through API.extractErrorMessage so a typed { code, message } error never coerces to [object Object]:\n  ' + offenders.join('\n  '),
    );
});
