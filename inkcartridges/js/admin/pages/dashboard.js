/**
 * Dashboard Page — Role-specific operational + analytics dashboard
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
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
let _charts = [];

async function loadDashboard() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const isOwner = AdminAuth.isOwner();

  // Parallel data fetch
  const promises = [
    AdminAPI.getWorkQueue(signal),
    AdminAPI.getFulfillmentSLA(params, signal),
  ];
  if (isOwner) {
    promises.push(AdminAPI.getDashboardKPIs(params, signal));
    promises.push(AdminAPI.getRevenueSeries(params, signal));
    promises.push(AdminAPI.getBrandBreakdown(params, 'revenue', signal));
    promises.push(AdminAPI.getRefundAnalytics(params, signal));
  }

  const results = await Promise.allSettled(promises);
  const workQueue = results[0]?.value ?? null;
  const sla = results[1]?.value ?? null;
  const kpis = isOwner ? (results[2]?.value ?? null) : null;
  const revSeries = isOwner ? (results[3]?.value ?? null) : null;
  const brandData = isOwner ? (results[4]?.value ?? null) : null;
  const refundData = isOwner ? (results[5]?.value ?? null) : null;

  render({ workQueue, sla, kpis, revSeries, brandData, refundData, isOwner });
}

function render({ workQueue, sla, kpis, revSeries, brandData, refundData, isOwner }) {
  if (!_container) return;
  Charts.destroyAll();

  let html = `<div class="admin-page-header"><h1>Dashboard</h1></div>`;

  // Owner KPIs
  if (isOwner) {
    html += renderOwnerKPIs(kpis);
  }

  // Work Queue
  html += renderWorkQueue(workQueue);

  // SLA Section
  html += renderSLA(sla);

  if (isOwner) {
    // Revenue Chart
    html += `
      <div class="admin-grid-2 admin-mb-lg">
        <div class="admin-card admin-card--cyan">
          <div class="admin-card__title">Revenue Over Time <small>${FilterState.get('period')}</small></div>
          <div class="admin-chart-box"><canvas id="chart-revenue"></canvas></div>
        </div>
        <div class="admin-card admin-card--magenta">
          <div class="admin-card__title">Brand Breakdown</div>
          <div class="admin-chart-box"><canvas id="chart-brands"></canvas></div>
        </div>
      </div>
    `;

    // Refund Summary
    html += renderRefundSummary(refundData);
  }

  _container.innerHTML = html;

  // Render charts after DOM update
  if (isOwner) {
    renderRevenueChart(revSeries);
    renderBrandChart(brandData);
  }
}

function renderOwnerKPIs(kpis) {
  const cur = kpis?.current ?? {};
  const prev = kpis?.previous ?? {};

  const cards = [
    { label: 'Revenue', value: cur.revenue != null ? formatPrice(cur.revenue) : null, prev: prev.revenue },
    { label: 'Orders', value: cur.orders, prev: prev.orders },
    { label: 'AOV', value: cur.aov != null ? formatPrice(cur.aov) : null, prev: prev.aov },
    { label: 'Refund Rate', value: cur.refund_rate != null ? `${cur.refund_rate.toFixed(1)}%` : null, prev: prev.refund_rate, invert: true },
    { label: 'Chargeback Rate', value: cur.chargeback_rate != null ? `${cur.chargeback_rate.toFixed(1)}%` : null, prev: prev.chargeback_rate, invert: true },
    { label: 'Margin Proxy', value: cur.margin_proxy != null ? `${cur.margin_proxy.toFixed(1)}%` : null, prev: prev.margin_proxy, sub: 'Based on cost snapshots' },
    { label: 'Fulfillment SLA', value: cur.sla_48h != null ? `${cur.sla_48h.toFixed(0)}%` : null, prev: prev.sla_48h, sub: 'Shipped within 48h' },
    { label: 'Volatility', value: cur.volatility != null ? formatPrice(cur.volatility) : null, sub: '\u03C3 daily revenue' },
  ];

  let html = '<div class="admin-kpi-grid">';
  for (const card of cards) {
    html += `<div class="admin-kpi">`;
    html += `<div class="admin-kpi__label">${esc(card.label)}</div>`;
    if (card.value != null) {
      html += `<div class="admin-kpi__value">${esc(String(card.value))}</div>`;
      if (card.prev != null) {
        const raw = typeof card.value === 'string' ? parseFloat(card.value.replace(/[^0-9.\-]/g, '')) : card.value;
        html += delta(raw, card.prev);
      }
    } else {
      html += missing('Requires analytics RPC endpoint');
    }
    if (card.sub) html += `<div class="admin-kpi__sub">${esc(card.sub)}</div>`;
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderWorkQueue(wq) {
  const items = [
    { label: 'Orders to Ship', key: 'orders_to_ship', iconType: 'warn', ic: 'orders' },
    { label: 'Missing Tracking', key: 'missing_tracking', iconType: 'warn', ic: 'fulfillment' },
    { label: 'Refunds Pending', key: 'refunds_pending', iconType: 'danger', ic: 'refunds' },
    { label: 'Late Deliveries', key: 'late_deliveries', iconType: 'info', ic: 'suppliers' },
    { label: 'Cancellations', key: 'cancellations', iconType: 'danger', ic: 'refunds' },
  ];

  let html = `<div class="admin-section">`;
  html += `<div class="admin-section__header"><h2 class="admin-section__title">Work Queue</h2></div>`;
  html += '<div class="admin-queue-grid">';

  for (const item of items) {
    const count = wq?.[item.key];
    const displayCount = count != null ? count : MISSING;
    const tooltip = count == null ? ' data-tooltip="Requires admin_work_queue RPC"' : '';
    const href = item.key === 'refunds_pending' ? '#refunds' : '#orders';

    html += `
      <a class="admin-queue-item" href="${href}"${tooltip}>
        <div class="admin-queue-item__icon admin-queue-item__icon--${item.iconType}">
          ${icon(item.ic)}
        </div>
        <div>
          <div class="admin-queue-item__count">${esc(String(displayCount))}</div>
          <div class="admin-queue-item__label">${esc(item.label)}</div>
        </div>
      </a>
    `;
  }

  html += '</div></div>';
  return html;
}

function renderSLA(sla) {
  let html = `<div class="admin-section"><div class="admin-section__header"><h2 class="admin-section__title">Fulfillment SLA</h2></div>`;
  html += '<div class="admin-grid-3 admin-mb-lg">';

  const metrics = [
    { label: 'Paid \u2192 Shipped Median', value: sla?.median_hours != null ? `${sla.median_hours.toFixed(1)}h` : null },
    { label: 'Shipped within 48h', value: sla?.pct_48h != null ? `${sla.pct_48h.toFixed(0)}%` : null },
    { label: 'Tracking Coverage', value: sla?.tracking_coverage != null ? `${(sla.tracking_coverage * 100).toFixed(0)}%` : null },
  ];

  for (const m of metrics) {
    html += `<div class="admin-card">`;
    html += `<div class="admin-kpi__label">${esc(m.label)}</div>`;
    if (m.value != null) {
      html += `<div class="admin-kpi__value" style="font-size:22px">${esc(m.value)}</div>`;
    } else {
      html += missing('Requires analytics_fulfillment_sla RPC');
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

function renderRefundSummary(data) {
  if (!data) {
    return `
      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Refund Analytics</div>
        <div class="admin-empty">
          <div class="admin-empty__title">${MISSING}</div>
          <div class="admin-empty__text" data-tooltip="Requires analytics_refunds_series RPC">Refund analytics data unavailable</div>
        </div>
      </div>
    `;
  }

  let html = `<div class="admin-card admin-card--yellow admin-mb-lg">`;
  html += `<div class="admin-card__title">Refund Analytics</div>`;
  if (data.reasons?.length) {
    html += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>';
    html += '<th>Reason</th><th class="cell-right">Count</th><th class="cell-right">Amount</th><th class="cell-right">% of Total</th>';
    html += '</tr></thead><tbody>';
    const total = data.reasons.reduce((s, r) => s + (r.count || 0), 0) || 1;
    for (const r of data.reasons) {
      html += `<tr>
        <td>${esc(r.reason || r.reason_code || 'Unknown')}</td>
        <td class="cell-right cell-mono">${r.count ?? MISSING}</td>
        <td class="cell-right cell-mono">${r.amount != null ? formatPrice(r.amount) : MISSING}</td>
        <td class="cell-right cell-mono">${((r.count / total) * 100).toFixed(1)}%</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  } else {
    html += `<div class="admin-empty"><div class="admin-empty__text">No refund reason data available</div></div>`;
  }
  html += '</div>';
  return html;
}

async function renderRevenueChart(data) {
  if (!data?.series?.length) return;

  const labels = data.series.map(d => d.date?.slice(5) || '');
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

  // Previous period overlay
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

async function renderBrandChart(data) {
  if (!data?.brands?.length) return;

  const labels = data.brands.map(b => b.brand || 'Unknown');
  const values = data.brands.map(b => b.current_revenue || 0);

  const colors = Charts.getThemeColors();
  const palette = [colors.cyan, colors.magenta, colors.yellow, colors.success, '#60a5fa', '#a78bfa', '#fb923c', '#f472b6'];

  await Charts.bar('chart-brands', {
    labels,
    datasets: [{
      label: 'Revenue',
      data: values,
      backgroundColor: labels.map((_, i) => palette[i % palette.length] + 'cc'),
      borderRadius: 4,
      barThickness: 24,
    }],
    options: {
      indexAxis: 'y',
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => formatPrice(ctx.raw || 0),
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
