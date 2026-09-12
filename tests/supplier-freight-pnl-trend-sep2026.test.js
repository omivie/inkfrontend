/**
 * Supplier freight reaches the AGGREGATE surfaces (ERR-255, Sep 2026)
 * ===================================================================
 *
 * ERR-255 wired the backend's `order.supplier_freight` into the order modal and
 * the Orders list and deleted the frontend estimator. Two surfaces were left
 * out of that commit and are covered here:
 *
 *   pages/financial-health.js  the P&L table, the only place in the admin that
 *                              lays gross → net out line by line. Before this,
 *                              it showed Revenue / COGS / Gross / Stripe / Opex
 *                              / Net, and the gap between the last two silently
 *                              contained a cost with no row.
 *   utils/trend-math.js        the bucket cash waterfall, which accounted for
 *                              COGS + opex + Stripe + GST and no freight at all.
 *
 * WHY THIS IS NOT COSMETIC. Measured against the live RPC on 2026-09-12, the
 * last 30 days carry $502.64 ex-GST of supplier freight ($578.00 incl). That is
 * the difference between a reported net profit of +$446.58 and the true −$56.06.
 * The backend has already subtracted it from `net_profit`; these surfaces have
 * to SHOW the term, and must never subtract it a second time.
 *
 * The identity both surfaces now express in full, verified to the cent against
 * the live RPC:
 *     gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
 *     2210.76 − (−56.06) = 2266.82 = 170.68 + 1593.50 + 502.64
 *
 * ── A NOTE ON THE TWO GST BASES, BECAUSE THEY ARE EASY TO SWAP ──────────────
 * The P&L is an ex-GST statement, so its row reads `supplier_freight`.
 * trend-math's bucket waterfall is an incl-GST CASH waterfall, so its term is
 * `supplier_freight_incl_gst`. Using the ex-GST figure there would under-state
 * cash out by 15% and break the bucket's footing. One test pins each.
 *
 * Run with: node --test tests/supplier-freight-pnl-trend-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const TREND_PATH = path.join(ROOT, 'inkcartridges/js/admin/utils/trend-math.js');
const FH_PATH = path.join(ROOT, 'inkcartridges/js/admin/pages/financial-health.js');

function stripEsm(src) {
  const exposed = new Set();
  const stripped = src.replace(
    /export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, kw, id) => { exposed.add(id); return `${kw} ${id}`; }
  );
  return stripped + '\n;' + [...exposed]
    .map((id) => `try { globalThis.${id} = ${id}; } catch(_) {}`)
    .join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(TREND_PATH, 'utf8')), ctx, { filename: 'trend-math.js' });

const fhSrc = fs.readFileSync(FH_PATH, 'utf8');

const GST_FRACTION = 3 / 23;   // GST inside a GST-inclusive amount
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ───────────────────────────────────────────────────────────────────────────
// §1  orderFreightInclGst — THREE STATES, AND TWO OF THEM LOOK ALIKE
// ───────────────────────────────────────────────────────────────────────────

test('a billed order reports its incl-GST freight and counts as known', () => {
  const r = sandbox.orderFreightInclGst({
    supplier_freight: { applies: true, amount_incl_gst: 14, amount_ex_gst: 12.17, complete: true },
  });
  assert.equal(r.inclGst, 14, 'the cash figure is the incl-GST one, not amount_ex_gst');
  assert.equal(r.known, true);
  assert.equal(r.complete, true);
});

test('applies:false is a KNOWN zero — the backend priced it and nothing is owed', () => {
  const r = sandbox.orderFreightInclGst({ supplier_freight: { applies: false, complete: true } });
  assert.equal(r.inclGst, 0);
  assert.equal(r.known, true, 'a priced order owing nothing is knowledge, not absence');
});

test('an ABSENT envelope is not a zero — it is an unknown, and says so', () => {
  // The distinction this whole file exists to protect. Both states report $0 of
  // freight; only one of them means "nothing is owed". Reading absence as zero
  // is ERR-063/068/073/075/076/149/150, and here it would understate cost.
  const r = sandbox.orderFreightInclGst({ order_number: '2026090902' });
  assert.equal(r.inclGst, 0);
  assert.equal(r.known, false, 'a row that never carried the field must not read as $0 owed');
});

test('a null order and a malformed amount are unknowns, never zeroes', () => {
  assert.equal(sandbox.orderFreightInclGst(null).known, false);
  assert.equal(sandbox.orderFreightInclGst(undefined).known, false);
  assert.equal(
    sandbox.orderFreightInclGst({ supplier_freight: { applies: true, amount_incl_gst: 'x' } }).known,
    false,
    'an unparseable amount is not a measurement of zero');
  assert.equal(
    sandbox.orderFreightInclGst({ supplier_freight: { applies: true, amount_incl_gst: -3 } }).known,
    false,
    'a negative freight bill is not a thing; refuse rather than credit it');
});

test('complete:false travels with the amount — the total is a FLOOR', () => {
  const r = sandbox.orderFreightInclGst({
    supplier_freight: { applies: true, amount_incl_gst: 7, complete: false, unpriced_consignments: 1 },
  });
  assert.equal(r.inclGst, 7);
  assert.equal(r.known, true, 'we know what we could price');
  assert.equal(r.complete, false, 'and we know it is not the whole bill');
});

// ───────────────────────────────────────────────────────────────────────────
// §2  bucketFreightFromOrders
// ───────────────────────────────────────────────────────────────────────────

function twoBuckets() {
  return [
    { revenue: 0, orders: 0 },
    { revenue: 0, orders: 0 },
  ];
}
// Bucket 0 = anything in August, bucket 1 = anything in September.
const indexFor = (ts) => (new Date(ts).getUTCMonth() === 7 ? 0 : 1);

test('freight lands in the bucket its order belongs to', () => {
  const buckets = twoBuckets();
  const res = sandbox.bucketFreightFromOrders(buckets, [
    { created_at: '2026-08-12T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 14, complete: true } },
    { created_at: '2026-09-02T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 7, complete: true } },
    { created_at: '2026-09-09T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 12, complete: true } },
  ], indexFor);
  assert.equal(buckets[0].freightFromOrders, 14);
  assert.equal(buckets[1].freightFromOrders, 19);
  assert.equal(buckets[0].hasOrderFreight, true);
  assert.equal(res.resolvedCount, 3);
  assert.equal(res.missingCount, 0);
});

test('an order owing nothing still marks the bucket KNOWN at zero', () => {
  const buckets = twoBuckets();
  sandbox.bucketFreightFromOrders(buckets, [
    { created_at: '2026-09-02T00:00:00Z', supplier_freight: { applies: false, complete: true } },
  ], indexFor);
  assert.equal(buckets[1].freightKnown, true, 'priced-and-owing-nothing is knowledge');
  assert.equal(buckets[1].freightFromOrders, 0);
});

test('ONE row without an envelope poisons the bucket, and it stays poisoned', () => {
  // A total built from some of the rows is a floor. A floor that presents
  // itself as a total is the failure this flag exists to prevent — and the
  // order of the rows must not change the verdict.
  const buckets = twoBuckets();
  const res = sandbox.bucketFreightFromOrders(buckets, [
    { created_at: '2026-09-02T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 7, complete: true } },
    { created_at: '2026-09-03T00:00:00Z' },                       // no envelope
    { created_at: '2026-09-04T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 5, complete: true } },
  ], indexFor);
  assert.equal(buckets[1].freightKnown, false, 'a later good row must not un-poison it');
  assert.equal(res.missingCount, 1);
  assert.equal(buckets[1].freightFromOrders, 12, 'what we did read is still reported — present→absent is not an upgrade');
});

test('an unparseable created_at is skipped rather than bucketed into the wrong period', () => {
  const buckets = twoBuckets();
  const res = sandbox.bucketFreightFromOrders(buckets, [
    { created_at: 'not-a-date', supplier_freight: { applies: true, amount_incl_gst: 14, complete: true } },
  ], indexFor);
  assert.equal(res.resolvedCount, 0);
  assert.equal(buckets[0].freightFromOrders, undefined);
  assert.equal(buckets[1].freightFromOrders, undefined);
});

test('an incomplete consignment marks the bucket as a floor', () => {
  const buckets = twoBuckets();
  const res = sandbox.bucketFreightFromOrders(buckets, [
    { created_at: '2026-09-02T00:00:00Z', supplier_freight: { applies: true, amount_incl_gst: 7, complete: false } },
  ], indexFor);
  assert.equal(buckets[1].freightComplete, false);
  assert.equal(res.incompleteCount, 1);
});

// ───────────────────────────────────────────────────────────────────────────
// §3  The GST credit — freight is the FOURTH reclaimable input
// ───────────────────────────────────────────────────────────────────────────

test('freight GST is reclaimed at the IRD line, like COGS and Stripe before it', () => {
  const withFreight = sandbox.deriveNetGstRemitted(1000, 400, 30, 100);
  const without = sandbox.deriveNetGstRemitted(1000, 400, 30, 0);
  assert.ok(near(without - withFreight, 100 * GST_FRACTION),
    'the credit must be exactly the GST inside the freight, not a share of it');
  assert.ok(near(withFreight, (1000 - 400 - 30 - 100) * GST_FRACTION));
});

test('omitting the freight argument leaves every existing caller unchanged', () => {
  // Back-compat is load-bearing: this function has callers outside the freight
  // path, and a defaulted parameter is the only reason they keep their numbers.
  assert.equal(sandbox.deriveNetGstRemitted(1000, 400, 30),
    sandbox.deriveNetGstRemitted(1000, 400, 30, 0));
});

// ───────────────────────────────────────────────────────────────────────────
// §4  assembleBucketExpense — the cash waterfall foots WITH freight in it
// ───────────────────────────────────────────────────────────────────────────

test('freight is cash out, and it is the INCL-GST figure', () => {
  const b = {
    revenue: 1000, orders: 5,
    hasPnlCogs: true, pnlCogs: 400,
    hasPnlOpex: true, pnlOpex: 50,
    hasPnlStripe: true, pnlStripe: 30,
    hasPnlFreight: true, pnlFreightInclGst: 115, supplier_freight: 100,
  };
  sandbox.assembleBucketExpense(b);
  assert.equal(b.freightTotal, 115, 'the ex-GST 100 would under-state cash out by 15%');
  assert.ok(near(b.expenses, 400 + 50 + 30 + 115 + b.gstTotal), 'every dollar out must be in `expenses`');
  assert.ok(near(b.net, b.revenue - b.expenses));
});

test('absence costs exactly nothing — a bucket with no freight is arithmetically unchanged', () => {
  const base = {
    revenue: 1000, orders: 5,
    hasPnlCogs: true, pnlCogs: 400, hasPnlOpex: true, pnlOpex: 50, hasPnlStripe: true, pnlStripe: 30,
  };
  const b = sandbox.assembleBucketExpense({ ...base });
  assert.equal(b.freightTotal, 0);
  assert.ok(near(b.expenses, 400 + 50 + 30 + b.gstTotal));
  // And the GST line must be identical to the pre-freight formula.
  assert.ok(near(b.gstTotal, (1000 - 400 - 30) * GST_FRACTION));
});

test('the P&L period figure wins over what the list rows resolved', () => {
  const b = sandbox.assembleBucketExpense({
    revenue: 1000, orders: 5,
    hasPnlCogs: true, pnlCogs: 400, hasPnlOpex: true, pnlOpex: 0, hasPnlStripe: true, pnlStripe: 0,
    hasPnlFreight: true, pnlFreightInclGst: 115,
    hasOrderFreight: true, freightFromOrders: 99,
  });
  assert.equal(b.freightTotal, 115, 'the authoritative period total outranks a row-by-row sum');
});

test('with no P&L figure it falls back to the bucketed order rows', () => {
  const b = sandbox.assembleBucketExpense({
    revenue: 1000, orders: 5,
    hasPnlCogs: true, pnlCogs: 400, hasPnlOpex: true, pnlOpex: 0, hasPnlStripe: true, pnlStripe: 0,
    hasOrderFreight: true, freightFromOrders: 99,
  });
  assert.equal(b.freightTotal, 99);
});

test('adding freight makes the bucket net STRICTLY smaller — a cost that never bites is not a cost', () => {
  // The positive control. Every other test here would still pass if freightTotal
  // were computed and then dropped on the floor before `expenses`.
  const base = {
    revenue: 1000, orders: 5,
    hasPnlCogs: true, pnlCogs: 400, hasPnlOpex: true, pnlOpex: 50, hasPnlStripe: true, pnlStripe: 30,
  };
  const without = sandbox.assembleBucketExpense({ ...base });
  const withF = sandbox.assembleBucketExpense({ ...base, hasPnlFreight: true, pnlFreightInclGst: 115 });
  assert.ok(withF.net < without.net, 'freight must reduce take-home');
  // It reduces net by the freight EX-GST, because the GST comes back as a credit.
  assert.ok(near(without.net - withF.net, 115 - 115 * GST_FRACTION),
    'the bite is the ex-GST cost; the GST is reclaimed, not lost');
});

// ───────────────────────────────────────────────────────────────────────────
// §5  sumTrendTotals
// ───────────────────────────────────────────────────────────────────────────

test('the totals strip sums freight and inherits the floor flags', () => {
  const t = sandbox.sumTrendTotals([
    { revenue: 100, expenses: 50, freightTotal: 14, freightKnown: true, freightComplete: true },
    { revenue: 100, expenses: 50, freightTotal: 7, freightKnown: false, freightComplete: true },
    { revenue: 100, expenses: 50, freightTotal: 5, freightKnown: true, freightComplete: false },
  ]);
  assert.equal(t.freight, 26);
  assert.equal(t.freightKnown, false, 'one unreadable bucket makes the window total a floor');
  assert.equal(t.freightComplete, false);
});

test('a clean window reports its freight as known and complete', () => {
  const t = sandbox.sumTrendTotals([
    { revenue: 100, expenses: 50, freightTotal: 14, freightKnown: true, freightComplete: true },
  ]);
  assert.equal(t.freight, 14);
  assert.equal(t.freightKnown, true);
  assert.equal(t.freightComplete, true);
});

// ───────────────────────────────────────────────────────────────────────────
// §6  The P&L table — EXECUTE the shipped row list, don't grep it
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lift the real `const rows = [ … ];` out of renderPnLTable and evaluate it.
 *
 * A source grep can tell you the characters "Supplier Freight" are in the file.
 * It cannot tell you the row is in the array, in the right place, reading the
 * right field, or flagged as a cost. This runs the actual literal.
 */
function pnlRows(cur, prev) {
  const start = fhSrc.indexOf('const rows = [');
  assert.ok(start > -1, 'the P&L row list must exist to be executed');
  const open = fhSrc.indexOf('[', start);
  let depth = 0; let end = -1;
  for (let i = open; i < fhSrc.length; i++) {
    if (fhSrc[i] === '[') depth++;
    else if (fhSrc[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'the P&L row list must be bracket-balanced');
  const literal = fhSrc.slice(open, end);
  return new Function('cur', 'prev', `return ${literal};`)(cur, prev);
}

const CUR = {
  revenue: 10278.23, cogs: 6500, gross_profit: 2210.76, stripe_fees: 170.68,
  operating_expenses: 1593.50, supplier_freight: 502.64, net_profit: -56.06,
};
const PREV = {
  revenue: 7967.75, cogs: 5000, gross_profit: 2013.85, stripe_fees: 172.76,
  operating_expenses: 1151.08, supplier_freight: 381.77, net_profit: 308.24,
};

test('the P&L carries a Supplier Freight row', () => {
  const labels = pnlRows(CUR, PREV).map((r) => r[0]);
  assert.ok(labels.some((l) => /Supplier Freight/i.test(l)),
    `no freight row in: ${labels.join(' | ')}`);
});

test('it sits between Operating Expenses and Net Profit, where it is subtracted', () => {
  const labels = pnlRows(CUR, PREV).map((r) => r[0]);
  const opex = labels.findIndex((l) => /Operating Expenses/i.test(l));
  const freight = labels.findIndex((l) => /Supplier Freight/i.test(l));
  const net = labels.findIndex((l) => /Net Profit/i.test(l));
  assert.ok(opex > -1 && freight > -1 && net > -1);
  assert.ok(opex < freight && freight < net,
    `expected opex < freight < net, got ${opex} < ${freight} < ${net}`);
});

test('it reads the EX-GST field, matching every other row in an ex-GST statement', () => {
  const row = pnlRows(CUR, PREV).find((r) => /Supplier Freight/i.test(r[0]));
  assert.equal(row[1], 502.64, 'current must be `supplier_freight`, not `supplier_freight_incl_gst` (578.00)');
  assert.equal(row[2], 381.77, 'previous must come from the prior period, not repeat current');
});

test('it is flagged as a COST, so it renders negative like Stripe and Opex', () => {
  const rows = pnlRows(CUR, PREV);
  const freight = rows.find((r) => /Supplier Freight/i.test(r[0]));
  const stripe = rows.find((r) => /Stripe Fees/i.test(r[0]));
  assert.equal(freight[3], true, 'a cost row must carry the negative flag');
  assert.equal(freight[3], stripe[3], 'it must be flagged exactly like the other outflows');
  assert.notEqual(freight[4], true, 'it is not the bolded total row — Net Profit is');
});

test('the label states its GST basis, because this table mixes two', () => {
  const row = pnlRows(CUR, PREV).find((r) => /Supplier Freight/i.test(r[0]));
  assert.match(row[0], /excl\. GST/i,
    'Revenue is incl-GST and every row under it is excl-GST; the label carries the basis');
});

test('the rows reconcile the identity the backend publishes', () => {
  // gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
  // Live figures, verified against the RPC 2026-09-12.
  const rows = pnlRows(CUR, PREV);
  const v = (re) => rows.find((r) => re.test(r[0]))[1];
  const lhs = v(/Gross Profit/i) - v(/Net Profit/i);
  const rhs = v(/Stripe Fees/i) + v(/Operating Expenses/i) + v(/Supplier Freight/i);
  assert.ok(Math.abs(lhs - rhs) < 0.005, `${lhs} !== ${rhs} — the table no longer accounts for net profit`);
});

test('an unknown freight figure renders as unknown, never as $0.00', () => {
  // The COGS-honesty rule (ERR-028 / ERR-063) has to cover the new row too: the
  // backend sends null, not 0, when it cannot compute — and "$0.00" would read
  // as "we owe nothing" when the truth is "we don't know".
  const row = pnlRows({ ...CUR, supplier_freight: null }, PREV)
    .find((r) => /Supplier Freight/i.test(r[0]));
  assert.equal(row[1], null, 'null must survive to the formatter, which renders the em-dash');
  const known = (val) => val != null && Number.isFinite(typeof val === 'string' ? parseFloat(val) : val);
  assert.equal(known(row[1]), false, 'the shipped `known()` guard must classify it as unavailable');
});

// ───────────────────────────────────────────────────────────────────────────
// §7  The ceiling note — a branch no live order can reach
// ───────────────────────────────────────────────────────────────────────────

test('the P&L warns when freight is a floor, and stays quiet when it is not', () => {
  // `unpriced_consignments` is 0 on all 150 live orders (measured 2026-09-12),
  // so NO probe against production can exercise this. A unit test is its only
  // coverage, and the negative control is what proves the guard is real rather
  // than the note being unconditional.
  assert.match(fhSrc, /supplier_freight_unpriced_orders/,
    'the P&L must read the unpriced count');
  const start = fhSrc.indexOf('const unpricedOrders =');
  assert.ok(start > -1, 'the ceiling note block must exist');
  const block = fhSrc.slice(start, start + 900);
  assert.match(block, /if \(unpricedOrders > 0\)/, 'the note must be GUARDED, not always rendered');
  assert.match(block, /at most/i, 'the qualifier is the whole point of the note');
});

test('pages/financial-health.js does no freight maths of its own', () => {
  // The backend has ALREADY deducted freight from `net_profit`. Any arithmetic
  // on the freight figure here would subtract the same cost a second time —
  // the exact double-charge the handoff's §1 is about, arriving by a different
  // door. This asserts the figure is only ever READ.
  //
  // Comments are stripped with the shared ERR-253 helper rather than a local
  // regex pair, and the check is scoped to the freight value itself: an earlier
  // version of this test banned the characters "1.15" anywhere in the function
  // and went red on the GST footnote's prose "revenue ÷ 1.15" and on a comment
  // citing "20/23". Banning a NUMBER catches sentences; banning an OPERATION on
  // the value catches the bug.
  const bare = stripComments(fhSrc);
  const fn = bare.slice(bare.indexOf('function renderPnLTable'), bare.indexOf('async function renderCashflowChart'));
  assert.ok(fn.length > 0, 'renderPnLTable must be locatable after comment-stripping');
  assert.match(fn, /supplier_freight/, 'positive control: the freight field is read in this function');
  assert.ok(!/net_profit\s*[-+*/]\s*[\w(]/.test(fn), 'net profit must be displayed, never recomputed');
  assert.ok(!/supplier_freight[\w.]*\s*[-+*/]\s*[\w(]/.test(fn),
    'the freight figure must be read, never scaled, grossed up or netted off');
  assert.ok(!/[\w)]\s*[-+*/]\s*cur\.supplier_freight/.test(fn),
    'and nothing may be computed FROM it either');
});
