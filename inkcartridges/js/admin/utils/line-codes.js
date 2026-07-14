/**
 * Line codes — what may be stored in an invoice/quick-order line's `product_code`.
 *
 * THE INVARIANT OF THIS MODULE: a line's code is a REAL products.sku, or it is
 * nothing at all. There is no third state.
 *
 * Why it matters (ERR-071): the backend materialises every invoice into a shadow
 * "order" and matches its line items BY SKU. A code that isn't a SKU matches
 * nothing, so the line is dropped and the invoice becomes a paid order with no
 * line items. Invoices #3263/#3264 shipped `CTN258` and `CLC531XL` — the series
 * codes printed on the box — instead of the SKUs `CTN258XLKCMY` / `CLC531XLKCMY`,
 * and both lines silently vanished.
 *
 * The picker was never the problem: it stores `product.sku` verbatim. The hole is
 * that the code box is a free-text input, so a code TYPED rather than PICKED
 * reached the payload unverified. This module is the gate that closes it.
 *
 * TWO RULES, both load-bearing:
 *
 *   1. AN EMPTY CODE IS LEGAL. "Code or description" is how freight, labour and
 *      one-off lines are modelled (validateInvoice in pages/invoices.js). A line
 *      with no code is never an error — only a NON-EMPTY code that doesn't resolve.
 *
 *   2. NEVER GUESS. `CTN258` is a prefix of both `CTN258BK` and `CTN258XLKCMY`.
 *      Auto-picking one would invoice the WRONG PRODUCT — worse than the bug we
 *      are fixing. Only an exact match (ignoring case) is accepted; everything
 *      else is handed back to the operator to resolve with the picker.
 *
 * Deliberately pure and dependency-free: no imports, no DOM, no network. The
 * catalogue lookup that feeds it lives in components/product-search.js
 * (resolveSkus), and the tests load this file straight into a vm sandbox.
 */

/** Trimmed string, defensively — lines arrive from the DOM, sessionStorage and the API. */
const clean = (s) => String(s ?? '').trim();

/**
 * The distinct, non-empty codes on these lines — i.e. exactly what needs checking
 * against the catalogue. Blank codes are dropped here (rule 1), so a document of
 * description-only lines asks the catalogue nothing at all.
 */
export function codesToVerify(lines) {
  const seen = new Set();
  for (const l of (lines || [])) {
    const c = clean(l?.code);
    if (c) seen.add(c);
  }
  return [...seen];
}

/**
 * Reconcile each line's code against the catalogue.
 *
 * `resolved` is Map<lowercased code, canonical products.sku> — the shape
 * resolveSkus() returns. A code that is present gets CANONICALISED in place, which
 * is how a hand-typed `ctn258xlkcmy` becomes the `CTN258XLKCMY` the backend can
 * match. A code that is absent did not match any SKU, and is returned as an error.
 *
 * Returns error objects in the shape both pages' markers already speak —
 * `{ line, lfield: 'code', msg }` (see markInvoiceErrors / markErrors) — so the
 * offending input is highlighted and focused with no new plumbing.
 *
 * Mutates the lines it canonicalises: the caller's draft IS the thing that gets
 * serialised into the payload, and canonical casing has to be what ships.
 */
export function applyResolvedCodes(lines, resolved) {
  const errs = [];
  if (!resolved) return errs;   // catalogue unreachable — the caller decides; see resolveSkus
  (lines || []).forEach((l, i) => {
    const code = clean(l?.code);
    if (!code) return;                                   // rule 1: no code is not an error
    const canonical = resolved.get(code.toLowerCase());
    if (canonical) { l.code = canonical; return; }       // snap to the catalogue's spelling
    errs.push({
      line: i,
      lfield: 'code',
      msg: `Line ${i + 1}: “${code}” isn’t a product SKU — pick the product from the list, `
         + 'or clear the code to keep it as a free-text line.',
    });
  });
  return errs;
}
