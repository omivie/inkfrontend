/**
 * The cart emptied itself and called the result healthy (Sep 2026)
 * ===============================================================
 *
 * ERR-259. Found while re-verifying ERR-256 — a GA4 `add_shipping_info` hit went
 * out of a real production browser carrying `value=0`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `loadFromServer()` adopted an empty server cart UNCONDITIONALLY:
 *
 *     this.items = parsed.items;              // [] — the shopper's line is gone
 *     this._adoptServerSummary(parsed.summary);// pricingState = OK, _everPriced = true
 *
 * So the cart threw the line away AND reported itself healthy. No notice, no
 * degraded state, nothing on any channel a shopper or a test could read.
 *
 * WHAT MADE IT SHOPPER-VISIBLE IS A LOOP, AND THE LOOP RUNS THROUGH THE RECOVERY
 * MACHINERY RATHER THAN AROUND IT:
 *
 *   1. a guest add that does not get a 2xx (a 429, a Render cold start) leaves
 *      the line in localStorage only;
 *   2. `loadCart()`'s guest branch handles that CORRECTLY — server empty, local
 *      non-empty, so it drops to SERVER_EMPTY and keeps the line;
 *   3. SERVER_EMPTY is in PRICING_DEGRADED, which is exactly what arms the
 *      bounded auto-revalidation added for ERR-210;
 *   4. that fires, calls `loadFromServer()`, and `loadFromServer()` threw the
 *      guard's work away and marked the result `ok`.
 *
 * ***The recovery path undid the guard the load path had correctly applied, and
 * called the result healthy.*** Which is why every guarded site looked right and
 * the symptom happened anyway. §5 is that loop, and it is the assertion that
 * would have caught this.
 *
 * Measured on production 2026-09-13 at the checkout's delivery step:
 * `items=0, subtotal=0, hasServerPricing()=true, pricingState='ok'`, with the
 * line still in localStorage — and the shopper had just been toasted "Item saved
 * locally. It will sync when connection is restored." Re-measured 2026-09-16
 * with the add returning 201: `lines=1, subtotal=5.99`. That pair is the
 * positive control for the diagnosis; the first run alone was only a
 * correlation, and it was first written up blaming the wrong thing (the
 * hostname).
 *
 * THE OPPOSITE MISTAKE IS WORSE THAN THE ONE BEING FIXED. A guard that keeps
 * local items whenever the server says empty would RESURRECT a line the shopper
 * deliberately removed — silently, and into the server on the next sync. §3 and
 * §4 are those cases, and they matter more than §1.
 *
 * WHY THE SOURCE ASSERTIONS ELSEWHERE ARE NOT ENOUGH
 * --------------------------------------------------
 * `cart-removal-durability-jul2026.test.js` §6.3 pins the guard's ORDER in the
 * source. It cannot see what `pricingState` ends up as, and the bug is entirely
 * about the value two state-setters leave behind. So this file EXECUTES the real
 * cart.js against a scripted API, exactly as the ERR-210 suite next door does.
 *
 * Run: node --test tests/cart-empty-server-adoption-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const CART_PATH = path.join(ROOT, 'inkcartridges', 'js', 'cart.js');
const CART_SRC = fs.readFileSync(CART_PATH, 'utf8');
const CART_CODE = stripComments(CART_SRC);

function makeEl(id) {
    return {
        id, hidden: true, textContent: '', innerHTML: '',
        style: {}, dataset: {},
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
 * Load the real cart.js into a sandbox and hand back `Cart`.
 *
 * `const Cart = {...}` at the top level of a classic script is a LEXICAL
 * binding, not a property of the global object (the ERR-156/167 family), so it
 * has to be handed out explicitly. Same lift as the ERR-210 suite.
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
            querySelector: () => null,
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
    vm.runInContext(CART_SRC + '\n;globalThis.__Cart = Cart;', sandbox, { filename: 'cart.js' });

    const Cart = sandbox.__Cart;
    // `loading` ships TRUE and is cleared by loadCart()'s finally. These tests
    // drive the read functions directly, so the page has to be told it settled —
    // otherwise assertions pass on the loading deferral instead of the claim.
    Cart.loading = false;
    Cart.__sandbox = sandbox;
    Cart.__store = store;
    return Cart;
}

const SUMMARY = { subtotal: 29.95, discount: 0, total: 29.95, shipping: 0 };

/**
 * A server cart with one real line.
 *
 * `_parseServerCart` DROPS any line without a nested `product`, so a flat stub
 * parses to ZERO items — which would make every "the line survived" assertion
 * below pass for entirely the wrong reason, and every "empty was adopted" one
 * pass without the guard ever running. The shape matters.
 */
const serverWithLine = () => ({
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

/** The measured production shape: no lines, but a summary, so it looks priced. */
const serverEmptyButPriced = () => ({
    ok: true,
    data: { items: [], summary: { subtotal: 0, discount: 0, total: 0, shipping: 0 } },
});

/** A local line, as localStorage holds it after an add the server refused. */
const localLine = (over = {}) => Object.assign({
    id: 'p1', key: 'core:CBCI3BK', name: 'BCI3BK Compatible Ink Cartridge',
    sku: 'CBCI3BK', price: 5.99, quantity: 5, source: 'core',
}, over);

/** Put the cart in the state a refused add leaves behind. */
function seedLocalOnly(Cart) {
    Cart.items = [localLine()];
    Cart.serverSummary = null;
    Cart.pricingState = Cart.__sandbox.PRICING.SERVER_EMPTY;
    return Cart;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE BUG — an empty server answer must not silently empty a held cart
// ═══════════════════════════════════════════════════════════════════════════

test('§1 loadFromServer KEEPS local lines when the server answers empty', async () => {
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    seedLocalOnly(Cart);

    await Cart.loadFromServer();

    assert.equal(Cart.items.length, 1,
        'the shopper still holds this line — it was never confirmed removed');
    assert.equal(Cart.items[0].sku, 'CBCI3BK');
});

test('§1b and it reports the state as DEGRADED, not ok', async () => {
    // This is the half that made it invisible. Before the fix pricingState was
    // 'ok' and hasServerPricing() was true, so nothing anywhere said a word.
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    seedLocalOnly(Cart);

    await Cart.loadFromServer();

    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.SERVER_EMPTY,
        'an unexplained empty server cart is a degraded episode, not a healthy read');
    // `hasServerPricing()` is `this.serverSummary && ...`, so with no summary it
    // answers null rather than false. Every caller reads it truthily, so assert
    // the CLAIM (we are not priced) and not the return type.
    assert.ok(!Cart.hasServerPricing(), 'the cart must not report itself as priced');
    assert.equal(Cart.serverSummary, null,
        'a zero summary must not be adopted — that is what reported value=0 to GA4');
    assert.equal(Cart.isPricingDegraded(), true,
        'degraded means the shopper gets the existing notice instead of silence');
});

test('§1c the zero subtotal never becomes a reportable cart value', async () => {
    // The GA4 link: Ga4Ecommerce reads getSubtotal()/hasServerPricing(), so a
    // server-confirmed 0 here is what a real add_shipping_info hit carried.
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    seedLocalOnly(Cart);

    await Cart.loadFromServer();

    assert.ok(!Cart.hasServerPricing(),
        'nothing downstream may believe this cart was priced at 0');
    assert.ok(Cart.getSubtotal() > 0,
        'the local estimate stands in, and it is a real number for a real line');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POSITIVE CONTROL — the guard must not block a normal read
// ═══════════════════════════════════════════════════════════════════════════

test('§2 a server cart WITH lines is adopted exactly as before', async () => {
    // Without this, §1 could pass on a guard that refuses every server answer,
    // which would freeze every cart on its local estimate for ever.
    const Cart = loadCart({ api: { getCart: async () => serverWithLine() } });
    Cart.items = [localLine({ price: 999 })];   // stale local price
    Cart.pricingState = Cart.__sandbox.PRICING.LOCAL_ONLY;

    await Cart.loadFromServer();

    assert.equal(Cart.items.length, 1);
    assert.equal(Cart.items[0].price, 5.99, "the server's fresh price won");
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.OK);
    assert.equal(Cart.hasServerPricing(), true);
    assert.equal(Cart.getSubtotal(), 29.95, 'the server summary is in use');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3+4. THE OPPOSITE MISTAKE — a genuinely emptied cart must STAY empty
//
// These matter more than §1. Resurrecting a line the shopper removed is silent,
// reaches the server on the next sync, and can be charged for.
// ═══════════════════════════════════════════════════════════════════════════

test('§3 both sides empty is a REAL empty cart, and is adopted', async () => {
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    Cart.items = [];
    Cart.pricingState = Cart.__sandbox.PRICING.LOCAL_ONLY;

    await Cart.loadFromServer();

    assert.equal(Cart.items.length, 0);
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.OK,
        'nothing is wrong here — an empty cart the server agrees about is healthy');
});

test('§4 a line that is a PENDING REMOVAL must never be resurrected', async () => {
    // The shopper removed their last item; the DELETE is in flight. The server
    // already answers empty and is RIGHT. If the guard counted that line as
    // "we still hold it", the removal would be undone.
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    Cart.items = [localLine()];
    Cart._removingItems.add('p1');            // the in-flight removal
    Cart.pricingState = Cart.__sandbox.PRICING.LOCAL_ONLY;

    await Cart.loadFromServer();

    assert.equal(Cart.items.length, 0,
        'the removal stands — the guard must not resurrect a line the shopper removed');
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.OK,
        'and this is a legitimately empty cart, so it is not a degraded episode');
});

test('§4b the predicate itself is what makes that distinction', () => {
    const Cart = loadCart();
    Cart.items = [localLine()];
    assert.equal(Cart._serverEmptyButWeHoldLines([]), true, 'a held line, server empty');

    Cart._removingItems.add('p1');
    assert.equal(Cart._serverEmptyButWeHoldLines([]), false,
        'a line under removal is not a line we hold');

    Cart._removingItems.clear();
    assert.equal(Cart._serverEmptyButWeHoldLines([{ id: 'x' }]), false,
        'the server is not empty, so there is nothing to guard against');
    Cart.items = [];
    assert.equal(Cart._serverEmptyButWeHoldLines([]), false, 'nothing held, nothing to keep');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE LOOP — the ERR-210 revalidation must not undo the guard
//
// This is the assertion that would have caught the original bug. Every other
// test here passes on a single read; the shopper-visible failure needed two.
// ═══════════════════════════════════════════════════════════════════════════

test('§5 a degraded cart stays degraded while the server keeps answering empty', async () => {
    let reads = 0;
    const Cart = loadCart({ api: { getCart: async () => { reads++; return serverEmptyButPriced(); } } });
    seedLocalOnly(Cart);

    // First read: the guard fires, exactly as §1.
    await Cart.loadFromServer();
    assert.equal(Cart.items.length, 1);
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.SERVER_EMPTY);

    // Now the ERR-210 recovery runs, which is what broke it. Its whole job is to
    // clear a degraded episode, and before the fix it "succeeded" by adopting
    // the empty cart and calling it ok.
    const recovered = await Cart.revalidatePricing({ reason: 'test' });

    assert.equal(recovered, false,
        'nothing was recovered — the server still has no cart to price');
    assert.equal(Cart.items.length, 1,
        'THE LOOP: the revalidation must not throw away the line the guard kept');
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.SERVER_EMPTY,
        'and it must not relabel a degraded cart as healthy');
    assert.ok(!Cart.hasServerPricing());
    assert.ok(reads >= 2, 'the revalidation really did re-read, so this was exercised');
});

test('§5b and it DOES recover the moment the server has the cart again', async () => {
    // The mirror image, and the reason §5 is not just "never recover". A backend
    // that comes back must clear the degraded state and the notice with it.
    let first = true;
    const Cart = loadCart({
        api: {
            getCart: async () => {
                if (first) { first = false; return serverEmptyButPriced(); }
                return serverWithLine();
            },
        },
    });
    seedLocalOnly(Cart);

    await Cart.loadFromServer();
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.SERVER_EMPTY);

    const recovered = await Cart.revalidatePricing({ reason: 'test' });

    assert.equal(recovered, true);
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.OK);
    assert.equal(Cart.getSubtotal(), 29.95);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. syncWithServer keeps the behaviour it always had
// ═══════════════════════════════════════════════════════════════════════════

test('§6 syncWithServer still guards, now through the shared predicate', async () => {
    const Cart = loadCart({ api: { getCart: async () => serverEmptyButPriced() } });
    Cart.items = [localLine()];
    Cart.pricingState = Cart.__sandbox.PRICING.LOCAL_ONLY;

    await Cart.syncWithServer();

    assert.equal(Cart.items.length, 1, 'the behaviour predates this change and must survive it');
    assert.equal(Cart.pricingState, Cart.__sandbox.PRICING.SERVER_EMPTY);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. One owner, and one deliberate omission
// ═══════════════════════════════════════════════════════════════════════════

test('§7 the rule is declared once and called by both read paths', () => {
    const decls = CART_CODE.match(/_serverEmptyButWeHoldLines\(parsedItems\)\s*\{/g) || [];
    assert.equal(decls.length, 1, 'one declaration — three spellings is what hid the gap');
    const calls = CART_CODE.match(/this\._serverEmptyButWeHoldLines\(/g) || [];
    assert.equal(calls.length, 2, 'loadFromServer and syncWithServer, and nothing else');
});

test('§7b the quantity-update path is deliberately NOT guarded', () => {
    // A quantity of zero removes the line, so an empty cart there is the point of
    // the request. Guarding it would resurrect what the shopper just removed.
    const at = CART_CODE.indexOf('async _executeQuantityUpdate(');
    assert.notEqual(at, -1);
    const body = CART_CODE.slice(at, CART_CODE.indexOf('\n    },', at));
    assert.doesNotMatch(body, /_serverEmptyButWeHoldLines/);
    assert.match(CART_SRC, /DELIBERATELY NOT GUARDED by _serverEmptyButWeHoldLines/,
        'the omission is explained where it lives, so it reads as a decision');
});

test('§7c the guard cannot spin — the revalidation budget is finite', () => {
    // The guard leaves the cart degraded, and a degraded state schedules a
    // revalidation, which re-enters the guard. That is only safe because the
    // budget is bounded and ONLY _adoptServerSummary resets it — which this
    // branch deliberately never reaches.
    assert.match(CART_CODE, /PRICING_REVALIDATE_DELAYS: \[/);
    assert.match(CART_CODE, /this\._revalidateAttempts >= this\.PRICING_REVALIDATE_DELAYS\.length\) return/,
        'the scheduler must refuse once the budget is spent');
    const adopt = CART_CODE.slice(CART_CODE.indexOf('_adoptServerSummary(summary)'));
    assert.match(adopt.slice(0, 600), /_revalidateAttempts = 0/,
        'and a genuine recovery is the only thing that resets it');
});
