/**
 * invoice-overlay.js — the guards that stop it lying
 * =================================================
 *
 * The overlay adds invoiced sales to the Dashboard/Finance KPIs client-side while
 * the backend catches up. It is the kind of code that fails SILENTLY and
 * plausibly, so its guards are pinned here:
 *
 *   1. SELF-RETIRING. backendCountsInvoices() must fire on the flag the backend
 *      spec promises (includes_invoices). If it doesn't, the day the backend
 *      ships we add invoices on top of numbers that already contain them and the
 *      revenue silently DOUBLES.
 *
 *   2. NO PARTIAL PROFIT. If any invoice in the window has an un-costed line,
 *      COGS and profit come back null so the caller leaves those tiles alone.
 *      Revenue and order count still overlay — we know those regardless of cost.
 *
 *   3. TWO REVENUE FIGURES. kpi-summary.revenue is incl-GST; pnl.revenue is
 *      ex-GST. Adding the wrong one is a silent 15% error that looks plausible.
 *
 *   4. WINDOWING. An invoice outside the selected range must not be counted.
 *
 * Run with: node --test tests/admin-invoice-overlay.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');

function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  // NB the `async` group: invoice-overlay.js exports `export async function`, which
  // a bare (const|let|var|function|class) pattern silently fails to strip.
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, asyncKw, kw, id) => { exposed.add(id); return `${asyncKw || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

// invoice-overlay imports AdminAPI (network) — only the pure functions are under
// test here, so a bare window stub is enough to let the module evaluate.
const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date, Promise };
sandbox.window = { DebugLog: { warn() {} } };
sandbox.AdminAPI = {};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of ['utils/profitability.js', 'utils/invoice-math.js', 'utils/invoice-overlay.js']) {
  vm.runInContext(stripEsm(fs.readFileSync(path.join(ADMIN, f), 'utf8')), ctx, { filename: path.basename(f) });
}
const { backendCountsInvoices, aggregateInvoices, normalizeInvoice } = sandbox;

const approx = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// A saved invoice as the backend hands it back.
const invoice = (over = {}) => normalizeInvoice({
  id: 'i1', status: 'unpaid', order_date: '2026-07-08',
  line_items: [{ product_code: 'X', quantity: 1, unit_cost_excl_gst: 100, supplier_cost_excl_gst: 60 }],
  freight_excl_gst: 0,
  ...over,
});

// ─── 1. The safety interlock ─────────────────────────────────────────────────
test('backendCountsInvoices fires on the includes_invoices flag the spec promises', () => {
  // If this ever stops matching what the backend sends, revenue DOUBLES the day
  // the backend ships. It is the single most important assertion in this file.
  assert.equal(backendCountsInvoices({ includes_invoices: true }), true);
  assert.equal(backendCountsInvoices({ current: { includes_invoices: true } }), true);
  assert.equal(backendCountsInvoices({ totals: { includes_invoices: true } }), true);
  assert.equal(backendCountsInvoices({ meta: { includes_invoices: true } }), true);
});

test('backendCountsInvoices also fires on an invoice_* breakdown field', () => {
  assert.equal(backendCountsInvoices({ current: { invoice_revenue: 0 } }), true,
    'a ZERO invoice_revenue still means the backend is counting them — 0 is a real answer');
  assert.equal(backendCountsInvoices({ invoice_orders: 3 }), true);
});

test("backendCountsInvoices is false for today's backend, which knows nothing of invoices", () => {
  assert.equal(backendCountsInvoices({ current: { revenue: 5735.4, orders: 54 } }), false);
  assert.equal(backendCountsInvoices({}), false);
  assert.equal(backendCountsInvoices(null), false);
  assert.equal(backendCountsInvoices({ includes_invoices: false }), false);
});

// ─── 2. No partial profit ────────────────────────────────────────────────────
test('a window where every cost is known overlays revenue AND profit', () => {
  const d = aggregateInvoices([invoice()], { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(d.count, 1);
  assert.equal(d.costsKnown, true);
  approx(d.revenueExGst, 100);
  approx(d.revenueInclGst, 115);
  approx(d.cogsExGst, 60);
  approx(d.grossProfit, 40);
  approx(d.netProfit, 40);   // bank transfer: no card fee, so gross === net
});

test('ONE un-costed invoice nulls the profit for the whole window — but not the revenue', () => {
  // This is the state of the world TODAY: the backend does not persist supplier
  // cost yet, so every saved invoice reads as un-costed. Revenue and Orders must
  // still overlay; profit must not.
  const costed = invoice();
  const uncosted = invoice({ id: 'i2', line_items: [{ product_code: 'Y', quantity: 1, unit_cost_excl_gst: 50 }] });
  const d = aggregateInvoices([costed, uncosted], { from: '2026-07-01', to: '2026-07-31' });

  assert.equal(d.costsKnown, false);
  assert.equal(d.cogsExGst, null, 'a partial COGS must not be presented as the COGS');
  assert.equal(d.grossProfit, null);
  assert.equal(d.netProfit, null);
  // …but the revenue we DO know still counts.
  approx(d.revenueExGst, 150);
  assert.equal(d.orders, 2);
});

// ─── 3. Two revenue figures, on purpose ──────────────────────────────────────
test('revenueInclGst and revenueExGst differ by exactly the GST', () => {
  // The Dashboard tile wants incl-GST; the P&L row wants ex-GST. Adding the wrong
  // one to the wrong surface is a plausible-looking 15% error.
  const d = aggregateInvoices([invoice()], { from: '2026-07-01', to: '2026-07-31' });
  approx(d.revenueInclGst, d.revenueExGst * 1.15);
});

test('freight counts as revenue, and is included ex-GST', () => {
  const d = aggregateInvoices([invoice({ freight_excl_gst: 20 })], { from: '2026-07-01', to: '2026-07-31' });
  approx(d.revenueExGst, 120);          // 100 goods + 20 freight
  approx(d.revenueInclGst, 138);        // × 1.15
});

// ─── 4. Windowing ────────────────────────────────────────────────────────────
test('an invoice outside the window is not counted', () => {
  const june = invoice({ id: 'i3', order_date: '2026-06-30' });
  const july = invoice({ id: 'i4', order_date: '2026-07-08' });
  const d = aggregateInvoices([june, july], { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(d.count, 1);
  approx(d.revenueExGst, 100);
});

test('the window boundaries are inclusive on both ends', () => {
  const first = invoice({ id: 'a', order_date: '2026-07-01' });
  const last = invoice({ id: 'b', order_date: '2026-07-31' });
  const d = aggregateInvoices([first, last], { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(d.count, 2);
});

test('a null window counts everything (the "All time" period)', () => {
  const d = aggregateInvoices([invoice({ order_date: '2024-01-01' }), invoice({ id: 'z' })], {});
  assert.equal(d.count, 2);
});

test('an empty window is a zero delta, not a null one', () => {
  // Zero must not read as "overlay unavailable" — it means "no invoices here",
  // which is a real, usable answer.
  const d = aggregateInvoices([invoice()], { from: '2020-01-01', to: '2020-12-31' });
  assert.equal(d.count, 0);
  assert.equal(d.revenueExGst, 0);
  assert.equal(d.costsKnown, true);
});

test('aggregateInvoices(null) is null — a failed fetch must not become a zero delta', () => {
  assert.equal(aggregateInvoices(null, {}), null);
});

// ─── 5. The double-count guard survives the overlay path ─────────────────────
test('the aggregate reflects only invoices the caller already filtered', () => {
  // countsForAnalytics does the filtering upstream (fetchCountableInvoices), and
  // admin-invoice-cost-math.test.js pins its rules. Here we just confirm the
  // aggregate is a plain sum of what it's handed — no second, divergent filter.
  const d = aggregateInvoices([invoice(), invoice({ id: 'i2' })], { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(d.orders, 2);
  approx(d.revenueExGst, 200);
});
