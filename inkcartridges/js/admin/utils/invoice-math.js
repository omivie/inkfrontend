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

/**
 * What one line actually cost US, with the CREDIT-LINE rule applied.
 *
 * costOrNull() above says an empty cost box means UNKNOWN, and for a product
 * line that is exactly right — nobody has costed it yet. But a line priced BELOW
 * zero is not a product. It is money coming off ("you already paid for the first
 * one"), there is nothing behind it to have bought, and so our cost is a KNOWN
 * $0.
 *
 * Note which way round this is. ERR-068's failure mode was reading an ABSENCE as
 * zero; this reads a SIGN as zero, and only that sign — a blank box on a
 * positively-priced line still comes back null, unknown, exactly as before. A
 * cost the operator typed always wins, in either direction.
 *
 * Every surface that asks "what did this line cost us" must come through here,
 * or the editor's margin bar and the figure we send the backend will disagree
 * about the same invoice. It reads BOTH shapes — editor draft and saved record —
 * for the same reason normalizeInvoice does.
 *
 * qty is applied by the caller (lineCostExGst), so a credit line of any quantity
 * still costs 0.
 */
export function lineSupplierCost(l) {
  const stored = costOrNull(l?.supplier_cost_excl_gst ?? l?.supplierCost);
  // A cost the OPERATOR typed wins over everything — including this rule. Note
  // the test is `cost_source`, not "is there a number here": a cost the product
  // picker auto-filled is not a claim about a credit line. Get that wrong and
  // picking product A and then typing -100 over its price books A's real $30
  // cost against negative revenue — a silent understatement that also reaches
  // the backend as this invoice's COGS.
  if ((l?.cost_source ?? l?.costSource) === 'manual' && stored != null) return stored;
  // Read the SAVED key first. A record off the backend spells the sell price
  // `unit_cost_excl_gst`; missing it here would leave every reopened credit line
  // reading as cost-unknown, which collapses the whole invoice's Profit column
  // to "—" and reports "nobody costed this" when we know exactly what it cost.
  if (num(l?.unit_cost_excl_gst ?? l?.unitCost ?? l?.unitPrice) < 0) return 0;
  return stored;
}

/**
 * Like costOrNull, but a profit may legitimately be NEGATIVE (a loss). Same
 * UNKNOWN-≠-0 discipline: '' / null / non-numeric → null (unknown); any finite
 * number, including a negative, → itself. Used for the backend's precomputed
 * profit_excl_gst, where costOrNull would wrongly null a real loss.
 */
export function profitOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Ex-GST revenue for one line: qty × sell price. */
export const lineRevenueExGst = (l) => num(l?.qty) * num(l?.unitCost ?? l?.unitPrice);

/** Ex-GST cost for one line, or null when the cost is unknown. */
export function lineCostExGst(l) {
  const c = lineSupplierCost(l);
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
  const lines = raw.map((l) => {
    const unitCost = num(l.unit_cost_excl_gst ?? l.unitCost ?? l.unitPrice ?? 0);
    return {
      code: l.product_code ?? l.code ?? '',
      description: l.description ?? '',
      qty: num(l.quantity ?? l.qty ?? 0),
      unitCost,
      // Through lineSupplierCost, not costOrNull: a saved invoice reopened next
      // month, and the analytics overlay reading the same record, must cost its
      // credit lines the way the editor did when it was written.
      supplierCost: lineSupplierCost({
        unitCost,
        supplierCost: l.supplier_cost_excl_gst ?? l.supplierCost,
        costSource: l.cost_source ?? l.costSource,
      }),
    };
  });
  const d = { lines, freight: num(r.freight_excl_gst ?? r.freight ?? 0) };
  const totals = computeInvoiceTotals(d);
  const cogs = computeInvoiceCogs(d);

  // §1 (backend response Jul 2026): GET /api/admin/invoices list rows now carry
  // precomputed cost_excl_gst / profit_excl_gst — the ONLY place the true COGS is
  // known here, because list rows deliberately omit per-line supplier costs (a list
  // response mustn't ship our cost). Prefer them when present; fall back to line-item
  // derivation otherwise, so an editor draft and the pre-deploy backend are unaffected.
  //
  // UNKNOWN ≠ 0 is preserved end-to-end. The backend sends BOTH fields as null,
  // together, when any coded line lacks a supplier cost — or when the invoice is void.
  // So detection is by field PRESENCE, not truthiness: a present-but-null field is an
  // authoritative "unknown" (→ "—"), while an ABSENT field means old backend / a draft
  // and we derive from the lines. A known $0 cost stays a real 0, never null.
  const hasServerFigures = Object.prototype.hasOwnProperty.call(r, 'profit_excl_gst')
    || Object.prototype.hasOwnProperty.call(r, 'cost_excl_gst');
  const serverProfit = profitOrNull(r.profit_excl_gst);   // number | null (loss allowed)
  const serverCost = costOrNull(r.cost_excl_gst);          // number | null (>= 0)
  const allKnown = hasServerFigures ? (serverProfit !== null) : cogs.allKnown;

  // Margin denominator: list rows have no line items, so totals.subtotal is 0. When
  // the server figures are known, revenue = profit + cost — exactly the backend's
  // Σ line_total_excl_gst (freight excluded), the same basis the detail editor uses.
  const revenueExGst = (hasServerFigures && allKnown)
    ? round2(serverProfit + serverCost)
    : totals.subtotal;

  return {
    id: r.id ?? null,
    status: r.status ?? 'unpaid',
    // order_date is the date the sale actually happened — the one analytics
    // should bucket by. issue_date is when the paperwork was cut.
    date: (r.order_date || r.issue_date || r.date || '').slice(0, 10) || '',
    sourceOrderId: r.source_order_id ?? null,
    lines,
    revenueExGst,
    freightExGst: totals.freight,
    gst: totals.gst,
    totalInclGst: totals.total,
    costExGst: hasServerFigures ? serverCost : cogs.costExGst,
    allCostsKnown: allKnown,
    unknownCostLines: hasServerFigures ? (allKnown ? 0 : null) : cogs.unknownLines,
    units: lines.reduce((s, l) => s + num(l.qty), 0),
    profit: hasServerFigures ? serverProfit : computeInvoiceProfit(d),
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
 *                     money has landed yet. (Handy side-effect: analytics do not
 *                     depend on the paid flag at all, so the paid/unpaid toggle —
 *                     PATCH /invoices/:id/status since ERR-131 — is pure operator
 *                     bookkeeping and can never move revenue.)
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
 * FOUR PRINTED COLUMNS — code, description, qty, ex-GST line total — plus a
 * fifth tuple slot carrying a customer-safe note that renders INSIDE the
 * description cell. The column count is what matters and it has not moved: a
 * fifth column is how our margin would end up on a customer's invoice, and
 * tests/admin-invoice-cost-not-on-document.test.js fails if one appears.
 *
 * The supplier cost is structurally unable to reach the live preview or the PDF
 * because it is not in this tuple and the renderers no longer touch the line
 * objects at all. That is the mechanism, not a promise.
 *
 * @param {object} d
 * @param {{money:Function, note?:Function}} deps `note` maps a line to its
 *        sub-line string; omit it and the slot is always ''.
 * @returns {Array<[string,string,string,string,string]>} `[printedCode,
 *        description, qty, lineTotal, note]` — printedCode is `ref || code`.
 */
export function invoiceDocRows(d, { money, note }) {
  const noteFor = typeof note === 'function' ? note : () => '';
  return (d?.lines || [])
    // Verbatim from the two renderers this replaces. NB it is deliberately looser
    // than the COGS/payload predicate above: a line carrying only a qty or a price
    // still prints. Preserved as-is — a refactor is the wrong place to change what
    // the customer sees.
    .filter((l) => l?.code || l?.ref || l?.description || num(l?.qty) || num(l?.unitCost))
    .map((l) => [
      // THE PRINTED CODE, which is not the same thing as the catalogue identity.
      // `ref` is the operator's own reference on a custom (non-catalogue) item;
      // `code` is a real products.sku. The customer's column shows whichever the
      // operator authored, and the backend's SKU matching only ever sees `code`.
      l.ref || l.code || '',
      l.description || '',
      String(num(l.qty)),
      money(lineRevenueExGst(l)),
      // Customer-safe by construction: read from the two volume fields only,
      // never from the line object at large.
      String(noteFor({ volumePercent: l.volumePercent, volumeQuantity: l.volumeQuantity }) || ''),
    ]);
}

/**
 * What the customer saved on this invoice by buying in bulk, ex-GST.
 *
 * Summed from the per-line savings the BACKEND returned and we stamped onto the
 * line when we applied its price. It is never re-derived from a retail price we
 * hold locally: an invoice reopened next month must not have its savings line
 * recomputed against a ladder that has since moved.
 *
 * Returns 0 when no line carries a saving — which is the same answer as "no
 * discount was given" and is safe to render as nothing. It deliberately does NOT
 * return null-for-unknown, because the caller's only use is `> 0 ? print : skip`
 * and an unknown saving prints nothing either way.
 */
export function computeInvoiceVolumeSavings(d) {
  return round2((d?.lines || []).reduce((s, l) => {
    const v = Number(l?.volumeSaving);
    return s + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0));
}
