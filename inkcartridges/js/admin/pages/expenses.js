/**
 * Expenses Page — dedicated Expense Management (Finance → Expenses, owner-only)
 * ============================================================================
 *
 * Replaces the small form that used to live on Financial Health. Answers, from
 * real backend data (never browser storage):
 *   • What have we spent?          → summary KPIs + category breakdown
 *   • What still needs paying?     → unpaid / overdue totals + status badges
 *   • What repeating costs come?   → recurring monthly commitment + upcoming strip
 *   • Where is our money going?    → over-time chart + category doughnut
 *   • What will next month cost?   → next-30-day projected cash requirement
 *   • True profit after expenses?  → GST-netted operating impact (order-linked excluded)
 *
 * Accounting rules are enforced in the pure utils (single source of truth):
 *   - utils/expense-categories.js  (operating vs order-linked; GST defaults)
 *   - utils/expense-recurrence.js  (template → projected occurrences; status)
 *   - utils/expense-math.js        (KPIs; order-linked exclusion; GST netting)
 *
 * Server-backed actions (edit / delete / mark-paid / pause / recurrence
 * persistence) call /api/admin/expenses/* which the backend dev is building from
 * the spec. Until then they fail-soft with a clear message — never a fake save.
 * Listing + one-off create work today via the legacy analytics endpoint.
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { Charts } from '../components/charts.js';
import {
  EXPENSE_CATEGORIES, categoryByKey, categoryLabel, categoryKind,
  normalizeCategory, isOrderLinked, gstDefaultFor,
} from '../utils/expense-categories.js';
import {
  RECURRENCE_TYPES, parseUtcDate, isoFromMs, expandExpenseOccurrences,
  nextOccurrence, deriveStatus, describeRecurrence, isRecurring,
} from '../utils/expense-recurrence.js';
import {
  computeExpenseKpis, categoryBreakdown, bucketExpenses, recurringMonthlyCommitment,
} from '../utils/expense-math.js';
import { fetchCountableInvoices, aggregateInvoices, backendCountsInvoices } from '../utils/invoice-overlay.js';

// ─── helpers ─────────────────────────────────────────────────────────────────
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const money = (n) => (typeof window.formatPrice === 'function' ? window.formatPrice(Number(n) || 0) : '$' + (Number(n) || 0).toFixed(2));
const num = (n) => { const v = typeof n === 'string' ? parseFloat(n) : n; return Number.isFinite(v) ? v : 0; };
const warn = (m, e) => window.DebugLog?.warn?.(`[Expenses] ${m}`, e?.message || e);

function todayUtcMs() {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}
function todayInputValue() {
  return isoFromMs(todayUtcMs());
}
function fmtDate(iso) {
  const ms = parseUtcDate(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-NZ', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—';
}
function monthStartMs(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
function monthEndMs(ms) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0); }
function addMonthsMs(ms, n) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()); }
// The current calendar month as an ISO {from,to} — matches the window the P&L's
// latest period covers, so invoiced sales land in the same month as the revenue
// we're adding them to.
function thisMonthWindow() {
  const now = todayUtcMs();
  return { from: isoFromMs(monthStartMs(now)), to: isoFromMs(monthEndMs(now)) };
}

const PERIODS = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'This month' },
  { key: 'prev_month', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'year', label: 'This year' },
  { key: 'custom', label: 'Custom range' },
];

function resolvePeriod(period, customFrom, customTo) {
  const today = todayUtcMs();
  if (period === 'custom' && customFrom && customTo) {
    return { fromMs: parseUtcDate(customFrom), toMs: parseUtcDate(customTo) };
  }
  const preset = PERIODS.find(p => p.key === period);
  if (preset && preset.days) return { fromMs: today - (preset.days - 1) * 86400000, toMs: today };
  if (period === 'month') return { fromMs: monthStartMs(today), toMs: monthEndMs(today) };
  if (period === 'prev_month') { const pm = addMonthsMs(monthStartMs(today), -1); return { fromMs: monthStartMs(pm), toMs: monthEndMs(pm) }; }
  if (period === 'quarter') { const d = new Date(today); const qm = Math.floor(d.getUTCMonth() / 3) * 3; return { fromMs: Date.UTC(d.getUTCFullYear(), qm, 1), toMs: Date.UTC(d.getUTCFullYear(), qm + 3, 0) }; }
  if (period === 'year') { const d = new Date(today); return { fromMs: Date.UTC(d.getUTCFullYear(), 0, 1), toMs: Date.UTC(d.getUTCFullYear(), 11, 31) }; }
  return { fromMs: today - 29 * 86400000, toMs: today };
}

const PAYMENT_METHODS = [
  { key: 'bank_transfer', label: 'Bank transfer' },
  { key: 'card', label: 'Card' },
  { key: 'direct_debit', label: 'Direct debit' },
  { key: 'automatic', label: 'Automatic payment' },
  { key: 'cash', label: 'Cash' },
  { key: 'other', label: 'Other' },
];
const methodLabel = (k) => (PAYMENT_METHODS.find(m => m.key === k)?.label || (k ? String(k) : '—'));

// ─── module state ────────────────────────────────────────────────────────────
let _container = null;
let _alive = false;
let _table = null;
let _page = 1;
let _limit = 50;
let _rows = [];             // enriched stored records (templates + one-offs)
let _occurrences = [];      // enriched occurrences across the KPI/analytics window
let _kpis = null;
let _period = '30d';
let _customFrom = '';
let _customTo = '';
let _filters = { search: '', category: '', status: '', type: '', method: '' };
let _searchDebounce = null;
let _editorToken = 0;
let _legacyMode = false;    // list came from the legacy endpoint (no server filters)
let _revenueThisMonth = null;

// ─── data load + enrichment ──────────────────────────────────────────────────
function enrichRecord(raw, idx) {
  const category = normalizeCategory(raw.category);
  const recurrence = RECURRENCE_TYPES.includes(raw.recurrence) ? raw.recurrence : 'none';
  const rec = {
    ...raw,
    id: raw.id ?? `local-${idx}`,
    _synthId: raw.id == null,
    name: raw.name || raw.description || raw.vendor || '',
    payee: raw.payee || raw.supplier || raw.vendor || '',
    category,
    kind: categoryKind(category),
    amount: num(raw.amount ?? raw.total),
    gst_claimable: raw.gst_claimable !== undefined ? !!raw.gst_claimable : gstDefaultFor(category),
    recurrence,
    series_state: raw.series_state || 'active',
    expense_date: (raw.expense_date || raw.date || '').slice(0, 10),
    due_date: (raw.due_date || '').slice(0, 10),
    paid_date: (raw.paid_date || '').slice(0, 10),
    method: raw.method || raw.payment_method || '',
  };
  rec.recurring = isRecurring(rec);
  const today = todayUtcMs();
  rec._status = rec.recurring
    ? rec.series_state // active / paused / ended
    : deriveStatus({ due_date: rec.due_date, date: rec.expense_date, paid_date: rec.paid_date, paid: rec.paid, status: rec.status }, today);
  rec._next = rec.recurring && rec.series_state === 'active' ? nextOccurrence(rec, today) : null;
  return rec;
}

function enrichOccurrence(o, today) {
  const category = normalizeCategory(o.category);
  const status = deriveStatus({ due_date: o.due_date, date: o.date || o.expense_date, paid_date: o.paid_date, paid: o.paid, status: o.status }, today);
  const expense_date = (o.expense_date || o.date || '').slice(0, 10);
  return {
    ...o,
    category,
    kind: categoryKind(category),
    amount: num(o.amount ?? o.total),
    gst_claimable: o.gst_claimable !== undefined ? !!o.gst_claimable : gstDefaultFor(category),
    status,
    paid: status === 'paid',
    expense_date,
    due_date: (o.due_date || expense_date || '').slice(0, 10),
    _ms: parseUtcDate(expense_date),
  };
}

function occKey(seriesId, dateIso) { return `${seriesId ?? ''}|${(dateIso || '').slice(0, 10)}`; }

// Build enriched occurrences across [fromMs,toMs]: project recurring (active
// only), include one-offs as single occurrences, and let materialised backend
// occurrences override projections for the same (series, date).
function buildOccurrences(records, materialised, fromMs, toMs) {
  const today = todayUtcMs();
  const matMap = new Map();
  for (const m of (materialised || [])) {
    const e = enrichOccurrence(m, today);
    matMap.set(occKey(m.series_id ?? m.template_id ?? m.id, e.expense_date), e);
  }
  const out = [];
  for (const r of records) {
    if (r.recurring) {
      if (r.series_state !== 'active') continue; // paused/ended: don't project future
      for (const o of expandExpenseOccurrences({ ...r }, fromMs, toMs)) {
        const k = occKey(r.id, o.date);
        if (matMap.has(k)) continue; // materialised wins
        out.push(enrichOccurrence({ ...o, series_id: r.id, projected: true }, today));
      }
    } else {
      const oms = parseUtcDate(r.expense_date);
      if (Number.isFinite(oms) && oms >= fromMs && oms <= toMs) {
        out.push(enrichOccurrence({ ...r, series_id: r.id, projected: false }, today));
      }
    }
  }
  for (const [, e] of matMap) {
    if (Number.isFinite(e._ms) && e._ms >= fromMs && e._ms <= toMs) out.push(e);
  }
  return out;
}

async function loadData() {
  if (!_alive) return;
  if (_table) _table.setLoading(true);
  const myToken = ++_editorToken;

  const [listRes, matRes, pnl, invoices] = await Promise.all([
    AdminAPI.expenses.list({ limit: 1000 }),
    AdminAPI.expenses.occurrences(rangeForOccurrences()),
    AdminAPI.getAdminAnalyticsPnL(31),
    // Invoiced sales are revenue too. Without them the expense-to-revenue ratio
    // divides by a website-only denominator and overstates how much of the month's
    // income is going out. TEMPORARY — see utils/invoice-overlay.js.
    fetchCountableInvoices(),
  ]);
  if (!_alive || myToken !== _editorToken) return;

  if (listRes === null) {
    renderError();
    return;
  }
  _legacyMode = !!listRes._legacy;
  const items = listRes.items || [];
  _rows = items.map((r, i) => enrichRecord(r, i));

  // Revenue this month for the expense-to-revenue ratio (fail-soft).
  try {
    const periods = Array.isArray(pnl?.periods) ? pnl.periods : [];
    const cur = periods[periods.length - 1] || pnl?.totals;
    _revenueThisMonth = cur && cur.revenue != null ? num(cur.revenue) : null;
    // Fold in this month's invoiced sales, unless the backend already counts them.
    // pnl.revenue is EX-GST, so add the ex-GST figure — not the incl-GST one.
    if (_revenueThisMonth != null && invoices && !backendCountsInvoices(pnl)) {
      const d = aggregateInvoices(invoices, thisMonthWindow());
      if (d && d.count) _revenueThisMonth += d.revenueExGst;
    }
  } catch (_) { _revenueThisMonth = null; }

  computeAndRender(matRes || []);
}

// The occurrence window must cover last-month → next-30-days AND the selected
// analytics period, so every KPI + chart has its occurrences available.
function rangeForOccurrences() {
  const today = todayUtcMs();
  const prevMonth = addMonthsMs(monthStartMs(today), -1);
  const { fromMs, toMs } = resolvePeriod(_period, _customFrom, _customTo);
  const from = Math.min(monthStartMs(prevMonth), fromMs);
  const to = Math.max(today + 30 * 86400000, toMs);
  return { from: isoFromMs(from), to: isoFromMs(to) };
}

function computeAndRender(materialised) {
  const today = todayUtcMs();
  const { from, to } = rangeForOccurrences();
  _occurrences = buildOccurrences(_rows, materialised, parseUtcDate(from), parseUtcDate(to));

  const mThisStart = monthStartMs(today), mThisEnd = monthEndMs(today);
  const pm = addMonthsMs(mThisStart, -1);
  _kpis = computeExpenseKpis(_occurrences, {
    monthStart: mThisStart, monthEnd: mThisEnd,
    prevStart: monthStartMs(pm), prevEnd: monthEndMs(pm),
    next30Start: today, next30End: today + 30 * 86400000,
    revenueThisMonth: _revenueThisMonth,
    recurringTemplates: _rows.filter(r => r.recurring),
  });

  render();
}

// ─── render ──────────────────────────────────────────────────────────────────
function render() {
  if (!_container || !_alive) return;
  Charts.destroyAll();
  const k = _kpis || {};

  _container.innerHTML = `
    <div class="admin-page-content">
      <div class="admin-page-header">
        <div>
          <h1>Expenses</h1>
          <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">Track one-off &amp; recurring business spending, upcoming cash requirements, and true profit after operating expenses.</p>
        </div>
        <div class="admin-page-header__actions">
          <button class="admin-btn admin-btn--ghost" id="exp-export" title="Export current view to CSV">${icon('download', 14, 14)} Export</button>
          <button class="admin-btn admin-btn--primary" id="exp-new">${icon('plus', 14, 14)} Add expense</button>
        </div>
      </div>

      ${_legacyMode ? `<div class="exp-notice" role="status">${icon('lock', 13, 13)} Connected to the legacy expense store — recurring persistence &amp; per-expense actions activate when the expense API update ships. One-off entries save now.</div>` : ''}

      ${renderKpis(k)}

      <div class="exp-cols">
        <div class="admin-card exp-upcoming">
          <div class="admin-card__title">Upcoming &amp; overdue <small>next 30 days</small></div>
          <div id="exp-upcoming-body">${renderUpcoming()}</div>
        </div>
        <div class="admin-card exp-breakdown">
          <div class="admin-card__title">Where the money goes <small>operating, selected period</small></div>
          <div class="exp-doughnut-wrap"><canvas id="exp-doughnut"></canvas></div>
          <div id="exp-legend" class="exp-legend"></div>
        </div>
      </div>

      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <span>Operating expenses over time</span>
          <select class="admin-select" id="exp-period" style="min-width:150px">
            ${PERIODS.map(p => `<option value="${p.key}"${p.key === _period ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select>
        </div>
        ${_period === 'custom' ? `<div class="exp-custom-range"><input type="date" class="admin-input" id="exp-cf" value="${escA(_customFrom)}"> <span>to</span> <input type="date" class="admin-input" id="exp-ct" value="${escA(_customTo)}"></div>` : ''}
        <div class="admin-chart-box admin-chart-box--tall"><canvas id="exp-trend"></canvas></div>
      </div>

      <div class="admin-card admin-mb-0">
        <div class="admin-filters exp-filters">
          <div class="admin-search" style="flex:1;min-width:220px">
            <span class="admin-search__icon">${icon('search', 14, 14)}</span>
            <input class="admin-input" id="exp-search" type="search" placeholder="Search name, payee, notes…" autocomplete="off" value="${escA(_filters.search)}" style="width:100%;padding-left:32px">
          </div>
          <select class="admin-select" id="f-category"><option value="">All categories</option>${EXPENSE_CATEGORIES.map(c => `<option value="${c.key}"${_filters.category === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
          <select class="admin-select" id="f-status">
            <option value="">Any status</option>
            <option value="overdue"${_filters.status === 'overdue' ? ' selected' : ''}>Overdue</option>
            <option value="due"${_filters.status === 'due' ? ' selected' : ''}>Due</option>
            <option value="scheduled"${_filters.status === 'scheduled' ? ' selected' : ''}>Scheduled</option>
            <option value="paid"${_filters.status === 'paid' ? ' selected' : ''}>Paid</option>
            <option value="active"${_filters.status === 'active' ? ' selected' : ''}>Active series</option>
            <option value="paused"${_filters.status === 'paused' ? ' selected' : ''}>Paused series</option>
            <option value="ended"${_filters.status === 'ended' ? ' selected' : ''}>Ended series</option>
          </select>
          <select class="admin-select" id="f-type">
            <option value="">One-off &amp; recurring</option>
            <option value="oneoff"${_filters.type === 'oneoff' ? ' selected' : ''}>One-off only</option>
            <option value="recurring"${_filters.type === 'recurring' ? ' selected' : ''}>Recurring only</option>
          </select>
          <select class="admin-select" id="f-method"><option value="">Any method</option>${PAYMENT_METHODS.map(m => `<option value="${m.key}"${_filters.method === m.key ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="exp-reset">Reset</button>
        </div>
        <div id="exp-table"></div>
      </div>
    </div>
  `;

  mountTable();
  bindChrome();
  renderTrendChart();
  renderDoughnut();
}

function renderKpis(k) {
  const pct = k.pctChange;
  const pctHtml = pct === null || pct === undefined
    ? '<span class="exp-kpi__delta">no prior month</span>'
    : `<span class="exp-kpi__delta exp-kpi__delta--${pct <= 0 ? 'good' : 'bad'}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}% vs last month</span>`;
  const ratio = k.expenseToRevenuePct != null ? `${k.expenseToRevenuePct.toFixed(0)}% of revenue` : 'revenue n/a';
  const largest = k.largestCategory ? `${categoryLabel(k.largestCategory.key)} · ${money(k.largestCategory.total)}` : '—';
  const cards = [
    { label: 'Operating expenses this month', value: money(k.thisMonth || 0), sub: pctHtml, tone: '' },
    { label: 'Overdue', value: money(k.overdue || 0), sub: k.overdue > 0 ? 'needs paying now' : 'all clear', tone: k.overdue > 0 ? 'bad' : 'good' },
    { label: 'Due (unpaid)', value: money(k.unpaid || 0), sub: 'awaiting payment', tone: k.unpaid > 0 ? 'warn' : '' },
    { label: 'Upcoming (next 30d)', value: money(k.upcoming30 || 0), sub: 'projected cash out', tone: '' },
    { label: 'Recurring commitment', value: money(k.recurringMonthly || 0), sub: 'per month, fixed', tone: '' },
    { label: 'Expenses vs revenue', value: money(k.thisMonth || 0), sub: ratio, tone: '' },
    { label: 'Profit impact (GST-net)', value: money(k.operatingPnl || 0), sub: k.gstReclaim ? `${money(k.gstReclaim)} GST reclaimed` : 'no GST credit', tone: '' },
    { label: 'Order-linked (excluded)', value: money(k.orderLinked || 0), sub: 'already in order costs', tone: 'muted' },
  ];
  return `<div class="exp-kpi-grid">${cards.map(c => `
    <div class="exp-kpi exp-kpi--${c.tone || 'plain'}">
      <div class="exp-kpi__label">${esc(c.label)}</div>
      <div class="exp-kpi__value">${esc(c.value)}</div>
      <div class="exp-kpi__sub">${c.sub}</div>
    </div>`).join('')}</div>`;
}

function renderUpcoming() {
  const today = todayUtcMs();
  const horizon = today + 30 * 86400000;
  const items = _occurrences
    .filter(o => o.kind !== 'order_linked' && o.status !== 'paid' && o.status !== 'cancelled' && o.status !== 'skipped')
    .filter(o => { const d = parseUtcDate(o.due_date || o.expense_date); return d <= horizon; })
    .sort((a, b) => parseUtcDate(a.due_date || a.expense_date) - parseUtcDate(b.due_date || b.expense_date))
    .slice(0, 14);
  if (!items.length) return '<div class="exp-empty-inline">Nothing due in the next 30 days.</div>';
  return `<ul class="exp-upcoming-list">${items.map(o => {
    const due = o.due_date || o.expense_date;
    const badge = statusBadge(o.status);
    const projected = o.projected ? '<span class="exp-tag exp-tag--projected" title="Projected from a recurring rule — not yet a saved occurrence">projected</span>' : '';
    return `<li class="exp-upcoming-item exp-upcoming-item--${o.status}">
      <div class="exp-upcoming-item__main">
        <span class="exp-upcoming-item__name">${esc(o.name || o.payee || categoryLabel(o.category))}</span>
        ${projected}
      </div>
      <div class="exp-upcoming-item__meta">${badge} <span class="exp-upcoming-item__date">${esc(fmtDate(due))}</span></div>
      <div class="exp-upcoming-item__amt">${esc(money(o.amount))}</div>
    </li>`;
  }).join('')}</ul>`;
}

function statusBadge(status) {
  const map = {
    overdue: ['bad', 'Overdue'], due: ['warn', 'Due'], scheduled: ['plain', 'Scheduled'],
    paid: ['good', 'Paid'], cancelled: ['muted', 'Cancelled'], skipped: ['muted', 'Skipped'],
    active: ['good', 'Active'], paused: ['warn', 'Paused'], ended: ['muted', 'Ended'],
  };
  const [tone, label] = map[status] || ['plain', status || '—'];
  return `<span class="exp-badge exp-badge--${tone}">${esc(label)}</span>`;
}

// ─── table ───────────────────────────────────────────────────────────────────
const COLUMNS = [
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

function filteredRows() {
  const f = _filters;
  const q = f.search.trim().toLowerCase();
  const { fromMs, toMs } = resolvePeriod(_period, _customFrom, _customTo);
  let rows = _rows.filter(r => {
    if (q) {
      const hay = `${r.name} ${r.payee} ${r.notes || ''} ${categoryLabel(r.category)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.category && r.category !== f.category) return false;
    if (f.method && r.method !== f.method) return false;
    if (f.type === 'oneoff' && r.recurring) return false;
    if (f.type === 'recurring' && !r.recurring) return false;
    if (f.status && r._status !== f.status) return false;
    // Period filter applies to one-offs by expense date; recurring series always
    // shown (they have no single date) so the operator can manage them.
    if (!r.recurring) {
      const d = parseUtcDate(r.expense_date);
      if (Number.isFinite(d) && (d < fromMs || d > toMs)) return false;
    }
    return true;
  });
  rows.sort((a, b) => parseUtcDate(b.expense_date) - parseUtcDate(a.expense_date));
  return rows;
}

function mountTable() {
  const mount = _container.querySelector('#exp-table');
  _table = new DataTable(mount, {
    columns: COLUMNS,
    rowKey: 'id',
    tableClass: 'admin-table--colsized',
    emptyMessage: 'No expenses match your filters',
    emptyIcon: icon('invoice', 28, 28),
    onRowClick: (row) => openDetail(row),
    onPageChange: (p) => { _page = p; refreshTable(); },
    onLimitChange: (l) => { _limit = l; _page = 1; refreshTable(); },
  });
  mount.addEventListener('click', onRowAction);
  refreshTable();
}

function refreshTable() {
  if (!_table) return;
  const all = filteredRows();
  const start = (_page - 1) * _limit;
  const pageRows = all.slice(start, start + _limit);
  _table.setData(pageRows, { total: all.length, page: _page, limit: _limit });
}

// ─── charts ──────────────────────────────────────────────────────────────────
async function renderTrendChart() {
  const { fromMs, toMs } = resolvePeriod(_period, _customFrom, _customTo);
  const spanDays = (toMs - fromMs) / 86400000;
  const grain = spanDays <= 31 ? 'day' : (spanDays <= 120 ? 'week' : 'month');
  const buckets = bucketExpenses(_occurrences, fromMs, toMs, grain);
  if (!buckets.length) { const c = _container?.querySelector('#exp-trend'); if (c) c.parentElement.innerHTML = '<div class="exp-empty-inline">No operating expenses in this period.</div>'; return; }
  const colors = Charts.getThemeColors();
  await Charts.bar('exp-trend', {
    labels: buckets.map(b => b.key),
    datasets: [{ label: 'Operating expenses', data: buckets.map(b => b.total), backgroundColor: colors.magenta, borderRadius: 4 }],
    options: { plugins: { tooltip: { callbacks: { label: (ctx) => `Expenses: ${money(ctx.parsed.y)}` } } } },
  });
}

async function renderDoughnut() {
  const breakdown = categoryBreakdown(_occurrences, { operatingOnly: true }).slice(0, 8);
  const legend = _container?.querySelector('#exp-legend');
  if (!breakdown.length) { const c = _container?.querySelector('.exp-doughnut-wrap'); if (c) c.innerHTML = '<div class="exp-empty-inline">No operating spend to break down.</div>'; return; }
  const palette = ['#267FB5', '#C71F6E', '#F4C430', '#34D399', '#8B5CF6', '#F97316', '#06B6D4', '#94A3B8'];
  await Charts.doughnut('exp-doughnut', {
    labels: breakdown.map(b => categoryLabel(b.key)),
    data: breakdown.map(b => b.total),
    colors: palette,
    options: { plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${money(ctx.parsed)}` } } } },
  });
  if (legend) {
    const total = breakdown.reduce((s, b) => s + b.total, 0) || 1;
    legend.innerHTML = breakdown.map((b, i) => `<div class="exp-legend__row"><span class="exp-legend__dot" style="background:${palette[i % palette.length]}"></span><span class="exp-legend__label">${esc(categoryLabel(b.key))}</span><span class="exp-legend__val">${esc(money(b.total))} · ${((b.total / total) * 100).toFixed(0)}%</span></div>`).join('');
  }
}

// ─── chrome binding ──────────────────────────────────────────────────────────
function bindChrome() {
  const $ = (s) => _container.querySelector(s);
  $('#exp-new')?.addEventListener('click', () => openEditor(freshDraft()));
  $('#exp-export')?.addEventListener('click', exportCsv);
  $('#exp-search')?.addEventListener('input', (e) => {
    clearTimeout(_searchDebounce);
    const v = e.target.value;
    _searchDebounce = setTimeout(() => { _filters.search = v; _page = 1; refreshTable(); }, 250);
  });
  $('#f-category')?.addEventListener('change', (e) => { _filters.category = e.target.value; _page = 1; refreshTable(); });
  $('#f-status')?.addEventListener('change', (e) => { _filters.status = e.target.value; _page = 1; refreshTable(); });
  $('#f-type')?.addEventListener('change', (e) => { _filters.type = e.target.value; _page = 1; refreshTable(); });
  $('#f-method')?.addEventListener('change', (e) => { _filters.method = e.target.value; _page = 1; refreshTable(); });
  $('#exp-reset')?.addEventListener('click', () => { _filters = { search: '', category: '', status: '', type: '', method: '' }; _page = 1; render(); });
  $('#exp-period')?.addEventListener('change', (e) => {
    _period = e.target.value;
    if (_period !== 'custom') reloadOccurrencesThenRender();
    else render(); // custom: wait for both date inputs before recomputing
  });
  $('#exp-cf')?.addEventListener('change', (e) => { _customFrom = e.target.value; if (_customTo) reloadOccurrencesThenRender(); });
  $('#exp-ct')?.addEventListener('change', (e) => { _customTo = e.target.value; if (_customFrom) reloadOccurrencesThenRender(); });
}

// Changing the period may widen the occurrence window, so re-fetch materialised
// occurrences for the new range then recompute (fail-soft; null → project only).
async function reloadOccurrencesThenRender() {
  const mat = await AdminAPI.expenses.occurrences(rangeForOccurrences());
  if (!_alive) return;
  computeAndRender(mat || []);
}

// ─── row actions ─────────────────────────────────────────────────────────────
function findRow(id) { return _rows.find(r => String(r.id) === String(id)); }

async function onRowAction(e) {
  const btn = e.target.closest('[data-row-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  const action = btn.dataset.rowAction;
  const row = findRow(id);
  if (!row) return;

  if (action === 'edit') return openEditor(row);
  if (action === 'duplicate') return openEditor({ ...row, id: null, _synthId: true, name: row.name ? `${row.name} (copy)` : '', paid_date: '', status: undefined }, true);
  if (action === 'delete') {
    return Modal.confirm({
      title: 'Delete expense',
      message: row.recurring ? `Delete the entire "${row.name || categoryLabel(row.category)}" series? This removes all its occurrences.` : `Delete "${row.name || categoryLabel(row.category)}" (${money(row.amount)})? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => { await guardedWrite(() => AdminAPI.expenses.remove(id), 'Expense deleted.'); },
    });
  }
  if (action === 'pay') {
    return Modal.confirm({
      title: 'Mark as paid',
      message: `Mark "${row.name || categoryLabel(row.category)}" (${money(row.amount)}) as paid today?`,
      confirmLabel: 'Mark paid', confirmClass: 'admin-btn--primary',
      onConfirm: async () => { await guardedWrite(() => AdminAPI.expenses.pay(id, { paid_date: todayInputValue(), amount: row.amount }), 'Marked paid.'); },
    });
  }
  if (action === 'unpay') return guardedWrite(() => AdminAPI.expenses.unpay(id), 'Marked unpaid.');
  if (action === 'pause') return guardedWrite(() => AdminAPI.expenses.pause(id), 'Series paused.');
  if (action === 'resume') return guardedWrite(() => AdminAPI.expenses.resume(id), 'Series resumed.');
}

// Run a write, surface success, and translate the "backend not built yet" 404
// into an honest message instead of a fake success.
async function guardedWrite(fn, successMsg) {
  try {
    await fn();
    if (!_alive) return;
    Toast.success(successMsg);
    await loadData();
  } catch (err) {
    if (err?.code === 'NOT_FOUND') {
      Toast.error('This action needs the expense API update (backend pending). See the backend spec — data was not changed.');
    } else {
      Toast.error(err?.message || 'Action failed. Please try again.');
    }
  }
}

// ─── detail view ─────────────────────────────────────────────────────────────
function openDetail(row) {
  const cat = categoryByKey(row.category);
  const rowsHtml = [
    ['Name', esc(row.name || '—')],
    ['Category', `${esc(cat.label)} ${row.kind === 'order_linked' ? '<span class="exp-tag exp-tag--linked">order-linked</span>' : ''}`],
    ['Payee', esc(row.payee || '—')],
    ['Amount', esc(money(row.amount))],
    ['GST', row.gst_claimable ? 'Claimable NZ GST (netted from profit)' : 'No GST credit'],
    ['Expense date', esc(fmtDate(row.expense_date))],
    ['Due date', row.due_date ? esc(fmtDate(row.due_date)) : '—'],
    ['Paid date', row.paid_date ? esc(fmtDate(row.paid_date)) : '—'],
    ['Payment method', esc(methodLabel(row.method))],
    ['Reference', esc(row.reference || row.invoice_number || '—')],
    ['Recurrence', row.recurring ? esc(describeRecurrence(row)) : 'One-off'],
    ['Series state', row.recurring ? esc(row.series_state) : '—'],
    ['Notes', esc(row.notes || '—')],
  ].map(([l, v]) => `<div class="exp-detail-row"><dt>${esc(l)}</dt><dd>${v}</dd></div>`).join('');

  let occHtml = '';
  if (row.recurring) {
    const today = todayUtcMs();
    const occs = expandExpenseOccurrences({ ...row }, today - 90 * 86400000, today + 120 * 86400000)
      .map(o => enrichOccurrence(o, today));
    occHtml = `<div class="admin-card__title" style="margin-top:18px">Occurrences <small>−90 to +120 days</small></div>
      <ul class="exp-occ-list">${occs.map(o => `<li class="exp-occ ${o._ms < today ? 'exp-occ--past' : 'exp-occ--future'}"><span>${esc(fmtDate(o.expense_date))}</span> ${statusBadge(o.status)} <span class="exp-occ__amt">${esc(money(o.amount))}</span></li>`).join('') || '<li class="exp-empty-inline">No occurrences in range.</li>'}</ul>`;
  }

  const d = Drawer.open({
    title: row.name || categoryLabel(row.category),
    body: `<div class="exp-detail"><dl class="exp-detail-grid">${rowsHtml}</dl>${occHtml}</div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-x="close">Close</button><button class="admin-btn admin-btn--primary" data-x="edit">Edit</button>`,
  });
  if (!d) return;
  d.footer.querySelector('[data-x="close"]').addEventListener('click', () => Drawer.close());
  d.footer.querySelector('[data-x="edit"]').addEventListener('click', () => { Drawer.close(); openEditor(row); });
}

// ─── add / edit editor ───────────────────────────────────────────────────────
function freshDraft() {
  return {
    id: null, _synthId: true, name: '', payee: '', category: '', amount: '',
    gst_claimable: undefined, expense_date: todayInputValue(), due_date: '', paid_date: '',
    method: '', reference: '', notes: '', recurrence: 'none', series_state: 'active',
    recurrence_day_of_week: 3, recurrence_day_of_month: '', recurrence_month: 1,
    recurrence_interval_days: '', recurrence_end: '', recurrence_count: '',
  };
}

function openEditor(model, isDuplicate = false) {
  const isNew = model.id == null;
  const m = { ...freshDraft(), ...model };
  const d = Drawer.open({
    title: isNew ? (isDuplicate ? 'Duplicate expense' : 'Add expense') : 'Edit expense',
    body: editorBody(m),
    footer: `<button class="admin-btn admin-btn--ghost" data-x="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-x="save">${isNew ? 'Save expense' : 'Save changes'}</button>`,
  });
  if (!d) return;
  bindEditor(d, m, isNew);
}

function editorBody(m) {
  const catOptions = (kind) => EXPENSE_CATEGORIES.filter(c => c.kind === kind)
    .map(c => `<option value="${c.key}"${m.category === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const gstChecked = (m.gst_claimable !== undefined ? m.gst_claimable : gstDefaultFor(m.category || 'other'));
  return `
    <form class="exp-form" id="exp-form" novalidate>
      <div class="exp-form__seg" role="tablist" aria-label="Expense type">
        <button type="button" class="exp-seg ${m.recurrence === 'none' ? 'active' : ''}" data-type="none">One-off</button>
        <button type="button" class="exp-seg ${m.recurrence !== 'none' ? 'active' : ''}" data-type="repeat">Repeating</button>
      </div>

      <div class="exp-field"><label>Name <span class="req">*</span></label><input class="admin-input" id="e-name" value="${escA(m.name)}" placeholder="e.g. Xero subscription, warehouse rent" maxlength="120"></div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label>Category <span class="req">*</span></label>
          <select class="admin-input" id="e-category">
            <option value="">Select…</option>
            <optgroup label="Operating expenses">${catOptions('operating')}</optgroup>
            <optgroup label="Order-linked (already counted)">${catOptions('order_linked')}</optgroup>
          </select>
        </div>
        <div class="exp-field"><label>Payee / supplier</label><input class="admin-input" id="e-payee" value="${escA(m.payee)}" placeholder="Who is paid" maxlength="120"></div>
      </div>

      <div id="e-linked-note" class="exp-linked-note" style="display:none">${icon('lock', 12, 12)} This is an order-linked cost — it's already counted in per-order profit, so it won't be added to operating expenses. Kept here for cash-flow visibility.</div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label>Amount (NZD, incl GST) <span class="req">*</span></label><input class="admin-input" type="number" step="0.01" min="0" id="e-amount" value="${escA(m.amount)}" placeholder="0.00"></div>
        <div class="exp-field exp-field--check"><label class="exp-check"><input type="checkbox" id="e-gst" ${gstChecked ? 'checked' : ''}> Claim NZ GST input credit</label><span class="exp-hint">Off for foreign SaaS / GST-free spend.</span></div>
      </div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label id="e-date-label">Expense date <span class="req">*</span></label><input class="admin-input" type="date" id="e-date" value="${escA(m.expense_date)}"></div>
        <div class="exp-field"><label>Due date</label><input class="admin-input" type="date" id="e-due" value="${escA(m.due_date)}"><span class="exp-hint">When payment is owed (for cash-flow).</span></div>
      </div>

      <div class="exp-oneoff-only ${m.recurrence !== 'none' ? 'hidden' : ''}">
        <div class="exp-field exp-field--check"><label class="exp-check"><input type="checkbox" id="e-paid" ${m.paid_date ? 'checked' : ''}> Already paid</label></div>
        <div class="exp-field ${m.paid_date ? '' : 'hidden'}" id="e-paid-wrap"><label>Paid date</label><input class="admin-input" type="date" id="e-paid-date" value="${escA(m.paid_date || todayInputValue())}"></div>
      </div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label>Payment method</label><select class="admin-input" id="e-method"><option value="">—</option>${PAYMENT_METHODS.map(p => `<option value="${p.key}"${m.method === p.key ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
        <div class="exp-field"><label>Reference / invoice #</label><input class="admin-input" id="e-ref" value="${escA(m.reference || m.invoice_number || '')}" maxlength="60"></div>
      </div>

      <div class="exp-recur ${m.recurrence !== 'none' ? '' : 'hidden'}" id="e-recur">
        <div class="exp-recur__title">Repeat schedule</div>
        <div class="exp-form__grid2">
          <div class="exp-field"><label>Frequency</label>
            <select class="admin-input" id="e-freq">
              ${['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly', 'custom'].map(f => `<option value="${f}"${m.recurrence === f ? ' selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div class="exp-field exp-recur-field" data-for="weekly fortnightly"><label>Day of week</label>
            <select class="admin-input" id="e-dow">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((n, i) => `<option value="${i}"${Number(m.recurrence_day_of_week) === i ? ' selected' : ''}>${n}</option>`).join('')}</select>
          </div>
          <div class="exp-field exp-recur-field" data-for="monthly quarterly"><label>Day of month</label><input class="admin-input" type="number" min="1" max="31" id="e-dom" value="${escA(m.recurrence_day_of_month)}" placeholder="1–31"><span class="exp-hint">31 → last day of shorter months.</span></div>
          <div class="exp-field exp-recur-field" data-for="yearly"><label>Month</label><select class="admin-input" id="e-month">${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((n, i) => `<option value="${i + 1}"${Number(m.recurrence_month) === i + 1 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
          <div class="exp-field exp-recur-field" data-for="yearly"><label>Day of month</label><input class="admin-input" type="number" min="1" max="31" id="e-ydom" value="${escA(m.recurrence_day_of_month)}" placeholder="1–31"></div>
          <div class="exp-field exp-recur-field" data-for="custom"><label>Every N days</label><input class="admin-input" type="number" min="1" id="e-interval" value="${escA(m.recurrence_interval_days)}" placeholder="e.g. 45"></div>
        </div>
        <div class="exp-field"><label>Ends</label>
          <div class="exp-form__grid2">
            <select class="admin-input" id="e-endmode">
              <option value="never"${!m.recurrence_end && !m.recurrence_count ? ' selected' : ''}>Never</option>
              <option value="on"${m.recurrence_end ? ' selected' : ''}>On date</option>
              <option value="after"${m.recurrence_count ? ' selected' : ''}>After N occurrences</option>
            </select>
            <div id="e-end-on" class="${m.recurrence_end ? '' : 'hidden'}"><input class="admin-input" type="date" id="e-end-date" value="${escA(m.recurrence_end)}"></div>
            <div id="e-end-after" class="${m.recurrence_count ? '' : 'hidden'}"><input class="admin-input" type="number" min="1" id="e-end-count" value="${escA(m.recurrence_count)}" placeholder="occurrences"></div>
          </div>
        </div>
      </div>

      <div class="exp-field"><label>Notes</label><textarea class="admin-input" id="e-notes" rows="2" maxlength="500">${esc(m.notes || '')}</textarea></div>
      <div class="exp-form__err" id="e-err" role="alert" aria-live="polite"></div>
    </form>
  `;
}

function bindEditor(d, model, isNew) {
  const token = ++_editorToken;
  const root = d.body;
  const $ = (s) => root.querySelector(s);
  const setType = (type) => {
    root.querySelectorAll('.exp-seg').forEach(b => b.classList.toggle('active', b.dataset.type === type));
    $('#e-recur').classList.toggle('hidden', type === 'none');
    root.querySelector('.exp-oneoff-only').classList.toggle('hidden', type !== 'none');
    $('#e-date-label').innerHTML = type === 'none' ? 'Expense date <span class="req">*</span>' : 'Start date <span class="req">*</span>';
    syncFreqFields();
  };
  const syncFreqFields = () => {
    const freq = $('#e-freq')?.value || 'monthly';
    root.querySelectorAll('.exp-recur-field').forEach(el => {
      el.style.display = el.dataset.for.split(' ').includes(freq) ? '' : 'none';
    });
  };
  const syncLinkedNote = () => {
    const cat = $('#e-category').value;
    const linked = cat && isOrderLinked(cat);
    $('#e-linked-note').style.display = linked ? '' : 'none';
    // Reset GST default when the category changes and the user hasn't overridden.
    if (cat && $('#e-gst').dataset.touched !== '1') $('#e-gst').checked = gstDefaultFor(cat);
  };
  const syncEndMode = () => {
    const mode = $('#e-endmode').value;
    $('#e-end-on').classList.toggle('hidden', mode !== 'on');
    $('#e-end-after').classList.toggle('hidden', mode !== 'after');
  };

  root.querySelectorAll('.exp-seg').forEach(b => b.addEventListener('click', () => setType(b.dataset.type)));
  $('#e-freq')?.addEventListener('change', syncFreqFields);
  $('#e-category')?.addEventListener('change', syncLinkedNote);
  $('#e-gst')?.addEventListener('change', () => { $('#e-gst').dataset.touched = '1'; });
  $('#e-endmode')?.addEventListener('change', syncEndMode);
  $('#e-paid')?.addEventListener('change', () => $('#e-paid-wrap').classList.toggle('hidden', !$('#e-paid').checked));

  setType(model.recurrence !== 'none' ? 'repeat' : 'none');
  syncLinkedNote();
  syncEndMode();
  setTimeout(() => $('#e-name')?.focus(), 60);

  d.footer.querySelector('[data-x="cancel"]').addEventListener('click', () => Drawer.close());
  const saveBtn = d.footer.querySelector('[data-x="save"]');
  saveBtn.addEventListener('click', async () => {
    const built = collectPayload(root);
    const err = validatePayload(built, root);
    if (err) { $('#e-err').textContent = err; return; }
    $('#e-err').textContent = '';
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      if (isNew) await AdminAPI.expenses.create(built);
      else await AdminAPI.expenses.update(model.id, built);
      if (token !== _editorToken && !_alive) return;
      Toast.success(isNew ? 'Expense saved.' : 'Expense updated.');
      Drawer.close();
      await loadData();
    } catch (e2) {
      saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Save expense' : 'Save changes';
      if (e2?.code === 'NOT_FOUND') {
        // update() has no legacy fallback; make the limitation explicit.
        $('#e-err').textContent = 'Editing an existing expense needs the expense API update (backend pending). See the backend spec — nothing was changed.';
      } else {
        $('#e-err').textContent = e2?.message || 'Could not save. Please try again.';
      }
    }
  });
}

function collectPayload(root) {
  const $ = (s) => root.querySelector(s);
  const type = root.querySelector('.exp-seg.active')?.dataset.type || 'none';
  const category = $('#e-category').value;
  const payload = {
    name: $('#e-name').value.trim(),
    description: $('#e-name').value.trim(),
    payee: $('#e-payee').value.trim(),
    vendor: $('#e-payee').value.trim(), // legacy field name
    category,
    amount: parseFloat($('#e-amount').value),
    gst_claimable: $('#e-gst').checked,
    expense_date: $('#e-date').value,
    date: $('#e-date').value, // legacy field name
    due_date: $('#e-due').value || null,
    method: $('#e-method').value || null,
    reference: $('#e-ref').value.trim() || null,
    notes: $('#e-notes').value.trim() || null,
  };
  if (type === 'none') {
    payload.recurrence = 'none';
    if ($('#e-paid')?.checked) payload.paid_date = $('#e-paid-date').value || todayInputValue();
  } else {
    const freq = $('#e-freq').value;
    payload.recurrence = freq;
    if (freq === 'weekly' || freq === 'fortnightly') payload.recurrence_day_of_week = parseInt($('#e-dow').value, 10);
    if (freq === 'monthly' || freq === 'quarterly') payload.recurrence_day_of_month = parseInt($('#e-dom').value, 10);
    if (freq === 'yearly') { payload.recurrence_month = parseInt($('#e-month').value, 10); payload.recurrence_day_of_month = parseInt($('#e-ydom').value, 10); }
    if (freq === 'custom') payload.recurrence_interval_days = parseInt($('#e-interval').value, 10);
    const mode = $('#e-endmode').value;
    if (mode === 'on') payload.recurrence_end = $('#e-end-date').value || null;
    if (mode === 'after') payload.recurrence_count = parseInt($('#e-end-count').value, 10);
  }
  return payload;
}

function validatePayload(p, root) {
  if (!p.name) return 'Please enter a name.';
  if (!p.category) return 'Please choose a category.';
  if (!Number.isFinite(p.amount) || p.amount <= 0) return 'Amount must be greater than zero.';
  if (p.amount > 1_000_000) return 'Amount looks too large — please check.';
  if (!p.expense_date) return 'Please set the expense / start date.';
  const start = parseUtcDate(p.expense_date);
  if (p.due_date && parseUtcDate(p.due_date) < start) return 'Due date cannot be before the expense date.';
  if (p.paid_date && parseUtcDate(p.paid_date) < start) return 'Paid date cannot be before the expense date.';
  if (p.recurrence && p.recurrence !== 'none') {
    if ((p.recurrence === 'monthly' || p.recurrence === 'quarterly' || p.recurrence === 'yearly')) {
      const dom = p.recurrence_day_of_month;
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) return 'Day of month must be between 1 and 31.';
    }
    if (p.recurrence === 'custom' && (!Number.isInteger(p.recurrence_interval_days) || p.recurrence_interval_days < 1)) return 'Interval must be a whole number of days ≥ 1.';
    if (p.recurrence_end && parseUtcDate(p.recurrence_end) < start) return 'Recurrence end date cannot be before the start date.';
    if (p.recurrence_count != null && (!Number.isInteger(p.recurrence_count) || p.recurrence_count < 1)) return 'Number of occurrences must be ≥ 1.';
  }
  return null;
}

// ─── CSV export ──────────────────────────────────────────────────────────────
function exportCsv() {
  const rows = filteredRows();
  if (!rows.length) { Toast.info('Nothing to export for the current filters.'); return; }
  const headers = ['Name', 'Payee', 'Category', 'Kind', 'Amount', 'GST claimable', 'Status', 'Expense date', 'Due date', 'Paid date', 'Method', 'Reference', 'Recurrence', 'Next occurrence', 'Notes'];
  const esc0 = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.name, r.payee, categoryLabel(r.category), r.kind, r.amount.toFixed(2), r.gst_claimable ? 'yes' : 'no',
      r._status, r.expense_date, r.due_date, r.paid_date, methodLabel(r.method), r.reference || r.invoice_number || '',
      r.recurring ? describeRecurrence(r) : 'one-off', r._next || '', r.notes || '',
    ].map(esc0).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `expenses-${todayInputValue()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  Toast.success(`Exported ${rows.length} expense${rows.length === 1 ? '' : 's'}.`);
}

function renderError() {
  if (!_container) return;
  _container.innerHTML = `<div class="admin-stub"><div class="admin-stub__title">Couldn't load expenses</div><div class="admin-stub__text">The expense service didn't respond. <button class="admin-btn admin-btn--ghost admin-btn--sm" id="exp-retry">Retry</button></div></div>`;
  _container.querySelector('#exp-retry')?.addEventListener('click', () => loadData());
}

// ─── lifecycle ───────────────────────────────────────────────────────────────
export default {
  title: 'Expenses',

  async init(container) {
    _container = container;
    _alive = true;
    _page = 1;
    _filters = { search: '', category: '', status: '', type: '', method: '' };
    FilterState?.showBar?.(false); // page has its own period control
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:40vh"><div class="admin-loading__spinner"></div></div>`;
    try {
      await loadData();
    } catch (e) {
      warn('init', e);
      if (_alive) renderError();
    }
  },

  destroy() {
    _alive = false;
    _editorToken++;
    clearTimeout(_searchDebounce);
    Charts.destroyAll();
    if (Drawer.isOpen()) Drawer.close();
    _table?.destroy?.();
    _table = null;
    _container = null;
    _rows = [];
    _occurrences = [];
    _kpis = null;
  },
};
