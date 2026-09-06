/**
 * Contract pricing on the storefront — the ladder, the PDP, the reorder tiles
 * ===========================================================================
 * ERR-221 · backend migration 165 · Sep 2026
 *
 * ── THE SAFETY PROPERTY THIS FILE EXISTS FOR ───────────────────────────────
 *
 * `js/business.js` keeps TWO caches, and the split is not an optimisation:
 *
 *   `_ladderCache`  public prices, identical for every shopper, filled by
 *                   ingest() from the catalogue payload, and DELIBERATELY NEVER
 *                   WIPED (clearing it blanks every painted grid the moment a
 *                   session resolves).
 *   `_priceCache`   whatever the AUTHED route returned, owner-scoped, wiped on
 *                   every auth change.
 *
 * A contract price is one company's negotiated rate. If it ever reached the
 * never-wiped public cache, the next person to use a shared machine would see
 * it until they reloaded. Merging the two caches is the obvious "fix" for the
 * PDP problem below, and it is the one thing that must not happen.
 *
 * ── AND THE PDP PROBLEM THAT INVITES THAT FIX ──────────────────────────────
 *
 * `getPricing()` answers from `_ladderCache` FIRST and returns before it ever
 * calls getStatus() — deliberately, so a guest's grid never queues behind a 3s
 * auth handshake. Since BF-032 put `quantity_breaks` on the public payload,
 * that first step answers for almost every product. A contract price appears
 * only on the AUTHED payload. So routing it through getPricing() would mean a
 * business customer with a negotiated rate never saw it. Hence a separate,
 * narrow `getContractPrice()` — B2B users only, PDP only.
 *
 * ── AND THE ONE INTERPRETER ────────────────────────────────────────────────
 *
 * `describeLadder()` is read by the PDP, the product cards, the cart nudges and
 * the Business Centre. Its output for a shopper with NO contract price must be
 * byte-identical to what it was before this change — asserted against a FROZEN
 * capture of the pre-change implementation's own output over the production
 * sweep, not against a fixture hand-written alongside the code, and not against
 * `git show HEAD:` (which stops being a baseline the moment the change lands —
 * see the note on that test).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BUS_SRC = read('inkcartridges/js/business.js');
const PDP_SRC = read('inkcartridges/js/product-detail-page.js');
const BP_SRC = read('inkcartridges/js/business-page.js');
const BUS = codeOnly(BUS_SRC);
const PDP = codeOnly(PDP_SRC);
const BP = codeOnly(BP_SRC);

/** Run the shipping business.js in a bare shim, the way the other suites do. */
function loadBusiness(src) {
  const fn = new Function('Auth', 'API', 'Security', 'DebugLog', 'formatPrice', 'window', 'document',
    `${src}\nreturn Business;`);
  return fn({}, {}, { escapeHtml: (s) => s, escapeAttr: (s) => s },
    { warn() {}, error() {}, log() {} }, (n) => `$${n}`, {}, {});
}

let B;
test.before(() => { B = loadBusiness(BUS_SRC); });

// ═══════════════════════════════════════════════════════════════════════════
// 1. The cache split
// ═══════════════════════════════════════════════════════════════════════════

test('ingest() cannot put a contract price in the public cache', () => {
  const b = loadBusiness(BUS_SRC);
  b.ingest({
    sku: 'A', retail_price: 100, contract_price: 80, your_price: 80, price_source: 'contract',
    quantity_breaks: [{ min_quantity: 2, business_price: 90, effective_percent: 10 }],
  });
  const cached = b._ladderCache.get('A');
  assert.ok(cached, 'the public ladder is still stored');
  assert.equal('contract_price' in cached, false,
    'the never-wiped public cache must never hold one account’s negotiated rate');
  assert.equal('your_price' in cached, false);
  assert.equal('price_source' in cached, false);
});

test('the ingest whitelist is explicit, so a new field cannot leak in by accident', () => {
  const fn = BUS.match(/ingest\(productOrList\)[\s\S]*?\n    \},/)[0];
  assert.match(fn, /_ladderCache\.set/);
  assert.doesNotMatch(fn, /\.\.\.(p|product|item)\b/,
    'a spread here would carry every future authed field into the public cache');
});

test('reset() clears the owner-scoped cache and the company name, and NOT the public one', () => {
  const fn = BUS.match(/reset\(\)\s*\{[\s\S]*?\n    \},/)[0];
  assert.match(fn, /_priceCache\.clear\(\)/);
  assert.match(fn, /_lastCompanyName = null/,
    'the company name names one account — it must not outlive that account’s prices');
  assert.doesNotMatch(fn, /_ladderCache/,
    'clearing the public cache blanks every painted grid the moment a session resolves');
});

test('getContractPrice refuses before it asks, so a guest fires no request', () => {
  const fn = BUS.match(/async getContractPrice\(sku\)[\s\S]*?\n    \},/)[0];
  const statusIdx = fn.indexOf('await this.getStatus()');
  const fetchIdx = fn.indexOf('_fetchChunk');
  assert.ok(statusIdx > 0 && fetchIdx > statusIdx,
    'the active-account gate must come BEFORE any request — contract prices are per-account by definition');
  assert.match(fn, /if \(!status\.active\) return null;/);
  assert.match(fn, /this\._syncCacheOwner\(\)/, 'and the cache owner is checked before the cache is read');
  assert.match(fn, /_priceCache\.get/);
  assert.doesNotMatch(fn, /_ladderCache/, 'never the public cache');
});

test('getContractPrice computes nothing — every figure is the server’s', () => {
  const fn = BUS.match(/async getContractPrice\(sku\)[\s\S]*?\n    \},/)[0];
  assert.doesNotMatch(fn, /\*\s*1\.15|\/\s*1\.15|\*\s*0\.\d|\-\s*item\./);
  assert.match(fn, /item\.contract_savings_amount/);
  assert.match(fn, /item\.price_source/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The one interpreter, unchanged for everyone without a contract
// ═══════════════════════════════════════════════════════════════════════════

test('describeLadder is byte-identical without a contract price, against a FROZEN pre-change baseline', () => {
  // ── WHY THIS READS A FIXTURE AND NOT `git show HEAD:…` ────────────────────
  //
  // It used to load the baseline out of git at test time. That worked exactly
  // as long as the change was UNCOMMITTED — the moment ERR-221 landed, `HEAD`
  // became the new file, `before` and `now` were the same implementation, and
  // the comparison was against itself. It went red on commit (caught by another
  // session within the hour), and the mode of failure is the one this repo
  // keeps paying for: **a test that passes for the wrong reason** (ERR-181/186).
  //
  // Note the near-miss. Stripping the two new keys from BOTH sides would have
  // turned it green again — and permanently vacuous, comparing the shipped code
  // to the shipped code forever. Green would then have meant nothing at all.
  //
  // So the baseline is FROZEN: `describeLadder()`'s output from business.js as
  // it stood at f2a366e, the commit before contract pricing, run over the
  // production sweep. It cannot rot, it needs no git, and it is genuinely the
  // OLD implementation's answer rather than a fixture written the same day as
  // the code it validates.
  const baseline = JSON.parse(read('tests/fixtures/ladder-baseline-pre-contract-pricing.json'));

  // The baseline must be a baseline. If someone ever regenerates this file from
  // the CURRENT code, every ladder in it gains basePrice/contractPrice, the
  // deepEqual below compares the shipped code to itself, and this test quietly
  // stops testing anything. Fail loudly instead.
  assert.ok(baseline.ladders.length >= 10,
    `expected a meaningful sample, got ${baseline.ladders.length}`);
  for (const { ladder } of baseline.ladders) {
    if (!ladder) continue;
    assert.equal('basePrice' in ladder, false,
      'the frozen baseline has been regenerated from the NEW code — it is no longer a baseline, ' +
      'and this comparison would be vacuous. Regenerate it from f2a366e or delete this test honestly.');
    assert.equal('contractPrice' in ladder, false, 'same — see above');
  }

  for (const { input, ladder: was } of baseline.ladders) {
    const now = B.describeLadder(input);
    if (was === null) { assert.equal(now, null, `${input.sku}: was null, now not`); continue; }
    assert.ok(now, `${input.sku}: the ladder disappeared`);
    // Strip only the two NEW keys; everything else must match the old output exactly.
    const { basePrice, contractPrice, ...rest } = now;
    assert.deepEqual(rest, was, `${input.sku}: the ladder changed for a shopper with no contract price`);
    assert.equal(basePrice, was.retailPrice, `${input.sku}: basePrice IS retailPrice without a contract`);
    assert.equal(contractPrice, null);
  }
});

test('a contract price becomes the base the rungs are measured from', () => {
  const ladder = B.describeLadder({
    sku: 'X', retail_price: 100, contract_price: 80,
    quantity_breaks: [
      { min_quantity: 2, business_price: 90, effective_percent: 10 },  // does not beat 80
      { min_quantity: 3, business_price: 75, effective_percent: 6.3, savings_amount: 5 },
    ],
  });
  assert.equal(ladder.basePrice, 80);
  assert.equal(ladder.contractPrice, 80);
  assert.equal(ladder.retailPrice, 100, 'retail is still reported — the PDP prints "the standard $X"');
  assert.equal(ladder.breaks.length, 1, 'a rung that does not beat what they already pay has nothing to advertise');
  assert.equal(ladder.breaks[0].minQuantity, 3);
  assert.equal(ladder.droppedAtOrAboveRetail, 1, 'and the drop is COUNTED, so the conservation law still holds');
  assert.equal(ladder.breaks.length + ladder.collapsed + ladder.droppedAtOrAboveRetail, 2);
});

test('a contract price ABOVE retail is ignored — they pay the lower of the two', () => {
  const ladder = B.describeLadder({
    sku: 'X', retail_price: 100, contract_price: 120,
    quantity_breaks: [{ min_quantity: 2, business_price: 90, effective_percent: 10 }],
  });
  assert.equal(ladder.basePrice, 100, 'the account is charged min(contract, ladder, list) — never above list');
  assert.equal(ladder.contractPrice, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The PDP — and the microdata it must never touch
// ═══════════════════════════════════════════════════════════════════════════

test('the contract line never touches #product-price or the itemprop content', () => {
  // The page is crawled ANONYMOUSLY and that markup feeds Merchant Center.
  // Showing a signed-in customer an ADDITIONAL, labelled line is personalisation
  // — the volume ladder already does it. Replacing the marked-up price is
  // cloaking: a price in the structured data that no crawler and no other
  // shopper can ever be charged.
  const fn = PDP.match(/renderContractPrice\(\)\s*\{[\s\S]*?\n        \},/)[0];
  assert.doesNotMatch(fn, /product-price|itemprop|content=/);
  assert.match(fn, /getElementById\('volume-pricing'\)/, 'it renders inside the ladder section and nowhere else');
});

test('the contract line renders even when there is no ladder at all', () => {
  // A contract price IS the price this customer pays. Returning early on a null
  // ladder would hide it on every product whose band has no volume discount.
  const fn = PDP.match(/async renderVolumePricing\(info\)[\s\S]*?this\._volumeLadder = ladder;/)[0];
  const contractIdx = fn.indexOf('this.renderContractPrice()');
  const bailIdx = fn.indexOf('if (!ladder) return;');
  assert.ok(contractIdx > 0 && bailIdx > contractIdx,
    'renderContractPrice() must run BEFORE the no-ladder bail-out');
});

test('a rung that beats the contract is stated, not silently hidden', () => {
  const fn = PDP.match(/renderContractPrice\(\)\s*\{[\s\S]*?\n        \},/)[0];
  assert.match(fn, /price_source|priceSource/, 'which of contract / volume / list actually applied at qty 1');
  assert.match(fn, /Your agreed price is/, 'the customer should know their contract exists either way');
});

test('a zero saving is not printed as a saving', () => {
  const fn = PDP.match(/renderContractPrice\(\)\s*\{[\s\S]*?\n        \},/)[0];
  assert.match(fn, /savingsAmount != null && c\.savingsAmount > 0/,
    'the server sends 0 when there is nothing to report and omits it when it did not compute one — ' +
    'neither is a reason to print "saves $0.00"');
});

test('the sticky buy-bar and the status line speak from basePrice', () => {
  const sync = PDP.slice(PDP.indexOf('syncVolumePricing() {'));
  assert.match(sync, /rung \? rung\.businessPrice : ladder\.basePrice/,
    'the bar must show what this add-to-cart will actually charge');
  assert.match(sync, /your agreed \$\{formatPrice\(ladder\.basePrice\)\} each/,
    'and below the entry rung, "the standard price" is the wrong words for a contract customer');
  assert.match(sync, /businessLocked = '1'/, 'the generic #product-price mirror is still held off');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The reorder tiles
// ═══════════════════════════════════════════════════════════════════════════

test('the tiles read the account’s own price, in one request', () => {
  assert.match(BP, /\/api\/business\/reorder-items/);
  assert.doesNotMatch(BP, /business\/top-products/,
    'that endpoint carried no price and needed a second /business/pricing call — both are gone');
  assert.doesNotMatch(BP, /decorateReorderPrices/);
});

test('the tile computes nothing, and names a missing price rather than guessing', () => {
  const fn = BP.match(/function reorderPriceHtml\(it\)[\s\S]*?\n    \}/)[0];
  assert.match(fn, /price unavailable/);
  assert.doesNotMatch(fn, /\*\s*1\.15|\/\s*1\.15|\-\s*Number/, 'no arithmetic on a price');
  assert.match(fn, /list > price/, 'a struck-through "was" only when list is genuinely higher');
});

test('a row missing its SKU is reported, not rendered as a dead tile', () => {
  // The hand-off documents only the PRICE keys on this endpoint; both accounts
  // have no order history, so its sku/name/product_url fields could not be
  // observed. A silent empty card is the ERR-218 failure all over again.
  const fn = BP.match(/async loadTopProducts\(\)[\s\S]*?QtyStepper\.bind\(list\)/)[0];
  assert.match(fn, /all\.filter\(\(it\) => it && it\.sku\)/);
  assert.match(fn, /warn\(/, 'and it says so out loud');
});

test('the tile never synthesises a product URL', () => {
  // The canonical URL is the backend's to give. Hand-building `/p/<sku>` makes
  // this the PRIMARY link to a shape the repo allows only as a documented
  // fallback (pinned by value-pack-and-product-url-contract.test.js).
  const fn = BP.match(/async loadTopProducts\(\)[\s\S]*?QtyStepper\.bind\(list\)/)[0];
  assert.doesNotMatch(fn, /`\/p\/\$\{/);
  assert.match(fn, /it\.product_url\s*$|it\.product_url\n/m, 'it links only when the server gave a URL');
});

test('ordering history is omitted rather than rendered as undefined', () => {
  const fn = BP.match(/async loadTopProducts\(\)[\s\S]*?QtyStepper\.bind\(list\)/)[0];
  assert.match(fn, /Number\.isFinite\(ordered\) && Number\.isFinite\(orders\)/,
    '"ordered undefined across undefined orders" is what an unguarded template prints');
});

test('the classes the tiles emit are styled', () => {
  const CSS = read('inkcartridges/css/pages.css');
  for (const c of ['business-reorder__was', 'business-reorder__contract',
    'volume-pricing__contract', 'volume-pricing__contract--beaten']) {
    assert.ok(CSS.includes('.' + c), `${c} is emitted but never styled`);
  }
});
