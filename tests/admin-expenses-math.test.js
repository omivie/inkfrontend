/**
 * expense-math.js — KPI, GST-netting and double-count-guard math
 * ==============================================================
 *
 * The accounting law of the Expenses page, pinned:
 *   1. Order-linked categories (inventory / merchant fees / courier) are ALREADY
 *      in per-order COGS/Stripe — they must be EXCLUDED from every operating /
 *      profit total and only surfaced separately. (The historical bug: opex
 *      summed them ON TOP, so "2 Jun expenses nearly = revenue".)
 *   2. GST-neutral: claimable NZ GST is reclaimed (3/23 of the gross), so only
 *      the ex-GST portion reduces profit; foreign/GST-free expenses hit at face.
 *
 * Run with: node --test tests/admin-expenses-math.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'expense-math.js');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map(id => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'expense-math.js' });

const approx = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
// Normalise sandbox-realm structures before deepEqual (prototype identity).
const plain = (x) => JSON.parse(JSON.stringify(x));

// ─── GST netting ─────────────────────────────────────────────────────────────
test('pnlCost nets the GST input credit only when claimable', () => {
  approx(sandbox.pnlCost(115, true), 100);   // 115 gross → 100 ex-GST reduces profit
  approx(sandbox.pnlCost(100, false), 100);  // foreign SaaS → full face value
});

test('gstCredit is 3/23 of a claimable gross, else 0', () => {
  approx(sandbox.gstCredit(115, true), 15);
  approx(sandbox.gstCredit(115, false), 0);
});

// ─── recurring commitment normalisation ──────────────────────────────────────
test('monthlyCommitment normalises every frequency to a monthly figure', () => {
  approx(sandbox.monthlyCommitment({ recurrence: 'monthly', amount: 100 }), 100);
  approx(sandbox.monthlyCommitment({ recurrence: 'yearly', amount: 1200 }), 100);
  approx(sandbox.monthlyCommitment({ recurrence: 'quarterly', amount: 300 }), 100);
  approx(sandbox.monthlyCommitment({ recurrence: 'weekly', amount: 100 }), 100 * 52 / 12);
  approx(sandbox.monthlyCommitment({ recurrence: 'fortnightly', amount: 100 }), 100 * 26 / 12);
  approx(sandbox.monthlyCommitment({ recurrence: 'custom', amount: 100, recurrence_interval_days: 30 }), 100 * 365 / 360);
  approx(sandbox.monthlyCommitment({ recurrence: 'none', amount: 100 }), 0);
});

test('recurringMonthlyCommitment sums only active recurring templates', () => {
  const total = sandbox.recurringMonthlyCommitment([
    { recurrence: 'monthly', amount: 100, series_state: 'active' },
    { recurrence: 'none', amount: 999 },                              // one-off → 0
    { recurrence: 'weekly', amount: 50, series_state: 'paused' },     // paused → 0
    { recurrence: 'yearly', amount: 1200, series_state: 'ended' },    // ended → 0
  ]);
  approx(total, 100);
});

// ─── double-count guard ──────────────────────────────────────────────────────
test('categoryBreakdown (operatingOnly) excludes order-linked categories', () => {
  const list = [
    { category: 'software', kind: 'operating', amount: 30 },
    { category: 'inventory', kind: 'order_linked', amount: 500 },
    { category: 'software', kind: 'operating', amount: 20 },
  ];
  const bd = plain(sandbox.categoryBreakdown(list, { operatingOnly: true }));
  assert.deepEqual(bd, [{ key: 'software', total: 50 }]);
});

test('bucketExpenses excludes order-linked and buckets by cash date', () => {
  const list = [
    { kind: 'operating', amount: 10, expense_date: '2026-07-05', paid: true, paid_date: '2026-07-05' },
    { kind: 'order_linked', amount: 999, expense_date: '2026-07-05' }, // must not appear
    { kind: 'operating', amount: 5, expense_date: '2026-07-20' },
  ];
  const b = sandbox.bucketExpenses(list, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 31), 'month');
  assert.equal(b.length, 1);
  approx(b[0].total, 15);
});

// ─── the full KPI bundle ─────────────────────────────────────────────────────
test('computeExpenseKpis: order-linked excluded, GST netted, statuses correct', () => {
  const list = [
    { category: 'software', kind: 'operating', amount: 115, gst_claimable: true, expense_date: '2026-07-05', due_date: '2026-07-05', status: 'paid', paid: true },
    { category: 'rent', kind: 'operating', amount: 200, gst_claimable: false, expense_date: '2026-07-02', due_date: '2026-07-04', status: 'overdue' },
    { category: 'marketing', kind: 'operating', amount: 50, gst_claimable: false, expense_date: '2026-07-11', due_date: '2026-07-11', status: 'due' },
    { category: 'software', kind: 'operating', amount: 80, gst_claimable: false, expense_date: '2026-06-15', due_date: '2026-06-15', status: 'paid', paid: true },
    { category: 'inventory', kind: 'order_linked', amount: 500, gst_claimable: true, expense_date: '2026-07-08', status: 'paid', paid: true },
    { category: 'utilities', kind: 'operating', amount: 90, gst_claimable: false, expense_date: '2026-07-21', due_date: '2026-07-21', status: 'scheduled', projected: true },
  ];
  const today = Date.UTC(2026, 6, 11);
  const k = sandbox.computeExpenseKpis(list, {
    monthStart: Date.UTC(2026, 6, 1), monthEnd: Date.UTC(2026, 6, 31),
    prevStart: Date.UTC(2026, 5, 1), prevEnd: Date.UTC(2026, 5, 30),
    next30Start: today, next30End: today + 30 * 86400000,
    revenueThisMonth: 1000,
    recurringTemplates: [{ recurrence: 'monthly', amount: 100, series_state: 'active' }],
  });

  approx(k.thisMonth, 455);        // operating in July: 115+200+50+90 (inventory 500 EXCLUDED)
  approx(k.lastMonth, 80);         // June software
  approx(k.pctChange, 468.75);
  approx(k.overdue, 200);
  approx(k.unpaid, 250);           // overdue 200 + due 50
  approx(k.upcoming30, 140);       // due today 50 + scheduled 07-21 90 (overdue 07-04 out of window)
  approx(k.operating, 535);        // all operating amounts
  approx(k.operatingPnl, 520);     // 100 (115 GST-netted) + 200 + 50 + 80 + 90
  approx(k.gstReclaim, 15);        // only the claimable software line
  approx(k.orderLinked, 500);      // reported separately, never in operating
  approx(k.expenseToRevenuePct, 45.5);
  approx(k.recurringMonthly, 100);
  assert.equal(k.largestCategory.key, 'rent');
  approx(k.largestCategory.total, 200);
});

test('computeExpenseKpis: no prior-month baseline → pctChange null, empty safe', () => {
  const k = sandbox.computeExpenseKpis([
    { category: 'software', kind: 'operating', amount: 60, gst_claimable: false, expense_date: '2026-07-05', status: 'paid', paid: true },
  ], {
    monthStart: Date.UTC(2026, 6, 1), monthEnd: Date.UTC(2026, 6, 31),
    prevStart: Date.UTC(2026, 5, 1), prevEnd: Date.UTC(2026, 5, 30),
    next30Start: Date.UTC(2026, 6, 11), next30End: Date.UTC(2026, 6, 11) + 30 * 86400000,
  });
  assert.equal(k.pctChange, null);
  assert.equal(k.expenseToRevenuePct, null); // no revenue provided
  const empty = sandbox.computeExpenseKpis([], {});
  approx(empty.thisMonth, 0);
  approx(empty.operating, 0);
});
