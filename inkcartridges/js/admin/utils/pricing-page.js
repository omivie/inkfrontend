/**
 * Pure helpers for the admin Pricing page (pages/pricing.js) and the margin
 * column on the rules ladder (pages/cc2-pricing.js). ERR-336.
 *
 * DISPLAY CONVERSION ONLY. The backend stores a cost multiplier per band
 * (retail = cost × multiplier × 1.15, then rounded to an ending, then floors —
 * tier-multiplier contract §1). The owner thinks in GROSS margin on the sell
 * price ex GST: m = (priceExGst − cost) / priceExGst, so multiplier = 1/(1−m).
 * The figure is the margin BEFORE rounding and floors; the simulate preview is
 * what the shelf will actually show. This file never produces a retail price.
 */

// "Lock at current price" is the one write that stays a per-row PUT (each row
// keeps ITS OWN price; the bulk endpoint takes one value). Paced, so capped.
export const BULK_CAP = 200;
// POST /api/admin/pricing/bulk takes 1–2,000 ids per call (TARGET_TOO_LARGE above).
export const BULK_TARGET_CAP = 2000;

// Margin % (e.g. 40) → multiplier (1.6667). null for anything the backend could
// never accept: m < 0 would price below cost, m ≥ 100 has no finite multiplier.
export function multFromMargin(marginPct) {
  if (marginPct === '' || marginPct == null) return null;
  const m = Number(marginPct) / 100;
  if (!Number.isFinite(m) || m < 0 || m >= 1) return null;
  return Math.round((1 / (1 - m)) * 1000) / 1000;
}

// Multiplier → margin % (one decimal). null when there is no multiplier.
export function marginFromMult(mult) {
  const x = Number(mult);
  if (mult === '' || mult == null || !Number.isFinite(x) || x <= 0) return null;
  return Math.round((1 - 1 / x) * 1000) / 10;
}

// Page filters → /api/admin/products params. Only keys the endpoint accepts:
// it is strictQuery, and an unknown key is a 400 (ERR-286).
export function filtersToParams(f = {}) {
  const out = { active: f.active === '' || f.active == null ? 'all' : f.active };
  if (f.search) out.search = f.search;
  if (f.brand) out.brand = f.brand;
  if (f.source) out.source = f.source;
  if (f.type === 'ribbons') out.product_type_group = 'ribbons';
  else if (f.type) out.product_type = f.type;
  // Live since 2026-10-16 (measured): has_manual=true|false, and ranges on
  // cost (ex GST) and retail (incl GST). Exact names — min_price etc. are 400s.
  if (f.manual === 'true' || f.manual === 'false') out.has_manual = f.manual;
  for (const k of ['cost_min', 'cost_max', 'price_min', 'price_max']) {
    const v = f[k];
    if (v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = String(Number(v));
  }
  if (f.sort) { out.sort = f.sort; out.order = f.order || 'asc'; }
  return out;
}

// Lock-at-current-price plan. Copies the backend's own retail_price verbatim
// (no FE price maths). Already-locked rows are skipped, rows with no known
// price are refused — never sent as a guess.
export function lockPlan(ids, rowsById) {
  const send = [];
  const already = [];
  const noPrice = [];
  for (const id of ids) {
    const r = rowsById.get(String(id));
    if (r && r.has_manual_price === true) already.push(id);
    else if (!r || r.retail_price == null || !Number.isFinite(Number(r.retail_price)) || Number(r.retail_price) <= 0) noPrice.push(id);
    else send.push({ id, price: Number(r.retail_price) });
  }
  return { send, already, noPrice };
}

/**
 * Run `put(id)` over `ids` ONE AT A TIME (the admin API is rate-limited; a
 * parallel burst of 200 writes trips it). Returns all three outcomes — never a
 * bare "done": ok rows, failed rows with their message, and rows never tried
 * because the operator pressed Stop. A row whose write succeeded but whose
 * response does not carry the expected retail price is ok-but-`unapplied`, so
 * the UI can say "override saved, shelf price not updated yet" instead of
 * claiming a price change nobody measured.
 *
 * @param {string[]} ids
 * @param {(id:string)=>Promise<object|null>} put
 * @param {{expect?:number|null, onProgress?:Function, shouldStop?:()=>boolean}} opts
 */
export async function runSequential(ids, put, { expect = null, onProgress, shouldStop } = {}) {
  if (ids.length > BULK_CAP) {
    return { refused: true, reason: `${ids.length} selected — a run is capped at ${BULK_CAP}. Narrow the filter.`, ok: [], failed: [], notAttempted: [...ids] };
  }
  const ok = [];
  const failed = [];
  let i = 0;
  for (; i < ids.length; i++) {
    if (shouldStop && shouldStop()) break;
    const id = ids[i];
    try {
      const data = await put(id);
      const p = data && (data.product ? data.product.retail_price : data.retail_price);
      const unapplied = expect != null && !(p != null && Math.abs(Number(p) - expect) < 0.005);
      ok.push({ id, unapplied, retail_price: p ?? null });
    } catch (e) {
      failed.push({ id, message: (e && e.message) || 'Failed' });
    }
    if (onProgress) onProgress(i + 1, ids.length);
  }
  return { refused: false, ok, failed, notAttempted: ids.slice(i) };
}

// ── POST /api/admin/pricing/bulk (live, ERR-352 → wired ERR-363) ─────────────
// Contract: backend response 2026-10-17 "Admin Pricing page" §3, dry run
// re-measured 2026-10-18 (Brother compatible toner +5%: affected 68).
//   { target: { product_ids } | { filter }, action, value, lock, allow_decrease,
//     dry_run, confirm }   — dry_run defaults TRUE server-side; confirm:true is
//   required whenever dry_run is false (else 400 CONFIRM_REQUIRED).
//   action ∈ set | adjust_pct | adjust_abs | set_margin | clear_manual
//   filter must narrow the catalogue (is_active alone or an empty search is refused)
// dry_run answers { affected, unchanged, blocked_by_floor, blocked_by_no_decrease,
// sample[], packs, failed[] }; a write { updated, unchanged, failed[], … }.
// The backend does all price maths; packs are never repriced.
export const BULK_ACTIONS = ['set', 'adjust_pct', 'adjust_abs', 'set_margin', 'clear_manual'];

// Page filters → the bulk endpoint's target.filter. Only keys it validated by
// name; the ribbons group has no bulk equivalent, so it is REFUSED, never dropped
// (dropping it would widen the change to every product type).
export function bulkFilter(f = {}) {
  if (f.type === 'ribbons') return { error: 'The Ribbons group cannot be used for a bulk change yet. Pick a single product type.' };
  const out = {};
  if (f.search && f.search.trim()) out.search = f.search.trim();
  if (f.brand) out.brand = f.brand;
  if (f.source) out.source = f.source;
  if (f.type) out.product_type = f.type;
  if (f.manual === 'true' || f.manual === 'false') out.has_manual = f.manual === 'true';
  for (const k of ['cost_min', 'cost_max', 'price_min', 'price_max']) {
    const v = f[k];
    if (v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = Number(v);
  }
  if (!Object.keys(out).length) return { error: 'Narrow the filter first: the backend refuses a bulk change on the whole catalogue.' };
  if (f.active === 'true' || f.active === 'false') out.is_active = f.active === 'true';
  return { filter: out };
}

// One body for both the preview and the apply — they must never differ.
export function bulkBody({ action, value, lock = true, allowDecrease = false, ids = null, filters = null }) {
  if (!BULK_ACTIONS.includes(action)) return { error: `Unknown action ${action}` };
  let target;
  if (ids && ids.length > BULK_TARGET_CAP) {
    return { error: `${ids.length} products — one change covers at most ${BULK_TARGET_CAP.toLocaleString('en-NZ')}. Narrow the filter, or save the margin as a rule.` };
  }
  if (ids && ids.length) target = { product_ids: ids.map(String) };
  else {
    const bf = bulkFilter(filters || {});
    if (bf.error) return { error: bf.error };
    target = { filter: bf.filter };
  }
  const body = { target, action, lock: !!lock, allow_decrease: !!allowDecrease };
  if (action === 'clear_manual') {
    body.value = 0;
    body.lock = false;
  } else {
    const v = Number(value);
    if (value === '' || value == null || !Number.isFinite(v)) return { error: 'Enter a number.' };
    if (action === 'set' && v <= 0) return { error: 'Enter a price above $0.' };
    if (action === 'set_margin' && (v < 0 || v >= 100)) return { error: 'Margin must be at least 0% and below 100%.' };
    if (action === 'adjust_pct' && v <= -100) return { error: 'A cut of 100% or more would price at $0 or below.' };
    body.value = v;
  }
  return { body };
}

// ── Margin rules: GET|POST /api/admin/pricing/rules, PATCH|DELETE /:ruleId ────
// Contract: backend response 2026-10-17 §4; preview shape re-measured 2026-10-18.
// A POST/PATCH WITHOUT confirm is a preview (writes nothing). The backend stores
// multiplier = 1/(1−m); margins outside 4.77–80% are refused (multiplier 1.05–5).
export const RULE_MARGIN_MIN = 4.77;
export const RULE_MARGIN_MAX = 80;

// Form → rule body. A filter needs at least one key: a catalogue-wide margin
// is the tier ladder (EMPTY_RULE_FILTER), so it is refused here too.
export function ruleBody(form = {}) {
  const filter = {};
  if (form.brand) filter.brand = form.brand;
  if (form.source === 'genuine' || form.source === 'compatible') filter.source = form.source;
  if (form.product_type === 'ribbons') return { error: 'A rule takes one product type, not the Ribbons group (ribbons have their own ladder).' };
  if (form.product_type) filter.product_type = form.product_type;
  if (form.category && String(form.category).trim()) filter.category = String(form.category).trim().toUpperCase();
  const band = {};
  for (const [k, out] of [['cost_min', 'min'], ['cost_max', 'max']]) {
    const v = form[k];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: 'Cost band must be a number of dollars (ex GST), 0 or more.' };
    band[out] = n;
  }
  if (band.min != null && band.max != null && band.min > band.max) return { error: 'Cost band: "from" is above "to".' };
  if (Object.keys(band).length) filter.cost_band = { min: band.min ?? null, max: band.max ?? null };
  if (!Object.keys(filter).length) return { error: 'Pick at least one of brand, source, type, category or cost band. A margin for the whole catalogue is the ladder below.' };
  const m = Number(form.margin_pct);
  if (form.margin_pct === '' || form.margin_pct == null || !Number.isFinite(m) || m < RULE_MARGIN_MIN || m > RULE_MARGIN_MAX) {
    return { error: `Margin must be between ${RULE_MARGIN_MIN}% and ${RULE_MARGIN_MAX}%.` };
  }
  const body = { filter, margin_pct: m, allow_decrease: !!form.allow_decrease };
  const pr = Number(form.priority);
  if (form.priority !== '' && form.priority != null && Number.isInteger(pr)) body.priority = pr;
  if (form.notes && String(form.notes).trim()) body.notes = String(form.notes).trim();
  return { body };
}

// One-line description of a stored rule's filter (GET rows carry brand {slug,name}).
export function ruleSummary(rule = {}, labelType = (t) => t) {
  const f = rule.filter || rule;
  const parts = [];
  const brand = (rule.brand && (rule.brand.name || rule.brand.slug)) || f.brand_name || null;
  if (brand) parts.push(brand);
  else if (f.brand_id || f.brand) parts.push('1 brand');
  if (f.source) parts.push(f.source);
  if (f.product_type) parts.push(labelType(f.product_type));
  if (f.category) parts.push(f.category);
  const band = f.cost_band || { min: f.cost_min, max: f.cost_max };
  if (band && (band.min != null || band.max != null)) {
    parts.push(`cost ${band.min != null ? `$${band.min}` : '$0'}–${band.max != null ? `$${band.max}` : 'any'}`);
  }
  return parts.length ? parts.join(' · ') : 'every product';
}

// Where a row's price comes from (`price_source`, backend 2026-10-17 §1).
// `has_manual_price` true with no manual price = an older freeze: still locked.
export const PRICE_SOURCE_LABEL = {
  manual: 'Manual (locked)',
  filter_rule: 'Margin rule',
  brand_rule: 'Brand ladder',
  catalogue: 'Catalogue band',
  default: 'Default ladder',
  pack: 'Pack (follows its singles)',
  ribbon: 'Ribbon ladder',
};
export function priceSourceOf(r = {}) {
  if (r.has_manual_price === true) return { kind: 'manual', label: PRICE_SOURCE_LABEL.manual, lockable: false };
  const src = r.price_source;
  if (!src || !PRICE_SOURCE_LABEL[src]) return { kind: 'unknown', label: 'unknown', lockable: false };
  const label = src === 'filter_rule' && r.price_rule_id
    ? `${PRICE_SOURCE_LABEL.filter_rule} #${String(r.price_rule_id).slice(0, 8)}`
    : PRICE_SOURCE_LABEL[src];
  // Packs follow their singles and the bulk endpoint never prices them.
  return { kind: src, label, lockable: src !== 'pack' };
}

// Minimum unit profit floor (backend reply 2026-10-25 §1). The backend owns
// the number: GET /pricing/tier-multipliers returns
// `min_unit_profit: { ex_gst, applies_to, measured_as }`. It is fixed in code
// server-side, so the page only prints it. Absent or malformed ⇒ state
// 'absent' and no text — never a typed-in $2.50 standing in for the server.
export function minUnitProfitLine(mup) {
  const v = mup && typeof mup === 'object' ? Number(mup.ex_gst) : NaN;
  if (!Number.isFinite(v) || v <= 0) return { state: 'absent', text: '' };
  // `applies_to` is the backend's own sentence (live 2026-10-26: "compatible
  // consumables (not receipt rolls) and ribbons, unless a pricing rule or
  // manual price sets the price"), so it is printed as written, never parsed.
  const scope = typeof mup.applies_to === 'string' && mup.applies_to.trim()
    ? ` Applies to ${mup.applies_to.trim().replace(/[.\s]+$/, '')}.` : '';
  return {
    state: 'ok',
    text: `Minimum $${v.toFixed(2)} profit per unit, ex GST, after the card fee.${scope} Fixed in code; not editable here.`,
    measuredAs: typeof mup.measured_as === 'string' ? mup.measured_as : '',
  };
}
