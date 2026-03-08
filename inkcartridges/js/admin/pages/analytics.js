/**
 * Analytics Page — Owner-only, 5-tab mega-page
 * Tabs: Financial, Customer Intelligence, Marketing, Operations, Alerts
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

function kpi(label, value, sub = '') {
  const v = value != null ? esc(String(value)) : `<span class="admin-kpi__value--missing">${MISSING}</span>`;
  return `<div class="admin-kpi"><div class="admin-kpi__label">${esc(label)}</div><div class="admin-kpi__value" style="font-size:20px">${v}</div>${sub ? `<div class="admin-kpi__sub">${esc(sub)}</div>` : ''}</div>`;
}

function unavailable(msg = 'Data unavailable') {
  return `<div class="admin-empty" style="min-height:200px"><div class="admin-empty__title">${MISSING}</div><div class="admin-empty__text">${esc(msg)}</div></div>`;
}

let _container = null;
let _activeTab = 'financial';
const TABS = [
  { key: 'financial', label: 'Financial' },
  { key: 'customers', label: 'Customer Intelligence' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'operations', label: 'Operations' },
  { key: 'alerts', label: 'Alerts' },
];

function renderShell() {
  let html = `<div class="admin-page-header"><h1>Analytics</h1></div>`;
  html += `<div class="admin-tabs" id="analytics-tabs">`;
  for (const t of TABS) {
    html += `<button class="admin-tab${t.key === _activeTab ? ' active' : ''}" data-tab="${t.key}">${esc(t.label)}</button>`;
  }
  html += `</div>`;
  html += `<div id="analytics-content"></div>`;
  _container.innerHTML = html;

  _container.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      _container.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      Charts.destroyAll();
      loadTab();
    });
  });
}

async function loadTab() {
  const content = document.getElementById('analytics-content');
  if (!content) return;
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:30vh"><div class="admin-loading__spinner"></div></div>`;

  switch (_activeTab) {
    case 'financial': return loadFinancial(content);
    case 'customers': return loadCustomerIntel(content);
    case 'marketing': return loadMarketing(content);
    case 'operations': return loadOperations(content);
    case 'alerts': return loadAlerts(content);
  }
}

// ---- Financial Tab ----
async function loadFinancial(el) {
  const { from, to } = FilterState.getDateRange();
  const days = FilterState.periodToDays();
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();

  const [kpiRes, revSeriesRes, burnRes, forecastRes, expenseRes] = await Promise.allSettled([
    AdminAPI.getDashboardKPIs(params, signal),
    AdminAPI.getRevenueSeries(params, signal),
    AdminAPI.getBurnRunway(),
    AdminAPI.getForecasts(),
    AdminAPI.getExpenses(from, to),
  ]);

  const kpis = kpiRes.value;
  const revSeries = revSeriesRes.value;
  const burn = burnRes.value;
  const forecast = forecastRes.value;
  const expenses = expenseRes.value;

  // Log warnings for REST endpoints that returned null/empty
  if (!forecast) console.warn('[Analytics] Forecast data unavailable — /api/admin/analytics/forecasts returned null');
  if (!expenses) console.warn('[Analytics] Expenses data unavailable — /api/admin/analytics/expenses returned null');
  if (!burn) console.warn('[Analytics] Burn/runway data unavailable — /api/admin/analytics/burn-runway returned null');

  let html = '';

  // KPIs — use RPC data (same source as dashboard)
  const cur = kpis?.current ?? {};
  const totalRev = cur.revenue;
  const marginProxy = cur.margin_proxy;
  const burnRate = burn?.burn_rate ?? burn?.monthly_burn;
  const runway = burn?.runway_months ?? burn?.months_remaining;
  html += `<div class="admin-kpi-grid">`;
  html += kpi('Revenue', totalRev != null ? formatPrice(totalRev) : null, `Last ${days}d`);
  html += kpi('Margin Proxy', marginProxy != null ? `${Number(marginProxy).toFixed(1)}%` : null, 'Based on cost snapshots');
  html += kpi('Burn Rate', burnRate != null ? `${formatPrice(burnRate)}/mo` : null);
  html += kpi('Runway', runway != null ? `${Number(runway).toFixed(1)} months` : null);
  html += `</div>`;

  // Charts
  html += `<div class="admin-grid-2 admin-mb-lg">`;
  html += `<div class="admin-card admin-card--cyan"><div class="admin-card__title">Daily Revenue</div><div class="admin-chart-box"><canvas id="chart-daily-revenue"></canvas></div></div>`;
  html += `<div class="admin-card admin-card--magenta"><div class="admin-card__title">Revenue Forecast</div><div class="admin-chart-box"><canvas id="chart-forecast"></canvas></div></div>`;
  html += `</div>`;

  // Expenses table
  html += `<div class="admin-card admin-mb-lg">`;
  html += `<div class="admin-card__title">Expenses <button class="admin-btn admin-btn--ghost admin-btn--sm" id="add-expense-btn">${icon('orders', 12, 12)} Add Expense</button></div>`;
  const expenseList = expenses?.expenses || expenses?.data || (Array.isArray(expenses) ? expenses : []);
  if (expenseList.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="cell-right">Amount</th></tr></thead><tbody>`;
    for (const ex of expenseList.slice(0, 20)) {
      html += `<tr><td class="cell-nowrap">${formatDate(ex.date || ex.created_at)}</td>`;
      html += `<td>${esc(ex.category || MISSING)}</td>`;
      html += `<td class="cell-truncate">${esc(ex.description || MISSING)}</td>`;
      html += `<td class="cell-right cell-mono">${ex.amount != null ? formatPrice(ex.amount) : MISSING}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += unavailable('No expense data');
  }
  html += `</div>`;

  el.innerHTML = html;

  // Add Expense button
  el.querySelector('#add-expense-btn')?.addEventListener('click', () => showExpenseModal());

  // Daily Revenue chart — uses RPC revenue series (same data source as dashboard)
  const series = revSeries?.series || [];
  if (series.length) {
    const colors = Charts.getThemeColors();
    Charts.line('chart-daily-revenue', {
      labels: series.map(d => (d.date || '').slice(5)),
      datasets: [{
        label: 'Revenue',
        data: series.map(d => d.revenue || 0),
        borderColor: colors.cyan,
        backgroundColor: colors.cyan + '18',
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: series.map(d => d.is_anomaly ? 6 : 1),
        pointBackgroundColor: series.map(d => d.is_anomaly ? colors.danger : colors.cyan),
      }],
      options: { plugins: { tooltip: { callbacks: { label: ctx => formatPrice(ctx.raw) } } } },
    });
  }

  // Forecast chart
  const fcData = forecast?.forecast || forecast?.data || (Array.isArray(forecast) ? forecast : []);
  if (fcData.length) {
    const colors = Charts.getThemeColors();
    Charts.line('chart-forecast', {
      labels: fcData.map(d => d.period || d.month || d.date || ''),
      datasets: [
        { label: 'Actual', data: fcData.map(d => d.actual ?? d.revenue ?? null), borderColor: colors.cyan, borderWidth: 2, pointRadius: 2 },
        { label: 'Forecast', data: fcData.map(d => d.forecast ?? d.predicted ?? null), borderColor: colors.magenta, borderDash: [6, 3], borderWidth: 2, pointRadius: 0 },
      ],
    });
  }
}

async function showExpenseModal() {
  const cats = await AdminAPI.getExpenseCategories();
  const categories = cats?.categories || cats?.data || (Array.isArray(cats) ? cats : ['Marketing', 'Shipping', 'Software', 'Office', 'Other']);

  let catOpts = categories.map(c => {
    const name = typeof c === 'string' ? c : c.name || c.category;
    return `<option value="${esc(name)}">${esc(name)}</option>`;
  }).join('');

  const modal = Modal.open({
    title: 'Add Expense',
    body: `
      <div class="admin-form-group"><label>Category</label><select class="admin-select" id="expense-category">${catOpts}</select></div>
      <div class="admin-form-group"><label>Amount (NZD)</label><input class="admin-input" type="number" step="0.01" min="0" id="expense-amount"></div>
      <div class="admin-form-group"><label>Description</label><input class="admin-input" id="expense-desc" placeholder="What was this for?"></div>
      <div class="admin-form-group"><label>Date</label><input class="admin-input" type="date" id="expense-date" value="${new Date().toISOString().slice(0, 10)}"></div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-action="save">Save</button>`,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const data = {
      category: modal.body.querySelector('#expense-category').value,
      amount: parseFloat(modal.body.querySelector('#expense-amount').value),
      description: modal.body.querySelector('#expense-desc').value.trim(),
      date: modal.body.querySelector('#expense-date').value,
    };
    if (!data.amount || data.amount <= 0) { Toast.warning('Enter a valid amount'); return; }
    try {
      await AdminAPI.createExpense(data);
      Toast.success('Expense recorded');
      Modal.close();
      Charts.destroyAll();
      loadTab();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

// ---- Customer Intelligence Tab ----
async function loadCustomerIntel(el) {
  const [ltvRes, cacRes, ratioRes, cohortRes, churnRes, healthRes, npsRes, repeatRes] = await Promise.allSettled([
    AdminAPI.getCustomerLTV(), AdminAPI.getCAC(), AdminAPI.getLTVCACRatio(),
    AdminAPI.getCohorts(), AdminAPI.getChurn(), AdminAPI.getCustomerHealth(),
    AdminAPI.getNPS(), AdminAPI.getRepeatPurchase(),
  ]);

  const ltv = ltvRes.value;
  const cac = cacRes.value;
  const ratio = ratioRes.value;
  const cohorts = cohortRes.value;
  const churn = churnRes.value;
  const health = healthRes.value;
  const nps = npsRes.value;
  const repeat = repeatRes.value;

  // Debug warnings for REST endpoints
  if (!ltv) console.warn('[Analytics] Customer LTV data unavailable');
  if (!cac) console.warn('[Analytics] CAC data unavailable');
  if (!cohorts) console.warn('[Analytics] Cohort data unavailable');
  if (!churn) console.warn('[Analytics] Churn data unavailable');
  if (!nps) console.warn('[Analytics] NPS data unavailable');

  let html = '';

  // KPIs
  const avgLtv = ltv?.avg_ltv ?? ltv?.average;
  const cacVal = cac?.cac ?? cac?.cost;
  const ratioVal = ratio?.ratio ?? ratio?.ltv_cac_ratio;
  const repeatRate = repeat?.rate ?? repeat?.repeat_rate;
  html += `<div class="admin-kpi-grid">`;
  html += kpi('Avg LTV', avgLtv != null ? formatPrice(avgLtv) : null);
  html += kpi('CAC', cacVal != null ? formatPrice(cacVal) : null);
  html += kpi('LTV:CAC Ratio', ratioVal != null ? `${Number(ratioVal).toFixed(1)}x` : null);
  html += kpi('Repeat Purchase', repeatRate != null ? `${Number(repeatRate).toFixed(1)}%` : null);
  html += `</div>`;

  // Charts row
  html += `<div class="admin-grid-2 admin-mb-lg">`;
  html += `<div class="admin-card admin-card--cyan"><div class="admin-card__title">LTV Distribution</div><div class="admin-chart-box"><canvas id="chart-ltv-dist"></canvas></div></div>`;
  html += `<div class="admin-card admin-card--magenta"><div class="admin-card__title">Cohort Retention</div><div id="cohort-heatmap" style="overflow-x:auto;max-height:320px"></div></div>`;
  html += `</div>`;

  // Churn + Health + NPS
  html += `<div class="admin-grid-2 admin-mb-lg">`;
  // Churn
  html += `<div class="admin-card admin-card--yellow"><div class="admin-card__title">Churn Analysis</div>`;
  const churnRate = churn?.churn_rate ?? churn?.rate;
  const atRisk = churn?.at_risk_count ?? churn?.at_risk;
  html += `<div style="display:flex;gap:24px;align-items:center;padding:12px 0">`;
  html += `<div><div class="admin-kpi__label">Churn Rate</div><div class="admin-kpi__value" style="font-size:28px;color:var(--danger)">${churnRate != null ? `${Number(churnRate).toFixed(1)}%` : MISSING}</div></div>`;
  html += `<div><div class="admin-kpi__label">At-Risk Customers</div><div class="admin-kpi__value" style="font-size:28px">${atRisk != null ? atRisk : MISSING}</div></div>`;
  html += `</div></div>`;

  // Health
  html += `<div class="admin-card"><div class="admin-card__title">Customer Health</div>`;
  const healthCounts = health?.summary || health?.counts;
  if (healthCounts) {
    html += `<div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 0">`;
    for (const [status, count] of Object.entries(healthCounts)) {
      const dotClass = status === 'good' || status === 'healthy' ? 'good' : status === 'warning' || status === 'at_risk' ? 'warning' : 'critical';
      html += `<div style="text-align:center"><span class="admin-health-dot admin-health-dot--${dotClass}"></span><div class="admin-kpi__value" style="font-size:20px">${count}</div><div class="admin-kpi__label">${esc(status)}</div></div>`;
    }
    html += `</div>`;
  } else {
    html += unavailable('Customer health data unavailable');
  }
  html += `</div></div>`;

  // NPS
  const npsScore = nps?.score ?? nps?.nps;
  html += `<div class="admin-card admin-mb-lg">`;
  html += `<div class="admin-card__title">Net Promoter Score</div>`;
  if (npsScore != null) {
    const npsColor = npsScore >= 50 ? 'var(--success)' : npsScore >= 0 ? 'var(--yellow)' : 'var(--danger)';
    html += `<div class="admin-nps-display"><div class="admin-nps-display__score" style="color:${npsColor}">${npsScore}</div>`;
    html += `<div class="admin-nps-display__label">${npsScore >= 50 ? 'Excellent' : npsScore >= 20 ? 'Good' : npsScore >= 0 ? 'Okay' : 'Needs Work'}</div></div>`;
    if (nps.promoters != null) {
      html += `<div style="display:flex;gap:24px;justify-content:center;margin-top:12px">`;
      html += `<div style="text-align:center"><div style="color:var(--success);font-weight:600">${nps.promoters}%</div><div class="admin-kpi__label">Promoters</div></div>`;
      html += `<div style="text-align:center"><div style="color:var(--text-muted);font-weight:600">${nps.passives ?? MISSING}%</div><div class="admin-kpi__label">Passives</div></div>`;
      html += `<div style="text-align:center"><div style="color:var(--danger);font-weight:600">${nps.detractors ?? MISSING}%</div><div class="admin-kpi__label">Detractors</div></div>`;
      html += `</div>`;
    }
  } else {
    html += unavailable('NPS data unavailable');
  }
  html += `</div>`;

  el.innerHTML = html;

  // LTV Chart
  const ltvCustomers = ltv?.customers || ltv?.data || [];
  if (ltvCustomers.length) {
    const colors = Charts.getThemeColors();
    Charts.bar('chart-ltv-dist', {
      labels: ltvCustomers.slice(0, 15).map(c => c.name || c.email?.split('@')[0] || '?'),
      datasets: [{ label: 'LTV', data: ltvCustomers.slice(0, 15).map(c => c.ltv || c.lifetime_value || 0), backgroundColor: colors.cyan + 'cc', borderRadius: 4 }],
      options: { indexAxis: 'y', plugins: { tooltip: { callbacks: { label: ctx => formatPrice(ctx.raw) } } } },
    });
  }

  // Cohort Heatmap
  const cohortRows = cohorts?.cohorts || cohorts?.data || [];
  const cohortEl = el.querySelector('#cohort-heatmap');
  if (cohortRows.length && cohortEl) {
    let t = '<table class="admin-table admin-cohort-table"><thead><tr><th>Cohort</th>';
    const maxM = Math.min(6, Math.max(...cohortRows.map(c => (c.retention || c.months || []).length)));
    for (let i = 0; i < maxM; i++) t += `<th>M${i}</th>`;
    t += '</tr></thead><tbody>';
    for (const c of cohortRows.slice(0, 10)) {
      t += `<tr><td class="cell-nowrap">${esc(c.cohort || c.month || MISSING)}</td>`;
      const vals = c.retention || c.months || [];
      for (let i = 0; i < maxM; i++) {
        const v = vals[i];
        if (v != null) {
          const pct = Number(v);
          const intensity = Math.min(1, pct / 100);
          t += `<td class="cell-center cell-mono" style="background:rgba(38,127,181,${(intensity * 0.5).toFixed(2)})">${pct.toFixed(0)}%</td>`;
        } else {
          t += `<td class="cell-center cell-muted">${MISSING}</td>`;
        }
      }
      t += '</tr>';
    }
    t += '</tbody></table>';
    cohortEl.innerHTML = t;
  } else if (cohortEl) {
    cohortEl.innerHTML = `<p class="admin-text-muted" style="padding:20px;text-align:center">Cohort data unavailable</p>`;
  }
}

// ---- Marketing Tab ----
async function loadMarketing(el) {
  const [campRes, channelRes, funnelRes] = await Promise.allSettled([
    AdminAPI.getCampaigns(), AdminAPI.getChannelEfficiency(), AdminAPI.getConversionFunnel(),
  ]);

  const campaigns = campRes.value;
  const channels = channelRes.value;
  const funnel = funnelRes.value;

  if (!campaigns) console.warn('[Analytics] Campaign data unavailable');
  if (!channels) console.warn('[Analytics] Channel efficiency data unavailable');
  if (!funnel) console.warn('[Analytics] Conversion funnel data unavailable');

  let html = '';

  // KPIs from campaigns
  const campList = campaigns?.campaigns || campaigns?.data || (Array.isArray(campaigns) ? campaigns : []);
  const totalSpend = campList.reduce((s, c) => s + (c.spend || c.budget || 0), 0);
  const avgCPA = campList.length ? campList.reduce((s, c) => s + (c.cpa || 0), 0) / campList.length : null;
  const funnelConv = funnel?.conversion_rate ?? funnel?.rate;
  const activeCamps = campList.filter(c => (c.status || '').toLowerCase() === 'active').length;

  html += `<div class="admin-kpi-grid">`;
  html += kpi('Total Spend', totalSpend ? formatPrice(totalSpend) : MISSING);
  html += kpi('Avg CPA', avgCPA != null ? formatPrice(avgCPA) : MISSING);
  html += kpi('Conversion Rate', funnelConv != null ? `${Number(funnelConv).toFixed(1)}%` : MISSING);
  html += kpi('Active Campaigns', activeCamps);
  html += `</div>`;

  // Campaigns table
  html += `<div class="admin-card admin-mb-lg">`;
  html += `<div class="admin-card__title">Campaigns <button class="admin-btn admin-btn--ghost admin-btn--sm" id="add-campaign-btn">${icon('orders', 12, 12)} Add Campaign</button></div>`;
  if (campList.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Name</th><th>Channel</th><th>Status</th><th class="cell-right">Spend</th><th class="cell-right">Revenue</th><th class="cell-right">ROAS</th></tr></thead><tbody>`;
    for (const c of campList) {
      const roas = c.revenue && c.spend ? (c.revenue / c.spend).toFixed(2) : MISSING;
      const s = String(c.status || '').toLowerCase();
      html += `<tr><td class="cell-truncate">${esc(c.name || MISSING)}</td>`;
      html += `<td>${esc(c.channel || MISSING)}</td>`;
      html += `<td><span class="admin-badge admin-badge--${s === 'active' ? 'completed' : s === 'paused' ? 'pending' : 'processing'}">${esc(c.status || MISSING)}</span></td>`;
      html += `<td class="cell-right cell-mono">${c.spend != null ? formatPrice(c.spend) : MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${c.revenue != null ? formatPrice(c.revenue) : MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${roas}x</td></tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += unavailable('No campaign data');
  }
  html += `</div>`;

  // Charts
  html += `<div class="admin-grid-2 admin-mb-lg">`;
  html += `<div class="admin-card admin-card--cyan"><div class="admin-card__title">Channel Efficiency</div><div class="admin-chart-box"><canvas id="chart-channel"></canvas></div></div>`;
  html += `<div class="admin-card admin-card--magenta"><div class="admin-card__title">Conversion Funnel</div><div id="funnel-viz" style="padding:20px"></div></div>`;
  html += `</div>`;

  el.innerHTML = html;

  // Campaign button
  el.querySelector('#add-campaign-btn')?.addEventListener('click', () => showCampaignModal());

  // Channel efficiency chart
  const channelList = channels?.channels || channels?.data || (Array.isArray(channels) ? channels : []);
  if (channelList.length) {
    const colors = Charts.getThemeColors();
    const palette = [colors.cyan, colors.magenta, colors.yellow, colors.success, '#60a5fa'];
    Charts.bar('chart-channel', {
      labels: channelList.map(c => c.channel || c.name || '?'),
      datasets: [{ label: 'ROAS', data: channelList.map(c => c.roas || c.efficiency || 0), backgroundColor: channelList.map((_, i) => palette[i % palette.length] + 'cc'), borderRadius: 4 }],
      options: { plugins: { tooltip: { callbacks: { label: ctx => `${ctx.raw.toFixed(2)}x ROAS` } } } },
    });
  }

  // Funnel visualization
  const funnelEl = el.querySelector('#funnel-viz');
  const stages = funnel?.stages || funnel?.data || (Array.isArray(funnel) ? funnel : []);
  if (stages.length && funnelEl) {
    const maxVal = stages[0]?.count || stages[0]?.value || 1;
    let fHtml = '<div class="admin-funnel">';
    for (const s of stages) {
      const val = s.count || s.value || 0;
      const pct = maxVal ? (val / maxVal * 100).toFixed(0) : 0;
      fHtml += `<div class="admin-funnel__stage"><div class="admin-funnel__bar" style="width:${pct}%"></div>`;
      fHtml += `<div class="admin-funnel__label">${esc(s.name || s.stage || '?')} <span class="cell-mono">${val.toLocaleString()}</span> <span class="cell-muted">(${pct}%)</span></div></div>`;
    }
    fHtml += '</div>';
    funnelEl.innerHTML = fHtml;
  } else if (funnelEl) {
    funnelEl.innerHTML = `<p class="admin-text-muted" style="text-align:center">Funnel data unavailable</p>`;
  }
}

async function showCampaignModal() {
  const modal = Modal.open({
    title: 'Add Campaign',
    body: `
      <div class="admin-form-group"><label>Name</label><input class="admin-input" id="camp-name" placeholder="Campaign name"></div>
      <div class="admin-form-row">
        <div class="admin-form-group"><label>Channel</label><select class="admin-select" id="camp-channel"><option>Email</option><option>Google Ads</option><option>Facebook</option><option>SEO</option><option>Direct</option><option>Other</option></select></div>
        <div class="admin-form-group"><label>Budget (NZD)</label><input class="admin-input" type="number" step="0.01" id="camp-budget"></div>
      </div>
      <div class="admin-form-row">
        <div class="admin-form-group"><label>Start Date</label><input class="admin-input" type="date" id="camp-start" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="admin-form-group"><label>End Date</label><input class="admin-input" type="date" id="camp-end"></div>
      </div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-action="save">Create</button>`,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const data = {
      name: modal.body.querySelector('#camp-name').value.trim(),
      channel: modal.body.querySelector('#camp-channel').value,
      budget: parseFloat(modal.body.querySelector('#camp-budget').value) || 0,
      start_date: modal.body.querySelector('#camp-start').value,
      end_date: modal.body.querySelector('#camp-end').value || null,
    };
    if (!data.name) { Toast.warning('Campaign name required'); return; }
    try {
      await AdminAPI.createCampaign(data);
      Toast.success('Campaign created');
      Modal.close();
      Charts.destroyAll();
      loadTab();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

// ---- Operations Tab ----
async function loadOperations(el) {
  const [turnoverRes, deadRes, velocityRes, lockupRes, perfRes] = await Promise.allSettled([
    AdminAPI.getInventoryTurnover(), AdminAPI.getDeadStock(), AdminAPI.getStockVelocity(),
    AdminAPI.getInventoryCashLockup(), AdminAPI.getProductPerformance(),
  ]);

  const turnover = turnoverRes.value;
  const dead = deadRes.value;
  const velocity = velocityRes.value;
  const lockup = lockupRes.value;
  const perf = perfRes.value;

  if (!turnover) console.warn('[Analytics] Inventory turnover data unavailable');
  if (!dead) console.warn('[Analytics] Dead stock data unavailable');
  if (!velocity) console.warn('[Analytics] Stock velocity data unavailable');
  if (!perf) console.warn('[Analytics] Product performance data unavailable');

  let html = '';

  // KPIs
  const avgTurnover = turnover?.avg_turnover ?? turnover?.average;
  const deadValue = dead?.total_value ?? dead?.value;
  const lockupVal = lockup?.total_locked ?? lockup?.value;
  const topRevenue = perf?.top_product_revenue ?? (perf?.products?.[0]?.revenue);
  html += `<div class="admin-kpi-grid">`;
  html += kpi('Avg Turnover', avgTurnover != null ? `${Number(avgTurnover).toFixed(1)}x` : null);
  html += kpi('Dead Stock Value', deadValue != null ? formatPrice(deadValue) : null);
  html += kpi('Cash Locked', lockupVal != null ? formatPrice(lockupVal) : null);
  html += kpi('Top Product Rev', topRevenue != null ? formatPrice(topRevenue) : null);
  html += `</div>`;

  // Charts
  html += `<div class="admin-grid-2 admin-mb-lg">`;
  html += `<div class="admin-card admin-card--cyan"><div class="admin-card__title">Inventory Turnover</div><div class="admin-chart-box"><canvas id="chart-turnover"></canvas></div></div>`;
  html += `<div class="admin-card admin-card--yellow"><div class="admin-card__title">Stock Velocity</div><div class="admin-chart-box"><canvas id="chart-velocity"></canvas></div></div>`;
  html += `</div>`;

  // Tables
  html += `<div class="admin-grid-2 admin-mb-lg">`;

  // Dead Stock
  html += `<div class="admin-card"><div class="admin-card__title">Dead Stock</div>`;
  const deadItems = dead?.products || dead?.data || (Array.isArray(dead) ? dead : []);
  if (deadItems.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th class="cell-right">Stock</th><th class="cell-right">Value</th><th class="cell-right">Days Stale</th></tr></thead><tbody>`;
    for (const d of deadItems.slice(0, 10)) {
      html += `<tr><td class="cell-truncate">${esc(d.name || d.sku || MISSING)}</td>`;
      html += `<td class="cell-right cell-mono">${d.stock ?? d.quantity ?? MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${d.value != null ? formatPrice(d.value) : MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${d.days_stale ?? d.days ?? MISSING}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += unavailable('No dead stock data');
  }
  html += `</div>`;

  // Product Performance
  html += `<div class="admin-card"><div class="admin-card__title">Product Performance</div>`;
  const perfItems = perf?.products || perf?.data || (Array.isArray(perf) ? perf : []);
  if (perfItems.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th class="cell-right">Revenue</th><th class="cell-right">Units</th><th class="cell-right">Margin</th></tr></thead><tbody>`;
    for (const p of perfItems.slice(0, 10)) {
      html += `<tr><td class="cell-truncate">${esc(p.name || p.sku || MISSING)}</td>`;
      html += `<td class="cell-right cell-mono">${p.revenue != null ? formatPrice(p.revenue) : MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${p.units_sold ?? p.quantity ?? MISSING}</td>`;
      html += `<td class="cell-right cell-mono">${p.margin != null ? `${Number(p.margin).toFixed(1)}%` : MISSING}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += unavailable('No performance data');
  }
  html += `</div></div>`;

  el.innerHTML = html;

  // Turnover chart
  const turnItems = turnover?.products || turnover?.data || (Array.isArray(turnover) ? turnover : []);
  if (turnItems.length) {
    const colors = Charts.getThemeColors();
    Charts.bar('chart-turnover', {
      labels: turnItems.slice(0, 12).map(t => t.name || t.sku || '?'),
      datasets: [{ label: 'Turnover', data: turnItems.slice(0, 12).map(t => t.turnover || t.rate || 0), backgroundColor: colors.cyan + 'cc', borderRadius: 4 }],
      options: { indexAxis: 'y' },
    });
  }

  // Velocity chart
  const velItems = velocity?.products || velocity?.data || (Array.isArray(velocity) ? velocity : []);
  if (velItems.length) {
    const colors = Charts.getThemeColors();
    Charts.bar('chart-velocity', {
      labels: velItems.slice(0, 12).map(v => v.name || v.sku || '?'),
      datasets: [{ label: 'Velocity', data: velItems.slice(0, 12).map(v => v.velocity || v.units_per_day || 0), backgroundColor: colors.yellow + 'cc', borderRadius: 4 }],
      options: { indexAxis: 'y' },
    });
  }
}

// ---- Alerts Tab ----
async function loadAlerts(el) {
  const [alertsRes, thresholdsRes] = await Promise.allSettled([
    AdminAPI.getAlerts('', false), AdminAPI.getAlertThresholds(),
  ]);

  const alerts = alertsRes.value;
  const thresholds = thresholdsRes.value;

  if (!alerts) console.warn('[Analytics] Alerts data unavailable');
  if (!thresholds) console.warn('[Analytics] Alert thresholds data unavailable');

  let html = '';

  // Active Alerts
  html += `<div class="admin-card admin-mb-lg">`;
  html += `<div class="admin-card__title">Active Alerts</div>`;
  const alertList = alerts?.alerts || alerts?.data || (Array.isArray(alerts) ? alerts : []);
  if (alertList.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Severity</th><th>Message</th><th>Created</th><th>Action</th></tr></thead><tbody>`;
    for (const a of alertList) {
      const sev = (a.severity || 'info').toLowerCase();
      const rowClass = sev === 'critical' ? 'admin-alert-row--critical' : sev === 'high' ? 'admin-alert-row--high' : '';
      html += `<tr class="${rowClass}">`;
      html += `<td><span class="admin-badge admin-badge--${sev === 'critical' ? 'failed' : sev === 'high' ? 'pending' : 'processing'}">${esc(a.severity || 'Info')}</span></td>`;
      html += `<td>${esc(a.message || a.description || MISSING)}</td>`;
      html += `<td class="cell-nowrap">${formatDate(a.created_at)}</td>`;
      html += `<td><button class="admin-btn admin-btn--ghost admin-btn--sm" data-ack-alert="${esc(String(a.id))}">Acknowledge</button></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += `<div class="admin-empty" style="min-height:120px"><div class="admin-empty__title">All clear</div><div class="admin-empty__text">No active alerts</div></div>`;
  }
  html += `</div>`;

  // Alert Thresholds
  html += `<div class="admin-card admin-mb-lg">`;
  html += `<div class="admin-card__title">Alert Thresholds</div>`;
  const thresholdList = thresholds?.thresholds || thresholds?.data || (Array.isArray(thresholds) ? thresholds : []);
  if (thresholdList.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Metric</th><th>Threshold</th><th>Severity</th><th>Enabled</th><th>Cooldown</th><th>Action</th></tr></thead><tbody>`;
    for (const t of thresholdList) {
      html += `<tr data-threshold-id="${esc(String(t.id))}">`;
      html += `<td>${esc(t.metric || t.name || MISSING)}</td>`;
      html += `<td><input class="admin-input" style="width:100px" type="number" step="any" value="${t.threshold ?? t.value ?? ''}" data-field="threshold"></td>`;
      html += `<td><select class="admin-select" style="width:100px" data-field="severity"><option value="low"${t.severity === 'low' ? ' selected' : ''}>Low</option><option value="medium"${t.severity === 'medium' ? ' selected' : ''}>Medium</option><option value="high"${t.severity === 'high' ? ' selected' : ''}>High</option><option value="critical"${t.severity === 'critical' ? ' selected' : ''}>Critical</option></select></td>`;
      html += `<td class="cell-center"><input type="checkbox" style="accent-color:var(--cyan)" data-field="enabled"${t.enabled !== false ? ' checked' : ''}></td>`;
      html += `<td><input class="admin-input" style="width:80px" type="number" value="${t.cooldown_minutes ?? t.cooldown ?? ''}" data-field="cooldown_minutes"></td>`;
      html += `<td><button class="admin-btn admin-btn--ghost admin-btn--sm" data-save-threshold="${esc(String(t.id))}">Save</button></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += unavailable('No alert thresholds configured');
  }
  html += `</div>`;

  el.innerHTML = html;

  // Acknowledge alert buttons
  el.querySelectorAll('[data-ack-alert]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await AdminAPI.acknowledgeAlert(btn.dataset.ackAlert);
        Toast.success('Alert acknowledged');
        btn.closest('tr')?.remove();
      } catch (e) {
        Toast.error(`Failed: ${e.message}`);
      }
    });
  });

  // Save threshold buttons
  el.querySelectorAll('[data-save-threshold]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = btn.dataset.saveThreshold;
      const data = {
        threshold: parseFloat(row.querySelector('[data-field="threshold"]').value),
        severity: row.querySelector('[data-field="severity"]').value,
        enabled: row.querySelector('[data-field="enabled"]').checked,
        cooldown_minutes: parseInt(row.querySelector('[data-field="cooldown_minutes"]').value) || 60,
      };
      try {
        await AdminAPI.updateAlertThreshold(id, data);
        Toast.success('Threshold updated');
      } catch (e) {
        Toast.error(`Failed: ${e.message}`);
      }
    });
  });
}

export default {
  title: 'Analytics',

  async init(container) {
    _container = container;
    _activeTab = 'financial';
    renderShell();
    await loadTab();
  },

  destroy() {
    Charts.destroyAll();
    _container = null;
  },

  async onFilterChange() {
    if (_container) {
      Charts.destroyAll();
      await loadTab();
    }
  },
};
