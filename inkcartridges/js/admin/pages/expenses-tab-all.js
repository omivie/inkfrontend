/**
 * Expenses → All expenses tab — the record table IS the page.
 *
 * Pure renderer over the shell's ctx (see pages/expenses.js): data, filters,
 * actions and persistence all live in the shell; this module owns only its DOM
 * (toolbar, hidden-note slot, DataTable) and its local view state (page/limit).
 * Never touches browser storage or the network directly.
 */
import { icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { categoryLabel } from '../utils/expense-categories.js';
import { describeRecurrence } from '../utils/expense-recurrence.js';

let _host = null;
let _ctx = null;
let _table = null;
let _page = 1;
let _limit = 50;
let _searchDebounce = null;

function buildColumns(ctx) {
  const { money, fmtDate, statusBadge, escA } = ctx.fmt;
  return [
    { key: 'name', label: 'Expense', render: (r) => `<div class="exp-cell-name"><strong>${esc(r.name || categoryLabel(r.category))}</strong>${r.payee ? `<span class="cell-muted">${esc(r.payee)}</span>` : ''}</div>` },
    { key: 'category', label: 'Category', render: (r) => `${esc(categoryLabel(r.category))} ${r.kind === 'order_linked' ? `<span class="exp-tag exp-tag--linked" title="Already counted in per-order costs — excluded from operating expenses">order-linked</span>` : ''}` },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${esc(money(r.amount))}</span>` },
    { key: 'gst', label: 'GST', align: 'center', render: (r) => r.gst_claimable ? `<span class="cell-muted" title="Claimable NZ GST — netted from profit">incl</span>` : `<span class="cell-muted" title="No GST credit">—</span>` },
    { key: 'status', label: 'Status', render: (r) => statusBadge(r._status) },
    { key: 'expense_date', label: 'Date', sortable: true, render: (r) => esc(fmtDate(r.expense_date)) },
    { key: 'due_date', label: 'Due', render: (r) => r.due_date ? esc(fmtDate(r.due_date)) : '<span class="cell-muted">—</span>' },
    { key: 'recurrence', label: 'Repeats', render: (r) => r.recurring ? esc(describeRecurrence(r)) : '<span class="cell-muted">One-off</span>' },
    { key: 'next', label: 'Next', render: (r) => r._next ? esc(fmtDate(r._next)) : '<span class="cell-muted">—</span>' },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => {
        const parts = [`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="edit" data-id="${escA(r.id)}" title="Edit">Edit</button>`];
        if (!r.recurring && r._status !== 'paid') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="pay" data-id="${escA(r.id)}" title="Mark paid">${icon('check', 13, 13)}</button>`);
        if (!r.recurring && r._status === 'paid') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="unpay" data-id="${escA(r.id)}" title="Mark unpaid">Unpay</button>`);
        if (r.recurring && r.series_state === 'active') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="pause" data-id="${escA(r.id)}" title="Pause series">Pause</button>`);
        if (r.recurring && r.series_state === 'paused') parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="resume" data-id="${escA(r.id)}" title="Resume series">Resume</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="duplicate" data-id="${escA(r.id)}" title="Duplicate">${icon('copy', 13, 13)}</button>`);
        parts.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${escA(r.id)}" title="Delete">${icon('trash', 13, 13)}</button>`);
        return parts.join(' ');
      },
    },
  ];
}

function toolbarHtml(ctx) {
  const f = ctx.filters.get();
  const { escA } = ctx.fmt;
  return `
    <div class="admin-filters exp-filters">
      <div class="admin-search" style="flex:1;min-width:220px">
        <span class="admin-search__icon">${icon('search', 14, 14)}</span>
        <input class="admin-input" id="exp-search" type="search" placeholder="Search name, payee, notes, reference…" autocomplete="off" value="${escA(f.q)}" style="width:100%;padding-left:32px" aria-label="Search expenses">
      </div>
      <select class="admin-select" id="f-category" aria-label="Filter by category">${ctx.filterCategoryOptions()}</select>
      <select class="admin-select" id="f-status" aria-label="Filter by status">
        <option value="">Any status</option>
        <option value="overdue"${f.status === 'overdue' ? ' selected' : ''}>Overdue</option>
        <option value="due"${f.status === 'due' ? ' selected' : ''}>Due</option>
        <option value="scheduled"${f.status === 'scheduled' ? ' selected' : ''}>Scheduled</option>
        <option value="paid"${f.status === 'paid' ? ' selected' : ''}>Paid</option>
        <option value="active"${f.status === 'active' ? ' selected' : ''}>Active series</option>
        <option value="paused"${f.status === 'paused' ? ' selected' : ''}>Paused series</option>
        <option value="ended"${f.status === 'ended' ? ' selected' : ''}>Ended series</option>
      </select>
      <select class="admin-select" id="f-type" aria-label="Filter by type">
        <option value="">One-off &amp; recurring</option>
        <option value="oneoff"${f.type === 'oneoff' ? ' selected' : ''}>One-off only</option>
        <option value="recurring"${f.type === 'recurring' ? ' selected' : ''}>Recurring only</option>
      </select>
      <select class="admin-select" id="f-method" aria-label="Filter by payment method"><option value="">Any method</option>${_ctx.PAYMENT_METHODS.map(m => `<option value="${m.key}"${f.method === m.key ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <label class="exp-basis-label" title="Which date must fall inside the selected period. The KPI bases never change (spend is always by paid date — cash basis).">Filter dates by
        <select class="admin-select" id="f-basis" aria-label="Date basis for period filtering">
          <option value="incurred"${f.basis === 'incurred' ? ' selected' : ''}>Expense date</option>
          <option value="paid"${f.basis === 'paid' ? ' selected' : ''}>Paid date</option>
          <option value="due"${f.basis === 'due' ? ' selected' : ''}>Due date</option>
        </select>
      </label>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="exp-reset">Reset</button>
    </div>`;
}

function refreshTable() {
  if (!_table || !_ctx) return;
  const all = _ctx.filteredRows();
  const start = (_page - 1) * _limit;
  const pageRows = all.slice(start, start + _limit);
  _table.setData(pageRows, { total: all.length, page: _page, limit: _limit });
  _ctx.updateHiddenNote(all.length);
}

function bindToolbar() {
  const $ = (s) => _host.querySelector(s);
  $('#exp-search')?.addEventListener('input', (e) => {
    clearTimeout(_searchDebounce);
    const v = e.target.value;
    _searchDebounce = setTimeout(() => { _ctx.filters.set({ q: v }); _page = 1; refreshTable(); }, 250);
  });
  const wire = (sel, key) => $(sel)?.addEventListener('change', (e) => {
    _ctx.filters.set({ [key]: e.target.value });
    _page = 1;
    refreshTable();
  });
  wire('#f-category', 'cat');
  wire('#f-status', 'status');
  wire('#f-type', 'type');
  wire('#f-method', 'method');
  wire('#f-basis', 'basis');
  $('#exp-reset')?.addEventListener('click', () => {
    _ctx.filters.set({ cat: '', status: '', type: '', method: '', q: '', basis: 'incurred' });
    _page = 1;
    // Rebuild the toolbar so the controls reflect the cleared state.
    render(_host, _ctx);
  });
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  host.innerHTML = `
    <div class="admin-card admin-mb-0">
      ${toolbarHtml(ctx)}
      <div id="exp-hidden-note"></div>
      <div id="exp-table"></div>
    </div>`;

  const mount = host.querySelector('#exp-table');
  _table = new DataTable(mount, {
    columns: buildColumns(ctx),
    rowKey: 'id',
    tableClass: 'admin-table--colsized',
    emptyMessage: 'No expenses match your filters',
    emptyIcon: icon('invoice', 28, 28),
    onRowClick: (row) => ctx.openDetail(row),
    onPageChange: (p) => { _page = p; refreshTable(); },
    onLimitChange: (l) => { _limit = l; _page = 1; refreshTable(); },
  });
  mount.addEventListener('click', ctx.onRowAction);
  bindToolbar();
  refreshTable();
}

export default {
  id: 'all',
  render,
  destroy() {
    clearTimeout(_searchDebounce);
    _searchDebounce = null;
    _table?.destroy?.();
    _table = null;
    _host = null;
    _ctx = null;
    _page = 1;
  },
};
