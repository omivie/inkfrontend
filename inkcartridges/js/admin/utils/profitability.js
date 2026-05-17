/**
 * Profitability helpers — single source of truth for margin/markup/profit math.
 *
 * Convention (GST-neutral — revised by user 2026-05-17, supersedes 2026-05-12):
 *   GST is a pass-through. We collect it from the customer and remit it to IRD;
 *   the GST we pay on supplier cost and on the Stripe fee is reclaimed as an
 *   input tax credit. It nets to zero, so profit is computed entirely ex-GST:
 *   - Revenue is ex-GST (the 15% GST collected is not ours).
 *   - Cost is ex-GST and deducted as-is — NOT grossed up. The GST we pay the
 *     supplier is reclaimable, so it never reduces profit.
 *   - Stripe NZ domestic = 2.65% × gross + $0.30 per transaction, deducted
 *     ex-GST. The 15% GST Stripe charges on its fee is likewise reclaimable, so
 *     it is NOT added. (There is a real cash-flow timing gap on GST in/out, but
 *     that is a working-capital matter, not profit.)
 *   - Fee base for an order is the FULL customer-paid amount (incl. shipping
 *     + GST) because Stripe charges on what hit the card. When the caller
 *     doesn't have the exact charge, fall back to (revenue + shipping) × 1.15.
 *
 *   priceExGst    = retail_price / (1 + gstRate)        // retail_price stored incl-GST
 *   stripeFee     = retail_price * STRIPE_RATE          // per-unit; $0.30 fixed is per-order
 *   profitDollars = priceExGst - cost_price - stripeFee
 *   marginPct     = profitDollars / priceExGst  * 100   // share of ex-GST revenue
 *   markupPct     = profitDollars / cost_price  * 100   // share of supplier cost (ex-GST)
 */

export const GST_RATE = 0.15;
export const STRIPE_RATE = 0.0265;      // NZ domestic card: 2.65% (verified stripe.com/nz/pricing 2026-05-13)
export const STRIPE_FIXED = 0.30;       // NZ domestic card: $0.30 per transaction
const MISSING = '—';

export function computeProfitability(row, gstRate = GST_RATE) {
  const retail = Number(row?.retail_price);
  const cost = Number(row?.cost_price);
  if (!Number.isFinite(retail) || !Number.isFinite(cost) || retail <= 0 || cost <= 0) {
    return { priceExGst: null, costExGst: null, profitDollars: null, marginPct: null, markupPct: null, stripeFee: null };
  }
  const priceExGst = retail / (1 + gstRate);
  const stripeFee = retail * STRIPE_RATE;          // ex-GST; Stripe bills 2.65% of the incl-GST charge
  const profitDollars = priceExGst - cost - stripeFee;
  const marginPct = (profitDollars / priceExGst) * 100;
  const markupPct = (profitDollars / cost) * 100;
  return { priceExGst, costExGst: cost, profitDollars, marginPct, markupPct, stripeFee };
}

/**
 * Per-order net profit (GST-neutral).
 *
 *   revenueExGst        — sum of ex-GST line totals (order_items.sell_price ×
 *                         qty; backend stores sell_price ex-GST).
 *   totalCostExGst      — sum of supplier costs (ex-GST), deducted as-is.
 *   opts.customerPaidInclGst — exact gross customer charge (preferred fee base
 *                         because Stripe charges on what hit the card, incl.
 *                         shipping + GST).
 *   opts.shippingExGst  — fallback when customerPaidInclGst is absent:
 *                         feeBase = (revenueExGst + shippingExGst) × 1.15.
 *
 * Stripe fee is feeBase × STRIPE_RATE + STRIPE_FIXED, deducted ex-GST.
 */
export function computeOrderProfit(revenueExGst, totalCostExGst, opts = {}) {
  const { shippingExGst = 0, customerPaidInclGst = null, gstRate = GST_RATE } = (opts && typeof opts === 'object') ? opts : {};
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const paid = Number(customerPaidInclGst);
  const ship = Number(shippingExGst);
  const feeBase = Number.isFinite(paid) && paid > 0
    ? paid
    : (rev + (Number.isFinite(ship) ? ship : 0)) * (1 + gstRate);
  const stripeFee = feeBase * STRIPE_RATE + STRIPE_FIXED;
  return rev - costExGst - stripeFee;
}

/**
 * Per-line net profit for an order's items.
 *
 * The order's Stripe fee includes a fixed $0.30 that can't be attributed to any
 * single line, so we derive the whole order fee (= revenue − cost − orderProfit)
 * and allocate it across lines proportionally to ex-GST line revenue. This
 * guarantees Σ lineProfits === computeOrderProfit(...) exactly.
 *
 *   lines: [{ revenueExGst, costExGst }]  — costExGst null/NaN ⇒ that line's
 *          profit is null (cost unknown) but its revenue still counts toward
 *          the fee-allocation denominator.
 *   opts:  same shape as computeOrderProfit (customerPaidInclGst, etc.).
 *
 * Returns { lineProfits: (number|null)[], totalProfit, totalRevenue, totalCost }.
 */
export function computeLineProfits(lines, opts = {}) {
  const rows = Array.isArray(lines) ? lines : [];
  let totalRevenue = 0, totalCost = 0;
  for (const l of rows) {
    const rev = Number(l?.revenueExGst);
    if (Number.isFinite(rev)) totalRevenue += rev;
    const cost = Number(l?.costExGst);
    if (Number.isFinite(cost)) totalCost += cost;
  }
  const totalProfit = computeOrderProfit(totalRevenue, totalCost, opts);
  const orderStripeFee = (totalProfit != null && totalRevenue > 0)
    ? totalRevenue - totalCost - totalProfit
    : null;
  const lineProfits = rows.map((l) => {
    const rev = Number(l?.revenueExGst);
    // null/undefined cost ⇒ unknown (Number(null) is 0, which would lie); NaN guards bad input.
    const cost = (l == null || l.costExGst == null) ? NaN : Number(l.costExGst);
    if (!Number.isFinite(rev) || !Number.isFinite(cost) || totalProfit == null || totalRevenue <= 0) {
      return null;
    }
    const feeShare = (orderStripeFee ?? 0) * (rev / totalRevenue);
    return rev - cost - feeShare;
  });
  return { lineProfits, totalProfit, totalRevenue, totalCost };
}

/**
 * Cash-flow waterfall for an order — the literal money trail: the full incl-GST
 * amount the customer paid at the top, every real payment out, take-home profit
 * at the bottom. Each outflow is shown incl-GST (the actual cash that leaves the
 * bank), so the GST you genuinely pay your supplier and Stripe is visible.
 *
 *   customerPaidInclGst
 *     − supplierCostInclGst   (cost ex-GST + the GST you pay the supplier)
 *     − stripeFeeInclGst      (Stripe fee + the GST Stripe charges on it)
 *     − gstRemittedToIrd      (GST collected − GST already paid out as credits)
 *   = netProfit               (identical to computeOrderProfit — GST nets to 0)
 *
 * gstRemittedToIrd is both the residual that makes the waterfall foot AND the
 * true GST return figure (output tax − input tax credits) — the two are
 * algebraically identical.
 *
 * Returns null when inputs are unusable (same guard as computeOrderProfit).
 */
export function computeProfitBreakdown(revenueExGst, totalCostExGst, opts = {}) {
  const { shippingExGst = 0, customerPaidInclGst = null, gstRate = GST_RATE } =
    (opts && typeof opts === 'object') ? opts : {};
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const paid = Number(customerPaidInclGst);
  const ship = Number(shippingExGst);
  const customerPaid = Number.isFinite(paid) && paid > 0
    ? paid
    : (rev + (Number.isFinite(ship) ? ship : 0)) * (1 + gstRate);
  // Stripe fee — billed on the full incl-GST charge.
  const stripeRateFee = customerPaid * STRIPE_RATE;  // 2.65%
  const stripeFixedFee = STRIPE_FIXED;               // $0.30 per transaction
  const stripeFeeExGst = stripeRateFee + stripeFixedFee;
  const stripeFeeGst = stripeFeeExGst * gstRate;     // 15% GST Stripe adds
  const stripeFeeInclGst = stripeFeeExGst + stripeFeeGst;
  // Supplier — paid the cost plus the GST on it.
  const supplierCostGst = costExGst * gstRate;
  const supplierCostInclGst = costExGst + supplierCostGst;
  // Take-home is GST-neutral (the GST you pay is reclaimed) — same as computeOrderProfit.
  const netProfit = rev - costExGst - stripeFeeExGst;
  // GST collected from the customer, and what's left to remit to IRD after
  // crediting the GST already paid to supplier + Stripe.
  const gstCollected = customerPaid - rev;
  const gstRemittedToIrd = gstCollected - supplierCostGst - stripeFeeGst;
  const netMarginPct = (netProfit / rev) * 100;
  return {
    customerPaidInclGst: customerPaid,
    revenueExGst: rev,
    gstCollected,
    supplierCostExGst: costExGst,
    supplierCostGst,
    supplierCostInclGst,
    stripeRateFee,
    stripeFixedFee,
    stripeFeeExGst,
    stripeFeeGst,
    stripeFeeInclGst,
    gstRemittedToIrd,
    netProfit,
    netMarginPct,
  };
}

export function marginBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 5 ? 'critical' : num < 15 ? 'warning' : num < 30 ? 'healthy' : 'excellent';
  return `<span class="margin-badge margin-badge--${cls}" title="Margin: net profit (ex-GST revenue minus ex-GST cost minus Stripe 2.65%) as a share of ex-GST revenue">${num.toFixed(1)}%</span>`;
}

export function markupBadge(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return `<span class="margin-badge margin-badge--unknown">${MISSING}</span>`;
  }
  const num = Number(pct);
  const cls = num < 20 ? 'critical' : num < 50 ? 'warning' : num < 150 ? 'healthy' : 'excellent';
  const display = num >= 1000 ? num.toFixed(0) : num.toFixed(1);
  return `<span class="markup-badge margin-badge margin-badge--${cls}" title="Markup: net profit (ex-GST revenue minus ex-GST cost minus Stripe 2.65%) as a share of supplier cost (ex-GST)">${display}%</span>`;
}

export function formatProfitDollars(n) {
  if (n == null || !Number.isFinite(Number(n))) return MISSING;
  const fmt = (typeof window !== 'undefined' && window.formatPrice)
    ? window.formatPrice
    : (v) => `$${Number(v).toFixed(2)}`;
  return fmt(n);
}
