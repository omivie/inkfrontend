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
  }

  const results = await Promise.allSettled(promises);
  const kpis      = isOwner ? (results[0]?.value ?? null) : null;
  const revSeries = isOwner ? (results[1]?.value ?? null) : null;
  const custStats = isOwner ? (results[2]?.value ?? null) : null;

  render({ kpis, revSeries, custStats, isOwner });
}

function render({ kpis, revSeries, custStats, isOwner }) {
  if (!_container) return;
  Charts.destroyAll();

  let html = `<div class="admin-page-header"><h1>Dashboard</h1></div>`;

  if (isOwner) {
    html += renderKPIs(kpis, custStats);
    html += `
      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Revenue Over Time <small>${FilterState.get('period')}</small></div>
        <div class="admin-chart-box"><canvas id="chart-revenue"></canvas></div>
      </div>
    `;
  }

  _container.innerHTML = html;

  if (isOwner) {
    renderRevenueChart(revSeries);
  }
}

function renderKPIs(kpis, custStats) {
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
      label: 'Orders',
      value: cur.orders != null ? String(cur.orders) : null,
      raw: cur.orders,
      prevRaw: prev.orders,
    },
    {
      label: 'AOV',
      value: cur.aov != null ? formatPrice(cur.aov) : null,
      raw: cur.aov,
      prevRaw: prev.aov,
    },
    {
      label: 'Returning %',
      value: cc.returning_pct != null ? `${cc.returning_pct}%` : null,
      raw: cc.returning_pct,
      prevRaw: cp.returning_pct,
      missingTip: 'Requires analytics_customer_stats RPC',
    },
    {
      label: 'Total Customers',
      value: cc.total_customers != null ? String(cc.total_customers) : null,
      raw: cc.total_customers,
      prevRaw: cp.total_customers,
      missingTip: 'Requires analytics_customer_stats RPC',
    },
  ];

  let html = '<div class="admin-kpi-grid admin-kpi-grid--5 admin-mb-lg">';
  for (const card of cards) {
    html += `<div class="admin-kpi">`;
    html += `<div class="admin-kpi__label">${esc(card.label)}</div>`;
    if (card.value != null) {
      html += `<div class="admin-kpi__value">${esc(card.value)}</div>`;
      html += delta(card.raw, card.prevRaw);
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
