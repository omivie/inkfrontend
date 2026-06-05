/**
 * Dashboard — "Everything at a glance" bento layout
 * KPI strip · Revenue vs Expenses · Orders/Products · Alerts · Activity
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import {
  STRIPE_RATE_DERIVE, STRIPE_FIXED_DERIVE, GST_FRACTION_OF_GROSS,
  bucketOperatingExpenses, distributeCogsByRevenue, assembleBucketExpense,
  sumTrendTotals, bucketCogsFromOrders, kpiCogsInclGst, residualCogsAfterExact,
  expandRecurringExpenses, isRevenueOrder, deriveKpisFromOrders,
  cogsIsKnown, refundAmount, forecastDailyAvgFromHistory,
  orderCostInclGst, extrapolateWindowCogsInclGst, reconciledGrossProfitInclGst,
  costCoverage,
} from '../utils/trend-math.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;
const MISSING = '—';

let _container = null;
let _trendData = null;       // bucketed historical series keyed to current filter
let _forecastData = null;    // { historical, projected } for forecast chart
let _trendMetric = 'revenue';
let _kpi = { cur: {}, derived: false };  // resolved KPI "current" block (RPC or order-derived fallback)
// Race-guard for loadDashboard — see the same pattern in pages/website-traffic.js.
// Filter changes call loadDashboard() concurrently; without this, a slow earlier
// load can paint stale data on top of a newer load that already finished.
let _loadSeq = 0;
let _hasRenderedSuccessfully = false; // first-load skeleton vs re-load dim

// ---------- helpers ----------

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

// Resolve the KPI "current" block once per render. When the
// analytics_kpi_summary RPC is healthy we use it verbatim; when it is down
// (recurring ERR-010 — the RPC's GRANT EXECUTE gets dropped by backend
// redeploys) we reconstruct Revenue/Orders/Gross Profit from the raw orders
// REST feed so the dashboard self-heals instead of showing "—" everywhere.
//
// Returns { cur, derived }: `cur` is shaped like the RPC's current block;
// `derived` is true when `cur` came from the order-feed fallback.
function resolveKpiCurrent(d) {
  const rpcCur = d.kpis?.current ?? {};
  let base;
  if (rpcCur.revenue != null) base = { cur: rpcCur, derived: false };
  else {
    const fallback = deriveKpisFromOrders(d.rawOrders);
    base = fallback ? { cur: fallback, derived: true } : { cur: {}, derived: false };
  }
  // Snapshot-cost reconciliation (set by reconcileProfitFromSnapshots once enough
  // orders resolve their real supplier cost): override gross_profit so the whole
  // dashboard derives the true margin from snapshots, not the optimistic RPC.
  if (d._reconciledGrossProfit != null && Number.isFinite(d._reconciledGrossProfit)) {
    base = {
      ...base,
      cur: { ...base.cur, gross_profit: d._reconciledGrossProfit },
      reconciled: true,
      coverage: d._costCoverage ?? null,
    };
  }
  return base;
}

// Keep only orders that produced a cleared charge — see `isRevenueOrder` /
// NON_REVENUE_ORDER_STATUSES in trend-math.js for the rationale.
function revenueGeneratingOrders(rawOrders) {
  return firstArray(rawOrders, ['orders', 'data']).filter(isRevenueOrder);
}

// ---------- per-order supplier-cost enrichment ----------
//
// The bulk /api/admin/orders list omits `supplier_cost_snapshot` (investigated
// 2026-06-05: list line items carry only price/qty; the cost snapshot lives on
// the detail endpoint /api/admin/orders/:id). Without it, the Revenue &
// Expenses chart can't value COGS per order and falls back to smearing the KPI
// window-total COGS by revenue — which under-books cost on days dominated by a
// low-margin genuine SKU (a single $350.90 supplier cost showing as ~$200, so
// the day's expense bar came out *below* that order's own cost).
//
// We back-fill the real cost by fetching each order's detail (the same call the
// Orders page makes) and stamping `cost_total_excl_gst` on the raw order, which
// `orderCostInclGst` then reads. Cost is paid carefully:
//   - sub-month granularity only (hour/day/week): at month resolution many
//     orders blend into a bucket and revenue-share is already a fair shape, and
//     wide windows carry far too many orders to fan out responsibly.
//   - capped fan-out + bounded concurrency so we never hammer the backend.
//   - cached by order id (cost snapshots are immutable once placed), and `null`
//     is cached too so cost-less orders aren't re-fetched every reload.
// Non-blocking: the dashboard paints immediately with the revenue-share
// approximation, then this self-corrects the per-day shape a few seconds later.
const ENRICH_MAX_FETCH   = 200;      // never fan out more live detail calls than this
const ENRICH_CONCURRENCY = 2;        // simultaneous detail requests — a gentle trickle that
                                     // coexists with the backend rate limiter (api.js also
                                     // honours Retry-After on 429 underneath)
const ENRICH_RETRIES     = 3;        // per-order retries on transient failure / 429
const COVERAGE_MIN       = 0.6;      // reconcile the headline only above this resolved-revenue share
const _COST_CACHE_KEY    = 'admin.dash.orderCost.v1';

// Persisted id → ex-GST supplier cost (number) | null. Snapshots are immutable
// once an order is placed, so caching across reloads (sessionStorage) is safe and
// means the expensive detail fan-out runs at most once per order per session.
const _orderCostCache = (() => {
  const m = new Map();
  try {
    const raw = sessionStorage.getItem(_COST_CACHE_KEY);
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) m.set(k, v);
  } catch (_) { /* private mode / quota — fall back to in-memory only */ }
  return m;
})();
function persistCostCache() {
  try {
    sessionStorage.setItem(_COST_CACHE_KEY, JSON.stringify(Object.fromEntries(_orderCostCache)));
  } catch (_) { /* best effort */ }
}

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sum ex-GST supplier cost from a detail-endpoint order's line items.
// Returns null when no item carries a cost snapshot (so we can cache "unknown").
function detailOrderCostExGst(order) {
  const items = (order && (order.items || order.order_items)) || [];
  let exGst = 0, saw = false;
  for (const it of items) {
    if (it == null || it.supplier_cost_snapshot == null) continue;
    const c = Number(it.supplier_cost_snapshot);
    const q = Number(it.quantity ?? it.qty ?? 0);
    if (Number.isFinite(c) && Number.isFinite(q)) { exGst += c * q; saw = true; }
  }
  return saw ? exGst : null;
}

// Fetch one order's detail, retrying on rate-limit/transient failure with
// backoff. Returns the ex-GST cost (number), null when the order genuinely
// carries no snapshot, or `undefined` when every attempt failed (so the caller
// leaves it uncached and retries on a later load rather than poisoning the cache
// with a transient miss). `idx` staggers first attempts to spread the load.
async function fetchOrderCostExGst(id, idx = 0) {
  await _sleep((idx % ENRICH_CONCURRENCY) * 60);   // deterministic stagger, no Math.random
  for (let attempt = 0; attempt < ENRICH_RETRIES; attempt++) {
    try {
      const resp = await window.API.get(`/api/admin/orders/${id}`);
      const order = resp?.data?.order ?? resp?.data ?? null;
      return detailOrderCostExGst(order);          // number | null — a real answer
    } catch (_) {
      if (attempt < ENRICH_RETRIES - 1) await _sleep(400 * Math.pow(3, attempt)); // 400 → 1200 → 3600
    }
  }
  return undefined;                                 // exhausted — transient, don't cache
}

// Run `worker` over `items` with at most `concurrency` in flight at once.
async function runPool(items, concurrency, worker) {
  const queue = items.map((item, i) => ({ item, i }));
  const runners = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) {
        const { item, i } = queue.shift();
        try { await worker(item, i); } catch (_) { /* leave this order on the fallback */ }
      }
    }
  );
  await Promise.all(runners);
}

// Stamp `cost_total_excl_gst` on each in-window revenue order from the detail
// endpoint (the bulk /orders list omits supplier_cost_snapshot). Mutates the
// order objects in place so a later buildTrendSeries / reconcile sees them, and
// returns the count of orders whose cost was newly applied this call — 0 means
// nothing changed, so the caller can skip the re-render.
async function enrichOrdersWithSupplierCost(rawOrders, unit) {
  if (unit === 'month') return 0;      // wide windows carry too many orders to fan out
  const orders = revenueGeneratingOrders(rawOrders);
  if (!orders.length) return 0;

  // Apply cached costs first (free); collect the genuinely-unknown into `need`.
  let applied = 0;
  const need = [];
  for (const o of orders) {
    if (!o || o.id == null || o.cost_total_excl_gst != null) continue; // already costed
    if (_orderCostCache.has(o.id)) {
      const c = _orderCostCache.get(o.id);
      if (c != null) { o.cost_total_excl_gst = c; applied++; }
    } else {
      need.push(o);
    }
  }

  // Guard the live fan-out: a huge window stays on the provisional RPC numbers
  // rather than firing hundreds of detail calls at the backend.
  if (need.length > ENRICH_MAX_FETCH) return applied;

  let touchedCache = false;
  await runPool(need, ENRICH_CONCURRENCY, async (o, i) => {
    const cost = await fetchOrderCostExGst(o.id, i);
    if (cost === undefined) return;              // transient failure — don't cache, retry next load
    _orderCostCache.set(o.id, cost);             // number or null (genuinely cost-less)
    touchedCache = true;
    if (cost != null) { o.cost_total_excl_gst = cost; applied++; }
  });
  if (touchedCache) persistCostCache();
  return applied;
}

// Recompute the window's gross_profit from the real supplier-cost snapshots now
// stamped on the orders, and pin it onto `payload` so resolveKpiCurrent (hence
// Gross Profit, Net Profit, Gross Margin AND the Trends chart) shows the true
// margin instead of the optimistic analytics_kpi_summary figure. Reconciles only
// above COVERAGE_MIN resolved-revenue so a thin sample can't drive a wild
// extrapolation; below it we leave the provisional RPC numbers in place. Sets
// payload._reconciledGrossProfit / _costCoverage (cleared when not confident).
function reconcileProfitFromSnapshots(payload) {
  const orders = revenueGeneratingOrders(payload.rawOrders);
  let resolvedCost = 0, resolvedRev = 0, totalRev = 0;
  for (const o of orders) {
    const total = Number(o?.total || 0);
    totalRev += total;
    const cost = orderCostInclGst(o);            // reads cost_total_excl_gst, grosses up
    if (cost > 0) { resolvedCost += cost; resolvedRev += total; }
  }
  const coverage = costCoverage(resolvedRev, totalRev);
  if (coverage < COVERAGE_MIN || resolvedRev <= 0) {
    payload._reconciledGrossProfit = null;
    payload._reconciledCogsInclGst = null;
    payload._costCoverage = coverage;
    return false;
  }
  const revenueGross = payload.kpis?.current?.revenue ?? totalRev;
  const windowCogs = extrapolateWindowCogsInclGst(resolvedCost, resolvedRev, totalRev);
  // Pin the snapshot COGS directly so buildTrendSeries uses real cash-to-supplier
  // (not a value back-derived from gross_profit), and pin the canonical
  // (ex-GST−based) gross_profit so the KPI card + Gross Margin read true.
  payload._reconciledCogsInclGst = windowCogs;
  payload._reconciledGrossProfit = reconciledGrossProfitInclGst(revenueGross, windowCogs);
  payload._costCoverage = coverage;
  return payload._reconciledGrossProfit != null;
}

// ---------- data loading ----------

// Skeleton matching the dashboard layout — 8 KPI tiles, two-up trend+forecast
// chart cards, then a side panel + lower row of summary cards. Used only on the
// FIRST load while the parallel fetches are in flight (subsequent filter-change
// reloads keep the existing content visible with a dim overlay).
function dashboardSkeleton() {
  const tile = '<div class="admin-skel admin-skel__tile" aria-hidden="true"></div>';
  return `
    <div class="admin-page-header admin-page-header--dash"><h1>Dashboard</h1></div>
    <div class="admin-skeleton" role="status" aria-label="Loading dashboard">
      <span class="admin-sr-only">Loading dashboard…</span>
      <div class="admin-kpi-grid admin-mb-lg" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
        ${tile}${tile}${tile}${tile}${tile}${tile}${tile}${tile}
      </div>
      <div class="admin-dash">
        <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div><div class="admin-skel admin-skel__chart"></div></div>
        <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div><div class="admin-skel admin-skel__chart"></div></div>
        <div class="admin-card admin-dash__side"><div class="admin-skel admin-skel__line admin-skel__line--title"></div>
          <div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div>
        </div>
        <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div></div>
        <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div></div>
        <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div><div class="admin-skel admin-skel__row"></div><div class="admin-skel admin-skel__row"></div></div>
      </div>
    </div>
  `;
}

async function loadDashboard() {
  if (!_container) return;
  const mySeq = ++_loadSeq;

  // First load → matched-layout skeleton. Re-load (filter change) → keep the
  // existing page visible and dim it via `--reloading`. Both paths get the same
  // race guard so a stale fetch can't paint over a newer one.
  if (!_hasRenderedSuccessfully) {
    _container.innerHTML = dashboardSkeleton();
  } else {
    _container.classList.add('admin-page--reloading');
  }

  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();

  if (!isOwner) {
    if (mySeq !== _loadSeq || !_container) return;
    _container.classList.remove('admin-page--reloading');
    render({ isOwner: false });
    return;
  }

  // Build an unfiltered date window for refund "this month vs last month" comparison.
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const nowStr = now.toISOString().slice(0, 10);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  const promises = [
    AdminAPI.getDashboardKPIs(params, signal),              // 0 kpis
    AdminAPI.getRevenueSeries(params, signal),              // 1 revenue series
    AdminAPI.getCustomerStats(params, signal),              // 2 customer stats
    AdminAPI.getTopProducts(params, signal),                // 3 top products
    AdminAPI.getRefundAnalytics(params, signal),            // 4 refunds
    AdminAPI.getOrders({
      from: params.get('from'), to: params.get('to'),
    }, 1, 8, signal),                                       // 5 recent orders
    AdminAPI.getOrders({
      from: params.get('from'), to: params.get('to'),
    }, 1, 500, signal),                                     // 6 raw orders for spark
    AdminAPI.getOutOfStock({ limit: 5 }),                   // 7 out of stock
    AdminAPI.getAdminAnalyticsCashflow(12),                 // 8 cashflow
    AdminAPI.getAdminAnalyticsBurnRunway(),                 // 9 runway
    AdminAPI.getAdminAnalyticsForecasts(),                  // 10 forecasts
    AdminAPI.getPaymentBreakdown(thisMonthStart, nowStr),   // 11 payment breakdown
    AdminAPI.getOverpricedProducts(1, 5),                   // 12 overpriced
    AdminAPI.getMarketDiscrepancies(15),                    // 13 discrepancies
    AdminAPI.getAuditLogs({ limit: 15 }),                   // 14 audit logs
    AdminAPI.getAdminAnalyticsPnL(372),                     // 15 p&l (12 months)
    AdminAPI.getAdminAnalyticsForecastHistory(
      Math.min(365, Math.max(90, FilterState.periodToDays())),
      30
    ),                                                      // 16 forecast history
    AdminAPI.getAdminAnalyticsExpenses(500),                // 17 logged expenses
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  // Race guard — bail if a newer loadDashboard() has been kicked off (or if the
  // page was destroyed). Without this, a slow earlier load races a newer one
  // and paints stale data on top.
  if (mySeq !== _loadSeq || !_container) return;
  _container.classList.remove('admin-page--reloading');

  const payload = {
    isOwner: true,
    kpis:         val(0),
    revSeries:    val(1),
    custStats:    val(2),
    topProducts:  val(3),
    refunds:      val(4),
    recentOrders: val(5),
    rawOrders:    val(6),
    outOfStock:   val(7),
    cashflow:     val(8),
    pnl:          val(15),
    runway:       val(9),
    forecasts:    val(10),
    paymentMix:   val(11),
    overpriced:   val(12),
    discrepancies: val(13),
    auditLogs:    val(14),
    forecastHistory: val(16),
    expenses:     val(17),
  };
  // Apply any session-cached supplier costs synchronously and reconcile the
  // headline profit BEFORE the first paint — on a warm cache the dashboard shows
  // the true (snapshot-based) margin immediately, no flash.
  const enrichUnit = getBucketConfig().unit;
  reconcileProfitFromSnapshots(payload);
  render(payload);
  _hasRenderedSuccessfully = true;

  // Background: back-fill real per-order supplier cost from the detail endpoint
  // (the bulk /orders list omits it), then re-reconcile and re-render so every
  // profit surface — Gross/Net Profit, Gross Margin, Trends — reflects the true
  // margin instead of the optimistic analytics_kpi_summary figure. Non-blocking,
  // rate-limit-hardened, session-cached. Guarded by the load-sequence token.
  enrichOrdersWithSupplierCost(payload.rawOrders, enrichUnit).then((applied) => {
    if (applied <= 0 || mySeq !== _loadSeq || !_container) return;
    reconcileProfitFromSnapshots(payload);
    render(payload);
  }).catch(() => { /* enrichment is best-effort; keep the painted dashboard */ });
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

  // Resolve the KPI block before anything reads it — buildTrendSeries,
  // renderKpiStrip and renderSidePanel all depend on it, and all must agree
  // on whether we're showing RPC numbers or the order-derived fallback.
  _kpi          = resolveKpiCurrent(d);
  _trendData    = buildTrendSeries(d);
  _forecastData = buildForecastSeries(d);

  const html = `
    <div class="admin-page-header admin-page-header--dash"><h1>Dashboard</h1></div>
    ${renderKpiStrip(d)}
    <div class="admin-dash">
      ${renderTrendCard()}
      ${renderForecastCard(d)}
      ${renderSidePanel(d)}
      ${renderRecentOrdersCard(d.recentOrders)}
      ${renderTopProductsCard(d.topProducts)}
      ${renderLowStockCard(d.outOfStock)}
      ${renderRefundsCard(d.refunds, d.kpis)}
      ${renderPaymentMixCard(d.paymentMix)}
      ${renderMarketIntelCard(d.overpriced, d.discrepancies)}
      ${renderActivityCard(d.auditLogs)}
    </div>
  `;

  _container.innerHTML = html;

  // Charts (after DOM insert)
  drawTrendChart();
  drawForecastChart();
  drawSparklines(d);
  drawRefundReasons(d.refunds);
  drawPaymentMixDonut(d.paymentMix);

  // Wire interactions
  wirePills();
  wireOrderRowClicks();
}

// ---------- KPI strip ----------

// Render one KPI card. `extraClass` lets callers tag a card (e.g. the
// half-height cards in the Gross/Net stack) without duplicating the markup.
function renderKpiTile(t, extraClass = '') {
  const alertCls = t.alert ? ' admin-kpi--alert' : '';
  let h = `<div class="admin-kpi admin-kpi--compact${alertCls}${extraClass}">`;
  h += `<div class="admin-kpi__label">${esc(t.label)}</div>`;
  if (t.value != null) {
    h += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
    h += deltaBadge(t.raw, t.prev);
  } else {
    h += missingValue(t.tooltip || 'Data unavailable');
  }
  if (t.sparkId) {
    h += `<div class="admin-kpi__spark"><canvas id="${t.sparkId}"></canvas></div>`;
  }
  h += '</div>';
  return h;
}

function renderKpiStrip(d) {
  const cur  = _kpi.cur;
  const prev = d.kpis?.previous ?? {};   // RPC-only; absent on the fallback path (no deltas)
  const cc   = d.custStats?.current  ?? {};
  const cp   = d.custStats?.previous ?? {};

  // Derived metrics
  const aov     = safeDiv(cur.revenue, cur.orders);
  const aovPrev = safeDiv(prev.revenue, prev.orders);

  const refundTotal = sumRefundAmounts(d.refunds);
  const refundRate  = safeDiv(refundTotal, cur.revenue);
  const refundPct   = refundRate != null ? (refundRate * 100) : null;

  const oosCount = outOfStockCount(d.outOfStock);

  const newCustomers     = cc.new_customers ?? cc.new ?? cc.newCustomers ?? null;
  const newCustomersPrev = cp.new_customers ?? cp.new ?? cp.newCustomers ?? null;

  // Net Profit — sourced from the SAME bucketed totals that feed the Trends
  // "Profit" pill (renderTrendTotals: net = revenue − expenses), so the headline
  // KPI and the Trends figure can never drift apart. Gross Profit (above) is
  // pre-fee margin; this is net of Stripe + GST + opex. Only meaningful when
  // COGS is genuinely known — when it isn't (analytics RPC down, no per-item
  // cost) the net would silently omit product cost and overstate profit, so we
  // show "—" exactly as the Gross Profit card does on the same data.
  const _tt          = sumTrendTotals(Array.isArray(_trendData) ? _trendData : []);
  const netCogsKnown = _tt.cogsKnown !== false;
  const hasTrend     = Array.isArray(_trendData) && _trendData.length > 0;
  const netProfit    = (hasTrend && netCogsKnown) ? (_tt.revenue - _tt.expenses) : null;

  const tiles = [
    {
      label: 'Revenue',
      value: cur.revenue != null ? formatPrice(cur.revenue) : null,
      raw: cur.revenue, prev: prev.revenue,
      sparkId: 'spark-rev',
    },
    {
      label: 'Gross Profit',
      value: cur.gross_profit != null ? formatPrice(cur.gross_profit) : null,
      raw: cur.gross_profit, prev: prev.gross_profit,
      tooltip: 'Revenue (ex-GST) − COGS. Product margin before payment fees.',
    },
    {
      label: 'Net Profit',
      value: netProfit != null ? formatPrice(netProfit) : null,
      raw: null, prev: null,                       // no period-over-period delta computed
      alert: netProfit != null && netProfit < 0,   // red accent on a loss
      tooltip: netCogsKnown
        ? 'Revenue − COGS − Stripe fees − GST − Opex. Matches the Trends “Profit” figure.'
        : 'Needs product cost (COGS) — unavailable while the analytics service is down',
    },
    {
      label: 'Orders',
      value: cur.orders != null ? String(cur.orders) : null,
      raw: cur.orders, prev: prev.orders,
      sparkId: 'spark-ord',
    },
    {
      label: 'Avg Order Value',
      value: aov != null ? formatPrice(aov) : null,
      raw: aov, prev: aovPrev,
    },
    {
      label: 'New Customers',
      value: newCustomers != null ? String(newCustomers) : null,
      raw: newCustomers, prev: newCustomersPrev,
    },
    {
      label: 'Returning %',
      value: cc.returning_pct != null ? `${cc.returning_pct}%` : null,
      raw: cc.returning_pct, prev: cp.returning_pct,
      tooltip: 'Requires analytics_customer_stats RPC',
    },
    {
      label: 'Refund Rate',
      value: refundPct != null ? `${refundPct.toFixed(1)}%` : null,
      alert: refundPct != null && refundPct > 3,
      sparkId: 'spark-ref',
    },
    {
      label: 'Out of Stock',
      value: oosCount != null ? String(oosCount) : null,
      alert: oosCount > 0,
      tooltip: 'Products currently flagged out of stock',
    },
  ];

  // Gross Profit + Net Profit share a single grid cell, stacked vertically at
  // half height each. This keeps the strip at 8 cells (2 rows of 4) instead of
  // spilling Out of Stock onto a lonely third row.
  let html = '<div class="admin-kpi-grid admin-kpi-grid--8">';
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const next = tiles[i + 1];
    if (t.label === 'Gross Profit' && next && next.label === 'Net Profit') {
      html += '<div class="admin-kpi-stack">'
            + renderKpiTile(t, ' admin-kpi--half')
            + renderKpiTile(next, ' admin-kpi--half')
            + '</div>';
      i += 1; // Net Profit already emitted as the second half
      continue;
    }
    html += renderKpiTile(t);
  }
  html += '</div>';

  // When the KPI strip is running on the order-derived fallback, say so
  // plainly — the numbers are real but reconstructed. WHICH numbers got
  // reconstructed depends on the order feed: Revenue/Orders/Avg Order Value
  // always rebuild, but Gross Profit + Gross Margin only when every counted
  // order carried supplier cost (deriveKpisFromOrders returns
  // gross_profit:null otherwise). The banner must promise EXACTLY what
  // rendered — never claim "Gross Margin" on a strip that shows it as "—".
  if (_kpi.derived) {
    const profitReconstructed = cur.gross_profit != null;
    const reconstructedList = profitReconstructed
      ? '<strong>Revenue</strong>, <strong>Orders</strong>, <strong>Avg Order Value</strong>, <strong>Gross Profit</strong>, <strong>Net Profit</strong> and <strong>Gross Margin</strong>'
      : '<strong>Revenue</strong>, <strong>Orders</strong> and <strong>Avg Order Value</strong>';
    const unavailableList = profitReconstructed
      ? '<strong>New Customers</strong>, <strong>Returning %</strong> and <strong>Refund Rate</strong>'
      : '<strong>Gross Profit</strong>, <strong>Net Profit</strong>, <strong>Gross Margin</strong>, <strong>New Customers</strong>, <strong>Returning %</strong> and <strong>Refund Rate</strong>';
    html += `
      <div class="admin-kpi-fallback" role="status">
        <span class="admin-kpi-fallback__icon" aria-hidden="true">⚠</span>
        <span>Live analytics service is unavailable — ${reconstructedList}
        below are reconstructed from order records. ${unavailableList} need the
        analytics service and return automatically once it is restored.</span>
      </div>`;
  }
  return html;
}

function sumRefundAmounts(refunds) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  if (!series.length) return null;
  return series.reduce((sum, r) => sum + refundAmount(r), 0);
}

function outOfStockCount(data) {
  if (data == null) return null;
  if (typeof data.total === 'number') return data.total;
  const items = firstArray(data, ['items', 'products', 'data']);
  return items.length;
}

// ---------- Row 2: Trend chart + Forecast chart ----------

function rangeLabel() {
  const period = FilterState.get('period');
  const map = { '24h':'last 24h', '72h':'last 72h', '7d':'last 7 days', '1m':'last 30 days',
                '3m':'last 3 months', '6m':'last 6 months', '1y':'last 12 months',
                'all':'all time', 'custom':'custom range' };
  return map[period] || 'selected range';
}

function renderTrendCard() {
  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Trends <small>${esc(rangeLabel())}</small></span>
        <div class="admin-pills" id="dash-trend-pills">
          <button type="button" class="admin-pill active" data-metric="revenue">Revenue &amp; Expenses</button>
          <button type="button" class="admin-pill" data-metric="profit">Net Profit</button>
          <button type="button" class="admin-pill" data-metric="orders">Orders</button>
        </div>
      </div>
      <div class="admin-chart-box admin-chart-box--mid"><canvas id="chart-trend"></canvas></div>
      <div id="dash-trend-totals" class="admin-trend-totals" aria-live="polite"></div>
    </div>
  `;
}

function renderForecastCard(d) {
  // Prefer the resolved projection from buildForecastSeries (which falls back to
  // a local trailing average when the backend forecast is empty) so the headline
  // matches the chart instead of showing "—" while the chart projects forward.
  const forecastRevenue = _forecastData?.projected30 ?? pickForecast(d.forecasts, 30);
  const usingLocal      = _forecastData?.usingLocal === true;
  const forecastConf    = d.forecasts?.confidence ?? null;
  const confStr = usingLocal
    ? 'Trend estimate'
    : (typeof forecastConf === 'number'
      ? `${forecastConf}% confidence`
      : (typeof forecastConf === 'string' && forecastConf
          ? `${forecastConf.charAt(0).toUpperCase()}${forecastConf.slice(1)} confidence`
          : 'Projected'));
  const summary = forecastRevenue != null ? formatPrice(forecastRevenue) : MISSING;

  // Projected net profit = forecast revenue × the window's net-profit margin.
  // netMargin is null when COGS is unknown (see buildForecastSeries) — rather
  // than print a profit built on an incomplete margin, we say why it's absent.
  const netMargin = _forecastData?.netMargin ?? null;
  const cogsKnown = _forecastData?.cogsKnown !== false;
  const forecastProfit = (forecastRevenue != null && netMargin != null)
    ? forecastRevenue * netMargin
    : null;
  const profitStr = forecastProfit != null
    ? `${forecastProfit >= 0 ? '+' : '−'}${formatPrice(Math.abs(forecastProfit))} profit`
    : (cogsKnown ? '' : 'profit pending cost data');

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>30-day Forecast <small>${esc(rangeLabel())} + projection</small></span>
        <div class="admin-forecast-summary">
          <span class="admin-forecast-summary__value">${esc(summary)} <small class="admin-forecast-summary__rev-tag">revenue</small></span>
          <span class="admin-forecast-summary__sub">${esc([profitStr, confStr].filter(Boolean).join(' · '))}</span>
        </div>
      </div>
      <div class="admin-chart-box admin-chart-box--mid"><canvas id="chart-forecast"></canvas></div>
    </div>
  `;
}

function pickForecast(forecasts, days) {
  if (!forecasts) return null;
  const fc = forecasts.forecasts || forecasts;
  const keys = {
    30: ['next_30_days', 'revenue_30d', 'forecast_revenue', 'forecast30', 'days30', 'd30', '30_days'],
    60: ['next_60_days', 'revenue_60d', 'forecast60', 'days60', 'd60', '60_days'],
    90: ['next_90_days', 'revenue_90d', 'forecast90', 'days90', 'd90', '90_days'],
  }[days] || [];
  for (const k of keys) {
    const v = fc[k];
    if (v != null) return typeof v === 'object' ? (v.revenue ?? v.value ?? null) : Number(v);
  }
  return null;
}

function renderSidePanel(d) {
  const runwayMonths = d.runway?.runway_months ?? d.runway?.months ?? d.runway?.runway ?? null;
  // /burn-runway ships `cash_balance` (verified live 2026-06-04); keep the
  // legacy aliases so an older shape still resolves.
  const cashOnHand   = d.runway?.cash_balance ?? d.runway?.cash_on_hand ?? d.runway?.cash ?? null;
  const burnRate     = d.runway?.burn_rate ?? d.runway?.monthly_burn ?? null;

  const cur = _kpi.cur;   // RPC current block, or order-derived fallback
  const grossMarginPct = cur.revenue && cur.gross_profit != null
    ? (cur.gross_profit / cur.revenue) * 100
    : null;
  const prevMarginPct = (d.kpis?.previous?.revenue && d.kpis?.previous?.gross_profit != null)
    ? (d.kpis.previous.gross_profit / d.kpis.previous.revenue) * 100
    : null;

  return `
    <div class="admin-dash__cell--12 admin-mini-row">
      <div class="admin-mini-card">
        <div class="admin-mini-card__label">Cash Runway</div>
        <div class="admin-mini-card__value">${runwayMonths != null ? `${Number(runwayMonths).toFixed(1)} mo` : MISSING}</div>
        <div class="admin-mini-card__sub">
          ${cashOnHand != null ? `${formatPrice(cashOnHand)} on hand` : ''}
          ${burnRate != null ? ` · ${formatPrice(burnRate)}/mo burn` : ''}
        </div>
      </div>
      <div class="admin-mini-card">
        <div class="admin-mini-card__label">Gross Margin</div>
        <div class="admin-mini-card__value">${grossMarginPct != null ? `${grossMarginPct.toFixed(1)}%` : MISSING}</div>
        <div class="admin-mini-card__sub">${deltaBadge(grossMarginPct, prevMarginPct) || 'vs previous period'}</div>
      </div>
    </div>
  `;
}

// ---------- Filter-aware bucketing ----------

// Pick bucket granularity from filter range. Returns { unit, n, startMs, stepMs, label }.
function getBucketConfig() {
  const days = FilterState.periodToDays();
  const now = new Date();
  const endMs = now.getTime();

  if (days <= 2) {
    const n = Math.max(12, days * 12); // 2-hour buckets for 24h/72h
    const stepMs = 2 * 3600 * 1000;
    return { unit: 'hour', n, endMs, stepMs, labelFor: (d) => d.toLocaleTimeString('en-NZ', { hour: 'numeric' }) };
  }
  if (days <= 100) {
    // Daily buckets up to ~3 months so each calendar day is its own bar. The 3m
    // window (90 days) lands here — previously it fell to weekly buckets, which
    // lumped e.g. all of the week of 31 May into a single "31 May" column.
    const stepMs = 24 * 3600 * 1000;
    return { unit: 'day', n: days, endMs, stepMs, labelFor: (d) => d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) };
  }
  if (days <= 200) {
    const stepMs = 7 * 24 * 3600 * 1000;
    return { unit: 'week', n: Math.ceil(days / 7), endMs, stepMs, labelFor: (d) => d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }) };
  }
  const n = Math.min(24, Math.ceil(days / 30));
  return { unit: 'month', n, endMs, stepMs: null, labelFor: (d) => d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }) };
}

// Returns epoch ms for the start of the bucket containing `ms`.
function bucketStart(ms, unit) {
  const d = new Date(ms);
  if (unit === 'hour') {
    d.setMinutes(0, 0, 0);
    // snap to 2-hour boundary
    d.setHours(d.getHours() - (d.getHours() % 2));
    return d.getTime();
  }
  if (unit === 'day') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (unit === 'week') {
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // snap to Sunday
    return d.getTime();
  }
  // month
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Build N empty buckets ending at now.
function seedBuckets(cfg) {
  const buckets = [];
  const end = new Date(cfg.endMs);
  for (let i = cfg.n - 1; i >= 0; i--) {
    let when;
    if (cfg.unit === 'month') {
      when = new Date(end.getFullYear(), end.getMonth() - i, 1);
    } else {
      when = new Date(cfg.endMs - i * cfg.stepMs);
    }
    const startMs = bucketStart(when.getTime(), cfg.unit);
    buckets.push({
      startMs,
      label: cfg.labelFor(new Date(startMs)),
      revenue: 0, expenses: 0, net: 0, orders: 0,
      hasRevenue: false, hasExpense: false, hasNet: false,
      // Per-period P&L lines if the backend ships them — kept for forward compat
      pnlCogs: 0, pnlOpex: 0, pnlStripe: 0, pnlGst: 0,
      hasPnlCogs: false, hasPnlOpex: false, hasPnlStripe: false, hasPnlGst: false,
      // Frontend-derived components (used when P&L is empty)
      cogsDerived: 0,                                  // revenue-share fallback
      cogsFromOrders: 0, hasOrderCogs: false,          // exact, from items[]
      opexLogged: 0, hasOpexLogged: false,
      // Final assembled components for tooltip + totals strip
      cogsTotal: 0, opexTotal: 0, stripeTotal: 0, gstTotal: 0,
    });
  }
  return buckets;
}


// Build trend series (revenue/expenses/net/orders) bucketed by filter granularity.
function buildTrendSeries(d) {
  const cfg = getBucketConfig();
  const buckets = seedBuckets(cfg);
  if (!buckets.length) return [];
  const firstStart = buckets[0].startMs;
  const indexFor = (ms) => {
    const bs = bucketStart(ms, cfg.unit);
    if (bs < firstStart) return -1;
    // Linear scan is fine — N is small (≤ 48).
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].startMs === bs) return i;
    }
    return -1;
  };

  // Revenue source depends on granularity.
  //
  // At DAY/HOUR resolution we derive revenue straight from each order's
  // created_at + total — the SAME basis the Orders list uses — so a bar lands on
  // the exact calendar day the order shows in the list. The backend's
  // pre-aggregated `revSeries` keys revenue by a date-only string bucketed in a
  // different timezone (UTC), which at daily resolution shifts an order's revenue
  // onto the adjacent local day (orders dated 2 Jun showing up under 1 Jun). The
  // per-order created_at carries a full timestamp, so `bucketStart` snaps it to
  // the same local day the Orders list renders — keeping the chart, the order
  // count, and the list all in agreement.
  //
  // At WEEK/MONTH resolution we keep `revSeries`: a one-day boundary shift is
  // invisible once orders are grouped by week/month, and wide windows can exceed
  // the raw-orders page cap (500) that would otherwise undercount revenue.
  const useOrderRevenue = cfg.unit === 'day' || cfg.unit === 'hour';

  // 1. Daily revenue series — week/month granularity only (see note above).
  if (!useOrderRevenue) {
    const revSeries = firstArray(d.revSeries?.series, []);
    for (const r of revSeries) {
      const ts = Date.parse(r.date);
      if (isNaN(ts)) continue;
      const i = indexFor(ts);
      if (i < 0) continue;
      buckets[i].revenue += Number(r.revenue || 0);
      buckets[i].hasRevenue = true;
    }
  }

  // 2. Raw orders — count per bucket, and source bucket revenue from each
  // order's total when running order-derived (day/hour) or as a fallback for any
  // bucket revSeries left empty. Only revenue-generating statuses count, so the
  // order tally + Stripe fixed-fee match the KPI summary (which counts sales,
  // not pending/cancelled rows).
  const rawOrders = revenueGeneratingOrders(d.rawOrders);
  for (const o of rawOrders) {
    const ts = Date.parse(o.created_at || o.createdAt || '');
    if (isNaN(ts)) continue;
    const i = indexFor(ts);
    if (i < 0) continue;
    buckets[i].orders += 1;
    if (useOrderRevenue || !buckets[i].hasRevenue) {
      buckets[i].revenue += Number(o.total || 0);
      buckets[i].hasRevenue = true;
    }
  }

  // 3. P&L lines (forward-compat) — if the backend ever populates per-period
  // cogs/opex/stripe/gst on /api/admin/analytics/pnl, pick them up. Today most
  // periods come back null, which is why steps 4 + 5 reconstruct the totals
  // from sources that DO work.
  //
  // GRANULARITY RULE (set 2026-05-10): P&L periods are MONTHS. Smearing a
  // monthly aggregate across day/week buckets paints fake expenses on empty
  // days (the "$29.80 ghost" — see readfirst/recurring-expenses-may2026.md).
  // At sub-month granularity we let the actual sources of truth speak: per-
  // order COGS (step 4) and dated logged expenses incl. recurring (step 5).
  // P&L pre-fill only runs at month-or-wider granularity where each row maps
  // to exactly one bucket and no smearing is needed.
  const pnlPeriods = Array.isArray(d.pnl?.periods) ? d.pnl.periods
                   : Array.isArray(d.pnl) ? d.pnl : [];
  if (cfg.unit === 'month') {
    for (const p of pnlPeriods) {
      const raw = p.period || p.month || p.date;
      if (!raw) continue;
      const m = String(raw).match(/^(\d{4})-(\d{2})/);
      let monthStart, monthEnd;
      if (m) {
        monthStart = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
        monthEnd   = new Date(Number(m[1]), Number(m[2]), 1).getTime();
      } else {
        const pd = new Date(raw);
        if (isNaN(pd)) continue;
        monthStart = new Date(pd.getFullYear(), pd.getMonth(), 1).getTime();
        monthEnd   = new Date(pd.getFullYear(), pd.getMonth() + 1, 1).getTime();
      }
      const cogs   = p.cogs != null ? Number(p.cogs) : null;
      const opex   = p.operating_expenses != null ? Number(p.operating_expenses) : null;
      const stripe = p.stripe_fees != null ? Number(p.stripe_fees) : null;
      const gst    = (p.gst ?? p.gst_remitted ?? p.gst_payable ?? p.tax);
      const gstNum = gst != null ? Number(gst) : null;
      const net    = p.net_profit != null ? Number(p.net_profit) : null;

      // At month granularity each bucket spans one calendar month, so the
      // overlap loop simplifies to "find the matching bucket and assign".
      // Kept as a loop for resilience to off-by-one edge cases (DST etc.).
      const overlaps = [];
      for (const b of buckets) {
        const bStart = b.startMs;
        const bEnd = new Date(new Date(bStart).getFullYear(), new Date(bStart).getMonth() + 1, 1).getTime();
        const ov = Math.max(0, Math.min(bEnd, monthEnd) - Math.max(bStart, monthStart));
        if (ov > 0) overlaps.push({ b, ov });
      }
      const totalOv = overlaps.reduce((s, o) => s + o.ov, 0);
      if (!totalOv) continue;

      for (const { b, ov } of overlaps) {
        const w = ov / totalOv;
        if (cogs   != null && cogs   > 0) { b.pnlCogs   += cogs   * w; b.hasPnlCogs   = true; }
        if (opex   != null && opex   > 0) { b.pnlOpex   += opex   * w; b.hasPnlOpex   = true; }
        if (stripe != null && stripe > 0) { b.pnlStripe += stripe * w; b.hasPnlStripe = true; }
        if (gstNum != null && gstNum > 0) { b.pnlGst    += gstNum * w; b.hasPnlGst    = true; }
        if (net != null) { b.net += net * w; b.hasNet = true; }
      }
    }
  }

  // 4. COGS — three-tier preference. Use the most accurate source available
  // and fall back gracefully:
  //
  //   (a) Per-order line items (`o.items[].supplier_cost_snapshot * qty * 1.15`)
  //       when the bulk-orders endpoint includes them. Exact match to the
  //       order detail page; no smearing across days.
  //   (b) For orders the backend list endpoint left without items, distribute
  //       a residual COGS amount over the remaining revenue. Residual =
  //       (kpiCogsInclGst total) − (sum of resolved per-order COGS), so the
  //       window total still matches the KPI even when only some orders
  //       resolved exactly.
  //   (c) If neither is available, fall back to pure revenue-share
  //       distribution of the full grossed-up KPI cost.
  //
  // COGS window total, incl-GST cash to suppliers:
  //   1. Reconciled snapshot total (`d._reconciledCogsInclGst`) — the real
  //      supplier_cost_snapshot sum, set by reconcileProfitFromSnapshots once
  //      enough orders resolve. This is authoritative; the KPI gross_profit (now
  //      overridden to the canonical ex-GST basis) can no longer be inverted to
  //      recover an incl-GST cost, so we must NOT fall back to kpiCogsInclGst here.
  //   2. Provisional fallback (no snapshots): recover an approximate incl-GST cost
  //      from the BACKEND gross_profit via kpiCogsInclGst, distributed by revenue.
  const kpiCur = _kpi.cur;
  const totalCogsInclGst = (d._reconciledCogsInclGst != null && Number.isFinite(d._reconciledCogsInclGst))
    ? d._reconciledCogsInclGst
    : kpiCogsInclGst(kpiCur.revenue, kpiCur.gross_profit);
  const hasAnyPnlCogs = buckets.some(b => b.hasPnlCogs);
  if (!hasAnyPnlCogs) {
    // (a) try per-order — only counts toward the bucket if a supplier cost is
    // present (line-item `supplier_cost_snapshot` or an order-level
    // `cost_total_excl_gst`, which enrichOrdersWithSupplierCost back-fills from
    // the detail endpoint since the bulk /orders list omits it).
    const { resolvedCost } = bucketCogsFromOrders(buckets, rawOrders, indexFor);
    if (totalCogsInclGst > 0) {
      // (b) residual = KPI window-total COGS minus what per-order line items
      // already accounted for exactly. Distributing THIS (not a revenue-
      // proportional slice) keeps the window total pinned to the KPI figure, so
      // resolving a low-margin order's exact cost reshapes the per-day bars
      // without drifting the totals strip or the Net-Profit KPI.
      const residualCogs = residualCogsAfterExact(totalCogsInclGst, resolvedCost);
      if (residualCogs > 0) {
        // Distribute the residual only across buckets whose orders weren't
        // resolved exactly — using each bucket's UN-resolved revenue.
        const phantomBuckets = buckets.map(b => ({
          revenue: b.hasOrderCogs ? 0 : (b.revenue || 0),
        }));
        distributeCogsByRevenue(phantomBuckets, residualCogs);
        for (let i = 0; i < buckets.length; i++) {
          buckets[i].cogsDerived = phantomBuckets[i].cogsDerived || 0;
        }
      }
    }
  }

  // 5. Operating expenses — drop in every manually-logged expense at the
  // exact day it happened. This is where the user's 3 May supplier purchase
  // shows up, IF they logged it via Finance → Add Expense.
  //
  // Recurring rows (Vercel/Render/etc., schema in trend-math.js) are expanded
  // into one virtual occurrence per fire-date inside the visible window so a
  // monthly $30 sub bills on the 12th every month, not smeared, not pinned to
  // the 1st. Expansion is bounded by the bucket window so we never emit
  // off-screen ghost rows.
  const expenseRows = Array.isArray(d.expenses)
    ? d.expenses
    : (d.expenses?.expenses || d.expenses?.items || d.expenses?.data || []);
  const lastBucket = buckets[buckets.length - 1];
  const windowEndMs = cfg.unit === 'month'
    ? new Date(new Date(lastBucket.startMs).getFullYear(), new Date(lastBucket.startMs).getMonth() + 1, 1).getTime()
    : lastBucket.startMs + cfg.stepMs;
  const expandedRows = expandRecurringExpenses(expenseRows, firstStart, windowEndMs);
  bucketOperatingExpenses(buckets, expandedRows, indexFor);

  // 6. Tag every bucket with whether COGS is genuinely KNOWN for this window.
  // When it isn't (analytics RPC down AND the bulk-orders feed carried no
  // per-item supplier cost) `cogsTotal` sits at 0 only as a placeholder —
  // renderTrendTotals must surface that honestly instead of folding the
  // missing cost into a confident green "Profit" figure. The flag is
  // window-wide: every bucket carries the same value so sumTrendTotals can
  // read it off any of them.
  const windowRevenue = buckets.reduce((s, b) => s + (b.revenue || 0), 0);
  const windowCogsKnown = cogsIsKnown({
    windowRevenue,
    hasPnlCogs: hasAnyPnlCogs,
    hasOrderCogs: buckets.some(b => b.hasOrderCogs),
    kpiCogsTotal: totalCogsInclGst,
  });

  // 7. Assemble each bucket's final expense components. Order of preference:
  //    cogs   → P&L per-period if populated, else revenue-distributed KPI cogs
  //    opex   → P&L per-period if populated, else logged expenses (date-bucketed)
  //    stripe → P&L per-period if populated, else derive from revenue + orders
  //    gst    → P&L per-period if populated, else derive from gross revenue
  for (const b of buckets) {
    b.cogsKnown = windowCogsKnown;
    assembleBucketExpense(b);
  }

  return buckets;
}

function renderTrendTotals(series) {
  const el = document.getElementById('dash-trend-totals');
  if (!el) return;
  if (!series.length) { el.innerHTML = ''; return; }

  const totals = sumTrendTotals(series);
  const cogsKnown = totals.cogsKnown !== false;
  const net = totals.revenue - totals.expenses;
  const isLoss = net < 0;
  const hasNoOpex = totals.opex === 0;

  const revenueChip = `
    <span class="admin-trend-totals__chip admin-trend-totals__chip--revenue">
      Revenue <strong>${esc(formatPrice(totals.revenue))}</strong>
    </span>`;

  // COGS unknown — the analytics RPC is down and the order feed carried no
  // per-item supplier cost, so `totals.cogs` is a 0 placeholder, not a real
  // zero. `net` here omits product cost entirely and overstates true profit,
  // so it is shown as a NEUTRAL "Net excl. COGS" figure — never a green
  // "Profit" chip — the COGS breakdown reads "—", and a warning explains why.
  // This mirrors the KPI strip, which refuses a Gross Profit card on the same
  // data rather than guessing.
  if (!cogsKnown) {
    const knownExpensePct = totals.revenue > 0
      ? Math.min(100, (totals.expenses / totals.revenue) * 100)
      : 0;
    const unknownPct = Math.max(0, 100 - knownExpensePct);
    const netSign = net < 0 ? '−' : '+';
    const breakdown = `COGS — · Opex ${formatPrice(totals.opex)} · Stripe ${formatPrice(totals.stripe)} · GST ${formatPrice(totals.gst)}`;
    el.innerHTML = `
      <div class="admin-trend-totals__row">
        ${revenueChip}
        <span class="admin-trend-totals__chip admin-trend-totals__chip--expense" title="${esc(breakdown)}">
          Known expenses <strong>${esc(formatPrice(totals.expenses))}</strong>
        </span>
        <span class="admin-trend-totals__chip admin-trend-totals__chip--unknown" title="Excludes product cost (COGS) — see note below">
          Net excl. COGS <strong>${netSign}${esc(formatPrice(Math.abs(net)))}</strong>
        </span>
      </div>
      <div class="admin-trend-totals__bar" role="img" aria-label="Revenue split into known expenses and an unknown-COGS remainder for ${esc(rangeLabel())}">
        <div class="admin-trend-totals__seg admin-trend-totals__seg--expense" style="width:${knownExpensePct.toFixed(2)}%"></div>
        <div class="admin-trend-totals__seg admin-trend-totals__seg--unknown" style="width:${unknownPct.toFixed(2)}%"></div>
      </div>
      <div class="admin-trend-totals__breakdown">${esc(breakdown)}</div>
      <div class="admin-trend-totals__hint admin-trend-totals__hint--warn">
        <span aria-hidden="true">⚠</span>
        Product cost (COGS) can't be reconstructed for this window — the live
        analytics service is unavailable and the order feed carries no supplier
        costs. <strong>Net excl. COGS</strong> counts only Stripe, GST and
        logged operating expenses, so it overstates true profit. The real
        profit figure returns automatically once the analytics service is
        restored.
      </div>
    `;
    return;
  }

  // Horizontal bar layout:
  // - profit case: [pink expenses | green profit] = revenue (100%)
  // - loss case:   [full pink revenue width][red overflow = how far over]
  let segs;
  if (isLoss) {
    const overflowPct = totals.revenue > 0
      ? Math.min(100, (Math.abs(net) / totals.revenue) * 100)
      : 100;
    segs = `
      <div class="admin-trend-totals__seg admin-trend-totals__seg--expense" style="width:100%"></div>
      <div class="admin-trend-totals__seg admin-trend-totals__seg--loss"    style="width:${overflowPct.toFixed(2)}%"></div>
    `;
  } else {
    const expensePct = totals.revenue > 0
      ? Math.min(100, (totals.expenses / totals.revenue) * 100)
      : 0;
    const profitPct = 100 - expensePct;
    segs = `
      <div class="admin-trend-totals__seg admin-trend-totals__seg--expense" style="width:${expensePct.toFixed(2)}%"></div>
      <div class="admin-trend-totals__seg admin-trend-totals__seg--profit"  style="width:${profitPct.toFixed(2)}%"></div>
    `;
  }

  const netLabel = isLoss
    ? `Loss <strong>−${esc(formatPrice(Math.abs(net)))}</strong>`
    : `Profit <strong>+${esc(formatPrice(net))}</strong>`;
  const netClass = isLoss ? 'admin-trend-totals__chip--loss' : 'admin-trend-totals__chip--profit';
  const breakdown = `COGS ${formatPrice(totals.cogs)} · Opex ${formatPrice(totals.opex)} · Stripe ${formatPrice(totals.stripe)} · GST ${formatPrice(totals.gst)}`;

  const hint = hasNoOpex
    ? `<div class="admin-trend-totals__hint">
        No operating expenses logged for this window.
        <a href="#financial-health">Add at Finance → Expenses</a>
        to capture supplier purchases, shipping, marketing, etc.
       </div>`
    : '';

  // COGS-source note: confirm the profit figure is reconciled from real per-order
  // supplier costs (snapshots), or flag that it's still the provisional analytics
  // estimate until those resolve. Keeps the headline honest about its basis.
  const covPct = _kpi.coverage != null ? Math.round(_kpi.coverage * 100) : null;
  const cogsSrcNote = _kpi.reconciled
    ? `<div class="admin-trend-totals__hint admin-trend-totals__hint--src">
        <span aria-hidden="true">✓</span> COGS reconciled from per-order supplier costs${covPct != null && covPct < 100 ? ` (${covPct}% of revenue valued)` : ''} — not the analytics estimate.
       </div>`
    : `<div class="admin-trend-totals__hint admin-trend-totals__hint--src">
        COGS is the provisional analytics estimate — per-order supplier costs not resolved for this window.
       </div>`;

  el.innerHTML = `
    <div class="admin-trend-totals__row">
      ${revenueChip}
      <span class="admin-trend-totals__chip admin-trend-totals__chip--expense" title="${esc(breakdown)}">
        Expenses <strong>${esc(formatPrice(totals.expenses))}</strong>
      </span>
      <span class="admin-trend-totals__chip ${netClass}">
        ${netLabel}
      </span>
    </div>
    <div class="admin-trend-totals__bar" role="img" aria-label="Revenue vs total expenses for ${esc(rangeLabel())}">
      ${segs}
    </div>
    <div class="admin-trend-totals__breakdown">${esc(breakdown)}</div>
    ${cogsSrcNote}
    ${hint}
  `;
}

function drawTrendChart() {
  const series = Array.isArray(_trendData) ? _trendData : [];
  const hasAny = series.some(m => m.revenue || m.expenses || m.orders);

  if (!series.length || !hasAny) {
    const canvas = document.getElementById('chart-trend');
    if (canvas) {
      canvas.closest('.admin-chart-box').innerHTML =
        '<div class="admin-dash-inline-empty">No data for this range — try a wider window</div>';
    }
    renderTrendTotals([]);
    return;
  }
  renderTrendTotals(series);

  const colors = Charts.getThemeColors();
  const labels = series.map(m => m.label);
  const revenueArr = series.map(m => m.revenue);
  const expenseArr = series.map(m => m.expenses);
  const profitArr  = series.map(m => m.net);
  const orderArr   = series.map(m => m.orders);
  // When COGS is unknown the per-bucket `net` excludes product cost — the
  // "Net Profit" line is really "Net excl. COGS". Relabel so the legend and
  // tooltip don't claim a profit the data can't support (see ERR-028).
  const trendCogsKnown = !series.some(m => m && m.cogsKnown === false);
  const netLineLabel = trendCogsKnown ? 'Net Profit' : 'Net (excl. COGS)';

  let chartType = 'bar';
  let datasets;
  if (_trendMetric === 'revenue') {
    chartType = 'bar';
    datasets = [
      {
        type: 'bar',
        label: 'Revenue',
        data: revenueArr,
        backgroundColor: colors.success + 'cc',
        borderRadius: 4,
        barPercentage: 0.7,
        categoryPercentage: 0.8,
      },
      {
        type: 'bar',
        label: 'Expenses',
        data: expenseArr,
        backgroundColor: colors.magenta + 'cc',
        borderRadius: 4,
        barPercentage: 0.7,
        categoryPercentage: 0.8,
      },
    ];
  } else if (_trendMetric === 'profit') {
    chartType = 'line';
    datasets = [{
      label: netLineLabel,
      data: profitArr,
      borderColor: colors.cyan,
      backgroundColor: hexToRgba(colors.cyan, 0.22),
      borderWidth: 2,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
    }];
  } else {
    chartType = 'line';
    datasets = [{
      label: 'Orders',
      data: orderArr,
      borderColor: colors.yellow,
      backgroundColor: hexToRgba(colors.yellow, 0.22),
      borderWidth: 2,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
    }];
  }

  const render = chartType === 'bar' ? Charts.bar : Charts.line;
  render.call(Charts, 'chart-trend', {
    labels,
    datasets,
    options: {
      plugins: {
        legend: {
          display: _trendMetric === 'revenue',
          position: 'top',
          labels: { color: colors.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.raw || 0;
              if (_trendMetric === 'orders') return `${ctx.dataset.label}: ${v}`;
              return `${ctx.dataset.label}: ${formatPrice(v)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
        y: {
          beginAtZero: _trendMetric !== 'profit',
          ticks: {
            callback: (v) => _trendMetric === 'orders' ? v : formatPrice(v),
          },
        },
      },
    },
  });
}

// ---------- Forecast ----------

function buildForecastSeries(d) {
  // Historical: use revSeries (daily) — always last 30 days regardless of filter,
  // so the forecast context is consistent. But we also respect filter if it's wider.
  const cfg = getBucketConfig();
  const revSeries = firstArray(d.revSeries?.series, []);
  const historical = revSeries
    .map(r => ({ ts: Date.parse(r.date), rev: Number(r.revenue || 0) }))
    .filter(x => !isNaN(x.ts))
    .sort((a, b) => a.ts - b.ts);

  const f30 = pickForecast(d.forecasts, 30);
  const f60 = pickForecast(d.forecasts, 60);
  const f90 = pickForecast(d.forecasts, 90);

  // Local fallback: when the backend forecast endpoint ships nothing, project
  // forward at the trailing 30-day daily revenue average instead of letting the
  // chart flat-line at $0. `usingLocal` flags the headline as a trend estimate.
  const localAvg = forecastDailyAvgFromHistory(historical, 30);
  const usingLocal = f30 == null;

  // Daily avg projections for days 1-30, 31-60, 61-90. Fall back to the local
  // trailing average whenever the corresponding backend horizon is missing.
  const avg30 = f30 != null ? f30 / 30 : localAvg;
  const avg60 = f60 != null && f30 != null ? (f60 - f30) / 30 : avg30;
  const avg90 = f90 != null && f60 != null ? (f90 - f60) / 30 : avg60;

  // 30-day projected revenue total for the card headline — backend value, or
  // the local average grossed back up to a 30-day total.
  const projected30 = f30 != null ? f30 : (localAvg != null ? localAvg * 30 : null);

  // Prior forecasts: each snapshot's projected_revenue is a 30-day total.
  // Convert to implied daily avg so it overlays the daily-scale actual/forecast lines.
  const priorSnapshots = firstArray(d.forecastHistory?.snapshots, ['snapshots']);
  const horizonDays = d.forecastHistory?.horizon_days || 30;
  const prior = priorSnapshots
    .map(s => ({
      ts: Date.parse(s.snapshot_date),
      dailyAvg: Number(s.projected_revenue || 0) / horizonDays,
      total: Number(s.projected_revenue || 0),
      confidence: s.confidence || null,
    }))
    .filter(x => !isNaN(x.ts))
    .sort((a, b) => a.ts - b.ts);

  // Net-profit margin for the visible window — used to project a profit line
  // alongside the revenue forecast. _trendData is built immediately before
  // this function in render(), so its totals are the corrected COGS/expense
  // figures. Net = revenue − expenses; margin = net / revenue.
  const trendTotals = sumTrendTotals(Array.isArray(_trendData) ? _trendData : []);
  // A profit projection is only as honest as its net-profit margin. When COGS
  // is unknown for the window (analytics RPC down + no per-order item costs)
  // the margin below excludes the largest cost line and runs far too high —
  // so the forecast must NOT project a profit off it. `cogsKnown` gates the
  // profit headline and the chart's profit lines; `netMargin` is left null so
  // every downstream consumer fails closed.
  const cogsKnown = trendTotals.cogsKnown !== false;
  const netMargin = (cogsKnown && trendTotals.revenue > 0)
    ? (trendTotals.revenue - trendTotals.expenses) / trendTotals.revenue
    : null;

  return { historical, prior, cfg, avg30, avg60, avg90, f30, f60, f90, projected30, usingLocal, horizonDays, netMargin, cogsKnown };
}

function drawForecastChart() {
  const state = _forecastData;
  const canvas = document.getElementById('chart-forecast');
  if (!canvas) return;

  const hasForecast = state && (state.f30 != null || state.avg30 != null);
  const hasHistorical = state && state.historical.length > 0;

  if (!hasForecast && !hasHistorical) {
    canvas.closest('.admin-chart-box').innerHTML =
      '<div class="admin-dash-inline-empty">No forecast data yet — need more order history</div>';
    return;
  }

  const colors = Charts.getThemeColors();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Build a contiguous daily series: historical dates + 30 forward days.
  const points = [];
  const histByDate = new Map();
  for (const h of state.historical) {
    const d = new Date(h.ts); d.setHours(0, 0, 0, 0);
    histByDate.set(d.getTime(), h.rev);
  }

  // Historical window: match filter range but cap at 90 days for legibility.
  const histDays = Math.min(90, Math.max(14, FilterState.periodToDays()));
  for (let i = histDays - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.getTime();
    points.push({ date: d, value: histByDate.get(key) || 0, type: 'actual' });
  }

  // Forward 30 days of projection, daily averages.
  const avg = state.avg30 != null ? state.avg30 : 0;
  for (let i = 1; i <= 30; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    points.push({ date: d, value: avg, type: 'forecast' });
  }

  const labels = points.map(p => p.date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }));
  const actualData   = points.map(p => p.type === 'actual'   ? p.value : null);
  const forecastData = points.map(p => p.type === 'forecast' ? p.value : null);

  // Profit lines: revenue × the window's net-profit margin. Daily COGS is not
  // available per-day, so historical profit is the margin applied to actual
  // daily revenue — labelled "estimate" in the legend so it's not mistaken
  // for booked profit. The forecast profit shares the revenue forecast's
  // flat daily average.
  //
  // When COGS is unknown for the window `state.netMargin` is null — the two
  // profit datasets are dropped entirely (see `showProfit` below) rather than
  // drawn off a margin that excludes product cost and overstates profit.
  const showProfit = state.netMargin != null && Number.isFinite(state.netMargin);
  const netMargin = showProfit ? state.netMargin : 0;
  const actualProfit   = points.map(p => p.type === 'actual'   ? p.value * netMargin : null);
  const forecastProfit = points.map(p => p.type === 'forecast' ? p.value * netMargin : null);

  // Bridge: repeat last actual as first forecast point so each line is continuous.
  const lastActualIdx = points.findIndex(p => p.type === 'forecast') - 1;
  if (lastActualIdx >= 0) {
    forecastData[lastActualIdx]   = actualData[lastActualIdx];
    forecastProfit[lastActualIdx] = actualProfit[lastActualIdx];
  }

  // Prior forecasts: align each snapshot's implied daily avg to its snapshot_date bucket.
  const priorByDay = new Map();
  for (const p of state.prior || []) {
    const d = new Date(p.ts); d.setHours(0, 0, 0, 0);
    priorByDay.set(d.getTime(), p);
  }
  const priorData = points.map(p => {
    if (p.type !== 'actual') return null;
    const hit = priorByDay.get(p.date.getTime());
    return hit ? hit.dailyAvg : null;
  });
  const hasPrior = priorData.some(v => v != null);

  const datasets = [
    {
      label: 'Revenue (actual)',
      data: actualData,
      borderColor: colors.success,
      backgroundColor: hexToRgba(colors.success, 0.16),
      borderWidth: 2,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 3,
      spanGaps: false,
      order: 2,
    },
    {
      label: 'Revenue (forecast)',
      data: forecastData,
      borderColor: colors.success,
      backgroundColor: hexToRgba(colors.success, 0.10),
      borderWidth: 2,
      borderDash: [5, 4],
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      pointHoverRadius: 3,
      spanGaps: false,
      order: 2,
    },
  ];

  // Profit lines are added only when COGS is known — otherwise the margin is
  // incomplete and the lines would overstate profit. The card headline already
  // shows "profit pending cost data" in this state.
  if (showProfit) {
    datasets.push(
      {
        label: 'Profit (actual est.)',
        data: actualProfit,
        borderColor: colors.cyan,
        backgroundColor: 'transparent',
        borderWidth: 2,
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 3,
        spanGaps: false,
        order: 1,
      },
      {
        label: 'Profit (forecast)',
        data: forecastProfit,
        borderColor: colors.cyan,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [5, 4],
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 3,
        spanGaps: false,
        order: 1,
      },
    );
  }

  if (hasPrior) {
    datasets.push({
      label: 'Prior forecasts (daily avg)',
      data: priorData,
      borderColor: hexToRgba(colors.magenta, 0.7),
      backgroundColor: 'transparent',
      borderWidth: 1.75,
      borderDash: [4, 4],
      fill: false,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointBackgroundColor: colors.magenta,
      pointBorderColor: colors.surface,
      pointBorderWidth: 1,
      spanGaps: true,
      order: 3,
    });
  }

  Charts.line('chart-forecast', {
    labels,
    datasets,
    options: {
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { color: colors.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 8 } },
        y: {
          // Drop the zero floor only if a loss window pushes profit negative,
          // so the profit line stays visible instead of clipping at the axis.
          beginAtZero: !(actualProfit.some(v => v != null && v < 0)
                      || forecastProfit.some(v => v != null && v < 0)),
          ticks: { callback: (v) => formatPrice(v) },
        },
      },
    },
  });
}

function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(100,100,100,${alpha})`;
  const h = hex.replace('#', '');
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (h.length >= 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex;
}

function wirePills() {
  const pills = document.getElementById('dash-trend-pills');
  if (!pills) return;
  pills.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-pill');
    if (!btn) return;
    const metric = btn.dataset.metric;
    if (metric === _trendMetric) return;
    _trendMetric = metric;
    pills.querySelectorAll('.admin-pill').forEach(p => p.classList.toggle('active', p === btn));
    Charts.destroy('chart-trend');
    drawTrendChart();
  });
}

// ---------- Row 3: Recent orders + Top products ----------

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
  const items = Array.isArray(data) ? data : (data ? [data] : []);
  if (!items.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Most Bought <small>top sellers</small></div>
        <div class="admin-dash-inline-empty">Top product data unavailable</div>
      </div>
    `;
  }

  const rows = items.slice(0, 10).map(p => {
    const name = p.product_name || p.name || 'Unknown';
    const brand = p.brand || '';
    const units = p.units_sold ?? p.units ?? p.quantity ?? p.qty ?? null;
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
        <a href="#analytics" class="admin-mini-card__sub">View report →</a>
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

// ---------- Row 4: Low stock + Refunds + Payment mix ----------

function renderLowStockCard(data) {
  const items = firstArray(data, ['items', 'products', 'data']);
  const total = data?.total ?? items.length;

  if (!items.length) {
    return `
      <div class="admin-dash__cell--4 admin-card">
        <div class="admin-card__title">Low / Out of Stock <small>${total || 0}</small></div>
        <div class="admin-dash-inline-empty">All products in stock</div>
      </div>
    `;
  }

  const lis = items.slice(0, 5).map(p => {
    const name = p.product_name || p.name || p.sku || 'Unknown';
    const brand = p.brand || '';
    const revAtRisk = p.revenue_at_risk ?? p.monthly_revenue ?? p.last_sold_revenue ?? null;
    return `
      <li class="admin-dash-feed__item">
        <span class="admin-dash-feed__dot admin-dash-feed__dot--danger"></span>
        <div class="admin-dash-feed__body">
          <strong>${esc(name)}</strong>
          ${brand ? ` <span class="cell-muted">· ${esc(brand)}</span>` : ''}
          <div class="admin-dash-feed__meta">${revAtRisk != null ? `${formatPrice(revAtRisk)} monthly at risk` : 'Out of stock'}</div>
        </div>
      </li>
    `;
  }).join('');

  return `
    <div class="admin-dash__cell--4 admin-card admin-card--magenta">
      <div class="admin-card__title">
        <span>Low / Out of Stock <small>${total}</small></span>
        <a href="#inventory" class="admin-mini-card__sub">Restock →</a>
      </div>
      <ul class="admin-dash-feed">${lis}</ul>
    </div>
  `;
}

function renderRefundsCard(refunds, kpis) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);

  let thisTotal = 0, thisCount = 0, lastTotal = 0, lastCount = 0;
  for (const r of series) {
    const date = String(r.date || r.month || '');
    const amt = refundAmount(r);
    const cnt = Number(r.count ?? r.refund_count ?? 1);
    if (date.startsWith(thisMonth)) { thisTotal += amt; thisCount += cnt; }
    else if (date.startsWith(lastMonth)) { lastTotal += amt; lastCount += cnt; }
  }

  const hasData = series.length > 0;

  return `
    <div class="admin-dash__cell--4 admin-card">
      <div class="admin-card__title">
        <span>Refunds <small>this month</small></span>
        ${hasData ? deltaBadge(thisTotal, lastTotal, { invert: true }) : ''}
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <div style="flex:0 0 96px;">
          <div class="admin-chart-box admin-chart-box--mini"><canvas id="chart-refund-reasons"></canvas></div>
        </div>
        <div style="flex:1;">
          <div class="admin-mini-card__value">${hasData ? formatPrice(thisTotal) : MISSING}</div>
          <div class="admin-mini-card__sub">${hasData ? `${thisCount} refund${thisCount === 1 ? '' : 's'}` : 'No refund data'}</div>
          <div class="admin-mini-card__sub">Last month: ${lastTotal ? formatPrice(lastTotal) : '$0'}</div>
        </div>
      </div>
    </div>
  `;
}

function drawRefundReasons(refunds) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  if (!series.length) return;

  const reasons = {};
  for (const r of series) {
    const reason = r.reason || r.type || 'Other';
    reasons[reason] = (reasons[reason] || 0) + refundAmount(r);
  }
  const labels = Object.keys(reasons);
  const data   = Object.values(reasons);
  if (!labels.length) return;

  const colors = Charts.getThemeColors();
  const palette = [colors.magenta, colors.yellow, colors.cyan, colors.success, colors.danger];

  Charts.doughnut('chart-refund-reasons', {
    labels,
    data,
    colors: labels.map((_, i) => palette[i % palette.length]),
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatPrice(ctx.raw || 0)}`,
          },
        },
      },
    },
  });
}

function renderPaymentMixCard(data) {
  return `
    <div class="admin-dash__cell--4 admin-card">
      <div class="admin-card__title">
        <span>Payment Methods <small>this month</small></span>
      </div>
      <div class="admin-chart-box admin-chart-box--compact"><canvas id="chart-payment-mix"></canvas></div>
    </div>
  `;
}

function drawPaymentMixDonut(data) {
  if (!data) {
    emptyCanvas('chart-payment-mix', 'No payment data yet');
    return;
  }

  let labels = [], values = [];

  if (Array.isArray(data.methods)) {
    for (const m of data.methods) {
      labels.push(m.name || m.method || m.label || 'Unknown');
      values.push(Number(m.total || m.amount || m.count || 0));
    }
  } else if (Array.isArray(data)) {
    for (const m of data) {
      labels.push(m.name || m.method || 'Unknown');
      values.push(Number(m.total || m.amount || m.count || 0));
    }
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && (v.total != null || v.amount != null || v.count != null)) {
        labels.push(k);
        values.push(Number(v.total || v.amount || v.count || 0));
      } else if (typeof v === 'number') {
        labels.push(k);
        values.push(v);
      }
    }
  }

  if (!labels.length || values.every(v => v === 0)) {
    emptyCanvas('chart-payment-mix', 'No payment data yet');
    return;
  }

  const colors = Charts.getThemeColors();
  const palette = [colors.cyan, colors.magenta, colors.yellow, colors.success, '#60a5fa'];

  Charts.doughnut('chart-payment-mix', {
    labels,
    data: values,
    colors: labels.map((_, i) => palette[i % palette.length]),
    options: {
      plugins: {
        legend: {
          display: true,
          position: 'right',
          labels: { color: colors.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatPrice(ctx.raw || 0)}`,
          },
        },
      },
    },
  });
}

function emptyCanvas(canvasId, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const box = canvas.closest('.admin-chart-box');
  if (box) box.innerHTML = `<div class="admin-dash-inline-empty">${esc(message)}</div>`;
}

// ---------- Row 5: Market Intel + Activity ----------

function renderMarketIntelCard(overpriced, discrepancies) {
  const over = firstArray(overpriced, ['items', 'products', 'data']).slice(0, 5);
  const disc = firstArray(discrepancies, ['items', 'products', 'data']).slice(0, 5);

  if (!over.length && !disc.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Market Intel <small>alerts</small></div>
        <div class="admin-dash-inline-empty">No market alerts</div>
      </div>
    `;
  }

  const items = [];
  for (const p of over) {
    const name = p.product_name || p.name || p.sku || 'Unknown';
    const gap = p.gap_pct ?? p.diff_pct ?? p.variance ?? null;
    items.push({
      dot: 'yellow',
      body: `<strong>${esc(name)}</strong> priced above market`,
      meta: gap != null ? `${Number(gap).toFixed(1)}% over competitors` : 'Review pricing',
    });
  }
  for (const p of disc) {
    const name = p.product_name || p.name || p.sku || 'Unknown';
    const gap = p.variance_pct ?? p.variance ?? null;
    items.push({
      dot: 'cyan',
      body: `<strong>${esc(name)}</strong> price discrepancy`,
      meta: gap != null ? `${Number(gap).toFixed(1)}% variance vs supplier` : 'Sync required',
    });
  }

  const lis = items.slice(0, 8).map(i => `
    <li class="admin-dash-feed__item">
      <span class="admin-dash-feed__dot admin-dash-feed__dot--${i.dot}"></span>
      <div class="admin-dash-feed__body">
        ${i.body}
        <div class="admin-dash-feed__meta">${esc(i.meta)}</div>
      </div>
    </li>
  `).join('');

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Market Intel <small>alerts</small></span>
        <a href="#market-intel" class="admin-mini-card__sub">Open intel →</a>
      </div>
      <ul class="admin-dash-feed">${lis}</ul>
    </div>
  `;
}

function renderActivityCard(logs) {
  const entries = firstArray(logs, ['logs', 'items', 'data']);
  if (!entries.length) {
    return `
      <div class="admin-dash__cell--6 admin-card">
        <div class="admin-card__title">Recent Activity</div>
        <div class="admin-dash-inline-empty">No recent activity</div>
      </div>
    `;
  }

  const dotFor = (action) => {
    const a = String(action || '').toLowerCase();
    if (a.includes('refund') || a.includes('cancel')) return 'magenta';
    if (a.includes('order')) return 'success';
    if (a.includes('login') || a.includes('auth')) return 'cyan';
    if (a.includes('price') || a.includes('discount')) return 'yellow';
    return '';
  };

  const lis = entries.slice(0, 12).map(e => {
    const action = e.action || e.event || 'activity';
    const who = e.actor_email || e.user_email || e.actor || '';
    const desc = e.description || e.details || e.message || action;
    const when = timeAgo(e.created_at || e.createdAt || e.timestamp);
    const dot = dotFor(action);
    return `
      <li class="admin-dash-feed__item">
        <span class="admin-dash-feed__dot admin-dash-feed__dot--${dot}"></span>
        <div class="admin-dash-feed__body">
          <strong>${esc(action)}</strong> ${who ? `<span class="cell-muted">· ${esc(who)}</span>` : ''}
          <div class="admin-dash-feed__meta">${esc(desc)}${when ? ` · ${esc(when)}` : ''}</div>
        </div>
      </li>
    `;
  }).join('');

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>Recent Activity</span>
        <a href="#audit" class="admin-mini-card__sub">Audit log →</a>
      </div>
      <ul class="admin-dash-feed">${lis}</ul>
    </div>
  `;
}

// ---------- Sparklines ----------

function drawSparklines(d) {
  const sparkOpts = (color) => ({
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false, grid: { display: false }, ticks: { display: false } },
      y: { display: false, grid: { display: false }, ticks: { display: false } },
    },
    elements: { point: { radius: 0 } },
    _sparkColor: color,
  });

  // Revenue sparkline from daily revSeries
  const revSeries = firstArray(d.revSeries?.series, []);
  if (revSeries.length) {
    const colors = Charts.getThemeColors();
    Charts.line('spark-rev', {
      labels: revSeries.map(() => ''),
      datasets: [{
        data: revSeries.map(r => r.revenue || 0),
        borderColor: colors.cyan,
        backgroundColor: colors.cyan + '22',
        fill: true,
        borderWidth: 1.5,
        tension: 0.35,
        pointRadius: 0,
      }],
      options: sparkOpts(colors.cyan),
    });
  }

  // Orders sparkline from raw orders grouped by date within the revSeries window
  if (revSeries.length) {
    const colors = Charts.getThemeColors();
    const rawOrders = revenueGeneratingOrders(d.rawOrders);
    const countByDate = {};
    for (const o of rawOrders) {
      const date = (o.created_at || '').slice(0, 10);
      if (date) countByDate[date] = (countByDate[date] || 0) + 1;
    }
    const orderSeries = revSeries.map(r => countByDate[r.date] || 0);
    Charts.line('spark-ord', {
      labels: orderSeries.map(() => ''),
      datasets: [{
        data: orderSeries,
        borderColor: colors.magenta,
        backgroundColor: colors.magenta + '22',
        fill: true,
        borderWidth: 1.5,
        tension: 0.35,
        pointRadius: 0,
      }],
      options: sparkOpts(colors.magenta),
    });
  }

  // Refund rate sparkline: per-date refund amount / matching-date revenue
  const refSeries = firstArray(d.refunds, ['series', 'refunds', 'data']);
  if (refSeries.length && revSeries.length) {
    const revByDate = {};
    for (const r of revSeries) revByDate[r.date] = r.revenue || 0;
    const rateSeries = refSeries.map(r => {
      const rev = revByDate[r.date] || 0;
      const refundAmt = refundAmount(r);
      return rev > 0 ? (refundAmt / rev) * 100 : 0;
    });
    const colors = Charts.getThemeColors();
    Charts.line('spark-ref', {
      labels: rateSeries.map(() => ''),
      datasets: [{
        data: rateSeries,
        borderColor: colors.danger,
        backgroundColor: colors.danger + '22',
        fill: true,
        borderWidth: 1.5,
        tension: 0.35,
        pointRadius: 0,
      }],
      options: sparkOpts(colors.danger),
    });
  }
}

// ---------- Page lifecycle ----------

export default {
  title: 'Dashboard',

  async init(container) {
    _container = container;
    _trendMetric = 'revenue';
    await loadDashboard();
  },

  destroy() {
    Charts.destroyAll();
    _container = null;
    _trendData = null;
    _forecastData = null;
    _hasRenderedSuccessfully = false; // next mount shows the skeleton again
    _loadSeq++;                       // any in-flight load now stale-checks and bails
  },

  async onFilterChange() {
    if (_container) await loadDashboard();
  },
};
