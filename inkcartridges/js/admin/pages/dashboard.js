/**
 * Dashboard Page — 30-second pulse check
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014'; // em dash

function missing(tooltip = 'Data unavailable') {
  return `<span class="admin-kpi__value admin-kpi__value--missing" data-tooltip="${esc(tooltip)}">${MISSING}</span>`;
}

function delta(current, previous) {
  if (current == null || previous == null) return '';
  if (previous === 0) return current > 0 ? '<span class="admin-kpi__delta admin-kpi__delta--up">\u2191 new</span>' : '';
  const pct = ((current - previous) / Math.abs(previous) * 100).toFixed(1);
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '\u2191' : dir === 'down' ? '\u2193' : '\u2192';
  return `<span class="admin-kpi__delta admin-kpi__delta--${dir}">${arrow} ${Math.abs(pct)}%</span>`;
}

function badge24h() {
  return `<span class="admin-kpi__badge-24h">&#x23F1; 24h window</span>`;
}

function emptyChart(canvasId, message = 'No data for this period') {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const box = canvas.closest('.admin-chart-box');
  if (!box) return;
  box.innerHTML = `<div class="admin-dash-empty"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 16l4-4 4 4 4-4"/></svg><span>${esc(message)}</span></div>`;
}

let _container = null;

async function loadDashboard() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();

  const promises = [];
  if (isOwner) {
    promises.push(AdminAPI.getDashboardKPIs(params, signal));
    promises.push(AdminAPI.getRevenueSeries(params, signal));
    promises.push(AdminAPI.getCustomerStats(params, signal));
    promises.push(AdminAPI.getTopProducts(params, signal));
    promises.push(AdminAPI.getBrandBreakdown(params, 'revenue', signal));
    promises.push(AdminAPI.getNewOrders24h(signal));
    // Fetch all orders (up to 500) to build orders-over-time series
    promises.push(AdminAPI.getOrders(
      { from: params.get('from'), to: params.get('to') },
      1, 500, signal
    ));
  }

  const results = await Promise.allSettled(promises);
  const kpis         = isOwner ? (results[0]?.value ?? null) : null;
  const revSeries    = isOwner ? (results[1]?.value ?? null) : null;
  const custStats    = isOwner ? (results[2]?.value ?? null) : null;
  const topProducts  = isOwner ? (results[3]?.value ?? null) : null;
  const brandData    = isOwner ? (results[4]?.value ?? null) : null;
  const newOrders24h = isOwner ? (results[5]?.value ?? null) : null;
  const rawOrders    = isOwner ? (results[6]?.value ?? null) : null;

  render({ kpis, revSeries, custStats, topProducts, brandData, newOrders24h, rawOrders, isOwner });
}

function render({ kpis, revSeries, custStats, topProducts, brandData, newOrders24h, rawOrders, isOwner }) {
  if (!_container) return;
  Charts.destroyAll();

  let html = `<div class="admin-page-header"><h1>Dashboard</h1></div>`;

  if (isOwner) {
    html += renderKPIs(kpis, custStats, newOrders24h);
    html += `
      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Revenue Over Time <small>${FilterState.get('period')}</small></div>
        <div class="admin-chart-box"><canvas id="chart-revenue"></canvas></div>
      </div>
      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Orders Over Time <small>${FilterState.get('period')}</small></div>
        <div class="admin-chart-box"><canvas id="chart-orders"></canvas></div>
      </div>
      <div class="admin-grid-2 admin-mb-lg">
        <div class="admin-card">
          <div class="admin-card__title">Top Products <small>by revenue</small></div>
          <div class="admin-chart-box admin-chart-box--tall"><canvas id="chart-top-products"></canvas></div>
        </div>
        <div class="admin-card">
          <div class="admin-card__title">Revenue by Brand</div>
          <div class="admin-chart-box admin-chart-box--tall"><canvas id="chart-brand-breakdown"></canvas></div>
        </div>
      </div>
    `;
  }

  _container.innerHTML = html;

  if (isOwner) {
    renderRevenueChart(revSeries);
    renderOrdersChart(revSeries, rawOrders);
    renderTopProductsChart(topProducts);
    renderBrandChart(brandData);
  }
}

function renderKPIs(kpis, custStats, newOrders24h) {
  const cur  = kpis?.current  ?? {};
  const prev = kpis?.previous ?? {};
  const cc   = custStats?.current  ?? {};
  const cp   = custStats?.previous ?? {};

  const cards = [
    {
      label: 'Revenue',
      value: cur.revenue != null ? formatPrice(cur.revenue) : null,
      raw: cur.revenue,
      prevRaw: prev.revenue,
    },
    {
      label: 'Profit',
      value: cur.gross_profit != null ? formatPrice(cur.gross_profit) : null,
      raw: cur.gross_profit,
      prevRaw: prev.gross_profit,
      missingTip: 'Requires supplier cost data on order items',
    },
    {
      label: 'Orders',
      value: cur.orders != null ? String(cur.orders) : null,
      raw: cur.orders,
      prevRaw: prev.orders,
    },
    {
      label: 'New Orders',
      value: newOrders24h != null ? String(newOrders24h) : null,
      raw: null,
      prevRaw: null,
      is24h: true,
    },
    {
      label: 'Returning %',
      value: cc.returning_pct != null ? `${cc.returning_pct}%` : null,
      raw: cc.returning_pct,
      prevRaw: cp.returning_pct,
      missingTip: 'Requires analytics_customer_stats RPC',
    },
  ];

  let html = '<div class="admin-kpi-grid admin-kpi-grid--5 admin-mb-lg">';
  for (const card of cards) {
    html += `<div class="admin-kpi">`;
    html += `<div class="admin-kpi__label">${esc(card.label)}</div>`;
    if (card.value != null) {
      html += `<div class="admin-kpi__value">${esc(card.value)}</div>`;
      if (card.is24h) {
        html += badge24h();
      } else {
        html += delta(card.raw, card.prevRaw);
      }
    } else {
      html += missing(card.missingTip || 'Data unavailable');
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

async function renderRevenueChart(data) {
  if (!data?.series?.length) return;

  const labels   = data.series.map(d => d.date?.slice(5) || '');
  const revenues = data.series.map(d => d.revenue || 0);

  // Compute 7-day MA
  const ma7 = [];
  for (let i = 0; i < revenues.length; i++) {
    if (i < 6) { ma7.push(null); continue; }
    let sum = 0;
    for (let j = i - 6; j <= i; j++) sum += revenues[j];
    ma7.push(sum / 7);
  }

  const colors = Charts.getThemeColors();
  const datasets = [
    {
      label: 'Revenue',
      data: revenues,
      borderColor: colors.cyan,
      backgroundColor: colors.cyan + '18',
      fill: true,
      tension: 0.3,
      pointRadius: data.series.map(d => d.is_anomaly ? 6 : 1),
      pointBackgroundColor: data.series.map(d => d.is_anomaly ? colors.danger : colors.cyan),
      borderWidth: 2,
    },
    {
      label: '7D MA',
      data: ma7,
      borderColor: colors.cyan + '60',
      borderDash: [6, 3],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    },
  ];

  if (data.previous_series?.length) {
    datasets.push({
      label: 'Previous Period',
      data: data.previous_series.map(d => d.revenue || 0),
      borderColor: colors.textMuted + '40',
      borderDash: [3, 3],
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
    });
  }

  await Charts.line('chart-revenue', {
    labels,
    datasets,
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex === 0) {
                const d = data.series[ctx.dataIndex];
                return [
                  `Revenue: ${formatPrice(d.revenue || 0)}`,
                  `Orders: ${d.orders ?? MISSING}`,
                  `AOV: ${d.aov != null ? formatPrice(d.aov) : MISSING}`,
                ];
              }
              return `${ctx.dataset.label}: ${formatPrice(ctx.raw || 0)}`;
            },
          },
        },
      },
    },
  });
}

async function renderOrdersChart(revSeries, rawOrders) {
  if (!revSeries?.series?.length) {
    emptyChart('chart-orders', 'No order data for this period');
    return;
  }

  // Build a date → count map from raw orders (accurate per-day counts)
  const countByDate = {};
  const orderList = Array.isArray(rawOrders) ? rawOrders : (rawOrders?.orders || rawOrders?.data || []);
  for (const o of orderList) {
    const date = (o.created_at || '').slice(0, 10);
    if (date) countByDate[date] = (countByDate[date] || 0) + 1;
  }

  const labels = revSeries.series.map(d => d.date?.slice(5) || '');
  const orders = revSeries.series.map(d => countByDate[d.date] || 0);
  const hasData = orders.some(v => v > 0);

  if (!hasData) {
    emptyChart('chart-orders', 'No order data for this period');
    return;
  }

  const colors = Charts.getThemeColors();

  await Charts.line('chart-orders', {
    labels,
    datasets: [
      {
        label: 'Orders',
        data: orders,
        borderColor: colors.magenta,
        backgroundColor: colors.magenta + '18',
        fill: true,
        tension: 0.3,
        pointRadius: 1,
        borderWidth: 2,
      },
    ],
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `Orders: ${ctx.raw}`,
          },
        },
      },
      scales: {
        y: { ticks: { precision: 0 } },
      },
    },
  });
}

async function renderTopProductsChart(data) {
  // RPC returns raw array; single-result gets unwrapped by rpc() helper
  const items = Array.isArray(data) ? data : (data ? [data] : []);
  if (!items.length) {
    emptyChart('chart-top-products', 'Top products unavailable');
    return;
  }

  const colors = Charts.getThemeColors();
  const palette = [colors.cyan, colors.magenta, colors.yellow, colors.success, '#60a5fa', '#a78bfa', '#fb923c', '#f472b6'];

  const labels   = items.map(d => d.product_name || d.name || 'Unknown');
  const revenues = items.map(d => d.revenue || 0);

  await Charts.bar('chart-top-products', {
    labels,
    datasets: [
      {
        label: 'Revenue',
        data: revenues,
        backgroundColor: labels.map((_, i) => palette[i % palette.length] + 'cc'),
        borderRadius: 4,
        barThickness: 18,
      },
    ],
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Revenue: ${formatPrice(ctx.raw || 0)}`,
          },
        },
      },
    },
  });
}

async function renderBrandChart(data) {
  // RPC returns { brands: [...] }
  if (!data?.brands?.length) {
    emptyChart('chart-brand-breakdown', 'Brand data unavailable');
    return;
  }

  const colors = Charts.getThemeColors();
  const palette = [colors.cyan, colors.magenta, colors.yellow, colors.success, '#60a5fa', '#a78bfa', '#fb923c', '#f472b6'];

  const brands   = data.brands;
  const labels   = brands.map(b => b.brand || 'Unknown');
  const revenues = brands.map(b => b.current_revenue || 0);

  await Charts.doughnut('chart-brand-breakdown', {
    labels,
    data: revenues,
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

export default {
  title: 'Dashboard',

  async init(container) {
    _container = container;
    await loadDashboard();
  },

  destroy() {
    Charts.destroyAll();
    _container = null;
  },

  async onFilterChange() {
    if (_container) await loadDashboard();
  },
};
