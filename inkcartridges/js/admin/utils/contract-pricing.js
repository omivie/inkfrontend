/**
 * Contract pricing — one business account's own price for one product.
 *
 * An admin opens a business account, searches the catalogue inside it, and sets
 * that account's price for a product. Nothing else is touched: the price lives
 * in its own table keyed on (business account × product), so the catalogue row,
 * the Google feed, the sitemap and every other customer are untouched by
 * definition rather than by convention.
 *
 * Contract: `readfirst/business-account-contract-pricing-FE-handoff-sep2026.md`
 * (backend migration 165). Our verified reply, including the three things that
 * handoff got wrong, is `business-account-contract-pricing-FE-response-sep2026.md`.
 *
 * Everything here is PURE — no DOM, no network — so every rule below is driven
 * directly by `tests/admin-contract-pricing-sep2026.test.js`.
 *
 * ── THE TWO FUNCTIONS THIS FILE EXISTS FOR ─────────────────────────────────
 *
 * `evaluatePrice()` and `describeHistoryRow()`. Both are places where an absent
 * value would otherwise render as a confident zero, which is the failure this
 * codebase keeps paying for (ERR-063/068/073/075/076/149/150).
 *
 *   - A product with no recorded supplier cost comes back with
 *     `cost_known: false` and `net_margin_percent`, `break_even_price` and
 *     `floor_price` ALL null. "0% margin" would be a lie and "$0.00 break-even"
 *     would be a licence to give the product away. The answer is "unknown".
 *
 *   - A history row's `previous_price` is null on a FIRST set and on a
 *     REACTIVATION, and `new_price` is null on a REMOVAL. `Number(null)` is 0,
 *     so the obvious rendering turns "this price had no predecessor" into
 *     "the price used to be $0.00" and "the price was withdrawn" into "the
 *     price was changed to $0.00". Both are worse than saying nothing.
 *
 * ── WHAT THE BACKEND REFUSES, AND WHAT IT MERELY FLAGS ─────────────────────
 *
 * Only BELOW COST is refused (409 `PRICE_BELOW_COST`), and even that is
 * overridable by re-sending with `acknowledge_below_cost: true`. Everything
 * else — under the automatic-discount floor, above list — is allowed and
 * flagged, because a thin negotiated line is a commercial decision the operator
 * owns. So `evaluatePrice` GRADES, it does not gate: the only band that blocks
 * a save without a confirmation is `below_cost`, and the server decides that
 * anyway. We colour the box early so the operator sees it before they press
 * Save, not so we can overrule them.
 *
 * ── GST ────────────────────────────────────────────────────────────────────
 *
 * `custom_price` is GST-INCLUSIVE, the same basis as the storefront price and
 * as `products.retail_price`. Every figure in this module is GST-incl. There is
 * no ex-GST number anywhere here, deliberately: the invoice editor works in
 * ex-GST and mixing the two bases in one file is how they get swapped.
 */

// ── Server-measured limits (probed live 2026-09-06, super_admin) ────────────

/** `custom_price` — must be > 0 and ≤ this. Two decimal places. */
export const PRICE_MAX = 100000;

/** `notes` on a set or a remove. */
export const NOTES_MAX = 1000;

/**
 * `GET /api/admin/business/accounts?status=` — these three and nothing else.
 *
 * NOT the storefront's vocabulary. `js/business.js` treats `approved` and
 * `active` as interchangeable because `/api/business/status` answers
 * `"approved"`; this admin endpoint answers `"active"` and hard-400s on
 * `status=approved` ("must be one of [active, suspended, closed]"). Two
 * vocabularies for two endpoints — do not merge them, and do not send
 * `approved` here.
 */
export const ACCOUNT_STATUSES = Object.freeze(['active', 'suspended', 'closed']);

/**
 * `?limit=101` is a **400**, not a silent clamp (verified live 2026-09-06:
 * `"limit" must be less than or equal to 100`). Worth stating as a constant
 * because the previous caller sent `?limit=200` and would have failed on the
 * day the endpoint shipped.
 */
export const ACCOUNTS_LIMIT_MAX = 100;

/** Only an ACTIVE account prices a quote. Suspended and closed pay list. */
export const ACCOUNT_PRICES_QUOTES = 'active';

// ── Small shared helpers ────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A figure the server sent: a number, or null meaning "not known". */
const nullableNum = (v) => (v == null ? null : (isNum(Number(v)) ? Number(v) : null));
const money = (v) => `$${Math.abs(Number(v) || 0).toFixed(2)}`;

// ── Price input ─────────────────────────────────────────────────────────────

/**
 * Parse what the operator typed into the price box.
 *
 * Returns `{ value, error }` — never throws, and never returns a value AND an
 * error. An empty box is `{ value: null, error: null }`: nothing typed yet is
 * not a validation failure, and reddening a box the operator has not filled in
 * is how a form teaches people to ignore it.
 *
 * The server re-validates all of this and wins. This exists so the common
 * mistakes cost no round trip, not to be an authority.
 */
export function parsePriceInput(raw) {
  const s = String(raw ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!s) return { value: null, error: null };

  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, error: 'Enter a price, for example 104.90.' };
  // The server's rule is `> 0`, so zero is refused too — and it must be, or
  // "free" becomes a thing an operator can set with a keystroke and no warning.
  if (n <= 0) return { value: null, error: 'The price must be more than $0.' };
  if (n > PRICE_MAX) return { value: null, error: `The price can’t be more than ${money(PRICE_MAX)}.` };
  // More than 2dp is a typo far more often than it is intent, and the server
  // stores 2dp regardless — so say what will actually be saved.
  if (Math.round(n * 100) !== Number((n * 100).toFixed(4))) {
    return { value: null, error: 'Use at most two decimal places.' };
  }
  return { value: Math.round(n * 100) / 100, error: null };
}

// ── The bands ───────────────────────────────────────────────────────────────

/** Bands `evaluatePrice()` can return, worst-first where they overlap. */
export const BAND_BELOW_COST = 'below_cost';
export const BAND_BELOW_FLOOR = 'below_floor';
export const BAND_ABOVE_LIST = 'above_list';
export const BAND_UNKNOWN = 'unknown';
export const BAND_OK = 'ok';
export const BAND_EMPTY = 'empty';

/**
 * Grade a typed price against the guard rails the search endpoint already sent,
 * so the operator sees the problem WHILE THEY TYPE with no round trip.
 *
 * `guards` is a §4.4 product-search row or a §4.5 evaluation block — both carry
 * the same four keys:
 *   `list_price`        what everyone else pays (GST-incl)
 *   `break_even_price`  below this we LOSE money → the server refuses the save
 *   `floor_price`       the lowest the automatic ladder would ever go
 *   `cost_known`        false ⇒ the other three are all null
 *
 * `cost_known` is read as "not explicitly false", because §4.4 rows do not
 * carry the key at all — they express the same fact by sending null guards.
 * Both spellings must land in the same band, or the same product grades
 * differently depending on which endpoint the row came from.
 *
 * Severity order is deliberate and is NOT the order the fields appear in the
 * doc: below-cost outranks below-floor (every below-cost price is also below
 * the floor, and only one of those two sentences is the one that matters).
 *
 * @returns {{band:string, message:string, blocking:boolean}}
 *   `blocking` means "the server will refuse this without an acknowledgement" —
 *   it is NOT "don't let them save". Only `below_cost` is ever blocking.
 */
export function evaluatePrice(value, guards) {
  const g = guards || {};
  const list = nullableNum(g.list_price);
  const breakEven = nullableNum(g.break_even_price);
  const floor = nullableNum(g.floor_price);
  const costKnown = g.cost_known !== false && breakEven != null;

  if (value == null) return { band: BAND_EMPTY, message: '', blocking: false };

  // Below cost first: it is the only refusal, and it is also below the floor,
  // so testing the floor first would print the milder of two true sentences.
  if (costKnown && breakEven != null && value < breakEven) {
    return {
      band: BAND_BELOW_COST,
      message: `Below cost — this loses money on every unit. Break-even is ${money(breakEven)}.`,
      blocking: true,
    };
  }

  // Above list is allowed, but the account is charged the LIST price until list
  // rises above it — so the number typed here would simply not be what they pay.
  // That is worth saying plainly; an operator typing it has almost certainly
  // mistyped, and "allowed" is not the same as "does what you meant".
  if (list != null && value > list) {
    return {
      band: BAND_ABOVE_LIST,
      message: `Above the list price of ${money(list)}. Allowed, but this account would still be charged ${money(list)} until list rises above it.`,
      blocking: false,
    };
  }

  if (floor != null && value < floor) {
    return {
      band: BAND_BELOW_FLOOR,
      message: `Deeper than the automatic discount would ever go (${money(floor)}). Still profitable — just make sure it’s deliberate.`,
      blocking: false,
    };
  }

  // No cost on file. The margin cannot be checked AT ALL — not "the margin is
  // zero", not "the margin is fine". Say which one it is.
  if (!costKnown) {
    return {
      band: BAND_UNKNOWN,
      message: 'Margin can’t be checked — this product has no recorded supplier cost. The price will still be saved.',
      blocking: false,
    };
  }

  return { band: BAND_OK, message: '', blocking: false };
}

// ── Percent and money formatting ────────────────────────────────────────────

/**
 * A margin or discount percent the server computed, or "unknown".
 *
 * `null` means the margin COULD NOT BE COMPUTED (no supplier cost). It is not
 * 0%, and rendering it as "0%" invents a fact — the ERR-068 shape, where an
 * unknown cost was reported as a zero cost and a $0 cost is a 100% margin.
 *
 * A real 0 is printed as "0%": that IS a measurement.
 */
export function formatMarginPercent(v) {
  const n = nullableNum(v);
  if (n == null) return 'unknown';
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * A discount percent beside a price. Same null rule; the difference is that
 * this one is a saving, so an absent value renders as an em dash rather than
 * the word "unknown" (there is no claim to qualify — there is just no discount).
 */
export function formatDiscountPercent(v) {
  const n = nullableNum(v);
  if (n == null) return '—';
  return `−${Math.round(n * 10) / 10}%`;
}

/**
 * A signed money delta: '−$9.42' when the price went DOWN, '+$4.10' when it
 * went up, and '—' when there is no delta to show.
 *
 * The sign is the whole point. `change_amount` is signed and negative means the
 * price fell, which is the good direction for the customer and the bad one for
 * margin; an unsigned "$9.42" beside "was $114.32 → now $104.90" reads as an
 * increase to about half of everyone.
 *
 * U+2212 MINUS SIGN, matching the storefront's chips — but note this string is
 * for the ADMIN only. `lineDocNote()` in invoice-quote.js stays on an ASCII
 * hyphen because jsPDF's WinAnsi font cannot draw U+2212.
 */
export function formatSignedMoney(v) {
  const n = nullableNum(v);
  if (n == null) return '—';
  if (n === 0) return '$0.00';
  return `${n < 0 ? '−' : '+'}${money(n)}`;
}

// ── History ─────────────────────────────────────────────────────────────────

/** The four actions a §4.6 history row can record. */
export const HISTORY_ACTIONS = Object.freeze(['set', 'updated', 'reactivated', 'removed']);

/**
 * Read one price-history row into something renderable, WITHOUT turning any of
 * its nulls into zeros.
 *
 * The §4.6 table, which is the whole reason this function exists:
 *
 *   action        previous_price   new_price   change_amount
 *   ───────────────────────────────────────────────────────
 *   set            null            the price   null
 *   updated        the old price   the new     signed delta
 *   reactivated    null            the price   null
 *   removed        the withdrawn   null        null
 *
 * So `previous` is absent for two of the four actions and `next` is absent for
 * a third. `Number(null)` is 0 and every one of those would render as $0.00.
 *
 * `sku` and `name` are SNAPSHOTS taken at the time of the change, and the row
 * has no foreign key to `products` — a later SKU rename, or deleting the
 * product outright, cannot rewrite history. Callers must render `row.sku`, not
 * the current product's; this function returns the snapshot so there is nothing
 * else to reach for.
 *
 * @returns {{action, known, label, previous, next, delta, direction, sku, name,
 *            changedByEmail, notes, at}|null}
 */
export function describeHistoryRow(row) {
  if (!row || typeof row !== 'object') return null;

  const rawAction = String(row.action ?? '').trim().toLowerCase();
  const known = HISTORY_ACTIONS.includes(rawAction);

  const previous = nullableNum(row.previous_price);
  const next = nullableNum(row.new_price);
  const delta = nullableNum(row.change_amount);

  // An action we do not recognise is reported as itself rather than guessed at
  // or silently dropped: a new backend action would otherwise vanish from the
  // audit trail, which is the one surface where a missing row is unacceptable.
  const label = known ? HISTORY_LABELS[rawAction] : (rawAction || 'changed');

  return {
    action: known ? rawAction : rawAction || null,
    known,
    label,
    previous,
    next,
    delta,
    direction: delta == null ? null : (delta < 0 ? 'down' : (delta > 0 ? 'up' : 'flat')),
    // The snapshot, never the live product. See the docblock.
    sku: row.sku ?? null,
    name: row.name ?? null,
    listPriceAtChange: nullableNum(row.list_price_at_change),
    discountPercentAtChange: nullableNum(row.discount_percent_at_change),
    changedByEmail: row.changed_by_email ?? null,
    notes: String(row.notes ?? '').trim() || null,
    at: row.created_at ?? null,
  };
}

const HISTORY_LABELS = Object.freeze({
  set: 'Price set',
  updated: 'Price changed',
  reactivated: 'Price re-added',
  removed: 'Price removed',
});

/**
 * The "was → now" sentence for a history row or a `last_change`, or '' when the
 * row cannot support one.
 *
 * A first `set` has no "was", and a `removed` has no "now" — so neither gets a
 * two-sided sentence with a fabricated $0.00 on the empty side.
 */
export function describeChange(row) {
  const d = describeHistoryRow(row);
  if (!d) return '';
  if (d.previous != null && d.next != null) return `${money(d.previous)} → ${money(d.next)}`;
  if (d.previous == null && d.next != null) return `${money(d.next)} (first set)`;
  if (d.previous != null && d.next == null) return `${money(d.previous)} withdrawn`;
  return '';
}

/**
 * Stated once, on any panel that renders history rows.
 *
 * Without it, a row showing a SKU that no longer exists looks like a bug rather
 * than the point.
 */
export function historySnapshotNote() {
  return 'The product code and name on each row are as they were at the time of the change, so renaming or deleting a product never rewrites this history.';
}

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Turn a failed save or remove into something an operator can act on.
 *
 * ── THE 409 IS THE INTERESTING ONE, AND IT IS NOT DELIVERED WHERE YOU'D LOOK ─
 *
 * `PRICE_BELOW_COST` is a refusal the operator can override by re-sending the
 * identical body with `acknowledge_below_cost: true`, and to write that dialog
 * honestly we need `details.evaluation` — the break-even figure and the margin
 * the price would actually produce.
 *
 * The shared client does not hand it over by the usual route. `js/api.js`
 * special-cases 409 and returns `{ ok:false, error:<string>, code, data:<raw
 * body> }` — note `error` is the MESSAGE STRING, not the error object. So
 * `invoiceError()`'s object branch never runs, its `resp.details` fallback finds
 * nothing (there is no top-level `details` on a 409), and `err.details` ends up
 * null. The evaluation survives only at `resp.data.error.details`.
 *
 * `contractPriceError()` in api.js digs it out; this function reads whatever it
 * managed to find. If the evaluation is genuinely missing we say so rather than
 * printing a confirmation dialog with blanks where the numbers should be — a
 * dialog that asks "are you sure?" and cannot say what you are agreeing to is
 * worse than an error.
 *
 * @returns {{code, needsAcknowledge, title, message, evaluation, fieldErrors}}
 */
/**
 * Drop a trailing "Re-send with <flag>: true …" instruction from a server
 * message, leaving every figure in it untouched.
 *
 * Deliberately narrow: it only removes a sentence that names re-sending with a
 * flag. Anything else the backend says reaches the operator word for word.
 */
function stripApiInstruction(message) {
  const s = String(message ?? '').trim();
  if (!s) return '';
  return s.replace(/\s*Re-send with\s+\w+\s*:\s*true[^.]*\.?\s*$/i, '').trim();
}

export function describeSaveError(err) {
  const code = err?.code ?? null;
  const base = {
    code,
    needsAcknowledge: false,
    title: 'Could not save that price',
    message: err?.message || 'Something went wrong saving this price. Nothing has been changed.',
    evaluation: null,
    fieldErrors: [],
  };

  if (code === 'PRICE_BELOW_COST') {
    const evaluation = err?.evaluation || null;
    return {
      ...base,
      needsAcknowledge: true,
      title: 'This price is below cost',
      // The server's own sentence, minus its closing API instruction.
      //
      // The message ends "Re-send with acknowledge_below_cost: true to set it
      // anyway." — correct, and written for whoever is calling the endpoint.
      // WE are that caller: the operator's "Set it anyway" button is exactly
      // that re-send. Leaving it in tells a salesperson to do something they
      // cannot do, in a vocabulary they have no reason to know, one line above
      // the button that does it for them.
      //
      // Everything that is a MEASUREMENT — the break-even figure — is kept
      // verbatim, because that is the part we must not paraphrase.
      message: stripApiInstruction(err?.message)
        || 'This price is below cost — it would lose money on every unit.',
      evaluation,
    };
  }

  if (code === 'VALIDATION_FAILED') {
    const details = Array.isArray(err?.details) ? err.details : [];
    return {
      ...base,
      title: 'That price wasn’t accepted',
      fieldErrors: details.map((d) => ({ field: d?.field ?? null, message: d?.message || String(d) })),
    };
  }

  if (code === 'NOT_FOUND') {
    return {
      ...base,
      title: 'Not found',
      message: err?.message || 'That account or product no longer exists. Nothing has been changed.',
    };
  }

  if (code === 'RATE_LIMITED') {
    return {
      ...base,
      title: 'Too many changes, too quickly',
      message: 'The server is rate-limiting writes (20 a minute). Wait a moment and try again — nothing has been changed.',
    };
  }

  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') {
    return {
      ...base,
      title: 'Not permitted',
      message: 'Contract pricing is super-admin only. Nothing has been changed.',
    };
  }

  if (code === 'BAD_REQUEST') {
    return {
      ...base,
      title: 'This product can’t be priced',
      message: err?.message || 'This product has no list price to price against.',
    };
  }

  return base;
}

/**
 * The DELETE answers 404 when the account has no price for that product.
 *
 * That is an HONEST answer to a double-click, and it must not be dressed up as
 * a success — but it also is not a failure the operator caused. Callers say
 * "there was no price to remove", refresh, and move on.
 */
export function isAlreadyRemoved(err) {
  return err?.code === 'NOT_FOUND';
}

// ── Quote-time account envelope (§6.1) ──────────────────────────────────────

/**
 * Describe the business account a quote resolved, for the chip above the line
 * items in both operator editors.
 *
 * ── READ `consulted` AND `pricedLineCount` AS TWO DIFFERENT FACTS ───────────
 *
 * `contract_prices_consulted: true` does NOT mean a line got a contract price.
 * An active account with no negotiated price on any quoted line is `true` / `0`
 * — which is a completely normal state and must not read as a failure. So:
 * badge off `contract_priced_line_count`, explain off `business_account_status`.
 *
 * ── AND `consulted: false` IS AMBIGUOUS, MEASURED 2026-09-06 ────────────────
 *
 * Three different situations all answer `consulted: false` with every account
 * field null, and the response cannot tell them apart:
 *   - no identifier was sent at all
 *   - the customer is a normal retail customer with no business account
 *   - the `customer_id` sent was WRONG (a bogus UUID returns 200, not 404)
 *
 * So the copy says "no business account" — a statement about what we found —
 * and never "list pricing confirmed", which would be a claim about a lookup
 * that may not have happened.
 */
export function describeQuoteAccount(account) {
  const a = account || {};
  const id = a.businessAccountId ?? a.business_account_id ?? null;
  const name = a.businessAccountName ?? a.business_account_name ?? null;
  const status = a.businessAccountStatus ?? a.business_account_status ?? null;
  const consulted = (a.contractPricesConsulted ?? a.contract_prices_consulted) === true;
  const pricedLineCount = Number(a.contractPricedLineCount ?? a.contract_priced_line_count ?? 0) || 0;

  if (!consulted || !id) {
    return {
      state: 'none', id: null, name: null, status: null, pricedLineCount: 0,
      label: 'No business account',
      detail: 'Quoted at list price plus the ordinary volume discounts.',
    };
  }

  if (status && status !== ACCOUNT_PRICES_QUOTES) {
    return {
      state: 'inactive', id, name, status, pricedLineCount: 0,
      label: `${name || 'Business account'} — ${status}`,
      // Say WHY, or the operator sees list pricing on an account they know has
      // negotiated rates and assumes the feature is broken.
      detail: `Only an active account is priced on contract, so this quote uses list pricing. Reactivate the account to apply its own prices.`,
    };
  }

  if (pricedLineCount > 0) {
    return {
      state: 'priced', id, name, status, pricedLineCount,
      label: `${name || 'Business account'} — contract pricing`,
      detail: `${pricedLineCount} line${pricedLineCount === 1 ? '' : 's'} priced from this account’s own rates.`,
    };
  }

  return {
    state: 'active', id, name, status, pricedLineCount: 0,
    label: name || 'Business account',
    // `true` / `0` is normal, not a fault. Saying so stops it being read as one.
    detail: 'This account’s prices were applied, but none of these products has a negotiated price.',
  };
}
