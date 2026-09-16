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
 *   - Supplier freight: what a SUPPLIER bills us to send a purchase order.
 *     Pass opts.supplierFreight, built by utils/supplier-freight.js from the
 *     backend's owner-only order.supplier_freight envelope. A GST-inclusive
 *     cost handled exactly like the supplier/Stripe lines — deducted ex-GST
 *     from profit, its GST reclaimed at the IRD line. Absent / {applies:false}
 *     ⇒ $0, so aggregates and card/invoice paths that don't pass it are
 *     unchanged.
 *   - Absorbed courier: NO LONGER A DEDUCTION (ERR-255). opts.absorbedShipping
 *     is still parsed, and its zone/delivery-type/amount are still returned for
 *     LABELLING, but it does not reduce take-home and its GST is not credited
 *     at the IRD line. It was double-charging: measured over 115 order-samples,
 *     there is no order where shipping_absorbed applies and supplier_freight
 *     does not, and where both apply the amounts are identical on 39 of 41 (the
 *     two exceptions are one two-supplier order where absorbed is ONE parcel
 *     rate and freight is TWO). It is the same parcel off the same ladder, and
 *     supplier_freight is the complete figure. The backend's own identity
 *     agrees — gross − net = stripe + opex + supplier_freight, with no
 *     absorbed-courier term, reconciling to the cent against the live RPC.
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

/**
 * Spread into computeOrderProfit / computeProfitBreakdown opts for a sale that
 * never touched a card processor — an invoiced or phone/walk-in order settled by
 * direct credit to the bank account printed on the invoice. There is no Stripe
 * charge on those, so the fee is 0, not "small". Invoiced sales therefore net
 * more than an identical website order, which is the truth, not a bug.
 */
export const NO_PAYMENT_FEES = { stripeRate: 0, stripeFixed: 0 };

/**
 * Parse opts.absorbedShipping (the backend's owner-only order.shipping_absorbed)
 * into the courier cost's three GST parts, or all-zero when it doesn't apply.
 *
 * Contract (see order-profit-absorbed-shipping hand-off):
 *   - Anchor on amount_incl_gst — the actual zone/weight courier rate, and what
 *     the on-screen "Courier absorbed" row displays.
 *   - gst is the reclaimable input credit (gst_component). Courier fees are
 *     GST-inclusive, so when the backend omits it we derive incl × 3/23
 *     (= incl × 0.15/1.15), the GST embedded in a GST-inclusive amount.
 *   - exGst is derived as incl − gst (NOT read from amount_ex_gst) so the cash
 *     waterfall foots exactly regardless of backend rounding; it equals the
 *     provided amount_ex_gst in practice (12.00 − 1.57 = 10.43).
 *
 * Fail-soft & LOUD-by-absence: applies!==true, or a non-finite / non-positive
 * amount_incl_gst, yields { exGst:0, gst:0, inclGst:0 } — a missing field never
 * invents a cost, and a present one is never silently dropped.
 */
function absorbedShippingParts(opts, gstRate = GST_RATE) {
  const a = (opts && typeof opts === 'object') ? opts.absorbedShipping : null;
  if (!a || typeof a !== 'object' || a.applies !== true) return { exGst: 0, gst: 0, inclGst: 0 };
  const inclGst = Number(a.amount_incl_gst);
  if (!Number.isFinite(inclGst) || inclGst <= 0) return { exGst: 0, gst: 0, inclGst: 0 };
  let gst = Number(a.gst_component);
  if (!Number.isFinite(gst) || gst < 0) gst = inclGst * (gstRate / (1 + gstRate)); // GST inside a GST-incl amount
  const exGst = inclGst - gst;
  return { exGst, gst, inclGst };
}

/**
 * Parse opts.supplierFreight (built by utils/supplier-freight.js) into the same
 * three GST parts as the absorbed courier above.
 *
 * A DELIBERATE MIRROR of absorbedShippingParts(), not a generalisation of it.
 * The two costs are shaped alike but answer to different owners — one is the
 * backend's measured courier charge, the other our own rules engine's reading
 * of a supplier's terms — and folding them into one parser is how a change to
 * either one silently moves the other. Anchor on amount_incl_gst; derive the
 * GST inside it when the caller does not state it (× rate/(1+rate) = × 3/23 at
 * 15%); derive exGst by subtraction so the waterfall foots exactly.
 *
 * Fail-soft & LOUD-by-absence: applies!==true, or a non-finite / non-positive
 * amount, yields all zeroes. A caller that passes nothing — every aggregate,
 * every invoice path — is unchanged, and an order that owes freight we could
 * not price is refused UPSTREAM (order-profit.js) rather than quietly costed
 * at $0 here.
 */
function supplierFreightParts(opts, gstRate = GST_RATE) {
  const f = (opts && typeof opts === 'object') ? opts.supplierFreight : null;
  if (!f || typeof f !== 'object' || f.applies !== true) return { exGst: 0, gst: 0, inclGst: 0 };
  const inclGst = Number(f.amount_incl_gst);
  if (!Number.isFinite(inclGst) || inclGst <= 0) return { exGst: 0, gst: 0, inclGst: 0 };
  let gst = Number(f.gst_component);
  if (!Number.isFinite(gst) || gst < 0) gst = inclGst * (gstRate / (1 + gstRate)); // GST inside a GST-incl amount
  const exGst = inclGst - gst;
  return { exGst, gst, inclGst };
}

/**
 * Split the delivery charge the CUSTOMER PAID into its three GST parts.
 *
 * THE THIRD MIRROR of absorbedShippingParts(), and deliberately a mirror rather
 * than a generalisation — same reasoning stated there. This one is the only
 * member of the family that is INCOME rather than an outflow, which is exactly
 * why it must exist: until ERR-261 the delivery a customer paid for was the one
 * number in the order that was charged but never booked.
 *
 * `orders.shipping_fee` is GST-INCLUSIVE (shipping_rates stores fees that way),
 * so the convention is identical to its siblings: anchor on the incl-GST figure,
 * derive the GST inside it (× rate/(1+rate) = × 3/23 at 15%), and derive exGst
 * by subtraction rather than incl / 1.15 so the waterfall foots exactly.
 *
 * 🚨 ZERO AND ABSENT ARE DIFFERENT HERE, AND THE DIFFERENCE IS THE WHOLE POINT.
 * A shipping_fee of 0 is a REAL DECISION — free shipping — and comes back as
 * applies:true with zero amounts. An ABSENT fee is not a decision and must never
 * be allowed to look like one: booking $0 of delivery income against a real
 * supplier freight bill is precisely the defect this function exists to end.
 * So `applies` is what callers read, never the amount, and the caller
 * (order-profit.js) owns what absence means — this parser only refuses to guess.
 *
 * Note the guard is `inclGst < 0`, NOT `<= 0` as in orderDiscountParts below.
 * That asymmetry is deliberate for the reason above: a $0 discount is not a
 * decision anyone made, a $0 delivery charge is.
 */
function shippingRevenueParts(opts, gstRate = GST_RATE) {
  const s = (opts && typeof opts === 'object') ? opts.shippingRevenue : null;
  if (!s || typeof s !== 'object' || s.applies !== true) return { exGst: 0, gst: 0, inclGst: 0 };
  const inclGst = Number(s.amount_incl_gst);
  if (!Number.isFinite(inclGst) || inclGst < 0) return { exGst: 0, gst: 0, inclGst: 0 };
  // `== null` BEFORE Number(), not after. `Number(null)` is 0, which is finite and
  // not negative, so a null gst_component sails through a `!Number.isFinite(gst)`
  // guard and leaves gst at 0 — making exGst the full incl-GST amount and booking
  // $12.00 of revenue for a $12.00 charge that contains $1.57 of GST. This exact
  // line shipped broken for one test run. The siblings above get away with
  // `Number()` first only because their backends always send the component.
  let gst = s.gst_component == null ? NaN : Number(s.gst_component);
  if (!Number.isFinite(gst) || gst < 0) gst = inclGst * (gstRate / (1 + gstRate)); // GST inside a GST-incl amount
  const exGst = inclGst - gst;
  return { exGst, gst, inclGst };
}

/**
 * Split an order-level discount into its GST parts.
 *
 * `orders.discount_amount` is the AGGREGATE of every discount applied to the
 * order — volume pricing, coupon and loyalty — and the backend stores it
 * GST-INCLUSIVE. There is no per-component column on the order row;
 * `loyalty_discount_amount` is a subset of it, exposed only for labelling.
 *
 * Netting the aggregate is the right thing to do: all three reduce realised
 * revenue identically for profit purposes.
 *
 * Convention matches absorbedShippingParts() deliberately — anchor on the
 * incl-GST figure, derive the GST inside it (× rate/(1+rate) = × 3/23 at 15%),
 * and derive exGst as incl − gst rather than incl / 1.15. The two are
 * arithmetically identical; deriving by subtraction keeps the waterfall footing
 * exactly regardless of rounding.
 *
 * Fail-soft & LOUD-by-absence: a missing, null, non-finite or non-positive
 * amount yields all zeroes with applies:false. A discount that was never
 * recorded must never invent a revenue reduction — and, just as importantly,
 * `Number(null) === 0` must not be allowed to look like a real "$0 discount"
 * decision. Callers read `applies`, not the amount.
 */
export function orderDiscountParts(discountInclGst, gstRate = GST_RATE) {
  const inclGst = Number(discountInclGst);
  if (!Number.isFinite(inclGst) || inclGst <= 0) {
    return { applies: false, inclGst: 0, gst: 0, exGst: 0 };
  }
  const gst = inclGst * (gstRate / (1 + gstRate)); // GST inside a GST-incl amount
  return { applies: true, inclGst, gst, exGst: inclGst - gst };
}

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
 *   opts.shippingExGst  — FEE BASE ONLY, and nothing else. It is the fallback
 *                         used when customerPaidInclGst is absent:
 *                         feeBase = (revenueExGst + shippingExGst) × 1.15.
 *                         🚨 IT IS NOT REVENUE AND MUST NOT BECOME REVENUE.
 *                         invoice-math.js:207 passes it alongside
 *                         NO_PAYMENT_FEES, where it is entirely inert (zero
 *                         rate, zero fixed). Making it load-bearing would wake
 *                         that dead argument and credit every invoice with the
 *                         freight it charged while deducting no freight cost.
 *                         Delivery INCOME rides on opts.shippingRevenue below.
 *   opts.shippingRevenue — the delivery charge the customer actually paid
 *                         (ERR-261), shaped { applies, amount_incl_gst,
 *                         gst_component?, basis? } and parsed by
 *                         shippingRevenueParts(). Added to revenue ex-GST.
 *                         Absent ⇒ $0, so aggregate/invoice callers are
 *                         unchanged — the CALLER decides what absence means.
 *   opts.stripeRate / opts.stripeFixed — override the processor fee. Spread
 *                         NO_PAYMENT_FEES for a bank-transfer sale (invoiced /
 *                         phone order): no card, so no fee.
 *   opts.absorbedShipping — backend order.shipping_absorbed. When it applies,
 *                         the absorbed courier cost (ex-GST) is subtracted too.
 *                         Absent ⇒ $0, so aggregate/invoice callers are unchanged.
 *   opts.supplierFreight — supplier-billed freight on a small purchase order
 *                         (ERR-241), from utils/supplier-freight.js. Subtracted
 *                         ex-GST. Absent ⇒ $0, same as above.
 *
 * Stripe fee is feeBase × stripeRate + stripeFixed, deducted ex-GST.
 */
export function computeOrderProfit(revenueExGst, totalCostExGst, opts = {}) {
  const {
    shippingExGst = 0, customerPaidInclGst = null, gstRate = GST_RATE,
    stripeRate = STRIPE_RATE, stripeFixed = STRIPE_FIXED,
  } = (opts && typeof opts === 'object') ? opts : {};
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const paid = Number(customerPaidInclGst);
  const ship = Number(shippingExGst);
  const feeBase = Number.isFinite(paid) && paid > 0
    ? paid
    : (rev + (Number.isFinite(ship) ? ship : 0)) * (1 + gstRate);
  const stripeFee = feeBase * stripeRate + stripeFixed;
  // Delivery INCOME (ERR-261). The customer's shipping charge is revenue on this
  // order and has to be booked as such, because the freight bill on the very
  // same parcel is deducted two lines down. Booking one half of a pass-through
  // is what printed a loss on profitable orders.
  const shippingRevExGst = shippingRevenueParts(opts, gstRate).exGst; // $0 unless the customer paid for delivery
  const totalRevExGst = rev + shippingRevExGst;
  // Supplier freight is the ONLY courier-side deduction (ERR-255). The absorbed
  // courier is the same parcel and is already inside this figure; deducting
  // both was the double-charge the migration removed.
  const freightExGst = supplierFreightParts(opts, gstRate).exGst;   // $0 unless a supplier billed us freight
  return totalRevExGst - costExGst - stripeFee - freightExGst;
}

/**
 * Per-line net profit for an order's items.
 *
 * The order carries money that can't be attributed to a single line — the
 * Stripe fee (including the fixed $0.30), any supplier freight, and the
 * delivery charge the customer paid — so we derive the whole order-level
 * adjustment (= revenue − cost − orderProfit) and allocate it across lines
 * proportionally to ex-GST line revenue. This guarantees
 * Σ lineProfits === computeOrderProfit(...) exactly, so the per-line Profit
 * column and its foot always agree with the Profit Breakdown take-home.
 *
 * THE RESIDUAL IS WHY THIS FUNCTION NEEDED NO CHANGE FOR ERR-261. It never
 * enumerates the order-level terms, it subtracts the answer from the inputs, so
 * delivery income joined the allocation the moment computeOrderProfit booked
 * it. Note the allocation can now be NEGATIVE — on an order whose shipping
 * charge exceeds the Stripe fee plus freight, the customer's delivery payment
 * is income shared across the lines. A line's profit legitimately exceeding its
 * own revenue-minus-cost is that, not a bug.
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
    // null/undefined revenue ⇒ unknown, NOT zero. `Number(null)` is 0, which is
    // finite, so the old spelling let an unpriced line join the allocation
    // denominator as a confident $0 (ERR-261). Mirrors the cost guard below.
    const rev = (l == null || l.revenueExGst == null) ? NaN : Number(l.revenueExGst);
    if (Number.isFinite(rev)) totalRevenue += rev;
    const cost = Number(l?.costExGst);
    if (Number.isFinite(cost)) totalCost += cost;
  }
  const totalProfit = computeOrderProfit(totalRevenue, totalCost, opts);
  // Whole-order adjustment not attributable to a line: Stripe fee (incl. the
  // fixed $0.30) + supplier freight − the delivery charge the customer paid.
  // Deliberately derived as a residual and never enumerated — see the docblock.
  // (It has NOT included the absorbed courier since ERR-255; that is the same
  // parcel as supplier freight and is labelling only.)
  const orderLevelFee = (totalProfit != null && totalRevenue > 0)
    ? totalRevenue - totalCost - totalProfit
    : null;
  const lineProfits = rows.map((l) => {
    const rev = (l == null || l.revenueExGst == null) ? NaN : Number(l.revenueExGst);
    // null/undefined cost ⇒ unknown (Number(null) is 0, which would lie); NaN guards bad input.
    const cost = (l == null || l.costExGst == null) ? NaN : Number(l.costExGst);
    if (!Number.isFinite(rev) || !Number.isFinite(cost) || totalProfit == null || totalRevenue <= 0) {
      return null;
    }
    const feeShare = (orderLevelFee ?? 0) * (rev / totalRevenue);
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
 *     − supplierCostInclGst      (cost ex-GST + the GST you pay the supplier)
 *     − stripeFeeInclGst         (Stripe fee + the GST Stripe charges on it)
 *     − absorbedShippingInclGst  (free-ship courier we absorbed, if any; incl-GST)
 *     − supplierFreightInclGst   (freight a supplier billed us, if any; incl-GST)
 *     − gstRemittedToIrd         (GST collected − GST already paid out as credits)
 *   = netProfit                  (identical to computeOrderProfit — GST nets to 0)
 *
 * The absorbed-courier and supplier-freight lines are handled exactly like the
 * supplier/Stripe lines: shown incl-GST, their GST reclaimed inside
 * gstRemittedToIrd. Each is present only when its own opts object applies;
 * otherwise every field of that group is 0.
 *
 * gstRemittedToIrd is both the residual that makes the waterfall foot AND the
 * true GST return figure (output tax − input tax credits) — the two are
 * algebraically identical.
 *
 * 🚨 THAT IDENTITY HAS A PRECONDITION, AND IT WAS SILENTLY FALSE FOR A MONTH.
 * The residual only IS the GST return when revenue covers EVERYTHING the
 * customer paid. `customerPaidInclGst` is the full charge, shipping included;
 * `revenueExGst` is the goods alone. So every dollar of delivery the customer
 * paid used to land inside gstRemittedToIrd, which is a residual and will
 * absorb anything you fail to book. On order 2026091601 it reported $11.82 of
 * GST remitted on a $41.49 sale whose entire GST content is $5.41 — more than
 * twice the GST that exists. It still footed. A residual always foots.
 *
 * ***IF A RESIDUAL IS YOUR ONLY CHECK, IT WILL AGREE WITH YOU FOREVER.***
 *
 * That is why totalRevenueExGst — goods + the delivery charge — is now what the
 * net, the margin and gstCollected are all built from, and why the test suite
 * pins the one bound a residual cannot fake: gstRemittedToIrd can never exceed
 * the output GST on the sale, customerPaidInclGst × 3/23.
 *
 * Returns null when inputs are unusable (same guard as computeOrderProfit).
 */
export function computeProfitBreakdown(revenueExGst, totalCostExGst, opts = {}) {
  const {
    shippingExGst = 0, customerPaidInclGst = null, gstRate = GST_RATE,
    stripeRate = STRIPE_RATE, stripeFixed = STRIPE_FIXED,
  } = (opts && typeof opts === 'object') ? opts : {};
  const rev = Number(revenueExGst);
  const costExGst = Number(totalCostExGst);
  if (!Number.isFinite(rev) || !Number.isFinite(costExGst) || rev <= 0) return null;
  const paid = Number(customerPaidInclGst);
  const ship = Number(shippingExGst);
  const customerPaid = Number.isFinite(paid) && paid > 0
    ? paid
    : (rev + (Number.isFinite(ship) ? ship : 0)) * (1 + gstRate);
  // Processor fee — billed on the full incl-GST charge. Zero for a bank-transfer
  // sale (NO_PAYMENT_FEES), in which case the waterfall still foots: with no fee
  // there is no fee GST to reclaim, so gstRemittedToIrd simply absorbs it.
  const stripeRateFee = customerPaid * stripeRate;   // 2.65% on card, 0 on bank transfer
  const stripeFixedFee = stripeFixed;                // $0.30 per card transaction
  const stripeFeeExGst = stripeRateFee + stripeFixedFee;
  const stripeFeeGst = stripeFeeExGst * gstRate;     // 15% GST Stripe adds
  const stripeFeeInclGst = stripeFeeExGst + stripeFeeGst;
  // Supplier — paid the cost plus the GST on it.
  const supplierCostGst = costExGst * gstRate;
  const supplierCostInclGst = costExGst + supplierCostGst;
  // Absorbed courier — PARSED FOR LABELLING, NOT DEDUCTED (ERR-255).
  //
  // 🚨 THESE THREE AMOUNTS DO NOT APPEAR IN `netProfit` OR IN `gstRemittedToIrd`
  // BELOW, AND THAT IS DELIBERATE. Until 2026-09-12 they did, alongside supplier
  // freight, and that double-charged the same parcel: `shipping_absorbed` is the
  // outbound parcel rate and `supplier_freight` prices the same parcel(s) off
  // the same ladder. Measured over 115 order-samples — no order where absorbed
  // applies and freight does not, amounts identical on 39 of 41. They are kept
  // as returned fields because the zone, the delivery type and the amount are
  // still worth SAYING on screen ("free shipping — the customer paid $0 and we
  // absorbed it"); they are simply no longer arithmetic.
  //
  // If you are about to add `- absorbedShippingExGst` back into the net: that is
  // the bug, not the fix. `supplier_freight.amount_ex_gst` is the complete
  // figure for the order, every supplier and both thresholds already inside it.
  const absorbed = absorbedShippingParts(opts, gstRate);
  const absorbedShippingInclGst = absorbed.inclGst;
  const absorbedShippingGst = absorbed.gst;
  const absorbedShippingExGst = absorbed.exGst;
  const a = (opts && typeof opts === 'object') ? opts.absorbedShipping : null;
  const absorbedShippingApplies = absorbedShippingInclGst > 0;
  // Supplier freight — what a supplier billed US for delivery because our
  // purchase order to them was under their free-freight threshold (ERR-241).
  // A distinct payment from both the goods cost and the absorbed courier, so it
  // is its own outflow rather than folded into supplierCostInclGst: that figure
  // is what the goods cost, and the Orders list column pins itself to it.
  const freight = supplierFreightParts(opts, gstRate);
  const supplierFreightInclGst = freight.inclGst;
  const supplierFreightGst = freight.gst;
  const supplierFreightExGst = freight.exGst;
  const f = (opts && typeof opts === 'object') ? opts.supplierFreight : null;
  const supplierFreightApplies = supplierFreightInclGst > 0;
  // Delivery INCOME — the shipping charge the customer paid (ERR-261).
  //
  // Booked as revenue because the freight bill for the SAME PARCEL is deducted
  // above. Until 2026-09-12 neither half was counted and the two omissions
  // cancelled: ERR-241 deducted freight but short-circuited it whenever the
  // customer had paid for delivery, so shipping stayed a clean pass-through.
  // ERR-255 deleted that short-circuit — correctly, we really do pay the bill —
  // and the revenue half was never added back. One half of a pass-through is
  // not a pass-through; it is a loss the order did not make.
  const shippingRevenue = shippingRevenueParts(opts, gstRate);
  const shippingRevenueInclGst = shippingRevenue.inclGst;
  const shippingRevenueGst = shippingRevenue.gst;
  const shippingRevenueExGst = shippingRevenue.exGst;
  const sr = (opts && typeof opts === 'object') ? opts.shippingRevenue : null;
  const shippingRevenueApplies = !!sr && sr.applies === true;
  // EVERYTHING the customer paid, ex-GST — goods (net of any discount) plus
  // delivery. This, not the goods alone, is the revenue the rest of the
  // statement is built on.
  const totalRevenueExGst = rev + shippingRevenueExGst;
  // Take-home is GST-neutral (the GST you pay is reclaimed) — same as computeOrderProfit.
  const netProfit = totalRevenueExGst - costExGst - stripeFeeExGst - supplierFreightExGst;
  // GST collected from the customer, and what's left to remit to IRD after
  // crediting the GST already paid to supplier + Stripe + supplier freight.
  const gstCollected = customerPaid - totalRevenueExGst;
  const gstRemittedToIrd = gstCollected - supplierCostGst - stripeFeeGst - supplierFreightGst;
  const netMarginPct = (netProfit / totalRevenueExGst) * 100;
  return {
    customerPaidInclGst: customerPaid,
    // GOODS ONLY, and it stays that way. ERR-219's two positive controls and
    // sourcing.js:346 pin the Supplier-cost column against this basis; widening
    // it would move a cost column to fix a revenue bug. Delivery income is its
    // own sibling below, and totalRevenueExGst is the sum the net is built on.
    revenueExGst: rev,
    shippingRevenueApplies,
    shippingRevenueInclGst,
    shippingRevenueGst,
    shippingRevenueExGst,
    // How we know the delivery charge: 'recorded' (the order's own shipping_fee)
    // or 'derived' (the residual of customerPaid against booked revenue). null
    // when nothing applies. Provenance lives in the RETURN VALUE, not only in a
    // tooltip, so a consumer can tell a measured figure from a reconstructed one.
    shippingRevenueBasis: shippingRevenueApplies && sr ? (sr.basis ?? null) : null,
    // NOT `totalRevenueExGst`, deliberately. order-profit.js's result object
    // already carries a `totalRevenueExGst` meaning the GOODS sum, and a single
    // consumer reads both objects side by side. Two different numbers sharing
    // one spelling across two payloads is a bug waiting for a careless
    // destructure, so this one says what it includes.
    revenueWithShippingExGst: totalRevenueExGst,
    gstCollected,
    supplierCostExGst: costExGst,
    supplierCostGst,
    supplierCostInclGst,
    stripeRateFee,
    stripeFixedFee,
    stripeFeeExGst,
    stripeFeeGst,
    stripeFeeInclGst,
    absorbedShippingApplies,
    absorbedShippingInclGst,
    absorbedShippingGst,
    absorbedShippingExGst,
    absorbedShippingZone: absorbedShippingApplies && a ? (a.zone ?? null) : null,
    // The ERR-118 field, nested inside `shipping_absorbed`.
    //
    // 🚨 I FIRST WROTE "0 of 167 live orders" HERE AND IT WAS FABRICATED. I
    // measured `shipping_absorbed` off `GET /api/admin/orders` LIST rows, where
    // the key is ABSENT — it is a DETAIL-ONLY field — and read absence as
    // `applies !== true`. That yields a clean, confident zero for a field that
    // was never projected: ERR-220's shape exactly (a presence check that asks
    // about the wrong thing), and ERR-243's (absence and negative are two
    // states, not one). A second session made the identical error on the
    // identical endpoint the same afternoon and retracted it.
    //
    // RE-MEASURED ON THE DETAIL ENDPOINT, 2026-09-12, 60 orders:
    //
    //   LIST rows carrying the key            0 of 167
    //   DETAIL payloads carrying the key     60 of 60
    //     shipping_absorbed.applies true     22 of 60
    //     supplier_freight.applies true      58 of 60
    //     BOTH on the same order             22 of 60
    //
    // So the de-dup branch in supplier-freight.js — which drops the absorbed
    // consignment so it is not charged twice — is LIVE ON 37% OF ORDERS, not
    // dead. Anyone who "simplifies" it on the strength of a zero measured from
    // a list row double-charges freight on every one of them.
    //
    // ***A FIELD THAT IS NOT PROJECTED ANSWERS EVERY QUESTION THE SAME WAY.***
    // Ask the endpoint that carries it.
    //
    // This stays what it always was: the delivery type the BACKEND used when it
    // priced the absorbed courier. It is not the ORDER's delivery type, and it
    // was the only thing ever standing in for one — that job now belongs to the
    // two fields below.
    absorbedShippingDeliveryType: absorbedShippingApplies && a ? (a.delivery_type ?? null) : null,
    // THE ORDER'S OWN DELIVERY AREA, AND HOW WE KNOW IT (ERR-253).
    //
    // `deliveryType` is 'urban' | 'rural' | null, where null means NOT
    // RECORDED and must never be rendered as 'urban'. `deliveryTypeBasis` is
    // 'recorded' | 'snapshot' | 'charged' | 'assumed' | null and is the whole
    // point: only the last of those is a guess, and the order modal printed
    // the word "assumed" over all of them until this landed.
    deliveryType: f ? (f.deliveryType ?? null) : null,
    deliveryTypeBasis: f ? (f.deliveryTypeBasis ?? null) : null,
    parcelWeightKg: f ? (f.parcelWeightKg ?? null) : null,
    supplierFreightApplies,
    supplierFreightInclGst,
    supplierFreightGst,
    supplierFreightExGst,
    // `supplierFreightEstimated` IS GONE ON PURPOSE (ERR-255). There is nothing
    // left to estimate: the backend publishes the figure for every order, so a
    // flag meaning "we guessed this" has no true value to hold. It was the name
    // of a defect, not a state. Do not reintroduce it to mean something else.
    //
    // The total is a FLOOR when the backend could not price every consignment,
    // which makes take-home a CEILING. That is `complete`, and it is a different
    // claim from "we guessed" — one is the backend telling us what it does not
    // know, the other was us not asking.
    supplierFreightComplete: !supplierFreightApplies || !f || f.complete !== false,
    supplierFreightUnpricedConsignments: supplierFreightApplies && f
      ? (Number(f.unpricedConsignments) || 0) : 0,
    supplierFreightSuppliers: supplierFreightApplies && f && Array.isArray(f.suppliers)
      ? f.suppliers.slice() : [],
    // Per-consignment detail, verbatim from the backend, so the modal can
    // explain any figure in a tooltip without a second request.
    supplierFreightConsignments: supplierFreightApplies && f && Array.isArray(f.consignments)
      ? f.consignments.slice() : [],
    supplierFreightZone: supplierFreightApplies && f ? (f.zone ?? null) : null,
    supplierFreightParcelRateInclGst: supplierFreightApplies && f
      ? (f.parcelRateInclGst ?? null) : null,
    // Provenance for the absorbed row's disappearance, in the RETURN VALUE and
    // not only in a comment — a consumer that still wants to render a courier
    // line can see WHY the money is not here (fail-soft must be loud).
    absorbedShippingSupersededByFreight: absorbedShippingApplies,
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
