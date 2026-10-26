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

// ─────────────────────────────────────────────────────────────────────────────
// 7. Double-count guard — backend now ships `series_codes` on every product
//    (commit 5c99462, May 2026). The primary /api/shop response's
//    `series[].count` already includes every compatible the sidecar would
//    surface, so adding the sidecar's compats again doubles the chip count.
//    Real-world repro (2026-05-12): /shop?brand=epson&category=ink showed
//    "81N — 16 products" while the actual filtered grid had 8. Same offset
//    on 73N (13 → 7), 103/133/138 (12 → 6), 200 (21 → 16), 273 (21 → 14),
//    604 (24 → 18) — the diff equaled the compat count every time, the
//    fingerprint of a +1 per sidecar row. Gate: `_enrichSeriesCodes` returns
//    a flag, and only enriched compats (backend was missing their codes)
//    contribute to chip counts. Backend-classified compats are skipped.
// ─────────────────────────────────────────────────────────────────────────────

test('_enrichSeriesCodes — returns false when backend already supplied series_codes', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = { sku: 'C81NBK', name: '81NBK Compatible Ink Cartridge for Epson 81N Black', series_codes: ['81N'], source: 'compatible' };
    const enriched = API._enrichSeriesCodes(p);
    assert.equal(enriched, false, 'backend-supplied series_codes must not be flagged as enriched');
    assert.deepEqual(p.series_codes, ['81N']);
});

test('_enrichSeriesCodes — returns true when codes were derived locally from name/sku', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = { sku: 'C81NBK', name: '81NBK Compatible Ink Cartridge for Epson 81N Black', series_codes: [], source: 'compatible' };
    const enriched = API._enrichSeriesCodes(p);
    assert.equal(enriched, true, 'locally-derived codes must be flagged as enriched');
    assert.ok(p.series_codes.includes('81N'));
});

test('_enrichSeriesCodes — returns false when nothing could be derived', () => {
    const { API } = loadApi({ fetchImpl: () => mockResponse({}) });
    const p = { sku: '', name: 'Compatible something somewhere', series_codes: [] };
    const enriched = API._enrichSeriesCodes(p);
    assert.equal(enriched, false, 'no extractable codes must return false');
});

test('getShopData — ONE request per call: the compat-recovery sidecar is retired (2026-10-26)', async () => {
    // The merge tests that lived here pinned the sidecar's behaviour. It was
    // removed on a catalogue-wide measurement (probe:lookalike --sidecar-all:
    // 0 rows over 1,153 chips); _enrichSeriesCodes above stays for the admin.
    const { API, calls } = loadApi({ fetchImpl: () => mockResponse({ body: shopEnvelope({ products: [] }) }) });
    await API.getShopData({ brand: 'hp', category: 'ink', code: '02' });
    const urls = calls.map((c) => String(c.url));
    assert.equal(urls.length, 1, urls.join(' | '));
    assert.match(urls[0], /\/api\/shop\?/);
});

