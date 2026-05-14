/**
 * 1-char SKU canon — May 2026
 * ===========================
 *
 * Backend handoff (2026-05-12):
 *   "API contract — unchanged shape, but values flipped: product.sku values
 *    are shorter: GLC73M not GLC73MG. ... Pack SKUs/names (CMY/KCMY/CMYK/MK
 *    tokens) unchanged. ... If the FE has any client-side parsing of the
 *    compact SKU body — e.g. a regex like /([A-Z]{2})$/ to extract a color
 *    abbrev for display logic, swatch lookups, or anchor-link building — it
 *    would miss the new 1-char canon (C/M/Y)."
 *
 * `api.js#_enrichSeriesCodes` runs the COLOR_SUFFIX strip on compatibles that
 * arrive without `series_codes` (the sidecar fallback). Before the regex was
 * widened to include K/C/M/Y, every new-canon compatible (CLC73M, CHP564C,
 * G-BRO-LC73-INK-M, …) fell through stripSuffix unchanged — series_codes
 * became `LC73M` instead of `LC73`, and the chip-drilldown grouped them under
 * a phantom series.
 *
 * This file pins:
 *   §1  — Every new 1-char canon (K/C/M/Y) strips to the bare code body.
 *   §2  — Legacy 2-char canon (BK/CY/MG/YL) still strips (back-compat,
 *         legacy_sku rows + 301 redirects keep the old SKUs reachable).
 *   §3  — Specialty 2-char canon (PB/PC/PM/PY/MB/LC/LM/PBK/PCY/PMG/PYL/VLM)
 *         still strips — handoff only flipped basic CMYK.
 *   §4  — Pack tokens (CMY/KCMY/CMYK/BCMY/MK) strip as a unit so the 1-char
 *         alternation doesn't shred them (MK → "M" + stray K, etc.).
 *   §5  — XL high-yield bodies disambiguate: "200XLC" strips just "C" leaving
 *         "200XL"; "200LC" still strips "LC" leaving "200". This is the
 *         lookbehind contract — without (?<!X) we'd over-strip XL+Cyan SKUs.
 *   §6  — The full new-canon hyphenated SKU shape (C-BRO-LC73-INK-M) still
 *         routes through the name path, so series_codes resolve from the
 *         leading "LC73 Compatible …" token, not the messy SKU body.
 *
 * Run: node --test tests/sku-1char-canon-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');

function loadApi() {
    const sandbox = {
        console,
        fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return {}; }, async text() { return '{}'; } }),
        setTimeout, clearTimeout, AbortController,
        Headers: globalThis.Headers, URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol, RegExp,
        structuredClone: globalThis.structuredClone,
        Config: { API_URL: 'https://backend.test', SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon-key' },
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
    return sandbox.API;
}

// Helpers ────────────────────────────────────────────────────────────────────

function enrich(API, { sku = '', name = '' } = {}) {
    const p = { sku, name, series_codes: [] };
    API._enrichSeriesCodes(p);
    // _enrichSeriesCodes spreads a Set from inside the vm sandbox, so the
    // resulting array carries the inner-realm Array prototype. Re-wrap with
    // outer-realm Array.from so deepStrictEqual prototype checks succeed.
    return Array.from(p.series_codes || []);
}

// ─── §1  New 1-char canon (K/C/M/Y) strips cleanly ──────────────────────────

test('§1 — CLC73M (new Magenta) strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73M', name: 'LC73M Compatible Ink Cartridge for Brother LC73 Magenta' }), ['LC73']);
});

test('§1 — CLC73C (new Cyan) strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73C', name: 'LC73C Compatible Ink Cartridge for Brother LC73 Cyan' }), ['LC73']);
});

test('§1 — CLC73Y (new Yellow) strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73Y', name: 'LC73Y Compatible Ink Cartridge for Brother LC73 Yellow' }), ['LC73']);
});

test('§1 — CLC73K (new Black) strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73K', name: 'LC73K Compatible Ink Cartridge for Brother LC73 Black' }), ['LC73']);
});

test('§1 — name-only new-canon lead word (no skuMatch path)', () => {
    const API = loadApi();
    // sku doesn't start with "C" so the skuMatch branch is skipped; we rely on
    // the lead-word path to derive the code.
    assert.deepEqual(enrich(API, { sku: 'GLC73M', name: 'LC73M Genuine Ink Cartridge for Brother LC73 Magenta' }), ['LC73']);
});

// ─── §2  Legacy 2-char canon still strips (back-compat) ─────────────────────

test('§2 — legacy CLC73MG still strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73MG', name: 'LC73MG Compatible Ink Cartridge for Brother LC73 Magenta' }), ['LC73']);
});

test('§2 — legacy CLC73BK still strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73BK', name: 'LC73BK Compatible Ink Cartridge for Brother LC73 Black' }), ['LC73']);
});

test('§2 — legacy CLC73YL still strips to LC73', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73YL', name: 'LC73YL Compatible Ink Cartridge for Brother LC73 Yellow' }), ['LC73']);
});

// ─── §3  Specialty colors (handoff didn't flip these) ───────────────────────
//
// Real catalog names mix the bare code with the hyphenated brand form
// ("CLI651PB ... for Canon CLI-651 Photo Black"). The "for <brand> <code>"
// pattern adds CLI-651 alongside the CLI651 from the lead word; both are
// valid derived codes that downstream chip-merging tolerates. Assert
// membership of the bare code rather than strict array equality.

test('§3 — Canon CLI651PB (Photo Black specialty) strips to CLI651', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'CCLI651PB', name: 'CLI651PB Compatible Ink Cartridge for Canon CLI-651 Photo Black' });
    assert.ok(codes.includes('CLI651'), `expected CLI651 in ${JSON.stringify(codes)}`);
});

test('§3 — Light Cyan (LC after a digit, not XL) strips to bare code', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'CT0851LC', name: 'T0851LC Compatible Ink Cartridge for Epson T0851 Light Cyan' });
    assert.ok(codes.includes('T0851'), `expected T0851 in ${JSON.stringify(codes)}`);
});

test('§3 — Light Magenta (LM after a digit, not XL) strips to bare code', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'CT0851LM', name: 'T0851LM Compatible Ink Cartridge for Epson T0851 Light Magenta' });
    assert.ok(codes.includes('T0851'), `expected T0851 in ${JSON.stringify(codes)}`);
});

test('§3 — PMG (Photo Magenta 3-char) strips to bare code', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'CCLI8PMG', name: 'CLI8PMG Compatible Ink Cartridge for Canon CLI-8 Photo Magenta' });
    assert.ok(codes.includes('CLI8'), `expected CLI8 in ${JSON.stringify(codes)}`);
});

// ─── §4  Pack tokens still strip as a unit ──────────────────────────────────

test('§4 — CMY 3-pack strips to bare code (not to "M" via 1-char canon)', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73CMY', name: 'LC73CMY Compatible Ink Cartridge 3-Pack for Brother LC73 CMY' }), ['LC73']);
});

test('§4 — KCMY 4-pack strips to bare code', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73KCMY', name: 'LC73KCMY Compatible Ink Cartridge 4-Pack for Brother LC73 KCMY' }), ['LC73']);
});

test('§4 — CMYK 4-pack strips to bare code', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CT5K0CMYK', name: 'T5K0CMYK Compatible Ink Cartridge 4-Pack for Epson T5K0 CMYK' }), ['T5K0']);
});

test('§4 — BCMY 4-pack strips to bare code', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'CLC73BCMY', name: 'LC73BCMY Compatible Ink Cartridge 4-Pack for Brother LC73 BCMY' }), ['LC73']);
});

test('§4 — MK pack token strips as a unit, not shredded to M+K', () => {
    const API = loadApi();
    // MK is mentioned in the handoff as an unchanged pack token. We must NOT
    // strip the trailing K via the new 1-char canon and leave a stray "M".
    assert.deepEqual(enrich(API, { sku: 'CLC73MK', name: 'LC73MK Compatible Ink Cartridge for Brother LC73 MK' }), ['LC73']);
});

// ─── §5  XL high-yield disambiguation (lookbehind contract) ─────────────────

test('§5 — 200XLC (XL + new Cyan canon) strips just C, leaves 200XL', () => {
    const API = loadApi();
    // Without (?<!X)LC the regex would greedily strip "LC" and produce 200X.
    assert.deepEqual(enrich(API, { sku: 'C200XLC', name: '200XLC Compatible Ink Cartridge for Epson 200XL Cyan' }), ['200XL']);
});

test('§5 — 200XLM (XL + new Magenta canon) strips just M, leaves 200XL', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'C200XLM', name: '200XLM Compatible Ink Cartridge for Epson 200XL Magenta' }), ['200XL']);
});

test('§5 — 200XLCY (legacy XL + Cyan) still strips to 200XL', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'C200XLCY', name: '200XLCY Compatible Ink Cartridge for Epson 200XL Cyan' }), ['200XL']);
});

test('§5 — bare 200LC (digit + LC specialty) strips LC, leaves 200', () => {
    const API = loadApi();
    // No X before LC — char before LC is "0" (digit) — strips LC as Light Cyan.
    assert.deepEqual(enrich(API, { sku: 'C200LC', name: '200LC Compatible Ink Cartridge for Epson 200 Light Cyan' }), ['200']);
});

test('§5 — 200XLK (XL + new Black canon) strips just K, leaves 200XL', () => {
    const API = loadApi();
    assert.deepEqual(enrich(API, { sku: 'C200XLK', name: '200XLK Compatible Ink Cartridge for Epson 200XL Black' }), ['200XL']);
});

// ─── §6  Full hyphenated new-canon SKU shape ────────────────────────────────
//
// Production catalog SKUs are hyphenated (C-BRO-LC73-INK-M). The skuMatch
// branch in _enrichSeriesCodes captures the body after the leading "C" and
// runs stripSuffix on it, which leaves a noisy "-BRO-LC73-INK-" alongside the
// clean "LC73" derived from the name lead-word. The noisy code is harmless
// downstream (no real chip matches it), so we assert *membership* of the
// good code rather than strict-equal the whole array. This holds for both
// legacy (-MG/-BK/-CY/-YL) and new-canon (-M/-K/-C/-Y) hyphenated SKUs.

test('§6 — C-BRO-LC73-INK-M (new hyphenated SKU) derives LC73 from the name lead word', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'C-BRO-LC73-INK-M', name: 'LC73 Compatible Ink Cartridge for Brother LC73 Magenta' });
    assert.ok(codes.includes('LC73'), `expected LC73 in ${JSON.stringify(codes)}`);
});

test('§6 — G-BRO-LC233-INK-K (new hyphenated genuine SKU, missing series_codes) still resolves via name lead', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'G-BRO-LC233-INK-K', name: 'LC233 Genuine Ink Cartridge for Brother LC233 Black' });
    assert.ok(codes.includes('LC233'), `expected LC233 in ${JSON.stringify(codes)}`);
});

test('§6 — legacy C-BRO-LC233-INK-BK still derives LC233 (parity with new canon)', () => {
    const API = loadApi();
    const codes = enrich(API, { sku: 'C-BRO-LC233-INK-BK', name: 'LC233 Compatible Ink Cartridge for Brother LC233 Black' });
    assert.ok(codes.includes('LC233'), `expected LC233 in ${JSON.stringify(codes)}`);
});
