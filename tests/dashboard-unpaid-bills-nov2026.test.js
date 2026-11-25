/**
 * ERR-392 — Dashboard Net Profit: second line "after $X unpaid bills" (owner 2026-11-23)
 * =====================================================================================
 *
 * Net profit is cash basis for operating expenses: a bill counts only once marked PAID.
 * The owner wants to see what is left once the bills still owed are paid. The line reads
 * the server's /api/admin/expenses/summary `overdue_amount` + `due_amount` (the Expenses
 * page's Unpaid figure) and must say so LOUDLY when that read fails — never "no unpaid bills".
 *
 * Run with: node --test tests/dashboard-unpaid-bills-nov2026.test.js
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
  const m = src.match(new RegExp(`\\nfunction\\s+${name}\\s*\\(`));
  assert.ok(m, `${name} not found in dashboard.js — renamed?`);
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index + 1, i + 1);
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

const sandbox = { Number, Math };
sandbox.globalThis = sandbox;
sandbox.formatPrice = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
vm.runInContext(
  [lift('unpaidBillsOf'), lift('unpaidBillsSub')].join('\n\n')
  + '\n;globalThis.unpaidBillsOf = unpaidBillsOf; globalThis.unpaidBillsSub = unpaidBillsSub;',
  vm.createContext(sandbox), { filename: 'dashboard-lifted.js' });
const { unpaidBillsOf, unpaidBillsSub } = sandbox;

test('unpaidBillsOf sums overdue + due from either summary shape', () => {
  assert.equal(unpaidBillsOf({ summary: { overdue_amount: '120.50', due_amount: 79.5 } }), 200);
  assert.equal(unpaidBillsOf({ overdue_amount: 0, due_amount: 0 }), 0);
});

test('unpaidBillsOf is null when the read failed or is half-present (never a silent 0)', () => {
  assert.equal(unpaidBillsOf(null), null);
  assert.equal(unpaidBillsOf({ summary: { overdue_amount: 50 } }), null);
  assert.equal(unpaidBillsOf({ summary: { overdue_amount: 'x', due_amount: 1 } }), null);
});

test('unpaidBillsSub: what is left after the bills, or says why not', () => {
  assert.equal(unpaidBillsSub(-2957.43, 400), '-$3357.43 after $400.00 unpaid bills');
  assert.equal(unpaidBillsSub(100, 0), 'no unpaid bills');
  assert.match(unpaidBillsSub(100, null), /could not load/);
  assert.equal(unpaidBillsSub(100, undefined), '', 'old cached payload: no line, not a failure');
  assert.equal(unpaidBillsSub(null, 400), '', 'no net profit: nothing to subtract from');
});

test('wiring: summary fetched in the load, carried on the payload, shown under Net Profit', () => {
  assert.match(src, /AdminAPI\.expenses\.summary\(\{ from, to \}\)/);
  assert.match(src, /unpaidBills: unpaidBillsOf\(val\(14\)\)/);
  assert.match(src, /unpaidBillsSub\(netProfit, d\.unpaidBills\)/);
});

test('Net Profit tile names no single expense — no "after $X supplier freight" line (owner 2026-11-23)', () => {
  assert.doesNotMatch(src, /supplier freight`/, 'freight sub line is back on the Net Profit tile');
  assert.match(src, /sub: unpaidBillsSub\(netProfit, d\.unpaidBills\)/);
});
