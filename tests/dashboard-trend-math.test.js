/**
 * dashboard-trend-math.js — Revenue & Expenses chart math
 * ========================================================
 *
 * Pins the math the admin dashboard uses to render the Revenue & Expenses
 * chart and the totals strip beneath it. The chart MUST account for every
 * dollar that left the company in a given window — COGS, operating expenses,
 * Stripe fees, and GST remitted. If any of these silently slip back to zero
 * we lose the ability to read profit/loss at a glance.
 *
 * Background (set by user 2026-05-08):
 *   - Backend /api/admin/analytics/pnl rarely populates per-period cogs, but
 *     the KPI summary (analytics_kpi_summary) reliably reports gross_profit.
 *     So COGS = revenue − gross_profit, distributed by bucket revenue.
 *   - /api/admin/analytics/expenses is the source of truth for opex (manually
 *     logged supplier purchases, marketing, etc.). Each row is bucketed at
 *     the day it happened.
 *   - Stripe + GST derive from gross order revenue + count using NZ rates.
 *
 * Run with: node --test tests/dashboard-trend-math.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'trend-math.js'
);

function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  const footer = '\n;' + [...exposed]
    .map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
  return stripped + footer;
}

const sandbox = {
  console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(
  stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')),
  ctx,
  { filename: 'trend-math.js' }
);

// Canonical profit math (profitability.js) loaded into its own sandbox so the
// GST-neutral cross-validation tests can assert the dashboard's bucket math
// EQUALS the single source of truth used by every order's detail modal.
const PROFITABILITY_PATH = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'profitability.js'
);
const profSandbox = {
  console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date,
};
profSandbox.globalThis = profSandbox;
const profCtx = vm.createContext(profSandbox);
vm.runInContext(
  stripEsm(fs.readFileSync(PROFITABILITY_PATH, 'utf8')),
  profCtx,
  { filename: 'profitability.js' }
);

// ─── Constants ──────────────────────────────────────────────────────────────

test('STRIPE_RATE_DERIVE is 2.65% (NZ domestic card, stripe.com/nz/pricing)', () => {
  assert.equal(sandbox.STRIPE_RATE_DERIVE, 0.0265);
});

test('STRIPE_FIXED_DERIVE is $0.30 per transaction', () => {
  assert.equal(sandbox.STRIPE_FIXED_DERIVE, 0.30);
});

test('STRIPE_FEE_GST_DERIVE is 15% (GST Stripe charges on top of its fee)', () => {
  assert.equal(sandbox.STRIPE_FEE_GST_DERIVE, 0.15);
});

test('GST_FRACTION_OF_GROSS is 3/23 — output GST embedded in incl-GST sale', () => {
  assert.equal(sandbox.GST_FRACTION_OF_GROSS, 3 / 23);
  // Sanity: a $115 gross sale carries $15 GST.
  const gross = 115;
  const gst = gross * sandbox.GST_FRACTION_OF_GROSS;
  assert.ok(Math.abs(gst - 15) < 0.001, `expected $15 GST on $115 gross, got ${gst}`);
});

test('COST_GST_GROSS_UP is 1.15 — supplier paid incl-GST', () => {
  assert.equal(sandbox.COST_GST_GROSS_UP, 1.15);
});

// ─── deriveStripe / deriveGst ────────────────────────────────────────────────

test('deriveStripe: 31 orders × $1,277.36 → (2.65% + 31 × $0.30) × 1.15 ≈ $49.62', () => {
  // Matches the dashboard fixture in the user screenshot (3m window).
  // 1277.36 * 0.0265   = 33.8500
  // 31 * 0.30          =  9.30
  // base               = 43.1500
  // × 1.15 (GST on fee) = 49.6225
  const fee = sandbox.deriveStripe(1277.36, 31);
  assert.ok(Math.abs(fee - 49.6225) < 0.01, `expected ~$49.62, got ${fee}`);
});

test('deriveStripe: zero revenue + zero orders → $0', () => {
  assert.equal(sandbox.deriveStripe(0, 0), 0);
});

test('deriveStripe: 0 orders does not add the $0.30 fixed fee', () => {
  // No transactions, no fixed fee. Real-world: an empty bucket.
  // Fee is still grossed up by 1.15 for GST on the fee.
  const expected = 100 * sandbox.STRIPE_RATE_DERIVE * 1.15;
  assert.ok(Math.abs(sandbox.deriveStripe(100, 0) - expected) < 1e-9);
});

test('deriveGst: $1,277.36 gross → ~$166.61 (matches dashboard chip)', () => {
  const gst = sandbox.deriveGst(1277.36);
  assert.ok(Math.abs(gst - 166.612) < 0.01, `expected ~$166.61, got ${gst}`);
});

test('deriveGst: handles non-numeric input safely', () => {
  assert.equal(sandbox.deriveGst(null), 0);
  assert.equal(sandbox.deriveGst(undefined), 0);
  assert.equal(sandbox.deriveGst('not a number'), 0);
});

// ─── distributeCogsByRevenue ────────────────────────────────────────────────

test('distributeCogsByRevenue: total COGS split across buckets in revenue proportion', () => {
  // Corrected COGS for the screenshot fixture: kpiCogsInclGst(1277.36, 557.48)
  // = 1277.36/1.15 − 557.48 ≈ $553.27 to spread across the visible window.
  const COGS = 553.27;
  const buckets = [
    { revenue: 358.24, cogsDerived: 0 },  // 3 May
    { revenue: 358.24, cogsDerived: 0 },  // 5 Apr
    { revenue: 165, cogsDerived: 0 },
    { revenue: 117.97, cogsDerived: 0 },
    { revenue: 277.91, cogsDerived: 0 },
  ];
  sandbox.distributeCogsByRevenue(buckets, COGS);
  const totalRev = 358.24 + 358.24 + 165 + 117.97 + 277.91;
  for (const b of buckets) {
    const expected = COGS * (b.revenue / totalRev);
    assert.ok(Math.abs(b.cogsDerived - expected) < 0.01,
      `bucket rev=${b.revenue}: expected ${expected}, got ${b.cogsDerived}`);
  }
  const sumDerived = buckets.reduce((s, b) => s + b.cogsDerived, 0);
  assert.ok(Math.abs(sumDerived - COGS) < 0.01,
    `derived sum should equal total cogs, got ${sumDerived}`);
});

test('distributeCogsByRevenue: zero total revenue is a no-op (no NaN)', () => {
  const buckets = [
    { revenue: 0, cogsDerived: 0 },
    { revenue: 0, cogsDerived: 0 },
  ];
  sandbox.distributeCogsByRevenue(buckets, 100);
  for (const b of buckets) assert.equal(b.cogsDerived, 0);
});

test('distributeCogsByRevenue: invalid totalCogs is a no-op', () => {
  const buckets = [{ revenue: 100, cogsDerived: 0 }];
  sandbox.distributeCogsByRevenue(buckets, NaN);
  assert.equal(buckets[0].cogsDerived, 0);
  sandbox.distributeCogsByRevenue(buckets, -50);
  assert.equal(buckets[0].cogsDerived, 0);
});

// ─── bucketOperatingExpenses ────────────────────────────────────────────────

test('bucketOperatingExpenses: a 3 May supplier purchase lands on the 3 May bucket', () => {
  // Reproduces the user's 2026-05-08 complaint: they bought cartridges on
  // 3 May, the expense should appear on 3 May, not smeared across the month.
  const buckets = [
    { startMs: Date.UTC(2026, 3, 26), opexLogged: 0, hasOpexLogged: false }, // 26 Apr
    { startMs: Date.UTC(2026, 4, 3),  opexLogged: 0, hasOpexLogged: false }, //  3 May
    { startMs: Date.UTC(2026, 4, 10), opexLogged: 0, hasOpexLogged: false }, // 10 May
  ];
  const indexFor = (ts) => {
    const d = new Date(ts);
    const ymd = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (ymd === '2026-3-26') return 0;
    if (ymd === '2026-4-3')  return 1;
    if (ymd === '2026-4-10') return 2;
    return -1;
  };
  const rows = [
    { expense_date: '2026-05-03', amount: 250.00, category: 'cogs', vendor: 'Cartridge supplier' },
    { expense_date: '2026-05-03', amount:  45.00, category: 'shipping' },
    { expense_date: '2026-04-26', amount:  30.00, category: 'software' },
    { date:         '2026-05-10', total:   12.00, category: 'other' },
  ];
  sandbox.bucketOperatingExpenses(buckets, rows, indexFor);
  assert.equal(buckets[0].opexLogged, 30.00);
  assert.equal(buckets[1].opexLogged, 295.00);   // 250 + 45 on 3 May
  assert.equal(buckets[2].opexLogged, 12.00);
  for (const b of buckets) assert.equal(b.hasOpexLogged, true);
});

test('bucketOperatingExpenses: rows without a date are skipped, not crashed', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(
    buckets,
    [{ amount: 100 }, { expense_date: '', amount: 50 }, { expense_date: 'not a date', amount: 25 }],
    () => 0,
  );
  assert.equal(buckets[0].opexLogged, 0);
  assert.equal(buckets[0].hasOpexLogged, false);
});

test('bucketOperatingExpenses: dates outside the window are dropped', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(
    buckets,
    [{ expense_date: '2020-01-01', amount: 999 }],
    () => -1, // simulate "date is before window"
  );
  assert.equal(buckets[0].opexLogged, 0);
});

test('bucketOperatingExpenses: handles non-array input', () => {
  const buckets = [{ startMs: 0, opexLogged: 0, hasOpexLogged: false }];
  sandbox.bucketOperatingExpenses(buckets, null, () => 0);
  sandbox.bucketOperatingExpenses(buckets, undefined, () => 0);
  sandbox.bucketOperatingExpenses(buckets, { not: 'an array' }, () => 0);
  assert.equal(buckets[0].opexLogged, 0);
});

// ─── pickExpenseDate / pickExpenseAmount ─────────────────────────────────────

test('pickExpenseDate prefers expense_date, then date, then created_at', () => {
  assert.equal(sandbox.pickExpenseDate({ expense_date: 'A', date: 'B', created_at: 'C' }), 'A');
  assert.equal(sandbox.pickExpenseDate({ date: 'B', created_at: 'C' }), 'B');
  assert.equal(sandbox.pickExpenseDate({ created_at: 'C' }), 'C');
  assert.equal(sandbox.pickExpenseDate({ createdAt: 'D' }), 'D');
  assert.equal(sandbox.pickExpenseDate({}), null);
  assert.equal(sandbox.pickExpenseDate(null), null);
});

test('pickExpenseAmount prefers amount, then total, then value', () => {
  assert.equal(sandbox.pickExpenseAmount({ amount: 10, total: 20, value: 30 }), 10);
  assert.equal(sandbox.pickExpenseAmount({ total: 20, value: 30 }), 20);
  assert.equal(sandbox.pickExpenseAmount({ value: 30 }), 30);
  assert.equal(sandbox.pickExpenseAmount({}), 0);
  assert.equal(sandbox.pickExpenseAmount({ amount: 'not a number' }), 0);
});

// ─── assembleBucketExpense ───────────────────────────────────────────────────

test('assembleBucketExpense: P&L cogs trumps revenue-distributed cogs', () => {
  const b = {
    revenue: 1000, orders: 5,
    pnlCogs: 600, hasPnlCogs: true, cogsDerived: 999,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.cogsTotal, 600);
});

test('assembleBucketExpense: derived path when P&L is empty', () => {
  // Matches the dashboard fixture: rev $1,277.36 across 31 orders, no P&L data.
  // GST-NEUTRAL model (2026-06-05): the GST line is NET remitted, not gross output.
  // Stripe   = (1277.36 × 0.0265 + 31 × 0.30) × 1.15                 ≈ 49.6225
  // GST_net  = (1277.36 − 553.27 − 49.6225) × 3/23                   ≈ 87.974
  // COGS     = kpiCogsInclGst(1277.36, 557.48) = 1277.36/1.15 − 557.48 ≈ 553.27
  // Expenses = 553.27 + 49.6225 + 87.974                             ≈ 690.87
  // Net      = 1277.36 − 690.87                                      ≈ 586.49
  // (Net also = (revenue − cogs − stripe) / 1.15 = 674.4675/1.15 — GST-neutral.)
  const b = {
    revenue: 1277.36, orders: 31,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 553.27,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.cogsTotal, 553.27);
  assert.equal(b.opexTotal, 0);
  assert.ok(Math.abs(b.stripeTotal - 49.6225) < 0.01);
  assert.ok(Math.abs(b.gstTotal    - 87.974) < 0.01, `net GST, got ${b.gstTotal}`);
  assert.ok(Math.abs(b.expenses - 690.87) < 0.05, `expenses=${b.expenses}`);
  assert.ok(Math.abs(b.net - 586.49) < 0.05, `expected GST-neutral net ~$586.49, got ${b.net}`);
  // GST-neutral identity: net === (revenue − cogs − stripe) / 1.15 exactly.
  assert.ok(Math.abs(b.net - (b.revenue - b.cogsTotal - b.stripeTotal) / 1.15) < 1e-9);
  assert.equal(b.hasExpense, true);
});

test('assembleBucketExpense: opex logged on the same day shows up', () => {
  // The user's 3 May supplier purchase scenario (net-GST model).
  // Stripe   = (358.24 × 0.0265 + 1 × 0.30) × 1.15        ≈ 11.26
  // GST_net  = (358.24 − 220 − 11.26) × 3/23              ≈ 16.56
  // Expenses = 220 + 250 + 11.26 + 16.56                 ≈ 497.82
  // Net      = 358.24 − 497.82                            ≈ −139.6 (loss; opex dominates)
  const b = {
    revenue: 358.24, orders: 1,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 220,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 250,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.opexTotal, 250);
  assert.ok(b.net < 0, `expected a loss when opex blows past revenue, got net=${b.net}`);
});

test('assembleBucketExpense: zero revenue + zero opex → all-zero expenses', () => {
  const b = {
    revenue: 0, orders: 0,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.expenses, 0);
  assert.equal(b.hasExpense, false);
  assert.equal(b.net, 0);
});

// ─── sumTrendTotals ─────────────────────────────────────────────────────────

test('sumTrendTotals: sums every component across the window', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, opexTotal: 5,  stripeTotal: 5, gstTotal: 10, orders: 2 },
    { revenue: 200, expenses: 110, cogsTotal: 80, opexTotal: 10, stripeTotal: 8, gstTotal: 12, orders: 3 },
  ];
  const t = sandbox.sumTrendTotals(series);
  assert.equal(t.revenue, 300);
  assert.equal(t.expenses, 170);
  assert.equal(t.cogs, 120);
  assert.equal(t.opex, 15);
  assert.equal(t.stripe, 13);
  assert.equal(t.gst, 22);
  assert.equal(t.orders, 5);
});

test('sumTrendTotals: empty / nullish series returns zeros, no crash', () => {
  for (const v of [null, undefined, []]) {
    const t = sandbox.sumTrendTotals(v);
    assert.equal(t.revenue, 0);
    assert.equal(t.expenses, 0);
    assert.equal(t.cogs, 0);
    assert.equal(t.opex, 0);
    assert.equal(t.stripe, 0);
    assert.equal(t.gst, 0);
    assert.equal(t.orders, 0);
  }
});

// ─── Integration: the user's screenshot fixture ─────────────────────────────

test('integration: dashboard 3m window matches the user-visible totals', () => {
  // Reproduce the screenshot fixture: revenue $1,277.36, gross_profit $557.48,
  // 31 orders, no logged opex. GST-NEUTRAL model (GST line = net remitted):
  //   COGS   = kpiCogsInclGst(1277.36, 557.48) = 1277.36/1.15 − 557.48 ≈ 553.27
  //   Stripe = (1277.36 × 0.0265 + 31 × 0.30) × 1.15        ≈ 49.6225
  //   GST    = (1277.36 − 553.27 − 49.6225) × 3/23          ≈ 87.974  (NET remitted)
  //   Opex   = 0 (none logged)
  //   Total  ≈ 690.87
  //   Net    ≈ 586.49 profit  (= (rev − cogs − stripe)/1.15, GST-neutral)
  const buckets = [
    { revenue: 1277.36, orders: 31,
      pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  // Step 1: distribute KPI cogs across (only one) bucket. The total COGS comes
  // from kpiCogsInclGst — NOT a raw `revenue − gross_profit` subtraction.
  const totalCogs = sandbox.kpiCogsInclGst(1277.36, 557.48);
  sandbox.distributeCogsByRevenue(buckets, totalCogs);
  // Step 2: assemble
  sandbox.assembleBucketExpense(buckets[0]);
  const totals = sandbox.sumTrendTotals(buckets);

  assert.ok(Math.abs(totals.cogs   - 553.27)  < 0.05, `cogs=${totals.cogs}`);
  assert.equal(totals.opex, 0);
  assert.ok(Math.abs(totals.stripe - 49.6225) < 0.01, `stripe=${totals.stripe}`);
  assert.ok(Math.abs(totals.gst    - 87.974)  < 0.01, `net gst=${totals.gst}`);
  assert.ok(Math.abs(totals.expenses - 690.87) < 0.05,
    `expected ~$690.87 expenses, got ${totals.expenses}`);
  // Net must be the GST-neutral take-home, NOT the old GST-double-counted figure.
  const net = totals.revenue - totals.expenses;
  assert.ok(Math.abs(net - 586.49) < 0.05, `expected GST-neutral net ~$586.49, got ${net}`);
  // Regression guard: GST line must be NET (~$88), never the gross output GST
  // (~$166.6) that double-counted the input credits already inside COGS+Stripe.
  assert.ok(totals.gst < 120, `regression guard: GST must be net remitted, got ${totals.gst}`);
});

test('integration: a bucket with logged opex flips a profit window into a loss', () => {
  // Real-world: a single $5,000 inventory purchase on a slow sales day.
  const buckets = [
    { revenue: 100, orders: 1,
      pnlCogs: 0, hasPnlCogs: false, cogsDerived: 60,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 5000,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  sandbox.assembleBucketExpense(buckets[0]);
  const totals = sandbox.sumTrendTotals(buckets);
  assert.ok(totals.expenses > totals.revenue,
    'a logged opex bigger than revenue must produce a visible loss');
  assert.ok(buckets[0].net < 0, 'net must be negative on a loss day');
});

// ─── kpiCogsInclGst — incl-GST cost from the KPI summary ────────────────────
//
// Formula corrected 2026-05-16. The KPI summary reports `revenue` GROSS and
// `gross_profit = revenue_ex_gst − cost_incl_gst`. So:
//     cost_incl_gst = revenue_ex_gst − gross_profit
//                   = (revenue_gross / 1.15) − gross_profit
// The previous `(revenue − gross_profit) × 1.15` over-counted COGS by ~38%
// because `revenue_gross − gross_profit` already equals
// `output_GST + cost_incl_gst` — see the regression guards below.

test('kpiCogsInclGst: $1,277.36 revenue − $557.48 GP → $553.27 incl-GST cost', () => {
  // (1277.36 / 1.15) − 557.48 = 1110.748 − 557.48 = 553.268
  const cogs = sandbox.kpiCogsInclGst(1277.36, 557.48);
  assert.ok(Math.abs(cogs - 553.268) < 0.01, `expected ~$553.27, got ${cogs}`);
});

test('kpiCogsInclGst: current screenshot fixture $1,354.10 / $594.46 → $583.02', () => {
  // The 2026-05-16 dashboard screenshot: revenue $1,354.10, gross_profit
  // $594.46. (1354.10 / 1.15) − 594.46 = 1177.478 − 594.46 = 583.018.
  const cogs = sandbox.kpiCogsInclGst(1354.10, 594.46);
  assert.ok(Math.abs(cogs - 583.018) < 0.01, `expected ~$583.02, got ${cogs}`);
});

test('kpiCogsInclGst: regression — never re-introduce the ×1.15 over-gross-up', () => {
  // The buggy formula gave (1354.10 − 594.46) × 1.15 = $873.59 — a $290
  // over-count. Guard the corrected value stays well clear of it.
  const cogs = sandbox.kpiCogsInclGst(1354.10, 594.46);
  assert.ok(cogs < 600, `COGS must not balloon back toward the $873.59 bug, got ${cogs}`);
});

test('kpiCogsInclGst: KPI fallback agrees with exact per-order COGS', () => {
  // The whole point of the fix: when items[] are absent and the chart falls
  // back to the KPI figure, it must land on the SAME number the per-order
  // path produces. 4 May order — true cost incl-GST = 198.65 × 1.15 = 228.45.
  //   revenue gross 358.24, gross_profit = 311.513 − 228.448 = 83.065
  const perOrder = sandbox.orderCostInclGst({
    items: [
      { qty: 1, supplier_cost_snapshot: 18.85 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 40.00 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
      { qty: 1, supplier_cost_snapshot: 34.95 },
    ],
  });
  const kpiFallback = sandbox.kpiCogsInclGst(358.24, 83.065);
  assert.ok(Math.abs(kpiFallback - perOrder) < 0.05,
    `KPI fallback (${kpiFallback}) must match per-order cost (${perOrder})`);
});

test('kpiCogsInclGst: NaN inputs return 0, not NaN', () => {
  assert.equal(sandbox.kpiCogsInclGst(NaN, 100), 0);
  assert.equal(sandbox.kpiCogsInclGst(100, NaN), 0);
  assert.equal(sandbox.kpiCogsInclGst(undefined, undefined), 0);
});

test('kpiCogsInclGst: GP > revenue (negative implied cost) clamps to 0', () => {
  // Defensive: negative cost would be nonsensical. Don't propagate it.
  assert.equal(sandbox.kpiCogsInclGst(100, 200), 0);
});

// ─── orderCostInclGst — exact per-order cost from line items ────────────────

test('orderCostInclGst: ORD-MOQBMOJI 4 May fixture → $228.45 incl-GST', () => {
  // The user's actual order from the screenshot:
  //   6 line items, total cost (excl. GST) = $198.65
  //   Real cash to suppliers = 198.65 × 1.15 = 228.4475
  const order = {
    created_at: '2026-05-04T03:00:00Z',
    total: 358.24,
    items: [
      { sku: 'C-HP-CART319-TNR-BK',  qty: 1, supplier_cost_snapshot: 18.85 },
      { sku: 'C-BRO-TN258XL-TNR-BK', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN349-TNR-BK',   qty: 1, supplier_cost_snapshot: 40.00 },
      { sku: 'C-BRO-TN258XL-TNR-YL', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN258XL-TNR-MG', qty: 1, supplier_cost_snapshot: 34.95 },
      { sku: 'C-BRO-TN258XL-TNR-CY', qty: 1, supplier_cost_snapshot: 34.95 },
    ],
  };
  // Sum ex-GST = 18.85 + 34.95 + 40 + 34.95 + 34.95 + 34.95 = 198.65
  // × 1.15 = 228.4475
  const cost = sandbox.orderCostInclGst(order);
  assert.ok(Math.abs(cost - 228.4475) < 0.01, `expected $228.45, got ${cost}`);
});

test('orderCostInclGst: respects qty multiplier', () => {
  const order = {
    items: [
      { qty: 3, supplier_cost_snapshot: 10 }, // 30 ex-GST → 34.50 incl
      { qty: 2, supplier_cost_snapshot: 5 },  // 10 ex-GST → 11.50 incl
    ],
  };
  // Total ex-GST = 40, × 1.15 = 46.00
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 46.0) < 0.01);
});

test('orderCostInclGst: missing items → 0 (caller falls back to KPI)', () => {
  assert.equal(sandbox.orderCostInclGst({ total: 100 }), 0);
  assert.equal(sandbox.orderCostInclGst({ items: [] }), 0);
  assert.equal(sandbox.orderCostInclGst(null), 0);
  assert.equal(sandbox.orderCostInclGst(undefined), 0);
});

test('orderCostInclGst: items without supplier_cost_snapshot are skipped', () => {
  const order = {
    items: [
      { qty: 1, supplier_cost_snapshot: 10 },
      { qty: 1, sku: 'no-cost' }, // skipped
      { qty: 1, supplier_cost_snapshot: null }, // skipped
    ],
  };
  // Only the first item has cost → 10 ex-GST → 11.50 incl
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 11.5) < 0.01);
});

test('orderCostInclGst: prefers order-level cost field when items absent', () => {
  // Forward-compat: if backend ever ships an aggregated cost on the list endpoint,
  // we use it without needing items[]. Still grosses up by 1.15.
  const order = { cost_total_excl_gst: 100 };
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 115) < 0.01);
});

test('orderCostInclGst: uses qty if quantity is absent', () => {
  // The dashboard list endpoint has historically used either field name.
  const order = { items: [{ quantity: 2, supplier_cost_snapshot: 10 }] };
  assert.ok(Math.abs(sandbox.orderCostInclGst(order) - 23) < 0.01);
});

// ─── bucketCogsFromOrders ────────────────────────────────────────────────────

test('bucketCogsFromOrders: 4 May order → 4 May bucket gets $228.45', () => {
  const buckets = [
    { startMs: Date.UTC(2026, 3, 26), cogsFromOrders: 0, hasOrderCogs: false },
    { startMs: Date.UTC(2026, 4, 4),  cogsFromOrders: 0, hasOrderCogs: false },
  ];
  const indexFor = (ts) => {
    const d = new Date(ts);
    if (d.getUTCMonth() === 3) return 0;  // April
    if (d.getUTCMonth() === 4) return 1;  // May
    return -1;
  };
  const orders = [
    {
      created_at: '2026-05-04T03:00:00Z', total: 358.24,
      items: [
        { qty: 1, supplier_cost_snapshot: 18.85 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 40.00 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
        { qty: 1, supplier_cost_snapshot: 34.95 },
      ],
    },
  ];
  const { resolvedCount, resolvedRevenue, resolvedCost } = sandbox.bucketCogsFromOrders(buckets, orders, indexFor);
  assert.equal(resolvedCount, 1);
  assert.ok(Math.abs(resolvedRevenue - 358.24) < 0.01);
  // resolvedCost is the incl-GST cash placed into buckets (must match cogsFromOrders).
  assert.ok(Math.abs(resolvedCost - 228.4475) < 0.01,
    `resolvedCost should equal the bucketed cost, got ${resolvedCost}`);
  assert.equal(buckets[0].cogsFromOrders, 0);
  assert.equal(buckets[0].hasOrderCogs, false);
  assert.ok(Math.abs(buckets[1].cogsFromOrders - 228.4475) < 0.01,
    `bucket 4 May should have $228.45, got ${buckets[1].cogsFromOrders}`);
  assert.equal(buckets[1].hasOrderCogs, true);
});

test('bucketCogsFromOrders: resolves order-level cost_total_excl_gst (enrichment path)', () => {
  // enrichOrdersWithSupplierCost stamps cost_total_excl_gst on the bulk-list
  // order (the detail endpoint carries supplier_cost_snapshot; the list does
  // not). orderCostInclGst must honour that order-level field and gross it up.
  const buckets = [{ startMs: 0, cogsFromOrders: 0, hasOrderCogs: false }];
  const indexFor = () => 0;
  const orders = [
    // no items[] with cost — only the back-filled order-level cost
    { created_at: '2026-06-01T18:56:28Z', total: 400.49, cost_total_excl_gst: 305.13 },
  ];
  const { resolvedCount, resolvedCost } = sandbox.bucketCogsFromOrders(buckets, orders, indexFor);
  assert.equal(resolvedCount, 1);
  assert.ok(Math.abs(resolvedCost - 350.8995) < 0.01,
    `305.13 ex-GST should gross up to $350.90 incl, got ${resolvedCost}`);
  assert.ok(Math.abs(buckets[0].cogsFromOrders - 350.8995) < 0.01);
  assert.equal(buckets[0].hasOrderCogs, true);
});

test('bucketCogsFromOrders: orders without items[] do not block resolution of others', () => {
  const buckets = [{ startMs: 0, cogsFromOrders: 0, hasOrderCogs: false }];
  const indexFor = () => 0;
  const orders = [
    { created_at: '2026-05-01T00:00:00Z', total: 100 },           // no items
    { created_at: '2026-05-02T00:00:00Z', total: 50,
      items: [{ qty: 1, supplier_cost_snapshot: 30 }] },           // exact: 34.50
  ];
  const { resolvedCount, resolvedRevenue, resolvedCost } = sandbox.bucketCogsFromOrders(buckets, orders, indexFor);
  assert.equal(resolvedCount, 1);
  assert.equal(resolvedRevenue, 50);
  assert.ok(Math.abs(resolvedCost - 34.5) < 0.01);
  assert.ok(Math.abs(buckets[0].cogsFromOrders - 34.5) < 0.01);
});

// ─── residualCogsAfterExact ──────────────────────────────────────────────────

test('residualCogsAfterExact: window total stays pinned to the KPI figure', () => {
  // Σ(exact per-order) + residual must equal totalCogsInclGst, so resolving
  // some orders exactly only reshapes per-day bars — it never drifts the total.
  const total = 1032.50;
  const resolved = 350.8995;           // the one Brother order resolved exactly
  const residual = sandbox.residualCogsAfterExact(total, resolved);
  assert.ok(Math.abs((resolved + residual) - total) < 1e-9,
    `exact + residual must equal total, got ${resolved + residual}`);
  assert.ok(Math.abs(residual - 681.6005) < 0.01);
});

test('residualCogsAfterExact: clamps at 0 when exact cost meets/exceeds the KPI total', () => {
  // If line-item costs already exceed the KPI-derived total (KPI under-reporting),
  // trust the harder per-order data and add no residual.
  assert.equal(sandbox.residualCogsAfterExact(500, 500), 0);
  assert.equal(sandbox.residualCogsAfterExact(500, 620), 0);
});

test('residualCogsAfterExact: nothing resolved → residual is the whole KPI total', () => {
  // The status quo when the orders feed carries no supplier cost at all.
  assert.ok(Math.abs(sandbox.residualCogsAfterExact(1032.50, 0) - 1032.50) < 1e-9);
});

test('residualCogsAfterExact: no/invalid KPI total → 0 (COGS stays honestly blank)', () => {
  assert.equal(sandbox.residualCogsAfterExact(0, 0), 0);
  assert.equal(sandbox.residualCogsAfterExact(null, 100), 0);
  assert.equal(sandbox.residualCogsAfterExact(-5, 0), 0);
  // a NaN resolvedCost must not poison the residual
  assert.ok(Math.abs(sandbox.residualCogsAfterExact(800, NaN) - 800) < 1e-9);
});

// ─── snapshot-cost reconciliation ────────────────────────────────────────────

test('extrapolateWindowCogsInclGst: full coverage → just the resolved sum', () => {
  // resolved revenue == total revenue ⇒ no extrapolation.
  assert.ok(Math.abs(sandbox.extrapolateWindowCogsInclGst(1500, 2200, 2200) - 1500) < 1e-9);
});

test('extrapolateWindowCogsInclGst: scales the resolved cost ratio across the gap', () => {
  // resolved 1517 cost on 2209 of 2211 revenue ⇒ ~1518.4 over the full window.
  const est = sandbox.extrapolateWindowCogsInclGst(1517, 2209, 2211);
  assert.ok(Math.abs(est - 1517 * (2211 / 2209)) < 1e-6);
  assert.ok(est > 1517, 'extrapolated window cost must cover the unresolved tail');
});

test('extrapolateWindowCogsInclGst: never scales below the resolved sum', () => {
  // a totalRevenue somehow < resolvedRevenue must not shrink the cost.
  assert.ok(Math.abs(sandbox.extrapolateWindowCogsInclGst(1000, 2000, 1500) - 1000) < 1e-9);
});

test('extrapolateWindowCogsInclGst: nothing resolved → 0', () => {
  assert.equal(sandbox.extrapolateWindowCogsInclGst(0, 0, 2200), 0);
  assert.equal(sandbox.extrapolateWindowCogsInclGst(500, 0, 2200), 0);
});

test('reconciledGrossProfitInclGst: revenue_ex_gst − cost_EX_gst (GST-neutral, canonical)', () => {
  // $2,211.17 gross, $1,518 incl-GST snapshot COGS. Gross profit subtracts the
  // EX-GST cost (1518/1.15 = 1320), NOT the incl cost — both sides ex-GST.
  const gp = sandbox.reconciledGrossProfitInclGst(2211.17, 1518);
  const revEx = 2211.17 * (1 - 3 / 23);
  const costEx = 1518 / 1.15;
  assert.ok(Math.abs(gp - (revEx - costEx)) < 1e-6, `gp=${gp}`);
  // ~$602.76: below the optimistic $890 RPC figure, but POSITIVE (subtracting the
  // incl cost would have wrongly given ~$405 and could go negative on thin items).
  assert.ok(Math.abs(gp - 602.76) < 0.5, `canonical gross profit ~$602.76, got ${gp}`);
  // A single thin-margin order must NOT show negative gross profit (the cost-incl
  // bug did): Brother sells $348.25 ex, costs $305.13 ex → +$43.12 gross.
  const brother = sandbox.reconciledGrossProfitInclGst(400.49, 305.13 * 1.15);
  assert.ok(Math.abs(brother - 43.12) < 0.05, `Brother gross profit must be +$43.12, got ${brother}`);
});

test('reconciledGrossProfitInclGst: unusable revenue → null (keep provisional)', () => {
  assert.equal(sandbox.reconciledGrossProfitInclGst(0, 100), null);
  assert.equal(sandbox.reconciledGrossProfitInclGst(null, 100), null);
  assert.equal(sandbox.reconciledGrossProfitInclGst(-1, 100), null);
});

test('costCoverage: resolved revenue fraction, clamped to [0,1]', () => {
  assert.ok(Math.abs(sandbox.costCoverage(2209, 2211) - (2209 / 2211)) < 1e-9);
  assert.equal(sandbox.costCoverage(0, 2211), 0);
  assert.equal(sandbox.costCoverage(2211, 0), 0);
  assert.equal(sandbox.costCoverage(3000, 2211), 1, 'over-100% coverage clamps to 1');
});

test('reconciliation end-to-end: snapshot COGS drives both the chart and the KPI consistently', () => {
  // Mirrors the live 2026-06-05 finding. The chart uses the snapshot COGS total
  // DIRECTLY (payload._reconciledCogsInclGst = windowCogs); the KPI gross_profit
  // is the canonical ex-GST figure. The two are decoupled but consistent:
  //   chart COGS (incl) = windowCogs
  //   KPI gross_profit  = rev_ex − windowCogs/1.15
  //   ⇒ kpiCogsInclGst(rev, gross_profit) recovers cost_EX = windowCogs/1.15
  const revenueGross = 2211.17;
  const windowCogs = sandbox.extrapolateWindowCogsInclGst(1517, 2209, 2211.17);
  const reconciledGP = sandbox.reconciledGrossProfitInclGst(revenueGross, windowCogs);
  // gross_profit is on the EX-GST cost basis, so inverting it yields cost_EX,
  // exactly windowCogs/1.15 — proving the convention flipped cleanly.
  const recoveredCostEx = sandbox.kpiCogsInclGst(revenueGross, reconciledGP);
  assert.ok(Math.abs(recoveredCostEx - windowCogs / 1.15) < 1e-6,
    `gross_profit must be on the ex-GST basis: ${recoveredCostEx} vs ${windowCogs / 1.15}`);
  // Canonical gross profit ~$602; net (Gross − stripe_ex) is the real take-home,
  // both well below the optimistic $890 RPC figure but POSITIVE and honest.
  assert.ok(reconciledGP > 580 && reconciledGP < 620,
    `reconciled gross profit ~$602, got ${reconciledGP}`);
});

// ─── assembleBucketExpense: per-order COGS preference ───────────────────────

test('assembleBucketExpense: order-resolved COGS trumps revenue-distributed', () => {
  const b = {
    revenue: 358.24, orders: 1,
    pnlCogs: 0, hasPnlCogs: false,
    cogsDerived: 999, // garbage smear value
    cogsFromOrders: 228.4475, hasOrderCogs: true,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  assert.ok(Math.abs(b.cogsTotal - 228.4475) < 0.01,
    `must use exact per-order COGS over the smear, got ${b.cogsTotal}`);
});

// ─── expandRecurringExpenses (recurring subscriptions) ─────────────────────
//
// Pinned 2026-05-10. Spec at readfirst/recurring-expenses-may2026.md.
// Each expense row may carry a `recurrence` field; for each fire-date that
// falls inside [windowStart, windowEnd] the helper emits a virtual row with a
// synthesised expense_date so the bucketer can treat the lot as a flat list.
//
// Why these tests matter: every cash-out day on the dashboard must be honest.
// The user's #1 ask was "no smearing, no fake spike on the 1st" — these guards
// keep recurring expenses landing on the actual billing day.

test('expandRecurringExpenses: a one-off row passes through unchanged', () => {
  const row = { date: '2026-05-03', amount: 250, category: 'cogs', vendor: 'Supplier' };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 1),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0], row, 'one-off rows should reference-pass through, not be cloned');
});

test('expandRecurringExpenses: monthly day-12 across a 90-day window emits 3 occurrences', () => {
  const row = {
    date: '2026-01-12',
    amount: 30,
    vendor: 'Vercel Pro',
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 1, 1), Date.UTC(2026, 4, 1), // 1 Feb → 1 May
  );
  assert.equal(out.length, 3, 'expected Feb 12 / Mar 12 / Apr 12');
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-02-12', '2026-03-12', '2026-04-12']);
  // Amount + vendor preserved on each occurrence.
  for (const r of out) {
    assert.equal(r.amount, 30);
    assert.equal(r.vendor, 'Vercel Pro');
    assert.equal(r.recurrence, undefined, 'recurrence keys must be stripped from emitted occurrences');
  }
});

test('expandRecurringExpenses: month-end clamp — day 31 in Feb fires on Feb 28 (2026)', () => {
  const row = {
    date: '2026-01-31',
    amount: 10,
    recurrence: 'monthly',
    recurrence_day_of_month: 31,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 1, 1), Date.UTC(2026, 5, 1), // Feb → June
  );
  // 2026 is not a leap year → Feb 28.
  assert.deepEqual(
    [...out.map(r => r.expense_date)],
    ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'],
    'day-31 must clamp to month-end for short months',
  );
});

test('expandRecurringExpenses: month-end clamp — day 31 in Feb fires on Feb 29 (2024 leap)', () => {
  const row = {
    date: '2024-01-31',
    amount: 10,
    recurrence: 'monthly',
    recurrence_day_of_month: 31,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2024, 1, 1), Date.UTC(2024, 2, 15),
  );
  assert.deepEqual([...out.map(r => r.expense_date)], ['2024-02-29']);
});

test('expandRecurringExpenses: weekly Wednesday across 4 weeks emits 4 occurrences', () => {
  const row = {
    date: '2026-05-04', // Mon
    amount: 12,
    recurrence: 'weekly',
    recurrence_day_of_week: 3, // Wed
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 4, 31),
  );
  assert.deepEqual(
    [...out.map(r => r.expense_date)],
    ['2026-05-06', '2026-05-13', '2026-05-20', '2026-05-27'],
  );
});

test('expandRecurringExpenses: yearly Mar 23 — 14-month window emits once, 26-month window emits twice', () => {
  const row = {
    date: '2025-03-23',
    amount: 80,
    vendor: 'Domain renewal',
    recurrence: 'yearly',
    recurrence_month: 3,
    recurrence_day_of_month: 23,
  };
  const oneYear = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2025, 5, 1), Date.UTC(2026, 6, 1), // Jun 2025 → Jul 2026 (~13mo)
  );
  assert.deepEqual([...oneYear.map(r => r.expense_date)], ['2026-03-23']);

  const twoYears = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2025, 0, 1), Date.UTC(2027, 5, 1), // Jan 2025 → Jun 2027
  );
  assert.deepEqual([...twoYears.map(r => r.expense_date)],
    ['2025-03-23', '2026-03-23', '2027-03-23']);
});

test('expandRecurringExpenses: custom every-90-days walks correctly from start', () => {
  const row = {
    date: '2026-01-01',
    amount: 600,
    recurrence: 'custom',
    recurrence_interval_days: 90,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31),
  );
  // 1 Jan + 90d = 1 Apr; +90d = 30 Jun; +90d = 28 Sep; +90d = 27 Dec
  assert.deepEqual([...out.map(r => r.expense_date)],
    ['2026-01-01', '2026-04-01', '2026-06-30', '2026-09-28', '2026-12-27']);
});

test('expandRecurringExpenses: recurrence_end stops the series mid-window', () => {
  const row = {
    date: '2026-01-12',
    amount: 30,
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
    recurrence_end: '2026-03-31',
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 0, 1), Date.UTC(2026, 5, 1), // Jan → Jun
  );
  // Cancelled 31 Mar → no Apr 12, no May 12.
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-01-12', '2026-02-12', '2026-03-12']);
});

test('expandRecurringExpenses: occurrences before windowStart are not emitted', () => {
  const row = {
    date: '2025-01-12',
    amount: 30,
    recurrence: 'monthly',
    recurrence_day_of_month: 12,
  };
  const out = sandbox.expandRecurringExpenses(
    [row],
    Date.UTC(2026, 4, 1), Date.UTC(2026, 6, 1), // May → Jul 2026
  );
  // Series started Jan 2025 but only the in-window months emit.
  assert.deepEqual([...out.map(r => r.expense_date)], ['2026-05-12', '2026-06-12']);
});

test('expandRecurringExpenses: handles non-array input safely', () => {
  assert.equal(sandbox.expandRecurringExpenses(null, 0, 1).length, 0);
  assert.equal(sandbox.expandRecurringExpenses(undefined, 0, 1).length, 0);
  assert.equal(sandbox.expandRecurringExpenses({ not: 'an array' }, 0, 1).length, 0);
});

test('expandRecurringExpenses: unknown recurrence value falls through as one-off', () => {
  const row = { date: '2026-05-03', amount: 5, recurrence: 'tuesday-of-leap-year' };
  const out = sandbox.expandRecurringExpenses([row], 0, Date.UTC(2030, 0, 1));
  assert.equal(out.length, 1);
  assert.equal(out[0], row);
});

test('expandRecurringExpenses: invalid weekly/monthly/custom params drop silently', () => {
  // Recurring without enough info to know when to fire is dropped, not exploded
  // into garbage rows.
  const rows = [
    { date: '2026-05-01', amount: 1, recurrence: 'weekly' /* no dow */ },
    { date: '2026-05-01', amount: 2, recurrence: 'weekly', recurrence_day_of_week: 99 },
    { date: '2026-05-01', amount: 3, recurrence: 'monthly' /* no dom */ },
    { date: '2026-05-01', amount: 4, recurrence: 'custom' /* no interval */ },
    { /* no start date */ amount: 5, recurrence: 'monthly', recurrence_day_of_month: 1 },
  ];
  const out = sandbox.expandRecurringExpenses(
    rows, Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 1),
  );
  assert.equal(out.length, 0);
});

test('expandRecurringExpenses: end-to-end with bucketOperatingExpenses — empty days stay $0', () => {
  // Integration guard for the user's "$29.80 ghost" scenario. A single monthly
  // recurring sub bills on the 12th. The 7-day window 2 May–8 May contains
  // ZERO occurrences → every day's opexLogged stays 0.
  const buckets = [
    { startMs: Date.UTC(2026, 4, 2), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 3), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 4), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 5), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 6), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 7), opexLogged: 0, hasOpexLogged: false },
    { startMs: Date.UTC(2026, 4, 8), opexLogged: 0, hasOpexLogged: false },
  ];
  const indexFor = (ts) => {
    const day = new Date(ts).getUTCDate();
    return (day >= 2 && day <= 8) ? day - 2 : -1;
  };
  const expanded = sandbox.expandRecurringExpenses(
    [{ date: '2026-01-12', amount: 30, recurrence: 'monthly', recurrence_day_of_month: 12 }],
    Date.UTC(2026, 4, 2), Date.UTC(2026, 4, 9),
  );
  sandbox.bucketOperatingExpenses(buckets, expanded, indexFor);
  for (const b of buckets) {
    assert.equal(b.opexLogged, 0, 'no recurring fire-date in 2-8 May → all days $0');
  }
});

// ─── Integration: the user's 4 May order, expenses must be ≥ $285 ───────────

test('integration: 4 May order single-bucket — expenses match cost+stripe+net-gst exactly', () => {
  // Reproduces the user's complaint on 2026-05-08:
  //   "How can the expenses be $209 for the order on the 4th of may if just
  //   the costs for the products are $198.65 before gst."
  //
  // GST-NEUTRAL model (corrected 2026-06-05 — the GST line is NET remitted, not
  // gross output; the old fix had over-shot to ~$286 by double-counting GST):
  //   Cost incl-GST: 198.65 × 1.15                          = 228.4475
  //   Stripe:        (358.24 × 0.0265 + 1 × 0.30) × 1.15     ≈ 11.2624
  //   GST net:       (358.24 − 228.4475 − 11.2624) × 3/23    ≈ 15.4600
  //   ─────────────────────────────────────────────────────────────────
  //   Total expenses:                                        ≈ 255.17
  //   Net profit:    358.24 − 255.17                         ≈ 103.07 (28.8% margin)
  //
  // The expense bar must still EXCEED the incl-GST supplier cost ($228.45) — the
  // original "$209 < $228 cost" complaint — but must NOT inflate to $286 by
  // counting the gross output GST on top of the GST already inside COGS+Stripe.
  const items = [
    { qty: 1, supplier_cost_snapshot: 18.85 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 40.00 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
    { qty: 1, supplier_cost_snapshot: 34.95 },
  ];
  const buckets = [
    { startMs: 0, revenue: 358.24, orders: 1,
      pnlCogs: 0, hasPnlCogs: false,
      cogsDerived: 0,
      cogsFromOrders: 0, hasOrderCogs: false,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  const indexFor = () => 0;
  sandbox.bucketCogsFromOrders(buckets, [{
    created_at: '2026-05-04T03:00:00Z', total: 358.24, items,
  }], indexFor);
  sandbox.assembleBucketExpense(buckets[0]);

  assert.ok(Math.abs(buckets[0].cogsTotal - 228.4475) < 0.01,
    `cogs must equal cost-incl-GST exactly when items[] are present: ${buckets[0].cogsTotal}`);
  assert.ok(buckets[0].expenses > buckets[0].cogsTotal,
    `expenses must exceed the supplier cost (original complaint), got ${buckets[0].expenses}`);
  assert.ok(Math.abs(buckets[0].expenses - 255.17) < 0.05,
    `4 May expenses must be ~$255.17 (cost incl + Stripe + NET gst), got ${buckets[0].expenses}`);
  const net = buckets[0].revenue - buckets[0].expenses;
  assert.ok(Math.abs(net - 103.07) < 0.05, `GST-neutral net ~$103.07, got ${net}`);
});

test('integration: when items[] are absent, KPI fallback equals the per-order cost', () => {
  // No items[] → the chart falls back to the KPI total cogs (kpiCogsInclGst)
  // distributed by revenue share. For a single-bucket window that means
  // bucket cogs = total kpiCogsInclGst.
  const buckets = [
    { revenue: 358.24, orders: 1,
      pnlCogs: 0, hasPnlCogs: false,
      cogsDerived: 0,
      cogsFromOrders: 0, hasOrderCogs: false,
      pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
      pnlStripe: 0, hasPnlStripe: false,
      pnlGst: 0, hasPnlGst: false,
      hasNet: false },
  ];
  // Single-order window: revenue gross 358.24, gross_profit per profitability.js
  // = revenue_ex_gst − cost_incl_gst = 311.513 − 228.448 = 83.065.
  // Corrected fallback: kpiCogsInclGst(358.24, 83.065)
  //   = 358.24/1.15 − 83.065 = 311.513 − 83.065 = 228.448
  // — i.e. EXACTLY the per-order cost. Pre-fix this returned $316.45 (a 38%
  // over-count); the fallback and the exact path must now agree.
  const totalCogs = sandbox.kpiCogsInclGst(358.24, 83.065);
  sandbox.distributeCogsByRevenue(buckets, totalCogs);
  sandbox.assembleBucketExpense(buckets[0]);
  assert.ok(Math.abs(buckets[0].cogsTotal - 228.4475) < 0.1,
    `KPI-fallback COGS must match the exact per-order cost ($228.45), got ${buckets[0].cogsTotal}`);
  assert.ok(buckets[0].cogsTotal < 300,
    `regression guard: fallback must not balloon back to the $316 over-count, got ${buckets[0].cogsTotal}`);
});

// ─── isRevenueOrder — order-status filter ───────────────────────────────────
//
// The dashboard counts orders for the Trends tally + Stripe fixed-fee from the
// bulk /orders endpoint, which returns every status. analytics_kpi_summary
// counts sales only — `isRevenueOrder` filters raw orders to match it.

test('isRevenueOrder: paid / shipped / completed / delivered count as sales', () => {
  for (const status of ['paid', 'shipped', 'completed', 'delivered', 'processing', 'refunded', 'fulfilled']) {
    assert.equal(sandbox.isRevenueOrder({ status }), true, `${status} should count`);
  }
});

test('isRevenueOrder: pending / cancelled / failed / abandoned are excluded', () => {
  for (const status of ['pending', 'cancelled', 'failed', 'abandoned']) {
    assert.equal(sandbox.isRevenueOrder({ status }), false, `${status} should be excluded`);
  }
});

test('isRevenueOrder: status match is case-insensitive', () => {
  assert.equal(sandbox.isRevenueOrder({ status: 'CANCELLED' }), false);
  assert.equal(sandbox.isRevenueOrder({ status: 'Pending' }), false);
  assert.equal(sandbox.isRevenueOrder({ status: 'PAID' }), true);
});

test('isRevenueOrder: missing / unknown status defaults to counting', () => {
  // An order with no status string still represents a placed order; only the
  // explicit non-revenue statuses are dropped.
  assert.equal(sandbox.isRevenueOrder({}), true);
  assert.equal(sandbox.isRevenueOrder({ status: null }), true);
  assert.equal(sandbox.isRevenueOrder(null), true);
});

test('NON_REVENUE_ORDER_STATUSES: the excluded set is exactly the 4 known non-sales', () => {
  assert.deepEqual(
    [...sandbox.NON_REVENUE_ORDER_STATUSES].sort(),
    ['abandoned', 'cancelled', 'failed', 'pending'],
  );
});

test('isRevenueOrder: a 42-order window with 9 non-sales filters down to 33', () => {
  // Reproduces the 2026-05-16 screenshot discrepancy: the bulk endpoint
  // returned 42 orders, the KPI summary counted 33. The 9 extra were
  // pending/cancelled/failed and inflated the Stripe fixed-fee.
  const orders = [];
  for (let i = 0; i < 33; i++) orders.push({ status: 'paid' });
  for (let i = 0; i < 5; i++)  orders.push({ status: 'pending' });
  for (let i = 0; i < 3; i++)  orders.push({ status: 'cancelled' });
  orders.push({ status: 'failed' });
  const counted = orders.filter(sandbox.isRevenueOrder);
  assert.equal(counted.length, 33, `expected 33 revenue orders, got ${counted.length}`);
});

// ─── deriveKpisFromOrders — KPI strip self-heal (ERR-010) ────────────────────
//
// The dashboard KPI cards (Revenue, Orders, Avg Order Value, Gross Profit) are
// fed by the analytics_kpi_summary RPC. That RPC's GRANT EXECUTE has been
// dropped by a backend redeploy more than once — when it is, the whole strip
// shows "—" even though /api/admin/orders still returns every order.
// deriveKpisFromOrders reconstructs the headline numbers from that order feed.

test('deriveKpisFromOrders: non-array / empty input returns null', () => {
  assert.equal(sandbox.deriveKpisFromOrders(null), null);
  assert.equal(sandbox.deriveKpisFromOrders(undefined), null);
  assert.equal(sandbox.deriveKpisFromOrders([]), null);
  assert.equal(sandbox.deriveKpisFromOrders('nope'), null);
});

test('deriveKpisFromOrders: a window of only non-revenue orders returns null', () => {
  const orders = [
    { status: 'pending', total: 50 },
    { status: 'cancelled', total: 99 },
    { status: 'failed', total: 12 },
  ];
  assert.equal(sandbox.deriveKpisFromOrders(orders), null);
});

test('deriveKpisFromOrders: sums o.total over revenue orders for GROSS revenue', () => {
  const orders = [
    { status: 'paid', total: 324.74 },
    { status: 'shipped', total: 53.79 },
    { status: 'delivered', total: 100.00 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.ok(Math.abs(k.revenue - 478.53) < 0.001, `revenue ${k.revenue}`);
  assert.equal(k.orders, 3);
  assert.equal(k._derived, true);
});

test('deriveKpisFromOrders: pending / cancelled / failed orders are excluded', () => {
  const orders = [
    { status: 'paid', total: 200 },
    { status: 'pending', total: 999 },     // not yet a sale
    { status: 'cancelled', total: 999 },   // never collected
    { status: 'paid', total: 100 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 300);
  assert.equal(k.orders, 2);
});

test('deriveKpisFromOrders: o.amount is used when o.total is absent', () => {
  const k = sandbox.deriveKpisFromOrders([{ status: 'paid', amount: 75.5 }]);
  assert.equal(k.revenue, 75.5);
  assert.equal(k.orders, 1);
});

test('deriveKpisFromOrders: zero / negative / non-numeric totals are skipped', () => {
  const orders = [
    { status: 'paid', total: 0 },
    { status: 'paid', total: -10 },
    { status: 'paid', total: 'abc' },
    { status: 'paid', total: 120 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 120);
  assert.equal(k.orders, 1);
});

test('deriveKpisFromOrders: unwraps { orders: [...] } and { data: [...] } envelopes', () => {
  const rows = [{ status: 'paid', total: 60 }, { status: 'paid', total: 40 }];
  for (const wrapped of [{ orders: rows }, { data: rows }]) {
    const k = sandbox.deriveKpisFromOrders(wrapped);
    assert.equal(k.revenue, 100);
    assert.equal(k.orders, 2);
  }
});

test('deriveKpisFromOrders: gross_profit is null when ANY order lacks cost data', () => {
  const orders = [
    { status: 'paid', total: 115, items: [{ supplier_cost_snapshot: 40, qty: 1 }] },
    { status: 'paid', total: 115 },  // no items[] — cost unknown
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.revenue, 230);
  assert.equal(k.orders, 2);
  // A partial cost sum would understate COGS and overstate profit — honest "—".
  assert.equal(k.gross_profit, null);
});

test('deriveKpisFromOrders: gross_profit computed when every order has cost data', () => {
  // $115 gross → $100 ex-GST. Cost ex-GST $40 → incl-GST $46. Profit = $54.
  const orders = [
    { status: 'paid', total: 115, items: [{ supplier_cost_snapshot: 40, qty: 1 }] },
    { status: 'paid', total: 230, items: [{ supplier_cost_snapshot: 40, qty: 2 }] },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  // ex-GST revenue 300; cost incl-GST (40 + 80) × 1.15 = 138; profit = 162.
  assert.ok(Math.abs(k.gross_profit - 162) < 0.001, `gross_profit ${k.gross_profit}`);
});

test('deriveKpisFromOrders: order-level cost_total_excl_gst counts as cost data', () => {
  const orders = [
    { status: 'paid', total: 115, cost_total_excl_gst: 40 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.ok(Math.abs(k.gross_profit - (100 - 46)) < 0.001, `gross_profit ${k.gross_profit}`);
});

test('deriveKpisFromOrders: reproduces the screenshot — blank strip becomes real numbers', () => {
  // 8 recent orders from the 2026-05-17 dashboard screenshot window. The KPI
  // RPC was down (strip showed "—"); the order feed was intact.
  const orders = [
    { status: 'paid', total: 324.74 }, { status: 'paid', total: 53.79 },
    { status: 'paid', total: 210.00 }, { status: 'shipped', total: 88.40 },
    { status: 'delivered', total: 412.10 }, { status: 'paid', total: 19.99 },
    { status: 'paid', total: 145.50 }, { status: 'completed', total: 67.25 },
  ];
  const k = sandbox.deriveKpisFromOrders(orders);
  assert.equal(k.orders, 8);
  assert.ok(k.revenue > 0, 'revenue must be a real positive number, not "—"');
  const aov = k.revenue / k.orders;
  assert.ok(aov > 0, 'avg order value derives cleanly from revenue / orders');
});

// ─── kpiCogsInclGst — null gross_profit must NOT become full-revenue COGS ────

test('kpiCogsInclGst: null gross_profit returns 0, not the entire ex-GST revenue', () => {
  // Number(null) === 0 (finite) — without an explicit null check this returned
  // revenueExGst, painting COGS = all revenue on the KPI fallback path.
  assert.equal(sandbox.kpiCogsInclGst(1678.84, null), 0);
  assert.equal(sandbox.kpiCogsInclGst(1678.84, undefined), 0);
  assert.equal(sandbox.kpiCogsInclGst(null, 500), 0);
  assert.equal(sandbox.kpiCogsInclGst(undefined, undefined), 0);
});

test('kpiCogsInclGst: real revenue + gross_profit still recovers incl-GST COGS', () => {
  // $1,150 gross → $1,000 ex-GST. gross_profit $400 → COGS incl-GST $600.
  const cogs = sandbox.kpiCogsInclGst(1150, 400);
  assert.ok(Math.abs(cogs - 600) < 0.001, `expected $600 COGS, got ${cogs}`);
});

// ─── cogsIsKnown — COGS-unknown vs COGS-genuinely-zero ──────────────────────
//
// Added 2026-05-17 (ERR-028). When the analytics RPC is down AND the bulk
// orders feed carries no per-item supplier cost, the dashboard cannot value
// COGS. `assembleBucketExpense` then leaves cogsTotal at 0 — but that 0 means
// "unknown", not "the goods cost nothing". `cogsIsKnown` distinguishes the two
// so renderTrendTotals can refuse to fold a missing cost line into a confident
// green "Profit" figure (it shows a neutral "Net excl. COGS" instead).

test('cogsIsKnown: no source resolved + real revenue → COGS unknown', () => {
  // The 2026-05-17 screenshot exactly: RPC down (kpiCogsTotal 0), bulk-orders
  // feed had no items[] (hasOrderCogs false), no P&L. COGS is unknown.
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 0,
  }), false);
});

test('cogsIsKnown: a positive KPI cost total marks COGS known', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 553.27,
  }), true);
});

test('cogsIsKnown: per-order item costs mark COGS known even with RPC down', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: true, kpiCogsTotal: 0,
  }), true);
});

test('cogsIsKnown: backend P&L COGS marks COGS known', () => {
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: true, hasOrderCogs: false, kpiCogsTotal: 0,
  }), true);
});

test('cogsIsKnown: a window with no revenue has no COGS to know → known', () => {
  // An empty date range must NOT raise a spurious "cost missing" warning.
  assert.equal(sandbox.cogsIsKnown({
    windowRevenue: 0, hasPnlCogs: false, hasOrderCogs: false, kpiCogsTotal: 0,
  }), true);
  assert.equal(sandbox.cogsIsKnown({}), true);
  assert.equal(sandbox.cogsIsKnown(), true);
});

test('cogsIsKnown: negative / non-numeric revenue is treated as no revenue', () => {
  assert.equal(sandbox.cogsIsKnown({ windowRevenue: -5, kpiCogsTotal: 0 }), true);
  assert.equal(sandbox.cogsIsKnown({ windowRevenue: 'nope', kpiCogsTotal: 0 }), true);
});

// ─── sumTrendTotals — cogsKnown propagation ─────────────────────────────────

test('sumTrendTotals: cogsKnown stays true when every bucket has known COGS', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, cogsKnown: true },
    { revenue: 200, expenses: 90, cogsTotal: 70, cogsKnown: true },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, true);
});

test('sumTrendTotals: one bucket with cogsKnown:false poisons the whole window', () => {
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40, cogsKnown: true },
    { revenue: 200, expenses: 20, cogsTotal: 0,  cogsKnown: false },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, false);
});

test('sumTrendTotals: cogsKnown defaults to true for legacy buckets without the flag', () => {
  // Buckets predating ERR-028 carry no cogsKnown — absence must not be read
  // as "unknown", or every cached render would flip to the warning state.
  const series = [
    { revenue: 100, expenses: 60, cogsTotal: 40 },
    { revenue: 200, expenses: 90, cogsTotal: 70 },
  ];
  assert.equal(sandbox.sumTrendTotals(series).cogsKnown, true);
});

test('sumTrendTotals: empty / nullish series reports cogsKnown true', () => {
  for (const v of [null, undefined, []]) {
    assert.equal(sandbox.sumTrendTotals(v).cogsKnown, true);
  }
});

test('integration: ERR-028 screenshot — COGS unknown, net must NOT read as profit', () => {
  // The 2026-05-17 window: revenue $1,678.84, RPC down so gross_profit null →
  // kpiCogsInclGst returns 0, no per-order items[], no P&L. COGS is unknown.
  // The bucket carries cogsKnown:false; sumTrendTotals propagates it; and the
  // "net" the totals strip would print (revenue − Stripe − GST) is an
  // OVERSTATEMENT of true profit because product cost is missing entirely.
  const totalCogsInclGst = sandbox.kpiCogsInclGst(1678.84, null); // RPC down
  assert.equal(totalCogsInclGst, 0, 'null gross_profit → 0 COGS, not guessed');

  const cogsKnown = sandbox.cogsIsKnown({
    windowRevenue: 1678.84, hasPnlCogs: false, hasOrderCogs: false,
    kpiCogsTotal: totalCogsInclGst,
  });
  assert.equal(cogsKnown, false, 'COGS is unknown for this window');

  const b = {
    revenue: 1678.84, orders: 34,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    cogsKnown,
    hasNet: false,
  };
  sandbox.assembleBucketExpense(b);
  const totals = sandbox.sumTrendTotals([b]);
  assert.equal(totals.cogsKnown, false,
    'cogsKnown:false must survive into the totals the strip renders from');
  assert.equal(totals.cogs, 0, 'COGS sits at a 0 placeholder — shown as "—", never "$0.00 profit"');
  // The renderable "net" excludes COGS — it is a ceiling on profit, not profit.
  const net = totals.revenue - totals.expenses;
  assert.ok(net > 0, 'net excl. COGS is positive here — which is exactly why it must not be labelled "Profit"');
});

// ─── forecastDailyAvgFromHistory ─────────────────────────────────────────────
// Local fallback that keeps the 30-day forecast line from flat-lining at $0
// when the backend forecast endpoint ships nothing.

const DAY = 24 * 60 * 60 * 1000;
// Anchor timestamp (epoch-ms) — passed in, never read from the clock, so the
// math is deterministic. 2026-06-05.
const T0 = Date.UTC(2026, 5, 5);
const day = (offsetDays, rev) => ({ ts: T0 - offsetDays * DAY, rev });

test('forecastDailyAvgFromHistory: averages trailing days including zero days', () => {
  // 30 days, each $30 → flat $30/day average.
  const hist = Array.from({ length: 30 }, (_, i) => day(i, 30));
  assert.ok(Math.abs(sandbox.forecastDailyAvgFromHistory(hist, 30) - 30) < 1e-9);
});

test('forecastDailyAvgFromHistory: zero-revenue days drag the average down', () => {
  // 10 days of $60 + 20 days of $0 over a 30-day span → $600 / 30 = $20/day.
  const hist = [
    ...Array.from({ length: 10 }, (_, i) => day(i, 60)),
    ...Array.from({ length: 20 }, (_, i) => day(i + 10, 0)),
  ];
  assert.ok(Math.abs(sandbox.forecastDailyAvgFromHistory(hist, 30) - 20) < 1e-9,
    'missing/zero days must count against the projection, not be dropped');
});

test('forecastDailyAvgFromHistory: only the trailing window counts', () => {
  // A big spike 45 days ago is outside the 30-day window and must be ignored.
  const hist = [
    day(45, 10000),
    ...Array.from({ length: 30 }, (_, i) => day(i, 10)),
  ];
  assert.ok(Math.abs(sandbox.forecastDailyAvgFromHistory(hist, 30) - 10) < 1e-9);
});

test('forecastDailyAvgFromHistory: short history divides by its real span, not 30', () => {
  // Only 5 days of $50 each → $250 / 5 = $50/day, NOT $250 / 30.
  const hist = Array.from({ length: 5 }, (_, i) => day(i, 50));
  assert.ok(Math.abs(sandbox.forecastDailyAvgFromHistory(hist, 30) - 50) < 1e-9);
});

test('forecastDailyAvgFromHistory: empty / non-array history → null', () => {
  assert.equal(sandbox.forecastDailyAvgFromHistory([], 30), null);
  assert.equal(sandbox.forecastDailyAvgFromHistory(null, 30), null);
  assert.equal(sandbox.forecastDailyAvgFromHistory(undefined, 30), null);
});

test('forecastDailyAvgFromHistory: drops malformed points (NaN ts)', () => {
  const hist = [
    { ts: NaN, rev: 9999 },
    ...Array.from({ length: 30 }, (_, i) => day(i, 40)),
  ];
  assert.ok(Math.abs(sandbox.forecastDailyAvgFromHistory(hist, 30) - 40) < 1e-9);
});

test('forecastDailyAvgFromHistory: a 30-day total grosses back up correctly', () => {
  // The headline does projected30 = localAvg × 30. $25/day → $750 projected.
  const hist = Array.from({ length: 30 }, (_, i) => day(i, 25));
  const avg = sandbox.forecastDailyAvgFromHistory(hist, 30);
  assert.ok(Math.abs(avg * 30 - 750) < 1e-9);
});

// ─── Cross-validation against profitability.js (the canonical source) ────────
//
// The dashboard's bucket math is only correct if it agrees, dollar-for-dollar,
// with the GST-neutral helpers that produce each order's detail-modal numbers.
// These tests build a bucket from real order data and assert the assembled
// net / GST equal computeOrderProfit / computeProfitBreakdown EXACTLY — so the
// chart can never silently drift from the modal again (ERR-039 / 2026-06-05).

// Build a single-bucket window from one order and assemble it the way
// buildTrendSeries does (per-order COGS → assembleBucketExpense).
function assembleSingleOrderBucket({ revenueIncl, costExGst }) {
  const buckets = [{
    startMs: 0, revenue: revenueIncl, orders: 1,
    pnlCogs: 0, hasPnlCogs: false,
    cogsDerived: 0, cogsFromOrders: 0, hasOrderCogs: false,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false,
    pnlGst: 0, hasPnlGst: false,
    hasNet: false,
  }];
  sandbox.bucketCogsFromOrders(
    buckets,
    [{ created_at: '2026-06-01T18:56:28Z', total: revenueIncl,
       items: [{ qty: 1, supplier_cost_snapshot: costExGst }] }],
    () => 0
  );
  sandbox.assembleBucketExpense(buckets[0]);
  return buckets[0];
}

test('cross-val: Brother order bucket net === modal take-home ($32.21)', () => {
  // INV-2026-0017 — the order the user pointed at. Sell $348.25 ex / $400.49 incl,
  // supplier cost $305.13 ex. The order modal shows take-home $32.21.
  const b = assembleSingleOrderBucket({ revenueIncl: 400.49, costExGst: 305.13 });
  const canonical = profSandbox.computeOrderProfit(348.25, 305.13, { customerPaidInclGst: 400.49 });
  const bucketNet = b.revenue - b.expenses;
  assert.ok(Math.abs(canonical - 32.21) < 0.05, `canonical take-home ~$32.21, got ${canonical}`);
  assert.ok(Math.abs(bucketNet - canonical) < 0.02,
    `bucket net must equal computeOrderProfit: ${bucketNet} vs ${canonical}`);
  // And the bucket's GST line must equal the modal's NET gstRemittedToIrd (~$4.83),
  // never the gross output GST (~$52.24).
  const bd = profSandbox.computeProfitBreakdown(348.25, 305.13, { customerPaidInclGst: 400.49 });
  assert.ok(Math.abs(bd.gstRemittedToIrd - 4.83) < 0.05, `modal net GST ~$4.83, got ${bd.gstRemittedToIrd}`);
  assert.ok(Math.abs(b.gstTotal - bd.gstRemittedToIrd) < 0.05,
    `bucket GST must equal net remitted: ${b.gstTotal} vs ${bd.gstRemittedToIrd}`);
  // Sanity on the user's complaint: expenses must sit BELOW revenue (a profit).
  assert.ok(b.expenses < b.revenue, `expenses ${b.expenses} must be below revenue ${b.revenue}`);
});

test('cross-val: bucket components === the cash waterfall (COGS incl, Stripe incl, NET GST)', () => {
  const b = assembleSingleOrderBucket({ revenueIncl: 400.49, costExGst: 305.13 });
  const bd = profSandbox.computeProfitBreakdown(348.25, 305.13, { customerPaidInclGst: 400.49 });
  assert.ok(Math.abs(b.cogsTotal - bd.supplierCostInclGst) < 0.01,
    `COGS must be incl-GST cash to supplier: ${b.cogsTotal} vs ${bd.supplierCostInclGst}`);
  assert.ok(Math.abs(b.stripeTotal - bd.stripeFeeInclGst) < 0.05,
    `Stripe must be incl-GST: ${b.stripeTotal} vs ${bd.stripeFeeInclGst}`);
  // Every dollar accounted: COGS + Stripe + net GST === customerPaid − take-home.
  const cashOut = b.cogsTotal + b.stripeTotal + b.gstTotal;
  assert.ok(Math.abs(cashOut - (b.revenue - bd.netProfit)) < 0.05,
    `cash out must foot to revenue − take-home: ${cashOut} vs ${b.revenue - bd.netProfit}`);
});

test('cross-val: multi-order window net === Σ computeOrderProfit (GST-neutral)', () => {
  // Mixed window: the thin-margin Brother + a healthier compatible order.
  const orders = [
    { revenueIncl: 400.49, sellEx: 348.25, costEx: 305.13 },  // ~8% margin
    { revenueIncl: 165.90, sellEx: 144.26, costEx: 80.00 },   // healthy
  ];
  const buckets = [{
    startMs: 0, revenue: 0, orders: 0,
    pnlCogs: 0, hasPnlCogs: false, cogsDerived: 0, cogsFromOrders: 0, hasOrderCogs: false,
    pnlOpex: 0, hasPnlOpex: false, opexLogged: 0,
    pnlStripe: 0, hasPnlStripe: false, pnlGst: 0, hasPnlGst: false, hasNet: false,
  }];
  const raw = orders.map((o, i) => ({
    created_at: '2026-06-01T18:56:28Z', total: o.revenueIncl,
    items: [{ qty: 1, supplier_cost_snapshot: o.costEx }],
  }));
  for (const o of orders) { buckets[0].revenue += o.revenueIncl; buckets[0].orders += 1; }
  sandbox.bucketCogsFromOrders(buckets, raw, () => 0);
  sandbox.assembleBucketExpense(buckets[0]);

  const bucketNet = buckets[0].revenue - buckets[0].expenses;
  const canonicalSum = orders.reduce((s, o) =>
    s + profSandbox.computeOrderProfit(o.sellEx, o.costEx, { customerPaidInclGst: o.revenueIncl }), 0);
  // Per-order Stripe ($0.30 fixed × N) vs bucket Stripe (orders × $0.30) agree
  // for same N, so the window net matches the sum of order take-homes closely.
  assert.ok(Math.abs(bucketNet - canonicalSum) < 0.05,
    `window net must equal Σ computeOrderProfit: ${bucketNet} vs ${canonicalSum}`);
  assert.ok(bucketNet > 0 && buckets[0].expenses < buckets[0].revenue);
});
