/**
 * Analytics Page — In-depth drill-down across 5 metric categories
 * Tabbed layout: Revenue | Customers | Products | Operations | Traffic
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

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

function kpiCard({ label, value, raw, prevRaw, missingTip, sub }) {
  let html = `<div class="admin-kpi">`;
  html += `<div class="admin-kpi__label">${esc(label)}</div>`;
  if (value != null) {
    html += `<div class="admin-kpi__value">${esc(value)}</div>`;
    html += delta(raw, prevRaw);
  } else {
    html += missing(missingTip || 'Requires analytics RPC endpoint');
  }
  if (sub) html += `<div class="admin-kpi__sub">${esc(sub)}</div>`;
  html += '</div>';
  return html;
}

const TABS = [
  { id: 'revenue',     label: 'Revenue' },
  { id: 'health',      label: 'Health', lazy: true },
  { id: 'margins',     label: 'Margins', lazy: true },
  { id: 'pricing',     label: 'Pricing', lazy: true },
  { id: 'market-intel', label: 'Market Intel', lazy: true },
  { id: 'customers',   label: 'Customers' },
  { id: 'products',    label: 'Products' },
  { id: 'operations',  label: 'Operations' },
];

let _container = null;
let _activeTab = 'revenue';
let _data = null;
let _lazyTabModule = null;

async function loadAnalytics() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();

  const [kpisResult, revSeriesResult, brandResult, custResult, topProductsResult, refundResult] = await Promise.allSettled([
    AdminAPI.getDashboardKPIs(params, signal),
    AdminAPI.getRevenueSeries(params, signal),
    AdminAPI.getBrandBreakdown(params, 'revenue', signal),
    AdminAPI.getCustomerStats(params, signal),
    AdminAPI.getTopProducts(params, signal),
    AdminAPI.getRefundAnalytics(params, signal),
  ]);

  _data = {
    kpis:        kpisResult?.value        ?? null,
    revSeries:   revSeriesResult?.value   ?? null,
    brandData:   brandResult?.value       ?? null,
    custStats:   custResult?.value        ?? null,
    topProducts: topProductsResult?.value ?? null,
    refundData:  refundResult?.value      ?? null,
  };

  render();
}

function render() {
  if (!_container) return;
  Charts.destroyAll();

  _container.innerHTML = `
    <div class="admin-page-header"><h1>Finance</h1></div>
    <div class="admin-analytics-tabs" id="analytics-tabs">
      ${TABS.map(t => `
        <button class="admin-analytics-tab${t.id === _activeTab ? ' is-active' : ''}" data-tab="${esc(t.id)}">
          ${esc(t.label)}
        </button>
      `).join('')}
    </div>
    <div id="analytics-tab-content"></div>
  `;

  _container.querySelector('#analytics-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tabId = btn.dataset.tab;
    if (tabId === _activeTab) return;

    // Destroy lazy tab if active
    if (_lazyTabModule?.destroy) _lazyTabModule.destroy();
    _lazyTabModule = null;

    _activeTab = tabId;
    _container.querySelectorAll('.admin-analytics-tab').forEach(b => {
      b.classList.toggle('is-active', b.dataset.tab === tabId);
    });
    renderTabContent();
  });

  renderTabContent();
}

async function renderTabContent() {
  Charts.destroyAll();
  const el = _container?.querySelector('#analytics-tab-content');
  if (!el) return;

  // Handle lazy-loaded tabs (margins, pricing, market-intel)
  const tab = TABS.find(t => t.id === _activeTab);
  if (tab?.lazy) {
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh"><div class="admin-loading__spinner"></div></div>`;
    const moduleMap = {
      'health': './financial-health.js',
      'margins': './margin.js',
      'pricing': './cc-profit.js',
      'market-intel': './cc-market-intel.js',
    };
    try {
      const mod = await import(moduleMap[_activeTab]);
      _lazyTabModule = mod.default;
      el.innerHTML = '';
      await _lazyTabModule.init(el);
    } catch (e) {
      el.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load ${esc(tab.label)}</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
    return;
  }

  if (!_data) return;

  const { kpis, revSeries, brandData, custStats, topProducts, refundData } = _data;
  const cur  = kpis?.current  ?? {};
  const prev = kpis?.previous ?? {};
  const cc   = custStats?.current  ?? {};
  const cp   = custStats?.previous ?? {};

  switch (_activeTab) {
    case 'revenue': {
      el.innerHTML = `
        <div class="admin-kpi-grid admin-kpi-grid--3 admin-mb-lg">
          ${kpiCard({ label: 'Revenue',       value: cur.revenue   != null ? formatPrice(cur.revenue) : null, raw: cur.revenue,   prevRaw: prev.revenue })}
          ${kpiCard({ label: 'AOV',           value: cur.aov       != null ? formatPrice(cur.aov)     : null, raw: cur.aov,       prevRaw: prev.aov })}
          ${kpiCard({ label: 'Rev Volatility',value: cur.volatility!= null ? formatPrice(cur.volatility): null, sub: '\u03C3 daily revenue' })}
        </div>
        <div class="admin-card admin-mb-lg">
          <div class="admin-card__title">Revenue Series <small>${FilterState.get('period')}</small></div>
          <div class="admin-chart-box"><canvas id="chart-revenue-detail"></canvas></div>
        </div>
        <div class="admin-grid-2 admin-mb-lg">
          <div class="admin-card admin-card--cyan">
            <div class="admin-card__title">Revenue by Brand</div>
            <div class="admin-chart-box"><canvas id="chart-brands"></canvas></div>
          </div>
          <div class="admin-card">
            <div class="admin-card__title">Brand Revenue Detail</div>
            ${renderBrandTable(brandData)}
          </div>
        </div>
      `;
      renderRevenueChart(revSeries);
      renderBrandChart(brandData);
      break;
    }

    case 'customers': {
      el.innerHTML = `
        <div class="admin-kpi-grid admin-kpi-grid--3 admin-mb-lg">
          ${kpiCard({ label: 'Total Customers',    value: cc.total_customers     != null ? String(cc.total_customers)     : null, raw: cc.total_customers,     prevRaw: cp.total_customers,     missingTip: 'Requires analytics_customer_stats RPC' })}
          ${kpiCard({ label: 'New Customers',      value: cc.new_customers       != null ? String(cc.new_customers)       : null, raw: cc.new_customers,       prevRaw: cp.new_customers,       missingTip: 'Requires analytics_customer_stats RPC' })}
          ${kpiCard({ label: 'Returning Customers',value: cc.returning_customers != null ? String(cc.returning_customers) : null, raw: cc.returning_customers, prevRaw: cp.returning_customers, missingTip: 'Requires analytics_customer_stats RPC' })}
        </div>
        <div class="admin-grid-2 admin-mb-lg">
          <div class="admin-card">
            <div class="admin-card__title">Retention Rates</div>
            ${renderRetentionStats(custStats)}
          </div>
          <div class="admin-card">
            <div class="admin-card__title">Customer Breakdown</div>
            ${renderCustomerStatRows(custStats)}
          </div>
        </div>
      `;
      break;
    }

    case 'products': {
      el.innerHTML = `
        <div class="admin-card admin-mb-lg">
          <div class="admin-card__title">Top Products</div>
          ${renderTopProducts(topProducts)}
        </div>
      `;
      break;
    }

    case 'operations': {
      el.innerHTML = `
        <div class="admin-kpi-grid admin-mb-lg">
          ${kpiCard({ label: 'Refund Rate',     value: cur.refund_rate     != null ? `${cur.refund_rate.toFixed(1)}%`     : null, raw: cur.refund_rate,     prevRaw: prev.refund_rate })}
          ${kpiCard({ label: 'Chargeback Rate', value: cur.chargeback_rate != null ? `${cur.chargeback_rate.toFixed(1)}%` : null, raw: cur.chargeback_rate, prevRaw: prev.chargeback_rate })}
          ${kpiCard({ label: 'Margin Proxy',    value: cur.margin_proxy    != null ? `${cur.margin_proxy.toFixed(1)}%`    : null, raw: cur.margin_proxy,    prevRaw: prev.margin_proxy, sub: 'Based on cost snapshots' })}
          ${kpiCard({ label: 'Fulfillment SLA', value: cur.sla_48h         != null ? `${cur.sla_48h.toFixed(0)}%`         : null, raw: cur.sla_48h,         prevRaw: prev.sla_48h, sub: 'Shipped within 48h' })}
        </div>
        <div class="admin-card admin-mb-lg">
          <div class="admin-card__title">Refund Analytics</div>
          ${renderRefundTable(refundData)}
        </div>
      `;
      break;
    }

  }
}

// ---- Section renderers ----

function renderRetentionStats(custStats) {
  if (!custStats) {
    return `<div class="admin-empty"><div class="admin-empty__text" data-tooltip="Requires analytics_customer_stats RPC">Customer analytics unavailable</div></div>`;
  }
  const cc = custStats?.current  ?? {};
  const cp = custStats?.previous ?? {};
  const rows = [
    { label: 'Returning %',         value: cc.returning_pct         != null ? `${cc.returning_pct}%`         : null, raw: cc.returning_pct,         prev: cp.returning_pct },
    { label: 'Returning Revenue %', value: cc.returning_revenue_pct != null ? `${cc.returning_revenue_pct}%` : null, raw: cc.returning_revenue_pct, prev: cp.returning_revenue_pct },
  ];
  let html = `<div class="admin-cust-stats">`;
  for (const row of rows) {
    html += `<div class="admin-cust-stat">`;
    html += `<div class="admin-cust-stat__label">${esc(row.label)}</div>`;
    html += `<div class="admin-cust-stat__right">`;
    if (row.value != null) {
      html += `<div class="admin-cust-stat__value">${esc(row.value)}</div>`;
      html += delta(row.raw, row.prev);
    } else {
      html += `<div class="admin-cust-stat__value" style="color:var(--text-muted)">${MISSING}</div>`;
    }
    html += `</div></div>`;
  }
  return html + `</div>`;
}

function renderCustomerStatRows(custStats) {
  if (!custStats) {
    return `<div class="admin-empty"><div class="admin-empty__text" data-tooltip="Requires analytics_customer_stats RPC">Customer analytics unavailable</div></div>`;
  }
  const cc = custStats?.current  ?? {};
  const cp = custStats?.previous ?? {};
  const rows = [
    { label: 'Total Customers',   value: cc.total_customers,     prev: cp.total_customers },
    { label: 'New Customers',     value: cc.new_customers,       prev: cp.new_customers },
    { label: 'Returning',         value: cc.returning_customers, prev: cp.returning_customers },
    { label: 'Returning Revenue', value: cc.returning_revenue != null ? formatPrice(cc.returning_revenue) : null, raw: cc.returning_revenue, prev: cp.returning_revenue },
  ];
  let html = `<div class="admin-cust-stats">`;
  for (const row of rows) {
    const rawVal = row.raw ?? (typeof row.value === 'number' ? row.value : null);
    html += `<div class="admin-cust-stat">`;
    html += `<div class="admin-cust-stat__label">${esc(row.label)}</div>`;
    html += `<div class="admin-cust-stat__right">`;
    if (row.value != null) {
      html += `<div class="admin-cust-stat__value">${esc(String(row.value))}</div>`;
      html += delta(rawVal, row.prev);
    } else {
      html += `<div class="admin-cust-stat__value" style="color:var(--text-muted)">${MISSING}</div>`;
    }
    html += `</div></div>`;
  }
  return html + `</div>`;
}

function renderTopProducts(data) {
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  if (!rows.length) {
    return `<div class="admin-empty"><div class="admin-empty__text" data-tooltip="Requires analytics_top_products RPC">Top products unavailable</div></div>`;
  }
  let html = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
    <th>Product</th><th>SKU</th><th class="cell-right">Revenue</th><th class="cell-right">Orders</th><th class="cell-right">Units</th>
  </tr></thead><tbody>`;
  for (const row of rows) {
    html += `<tr>
      <td style="font-weight:600;font-size:13px">${esc(row.product_name || row.name || MISSING)}</td>
      <td style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${esc(row.sku || MISSING)}</td>
      <td class="cell-right cell-mono">${row.revenue != null ? formatPrice(row.revenue) : MISSING}</td>
      <td class="cell-right cell-mono">${row.orders ?? MISSING}</td>
      <td class="cell-right cell-mono">${row.units ?? MISSING}</td>
    </tr>`;
  }
  return html + `</tbody></table></div>`;
}

function renderRefundTable(data) {
  // Preferred shape (when backend ships reason breakdown): { reasons: [{reason, count, amount}] }
  if (data?.reasons?.length) {
    const total = data.reasons.reduce((s, r) => s + (r.count || 0), 0) || 1;
    let html = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
      <th>Reason</th><th class="cell-right">Count</th><th class="cell-right">Amount</th><th class="cell-right">Share</th>
    </tr></thead><tbody>`;
    for (const r of data.reasons) {
      html += `<tr>
        <td>${esc(r.reason || r.reason_code || 'Unknown')}</td>
        <td class="cell-right cell-mono">${r.count ?? MISSING}</td>
        <td class="cell-right cell-mono">${r.amount != null ? formatPrice(r.amount) : MISSING}</td>
        <td class="cell-right cell-mono">${((r.count / total) * 100).toFixed(1)}%</td>
      </tr>`;
    }
    return html + `</tbody></table></div>`;
  }

  // Fallback: use the daily series returned by analytics_refunds_series RPC
  const series = Array.isArray(data?.series) ? data.series : [];
  const totalCount = series.reduce((s, r) => s + (r.refund_count || 0), 0);
  const totalAmount = series.reduce((s, r) => s + (r.total_amount || 0), 0);
  if (!series.length || totalCount === 0) {
    return `<div class="admin-empty"><div class="admin-empty__text">No refunds in this period</div></div>`;
  }
  const rows = series.filter(r => (r.refund_count || 0) > 0);
  let html = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${totalCount} refund${totalCount === 1 ? '' : 's'} totalling ${formatPrice(totalAmount)}</div>`;
  html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
    <th>Date</th><th class="cell-right">Refunds</th><th class="cell-right">Orders</th><th class="cell-right">Amount</th>
  </tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr>
      <td>${esc(r.date || MISSING)}</td>
      <td class="cell-right cell-mono">${r.refund_count ?? MISSING}</td>
      <td class="cell-right cell-mono">${r.total_orders ?? MISSING}</td>
      <td class="cell-right cell-mono">${r.total_amount != null ? formatPrice(r.total_amount) : MISSING}</td>
    </tr>`;
  }
  return html + `</tbody></table></div>`;
}

function renderBrandTable(data) {
  if (!data?.brands?.length) {
    return `<div class="admin-empty"><div class="admin-empty__text" data-tooltip="Requires analytics_brand_breakdown RPC">Brand data unavailable</div></div>`;
  }
  let html = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
    <th>Brand</th><th class="cell-right">Revenue</th><th class="cell-right">vs Prior</th><th class="cell-right">Orders</th>
  </tr></thead><tbody>`;
  for (const b of data.brands) {
    const curr = b.current_revenue ?? 0;
    const prev = b.previous_revenue ?? 0;
    const pct  = prev > 0 ? ((curr - prev) / prev * 100).toFixed(1) : null;
    const dir  = pct == null ? '' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const arrow = { up: '\u2191', down: '\u2193', flat: '\u2192' }[dir] || '';
    const deltaClass = { up: 'admin-kpi__delta--up', down: 'admin-kpi__delta--down', flat: '' }[dir] || '';
    html += `<tr>
      <td>${esc(b.brand || 'Unknown')}</td>
      <td class="cell-right cell-mono">${formatPrice(curr)}</td>
      <td class="cell-right cell-mono"><span class="${deltaClass}">${pct != null ? `${arrow} ${Math.abs(pct)}%` : MISSING}</span></td>
      <td class="cell-right cell-mono">${b.orders ?? MISSING}</td>
    </tr>`;
  }
  return html + `</tbody></table></div>`;
}

// ---- Chart renderers ----

async function renderRevenueChart(data) {
  if (!data?.series?.length) return;
  const labels   = data.series.map(d => d.date?.slice(5) || '');
  const revenues = data.series.map(d => d.revenue || 0);

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
      pointRadius: data.series.map(d => d.is_anomaly ? 5 : 1),
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

  await Charts.line('chart-revenue-detail', {
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
      plugins: { tooltip: { callbacks: { label: (ctx) => formatPrice(ctx.raw || 0) } } },
    },
  });
}

// ---- Module export ----

export default {
  title: 'Finance',

  async init(container) {
    _container = container;
    _activeTab = 'revenue';
    _lazyTabModule = null;
    await loadAnalytics();
  },

  destroy() {
    Charts.destroyAll();
    if (_lazyTabModule?.destroy) _lazyTabModule.destroy();
    _lazyTabModule = null;
    _container = null;
    _data = null;
  },

  async onFilterChange() {
    if (_lazyTabModule?.onFilterChange) {
      _lazyTabModule.onFilterChange();
    } else if (_container) {
      await loadAnalytics();
    }
  },
};
