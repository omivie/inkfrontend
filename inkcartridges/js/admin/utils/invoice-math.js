/**
 * Invoice math — the single definition of what an invoice's revenue, cost and
 * profit are. Shared by the Invoices editor, the Quick Order editor, the interim
 * analytics overlay and the tests, so all four agree by construction.
 *
 * TWO FIELDS, EASILY CONFUSED — read this before touching anything:
 *
 *   unitCost / unit_cost_excl_gst
 *     The ex-GST SELL price. Badly named for historical reasons, but it is the
 *     "Cost (excl. GST)" column literally PRINTED on the customer's invoice —
 *     from the buyer's side, the cost *is* the price. Do not rename it; the
 *     backend contract, the PDF, every saved record and the Quick Order bridge
 *     all speak this name.
 *
 *   supplierCost / supplier_cost_excl_gst
 *     The ex-GST price WE paid. INTERNAL ONLY — it must never reach the preview,
 *     the PDF or the customer email. Mirrors order_items.supplier_cost_snapshot.
 *
 * Money conventions (inherited, unchanged):
 *   - Line sell price and freight are ex-GST; GST (15%) is added on top of
 *     (subtotal + freight); total is GST-inclusive.
 *   - Profit is GST-NEUTRAL (see profitability.js): ex-GST revenue minus ex-GST
 *     cost. GST paid to the supplier is reclaimed, so it never reduces profit.
 *   - Invoiced sales settle by bank transfer, so there is NO processor fee.
 */
import { computeOrderProfit, NO_PAYMENT_FEES, GST_RATE } from './profitability.js';

const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * THE INVARIANT OF THIS FEATURE: an empty cost box means UNKNOWN, not $0.
 *
 * Number('') === 0, and a $0 cost reports a 100% margin — so a line nobody has
 * costed would silently masquerade as pure profit. Every read of a supplier cost
 * goes through here, and every consumer must handle null as "we don't know"
 * rather than coercing it. profitability.js makes the same distinction
 * deliberately (see computeLineProfits: "Number(null) is 0, which would lie").
 *
 *   costOrNull('')    → null   (unknown)
 *   costOrNull(0)     → 0      (genuinely free — a known zero)
 *   costOrNull('abc') → null
 *   costOrNull(-1)    → null   (a negative cost is not a thing)
 */
export function costOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Ex-GST revenue for one line: qty × sell price. */
export const lineRevenueExGst = (l) => num(l?.qty) * num(l?.unitCost ?? l?.unitPrice);

/** Ex-GST cost for one line, or null when the cost is unknown. */
export function lineCostExGst(l) {
  const c = costOrNull(l?.supplierCost);
  return c == null ? null : num(l?.qty) * c;
}

/**
 * Invoice totals. Moved verbatim from the old private computeTotals() in
 * pages/invoices.js so the numbers cannot drift from what the PDF prints.
 */
export function computeInvoiceTotals(d) {
  const subtotal = round2((d?.lines || []).reduce((s, l) => s + lineRevenueExGst(l), 0));
  const freight = round2(num(d?.freight));
  const gst = round2((subtotal + freight) * GST_RATE);
  const total = round2(subtotal + freight + gst);
  return { subtotal, freight, gst, total };
}

/**
 * Cost of goods for an invoice.
 *
 * costExGst sums only the lines whose cost we actually know. When unknownLines
 * > 0 that figure is a FLOOR, not a fact — allKnown is false and every caller
 * must degrade to "—" rather than present it as the real COGS.
 */
export function computeInvoiceCogs(d) {
  const rows = (d?.lines || []).filter((l) => (l?.code || '').trim() || (l?.description || '').trim());
  let costExGst = 0;
  let unknownLines = 0;
  for (const l of rows) {
    const c = lineCostExGst(l);
    if (c == null) unknownLines += 1;
    else costExGst += c;
  }
  return { costExGst: round2(costExGst), unknownLines, allKnown: rows.length > 0 && unknownLines === 0 };
}

/**
 * Net profit on an invoiced sale, or null when any line's cost is unknown.
 *
 * Bank transfer, so NO_PAYMENT_FEES — no Stripe 2.65% + $0.30. Freight rides in
 * as shippingExGst so the shape is identical to an order's, which is what lets
 * the backend fold invoices into orders later without the math changing.
 */
export function computeInvoiceProfit(d) {
  const { costExGst, allKnown } = computeInvoiceCogs(d);
  if (!allKnown) return null;
  const t = computeInvoiceTotals(d);
  return computeOrderProfit(t.subtotal, costExGst, { shippingExGst: t.freight, ...NO_PAYMENT_FEES });
}

/**
 * Read an invoice from EITHER shape — an editor draft (lines[].unitCost /
 * .supplierCost) or a saved backend record (line_items[].unit_cost_excl_gst /
 * .supplier_cost_excl_gst) — into one normalized view. The overlay only ever
 * sees saved records; the editor only ever sees drafts; both land here.
 */
export function normalizeInvoice(recOrDraft) {
  const r = recOrDraft || {};
  const raw = r.line_items || r.lines || [];
  const lines = raw.map((l) => ({
    code: l.product_code ?? l.code ?? '',
    description: l.description ?? '',
    qty: num(l.quantity ?? l.qty ?? 0),
    unitCost: num(l.unit_cost_excl_gst ?? l.unitCost ?? l.unitPrice ?? 0),
    supplierCost: costOrNull(l.supplier_cost_excl_gst ?? l.supplierCost),
  }));
  const d = { lines, freight: num(r.freight_excl_gst ?? r.freight ?? 0) };
  const totals = computeInvoiceTotals(d);
  const cogs = computeInvoiceCogs(d);
  return {
    id: r.id ?? null,
    status: r.status ?? 'unpaid',
    // order_date is the date the sale actually happened — the one analytics
    // should bucket by. issue_date is when the paperwork was cut.
    date: (r.order_date || r.issue_date || r.date || '').slice(0, 10) || '',
    sourceOrderId: r.source_order_id ?? null,
    lines,
    revenueExGst: totals.subtotal,
    freightExGst: totals.freight,
    gst: totals.gst,
    totalInclGst: totals.total,
    costExGst: cogs.costExGst,
    allCostsKnown: cogs.allKnown,
    unknownCostLines: cogs.unknownLines,
    units: lines.reduce((s, l) => s + num(l.qty), 0),
    profit: computeInvoiceProfit(d),
  };
}

/**
 * Does this invoice contribute to sales analytics?
 *
 *   void            → never. It's a cancelled document; the sale didn't happen.
 *   source_order_id → never. THE DOUBLE-COUNT GUARD. An invoice built FROM an
 *                     existing order is paperwork *for* that order — the order
 *                     is already in the numbers. Counting the invoice too would
 *                     book the same sale twice. True even when it's paid.
 *   unpaid          → counts. We recognise on an ACCRUAL basis: the sale
 *                     happened on the invoice's order date whether or not the
 *                     money has landed yet. (Handy side-effect: this does not
 *                     depend on POST /invoices/:id/paid, which is still a 404.)
 */
export function countsForAnalytics(rec) {
  if (!rec) return false;
  if (rec.status === 'void') return false;
  if ((rec.source_order_id ?? rec.sourceOrderId) != null) return false;
  return true;
}

/**
 * The ONLY row projection the customer-facing document may use.
 *
 * Exactly four fields — code, description, qty, ex-GST line total. The supplier
 * cost is structurally unable to reach the live preview or the PDF because it is
 * not in this tuple and the renderers no longer touch the line objects at all.
 * That is the mechanism, not a promise; tests/admin-invoice-cost-not-on-document
 * .test.js holds it in place.
 */
export function invoiceDocRows(d, { money }) {
  return (d?.lines || [])
    // Verbatim from the two renderers this replaces. NB it is deliberately looser
    // than the COGS/payload predicate above: a line carrying only a qty or a price
    // still prints. Preserved as-is — a refactor is the wrong place to change what
    // the customer sees.
    .filter((l) => l?.code || l?.description || num(l?.qty) || num(l?.unitCost))
    .map((l) => [
      l.code || '',
      l.description || '',
      String(num(l.qty)),
      money(lineRevenueExGst(l)),
    ]);
}
