/**
 * Best sellers — one owner for the rankings shown by the dashboard "Most Bought"
 * card and the Performance hub's Best Sellers tab.
 *
 * Source: GET /api/admin/analytics/top-products-rpc, measured 2026-09-28 by
 * `npm run probe:best-sellers`:
 *   - rows carry product_name, product_sku, revenue, units_sold, order_count (no brand)
 *   - result_limit is capped at 500; all-time returned 209 rows, so the FULL set
 *     arrives and units/orders can be ranked here. A response that fills the cap is
 *     TRUNCATED and every ranking says so (`truncated`), never silently ranks a cut.
 *   - the server orders by revenue and ignores sort_by, status_filter, category_filter
 *   - ONE SKU CAN COME BACK AS SEVERAL ROWS, one per historical product name
 *     (7 of 202 SKUs, e.g. "… 4-Pack" and "… 4-Pack (500 pages)"). Merged by SKU,
 *     all 202 reconciled exactly with the non-cancelled orders list on order count,
 *     units and revenue. Unmerged, one product's sales were split across two rows.
 *   - cancelled orders are already excluded server-side (same reconciliation).
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
 * Merge raw rows by SKU. Sums revenue/units/orders; a sum that meets an absent
 * value stays null (absent is not zero). The displayed name is the one carrying the
 * most revenue. Rows without a SKU are kept as their own entries.
 */
export function mergeBySku(rows) {
  const bySku = new Map();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const sku = r.product_sku || r.sku || null;
    const row = {
      sku,
      name: r.product_name || r.name || sku || 'Unknown',
      revenue: num(r.revenue ?? r.total),
      units: num(r.units_sold ?? r.units ?? r.quantity ?? r.qty ?? r.quantity_sold),
      orders: num(r.order_count ?? r.orders),
      brand: r.brand || null,
      _nameRevenue: num(r.revenue ?? r.total) ?? 0,
      _rows: 1,
    };
    const prev = sku ? bySku.get(sku) : null;
    if (!prev) { if (sku) bySku.set(sku, row); out.push(row); continue; }
    for (const k of ['revenue', 'units', 'orders']) {
      prev[k] = prev[k] == null || row[k] == null ? null : Math.round((prev[k] + row[k]) * 100) / 100;
    }
    if (row._nameRevenue > prev._nameRevenue) { prev.name = row.name; prev._nameRevenue = row._nameRevenue; }
    prev.brand = prev.brand || row.brand;
    prev._rows += 1;
  }
  return out;
}

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

/**
 * Attach catalogue facts (brand, product_type, pack_type) by SKU. A SKU the
 * catalogue no longer holds (33 of 202 sold SKUs, measured) is marked
 * `inCatalog: false` — its type and pack are UNKNOWN, not "single".
 */
export function attachCatalog(items, metaBySku) {
  const meta = metaBySku instanceof Map ? metaBySku : new Map();
  return items.map(i => {
    const m = i.sku ? meta.get(i.sku) : null;
    return m
      ? { ...i, brand: i.brand || m.brand || null, productType: m.product_type || null, packType: m.pack_type || null, inCatalog: true }
      : { ...i, productType: null, packType: null, inCatalog: !meta.size ? null : false };
  });
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
