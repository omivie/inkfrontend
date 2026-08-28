/**
 * Patch the line-item grid in place instead of rebuilding it (ERR-178).
 *
 * The Invoices and Quick Order editors both render their line items with
 * `host.innerHTML = lines.map(...)`, which is correct for a user gesture — add a
 * line, remove a line, pick a product — and catastrophic for anything that
 * arrives on its own. The volume/freight quote is exactly that: it is armed by a
 * keystroke, lands 400ms plus a round-trip later, and the full re-render it used
 * to trigger discarded the `<input>` the operator was typing into. The caret
 * went, and the portalled autocomplete menu anchored to that input was orphaned
 * rather than closed (`blur` never fires for a node removed from the DOM).
 *
 * So the quote reply comes through here instead. It can do that safely because
 * of what a quote is actually allowed to change — see applyQuoteToLines() in
 * invoice-quote.js. It never adds, removes or reorders a row, and it never
 * touches `code`, `description`, `qty`, `supplierCost`, `costSource` or `kind`.
 * The entire surface is two cells per row:
 *
 *   • the ex-GST price input — its value and its "hand-edited" class
 *   • the `.inv-line__note` strip — the volume badge, the "Apply volume price"
 *     offer button, and the "Inactive product" warning
 *
 * TWO GUARDS, both load-bearing:
 *
 *   1. NEVER WRITE INTO THE BOX UNDER THE CARET. Same rule the storefront cart
 *      applies to its quantity field (js/cart.js:2312, js/cart-page.js:600):
 *      `document.activeElement !== input` before assigning `.value`. A quote
 *      cannot have authored a price for a box being typed in anyway — the first
 *      keystroke flips that line to `priceSource: 'manual'` — but the guard also
 *      covers the operator editing a price while a quote fired by the qty or the
 *      code box is still in flight.
 *
 *   2. A COUNT MISMATCH IS NOT PATCHABLE. If the DOM and the draft disagree
 *      about how many rows exist, the grid is stale in a way cell-writes cannot
 *      repair, and patching it anyway would leave half a grid describing the
 *      wrong lines. Say so by returning false and let the caller do the full
 *      re-render it was going to do before. A skip is not a pass.
 */

import { linePrice, PRICE_MANUAL } from './invoice-quote.js';

// Invoices names the ex-GST sell price `unitCost`, Quick Order `unitPrice`.
// Matching both here is what lets one function serve both editors — `linePrice()`
// already reads the value through the same pair.
const PRICE_SELECTOR = '[data-lfield="unitCost"], [data-lfield="unitPrice"]';
const MANUAL_CLASS = 'inv-line__price--manual';
// A price below zero is a CREDIT line. Kept in sync here as well as in each
// page's renderLines(), so the affordance survives a quote reply — the same
// reason MANUAL_CLASS is toggled above. Styled once in admin.css, which serves
// both editors, so Quick Order gets it for free.
const CREDIT_CLASS = 'inv-line__price--credit';

/**
 * Fold a fresh quote into an already-rendered line grid.
 *
 * @param {Element|null} host     the `#inv-lines` / `#qo-lines` container
 * @param {Array} lines           the draft's lines, AFTER applyQuoteToLines()
 * @param {object} opts
 * @param {(line:object, i:number) => string} opts.noteHtml  the page's own
 *        lineQuoteNote() — the two editors word theirs differently, and both
 *        close over that page's `_volumeOffers` and `_quote`.
 * @returns {boolean} true when the grid was patched; FALSE when it could not be,
 *        which obliges the caller to fall back to a full re-render.
 */
export function patchQuotedLineRows(host, lines, { noteHtml } = {}) {
  if (!host) return false;
  const src = Array.isArray(lines) ? lines : [];
  const rows = host.querySelectorAll('.inv-line');
  if (rows.length !== src.length) return false;   // guard 2 — not patchable

  const active = typeof document !== 'undefined' ? document.activeElement : null;

  rows.forEach((row, i) => {
    const line = src[i];
    if (!line) return;

    const price = row.querySelector(PRICE_SELECTOR);
    if (price) {
      // guard 1 — the operator is mid-edit in this very box; leave it alone.
      // The class still updates: it changes no selection and steals no focus.
      if (price !== active) price.value = String(linePrice(line));
      price.classList.toggle(MANUAL_CLASS, line.priceSource === PRICE_MANUAL);
      price.classList.toggle(CREDIT_CLASS, linePrice(line) < 0);
    }

    // The note strip is the LAST child of the row and is absent when there is
    // nothing to say, so all three transitions have to be handled: gone, new,
    // and replaced. It holds no focusable state worth preserving — the "Apply
    // volume price" button is a click target, and a quote reply is the only
    // thing that can change what it offers.
    const html = typeof noteHtml === 'function' ? (noteHtml(line, i) || '') : '';
    const existing = row.querySelector('.inv-line__note');
    if (!html) { existing?.remove(); return; }
    if (existing) existing.outerHTML = html;
    else row.insertAdjacentHTML('beforeend', html);
  });

  return true;
}
