/**
 * Dashboard — small KPI cards on top, the analytics rows below (owner layout, 2026-11-26)
 *
 * Money comes from ONE backend call, GET /api/admin/analytics/dashboard-summary (backend reply
 * 2026-11-25 §6), on the owner's definitions: invoices on their issue date, processed refunds off
 * on the refund date, expenses by bill date paid or not, GST payments to IRD not an expense.
 * utils/money-truth.js shapes those figures into tiles and their "How it's calculated" inputs; it
 * adjusts NOTHING. The graph rows still come pre-bucketed from the dashboard bundle, whose series
 * share the same definition (§2). The frontend never aggregates, buckets or derives profit — the
 * margins (a ratio of two backend figures) are its only arithmetic.
 *
 * The money is whole-business (dashboard-summary takes no brand/supplier filter), so this page
 * shows only the period and bar-width filters, and sends every endpoint the date range alone.
 *
 * "Dashboard (new)" (pages/dashboard-new.js) was merged into this page and deleted (owner
 * 2026-11-26): its money boxes became the KPI strip's data, its to-do items joined "Action
 * needed", and the 120-request "sales missing a cost" scan became `actions.missing_cost`.
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { Drawer } from '../components/drawer.js';
import {
  formatPrice, MISSING, timeAgo, firstArray, resolveGranularity,
  rangeLabel, rowMarginPct, normalizeWorstMargin, drawPerformanceOverview, buildOverviewBuckets,
  drawSeries, drawRanked, drawShare, drawRevenueProfit, drawForecast, bundleToGraphs, renderFunnelCard,
  chartCard, row, rowN, renderFulfillmentCard, fmtPct, planProfitLine,
  renderRecentOrdersCard, wireOrderRowClicks, renderTopProductsCard, wireTopProductsToggle,
  setEffectiveGranularity,
} from '../utils/dash-charts.js';
import {
  LOW_MARGIN_PCT, ZERO_SEARCH_MIN,
  computeTrackingAlert, computeZeroSearchAlert, computeLowMarginAlert, alertCard, wireAlertToggles,
} from '../utils/dash-alerts.js';
import {
  dashboardMoney, unpaidBillsInRange, unpaidBillsLine, moneyTodos, missingCostItems, refundRatePct,
} from '../utils/money-truth.js';
// Robustly parse the traffic time-series (array | {data|series|points}) into
// [{ date, sessions, pageviews }] for the Performance overview overlay.
import { normalizeSeries } from '../utils/traffic-analytics.js';
import { GST_INCL, GST_EXCL, GST_BASE } from '../utils/gst-basis.js';

let _container = null;
// Race-guard for loadDashboard — see the same pattern in pages/website-traffic.js.
// Filter changes call loadDashboard() concurrently; without this, a slow earlier
// load can paint stale data on top of a newer load that already finished.
let _loadSeq = 0;
let _hasRenderedSuccessfully = false; // first-load spinner vs re-load dim
// The grain the bundle ACTUALLY served at — may be coarser than the user's pick if
// the backend rejected the finer one (getDashboardBundle escalates). Drives fmtBucket
// so the x-axis labels match the bars, even when escalation happened.

// Last successful render payload, keyed by the active filter signature. Survives SPA
// navigation (NOT cleared in destroy) so returning to the dashboard paints instantly,
// then revalidates in the background (stale-while-revalidate). In-memory Map, but the
// most-recent view is also written through to localStorage (see below) so a FULL PAGE
// REFRESH — which starts with an empty Map — paints the last-known dashboard instantly
// instead of a spinner, then revalidates just the same.
const _payloadCache = new Map();
const _PAYLOAD_CACHE_MAX = 12;
let _storageHydrated = false;   // seed the Map from localStorage exactly once per module life

// Persisted cold-load cache. Mirrors the account-keyed, fail-soft localStorage pattern used
// by AdminAPI's ui-prefs / code-universe caches (js/admin/api.js). Single entry — the last
// view rendered — which is enough because a refresh keeps the same URL/filters, so the
// last-rendered key always matches the cold-load lookup, and it bounds storage size (a
// payload can carry up to 1000 expense rows + 18 chart series).
// BUMP DASH_CACHE_SCHEMA whenever the `payload` object shape (in loadDashboard) changes, so
// a stale-shape blob from a previous deploy is ignored rather than fed to render().
const DASH_CACHE_SCHEMA = 5; // 2: added payload.sTraffic (Performance overview traffic overlay); 3: topProducts is getBestSellers()' object, not a row array; 4: its rows are server-grouped (BF-089) and a failure is { error }; 5: money from dashboard-summary (payload.dsum), no kpi-summary / missing-cost scan
function _dashCacheKey() {
  const uid = (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) ? Auth.user.id : 'anon';
  return `admin_dash_cache:${uid}`;
}
function _readPersistedPayload(cacheKey) {
  try {
    const raw = localStorage.getItem(_dashCacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== DASH_CACHE_SCHEMA) {
      try { localStorage.removeItem(_dashCacheKey()); } catch (_) { /* non-fatal */ }
      return null;
    }
    // Only reuse it for the exact same filter signature we're loading.
    return parsed.key === cacheKey ? (parsed.payload || null) : null;
  } catch (_) {
    return null;   // private mode / malformed / disabled storage
  }
}
function _writePersistedPayload(cacheKey, payload) {
  try {
    localStorage.setItem(_dashCacheKey(), JSON.stringify({ v: DASH_CACHE_SCHEMA, key: cacheKey, payload }));
  } catch (_) {
    /* quota / private mode — cold-load just falls back to the spinner next time */
  }
}
function _clearPersistedPayload() {
  try { localStorage.removeItem(_dashCacheKey()); } catch (_) { /* non-fatal */ }
}


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


// Fallback when the bundle endpoint itself fails: fetch each chart's standalone
// endpoint in parallel (the router now allows 60 req/min, so the fan-out is safe).
async function loadDashboard() {
  if (!_container) return;
  const mySeq = ++_loadSeq;
  FilterState.setBusy(true);
  try {
    await runDashboardLoad(mySeq);
  } finally {
    // Only the newest load clears the spinner. A superseded load finishing late must not
    // signal "done" while the fetch the user is actually waiting on is still in flight.
    if (mySeq === _loadSeq) FilterState.setBusy(false);
  }
}

async function runDashboardLoad(mySeq) {
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();
  // Range + bar width only: those are the only filters this page shows (see init).
  const { from: keyFrom, to: keyTo } = FilterState.getDateRange();
  const cacheKey = `${keyFrom}|${keyTo}|${FilterState.get('granularity') || ''}`;

  // On the very first load of this module life (i.e. a full page refresh — the in-memory
  // Map is empty), seed it from localStorage so the warm-cache branch below fires and we
  // paint the last-known dashboard instantly instead of a spinner. Once-only: later filter
  // changes rely on the in-memory Map, which is fresher than storage.
  if (isOwner && !_storageHydrated) {
    _storageHydrated = true;
    if (!_payloadCache.has(cacheKey)) {
      const persisted = _readPersistedPayload(cacheKey);
      if (persisted) _payloadCache.set(cacheKey, persisted);
    }
  }

  // Stale-while-revalidate: warm cache (in-memory OR seeded from storage) paints instantly
  // in full colour while revalidating; cold first load with nothing cached → spinner;
  // filter-change reload → keep the page on screen. All paths share the _loadSeq race guard
  // so a stale fetch can't paint over a newer one.
  const cached = isOwner ? _payloadCache.get(cacheKey) : null;
  if (cached) {
    // Guard the repaint: a stale-shape payload that slipped past the version gate must not
    // white-screen the page. On throw, drop the bad blob and fall back to the spinner.
    try {
      render(cached);
      _hasRenderedSuccessfully = true;
      _container.classList.add('admin-page--reloading');
    } catch (err) {
      window.DebugLog?.warn?.('[Dashboard] cached repaint failed — clearing persisted cache', err?.message || err);
      _payloadCache.delete(cacheKey);
      _clearPersistedPayload();
      if (!_hasRenderedSuccessfully) _container.innerHTML = dashboardSkeleton();
    }
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

  const { from, to } = FilterState.getDateRange();
  const range = { from, to };
  // Money is whole-business, so every call gets the date range alone — a brand/status left in
  // the URL from another page must not silently filter the graphs under whole-business tiles.
  const rangeParams = new URLSearchParams({ from, to });
  // The bundle needs a real grain; the 'all' bar width is FE-only (cumulative plot).
  const g = resolveGranularity();
  const dsumGrain = ['day', 'week', 'month'].includes(g) ? g : 'month';
  // 17 requests, none of them per-order (the old "sales missing a cost" scan made ~120 GETs).
  const promises = [
    AdminAPI.getDashboardBundle(rangeParams, g, signal),     // 0  all graph charts
    AdminAPI.getDashboardSummary(range, dsumGrain, signal),  // 1  money tiles + action lists (§6)
    AdminAPI.getCustomerStats(rangeParams, signal),          // 2  new / returning KPI
    AdminAPI.getRefundAnalytics(rangeParams, signal),        // 3  refund reasons + refund count
    // 4  invoice cost-over-price to-do. (This slot was the supplier-feed out-of-stock read, 608;
    // the Out of Stock tile now uses dashboard-summary's shopper view, 813 — backend reply
    // 2026-11-26 §3: "use 813 for a can't-be-bought to-do, 608 for a supplier view".)
    AdminAPI.listInvoices({}, 1, 100),
    AdminAPI.getOrders({ from, to }, 1, 8, signal),          // 5  recent orders table
    AdminAPI.getBestSellers(rangeParams, signal),            // 6  most-bought card
    AdminAPI.getTrackingRequests({ status: 'pending' }, signal), // 7  customer tracking requests
    // 8, 9  Worst-margin SKUs + low-margin alert (< LOW_MARGIN_PCT net). NOT dashboard-summary's
    // `under_margin_floor`: that is "under its pricing rule's floor" (80% on compatibles ⇒ 4,125
    // products), a different question. The endpoint needs a concrete source, so fetch both.
    AdminAPI.getUnderMarginProducts('genuine', 1, 60, 'under-margin', 'net_margin', 'asc', signal),
    AdminAPI.getUnderMarginProducts('compatible', 1, 60, 'under-margin', 'net_margin', 'asc', signal),
    AdminAPI.expenses.list({ limit: 1000 }, signal),          // 10 expense rows: unpaid-bills line, to-dos, chart fallback
    AdminAPI.getTrafficTimeseries(from, to, signal),         // 11 Performance overview traffic overlay
    // 12 Conversion funnel. Takes NO params — its window is fixed at 30 days server-side and
    // every filter it appears to accept is a decoy. The card says so on its face.
    AdminAPI.getConversionFunnel(signal),
    AdminAPI.getRefunds({}, 1, 100),                         // 13 pending refunds to-do
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // Race guard — bail if a newer loadDashboard() started or the page was destroyed.
  if (mySeq !== _loadSeq || !_container) return;

  // Graphs come solely from the resilient bundle (per-chart isolation server-side; a failed
  // sub-chart → null key → that one tile's empty state). No per-chart fan-out on a miss: that
  // is what trips the limiter, and api.js already retries the bundle on transient failures.
  const bundle = val(0);
  const graphs = bundleToGraphs(bundle);
  const dsum = val(1);
  _container.classList.remove('admin-page--reloading');

  const UM_LIMIT = 60;
  const umResponses = [val(8), val(9)];
  const worstMargin = normalizeWorstMargin(umResponses);
  // The low-margin count is truncated (show "N+") when a source returned a full page whose
  // every row is still under the alert threshold — i.e. there are more below it than we fetched.
  const worstMarginTruncated = umResponses.some(r => {
    const rows = firstArray(r, ['data', 'rows', 'products', 'items']);
    if (rows.length < UM_LIMIT) return false;
    const pcts = rows.map(rowMarginPct).filter(p => p != null);
    return pcts.length > 0 && Math.max(...pcts) < LOW_MARGIN_PCT;
  });

  // A list is only "loaded" when the whole of it arrived — a partial page must not read as an
  // all-clear to-do, so anything short of its own total is treated as not loaded.
  const wholeList = (resp, keys) => {
    if (!resp) return null;
    const rows = firstArray(resp, keys);
    const total = Number(resp.pagination?.total ?? resp.total ?? rows.length);
    return Number.isFinite(total) && rows.length >= total ? rows : null;
  };
  // Whole list or nothing: the to-dos scan these rows, so a list cut short by the 1000 limit
  // must read "could not load", never "None found" (the unpaid-bills line also proves its total).
  const expResp = val(10);
  const expTotal = Number(expResp?.pagination?.total);
  const expenseRows = Array.isArray(expResp?.items) && !expResp?._legacy
    && (!Number.isFinite(expTotal) || expResp.items.length >= expTotal) ? expResp.items : null;
  const needsTracking = dsum?.actions?.needs_tracking;

  const payload = {
    isOwner: true,
    // The grain the bundle ACTUALLY served at (getDashboardBundle may have escalated past
    // a backend bucket-cap rejection). Carried in the payload so a cache repaint labels its
    // x-axis to match its own bars.
    _effectiveGranularity: (bundle && bundle._granularity) || g,
    _loadedAt: new Date().toISOString(),   // drives the "Updated …" stamp in the header
    range,
    dsum,
    // The Performance overview's drift guard compares the net-profit series with the backend's
    // own total; dashboard-summary's `current` is that total (same field names as kpi-summary).
    kpis: dsum ? { current: dsum.current, previous: dsum.previous } : null,
    custStats: val(2), refunds: val(3),
    recentOrders: val(5), topProducts: val(6),
    funnel: val(12),
    trackingReq: val(7),
    // Orders still needing a tracking number (dashboard-summary: paid/processing, not invoice or
    // test, no tracking number). The rows don't repeat the empty field, so it is restated here
    // for the shared tracking card. null = the list was unavailable — said so, never "all clear".
    trackingOrders: needsTracking && needsTracking.count != null
      ? { orders: needsTracking.rows.map(r => ({ ...r, tracking_number: null })), total: needsTracking.count }
      : null,
    worstMarginSkus: worstMargin, worstMarginTruncated,
    // Raw expense rows (backend `category`). null = the list failed: the unpaid-bills line and
    // the expense to-dos then say "could not load", and the chart drops its expense lines.
    expenseRows,
    refundRows: wholeList(val(13), ['refunds', 'data', 'items']),
    invoiceRows: wholeList(val(4), ['invoices', 'data', 'items']),
    // Daily traffic rows for the Performance overview overlay; [] when the fetch failed or the
    // range has no data → both traffic lines omit and the card notes it (never a misleading zero).
    sTraffic: normalizeSeries(val(11)),
    ...graphs,
  };

  render(payload);
  _hasRenderedSuccessfully = true;
  _payloadCache.set(cacheKey, payload);
  if (_payloadCache.size > _PAYLOAD_CACHE_MAX) {
    _payloadCache.delete(_payloadCache.keys().next().value);
  }
  // Write through to localStorage so the next full page refresh paints this view instantly.
  _writePersistedPayload(cacheKey, payload);
}

// ---------- render ----------

function render(d) {
  if (!_container) return;
  // Latch the grain this payload was served at so fmtBucket labels the axis to match its
  // bars — works for both fresh loads and cache repaints (the value rides on the payload).
  setEffectiveGranularity(d._effectiveGranularity || resolveGranularity());
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
    <div id="${ALERTS_MOUNT_ID}">${renderAlertsSection(d)}</div>
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
        ${d.trackingOrders == null
          // Fail-soft LOUD: an unavailable list is not "Nothing awaiting tracking 🎉".
          ? `<div class="admin-dash__cell--6 admin-card"><div class="admin-card__title">Needs tracking <small>paid · processing</small></div>
              <div class="admin-dash-inline-empty">Could not load the orders awaiting tracking — this is not a zero. Reload to retry.</div></div>`
          : renderFulfillmentCard(d)}
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
        ${renderFunnelCard(d.funnel)}
      </div>
    </section>
    ${row('Risk', 'danger', chartCard('Refund rate', 'over time', 'dash-c-refund-rate'), chartCard('Refund reasons', 'share', 'dash-c-refund-reasons'))}
  `;

  drawAllCharts(d);
  wireHow(_container, d);
  wireOrderRowClicks(_container);
  wireTopProductsToggle(_container);
  wireAlertToggles(_container);
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
          <div class="admin-chart-box admin-chart-box--xtall"><canvas id="dash-c-overview"></canvas></div>
          <div id="dash-overview-notes"></div>
        </div>
      </div>
    </section>
  `;
}

// ---------- action alerts ----------

const ALERTS_MOUNT_ID = 'dash-alerts-mount';

// A to-do whose list did not load. Neutral count, and it says it is not a zero.
const failCard = (title, why, span) => alertCard(title, '—', `${why} — this is not a zero. Reload to retry.`, [], 'warning', '', span);

function renderAlertsSection(d) {
  const span = 3;
  // The orders list is the core of this card; without it the count would silently cover only
  // customer requests, so the card says it could not load (even if the requests did).
  const tracking = d.trackingOrders == null ? null : computeTrackingAlert(d.trackingReq, d.trackingOrders);
  const zero = computeZeroSearchAlert(d.searchZero);
  const lowMargin = computeLowMarginAlert(d.worstMarginSkus, d.marginBrand, d.worstMarginTruncated);
  const lowUnit = lowMargin.grain === 'brand' ? 'brands' : 'SKUs';
  const lowCount = `${lowMargin.count}${lowMargin.capped ? '+' : ''}`;
  // dashboard-summary's own list of sales with no cost of goods (replaces the old ~120-GET scan).
  // Order links go through the ONE order-number vocabulary (ERR-198).
  const orderRefFor = (n) => window.OrderNumber.forDisplay(n) || n;
  const missing = missingCostItems(d.dsum?.actions?.missing_cost, orderRefFor);
  const todos = moneyTodos({ range: d.range, expenses: d.expenseRows, refunds: d.refundRows, invoices: d.invoiceRows, orderRef: orderRefFor });

  const cards = [
    tracking == null
      ? failCard('Orders needing tracking', 'the list of orders awaiting tracking could not load', span)
      : alertCard('Orders needing tracking', tracking.count,
        'paid/processing orders with no tracking number, plus customer tracking requests', tracking.items, tracking.count > 0 ? 'danger' : null, 'All caught up', span),
    missing == null
      ? failCard('Sales missing a cost', 'the backend could not list sales with no cost of goods', span)
      : alertCard('Sales missing a cost', `${missing.count}`,
        'these sales have no cost of goods recorded, so profit for any range containing them is AT MOST the figure shown — add the cost',
        missing.items, missing.count > 0 ? 'danger' : null, 'Every sale has a cost', span),
    alertCard('Low-margin products', lowCount,
      `${lowUnit} under ${LOW_MARGIN_PCT}% net margin — reprice or drop`, lowMargin.items, lowMargin.count > 0 ? 'warning' : null, 'None under threshold', span),
    alertCard('Zero-result searches', zero.count,
      `searches with ≥${ZERO_SEARCH_MIN} hits returning nothing — add products/synonyms`, zero.items, zero.count > 0 ? 'warning' : null, 'No high-volume misses', span),
  ];
  // Money housekeeping, read from lists the page already has. Each list that failed says so.
  const moneyCards = [
    todos.taxAsExpense == null
      ? failCard('Tax payment filed as an expense', 'the expense list could not load', span)
      : alertCard('Tax payment filed as an expense', todos.taxAsExpense.length,
        'it is subtracted from net profit until it is moved to “GST / tax payment to IRD”', todos.taxAsExpense, todos.taxAsExpense.length ? 'danger' : null, 'None found', span),
    todos.duplicates == null
      ? failCard('Possible duplicate expenses', 'the expense list could not load', span)
      : alertCard('Possible duplicate expenses', todos.duplicates.length,
        'same payee, similar amount, within 5 days — check before it doubles a cost', todos.duplicates, todos.duplicates.length ? 'warning' : null, 'None found', span),
    todos.pendingRefunds == null
      ? failCard('Refunds still pending', 'the refunds list could not load', span)
      : alertCard('Refunds still pending', todos.pendingRefunds.length,
        'not taken off revenue until processed', todos.pendingRefunds, todos.pendingRefunds.length ? 'warning' : null, 'None pending', span),
    todos.invoiceCostOverPrice == null
      ? failCard('Invoices costing more than their price', 'the invoice list could not load', span)
      : alertCard('Invoices costing more than their price', todos.invoiceCostOverPrice.length,
        'our cost is above the invoice price, both excl. GST', todos.invoiceCostOverPrice, todos.invoiceCostOverPrice.length ? 'danger' : null, 'None found', span),
  ];
  return rowN('Action needed', 'danger', cards) + rowN('Money housekeeping', 'danger', moneyCards);
}

// ---------- KPI band ----------

function deltaFor(t, noDelta) {
  if (noDelta || t.prev === undefined) return '';
  return deltaBadge(t.raw, t.prev, t.deltaOpts || {});
}

function renderKpiTile(t, extraClass = '', noDelta = false) {
  const alertCls = t.alert ? ' admin-kpi--alert' : '';
  const tipAttr = t.tooltip ? ` data-tooltip="${esc(t.tooltip)}"` : '';
  // A money tile opens "How it's calculated"; it is a button so the keyboard reaches it.
  const tag = t.how ? 'button' : 'div';
  const howAttr = t.how ? ` type="button" data-how="${esc(t.how)}" aria-label="${esc(`${t.label}: how it's calculated`)}"` : '';
  let h = `<${tag} class="admin-kpi admin-kpi--compact${t.how ? ' admin-kpi--how' : ''}${alertCls}${extraClass}"${howAttr}>`;
  h += `<div class="admin-kpi__label"${tipAttr}>${esc(t.label)}${t.atMost ? ' <span class="admin-kpi__flag">at most</span>' : ''}</div>`;
  // GST basis under the label. Absent = basis not documented — never assume "no line" means "no GST".
  if (t.gst) h += `<div class="admin-kpi__basis">${esc(t.gst)}</div>`;
  if (t.value != null) {
    h += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
    if (t.sub) h += `<div class="admin-kpi__sub">${esc(t.sub)}</div>`;
    h += deltaFor(t, noDelta);
  } else {
    h += missingValue(t.missingWhy || t.tooltip || 'Data unavailable');
    if (t.sub) h += `<div class="admin-kpi__sub">${esc(t.sub)}</div>`;
  }
  h += `</${tag}>`;
  return h;
}

const money = (v) => (v == null ? null : formatPrice(v));

function renderKpiStrip(d) {
  const m = dashboardMoney(d.dsum);
  const f = m.figures;
  const cc = d.custStats?.current ?? {};
  const cp = d.custStats?.previous ?? {};
  const noDelta = FilterState.get('period') === 'all';   // all-time → deltas are meaningless
  // What a shopper sees as out of stock — active, stock 0, packs included (dashboard-summary
  // `actions.out_of_stock`, backend reply 2026-11-26 §3). null = that list was unavailable.
  const oosCount = d.dsum?.actions?.out_of_stock?.count ?? null;
  const newCustomers = cc.new_customers ?? cc.new ?? null;
  const newCustomersPrev = cp.new_customers ?? cp.new ?? null;
  // Processed refunds in range (refunds-series, dated on refunded_at) ÷ the orders the money
  // counts. Since 2026-11-26 (backend §2) kpi-summary's `refund_rate` uses this same definition
  // (October 0.0, 26 Oct–25 Nov 1.9 — measured equal); this page reads it from the two lists it
  // already has rather than paying for a kpi-summary call.
  const refundPct = f ? refundRatePct(d.refunds, f.orders.value) : null;
  const unpaid = f ? unpaidBillsInRange(d.expenseRows, d.range, d.dsum.current.operating_expenses) : null;
  const why = (fig) => fig?.note || 'Not available for this range.';
  const tiles = f ? [
    { label: 'Revenue', how: 'revenueInclGst', value: money(f.revenueInclGst.value), raw: f.revenueInclGst.value, prev: f.revenueInclGst.prev,
      gst: GST_INCL, missingWhy: why(f.revenueInclGst),
      sub: f.revenueInclGst.refunds ? `after ${formatPrice(f.revenueInclGst.refunds)} refunds` : '',
      tooltip: 'Sales incl. GST, minus refunds processed in the range (on the refund date). Invoices count on their issue date, paid or not. Click for how it’s calculated.' },
    { label: 'Gross Profit', how: 'grossProfit', value: money(f.grossProfit.value), raw: f.grossProfit.value, prev: f.grossProfit.prev,
      stackNext: true, gst: GST_EXCL, atMost: f.grossProfit.atMost, missingWhy: why(f.grossProfit),
      alert: f.grossProfit.atMost,
      tooltip: `Revenue after refunds − cost of goods, both excl. GST. A refund takes the whole ex-GST amount off; goods are not restocked.${f.grossProfit.note ? ` ${f.grossProfit.note}` : ''}` },
    { label: 'Gross Margin', value: fmtPct(f.grossMargin.value), raw: f.grossMargin.value, prev: f.grossMargin.prev,
      alert: f.grossMargin.value != null && f.grossMargin.value < 0, gst: GST_BASE,
      tooltip: 'Gross profit ÷ revenue, both ex GST. Profit quality, not size.' },
    { label: 'Net Profit', how: 'netProfit', value: money(f.netProfit.value), raw: f.netProfit.value, prev: f.netProfit.prev,
      stackNext: true, gst: GST_EXCL, atMost: f.netProfit.atMost, missingWhy: why(f.netProfit),
      alert: (f.netProfit.value != null && f.netProfit.value < 0) || f.netProfit.atMost,
      // Net profit ALREADY includes every bill dated in the range, paid or not (accrual). The
      // second line only says how much of that is still unpaid — it never subtracts again.
      sub: unpaidBillsLine(unpaid),
      tooltip: `Gross profit − Stripe fees − supplier freight − operating expenses, all ex-GST. Expenses count on their bill date, paid or not; a GST payment to IRD is not an expense. Invoiced sales carry no card fee. KNOWN DIFFERENCE: the backend divides Stripe’s 2.65% + $0.30 by 1.15, an order’s own modal deducts it as-is, so a modal take-home reads about $0.47 per card order lower (ERR-255).${f.netProfit.note ? ` ${f.netProfit.note}` : ''}` },
    { label: 'Net Margin', value: fmtPct(f.netMargin.value), raw: f.netMargin.value, prev: f.netMargin.prev,
      alert: f.netMargin.value != null && f.netMargin.value < 0, gst: GST_BASE,
      tooltip: 'Net profit ÷ revenue, both ex GST. What you actually keep.' },
    { label: 'Orders', how: 'orders', value: f.orders.value != null ? String(f.orders.value) : null, raw: f.orders.value, prev: f.orders.prev,
      tooltip: f.orders.note },
    { label: 'Avg Order Value', how: 'aov', value: money(f.aov.value), raw: f.aov.value, prev: f.aov.prev, gst: GST_INCL,
      tooltip: f.aov.note },
    { label: 'New Customers', value: newCustomers != null ? String(newCustomers) : null, raw: newCustomers, prev: newCustomersPrev,
      tooltip: 'First-time buyers in the range.' },
    {
      // The backend counts a buyer as returning when they ordered BEFORE the range. All time
      // has no "before", so it answers 0 by construction (ERR-366): show "—" and say why.
      label: 'Returning %',
      value: noDelta ? null : (cc.returning_pct != null ? `${cc.returning_pct}%` : null),
      raw: noDelta ? null : cc.returning_pct, prev: cp.returning_pct,
      tooltip: noDelta
        ? 'Share of buyers who had ordered before the range. All time has no earlier period to return from, so pick a bounded range to see it.'
        : 'Share of buyers who had ordered before the range.',
    },
    { label: 'Refund Rate', value: refundPct != null ? `${refundPct.toFixed(1)}%` : null,
      alert: refundPct != null && refundPct > 3,
      tooltip: 'Refunds processed in the range (on the refund date) ÷ orders. A count, not a value. Flagged above 3%.' },
    { label: 'Owed to us', how: 'owed', value: money(f.owed.value), raw: f.owed.value, prev: undefined, gst: GST_INCL,
      alert: f.owed.value != null && f.owed.value > 0, tooltip: f.owed.note },
    { label: 'Out of Stock', value: oosCount != null ? String(oosCount) : null, prev: undefined,
      alert: oosCount > 0, missingWhy: 'The out-of-stock list could not load — this is not a zero.',
      tooltip: 'Products a shopper sees as out of stock right now (active, stock 0), including packs whose parts are out. The supplier-feed view (genuine feed stock ≤ 0) is on Margins → Out of stock.' },
  ] : [];

  if (!f) {
    return `<div class="admin-kpi-grid admin-kpi-grid--9"></div>
      <p class="fh-pnl-note admin-dash-note--alert">${esc(m.warnings[0])}</p>`;
  }
  // Each profit tile (stackNext) shares one grid cell with the margin tile that follows it.
  let html = '<div class="admin-kpi-grid admin-kpi-grid--10">';
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
  // Fail-soft must be LOUD: an un-costed sale, failed freight or a backend figure that does
  // not add up is written under the strip, not only in a tooltip.
  for (const w of m.warnings) html += `<p class="fh-pnl-note admin-dash-note--alert">${esc(w)}</p>`;
  return html;
}

// ---------- How it's calculated ----------

const HOW = {
  revenueInclGst: { label: 'Revenue', formula: 'Sales incl. GST (shipping charged included) − refunds and chargebacks processed in this period. Web orders count on the day they were placed; invoices on their issue date, paid or not. Cancelled and test orders are left out.' },
  grossProfit: { label: 'Gross Profit', formula: 'Revenue ex GST (after refunds) − cost of goods ex GST. An invoice counts its revenue and cost on its issue date. A refund takes the whole ex-GST amount off; the goods are not restocked.' },
  netProfit: { label: 'Net Profit', formula: 'Gross profit − Stripe card fees − supplier freight − operating expenses, all ex GST. Expenses count on their bill date, paid or not. A GST payment to IRD is not an expense.' },
  orders: { label: 'Orders', formula: 'Web orders placed in the period, plus invoices issued in it. A refunded order still counts; cancelled and test orders do not.' },
  aov: { label: 'Avg Order Value', formula: 'Revenue incl. GST (after refunds) ÷ orders — the backend’s figure.' },
  owed: { label: 'Owed to us', formula: 'Unpaid invoices issued on or before the last day of the period, incl. GST.' },
};

function inputsTable(inputs) {
  if (!inputs.length) return '';
  const rows = inputs.map((i) => `
    <tr>
      <td>${esc(i.label)}</td>
      <td class="cell-mono dash-how-amt">${esc(formatPrice(i.amount))}</td>
      <td class="dash-how-src">${esc(i.source)}</td>
    </tr>`).join('');
  return `<table class="admin-dash-table dash-how-table"><thead><tr><th>Input</th><th>Amount</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function openHow(d, key) {
  const m = dashboardMoney(d.dsum);
  const fig = m.figures?.[key];
  const meta = HOW[key];
  if (!meta) return;
  const parts = [`<p class="dash-how-formula">${esc(meta.formula)}</p>`];
  if (!fig || fig.value == null) {
    parts.push(`<p class="fh-pnl-note admin-dash-note--alert">${esc(fig?.note || m.warnings[0] || 'Not available for this range.')}</p>`);
  } else {
    parts.push(inputsTable(fig.inputs || []));
    parts.push(`<p class="dash-how-total">= <strong>${esc(key === 'orders' ? String(fig.value) : formatPrice(fig.value))}</strong>${fig.basis ? ` <small>${esc(fig.basis)}</small>` : ''}</p>`);
    if (fig.note) parts.push(`<p class="fh-pnl-note${fig.atMost ? ' admin-dash-note--alert' : ''}">${esc(fig.note)}</p>`);
    const ratio = key === 'grossProfit' ? m.figures.grossMargin : key === 'netProfit' ? m.figures.netMargin : null;
    if (ratio?.value != null) parts.push(`<p>Margin: ${esc(fmtPct(ratio.value))} of revenue ex GST.</p>`);
  }
  const r = d.range ? `${d.range.from} – ${d.range.to}` : '';
  parts.push(`<p class="fh-pnl-note">Source: the backend’s dashboard summary for ${esc(r)} (NZ days). This screen adjusts nothing; “calculated” rows are GST arithmetic only.</p>`);
  const dr = Drawer.open({
    title: `${meta.label} — how it’s calculated`,
    body: `<div class="dash-how-body">${parts.join('')}</div>`,
    footer: '<button class="admin-btn admin-btn--ghost" data-x="close">Close</button>',
  });
  dr?.footer?.querySelector('[data-x="close"]')?.addEventListener('click', () => Drawer.close());
}

function wireHow(root, d) {
  root.querySelectorAll('[data-how]').forEach((btn) => btn.addEventListener('click', () => openHow(d, btn.dataset.how)));
}


// ---------- page lifecycle ----------

export default {
  title: 'Dashboard',

  async init(container) {
    _container = container;
    // Dashboard-local defaults (range = all) applied only when the URL omits them,
    // and the bar-width control shown for this page only.
    FilterState.setDefaults({ period: 'all', granularity: 'all' });
    // Money is whole-business (dashboard-summary takes no brand/supplier/status filter), so
    // only the period and bar-width controls are shown — a filter that changed nothing above
    // it would be a lie.
    FilterState.setVisibleFilters(['period']);
    FilterState.setGranularityVisible(true);
    await loadDashboard();
  },

  destroy() {
    Charts.destroyAll();
    FilterState.setGranularityVisible(false);   // hide bar-width control on other pages
    FilterState.setVisibleFilters(null);        // other pages show their own filters again
    // _loadSeq++ below makes any in-flight load decline to clear the spinner, so clear it
    // here — otherwise navigating away mid-load strands one in the next page's filter bar.
    FilterState.setBusy(false);
    _container = null;
    _hasRenderedSuccessfully = false;
    _loadSeq++;                                  // any in-flight load now stale-checks and bails
  },

  async onFilterChange() {
    if (_container) await loadDashboard();
  },
};
