/**
 * FE master checklist — the backend's 6 October re-check (ERR-307)
 * =============================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md, "Status after the
 * live check on 6 October 2026". Items 5/6/7/8/10/13 shipped in 831569a8 after
 * that check ran; this file pins what was still open in the code:
 *
 *   §14  the cart's unit price follows the quantity's rung (GLC3313BK: qty 3
 *        reads $66.14, not $67.49) in BOTH price cells and in both renderers;
 *        the summary never shows the previous quantity's server rows beside a
 *        new subtotal; the PUT's own `data.cart` is adopted (one request, not
 *        two) behind a mutation-epoch guard; "Updating…" always ends.
 *   §15  a guest email the backend refused (VALIDATION_FAILED on `email`) is
 *        shown under the field and holds "Continue to payment"; a 429 / 5xx /
 *        network error FAILS OPEN; a typo hint never blocks; /payment's
 *        `guest_email` refusal is shown beside Pay with a way back that keeps
 *        the form (order 2026100602, $486.81).
 *   §9   "Proceed to Checkout" uses a verdict fetched while the shopper read
 *        the cart, keyed by the mutation epoch.
 *   §6   the PDP line says "reward points".
 *
 * Behaviour is EXECUTED (the real cart.js in a vm; real methods extracted from
 * checkout-page.js / payment-page.js), so a test cannot pass on a comment.
 *
 * Run: node --test tests/fe-master-checklist-6oct-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractMethod(raw, name) {
    // Comments carry apostrophes ("don't") that would read as open quotes.
    const src = stripComments(raw);
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = extractMethod(stripComments(read(file)), name);
    const ctx = vm.createContext({ formatPrice: (n) => '$' + Number(n).toFixed(2), setTimeout, clearTimeout, Promise, Date, JSON, Math, Number, ...globals });
    const fn = vm.runInContext(`(${async ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}

// ─── a scriptable DOM element ───────────────────────────────────────────────
function makeEl(id) {
    const attrs = {};
    return {
        id, hidden: false, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} },
        setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null }, removeAttribute(k) { delete attrs[k]; },
        addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
        focus() {}, scrollIntoView() {},
    };
}

// ─── the real cart.js in a sandbox ──────────────────────────────────────────
const CART_SRC = read('js/cart.js');
function loadCart(api = {}) {
    const els = Object.create(null);
    const getEl = (id) => (els[id] || (els[id] = makeEl(id)));
    const summaryEl = makeEl('summary');
    const store = Object.create(null);
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        navigator: { onLine: true },
        document: {
            getElementById: getEl,
            querySelector: (sel) => (sel === '.cart-summary' ? summaryEl : null),
            querySelectorAll: () => [],
            addEventListener() {}, visibilityState: 'visible',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        Security: { escapeHtml: (v) => String(v), escapeAttr: (v) => String(v) },
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        showToast() {},
        API: api,
        Auth: { initialized: true, isAuthenticated: () => false, onAuthStateChange() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CART_SRC + '\n;globalThis.__Cart = Cart; globalThis.__PRICING = PRICING;', sandbox, { filename: 'cart.js' });
    const Cart = sandbox.__Cart;
    Cart.loading = false;
    Cart.__els = new Proxy(els, { get: (_t, id) => getEl(id) });
    Cart.__summary = summaryEl;
    Cart.__PRICING = sandbox.__PRICING;
    return Cart;
}

// GLC3313BK as served by GET /api/products/GLC3313BK on 2026-10-06.
const LADDER = [
    { min_quantity: 3, business_price: 66.14, savings_amount: 1.35 },
    { min_quantity: 4, business_price: 65.47, savings_amount: 2.02 },
    { min_quantity: 7, business_price: 63.44, savings_amount: 4.05 },
    { min_quantity: 8, business_price: 62.09, savings_amount: 5.40 },
];
const line = (quantity, extra = {}) => ({ id: 'p1', sku: 'GLC3313BK', price: 67.49, quantity, quantity_breaks: LADDER, volume_figures: null, ...extra });

/** A server cart line for GLC3313BK at `qty` (shape of GET /api/cart `data.items[]`). */
function serverLine(qty) {
    const unit = qty >= 3 ? 66.14 : 67.49;
    return {
        id: 'row1', quantity: qty,
        product: { id: 'p1', sku: 'GLC3313BK', name: 'Brother LC3313 Black', retail_price: 67.49 },
        quantity_breaks: LADDER,
        line_total: Math.round(67.49 * qty * 100) / 100,
        line_total_after_discount: Math.round(unit * qty * 100) / 100,
        volume_unit_price: qty >= 3 ? 66.14 : null,
        volume_line_savings: qty >= 3 ? Math.round((67.49 - 66.14) * qty * 100) / 100 : 0,
    };
}
function serverCart(qty) {
    const sub = Math.round(67.49 * qty * 100) / 100;
    const vol = qty >= 3 ? Math.round((67.49 - 66.14) * qty * 100) / 100 : 0;
    const free = sub - vol >= 100;
    return {
        items: [serverLine(qty)],
        summary: { subtotal: sub, discount: vol, shipping: free ? 0 : 7, total: Math.round((sub - vol + (free ? 0 : 7)) * 100) / 100, qualifies_for_free_shipping: free, is_shipping_estimate: true },
        loyalty: { earn_on_this_order: Math.floor(sub - vol) },
    };
}
function primeCart(Cart, qty) {
    const parsed = Cart._parseServerCart(serverCart(qty));
    Cart.items = parsed.items;
    Cart._adoptServerSummary(parsed.summary);
    Cart.loyalty = parsed.loyalty;
}

// ═══ §14 unit price = the quantity's rung ════════════════════════════════════

test('§14 unitPriceFor reads the rung (GLC3313BK, live ladder) — 1,2 retail; 3 → 66.14; boundaries', () => {
    const Cart = loadCart();
    const at = (q) => Cart.unitPriceFor(line(q));
    assert.equal(at(1), 67.49);
    assert.equal(at(2), 67.49, 'below the first rung ⇒ retail');
    assert.equal(at(3), 66.14, 'the owner\'s report: qty 3 must read $66.14');
    assert.equal(at(4), 65.47);
    assert.equal(at(6), 65.47, 'highest rung with min_quantity ≤ quantity');
    assert.equal(at(7), 63.44);
    assert.equal(at(100), 62.09);
});

test('§14 the server\'s own figures win while they describe this quantity; stale ones are ignored', () => {
    const Cart = loadCart();
    const fig = (quantity, unit_price) => ({ quantity, line_total: 0, line_total_after_discount: 1, unit_price, line_savings: 0 });
    assert.equal(Cart.unitPriceFor(line(3, { volume_figures: fig(3, 66.00) })), 66.00, 'server unit price for this quantity');
    assert.equal(Cart.unitPriceFor(line(3, { volume_figures: fig(3, null) })), 67.49, 'server priced THIS quantity with no volume ⇒ retail, never a ladder guess');
    assert.equal(Cart.unitPriceFor(line(3, { volume_figures: fig(1, null) })), 66.14, 'figures for the OLD quantity ⇒ the ladder');
    assert.equal(Cart.unitPriceFor(line(3, { quantity_breaks: null })), 67.49, 'no ladder ⇒ retail');
    assert.equal(Cart.unitPriceFor(line(3, { quantity_breaks: [{ min_quantity: 3, business_price: 70 }] })), 67.49, 'a rung above retail is never shown');
    assert.equal(Cart.unitPriceFor(line(3, { quantity_breaks: [{ min_quantity: 3, business_price: 'x' }] })), 67.49);
});

test('§14 unitPriceHtml: retail struck beside the rung price; ex-GST carries the SAME figure', () => {
    const Cart = loadCart();
    const h3 = Cart.unitPriceHtml(line(3));
    assert.match(h3, /<s class="cart-item__price-was">\$67\.49<\/s> <span class="cart-item__price-now">\$66\.14<\/span>/);
    assert.match(h3, /data-exgst="66\.14"/);
    const h1 = Cart.unitPriceHtml(line(1));
    assert.doesNotMatch(h1, /<s /);
    assert.match(h1, /^\$67\.49 /);
    assert.match(h1, /data-exgst="67\.49"/);
});

test('§14 in flight, the line total is rung × quantity ($198.42), not retail × quantity ($202.47)', () => {
    const Cart = loadCart();
    const h = Cart.lineTotalHtml(line(3));
    assert.match(h, /<s class="cart-item__total-was">\$202\.47<\/s>/);
    assert.match(h, /<span class="cart-item__total-now">\$198\.42<\/span>/);
    assert.equal(Cart.lineTotalHtml(line(1)), '$67.49', 'no rung ⇒ plain retail');
});

test('§14 both price cells use unitPriceHtml, in the full render AND the surgical path', () => {
    const code = stripComments(CART_SRC);
    assert.match(code, /<p class="cart-item__price-mobile">' \+ self\.unitPriceHtml\(item\)/);
    assert.match(code, /<div class="cart-item__price">\\\s*' \+ self\.unitPriceHtml\(item\)/);
    const surgical = stripComments(extractMethod(CART_SRC, '_updateCartItemDOM').body);
    assert.match(surgical, /querySelectorAll\('\.cart-item__price-mobile, \.cart-item__price'\)/, 'both cells, not just mobile');
    assert.match(surgical, /this\.unitPriceHtml\(item\)/);
    assert.doesNotMatch(surgical, /formatPrice\(item\.price\)/, 'no retail-only repaint left');

    // Executed: the surgical repaint reaches both cells.
    const Cart = loadCart();
    Cart.items = [line(3)];
    const cells = [makeEl('m'), makeEl('d')];
    const itemEl = makeEl('row');
    itemEl.querySelector = () => null;
    itemEl.querySelectorAll = (sel) => (sel === '.cart-item__price-mobile, .cart-item__price' ? cells : []);
    const doc = { activeElement: null, querySelector: (sel) => (sel.startsWith('.cart-item[') ? itemEl : null) };
    method('js/cart.js', '_updateCartItemDOM', Cart, { document: doc })('p1');
    cells.forEach((c) => assert.match(c.innerHTML, /\$66\.14/, 'each cell shows the rung price'));
});

// ═══ §14 never a mix of two quantities ═══════════════════════════════════════

test('§14 a + click drops the old quantity\'s server summary (no retail-delta patch) and paints "Updating…"', async () => {
    let release;
    const Cart = loadCart({
        updateCartItem: () => new Promise((r) => { release = () => r({ ok: true, data: { message: 'ok', id: 'row1', quantity: 3, cart: serverCart(3) } }); }),
        getCart: async () => { throw new Error('the PUT carried the cart — no GET'); },
    });
    primeCart(Cart, 1);
    assert.equal(Cart.pricingState, 'ok');
    Cart.__els['cart-savings-row'].hidden = false; // as if a previous quantity had shown a discount
    Cart.__els['cart-points-earn'].hidden = false;

    Cart._debouncedQuantityUpdate(Cart.items[0].key || 'p1', 3);
    assert.equal(Cart.pricingState, 'pending');
    assert.equal(Cart.serverSummary, null, 'the qty-1 summary is gone, not patched');
    assert.equal(Math.round(Cart.getSubtotal() * 100) / 100, 202.47, 'subtotal = pre-discount retail, the server\'s own meaning');

    Cart._paintSummaryPending();
    const e = Cart.__els;
    for (const id of ['cart-total', 'cart-shipping', 'cart-gst', 'cart-points-earn-value']) {
        assert.equal(e[id].textContent, 'Updating…', `${id} says Updating…`);
    }
    assert.equal(e['cart-total-row'].dataset.totalSource, 'pending');
    for (const id of ['cart-savings-row', 'cart-loyalty-row', 'cart-b2b-row', 'cart-shipping-message', 'cart-shipping-bar']) {
        assert.equal(e[id].hidden, true, `${id} hidden while pending`);
    }
    assert.equal(Cart.__summary.getAttribute('aria-busy'), 'true');

    await sleep(450); // the 400 ms debounce fires the PUT
    release();
    await sleep(10);
    assert.equal(Cart.pricingState, 'ok', 'the PUT\'s cart re-priced it');
    assert.equal(Cart.serverSummary.total, 198.42);
    assert.equal(Cart.serverSummary.discount, 4.05);
    assert.equal(Cart.loyalty.earn_on_this_order, 198, 'loyalty adopted from the same answer');
    Cart._paintSummaryPending();
    assert.equal(Cart.__summary.getAttribute('aria-busy'), null);
    clearTimeout(Cart._pendingWatchdog);
});

test('§14 a PUT answer that a newer click overtook is DROPPED (epoch guard)', async () => {
    let calls = 0;
    const Cart = loadCart({
        updateCartItem: async (_id, qty) => {
            calls++;
            if (qty === 3) Cart._mutationEpoch++; // the shopper clicked again mid-flight
            return { ok: true, data: { cart: serverCart(qty) } };
        },
        getCart: async () => { throw new Error('no GET'); },
    });
    primeCart(Cart, 1);
    Cart.items[0].quantity = 3;
    Cart._losePricing('pending');
    await Cart._executeQuantityUpdate(Cart.items[0].key || 'p1', 3);
    assert.equal(calls, 1);
    assert.equal(Cart.pricingState, 'pending', 'the overtaken answer was not adopted');
    assert.equal(Cart.items[0].quantity, 3, 'nothing flashed back');
    clearTimeout(Cart._pendingWatchdog);
});

test('§14 no `data.cart` (older backend / its re-read failed) ⇒ the GET fallback; legacy `data.items` still adopted', async () => {
    let gets = 0;
    const Cart = loadCart({
        updateCartItem: async () => ({ ok: true, data: { message: 'updated', id: 'row1', quantity: 3 } }),
        getCart: async () => { gets++; return { ok: true, data: serverCart(3) }; },
    });
    primeCart(Cart, 1);
    Cart.items[0].quantity = 3;
    await Cart._executeQuantityUpdate(Cart.items[0].key || 'p1', 3);
    assert.equal(gets, 1, 'missing cart ⇒ one GET');
    assert.equal(Cart.serverSummary.total, 198.42);

    const legacy = loadCart({ updateCartItem: async () => ({ ok: true, data: serverCart(3) }), getCart: async () => { throw new Error('no GET'); } });
    primeCart(legacy, 1);
    legacy.items[0].quantity = 3;
    await legacy._executeQuantityUpdate(legacy.items[0].key || 'p1', 3);
    assert.equal(legacy.serverSummary.total, 198.42);
});

test('§14 _putResponseCart: data.cart, legacy data.items, or null', () => {
    const Cart = loadCart();
    assert.equal(Cart._putResponseCart({ ok: true, data: { cart: { items: [] } } }).items.length, 0);
    assert.ok(Cart._putResponseCart({ ok: true, data: { items: [] } }));
    assert.equal(Cart._putResponseCart({ ok: true, data: { message: 'x' } }), null);
    assert.equal(Cart._putResponseCart({ ok: true, data: { cart: { summary: {} } } }), null, 'a cart with no items array is not a cart');
    assert.equal(Cart._putResponseCart({ ok: true }), null);
});

test('§14 the PUT adoption filters pending removals and stays DELIBERATELY unguarded (qty 0 empties)', () => {
    const body = stripComments(extractMethod(CART_SRC, '_adoptMutationCart').body);
    assert.match(body, /_filterPendingRemovals\(parsed\.items\)/);
    assert.match(body, /this\.loyalty = parsed\.loyalty/);
    assert.doesNotMatch(body, /_serverEmptyButWeHoldLines/);
    assert.match(CART_SRC, /DELIBERATELY NOT GUARDED by _serverEmptyButWeHoldLines \(ERR-259\): a\s+\* quantity set to zero/);
    const debounced = stripComments(extractMethod(CART_SRC, '_debouncedQuantityUpdate').body);
    assert.doesNotMatch(debounced, /serverSummary\.(subtotal|total) \+=/, 'the retail-delta patch is gone');
});

test('§14 "Updating…" always ENDS: the watchdog re-reads when no mutation is coming', async () => {
    let gets = 0;
    const Cart = loadCart({ getCart: async () => { gets++; return { ok: true, data: serverCart(1) }; } });
    primeCart(Cart, 1);
    Cart.PENDING_WATCHDOG_MS = 20;
    Cart._losePricing('pending'); // e.g. a server-rejected add rolled back without a re-read
    Cart._paintSummaryPending();
    await sleep(60);
    assert.equal(gets, 1);
    assert.equal(Cart.pricingState, 'ok');
});

test('§14 a failed programmatic updateQuantity re-reads after its rollback (PENDING never lingers)', () => {
    const body = stripComments(extractMethod(CART_SRC, 'updateQuantity').body);
    assert.equal((body.match(/item\.quantity = oldQuantity;\s*this\.saveToLocalStorage\(\);\s*await this\.loadFromServer\(\);/g) || []).length, 2);
    assert.match(body, /this\._adoptMutationCart\(putCart\)/);
});

// ═══ §9 pre-validation ═══════════════════════════════════════════════════════

test('§9 a verdict fetched while the shopper reads the cart answers the click at once — for THIS cart only', async () => {
    let validates = 0;
    const Cart = loadCart({ validateCart: async () => { validates++; return { ok: true, data: { is_valid: true, issues: [], valid_items: [] } }; } });
    primeCart(Cart, 1);
    Cart._maybePrevalidate();
    Cart._maybePrevalidate();
    assert.equal(validates, 1, 'one per settled cart, however often it re-renders');
    await sleep(5);
    assert.deepEqual(plain(Cart._freshPrevalidation()), { valid: true, errors: [], priceChanges: [] });
    const before = validates;
    assert.deepEqual(plain(await Cart._validateWithinCap()), { valid: true, errors: [], priceChanges: [] });
    assert.equal(validates, before, 'the click did not ask again');

    Cart._mutationEpoch++;
    assert.equal(Cart._freshPrevalidation(), null, 'any change makes it unusable');
    await Cart._validateWithinCap();
    assert.equal(validates, before + 1, 'a changed cart is asked about again');

    Cart.PREVALIDATE_MAX_AGE_MS = -1;
    assert.equal(Cart._freshPrevalidation(), null, 'too old ⇒ ask');
});

test('§9 never while pending; acknowledging price changes forgets the cached verdict', async () => {
    let validates = 0;
    const Cart = loadCart({ validateCart: async () => { validates++; return { ok: true, data: { is_valid: true } }; } });
    primeCart(Cart, 1);
    Cart._losePricing('pending');
    Cart._maybePrevalidate();
    assert.equal(validates, 0);
    clearTimeout(Cart._pendingWatchdog);
    Cart._prevalidated = { epoch: Cart._mutationEpoch, inflight: false, at: Date.now(), result: { valid: false, priceChanges: [{}] } };
    await Cart.validateCart(true);
    assert.equal(Cart._prevalidated, null);
});

test('§9 the click still awaits _validateWithinCap (one navigation) and cart.html prefetches /checkout', () => {
    const fn = stripComments(extractMethod(CART_SRC, 'bindCheckoutButton').body);
    assert.match(fn, /await self\._validateWithinCap\(\)/);
    assert.match(read('html/cart.html').replace(/<!--[\s\S]*?-->/g, ''), /<link rel="prefetch" href="\/checkout">/);
});

// ═══ §15 the backend's verdict on a guest email ══════════════════════════════

const VERDICT = method('js/checkout-page.js', 'emailVerdictFrom');
const REFUSED = { ok: false, code: 'VALIDATION_FAILED', error: 'Validation failed', details: [{ field: 'email', message: 'Please enter a valid email address' }] };

test('§15 ONLY VALIDATION_FAILED on the email field is "invalid"; everything else fails OPEN', () => {
    assert.deepEqual(plain(VERDICT(REFUSED)), { state: 'invalid', message: 'Please enter a valid email address' });
    assert.equal(VERDICT({ ...REFUSED, details: [{ field: 'guest_email', message: 'm' }] }).state, 'invalid');
    assert.equal(VERDICT({ ok: true, data: { has_previous_order: false } }).state, 'ok');
    assert.equal(VERDICT(null).state, 'unknown', 'guestPrefill → null on a thrown 429 / network error');
    assert.equal(VERDICT({ ok: false, code: 'RATE_LIMITED' }).state, 'unknown');
    assert.equal(VERDICT({ ok: false, status: 503, error: 'down' }).state, 'unknown');
    assert.equal(VERDICT({ ...REFUSED, details: [{ field: 'phone', message: 'x' }] }).state, 'unknown', 'another field is not the email\'s verdict');
    assert.equal(VERDICT({ ...REFUSED, details: [{ field: 'email', message: '  ' }] }).message, 'Please enter a valid email address');
});

function checkoutSelf(apiAnswer, { delay = 0, authed = false } = {}) {
    const calls = { api: 0, shown: [], cleared: 0 };
    const field = { value: 'test@gmail.con', validity: { valid: true }, scrollIntoView() {} };
    const self = {
        EMAIL_CHECK_CAP_MS: 40,
        _renderReturningGuestBanner() {},
        _showEmailError(m) { calls.shown.push(m); },
        _clearEmailError() { calls.cleared++; },
    };
    const globals = {
        API: { guestPrefill: async () => { calls.api++; if (delay) await sleep(delay); return apiAnswer; } },
        Auth: { isAuthenticated: () => authed },
        document: { getElementById: (id) => (id === 'email' ? field : null) },
    };
    for (const n of ['tryGuestPrefill', 'emailVerdictFrom', '_recordEmailVerdict', '_currentEmailVerdict', '_emailPassesGate']) {
        self[n] = method('js/checkout-page.js', n, self, globals);
    }
    return { self, calls, field };
}

test('§15 a refused address is painted under the field and BLOCKS Continue; the fix clears it', async () => {
    const { self, calls, field } = checkoutSelf(REFUSED);
    await self.tryGuestPrefill(field.value);
    assert.deepEqual(calls.shown, ['Please enter a valid email address']);
    assert.equal(await self._emailPassesGate(), false);
    assert.equal(calls.api, 1, 'the gate used the verdict it had — no second request');

    const fixed = checkoutSelf({ ok: true, data: { has_previous_order: false } });
    fixed.field.value = 'test@gmail.com';
    await fixed.self.tryGuestPrefill(fixed.field.value);
    assert.equal(fixed.calls.cleared, 1);
    assert.equal(await fixed.self._emailPassesGate(), true);
});

test('§15 fail OPEN: a 429/5xx/network null never blocks; a slow check past the cap proceeds', async () => {
    for (const ans of [null, { ok: false, code: 'RATE_LIMITED' }, { ok: false, status: 502 }]) {
        const { self } = checkoutSelf(ans);
        assert.equal(await self._emailPassesGate(), true, JSON.stringify(ans));
    }
    const slow = checkoutSelf(REFUSED, { delay: 200 });
    const t0 = Date.now();
    assert.equal(await slow.self._emailPassesGate(), true, 'the cap won: proceed, POST /api/orders still checks');
    assert.ok(Date.now() - t0 < 150);
    const authed = checkoutSelf(REFUSED, { authed: true });
    assert.equal(await authed.self._emailPassesGate(), true, 'signed-in shoppers are never gated here');
    assert.equal(authed.calls.api, 0);
});

test('§15 the gate runs AFTER field validation and BEFORE checkoutData is saved', () => {
    const fn = stripComments(extractMethod(read('js/checkout-page.js'), 'handleContinueToPayment').body);
    const fields = fn.indexOf('this.validateFormFields(form)');
    const gate = fn.indexOf('await this._emailPassesGate()');
    const save = fn.indexOf("sessionStorage.setItem('checkoutData'");
    assert.ok(fields > 0 && fields < gate && gate < save);
    const acc = stripComments(extractMethod(read('js/checkout-page.js'), '_validateAccordionSection').body);
    assert.match(acc, /_currentEmailVerdict\(\)[\s\S]{0,120}state === 'invalid'/, 'the contact step cannot complete on a refused address');
});

test('§15 the error is accessible: aria-invalid, aria-describedby, role=alert; Continue is disabled', () => {
    const btn = { disabled: false, dataset: {} };
    const field = makeEl('email');
    let inserted = null;
    const group = { insertBefore(el) { inserted = el; } };
    field.closest = () => group;
    const doc = {
        getElementById: (id) => (id === 'email' ? field : id === 'continue-to-payment-btn' ? btn : null),
        querySelectorAll: () => [],
        createElement: () => makeEl('new'),
    };
    const self = { isSubmitting: false };
    method('js/checkout-page.js', '_showEmailError', self, { document: doc })('Please enter a valid email address');
    assert.equal(inserted.id, 'email-error');
    assert.equal(inserted.textContent, 'Please enter a valid email address');
    assert.equal(inserted.getAttribute('role'), 'alert');
    assert.equal(field.getAttribute('aria-invalid'), 'true');
    assert.equal(field.getAttribute('aria-describedby'), 'email-error');
    assert.equal(btn.disabled, true);
    method('js/checkout-page.js', '_clearEmailError', self, { document: doc })();
    assert.equal(field.getAttribute('aria-invalid'), null);
    assert.equal(btn.disabled, false, 'released');
});

test('§15 typo hint: every listed slip is caught; exact and unrelated domains get nothing', () => {
    const s = method('js/checkout-page.js', 'suggestEmailDomain');
    const cases = {
        'name@gmail.con': 'name@gmail.com', 'name@gmail.cmo': 'name@gmail.com', 'name@gmail.comm': 'name@gmail.com',
        'name@gmial.com': 'name@gmail.com', 'name@gmai.com': 'name@gmail.com', 'name@hotmial.com': 'name@hotmail.com',
        'name@xtra.co': 'name@xtra.co.nz', 'name@gmail': 'name@gmail.com', 'Jo.Smith@Outlok.com': 'Jo.Smith@outlook.com',
        'name@icloud.con': 'name@icloud.com', 'name@yahooo.com': 'name@yahoo.com',
    };
    for (const [typed, want] of Object.entries(cases)) assert.equal(s(typed), want, typed);
    for (const fine of ['name@gmail.com', 'name@xtra.co.nz', 'name@inkcartridges.co.nz', 'name@company.com', 'name@yahoo.co.nz', 'nope', '@gmail.con', '']) {
        assert.equal(s(fine), null, fine);
    }
});

test('§15 checkout.html carries the hint slot; the blur pin for guest-prefill still holds', () => {
    const h = read('html/checkout.html');
    assert.match(h, /<p class="email-suggest" id="email-suggest" aria-live="polite" hidden><\/p>/);
    assert.match(stripComments(read('js/checkout-page.js')), /addEventListener\('blur',[\s\S]{0,200}emailField\.validity\.valid[\s\S]{0,120}tryGuestPrefill/);
});

// ═══ §15 backstop on /payment ════════════════════════════════════════════════

test('§15 /payment: a guest_email refusal is named beside Pay, with "Change email" that keeps the form', () => {
    const detail = method('js/payment-page.js', 'rejectedEmailDetail');
    const ORDER_REFUSAL = { ok: false, code: 'VALIDATION_FAILED', details: [{ field: 'guest_email', message: 'Please enter a valid email address so we can send your receipt' }] };
    assert.equal(detail(ORDER_REFUSAL), 'Please enter a valid email address so we can send your receipt');
    assert.equal(detail({ ok: false, code: 'VALIDATION_FAILED', details: [{ field: 'shipping_postal_code', message: 'x' }] }), null);
    assert.equal(detail({ ok: false, code: 'PAYMENT_ERROR' }), null);

    const store = {};
    const errorEl = makeEl('card-errors');
    const self = { checkoutData: { email: 'test@gmail.con', firstName: 'A', savedAt: 1 } };
    method('js/payment-page.js', 'showEmailRejected', self, {
        sessionStorage: { setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: (id) => (id === 'card-errors' ? errorEl : null) },
        esc: (v) => String(v), DebugLog: { warn() {} },
    })('Please enter a valid email address so we can send your receipt');
    const saved = JSON.parse(store.checkoutData);
    assert.equal(saved.email, 'test@gmail.con');
    assert.ok(Date.now() - saved.savedAt < 5000, 'fresh savedAt, so restoreCheckoutState accepts it');
    assert.match(errorEl.innerHTML, /so we can send your receipt/);
    assert.match(errorEl.innerHTML, /<a href="\/checkout#email"[^>]*>Change email<\/a>/);
    assert.equal(errorEl.dataset.error, 'email-rejected');

    const order = stripComments(extractMethod(read('js/payment-page.js'), 'createStripeOrder').body);
    const branch = order.indexOf('this.rejectedEmailDetail(orderResponse)');
    assert.ok(branch > 0 && branch < order.indexOf("errorCode === 'INSUFFICIENT_POINTS'"), 'checked before the generic triage');
    assert.match(order.slice(branch, branch + 300),
        /this\.rejectedEmailDetail\(orderResponse\);\s*if \(emailDetail\) \{\s*this\.showEmailRejected\(emailDetail\);\s*return \{ status: 'handled' \};/,
        'shown, then { status: handled } so the card AND wallet paths unstick');
    assert.match(stripComments(read('js/checkout-page.js')), /this\.focusEmailFromHash\(\)/);
});

// ═══ §6 copy ═════════════════════════════════════════════════════════════════

test('§6 the PDP line reads "Earn N reward points"', () => {
    assert.match(stripComments(read('js/product-detail-page.js')), /`Earn \$\{earn\.points\.toLocaleString\('en-NZ'\)\} reward points \(/);
});
