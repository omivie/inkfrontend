/**
 * Cart: "We couldn't confirm today's prices" must be EARNED (ERR-210)
 * ==================================================================
 *
 * The owner screenshotted /cart showing that warning printed directly above an
 * Order Summary that was rendering a "You Save −$0.72" row and a working volume
 * nudge. The savings row can only come from `Cart.discountAmount`, which only a
 * SUCCESSFUL server parse ever sets — and `_losePricing()` nulls `serverSummary`
 * while leaving `discountAmount` behind. So the cart had priced correctly and
 * then lost it, and announced that in copy written for a cart that had never
 * priced at all.
 *
 * Three faults, all here:
 *
 *   1. `_staleRefetches` was reset ONLY inside loadFromServer's success arm, so
 *      the guest and syncWithServer success paths never cleared it and the
 *      stale-snapshot budget leaked across the whole page lifetime. Three
 *      discarded snapshots at any point in a session — three fast + clicks, each
 *      legitimately racing a GET — tripped the banner against a healthy backend.
 *      And a discarded snapshot is not a pricing failure at all.
 *   2. A transient failure was announced immediately and never retried. The
 *      durability listeners (online / pageshow / visibilitychange) existed and
 *      replayed REMOVALS only; the copy told the shopper to refresh by hand.
 *   3. The mirror image: `API.request()` RETURNS `{ok:false}` for 401/403/429 and
 *      for a 5xx that parsed as JSON, and all three cart GETs read
 *      `if (response.ok && response.data)` with no `else`. Those left
 *      pricingState at LOCAL_ONLY/PENDING — local prices on screen, notice
 *      HIDDEN, and DebugLog is a no-op in production.
 *
 * This suite is BEHAVIOURAL: it loads the real cart.js and drives Cart through
 * stubbed API responses. The ERR-169 suite next door is source-text assertions,
 * and there has never been a test that fails a fetch and looks at the banner.
 *
 * Run with: node --test tests/cart-pricing-revalidation-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CART = path.join(ROOT, 'inkcartridges', 'js', 'cart.js');
const cartSrc = fs.readFileSync(CART, 'utf8');

// ─── A DOM small enough to read, real enough to render into ────────────────

function makeEl(id) {
    return {
        id: id,
        hidden: true,
        textContent: '',
        innerHTML: '',
        value: '',
        max: 0,
        disabled: false,
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, remove() {}, insertAdjacentHTML() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
    };
}

/**
 * Load the real cart.js into a sandbox.
 *
 * `updateUI` is left ALONE — the tests that care about the banner call
 * `_renderDiscountRows()`, which is the one function both summary renderers
 * share and the only caller of `_renderPricingNotice`. Stubbing that out is how
 * a gate passes by never running (ERR-181/186), so the positive control at the
 * bottom of this file proves it does run.
 */
function loadCart(opts) {
    const options = opts || {};
    const els = Object.create(null);
    const getEl = (id) => (els[id] || (els[id] = makeEl(id)));

    const store = Object.create(null);
    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; },
        },
        navigator: { onLine: true },
        document: {
            getElementById: getEl,
            querySelector: () => null,          // no `.cart-page` — updateUI stays cheap
            querySelectorAll: () => [],
            addEventListener() {},
            visibilityState: 'visible',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        Security: { escapeHtml: (v) => String(v), escapeAttr: (v) => String(v) },
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        showToast() {},
        API: options.api || {},
        Auth: { initialized: true, isAuthenticated: () => true, onAuthStateChange() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // `const Cart = {...}` at the top level of a classic script is a LEXICAL
    // binding, not a property of the global object, so it has to be handed out
    // explicitly — the same lift the ERR-169 suite does for its helpers.
    vm.runInContext(cartSrc + '\n;globalThis.__Cart = Cart;', sandbox, { filename: 'cart.js' });

    const Cart = sandbox.__Cart;
    // `loading` ships as TRUE and is cleared by loadCart()'s finally. These tests
    // drive the read functions directly, so the page has to be told it has
    // settled — otherwise every assertion below passes on the loading deferral
    // rather than on the thing it claims to test.
    Cart.loading = false;
    // The one element this suite reads. Nothing else needs to be real.
    Cart.__notice = getEl('cart-pricing-notice');
    Cart.__sandbox = sandbox;
    return Cart;
}

// The real payload shape: _parseServerCart drops any line without a nested
// `product`, so a flat stub silently parses to ZERO items — and an empty cart is
// a legitimately silent degraded state. Every "no banner" assertion here would
// then pass for entirely the wrong reason. assertPriced() below is the guard.
const SUMMARY = { subtotal: 29.95, discount: 0.72, total: 29.23, shipping: 0 };
const okCart = () => ({
    ok: true,
    data: {
        items: [{
            quantity: 5,
            product: {
                id: 'p1', name: 'BCI3BK Compatible Ink Cartridge', sku: 'CBCI3BK',
                retail_price: 5.99, source: 'compatible', image_url: '',
            },
        }],
        summary: Object.assign({}, SUMMARY),
    },
});
const ITEM = { id: 'p1', key: 'core:CBCI3BK', name: 'BCI3BK', sku: 'CBCI3BK', price: 5.99, quantity: 5, source: 'core' };

/** Paint the notice the way the page does — through the shared renderer. */
function paint(Cart) {
    Cart._renderDiscountRows(Cart.getDiscount());
    return Cart.__notice.hidden ? '' : Cart.__notice.innerHTML;
}

/** The cart must still HAVE items, or "no banner" proves nothing. */
function assertPriced(Cart) {
    assert.ok(Cart.items.length > 0, 'the stub payload must actually parse into a line');
}

// ─── 1. The leak: the stale-snapshot budget must be PER EPISODE ────────────

test('every success path resets the stale-snapshot budget, not just loadFromServer', async () => {
    const Cart = loadCart();
    Cart.items = [ITEM];

    // Two legitimate races earlier in the session (two fast + clicks).
    Cart._staleRefetches = 2;

    // Any successful adoption ends the episode. Before ERR-210 only
    // loadFromServer's own arm did this, so a guest load or a syncWithServer
    // success left the counter at 2 and the very next race tripped the banner.
    Cart._adoptServerSummary(Object.assign({}, SUMMARY));

    assert.equal(Cart._staleRefetches, 0, 'the stale budget must reset on adoption');
    assert.equal(Cart._pricingRefetches, 0, 'so must the one-shot refetch budget');
    assert.equal(Cart._revalidateAttempts, 0, 'and the revalidation budget');
    assert.equal(Cart.pricingState, 'ok');
});

test('a spent stale budget is PENDING, not a failure, while a mutation still owes a read', async () => {
    const Cart = loadCart();
    Cart.items = [ITEM];
    Cart._staleRefetches = 2;
    // A quantity update is mid-flight: _executeQuantityUpdate WILL reload.
    Cart._quantityInFlight['p1'] = true;

    await Cart._handleStaleSnapshot('test');

    assert.equal(Cart.pricingState, 'pending',
        'another read is guaranteed, so this is not a state to warn about');
    assert.equal(Cart.isPricingDegraded(), false);
    assert.equal(paint(Cart), '', 'and nothing is said');
});

test('but with nothing in flight it still settles to STALE_BUDGET and is still degraded', async () => {
    const Cart = loadCart();
    Cart.items = [ITEM];
    Cart._staleRefetches = 2;

    await Cart._handleStaleSnapshot('test');

    assert.equal(Cart.pricingState, 'stale-budget',
        'removing this state would be present->absent, the ERR-158 shape');
    assert.equal(Cart.isPricingDegraded(), true);
});

// ─── 2. Announce AFTER the retry, not instead of it ────────────────────────

test('a fetch that fails and then recovers never paints the banner', async () => {
    let calls = 0;
    const api = {
        getCart: async () => {
            calls++;
            if (calls === 1) throw new Error('Request timed out. Please check your connection and try again.');
            return okCart();
        },
    };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();

    assert.equal(calls, 2, 'the bounded retry must have fired');
    assert.equal(Cart.pricingState, 'ok');
    assertPriced(Cart);
    assert.equal(paint(Cart), '', 'a cold start that warmed up is not the shoppers problem');
});

test('a fetch that never recovers DOES paint it — the deferral is not a suppression', async () => {
    const api = { getCart: async () => { throw new Error('Failed to fetch'); } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();   // don't wait out the 2s backoff in a unit test

    assert.equal(Cart.pricingState, 'fetch-failed');
    const html = paint(Cart);
    assert.notEqual(html, '', 'an exhausted failure must still be disclosed');
    assert.match(html, /couldn't confirm today's prices/i,
        'never priced this page, so the original wording is the true one');
});

test('the banner is DEFERRED while a re-price is on its way, and lands once it is not', async () => {
    const api = { getCart: async () => { throw new Error('Failed to fetch'); } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();
    assert.equal(Cart.isPricingDegraded(), true, 'the fault is real either way');

    // A quantity update is in flight: hold the announcement.
    Cart._quantityInFlight['p1'] = true;
    assert.equal(paint(Cart), '', 'deferred while a re-price is coming');

    // It finishes without fixing anything. The announcement is now owed.
    delete Cart._quantityInFlight['p1'];
    assert.notEqual(paint(Cart), '', 'and it lands — deferral, not suppression');
});

test('revalidation recovers a degraded cart without a manual refresh', async () => {
    let fail = true;
    const api = { getCart: async () => { if (fail) throw new Error('Failed to fetch'); return okCart(); } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();
    assert.equal(Cart.isPricingDegraded(), true);

    fail = false;                                   // the backend warms up
    const recovered = await Cart.revalidatePricing({ reason: 'test' });

    assert.equal(recovered, true, 'and it must SAY it recovered, not just do it');
    assert.equal(Cart.pricingState, 'ok');
    assertPriced(Cart);
    assert.equal(paint(Cart), '', 'the notice clears itself');
});

test('the revalidation budget is bounded and does not stack timers', () => {
    const Cart = loadCart({ api: { getCart: async () => okCart() } });
    const delays = Cart.PRICING_REVALIDATE_DELAYS;
    assert.ok(Array.isArray(delays) && delays.length >= 1);

    for (let i = 0; i < delays.length + 3; i++) {
        Cart._cancelPricingRevalidation();
        Cart._schedulePricingRevalidation('fetch-failed');
    }
    assert.equal(Cart._revalidateAttempts, delays.length,
        'the schedule must stop at the budget, never loop forever against a dead backend');
    Cart._cancelPricingRevalidation();
});

test('a signed-out session schedules nothing — a re-read cannot fix it', () => {
    const Cart = loadCart({ api: { getCart: async () => okCart() } });
    Cart._schedulePricingRevalidation('session-expired');
    assert.equal(Cart._revalidateTimer, null);
    assert.equal(Cart._revalidateAttempts, 0);
});

// ─── 3. The mirror image: {ok:false} must not be silent ────────────────────

test('a 500 envelope is degraded and disclosed, not swallowed by a missing else', async () => {
    const api = { getCart: async () => ({ ok: false, error: 'boom', code: 'INTERNAL_ERROR' }) };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();

    assert.equal(Cart.pricingState, 'server-error',
        'this used to leave pricingState at local-only and show nothing at all');
    assert.equal(Cart.isPricingDegraded(), true);
    assert.notEqual(paint(Cart), '');
});

test('a 429 envelope is degraded too', async () => {
    const api = { getCart: async () => ({ ok: false, error: 'slow down', code: 'RATE_LIMITED' }) };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();

    assert.equal(Cart.pricingState, 'rate-limited');
    assert.equal(Cart.isPricingDegraded(), true);
});

test('a 401 gets the sign-in copy, never the pricing sentence', async () => {
    let calls = 0;
    const api = { getCart: async () => { calls++; return { ok: false, error: 'nope', code: 'UNAUTHORIZED' }; } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();

    assert.equal(Cart.pricingState, 'session-expired');
    assert.equal(calls, 1,
        '_fetchWithAuth already spent its refresh ladder — replaying just asks to be told the same thing');
    assert.equal(Cart._revalidateTimer, null, 'and nothing is scheduled');

    const html = paint(Cart);
    assert.match(html, /sign-?in has expired/i);
    assert.doesNotMatch(html, /confirm today's prices/i,
        'nothing is wrong with the prices; saying so sends them round the same loop');
    assert.match(html, /\/account\/login/, 'and it must offer the way out');
});

// ─── 4. The words have to match the state on screen ────────────────────────

test('priced-then-lost says "last confirmed prices" — the screenshot case', async () => {
    let fail = false;
    const api = { getCart: async () => { if (fail) throw new Error('Failed to fetch'); return okCart(); } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();                    // priced fine
    assert.equal(Cart._everPriced, true);
    assert.equal(Cart.discountAmount, 0.72);

    fail = true;
    await Cart.loadFromServer();                    // and then lost it
    Cart._cancelPricingRevalidation();

    const html = paint(Cart);
    assert.match(html, /last confirmed prices/i);
    assert.doesNotMatch(html, /may not include volume discounts/i,
        'that claim contradicts the savings row printed directly beneath it');
    assert.match(html, /out of date/i, 'the real risk here is staleness, and it must be named');
});

test('the stale savings row STAYS on screen — hiding it would be absence-as-zero', async () => {
    let fail = false;
    const api = { getCart: async () => { if (fail) throw new Error('Failed to fetch'); return okCart(); } };
    const Cart = loadCart({ api });
    Cart.items = [ITEM];

    await Cart.loadFromServer();
    fail = true;
    await Cart.loadFromServer();
    Cart._cancelPricingRevalidation();

    assert.ok(!Cart.hasServerPricing());
    assert.equal(Cart.getDiscount(), 0.72,
        'the backend owns the money — a mismatch is disclosed, never recomputed or dropped (ERR-063/068/149)');
});

test('a shortfall still outranks every degraded variant', async () => {
    const Cart = loadCart();
    Cart.items = [ITEM];
    Cart._losePricing('fetch-failed');
    Cart._cancelPricingRevalidation();

    Cart._renderPricingNotice(4.80);
    assert.match(Cart.__notice.innerHTML, /don't add up/i,
        'a number that is wrong RIGHT NOW beats a number we merely could not confirm');
});

// ─── 5. Positive control ───────────────────────────────────────────────────

test('POSITIVE CONTROL: the gate really runs — an empty cart is the only silent degraded state', async () => {
    const Cart = loadCart();
    Cart._losePricing('fetch-failed');
    Cart._cancelPricingRevalidation();

    Cart.items = [];
    assert.equal(paint(Cart), '', 'nothing to warn about with nothing in the cart');

    Cart.items = [ITEM];
    assert.notEqual(paint(Cart), '',
        'and with items it paints — without this, every "no banner" assertion above '
        + 'could be passing because the renderer never ran at all');
});
