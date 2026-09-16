/**
 * Stock adjustment — the single vocabulary for "how many units are on hand, and
 * what does adding or removing some of them come to".
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The admin product editor's Inventory tab carried weight, sourcing identity and
 * two visibility toggles, and no quantity at all. An operator taking a delivery
 * or writing off a damaged unit had to go to the database. This is the arithmetic
 * behind the control that closes that gap.
 *
 * It is separate from the page, and pure, for two reasons.
 *
 * FIRST: stock zero is not a bookkeeping state, it is a storefront state. At
 * `stock_quantity` 0 the product card swaps Add to cart for a Contact us button
 * (js/products.js:238, js/shop-page.js:4782) and `getStockStatus()` prints
 * "Contact Us For Stock Enquiries" (js/api.js:4225). So the branch that decides
 * whether a number reaches zero has to be exercised for real by a test, not
 * grepped for. Same reasoning, same shape as `product-deletability.js`.
 *
 * SECOND: ***A MISSING INPUT IS NOT A ZERO.*** `stock_quantity` arrives in three
 * distinct states and only one of them means "none in the warehouse":
 *
 *     absent from the record   →  we were never told. Say so.
 *     present and null         →  the column is empty. Not a count.
 *     present and a number     →  a count, and 0 is a real one.
 *
 * Collapsing the first two into 0 would take a product whose stock we simply
 * failed to fetch and tell the operator it was out of stock — and, if they then
 * "corrected" it, would pull a live product off sale. That is the ERR-063 /068
 * /073 /075 /076 /149 /150 family, and it is the same rule `bulkSetActiveFor`
 * states for price: a product whose value we cannot establish is REFUSED rather
 * than written with a guess (js/admin/pages/products.js:4656).
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It never derives `stock_status`. That column is TRI-state — `in_stock`,
 * `out_of_stock` and `contact_us` — and `contact_us` cannot be recomputed from a
 * number. A control that "kept status in sync" with the quantity would silently
 * convert every deliberate contact-us product into an ordinary one. `in_stock` is
 * likewise derived by the backend (measured 2026-09-16: false on exactly the rows
 * at 0), so neither belongs in a payload this module produces.
 *
 * Pure: no DOM, no globals, no imports. Plain text and plain data out; the page
 * escapes and renders.
 */

/** The record carries no `stock_quantity` key at all — we were never told. */
export const STOCK_UNKNOWN = 'STOCK_UNKNOWN';
/** The key is there and empty. A blank column, not a count of zero. */
export const STOCK_EMPTY = 'STOCK_EMPTY';
/** A real count. `value` is a non-negative integer, and 0 is meaningful. */
export const STOCK_KNOWN = 'STOCK_KNOWN';

/**
 * Read a product's stock level as one of three states.
 *
 * `hasOwnProperty`, not truthiness: a record that omits the field and a record
 * holding 0 are identical to `!product.stock_quantity` and mean opposite things.
 *
 * @param {object|null} product
 * @returns {{state:string, value:number|null, label:string}}
 */
export function readStock(product) {
  if (!product || typeof product !== 'object'
      || !Object.prototype.hasOwnProperty.call(product, 'stock_quantity')) {
    return { state: STOCK_UNKNOWN, value: null, label: 'not available' };
  }
  const raw = product.stock_quantity;
  if (raw === null || raw === undefined || raw === '') {
    return { state: STOCK_EMPTY, value: null, label: '—' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { state: STOCK_UNKNOWN, value: null, label: 'not available' };
  }
  const units = Math.trunc(n);
  return {
    state: STOCK_KNOWN,
    value: units,
    label: `${units} unit${units === 1 ? '' : 's'}`,
  };
}

/** Can this product's stock be adjusted at all? Only from a known baseline. */
export function canAdjust(product) {
  return readStock(product).state === STOCK_KNOWN;
}

/**
 * Work out what a delta comes to, refusing everything that isn't a clean move.
 *
 * The operator types a magnitude and picks a direction, the way the loyalty
 * points adjustment does (js/admin/pages/customers.js:358) — recording the
 * intent ("12 received") rather than a final number, so two people counting the
 * same shelf cannot silently overwrite each other with stale totals.
 *
 * @param {number|null} current  the baseline, from readStock().value
 * @param {'add'|'remove'} direction
 * @param {number|string} magnitude  how many units, always positive
 * @returns {{ok:boolean, value:number|null, delta:number|null, error:string|null,
 *            zeroing:boolean}}
 */
export function computeNewStock(current, direction, magnitude) {
  const refuse = (error) => ({ ok: false, value: null, delta: null, error, zeroing: false });

  if (!Number.isFinite(Number(current)) || current === null || current === '') {
    return refuse('There is no current stock level to adjust from.');
  }
  if (direction !== 'add' && direction !== 'remove') {
    return refuse('Choose whether you are adding or removing stock.');
  }

  const raw = typeof magnitude === 'string' ? magnitude.trim() : magnitude;
  if (raw === '' || raw === null || raw === undefined) {
    return refuse('Enter how many units.');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return refuse('Enter how many units, as a number.');
  if (!Number.isInteger(n)) return refuse('Stock moves in whole units.');
  if (n <= 0) return refuse('Enter a number above zero, and pick a direction.');

  const base = Math.trunc(Number(current));
  const delta = direction === 'remove' ? -n : n;
  const value = base + delta;

  if (value < 0) {
    return refuse(`You cannot remove ${n} — there ${base === 1 ? 'is' : 'are'} only ${base} on hand.`);
  }

  return { ok: true, value, delta, error: null, zeroing: value === 0 && base !== 0 };
}

/**
 * Shown, and a second click required, before a change that lands on zero.
 *
 * Worth interrupting for because the consequence is not on this screen: at 0 the
 * storefront stops selling the product. Naming it is the difference between an
 * operator choosing that and discovering it. A second click rather than a nested
 * dialog — the product editor is its own modal, and stacking one inside it is how
 * a confirm ends up dismissing the form behind it.
 */
export const ZEROING_NOTICE = 'This drops the product to 0. It will stop showing '
  + 'Add to cart and will show "Contact Us For Stock Enquiries" instead. '
  + 'Click Apply again to confirm.';

/**
 * The body for the write.
 *
 * Deliberately small. Measured 2026-09-16 (`npm run probe:product-stock` §4b): a
 * five-key PUT left all 13 other columns on the row untouched, so a stock write
 * costs nothing else. The identity fields are here because the route REQUIRES
 * `retail_price` (products.js:4644) and because a partial PUT has been seen
 * defaulting fields rather than merging them (ERR-244) — sending the row's own
 * values back is a no-op for everything except the number being changed.
 *
 * `stock_status` and `in_stock` are absent on purpose. See the module header.
 */
export function stockAdjustPayload(product, newValue) {
  if (!product || !Number.isInteger(newValue) || newValue < 0) return null;
  return {
    sku: product.sku,
    name: product.name,
    is_active: product.is_active !== false,
    retail_price: product.retail_price,
    stock_quantity: newValue,
  };
}
