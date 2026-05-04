/**
 * Profitability helpers — single source of truth for margin/markup/profit math.
 *
 * Convention (set by user 2026-05-04):
 *   - Revenue is ex-GST (we don't keep the 15% GST collected — passes to IRD).
 *   - Cost is incl-GST (supplier price stored ex-GST in DB; we pay it +15%).
 *   - Stripe fees are deducted GROSS (no /1.15) — we eat the full fee.
 *
 *   priceExGst    = retail_price / (1 + gstRate)
 *   costInclGst   = cost_price * (1 + gstRate)
 *   stripeFee     = retail_price * STRIPE_RATE        (per-unit; gross)
 *   profitDollars = priceExGst - costInclGst - stripeFee
 *   marginPct     = profitDollars / priceExGst  * 100   // share of ex-GST revenue
 *   markupPct     = profitDollars / cost_price  * 100   // share of supplier cost (ex-GST)
 *
 * The $0.30 Stripe fixed fee is per-transaction, not per-unit, so it is
 * excluded from product-level math and applied at the order level instead
 * (see computeOrderProfit).
 */

export const GST_RATE = 0.15;
export const STRIPE_RATE = 0.029;       // NZ domestic card: 2.9%
export const STRIPE_FIXED = 0.30;       // NZ domestic card: $0.30 per transaction
const MISSING = '—';

export function computeProfitability(row, gstRate = GST_RATE) {
  const retail = Number(row?.retail_price);
  const cost = Number(row?.cost_price);
  if (!Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) {
    return { priceExGst: null, costInclGst: null, profitDollars: null, marginPct: null, markupPct: null, stripeFee: null };
  }
  const priceExGst = retail / (1 + gstRate);
  const costInclGst = cost * (1 + gstRate);
  const stripeFee = retail * STRIPE_RATE;
  const profitDollars = priceExGst - costInclGst - stripeFee;
  const marginPct = (profitDollars / priceExGst) * 100;
  const markupPct = (profitDollars / cost) * 100;
  return { priceExGst, costInclGst, profitDollars, marginPct, markupPct, stripeFee };
}

/**
 * Per-order net profit.
 *
 *   revenueExGst   — sum of ex-GST line totals (order_items.sell_price × qty;
 *                    backend stores sell_price ex-GST, NOT incl-GST)
 *   totalCostExGst — sum of supplier costs (ex-GST). Function grosses up by
 *                    (1 + gstRate) since we pay the supplier incl-GST.
 *
 * Stripe fees are charged on the gross (incl-GST) amount the customer paid
 * and are NOT divided by 1.15 — we deduct the full gross fee.
 */
export function computeOrderProfit(revenueExGst, totalCostExGst, gstRate = GST_RATE) {
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const costInclGst = costExGst * (1 + gstRate);
  const grossInclGst = rev * (1 + gstRate);
  const stripeFee = grossInclGst * STRIPE_RATE + STRIPE_FIXED;
  return rev - costInclGst - stripeFee;
}

export function marginBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 5 ? 'critical' : num < 15 ? 'warning' : num < 30 ? 'healthy' : 'excellent';
  return `<span class="margin-badge margin-badge--${cls}" title="Margin: net profit (after GST on cost + Stripe 2.9% gross) as share of ex-GST revenue">${num.toFixed(1)}%</span>`;
}

export function markupBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 20 ? 'critical' : num < 50 ? 'warning' : num < 150 ? 'healthy' : 'excellent';
  const display = num >= 1000 ? num.toFixed(0) : num.toFixed(1);
  return `<span class="markup-badge margin-badge margin-badge--${cls}" title="Markup: net profit (after GST on cost + Stripe 2.9% gross) as a share of supplier cost (ex-GST)">${display}%</span>`;
}

export function formatProfitDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return MISSING;
  const fmt = (typeof window !== 'undefined' && window.formatPrice)
    ? window.formatPrice
    : (v) => `$${Number(v).toFixed(2)}`;
  return fmt(n);
}
