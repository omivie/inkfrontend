/**
 * Order profit — the ONE place an order's take-home profit is derived.
 *
 * Two surfaces show an order's profit: the Orders list column and the order
 * detail modal's Profit Breakdown. They used to be one inline block inside
 * pages/orders.js, which meant the moment a second surface wanted the number it
 * would have been re-implemented and the two would drift. A figure derivable
 * from the same inputs must never disagree with itself on screen (ERR-113), so
 * both call `orderProfitFromDetail` and render whatever it returns.
 *
 * This module contains NO math. Every number comes from profitability.js
 * (GST-neutral convention, Stripe 2.65% + $0.30, absorbed courier) — this is
 * only the *classification* layer: given a full order, decide whether a profit
 * can honestly be stated at all, and if so assemble the inputs.
 *
 * THE CLASSIFICATION IS THE POINT. There are five ways an order can fail to
 * produce a profit figure, and they are NOT the same fact:
 *
 *   CANCELLED  — no revenue was realised. The backend excludes cancelled orders
 *                from COGS and revenue, so we do too. Needs no detail fetch.
 *   NO_ITEMS   — the order has no line items at all. Nothing to cost.
 *   UNKNOWN    — it HAS items, but at least one has no supplier_cost_snapshot.
 *                A profit computed from the rest would be an OVER-statement,
 *                because the missing cost would silently count as $0 — the
 *                ERR-028 / ERR-068 failure mode this module exists to prevent.
 *   FAILED     — (set by the caller) we could not fetch the detail. "We didn't
 *                ask" is not "there is no cost". Callers must render it
 *                distinctly, never as $0 and never as UNKNOWN.
 *   PENDING    — (set by the caller) the fetch is in flight.
 *
 * In every one of those states `netProfit` is null, never 0.
 *
 * ── UNPRICED SUPPLIER FREIGHT IS A QUALIFIER, NOT A SIXTH REFUSAL (ERR-241) ─
 *
 * An order can owe a supplier freight charge we cannot price — a line naming no
 * supplier, a supplier with no recorded freight terms, a delivery zone with no
 * courier rate. That does NOT blank the take-home, and the distinction from a
 * missing `supplier_cost_snapshot` is the reason why:
 *
 *   a missing supplier COST is UNBOUNDED and is the dominant term. Any figure
 *   computed without it is wrong by an unknown amount in an unknown direction,
 *   so there is no honest number to print. Refuse.
 *
 *   an unpriced FREIGHT charge is BOUNDED and DIRECTIONAL — the courier ladder
 *   tops out at $30 incl-GST, and it can only ever make take-home LOWER. So the
 *   figure is a stateable CEILING, and deleting it would be present→absent
 *   (ERR-158) — throwing away everything we do know to avoid saying what we
 *   don't.
 *
 * So `netProfit` stands and `supplierFreightUnknown` travels beside it with the
 * reason. Every surface that prints the number MUST print the qualifier: a
 * silent ceiling presented as a measurement is the bug this comment prevents.
 *
 * ── REVENUE IS NET OF THE ORDER DISCOUNT (ERR-168, Aug 2026) ────────────────
 *
 * Line items carry the price BEFORE any order-level discount. Since public
 * volume pricing shipped, most orders also carry `orders.discount_amount` — the
 * GST-INCLUSIVE aggregate of volume + coupon + loyalty. Summing the lines and
 * stopping there overstates revenue, and therefore profit, by discount/1.15 on
 * every discounted order.
 *
 * It is not only the profit line. `computeProfitBreakdown` derives
 * `gstCollected = customerPaid − revenue`, and `customerPaid` (the order total)
 * has ALWAYS been net of the discount. So while revenue stayed gross the two
 * sides were on different bases: the proof order reported $4.00 of GST collected
 * on a $116.60 sale. Netting the discount out of revenue is what puts both sides
 * on the same footing.
 */

import { computeLineProfits, computeProfitBreakdown, orderDiscountParts, NO_PAYMENT_FEES, GST_RATE } from './profitability.js';
import { supplierFreightForOrder, freightCeilingReason } from './supplier-freight.js';

export const PROFIT_STATE = {
  OK: 'ok',
  UNKNOWN: 'unknown',
  CANCELLED: 'cancelled',
  NO_ITEMS: 'no_items',
  PENDING: 'pending',
  FAILED: 'failed',
};

/**
 * The three channels an order can arrive through. One vocabulary, and the only
 * place the storefront/invoice/quick-order distinction is decided (ERR-199).
 *
 * These are the backend's own `orders.channel` values, spelled here so a reader
 * of any surface can find the whole vocabulary in one place rather than three
 * string comparisons scattered across a page module.
 */
export const ORDER_CHANNEL = Object.freeze({
  WEB: 'web',
  INVOICE: 'invoice',
  QUICK_ORDER: 'quick_order',
});

/**
 * Which channel did this order arrive through?
 *
 * `channel` IS THE AUTHORITY when the backend sends it. The Sep-2026 handoff is
 * explicit that an order whose number happens to start `INV-` but whose channel
 * says `web` is a website order, so the number is never consulted once `channel`
 * is present — and an UNRECOGNISED channel value reads as Website (handoff
 * Rule 3), never as "invoice", because guessing "invoice" from an unknown string
 * would put a storefront order in the no-card-fee branch and overstate its profit.
 *
 * Measured against live production 2026-09-01: `channel` IS NOT ON THE PAYLOAD.
 * It is absent on every row of the list and the detail endpoint, and `?channel=`
 * is an accepted-and-ignored decoy (`zzznope` returns the full 50-row set). So
 * the ladder below it is load-bearing, not belt-and-braces, and REMOVING IT
 * WOULD BE A BEHAVIOUR CHANGE rather than a cleanup (ERR-158): the backend
 * materialises a saved invoice as a shadow `orders` row with
 * `payment_method: 'invoice'`, numbered `INV-<n>`.
 *
 * The ladder is measured, not assumed — `payment_method` is `'invoice'` on
 * exactly the 15 `INV-` orders and null on all 131 website orders, 146 of 146
 * with zero disagreements against the number prefix (npm run probe:orders-invoice-sent).
 *
 * This matters for money: an invoiced sale is paid by bank transfer, so it carries
 * NO card processing fee. Charging it the Stripe 2.65% + $0.30 understates its profit.
 *
 * Lives here rather than in pages/orders.js so utils never has to import a page
 * (that would be circular). pages/orders.js re-exports isInvoiceOrder for its own
 * callers; pages/dashboard.js keeps its documented local mirror.
 */
export function orderChannel(o) {
  if (!o) return ORDER_CHANNEL.WEB;

  if (o.channel) {
    const c = String(o.channel).toLowerCase().trim();
    if (c === ORDER_CHANNEL.INVOICE) return ORDER_CHANNEL.INVOICE;
    if (c === ORDER_CHANNEL.QUICK_ORDER) return ORDER_CHANNEL.QUICK_ORDER;
    // Rule 3: anything else the backend sends — including a value added after
    // this was written — is treated as Website rather than guessed at.
    return ORDER_CHANNEL.WEB;
  }

  // No `channel` on the payload. Fall back, in the order the evidence supports.
  if (o.payment_method) {
    return String(o.payment_method).toLowerCase() === ORDER_CHANNEL.INVOICE
      ? ORDER_CHANNEL.INVOICE : ORDER_CHANNEL.WEB;
  }
  return /^INV-/i.test(String(o.order_number || '')) ? ORDER_CHANNEL.INVOICE : ORDER_CHANNEL.WEB;
}

/**
 * Is this order an invoiced sale (phone / walk-in / B2B) rather than a website order?
 *
 * Thin over orderChannel() on purpose: the money path (no card fee) and the
 * invoice-sent column must never disagree about what an invoiced sale IS.
 */
export function isInvoiceOrder(o) {
  if (!o) return false;
  return orderChannel(o) === ORDER_CHANNEL.INVOICE;
}

function warn(msg) {
  if (typeof DebugLog !== 'undefined' && DebugLog?.warn) DebugLog.warn(msg);
}

/**
 * What the customer paid for delivery on this order (ERR-261).
 *
 * `orders.shipping_fee` is GST-INCLUSIVE — shipping_rates stores fees that way,
 * pinned by the modal's own "Shipping (incl. GST)" row (pages/orders.js) and by
 * pages/invoices.js, which divides it back out for the invoice freight field.
 *
 * TWO STATES. A stated fee, or an admission that we do not know.
 *
 *   recorded — the order carries a finite fee. A fee of 0 IS recorded: free
 *              shipping is a decision somebody made, which is why the guard
 *              below is `< 0` and not `<= 0`.
 *   unknown  — no fee on the payload. Take-home becomes a FLOOR (revenue we
 *              could not book, so the truth is higher) and says so. It is NOT
 *              $0 of income, and the order is NOT blanked.
 *
 * 🚨 THERE IS NO "DERIVED FROM THE TOTAL" BRANCH, AND THERE MUST NEVER BE ONE.
 * I wrote one first. `residual = total − revenue × 1.15` looks unimpeachable —
 * two known numbers, one gap — and it reproduced order 2026091601 to the cent.
 * Then the ERR-168 apportionment test went red, because a residual cannot tell
 * a delivery charge from ANY other reason revenue fell short of the total. On
 * an order carrying a discount it booked the discount as shipping income: net
 * profit came out IDENTICAL with and without an $11.50 discount, silently
 * undoing the whole of ERR-168. A residual will explain away every mistake you
 * make upstream of it, including the ones you have not made yet.
 *
 * ***A RESIDUAL IS A CHECK, NEVER A SOURCE.*** Which is exactly how it is used
 * below: when a fee IS stated, the residual is computed alongside it and any
 * disagreement over 5c is warned and carried out in the return value. Two
 * numbers agreeing is the only evidence either one is live (ERR-253), and the
 * identity itself is the one scripts/probe-order-discount.mjs already asserts
 * against production.
 *
 * ALIAS LADDER, and the two names deliberately NOT on it:
 *   `shipping_fee` → `shipping_cost` → `shipping_amount`, all customer-charge
 *   spellings (js/order-totals.js:144 carries the same ladder for the receipt).
 *   `freight` is EXCLUDED: on an admin order that word is our supplier's bill to
 *   US, and reading a cost field as income is how this codebase earns its worst
 *   bugs. `shipping` is EXCLUDED: on a raw API order it is the tier NAME
 *   ("Standard Shipping"), not a number.
 */
const SHIPPING_FEE_KEYS = ['shipping_fee', 'shipping_cost', 'shipping_amount'];
const SHIPPING_DRIFT_TOLERANCE = 0.05;   // the bound probe-order-discount.mjs asserts live

function shippingRevenueForOrder(order, ctx = {}) {
  const NONE = { applies: false, amount_incl_gst: 0, basis: null, unknown: true, drift: null };
  if (!order || typeof order !== 'object') return NONE;

  let recorded = null;
  for (const key of SHIPPING_FEE_KEYS) {
    if (order[key] == null) continue;          // `== null` only — a 0 is an answer
    const n = Number(order[key]);
    if (Number.isFinite(n) && n >= 0) { recorded = n; break; }
  }
  if (recorded == null) return NONE;

  // THE CHECK, not the source. Everything paid, less everything already booked.
  const paid = Number(ctx.customerPaidInclGst);
  const booked = Number(ctx.bookedRevenueExGst);
  let drift = null;
  if (Number.isFinite(paid) && Number.isFinite(booked)) {
    drift = recorded - (paid - booked * (1 + GST_RATE));
    if (Math.abs(drift) > SHIPPING_DRIFT_TOLERANCE) {
      warn(`[order-profit] shipping_fee ${recorded} does not reconcile against the charged `
        + `total on ${order.order_number || order.id} (drift ${drift.toFixed(2)}) — the stated `
        + `fee still stands; something else on this order is unexplained`);
    }
  }
  // gst_component is OMITTED, not null: the parser derives incl × 3/23 when it is
  // absent, and `Number(null)` is 0 — a value that passes a finite check and
  // books the entire charge as GST-free revenue. It did, for one test run.
  return { applies: true, amount_incl_gst: recorded, basis: 'recorded', unknown: false, drift };
}

/** Every return has the same shape, so no consumer has to guard on key presence. */
function result(state, extra = {}) {
  return {
    state,
    netProfit: null,
    netMarginPct: null,
    breakdown: null,
    lineProfits: [],
    missingCostCount: 0,
    // A line nobody priced. Counted and refused exactly like an uncosted one —
    // see the loop in orderProfitFromDetail for why the two must stay symmetric.
    missingPriceCount: 0,
    itemCount: 0,
    totalRevenueExGst: null,
    totalCostExGst: null,
    isInvoice: false,
    absorbedApplies: false,
    // Delivery income (ERR-261). `shippingRevenueBasis` is 'recorded' | 'derived'
    // | null, and null with applies:false means NOT REPORTED — never $0 charged.
    shippingRevenueApplies: false,
    shippingRevenueInclGst: 0,
    shippingRevenueBasis: null,
    shippingRevenueUnknown: false,
    shippingRevenueDrift: null,
    // Supplier freight (ERR-241). Consumers read the FLAGS, never the amount —
    // the money itself lives on `breakdown`, and an order can be
    // supplierFreightUnknown while having no breakdown at all.
    supplierFreightApplies: false,
    supplierFreightUnknown: false,
    supplierFreightUnknownReason: null,
    supplierFreightSuppliers: [],
    // ONE ceiling gate, two causes (ERR-255): freight we could not state at all,
    // and a freight total the backend reports as incomplete. Both mean take-home
    // is an upper bound; no surface should have to remember which is which.
    supplierFreightCeiling: false,
    supplierFreightCeilingReason: null,
    supplierFreightComplete: true,
    supplierFreightUnpricedConsignments: 0,
    // ABSENT is not {applies:false}. The profit UI is owner-gated, so a missing
    // envelope here means a stale payload or a backend regression, never "this
    // viewer may not see it" — and never $0.
    supplierFreightAbsent: false,
    supplierFreightConsignments: [],
    supplierFreightZone: null,
    supplierFreightParcelRateInclGst: null,
    deliveryType: null,
    deliveryTypeBasis: null,
    parcelWeightKg: null,
    // Order-level discount (ERR-168). `grossRevenueExGst` is the raw line sum —
    // kept so a surface can show WHY revenue is lower than the prices above it
    // without re-summing the items itself. `discountApplies` is the gate every
    // consumer reads; a $0 amount and an absent one are both `false`.
    grossRevenueExGst: null,
    orderDiscountInclGst: 0,
    orderDiscountExGst: 0,
    discountApplies: false,
    discountExceedsRevenue: false,
    couponCode: null,
    loyaltyDiscountInclGst: 0,
    ...extra,
  };
}

/**
 * Derive an order's take-home profit from a FULL order object.
 *
 * @param {object} order  an order from AdminAPI.getOrder — it must carry `items`
 *        with `supplier_cost_snapshot`. The LIST endpoint does not return that
 *        field (ERR-039), so a list row alone can only ever resolve to
 *        CANCELLED or NO_ITEMS here — callers must fetch the detail first.
 * @param {object} [opts]
 * @param {number} [opts.customerPaidInclGst]  card-fee base override. The modal
 *        passes the order-breakdown endpoint's `total_incl_gst`; the list column
 *        makes no such call and falls back to the order's own total_amount. The
 *        two are the same figure in practice — if they ever aren't, the override
 *        wins and the divergence is warned about rather than silently splitting
 *        the two surfaces' answers.
 * @returns {{state:string, netProfit:number|null, netMarginPct:number|null,
 *   breakdown:object|null, lineProfits:Array<number|null>, missingCostCount:number,
 *   itemCount:number, totalRevenueExGst:number|null, totalCostExGst:number|null,
 *   isInvoice:boolean, absorbedApplies:boolean, grossRevenueExGst:number|null,
 *   orderDiscountInclGst:number, orderDiscountExGst:number, discountApplies:boolean,
 *   discountExceedsRevenue:boolean, couponCode:string|null,
 *   loyaltyDiscountInclGst:number}}
 *
 * `totalRevenueExGst` is REALISED revenue — net of the order discount.
 * `grossRevenueExGst` is the raw line sum. They differ exactly when
 * `discountApplies`, and the difference is `orderDiscountExGst`.
 */
export function orderProfitFromDetail(order, opts = {}) {
  if (!order || typeof order !== 'object') return result(PROFIT_STATE.FAILED);

  // A cancelled order earned nothing. Resolvable from a list row alone, which is
  // why the list column can short-circuit it without spending a detail fetch.
  if (String(order.status || '').toLowerCase() === 'cancelled') {
    return result(PROFIT_STATE.CANCELLED);
  }

  const items = Array.isArray(order.items) ? order.items
    : Array.isArray(order.order_items) ? order.order_items
      : [];
  if (!items.length) return result(PROFIT_STATE.NO_ITEMS);

  const isInvoice = isInvoiceOrder(order);

  // `== null` and nothing looser: a genuine 0 is a real recorded cost (a giveaway,
  // a sample), only null/undefined means nobody wrote one down. `?? 0` here is the
  // whole bug class — see the module header.
  //
  // THE SAME RULE NOW RUNS ON BOTH SIDES OF THE LINE (ERR-261). It used to be
  // `(unitPrice ?? 0) * qty` with `qty ?? 0`, so a line whose price or quantity
  // was never recorded contributed $0 of revenue while its cost was still
  // counted three lines down — the cost side refusing outright, the revenue
  // side absorbing the identical absence as a confident zero, in one loop.
  // An unpriced line understates profit exactly as silently as an uncosted one.
  let missingCostCount = 0;
  let missingPriceCount = 0;
  let totalRevenueExGst = 0;
  let totalCostExGst = 0;
  const lines = [];
  for (const item of items) {
    const unitPrice = item.sell_price ?? item.unit_price ?? item.price;   // backend stores sell_price ex-GST
    const qtyRaw = item.qty ?? item.quantity;
    const priceNum = unitPrice == null ? NaN : Number(unitPrice);
    const qtyNum = qtyRaw == null ? NaN : Number(qtyRaw);
    const hasRevenue = Number.isFinite(priceNum) && Number.isFinite(qtyNum);
    if (!hasRevenue) missingPriceCount++;
    const lineRevenue = hasRevenue ? priceNum * qtyNum : null;
    if (hasRevenue) totalRevenueExGst += lineRevenue;
    // Quantity is shared with the cost side, so an unknown quantity makes the
    // cost unstateable too — a snapshot with nothing to multiply it by is not
    // a $0 cost.
    const hasCost = item.supplier_cost_snapshot != null && Number.isFinite(qtyNum);
    if (hasCost) totalCostExGst += item.supplier_cost_snapshot * qtyNum;
    else missingCostCount++;
    lines.push({
      revenueExGst: lineRevenue,
      costExGst: hasCost ? item.supplier_cost_snapshot * qtyNum : null,
    });
  }

  // ── Net out the order-level discount (ERR-168) ─────────────────────────────
  //
  // The line loop above summed the price BEFORE any order discount. The order
  // row carries the aggregate (volume + coupon + loyalty) GST-INCLUSIVE, so it
  // is converted before being netted against ex-GST revenue.
  //
  // It is applied HERE, before both profit calls, rather than being handed to
  // computeOrderProfit as another deduction alongside the Stripe fee and the
  // absorbed courier. A discount is a REVENUE REDUCTION, not a cost: routing it
  // through the cost side would leave `revenueExGst` gross, which keeps
  // `gstCollected = customerPaid − revenue` wrong and overstates the margin
  // denominator. Both surfaces need revenue itself to be the realised figure.
  //
  // Absent / null / 0 ⇒ a strict no-op, the same LOUD-by-absence rule as
  // shipping_absorbed. Old cached list rows without the field cannot turn a
  // real profit into null.
  const grossRevenueExGst = totalRevenueExGst;
  const discount = orderDiscountParts(order.discount_amount);
  let discountExceedsRevenue = false;
  if (discount.applies && grossRevenueExGst > 0) {
    // Apportion across the lines by ex-GST revenue share — the same convention
    // the order-level fee already uses — so the modal's per-line Profit column
    // keeps footing to the order total (ERR-113 / ERR-118).
    const share = discount.exGst / grossRevenueExGst;
    if (share >= 1) {
      // A discount at or above the entire line sum is a data problem, not a
      // free order. Clamp so revenue can't go negative, and say so: the order
      // will resolve to UNKNOWN below rather than print a confident figure.
      discountExceedsRevenue = true;
      warn(`[order-profit] discount ${discount.inclGst} incl-GST exceeds line revenue `
        + `${grossRevenueExGst} ex-GST for ${order.order_number || order.id} — revenue clamped to 0`);
    }
    const keep = Math.max(0, 1 - share);
    // Re-total from the apportioned lines rather than computing
    // `gross − discountExGst` separately. computeLineProfits recomputes its own
    // total from `lines`, and two independently-derived totals can drift by a
    // float ulp — which is exactly enough to break the Σ lineProfits === netProfit
    // invariant that the per-line column and the waterfall both depend on.
    let apportioned = 0;
    for (const l of lines) {
      l.revenueExGst *= keep;
      apportioned += l.revenueExGst;
    }
    totalRevenueExGst = apportioned;
  } else if (discount.applies) {
    // Discount recorded but there is no revenue to apportion it across.
    discountExceedsRevenue = true;
    warn(`[order-profit] discount ${discount.inclGst} incl-GST on an order with no line revenue `
      + `(${order.order_number || order.id})`);
  }

  // Fee base: what actually hit the card, incl. shipping + GST.
  const paidOverride = Number(opts?.customerPaidInclGst);
  const ownTotal = Number(order.total_amount ?? order.total);
  const customerPaidInclGst = Number.isFinite(paidOverride) && paidOverride > 0
    ? paidOverride
    : (Number.isFinite(ownTotal) ? ownTotal : null);
  if (Number.isFinite(paidOverride) && Number.isFinite(ownTotal) && Math.abs(paidOverride - ownTotal) > 0.01) {
    // The modal (with the breakdown endpoint) and the list column (without it)
    // would now be quoting different fee bases for the same order. Say so.
    warn(`[order-profit] fee base disagrees for ${order.order_number || order.id}: `
      + `breakdown ${paidOverride} vs total_amount ${ownTotal}`);
  }

  // ── Delivery income (ERR-261) ──────────────────────────────────────────────
  //
  // Read AFTER the discount has been netted out above, because the derived
  // branch reconciles against revenue as booked, not as listed.
  const shippingRevenue = shippingRevenueForOrder(order, {
    customerPaidInclGst,
    bookedRevenueExGst: totalRevenueExGst,
  });

  const absorbedShipping = order.shipping_absorbed || null;
  const absorbedApplies = !!absorbedShipping
    && absorbedShipping.applies === true
    && Number(absorbedShipping.amount_incl_gst) > 0;

  // ── Supplier freight (ERR-241) ─────────────────────────────────────────────
  //
  // The customer's free-shipping threshold is on the SELL price; the supplier's
  // free-freight threshold is on the GOODS COST. Two tests, two numbers, and an
  // order sits on both sides of them routinely — which is why this is decided
  // from a per-supplier cost roll-up rather than from the order total.
  //
  // It takes the ORDER and nothing else now. It used to be handed a per-supplier
  // cost roll-up because it applied the $100 threshold itself; the backend does
  // that, so the roll-up is no longer an input to a freight decision. The
  // Supplier-cost column still uses `orderSupplierCostFromDetail` — that is a
  // different question (what did the goods cost) with a different answer.
  const supplierFreight = supplierFreightForOrder(order);

  // An invoiced sale is settled by bank transfer — there is no card processor, so
  // NO fee. Charging it Stripe's 2.65% + $0.30 invents a payment it never made.
  //
  // `shippingRevenue` rides on BOTH branches. An invoiced sale pays no card fee;
  // it still charges for delivery. ERR-255 has a test named for exactly the
  // branch that gets forgotten here, and this is the same trap.
  const feeOpts = isInvoice
    ? { customerPaidInclGst, absorbedShipping, supplierFreight, shippingRevenue, ...NO_PAYMENT_FEES }
    : { customerPaidInclGst, absorbedShipping, supplierFreight, shippingRevenue };

  // Per-line profits stay valid even when a sibling line has no cost: each line is
  // (own revenue − own cost − its revenue share of the order-level fee), and that
  // fee share is independent of the total cost. So the modal keeps its per-line
  // column in the UNKNOWN state; it is only the SUM that would be a lie.
  const { lineProfits } = computeLineProfits(lines, feeOpts);

  const common = {
    lineProfits,
    missingCostCount,
    missingPriceCount,
    itemCount: items.length,
    totalRevenueExGst,
    totalCostExGst: missingCostCount ? null : totalCostExGst,
    isInvoice,
    absorbedApplies,
    shippingRevenueApplies: shippingRevenue.applies === true,
    shippingRevenueInclGst: shippingRevenue.applies === true ? shippingRevenue.amount_incl_gst : 0,
    shippingRevenueBasis: shippingRevenue.applies === true ? shippingRevenue.basis : null,
    shippingRevenueUnknown: shippingRevenue.unknown === true,
    shippingRevenueDrift: shippingRevenue.drift ?? null,
    supplierFreightApplies: supplierFreight.applies === true,
    supplierFreightUnknown: supplierFreight.unknown === true,
    supplierFreightUnknownReason: supplierFreight.unknown === true ? supplierFreight.unknownReason : null,
    supplierFreightSuppliers: Array.isArray(supplierFreight.suppliers) ? supplierFreight.suppliers.slice() : [],
    supplierFreightCeiling: freightCeilingReason(supplierFreight) != null,
    supplierFreightCeilingReason: freightCeilingReason(supplierFreight),
    supplierFreightComplete: supplierFreight.complete !== false,
    supplierFreightUnpricedConsignments: Number(supplierFreight.unpricedConsignments) || 0,
    supplierFreightAbsent: supplierFreight.absent === true,
    supplierFreightConsignments: Array.isArray(supplierFreight.consignments)
      ? supplierFreight.consignments.slice() : [],
    supplierFreightZone: supplierFreight.zone ?? null,
    supplierFreightParcelRateInclGst: supplierFreight.parcelRateInclGst ?? null,
    // The order's delivery area travels with the profit info so the modal never
    // has to re-derive it from an address (ERR-253). Null means NOT RECORDED.
    deliveryType: supplierFreight.deliveryType ?? null,
    deliveryTypeBasis: supplierFreight.deliveryTypeBasis ?? null,
    parcelWeightKg: supplierFreight.parcelWeightKg ?? null,
    grossRevenueExGst,
    orderDiscountInclGst: discount.inclGst,
    orderDiscountExGst: discount.exGst,
    discountApplies: discount.applies,
    discountExceedsRevenue,
    // Labelling only — the amounts above are the aggregate and are what the
    // money is derived from. A non-null coupon_code means SOME of the aggregate
    // is a promo code; loyalty_discount_amount is a subset of it. Neither is
    // subtracted again anywhere.
    couponCode: order.coupon_code ? String(order.coupon_code) : null,
    loyaltyDiscountInclGst: orderDiscountParts(order.loyalty_discount_amount).inclGst,
  };

  // Two ways an order cannot be stated at all, and both are UNKNOWN rather than a
  // number: a line with no cost, and a line with no price or quantity.
  //
  // A delivery charge we can neither read nor reconstruct is NOT one of them. It
  // makes take-home a FLOOR — we have omitted revenue, so the true figure is
  // higher — which is the exact mirror of unpriced freight making it a CEILING,
  // and the two must not be folded together because they point opposite ways.
  // Blanking a number the owner could see yesterday would be ERR-158 in the
  // wrong direction: the upgrade path is silent → LOUD, never present → absent.
  if (missingCostCount > 0 || missingPriceCount > 0) return result(PROFIT_STATE.UNKNOWN, common);

  const breakdown = computeProfitBreakdown(totalRevenueExGst, totalCostExGst, feeOpts);
  // computeProfitBreakdown refuses unusable inputs (non-finite, zero revenue).
  // A refusal is unknown, not zero.
  if (!breakdown) return result(PROFIT_STATE.UNKNOWN, { ...common, totalCostExGst: null });

  return result(PROFIT_STATE.OK, {
    ...common,
    netProfit: breakdown.netProfit,
    netMarginPct: breakdown.netMarginPct,
    breakdown,
  });
}
