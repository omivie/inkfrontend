/**
 * Expenses → All expenses tab — the record table IS the page.
 *
 * Data-dense view over the shell's ctx (see pages/expenses.js): summary strip,
 * quick-view chips, a compact filter toolbar with a DATE-BASIS selector
 * (which date must fall inside the global period — the KPI bases never
 * switch), a column-configurable DataTable with bulk actions, and the ERR-090
 * hidden-rows note.
 *
 * Bulk writes are SEQUENTIAL with exponential backoff on RATE_LIMITED (the
 * backend rate-limits per-row writes) and always end in ONE reload + an honest
 * summary toast — failures are named, never swallowed.
 *
 * This module owns only its DOM and view state (page/limit/sort/columns);
 * data, filters, actions and persistence live in the shell. Column visibility
 * persists via AdminAPI.setUiPref ('expenses.columns') — the same per-admin
 * Supabase store the products column picker uses; never browser storage.
 */
import { icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { categoryLabel, operatingCategories, orderLinkedCategories } from '../utils/expense-categories.js';
import { describeRecurrence, parseUtcDate } from '../utils/expense-recurrence.js';
import { pnlCost, gstCredit } from '../utils/expense-math.js';

let _host = null;
let _ctx = null;
let _table = null;
let _page = 1;
let _limit = 50;
let _searchDebounce = null;
let _sortKey = 'date';
let _sortDir = 'desc';
let _hiddenCols = null;      // Set of hidden column keys (null until prefs load)
let _lastPersistedCols = null;
let _bulkBar = null;
let _bulkRunning = false;
let _lastFiltered = [];

const COLUMN_PREF_KEY = 'expenses.columns';
const LOCKED_VISIBLE = new Set(['date', 'name', 'amount', 'actions']);
const DEFAULT_HIDDEN = ['paid_date', 'method', 'ex_gst', 'gst_amt', 'reference', 'created'];
const COLUMN_LABELS = {
  date: 'Date', name: 'Expense', category: 'Category', amount: 'Amount', gst: 'GST',
  status: 'Status', due_date: 'Due', recurrence: 'Repeats', next: 'Next',
  paid_date: 'Paid on', method: 'Method', ex_gst: 'Ex-GST', gst_amt: 'GST $',
  reference: 'Reference', created: 'Created', actions: 'Actions',
};

const BASIS_LABEL = { incurred: 'Expense date', paid: 'Paid date', due: 'Due date' };
const basisDateOf = (r, basis) => (basis === 'paid' ? r.paid_date : basis === 'due' ? r.due_date : r.expense_date);

function buildColumns(ctx) {
  const { money, fmtDate, statusBadge, escA } = ctx.fmt;
  const basis = ctx.filters.get().basis;
  return [
    { key: 'date', label: BASIS_LABEL[basis] || 'Date', sortable: true, render: (r) => esc(fmtDate(basisDateOf(r, basis) || r.expense_date)) },
    { key: 'name', label: 'Expense', sortable: true, render: (r) => `<div class="exp-cell-name"><strong>${esc(r.name || categoryLabel(r.category))}</strong>${r.payee ? `<span class="cell-muted">${esc(r.payee)}</span>` : ''}</div>` },
    { key: 'category', label: 'Category', sortable: true, render: (r) => `${esc(categoryLabel(r.category))} ${r.kind === 'order_linked' ? `<span class="exp-tag exp-tag--linked" title="Already counted in per-order costs — excluded from operating expenses">order-linked</span>` : ''}` },
    { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => `<span class="cell-mono" title="GST-inclusive">${esc(money(r.amount))}</span>` },
    { key: 'gst', label: 'GST', align: 'center', render: (r) => r.gst_claimable ? `<span class="cell-muted" title="Claimable NZ GST — netted from profit">incl</span>` : `<span class="cell-muted" title="No GST credit">—</span>` },
    { key: 'status', label: 'Status', render: (r) => statusBadge(r._status) },
    { key: 'due_date', label: 'Due', sortable: true, render: (r) => r.due_date ? esc(fmtDate(r.due_date)) : '<span class="cell-muted">—</span>' },
    { key: 'recurrence', label: 'Repeats', render: (r) => r.recurring ? esc(describeRecurrence(r)) : '<span class="cell-muted">One-off</span>' },
    { key: 'next', label: 'Next', sortable: true, render: (r) => r._next ? esc(fmtDate(r._next)) : '<span class="cell-muted">—</span>' },
    { key: 'paid_date', label: 'Paid on', sortable: true, render: (r) => r.paid_date ? esc(fmtDate(r.paid_date)) : '<span class="cell-muted">—</span>' },
    { key: 'method', label: 'Method', render: (r) => esc(ctx.fmt.methodLabel(r.method)) },
    { key: 'ex_gst', label: 'Ex-GST', align: 'right', sortable: true, render: (r) => `<span class="cell-mono" title="P&L cost — GST netted out when claimable">${esc(money(pnlCost(r.amount, !!r.gst_claimable)))}</span>` },
    { key: 'gst_amt', label: 'GST $', align: 'right', sortable: true, render: (r) => `<span class="cell-mono" title="Reclaimable GST input credit">${esc(money(gstCredit(r.amount, !!r.gst_claimable)))}</span>` },
    { key: 'reference', label: 'Reference', render: (r) => esc(r.reference || r.invoice_number || '—') },
    { key: 'created', label: 'Created', sortable: true, render: (r) => r.created_at ? esc(fmtDate(String(r.created_at).slice(0, 10))) : '<span class="cell-muted">—</span>' },
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

function visibleColumns(ctx) {
  const cols = buildColumns(ctx);
  const hidden = _hiddenCols || new Set(DEFAULT_HIDDEN);
  return cols.filter(c => LOCKED_VISIBLE.has(c.key) || !hidden.has(c.key));
}

// ─── sorting (callback-only per DataTable; the tab owns the comparators) ─────
function comparator(key, ctx) {
  const basis = ctx.filters.get().basis;
  const byDate = (get) => (a, b) => (parseUtcDate(get(a)) || 0) - (parseUtcDate(get(b)) || 0);
  const map = {
    date: byDate(r => basisDateOf(r, basis) || r.expense_date),
    due_date: byDate(r => r.due_date),
    paid_date: byDate(r => r.paid_date),
    next: byDate(r => r._next),
    created: byDate(r => String(r.created_at || '').slice(0, 10)),
    amount: (a, b) => a.amount - b.amount,
    ex_gst: (a, b) => pnlCost(a.amount, !!a.gst_claimable) - pnlCost(b.amount, !!b.gst_claimable),
    gst_amt: (a, b) => gstCredit(a.amount, !!a.gst_claimable) - gstCredit(b.amount, !!b.gst_claimable),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    category: (a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)),
  };
  return map[key] || map.date;
}

// ─── quick-view chips ────────────────────────────────────────────────────────
const CHIPS = [
  { id: 'all', label: 'All', patch: { status: '', type: '' } },
  { id: 'paid', label: 'Paid', patch: { status: 'paid', type: '' } },
  { id: 'unpaid', label: 'Unpaid', patch: { status: 'unpaid', type: '' } },
  { id: 'overdue', label: 'Overdue', patch: { status: 'overdue', type: '' } },
  { id: 'upcoming', label: 'Upcoming', patch: { status: 'scheduled', type: '' } },
  { id: 'recurring', label: 'Recurring', patch: { status: '', type: 'recurring' } },
];

function activeChipId(f) {
  for (const c of CHIPS) {
    if ((f.status || '') === c.patch.status && (f.type || '') === c.patch.type) return c.id;
  }
  return null; // a manual filter combination no chip represents
}

function chipsHtml(ctx) {
  const f = ctx.filters.get();
  const active = activeChipId(f);
  return `<div class="exp-chips" role="group" aria-label="Quick views">${CHIPS.map(c =>
    `<button class="exp-chip${c.id === active ? ' exp-chip--active' : ''}" data-chip="${c.id}" aria-pressed="${c.id === active}">${esc(c.label)}</button>`).join('')}</div>`;
}

// ─── summary strip (over the CURRENT filtered set; gross = incl GST) ─────────
function summaryHtml(ctx, rows) {
  const { money } = ctx.fmt;
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const paid = rows.filter(r => r._status === 'paid').reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const unpaid = rows.filter(r => r._status === 'overdue' || r._status === 'due' || r._status === 'scheduled')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const items = [
    ['Matching', String(rows.length)],
    ['Total (incl GST)', money(total)],
    ['Paid (incl GST)', money(paid)],
    ['Unpaid (incl GST)', money(unpaid)],
  ];
  return `<div class="exp-kpi-strip exp-kpi-strip--table" id="exp-table-summary">${items.map(([l, v]) =>
    `<div class="exp-kpi-strip__item"><span class="exp-kpi-strip__label">${esc(l)}</span><span class="exp-kpi-strip__value">${esc(v)}</span></div>`).join('')}</div>`;
}

// ─── toolbar ─────────────────────────────────────────────────────────────────
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
        <option value="unpaid"${f.status === 'unpaid' ? ' selected' : ''}>Unpaid (overdue + due)</option>
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
      <div class="admin-colpicker">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="exp-cols-btn" aria-haspopup="menu" aria-expanded="false">${icon('settings', 13, 13)} Columns</button>
        <div class="admin-colpicker__panel" id="exp-cols-panel" role="menu" hidden></div>
      </div>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="exp-reset">Reset</button>
    </div>`;
}

// ─── column picker (products.js pattern; persisted per admin) ────────────────
async function loadColumnPrefs(ctx) {
  if (_hiddenCols) return;
  try {
    const prefs = await ctx.api.getUiPrefs();
    const stored = prefs?.[COLUMN_PREF_KEY]?.hidden;
    _hiddenCols = new Set(Array.isArray(stored) ? stored.filter(k => COLUMN_LABELS[k] && !LOCKED_VISIBLE.has(k)) : DEFAULT_HIDDEN);
  } catch (_) {
    _hiddenCols = new Set(DEFAULT_HIDDEN);
  }
}

function persistColumnPrefs(ctx) {
  const serialized = JSON.stringify([..._hiddenCols].sort());
  if (serialized === _lastPersistedCols) return;
  _lastPersistedCols = serialized;
  ctx.api.setUiPref(COLUMN_PREF_KEY, { hidden: JSON.parse(serialized) });
}

function renderColumnPanel(ctx) {
  const panel = _host?.querySelector('#exp-cols-panel');
  if (!panel) return;
  const keys = buildColumns(ctx).map(c => c.key).filter(k => k !== 'actions');
  panel.innerHTML = `
    <div class="admin-colpicker__head"><span>Columns</span><button class="admin-btn admin-btn--ghost admin-btn--sm" data-cols-reset>Reset</button></div>
    ${keys.map(k => {
      const locked = LOCKED_VISIBLE.has(k);
      const on = locked || !_hiddenCols.has(k);
      return `<label class="admin-colpicker__row${locked ? ' admin-colpicker__row--locked' : ''}">
        <input type="checkbox" data-col-key="${k}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span>${esc(COLUMN_LABELS[k] || k)}</span>${locked ? '<em>always on</em>' : ''}
      </label>`;
    }).join('')}
    <div class="admin-colpicker__foot">Saved to your admin account — synced to every device you sign in on.</div>`;
}

function bindColumnPicker(ctx) {
  const btn = _host?.querySelector('#exp-cols-btn');
  const panel = _host?.querySelector('#exp-cols-panel');
  if (!btn || !panel) return;
  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    const open = panel.hidden;
    if (open) { renderColumnPanel(ctx); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
    else close();
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('.admin-colpicker')) close();
  }, { capture: true });
  panel.addEventListener('change', (e) => {
    const key = e.target?.dataset?.colKey;
    if (!key) return;
    if (e.target.checked) _hiddenCols.delete(key);
    else _hiddenCols.add(key);
    persistColumnPrefs(ctx);
    _table?.setColumns(visibleColumns(ctx));
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-cols-reset]')) {
      _hiddenCols = new Set(DEFAULT_HIDDEN);
      persistColumnPrefs(ctx);
      renderColumnPanel(ctx);
      _table?.setColumns(visibleColumns(ctx));
    }
  });
}

// ─── bulk actions ────────────────────────────────────────────────────────────
function removeBulkBar() {
  _bulkBar?.remove();
  _bulkBar = null;
}

function selectedRows() {
  const sel = _table?.getSelected?.() || new Set();
  return _lastFiltered.filter(r => sel.has(String(r.id)));
}

function updateBulkBar(ctx) {
  const rows = selectedRows();
  if (!rows.length || _bulkRunning) { if (!_bulkRunning) removeBulkBar(); return; }
  if (!_bulkBar) {
    _bulkBar = document.createElement('div');
    _bulkBar.className = 'admin-bulk-bar';
    document.body.appendChild(_bulkBar);
    _bulkBar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-bulk]')?.dataset.bulk;
      if (!act) return;
      if (act === 'clear') { _table?.clearSelection(); removeBulkBar(); return; }
      if (act === 'export') { ctx.exportCsv(selectedRows()); return; }
      if (act === 'pay') return bulkMarkPaid(ctx);
      if (act === 'category') return bulkChangeCategory(ctx);
      if (act === 'delete') return bulkDelete(ctx);
    });
  }
  _bulkBar.innerHTML = `
    <span class="admin-bulk-bar__count">${rows.length} selected</span>
    <span class="admin-bulk-bar__actions">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="pay">${icon('check', 13, 13)} Mark paid</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="category">Change category</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="export">${icon('download', 13, 13)} Export CSV</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="delete">${icon('trash', 13, 13)} Delete</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-bulk="clear">Clear</button>
    </span>`;
}

function bulkProgress(txt) {
  const el = _bulkBar?.querySelector('.admin-bulk-bar__count');
  if (el) el.textContent = txt;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Sequential bulk runner: one write at a time (the backend rate-limits),
 * exponential backoff (1s/2s/4s ×3) on RATE_LIMITED, failures collected — the
 * loop never aborts early and never retries a non-rate-limit error.
 */
async function runBulk(rows, verb, fn) {
  _bulkRunning = true;
  let done = 0;
  const failures = [];
  for (const row of rows) {
    let attempt = 0;
    for (;;) {
      try { await fn(row); done++; break; }
      catch (err) {
        if (err?.code === 'RATE_LIMITED' && attempt < 3) {
          attempt++;
          bulkProgress(`${verb} ${done}/${rows.length} — rate-limited, retrying…`);
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        failures.push({ name: row.name || row.id, msg: err?.message || 'failed' });
        break;
      }
    }
    bulkProgress(`${verb} ${done + failures.length}/${rows.length}…`);
  }
  _bulkRunning = false;
  return { done, failures };
}

function bulkSummaryToast(verb, done, failures, skipped = 0) {
  const skippedTxt = skipped ? ` · ${skipped} skipped` : '';
  if (failures.length) {
    const names = failures.slice(0, 3).map(f => f.name).join(', ');
    Toast.warning(`${verb}: ${done} done · ${failures.length} failed (${names}${failures.length > 3 ? '…' : ''})${skippedTxt}`);
  } else {
    Toast.success(`${verb}: ${done} done${skippedTxt}.`);
  }
}

async function afterBulk(ctx) {
  _table?.clearSelection();
  removeBulkBar();
  await ctx.reload();
}

function bulkMarkPaid(ctx) {
  const rows = selectedRows();
  // Recurring templates pay per-occurrence (via the detail drawer) — a series
  // has no single "the payment". Skipped LOUDLY, never silently.
  const eligible = rows.filter(r => !r.recurring && r._status !== 'paid');
  const skipped = rows.length - eligible.length;
  if (!eligible.length) { Toast.info('Nothing eligible — recurring series and already-paid rows are skipped.'); return; }
  const today = ctx.fmt.todayInputValue();
  Modal.confirm({
    title: 'Mark paid',
    message: `Mark ${eligible.length} expense${eligible.length === 1 ? '' : 's'} as paid today (${today})?${skipped ? ` ${skipped} selected row${skipped === 1 ? ' is' : 's are'} recurring or already paid and will be skipped.` : ''}`,
    confirmLabel: 'Mark paid', confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      const { done, failures } = await runBulk(eligible, 'Paying', (r) =>
        ctx.api.pay(r.id, { paid_date: today, amount: r.amount }));
      bulkSummaryToast('Mark paid', done, failures, skipped);
      await afterBulk(ctx);
    },
  });
}

function bulkChangeCategory(ctx) {
  const rows = selectedRows();
  if (!rows.length) return;
  const opts = [...operatingCategories(), ...orderLinkedCategories()]
    .map(c => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('');
  const modal = Modal.open({
    title: 'Change category',
    body: `
      <p style="margin:0 0 10px;color:var(--text-secondary)">Re-categorise ${rows.length} selected expense${rows.length === 1 ? '' : 's'}. Order-linked categories are excluded from operating totals (already in per-order costs).</p>
      <select class="admin-input" id="bulk-cat"><option value="">Select a category…</option>${opts}</select>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-x="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-x="apply">Apply</button>`,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-x="cancel"]')?.addEventListener('click', () => modal.close());
  modal.footer.querySelector('[data-x="apply"]')?.addEventListener('click', async () => {
    const key = modal.body.querySelector('#bulk-cat')?.value;
    if (!key) return;
    modal.close();
    // A custom (owner) key can't live in the backend enum — those rows store
    // 'other' + a per-expense override entry, persisted ONCE after the loop.
    const backendOk = ctx.categories.backendAccepts(key);
    const storeKey = backendOk ? key : 'other';
    const { done, failures } = await runBulk(rows, 'Re-categorising', async (r) => {
      await ctx.api.update(r.id, { category: storeKey });
      ctx.categories.setOverrideLocal(r.id, backendOk ? null : key);
    });
    const persisted = await ctx.categories.persistOverrides();
    if (persisted === false) Toast.warning('Category labels saved on this device only — they couldn\'t reach the server.');
    bulkSummaryToast(`Category → ${categoryLabel(key)}`, done, failures);
    await afterBulk(ctx);
  });
}

function bulkDelete(ctx) {
  const rows = selectedRows();
  if (!rows.length) return;
  const seriesCount = rows.filter(r => r.recurring).length;
  Modal.confirm({
    title: 'Delete expenses',
    message: `Delete ${rows.length} expense${rows.length === 1 ? '' : 's'}? This cannot be undone.${seriesCount ? ` ${seriesCount} of them ${seriesCount === 1 ? 'is a recurring series — deleting it removes ALL its occurrences.' : 'are recurring series — deleting them removes ALL their occurrences.'}` : ''}`,
    confirmLabel: 'Delete',
    onConfirm: async () => {
      const { done, failures } = await runBulk(rows, 'Deleting', (r) => ctx.api.remove(r.id));
      bulkSummaryToast('Delete', done, failures);
      await afterBulk(ctx);
    },
  });
}

// ─── table ───────────────────────────────────────────────────────────────────
function refreshTable() {
  if (!_table || !_ctx) return;
  const all = _ctx.filteredRows();
  const cmp = comparator(_sortKey, _ctx);
  all.sort((a, b) => (_sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
  _lastFiltered = all;
  // Three-way empty state: nothing exists vs nothing matches (the hidden-note
  // handles "exists outside the period/filters" loudly underneath).
  _table.config.emptyMessage = _ctx.getState().rows.length === 0
    ? 'No expenses yet — add your first with the button above'
    : 'No expenses match your filters';
  const start = (_page - 1) * _limit;
  _table.setData(all.slice(start, start + _limit), { total: all.length, page: _page, limit: _limit });
  _ctx.updateHiddenNote(all.length);
  const summary = _host?.querySelector('#exp-table-summary');
  if (summary) summary.outerHTML = summaryHtml(_ctx, all);
  const chips = _host?.querySelector('.exp-chips');
  if (chips) chips.outerHTML = chipsHtml(_ctx);
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
  // Basis changes relabel the Date column too — full tab re-render.
  $('#f-basis')?.addEventListener('change', (e) => {
    _ctx.filters.set({ basis: e.target.value });
    _page = 1;
    render(_host, _ctx);
  });
  $('#exp-reset')?.addEventListener('click', () => {
    _ctx.filters.set({ cat: '', status: '', type: '', method: '', q: '', basis: 'incurred' });
    _page = 1;
    render(_host, _ctx);
  });
}

function bindChips() {
  _host.querySelector('#exp-chips-host')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-chip]')?.dataset.chip;
    const chip = CHIPS.find(c => c.id === id);
    if (!chip) return;
    _ctx.filters.set(chip.patch);
    _page = 1;
    // Rebuild toolbar selects so they mirror the chip's filter state.
    render(_host, _ctx);
  });
}

async function render(host, ctx) {
  _host = host;
  _ctx = ctx;
  removeBulkBar();
  await loadColumnPrefs(ctx);
  const initialRows = ctx.filteredRows();
  host.innerHTML = `
    ${summaryHtml(ctx, initialRows)}
    <div id="exp-chips-host">${chipsHtml(ctx)}</div>
    <div class="admin-card admin-mb-0">
      ${toolbarHtml(ctx)}
      <div id="exp-hidden-note"></div>
      <div id="exp-table"></div>
    </div>`;

  const mount = host.querySelector('#exp-table');
  _table = new DataTable(mount, {
    columns: visibleColumns(ctx),
    rowKey: 'id',
    selectable: true,
    tableClass: 'admin-table--colsized',
    emptyMessage: 'No expenses match your filters',
    emptyIcon: icon('invoice', 28, 28),
    onRowClick: (row) => ctx.openDetail(row),
    onPageChange: (p) => { _page = p; refreshTable(); },
    onLimitChange: (l) => { _limit = l; _page = 1; refreshTable(); },
    onSort: (key, dir) => {
      _sortKey = key || 'date';
      _sortDir = dir || 'desc';
      _table.setSort(_sortKey, _sortDir);
      refreshTable();
    },
    onSelectionChange: () => updateBulkBar(ctx),
  });
  _table.setSort(_sortKey, _sortDir);
  mount.addEventListener('click', ctx.onRowAction);
  bindToolbar();
  bindChips();
  bindColumnPicker(ctx);
  refreshTable();
}

export default {
  id: 'all',
  render,
  destroy() {
    clearTimeout(_searchDebounce);
    _searchDebounce = null;
    removeBulkBar();
    _bulkRunning = false;
    _table?.destroy?.();
    _table = null;
    _host = null;
    _ctx = null;
    _page = 1;
    _lastFiltered = [];
  },
};
