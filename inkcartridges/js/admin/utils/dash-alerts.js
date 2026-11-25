/**
 * Dashboard 'to-do' cards: thresholds, the pure alert computations and the card renderer.
 * Moved verbatim out of pages/dashboard.js (Nov 2026) so the rebuilt dashboard and the
 * old one share ONE copy while both exist (side-by-side rollout).
 */
import { esc } from '../app.js';
import { firstArray, numOrNull, orderRef, MISSING } from './dash-charts.js';

// ---------- action-alert thresholds ----------

// Net-margin % below which a product is "reprice or drop" urgent. The backend's own
// margin floors (16–47%) flag thousands of products as under-floor — too many to be a daily
// action — so the alert uses this tighter threshold to surface only the genuinely thin ones.
export const LOW_MARGIN_PCT = 10;
// A zero-result search must reach this volume to be "worth acting on" (add a product,
// synonym or redirect). Quieter one-off typos stay out of the alert.
export const ZERO_SEARCH_MIN = 5;

// /margin/out-of-stock answers `{ok, data:{out_of_stock:[…limit rows], total_out_of_stock, pagination}}`.
// The old reader looked for `total` / `items` and found neither, so the tile read 0 while the
// backend reported 530 (ERR-366). The row array is only the requested page (limit 5), so its
// length is never the count unless no total came back at all.
export function outOfStockCount(data) {
  if (data == null) return null;
  const d = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const total = numOrNull(d.total_out_of_stock ?? d.pagination?.total ?? d.total);
  if (total != null) return total;
  return firstArray(d, ['out_of_stock', 'items', 'products', 'data']).length;
}

// ---------- action-alert data shaping ----------


// Each alert returns a full `items` list (each row clickable to its own destination) plus a
// headline `count`. The card renders the first 5 and expands to the rest on demand.

// Alert A — orders needing tracking. Union of paid/processing orders missing a tracking_number
// (deep-linkable to the order) and pending tracking requests, deduped by order number.

export function computeTrackingAlert(trackingReq, trackingOrders) {
  const reqList = firstArray(trackingReq, ['requests', 'data', 'items']);
  const orders = firstArray(trackingOrders, ['orders', 'data', 'items']);
  const items = [];
  const seen = new Set();
  let hasOrderTrackingField = false;
  // Order rows carry an id → deep-link straight to the order detail.
  for (const o of orders) {
    if ('tracking_number' in o) hasOrderTrackingField = true;
    if (o.tracking_number) continue;
    const num = o.order_number || o.id;
    if (num == null || seen.has(String(num))) continue;
    seen.add(String(num));
    items.push({ label: `#${orderRef(num)}`, href: o.id ? `orders?focus=${encodeURIComponent(window.OrderNumber.forDisplay(o.order_number) || o.id)}` : 'tracking-requests' });
  }
  // Tracking-request rows lack an order id → route to the tracking-requests queue.
  for (const r of reqList) {
    const num = r.order_number || r.order?.order_number || r.id;
    if (num == null || seen.has(String(num))) continue;
    seen.add(String(num));
    items.push({ label: `#${orderRef(num)}`, href: 'tracking-requests' });
  }
  // If the orders endpoint never exposes tracking_number we can't trust the order-derived
  // items; fall back to just the tracking-request queue + its total count.
  if (!hasOrderTrackingField && orders.length) {
    const reqItems = reqList.map(r => ({ label: `#${orderRef(r.order_number || r.order?.order_number || r.id)}`, href: 'tracking-requests' }));
    const count = typeof trackingReq?.total === 'number' ? trackingReq.total : reqItems.length;
    return { count, items: reqItems };
  }
  return { count: items.length, items };
}

// Alert B — high-volume zero-result searches worth acting on (add product / synonym / redirect).
// Each term links to the Products list filtered by it, ready to add a matching product.
export function computeZeroSearchAlert(searchZero) {
  const list = firstArray(searchZero, ['terms', 'searches', 'data']);
  const items = list
    .map(r => ({ term: r.term || r.query || r.q || MISSING, n: Number(r.searches ?? r.count ?? r.volume ?? 0) }))
    .filter(r => r.n >= ZERO_SEARCH_MIN)
    .sort((a, b) => b.n - a.n)
    .map(r => ({ label: r.term, badge: String(r.n), href: `products?search=${encodeURIComponent(r.term)}` }));
  return { count: items.length, items };
}

// Alert C — low-margin products. Prefers real per-SKU under-margin rows (each links to the
// product); falls back to brand-level margin_by_brand when that endpoint is unavailable.
// `capped` is set when every fetched row is under threshold (so there may be more than shown).
export function computeLowMarginAlert(worstMarginSkus, marginBrand, truncated = false) {
  if (Array.isArray(worstMarginSkus) && worstMarginSkus.length) {
    // An UNKNOWN margin is not a low margin. numOrNull keeps null out of the compare
    // (null < 10 would be true — null coerces to 0).
    const low = worstMarginSkus.filter(r => numOrNull(r._marginPct) != null && r._marginPct < LOW_MARGIN_PCT);
    return {
      count: low.length, capped: !!truncated, grain: 'sku',
      items: low.map(r => ({ label: r._label, badge: `${Number(r._marginPct).toFixed(1)}%`, badgeCls: 'admin-badge--failed', href: `products?search=${encodeURIComponent(r.sku || r._label)}` })),
    };
  }
  const brands = firstArray(marginBrand, ['brands', 'data']);
  const low = brands
    // Number(null) === 0, and Number.isFinite(0) is true — so an unknown-margin brand
    // used to sail through this filter and get reported as a CRITICAL "0.0% — reprice
    // or drop" recommendation. Telling the owner to drop a brand on the strength of a
    // number that doesn't exist is worse than showing them nothing.
    .map(b => ({ label: b.brand || MISSING, pct: numOrNull(b.margin_pct) }))
    .filter(b => b.pct != null && b.pct < LOW_MARGIN_PCT)
    .sort((a, b) => a.pct - b.pct);
  return {
    count: low.length, capped: false, grain: 'brand',
    items: low.map(b => ({ label: b.label, badge: `${b.pct.toFixed(1)}%`, badgeCls: 'admin-badge--failed', href: 'margin' })),
  };
}

// "Action needed" panel — surfaces what the owner should do today. The card itself is NOT a
// link; each row is its own clickable link to that item's page. Shows up to ALERT_PREVIEW rows
// and expands to the full list on demand (wireAlertToggles).
export const ALERT_PREVIEW = 5;

export function alertCard(title, count, why, items, sev, emptyMsg, span = 4) {
  const rows = items.length
    ? items.map(it => {
        const badge = it.badge != null
          ? `<span class="admin-badge ${it.badgeCls || ''}">${esc(it.badge)}</span>` : '';
        return `<a class="admin-alert-card__item" href="#${esc(it.href)}"><span class="admin-alert-card__item-label">${esc(it.label)}</span>${badge}</a>`;
      }).join('')
    : `<div class="admin-alert-card__none">${esc(emptyMsg)}</div>`;
  const collapsed = items.length > ALERT_PREVIEW ? ' admin-alert-card__list--collapsed' : '';
  const toggle = items.length > ALERT_PREVIEW
    ? `<button type="button" class="admin-alert-card__toggle" data-alert-toggle>Show all ${items.length}</button>`
    : '';
  return `
    <div class="admin-dash__cell--${span} admin-card admin-alert-card${sev ? ' admin-alert-card--' + sev : ''}">
      <div class="admin-card__title"><span>${esc(title)}</span></div>
      <div class="admin-alert-card__count">${esc(String(count))}</div>
      <div class="admin-alert-card__why">${esc(why)}</div>
      <div class="admin-alert-card__list${collapsed}">${rows}</div>
      ${toggle}
    </div>
  `;
}

// Local copy of the orders.js predicate (canonical version + rationale: pages/orders.js
// `isInvoiceOrder`). Importing it would drag DataTable/Drawer/Modal in for a one-line test,
// so the rules are mirrored — INCLUDING the `channel` check, which this copy was missing.
// Without it a backend that starts sending `channel: 'invoice'` on non-INV- numbered rows
// would route them to the wrong page here while orders.js classified them correctly.
export const isInvoiceOrder = (o) => {
  if (!o) return false;
  if (o.channel) return String(o.channel).toLowerCase() === 'invoice';
  if (o.payment_method) return String(o.payment_method).toLowerCase() === 'invoice';
  return /^INV-/i.test(String(o.order_number || ''));
};

// Expand/collapse the alert item lists (show all ↔ show first ALERT_PREVIEW).
// Takes a root so the alerts panel can be re-wired on its own after the background
// missing-cost scan repaints it, without re-binding buttons elsewhere on the page.
export function wireAlertToggles(root) {
  root?.querySelectorAll('[data-alert-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = btn.previousElementSibling;
      const collapsed = list?.classList.toggle('admin-alert-card__list--collapsed');
      const total = list?.querySelectorAll('.admin-alert-card__item').length || 0;
      btn.textContent = collapsed ? `Show all ${total}` : 'Show less';
    });
  });
}
