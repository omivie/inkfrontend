/**
 * Best sellers — one owner for the rankings shown by the dashboard "Most Bought"
 * card and the Performance hub's Best Sellers tab.
 *
 * Source: GET /api/admin/analytics/top-products-rpc, re-measured 2026-09-29 after
 * the backend built BF-089/BF-090 (ERR-299, `npm run probe:best-sellers`):
 *   - ONE ROW PER PRODUCT (grouped by order_items.product_id). All-time: 199 rows,
 *     199 distinct product_sku. `product_sku`/`product_name` are the product's
 *     CURRENT sku/name; `sale_skus` lists every SKU it was SOLD under (33 of 199
 *     differ, e.g. C62XLBK <- C62BK). An order line in /api/admin/orders carries
 *     the SALE-TIME sku, so reconcile through `sale_skus`, never `product_sku`.
 *   - rows carry brand, product_type, pack_type, source from the product row. A
 *     product that no longer exists keeps brand/type from the order line's
 *     snapshot and has pack_type null (0 such rows measured) — that null is the
 *     "not in the catalogue" marker. The direct Supabase catalogue read is gone.
 *   - result_limit is capped at 500; a response that fills the cap is TRUNCATED and
 *     every ranking says so (`truncated`), never silently ranks a cut.
 *   - status_filter / category_filter / supplier_filter / brand_filter all BITE
 *     (negative controls: an impossible category or supplier = 0 rows). An unknown
 *     status or an unknown PARAMETER (e.g. sort_by) is a 400 VALIDATION_FAILED —
 *     surfaced on screen with the server's message, never read as "no sales".
 *   - category_filter takes products.category CODES (CON-INK, …), not storefront
 *     slugs: `ink` returns 0 rows. CATEGORY_OPTIONS below is that list.
 *   - default statuses = every status except cancelled (same rule as /kpi-summary);
 *     admin test orders (orders.is_test_order) are excluded server-side.
 *
 * Pure functions, no imports: pages and api.js both use this.
 */

export const TOP_PRODUCTS_MAX_LIMIT = 500;

export const METRICS = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'units',   label: 'Units' },
  { id: 'orders',  label: 'Orders' },
];

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Normalise the server rows. No merging: the server groups by product now. A SKU
 * that still arrives on several rows is a server regression — it is COUNTED
 * (`dupSkus`) so the page says so, instead of being silently summed.
 */
export function normalizeRows(rows) {
  const seen = new Map();
  const items = (Array.isArray(rows) ? rows : []).map(r => {
    const sku = r.product_sku || null;
    if (sku) seen.set(sku, (seen.get(sku) || 0) + 1);
    const sale = Array.isArray(r.sale_skus) ? r.sale_skus.filter(Boolean) : [];
    return {
      sku,
      name: r.product_name || sku || 'Unknown',
      revenue: num(r.revenue),
      units: num(r.units_sold),
      orders: num(r.order_count),
      brand: r.brand || null,
      productType: r.product_type || null,
      packType: r.pack_type || null,
      source: r.source || null,
      saleSkus: sale,
      soldAs: sale.filter(x => x !== sku),
      inCatalog: r.pack_type != null,
    };
  });
  return { items, dupSkus: [...seen.values()].filter(n => n > 1).length };
}

/**
 * Filter-bar category codes for category_filter (products.category). The backend
 * matches these codes only — a storefront slug silently returns 0 rows.
 */
export const CATEGORY_OPTIONS = [
  { value: 'CON-INK', label: 'Ink' },
  { value: 'CON-LASER', label: 'Toner / laser' },
  { value: 'CON-RIBBON', label: 'Ribbons' },
  { value: 'CON-LABELS', label: 'Labels' },
  { value: 'CON-PAPER', label: 'Paper' },
  { value: 'CON-COPIER', label: 'Copier' },
  { value: 'CON-A3', label: 'A3' },
  { value: 'CON-FAX', label: 'Fax' },
  { value: 'CON-OTHER', label: 'Other consumables' },
  { value: 'HW-ACCESS', label: 'Hardware accessories' },
];

/** Sorted copy, highest first. Ties break on revenue, then name, so the order is stable. */
export function rankBy(items, metric) {
  return [...items].sort((a, b) =>
    (b[metric] ?? -1) - (a[metric] ?? -1)
    || (b.revenue ?? -1) - (a.revenue ?? -1)
    || String(a.name).localeCompare(String(b.name)));
}

/** True when some row lacks the metric — the ranking would put it last as if zero. */
export function metricIncomplete(items, metric) {
  return items.some(i => i[metric] == null);
}

export const TYPE_GROUPS = [
  { id: 'all',     label: 'All types' },
  { id: 'ink',     label: 'Ink',     types: ['ink_cartridge'] },
  { id: 'toner',   label: 'Toner',   types: ['toner_cartridge', 'drum_unit', 'fuser_kit'] },
  { id: 'ribbon',  label: 'Ribbons', types: ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'] },
  { id: 'other',   label: 'Other' },
];

const GROUPED = new Set(TYPE_GROUPS.flatMap(g => g.types || []));

/**
 * Filter by type group and pack kind. Rows with unknown catalogue facts cannot be
 * placed, so any active filter drops them — and returns how many it dropped so the
 * page can say so.
 */
export function filterItems(items, { type = 'all', pack = 'all' } = {}) {
  if (type === 'all' && pack === 'all') return { items, unplaced: 0 };
  const group = TYPE_GROUPS.find(g => g.id === type);
  let unplaced = 0;
  const kept = items.filter(i => {
    if (!i.inCatalog) { unplaced++; return false; }
    if (type === 'other' && GROUPED.has(i.productType)) return false;
    if (group?.types && !group.types.includes(i.productType)) return false;
    if (pack === 'packs' && i.packType === 'single') return false;
    if (pack === 'singles' && i.packType !== 'single') return false;
    return true;
  });
  return { items: kept, unplaced };
}
