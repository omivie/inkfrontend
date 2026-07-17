/**
 * Expenses → Overview tab — "how is spending going?" at a glance.
 *
 * Period-driven (the GLOBAL FilterState bar): four primary KPIs with a
 * comparison against the previous equal-length window, a trend chart with
 * three modes (Expenses / Cumulative / vs Revenue), ranked category bars,
 * the upcoming/overdue cash panel, the recurring-commitment summary and a
 * recent-expenses preview.
 *
 * DATE-BASIS HONESTY: spend KPIs are CASH BASIS (paid date, GST-netted) and
 * match Finance → P&L — they never switch. The trend chart follows the
 * page's "Filter dates by" basis and SAYS SO in its subtitle; the vs-Revenue
 * mode always uses paid-basis expenses and labels the mixed bases explicitly
 * (revenue is by order date). Nothing mixes silently.
 *
 * Pure renderer over the shell's ctx (see pages/expenses.js) — no fetching
 * beyond the shell's lazy ensurePnl/ensureDailyRevenue, no persistence.
 */
import { icon, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { bucketExpenses, pnlCost } from '../utils/expense-math.js';
import { categoryLabel } from '../utils/expense-categories.js';
import { parseUtcDate } from '../utils/expense-recurrence.js';

let _host = null;
let _ctx = null;
let _chartMode = 'expenses'; // expenses | cumulative | revenue (ephemeral, not URL)
let _renderSeq = 0;          // guards async strip/chart fills after a re-render

const MS_DAY = 86400000;

// ─── KPIs ────────────────────────────────────────────────────────────────────
function deltaHtml(kpis, range) {
  if (range.period === 'all') return '<span class="exp-kpi__delta">all time</span>';
  const pct = kpis.pctChange;
  if (pct === null || pct === undefined) {
    return `<span class="exp-kpi__delta">${kpis.prevSpend === null ? 'no comparison window' : 'no prior-period baseline'}</span>`;
  }
  const tone = Math.abs(pct) < 0.5 ? '' : (pct > 0 ? ' exp-kpi__delta--bad' : ' exp-kpi__delta--good');
  return `<span class="exp-kpi__delta${tone}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}% vs previous ${esc(periodNoun(range))}</span>`;
}

function periodNoun(range) {
  return { '24h': '24 hours', '72h': '72 hours', '7d': '7 days', '1m': 'month', '3m': '3 months', '6m': '6 months', '1y': 'year', '2y': '2 years', custom: 'period' }[range.period] || 'period';
}

function kpiGrid(ctx) {
  const { money, escA } = ctx.fmt;
  const k = ctx.getState().kpis || {};
  const range = ctx.getRange();
  const grossSub = (k.spendGross && Math.abs(k.spendGross - k.spend) > 0.01)
    ? `${money(k.spendGross)} gross cash out`
    : 'GST-netted, matches P&L';
  const cards = [
    {
      label: `Operating spend · ${range.periodLabel}`, value: money(k.spend || 0), go: 'paid',
      sub: `${deltaHtml(k, range)}<span class="exp-kpi__note" title="Cash basis: only expenses marked paid, on their paid date, GST-netted, operating only — the same figure Finance → P&amp;L books.">${esc(grossSub)}</span>`,
      tone: '',
    },
    { label: 'Overdue', value: money(k.overdue || 0), go: 'overdue', sub: k.overdue > 0 ? 'needs paying now — by due date' : 'all clear', tone: k.overdue > 0 ? 'bad' : 'good' },
    { label: 'Due (unpaid)', value: money(k.unpaid || 0), go: 'unpaid', sub: 'open amounts by due date — not period-scoped', tone: k.unpaid > 0 ? 'warn' : '' },
    { label: 'Recurring commitment', value: money(k.recurringMonthly || 0), go: 'recurring-tab', sub: 'per month, active series only', tone: '' },
  ];
  const secondary = [
    { id: 'ratio', label: '% of revenue', value: '…', title: 'Period spend (GST-netted) ÷ revenue (ex-GST) of the P&L months overlapping the window — approximate, monthly P&L granularity.' },
    { label: 'Upcoming (next 30d)', value: money(k.upcoming30 || 0), title: 'Open amounts due in the next 30 days, gross.' },
    { label: 'Largest category', value: k.largestCategory ? `${categoryLabel(k.largestCategory.key)} · ${money(k.largestCategory.total)}` : '—', title: 'Biggest paid operating category in the period, GST-netted.' },
    { label: 'Avg expense', value: k.avgExpense != null ? money(k.avgExpense) : '—', title: `Average paid operating expense in the period (${k.txnCount || 0} transactions), GST-netted.` },
    { label: 'GST reclaim', value: money(k.gstReclaim || 0), title: 'GST input credits embedded in the period\'s paid claimable expenses.' },
    { label: 'Order-linked (excluded)', value: money(k.orderLinked || 0), title: 'Already counted in per-order costs — never added to operating spend.' },
  ];
  return `
    <div class="exp-kpi-grid exp-kpi-grid--primary">${cards.map(c => `
      <button class="exp-kpi exp-kpi--${c.tone || 'plain'} exp-kpi--click" data-kpi-go="${c.go}" title="Open the matching view">
        <div class="exp-kpi__label">${esc(c.label)}</div>
        <div class="exp-kpi__value">${esc(c.value)}</div>
        <div class="exp-kpi__sub">${c.sub}</div>
      </button>`).join('')}</div>
    <div class="exp-kpi-strip">${secondary.map(s => `
      <div class="exp-kpi-strip__item" ${s.id ? `id="exp-strip-${s.id}"` : ''} title="${escA(s.title)}">
        <span class="exp-kpi-strip__label">${esc(s.label)}</span>
        <span class="exp-kpi-strip__value">${esc(s.value)}</span>
      </div>`).join('')}</div>`;
}

/** Async fill: % of revenue from the P&L months overlapping the window. */
async function fillRevenueRatio(ctx, seq) {
  const el = () => _host?.querySelector('#exp-strip-ratio .exp-kpi-strip__value');
  const pnl = await ctx.ensurePnl();
  if (seq !== _renderSeq || !el()) return;
  const k = ctx.getState().kpis || {};
  const range = ctx.getRange();
  const periods = Array.isArray(pnl?.periods) ? pnl.periods : [];
  let revenue = 0;
  let any = false;
  for (const p of periods) {
    const m = /^(\d{4})-(\d{2})/.exec(String(p.period || ''));
    if (!m || p.revenue == null) continue;
    const mStart = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
    const mEnd = Date.UTC(Number(m[1]), Number(m[2]), 0);
    if (mEnd >= range.fromMs && mStart <= range.toMs) { revenue += Number(p.revenue) || 0; any = true; }
  }
  el().textContent = (any && revenue > 0 && k.spend != null)
    ? `${((k.spend / revenue) * 100).toFixed(1)}%`
    : 'n/a';
}

// ─── upcoming & overdue panel ────────────────────────────────────────────────
function openItems(ctx) {
  const today = ctx.fmt.todayUtcMs();
  return ctx.getState().occurrences
    .filter(o => o.kind !== 'order_linked' && o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped')
    .map(o => ({ ...o, _dueMs: parseUtcDate(o.due_date || o.expense_date) }))
    .filter(o => Number.isFinite(o._dueMs) && o._dueMs <= today + 30 * MS_DAY)
    .sort((a, b) => a._dueMs - b._dueMs);
}

function upcomingPanel(ctx) {
  const { money, fmtDate, escA } = ctx.fmt;
  const today = ctx.fmt.todayUtcMs();
  const items = openItems(ctx);
  if (!items.length) return '<div class="exp-empty-inline">Nothing due in the next 30 days.</div>';
  const groups = [
    { title: 'Overdue', tone: 'bad', rows: items.filter(o => o._dueMs < today) },
    { title: 'Next 7 days', tone: 'warn', rows: items.filter(o => o._dueMs >= today && o._dueMs <= today + 7 * MS_DAY) },
    { title: 'Next 30 days', tone: 'plain', rows: items.filter(o => o._dueMs > today + 7 * MS_DAY) },
  ].filter(g => g.rows.length);
  return groups.map(g => `
    <div class="exp-due-group exp-due-group--${g.tone}">
      <div class="exp-due-group__title">${esc(g.title)} <span class="exp-due-group__sum">${esc(money(g.rows.reduce((s, o) => s + o.amount, 0)))}</span></div>
      <ul class="exp-upcoming-list">${g.rows.slice(0, 8).map(o => {
        const days = Math.round((o._dueMs - today) / MS_DAY);
        const daysTxt = days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : `in ${days}d`;
        return `<li class="exp-upcoming-item exp-upcoming-item--${o.status}">
          <div class="exp-upcoming-item__main">
            <button class="exp-linklike" data-detail-id="${escA(o.series_id)}" title="Open details">${esc(o.name || o.payee || categoryLabel(o.category))}</button>
            ${o.recurring ? '<span class="exp-tag exp-tag--projected" title="Recurring occurrence">recurring</span>' : ''}
          </div>
          <div class="exp-upcoming-item__meta"><span class="exp-upcoming-item__date">${esc(fmtDate(o.due_date || o.expense_date))} · ${esc(daysTxt)}</span></div>
          <div class="exp-upcoming-item__amt">${esc(money(o.amount))}</div>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-quick-pay="${escA(o.series_id)}" data-date="${escA(o.expense_date)}" data-amount="${escA(o.amount)}" data-recurring="${o.recurring ? '1' : ''}" title="Mark paid today">${icon('check', 12, 12)}</button>
        </li>`;
      }).join('')}${g.rows.length > 8 ? `<li class="exp-empty-inline" style="padding:6px 0">+ ${g.rows.length - 8} more — see All expenses</li>` : ''}</ul>
    </div>`).join('');
}

// ─── ranked category bars ────────────────────────────────────────────────────
function categoryBars(ctx) {
  const { money, escA } = ctx.fmt;
  const rows = (ctx.getState().catBreakdown || []).slice(0, 10);
  if (!rows.length) return '<div class="exp-empty-inline">No <strong>paid</strong> operating spend to break down yet.</div>';
  const max = rows[0].total || 1;
  return `<div class="exp-cat-bars">${rows.map(b => {
    const delta = b.deltaPct == null ? ''
      : `<span class="exp-cat-bar__delta ${b.deltaPct > 0 ? 'exp-kpi__delta--bad' : 'exp-kpi__delta--good'}">${b.deltaPct > 0 ? '↑' : '↓'}${Math.abs(b.deltaPct).toFixed(0)}%</span>`;
    return `<button class="exp-cat-bar" data-cat-go="${escA(b.key)}" title="Show these expenses">
      <span class="exp-cat-bar__label">${esc(categoryLabel(b.key))}</span>
      <span class="exp-cat-bar__track"><span class="exp-cat-bar__fill" style="width:${Math.max(2, (b.total / max) * 100).toFixed(1)}%"></span></span>
      <span class="exp-cat-bar__meta">${esc(money(b.total))} · ${b.pct.toFixed(0)}% · ${b.count}× ${delta}</span>
    </button>`;
  }).join('')}</div>`;
}

// ─── recurring summary + recent preview ─────────────────────────────────────
function recurringCard(ctx) {
  const { money, fmtDate } = ctx.fmt;
  const k = ctx.getState().kpis || {};
  const today = ctx.fmt.todayUtcMs();
  const next = ctx.getState().occurrences
    .filter(o => o.recurring && o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped' && o._ms >= today)
    .sort((a, b) => a._ms - b._ms)
    .slice(0, 3);
  return `
    <div class="exp-commit-row">
      <div><span class="exp-kpi-strip__label">Monthly</span> <strong>${esc(money(k.recurringMonthly || 0))}</strong></div>
      <div><span class="exp-kpi-strip__label">Annualised</span> <strong>${esc(money((k.recurringMonthly || 0) * 12))}</strong></div>
    </div>
    ${next.length ? `<ul class="exp-next-list">${next.map(o => `
      <li><span>${esc(o.name || categoryLabel(o.category))}</span><span class="cell-muted">${esc(fmtDate(o.expense_date))}</span><span class="cell-mono">${esc(money(o.amount))}</span></li>`).join('')}</ul>`
      : '<div class="exp-empty-inline" style="padding:8px 0">No upcoming recurring payments.</div>'}
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-go-recurring>Manage recurring →</button>`;
}

function recentCard(ctx) {
  const { money, fmtDate, escA } = ctx.fmt;
  const recent = [...ctx.getState().rows]
    .sort((a, b) => String(b.created_at || b.expense_date).localeCompare(String(a.created_at || a.expense_date)))
    .slice(0, 5);
  if (!recent.length) return '<div class="exp-empty-inline">No expenses yet.</div>';
  return `
    <ul class="exp-next-list">${recent.map(r => `
      <li><button class="exp-linklike" data-detail-id="${escA(r.id)}">${esc(r.name || categoryLabel(r.category))}</button><span class="cell-muted">${esc(fmtDate(r.expense_date))}</span><span class="cell-mono">${esc(money(r.amount))}</span></li>`).join('')}</ul>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-go-all>View all expenses →</button>`;
}

// ─── trend chart (3 modes) ───────────────────────────────────────────────────
function bucketKey(ms, grain) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  if (grain === 'day') return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (grain === 'week') {
    const monday = ms - ((d.getUTCDay() + 6) % 7) * MS_DAY;
    const md = new Date(monday);
    return `${md.getUTCFullYear()}-${pad(md.getUTCMonth() + 1)}-${pad(md.getUTCDate())}`;
  }
  if (grain === 'quarter') return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

const BASIS_SUBTITLE = {
  paid: 'by paid date · cash basis — matches P&L',
  incurred: 'by expense date · includes unpaid',
  due: 'by due date · includes unpaid',
};

/** Buckets on the page's date basis. paid = the canonical cash-basis math. */
function trendBuckets(ctx) {
  const range = ctx.getRange();
  const { occurrences } = ctx.getState();
  const basis = ctx.filters.get().basis;
  if (basis === 'paid') return bucketExpenses(occurrences, range.fromMs, range.toMs, range.grain);
  const map = new Map();
  for (const o of occurrences) {
    if (o.kind === 'order_linked') continue;
    if (o.status === 'cancelled' || o.status === 'skipped') continue;
    const ms = parseUtcDate(basis === 'due' ? (o.due_date || o.expense_date) : o.expense_date);
    if (!Number.isFinite(ms) || ms < range.fromMs || ms > range.toMs) continue;
    const k = bucketKey(ms, range.grain);
    map.set(k, (map.get(k) || 0) + pnlCost(o.amount, !!o.gst_claimable));
  }
  return [...map.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

function chartEmpty(msg) {
  const box = _host?.querySelector('#exp-trend-box');
  if (box) box.innerHTML = `<div class="exp-empty-inline">${msg}</div>`;
}

function chartSubtitle(txt) {
  const el = _host?.querySelector('#exp-trend-sub');
  if (el) el.textContent = txt;
}

async function renderTrendChart(ctx, seq) {
  const { money } = ctx.fmt;
  const range = ctx.getRange();
  const basis = ctx.filters.get().basis;
  // Re-create the canvas (a previous mode/empty state may have replaced it).
  const box = _host?.querySelector('#exp-trend-box');
  if (!box) return;
  box.innerHTML = '<canvas id="exp-trend"></canvas>';
  const colors = Charts.getThemeColors();

  if (_chartMode === 'revenue') {
    // Honest comparison: expenses stay PAID/cash-basis here regardless of the
    // table basis; revenue is by ORDER date as charged — labelled mixed bases.
    chartSubtitle(`expenses by paid date (GST-netted) · revenue by order date (as charged) — mixed bases · ${range.grain} buckets`);
    const [expBuckets, dailyRes] = [bucketExpenses(ctx.getState().occurrences, range.fromMs, range.toMs, range.grain), await ctx.ensureDailyRevenue()];
    if (seq !== _renderSeq || !_host?.querySelector('#exp-trend')) return;
    const daily = Array.isArray(dailyRes?.daily) ? dailyRes.daily : [];
    const revMap = new Map();
    for (const d of daily) {
      const ms = parseUtcDate(d.date);
      if (!Number.isFinite(ms) || ms < range.fromMs || ms > range.toMs) continue;
      const k = bucketKey(ms, range.grain);
      revMap.set(k, (revMap.get(k) || 0) + (Number(d.revenue) || 0));
    }
    const keys = [...new Set([...expBuckets.map(b => b.key), ...revMap.keys()])].sort();
    if (!keys.length) { chartEmpty('Nothing paid and no revenue in this period.'); return; }
    const expByKey = new Map(expBuckets.map(b => [b.key, b.total]));
    await Charts.bar('exp-trend', {
      labels: keys,
      datasets: [
        { label: 'Expenses (paid, GST-netted)', data: keys.map(k => expByKey.get(k) || 0), backgroundColor: colors.magenta, borderRadius: 4, yAxisID: 'y' },
        { label: 'Revenue (order date)', data: keys.map(k => revMap.get(k) || 0), type: 'line', borderColor: colors.cyan, backgroundColor: 'transparent', tension: 0.25, yAxisID: 'y1', pointRadius: 2 },
      ],
      options: {
        plugins: {
          legend: { display: true, labels: { color: colors.textMuted, boxWidth: 12 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } },
        },
        scales: { y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: colors.textMuted } } },
      },
    });
    return;
  }

  const buckets = trendBuckets(ctx);
  if (!buckets.length) {
    chartSubtitle(BASIS_SUBTITLE[basis] || '');
    chartEmpty(basis === 'paid'
      ? 'No operating expenses <strong>paid</strong> in this period. Mark an expense paid and it lands here on its paid date.'
      : 'No operating expenses dated in this period.');
    return;
  }

  if (_chartMode === 'cumulative') {
    chartSubtitle(`cumulative · ${BASIS_SUBTITLE[basis] || ''} · ${range.grain} buckets`);
    let run = 0;
    const cum = buckets.map(b => (run += b.total));
    await Charts.line('exp-trend', {
      labels: buckets.map(b => b.key),
      datasets: [{ label: 'Cumulative operating expenses', data: cum, borderColor: colors.magenta, backgroundColor: 'transparent', tension: 0.25, fill: false, pointRadius: 2 }],
      options: { plugins: { tooltip: { callbacks: { label: (c) => `Cumulative: ${money(c.parsed.y)}` } } } },
    });
    return;
  }

  chartSubtitle(`${BASIS_SUBTITLE[basis] || ''} · ${range.grain} buckets`);
  await Charts.bar('exp-trend', {
    labels: buckets.map(b => b.key),
    datasets: [{ label: 'Operating expenses', data: buckets.map(b => b.total), backgroundColor: colors.magenta, borderRadius: 4 }],
    options: { plugins: { tooltip: { callbacks: { label: (c) => `Expenses: ${money(c.parsed.y)}` } } } },
  });
}

// ─── bindings ────────────────────────────────────────────────────────────────
function bind(ctx) {
  _host.addEventListener('click', (e) => {
    const kpi = e.target.closest('[data-kpi-go]');
    if (kpi) {
      const go = kpi.dataset.kpiGo;
      if (go === 'recurring-tab') return ctx.switchTab('recurring');
      return ctx.switchTab('all', { status: go === 'paid' ? 'paid' : go, type: '' });
    }
    const cat = e.target.closest('[data-cat-go]');
    if (cat) return ctx.switchTab('all', { cat: cat.dataset.catGo });
    if (e.target.closest('[data-go-recurring]')) return ctx.switchTab('recurring');
    if (e.target.closest('[data-go-all]')) return ctx.switchTab('all');
    const detail = e.target.closest('[data-detail-id]');
    if (detail) {
      const row = ctx.getState().rows.find(r => String(r.id) === String(detail.dataset.detailId));
      if (row) ctx.openDetail(row);
      return;
    }
    const pay = e.target.closest('[data-quick-pay]');
    if (pay) {
      const { quickPay: sid, date, amount, recurring } = pay.dataset;
      pay.disabled = true;
      if (recurring) ctx.payOccurrence(sid, date, Number(amount) || 0);
      else ctx.guardedWrite(() => ctx.api.pay(sid, { paid_date: ctx.fmt.todayInputValue(), amount: Number(amount) || 0 }), 'Marked paid.');
      return;
    }
    const mode = e.target.closest('[data-chart-mode]');
    if (mode && mode.dataset.chartMode !== _chartMode) {
      _chartMode = mode.dataset.chartMode;
      _host.querySelectorAll('[data-chart-mode]').forEach(b => {
        const on = b.dataset.chartMode === _chartMode;
        b.classList.toggle('admin-segmented__btn--active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderTrendChart(ctx, _renderSeq);
    }
  });
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  const seq = ++_renderSeq;
  const range = ctx.getRange();
  host.innerHTML = `
    ${kpiGrid(ctx)}
    <div class="exp-cols">
      <div class="admin-card exp-upcoming">
        <div class="admin-card__title">Upcoming &amp; overdue <small>next 30 days · by due date · gross</small></div>
        <div id="exp-upcoming-body">${upcomingPanel(ctx)}</div>
      </div>
      <div class="admin-card exp-breakdown">
        <div class="admin-card__title">Where the money goes <small>paid · GST-netted · ${esc(range.periodLabel.toLowerCase())}</small></div>
        ${categoryBars(ctx)}
      </div>
    </div>
    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <span>Spending over time <small id="exp-trend-sub"></small></span>
        <div class="admin-segmented" role="tablist" aria-label="Chart mode">
          <button class="admin-segmented__btn${_chartMode === 'expenses' ? ' admin-segmented__btn--active' : ''}" data-chart-mode="expenses" role="tab" aria-selected="${_chartMode === 'expenses'}">Expenses</button>
          <button class="admin-segmented__btn${_chartMode === 'cumulative' ? ' admin-segmented__btn--active' : ''}" data-chart-mode="cumulative" role="tab" aria-selected="${_chartMode === 'cumulative'}">Cumulative</button>
          <button class="admin-segmented__btn${_chartMode === 'revenue' ? ' admin-segmented__btn--active' : ''}" data-chart-mode="revenue" role="tab" aria-selected="${_chartMode === 'revenue'}">vs Revenue</button>
        </div>
      </div>
      <div class="admin-chart-box admin-chart-box--tall" id="exp-trend-box"><canvas id="exp-trend"></canvas></div>
    </div>
    <div class="exp-cols">
      <div class="admin-card">
        <div class="admin-card__title">Recurring commitments <small>active series</small></div>
        ${recurringCard(ctx)}
      </div>
      <div class="admin-card">
        <div class="admin-card__title">Recently added <small>latest 5</small></div>
        ${recentCard(ctx)}
      </div>
    </div>
    <div id="exp-hidden-note"></div>`;

  ctx.updateHiddenNote(ctx.filteredRows().length);
  bind(ctx);
  fillRevenueRatio(ctx, seq);
  await renderTrendChart(ctx, seq);
}

export default {
  id: 'overview',
  render,
  destroy() {
    _renderSeq++;
    _host = null;
    _ctx = null;
  },
};
