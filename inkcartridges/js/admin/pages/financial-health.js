/**
 * Financial Health Page — Cash, P&L, runway, expenses
 */
import { AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;

const pick = (obj, ...keys) => {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};
const num = (v, d = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : d;
};

let _container = null;
let _state = {};

async function load() {
  const [overview, burnRunway, forecasts, cashflow, daily, pnl, expenses] = await Promise.all([
    AdminAPI.getAdminAnalyticsOverview(30),
    AdminAPI.getAdminAnalyticsBurnRunway(),
    AdminAPI.getAdminAnalyticsForecasts(),
    AdminAPI.getAdminAnalyticsCashflow(12),
    AdminAPI.getAdminAnalyticsDailyRevenue(372),
    AdminAPI.getAdminAnalyticsPnL(90),
    AdminAPI.getAdminAnalyticsExpenses(20),
  ]);
  _state = { overview, burnRunway, forecasts, cashflow, daily, pnl, expenses };
  render();
}

function render() {
  if (!_container) return;
  Charts.destroyAll();

  const ov = _state.overview || {};
  const br = _state.burnRunway || {};
  const f = _state.forecasts || {};

  const grossMargin = num(pick(ov, 'grossMargin', 'gross_margin'));
  const prevGrossMargin = num(pick(ov, 'prevGrossMargin', 'prev_gross_margin'));
  const netProfit = num(pick(ov, 'netProfit', 'net_profit'));
  const cashBalance = num(pick(br, 'cashBalance', 'cash_balance', 'balance'));
  const monthlyBurn = num(pick(br, 'monthlyBurn', 'monthly_burn', 'burnRate'));
  const runwayMonths = pick(br, 'runwayMonths', 'runway_months', 'runway');
  const f30 = num(pick(f, 'forecast30', 'days30', 'd30'));
  const f60 = num(pick(f, 'forecast60', 'days60', 'd60'));
  const f90 = num(pick(f, 'forecast90', 'days90', 'd90'));

  const marginDelta = grossMargin - prevGrossMargin;
  const marginDeltaHtml = (_state.overview && pick(ov, 'prevGrossMargin', 'prev_gross_margin') !== undefined)
    ? `<span class="admin-kpi__delta admin-kpi__delta--${marginDelta >= 0 ? 'up' : 'down'}">${marginDelta >= 0 ? '↑' : '↓'} ${Math.abs(marginDelta).toFixed(1)} pts</span>`
    : '';

  const runwayDisplay = (runwayMonths === null || runwayMonths === undefined || !Number.isFinite(num(runwayMonths, NaN)) || num(runwayMonths) > 999)
    ? '∞'
    : num(runwayMonths).toFixed(1) + ' mo';

  const breakevenColor = netProfit >= 0 ? '#10b981' : 'var(--magenta, #C71F6E)';
  const breakevenLabel = netProfit >= 0 ? 'Profitable' : 'Below Break-Even';
  const breakevenSub = netProfit >= 0
    ? `Net profit: ${formatPrice(netProfit)} (last 30d)`
    : `Net loss: ${formatPrice(Math.abs(netProfit))} (last 30d)`;

  let runwayAlert = '';
  const r = num(runwayMonths, Infinity);
  if (Number.isFinite(r) && r < 6) {
    const critical = r < 3;
    runwayAlert = `
      <div class="admin-card admin-mb-lg" style="border-left:4px solid ${critical ? 'var(--magenta, #C71F6E)' : 'var(--yellow, #F4C430)'};padding:14px 18px">
        <strong>${critical ? 'Critical:' : 'Warning:'} Cash Runway Below Target</strong>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">${r.toFixed(1)} months runway. Target is 6+ months.</div>
      </div>`;
  }

  _container.innerHTML = `
    <div class="admin-page-header"><h1>Financial Health</h1></div>
    ${runwayAlert}

    <div class="admin-kpi-grid admin-kpi-grid--4 admin-mb-lg">
      <div class="admin-kpi">
        <div class="admin-kpi__label">Cash Balance</div>
        <div class="admin-kpi__value">${esc(formatPrice(cashBalance))}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Gross Margin (30d)</div>
        <div class="admin-kpi__value">${grossMargin.toFixed(1)}%</div>
        ${marginDeltaHtml}
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Monthly Burn</div>
        <div class="admin-kpi__value">${monthlyBurn > 0 ? esc(formatPrice(monthlyBurn)) : '$0'}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Cash Runway</div>
        <div class="admin-kpi__value">${esc(runwayDisplay)}</div>
      </div>
    </div>

    <div class="admin-grid-2 admin-mb-lg">
      <div class="admin-card">
        <div class="admin-card__title">Cash Flow <small>last 12 months</small></div>
        <div class="admin-chart-box admin-chart-box--tall"><canvas id="fh-cashflow"></canvas></div>
      </div>
      <div class="admin-card">
        <div class="admin-card__title">Revenue Forecasts</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:8px 0 16px">
          <div style="text-align:center"><div style="font-size:12px;color:var(--text-muted)">30 Days</div><div style="font-size:18px;font-weight:700;margin-top:4px">${esc(formatPrice(f30))}</div></div>
          <div style="text-align:center"><div style="font-size:12px;color:var(--text-muted)">60 Days</div><div style="font-size:18px;font-weight:700;margin-top:4px">${esc(formatPrice(f60))}</div></div>
          <div style="text-align:center"><div style="font-size:12px;color:var(--text-muted)">90 Days</div><div style="font-size:18px;font-weight:700;margin-top:4px">${esc(formatPrice(f90))}</div></div>
        </div>
        <div style="border-top:1px solid var(--border);padding-top:14px;display:flex;align-items:center;gap:12px">
          <div style="width:14px;height:14px;border-radius:50%;background:${breakevenColor}"></div>
          <div>
            <div style="font-weight:600">${esc(breakevenLabel)}</div>
            <div style="font-size:12px;color:var(--text-muted)">${esc(breakevenSub)}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title">Profit Over Time <small>gross & net per month</small></div>
      <div class="admin-chart-box admin-chart-box--tall"><canvas id="fh-profit"></canvas></div>
    </div>

    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title">Profit & Loss <small>last 90 days vs prior 90</small></div>
      <div style="overflow-x:auto">${renderPnLTable()}</div>
    </div>

    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title" style="display:flex;justify-content:space-between;align-items:center">
        <span>Recent Expenses</span>
        <button class="admin-btn admin-btn--primary admin-btn--sm" id="fh-add-expense-btn">+ Add Expense</button>
      </div>
      <div id="fh-expense-form" style="display:none;padding:14px;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
        ${renderExpenseForm()}
      </div>
      <div style="overflow-x:auto">${renderExpensesTable()}</div>
    </div>
  `;

  renderCashflowChart();
  renderProfitChart();
  bindExpenseForm();
}

function renderPnLTable() {
  const pnl = _state.pnl || {};
  const rows = [
    ['Gross Sales', pick(pnl, 'grossSales', 'gross_sales', 'revenue'), pick(pnl, 'prevGrossSales', 'prev_gross_sales')],
    ['Discounts & Returns', pick(pnl, 'discounts'), pick(pnl, 'prevDiscounts', 'prev_discounts'), true],
    ['Net Revenue', pick(pnl, 'netRevenue', 'net_revenue'), pick(pnl, 'prevNetRevenue', 'prev_net_revenue')],
    ['Cost of Goods Sold', pick(pnl, 'cogs'), pick(pnl, 'prevCogs', 'prev_cogs'), true],
    ['Shipping Costs', pick(pnl, 'shippingCosts', 'shipping'), pick(pnl, 'prevShippingCosts', 'prev_shipping'), true],
    ['Gross Profit', pick(pnl, 'grossProfit', 'gross_profit'), pick(pnl, 'prevGrossProfit', 'prev_gross_profit')],
    ['Marketing', pick(pnl, 'marketing'), pick(pnl, 'prevMarketing', 'prev_marketing'), true],
    ['Platform Fees', pick(pnl, 'platform', 'platformFees'), pick(pnl, 'prevPlatform', 'prev_platform'), true],
    ['Other Operating', pick(pnl, 'otherOperating', 'other'), pick(pnl, 'prevOtherOperating', 'prev_other'), true],
    ['Net Profit', pick(pnl, 'netProfit', 'net_profit'), pick(pnl, 'prevNetProfit', 'prev_net_profit'), false, true],
  ];

  const fmt = (v, neg) => {
    const n = num(v);
    return (neg && n > 0 ? '-' : '') + formatPrice(Math.abs(n));
  };
  const change = (cur, prev) => {
    const c = num(cur), p = num(prev);
    if (!p) return c > 0 ? '+∞' : '0%';
    const pct = ((c - p) / Math.abs(p)) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  };

  let html = `<table class="admin-table" style="margin:0;width:100%">
    <thead><tr><th>Line</th><th style="text-align:right">Current</th><th style="text-align:right">Previous</th><th style="text-align:right">Change</th></tr></thead><tbody>`;
  for (const [label, cur, prev, neg, bold] of rows) {
    const style = bold ? 'font-weight:700;border-top:2px solid var(--border)' : '';
    const negClass = neg ? 'style="color:var(--magenta, #C71F6E);"' : '';
    html += `<tr style="${style}">
      <td>${esc(label)}</td>
      <td style="text-align:right" ${negClass}>${esc(fmt(cur, neg))}</td>
      <td style="text-align:right" ${negClass}>${esc(fmt(prev, neg))}</td>
      <td style="text-align:right">${esc(change(cur, prev))}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function renderExpenseForm() {
  return `
    <form id="fh-expense-form-el" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
      <select class="admin-input" id="fh-exp-category" required>
        <option value="">Category…</option>
        <option value="cogs">Cost of Goods Sold</option>
        <option value="shipping">Shipping</option>
        <option value="marketing">Marketing</option>
        <option value="platform">Platform Fees</option>
        <option value="rent">Rent & Utilities</option>
        <option value="salaries">Salaries</option>
        <option value="software">Software</option>
        <option value="other">Other</option>
      </select>
      <input class="admin-input" type="number" step="0.01" min="0" id="fh-exp-amount" placeholder="Amount (NZD)" required>
      <input class="admin-input" type="date" id="fh-exp-date" required>
      <input class="admin-input" type="text" id="fh-exp-vendor" placeholder="Vendor / description">
      <div style="grid-column:span 4;display:flex;gap:8px;justify-content:flex-end">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="fh-exp-cancel">Cancel</button>
        <button type="submit" class="admin-btn admin-btn--primary admin-btn--sm">Save Expense</button>
      </div>
    </form>
  `;
}

function renderExpensesTable() {
  const data = _state.expenses;
  const rows = Array.isArray(data) ? data : (data?.expenses || []);
  if (!rows.length) {
    return '<div style="padding:24px;text-align:center;color:var(--text-muted)">No expenses recorded yet.</div>';
  }
  let html = '<table class="admin-table" style="margin:0;width:100%"><thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th style="text-align:right">Amount</th></tr></thead><tbody>';
  for (const r of rows) {
    const date = pick(r, 'date', 'expense_date', 'created_at') || '';
    const dateStr = date ? new Date(date).toLocaleDateString('en-NZ') : '';
    const cat = pick(r, 'category', 'category_name') || '';
    const vendor = pick(r, 'vendor', 'description') || '';
    const amount = num(pick(r, 'amount', 'total'));
    html += `<tr><td>${esc(dateStr)}</td><td>${esc(cat)}</td><td>${esc(vendor)}</td><td style="text-align:right;color:var(--magenta, #C71F6E)">-${esc(formatPrice(amount))}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

async function renderCashflowChart() {
  const data = _state.cashflow;
  const series = Array.isArray(data) ? data : (data?.months || data?.series || []);
  if (!series.length) return;

  const labels = [], inflows = [], outflows = [], net = [];
  for (const row of series.slice(-12)) {
    const label = pick(row, 'monthLabel', 'label', 'month', 'period');
    const d = label ? new Date(label) : null;
    labels.push(d && !isNaN(d) ? d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }) : (label || ''));
    const inflow = num(pick(row, 'inflow', 'inflows', 'revenue'));
    const outflow = num(pick(row, 'outflow', 'outflows', 'expenses'));
    inflows.push(inflow);
    outflows.push(-Math.abs(outflow));
    net.push(num(pick(row, 'net', 'netFlow', 'net_cashflow'), inflow - outflow));
  }

  const colors = Charts.getThemeColors();
  await Charts.bar('fh-cashflow', {
    labels,
    datasets: [
      { label: 'Inflows', data: inflows, backgroundColor: colors.success, borderRadius: 4 },
      { label: 'Outflows', data: outflows, backgroundColor: colors.magenta, borderRadius: 4 },
      { label: 'Net', data: net, type: 'line', borderColor: colors.cyan, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3 },
    ],
    options: { plugins: { legend: { display: true, position: 'top' } } },
  });
}

async function renderProfitChart() {
  const daily = _state.daily;
  const rows = Array.isArray(daily) ? daily : (daily?.days || daily?.series || []);
  const grossMarginPct = num(pick(_state.overview || {}, 'grossMargin', 'gross_margin')) / 100;
  const monthlyExpenses = num(pick(_state.burnRunway || {}, 'monthlyExpenses', 'monthly_expenses'));

  const months = 12;
  const buckets = new Map();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    buckets.set(key, { label: d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }), revenue: 0 });
  }
  for (const r of rows) {
    const dateStr = pick(r, 'date', 'day', 'period');
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d)) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const b = buckets.get(key);
    if (b) b.revenue += num(pick(r, 'revenue', 'total', 'sales'));
  }

  const labels = [], gross = [], net = [];
  for (const b of buckets.values()) {
    labels.push(b.label);
    const g = b.revenue * grossMarginPct;
    gross.push(parseFloat(g.toFixed(2)));
    net.push(parseFloat((g - monthlyExpenses).toFixed(2)));
  }

  const colors = Charts.getThemeColors();
  await Charts.line('fh-profit', {
    labels,
    datasets: [
      { label: 'Gross Profit', data: gross, borderColor: colors.success, backgroundColor: colors.success + '22', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3 },
      { label: 'Net Profit', data: net, borderColor: colors.cyan, backgroundColor: colors.cyan + '22', borderWidth: 2, fill: true, tension: 0.3, pointRadius: 3 },
    ],
    options: {
      plugins: {
        legend: { display: true, position: 'top' },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}` } },
      },
    },
  });
}

function bindExpenseForm() {
  const addBtn = _container.querySelector('#fh-add-expense-btn');
  const formWrap = _container.querySelector('#fh-expense-form');
  const cancelBtn = _container.querySelector('#fh-exp-cancel');
  const formEl = _container.querySelector('#fh-expense-form-el');
  const dateInput = _container.querySelector('#fh-exp-date');

  addBtn?.addEventListener('click', () => {
    formWrap.style.display = 'block';
    if (dateInput && !dateInput.value) dateInput.valueAsDate = new Date();
  });
  cancelBtn?.addEventListener('click', () => {
    formWrap.style.display = 'none';
    formEl?.reset();
  });
  formEl?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      category: _container.querySelector('#fh-exp-category').value,
      amount: parseFloat(_container.querySelector('#fh-exp-amount').value),
      date: _container.querySelector('#fh-exp-date').value,
      vendor: _container.querySelector('#fh-exp-vendor').value,
    };
    try {
      await AdminAPI.addAdminAnalyticsExpense(payload);
      formWrap.style.display = 'none';
      formEl.reset();
      await load();
    } catch (err) {
      alert('Failed to save expense: ' + (err.message || 'Please try again.'));
    }
  });
}

export default {
  title: 'Financial Health',

  async init(container) {
    _container = container;
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:40vh"><div class="admin-loading__spinner"></div></div>`;
    try {
      await load();
    } catch (e) {
      container.innerHTML = `<div class="admin-stub"><div class="admin-stub__title">Failed to load Financial Health</div><div class="admin-stub__text">${esc(e.message || 'Unknown error')}</div></div>`;
    }
  },

  destroy() {
    Charts.destroyAll();
    _container = null;
    _state = {};
  },
};
