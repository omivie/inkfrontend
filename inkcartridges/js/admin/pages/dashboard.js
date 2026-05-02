/**
 * Dashboard — "Everything at a glance" bento layout
 * KPI strip · Revenue vs Expenses · Orders/Products · Alerts · Activity
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;
const MISSING = '—';

let _container = null;
let _trendData = null;       // bucketed historical series keyed to current filter
let _forecastData = null;    // { historical, projected } for forecast chart
let _trendMetric = 'revenue';

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

// ---------- data loading ----------

async function loadDashboard() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();

  if (!isOwner) {
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
  ];

  const results = await Promise.allSettled(promises);
  const val = (i) => results[i]?.status === 'fulfilled' ? results[i].value : null;

  render({
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
  });
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

function renderKpiStrip(d) {
  const cur  = d.kpis?.current  ?? {};
  const prev = d.kpis?.previous ?? {};
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
      tooltip: 'Requires supplier cost data on order items',
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

  let html = '<div class="admin-kpi-grid admin-kpi-grid--8">';
  for (const t of tiles) {
    const alertCls = t.alert ? ' admin-kpi--alert' : '';
    html += `<div class="admin-kpi admin-kpi--compact${alertCls}">`;
    html += `<div class="admin-kpi__label">${esc(t.label)}</div>`;
    if (t.value != null) {
      html += `<div class="admin-kpi__value">${esc(t.value)}</div>`;
      html += deltaBadge(t.raw, t.prev);
    } else {
      html += missingValue(t.tooltip || 'Data unavailable');
    }
    if (t.sparkId) {
      html += `<div class="admin-kpi__spark"><canvas id="${t.sparkId}"></canvas></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function sumRefundAmounts(refunds) {
  const series = firstArray(refunds, ['series', 'refunds', 'data']);
  if (!series.length) return null;
  return series.reduce((sum, r) => sum + (r.amount || r.total || r.value || 0), 0);
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
    </div>
  `;
}

function renderForecastCard(d) {
  const forecastRevenue = pickForecast(d.forecasts, 30);
  const forecastConf    = d.forecasts?.confidence ?? null;
  const confStr = typeof forecastConf === 'number'
    ? `${forecastConf}% confidence`
    : (typeof forecastConf === 'string' && forecastConf
        ? `${forecastConf.charAt(0).toUpperCase()}${forecastConf.slice(1)} confidence`
        : 'Projected revenue');
  const summary = forecastRevenue != null ? formatPrice(forecastRevenue) : MISSING;

  return `
    <div class="admin-dash__cell--6 admin-card">
      <div class="admin-card__title">
        <span>30-day Forecast <small>${esc(rangeLabel())} + projection</small></span>
        <div class="admin-forecast-summary">
          <span class="admin-forecast-summary__value">${esc(summary)}</span>
          <span class="admin-forecast-summary__sub">${esc(confStr)}</span>
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
  const cashOnHand   = d.runway?.cash_on_hand ?? d.runway?.cash ?? null;
  const burnRate     = d.runway?.burn_rate ?? d.runway?.monthly_burn ?? null;

  const cur = d.kpis?.current ?? {};
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
  if (days <= 60) {
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

  // 1. Daily revenue series (most accurate for rev within filter range)
  const revSeries = firstArray(d.revSeries?.series, []);
  for (const r of revSeries) {
    const ts = Date.parse(r.date);
    if (isNaN(ts)) continue;
    const i = indexFor(ts);
    if (i < 0) continue;
    buckets[i].revenue += Number(r.revenue || 0);
    buckets[i].hasRevenue = true;
  }

  // 2. Raw orders — count per bucket + fallback revenue
  const rawOrders = firstArray(d.rawOrders, ['orders', 'data']);
  for (const o of rawOrders) {
    const ts = Date.parse(o.created_at || o.createdAt || '');
    if (isNaN(ts)) continue;
    const i = indexFor(ts);
    if (i < 0) continue;
    buckets[i].orders += 1;
    if (!buckets[i].hasRevenue) {
      buckets[i].revenue += Number(o.total || 0);
    }
  }

  // 3. Expenses — only P&L has this, keyed monthly. Distribute evenly into contained buckets.
  const pnlPeriods = Array.isArray(d.pnl?.periods) ? d.pnl.periods
                   : Array.isArray(d.pnl) ? d.pnl : [];
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
    const expense = (p.cogs != null || p.operating_expenses != null)
      ? Number(p.cogs || 0) + Number(p.operating_expenses || 0)
      : (p.expenses != null ? Number(p.expenses) : null);
    const net = p.net_profit != null ? Number(p.net_profit) : null;

    // Find buckets overlapping the month, weight by days of overlap.
    const overlaps = [];
    for (const b of buckets) {
      const bStart = b.startMs;
      const bEnd = cfg.unit === 'month'
        ? new Date(new Date(bStart).getFullYear(), new Date(bStart).getMonth() + 1, 1).getTime()
        : bStart + cfg.stepMs;
      const ov = Math.max(0, Math.min(bEnd, monthEnd) - Math.max(bStart, monthStart));
      if (ov > 0) overlaps.push({ b, ov });
    }
    const totalOv = overlaps.reduce((s, o) => s + o.ov, 0);
    if (!totalOv) continue;

    for (const { b, ov } of overlaps) {
      const w = ov / totalOv;
      if (expense != null) { b.expenses += expense * w; b.hasExpense = true; }
      if (net != null)     { b.net      += net * w;     b.hasNet = true; }
    }
  }

  // 4. Derive net if still missing
  for (const b of buckets) {
    if (!b.hasNet) b.net = b.revenue - b.expenses;
  }

  return buckets;
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
    return;
  }

  const colors = Charts.getThemeColors();
  const labels = series.map(m => m.label);
  const revenueArr = series.map(m => m.revenue);
  const expenseArr = series.map(m => m.expenses);
  const profitArr  = series.map(m => m.net);
  const orderArr   = series.map(m => m.orders);

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
      label: 'Net Profit',
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

  // Daily avg projections for days 1-30, 31-60, 61-90.
  const avg30 = f30 != null ? f30 / 30 : null;
  const avg60 = f60 != null && f30 != null ? (f60 - f30) / 30 : avg30;
  const avg90 = f90 != null && f60 != null ? (f90 - f60) / 30 : avg60;

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

  return { historical, prior, cfg, avg30, avg60, avg90, f30, f60, f90, horizonDays };
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

  // Bridge: repeat last actual as first forecast point so line is continuous.
  const lastActualIdx = points.findIndex(p => p.type === 'forecast') - 1;
  if (lastActualIdx >= 0) {
    forecastData[lastActualIdx] = actualData[lastActualIdx];
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
      label: 'Actual',
      data: actualData,
      borderColor: colors.success,
      backgroundColor: hexToRgba(colors.success, 0.18),
      borderWidth: 2,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 3,
      spanGaps: false,
      order: 2,
    },
    {
      label: 'Forecast',
      data: forecastData,
      borderColor: colors.cyan,
      backgroundColor: hexToRgba(colors.cyan, 0.14),
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
        y: { beginAtZero: true, ticks: { callback: (v) => formatPrice(v) } },
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
    const amt = Number(r.amount || r.total || r.value || 0);
    const cnt = Number(r.count || 1);
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
    reasons[reason] = (reasons[reason] || 0) + Number(r.amount || r.total || r.value || 0);
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
    const rawOrders = firstArray(d.rawOrders, ['orders', 'data']);
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
      const refundAmt = Number(r.amount || r.total || 0);
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
  },

  async onFilterChange() {
    if (_container) await loadDashboard();
  },
};
