/**
 * Admin Ribbon Brands assignment — May 2026
 * =========================================
 *
 * The `ribbon_brands` catalogue and the `product_ribbon_brands` junction table
 * had a full API surface in inkcartridges/js/admin/api.js —
 * getAdminRibbonBrands / getProductRibbonBrands / setProductRibbonBrands /
 * createRibbonBrand — but ZERO admin UI bound to it. A ribbon product could be
 * created, but it could never be filed under a device brand, so the brand
 * filter on the customer-facing /ribbons page could never surface it.
 *
 * The fix adds a "Ribbon Brands" section to the product edit drawer's
 * "For Use In" tab, shown only for ribbon-family product types
 * (printer_ribbon / typewriter_ribbon / correction_tape):
 *
 *   1. RIBBON_PRODUCT_TYPES — module-level constant, the single source of
 *      truth for "is this a ribbon-family product".
 *
 *   2. buildProductModalTabs() appends the #ribbon-brands-group shell to the
 *      For Use In panel ONLY when isManualCompat (i.e. a ribbon type).
 *
 *   3. wireRibbonBrandsSection() loads the brand catalogue + the product's
 *      current assignments, renders assigned brands as removable chips and a
 *      picker for the rest, and supports inline brand creation
 *      (AdminAPI.createRibbonBrand).
 *
 *   4. The save handler persists assignments via setProductRibbonBrands —
 *      GATED on modal._ribbonBrandsLoaded so a failed initial load can never
 *      be misread as "no brands" and silently wipe existing assignments.
 *
 * This test runs the real wireRibbonBrandsSection() — extracted from the
 * source and executed against a hand-rolled minimal DOM — so the load gate,
 * chip add/remove, and inline-create paths are exercised, not just grepped.
 *
 * Run: node --test tests/admin-ribbon-brands.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');
const API_SRC      = READ('inkcartridges/js/admin/api.js');
const APP_SRC      = READ('inkcartridges/js/admin/app.js');
const CSS_SRC      = READ('inkcartridges/css/admin.css');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extract a top-level function body by brace matching.
// ─────────────────────────────────────────────────────────────────────────────
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RIBBON_PRODUCT_TYPES — the single source of truth
// ─────────────────────────────────────────────────────────────────────────────

test('RIBBON_PRODUCT_TYPES constant lists exactly the three ribbon-family types', () => {
  const m = PRODUCTS_SRC.match(/const RIBBON_PRODUCT_TYPES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'RIBBON_PRODUCT_TYPES constant must be declared');
  const types = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(types.sort(), ['correction_tape', 'printer_ribbon', 'typewriter_ribbon']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The drawer shell is gated on isManualCompat
// ─────────────────────────────────────────────────────────────────────────────

test('#ribbon-brands-group shell is only emitted for ribbon-family products', () => {
  // The section HTML must sit inside an `if (isManualCompat)` block.
  const idx = PRODUCTS_SRC.indexOf('id="ribbon-brands-group"');
  assert.notEqual(idx, -1, 'ribbon-brands-group shell must exist');
  const before = PRODUCTS_SRC.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(\s*isManualCompat\s*\)/,
    'the ribbon-brands shell must be guarded by isManualCompat');
});

test('drawer shell contains the chips container, picker and inline-create row', () => {
  for (const id of ['ribbon-brands-chips', 'ribbon-brand-picker',
                     'ribbon-brand-new', 'ribbon-brand-new-name',
                     'ribbon-brand-new-save', 'ribbon-brand-new-cancel']) {
    assert.ok(PRODUCTS_SRC.includes(`id="${id}"`), `shell must contain #${id}`);
  }
});

test('wireRibbonBrandsSection is invoked from openProductDrawer', () => {
  const drawer = extractFunction(PRODUCTS_SRC, 'async function openProductDrawer(');
  assert.match(drawer, /wireRibbonBrandsSection\(modal,\s*full\)/,
    'openProductDrawer must call wireRibbonBrandsSection');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The save handler is gated — a failed load must never wipe assignments
// ─────────────────────────────────────────────────────────────────────────────

test('save handler persists ribbon brands only when load succeeded', () => {
  const bind = extractFunction(PRODUCTS_SRC, 'function bindProductModalActions(');
  // The persistence call must be guarded by BOTH the loaded flag and a
  // ribbon-type check, and must call setProductRibbonBrands.
  assert.match(bind, /modal\._ribbonBrandsLoaded\s*&&\s*RIBBON_PRODUCT_TYPES\.includes\(data\.product_type\)/,
    'persistence must be gated on _ribbonBrandsLoaded AND a ribbon product_type');
  assert.match(bind, /setProductRibbonBrands\(product\.id,\s*\[\.\.\.modal\._ribbonBrandSelection\.keys\(\)\]\)/,
    'persistence must pass the selected brand ids to setProductRibbonBrands');
  // The guard must come from a flag set only after a clean load.
  const wire = extractFunction(PRODUCTS_SRC, 'async function wireRibbonBrandsSection(');
  assert.match(wire, /modal\._ribbonBrandsLoaded\s*=\s*false/,
    'the flag must start false');
  assert.match(wire, /modal\._ribbonBrandsLoaded\s*=\s*true/,
    'the flag must be set true only after a successful load');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. API surface sanity — the methods the UI calls must exist
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI exposes every ribbon-brand method the UI depends on', () => {
  for (const m of ['getAdminRibbonBrands', 'getProductRibbonBrands',
                    'setProductRibbonBrands', 'createRibbonBrand']) {
    assert.match(API_SRC, new RegExp(`\\b${m}\\s*\\(`), `AdminAPI.${m} must exist`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CSS — the section's classes are styled
// ─────────────────────────────────────────────────────────────────────────────

test('admin.css styles the ribbon-brands section', () => {
  for (const cls of ['.admin-ribbon-brands', '.admin-ribbon-brand-chip',
                      '.admin-ribbon-brand-chip__remove', '.admin-ribbon-brands__new',
                      '.admin-ribbon-brands__error']) {
    assert.ok(CSS_SRC.includes(cls), `admin.css must define ${cls}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. APP_VERSION bumped so the edited products.js module is re-fetched
// ─────────────────────────────────────────────────────────────────────────────

test('APP_VERSION was bumped off the previous (cogs) build', () => {
  const m = APP_SRC.match(/const APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'APP_VERSION must be declared');
  assert.notEqual(m[1], '2026.05.17-cogs', 'APP_VERSION must change so the cached module is busted');
  assert.match(m[1], /ribbon/, 'APP_VERSION should name the ribbon-brands change');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Functional — run the real wireRibbonBrandsSection against a minimal DOM
// ─────────────────────────────────────────────────────────────────────────────

// Minimal DOM element: stores innerHTML/value/etc, captures listeners so the
// test can fire them, and supports the delegated-event shape the code uses.
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    _listeners: {},
    focus() {},
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    fire(type, event) { (this._listeners[type] || []).forEach(fn => fn(event)); },
  };
}

// A modal whose querySelector returns registered elements by id selector.
function makeModal(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  return {
    isConnected: true,
    _els: els,
    querySelector(sel) { return els[sel.replace(/^#/, '')] || null; },
  };
}

const RIBBON_GROUP_IDS = [
  'ribbon-brands-group', 'ribbon-brands-chips', 'ribbon-brand-picker',
  'ribbon-brand-new', 'ribbon-brand-new-name', 'ribbon-brand-new-save',
  'ribbon-brand-new-cancel',
];

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Build a runnable copy of wireRibbonBrandsSection with its free globals injected.
function loadWire() {
  const src = extractFunction(PRODUCTS_SRC, 'async function wireRibbonBrandsSection(');
  const factory = new Function('AdminAPI', 'Toast', 'esc', 'DebugLog',
    `${src}; return wireRibbonBrandsSection;`);
  return (deps) => factory(deps.AdminAPI, deps.Toast, esc, deps.DebugLog || { warn() {} });
}

function makeToast() {
  const calls = [];
  return {
    calls,
    success: (m) => calls.push(['success', m]),
    error:   (m) => calls.push(['error', m]),
    info:    (m) => calls.push(['info', m]),
  };
}

test('non-ribbon product → wireRibbonBrandsSection is a clean no-op', async () => {
  const wire = loadWire();
  // querySelector('#ribbon-brands-group') returns null → early return.
  const modal = { isConnected: true, querySelector: () => null };
  const calls = [];
  const AdminAPI = {
    getAdminRibbonBrands: () => { calls.push('brands'); return []; },
    getProductRibbonBrands: () => { calls.push('assigned'); return []; },
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p1', product_type: 'ink_cartridge' });
  assert.equal(calls.length, 0, 'no API calls for a non-ribbon product');
  assert.equal(modal._ribbonBrandSelection, undefined);
});

test('ribbon product → loads catalogue + assignments and pre-selects them', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([
      { id: 'b1', name: 'Brother', sort_order: 10 },
      { id: 'b2', name: 'Olympia', sort_order: 20 },
      { id: 'b3', name: 'Olivetti', sort_order: 30 },
    ]),
    getProductRibbonBrands: async (pid) => {
      assert.equal(pid, 'p9', 'product id is threaded through');
      return [{ ribbon_brand_id: 'b2', ribbon_brands: { id: 'b2', name: 'Olympia' } }];
    },
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'typewriter_ribbon' });

  assert.equal(modal._ribbonBrandsLoaded, true, 'load gate flips true on success');
  assert.ok(modal._ribbonBrandSelection instanceof Map);
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b2'], 'assigned brand pre-selected');

  // Chips show the assigned brand; picker offers the unassigned ones + create.
  assert.match(modal._els['ribbon-brands-chips'].innerHTML, /Olympia/);
  const pickerHtml = modal._els['ribbon-brand-picker'].innerHTML;
  assert.match(pickerHtml, /Brother/);
  assert.match(pickerHtml, /Olivetti/);
  assert.doesNotMatch(pickerHtml, />Olympia</, 'already-assigned brand is not offered again');
  assert.match(pickerHtml, /__new__/, 'picker offers an inline-create option');
  assert.equal(modal._els['ribbon-brand-picker'].disabled, false);
});

test('failed load keeps the gate false (save must not wipe assignments)', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => { throw new Error('network down'); },
    getProductRibbonBrands: async () => [],
  };
  await wire({ AdminAPI, Toast: makeToast(), DebugLog: { warn() {} } })(
    modal, { id: 'p9', product_type: 'printer_ribbon' });

  assert.equal(modal._ribbonBrandsLoaded, false, 'gate stays false on load failure');
  assert.match(modal._els['ribbon-brands-chips'].innerHTML, /load/i, 'an error message is shown');
  assert.equal(modal._els['ribbon-brand-picker'].disabled, true, 'picker disabled when unavailable');
});

test('picker change assigns an existing brand; chip removal un-assigns it', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([
      { id: 'b1', name: 'Brother', sort_order: 10 },
      { id: 'b2', name: 'Olympia', sort_order: 20 },
    ]),
    getProductRibbonBrands: async () => [],
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });
  assert.equal(modal._ribbonBrandSelection.size, 0, 'starts empty');

  // Assign Brother via the picker.
  const picker = modal._els['ribbon-brand-picker'];
  picker.value = 'b1';
  picker.fire('change');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b1']);
  assert.match(modal._els['ribbon-brands-chips'].innerHTML, /Brother/);

  // Remove it again — delegated click whose target.closest yields the chip btn.
  modal._els['ribbon-brands-chips'].fire('click', {
    target: { closest: (sel) => sel === '[data-remove-brand]' ? { dataset: { removeBrand: 'b1' } } : null },
  });
  assert.equal(modal._ribbonBrandSelection.size, 0, 'chip removal clears the selection');
});

test('picker "__new__" reveals the inline create row', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => [],
    getProductRibbonBrands: async () => [],
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'correction_tape' });

  const newWrap = modal._els['ribbon-brand-new'];
  newWrap.hidden = true;
  const picker = modal._els['ribbon-brand-picker'];
  picker.value = '__new__';
  picker.fire('change');
  assert.equal(newWrap.hidden, false, 'inline create row is revealed');
  assert.equal(picker.value, '', 'picker resets after selection');
});

test('inline create calls createRibbonBrand and assigns the new brand', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  let createdWith = null;
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => [],
    createRibbonBrand: async (data) => { createdWith = data; return { id: 'b9', ...data }; },
  };
  const Toast = makeToast();
  await wire({ AdminAPI, Toast })(modal, { id: 'p9', product_type: 'typewriter_ribbon' });

  modal._els['ribbon-brand-new-name'].value = 'Olympia SM9';
  await modal._els['ribbon-brand-new-save'].fire('click');

  assert.ok(createdWith, 'createRibbonBrand was called');
  assert.equal(createdWith.name, 'Olympia SM9');
  assert.equal(createdWith.slug, 'olympia-sm9', 'name is slugified');
  assert.equal(createdWith.is_active, true);
  assert.ok(createdWith.sort_order > 10, 'sort_order is appended past the catalogue max');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b9'], 'new brand auto-assigned');
  assert.ok(Toast.calls.some(([t]) => t === 'success'), 'a success toast is shown');
});

test('inline create de-dupes against an existing brand name (case-insensitive)', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  let createCalled = false;
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => [],
    createRibbonBrand: async () => { createCalled = true; return {}; },
  };
  const Toast = makeToast();
  await wire({ AdminAPI, Toast })(modal, { id: 'p9', product_type: 'printer_ribbon' });

  modal._els['ribbon-brand-new-name'].value = 'brother';
  await modal._els['ribbon-brand-new-save'].fire('click');

  assert.equal(createCalled, false, 'no duplicate brand created');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b1'], 'existing brand assigned instead');
  assert.ok(Toast.calls.some(([t]) => t === 'info'), 'an info toast explains the de-dupe');
});

test('a product with no id skips the assignment fetch but still loads the catalogue', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  let assignedCalled = false;
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => { assignedCalled = true; return []; },
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { product_type: 'printer_ribbon' });
  assert.equal(assignedCalled, false, 'getProductRibbonBrands not called without a product id');
  assert.equal(modal._ribbonBrandsLoaded, true);
  assert.equal(modal._ribbonBrandSelection.size, 0);
});
