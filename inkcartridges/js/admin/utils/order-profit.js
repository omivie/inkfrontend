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

import { computeLineProfits, computeProfitBreakdown, orderDiscountParts, NO_PAYMENT_FEES } from './profitability.js';

export const PROFIT_STATE = {
  OK: 'ok',
  UNKNOWN: 'unknown',
  CANCELLED: 'cancelled',
  NO_ITEMS: 'no_items',
  PENDING: 'pending',
  FAILED: 'failed',
};

/**
 * Is this order an invoiced sale (phone / walk-in / B2B) rather than a website order?
 *
 * The backend materialises a saved invoice as a shadow `orders` row. It sets
 * `payment_method: 'invoice'` and numbers it `INV-<n>`. NB it does NOT expose the
 * `orders.channel` column on the API (the spec asked for it; it isn't there), so
 * payment_method is the contract and the order-number prefix is the belt-and-braces
 * fallback. If `channel` ever appears, it wins.
 *
 * This matters for money: an invoiced sale is paid by bank transfer, so it carries
 * NO card processing fee. Charging it the Stripe 2.65% + $0.30 understates its profit.
 *
 * Lives here rather than in pages/orders.js so utils never has to import a page
 * (that would be circular). pages/orders.js re-exports it for its own callers;
 * pages/dashboard.js keeps its documented local mirror.
 */
export function isInvoiceOrder(o) {
  if (!o) return false;
  if (o.channel) return String(o.channel).toLowerCase() === 'invoice';
  if (o.payment_method) return String(o.payment_method).toLowerCase() === 'invoice';
  return /^INV-/i.test(String(o.order_number || ''));
}

function warn(msg) {
  if (typeof DebugLog !== 'undefined' && DebugLog?.warn) DebugLog.warn(msg);
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
    itemCount: 0,
    totalRevenueExGst: null,
    totalCostExGst: null,
    isInvoice: false,
    absorbedApplies: false,
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
  let missingCostCount = 0;
  let totalRevenueExGst = 0;
  let totalCostExGst = 0;
  const lines = [];
  for (const item of items) {
    const unitPrice = item.sell_price ?? item.unit_price ?? item.price;   // backend stores sell_price ex-GST
    const qty = item.qty ?? item.quantity ?? 0;
    const lineRevenue = (unitPrice ?? 0) * qty;
    totalRevenueExGst += lineRevenue;
    const hasCost = item.supplier_cost_snapshot != null;
    if (hasCost) totalCostExGst += item.supplier_cost_snapshot * qty;
    else missingCostCount++;
    lines.push({ revenueExGst: lineRevenue, costExGst: hasCost ? item.supplier_cost_snapshot * qty : null });
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

  const absorbedShipping = order.shipping_absorbed || null;
  const absorbedApplies = !!absorbedShipping
    && absorbedShipping.applies === true
    && Number(absorbedShipping.amount_incl_gst) > 0;

  // An invoiced sale is settled by bank transfer — there is no card processor, so
  // NO fee. Charging it Stripe's 2.65% + $0.30 invents a payment it never made.
  const feeOpts = isInvoice
    ? { customerPaidInclGst, absorbedShipping, ...NO_PAYMENT_FEES }
    : { customerPaidInclGst, absorbedShipping };

  // Per-line profits stay valid even when a sibling line has no cost: each line is
  // (own revenue − own cost − its revenue share of the order-level fee), and that
  // fee share is independent of the total cost. So the modal keeps its per-line
  // column in the UNKNOWN state; it is only the SUM that would be a lie.
  const { lineProfits } = computeLineProfits(lines, feeOpts);

  const common = {
    lineProfits,
    missingCostCount,
    itemCount: items.length,
    totalRevenueExGst,
    totalCostExGst: missingCostCount ? null : totalCostExGst,
    isInvoice,
    absorbedApplies,
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

  if (missingCostCount > 0) return result(PROFIT_STATE.UNKNOWN, common);

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
