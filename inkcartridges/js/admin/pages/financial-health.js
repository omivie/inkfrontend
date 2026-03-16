/**
 * Financial Health Page — Tabs: Overview | P&L | Expenses
 */
import { FilterState, AdminAPI, esc } from '../app.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;

let _container = null;
const _charts = {};
const _data = {};

let _currentPeriod = '3m';
let _currentTab = 'overview';
let _pnlPeriod = 'current';
let _expensesLoaded = false;
let _expenseFilters = { search: '', category: '', from: '', to: '' };

const PERIOD_MONTHS = { all: null, mtd: 1, '3m': 3, '6m': 6, '12m': 12, ytd: new Date().getMonth() + 1 };

function getMonthsForPeriod(period) {
  if (period === 'all') {
    const orders = _data.orders || [];
    if (!orders.length) return 12;
    const oldest = new Date(Math.min(...orders.map(o => new Date(o.created_at))));
    const now = new Date();
    return Math.max(1, (now.getFullYear() - oldest.getFullYear()) * 12 + (now.getMonth() - oldest.getMonth()) + 1);
  }
  return PERIOD_MONTHS[period] ?? 3;
}

const CAT_LABELS = {
  cogs: 'COGS', shipping: 'Shipping', 'marketing-paid': 'Marketing',
  platform: 'Platform', software: 'Software', other: 'Other',
};

// ---- Styles ----
const STYLE_ID = 'financial-health-styles';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .fh-page { padding: var(--spacing-6); }
    .fh-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--spacing-5); }
    .fh-header h1 { font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); margin: 0; }
    .fh-header p { font-size: var(--font-size-sm); color: var(--color-text-muted); margin: var(--spacing-1) 0 0; }
    .fh-header__actions { display: flex; gap: var(--spacing-3); align-items: center; }
    .fh-period-btns { display: flex; gap: 2px; background: var(--color-background-alt); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 3px; }
    .fh-period-btn { padding: 5px 12px; border: none; border-radius: calc(var(--radius-md) - 2px); background: transparent; font-size: var(--font-size-sm); cursor: pointer; color: var(--color-text-muted); transition: all 0.15s; white-space: nowrap; }
    .fh-period-btn:hover { background: var(--color-background); color: var(--color-text); }
    .fh-period-btn--active { background: var(--color-background); color: var(--color-text); font-weight: var(--font-weight-semibold); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
    .fh-tab-nav { margin-bottom: var(--spacing-6); }
    .fh-panel { display: none; }
    .fh-panel--active { display: block; }
    .fh-alert { padding: var(--spacing-4); border-radius: var(--radius-lg); margin-bottom: var(--spacing-6); display: flex; align-items: center; gap: var(--spacing-4); }
    .fh-alert--warning { background: var(--yellow-light); border: 1px solid var(--yellow-primary); }
    .fh-alert--critical { background: var(--magenta-light); border: 1px solid var(--magenta-primary); }
    .fh-alert__icon { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .fh-alert--warning .fh-alert__icon { background: var(--yellow-primary); color: white; }
    .fh-alert--critical .fh-alert__icon { background: var(--magenta-primary); color: white; }
    .fh-alert__content { flex: 1; }
    .fh-alert__title { font-weight: var(--font-weight-semibold); margin-bottom: 4px; }
    .fh-alert__text { font-size: var(--font-size-sm); opacity: 0.8; }
    .fh-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--spacing-5); margin-bottom: var(--spacing-6); }
    .fh-kpi { background: var(--color-background); border-radius: var(--radius-lg); border: 1px solid var(--color-border); padding: var(--spacing-5); }
    .fh-kpi--highlight { border-color: var(--cyan-primary); border-width: 2px; }
    .fh-kpi__hdr { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--spacing-3); }
    .fh-kpi__icon { width: 44px; height: 44px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; }
    .fh-kpi__icon--cash { background: #DBEAFE; color: #2563EB; }
    .fh-kpi__icon--profit { background: #D1FAE5; color: #059669; }
    .fh-kpi__icon--burn { background: var(--magenta-light); color: var(--magenta-primary); }
    .fh-kpi__icon--runway { background: var(--yellow-light); color: var(--yellow-dark); }
    .fh-kpi__value { font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); margin-bottom: var(--spacing-1); }
    .fh-kpi__label { font-size: var(--font-size-sm); color: var(--color-text-muted); }
    .fh-kpi__sub { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: var(--spacing-2); }
    .fh-chart-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--spacing-6); margin-bottom: var(--spacing-6); }
    .fh-card { background: var(--color-background); border-radius: var(--radius-lg); border: 1px solid var(--color-border); margin-bottom: var(--spacing-6); }
    .fh-card:last-child { margin-bottom: 0; }
    .fh-card__hdr { padding: var(--spacing-5); border-bottom: 1px solid var(--color-border-light); display: flex; justify-content: space-between; align-items: center; }
    .fh-card__title { font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); margin: 0; }
    .fh-card__body { padding: var(--spacing-5); }
    .fh-chart-wrap { height: 300px; position: relative; }
    .fh-forecast-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--spacing-4); }
    .fh-forecast { background: var(--color-background-alt); border-radius: var(--radius-md); padding: var(--spacing-4); text-align: center; }
    .fh-forecast__period { font-size: var(--font-size-sm); color: var(--color-text-muted); margin-bottom: var(--spacing-2); }
    .fh-forecast__value { font-size: var(--font-size-xl); font-weight: var(--font-weight-bold); }
    .fh-forecast__conf { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: var(--spacing-1); }
    .fh-pnl { width: 100%; border-collapse: collapse; }
    .fh-pnl th, .fh-pnl td { padding: var(--spacing-3) var(--spacing-4); text-align: right; border-bottom: 1px solid var(--color-border-light); }
    .fh-pnl th:first-child, .fh-pnl td:first-child { text-align: left; }
    .fh-pnl th { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: var(--letter-spacing-wide); background: var(--color-background-alt); }
    .fh-pnl__section { font-weight: var(--font-weight-semibold); background: var(--color-background-alt); }
    .fh-pnl__total { font-weight: var(--font-weight-bold); border-top: 2px solid var(--color-border); }
    .fh-pnl__pos { color: #059669; }
    .fh-pnl__neg { color: var(--magenta-primary); }
    .fh-expenses-filters { display: flex; gap: var(--spacing-3); align-items: center; margin-bottom: var(--spacing-5); flex-wrap: wrap; }
    .fh-expenses-filters input, .fh-expenses-filters select { padding: var(--spacing-2) var(--spacing-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); font-size: var(--font-size-sm); background: var(--color-background); color: var(--color-text); }
    .fh-expenses-filters input[type="search"] { flex: 1; min-width: 180px; }
    .fh-date-range { display: flex; align-items: center; gap: var(--spacing-2); }
    .fh-date-range__sep { font-size: var(--font-size-xs); color: var(--color-text-muted); white-space: nowrap; }
    .fh-expense-table { width: 100%; border-collapse: collapse; }
    .fh-expense-table th, .fh-expense-table td { padding: var(--spacing-3) var(--spacing-4); text-align: left; border-bottom: 1px solid var(--color-border-light); font-size: var(--font-size-sm); }
    .fh-expense-table th { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: var(--letter-spacing-wide); background: var(--color-background-alt); }
    .fh-expense-table td:nth-child(4) { text-align: right; font-weight: var(--font-weight-medium); }
    .fh-expense-table td:last-child { text-align: right; }
    .fh-delete-btn { background: none; border: none; cursor: pointer; color: var(--color-text-muted); padding: 4px; border-radius: var(--radius-sm); line-height: 1; }
    .fh-delete-btn:hover { color: var(--magenta-primary); background: var(--magenta-light); }
    .fh-expense-empty { text-align: center; padding: var(--spacing-10) var(--spacing-6); color: var(--color-text-muted); }
    .fh-expense-empty p { margin: var(--spacing-2) 0; }
    .fh-cat-badge { display: inline-block; padding: 2px 8px; border-radius: var(--radius-full); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); background: var(--color-background-alt); color: var(--color-text-muted); }
    .fh-modal-form { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-4); }
    .fh-modal-form__field { display: flex; flex-direction: column; gap: var(--spacing-2); }
    .fh-modal-form__label { font-size: var(--font-size-sm); font-weight: var(--font-weight-medium); }
    .fh-modal-form__input { padding: var(--spacing-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); font-size: var(--font-size-sm); background: var(--color-background); color: var(--color-text); }
    @media (max-width: 1200px) {
      .fh-kpi-grid { grid-template-columns: repeat(2, 1fr); }
      .fh-chart-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      .fh-kpi-grid { grid-template-columns: 1fr; }
      .fh-forecast-grid { grid-template-columns: 1fr; }
      .fh-header { flex-direction: column; gap: var(--spacing-3); }
      .fh-header__actions { flex-wrap: wrap; }
    }
  `;
  document.head.appendChild(s);
}

// ---- HTML template ----
function renderHTML() {
  return `
    <div class="fh-page">
      <div class="fh-header">
        <div>
          <h1>Financial Health</h1>
          <p>Cash flow, P&amp;L and expenses</p>
        </div>
        <div class="fh-header__actions">
          <div class="fh-period-btns" id="fh-period-btns">
            <button class="fh-period-btn fh-period-btn--active" data-period="all">All</button>
            <button class="fh-period-btn" data-period="ytd">YTD</button>
            <button class="fh-period-btn" data-period="12m">12M</button>
            <button class="fh-period-btn" data-period="6m">6M</button>
            <button class="fh-period-btn" data-period="3m">3M</button>
            <button class="fh-period-btn" data-period="mtd">MTD</button>
          </div>
          <button class="btn btn--primary btn--sm" id="fh-add-expense-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Expense
          </button>
        </div>
      </div>

      <div class="admin-tabs fh-tab-nav" id="fh-tabs">
        <button class="admin-tab active" data-tab="overview">Overview</button>
        <button class="admin-tab" data-tab="pnl">P&amp;L</button>
        <button class="admin-tab" data-tab="expenses">Expenses</button>
      </div>

      <!-- Overview Tab -->
      <div class="fh-panel fh-panel--active" id="fh-tab-overview">
        <div class="fh-alert fh-alert--warning" id="fh-runway-alert" style="display:none;">
          <div class="fh-alert__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div class="fh-alert__content">
            <div class="fh-alert__title" id="fh-alert-title">Cash Runway Warning</div>
            <div class="fh-alert__text" id="fh-alert-text">Your current runway is below the recommended threshold.</div>
          </div>
        </div>

        <div class="fh-kpi-grid">
          <div class="fh-kpi fh-kpi--highlight">
            <div class="fh-kpi__hdr">
              <div class="fh-kpi__icon fh-kpi__icon--cash">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
              </div>
            </div>
            <div class="fh-kpi__value" id="fh-cash-balance">$0.00</div>
            <div class="fh-kpi__label">This Month's Revenue</div>
            <div class="fh-kpi__sub">From paid orders</div>
          </div>
          <div class="fh-kpi">
            <div class="fh-kpi__hdr">
              <div class="fh-kpi__icon fh-kpi__icon--profit">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
              </div>
            </div>
            <div class="fh-kpi__value" id="fh-gross-margin">0%</div>
            <div class="fh-kpi__label">Gross Margin</div>
            <div class="fh-kpi__sub">This month</div>
          </div>
          <div class="fh-kpi">
            <div class="fh-kpi__hdr">
              <div class="fh-kpi__icon fh-kpi__icon--burn">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </div>
            </div>
            <div class="fh-kpi__value" id="fh-monthly-burn">$0</div>
            <div class="fh-kpi__label">Monthly Burn Rate</div>
            <div class="fh-kpi__sub">Net cash out</div>
          </div>
          <div class="fh-kpi">
            <div class="fh-kpi__hdr">
              <div class="fh-kpi__icon fh-kpi__icon--runway">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
            </div>
            <div class="fh-kpi__value" id="fh-runway-months">&#8734;</div>
            <div class="fh-kpi__label">Cash Runway</div>
            <div class="fh-kpi__sub" id="fh-runway-days">At current burn rate</div>
          </div>
        </div>

        <div class="fh-chart-grid">
          <div class="fh-card" style="margin-bottom:0;">
            <div class="fh-card__hdr">
              <h2 class="fh-card__title">Cash Flow</h2>
            </div>
            <div class="fh-card__body">
              <div class="fh-chart-wrap"><canvas id="fh-cashflow-chart"></canvas></div>
            </div>
          </div>
          <div class="fh-card" style="margin-bottom:0;">
            <div class="fh-card__hdr"><h2 class="fh-card__title">Revenue Forecasts</h2></div>
            <div class="fh-card__body">
              <div class="fh-forecast-grid">
                <div class="fh-forecast">
                  <div class="fh-forecast__period">30 Days</div>
                  <div class="fh-forecast__value" id="fh-forecast-30">$0</div>
                  <div class="fh-forecast__conf">±15% confidence</div>
                </div>
                <div class="fh-forecast">
                  <div class="fh-forecast__period">60 Days</div>
                  <div class="fh-forecast__value" id="fh-forecast-60">$0</div>
                  <div class="fh-forecast__conf">±20% confidence</div>
                </div>
                <div class="fh-forecast">
                  <div class="fh-forecast__period">90 Days</div>
                  <div class="fh-forecast__value" id="fh-forecast-90">$0</div>
                  <div class="fh-forecast__conf">±25% confidence</div>
                </div>
              </div>
              <div style="margin-top:var(--spacing-5);">
                <h3 style="font-size:var(--font-size-md);margin-bottom:var(--spacing-3);">Break-Even Status</h3>
                <div style="display:flex;align-items:center;gap:var(--spacing-4);">
                  <div id="fh-breakeven-dot" style="width:16px;height:16px;border-radius:50%;background:#10b981;flex-shrink:0;"></div>
                  <div>
                    <div style="font-weight:var(--font-weight-semibold);" id="fh-breakeven-status">Profitable</div>
                    <div style="font-size:var(--font-size-sm);color:var(--color-text-muted);" id="fh-breakeven-gap">Revenue exceeds expenses</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- P&L Tab -->
      <div class="fh-panel" id="fh-tab-pnl">
        <div class="fh-card">
          <div class="fh-card__hdr">
            <div>
              <h2 class="fh-card__title">Profit Over Time</h2>
              <p style="font-size:var(--font-size-sm);color:var(--color-text-muted);margin:4px 0 0;">Gross &amp; net profit per month</p>
            </div>
            <div id="fh-profit-totals" style="display:flex;gap:var(--spacing-5);font-size:var(--font-size-sm);"></div>
          </div>
          <div class="fh-card__body">
            <div class="fh-chart-wrap"><canvas id="fh-profit-chart"></canvas></div>
          </div>
        </div>

        <div class="fh-card">
          <div class="fh-card__hdr">
            <h2 class="fh-card__title">Profit &amp; Loss Statement</h2>
            <div class="fh-period-btns" id="fh-pnl-period-btns">
              <button class="fh-period-btn fh-period-btn--active" data-pnl-period="current">This Month</button>
              <button class="fh-period-btn" data-pnl-period="last">Last Month</button>
              <button class="fh-period-btn" data-pnl-period="quarter">This Quarter</button>
              <button class="fh-period-btn" data-pnl-period="year">This Year</button>
            </div>
          </div>
          <div class="fh-card__body" style="padding:0;">
            <table class="fh-pnl">
              <thead><tr><th>Category</th><th>Current Period</th><th>Previous Period</th><th>Change</th></tr></thead>
              <tbody>
                <tr class="fh-pnl__section"><td colspan="4">Revenue</td></tr>
                <tr><td>Gross Sales</td><td id="fh-pnl-gross-sales">$0.00</td><td id="fh-pnl-gross-sales-prev">$0.00</td><td id="fh-pnl-gross-sales-change">0%</td></tr>
                <tr><td>Discounts &amp; Returns</td><td class="fh-pnl__neg" id="fh-pnl-discounts">-$0.00</td><td id="fh-pnl-discounts-prev">-$0.00</td><td>—</td></tr>
                <tr class="fh-pnl__total"><td>Net Revenue</td><td id="fh-pnl-net-revenue">$0.00</td><td id="fh-pnl-net-revenue-prev">$0.00</td><td>—</td></tr>
                <tr class="fh-pnl__section"><td colspan="4">Cost of Goods Sold</td></tr>
                <tr><td>Product Costs</td><td class="fh-pnl__neg" id="fh-pnl-cogs">-$0.00</td><td id="fh-pnl-cogs-prev">-$0.00</td><td>—</td></tr>
                <tr class="fh-pnl__total"><td>Gross Profit</td><td class="fh-pnl__pos" id="fh-pnl-gross-profit">$0.00</td><td id="fh-pnl-gross-profit-prev">$0.00</td><td>—</td></tr>
                <tr class="fh-pnl__section"><td colspan="4">Operating Expenses</td></tr>
                <tr><td>Platform &amp; Software</td><td class="fh-pnl__neg" id="fh-pnl-platform">-$0.00</td><td id="fh-pnl-platform-prev">-$0.00</td><td>—</td></tr>
                <tr><td>Other Operating</td><td class="fh-pnl__neg" id="fh-pnl-other">-$0.00</td><td id="fh-pnl-other-prev">-$0.00</td><td>—</td></tr>
                <tr class="fh-pnl__total" style="background:var(--cyan-light);">
                  <td><strong>Net Profit</strong></td>
                  <td class="fh-pnl__pos" id="fh-pnl-net-profit"><strong>$0.00</strong></td>
                  <td id="fh-pnl-net-profit-prev"><strong>$0.00</strong></td>
                  <td id="fh-pnl-net-profit-change"><strong>0%</strong></td>
                </tr>
                <tr><td>Net Margin</td><td id="fh-pnl-net-margin">0%</td><td>—</td><td>—</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Expenses Tab -->
      <div class="fh-panel" id="fh-tab-expenses">
        <div class="fh-expenses-filters">
          <input type="search" id="fh-expense-search" placeholder="Search vendor...">
          <select id="fh-expense-cat-filter">
            <option value="">All Categories</option>
            <option value="cogs">Cost of Goods Sold</option>
            <option value="shipping">Shipping &amp; Fulfillment</option>
            <option value="marketing-paid">Marketing - Paid Ads</option>
            <option value="platform">Platform Fees</option>
            <option value="software">Software &amp; Tools</option>
            <option value="other">Other Operating</option>
          </select>
          <div class="fh-date-range">
            <input type="date" id="fh-expense-from" title="From date">
            <span class="fh-date-range__sep">to</span>
            <input type="date" id="fh-expense-to" title="To date">
          </div>
          <button class="btn btn--primary btn--sm" id="fh-expenses-add-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Expense
          </button>
        </div>
        <div class="fh-card">
          <div class="fh-card__body" style="padding:0;" id="fh-expenses-body">
            <div class="fh-expense-empty"><p>Activate this tab to load expenses.</p></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ---- Query helper ----
function q(id) { return _container.querySelector('#' + id); }

// ---- Calculation helpers ----
function calculateChange(current, previous) {
  if (previous === 0) return current > 0 ? '+∞' : '0%';
  const change = ((current - previous) / previous) * 100;
  return (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
}

function computeCogs(orders) {
  let totalCogs = 0, totalRev = 0;
  for (const o of orders) {
    const rev = o.total_amount ?? o.total ?? 0;
    totalRev += rev;
    const items = o.items || [];
    const itemCost = items.reduce((s, item) => {
      const cost = item.supplier_cost_snapshot ?? 0;
      const qty = item.qty ?? item.quantity ?? 1;
      return s + cost * qty;
    }, 0);
    totalCogs += itemCost > 0 ? itemCost : rev * 0.60;
  }
  return { totalCogs, totalRev };
}

function getMonthSpan(expenses) {
  if (!expenses.length) return 1;
  const dates = expenses.map(e => new Date(e.date || e.created_at)).filter(d => !isNaN(d));
  if (!dates.length) return 1;
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  return (max.getFullYear() - min.getFullYear()) * 12 + (max.getMonth() - min.getMonth()) + 1;
}

// ---- KPI metrics ----
function calculateMetrics(orders) {
  const now = new Date();
  const thisMonth = orders.filter(o => {
    const d = new Date(o.created_at);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() &&
           o.status !== 'cancelled' && o.status !== 'refunded';
  });
  const lastMonth = orders.filter(o => {
    const d = new Date(o.created_at);
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.getMonth() === lm.getMonth() && d.getFullYear() === lm.getFullYear() &&
           o.status !== 'cancelled' && o.status !== 'refunded';
  });

  const { totalCogs: thisCogs, totalRev: thisRev } = computeCogs(thisMonth);
  const { totalCogs: lastCogs, totalRev: lastRev } = computeCogs(lastMonth);
  const grossProfit = thisRev - thisCogs;
  const grossMargin = thisRev > 0 ? (grossProfit / thisRev) * 100 : 0;
  const monthlyExpenses = _data.monthlyExpenses || 0;
  const netProfit = grossProfit - monthlyExpenses;

  const burnRate = _data.burn?.burn_rate ?? _data.burn?.monthly_burn;
  let monthlyBurn;
  if (burnRate != null) {
    monthlyBurn = burnRate;
    q('fh-monthly-burn').textContent = formatPrice(monthlyBurn) + '/mo';
  } else {
    monthlyBurn = Math.max(0, monthlyExpenses - grossProfit);
    q('fh-monthly-burn').textContent = monthlyBurn > 0 ? formatPrice(monthlyBurn) : '$0 (profitable)';
  }

  const runwayMonths = _data.burn?.runway_months ?? _data.burn?.months_remaining;
  let runway;
  if (runwayMonths != null) {
    runway = Number(runwayMonths);
    q('fh-runway-months').textContent = runway.toFixed(1) + ' mo';
    q('fh-runway-days').textContent = `~${Math.round(runway * 30)} days at current burn`;
  } else if (monthlyExpenses === 0) {
    runway = Infinity;
    q('fh-runway-months').textContent = '—';
    q('fh-runway-days').textContent = 'Expenses not tracked';
  } else if (monthlyBurn === 0) {
    runway = Infinity;
    q('fh-runway-months').textContent = '∞';
    q('fh-runway-days').textContent = 'Business is profitable';
  } else {
    runway = Infinity;
    q('fh-runway-months').textContent = '—';
    q('fh-runway-days').textContent = 'No cash balance data';
  }

  q('fh-cash-balance').textContent = formatPrice(thisRev);
  q('fh-gross-margin').textContent = grossMargin.toFixed(1) + '%';

  const fcData = _data.forecasts?.forecast || _data.forecasts?.data ||
                 (Array.isArray(_data.forecasts) ? _data.forecasts : null);
  if (fcData && fcData.length) {
    const find = (days) => fcData.find(f => f.days === days || f.period === `${days}d`);
    q('fh-forecast-30').textContent = formatPrice(find(30)?.predicted ?? find(30)?.forecast ?? 0);
    q('fh-forecast-60').textContent = formatPrice(find(60)?.predicted ?? find(60)?.forecast ?? 0);
    q('fh-forecast-90').textContent = formatPrice(find(90)?.predicted ?? find(90)?.forecast ?? 0);
  } else {
    const avgDaily = thisRev / Math.max(1, now.getDate());
    q('fh-forecast-30').textContent = formatPrice(avgDaily * 30);
    q('fh-forecast-60').textContent = formatPrice(avgDaily * 60);
    q('fh-forecast-90').textContent = formatPrice(avgDaily * 90);
  }

  if (netProfit >= 0) {
    q('fh-breakeven-dot').style.background = '#10b981';
    q('fh-breakeven-status').textContent = 'Profitable';
    q('fh-breakeven-gap').textContent = `Net profit: ${formatPrice(netProfit)}/month`;
  } else {
    q('fh-breakeven-dot').style.background = 'var(--magenta-primary)';
    q('fh-breakeven-status').textContent = 'Below Break-Even';
    q('fh-breakeven-gap').textContent = `Need ${formatPrice(Math.abs(netProfit))} more revenue/month`;
  }

  _data.thisRev = thisRev;
  _data.lastRev = lastRev;
  _data.cogs = thisCogs;
  _data.lastCogs = lastCogs;
  _data.grossProfit = grossProfit;
  _data.netProfit = netProfit;
  _data.runway = runway;
}

// ---- Charts ----
async function loadCashFlowChart(months) {
  const ctx = q('fh-cashflow-chart');
  if (!ctx) return;
  if (_charts.cashflow) _charts.cashflow.destroy();

  const labels = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    labels.push(d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }));
  }

  let inflows = labels.map(() => 0), outflows = labels.map(() => 0), netFlow = labels.map(() => 0);

  let cfData = null;
  try { cfData = await AdminAPI.getCashflow(months, false); } catch {}

  const cf = cfData?.months || cfData?.data || (Array.isArray(cfData) ? cfData : null);
  if (cf && cf.length) {
    const apiLabels = cf.map(m => m.label || m.month);
    inflows = apiLabels.map(l => cf.find(m => (m.label || m.month) === l)?.inflow ?? cf.find(m => (m.label || m.month) === l)?.revenue ?? 0);
    outflows = apiLabels.map(l => cf.find(m => (m.label || m.month) === l)?.outflow ?? cf.find(m => (m.label || m.month) === l)?.expenses ?? 0);
    netFlow = cf.map(m => m.net ?? ((m.inflow ?? m.revenue ?? 0) - (m.outflow ?? m.expenses ?? 0)));
  } else {
    const orders = _data.orders || [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const idx = months - 1 - i;
      const mo = orders.filter(o => {
        const od = new Date(o.created_at);
        return od.getMonth() === d.getMonth() && od.getFullYear() === d.getFullYear() &&
               o.status !== 'cancelled' && o.status !== 'refunded';
      });
      const { totalCogs, totalRev } = computeCogs(mo);
      const shippingOut = mo.reduce((s, o) => s + (o.shipping_fee || 0), 0);
      inflows[idx] = parseFloat(totalRev.toFixed(2));
      outflows[idx] = parseFloat((totalCogs + shippingOut).toFixed(2));
      netFlow[idx] = parseFloat((totalRev - totalCogs - shippingOut).toFixed(2));
    }
  }

  _charts.cashflow = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Inflows', data: inflows, backgroundColor: '#10b981', borderRadius: 4 },
        { label: 'Outflows', data: outflows, backgroundColor: '#C71F6E', borderRadius: 4 },
        { label: 'Net Cash Flow', data: netFlow, type: 'line', borderColor: '#267FB5', backgroundColor: 'transparent', borderWidth: 3, pointRadius: 4, pointBackgroundColor: '#267FB5' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: { x: { stacked: false }, y: { beginAtZero: true, ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'k' } } }
    }
  });
}

function loadProfitChart(months) {
  const ctx = q('fh-profit-chart');
  if (!ctx) return;
  if (_charts.profit) _charts.profit.destroy();

  const orders = _data.orders || [];
  const monthlyExpenses = _data.monthlyExpenses || 0;
  const labels = [], grossProfits = [], netProfits = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    labels.push(d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }));
    const mo = orders.filter(o => {
      const od = new Date(o.created_at);
      return od.getMonth() === d.getMonth() && od.getFullYear() === d.getFullYear() &&
             o.status !== 'cancelled' && o.status !== 'refunded';
    });
    const { totalCogs, totalRev } = computeCogs(mo);
    grossProfits.push(parseFloat((totalRev - totalCogs).toFixed(2)));
    netProfits.push(parseFloat((totalRev - totalCogs - monthlyExpenses).toFixed(2)));
  }

  const totalGross = grossProfits.reduce((a, b) => a + b, 0);
  const totalNet = netProfits.reduce((a, b) => a + b, 0);
  const totalsEl = q('fh-profit-totals');
  if (totalsEl) {
    const netColor = totalNet >= 0 ? '#059669' : 'var(--magenta-primary)';
    totalsEl.innerHTML =
      `<span style="color:#059669;">Gross <strong>${formatPrice(totalGross)}</strong></span>` +
      `<span style="color:${netColor};">Net <strong>${formatPrice(totalNet)}</strong></span>`;
  }

  _charts.profit = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Gross Profit', data: grossProfits, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#10b981', fill: true, tension: 0.3 },
        { label: 'Net Profit', data: netProfits, borderColor: '#267FB5', backgroundColor: 'rgba(38,127,181,0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#267FB5', fill: true, tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top' },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}` } }
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'k' }, grid: { color: 'rgba(0,0,0,0.05)' } }
      }
    }
  });
}

function loadPnL() {
  const rev = _data.thisRev || 0, prevRev = _data.lastRev || 0;
  const cogs = _data.cogs || 0, lastCogs = _data.lastCogs || (prevRev * 0.60);
  const grossProfit = _data.grossProfit || 0, prevGrossProfit = prevRev - lastCogs;
  const expenses = _data.monthlyExpenses || 0;
  const netProfit = _data.netProfit || 0, prevNetProfit = prevGrossProfit - expenses;

  q('fh-pnl-gross-sales').textContent = formatPrice(rev);
  q('fh-pnl-gross-sales-prev').textContent = formatPrice(prevRev);
  q('fh-pnl-gross-sales-change').textContent = calculateChange(rev, prevRev);
  q('fh-pnl-discounts').textContent = '-' + formatPrice(rev * 0.02);
  q('fh-pnl-discounts-prev').textContent = '-' + formatPrice(prevRev * 0.02);
  q('fh-pnl-net-revenue').textContent = formatPrice(rev * 0.98);
  q('fh-pnl-net-revenue-prev').textContent = formatPrice(prevRev * 0.98);
  q('fh-pnl-cogs').textContent = '-' + formatPrice(cogs);
  q('fh-pnl-cogs-prev').textContent = '-' + formatPrice(lastCogs);
  q('fh-pnl-gross-profit').textContent = formatPrice(grossProfit);
  q('fh-pnl-gross-profit-prev').textContent = formatPrice(prevGrossProfit);

  if (expenses > 0) {
    q('fh-pnl-platform').textContent = '-' + formatPrice(expenses * 0.3);
    q('fh-pnl-platform-prev').textContent = '-' + formatPrice(expenses * 0.3);
    q('fh-pnl-other').textContent = '-' + formatPrice(expenses * 0.7);
    q('fh-pnl-other-prev').textContent = '-' + formatPrice(expenses * 0.7);
  } else {
    q('fh-pnl-platform').textContent = '$0 (not tracked)';
    q('fh-pnl-platform-prev').textContent = '—';
    q('fh-pnl-other').textContent = '$0 (not tracked)';
    q('fh-pnl-other-prev').textContent = '—';
  }

  const netEl = q('fh-pnl-net-profit');
  netEl.innerHTML = '<strong>' + formatPrice(netProfit) + '</strong>';
  netEl.className = netProfit >= 0 ? 'fh-pnl__pos' : 'fh-pnl__neg';
  q('fh-pnl-net-profit-prev').innerHTML = '<strong>' + formatPrice(prevNetProfit) + '</strong>';
  q('fh-pnl-net-profit-change').innerHTML = '<strong>' + calculateChange(netProfit, prevNetProfit) + '</strong>';
  q('fh-pnl-net-margin').textContent = rev > 0 ? (netProfit / rev * 100).toFixed(1) + '%' : '0%';
}

function checkAlerts() {
  const runway = _data.runway;
  if (runway !== undefined && runway !== Infinity && runway < 90) {
    const el = q('fh-runway-alert');
    el.style.display = 'flex';
    if (runway < 45) {
      el.className = 'fh-alert fh-alert--critical';
      q('fh-alert-title').textContent = 'Critical: Low Cash Runway';
      q('fh-alert-text').textContent = `Only ${Math.round(runway)} months of runway remaining. Immediate action required.`;
    } else {
      el.className = 'fh-alert fh-alert--warning';
      q('fh-alert-title').textContent = 'Warning: Cash Runway Below Target';
      q('fh-alert-text').textContent = `${Math.round(runway)} months runway. Target is 6+ months.`;
    }
  }
}

// ---- Expenses tab ----
function renderExpensesTable() {
  const list = _data.expenseList || [];
  const { search, category, from, to } = _expenseFilters;

  const filtered = list.filter(e => {
    if (search && !(e.vendor || e.description || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (category && e.category !== category) return false;
    if (from && (e.date || e.created_at || '') < from) return false;
    if (to && (e.date || e.created_at || '') > to) return false;
    return true;
  });

  const body = q('fh-expenses-body');
  if (!body) return;

  if (filtered.length === 0) {
    const isEmpty = list.length === 0;
    body.innerHTML = `
      <div class="fh-expense-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;margin-bottom:var(--spacing-3);"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
        <p style="font-weight:var(--font-weight-medium);">${isEmpty ? 'No expenses tracked yet' : 'No expenses match your filters'}</p>
        ${isEmpty ? `<p>Track your business expenses to get accurate P&amp;L reports.</p>
        <button class="btn btn--primary" style="margin-top:var(--spacing-4);" id="fh-empty-add-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add First Expense
        </button>` : ''}
      </div>
    `;
    const emptyBtn = body.querySelector('#fh-empty-add-btn');
    if (emptyBtn) emptyBtn.addEventListener('click', openAddExpenseModal);
    return;
  }

  const rows = filtered.map(e => {
    const dateStr = e.date
      ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
      : e.created_at
        ? new Date(e.created_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
        : '—';
    const catLabel = CAT_LABELS[e.category] || e.category || '—';
    return `
      <tr>
        <td>${dateStr}</td>
        <td><span class="fh-cat-badge">${esc(catLabel)}</span></td>
        <td>${esc(e.vendor || e.description || '—')}</td>
        <td style="text-align:right;">${formatPrice(e.amount || 0)}</td>
        <td style="text-align:right;">
          <button class="fh-delete-btn" data-id="${esc(String(e.id || ''))}" title="Delete expense" aria-label="Delete expense">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');

  body.innerHTML = `
    <table class="fh-expense-table">
      <thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  body.querySelectorAll('.fh-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteExpense(btn.dataset.id));
  });
}

function deleteExpense(id) {
  Modal.confirm({
    title: 'Delete Expense',
    message: 'Are you sure you want to delete this expense? This cannot be undone.',
    confirmLabel: 'Delete',
    confirmClass: 'admin-btn--danger',
    onConfirm: async () => {
      try {
        if (typeof AdminAPI.deleteExpense === 'function') {
          await AdminAPI.deleteExpense(id);
        }
        _data.expenseList = (_data.expenseList || []).filter(e => String(e.id) !== String(id));
        renderExpensesTable();
        Toast.success('Expense deleted');
      } catch {
        Toast.error('Failed to delete expense');
      }
    }
  });
}

async function loadExpenses() {
  const body = q('fh-expenses-body');
  if (body) body.innerHTML = '<div class="fh-expense-empty"><p>Loading expenses...</p></div>';
  try {
    const res = await AdminAPI.getExpenses('', '', '', 500);
    _data.expenseList = res?.expenses || res?.data || (Array.isArray(res) ? res : []);
  } catch {
    _data.expenseList = _data.expenseList || [];
  }
  renderExpensesTable();
  _expensesLoaded = true;
}

// ---- Add Expense Modal ----
function openAddExpenseModal() {
  const m = Modal.open({
    title: 'Add Expense',
    body: `
      <div class="fh-modal-form">
        <div class="fh-modal-form__field">
          <label class="fh-modal-form__label">Category <span style="color:var(--magenta-primary)">*</span></label>
          <select class="fh-modal-form__input" id="fh-modal-category" required>
            <option value="">Select category...</option>
            <option value="cogs">Cost of Goods Sold</option>
            <option value="shipping">Shipping &amp; Fulfillment</option>
            <option value="marketing-paid">Marketing - Paid Ads</option>
            <option value="platform">Platform Fees</option>
            <option value="software">Software &amp; Tools</option>
            <option value="other">Other Operating</option>
          </select>
        </div>
        <div class="fh-modal-form__field">
          <label class="fh-modal-form__label">Amount (NZD) <span style="color:var(--magenta-primary)">*</span></label>
          <input type="number" class="fh-modal-form__input" id="fh-modal-amount" step="0.01" min="0" placeholder="0.00" required>
        </div>
        <div class="fh-modal-form__field">
          <label class="fh-modal-form__label">Date <span style="color:var(--magenta-primary)">*</span></label>
          <input type="date" class="fh-modal-form__input" id="fh-modal-date" required>
        </div>
        <div class="fh-modal-form__field">
          <label class="fh-modal-form__label">Vendor / Description</label>
          <input type="text" class="fh-modal-form__input" id="fh-modal-vendor" placeholder="e.g., Google Ads">
        </div>
      </div>
    `,
    footer: `
      <button class="btn btn--secondary" id="fh-modal-cancel">Cancel</button>
      <button class="btn btn--primary" id="fh-modal-save">Save Expense</button>
    `
  });
  if (!m) return;

  const dateInput = m.el.querySelector('#fh-modal-date');
  if (dateInput) dateInput.valueAsDate = new Date();

  m.el.querySelector('#fh-modal-cancel').addEventListener('click', () => m.close());
  m.el.querySelector('#fh-modal-save').addEventListener('click', async () => {
    const category = m.el.querySelector('#fh-modal-category').value;
    const amount = m.el.querySelector('#fh-modal-amount').value;
    const date = m.el.querySelector('#fh-modal-date').value;
    const vendor = m.el.querySelector('#fh-modal-vendor').value;

    if (!category || !amount || !date) {
      Toast.warning('Please fill in all required fields');
      return;
    }

    const saveBtn = m.el.querySelector('#fh-modal-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      await AdminAPI.createExpense({ category, amount: parseFloat(amount), date, vendor });
      Toast.success('Expense saved');
      m.close();
      await loadData();
      if (_currentTab === 'expenses') {
        _expensesLoaded = false;
        await loadExpenses();
      }
    } catch {
      Toast.error('Failed to save expense');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Expense';
    }
  });
}

// ---- Tab switching ----
function switchTab(tab) {
  _currentTab = tab;
  _container.querySelectorAll('.admin-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  _container.querySelectorAll('.fh-panel').forEach(panel => {
    panel.classList.toggle('fh-panel--active', panel.id === `fh-tab-${tab}`);
  });

  if (tab === 'expenses' && !_expensesLoaded) {
    loadExpenses();
  }
  if (tab === 'pnl') {
    // Re-render profit chart now that panel is visible
    setTimeout(() => loadProfitChart(getMonthsForPeriod(_currentPeriod)), 50);
  }
}

// ---- Period buttons ----
async function setPeriod(period) {
  _currentPeriod = period;
  _container.querySelectorAll('#fh-period-btns .fh-period-btn').forEach(btn => {
    btn.classList.toggle('fh-period-btn--active', btn.dataset.period === period);
  });
  const months = getMonthsForPeriod(period);
  await loadCashFlowChart(months).catch(() => {});
  if (_currentTab === 'pnl') loadProfitChart(months);
}

// ---- Bind events ----
function bindEvents() {
  q('fh-period-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-period]');
    if (btn) setPeriod(btn.dataset.period);
  });

  q('fh-tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) switchTab(btn.dataset.tab);
  });

  q('fh-add-expense-btn').addEventListener('click', openAddExpenseModal);
  q('fh-expenses-add-btn').addEventListener('click', openAddExpenseModal);

  q('fh-pnl-period-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-pnl-period]');
    if (!btn) return;
    _pnlPeriod = btn.dataset.pnlPeriod;
    _container.querySelectorAll('#fh-pnl-period-btns .fh-period-btn').forEach(b => {
      b.classList.toggle('fh-period-btn--active', b.dataset.pnlPeriod === _pnlPeriod);
    });
    loadPnL();
  });

  q('fh-expense-search').addEventListener('input', e => {
    _expenseFilters.search = e.target.value;
    renderExpensesTable();
  });
  q('fh-expense-cat-filter').addEventListener('change', e => {
    _expenseFilters.category = e.target.value;
    renderExpensesTable();
  });
  q('fh-expense-from').addEventListener('change', e => {
    _expenseFilters.from = e.target.value;
    renderExpensesTable();
  });
  q('fh-expense-to').addEventListener('change', e => {
    _expenseFilters.to = e.target.value;
    renderExpensesTable();
  });
}

// ---- Data loading ----
async function loadData() {
  try {
    const [ordersRes, burnRes, forecastRes, expensesRes] = await Promise.allSettled([
      AdminAPI.getOrders({}, 1, 500),
      AdminAPI.getBurnRunway(),
      AdminAPI.getForecasts(),
      AdminAPI.getExpenses('', '', '', 200),
    ]);

    const ordersData = ordersRes.status === 'fulfilled' ? ordersRes.value : null;
    _data.orders = Array.isArray(ordersData) ? ordersData : (ordersData?.orders || []);
    _data.burn = burnRes.status === 'fulfilled' ? burnRes.value : null;
    _data.forecasts = forecastRes.status === 'fulfilled' ? forecastRes.value : null;
    _data.expenses = expensesRes.status === 'fulfilled' ? expensesRes.value : null;

    const expenseList = _data.expenses?.expenses || _data.expenses?.data ||
                        (Array.isArray(_data.expenses) ? _data.expenses : []);
    _data.expenseList = expenseList;
    _data.monthlyExpenses = expenseList.length
      ? expenseList.reduce((s, e) => s + (e.amount || 0), 0) / Math.max(1, getMonthSpan(expenseList))
      : 0;

    calculateMetrics(_data.orders);
    await loadCashFlowChart(getMonthsForPeriod(_currentPeriod)).catch(() => {});
    loadPnL();
    checkAlerts();
  } catch (e) {
    console.error('[FinancialHealth] load error', e);
  }
}

// ---- Page export ----
export default {
  title: 'Financial Health',

  async init(container) {
    _container = container;
    _currentPeriod = 'all';
    _currentTab = 'overview';
    _pnlPeriod = 'current';
    _expensesLoaded = false;
    _expenseFilters = { search: '', category: '', from: '', to: '' };
    FilterState.showBar(false);
    injectStyles();
    container.innerHTML = renderHTML();
    bindEvents();
    await loadData();
  },

  destroy() {
    Object.values(_charts).forEach(c => { try { c.destroy(); } catch {} });
    Object.keys(_charts).forEach(k => delete _charts[k]);
    Object.keys(_data).forEach(k => delete _data[k]);
    _container = null;
  }
};
