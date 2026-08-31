/**
 * RIBBON BRAND PAGES — a failed request must never render as an empty shelf
 * ========================================================================
 *
 * errors.md ERR-193, from the backend hand-off
 * `ribbon-brand-pages-anon-rpc-fix-aug2026.md`.
 *
 * WHAT HAPPENED. `/ribbons?printer_brand=<slug>` does not call `/api/ribbons`.
 * It calls the Supabase RPC `get_ribbons_by_brand` DIRECTLY with the anon key,
 * and that function was written `RETURNS SETOF products` over a `SELECT p.*`
 * body. On 2026-08-29 10:38 UTC the backend revoked `cost_price`,
 * `profit_ex_gst` and `margin_pct` from the `anon` role — correctly, and
 * permanently. Under PostgreSQL column privileges a star projection that touches
 * a revoked column fails WHOLESALE:
 *
 *     SELECT p.*  →  42501 permission denied for table products
 *                 →  PostgREST 401
 *                 →  getRibbonsByBrand catch → { ok:false, products: [] }
 *                 →  "No ribbons found for Brother yet. Check back soon!"
 *
 * All 63 brand pages rendered that sentence for ~44 hours. `GET /api/ribbons`
 * was healthy throughout, so nothing alerted. The backend has fixed the function
 * (explicit public columns, migration 156).
 *
 * THE FRONTEND DEFECT THIS FILE PINS is the second half of that chain, and it is
 * ours. `getRibbonsByBrand` threw its own `HTTP 401` into its own catch and
 * returned a bare empty list, so `loadProducts()` could not tell "this brand
 * stocks nothing" from "the database refused us" — and printed the merchandising
 * copy for both, with no retry and no signal. The reason was in the response body
 * the entire time and was discarded one line later.
 *
 * The distinction now lives in three places, and all three are asserted here:
 *   1. api.js reports WHY (`code`/`status`), instead of flattening to `[]`;
 *   2. ribbons-page.js renders a separate #drilldown-error pane with a Retry;
 *   3. the failure is reported through channels that leave the browser —
 *      `DebugLog` is a no-op anywhere but localhost, so the "add a DebugLog.error"
 *      fix the hand-off asked for would have produced nothing in production.
 *
 * §2 IS A POSITIVE CONTROL and is the most important section in the file. Ten
 * brands (HP, Printronix, 3M, Adler, Calcomp, Digital Equipment, Philips,
 * Tally-Gemicin, Texas Instuments, Unisys) genuinely have no ribbons mapped and
 * MUST still get "Check back soon" verbatim. Without that control this suite
 * would pass just as well if the fix had turned every empty brand into an error
 * — which would be the same bug pointing the other way (ERR-191).
 *
 * Run with: node --test tests/ribbon-brand-page-error-state-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const API_SRC = READ('inkcartridges/js/api.js');
const PAGE_SRC = READ('inkcartridges/js/ribbons-page.js');
const HTML_SRC = READ('inkcartridges/html/ribbons.html');
const CSS_SRC = READ('inkcartridges/css/pages.css');

// ─────────────────────────────────────────────────────────────────────────────
// Sandboxes — both modules are browser globals, evaluated off the shipped file.
// ─────────────────────────────────────────────────────────────────────────────

function loadApi(fetchImpl) {
    const calls = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {} },
        fetch: async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts, calls); },
        setTimeout, clearTimeout, AbortController,
        URL, URLSearchParams, encodeURIComponent, decodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, Math,
        String, Number, Boolean, Symbol, RegExp, TypeError, isNaN, parseInt, parseFloat,
        structuredClone: globalThis.structuredClone,
        Headers: globalThis.Headers,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
        },
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { cookie: '', addEventListener() {} },
        navigator: { userAgent: 'test' },
        location: { href: 'https://test/', search: '', pathname: '/' },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInContext(API_SRC, vm.createContext(sandbox), { filename: 'api.js' });
    return { API: sandbox.API, calls };
}

/**
 * A JSON response stub complete enough for BOTH paths: the bare-fetch helpers
 * (which read only `ok`/`status`/`json`) and API.request(), which also reads
 * `headers.get('x-request-id')` and `X-Guest-Session`. Omitting `headers` makes
 * request() throw, which _fetchWithAuth then RETRIES — quietly turning one call
 * into three and any success into a failure.
 */
const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
});

function loadPage() {
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {} },
        document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [] },
        window: { addEventListener() {}, location: { search: '', pathname: '/ribbons' } },
        URLSearchParams, JSON, Math, Number, Object, Array, String, Boolean, Date, Error, RegExp,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
    };
    sandbox.window.document = sandbox.document;
    sandbox.globalThis = sandbox;
    // `const RibbonsPage = {...}` is a bare lexical declaration — it never lands
    // on `window` (the ERR-167 family: js/security.js does the same). So the
    // sandbox cannot see it unless we hand it over explicitly, exactly as the
    // admin ESM suites do with stripEsm's trailing globalThis assignments.
    vm.runInContext(PAGE_SRC + '\n;globalThis.RibbonsPage = RibbonsPage;',
        vm.createContext(sandbox), { filename: 'ribbons-page.js' });
    assert.ok(sandbox.RibbonsPage, 'the sandbox must actually expose RibbonsPage');
    return sandbox.RibbonsPage;
}

/** Drop line comments so an assertion greps live code, not the fix's own notes. */
function stripComments(src) {
    return src.split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');
}

/** Slice a function body out of the source so a grep can be scoped to it. */
function bodyOf(src, startMarker, endMarker) {
    const i = src.indexOf(startMarker);
    assert.ok(i !== -1, `could not find ${startMarker}`);
    const j = src.indexOf(endMarker, i);
    assert.ok(j > i, `could not find ${endMarker} after ${startMarker}`);
    return src.slice(i, j);
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — api.js reports the reason instead of flattening it
// ─────────────────────────────────────────────────────────────────────────────

test('§1 a 401 from the RPC yields ok:false carrying PostgREST\'s own code', async () => {
    // This is the exact body PostgREST returned for 44 hours.
    const { API } = loadApi(async () => jsonResponse(401, {
        code: '42501', message: 'permission denied for table products',
    }));
    const res = await API.getRibbonsByBrand('brother');

    assert.equal(res.ok, false, 'a 401 must not be reported as a successful read');
    assert.equal(res.code, '42501',
        'the envelope must carry PostgREST\'s own code — 42501 is the string that would have named this outage on day one');
    assert.equal(res.status, 401, 'the HTTP status must survive to the caller');
    assert.match(res.error, /permission denied/i, 'the server\'s message must reach the caller');
    // NB: length, not deepEqual — this array is constructed inside the vm realm
    // and its prototype is not the test realm's Array.prototype.
    assert.equal(res.data.products.length, 0,
        'the data shape stays the same so no existing reader breaks — the REASON is what was added');
});

test('§1 a 500 and a network failure are distinguishable from each other', async () => {
    const five = loadApi(async () => jsonResponse(500, { message: 'boom' }));
    const r5 = await five.API.getRibbonsByBrand('brother');
    assert.equal(r5.ok, false);
    assert.equal(r5.status, 500);
    assert.equal(r5.code, 'HTTP_500', 'a 5xx with no PostgREST code falls back to HTTP_<status>');

    const net = loadApi(async () => { throw new Error('Failed to fetch'); });
    const rn = await net.API.getRibbonsByBrand('brother');
    assert.equal(rn.ok, false);
    assert.equal(rn.code, 'NETWORK_ERROR',
        '"we could not reach the server" and "the server said no" need different words — only one is worth a retry');
    assert.equal(rn.status, null, 'there is no HTTP status when the request never completed');
});

test('§1 a timeout is its own code, and the request is actually aborted', async () => {
    // A bare fetch with no AbortController leaves the skeleton spinning forever:
    // these helpers bypass API.request(), so they inherit none of its bounds.
    let sawSignal = false;
    const { API } = loadApi(async (_url, opts) => {
        sawSignal = !!(opts && opts.signal);
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
    });
    const res = await API.getRibbonsByBrand('brother');
    assert.ok(sawSignal, 'the direct Supabase reads must pass an AbortController signal');
    assert.equal(res.code, 'TIMEOUT', 'an abort must be reported as a timeout, not as a generic network error');
    assert.ok(Number.isFinite(API.ANON_REST_TIMEOUT_MS) && API.ANON_REST_TIMEOUT_MS > 0,
        'there must be a real timeout constant, not an unbounded wait');
});

test('§1 a genuine 200 with zero rows is still a SUCCESS (positive control)', async () => {
    // The ten empty brands answer 200 []. If this ever reported ok:false the fix
    // would have replaced one wrong state with the opposite wrong state.
    const { API } = loadApi(async () => jsonResponse(200, []));
    const res = await API.getRibbonsByBrand('hp');
    assert.equal(res.ok, true, 'an empty brand is a successful read, not a failure');
    assert.deepEqual(res.data.products, []);
});

test('§1 getRibbonBrandsList got the same treatment — the brand GRID had the same bug', async () => {
    const { API } = loadApi(async () => jsonResponse(401, { code: '42501', message: 'nope' }));
    const res = await API.getRibbonBrandsList();
    assert.equal(res.ok, false);
    assert.equal(res.code, '42501');
    assert.equal(res.data.brands.length, 0);
});

test('§1 the RPC is still called with apikey-only and the documented body', async () => {
    // apikey-without-Authorization is what is measured working against
    // production. This asserts the fix did not quietly change the request.
    const { API, calls } = loadApi(async () => jsonResponse(200, []));
    await API.getRibbonsByBrand('brother');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/get_ribbons_by_brand$/);
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.apikey, 'anon-key');
    assert.ok(!calls[0].opts.headers.Authorization,
        'this call has never sent an Authorization header; adding one changes a path that is measured working');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { brand_slug: 'brother' });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — POSITIVE CONTROL: an honestly empty brand keeps its honest words
// ─────────────────────────────────────────────────────────────────────────────

test('§2 the "Check back soon" copy survives verbatim for a genuinely empty brand', () => {
    // Ten brands have zero ribbons mapped in product_ribbon_brands and correctly
    // render this. A suite that only proved the sentence was gone would pass just
    // as well if the fix had deleted the honest empty state outright.
    assert.match(PAGE_SRC, /No ribbons found for \$\{activeBrand\} yet\. Check back soon!/,
        'the empty-shelf copy must still exist for the ten brands it is TRUE for');
});

test('§2 that copy is reachable only from the zero-rows branch, never from a failure', () => {
    // Comments are stripped first: the failure branch's comment deliberately
    // QUOTES the sentence it must never render, as the record of what went wrong.
    const body = stripComments(bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)'));
    const failIdx = body.indexOf('res.ok !== true');
    const emptyIdx = body.indexOf('ribbons.length === 0');
    const copyIdx = body.indexOf('Check back soon');
    assert.ok(failIdx !== -1 && emptyIdx !== -1 && copyIdx !== -1, 'all three branches must exist');
    assert.ok(failIdx < emptyIdx,
        'the failure branch must be evaluated BEFORE the zero-rows branch');
    assert.ok(copyIdx > emptyIdx,
        '"Check back soon" must live inside the zero-rows branch, not the failure branch');

    const failBranch = body.slice(failIdx, emptyIdx);
    assert.doesNotMatch(failBranch, /Check back soon/,
        'a failed request must never be rendered in the words reserved for an empty catalogue — this is ERR-193 itself');
    assert.match(failBranch, /this\.showError\(/,
        'the failure branch must use showError');
});

test('§2 the double-escape is gone — showEmpty writes textContent, so pre-escaping was visible', () => {
    // `escapeHtml(brand)` then `.textContent = msg` renders "Smith &amp; Corona".
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    assert.doesNotMatch(body, /Security\.escapeHtml\(activeBrand\)/,
        'the brand name must not be HTML-escaped before being assigned via textContent');
    assert.match(PAGE_SRC, /this\.elements\.emptyMessage\.textContent = message/,
        'showEmpty must still assign via textContent (which escapes on its own)');
});

test('§2 the brand list is memoised on success but never on failure', async () => {
    const good = loadApi(async () => jsonResponse(200, [{ id: '1', name: 'HP', slug: 'hp' }]));
    await good.API.getRibbonBrandsList();
    await good.API.getRibbonBrandsList();
    assert.equal(good.calls.length, 1,
        'the grid, the label resolver and the mega-nav all want this list — one round trip, not three');

    const bad = loadApi(async () => jsonResponse(401, { code: '42501', message: 'nope' }));
    await bad.API.getRibbonBrandsList();
    await bad.API.getRibbonBrandsList();
    assert.equal(bad.calls.length, 2,
        'a cached failure would leave the brand grid permanently broken for the session');
});

test('§2 the empty sentence waits for the properly-cased brand label', () => {
    // resolveBrandLabelFromAPI races loadProducts, so a pane painted first said
    // "No ribbons found for Hp yet" directly beneath an H1 reading "HP".
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    const emptyIdx = body.indexOf('ribbons.length === 0');
    const branch = body.slice(emptyIdx, body.indexOf('let visible'));
    assert.match(branch, /await this\.resolveBrandLabelFromAPI\(\)/,
        'the zero-rows branch must resolve the real label before composing its sentence');
    assert.match(branch, /this\.navigationVersion !== navVersion/,
        'and must re-check the nav version after that await, like every other await here');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — the error pane: markup, wiring, bfcache
// ─────────────────────────────────────────────────────────────────────────────

test('§3 ribbons.html ships a #drilldown-error pane, hidden and announced', () => {
    assert.match(HTML_SRC, /id=["']drilldown-error["']/, '#drilldown-error must exist');
    assert.match(HTML_SRC, /id=["']error-message["']/, '#error-message must exist for the controller to write into');
    assert.match(HTML_SRC, /id=["']drilldown-retry-btn["']/, '#drilldown-retry-btn must exist');
    assert.match(HTML_SRC, /id=["']drilldown-error["'][^>]*hidden/, 'it must start hidden');
    assert.match(HTML_SRC, /id=["']drilldown-error["'][^>]*role=["']alert["']/, 'it must carry role="alert"');
});

test('§3 the error pane has its OWN heading — a fault never appears under "No ribbons found"', () => {
    const errIdx = HTML_SRC.indexOf('id="drilldown-error"');
    const pane = HTML_SRC.slice(errIdx, errIdx + 1400);
    assert.doesNotMatch(pane, /<h3>\s*No ribbons found\s*<\/h3>/,
        'the failure pane must not reuse the empty-shelf heading — that heading IS the bug');
    assert.match(pane, /<h3>[^<]+<\/h3>/, 'the failure pane needs a heading of its own');
});

test('§3 the controller binds all three pane elements', () => {
    assert.match(PAGE_SRC, /error:\s*document\.getElementById\(['"]drilldown-error['"]\)/);
    assert.match(PAGE_SRC, /errorMessage:\s*document\.getElementById\(['"]error-message['"]\)/);
    assert.match(PAGE_SRC, /errorRetryBtn:\s*document\.getElementById\(['"]drilldown-retry-btn['"]\)/);
});

test('§3 showError honours the bfcache _unloading guard and hides the empty pane', () => {
    const body = bodyOf(PAGE_SRC, '    showError(message, onRetry) {', '    reportLoadFailure(');
    assert.match(body, /if\s*\(\s*this\._unloading\s*\)\s*return/,
        'a fetch rejecting mid-navigation must not paint a sticky error into the bfcache snapshot');
    assert.match(body, /this\.elements\.empty\.hidden\s*=\s*true/,
        'showError must hide the empty pane so the two never stack');
});

test('§3 the Retry button is replaced (not stacked) and bumps navigationVersion', () => {
    const body = bodyOf(PAGE_SRC, '    showError(message, onRetry) {', '    reportLoadFailure(');
    assert.match(body, /cloneNode\(true\)/,
        'successive showError calls must not stack click listeners on the same button');
    assert.match(body, /this\.navigationVersion\+\+/,
        'the retry must bump navigationVersion so a zombie response from the failed attempt cannot paint over it');
    assert.match(body, /this\.showLoading\(\s*true\s*\)/,
        'the retry must show the skeleton immediately rather than flashing through empty');
});

test('§3 showEmpty hides the error pane, and both panes clear on bfcache restore / level change', () => {
    const empty = bodyOf(PAGE_SRC, '    showEmpty(message) {', '    /**');
    assert.match(empty, /this\.elements\.error\.hidden\s*=\s*true/,
        'showEmpty must hide the error pane, or a later empty result leaves the old error on screen');
    assert.match(PAGE_SRC, /pageshow[\s\S]{0,600}elements\.error\.hidden\s*=\s*true/,
        'the pageshow/bfcache handler must clear the error pane');
    assert.match(PAGE_SRC, /showLevel\s*\([\s\S]{0,500}elements\.error\.hidden\s*=\s*true/,
        'switching back to the brand grid must clear the error pane');
});

test('§3 every early return clears the previously rendered grid', () => {
    // Only renderProducts clears the grid, so an early return leaves the previous
    // brand's cards under the new pane.
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    const guards = body.match(/this\.clearProductGrids\(\)/g) || [];
    assert.ok(guards.length >= 5,
        `every early return (failed, empty, filter-failed, filtered-to-zero, thrown) must clear the grid — found ${guards.length}`);
    assert.match(PAGE_SRC, /clearProductGrids\(\)\s*\{/, 'the helper must exist');
});

test('§3 the brand GRID failure also uses showError, not the empty pane', () => {
    const body = bodyOf(PAGE_SRC, '    async loadBrands() {', '    resolveBrandLabel()');
    assert.doesNotMatch(body, /showEmpty\(\s*['"]Failed to load ribbon brands/,
        'the old "Failed to load ribbon brands" showEmpty call must be gone');
    assert.match(body, /this\.showError\(/, 'loadBrands must render failures in the error pane');
    assert.match(body, /res\.ok === false/,
        'a failed brands read must short-circuit BEFORE the legacy-API fallback, which is for an EMPTY table not a failed read');
});

test('§3 pages.css already styles the pane (shared with /shop — no new CSS invented)', () => {
    assert.match(CSS_SRC, /\.drilldown-error\s*\{/);
    assert.match(CSS_SRC, /\.drilldown-error__btn\s*\{/);
    assert.match(CSS_SRC, /\.drilldown-error__btn:focus-visible\s*\{/);
    assert.match(HTML_SRC, /href="\/css\/pages\.css/, 'ribbons.html must link the stylesheet that defines them');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the signal actually leaves the browser
// ─────────────────────────────────────────────────────────────────────────────

test('§4 DebugLog alone is not treated as telemetry — it is a no-op off localhost', () => {
    const utils = READ('inkcartridges/js/utils.js');
    assert.match(utils, /_isDev[\s\S]{0,200}localhost/,
        'DebugLog gates every method on _isDev — this is why the outage produced no signal');
    // Start at the docblock: the measured enum is recorded there, beside the code.
    const body = bodyOf(PAGE_SRC, '     * Report a catalogue read that failed', '    // =========================================');
    assert.match(body, /gtag/, 'GA takes an arbitrary event name and is the channel that works today');
    assert.match(body, /catch\s*\(_\)\s*\{\s*\}/,
        'the channel must be guarded — analytics must never gate the page');

    // Measured 2026-09-01: POST /api/analytics/traffic-event with
    // event_type=catalogue_load_failed answers 400 VALIDATION_FAILED,
    // "event_type" must be one of [pageview, click]. A call that cannot succeed
    // is not instrumentation — it is the DebugLog mistake one layer up.
    const live = stripComments(body);
    assert.doesNotMatch(live, /TrafficTracker/,
        'the first-party tracker cannot carry this event yet (hard 400) — shipping the call would record nothing while looking instrumented');
    assert.doesNotMatch(live, /['"]click['"]/,
        'and it must never be smuggled through as a click — that fabricates an interaction and corrupts the click metrics');
    assert.match(body, /pageview, click/,
        'the measured enum must be written down beside the code, so the gap is a fact rather than an omission');
});

test('§4 every failure path reports before it renders', () => {
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    const reports = body.match(/this\.reportLoadFailure\(/g) || [];
    assert.equal(reports.length, 3,
        `exactly three branches in loadProducts are failures — the read failed, the brand-name fetch failed, or something threw — and each must report. Found ${reports.length}`);
    const empty = body.slice(body.indexOf('ribbons.length === 0'), body.indexOf('let visible'));
    assert.doesNotMatch(empty, /reportLoadFailure/,
        'the zero-rows branch must NOT report — an empty brand is a correct answer, and crying wolf on the ten empty brands trains everyone to ignore the alert (ERR-191)');
    assert.match(PAGE_SRC, /reportLoadFailure\('ribbon_brands'/,
        'the brand grid failure must be reported too');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — FE-2: the volume ladder on brand pages
// ─────────────────────────────────────────────────────────────────────────────

test('§5 getRibbonLadders fetches the whole ribbon universe in ONE capped request', async () => {
    const { API, calls } = loadApi(async () => jsonResponse(200, {
        ok: true,
        data: { ribbons: [{ sku: 'A1', quantity_breaks: [{ min_quantity: 3 }], brand: 'Epson' }] },
        meta: { total: 1 },
    }));
    const res = await API.getRibbonLadders();
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'one request, not one per SKU');
    assert.match(calls[0].url, /limit=200/,
        'limit=200 is the endpoint maximum (201 is a hard 400) and covers the 109 ribbons that exist');
    assert.deepEqual(res.bySku.get('A1').quantity_breaks, [{ min_quantity: 3 }]);
    assert.equal(res.bySku.get('A1').brand, 'Epson',
        'the resolved brand NAME comes from here — the RPC has only a brand_id UUID');
});

test('§5 a success is memoised, a failure is NOT', async () => {
    const okApi = loadApi(async () => jsonResponse(200, { ok: true, data: { ribbons: [] }, meta: { total: 0 } }));
    await okApi.API.getRibbonLadders();
    await okApi.API.getRibbonLadders();
    assert.equal(okApi.calls.length, 1, 'a successful ladder fetch must be reused for the session');

    // A 400 rather than a 500, so _fetchWithAuth's transient-5xx retry ladder
    // does not muddy the call count this test is actually about.
    const badApi = loadApi(async () => jsonResponse(400, { error: { message: 'boom' } }));
    const first = await badApi.API.getRibbonLadders();
    assert.equal(first.ok, false, 'a 400 must be reported as a failed ladder fetch');
    const afterFirst = badApi.calls.length;
    await badApi.API.getRibbonLadders();
    assert.ok(badApi.calls.length > afterFirst,
        'caching a failure would disable volume pricing for the whole session over one blip — and a missing ladder is invisible');
});

test('§5 absence stays absence — a row with no quantity_breaks stores null, not []', async () => {
    // business.js: an ABSENT ladder means "fall through"; an EMPTY array means
    // "this band has no discount". Collapsing them turns a missing feature into a
    // confident "no discount available" (the ERR-063/068/149 shape).
    const { API } = loadApi(async () => jsonResponse(200, {
        ok: true,
        data: { ribbons: [{ sku: 'NOLADDER', brand: 'X' }, { sku: 'EMPTY', quantity_breaks: [], brand: 'Y' }] },
        meta: { total: 2 },
    }));
    const res = await API.getRibbonLadders();
    assert.equal(res.bySku.get('NOLADDER').quantity_breaks, null,
        'an absent ladder must not become an empty one');
    assert.deepEqual(res.bySku.get('EMPTY').quantity_breaks, [],
        'an explicitly empty ladder is real data and must survive');
});

test('§5 applyLadders copies ONLY the ladder and the brand name', () => {
    const page = loadPage();
    const rows = [{ sku: 'A1', retail_price: 10, stock_quantity: 4, name: 'a', _brandName: '' }];
    const bySku = new Map([['A1', { quantity_breaks: [{ min_quantity: 3 }], brand: 'Epson' }]]);
    const n = page.applyLadders(rows, bySku);

    assert.equal(n, 1);
    assert.deepEqual(rows[0].quantity_breaks, [{ min_quantity: 3 }]);
    assert.equal(rows[0]._brandName, 'Epson', 'this is what fixes data-product-brand=""');
    assert.equal(rows[0].retail_price, 10,
        'price must NOT be copied across — the RPC row is this page\'s source of truth for what a ribbon costs');
    assert.equal(rows[0].stock_quantity, 4, 'nor stock');
});

test('§5 applyLadders leaves an unmatched row completely untouched', () => {
    const page = loadPage();
    const rows = [{ sku: 'MISSING', retail_price: 10 }];
    assert.equal(page.applyLadders(rows, new Map()), 0);
    assert.ok(!('quantity_breaks' in rows[0]),
        'a SKU the hydration cannot answer must get NO key, so Business.ingest falls through instead of reporting "no discount"');
});

test('§5 hydration runs after the paint, is version-guarded, and patches rather than repaints', () => {
    const body = bodyOf(PAGE_SRC, '    async hydrateLadders(rows, container, navVersion) {', '    // =========================================\n    // LOAD');
    assert.match(body, /this\.navigationVersion !== navVersion/,
        'a late ladder must not paint onto a page the visitor has already navigated away from');
    assert.match(body, /this\._unloading/, 'and not during unload');
    assert.match(body, /setAttribute\('data-product-brand'/,
        'the brand name must be patched onto the existing card — never by re-rendering the grid under the visitor (ERR-179)');
    assert.doesNotMatch(body, /renderProducts\(/,
        'hydration must not re-render');
    assert.match(body, /Business\.ingest\(rows\)/, 'the ladder must be handed to Business.ingest');

    const load = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    const renderIdx = load.indexOf('this.renderProducts(visible)');
    const hydrateIdx = load.indexOf('this.hydrateLadders(');
    assert.ok(renderIdx !== -1 && hydrateIdx > renderIdx,
        'hydration must be kicked off AFTER the paint so it never delays it');
    assert.ok(!/await this\.hydrateLadders\(/.test(load),
        'the post-paint hydration must not be awaited');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — FE-3: the other filters actually apply on a brand page
// ─────────────────────────────────────────────────────────────────────────────

test('§6 sortRows implements the API\'s own sort vocabulary', () => {
    const page = loadPage();
    const rows = [
        { sku: 'c', name: 'Cobalt', retail_price: 30 },
        { sku: 'a', name: 'Amber', retail_price: 10 },
        { sku: 'b', name: 'Beryl', retail_price: 20 },
    ];
    assert.deepEqual(page.sortRows(rows, 'name').map(r => r.sku), ['a', 'b', 'c']);
    assert.deepEqual(page.sortRows(rows, 'price_asc').map(r => r.sku), ['a', 'b', 'c']);
    assert.deepEqual(page.sortRows(rows, 'price_desc').map(r => r.sku), ['c', 'b', 'a']);
    assert.deepEqual(page.sortRows(rows, 'nonsense').map(r => r.sku), ['a', 'b', 'c'],
        'an unknown sort falls back to name rather than to arbitrary order');
});

test('§6 a ribbon with no readable price sorts LAST in both directions, never as $0', () => {
    const page = loadPage();
    const rows = [
        { sku: 'known', name: 'Known', retail_price: 20 },
        { sku: 'unknown', name: 'Unknown', retail_price: null },
    ];
    assert.deepEqual(page.sortRows(rows, 'price_asc').map(r => r.sku), ['known', 'unknown'],
        'an unknown price must not head the cheapest list — Number(null) === 0 is the ERR-068 shape');
    assert.deepEqual(page.sortRows(rows, 'price_desc').map(r => r.sku), ['known', 'unknown'],
        'and must not head the dearest list either');
    assert.equal(page.rowPrice({ retail_price: null }), null, 'an absent price reads as null, not 0');
    assert.equal(page.rowPrice({ retail_price: '' }), null, 'and so does an empty string');
    assert.equal(page.rowPrice({ retail_price: 0 }), 0, 'but a real zero survives (positive control)');
});

test('§6 filterRows applies colour and manufacturer brand, case-insensitively', () => {
    const page = loadPage();
    const rows = [
        { sku: 'a', color: 'Black', _brandName: 'Epson' },
        { sku: 'b', color: 'Red', _brandName: 'Epson' },
        { sku: 'c', color: 'Black', _brandName: 'Star' },
    ];
    page.state.color = 'black'; page.state.ribbonBrand = null;
    assert.deepEqual(page.filterRows(rows).map(r => r.sku), ['a', 'c']);

    page.state.color = null; page.state.ribbonBrand = 'epson';
    assert.deepEqual(page.filterRows(rows).map(r => r.sku), ['a', 'b']);

    page.state.color = 'Black'; page.state.ribbonBrand = 'Star';
    assert.deepEqual(page.filterRows(rows).map(r => r.sku), ['c'], 'filters compose');

    page.state.color = null; page.state.ribbonBrand = null;
    assert.deepEqual(page.filterRows(rows).map(r => r.sku), ['a', 'b', 'c'],
        'no filters means no filtering (positive control)');
});

test('§6 the params object is no longer built and silently discarded', () => {
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    assert.match(body, /this\.sortRows\(/, 'sort must be applied on the brand branch');
    assert.match(body, /this\.filterRows\(/, 'colour/brand must be applied on the brand branch');
    assert.match(body, /matched\.slice\(/, 'and the page must actually be sliced');
    assert.match(body, /total_pages:\s*totalPages/,
        'a real pagination record must be synthesised — it used to be null on every brand page');
});

test('§6 a printer_model URL takes the branch that can actually filter by model', () => {
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    assert.match(body, /const useBrandRpc = !!this\.state\.brand && !this\.state\.model/,
        'the RPC has no device data, so a model filter must go to the API rather than silently widening to the whole brand');
});

test('§6 a brand filter is resolved BEFORE render, or refused — never rendered unfiltered', () => {
    const body = bodyOf(PAGE_SRC, 'async loadProducts(navVersion)', '    renderProducts(ribbons)');
    const idx = body.indexOf('if (this.state.ribbonBrand)');
    assert.ok(idx !== -1, 'the manufacturer-filter branch must exist');
    const branch = body.slice(idx, body.indexOf('const matched'));
    assert.match(branch, /await API\.getRibbonLadders\(\)/,
        'the brand NAME must be fetched before filtering by it — the RPC has only the UUID');
    assert.match(branch, /this\.showError\(/,
        'if the names cannot be fetched the filter must be REFUSED, not silently skipped — a page that looks filtered and is not is the ERR-151/173/190 shape');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — grouping: never label a ribbon a kind it never claimed to be
// ─────────────────────────────────────────────────────────────────────────────

test('§7 an untyped row is no longer defaulted into "Printer Ribbons"', () => {
    // /api/ribbons sends no product_type on ANY row (measured: 109 of 109), so
    // the old `|| 'printer_ribbon'` filed typewriter ribbons and correction tape
    // under a heading that was simply wrong.
    const live = PAGE_SRC.split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
    assert.doesNotMatch(live, /product_type\s*\|\|\s*['"]printer_ribbon['"]/,
        'the default-to-printer_ribbon fallback must be gone from LIVE code (the fix comments quote it deliberately)');
    const body = bodyOf(PAGE_SRC, '    renderProducts(ribbons) {', '    createRibbonCard(ribbon)');
    assert.match(body, /unlabelled/,
        'rows with no product_type must go to an unlabelled grid rather than borrowing a heading');
    assert.match(body, /if \(unlabelled\.length\) addGrid\(unlabelled\)/,
        'and they must still be RENDERED — an unrecognised type used to be dropped from the page silently');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the decoy params must stay uncalled, and stay documented as decoys
// ─────────────────────────────────────────────────────────────────────────────

test('§8 nothing calls the ribbon_brand= param, which is silently ignored today', () => {
    // Measured 2026-08-31: GET /api/ribbons?ribbon_brand=brother returns ok:true
    // with the FULL unfiltered 109 rows. Shipping it early would render every
    // ribbon on every brand page and look like it worked.
    for (const rel of ['inkcartridges/js/api.js', 'inkcartridges/js/ribbons-page.js']) {
        assert.doesNotMatch(READ(rel), /ribbon_brand=|ribbon_brand['"]?\s*:/,
            `${rel} must not send ribbon_brand= until the backend actually implements it`);
    }
});

test('§8 the getRibbons docblock no longer advertises type/search as working filters', () => {
    const doc = bodyOf(API_SRC, '     * Get ribbons with optional filters', '    async getRibbons(params');
    assert.match(doc, /IGNORED/, 'the docblock must name the params that do nothing');
    assert.match(doc, /type/, 'type must be listed among them');
    assert.match(doc, /search/, 'and search');
    assert.doesNotMatch(doc, /@param \{object\} params - Filter parameters \(printer_brand, printer_model, brand, type, color, search/,
        'the old line listing type and search as filters must be gone');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — dead code that made this page harder to reason about
// ─────────────────────────────────────────────────────────────────────────────

test('§9 the dead filter-dropdown loader and stale grid binding are gone', () => {
    assert.doesNotMatch(PAGE_SRC, /loadRibbonBrands/,
        'loadRibbonBrands targeted #ribbon-brand-filter, which does not exist in ribbons.html, and nothing called it');
    assert.doesNotMatch(PAGE_SRC, /ribbon-brand-filter/);
    assert.doesNotMatch(PAGE_SRC, /productsGrid:/,
        '#ribbon-products-grid is not in the HTML — renderProducts builds its own grids');
    assert.doesNotMatch(PAGE_SRC, /subtypeLabel/,
        'subtypeLabel was computed and never used');
});

test('§9 the cost columns are still absent from everything this page asks for', () => {
    // The revoke is permanent and correct. Nothing here may reach for a wider
    // projection to get a field back.
    for (const rel of ['inkcartridges/js/ribbons-page.js', 'inkcartridges/js/api.js']) {
        const src = READ(rel);
        for (const col of ['cost_price', 'profit_ex_gst', 'margin_pct']) {
            const live = src.split('\n')
                .filter(l => l.includes(col) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
            assert.deepEqual(live, [], `${rel} must not read ${col} — it is revoked from anon and staying revoked`);
        }
    }
});
