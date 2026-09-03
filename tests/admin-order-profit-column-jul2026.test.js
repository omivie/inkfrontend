/**
 * Orders list — Profit column (Jul 2026)
 * ======================================
 *
 * The Orders table gained a Profit column so an owner can see which sales made
 * money without opening each one. Two things make it fragile, and this file pins
 * both.
 *
 * 1. THE LIST ENDPOINT HAS NO COSTS. `supplier_cost_snapshot` and
 *    `shipping_absorbed` exist only on GET /api/admin/orders/:id (ERR-039), so
 *    the column is filled by a per-row detail fan-out after the table paints.
 *    That fan-out must be abortable, cached, owner-gated, and must never block
 *    first paint (ERR-121).
 *
 * 2. AN ORDER CAN FAIL TO HAVE A PROFIT IN FOUR DIFFERENT WAYS, and none of them
 *    is $0. Cancelled, no items, no recorded cost, and lookup-failed are
 *    distinct facts. Collapsing any of them into a number is the ERR-028 /
 *    ERR-068 / ERR-074 family of bugs — the same class that shipped a green
 *    "Profit +$1,396.97" next to "COGS $0.00".
 *
 * ERR-122 lives here too: the order modal's items foot used to do
 * `totalCost += (item.supplier_cost_snapshot ?? 0) * qty` and then print a
 * confident bold profit, so one un-costed line over-stated the order's profit.
 * §"modal foot" below pins the fix.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const PROFITABILITY = path.join(ADMIN, 'utils', 'profitability.js');
const ORDER_PROFIT = path.join(ADMIN, 'utils', 'order-profit.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');
const ADMIN_CSS = path.resolve(__dirname, '..', 'inkcartridges', 'css', 'admin.css');

const ordersSrc = fs.readFileSync(ORDERS_PAGE, 'utf8');
const cssSrc = fs.readFileSync(ADMIN_CSS, 'utf8');

// Same loader the other admin-util tests use: strip the ESM keywords, hoist the
// exports onto the sandbox global, and run the dependency first so order-profit's
// `import` targets are already present as globals.
function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
  stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
  stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  return stripped + '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(PROFITABILITY, 'utf8')), ctx, { filename: 'profitability.js' });
vm.runInContext(stripEsm(fs.readFileSync(ORDER_PROFIT, 'utf8')), ctx, { filename: 'order-profit.js' });

const { orderProfitFromDetail, isInvoiceOrder, PROFIT_STATE, computeProfitBreakdown } = sandbox;

// A plain website order: 2 × $20 + 1 × $10 ex-GST = $50 revenue, $20 cost,
// $57.50 charged to the card.
const fullyCosted = () => ({
  id: 'ord-1',
  order_number: '20260728000001',
  status: 'paid',
  payment_method: 'stripe',
  total_amount: 57.50,
  items: [
    { sku: 'A1', sell_price: 20, qty: 2, supplier_cost_snapshot: 8 },
    { sku: 'B2', sell_price: 10, qty: 1, supplier_cost_snapshot: 4 },
  ],
});

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

// ─── State classification ───────────────────────────────────────────────────

test('cancelled order is CANCELLED with a null profit, even when fully costed', () => {
  const r = orderProfitFromDetail({ ...fullyCosted(), status: 'cancelled' });
  assert.equal(r.state, PROFIT_STATE.CANCELLED);
  assert.equal(r.netProfit, null, 'a cancelled order earned nothing — that is null, not 0');
  assert.equal(r.netMarginPct, null);
});

test('cancelled is resolvable from a LIST row alone (no items) — so it costs no fetch', () => {
  const r = orderProfitFromDetail({ id: 'x', status: 'cancelled', total_amount: 50.90 });
  assert.equal(r.state, PROFIT_STATE.CANCELLED);
});

test('an order with items but no line costs is UNKNOWN — netProfit is null, NOT a number', () => {
  const o = fullyCosted();
  o.items[1].supplier_cost_snapshot = null;
  const r = orderProfitFromDetail(o);
  assert.equal(r.state, PROFIT_STATE.UNKNOWN);
  assert.equal(r.missingCostCount, 1);
  assert.equal(r.itemCount, 2);
  // The ERR-122 regression: a partial profit here would be an OVER-statement,
  // because the missing cost would silently count as $0.
  assert.equal(r.netProfit, null);
  assert.equal(typeof r.netProfit, 'object', 'must not be a Number');
  assert.equal(r.totalCostExGst, null, 'a partial cost total is not a cost total');
  assert.equal(r.breakdown, null, 'no waterfall may be built on an unknown cost');
});

test('per-line profits survive the UNKNOWN state — only the SUM is unknowable', () => {
  const o = fullyCosted();
  o.items[1].supplier_cost_snapshot = null;
  const r = orderProfitFromDetail(o);
  assert.equal(r.lineProfits.length, 2);
  assert.ok(Number.isFinite(r.lineProfits[0]), 'the costed line still has a real profit');
  assert.equal(r.lineProfits[1], null, 'the un-costed line does not');
});

test('a genuine $0 cost is a RECORDED cost, not an unknown', () => {
  const o = fullyCosted();
  o.items[0].supplier_cost_snapshot = 0;
  o.items[1].supplier_cost_snapshot = 0;
  const r = orderProfitFromDetail(o);
  assert.equal(r.state, PROFIT_STATE.OK, 'only null/undefined means nobody wrote a cost down');
  assert.equal(r.missingCostCount, 0);
  assert.ok(r.netProfit > 45, 'zero cost means near-full margin, and that is the truth');
});

test('an order with no line items is NO_ITEMS, not UNKNOWN and not OK', () => {
  const r = orderProfitFromDetail({ id: 'x', status: 'paid', total_amount: 15.95, items: [] });
  assert.equal(r.state, PROFIT_STATE.NO_ITEMS);
  assert.equal(r.netProfit, null);
});

test('a null/garbage order is FAILED — "we could not ask" is its own state', () => {
  assert.equal(orderProfitFromDetail(null).state, PROFIT_STATE.FAILED);
  assert.equal(orderProfitFromDetail(undefined).netProfit, null);
});

// ─── The money ──────────────────────────────────────────────────────────────

test('a fully-costed website order matches computeProfitBreakdown exactly', () => {
  const r = orderProfitFromDetail(fullyCosted());
  assert.equal(r.state, PROFIT_STATE.OK);
  const expected = computeProfitBreakdown(50, 20, { customerPaidInclGst: 57.50 });
  near(r.netProfit, expected.netProfit);
  near(r.netMarginPct, expected.netMarginPct);
  // 50 − 20 − (57.50 × 2.65% + 0.30)
  near(r.netProfit, 50 - 20 - (57.50 * 0.0265 + 0.30));
});

test('the per-line profits sum to the order profit (ERR-118 footing invariant)', () => {
  const r = orderProfitFromDetail(fullyCosted());
  const sum = r.lineProfits.reduce((a, b) => a + b, 0);
  near(sum, r.netProfit, 1e-9);
});

test('an invoiced sale pays no card fee, so it nets strictly more than the same card sale', () => {
  const card = orderProfitFromDetail(fullyCosted());
  const inv = orderProfitFromDetail({ ...fullyCosted(), payment_method: 'invoice', order_number: 'INV-3300' });
  assert.equal(inv.isInvoice, true);
  assert.equal(card.isInvoice, false);
  near(inv.netProfit, 30, 1e-9);                 // 50 − 20, no processor at all
  assert.ok(inv.netProfit > card.netProfit);
});

test('isInvoiceOrder honours channel > payment_method > INV- prefix', () => {
  assert.equal(isInvoiceOrder({ channel: 'invoice' }), true);
  assert.equal(isInvoiceOrder({ channel: 'website', payment_method: 'invoice' }), false, 'channel wins');
  assert.equal(isInvoiceOrder({ payment_method: 'invoice' }), true);
  assert.equal(isInvoiceOrder({ order_number: 'inv-3264' }), true);
  assert.equal(isInvoiceOrder({ order_number: '20260728000001', payment_method: 'stripe' }), false);
});

test('absorbed courier on a free-shipping order reduces take-home by its ex-GST cost', () => {
  const base = orderProfitFromDetail(fullyCosted());
  const absorbed = orderProfitFromDetail({
    ...fullyCosted(),
    shipping_absorbed: { applies: true, amount_incl_gst: 12, zone: 'north-island' },
  });
  assert.equal(absorbed.absorbedApplies, true);
  const exGst = 12 - (12 * 0.15 / 1.15);         // GST inside a GST-inclusive amount
  near(absorbed.netProfit, base.netProfit - exGst, 1e-9);
});

test('shipping_absorbed with applies:false costs nothing (LOUD-by-absence)', () => {
  const r = orderProfitFromDetail({
    ...fullyCosted(),
    shipping_absorbed: { applies: false, amount_incl_gst: 12 },
  });
  assert.equal(r.absorbedApplies, false);
  near(r.netProfit, orderProfitFromDetail(fullyCosted()).netProfit);
});

test('the fee-base override (modal breakdown) is used when present', () => {
  const withOverride = orderProfitFromDetail(fullyCosted(), { customerPaidInclGst: 100 });
  const withoutOverride = orderProfitFromDetail(fullyCosted());
  assert.ok(withOverride.netProfit < withoutOverride.netProfit, 'a bigger charge means a bigger card fee');
  near(withOverride.netProfit, 50 - 20 - (100 * 0.0265 + 0.30));
});

// ─── The column wiring (source contract) ────────────────────────────────────

test('the Profit column exists and is NOT sortable', () => {
  assert.match(ordersSrc, /key:\s*'_profit',\s*label:\s*'Profit'/, 'column must be declared');
  const col = ordersSrc.slice(ordersSrc.indexOf("key: '_profit'"), ordersSrc.indexOf("key: '_actions'"));
  assert.ok(!/sortable:\s*true/.test(col),
    'the backend sort enum has no profit option and would silently fall back to newest');
});

test('the Profit column is owner-gated at the DataTable, so non-owners never fan out', () => {
  // The gate is a NAMED SET now (ERR-203): Profit was joined by Supplier and
  // Supplier cost, all fed by the same fan-out, and an inline `!== '_profit'`
  // is how the third one would have shipped ungated to every admin.
  assert.match(ordersSrc, /AdminAuth\.isOwner\(\)\s*\?\s*COLUMNS\s*:\s*COLUMNS\.filter\(c => !OWNER_ONLY_COLUMNS\.has\(c\.key\)\)/);
  assert.match(ordersSrc, /const OWNER_ONLY_COLUMNS = new Set\(\[[^\]]*'_profit'[^\]]*\]\)/,
    'the Profit column must still be in the owner-only set');
  const hydrate = ordersSrc.slice(ordersSrc.indexOf('async function hydrateRowDetail'), ordersSrc.indexOf('function orderLabel'));
  assert.ok(/!AdminAuth\.isOwner\(\)/.test(hydrate) && /return;/.test(hydrate),
    'hydrateRowDetail must bail for non-owners');
});

test('profit hydration runs AFTER setData and is never awaited (first paint, ERR-121)', () => {
  const load = ordersSrc.slice(ordersSrc.indexOf('async function loadOrders'), ordersSrc.indexOf('// ---- Bulk bar ----'));
  const setDataAt = load.indexOf('_table.setData(rows, pagination)');
  const hydrateAt = load.indexOf('hydrateRowDetail(rows)');
  assert.ok(setDataAt > -1 && hydrateAt > setDataAt, 'the table must paint before costs are fetched');
  assert.ok(!/await hydrateRowDetail/.test(load), 'awaiting it would re-gate first paint behind ~20 round-trips');
});

test('the detail fan-out is batched and abortable', () => {
  assert.match(ordersSrc, /const PROFIT_BATCH = \d+/);
  assert.match(ordersSrc, /new AbortController\(\)/);
  assert.match(ordersSrc, /AdminAPI\.getOrder\(r\.id, ctrl\.signal\)/, 'the signal must reach the request');
  assert.match(ordersSrc, /ctrl\.signal\.aborted/, 'and be checked between batches');
});

test('destroyOrdersTab aborts in-flight fetches and clears the cache', () => {
  const destroy = ordersSrc.slice(ordersSrc.indexOf('function destroyOrdersTab'), ordersSrc.indexOf('// ---- Tab switching ----'));
  assert.match(destroy, /_profitAbort\?\.abort\(\)/);
  assert.match(destroy, /_profitCache\.clear\(\)/);
  // The same fetch fills the sourcing cache; clearing one and not the other
  // would leave a previous page's suppliers on screen after the next paint.
  assert.match(destroy, /_sourcingCache\.clear\(\)/);
});

test('the cache is invalidated wherever an order status or existence changes', () => {
  // Two eviction helpers now: forgetRowDetail() drops everything the detail
  // fetch produced (profit AND sourcing — one fetch, one eviction, ERR-203),
  // and forgetOrderCache() drops that AND the row's delete contract (it calls
  // forgetRowDetail internally). Every call site that used to be a bare
  // forgetProfit on a status change or a delete is now the wider one, because a
  // status change flips deletability too. Count both — what the invariant cares
  // about is that no path mutates an order without dropping its cached answers.
  const evictions = (ordersSrc.match(/forget(RowDetail|OrderCache)\(/g) || []).length;
  assert.ok(evictions >= 4,
    `status update, single delete, bulk delete and the helper itself (found ${evictions})`);
  assert.match(ordersSrc, /function forgetOrderCache\(id\)[\s\S]{0,200}forgetRowDetail\(id\)/,
    'forgetOrderCache must still drop the detail caches, not just the delete contract');
  assert.match(ordersSrc, /function forgetRowDetail\(id\)[\s\S]{0,200}_sourcingCache\.delete\(id\)/,
    'and forgetRowDetail must drop BOTH caches the one fetch filled');
});

test('a failed detail call is cached as FAILED, never as a zero or an unknown', () => {
  assert.match(ordersSrc, /\{ state: PROFIT_STATE\.FAILED \}/);
  assert.match(ordersSrc, /order-profit--failed/, 'and rendered distinctly from the muted unknown state');
});

// ─── ERR-122: the modal foot must not invent a cost ─────────────────────────

test('modal foot: no `supplier_cost_snapshot ?? 0` anywhere in orders.js', () => {
  assert.ok(!/supplier_cost_snapshot\s*\?\?\s*0/.test(ordersSrc),
    'ERR-122: coercing a missing cost to $0 over-states the order profit');
  assert.ok(!/supplier_cost_snapshot\s*\|\|\s*0/.test(ordersSrc));
});

test('modal foot prints an em-dash, not a number, when a cost is missing', () => {
  assert.match(ordersSrc, /const costFoot = missingCostCount > 0/);
  assert.match(ordersSrc, /profitInfo\.netProfit != null/, 'the profit foot is gated on a real figure');
  assert.match(ordersSrc, /It is UNKNOWN, not \$0\./, 'and says so out loud');
});

test('the modal and the column derive profit from the SAME function (ERR-113)', () => {
  const calls = ordersSrc.match(/orderProfitFromDetail\(/g) || [];
  assert.ok(calls.length >= 2, 'both surfaces must call it; neither may re-implement the math');
  assert.ok(!/computeProfitBreakdown\(/.test(ordersSrc),
    'orders.js must not build a waterfall itself — that is the helper\'s job');
});

// ─── Styling ────────────────────────────────────────────────────────────────

test('the profit cell and the previously-unstyled unknown margin badge have rules', () => {
  assert.match(cssSrc, /\.margin-badge--unknown\s*\{/, 'emitted by profitability.js since day one, never styled');
  assert.match(cssSrc, /\.order-profit\s*\{/);
  assert.match(cssSrc, /\.order-profit__amt--loss\s*\{/, 'a loss must not render green');
  assert.match(cssSrc, /\.order-profit--failed\s*\{/);
});
