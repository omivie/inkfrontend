/**
 * invoice-cash-basis.js — recognise an invoiced sale's REVENUE when the money
 * lands, while its COGS stays on the day the invoice was raised (ERR-197)
 * ===========================================================================
 *
 * ── What changed, and why it is not the overlay coming back ─────────────────
 *
 * The backend counts invoiced sales on an ACCRUAL basis: the sale is booked on
 * the invoice's order date whether or not the customer has paid. A client-side
 * `utils/invoice-overlay.js` used to ADD invoice revenue on top of the backend's
 * figures; it was deleted in Jul 2026 when the backend started counting invoices
 * itself, because an add would DOUBLE the revenue. That deletion is still right
 * and `tests/admin-cogs-honesty.test.js` still enforces it.
 *
 * This module does the opposite thing. It SUBTRACTS the invoices whose money has
 * not arrived. Adding is a double-count; subtracting is the owner's chosen basis:
 *
 *      revenue        cash    — only once the PAID slider is flipped
 *      gross/net profit cash  — same, revenue side only
 *      COGS           accrual — we are charged for the goods on day one
 *      orders         accrual — the order still happened
 *
 * The visible consequence is intended: an unpaid invoice shows up as real cost
 * with no revenue against it, so a book that is mostly unpaid reads as a LOSS.
 * That is what being owed money looks like. It is not a fault.
 *
 * ── THE JOIN: why `invoices.status` alone is not enough ─────────────────────
 *
 * Two facts, both MEASURED live on 2026-09-01 by `npm run probe:invoice-cash-basis`,
 * neither of them guessable from source:
 *
 * 1. **`source_order_id` is NOT on `/api/admin/invoices` list rows.** It is the
 *    field that would say whether an invoice is a standalone sale or paperwork
 *    for an order the backend already counted. Deducting the latter would delete
 *    a real order's revenue from the dashboard.
 *
 *    Instead: every invoice the backend counts materialises as a SHADOW ORDER
 *    numbered `INV-<invoice_number>` (`payment_method: 'invoice'`). That order is
 *    literally the thing the dashboard's revenue contains. An invoice raised
 *    against a real order gets no shadow order — that is the backend's OWN
 *    double-count guard — so it never joins here and is never deducted. The join
 *    is therefore strictly better than the missing field: it reflects what the
 *    backend actually counted rather than what we infer it counted.
 *
 * 2. **The booking date is the shadow order's `created_at`, NOT the invoice's
 *    `issue_date`.** They differed on 8 of 15 live invoices, by up to 8 days and
 *    across month boundaries. INV-3277 carries `issue_date` 2026-09-01 but was
 *    booked 2026-08-28, and the backend reports `invoice_revenue = 0` for the
 *    whole of September. Bucketing by `issue_date` puts money in the wrong month
 *    and leaves a phantom in the right one.
 *
 * ── The trap that would make this silently do nothing ───────────────────────
 *
 * A shadow order's OWN `status` is `'paid'`, with a `paid_at`, for every invoice
 * — including the nine the Invoices page shows as UNPAID. The order's paid flag
 * is decoupled from the customer's. Read `invoices.status`. Reading the order's
 * would make every deduction zero and the feature would look shipped while doing
 * nothing at all.
 *
 * See [[project_invoice_cash_basis_sep2026]], errors.md ERR-197.
 */

/**
 * An incl-GST figure becomes its ex-GST base by x20/23. NZ GST is 15%, and the
 * backend's `gross_profit = revenue_ex - cogs_ex` since migration 118 (ERR-111).
 * Never divide profit by incl-GST revenue: it understates every margin ~13%.
 */
export const EX_GST_FACTOR = 20 / 23;

const round2 = (n) => Math.round(n * 100) / 100;

/** Finite number, or null. Never coerces null/'' to 0 (ERR-068). */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An invoice's money, incl. GST. The backend is authoritative; do not derive it. */
function invoiceTotal(inv) {
  return numOrNull(inv?.total_incl_gst ?? inv?.total);
}

// ───────────────────────────────────────────────────────────────────────────
//  Predicates — ONE QUESTION EACH. Do not merge them.
// ───────────────────────────────────────────────────────────────────────────

/**
 * DO THEY STILL OWE US? — the debtors question, for the Invoices page's
 * outstanding box.
 *
 * Deliberately DIFFERENT from `isUnrealised` below: it does NOT care whether the
 * backend counted the invoice in analytics. An invoice raised against an
 * existing order is still money a customer owes us, even though deducting it
 * from the dashboard would be wrong. Confusing these two is the most likely bug
 * in this feature.
 */
export function isOutstanding(inv) {
  if (!inv) return false;
  const s = inv.status;
  return s !== 'paid' && s !== 'void';
}

/**
 * HAS THE MONEY LANDED? — the analytics question.
 *
 * Note `!== 'paid'` rather than `=== 'unpaid'`. `INVOICE_STATUSES` also contains
 * `'draft'` (0 rows live today, but the value is legal), and an equality test
 * would silently let a draft's revenue stay in the dashboard as if collected.
 * Void is excluded because a void sale never happened at all.
 */
export function isUnrealised(inv) {
  if (!inv) return false;
  return inv.status !== 'paid' && inv.status !== 'void';
}

// ───────────────────────────────────────────────────────────────────────────
//  The shadow-order join
// ───────────────────────────────────────────────────────────────────────────

/**
 * Index the `INV-<number>` shadow orders out of an `/api/admin/orders` payload.
 *
 * NB that route returns `data` as a BARE ARRAY (ERR-176) — callers must not
 * reach for `data.orders`, which is `[]` for every query.
 *
 * @returns {Map<string, object>} invoice_number (as a string) → order row
 */
export function indexShadowOrders(orders) {
  const out = new Map();
  for (const o of Array.isArray(orders) ? orders : []) {
    const m = /^INV-(\d+)$/.exec(String(o?.order_number ?? ''));
    if (m) out.set(m[1], o);
  }
  return out;
}

/**
 * Join invoices to the shadow orders that represent them in the backend's
 * numbers. An invoice with no shadow order was never counted, so it is dropped
 * — that is the double-count guard working, not a data error.
 *
 * A cancelled shadow order is the backend's representation of a VOID invoice and
 * carries no revenue, so it is dropped too.
 *
 * @returns {Array<{invoice, order, bookedOn: string, totalInclGst: number|null}>}
 *          `bookedOn` is a YYYY-MM-DD day key taken from the ORDER, never the
 *          invoice — see the header.
 */
export function joinToShadowOrders(invoices, shadows) {
  const out = [];
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    const order = shadows?.get?.(String(inv?.invoice_number));
    if (!order) continue;
    if (order.status === 'cancelled') continue;
    const bookedOn = String(order.created_at ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bookedOn)) continue;
    out.push({ invoice: inv, order, bookedOn, totalInclGst: invoiceTotal(inv) });
  }
  return out;
}

/** Rows booked within an inclusive YYYY-MM-DD day range. */
export function withinPeriod(joined, from, to) {
  return (joined || []).filter((j) => (!from || j.bookedOn >= from) && (!to || j.bookedOn <= to));
}

// ───────────────────────────────────────────────────────────────────────────
//  Reconciliation — the guard that replaces the missing field
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does our view of a period's invoiced sales match the backend's own published
 * figures for it?
 *
 * `kpi-summary` carries `invoice_revenue` and `invoice_orders`, which until now
 * were forwarded by `api.js` and read by nothing. They are exactly the check this
 * needs: if the sum of the invoices we joined equals what the backend says it
 * counted, we know precisely which money is in the total and may remove part of
 * it. If it does not, we do NOT know, and subtracting an amount the backend never
 * added would corrupt the dashboard.
 *
 * Verified exact to the cent live for Jun/Jul/Aug/Sep 2026.
 *
 * A missing `invoice_revenue` is UNKNOWN, not zero — it cannot reconcile, and
 * that is reported as its own reason rather than passing by default.
 *
 * @returns {{ok: boolean, reason: string|null, ours: number, theirs: number|null}}
 */
export function reconcilePeriod(joinedInPeriod, kpis) {
  const ours = round2((joinedInPeriod || []).reduce((s, j) => s + (j.totalInclGst ?? 0), 0));
  const count = (joinedInPeriod || []).length;
  const theirs = numOrNull(kpis?.invoice_revenue);
  const theirCount = numOrNull(kpis?.invoice_orders);

  if (kpis?.includes_invoices !== true) {
    return { ok: false, ours, theirs, reason: 'the backend did not report counting invoiced sales for this period' };
  }
  if (theirs === null) {
    return { ok: false, ours, theirs, reason: 'the backend did not report an invoice revenue figure to reconcile against' };
  }
  if (Math.abs(ours - theirs) > 0.01) {
    return {
      ok: false, ours, theirs,
      reason: `invoiced sales do not reconcile ($${ours.toFixed(2)} here vs $${theirs.toFixed(2)} reported)`,
    };
  }
  if (theirCount !== null && count !== theirCount) {
    return {
      ok: false, ours, theirs,
      reason: `invoice counts do not reconcile (${count} here vs ${theirCount} reported)`,
    };
  }
  return { ok: true, ours, theirs, reason: null };
}

// ───────────────────────────────────────────────────────────────────────────
//  The deduction
// ───────────────────────────────────────────────────────────────────────────

/**
 * How much revenue to remove, for the invoices whose money has not arrived.
 *
 * `revenueExGst` is `total x 20/23` and NOT `profit_excl_gst + cost_excl_gst`.
 * Those two differ on any invoice carrying freight — live, #3266 and #3273
 * differ by exactly $6.09 each, a $7.00-incl freight line the invoice's own
 * profit figure excludes but the shadow order's revenue includes. The
 * dashboard's profit is built from the ORDER, so the order's ex-GST revenue is
 * what has to come off.
 *
 * @returns {{revenueInclGst:number, revenueExGst:number, count:number, unknownTotal:number}}
 */
export function unrealisedDeduction(joinedInPeriod) {
  let incl = 0, count = 0, unknownTotal = 0;
  for (const j of joinedInPeriod || []) {
    if (!isUnrealised(j.invoice)) continue;
    count++;
    if (j.totalInclGst === null) { unknownTotal++; continue; }
    incl += j.totalInclGst;
  }
  return {
    revenueInclGst: round2(incl),
    revenueExGst: round2(incl * EX_GST_FACTOR),
    count,
    unknownTotal,
  };
}

/**
 * Split a deduction across chart buckets.
 *
 * Do NOT re-implement the backend's week/month/quarter boundaries. Take the
 * `bucket_start` keys off the series we were handed and put each invoice in the
 * last bucket that starts on or before its booking day. Granularity-agnostic,
 * and it cannot drift from the backend's own bucketing.
 *
 * @param {string[]} bucketStarts YYYY-MM-DD keys, any order
 * @returns {Map<string, {revenueInclGst:number, revenueExGst:number, count:number}>}
 */
export function bucketDeduction(joinedInPeriod, bucketStarts) {
  const starts = [...(bucketStarts || [])].sort();
  const out = new Map();
  for (const j of joinedInPeriod || []) {
    if (!isUnrealised(j.invoice) || j.totalInclGst === null) continue;
    let key = null;
    for (const s of starts) {
      if (s <= j.bookedOn) key = s; else break;
    }
    if (key === null) continue;   // earlier than the first bucket — out of range
    const cur = out.get(key) || { revenueInclGst: 0, revenueExGst: 0, count: 0 };
    cur.revenueInclGst = round2(cur.revenueInclGst + j.totalInclGst);
    cur.revenueExGst = round2(cur.revenueExGst + j.totalInclGst * EX_GST_FACTOR);
    cur.count++;
    out.set(key, cur);
  }
  return out;
}

/**
 * Apply a deduction to one set of backend figures — the KPI `current`/`previous`
 * object, or a single chart bucket.
 *
 * WHAT MOVES: revenue (incl-GST), gross_profit and net_profit (both ex-GST,
 * revenue side only), and `aov`, which is re-derived because leaving the
 * backend's would put an unadjusted average beside an adjusted revenue.
 *
 * WHAT DOES NOT: every cost. COGS, operating expenses, Stripe fees and the
 * orders count are returned untouched — that is the whole point of the hybrid,
 * and a test asserts it field by field.
 *
 * `null` in, `null` out — never 0. A backend figure that is unknown stays
 * unknown; `Number(null) === 0` is the bug that has bitten this codebase
 * repeatedly (ERR-068, ERR-074).
 *
 * @returns {object} a NEW object; the input is never mutated.
 */
export function applyCashBasis(figures, deduction) {
  const f = { ...(figures || {}) };
  if (!deduction || !(deduction.revenueInclGst > 0 || deduction.revenueExGst > 0)) return f;

  const rev = numOrNull(f.revenue);
  const gp = numOrNull(f.gross_profit);
  const np = numOrNull(f.net_profit);
  const orders = numOrNull(f.orders);

  if (rev !== null) f.revenue = round2(rev - deduction.revenueInclGst);
  if (gp !== null) f.gross_profit = round2(gp - deduction.revenueExGst);
  if (np !== null) f.net_profit = round2(np - deduction.revenueExGst);

  // AOV must follow revenue or the two disagree on screen. Orders is unchanged
  // by design, so this necessarily falls — that is the owner's decision, not a bug.
  if (f.revenue !== null && f.revenue !== undefined && orders) {
    f.aov = round2(Number(f.revenue) / orders);
  } else if ('aov' in f && !orders) {
    f.aov = null;
  }

  // Margins are re-derived from the ADJUSTED pair, against an ex-GST denominator
  // (ERR-111). The backend's own margin now legitimately describes a different
  // basis, so it must not be rendered beside these.
  const adjRev = numOrNull(f.revenue);
  const base = adjRev === null ? null : adjRev * EX_GST_FACTOR;
  f.gross_margin = marginPct(numOrNull(f.gross_profit), base);
  f.net_margin = marginPct(numOrNull(f.net_profit), base);
  f.margin_proxy = f.gross_margin;

  return f;
}

/**
 * profit ÷ ex-GST revenue, as a percentage. Null unless both are known and the
 * denominator is meaningfully non-zero — a near-zero base makes the ratio
 * explode, and an exploded margin beside a small profit is ERR-113.
 */
export function marginPct(profit, exGstBase) {
  if (profit === null || exGstBase === null) return null;
  if (!(Math.abs(exGstBase) > 0.005)) return null;
  return round2((profit / exGstBase) * 100);
}

/**
 * The sentence the dashboard prints under its KPI strip. Kept here so the
 * wording and the arithmetic cannot drift apart.
 *
 * It names the cost deliberately: without that clause a negative net profit
 * reads as a fault rather than as money we have spent and not yet been paid.
 */
export function cashBasisNote(deduction) {
  if (!deduction || !deduction.count) return null;
  const n = deduction.count;
  return `Invoiced sales count as revenue once marked paid. `
    + `$${deduction.revenueInclGst.toFixed(2)} across ${n} unpaid invoice${n === 1 ? '' : 's'} `
    + `is held out of revenue and profit; the cost of those goods stays in costs.`;
}
