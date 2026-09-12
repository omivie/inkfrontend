/**
 * Supplier freight — what a SUPPLIER bills us to send a purchase order, read
 * from the backend's `order.supplier_freight` envelope.
 *
 * ── This module no longer decides anything about money (ERR-255) ────────────
 *
 * Until 2026-09-12 it did. It held the per-supplier terms (DSNZ always pays,
 * Augmento free at $100 ex-GST), a transcription of the courier ladder, and a
 * guard that dropped one consignment because `shipping_absorbed` was believed
 * to cover it. All of that is gone. The backend now computes the figure from
 * the owner's actual terms and publishes it per order, per consignment, with
 * its own provenance — so this file's whole job is to PARSE, and to be honest
 * about the states where the answer is not a number.
 *
 * ***THE ESTIMATOR HAD TO COME OUT BEFORE THE FIELD WENT IN.*** Running both
 * double-charges. That is a measurement, not a worry: over 115 order-samples
 * (70 on 09-10, 45 on 09-12) there was NOT ONE order where `shipping_absorbed`
 * applied and `supplier_freight` did not, and where both applied the amounts
 * were identical on 39 of 41. The two exceptions are the same order both times,
 * 2026090102, and it is not an exception to the rule: absorbed $7 is ONE parcel
 * rate, freight $14 is TWO consignments at $7. `shipping_absorbed` is a strict
 * SUBSET of `supplier_freight` — the same parcel priced off the same ladder.
 *
 * Confirmed from the other side by the backend's own identity, which has three
 * deduction terms and NO absorbed-courier term:
 *     gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight
 * Live RPC, 2026-09-10: 2210.76 − (−56.06) = 2266.82 = 170.68 + 1593.50 + 502.64.
 * Exact to the cent. A modal that deducts a fourth term can never agree with
 * the dashboard, and making them agree is the entire point of the migration.
 *
 * ── Two deletions that were NOT obvious from the hand-off's bullet list ─────
 *
 * 1. `customerPaidFreight()` — a short-circuit that returned "no freight owed"
 *    whenever the customer paid for delivery, on the reasoning that a charged
 *    delivery is a pass-through. Measured: 27 of 60 orders have customer-paid
 *    shipping AND a real backend freight bill, $221.77 of $506.98 — 44% of the
 *    total — and 0 orders have customer-paid shipping without one. The customer
 *    paying OUR courier to reach THEM says nothing about the supplier billing
 *    US to reach our door; two parcels, two invoices.
 *    ***IT WAS WORSE THAN THE LADDER'S UNDERSTATEMENT, AND WORSE IN KIND.***
 *    The floor was wrong by a visible amount on orders it did price; this
 *    returned a clean zero with no gap, no qualifier and no estimate flag —
 *    nothing on screen to be suspicious of. Found independently by two sessions.
 *
 * 2. The whole `estimated` vocabulary. There is nothing left to estimate:
 *    `supplier_freight` is present on 150 of 150 live list rows and on every
 *    detail payload. "Estimated" was the name of a defect, not a state.
 *
 * ── A finding that outlived the code that worked around it ──────────────────
 *
 * ***`supplier_freight.parcel_weight_kg` IS THE SUM ACROSS CONSIGNMENTS, AND
 * EACH CONSIGNMENT IS WEIGHED AND PRICED ON ITS OWN.*** Read this before ever
 * pricing a parcel off the order-level weight again. Witness: order
 * 20260730000001, north-island — Augmento shipped 0.1 kg ($7, light band) and
 * DSNZ shipped 2.0 kg ($12, standard band) for $19. Pricing both off the
 * order's 2.1 kg total gives $12 × 2 = $24. The error is invisible on 153 of
 * 154 orders, which is exactly why it is written down rather than remembered
 * (ERR-253, feink-c8).
 */

import { supplierSlug, supplierLabel } from './sourcing.js';

/**
 * What the backend recorded about this order's delivery, and how it knows.
 *
 * THREE SOURCES, IN ORDER, AND THE BASIS IS PART OF THE ANSWER (ERR-253):
 *
 *   recorded  the ORDER says so — `orders.delivery_type`, written at checkout
 *   snapshot  summed from the stored courier-cost snapshot        (exact)
 *   charged   inverted from the fee the customer was charged      (exact)
 *   assumed   urban, and the backend says so rather than pretending
 *
 * Measured 2026-09-12 over 167 live orders: recorded 1, snapshot 19,
 * charged 73, assumed 74. The top-level `orders.delivery_type` column is null
 * on 166 of 167 — it was added without a backfill, on purpose — so **reading
 * only the top-level column would report "unknown" on 99% of orders while the
 * backend already knew the answer for 93 of them.** Read both.
 *
 * `null` is a THIRD STATE and must survive to the display layer. It is not
 * `'urban'`; ERR-235 is what happens when a guess is stored as a fact.
 *
 * @returns {{deliveryType: string|null, basis: string|null, weightKg: number|null}}
 */
export function deliveryFactsForOrder(order) {
  const sf = order && typeof order.supplier_freight === 'object' ? order.supplier_freight : null;
  const recorded = order && typeof order.delivery_type === 'string' ? order.delivery_type : null;
  const fromFreight = sf && typeof sf.delivery_type === 'string' ? sf.delivery_type : null;
  const basis = sf && typeof sf.delivery_type_basis === 'string' ? sf.delivery_type_basis : null;
  const kg = sf && Number.isFinite(Number(sf.parcel_weight_kg)) ? Number(sf.parcel_weight_kg) : null;
  if (recorded) return { deliveryType: recorded, basis: basis || 'recorded', weightKg: kg };
  if (fromFreight) return { deliveryType: fromFreight, basis: basis || null, weightKg: kg };
  return { deliveryType: null, basis: basis || null, weightKg: kg };
}

/**
 * The backend's vocabulary for WHY a consignment was or was not billed.
 *
 * A frozen map rather than a switch at the call site, so a reason the backend
 * coins later is visible as a GAP (`null`) instead of rendering as an empty
 * string inside a sentence that still reads like a complete explanation.
 */
export const FREIGHT_REASONS = Object.freeze({
  always_billed: 'billed on every purchase order',
  goods_under_free_threshold: 'the goods came to under the free-freight threshold',
  goods_at_or_over_free_threshold: 'the goods met the free-freight threshold',
  unknown_supplier: 'the supplier could not be identified',
  unknown_supplier_terms: 'no freight terms are recorded for this supplier',
  unknown_goods_cost: 'the goods cost could not be totalled',
});

/** Phrase for a consignment's `reason`, or null when the backend coins a new one. */
export function freightReasonPhrase(reason) {
  const key = String(reason || '');
  return Object.prototype.hasOwnProperty.call(FREIGHT_REASONS, key) ? FREIGHT_REASONS[key] : null;
}

/**
 * All-zero, never-applies result. `unknown` distinguishes "we decided no" from
 * "we could not decide", and only the second one may qualify a profit figure.
 */
function noFreight(extra = {}) {
  return {
    applies: false,
    unknown: false,
    unknownReason: null,
    absent: false,
    amount_incl_gst: 0,
    gst_component: 0,
    amount_ex_gst: 0,
    // `complete` answers "is this total the whole bill?", so it is vacuously
    // TRUE for an order that owes nothing — a complete bill of zero. That lets
    // the ceiling gate downstream read one flag instead of two.
    complete: true,
    unpricedConsignments: 0,
    suppliers: [],
    consignments: [],
    zone: null,
    parcelRateInclGst: null,
    // Present-and-null, never absent: a reader doing `'deliveryType' in f` must
    // get the same answer on both shapes (ERR-199 — absent, null and a value
    // are three different things and two of them look alike).
    deliveryType: null,
    deliveryTypeBasis: null,
    parcelWeightKg: null,
    ...extra,
  };
}

/**
 * Read one order's supplier freight from the backend envelope.
 *
 * ── FOUR STATES, AND THE FOURTH IS THE ONE THAT MATTERS ─────────────────────
 *
 *   applies:true,  complete:true    the bill, exact. Deduct `amount_ex_gst`.
 *   applies:false                   a KNOWN zero. No row, no qualifier.
 *   complete:false / unpriced > 0   the total is a FLOOR, so take-home is a
 *                                   CEILING. Row renders, "(at most)" applies.
 *   field ABSENT                    LOUD unknown. Never, ever $0.
 *
 * 🚨 ABSENT IS NOT `{applies:false}`, AND THE DOLLAR FIGURE CANNOT TELL THEM
 * APART. Both produce zero freight; they mean opposite things. That is the
 * ERR-243 shape exactly — `null` meaning both "no list" and "read failed" — so
 * the test is `hasOwnProperty`, never truthiness, and the result carries
 * `absent` as a flag of its own.
 *
 * ***AND ABSENCE HERE IS NOT A PERMISSIONS CASE.*** The hand-off says
 * `supplier_freight` is owner-only and "absent for `order_manager` — render
 * nothing, not a zero", which invites reading absence as "this viewer may not
 * see it". It cannot be. The Profit column is in `OWNER_ONLY_COLUMNS`
 * (pages/orders.js) and the modal breakdown is owner-gated too, so the freight
 * field is present exactly when the profit UI renders at all. If a breakdown is
 * on screen and the envelope is missing, the viewer IS a super_admin and the
 * payload is stale or the backend regressed — the one case that must never read
 * as "$0 of freight owed". (Framing: wire-backend-supplier-freight.)
 *
 * `complete:false` and `unpriced_consignments > 0` fire on **0 of 149 live
 * orders**, so neither is reachable by a live-data probe. They are
 * unit-test-only, and the probe SKIPS them BY NAME rather than reporting green.
 *
 * @param {object} order a FULL order from AdminAPI.getOrder, or a list row —
 *        both carry `supplier_freight`.
 */
export function supplierFreightForOrder(order) {
  if (!order || typeof order !== 'object') {
    return noFreight({ unknown: true, absent: true, unknownReason: 'no order was supplied' });
  }

  // THE DELIVERY FACTS BELONG TO THE ORDER, NOT TO THE FREIGHT DECISION.
  // Read before any refusal below and threaded through every one of them: an
  // order whose freight we cannot state still has a delivery area, and the
  // modal still has to say what it is. Reading them only on the success path is
  // how a field ends up null on the orders where it is most interesting.
  const facts = deliveryFactsForOrder(order);
  const base = (extra) => noFreight({
    deliveryType: facts.deliveryType,
    deliveryTypeBasis: facts.basis,
    parcelWeightKg: facts.weightKg,
    ...(extra || {}),
  });

  // ── The absent case, tested by KEY and never by value ─────────────────────
  if (!Object.prototype.hasOwnProperty.call(order, 'supplier_freight')) {
    return base({
      unknown: true,
      absent: true,
      unknownReason: 'the supplier-freight figure was not returned for this order',
    });
  }
  const sf = order.supplier_freight;
  if (!sf || typeof sf !== 'object') {
    // Present but unusable — a null or a scalar where an envelope belongs. Not
    // the same as absent (the backend did answer), and not the same as zero.
    return base({
      unknown: true,
      unknownReason: 'the supplier-freight figure came back in a shape this page cannot read',
    });
  }

  const zone = typeof sf.zone === 'string' ? sf.zone : null;
  const rate = Number(sf.parcel_rate_incl_gst);
  const consignments = Array.isArray(sf.consignments) ? sf.consignments.slice() : [];
  const unpricedRaw = Number(sf.unpriced_consignments);
  const unpricedConsignments = Number.isFinite(unpricedRaw) && unpricedRaw > 0 ? unpricedRaw : 0;
  // `complete` is false only when the backend SAYS false — an absent `complete`
  // on a present envelope is not a refusal. But an unpriced consignment is one
  // whatever `complete` says: the two are the same claim from two directions,
  // and disagreeing with ourselves is not a state we should be able to render.
  const complete = sf.complete !== false && unpricedConsignments === 0;
  const common = {
    zone,
    parcelRateInclGst: Number.isFinite(rate) ? rate : null,
    consignments,
    unpricedConsignments,
    complete,
    deliveryType: facts.deliveryType,
    deliveryTypeBasis: facts.basis,
    parcelWeightKg: facts.weightKg,
  };

  if (sf.applies !== true) return base({ ...common, complete: true });

  const inclGst = Number(sf.amount_incl_gst);
  if (!Number.isFinite(inclGst) || inclGst <= 0) {
    // `applies:true` with no usable amount is the backend contradicting itself.
    // Say so rather than quietly rendering nothing: a freight bill we have been
    // told exists and cannot price is the CEILING case, not the zero case.
    return base({
      ...common,
      unknown: true,
      unknownReason: 'this order is marked as owing supplier freight but carries no amount',
    });
  }
  let gst = Number(sf.gst_component);
  if (!Number.isFinite(gst) || gst < 0) gst = inclGst * (0.15 / 1.15); // GST inside a GST-incl amount
  // exGst is DERIVED as incl − gst rather than read from `amount_ex_gst`, so the
  // cash waterfall foots exactly regardless of backend rounding. It equals the
  // published figure in practice (14.00 − 1.83 = 12.17).
  const exGst = inclGst - gst;

  const billed = consignments.filter((c) => c && c.billed !== false && c.supplier);
  const suppliers = (billed.length ? billed : consignments.filter((c) => c && c.supplier))
    .map((c) => String(c.supplier));

  return {
    applies: true,
    unknown: false,
    unknownReason: null,
    absent: false,
    amount_incl_gst: inclGst,
    gst_component: gst,
    amount_ex_gst: exGst,
    suppliers,
    ...common,
  };
}

/**
 * Does this order's take-home have to be read as a CEILING rather than a
 * measurement? ONE gate, two causes, so no surface has to remember both.
 *
 * An unpriced freight charge is BOUNDED (the courier ladder tops out at $30)
 * and DIRECTIONAL (it can only push profit down), so the figure stays on screen
 * and says what it is. Blanking it would be present→absent (ERR-158) — throwing
 * away everything we do know in order to avoid saying what we don't.
 *
 * @returns {string|null} why it is a ceiling, or null when the figure is exact.
 */
export function freightCeilingReason(freight) {
  if (!freight || typeof freight !== 'object') return null;
  if (freight.unknown === true) return freight.unknownReason || 'the freight rule could not be applied';
  if (freight.complete === false || Number(freight.unpricedConsignments) > 0) {
    const n = Number(freight.unpricedConsignments) || 0;
    return n > 0
      ? `${n} supplier consignment${n === 1 ? '' : 's'} on this order could not be priced`
      : 'the backend reports this freight total as incomplete';
  }
  return null;
}

export { supplierSlug, supplierLabel };
