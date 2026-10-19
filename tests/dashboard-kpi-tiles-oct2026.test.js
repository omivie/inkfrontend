/**
 * ERR-366 — dashboard KPI tiles that disagreed with the live API (measured 2026-10-20)
 * ===================================================================================
 *
 * An all-time audit of every dashboard tile against the live admin API found:
 *
 *   1. Out of Stock read 0. `/api/admin/margin/out-of-stock` answers
 *      `{ok, data:{out_of_stock:[5 rows], total_out_of_stock:530, pagination:{total:530}}}`
 *      and the reader looked for `total` / `items` — neither exists.
 *   2. Returning % read 0% on "All". The backend counts a buyer as returning when they
 *      ordered BEFORE the range; all time has no "before", so 0 is by construction.
 *   3. Refund Rate's tooltip said "value ÷ revenue"; the backend figure is a COUNT ratio
 *      (1 refunded order of 226 = 0.4%; by value it would be 0.04%).
 *
 * Run with: node --test tests/dashboard-kpi-tiles-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');

function lift(name) {
  const re = new RegExp(`(?:^|\\n)(?:const\\s+${name}\\s*=|function\\s+${name}\\s*\\()`);
  const m = src.match(re);
  assert.ok(m, `${name} not found in dashboard.js — renamed?`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = src.indexOf('{', src.indexOf(name, start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      return src.slice(start, src.indexOf(';', i) === i + 1 ? i + 2 : i + 1);
    }
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

const sandbox = { Number, Array, Object };
sandbox.globalThis = sandbox;
vm.runInContext(
  [lift('numOrNull'), lift('firstArray'), lift('outOfStockCount')].join('\n\n')
  + '\n;globalThis.outOfStockCount = outOfStockCount;',
  vm.createContext(sandbox), { filename: 'dashboard-lifted.js' });
const { outOfStockCount } = sandbox;

/** Live shape, 2026-10-20 (rows trimmed). */
const LIVE_OOS = {
  ok: true,
  data: {
    out_of_stock: [{ sku: 'GDK22606Y' }, { sku: 'GDK44605Y' }, {}, {}, {}],
    total_out_of_stock: 530,
    total_genuine_products: 3214,
    pagination: { page: 1, limit: 5, total: 530, total_pages: 106 },
  },
};

test('Out of Stock reads the backend total, not the 5-row page', () => {
  assert.equal(outOfStockCount(LIVE_OOS), 530);
  assert.equal(outOfStockCount(LIVE_OOS.data), 530, 'unwrapped payload works too');
});

test('Out of Stock falls back to pagination.total, then the row count', () => {
  assert.equal(outOfStockCount({ data: { out_of_stock: [{}], pagination: { total: 7 } } }), 7);
  assert.equal(outOfStockCount({ data: { out_of_stock: [{}, {}] } }), 2);
  assert.equal(outOfStockCount({ ok: true, data: { out_of_stock: [], total_out_of_stock: 0 } }), 0);
});

test('Out of Stock: a failed fetch stays unknown, never 0', () => {
  assert.equal(outOfStockCount(null), null);
});

test('Returning % shows "—" on All, the backend 0 is by construction', () => {
  const tile = src.slice(src.indexOf("label: 'Returning %'"));
  const body = tile.slice(0, tile.indexOf('},'));
  assert.match(body, /value: noDelta \? null/);
  assert.match(body, /raw: noDelta \? null/);
  assert.match(body, /no earlier period to return from/);
});

test('Refund Rate tooltip names the count basis the backend uses', () => {
  const tile = src.slice(src.indexOf("label: 'Refund Rate'"));
  const body = tile.slice(0, tile.indexOf('},'));
  assert.match(body, /Refunded orders ÷ orders \(a count, not a value\)/);
  assert.ok(!/Refunded value ÷ revenue/.test(body));
});
