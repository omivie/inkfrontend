/**
 * Dashboard (rebuilt, Nov 2026) — money first, then the graph, then what to do today.
 *
 * Owner brief (2026-11-25): "the first thing it should tell me is our revenue, gross profit
 * and net profit, percentages, etc." Every other chart moved to Analytics → Trends.
 *
 *   1. Money boxes — utils/money-truth.js, on the owner's definitions. Every box opens
 *      "How it's calculated": the formula, every input with its amount, and whether that input
 *      is the backend's figure or adjusted on this screen.
 *   2. Performance overview graph — the backend's per-period series (utils/dash-charts.js).
 *   3. To-do — tracking, sales missing a cost, low margin, out of stock, bills to pay, possible
 *      duplicate expenses, pending refunds, tax paid filed as an expense, invoices costed
 *      above their price.
 *
 * SPEED (measured 2026-11-25, old page: first money box 17.0 s, 147 requests). The money
 * boxes wait ONLY for their own inputs (1 analytics call + 4 list calls + cached prefs). The
 * graph and the to-do cards load in parallel and paint into their own slots when they land.
 * "Sales missing a cost" reads `cost_complete` off the order LIST rows (backend handoff
 * readfirst/dashboard-missing-cost-backend-handoff-jul2026.md) instead of ~120 order-detail
 * requests.
 *
 * Side-by-side rollout: this is #dashboard-new until the owner approves it.
 */
import { AdminAuth, FilterState, AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { Drawer } from '../components/drawer.js';
import {
  formatPrice, timeAgo, firstArray, resolveGranularity, rangeLabel, bundleToGraphs,
  drawPerformanceOverview, setEffectiveGranularity, normalizeWorstMargin, orderRef,
} from '../utils/dash-charts.js';
import {
  LOW_MARGIN_PCT, isInvoiceOrder, outOfStockCount, computeTrackingAlert, computeLowMarginAlert,
  alertCard, wireAlertToggles,
} from '../utils/dash-alerts.js';
import { moneyTruth, moneyTodos } from '../utils/money-truth.js';
import {
  categoryKind, resolveRowCategory, normalizeCategoryOverrides, CATEGORY_OVERRIDES_KEY,
} from '../utils/expense-categories.js';
import { normalizeSeries } from '../utils/traffic-analytics.js';

let _container = null;
let _seq = 0;
const _cache = new Map();   // range key → last painted state (instant repaint on return)

const ADJ = 'adjusted on this screen';
const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
const money = (v) => (v == null ? '—' : formatPrice(v));

// ── list readers: every page, or say how much was read ─────────────────────────────────
async function allPages(fetchPage, readRows, pageSize, maxPages = 10) {
  const rows = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchPage(page, pageSize);
    if (data == null) return null;   // a failed read is "did not load", never an empty list
    const got = readRows(data);
    rows.push(...got);
    // No server total ⇒ NaN, and money-truth refuses the list as "did not say how many".
    total = Number(data.pagination?.total ?? NaN);
    if (rows.length >= total || got.length < pageSize) break;
  }
  return { rows, total };
}
const orderRows = (d) => (Array.isArray(d) ? d : firstArray(d, ['orders', 'data', 'items']));

async function loadExpenses() {
  const [list, prefs] = await Promise.all([AdminAPI.expenses.list({ limit: 1000 }), AdminAPI.getUiPrefs().catch(() => null)]);
  if (!list) return null;
  const overrides = normalizeCategoryOverrides(prefs?.[CATEGORY_OVERRIDES_KEY]);
  const rows = list.items.map((r) => ({ ...r, kind: categoryKind(resolveRowCategory(r.category, r.id, overrides)) }));
  return { rows, total: Number(list.pagination?.total ?? NaN), legacy: !!list._legacy };
}

/** Invoice sales records: every order matching INV-, kept only if it IS an invoice sale. */
async function loadShadows(signal) {
  const all = await allPages((p, n) => AdminAPI.getOrders({ search: 'INV-' }, p, n, signal), orderRows, 200);
  if (!all || all.rows.length !== all.total) return all;   // incomplete stays incomplete (refused downstream)
  const rows = all.rows.filter((o) => o.channel === 'invoice');
  return { rows, total: rows.length };
}

/**
 * Refunds, each processed one carrying the status of its order (refund rows have none), so a
 * refund on a cancelled or test order is not taken off revenue the backend never counted.
 * A lookup that fails leaves the status unknown, and money-truth refuses the refunds part.
 */
async function loadRefunds(signal) {
  const list = await allPages((p, n) => AdminAPI.getRefunds({}, p, n), (d) => d.refunds || [], 100);
  if (!list) return null;
  const numbers = [...new Set(list.rows.filter((r) => r.status === 'processed').map((r) => r.order_number))];
  const found = new Map();
  await Promise.all(numbers.map(async (num) => {
    const rows = orderRows(await AdminAPI.getOrders({ search: num }, 1, 5, signal) || []);
    const o = rows.find((x) => x.order_number === num);
    if (o) found.set(num, { order_status: String(o.status || ''), order_is_test: o.is_test_order === true });
  }));
  return { ...list, rows: list.rows.map((r) => ({ ...r, ...(found.get(r.order_number) || {}) })) };
}

// ── money boxes ────────────────────────────────────────────────────────────────────────
const BOXES = [
  { key: 'revenueExGst', label: 'Revenue', sub: (f) => `incl. GST ${money(f.revenueInclGst.value)}` },
  { key: 'grossProfit', label: 'Gross profit', sub: (f) => `margin ${pct(f.grossMargin.value)}`, alertNeg: true },
  { key: 'netProfit', label: 'Net profit', sub: (f) => `margin ${pct(f.netMargin.value)}`, alertNeg: true },
  { key: 'orders', label: 'Orders', fmt: (v) => (v == null ? '—' : String(v)) },
  { key: 'aov', label: 'Average order', sub: () => 'revenue ÷ orders' },
  { key: 'owed', label: 'Owed to us', sub: (f, m) => `${m.owedToUs.inputs.length} unpaid invoice${m.owedToUs.inputs.length === 1 ? '' : 's'} · any date` },
];

function delta(fig, compare) {
  if (!compare || fig.prev == null || fig.value == null) return '';
  if (!fig.prevComparable) return '<span class="admin-kpi__delta admin-kpi__delta--flat" data-tooltip="The previous period could not be adjusted the same way, so no comparison.">no comparison</span>';
  if (fig.prev === 0) return '';
  const p = ((fig.value - fig.prev) / Math.abs(fig.prev)) * 100;
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const arrow = p > 0 ? '↑' : p < 0 ? '↓' : '→';
  return `<span class="admin-kpi__delta admin-kpi__delta--${cls}" data-tooltip="Previous period: ${esc(String(fig.prev))}">${arrow} ${Math.abs(p).toFixed(1)}%</span>`;
}

function boxFigure(m, key) {
  return key === 'owed' ? { ...m.owedToUs, adjusted: false } : m.figures[key];
}

function renderBoxes(m, compare) {
  if (!m.figures) {
    return `<div class="admin-dash-note--alert fh-pnl-note"><strong>The money figures could not load.</strong> ${m.warnings.map(esc).join(' ')}</div>`;
  }
  const boxes = BOXES.map((b) => {
    const fig = boxFigure(m, b.key);
    const neg = b.alertNeg && fig.value != null && fig.value < 0;
    const value = b.fmt ? b.fmt(fig.value) : money(fig.value);
    return `
      <button type="button" class="admin-kpi dash2-box${neg ? ' admin-kpi--alert' : ''}" data-how="${esc(b.key)}"
        aria-label="${esc(b.label)}: ${esc(value)}. How it's calculated">
        <div class="admin-kpi__label">${esc(b.label)}${fig.adjusted ? ' <span class="dash2-adj">adjusted</span>' : ''}</div>
        ${fig.basis ? `<div class="admin-kpi__basis">${esc(fig.basis)}</div>` : ''}
        <div class="admin-kpi__value${fig.value == null ? ' admin-kpi__value--missing' : ''}">${esc(value)}</div>
        ${b.sub ? `<div class="admin-kpi__sub">${esc(b.sub(m.figures, m))}</div>` : ''}
        ${b.key === 'owed' ? '' : delta(fig, compare)}
        <div class="dash2-how">How it's calculated →</div>
      </button>`;
  }).join('');
  const warn = m.warnings.length
    ? `<div class="fh-pnl-note admin-dash-note--alert">${m.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : '';
  return `<div class="admin-kpi-grid admin-kpi-grid--3">${boxes}</div>${warn}`;
}

// ── How it's calculated ────────────────────────────────────────────────────────────────
const RATIO_OF = { grossMargin: 'grossProfit', netMargin: 'netProfit' };

function inputsTable(inputs) {
  if (!inputs.length) return '';
  const rows = inputs.map((i) => `
    <tr${i.source === ADJ ? ' class="dash2-row--adj"' : ''}>
      <td>${esc(i.label)}</td>
      <td class="cell-mono dash2-amt">${esc(formatPrice(i.amount))}</td>
      <td class="dash2-src">${esc(i.source)}</td>
    </tr>`).join('');
  return `<table class="admin-dash-table dash2-how-table"><thead><tr><th>Input</th><th>Amount</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const FORMULAS = {
  revenueExGst: 'Sales incl. GST (shipping charged included) − processed refunds, then GST taken out (× 20/23). Invoices count on their issue date, paid or not.',
  grossProfit: 'Revenue ex GST − cost of goods ex GST. Invoices count revenue and cost on their issue date. A refund takes the whole ex-GST amount off (goods are not restocked).',
  netProfit: 'Gross profit − Stripe card fees − supplier freight − operating expenses. Expenses count on their bill date, paid or not. "GST payment to IRD" is not an expense.',
  orders: 'Sales the backend counts (every status except cancelled), with invoices counted on their issue date.',
  aov: 'Revenue ex GST ÷ orders.',
  owed: 'Every invoice not paid and not void, whatever its date.',
};

function openHow(m, key) {
  const box = BOXES.find((b) => b.key === key);
  const fig = boxFigure(m, key);
  const parts = [`<p class="dash2-formula">${esc(FORMULAS[key] || '')}</p>`];
  if (fig.value == null) parts.push(`<p class="fh-pnl-note admin-dash-note--alert">${esc(fig.note || 'Not available for this range.')}</p>`);
  if (fig.of) parts.push(`<p>${esc(fig.of[0])} ÷ ${esc(fig.of[1])}</p>`);
  parts.push(inputsTable(fig.inputs || []));
  if (fig.inputs?.length) parts.push(`<p class="dash2-total">= <strong>${esc(box?.fmt ? box.fmt(fig.value) : money(fig.value))}</strong></p>`);
  if (fig.replaces && fig.adjusted) parts.push(`<p class="fh-pnl-note">Replaces the backend's <code>${esc(fig.replaces)}</code> until the backend ships the matching change (backend asks, 25 Nov 2026).</p>`);
  if (fig.note && fig.value != null) parts.push(`<p class="fh-pnl-note">${esc(fig.note)}</p>`);
  for (const [ratioKey, base] of Object.entries(RATIO_OF)) {
    if (base === key && m.figures[ratioKey].value != null) parts.push(`<p>Margin: ${esc(pct(m.figures[ratioKey].value))} of revenue ex GST.</p>`);
  }
  const adj = m.adjustments.map((a) => `<li><strong>${esc(a.id)}</strong> (backend ask ${esc(a.ask)}): ${a.applied ? 'applied' : esc(a.backendHasIt ? 'the backend does this now' : `not applied — ${a.reason}`)}</li>`).join('');
  parts.push(`<details class="dash2-details"><summary>All adjustments for ${esc(m.range.from)} – ${esc(m.range.to)}</summary><ul>${adj}</ul></details>`);
  const d = Drawer.open({ title: `${box?.label || key} — how it's calculated`, body: `<div class="dash2-how-body">${parts.join('')}</div>`, footer: '<button class="admin-btn admin-btn--ghost" data-x="close">Close</button>' });
  d?.footer.querySelector('[data-x="close"]')?.addEventListener('click', () => Drawer.close());
}

// ── to-do ──────────────────────────────────────────────────────────────────────────────
const failCard = (title, why) => alertCard(title, '—', `${why} — this is not a zero. Reload to retry.`, [], 'warning', '', 4);

function missingCostFromList(list) {
  if (!list) return null;
  const live = list.rows.filter((o) => String(o.status || '').toLowerCase() !== 'cancelled');
  const culprits = live.filter((o) => o.cost_complete === false);
  const unknown = live.filter((o) => o.cost_complete == null).length;
  return {
    unknown,
    incomplete: list.rows.length < list.total,
    items: culprits.map((o) => ({
      label: `${orderRef(o.order_number || o.id)} · ${formatPrice(Number(o.total) || 0)}`,
      badge: (o.missing_cost_skus || []).slice(0, 2).join(', ') || 'no cost recorded',
      badgeCls: 'admin-badge--failed',
      href: isInvoiceOrder(o) ? 'invoices' : `orders?focus=${encodeURIComponent(window.OrderNumber.forDisplay(o.order_number))}`,
    })),
  };
}

function renderTodo(t) {
  const cards = [];
  const quiet = [];
  const add = (title, list, why, sev = 'warning', fail = 'could not load', count = list?.length) => {
    if (list == null) { cards.push(failCard(title, fail)); return; }
    if (!list.length) { quiet.push(title); return; }
    cards.push(alertCard(title, count, why, list, sev, '', 4));
  };
  if (t.tracking === undefined) return '<div class="admin-dash-inline-empty">Loading the to-do list…</div>';

  add('Orders needing tracking', t.tracking?.items ?? null, 'paid or processing, no tracking number yet', 'danger');
  if (t.missingCost) {
    const why = `no cost of goods recorded, so profit can't be counted for them${t.missingCost.unknown ? ` · ${t.missingCost.unknown} not checked by the backend` : ''}${t.missingCost.incomplete ? ' · not every order was read' : ''}`;
    add('Sales missing a cost', t.missingCost.items, why, 'danger');
  } else add('Sales missing a cost', null, '');
  add('Low-margin products', t.lowMargin?.items ?? null, `under ${LOW_MARGIN_PCT}% net margin — reprice or drop`);
  add('Out of stock', t.oos, 'products flagged out of stock — the first 50 are listed', 'warning', 'could not load', t.oosCount);
  add('Bills to pay', t.bills, 'expenses due or overdue');
  add('Possible duplicate expenses', t.money?.duplicates ?? null, 'same payee, near-same amount, within 5 days — delete one if it was entered twice');
  add('Refunds still pending', t.money?.pendingRefunds ?? null, 'not counted until processed — finish or cancel them');
  add('Tax payment filed as an expense', t.money?.taxAsExpense ?? null, 'GST paid to IRD is not a cost — move it to "GST payment to IRD"');
  add('Invoice cost above its price', t.money?.invoiceCostOverPrice ?? null, 'check the cost entered on these invoices');

  const quietLine = quiet.length ? `<p class="fh-pnl-note">All clear: ${quiet.map(esc).join(' · ')}</p>` : '';
  return `<div class="admin-dash">${cards.join('')}</div>${quietLine}`;
}

// ── page ───────────────────────────────────────────────────────────────────────────────
function shell(state) {
  return `
    <div class="admin-page-header admin-page-header--dash">
      <h1>Dashboard <small class="dash2-tag">new</small></h1>
      <span class="admin-dash__updated">${state.loadedAt ? `Updated ${esc(timeAgo(state.loadedAt))}` : 'Loading…'}</span>
    </div>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--cyan">Money <small>${esc(rangeLabel())}</small></div>
      <div id="dash2-money">${state.money ? renderBoxes(state.money, state.compare) : '<div class="admin-kpi-grid admin-kpi-grid--3 admin-kpi-grid--loading">' + BOXES.map((b) => `<div class="admin-kpi"><div class="admin-kpi__label">${esc(b.label)}</div><div class="admin-kpi__value">…</div></div>`).join('') + '</div>'}</div>
    </section>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--cyan">Performance <small>${esc(rangeLabel())}</small></div>
      <div class="admin-dash">
        <div class="admin-dash__cell--12 admin-card">
          <div class="admin-card__title"><span>Performance overview <small>revenue · profit · costs · orders, per period — the backend's figures, before this screen's adjustments</small></span></div>
          <div class="admin-chart-box admin-chart-box--xtall"><canvas id="dash-c-overview"></canvas></div>
          <div id="dash-overview-notes"></div>
        </div>
      </div>
    </section>
    <section class="admin-dash-row">
      <div class="admin-dash-row__label admin-dash-row__label--danger">To do</div>
      <div id="dash2-todo">${renderTodo(state.todo || {})}</div>
    </section>`;
}

function paintMoney(state) {
  const host = _container?.querySelector('#dash2-money');
  if (!host || !state.money) return;
  host.innerHTML = renderBoxes(state.money, state.compare);
  host.querySelectorAll('[data-how]').forEach((btn) => btn.addEventListener('click', () => openHow(state.money, btn.dataset.how)));
  const stamp = _container.querySelector('.admin-dash__updated');
  if (stamp && state.loadedAt) stamp.textContent = `Updated ${timeAgo(state.loadedAt)}`;
}

function paintGraph(state) {
  if (!state.graph || !_container) return;
  setEffectiveGranularity(state.graph._effectiveGranularity);
  Charts.destroyAll();
  try { drawPerformanceOverview(state.graph); } catch (e) { window.DebugLog?.warn?.('[Dashboard new] graph', e?.message); }
}

function paintTodo(state) {
  const host = _container?.querySelector('#dash2-todo');
  if (!host) return;
  host.innerHTML = renderTodo(state.todo || {});
  wireAlertToggles(host);
}

async function load() {
  if (!_container) return;
  const mySeq = ++_seq;
  const live = () => mySeq === _seq && !!_container;
  FilterState.setBusy(true);

  const range = FilterState.getDateRange();
  const compare = FilterState.get('period') !== 'all';
  const key = `${range.from}|${range.to}|${FilterState.get('granularity')}`;
  const cached = _cache.get(key);
  const state = cached ? { ...cached } : { compare, todo: {} };
  _container.innerHTML = shell(state);
  if (cached) { paintMoney(state); paintGraph(state); paintTodo(state); }

  // Money: kpi with the date range ONLY — the adjustments are whole-business, so a
  // brand/status-filtered kpi would mix two populations.
  const kpiParams = new URLSearchParams({ from: range.from, to: range.to });
  const signal = FilterState.getAbortSignal();
  const lists = {
    invoices: allPages((p, n) => AdminAPI.listInvoices({}, p, n), (d) => d.invoices || [], 100),
    shadows: loadShadows(signal),
    refunds: loadRefunds(signal),
    expenses: loadExpenses(),
  };
  const kpiP = AdminAPI.getDashboardKPIs(kpiParams, signal);
  const moneyP = Promise.allSettled([kpiP, lists.invoices, lists.shadows, lists.refunds, lists.expenses])
    .then((r) => {
      const v = (i) => (r[i].status === 'fulfilled' ? r[i].value : null);
      const src = { range, compare, kpi: v(0), invoices: v(1), shadows: v(2), refunds: v(3), expenses: v(4), asOf: new Date().toISOString() };
      if (!live()) return;
      state.money = moneyTruth(src);
      state.loadedAt = src.asOf;
      state.todo.money = moneyTodos(src);
      state.todo.bills = src.expenses
        ? src.expenses.rows.filter((e) => !e.deleted_at && (e.derived_status === 'due' || e.derived_status === 'overdue'))
          .map((e) => ({ label: `${e.name || e.payee}: ${formatPrice(Number(e.amount))} ${e.derived_status}${e.due_date ? ` (due ${e.due_date})` : ''}`, href: 'expenses' }))
        : null;
      paintMoney(state);
    });

  // Graph: the backend bundle (+ traffic overlay), painted when it lands.
  const g = resolveGranularity();
  // The traffic overlay is slow (10 s measured for 8 months), so the graph paints without it
  // and repaints once it lands — it never holds the graph back.
  const trafficP = AdminAPI.getTrafficTimeseries(range.from, range.to, signal).catch(() => null);
  const graphP = Promise.allSettled([AdminAPI.getDashboardBundle(kpiParams, g, signal), lists.expenses, kpiP])
    .then(async (r) => {
      const v = (i) => (r[i].status === 'fulfilled' ? r[i].value : null);
      if (!live()) return;
      const bundle = v(0);
      state.graph = { ...bundleToGraphs(bundle), kpis: v(2), sTraffic: [], expenseRows: v(1)?.rows || [], _effectiveGranularity: (bundle && bundle._granularity) || g };
      paintGraph(state);
      const traffic = await trafficP;
      if (!live()) return;
      state.graph = { ...state.graph, sTraffic: normalizeSeries(traffic) };
      paintGraph(state);
    });

  // To-do: everything else, after the money is on its way.
  const todoP = Promise.allSettled([
    AdminAPI.getTrackingRequests({ status: 'pending' }, signal),
    AdminAPI.getOrders({ statuses: ['paid', 'processing'] }, 1, 100, signal),
    allPages((p, n) => AdminAPI.getOrders({ from: range.from, to: range.to }, p, n, signal), orderRows, 200),
    AdminAPI.getUnderMarginProducts('genuine', 1, 60, 'under-margin', 'net_margin', 'asc', signal),
    AdminAPI.getUnderMarginProducts('compatible', 1, 60, 'under-margin', 'net_margin', 'asc', signal),
    AdminAPI.getOutOfStock({ limit: 50 }, signal),
  ]).then(async (r) => {
    const v = (i) => (r[i].status === 'fulfilled' ? r[i].value : null);
    await moneyP;   // the money to-dos come from the same lists
    if (!live()) return;
    state.todo.tracking = v(0) == null && v(1) == null ? null : computeTrackingAlert(v(0), v(1));
    state.todo.missingCost = missingCostFromList(v(2));
    state.todo.lowMargin = v(3) == null && v(4) == null ? null : computeLowMarginAlert(normalizeWorstMargin([v(3), v(4)]), null, false);
    const oos = v(5);
    const oosRows = oos == null ? null : firstArray(oos.data && !Array.isArray(oos.data) ? oos.data : oos, ['out_of_stock', 'items', 'products', 'data']);
    state.todo.oos = oosRows == null ? null : oosRows.map((p) => ({ label: p.name || p.sku, badge: p.sku, href: `products?search=${encodeURIComponent(p.sku || p.name || '')}` }));
    state.todo.oosCount = oos == null ? null : outOfStockCount(oos);
    paintTodo(state);
  });

  try {
    await Promise.allSettled([moneyP, graphP, todoP]);
    if (live() && state.money) _cache.set(key, state);
  } finally {
    if (mySeq === _seq) FilterState.setBusy(false);
  }
}

export default {
  title: 'Dashboard (new)',

  async init(container) {
    _container = container;
    if (!AdminAuth.isOwner()) {
      container.innerHTML = '<div class="admin-page-header"><h1>Dashboard</h1></div><div class="admin-empty"><div class="admin-empty__title">Owner access required</div></div>';
      return;
    }
    FilterState.setDefaults({ period: '1m', granularity: 'all' });
    FilterState.setVisibleFilters(['period']);   // money is whole-business: no brand/status filter
    FilterState.setGranularityVisible(true);
    await load();
  },

  destroy() {
    Charts.destroyAll();
    FilterState.setGranularityVisible(false);
    FilterState.setVisibleFilters(null);
    FilterState.setBusy(false);
    _container = null;
    _seq++;
  },

  async onFilterChange() {
    if (_container) await load();
  },
};
