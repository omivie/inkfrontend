'use strict';

/**
 * Admin Products — the Margin % / Profit $ sort is not the number in the cell
 * ============================================================================
 * ERR-311 (2026-10-07). Sorted by Margin % ascending, a $4.50 Dymo label showing
 * 3.8% sat among rows showing ~10.3%. The backend sorts `margin_pct` by the
 * stored GROSS column (no card fee, no $0.30); the cell shows
 * `net_margin_incl_fixed_pct`. Gross for the three neighbouring rows: 13.05%,
 * 13.1%, 13.2% — correctly ordered. The $0.30 is ~7.7 points on a $3.91 ex-GST
 * price, nothing on a $1,746 one.
 *
 * Until the backend can sort by the displayed key, the page must SAY so (header
 * title + a toast on every such backend sort). Separately, the Supabase leg's
 * client-side comparator read snake_case keys computeProfitability never
 * returns, so it compared -Infinity to -Infinity and sorted nothing.
 *
 * Run: node --test tests/admin-products-margin-sort-basis-oct2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/products.js'), 'utf8');
const SRC = stripComments(RAW);
const TABLE = stripComments(fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/components/table.js'), 'utf8'));

test('the note names the gross basis and the fixed fee', () => {
  const m = SRC.match(/const GROSS_SORT_NOTE = '([^']+)'/);
  assert.ok(m, 'GROSS_SORT_NOTE must exist');
  assert.match(m[1], /gross margin before fees/);
  assert.match(m[1], /\$0\.30/);
});

test('Margin % and Profit $ headers carry the note as their title', () => {
  for (const key of ['margin_pct', 'profit_ex_gst']) {
    const at = SRC.indexOf(`key: '${key}', label:`);
    assert.notEqual(at, -1, key);
    const block = SRC.slice(at, SRC.indexOf('cols.push', at));
    assert.match(block, /title: GROSS_SORT_NOTE/, `${key} header must explain its sort`);
  }
  assert.match(TABLE, /col\.title \? ` title="\$\{esc\(col\.title\)\}"`/, 'table.js must render col.title, escaped');
});

test('the backend leg warns on a margin/profit sort', () => {
  const leg = SRC.slice(SRC.indexOf('if (needsBackend) {'), SRC.indexOf('AdminAPI.getProducts(backendProductFilters()'));
  assert.match(leg, /warnGrossSort\(\)/);
  assert.match(SRC, /function warnGrossSort\(\) \{\s*if \(_sort === 'margin_pct' \|\| _sort === 'profit_ex_gst'\) Toast\.info\(GROSS_SORT_NOTE\)/);
});

test('client-side comparator reads keys computeProfitability actually returns', async () => {
  const { computeProfitability } = await import(path.join(ROOT, 'inkcartridges/js/admin/utils/profitability.js'));
  const m = SRC.match(/const key = _sort === 'profit_ex_gst' \? '(\w+)' : '(\w+)';/);
  assert.ok(m, 'comparator key line must exist');
  const p = computeProfitability({ retail_price: 4.5, cost_price: 3.4 });
  for (const k of [m[1], m[2]]) {
    assert.equal(typeof p[k], 'number', `computeProfitability() has no "${k}" — the sort would compare -Infinity`);
  }
  // Behavioural: the comparator orders by margin.
  const rows = [{ retail_price: 203.79, cost_price: 154.09 }, { retail_price: 10, cost_price: 8.5 }];
  const sorted = [...rows].sort((a, b) => computeProfitability(a)[m[2]] - computeProfitability(b)[m[2]]);
  assert.equal(sorted[0].retail_price, 10);
});
