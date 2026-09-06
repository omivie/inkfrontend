/**
 * Admin Products — what the backend fallback carries, and what it admits it lost
 * ============================================================================ *
 * ERR-220. The Products list showed "Genuine" in the Source dropdown and a full
 * page of rows badged "Compatible". Both facts were one bug. `loadProducts()`
 * has three routes, and the FALLBACK one — taken whenever the direct-Supabase
 * leg throws — rebuilt its filter object from scratch:
 *
 *     const filters = { search: _search, sort: _sort, order: _sortDir };
 *     if (_brandFilter) filters.brand = _brandFilter;
 *     if (_activeFilter !== '') filters.active = _activeFilter;
 *
 * `source`, `product_type`, `has_images` and `stock_status` were never read,
 * even though `AdminAPI.getProducts` sends all four and the OTHER backend route
 * already passed them. The dropdown is rendered once and never re-synced, so it
 * went on saying "Genuine" over rows nobody had filtered.
 *
 * Measured with `npm run probe:admin-products` on 2026-09-06, signed in as the
 * owner:
 *
 *   - the shipped Supabase select returns 403 / 42501 permission denied, and
 *     bisecting the column list names `cost_price` — so the fallback is not a
 *     rare hiccup, it is EVERY load;
 *   - `/api/admin/products` honours source / product_type / stock_status on
 *     100 of 100 rows, so forwarding them genuinely fixes the list;
 *   - that endpoint returns NO pagination block, and the page substituted
 *     `rows.length`, so the footer read "1–100 of 100" over 3,398 rows;
 *   - it returns `pack_type` on 100/100 rows and `supplier`/`supplier_sku` on
 *     0/100, and `productOrigin()` read an ABSENT supplier_sku as "no supplier
 *     code" — 27 of 100 rows wore a confident "Assembled" badge derived from a
 *     field that view never fetched.
 *
 * The gate this file really is: **one filter builder, used by every backend
 * leg**. "Both legs send the same filters" is a list nobody maintains unless a
 * test maintains it (the ERR-150/160 lesson). The source filter was one
 * instance; the test is written against the whole set.
 *
 * Run: node --test tests/admin-products-fallback-filters-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PRODUCTS = read('inkcartridges/js/admin/pages/products.js');
const API = read('inkcartridges/js/admin/api.js');
const TABLE = read('inkcartridges/js/admin/components/table.js');

let S;
test.before(async () => {
  S = await import(path.join(SITE, 'js/admin/utils/sourcing.js'));
});

/** Pull one top-level `function name(...) { ... }` out of a source file. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

/** Pull one `_name() { ... }` class method out of a source file. */
function extractMethod(src, name) {
  const start = src.indexOf(`\n  ${name}() {`);
  assert.notEqual(start, -1, `${name}() must exist`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const DEFAULT_STATE = {
  _search: '', _sort: 'name', _sortDir: 'asc', _page: 1,
  _brandFilter: '', _activeFilter: '', _sourceFilter: '', _typeFilter: '',
  _imageFilter: '', _stockFilter: '', _packFilter: '', _supplierFilter: '',
};

/**
 * Run the SHIPPED helpers against a given filter state. Re-implementing them
 * here would test a copy nobody loads.
 */
async function withState(overrides) {
  const state = { ...DEFAULT_STATE, ...overrides };
  const { typeFilterGroup } = await import(path.join(SITE, 'js/admin/utils/product-types.js'));
  const src = [
    extractFunction(PRODUCTS, 'backendProductFilters'),
    extractFunction(PRODUCTS, 'filtersLostToBackend'),
    extractFunction(PRODUCTS, 'paginationFrom'),
  ].join('\n\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function('state', 'typeFilterGroup', `
    const { ${Object.keys(DEFAULT_STATE).join(', ')} } = state;
    ${src}
    return { backendProductFilters, filtersLostToBackend, paginationFrom };
  `);
  return factory(state, typeFilterGroup);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ENROLMENT — every filter the API can send must come from ONE builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filters `AdminAPI.getProducts` forwards that the Products LIST deliberately
 * never sets, each with the reason. An entry may only be added here with one.
 */
const NOT_ON_THIS_PAGE = {
  category: 'the list filters by product_type, not the legacy category column',
  is_reviewed: 'the review queue is its own page (getUnreviewedProducts)',
};

test('every filter AdminAPI.getProducts forwards is produced by the ONE builder', async () => {
  const getProducts = API.slice(API.indexOf('async getProducts('));
  const supported = [...getProducts.slice(0, getProducts.indexOf('window.API.get'))
    .matchAll(/filters\.([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(supported.length >= 8, `expected to find the filter reads in api.js, found ${supported.length}`);

  const { backendProductFilters } = await withState({
    _search: 'brother', _brandFilter: 'b1', _activeFilter: 'true',
    _sourceFilter: 'genuine', _typeFilter: 'toner_cartridge',
    _imageFilter: 'has-images', _stockFilter: 'in_stock',
  });
  const built = backendProductFilters();

  for (const key of new Set(supported)) {
    if (key in NOT_ON_THIS_PAGE) continue;
    assert.ok(key in built,
      `AdminAPI.getProducts forwards \`${key}\` but backendProductFilters() never produces it — `
      + 'that is exactly how the Source filter went missing on one leg (ERR-220). '
      + `Either produce it, or add it to NOT_ON_THIS_PAGE with a reason.`);
  }
});

test('neither backend leg builds its own filter literal any more', () => {
  // Exactly one such literal may exist: the one INSIDE the builder.
  const literals = (PRODUCTS.match(/const filters = \{ search: _search/g) || []).length;
  assert.equal(literals, 1,
    'a hand-rolled `{ search: _search, ... }` is back outside backendProductFilters() — every '
    + 'backend caller must go through the builder or the two legs drift apart again');
  assert.match(extractFunction(PRODUCTS, 'backendProductFilters'), /const filters = \{ search: _search/,
    'the one permitted literal must be the builder\'s own');
  const calls = (PRODUCTS.match(/backendProductFilters\(\)/g) || []).length;
  assert.ok(calls >= 3,
    `expected the planned leg, the fallback and the PDF export to share the builder, found ${calls} call(s)`);
});

test('the fallback leg forwards the source filter — the ERR-220 case itself', async () => {
  const { backendProductFilters } = await withState({ _sourceFilter: 'genuine' });
  assert.equal(backendProductFilters().source, 'genuine');
});

test('a GROUPED type is never sent as a single product_type', async () => {
  // "All Ribbons" spans three types; the backend param takes one. Sending one
  // arm would filter to a third of the rows and look like it worked. The key is
  // read from the shipped vocabulary — hardcoding it here is how a renamed
  // group would quietly stop being tested.
  const { TYPE_FILTER_GROUPS } = await import(path.join(SITE, 'js/admin/utils/product-types.js'));
  const groupKey = Object.keys(TYPE_FILTER_GROUPS)[0];
  assert.ok(groupKey, 'there must be at least one grouped type filter to test');
  const grouped = await withState({ _typeFilter: groupKey });
  assert.ok(!('product_type' in grouped.backendProductFilters()),
    'a grouped type must not reach the backend as one value');
  assert.deepEqual(grouped.filtersLostToBackend(), ['the grouped type filter']);

  // Positive control: a single type MUST still be sent, or the test above would
  // pass just as well against a builder that forgot product_type entirely.
  const single = await withState({ _typeFilter: 'toner_cartridge' });
  assert.equal(single.backendProductFilters().product_type, 'toner_cartridge');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. What cannot cross must be NAMED
// ─────────────────────────────────────────────────────────────────────────────

test('Pack and Supplier are named as lost; nothing is invented when nothing is lost', async () => {
  const both = await withState({ _packFilter: 'packs', _supplierFilter: 'dsnz' });
  assert.deepEqual(both.filtersLostToBackend(), ['Pack', 'Supplier']);

  const none = await withState({ _sourceFilter: 'genuine', _stockFilter: 'in_stock' });
  assert.deepEqual(none.filtersLostToBackend(), [],
    'source and stock DO cross now — claiming a loss that did not happen is its own lie');
});

test('the fallback toast names the loss instead of "may match slightly differently"', () => {
  // The phrase may survive in the comment that explains why it was wrong; what
  // must not survive is a Toast built from it.
  assert.ok(!/Toast\.\w+\([^)]*may match slightly differently/.test(PRODUCTS),
    'the vague wording is back in a toast: it told an operator nothing about a filter that did nothing');
  assert.match(PRODUCTS, /filtersLostToBackend\(\)/,
    'the fallback must ask which filters were lost and say so');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. An unknown total is not a total
// ─────────────────────────────────────────────────────────────────────────────

test('a payload with no pagination block yields an UNKNOWN total, not the page size', async () => {
  const { paginationFrom } = await withState({});
  const rows = new Array(100).fill({});
  const p = paginationFrom({ products: rows }, rows, 100);
  assert.equal(p.totalUnknown, true);
  assert.equal(p.total, null, 'rows.length as a total is what hid 3,298 products');
  assert.equal(p.hasMore, true, 'a full page means there is probably another one');

  // Positive control: a real pagination block is still used verbatim.
  const real = paginationFrom({ pagination: { total: 3398, page: 2, limit: 100 } }, rows, 100);
  assert.equal(real.total, 3398);
  assert.ok(!real.totalUnknown);
});

test('the table footer says "of many" and keeps Next alive when the total is unknown', () => {
  const body = extractMethod(TABLE, '_renderPagination');
  // eslint-disable-next-line no-new-func
  const render = new Function(`return function() ${body}`)();

  const unknown = render.call({
    pagination: { total: null, totalUnknown: true, hasMore: true, page: 1, limit: 100 },
    data: new Array(100).fill({}),
    config: {},
  });
  assert.match(unknown, /of many/);
  assert.ok(!/data-page="2"[^>]*disabled/.test(unknown),
    'Next must stay clickable while more rows may exist — a disabled Next over an unknown '
    + 'total is how the catalogue looked 100 products long');

  // Walking off the end of an uncountable list must say so, not print a range
  // over an empty table.
  const empty = render.call({
    pagination: { total: null, totalUnknown: true, hasMore: false, page: 4, limit: 100 },
    data: [],
    config: {},
  });
  assert.match(empty, /No further products/);
  assert.ok(!/of many/.test(empty));

  // Positive control: a known total still behaves exactly as it always has.
  const known = render.call({
    pagination: { total: 250, page: 3, limit: 100 },
    data: new Array(50).fill({}),
    config: {},
  });
  assert.match(known, /201–250 of 250/);
  assert.match(known, /data-page="4"[^>]*disabled/, 'the last page must still disable Next');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sourcing: absent is not null
// ─────────────────────────────────────────────────────────────────────────────

test('productOrigin: an ABSENT supplier_sku answers nothing', () => {
  // The backend list returns pack_type and no supplier_sku at all.
  assert.equal(S.productOrigin({ pack_type: 'value_pack' }), null,
    'a field this view never fetched must not print "Assembled"');
  assert.equal(S.productOrigin({ pack_type: 'multipack' }), null);

  // Positive controls — the real derivation is untouched (GLC3317KCMY /
  // GLC3317CMY, the live pair this rule was written from).
  assert.equal(S.productOrigin({ pack_type: 'value_pack', supplier_sku: null }), 'in_house_pack');
  assert.equal(S.productOrigin({ pack_type: 'value_pack', supplier_sku: 'B3317CMY' }), 'supplier_pack');
  assert.equal(S.productOrigin({ pack_type: 'single' }), 'single',
    'a single needs no supplier code to be a single');
});

test('"sourcing data arrived" is decided by the supplier fields, not by pack_type', () => {
  // Both the warning and the enrichment used to return early when EITHER
  // supplier OR pack_type was present. The backend leg sends pack_type on every
  // row and supplier on none, so both switched themselves off on the one view
  // that needed them.
  assert.ok(!/\('supplier' in r \|\| 'pack_type' in r\)/.test(PRODUCTS),
    'pack_type is back in the presence test — it is not evidence that supplier arrived');
  const guards = (PRODUCTS.match(/'supplier' in r \|\| 'supplier_sku' in r/g) || []).length;
  assert.equal(guards, 2,
    'warnIfSourcingFieldsMissing and enrichSourcingFields must both ask about the supplier fields');
});

test('the fallback leg enriches sourcing and reports it when it cannot', () => {
  const fallback = PRODUCTS.slice(PRODUCTS.indexOf('// Fallback: use backend API'));
  assert.match(fallback, /enrichSourcingFields\(/,
    'the fallback must try to fill supplier/supplier_sku — that read needs no privileged column');
  assert.match(fallback, /warnIfSourcingFieldsMissing\(rows\)/,
    'and must say so when the dashes mean "not loaded" rather than "none"');
});
