/**
 * Product Codes — manual /shop categorisation codes (May 2026)
 * ============================================================
 *
 * A product is categorised brand > type > CODE. The /shop drilldown groups
 * products into "code" chips (Brother › Ink › LC40). Until now those codes
 * were derived only — the backend extracts `series_codes` from each product's
 * name/SKU/part-number at query time, with no way for an admin to correct or
 * extend them.
 *
 * This feature adds a MANUAL OVERRIDE layer:
 *
 *   • Supabase `product_codes` table  — one row per (product, code).
 *   • Admin product drawer → For Use In → "Product Codes" picker — assigns
 *     codes, pre-filled from the product's current codes.
 *   • Customer /shop honours the table: a product tagged LC40 + LC57 shows
 *     under BOTH chips; a purely-manual code gets its own chip.
 *
 * SEMANTICS — "manual fully replaces auto": a product with any product_codes
 * rows has its derived series_codes fully overridden on the storefront; a
 * product with none is untouched (the table is a pure override layer).
 *
 * This suite pins:
 *   1. the SQL migration shape (table, constraint, RLS, views)
 *   2. the AdminAPI surface (getProductCodes / setProductCodes / getCodeCatalogue)
 *   3. the admin drawer shell + save wiring
 *   4. wireProductCodesSection behaviour (seed, edit, save-diff gate)
 *   5. api.js _applyManualCodes — override, chip injection, code recovery
 *   6. the getShopData integration is fail-open
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SQL_SRC      = READ('inkcartridges/sql/product_codes.sql');
const ADMIN_API    = READ('inkcartridges/js/admin/api.js');
const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const APP_SRC      = READ('inkcartridges/js/admin/app.js');
const CSS_SRC      = READ('inkcartridges/css/admin.css');
const API_JS       = path.join(ROOT, 'inkcartridges/js/api.js');
const API_SRC      = fs.readFileSync(API_JS, 'utf8');

// Extract a top-level function body by brace matching.
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// api.js runs inside a vm realm, so objects it produces have a foreign
// prototype that deepStrictEqual rejects. plain() re-homes a value into this
// realm for comparison.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ─────────────────────────────────────────────────────────────────────────────
// 1. SQL migration — sql/product_codes.sql
// ─────────────────────────────────────────────────────────────────────────────

test('SQL: product_codes table — (product_id, code) PK, cascade delete', () => {
  assert.match(SQL_SRC, /create table if not exists public\.product_codes/);
  assert.match(SQL_SRC, /product_id\s+uuid\s+not null\s+references public\.products \(id\) on delete cascade/);
  assert.match(SQL_SRC, /primary key \(product_id, code\)/);
});

test('SQL: CHECK constraint enforces normalised UPPERCASE alphanumeric codes', () => {
  assert.match(SQL_SRC, /constraint product_codes_code_format/);
  assert.match(SQL_SRC, /code = upper\(code\)/);
  assert.match(SQL_SRC, /code ~ '\^\[A-Z0-9\]\{2,24\}\$'/);
});

test('SQL: a reverse index on code backs the ?code= recovery + chip views', () => {
  assert.match(SQL_SRC, /create index if not exists product_codes_code_idx on public\.product_codes \(code\)/);
});

test('SQL: RLS — public read, authenticated-only writes, no UPDATE', () => {
  assert.match(SQL_SRC, /alter table public\.product_codes enable row level security/);
  assert.match(SQL_SRC, /for select using \(true\)/);
  assert.match(SQL_SRC, /for insert to authenticated/);
  assert.match(SQL_SRC, /for delete to authenticated/);
  assert.doesNotMatch(SQL_SRC, /for update/, 'codes are insert/delete only — no UPDATE policy');
  assert.match(SQL_SRC, /grant select\s+on public\.product_codes to anon, authenticated/);
  assert.match(SQL_SRC, /grant insert, delete\s+on public\.product_codes to authenticated/);
});

test('SQL: product_code_catalogue view — distinct code + product_count', () => {
  assert.match(SQL_SRC, /create or replace view public\.product_code_catalogue as/);
  assert.match(SQL_SRC, /count\(distinct product_id\)::int as product_count/);
  assert.match(SQL_SRC, /grant select on public\.product_code_catalogue\s+to anon, authenticated/);
});

test('SQL: product_code_chip_counts view — keyed by brand slug + product_type', () => {
  assert.match(SQL_SRC, /create or replace view public\.product_code_chip_counts as/);
  assert.match(SQL_SRC, /b\.slug\s+as brand_slug/);
  assert.match(SQL_SRC, /p\.product_type/);
  assert.match(SQL_SRC, /join public\.products p on p\.id = pc\.product_id and p\.is_active = true/);
  assert.match(SQL_SRC, /join public\.brands\s+b on b\.id = p\.brand_id/);
  assert.match(SQL_SRC, /grant select on public\.product_code_chip_counts to anon, authenticated/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AdminAPI — admin/api.js
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI exposes every product-code method the picker depends on', () => {
  for (const m of ['getProductCodes', 'setProductCodes', 'getCodeCatalogue', 'normalizeProductCode']) {
    assert.match(ADMIN_API, new RegExp(`\\b${m}\\b`), `AdminAPI.${m} must exist`);
  }
});

test('AdminAPI.setProductCodes replaces the set (delete-then-insert) on product_codes', () => {
  const fn = extractFunction(ADMIN_API, 'async setProductCodes(');
  assert.match(fn, /from\('product_codes'\)[\s\S]*\.delete\(\)\.eq\('product_id', productId\)/);
  assert.match(fn, /from\('product_codes'\)\.insert\(rows\)/);
  // Codes are normalised + de-duped before they can reach the DB constraint.
  assert.match(fn, /normalizeProductCode/);
  assert.match(fn, /new Set\(/);
});

test('AdminAPI.getProductCodes / getCodeCatalogue read the right relations', () => {
  assert.match(extractFunction(ADMIN_API, 'async getProductCodes('), /from\('product_codes'\)/);
  assert.match(extractFunction(ADMIN_API, 'async getCodeCatalogue('), /from\('product_code_catalogue'\)/);
});

test('AdminAPI.normalizeProductCode uppercases and strips non-alphanumerics', () => {
  const fn = extractFunction(ADMIN_API, 'normalizeProductCode(');
  assert.match(fn, /toUpperCase\(\)/);
  assert.match(fn, /replace\(\/\[\^A-Z0-9\]\/g, ''\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Admin drawer shell + wiring — admin/pages/products.js
// ─────────────────────────────────────────────────────────────────────────────

test('drawer emits the Product Codes shell — chips, picker, toggle, panel, search, list', () => {
  for (const id of ['product-codes-group', 'product-codes-chips', 'product-codes-count',
                     'code-picker', 'code-toggle', 'code-toggle-label',
                     'code-panel', 'code-search', 'code-list']) {
    assert.match(PRODUCTS_SRC, new RegExp(`id="${id}"`), `#${id} must be in the shell`);
  }
});

test('Product Codes section is emitted for EVERY product type (not gated on isManualCompat)', () => {
  // The codes shell must be appended unconditionally, before the ribbon-brands
  // block which alone is `if (isManualCompat)`-gated.
  const codesAt  = PRODUCTS_SRC.indexOf('id="product-codes-group"');
  const ribbonIf = PRODUCTS_SRC.indexOf('if (isManualCompat) {');
  assert.ok(codesAt !== -1 && ribbonIf !== -1);
  assert.ok(codesAt < ribbonIf, 'codes shell is appended before the ribbon-only block');
  // The forUseInHtml += for codes must not sit inside an isManualCompat guard.
  const block = PRODUCTS_SRC.slice(PRODUCTS_SRC.indexOf('Product Codes — the /shop'), codesAt);
  assert.doesNotMatch(block, /isManualCompat/, 'codes section is unconditional');
});

test('wireProductCodesSection is invoked from openProductDrawer', () => {
  assert.match(PRODUCTS_SRC, /wireProductCodesSection\(modal, full\)/);
});

test('save handler persists codes — gated on the load flag AND a baseline diff', () => {
  const save = PRODUCTS_SRC.slice(PRODUCTS_SRC.indexOf("data-action=\"save\""));
  assert.match(save, /modal\._productCodesLoaded/, 'guarded by the clean-load flag');
  assert.match(save, /modal\._productCodesBaseline/, 'diff-checked against the opened-with baseline');
  assert.match(save, /AdminAPI\.setProductCodes\(product\.id/, 'writes via setProductCodes');
});

test('APP_VERSION was bumped to the product-codes build', () => {
  assert.match(APP_SRC, /const APP_VERSION = '2026\.05\.18-product-codes'/);
});

test('admin.css styles the code chips + picker count', () => {
  assert.match(CSS_SRC, /\.admin-code-chip\s*\{/);
  assert.match(CSS_SRC, /\.admin-code-chip__remove/);
  assert.match(CSS_SRC, /\.admin-product-codes__optcount/);
  // The monospace rule must be scoped so it cannot bleed into the ribbon picker.
  assert.match(CSS_SRC, /#code-panel \.admin-brandpicker__optname/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. wireProductCodesSection — functional, against a minimal DOM
// ─────────────────────────────────────────────────────────────────────────────

function makeEl(id) {
  return {
    id, innerHTML: '', value: '', textContent: '', hidden: false,
    disabled: false, isConnected: true, _listeners: {}, _attrs: {},
    focus() {}, scrollIntoView() {},
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getAttribute(n) { return this._attrs[n]; },
    contains() { return false; },
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
    fire(t, e) { return Promise.all((this._listeners[t] || []).map(fn => fn(e))); },
  };
}

const CODE_IDS = ['product-codes-group', 'product-codes-chips', 'product-codes-count',
  'code-picker', 'code-toggle', 'code-toggle-label', 'code-panel', 'code-search', 'code-list'];

function makeModal(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  if (els['code-panel']) els['code-panel'].hidden = true;
  return {
    isConnected: true, _els: els,
    querySelector(sel) { return els[sel.replace(/^#/, '')] || null; },
  };
}

function makeToast() {
  const calls = [];
  return { calls, success: (m) => calls.push(['success', m]),
    error: (m) => calls.push(['error', m]), info: (m) => calls.push(['info', m]) };
}

function clickEvent(map) {
  return { target: { closest: (sel) => map[sel] || null }, preventDefault() {} };
}
function keyEvent(key, target) {
  return { key, target, preventDefault() {} };
}

// Build a runnable copy of wireProductCodesSection with its free globals injected.
function loadWire() {
  const src = extractFunction(PRODUCTS_SRC, 'async function wireProductCodesSection(');
  const factory = new Function('AdminAPI', 'Toast', 'esc', 'DebugLog', 'window',
    `${src}; return wireProductCodesSection;`);
  return (deps) => factory(deps.AdminAPI, deps.Toast || makeToast(), esc,
    deps.DebugLog || { warn() {} }, deps.window || {});
}

test('seed: a product with no saved codes is pre-filled from backend series_codes', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getCodeCatalogue: async () => ([{ code: 'LC40', product_count: 3 }]),
    getProductCodes: async () => [],
  };
  await loadWire()({ AdminAPI })(modal, { id: 'p1', sku: 'CLC40BK', name: 'x', series_codes: ['LC40'] });
  assert.equal(modal._productCodesLoaded, true);
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC40']);
  assert.match(modal._els['product-codes-chips'].innerHTML, /Suggested from/, 'shows the seed note');
});

test('seed: with no series_codes, it derives via window.API._enrichSeriesCodes', async () => {
  const modal = makeModal(CODE_IDS);
  const win = { API: { _enrichSeriesCodes(p) { p.series_codes = ['LC57']; return true; } } };
  const AdminAPI = { getCodeCatalogue: async () => [], getProductCodes: async () => [] };
  await loadWire()({ AdminAPI, window: win })(modal, { id: 'p2', sku: 'CLC57', name: 'n', series_codes: [] });
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC57']);
});

test('a product WITH saved codes loads them and shows no seed note', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getCodeCatalogue: async () => ([{ code: 'LC40', product_count: 9 }]),
    getProductCodes: async (pid) => { assert.equal(pid, 'p3'); return ['LC40', 'LC57']; },
  };
  await loadWire()({ AdminAPI })(modal, { id: 'p3', sku: 's', name: 'n', series_codes: ['LC40'] });
  assert.deepEqual([...modal._productCodesSelection.keys()].sort(), ['LC40', 'LC57']);
  assert.doesNotMatch(modal._els['product-codes-chips'].innerHTML, /Suggested from/);
  assert.equal(modal._productCodesBaseline, 'LC40,LC57', 'baseline = the opened-with set');
});

test('typing a new code and pressing Enter adds it to the selection', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getCodeCatalogue: async () => [], getProductCodes: async () => ['LC40'] };
  await loadWire()({ AdminAPI })(modal, { id: 'p4', sku: 's', name: 'n', series_codes: [] });
  const search = modal._els['code-search'];
  search.value = 'lc-57';                       // lower-case + hyphen → normalises to LC57
  await search.fire('keydown', keyEvent('Enter', search));
  assert.ok(modal._productCodesSelection.has('LC57'), 'normalised code added');
  assert.deepEqual([...modal._productCodesSelection.keys()].sort(), ['LC40', 'LC57']);
});

test('a 1-character code is rejected with an error toast', async () => {
  const modal = makeModal(CODE_IDS);
  const Toast = makeToast();
  const AdminAPI = { getCodeCatalogue: async () => [], getProductCodes: async () => [] };
  await loadWire()({ AdminAPI, Toast })(modal, { id: 'p5', sku: 's', name: 'n', series_codes: [] });
  const search = modal._els['code-search'];
  search.value = 'L';
  await search.fire('keydown', keyEvent('Enter', search));
  assert.equal(modal._productCodesSelection.size, 0, 'no code added');
  assert.ok(Toast.calls.some(c => c[0] === 'error'), 'an error toast fired');
});

test('clicking a catalogue row toggles the code on, then off', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getCodeCatalogue: async () => ([{ code: 'TN253', product_count: 4 }]),
    getProductCodes: async () => [],
  };
  await loadWire()({ AdminAPI })(modal, { id: 'p6', sku: 's', name: 'n', series_codes: [] });
  const list = modal._els['code-list'];
  await list.fire('click', clickEvent({ '[data-code]': { dataset: { code: 'TN253' } } }));
  assert.ok(modal._productCodesSelection.has('TN253'), 'toggled on');
  await list.fire('click', clickEvent({ '[data-code]': { dataset: { code: 'TN253' } } }));
  assert.ok(!modal._productCodesSelection.has('TN253'), 'toggled back off');
});

test('removing a chip un-assigns the code', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = { getCodeCatalogue: async () => [], getProductCodes: async () => ['LC40', 'LC57'] };
  await loadWire()({ AdminAPI })(modal, { id: 'p7', sku: 's', name: 'n', series_codes: [] });
  await modal._els['product-codes-chips'].fire('click',
    clickEvent({ '[data-remove-code]': { dataset: { removeCode: 'LC40' } } }));
  assert.deepEqual([...modal._productCodesSelection.keys()], ['LC57']);
});

test('a failed catalogue load leaves the gate false so save cannot wipe codes', async () => {
  const modal = makeModal(CODE_IDS);
  const AdminAPI = {
    getCodeCatalogue: async () => { throw new Error('down'); },
    getProductCodes: async () => { throw new Error('down'); },
  };
  await loadWire()({ AdminAPI })(modal, { id: 'p8', sku: 's', name: 'n', series_codes: [] });
  assert.notEqual(modal._productCodesLoaded, true, 'gate stays false on load failure');
  assert.equal(modal._els['code-toggle'].disabled, true, 'picker is disabled');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. api.js — _applyManualCodes (override / chip injection / recovery)
// ─────────────────────────────────────────────────────────────────────────────

function loadAPI() {
  const win = {};
  const ctx = {
    window: win, console,
    URLSearchParams, TextEncoder, AbortController,
    setTimeout, clearTimeout,
    fetch: async () => ({ ok: false, json: async () => null }),
    Config: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k',
      API_BASE_URL: 'https://api.example', getSetting: (k, d) => d },
    DebugLog: { warn() {}, error() {}, log() {}, info() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Security: { escapeHtml: (s) => s, escapeAttr: (s) => s },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
  assert.ok(win.API, 'api.js must expose window.API');
  return win.API;
}

test('api.js loads cleanly and exposes the manual-code helpers', () => {
  const API = loadAPI();
  for (const m of ['_applyManualCodes', '_fetchManualCodesByProduct', '_fetchManualChipCounts',
                   '_fetchProductIdsForCode', '_supabaseSelect', '_CATEGORY_PRODUCT_TYPES']) {
    assert.ok(API[m] !== undefined, `API.${m} must exist`);
  }
});

test('_CATEGORY_PRODUCT_TYPES maps each /shop category to its product_types', () => {
  const API = loadAPI();
  assert.deepEqual(plain(API._CATEGORY_PRODUCT_TYPES.ink), ['ink_cartridge', 'ink_bottle']);
  assert.deepEqual(plain(API._CATEGORY_PRODUCT_TYPES.toner), ['toner_cartridge']);
  assert.ok(API._CATEGORY_PRODUCT_TYPES.ribbons.includes('typewriter_ribbon'));
});

test('(1) override — a product with manual codes has series_codes fully replaced', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    assert.match(q, /^product_codes\?select=product_id,code/);
    return [{ product_id: 'p1', code: 'LC57' }, { product_id: 'p1', code: 'LC40' }];
  };
  const primary = { ok: true, data: { products: [
    { id: 'p1', series_codes: ['LC40'] },     // auto said LC40; manual says LC40+LC57
    { id: 'p2', series_codes: ['TN253'] },     // no manual rows → untouched
  ] } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  assert.deepEqual(plain(primary.data.products[0].series_codes).sort(), ['LC40', 'LC57']);
  assert.deepEqual(plain(primary.data.products[1].series_codes), ['TN253'], 'uncoded product untouched');
});

test('(2) chip injection — a purely-manual code gains its own drilldown chip', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    if (q.startsWith('product_code_chip_counts')) {
      return [{ code: 'LC57', product_count: 2 }, { code: 'LC40', product_count: 9 }];
    }
    return [];
  };
  const primary = { ok: true, data: {
    products: [],
    series: [{ code: 'LC40', count: 9 }, { code: 'TN253', count: 4 }],
  } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  const codes = primary.data.series.map(s => s.code);
  assert.ok(codes.includes('LC57'), 'manual-only code LC57 was injected as a chip');
  const lc40 = primary.data.series.find(s => s.code === 'LC40');
  assert.equal(lc40.count, 9, 'an already-present chip keeps its backend count');
});

test('(3) recovery — a manually-tagged product is merged into the ?code= grid', async () => {
  const API = loadAPI();
  API._supabaseSelect = async (q) => {
    if (q.startsWith('product_codes?select=product_id&code=eq.LC57')) return [{ product_id: 'pX' }];
    if (q.startsWith('product_codes?select=product_id,code')) return [{ product_id: 'pX', code: 'LC57' }];
    return [];
  };
  API.getWithSWR = async () => ({ ok: true, data: { products: [
    { id: 'pX', name: 'Manually tagged', series_codes: [] },
    { id: 'pZ', name: 'Unrelated', series_codes: [] },
  ] } });
  const primary = { ok: true, data: { products: [] }, meta: { total: 0 } };
  await API._applyManualCodes(primary, { brand: 'brother', category: 'ink', code: 'LC57' });
  const ids = primary.data.products.map(p => p.id);
  assert.deepEqual(plain(ids), ['pX'], 'only the LC57-tagged product is recovered');
  assert.equal(primary.meta.total, 1, 'meta.total reflects the recovered row');
  assert.deepEqual(plain(primary.data.products[0].series_codes), ['LC57']);
});

test('_applyManualCodes is fail-open — a Supabase outage leaves the response intact', async () => {
  const API = loadAPI();
  API._supabaseSelect = async () => { throw new Error('supabase unreachable'); };
  const primary = { ok: true, data: { products: [{ id: 'p1', series_codes: ['LC40'] }],
    series: [{ code: 'LC40', count: 1 }] } };
  const out = await API._applyManualCodes(primary, { brand: 'brother', category: 'ink' });
  assert.equal(out, primary, 'the same response object is returned');
  assert.deepEqual(primary.data.products[0].series_codes, ['LC40'], 'untouched on failure');
});

test('_fetchManualChipCounts sums product_count across product_types of a category', async () => {
  const API = loadAPI();
  API._supabaseSelect = async () => ([
    { code: 'LC40', product_count: 3 },   // ink_cartridge rows
    { code: 'LC40', product_count: 1 },   // ink_bottle rows — same chip
  ]);
  const chips = await API._fetchManualChipCounts('brother', ['ink_cartridge', 'ink_bottle']);
  assert.deepEqual(plain(chips), [{ code: 'LC40', count: 4 }]);
});

test('_fetchProductIdsForCode normalises the code before the lookup', async () => {
  const API = loadAPI();
  let seen = '';
  API._supabaseSelect = async (q) => { seen = q; return [{ product_id: 'p1' }]; };
  const ids = await API._fetchProductIdsForCode('lc-40');
  assert.match(seen, /code=eq\.LC40/, 'code is upper-cased and stripped before query');
  assert.deepEqual(ids, ['p1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. getShopData integration
// ─────────────────────────────────────────────────────────────────────────────

test('getShopData routes BOTH return paths through _applyManualCodes', () => {
  // extractFunction is fooled by the `params = {}` default arg, so slice the
  // method span explicitly: getShopData ends where the _manualCodeCache field
  // (the first member of the manual-code block) begins.
  const start = API_SRC.indexOf('async getShopData(');
  const end = API_SRC.indexOf('_manualCodeCache:', start);
  assert.ok(start !== -1 && end !== -1 && end > start);
  const fn = API_SRC.slice(start, end);
  const hooks = fn.match(/_applyManualCodes\(primary, params\)/g) || [];
  assert.equal(hooks.length, 2, 'the early-skip and the final return both apply manual codes');
  assert.doesNotMatch(fn, /\n\s*return primary;/, 'no raw `return primary` bypasses the hook');
});
