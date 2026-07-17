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
  EXPENSE_CATEGORIES, RETIRED_CATEGORY_DEFAULTS,
  categoryByKey, categoryLabel, categoryKind,
  normalizeCategory, isOrderLinked, gstDefaultFor,
  operatingCategories, orderLinkedCategories,
  CUSTOM_CATEGORIES_KEY, CATEGORY_OVERRIDES_KEY, setCustomCategories,
  addCustomCategory, renameCustomCategory, removeCustomCategory, seedMissingCategories,
  normalizeCategoryOverrides, resolveRowCategory,
} from '../utils/expense-categories.js';
import {
  RECURRENCE_TYPES, parseUtcDate, isoFromMs, expandExpenseOccurrences,
  firstOccurrence, nextOccurrence, deriveStatus, describeRecurrence, isRecurring,
} from '../utils/expense-recurrence.js';
import {
  computeExpenseKpis, categoryBreakdown, bucketExpenses, recurringMonthlyCommitment,
} from '../utils/expense-math.js';
import {
  PRESET_KEY, MAX_PRESETS, toPreset, applyPresetToDraft, upsertPreset, removePreset,
  normalizePresetList, validatePreset, presetNameExists,
} from '../utils/expense-presets.js';

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
let _presets = [];          // saved form templates, from admin_ui_prefs (real DB)
let _customCats = [];       // owner's category list, from admin_ui_prefs (real DB)
let _catOverrides = {};     // { expenseId: customKey } for rows the backend stores as 'other'
let _backendCatKeys = null; // Set of keys the backend's category enum accepts (null = use static fallback)
let _serverSummary = null;  // { thisMonth, lastMonth } from GET /expenses/summary

// ─── data load + enrichment ──────────────────────────────────────────────────
function enrichRecord(raw, idx) {
  const category = normalizeCategory(resolveRowCategory(raw.category, raw.id, _catOverrides));
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
  // The backend now ships `derived_status` computed on the same rule we use. Prefer
  // it (one source of truth) and fall back to our own derivation when it's absent.
  rec._status = rec.recurring
    ? rec.series_state // active / paused / ended
    : (raw.derived_status
       || deriveStatus({ due_date: rec.due_date, date: rec.expense_date, paid_date: rec.paid_date, paid: rec.paid, status: rec.status }, today));
  rec._next = rec.recurring && rec.series_state === 'active' ? nextOccurrence(rec, today) : null;
  return rec;
}

function enrichOccurrence(o, today) {
  const category = normalizeCategory(resolveRowCategory(o.category, o.series_id ?? o.expense_id ?? o.id, _catOverrides));
  const status = o.derived_status
    || deriveStatus({ due_date: o.due_date, date: o.date || o.expense_date, paid_date: o.paid_date, paid: o.paid, status: o.status }, today);
  const expense_date = (o.expense_date || o.date || o.occurrence_date || '').slice(0, 10);
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
    // The backend keys an occurrence by (expense_id, occurrence_date); `series_id`
    // is a convenience alias on the same row. Carry the parent id through as
    // `series_id` so the merge + the detail drawer can find it.
    const parentId = m.series_id ?? m.expense_id ?? m.template_id ?? m.id;
    const e = enrichOccurrence({ ...m, series_id: parentId, projected: false }, today);
    matMap.set(occKey(parentId, e.expense_date), e);
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

  const today = todayUtcMs();
  const mStart = monthStartMs(today), mEnd = monthEndMs(today);
  const pm = addMonthsMs(mStart, -1);

  const [listRes, matRes, pnl, sumThis, sumPrev] = await Promise.all([
    AdminAPI.expenses.list({ limit: 1000 }),
    AdminAPI.expenses.occurrences(rangeForOccurrences()),
    AdminAPI.getAdminAnalyticsPnL(31),
    // Server-computed, cash-basis KPI bundle — the SAME numbers /pnl uses. We treat
    // it as authoritative and cross-check our client math against it (below), so the
    // page can never quietly drift from Finance.
    AdminAPI.expenses.summary({ from: isoFromMs(mStart), to: isoFromMs(mEnd) }),
    AdminAPI.expenses.summary({ from: isoFromMs(monthStartMs(pm)), to: isoFromMs(monthEndMs(pm)) }),
  ]);
  if (!_alive || myToken !== _editorToken) return;

  if (listRes === null) {
    renderError();
    return;
  }
  _legacyMode = !!listRes._legacy;
  const items = listRes.items || [];

  // Self-heal the owner's category list BEFORE enrichment: any key in use that
  // the registry doesn't know (a retired built-in, or a custom added on another
  // device) is adopted so the row keeps its label instead of collapsing to
  // "Other". Safe on every load — delete is blocked while a category is in use,
  // so seeding can never resurrect a deliberate deletion.
  const seeded = seedMissingCategories(_customCats, items);
  if (seeded.added.length) {
    _customCats = setCustomCategories(seeded.list);
    saveCategories(_customCats).then(ok => { if (ok === false) warn('seeded categories saved on this device only'); });
  }

  // Prune override entries for deleted expenses. Only when this list is the
  // complete set (under the fetch limit) — a truncated list must never be read
  // as "those ids are gone".
  if (!_legacyMode && items.length < 1000) {
    const liveIds = new Set(items.map(r => String(r.id)));
    const stale = Object.keys(_catOverrides).filter(id => !liveIds.has(id));
    if (stale.length) {
      for (const id of stale) delete _catOverrides[id];
      saveCategoryOverrides().then(ok => { if (ok === false) warn('override prune saved on this device only'); });
    }
  }

  _rows = items.map((r, i) => enrichRecord(r, i));
  _serverSummary = { thisMonth: summaryOf(sumThis), lastMonth: summaryOf(sumPrev) };

  // Revenue this month for the expense-to-revenue ratio (fail-soft). The backend's
  // P&L revenue already includes invoiced (phone / walk-in / B2B) sales.
  try {
    const periods = Array.isArray(pnl?.periods) ? pnl.periods : [];
    const cur = periods[periods.length - 1] || pnl?.totals;
    _revenueThisMonth = cur && cur.revenue != null ? num(cur.revenue) : null;
  } catch (_) { _revenueThisMonth = null; }

  computeAndRender(matRes || []);
}

// Unwrap GET /api/admin/expenses/summary → the flat numbers we care about.
// Fail-soft: a null/!ok response just means "no server figure", and the client
// math stands in.
function summaryOf(resp) {
  const s = resp?.summary ?? resp;
  if (!s || typeof s !== 'object') return null;
  const pick = (k) => (s[k] != null ? num(s[k]) : null);
  return {
    operatingPaid: pick('operating_paid'),
    orderLinkedPaid: pick('order_linked_paid'),
    overdue: pick('overdue_amount'),
    due: pick('due_amount'),
    upcoming: pick('upcoming_amount'),
  };
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
  reconcileWithServer();

  render();
}

/**
 * The server's /summary is the SAME cash-basis computation that feeds Finance →
 * P&L, so it is the source of truth for the spend figures. Where it disagrees with
 * our client math by more than a cent we take the server's number AND warn — a
 * divergence means our projector and theirs have drifted, which is exactly the bug
 * we most want to hear about rather than paper over.
 *
 * Figures the server doesn't return (recurring commitment, largest category,
 * expense-vs-revenue) stay client-computed.
 */
function reconcileWithServer() {
  const s = _serverSummary;
  if (!s || !_kpis) return;
  const take = (label, serverVal, clientVal, apply) => {
    if (serverVal == null) return;
    if (Math.abs(serverVal - (clientVal || 0)) > 0.01) {
      warn(`${label}: server ${serverVal} vs client ${clientVal} — using server (P&L basis)`);
    }
    apply(serverVal);
  };
  if (s.thisMonth) {
    take('operating_paid', s.thisMonth.operatingPaid, _kpis.thisMonth, v => { _kpis.thisMonth = v; _kpis.paid = v; });
    take('order_linked_paid', s.thisMonth.orderLinkedPaid, _kpis.orderLinked, v => { _kpis.orderLinked = v; });
    take('overdue', s.thisMonth.overdue, _kpis.overdue, v => { _kpis.overdue = v; });
    take('due', s.thisMonth.due, _kpis.due, v => { _kpis.due = v; _kpis.unpaid = (_kpis.overdue || 0) + v; });
    take('upcoming', s.thisMonth.upcoming, _kpis.upcoming30, v => { _kpis.upcoming30 = v; });
  }
  if (s.lastMonth && s.lastMonth.operatingPaid != null) {
    _kpis.lastMonth = s.lastMonth.operatingPaid;
  }
  // Re-derive the two figures that depend on the (possibly corrected) totals.
  const lm = _kpis.lastMonth;
  _kpis.pctChange = lm > 0 ? ((_kpis.thisMonth - lm) / lm) * 100 : (_kpis.thisMonth > 0 ? null : 0);
  _kpis.expenseToRevenuePct = (Number.isFinite(_revenueThisMonth) && _revenueThisMonth > 0)
    ? (_kpis.thisMonth / _revenueThisMonth) * 100
    : null;
  _kpis._serverBacked = true;
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
          <div class="admin-card__title">Where the money goes <small>operating, paid, selected period</small></div>
          <div class="exp-doughnut-wrap"><canvas id="exp-doughnut"></canvas></div>
          <div id="exp-legend" class="exp-legend"></div>
        </div>
      </div>

      <div class="admin-card admin-mb-lg">
        <div class="admin-card__title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <span>Operating expenses paid <small>cash basis — by paid date</small></span>
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
          <select class="admin-select" id="f-category">${filterCategoryOptions()}</select>
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
  const largest = k.largestCategory ? `${categoryLabel(k.largestCategory.key)} · ${money(k.largestCategory.total)}` : 'nothing paid yet';
  // Gross = what actually left the bank; the headline is the GST-netted figure that
  // Finance → P&L books, so the two can never disagree.
  const grossSub = (k.thisMonthGross && Math.abs(k.thisMonthGross - k.thisMonth) > 0.01)
    ? `${money(k.thisMonthGross)} gross cash out`
    : 'GST-netted, matches P&L';
  const cards = [
    {
      label: 'Paid this month', value: money(k.thisMonth || 0),
      sub: `${pctHtml}<span class="exp-kpi__note" title="Cash basis: only expenses marked paid, on their paid date, GST-netted, operating only — the same figure Finance → P&amp;L books.">${esc(grossSub)}</span>`,
      tone: '',
    },
    { label: 'Overdue', value: money(k.overdue || 0), sub: k.overdue > 0 ? 'needs paying now' : 'all clear', tone: k.overdue > 0 ? 'bad' : 'good' },
    { label: 'Due (unpaid)', value: money(k.unpaid || 0), sub: 'awaiting payment', tone: k.unpaid > 0 ? 'warn' : '' },
    { label: 'Upcoming (next 30d)', value: money(k.upcoming30 || 0), sub: 'projected cash out', tone: '' },
    { label: 'Recurring commitment', value: money(k.recurringMonthly || 0), sub: 'per month, fixed', tone: '' },
    { label: 'Expenses vs revenue', value: money(k.thisMonth || 0), sub: ratio, tone: '' },
    { label: 'Largest category', value: k.largestCategory ? money(k.largestCategory.total) : '—', sub: k.largestCategory ? esc(categoryLabel(k.largestCategory.key)) : esc(largest), tone: '' },
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
  if (!buckets.length) { const c = _container?.querySelector('#exp-trend'); if (c) c.parentElement.innerHTML = '<div class="exp-empty-inline">No operating expenses <strong>paid</strong> in this period. Mark an expense paid and it lands here on its paid date.</div>'; return; }
  const colors = Charts.getThemeColors();
  await Charts.bar('exp-trend', {
    labels: buckets.map(b => b.key),
    datasets: [{ label: 'Operating expenses paid', data: buckets.map(b => b.total), backgroundColor: colors.magenta, borderRadius: 4 }],
    options: { plugins: { tooltip: { callbacks: { label: (ctx) => `Expenses: ${money(ctx.parsed.y)}` } } } },
  });
}

async function renderDoughnut() {
  const breakdown = categoryBreakdown(_occurrences, { operatingOnly: true }).slice(0, 8);
  const legend = _container?.querySelector('#exp-legend');
  if (!breakdown.length) { const c = _container?.querySelector('.exp-doughnut-wrap'); if (c) c.innerHTML = '<div class="exp-empty-inline">No <strong>paid</strong> operating spend to break down yet.</div>'; return; }
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

// Run a write, surface success, reload. Errors are reported verbatim — we never
// swallow one or fake a success. Now that the expense API is live, a NOT_FOUND
// genuinely means the row is gone, so it reads as a stale-row message.
async function guardedWrite(fn, successMsg) {
  try {
    await fn();
    if (!_alive) return;
    Toast.success(successMsg);
    await loadData();
  } catch (err) {
    if (err?.code === 'NOT_FOUND') {
      Toast.error('That expense no longer exists — it may have been deleted. Refreshing.');
      await loadData();
    } else if (err?.code === 'RATE_LIMITED') {
      Toast.error('Too many changes at once. Wait a few seconds and try again.');
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
    // Merge the materialised (server) occurrences over the projected ones so a
    // paid/skipped instance shows its real state, then offer per-occurrence
    // actions. Every action sends an explicit occurrence_date, so the backend acts
    // on exactly the row the operator clicked instead of guessing "the current due".
    const mat = _occurrences.filter(o => String(o.series_id) === String(row.id) && !o.projected);
    const matByDate = new Map(mat.map(o => [o.expense_date, o]));
    const occs = expandExpenseOccurrences({ ...row }, today - 90 * 86400000, today + 120 * 86400000)
      .map(o => enrichOccurrence(o, today))
      .map(o => matByDate.get(o.expense_date) || o);

    occHtml = `<div class="admin-card__title" style="margin-top:18px">Occurrences <small>−90 to +120 days</small></div>
      <ul class="exp-occ-list">${occs.map(o => {
        const paid = o.status === 'paid';
        const done = paid || o.status === 'skipped' || o.status === 'cancelled';
        const acts = paid
          ? `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-occ-action="unpay" data-date="${escA(o.expense_date)}">Unpay</button>`
          : (o.status === 'skipped' || o.status === 'cancelled')
            ? ''
            : `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-occ-action="pay" data-date="${escA(o.expense_date)}" data-amount="${escA(o.amount)}" title="Mark this occurrence paid">${icon('check', 12, 12)}</button>
               <button class="admin-btn admin-btn--ghost admin-btn--sm" data-occ-action="skip" data-date="${escA(o.expense_date)}" title="Skip this occurrence">Skip</button>`;
        return `<li class="exp-occ ${o._ms < today ? 'exp-occ--past' : 'exp-occ--future'}${done ? ' exp-occ--done' : ''}">
          <span>${esc(fmtDate(o.expense_date))}</span>
          ${statusBadge(o.status)}
          ${o.projected ? '<span class="exp-tag exp-tag--projected" title="Projected from the recurring rule — not yet a saved occurrence">projected</span>' : ''}
          <span class="exp-occ__amt">${esc(money(o.amount))}</span>
          <span class="exp-occ__acts">${acts}</span>
        </li>`;
      }).join('') || '<li class="exp-empty-inline">No occurrences in range.</li>'}</ul>`;
  }

  const d = Drawer.open({
    title: row.name || categoryLabel(row.category),
    body: `<div class="exp-detail"><dl class="exp-detail-grid">${rowsHtml}</dl>${occHtml}</div>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-x="close">Close</button><button class="admin-btn admin-btn--primary" data-x="edit">Edit</button>`,
  });
  if (!d) return;
  d.footer.querySelector('[data-x="close"]').addEventListener('click', () => Drawer.close());
  d.footer.querySelector('[data-x="edit"]').addEventListener('click', () => { Drawer.close(); openEditor(row); });

  // Per-occurrence actions (delegated). Each carries the exact occurrence_date the
  // UI rendered, so the backend materialises that instance and nothing else.
  d.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-occ-action]');
    if (!btn) return;
    e.stopPropagation();
    const date = btn.dataset.date;
    const act = btn.dataset.occAction;
    const label = `${row.name || categoryLabel(row.category)} · ${fmtDate(date)}`;
    btn.disabled = true;
    if (act === 'pay') {
      await guardedWrite(
        () => AdminAPI.expenses.pay(row.id, { paid_date: todayInputValue(), amount: num(btn.dataset.amount) || row.amount, occurrence_date: date }),
        `Marked paid — ${label}.`,
      );
    } else if (act === 'unpay') {
      await guardedWrite(() => AdminAPI.expenses.unpay(row.id, { occurrence_date: date }), `Marked unpaid — ${label}.`);
    } else if (act === 'skip') {
      await guardedWrite(() => AdminAPI.expenses.skipOccurrence(row.id, date), `Skipped — ${label}.`);
    }
    if (Drawer.isOpen()) Drawer.close();
  });
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

// ─── categories: persistence + owner management ──────────────────────────────
// The owner's category list lives in `admin_ui_prefs` under `expenses.categories`
// — the same per-admin durable store the presets use (see the note below). The
// registry in utils/expense-categories.js is loaded from it at init, BEFORE any
// expense is enriched, so every lookup (labels, kinds, GST defaults) knows the
// owner's categories.

async function loadCategories() {
  try {
    const [prefs, backendCats] = await Promise.all([
      AdminAPI.getUiPrefs(),
      AdminAPI.expenses.categories(),   // live server enum; fail-soft null
    ]);
    _customCats = setCustomCategories(prefs?.[CUSTOM_CATEGORIES_KEY]);
    _catOverrides = normalizeCategoryOverrides(prefs?.[CATEGORY_OVERRIDES_KEY]);
    _backendCatKeys = Array.isArray(backendCats) && backendCats.length
      ? new Set(backendCats.map(c => c && c.key).filter(Boolean))
      : null;
  } catch (e) {
    warn('loadCategories', e);
    _customCats = setCustomCategories([]);
    _catOverrides = {};
    _backendCatKeys = null;
  }
}

/**
 * Can the record's `category` column hold this key? The backend validates
 * writes against ITS enum (built-ins + the retired operating list — the live
 * enum is fetched at init; the static lists mirror it as fallback). Any other
 * key is saved as 'other' + a CATEGORY_OVERRIDES_KEY entry (see the util's
 * header for why — totals are unaffected, only the label/grouping rides along).
 */
function backendAcceptsCategory(key) {
  if (_backendCatKeys) return _backendCatKeys.has(key);
  return EXPENSE_CATEGORIES.some(c => c.key === key) || !!RETIRED_CATEGORY_DEFAULTS[key];
}

async function saveCategoryOverrides() {
  try {
    await AdminAPI.getUiPrefs();               // refresh the cache we're about to merge into
    return await AdminAPI.setUiPref(CATEGORY_OVERRIDES_KEY, _catOverrides);
  } catch (e) {
    warn('saveCategoryOverrides', e);
    return false;
  }
}

/**
 * Point (or stop pointing) an expense id at a custom category after a save.
 * Returns the durable-write result (false = local cache only), or true when
 * there was nothing to change.
 */
async function syncCategoryOverride(id, customKeyOrNull) {
  if (id == null) return true;
  const sid = String(id);
  const cur = _catOverrides[sid] || null;
  if (cur === customKeyOrNull) return true;
  if (customKeyOrNull) _catOverrides[sid] = customKeyOrNull;
  else delete _catOverrides[sid];
  return await saveCategoryOverrides();
}

/**
 * Persist the owner's category list (same contract as savePresets: re-read the
 * shared prefs blob first, and return FALSE when the write only reached the
 * local cache so callers can surface that honestly).
 */
async function saveCategories(next) {
  _customCats = setCustomCategories(next);
  try {
    await AdminAPI.getUiPrefs();               // refresh the cache we're about to merge into
    return await AdminAPI.setUiPref(CUSTOM_CATEGORIES_KEY, _customCats);
  } catch (e) {
    warn('saveCategories', e);
    return false;
  }
}

/** <option>s for the editor's category select — owner's list, order-linked, and the add sentinel. */
function categorySelectOptions(selected) {
  const opt = (c) => `<option value="${escA(c.key)}"${selected === c.key ? ' selected' : ''}>${esc(c.label)}</option>`;
  return `<option value="">Select…</option>
    <optgroup label="Your categories">${operatingCategories().map(opt).join('')}</optgroup>
    <optgroup label="Order-linked (already counted)">${orderLinkedCategories().map(opt).join('')}</optgroup>
    <option value="__new__">＋ Add new category…</option>`;
}

/** <option>s for the filter bar's category select. */
function filterCategoryOptions() {
  const all = [...operatingCategories(), ...orderLinkedCategories()];
  return `<option value="">All categories</option>`
    + all.map(c => `<option value="${escA(c.key)}"${_filters.category === c.key ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
}

/** Rebuild the filter dropdown in place after the category list changes. */
function refreshFilterCategoryOptions() {
  const sel = _container?.querySelector('#f-category');
  if (!sel) return;
  // If the selected filter category was just deleted, clear the filter.
  if (_filters.category && normalizeCategory(_filters.category) !== _filters.category) {
    _filters.category = '';
    _page = 1;
    refreshTable();
  }
  sel.innerHTML = filterCategoryOptions();
  sel.value = _filters.category;
}

/** Rebuild an open editor's category select from the current registry, keeping/setting the selection. */
function rebuildCategorySelect(root, selectedKey) {
  const sel = root?.querySelector('#e-category');
  if (!sel) return;
  const val = selectedKey !== undefined ? selectedKey : sel.value;
  sel.innerHTML = categorySelectOptions(val);
  sel.value = val && normalizeCategory(val) === val ? val : '';
  // Re-run the bound sync (order-linked note + GST default) against the new value.
  sel.dispatchEvent(new Event('change'));
}

function categoryUsageCount(key) {
  return _rows.filter(r => r.category === key).length;
}

function categoryManagerBody() {
  const rows = _customCats.map(c => {
    const n = categoryUsageCount(c.key);
    const delAttrs = n
      ? `disabled title="In use by ${n} expense${n === 1 ? '' : 's'} — reassign them first"`
      : 'title="Delete category"';
    return `<li class="exp-cat-row" data-cat-key="${escA(c.key)}">
      <span class="exp-cat-row__label">${esc(c.label)}</span>
      <span class="exp-cat-row__use">${n ? `${n} expense${n === 1 ? '' : 's'}` : 'unused'}</span>
      <span class="exp-cat-row__acts">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-cat-rename="${escA(c.key)}">Rename</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-cat-del="${escA(c.key)}" ${delAttrs}>Delete</button>
      </span>
    </li>`;
  }).join('');
  return `${rows
    ? `<ul class="exp-cat-list">${rows}</ul>`
    : '<div class="exp-empty-inline">No custom categories yet. Add one from the category dropdown ("＋ Add new category…").</div>'}
  <div class="exp-preset-err" id="cat-mgr-err" role="alert" aria-live="polite"></div>`;
}

/**
 * The category manager (Modal over the editor Drawer — same layering the preset
 * delete confirm already uses). Rename is display-only (the KEY never changes,
 * so every saved expense picks the new label up). Delete is blocked while a
 * category is in use — which is exactly what makes continuous seeding safe.
 */
function openCategoryManager(editorRoot) {
  const modal = Modal.open({
    title: 'Manage categories',
    body: categoryManagerBody(),
    footer: '<button class="admin-btn admin-btn--ghost" data-x="close">Close</button>',
  });
  if (!modal) return;
  modal.footer.querySelector('[data-x="close"]')?.addEventListener('click', () => modal.close());

  const mgrErr = (msg) => { const el = modal.body.querySelector('#cat-mgr-err'); if (el) el.textContent = msg || ''; };
  const afterChange = () => {
    modal.body.innerHTML = categoryManagerBody();
    refreshFilterCategoryOptions();
    refreshTable();
    if (editorRoot) rebuildCategorySelect(editorRoot);
  };

  modal.body.addEventListener('click', async (e) => {
    const renameBtn = e.target.closest('[data-cat-rename]');
    if (renameBtn) {
      const key = renameBtn.dataset.catRename;
      const cat = _customCats.find(c => c.key === key);
      const row = renameBtn.closest('.exp-cat-row');
      if (!cat || !row) return;
      row.innerHTML = `
        <input class="admin-input" data-cat-rename-input="${escA(key)}" type="text" maxlength="40" value="${escA(cat.label)}">
        <span class="exp-cat-row__acts">
          <button type="button" class="admin-btn admin-btn--primary admin-btn--sm" data-cat-rename-save="${escA(key)}">Save</button>
          <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-cat-rename-cancel="1">Cancel</button>
        </span>`;
      row.querySelector('input')?.focus();
      return;
    }
    if (e.target.closest('[data-cat-rename-cancel]')) { mgrErr(''); afterChange(); return; }
    const renameSave = e.target.closest('[data-cat-rename-save]');
    if (renameSave) {
      const key = renameSave.dataset.catRenameSave;
      const input = modal.body.querySelector(`[data-cat-rename-input="${CSS.escape(key)}"]`);
      let next;
      try { next = renameCustomCategory(_customCats, key, input?.value); }
      catch (e2) { mgrErr(e2.message); return; }
      const ok = await saveCategories(next);
      mgrErr('');
      afterChange();
      if (ok === false) Toast.warning('Category renamed on this device only — it couldn\'t reach the server.');
      return;
    }
    const delBtn = e.target.closest('[data-cat-del]');
    if (delBtn && !delBtn.disabled) {
      const key = delBtn.dataset.catDel;
      const cat = _customCats.find(c => c.key === key);
      if (!cat) return;
      if (categoryUsageCount(key) > 0) { mgrErr('That category is in use — reassign its expenses first.'); return; }
      const ok = await saveCategories(removeCustomCategory(_customCats, key));
      mgrErr('');
      afterChange();
      if (ok === false) Toast.warning(`Category "${cat.label}" deleted on this device only — it couldn't reach the server.`);
      else Toast.success(`Category "${cat.label}" deleted.`);
    }
  });
}

// ─── presets: persistence ────────────────────────────────────────────────────
// Presets live in `admin_ui_prefs` — a per-admin Supabase KV table (RLS-locked to
// auth.uid()), the same durable store the Products column-picker uses. They are a
// UI convenience, NOT financial data, so this is the right home for them; no expense
// record is ever written to browser storage.

async function loadPresets() {
  try {
    const prefs = await AdminAPI.getUiPrefs();
    _presets = normalizePresetList(prefs?.[PRESET_KEY]);
  } catch (e) {
    warn('loadPresets', e);
    _presets = [];
  }
}

/**
 * Persist the preset list. `setUiPref` writes through to Supabase and returns FALSE
 * when it could only reach the local cache — we surface that honestly rather than
 * pretending the save stuck.
 *
 * The prefs blob is shared with other features and written read-modify-write, so we
 * re-read immediately before writing to avoid clobbering a concurrent change (e.g. a
 * column toggle in another tab).
 */
async function savePresets(next) {
  _presets = normalizePresetList(next);
  try {
    await AdminAPI.getUiPrefs();               // refresh the cache we're about to merge into
    return await AdminAPI.setUiPref(PRESET_KEY, _presets);
  } catch (e) {
    warn('savePresets', e);
    return false;
  }
}

/** Repaint just the chip row in an open editor (no full drawer rebuild). */
function refreshPresetChips(root) {
  const host = root?.querySelector('#e-presets');
  if (!host) return;
  const fresh = document.createElement('div');
  fresh.innerHTML = presetsPanel();
  const nextChips = fresh.querySelector('#e-preset-chips');
  const curChips = host.querySelector('#e-preset-chips');
  if (nextChips && curChips) curChips.innerHTML = nextChips.innerHTML;
}

/**
 * The saved-presets panel that sits at the top of the editor. A preset is a named
 * snapshot of this form (never dates — see utils/expense-presets.js), stored in the
 * admin_ui_prefs Supabase table, so it follows the account across devices.
 */
function presetsPanel() {
  const chips = _presets.map(p => `
    <span class="exp-preset" data-preset-id="${escA(p.id)}">
      <button type="button" class="exp-preset__load" data-preset-load="${escA(p.id)}" title="Fill the form from this preset">${esc(p.name)}</button>
      <button type="button" class="exp-preset__del" data-preset-del="${escA(p.id)}" aria-label="Delete preset ${escA(p.name)}" title="Delete preset">${icon('close', 11, 11)}</button>
    </span>`).join('');
  return `
    <div class="exp-recur exp-presets" id="e-presets">
      <div class="exp-recur__title">Presets <span class="exp-hint" style="text-transform:none;font-weight:400">reuse a saved expense — dates always reset to today</span></div>
      <div class="exp-preset-row" id="e-preset-chips">
        ${chips || '<span class="exp-empty-inline" style="padding:4px 0">No presets yet. Fill this form in, then save it as a preset for one-click reuse.</span>'}
      </div>
      <div class="exp-preset-save" id="e-preset-save">
        <input class="admin-input" id="e-preset-name" type="text" maxlength="40" placeholder="Name this preset (e.g. Netflix subscription)" autocomplete="off">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="e-preset-add">Save as preset</button>
      </div>
      <div class="exp-preset-err" id="e-preset-err" role="alert" aria-live="polite"></div>
    </div>`;
}

function editorBody(m) {
  const gstChecked = (m.gst_claimable !== undefined ? m.gst_claimable : gstDefaultFor(m.category || 'other'));
  return `
    <form class="exp-form" id="exp-form" novalidate>
      ${presetsPanel()}
      <div class="exp-form__seg" role="tablist" aria-label="Expense type">
        <button type="button" class="exp-seg ${m.recurrence === 'none' ? 'active' : ''}" data-type="none">One-off</button>
        <button type="button" class="exp-seg ${m.recurrence !== 'none' ? 'active' : ''}" data-type="repeat">Repeating</button>
      </div>

      <div class="exp-field"><label>Name <span class="req">*</span></label><input class="admin-input" id="e-name" value="${escA(m.name)}" placeholder="e.g. Xero subscription, warehouse rent" maxlength="120"></div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label class="exp-cat-label">Category <span class="req">*</span> <button type="button" class="exp-cat-manage" id="e-cat-manage" title="Rename or delete your categories">Manage</button></label>
          <select class="admin-input" id="e-category">${categorySelectOptions(m.category)}</select>
          <div class="exp-preset-save exp-cat-add hidden" id="e-cat-add">
            <input class="admin-input" id="e-cat-add-name" type="text" maxlength="40" placeholder="New category name" autocomplete="off">
            <button type="button" class="admin-btn admin-btn--primary admin-btn--sm" id="e-cat-add-save">Add</button>
            <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="e-cat-add-cancel">Cancel</button>
          </div>
          <div class="exp-preset-err" id="e-cat-add-err" role="alert" aria-live="polite"></div>
        </div>
        <div class="exp-field"><label>Payee / supplier</label><input class="admin-input" id="e-payee" value="${escA(m.payee)}" placeholder="Who is paid" maxlength="120"></div>
      </div>

      <div id="e-linked-note" class="exp-linked-note" style="display:none">${icon('lock', 12, 12)} This is an order-linked cost — it's already counted in per-order profit, so it won't be added to operating expenses. Kept here for cash-flow visibility.</div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label>Amount (NZD, incl GST) <span class="req">*</span></label><input class="admin-input" type="number" step="0.01" min="0" id="e-amount" value="${escA(m.amount)}" placeholder="0.00"></div>
        <div class="exp-field exp-field--check"><label class="exp-check"><input type="checkbox" id="e-gst" ${gstChecked ? 'checked' : ''}> Claim NZ GST input credit</label><span class="exp-hint">Off for foreign SaaS / GST-free spend.</span></div>
      </div>

      <div class="exp-form__grid2">
        <div class="exp-field"><label id="e-date-label">Expense date <span class="req">*</span></label><input class="admin-input" type="date" id="e-date" value="${escA(m.expense_date)}"><span class="exp-hint" id="e-first-occ"></span></div>
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
  // Show where a repeating series will actually begin once its day-of-week /
  // day-of-month rule is applied. That snapped date is what we STORE (see
  // collectPayload), which is what keeps our projection and the backend's identical.
  const syncFirstOcc = () => {
    const hint = $('#e-first-occ');
    if (!hint) return;
    const type = root.querySelector('.exp-seg.active')?.dataset.type || 'none';
    if (type === 'none') { hint.textContent = ''; return; }
    const probe = collectPayload(root, { snap: false });
    const first = firstOccurrence(probe);
    hint.textContent = (first && first !== probe.expense_date)
      ? `Starts on its first occurrence: ${fmtDate(first)}`
      : '';
  };

  root.querySelectorAll('.exp-seg').forEach(b => b.addEventListener('click', () => { setType(b.dataset.type); syncFirstOcc(); }));
  $('#e-freq')?.addEventListener('change', () => { syncFreqFields(); syncFirstOcc(); });

  // ── Category select: the "＋ Add new category…" sentinel + manager ──
  // The select must never be LEFT on the sentinel — we snap back to the last real
  // choice and reveal the inline add row instead.
  let lastCat = model.category || '';
  const catAddErr = (msg) => { const el = $('#e-cat-add-err'); if (el) el.textContent = msg || ''; };
  const hideCatAdd = () => {
    $('#e-cat-add')?.classList.add('hidden');
    const nameEl = $('#e-cat-add-name');
    if (nameEl) nameEl.value = '';
    catAddErr('');
  };
  $('#e-category')?.addEventListener('change', () => {
    const v = $('#e-category').value;
    if (v === '__new__') {
      $('#e-category').value = lastCat;
      $('#e-cat-add')?.classList.remove('hidden');
      setTimeout(() => $('#e-cat-add-name')?.focus(), 0);
      return;
    }
    lastCat = v;
    syncLinkedNote();
  });
  const commitNewCategory = async () => {
    const label = ($('#e-cat-add-name')?.value || '').trim();
    let next;
    try { next = addCustomCategory(_customCats, label); }
    catch (e3) { catAddErr(e3.message); $('#e-cat-add-name')?.focus(); return; }
    const durable = await saveCategories(next.list);
    hideCatAdd();
    rebuildCategorySelect(root, next.key);   // fires change → lastCat + GST default sync
    refreshFilterCategoryOptions();
    if (durable === false) Toast.warning(`Category "${label}" saved on this device only — it couldn't reach the server.`);
    else Toast.success(`Category "${label}" added.`);
  };
  $('#e-cat-add-save')?.addEventListener('click', commitNewCategory);
  $('#e-cat-add-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNewCategory(); } });
  $('#e-cat-add-cancel')?.addEventListener('click', hideCatAdd);
  $('#e-cat-manage')?.addEventListener('click', () => openCategoryManager(root));

  $('#e-gst')?.addEventListener('change', () => { $('#e-gst').dataset.touched = '1'; });
  $('#e-endmode')?.addEventListener('change', syncEndMode);
  $('#e-paid')?.addEventListener('change', () => $('#e-paid-wrap').classList.toggle('hidden', !$('#e-paid').checked));
  for (const sel of ['#e-date', '#e-dow', '#e-dom', '#e-month', '#e-ydom', '#e-interval']) {
    $(sel)?.addEventListener('change', syncFirstOcc);
  }

  // ── Presets ──
  const presetErr = (msg) => { const el = $('#e-preset-err'); if (el) el.textContent = msg || ''; };

  // Fill the live form from a preset, then re-run every sync so the conditional
  // panels (recurrence fields, order-linked note, end-mode) match what we just wrote.
  const applyPreset = (preset) => {
    const patch = applyPresetToDraft(preset);
    const set = (sel, v) => { const el = $(sel); if (el != null && v !== undefined) el.value = v; };
    set('#e-name', patch.name ?? '');
    set('#e-category', patch.category ?? '');
    // A preset can carry a category that has since been deleted — the select falls
    // to '' and validatePayload asks for a category. Track the landed value so the
    // add-category sentinel snaps back to it, not to a stale choice.
    lastCat = $('#e-category')?.value || '';
    set('#e-payee', patch.payee ?? '');
    set('#e-amount', patch.amount ?? '');
    set('#e-method', patch.method ?? '');
    set('#e-ref', patch.reference ?? '');
    set('#e-notes', patch.notes ?? '');
    if ($('#e-gst')) { $('#e-gst').checked = !!patch.gst_claimable; $('#e-gst').dataset.touched = '1'; }

    const rec = patch.recurrence && patch.recurrence !== 'none' ? patch.recurrence : 'none';
    if (rec !== 'none') {
      set('#e-freq', rec);
      if (patch.recurrence_day_of_week != null) set('#e-dow', patch.recurrence_day_of_week);
      if (patch.recurrence_day_of_month != null) { set('#e-dom', patch.recurrence_day_of_month); set('#e-ydom', patch.recurrence_day_of_month); }
      if (patch.recurrence_month != null) set('#e-month', patch.recurrence_month);
      if (patch.recurrence_interval_days != null) set('#e-interval', patch.recurrence_interval_days);
      if (patch.recurrence_count != null) { set('#e-endmode', 'after'); set('#e-end-count', patch.recurrence_count); }
      else set('#e-endmode', 'never');
    }
    // Dates are never carried by a preset — always re-anchor on today.
    set('#e-date', todayInputValue());
    set('#e-due', '');
    if ($('#e-paid')) { $('#e-paid').checked = false; $('#e-paid-wrap')?.classList.add('hidden'); }

    setType(rec === 'none' ? 'none' : 'repeat');
    syncLinkedNote();
    syncEndMode();
    syncFreqFields();
    syncFirstOcc();
    presetErr('');
    Toast.info(`Loaded preset "${preset.name}".`);
  };

  root.querySelector('#e-preset-chips')?.addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('[data-preset-load]');
    if (loadBtn) {
      const p = _presets.find(x => x.id === loadBtn.dataset.presetLoad);
      if (p) applyPreset(p);
      return;
    }
    const delBtn = e.target.closest('[data-preset-del]');
    if (delBtn) {
      const p = _presets.find(x => x.id === delBtn.dataset.presetDel);
      if (!p) return;
      Modal.confirm({
        title: 'Delete preset',
        message: `Delete the preset "${p.name}"? This doesn't touch any saved expense.`,
        confirmLabel: 'Delete preset',
        onConfirm: async () => {
          const ok = await savePresets(removePreset(_presets, p.id));
          if (ok !== false) Toast.success(`Preset "${p.name}" deleted.`);
          refreshPresetChips(root);
        },
      });
    }
  });

  $('#e-preset-add')?.addEventListener('click', async () => {
    const nameEl = $('#e-preset-name');
    const name = (nameEl?.value || '').trim();
    const overwrite = presetNameExists(_presets, name);
    const err = validatePreset(name, _presets, { allowOverwrite: overwrite });
    if (err) { presetErr(err); nameEl?.focus(); return; }
    presetErr('');

    const commit = async () => {
      // A preset is a template, not an expense — no amount/date validation here.
      const snapshot = collectPayload(root, { snap: false });
      let next;
      try { next = upsertPreset(_presets, toPreset(snapshot, name)); }
      catch (e3) { presetErr(e3.message); return; }
      const durable = await savePresets(next);
      refreshPresetChips(root);
      if (nameEl) nameEl.value = '';
      if (durable === false) {
        Toast.warning(`Preset "${name}" saved on this device only — it couldn't reach the server.`);
      } else {
        Toast.success(`Preset "${name}" saved.`);
      }
    };

    if (overwrite) {
      Modal.confirm({
        title: 'Overwrite preset',
        message: `A preset called "${name}" already exists. Replace it with the current form?`,
        confirmLabel: 'Overwrite', confirmClass: 'admin-btn--primary',
        onConfirm: commit,
      });
    } else {
      await commit();
    }
  });

  setType(model.recurrence !== 'none' ? 'repeat' : 'none');
  syncLinkedNote();
  syncEndMode();
  syncFirstOcc();
  setTimeout(() => $('#e-name')?.focus(), 60);

  d.footer.querySelector('[data-x="cancel"]').addEventListener('click', () => Drawer.close());
  const saveBtn = d.footer.querySelector('[data-x="save"]');
  saveBtn.addEventListener('click', async () => {
    const built = collectPayload(root);
    const err = validatePayload(built, root);
    if (err) { $('#e-err').textContent = err; return; }
    $('#e-err').textContent = '';
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    // The backend's category enum doesn't know the owner's custom keys — those
    // save as 'other' (same operating kind, so no total changes) and the real
    // key rides in the per-expense override map (see CATEGORY_OVERRIDES_KEY).
    const customKey = backendAcceptsCategory(built.category) ? null : built.category;
    const payload = customKey ? { ...built, category: 'other' } : built;
    try {
      let created = null;
      if (isNew) created = await AdminAPI.expenses.create(payload);
      else await AdminAPI.expenses.update(model.id, payload);
      if (token !== _editorToken && !_alive) return;
      const savedId = isNew ? (created?.expense?.id ?? created?.id ?? null) : model.id;
      if (customKey && savedId == null) {
        // Legacy create path without an id: the row will read as "Other" — say so.
        Toast.warning(`Saved, but the server returned no id — this expense will show as "Other" instead of "${categoryLabel(customKey)}".`);
      } else {
        const ovOk = await syncCategoryOverride(savedId, customKey);
        if (ovOk === false) Toast.warning('Saved — but the category label could only be stored on this device.');
        else Toast.success(isNew ? 'Expense saved.' : 'Expense updated.');
      }
      Drawer.close();
      await loadData();
    } catch (e2) {
      saveBtn.disabled = false; saveBtn.textContent = isNew ? 'Save expense' : 'Save changes';
      showSaveError($, e2, isNew);
    }
  });
}

// Field id for each name the backend can cite in a VALIDATION_FAILED detail.
const FIELD_TO_INPUT = {
  name: '#e-name', category: '#e-category', payee: '#e-payee', amount: '#e-amount',
  expense_date: '#e-date', due_date: '#e-due', paid_date: '#e-paid-date',
  method: '#e-method', reference: '#e-ref', notes: '#e-notes',
  recurrence: '#e-freq', recurrence_day_of_week: '#e-dow',
  recurrence_day_of_month: '#e-dom', recurrence_month: '#e-month',
  recurrence_interval_days: '#e-interval', recurrence_end: '#e-end-date',
  recurrence_count: '#e-end-count',
};

/**
 * Render a save failure. The backend returns VALIDATION_FAILED with
 * `details: [{ field, message }]` — we pin each message to its own input rather than
 * dumping one generic line, so the operator can see exactly what to fix.
 */
function showSaveError($, err, isNew) {
  // Clear any previous inline marks.
  for (const sel of Object.values(FIELD_TO_INPUT)) {
    const el = $(sel);
    if (el) el.classList.remove('exp-input--invalid');
    el?.parentElement?.querySelector('.exp-field-err')?.remove();
  }

  const details = Array.isArray(err?.details) ? err.details : null;
  if (err?.code === 'VALIDATION_FAILED' && details && details.length) {
    let first = null;
    for (const d of details) {
      const sel = FIELD_TO_INPUT[d?.field];
      const el = sel ? $(sel) : null;
      if (!el) continue;
      el.classList.add('exp-input--invalid');
      const msg = document.createElement('span');
      msg.className = 'exp-field-err';
      msg.textContent = d.message || 'Invalid value.';
      el.parentElement?.appendChild(msg);
      if (!first) first = el;
    }
    $('#e-err').textContent = first ? 'Please fix the highlighted fields.' : (err.message || 'Validation failed.');
    first?.focus();
    return;
  }

  if (err?.code === 'RATE_LIMITED') {
    $('#e-err').textContent = 'Too many saves at once. Wait a few seconds and try again.';
    return;
  }
  if (err?.code === 'NOT_FOUND' && !isNew) {
    $('#e-err').textContent = 'That expense no longer exists — it may have been deleted. Close and refresh.';
    return;
  }
  $('#e-err').textContent = err?.message || 'Could not save. Please try again.';
}

/**
 * Read the form into an API payload.
 *
 * `snap` (default true) pins a recurring series' `expense_date` to its FIRST real
 * occurrence. This is what guarantees our projection and the backend's agree: the
 * backend anchors stepping on `expense_date` and ignores the dow/dom fields, so once
 * the start date IS the first occurrence, both produce the identical series. Pass
 * { snap:false } for a preview/preset snapshot (nothing is being persisted).
 */
function collectPayload(root, { snap = true } = {}) {
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

    if (snap) {
      const first = firstOccurrence(payload);
      if (first) { payload.expense_date = first; payload.date = first; }
    }
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
      // Categories must be in the registry BEFORE loadData enriches rows (labels,
      // kinds, GST defaults all resolve through it). getUiPrefs is promise-cached,
      // so loadPresets re-reading it costs nothing.
      await loadCategories();
      // Presets are a UI nicety — never let them block or break the page load.
      await Promise.all([loadData(), loadPresets()]);
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
    _presets = [];
    _customCats = [];
    _catOverrides = {};
    _backendCatKeys = null;
    _serverSummary = null;
  },
};
