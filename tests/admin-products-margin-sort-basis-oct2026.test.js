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
 * ERR-364 (2026-10-18): the backend now sorts by the displayed keys
 * (`net_margin_incl_fixed_pct`, `profit_incl_fixed_ex_gst`), so the columns map
 * to them and the warning note was deleted. Separately, the Supabase leg's
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

// ERR-364 (backend 2026-10-17, live since 2026-10-12): the backend sorts by the
// net keys the cells show, so each column sends the key that fills its cell and
// the "sorts by gross" note is gone.
test('Margin % / Profit $ sort by the NET key that fills the cell', () => {
  assert.match(SRC, /const NET_SORT_KEY = \{ margin_pct: 'net_margin_incl_fixed_pct', profit_ex_gst: 'profit_incl_fixed_ex_gst' \};/);
  assert.match(SRC, /sort: NET_SORT_KEY\[_sort\] \|\| _sort/, 'backendProductFilters maps the column key');
  assert.match(SRC, /r\.net_margin_incl_fixed_pct != null/, 'Margin % cell = net margin');
  assert.match(SRC, /r\.profit_incl_fixed_ex_gst != null/, 'Profit $ cell = net profit');
});

test('the gross-sort note and its toast are gone', () => {
  for (const gone of ['GROSS_SORT_NOTE', 'warnGrossSort', 'Sorts by gross margin']) {
    assert.ok(!SRC.includes(gone), `${gone} must not come back — the backend sorts by the net keys`);
  }
  assert.match(TABLE, /col\.title \? ` title="\$\{esc\(col\.title\)\}"`/, 'table.js still renders col.title for other headers');
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
