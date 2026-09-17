/**
 * A backend 500 is not an empty catalogue
 * =======================================
 * ERR-264 · Sep 2026
 *
 * Reported as "it seems like there are no products" on /search?q=273h, with
 * the note that the backend looked correct. It was not. Measured live on
 * 2026-09-17, every route in the /api/products and /api/shop family answered
 * `500 {"ok":false,"error":{"code":"INTERNAL_ERROR"}}` for about ten minutes —
 * including `/api/products?limit=1` with no filters at all — while
 * /api/search/* and /api/brands stayed up throughout. It self-recovered.
 *
 * ── WHY THE FRONTEND IS IN THIS FILE AT ALL ────────────────────────────────
 *
 * `API.request()` has two failure shapes and only one of them is loud. It
 * THROWS for a non-JSON body, a network drop or a timeout (api.js), and it
 * RESOLVES `{ ok: false, status: 5xx }` for a structured error (api.js, the
 * 5xx branch). Every catch in shop-page.js was written against the first
 * shape. The second — which is what a healthy-but-broken backend actually
 * sends, and therefore the commonest failure of all — walked straight past
 * them into code that asked only "did I get products?".
 *
 * So `/shop?brand=epson&category=ink` rendered **"No products found for this
 * category."** while three of its calls were 500ing: no error, no Try again,
 * and the empty answer then CACHED for the rest of the SPA session, which is
 * what made a ten-minute outage look permanent.
 *
 * This is the absence-as-zero defect the project keeps re-learning
 * (ERR-063/068/073/075/076/149/150). The rule it breaks: partial-ness belongs
 * in the RETURN VALUE and in the UI, never in a log line alone.
 *
 * ── AND WHY AN ADMIN SAW SOMETHING NOBODY ELSE DID ─────────────────────────
 *
 * A granted admin's catalogue reads are re-routed to /api/admin/catalog/*
 * (ERR-234), which is token-bearing and therefore never edge-cached. That
 * makes an admin the only visitor on the site who cannot be shielded by
 * Cloudflare when the origin wobbles. The storefront also paints TWICE for an
 * admin — the public route first, then a repaint when 'admin-preview:ready'
 * fires — so a failing mirror did not merely fail: it REPLACED a page that had
 * already rendered nineteen correct cards with an error pane. A signed-out
 * visitor on the same URL at the same moment saw the products.
 *
 * ── §6-§9: THE SAME DEFECT ONE LEVEL DOWN (ERR-266) ────────────────────────
 *
 * Filed separately, and the reason this file grew: the fix above stopped at
 * loadProductCodes. `/shop?brand=brother&category=ink&code=LC431` runs through
 * loadProducts, which the ERR-264 diff never touched — its hunks jump from 2419
 * to 3774 — and which had no failure state of ANY kind. It was worse than
 * unfixed: loadProducts falls back to loadProductCodes, so the retryable error
 * pane ERR-264 had just taught that function to raise was then HIDDEN by
 * showEmpty at the foot of the caller. The fix was actively undone on this route.
 *
 * Measured, not guessed: the catalogue returned 18 products for LC431 on eight
 * consecutive reads. What varied was the ADMIN. /api/admin/catalog/* is served
 * `private, no-store` (cf-cache-status DYNAMIC), so an admin's every catalogue
 * read reaches the origin while a shopper rides an edge HIT — and the origin
 * limiter is 100 requests per 60s per IP SHARED ACROSS ENDPOINTS. A burst of 15
 * measured 14 × 429, `retry-after: 27`. So the admin met RATE_LIMITED as a
 * matter of routine, every 429 read as "this code has no products", and it
 * cleared within a minute — which is why it looked random.
 *
 * ── HOW THIS FILE TESTS ────────────────────────────────────────────────────
 *
 * By EXECUTING the shipped functions, not by grepping them. A source-grep pins
 * the text that was there, not the behaviour that was meant (ERR-263), and
 * this defect is entirely about which branch runs. Every method below is
 * lifted out of the real file and run against fakes.
 *
 * Run: node --test tests/catalogue-error-vs-empty-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const API_SRC = read('inkcartridges/js/api.js');
const SHOP_SRC = read('inkcartridges/js/shop-page.js');

// ONE owner for comment stripping (ERR-253). Every test file used to carry its
// own two-regex copy, and a line comment containing a path glob silently
// deleted live code — 22,251 characters of it across 35 suites, in the
// direction that makes an assertion pass by construction.
const stripComments = require('./helpers/strip-comments');

/**
 * Lift an object-literal method out of a source file and return its text.
 * Brace-matches from the body's `{`, never the first `{` after the name — a
 * default parameter like `getProducts(filters = {})` closes immediately and
 * would yield an empty body that passes nothing and fails everything.
 * (Same shape as tests/admin-only-test-product-sep2026.test.js.)
 */
function liftMethod(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist in the shipped source`);
    let p = src.indexOf('(', start), pd = 0, i = p;
    for (; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (!pd) break; }
    }
    let depth = 0, end = i;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    return src.slice(start, end + 1);
}

/** Run lifted methods as a real object in a sandbox with the globals they read. */
function liftInto(src, signatures, globals) {
    const sandbox = Object.assign({ console }, globals);
    vm.createContext(sandbox);
    const body = signatures.map((s) => liftMethod(src, s)).join(',\n');
    vm.runInContext(`globalThis.__lifted = {\n${body}\n};`, sandbox);
    return sandbox.__lifted;
}

const QUIET = { warn() {}, error() {}, log() {} };

// ─────────────────────────────────────────────────────────────────────────────
// §1 + §2 — loadProductCodes: a failed fetch is an ERROR, an empty one is EMPTY
//
// The whole defect lives in one decision, so it is tested by running the real
// decision. `_shopEndpointAvailable: false` forces the legacy /api/products
// walk, which is the path that actually paged and therefore the path that
// mistook a 500 for the last page.
// ─────────────────────────────────────────────────────────────────────────────

const INK = {
    id: 'p1', sku: 'G273HYC', name: 'Epson Genuine 273HYC',
    product_type: 'ink_cartridge', brand: { slug: 'epson' }, series_codes: ['273'],
};

/** Build a DrilldownNav stand-in that records which pane it was asked to show. */
function makeNav(getProducts) {
    const nav = {
        navigationVersion: 1,
        // Force the legacy walk: the /api/shop branch is a separate path with
        // its own (already correct) ERR-216 handling.
        _shopEndpointAvailable: false,
        _chipsDerivedFrom: null,
        _chipsDegraded: false,
        state: { brand: 'epson', category: 'ink', type: null },
        cache: { products: {} },
        categories: [{ id: 'ink', name: 'Ink Cartridges', apiCategory: 'ink' }],
        elements: {
            levelCodes: { hidden: true },
            levelProducts: { hidden: true },
            genuineProducts: { hidden: true, children: [] },
            compatibleProducts: { hidden: true, children: [] },
        },
        panes: [],
        brandName() { return 'Epson'; },
        extractProductCodes(products) {
            return products.length ? [{ code: '273', count: products.length, products }] : [];
        },
        renderProductCodes() { this.panes.push(['codes', null]); },
        async displayProductInfo() {},
        renderProducts() {},
        showLoading() {},
        showEmpty(msg) { this.panes.push(['empty', msg]); },
        showError(msg) { this.panes.push(['error', msg]); },
    };
    nav._getProducts = getProducts;
    return nav;
}

async function runLoadProductCodes(getProducts) {
    const nav = makeNav(getProducts);
    const lifted = liftInto(SHOP_SRC, ['async loadProductCodes(navVersion)'], {
        API: { getProducts, getShopData: async () => ({ ok: false }) },
        DebugLog: QUIET,
        CONSUMABLE_PRODUCT_TYPES: ['drum_unit'],
        window: {},
    });
    await lifted.loadProductCodes.call(nav, 1);
    return nav;
}

/** A backend that is up and answering. */
const ok = (products) => async () => ({
    ok: true,
    data: { products, pagination: { page: 1, total_pages: products.length ? 1 : 0 } },
});

test('§1 a structured 5xx shows the ERROR pane, not "No products found"', async () => {
    // The reported symptom, exactly. API.request() RESOLVES this shape rather
    // than throwing, so it never reached loadProductCodes' catch.
    const nav = await runLoadProductCodes(async () => ({
        ok: false, code: 'INTERNAL_ERROR', status: 500, error: 'Failed to fetch products',
    }));
    const kinds = nav.panes.map(([k]) => k);
    assert.ok(kinds.includes('error'),
        `a 500 must raise the error pane; got ${JSON.stringify(nav.panes)}`);
    assert.ok(!kinds.includes('empty'),
        'a 500 must NOT be reported to the shopper as an empty category');
});

test('§1 a THROWN failure takes the same path as the resolved one', async () => {
    // The two failure shapes must be indistinguishable to the shopper. Before
    // ERR-264 they were not: only this one reached an error state, and only
    // because it escaped to the outer catch.
    const nav = await runLoadProductCodes(async () => {
        const e = new Error('The server is temporarily unavailable.');
        e.status = 503;
        throw e;
    });
    assert.ok(nav.panes.map(([k]) => k).includes('error'),
        `a thrown fetch must raise the error pane; got ${JSON.stringify(nav.panes)}`);
});

test('§1 the error pane offers copy that admits a retry may work', async () => {
    const nav = await runLoadProductCodes(async () => ({ ok: false, status: 500 }));
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.match(String(msg), /try again/i,
        'the error pane must tell the shopper a retry is worth making');
});

test('§1 POSITIVE CONTROL — a genuinely empty brand still shows the EMPTY pane', async () => {
    // Without this, "always show the error pane" would pass every test above.
    // A brand that truly stocks nothing must not be reported as a server fault.
    const nav = await runLoadProductCodes(ok([]));
    const kinds = nav.panes.map(([k]) => k);
    assert.ok(kinds.includes('empty'),
        `an empty 200 must show the empty pane; got ${JSON.stringify(nav.panes)}`);
    assert.ok(!kinds.includes('error'),
        'an empty 200 is an answer, not a failure — it must not raise the error pane');
});

test('§1 POSITIVE CONTROL — products still render', async () => {
    const nav = await runLoadProductCodes(ok([INK]));
    const kinds = nav.panes.map(([k]) => k);
    assert.ok(kinds.includes('codes'), 'a healthy response must render the chip grid');
    assert.ok(!kinds.includes('error') && !kinds.includes('empty'),
        'a healthy response must show neither failure pane');
});

test('§2 a failed fetch is NEVER cached — this is what made the outage look permanent', async () => {
    // cache.products[codesCacheKey] is consulted at the TOP of loadProductCodes
    // on every later visit to this brand+category. Writing an outage-derived []
    // there means the page keeps saying "no products" after the backend heals,
    // until a hard reload.
    const nav = await runLoadProductCodes(async () => ({ ok: false, status: 500 }));
    const cached = Object.entries(nav.cache.products);
    assert.deepEqual(cached, [],
        `nothing may be cached from a failed fetch; cached ${JSON.stringify(cached)}`);
});

test('§2 a SUCCESSFUL fetch is still cached — the fix must not disable memoisation', async () => {
    const nav = await runLoadProductCodes(ok([INK]));
    const keys = Object.keys(nav.cache.products);
    assert.ok(keys.some((k) => k.endsWith('-final')),
        `a good response must still populate the codes cache; got ${JSON.stringify(keys)}`);
});

test('§2 a recovered backend answers correctly after a failure — no poisoned cache', async () => {
    // The end-to-end proof of §2: fail, then succeed on the same instance.
    const nav = makeNav(null);
    let up = false;
    const getProducts = async () => (up
        ? { ok: true, data: { products: [INK], pagination: { page: 1, total_pages: 1 } } }
        : { ok: false, status: 500 });
    const lifted = liftInto(SHOP_SRC, ['async loadProductCodes(navVersion)'], {
        API: { getProducts, getShopData: async () => ({ ok: false }) },
        DebugLog: QUIET,
        CONSUMABLE_PRODUCT_TYPES: ['drum_unit'],
        window: {},
    });
    await lifted.loadProductCodes.call(nav, 1);
    assert.ok(nav.panes.map(([k]) => k).includes('error'), 'first pass must fail loudly');

    up = true;
    nav.panes = [];
    await lifted.loadProductCodes.call(nav, 1);
    assert.ok(nav.panes.map(([k]) => k).includes('codes'),
        `after the backend recovers the retry must render; got ${JSON.stringify(nav.panes)}`);
});

test('§2 partial-ness is recorded on the instance, not only in a log line', async () => {
    const nav = await runLoadProductCodes(async () => ({ ok: false, status: 500 }));
    assert.equal(nav._chipsDegraded, true,
        '_chipsDegraded is the existing ERR-216 vocabulary for "this grid is not authoritative"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — _catalogReadWithPublicFallback
//
// This is the owner ERR-124's anonymity rule moved to, so it carries that
// rule's guard now: catalog-edge-cache-jul2026 §5/§9 point here. The public
// leg must ALWAYS be read anonymously, and the authenticated getter must only
// ever receive the mirrored endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_EP = '/api/search/smart?page=1&limit=100&q=273h';
const MIRROR_EP = '/api/admin/catalog/search/smart?page=1&limit=100&q=273h';
const ADMIN_ROUTE = { endpoint: MIRROR_EP, anonymous: false };
const SHOPPER_ROUTE = { endpoint: PUBLIC_EP, anonymous: true };

function liftFallback() {
    return liftInto(API_SRC,
        ['async _catalogReadWithPublicFallback(route, publicEndpoint, run)'],
        { DebugLog: QUIET });
}

/** Records every (endpoint, anonymous) pair the helper asked for. */
function recorder(responses) {
    const calls = [];
    let n = 0;
    const run = async (endpoint, anonymous) => {
        calls.push({ endpoint, anonymous });
        const r = responses[Math.min(n++, responses.length - 1)];
        if (typeof r === 'function') return r();
        return r;
    };
    return { calls, run };
}

test('§3 a shopper is read anonymously on the public endpoint, once', async () => {
    const API = liftFallback();
    const { calls, run } = recorder([{ ok: true, data: { products: [] } }]);
    await API._catalogReadWithPublicFallback(SHOPPER_ROUTE, PUBLIC_EP, run);
    assert.deepEqual(calls, [{ endpoint: PUBLIC_EP, anonymous: true }],
        'a non-admin must cost exactly one anonymous read of the public URL');
});

test('§3 a healthy mirror answers, and the public route is never touched', async () => {
    const API = liftFallback();
    const body = { ok: true, data: { products: [INK] } };
    const { calls, run } = recorder([body]);
    const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
    assert.equal(out, body, 'the mirror body must be returned untouched');
    assert.deepEqual(calls, [{ endpoint: MIRROR_EP, anonymous: false }],
        'a working mirror must not cost a second request');
});

test('§3 a 5xx on the mirror falls back to the public route — ANONYMOUSLY', async () => {
    // This is the ERR-124 guarantee, now owned here: the fallback leg must go
    // out tokenless, or an authenticated body could be stored in the shared
    // Cloudflare entry for a public URL.
    const API = liftFallback();
    const good = { ok: true, data: { products: [INK] } };
    const { calls, run } = recorder([{ ok: false, status: 500, code: 'INTERNAL_ERROR' }, good]);
    const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
    assert.equal(out, good, 'the admin must receive the public answer rather than a failure');
    assert.deepEqual(calls, [
        { endpoint: MIRROR_EP, anonymous: false },
        { endpoint: PUBLIC_EP, anonymous: true },
    ], 'the fallback must read the PUBLIC endpoint with anonymous === true');
});

test('§3 a THROWN mirror failure also falls back', async () => {
    const API = liftFallback();
    const good = { ok: true, data: { products: [INK] } };
    const { calls, run } = recorder([
        () => { throw new Error('The server is temporarily unavailable.'); },
        good,
    ]);
    const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
    assert.equal(out, good);
    assert.equal(calls.length, 2, 'a throw must be retried publicly, exactly once');
    assert.equal(calls[1].anonymous, true);
});

test('§3 a lapsed session falls back too — a dead page helps nobody', async () => {
    // These envelopes are written EXACTLY as request() emits them: 401/403/429
    // carry `code` and NO `status` field (api.js — only the 5xx branch sets it).
    // That is the whole reason this helper keys on the code. An earlier draft
    // gated on `status >= 500` and excluded these by accident of a missing
    // field; red-proofing showed the exclusion list could be deleted without a
    // single test going red.
    //
    // Falling back is AdminPreview's own policy arriving one moment late: every
    // state it can reach other than 'granted' already routes publicly.
    for (const resp of [
        { ok: false, code: 'UNAUTHORIZED', error: 'Missing authorization header' },
        { ok: false, code: 'FORBIDDEN', error: 'Forbidden' },
        { ok: false, code: 'RATE_LIMITED', retry_after: 30 },
    ]) {
        const API = liftFallback();
        const good = { ok: true, data: { products: [INK] } };
        const { calls, run } = recorder([resp, good]);
        const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
        assert.equal(out, good, `${resp.code} must degrade to the shopper's catalogue`);
        assert.deepEqual(calls, [
            { endpoint: MIRROR_EP, anonymous: false },
            { endpoint: PUBLIC_EP, anonymous: true },
        ], `${resp.code} must retry the PUBLIC endpoint anonymously`);
    }
});

test('§3 NOT_FOUND does NOT fall back — an absent mirror is the "unsupported" state', async () => {
    // The single exception, and the one that must survive every future edit.
    // AdminPreview exists to SHOUT that /api/admin/catalog/* is missing —
    // "admin-only products cannot be shown", which is not "there are none".
    // Quietly serving the shopper's catalogue is exactly what would hide it,
    // and silence on a route nobody implemented is how ERR-166 ran for months.
    //
    // Note the shape: a real NOT_FOUND envelope has NO `status` either, so this
    // test would pass for the wrong reason under the old status-based rule. It
    // now fails the moment the code check is removed.
    const API = liftFallback();
    const resp = { ok: false, code: 'NOT_FOUND', error: 'Endpoint not found' };
    const { calls, run } = recorder([resp, { ok: true, data: { products: [] } }]);
    const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
    assert.equal(out, resp, 'the 404 must reach the caller unchanged');
    assert.equal(calls.length, 1, 'a missing mirror route must not trigger a public retry');
});

test('§3 a 5xx envelope is the shape that actually carries a status', async () => {
    // Pins the asymmetry the rule was rewritten around: this is the ONLY error
    // envelope request() stamps with `status`. If that ever changes, the rule
    // above is unaffected — which is the point of keying on the code.
    const API = liftFallback();
    const good = { ok: true, data: { products: [INK] } };
    const { calls, run } = recorder([
        { ok: false, code: 'INTERNAL_ERROR', status: 500, error: 'Failed to fetch products' },
        good,
    ]);
    const out = await API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run);
    assert.equal(out, good);
    assert.equal(calls.length, 2);
});

test('§3 when BOTH legs fail the ORIGINAL error is what surfaces', async () => {
    const API = liftFallback();
    const first = new Error('mirror exploded');
    const { run } = recorder([
        () => { throw first; },
        () => { throw new Error('public also exploded'); },
    ]);
    await assert.rejects(
        () => API._catalogReadWithPublicFallback(ADMIN_ROUTE, PUBLIC_EP, run),
        (e) => e === first,
        'the surfaced error must describe the request we meant to make');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the admin repaint may not destroy a good page
// ─────────────────────────────────────────────────────────────────────────────

function liftShowError() {
    return liftInto(SHOP_SRC, ['_hasRenderedCatalogue()', 'showError(message, onRetry)'],
        { DebugLog: QUIET });
}

/** A DOM stand-in whose panes record what was shown. */
function makePanes(rendered) {
    const kids = rendered ? [{}, {}] : [];
    return {
        _unloading: false,
        _adminRepaint: false,
        elements: {
            empty: { hidden: false },
            error: { hidden: true },
            errorMessage: { textContent: '' },
            errorRetryBtn: null,
            genuineProducts: { hidden: !rendered, children: kids },
            compatibleProducts: { hidden: true, children: [] },
            levelCodes: { hidden: true, children: [] },
        },
    };
}

test('§4 a failed admin repaint leaves a rendered grid alone', async () => {
    // The reported screenshot: nineteen good cards replaced by an error pane
    // because the SECOND, admin-routed pass failed.
    const M = liftShowError();
    const nav = Object.assign(makePanes(true), M);
    nav._adminRepaint = true;
    nav.showError("We couldn't load search results.", () => {});
    assert.equal(nav.elements.error.hidden, true,
        'the error pane must stay hidden over an already-rendered grid');
});

test('§4 a failed admin repaint on an EMPTY page still shows the error', async () => {
    // The guard is about not DESTROYING a render, not about silence. With
    // nothing on screen there is nothing to protect and the admin deserves to
    // be told. Without this, the guard would swallow real failures.
    const M = liftShowError();
    const nav = Object.assign(makePanes(false), M);
    nav._adminRepaint = true;
    nav.showError("We couldn't load search results.", () => {});
    assert.equal(nav.elements.error.hidden, false,
        'with no grid rendered the error pane must still appear');
});

test('§4 POSITIVE CONTROL — outside a repaint, a rendered grid does NOT suppress the error', async () => {
    // The guard must be scoped to the repaint. A genuine load failure after a
    // previous render (a filter change, a Retry) still owns the screen.
    const M = liftShowError();
    const nav = Object.assign(makePanes(true), M);
    nav._adminRepaint = false;
    nav.showError("We couldn't load search results.", () => {});
    assert.equal(nav.elements.error.hidden, false,
        'the suppression must apply ONLY during an admin-preview repaint');
});

test('§4 the repaint listener always clears its own flag', () => {
    // A flag left true would suppress every later error on the page for the
    // rest of the session. It is set and cleared around an `await`, so the
    // clear has to be in a `finally` — a trailing assignment would be skipped
    // by the very failure the flag exists for.
    //
    // Comments are stripped first, via the ONE owner (ERR-253): the rationale
    // above this listener is longer than the code it guards, and a fixed
    // character window over raw source would be measuring prose.
    // Whitespace is collapsed too: the stripper BLANKS a comment line rather
    // than deleting it, so fifteen blanked lines at twenty spaces of indent
    // would otherwise fill the window with layout.
    const code = stripComments(liftMethod(SHOP_SRC, 'async init()')).replace(/\s+/g, ' ');
    const at = code.indexOf("'admin-preview:ready'");
    assert.ok(at >= 0, 'init() must still register the admin-preview:ready listener');
    assert.match(code.slice(at, at + 200), /finally\s*\{\s*this\._adminRepaint\s*=\s*false/,
        '_adminRepaint must be cleared in a finally, or one failure mutes the page forever');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — getWithSWR must not memoise a failure
//
// Found by driving a real browser rather than by reading the code: after §1–§4
// the error pane appeared correctly, the backend "recovered", Try again was
// pressed — and nothing happened. `request()` RESOLVES a structured 5xx, so
// both of getWithSWR's `.then` handlers were memoising it like any other body.
// The retry re-read the failure out of memory for SWR_TTL_MS (60s) and never
// touched the network: the one control the shopper is given was inert during
// the only window it exists for.
//
// The stale path was worse — a background revalidation that came back 5xx
// REPLACED good stale data with the failure, past a `.catch()` that says "keep
// stale on failure" and never fired because the common failure does not throw.
// ─────────────────────────────────────────────────────────────────────────────

const EP = '/api/products?brand=epson&page=1&limit=100';

/** A lifted getWithSWR with a controllable fetcher and a real cache. */
function makeSWR(responses) {
    const API = liftInto(API_SRC, ['async getWithSWR(endpoint, { ttl = this.SWR_TTL_MS, anonymous = false } = {})'],
        { DebugLog: QUIET, window: { dispatchEvent() {} } });
    let n = 0;
    const calls = [];
    API.SWR_TTL_MS = 60000;
    API._swrCache = new Map();
    API._swrInflight = new Map();
    API._swrClone = (d) => d;
    API.getPublic = async (ep) => {
        calls.push(ep);
        const r = responses[Math.min(n++, responses.length - 1)];
        return typeof r === 'function' ? r() : r;
    };
    API.get = API.getPublic;
    API._calls = calls;
    return API;
}

const GOOD = { ok: true, data: { products: [INK], pagination: { page: 1, total_pages: 1 } } };
const BOOM = { ok: false, code: 'INTERNAL_ERROR', status: 500, error: 'Failed to fetch products' };

test('§5 a 5xx is returned to the caller but NEVER memoised', async () => {
    const API = makeSWR([BOOM]);
    const out = await API.getWithSWR(EP, { anonymous: true });
    assert.equal(out, BOOM, 'the caller still gets the failure — it is not swallowed');
    assert.equal(API._swrCache.size, 0,
        'a failure must leave the SWR cache empty, or the retry reads it back');
});

test('§5 Try again after a failure is a REAL request — this is the browser symptom', async () => {
    // Two calls inside the 60s TTL. Before ERR-264 the second never left the
    // page: the button looked alive and did nothing.
    const API = makeSWR([BOOM, GOOD]);
    const first = await API.getWithSWR(EP, { anonymous: true });
    const second = await API.getWithSWR(EP, { anonymous: true });
    assert.equal(first, BOOM);
    assert.equal(second, GOOD, 'the retry must reach the network and see the recovered backend');
    assert.equal(API._calls.length, 2, 'the retry must not be served from the failure cache');
});

test('§5 POSITIVE CONTROL — a good response IS still memoised', async () => {
    // Without this, "never cache anything" would pass every test above and
    // would silently delete the deduplication the SWR cache exists for.
    const API = makeSWR([GOOD, GOOD]);
    await API.getWithSWR(EP, { anonymous: true });
    await API.getWithSWR(EP, { anonymous: true });
    assert.equal(API._calls.length, 1,
        'a second read inside the TTL must be served from cache, not refetched');
    assert.equal(API._swrCache.size, 1);
});

test('§5 a failed background revalidation KEEPS the stale-but-good copy', async () => {
    // The stale path. `_swrClone` is identity here, so an overwrite is visible
    // as the returned object changing identity.
    const API = makeSWR([GOOD, BOOM, BOOM]);
    await API.getWithSWR(EP, { anonymous: true });          // populate
    // Age the entry past the TTL so the next read takes the stale branch.
    const entry = API._swrCache.get(EP);
    entry.timestamp = Date.now() - 120000;

    const stale = await API.getWithSWR(EP, { anonymous: true });
    assert.equal(stale, GOOD, 'the stale read returns the good copy immediately');
    // Let the background revalidation settle.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(API._swrCache.get(EP).data, GOOD,
        'a 5xx revalidation must NOT overwrite good data with an error envelope');
});

test('§5 a failed revalidation stays quiet — it must not repaint a working page', async () => {
    // `swr:update` listeners re-render from the payload, so announcing a
    // failure here would paint an error over a page that is working.
    const events = [];
    const API = liftInto(API_SRC, ['async getWithSWR(endpoint, { ttl = this.SWR_TTL_MS, anonymous = false } = {})'],
        { DebugLog: QUIET, window: { dispatchEvent: (e) => events.push(e) }, CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } } });
    let n = 0;
    API.SWR_TTL_MS = 60000;
    API._swrCache = new Map();
    API._swrInflight = new Map();
    API._swrClone = (d) => d;
    API.getPublic = async () => [GOOD, BOOM][Math.min(n++, 1)];
    API.get = API.getPublic;

    await API.getWithSWR(EP, { anonymous: true });
    API._swrCache.get(EP).timestamp = Date.now() - 120000;
    await API.getWithSWR(EP, { anonymous: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(events.length, 0,
        'a failed revalidation must not dispatch swr:update');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — loadProducts: THE CODE DRILLDOWN, the level ERR-264 did not reach
//
// Reported separately, on 2026-09-17: /shop?brand=brother&category=ink&code=LC431
// showing "No products found for this code." Eight sequential reads of the live
// catalogue returned 18 products every time, so nothing was missing. The whole
// defect was that this function had NO failure state — the ERR-264 fix above
// stopped at loadProductCodes, and its diff hunks jump straight from 2419 to
// 3774, over the top of loadProducts.
//
// It reproduced for an admin and not for a shopper, for a measurable reason:
// /api/admin/catalog/* is served `private, no-store` (cf-cache-status DYNAMIC),
// so an admin's every catalogue read reaches the origin, while a shopper rides
// an edge HIT. The origin limiter is 100 requests per 60s per IP SHARED ACROSS
// ENDPOINTS — a burst of 15 measured 14 × 429 with `retry-after: 27`. So the
// admin, and only the admin, met RATE_LIMITED as a matter of routine, and every
// 429 read to the shopper as "this code has no products".
// ─────────────────────────────────────────────────────────────────────────────

const LC431 = Array.from({ length: 18 }, (_, i) => ({
    id: 'b' + i, sku: 'GLC431' + i, name: 'Brother LC431',
    product_type: 'ink_cartridge', source: i % 2 ? 'compatible' : 'genuine',
}));

/**
 * A Shop stand-in for the code level. showEmpty/showError deliberately mutate
 * `elements.error.hidden` exactly as the real ones do (:1248, :1320) — that is
 * what makes §7's clobber test a measurement rather than a tautology.
 */
function makeCodeNav(opts = {}) {
    return {
        navigationVersion: 1,
        _shopEndpointAvailable: opts.shopEndpoint !== false,
        state: { brand: 'brother', category: 'ink', type: null, code: 'LC431' },
        cache: { products: opts.cache || {} },
        categories: [{ id: 'ink', name: 'Ink Cartridges', apiCategory: 'ink' }],
        elements: {
            levelCodes: { hidden: true, children: [] },
            levelProducts: { hidden: true },
            genuineProducts: { hidden: true, children: [] },
            compatibleProducts: { hidden: true, children: [] },
            genuineSection: { hidden: true },
            compatibleSection: { hidden: true },
            empty: { hidden: true },
            error: { hidden: true },   // hideAllLevels' post-condition (:1201)
        },
        panes: [],
        retries: [],
        _codeAliasesFor() { return opts.aliases || null; },
        _backendStemFor() { return null; },
        loadProductCodes: opts.loadProductCodes || (async function () {}),
        async displayProductInfo() {},
        renderProducts() {},
        showLoading() {},
        showEmpty(msg) { this.panes.push(['empty', msg]); this.elements.error.hidden = true; },
        showError(msg, onRetry) {
            this.panes.push(['error', msg]);
            this.retries.push(onRetry);
            this.elements.error.hidden = false;
        },
    };
}

function liftLoadProducts(getShopData, src = SHOP_SRC) {
    return liftInto(src, [
        'async loadProducts(navVersion)',
        '_errorPaneShowing()',
        '_isCatalogueFailure(resp)',
    ], {
        API: { getShopData },
        DebugLog: QUIET,
        window: { location: { search: '', pathname: '/shop', hash: '' } },
        history: { state: null, replaceState() {} },
        URLSearchParams,
    });
}

async function runLoadProducts(getShopData, opts = {}) {
    const nav = makeCodeNav(opts);
    const lifted = liftLoadProducts(getShopData, opts.src);
    nav._errorPaneShowing = lifted._errorPaneShowing;
    nav._isCatalogueFailure = lifted._isCatalogueFailure;
    await lifted.loadProducts.call(nav, 1);
    return nav;
}

const kindsOf = (nav) => nav.panes.map(([k]) => k);

test('§6 a structured 5xx shows the ERROR pane, not "No products found for this code."', async () => {
    // The reported symptom, exactly. This envelope RESOLVES (api.js:471-478),
    // so it never threw and never reached loadProducts' catch — it was simply
    // discarded by the `response.ok` test and read as zero rows.
    const nav = await runLoadProducts(async () => ({
        ok: false, code: 'INTERNAL_ERROR', status: 500, error: 'Failed to fetch products',
    }));
    assert.ok(kindsOf(nav).includes('error'),
        'a 500 must raise the error pane; got ' + JSON.stringify(nav.panes));
    assert.ok(!kindsOf(nav).includes('empty'),
        'a 500 must NOT be reported to the shopper as an empty code');
});

test('§6 a THROWN failure takes the same path as the resolved one', async () => {
    const nav = await runLoadProducts(async () => {
        const e = new Error('The server is temporarily unavailable.');
        e.code = 'INTERNAL_ERROR';
        e.status = 503;
        throw e;
    });
    assert.ok(kindsOf(nav).includes('error'),
        'a thrown fetch must raise the error pane; got ' + JSON.stringify(nav.panes));
});

test('§6 a network drop and a timeout carry no code at all, and still error', async () => {
    // The guard must not depend on a field being present. A TypeError from
    // fetch and an AbortError from the 15s timeout both arrive bare.
    for (const make of [
        () => new TypeError('Failed to fetch'),
        () => Object.assign(new Error('aborted'), { name: 'AbortError' }),
    ]) {
        const nav = await runLoadProducts(async () => { throw make(); });
        assert.ok(kindsOf(nav).includes('error'),
            'a bare transport failure must raise the error pane; got ' + JSON.stringify(nav.panes));
    }
});

test('§6 RATE_LIMITED gets its own copy — THROWN shape (api.js:128-132)', async () => {
    const nav = await runLoadProducts(async () => {
        const e = new Error('Too many requests. Please wait a moment.');
        e.code = 'RATE_LIMITED';
        e.retryAfter = 27;
        throw e;
    });
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.ok(msg, 'RATE_LIMITED must raise the error pane');
    assert.match(msg, /wait a moment/i,
        'a rate-limited shopper must be told to wait, not that the server is warming up');
    assert.doesNotMatch(msg, /warming up/i);
});

test('§6 RATE_LIMITED gets its own copy — RESOLVED shape (api.js:394-395)', async () => {
    // This envelope carries NO `status` field. A guard keyed on `status === 429`
    // would miss it entirely and fall through to the 5xx copy — the exact
    // could-not-fail mistake ERR-264 documents at api.js:953-959. Keyed on code.
    const nav = await runLoadProducts(async () => ({
        ok: false, code: 'RATE_LIMITED', error: 'Too many requests', retry_after: 27,
    }));
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.ok(msg, 'a resolved RATE_LIMITED envelope must raise the error pane');
    assert.match(msg, /wait a moment/i);
});

test('§6 POSITIVE CONTROL — a genuinely empty code still says so, verbatim', async () => {
    // Without this, "always show the error pane" passes every test above and
    // the fix is the same bug pointing the other way (ERR-191).
    const nav = await runLoadProducts(async () => ({ ok: true, data: { products: [] } }));
    assert.deepEqual(nav.panes, [['empty', 'No products found for this code.']],
        'a real empty result must keep its exact copy and raise no error pane');
});

test('§6 POSITIVE CONTROL — a 200 carrying no products array is an ANSWER, not an outage', async () => {
    const nav = await runLoadProducts(async () => ({ ok: true, data: {} }));
    assert.ok(!kindsOf(nav).includes('error'),
        'a 200 without a products array must not be dressed up as a backend failure');
});

test('§6 NOT_FOUND is an answer, not an outage — no retry button that can never work', async () => {
    // Same boundary _catalogReadWithPublicFallback draws at api.js:975-979.
    const nav = await runLoadProducts(async () => ({ ok: false, code: 'NOT_FOUND', error: 'No such code' }));
    assert.deepEqual(nav.panes, [['empty', 'No products found for this code.']],
        'NOT_FOUND must read as empty; offering Try again on it is a dead end');
});

test('§6 POSITIVE CONTROL — 18 products still render, no pane at all', async () => {
    const nav = await runLoadProducts(async () => ({ ok: true, data: { products: LC431 } }));
    assert.deepEqual(nav.panes, [], 'a healthy load must raise neither pane');
    assert.equal(nav.elements.levelProducts.hidden, false, 'the grid must be revealed');
    assert.equal(nav.cache.products['brother-ink-all-products-LC431'].length, 18,
        'a complete, healthy result IS cached');
});

test('§6 Try again re-runs THIS loader, and succeeds once the backend recovers', async () => {
    let healthy = false;
    const getShopData = async () => healthy
        ? { ok: true, data: { products: LC431 } }
        : { ok: false, code: 'INTERNAL_ERROR', status: 500 };
    const nav = makeCodeNav();
    const lifted = liftLoadProducts(getShopData);
    nav._errorPaneShowing = lifted._errorPaneShowing;
    nav._isCatalogueFailure = lifted._isCatalogueFailure;
    nav.loadProducts = lifted.loadProducts;

    await lifted.loadProducts.call(nav, 1);
    assert.equal(typeof nav.retries[0], 'function', 'the error pane must wire a retry');

    healthy = true;
    await nav.retries[0].call(nav, 1);
    assert.equal(nav.elements.levelProducts.hidden, false,
        'the retry must reach the network and render the recovered catalogue');
});

test('§6 a PARTIAL fan-out renders what arrived but is never memoised', async () => {
    // Chip "LC431" with aliases LC431 + LC431XL: one answers, one 429s. The old
    // `length > 0` guard would freeze that incomplete set into the session.
    const nav = await runLoadProducts(async ({ code }) => (
        code === 'LC431'
            ? { ok: true, data: { products: LC431.slice(0, 12) } }
            : { ok: false, code: 'RATE_LIMITED' }
    ), { aliases: ['LC431', 'LC431XL'] });

    assert.equal(nav.elements.levelProducts.hidden, false,
        'fail-soft: the rows that did arrive must still render');
    assert.equal(nav._productsDegraded, true,
        'partial-ness belongs in the state, not only in a log line');
    assert.equal(nav.cache.products['brother-ink-all-products-LC431'], undefined,
        'an INCOMPLETE set must never become the answer the next navigation reads');
});

test('§6 POSITIVE CONTROL — a complete fan-out IS cached', async () => {
    // Without this, deleting the cache write altogether passes the test above.
    const nav = await runLoadProducts(async () => ({ ok: true, data: { products: LC431 } }),
        { aliases: ['LC431', 'LC431XL'] });
    assert.equal(nav.cache.products['brother-ink-all-products-LC431'].length, 18,
        'a fan-out where every alias answered must still be memoised');
});

test('§6 a total outage caches nothing at all', async () => {
    const nav = await runLoadProducts(async () => ({ ok: false, code: 'INTERNAL_ERROR', status: 500 }));
    assert.deepEqual(Object.keys(nav.cache.products), [],
        'nothing may be written to the session cache when every read failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — showEmpty may not paint over an error pane a nested call already raised
//
// The compound half of this defect. loadProducts falls back to loadProductCodes
// (:3117) when it has no rows; ERR-264 taught THAT function to raise a retryable
// error pane; loadProducts then ran on to showEmpty, which hides the error pane
// outright (:1248). So on this one route the ERR-264 fix was not merely absent —
// it was actively undone, and the shopper watched the error flash and vanish.
// ─────────────────────────────────────────────────────────────────────────────

test('§7 a nested loadProductCodes failure survives to the shopper', async () => {
    const nav = await runLoadProducts(async () => ({ ok: false, code: 'INTERNAL_ERROR', status: 500 }), {
        shopEndpoint: false,   // skip the fan-out; the legacy fallback is the only path
        loadProductCodes: async function () {
            // Exactly what the ERR-264 fix makes it do (:2407-2418).
            this.showError("We couldn't load products. The server may be warming up — please try again.",
                () => {});
        },
    });
    assert.equal(nav.elements.error.hidden, false,
        'the error pane raised by the nested call must still be visible at the end');
    assert.equal(kindsOf(nav).filter((k) => k === 'empty').length, 0,
        'showEmpty must not run at all once a nested call has raised an error');
});

test('§7 POSITIVE CONTROL — a nested call that SUCCEEDS still yields the empty pane', async () => {
    // Otherwise §7 just means "never show empty again", which is the same bug
    // pointing the other way.
    const nav = await runLoadProducts(async () => ({ ok: true, data: { products: [] } }), {
        shopEndpoint: false,
        loadProductCodes: async function () { /* healthy, finds nothing, raises nothing */ },
    });
    assert.deepEqual(nav.panes, [['empty', 'No products found for this code.']],
        'a healthy walk that genuinely found nothing must still say so');
});

test('§7 _errorPaneShowing reads the DOM, and a legacy pane-less DOM is not "showing"', async () => {
    const lifted = liftLoadProducts(async () => ({ ok: true, data: { products: [] } }));
    const probe = (error) => lifted._errorPaneShowing.call({ elements: { error } });
    assert.equal(probe({ hidden: false }), true);
    assert.equal(probe({ hidden: true }), false);
    assert.equal(probe(undefined), false, 'a DOM with no error pane must not read as "an error is up"');
    assert.equal(probe({}), false,
        'a legacy pane with no `hidden` property must not mute the empty state forever');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the manual-code cache must not memoise "we could not ask"
//
// _supabaseSelect (api.js:1718) returns null for a non-2xx, for a throw AND for
// missing config, never as a real answer — a select that matched nothing gives
// []. _manualCodeCacheGet counts only `undefined` as a miss, so that null stuck
// for the full 60s TTL and the retry read the failure back out of memory. Fixed
// in the SETTER, because all three call sites (:1761, :1797, :1833) are the same
// three lines and a grep for one spelling is how ERR-259 shipped.
// ─────────────────────────────────────────────────────────────────────────────

function liftManualCodes(supabaseSelect, src = API_SRC) {
    const API = liftInto(src, [
        '_manualCodeCacheGet(key)',
        '_manualCodeCacheSet(key, value)',
        '_normManualCode(code)',
        'async _fetchProductIdsForCode(code)',
        'purgeCatalogCache()',
    ], { DebugLog: QUIET, window: {} });
    API._manualCodeCache = new Map();
    API._MANUAL_CODE_TTL = 60000;
    API._swrCache = new Map();
    API._swrInflight = new Map();
    API._supabaseSelect = supabaseSelect;
    return API;
}

test('§8 a FAILED manual-code read is not memoised — the retry asks again', async () => {
    let calls = 0;
    const API = liftManualCodes(async () => (++calls === 1 ? null : [{ product_id: 'p1' }]));

    // Spread it: the `[]` on the failure path is built INSIDE the vm realm, so
    // its prototype is not the host's Array.prototype and a strict deepEqual
    // fails on two arrays that print identically.
    assert.deepEqual([...await API._fetchProductIdsForCode('LC431')], [],
        'a failed read yields no ids, fail-open');
    assert.deepEqual(await API._fetchProductIdsForCode('LC431'), ['p1'],
        'the immediate retry must reach Supabase, not the memoised failure');
    assert.equal(calls, 2, 'the failure must not have been cached');
});

test('§8 POSITIVE CONTROL — an empty ARRAY is a real answer and IS cached', async () => {
    // Distinguishes "do not cache failures" from "do not cache anything", which
    // would delete the cache's whole reason to exist.
    let calls = 0;
    const API = liftManualCodes(async () => { calls++; return []; });
    await API._fetchProductIdsForCode('LC431');
    await API._fetchProductIdsForCode('LC431');
    assert.equal(calls, 1, 'a genuine "no manual codes" answer must still be memoised');
});

test('§8 POSITIVE CONTROL — a successful read is cached', async () => {
    let calls = 0;
    const API = liftManualCodes(async () => { calls++; return [{ product_id: 'p1' }]; });
    assert.deepEqual(await API._fetchProductIdsForCode('LC431'), ['p1']);
    assert.deepEqual(await API._fetchProductIdsForCode('LC431'), ['p1']);
    assert.equal(calls, 1, 'a good read must be memoised');
});

test('§8 purgeCatalogCache clears the manual-code layer too', async () => {
    let calls = 0;
    const API = liftManualCodes(async () => { calls++; return [{ product_id: 'p1' }]; });
    await API._fetchProductIdsForCode('LC431');
    assert.equal(API._manualCodeCache.size, 1);
    API.purgeCatalogCache();
    assert.equal(API._manualCodeCache.size, 0,
        'the manual-code layer is catalogue data and must not outlive a purge');
    await API._fetchProductIdsForCode('LC431');
    assert.equal(calls, 2, 'after a purge the next read must reach the network');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — RED-PROOF: every guard above is shown to be load-bearing
//
// A guard that cannot fail is the defect this project keeps re-filing, not a
// safety net: ERR-264's own first draft gated on `status >= 500` with an
// exclusion list that could be deleted without a single test going red, and
// ERR-258 found SIX guards hiding behind one 6088/0 green suite. These tests
// are the proof that did not exist — each deletes one guard from the source,
// re-lifts, and asserts the ORIGINAL defect comes back.
//
// Mutating the lifted STRING rather than the file on disk is deliberate: other
// sessions hold shop-page.js, and hand-breaking it to watch a test fail is how
// a broken guard gets swept into someone else's commit.
// ─────────────────────────────────────────────────────────────────────────────

/** Delete or replace one guard, insisting the anchor is present and unique. */
function mutate(src, find, replace) {
    assert.ok(src.includes(find), 'mutant anchor must still exist in the shipped source:\n' + find);
    assert.equal(src.split(find).length, 2, 'mutant anchor must be unique:\n' + find);
    return src.replace(find, replace);
}

test('§9 MUTANT — delete the failure classifier and the 500 reads as empty again', async () => {
    const broken = mutate(SHOP_SRC,
        '} else if (this._isCatalogueFailure(response)) {',
        '} else if (false) {');
    const nav = await runLoadProducts(
        async () => ({ ok: false, code: 'INTERNAL_ERROR', status: 500 }), { src: broken });
    assert.ok(kindsOf(nav).includes('empty'),
        'without the classifier the reported symptom must return — if this passes, the guard is decorative');
});

test('§9 MUTANT — revert the fan-out catch to `() => null` and a thrown 429 loses its identity', async () => {
    // Red-proofing corrected this test's first draft, which is the point of
    // writing it. Reverting the catch does NOT bring the empty pane back: the
    // classifier treats a bare `null` as a failure (`if (!resp) return true`),
    // so the error pane still appears. What `() => null` actually destroys is
    // WHICH failure it was — the thrown RATE_LIMITED (api.js:128-132) arrives
    // as `null`, carries no code, and the rate-limited admin is told the server
    // is warming up. So this catch earns its place on the COPY, not the pane,
    // and the assertion now says so rather than overclaiming.
    const broken = mutate(SHOP_SRC,
        `}).catch((err) => ({
                                ok: false,
                                code: (err && err.code) || 'FETCH_FAILED',
                            }))`,
        '}).catch(() => null)');
    const thrower = async () => {
        const e = new Error('Too many requests. Please wait a moment.');
        e.code = 'RATE_LIMITED';
        throw e;
    };
    const nav = await runLoadProducts(thrower, { src: broken });
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.match(msg, /warming up/i,
        'with `() => null` the thrown rate-limit code is lost and the wrong copy is shown');

    // …and the shipped source gets it right, which is the other half of the proof.
    const fixed = await runLoadProducts(thrower);
    const [, goodMsg] = fixed.panes.find(([k]) => k === 'error') || [];
    assert.match(goodMsg, /wait a moment/i,
        'the shipped catch must preserve the code so the copy is right');
});

test('§9 MUTANT — key the rate-limit copy on `status` and the resolved 429 falls through', async () => {
    // The ERR-264 mistake, re-run against the new guard: request() stamps
    // `status` on the 5xx envelope ALONE, so a status-keyed rule silently
    // misses every RATE_LIMITED that arrives as an envelope.
    const broken = mutate(SHOP_SRC,
        'if (!unavailableCode) unavailableCode = response && response.code;',
        'if (!unavailableCode) unavailableCode = response && response.status;');
    const nav = await runLoadProducts(
        async () => ({ ok: false, code: 'RATE_LIMITED', retry_after: 27 }), { src: broken });
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.match(msg, /warming up/i,
        'keyed on status, a resolved RATE_LIMITED must get the WRONG copy — proving code-keying earns its place');
});

test('§9 MUTANT — drop the rate-limit arm and a 429 is told the server is warming up', async () => {
    const broken = mutate(SHOP_SRC,
        "unavailableCode === 'RATE_LIMITED'\n                                ? \"We're handling a lot of requests right now. Please wait a moment and try again.\"\n                                : ",
        '');
    const nav = await runLoadProducts(async () => ({ ok: false, code: 'RATE_LIMITED' }), { src: broken });
    const [, msg] = nav.panes.find(([k]) => k === 'error') || [];
    assert.doesNotMatch(msg, /wait a moment/i,
        'without the arm the rate-limit copy must disappear');
});

test('§9 MUTANT — revert the partial-cache guard and an incomplete set is memoised', async () => {
    const broken = mutate(SHOP_SRC,
        'if (mergedProducts.length > 0 && !productsUnavailable) {',
        'if (mergedProducts.length > 0) {');
    const nav = await runLoadProducts(async ({ code }) => (
        code === 'LC431'
            ? { ok: true, data: { products: LC431.slice(0, 12) } }
            : { ok: false, code: 'RATE_LIMITED' }
    ), { aliases: ['LC431', 'LC431XL'], src: broken });
    assert.equal(nav.cache.products['brother-ink-all-products-LC431'].length, 12,
        'the old guard must demonstrably freeze a partial fan-out into the session');
});

test('§9 MUTANT — delete the nested-failure fold and showEmpty clobbers the error pane', async () => {
    const broken = mutate(SHOP_SRC,
        'if (this._errorPaneShowing()) productsUnavailable = true;',
        '');
    const nav = await runLoadProducts(async () => ({ ok: false, code: 'INTERNAL_ERROR' }), {
        src: broken,
        shopEndpoint: false,
        loadProductCodes: async function () {
            this.showError("We couldn't load products. The server may be warming up — please try again.", () => {});
        },
    });
    assert.equal(nav.elements.error.hidden, true,
        'without the fold, showEmpty must demonstrably hide the pane ERR-264 raised');
    assert.ok(kindsOf(nav).includes('empty'));
});

test('§9 MUTANT — drop the NOT_FOUND carve-out and a real "none" becomes a dead retry button', async () => {
    const broken = mutate(SHOP_SRC,
        "return resp.code !== 'NOT_FOUND';",
        'return true;');
    const nav = await runLoadProducts(
        async () => ({ ok: false, code: 'NOT_FOUND' }), { src: broken });
    assert.ok(kindsOf(nav).includes('error'),
        'without the carve-out NOT_FOUND must become an outage — the carve-out is a decision, not noise');
});

test('§9 MUTANT — delete the manual-code null guard and the failure sticks for the TTL', async () => {
    const broken = mutate(API_SRC,
        'if (value === null || value === undefined) return value;',
        '');
    let calls = 0;
    const API = liftManualCodes(async () => (++calls === 1 ? null : [{ product_id: 'p1' }]), broken);
    await API._fetchProductIdsForCode('LC431');
    await API._fetchProductIdsForCode('LC431');
    assert.equal(calls, 1,
        'without the guard the failed read must be served back out of cache — that is the bug');
});
