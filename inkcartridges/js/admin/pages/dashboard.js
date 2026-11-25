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
import {
  formatPrice, MISSING, numOrNull, timeAgo, firstArray, safeDiv, resolveGranularity,
  rangeLabel, rowMarginPct, normalizeWorstMargin, orderRef, drawPerformanceOverview, buildOverviewBuckets,
  drawSeries, drawRanked, drawShare, drawRevenueProfit, drawForecast, bundleToGraphs, renderFunnelCard,
  chartCard, row, rowN, renderFulfillmentCard, fmtPct, planProfitLine, recoverProfitFromSeries,
  renderRecentOrdersCard, wireOrderRowClicks, renderTopProductsCard, wireTopProductsToggle,
  setEffectiveGranularity,
} from '../utils/dash-charts.js';
// Robustly parse the traffic time-series (array | {data|series|points}) into
// [{ date, sessions, pageviews }] for the Performance overview overlay.
import { normalizeSeries } from '../utils/traffic-analytics.js';
import { GST_INCL, GST_EXCL, GST_BASE } from '../utils/gst-basis.js';



/** Money to the cent. Keeps a subtracted bucket from carrying float dust. */
const round2 = (n) => Math.round(n * 100) / 100;

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
const DASH_CACHE_SCHEMA = 4; // 2: added payload.sTraffic (Performance overview traffic overlay); 3: topProducts is getBestSellers()' object, not a row array; 4: its rows are server-grouped (BF-089) and a failure is { error }
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



// /margin/out-of-stock answers `{ok, data:{out_of_stock:[…limit rows], total_out_of_stock, pagination}}`.
// The old reader looked for `total` / `items` and found neither, so the tile read 0 while the
// backend reported 530 (ERR-366). The row array is only the requested page (limit 5), so its
// length is never the count unless no total came back at all.
function outOfStockCount(data) {
  if (data == null) return null;
  const d = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : data;
  const total = numOrNull(d.total_out_of_stock ?? d.pagination?.total ?? d.total);
  if (total != null) return total;
  return firstArray(d, ['out_of_stock', 'items', 'products', 'data']).length;
}

function sumRefundAmounts(refunds) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  if (!series.length) return null;
  return series.reduce((sum, r) => sum + Number(r.refund_amount ?? r.amount ?? r.total ?? 0), 0);
}

// ---------- action-alert data shaping ----------


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
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();
  const g = resolveGranularity();
  const cacheKey = params.toString();   // includes granularity via getParams()

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

  const from = params.get('from'), to = params.get('to');
  // Traffic time-series feeds the Performance overview's Sessions/Pageviews overlay. Its endpoint
  // needs an explicit from/to; the all-time view leaves both blank, so pass a wide fallback (the
  // backend clamps to available data and out-of-range rows drop during client-side re-bucketing).
  const trafficFrom = from || '2000-01-01';
  const trafficTo   = to   || new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date());   // NZ day (ERR-367)
  // One bundle call covers all 18 graph charts (backend's preferred path — avoids
  // the parallel fan-out that tripped the rate limiter). The KPI band, tables and
  // refund reasons stay on their existing dedicated endpoints. The last three feed the
  // "Action needed" panel + worst-margin card, and the last two the cash-basis
  // adjustment for invoiced sales, plus the unpaid-bills summary. 17 calls total (under the 60/min limit).
  const promises = [
    AdminAPI.getDashboardBundle(params, g, signal),          // 0  all graph charts
    AdminAPI.getDashboardKPIs(params, signal),               // 1  KPI band
    AdminAPI.getCustomerStats(params, signal),               // 2  new / returning KPI
    AdminAPI.getRefundAnalytics(params, signal),             // 3  refund reasons + rate KPI
    AdminAPI.getOutOfStock({ limit: 5 }, signal),            // 4  out-of-stock KPI
    AdminAPI.getOrders({ from, to }, 1, 8, signal),          // 5  recent orders table
    AdminAPI.getBestSellers(params, signal),                 // 6  most-bought card (revenue / units / orders)
    AdminAPI.getTrackingRequests({ status: 'pending' }, signal), // 7  alert: orders needing tracking
    AdminAPI.getOrders({ from, to, statuses: ['paid', 'processing'] }, 1, 50, signal), // 8  alert: untracked open orders
    // Worst-margin SKUs + low-margin alert. The endpoint needs a concrete source ('' → 400),
    // so fetch genuine + compatible worst-first and merge. limit:60 each gives a deep enough
    // tail to count everything under the alert threshold accurately for this catalog.
    AdminAPI.getUnderMarginProducts('genuine', 1, 60, 'under-margin', 'net_margin', 'asc', signal),    // 9
    AdminAPI.getUnderMarginProducts('compatible', 1, 60, 'under-margin', 'net_margin', 'asc', signal), // 10
    AdminAPI.expenses.list({ limit: 1000 }, signal),          // 11  raw expense records → trend lines
    AdminAPI.getTrafficTimeseries(trafficFrom, trafficTo, signal), // 12  Performance overview traffic overlay
    // 13  Conversion funnel. Takes NO params — its window is fixed at 30 days
    // server-side and every filter it appears to accept is a decoy (see the
    // method's comment). The card says so on its face rather than pretending to
    // follow the page's range.
    AdminAPI.getConversionFunnel(signal),
    // 14  Unpaid operating bills (overdue + due) for the Net Profit tile's second
    // line (ERR-392). Net profit is cash basis — an unpaid bill is not in it yet.
    AdminAPI.expenses.summary({ from, to }),
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // Race guard — bail if a newer loadDashboard() started or the page was destroyed.
  if (mySeq !== _loadSeq || !_container) return;

  // Which sales are stopping the backend computing profit? This owns its own order fetch —
  // it must see EVERY status, and index 8 is filtered to paid|processing for the tracking
  // card. Reusing it is what made this scan blind (ERR-074).
  //
  // ⚠ It is DELIBERATELY NOT AWAITED HERE. The scan costs up to ~1 order-list page plus 120
  // order-detail GETs; awaiting it put ~20 sequential round-trips between "all chart data has
  // arrived" and "anything is on screen", which is what made the whole dashboard — the
  // Performance overview most visibly — take seconds to paint for one alert card's sake.
  // It now runs in the background and patches only its own card (see startMissingCostScan).
  const missingCost = { pending: true, cogsUnknown: val(1)?.current ? val(1).current.gross_profit == null : false };

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
    funnel: val(13),
    // number | null. null = summary failed ⇒ the tile SAYS so (never "no unpaid bills").
    unpaidBills: unpaidBillsOf(val(14)),
    trackingReq: val(7), trackingOrders: val(8),
    worstMarginSkus: worstMargin, worstMarginTruncated,
    // Raw expense records for the performance chart's Added/Total expense lines.
    // Fails soft to [] so a null expenses fetch just drops those two lines, never the page.
    expenseRows: (val(11)?.items) || [],
    // Daily traffic rows for the Performance overview overlay; [] when the fetch failed or the
    // range has no data → both traffic lines omit and the card notes it (never a misleading zero).
    sTraffic: normalizeSeries(val(12)),
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

  // Everything above is on screen. NOW pay for the missing-cost scan, off the critical path.
  startMissingCostScan({ from, to }, val(1), signal, mySeq, cacheKey, payload);
}

/**
 * Run the missing-cost scan in the background and patch its card in place when it lands.
 *
 * Not awaited by the caller — that is the entire point. The result is written back into the
 * payload object that is already banked in `_payloadCache` (same object reference) and
 * re-persisted, so a later stale-while-revalidate repaint shows the real count instead of a
 * frozen "checking…".
 */
function startMissingCostScan(range, kpis, signal, mySeq, cacheKey, payload) {
  computeMissingCostAlert(range, kpis, signal)
    .then((result) => {
      // A scan that resolved to nothing at all is not a clean bill of health.
      applyMissingCost(payload, result || { failed: true, cogsUnknown: payload.missingCost?.cogsUnknown }, mySeq, cacheKey);
    })
    .catch((err) => {
      if (err?.name === 'AbortError' || signal?.aborted) return;   // superseded load / left the page
      window.DebugLog?.warn?.('[Dashboard] missing-cost scan failed', err?.message || err);
      applyMissingCost(payload, { failed: true, cogsUnknown: payload.missingCost?.cogsUnknown }, mySeq, cacheKey);
    });
}

// Patch the banked payload + the "Action needed" panel with a settled (or failed) scan.
// Repaints ONLY that panel — re-rendering the whole dashboard would tear down and rebuild
// all 18 Chart.js instances for one card.
function applyMissingCost(payload, missingCost, mySeq, cacheKey) {
  payload.missingCost = missingCost;
  // Re-persist so a cold load repaints the settled count, not the pending placeholder.
  if (_payloadCache.get(cacheKey) === payload) _writePersistedPayload(cacheKey, payload);

  // Same race guard as the main load: a superseded scan must never paint over a newer one.
  if (mySeq !== _loadSeq || !_container) return;
  const mount = _container.querySelector(`#${ALERTS_MOUNT_ID}`);
  if (!mount) return;   // page re-rendered from a different path; the banked payload still has it
  mount.innerHTML = renderAlertsSection(payload);
  wireAlertToggles(mount);
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
        ${renderFunnelCard(d.funnel)}
      </div>
    </section>
    ${row('Risk', 'danger', chartCard('Refund rate', 'over time', 'dash-c-refund-rate'), chartCard('Refund reasons', 'share', 'dash-c-refund-reasons'))}
  `;

  drawAllCharts(d);
  wireOrderRowClicks(_container);
  wireTopProductsToggle(_container);
  wireAlertToggles();
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

// "Action needed" panel — surfaces what the owner should do today. The card itself is NOT a
// link; each row is its own clickable link to that item's page. Shows up to ALERT_PREVIEW rows
// and expands to the full list on demand (wireAlertToggles).
const ALERT_PREVIEW = 5;

// The "Action needed" panel is the ONE region that repaints on its own, after first paint:
// the missing-cost scan is deliberately off the critical path (see runDashboardLoad), so the
// panel first renders a pending state and is re-rendered in place when the scan lands.
const ALERTS_MOUNT_ID = 'dash-alerts-mount';

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
  // The scan no longer blocks first paint, so it has two states the card must not conflate
  // with a result: still running, and failed. Neither is "0 sales missing a cost" — presenting
  // an unfinished or failed scan as a clean bill of health is the ERR-074 bug wearing a new hat.
  const scanPending = !!missingCost?.pending;
  const scanFailed  = !!missingCost?.failed;
  const scanSettled = !!missingCost && !scanPending && !scanFailed;
  const hasCulprits  = scanSettled && missingCost.count > 0;
  // Only cry "degraded" when the tiles are actually blank — if the series rebuild worked,
  // the dashboard is functional and the tile's own tooltip carries the provenance. Requires a
  // SETTLED scan: "no culprits" is only meaningful once we've actually looked.
  const showDegraded = scanSettled && !hasCulprits && cur.gross_profit == null && !recovered;
  const showFourth   = hasCulprits || showDegraded || scanPending || scanFailed;
  const span = showFourth ? 3 : 4;

  const cards = [
    alertCard('Orders needing tracking', tracking.count,
      'paid/processing orders awaiting tracking', tracking.items, tracking.count > 0 ? 'danger' : null, 'All caught up', span),
    alertCard('Zero-result searches', zero.count,
      `searches with ≥${ZERO_SEARCH_MIN} hits returning nothing — add products/synonyms`, zero.items, zero.count > 0 ? 'warning' : null, 'No high-volume misses', span),
    alertCard('Low-margin products', lowCount,
      lowWhy, lowMargin.items, lowMargin.count > 0 ? 'warning' : null, 'None under threshold', span),
  ];

  if (scanPending) {
    // Neutral severity and an em-dash count: this says "not known yet", never "all clear".
    cards.push(alertCard('Sales missing a cost', '—',
      'checking every sale in this range for a recorded cost — the dashboard above is already up to date',
      [], null, '', span));
  } else if (scanFailed) {
    cards.push(alertCard('Sales missing a cost', '—',
      'the cost scan failed, so whether any sale is missing a cost is UNKNOWN — this is not a zero. Reload to retry',
      [], 'warning', '', span));
  } else if (hasCulprits) {
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

// Local copy of the orders.js predicate (canonical version + rationale: pages/orders.js
// `isInvoiceOrder`). Importing it would drag DataTable/Drawer/Modal in for a one-line test,
// so the rules are mirrored — INCLUDING the `channel` check, which this copy was missing.
// Without it a backend that starts sending `channel: 'invoice'` on non-INV- numbered rows
// would route them to the wrong page here while orders.js classified them correctly.
const isInvoiceOrder = (o) => {
  if (!o) return false;
  if (o.channel) return String(o.channel).toLowerCase() === 'invoice';
  if (o.payment_method) return String(o.payment_method).toLowerCase() === 'invoice';
  return /^INV-/i.test(String(o.order_number || ''));
};

async function computeMissingCostAlert(range, kpis, signal) {
  const cogsUnknown = kpis?.current ? kpis.current.gross_profit == null : false;
  const base = { cogsUnknown, count: 0, items: [], scanned: 0, incomplete: false };

  // Every status, not just the two the tracking card cares about. Cancelled orders carry no
  // revenue and the backend excludes them from COGS, so they're excluded here too — counting
  // them would invent culprits the backend never looks at.
  //
  // Page 1 first — its `pagination` tells us how many pages actually exist, so the remaining
  // pages go out in ONE parallel batch instead of a serial walk. (The old loop paid a full
  // round-trip per page just to discover whether a next page existed.)
  const list = [];
  let incomplete = false;
  const fetchPage = (page) =>
    AdminAPI.getOrders({ from: range.from, to: range.to }, page, MISSING_COST_PAGE, signal);

  const first = await fetchPage(1);
  const firstRows = firstArray(first, ['orders', 'data', 'items']);
  list.push(...firstRows);

  if (firstRows.length >= MISSING_COST_PAGE) {
    // Trust the backend's page count when it gives one; otherwise fall back to walking to the
    // cap. Either way MISSING_COST_MAX_PAGES is the hard ceiling.
    const pg = first?.pagination || {};
    const total = Number(pg.total_pages ?? (Number(pg.total) ? Math.ceil(Number(pg.total) / MISSING_COST_PAGE) : NaN));
    const wanted = Number.isFinite(total) && total > 0 ? total : MISSING_COST_MAX_PAGES;
    const last = Math.min(wanted, MISSING_COST_MAX_PAGES);
    if (wanted > MISSING_COST_MAX_PAGES) incomplete = true;   // more pages exist than we read

    const rest = [];
    for (let page = 2; page <= last; page++) rest.push(fetchPage(page));
    const settled = await Promise.allSettled(rest);
    settled.forEach((res, idx) => {
      // A page we failed to fetch is a page we did NOT scan. Say so.
      if (res.status !== 'fulfilled') { incomplete = true; return; }
      const rows = firstArray(res.value, ['orders', 'data', 'items']);
      list.push(...rows);
      // No page count came back and the last page we read was still full → there is more.
      if (idx + 2 === last && !Number.isFinite(total) && rows.length >= MISSING_COST_PAGE) incomplete = true;
    });
  }
  // An aborted fetch returns null → firstArray → [] → an EMPTY list that is indistinguishable
  // from "this range genuinely has no orders". Reporting that as `count: 0` would print
  // "All sales are costed" off the back of a scan that never ran — the ERR-074 conflation.
  // Abort is not a result; say so and let the card render its unknown state.
  if (signal?.aborted) return { cogsUnknown, failed: true };

  const revenueOrders = list.filter(o => String(o.status || '').toLowerCase() !== 'cancelled');
  if (!revenueOrders.length) return base;

  const totalOf = (o) => Number(o.total_amount ?? o.total ?? 0) || 0;

  const budget = revenueOrders.slice(0, MISSING_COST_DETAIL_CAP);
  if (budget.length < revenueOrders.length) incomplete = true;

  const culprits = [];
  // Count what we ACTUALLY looked at — `budget.length` overstates it the moment the loop
  // breaks early, and `scanned` is what the card prints to justify a clean bill of health.
  let scanned = 0;
  for (let i = 0; i < budget.length; i += MISSING_COST_BATCH) {
    const batch = budget.slice(i, i + MISSING_COST_BATCH);
    if (signal?.aborted) { incomplete = true; break; }   // superseded load / left the page
    const results = await Promise.allSettled(batch.map(o => AdminAPI.getOrder(o.id, signal)));
    scanned += batch.length;
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
    scanned,
    count: culprits.length,
    items: culprits.map(({ order, reason }) => ({
      label: `${orderRef(order.order_number || order.id)} · ${formatPrice(totalOf(order))}`,
      badge: reason,
      badgeCls: 'admin-badge--failed',
      // Invoiced sales are fixed in the invoice editor ("Our Cost"); a website order's
      // cost lives on the product.
      // `?search=` was read by NOTHING — orders.js reads `focus` and `q` only, so
      // this link had never once filtered the list it landed on (ERR-198). `focus`
      // seeds the search AND opens the order.
      href: isInvoiceOrder(order) ? 'invoices' : `orders?focus=${encodeURIComponent(window.OrderNumber.forDisplay(order.order_number))}`,
    })),
  };
}

// Expand/collapse the alert item lists (show all ↔ show first ALERT_PREVIEW).
// Takes a root so the alerts panel can be re-wired on its own after the background
// missing-cost scan repaints it, without re-binding buttons elsewhere on the page.
function wireAlertToggles(root = _container) {
  root?.querySelectorAll('[data-alert-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = btn.previousElementSibling;
      const collapsed = list?.classList.toggle('admin-alert-card__list--collapsed');
      const total = list?.querySelectorAll('.admin-alert-card__item').length || 0;
      btn.textContent = collapsed ? `Show all ${total}` : 'Show less';
    });
  });
}


// ---------- KPI band ----------

function renderKpiTile(t, extraClass = '', noDelta = false) {
  const alertCls = t.alert ? ' admin-kpi--alert' : '';
  const tipAttr = t.tooltip ? ` data-tooltip="${esc(t.tooltip)}"` : '';
  let h = `<div class="admin-kpi admin-kpi--compact${alertCls}${extraClass}">`;
  h += `<div class="admin-kpi__label"${tipAttr}>${esc(t.label)}</div>`;
  // GST basis under the label. Absent = basis not documented (Refund Rate's
  // numerator, for one) — never assume "no line" means "no GST".
  if (t.gst) h += `<div class="admin-kpi__basis">${esc(t.gst)}</div>`;
  if (t.value != null) {
    h += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
    // Recognition basis, under the value. Distinct from __basis above, which
    // states the GST basis — one says which dollars, the other says whose.
    if (t.sub) h += `<div class="admin-kpi__sub">${esc(t.sub)}</div>`;
    // In all-time view every "previous" is 0, so deltas read "↑ new" everywhere — noise.
    if (!noDelta) h += deltaBadge(t.raw, t.prev, t.deltaOpts || {});
  } else {
    h += missingValue(t.tooltip || 'Data unavailable');
  }
  h += '</div>';
  return h;
}

/**
 * Unpaid operating bills (ERR-392) from GET /api/admin/expenses/summary — the same
 * server `overdue_amount` + `due_amount` the Expenses page's Unpaid tile uses.
 * GLOBAL open amounts (not range-scoped) at GROSS. null when either is missing:
 * a half-read total would understate what is owed.
 */
function unpaidBillsOf(resp) {
  const s = resp?.summary ?? resp;
  if (!s || typeof s !== 'object' || s.overdue_amount == null || s.due_amount == null) return null;
  const total = Number(s.overdue_amount) + Number(s.due_amount);
  return Number.isFinite(total) ? Math.round(total * 100) / 100 : null;
}

/**
 * Second line under Net Profit. Net profit is cash basis, so a bill still owed is
 * not in it — this line shows what is left once those bills are paid.
 *   undefined unpaid → '' (a cached payload from before this line existed)
 *   null unpaid      → says the read failed — never prints "no unpaid bills"
 */
function unpaidBillsSub(netProfit, unpaid) {
  if (unpaid === undefined || netProfit == null) return '';
  if (unpaid === null) return 'unpaid bills: could not load — see Expenses';
  if (unpaid === 0) return 'no unpaid bills';
  return `${formatPrice(netProfit - unpaid)} after ${formatPrice(unpaid)} unpaid bills`;
}

/**
 * Guard: a margin the backend reports must agree with the profit tile sitting beside it.
 *
 * We prefer the backend's own `margin_proxy` / `gross_margin` / `net_margin` (ERR-111 — its
 * figure is authoritative and we do not want to re-derive what it already computed). But
 * "prefer" cannot mean "render blindly": live 2026-07-22 the Net Margin tile read −29.3%
 * while the Net Profit tile 40px away read −$19.67 on $7,728.48 of revenue, which is −0.29%.
 * The strip contradicted itself and said nothing, because the frontend passed `cur.net_margin`
 * straight through.
 *
 * So the backend figure now has to pass a consistency gate against the same profit and the
 * same ex-GST base the tile beside it uses. When it fails we render the DERIVED figure —
 * internal consistency across the strip beats deference to a number that disagrees with its
 * own inputs — and the caller says so on the card. This does NOT stop reading the backend:
 * an agreeing `margin_proxy` still wins, exactly as before.
 *
 * Tolerance is RELATIVE so it scales with the figure: a 100× scale error trips, a basis error
 * (the ~13% understatement from an incl-GST denominator) trips, ordinary rounding does not.
 * The 0.5pp floor keeps a near-zero margin from tripping on float noise.
 *
 * @returns null when the two agree (or either is unavailable), else the disagreement.
 */
function checkMarginConsistency(label, backendPct, derivedPct) {
  if (backendPct == null || !Number.isFinite(backendPct)) return null;
  if (derivedPct == null || !Number.isFinite(derivedPct)) return null;
  const tolerance = Math.max(0.5, Math.abs(derivedPct) * 0.05);
  const gap = backendPct - derivedPct;
  if (Math.abs(gap) <= tolerance) return null;
  // Ratio is the tell that names the failure mode (~100 = a scale bug) — but it is
  // meaningless when the derived figure is ~0, so it stays null there rather than exploding.
  const ratio = Math.abs(derivedPct) > 0.001 ? backendPct / derivedPct : null;
  return { label, backend: backendPct, derived: derivedPct, gap, tolerance, ratio };
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
  // The backend's figure is preferred — but only once it agrees with the profit tile beside
  // it (see checkMarginConsistency). A backend margin that contradicts its own profit and
  // revenue is not authoritative, it is broken, and rendering it verbatim makes the strip lie.
  const grossMarginBackend = cur.gross_margin  != null ? Number(cur.gross_margin)
                           : cur.margin_proxy  != null ? Number(cur.margin_proxy)
                           : null;
  const grossMarginDerived = marginOf(grossProfit, cur.revenue);
  const grossMarginCheck   = checkMarginConsistency('Gross Margin', grossMarginBackend, grossMarginDerived);
  const grossMarginPct     = grossMarginCheck ? grossMarginDerived
                           : (grossMarginBackend ?? grossMarginDerived);

  const netMarginBackend   = cur.net_margin != null ? Number(cur.net_margin) : null;
  const netMarginDerived   = marginOf(netProfit, cur.revenue);
  const netMarginCheck     = checkMarginConsistency('Net Margin', netMarginBackend, netMarginDerived);
  const netMarginPct       = netMarginCheck ? netMarginDerived
                           : (netMarginBackend ?? netMarginDerived);

  const grossMarginPctPrev = prev.gross_margin != null ? Number(prev.gross_margin)
                           : prev.margin_proxy != null ? Number(prev.margin_proxy)
                           : marginOf(prev.gross_profit, prev.revenue);
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
      gst: GST_INCL,
      tooltip: `Total sales (incl. GST) for the selected range. Includes invoiced (phone / walk-in / B2B) sales, paid or not.` },
    {
      label: 'Gross Profit', value: grossProfit != null ? formatPrice(grossProfit) : null,
      raw: grossProfit, prev: prev.gross_profit, stackNext: true, gst: GST_EXCL,
      tooltip: `Revenue (ex-GST) − cost of goods (ex-GST), computed by the backend.${grossNote}`,
    },
    {
      label: 'Gross Margin', value: fmtPct(grossMarginPct), raw: grossMarginPct, prev: grossMarginPctPrev,
      alert: grossMarginPct != null && grossMarginPct < 0, gst: GST_BASE,
      tooltip: 'Gross profit ÷ revenue, both ex-GST. Profit quality, not size.',
    },
    {
      label: 'Net Profit', value: netProfit != null ? formatPrice(netProfit) : null,
      raw: netProfit, prev: prev.net_profit,
      alert: netProfit != null && netProfit < 0, stackNext: true,
      gst: GST_EXCL,
      // No "after $X supplier freight" line (owner 2026-11-23, ERR-392): freight is one
      // expense among several already inside net profit, and naming only it read as if
      // the others were not. The tooltip still lists every deduction.
      sub: unpaidBillsSub(netProfit, d.unpaidBills),
      // No separate "− GST" term: since migration 118 every figure below revenue is ex-GST,
      // so GST is already outside this calculation rather than a line item inside it.
      // The Stripe-basis divergence is named on BOTH sides of it (ERR-255). An
      // operator comparing this tile against an order modal sees a difference of
      // roughly $0.47 per card order, and it is the backend's ÷1.15 against our
      // 2026-05-17 convention — not an error in either screen. Naming it only in
      // the modal would leave whoever starts from the Dashboard re-deriving it.
      tooltip: `Gross profit − Stripe fees − operating expenses − supplier freight, all ex-GST, computed by the backend. Invoiced sales carry no card fee (bank transfer). KNOWN DIFFERENCE: this figure divides Stripe's 2.65% + $0.30 by 1.15; an order's own modal deducts it as-is, so a modal take-home reads about $0.47 per card order lower. Settled by reading a real Stripe payout, not by changing either screen. Operating expenses count only once marked PAID; the second line takes off bills still owed (overdue + due on the Expenses page, all dates, at the amount you will pay incl. GST — the GST part is reclaimable, so the true figure sits slightly higher).${netNote}`,
    },
    {
      label: 'Net Margin', value: fmtPct(netMarginPct), raw: netMarginPct, prev: netMarginPctPrev,
      alert: netMarginPct != null && netMarginPct < 0, gst: GST_BASE,
      tooltip: 'Net profit ÷ revenue, both ex-GST. What you actually keep.',
    },
    { label: 'Orders', value: cur.orders != null ? String(cur.orders) : null, raw: cur.orders, prev: prev.orders,
      tooltip: `Orders placed in the selected range. Includes invoiced sales, paid or not.` },
    { label: 'Avg Order Value', value: aov != null ? formatPrice(aov) : null, raw: aov, prev: aovPrev,
      gst: GST_INCL,  // inherits revenue's basis
      tooltip: `Revenue ÷ orders, both incl. GST.` },
    { label: 'New Customers', value: newCustomers != null ? String(newCustomers) : null, raw: newCustomers, prev: newCustomersPrev,
      tooltip: 'First-time buyers in the range.' },
    {
      // The backend counts a buyer as returning when they ordered BEFORE the range. All time
      // has no "before", so it answers 0 by construction (measured 2026-10-20: 0 of 205, while
      // ~20 buyers have 2+ orders). Show "—" and say why rather than print that 0 (ERR-366).
      label: 'Returning %',
      value: noDelta ? null : (cc.returning_pct != null ? `${cc.returning_pct}%` : null),
      raw: noDelta ? null : cc.returning_pct, prev: cp.returning_pct,
      tooltip: noDelta
        ? 'Share of buyers who had ordered before the range. All time has no earlier period to return from, so pick a bounded range to see it.'
        : 'Share of buyers who had ordered before the range. Requires GET /api/admin/analytics/customer-stats.',
    },
    {
      // No `gst`: the denominator is incl-GST revenue but no basis is documented
      // anywhere for the refund amounts on top, so the ratio's basis is unknown.
      label: 'Refund Rate', value: refundPct != null ? `${refundPct.toFixed(1)}%` : null,
      // Backend `refund_rate` is a COUNT ratio: measured 2026-10-20 it read 0.4 for 1 refunded
      // order of 226, where value ÷ revenue would be $14 / $34,630 = 0.04% (ERR-366).
      alert: refundPct != null && refundPct > 3, tooltip: 'Refunded orders ÷ orders (a count, not a value). Flagged above 3%.',
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

  // Fail-soft must be LOUD. A margin that disagrees with the profit tile beside it is a
  // data-integrity problem, not a footnote — the last time a backend figure silently
  // contradicted its own inputs it went unnoticed for weeks (ERR-111). Say which number the
  // backend sent, which one we're showing, and why.
  for (const chk of [grossMarginCheck, netMarginCheck]) {
    if (!chk) continue;
    const scale = chk.ratio != null && Math.abs(Math.abs(chk.ratio) - 100) < 10
      ? ' That is almost exactly 100× out, which is a scale bug at the source, not a rounding difference.'
      : '';
    html += `<p class="fh-pnl-note admin-dash-note--alert"><strong>${esc(chk.label)} doesn’t match its own profit figure.</strong>
      The backend reported ${esc(fmtPct(chk.backend))}, but its own ${esc(chk.label === 'Net Margin' ? 'Net Profit' : 'Gross Profit')}
      over ex-GST revenue gives ${esc(fmtPct(chk.derived))}. Showing the derived figure so this strip stays
      internally consistent.${scale}</p>`;
  }
  return html;
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
