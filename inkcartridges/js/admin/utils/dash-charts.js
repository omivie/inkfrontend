/**
 * Dashboard chart + card helpers, shared by pages/dashboard.js and pages/trends.js.
 * Moved verbatim from dashboard.js (Nov 2026, Trends tab) -- one definition each, never copy back.
 */
import { FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { kpiCogsInclGst, COST_GST_GROSS_UP } from './trend-math.js';
import { pnlCost } from './expense-math.js';
import { METRICS, rankBy, metricIncomplete } from './best-sellers.js';

// The grain the bundle ACTUALLY served at; drives fmtBucket so axis labels match the bars.
let _effectiveGranularity = null;
export function setEffectiveGranularity(g) { _effectiveGranularity = g; }

export const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;
export const MISSING = '—';
export const AWAIT_MSG = 'Awaiting data — backend endpoint pending';
export const EMPTY_MSG = 'No data for this range';

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
export const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  for (const k of keys) {
    if (obj && Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

export function safeDiv(a, b) {
  if (!b || b === 0 || a == null) return null;
  return a / b;
}

export function hexToRgba(hex, alpha) {
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
export const GRAN_ORDER = ['day', 'week', 'month', 'quarter'];
export const GRAN_DAYS = { day: 1, week: 7, month: 30.4, quarter: 91 };
export const GRAN_BUCKET_CAP = 750;

export function realRangeDays() {
  const { from, to } = FilterState.getDateRange();
  return Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000));
}

export function resolveGranularity() {
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
export function isCumulativeMode() {
  return FilterState.get('granularity') === 'all';
}

// Format a backend bucket_start for the x-axis at the active granularity. Chart.js reuses
// this same string as the tooltip title, so axis and tooltip can never disagree about
// which period a point belongs to — one formatter, one vocabulary.
// The backend sends an Auckland-LOCAL label, not a UTC ISO timestamp:
//   day/week/month/quarter → "YYYY-MM-DD". We parse it as a LOCAL date (never
// `new Date("YYYY-MM-DD")`, which is UTC and would shift the label a day in NZ)
// so bars line up with the Orders list — and so the weekday named below is the NZ
// weekday the owner actually traded on.
export const WEEKDAY = (d) => d.toLocaleDateString('en-NZ', { weekday: 'short' });

export function fmtBucket(v) {
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
  // Day grain leads with the weekday ("Fri 12 Jun"). Day-of-week is the strongest cycle in
  // this data (weekday trade vs weekend), and a bare "12 Jun" hides it — every peak looks
  // like a one-off. The two-call format is deliberate: one call with weekday+day+month
  // renders "Fri, 12 Jun" in en-NZ, and the comma reads as a separator between two dates
  // on a crowded axis. Only the `day` grain gets it — a week/month/quarter bucket spans
  // every weekday, so naming one would be a false claim.
  return WEEKDAY(d) + ' ' + d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
}

export function rangeLabel() {
  const period = FilterState.get('period');
  const map = {
    '24h': 'last 24h', '72h': 'last 72h', '7d': 'last 7 days', '1m': 'last 30 days',
    '3m': 'last 3 months', '6m': 'last 6 months', '1y': 'last 12 months',
    '2y': 'last 2 years', 'all': 'all time', 'custom': 'custom range',
  };
  return map[period] || 'selected range';
}

// Pull a net-margin % off an under-margin row. The endpoint exposes a few shapes; prefer the
// fields already labelled "_pct" (definitely a percentage), and only treat a bare `net_margin`
// as a fraction (×100) when it's clearly ≤1 in magnitude.
export function rowMarginPct(r) {
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
export function normalizeWorstMargin(responses) {
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

/**
 * The short reference a dashboard card prints for an order.
 *
 * ORDER NUMBERS ARE PRINTED WHOLE (ERR-198). These five call sites used
 * `String(n).slice(-8)`, which was deliberate and harmless while every order
 * number was 14 fixed characters: the leading 8 were a redundant date prefix, so
 * the slice dropped them and kept the entire counter — `20260829000004` read as
 * `29000004`. Since migration 157 the daily sequence is no longer padded and a
 * number is only 10 characters, so the same slice eats the CENTURY and prints
 * `26090101` — which is not an order number, matches nothing in the order
 * search, and reads like a date. The new numbers are shorter than the old ones,
 * so there is nothing left to save by truncating them.
 *
 * A bare UUID fallback (a row carrying no order number at all) still gets a
 * short form — nobody types a UUID — and uses the SAME first-8 convention the
 * Orders list uses in exactly this situation (pages/orders.js `orderLabel`),
 * rather than the last-8 these five sites used alone.
 *
 * @param {*} value an order number, or an order id when the row has no number
 * @returns {string}  when there is nothing to print
 */
export function orderRef(value) {
  const num = window.OrderNumber.forDisplay(value);
  if (!num) return '';
  return window.OrderNumber.isValid(num) ? num : num.slice(0, 8);
}


// ---------- chart empty/await state ----------

// Distinguish a missing endpoint (payload === null) from an endpoint that
// answered with no rows, so the page reads honestly while the backend is pending.
export function resolveList(payload, keys = []) {
  if (payload == null) return null;             // endpoint missing entirely
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];                                     // present, but empty / unknown shape
}

export function chartEmpty(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  const box = canvas?.closest('.admin-chart-box');
  if (box) box.innerHTML = `<div class="admin-dash-inline-empty">${esc(message)}</div>`;
}

// Returns true when there's data to draw; otherwise paints the right empty state.
export function hasData(canvasId, payload, list) {
  if (payload == null) { chartEmpty(canvasId, AWAIT_MSG); return false; }
  if (!list || !list.length) { chartEmpty(canvasId, EMPTY_MSG); return false; }
  return true;
}

// Charts.* are async (lazy Chart.js CDN); fire-and-forget but catch rejections
// so a CDN failure degrades to an empty state instead of an unhandled rejection.
export function guardDraw(promise, canvasId) {
  Promise.resolve(promise).catch(() => chartEmpty(canvasId, 'Chart failed to render'));
}

// ---------- generic chart drawers ----------

// Time-series (bar or line), one or more metrics, optional stacking. Reads
// payload.series (one row per backend bucket); never re-buckets.
export function drawSeries(canvasId, payload, opts) {
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
export function drawRanked(canvasId, payload, opts) {
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
export function drawShare(canvasId, payload, opts) {
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
export function drawRevenueProfit(d) {
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
export function drawForecast(canvasId, payload) {
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
export function buildOverviewBuckets(d) {
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
  // The fourth term (ERR-255). `net_profit` above ALREADY has freight deducted
  // server-side, so this is here to be RENDERED as a cost band — never to be
  // subtracted again. Measured live: net_profit_series buckets carry
  // supplier_freight on every row.
  merge(npList, (r) => numOrNull(r.supplier_freight), 'freight');

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
export function renderOverviewNotes(plan, drift, opexLabel, hasBackendOpex, trafficMissing) {
  const host = document.getElementById('dash-overview-notes');
  if (!host) return;
  const notes = [];

  if (trafficMissing) {
    // Fail-soft must be LOUD: the traffic lines were requested but no usable series came back
    // for this range. Say so rather than plotting a flat zero that reads as "no visitors".
    notes.push(`<p class="fh-pnl-note">Traffic data isn’t available for this range, so the Sessions and
      Pageviews lines are hidden rather than drawn as zero.</p>`);
  }

  if (drift) {
    // Both figures are the backend's own, so this is a backend inconsistency — say so
    // plainly rather than implying the chart is at fault.
    notes.push(`<p class="fh-pnl-note admin-dash-note--alert"><strong>These two backend figures disagree.</strong>
      The per-period ${esc(plan.label.toLowerCase())} adds up to ${esc(formatPrice(drift.seriesTotal))},
      but the backend's own net-profit total for the same range reads ${esc(formatPrice(drift.kpiNet))} (gap ${esc(formatPrice(Math.abs(drift.gap)))}).
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
      browser (by bill date, paid or not) because the backend didn’t return per-period operating
      expenses for this range. It can differ from the Net Profit tile’s expense figure, which also
      counts recurring charges.</p>`);
  }

  host.innerHTML = notes.join('');
}

// Categories the backend leaves out of operating expenses (order-linked + GST payment to IRD).
const FALLBACK_EXCLUDED_RAW = ['inventory', 'merchant_fees', 'customer_shipping', 'gst_payment'];

export function drawPerformanceOverview(d) {
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
  // Supplier freight per bucket (ERR-255), from the same series. It is already
  // inside the backend's `net_profit`; it is added to the COST band below so the
  // cost line and the profit line describe the same arithmetic. Leaving it out
  // made the cost line understate while the profit line was correct — two lines
  // on one chart disagreeing silently.
  //
  // 🚨 GROSSED UP, BECAUSE THIS BAND IS CASH OUT AND FREIGHT IS A SUPPLIER
  // INVOICE. `net_profit_series` publishes freight EX-GST only — measured
  // 2026-09-12, the per-bucket rows carry `supplier_freight` and NOT
  // `supplier_freight_incl_gst`, though `kpi-summary` carries both. Dropping the
  // raw field in here would sit an ex-GST term directly beside `cogsByBucket`,
  // which is deliberately grossed up as "real cash to suppliers"
  // (trend-math.js `kpiCogsInclGst`). We pay freight incl-GST for the same
  // reason we pay goods incl-GST, so it gets the same treatment: over the last
  // 30 live days that is $488.03 of cash rather than $424.37.
  //
  // ***TWO FIELDS DIFFERING ONLY BY A SUFFIX ARE TWO CHANCES TO BE QUIETLY 15%
  // WRONG*** — and this band would have accepted either one without complaint.
  //
  // 🚨 THE REST OF THIS BAND IS MIXED, AND ONE TERM CANNOT BE FIXED YET.
  // DO NOT "TIDY" IT UNIFORM — that is wrong in both directions:
  //
  //   COGS     incl-GST (grossed up above)      cash out
  //   freight  incl-GST (grossed up here)       cash out
  //   fees     ex-GST, the backend's figure     ← BLOCKED, see below
  //   opex     ex-GST, and CORRECTLY so         ← already per-row GST-netted
  //
  // There is no GST line in `parts` below to net anything back, so each term's
  // basis has to be right on its own.
  //
  // `fees` is blocked on the SAME open question as hand-off §6, which the owner
  // deferred pending a real Stripe payout. Under our 2026-05-17 convention
  // (2.65% + $0.30 is ex-GST and Stripe adds 15%) the cash figure is
  // `fees × 1.15` and this band is ~$25.60/30d short. Under the backend's
  // convention the published rate already includes GST, `stripe_fees` IS the
  // cash figure, and grossing it up would be the bug. ***THE CORRECT BASIS FOR
  // THIS TERM IS DOWNSTREAM OF THE PAYOUT LINE*** — for the $134.49 charge on
  // 2026090902, does the Stripe fee read $3.86 or $3.36? One check answers both
  // that and this.
  //
  // `opex` must NOT be grossed up at all: expense-math's `pnlCost()` already
  // nets GST PER ROW off `gst_claimable`, and foreign / GST-free expenses hit
  // the P&L at full value. A blanket x1.15 would invent input credits that do
  // not exist. (Linkage identified by wire-backend-supplier-freight.)
  const freightByBucket = order.map(b => {
    const ex = numOrNull(byBucket.get(b)?.freight);
    return ex == null ? null : ex * COST_GST_GROSS_UP;
  });

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
    // Same rule as the backend's operating expenses since 2026-11-25 (§4/§5): ACCRUAL — a
    // bill counts on its expense_date, paid or not — GST-net, and order-linked costs (they
    // live in COGS / fees / freight) and GST payments to IRD (`gst_payment`) left out. Rows
    // may carry the FE `kind` (expenses page) or only the backend's raw `category` (dashboard).
    for (const row of (Array.isArray(d.expenseRows) ? d.expenseRows : [])) {
      if (!row || row.deleted_at || row.derived_status === 'cancelled' || row.derived_status === 'skipped') continue;
      if (row.kind ? row.kind !== 'operating' : FALLBACK_EXCLUDED_RAW.includes(row.category)) continue;
      const day = row.expense_date || row.date;
      const i = indexFor(day ? Date.parse(String(day).slice(0, 10)) : NaN);
      if (i < 0) continue;
      loggedOpex[i] += pnlCost(Number(row.amount), row.gst_claimable);
    }
  }
  const opexByBucket = hasBackendOpex ? backendOpex : loggedOpex;
  const opexLabel = hasBackendOpex ? 'Operating expenses' : 'Logged expenses (client-side)';

  // Total costs = COGS + operating expenses + Stripe fees + supplier freight — every
  // component now per-bucket. Any unknown component makes the total unknown: a gap,
  // never a confident partial sum.
  //
  // 🚨 FREIGHT IS INCLUDED THE SAME WAY THE OTHERS ARE — a null makes the whole
  // bucket null. It must NOT be coalesced to 0: an absent freight figure would
  // then quietly shrink the cost band instead of leaving a visible gap, which is
  // the absence-as-zero failure with a chart in front of it.
  const totalCostByBucket = order.map((_, i) => {
    const parts = [cogsByBucket[i], opexByBucket[i], feesByBucket[i], freightByBucket[i]];
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

  // ── Traffic overlay (sessions + pageviews) ──────────────────────────────────────────
  // Daily rows from /traffic/timeseries, re-bucketed to THIS chart's grain via the same
  // indexFor() the opex fallback uses (out-of-range rows fall to -1 and drop). Fail-soft LOUD:
  // a failed/empty fetch → sessions/pageviews stay null → both lines omitted (never plotted as
  // a misleading zero) and renderOverviewNotes flags it.
  const trafficRows = Array.isArray(d.sTraffic) ? d.sTraffic : null;
  const trafficMissing = !trafficRows || trafficRows.length === 0;
  let sessions = null, pageviews = null;
  if (!trafficMissing) {
    const sBk = new Array(order.length).fill(0);
    const pBk = new Array(order.length).fill(0);
    for (const row of trafficRows) {
      const i = indexFor(Date.parse(String(row?.date ?? '').slice(0, 10)));
      if (i < 0) continue;
      sBk[i] += Number(row?.sessions)  || 0;
      pBk[i] += Number(row?.pageviews) || 0;
    }
    sessions  = accum(sBk);
    pageviews = accum(pBk);
  }

  renderOverviewNotes(plan, drift, opexLabel, hasBackendOpex, trafficMissing);

  const revenue = accum(order.map(b => numOrNull(byBucket.get(b)?.revenue)));
  const profit  = accum(plan.values.slice());
  const orders  = accum(order.map(b => numOrNull(byBucket.get(b)?.orders)));
  const addedExpenses = accum(opexByBucket.slice());
  const totalExpenses = accum(totalCostByBucket.slice());

  // ── Axis domains ────────────────────────────────────────────────────────────────────
  // Round a value UP / DOWN to a "nice" 1/2/2.5/5 × 10ⁿ step.
  const niceUp = (v) => {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  };
  const niceDown = (v) => {
    if (!(v > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    return (n >= 10 ? 10 : n >= 5 ? 5 : n >= 2.5 ? 2.5 : n >= 2 ? 2 : 1) * mag;
  };
  // Money (left) axis — set min/max explicitly (Chart.js auto-scaling is otherwise opaque to us,
  // and we need the exact numbers to align the count axes below). Losses still dip under zero:
  // moneyMin is the real negative data floor, only 0 when nothing is below break-even.
  const allMoney = [revenue, profit, addedExpenses, totalExpenses]
    .flat().filter(v => v != null && Number.isFinite(v));
  const rawMoneyMax = allMoney.length ? Math.max(0, ...allMoney) : 0;
  const rawMoneyMin = allMoney.length ? Math.min(0, ...allMoney) : 0;
  // Aim for ≥12 gridlines → finer $ increments than Chart.js's default ~10. niceDown never
  // overshoots to FEWER lines the way rounding up can (e.g. a $10k range → $500 steps, not $1k).
  const moneyStep = niceDown((Math.max(rawMoneyMax, 1) - Math.min(rawMoneyMin, 0)) / 12);
  const moneyMax  = Math.max(moneyStep, Math.ceil(rawMoneyMax / moneyStep) * moneyStep);
  const moneyMin  = rawMoneyMin < 0 ? Math.floor(rawMoneyMin / moneyStep) * moneyStep : 0;
  // The shared below-zero fraction. Give every COUNT axis the same fraction and their zeros land
  // on the exact pixel row of the money-zero gridline — so Orders/Traffic (always ≥ 0) can never
  // render below the baseline, while the money lines still dip for a loss. zeroFrac ≤ 0.
  const zeroFrac = moneyMax > 0 ? moneyMin / moneyMax : 0;

  const ordersVals   = orders.filter(v => v != null && Number.isFinite(v));
  const rawOrdersMax = ordersVals.length ? Math.max(...ordersVals) : 0;
  const ordersStep   = niceUp(Math.max(rawOrdersMax, 1) / 7);
  const ordersMax    = Math.max(ordersStep, Math.ceil(rawOrdersMax / ordersStep) * ordersStep);

  const trafficVals   = [...(sessions || []), ...(pageviews || [])].filter(v => v != null && Number.isFinite(v));
  const rawTrafficMax = trafficVals.length ? Math.max(...trafficVals) : 0;
  const trafficMax    = rawTrafficMax > 0 ? rawTrafficMax * 1.08 : 1;   // headroom; axis is hidden

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

  // Traffic pair — dashed & on the hidden y2 scale so they group visually as "traffic" and don't
  // add a third column of numbers. Two shades of violet keep them distinct from every solid line
  // (green/cyan/magenta/red/yellow) while reading as one family. Omitted when data is unavailable.
  if (!trafficMissing) {
    const TRAFFIC_SESSIONS  = '#7C3AED'; // violet-600
    const TRAFFIC_PAGEVIEWS = '#A78BFA'; // violet-400
    const trafficLine = (label, data, color) => ({
      label, data, yAxisID: 'y2', type: 'line', borderColor: color,
      backgroundColor: 'transparent', borderDash: [5, 4], borderWidth: 2,
      fill: false, tension: 0.35, pointRadius: 0, pointHoverRadius: 4,
    });
    datasets.push(
      trafficLine('Sessions', sessions, TRAFFIC_SESSIONS),
      trafficLine('Pageviews', pageviews, TRAFFIC_PAGEVIEWS),
    );
  }

  // Bar base with a line dataset mixed in (Chart.js honors per-dataset `type`).
  const fn = drawType === 'line' ? Charts.line : Charts.bar;
  guardDraw(fn.call(Charts, canvasId, {
    labels, datasets,
    options: {
      plugins: {
        legend: { display: true, position: 'top', labels: { color: c.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: {
          // y1 (Orders) and y2 (Traffic) are integer counts; everything else is money.
          label: (ctx) => (ctx.dataset.yAxisID === 'y1' || ctx.dataset.yAxisID === 'y2')
            ? `${ctx.dataset.label}: ${Math.round(ctx.raw || 0).toLocaleString('en-NZ')}`
            : `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}`,
          // Revenue is what landed in the bank (incl-GST) and costs are what left it
          // (incl-GST), but PROFIT is measured net of GST — GST is collected on behalf of
          // IRD and remitted, so it was never income. Without this note the lines look
          // like they should subtract to the profit line, and they don't.
          footer: () => 'Revenue and costs incl. GST; profit is measured net of GST.',
        } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        // Explicit min/max (not Chart.js auto) so the count axes can align their zeros to ours.
        // moneyMin is negative only for a real loss, so loss periods still dip under the baseline;
        // the finer stepSize gives more $ gridlines. The zero gridline is emphasised.
        y:  { min: moneyMin, max: moneyMax, position: 'left',
              ticks: { color: c.textMuted, font: { size: 11 }, stepSize: moneyStep, callback: (v) => formatPrice(v) },
              grid: { drawBorder: false, color: (gctx) => gctx.tick?.value === 0 ? c.textMuted : c.border } },
        // Orders (count) — min set so orders-0 lands on the money-0 gridline (zeroFrac). Negative
        // ticks the alignment introduces are blanked, so the axis never shows a negative order count.
        y1: { min: ordersMax * zeroFrac, max: ordersMax, position: 'right', grid: { drawOnChartArea: false },
              ticks: { color: c.textMuted, font: { size: 11 }, stepSize: ordersStep, callback: (v) => v < 0 ? '' : Math.round(v) } },
        // Traffic (count) — hidden scale (no ticks/label), same zero alignment so the dashed lines
        // never dip below the baseline. Only present when traffic data loaded.
        ...(trafficMissing ? {} : {
          y2: { min: trafficMax * zeroFrac, max: trafficMax, position: 'right', display: false,
                grid: { drawOnChartArea: false } },
        }),
      },
    },
  }), canvasId);
}

// Map the /dashboard-bundle `data` map onto the per-chart payload keys render()
// reads. A null bundle (or a missing key) yields null → that chart shows its
// "awaiting data" empty state. Keys mirror the backend bundle contract exactly.
export function bundleToGraphs(b) {
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

/* ────────────────────────────────────────────────────────────────────────────
 * CONVERSION FUNNEL (data-tracking-capture-fe-handoff-aug2026 §2.3)
 *
 * Visitors → product viewers → add to cart → checkout → order, over a FIXED
 * 30-day window.
 *
 * Three things this card refuses to do, each of them a way the same number has
 * gone wrong on this page before:
 *
 * 1. IT NEVER PRINTS 0% FOR "WE MEASURED NOTHING". `overall_conversion_rate` is
 *    now null when there were no visitors, which is the honest answer; a 0% rate
 *    is a measurement and this is not one. Renders as — (ERR-063/068/073/075/
 *    076/127, the absence-as-zero family).
 *
 * 2. IT NEVER DRAWS AN IMPOSSIBLE FUNNEL AS IF IT WERE REAL. A funnel is
 *    monotonic by construction: you cannot start more checkouts than you had
 *    carts. Live today it is NOT — `added_to_cart: 2` sits under
 *    `started_checkout: 78`, and the backend's own `drop_off.cart_to_checkout`
 *    reads **-3800%**. That is not a customer behaviour, it is the broken
 *    `add_to_cart` emitter (handoff §1.3, fixed in this same change: the event
 *    was guarded by `typeof CartAnalytics !== 'undefined'` on 30 pages that
 *    never loaded the script). Rendering -3800% next to four confident-looking
 *    numbers would launder a wiring bug into a business insight. So a stage that
 *    exceeds the one above it is called out BY NAME, and its rate is withheld.
 *    The callout disappears on its own once the fixed emitter has 30 days of
 *    data — it is measured, not hardcoded.
 *
 * 3. IT NEVER LABELS ITSELF WITH THE PAGE'S DATE RANGE. The endpoint ignores
 *    window_days and date_from/date_to entirely (measured: 7, 90, 999 and an
 *    explicit range all return the identical 30-day payload — the ERR-151 decoy
 *    shape). The subtitle comes from `meta.window_days`, the server's own echo,
 *    and says out loud that it does not follow the filter above it.
 * ──────────────────────────────────────────────────────────────────────────── */
export const FUNNEL_STAGE_LABELS = {
  visitors: 'Visitors',
  product_viewers: 'Viewed a product',
  added_to_cart: 'Added to cart',
  started_checkout: 'Started checkout',
  completed_purchase: 'Ordered',
};

/** Already a percent (6.44 = 6.44%). NOT fmtPct — see funnelPct's note. */
export function funnelPct(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  return `${n.toFixed(n < 10 ? 2 : 1)}%`;
}

/**
 * Stages in server order, each marked against its IMMEDIATE predecessor.
 *
 * A funnel cannot widen: no step can record more events than the step before it.
 * Comparing each stage to the one directly above it (rather than to a running
 * maximum) localises the fault to the pair that actually disagrees, instead of
 * condemning every stage downstream of the first bad one.
 *
 * `underReporting` marks the EARLIER half of an inconsistent pair, because that
 * is the one that is wrong: `added_to_cart: 2` beneath `started_checkout: 78`
 * means add-to-cart is under-counting, not that 78 checkouts are imaginary.
 *
 * Plain data, deliberately, so the rule can be tested without a DOM.
 */
export function funnelStages(data) {
  const raw = Array.isArray(data?.funnel) ? data.funnel : [];
  const rows = raw.map((row) => ({
    stage: row?.stage,
    label: FUNNEL_STAGE_LABELS[row?.stage] || String(row?.stage || MISSING),
    count: numOrNull(row?.count),
    rate: numOrNull(row?.rate),
    underReporting: false,
    exceededBy: null,
  }));
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    // An unknown count cannot be exceeded — absence is not a bound.
    if (prev.count == null || rows[i].count == null) continue;
    if (rows[i].count > prev.count) {
      prev.underReporting = true;
      prev.exceededBy = rows[i];
    }
  }
  return rows;
}

export function renderFunnelCard(data) {
  const d = data || null;
  const meta = d?.meta || {};
  const windowDays = numOrNull(meta.window_days);
  const sub = windowDays ? `last ${windowDays} days · fixed window` : 'fixed window';

  const shell = (inner) => `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title"><span>Conversion funnel <small>${esc(sub)}</small></span></div>
      ${inner}
    </div>`;

  if (!d) {
    return shell('<p class="admin-conv-funnel__empty">Funnel data could not be loaded.</p>');
  }
  if (meta.data_gap === true) {
    // The backend says its own aggregate is unavailable. That is a louder fact
    // than an empty chart, and it names the thing to check — the whole point of
    // §2.3 was replacing a fabricated number, and silence here would be a
    // quieter version of the same failure.
    return shell(`
      <p class="admin-conv-funnel__gap">No funnel could be computed — the backend reports
      <code>data_gap</code>, meaning the traffic aggregate (migration 155) is not in
      place. No numbers are shown rather than estimated ones.</p>`);
  }

  const stages = funnelStages(d);
  if (!stages.length) {
    return shell('<p class="admin-conv-funnel__empty">No funnel stages were returned.</p>');
  }

  const broken = stages.filter((s) => s.underReporting);
  const top = stages[0]?.count;

  const rows = stages.map((s) => {
    const width = (top && s.count != null && !s.underReporting)
      ? Math.max(2, Math.round((s.count / top) * 100))
      : 0;
    // The count is still shown — it is what the table holds — but its RATE is
    // withheld, because a percentage of a number we know to be under-counted is
    // not a measurement of anything a customer did.
    const rate = s.underReporting ? MISSING : (funnelPct(s.rate) ?? MISSING);
    return `
      <li class="admin-conv-funnel__row${s.underReporting ? ' admin-conv-funnel__row--broken' : ''}">
        <span class="admin-conv-funnel__label">${esc(s.label)}</span>
        <span class="admin-conv-funnel__bar"><i style="width:${width}%"></i></span>
        <span class="admin-conv-funnel__count">${s.count == null ? MISSING : esc(String(s.count))}</span>
        <span class="admin-conv-funnel__rate">${esc(rate)}</span>
      </li>`;
  }).join('');

  // null → "—", never 0%. `overall_conversion_rate` is visitors → orders, so it
  // does NOT route through the broken stage and is still a real number when one
  // exists; withholding it too would throw away a good measurement to punish a
  // neighbouring bad one.
  const overallLine = `
    <p class="admin-conv-funnel__overall">
      <span>Visitor → order</span>
      <strong>${esc(funnelPct(d.overall_conversion_rate) ?? MISSING)}</strong>
    </p>`;

  const warning = broken.length ? `
    <p class="admin-conv-funnel__broken">
      ${broken.map((s) => `<strong>${esc(s.label)}</strong> (${esc(String(s.count))}) sits below
        <strong>${esc(s.exceededBy.label)}</strong> (${esc(String(s.exceededBy.count))})`).join('; ')} —
      a funnel cannot widen, so that step is under-counting rather than describing customers, and
      its rate is withheld. Cause: the <code>add_to_cart</code> emitter, repaired 2026-08-31
      (cart-analytics.js was loaded on 3 pages while cart.js is on 33). This note clears itself
      once the fix has a full window of data behind it.
    </p>` : '';

  const provenance = meta.source
    ? `<p class="admin-conv-funnel__source">${esc(String(meta.source))}. Independent of the date filter above.</p>`
    : '<p class="admin-conv-funnel__source">Independent of the date filter above.</p>';

  return shell(`<ul class="admin-conv-funnel">${rows}</ul>${overallLine}${warning}${provenance}`);
}

// ---------- layout helpers ----------

export function chartCard(title, sub, canvasId, cell = 6) {
  return `
    <div class="admin-dash__cell--${cell} admin-card">
      <div class="admin-card__title"><span>${esc(title)}${sub ? ` <small>${esc(sub)}</small>` : ''}</span></div>
      <div class="admin-chart-box"><canvas id="${canvasId}"></canvas></div>
    </div>
  `;
}

export function row(label, accent, leftCard, rightCard) {
  return rowN(label, accent, [leftCard, rightCard]);
}

// N-card row variant (used by the 3-up Products row and the alerts panel). Cards carry
// their own cell-width class so a row can hold two --6 cells or three --4 cells.
export function rowN(label, accent, cards) {
  const acc = accent ? ` admin-dash-row__label--${accent}` : '';
  return `
    <section class="admin-dash-row">
      <div class="admin-dash-row__label${acc}">${esc(label)} <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">${cards.join('')}</div>
    </section>
  `;
}

// Fulfillment card for the Operations row — a compact list of paid/processing orders that
// still need tracking, each clickable through to the order. Complements the alert count.
export function renderFulfillmentCard(d) {
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
    // dashboard-summary's needs-tracking rows carry no customer fields — show the order total
    // there rather than calling a known customer "Guest".
    const who = o.customer_name || o.customer_email || o.email
      || (('customer_name' in o || 'customer_email' in o || 'email' in o) ? 'Guest'
        : (o.total != null ? formatPrice(o.total) : '—'));
    const status = (o.status || 'pending').toLowerCase();
    const when = timeAgo(o.created_at || o.createdAt);
    return `
      <tr data-order-id="${esc(String(o.id || id))}" data-order-number="${esc(window.OrderNumber.forDisplay(o.order_number))}">
        <td class="cell-mono cell-ordernum">${esc(orderRef(id))}</td>
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


// Format a margin as a percent. Every caller passes a PERCENT (e.g. 33.2). There used to be a
// "fraction guard" here (|n| ≤ 1.5 → ×100); it cannot tell 0.33 from a real 0.33%, and live
// 2026-10-07 it rendered a −1.39% net margin as −139.0% (ERR-310). A near-breakeven margin
// is exactly the one the owner most needs to read correctly.
export function fmtPct(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
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
export function planProfitLine(order, byBucket) {
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
export function checkNetDrift(plan, kpiNet, bucketCount) {
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
export function recoverProfitFromSeries(cur, grossProfitSeries, netProfitSeries) {
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
    // Supplier freight is the FOURTH term (ERR-255). The backend's identity is
    // `gross_profit − net_profit = stripe_fees + operating_expenses + supplier_freight`
    // — verified against the live RPC 2026-09-10, $2,210.76 − (−$56.06) = $2,266.82 =
    // $170.68 + $1,593.50 + $502.64, exact to the cent.
    //
    // 🚨 AND IT IS READ AS UNKNOWN, NEVER AS ZERO. `numOrNull` is the whole point: the
    // range total was $502.64 over 30 days, so treating an absent field as $0 would
    // rebuild a net profit HALF A THOUSAND DOLLARS too healthy and stamp "Rebuilt" on it
    // as if that were a provenance claim. That is ERR-063/068 absence-as-zero with the
    // headline figure on it. A missing freight term disqualifies the primary formula and
    // drops through to the backend's own per-bucket net below, which already has freight
    // inside it.
    const freight = numOrNull(cur.supplier_freight);
    // PRIMARY: kpi-summary's own formula off its own range-exact scalars. Deliberately
    // preferred over summing the series — `Σ series` carries per-bucket rounding (~1c per
    // bucket), while these scalars are rounded once for the whole range.
    if (gross != null && fees != null && opex != null && freight != null) {
      net = gross - fees - opex - freight;
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

// ---------- supplementary tables ----------

export function renderRecentOrdersCard(data) {
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
      <tr data-order-id="${esc(String(o.id || id))}" data-order-number="${esc(window.OrderNumber.forDisplay(o.order_number))}">
        <td class="cell-mono cell-ordernum">${esc(orderRef(id))}</td>
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

export function wireOrderRowClicks(_container) {
  _container?.querySelectorAll('.admin-dash-table tbody tr[data-order-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      // `?order=` was read by NOTHING, and the attribute it carried was a UUID
      // — which `focus` cannot resolve either, because the orders `?search=`
      // matches customer name and order number only. Carry the order number
      // (ERR-198); fall back to leaving the operator on an unfiltered list
      // rather than sending them to a query that silently matches nothing.
      const num = tr.getAttribute('data-order-number');
      window.location.hash = num ? `orders?focus=${encodeURIComponent(num)}` : 'orders';
    });
  });
}

// Most Bought: one card, three rankings (utils/best-sellers.js). The toggle re-renders
// the body from the loaded set — no refetch. Full list: Performance → Best Sellers.
let _topMetric = 'revenue';
let _topData = null;

export function renderTopProductsBody() {
  const items = _topData?.items || [];
  const ranked = rankBy(items, _topMetric).slice(0, 10);
  const showBrand = ranked.some(p => p.brand);
  const cell = (v, fmt = String) => (v == null ? MISSING : esc(fmt(v)));
  const rows = ranked.map(p => `
      <tr>
        <td class="cell-truncate">${esc(p.name)}</td>
        ${showBrand ? `<td class="cell-muted">${esc(p.brand || '')}</td>` : ''}
        <td class="cell-mono cell-right">${cell(p.units)}</td>
        <td class="cell-mono cell-right">${cell(p.orders)}</td>
        <td class="cell-mono cell-right">${cell(p.revenue, formatPrice)}</td>
      </tr>`).join('');
  // Partial-ness is said on the card, never left to look like a full ranking.
  const notes = [];
  if (_topData?.truncated) notes.push('Server row cap reached — ranking covers a partial set.');
  if (_topData?.dupSkus) notes.push(`${_topData.dupSkus} SKU(s) split across rows — totals are partial.`);
  if (metricIncomplete(items, _topMetric)) notes.push(`Some products have no ${_topMetric} figure and rank last.`);
  return `
      ${notes.map(n => `<div class="admin-dash-inline-empty">${esc(n)}</div>`).join('')}
      <table class="admin-dash-table">
        <thead><tr>
          <th>Product</th>${showBrand ? '<th>Brand</th>' : ''}<th class="cell-right">Units</th><th class="cell-right">Orders</th><th class="cell-right">Revenue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
}

export function renderTopProductsCard(data) {
  _topData = data && Array.isArray(data.items) ? data : null;
  if (!_topData?.items.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Most Bought <small>top sellers</small></div>
        <div class="admin-dash-inline-empty">${_topData ? 'No sales in this range' : esc(data?.error || 'Top product data unavailable')}</div>
      </div>
    `;
  }
  return `
    <div class="admin-dash__cell--6 admin-card" id="dash-top-products">
      <div class="admin-card__title">
        <span>Most Bought <small>top ${Math.min(_topData.items.length, 10)}</small></span>
        <div class="admin-segmented" role="group" aria-label="Rank by">
          ${METRICS.map(m => `<button type="button" class="admin-segmented__btn${m.id === _topMetric ? ' admin-segmented__btn--active' : ''}" data-top-metric="${esc(m.id)}" aria-pressed="${m.id === _topMetric}">${esc(m.label)}</button>`).join('')}
        </div>
        <a href="#analytics?tab=best-sellers" class="admin-mini-card__sub">View all →</a>
      </div>
      <div data-top-body>${renderTopProductsBody()}</div>
    </div>
  `;
}

export function wireTopProductsToggle(_container) {
  const card = _container?.querySelector('#dash-top-products');
  card?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-top-metric]');
    if (!btn) return;
    _topMetric = btn.dataset.topMetric;
    card.querySelectorAll('[data-top-metric]').forEach(b => {
      const on = b === btn;
      b.classList.toggle('admin-segmented__btn--active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    card.querySelector('[data-top-body]').innerHTML = renderTopProductsBody();
  });
}
