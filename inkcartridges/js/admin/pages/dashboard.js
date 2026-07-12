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
import { fetchInvoiceDelta, backendCountsInvoices, overlayNote } from '../utils/invoice-overlay.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;
const MISSING = '—';
const AWAIT_MSG = 'Awaiting data — backend endpoint pending';
const EMPTY_MSG = 'No data for this range';

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
    const low = worstMarginSkus.filter(r => r._marginPct < LOW_MARGIN_PCT);
    return {
      count: low.length, capped: !!truncated, grain: 'sku',
      items: low.map(r => ({ label: r._label, badge: `${Number(r._marginPct).toFixed(1)}%`, badgeCls: 'admin-badge--failed', href: `products?search=${encodeURIComponent(r.sku || r._label)}` })),
    };
  }
  const brands = firstArray(marginBrand, ['brands', 'data']);
  const low = brands
    .map(b => ({ label: b.brand || MISSING, pct: Number(b.margin_pct) }))
    .filter(b => Number.isFinite(b.pct) && b.pct < LOW_MARGIN_PCT)
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
    const raw = list.map(r => Number(r[key] || 0));
    if (!cumulative) return raw;
    let acc = 0;
    return raw.map(v => (acc += v));
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
  if (sort) rows.sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0));
  rows = rows.slice(0, limit);

  const c = Charts.getThemeColors();
  const labels = rows.map(r => String(r[labelKey] ?? MISSING));
  const data = rows.map(r => Number(r[valueKey] || 0));
  const valFmt = (v) => isMoney ? formatPrice(v) : isPercent ? `${Number(v).toFixed(1)}%` : String(v);
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
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${valFmt(ctx.raw || 0)}` } },
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
      byBucket.get(b)[dstKey] = Number(r[srcKey] || 0);
    }
  };
  merge(revList, 'revenue', 'revenue');
  merge(gpList, 'gross_profit', 'gross_profit');
  if (!order.length) { chartEmpty(canvasId, EMPTY_MSG); return; }
  order.sort(); // "YYYY-MM-DD" sorts chronologically

  const c = Charts.getThemeColors();
  const labels = order.map(fmtBucket);
  const plot = isCumulativeMode();
  const accum = (arr) => { if (!plot) return arr; let acc = 0; return arr.map(v => (acc += v)); };
  const revenue = accum(order.map(b => Number(byBucket.get(b)?.revenue || 0)));
  const profit  = accum(order.map(b => Number(byBucket.get(b)?.gross_profit || 0)));

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
function drawPerformanceOverview(d) {
  const canvasId = 'dash-c-overview';
  const revList = resolveList(d.sRevenue, ['series', 'data']) || [];
  const gpList  = resolveList(d.sGrossProfit, ['series', 'data']) || [];
  const npList  = resolveList(d.sNetProfit, ['series', 'data']);
  const ordList = resolveList(d.sOrders, ['series', 'data']) || [];

  // Prefer the real per-bucket net-profit series; fall back to the gross-profit series
  // (relabeled) until the backend ships net_profit_series. See readfirst handoff.
  const hasNet = Array.isArray(npList) && npList.length > 0;
  const profitList = hasNet ? npList : gpList;

  const byBucket = new Map(); // bucket_start -> { revenue, profit, orders }
  const order = [];
  const merge = (list, valFn, dstKey) => {
    for (const r of list) {
      const b = r.bucket_start ?? r.date;
      if (!byBucket.has(b)) { byBucket.set(b, {}); order.push(b); }
      byBucket.get(b)[dstKey] = valFn(r);
    }
  };
  merge(revList, (r) => Number(r.revenue || 0), 'revenue');
  merge(profitList, (r) => Number(r.net_profit ?? r.gross_profit ?? 0), 'profit');
  merge(ordList, (r) => Number(r.orders || 0), 'orders');
  if (!order.length) { chartEmpty(canvasId, d.sRevenue == null ? AWAIT_MSG : EMPTY_MSG); return; }
  order.sort(); // "YYYY-MM-DD" sorts chronologically

  const c = Charts.getThemeColors();
  const labels = order.map(fmtBucket);
  const plot = isCumulativeMode();
  const accum = (arr) => { if (!plot) return arr; let acc = 0; return arr.map(v => (acc += v)); };
  const revenue = accum(order.map(b => Number(byBucket.get(b)?.revenue || 0)));
  const profit  = accum(order.map(b => Number(byBucket.get(b)?.profit || 0)));
  const orders  = accum(order.map(b => Number(byBucket.get(b)?.orders || 0)));

  const drawType = plot ? 'line' : 'bar';
  const mkMoney = (label, data, color) => drawType === 'line'
    ? { label, data, yAxisID: 'y', borderColor: color, backgroundColor: hexToRgba(color, 0.16),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4 }
    : { label, data, yAxisID: 'y', backgroundColor: color + 'cc', borderRadius: 4,
        barPercentage: 0.7, categoryPercentage: 0.8 };

  const datasets = [
    mkMoney('Revenue', revenue, c.success),
    mkMoney('Net profit', profit, c.cyan),
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
        } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
        y:  { beginAtZero: true, min: 0, position: 'left',  ticks: { callback: (v) => formatPrice(v) } },
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
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // Race guard — bail if a newer loadDashboard() started or the page was destroyed.
  if (mySeq !== _loadSeq || !_container) return;

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

  // Invoiced sales (phone / walk-in / B2B) are real orders the backend doesn't
  // know about yet, so the KPI band would understate the business. Add them
  // client-side — SCALAR TILES ONLY, never the charts. Self-disables the moment
  // the backend starts including them. See utils/invoice-overlay.js.
  const kpis = val(1);
  const invoiceDelta = backendCountsInvoices(kpis) ? null : await fetchInvoiceDelta({ from, to });
  if (mySeq !== _loadSeq || !_container) return;   // the await above is a new race window

  const payload = {
    isOwner: true,
    invoiceDelta,
    // The grain the bundle ACTUALLY served at (getDashboardBundle may have escalated past
    // a backend bucket-cap rejection). Carried in the payload — not just a module var — so
    // a stale-while-revalidate cache repaint labels its x-axis to match its own bars.
    _effectiveGranularity: (bundle && bundle._granularity) || g,
    _loadedAt: new Date().toISOString(),   // drives the "Updated …" stamp in the header
    kpis, custStats: val(2), refunds: val(3), outOfStock: val(4),
    recentOrders: val(5), topProducts: val(6),
    trackingReq: val(7), trackingOrders: val(8),
    worstMarginSkus: worstMargin, worstMarginTruncated,
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
    ${renderOverviewSection()}
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
function renderOverviewSection() {
  return `
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--cyan">Performance <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        <div class="admin-dash__cell--12 admin-card">
          <div class="admin-card__title"><span>Performance overview <small>revenue · net profit · orders — real values, not normalized</small></span></div>
          <div class="admin-chart-box admin-chart-box--tall"><canvas id="dash-c-overview"></canvas></div>
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

function alertCard(title, count, why, items, sev, emptyMsg) {
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
    <div class="admin-dash__cell--4 admin-card admin-alert-card${sev ? ' admin-alert-card--' + sev : ''}">
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

  const lowUnit = lowMargin.grain === 'brand' ? 'brands' : 'SKUs';
  const lowWhy = `${lowUnit} under ${LOW_MARGIN_PCT}% net margin — reprice or drop`;
  const lowCount = `${lowMargin.count}${lowMargin.capped ? '+' : ''}`;

  return rowN('Action needed', 'danger', [
    alertCard('Orders needing tracking', tracking.count,
      'paid/processing orders awaiting tracking', tracking.items, tracking.count > 0 ? 'danger' : null, 'All caught up'),
    alertCard('Zero-result searches', zero.count,
      `searches with ≥${ZERO_SEARCH_MIN} hits returning nothing — add products/synonyms`, zero.items, zero.count > 0 ? 'warning' : null, 'No high-volume misses'),
    alertCard('Low-margin products', lowCount,
      lowWhy, lowMargin.items, lowMargin.count > 0 ? 'warning' : null, 'None under threshold'),
  ]);
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
    // t.note flags a tile whose value we adjusted client-side (invoiced sales) —
    // the number must never be quietly different from what the backend returned.
    if (t.note) h += `<div class="admin-kpi__note">${esc(t.note)}</div>`;
    // In all-time view every "previous" is 0, so deltas read "↑ new" everywhere — noise.
    // A tile can also opt out individually (t.noDelta) when its current value is
    // overlaid but its previous value isn't — comparing the two would invent growth.
    if (!noDelta && !t.noDelta) h += deltaBadge(t.raw, t.prev, t.deltaOpts || {});
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
 * Fold invoiced sales into the backend's current-period KPIs.
 *
 * Bumps the COMPONENTS (revenue, orders, gross/net profit) and then DELETES the
 * derived fields (aov, gross_margin, net_margin) so renderKpiStrip's existing
 * "derive from components when the backend omits them" fallbacks recompute them
 * from the new totals. Leaving the backend's derived values in place would show
 * a margin computed against website-only revenue — right numerator, wrong
 * denominator.
 *
 * Profit is only bumped when the delta knows every invoice's cost. Otherwise the
 * profit tiles keep the backend's website-only figure: understated, but honest.
 * Revenue and Orders always bump — we know those regardless of cost.
 */
function withInvoices(cur, delta) {
  if (!delta || !delta.count) return cur;
  const out = { ...cur };
  const bump = (k, v) => { if (out[k] != null && v != null) out[k] = Number(out[k]) + Number(v); };
  bump('revenue', delta.revenueInclGst);   // kpi-summary.revenue is INCL-GST
  bump('orders', delta.orders);
  if (delta.costsKnown) {
    bump('gross_profit', delta.grossProfit);
    bump('net_profit', delta.netProfit);
  }
  delete out.aov;
  delete out.gross_margin;
  delete out.net_margin;
  return out;
}

function renderKpiStrip(d) {
  const delta = d.invoiceDelta;
  const overlaid = !!(delta && delta.count);
  const cur  = withInvoices(d.kpis?.current ?? {}, delta);
  // The previous period is NOT overlaid (that would need a second fetch), so a
  // delta badge would compare invoices-included against website-only and invent a
  // jump. Suppress the badge on the tiles we touched rather than lie about growth.
  const prev = d.kpis?.previous ?? {};
  const cc   = d.custStats?.current  ?? {};
  const cp   = d.custStats?.previous ?? {};
  const note = overlaid ? overlayNote(delta) : '';
  const invTile = (extra = {}) => overlaid ? { note: 'incl. invoiced sales', noDelta: true, ...extra } : {};
  const profitOverlaid = overlaid && delta.costsKnown;

  const aov     = cur.aov ?? safeDiv(cur.revenue, cur.orders);
  const aovPrev = prev.aov ?? safeDiv(prev.revenue, prev.orders);

  const refundTotal = sumRefundAmounts(d.refunds);
  const refundPct   = cur.refund_rate != null
    ? Number(cur.refund_rate)
    : (refundTotal != null && cur.revenue ? (refundTotal / cur.revenue) * 100 : null);

  const oosCount = outOfStockCount(d.outOfStock);
  const newCustomers     = cc.new_customers ?? cc.new ?? null;
  const newCustomersPrev = cp.new_customers ?? cp.new ?? null;
  const netProfit = cur.net_profit ?? null;
  const noDelta = FilterState.get('period') === 'all';   // all-time → deltas are meaningless

  // Backend kpi-summary omits gross_margin/net_margin → derive from profit ÷ revenue (matches
  // how the headline tiles read). Uses each profit's own revenue base; null when revenue is 0.
  const marginOf = (profit, revenue) =>
    profit != null && revenue ? (profit / revenue) * 100 : null;
  const grossMarginPct     = cur.gross_margin  != null ? Number(cur.gross_margin)  : marginOf(cur.gross_profit, cur.revenue);
  const grossMarginPctPrev = prev.gross_margin != null ? Number(prev.gross_margin) : marginOf(prev.gross_profit, prev.revenue);
  const netMarginPct       = cur.net_margin    != null ? Number(cur.net_margin)    : marginOf(netProfit, cur.revenue);
  const netMarginPctPrev   = prev.net_margin   != null ? Number(prev.net_margin)   : marginOf(prev.net_profit, prev.revenue);

  const tiles = [
    { label: 'Revenue', value: cur.revenue != null ? formatPrice(cur.revenue) : null, raw: cur.revenue, prev: prev.revenue,
      tooltip: `Total sales (incl. GST) for the selected range.${note}`, ...invTile() },
    {
      label: 'Gross Profit', value: cur.gross_profit != null ? formatPrice(cur.gross_profit) : null,
      raw: cur.gross_profit, prev: prev.gross_profit, stackNext: true,
      tooltip: profitOverlaid
        ? `Revenue (ex-GST) − COGS.${note}`
        : (overlaid
          ? 'Revenue (ex-GST) − COGS, computed by the backend. Website orders only — invoiced sales are excluded until their cost of goods is recorded.'
          : 'Revenue (ex-GST) − COGS, computed by the backend.'),
      ...(profitOverlaid ? invTile() : {}),
    },
    {
      label: 'Gross Margin', value: fmtPct(grossMarginPct), raw: grossMarginPct, prev: grossMarginPctPrev,
      tooltip: 'Gross profit ÷ revenue. Profit quality, not size.',
      ...(profitOverlaid ? { noDelta: true } : {}),
    },
    {
      label: 'Net Profit', value: netProfit != null ? formatPrice(netProfit) : null,
      raw: netProfit, prev: prev.net_profit, alert: netProfit != null && netProfit < 0, stackNext: true,
      tooltip: profitOverlaid
        ? `Revenue − COGS − fees − GST − Opex. Invoiced sales carry no card fee (bank transfer).${note}`
        : 'Revenue − COGS − fees − GST − Opex, computed by the backend.',
      ...(profitOverlaid ? invTile() : {}),
    },
    {
      label: 'Net Margin', value: fmtPct(netMarginPct), raw: netMarginPct, prev: netMarginPctPrev,
      alert: netMarginPct != null && netMarginPct < 0,
      tooltip: 'Net profit ÷ revenue. What you actually keep.',
      ...(profitOverlaid ? { noDelta: true } : {}),
    },
    { label: 'Orders', value: cur.orders != null ? String(cur.orders) : null, raw: cur.orders, prev: prev.orders,
      tooltip: `Paid orders placed in the selected range.${note}`, ...invTile() },
    { label: 'Avg Order Value', value: aov != null ? formatPrice(aov) : null, raw: aov, prev: aovPrev,
      tooltip: 'Revenue ÷ orders.', ...(overlaid ? { noDelta: true } : {}) },
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
