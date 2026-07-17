/**
 * Expenses → Recurring tab — committed subscriptions and repeating bills.
 *
 * Period-INDEPENDENT by design: a commitment doesn't stop existing because the
 * period bar is on "Last month" — templates always show, and the card subtitle
 * says so. Commitment math comes from utils/expense-math.js (weekly ×52/12,
 * fortnightly ×26/12, quarterly ÷3, yearly ÷12, custom ×365/(12·N); paused and
 * ended series never count). The 30/60/90-day cash chips are projected GROSS
 * amounts — what will actually leave the bank, not the netted P&L figure.
 *
 * Pure renderer over the shell's ctx (see pages/expenses.js).
 */
import { icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { categoryLabel } from '../utils/expense-categories.js';
import { describeRecurrence, expandExpenseOccurrences, parseUtcDate } from '../utils/expense-recurrence.js';
import { monthlyCommitment, recurringMonthlyCommitment } from '../utils/expense-math.js';

let _host = null;
let _ctx = null;
let _table = null;
let _sortKey = 'monthly';
let _sortDir = 'desc';

const MS_DAY = 86400000;

function templates(ctx) {
  return ctx.getState().rows.filter(r => r.recurring);
}

/**
 * Display state: a series whose recurrence_end has passed reads as ENDED even
 * if the stored series_state lags behind (see the /end fallback below).
 */
function effectiveState(ctx, r) {
  if (r.series_state !== 'active') return r.series_state;
  const end = parseUtcDate(r.recurrence_end);
  return (Number.isFinite(end) && end < ctx.fmt.todayUtcMs()) ? 'ended' : 'active';
}

function kpiRow(ctx) {
  const { money } = ctx.fmt;
  const all = templates(ctx);
  const active = all.filter(t => effectiveState(ctx, t) === 'active');
  const paused = all.filter(t => t.series_state === 'paused');
  const monthly = recurringMonthlyCommitment(all, ctx.fmt.todayUtcMs());
  const cards = [
    { label: 'Monthly commitment', value: money(monthly), sub: 'active series, normalised to monthly', tone: '' },
    { label: 'Annualised', value: money(monthly * 12), sub: 'monthly commitment × 12', tone: '' },
    { label: 'Active series', value: String(active.length), sub: active.length ? 'projecting occurrences' : 'none yet', tone: active.length ? 'good' : 'plain' },
    { label: 'Paused', value: String(paused.length), sub: paused.length ? 'not counted in commitment' : 'none', tone: paused.length ? 'warn' : 'plain' },
  ];
  return `<div class="exp-kpi-grid exp-kpi-grid--primary">${cards.map(c => `
    <div class="exp-kpi exp-kpi--${c.tone || 'plain'}">
      <div class="exp-kpi__label">${esc(c.label)}</div>
      <div class="exp-kpi__value">${esc(c.value)}</div>
      <div class="exp-kpi__sub">${esc(c.sub)}</div>
    </div>`).join('')}</div>`;
}

/**
 * Projected recurring cash out over the next 30/60/90 days — expanded fresh
 * from the ACTIVE templates (the shell's occurrence window only guarantees
 * +30d, so the longer horizons project locally; the expander is pure + cheap).
 * Gross amounts: this is a cash-requirement figure, not a P&L one.
 */
function cashAheadChips(ctx) {
  const { money } = ctx.fmt;
  const today = ctx.fmt.todayUtcMs();
  const active = templates(ctx).filter(t => effectiveState(ctx, t) === 'active');
  const horizons = [30, 60, 90];
  const sums = horizons.map(days => {
    let sum = 0;
    for (const t of active) {
      for (const o of expandExpenseOccurrences({ ...t }, today, today + days * MS_DAY)) {
        sum += Number(o.amount) || 0;
      }
    }
    return sum;
  });
  return `<div class="exp-kpi-strip exp-kpi-strip--table" title="Projected recurring payments from active series — gross cash out, not GST-netted.">
    ${horizons.map((d, i) => `<div class="exp-kpi-strip__item"><span class="exp-kpi-strip__label">Next ${d} days</span><span class="exp-kpi-strip__value">${esc(money(sums[i]))}</span></div>`).join('')}
  </div>`;
}

/** Commitment share per category (active series only) — mini ranked bars. */
function commitmentByCategory(ctx) {
  const { money } = ctx.fmt;
  const active = templates(ctx).filter(t => effectiveState(ctx, t) === 'active');
  const map = new Map();
  for (const t of active) {
    const key = t.category || 'other';
    map.set(key, (map.get(key) || 0) + monthlyCommitment(t));
  }
  const rows = [...map.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => b.total - a.total);
  if (!rows.length) return '<div class="exp-empty-inline">No active recurring series yet.</div>';
  const max = rows[0].total || 1;
  return `<div class="exp-cat-bars">${rows.map(b => `
    <div class="exp-cat-bar" role="listitem">
      <span class="exp-cat-bar__label">${esc(categoryLabel(b.key))}</span>
      <span class="exp-cat-bar__track"><span class="exp-cat-bar__fill" style="width:${Math.max(2, (b.total / max) * 100).toFixed(1)}%"></span></span>
      <span class="exp-cat-bar__meta">${esc(money(b.total))} / month</span>
    </div>`).join('')}</div>`;
}

/** Most recent PAID occurrence for a series, from the loaded occurrence window. */
function lastPaidOf(ctx, seriesId) {
  let best = null;
  for (const o of ctx.getState().occurrences) {
    if (String(o.series_id) !== String(seriesId) || o.status !== 'paid') continue;
    if (!best || String(o.expense_date) > best) best = o.expense_date;
  }
  return best;
}

function buildColumns(ctx) {
  const { money, fmtDate, statusBadge, escA } = ctx.fmt;
  return [
    { key: 'name', label: 'Series', sortable: true, render: (r) => `<div class="exp-cell-name"><strong>${esc(r.name || categoryLabel(r.category))}</strong>${r.payee ? `<span class="cell-muted">${esc(r.payee)}</span>` : ''}</div>` },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${esc(money(r.amount))}</span>` },
    { key: 'monthly', label: '≈ Monthly', align: 'right', sortable: true, render: (r) => `<span class="cell-mono" title="Normalised to a monthly figure for the commitment KPI">${esc(money(monthlyCommitment(r)))}</span>` },
    { key: 'recurrence', label: 'Schedule', render: (r) => esc(describeRecurrence(r)) },
    { key: 'category', label: 'Category', sortable: true, render: (r) => esc(categoryLabel(r.category)) },
    { key: 'started', label: 'Started', sortable: true, render: (r) => esc(fmtDate(r.expense_date)) },
    { key: 'next', label: 'Next due', sortable: true, render: (r) => r._next ? esc(fmtDate(r._next)) : '<span class="cell-muted">—</span>' },
    { key: 'last_paid', label: 'Last paid', render: (r) => { const d = lastPaidOf(ctx, r.id); return d ? esc(fmtDate(d)) : '<span class="cell-muted">—</span>'; } },
    { key: 'state', label: 'State', render: (r) => statusBadge(effectiveState(ctx, r)) },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => {
        const parts = [`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="edit" data-id="${escA(r.id)}" title="Edit schedule">Edit</button>`];
        if (effectiveState(ctx, r) === 'active') {
          parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="pause" data-id="${escA(r.id)}" title="Pause series">Pause</button>`);
          parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-series-end="${escA(r.id)}" title="End series — stops all future occurrences">End</button>`);
        }
        if (r.series_state === 'paused') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="resume" data-id="${escA(r.id)}" title="Resume series">Resume</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="duplicate" data-id="${escA(r.id)}" title="Duplicate">${icon('copy', 13, 13)}</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${escA(r.id)}" title="Delete series">${icon('trash', 13, 13)}</button>`);
        return parts.join(' ');
      },
    },
  ];
}

const SORTS = {
  name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
  amount: (a, b) => a.amount - b.amount,
  monthly: (a, b) => monthlyCommitment(a) - monthlyCommitment(b),
  category: (a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)),
  started: (a, b) => String(a.expense_date).localeCompare(String(b.expense_date)),
  next: (a, b) => String(a._next || '9999').localeCompare(String(b._next || '9999')),
};

function refreshTable() {
  if (!_table || !_ctx) return;
  const rows = templates(_ctx).slice();
  const cmp = SORTS[_sortKey] || SORTS.monthly;
  rows.sort((a, b) => (_sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
  _table.setData(rows, { total: rows.length, page: 1, limit: Math.max(rows.length, 20) });
}

/**
 * Payload for the /end FALLBACK: the backend's update validation wants the
 * full record shape (probed live — a bare {recurrence_end} PUT is silently
 * dropped and a rule-only PUT fails validation), so the row's own fields ride
 * along unchanged with only recurrence_end set. The stored category must be
 * backend-enum-safe: an owner's custom key rides as 'other' (its override-map
 * entry already exists and is keyed by id, so the label is unaffected).
 */
function endFallbackPayload(ctx, row, endIso) {
  const storedCategory = ctx.categories.backendAccepts(row.category) ? row.category : 'other';
  const p = {
    name: row.name, description: row.name,
    payee: row.payee || '', vendor: row.payee || '',
    category: storedCategory,
    amount: row.amount, gst_claimable: !!row.gst_claimable,
    expense_date: row.expense_date, date: row.expense_date,
    due_date: row.due_date || null, method: row.method || null,
    reference: row.reference || null, notes: row.notes || null,
    recurrence: row.recurrence,
    recurrence_end: endIso,
  };
  if (row.recurrence_day_of_week != null) p.recurrence_day_of_week = row.recurrence_day_of_week;
  if (row.recurrence_day_of_month != null) p.recurrence_day_of_month = row.recurrence_day_of_month;
  if (row.recurrence_month != null) p.recurrence_month = row.recurrence_month;
  if (row.recurrence_interval_days != null) p.recurrence_interval_days = row.recurrence_interval_days;
  if (row.recurrence_count != null) p.recurrence_count = row.recurrence_count;
  return p;
}

function onEndSeries(e) {
  const btn = e.target.closest('[data-series-end]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.seriesEnd;
  const row = templates(_ctx).find(r => String(r.id) === String(id));
  if (!row) return;
  const today = _ctx.fmt.todayInputValue();
  // An end date can't precede the series start (validation). A series that
  // hasn't started yet ends ON its start date — one final occurrence remains;
  // Delete is the tool for "never happened at all", and the confirm says so.
  const notStarted = String(row.expense_date) > today;
  const endIso = notStarted ? row.expense_date : today;
  Modal.confirm({
    title: 'End recurring series',
    message: notStarted
      ? `"${row.name || categoryLabel(row.category)}" hasn't started yet — ending it now makes its first occurrence (${_ctx.fmt.fmtDate(row.expense_date)}) also its last. If it should never occur at all, use Delete instead.`
      : `End "${row.name || categoryLabel(row.category)}" today (${today})? No further occurrences will be projected or created; past occurrences are untouched. This is how a cancelled subscription is recorded.`,
    confirmLabel: 'End series',
    onConfirm: async () => {
      await _ctx.guardedWrite(async () => {
        try {
          await _ctx.api.end(id, { end_date: endIso });
        } catch (err) {
          // The documented /end endpoint 500s (ERR-094, backend bug). Writing
          // recurrence_end via the update path stops projections and drops the
          // series from the commitment math identically — same outcome.
          await _ctx.api.update(id, endFallbackPayload(_ctx, row, endIso));
        }
      }, 'Series ended.');
    },
  });
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  host.innerHTML = `
    ${kpiRow(ctx)}
    ${cashAheadChips(ctx)}
    <div class="exp-cols">
      <div class="admin-card">
        <div class="admin-card__title">Commitment by category <small>active series · normalised monthly</small></div>
        ${commitmentByCategory(ctx)}
      </div>
      <div class="admin-card">
        <div class="admin-card__title">About these figures</div>
        <p class="exp-subtitle" style="margin:0">Commitments are period-independent — they always show regardless of the date range above. Amounts here are GROSS (what leaves the bank); the P&amp;L nets claimable GST out. Pausing a series stops projections and removes it from the commitment; ending it is permanent and records a cancelled subscription.</p>
      </div>
    </div>
    <div class="admin-card admin-mb-0">
      <div class="admin-card__title">Recurring series <small>period-independent — commitments always show</small></div>
      <div id="exp-recurring-table"></div>
    </div>`;

  const mount = host.querySelector('#exp-recurring-table');
  _table = new DataTable(mount, {
    columns: buildColumns(ctx),
    rowKey: 'id',
    tableClass: 'admin-table--colsized',
    emptyMessage: 'No recurring expenses yet — use "Add expense" and switch to Repeating',
    emptyIcon: icon('refresh', 28, 28),
    onRowClick: (row) => ctx.openDetail(row),
    onSort: (key, dir) => {
      if (!SORTS[key]) return;
      _sortKey = key;
      _sortDir = dir || 'desc';
      _table.setSort(key, _sortDir);
      refreshTable();
    },
  });
  _table.setSort(_sortKey, _sortDir);
  mount.addEventListener('click', ctx.onRowAction);
  mount.addEventListener('click', onEndSeries);
  refreshTable();
}

export default {
  id: 'recurring',
  render,
  destroy() {
    _table?.destroy?.();
    _table = null;
    _host = null;
    _ctx = null;
  },
};
