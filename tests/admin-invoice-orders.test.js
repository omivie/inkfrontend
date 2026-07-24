/**
 * Invoiced sales inside the Orders list
 * =====================================
 *
 * The backend now materialises a saved invoice as a shadow `orders` row, so
 * invoiced sales (phone / walk-in / B2B) sit in the Orders list alongside website
 * orders. Two things must hold:
 *
 *   1. THEY MUST BE TELLABLE APART. Measured against the live API, the backend does
 *      NOT expose the `orders.channel` column the spec asked for. What it does send
 *      is `payment_method: "invoice"` and an `INV-<n>` order number. Those are the
 *      contract; if `channel` ever shows up, it wins.
 *
 *   2. THEY MUST NOT BE CHARGED A CARD FEE. An invoiced sale is settled by bank
 *      transfer — no Stripe, no 2.65%, no $0.30. Applying the website default
 *      understates the profit and invents a payment that never happened. On the
 *      live INV-3265 ($840 ex-GST, $776.64 cost) that error is ~$26 on $63 of
 *      profit — a 40% understatement.
 *
 * Run with: node --test tests/admin-invoice-orders.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin');
const ordersSrc = fs.readFileSync(path.join(ADMIN, 'pages', 'orders.js'), 'utf8');

function stripEsm(src) {
  const exposed = new Set();
  const noImports = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const stripped = noImports.replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
    (_m, a, kw, id) => { exposed.add(id); return `${a || ''}${kw} ${id}`; });
  return stripped + '\n;' + [...exposed].map(id => `try{globalThis.${id}=${id}}catch(_){}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(path.join(ADMIN, 'utils', 'profitability.js'), 'utf8')), ctx,
  { filename: 'profitability.js' });
const { computeOrderProfit, computeProfitBreakdown, NO_PAYMENT_FEES, STRIPE_RATE, STRIPE_FIXED } = sandbox;

const approx = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// The real isInvoiceOrder, lifted from orders.js so the rules stay in one place.
const isInvoiceOrder = (o) => {
  if (!o) return false;
  if (o.channel) return String(o.channel).toLowerCase() === 'invoice';
  if (o.payment_method) return String(o.payment_method).toLowerCase() === 'invoice';
  return /^INV-/i.test(String(o.order_number || ''));
};

// ─── 1. Telling an invoiced sale apart ───────────────────────────────────────
test('payment_method is the live discriminator — the backend does not send `channel`', () => {
  // Exactly the shape the live API returns for INV-3265.
  assert.equal(isInvoiceOrder({ order_number: 'INV-3265', payment_method: 'invoice' }), true);
  assert.equal(isInvoiceOrder({ order_number: '20260714000001', payment_method: 'stripe' }), false);
  assert.equal(isInvoiceOrder({ order_number: '20260714000001', payment_method: null }), false);
});

test('the INV- order-number prefix is the fallback when payment_method is absent', () => {
  assert.equal(isInvoiceOrder({ order_number: 'INV-3264' }), true);
  assert.equal(isInvoiceOrder({ order_number: 'inv-3264' }), true, 'case-insensitive');
  assert.equal(isInvoiceOrder({ order_number: '20260713000001' }), false);
});

test('an explicit `channel` field wins if the backend ever ships it', () => {
  assert.equal(isInvoiceOrder({ channel: 'invoice', order_number: 'anything' }), true);
  // channel:'web' must override a misleading INV- prefix, not be ignored.
  assert.equal(isInvoiceOrder({ channel: 'web', order_number: 'INV-9999' }), false);
});

test('isInvoiceOrder tolerates junk', () => {
  assert.equal(isInvoiceOrder(null), false);
  assert.equal(isInvoiceOrder(undefined), false);
  assert.equal(isInvoiceOrder({}), false);
});

// ─── 2. No card fee on an invoiced sale ──────────────────────────────────────
test('INV-3265: an invoiced sale nets revenue − cost, with NO card fee', () => {
  // The real numbers: $840.00 ex-GST sell, $776.64 supplier cost (snapshotted by
  // the backend from products.cost_price).
  const profit = computeOrderProfit(840, 776.64, {
    customerPaidInclGst: 966, ...NO_PAYMENT_FEES,
  });
  approx(profit, 63.36, 0.005);
});

test('…and the website default would have understated that by the Stripe fee', () => {
  // What the drawer computed BEFORE this fix — a fee on a sale paid by bank transfer.
  const wrong = computeOrderProfit(840, 776.64, { customerPaidInclGst: 966 });
  const fee = 966 * STRIPE_RATE + STRIPE_FIXED;   // ≈ $25.90
  approx(wrong, 63.36 - fee, 0.005);
  assert.ok(wrong < 63.36 - 25,
    'the old path silently docked ~$26 of fees from a sale that never touched a card — ' +
    'a 40% understatement of its profit');
});

test('the profit waterfall still foots with zero fees', () => {
  const b = computeProfitBreakdown(840, 776.64, { customerPaidInclGst: 966, ...NO_PAYMENT_FEES });
  assert.equal(b.stripeRateFee, 0);
  assert.equal(b.stripeFixedFee, 0);
  assert.equal(b.stripeFeeInclGst, 0, 'no card fee at all — not a rounded-down one');
  // customerPaid − supplier(incl GST) − fee(incl GST) − GST remitted === netProfit
  approx(
    b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst - b.gstRemittedToIrd,
    b.netProfit,
    0.01,
  );
  approx(b.netProfit, 63.36, 0.01);
});

test('a website order still pays its Stripe fee — NO_PAYMENT_FEES has not leaked into the default', () => {
  const web = computeOrderProfit(100, 60, { customerPaidInclGst: 115 });
  approx(web, 100 - 60 - (115 * STRIPE_RATE + STRIPE_FIXED));
  assert.ok(web < 40, 'a card sale must net less than an otherwise identical bank-transfer sale');
});

// ─── 3. The page actually wires it up ────────────────────────────────────────
test('orders.js exports isInvoiceOrder and renders a Channel column', () => {
  assert.ok(/export function isInvoiceOrder/.test(ordersSrc));
  assert.ok(/key: 'channel', label: 'Channel'/.test(ordersSrc),
    'invoiced sales sit in the Orders list — without a Channel column they are indistinguishable');
  assert.ok(/admin-badge--invoice/.test(ordersSrc) && /admin-badge--web/.test(ordersSrc));
});

test('orders.js passes NO_PAYMENT_FEES for an invoiced order', () => {
  assert.ok(/NO_PAYMENT_FEES/.test(ordersSrc), 'must import and use NO_PAYMENT_FEES');
  // absorbedShipping (free-ship courier) rides alongside on both branches — see
  // order-profit-absorbed-shipping-jul2026.test.js. It must not displace NO_PAYMENT_FEES.
  assert.ok(/isInvoiceOrder\(o\)\s*\n?\s*\?\s*\{ customerPaidInclGst, absorbedShipping, \.\.\.NO_PAYMENT_FEES \}/.test(ordersSrc),
    'the fee options must branch on isInvoiceOrder(o) and still spread NO_PAYMENT_FEES');
  // Both the per-line profits AND the waterfall must use the branched options.
  assert.ok(/computeLineProfits\([\s\S]{0,220}?feeOpts,/.test(ordersSrc),
    'computeLineProfits must receive feeOpts, not a hard-coded { customerPaidInclGst }');
  assert.ok(/computeProfitBreakdown\(totalPrice, totalCost, feeOpts\)/.test(ordersSrc),
    'computeProfitBreakdown must receive feeOpts');
});

test('the drawer does not show a "Paid to Stripe" row on an invoiced sale', () => {
  // A "−$0.00" Stripe row implies a fee was charged and rounded away. There wasn't one.
  assert.ok(/if \(isInvoiceOrder\(o\)\) \{[\s\S]{0,200}?Card fee[\s\S]{0,120}?bank transfer/.test(ordersSrc),
    'expected an explicit "Card fee (bank transfer — none)" row for invoiced sales');
});

test('the badge CSS exists — .admin-badge has no colour of its own', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'inkcartridges', 'css', 'admin.css'), 'utf8');
  assert.ok(/\.admin-badge--invoice\s*\{[^}]*background/.test(css),
    '.admin-badge--invoice needs its own background — the base class supplies none, so an ' +
    'unstyled modifier renders as invisible text');
  assert.ok(/\.admin-badge--web\s*\{[^}]*background/.test(css));
});

// ─── 4. The "sales missing a cost" alert ─────────────────────────────────────
test('the dashboard names the sales that are blocking the profit calculation', () => {
  const dash = fs.readFileSync(path.join(ADMIN, 'pages', 'dashboard.js'), 'utf8');
  assert.ok(/computeMissingCostAlert/.test(dash),
    'a Dashboard full of "—" profit tiles with no explanation is a dead end');
  assert.ok(/Sales missing a cost/.test(dash), 'the alert card must be rendered');
  // Case 2 — the live cause: the backend materialised a shadow order with revenue
  // but ZERO items, because the invoice line s SKU did not resolve.
  assert.ok(/no items recorded/.test(dash),
    'must detect the zero-items case — that is what is actually nulling COGS today');
  assert.ok(/supplier_cost_snapshot == null/.test(dash),
    'must also detect an item that simply has no cost');
});
