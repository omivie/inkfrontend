/**
 * Supplier price comparison — the vocabulary and the arithmetic.
 *
 * One question: for each product, which supplier is cheapest, and by how much?
 * The backend answers it (`/api/admin/supplier-offers/compare`). This module owns
 * everything the answer has to be qualified BY before an operator acts on it.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * Measured against production 2026-08-31, over all 172 comparable products:
 *
 *     131 rows say "switch supplier and save"
 *     130 of those 131 rest on a price list that is 193 days old
 *       1 of those 131 is backed by a price from this month
 *
 *     $293.97 total per-unit saving  =  $96.28 fresh  +  $197.69 stale
 *
 * A screen that renders one blended saving figure and sorts by it therefore
 * points the owner at a February price 130 times out of 131. The cheapest number
 * is not the answer; the cheapest number PLUS how old it is, is the answer. So
 * every total this module returns is split by freshness, and the copy that
 * describes a saving is written in one place (`perUnitCaption` / `perUnitPhrase`)
 * so the sentence "you would save $293.97" cannot be typed anywhere.
 *
 * Staleness is not a rendering flourish here. It is the primary fact.
 *
 * ── WHY THE PAGE FETCHES EVERY PAGE INSTEAD OF PAGING THE SERVER ────────────
 *
 * Four query params that a reasonable person would assume exist are DECOYS —
 * accepted, ignored, full result set returned (the ERR-151 family, measured
 * again here 2026-08-31 and re-measured on every `npm run probe:supplier-prices`
 * run). See DECOY_PARAMS below. The consequence is structural, not cosmetic:
 *
 *   - There is no server-side staleness filter, so the fresh/stale split can
 *     only be computed over the WHOLE filtered set.
 *   - `/unmatched` has no `reason=` filter, and the handoff requires the review
 *     tab to open on the ~26 actionable rows out of 345. Both `ambiguous` rows
 *     sit deep in the list, so filtering ONE server page client-side renders an
 *     empty tab — a filter that silently finds nothing is worse than no filter.
 *
 * So the page pulls every page (1 request for `multi`, 4 for `all`, 2 for
 * `unmatched`) and splits at DISPLAY, not at READ (ERR-177). The sets are small
 * enough that honesty is cheap. If the backend ever implements one of these
 * params the probe says so loudly and this can be simplified.
 *
 * ── NOTHING HERE TOUCHES THE DOM ────────────────────────────────────────────
 *
 * Pure data in, pure data out, so `node --test` exercises the real shipped code
 * rather than a re-implementation of it. The page renders; this module decides.
 *
 * Pinned by tests/admin-supplier-prices-aug2026.test.js.
 */

/** Em-dash. An absent supplier renders THIS, never `$0.00` — see supplierEntry. */
export const MISSING = '—';

/**
 * Only used when `meta.stale_after_days` is absent from a response.
 *
 * The server sends 30 today. Reading it from the response rather than from here
 * means a backend policy change lands on the page without a deploy; keeping a
 * local constant anyway means a malformed response still gets a real threshold
 * instead of `undefined`, which would make `age_days > undefined` false and mark
 * a 193-day-old price fresh.
 */
export const STALE_FALLBACK_DAYS = 30;

/**
 * Params the API accepts and IGNORES. Measured 2026-08-31; re-measured by
 * `npm run probe:supplier-prices`.
 *
 * Sending one of these is worse than not filtering at all: the request looks
 * filtered, the response looks filtered (rows come back, the page repaints), and
 * every row is wrong. The page must never put one on a URL, and a test asserts
 * that it doesn't.
 */
export const DECOY_PARAMS = Object.freeze({
  compare: Object.freeze(['supplier', 'cheapest_supplier', 'stale', 'exclude_stale', 'fresh_only']),
  unmatched: Object.freeze(['reason']),
});

/** The three tabs. `key` is the server's `coverage` value except for `review`. */
export const COVERAGE = Object.freeze({
  multi: Object.freeze({
    label: 'Compare',
    blurb: 'Products quoted by two or more suppliers.',
    empty: 'No product with two or more suppliers matches these filters.',
  }),
  single: Object.freeze({
    label: 'Single source',
    blurb: 'Only one supplier quotes these — sourcing gaps, and where to go shopping.',
    empty: 'No single-source product matches these filters.',
  }),
  all: Object.freeze({
    label: 'All',
    blurb: 'Every product with at least one matched supplier offer.',
    empty: 'No product matches these filters.',
  }),
});

/**
 * The only four sorts the server accepts. Anything else is a hard 400, so this
 * list is a contract and not a preference — sending a fifth value breaks the page.
 */
export const SORTS = Object.freeze([
  { value: 'saving_desc', label: 'Biggest saving' },
  { value: 'saving_pct_desc', label: 'Biggest saving %' },
  { value: 'cheapest_cost_asc', label: 'Cheapest cost' },
  { value: 'name_asc', label: 'Name A–Z' },
]);

/** Params the compare endpoint genuinely honours (measured). */
export const COMPARE_PARAMS = Object.freeze([
  'coverage', 'brand', 'product_type', 'search', 'min_saving', 'sort', 'include_inactive',
]);

/** Params the unmatched endpoint genuinely honours (measured). */
export const UNMATCHED_PARAMS = Object.freeze(['supplier', 'search']);

/** The reasons that need a human decision, as opposed to the ones that are noise. */
export const ACTIONABLE_REASONS = Object.freeze(['ambiguous', 'no_model_number']);

/**
 * What each `reason` means and what to do about it.
 *
 * `actionable` drives the review tab's default filter: 26 rows that need a
 * decision, rather than 345 rows of which 320 are "we don't stock that".
 */
export const REASON_META = Object.freeze({
  no_catalogue_match: Object.freeze({
    label: 'No catalogue match',
    meaning: 'Nothing in the catalogue matched this supplier line — usually something we do not stock.',
    action: 'Usually none.',
    actionable: false,
  }),
  ambiguous: Object.freeze({
    label: 'Ambiguous',
    meaning: 'It matched more than one product, so the matcher refused rather than guess. '
      + 'A wrong guess sends the buyer to the wrong cartridge.',
    action: 'Map it by hand.',
    actionable: true,
  }),
  no_model_number: Object.freeze({
    label: 'No model number',
    meaning: 'The feed row carried no model code, so there was nothing to match on.',
    action: 'Map it by hand.',
    actionable: true,
  }),
});

/**
 * Describe a reason, including one this build has never seen.
 *
 * An unrecognised reason is treated as ACTIONABLE on purpose. If the backend adds
 * a fourth reason tomorrow, the alternative is that its rows land in the "noise"
 * bucket behind a collapsed toggle and nobody ever sees them — a new category of
 * work, silently filed as ignorable. Surfacing it with an honest "this build does
 * not know what this means" is the loud failure; hiding it is the quiet one.
 */
export function reasonMeta(reason) {
  const known = REASON_META[reason];
  if (known) return known;
  return Object.freeze({
    label: String(reason || 'Unknown reason'),
    meaning: 'This build does not recognise this reason — it was added to the API after this page shipped.',
    action: 'Surfaced anyway so it is not silently ignored. Ask the backend what it means.',
    actionable: true,
    unrecognised: true,
  });
}

/** The staleness threshold this response was computed with. */
export function staleAfterDays(meta) {
  const n = Number(meta && meta.stale_after_days);
  return Number.isFinite(n) && n > 0 ? n : STALE_FALLBACK_DAYS;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Feb 26", UTC, matching the admin house date format. */
export function shortDate(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${yy}`;
}

/**
 * How old a price is, in words.
 *
 * There are already six independent "N days ago" helpers across this admin, and
 * not one of them was written with a 193-day-old price in mind — they all stop at
 * `${days}d`. This is the seventh and the last: it lives here, the page imports
 * it, and the age of a supplier price is described the same way everywhere.
 *
 * A missing age is "age unknown", never "updated today". Zero is a measurement;
 * absent is not.
 */
export function ageLabel(days, lastSeenAt) {
  // `Number(null)`, `Number('')` and `Number(false)` are all a finite 0, so a bare
  // Number.isFinite guard would call an ABSENT age "updated today" — the exact
  // unknown-becomes-zero failure this function exists to prevent, and the worst
  // possible direction for it to fail in: the least trustworthy row would render
  // as the most trustworthy one.
  if (days === null || days === undefined || days === '') return 'age unknown';
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return 'age unknown';
  const when = shortDate(lastSeenAt);
  const suffix = when ? ` (${when})` : '';
  if (n === 0) return 'updated today';
  if (n === 1) return `1 day ago${suffix}`;
  return `${n} days ago${suffix}`;
}

/**
 * This supplier's offer for this product, or null.
 *
 * `suppliers[]` is cheapest-first and its NAMES VARY PER ROW, so a fixed column
 * grid has to look each row up by name rather than by position. A supplier that
 * does not quote a product is simply absent from the array — the caller renders
 * MISSING for a null. Returning a zero-cost stand-in here would put `$0.00` in a
 * price column, which reads as "free", which is the cheapest possible price, and
 * would sort straight to the top of the page.
 */
export function supplierEntry(row, supplierName) {
  const list = (row && Array.isArray(row.suppliers)) ? row.suppliers : [];
  for (const entry of list) {
    if (entry && entry.supplier_name === supplierName) return entry;
  }
  return null;
}

/** Column order for the per-supplier grid, taken from the feed list the API sends. */
export function supplierColumns(suppliers) {
  return (Array.isArray(suppliers) ? suppliers : [])
    .map((s) => s && s.supplier_name)
    .filter((name) => typeof name === 'string' && name.length > 0);
}

/** Money comparisons are on cents; two floats a hundredth apart are the same price. */
const EPSILON = 0.005;

/**
 * What kind of answer this row is.
 *
 *   'single' — one supplier quotes it. `saving_vs_next` is 0, and that 0 means
 *              "nothing to compare against", NOT "no saving available". The two
 *              render differently or the Single-source tab is a wall of $0.00.
 *   'tie'    — two suppliers, same price. 8 of the 172 live rows. Rendering
 *              "$0.00 saving" here invites the reader to think something is broken.
 *   'stale'  — there IS a saving, and the cheapest price behind it is older than
 *              the threshold. 137 of the 172 live rows.
 *   'fresh'  — there is a saving and the cheapest price is current. 27 live rows.
 */
export function savingState(row) {
  if (!row) return 'single';
  const count = Number(row.supplier_count);
  if (!Number.isFinite(count) || count < 2) return 'single';
  const saving = Number(row.saving_vs_next);
  if (!Number.isFinite(saving) || saving <= EPSILON) return 'tie';
  return row.cheapest_is_stale ? 'stale' : 'fresh';
}

/**
 * Would acting on this row actually change who we buy from?
 *
 * Returns true / false / **null**. Null is the whole point: `current_cost_price`
 * is nullable, and a product whose current cost we do not know is not a product
 * we know we are overpaying for. Collapsing that null to `false` would quietly
 * drop it out of every "would change supplier" count; collapsing it to `true`
 * would invent an opportunity. It stays unknown and gets counted as unknown.
 */
export function switchOpportunity(row) {
  if (!row) return null;
  // `retail_price` / `current_cost_price` can be null (handoff §9), and
  // `Number(null)` is a finite 0. Testing the raw value BEFORE coercing is what
  // keeps "we hold no cost for this" from becoming "we pay nothing for this" —
  // which would report a genuine unknown as a confident "not a switch".
  if (row.current_cost_price === null || row.current_cost_price === undefined
      || row.current_cost_price === '') return null;
  if (row.cheapest_cost === null || row.cheapest_cost === undefined
      || row.cheapest_cost === '') return null;
  const current = Number(row.current_cost_price);
  const cheapest = Number(row.cheapest_cost);
  if (!Number.isFinite(current) || !Number.isFinite(cheapest)) return null;
  return cheapest < current - EPSILON;
}

/**
 * The honest replacement for one headline number.
 *
 * `meta.totals.sum_per_unit_saving` is a single figure covering both the 27 rows
 * priced this month and the 137 priced in February. This splits it, and counts
 * the switches separately, because "131 rows would change supplier" and "130 of
 * those rest on a stale price" are the two sentences that actually decide whether
 * the owner picks up the phone or places an order.
 *
 * Every total is per-unit and ignores how many of each we buy — see perUnitPhrase.
 */
export function savingSplit(rows) {
  const out = {
    freshTotal: 0, staleTotal: 0, total: 0,
    freshCount: 0, staleCount: 0, tieCount: 0, singleCount: 0,
    switchCount: 0, staleSwitchCount: 0, freshSwitchCount: 0,
    unknownCostCount: 0,
    comparedCount: 0,
  };
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const state = savingState(row);
    if (state === 'single') { out.singleCount++; continue; }
    out.comparedCount++;
    const saving = Number(row.saving_vs_next);
    const amount = Number.isFinite(saving) && saving > EPSILON ? saving : 0;
    if (state === 'tie') out.tieCount++;
    else if (state === 'stale') { out.staleCount++; out.staleTotal += amount; }
    else { out.freshCount++; out.freshTotal += amount; }

    const swap = switchOpportunity(row);
    if (swap === null) out.unknownCostCount++;
    else if (swap) {
      out.switchCount++;
      if (state === 'stale') out.staleSwitchCount++;
      else if (state === 'fresh') out.freshSwitchCount++;
    }
  }
  // Round once, at the end, so 172 float additions can't drift the printed cents.
  out.freshTotal = Math.round(out.freshTotal * 100) / 100;
  out.staleTotal = Math.round(out.staleTotal * 100) / 100;
  out.total = Math.round((out.freshTotal + out.staleTotal) * 100) / 100;
  return out;
}

/**
 * The ONLY place a saving is described in words.
 *
 * `sum_per_unit_saving` is a per-unit sum. It does not know how many of anything
 * we buy, so "you would save $293.97" is a claim the data cannot support — buy one
 * of each and you save that; buy the mix we actually buy and the number is
 * different. The phrase is centralised so that sentence has nowhere to be typed,
 * and SAVING_COPY_BANNED is what the test greps the page for.
 */
export function perUnitCaption(count, qualifier = '') {
  const n = Number(count) || 0;
  const q = String(qualifier || '').trim();
  return `potential saving per unit across ${n} product${n === 1 ? '' : 's'}${q ? ` ${q}` : ''}`;
}

/** The same sentence with the money in front of it. */
export function perUnitPhrase(amountText, count, qualifier = '') {
  return `${amountText} ${perUnitCaption(count, qualifier)}`;
}

/** Phrasings that overstate a per-unit sum as money in hand. Pinned by the test. */
export const SAVING_COPY_BANNED = /you would save|you'?ll save|you will save|total savings? of/i;

/** Unpack a compare envelope into the shape the page renders from. */
export function normalizeCompare(envelope) {
  const data = (envelope && envelope.data) || {};
  const meta = (envelope && envelope.meta) || {};
  return {
    rows: Array.isArray(data.comparisons) ? data.comparisons : [],
    suppliers: Array.isArray(data.suppliers) ? data.suppliers : [],
    pagination: meta.pagination || null,
    totals: meta.totals || null,
    staleAfterDays: staleAfterDays(meta),
  };
}

/**
 * Is the cheapest price we hold for this product a current one?
 *
 * Deliberately reads `cheapest_is_stale` rather than `savingState(row) === 'fresh'`.
 * On the Single-source tab every row is state 'single' (there is nothing to save
 * against), so a saving-based definition would filter that whole tab to zero rows
 * while the chip still read "Cheapest price is current" — a control that empties a
 * tab and leaves the operator blaming the data. Freshness is a property of the
 * PRICE, not of the saving, and it has to mean the same thing on every tab.
 */
export function cheapestIsCurrent(row) {
  return !!row && !row.cheapest_is_stale;
}

/**
 * The two client-side filters the server cannot do (see DECOY_PARAMS).
 *
 * Neither is on by default. The default view never hides a stale row, because a
 * stale cheap price is still a reason to go ask that supplier for a current list
 * (handoff §4). These are opt-in "show me only what I can act on today" controls.
 */
export function applyClientFilters(rows, { freshOnly = false, switchOnly = false } = {}) {
  let out = Array.isArray(rows) ? rows.slice() : [];
  if (freshOnly) out = out.filter(cheapestIsCurrent);
  if (switchOnly) out = out.filter((r) => switchOpportunity(r) === true);
  return out;
}

/**
 * Split the review queue into rows that need a decision and rows that do not.
 *
 * This runs over the FULL set, never over one server page. 345 rows live in the
 * queue and both `ambiguous` rows sit past the first page of 50 — filtering a
 * single page client-side would render an empty tab and read as "nothing to do".
 */
export function partitionUnmatched(rows) {
  const actionable = [];
  const noise = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    (reasonMeta(row && row.reason).actionable ? actionable : noise).push(row);
  }
  return { actionable, noise };
}

/** Count rows by reason, for the review tab's chips when the server sends no meta. */
export function countByReason(rows) {
  const out = {};
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const key = (row && row.reason) || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * Build the /map body, refusing locally what the server would refuse remotely.
 *
 * The server takes `product_sku` OR `product_id` and 400s on both. Catching that
 * here means a mis-wired picker fails at the call site with a sentence, rather
 * than as a round-tripped validation error the operator has to interpret.
 */
export function mapPayload({ supplierName, supplierSku, productSku, productId, note } = {}) {
  const name = String(supplierName || '').trim();
  const sku = String(supplierSku || '').trim();
  if (!name) throw new Error('supplier_name is required to map an offer');
  if (!sku) throw new Error('supplier_sku is required to map an offer');

  const hasSku = String(productSku || '').trim().length > 0;
  const hasId = String(productId || '').trim().length > 0;
  if (hasSku && hasId) {
    throw new Error('Send product_sku OR product_id, never both — the server answers 400.');
  }
  if (!hasSku && !hasId) {
    throw new Error('Choose a product first — a mapping needs product_sku or product_id.');
  }

  const payload = { supplier_name: name, supplier_sku: sku };
  if (hasSku) payload.product_sku = String(productSku).trim();
  else payload.product_id = String(productId).trim();

  const trimmedNote = String(note == null ? '' : note).trim();
  if (trimmedNote) payload.note = trimmedNote;
  return payload;
}

/**
 * Does this feed row's own colour contradict its supplier SKU?
 *
 * Both live `ambiguous` rows are exactly this: `BTN346M` and `BTN443M`, each
 * carrying `color: "Black"` while the SKU's trailing M reads as Magenta. That
 * contradiction is *why* the matcher refused, so putting it on screen turns an
 * unexplained "ambiguous" into a decision the operator can actually make.
 *
 * Advisory only. It never changes what is sent, and it never hides a row.
 */
const COLOUR_TAIL = { C: 'Cyan', M: 'Magenta', Y: 'Yellow', K: 'Black' };
export function colourTailConflict(offer) {
  if (!offer) return null;
  const sku = String(offer.supplier_sku || '').trim().toUpperCase();
  const stated = String(offer.color || '').trim();
  if (!sku || !stated) return null;
  const implied = COLOUR_TAIL[sku.slice(-1)];
  if (!implied) return null;
  if (implied.toLowerCase() === stated.toLowerCase()) return null;
  return { implied, stated };
}
