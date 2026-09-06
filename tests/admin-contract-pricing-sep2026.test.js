/**
 * Contract pricing — one business account's own price for one product
 * ===================================================================
 * ERR-221 · backend migration 165 · Sep 2026
 *
 * An admin opens a business account, searches the catalogue inside it, and sets
 * that account's price for a product. Nothing else is touched: the price lives
 * in its own table keyed on (business account × product), so the catalogue row,
 * the Google feed and every other customer are untouched by definition rather
 * than by convention.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
 *
 * Two failure shapes, both of which look completely healthy on screen:
 *
 *   1. A NULL RENDERED AS A ZERO. `net_margin_percent` is null when the product
 *      has no supplier cost — "we could not check" — and `Number(null)` is 0. A
 *      0% margin and an unknown margin are opposite facts: one says the price
 *      is at cost, the other says nobody looked. Same for a history row's
 *      `previous_price`, which is null on a first set AND on a reactivation, and
 *      `new_price`, which is null on a removal. Rendered naively, "this price
 *      had no predecessor" becomes "the price used to be $0.00".
 *
 *   2. THE 409 ARRIVING WITHOUT ITS NUMBERS. Below cost is the ONE refusal, and
 *      it is designed to be overridden — the operator confirms and we re-send
 *      with `acknowledge_below_cost`. js/api.js special-cases a 409 and returns
 *      `{ok:false, error:<STRING>, code, data:<raw body>}`, so invoiceError()'s
 *      object branch never runs and `err.details` comes out null. The evaluation
 *      survives only at `resp.data.error.details`. Miss that and the confirm
 *      dialog asks "are you sure?" while quoting no figures at all.
 *
 * Live-measured 2026-09-06 by `npm run probe:contract-pricing -- --write`,
 * 85/85 including the full set → update → 409 → acknowledge → history →
 * isolation → remove → reactivate cycle. Findings that shaped this file:
 *
 *   - `?limit=200` is a hard 400, not a clamp; `?status=approved` is a 400 too
 *     (this route's vocabulary is active|suspended|closed — NOT the storefront's).
 *   - `set` is only observable ONCE per (account, product): a removal
 *     soft-deletes, so every later first-write is `reactivated`. Both carry
 *     `previous_price: null`, which is why that is the assertion that matters.
 *   - The account object carries an undocumented `application_id`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const UTIL_SRC = read('inkcartridges/js/admin/utils/contract-pricing.js');
const API_SRC = read('inkcartridges/js/admin/api.js');
const PANEL_SRC = read('inkcartridges/js/admin/components/contract-pricing-panel.js');
const PAGE_SRC = read('inkcartridges/js/admin/pages/business.js');
const APP_SRC = read('inkcartridges/js/admin/app.js');
const CSS = read('inkcartridges/css/admin.css');

/** Strip comments so a rule can never be satisfied by prose describing it. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const UTIL = codeOnly(UTIL_SRC);
const API = codeOnly(API_SRC);
const PANEL = codeOnly(PANEL_SRC);
const PAGE = codeOnly(PAGE_SRC);

// The module is ESM; this file is CJS. Load it once, lazily.
let C;
test.before(async () => {
  C = await import(path.join(SITE, 'js/admin/utils/contract-pricing.js'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The price input
// ═══════════════════════════════════════════════════════════════════════════

test('an empty box is not zero, and not an error either', () => {
  const r = C.parsePriceInput('');
  assert.equal(r.value, null, 'blank must never parse to 0 — "free" is not what an empty field means');
  assert.equal(r.error, null,
    'and reddening a field the operator has not filled in yet is how a form teaches people to ignore it');
});

test('the server’s bounds are mirrored, not invented', () => {
  assert.equal(C.parsePriceInput('0').value, null, 'the server rule is > 0, so zero is refused');
  assert.match(C.parsePriceInput('0').error, /more than \$0/);
  assert.equal(C.parsePriceInput('-5').value, null);
  assert.equal(C.parsePriceInput('100001').value, null, '> 100000 is a 400');
  assert.equal(C.parsePriceInput('104.90').value, 104.90);
  assert.equal(C.parsePriceInput('$1,049.00').value, 1049, 'operators paste currency');
  assert.equal(C.parsePriceInput('abc').value, null);
});

test('more than two decimal places is refused rather than silently rounded', () => {
  // A silently rounded price is a changed price. The server stores 2dp
  // regardless, so saying so beats saving something the operator did not type.
  const r = C.parsePriceInput('104.905');
  assert.equal(r.value, null);
  assert.match(r.error, /two decimal places/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The guard rails — evaluatePrice
// ═══════════════════════════════════════════════════════════════════════════

const GUARDS = { list_price: 134.49, break_even_price: 97.68, floor_price: 102.99, cost_known: true };

test('below cost is the only blocking band', () => {
  const r = C.evaluatePrice(90, GUARDS);
  assert.equal(r.band, C.BAND_BELOW_COST);
  assert.equal(r.blocking, true, 'the server refuses this without an acknowledgement');
  assert.match(r.message, /97\.68/, 'and it names break-even, because that is the number the operator needs');
});

test('below the floor is a warning, never a block', () => {
  const r = C.evaluatePrice(100, GUARDS);
  assert.equal(r.band, C.BAND_BELOW_FLOOR);
  assert.equal(r.blocking, false,
    'a thin negotiated line is a commercial decision the operator owns — we colour it, we do not overrule it');
});

test('below cost outranks below floor — every below-cost price is also below the floor', () => {
  // Testing the floor first would print the milder of two true sentences.
  assert.equal(C.evaluatePrice(50, GUARDS).band, C.BAND_BELOW_COST);
});

test('above list is allowed, and says the account is still charged LIST', () => {
  const r = C.evaluatePrice(200, GUARDS);
  assert.equal(r.band, C.BAND_ABOVE_LIST);
  assert.equal(r.blocking, false);
  assert.match(r.message, /charged \$134\.49|charged.*134/,
    'this is the surprising server behaviour — an operator who does not know it thinks the save failed');
});

test('no supplier cost is "unknown", NEVER "0%"', () => {
  // The ERR-068 shape: an unknown cost reported as a zero cost, and a $0 cost is
  // a 100% margin. Both spellings the backend uses must land in the same band —
  // §4.4 rows express it with null guards, §4.5 evaluations with cost_known.
  for (const guards of [
    { list_price: 20, break_even_price: null, floor_price: null },
    { list_price: 20, break_even_price: null, floor_price: null, cost_known: false },
  ]) {
    const r = C.evaluatePrice(10, guards);
    assert.equal(r.band, C.BAND_UNKNOWN, JSON.stringify(guards));
    assert.equal(r.blocking, false);
    assert.match(r.message, /no recorded supplier cost/i);
    assert.doesNotMatch(r.message, /0%/, 'an unchecked margin is not a zero margin');
  }
});

test('a healthy price says nothing, and an empty one is its own band', () => {
  assert.equal(C.evaluatePrice(120, GUARDS).band, C.BAND_OK);
  assert.equal(C.evaluatePrice(120, GUARDS).message, '');
  assert.equal(C.evaluatePrice(null, GUARDS).band, C.BAND_EMPTY);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The §4.6 four-action null table
// ═══════════════════════════════════════════════════════════════════════════
//
// action        previous_price   new_price   change_amount
// set            null            the price   null
// updated        the old price   the new     signed delta
// reactivated    null            the price   null
// removed        the withdrawn   null        null

test('a first "set" has no previous price, and never renders one', () => {
  const row = { action: 'set', previous_price: null, new_price: 104.90, change_amount: null, sku: 'GTN2530BK' };
  const d = C.describeHistoryRow(row);
  assert.equal(d.previous, null, 'null, not 0 — Number(null) is 0 and that reads as "it used to be free"');
  assert.equal(d.next, 104.90);
  assert.equal(d.delta, null);
  assert.equal(d.direction, null, 'no delta means no direction, not "flat"');
  const text = C.describeChange(row);
  assert.doesNotMatch(text, /\$0\.00/, 'a fabricated $0.00 on the empty side of the arrow');
  assert.match(text, /first set/i);
});

test('a "removed" has no new price', () => {
  const row = { action: 'removed', previous_price: 104.90, new_price: null, change_amount: null };
  const d = C.describeHistoryRow(row);
  assert.equal(d.next, null);
  const text = C.describeChange(row);
  assert.doesNotMatch(text, /→\s*\$0\.00/, '"changed to $0.00" is not what a withdrawal means');
  assert.match(text, /withdrawn/i);
});

test('a "reactivated" also has no previous price — the subtle row', () => {
  // Measured live: re-adding after a removal reports `reactivated` with
  // previous_price null, NOT the price it used to be.
  const d = C.describeHistoryRow({ action: 'reactivated', previous_price: null, new_price: 99, change_amount: null });
  assert.equal(d.previous, null);
  assert.equal(d.label, 'Price re-added');
});

test('an "updated" carries all three, and the sign carries the meaning', () => {
  const d = C.describeHistoryRow({ action: 'updated', previous_price: 114.32, new_price: 104.90, change_amount: -9.42 });
  assert.equal(d.previous, 114.32);
  assert.equal(d.next, 104.90);
  assert.equal(d.direction, 'down');
  assert.equal(C.formatSignedMoney(-9.42), '−$9.42',
    'unsigned "$9.42" beside "was → now" reads as an increase to about half of everyone');
  assert.equal(C.formatSignedMoney(4.1), '+$4.10');
  assert.equal(C.formatSignedMoney(null), '—', 'no delta is an em dash, not $0.00');
});

test('an unrecognised action is reported as itself, never folded into "updated"', () => {
  const d = C.describeHistoryRow({ action: 'expired', previous_price: 10, new_price: 12, change_amount: 2 });
  assert.equal(d.known, false);
  assert.equal(d.label, 'expired',
    'a new backend action must not vanish from the audit trail, and must not be described as something it is not');
});

test('history renders the row’s own SKU snapshot, not the live product', () => {
  // The row has no foreign key to products — that is the point. A later rename
  // or a delete cannot rewrite history.
  const d = C.describeHistoryRow({ action: 'set', sku: 'OLD-SKU', name: 'Old name', new_price: 1, previous_price: null });
  assert.equal(d.sku, 'OLD-SKU');
  const historyFn = PANEL.slice(PANEL.indexOf('function historyHtml'));
  assert.match(historyFn, /d\.sku/, 'the panel reads the history row’s sku');
  assert.doesNotMatch(historyFn.slice(0, historyFn.indexOf('function formatSigned')), /product\.sku|row\.product/,
    'and never reaches for the current product to look tidier');
  assert.match(PANEL, /historySnapshotNote/, 'and states once, on the panel, that these are snapshots');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Margin display — the tri-state
// ═══════════════════════════════════════════════════════════════════════════

test('an unknown margin says "unknown"; a real zero says "0%"', () => {
  assert.equal(C.formatMarginPercent(null), 'unknown');
  assert.equal(C.formatMarginPercent(undefined), 'unknown');
  assert.equal(C.formatMarginPercent(0), '0%', 'a measured zero IS a measurement');
  assert.equal(C.formatMarginPercent(6.7), '6.7%');
  assert.equal(C.formatMarginPercent(-18.1), '-18.1%', 'a below-cost row has a negative margin and must show it');
});

test('an absent discount percent is an em dash, not −0%', () => {
  assert.equal(C.formatDiscountPercent(null), '—');
  assert.equal(C.formatDiscountPercent(22), '−22%');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Errors — and the 409 that carries its numbers somewhere unexpected
// ═══════════════════════════════════════════════════════════════════════════

test('PRICE_BELOW_COST asks for a confirmation and carries the evaluation', () => {
  const err = Object.assign(new Error('This price is below cost — break-even is $97.68.'), {
    code: 'PRICE_BELOW_COST',
    evaluation: { below_cost: true, net_margin_percent: -18.1, break_even_price: 97.68 },
  });
  const d = C.describeSaveError(err);
  assert.equal(d.needsAcknowledge, true);
  assert.match(d.message, /97\.68/, 'the server’s own message carries the figure — do not replace it');
  assert.equal(d.evaluation.net_margin_percent, -18.1);
});

test('the operator is not told to re-send an API flag they have a button for', () => {
  // Seen in the real dialog, live: the server's message ends "Re-send with
  // acknowledge_below_cost: true to set it anyway." That is correct, and it is
  // written for whoever calls the endpoint. WE are that caller — the "Set it
  // anyway" button one line below IS the re-send. Left in, it tells a
  // salesperson to do something they cannot do, in a vocabulary they have no
  // reason to know.
  const d = C.describeSaveError({
    code: 'PRICE_BELOW_COST',
    message: 'This price is below cost — it would lose money on every unit. Break-even is $97.68. Re-send with acknowledge_below_cost: true to set it anyway.',
    evaluation: { below_cost: true },
  });
  assert.doesNotMatch(d.message, /acknowledge_below_cost|Re-send/i);
  assert.match(d.message, /Break-even is \$97\.68\./,
    'every MEASUREMENT in the server’s sentence survives verbatim — only the instruction goes');
});

test('the trim is narrow — any other server sentence reaches the operator intact', () => {
  const d = C.describeSaveError({
    code: 'PRICE_BELOW_COST',
    message: 'This price is below cost. Contact the supplier before agreeing to it.',
  });
  assert.match(d.message, /Contact the supplier before agreeing to it\./);
});

test('js/api.js hands a 409 over as an ENVELOPE whose error is a STRING', () => {
  // This is why contractEvaluation() has to exist. Pinning the client's shape
  // here means a change to it fails loudly rather than silently emptying the
  // confirm dialog.
  const req = API_SRC.slice(0, 0) + read('inkcartridges/js/api.js');
  assert.match(req, /if \(response\.status === 409 && errorCode\) \{[\s\S]*?return withRid\(\{ ok: false, error: errorMsg, code: errorCode, data: data \}\)/,
    'a 409 returns { error: <string>, data: <raw body> } — so error.details is unreachable by the usual route');
});

test('contractEvaluation digs the evaluation out of BOTH shapes, and returns null when there is none', () => {
  const fn = API.slice(API.indexOf('function contractEvaluation'), API.indexOf('function contractPriceError'));
  assert.match(fn, /source\?\.data\?\.error\?\.details\?\.evaluation/,
    'the 409 envelope path — the one invoiceError() cannot reach');
  assert.match(fn, /source\?\.details\?\.evaluation/, 'the thrown path');
  assert.match(fn, /catch \{ return null; \}/,
    'total by construction: this runs while handling an error and must not throw a second one');
  assert.doesNotMatch(fn, /return \{\}/, 'null means "no numbers"; {} would render a dialog full of blanks');
});

test('the save path attaches the evaluation before throwing', () => {
  const set = API.match(/async setContractPrice\([\s\S]*?\n  \},/)[0];
  assert.match(set, /contractPriceError\(/,
    'not invoiceError — the 409 is a normal path here, not a failure, and it must keep its numbers');
  assert.match(set, /window\.API\.put\(/, 'PUT is inside the CORS allow-list; PATCH is not (BF-021)');
});

test('a below-cost dialog that lost its numbers refuses to offer a blind override', () => {
  const save = PANEL.slice(PANEL.indexOf('async function savePrice'));
  assert.match(save, /if \(!ev\) \{/,
    'a confirmation that cannot say what you are agreeing to is worse than an error');
  assert.match(save, /Modal\.confirm/, 'and the override is an explicit human confirm');
  assert.match(save, /savePrice\(product, price, notes, btn, true\)/,
    'the retry is rebuilt from the SAME inputs, so the note cannot be dropped on the second attempt');
});

test('a 404 on remove reads as "there was nothing to remove", not as a failure', () => {
  assert.equal(C.isAlreadyRemoved({ code: 'NOT_FOUND' }), true);
  assert.equal(C.isAlreadyRemoved({ code: 'RATE_LIMITED' }), false);
  const remove = PANEL.slice(PANEL.indexOf('function confirmRemove'));
  assert.match(remove, /isAlreadyRemoved/,
    'a double-click on Remove must report honestly rather than pretend to succeed OR cry failure');
});

test('the error copy never blames CORS — PUT and DELETE are allowed', () => {
  // describeUpdateError() correctly blames BF-021 for PATCH. Copying that branch
  // here would tell an operator the backend blocks a change it does not block,
  // and send them to file a ticket for their own wifi. Measured 2026-09-06:
  // Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS.
  const fn = UTIL.slice(UTIL.indexOf('export function describeSaveError'));
  assert.doesNotMatch(fn, /BF-021|Access-Control-Allow-Methods/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The API layer — the two bugs that made this endpoint look unshipped
// ═══════════════════════════════════════════════════════════════════════════

test('ERR-221: the accounts list never asks for more than 100', () => {
  // `?limit=200` is a 400 VALIDATION_FAILED. js/api.js returns that as an
  // ENVELOPE rather than throwing, so the old caller's `resp.data` was undefined
  // and it fell through to the device-local rows — the identical value it
  // returned during the 404 years, with no toast and no warning. The check
  // could not fail, which is why it went unnoticed.
  const fn = API.match(/async listBusinessAccountsPage\([\s\S]*?\n  \},/)[0];
  assert.doesNotMatch(fn, /limit['"]?\s*[,)]\s*['"]?\d{3,}/);
  assert.match(fn, /Math\.min\([\s\S]*?BUSINESS_ACCOUNT_PAGE_MAX\)/,
    'the ceiling is enforced here, not trusted to the caller');
  assert.match(API, /const BUSINESS_ACCOUNT_PAGE_MAX = 100;/);
});

test('ERR-221: and never sends the STOREFRONT status vocabulary', () => {
  // /api/business/status answers "approved"; this route's enum is
  // active|suspended|closed and `?status=approved` is a 400. The old code
  // filtered server rows for 'approved', which would have dropped every real row
  // even after the limit was fixed.
  const fn = API.match(/async listBusinessAccounts\(\)[\s\S]*?\n  \},/)[0];
  assert.doesNotMatch(fn, /'approved'/);
  assert.deepEqual([...C.ACCOUNT_STATUSES], ['active', 'suspended', 'closed']);
  assert.equal(C.ACCOUNTS_LIMIT_MAX, 100);
});

test('reads fail soft to null; writes throw', () => {
  for (const name of ['listContractPrices', 'searchAccountProducts', 'listContractPriceHistory']) {
    const fn = API.match(new RegExp(`async ${name}\\([\\s\\S]*?\\n  \\},`))[0];
    assert.match(fn, /catch \(e\) \{[\s\S]*?return null;/,
      `${name}: null means "we could not ask", which the caller renders differently from []`);
  }
  for (const name of ['setContractPrice', 'removeContractPrice']) {
    const fn = API.match(new RegExp(`async ${name}\\([\\s\\S]*?\\n  \\},`))[0];
    assert.match(fn, /throw contractPriceError\(/, `${name} must throw, not swallow`);
  }
});

test('every id is encoded into the path', () => {
  for (const name of ['getBusinessAccount', 'listContractPrices', 'searchAccountProducts',
    'setContractPrice', 'removeContractPrice', 'listContractPriceHistory']) {
    const fn = API.match(new RegExp(`async ${name}\\([\\s\\S]*?\\n  \\},`))[0];
    assert.match(fn, /encodeURIComponent/, name);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The surface — gating, addressability, and absence-vs-zero on screen
// ═══════════════════════════════════════════════════════════════════════════

test('the route is owner-only in the manifest AND self-gated in the page', () => {
  // These responses carry cost_price and net_margin_percent.
  assert.match(APP_SRC, /\{ key: 'business',[^}]*ownerOnly: true \}/);
  assert.match(PAGE, /if \(!AdminAuth\.isOwner\(\)\)/,
    'belt-and-braces beside the router gate — one of them being removed must not open the surface');
});

test('ERR-208: onRouteChange re-reads the hash rather than trusting its argument', () => {
  // app.js passes getRouteDetailFromHash(), which extracts `?tab=` and nothing
  // else. Destructuring `account` from it would be undefined forever, and the
  // symptom — "the account never changes" — reads as a caching bug.
  const fn = PAGE.match(/onRouteChange\(\)\s*\{[\s\S]*?\n  \},/)[0];
  assert.doesNotMatch(fn, /\(\s*\{/, 'no destructured parameter');
  assert.match(fn, /syncToRoute\(\)/);
  assert.match(PAGE, /function readRouteFromHash\(\)\s*\{\s*const hash = String\(window\.location\.hash/);
});

test('opening an account is a NAVIGATION, so addressable and launchable cannot drift', () => {
  const paint = PAGE.match(/function paintAccounts\(\)[\s\S]*?\n\}/)[0];
  assert.match(paint, /goTo\(\{ accountId: tr\.dataset\.account/);
  assert.doesNotMatch(paint, /openAccountDrawer\(/,
    'the row handler sets the hash and returns — there is no second path into the drawer');
});

test('an absent custom_price_count is an em dash, never "0 custom prices"', () => {
  const fn = PAGE.match(/function countCell\(a\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /n == null/, 'absent is checked before the number is used');
  assert.match(fn, /MISSING/);
  // and a real zero says what it means
  assert.match(fn, /List price/);
});

test('a failed read of the prices says so, instead of showing an empty list', () => {
  const fn = PANEL.match(/function paintRows\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(_rows === null\)/, 'null and [] are different states and are rendered differently');
  assert.match(PANEL_SRC, /connection problem, not an empty list/i);
});

test('the panel validates locally — no request fires per keystroke', () => {
  // Writes are 20/min. product-search already hands us break_even_price and
  // floor_price with the row; that is WHY it does.
  const grade = PANEL.slice(PANEL.indexOf('const grade = ='), PANEL.indexOf('saveBtn.addEventListener'));
  assert.doesNotMatch(grade, /AdminAPI\.|await /, 'grading a typed price must cost no round trip');
});

test('the suspended case is stated on the account, not left to be inferred', () => {
  // Its prices still EXIST but are not CHARGED, and those are easy to confuse
  // when the prices are sitting in a table right below.
  assert.match(PAGE_SRC, /not being charged/i);
});

/** Pull one top-level function body out of a comment-stripped source. */
function fnBody(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  assert.ok(m, `${name} must exist`);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

test('Modal escapes its own title and confirm message — the exemption below is earned', () => {
  // Scoped escaping only makes sense if the things it exempts really are safe.
  const MODAL = read('inkcartridges/js/admin/components/modal.js');
  assert.match(MODAL, /<h3>\$\{esc\(title\)\}<\/h3>/);
  assert.match(MODAL, /\$\{esc\(message\)\}/);
  // `body` and `footer` are raw HTML, which is exactly why the builders below
  // are the last line of defence.
  assert.doesNotMatch(MODAL, /esc\(body\)|esc\(footer\)/);
});

test('every HTML builder escapes the operator-typed values it interpolates', () => {
  // Scoped to the BUILDERS, mirroring admin-business-upgrade-aug2026. A whole-
  // file scan flags Modal.open({title}) and Modal.confirm({message}), both of
  // which Modal escapes itself (pinned above) — and a test that cries wolf on
  // safe code gets its failures ignored.
  const UNTRUSTED = /\b(company_name|contact_email|contact_name|sku|name|notes|changed_by_email|business_account_id)\b/;
  const builders = [
    ['panel paintRows', fnBody(PANEL, 'paintRows')],
    ['panel lastChangeCell', fnBody(PANEL, 'lastChangeCell')],
    ['panel renderPriceForm', fnBody(PANEL, 'renderPriceForm')],
    ['panel historyHtml', fnBody(PANEL, 'historyHtml')],
    ['page paintAccounts', fnBody(PAGE, 'paintAccounts')],
    ['page accountHeaderHtml', fnBody(PAGE, 'accountHeaderHtml')],
    ['page accountDetailsHtml', fnBody(PAGE, 'accountDetailsHtml')],
    ['page paintReconciliation', fnBody(PAGE, 'paintReconciliation')],
    ['page countCell', fnBody(PAGE, 'countCell')],
  ];
  // Builders that escape their own arguments — narrow on purpose.
  const DELEGATES = /^\$\{(row|countCell|lastChangeCell)\(/;
  const bad = [];
  for (const [label, body] of builders) {
    for (const expr of body.match(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || []) {
      if (!UNTRUSTED.test(expr)) continue;
      if (DELEGATES.test(expr)) continue;
      if (/\besc\(|\bescA\(|\bmoney\(|\bformatDate\(|\bencodeURIComponent\(/.test(expr)) continue;
      bad.push(`${label}: ${expr}`);
    }
  }
  assert.deepEqual(bad, [],
    'company_name and notes are typed by an operator and stored verbatim by the backend — ' +
    'they reach the drawer, the modal, the table and the price history');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Purity, one vocabulary, and the CSS the surface depends on
// ═══════════════════════════════════════════════════════════════════════════

test('the vocabulary module touches no DOM and makes no request', () => {
  assert.doesNotMatch(UTIL, /\bdocument\.|\bwindow\.|\bfetch\(|AdminAPI/,
    'every rule in it must be drivable by this file without a browser');
});

test('the surface computes no price, no margin and no percent it will save', () => {
  // evaluatePrice COMPARES a typed number against three server thresholds.
  // Comparison is not derivation. The one exception is the live "X% off list"
  // hint under the box, which labels a number the operator is typing and is
  // replaced by the server's own discount_percent the moment it is saved.
  const exceptions = PANEL.indexOf('function pctOff');
  const before = PANEL.slice(0, exceptions);
  assert.doesNotMatch(before, /\/\s*1\.15|\*\s*1\.15|\*\s*0\.\d/,
    'no GST arithmetic and no percentage arithmetic on a price that gets stored');
  assert.match(PANEL_SRC, /nothing downstream ever reads this/,
    'and the one exception documents why it is one');
});

test('the classes the surface emits are all styled', () => {
  for (const c of ['cp-toolbar', 'cp-pager', 'cp-table', 'cp-off', 'cp-danger', 'cp-actions',
    'cp-flags', 'cp-form__facts', 'cp-form__label', 'cp-form__value', 'cp-note',
    'cp-note--red', 'cp-note--amber', 'cp-note--info', 'cp-delta', 'cp-history__note',
    'biz-drawer', 'biz-panel', 'biz-reconcile', 'inv-vol--contract', 'inv-account-notice']) {
    assert.ok(CSS.includes('.' + c), `${c} is emitted but never styled`);
  }
});

test('the contract chip is visually distinct from the volume chip, in brand tokens', () => {
  // They look alike on a line — both are "less than list" — and they are not
  // alike at all: the ladder is public, a contract price is negotiated with one
  // account and appears on no public payload.
  const block = CSS.slice(CSS.indexOf('.inv-vol--contract {'), CSS.indexOf('.inv-account-notice {'));
  assert.match(block, /var\(--magenta\)/);
  assert.doesNotMatch(block, /var\(--cyan\)/, 'cyan is the volume chip’s — reusing it defeats the point');
  // Two admin tests slice this stylesheet from a marker to EOF and assert every
  // var() they find is defined, so anything appended inherits those checks.
  const appended = CSS.slice(CSS.indexOf('CONTRACT PRICING —'));
  for (const v of [...new Set((appended.match(/var\(--[a-z-]+/g) || []).map((x) => x.slice(4)))]) {
    assert.ok(new RegExp(`${v}\\s*:`).test(CSS), `${v} is used but never defined`);
  }
});

test('the probe exists, is registered, and defaults to read-only', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['probe:contract-pricing'], 'node scripts/probe-contract-pricing.mjs');
  const probe = read('scripts/probe-contract-pricing.mjs');
  assert.match(probe, /const WRITE = ARGS\.has\('--write'\);/,
    'writing is opt-in and never inferred — sweep:b2b once passed by overwriting what it compared against');
  assert.match(probe, /MODE: READ-ONLY/, 'and the mode is printed before any work');
  assert.match(probe, /finally \{ await cleanup\(\); \}/);
  assert.match(probe, /cleanupFailed/, 'a failed cleanup must redden the exit code even when every check passed');
});
