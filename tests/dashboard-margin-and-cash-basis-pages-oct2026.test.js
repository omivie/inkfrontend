/**
 * dashboard-margin-and-cash-basis-pages-oct2026.test.js — ERR-310
 *
 * Live 2026-10-07, /admin#dashboard?period=all:
 *   1. Net Margin tile read −139.0%. The real figure was −1.39%: fmtPct multiplied any
 *      |n| ≤ 1.5 by 100, guessing it was a fraction. Every caller passes a percent.
 *   2. Red banner "only 200 of 217 orders in range were read": the cash-basis fetch read
 *      one 200-row page, so the deduction refused and the strip fell back to accrual.
 *
 * Run: node --test tests/dashboard-margin-and-cash-basis-pages-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');

function lift(name) {
  const start = src.search(new RegExp(`\\n(?:async\\s+)?function\\s+${name}\\s*\\(`)) + 1;
  assert.ok(start > 0, `${name} not found in dashboard.js — renamed?`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

function load(AdminAPI) {
  const ctx = vm.createContext({ AdminAPI, Number, Array });
  vm.runInContext(`${lift('fmtPct')}\n${lift('getAllOrdersInRange')}\n`
    + 'this.fmtPct = fmtPct; this.getAllOrdersInRange = getAllOrdersInRange;', ctx);
  return ctx;
}

test('fmtPct prints a near-breakeven percent as itself, not ×100', () => {
  const { fmtPct } = load({});
  assert.equal(fmtPct(-1.39), '-1.4%', 'the live −139.0% tile');
  assert.equal(fmtPct(0.33), '0.3%');
  assert.equal(fmtPct(1.5), '1.5%');
  assert.equal(fmtPct(26.2), '26.2%');
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(null), null);
  assert.equal(fmtPct('x'), null);
});

function fakeOrders(total, { failPage = null } = {}) {
  const calls = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  return {
    calls,
    getOrders: async (filters, page, limit) => {
      calls.push({ filters, page, limit });
      if (page === failPage) return null;
      return { orders: all.slice((page - 1) * limit, page * limit), pagination: { total } };
    },
  };
}

test('217 orders over two pages: every row is read, oldest-first', async () => {
  const api = fakeOrders(217);
  const out = await load(api).getAllOrdersInRange('', '', null);
  assert.equal(out.orders.length, 217);
  assert.equal(out.pagination.total, 217);
  assert.deepEqual(api.calls.map(c => c.page), [1, 2]);
  assert.equal(api.calls[0].filters.order, 'asc');
});

test('one page is enough: no second request', async () => {
  const api = fakeOrders(150);
  const out = await load(api).getAllOrdersInRange('', '', null);
  assert.equal(out.orders.length, 150);
  assert.equal(api.calls.length, 1);
});

test('a failed page 2 returns a SHORT list, so the count check still refuses loudly', async () => {
  const api = fakeOrders(217, { failPage: 2 });
  const out = await load(api).getAllOrdersInRange('', '', null);
  assert.equal(out.orders.length, 200);
  assert.equal(out.pagination.total, 217, 'total kept, so buildCashBasis sees 200 < 217');
});

test('a failed page 1 passes the failure through (null, never an empty book)', async () => {
  const api = fakeOrders(217, { failPage: 1 });
  assert.equal(await load(api).getAllOrdersInRange('', '', null), null);
});

test('wired: the cash-basis slot uses the pager, not a single 200-row page', () => {
  assert.match(src, /getAllOrdersInRange\(from, to, signal\),\s*\/\/ 15/);
  assert.doesNotMatch(src, /getOrders\(\{ from, to \}, 1, 200, signal\)/);
});
