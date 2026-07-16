/**
 * Product-codes shared helpers.
 *
 * Product codes are the /shop drilldown chips (CI3, PG40/CL41 …). Two admin
 * surfaces edit them — the per-product drawer tab (pages/products.js) and the
 * per-code page (pages/product-codes.js) — and both need the same category
 * mapping and the same error vocabulary. This module is the single source of
 * truth so they can't drift.
 *
 * The codes themselves live in Supabase `product_codes`; see sql/product_codes.sql
 * for the storage contract, and AdminAPI.normalizeProductCode for the format.
 */

/**
 * A product's `product_type` → the /shop `category` it drills down under.
 * Several types share one category (ink = ink_cartridge + ink_bottle), which is
 * why a code edit is scoped to a brand+CATEGORY rather than a brand+type: it's
 * the grain the customer's chip grid actually has.
 */
export const PRODUCT_TYPE_TO_SHOP_CATEGORY = {
  ink_cartridge: 'ink', ink_bottle: 'ink', toner_cartridge: 'toner',
  drum_unit: 'drums', waste_toner: 'drums', belt_unit: 'drums',
  fuser_kit: 'drums', maintenance_kit: 'drums',
  label_tape: 'label', photo_paper: 'paper',
  printer_ribbon: 'ribbons', typewriter_ribbon: 'ribbons', correction_tape: 'ribbons',
};

/** The distinct /shop categories, in the order the picker should offer them. */
export const SHOP_CATEGORIES = [
  { value: 'ink', label: 'Ink' },
  { value: 'toner', label: 'Toner' },
  { value: 'drums', label: 'Drums & Kits' },
  { value: 'ribbons', label: 'Ribbons' },
  { value: 'label', label: 'Label Tape' },
  { value: 'paper', label: 'Paper' },
];

/** A /shop category value → its display label. */
export function categoryLabel(value) {
  const hit = SHOP_CATEGORIES.find(c => c.value === value);
  return (hit && hit.label) || value || '';
}

/**
 * Human-readable scope list for a code — "Canon · Ink", or
 * "HP · Ink and Brother · Toner" when a code spans several.
 *
 * A code label is NOT unique to one brand+category: 41 of the ~1,214 span more
 * than one (HP's "410" ink and Brother's "410" toner are the same three
 * characters). Anything that renames, deletes or lists a code has to say which
 * scopes it means, or the admin can't tell what a click is about to change.
 *
 * @param {Array<{brandSlug:string, category:string}>} scopes
 * @param {(slug:string) => string} brandName  slug → display name
 */
export function describeScopes(scopes, brandName = (s) => s) {
  const parts = (scopes || []).map(s => `${brandName(s.brandSlug)} · ${categoryLabel(s.category)}`);
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Window a list for display and describe the pager around it.
 *
 * The code catalogue is ~1,200 entries; rendering every tile at once is heavy
 * and gives the admin no way to walk it. Both code surfaces slice their
 * (already alphabetically sorted, already filtered) list through this and page
 * with `pagerHtml`. `page` is clamped so a filter that shrinks the list can't
 * strand the view on a page that no longer exists.
 *
 * @param {Array} list      the full (filtered) list to page over
 * @param {number} page     desired 0-based page index (clamped into range)
 * @param {number} perPage  items per page (must be >= 1)
 * @returns {{page:number, pages:number, total:number, items:Array, hasPrev:boolean, hasNext:boolean}}
 */
export function paginate(list, page, perPage) {
  const arr = Array.isArray(list) ? list : [];
  const size = Math.max(1, perPage | 0);
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(page | 0, 0), pages - 1);
  const start = p * size;
  return {
    page: p, pages, total,
    items: arr.slice(start, start + size),
    hasPrev: p > 0, hasNext: p < pages - 1,
  };
}

/**
 * Pager row markup for a `paginate()` model — reuses the shared `.admin-pagination`
 * styles. Returns '' for a single page so callers can append it unconditionally.
 * Prev/Next carry `data-pcpage` so one delegated grid-click handler drives both.
 */
export function pagerHtml(model) {
  if (!model || model.pages <= 1) return '';
  return `<div class="admin-pagination admin-pagination--codes">`
    + `<span class="admin-pagination__info">Page ${model.page + 1} of ${model.pages}</span>`
    + `<span class="admin-pagination__btns">`
    + `<button type="button" class="admin-pagination__btn" data-pcpage="prev"${model.hasPrev ? '' : ' disabled'}>Prev</button>`
    + `<button type="button" class="admin-pagination__btn" data-pcpage="next"${model.hasNext ? '' : ' disabled'}>Next</button>`
    + `</span></div>`;
}

/** True if `code` is storable — matches the table's CHECK constraint exactly. */
export function isValidProductCode(code) {
  const c = String(code || '');
  return c.length >= 2 && c.length <= 24 && /^[A-Z0-9]+(\/[A-Z0-9]+)*$/.test(c);
}

/**
 * Turn a product_codes write failure into a plain-English message, mapping the
 * Postgres error codes the RLS layer can raise (backend migration 104 applies
 * the insert/delete policies + grants). The client normalises codes before
 * writing, so 23505/23503 are defensive; 42501 means the session isn't a
 * signed-in admin, and 23514 means the DB hasn't caught up with the frontend's
 * code format. Any other error keeps its own message.
 */
export function describeCodesWriteError(err) {
  const msg = (err && err.message) || 'unknown error';
  const code = err && err.code;
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return 'you don’t have permission to edit product codes — make sure you’re signed in as an admin.';
  }
  if (code === '23514' || /check constraint|violates check/i.test(msg)) {
    // The likeliest cause is a code containing "/" (PG40/CL41) against a database
    // still on the old A-Z0-9-only rule — i.e. the migration hasn't been run.
    return 'the database rejected that code’s format. If it contains a “/”, run sql/product_codes.sql in the Supabase SQL Editor — the slash rule ships with that migration.';
  }
  if (code === '23503' || /foreign key/i.test(msg)) {
    return 'that product no longer exists — refresh and try again.';
  }
  if (code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
    return 'that code is already on the product.';
  }
  return msg;
}
