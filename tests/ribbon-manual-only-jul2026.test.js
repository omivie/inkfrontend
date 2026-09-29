/**
 * Ribbons are fully owner-manual — content auto-fills retired (ERR-086)
 * ====================================================================
 *
 * Owner directive: "ribbons shouldn't be automated at all for any aspect except
 * page design" (and searchability stays automated). So a ribbon's PAGE shows
 * only what the owner entered; layout/sort/routing/search stay automatic.
 *
 * Two content auto-fills were killed for ribbons:
 *
 *   1. For Use In — product-detail-page.js renderCompatiblePrinters no longer
 *      falls through to the Supabase product_compatibility fetch for a ribbon:
 *      with no admin-written compatible_devices_html it renders NOTHING.
 *
 *   2. Product Codes — a ribbon carries ONLY explicitly-assigned codes:
 *        • admin picker deriveSeed returns [] for ribbon types (no machine
 *          pre-tick);
 *        • storefront _applyManualCodes clears a ribbon's series_codes when it
 *          has no override (never a backend-derived fallback);
 *        • the PDP does the same on load.
 *
 * Related products were already made manual (ERR-085). Search indexing, SEO,
 * and /ribbons sort/group/routing are intentionally KEPT automatic.
 *
 * Run: node --test tests/ribbon-manual-only-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const API_SRC = read('inkcartridges/js/api.js');
const PDP = stripComments(read('inkcartridges/js/product-detail-page.js'));
const PRODUCTS = stripComments(read('inkcartridges/js/admin/pages/products.js'));

// ── vm harness for the storefront API (mirrors search-results-parity) ───────
function loadApi() {
  const sandbox = {
    console,
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }),
    setTimeout, clearTimeout, AbortController,
    Headers: globalThis.Headers, URL, URLSearchParams, encodeURIComponent,
    Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol,
    Config: {
      API_URL: 'https://backend.test', SUPABASE_URL: 'https://supabase.test', SUPABASE_ANON_KEY: 'anon',
      settings: { FREE_SHIPPING_THRESHOLD: 100, GST_RATE: 0.15 },
      getSetting(k, f) { return this.settings[k] != null ? this.settings[k] : f; },
    },
    DebugLog: { log() {}, warn() {}, error() {} },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    document: { cookie: '' },
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(API_SRC, vm.createContext(sandbox), { filename: 'api.js' });
  return sandbox.API;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. the override-only rule is the BACKEND's (ERR-294); the whole storefront
//    manual-code layer is gone since ERR-299 — _finalizeShopData is the hook
//
// Until 2026-09-28 the storefront read product_codes and cleared a ribbon's
// backend-derived codes itself. The backend now applies the rule on every
// endpoint (BF-085): a ribbon carries only its override, else `series_codes: []`
// (measured: 691.01 and 72200.01 → [], C-OKI-720-RIB-BK → ["720"]). So the
// storefront passes series_codes through UNTOUCHED — a second, client-side
// opinion could only disagree with the server. probe:backend-move §R re-measures
// the rule live, every ribbon row.
// ═══════════════════════════════════════════════════════════════════════════
async function applyWith(products) {
  const API = loadApi();
  const primary = { ok: true, data: { products, series: [] } };
  const out = await API._finalizeShopData(primary, {});
  // No reader exists that COULD read product_codes (ERR-299).
  const reads = ['_applyManualCodes', '_supabaseSelect', '_fetchManualChipCounts'].filter((m) => API[m] !== undefined).length;
  return { products: out.data.products, reads };
}

test('ribbon series_codes pass through untouched — the backend already applied the rule', async () => {
  const { products, reads } = await applyWith([
    { id: 'a', product_type: 'printer_ribbon', series_codes: [] },
    { id: 'b', product_type: 'typewriter_ribbon', series_codes: ['720'] },
    { id: 'c', product_type: 'correction_tape', series_codes: [] },
  ]);
  assert.deepEqual(products.map((p) => [...p.series_codes]), [[], ['720'], []]);
  assert.equal(reads, 0, 'no product_codes reader exists any more');
});

test('a NON-ribbon keeps its backend codes (unchanged)', async () => {
  const { products: [ink] } = await applyWith([
    { id: 'i1', product_type: 'ink_cartridge', series_codes: ['LC40'] },
  ]);
  assert.deepEqual([...ink.series_codes], ['LC40']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. For Use In — PDP never auto-derives a printer list for a ribbon
// ═══════════════════════════════════════════════════════════════════════════
test('renderCompatiblePrinters short-circuits for ribbons BEFORE the Supabase fallback', () => {
  const start = PDP.indexOf('async renderCompatiblePrinters(info)');
  const end = PDP.indexOf('_fetchPrinters(info.sku)', start);
  assert.ok(start !== -1 && end !== -1, 'the function and its fallback must exist');
  const preFallback = PDP.slice(start, end);
  assert.match(preFallback, /if \(info\.category === 'ribbon'\) return;/,
    'a ribbon must return before the _fetchPrinters product_compatibility fallback');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Product Codes — ribbons carry only owner-assigned codes
// ═══════════════════════════════════════════════════════════════════════════
test('the PDP takes a ribbon\'s series_codes from the response (backend applies ERR-086 since BF-085)', () => {
  assert.doesNotMatch(PDP, /getManualProductCodes|isRibbonRow/,
    'no PDP-side override read: the ribbon endpoint already sends override-or-[]');
});

test('the admin picker deriveSeed returns [] for ribbon types (no machine pre-tick)', () => {
  const start = PRODUCTS.indexOf('const deriveSeed = () =>');
  const body = PRODUCTS.slice(start, start + 700);
  assert.match(body, /if \(RIBBON_PRODUCT_TYPES\.includes\(full\.product_type\)\) return \[\];/,
    'ribbons must seed empty rather than pre-tick backend/heuristic codes');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Boundary: search / SEO / page-design stay automated (guard the intent)
// ═══════════════════════════════════════════════════════════════════════════
test('the ribbon guard governs DISPLAY only — the non-ribbon compat fallback is intact', () => {
  // The _fetchPrinters fallback still exists (for non-ribbons); we only gated ribbons.
  assert.match(PDP, /_fetchPrinters\(info\.sku\)/, 'non-ribbon compat auto-fill must remain');
});
