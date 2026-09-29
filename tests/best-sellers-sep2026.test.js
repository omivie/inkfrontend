/**
 * Best Sellers — revenue / units / orders rankings (dashboard card + Performance tab).
 *
 * Facts re-measured 2026-09-29 by `npm run probe:best-sellers` after the backend
 * built BF-089/BF-090 (ERR-299; see utils/best-sellers.js header):
 *   - top-products-rpc returns ONE ROW PER PRODUCT: 199 rows, 199 distinct SKUs.
 *     `sale_skus` lists every SKU it was sold under (C62XLBK <- C62BK).
 *   - brand, product_type, pack_type, source ride on every row; pack_type null
 *     marks a product that no longer exists. No client catalogue read.
 *   - status/category/supplier/brand filters BITE; an unknown status or an
 *     unknown parameter is 400 VALIDATION_FAILED.
 *
 *   §1 normalizeRows maps the server row, keeps absent as absent, counts dupes
 *   §2 rankings order by the chosen metric
 *   §3 "not in catalogue" is the server's pack_type null
 *   §4 type/pack filters count what they could not place
 *   §5 wiring: dashboard card → hub tab, filters, escaping, cache schema
 *
 * Run with: node --test tests/best-sellers-sep2026.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRows, rankBy, metricIncomplete, filterItems, TOP_PRODUCTS_MAX_LIMIT, CATEGORY_OPTIONS,
} from '../inkcartridges/js/admin/utils/best-sellers.js';
import { stripComments } from './helpers/strip-comments.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', ...p), 'utf8');

// Live rows, 2026-09-29 (product_id trimmed). C62XLBK was sold as C62BK.
const LIVE = [
  { product_sku: 'G206XKCMY', product_name: 'HP Genuine 206XKCMY Toner Cartridge 206X KCMY 4-Pack', revenue: 1680, units_sold: 2, order_count: 2,
    sale_skus: ['G206XKCMY'], brand: 'HP', product_type: 'toner_cartridge', pack_type: 'value_pack', source: 'genuine' },
  { product_sku: 'C1030', product_name: 'Brother 1030 Ribbon', revenue: 437.43, units_sold: 21, order_count: 3,
    sale_skus: ['C1030'], brand: 'Brother', product_type: 'typewriter_ribbon', pack_type: 'single', source: 'compatible' },
  { product_sku: 'C62XLBK', product_name: 'HP 62XL Ink Cartridge Black - Compatible', revenue: 120, units_sold: 3, order_count: 3,
    sale_skus: ['C62BK'], brand: 'HP', product_type: 'ink_cartridge', pack_type: 'single', source: 'compatible' },
];

test('§1 normalizeRows maps the server row and never merges', () => {
  const { items, dupSkus } = normalizeRows(LIVE);
  assert.equal(items.length, 3);
  assert.equal(dupSkus, 0);
  const c62 = items.find(i => i.sku === 'C62XLBK');
  assert.deepEqual([c62.revenue, c62.units, c62.orders], [120, 3, 3]);
  assert.deepEqual([c62.brand, c62.productType, c62.packType, c62.source], ['HP', 'ink_cartridge', 'single', 'compatible']);
  assert.deepEqual(c62.saleSkus, ['C62BK'], 'order lines carry the sale-time SKU — the reconciliation key');
  assert.deepEqual(c62.soldAs, ['C62BK']);
  assert.deepEqual(items.find(i => i.sku === 'C1030').soldAs, [], 'a SKU sold under itself is not "sold as" anything');
});

test('§1 an absent figure stays absent — never zero', () => {
  const { items } = normalizeRows([{ product_sku: 'A', revenue: 10, units_sold: 1, pack_type: 'single' }]);
  assert.equal(items[0].orders, null);
  assert.equal(normalizeRows(null).items.length, 0);
});

test('§1 a SKU on two rows is COUNTED (a BF-089 regression), not silently summed', () => {
  const { items, dupSkus } = normalizeRows([LIVE[0], { ...LIVE[0], revenue: 1 }]);
  assert.equal(items.length, 2, 'both rows kept — the page says the totals are split');
  assert.equal(dupSkus, 1);
});

test('§2 each metric ranks by itself', () => {
  const { items } = normalizeRows(LIVE);
  assert.deepEqual(rankBy(items, 'revenue').map(i => i.sku), ['G206XKCMY', 'C1030', 'C62XLBK']);
  assert.deepEqual(rankBy(items, 'units').map(i => i.sku), ['C1030', 'C62XLBK', 'G206XKCMY']);
  assert.deepEqual(rankBy(items, 'orders').map(i => i.sku), ['C1030', 'C62XLBK', 'G206XKCMY']);
  assert.equal(metricIncomplete(items, 'orders'), false);
  assert.equal(metricIncomplete([{ orders: null }], 'orders'), true);
});

test('§3 a product that no longer exists (pack_type null) is not in the catalogue', () => {
  const { items } = normalizeRows([{ ...LIVE[2], pack_type: null }]);
  assert.equal(items[0].inCatalog, false);
  assert.equal(items[0].brand, 'HP', 'brand/type still come from the order-line snapshot');
  assert.equal(normalizeRows(LIVE).items.every(i => i.inCatalog), true);
});

test('§4 type/pack filters drop unplaceable rows and COUNT them', () => {
  const { items } = normalizeRows([...LIVE, { product_sku: 'GONE', revenue: 1, product_type: 'ink_cartridge', pack_type: null }]);
  assert.equal(filterItems(items, {}).items.length, 4, 'no filter: nothing dropped');
  const packs = filterItems(items, { pack: 'packs' });
  assert.deepEqual(packs.items.map(i => i.sku), ['G206XKCMY']);
  assert.equal(packs.unplaced, 1, 'GONE is not in the catalogue — counted, not silently hidden');
  assert.deepEqual(filterItems(items, { type: 'ribbon' }).items.map(i => i.sku), ['C1030']);
  assert.deepEqual(filterItems(items, { type: 'ink' }).items.map(i => i.sku), ['C62XLBK']);
});

test('§4 category options are products.category CODES, never storefront slugs', () => {
  const values = CATEGORY_OPTIONS.map(o => o.value);
  assert.ok(values.includes('CON-INK') && values.includes('CON-LASER'));
  for (const v of values) assert.match(v, /^(CON|HW)-[A-Z0-9]+$/, `${v}: category_filter=ink returns 0 rows (measured)`);
});

test('§5 the loader asks for the server cap and flags a full response as truncated', () => {
  const api = stripComments(read('api.js'));
  assert.equal(TOP_PRODUCTS_MAX_LIMIT, 500, 'the server rejects result_limit > 500 (measured)');
  assert.match(api, /result_limit:\s*TOP_PRODUCTS_MAX_LIMIT/);
  assert.match(api, /truncated:\s*raw\.length\s*>=\s*TOP_PRODUCTS_MAX_LIMIT/);
  assert.doesNotMatch(api, /getTopProducts/, 'the top-10-by-revenue call is retired: a units/orders top 10 needs the full set');
});

test('§5 dashboard card: three rankings, "View all" to the hub tab, cache schema bumped', () => {
  const dash = stripComments(read('pages', 'dashboard.js'));
  assert.match(dash, /AdminAPI\.getBestSellers\(params, signal\)/);
  assert.match(dash, /href="#analytics\?tab=best-sellers"/);
  assert.match(dash, /wireTopProductsToggle\(\);/);
  assert.match(dash, /const DASH_CACHE_SCHEMA = 4;/, 'topProducts changed shape again (BF-089): an old cached payload must not reach render()');
  assert.match(dash, /esc\(data\?\.error \|\| 'Top product data unavailable'\)/, 'a refusal is shown, escaped, not read as "no sales"');
  assert.doesNotMatch(dash, /\$\{p\.(name|brand|sku)\}/, 'every product field goes through esc()');
});

test('§5 hub tab: registered, shows the filters the endpoint honours, escapes cells', () => {
  const tabs = read('utils', 'analytics-tabs.js');
  assert.match(tabs, /id: 'best-sellers',\s*label: 'Best Sellers',\s*lazy: '\.\/best-sellers\.js'/);
  const page = stripComments(read('pages', 'best-sellers.js'));
  assert.match(page, /setVisibleFilters\(\['period', 'brands', 'suppliers', 'statuses', 'categories'\]\)/,
    'every filter bites since BF-090 (probe §5 negative controls)');
  assert.match(page, /esc\(_data\?\.error/, 'a 400 names what the server refused');
  assert.match(page, /sold as \$\{esc\(p\.soldAs\.join/, 'the sale-time SKUs are shown — the orders reconciliation key');
  assert.match(page, /setVisibleFilters\(null\)/, 'destroy() must restore the bar for the next tab');
  assert.doesNotMatch(page, /\$\{p\.(name|brand|sku)\}/, 'every product field goes through esc()');
  assert.match(page, /unplaced/, 'the page must say how many products a filter could not place');
});

test('§5 the category filter is OPT-IN: shown only where a page asks for it', () => {
  const filters = stripComments(read('filters.js'));
  assert.match(filters, /if \(visible && visible\.includes\('categories'\)\)/,
    'pages that never listed categories must not suddenly show a filter their endpoints may ignore');
  assert.doesNotMatch(filters, /!visible \|\| visible\.includes\('categories'\)/);
  const app = stripComments(read('app.js'));
  assert.match(app, /FilterState\.setOptions\('categories', CATEGORY_OPTIONS\)/);
});

test('§5 the loader keeps no client catalogue read or merge', () => {
  const api = stripComments(read('api.js'));
  assert.doesNotMatch(api, /getProductMetaBySku|mergeBySku|attachCatalog/);
  assert.match(api, /normalizeRows\(raw\)/);
});
