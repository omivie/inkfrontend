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

export const BULK_CAP = 200;

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

// ── POST /api/admin/pricing/bulk (live 2026-10-16, ERR-352) ──────────────────
// Contract MEASURED from the endpoint's own validation messages:
//   { target: { product_ids } | { filter }, action, value, lock, allow_decrease, dry_run }
//   action ∈ set | adjust_pct | adjust_abs | set_margin | clear_manual
//   filter must narrow the catalogue (is_active alone or an empty search is refused)
// dry_run answers { affected, unchanged, blocked_by_floor, blocked_by_no_decrease,
// sample[], packs, failed[] }. The backend does all price maths.
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
