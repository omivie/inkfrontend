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
 * (printer_ribbon / typewriter_ribbon / correction_tape).
 *
 * UI REVISION (May 2026, this revision) — the native <select> "Add a brand…"
 * dropdown was clipped by the modal's scroll container, so most of the brand
 * list was invisible. It is replaced by `.admin-brandpicker`, a searchable
 * multi-select combobox whose options live in an INLINE panel (rendered in the
 * form flow, never absolutely positioned) so the modal can never clip it:
 *
 *   • A toggle button opens/closes an inline panel.
 *   • The panel has a search field + a scrollable list of EVERY brand.
 *   • Clicking a row toggles assignment (multi-select; panel stays open).
 *   • Typing a novel name surfaces an inline "Create …" row.
 *   • Selection still lives on modal._ribbonBrandSelection (Map id→{id,name}).
 *
 * Safety invariant is unchanged: the save handler persists assignments via
 * setProductRibbonBrands ONLY when modal._ribbonBrandsLoaded === true, so a
 * failed initial load can never be misread as "no brands" and wipe them.
 *
 * This test runs the real wireRibbonBrandsSection() — extracted from the
 * source and executed against a hand-rolled minimal DOM — so the load gate,
 * the panel toggle, search-filter, option-toggle, chip-remove and inline-create
 * paths are exercised, not just grepped.
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
  const idx = PRODUCTS_SRC.indexOf('id="ribbon-brands-group"');
  assert.notEqual(idx, -1, 'ribbon-brands-group shell must exist');
  const before = PRODUCTS_SRC.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(\s*isManualCompat\s*\)/,
    'the ribbon-brands shell must be guarded by isManualCompat');
});

test('drawer shell contains the chips container, count, picker, toggle, panel, search and list', () => {
  for (const id of ['ribbon-brands-chips', 'ribbon-brands-count', 'ribbon-brand-picker',
                     'ribbon-brand-toggle', 'ribbon-brand-toggle-label',
                     'ribbon-brand-panel', 'ribbon-brand-search', 'ribbon-brand-list']) {
    assert.ok(PRODUCTS_SRC.includes(`id="${id}"`), `shell must contain #${id}`);
  }
});

test('the clipped native <select> picker and standalone create row are gone', () => {
  // The bug was a native <select id="ribbon-brand-picker"> — the picker id now
  // belongs to a <div> wrapper. No <select … id="ribbon-brand-picker"> anywhere.
  assert.doesNotMatch(PRODUCTS_SRC, /<select[^>]*id="ribbon-brand-picker"/,
    'ribbon-brand-picker must no longer be a native <select> (it was clipped)');
  for (const deadId of ['ribbon-brand-new', 'ribbon-brand-new-name',
                        'ribbon-brand-new-save', 'ribbon-brand-new-cancel']) {
    assert.ok(!PRODUCTS_SRC.includes(`id="${deadId}"`),
      `the old standalone create row #${deadId} must be removed`);
  }
});

test('drawer toggle button is an accessible, initially-collapsed combobox', () => {
  const idx = PRODUCTS_SRC.indexOf('id="ribbon-brand-toggle"');
  const tag = PRODUCTS_SRC.slice(idx - 80, idx + 240);
  assert.match(tag, /aria-expanded="false"/, 'toggle starts collapsed');
  assert.match(tag, /aria-controls="ribbon-brand-panel"/, 'toggle points at its panel');
  // The panel itself starts hidden.
  const panelIdx = PRODUCTS_SRC.indexOf('id="ribbon-brand-panel"');
  assert.match(PRODUCTS_SRC.slice(panelIdx, panelIdx + 160), /\bhidden\b/,
    'the inline panel starts hidden');
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
  assert.match(bind, /modal\._ribbonBrandsLoaded\s*&&\s*RIBBON_PRODUCT_TYPES\.includes\(data\.product_type\)/,
    'persistence must be gated on _ribbonBrandsLoaded AND a ribbon product_type');
  assert.match(bind, /setProductRibbonBrands\(product\.id,\s*\[\.\.\.modal\._ribbonBrandSelection\.keys\(\)\]\)/,
    'persistence must pass the selected brand ids to setProductRibbonBrands');
  const wire = extractFunction(PRODUCTS_SRC, 'async function wireRibbonBrandsSection(');
  assert.match(wire, /modal\._ribbonBrandsLoaded\s*=\s*false/, 'the flag must start false');
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
// 5. CSS — the new searchable picker is fully styled and CANNOT be clipped
// ─────────────────────────────────────────────────────────────────────────────

test('admin.css styles the ribbon-brands section and the new brand picker', () => {
  for (const cls of ['.admin-ribbon-brands', '.admin-ribbon-brand-chip',
                      '.admin-ribbon-brand-chip__remove', '.admin-ribbon-brands__error',
                      '.admin-ribbon-brands__count', '.admin-brandpicker',
                      '.admin-brandpicker__toggle', '.admin-brandpicker__panel',
                      '.admin-brandpicker__search', '.admin-brandpicker__list',
                      '.admin-brandpicker__option', '.admin-brandpicker__create']) {
    assert.ok(CSS_SRC.includes(cls), `admin.css must define ${cls}`);
  }
});

test('the picker panel is INLINE, never an absolutely-positioned popup', () => {
  // The whole point of the rewrite: a position:absolute/fixed panel would be
  // clipped by the modal's overflow-y:auto scroll container — the original bug.
  const m = CSS_SRC.match(/\.admin-brandpicker__panel\s*\{([^}]*)\}/);
  assert.ok(m, '.admin-brandpicker__panel rule must exist');
  assert.doesNotMatch(m[1], /position\s*:\s*(absolute|fixed)/,
    'the panel must NOT be absolutely/fixed positioned — it would be clipped again');
  // The panel hides via the [hidden] attribute (set by JS).
  assert.match(CSS_SRC, /\.admin-brandpicker__panel\[hidden\]\s*\{[^}]*display\s*:\s*none/,
    'a [hidden] rule must collapse the panel');
  // The list itself scrolls internally — that is how a long brand list stays
  // reachable without the panel growing unbounded.
  const list = CSS_SRC.match(/\.admin-brandpicker__list\s*\{([^}]*)\}/);
  assert.ok(list && /overflow-y\s*:\s*auto/.test(list[1]) && /max-height/.test(list[1]),
    'the brand list must scroll internally (max-height + overflow-y:auto)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. APP_VERSION bumped so the edited products.js module is re-fetched
// ─────────────────────────────────────────────────────────────────────────────

test('APP_VERSION was bumped off the previous build', () => {
  const m = APP_SRC.match(/const APP_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'APP_VERSION must be declared');
  assert.notEqual(m[1], '2026.05.18-rich-text-persist',
    'APP_VERSION must change so the cached module is busted');
  assert.match(m[1], /^2026\.\d{2}\.\d{2}-[a-z0-9-]+$/i,
    'APP_VERSION must be a dated build tag (YYYY.MM.DD-slug)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Functional — run the real wireRibbonBrandsSection against a minimal DOM
// ─────────────────────────────────────────────────────────────────────────────

// Minimal DOM element: stores innerHTML/value/attrs, captures listeners so the
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
    _attrs: {},
    focus() {},
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getAttribute(n) { return this._attrs[n]; },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    fire(type, event) { return Promise.all((this._listeners[type] || []).map(fn => fn(event))); },
  };
}

// A modal whose querySelector returns registered elements by id selector.
function makeModal(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  // Mirror the real shell: the inline panel starts hidden.
  if (els['ribbon-brand-panel']) els['ribbon-brand-panel'].hidden = true;
  return {
    isConnected: true,
    _els: els,
    querySelector(sel) { return els[sel.replace(/^#/, '')] || null; },
  };
}

const RIBBON_GROUP_IDS = [
  'ribbon-brands-group', 'ribbon-brands-chips', 'ribbon-brands-count',
  'ribbon-brand-picker', 'ribbon-brand-toggle', 'ribbon-brand-toggle-label',
  'ribbon-brand-panel', 'ribbon-brand-search', 'ribbon-brand-list',
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

// Event whose target.closest(sel) yields a stub for the given selectors.
function clickEvent(map) {
  return { target: { closest: (sel) => map[sel] || null }, preventDefault() {} };
}
// A keydown event.
function keyEvent(key) {
  return { key, preventDefault() {} };
}

test('non-ribbon product → wireRibbonBrandsSection is a clean no-op', async () => {
  const wire = loadWire();
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

  // Chips show the assigned brand + a live count; the toggle is enabled.
  assert.match(modal._els['ribbon-brands-chips'].innerHTML, /Olympia/);
  assert.match(modal._els['ribbon-brands-count'].textContent, /1 assigned/);
  assert.equal(modal._els['ribbon-brands-count'].hidden, false, 'count is visible when >0');
  assert.equal(modal._els['ribbon-brand-toggle'].disabled, false, 'toggle is enabled after load');
  assert.match(modal._els['ribbon-brand-toggle-label'].textContent, /1 selected/);
});

test('opening the panel renders EVERY brand (assigned ones marked selected)', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([
      { id: 'b1', name: 'Brother', sort_order: 10 },
      { id: 'b2', name: 'Olympia', sort_order: 20 },
      { id: 'b3', name: 'Olivetti', sort_order: 30 },
    ]),
    getProductRibbonBrands: async () => ([{ ribbon_brands: { id: 'b2', name: 'Olympia' } }]),
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });

  const toggle = modal._els['ribbon-brand-toggle'];
  const panel  = modal._els['ribbon-brand-panel'];
  const list   = modal._els['ribbon-brand-list'];
  assert.equal(panel.hidden, true, 'panel starts hidden');

  await toggle.fire('click');
  assert.equal(panel.hidden, false, 'clicking the toggle opens the inline panel');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'aria-expanded reflects the open state');

  // ALL three brands are listed — the clipping bug is gone.
  for (const name of ['Brother', 'Olympia', 'Olivetti']) {
    assert.match(list.innerHTML, new RegExp(name), `${name} is in the list`);
  }
  assert.match(list.innerHTML, /data-brand-id="b2"[^>]*aria-selected="true"/,
    'the assigned brand is rendered as selected');
  assert.match(list.innerHTML, /data-brand-id="b1"[^>]*aria-selected="false"/,
    'an unassigned brand is rendered as not-selected');

  // Clicking the toggle again closes it.
  await toggle.fire('click');
  assert.equal(panel.hidden, true, 'a second click closes the panel');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('clicking a list row toggles assignment on, then off', async () => {
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

  const list = modal._els['ribbon-brand-list'];
  await modal._els['ribbon-brand-toggle'].fire('click');

  // Select Brother.
  list.fire('click', clickEvent({ '[data-brand-id]': { dataset: { brandId: 'b1' } } }));
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b1']);
  assert.match(modal._els['ribbon-brands-chips'].innerHTML, /Brother/);

  // Click the same row again → un-assign (multi-select toggle behaviour).
  list.fire('click', clickEvent({ '[data-brand-id]': { dataset: { brandId: 'b1' } } }));
  assert.equal(modal._ribbonBrandSelection.size, 0, 'a second row click un-assigns it');
});

test('chip removal un-assigns a brand', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => ([{ ribbon_brands: { id: 'b1', name: 'Brother' } }]),
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });
  assert.equal(modal._ribbonBrandSelection.size, 1, 'pre-assigned');

  modal._els['ribbon-brands-chips'].fire('click',
    clickEvent({ '[data-remove-brand]': { dataset: { removeBrand: 'b1' } } }));
  assert.equal(modal._ribbonBrandSelection.size, 0, 'chip removal clears the selection');
  assert.equal(modal._els['ribbon-brands-count'].hidden, true, 'count hides at zero');
});

test('the search box filters the brand list', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([
      { id: 'b1', name: 'Brother', sort_order: 10 },
      { id: 'b2', name: 'Olympia', sort_order: 20 },
      { id: 'b3', name: 'Olivetti', sort_order: 30 },
    ]),
    getProductRibbonBrands: async () => [],
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });

  const search = modal._els['ribbon-brand-search'];
  const list   = modal._els['ribbon-brand-list'];
  await modal._els['ribbon-brand-toggle'].fire('click');

  search.value = 'OL';
  search.fire('input');
  assert.match(list.innerHTML, /Olympia/, 'case-insensitive substring match keeps Olympia');
  assert.match(list.innerHTML, /Olivetti/, '…and Olivetti');
  assert.doesNotMatch(list.innerHTML, /Brother/, 'non-matching brands are filtered out');
});

test('typing a novel name surfaces an inline "Create" row; clicking it creates the brand', async () => {
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

  const search = modal._els['ribbon-brand-search'];
  const list   = modal._els['ribbon-brand-list'];
  await modal._els['ribbon-brand-toggle'].fire('click');

  search.value = 'Olympia SM9';
  search.fire('input');
  assert.match(list.innerHTML, /data-create-brand/, 'a Create row appears for a novel name');
  assert.match(list.innerHTML, /Create .Olympia SM9./, 'the Create row echoes the typed name');

  await list.fire('click', clickEvent({ '[data-create-brand]': { dataset: {} } }));

  assert.ok(createdWith, 'createRibbonBrand was called');
  assert.equal(createdWith.name, 'Olympia SM9');
  assert.equal(createdWith.slug, 'olympia-sm9', 'name is slugified');
  assert.equal(createdWith.is_active, true);
  assert.ok(createdWith.sort_order > 10, 'sort_order is appended past the catalogue max');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b9'], 'new brand auto-assigned');
  assert.equal(search.value, '', 'the search box is cleared after a create');
  assert.ok(Toast.calls.some(([t]) => t === 'success'), 'a success toast is shown');
});

test('Enter on a novel name creates the brand; Enter on an exact match just assigns it', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  let createCalls = 0;
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => [],
    createRibbonBrand: async (data) => { createCalls++; return { id: 'bN', ...data }; },
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });

  const search = modal._els['ribbon-brand-search'];
  await modal._els['ribbon-brand-toggle'].fire('click');

  // Exact match → no create, just assign.
  search.value = 'brother';
  await search.fire('keydown', keyEvent('Enter'));
  assert.equal(createCalls, 0, 'an exact name match must not create a duplicate');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b1'], 'the matched brand is assigned');

  // Novel name → create.
  search.value = 'Adler';
  await search.fire('keydown', keyEvent('Enter'));
  assert.equal(createCalls, 1, 'a novel name creates a brand');
  assert.ok(modal._ribbonBrandSelection.has('bN'), 'the newly created brand is assigned');
});

test('Escape closes the panel', async () => {
  const wire = loadWire();
  const modal = makeModal(RIBBON_GROUP_IDS);
  const AdminAPI = {
    getAdminRibbonBrands: async () => ([{ id: 'b1', name: 'Brother', sort_order: 10 }]),
    getProductRibbonBrands: async () => [],
  };
  await wire({ AdminAPI, Toast: makeToast() })(modal, { id: 'p9', product_type: 'printer_ribbon' });

  const panel = modal._els['ribbon-brand-panel'];
  await modal._els['ribbon-brand-toggle'].fire('click');
  assert.equal(panel.hidden, false);
  await modal._els['ribbon-brand-search'].fire('keydown', keyEvent('Escape'));
  assert.equal(panel.hidden, true, 'Escape in the search box closes the panel');
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

  const search = modal._els['ribbon-brand-search'];
  await modal._els['ribbon-brand-toggle'].fire('click');
  // No Create row should be offered for an existing name.
  search.value = 'brother';
  search.fire('input');
  assert.doesNotMatch(modal._els['ribbon-brand-list'].innerHTML, /data-create-brand/,
    'no Create row when the typed name already exists');

  await search.fire('keydown', keyEvent('Enter'));
  assert.equal(createCalled, false, 'no duplicate brand created');
  assert.deepEqual([...modal._ribbonBrandSelection.keys()], ['b1'], 'existing brand assigned instead');
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
  assert.equal(modal._els['ribbon-brand-toggle'].disabled, true,
    'the picker toggle is disabled when the catalogue is unavailable');
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
