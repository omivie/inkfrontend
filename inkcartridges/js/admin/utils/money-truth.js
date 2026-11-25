/**
 * money-truth.js — the Dashboard's money boxes, on the owner's definitions (2026-11-25)
 * ===================================================================================
 *
 * Starts from the backend's kpi-summary (NZ calendar days, migration 212) and applies three
 * LABELLED adjustments where the backend's definition differs from the owner's. Each one is
 * a single function that either applies in full or refuses as a unit with a reason — never a
 * partial sum, never a missing input read as zero (fail-soft must be LOUD).
 *
 *   §1 redateInvoices   An invoice's revenue AND cost of goods count on its ISSUE DATE.
 *                       Backend dates the invoice's sales record (shadow order) instead, and
 *                       INV-3298 (issued 22 Nov) carries a 1 Oct record. Outbox §1.
 *   §3 refundsIn        PROCESSED refunds come off revenue and profit on the day the money went
 *                       back (`refunded_at`). Goods are not restocked (owner), so the whole
 *                       ex-GST refund comes off profit. Outbox §3.
 *   §4 opexByBillDate   Operating expenses count on their BILL date, paid or not, and a
 *                       "GST payment to IRD" row (kind 'not_expense') is not an expense at all.
 *                       Backend counts only PAID rows on their paid date. Outbox §4 + §5.
 *
 * REMOVAL MAP — when the backend ships a section (backend-docs/outbox/backend-asks-2026-11-25-
 * dashboard.md), delete the matching function and its tests:
 *   §1 ⇒ redateInvoices + the shadow-order fetch (it already becomes a no-op on its own)
 *   §3 ⇒ refundsIn (it switches itself off when kpi-summary returns `refunds`)
 *   §4/§5 ⇒ opexByBillDate (its cross-check refuses on its own once the backend changes)
 *   §6 ⇒ this whole module
 *
 * The FE computes no prices. It re-dates and re-sums amounts the backend reports, and labels
 * every one. Every money figure's `inputs` add up EXACTLY to its `value` (the How-it's-
 * calculated panel prints them); ratio figures carry `of` instead.
 *
 * Import-free on purpose (pure, vm-testable): tests/money-truth-nov2026.test.js.
 */

const EX_GST = 20 / 23;                 // incl. GST ⇒ ex GST at NZ 15%
const GST_SHARE = 3 / 23;               // GST share of a GST-inclusive amount
const BACKEND = 'backend';
const ADJUSTED = 'adjusted on this screen';
const ORDER_LINKED_RAW = ['inventory', 'merchant_fees', 'customer_shipping'];

/** Cents, and never −0. */
const mtCents = (n) => Math.round(n * 100) / 100 || 0;
/** A finite number, or null (null / '' / NaN are "not reported", never zero). */
const mtNum = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
/** NZ calendar day (YYYY-MM-DD) of a timestamp. NEVER `iso.slice(0,10)` — that is the UTC day. */
const mtNzDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date(ts));
const mtIn = (day, r) => !!day && day >= r.from && day <= r.to;
/** Ex-GST cost of an expense row (the backend's own rule: GST comes off only when claimable). */
const mtCost = (row) => (row.gst_claimable ? Number(row.amount) * (1 - GST_SHARE) : Number(row.amount));
/** Gross profit of one invoice: ex-GST total (shipping charged included) − its cost. */
const mtInvGross = (inv) => inv.total_incl_gst * EX_GST - inv.cost_excl_gst;
const mtFmt = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);

/** The backend's comparison window: same number of NZ days, ending the day before `from`. */
export function previousRange(r) {
  if (!r || !r.from || !r.to) return null;
  const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const n = (day(r.to) - day(r.from)) / 864e5 + 1;
  const to = day(r.from) - 864e5;
  return { from: iso(to - (n - 1) * 864e5), to: iso(to) };
}

const refuse = (reason) => ({ applied: false, reason });

// ── §1 invoice dating ──────────────────────────────────────────────────────────────────
function redateInvoices(k, range, invoices, shadows) {
  if (!invoices) return refuse('the invoice list did not load');
  if (!shadows) return refuse('the invoice sales records did not load');
  if (invoices.rows.length < invoices.total) return refuse(`only ${invoices.rows.length} of ${invoices.total} invoices were read`);
  if (shadows.rows.length < shadows.total) return refuse(`only ${shadows.rows.length} of ${shadows.total} invoice sales records were read`);
  if (k.includes_invoices !== true || mtNum(k.invoice_revenue) == null || mtNum(k.invoice_orders) == null) {
    return refuse('the backend did not report its invoice figures');
  }
  const byId = new Map(invoices.rows.map((i) => [i.id, i]));
  const live = shadows.rows.filter((s) => s.status !== 'cancelled');
  for (const s of live) {
    const inv = byId.get(s.invoice_id);
    if (!inv || s.order_number !== `INV-${inv.invoice_number}`) {
      return refuse(`sales record ${s.order_number} does not match its invoice`);
    }
  }
  const shadowed = new Set(live.map((s) => s.invoice_id));
  // K: what the backend counted (its sales records dated in range). Must reconcile EXACTLY,
  // by total AND count — an amount match alone is not proof (15 different invoice sets add
  // up to one of the backend's figures).
  const kset = live.filter((s) => mtIn(mtNzDay(s.created_at), range));
  const kTotal = kset.reduce((a, s) => a + Number(s.total), 0);
  if (Math.abs(kTotal - k.invoice_revenue) > 0.005 || kset.length !== k.invoice_orders) {
    return refuse(`the backend's invoice figures do not reconcile (${mtCents(kTotal).toFixed(2)} from ${kset.length} records vs ${k.invoice_revenue} from ${k.invoice_orders})`);
  }
  // I: what should count — invoices issued in range that have a sales record. An invoice with
  // no sales record is left out (probably paperwork for a web order) and named in a warning.
  const issued = invoices.rows.filter((i) => i.status !== 'void' && mtIn(i.issue_date, range));
  const iset = issued.filter((i) => shadowed.has(i.id));
  const unrecorded = issued.filter((i) => !shadowed.has(i.id)).map((i) => `INV-${i.invoice_number}`);
  for (const inv of [...kset.map((s) => byId.get(s.invoice_id)), ...iset]) {
    if (mtNum(inv.total_incl_gst) == null || mtNum(inv.cost_excl_gst) == null) {
      return refuse(`INV-${inv.invoice_number} has no total or cost`);
    }
  }
  const kIds = new Set(kset.map((s) => s.invoice_id));
  const iIds = new Set(iset.map((i) => i.id));
  return {
    applied: true,
    revenueIncl: mtCents(iset.reduce((a, i) => a + i.total_incl_gst, 0) - kTotal),
    gross: mtCents(iset.reduce((a, i) => a + mtInvGross(i), 0) - kset.reduce((a, s) => a + mtInvGross(byId.get(s.invoice_id)), 0)),
    orders: iset.length - kset.length,
    movedOut: kset.filter((s) => !iIds.has(s.invoice_id)).map((s) => {
      const i = byId.get(s.invoice_id);
      return `INV-${i.invoice_number} (issued ${i.issue_date})`;
    }),
    movedIn: iset.filter((i) => !kIds.has(i.id)).map((i) => `INV-${i.invoice_number} (issued ${i.issue_date})`),
    unrecorded,
  };
}

// ── §3 refunds ─────────────────────────────────────────────────────────────────────────
function refundsIn(k, range, refunds) {
  if (mtNum(k.refunds) != null) return { applied: false, reason: 'the backend already takes refunds off', backendHasIt: true };
  if (!refunds) return refuse('the refunds list did not load');
  if (refunds.rows.length < refunds.total) return refuse(`only ${refunds.rows.length} of ${refunds.total} refunds were read`);
  const rows = refunds.rows.filter((r) => r.status === 'processed' && mtIn(mtNzDay(r.refunded_at || r.created_at), range));
  if (rows.some((r) => mtNum(r.amount) == null)) return refuse('a refund in range has no amount');
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);
  return {
    applied: true,
    count: rows.length,
    revenueIncl: mtCents(-total),
    gross: mtCents(-total * EX_GST),
    orders: rows.map((r) => r.order_number),
  };
}

// ── §4 + §5 operating expenses by bill date ────────────────────────────────────────────
function opexByBillDate(k, range, expenses) {
  if (mtNum(k.operating_expenses) == null) return refuse('the backend did not report operating expenses');
  if (!expenses) return refuse('the expense list did not load');
  if (expenses.legacy) return refuse('the expense list came from the old endpoint');
  if (expenses.rows.length < expenses.total) return refuse(`only ${expenses.rows.length} of ${expenses.total} expenses were read`);
  if (expenses.rows.some((r) => r.recurrence && r.recurrence !== 'none')) {
    return refuse('recurring bills are not supported on this screen yet');
  }
  const live = expenses.rows.filter((r) => !r.deleted_at && r.derived_status !== 'cancelled' && r.derived_status !== 'skipped');
  // Cross-check: our rows must reproduce the backend's own (paid-date) figure first. If they
  // don't, the backend changed its rule (or a row is missing) and we refuse rather than guess.
  const paidBasis = live
    .filter((r) => !ORDER_LINKED_RAW.includes(r.category) && mtIn(r.paid_date, range))
    .reduce((a, r) => a + mtCost(r), 0);
  if (Math.abs(mtCents(paidBasis) - k.operating_expenses) > 0.01) {
    return refuse(`the expense rows do not reproduce the backend's figure (${mtCents(paidBasis).toFixed(2)} vs ${k.operating_expenses})`);
  }
  const billDay = (r) => r.expense_date || r.date;
  const inRange = live.filter((r) => mtIn(billDay(r), range));
  if (inRange.some((r) => mtNum(r.amount) == null)) return refuse('an expense in range has no amount');
  const counted = inRange.filter((r) => r.kind === 'operating');
  const gstRows = inRange.filter((r) => r.kind === 'not_expense');
  const billDate = mtCents(counted.reduce((a, r) => a + mtCost(r), 0));
  return {
    applied: true,
    opex: billDate,
    net: mtCents(k.operating_expenses - billDate),
    gstExcluded: mtCents(gstRows.reduce((a, r) => a + mtCost(r), 0)),
    unpaidCounted: mtCents(counted.filter((r) => r.derived_status !== 'paid').reduce((a, r) => a + mtCost(r), 0)),
  };
}

// ── figures for one window ─────────────────────────────────────────────────────────────
function windowFigures(k, range, src) {
  if (!k) return null;
  const r1 = redateInvoices(k, range, src.invoices, src.shadows);
  const r3 = refundsIn(k, range, src.refunds);
  const r4 = opexByBillDate(k, range, src.expenses);
  const d = (t, f) => (t.applied ? (t[f] ?? 0) : 0);

  const rev = mtNum(k.revenue);
  const revIncl = rev == null ? null : mtCents(rev + d(r1, 'revenueIncl') + d(r3, 'revenueIncl'));
  const revEx = revIncl == null ? null : mtCents(revIncl * EX_GST);
  const gross = mtNum(k.gross_profit) == null ? null : mtCents(k.gross_profit + d(r1, 'gross') + d(r3, 'gross'));
  const net = mtNum(k.net_profit) == null ? null : mtCents(k.net_profit + d(r1, 'gross') + d(r3, 'gross') + d(r4, 'net'));
  const orders = mtNum(k.orders) == null ? null : k.orders + d(r1, 'orders');
  return { k, range, r1, r3, r4, revIncl, revEx, gross, net, orders };
}

const sameAdjustments = (a, b) => !!a && !!b
  && a.r1.applied === b.r1.applied && a.r3.applied === b.r3.applied && a.r4.applied === b.r4.applied;

// ── possible duplicate expenses (flag only; never removed) ─────────────────────────────
// ponytail: O(n²) pair scan and plain payee matching — fine for hundreds of rows. Add a
// dismissed-pairs list in admin_ui_prefs when the owner confirms a pair is genuine.
export function possibleDuplicateExpenses(rows, range, days = 5) {
  const key = (r) => String(r.payee || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
  const live = (rows || []).filter((r) => !r.deleted_at && (r.expense_date || r.date) && mtNum(r.amount) != null);
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const da = a.expense_date || a.date, db = b.expense_date || b.date;
      if (!key(a) || key(a) !== key(b)) continue;
      if (range && !mtIn(da, range) && !mtIn(db, range)) continue;
      if (Math.abs(dayNo(da) - dayNo(db)) > days) continue;
      const big = Math.max(Number(a.amount), Number(b.amount));
      if (Math.abs(Number(a.amount) - Number(b.amount)) > Math.max(1, 0.01 * big)) continue;
      pairs.push({ a, b, label: `${a.payee || a.name}: ${mtFmt(Number(a.amount))} on ${da} and ${mtFmt(Number(b.amount))} on ${db}` });
    }
  }
  return pairs;
}

// ── the figure builders ────────────────────────────────────────────────────────────────
const fig = (value, basis, inputs, extra = {}) => ({
  value, basis, inputs,
  adjusted: inputs.some((i) => i.source === ADJUSTED && i.amount !== 0),
  ...extra,
});

function revenueInclFigure(w) {
  if (w.revIncl == null) return fig(null, 'incl. GST', [], { note: 'The backend did not report revenue.' });
  const inputs = [{ label: 'Sales the backend counted (every status except cancelled)', amount: mtCents(w.k.revenue), source: BACKEND }];
  if (w.r1.applied && w.r1.revenueIncl !== 0) {
    inputs.push({ label: `Invoices counted on their issue date${w.r1.movedOut.length ? ` — moved out: ${w.r1.movedOut.join(', ')}` : ''}${w.r1.movedIn.length ? ` — moved in: ${w.r1.movedIn.join(', ')}` : ''}`, amount: w.r1.revenueIncl, source: ADJUSTED });
  }
  if (w.r3.applied && w.r3.revenueIncl !== 0) {
    inputs.push({ label: `Refunds processed in this period (${w.r3.count}: ${w.r3.orders.join(', ')})`, amount: w.r3.revenueIncl, source: ADJUSTED });
  }
  return fig(w.revIncl, 'incl. GST', inputs, { replaces: 'kpi-summary revenue' });
}

function revenueExFigure(w) {
  if (w.revEx == null) return fig(null, 'excl. GST', [], { note: 'The backend did not report revenue.' });
  const inputs = [
    { label: 'Revenue incl. GST (shipping charged included, refunds taken off)', amount: w.revIncl, source: w.r1.applied || w.r3.applied ? ADJUSTED : BACKEND },
    { label: 'GST (3/23 of it)', amount: mtCents(w.revEx - w.revIncl), source: 'calculated' },
  ];
  return fig(w.revEx, 'excl. GST', inputs, { replaces: 'kpi-summary revenue ÷ 1.15' });
}

function grossFigure(w) {
  if (w.gross == null) {
    return fig(null, 'excl. GST', [], { note: 'The backend did not return gross profit for this range (it drops it when a sale has no cost recorded). See "Sales missing a cost" in the to-do list.' });
  }
  const inputs = [{ label: 'Gross profit the backend counted (revenue ex GST − cost of goods)', amount: mtCents(w.k.gross_profit), source: BACKEND }];
  if (w.r1.applied && w.r1.gross !== 0) inputs.push({ label: 'Invoice profit counted on issue date (revenue ex GST − our cost)', amount: w.r1.gross, source: ADJUSTED });
  if (w.r3.applied && w.r3.gross !== 0) inputs.push({ label: 'Refunds, ex GST (goods are not restocked, so the whole refund comes off)', amount: w.r3.gross, source: ADJUSTED });
  return fig(w.gross, 'excl. GST', inputs, { replaces: 'kpi-summary gross_profit' });
}

function netFigure(w) {
  if (w.net == null || w.gross == null) {
    return fig(null, 'excl. GST', [], { note: 'Net profit needs gross profit, which the backend did not return for this range.' });
  }
  const stripe = mtNum(w.k.stripe_fees), freight = mtNum(w.k.supplier_freight);
  const opex = w.r4.applied ? w.r4.opex : mtNum(w.k.operating_expenses);
  if (stripe == null || freight == null || opex == null) {
    // Identity terms missing: show the figure as backend net + deltas.
    const inputs = [{ label: 'Net profit the backend counted', amount: mtCents(w.k.net_profit), source: BACKEND }];
    for (const [t, f, label] of [[w.r1, 'gross', 'Invoice profit counted on issue date'], [w.r3, 'gross', 'Refunds, ex GST'], [w.r4, 'net', 'Operating expenses by bill date']]) {
      if (t.applied && t[f] !== 0) inputs.push({ label, amount: t[f], source: ADJUSTED });
    }
    return fig(w.net, 'excl. GST', inputs, { replaces: 'kpi-summary net_profit' });
  }
  const opexLabel = w.r4.applied
    ? `Operating expenses by bill date, paid or not${w.r4.unpaidCounted ? ` (incl. ${mtFmt(w.r4.unpaidCounted)} not paid yet)` : ''}${w.r4.gstExcluded ? `; ${mtFmt(w.r4.gstExcluded)} of GST payments to IRD left out` : ''}`
    : `Operating expenses the backend counted (paid only) — bill-date basis unavailable: ${w.r4.reason}`;
  const inputs = [
    { label: 'Gross profit (box above)', amount: w.gross, source: w.r1.applied || w.r3.applied ? ADJUSTED : BACKEND },
    { label: 'Stripe card fees (ex GST)', amount: mtCents(-stripe), source: BACKEND },
    { label: 'Supplier freight we pay (Dynamic every order; Augmento under $100 ex GST of goods)', amount: mtCents(-freight), source: BACKEND },
    { label: opexLabel, amount: mtCents(-opex), source: w.r4.applied ? ADJUSTED : BACKEND },
  ];
  // The backend's own identity is occasionally a cent out; show that, never hide it.
  const rounding = mtCents(w.net - inputs.reduce((a, i) => a + i.amount, 0));
  if (rounding !== 0) inputs.push({ label: 'Rounding in the backend’s own figures', amount: rounding, source: BACKEND });
  return fig(w.net, 'excl. GST', inputs, { replaces: 'kpi-summary net_profit' });
}

const ratio = (profitFig, revFig, label) => {
  const v = profitFig.value != null && revFig.value != null && Math.abs(revFig.value) >= 0.005
    ? (profitFig.value / revFig.value) * 100 : null;
  return { value: v, basis: 'excl. GST base', of: [label, 'Revenue (ex GST)'], adjusted: profitFig.adjusted || revFig.adjusted, inputs: [] };
};

/**
 * Build every money box for a range.
 *
 * src = {
 *   range: {from,to} (NZ days, the SAME bounds sent to kpi-summary),
 *   compare: boolean (false for All time),
 *   kpi: normalizeKpiSummary() result {current, previous} | null,
 *   refunds:  {rows,total} | null    (GET /api/admin/refunds — all of them),
 *   expenses: {rows,total,legacy} | null  (rows carry `kind` from the category registry),
 *   invoices: {rows,total} | null,
 *   shadows:  {rows,total} | null    (GET /api/admin/orders?search=INV-),
 * }
 */
export function moneyTruth(src) {
  const { range, compare } = src;
  const prevRange = compare ? previousRange(range) : null;
  const cur = windowFigures(src.kpi?.current, range, src);
  const prev = prevRange ? windowFigures(src.kpi?.previous, prevRange, src) : null;
  const comparable = sameAdjustments(cur, prev);

  const build = (w) => {
    if (!w) return null;
    const revenueInclGst = revenueInclFigure(w);
    const revenueExGst = revenueExFigure(w);
    const grossProfit = grossFigure(w);
    const netProfit = netFigure(w);
    const orders = fig(w.orders, null, w.orders == null ? [] : [
      { label: 'Orders the backend counted', amount: w.k.orders, source: BACKEND },
      ...(w.r1.applied && w.r1.orders ? [{ label: 'Invoices counted on their issue date', amount: w.r1.orders, source: ADJUSTED }] : []),
    ], { note: 'A refunded order still counts as an order.' });
    const aov = {
      value: w.orders && w.revEx != null ? mtCents(w.revEx / w.orders) : null, basis: 'excl. GST',
      of: ['Revenue (ex GST)', 'Orders'], adjusted: revenueExGst.adjusted || orders.adjusted, inputs: [],
    };
    return {
      revenueInclGst, revenueExGst, grossProfit, netProfit, orders, aov,
      grossMargin: ratio(grossProfit, revenueExGst, 'Gross profit'),
      netMargin: ratio(netProfit, revenueExGst, 'Net profit'),
    };
  };
  const figures = build(cur);
  const prevFigures = build(prev);
  if (figures && prevFigures) {
    for (const key of Object.keys(figures)) {
      figures[key].prev = prevFigures[key].value;
      // Orders do not move with refunds/opex, so they stay comparable when only those differ.
      figures[key].prevComparable = key === 'orders'
        ? cur.r1.applied === prev.r1.applied
        : comparable;
    }
  }

  const adjustments = cur ? [
    { id: 'invoice-dates', ask: '§1', ...pick(cur.r1), prev: prev && pick(prev.r1) },
    { id: 'refunds', ask: '§3', ...pick(cur.r3), prev: prev && pick(prev.r3) },
    { id: 'expenses-by-bill-date', ask: '§4 §5', ...pick(cur.r4), prev: prev && pick(prev.r4) },
  ] : [];

  const warnings = [];
  if (!src.kpi?.current) warnings.push('The backend summary (kpi-summary) did not load, so no money figure can be shown.');
  for (const a of adjustments) if (!a.applied && !a.backendHasIt) warnings.push(`Not adjusted (${a.id}): ${a.reason}. Showing the backend’s figure for that part.`);
  if (cur?.r1.applied && cur.r1.unrecorded.length) {
    warnings.push(`${cur.r1.unrecorded.join(', ')} issued in this period ha${cur.r1.unrecorded.length === 1 ? 's' : 've'} no sales record, so ${cur.r1.unrecorded.length === 1 ? 'it is' : 'they are'} not counted.`);
  }

  return {
    asOf: src.asOf || null, range, previousRange: prevRange,
    figures, adjustments, warnings,
    owedToUs: owedToUs(src.invoices),
  };
}

function pick(t) {
  const { applied, reason, backendHasIt } = t;
  return { applied, reason: reason || null, backendHasIt: !!backendHasIt };
}

/** Unpaid invoices, any date — the same rule as the Invoices page's Outstanding box. */
export function owedToUs(invoices) {
  if (!invoices) return { value: null, inputs: [], note: 'The invoice list did not load.' };
  if (invoices.rows.length < invoices.total) return { value: null, inputs: [], note: `Only ${invoices.rows.length} of ${invoices.total} invoices were read.` };
  const open = invoices.rows.filter((i) => i && i.status !== 'paid' && i.status !== 'void');
  if (open.some((i) => mtNum(i.total_incl_gst) == null)) return { value: null, inputs: [], note: 'An unpaid invoice has no total.' };
  return {
    value: mtCents(open.reduce((a, i) => a + Number(i.total_incl_gst), 0)),
    basis: 'incl. GST',
    inputs: open.map((i) => ({ label: `INV-${i.invoice_number} · issued ${i.issue_date} · ${i.status}`, amount: Number(i.total_incl_gst), source: BACKEND })),
    note: 'What customers still owe on invoices, whatever the date. Not limited to the selected period.',
  };
}

/**
 * To-do items that come from the same lists (no extra requests).
 * Each item: { label, href }.
 */
export function moneyTodos({ range, expenses, refunds, invoices }) {
  const out = { duplicates: null, pendingRefunds: null, taxAsExpense: null, invoiceCostOverPrice: null };
  if (expenses) {
    out.duplicates = possibleDuplicateExpenses(expenses.rows, range).map((p) => ({ label: p.label, href: 'expenses' }));
    out.taxAsExpense = expenses.rows
      .filter((r) => !r.deleted_at && r.kind === 'operating' && mtIn(r.expense_date || r.date, range)
        && /\bG\.?S\.?T\b|\bIRD\b/i.test(`${r.name || ''} ${r.payee || ''}`))
      .map((r) => ({ label: `${r.name || r.payee}: ${mtFmt(Number(r.amount))} on ${r.expense_date || r.date} — move to "GST payment to IRD"`, href: 'expenses' }));
  }
  if (refunds) {
    out.pendingRefunds = refunds.rows
      .filter((r) => r.status === 'pending')
      .map((r) => ({ label: `${r.order_number}: ${mtFmt(Number(r.amount))} pending since ${mtNzDay(r.created_at)}`, href: `orders?focus=${encodeURIComponent(r.order_number)}` }));
  }
  if (invoices) {
    out.invoiceCostOverPrice = invoices.rows
      .filter((i) => i.status !== 'void' && mtNum(i.cost_excl_gst) != null && mtNum(i.total_incl_gst) != null
        && i.cost_excl_gst > i.total_incl_gst * EX_GST)
      .map((i) => ({ label: `INV-${i.invoice_number}: cost ${mtFmt(i.cost_excl_gst)} vs price ${mtFmt(mtCents(i.total_incl_gst * EX_GST))} ex GST`, href: 'invoices' }));
  }
  return out;
}
