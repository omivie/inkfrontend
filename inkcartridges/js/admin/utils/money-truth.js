/**
 * money-truth.js — the Dashboard's money figures, straight from the backend (2026-11-26)
 * ====================================================================================
 *
 * Source: GET /api/admin/analytics/dashboard-summary (backend reply 2026-11-25, §6), via
 * AdminAPI.getDashboardSummary → normalizeDashboardSummary. The backend now computes money on
 * the owner's definitions, so this module NO LONGER ADJUSTS ANYTHING:
 *   - an invoice counts on its ISSUE DATE, paid or not (its shadow order is dated there, §1);
 *   - PROCESSED refunds and chargebacks come off revenue and profit on `refunded_at` (§3);
 *   - operating expenses count on their `expense_date`, paid or not (§4);
 *   - a `gst_payment` row ("GST / tax payment to IRD") is not an expense (§5);
 *   - kpi-summary, /pnl, the dashboard bundle and dashboard-summary share ONE definition (§2).
 * The three FE adjustments that bridged those gaps (redateInvoices, refundsIn, opexByBillDate)
 * were deleted when the backend shipped them — never re-add one: two layers subtracting the same
 * refund is exactly the bug they would cause now.
 *
 * What this module still does:
 *   - dashboardMoney: shapes the backend figures into tiles, and lays each money figure out as
 *     its inputs for the "How it's calculated" drawer. The inputs add up EXACTLY to the value:
 *     a cent of rounding inside the backend's own figures is shown as a row, and anything bigger
 *     is labelled UNEXPLAINED — never hidden.
 *   - unpaidBillsInRange: the Net Profit tile's second line ("includes $X of bills not paid
 *     yet"). Net profit already includes those bills, so nothing is subtracted twice (ERR-392
 *     superseded). It first proves the expense rows reproduce the backend's operating expenses.
 *   - moneyTodos: to-do items read from lists the page already has (no extra requests).
 *
 * Fail-soft must be LOUD: a figure the backend did not report is null and says why; profit with
 * an un-costed sale in range is "AT MOST" and names the sale; never a missing input read as 0.
 * The FE computes no prices. Ratios (margins) are the only arithmetic of its own.
 *
 * Import-free on purpose (pure, vm-testable): tests/dashboard-money-nov2026.test.js.
 */

const GST_SHARE = 3 / 23;               // GST share of a GST-inclusive amount (NZ 15%)
const EX_GST = 20 / 23;
// Categories the backend leaves out of operating expenses: order-linked costs (already inside
// cost of goods / fees / freight) and GST payments to IRD. Matches /api/admin/expense-categories
// kinds order_linked + tax_payment (measured 2026-11-26).
const BACKEND_EXCLUDED_RAW = ['inventory', 'merchant_fees', 'customer_shipping', 'gst_payment'];
const BACKEND = 'backend';
const CALC = 'calculated';

/** Cents, and never −0. A non-finite input stays NaN so a guard can see it — never a 0. */
const mtCents = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 || 0 : NaN);
/** A finite number, or null (null / '' / NaN are "not reported", never zero). */
const mtNum = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
/** NZ calendar day (YYYY-MM-DD) of a timestamp. NEVER `iso.slice(0,10)` — that is the UTC day. */
const mtNzDay = (ts) => {
  const d = ts ? new Date(ts) : null;
  return d && Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(d) : null;
};
const mtIn = (day, r) => !!day && !!r && day >= r.from && day <= r.to;
/** Ex-GST cost of an expense row (the backend's own rule: GST comes off only when claimable). */
const mtCost = (row) => (row.gst_claimable ? Number(row.amount) * (1 - GST_SHARE) : Number(row.amount));
const mtFmt = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
const billDay = (r) => r.expense_date || r.date || null;
const isOperatingRaw = (r) => !BACKEND_EXCLUDED_RAW.includes(r.category);
const liveExpense = (r) => !r.deleted_at && r.derived_status !== 'cancelled' && r.derived_status !== 'skipped';

// ── the How-it's-calculated inputs ─────────────────────────────────────────────────────
/**
 * Close a list of inputs against the value the backend reported. Up to 2¢ is rounding in the
 * backend's own figures (shown); more than that is UNEXPLAINED (shown, and flagged on the figure).
 */
function closeInputs(value, inputs) {
  const sum = inputs.reduce((a, i) => a + i.amount, 0);
  const gap = mtCents(value - sum);
  if (!Number.isFinite(gap) || gap === 0) return { inputs, unexplained: 0 };
  const row = Math.abs(gap) <= 0.02
    ? { label: 'Rounding in the backend’s own figures', amount: gap, source: BACKEND }
    : { label: 'UNEXPLAINED difference inside the backend’s own figures', amount: gap, source: BACKEND };
  return { inputs: [...inputs, row], unexplained: Math.abs(gap) > 0.02 ? gap : 0 };
}

const fig = (value, basis, inputs, extra = {}) => ({ value, basis, inputs, note: null, atMost: false, unexplained: 0, ...extra });
const missing = (basis, note) => fig(null, basis, [], { note });

function costUnknownLabel(list) {
  return list.map((o) => {
    const num = o.order_number || o.order_id || 'a sale';
    const skus = Array.isArray(o.skus) && o.skus.length ? ` (${o.skus.join(', ')})` : '';
    return `${num}${skus}`;
  }).join(', ');
}

function windowFigures(w, flags) {
  if (!w) return null;
  const rev = w.revenue_incl_gst, refunds = w.refunds, revEx = w.revenue_ex_gst;
  const cogs = w.cogs, gross = w.gross_profit, net = w.net_profit;
  const stripe = w.stripe_fees, freight = w.supplier_freight, opex = w.operating_expenses;
  const out = {};

  // Revenue incl. GST — after refunds.
  if (rev == null) {
    out.revenueInclGst = missing('incl. GST', 'The backend did not report revenue for this range.');
  } else if (refunds == null) {
    out.revenueInclGst = fig(rev, 'incl. GST', [{ label: 'Revenue after refunds (the backend did not say how much was refunded)', amount: rev, source: BACKEND }]);
  } else {
    const c = closeInputs(rev, [
      { label: 'Sales: web orders + invoices on their issue date, paid or not', amount: mtCents(rev + refunds), source: BACKEND },
      { label: 'Refunds and chargebacks processed in this period (on the refund date)', amount: mtCents(-refunds), source: BACKEND },
    ]);
    out.revenueInclGst = fig(rev, 'incl. GST', c.inputs, { unexplained: c.unexplained, refunds });
  }

  // Revenue ex GST.
  if (revEx == null || rev == null) {
    out.revenueExGst = missing('excl. GST', 'The backend did not report revenue for this range.');
  } else {
    out.revenueExGst = fig(revEx, 'excl. GST', [
      { label: 'Revenue after refunds (incl. GST)', amount: rev, source: BACKEND },
      { label: 'GST in it (3/23 of the incl-GST total)', amount: mtCents(revEx - rev), source: CALC },
    ]);
  }

  // Cost of goods. A non-empty list ⇒ some sale in range has no cost recorded.
  const unknown = Array.isArray(w.cogs_unknown_orders) ? w.cogs_unknown_orders : null;
  const costNote = unknown && unknown.length
    ? `AT MOST this figure: ${unknown.length} sale${unknown.length === 1 ? ' has' : 's have'} no cost of goods recorded (${costUnknownLabel(unknown)}), so the cost is incomplete and profit is overstated. Add the cost to fix it.`
    : null;
  const costListMissing = unknown == null
    ? 'The backend did not say whether every sale has a cost, so this figure may be overstated.'
    : null;

  // Gross profit.
  if (gross == null) {
    out.grossProfit = missing('excl. GST', 'The backend did not report gross profit for this range.');
  } else if (revEx == null || cogs == null) {
    out.grossProfit = fig(gross, 'excl. GST', [{ label: 'Gross profit the backend reported', amount: gross, source: BACKEND }],
      { note: 'The backend did not send revenue or cost of goods, so the steps cannot be shown.', atMost: !!costNote });
  } else {
    const c = closeInputs(gross, [
      { label: 'Revenue after refunds (excl. GST)', amount: revEx, source: BACKEND },
      { label: 'Cost of goods (excl. GST; refunded goods are not restocked)', amount: mtCents(-cogs), source: BACKEND },
    ]);
    out.grossProfit = fig(gross, 'excl. GST', c.inputs, { unexplained: c.unexplained, atMost: !!costNote, note: costNote || costListMissing });
  }

  // Net profit.
  const freightNote = flags.supplierFreightFailed === true
    ? 'AT MOST this figure: supplier freight could not be worked out for this range, so it is missing from the costs.'
    : flags.supplierFreightFailed == null
      ? 'The backend did not say whether supplier freight loaded, so this figure may be overstated.'
      : null;
  if (net == null) {
    out.netProfit = missing('excl. GST', 'The backend did not report net profit for this range.');
  } else if (gross == null || stripe == null || freight == null || opex == null) {
    out.netProfit = fig(net, 'excl. GST', [{ label: 'Net profit the backend reported', amount: net, source: BACKEND }],
      { note: 'The backend did not send every cost, so the steps cannot be shown.', atMost: !!costNote || flags.supplierFreightFailed === true });
  } else {
    const c = closeInputs(net, [
      { label: 'Gross profit (box above)', amount: gross, source: BACKEND },
      { label: 'Stripe card fees (excl. GST)', amount: mtCents(-stripe), source: BACKEND },
      { label: 'Supplier freight we pay (Dynamic every order; Augmento under $100 ex GST of goods)', amount: mtCents(-freight), source: BACKEND },
      { label: 'Operating expenses by bill date, paid or not (excl. GST; GST payments to IRD are not an expense)', amount: mtCents(-opex), source: BACKEND },
    ]);
    const notes = [costNote || costListMissing, freightNote].filter(Boolean).join(' ');
    out.netProfit = fig(net, 'excl. GST', c.inputs, {
      unexplained: c.unexplained, atMost: !!costNote || flags.supplierFreightFailed === true, note: notes || null,
    });
  }

  // Ratios — the only arithmetic of our own. Both ex GST.
  const ratio = (p) => (p.value != null && revEx != null && Math.abs(revEx) >= 0.005 ? (p.value / revEx) * 100 : null);
  out.grossMargin = { value: ratio(out.grossProfit), basis: 'excl. GST base', of: ['Gross profit', 'Revenue (excl. GST)'], inputs: [], atMost: out.grossProfit.atMost };
  out.netMargin = { value: ratio(out.netProfit), basis: 'excl. GST base', of: ['Net profit', 'Revenue (excl. GST)'], inputs: [], atMost: out.netProfit.atMost };

  out.orders = fig(w.orders, null, [], {
    note: 'Web orders and invoices (on their issue date). A refunded order still counts; cancelled and test orders do not.',
  });
  out.aov = fig(w.aov, 'incl. GST', [], { note: 'Revenue after refunds ÷ orders, both incl. GST (the backend’s figure).' });
  out.owed = fig(w.owed_unpaid_invoices, 'incl. GST', [], {
    note: 'What customers still owe on unpaid invoices issued on or before the end of this period.',
  });
  out.costUnknown = unknown;
  return out;
}

/**
 * Every money figure for one dashboard-summary payload (normalizeDashboardSummary result).
 * Returns { figures, warnings } — figures null (and a warning) when the payload did not load.
 * Each figure: { value, prev, basis, inputs[], note, atMost, unexplained }.
 */
export function dashboardMoney(dsum) {
  if (!dsum || !dsum.current) {
    return { figures: null, warnings: ['The dashboard summary did not load, so no money figure can be shown. This is not a zero — reload to retry.'] };
  }
  const flags = { supplierFreightFailed: dsum.supplier_freight_failed };
  const figures = windowFigures(dsum.current, flags);
  const prev = windowFigures(dsum.previous, flags);
  for (const key of Object.keys(figures)) {
    if (key === 'costUnknown') continue;
    figures[key].prev = prev && prev[key] ? prev[key].value : null;
  }
  const warnings = [];
  if (figures.costUnknown && figures.costUnknown.length) {
    warnings.push(`Profit is AT MOST the figure shown: ${costUnknownLabel(figures.costUnknown)} ha${figures.costUnknown.length === 1 ? 's' : 've'} no cost of goods recorded.`);
  }
  if (dsum.supplier_freight_failed === true) warnings.push('Supplier freight could not be worked out for this range, so net profit is AT MOST the figure shown.');
  for (const [k, label] of [['revenueInclGst', 'Revenue'], ['grossProfit', 'Gross profit'], ['netProfit', 'Net profit']]) {
    if (figures[k].unexplained) warnings.push(`${label}: the backend’s own figures differ by ${mtFmt(figures[k].unexplained)} that is not rounding. Treat it with care.`);
  }
  return { figures, warnings };
}

// ── Net Profit second line: bills not paid yet ──────────────────────────────────────────
/**
 * Unpaid operating bills dated in range, at the cost net profit uses (ex GST when claimable).
 * Net profit ALREADY includes them (accrual, §4) — this only says how much of it is unpaid.
 *
 * Proof first: the live operating rows dated in range must reproduce the backend's
 * `operating_expenses` to the cent (±1¢). If they don't, a row is missing or the rule moved,
 * and the line says it could not confirm rather than print a guess.
 *
 * rows: raw GET /api/admin/expenses items (backend `category`, not the FE display override).
 * Returns { value, count } or { value: null, reason }.
 */
export function unpaidBillsInRange(rows, range, backendOpex) {
  if (!Array.isArray(rows)) return { value: null, reason: 'the expense list did not load' };
  if (!range || !range.from || !range.to) return { value: null, reason: 'no date range (All time)' };
  const opex = mtNum(backendOpex);
  if (opex == null) return { value: null, reason: 'the backend did not report operating expenses' };
  const inRange = rows.filter((r) => liveExpense(r) && isOperatingRaw(r) && mtIn(billDay(r), range));
  if (inRange.some((r) => r.recurrence && r.recurrence !== 'none')) {
    return { value: null, reason: 'a recurring bill is in this period, and its occurrences are not on this list' };
  }
  if (inRange.some((r) => mtNum(r.amount) == null)) return { value: null, reason: 'a bill in this period has no amount' };
  const total = mtCents(inRange.reduce((a, r) => a + mtCost(r), 0));
  if (Math.abs(total - opex) > 0.01) {
    return { value: null, reason: `the bills on file add up to ${mtFmt(total)}, not the ${mtFmt(opex)} in net profit` };
  }
  const unpaid = inRange.filter((r) => r.derived_status !== 'paid');
  return { value: mtCents(unpaid.reduce((a, r) => a + mtCost(r), 0)), count: unpaid.length };
}

/** The Net Profit tile's second line. Never subtracts: net profit already includes these bills. */
export function unpaidBillsLine(res) {
  if (!res) return '';
  if (res.value == null) return `Unpaid bills: could not confirm (${res.reason})`;
  if (res.value === 0) return 'All bills in this period are paid';
  return `Includes ${mtFmt(res.value)} of bills not paid yet`;
}

// ── possible duplicate expenses (flag only; never removed) ─────────────────────────────
// ponytail: O(n²) pair scan and plain payee matching — fine for hundreds of rows. Add a
// dismissed-pairs list in admin_ui_prefs when the owner confirms a pair is genuine.
export function possibleDuplicateExpenses(rows, range, days = 5) {
  const key = (r) => String(r.payee || r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dayNo = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
  const live = (rows || []).filter((r) => !r.deleted_at && billDay(r) && mtNum(r.amount) != null);
  const pairs = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const da = billDay(a), db = billDay(b);
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

/**
 * Operating expenses in range whose name/payee looks like a tax payment (GST, IRD, Inland
 * Revenue). Filed under an operating category, such a row is subtracted from net profit — the
 * backend only leaves it out once it is in "GST / tax payment to IRD" (`gst_payment`).
 */
export function taxLikeExpenses(rows, range) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => liveExpense(r) && isOperatingRaw(r) && mtIn(billDay(r), range)
    && mtNum(r.amount) != null && /\bG\.?S\.?T\b|\bIRD\b|inland\s+revenue|tax\s+payment/i.test(`${r.name || ''} ${r.payee || ''}`));
}

/**
 * To-do items read from lists the page already has (no extra requests).
 * Inputs are row ARRAYS, or null when that list did not load (⇒ that item is null = "could
 * not load", never an empty "all clear"). Each item: { label, href }. `orderRef` formats an
 * order number for a link (the page passes OrderNumber.forDisplay).
 */
export function moneyTodos({ range, expenses, refunds, invoices, orderRef = (n) => n }) {
  const out = { duplicates: null, pendingRefunds: null, taxAsExpense: null, invoiceCostOverPrice: null };
  if (Array.isArray(expenses)) {
    out.duplicates = possibleDuplicateExpenses(expenses, range).map((p) => ({ label: p.label, href: 'expenses' }));
    out.taxAsExpense = taxLikeExpenses(expenses, range)
      .map((r) => ({ label: `${r.name || r.payee}: ${mtFmt(Number(r.amount))} on ${billDay(r)} — move to "GST / tax payment to IRD"`, href: 'expenses' }));
  }
  if (Array.isArray(refunds)) {
    out.pendingRefunds = refunds
      .filter((r) => r.status === 'pending')
      .map((r) => ({ label: `${r.order_number}: ${mtNum(r.amount) == null ? 'amount unknown' : mtFmt(Number(r.amount))} pending${r.created_at ? ` since ${mtNzDay(r.created_at)}` : ''}`, href: `orders?focus=${encodeURIComponent(orderRef(r.order_number))}` }));
  }
  if (Array.isArray(invoices)) {
    out.invoiceCostOverPrice = invoices
      .filter((i) => i.status !== 'void' && mtNum(i.cost_excl_gst) != null && mtNum(i.total_incl_gst) != null
        && Number(i.cost_excl_gst) > Number(i.total_incl_gst) * EX_GST)
      .map((i) => ({ label: `INV-${i.invoice_number}: cost ${mtFmt(Number(i.cost_excl_gst))} vs price ${mtFmt(mtCents(Number(i.total_incl_gst) * EX_GST))} ex GST`, href: 'invoices' }));
  }
  return out;
}

/**
 * "Sales missing a cost" to-do from dashboard-summary `actions.missing_cost`.
 * null = the list was unavailable (the card says "could not load — not a zero").
 */
export function missingCostItems(action, orderRef = (n) => n) {
  if (!action || action.count == null) return null;
  const items = (action.rows || []).map((o) => {
    const num = String(o.order_number || o.order_id || '');
    const skus = Array.isArray(o.skus) && o.skus.length ? ` — no cost on ${o.skus.join(', ')}` : ' — no cost recorded';
    return { label: `${num}${skus}`, href: /^INV-/i.test(num) ? 'invoices' : `orders?focus=${encodeURIComponent(orderRef(num))}` };
  });
  return { count: action.count, items, truncated: action.count > items.length };
}

/** Refund rate: processed refunds in range ÷ orders (a COUNT ratio, %). null when either is unknown. */
export function refundRatePct(refundSeries, orders) {
  const rows = refundSeries && Array.isArray(refundSeries.series) ? refundSeries.series : null;
  const n = mtNum(orders);
  if (!rows || n == null || n <= 0) return null;
  if (rows.some((r) => mtNum(r.refund_count) == null)) return null;
  return (rows.reduce((a, r) => a + Number(r.refund_count), 0) / n) * 100;
}
