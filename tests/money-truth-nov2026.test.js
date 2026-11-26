/**
 * Dashboard money — utils/money-truth.js on the backend's dashboard-summary (2026-11-26)
 * ===================================================================================
 *
 * The backend shipped every section of backend-asks-2026-11-25-dashboard (one deploy,
 * migrations 218–220): invoices on their issue date, processed refunds off on refunded_at,
 * expenses by bill date paid or not, GST payments not an expense, ONE P&L definition, and
 * GET /api/admin/analytics/dashboard-summary. The FE adjustments that bridged those gaps
 * (redateInvoices, refundsIn, opexByBillDate) were DELETED — re-adding one would subtract the
 * same refund twice. These tests pin what replaced them, against the LIVE payloads measured
 * 2026-11-26 (tests/fixtures/dashboard-summary-nov2026.json), whose figures equal the backend
 * reply's own live-check table to the cent.
 *
 * Also pins the Net Profit second line (supersedes ERR-392's "after $X unpaid bills"): net
 * profit now INCLUDES unpaid bills dated in range, so the line says how much is unpaid and
 * never subtracts it again.
 *
 * Run with: node --test tests/money-truth-nov2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'money-truth.js');
const SRC = fs.readFileSync(MODULE, 'utf8');
const DASH = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'), 'utf8');
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dashboard-summary-nov2026.json'), 'utf8'));

// The module is import-free ESM; load it as .mjs from a temp copy. normalizeDashboardSummary
// lives in api.js (tested in admin-analytics-wiring); this mirrors its output shape for the
// fields money-truth reads, so a raw payload can be fed through unchanged.
let M;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-truth-'));
  const file = path.join(dir, 'money-truth.mjs');
  fs.copyFileSync(MODULE, file);
  M = await import('file://' + file);
});

const KEYS = ['revenue_incl_gst', 'revenue_ex_gst', 'refunds', 'cogs', 'gross_profit', 'stripe_fees',
  'supplier_freight', 'operating_expenses', 'net_profit', 'orders', 'aov', 'owed_unpaid_invoices'];
const win = (w) => (w ? { ...Object.fromEntries(KEYS.map((k) => [k, w[k] ?? null])), cogs_unknown_orders: w.cogs_unknown_orders ?? null } : null);
const norm = (raw) => ({ ...raw, current: win(raw.current), previous: win(raw.previous) });
const OCT = { from: '2026-10-01', to: '2026-10-31' };
const D30 = { from: '2026-10-26', to: '2026-11-25' };
const sum = (inputs) => Math.round(inputs.reduce((a, i) => a + i.amount, 0) * 100) / 100;

// ─── 1. The live October figures (the backend reply's live-check table) ─────────────────
test('October: every tile equals the backend figure, untouched', () => {
  const { figures: f, warnings } = M.dashboardMoney(norm(F.dsum_oct));
  assert.equal(f.revenueInclGst.value, 5877.15);
  assert.equal(f.revenueExGst.value, 5110.57);
  assert.equal(f.grossProfit.value, 1413.32);
  assert.equal(f.netProfit.value, -1890.79);
  assert.equal(f.orders.value, 52);
  assert.equal(f.owed.value, 302.83);
  assert.equal(f.revenueInclGst.refunds, 0);
  assert.equal(f.grossProfit.atMost, false);
  assert.equal(f.netProfit.atMost, false);
  assert.deepEqual(warnings, []);
  // previous window comes from the same payload (2026-08-31..2026-09-30)
  assert.equal(typeof f.netProfit.prev, 'number');
});

test('30 days to 25 Nov: revenue is AFTER the $59.40 refund, and says so', () => {
  const { figures: f } = M.dashboardMoney(norm(F.dsum_30));
  assert.equal(f.revenueInclGst.value, 6432.20);
  assert.equal(f.revenueInclGst.refunds, 59.40);
  assert.equal(f.revenueExGst.value, 5593.22);
  const [sales, refunds] = f.revenueInclGst.inputs;
  assert.equal(sales.amount, 6491.60, 'sales before refunds');
  assert.equal(refunds.amount, -59.40, 'the refund comes off once, from the backend figure');
  assert.equal(f.grossProfit.value, 651.15);
  assert.equal(f.netProfit.value, -1641.04);
});

// ─── 2. "How it's calculated": inputs add up EXACTLY ───────────────────────────────────
test('every money figure: inputs add up exactly to the value (rounding shown, never hidden)', () => {
  for (const raw of [F.dsum_oct, F.dsum_30]) {
    const { figures: f } = M.dashboardMoney(norm(raw));
    for (const key of ['revenueInclGst', 'revenueExGst', 'grossProfit', 'netProfit']) {
      assert.ok(f[key].inputs.length >= 2, `${key} shows its steps`);
      assert.equal(sum(f[key].inputs), f[key].value, `${key} inputs must sum to the value`);
      for (const i of f[key].inputs) assert.ok(['backend', 'calculated'].includes(i.source), `${key}: source ${i.source}`);
      assert.equal(f[key].unexplained, 0, `${key}: live figures have no unexplained gap`);
    }
  }
});

test('a 1–2¢ backend rounding gap is a labelled row; more than 2¢ is UNEXPLAINED and warned', () => {
  const r = norm(F.dsum_oct);
  // Live October: 1413.32 − 122.41 − 414.80 − 2766.89 = −1890.78; the backend says −1890.79.
  let m = M.dashboardMoney(r);
  assert.ok(m.figures.netProfit.inputs.some((i) => /Rounding/.test(i.label) && i.amount === -0.01),
    'the live 1¢ is SHOWN as backend rounding');
  r.current.net_profit = -1890.76;   // 2¢ the other way: still rounding
  m = M.dashboardMoney(r);
  assert.ok(m.figures.netProfit.inputs.some((i) => /Rounding/.test(i.label) && i.amount === 0.02));
  assert.equal(m.figures.netProfit.unexplained, 0);
  r.current.net_profit = -1880.78;   // $10 off
  m = M.dashboardMoney(r);
  assert.ok(m.figures.netProfit.inputs.some((i) => /UNEXPLAINED/.test(i.label)));
  assert.equal(m.figures.netProfit.unexplained, 10);
  assert.ok(m.warnings.some((w) => /Net profit: .*not rounding/.test(w)));
  assert.equal(sum(m.figures.netProfit.inputs), -1880.78, 'still sums exactly');
});

// ─── 3. Fail-soft must be LOUD ───────────────────────────────────────────────────────────
test('an un-costed sale ⇒ gross and net are AT MOST, the sale is named (INV-3275 case)', () => {
  const r = norm(F.dsum_oct);
  r.current.cogs_unknown_orders = [{ order_id: 'x', order_number: 'INV-3275', skus: [] }];
  const m = M.dashboardMoney(r);
  assert.equal(m.figures.grossProfit.atMost, true);
  assert.equal(m.figures.netProfit.atMost, true);
  assert.equal(m.figures.grossMargin.atMost, true);
  assert.match(m.figures.grossProfit.note, /AT MOST.*INV-3275/);
  assert.ok(m.warnings.some((w) => /AT MOST.*INV-3275/.test(w)));
  assert.equal(m.figures.grossProfit.value, 1413.32, 'the figure is still shown — not a bare "—"');
});

test('failed or unstated supplier freight qualifies net profit', () => {
  const r = norm(F.dsum_oct);
  r.supplier_freight_failed = true;
  let m = M.dashboardMoney(r);
  assert.equal(m.figures.netProfit.atMost, true);
  assert.ok(m.warnings.some((w) => /freight.*AT MOST/.test(w)));
  r.supplier_freight_failed = null;
  m = M.dashboardMoney(r);
  assert.match(m.figures.netProfit.note, /did not say whether supplier freight loaded/);
});

test('no payload ⇒ no figures and a reason — never a $0', () => {
  for (const bad of [null, {}, { current: null }]) {
    const m = M.dashboardMoney(bad);
    assert.equal(m.figures, null);
    assert.match(m.warnings[0], /did not load.*not a zero/);
  }
  const r = norm(F.dsum_oct);
  r.current.gross_profit = null;
  const m = M.dashboardMoney(r);
  assert.equal(m.figures.grossProfit.value, null);
  assert.match(m.figures.grossProfit.note, /did not report gross profit/);
  assert.equal(m.figures.grossMargin.value, null);
});

test('ERR-395: the freight row names no threshold figure, so it cannot go stale again', () => {
  // The rule moved from "$100 ex GST" to "$100 incl GST" (owner 2026-11-26) and the old label
  // stated the ex-GST one. The backend decides; the label only says a threshold exists.
  const { figures: f } = M.dashboardMoney(norm(F.dsum_oct));
  const freight = f.netProfit.inputs.find((i) => /Supplier freight/.test(i.label));
  assert.ok(freight);
  assert.match(freight.label, /Augmento and Streamline only when our cost is under their free-shipping threshold/);
  assert.doesNotMatch(freight.label, /\$100|ex GST of goods/);
});

test('margins are profit ÷ ex-GST revenue from the same payload', () => {
  const { figures: f } = M.dashboardMoney(norm(F.dsum_oct));
  assert.equal(Math.round(f.grossMargin.value * 100) / 100, Math.round((1413.32 / 5110.57) * 10000) / 100);
  assert.deepEqual(f.netMargin.of, ['Net profit', 'Revenue (excl. GST)']);
});

// ─── 4. The deleted adjustments stay deleted ────────────────────────────────────────────
test('no FE adjustment survives: no re-dating, no refund subtraction, no expense re-count', () => {
  // (The header names them, as history; no code may define or call them.)
  assert.doesNotMatch(SRC, /function\s+(redateInvoices|refundsIn|opexByBillDate|moneyTruth)\b|\b(redateInvoices|refundsIn|opexByBillDate)\(/);
  assert.doesNotMatch(SRC, /'adjusted on this screen'|REMOVAL MAP/);
  assert.doesNotMatch(DASH, /adjusted on this screen/);
  assert.doesNotMatch(SRC, /^import /m, 'import-free (pure, vm-testable)');
  assert.doesNotMatch(SRC, /toISOString\(\)\.slice\(0, ?10\)/, 'NZ days only, never the UTC slice');
});

// ─── 5. Net Profit second line ───────────────────────────────────────────────────────────
test('unpaid bills: the live October rows reproduce the backend opex to the cent first', () => {
  const r = M.unpaidBillsInRange(F.expenses, OCT, 2766.89);
  assert.deepEqual(r, { value: 0, count: 0 });
  assert.equal(M.unpaidBillsLine(r), 'All bills in this period are paid');
  assert.deepEqual(M.unpaidBillsInRange(F.expenses, D30, 1769.72), { value: 0, count: 0 });
});

test('an unpaid bill is counted at its ex-GST cost, and is NOT subtracted again', () => {
  const rows = F.expenses.map((x) => ({ ...x }));
  const target = rows.find((x) => x.expense_date >= '2026-10-01' && x.expense_date <= '2026-10-31' && x.gst_claimable && x.category !== 'gst_payment');
  target.derived_status = 'due';
  const r = M.unpaidBillsInRange(rows, OCT, 2766.89);
  assert.equal(r.count, 1);
  assert.equal(r.value, Math.round(target.amount * 20 / 23 * 100) / 100);
  assert.match(M.unpaidBillsLine(r), /^Includes \$\d+\.\d{2} of bills not paid yet$/);
  // The Dashboard never subtracts it: the old "after $X unpaid bills" arithmetic is gone.
  assert.doesNotMatch(DASH, /unpaidBillsSub|netProfit - unpaid|after \$\{formatPrice\(unpaid\)\} unpaid bills/);
  assert.match(DASH, /sub: unpaidBillsLine\(unpaid\)/);
});

test('the gst_payment row (G.S.T $724.51) is not an expense — leaving it in breaks the proof', () => {
  // 2766.89 already excludes it; counting it would make the rows add to 3491.40 and refuse.
  const rows = F.expenses.map((x) => (x.category === 'gst_payment' ? { ...x, category: 'other' } : x));
  const r = M.unpaidBillsInRange(rows, OCT, 2766.89);
  assert.equal(r.value, null);
  assert.match(r.reason, /add up to \$3491\.40, not the \$2766\.89/);
  assert.match(M.unpaidBillsLine(r), /^Unpaid bills: could not confirm \(/);
});

test('unpaid bills refuses, loudly, when it cannot prove its total', () => {
  assert.match(M.unpaidBillsInRange(null, OCT, 1).reason, /did not load/);
  assert.match(M.unpaidBillsInRange(F.expenses, null, 1).reason, /no date range/);
  assert.match(M.unpaidBillsInRange(F.expenses, OCT, null).reason, /did not report operating expenses/);
  const recurring = F.expenses.map((x, i) => (i === 0 ? { ...x, expense_date: '2026-10-05', recurrence: 'monthly' } : x));
  assert.match(M.unpaidBillsInRange(recurring, OCT, 2766.89).reason, /recurring/);
  assert.equal(M.unpaidBillsLine(null), '');
});

// ─── 6. To-dos and the action lists ─────────────────────────────────────────────────────
test('to-dos read the live lists: one pending refund, no tax row filed as an expense', () => {
  const t = M.moneyTodos({ range: OCT, expenses: F.expenses, refunds: F.refunds, invoices: F.invoices, orderRef: (n) => `#${n}` });
  assert.equal(t.pendingRefunds.length, 1);
  assert.match(t.pendingRefunds[0].label, /^2026100901: \$14\.00 pending since 2026-10-/);
  assert.equal(t.pendingRefunds[0].href, 'orders?focus=%232026100901', 'links go through the order-number formatter');
  assert.deepEqual(t.taxAsExpense, [], 'the G.S.T row is in gst_payment now');
  assert.ok(Array.isArray(t.duplicates));
  assert.ok(Array.isArray(t.invoiceCostOverPrice));
});

test('a tax payment still filed as an operating expense is flagged', () => {
  const rows = F.expenses.map((x) => (x.category === 'gst_payment' ? { ...x, category: 'other' } : x));
  const t = M.moneyTodos({ range: OCT, expenses: rows, refunds: [], invoices: [] });
  assert.equal(t.taxAsExpense.length, 1);
  assert.match(t.taxAsExpense[0].label, /G\.S\.T: \$724\.51 on 2026-10-20 — move to "GST \/ tax payment to IRD"/);
});

test('a list that did not load is null ("could not load"), never an empty all-clear', () => {
  const t = M.moneyTodos({ range: OCT, expenses: null, refunds: null, invoices: null });
  assert.deepEqual(t, { duplicates: null, pendingRefunds: null, taxAsExpense: null, invoiceCostOverPrice: null });
});

test('missing-cost action: unavailable is null; rows link to the invoice or the order', () => {
  assert.equal(M.missingCostItems({ count: null, rows: [], error: 'unavailable' }), null);
  assert.equal(M.missingCostItems(undefined), null);
  const m = M.missingCostItems({ count: 3, rows: [
    { order_id: 'a', order_number: 'INV-3275', skus: [] },
    { order_id: 'b', order_number: '2026110601', skus: ['GLC135XLC'] },
  ] }, (n) => `#${n}`);
  assert.equal(m.count, 3);
  assert.equal(m.truncated, true, 'count beyond the rows is said, not hidden');
  assert.deepEqual(m.items[0], { label: 'INV-3275 — no cost recorded', href: 'invoices' });
  assert.deepEqual(m.items[1], { label: '2026110601 — no cost on GLC135XLC', href: 'orders?focus=%232026110601' });
});

test('refund rate = processed refunds in range ÷ the orders the money counts', () => {
  const series = { series: [{ refund_count: 0 }, { refund_count: 1 }] };
  assert.equal(Math.round(M.refundRatePct(series, 52) * 100) / 100, 1.92);
  assert.equal(M.refundRatePct(series, 0), null);
  assert.equal(M.refundRatePct(null, 52), null);
  assert.equal(M.refundRatePct({ series: [{ refund_count: null }] }, 52), null, 'an unknown day is not a zero');
});

test('possible duplicate expenses: same payee, similar amount, within 5 days', () => {
  const rows = [
    { id: 1, payee: 'Spark', amount: 100, expense_date: '2026-10-02' },
    { id: 2, payee: 'spark ', amount: 100.5, expense_date: '2026-10-05' },
    { id: 3, payee: 'Spark', amount: 100, expense_date: '2026-10-20' },
  ];
  const pairs = M.possibleDuplicateExpenses(rows, OCT);
  assert.equal(pairs.length, 1);
  assert.match(pairs[0].label, /Spark: \$100\.00 on 2026-10-02 and \$100\.50 on 2026-10-05/);
});
