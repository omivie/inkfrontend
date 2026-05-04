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
 *   3. Stripe fees are deducted GROSS (no /1.15) — we eat the full fee.
 *   4. NZ domestic Stripe rate is 2.9% + $0.30.
 *
 * Convention set by user 2026-05-04. See project_profit_calc.md for the
 * accounting rationale.
 *
 * Fixture is taken from order ORD-MOQBMOJI-C81B807 (4 May 2026):
 *   subtotal_excl_gst = $311.52  (line items × qty, ex-GST)
 *   total_cost_ex_gst = $198.65
 *   total_incl_gst    = $358.24  (== subtotal × 1.15)
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

test('STRIPE_RATE is 2.9% (NZ domestic card, not 2.7%)', () => {
  assert.equal(sandbox.STRIPE_RATE, 0.029);
});

test('STRIPE_FIXED is $0.30 per transaction', () => {
  assert.equal(sandbox.STRIPE_FIXED, 0.30);
});

test('GST_RATE is 15%', () => {
  assert.equal(sandbox.GST_RATE, 0.15);
});

// ─── computeOrderProfit ─────────────────────────────────────────────────────

test('computeOrderProfit: $311.52 ex-GST rev, $198.65 cost ex-GST → ~$72.38 profit', () => {
  // costInclGst  = 198.65 × 1.15           = 228.4475
  // grossInclGst = 311.52 × 1.15           = 358.248
  // stripeFee    = 358.248 × 0.029 + 0.30  =  10.6892
  // profit       = 311.52 − 228.4475 − 10.6892 ≈ 72.3833
  const profit = sandbox.computeOrderProfit(311.52, 198.65);
  assert.ok(Math.abs(profit - 72.3833) < 0.01, `expected ~72.38, got ${profit}`);
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

// ─── computeProfitability (per-product, retail_price is incl-GST) ────────────

test('computeProfitability: $63.49 incl-GST retail, $34.95 cost ex-GST → ~$13.18 profit', () => {
  // priceExGst  = 63.49 / 1.15         = 55.2087
  // costInclGst = 34.95 × 1.15         = 40.1925
  // stripeFee   = 63.49 × 0.029        =  1.8412 (gross)
  // profit      = 55.2087 − 40.1925 − 1.8412 ≈ 13.175
  // margin      = 13.175 / 55.2087 × 100 ≈ 23.86%   (share of ex-GST revenue)
  // markup      = 13.175 / 34.95   × 100 ≈ 37.70%   (share of supplier cost ex-GST)
  const r = sandbox.computeProfitability({ retail_price: 63.49, cost_price: 34.95 });
  assert.ok(Math.abs(r.profitDollars - 13.175) < 0.01, `profit: ${r.profitDollars}`);
  assert.ok(r.marginPct > 23 && r.marginPct < 25, `margin: ${r.marginPct}`);
  assert.ok(r.markupPct > 36 && r.markupPct < 39, `markup: ${r.markupPct}`);
});

test('computeProfitability: missing/invalid inputs return all-null shape', () => {
  const r = sandbox.computeProfitability({ retail_price: null, cost_price: 10 });
  assert.equal(r.profitDollars, null);
  assert.equal(r.marginPct, null);
  assert.equal(r.markupPct, null);
});
