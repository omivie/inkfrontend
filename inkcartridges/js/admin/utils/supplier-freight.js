/**
 * Supplier freight — when a purchase order to a supplier is small enough that
 * the SUPPLIER bills us for the delivery, and what that costs.
 *
 * ── The two $100 thresholds are not the same threshold ──────────────────────
 *
 * The customer's free-shipping threshold is $100 on the SELL price. The
 * supplier's free-freight threshold is $100 on the GOODS COST, ex-GST. They are
 * independent tests on two different numbers, and an order routinely sits on
 * both sides at once: order 2026090902 sold for $134.49 (customer ships free)
 * on goods that cost $76.00 ex-GST (supplier still bills us freight). Until
 * ERR-241 the profit breakdown only knew about the first, so that freight was
 * charged to nobody.
 *
 * ── What each supplier actually charges (owner, 2026-09-09) ─────────────────
 *
 *   DSNZ      we ALWAYS pay freight, whatever the purchase order is worth.
 *   Augmento  free over $100 ex-GST; under that they bill us the delivery.
 *
 * A supplier with no rule here is UNKNOWN, never free. `okin` is in
 * SUPPLIER_FILTER_VALUES and its terms have never been stated; guessing "$0"
 * for it would be the ERR-063/068 absence-as-zero failure with money on it.
 *
 * ── This module decides WHETHER and HOW MUCH. It does no profit maths ───────
 *
 * It returns the same shape the backend's `order.shipping_absorbed` uses, so
 * profitability.js can parse it with a mirror of `absorbedShippingParts()` and
 * the waterfall gains one more outflow rather than a new concept.
 */

import { supplierSlug, supplierLabel } from './sourcing.js';

/**
 * Per-supplier freight terms, keyed by the slug `supplierSlug()` produces.
 *
 *   alwaysPays:    true  — we pay freight on every purchase order.
 *   freeOverExGst: n     — free at or above $n of goods ex-GST, billed below it.
 *
 * A supplier absent from this map resolves to UNKNOWN. Adding one is a business
 * fact, not a default: leave it out until someone has actually been asked.
 */
export const SUPPLIER_FREIGHT_RULES = Object.freeze({
  dsnz: Object.freeze({ alwaysPays: true }),
  augmento: Object.freeze({ freeOverExGst: 100 }),
});

/**
 * The courier rate ladder, transcribed from the live `/api/settings` response
 * (`shipping.zones`) on 2026-09-09. Fees are GST-INCLUSIVE, matching
 * `shipping_rates` and the amounts the backend puts in `shipping_absorbed`.
 *
 * ⚠ THIS IS A CONSTANT ON PURPOSE, NOT A `Config` READ. `Config.settings.shipping`
 * does not exist in the admin: only cart.js ever calls `Config.loadSettings()`
 * (config.js:68), and config.js's own hardcoded `settings` block has no
 * `shipping` key. A `Config.settings?.shipping ?? FALLBACK` guard here would be
 * an off switch whose fallback is the only branch that ever runs — the ERR-167
 * shape exactly. `npm run probe:supplier-freight` §1 re-fetches /api/settings
 * live and fails if this table has drifted from it.
 */
export const ZONE_RATES = Object.freeze({
  auckland: Object.freeze([
    { deliveryType: 'urban', fee: 7, minKg: 0, maxKg: null },
    { deliveryType: 'rural', fee: 14, minKg: 0, maxKg: null },
  ]),
  'north-island': Object.freeze([
    { deliveryType: 'urban', fee: 7, minKg: 0, maxKg: 0.5 },
    { deliveryType: 'rural', fee: 14, minKg: 0, maxKg: 0.5 },
    { deliveryType: 'urban', fee: 12, minKg: 0.5, maxKg: null },
    { deliveryType: 'rural', fee: 20, minKg: 0.5, maxKg: null },
  ]),
  'south-island': Object.freeze([
    { deliveryType: 'urban', fee: 7, minKg: 0, maxKg: 0.5 },
    { deliveryType: 'rural', fee: 14, minKg: 0, maxKg: 0.5 },
    { deliveryType: 'urban', fee: 12, minKg: 0.5, maxKg: 2 },
    { deliveryType: 'rural', fee: 20, minKg: 0.5, maxKg: 2 },
    { deliveryType: 'urban', fee: 22, minKg: 2, maxKg: null },
    { deliveryType: 'rural', fee: 30, minKg: 2, maxKg: null },
  ]),
});

/**
 * The cheapest rate that could apply to a zone — the LIGHTEST band, urban.
 *
 * THIS IS A FLOOR, AND IT IS NOW THE FALLBACK RATHER THAN THE ANSWER. Prefer
 * `zoneRateInclGst()` below, which reads the weight and the delivery type the
 * backend now sends. This one survives for the orders that carry neither.
 *
 * Its old doc-comment said "neither the parcel weight nor urban/rural is on the
 * order payload". That was true when it was written on 2026-09-09 and it is
 * false now: measured 2026-09-12 across 167 live orders,
 * `order.supplier_freight` carries `parcel_weight_kg` on 167/167 and
 * `delivery_type` on 167/167 (urban 156 / rural 11). The ERR-241 brief it asked
 * for landed. ***A COMMENT THAT RECORDS AN ABSENCE HAS A SHELF LIFE.***
 *
 * @returns {number|null} GST-inclusive fee, or null for an unknown zone.
 */
export function lightestZoneRateInclGst(zone, deliveryType = 'urban') {
  const tiers = ZONE_RATES[String(zone || '').trim().toLowerCase()];
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const matching = tiers.filter((t) => t.deliveryType === deliveryType);
  if (!matching.length) return null;
  return matching.reduce((lo, t) => (t.fee < lo ? t.fee : lo), Infinity);
}

/**
 * The rate for the band this parcel actually falls in (ERR-253).
 *
 * WHY THIS EXISTS, MEASURED. `lightestZoneRateInclGst` always returned the
 * lightest urban band because the weight and the area were unknowable from an
 * order. Both are knowable now, and the cost of not using them is not small:
 * across the 154 live orders our module prices, the lightest-urban floor sits
 * **$365.00 below** the backend's own figure, understating on **54** of them —
 * 37 because the parcel is over the 0.5 kg band, 10 because the delivery is
 * rural, 1 for both, 6 for multi-consignment reasons.
 *
 * The band table is the same `ZONE_RATES` as before; only the selection changed
 * from "cheapest row" to "the row this parcel matches". With that change, this
 * function's rate reproduces the backend's own `supplier_freight.amount_incl_gst`
 * to the cent on 154 of 154 priced orders.
 *
 * SCOPE THAT CLAIM CAREFULLY: it is about the RATE, not about what
 * `supplierFreightForOrder` finally returns. That total legitimately differs
 * from the backend's whenever the absorbed-courier consignment is dropped to
 * avoid double-charging it — which is 22 of 60 orders, measured on the DETAIL
 * endpoint, because `shipping_absorbed` is absent from list rows entirely.
 *
 * FALLS BACK RATHER THAN GUESSES. An unknown weight or an unrecorded delivery
 * type returns the floor, and the caller still labels it an estimate — a
 * missing fact must never be promoted into a number that reads as measured.
 * `deliveryType` of `null` means NOT RECORDED and is treated as urban ONLY for
 * arithmetic, never for display: `deliveryTypeBasis` on the result says which.
 *
 * Bands are half-open [minKg, maxKg): a parcel of exactly 0.5 kg is in the
 * LIGHT band, matching the backend's own reading of the same table.
 *
 * @param {string} zone           `delivery_zone` / `supplier_freight.zone`
 * @param {number|null} weightKg  `supplier_freight.parcel_weight_kg`
 * @param {string|null} deliveryType `'urban' | 'rural' | null`
 * @returns {number|null} GST-inclusive fee, or null for an unknown zone.
 */
export function zoneRateInclGst(zone, weightKg, deliveryType) {
  const tiers = ZONE_RATES[String(zone || '').trim().toLowerCase()];
  if (!Array.isArray(tiers) || !tiers.length) return null;
  const area = deliveryType === 'rural' ? 'rural' : 'urban';
  const matching = tiers.filter((t) => t.deliveryType === area);
  if (!matching.length) return null;
  const kg = Number(weightKg);
  if (!Number.isFinite(kg) || kg < 0) {
    return matching.reduce((lo, t) => (t.fee < lo ? t.fee : lo), Infinity);
  }
  const band = matching.find((t) => kg >= t.minKg && (t.maxKg == null || kg < t.maxKg));
  // A weight above every band's ceiling belongs in the heaviest band, not in
  // the cheapest one — falling back to the floor here is how a 5 kg parcel
  // would have been priced at $7.
  if (!band) return matching.reduce((hi, t) => (t.fee > hi ? t.fee : hi), 0);
  return band.fee;
}

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
 * The weight of ONE supplier's parcel, not of the whole order (ERR-253).
 *
 * ***`supplier_freight.parcel_weight_kg` IS THE SUM ACROSS CONSIGNMENTS, AND
 * EACH CONSIGNMENT IS WEIGHED AND PRICED ON ITS OWN.*** Using the order-level
 * figure for every parcel is only right when there is one parcel, and it
 * overcharges the moment there are two.
 *
 * Caught by measurement, not by reading: after switching from the lightest band
 * to the matching band, 153 of 154 live orders agreed with the backend to the
 * cent and one did not — order 20260730000001, north-island, where Augmento
 * shipped 0.1 kg ($7, light band) and DSNZ shipped 2.0 kg ($12, standard band)
 * for $19. Pricing both parcels off the order's 2.1 kg total gave $12 x 2 =
 * $24. The error is invisible on every single-consignment order, which is 153
 * of them.
 *
 * Falls back to the order-level weight when the backend has no consignment for
 * this supplier — which is the correct behaviour for the single-parcel case the
 * fallback describes, and the honest one otherwise.
 */
export function consignmentWeightKg(order, supplierName) {
  const sf = order && typeof order.supplier_freight === 'object' ? order.supplier_freight : null;
  const list = sf && Array.isArray(sf.consignments) ? sf.consignments : null;
  const want = supplierSlug(supplierName);
  if (list && want) {
    const hit = list.find((c) => supplierSlug(c && c.supplier) === want);
    const kg = hit ? Number(hit.parcel_weight_kg) : NaN;
    if (Number.isFinite(kg) && kg >= 0) return kg;
  }
  const whole = sf ? Number(sf.parcel_weight_kg) : NaN;
  return Number.isFinite(whole) && whole >= 0 ? whole : null;
}

/** Did the customer pay for delivery on this order? Then it is a pass-through. */
function customerPaidFreight(order) {
  const fee = Number(order?.shipping_fee ?? order?.shipping_cost);
  return Number.isFinite(fee) && fee > 0;
}

/**
 * All-zero, never-applies result. `unknown` distinguishes "we decided no" from
 * "we could not decide", and only the second one may suppress a profit figure.
 */
function noFreight(extra = {}) {
  return {
    applies: false,
    unknown: false,
    unknownReason: null,
    amount_incl_gst: 0,
    estimated: false,
    suppliers: [],
    consignments: [],
    // Present-and-null, never absent: a reader that does `'deliveryType' in f`
    // must get the same answer on both shapes (ERR-199 — absent, null and a
    // value are three different things and two of them look alike).
    deliveryType: null,
    deliveryTypeBasis: null,
    parcelWeightKg: null,
    ...extra,
  };
}

/**
 * Decide the supplier freight for one order.
 *
 * @param {object} order   a FULL order from AdminAPI.getOrder (needs
 *        `delivery_zone`, `shipping_fee` and `shipping_absorbed`).
 * @param {object} sourcing the result of `orderSupplierCostFromDetail(order)` —
 *        its `costBySupplier`, `missingSupplierCount` and
 *        `mixedSupplierLineCount` are what this reasons over.
 * @returns {{applies:boolean, unknown:boolean, unknownReason:string|null,
 *   amount_incl_gst:number, estimated:boolean, suppliers:string[],
 *   consignments:Array<{supplier:string, slug:string, reason:string,
 *                       inclGst:number, estimated:boolean}>}}
 *
 * The return is shaped like `order.shipping_absorbed` so profitability.js can
 * parse it with the same convention as the absorbed courier.
 */
export function supplierFreightForOrder(order, sourcing) {
  if (!order || typeof order !== 'object') return noFreight();

  // THE DELIVERY FACTS BELONG TO THE ORDER, NOT TO THE FREIGHT DECISION.
  // Computed before any of the refusals below, and threaded through every one
  // of them: an order whose freight we decline to price still has a delivery
  // area, and the modal still has to say what it is. Reading them only on the
  // success path is how a field ends up null on the 13 orders where it is most
  // interesting (ERR-253).
  const facts = deliveryFactsForOrder(order);
  const none = (extra) => noFreight({
    deliveryType: facts.deliveryType,
    deliveryTypeBasis: facts.basis,
    parcelWeightKg: facts.weightKg,
    ...(extra || {}),
  });

  // The customer paid the courier, we paid the courier, it nets out. The engine
  // has always treated a charged delivery as a pass-through (revenue excludes
  // it, customerPaid includes it) and adding a cost on top would be charging
  // ourselves twice for one parcel.
  if (customerPaidFreight(order)) return none();

  const costBySupplier = (sourcing && sourcing.costBySupplier) || null;
  if (!costBySupplier || typeof costBySupplier !== 'object') {
    return none({ unknown: true, unknownReason: 'no per-supplier costs were resolved for this order' });
  }

  // A line with no supplier, or one naming several, cannot be put on either
  // side of a per-supplier threshold. Refuse the whole order rather than price
  // the part we happen to understand — a freight bill missing a consignment
  // reads exactly like an order that owed none.
  const missing = Number(sourcing.missingSupplierCount) || 0;
  const mixed = Number(sourcing.mixedSupplierLineCount) || 0;
  if (missing > 0 || mixed > 0) {
    const parts = [];
    if (missing) parts.push(`${missing} line${missing === 1 ? '' : 's'} name no supplier`);
    if (mixed) parts.push(`${mixed} line${mixed === 1 ? '' : 's'} name more than one supplier`);
    return none({ unknown: true, unknownReason: parts.join(' and ') });
  }

  const names = Object.keys(costBySupplier);
  if (!names.length) return none();

  // ── Which suppliers billed us for this delivery? ──────────────────────────
  const owed = [];
  for (const name of names) {
    const slug = supplierSlug(name);
    const rule = slug ? SUPPLIER_FREIGHT_RULES[slug] : null;
    if (!rule) {
      return none({
        unknown: true,
        unknownReason: `no freight terms recorded for ${supplierLabel(name) || 'an unnamed supplier'}`,
      });
    }
    const goods = Number(costBySupplier[name]);
    if (!Number.isFinite(goods)) {
      return none({ unknown: true, unknownReason: `the goods cost from ${name} could not be totalled` });
    }
    if (rule.alwaysPays) {
      owed.push({ supplier: name, slug, alwaysPays: true, reason: `${name} charges freight on every order` });
    } else if (Number.isFinite(rule.freeOverExGst) && goods < rule.freeOverExGst) {
      owed.push({
        supplier: name,
        slug,
        alwaysPays: false,
        reason: `${name} goods $${goods.toFixed(2)} ex-GST is under the $${rule.freeOverExGst} free-freight threshold`,
      });
    }
  }
  if (!owed.length) return none();

  // ── Drop what the backend has already charged ─────────────────────────────
  //
  // `order.shipping_absorbed` is the freight the backend already knows about,
  // and the order modal already deducts it as "Courier absorbed". Measured over
  // 60 live orders it is populated on 23 and EVERY ONE of those contains a DSNZ
  // line, while all six Augmento-only free-shipping orders get {applies:false}.
  // So it covers one consignment, and on this evidence it is the always-pays
  // supplier's. Charging that consignment again here would double it — the row
  // this module adds is for what the backend has NOT accounted for.
  const absorbed = order.shipping_absorbed;
  const absorbedApplies = !!absorbed && absorbed.applies === true
    && Number(absorbed.amount_incl_gst) > 0;
  let remaining = owed;
  if (absorbedApplies) {
    const idx = owed.findIndex((c) => c.alwaysPays);
    const drop = idx >= 0 ? idx : 0;
    remaining = owed.filter((_, i) => i !== drop);
  }
  if (!remaining.length) return none();

  // ── What does each remaining consignment cost? ────────────────────────────
  //
  // THE BAND, NOT THE FLOOR (ERR-253). This used to be
  // `lightestZoneRateInclGst(zone)` — the cheapest urban row — because neither
  // the weight nor the area was on the order. Both are now, so the rate is the
  // one this parcel actually falls in, and the $365 understatement measured
  // across 154 live orders goes with it.
  const zone = order.delivery_zone || (order.supplier_freight && order.supplier_freight.zone) || null;
  // Per-consignment, because each parcel is weighed on its own (see
  // consignmentWeightKg). `estimate` stays the order-level answer purely as the
  // "is this zone priceable at all" test below — it must not be the rate.
  const estimate = zoneRateInclGst(zone, facts.weightKg, facts.deliveryType);
  if (estimate == null) {
    return none({
      unknown: true,
      unknownReason: zone
        ? `no courier rate is known for the "${zone}" zone`
        : 'the order records no delivery zone, so no courier rate can be applied',
    });
  }

  const consignments = remaining.map((c) => ({
    supplier: c.supplier,
    slug: c.slug,
    reason: c.reason,
    inclGst: zoneRateInclGst(zone, consignmentWeightKg(order, c.supplier), facts.deliveryType) ?? estimate,
    // Always true today: the backend sends an amount only for the consignment
    // dropped above. The flag is here so it can go false the moment the brief
    // in supplier-freight-backend-brief-sep2026.md lands.
    estimated: true,
  }));

  return {
    applies: true,
    unknown: false,
    unknownReason: null,
    amount_incl_gst: consignments.reduce((sum, c) => sum + c.inclGst, 0),
    estimated: consignments.some((c) => c.estimated),
    suppliers: consignments.map((c) => c.supplier),
    consignments,
    // Carried so the modal can say WHICH band it priced and HOW it knows the
    // area, instead of printing the word "assumed" over 93 orders the backend
    // had settled exactly (ERR-253). `deliveryType: null` reaches the display
    // layer intact — it is "not recorded", never "urban".
    deliveryType: facts.deliveryType,
    deliveryTypeBasis: facts.basis,
    parcelWeightKg: facts.weightKg,
  };
}
