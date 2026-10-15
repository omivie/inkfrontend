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
  if (f.sort) { out.sort = f.sort; out.order = f.order || 'asc'; }
  return out;
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
