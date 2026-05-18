/**
 * Shop transient-failure recovery — May 2026
 * ===========================================
 *
 * Pins the contract documented in
 *   readfirst/shop-transient-failure-recovery-may2026.md
 *
 * Why this exists: a customer opens /shop?brand=canon&category=ink on a cold
 * Render dyno. /api/shop returns 502 or the request times out. Before this
 * fix, loadProductCodes's outer catch painted "No products found / Failed to
 * load products. Please try again." into the codes drilldown and the user
 * either reloaded (and saw it work — confusing) or bounced.
 *
 * Two-layer contract:
 *
 *   1. api.js `_fetchWithAuth` AUTO-RETRIES idempotent GETs for transient
 *      failures (5xx, network errors, request timeout). Backoff is 300ms ×
 *      3ⁿ for up to MAX_TRANSIENT_RETRIES = 2 retries (3 attempts total).
 *      POST/PUT/DELETE never retry (could double-mutate). 401 still triggers
 *      the auth-refresh branch; 429 still triggers the rate-limit branch.
 *
 *   2. shop-page.js exposes a `showError(message, onRetry)` distinct from
 *      `showEmpty(message)`. The five "Failed to load…" loader-catch sites
 *      (loadProductCodes, loadProducts, loadPrinterProducts,
 *      loadPrinterModelProducts, loadSearchResults) call showError instead
 *      of showEmpty so the user sees a recoverable error pane with a Retry
 *      button, not a permanent-looking empty state.
 *
 *   3. The Retry button bumps `navigationVersion`, re-runs the loader, and
 *      keeps the skeleton visible during the retry. The bfcache `pageshow`
 *      handler also clears the error pane (defends against snapshot stickiness
 *      identical to the bfcache-restore-may2026.md problem).
 *
 *   4. The HTML/CSS exists: `#drilldown-error` pane, `#drilldown-retry-btn`
 *      button, `.drilldown-error` + `.drilldown-error__btn` styling.
 *
 * Run with: node --test tests/shop-transient-failure-recovery-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const API_SRC       = READ('inkcartridges/js/api.js');
const SHOP_PAGE_SRC = READ('inkcartridges/js/shop-page.js');
const SHOP_HTML_SRC = READ('inkcartridges/html/shop.html');
const PAGES_CSS_SRC = READ('inkcartridges/css/pages.css');

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox loader for api.js — mirrors compatible-products-recovery.test.js
// ─────────────────────────────────────────────────────────────────────────────

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
        Map, Set, Promise, Date, JSON, Error, Object, Array,
        String, Number, Boolean, Symbol, RegExp, TypeError,
        structuredClone: globalThis.structuredClone,
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
    vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
    return { API: sandbox.API, calls };
}

function mockResponse({ status = 200, body = {}, ok } = {}) {
    return {
        ok: ok != null ? ok : (status >= 200 && status < 300),
        status,
        headers: { get: () => null },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — api.js source contract
// ─────────────────────────────────────────────────────────────────────────────

test('api.js declares MAX_TRANSIENT_RETRIES and TRANSIENT_RETRY_BASE_MS constants', () => {
    assert.match(API_SRC, /MAX_TRANSIENT_RETRIES:\s*2\b/,
        'MAX_TRANSIENT_RETRIES must be 2 (3 total attempts) — drops the cold-start failure rate to near zero without blocking the page for more than ~1.2s when the backend is truly down');
    assert.match(API_SRC, /TRANSIENT_RETRY_BASE_MS:\s*300\b/,
        'Backoff base must be 300ms — first retry fires fast enough that a healthy Render warm-up is invisible to the user');
});

test('api.js _fetchWithAuth threads transientRetry through opts', () => {
    assert.match(API_SRC, /transientRetry\s*=\s*opts\.transientRetry\s*\|\|\s*0/,
        '_fetchWithAuth must read opts.transientRetry to track attempt count across recursive calls');
    assert.match(API_SRC, /transientRetry:\s*transientRetry\s*\+\s*1/,
        'recursive retry call must bump transientRetry');
});

test('api.js _fetchWithAuth retries idempotent 5xx', () => {
    // The 5xx retry branch must gate on isIdempotent && 5xx && transientRetry < MAX
    assert.match(API_SRC,
        /isIdempotent[\s\S]{0,200}response\.status\s*>=\s*500[\s\S]{0,200}transientRetry\s*<\s*this\.MAX_TRANSIENT_RETRIES/,
        '5xx retry branch must require isIdempotent so POST/PUT/DELETE never replay');
});

test('api.js _fetchWithAuth retries idempotent network + timeout errors', () => {
    // The catch block must classify TypeError (network) and AbortError (timeout)
    // as transient, and only for idempotent methods.
    assert.match(API_SRC, /isAbort\s*=\s*error\s*&&\s*error\.name\s*===\s*['"]AbortError['"]/,
        'catch block must detect AbortError as a transient timeout candidate');
    assert.match(API_SRC, /isNetwork\s*=\s*error\s*&&\s*error\.name\s*===\s*['"]TypeError['"]/,
        'catch block must detect TypeError as a transient network-error candidate');
    assert.match(API_SRC,
        /isIdempotent[\s\S]{0,200}\(isAbort\s*\|\|\s*isNetwork\)[\s\S]{0,200}transientRetry\s*<\s*this\.MAX_TRANSIENT_RETRIES/,
        'network/timeout retry must gate on isIdempotent so mutations never replay');
});

test('api.js _fetchWithAuth blocks non-idempotent transient retry', () => {
    // isIdempotent is derived from method; POST/PUT/DELETE produce false.
    assert.match(API_SRC,
        /isIdempotent\s*=\s*method\s*===\s*['"]GET['"]\s*\|\|\s*method\s*===\s*['"]HEAD['"]/,
        'isIdempotent must be exactly GET || HEAD — anything else (POST, PUT, PATCH, DELETE) is a mutation');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Behavioural: fetch mocks prove _fetchWithAuth actually retries
// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/products retries on transient 503 then succeeds', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            if (attempt === 1) return mockResponse({ status: 503, body: { ok: false, error: 'cold start' } });
            return mockResponse({ status: 200, body: { ok: true, data: { products: [{ id: 'p1' }] } } });
        },
    });
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, true, 'second attempt must succeed and return ok: true');
    assert.equal(resp.data.products[0].id, 'p1');
    assert.equal(calls.length, 2, 'fetch should be called exactly twice (1 503 + 1 success)');
});

test('GET /api/shop retries on transient 502 twice then succeeds', async () => {
    // Use source=genuine to skip the compat-recovery sidecar — otherwise
    // getShopData fires primary + sidecar in parallel and the test would
    // have to count both retry chains. Sidecar behaviour is covered by
    // tests/compatible-products-recovery.test.js.
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            if (attempt <= 2) return mockResponse({ status: 502, body: { ok: false, error: 'bad gateway' } });
            return mockResponse({ status: 200, body: { ok: true, data: { series: [{ code: 'PG40', count: 5 }] } } });
        },
    });
    // The manual product-codes layer (May 2026) adds its own Supabase lookup —
    // stub it inert so `calls` counts only the backend /api/shop retry chain.
    API._supabaseSelect = async () => null;
    const resp = await API.getShopData({ brand: 'canon', category: 'ink', source: 'genuine' });
    assert.equal(resp.ok, true);
    assert.deepEqual(resp.data.series, [{ code: 'PG40', count: 5 }]);
    assert.equal(calls.length, 3, 'two 502s + one success = 3 fetch calls');
});

test('GET gives up after MAX_TRANSIENT_RETRIES + 1 attempts on persistent 503', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            return mockResponse({ status: 503, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'still down' } } });
        },
    });
    // request() returns a structured envelope on 5xx (does not throw)
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, false, 'after exhausting retries the structured 5xx envelope reaches the caller');
    assert.equal(resp.code, 'INTERNAL_ERROR');
    assert.equal(calls.length, 3, 'max retries exhausted: 1 original + 2 retries = 3 attempts');
});

test('GET retries on TypeError (network error)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            if (attempt === 1) throw new TypeError('Failed to fetch');
            return mockResponse({ status: 200, body: { ok: true, data: { products: [] } } });
        },
    });
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, true);
    assert.equal(calls.length, 2);
});

test('POST is NEVER retried on 5xx (mutation safety)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            return mockResponse({ status: 503, body: { ok: false, error: 'down' } });
        },
    });
    // Use a known POST surface — newsletter subscribe wraps API.post directly.
    const resp = await API.post('/api/newsletter/subscribe', { email: 'a@b.com' });
    assert.equal(resp.ok, false, 'request() returns the 5xx envelope unchanged');
    assert.equal(calls.length, 1, 'POST must fire EXACTLY ONCE — replaying could double-charge or send duplicate emails');
});

test('POST is NEVER retried on TypeError (mutation safety)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            throw new TypeError('Failed to fetch');
        },
    });
    await assert.rejects(
        () => API.post('/api/newsletter/subscribe', { email: 'a@b.com' }),
        /Failed to fetch/,
        'network error on a POST must propagate to the caller without replay'
    );
    assert.equal(calls.length, 1, 'POST must fire EXACTLY ONCE');
});

test('GET retries on AbortError (timeout)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            if (attempt === 1) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            }
            return mockResponse({ status: 200, body: { ok: true, data: { products: [] } } });
        },
    });
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, true);
    assert.equal(calls.length, 2);
});

test('4xx is NOT retried (only 5xx / network / timeout are)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            return mockResponse({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: 'no' } } });
        },
    });
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, false);
    assert.equal(resp.code, 'NOT_FOUND');
    assert.equal(calls.length, 1, '404 is a definite answer — replaying it just wastes a round trip');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — shop-page.js source contract: showError + retry wiring
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js binds the new error pane elements', () => {
    assert.match(SHOP_PAGE_SRC, /error:\s*document\.getElementById\(['"]drilldown-error['"]\)/,
        'controller must read #drilldown-error');
    assert.match(SHOP_PAGE_SRC, /errorMessage:\s*document\.getElementById\(['"]error-message['"]\)/,
        'controller must read #error-message');
    assert.match(SHOP_PAGE_SRC, /errorRetryBtn:\s*document\.getElementById\(['"]drilldown-retry-btn['"]\)/,
        'controller must read #drilldown-retry-btn');
});

test('shop-page.js defines showError(message, onRetry)', () => {
    assert.match(SHOP_PAGE_SRC, /showError\s*\(\s*message\s*,\s*onRetry\s*\)\s*\{/,
        'showError must accept (message, onRetry) — message for the user, onRetry for the button click');
});

test('shop-page.js showError honours the bfcache _unloading guard', () => {
    // showError must check _unloading exactly the way showEmpty does, otherwise
    // a navigation-away reject could paint the error pane and bfcache would
    // snapshot it (bfcache-restore-may2026 regression).
    assert.match(SHOP_PAGE_SRC,
        /showError\s*\([^)]*\)\s*\{[\s\S]{0,400}if\s*\(\s*this\._unloading\s*\)\s*return/,
        'showError must early-return when _unloading is true');
});

test('shop-page.js showError hides the empty pane when showing the error pane', () => {
    // The two panes are mutually exclusive — showError must hide showEmpty's pane.
    assert.match(SHOP_PAGE_SRC,
        /showError\s*\([^)]*\)\s*\{[\s\S]{0,800}this\.elements\.empty\.hidden\s*=\s*true/,
        'showError must hide the empty pane to avoid stacking');
});

test('shop-page.js Retry button bumps navigationVersion before re-running the loader', () => {
    // Without bumping navigationVersion, a zombie in-flight reject from the
    // first attempt could fire its showError AFTER the retry's success and
    // overwrite the rendered grid.
    assert.match(SHOP_PAGE_SRC,
        /addEventListener\(\s*['"]click['"][\s\S]{0,500}this\.navigationVersion\+\+/,
        'Retry click handler must bump navigationVersion to cancel any stale in-flight render');
});

test('shop-page.js Retry button shows the loading skeleton during the retry', () => {
    assert.match(SHOP_PAGE_SRC,
        /addEventListener\(\s*['"]click['"][\s\S]{0,500}this\.showLoading\(\s*true\s*\)/,
        'Retry click handler must call showLoading(true) so the user gets immediate visual feedback');
});

test('shop-page.js: every loader-catch "Failed to load…" path uses showError, not showEmpty', () => {
    // The previous wording "showEmpty('Failed to load products. Please try
    // again.')" must not survive in any live call site — every loader-catch
    // path now lives behind showError(...). The phrase may still appear in
    // (a) the bfcache-restore comment block (historical context) and (b) the
    // defensive fallback inside showError itself (`showEmpty(message || …)`)
    // when the controller is loaded against a legacy DOM that lacks the new
    // pane — neither of those is a regression.
    const re = /showEmpty\(\s*['"]Failed to load products\. Please try again\.['"]\s*\)/;
    assert.ok(!re.test(SHOP_PAGE_SRC),
        'showEmpty("Failed to load products. Please try again.") must not appear as a live call — it was the wording that misled users into thinking the catalog was permanently empty');
});

test('shop-page.js loaders pass a retry callback that re-invokes themselves', () => {
    // Each loader catch should call showError with `() => this.loadX(...)` so
    // the Retry button reruns the failed loader (not just a generic refresh).
    const LOADERS = [
        'loadProductCodes',
        'loadProducts',
        'loadPrinterProducts',
        'loadPrinterModelProducts',
        'loadSearchResults',
    ];
    for (const fn of LOADERS) {
        const re = new RegExp(`showError\\s*\\(\\s*[^,]+,\\s*\\([^)]*\\)\\s*=>\\s*this\\.${fn}\\s*\\(`);
        assert.match(SHOP_PAGE_SRC, re,
            `${fn} must pass a retry callback that re-invokes itself`);
    }
});

test('shop-page.js hideAllLevels and pageshow handler hide the error pane', () => {
    // hideAllLevels runs on every level change — the error pane must be in the
    // mass-hide so navigation to a different category clears it.
    assert.match(SHOP_PAGE_SRC,
        /hideAllLevels\s*\(\s*\)\s*\{[\s\S]{0,600}this\.elements\.error\.hidden\s*=\s*true/,
        'hideAllLevels must hide the error pane along with the empty pane');
    // pageshow (bfcache restore) must clear the error pane the same way it
    // clears the empty pane.
    assert.match(SHOP_PAGE_SRC,
        /pageshow[\s\S]{0,800}this\.elements\.error\.hidden\s*=\s*true/,
        'pageshow handler must clear the error pane on bfcache restore');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — HTML + CSS contract
// ─────────────────────────────────────────────────────────────────────────────

test('shop.html ships the #drilldown-error pane with id="error-message" and #drilldown-retry-btn', () => {
    assert.match(SHOP_HTML_SRC, /id=["']drilldown-error["']/,
        '#drilldown-error must exist in shop.html');
    assert.match(SHOP_HTML_SRC, /id=["']error-message["']/,
        '#error-message must exist for the controller to write into');
    assert.match(SHOP_HTML_SRC, /id=["']drilldown-retry-btn["']/,
        '#drilldown-retry-btn must exist for the click-to-retry flow');
});

test('shop.html error pane starts hidden and is accessibility-tagged', () => {
    // Pane must start hidden — otherwise it flashes on first paint.
    assert.match(SHOP_HTML_SRC,
        /id=["']drilldown-error["'][^>]*hidden/,
        '#drilldown-error must include the `hidden` attribute on initial render');
    // role="alert" + aria-live so AT users get notified when the controller
    // toggles `hidden=false`.
    assert.match(SHOP_HTML_SRC,
        /id=["']drilldown-error["'][^>]*role=["']alert["']/,
        '#drilldown-error must carry role="alert" for screen readers');
});

test('pages.css ships .drilldown-error + .drilldown-error__btn styling', () => {
    assert.match(PAGES_CSS_SRC, /\.drilldown-error\s*\{/, '.drilldown-error rule must exist');
    assert.match(PAGES_CSS_SRC, /\.drilldown-error__btn\s*\{/, '.drilldown-error__btn rule must exist');
    // Retry button must have a hover/focus state — bare buttons are a UX anti-pattern.
    assert.match(PAGES_CSS_SRC, /\.drilldown-error__btn:hover\s*\{/, 'Retry button must have :hover style');
    assert.match(PAGES_CSS_SRC, /\.drilldown-error__btn:focus-visible\s*\{/, 'Retry button must have :focus-visible style');
});
