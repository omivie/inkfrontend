/**
 * Sourcing vocabulary — WHO we buy a product from, and HOW a pack was produced.
 *
 * Two admin surfaces answer these questions and they must answer them
 * identically:
 *   - Orders  → the order-detail modal's line-items table (per SOLD line).
 *   - Products → the catalogue list (per PRODUCT).
 *
 * The badge labels, colours and tooltips therefore live here once. A second copy
 * of the origin map is how "Assembled" on one page and "In-house" on another
 * start meaning subtly different things.
 *
 * ── Where the data comes from (they are NOT the same source) ────────────────
 *
 * ORDERS: the backend resolves both fields server-side and sends the ANSWER on
 * each line item — `origin` (the enum below) and `suppliers[]`
 * ([{name, sku?, color?}], one entry per constituent for an assembled pack).
 * See `orders-supplier-origin-backend-brief.md`. The frontend renders; it does
 * not compute.
 *
 * PRODUCTS: there is no product-level `origin` column. `products` carries
 * `supplier` (a slug: dsnz / augmento / okin / unknown), `supplier_sku` (the
 * supplier's own code for that SKU, or null) and `pack_type`
 * (single / value_pack / multipack). `productOrigin()` below DERIVES the origin
 * from those two real columns. That derivation is a frontend inference of a fact
 * the backend resolves properly for orders — see the comment on the function.
 *
 * Fail-soft is LOUD everywhere: anything unknown renders a muted em-dash, never
 * a plausible-looking default ("Single", "unknown", blank).
 */

const MISSING = '—';

// These helpers run in the browser (where `Security` is a global from
// js/security.js) and under `node --test` (where it is not). Mirror
// Security.escapeHtml's character set exactly so the escaping under test is the
// escaping that ships.
const ESCAPE_MAP = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  "'": '&#x27;', '/': '&#x2F;', '`': '&#96;',
};

function esc(value) {
  if (typeof Security !== 'undefined' && Security && typeof Security.escapeHtml === 'function') {
    return Security.escapeHtml(String(value));
  }
  return String(value).replace(/[&<>"'/`]/g, (char) => ESCAPE_MAP[char]);
}

// Security.escapeAttr is escapeHtml — same coverage, different intent at the
// call site. Keep both names so attribute-context calls stay self-documenting.
const escAttr = esc;

/**
 * How a pack was produced, keyed by the backend's origin enum.
 * Tuple: [css modifier on .admin-badge, visible label, hover tooltip].
 * Styles live in css/admin.css (.admin-badge--in-house / --supplier-pack / --single).
 */
export const ORIGIN_META = {
  in_house_pack: ['in-house', 'Assembled', 'Assembled in-house from multiple single products.'],
  supplier_pack: ['supplier-pack', 'Pre-boxed', 'Bought pre-boxed as a single pack from one supplier.'],
  single: ['single', 'Single', 'A single product (not a pack).'],
};

/**
 * Render the origin badge. Absent/unknown renders a LOUD em-dash, never a
 * silent "single" default (see the "fail-soft must be loud" convention).
 */
export function originBadge(origin) {
  const m = ORIGIN_META[origin];
  if (!m) return `<span class="admin-text-muted">${MISSING}</span>`;
  return `<span class="admin-badge admin-badge--${m[0]}" title="${escAttr(m[2])}">${esc(m[1])}</span>`;
}

/**
 * Supplier(s) an ORDER LINE was sourced from. For an in-house pack the backend
 * sends one `suppliers[]` entry per constituent single; we show the DISTINCT
 * supplier names and map each constituent -> supplier in the hover tooltip.
 * Absent/empty renders MISSING (loud fail-soft) so an existing order never looks
 * silently "supplier-less".
 */
export function supplierCell(item) {
  const list = Array.isArray(item && item.suppliers) ? item.suppliers.filter((s) => s && s.name) : [];
  if (!list.length) return `<span class="admin-text-muted">${MISSING}</span>`;
  const distinct = [...new Set(list.map((s) => s.name))];
  const tip = list.map((s) => `${s.color || s.sku || '?'} → ${s.name}`).join('\n');
  return `<span title="${escAttr(tip)}">${distinct.map(esc).join(', ')}</span>`;
}

/**
 * Display casing for the `products.supplier` slug. The column stores lowercase
 * slugs; the backend prints "DSNZ" and "Augmento" on order lines, and those two
 * casings are the ones we have actually seen rendered — so they are pinned here
 * rather than guessed from a rule.
 *
 * `unknown` (104 products) is NOT a supplier: it is the absence of one. It
 * returns null so the caller renders the em-dash instead of printing the word
 * "unknown", which would read as a real answer.
 */
export const SUPPLIER_LABELS = {
  dsnz: 'DSNZ',
  augmento: 'Augmento',
};

/** Slugs that mean "we don't know", not "a supplier called this". */
const NO_SUPPLIER = new Set(['unknown', 'none', 'n/a', 'na']);

/**
 * @returns {string|null} display label, or null when no supplier is recorded.
 */
export function supplierLabel(slug) {
  if (slug == null) return null;
  const raw = String(slug).trim();
  if (!raw || NO_SUPPLIER.has(raw.toLowerCase())) return null;
  const known = SUPPLIER_LABELS[raw.toLowerCase()];
  if (known) return known;
  // An unmapped slug (a supplier added after this list was written) is shown
  // title-cased rather than dropped — but the caller keeps the raw slug in the
  // tooltip so nothing is silently prettified into something unrecognisable.
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/** Cell for the Products-page Supplier column. Not recorded -> loud em-dash. */
export function productSupplierCell(product) {
  const raw = product && product.supplier != null ? String(product.supplier).trim() : '';
  const label = supplierLabel(raw);
  if (!label) {
    return `<span class="admin-text-muted" title="No supplier recorded for this product.">${MISSING}</span>`;
  }
  // A slug we have no canonical casing for is title-cased as a best guess, so the
  // tooltip says so and keeps the stored value — better than presenting a guess
  // as though it were the supplier's own spelling.
  const known = Object.prototype.hasOwnProperty.call(SUPPLIER_LABELS, raw.toLowerCase());
  const tip = known
    ? `Supplier: ${label}`
    : `Supplier: ${label} — not in the known supplier list (stored as "${raw}")`;
  return `<span title="${escAttr(tip)}">${esc(label)}</span>`;
}

/**
 * The supplier <select> vocabulary — ONE list, so a filter value can never drift
 * into something that isn't a real `products.supplier` value. A bogus value
 * doesn't error, it silently matches zero rows (the ERR-075 trap), so the option
 * list and the query must come from the same place.
 *
 * Every row has a supplier: 'unknown' is a stored literal, not NULL, so it is
 * selected with the same .eq() as any other value.
 */
export const SUPPLIER_FILTER_VALUES = ['dsnz', 'augmento', 'okin', 'unknown'];

/** Build the <option> list for the Supplier filter, marking `selected`. */
export function supplierFilterOptions(selected = '') {
  const opts = [`<option value="">All Suppliers</option>`];
  for (const value of SUPPLIER_FILTER_VALUES) {
    const label = supplierLabel(value) || 'No supplier recorded';
    const sel = value === selected ? ' selected' : '';
    opts.push(`<option value="${escAttr(value)}"${sel}>${esc(label)}</option>`);
  }
  return opts.join('');
}

/** `products.pack_type` values that mean "this is a multi-cartridge pack". */
export const PACK_PACK_TYPES = ['value_pack', 'multipack'];

/**
 * DERIVE a product's origin from its own columns.
 *
 * ⚠ This is a FRONTEND derivation. For ORDER lines the backend resolves origin
 * itself and we render its answer verbatim; `products` has no equivalent column,
 * so the Products page infers it from two real, fully-populated columns:
 *
 *   pack_type 'single'                      -> 'single'
 *   pack_type 'value_pack' | 'multipack':
 *       supplier_sku empty/null             -> 'in_house_pack'  (we assemble it
 *                                              from the constituent singles —
 *                                              there is no supplier code for the
 *                                              pack itself because no supplier
 *                                              sells it as one box)
 *       supplier_sku present                -> 'supplier_pack'  (the supplier
 *                                              sells this pack pre-boxed under
 *                                              its own code)
 *   anything else / absent                  -> null -> em-dash
 *
 * Evidence (live, 2026-07-28): GLC3317KCMY is a KCMY value pack with
 * supplier_sku null and its order line renders "Assembled"; GLC3317CMY is a CMY
 * value pack with supplier_sku "B3317CMY" (bought pre-boxed). 716 of 806 packs
 * have no supplier_sku.
 *
 * The day `products` grows a real sourcing column (`pack_sourcing`), this
 * function should read it and drop the inference — one place to change.
 *
 * @returns {'single'|'in_house_pack'|'supplier_pack'|null}
 */
export function productOrigin(product) {
  if (!product) return null;
  // A real backend field always wins over the inference.
  if (product.origin && ORIGIN_META[product.origin]) return product.origin;

  const packType = product.pack_type == null ? '' : String(product.pack_type).trim().toLowerCase();
  if (!packType) return null;
  if (packType === 'single') return 'single';
  if (!PACK_PACK_TYPES.includes(packType)) return null;

  const supplierSku = product.supplier_sku == null ? '' : String(product.supplier_sku).trim();
  return supplierSku ? 'supplier_pack' : 'in_house_pack';
}

/** Plain-text origin label (for exports, where a badge is meaningless). */
export function originLabel(origin) {
  const m = ORIGIN_META[origin];
  return m ? m[1] : MISSING;
}
