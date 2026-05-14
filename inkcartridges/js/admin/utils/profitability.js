/**
 * Profitability helpers — single source of truth for margin/markup/profit math.
 *
 * Convention (revised by user 2026-05-12, supersedes 2026-05-04):
 *   - Revenue is ex-GST (we don't keep the 15% GST collected — passes to IRD).
 *   - Cost is stored ex-GST; we pay supplier incl-GST so cost is grossed up by
 *     × (1 + gstRate) before deduction.
 *   - Stripe NZ domestic = 2.65% × gross + $0.30 per transaction.
 *   - Stripe charges 15% GST on its fee. We treat that as a real cash outflow
 *     (input tax credit is reclaimable but it's still cash leaving on each
 *     transaction), so the fee is multiplied by (1 + STRIPE_FEE_GST).
 *   - Fee base for an order is the FULL customer-paid amount (incl. shipping
 *     + GST), not just the product subtotal. When the caller doesn't have the
 *     exact charge amount, fall back to (revenue + shipping) × (1 + gstRate).
 *
 *   priceExGst    = retail_price / (1 + gstRate)
 *   costInclGst   = cost_price * (1 + gstRate)
 *   stripeFee     = retail_price * STRIPE_RATE * (1 + STRIPE_FEE_GST)    // per-unit; $0.30 fixed is per-order, applied in computeOrderProfit
 *   profitDollars = priceExGst - costInclGst - stripeFee
 *   marginPct     = profitDollars / priceExGst  * 100   // share of ex-GST revenue
 *   markupPct     = profitDollars / cost_price  * 100   // share of supplier cost (ex-GST)
 */

export const GST_RATE = 0.15;
export const STRIPE_RATE = 0.0265;      // NZ domestic card: 2.65% (verified stripe.com/nz/pricing 2026-05-13)
export const STRIPE_FIXED = 0.30;       // NZ domestic card: $0.30 per transaction
export const STRIPE_FEE_GST = 0.15;     // Stripe charges 15% GST on top of its fee
const MISSING = '—';

export function computeProfitability(row, gstRate = GST_RATE) {
  const retail = Number(row?.retail_price);
  const cost = Number(row?.cost_price);
  if (!Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) {
    return { priceExGst: null, costInclGst: null, profitDollars: null, marginPct: null, markupPct: null, stripeFee: null };
  }
  const priceExGst = retail / (1 + gstRate);
  const costInclGst = cost * (1 + gstRate);
  const stripeFee = retail * STRIPE_RATE * (1 + STRIPE_FEE_GST);
  const profitDollars = priceExGst - costInclGst - stripeFee;
  const marginPct = (profitDollars / priceExGst) * 100;
  const markupPct = (profitDollars / cost) * 100;
  return { priceExGst, costInclGst, profitDollars, marginPct, markupPct, stripeFee };
}

/**
 * Per-order net profit.
 *
 *   revenueExGst        — sum of ex-GST line totals (order_items.sell_price ×
 *                         qty; backend stores sell_price ex-GST).
 *   totalCostExGst      — sum of supplier costs (ex-GST). Function grosses up
 *                         by (1 + gstRate) since we pay supplier incl-GST.
 *   opts.customerPaidInclGst — exact gross customer charge (preferred fee base
 *                         because Stripe charges on what hit the card, incl.
 *                         shipping + GST).
 *   opts.shippingExGst  — fallback when customerPaidInclGst is absent:
 *                         feeBase = (revenueExGst + shippingExGst) × 1.15.
 *
 * Stripe fee is (feeBase × STRIPE_RATE + STRIPE_FIXED) × (1 + STRIPE_FEE_GST)
 * — i.e. the full cash outflow to Stripe including the 15% GST on the fee.
 */
export function computeOrderProfit(revenueExGst, totalCostExGst, opts = {}) {
  const { shippingExGst = 0, customerPaidInclGst = null, gstRate = GST_RATE } = (opts && typeof opts === 'object') ? opts : {};
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const costInclGst = costExGst * (1 + gstRate);
  const paid = Number(customerPaidInclGst);
  const ship = Number(shippingExGst);
  const feeBase = Number.isFinite(paid) && paid > 0
    ? paid
    : (rev + (Number.isFinite(ship) ? ship : 0)) * (1 + gstRate);
  const stripeFee = (feeBase * STRIPE_RATE + STRIPE_FIXED) * (1 + STRIPE_FEE_GST);
  return rev - costInclGst - stripeFee;
}

export function marginBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 5 ? 'critical' : num < 15 ? 'warning' : num < 30 ? 'healthy' : 'excellent';
  return `<span class="margin-badge margin-badge--${cls}" title="Margin: net profit (after GST on cost + Stripe 2.65% incl. GST on fee) as share of ex-GST revenue">${num.toFixed(1)}%</span>`;
}

export function markupBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 20 ? 'critical' : num < 50 ? 'warning' : num < 150 ? 'healthy' : 'excellent';
  const display = num >= 1000 ? num.toFixed(0) : num.toFixed(1);
  return `<span class="markup-badge margin-badge margin-badge--${cls}" title="Markup: net profit (after GST on cost + Stripe 2.65% incl. GST on fee) as a share of supplier cost (ex-GST)">${display}%</span>`;
}

export function formatProfitDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return MISSING;
  const fmt = (typeof window !== 'undefined' && window.formatPrice)
    ? window.formatPrice
    : (v) => `$${Number(v).toFixed(2)}`;
  return fmt(n);
}
