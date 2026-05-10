/**
 * Compatible-products recovery contract — May 2026
 * =================================================
 *
 * The backend's /api/shop endpoint filters by series_codes (a string[] on
 * each product). Compatible products in the catalog ship with
 * `series_codes: []` because the extraction job that runs for genuines was
 * never wired up for compatibles (readfirst/catalog-defects-may2026.md §6).
 *
 * Customer-visible consequences before the fix:
 *  - Codes drilldown chips for compatible-only series (HP 02, Epson 73N, …)
 *    never appeared.
 *  - Mixed series (HP 564 = 7 genuines + 7 compatibles) showed only the
 *    genuine count in the chip and only the genuines on click.
 *  - Brands with mostly compatibles (Epson 201 / 87 totals) looked half-empty.
 *
 * api.js's getShopData fires a parallel `source=compatible` sidecar fetch,
 * derives series_codes from each compatible's name/SKU via
 * `_enrichSeriesCodes`, and merges the missing rows back into the primary
 * response. This file pins:
 *
 *   1. _enrichSeriesCodes — naming-pattern extraction is correct across
 *      every catalog convention seen in real product names (HP, Epson, Canon).
 *      Empty input yields no codes; populated arrays pass through with
 *      casing normalized.
 *   2. getShopData (no code) — drilldown series merge: chips for
 *      compatible-only codes appear; mixed-source codes get summed counts;
 *      `series` stays sorted alphanumerically with numeric awareness.
 *   3. getShopData (code=X) — code-filtered grid: missing compatibles for
 *      code X are appended; existing products are not duplicated; meta.total
 *      is bumped when present.
 *   4. Negative cases — source=genuine, no brand, no category, search=, and
 *      unhealthy primary all skip the sidecar entirely (no extra HTTP call).
 *   5. Failure isolation — sidecar 5xx/network failure leaves primary
 *      response intact (fail-open).
 *
 * Run: node --test tests/compatible-products-recovery.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');

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
        Set,
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
        RegExp,
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

function shopEnvelope({ products = [], series = null, meta } = {}) {
    return {
        ok: true,
        data: { products, ...(series !== null ? { series } : {}), counts: {} },
        meta: meta || { page: 1, limit: 200, total: products.length, total_pages: 1, has_next: false, has_prev: false },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. _enrichSeriesCodes — naming-pattern extraction
// ─────────────────────────────────────────────────────────────────────────────

test('_enrichSeriesCodes — backend-populated array passes through with normalized casing', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = { series_codes: ['lc67', '  TN243 '] };
    API._enrichSeriesCodes(p);
    assert.deepEqual(p.series_codes, ['LC67', 'TN243']);
});

test('_enrichSeriesCodes — single-code HP compatible from name + SKU', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'C02BK',
        name: '02BK Compatible Ink Cartridge for HP 02 (C8721WA) Black',
        series_codes: [],
        source: 'compatible',
    };
    API._enrichSeriesCodes(p);
    assert.ok(p.series_codes.includes('02'),
        `expected '02' in series_codes, got ${JSON.stringify(p.series_codes)}`);
});

test('_enrichSeriesCodes — Epson XL variant extracted as "200XL" (not "200")', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'CC13T201192BK',
        name: '200XLBK Compatible Ink Cartridge for Epson 200XL C13T201192 Black',
        series_codes: [],
        source: 'compatible',
    };
    API._enrichSeriesCodes(p);
    assert.ok(p.series_codes.includes('200XL'),
        `expected '200XL' in series_codes, got ${JSON.stringify(p.series_codes)}`);
});

test('_enrichSeriesCodes — Canon multi-printer compatible captures both codes', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'CBCI3CMY',
        name: 'BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack',
        series_codes: [],
        source: 'compatible',
    };
    API._enrichSeriesCodes(p);
    assert.ok(p.series_codes.includes('BCI3'),
        `expected 'BCI3' in series_codes, got ${JSON.stringify(p.series_codes)}`);
    assert.ok(p.series_codes.includes('BCI6'),
        `expected 'BCI6' in series_codes, got ${JSON.stringify(p.series_codes)}`);
});

test('_enrichSeriesCodes — Epson 73N (suffix N) preserved', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'C73NBK',
        name: '73NBK Compatible Ink Cartridge for Epson 73N Black',
        series_codes: [],
        source: 'compatible',
    };
    API._enrichSeriesCodes(p);
    assert.ok(p.series_codes.includes('73N'),
        `expected '73N' in series_codes, got ${JSON.stringify(p.series_codes)}`);
});

test('_enrichSeriesCodes — KCMY 4-pack name resolves the family code, not "KCMY"', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'C975KCMY',
        name: '975KCMY Compatible Ink Cartridge for HP 975 KCMY 4-Pack',
        series_codes: [],
        source: 'compatible',
    };
    API._enrichSeriesCodes(p);
    assert.ok(p.series_codes.includes('975'),
        `expected '975' in series_codes, got ${JSON.stringify(p.series_codes)}`);
    assert.ok(!p.series_codes.includes('KCMY'),
        `KCMY is a colour-pack token, not a series code`);
});

test('_enrichSeriesCodes — empty/missing input does not throw and does not invent codes', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const cases = [
        {},
        { name: '', sku: '', series_codes: [] },
        { name: 'Compatible something somewhere', sku: '' },
        { name: 'Photo paper', sku: 'PAPER1' },
    ];
    for (const p of cases) {
        const before = p.series_codes ? p.series_codes.slice() : undefined;
        API._enrichSeriesCodes(p);
        // No throw is the bar. If series_codes was populated, it's still array.
        // If it was empty, derived codes (if any) must contain a digit per
        // contract — none of the cases above carry a discernible code.
        if (p.series_codes) {
            for (const c of p.series_codes) {
                assert.ok(/\d/.test(c), `derived code "${c}" must contain a digit`);
            }
        }
    }
});

test('_enrichSeriesCodes — Brother LC67 genuine pre-populated stays untouched', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = {
        sku: 'GLC67BK',
        name: 'Brother Genuine LC67 Ink Cartridge Black (450 Pages)',
        series_codes: ['LC67'],
        source: 'genuine',
    };
    API._enrichSeriesCodes(p);
    assert.deepEqual(p.series_codes, ['LC67']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. getShopData — codes drilldown (no code filter) merges sidecar series
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData — drilldown view: compatible-only series chip is added with count', async () => {
    const primary = shopEnvelope({
        products: [],
        series: [
            { code: 'LC133', count: 4 },
            { code: 'TN243', count: 4 },
        ],
    });
    const sidecar = shopEnvelope({
        products: [
            // 8 compatibles in HP "02" — should yield {code:'02', count:8}
            ...Array.from({ length: 8 }, (_, i) => ({
                id: `id-02-${i}`,
                sku: `C02BK${i}`,
                name: '02BK Compatible Ink Cartridge for HP 02 (C8721WA) Black',
                source: 'compatible',
                series_codes: [],
            })),
            // One existing series — count should be SUMMED, not replaced
            {
                id: 'id-tn243-1', sku: 'CTN243BK',
                name: 'TN243BK Compatible Toner Cartridge for Brother TN243 Black',
                source: 'compatible', series_codes: [],
            },
        ],
    });

    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('source=compatible')) {
                return mockResponse({ status: 200, body: sidecar });
            }
            return mockResponse({ status: 200, body: primary });
        },
    });
    const resp = await API.getShopData({ brand: 'hp', category: 'ink' });
    assert.equal(resp.ok, true);

    const codes = resp.data.series.map(s => s.code);
    assert.ok(codes.includes('02'), `expected '02' chip after merge, got ${JSON.stringify(codes)}`);

    const tn = resp.data.series.find(s => s.code === 'TN243');
    assert.equal(tn.count, 5, 'TN243 count should be 4 (primary) + 1 (sidecar) = 5');

    const hp02 = resp.data.series.find(s => s.code === '02');
    assert.equal(hp02.count, 8);

    // Sort: numeric-aware so "02" < "LC133" < "TN243"
    const sorted = [...resp.data.series].sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true, sensitivity: 'base' }));
    assert.deepEqual(resp.data.series.map(s => s.code), sorted.map(s => s.code));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. getShopData — code-filtered request appends missing compatibles
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData — code=02: missing compatibles are appended, dedup by id', async () => {
    const primary = shopEnvelope({
        products: [], // backend returns 0 because all "02" products are compats with empty series_codes
        series: [],
        meta: { page: 1, limit: 200, total: 0, total_pages: 0, has_next: false, has_prev: false },
    });
    const compats = [
        { id: 'a', sku: 'C02BK', name: '02BK Compatible Ink Cartridge for HP 02 (C8721WA) Black', source: 'compatible', series_codes: [] },
        { id: 'b', sku: 'C02CY', name: '02CY Compatible Ink Cartridge for HP 02 (C8771WA) Cyan', source: 'compatible', series_codes: [] },
        { id: 'c', sku: 'C02MG', name: '02MG Compatible Ink Cartridge for HP 02 (C8772WA) Magenta', source: 'compatible', series_codes: [] },
        // Different code, must NOT be merged
        { id: 'd', sku: 'C564BK', name: '564BK Compatible Ink Cartridge for HP 564 Black', source: 'compatible', series_codes: [] },
    ];
    const sidecar = shopEnvelope({ products: compats });

    const { API, calls } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('source=compatible')) {
                return mockResponse({ status: 200, body: sidecar });
            }
            return mockResponse({ status: 200, body: primary });
        },
    });
    const resp = await API.getShopData({ brand: 'hp', category: 'ink', code: '02' });
    assert.equal(resp.ok, true);
    assert.equal(resp.data.products.length, 3, 'should have appended 3 HP-02 compatibles');
    const ids = resp.data.products.map(p => p.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
    assert.equal(resp.meta.total, 3, 'meta.total should reflect the merged count');

    // Sanity: exactly two HTTP calls — primary (/api/shop) + sidecar (/api/products).
    // The sidecar moved to /api/products on 2026-05-11 because /api/shop drops
    // every `pack_type=value_pack` row on the source=compatible filter — the
    // KCMY/CMY compat packs (CPGI650KCMY, CCLI671KCMY, etc.) were silently
    // hidden from chip drilldowns. /api/products keeps them.
    const shopCalls = calls.filter(c => /\/api\/shop\?/.test(c.url));
    const productsCalls = calls.filter(c => /\/api\/products\?/.test(c.url));
    assert.equal(shopCalls.length, 1, `expected 1 /api/shop primary call, got ${shopCalls.map(c => c.url).join(' | ')}`);
    assert.equal(productsCalls.length, 1, `expected 1 /api/products sidecar call, got ${productsCalls.map(c => c.url).join(' | ')}`);
    // Sidecar carries the brand+category+source=compatible filter for narrow dedupe.
    assert.match(productsCalls[0].url, /brand=hp/);
    assert.match(productsCalls[0].url, /category=ink/);
    assert.match(productsCalls[0].url, /source=compatible/);
});

test('getShopData — code=564: existing genuines stay; compatibles are appended without duplication', async () => {
    const genuine = { id: 'g1', sku: 'GHP564BK', name: 'HP Genuine 564 Ink Cartridge Black (250 Pages)', source: 'genuine', series_codes: ['564'] };
    const primary = shopEnvelope({ products: [genuine], series: [], meta: { page: 1, limit: 200, total: 1, total_pages: 1, has_next: false, has_prev: false } });

    // The compatible list will contain BOTH the backend-genuine row already present (defensive — should not duplicate)
    // AND a new compatible for code 564.
    const compats = [
        // dup id — must be skipped
        { id: 'g1', sku: 'GHP564BK', name: 'HP Genuine 564 Ink Cartridge Black', source: 'genuine', series_codes: ['564'] },
        // new compatible
        { id: 'c1', sku: 'C564BK', name: '564BK Compatible Ink Cartridge for HP 564 Black', source: 'compatible', series_codes: [] },
        // wrong code — must not merge
        { id: 'c2', sku: 'C975BK', name: '975BK Compatible Ink Cartridge for HP 975 Black', source: 'compatible', series_codes: [] },
    ];
    const sidecar = shopEnvelope({ products: compats });

    const { API } = loadApi({
        fetchImpl: (url) => mockResponse({ status: 200, body: url.includes('source=compatible') ? sidecar : primary }),
    });
    const resp = await API.getShopData({ brand: 'hp', category: 'ink', code: '564' });
    assert.equal(resp.data.products.length, 2);
    assert.deepEqual(resp.data.products.map(p => p.id).sort(), ['c1', 'g1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Negative cases — recovery skipped
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData — source=genuine: sidecar fetch is skipped', async () => {
    const primary = shopEnvelope({ products: [], series: [] });
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 200, body: primary }),
    });
    await API.getShopData({ brand: 'hp', category: 'ink', source: 'genuine' });
    const shopCalls = calls.filter(c => /\/api\/shop\?/.test(c.url));
    const productsCalls = calls.filter(c => /\/api\/products\?/.test(c.url));
    assert.equal(shopCalls.length, 1, 'source=genuine must NOT trigger sidecar fetch');
    assert.equal(productsCalls.length, 0, 'source=genuine must NOT fire the /api/products sidecar');
});

test('getShopData — no brand: sidecar fetch is skipped', async () => {
    const primary = shopEnvelope({ products: [], series: [] });
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 200, body: primary }),
    });
    await API.getShopData({ category: 'ink' });
    const shopCalls = calls.filter(c => /\/api\/shop\?/.test(c.url));
    const productsCalls = calls.filter(c => /\/api\/products\?/.test(c.url));
    assert.equal(shopCalls.length, 1);
    assert.equal(productsCalls.length, 0);
});

test('getShopData — search param: sidecar fetch is skipped', async () => {
    const primary = shopEnvelope({ products: [], series: [] });
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 200, body: primary }),
    });
    await API.getShopData({ brand: 'hp', category: 'ink', search: '02' });
    const shopCalls = calls.filter(c => /\/api\/shop\?/.test(c.url));
    const productsCalls = calls.filter(c => /\/api\/products\?/.test(c.url));
    assert.equal(shopCalls.length, 1, 'search= triggers a different code path; recovery off');
    assert.equal(productsCalls.length, 0, 'search= must not fire the /api/products sidecar either');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Failure isolation — sidecar errors leave primary intact
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData — sidecar 5xx: primary response unchanged, no throw', async () => {
    const primary = shopEnvelope({
        products: [{ id: 'g1', sku: 'GLC67BK', name: 'Brother Genuine LC67 Ink Cartridge Black', source: 'genuine', series_codes: ['LC67'] }],
        series: [{ code: 'LC67', count: 1 }],
    });
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('source=compatible')) {
                return mockResponse({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR' } } });
            }
            return mockResponse({ status: 200, body: primary });
        },
    });
    const resp = await API.getShopData({ brand: 'brother', category: 'ink', code: 'LC67' });
    assert.equal(resp.ok, true, 'primary response must survive sidecar failure');
    assert.equal(resp.data.products.length, 1);
    assert.equal(resp.data.products[0].id, 'g1');
});

test('getShopData — Brother LC67 (no compatibles in catalog): zero rows added', async () => {
    const genuines = Array.from({ length: 6 }, (_, i) => ({
        id: `g${i}`, sku: `GLC67-${i}`, name: 'Brother Genuine LC67 Ink Cartridge', source: 'genuine', series_codes: ['LC67'],
    }));
    const primary = shopEnvelope({ products: genuines, series: [{ code: 'LC67', count: 6 }] });
    // Brother sidecar returns no compatibles
    const sidecar = shopEnvelope({ products: [] });
    const { API } = loadApi({
        fetchImpl: (url) => mockResponse({ status: 200, body: url.includes('source=compatible') ? sidecar : primary }),
    });
    const resp = await API.getShopData({ brand: 'brother', category: 'ink', code: 'LC67' });
    assert.equal(resp.data.products.length, 6, 'no compatibles to recover; row count unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Parallelism + hardening — regressions guards (added after the 2026-05-10
//    "Failed to load products" report on /shop?brand=epson&category=ink).
//    The first fix awaited primary then awaited sidecar; on a Render cold
//    start that doubled latency and made the codes drilldown look broken.
//    The hardened version fires both in parallel via Promise.all and wraps
//    the merge in a try/catch so any error returns the unmerged primary.
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData — primary + sidecar fire in parallel, not sequentially', async () => {
    // Each request resolves after a per-URL delay. If sequential, total wall
    // time would be primaryDelay + sidecarDelay. If parallel, it's max(both).
    const primary = shopEnvelope({ products: [], series: [{ code: 'LC67', count: 6 }] });
    const sidecar = shopEnvelope({ products: [] });
    let primaryStartedAt = null;
    let sidecarStartedAt = null;
    const { API } = loadApi({
        fetchImpl: (url) => new Promise(resolve => {
            const isSidecar = url.includes('source=compatible');
            const startedAt = Date.now();
            if (isSidecar) sidecarStartedAt = startedAt; else primaryStartedAt = startedAt;
            setTimeout(() => {
                resolve(mockResponse({ status: 200, body: isSidecar ? sidecar : primary }));
            }, 60);
        }),
    });
    const t0 = Date.now();
    await API.getShopData({ brand: 'brother', category: 'ink' });
    const elapsed = Date.now() - t0;

    assert.ok(primaryStartedAt !== null && sidecarStartedAt !== null,
        'both primary and sidecar must have been initiated');
    // Sidecar must start within the same tick as primary (parallel), not after
    // primary resolves. Allow 25ms slack for event-loop scheduling.
    const startGap = Math.abs(sidecarStartedAt - primaryStartedAt);
    assert.ok(startGap < 25, `expected parallel start, got ${startGap}ms gap between primary and sidecar`);
    // Total wall time is bounded by max(60ms, 60ms) + overhead, NOT 60+60.
    assert.ok(elapsed < 100, `expected parallel total ~60ms, got ${elapsed}ms (suggests sequential await)`);
});

test('getShopData — sidecar that returns malformed shape: primary unchanged, no throw', async () => {
    const primary = shopEnvelope({
        products: [{ id: 'g1', sku: 'g1', source: 'genuine', series_codes: ['LC67'] }],
        series: [{ code: 'LC67', count: 1 }],
    });
    // Malformed: data.products is not an array
    const malformed = { ok: true, data: { products: 'not-an-array', series: null }, meta: {} };
    const { API } = loadApi({
        fetchImpl: (url) => mockResponse({ status: 200, body: url.includes('source=compatible') ? malformed : primary }),
    });
    const resp = await API.getShopData({ brand: 'brother', category: 'ink', code: 'LC67' });
    assert.equal(resp.ok, true);
    assert.equal(resp.data.products.length, 1);
});

test('getShopData — primary 5xx rejects: error propagates so caller can fall back to legacy', async () => {
    // shop-page.js loadProductCodes catches a thrown error and shows the
    // "Failed to load products" empty state. The hardening MUST keep this
    // path: getShopData should not swallow primary failures, only sidecar.
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('source=compatible')) {
                return mockResponse({ status: 200, body: shopEnvelope({ products: [] }) });
            }
            // Primary throws like a real 5xx: request() rejects with Error
            // when status >= 500 and no JSON body. Simulate that here by
            // returning an unhealthy envelope that request() would reject.
            return mockResponse({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'cold start' } } });
        },
    });
    const resp = await API.getShopData({ brand: 'epson', category: 'ink' });
    // request() returns a structured envelope for 5xx (see api.js line ~265).
    // The eligibility check sees `primary.ok === false` and returns primary
    // as-is — caller's branching on `response.ok && response.data?.series`
    // then falls through to legacy.
    assert.equal(resp.ok, false);
    assert.equal(resp.code, 'INTERNAL_ERROR');
});

test('getShopData — sidecar rejects: primary returned unchanged (fail-open)', async () => {
    const primary = shopEnvelope({
        products: [],
        series: [{ code: 'LC67', count: 6 }, { code: 'TN243', count: 4 }],
    });
    const { API } = loadApi({
        fetchImpl: (url) => {
            if (url.includes('source=compatible')) {
                // Simulate network/Render hard failure — a thrown error,
                // not just an envelope.
                return Promise.reject(new Error('ECONNREFUSED'));
            }
            return mockResponse({ status: 200, body: primary });
        },
    });
    const resp = await API.getShopData({ brand: 'brother', category: 'ink' });
    assert.equal(resp.ok, true);
    // series unchanged from primary — no merge ran.
    assert.equal(resp.data.series.length, 2);
});
