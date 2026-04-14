/**
 * Profitability helpers — single source of truth for margin/markup/profit math.
 *
 *   priceExGst    = retail_price / (1 + gstRate)        // NZ GST = 0.15
 *   profitDollars = priceExGst - cost_price
 *   marginPct     = profitDollars / priceExGst  * 100   // 0–100 %
 *   markupPct     = profitDollars / cost_price  * 100   // 0–∞ %
 */

export const GST_RATE = 0.15;
const MISSING = '\u2014';

export function computeProfitability(row, gstRate = GST_RATE) {
  const retail = Number(row?.retail_price);
  const cost = Number(row?.cost_price);
  if (!Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) {
    return { priceExGst: null, profitDollars: null, marginPct: null, markupPct: null };
  }
  const priceExGst = retail / (1 + gstRate);
  const profitDollars = priceExGst - cost;
  const marginPct = (profitDollars / priceExGst) * 100;
  const markupPct = (profitDollars / cost) * 100;
  return { priceExGst, profitDollars, marginPct, markupPct };
}

export function marginBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 5 ? 'critical' : num < 15 ? 'warning' : num < 30 ? 'healthy' : 'excellent';
  return `<span class="margin-badge margin-badge--${cls}" title="Margin: profit as share of ex-GST sale price">${num.toFixed(1)}%</span>`;
}

export function markupBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 20 ? 'critical' : num < 50 ? 'warning' : num < 150 ? 'healthy' : 'excellent';
  const display = num >= 1000 ? num.toFixed(0) : num.toFixed(1);
  return `<span class="markup-badge margin-badge margin-badge--${cls}" title="Markup: profit as a multiple of cost">${display}%</span>`;
}

export function formatProfitDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return MISSING;
  const fmt = (typeof window !== 'undefined' && window.formatPrice)
    ? window.formatPrice
    : (v) => `$${Number(v).toFixed(2)}`;
  return fmt(n);
}
