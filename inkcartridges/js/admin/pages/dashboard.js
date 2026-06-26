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

// Last successful render payload, keyed by the active filter signature. Survives SPA
// navigation (NOT cleared in destroy) so returning to the dashboard paints instantly,
// then revalidates in the background (stale-while-revalidate). In-memory only.
const _payloadCache = new Map();
const _PAYLOAD_CACHE_MAX = 12;

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

// Resolve the active bar-width sent to the backend. An explicit granularity wins
// — but is CLAMPED coarser if it would exceed the backend's ~750-bucket cap for
// the real window span (else the request 400s and blanks every chart). 'auto'
// derives a sensible bucket from the span. FilterState gates the UI to match;
// this is the safety net for a stale URL like ?period=all&granularity=hour.
const GRAN_ORDER = ['hour', 'day', 'week', 'month', 'quarter'];
const GRAN_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30.4, quarter: 91 };
const GRAN_BUCKET_CAP = 750;

function realRangeDays() {
  const { from, to } = FilterState.getDateRange();
  return Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
}

function resolveGranularity() {
  const days = realRangeDays();
  const fits = (g) => days / GRAN_DAYS[g] <= GRAN_BUCKET_CAP;
  const explicit = FilterState.get('granularity');
  if (explicit && explicit !== 'auto') {
    if (fits(explicit)) return explicit;
    for (let i = GRAN_ORDER.indexOf(explicit); i < GRAN_ORDER.length; i++) {
      if (fits(GRAN_ORDER[i])) return GRAN_ORDER[i];
    }
    return 'quarter';
  }
  if (days <= 2) return 'hour';
  if (days <= 100) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

// Format a backend bucket_start for the x-axis at the active granularity.
// The backend sends an Auckland-LOCAL label, not a UTC ISO timestamp:
//   day/week/month/quarter → "YYYY-MM-DD"   ·   hour → "YYYY-MM-DDTHH:00"
// We parse it as a LOCAL date (never `new Date("YYYY-MM-DD")`, which is UTC and
// would shift the label a day in NZ) so bars line up with the Orders list.
function fmtBucket(v) {
  if (v == null) return '';
  const s = String(v);
  const g = resolveGranularity();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0)
    : new Date(s);
  if (isNaN(d.getTime())) return s;
  if (g === 'hour') return d.toLocaleTimeString('en-NZ', { hour: 'numeric' });
  if (g === 'month' || g === 'quarter') return d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' });
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
  const { type = 'bar', metrics, labelKey = 'bucket_start', isMoney = true, isPercent = false, stacked = false } = opts;
  const list = resolveList(payload, ['series', 'data']);
  if (!hasData(canvasId, payload, list)) return;

  const c = Charts.getThemeColors();
  const labels = list.map(r => fmtBucket(r[labelKey]));
  const valFmt = (v) => isMoney ? formatPrice(v) : isPercent ? `${Number(v).toFixed(1)}%` : String(v);

  const datasets = metrics.map(m => {
    const col = c[m.color] || c.cyan;
    if (type === 'line') {
      return {
        label: m.label, data: list.map(r => Number(r[m.key] || 0)),
        borderColor: col, backgroundColor: hexToRgba(col, 0.18),
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4,
      };
    }
    return {
      label: m.label, data: list.map(r => Number(r[m.key] || 0)),
      backgroundColor: col + 'cc', borderRadius: 4, barPercentage: 0.7, categoryPercentage: 0.8,
      ...(stacked ? { stack: 's' } : {}),
    };
  });

  const scales = {
    x: { ticks: { maxTicksLimit: 10 } },
    y: { beginAtZero: true, ticks: { callback: (v) => valFmt(v) } },
  };
  if (stacked) { scales.x.stacked = true; scales.y.stacked = true; }

  const fn = type === 'line' ? Charts.line : Charts.bar;
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

// Ranked bars (top SKUs, suppliers, searches, margin, conversion, histograms).
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

function drawAllCharts(d) {
  try {
    // Row 1 — Money
    drawSeries('dash-c-revenue', d.sRevenue, { type: 'bar', metrics: [{ label: 'Revenue', key: 'revenue', color: 'success' }], isMoney: true });
    drawSeries('dash-c-gross-profit', d.sGrossProfit, { type: 'bar', metrics: [{ label: 'Gross profit', key: 'gross_profit', color: 'cyan' }], isMoney: true });
    // Row 2 — Products
    drawRanked('dash-c-sku-revenue', d.topSkusRev, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'revenue', color: 'success', isMoney: true });
    drawRanked('dash-c-sku-profit', d.topSkusProfit, { listKeys: ['products', 'skus'], labelKey: 'sku', valueKey: 'gross_profit', color: 'cyan', isMoney: true });
    // Row 3 — Sales
    drawSeries('dash-c-orders', d.sOrders, { type: 'line', metrics: [{ label: 'Orders', key: 'orders', color: 'yellow' }], isMoney: false });
    drawSeries('dash-c-aov', d.sAov, { type: 'line', metrics: [{ label: 'AOV', key: 'aov', color: 'cyan' }], isMoney: true });
    // Row 4 — Margin
    drawRanked('dash-c-margin-brand', d.marginBrand, { listKeys: ['brands'], labelKey: 'brand', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    drawRanked('dash-c-margin-category', d.marginCategory, { listKeys: ['categories'], labelKey: 'category', valueKey: 'margin_pct', color: 'magenta', isMoney: false, isPercent: true });
    // Row 5 — Marketing
    drawShare('dash-c-traffic-source', d.trafficSource, { listKeys: ['sources'], labelKey: 'source', valueKey: 'sessions' });
    drawRanked('dash-c-conversion-source', d.conversionSource, { listKeys: ['sources'], labelKey: 'source', valueKey: 'conversion_pct', color: 'success', isMoney: false, isPercent: true });
    // Row 6 — Customers
    drawSeries('dash-c-cust-type', d.custType, { type: 'bar', stacked: true, isMoney: true, metrics: [{ label: 'New', key: 'new_revenue', color: 'cyan' }, { label: 'Returning', key: 'returning_revenue', color: 'success' }] });
    drawRanked('dash-c-reorder', d.reorder, { listKeys: ['buckets'], labelKey: 'days_label', valueKey: 'customer_count', color: 'cyan', isMoney: false, horizontal: false, sort: false, limit: 24 });
    // Row 7 — Suppliers
    drawRanked('dash-c-supplier-rev', d.supplierRev, { listKeys: ['suppliers'], labelKey: 'supplier', valueKey: 'revenue', color: 'success', isMoney: true });
    drawRanked('dash-c-supplier-problem', d.supplierProblem, { listKeys: ['suppliers'], labelKey: 'supplier', valueKey: 'problem_rate_pct', color: 'danger', isMoney: false, isPercent: true });
    // Row 8 — Search
    // search→purchase attribution isn't tracked yet (backend data_gap: orders/
    // conversion_pct are null), so rank by search volume until it lands.
    drawRanked('dash-c-search-top', d.searchTop, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'success', isMoney: false });
    drawRanked('dash-c-search-zero', d.searchZero, { listKeys: ['terms', 'searches'], labelKey: 'term', valueKey: 'searches', color: 'yellow', isMoney: false });
    // Row 9 — Risk
    drawSeries('dash-c-refund-rate', d.sRefundRate, { type: 'line', metrics: [{ label: 'Refund rate', key: 'refund_rate_pct', color: 'danger' }], isMoney: false, isPercent: true });
    drawShare('dash-c-refund-reasons', d.refunds, { listKeys: ['reasons'], labelKey: 'reason_code', valueKey: 'count' });
    // Row 10 — Forecast
    drawForecast('dash-c-forecast', d.forecast);
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
    supplierRev:      b.suppliers_revenue ?? null,
    supplierProblem:  b.suppliers_problem_rate ?? null,
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
  // refund reasons stay on their existing dedicated endpoints. 7 calls total.
  const promises = [
    AdminAPI.getDashboardBundle(params, g, signal),          // 0  all graph charts
    AdminAPI.getDashboardKPIs(params, signal),               // 1  KPI band
    AdminAPI.getCustomerStats(params, signal),               // 2  new / returning KPI
    AdminAPI.getRefundAnalytics(params, signal),             // 3  refund reasons + rate KPI
    AdminAPI.getOutOfStock({ limit: 5 }),                    // 4  out-of-stock KPI
    AdminAPI.getOrders({ from, to }, 1, 8, signal),          // 5  recent orders table
    AdminAPI.getTopProducts(params, signal),                 // 6  most-bought table
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
  const graphs = bundleToGraphs(val(0));
  _container.classList.remove('admin-page--reloading');

  const payload = {
    isOwner: true,
    kpis: val(1), custStats: val(2), refunds: val(3), outOfStock: val(4),
    recentOrders: val(5), topProducts: val(6),
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
    <div class="admin-page-header admin-page-header--dash"><h1>Dashboard</h1></div>
    ${renderKpiStrip(d)}
    ${row('Money', 'success', chartCard('Revenue', 'over time', 'dash-c-revenue'), chartCard('Gross profit', 'over time', 'dash-c-gross-profit'))}
    ${row('Products', 'cyan', chartCard('Top SKUs by revenue', 'top 10', 'dash-c-sku-revenue'), chartCard('Top SKUs by gross profit', 'top 10', 'dash-c-sku-profit'))}
    ${row('Sales', 'yellow', chartCard('Orders', 'over time', 'dash-c-orders'), chartCard('Average order value', 'over time', 'dash-c-aov'))}
    ${row('Margin', 'magenta', chartCard('Gross margin by brand', '%', 'dash-c-margin-brand'), chartCard('Gross margin by category', '%', 'dash-c-margin-category'))}
    ${row('Marketing', 'success', chartCard('Traffic by source', 'sessions · approx', 'dash-c-traffic-source'), chartCard('Conversion by source', '% · approx', 'dash-c-conversion-source'))}
    ${row('Customers', 'cyan', chartCard('New vs returning revenue', 'over time', 'dash-c-cust-type'), chartCard('Reorder interval', 'days between orders', 'dash-c-reorder'))}
    ${row('Suppliers', 'yellow', chartCard('Supplier revenue', '', 'dash-c-supplier-rev'), chartCard('Supplier problem rate', 'refunds · late · cancels · approx', 'dash-c-supplier-problem'))}
    ${row('Search', 'magenta', chartCard('Top searches', 'by volume — conversion pending', 'dash-c-search-top'), chartCard('Zero-result searches', '', 'dash-c-search-zero'))}
    ${row('Risk', 'danger', chartCard('Refund rate', 'over time', 'dash-c-refund-rate'), chartCard('Refund reasons', 'share', 'dash-c-refund-reasons'))}
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--success">Forecast</div>
      <div class="admin-dash">
        <div class="admin-dash__cell--12 admin-card">
          <div class="admin-card__title"><span>30-day revenue forecast <small>actual + projection · trend estimate</small></span></div>
          <div class="admin-chart-box admin-chart-box--tall"><canvas id="dash-c-forecast"></canvas></div>
        </div>
      </div>
    </section>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label">Latest</div>
      <div class="admin-dash">
        ${renderRecentOrdersCard(d.recentOrders)}
        ${renderTopProductsCard(d.topProducts)}
      </div>
    </section>
  `;

  drawAllCharts(d);
  wireOrderRowClicks();
}

// ---------- layout helpers ----------

function chartCard(title, sub, canvasId) {
  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title"><span>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span></div>
      <div class="admin-chart-box"><canvas id="${canvasId}"></canvas></div>
    </div>
  `;
}

function row(label, accent, leftCard, rightCard) {
  return `
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--${accent}">${esc(label)} <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">${leftCard}${rightCard}</div>
    </section>
  `;
}

// ---------- KPI band ----------

function renderKpiTile(t, extraClass = '') {
  const alertCls = t.alert ? ' admin-kpi--alert' : '';
  let h = `<div class="admin-kpi admin-kpi--compact${alertCls}${extraClass}">`;
  h += `<div class="admin-kpi__label">${esc(t.label)}</div>`;
  if (t.value != null) {
    h += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
    h += deltaBadge(t.raw, t.prev, t.deltaOpts || {});
  } else {
    h += missingValue(t.tooltip || 'Data unavailable');
  }
  h += '</div>';
  return h;
}

function renderKpiStrip(d) {
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
  const netProfit = cur.net_profit ?? null;

  const tiles = [
    { label: 'Revenue', value: cur.revenue != null ? formatPrice(cur.revenue) : null, raw: cur.revenue, prev: prev.revenue },
    {
      label: 'Gross Profit', value: cur.gross_profit != null ? formatPrice(cur.gross_profit) : null,
      raw: cur.gross_profit, prev: prev.gross_profit,
      tooltip: 'Revenue (ex-GST) − COGS, computed by the backend.',
    },
    {
      label: 'Net Profit', value: netProfit != null ? formatPrice(netProfit) : null,
      raw: netProfit, prev: prev.net_profit, alert: netProfit != null && netProfit < 0,
      tooltip: 'Revenue − COGS − fees − GST − Opex, computed by the backend.',
    },
    { label: 'Orders', value: cur.orders != null ? String(cur.orders) : null, raw: cur.orders, prev: prev.orders },
    { label: 'Avg Order Value', value: aov != null ? formatPrice(aov) : null, raw: aov, prev: aovPrev },
    { label: 'New Customers', value: newCustomers != null ? String(newCustomers) : null, raw: newCustomers, prev: newCustomersPrev },
    {
      label: 'Returning %', value: cc.returning_pct != null ? `${cc.returning_pct}%` : null,
      raw: cc.returning_pct, prev: cp.returning_pct, tooltip: 'Requires analytics_customer_stats',
    },
    {
      label: 'Refund Rate', value: refundPct != null ? `${refundPct.toFixed(1)}%` : null,
      alert: refundPct != null && refundPct > 3,
    },
    {
      label: 'Out of Stock', value: oosCount != null ? String(oosCount) : null,
      alert: oosCount > 0, tooltip: 'Products currently flagged out of stock',
    },
  ];

  // Gross Profit + Net Profit share one grid cell (stacked half-height) so the
  // strip stays at 8 cells (2 rows of 4) rather than spilling onto a third row.
  let html = '<div class="admin-kpi-grid admin-kpi-grid--8">';
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const next = tiles[i + 1];
    if (t.label === 'Gross Profit' && next && next.label === 'Net Profit') {
      html += '<div class="admin-kpi-stack">'
            + renderKpiTile(t, ' admin-kpi--half')
            + renderKpiTile(next, ' admin-kpi--half')
            + '</div>';
      i += 1;
      continue;
    }
    html += renderKpiTile(t);
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
    FilterState.setDefaults({ period: 'all', granularity: 'auto' });
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
