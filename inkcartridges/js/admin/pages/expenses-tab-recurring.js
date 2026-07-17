/**
 * Expenses → Recurring tab — committed subscriptions and repeating bills.
 *
 * Period-INDEPENDENT by design: a commitment doesn't stop existing because the
 * period bar is on "Last month" — templates always show, and the card subtitle
 * says so. Commitment math comes from utils/expense-math.js (weekly ×52/12,
 * fortnightly ×26/12, quarterly ÷3, yearly ÷12, custom ×365/(12·N); paused and
 * ended series never count).
 *
 * Pure renderer over the shell's ctx (see pages/expenses.js).
 */
import { icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { categoryLabel } from '../utils/expense-categories.js';
import { describeRecurrence } from '../utils/expense-recurrence.js';
import { monthlyCommitment, recurringMonthlyCommitment } from '../utils/expense-math.js';

let _host = null;
let _ctx = null;
let _table = null;

function templates(ctx) {
  return ctx.getState().rows.filter(r => r.recurring);
}

function kpiRow(ctx) {
  const { money } = ctx.fmt;
  const all = templates(ctx);
  const active = all.filter(t => t.series_state === 'active');
  const paused = all.filter(t => t.series_state === 'paused');
  const monthly = recurringMonthlyCommitment(all);
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

function buildColumns(ctx) {
  const { money, fmtDate, statusBadge, escA } = ctx.fmt;
  return [
    { key: 'name', label: 'Series', render: (r) => `<div class="exp-cell-name"><strong>${esc(r.name || categoryLabel(r.category))}</strong>${r.payee ? `<span class="cell-muted">${esc(r.payee)}</span>` : ''}</div>` },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${esc(money(r.amount))}</span>` },
    { key: 'monthly', label: '≈ Monthly', align: 'right', sortable: true, render: (r) => `<span class="cell-mono" title="Normalised to a monthly figure for the commitment KPI">${esc(money(monthlyCommitment(r)))}</span>` },
    { key: 'recurrence', label: 'Schedule', render: (r) => esc(describeRecurrence(r)) },
    { key: 'category', label: 'Category', render: (r) => esc(categoryLabel(r.category)) },
    { key: 'started', label: 'Started', sortable: true, render: (r) => esc(fmtDate(r.expense_date)) },
    { key: 'next', label: 'Next due', sortable: true, render: (r) => r._next ? esc(fmtDate(r._next)) : '<span class="cell-muted">—</span>' },
    { key: 'state', label: 'State', render: (r) => statusBadge(r.series_state) },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => {
        const parts = [`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="edit" data-id="${escA(r.id)}" title="Edit schedule">Edit</button>`];
        if (r.series_state === 'active') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="pause" data-id="${escA(r.id)}" title="Pause series">Pause</button>`);
        if (r.series_state === 'paused') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="resume" data-id="${escA(r.id)}" title="Resume series">Resume</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="duplicate" data-id="${escA(r.id)}" title="Duplicate">${icon('copy', 13, 13)}</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${escA(r.id)}" title="Delete series">${icon('trash', 13, 13)}</button>`);
        return parts.join(' ');
      },
    },
  ];
}

const SORTS = {
  amount: (a, b) => a.amount - b.amount,
  monthly: (a, b) => monthlyCommitment(a) - monthlyCommitment(b),
  started: (a, b) => String(a.expense_date).localeCompare(String(b.expense_date)),
  next: (a, b) => String(a._next || '9999').localeCompare(String(b._next || '9999')),
};
let _sortKey = 'monthly';
let _sortDir = 'desc';

function refreshTable() {
  if (!_table || !_ctx) return;
  const rows = templates(_ctx).slice();
  const cmp = SORTS[_sortKey] || SORTS.monthly;
  rows.sort((a, b) => (_sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
  _table.setData(rows, { total: rows.length, page: 1, limit: Math.max(rows.length, 20) });
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  host.innerHTML = `
    ${kpiRow(ctx)}
    <div class="admin-card admin-mb-0">
      <div class="admin-card__title">Recurring series <small>period-independent — commitments always show</small></div>
      <div id="exp-recurring-table"></div>
    </div>`;

  const mount = host.querySelector('#exp-recurring-table');
  _table = new DataTable(mount, {
    columns: buildColumns(ctx),
    rowKey: 'id',
    tableClass: 'admin-table--colsized',
    emptyMessage: 'No recurring expenses yet',
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
  mount.addEventListener('click', ctx.onRowAction);
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
