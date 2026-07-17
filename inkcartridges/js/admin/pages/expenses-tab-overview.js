/**
 * Expenses → Overview tab — "how is spending going?" at a glance.
 *
 * Period-driven (the GLOBAL FilterState bar): four primary KPIs with a
 * comparison against the previous equal-length window, the spend trend chart,
 * the category doughnut, and the upcoming/overdue strip. Every figure names
 * its basis — spend is CASH BASIS (paid date, GST-netted) and matches
 * Finance → P&L; the open amounts are due-date based and global.
 *
 * Pure renderer over the shell's ctx (see pages/expenses.js) — no fetching, no
 * persistence here.
 */
import { icon, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { bucketExpenses } from '../utils/expense-math.js';
import { categoryLabel } from '../utils/expense-categories.js';
import { parseUtcDate } from '../utils/expense-recurrence.js';

let _host = null;
let _ctx = null;

function deltaHtml(kpis, range) {
  if (range.period === 'all') return '<span class="exp-kpi__delta">all time</span>';
  const pct = kpis.pctChange;
  if (pct === null || pct === undefined) {
    return `<span class="exp-kpi__delta">${kpis.prevSpend === null ? 'no comparison window' : 'no prior-period baseline'}</span>`;
  }
  // More spend than last period reads as bad (invert), flat reads neutral.
  const tone = Math.abs(pct) < 0.5 ? '' : (pct > 0 ? ' exp-kpi__delta--bad' : ' exp-kpi__delta--good');
  return `<span class="exp-kpi__delta${tone}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}% vs previous ${esc(periodNoun(range))}</span>`;
}

function periodNoun(range) {
  return { '24h': '24 hours', '72h': '72 hours', '7d': '7 days', '1m': 'month', '3m': '3 months', '6m': '6 months', '1y': 'year', '2y': '2 years', custom: 'period' }[range.period] || 'period';
}

function kpiGrid(ctx) {
  const { money } = ctx.fmt;
  const k = ctx.getState().kpis || {};
  const range = ctx.getRange();
  const grossSub = (k.spendGross && Math.abs(k.spendGross - k.spend) > 0.01)
    ? `${money(k.spendGross)} gross cash out`
    : 'GST-netted, matches P&L';
  const cards = [
    {
      label: `Operating spend · ${range.periodLabel}`, value: money(k.spend || 0),
      sub: `${deltaHtml(k, range)}<span class="exp-kpi__note" title="Cash basis: only expenses marked paid, on their paid date, GST-netted, operating only — the same figure Finance → P&amp;L books.">${esc(grossSub)}</span>`,
      tone: '',
    },
    { label: 'Overdue', value: money(k.overdue || 0), sub: k.overdue > 0 ? 'needs paying now — by due date' : 'all clear', tone: k.overdue > 0 ? 'bad' : 'good' },
    { label: 'Due (unpaid)', value: money(k.unpaid || 0), sub: 'open amounts by due date — not period-scoped', tone: k.unpaid > 0 ? 'warn' : '' },
    { label: 'Recurring commitment', value: money(k.recurringMonthly || 0), sub: 'per month, active series only', tone: '' },
  ];
  const secondary = [
    { label: 'Upcoming (next 30d)', value: money(k.upcoming30 || 0), title: 'Open amounts due in the next 30 days, gross.' },
    { label: 'Largest category', value: k.largestCategory ? `${categoryLabel(k.largestCategory.key)} · ${money(k.largestCategory.total)}` : '—', title: 'Biggest paid operating category in the period, GST-netted.' },
    { label: 'Avg expense', value: k.avgExpense != null ? money(k.avgExpense) : '—', title: `Average paid operating expense in the period (${k.txnCount || 0} transactions), GST-netted.` },
    { label: 'GST reclaim', value: money(k.gstReclaim || 0), title: 'GST input credits embedded in the period\'s paid claimable expenses.' },
    { label: 'Order-linked (excluded)', value: money(k.orderLinked || 0), title: 'Already counted in per-order costs — never added to operating spend.' },
  ];
  return `
    <div class="exp-kpi-grid exp-kpi-grid--primary">${cards.map(c => `
      <div class="exp-kpi exp-kpi--${c.tone || 'plain'}">
        <div class="exp-kpi__label">${esc(c.label)}</div>
        <div class="exp-kpi__value">${esc(c.value)}</div>
        <div class="exp-kpi__sub">${c.sub}</div>
      </div>`).join('')}</div>
    <div class="exp-kpi-strip">${secondary.map(s => `
      <div class="exp-kpi-strip__item" title="${ctx.fmt.escA(s.title)}">
        <span class="exp-kpi-strip__label">${esc(s.label)}</span>
        <span class="exp-kpi-strip__value">${esc(s.value)}</span>
      </div>`).join('')}</div>`;
}

function upcomingHtml(ctx) {
  const { money, fmtDate, statusBadge } = ctx.fmt;
  const { occurrences } = ctx.getState();
  const today = ctx.fmt.todayUtcMs();
  const horizon = today + 30 * 86400000;
  const items = occurrences
    .filter(o => o.kind !== 'order_linked' && o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped')
    .filter(o => { const d = parseUtcDate(o.due_date || o.expense_date); return d <= horizon; })
    .sort((a, b) => parseUtcDate(a.due_date || a.expense_date) - parseUtcDate(b.due_date || b.expense_date))
    .slice(0, 14);
  if (!items.length) return '<div class="exp-empty-inline">Nothing due in the next 30 days.</div>';
  return `<ul class="exp-upcoming-list">${items.map(o => {
    const due = o.due_date || o.expense_date;
    const projected = o.projected ? '<span class="exp-tag exp-tag--projected" title="Projected from a recurring rule — not yet a saved occurrence">projected</span>' : '';
    return `<li class="exp-upcoming-item exp-upcoming-item--${o.status}">
      <div class="exp-upcoming-item__main">
        <span class="exp-upcoming-item__name">${esc(o.name || o.payee || categoryLabel(o.category))}</span>
        ${projected}
      </div>
      <div class="exp-upcoming-item__meta">${statusBadge(o.status)} <span class="exp-upcoming-item__date">${esc(fmtDate(due))}</span></div>
      <div class="exp-upcoming-item__amt">${esc(money(o.amount))}</div>
    </li>`;
  }).join('')}</ul>`;
}

async function renderTrendChart(ctx) {
  const { money } = ctx.fmt;
  const range = ctx.getRange();
  const { occurrences } = ctx.getState();
  const buckets = bucketExpenses(occurrences, range.fromMs, range.toMs, range.grain);
  const canvas = _host?.querySelector('#exp-trend');
  if (!buckets.length) {
    if (canvas) canvas.parentElement.innerHTML = '<div class="exp-empty-inline">No operating expenses <strong>paid</strong> in this period. Mark an expense paid and it lands here on its paid date.</div>';
    return;
  }
  const colors = Charts.getThemeColors();
  await Charts.bar('exp-trend', {
    labels: buckets.map(b => b.key),
    datasets: [{ label: 'Operating expenses paid', data: buckets.map(b => b.total), backgroundColor: colors.magenta, borderRadius: 4 }],
    options: { plugins: { tooltip: { callbacks: { label: (c) => `Expenses: ${money(c.parsed.y)}` } } } },
  });
}

async function renderDoughnut(ctx) {
  const { money } = ctx.fmt;
  const breakdown = (ctx.getState().catBreakdown || []).slice(0, 8);
  const legend = _host?.querySelector('#exp-legend');
  if (!breakdown.length) {
    const c = _host?.querySelector('.exp-doughnut-wrap');
    if (c) c.innerHTML = '<div class="exp-empty-inline">No <strong>paid</strong> operating spend to break down yet.</div>';
    return;
  }
  const palette = ['#267FB5', '#C71F6E', '#F4C430', '#34D399', '#8B5CF6', '#F97316', '#06B6D4', '#94A3B8'];
  await Charts.doughnut('exp-doughnut', {
    labels: breakdown.map(b => categoryLabel(b.key)),
    data: breakdown.map(b => b.total),
    colors: palette,
    options: { plugins: { tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } } },
  });
  if (legend) {
    legend.innerHTML = breakdown.map((b, i) => `<div class="exp-legend__row"><span class="exp-legend__dot" style="background:${palette[i % palette.length]}"></span><span class="exp-legend__label">${esc(categoryLabel(b.key))}</span><span class="exp-legend__val">${esc(money(b.total))} · ${b.pct.toFixed(0)}%</span></div>`).join('');
  }
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  const range = ctx.getRange();
  host.innerHTML = `
    ${kpiGrid(ctx)}
    <div class="exp-cols">
      <div class="admin-card exp-upcoming">
        <div class="admin-card__title">Upcoming &amp; overdue <small>next 30 days · by due date</small></div>
        <div id="exp-upcoming-body">${upcomingHtml(ctx)}</div>
      </div>
      <div class="admin-card exp-breakdown">
        <div class="admin-card__title">Where the money goes <small>paid · GST-netted · ${esc(range.periodLabel.toLowerCase())}</small></div>
        <div class="exp-doughnut-wrap"><canvas id="exp-doughnut"></canvas></div>
        <div id="exp-legend" class="exp-legend"></div>
      </div>
    </div>
    <div class="admin-card admin-mb-lg">
      <div class="admin-card__title">Operating expenses paid <small>cash basis — by paid date · ${esc(range.grain)} buckets</small></div>
      <div class="admin-chart-box admin-chart-box--tall"><canvas id="exp-trend"></canvas></div>
    </div>
    <div id="exp-hidden-note"></div>`;

  // The compact hidden-rows cue: on Overview a fully period-hidden dataset is
  // just as confusing as on the table — reuse the shell's loud note.
  ctx.updateHiddenNote(ctx.filteredRows().length);

  await Promise.all([renderTrendChart(ctx), renderDoughnut(ctx)]);
}

export default {
  id: 'overview',
  render,
  destroy() {
    _host = null;
    _ctx = null;
  },
};
