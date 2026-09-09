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
 * This is a floor, and every caller must label it as one. Neither the parcel
 * weight nor urban/rural is on the order payload (measured 2026-09-09: admin
 * `products` has no weight column, order items have none, and `delivery_type`
 * appears only INSIDE `shipping_absorbed`, i.e. only once the backend has
 * already decided the cost). A comparable measured south-island 0.5 kg parcel
 * was charged $12 against this function's $7, so the understatement is real and
 * the fix is the backend sending its own figure — see the ERR-241 brief.
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

  // The customer paid the courier, we paid the courier, it nets out. The engine
  // has always treated a charged delivery as a pass-through (revenue excludes
  // it, customerPaid includes it) and adding a cost on top would be charging
  // ourselves twice for one parcel.
  if (customerPaidFreight(order)) return noFreight();

  const costBySupplier = (sourcing && sourcing.costBySupplier) || null;
  if (!costBySupplier || typeof costBySupplier !== 'object') {
    return noFreight({ unknown: true, unknownReason: 'no per-supplier costs were resolved for this order' });
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
    return noFreight({ unknown: true, unknownReason: parts.join(' and ') });
  }

  const names = Object.keys(costBySupplier);
  if (!names.length) return noFreight();

  // ── Which suppliers billed us for this delivery? ──────────────────────────
  const owed = [];
  for (const name of names) {
    const slug = supplierSlug(name);
    const rule = slug ? SUPPLIER_FREIGHT_RULES[slug] : null;
    if (!rule) {
      return noFreight({
        unknown: true,
        unknownReason: `no freight terms recorded for ${supplierLabel(name) || 'an unnamed supplier'}`,
      });
    }
    const goods = Number(costBySupplier[name]);
    if (!Number.isFinite(goods)) {
      return noFreight({ unknown: true, unknownReason: `the goods cost from ${name} could not be totalled` });
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
  if (!owed.length) return noFreight();

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
  if (!remaining.length) return noFreight();

  // ── What does each remaining consignment cost? ────────────────────────────
  const zone = order.delivery_zone;
  const estimate = lightestZoneRateInclGst(zone);
  if (estimate == null) {
    return noFreight({
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
    inclGst: estimate,
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
  };
}
