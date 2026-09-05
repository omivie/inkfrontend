/**
 * Analytics hub ("Performance") — in-depth drill-down across the metric families.
 * ==============================================================================
 *
 * Tabs are NOT declared here. They live in utils/analytics-tabs.js, which the admin
 * sidebar also reads, so the bar on this page and the indented sub-links under the
 * ANALYTICS group can never list different tabs (Sep 2026 — ERR-208).
 *
 * Two things this page owes the shell, both because the router keys off the route and
 * this hub's real address includes `?tab=`:
 *
 *   • `onRouteChange({ tab })` — the hash changed but the ROUTE did not (someone clicked
 *     a sidebar sub-link while already here). Before ERR-208 there was no such hook and
 *     the click did nothing at all: hashchange fired, app.js compared route-without-query,
 *     saw no change, and returned.
 *   • an `admin:tab-change` CustomEvent on `window` after every switch — writeTabToHash()
 *     uses history.replaceState (deliberately: tab switches should not stack back-button
 *     entries), which fires NO hashchange, so the sidebar would otherwise never learn about
 *     a tab clicked in-page. A DOM event is also the only channel that reaches the shell:
 *     app.js is evaluated as two module instances (see its __ADMIN_BOOTED__ guard), and the
 *     one that owns the sidebar is not the one this file imports.
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { ANALYTICS_TABS, ANALYTICS_TAB_IDS, ANALYTICS_DEFAULT_TAB, analyticsTabLabel } from '../utils/analytics-tabs.js';

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

// No GST-basis slot here yet, unlike dashboard.js's renderKpiTile(): these
// tiles come from getDashboardKPIs/getRevenueSeries — a different path from the
// P&L, with no basis stated anywhere for revenue/AOV/volatility. Blank is the
// honest answer until the backend confirms. See gst-basis-backend-brief-jul2026.md.
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

// Tabs come from the shared manifest — see utils/analytics-tabs.js for why.
const TABS = ANALYTICS_TABS;
const TAB_IDS = ANALYTICS_TAB_IDS;

// Read/persist the active tab in the hash query so #analytics?tab=traffic
// deep-links (the website-traffic route redirects here, June 2026 IA overhaul).
function readTabFromHash() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx < 0) return null;
  const t = new URLSearchParams(hash.slice(qIdx + 1)).get('tab');
  return TAB_IDS.includes(t) ? t : null;
}

function writeTabToHash(tabId) {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const [base, query] = hash.split('?');
  const params = new URLSearchParams(query || '');
  params.set('tab', tabId);
  const next = `#${base || 'analytics'}?${params.toString()}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

let _container = null;
let _activeTab = ANALYTICS_DEFAULT_TAB;
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
    <div class="admin-page-header"><h1>Performance</h1></div>
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
    switchTab(btn.dataset.tab);
  });

  renderTabContent();
}

/**
 * The ONE way this hub changes tab — the in-page bar and the sidebar sub-links both
 * end up here, so they cannot diverge in what they clean up (ERR-208). Returns false
 * when there is nothing to do, which is what stops the hashchange -> onRouteChange ->
 * switchTab -> announce -> ... path from looping.
 */
function switchTab(tabId) {
  if (!_container) return false;
  if (!TAB_IDS.includes(tabId)) return false;
  if (tabId === _activeTab) { announceTab(); return false; }

  // Destroy lazy tab if active
  if (_lazyTabModule?.destroy) _lazyTabModule.destroy();
  _lazyTabModule = null;

  _activeTab = tabId;
  writeTabToHash(tabId);
  _container.querySelectorAll('.admin-analytics-tab').forEach(b => {
    b.classList.toggle('is-active', b.dataset.tab === tabId);
  });
  announceTab();
  renderTabContent();
  return true;
}

/**
 * Tell the shell which tab is showing. Carries two jobs the router cannot do itself:
 * the sidebar highlight (writeTabToHash uses replaceState, which fires no hashchange)
 * and the document title (navigate() reads `page.title` once, before any tab is known).
 */
function announceTab() {
  const label = analyticsTabLabel(_activeTab);
  if (label) document.title = `${label} | Admin | InkCartridges.co.nz`;
  window.dispatchEvent(new CustomEvent('admin:tab-change', {
    detail: { route: 'analytics', tab: _activeTab },
  }));
}

async function renderTabContent() {
  Charts.destroyAll();
  // Reset filter-bar visibility to the default for every tab. Lazy panels that
  // want to restrict it (Health → period only, Traffic → none) re-apply that in
  // their own init(); without this baseline, leaving Traffic (which hides all
  // filters) would leave the bar misconfigured for Revenue.
  FilterState.setVisibleFilters(null);
  const el = _container?.querySelector('#analytics-tab-content');
  if (!el) return;

  // Lazily-mounted tabs. The module path travels WITH the label in the shared manifest
  // (utils/analytics-tabs.js) — it used to live in a second object keyed by the same ids.
  const tab = TABS.find(t => t.id === _activeTab);
  if (tab?.lazy) {
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh"><div class="admin-loading__spinner"></div></div>`;
    try {
      const mod = await import(tab.lazy);
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
  title: 'Performance',

  async init(container) {
    _container = container;
    _activeTab = readTabFromHash() || ANALYTICS_DEFAULT_TAB;
    _lazyTabModule = null;
    await loadAnalytics();   // ends in render()
    announceTab();           // a bare #analytics resolved to a tab — say which one
  },

  /**
   * The hash changed but the route did not: a sidebar sub-link clicked while already
   * on this page. Without this the click was silent (ERR-208).
   */
  onRouteChange({ tab } = {}) {
    // No tab in the address (someone navigated to a bare #analytics while already here):
    // the hub keeps the panel it is showing — but it must SAY so, or the sidebar would
    // fall back to marking the parent row while a named tab is still on screen.
    if (!tab) { announceTab(); return; }
    switchTab(tab);
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
