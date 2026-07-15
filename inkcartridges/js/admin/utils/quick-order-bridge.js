/**
 * Quick Order → Invoice bridge — the prefill that crosses from the quick-order
 * register to the invoice editor, and the id that must come back.
 *
 * A quick order MAY become an invoice ("Create invoice" on a row or in the
 * editor). Since 2026-07-14 (backend migration 108) a saved quick order already
 * materialises its OWN shadow `orders` row (`channel='quick_order'`), so it is
 * counted in analytics exactly like an invoice. That is the whole reason this
 * module exists:
 *
 *   When a quick order is converted, the resulting invoice materialises ITS OWN
 *   paid shadow order. If the source quick order is left `status='open'`, the sale
 *   is counted TWICE — once as the quick-order shadow, once as the invoice's. The
 *   backend has no invoice→quick-order link, so the FE flipping the quick order to
 *   `status='invoiced'` (which cancels its shadow) is the SOLE double-count guard.
 *
 * The link is carried as `qo_id` inside the sessionStorage prefill on the way out,
 * and read back as `source_quick_order_id` on the invoice draft so the invoice save
 * (pages/invoices.js persistDraft) can perform the flip AFTER the invoice is truly
 * saved — never at bridge-click time, because a cancelled invoice would leave the
 * quick order invoiced-but-uninvoiced and the sale would vanish entirely.
 *
 * Deliberately pure and dependency-free — no imports, no DOM, no network — so the
 * whole guard is unit-testable by loading this file straight into a vm sandbox
 * (see tests/admin-quick-order-invoice-integration.test.js), the same discipline
 * as utils/line-codes.js.
 */

// Tiny numeric coercers, inlined to keep this module import-free. These mirror the
// per-page `num`/`round2` helpers used across the admin (quick-order.js,
// invoices.js) — the codebase intentionally keeps a local copy per module rather
// than a shared import.
const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Build the sessionStorage prefill that stages a quick order into a new invoice.
 *
 * `draft` is the quick-order editor draft (or a record already mapped into one):
 * `{ id, order_date, customer{name,company,phone,email,address}, lines[...] }`.
 *
 * The shape matches what invoices.js `maybeOpenFromQuickOrder` consumes, plus the
 * new `qo_id`. A SAVED quick order carries its `id`; a brand-new unsaved draft
 * (`id == null`) yields `qo_id: null` — correct, because nothing was persisted, so
 * there is no shadow order to double-count and nothing to flip.
 *
 * OUR-cost fields (`supplierCost`/`costSource`) are passed through VERBATIM; the
 * invoice consumer normalises `supplierCost` with `costOrNull` (idempotent), so
 * this stays the single owner of the prefill shape without duplicating that helper.
 * `unitPrice` (the quick order's ex-GST sell price) maps to the invoice's
 * `unitCost` (also the ex-GST sell price — see the naming note in utils/invoice-math.js).
 */
export function buildQuickOrderPrefill(draft) {
  const d = draft || {};
  const c = d.customer || {};
  return {
    qo_id: d.id || null,
    order_date: d.order_date || '',
    customer: {
      attn: c.name || '',
      name: c.name || '',
      company: c.company || '',
      address: c.address || '',
      phone: c.phone || '',
      email: c.email || '',
    },
    lines: (d.lines || []).map((l) => ({
      code: l.code || '',
      description: l.description || '',
      qty: num(l.qty) || 1,
      unitCost: round2(num(l.unitPrice)),
      supplierCost: l.supplierCost ?? null,
      costSource: l.costSource || 'auto',
    })),
  };
}

/**
 * Parse a staged prefill back into the pieces the invoice editor needs.
 *
 * Reads defensively: the raw string comes from sessionStorage and may be absent,
 * corrupt, or staged by a PREVIOUS build. Anything that isn't a JSON object returns
 * `null` (never throws) so the caller can simply skip. `qo_id` becomes
 * `source_quick_order_id` — the field the invoice save keys its flip off. A prefill
 * from before this change carries no `qo_id`, so `source_quick_order_id` is `null`
 * and no flip is attempted (that invoice simply won't auto-mark its quick order,
 * which is the pre-change behaviour — safe).
 */
export function parseQuickOrderPrefill(raw) {
  if (!raw) return null;
  let pre;
  try { pre = JSON.parse(raw); } catch (_) { return null; }
  if (!pre || typeof pre !== 'object') return null;
  return {
    order_date: typeof pre.order_date === 'string' ? pre.order_date : '',
    customer: (pre.customer && typeof pre.customer === 'object') ? pre.customer : null,
    lines: Array.isArray(pre.lines) ? pre.lines : null,
    source_quick_order_id: pre.qo_id || null,
  };
}

/**
 * The single predicate for "does this invoice still owe its source quick order a
 * status flip?" — returns the quick-order id, or `null` when there is nothing to
 * flip (no source, or the flip already happened and the caller cleared the field).
 *
 * This is what makes the flip idempotent: persistDraft flips once, sets
 * `_draft.source_quick_order_id = null`, and a later email/download re-save sees
 * `null` here and skips — so a converted sale is never marked invoiced twice.
 */
export function flipTargetFrom(draft) {
  return (draft && draft.source_quick_order_id) || null;
}
