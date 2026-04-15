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
];

let _container = null;
let _activeTab = 'revenue';
let _data = null;
let _lazyTabModule = null;

async function loadAnalytics() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();

  const [kpisResult, revSeriesResult, brandResult] = await Promise.allSettled([
    AdminAPI.getDashboardKPIs(params, signal),
    AdminAPI.getRevenueSeries(params, signal),
    AdminAPI.getBrandBreakdown(params, 'revenue', signal),
  ]);

  _data = {
    kpis:      kpisResult?.value      ?? null,
    revSeries: revSeriesResult?.value ?? null,
    brandData: brandResult?.value     ?? null,
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

  const { kpis, revSeries, brandData } = _data;
  const cur  = kpis?.current  ?? {};
  const prev = kpis?.previous ?? {};

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

  }
}

// ---- Section renderers ----

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
