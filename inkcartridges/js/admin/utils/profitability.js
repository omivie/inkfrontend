/**
 * Profitability helpers — single source of truth for margin/markup/profit math.
 *
 * All figures are net of NZ GST (15%) and Stripe domestic processing fees.
 * We're GST-registered, so GST charged on Stripe fees is reclaimable — the
 * stripe deduction is applied ex-GST.
 *
 *   priceExGst    = retail_price / (1 + gstRate)
 *   stripeFeeExGst= (retail_price * STRIPE_RATE) / (1 + gstRate)
 *   profitDollars = priceExGst - cost_price - stripeFeeExGst
 *   marginPct     = profitDollars / priceExGst  * 100   // 0–100 %
 *   markupPct     = profitDollars / cost_price  * 100   // 0–∞ %
 *
 * The $0.30 Stripe fixed fee is per-transaction, not per-unit, so it is
 * excluded from product-level math and applied at the order level instead
 * (see computeOrderProfit).
 */

export const GST_RATE = 0.15;
export const STRIPE_RATE = 0.027;       // NZ domestic card: 2.7%
export const STRIPE_FIXED = 0.30;       // NZ domestic card: $0.30 per transaction
const MISSING = '—';

export function computeProfitability(row, gstRate = GST_RATE) {
  const retail = Number(row?.retail_price);
  const cost = Number(row?.cost_price);
  if (!Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) {
    return { priceExGst: null, profitDollars: null, marginPct: null, markupPct: null, stripeFeeExGst: null };
  }
  const priceExGst = retail / (1 + gstRate);
  const stripeFeeExGst = (retail * STRIPE_RATE) / (1 + gstRate);
  const profitDollars = priceExGst - cost - stripeFeeExGst;
  const marginPct = (profitDollars / priceExGst) * 100;
  const markupPct = (profitDollars / cost) * 100;
  return { priceExGst, profitDollars, marginPct, markupPct, stripeFeeExGst };
}

/**
 * Per-order net profit. Strips GST from revenue, deducts supplier cost,
 * and deducts the full Stripe fee (% + fixed $0.30) ex-GST.
 *
 *   grossRevenue  — sum of GST-inclusive line totals (item sell_price × qty)
 *   totalCost     — sum of supplier costs (assumed ex-GST)
 */
export function computeOrderProfit(grossRevenue, totalCost, gstRate = GST_RATE) {
  const rev = Number(grossRevenue);
  const cost = Number(totalCost);
  if (!Number.isFinite(rev) || !Number.isFinite(cost) || rev <= 0) return null;
  const revExGst = rev / (1 + gstRate);
  const stripeFeeExGst = (rev * STRIPE_RATE + STRIPE_FIXED) / (1 + gstRate);
  return revExGst - cost - stripeFeeExGst;
}

export function marginBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 5 ? 'critical' : num < 15 ? 'warning' : num < 30 ? 'healthy' : 'excellent';
  return `<span class="margin-badge margin-badge--${cls}" title="Margin: net profit (after GST + Stripe 2.7%) as share of ex-GST sale price">${num.toFixed(1)}%</span>`;
}

export function markupBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 20 ? 'critical' : num < 50 ? 'warning' : num < 150 ? 'healthy' : 'excellent';
  const display = num >= 1000 ? num.toFixed(0) : num.toFixed(1);
  return `<span class="markup-badge margin-badge margin-badge--${cls}" title="Markup: net profit (after GST + Stripe 2.7%) as a multiple of cost">${display}%</span>`;
}

export function formatProfitDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return MISSING;
  const fmt = (typeof window !== 'undefined' && window.formatPrice)
    ? window.formatPrice
    : (v) => `$${Number(v).toFixed(2)}`;
  return fmt(n);
}
