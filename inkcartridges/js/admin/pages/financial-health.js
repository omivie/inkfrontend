/**
 * Financial Health Page — Cash, P&L, runway, expenses
 */
import { AdminAPI, FilterState, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import {
  normalizeCategory, categoryKind, gstDefaultFor, setCustomCategories,
  CUSTOM_CATEGORIES_KEY, CATEGORY_OVERRIDES_KEY, normalizeCategoryOverrides, resolveRowCategory,
} from '../utils/expense-categories.js';
import { RECURRENCE_TYPES, expandExpenseOccurrences, deriveStatus, isRecurring } from '../utils/expense-recurrence.js';
import { computeExpenseKpis } from '../utils/expense-math.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '—';

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
let _catOverrides = {};   // { expenseId: customKey } — rows the backend stores as 'other'

async function load() {
  const days = FilterState.periodToDays();
  const [overview, burnRunway, forecasts, cashflow, daily, pnl, expenses, prefs] = await Promise.all([
    AdminAPI.getAdminAnalyticsOverview(days),
    AdminAPI.getAdminAnalyticsBurnRunway(),
    AdminAPI.getAdminAnalyticsForecasts(),
    AdminAPI.getAdminAnalyticsCashflow(12),
    AdminAPI.getAdminAnalyticsDailyRevenue(372),
    AdminAPI.getAdminAnalyticsPnL(days),
    AdminAPI.expenses.list({ limit: 1000 }),
    // Owner's custom expense categories — fail-soft: P&L TOTALS are correct either
    // way (an unknown key normalises to 'other', which is operating, and GST is
    // stored per row); this only keeps per-category grouping consistent with the
    // Expenses page. Never seed from here — the Expenses page owns that.
    AdminAPI.getUiPrefs().catch(() => null),
  ]);
  setCustomCategories(prefs?.[CUSTOM_CATEGORIES_KEY]);
  _catOverrides = normalizeCategoryOverrides(prefs?.[CATEGORY_OVERRIDES_KEY]);
  // NB the backend's P&L already includes invoiced (phone / walk-in / B2B) sales —
  // it returns includes_invoices: true. The frontend renders; it does not aggregate.
  _state = { overview, burnRunway, forecasts, cashflow, daily, pnl, expenses: expenses?.items || [] };
  render();
}

// ── Expense summary (the full management UI now lives at Finance → Expenses) ──
const MS_DAY_FH = 86400000;
function todayUtcFH() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
function monthStartFH(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
function monthEndFH(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); }

function computeExpenseSummary() {
  const rows = Array.isArray(_state.expenses) ? _state.expenses : [];
  const today = todayUtcFH();
  const mStart = monthStartFH(today), mEnd = monthEndFH(today);
  const from = Math.min(mStart, today - 90 * MS_DAY_FH), to = today + 30 * MS_DAY_FH;
  const enrich = (o) => {
    const category = normalizeCategory(resolveRowCategory(o.category, o.series_id ?? o.id, _catOverrides));
    const ed = (o.expense_date || o.date || '').slice(0, 10);
    const status = deriveStatus({ due_date: o.due_date, date: ed, paid_date: o.paid_date, paid: o.paid, status: o.status }, today);
    return {
      ...o, category, kind: categoryKind(category), amount: num(pick(o, 'amount', 'total')),
      gst_claimable: o.gst_claimable !== undefined ? !!o.gst_claimable : gstDefaultFor(category),
      status, paid: status === 'paid', expense_date: ed, due_date: (o.due_date || ed || '').slice(0, 10),
    };
  };
  const occ = [];
  for (const raw of rows) {
    const recurrence = RECURRENCE_TYPES.includes(raw.recurrence) ? raw.recurrence : 'none';
    const base = { ...raw, recurrence, series_state: raw.series_state || 'active' };
    if (isRecurring(base) && base.series_state === 'active') {
      for (const o of expandExpenseOccurrences(base, from, to)) occ.push(enrich(o));
    } else if (!isRecurring(base)) {
      occ.push(enrich(base));
    }
  }
  return computeExpenseKpis(occ, {
    monthStart: mStart, monthEnd: mEnd, prevStart: 0, prevEnd: 0,
    next30Start: today, next30End: to, revenueThisMonth: null, recurringTemplates: [],
  });
}

function renderExpenseSummaryCard() {
  const k = computeExpenseSummary();
  const tile = (label, value, tone) => `
    <div class="exp-kpi exp-kpi--${tone || 'plain'}" style="padding:12px 14px">
      <div class="exp-kpi__label">${esc(label)}</div>
      <div class="exp-kpi__value" style="font-size:19px">${esc(formatPrice(value || 0))}</div>
    </div>`;
  return `
    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title" style="display:flex;justify-content:space-between;align-items:center">
        <span>Expenses <small>cash basis — paid operating spend &amp; upcoming cash</small></span>
        <button class="admin-btn admin-btn--primary admin-btn--sm" id="fh-open-expenses">Open Expense Management →</button>
      </div>
      <div class="exp-kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
        ${tile('Paid this month', k.thisMonth, '')}
        ${tile('Upcoming (30d)', k.upcoming30, '')}
        ${tile('Overdue', k.overdue, k.overdue > 0 ? 'bad' : 'good')}
      </div>
    </div>`;
}

function render() {
  if (!_container) return;
  Charts.destroyAll();

  const ov = _state.overview || {};
  const br = _state.burnRunway || {};
  const f = _state.forecasts || {};
  const fc = f.forecasts || f;

  const grossMargin = num(pick(ov, 'grossMargin', 'gross_margin'));
  const prevGrossMargin = num(pick(ov, 'prevGrossMargin', 'prev_gross_margin'));
  const netProfit = num(pick(ov, 'netProfit', 'net_profit'));
  const cashBalance = num(pick(br, 'cashBalance', 'cash_balance', 'balance'));
  const monthlyBurn = num(pick(br, 'monthlyBurn', 'monthly_burn', 'burnRate'));
  const runwayMonths = pick(br, 'runwayMonths', 'runway_months', 'runway');
  const f30 = num(pick(fc, 'forecast30', 'days30', 'd30', '30_days'));
  const f60 = num(pick(fc, 'forecast60', 'days60', 'd60', '60_days'));
  const f90 = num(pick(fc, 'forecast90', 'days90', 'd90', '90_days'));

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
      <div class="admin-card__title">Profit & Loss <small>latest period vs prior</small></div>
      ${renderPnLOrdersSummary()}
      <div style="overflow-x:auto">${renderPnLTable()}</div>
    </div>

    ${renderExpenseSummaryCard()}
  `;

  renderCashflowChart();
  renderProfitChart();
  bindExpenseSummary();
}

function bindExpenseSummary() {
  _container?.querySelector('#fh-open-expenses')?.addEventListener('click', () => {
    window.location.hash = 'expenses';
  });
}

function renderPnLOrdersSummary() {
  const pnl = _state.pnl || {};
  const periods = Array.isArray(pnl.periods) ? pnl.periods : [];
  const cur = periods[periods.length - 1] || pnl.totals || {};
  const prev = periods.length >= 2 ? periods[periods.length - 2] : {};
  const curN = num(cur.order_count, NaN);
  const prevN = num(prev.order_count, NaN);
  if (!Number.isFinite(curN)) return '';
  let delta = '';
  if (Number.isFinite(prevN) && prevN > 0) {
    const pct = ((curN - prevN) / prevN) * 100;
    delta = ` <span style="color:var(--text-muted);font-size:12px">(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs prior)</span>`;
  }
  return `<div style="font-size:12px;color:var(--text-muted);margin:-4px 0 8px">${curN.toLocaleString('en-NZ')} orders this period${delta}</div>`;
}

function renderPnLTable() {
  const pnl = _state.pnl || {};
  const periods = Array.isArray(pnl.periods) ? pnl.periods : [];
  const cur = periods[periods.length - 1] || pnl.totals || {};
  const prev = periods.length >= 2 ? periods[periods.length - 2] : {};
  const rows = [
    ['Revenue', cur.revenue, prev.revenue],
    ['Cost of Goods Sold', cur.cogs, prev.cogs, true],
    ['Gross Profit', cur.gross_profit, prev.gross_profit],
    // Invoiced sales settle by bank transfer, so they add exactly $0 of card fees.
    ['Stripe Fees', cur.stripe_fees, prev.stripe_fees, true],
    ['Operating Expenses', cur.operating_expenses, prev.operating_expenses, true],
    ['Net Profit', cur.net_profit, prev.net_profit, false, true],
  ];

  // COGS HONESTY (ERR-028 / ERR-063). The backend returns cogs / gross_profit /
  // net_profit as NULL — never 0 — when any sale in the period has an un-costed
  // line. Do NOT route those through num(v, 0): that renders "$0.00", which reads
  // as "we made nothing" when the truth is "we don't know". Unknown is "—".
  const known = (v) => v != null && Number.isFinite(typeof v === 'string' ? parseFloat(v) : v);
  const fmt = (v, neg) => {
    if (!known(v)) return MISSING;
    const n = num(v);
    return (neg && n > 0 ? '-' : '') + formatPrice(Math.abs(n));
  };
  const change = (c0, p0) => {
    // A change against an unknown value is itself unknown — not "0%" (which claims
    // it was flat) and not "+∞" (which claims it appeared from nothing).
    if (!known(c0) || !known(p0)) return MISSING;
    const c = num(c0), p = num(p0);
    if (!p) return c > 0 ? '+∞' : '0%';
    const pct = ((c - p) / Math.abs(p)) * 100;
    return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  };

  const unknownRows = rows.filter(([, c]) => !known(c)).map(([label]) => label);

  let html = `<table class="admin-table" style="margin:0;width:100%">
    <thead><tr><th>Line</th><th style="text-align:right">Current</th><th style="text-align:right">Previous</th><th style="text-align:right">Change</th></tr></thead><tbody>`;
  for (const [label, c, p, neg, bold] of rows) {
    const style = bold ? 'font-weight:700;border-top:2px solid var(--border)' : '';
    const negClass = neg && known(c) ? 'style="color:var(--magenta, #C71F6E);"' : '';
    html += `<tr style="${style}">
      <td>${esc(label)}</td>
      <td style="text-align:right" ${negClass}>${esc(fmt(c, neg))}</td>
      <td style="text-align:right" ${negClass}>${esc(fmt(p, neg))}</td>
      <td style="text-align:right">${esc(change(c, p))}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  if (unknownRows.length) {
    html += `<p class="fh-pnl-note">${esc(unknownRows.join(', '))} ${unknownRows.length === 1 ? 'is' : 'are'} unavailable —
      at least one sale in this period has no cost of goods recorded, so profit can’t be calculated.
      <a href="#dashboard">See which sales</a> to fix it.</p>`;
  }
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
  const pnl = _state.pnl || {};
  const periods = Array.isArray(pnl.periods) ? pnl.periods : [];

  const labels = [], gross = [], net = [], orders = [];
  for (const p of periods) {
    const ym = String(p.period || '');
    const [y, m] = ym.split('-');
    const label = (y && m)
      ? new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' })
      : ym;
    labels.push(label);
    // null = unknown COGS for that month. Push null, NOT 0 — Chart.js draws a gap
    // (spanGaps defaults false), which is the truth. A 0 would draw the line down
    // to the axis and read as "we made no profit that month".
    gross.push(p.gross_profit != null ? num(p.gross_profit) : null);
    net.push(p.net_profit != null ? num(p.net_profit) : null);
    orders.push(p.order_count != null ? num(p.order_count) : null);
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
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}`,
            afterBody: (items) => {
              const i = items?.[0]?.dataIndex;
              const n = i != null ? orders[i] : null;
              return n != null ? `${n.toLocaleString('en-NZ')} orders` : '';
            },
          },
        },
      },
    },
  });
}

export default {
  title: 'Financial Health',

  async init(container) {
    _container = container;
    FilterState.setVisibleFilters(['period']);
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:40vh"><div class="admin-loading__spinner"></div></div>`;
    try {
      await load();
    } catch (e) {
      container.innerHTML = `<div class="admin-stub"><div class="admin-stub__title">Failed to load Financial Health</div><div class="admin-stub__text">${esc(e.message || 'Unknown error')}</div></div>`;
    }
  },

  async onFilterChange() {
    if (_container) await load();
  },

  destroy() {
    Charts.destroyAll();
    FilterState.setVisibleFilters(null);
    _container = null;
    _state = {};
  },
};
