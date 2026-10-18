/**
 * Points pay the whole order (ERR-362; backend response 2026-10-17 "Loyalty
 * points", owner decision 2026-10-16). Unblocks ERR-345.
 *
 *   - $0 mode = the SERVER cart total is exactly 0 with points applied, signed in;
 *   - the order is POST /api/orders with payment_method "points", the SAME body
 *     a card order sends; 201 paid ⇒ confirmation, no card, no PayPal, no wallet;
 *   - every refusal code has words; POINTS_TOTAL_NOT_ZERO brings the card back;
 *   - wallets hide at $0; ad platforms never hear "purchase" for a $0 order.
 *
 * Logic is EXECUTED (methods lifted from the shipping source into a vm). No
 * real order is ever placed by this suite or its probe (owner, 2026-10-18).
 *
 * Run: node --test tests/points-whole-order-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) }; }
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self, globals = {}) {
    const { params, body, async } = extractMethod(read(file), name);
    const ctx = vm.createContext({ Number, String, JSON, encodeURIComponent, Promise, ...globals });
    const fn = vm.runInContext(`(${async ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}
const plain = (v) => JSON.parse(JSON.stringify(v));
function fakeDom(ids) {
    const els = {};
    for (const id of ids) els[id] = { id, textContent: '', innerHTML: '', hidden: true, disabled: false, dataset: {} };
    return { els, document: { body: { dataset: {} }, getElementById: (id) => els[id] || null } };
}
// POINTS_ORDER_ERRORS is an object literal on PaymentPage — lift it as data.
function pointsErrors() {
    const src = read('js/payment-page.js');
    const at = src.indexOf('POINTS_ORDER_ERRORS: {');
    assert.ok(at > 0, 'POINTS_ORDER_ERRORS must exist');
    let depth = 0;
    const open = src.indexOf('{', at);
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return vm.runInNewContext(`(${src.slice(open, i + 1)})`);
    }
    throw new Error('unbalanced POINTS_ORDER_ERRORS');
}

// ─── mode decision (CheckoutPage._syncPointsOrder) ───────────────────────────

function syncHarness({ authed = true, refused = false } = {}) {
    const { els, document } = fakeDom(['checkout-total-note']);
    const calls = [];
    const PaymentPage = { pointsRefused: refused, setPointsMode: (on) => calls.push(on) };
    const self = {};
    const sync = method('js/checkout-page.js', '_syncPointsOrder', self, {
        document, PaymentPage, Auth: { isAuthenticated: () => authed },
    });
    return { sync, els, calls, self };
}

test('$0 mode ON only when the server total is exactly 0 with points applied, signed in', () => {
    const h = syncHarness();
    assert.equal(h.sync({ total: 0, loyalty_points_applied: 4500 }, { points_applied: 4500, shipping_estimated: false }), true);
    assert.deepEqual(h.calls, [true]);
    assert.equal(h.els['checkout-total-note'].hidden, true, 'free shipping is exact: no "estimated" note');

    for (const [summary, loyalty, why] of [
        [{ total: 0.5 }, { points_applied: 4450 }, 'partial cover'],
        [{ total: 0 }, { points_applied: 0 }, '$0 from anything but points is not a points order'],
        [{ total: '0' }, { points_applied: 10 }, 'never a coerced string'],
        [null, { points_applied: 10 }, 'no server summary'],
    ]) {
        const g = syncHarness();
        assert.equal(g.sync(summary, loyalty), false, why);
        assert.deepEqual(g.calls, [false], why);
    }
    assert.equal(syncHarness({ authed: false }).sync({ total: 0 }, { points_applied: 10 }), false, 'a guest has no points');
    assert.equal(syncHarness({ refused: true }).sync({ total: 0 }, { points_applied: 10 }), false, 'after POINTS_TOTAL_NOT_ZERO the card stays');
});

test('"Shipping estimated" beside the $0 total when loyalty.shipping_estimated', () => {
    const h = syncHarness();
    h.sync({ total: 0 }, { points_applied: 4500, shipping_estimated: true });
    assert.equal(h.els['checkout-total-note'].hidden, false);
    assert.equal(h.els['checkout-total-note'].textContent, 'Shipping estimated');
    h.sync({ total: 3 }, { points_applied: 4000, shipping_estimated: true });
    assert.equal(h.els['checkout-total-note'].hidden, true, 'not a $0 order ⇒ no note');
});

// ─── pay button (PaymentPage.setPointsMode / updatePayButton / payLabel) ────

function payHarness(state = {}) {
    const { els, document } = fakeDom(['pay-now-btn', 'pay-button-text', 'points-pay-note']);
    const self = { embedded: true, paymentElementReady: false, isSubmitting: false, ...state };
    self.payLabel = method('js/payment-page.js', 'payLabel', self);
    self.updatePayButton = method('js/payment-page.js', 'updatePayButton', self, { document });
    self.setPointsMode = method('js/payment-page.js', 'setPointsMode', self, { document });
    return { self, els, document };
}

test('points mode: Pay enables WITHOUT a card, says so, and flags <body> for the CSS', () => {
    const h = payHarness();
    h.self.updatePayButton();
    assert.equal(h.els['pay-now-btn'].disabled, true, 'card mode, card incomplete ⇒ disabled');
    h.self.setPointsMode(true);
    assert.equal(h.els['pay-now-btn'].disabled, false);
    assert.equal(h.els['pay-button-text'].textContent, 'Place order — paid with points');
    assert.equal(h.document.body.dataset.pointsOrder, 'on');
    assert.equal(h.els['points-pay-note'].hidden, false);
    h.self.setPointsMode(false);
    assert.equal(h.els['pay-button-text'].textContent, 'Pay now');
    assert.equal(h.els['pay-now-btn'].disabled, true);
    assert.equal(h.document.body.dataset.pointsOrder, 'off');
    // A backend-refused email still holds the button in points mode.
    h.self.setPointsMode(true);
    h.els['pay-now-btn'].dataset.emailBlocked = 'true';
    h.self.updatePayButton();
    assert.equal(h.els['pay-now-btn'].disabled, true);
});

test('handlePayment routes to the points order in points mode, before any card check', () => {
    const body = extractMethod(read('js/payment-page.js'), 'handlePayment').body;
    const at = body.indexOf('if (this.pointsMode) return this.handlePointsOrder();');
    assert.ok(at > 0 && at < body.indexOf('paymentElementReady'), 'points first — a $0 order has no card to check');
});

// ─── the order call (PaymentPage.createPointsOrder) ─────────────────────────

function orderHarness(createOrder) {
    const store = {};
    const sessionStorage = { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
    const location = { href: '' };
    const sent = [];
    const self = {
        POINTS_ORDER_ERRORS: pointsErrors(),
        _orderPayload: async (method, label) => ({ payment_method: method, idempotency_label: label }),
        buildOrderSnapshot: (n, m) => ({ order_number: n, payment_method: m, total: 4.99 }),
    };
    const API = { createOrder: async (b) => { sent.push(b); return createOrder(b); } };
    self.createPointsOrder = method('js/payment-page.js', 'createPointsOrder', self, { API, sessionStorage, window: { location } });
    return { self, store, location, sent };
}

test('201 paid ⇒ snapshot at $0 + confirmation; the body says payment_method "points"', async () => {
    const h = orderHarness(() => ({ ok: true, data: { order_id: 'x', order_number: '2026101612', status: 'paid', payment_method: 'points', payment_required: false, total_amount: 0, points_redeemed: 4500, shipping_cost: 5 } }));
    const out = await h.self.createPointsOrder();
    assert.equal(out.status, 'navigated');
    assert.deepEqual(plain(h.sent), [{ payment_method: 'points', idempotency_label: 'points' }]);
    assert.equal(h.location.href, '/order-confirmation?order=2026101612&paid=points');
    const snap = JSON.parse(h.store.lastOrder);
    assert.equal(snap.total, 0, 'never the display total');
    assert.equal(snap.payment_method, 'points');
    assert.equal(snap.points_redeemed, 4500);
});

test('a 2xx that is not a paid $0 order is never treated as one', async () => {
    const h = orderHarness(() => ({ ok: true, data: { order_number: 'N', status: 'pending', payment_required: true, client_secret: 'cs' } }));
    const out = await h.self.createPointsOrder();
    assert.equal(out.status, 'refused');
    assert.equal(h.location.href, '');
    assert.ok(!('lastOrder' in h.store));
});

test('every refusal code has words; the shapes api.js returns are all read', async () => {
    const ERR = pointsErrors();
    for (const code of ['POINTS_REQUIRE_ACCOUNT', 'POINTS_NOT_APPLIED', 'POINTS_TOTAL_NOT_ZERO', 'INSUFFICIENT_POINTS',
        'POINTS_ORDER_FAILED', 'PENDING_PAYMENT_IN_PROGRESS', 'DUPLICATE_REQUEST', 'POINTS_PAYMENT_REQUIRED']) {
        assert.ok(ERR[code] && ERR[code].text, `${code} needs shopper words`);
    }
    assert.equal(ERR.POINTS_TOTAL_NOT_ZERO.retry, 'card');

    // 409 — resolved envelope, details under data.error.details
    let h = orderHarness(() => ({ ok: false, code: 'PENDING_PAYMENT_IN_PROGRESS', error: 'x', data: { error: { details: { order_number: '2026101599' } } } }));
    let out = await h.self.createPointsOrder();
    assert.equal(out.code, 'PENDING_PAYMENT_IN_PROGRESS');
    assert.match(out.text, /Order 2026101599/);
    // 400 — api.js THROWS with .code/.details
    h = orderHarness(() => { const e = new Error('No points'); e.code = 'POINTS_NOT_APPLIED'; throw e; });
    out = await h.self.createPointsOrder();
    assert.equal(out.code, 'POINTS_NOT_APPLIED');
    assert.match(out.text, /check there before trying again/);
    // 401 — generic code, the backend's reason in server_code
    h = orderHarness(() => ({ ok: false, code: 'UNAUTHORIZED', server_code: 'POINTS_REQUIRE_ACCOUNT', error: 'x' }));
    out = await h.self.createPointsOrder();
    assert.equal(out.code, 'POINTS_REQUIRE_ACCOUNT');
    // 409 POINTS_TOTAL_NOT_ZERO ⇒ back to the card
    h = orderHarness(() => ({ ok: false, code: 'POINTS_TOTAL_NOT_ZERO', data: { error: { details: { total: 3, points_applied: 4500 } } } }));
    out = await h.self.createPointsOrder();
    assert.equal(out.retry, 'card');
    // unknown ⇒ the server's message, never blank
    h = orderHarness(() => ({ ok: false, code: 'SOMETHING_NEW', error: 'Server says no' }));
    assert.equal((await h.self.createPointsOrder()).text, 'Server says no');
});

test('one body for card, wallet and points orders; only payment_method varies', () => {
    const src = stripComments(read('js/payment-page.js'));
    assert.match(src, /async _orderPayload\(paymentMethod, idempotencyLabel\)/);
    assert.match(src, /payment_method: paymentMethod,/);
    assert.equal((src.match(/API\.createOrder\(await this\._orderPayload\(/g) || []).length, 2, 'createStripeOrder + createPointsOrder');
    assert.match(src, /API\.createOrder\(await this\._orderPayload\('stripe', idempotencyLabel\)\)/);
    assert.match(src, /API\.createOrder\(await this\._orderPayload\('points', 'points'\)\)/);
    assert.doesNotMatch(src, /payment_method: 'stripe',/, 'no second hand-written body');
});

test('POINTS_TOTAL_NOT_ZERO latches the card until the points change', () => {
    const PP = stripComments(read('js/payment-page.js'));
    assert.match(PP, /if \(out\.code === 'POINTS_TOTAL_NOT_ZERO'\) this\.pointsRefused = true;/);
    assert.match(PP, /await CheckoutPage\.refreshLoyalty\(\);/);
    const CP = stripComments(read('js/checkout-page.js'));
    assert.equal((CP.match(/PaymentPage\.pointsRefused = false/g) || []).length, 2, 'apply and remove both clear it');
    assert.match(CP, /this\.refreshLoyalty = refreshFromCart;/);
    assert.match(CP, /self\._syncPointsOrder\(summary, data\.loyalty \|\| null\);/);
    assert.match(CP, /CartWallet\.sync\(\)/, 'the wallet follows the cart this control changed');
});

test('Elements never get a sub-50c amount (a $0 total used to throw "Unable to load order total")', () => {
    const body = extractMethod(read('js/payment-page.js'), 'calculateTotals').body;
    assert.match(body, /if \(amountCents >= STRIPE_MIN_NZD_CENTS\) \{\s*if \(this\.elements\) this\.elements\.update/);
});

// ─── loyalty control ────────────────────────────────────────────────────────

test('loyalty control: the full cover is submittable (step 1) and refusals offer both amounts', () => {
    const CP = stripComments(read('js/checkout-page.js'));
    assert.match(CP, /input\.step = '1';/, 'step 100 made the browser refuse a cent-exact full cover');
    assert.doesNotMatch(CP, /input\.step = '100'/);
    assert.match(CP, /case 'LEAVES_UNPAYABLE_BALANCE':/);
    assert.match(CP, /case 'TEST_CART_NO_DISCOUNTS':/);
    assert.match(CP, /offerChoices\(err && err\.details\)/, '400 details (api.js throws)');
    assert.match(CP, /details\.full_cover_points/);
    assert.match(CP, /details\.max_partial_points/);
});

// ─── wallets ────────────────────────────────────────────────────────────────

test('wallet: a $0 server total is never a wallet order', () => {
    const self = { STRIPE_MIN_NZD_CENTS: 50 };
    const Cart = { serverSummary: null, items: [{ id: 'p', quantity: 1 }] };
    self._summary = () => Cart.serverSummary;
    self._items = () => Cart.items.map((i) => ({ product_id: i.id, quantity: i.quantity }));
    self._initialRate = method('js/cart-wallet.js', '_initialRate', self);
    self._amountCents = method('js/cart-wallet.js', '_amountCents', self);
    self._eligibleCents = method('js/cart-wallet.js', '_eligibleCents', self);
    Cart.serverSummary = { subtotal: 40, discount: 40, shipping: 0, qualifies_for_free_shipping: true, total: 0 };
    assert.ok(Number.isNaN(self._eligibleCents()));
    Cart.serverSummary = { subtotal: 40, discount: 5, shipping: 0, qualifies_for_free_shipping: true, total: 35 };
    assert.equal(self._eligibleCents(), 3500, 'positive control: a normal cart is still a wallet order');
    const CSS = stripComments(read('css/cart-checkout.css'));
    assert.match(CSS, /body\[data-points-order="on"\] section\.checkout-page \.checkout-express/);
    assert.match(CSS, /body\[data-points-order="on"\] section\.checkout-page \.payment-col-alt/);
    assert.match(CSS, /body\[data-points-order="on"\] section\.checkout-page \.payment-element-wrapper/);
});

// ─── confirmation ───────────────────────────────────────────────────────────

test('confirmation: no ad-platform purchase for a $0 / points order; first-party funnel still records it', () => {
    const calls = [];
    const mk = (order, detected) => {
        const self = { _conversionFired: false, _paymentSucceeded: true, orderData: order, detectedPaymentMethod: detected };
        const store = {};
        return method('js/order-confirmation-page.js', 'markConversion', self, {
            localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
            gtag: (...a) => calls.push(['gtag', a[1]]),
            AdsRemarketing: { items: () => [], event: (n) => calls.push(['remarketing', n]) },
            UetTag: { purchase: () => calls.push(['uet']) },
            CartAnalytics: { trackOrderCompleted: () => calls.push(['funnel']) },
            Array,
        });
    };
    mk({ orderNumber: 'A1', total: 0, items: [] }, 'points')();
    assert.deepEqual(calls, [['funnel']], '$0 points order: funnel only');
    calls.length = 0;
    mk({ orderNumber: 'A2', total: 0, paymentMethod: 'points', items: [] })();
    assert.deepEqual(calls, [['funnel']]);
    calls.length = 0;
    mk({ orderNumber: 'A3', total: 25, paymentMethod: 'stripe', items: [] })();
    assert.deepEqual(calls.map((c) => c[0]), ['gtag', 'remarketing', 'uet', 'funnel'], 'positive control: a paid order still converts');
});

test('confirmation: ?paid=points clears the cart; label + $0.00 total render', () => {
    const src = stripComments(read('js/order-confirmation-page.js'));
    assert.match(src, /const paidByPoints = urlParams\.get\('paid'\) === 'points';/);
    assert.match(src, /if \(redirectStatus === 'succeeded' \|\| paidByPoints\) \{/);
    assert.match(src, /'points': 'Loyalty points'/);
    assert.match(src, /order\.total != null && Number\.isFinite\(parseFloat\(order\.total\)\)/);
});

test('markup: the note and the $0 hint each have ONE writer', () => {
    const H = read('html/checkout.html');
    assert.match(H, /<p class="checkout-summary__total-note" id="checkout-total-note" hidden><\/p>/);
    assert.match(H, /<p class="points-pay-note" id="points-pay-note" hidden>/);
    const all = ['js/checkout-page.js', 'js/payment-page.js', 'js/cart.js', 'js/cart-page.js'].map((f) => stripComments(read(f))).join('\n');
    assert.equal((all.match(/checkout-total-note/g) || []).length, 1, 'only _syncPointsOrder writes the note');
    assert.equal((all.match(/points-pay-note/g) || []).length, 1, 'only setPointsMode writes the hint');
    assert.equal((all.match(/dataset\.pointsOrder =/g) || []).length, 1);
});

test('api.js keeps the backend 401 reason as server_code (additive)', () => {
    const src = stripComments(read('js/api.js'));
    assert.match(src, /const env = \{ ok: false, error: errorMsg, code: 'UNAUTHORIZED' \};\s*if \(errorCode && errorCode !== 'UNAUTHORIZED'\) env\.server_code = errorCode;/);
});
