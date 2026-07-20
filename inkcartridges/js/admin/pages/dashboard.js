/**
 * Dashboard — paired-row analytics (Jun 2026 redesign)
 *
 * KPI band (backend kpi-summary) + side-by-side graph rows, each one a labelled
 * section with two charts. EVERY data point is fetched pre-computed and
 * pre-bucketed from the backend — the frontend never aggregates, buckets, or
 * derives margins/profit itself (the project's "backend is the source of truth"
 * rule). Two independent filters drive the page: the data range (FilterState
 * period) and the bar width (FilterState granularity), the latter sent to the
 * backend so each series comes back one row per bucket.
 *
 * Charts whose backend endpoint does not exist yet render a graceful
 * "awaiting data" empty state (the API client returns null) so the page never
 * crashes — they light up automatically once the backend ships each endpoint
 * (see docs/dashboard-graph-endpoints.md).
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
// Reused pure math so the two expense trend lines reconcile with the rest of the app:
// COGS from the same convention as the KPI strip, opex from the same cash-basis rules
// as the Expenses page (paid-only, GST-netted, order-linked excluded).
import { kpiCogsInclGst } from '../utils/trend-math.js';
import { cashMs, pnlCost } from '../utils/expense-math.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;
const MISSING = '—';
const AWAIT_MSG = 'Awaiting data — backend endpoint pending';
const EMPTY_MSG = 'No data for this range';

/**
 * Null-honest numeric read — use this for anything COGS-derived.
 *
 * The backend returns gross_profit / net_profit / cogs / margin_pct as **null**,
 * never 0, when a sale in the bucket has an un-costed line (COGS honesty, ERR-028).
 * `Number(null)` is `0`, and `null || 0` is `0` — so the naive read draws a
 * confident $0 bar or a 0% margin, which the owner reads as a catastrophic loss
 * rather than "we don't know". Chart.js renders `null` as a GAP (spanGaps defaults
 * to false), which is the truthful picture.
 *
 * Revenue and order counts are always real numbers and don't need this.
 */
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

let _container = null;
// Race-guard for loadDashboard — see the same pattern in pages/website-traffic.js.
// Filter changes call loadDashboard() concurrently; without this, a slow earlier
// load can paint stale data on top of a newer load that already finished.
let _loadSeq = 0;
let _hasRenderedSuccessfully = false; // first-load spinner vs re-load dim
// The grain the bundle ACTUALLY served at — may be coarser than the user's pick if
// the backend rejected the finer one (getDashboardBundle escalates). Drives fmtBucket
// so the x-axis labels match the bars, even when escalation happened.
let _effectiveGranularity = null;

// Last successful render payload, keyed by the active filter signature. Survives SPA
// navigation (NOT cleared in destroy) so returning to the dashboard paints instantly,
// then revalidates in the background (stale-while-revalidate). In-memory only.
const _payloadCache = new Map();
const _PAYLOAD_CACHE_MAX = 12;

// ---------- action-alert thresholds ----------

// Net-margin % below which a product is "reprice or drop" urgent. The backend's own
// margin floors (16–47%) flag thousands of products as under-floor — too many to be a daily
// action — so the alert uses this tighter threshold to surface only the genuinely thin ones.
const LOW_MARGIN_PCT = 10;
// A zero-result search must reach this volume to be "worth acting on" (add a product,
// synonym or redirect). Quieter one-off typos stay out of the alert.
const ZERO_SEARCH_MIN = 5;

// ---------- small helpers ----------

function deltaBadge(current, previous, { invert = false } = {}) {
  if (current == null || previous == null) return '';
  if (previous === 0) {
    if (current === 0) return '';
    return `<span class="admin-kpi__delta admin-kpi__delta--up">↑ new</span>`;
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const isUp = pct > 0, isDown = pct < 0;
  let cls = 'flat';
  if (isUp) cls = invert ? 'down' : 'up';
  else if (isDown) cls = invert ? 'up' : 'down';
  const arrow = isUp ? '↑' : isDown ? '↓' : '→';
  return `<span class="admin-kpi__delta admin-kpi__delta--${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function missingValue(tooltip = 'Data unavailable') {
  return `<span class="admin-kpi__value admin-kpi__value--missing" data-tooltip="${esc(tooltip)}">${MISSING}</span>`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  for (const k of keys) {
    if (obj && Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

function safeDiv(a, b) {
  if (!b || b === 0 || a == null) return null;
  return a / b;
}

function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(100,100,100,${alpha})`;
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return `rgba(${parseInt(h[0] + h[0], 16)},${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${alpha})`;
  }
  if (h.length >= 6) {
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }
  return hex;
}

// Resolve the active bar-width sent to the backend. The chosen granularity (Day by
// default) wins — but is CLAMPED coarser if it would exceed the backend's ~750-bucket
// cap for the real window span (else the request 400s and blanks every chart).
// FilterState gates the UI to match; this is the safety net for a stale/over-cap URL.
const GRAN_ORDER = ['day', 'week', 'month', 'quarter'];
const GRAN_DAYS = { day: 1, week: 7, month: 30.4, quarter: 91 };
const GRAN_BUCKET_CAP = 750;

function realRangeDays() {
  const { from, to } = FilterState.getDateRange();
  return Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
}

function resolveGranularity() {
  const days = realRangeDays();
  const fits = (g) => days / GRAN_DAYS[g] <= GRAN_BUCKET_CAP;
  // 'all' is a FE-only cumulative-plot mode — fetch off the finest real grain that fits.
  let explicit = FilterState.get('granularity') || 'day';
  if (explicit === 'all') explicit = 'day';
  if (fits(explicit)) return explicit;
  for (let i = Math.max(0, GRAN_ORDER.indexOf(explicit)); i < GRAN_ORDER.length; i++) {
    if (fits(GRAN_ORDER[i])) return GRAN_ORDER[i];
  }
  return 'quarter';
}

// 'all' bar-width → render the additive time-series as a cumulative line ("total over
// time") instead of per-bucket bars. FE-only; the request uses the resolved real grain.
function isCumulativeMode() {
  return FilterState.get('granularity') === 'all';
}

// Format a backend bucket_start for the x-axis at the active granularity.
// The backend sends an Auckland-LOCAL label, not a UTC ISO timestamp:
//   day/week/month/quarter → "YYYY-MM-DD". We parse it as a LOCAL date (never
// `new Date("YYYY-MM-DD")`, which is UTC and would shift the label a day in NZ)
// so bars line up with the Orders list.
function fmtBucket(v) {
  if (v == null) return '';
  const s = String(v);
  const g = _effectiveGranularity || resolveGranularity();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0)
    : new Date(s);
  if (isNaN(d.getTime())) return s;
  if (g === 'week') {
    // Show the week span, month-first, end at the next week's boundary: "Jul 2 – Jul 9".
    const md = (x) => x.toLocaleDateString('en-NZ', { month: 'short' }) + ' ' + x.getDate();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
    return md(d) + ' – ' + md(end);
  }
  if (g === 'month') return d.toLocaleDateString('en-NZ', { month: 'long' });
  if (g === 'quarter') return d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

function rangeLabel() {
  const period = FilterState.get('period');
  const map = {
    '24h': 'last 24h', '72h': 'last 72h', '7d': 'last 7 days', '1m': 'last 30 days',
    '3m': 'last 3 months', '6m': 'last 6 months', '1y': 'last 12 months',
    '2y': 'last 2 years', 'all': 'all time', 'custom': 'custom range',
  };
  return map[period] || 'selected range';
}

function outOfStockCount(data) {
  if (data == null) return null;
  if (typeof data.total === 'number') return data.total;
  const items = firstArray(data, ['items', 'products', 'data']);
  return items.length;
}

function sumRefundAmounts(refunds) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  if (!series.length) return null;
  return series.reduce((sum, r) => sum + Number(r.refund_amount ?? r.amount ?? r.total ?? 0), 0);
}

// ---------- action-alert data shaping ----------

// Pull a net-margin % off an under-margin row. The endpoint exposes a few shapes; prefer the
// fields already labelled "_pct" (definitely a percentage), and only treat a bare `net_margin`
// as a fraction (×100) when it's clearly ≤1 in magnitude.
function rowMarginPct(r) {
  if (r == null) return null;
  for (const k of ['net_margin_pct', 'estimated_margin_pct', 'margin_pct']) {
    if (r[k] != null) return Number(r[k]);
  }
  if (r.net_margin != null) {
    const v = Number(r.net_margin);
    return Math.abs(v) <= 1.5 ? v * 100 : v;   // fraction → percent
  }
  return null;
}

// Normalize one-or-more getUnderMarginProducts() responses into ranked rows the worst-margin
// chart + low-margin alert both read: { sku, name, _label, _marginPct }, MERGED across sources
// and sorted ascending (worst first). Returns null only when every response is missing, so the
// chart shows "awaiting data" honestly. Each source is fetched worst-first, so the merged head
// is the catalog-wide worst.
function normalizeWorstMargin(responses) {
  const list = Array.isArray(responses) ? responses : [responses];
  if (list.every(r => r == null)) return null;
  const out = [];
  for (const resp of list) {
    const rows = firstArray(resp, ['data', 'rows', 'products', 'items']);
    for (const r of rows) {
      const pct = rowMarginPct(r);
      if (pct == null) continue;
      const sku = r.sku || r.SKU || '';
      const name = r.name || r.product_name || sku || MISSING;
      out.push({ sku, name, source: r.source || '', _label: sku || String(name).slice(0, 18), _marginPct: pct });
    }
  }
  out.sort((a, b) => a._marginPct - b._marginPct);
  return out;
}

// Each alert returns a full `items` list (each row clickable to its own destination) plus a
// headline `count`. The card renders the first 5 and expands to the rest on demand.

// Alert A — orders needing tracking. Union of paid/processing orders missing a tracking_number
// (deep-linkable to the order) and pending tracking requests, deduped by order number.
function computeTrackingAlert(trackingReq, trackingOrders) {
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
    items.push({ label: `#${String(num).slice(-8)}`, href: o.id ? `orders?order=${encodeURIComponent(o.id)}` : 'tracking-requests' });
  }
  // Tracking-request rows lack an order id → route to the tracking-requests queue.
  for (const r of reqList) {
    const num = r.order_number || r.order?.order_number || r.id;
    if (num == null || seen.has(String(num))) continue;
    seen.add(String(num));
    items.push({ label: `#${String(num).slice(-8)}`, href: 'tracking-requests' });
  }
  // If the orders endpoint never exposes tracking_number we can't trust the order-derived
  // items; fall back to just the tracking-request queue + its total count.
  if (!hasOrderTrackingField && orders.length) {
    const reqItems = reqList.map(r => ({ label: `#${String(r.order_number || r.order?.order_number || r.id).slice(-8)}`, href: 'tracking-requests' }));
    const count = typeof trackingReq?.total === 'number' ? trackingReq.total : reqItems.length;
    return { count, items: reqItems };
  }
  return { count: items.length, items };
}

// Alert B — high-volume zero-result searches worth acting on (add product / synonym / redirect).
// Each term links to the Products list filtered by it, ready to add a matching product.
function computeZeroSearchAlert(searchZero) {
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
function computeLowMarginAlert(worstMarginSkus, marginBrand, truncated = false) {
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

// ---------- chart empty/await state ----------

// Distinguish a missing endpoint (payload === null) from an endpoint that
// answered with no rows, so the page reads honestly while the backend is pending.
function resolveList(payload, keys = []) {
  if (payload == null) return null;             // endpoint missing entirely
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];                                     // present, but empty / unknown shape
}

function chartEmpty(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  const box = canvas?.closest('.admin-chart-box');
  if (box) box.innerHTML = `<div class="admin-dash-inline-empty">${esc(message)}</div>`;
}

// Returns true when there's data to draw; otherwise paints the right empty state.
function hasData(canvasId, payload, list) {
  if (payload == null) { chartEmpty(canvasId, AWAIT_MSG); return false; }
  if (!list || !list.length) { chartEmpty(canvasId, EMPTY_MSG); return false; }
  return true;
}

// Charts.* are async (lazy Chart.js CDN); fire-and-forget but catch rejections
// so a CDN failure degrades to an empty state instead of an unhandled rejection.
function guardDraw(promise, canvasId) {
  Promise.resolve(promise).catch(() => chartEmpty(canvasId, 'Chart failed to render'));
}

// ---------- generic chart drawers ----------

// Time-series (bar or line), one or more metrics, optional stacking. Reads
// payload.series (one row per backend bucket); never re-buckets.
function drawSeries(canvasId, payload, opts) {
  const { type = 'bar', metrics, labelKey = 'bucket_start', isMoney = true, isPercent = false, stacked = false, additive = false } = opts;
  const list = resolveList(payload, ['series', 'data']);
  if (!hasData(canvasId, payload, list)) return;

  const c = Charts.getThemeColors();
  const labels = list.map(r => fmtBucket(r[labelKey]));
  const valFmt = (v) => isMoney ? formatPrice(v) : isPercent ? `${Number(v).toFixed(1)}%` : String(v);

  // 'all' bar-width: plot every series as a line, and accumulate the additive ones
  // (money totals, counts) into a running total. Averages/rates (additive:false) plot
  // their per-bucket value — a cumulative average/rate would be meaningless.
  const plot = isCumulativeMode();
  const cumulative = plot && additive;
  const seriesData = (key) => {
    // null (unknown COGS) stays null → Chart.js draws a gap. In cumulative mode an
    // unknown bucket can't be added to the running total, so the total is unknowable
    // from there on — carry the gap rather than silently treating it as +0.
    const raw = list.map(r => numOrNull(r[key]));
    if (!cumulative) return raw;
    let acc = 0;
    let broken = false;
    return raw.map(v => {
      if (v == null) { broken = true; return null; }
      if (broken) return null;
      return (acc += v);
    });
  };
  const drawType = plot ? 'line' : type;

  const datasets = metrics.map(m => {
    const col = c[m.color] || c.cyan;
    if (drawType === 'line') {
      return {
        label: m.label, data: seriesData(m.key),
        borderColor: col, backgroundColor: hexToRgba(col, 0.18),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4,
        ...(stacked ? { stack: 's' } : {}),
      };
    }
    return {
      label: m.label, data: seriesData(m.key),
      backgroundColor: col + 'cc', borderRadius: 4, barPercentage: 0.7, categoryPercentage: 0.8,
      ...(stacked ? { stack: 's' } : {}),
    };
  });

  const scales = {
    x: { ticks: { maxTicksLimit: 10 } },
    y: { beginAtZero: true, ticks: { callback: (v) => valFmt(v) } },
  };
  if (stacked) { scales.x.stacked = true; scales.y.stacked = true; }

  const fn = drawType === 'line' ? Charts.line : Charts.bar;
  guardDraw(fn.call(Charts, canvasId, {
    labels, datasets,
    options: {
      plugins: {
        legend: {
          display: metrics.length > 1, position: 'top',
          labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${valFmt(ctx.raw || 0)}` } },
      },
      scales,
    },
  }), canvasId);
}

// Ranked bars (top SKUs, searches, margin, conversion, histograms).
function drawRanked(canvasId, payload, opts) {
  const {
    listKeys = [], labelKey, valueKey, color = 'cyan',
    isMoney = true, isPercent = false, horizontal = true, sort = true, limit = 10, label,
  } = opts;
  const list = resolveList(payload, listKeys);
  if (!hasData(canvasId, payload, list)) return;

  let rows = list.slice();
  // A row whose value is unknown (null COGS) must not sort as if it earned $0 — that
  // would dump it to the bottom of the ranking as the "worst" performer. Sort the
  // known rows, then park the unknowns at the end where they read as unknown.
  if (sort) {
    rows.sort((a, b) => {
      const av = numOrNull(a[valueKey]), bv = numOrNull(b[valueKey]);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
  }
  rows = rows.slice(0, limit);

  const c = Charts.getThemeColors();
  const labels = rows.map(r => String(r[labelKey] ?? MISSING));
  const data = rows.map(r => numOrNull(r[valueKey]));   // null → no bar, not a $0 bar
  const valFmt = (v) => v == null ? MISSING
    : isMoney ? formatPrice(v) : isPercent ? `${Number(v).toFixed(1)}%` : String(v);
  const valueAxis = horizontal ? 'x' : 'y';

  guardDraw(Charts.bar(canvasId, {
    labels,
    datasets: [{
      label: label || valueKey, data,
      backgroundColor: (c[color] || c.cyan) + 'cc', borderRadius: 4,
      barPercentage: 0.85, categoryPercentage: 0.85,
    }],
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${valFmt(ctx.raw ?? null)}` } },
      },
      scales: { [valueAxis]: { beginAtZero: true, ticks: { callback: (v) => valFmt(v) } } },
    },
  }), canvasId);
}

// Share doughnut (traffic by source, refund reasons).
function drawShare(canvasId, payload, opts) {
  const { listKeys = [], labelKey, valueKey, isMoney = false } = opts;
  const list = resolveList(payload, listKeys);
  if (!hasData(canvasId, payload, list)) return;

  const c = Charts.getThemeColors();
  const palette = [c.cyan, c.magenta, c.yellow, c.success, c.danger, '#60a5fa', '#a78bfa'];
  const labels = list.map(r => String(r[labelKey] ?? MISSING));
  const data = list.map(r => Number(r[valueKey] || 0));
  if (data.every(v => v === 0)) { chartEmpty(canvasId, EMPTY_MSG); return; }
  const valFmt = (v) => isMoney ? formatPrice(v) : String(v);

  guardDraw(Charts.doughnut(canvasId, {
    labels, data,
    colors: labels.map((_, i) => palette[i % palette.length]),
    options: {
      plugins: {
        legend: { display: true, position: 'right', labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${valFmt(ctx.raw || 0)}` } },
      },
    },
  }), canvasId);
}

// Revenue + gross profit on one chart. They share the time axis but live on very
// different scales (revenue ≫ gross profit), so gross profit rides a secondary
// right-hand y-axis to stay readable. Merges the two payloads by bucket and honors
// cumulative 'all' mode exactly like the sibling money charts used to.
function drawRevenueProfit(d) {
  const canvasId = 'dash-c-revenue-profit';
  const revList = resolveList(d.sRevenue, ['series', 'data']) || [];
  const gpList  = resolveList(d.sGrossProfit, ['series', 'data']) || [];

  const byBucket = new Map(); // bucket_start -> { revenue, gross_profit }
  const order = [];
  const merge = (list, srcKey, dstKey) => {
    for (const r of list) {
      const b = r.bucket_start ?? r.date;
      if (!byBucket.has(b)) { byBucket.set(b, {}); order.push(b); }
      byBucket.get(b)[dstKey] = numOrNull(r[srcKey]);
    }
  };
  merge(revList, 'revenue', 'revenue');
  merge(gpList, 'gross_profit', 'gross_profit');
  if (!order.length) { chartEmpty(canvasId, EMPTY_MSG); return; }
  order.sort(); // "YYYY-MM-DD" sorts chronologically

  const c = Charts.getThemeColors();
  const labels = order.map(fmtBucket);
  const plot = isCumulativeMode();
  // Two distinct nulls collapse here: a bucket the series never mentioned, and a
  // bucket whose COGS is unknown. Both mean "no profit figure for this bucket", and
  // both must draw a GAP — a 0 would put a confident $0 profit bar next to a healthy
  // revenue bar and read as "we sold $4k and made nothing".
  const accum = (arr) => {
    if (!plot) return arr;
    let acc = 0, broken = false;
    return arr.map(v => {
      if (v == null) { broken = true; return null; }
      if (broken) return null;   // a running total past an unknown bucket is unknowable
      return (acc += v);
    });
  };
  const revenue = accum(order.map(b => numOrNull(byBucket.get(b)?.revenue)));
  const profit  = accum(order.map(b => numOrNull(byBucket.get(b)?.gross_profit)));

  const drawType = plot ? 'line' : 'bar';
  const mk = (label, data, color, axis) => drawType === 'line'
    ? { label, data, yAxisID: axis, borderColor: color, backgroundColor: hexToRgba(color, 0.16),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4 }
    : { label, data, yAxisID: axis, backgroundColor: color + 'cc', borderRadius: 4,
        barPercentage: 0.7, categoryPercentage: 0.8 };

  const datasets = [
    mk('Revenue', revenue, c.success, 'y'),
    mk('Gross profit', profit, c.cyan, 'y1'),
  ];

  const fn = drawType === 'line' ? Charts.line : Charts.bar;
  guardDraw(fn.call(Charts, canvasId, {
    labels, datasets,
    options: {
      plugins: {
        legend: { display: true, position: 'top', labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
        // Pin both axes to a 0 floor so the two series share one baseline (revenue and
        // cumulative gross profit are both ≥0; without min:0 Chart.js pads the right axis
        // down to ~-$100 and the zero lines drift apart).
        y:  { beginAtZero: true, min: 0, position: 'left',  ticks: { callback: (v) => formatPrice(v) } },
        y1: { beginAtZero: true, min: 0, position: 'right', grid: { drawOnChartArea: false },
              ticks: { color: c.textMuted, font: { size: 11 }, callback: (v) => formatPrice(v) } },
      },
    },
  }), canvasId);
}

// Revenue forecast: backend ships a contiguous series flagged is_forecast.
function drawForecast(canvasId, payload) {
  const list = resolveList(payload, ['series', 'data']);
  if (!hasData(canvasId, payload, list)) return;

  const c = Charts.getThemeColors();
  const labels = list.map(r => fmtBucket(r.bucket_start ?? r.date));
  const actual = list.map(r => r.is_forecast ? null : Number(r.revenue || 0));
  const forecast = list.map(r => r.is_forecast ? Number(r.revenue || 0) : null);
  const firstFc = list.findIndex(r => r.is_forecast);
  if (firstFc > 0) forecast[firstFc - 1] = actual[firstFc - 1];   // bridge the two lines

  guardDraw(Charts.line(canvasId, {
    labels,
    datasets: [
      {
        label: 'Revenue (actual)', data: actual,
        borderColor: c.success, backgroundColor: hexToRgba(c.success, 0.16),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, spanGaps: false,
      },
      {
        label: 'Revenue (forecast)', data: forecast,
        borderColor: c.success, backgroundColor: hexToRgba(c.success, 0.08),
        borderWidth: 2, borderDash: [5, 4], fill: true, tension: 0.25, pointRadius: 0, spanGaps: false,
      },
    ],
    options: {
      plugins: {
        legend: { display: true, position: 'top', labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}` } },
      },
      scales: { x: { ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { callback: (v) => formatPrice(v) } } },
    },
  }), canvasId);
}

// Performance overview — real numbers, NOT normalized (replaces the old 0–100% combined
// chart, which made small metrics look as important as big ones). Revenue + gross profit
// ride the left $ axis; order volume rides the right count axis. Merges the three series by
// bucket_start and honors cumulative 'all' mode for the money series (orders stay per-bucket
// so the line always reads as daily/weekly volume, never a runaway running total).
/**
 * Merge every Performance-overview series onto one chronological bucket axis.
 *
 * Shared by `drawPerformanceOverview` (which plots it) and `renderOverviewSection` (which
 * names it in the card subtitle) so the subtitle and the chart legend are provably the same
 * string. They used to be computed independently and could contradict each other.
 *
 * Pure: no DOM, no Charts, no FilterState.
 */
function buildOverviewBuckets(d) {
  const revList = resolveList(d?.sRevenue, ['series', 'data']) || [];
  const gpList  = resolveList(d?.sGrossProfit, ['series', 'data']) || [];
  const ordList = resolveList(d?.sOrders, ['series', 'data']) || [];
  const npList  = resolveList(d?.sNetProfit, ['series', 'data']) || [];

  const byBucket = new Map(); // bucket key -> { revenue, grossProfit, netProfit, fees, opex, orders }
  const order = [];
  const merge = (list, valFn, dstKey) => {
    for (const r of (Array.isArray(list) ? list : [])) {
      // Normalise to YYYY-MM-DD. Four series merging on a RAW key means one shipping
      // "2026-07-01T00:00:00Z" against another shipping "2026-07-01" would silently split
      // one day into two labels and halve both lines.
      const b = String(r?.bucket_start ?? r?.date ?? '').slice(0, 10);
      if (!b) continue;
      if (!byBucket.has(b)) { byBucket.set(b, {}); order.push(b); }
      byBucket.get(b)[dstKey] = valFn(r);
    }
  };
  merge(revList, (r) => numOrNull(r.revenue), 'revenue');
  merge(ordList, (r) => numOrNull(r.orders), 'orders');
  // Gross profit is the source of the derived COGS line (COGS = revenue_ex − gross_profit)
  // and the honest fallback for the profit line. Reads gross_profit_series specifically —
  // never a net-or-gross blend.
  merge(gpList, (r) => numOrNull(r.gross_profit), 'grossProfit');
  // Net profit + its two components, straight from the backend. Since migration 118 these
  // reconcile to kpi-summary by construction (verified live 2026-07-20, residual ≤2c/30
  // buckets), so the plotted line IS the backend's figure — no proration, no reconstruction.
  merge(npList, (r) => numOrNull(r.net_profit), 'netProfit');
  merge(npList, (r) => numOrNull(r.stripe_fees), 'fees');
  merge(npList, (r) => numOrNull(r.operating_expenses), 'opex');

  order.sort(); // "YYYY-MM-DD" sorts chronologically
  return { order, byBucket };
}

/**
 * Render the Performance card's honesty captions.
 *
 * "Fail-soft must be LOUD": partial-ness and backend disagreement belong in the UI, not in
 * a console nobody reads. ERR-106's drift guard warned correctly and went unnoticed for
 * weeks because DebugLog was its only channel.
 */
function renderOverviewNotes(plan, drift, opexLabel, hasBackendOpex) {
  const host = document.getElementById('dash-overview-notes');
  if (!host) return;
  const notes = [];

  if (drift) {
    // Both figures are the backend's own, so this is a backend inconsistency — say so
    // plainly rather than implying the chart is at fault.
    notes.push(`<p class="fh-pnl-note admin-dash-note--alert"><strong>These two backend figures disagree.</strong>
      The per-period ${esc(plan.label.toLowerCase())} adds up to ${esc(formatPrice(drift.seriesTotal))},
      but the Net Profit tile reads ${esc(formatPrice(drift.kpiNet))} (gap ${esc(formatPrice(Math.abs(drift.gap)))}).
      Neither figure can be trusted until this is resolved.</p>`);
  }

  if (plan.basis === 'gross-fallback') {
    notes.push(`<p class="fh-pnl-note">Net profit isn’t available per period for this range, so this chart
      shows <strong>gross profit</strong> instead — before Stripe fees and operating expenses.</p>`);
  } else if (plan.nullCount > 0) {
    const total = plan.knownCount + plan.nullCount;
    notes.push(`<p class="fh-pnl-note">${plan.nullCount} of ${total} periods have no profit figure
      (a sale in them has no cost of goods recorded), so the profit line gaps there rather than
      reading as ${esc(formatPrice(0))}.</p>`);
  }

  if (!hasBackendOpex) {
    notes.push(`<p class="fh-pnl-note">“${esc(opexLabel)}” is bucketed from your logged expenses in the
      browser because the backend didn’t return per-period operating expenses for this range. It can
      differ from the Net Profit tile’s expense figure, which also counts recurring charges.</p>`);
  }

  host.innerHTML = notes.join('');
}

function drawPerformanceOverview(d) {
  const canvasId = 'dash-c-overview';
  const { order, byBucket } = buildOverviewBuckets(d);
  if (!order.length) { chartEmpty(canvasId, d.sRevenue == null ? AWAIT_MSG : EMPTY_MSG); return; }

  // ── Cost lines ────────────────────────────────────────────────────────────────────
  // COGS per bucket as real cash to suppliers (incl-GST), via the same helper the KPI
  // strip uses. Null-honest: an unknown gross_profit bucket leaves COGS null (a gap),
  // never a confident 0. See ERR-111 — this figure is grossed up because the backend's
  // gross_profit is on the ex-GST cost basis (migration 118).
  const cogsByBucket = order.map(b => {
    const rev = numOrNull(byBucket.get(b)?.revenue);
    const gp  = numOrNull(byBucket.get(b)?.grossProfit);
    return (rev == null || gp == null) ? null : kpiCogsInclGst(rev, gp);
  });
  // Stripe fees per bucket — shipped by the backend on net_profit_series since migration 118.
  const feesByBucket = order.map(b => numOrNull(byBucket.get(b)?.fees));

  // Operating expenses per bucket. PRIMARY is the backend's own `operating_expenses` — it is
  // range-scoped, GST-net, order-linked-excluded and includes recurring expense_occurrences,
  // and it is the figure the Net Profit KPI actually subtracts. The client-side bucketing of
  // /expenses below is a FALLBACK ONLY: measured live 2026-07-20 it read $1,375.76 of face
  // value against the backend's $1,071.69 for the same window, because it misses recurring
  // occurrences, doesn't GST-net identically, isn't range-scoped, and silently drops rows
  // before the first bucket. Two different measurements — so they get two different labels.
  const backendOpex = order.map(b => numOrNull(byBucket.get(b)?.opex));
  const hasBackendOpex = backendOpex.some(v => v != null);

  const startMs = order.map(b => Date.parse(b));
  const indexFor = (ms) => {
    if (!Number.isFinite(ms)) return -1;
    let idx = -1;
    for (let i = 0; i < startMs.length; i++) {
      if (Number.isFinite(startMs[i]) && startMs[i] <= ms) idx = i; else break;
    }
    return idx; // -1 when the date precedes the first bucket → dropped
  };
  const loggedOpex = new Array(order.length).fill(0);
  if (!hasBackendOpex) {
    // Cash-basis + GST-net + order-linked exclusion all come from expense-math
    // (cashMs skips unpaid; order_linked is COGS).
    for (const row of (Array.isArray(d.expenseRows) ? d.expenseRows : [])) {
      if (!row || row.kind === 'order_linked') continue; // order-linked lives in COGS
      const i = indexFor(cashMs(row)); // NaN for unpaid → -1 → skipped
      if (i < 0) continue;
      loggedOpex[i] += pnlCost(Number(row.amount), row.gst_claimable);
    }
  }
  const opexByBucket = hasBackendOpex ? backendOpex : loggedOpex;
  const opexLabel = hasBackendOpex ? 'Operating expenses' : 'Logged expenses (client-side)';

  // Total costs = COGS + operating expenses + Stripe fees — every component now per-bucket.
  // Any unknown component makes the total unknown: a gap, never a confident partial sum.
  const totalCostByBucket = order.map((_, i) => {
    const parts = [cogsByBucket[i], opexByBucket[i], feesByBucket[i]];
    if (parts.some(v => v == null)) return null;
    return parts.reduce((a, v) => a + v, 0);
  });

  const c = Charts.getThemeColors();
  const labels = order.map(fmtBucket);
  const plot = isCumulativeMode();
  const accum = (arr) => {
    if (!plot) return arr;
    let acc = 0, broken = false;
    return arr.map(v => {
      if (v == null) { broken = true; return null; }
      if (broken) return null;   // can't keep a running total across an unknown bucket
      return (acc += v);
    });
  };
  // ── Profit line — the BACKEND's per-bucket figure, not a reconstruction ─────────────
  // net_profit_series reconciles to kpi-summary by construction since migration 118, so we
  // plot it directly. `plan` also decides the legend label, so the line can never claim to
  // be net profit while actually showing gross.
  const cur  = d.kpis?.current ?? {};
  const plan = planProfitLine(order, byBucket);

  // Loud guard (fail-soft must be LOUD). Both numbers below are the backend's own, so a trip
  // means the BACKEND disagrees with itself — the caption says exactly that rather than
  // blaming the chart. Resolved from the same expression the KPI tile renders, so the guard
  // can't pass while the tile shows something else.
  const recovered = recoverProfitFromSeries(cur, d.sGrossProfit, d.sNetProfit);
  const kpiNet    = cur.net_profit ?? recovered?.net ?? null;
  const drift     = checkNetDrift(plan, kpiNet, order.length);
  if (drift) {
    window.DebugLog?.warn?.(
      `[Dashboard] net-profit line ($${drift.seriesTotal.toFixed(2)}) does not reconcile to the Net Profit KPI ($${drift.kpiNet.toFixed(2)}) — gap $${Math.abs(drift.gap).toFixed(2)}, tolerance $${drift.tolerance.toFixed(2)}. Both figures are backend-sourced, so this is a backend inconsistency.`);
  }
  renderOverviewNotes(plan, drift, opexLabel, hasBackendOpex);

  const revenue = accum(order.map(b => numOrNull(byBucket.get(b)?.revenue)));
  const profit  = accum(plan.values.slice());
  const orders  = accum(order.map(b => numOrNull(byBucket.get(b)?.orders)));
  const addedExpenses = accum(opexByBucket.slice());
  const totalExpenses = accum(totalCostByBucket.slice());

  const drawType = plot ? 'line' : 'bar';
  const mkMoney = (label, data, color) => drawType === 'line'
    ? { label, data, yAxisID: 'y', borderColor: color, backgroundColor: hexToRgba(color, 0.16),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4 }
    : { label, data, yAxisID: 'y', backgroundColor: color + 'cc', borderRadius: 4,
        barPercentage: 0.7, categoryPercentage: 0.8 };

  const datasets = [
    mkMoney('Revenue', revenue, c.success),
    mkMoney(plan.label, profit, c.cyan),
    // Cost lines share the left $ axis. Operating expenses = spend that isn't cost of goods;
    // Total costs = that + COGS + Stripe fees, so the gap between them reads as "how much of
    // the total is running the business vs buying the stock".
    mkMoney(opexLabel, addedExpenses, c.magenta),
    mkMoney('Total costs', totalExpenses, c.danger),
    // Orders always a line on the right axis so it reads against the money bars/lines.
    { label: 'Orders', data: orders, yAxisID: 'y1', type: 'line',
      borderColor: c.yellow, backgroundColor: hexToRgba(c.yellow, 0.12),
      borderWidth: 2, fill: false, tension: 0.35, pointRadius: 0, pointHoverRadius: 4 },
  ];

  // Bar base with a line dataset mixed in (Chart.js honors per-dataset `type`).
  const fn = drawType === 'line' ? Charts.line : Charts.bar;
  guardDraw(fn.call(Charts, canvasId, {
    labels, datasets,
    options: {
      plugins: {
        legend: { display: true, position: 'top', labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: {
          label: (ctx) => ctx.dataset.yAxisID === 'y1'
            ? `${ctx.dataset.label}: ${Math.round(ctx.raw || 0)}`
            : `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}`,
          // Revenue is what landed in the bank (incl-GST) and costs are what left it
          // (incl-GST), but PROFIT is measured net of GST — GST is collected on behalf of
          // IRD and remitted, so it was never income. Without this note the lines look
          // like they should subtract to the profit line, and they don't.
          footer: () => 'Revenue and costs incl. GST; profit is measured net of GST.',
        } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
        // No `min: 0` — the money axis auto-scales below zero so a loss-making period reads as
        // a dip under the baseline instead of being clipped flat. beginAtZero keeps 0 in view
        // when everything is positive. The zero gridline is emphasised so break-even is obvious.
        y:  { beginAtZero: true, position: 'left', ticks: { callback: (v) => formatPrice(v) },
              grid: { drawBorder: false, color: (gctx) => gctx.tick?.value === 0 ? c.textMuted : c.border } },
        // Orders can't be negative — keep this axis clamped at 0.
        y1: { beginAtZero: true, min: 0, position: 'right', grid: { drawOnChartArea: false },
              ticks: { color: c.textMuted, font: { size: 11 }, precision: 0, callback: (v) => Math.round(v) } },
      },
    },
  }), canvasId);
}

function drawAllCharts(d) {
  try {
    // Performance overview (real numbers, above the rest) — replaces the old normalized chart
    drawPerformanceOverview(d);
    // Row 1 — Money: revenue + gross profit merged (left), forecast (right)
    drawRevenueProfit(d);
    drawForecast('dash-c-forecast', d.forecast);
    // Row 2 — Products (3-up): top by revenue, top by profit, worst margin
    drawRanked('dash-c-sku-revenue', d.topSkusRev, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'revenue', color: 'success', isMoney: true });
    drawRanked('dash-c-sku-profit', d.topSkusProfit, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'gross_profit', color: 'cyan', isMoney: true });
    // Worst-margin SKUs come pre-sorted ascending from getUnderMarginProducts (sort:false here).
    drawRanked('dash-c-sku-worst-margin', d.worstMarginSkus, { listKeys: ['products', 'rows', 'data'], labelKey: '_label', valueKey: '_marginPct', color: 'danger', isMoney: false, isPercent: true, sort: false, limit: 8 });
    // Row 3 — Sales
    drawSeries('dash-c-orders', d.sOrders, { type: 'line', additive: true, metrics: [{ label: 'Orders', key: 'orders', color: 'yellow' }], isMoney: false });
    drawSeries('dash-c-aov', d.sAov, { type: 'line', metrics: [{ label: 'AOV', key: 'aov', color: 'cyan' }], isMoney: true });
    // Row 4 — Margin
    drawRanked('dash-c-margin-brand', d.marginBrand, { listKeys: ['brands'], labelKey: 'brand', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    drawRanked('dash-c-margin-category', d.marginCategory, { listKeys: ['categories'], labelKey: 'category', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    // Row 5 — Marketing (traffic only). Conversion-by-source is HIDDEN: the backend
    // conversion_pct returns >100% (bad sessions↔orders attribution, see handoff doc).
    // Restore the card in render() + uncomment below once the backend math is fixed:
    //   drawRanked('dash-c-conversion-source', d.conversionSource, { listKeys: ['sources'], labelKey: 'source', valueKey: 'conversion_pct', color: 'success', isMoney: false, isPercent: true });
    drawShare('dash-c-traffic-source', d.trafficSource, { listKeys: ['sources'], labelKey: 'source', valueKey: 'sessions' });
    // Row 6 — Customers
    drawSeries('dash-c-cust-type', d.custType, { type: 'bar', stacked: true, additive: true, isMoney: true, metrics: [{ label: 'New', key: 'new_revenue', color: 'cyan' }, { label: 'Returning', key: 'returning_revenue', color: 'success' }] });
    drawRanked('dash-c-reorder', d.reorder, { listKeys: ['buckets'], labelKey: 'days_label', valueKey: 'customer_count', color: 'cyan', isMoney: false, horizontal: false, sort: false, limit: 24 });
    // Row 8 — Search
    // search→purchase attribution isn't tracked yet (backend data_gap: orders/
    // conversion_pct are null), so rank by search volume until it lands.
    drawRanked('dash-c-search-top', d.searchTop, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'success', isMoney: false });
    drawRanked('dash-c-search-zero', d.searchZero, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'yellow', isMoney: false });
    // Row 9 — Risk
    drawSeries('dash-c-refund-rate', d.sRefundRate, { type: 'line', metrics: [{ label: 'Refund rate', key: 'refund_rate_pct', color: 'danger' }], isMoney: false, isPercent: true });
    drawShare('dash-c-refund-reasons', d.refunds, { listKeys: ['reasons'], labelKey: 'reason_code', valueKey: 'count' });
  } catch (e) {
    if (window.DebugLog) DebugLog.warn('[Dashboard] chart draw error:', e?.message);
  }
}

// ---------- data loading ----------

function dashboardSkeleton() {
  return `
    <div class="admin-page-header admin-page-header--dash"><h1>Dashboard</h1></div>
    <div class="admin-loader" role="status" aria-label="Loading dashboard">
      <span class="admin-sr-only">Loading dashboard…</span>
      <div class="admin-loading__spinner" aria-hidden="true"></div>
    </div>
  `;
}

// Map the /dashboard-bundle `data` map onto the per-chart payload keys render()
// reads. A null bundle (or a missing key) yields null → that chart shows its
// "awaiting data" empty state. Keys mirror the backend bundle contract exactly.
function bundleToGraphs(b) {
  b = b || {};
  return {
    sRevenue:         b.revenue_series ?? null,
    sGrossProfit:     b.gross_profit_series ?? null,
    sNetProfit:       b.net_profit_series ?? null,
    sOrders:          b.orders_series ?? null,
    sAov:             b.aov_series ?? null,
    sRefundRate:      b.refund_rate_series ?? null,
    custType:         b.revenue_by_customer_type ?? null,
    trafficSource:    b.traffic_by_source ?? null,
    forecast:         b.forecast_revenue ?? null,
    topSkusRev:       b.top_skus_revenue ?? null,
    topSkusProfit:    b.top_skus_gross_profit ?? null,
    marginBrand:      b.margin_by_brand ?? null,
    marginCategory:   b.margin_by_category ?? null,
    conversionSource: b.conversion_by_source ?? null,
    reorder:          b.reorder_interval ?? null,
    searchTop:        b.search_top_converting ?? null,
    searchZero:       b.search_zero_result ?? null,
  };
}

// Fallback when the bundle endpoint itself fails: fetch each chart's standalone
// endpoint in parallel (the router now allows 60 req/min, so the fan-out is safe).
async function loadDashboard() {
  if (!_container) return;
  const mySeq = ++_loadSeq;

  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();
  const g = resolveGranularity();
  const cacheKey = params.toString();   // includes granularity via getParams()

  // Stale-while-revalidate: warm cache paints instantly + dims while revalidating;
  // cold first load → spinner; filter-change reload → keep page, dim it. All paths
  // share the _loadSeq race guard so a stale fetch can't paint over a newer one.
  const cached = isOwner ? _payloadCache.get(cacheKey) : null;
  if (cached) {
    render(cached);
    _hasRenderedSuccessfully = true;
    _container.classList.add('admin-page--reloading');
  } else if (!_hasRenderedSuccessfully) {
    _container.innerHTML = dashboardSkeleton();
  } else {
    _container.classList.add('admin-page--reloading');
  }

  if (!isOwner) {
    if (mySeq !== _loadSeq || !_container) return;
    _container.classList.remove('admin-page--reloading');
    render({ isOwner: false });
    return;
  }

  const from = params.get('from'), to = params.get('to');
  // One bundle call covers all 18 graph charts (backend's preferred path — avoids
  // the parallel fan-out that tripped the rate limiter). The KPI band, tables and
  // refund reasons stay on their existing dedicated endpoints. The last three feed the
  // "Action needed" panel + worst-margin card. 10 calls total (under the 60/min limit).
  const promises = [
    AdminAPI.getDashboardBundle(params, g, signal),          // 0  all graph charts
    AdminAPI.getDashboardKPIs(params, signal),               // 1  KPI band
    AdminAPI.getCustomerStats(params, signal),               // 2  new / returning KPI
    AdminAPI.getRefundAnalytics(params, signal),             // 3  refund reasons + rate KPI
    AdminAPI.getOutOfStock({ limit: 5 }),                    // 4  out-of-stock KPI
    AdminAPI.getOrders({ from, to }, 1, 8, signal),          // 5  recent orders table
    AdminAPI.getTopProducts(params, signal),                 // 6  most-bought table
    AdminAPI.getTrackingRequests({ status: 'pending' }),     // 7  alert: orders needing tracking
    AdminAPI.getOrders({ from, to, statuses: ['paid', 'processing'] }, 1, 50, signal), // 8  alert: untracked open orders
    // Worst-margin SKUs + low-margin alert. The endpoint needs a concrete source ('' → 400),
    // so fetch genuine + compatible worst-first and merge. limit:60 each gives a deep enough
    // tail to count everything under the alert threshold accurately for this catalog.
    AdminAPI.getUnderMarginProducts('genuine', 1, 60, 'under-margin', 'net_margin', 'asc'),    // 9
    AdminAPI.getUnderMarginProducts('compatible', 1, 60, 'under-margin', 'net_margin', 'asc'), // 10
    AdminAPI.expenses.list({ limit: 1000 }),                 // 11  raw expense records → trend lines
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // Race guard — bail if a newer loadDashboard() started or the page was destroyed.
  if (mySeq !== _loadSeq || !_container) return;

  // Which sales are stopping the backend computing profit? This owns its own order fetch —
  // it must see EVERY status, and index 8 is filtered to paid|processing for the tracking
  // card. Reusing it is what made this scan blind (ERR-074). Never blocks the render: it
  // fails soft to null.
  let missingCost = null;
  try {
    missingCost = await computeMissingCostAlert({ from, to }, val(1), signal);
  } catch (err) {
    window.DebugLog?.warn?.('[Dashboard] missing-cost alert failed', err?.message || err);
  }
  if (mySeq !== _loadSeq || !_container) return;   // the await above is a fresh race window

  // Graphs come solely from the resilient bundle (per-chart isolation server-side;
  // a failed sub-chart → null key → that one tile's empty state). We deliberately
  // do NOT fan out to the per-chart endpoints on a bundle miss: that fan-out is
  // exactly what trips the 60/min limiter, and api.js already retries the bundle
  // on transient failures. A total bundle failure → all charts show their empty
  // state, which self-heals on the next load.
  const bundle = val(0);
  const graphs = bundleToGraphs(bundle);
  _container.classList.remove('admin-page--reloading');

  const UM_LIMIT = 60;
  const umResponses = [val(9), val(10)];
  const worstMargin = normalizeWorstMargin(umResponses);
  // The low-margin count is truncated (show "N+") when a source returned a full page whose
  // every row is still under the alert threshold — i.e. there are more below it than we fetched.
  const worstMarginTruncated = umResponses.some(r => {
    const rows = firstArray(r, ['data', 'rows', 'products', 'items']);
    if (rows.length < UM_LIMIT) return false;
    const pcts = rows.map(rowMarginPct).filter(p => p != null);
    return pcts.length > 0 && Math.max(...pcts) < LOW_MARGIN_PCT;
  });

  const payload = {
    isOwner: true,
    // The grain the bundle ACTUALLY served at (getDashboardBundle may have escalated past
    // a backend bucket-cap rejection). Carried in the payload — not just a module var — so
    // a stale-while-revalidate cache repaint labels its x-axis to match its own bars.
    _effectiveGranularity: (bundle && bundle._granularity) || g,
    _loadedAt: new Date().toISOString(),   // drives the "Updated …" stamp in the header
    kpis: val(1), custStats: val(2), refunds: val(3), outOfStock: val(4),
    recentOrders: val(5), topProducts: val(6), missingCost,
    trackingReq: val(7), trackingOrders: val(8),
    worstMarginSkus: worstMargin, worstMarginTruncated,
    // Raw expense records for the performance chart's Added/Total expense lines.
    // Fails soft to [] so a null expenses fetch just drops those two lines, never the page.
    expenseRows: (val(11)?.items) || [],
    ...graphs,
  };

  render(payload);
  _hasRenderedSuccessfully = true;
  _payloadCache.set(cacheKey, payload);
  if (_payloadCache.size > _PAYLOAD_CACHE_MAX) {
    _payloadCache.delete(_payloadCache.keys().next().value);
  }
}

// ---------- render ----------

function render(d) {
  if (!_container) return;
  // Latch the grain this payload was served at so fmtBucket labels the axis to match its
  // bars — works for both fresh loads and cache repaints (the value rides on the payload).
  _effectiveGranularity = d._effectiveGranularity || resolveGranularity();
  Charts.destroyAll();

  if (!d.isOwner) {
    _container.innerHTML = `
      <div class="admin-page-header"><h1>Dashboard</h1></div>
      <div class="admin-empty">
        <div class="admin-empty__title">Owner access required</div>
        <div class="admin-empty__text">The dashboard is available to store owners only.</div>
      </div>
    `;
    return;
  }

  _container.innerHTML = `
    <div class="admin-page-header admin-page-header--dash">
      <h1>Dashboard</h1>
      <span class="admin-dash__updated">Updated ${esc(timeAgo(d._loadedAt))}</span>
    </div>
    ${renderKpiStrip(d)}
    ${renderOverviewSection(d)}
    ${renderAlertsSection(d)}
    ${rowN('Products', 'cyan', [
      chartCard('Top SKUs by revenue', 'top 8', 'dash-c-sku-revenue', 4),
      chartCard('Top SKUs by gross profit', 'top 8', 'dash-c-sku-profit', 4),
      chartCard('Worst-margin SKUs', 'lowest net %', 'dash-c-sku-worst-margin', 4),
    ])}
    ${row('Search', 'magenta', chartCard('Top searches', 'by volume', 'dash-c-search-top'), chartCard('Zero-result searches', 'demand gaps', 'dash-c-search-zero'))}
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Operations <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        ${renderRecentOrdersCard(d.recentOrders)}
        ${renderFulfillmentCard(d)}
      </div>
    </section>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Money <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        <div class="admin-dash__cell--6 admin-card">
          <div class="admin-card__title"><span>Revenue &amp; gross profit <small>over time</small></span></div>
          <div class="admin-chart-box"><canvas id="dash-c-revenue-profit"></canvas></div>
        </div>
        <div class="admin-dash__cell--6 admin-card">
          <div class="admin-card__title"><span>30-day revenue estimate <small>actual + projection · trend only, bands pending</small></span></div>
          <div class="admin-chart-box"><canvas id="dash-c-forecast"></canvas></div>
        </div>
      </div>
    </section>
    ${row('Sales', 'yellow', chartCard('Orders', 'over time', 'dash-c-orders'), chartCard('Average order value', 'over time', 'dash-c-aov'))}
    ${row('Margin', 'magenta', chartCard('Gross margin by brand', '%', 'dash-c-margin-brand'), chartCard('Gross margin by category', '%', 'dash-c-margin-category'))}
    ${row('Customers', 'cyan', chartCard('New vs returning revenue', 'over time', 'dash-c-cust-type'), chartCard('Reorder interval', 'days between orders', 'dash-c-reorder'))}
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Marketing <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        ${chartCard('Traffic by source', 'sessions · approx', 'dash-c-traffic-source')}
        ${renderTopProductsCard(d.topProducts)}
      </div>
    </section>
    ${row('Risk', 'danger', chartCard('Refund rate', 'over time', 'dash-c-refund-rate'), chartCard('Refund reasons', 'share', 'dash-c-refund-reasons'))}
  `;

  drawAllCharts(d);
  wireOrderRowClicks();
  wireAlertToggles();
}

// ---------- layout helpers ----------

function chartCard(title, sub, canvasId, cell = 6) {
  return `
    <div class="admin-dash__cell--${cell} admin-card">
      <div class="admin-card__title"><span>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span></div>
      <div class="admin-chart-box"><canvas id="${canvasId}"></canvas></div>
    </div>
  `;
}

function row(label, accent, leftCard, rightCard) {
  return rowN(label, accent, [leftCard, rightCard]);
}

// N-card row variant (used by the 3-up Products row and the alerts panel). Cards carry
// their own cell-width class so a row can hold two --6 cells or three --4 cells.
function rowN(label, accent, cards) {
  const acc = accent ? ` admin-dash-row__label--${accent}` : '';
  return `
    <section class="admin-dash-row">
      <div class="admin-dash-row__label${acc}">${esc(label)} <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">${cards.join('')}</div>
    </section>
  `;
}

// Full-width real-numbers performance overview (replaces the old normalized "All metrics"
// chart). Just a tall canvas — drawPerformanceOverview fills it; no toolbar/legend wiring.
function renderOverviewSection(d) {
  // Name the series the chart ACTUALLY plots, from the same planner the chart's legend uses.
  // These were computed independently before, so the subtitle could read "gross profit"
  // while the legend said "Net profit" on the very same card.
  const { order, byBucket } = buildOverviewBuckets(d);
  const profitWord = planProfitLine(order, byBucket).label.toLowerCase();
  return `
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--cyan">Performance <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        <div class="admin-dash__cell--12 admin-card">
          <div class="admin-card__title"><span>Performance overview <small>revenue · ${esc(profitWord)} · costs · orders — real values, not normalized</small></span></div>
          <div class="admin-chart-box admin-chart-box--tall"><canvas id="dash-c-overview"></canvas></div>
          <div id="dash-overview-notes"></div>
        </div>
      </div>
    </section>
  `;
}

// ---------- action alerts ----------

// "Action needed" panel — surfaces what the owner should do today. The card itself is NOT a
// link; each row is its own clickable link to that item's page. Shows up to ALERT_PREVIEW rows
// and expands to the full list on demand (wireAlertToggles).
const ALERT_PREVIEW = 5;

function alertCard(title, count, why, items, sev, emptyMsg, span = 4) {
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

function renderAlertsSection(d) {
  const tracking = computeTrackingAlert(d.trackingReq, d.trackingOrders);
  const zero = computeZeroSearchAlert(d.searchZero);
  const lowMargin = computeLowMarginAlert(d.worstMarginSkus, d.marginBrand, d.worstMarginTruncated);
  const missingCost = d.missingCost;   // computed in loadDashboard (needs order detail)

  const lowUnit = lowMargin.grain === 'brand' ? 'brands' : 'SKUs';
  const lowWhy = `${lowUnit} under ${LOW_MARGIN_PCT}% net margin — reprice or drop`;
  const lowCount = `${lowMargin.count}${lowMargin.capped ? '+' : ''}`;

  // The fourth card has TWO jobs, and conflating them is what made it lie (ERR-074):
  //
  //   • Culprits found → the owner can fix this: open the sale, add the cost. Actionable.
  //   • No culprits, but the backend still won't hand over a profit → this is NOT the
  //     owner's data. Telling them to "add a cost to every sale" when all 84 line items
  //     already carry one sends them hunting for a problem that does not exist. That is
  //     precisely what this card did, for as long as kpi-summary has been dropping profit
  //     on ranges containing an invoiced sale.
  //
  // So the copy is chosen from what the scan actually FOUND, never from the mere fact that
  // profit is missing. "Action needed" must mean the owner can act.
  const cur = d.kpis?.current ?? {};
  const recovered = recoverProfitFromSeries(cur, d.sGrossProfit);
  const hasCulprits  = !!(missingCost && missingCost.count > 0);
  // Only cry "degraded" when the tiles are actually blank — if the series rebuild worked,
  // the dashboard is functional and the tile's own tooltip carries the provenance.
  const showDegraded = !hasCulprits && cur.gross_profit == null && !recovered;
  const showFourth   = hasCulprits || showDegraded;
  const span = showFourth ? 3 : 4;

  const cards = [
    alertCard('Orders needing tracking', tracking.count,
      'paid/processing orders awaiting tracking', tracking.items, tracking.count > 0 ? 'danger' : null, 'All caught up', span),
    alertCard('Zero-result searches', zero.count,
      `searches with ≥${ZERO_SEARCH_MIN} hits returning nothing — add products/synonyms`, zero.items, zero.count > 0 ? 'warning' : null, 'No high-volume misses', span),
    alertCard('Low-margin products', lowCount,
      lowWhy, lowMargin.items, lowMargin.count > 0 ? 'warning' : null, 'None under threshold', span),
  ];

  if (hasCulprits) {
    cards.push(alertCard(
      'Sales missing a cost', missingCost.count,
      'these sales have no cost of goods recorded, so profit can’t be computed for any range that contains them — add a cost to bring the figures back',
      missingCost.items, 'danger', 'All sales are costed', span,
    ));
  } else if (showDegraded) {
    // Every sale we could inspect is costed, yet profit is still missing. Name the real
    // suspect instead of inventing a data problem, and say how far the scan actually got —
    // a scan that couldn't finish must not be reported as a clean bill of health.
    const scanned = missingCost?.scanned ?? 0;
    const why = missingCost?.incomplete
      ? `couldn’t check every sale (${scanned} scanned) — profit is unavailable and the cause is unconfirmed`
      : `all ${scanned} sales in this range are costed, yet the backend still won’t return a profit — this is a kpi-summary defect, not your data (ERR-074)`;
    cards.push(alertCard('Profit unavailable', '—', why, [], 'warning', '', span));
  }

  return rowN('Action needed', 'danger', cards);
}

/**
 * Find the sales that are stopping the backend from computing profit — if there are any.
 *
 * A sale is un-costed in one of two ways:
 *   1. It has items, and one of them has no `supplier_cost_snapshot`.
 *   2. It has a total but ZERO items — nothing to attach a cost to. (Historically caused by
 *      an invoice whose product_code didn't resolve; the backend now repairs those.)
 *
 * ⚠ This scan used to be blind, and a blind scan is worse than no scan: it reported "0", the
 * card printed "add a cost to every sale", and every sale already had one. Three holes, all
 * of them in WHICH orders it looked at (ERR-074):
 *   • it reused the *tracking* alert's order list — `statuses: ['paid','processing']` — so
 *     `shipped` and `completed` sales, 10 of 59 on the live store, were never examined;
 *   • page 1 / limit 50, against 59 revenue orders;
 *   • only invoice-channel rows got the detail call, and the detail call is the ONLY place
 *     `supplier_cost_snapshot` is visible (the list omits it, ERR-039) — so an un-costed
 *     WEBSITE order was structurally undetectable.
 *
 * So it now owns its fetch, takes every status, paginates, and details every order. The cost
 * is a bounded fan-out of cheap cached GETs, paid once per dashboard load.
 *
 * Reports `scanned` and `incomplete` so the caller can never present a truncated or partly
 * failed scan as a clean bill of health — that conflation is the whole bug.
 */
const MISSING_COST_DETAIL_CAP = 120;   // ≫ the store's order count; a runaway backstop, not a filter
const MISSING_COST_PAGE = 100;
const MISSING_COST_MAX_PAGES = 3;
const MISSING_COST_BATCH = 6;          // keep the detail fan-out under the 60/min limiter

const isInvoiceOrder = (o) => String(o?.payment_method || '').toLowerCase() === 'invoice'
  || /^INV-/i.test(String(o?.order_number || ''));

async function computeMissingCostAlert(range, kpis, signal) {
  const cogsUnknown = kpis?.current ? kpis.current.gross_profit == null : false;
  const base = { cogsUnknown, count: 0, items: [], scanned: 0, incomplete: false };

  // Every status, not just the two the tracking card cares about. Cancelled orders carry no
  // revenue and the backend excludes them from COGS, so they're excluded here too — counting
  // them would invent culprits the backend never looks at.
  const list = [];
  let incomplete = false;
  for (let page = 1; page <= MISSING_COST_MAX_PAGES; page++) {
    const resp = await AdminAPI.getOrders({ from: range.from, to: range.to }, page, MISSING_COST_PAGE, signal);
    const rows = firstArray(resp, ['orders', 'data', 'items']);
    list.push(...rows);
    if (rows.length < MISSING_COST_PAGE) break;
    if (page === MISSING_COST_MAX_PAGES) incomplete = true;   // more pages exist than we read
  }
  const revenueOrders = list.filter(o => String(o.status || '').toLowerCase() !== 'cancelled');
  if (!revenueOrders.length) return base;

  const totalOf = (o) => Number(o.total_amount ?? o.total ?? 0) || 0;

  const budget = revenueOrders.slice(0, MISSING_COST_DETAIL_CAP);
  if (budget.length < revenueOrders.length) incomplete = true;

  const culprits = [];
  for (let i = 0; i < budget.length; i += MISSING_COST_BATCH) {
    const batch = budget.slice(i, i + MISSING_COST_BATCH);
    const results = await Promise.allSettled(batch.map(o => AdminAPI.getOrder(o.id)));
    results.forEach((res, j) => {
      const order = batch[j];
      // A detail call we couldn't make is an order we did NOT clear. Say so, don't assume.
      if (res.status !== 'fulfilled' || !res.value) { incomplete = true; return; }
      const items = res.value.items || res.value.order_items || [];
      if (!items.length && totalOf(order) > 0) {
        culprits.push({ order, reason: 'no items recorded' });
        return;
      }
      const un = items.filter(it => it.supplier_cost_snapshot == null);
      if (un.length) {
        const skus = un.map(it => it.sku || it.product_sku).filter(Boolean).slice(0, 2).join(', ');
        culprits.push({ order, reason: skus ? `no cost: ${skus}` : 'no cost recorded' });
      }
    });
  }

  return {
    cogsUnknown,
    incomplete,
    scanned: budget.length,
    count: culprits.length,
    items: culprits.map(({ order, reason }) => ({
      label: `${order.order_number || String(order.id).slice(0, 8)} · ${formatPrice(totalOf(order))}`,
      badge: reason,
      badgeCls: 'admin-badge--failed',
      // Invoiced sales are fixed in the invoice editor ("Our Cost"); a website order's
      // cost lives on the product.
      href: isInvoiceOrder(order) ? 'invoices' : `orders?search=${encodeURIComponent(order.order_number || '')}`,
    })),
  };
}

// Expand/collapse the alert item lists (show all ↔ show first ALERT_PREVIEW).
function wireAlertToggles() {
  _container?.querySelectorAll('[data-alert-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = btn.previousElementSibling;
      const collapsed = list?.classList.toggle('admin-alert-card__list--collapsed');
      const total = list?.querySelectorAll('.admin-alert-card__item').length || 0;
      btn.textContent = collapsed ? `Show all ${total}` : 'Show less';
    });
  });
}

// Fulfillment card for the Operations row — a compact list of paid/processing orders that
// still need tracking, each clickable through to the order. Complements the alert count.
function renderFulfillmentCard(d) {
  const orders = firstArray(d.trackingOrders, ['orders', 'data', 'items'])
    .filter(o => !o.tracking_number)
    .slice(0, 8);
  if (!orders.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Needs tracking <small>paid · processing</small></div>
        <div class="admin-dash-inline-empty">Nothing awaiting tracking 🎉</div>
      </div>
    `;
  }
  const rows = orders.map(o => {
    const id = o.order_number || o.id || '';
    const who = o.customer_name || o.customer_email || o.email || 'Guest';
    const status = (o.status || 'pending').toLowerCase();
    const when = timeAgo(o.created_at || o.createdAt);
    return `
      <tr data-order-id="${esc(String(o.id || id))}">
        <td class="cell-mono">${esc(String(id).slice(-8))}</td>
        <td class="cell-truncate">${esc(who)}</td>
        <td><span class="admin-badge admin-badge--${esc(status)}">${esc(status)}</span></td>
        <td class="cell-muted cell-mono">${esc(when)}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Needs tracking <small>paid · processing</small></span>
        <a href="#tracking-requests" class="admin-mini-card__sub">View all →</a>
      </div>
      <table class="admin-dash-table">
        <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>When</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ---------- KPI band ----------

function renderKpiTile(t, extraClass = '', noDelta = false) {
  const alertCls = t.alert ? ' admin-kpi--alert' : '';
  const tipAttr = t.tooltip ? ` data-tooltip="${esc(t.tooltip)}"` : '';
  let h = `<div class="admin-kpi admin-kpi--compact${alertCls}${extraClass}">`;
  h += `<div class="admin-kpi__label"${tipAttr}>${esc(t.label)}</div>`;
  if (t.value != null) {
    h += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
    // In all-time view every "previous" is 0, so deltas read "↑ new" everywhere — noise.
    if (!noDelta) h += deltaBadge(t.raw, t.prev, t.deltaOpts || {});
  } else {
    h += missingValue(t.tooltip || 'Data unavailable');
  }
  h += '</div>';
  return h;
}

// Format a backend margin field as a percent. Margins arrive as percentages (e.g. 33.2);
// guard the rare fraction shape (≤1.5 → ×100) so 0.33 doesn't render as "0.3%".
function fmtPct(v) {
  if (v == null) return null;
  let n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1.5) n *= 100;
  return `${n.toFixed(1)}%`;
}

/**
 * Decide what the Performance chart's profit line actually plots, and say so honestly.
 *
 * The backend ships a real per-bucket `net_profit_series` (rows carry `net_profit`,
 * `stripe_fees` and `operating_expenses`), and since migration 118 it reconciles to
 * `kpi-summary.net_profit` by construction — verified live 2026-07-20 across four windows,
 * residual ≤ 2c over 30 buckets. So we plot the backend's number directly.
 *
 * We used to PRORATE two whole-range scalars across buckets to force the line onto the KPI
 * tile (ERR-106's `buildReconciledNetSeries`). That is gone: it manufactured per-bucket
 * figures the backend never published. When the backend can't say what net was in a bucket,
 * the honest answer is to plot gross profit and CALL IT gross profit — never to invent net.
 *
 * @param order    string[]  bucket keys, chronological
 * @param byBucket Map       bucket key -> { revenue, grossProfit, netProfit, fees, opex, orders }
 * @returns {{ values:(number|null)[], label:string, basis:string, knownCount:number,
 *            nullCount:number, seriesTotal:number|null, complete:boolean }}
 *   `basis` is 'net-series' or 'gross-fallback'. Callers MUST read `label`/`basis` rather
 *   than assuming "net" — that assumption is what let the card subtitle and the chart legend
 *   drift apart. Nulls stay null (a gap, never a confident 0 — ERR-028).
 */
function planProfitLine(order, byBucket) {
  const gross = order.map(b => numOrNull(byBucket.get(b)?.grossProfit));
  const net   = order.map(b => numOrNull(byBucket.get(b)?.netProfit));
  const netKnown = net.filter(v => v != null).length;

  // No usable net anywhere → plot gross and label it gross. An all-null net series is NOT
  // a run of $0 net; it means the backend didn't answer, so we must not answer for it.
  const useNet = netKnown > 0;
  const values = useNet ? net : gross;

  let knownCount = 0, total = 0;
  for (const v of values) if (v != null) { knownCount++; total += v; }
  const nullCount = values.length - knownCount;

  return {
    values,
    label: useNet ? 'Net profit' : 'Gross profit',
    basis: useNet ? 'net-series' : 'gross-fallback',
    knownCount,
    nullCount,
    seriesTotal: knownCount ? total : null,
    complete: knownCount > 0 && nullCount === 0,
  };
}

/**
 * Guard: the per-bucket profit series and the headline KPI tile must agree.
 *
 * Both figures are now the BACKEND'S — the frontend reconstructs nothing — so a trip here
 * means the backend disagrees with itself, not that the chart is wrong. The caller surfaces
 * that on the card, because the last time this broke the console warning fired and nobody
 * saw it (ERR-074 → ERR-106 → this).
 *
 * Tolerance scales with bucket count. `Σ series` sums per-bucket-rounded values while the
 * RPC rounds once, so a residual of ~1c per bucket is expected and harmless (measured: 2c
 * over 30 buckets). A real basis regression is orders of magnitude larger — the original
 * defect was $1,088 (revenue GST booked as profit) — so 2c/bucket cannot mask one. The 5c
 * floor stops a single-bucket range from tripping on ordinary float noise.
 *
 * @returns null when there is nothing to say, else { seriesTotal, kpiNet, gap, tolerance }.
 */
function checkNetDrift(plan, kpiNet, bucketCount) {
  // A PARTIAL series has nothing to say about backend self-consistency: its sum is a subset
  // of the range the KPI covers, so any comparison is meaningless. The old guard summed
  // nulls as 0 against a full-range KPI and false-alarmed on every gapped series.
  if (!plan || !plan.complete || plan.basis !== 'net-series') return null;
  if (kpiNet == null || !Number.isFinite(kpiNet)) return null;
  const seriesTotal = plan.seriesTotal;
  if (seriesTotal == null || !Number.isFinite(seriesTotal)) return null;

  const n = Number.isFinite(bucketCount) && bucketCount > 0 ? bucketCount : 1;
  const tolerance = Math.max(0.05, 0.02 * n);
  const gap = seriesTotal - kpiNet;
  if (Math.abs(gap) <= tolerance) return null;
  return { seriesTotal, kpiNet, gap, tolerance };
}

/**
 * Rebuild Gross/Net Profit from the backend's own per-bucket series when kpi-summary
 * drops them.
 *
 * `kpi-summary` returns `gross_profit: null` (and `net_profit`, `margin_proxy`) for ANY
 * range containing an invoiced sale — even though those sales' lines all carry a real
 * `supplier_cost_snapshot`. Measured against live data 2026-07-14 by probing the endpoint
 * one week at a time: 17 of 19 weeks returned a real gross profit; the only two that
 * nulled were the two holding the three INV- shadow orders. All 84 line items across all
 * 59 revenue orders are costed. Nothing is missing a cost — the summary endpoint is simply
 * dropping the figure. Backend defect (ERR-074).
 *
 * The same backend computes a real gross profit for those very weeks in
 * `gross_profit_series`. The number exists; only one endpoint loses it.
 *
 * This is NOT the frontend inventing COGS — that is banned (ERR-028) and stays banned.
 * Every input below is a figure the backend published and vouches for:
 *     gross = Σ gross_profit_series[].gross_profit   (the backend's own weekly figures)
 *     net   = gross − stripe_fees − operating_expenses
 * That net formula is kpi-summary's own, fed by its own still-non-null fields; it was
 * verified to the cent against four un-poisoned weeks before being relied on here.
 *
 * Honesty gates — returns null (leaving the tiles at "—") unless ALL hold:
 *   • kpi-summary genuinely nulled gross_profit — a real backend figure always wins
 *   • the series exists and is non-empty
 *   • EVERY bucket is non-null. One unknown bucket means COGS really is unknown somewhere
 *     in the range, and then "—" is the honest answer. ERR-028 stands.
 *   • stripe_fees / operating_expenses are themselves known, or `net` stays null on its own
 *
 * Self-disabling: each half is skipped the moment kpi-summary returns that figure, so a
 * healthy backend retires this with no coordination and no second deploy. As of 2026-07-20
 * the live payload carries both, so this returns null and nothing below runs — it is pure
 * insurance. Kept rather than deleted because this exact endpoint has already regressed
 * once (see readfirst/backend-open-items-jul2026.md §1).
 *
 * Provenance is reported PER FIGURE (`grossRebuilt` / `netRebuilt`). A single flag used to
 * stamp "Rebuilt…" on both tiles whenever either was rebuilt, mislabelling a real backend
 * number as reconstructed.
 */
function recoverProfitFromSeries(cur, grossProfitSeries, netProfitSeries) {
  if (!cur) return null;

  // Sum a per-bucket series, but only if EVERY bucket is known. One unknown bucket means
  // the range total is unknown, and "—" is the honest answer (ERR-028).
  const sumComplete = (series, key) => {
    const rows = resolveList(series, ['series', 'data']);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let total = 0;
    for (const r of rows) {
      const v = numOrNull(r[key]);
      if (v == null) return null;   // unknown bucket → unknown range. Don't guess.
      total += v;
    }
    return total;
  };

  // ── Gross half ── fires only when kpi-summary dropped its own figure.
  const grossRebuilt = cur.gross_profit == null;
  const gross = grossRebuilt ? sumComplete(grossProfitSeries, 'gross_profit') : numOrNull(cur.gross_profit);

  // ── Net half ── gated INDEPENDENTLY of gross. Previously the whole function bailed when
  // gross_profit was present, so a real gross alongside a null net left the Net tile blank
  // even with a complete net_profit_series sitting in the same bundle.
  const netRebuilt = cur.net_profit == null;
  let net = netRebuilt ? null : numOrNull(cur.net_profit);
  if (netRebuilt) {
    const fees = numOrNull(cur.stripe_fees);
    const opex = numOrNull(cur.operating_expenses);
    // PRIMARY: kpi-summary's own formula off its own range-exact scalars. Deliberately
    // preferred over summing the series — `Σ series` carries per-bucket rounding (~1c per
    // bucket), while these scalars are rounded once for the whole range.
    if (gross != null && fees != null && opex != null) {
      net = gross - fees - opex;
    } else {
      // FALLBACK: the backend's per-bucket net. Costs a few cents of rounding, but it is a
      // real published figure and beats leaving the tile blank.
      net = sumComplete(netProfitSeries, 'net_profit');
    }
  }

  // Nothing rebuilt and nothing recovered → behave exactly as if this function didn't exist.
  if (!grossRebuilt && !netRebuilt) return null;
  if (gross == null && net == null) return null;

  return {
    gross,
    net,
    grossRebuilt: grossRebuilt && gross != null,
    netRebuilt:   netRebuilt   && net   != null,
  };
}

function renderKpiStrip(d) {
  // Invoiced sales are counted by the BACKEND (kpi-summary carries
  // includes_invoices: true). The frontend does not aggregate — it renders.
  const cur  = d.kpis?.current ?? {};
  const prev = d.kpis?.previous ?? {};
  const cc   = d.custStats?.current  ?? {};
  const cp   = d.custStats?.previous ?? {};

  const aov     = cur.aov ?? safeDiv(cur.revenue, cur.orders);
  const aovPrev = prev.aov ?? safeDiv(prev.revenue, prev.orders);

  const refundTotal = sumRefundAmounts(d.refunds);
  const refundPct   = cur.refund_rate != null
    ? Number(cur.refund_rate)
    : (refundTotal != null && cur.revenue ? (refundTotal / cur.revenue) * 100 : null);

  const oosCount = outOfStockCount(d.outOfStock);
  const newCustomers     = cc.new_customers ?? cc.new ?? null;
  const newCustomersPrev = cp.new_customers ?? cp.new ?? null;
  const noDelta = FilterState.get('period') === 'all';   // all-time → deltas are meaningless

  // kpi-summary drops profit for any range holding an invoiced sale (ERR-074). When it does,
  // rebuild both figures from the backend's own weekly gross-profit series. Null → the tiles
  // stay "—", exactly as before. There is no previous-period series, so `prev` is left alone
  // and the delta badges simply don't render — honest, rather than a delta against a guess.
  const recovered  = recoverProfitFromSeries(cur, d.sGrossProfit, d.sNetProfit);
  const grossProfit = cur.gross_profit ?? recovered?.gross ?? null;
  const netProfit   = cur.net_profit   ?? recovered?.net   ?? null;

  // Backend kpi-summary omits gross_margin/net_margin → derive it. The base MUST be ex-GST
  // revenue: profit is measured net of GST (migration 118), so dividing it by GST-inclusive
  // revenue understates every margin by ~13%. Live 2026-07-20 that read 19.1% where the
  // backend's own margin_proxy said 21.9% (1591.20 / 7254.04). Prefer the backend's figure
  // when it ships one, exactly as we do for every other number on this page.
  const exGst = (revenue) => (revenue != null && Number.isFinite(Number(revenue)))
    ? Number(revenue) * (20 / 23)
    : null;
  const marginOf = (profit, revenue) => {
    const base = exGst(revenue);
    return (profit != null && base) ? (profit / base) * 100 : null;
  };
  const grossMarginPct     = cur.gross_margin  != null ? Number(cur.gross_margin)
                           : cur.margin_proxy  != null ? Number(cur.margin_proxy)
                           : marginOf(grossProfit, cur.revenue);
  const grossMarginPctPrev = prev.gross_margin != null ? Number(prev.gross_margin)
                           : prev.margin_proxy != null ? Number(prev.margin_proxy)
                           : marginOf(prev.gross_profit, prev.revenue);
  const netMarginPct       = cur.net_margin    != null ? Number(cur.net_margin)    : marginOf(netProfit, cur.revenue);
  const netMarginPctPrev   = prev.net_margin   != null ? Number(prev.net_margin)   : marginOf(prev.net_profit, prev.revenue);

  // "—" on a profit tile is the honest answer when the backend can't compute COGS
  // (a sale with an un-costed line). The Action-needed panel names the offenders.
  const COGS_UNKNOWN = ' Shows "—" when any sale in the range has no cost of goods recorded — see "Sales missing a cost" under Action needed.';
  // …but when we rebuilt the figure, say so on the tile rather than passing it off as the
  // summary endpoint's own number.
  const REBUILT = ' Rebuilt from the backend’s own per-period series because kpi-summary dropped this figure for the selected range (ERR-074).';
  // Provenance PER FIGURE. One shared flag used to stamp "Rebuilt…" on both tiles whenever
  // either was rebuilt — claiming a real backend number was reconstructed.
  const grossNote = recovered?.grossRebuilt ? REBUILT : COGS_UNKNOWN;
  const netNote   = recovered?.netRebuilt   ? REBUILT : COGS_UNKNOWN;

  const tiles = [
    { label: 'Revenue', value: cur.revenue != null ? formatPrice(cur.revenue) : null, raw: cur.revenue, prev: prev.revenue,
      tooltip: 'Total sales (incl. GST) for the selected range. Includes invoiced (phone / walk-in / B2B) sales.' },
    {
      label: 'Gross Profit', value: grossProfit != null ? formatPrice(grossProfit) : null,
      raw: grossProfit, prev: prev.gross_profit, stackNext: true,
      tooltip: `Revenue (ex-GST) − cost of goods (ex-GST), computed by the backend.${grossNote}`,
    },
    {
      label: 'Gross Margin', value: fmtPct(grossMarginPct), raw: grossMarginPct, prev: grossMarginPctPrev,
      tooltip: 'Gross profit ÷ revenue, both ex-GST. Profit quality, not size.',
    },
    {
      label: 'Net Profit', value: netProfit != null ? formatPrice(netProfit) : null,
      raw: netProfit, prev: prev.net_profit, alert: netProfit != null && netProfit < 0, stackNext: true,
      // No separate "− GST" term: since migration 118 every figure below revenue is ex-GST,
      // so GST is already outside this calculation rather than a line item inside it.
      tooltip: `Gross profit − Stripe fees − operating expenses, all ex-GST, computed by the backend. Invoiced sales carry no card fee (bank transfer).${netNote}`,
    },
    {
      label: 'Net Margin', value: fmtPct(netMarginPct), raw: netMarginPct, prev: netMarginPctPrev,
      alert: netMarginPct != null && netMarginPct < 0,
      tooltip: 'Net profit ÷ revenue, both ex-GST. What you actually keep.',
    },
    { label: 'Orders', value: cur.orders != null ? String(cur.orders) : null, raw: cur.orders, prev: prev.orders,
      tooltip: 'Paid orders placed in the selected range. Includes invoiced sales.' },
    { label: 'Avg Order Value', value: aov != null ? formatPrice(aov) : null, raw: aov, prev: aovPrev,
      tooltip: 'Revenue ÷ orders.' },
    { label: 'New Customers', value: newCustomers != null ? String(newCustomers) : null, raw: newCustomers, prev: newCustomersPrev,
      tooltip: 'First-time buyers in the range.' },
    {
      label: 'Returning %', value: cc.returning_pct != null ? `${cc.returning_pct}%` : null,
      raw: cc.returning_pct, prev: cp.returning_pct, tooltip: 'Share of buyers who had ordered before. Requires analytics_customer_stats.',
    },
    {
      label: 'Refund Rate', value: refundPct != null ? `${refundPct.toFixed(1)}%` : null,
      alert: refundPct != null && refundPct > 3, tooltip: 'Refunded value ÷ revenue. Flagged above 3%.',
    },
    {
      label: 'Out of Stock', value: oosCount != null ? String(oosCount) : null,
      alert: oosCount > 0, tooltip: 'Products currently flagged out of stock.',
    },
  ];

  // Each profit tile (stackNext) shares one grid cell with the margin % tile that follows it
  // — so Gross/Net profit and their margins ride together and the strip stays at 9 cells.
  let html = '<div class="admin-kpi-grid admin-kpi-grid--9">';
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const next = tiles[i + 1];
    if (t.stackNext && next) {
      html += '<div class="admin-kpi-stack">'
            + renderKpiTile(t, ' admin-kpi--half', noDelta)
            + renderKpiTile(next, ' admin-kpi--half', noDelta)
            + '</div>';
      i += 1;
      continue;
    }
    html += renderKpiTile(t, '', noDelta);
  }
  html += '</div>';
  return html;
}

// ---------- supplementary tables ----------

function renderRecentOrdersCard(data) {
  const orders = firstArray(data, ['orders', 'data', 'items']);
  if (!orders.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Recent Orders <small>latest</small></div>
        <div class="admin-dash-inline-empty">No recent orders</div>
      </div>
    `;
  }

  let rows = '';
  for (const o of orders.slice(0, 8)) {
    const id = o.order_number || o.id || '';
    const who = o.customer_name || o.customer_email || o.email || o.user_email || 'Guest';
    const total = o.total ?? o.amount ?? 0;
    const status = (o.status || 'pending').toLowerCase();
    const when = timeAgo(o.created_at || o.createdAt);
    rows += `
      <tr data-order-id="${esc(String(o.id || id))}">
        <td class="cell-mono">${esc(String(id).slice(-8))}</td>
        <td class="cell-truncate">${esc(who)}</td>
        <td class="cell-mono cell-right">${esc(formatPrice(total))}</td>
        <td><span class="admin-badge admin-badge--${esc(status)}">${esc(status)}</span></td>
        <td class="cell-muted cell-mono">${esc(when)}</td>
      </tr>
    `;
  }

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Recent Orders <small>latest ${orders.length}</small></span>
        <a href="#orders" class="admin-mini-card__sub">View all →</a>
      </div>
      <table class="admin-dash-table">
        <thead><tr>
          <th>Order</th><th>Customer</th><th class="cell-right">Total</th><th>Status</th><th>When</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function wireOrderRowClicks() {
  _container?.querySelectorAll('.admin-dash-table tbody tr[data-order-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-order-id');
      if (id) window.location.hash = `orders?order=${encodeURIComponent(id)}`;
    });
  });
}

function renderTopProductsCard(data) {
  const items = Array.isArray(data) ? data : (data ? firstArray(data, ['products', 'items', 'data']) : []);
  if (!items.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Most Bought <small>top sellers</small></div>
        <div class="admin-dash-inline-empty">Top product data unavailable</div>
      </div>
    `;
  }

  const rows = items.slice(0, 10).map(p => {
    const name = p.product_name || p.name || p.sku || 'Unknown';
    const brand = p.brand || '';
    const units = p.units_sold ?? p.units ?? p.quantity ?? p.qty ?? p.quantity_sold ?? null;
    const revenue = p.revenue ?? p.total ?? 0;
    return `
      <tr>
        <td class="cell-truncate">${esc(name)}</td>
        <td class="cell-muted">${esc(brand)}</td>
        <td class="cell-mono cell-right">${units != null ? esc(String(units)) : MISSING}</td>
        <td class="cell-mono cell-right">${esc(formatPrice(revenue))}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Most Bought <small>top ${Math.min(items.length, 10)}</small></span>
        <a href="#products" class="admin-mini-card__sub">View products →</a>
      </div>
      <table class="admin-dash-table">
        <thead><tr>
          <th>Product</th><th>Brand</th><th class="cell-right">Units</th><th class="cell-right">Revenue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ---------- page lifecycle ----------

export default {
  title: 'Dashboard',

  async init(container) {
    _container = container;
    // Dashboard-local defaults (range = all) applied only when the URL omits them,
    // and the bar-width control shown for this page only.
    FilterState.setDefaults({ period: 'all', granularity: 'all' });
    FilterState.setGranularityVisible(true);
    await loadDashboard();
  },

  destroy() {
    Charts.destroyAll();
    FilterState.setGranularityVisible(false);   // hide bar-width control on other pages
    _container = null;
    _hasRenderedSuccessfully = false;
    _loadSeq++;                                  // any in-flight load now stale-checks and bails
  },

  async onFilterChange() {
    if (_container) await loadDashboard();
  },
};
