/**
 * profitability.js — order/product profit math
 * =============================================
 *
 * Pins computeOrderProfit and computeProfitability against real-world fixtures
 * so we don't regress the GST/Stripe convention again. Background:
 *
 *   1. order_items.sell_price is stored EX-GST in the backend, not incl-GST.
 *   2. cost_price is stored ex-GST; we pay supplier incl-GST so it must be
 *      grossed up by 1.15 before deduction.
 *   3. Stripe NZ domestic rate is 2.65% + $0.30 per transaction.
 *   4. Stripe charges 15% GST on its fee. Treat as cash outflow (the input tax
 *      credit is reclaimable but the cash leaves on each transaction), so fee
 *      is multiplied by 1.15.
 *   5. Fee base is the FULL customer-paid amount (incl. shipping + GST), not
 *      just the product subtotal. computeOrderProfit accepts an opts arg with
 *      customerPaidInclGst; falls back to (rev + shipping) × 1.15.
 *
 * Convention revised by user 2026-05-12 (supersedes 2026-05-04). See
 * project_profit_calc.md for accounting rationale.
 *
 * Run with: node --test tests/profitability.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.resolve(__dirname, '..', 'inkcartridges', 'js', 'admin', 'utils', 'profitability.js');

function stripEsm(src) {
  const exposed = new Set();
  let stripped = src.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
    exposed.add(id);
    return `${kw} ${id}`;
  });
  const footer = '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
  return stripped + footer;
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(MODULE_PATH, 'utf8')), ctx, { filename: 'profitability.js' });

// ─── Constants ──────────────────────────────────────────────────────────────

test('STRIPE_RATE is 2.65% (NZ domestic card, stripe.com/nz/pricing)', () => {
  assert.equal(sandbox.STRIPE_RATE, 0.0265);
});

test('STRIPE_FIXED is $0.30 per transaction', () => {
  assert.equal(sandbox.STRIPE_FIXED, 0.30);
});

test('STRIPE_FEE_GST is 15% (GST Stripe charges on top of its fee)', () => {
  assert.equal(sandbox.STRIPE_FEE_GST, 0.15);
});

test('GST_RATE is 15%', () => {
  assert.equal(sandbox.GST_RATE, 0.15);
});

// ─── computeOrderProfit ─────────────────────────────────────────────────────

test('computeOrderProfit: ORD-MOXKETUX (rev $13.87 ex-GST, cost $9.10 ex-GST, customer paid $22.95) → ~$2.36', () => {
  // The order from the user's 2026-05-12 screenshot. Product $13.87 ex-GST,
  // cost $9.10 ex-GST, shipping $7.00, customer paid $22.95 to Stripe.
  //
  // costInclGst = 9.10 × 1.15           = 10.465
  // stripeFee   = (22.95 × 0.0265 + 0.30) × 1.15
  //             = (0.608175 + 0.30)     × 1.15
  //             =  0.908175             × 1.15
  //             ≈  1.0444
  // profit      = 13.87 − 10.465 − 1.0444 ≈ 2.3606
  const profit = sandbox.computeOrderProfit(13.87, 9.10, { customerPaidInclGst: 22.95 });
  assert.ok(Math.abs(profit - 2.3606) < 0.01, `expected ~$2.36, got ${profit}`);
});

test('computeOrderProfit: $311.52 ex-GST rev, $198.65 cost ex-GST, no opts → falls back to (rev × 1.15)', () => {
  // When no customerPaidInclGst is supplied and no shipping passed, the fee
  // base is just revenue grossed up — same shape as the old formula but with
  // the new rate and GST-on-fee multiplier.
  //
  // costInclGst = 198.65 × 1.15                = 228.4475
  // grossInclGst= 311.52 × 1.15                = 358.248
  // stripeFee   = (358.248 × 0.0265 + 0.30) × 1.15
  //             = (9.4936 + 0.30) × 1.15        ≈ 11.2626
  // profit      = 311.52 − 228.4475 − 11.2626   ≈ 71.8099
  const profit = sandbox.computeOrderProfit(311.52, 198.65);
  assert.ok(Math.abs(profit - 71.810) < 0.05, `expected ~$71.81, got ${profit}`);
});

test('computeOrderProfit: prefers customerPaidInclGst over fallback shipping math', () => {
  // Same revenue/cost as above but pass an explicit paid amount including
  // shipping; profit should drop because Stripe is charging on a larger base.
  const profitNoShip = sandbox.computeOrderProfit(311.52, 198.65);
  const profitWithShip = sandbox.computeOrderProfit(311.52, 198.65, { customerPaidInclGst: 400.00 });
  assert.ok(profitWithShip < profitNoShip, 'larger fee base must produce a smaller profit');
});

test('computeOrderProfit: shippingExGst fallback adjusts fee base when paid is unknown', () => {
  // shippingExGst is grossed up in the fallback path:
  // feeBase = (10 + 5) × 1.15 = 17.25
  const profitWithShipping = sandbox.computeOrderProfit(10, 5, { shippingExGst: 5 });
  const profitNoShipping = sandbox.computeOrderProfit(10, 5);
  assert.ok(profitWithShipping < profitNoShipping, 'shipping in fallback widens fee base');
});

test('computeOrderProfit: zero/negative/NaN revenue returns null', () => {
  assert.equal(sandbox.computeOrderProfit(0, 100), null);
  assert.equal(sandbox.computeOrderProfit(-50, 100), null);
  assert.equal(sandbox.computeOrderProfit(NaN, 100), null);
  assert.equal(sandbox.computeOrderProfit('not a number', 100), null);
});

test('computeOrderProfit: cost > revenue yields a negative profit (loss)', () => {
  // A lossy order should report negative profit, not be silently swallowed.
  const profit = sandbox.computeOrderProfit(50, 100);
  assert.ok(profit < 0, `expected loss, got ${profit}`);
});

test('computeOrderProfit: opts arg is optional (back-compat with positional gstRate)', () => {
  // Passing nothing for opts should not throw — most call sites omit it.
  const profit = sandbox.computeOrderProfit(100, 50);
  assert.ok(Number.isFinite(profit), `expected a number, got ${profit}`);
});

// ─── computeProfitability (per-product, retail_price is incl-GST) ────────────

test('computeProfitability: $63.49 incl-GST retail, $34.95 cost ex-GST → ~$13.08 profit', () => {
  // priceExGst  = 63.49 / 1.15                       = 55.2087
  // costInclGst = 34.95 × 1.15                       = 40.1925
  // stripeFee   = 63.49 × 0.0265 × 1.15              =  1.9349
  // profit      = 55.2087 − 40.1925 − 1.9349         ≈ 13.0813
  // margin      = 13.0813 / 55.2087 × 100            ≈ 23.69%
  // markup      = 13.0813 / 34.95   × 100            ≈ 37.43%
  const r = sandbox.computeProfitability({ retail_price: 63.49, cost_price: 34.95 });
  assert.ok(Math.abs(r.profitDollars - 13.081) < 0.01, `profit: ${r.profitDollars}`);
  assert.ok(r.marginPct > 23 && r.marginPct < 25, `margin: ${r.marginPct}`);
  assert.ok(r.markupPct > 36 && r.markupPct < 39, `markup: ${r.markupPct}`);
});

test('computeProfitability: missing/invalid inputs return all-null shape', () => {
  const r = sandbox.computeProfitability({ retail_price: null, cost_price: 10 });
  assert.equal(r.profitDollars, null);
  assert.equal(r.marginPct, null);
  assert.equal(r.markupPct, null);
});
