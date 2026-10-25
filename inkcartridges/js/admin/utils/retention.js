/**
 * Retention report — pure helpers (checklist 2026-10-22 item 39, ERR-372).
 * GET /api/admin/analytics/retention (owner only; 403 for other admins).
 *
 * Rules the panel must keep, from the backend's spec:
 *   - null is "—", NEVER 0. A real zero arrives as {repeat_customers: 0, …}.
 *   - every rate shows its counts: "4 of 43 · 9.3%".
 *   - a rate whose observed_customers < 20, a median whose
 *     customers_with_second_order < 20, and revenue at dN whose
 *     second_order_within.dN.observed_customers < 20 are greyed "small sample".
 *   - rates and medians do NOT add across segments: always read them from the
 *     response, never derive them here.
 * No imports, so node tests can load this file directly.
 */

export const SMALL_SAMPLE = 20;
export const MISSING = '—';
export const WINDOWS = ['d30', 'd60', 'd90', 'd180'];
export const REVENUE_WINDOWS = ['d30', 'd90', 'd180'];
export const SEGMENTS = [
  { id: 'all', label: 'All' },
  { id: 'ad_acquired', label: 'Google Ads' },
  { id: 'other', label: 'Other web' },
  { id: 'invoice_or_quick_order', label: 'Invoice & quick order' },
];
export const SEGMENT_NOTE = 'Other web is the comparison for Google Ads, but not a clean control: it includes customers from the old order book and ad clicks that arrived without a Google click id.';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A rate cell: {text, small} — "4 of 43 · 9.3%", or "—" for null. */
export function rateCell(w) {
  if (!w || typeof w !== 'object') return { text: MISSING, small: false, missing: true };
  const r = num(w.repeat_customers), o = num(w.observed_customers), p = num(w.rate_pct);
  if (r === null || o === null) return { text: MISSING, small: false, missing: true };
  const pct = p === null ? MISSING : `${p.toFixed(1)}%`;
  return { text: `${r} of ${o} · ${pct}`, small: o < SMALL_SAMPLE, missing: false };
}

/** Median days to a 2nd order, muted by the customers it is based on. */
export function medianCell(group) {
  const m = num(group && group.median_days_to_second_order);
  const n = num(group && group.customers_with_second_order);
  if (m === null) return { text: MISSING, small: false, missing: true };
  return { text: `${Math.round(m)} days (n=${n === null ? '?' : n})`, small: n === null || n < SMALL_SAMPLE, missing: false };
}

/** Revenue per customer at dN, muted by second_order_within.dN.observed_customers. */
export function revenueCell(group, win) {
  const v = num(group && group.revenue_per_customer_incl_gst && group.revenue_per_customer_incl_gst[win]);
  if (v === null) return { text: MISSING, small: false, missing: true };
  const w = group && group.second_order_within && group.second_order_within[win];
  const o = num(w && w.observed_customers);
  const text = '$' + v.toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { text, small: o === null || o < SMALL_SAMPLE, missing: false };
}

/** Rows for one segment: cohorts oldest first, then totals. */
export function rowsFor(data, segment) {
  const cohorts = Array.isArray(data && data.cohorts) ? data.cohorts : [];
  const rows = cohorts.map((c) => ({ label: c.cohort, inProgress: c.month_complete === false, group: c[segment] || null }));
  if (data && data.totals) rows.push({ label: 'Total', inProgress: false, total: true, group: data.totals[segment] || null });
  return rows;
}

/** Footer: "As of 2026-10-24 · 226 orders counted · excluded: 3 test, …". */
export function footerText(meta) {
  const m = meta || {};
  const ex = m.excluded || {};
  const parts = [];
  if (m.as_of) parts.push(`As of ${m.as_of}`);
  if (num(m.orders_counted) !== null) parts.push(`${m.orders_counted} orders counted`);
  const exParts = [['test_orders', 'test'], ['non_positive_total', '$0 or less'], ['staff_orders', 'staff'], ['orders_without_customer', 'no customer']]
    .filter(([k]) => num(ex[k]) !== null).map(([k, l]) => `${ex[k]} ${l}`);
  if (exParts.length) parts.push(`excluded: ${exParts.join(', ')}`);
  return parts.join(' · ');
}
