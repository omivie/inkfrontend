/**
 * Best Sellers — revenue / units / orders rankings (dashboard card + Performance tab).
 *
 * Facts measured 2026-09-28 by `npm run probe:best-sellers` and a reconciliation
 * against the orders list (see utils/best-sellers.js header):
 *   - top-products-rpc returns ONE SKU AS SEVERAL ROWS (one per historical name).
 *     Merged by SKU, 202/202 SKUs matched the non-cancelled orders exactly.
 *   - order_count is on every row; brand is on none.
 *   - 33 of 202 sold SKUs are no longer in the catalogue.
 *
 *   §1 merge by SKU sums, keeps absent as absent, names by revenue
 *   §2 rankings order by the chosen metric
 *   §3 catalogue facts: "not in catalogue" ≠ "lookup failed"
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
  mergeBySku, rankBy, metricIncomplete, attachCatalog, filterItems, TOP_PRODUCTS_MAX_LIMIT,
} from '../inkcartridges/js/admin/utils/best-sellers.js';
import { stripComments } from './helpers/strip-comments.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', ...p), 'utf8');

// The live shape of the duplicate (CLC431XLKCMY, 2026-09-28).
const LIVE = [
  { product_name: 'HP 206X KCMY 4-Pack', product_sku: 'G206XKCMY', revenue: 1680, units_sold: 2, order_count: 2 },
  { product_name: 'LC431XLKCMY … 4-Pack (500 pages)', product_sku: 'CLC431XLKCMY', revenue: 120, units_sold: 2, order_count: 2 },
  { product_name: 'Brother 1030 Ribbon', product_sku: 'C1030', revenue: 437.43, units_sold: 21, order_count: 3 },
  { product_name: 'LC431XLKCMY … 4-Pack', product_sku: 'CLC431XLKCMY', revenue: 60, units_sold: 1, order_count: 1 },
];

test('§1 one SKU returned as two rows is merged into one product with summed figures', () => {
  const m = mergeBySku(LIVE);
  assert.equal(m.length, 3);
  const lc = m.find(i => i.sku === 'CLC431XLKCMY');
  assert.deepEqual([lc.revenue, lc.units, lc.orders], [180, 3, 3]);
  assert.equal(lc.name, 'LC431XLKCMY … 4-Pack (500 pages)', 'the name carrying the most revenue wins');
});

test('§1 an absent figure stays absent through the merge — never summed as zero', () => {
  const m = mergeBySku([
    { product_sku: 'A', revenue: 10, units_sold: 1 },            // no order_count
    { product_sku: 'A', revenue: 5, units_sold: 1, order_count: 1 },
  ]);
  assert.equal(m[0].orders, null);
  assert.equal(m[0].revenue, 15);
});

test('§2 each metric ranks by itself', () => {
  const m = mergeBySku(LIVE);
  assert.deepEqual(rankBy(m, 'revenue').map(i => i.sku), ['G206XKCMY', 'C1030', 'CLC431XLKCMY']);
  assert.deepEqual(rankBy(m, 'units').map(i => i.sku), ['C1030', 'CLC431XLKCMY', 'G206XKCMY']);
  assert.deepEqual(rankBy(m, 'orders').map(i => i.sku), ['C1030', 'CLC431XLKCMY', 'G206XKCMY']);
  assert.equal(metricIncomplete(m, 'orders'), false);
  assert.equal(metricIncomplete([{ orders: null }], 'orders'), true);
});

test('§3 a SKU gone from the catalogue is `false`; a FAILED lookup is `null` (unknown)', () => {
  const m = mergeBySku(LIVE);
  const meta = new Map([['G206XKCMY', { brand: 'HP', product_type: 'toner_cartridge', pack_type: 'value_pack' }]]);
  const a = attachCatalog(m, meta);
  assert.equal(a.find(i => i.sku === 'G206XKCMY').brand, 'HP');
  assert.equal(a.find(i => i.sku === 'C1030').inCatalog, false);
  assert.equal(attachCatalog(m, null)[0].inCatalog, null);
});

test('§4 type/pack filters drop unplaceable rows and COUNT them', () => {
  const items = attachCatalog(mergeBySku(LIVE), new Map([
    ['G206XKCMY', { product_type: 'toner_cartridge', pack_type: 'value_pack' }],
    ['C1030', { product_type: 'typewriter_ribbon', pack_type: 'single' }],
  ]));
  assert.deepEqual(filterItems(items, {}).items.length, 3, 'no filter: nothing dropped');
  const packs = filterItems(items, { pack: 'packs' });
  assert.deepEqual(packs.items.map(i => i.sku), ['G206XKCMY']);
  assert.equal(packs.unplaced, 1, 'CLC431XLKCMY is not in the catalogue — counted, not silently hidden');
  assert.deepEqual(filterItems(items, { type: 'ribbon' }).items.map(i => i.sku), ['C1030']);
  assert.deepEqual(filterItems(items, { type: 'ink' }).items, []);
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
  assert.match(dash, /const DASH_CACHE_SCHEMA = 3;/, 'topProducts changed shape: an old cached array must not reach render()');
  assert.doesNotMatch(dash, /\$\{p\.(name|brand|sku)\}/, 'every product field goes through esc()');
});

test('§5 hub tab: registered, shows only the filters the endpoint honours, escapes cells', () => {
  const tabs = read('utils', 'analytics-tabs.js');
  assert.match(tabs, /id: 'best-sellers',\s*label: 'Best Sellers',\s*lazy: '\.\/best-sellers\.js'/);
  const page = stripComments(read('pages', 'best-sellers.js'));
  assert.match(page, /setVisibleFilters\(\['period', 'brands'\]\)/,
    'status/category filters are IGNORED by top-products-rpc (probe §5) — offering them would lie');
  assert.match(page, /setVisibleFilters\(null\)/, 'destroy() must restore the bar for the next tab');
  assert.doesNotMatch(page, /\$\{p\.(name|brand|sku)\}/, 'every product field goes through esc()');
  assert.match(page, /unplaced/, 'the page must say how many products a filter could not place');
});
