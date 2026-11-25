/**
 * money-truth.js — the rebuilt Dashboard's money boxes (owner definitions, 2026-11-25).
 *
 * Fixture: tests/fixtures/money-truth-nov2026.json, a READ-ONLY capture of the live admin API
 * (owner session, 2026-11-25): kpi-summary for Oct and 1–25 Nov, every invoice-channel order,
 * every invoice, every refund, every expense. Money fields only — no customer names/emails.
 *
 * Every expected value below was reconciled BY HAND from the fixture rows (see comments), and
 * independently by the chief review's prototype for the parts it shares.
 *
 * Run: node --test tests/money-truth-nov2026.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'money-truth.js');
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'money-truth-nov2026.json'), 'utf8'));

// The module is import-free ESM; load it as .mjs from a temp copy.
let M;
test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-truth-'));
  const file = path.join(dir, 'money-truth.mjs');
  fs.copyFileSync(MODULE, file);
  M = await import('file://' + file);
});

const OCT = { from: '2026-10-01', to: '2026-10-31' };
const NOV = { from: '2026-11-01', to: '2026-11-25' };
const ORDER_LINKED = ['inventory', 'merchant_fees', 'customer_shipping'];
const GST_ROW = F.expenses.items.find((r) => r.name === 'G.S.T').id;

// What the page does: the category registry gives each row a kind; a G.S.T row moved to the
// new category resolves to 'not_expense'.
const expenseRows = (notExpense = []) => F.expenses.items.map((r) => ({
  ...r,
  kind: notExpense.includes(r.id) ? 'not_expense' : (ORDER_LINKED.includes(r.category) ? 'order_linked' : 'operating'),
}));
const src = (over = {}) => ({
  compare: true,
  invoices: { rows: F.invoices.rows, total: F.invoices.total },
  shadows: { rows: F.shadows, total: F.shadows.length },
  refunds: { rows: F.refunds.rows, total: F.refunds.pagination.total },
  expenses: { rows: expenseRows(), total: F.expenses.pagination.total, legacy: false },
  ...over,
});
const oct = (over) => M.moneyTruth({ range: OCT, kpi: F.kpiOct, ...src(over) });
const MONEY = ['revenueInclGst', 'revenueExGst', 'grossProfit', 'netProfit', 'orders'];

// ── October, by hand ────────────────────────────────────────────────────────────────────
test('October: every money box, reconciled by hand', () => {
  const f = oct().figures;
  // 6073.14 backend − 195.99 (INV-3298: issued 22 Nov, its sales record says 1 Oct).
  // No processed refund in Oct: 70.49 was paid back 17 Sep (logged 25 Oct); 14.00 is pending.
  assert.equal(f.revenueInclGst.value, 5877.15);
  assert.equal(f.revenueExGst.value, 5110.57);                 // 5877.15 × 20/23
  // 1443.94 − (195.99 × 20/23 − 139.80) = 1443.94 − 30.63. INV-3284 is in both sets: no effect.
  assert.equal(f.grossProfit.value, 1413.31);
  // 1413.31 − 122.41 Stripe − 414.80 freight − 3491.40 expenses (bill date = paid date in Oct).
  assert.equal(f.netProfit.value, -2615.30);
  assert.equal(f.orders.value, 52);                             // 53 − INV-3298
  assert.equal(f.aov.value, 98.28);                             // 5110.57 / 52
  assert.equal(Math.round(f.grossMargin.value * 10) / 10, 27.7);
  assert.equal(Math.round(f.netMargin.value * 10) / 10, -51.2);
  for (const k of MONEY) assert.equal(f[k].adjusted, true, k);
});

test('October: the G.S.T payment moved to "GST payment to IRD" leaves net profit', () => {
  const f = oct({ expenses: { rows: expenseRows([GST_ROW]), total: F.expenses.pagination.total } }).figures;
  assert.equal(f.netProfit.value, -1890.79);                     // −2615.30 + 724.51
  const opex = f.netProfit.inputs.find((i) => /Operating expenses/.test(i.label));
  assert.equal(opex.amount, -2766.89);
  assert.match(opex.label, /\$724\.51 of GST payments to IRD left out/);
  assert.equal(f.grossProfit.value, 1413.31, 'gross never moves with expenses');
});

test('November 1–25: INV-3298 moves IN; the 6 Nov refund comes off', () => {
  const f = M.moneyTruth({ range: NOV, kpi: F.kpiNov, ...src() }).figures;
  assert.equal(f.revenueInclGst.value, 5763.38);                // 5626.79 + 195.99 − 59.40
  assert.equal(f.grossProfit.value, 468.67);                    // 489.69 + 30.63 − 51.65
  assert.equal(f.orders.value, 47);
});

test('every money figure: inputs add up EXACTLY to the value', () => {
  for (const m of [oct(), M.moneyTruth({ range: NOV, kpi: F.kpiNov, ...src() })]) {
    for (const k of MONEY) {
      const fig = m.figures[k];
      const sum = Math.round(fig.inputs.reduce((a, i) => a + i.amount, 0) * 100) / 100;
      assert.equal(sum, fig.value, k);
      assert.ok(fig.inputs.every((i) => ['backend', 'adjusted on this screen', 'calculated'].includes(i.source)), k);
    }
  }
});

test('adjusted figures say what they replace', () => {
  const f = oct().figures;
  assert.equal(f.revenueInclGst.replaces, 'kpi-summary revenue');
  assert.equal(f.netProfit.replaces, 'kpi-summary net_profit');
  assert.ok(f.revenueInclGst.inputs.some((i) => /INV-3298 \(issued 2026-11-22\)/.test(i.label)));
});

// ── previous period ─────────────────────────────────────────────────────────────────────
test('previousRange = same NZ day count, ending the day before (incl. across DST)', () => {
  assert.deepEqual({ ...M.previousRange(OCT) }, { from: '2026-08-31', to: '2026-09-30' });
  assert.deepEqual({ ...M.previousRange(NOV) }, { from: '2026-10-07', to: '2026-10-31' });
  assert.deepEqual({ ...M.previousRange({ from: '2026-09-20', to: '2026-10-10' }) }, { from: '2026-08-30', to: '2026-09-19' });
  assert.equal(M.previousRange({ from: null, to: '2026-11-25' }), null);
});

test('previous window gets the same adjustments; the Sep refund lands there', () => {
  const m = oct();
  assert.equal(m.figures.revenueInclGst.prevComparable, true);
  const refunds = m.adjustments.find((a) => a.id === 'refunds');
  assert.equal(refunds.applied, true);
  assert.equal(refunds.prev.applied, true);
  // 31 Aug–30 Sep: the 70.49 refund (refunded_at 2026-09-17) is in this window.
  const prevRev = m.figures.revenueInclGst.prev;
  assert.equal(prevRev, 10538.58);   // 7590.13 + 3018.94 invoices by issue date − 70.49
});

test('compare:false (All time) has no previous figures', () => {
  const m = M.moneyTruth({ range: OCT, kpi: F.kpiOct, ...src({ compare: false }) });
  assert.equal(m.previousRange, null);
  assert.equal(m.figures.netProfit.prev, undefined);
});

// ── timezone ────────────────────────────────────────────────────────────────────────────
test('NZ day, never the UTC slice (negative control included)', () => {
  // A shadow at 2026-09-30T20:00Z is NZ 1 Oct. Shift INV-3284's record there: still in October.
  const shadows = F.shadows.map((s) => (s.order_number === 'INV-3284' ? { ...s, created_at: '2026-09-30T20:00:00Z' } : s));
  const m = oct({ shadows: { rows: shadows, total: shadows.length } });
  assert.equal(m.adjustments[0].applied, true);
  assert.equal('2026-09-30T20:00:00Z'.slice(0, 10), '2026-09-30', 'the UTC slice would have dropped it from October');
});

// ── refusals: one input failing never becomes a zero ────────────────────────────────────
test('§1 refuses when the backend’s invoice set does not reconcile', () => {
  const shadows = F.shadows.filter((s) => s.order_number !== 'INV-3284');
  const m = oct({ shadows: { rows: shadows, total: shadows.length } });
  const a = m.adjustments.find((x) => x.id === 'invoice-dates');
  assert.equal(a.applied, false);
  assert.match(a.reason, /1074\.27 from 7 records vs 1270\.26 from 8/);
  assert.equal(m.figures.revenueInclGst.value, 6073.14, 'backend figure, unadjusted');
  assert.ok(m.warnings.some((w) => /invoice-dates/.test(w)));
});

test('§1 refuses on a truncated list', () => {
  const m = oct({ invoices: { rows: F.invoices.rows.slice(0, 30), total: F.invoices.total } });
  assert.match(m.adjustments[0].reason, /30 of 37 invoices were read/);
});

test('refunds list missing: refused, named, revenue stays the backend figure for that part', () => {
  const m = M.moneyTruth({ range: NOV, kpi: F.kpiNov, ...src({ refunds: null }) });
  assert.equal(m.adjustments.find((a) => a.id === 'refunds').applied, false);
  assert.equal(m.figures.revenueInclGst.value, 5822.78);        // 5626.79 + 195.99, no refund
  assert.ok(m.warnings.some((w) => /refunds list did not load/.test(w)));
});

test('refunds: only PROCESSED, dated by refunded_at; switches off when kpi returns refunds', () => {
  const pendingOnly = { rows: [{ order_number: 'X', amount: 50, status: 'pending', created_at: '2026-10-10T00:00:00Z', refunded_at: null }], total: 1 };
  assert.equal(oct({ refunds: pendingOnly }).figures.revenueInclGst.value, 5877.15);
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, refunds: 10 } };
  const m = M.moneyTruth({ range: OCT, kpi, ...src() });
  const a = m.adjustments.find((x) => x.id === 'refunds');
  assert.equal(a.applied, false);
  assert.equal(a.backendHasIt, true);
  // Not silent: the switch-off is named so the owner (and FE) confirm before deleting §3.
  assert.ok(m.warnings.some((w) => /^Check \(refunds\): kpi-summary now returns `refunds`/.test(w)));
  assert.ok(!m.warnings.some((w) => /Not adjusted \(refunds\)/.test(w)));
});

test('kpi missing ⇒ every money figure null (never 0); owed still works', () => {
  const m = M.moneyTruth({ range: OCT, kpi: null, ...src() });
  assert.equal(m.figures, null);
  assert.ok(m.warnings.some((w) => /kpi-summary\) did not load/.test(w)));
  assert.equal(m.owedToUs.value, 2477.29);
});

test('gross dropped by the backend ⇒ gross, net, margins null with a reason', () => {
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, gross_profit: null, net_profit: null } };
  const f = M.moneyTruth({ range: OCT, kpi, ...src() }).figures;
  for (const k of ['grossProfit', 'netProfit', 'grossMargin', 'netMargin']) assert.equal(f[k].value, null, k);
  assert.match(f.grossProfit.note, /did not return gross profit/);
  assert.equal(f.revenueInclGst.value, 5877.15, 'revenue is unaffected');
});

test('§4 refuses: legacy list, truncated list, recurring row, cross-check mismatch', () => {
  const rows = expenseRows();
  const reason = (expenses) => oct({ expenses }).adjustments.find((a) => a.id === 'expenses-by-bill-date').reason;
  assert.match(reason({ rows, total: rows.length, legacy: true }), /old endpoint/);
  assert.match(reason({ rows: rows.slice(1), total: rows.length }), /75 of 76 expenses were read/);
  assert.match(reason({ rows: rows.map((r, i) => (i ? r : { ...r, recurrence: 'monthly' })), total: rows.length }), /recurring/);
  const noSupabase = rows.filter((r) => !(r.name === 'Supabase' && r.expense_date === '2026-10-07'));
  assert.match(reason({ rows: noSupabase, total: noSupabase.length }), /3446\.05 vs 3491\.4/);
});

test('§4 counts an UNPAID bill on its bill date', () => {
  const rows = [...expenseRows(), { id: 'u1', name: 'Accountant', payee: 'Accountant', amount: 115, gst_claimable: true, category: 'other', kind: 'operating', expense_date: '2026-10-15', paid_date: null, derived_status: 'due', recurrence: 'none' }];
  const f = oct({ expenses: { rows, total: rows.length } }).figures;
  assert.equal(f.netProfit.value, -2715.30);                    // −2615.30 − 115 × 20/23
  assert.match(f.netProfit.inputs.find((i) => /Operating/.test(i.label)).label, /\$100\.00 not paid yet/);
});

// ── owed, to-dos ────────────────────────────────────────────────────────────────────────
test('owed to us = unpaid invoices, any date; void and paid excluded (Invoices page rule)', () => {
  const o = M.owedToUs({ rows: F.invoices.rows, total: F.invoices.total });
  assert.equal(o.value, 2477.29);
  assert.equal(o.inputs.length, 10);
  assert.equal(M.owedToUs({ rows: F.invoices.rows.slice(1), total: F.invoices.total }).value, null);
  const inv = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'invoices.js'), 'utf8');
  assert.match(inv, /const isOutstanding = \(inv\) => !!inv && inv\.status !== 'paid' && inv\.status !== 'void';/,
    'the Invoices page rule changed — change owedToUs with it');
});

test('to-dos: duplicate pairs, pending refund, tax row, invoice cost over price', () => {
  const t = M.moneyTodos({ range: OCT, ...src() });
  assert.deepEqual(t.duplicates.map((d) => d.label), [
    'Google: $657.94 on 2026-10-05 and $657.94 on 2026-10-02',
    'Render: $94.71 on 2026-10-05 and $94.00 on 2026-10-02',
  ]);
  assert.equal(t.pendingRefunds.length, 1);
  assert.match(t.pendingRefunds[0].label, /2026100901: \$14\.00 pending since 2026-10-14/);
  assert.equal(t.taxAsExpense.length, 1);
  assert.deepEqual(t.invoiceCostOverPrice.map((i) => i.label.slice(0, 8)), ['INV-3289', 'INV-3294', 'INV-3296']);
});

test('duplicate rule negatives', () => {
  const r = (payee, amount, d) => ({ payee, name: payee, amount, expense_date: d });
  const pairs = (rows) => M.possibleDuplicateExpenses(rows, null).length;
  assert.equal(pairs([r('Google Ads', 1000, '2026-09-16'), r('Google Ads', 1000, '2026-10-14')]), 0, 'a month apart');
  assert.equal(pairs([r('Google Works', 74, '2026-10-02'), r('Google Works', 45.54, '2026-10-05')]), 0, 'different amounts');
  assert.equal(pairs([r('Render', 43.23, '2026-10-02'), r('Supabase', 43.21, '2026-10-02')]), 0, 'different payee');
  assert.equal(pairs([r('Render', 94, '2026-10-02'), r('Render', 94.71, '2026-10-05')]), 1);
});

// ── guards on the code around it ────────────────────────────────────────────────────────
test('module stays pure: no imports, no UTC date slicing of timestamps', () => {
  const s = fs.readFileSync(MODULE, 'utf8');
  assert.doesNotMatch(s, /^import /m);
  assert.doesNotMatch(s, /created_at\.slice\(0, ?10\)|refunded_at\.slice/);
});

test('Expenses save path: a backend-pending built-in rides the override map', () => {
  const s = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'expenses.js'), 'utf8');
  assert.match(s, /EXPENSE_CATEGORIES\.some\(c => c\.key === key && !c\.backendPending\)/);
  assert.match(s, /<optgroup label="Not an expense">\$\{notExpenseCategories\(\)/);
});

// ── chief verify findings (2026-11-25), each pinned ─────────────────────────────────────
const NOVsrc = (over) => M.moneyTruth({ range: NOV, kpi: F.kpiNov, ...src(over) });
const refundList = (rows) => ({ rows, total: rows.length });
const novRefund = F.refunds.rows.find((r) => r.order_number === '2026110601');

test('F1: a refund on a cancelled or test order is NOT taken off again (named instead)', () => {
  const extra = { id: 'x1', order_number: 'C1', type: 'refund', amount: 120, status: 'processed', created_at: '2026-11-10T00:00:00Z', refunded_at: '2026-11-10T00:00:00Z', order_status: 'cancelled', order_is_test: false };
  const m = NOVsrc({ refunds: refundList([...F.refunds.rows, extra]) });
  assert.equal(m.figures.revenueInclGst.value, 5763.38);
  assert.ok(m.warnings.some((w) => /Refund on C1 not taken off/.test(w)));
});

test('F1: an unknown order status behind a refund refuses the refunds part', () => {
  const rows = F.refunds.rows.map((r) => (r === novRefund ? { ...r, order_status: undefined } : r));
  const a = NOVsrc({ refunds: refundList(rows) }).adjustments.find((x) => x.id === 'refunds');
  assert.equal(a.applied, false);
  assert.match(a.reason, /order status behind refund 2026110601 could not be read/);
});

test('F2: unpriced supplier freight ⇒ "at most" net profit, loudly', () => {
  const kpi = { ...F.kpiNov, current: { ...F.kpiNov.current, supplier_freight_unpriced_orders: 3 } };
  const m = M.moneyTruth({ range: NOV, kpi, ...src() });
  assert.match(m.figures.netProfit.note, /AT MOST/);
  assert.ok(m.figures.netProfit.inputs.some((i) => /AT LEAST this: 3 unpriced/.test(i.label)));
  assert.ok(m.warnings.some((w) => /could not price/.test(w)));
});

test('F3: a shadow with no total refuses §1 (never "applied" with revenue and gross disagreeing)', () => {
  const shadows = F.shadows.map((x) => (x.order_number === 'INV-3284' ? { ...x, total: undefined } : x));
  const a = oct({ shadows: { rows: shadows, total: shadows.length } }).adjustments[0];
  assert.equal(a.applied, false);
  assert.match(a.reason, /INV-3284 does not carry the invoice's total/);
});

test('F3: numeric strings from the backend are numbers; garbage is null, never 0', () => {
  const str = Object.fromEntries(Object.entries(F.kpiOct.current).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]));
  const f = M.moneyTruth({ range: OCT, kpi: { ...F.kpiOct, current: str }, ...src() }).figures;
  assert.equal(f.grossProfit.value, 1413.31);
  assert.equal(f.orders.value, 52);
  const junk = { ...F.kpiOct.current, net_profit: 'n/a' };
  assert.equal(M.moneyTruth({ range: OCT, kpi: { ...F.kpiOct, current: junk }, ...src() }).figures.netProfit.value, null);
});

test('F4: an expense with an unknown kind refuses §4 instead of vanishing from the total', () => {
  const rows = expenseRows().map((r) => (r.name === 'Google Ads' && r.expense_date === '2026-10-14' ? { ...r, kind: undefined } : r));
  const a = oct({ expenses: { rows, total: rows.length } }).adjustments.find((x) => x.id === 'expenses-by-bill-date');
  assert.equal(a.applied, false);
  assert.match(a.reason, /no known category kind/);
});

test('F5: a list without a total, or with a duplicated row, is refused', () => {
  const noTotal = NOVsrc({ refunds: { rows: F.refunds.rows.filter((r) => r !== novRefund) } }).adjustments.find((x) => x.id === 'refunds');
  assert.match(noTotal.reason, /did not say how many/);
  const dup = NOVsrc({ refunds: refundList([...F.refunds.rows, novRefund]) }).adjustments.find((x) => x.id === 'refunds');
  assert.match(dup.reason, /same row twice/);
});

test('F6a: zero deltas ⇒ not badged "adjusted" (Oct 7–31: every delta is 0)', () => {
  const m = M.moneyTruth({ range: { from: '2026-10-07', to: '2026-10-31' }, kpi: { current: F.kpiNov.previous, previous: null }, ...src({ compare: false }) });
  assert.equal(m.figures.netProfit.value, mtNet(F.kpiNov.previous));
  assert.equal(m.figures.netProfit.adjusted, false);
  assert.equal(m.figures.netMargin.adjusted, false);
});
function mtNet(k) { return k.net_profit; }

test('F6b: a big gap in the backend identity is "unexplained", not "rounding"', () => {
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, net_profit: F.kpiOct.current.net_profit - 50 } };
  const m = M.moneyTruth({ range: OCT, kpi, ...src() });
  assert.ok(m.figures.netProfit.inputs.some((i) => /UNEXPLAINED/.test(i.label) && i.amount === -50));
  assert.ok(m.warnings.some((w) => /unexplained/.test(w)));
});

test('F6c: chargebacks are labelled as chargebacks', () => {
  const cb = { ...novRefund, id: 'cb1', type: 'chargeback', order_number: '2026110601' };
  const rows = F.refunds.rows.map((r) => (r === novRefund ? cb : r));
  const inp = NOVsrc({ refunds: refundList(rows) }).figures.revenueInclGst.inputs;
  assert.ok(inp.some((i) => /Refunds and chargebacks \(1 chargeback\)/.test(i.label)));
});

test('F6d: two live sales records for one invoice refuse §1; a void invoice is named as voided', () => {
  const twin = { ...F.shadows.find((x) => x.order_number === 'INV-3290'), id: 'twin' };
  const a = oct({ shadows: { rows: [...F.shadows, twin], total: F.shadows.length + 1 } }).adjustments[0];
  assert.match(a.reason, /INV-3290 has two live sales records/);
  const invoices = F.invoices.rows.map((i) => (i.invoice_number === 3290 ? { ...i, status: 'void' } : i));
  const inp = oct({ invoices: { rows: invoices, total: invoices.length } }).figures.revenueInclGst.inputs;
  assert.ok(inp.some((i) => /voided: INV-3290/.test(i.label) && !/moved out: [^—]*INV-3290/.test(i.label)));
});

test('F6e: only net missing ⇒ the note says net, not gross', () => {
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, net_profit: null } };
  assert.match(M.moneyTruth({ range: OCT, kpi, ...src() }).figures.netProfit.note, /did not return net profit/);
});

test('F7: a processed refund with no refund date refuses (never dated by created_at)', () => {
  const rows = F.refunds.rows.map((r) => (r === novRefund ? { ...r, refunded_at: null } : r));
  const a = NOVsrc({ refunds: refundList(rows) }).adjustments.find((x) => x.id === 'refunds');
  assert.match(a.reason, /2026110601 is processed but has no refund date/);
});

test('mutation guards the chief found uncaught: cancelled shadow, void invoice, freight in invoice gross', () => {
  // A cancelled shadow is not counted by the backend: keeping it would break reconciliation.
  const cancelled = F.shadows.find((x) => x.status === 'cancelled');
  assert.ok(cancelled, 'fixture holds the cancelled INV-3264 record');
  // A void invoice issued in range must not be counted as revenue.
  const invoices = F.invoices.rows.map((i) => (i.invoice_number === 3290 ? { ...i, status: 'void' } : i));
  assert.equal(oct({ invoices: { rows: invoices, total: invoices.length } }).figures.revenueInclGst.value, mtRound(5877.15 - 46.99));
  // INV-3290 carries a $7 freight line: moving it must move 46.99 × 20/23 − 23.00 = 17.86, not profit_excl_gst 11.77.
  const shadows = F.shadows.map((x) => (x.order_number === 'INV-3290' ? { ...x, created_at: '2026-09-20T00:00:00Z' } : x));
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, invoice_revenue: mtRound(1270.26 - 46.99), invoice_orders: 7, revenue: mtRound(6073.14 - 46.99), gross_profit: mtRound(1443.94 - 17.86) } };
  const f = M.moneyTruth({ range: OCT, kpi, ...src({ shadows: { rows: shadows, total: shadows.length } }) }).figures;
  assert.equal(f.grossProfit.value, 1413.31, 'moving INV-3290 back in restores exactly 17.86');
});
function mtRound(n) { return Math.round(n * 100) / 100; }

test('§1 reconciliation needs the COUNT too, not only the amount', () => {
  const kpi = { ...F.kpiOct, current: { ...F.kpiOct.current, invoice_orders: 9 } };
  const a = M.moneyTruth({ range: OCT, kpi, ...src() }).adjustments[0];
  assert.equal(a.applied, false);
  assert.match(a.reason, /from 8 records vs 1270\.26 from 9/);
});

test('§1 ignores a CANCELLED sales record (the backend does not count it)', () => {
  // INV-3264's cancelled record, moved into October: it must not join the backend's set.
  const shadows = F.shadows.map((x) => (x.status === 'cancelled' ? { ...x, created_at: '2026-10-10T00:00:00Z' } : x));
  const m = oct({ shadows: { rows: shadows, total: shadows.length } });
  assert.equal(m.adjustments[0].applied, true);
  assert.equal(m.figures.revenueInclGst.value, 5877.15);
});
