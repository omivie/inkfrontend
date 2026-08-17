/**
 * Cart: a discount that is SHOWN must be a discount that is DEDUCTED (ERR-169)
 * ===========================================================================
 *
 * The reported symptom was "the discounts on bulk orders are showing, but they
 * are not added into the total price at the end." The mechanism that produces
 * exactly that, and hides it, was this line in computeDiscountBreakdown:
 *
 *     other: Math.max(0, aggregate - loyalty - b2b)
 *
 * The rows the shopper SEES are the components (`b2b`, `loyalty`). The total the
 * shopper PAYS is computed elsewhere as `subtotal − aggregate`. The whole design
 * rests on `summary.discount` containing the components — recorded as verified
 * live in a comment, and never checked anywhere. When it does not hold, the
 * volume row still renders −$4.80 while the total deducts nothing, and the
 * `Math.max(0, …)` clamps the contradiction to a tidy zero on the way past.
 *
 * That is the absence-read-as-a-healthy-zero shape of ERR-063/068/149, and the
 * clamp was the silencer. The clamp stays — a negative "You Save" row would be
 * worse — but what it swallowed is now returned as `shortfall` and rendered.
 *
 * SECOND FAULT, same notice: `serverSummary === null` was set at eight sites
 * meaning two different things (four real failures, four deliberate
 * invalidations), carried no reason, and was silent in production because
 * DebugLog is a no-op outside localhost. A shopper in that state sees local
 * arithmetic, which contains NO volume discount, because the ladder only exists
 * on the server response.
 *
 * Run with: node --test tests/cart-discount-footing-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CART = path.join(ROOT, 'inkcartridges', 'js', 'cart.js');
const CHECKOUT = path.join(ROOT, 'inkcartridges', 'js', 'checkout-page.js');
const CART_HTML = path.join(ROOT, 'inkcartridges', 'html', 'cart.html');

const cartSrc = fs.readFileSync(CART, 'utf8');
const checkoutSrc = fs.readFileSync(CHECKOUT, 'utf8');
const cartHtml = fs.readFileSync(CART_HTML, 'utf8');

/**
 * computeDiscountBreakdown is a module-level function in a plain (non-ESM)
 * script, so it is lifted out and run on its own rather than loading all 3.5k
 * lines of cart.js. Behavioural, against the real shipping source.
 */
function loadBreakdown() {
    const start = cartSrc.indexOf('function computeDiscountBreakdown(');
    assert.ok(start > -1, 'computeDiscountBreakdown must exist');
    const end = cartSrc.indexOf('\nif (typeof window !== \'undefined\') window.computeDiscountBreakdown', start);
    assert.ok(end > start, 'the function must still be followed by its window export');
    const sandbox = { Number, Math, Object, String, Boolean, Array, JSON };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(cartSrc.slice(start, end) + '\n;globalThis.fn = computeDiscountBreakdown;', ctx,
        { filename: 'cart-breakdown.js' });
    return sandbox.fn;
}
const computeDiscountBreakdown = loadBreakdown();

// NB the third parameter is a MESSAGE, not a tolerance — passing a string as a
// tolerance makes `Math.abs(a-b) < tol` compare a number to a string, which is
// always false, and every assertion using it fails for a reason that has nothing
// to do with the code under test.
const near = (a, b, msg = '') => assert.ok(Math.abs(a - b) < 1e-9,
    `${a} !== ${b}${msg ? ' — ' + msg : ''}`);

// ─── 1. The sound case must stay completely silent ──────────────────────────

test('a well-formed breakdown reports no shortfall', () => {
    // The live shape: summary.discount is the aggregate and INCLUDES the volume
    // amount, so the components net out of "You Save" cleanly.
    const r = computeDiscountBreakdown({ discount: 4.80, volume_discount: 4.80 });
    near(r.b2b, 4.80);
    near(r.other, 0);
    assert.equal(r.shortfall, 0, 'a correct cart must raise nothing');
});

test('coupon + volume + loyalty together still foot', () => {
    const r = computeDiscountBreakdown({
        discount: 12.00, volume_discount: 4.80, loyalty_discount_amount: 2.20,
    });
    near(r.b2b, 4.80);
    near(r.loyalty, 2.20);
    near(r.other, 5.00, 'the coupon is the residual');
    assert.equal(r.shortfall, 0);
});

test('float noise below half a cent is not a shortfall', () => {
    const r = computeDiscountBreakdown({ discount: 4.7999999, volume_discount: 4.80 });
    assert.equal(r.shortfall, 0, 'a sub-cent residual is rounding, not a missing discount');
});

// ─── 2. The reported symptom is caught ──────────────────────────────────────

test('THE BUG: a volume discount missing from the aggregate is reported, not clamped away', () => {
    // The volume row will render −$4.80; the total will deduct only the $1.00
    // coupon. Before this change `other` clamped to 0 and nothing else happened.
    const r = computeDiscountBreakdown({ discount: 1.00, volume_discount: 4.80 });
    near(r.b2b, 4.80, 'the row we are about to SHOW');
    near(r.total, 1.00, 'the aggregate we are about to DEDUCT');
    assert.equal(r.other, 0, 'the clamp still protects the "You Save" row from going negative');
    near(r.shortfall, 3.80, 'and the swallowed amount is now part of the return value');
});

test('a loyalty credit missing from the aggregate is caught the same way', () => {
    const r = computeDiscountBreakdown({ discount: 0, loyalty_discount_amount: 6.50 });
    near(r.shortfall, 6.50);
});

test('the shortfall is the exact dollar gap, so the notice can name it', () => {
    const r = computeDiscountBreakdown({ discount: 2.00, volume_discount: 5.00, loyalty_discount_amount: 1.00 });
    near(r.shortfall, 4.00);   // 5.00 + 1.00 − 2.00
});

test('an absent summary is NOT a shortfall — nothing is being displayed to contradict', () => {
    for (const s of [null, undefined, {}, 'nonsense']) {
        assert.equal(computeDiscountBreakdown(s).shortfall, 0,
            'no summary means no discount rows, which cannot disagree with a total');
    }
});

test('the explicit `total` override still drives the aggregate', () => {
    // cart.js passes Cart.getDiscount() as `total`; checkout passes nothing.
    const r = computeDiscountBreakdown({ discount: 99, volume_discount: 4.80 }, 1.00);
    near(r.total, 1.00, 'the caller-supplied aggregate wins over summary.discount');
    near(r.shortfall, 3.80);
});

// ─── 3. The gate is rendered, from BOTH summary paths ───────────────────────

test('the notice renderer exists and is fed the shortfall', () => {
    assert.match(cartSrc, /_renderPricingNotice\(shortfall\)/,
        'the gate must be handed the figure, not left to recompute it');
    assert.match(cartSrc, /_renderPricingNotice\(shortfall\)\s*\{|_renderPricingNotice\(shortfall\)/);
});

test('it is called from _renderDiscountRows, which is the ONE function both renderers share', () => {
    // renderCartPage and _updateCartSummaryDOM drifted once before (ERR-110), so
    // the gate hangs off the shared helper rather than being wired into each.
    const body = cartSrc.slice(cartSrc.indexOf('_renderDiscountRows: function(discount)'),
        cartSrc.indexOf('_updateCartSummaryDOM: function()'));
    assert.match(body, /_renderPricingNotice\(/,
        'a gate wired into only one of the two paths passes by being skipped');
    assert.match(body, /shortfall/, 'and it must destructure the shortfall to pass it');

    for (const renderer of ['_updateCartSummaryDOM: function()', 'renderCartPage']) {
        const i = cartSrc.indexOf(renderer);
        assert.ok(i > -1, `${renderer} must exist`);
    }
    const calls = (cartSrc.match(/this\._renderDiscountRows\(discount\)/g) || []).length;
    assert.ok(calls >= 2, `both summary paths must call the shared row renderer (found ${calls})`);
});

test('the notice has a durable markup slot, matching the removal-notice precedent', () => {
    assert.match(cartHtml, /id="cart-pricing-notice"/, 'the slot must exist in the page');
    const el = /<p[^>]*id="cart-pricing-notice"[^>]*>/.exec(cartHtml);
    assert.ok(el, 'it must be a <p> like #cart-removal-notice');
    assert.match(el[0], /alert--warning/, 'styled as a warning, not a toast');
    assert.match(el[0], /role="status"/);
    assert.match(el[0], /aria-live="polite"/, 'a money warning must reach a screen reader');
    assert.match(el[0], /hidden/, 'and start hidden — it is shown only on a real fault');
});

test('the notice clears itself when the fault clears', () => {
    const body = cartSrc.slice(cartSrc.indexOf('_renderPricingNotice(shortfall)'),
        cartSrc.indexOf('     * Initialize cart - SERVER FIRST'));
    assert.match(body, /el\.hidden = true/, 'a resolved fault must hide the notice again');
    assert.match(body, /!degraded && !hasShortfall/, 'and the clear must be the explicit sound case');
});

test('the shortfall wording names the amount, and does not silently correct the total', () => {
    const body = cartSrc.slice(cartSrc.indexOf('_renderPricingNotice(shortfall)'),
        cartSrc.indexOf('     * Initialize cart - SERVER FIRST'));
    assert.match(body, /formatPrice\(gap\)/, 'the shopper must be told how much is missing');
    assert.ok(!/getDiscount\s*=|subtotal\s*-\s*/.test(body),
        'the gate must not recompute money — the backend owns it, we only disclose');
});

// ─── 4. Degraded pricing is distinguishable from an in-flight re-price ──────

test('PRICING reasons exist and separate real failures from pending invalidation', () => {
    assert.match(cartSrc, /const PRICING = \{/, 'the reasons must be a named vocabulary, not ad-hoc strings');
    for (const key of ['OK', 'FETCH_FAILED', 'SERVER_EMPTY', 'STALE_BUDGET', 'NO_API', 'LOCAL_ONLY', 'PENDING']) {
        assert.match(cartSrc, new RegExp(`${key}:\\s*'`), `PRICING.${key} must be defined`);
    }
    const degraded = /const PRICING_DEGRADED = new Set\(\[([\s\S]*?)\]\)/.exec(cartSrc);
    assert.ok(degraded, 'the degraded subset must be explicit');
    assert.ok(!/PENDING/.test(degraded[1]),
        'PENDING must NOT be degraded, or every quantity change flashes a warning');
    assert.ok(!/\bOK\b/.test(degraded[1]), 'and OK obviously must not be');
    assert.match(degraded[1], /FETCH_FAILED/, 'a failed fetch must be degraded');
    assert.match(degraded[1], /STALE_BUDGET/, 'so must an exhausted retry budget');
});

test('EVERY serverSummary drop goes through _losePricing with a stated reason', () => {
    // The point of the change: eight sites set null, meaning two different things,
    // and downstream could not tell them apart. Only the two helpers may touch the
    // field directly now.
    // The only legal direct writes are the two inside the helpers themselves.
    const helpersStart = cartSrc.indexOf('_adoptServerSummary(summary)');
    const helpersEnd = cartSrc.indexOf('isPricingDegraded: function()');
    assert.ok(helpersStart > -1 && helpersEnd > helpersStart, 'both helpers must exist, adjacent');
    const outside = cartSrc.slice(0, helpersStart) + cartSrc.slice(helpersEnd);
    const stray = [...outside.matchAll(/this\.serverSummary\s*=/g)];
    assert.equal(stray.length, 0,
        `serverSummary may only be assigned inside _adoptServerSummary/_losePricing `
        + `(found ${stray.length} write(s) elsewhere)`);

    const loses = (cartSrc.match(/_losePricing\(PRICING\.[A-Z_]+\)/g) || []).length;
    assert.ok(loses >= 8, `every former null-site must state its reason (found ${loses})`);
});

test('_losePricing takes NO default reason, so a new failure path cannot inherit PENDING', () => {
    assert.match(cartSrc, /_losePricing\(reason\)\s*\{/,
        'an optional reason would let a new failure silently become non-degraded');
});

test('isPricingDegraded is true only for real failures, and has a caller', () => {
    const body = cartSrc.slice(cartSrc.indexOf('isPricingDegraded: function()'),
        cartSrc.indexOf('isPricingDegraded: function()') + 400);
    assert.match(body, /PRICING_DEGRADED\.has\(this\.pricingState\)/);
    assert.match(body, /!this\.hasServerPricing\(\)/);
    // isUsingEstimatedPrices() sat in this file for months with ZERO callers while
    // its docblock claimed checkout should be blocked on it. A predicate nobody
    // calls is a comment that looks like code.
    const callers = (cartSrc.match(/isPricingDegraded\(\)/g) || []).length
        + (checkoutSrc.match(/isPricingDegraded\(\)/g) || []).length;
    assert.ok(callers >= 2, `isPricingDegraded must actually be consumed (found ${callers} references)`);
});

test('the degraded notice is suppressed while merely loading or pending', () => {
    const body = cartSrc.slice(cartSrc.indexOf('_renderPricingNotice(shortfall)'),
        cartSrc.indexOf('     * Initialize cart - SERVER FIRST'));
    assert.match(body, /!this\.loading/, 'never warn while the first load is still in flight');
    assert.match(body, /this\.items\.length > 0/, 'and never on an empty cart');
});

// ─── 5. The bounded retry ──────────────────────────────────────────────────

test('a failed cart fetch is retried ONCE, and the budget is bounded', () => {
    const body = cartSrc.slice(cartSrc.indexOf('async _retryPricingOnce(where)'),
        cartSrc.indexOf('     * Load cart from localStorage'));
    assert.match(body, /_pricingRefetches >= 1/, 'the budget must be bounded at one attempt');
    assert.match(body, /this\._pricingRefetches\+\+/);
    const inc = body.indexOf('_pricingRefetches++');
    const call = body.indexOf('this.loadFromServer()');
    assert.ok(inc > -1 && call > inc,
        'the counter must increment BEFORE the call, or loadFromServer\'s own catch recurses');
});

test('the retry budget resets on a successful adoption, so a later outage gets its own', () => {
    const body = cartSrc.slice(cartSrc.indexOf('_adoptServerSummary(summary)'),
        cartSrc.indexOf('_losePricing(reason)'));
    assert.match(body, /_pricingRefetches = 0/);
    assert.match(body, /pricingState = PRICING\.OK/);
});

test('all three failure catches attempt the retry', () => {
    const attempts = (cartSrc.match(/_retryPricingOnce\(/g) || []).length;
    // definition + the guest path, syncWithServer and loadFromServer catches
    assert.ok(attempts >= 4, `every fetch-failure path should retry once (found ${attempts})`);
});

// ─── 6. Checkout carries the same signal ───────────────────────────────────

test('checkout reports the same two faults instead of reading a null summary in silence', () => {
    assert.match(checkoutSrc, /Cart\.isPricingDegraded\(\)/,
        'checkout-page.js had the identical silent read of Cart.serverSummary');
    assert.match(checkoutSrc, /b2b\.shortfall/, 'and must consume the footing gate too');
    assert.match(checkoutSrc, /DebugLog\.error/, 'a money contradiction is an error, not a warn');
});

// ─── 7. The fallback is still THERE — loud, not removed ────────────────────

test('the local estimate is still rendered — this change makes it loud, it does not delete it', () => {
    // Removing a fallback is a behaviour change, not cleanup. The shopper keeps
    // seeing their cart; they are simply told the prices are unconfirmed.
    const start = cartSrc.indexOf('getSubtotal: function()');
    assert.ok(start > -1, 'getSubtotal must exist');
    const body = cartSrc.slice(start, cartSrc.indexOf('getShipping: function()', start));
    assert.ok(body.length > 0, 'getSubtotal must still be followed by getShipping');
    assert.match(body, /this\.items\.reduce/, 'the local subtotal estimate must survive');
    assert.match(body, /serverSummary\.subtotal !== undefined/,
        'and the server figure must still win when it exists');
});
