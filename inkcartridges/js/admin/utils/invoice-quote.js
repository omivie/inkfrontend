/**
 * Invoice quote — reading `POST /api/admin/invoices/quote`.
 *
 * The backend prices two things the operator used to guess at: the courier fee
 * for a parcel, and the per-line volume discount the website has given every
 * shopper (guests included) since Aug 2026. This module is the whole decision
 * layer for both, kept free of the DOM so it can be unit-tested and so the
 * Invoices editor and the Quick Order editor cannot drift apart.
 *
 * THREE RULES, in descending order of how expensive they are to get wrong:
 *
 *   1. EVERYTHING HERE IS ADVISORY. The endpoint is read-only and nothing about
 *      POST/PUT /api/admin/invoices changed. The operator's typed price and the
 *      freight box remain authoritative at save. A quote that fails, rate-limits
 *      or arrives late must leave the draft exactly as the operator left it.
 *
 *   2. WE DO NOT COMPUTE PRICES. The response carries the finished figure for
 *      each line; there is no ladder interpreter in the admin and there must
 *      never be one. `js/business.js` owns that on the storefront and the admin
 *      shell does not even load it. Read `volume.unit_excl_gst` verbatim.
 *
 *   3. NEVER OVERWRITE A HAND-EDITED PRICE. Tracked per line as
 *      `priceSource: 'auto' | 'manual'`, deliberately mirroring the existing
 *      `costSource` idiom so there is one shape to learn. "Hand-edited" is wider
 *      than "typed just now": a SAVED invoice's prices and prices pulled off a
 *      real ORDER are also operator-authored history, and re-pricing them from
 *      today's ladder would silently rewrite what a customer was charged.
 *
 * Absence is never zero. A missing `options` array means "we could not read the
 * rates", which is a different thing from `[]` meaning "there are no rates" —
 * collapsing the two is the ERR-063/068/149 failure this codebase keeps paying
 * for. Same for `volume: null`, which means "no discount applies", and a missing
 * `volume` key on an unresolved line, which means "we do not know yet".
 */

const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (s) => String(s ?? '').trim();

/** The endpoint accepts 1–200 line items. */
export const MAX_QUOTE_LINES = 200;

/** Per-line price provenance. Mirrors costSource in the two editors. */
export const PRICE_AUTO = 'auto';
export const PRICE_MANUAL = 'manual';

/**
 * The two editors name the ex-GST sell price differently — Invoices calls it
 * `unitCost` (it is the "Cost (excl. GST)" column printed on the customer's
 * invoice), Quick Order calls it `unitPrice`. Both are the same number, and
 * invoice-math.js already reads them with the same `??` pair. Read and write
 * through these two helpers so nothing else has to know.
 */
export function linePrice(line) {
  return num(line?.unitCost ?? line?.unitPrice);
}

export function withLinePrice(line, value) {
  const key = (line && line.unitPrice !== undefined && line.unitCost === undefined) ? 'unitPrice' : 'unitCost';
  return { ...line, [key]: round2(value) };
}

/** A line the operator has actually put something in. */
const hasContent = (l) => !!(str(l?.code) || str(l?.description));

// =========================================================================
//  Request
// =========================================================================

/**
 * NZ regions, in the spelling the endpoint's `delivery.region` example uses.
 * Same 16 regions as `js/shipping.js:46-63` — that file is the storefront's
 * zone vocabulary and this hint feeds the same backend concept, so the two must
 * not invent different names for the same place.
 */
const NZ_REGIONS = [
  'Auckland', 'Northland', 'Waikato', 'Bay of Plenty', 'Gisborne', "Hawke's Bay",
  'Taranaki', 'Manawatu-Wanganui', 'Wellington', 'Tasman', 'Nelson', 'Marlborough',
  'West Coast', 'Canterbury', 'Otago', 'Southland',
];

// "Hawkes Bay" / "Hawke's Bay" / "Manawatu-Whanganui" all mean the same place to
// a person typing an address, and none of them are worth a wrong preselection.
// NB the apostrophe class covers the typographic ’ as well as the ASCII ' —
// pasting an address out of Word or a browser autofill routinely yields the
// curly one, and it is the commonest spelling of the only region that has one.
const REGION_ALIASES = [
  [/\bhawke['’]?s?\s+bay\b/i, "Hawke's Bay"],
  [/\bmanawatu[-\s]?(?:wh)?anganui\b/i, 'Manawatu-Wanganui'],
  [/\bbay\s+of\s+plenty\b/i, 'Bay of Plenty'],
  [/\bwest\s+coast\b/i, 'West Coast'],
];

/**
 * Best-effort delivery hint scraped from the address the operator already typed.
 *
 * This ONLY steers which option is preselected — every zone option is returned
 * regardless, so a wrong guess costs one click and can never produce a wrong
 * price. That is why a heuristic is acceptable here and would not be anywhere
 * near the money.
 *
 * The postcode is taken as the LAST standalone 4-digit token, because NZ
 * addresses put it last and street numbers ("1234 Great North Road") come
 * first. Rural delivery is inferred from the "RD 2" convention.
 *
 * @param {object} draft
 * @returns {{postal_code?:string, region?:string, delivery_type:string}|null}
 */
export function deliveryHintFromDraft(draft) {
  const delivery = str(draft?.delivery?.address);
  const customer = str(draft?.customer?.address);
  const text = delivery || customer;
  if (!text) return null;

  const hint = {};

  const codes = text.match(/(?<![\d-])\d{4}(?![\d-])/g);
  if (codes && codes.length) hint.postal_code = codes[codes.length - 1];

  for (const [re, name] of REGION_ALIASES) {
    if (re.test(text)) { hint.region = name; break; }
  }
  if (!hint.region) {
    // Longest name first so "Bay of Plenty" cannot be beaten by a bare match.
    const byLength = [...NZ_REGIONS].sort((a, b) => b.length - a.length);
    for (const name of byLength) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) { hint.region = name; break; }
    }
  }

  hint.delivery_type = /\brd\s*\d\b|\brural\b|\brural\s+delivery\b/i.test(text) ? 'rural' : 'urban';
  return hint;
}

/**
 * Build the request body from the editor draft.
 *
 * Sends EVERY line, blank ones included, because the response indexes back by
 * `position` and the contract is "same order, same length". Filtering here would
 * silently shift every badge one row up the moment a blank line sat in the middle.
 *
 * The typed price is sent ONLY for hand-edited lines. The backend uses it for
 * the free-shipping goods-total check, so sending our own autofilled figure back
 * would just be quoting ourselves; omitting it on untouched lines is what the
 * brief asks for and keeps a deliberate override honoured.
 *
 * @returns {{body:object, truncated:number}|null} null when there is nothing to quote
 */
export function quoteRequestBody(draft) {
  const all = Array.isArray(draft?.lines) ? draft.lines : [];
  if (!all.length) return null;
  // Nothing typed anywhere: a quote would only tell us the zone options, and the
  // editor already has those from the previous call. Skip the request.
  if (!all.some(hasContent)) return null;

  const kept = all.slice(0, MAX_QUOTE_LINES);
  const line_items = kept.map((l) => {
    const item = {
      product_code: str(l?.code),
      description: str(l?.description),
      quantity: num(l?.qty),
    };
    if (l?.priceSource === PRICE_MANUAL) {
      const price = linePrice(l);
      if (price >= 0) item.unit_cost_excl_gst = round2(price);
    }
    return item;
  });

  const body = { line_items };
  const hint = deliveryHintFromDraft(draft);
  if (hint) body.delivery = hint;

  return { body, truncated: all.length - kept.length };
}

// =========================================================================
//  Response
// =========================================================================

/**
 * Tolerant unwrap of the response into the shape the editor consumes.
 *
 * Returns null for anything unrecognisable — the caller then keeps its previous
 * quote and SAYS the rates are unavailable, rather than painting an empty
 * dropdown that reads as "no shipping options exist".
 *
 * `shipping.options` absent and `shipping.options: []` are kept distinct via
 * `hasOptions`, for the same reason `Business.ingest` distinguishes a missing
 * `quantity_breaks` from an empty one.
 */
export function normalizeQuote(payload) {
  const data = payload?.data ?? payload;
  if (!data || typeof data !== 'object') return null;

  const rawLines = Array.isArray(data.lines) ? data.lines : null;
  const rawShipping = (data.shipping && typeof data.shipping === 'object') ? data.shipping : null;
  if (!rawLines && !rawShipping) return null;

  const lines = (rawLines || []).map((l, i) => ({
    position: Number.isFinite(Number(l?.position)) ? Number(l.position) : i,
    inputCode: l?.input_code ?? null,
    productCode: l?.product_code ?? null,
    resolved: l?.resolved === true,
    reason: l?.reason ?? null,
    name: l?.name ?? '',
    source: l?.source ?? null,
    isActive: l?.is_active !== false,
    quantity: num(l?.quantity),
    retailInclGst: l?.retail_incl_gst != null ? num(l.retail_incl_gst) : null,
    unitExclGst: l?.unit_excl_gst != null ? num(l.unit_excl_gst) : null,
    volume: normalizeVolume(l?.volume),
  }));

  const hasOptions = Array.isArray(rawShipping?.options);
  const shipping = rawShipping ? {
    hasOptions,
    options: hasOptions ? rawShipping.options.map(normalizeOption).filter(Boolean) : [],
    weightKg: rawShipping.weight_kg != null ? num(rawShipping.weight_kg) : null,
    goodsTotalInclGst: rawShipping.goods_total_incl_gst != null ? num(rawShipping.goods_total_incl_gst) : null,
    freeShippingThreshold: rawShipping.free_shipping_threshold != null ? num(rawShipping.free_shipping_threshold) : null,
    freeShippingEligible: rawShipping.free_shipping_eligible === true,
    suggestedKey: rawShipping.suggested_key ?? null,
  } : { hasOptions: false, options: [], weightKg: null, goodsTotalInclGst: null, freeShippingThreshold: null, freeShippingEligible: false, suggestedKey: null };

  return { lines, shipping };
}

function normalizeOption(o) {
  const key = str(o?.key);
  if (!key) return null;
  return {
    key,
    label: str(o?.label) || key,
    zone: o?.zone ?? null,
    zoneLabel: o?.zone_label ?? null,
    deliveryType: o?.delivery_type ?? null,
    tier: o?.tier ?? null,
    feeInclGst: o?.fee_incl_gst != null ? num(o.fee_incl_gst) : null,
    // THE figure that goes into the invoice's freight field. Already ex-GST —
    // do NOT divide it again (the fill-from-order path at invoices.js does
    // divide, because an order's shipping_fee is GST-INCLUSIVE; this is not).
    freightExclGst: round2(num(o?.freight_excl_gst)),
  };
}

/**
 * `volume: null` is a real answer — "no discount at this quantity" — and must
 * stay null rather than becoming a zero-percent object that would render a
 * "−0%" badge beside a full-price line.
 */
function normalizeVolume(v) {
  if (!v || typeof v !== 'object') return null;
  return {
    // The ladder rung's ceiling. Kept for completeness; never displayed.
    discountPercent: v.discount_percent != null ? num(v.discount_percent) : null,
    // What was actually realised after the margin-floor clamp. THIS is the one
    // that may be displayed — see effectivePercent() below.
    effectivePercent: v.effective_percent != null ? num(v.effective_percent) : null,
    unitInclGst: v.unit_incl_gst != null ? num(v.unit_incl_gst) : null,
    unitExclGst: v.unit_excl_gst != null ? num(v.unit_excl_gst) : null,
    perUnitSavingExclGst: v.per_unit_saving_excl_gst != null ? num(v.per_unit_saving_excl_gst) : null,
    lineSavingExclGst: v.line_saving_excl_gst != null ? num(v.line_saving_excl_gst) : null,
    floored: v.floored === true,
  };
}

/**
 * ALWAYS the effective percent, never the ladder ceiling.
 *
 * `discount_percent` is what the rung offers; `effective_percent` is what the
 * margin floor actually allowed. When they differ the price charged is the
 * floored one, so quoting the ceiling anywhere — badge, invoice, email — states
 * a discount the customer did not get. This is the standing rule for every B2B
 * surface (project_business_account_pricing_jul2026), not a preference.
 */
export function effectivePercent(volume) {
  if (!volume) return null;
  const pct = volume.effectivePercent != null ? volume.effectivePercent : volume.discountPercent;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Format a percent for display: 6 → "6%", 0.5 → "0.5%", 0.03 → "<0.1%".
 *
 * A DELIBERATE PORT of Business.formatPercent (js/business.js). business.js is a
 * `window` global loaded by the storefront pages; the admin shell loads none of
 * it, and adding a 53 KB script tag to import one five-line formatter is the
 * wrong trade. tests/admin-invoice-quote-aug2026.test.js executes BOTH versions
 * over the same inputs and fails if they ever disagree, so this copy cannot
 * quietly drift from the original.
 *
 * "<0.1%" and not "": an empty string is falsy, every badge renderer's ternary
 * reads that as "no percent to show", and a badge silently missing from a real
 * discount is the absence-reads-as-zero failure (ERR-063/068/139). The 0.5%
 * entry rung plus the margin floor makes sub-0.05% reachable.
 */
export function formatVolumePercent(pct) {
  if (!Number.isFinite(pct)) return '';
  const rounded = Math.round(pct * 10) / 10;
  if (pct > 0 && rounded === 0) return '<0.1%';
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

/**
 * The operator-facing badge for one quoted line, or null when there is nothing
 * to say.
 *
 * @returns {{percent:number, percentText:string, wasPrice:number, unitPrice:number,
 *            perUnitSaving:number, lineSaving:number, floored:boolean}|null}
 */
export function volumeBadge(quoteLine) {
  const v = quoteLine?.volume;
  if (!v || v.unitExclGst == null) return null;
  const pct = effectivePercent(v);
  // A rung that floored all the way back to retail is not a discount. Saying
  // "−0%" beside the full price would be worse than saying nothing.
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return {
    percent: pct,
    percentText: formatVolumePercent(pct),
    wasPrice: quoteLine.unitExclGst != null ? quoteLine.unitExclGst : null,
    unitPrice: v.unitExclGst,
    perUnitSaving: v.perUnitSavingExclGst ?? null,
    lineSaving: v.lineSavingExclGst ?? null,
    floored: v.floored === true,
  };
}

// =========================================================================
//  Applying a quote to the draft's lines
// =========================================================================

/**
 * Decide what a quote does to the editor's lines. Pure: returns new line
 * objects, never mutates the ones passed in.
 *
 * `applied` lists the positions whose price we changed (so the caller can
 * re-render and, if it likes, say so). `offers` lists positions where a better
 * volume price exists but the operator has hand-edited the price — those get an
 * "apply volume price" affordance instead of being overwritten.
 *
 * The volume facts are stamped onto the line (`volumePercent`, `volumeSaving`,
 * `volumeQuantity`) because they are what the customer-facing document prints.
 * They are cleared whenever we are NOT the author of the price — we must never
 * print "6% off" beside a number we did not compute.
 *
 * @param {Array} lines  draft lines
 * @param {object} quote normalizeQuote() output
 * @returns {{lines:Array, applied:number[], offers:Array, changed:boolean}}
 */
export function applyQuoteToLines(lines, quote) {
  const src = Array.isArray(lines) ? lines : [];
  const byPosition = new Map();
  for (const ql of (quote?.lines || [])) byPosition.set(ql.position, ql);

  const applied = [];
  const offers = [];
  let changed = false;

  const next = src.map((line, i) => {
    const ql = byPosition.get(i);

    // No answer for this row (mid-typing, blank, or the quote is older than the
    // row). Leave it completely alone — including any badge it already carries,
    // which still describes the price currently in the box.
    if (!ql) return line;

    // Unknown or half-typed code. NOT an error and NOT a toast: the operator may
    // be three characters into a SKU. The hard gate is verifyLineCodes() at save.
    if (!ql.resolved) {
      if (line.volumePercent == null && line.volumeSaving == null) return line;
      changed = true;
      return clearVolume(line);
    }

    const badge = volumeBadge(ql);
    const target = badge ? badge.unitPrice : ql.unitExclGst;

    if (line.priceSource === PRICE_MANUAL) {
      // Hand-edited: never overwrite. Offer the volume price instead, and only
      // when it would actually change the number in the box.
      if (badge && round2(linePrice(line)) !== round2(badge.unitPrice)) {
        offers.push({ position: i, badge });
      }
      // The badge on a hand-edited line would be a claim about a price we did
      // not set, so it goes.
      if (line.volumePercent != null || line.volumeSaving != null) {
        changed = true;
        return clearVolume(line);
      }
      return line;
    }

    if (target == null) return line;

    const priceChanged = round2(linePrice(line)) !== round2(target);
    const badgeChanged = (line.volumePercent ?? null) !== (badge ? badge.percent : null)
      || (line.volumeSaving ?? null) !== (badge ? badge.lineSaving : null);
    if (!priceChanged && !badgeChanged) return line;

    changed = true;
    if (priceChanged) applied.push(i);

    const out = withLinePrice(line, target);
    out.priceSource = PRICE_AUTO;
    if (badge) {
      out.volumePercent = badge.percent;
      out.volumeSaving = badge.lineSaving;
      out.volumeQuantity = ql.quantity;
    } else {
      out.volumePercent = null;
      out.volumeSaving = null;
      out.volumeQuantity = null;
    }
    return out;
  });

  return { lines: next, applied, offers, changed };
}

/** Strip a volume claim from a line without touching its price. */
export function clearVolume(line) {
  return { ...line, volumePercent: null, volumeSaving: null, volumeQuantity: null };
}

/**
 * The customer-facing sub-line printed under a description on the invoice
 * document, or '' when the line carries no discount we authored.
 *
 * Deliberately says the rung ("at 7+"), not just the percent — an invoice is a
 * document someone reads months later, and "6% off" alone does not explain
 * itself. Wording matches the storefront's "Buy 3+" vocabulary
 * (Business.breakLabel) so the counter and the website say the same thing.
 */
export function lineDocNote(line) {
  const pct = Number(line?.volumePercent);
  if (!Number.isFinite(pct) || pct <= 0) return '';
  const qty = Number(line?.volumeQuantity);
  const at = Number.isFinite(qty) && qty > 0 ? ` at ${qty}+` : '';
  return `Bulk price — ${formatVolumePercent(pct)} off${at}`;
}

// =========================================================================
//  Shipping selection
// =========================================================================

/** The key used when the freight box holds a number no option offers. */
export const FREIGHT_CUSTOM = 'custom';

/**
 * WHO last wrote the number in the freight box.
 *
 * `_freightChoice` used to carry this meaning as well as "which option should the
 * dropdown show", and conflating the two was ERR-178: the very first quote of a
 * session fires on a code or description ALONE (`hasContent` below is not about
 * price), so it routinely lands with a goods total of $0 or a half-typed one —
 * typing `99` passes through `9`. The backend correctly suggests a courier rate
 * for that total, we adopted it, and we recorded it in the field that means "the
 * operator chose this". Every later quote then skipped the adopt branch, so an
 * order that crossed the free-shipping threshold could only ever be offered a
 * nudge, and a qualifying invoice went out with freight on it.
 *
 * The distinction the code actually needs is provenance, not presence:
 *   - OUR number follows the quote, including down to $0, and says so out loud.
 *   - THEIRS is never touched — they may be charging freight on purpose, which is
 *     why `freeShippingAvailable()` below still only ever offers.
 */
export const FREIGHT_OWNER_NONE = 'none';         // blank draft; nobody has written freight
export const FREIGHT_OWNER_AUTO = 'auto';         // we adopted the backend's suggestion
export const FREIGHT_OWNER_OPERATOR = 'operator'; // picked, typed, loaded, or billed as a line

/**
 * Work out which shipping option the dropdown should be showing.
 *
 * `choice` is the operator's explicit pick this session (null when they have not
 * picked). `freight` is whatever is in the freight box right now, which is the
 * only durable record — the chosen option is NOT stored on the invoice, because
 * buildPayload's key set is walked by the paid-toggle's full-record PUT and
 * diffed by documentDrift(), so adding a key there has consequences well beyond
 * this feature.
 *
 * Deriving from the value alone is ambiguous exactly once: `pickup` and `free`
 * both cost $0. A stored zero resolves to `free` when the order qualifies (the
 * commoner case, and the one the operator most likely meant) and `pickup`
 * otherwise.
 *
 * @returns {{key:string, option:object|null, isCustom:boolean, available:boolean}}
 */
export function resolveShippingSelection(shipping, { choice = null, freight = 0 } = {}) {
  const options = shipping?.options || [];
  if (!shipping?.hasOptions || !options.length) {
    return { key: FREIGHT_CUSTOM, option: null, isCustom: true, available: false };
  }

  if (choice === FREIGHT_CUSTOM) {
    return { key: FREIGHT_CUSTOM, option: null, isCustom: true, available: true };
  }

  if (choice) {
    const picked = options.find((o) => o.key === choice);
    if (picked) return { key: picked.key, option: picked, isCustom: false, available: true };
    // The pick is gone (see freeShippingLost). Fall through to derivation rather
    // than showing a selection that no longer exists.
  }

  const value = round2(num(freight));
  const matches = options.filter((o) => round2(o.freightExclGst) === value);
  if (!matches.length) {
    return { key: FREIGHT_CUSTOM, option: null, isCustom: true, available: true };
  }
  if (matches.length === 1) {
    return { key: matches[0].key, option: matches[0], isCustom: false, available: true };
  }
  const preferred = matches.find((o) => o.key === 'free') || matches.find((o) => o.key === 'pickup') || matches[0];
  return { key: preferred.key, option: preferred, isCustom: false, available: true };
}

/**
 * Did a re-quote take away the free-shipping option the operator had selected?
 *
 * This is the one shipping change that MUST be loud. The goods total dropping
 * under the threshold silently leaves $0 in the freight box, and a courier
 * parcel goes out billed at nothing. Fail-soft has to be visible in the return
 * value AND the UI, not just survivable (feedback_fail_soft_must_be_loud).
 *
 * @returns {{lost:boolean, fallbackKey:string|null, fallbackOption:object|null}}
 */
export function freeShippingLost(choice, shipping) {
  if (choice !== 'free') return { lost: false, fallbackKey: null, fallbackOption: null };
  const options = shipping?.options || [];
  if (!shipping?.hasOptions) return { lost: false, fallbackKey: null, fallbackOption: null };
  if (options.some((o) => o.key === 'free')) return { lost: false, fallbackKey: null, fallbackOption: null };

  const suggested = shipping.suggestedKey && options.find((o) => o.key === shipping.suggestedKey);
  const fallback = suggested || options.find((o) => o.key !== 'pickup') || options[0] || null;
  return { lost: true, fallbackKey: fallback ? fallback.key : null, fallbackOption: fallback };
}

/**
 * Free shipping has become available while a paid option is selected. Unlike the
 * case above this is NOT applied automatically — the operator may be invoicing a
 * courier charge on purpose, and overwriting their number to be helpful is how
 * you lose their trust in every other autofill on the page.
 */
export function freeShippingAvailable(choice, shipping) {
  if (!shipping?.hasOptions) return false;
  if (choice === 'free' || choice === 'pickup') return false;
  const free = (shipping.options || []).find((o) => o.key === 'free');
  if (!free) return false;
  return shipping.freeShippingEligible === true;
}

/**
 * What should the freight box hold after this quote, given who last wrote it?
 *
 * This is the ERR-178 fix and the counterpart to `freeShippingAvailable()` above:
 * that function answers "may we OFFER free shipping", this one answers "may we
 * APPLY the backend's current suggestion". The two differ on exactly one input —
 * ownership — and nothing else about the offer path changes.
 *
 * Rules, in order:
 *   1. No options ⇒ nothing to say. A quote that could not price freight must not
 *      silently zero it (`hasOptions` is the absent-vs-empty distinction).
 *   2. OPERATOR-owned ⇒ never apply. Their number stands; they get the nudge.
 *   3. AUTO-owned ⇒ re-adopt whenever `suggestedKey` has moved. Crossing the
 *      threshold is the case that matters: `free` arrives and the courier rate WE
 *      guessed at $0 goods is withdrawn.
 *   4. Unowned + an untouched $0 box ⇒ first adoption, which is the pre-ERR-178
 *      behaviour unchanged, except that it now returns AUTO rather than passing
 *      itself off as an operator pick.
 *
 * `announce` names a crossing, not merely a change: it is null when one paid zone
 * replaces another (a delivery-address edit re-quoting from Auckland to rural,
 * say), because the freight box is on screen and re-labelling it is not news. It
 * is set when money changed hands direction — free arrived, or free was withdrawn
 * — which the caller must surface visibly (feedback_fail_soft_must_be_loud).
 *
 * @returns {{apply:boolean, key:string|null, option:object|null,
 *            owner:string, announce:null|'free'|'courier'}}
 */
export function planFreightAutofill(shipping, { owner = FREIGHT_OWNER_NONE, choice = null, freight = 0 } = {}) {
  const none = { apply: false, key: null, option: null, owner, announce: null };
  if (!shipping?.hasOptions) return none;

  const options = shipping.options || [];
  if (!options.length) return none;
  if (owner === FREIGHT_OWNER_OPERATOR) return none;

  const suggested = options.find((o) => o.key === shipping.suggestedKey) || null;
  if (!suggested) return none;

  if (owner === FREIGHT_OWNER_AUTO) {
    if (suggested.key === choice) return none;
    const announce = suggested.key === 'free' ? 'free' : (choice === 'free' ? 'courier' : null);
    return { apply: true, key: suggested.key, option: suggested, owner: FREIGHT_OWNER_AUTO, announce };
  }

  // FREIGHT_OWNER_NONE — only ever onto an untouched empty box.
  if (round2(num(freight)) !== 0) return none;
  return { apply: true, key: suggested.key, option: suggested, owner: FREIGHT_OWNER_AUTO, announce: null };
}

/**
 * "$6.15 more (incl GST) for free shipping", or '' when we cannot say.
 *
 * `goodsTotalInclGst` and `freeShippingThreshold` were parsed by `normalizeQuote`
 * and read by nothing until ERR-178. Printing the figure is the whole point: the
 * freight box and the courier dropdown beside this note are labelled ex-GST while
 * the threshold is judged on the GST-INCLUSIVE goods total, and a row that mixes
 * two bases without naming either is what made correct behaviour read as a GST
 * bug. Returns '' rather than a guess when either number is absent.
 */
export function freeShippingGapNote(shipping) {
  const goods = shipping?.goodsTotalInclGst;
  const threshold = shipping?.freeShippingThreshold;
  if (goods == null || threshold == null || !(threshold > 0)) return '';
  if (shipping.freeShippingEligible === true) return '';
  const gap = round2(threshold - goods);
  if (!(gap > 0)) return '';
  return `$${gap.toFixed(2)} more (incl GST) for free shipping`;
}

/**
 * "parcel ≈ 0.7 kg" — with the truth attached when it is only part of the parcel.
 *
 * Weight comes from resolved products only, so an unknown code contributes
 * nothing. Printing the bare number then quietly under-states the parcel, and an
 * under-stated parcel is an under-charged courier. Say which lines were not
 * counted rather than rounding the doubt away.
 */
export function parcelWeightNote(quote) {
  const kg = quote?.shipping?.weightKg;
  if (kg == null) return '';
  const uncounted = (quote?.lines || []).filter((l) => !l.resolved && (l.inputCode || '').trim()).length;
  const base = `parcel ≈ ${round2(kg)} kg`;
  if (!uncounted) return base;
  return `${base} — ${uncounted} unrecognised ${uncounted === 1 ? 'code is' : 'codes are'} not counted`;
}
