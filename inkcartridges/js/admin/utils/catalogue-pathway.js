/**
 * Catalogue pathway — the shared, DOM-free half of the admin's
 * brand → category → code → product walk.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The Browse tab (pages/catalogue-browse.js) and the probe
 * (scripts/probe-catalogue-pathway.mjs) both have to answer the same question:
 * *is this product reachable on /shop, and if not, which facet failed?* Two
 * implementations of that question would drift the moment one of them was
 * edited, and the drift would be invisible — a reachability check that has
 * quietly stopped checking still returns "fine".
 *
 * So the answer lives here once, with no DOM and no network, and both callers
 * import it. Same reason `audit-product-types.mjs` loads the shipped
 * vocabularies instead of declaring its own: an audit carrying its own copy
 * certifies a UI that does not exist.
 *
 * THREE OF THE FOUR PATHWAY LEVELS ARE NOT RECORDS
 * ------------------------------------------------
 * This is the fact the whole feature is shaped around, and it is worth stating
 * where someone editing the pathway will read it:
 *
 *   brand     a real `brands` row — and since Aug 2026 whether /shop renders a
 *             tile for it is a column on that row (`show_on_shop`, `sort_order`),
 *             not a hardcoded allowlist in the frontend. See brandShopVisibility.
 *   category  not stored. A fixed map over `product_type`, which is a backend
 *             Postgres enum the frontend can never extend (ERR-162…166)
 *   code      not stored. DERIVED from sku/name by API._enrichSeriesCodes at
 *             query time; `product_codes` is only an override layer
 *   product   the only real record
 *
 * A code with zero products therefore cannot exist — there is no row to write.
 * Which is why the pathway pre-fills a create form rather than creating
 * containers: the chip materialises when the first product saves into it.
 *
 * ONE VOCABULARY. Category↔type membership is read from the SHIPPED maps
 * (`API._CATEGORY_PRODUCT_TYPES` in js/api.js, `PRODUCT_TYPE_TO_SHOP_CATEGORY`
 * in ./product-codes.js) and never re-declared here. `npm run audit:types`
 * reconciles those against the live catalogue in both directions.
 */

import { PRODUCT_TYPE_TO_SHOP_CATEGORY, SHOP_CATEGORIES } from './product-codes.js';
import { RIBBON_PRODUCT_TYPES } from './product-types.js';

/**
 * Whether a brand renders a tile on /shop — a THREE-STATE answer.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * Until 2026-08-31 this module carried `SHOP_BRAND_ALLOWLIST`, a hand-maintained
 * copy of a `preferredOrder` array inside `renderBrands()` in js/shop-page.js,
 * which that function applied as a FILTER rather than a sort. A brand present in
 * the database and returned by `/api/brands` but absent from that array appeared
 * in search, on its PDP and in the admin, and rendered **no tile on /shop**, with
 * no error anywhere. Seventeen brands were in that state. Two hardcoded lists
 * pinned to each other by a test is not a source of truth; it is two stale halves
 * waiting to disagree.
 *
 * The backend now owns it: `brands.show_on_shop` (plus `sort_order`), and
 * shop-page.js filters on exactly that. So the question this module answers is no
 * longer "is the slug in our list" but "what does this brand's own row say".
 *
 * ── Why three states and not a boolean ──────────────────────────────────────
 *
 * Because "we were not given the row" and "the row says no" are different facts
 * that demand opposite responses, and collapsing them is the mistake this whole
 * area keeps making. Reporting an unknown as `false` would file a product as
 * UNREACHABLE on the strength of a field we never read — the could-not-look
 * mistake with the sign flipped, which is exactly how one bad request once became
 * "662 products unreachable" (ERR-187). Reporting it as `true` would hide real
 * misses. So it returns `null`, and callers route that to their own "unmeasured"
 * vocabulary.
 *
 * `=== true` on purpose: an ABSENT field is not visible-by-default.
 *
 * Pure and network-free — the CALLER supplies the row. That is what keeps the
 * probe able to decide without an extra request per brand.
 *
 * @param {object} brandRow a row from /api/brands
 * @returns {{visible: (boolean|null), source: ('row'|'unknown')}}
 */
export function brandShopVisibility(brandRow) {
  const v = brandRow && typeof brandRow === 'object' ? brandRow.show_on_shop : undefined;
  if (v === true) return { visible: true, source: 'row' };
  if (v === false) return { visible: false, source: 'row' };
  return { visible: null, source: 'unknown' };
}

/**
 * Fallback category→types map, used ONLY when `window.API` is absent (the probe
 * and the unit tests run in node, where there is no storefront bundle loaded).
 *
 * In the browser `typesForCategory` reads `API._CATEGORY_PRODUCT_TYPES`
 * directly, so the running admin can never disagree with the running
 * storefront. This literal is the node-side mirror of the same thing and is
 * pinned equal to it by the test file — keep them in step, or the probe will
 * certify a membership the site does not have.
 */
export const CATEGORY_PRODUCT_TYPES_FALLBACK = {
  ink:     ['ink_cartridge', 'ink_bottle'],
  toner:   ['toner_cartridge'],
  drums:   ['drum_unit', 'waste_toner', 'maintenance_box', 'belt_unit', 'fuser_kit', 'fax_film', 'fax_film_refill'],
  label:   ['label_tape'],
  paper:   ['photo_paper'],
  ribbons: ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'],
};

/** The live category→types map: the storefront's own when we are in a browser. */
function categoryMap() {
  const live = (typeof window !== 'undefined' && window.API && window.API._CATEGORY_PRODUCT_TYPES);
  return live || CATEGORY_PRODUCT_TYPES_FALLBACK;
}

/**
 * The `product_type[]` a /shop category contains, in enum order.
 *
 * A category is NOT a type. `ink` holds two types and `drums` holds seven, so
 * walking into a category cannot decide the product's type for you — it can
 * only narrow the menu. The create form uses this to offer exactly the types
 * that belong where the operator is standing.
 */
export function typesForCategory(category) {
  const types = categoryMap()[String(category || '')];
  return Array.isArray(types) ? [...types] : [];
}

/** The /shop category a `product_type` drills down under, or '' if unmapped. */
export function categoryForType(productType) {
  return PRODUCT_TYPE_TO_SHOP_CATEGORY[String(productType || '')] || '';
}

/**
 * The type a category should DEFAULT to in the create form — the first member,
 * which is the enum-order primary (`ink` → `ink_cartridge`, `drums` →
 * `drum_unit`). Deliberately not "the most populated type": that would need a
 * live count, and a default that changes with the catalogue is a default nobody
 * can predict.
 */
export function defaultTypeForCategory(category) {
  return typesForCategory(category)[0] || '';
}



/** True when this product type's codes are owner-assigned only (never derived). */
export function isManualCodeType(productType) {
  return RIBBON_PRODUCT_TYPES.includes(String(productType || ''));
}

/** Normalise a code for comparison. Mirrors AdminAPI.normalizeProductCode. */
export function normCode(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * What codes a product WOULD carry on /shop, derived from its sku/name the same
 * way the storefront derives them.
 *
 * Runs `API._enrichSeriesCodes` on a throwaway probe object — the identical
 * call `wireProductCodesSection`'s `deriveSeed` makes (pages/products.js), so
 * the create form's preview and the drawer's pre-tick can never disagree.
 *
 * **Ribbons return [] and that is not a failure.** Ribbon codes are
 * owner-assigned only — `deriveSeed` returns [] for them, `_applyManualCodes`
 * clears their `series_codes`, and the standing owner directive is that
 * ribbons are not automated in any aspect except page design (ERR-085/086).
 * Deriving one here would reintroduce exactly the auto-fill that was removed.
 *
 * @returns {string[]} normalised codes, or [] when nothing could be derived
 */
export function deriveCodesForSku({ sku, name, productType } = {}) {
  if (isManualCodeType(productType)) return [];
  const api = (typeof window !== 'undefined' && window.API) || null;
  if (!api || typeof api._enrichSeriesCodes !== 'function') return [];
  try {
    const probe = { sku: sku || '', name: name || '', series_codes: [] };
    api._enrichSeriesCodes(probe);
    const out = [];
    for (const c of (probe.series_codes || [])) {
      const n = normCode(c);
      if (n.length >= 2 && !out.includes(n)) out.push(n);
    }
    return out;
  } catch (_) {
    // Derivation is best-effort and advisory — the operator still sees the
    // form. Never let a preview throw into a create flow.
    return [];
  }
}

/**
 * The yield-suffix collapse, mirroring `SeriesCodes.collapseYieldSuffix`
 * (js/utils.js) — `LC3339XL` → `LC3339`, `604XXL` → `604`.
 *
 * ⚠ THIS COMPARISON IS LOAD-BEARING, and leaving it out is not a cosmetic bug.
 *
 * The server already collapses XL on the chip LABEL: brother · ink offers
 * `LC3339`, never `LC3339XL`. But the extractor derives the UNCOLLAPSED form
 * from a SKU — `CLC3339XLBK` → `LC3339XL`. Comparing those two strings for
 * equality says "mismatch" for a product that is in exactly the right place,
 * and every one of LC3339's twelve existing products is an `LC3339XL*` SKU.
 *
 * Left uncollapsed, `needsCodeOverride` would return true for essentially every
 * XL product, so the create flow would write a `product_codes` row on every
 * save — materialising each one into the override layer, where its derived
 * codes are ignored PERMANENTLY. That is the override trap, sprung on the happy
 * path. Caught in a browser on 2026-08-30, not by a unit test.
 *
 * Anchored `^([A-Z]*\d+)(X{1,3}L)$` so a raw SKU body like `604XLBK` cannot
 * match — only already-extracted canonical codes collapse. Pinned equal to
 * utils.js by tests/catalogue-pathway-aug2026.test.js.
 */
const YIELD_SUFFIX = /^([A-Z]*\d+)(X{1,3}L)$/;

export function collapseYield(code) {
  const c = normCode(code);
  const shipped = (typeof window !== 'undefined' && window.SeriesCodes?.collapseYieldSuffix);
  if (typeof shipped === 'function') {
    try { return normCode(shipped(c)); } catch (_) { /* fall through to the mirror */ }
  }
  const m = c.match(YIELD_SUFFIX);
  return m ? m[1] : c;
}

/**
 * Does `code` put a product on the chip labelled `chip`?
 *
 * True when they are equal, or equal once the yield suffix is collapsed off
 * either side. This is the ONLY comparison the pathway should use — a bare
 * `===` between a derived code and a chip label is the bug described above.
 */
export function codeMatchesChip(code, chip) {
  const a = normCode(code);
  const b = normCode(chip);
  if (!a || !b) return false;
  return a === b || collapseYield(a) === collapseYield(b);
}

/**
 * Compare where a product WILL land against where the operator is standing.
 *
 * This is the create form's live preview, and the one place that catches the
 * failure nobody currently notices: a mistyped SKU derives a DIFFERENT code,
 * silently minting a one-product chip on /shop that looks like a real series.
 *
 * @returns {{state:'match'|'mismatch'|'none'|'manual', derived:string[], expected:string}}
 *   match    — the derived set contains the pathway's code; nothing to do
 *   mismatch — it derives something else; saving creates a new chip
 *   none     — nothing derivable from this sku/name yet
 *   manual   — owner-assigned type (ribbons); derivation deliberately not run
 */
export function previewCodeForSku({ sku, name, productType, expectedCode } = {}) {
  const expected = normCode(expectedCode);
  if (isManualCodeType(productType)) return { state: 'manual', derived: [], expected };
  const derived = deriveCodesForSku({ sku, name, productType });
  if (!derived.length) return { state: 'none', derived, expected };
  if (!expected) return { state: 'none', derived, expected };
  return {
    state: derived.some(c => codeMatchesChip(c, expected)) ? 'match' : 'mismatch',
    derived,
    expected,
  };
}

/**
 * Does this product need a `product_codes` override row written so it lands
 * under `expectedCode`?
 *
 * TRUE only when the derived set does NOT already contain the code.
 *
 * **Never seed a product whose derivation already agrees.** Writing an override
 * materialises the product into `product_codes`, and from that moment its
 * backend-derived `series_codes` are ignored ENTIRELY, forever — the override
 * trap documented in sql/product_codes.sql and pages/product-codes.js. A
 * product that would have landed in the right place on its own must stay out of
 * that table. This mirrors the drawer's baseline-divergence check, which is why
 * seeded-but-untouched products never materialise there either.
 */
export function needsCodeOverride({ sku, name, productType, expectedCode } = {}) {
  const expected = normCode(expectedCode);
  if (!expected) return false;
  if (isManualCodeType(productType)) return true; // ribbons carry only what we assign
  return !deriveCodesForSku({ sku, name, productType }).some(c => codeMatchesChip(c, expected));
}

/**
 * Merge a code into a product's EFFECTIVE codes, ready for `setProductCodes`.
 *
 * `setProductCodes` replaces the product's whole set, so the input must start
 * from what the product effectively carries today — its existing override rows
 * if any, else its derived codes. Passing a bare `[code]` would silently erase
 * every other chip the product appears under. That is the single most
 * destructive mistake available in this area and it fails silently.
 *
 * @param {string[]} effective  the product's current effective codes
 * @param {string} code         the code to add
 * @returns {string[]} the full set to persist
 */
export function mergeCodeIntoEffective(effective, code) {
  const out = [];
  for (const c of (Array.isArray(effective) ? effective : [])) {
    const n = normCode(c);
    if (n.length >= 2 && !out.includes(n)) out.push(n);
  }
  const add = normCode(code);
  if (add.length >= 2 && !out.includes(add)) out.push(add);
  return out;
}

/**
 * The four facets that decide whether a product is reachable by a customer
 * walking /shop. Used by the probe and by the Browse tab's on-demand check —
 * one implementation, two callers.
 *
 * A product can be created with a 201 and still be invisible to every customer
 * if ANY of these is wrong, and nothing in the current admin would say so. That
 * is the whole reason the automatic (feed) path needs measuring rather than
 * assuming.
 *
 * `overrideCodes` is optional: pass the product's `product_codes` rows when you
 * have them. Absent, a product with no derivable code is reported as such —
 * which is correct for the feed path, where overrides are never written.
 *
 * @returns {{reachable:boolean, failures:Array<{facet:string, detail:string}>}}
 */
export function reachabilityFacets(product, { overrideCodes = null, brandSlug = null, brandRow = null } = {}) {
  const failures = [];
  const p = product || {};

  // 1. Active. An inactive product is excluded from every /shop query.
  if (p.is_active === false) {
    failures.push({ facet: 'is_active', detail: 'product is deactivated' });
  }

  // 2. Brand — set, AND on the /shop tile grid. Two distinct ways to be
  //    unreachable, and the second one is invisible today.
  const slug = brandSlug || p.brand?.slug || p.brand_slug || '';
  if (!p.brand_id && !slug) {
    failures.push({ facet: 'brand_id', detail: 'no brand assigned' });
  } else if (slug) {
    // `brandRow` is supplied by the caller (the probe fetches /api/brands once;
    // the Browse tab already has the list). Its ABSENCE is not a "no" — a product
    // is only reported unreachable on a brand row we actually read.
    const vis = brandShopVisibility(brandRow);
    if (vis.visible === false) {
      failures.push({
        facet: 'brand_on_shop',
        detail: `brand "${slug}" has show_on_shop = false — it renders no tile on /shop`,
      });
    } else if (vis.visible === null) {
      failures.push({
        facet: 'brand_visibility_unknown',
        detail: `brand "${slug}" — no brand row was supplied, so whether it renders a /shop tile was NOT checked`,
      });
    }
  }

  // 3. Product type — set, and mapped to a /shop category. An unmapped type has
  //    no category to drill down under, so the product has no route at all.
  const type = p.product_type || '';
  if (!type) {
    failures.push({ facet: 'product_type', detail: 'no product_type set' });
  } else if (!categoryForType(type)) {
    failures.push({
      facet: 'product_type',
      detail: `product_type "${type}" maps to no /shop category`,
    });
  }

  // 4. A code — derived, supplied by the backend, or overridden.
  const supplied = Array.isArray(p.series_codes) ? p.series_codes.filter(Boolean) : [];
  const overrides = Array.isArray(overrideCodes) ? overrideCodes.filter(Boolean) : [];
  const derived = deriveCodesForSku({ sku: p.sku, name: p.name, productType: type });
  if (!supplied.length && !overrides.length && !derived.length) {
    failures.push({
      facet: 'code',
      detail: isManualCodeType(type)
        ? 'owner-assigned type with no code assigned (ribbons are never auto-derived)'
        : `no code derivable from sku "${p.sku || ''}" or name`,
    });
  }

  return { reachable: failures.length === 0, failures };
}

/**
 * The /shop categories, for the admin's category level.
 *
 * Re-exported from ./product-codes.js rather than re-listed, so there is one
 * category vocabulary in the admin. The Browse tab shows ALL of these including
 * empty ones — unlike /shop, which hides a zero-count category. An empty
 * category is exactly where an admin adds the first product, so hiding it would
 * make that impossible.
 */
export { SHOP_CATEGORIES };
