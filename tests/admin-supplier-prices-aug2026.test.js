/**
 * Supplier price comparison — Aug 2026 (ERR-190)
 * ==============================================
 *
 * The backend can say which supplier is cheapest. It cannot say whether that
 * answer is worth acting on, and measured against production on 2026-08-31, most
 * of the time it is not:
 *
 *     131 of 172 comparable products show a "switch supplier and save"
 *     130 of those 131 rest on a price list 193 days old
 *       1 is backed by a price from this month
 *     $293.97 total per-unit saving = $96.28 fresh + $197.69 stale
 *
 * So the failure this page is built to avoid is not a crash. It is a page that
 * works perfectly and sends the owner to a February price 130 times out of 131.
 * Almost every test below is aimed at that.
 *
 * WHAT THIS FILE PINS, in order of how badly it would hurt to lose:
 *
 *   1. AN ABSENT SUPPLIER IS AN EM-DASH, NEVER $0.00. A supplier that does not
 *      quote a product has no price. A zero would read as free, be the cheapest
 *      number on the row, and sort straight to the top of a cheapest-first page.
 *      (handoff §9; the unknown-≠-zero family, ERR-063/068/073/149.)
 *   2. THE HEADLINE IS NEVER ONE NUMBER, and never says "you would save $X". The
 *      figure is a per-unit sum that ignores how many of each we buy.
 *   3. THE REVIEW TAB FILTERS OVER THE WHOLE SET. `reason=` is a DECOY (measured:
 *      reason=ambiguous, reason=no_model_number and reason=bogus all return the
 *      identical 345 rows), and both `ambiguous` rows sit past the first page of
 *      50 — so filtering one server page would render an empty tab that reads as
 *      "nothing to do". This is the ERR-151 decoy family.
 *   4. A SHORT LIST SAYS IT IS SHORT. compareAll/unmatchedAll set complete:false
 *      and the page renders it. A failed page that quietly returns fewer rows is
 *      an outage disguised as a smaller, entirely plausible number (ERR-188).
 *   5. NO STALE ROW IS EVER HIDDEN by default — a stale cheap price is still a
 *      reason to go ask that supplier for a current list (handoff §4).
 *   6. THE POSITIVE CONTROL. A fresh, cheaper, multi-supplier row must still
 *      produce an ordinary saving. Without it this suite could pass by calling
 *      every row stale and quietly breaking the one case that matters (ERR-186:
 *      a test can pass for the wrong reason).
 *   7. NO DRIFTING VALUE IS PINNED. `age_days` was 192 in the handoff and 193 the
 *      next day; row counts move with the catalogue. Invariants only.
 *
 * The live contract is measured, not assumed: `npm run probe:supplier-prices`
 * (read-only) established all of the above against production on 2026-08-31.
 *
 * Run with: node --test tests/admin-supplier-prices-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const ADMIN = path.join(SITE, 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const pageJs = read(path.join(ADMIN, 'pages', 'supplier-prices.js'));
const utilJs = read(path.join(ADMIN, 'utils', 'supplier-offers.js'));
const apiJs = read(path.join(ADMIN, 'api.js'));
const appJs = read(path.join(ADMIN, 'app.js'));
const cssSrc = read(path.join(SITE, 'css', 'admin.css'));
const probeSrc = read(path.join(ROOT, 'scripts', 'probe-supplier-prices.mjs'));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

/** The ESM module under test, imported once and shared. */
let M;
test.before(async () => {
  M = await import('../inkcartridges/js/admin/utils/supplier-offers.js');
});

/** Body of a named function declaration, brace-matched. */
function fnBody(source, name, file = 'supplier-prices.js') {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in ${file}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Source with comments stripped — for asserting on what SHIPS, not what is explained. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Rows shaped exactly like the live payload. `age_days` is a variable here on
// purpose — pinning a literal would make this suite fail every morning.
const FRESH_DAYS = 0;
const STALE_DAYS = 193;

const rowStaleCheapest = {
  product_id: 'p1', sku: 'CCWAA0805BK', name: 'Fuji Xerox CWAA0805 Black',
  brand: 'Fuji Xerox', product_type: 'toner_cartridge', color: 'Black',
  is_active: true, retail_price: 92.49, current_cost_price: 54.55,
  supplier_count: 2, cheapest_supplier: 'Supplier2026', cheapest_cost: 31.95,
  saving_vs_next: 22.60, saving_vs_next_percent: 41.43,
  cheapest_is_stale: true, any_stale: true,
  suppliers: [
    { supplier_name: 'Supplier2026', supplier_sku: 'XCWAA0805', cost_nzd: 31.95,
      last_seen_at: '2026-02-19T03:17:04Z', age_days: STALE_DAYS, is_stale: true, match_method: 'constructed_sku' },
    { supplier_name: 'Augmento', supplier_sku: 'CCWAA0805BK', cost_nzd: 54.55,
      last_seen_at: '2026-08-30T14:23:50Z', age_days: FRESH_DAYS, is_stale: false, match_method: 'exact_sku' },
  ],
};

/** THE POSITIVE CONTROL — a real, current, actionable saving. */
const rowFreshCheapest = {
  product_id: 'p2', sku: 'CTK5244BK', name: 'Kyocera TK5244 Black',
  brand: 'Kyocera', product_type: 'toner_cartridge', color: 'Black',
  is_active: true, retail_price: 63.49, current_cost_price: 50.39,
  supplier_count: 2, cheapest_supplier: 'Augmento', cheapest_cost: 34.95,
  saving_vs_next: 15.44, saving_vs_next_percent: 30.64,
  cheapest_is_stale: false, any_stale: true,
  suppliers: [
    { supplier_name: 'Augmento', supplier_sku: 'CTK5244BK', cost_nzd: 34.95,
      last_seen_at: '2026-08-30T14:23:50Z', age_days: FRESH_DAYS, is_stale: false, match_method: 'exact_sku' },
    { supplier_name: 'Supplier2026', supplier_sku: 'KTK5244BK', cost_nzd: 50.39,
      last_seen_at: '2026-02-19T03:17:04Z', age_days: STALE_DAYS, is_stale: true, match_method: 'constructed_sku' },
  ],
};

const rowTie = {
  product_id: 'p3', sku: 'CCLI651XLM', supplier_count: 2, cheapest_supplier: 'Augmento',
  cheapest_cost: 3.50, current_cost_price: 3.50, saving_vs_next: 0, saving_vs_next_percent: 0,
  cheapest_is_stale: false,
  suppliers: [
    { supplier_name: 'Augmento', cost_nzd: 3.50, age_days: FRESH_DAYS, is_stale: false },
    { supplier_name: 'Supplier2026', cost_nzd: 3.50, age_days: STALE_DAYS, is_stale: true },
  ],
};

const rowSingle = {
  product_id: 'p4', sku: 'C81XBK', supplier_count: 1, cheapest_supplier: 'Augmento',
  cheapest_cost: 60, current_cost_price: 60, saving_vs_next: 0, saving_vs_next_percent: 0,
  cheapest_is_stale: false,
  suppliers: [{ supplier_name: 'Augmento', cost_nzd: 60, age_days: FRESH_DAYS, is_stale: false }],
};

/** A comparable row whose catalogue cost is unknown. Not "no saving" — unknown. */
const rowUnknownCost = {
  product_id: 'p5', sku: 'CUNKNOWN', supplier_count: 2, cheapest_supplier: 'Augmento',
  cheapest_cost: 10, current_cost_price: null, saving_vs_next: 5, saving_vs_next_percent: 33,
  cheapest_is_stale: false,
  suppliers: [
    { supplier_name: 'Augmento', cost_nzd: 10, age_days: FRESH_DAYS, is_stale: false },
    { supplier_name: 'Supplier2026', cost_nzd: 15, age_days: STALE_DAYS, is_stale: true },
  ],
};

// ── 1. An absent supplier is an em-dash, never a zero ───────────────────────

test('supplierEntry returns null for a supplier that does not quote the product', () => {
  assert.equal(M.supplierEntry(rowSingle, 'Supplier2026'), null,
    'a supplier absent from suppliers[] must come back as null. Returning a zero-cost '
    + 'stand-in would put $0.00 in a price column, which reads as free — the cheapest '
    + 'possible price — and sorts to the top of a cheapest-first page.');
  assert.equal(M.supplierEntry(rowSingle, 'Augmento').cost_nzd, 60,
    'a supplier that IS present must still come back');
  assert.equal(M.supplierEntry(null, 'Augmento'), null, 'a missing row must not throw');
  assert.equal(M.supplierEntry({}, 'Augmento'), null, 'a row with no suppliers[] must not throw');
});

test('the absent-supplier cell renders MISSING and never a formatted zero', () => {
  const body = fnBody(pageJs, 'renderSupplierCell');
  assert.match(body, /if \(!entry\)/,
    'the null from supplierEntry must be branched on explicitly');
  assert.match(body, /MISSING/,
    'the absent branch must render the em-dash constant');
  assert.doesNotMatch(body.slice(0, body.indexOf('const isCheapest')), /money\(/,
    'the absent branch must not run a value through money() — money(0) is "$0.00", '
    + 'and a product nobody quotes is not a product that costs nothing');
});

test('the CSV export writes a blank, not a 0, for a supplier with no offer', () => {
  const body = fnBody(pageJs, 'exportCsv');
  assert.match(body, /cells\.push\(e \? e\.cost_nzd : '', e \? e\.age_days : ''\)/,
    'a spreadsheet will happily average a fabricated zero into a supplier cost. '
    + 'An absent offer must export as an empty cell.');
});

test('the drawer says "same" rather than printing the page\'s only $0.00', () => {
  // A supplier quoting exactly what we already pay is the one legitimate zero on
  // this page. Rendered as "$0.00" it is indistinguishable at a glance from the
  // absent and unknown cases every other cell renders as an em-dash — so it says
  // what it means instead. Spotted in a real browser, on the top live row.
  const body = fnBody(pageJs, 'vsCurrentLabel');
  assert.match(body, /if \(delta == null\) return MISSING;/,
    'an unknown difference is still an em-dash — "same" is only for a measured zero');
  assert.match(body, /Math\.abs\(delta\) < 0\.005/,
    'compare on cents; two floats a hundredth apart are the same price');
  assert.match(body, /return 'same'/);
  assert.match(body, /delta > 0 \? '\+' : ''/,
    'a dearer supplier must carry an explicit + so the sign is never ambiguous');
});

test('money() renders an explicit em-dash for null — formatPrice(null) returns an empty string', () => {
  assert.match(pageJs, /const money = \(v\) =>[\s\S]{0,160}MISSING/,
    'window.formatPrice(null) returns "" — an invisible field. Every money cell on this '
    + 'page goes through money() so an unknown reads as "—" rather than as blank space '
    + 'the eye skips over.');
});

// ── 2. The headline is split, and never overstates a per-unit sum ───────────

test('savingSplit keeps fresh and stale apart and never merges them into one figure', () => {
  const split = M.savingSplit([rowStaleCheapest, rowFreshCheapest, rowTie, rowSingle]);
  assert.equal(split.freshTotal, 15.44, 'the fresh saving is the Kyocera row alone');
  assert.equal(split.staleTotal, 22.60, 'the stale saving is the Fuji Xerox row alone');
  assert.equal(split.total, 38.04, 'total is available, but only as fresh + stale');
  assert.equal(split.freshCount, 1);
  assert.equal(split.staleCount, 1);
  assert.equal(split.tieCount, 1, 'a same-price row is a tie, not a zero saving');
  assert.equal(split.singleCount, 1, 'a single-source row is excluded from the comparison counts');
  assert.equal(split.comparedCount, 3, 'three of the four rows had something to compare');
});

test('POSITIVE CONTROL — a fresh, cheaper, multi-supplier row still produces a normal saving', () => {
  // Without this, the suite could pass by classifying everything as stale or as a
  // tie, and the one row on the live page that is actually actionable would break
  // silently. ERR-186: a test can pass for the wrong reason.
  assert.equal(M.savingState(rowFreshCheapest), 'fresh',
    'a row whose cheapest price is current must be state "fresh"');
  assert.equal(M.switchOpportunity(rowFreshCheapest), true,
    '34.95 beats the 50.39 the catalogue holds, so this row would change supplier');
  const split = M.savingSplit([rowFreshCheapest]);
  assert.equal(split.freshTotal, 15.44, 'its saving must land in the fresh bucket, at full value');
  assert.equal(split.staleTotal, 0, 'and nothing must leak into the stale bucket');
  assert.equal(split.freshSwitchCount, 1);
  assert.equal(split.staleSwitchCount, 0);
});

test('savingState separates "nothing to compare" from "no saving available"', () => {
  assert.equal(M.savingState(rowSingle), 'single',
    'saving_vs_next is 0 on a single-source row, but that 0 means "nothing to compare '
    + 'against", not "no saving". Collapsing them makes the Single-source tab a wall of $0.00.');
  assert.equal(M.savingState(rowTie), 'tie',
    'two suppliers at the same price is a tie — rendering "$0.00 saving" invites the '
    + 'reader to think something is broken');
  assert.equal(M.savingState(rowStaleCheapest), 'stale');
  assert.equal(M.savingState(null), 'single', 'a missing row must not throw');
});

test('switchOpportunity returns null — not false — when the catalogue holds no cost', () => {
  assert.equal(M.switchOpportunity(rowUnknownCost), null,
    'a product whose current cost we do not know is not a product we know we are '
    + 'overpaying for. Collapsing that null to false would drop it out of every '
    + '"would change supplier" count with no trace.');
  const split = M.savingSplit([rowUnknownCost]);
  assert.equal(split.unknownCostCount, 1, 'it must be counted as unknown, not ignored');
  assert.equal(split.switchCount, 0, 'and never counted as a switch');
});

test('the saving copy always says "per unit", and never claims money in hand', () => {
  assert.match(M.perUnitCaption(35), /per unit/,
    'the qualifier is the whole reason the figure is honest — it ignores how many of each we buy');
  assert.match(M.perUnitCaption(1), /across 1 product\b/, 'singular must not read "1 products"');
  assert.match(M.perUnitCaption(35), /across 35 products/);
  assert.match(M.perUnitPhrase('$96.28', 35), /^\$96\.28 potential saving per unit/);
  assert.match(M.perUnitCaption(3, 'whose cheapest price is current'),
    /across 3 products whose cheapest price is current$/);
});

test('no source file claims "you would save" — the banned phrasing', () => {
  for (const [name, src] of [['supplier-prices.js', pageJs], ['supplier-offers.js', utilJs]]) {
    // Read the CODE, not the comments: both module headers quote the banned
    // sentence in order to forbid it, and a guard tripped by its own explanation
    // teaches the next person to delete the explanation.
    const code = codeOnly(src).replace(/export const SAVING_COPY_BANNED[^\n]*\n/, '');
    const hit = code.match(/you would save|you'?ll save|you will save|total savings? of/i);
    assert.equal(hit, null,
      `${name} SHIPS the string "${hit && hit[0]}" "${hit && hit[0]}" in live code. meta.totals.sum_per_unit_saving is a PER-UNIT sum: `
      + 'buy one of each and you save that, buy the mix we actually buy and the number is '
      + 'different. Stating it as money in hand is a claim the data cannot support (handoff §4).');
  }
});

test('the honesty panel composes its captions through perUnitCaption', () => {
  const body = fnBody(pageJs, 'renderHonesty');
  const uses = body.match(/perUnitCaption\(/g) || [];
  assert.ok(uses.length >= 2,
    'both the fresh and the stale caption must come from the shared function, or a later '
    + 'edit can drop "per unit" from one of them and only one figure stays honest');
  assert.match(body, /savingSplit\(_filtered\)/,
    'the split must be computed over the FILTERED set the operator is looking at, not over '
    + 'the unfiltered fetch — otherwise the headline describes rows that are not on screen');
});

test('the stale figure is rendered whenever there are stale rows, beside the fresh one', () => {
  const body = fnBody(pageJs, 'renderHonesty');
  assert.match(body, /admin-sp-honesty__figure--fresh/);
  assert.match(body, /admin-sp-honesty__figure--stale/);
  assert.match(body, /if \(split\.staleCount\)/,
    'the stale figure appears whenever stale rows exist — it is never conditional on a '
    + 'user preference, because hiding it is how the page would become misleading again');
});

// ── 3. The review tab partitions the WHOLE set, and never sends reason= ─────

test('reason= is recorded as a decoy and is never sent', () => {
  assert.ok(M.DECOY_PARAMS.unmatched.includes('reason'),
    'reason=ambiguous, reason=no_model_number and reason=bogus all return the identical '
    + '345 rows (measured 2026-08-31). It must be documented as a decoy.');
  assert.doesNotMatch(pageJs, /reason:\s*|['"]reason['"]\s*,/,
    'the page must never put reason= on a request — a filtered-looking response with '
    + 'every row in it is worse than no filter (ERR-151)');
  const un = apiJs.slice(apiJs.indexOf('async unmatchedAll'), apiJs.indexOf('async map('));
  assert.match(un, /this\._query\(params, \['supplier', 'search'\]\)/,
    'unmatchedAll must whitelist only the two params the server honours; a passthrough '
    + 'would let reason= reach the URL the first time a caller passed it');
});

test('partitionUnmatched keeps the two actionable reasons and buckets the rest', () => {
  const rows = [
    { offer_id: 'a', reason: 'ambiguous' },
    { offer_id: 'b', reason: 'no_model_number' },
    { offer_id: 'c', reason: 'no_catalogue_match' },
  ];
  const { actionable, noise } = M.partitionUnmatched(rows);
  assert.deepEqual(actionable.map((r) => r.offer_id), ['a', 'b'],
    'ambiguous and no_model_number are the ~25 rows that need a decision out of 345');
  assert.deepEqual(noise.map((r) => r.offer_id), ['c'],
    'no_catalogue_match is usually something we do not stock');
});

test('an unrecognised reason is surfaced as ACTIONABLE, not filed as noise', () => {
  const meta = M.reasonMeta('some_new_reason_the_backend_added');
  assert.equal(meta.actionable, true,
    'if the backend adds a fourth reason, the alternative is that its rows land behind a '
    + 'collapsed "show all" toggle and nobody ever sees them — a new category of work, '
    + 'silently filed as ignorable. Surfacing it is the loud failure; hiding it is the quiet one.');
  assert.equal(meta.unrecognised, true, 'and it must be flagged as unrecognised, not dressed up as known');
  assert.match(meta.meaning, /does not recognise/i, 'the label must admit what it does not know');
  const { actionable } = M.partitionUnmatched([{ reason: 'brand_new_reason' }]);
  assert.equal(actionable.length, 1, 'and the partition must follow that classification');
});

test('the review tab fetches every page before partitioning', () => {
  const body = fnBody(pageJs, 'loadReview');
  assert.match(body, /AdminAPI\.supplierOffers\.unmatchedAll/,
    'the queue is 345 rows and both `ambiguous` rows sit past the first page of 50. '
    + 'Partitioning one server page would render an EMPTY review tab, which reads as '
    + '"nothing to do" — a filter that silently finds nothing.');
  assert.doesNotMatch(body, /limit:\s*50|page:\s*\d/,
    'loadReview must not ask for a single page');
  const partition = fnBody(pageJs, 'reviewSets');
  assert.match(partition, /partitionUnmatched\(_reviewRows\)/,
    'the partition runs over the full set held in memory');
});

test('a background review load never paints over the Compare table', () => {
  // The Compare tab loads the review queue in the background purely to fill the
  // tab's count badge, and BOTH views render into #sp-table. Without this guard
  // the count fetch replaced the entire comparison table with the review queue —
  // the table simply vanished, with no error anywhere. Caught in a real browser.
  const render = fnBody(pageJs, 'renderReview');
  assert.match(render, /if \(_tab !== 'review'\) return;/,
    'renderReview must refuse to paint unless the review tab owns #sp-table');
  const load = fnBody(pageJs, 'loadReview');
  assert.match(load, /if \(_tab === 'review'\) \{[\s\S]{0,200}admin-loader/,
    'and the loading spinner it writes into that same element must be gated too');
  assert.match(load, /renderTabCounts\(\);[\s\S]{0,120}if \(_tab === 'review'\)/,
    'the count badge must still update from a background load — that is what the '
    + 'background load is FOR; it is only the table paint that must be withheld');
  const reload = fnBody(pageJs, 'reload');
  assert.match(reload, /loadReview\(\)/,
    'the Compare tab must still prefetch the queue, or the badge reads empty until you click it');
});

test('the review tab defaults to the actionable rows and offers the rest behind a toggle', () => {
  assert.match(pageJs, /let _reviewShowAll = false;/,
    'defaulting to all 345 rows buries the ~25 that need a decision');
  const body = fnBody(pageJs, 'reviewSets');
  assert.match(body, /_reviewShowAll \? _reviewRows : actionable/,
    'the toggle widens the view; it is never the default');
  const render = fnBody(pageJs, 'renderReview');
  assert.match(render, /sp-review-all/, 'the toggle must exist — the hidden rows are still real rows');
  assert.match(render, /noise\.length/,
    'the intro must say how many rows are hidden, by number. "Some rows are hidden" is '
    + 'not a disclosure.');
});

test('by_reason is preferred over a local count, because it is server-computed', () => {
  const render = fnBody(pageJs, 'renderReview');
  assert.match(render, /_reviewMeta && _reviewMeta\.by_reason\) \|\| countByReason\(_reviewRows\)/,
    'by_reason respects supplier= and search= (measured), so it is the trustworthy count; '
    + 'the local fallback only covers a response that omits meta');
});

// ── 4. A short list must say it is short ───────────────────────────────────

test('compareAll reports an incomplete walk instead of returning a short list quietly', () => {
  const block = apiJs.slice(apiJs.indexOf('async compareAll'), apiJs.indexOf('async unmatchedAll'));
  assert.match(block, /complete = false;/,
    'a page that fails must flip complete to false');
  assert.match(block, /if \(complete && expected !== null && rows\.length !== expected\) complete = false;/,
    "the server's own pagination total is the check on our walk. Without it, holding 40 of "
    + '172 rows with no request having thrown would still report complete — and every total '
    + 'on the page would be a plausible, wrong, smaller number (ERR-188).');
  assert.match(block, /MAX_PAGES/, 'the walk must be bounded');
});

test('the page renders the incomplete state rather than swallowing it', () => {
  const body = fnBody(pageJs, 'renderIncompleteNote');
  assert.match(body, /_reviewComplete[\s\S]*_complete/,
    'both tabs must be covered — a partial review queue is as misleading as a partial table');
  assert.match(body, /floor, not a figure/,
    'the note must say what the numbers now mean, not merely that something went wrong');
  assert.match(pageJs, /renderIncompleteNote\(\)/,
    'and it must actually be called on load');
});

test('a superseded load never paints over a newer one', () => {
  const body = fnBody(pageJs, 'loadCompare');
  assert.match(body, /const myGen = \+\+_gen;/, 'each load claims a generation');
  assert.match(body, /if \(myGen !== _gen \|\| !_alive\) return;/,
    'a multi-page walk can outlive the filter that started it. Without this guard, an old '
    + "result repaints on top of the new filter's rows.");
  assert.match(body, /isStale: \(\) => myGen !== _gen \|\| !_alive/,
    'and the walk must stop issuing further requests once superseded');
});

test('the API layer does not offer an AbortSignal it cannot honour', () => {
  const block = apiJs.slice(apiJs.indexOf('supplierOffers: {'), apiJs.indexOf('// ---- Financial Health Analytics'));
  assert.doesNotMatch(codeOnly(block), /\bsignal\b/,
    'API.request() overwrites a caller\'s signal with its own timeout controller '
    + '(js/api.js — `fetch(url, { ...fetchOptions, signal: controller.signal })`), so a '
    + '`signal` option here would be an off switch: it would look like cancellation and do '
    + 'nothing. The between-pages isStale() predicate is what actually works. (ERR-167.)');
  assert.match(block, /isStale/, 'the honest mechanism must be there instead');
});

// ── 5. No stale row is ever hidden by default ──────────────────────────────

test('the default view hides nothing — both client filters are opt-in', () => {
  assert.match(pageJs, /let _freshOnly = false;/,
    'a stale cheap price is still a reason to go ask that supplier for a current list '
    + '(handoff §4: "Do not hide stale rows"). Hiding them by default would remove the '
    + 'page\'s single most useful signal.');
  assert.match(pageJs, /let _switchOnly = false;/);
  const reset = fnBody(pageJs, 'resetState');
  assert.match(reset, /_freshOnly = false; _switchOnly = false;/,
    'and a fresh visit must not inherit a filter from a previous one');
});

test('the freshness filter is a property of the PRICE, so it works on every tab', () => {
  assert.equal(M.cheapestIsCurrent(rowSingle), true,
    'a single-source row with a current price IS current. Defining freshness as '
    + 'savingState === "fresh" would make every row on the Single-source tab fail this '
    + 'filter, emptying the whole tab while the chip still read "Cheapest price is current".');
  assert.equal(M.cheapestIsCurrent(rowStaleCheapest), false);
  const kept = M.applyClientFilters([rowSingle, rowStaleCheapest], { freshOnly: true });
  assert.deepEqual(kept.map((r) => r.sku), ['C81XBK']);
});

test('applyClientFilters composes and never mutates its input', () => {
  const rows = [rowFreshCheapest, rowStaleCheapest, rowSingle, rowTie];
  const both = M.applyClientFilters(rows, { freshOnly: true, switchOnly: true });
  assert.deepEqual(both.map((r) => r.sku), ['CTK5244BK'],
    'only the fresh row that also beats our current cost survives both filters');
  assert.equal(rows.length, 4, 'the caller\'s array must be untouched');
  assert.deepEqual(M.applyClientFilters(rows).map((r) => r.sku),
    ['CTK5244BK', 'CCWAA0805BK', 'C81XBK', 'CCLI651XLM'],
    'with no options, every row passes through in order — the server\'s sort must survive');
});

test('an empty result names the client-side chip that caused it', () => {
  const body = fnBody(pageJs, 'emptyMessage');
  assert.match(body, /_freshOnly/);
  assert.match(body, /_switchOnly/);
  assert.match(body, /turn/,
    'these two chips are the only filters NOT in the URL the server saw, so "no results" '
    + 'is otherwise unattributable — the operator cannot tell a real empty set from a chip '
    + 'they forgot was on');
});

// ── 6. Staleness is stated in words, everywhere, from one function ──────────

test('ageLabel says how old a price is, at any age', () => {
  assert.equal(M.ageLabel(0, null), 'updated today');
  assert.equal(M.ageLabel(1, null), '1 day ago', 'singular must not read "1 days ago"');
  assert.equal(M.ageLabel(3, null), '3 days ago');
  assert.equal(M.ageLabel(STALE_DAYS, '2026-02-19T03:17:04Z'), `${STALE_DAYS} days ago (19 Feb 26)`,
    'the six existing "N days ago" helpers in this admin all stop at days with no date. '
    + 'A 193-day-old price needs the date beside it, or "193 days ago" is arithmetic the '
    + 'reader has to do to know it means February.');
});

test('a missing age is "unknown", never "today"', () => {
  assert.equal(M.ageLabel(null, null), 'age unknown',
    'zero is a measurement; absent is not. Rendering an unknown age as "updated today" '
    + 'would make the least trustworthy row look like the most trustworthy one.');
  assert.equal(M.ageLabel(undefined, null), 'age unknown');
  assert.equal(M.ageLabel('', null), 'age unknown', 'an empty string must not coerce to 0');
  assert.equal(M.ageLabel(-5, null), 'age unknown', 'a negative age is not a fresh price');
});

test('shortDate is UTC and stable regardless of the machine running it', () => {
  assert.equal(M.shortDate('2026-02-19T03:17:04Z'), '19 Feb 26');
  assert.equal(M.shortDate('2026-08-30T14:23:50.459+00:00'), '30 Aug 26');
  assert.equal(M.shortDate(null), '', 'a missing date must render nothing, not "Invalid Date"');
  assert.equal(M.shortDate('not-a-date'), '');
});

test('every supplier price cell carries its age', () => {
  const body = fnBody(pageJs, 'renderSupplierCell');
  assert.match(body, /ageLabel\(entry\.age_days, entry\.last_seen_at\)/,
    'the age goes IN the cell, not in a tooltip. A price and the date it was quoted are '
    + 'one fact; separating them is what lets a February price read as a current one.');
  assert.match(body, /admin-sp-cell--stale/, 'and a stale price must be visually marked');
});

test('a stale-cheapest row is marked in the row itself, not only in the header', () => {
  const body = fnBody(pageJs, 'renderSavingCell');
  assert.match(body, /state === 'stale'/);
  assert.match(body, /admin-sp-saving__warn/,
    'the headline split tells you 130 of 131 savings are stale; the row has to tell you '
    + 'WHICH, or the reader still cannot act');
  assert.match(body, /confirm it before ordering/i,
    'and it must say what to do about it');
});

test('the drawer verdict is different prose for a stale saving than for a fresh one', () => {
  const body = fnBody(pageJs, 'verdictFor');
  assert.match(body, /tone: 'warn'/, 'a stale saving is a caution');
  assert.match(body, /tone: 'good'/, 'a fresh saving is not');
  assert.match(body, /not a reason to buy/,
    'the stale verdict must name the action: ask the supplier for a current list, do not order');
  assert.match(body, /Confirm it with them before ordering/,
    'and say so before the saving figure has a chance to look like permission');
});

test('staleAfterDays reads the response and only falls back when it must', () => {
  assert.equal(M.staleAfterDays({ stale_after_days: 45 }), 45,
    'a backend policy change must land on the page without a deploy');
  assert.equal(M.staleAfterDays({}), M.STALE_FALLBACK_DAYS);
  assert.equal(M.staleAfterDays(null), M.STALE_FALLBACK_DAYS,
    'a malformed response must still get a real threshold — `age_days > undefined` is '
    + 'false, which would silently mark a 193-day-old price fresh');
  assert.equal(M.staleAfterDays({ stale_after_days: 0 }), M.STALE_FALLBACK_DAYS);
});

// ── 7. Mapping: local refusal, permanence stated, undo is honest ───────────

test('mapPayload refuses locally exactly what the server refuses with a 400', () => {
  assert.throws(() => M.mapPayload({
    supplierName: 'S', supplierSku: 'X', productSku: 'A', productId: 'B',
  }), /never both/i, 'sending both ids is a 400 — catching it here fails at the call site with a sentence');
  assert.throws(() => M.mapPayload({ supplierName: 'S', supplierSku: 'X' }),
    /Choose a product/i, 'sending neither is also a 400');
  assert.throws(() => M.mapPayload({ supplierSku: 'X', productSku: 'A' }), /supplier_name/);
  assert.throws(() => M.mapPayload({ supplierName: 'S', productSku: 'A' }), /supplier_sku/);
});

test('mapPayload builds exactly the documented body', () => {
  assert.deepEqual(
    M.mapPayload({ supplierName: 'Supplier2026', supplierSku: 'BTN237M', productSku: 'CTN237M', note: '  M tail  ' }),
    { supplier_name: 'Supplier2026', supplier_sku: 'BTN237M', product_sku: 'CTN237M', note: 'M tail' });
  assert.deepEqual(
    M.mapPayload({ supplierName: 'S', supplierSku: 'X', productId: 'uuid-1' }),
    { supplier_name: 'S', supplier_sku: 'X', product_id: 'uuid-1' },
    'an empty note must be omitted entirely, not sent as ""');
});

test('the map modal states that the mapping is permanent', () => {
  const body = fnBody(pageJs, 'openMapModal');
  assert.match(body, /permanent/i,
    'the mapping applies immediately and is re-applied on every future import. An operator '
    + 'pinning a wrong SKU has no list to undo it from — they must know that before they click.');
  assert.match(body, /remembered forever/i,
    'and the upside must be stated too — it is the payoff for the manual effort (handoff §7)');
});

test('typing after choosing a product invalidates the choice', () => {
  const body = fnBody(pageJs, 'openMapModal');
  assert.match(body, /chosen = null;[\s\S]{0,200}saveBtn\.disabled = true;/,
    'without this the label keeps naming a product the box no longer shows, and the '
    + 'operator pins a SKU they did not mean — permanently');
});

test('undo is offered once, and the page never implies a mapping history it cannot load', () => {
  const body = fnBody(pageJs, 'toastWithUndo');
  assert.match(body, /only chance|only moment/i,
    'GET /map, /mappings, /maps and /map/list are ALL 404 (measured 2026-08-31), so the id '
    + 'returned by the POST is the only one the front-end can ever hold');
  assert.match(body, /unmap\(mappingId\)/);
  // Check the CODE, not the comments: the module header says in as many words that
  // no endpoint lists existing mappings, and that sentence must not trip its own guard.
  assert.doesNotMatch(codeOnly(pageJs), /mapping history|view mappings|all mappings/i,
    'the UI must not offer a mappings list it has no endpoint for');
});

test('a successful map refreshes both tabs', () => {
  const body = fnBody(pageJs, 'refreshAll');
  assert.match(body, /loadReview\(\)/);
  assert.match(body, /loadCompare\(\)/,
    'a map changes BOTH: the line leaves the review queue AND the product gains a supplier. '
    + 'Refetching one would leave the other lying.');
});

test('the portalled autocomplete menu is destroyed with the modal', () => {
  assert.match(pageJs, /_acHandles\.push\(handle\)/,
    'attachAutocomplete portals its menu to <body>, so it outlives the modal that made it '
    + '(ERR-107/ERR-179) — every handle must be registered');
  const destroy = fnBody(pageJs, 'destroyAutocompletes');
  assert.match(destroy, /handle\.destroy/);
  assert.match(pageJs, /onClose: destroyAutocompletes/,
    'closing the modal by any route — button, backdrop, Escape — must drain them');
  const teardown = pageJs.slice(pageJs.indexOf('  destroy() {'));
  assert.match(teardown, /destroyAutocompletes\(\)/, 'and leaving the page must too');
});

// ── 8. Supplier columns are built from the data, never a hardcoded pair ─────

test('supplier columns come from the feed list, so a third supplier just appears', () => {
  assert.deepEqual(M.supplierColumns([
    { supplier_name: 'Augmento' }, { supplier_name: 'Supplier2026' }, { supplier_name: 'Third' },
  ]), ['Augmento', 'Supplier2026', 'Third'],
    'only two suppliers exist today and the handoff is explicit that a third is expected '
    + '(§5). A two-element assumption anywhere here would drop the third feed silently.');
  assert.deepEqual(M.supplierColumns(null), [], 'a missing list must not throw');
  assert.deepEqual(M.supplierColumns([{}, { supplier_name: '' }]), [],
    'an unnamed supplier cannot become a column with a blank header');
});

test('each row looks its supplier up BY NAME, not by position', () => {
  const body = fnBody(pageJs, 'buildColumns');
  assert.match(body, /for \(const name of supplierColumns\(_suppliers\)\)/,
    'columns are generated from the feed list');
  assert.match(body, /renderSupplierCell\(r, name\)/,
    'suppliers[] on a row is sorted CHEAPEST FIRST and its names vary per row, so indexing '
    + 'into it by column position would print one supplier\'s price under another\'s heading '
    + '(handoff §3)');
  assert.doesNotMatch(body, /suppliers\[0\]|suppliers\[1\]/,
    'never index the per-row supplier array positionally');
});

// ── 9. Decoys are documented, and the page never sends one ─────────────────

test('every measured decoy is recorded', () => {
  for (const p of ['supplier', 'cheapest_supplier', 'stale', 'exclude_stale', 'fresh_only']) {
    assert.ok(M.DECOY_PARAMS.compare.includes(p), `${p} must be listed as a compare decoy`);
  }
  assert.ok(Object.isFrozen(M.DECOY_PARAMS), 'the record must not be mutable at runtime');
});

test('compareAll whitelists the params the server honours instead of passing everything through', () => {
  const block = apiJs.slice(apiJs.indexOf('async compareAll'), apiJs.indexOf('async unmatchedAll'));
  assert.match(block, /'coverage', 'brand', 'product_type', 'search', 'min_saving', 'sort', 'include_inactive'/,
    'a whitelist is what stops a decoy reaching the URL the first time somebody passes one. '
    + 'A passthrough would make a filtered-looking request that filters nothing.');
  for (const decoy of ['fresh_only', 'exclude_stale']) {
    assert.ok(!block.includes(`'${decoy}'`), `${decoy} must not be in the whitelist`);
  }
});

test('min_saving is not sent on the single-source tab, where it empties the tab', () => {
  const body = fnBody(pageJs, 'serverParams');
  assert.match(body, /_minSaving && _tab === 'multi'/,
    'every single-source row has a saving of 0, so ANY positive min_saving returns zero rows '
    + '(measured: min_saving=5&coverage=single → 0). A control that silently empties a tab '
    + 'is worse than one that is not offered.');
  const filters = fnBody(pageJs, 'renderFilters');
  assert.match(filters, /_tab === 'multi' \? `<input[^`]*id="sp-min-saving"/,
    'and the input must not be rendered there either');
});

// ── 10. Export and scope ───────────────────────────────────────────────────

test('the CSV exports the whole filtered set, never the visible page', () => {
  const body = fnBody(pageJs, 'exportCsv');
  assert.match(body, /_tab === 'review' \? reviewSets\(\)\.shown : _filtered/,
    'the table is paged client-side at 50; exporting the visible slice would hand the owner '
    + 'page 1 of 4 labelled as the answer');
  assert.doesNotMatch(body, /\.slice\(start/, 'never export a page slice');
  assert.match(body, /Cheapest price is stale/,
    'the export must carry the staleness flag — a spreadsheet of prices with no ages is '
    + 'exactly the artefact this page exists to replace');
  assert.match(body, /price age \(days\)/, 'and each price must export with its age');
});

test('the page states the scope limit — this is not the whole catalogue', () => {
  const body = fnBody(pageJs, 'renderShell');
  assert.match(body, /admin-sp-scope/);
  assert.match(body, /genuine/i,
    'roughly three quarters of the active catalogue is genuine stock from a single supplier '
    + '(DSNZ) and can never appear here. A page that implies whole-catalogue coverage would '
    + 'be read as "we only have 610 products" (handoff §5).');
  assert.match(body, /Compatible products only/i);
});

test('the import panel offers no button, and says why', () => {
  const body = fnBody(pageJs, 'renderShell');
  assert.match(body, /CRON_SECRET/,
    'POST /api/admin/feed-files/product-list AND POST /api/admin/import/supplier-price-list '
    + 'both answer 403 "Cron endpoints require CRON_SECRET in production" to a live owner '
    + 'token (measured 2026-08-31). Two buttons that 403 the first time the owner trusted '
    + 'them would be worse than none.');
  assert.match(body, /Neither step can be run from this page/i);
  assert.doesNotMatch(body, /admin-dropzone|type="file"/,
    'no upload control may be rendered while the route is cron-gated');
  assert.doesNotMatch(pageJs, /feed-files\/product-list['"`]\s*,|triggerImport|uploadPriceList/,
    'and no code path may call the gated endpoints');
});

test('the freshness strip is built from the data and survives an empty result', () => {
  const body = fnBody(pageJs, 'renderFreshness');
  assert.match(body, /_suppliers\.map/, 'one pill per supplier in the feed list');
  assert.match(body, /if \(!_suppliers\.length\)/,
    'and an honest empty state — measured, data.suppliers[] stays populated even when '
    + 'comparisons is empty, so a blank strip means something else went wrong');
  assert.match(body, /ageLabel\(s\.age_days, s\.last_seen_at\)/);
  const load = fnBody(pageJs, 'loadCompare');
  assert.doesNotMatch(load, /_suppliers = \[\]/,
    'a later page of the walk must not blank a supplier list an earlier page already filled');
});

// ── 11. Wiring, teardown, and the meta-tests ───────────────────────────────

test('NAV_ITEMS carries an owner-only supplier-prices entry', () => {
  assert.match(appJs, /key: 'supplier-prices'[^}]*ownerOnly: true/,
    'the router derives its gate from NAV_ITEMS via isOwnerOnlyRoute() — without ownerOnly '
    + 'a direct #supplier-prices would load supplier cost for any admin');
  assert.match(appJs, /key: 'supplier-prices', label: 'Supplier Prices', icon: 'suppliers'/,
    'the `suppliers` icon already exists in the registry — no new icon was added');
});

test('the page gates itself as well as trusting the router', () => {
  const init = pageJs.slice(pageJs.indexOf('  async init(container) {'), pageJs.indexOf('  destroy() {'));
  assert.match(init, /if \(!AdminAuth\.isOwner\(\)\)/,
    'every owner page repeats the check, so a future routing change cannot expose supplier '
    + 'cost to a plain admin');
  assert.match(init, /Access Restricted/);
});

test('the page module exports the lifecycle the router calls', () => {
  assert.match(pageJs, /export default \{/);
  assert.match(pageJs, /title: 'Supplier Prices'/);
  assert.match(pageJs, /async init\(container\) \{/);
  assert.match(pageJs, /destroy\(\) \{/);
  const init = pageJs.slice(pageJs.indexOf('  async init(container) {'));
  assert.match(init, /resetState\(\);/,
    'page modules are singletons — every module-scoped let must be reset or a second visit '
    + 'inherits the first visit\'s filters');
});

test('destroy tears down everything that outlives the container', () => {
  const teardown = pageJs.slice(pageJs.indexOf('  destroy() {'));
  assert.match(teardown, /clearTimeout\(_searchDebounce\)/,
    'a keystroke landing 300ms after the operator navigates away would fetch against a dead table');
  assert.match(teardown, /_gen\+\+/, 'and bump the generation so an in-flight walk cannot paint');
  assert.match(teardown, /removeEventListener\('click', _delegated\)/);
  assert.match(teardown, /_table\.destroy\(\)/, 'DataTable adds a document-level keydown listener');
  assert.match(teardown, /Drawer\.close\(\)/);
  assert.match(teardown, /destroyAutocompletes\(\)/);
});

test('admin.css carries EVERY class the page emits, not just the prefixed ones', () => {
  // This originally scanned only `admin-sp-*` and therefore passed while both
  // filter chips rendered as bare unstyled text: they carry `.filter-chip`, which
  // had never been defined in the stylesheet at all — pages/price-monitor.js has
  // been shipping the same two invisible chips since it launched. A prefix-scoped
  // check only ever guards the classes you remembered to prefix, so this reads
  // every class attribute in the file.
  const emitted = new Set();
  for (const attr of pageJs.matchAll(/class="([^"]*)"/g)) {
    // Drop `${...}` template expressions, then take the literal tokens around them.
    for (const token of attr[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (/^[a-z][a-z0-9_-]*$/.test(token)) emitted.add(token);
    }
  }
  assert.ok(emitted.size > 30, `expected a real class list; found ${emitted.size}`);
  const missing = [...emitted].filter((cls) => !cssSrc.includes(`.${cls}`)).sort();
  assert.deepEqual(missing, [],
    `admin.css is missing: ${missing.join(', ')} — an unstyled class renders as unformatted `
    + 'text that still looks deliberate, which is why it survives review');
});

test('.admin-page-title and .admin-page-subtitle are defined', () => {
  // Found by the broadened class sweep above. Six admin pages emit the title
  // class and three emit the subtitle class, and neither selector existed: the
  // h1 looked right by accident (`.admin-page-header h1` styles it by element)
  // while every subtitle rendered as a full-size unstyled paragraph.
  assert.match(cssSrc, /^\.admin-page-title \{/m);
  assert.match(cssSrc, /^\.admin-page-subtitle \{/m);
  assert.match(cssSrc, /\.admin-page-title \{\s*\n\s*font-size: 22px; font-weight: 700; margin: 0;/,
    'the title rules must match .admin-page-header h1 exactly, so defining the class is a '
    + 'no-op for the six pages already using it rather than a restyle they did not ask for');
});

test('.filter-chip is defined, and both active conventions work', () => {
  assert.match(cssSrc, /^\.filter-chip \{/m,
    'price-monitor.js and supplier-prices.js both emit it; until now neither had any styling');
  assert.match(cssSrc, /\.filter-chip\.active,\s*\n\.filter-chip--active \{/,
    'price-monitor toggles `filter-chip--active` and supplier-prices toggles `active`. '
    + 'Supporting both is a two-line selector; renaming one page\'s convention would be a '
    + 'behaviour change to a page this work was not asked to touch.');
});

test('the page reuses the shared admin primitives instead of reinventing them', () => {
  for (const cls of ['admin-page-header', 'admin-tabs', 'admin-search', 'admin-empty',
    'admin-loader', 'admin-pagination', 'admin-btn', 'admin-form-group']) {
    assert.ok(pageJs.includes(cls), `the page should use the existing ${cls}`);
    assert.ok(cssSrc.includes(`.${cls}`), `${cls} must already exist in admin.css`);
  }
});

test('probe:supplier-prices is registered', () => {
  assert.equal(pkg.scripts['probe:supplier-prices'], 'node scripts/probe-supplier-prices.mjs');
});

test('the probe has no write path at all', () => {
  // A probe that can record is a probe that can pass because it just overwrote
  // what it was comparing against (sweep:b2b ate a committed fixture, 2026-08-12).
  // Scope the flag check to the code, not the banner — the banner says the words
  // "--record" precisely to explain that no such flag exists.
  const code = probeSrc.slice(probeSrc.indexOf("import fs from 'node:fs'"));
  assert.ok(!/'--record'|'--update-baseline'/.test(code), 'no record flag may be parsed');
  assert.ok(!/method:\s*['"](PUT|PATCH|DELETE)['"]/i.test(code), 'no write verb');
  // The single POST is the Supabase sign-in, which is how every credentialed
  // probe in this repo authenticates. Nothing else may POST.
  const posts = code.match(/method:\s*'POST'/g) || [];
  assert.equal(posts.length, 1, 'the only POST may be the auth/v1/token sign-in');
  assert.ok(/auth\/v1\/token[\s\S]{0,200}method:\s*'POST'/.test(code),
    'and that POST must be the sign-in');
  assert.ok(!/supplier-offers\/map/.test(code.replace(/\/\*[\s\S]*?\*\//g, '')) ||
    !/method:\s*'POST'[\s\S]{0,300}supplier-offers\/map/.test(code),
    'the probe must never create a mapping — that is a permanent production write');
  assert.ok(!/writeFileSync|appendFileSync/.test(code), 'the probe must not write files');
  assert.ok(/MODE: .*READ-ONLY/.test(probeSrc), 'the mode must be printed on every run');
});

test('the probe exits 2 for "could not look", never 1', () => {
  // "We could not look" and "we looked and it was fine" are different sentences,
  // and collapsing them is the mistake the probe exists to catch.
  assert.ok(/function cannotRun[\s\S]*?process\.exit\(2\)/.test(probeSrc), 'cannotRun() must exit 2');
  assert.ok(/if \(!findings\.length\)[\s\S]{0,200}process\.exit\(0\)/.test(probeSrc),
    'a fully-measured clean run exits 0');
  assert.ok(/process\.exit\(1\)/.test(probeSrc), 'real findings exit 1');
  assert.ok(/ADMIN_EMAIL \/ ADMIN_PASSWORD not set/.test(probeSrc),
    'a missing credential must name the variable — a skip is not a pass');
});

test('the probe guards the decoys in BOTH directions', () => {
  assert.match(probeSrc, /is still ignored/,
    'a decoy that starts filtering means the page can stop fetching everything');
  assert.match(probeSrc, /NOW FILTERS/,
    'and that improvement must be reported loudly rather than passing silently');
  assert.match(probeSrc, /is not ignored/,
    'a param the page RELIES on must be proven to filter, against a nonsense token');
  assert.match(probeSrc, /multi \(\$\{nMulti\}\) \+ single/,
    'the coverage check must be an invariant, not a pinned row count — the catalogue moves daily');
});

test('no test or source file pins a value that drifts daily', () => {
  const thisFile = read(path.join(ROOT, 'tests', 'admin-supplier-prices-aug2026.test.js'));
  // The fixture ages are named constants, so the intent is explicit and a single
  // edit updates every use. What must never appear is a bare literal age in an
  // assertion, or a row count treated as a contract.
  const body = thisFile.slice(thisFile.indexOf('// ── 1.'));
  assert.ok(!/age_days: 19[0-9]\b(?!.*STALE_DAYS)/.test(body),
    'fixture ages must go through the STALE_DAYS / FRESH_DAYS constants');
  assert.ok(!/assert\.equal\([^,]*total[^,]*,\s*(172|438|610|345)\b/.test(thisFile),
    'a live row count is not a contract — 172/438/610/345 move with the catalogue, and the '
    + 'handoff itself was already one row out (it said 439 single; production says 438)');
});

test('the colour-tail hint explains an ambiguous row instead of just labelling it', () => {
  const hit = M.colourTailConflict({ supplier_sku: 'BTN346M', color: 'Black' });
  assert.deepEqual(hit, { implied: 'Magenta', stated: 'Black' },
    'both live ambiguous rows are exactly this shape — a code ending in M carrying '
    + 'color: "Black". That contradiction is WHY the matcher refused, so showing it turns an '
    + 'unexplained refusal into a decision the operator can make.');
  assert.equal(M.colourTailConflict({ supplier_sku: 'BTN346M', color: 'Magenta' }), null,
    'agreement is not a conflict');
  assert.equal(M.colourTailConflict({ supplier_sku: 'IBDR3325', color: 'Black' }), null,
    'a code with no colour letter must not be forced into a guess');
  assert.equal(M.colourTailConflict({ supplier_sku: 'X', color: null }), null);
  assert.equal(M.colourTailConflict(null), null);
});

test('an unrecognised match_method is shown, not blanked', () => {
  const body = fnBody(pageJs, 'matchMethodLabel');
  assert.match(body, /unrecognised by this build/,
    'a new matcher strategy should be visible the day it ships. Rendering it as blank would '
    + 'make a change to how our costs are resolved invisible to the person spending the money.');
  assert.match(pageJs, /manual: 'Pinned by hand from the review queue'/,
    'a hand-pinned mapping must be labelled as such — `manual` is what a row mapped from '
    + 'the review queue comes back as, and seeing it is how the operator knows a human, '
    + 'not the matcher, decided that pairing');
});

test('normalizeCompare tolerates a malformed envelope without inventing data', () => {
  const empty = M.normalizeCompare(null);
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.suppliers, []);
  assert.equal(empty.pagination, null, 'a missing pagination must stay null, not become a fake page 1');
  assert.equal(empty.totals, null, 'and a missing total must not become 0 — unknown is not zero');
  assert.equal(empty.staleAfterDays, M.STALE_FALLBACK_DAYS);
});
