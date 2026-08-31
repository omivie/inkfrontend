/**
 * Cart funnel — the middle of the funnel had no wiring (Aug 2026)
 * ==============================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The backend measured `cart_analytics_events` over the whole of its history and
 * sent the numbers over:
 *
 *   cart_viewed         1,128 events / 583 sessions / last seen 2026-08-31
 *   checkout_started      579 events / 369 sessions / last seen 2026-08-30
 *   remove_from_cart      251 events / 101 sessions / last seen 2026-08-20
 *   add_to_cart            56 events /  34 sessions / last seen 2026-08-11
 *   checkout_completed      4 events /   4 sessions / last seen 2026-03-11
 *
 * 583 sessions viewed a cart and 34 ever added to one. Both dead events had a
 * single, findable cause, and neither was "the tracker is broken":
 *
 *   add_to_cart        `cart-analytics.js` was loaded on THREE pages — cart,
 *                      checkout, payment — while `cart.js`, which owns the only
 *                      call site, is loaded on THIRTY-THREE. Every real add-to-
 *                      cart entry point (PDP, shop cards, homepage, ribbons,
 *                      favourites, business) sat behind
 *                      `typeof CartAnalytics !== 'undefined'`, which was false
 *                      on all of them. The guard was an off-switch. What
 *                      survived was the cart page's own value-pack swap and
 *                      cross-sell modal — both gated on backend-supplied data —
 *                      and when that trickle stopped the metric looked like a
 *                      feature breaking rather than one that had never worked.
 *
 *   checkout_completed `trackOrderCompleted()` had ZERO callers. Commit 633d045
 *                      ("add custom PayPal integration with JS SDK popup flow",
 *                      2026-03-12) rewrote payment-page.js and deleted both
 *                      calls while keeping the lines around them. The last
 *                      recorded event is 2026-03-11 — the day before.
 *
 * THE RULE THIS FILE PINS
 * -----------------------
 * "Every surface calls X" is a list nobody maintains — that is ERR-150/160,
 * where the same feature vanished twice, once at a parser and once at a call
 * site. So enrolment is not a convention here, it is §1: a page that loads
 * cart.js MUST load cart-analytics.js. A new page cannot silently opt out.
 *
 * Run: node --test tests/cart-funnel-enrolment-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(INK, 'js', rel), 'utf8');

/** Every .html in the deployed tree. */
function htmlFiles(dir = INK, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) htmlFiles(full, out);
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}

const HTML = htmlFiles();
const loads = (src, file) => new RegExp(`src="/js/${file.replace('.', '\\.')}(\\?v=[a-f0-9]+)?"`).test(src);

// ─────────────────────────────────────────────────────────────────────────
// §1  ENROLMENT — the structural fix, and the thing that must never regress
// ─────────────────────────────────────────────────────────────────────────

test('§1 the tree actually has pages to check (guards a vacuous pass)', () => {
    assert.ok(HTML.length >= 30, `expected 30+ html files, found ${HTML.length}`);
    const withCart = HTML.filter((f) => loads(fs.readFileSync(f, 'utf8'), 'cart.js'));
    assert.ok(withCart.length >= 30,
        `expected 30+ pages loading cart.js, found ${withCart.length} — if this drops, the ` +
        'test below can pass by checking nothing');
});

test('§1 EVERY page that loads cart.js also loads cart-analytics.js', () => {
    const missing = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        if (!loads(src, 'cart.js')) continue;
        if (!loads(src, 'cart-analytics.js')) missing.push(path.relative(INK, file));
    }
    assert.deepEqual(missing, [],
        'These pages can add to cart but cannot record it — `typeof CartAnalytics !== ' +
        `'undefined'` + '` is an off-switch there:\n  ' + missing.join('\n  '));
});

test('§1 cart-analytics.js is never loaded before cart.js on any page', () => {
    // Order matters only for readability, not correctness (both are defer, and
    // CartAnalytics is read at call time) — but a page that lists them the other
    // way round is a copy-paste that did not follow the pattern, and that is
    // exactly how the next page ends up missing the tag altogether.
    const wrong = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        const c = src.indexOf('/js/cart.js');
        const a = src.indexOf('/js/cart-analytics.js');
        if (c === -1 || a === -1) continue;
        if (a < c) wrong.push(path.relative(INK, file));
    }
    assert.deepEqual(wrong, []);
});

test('§1 printer-context.js loads BEFORE cart.js everywhere (Cart reads it)', () => {
    const wrong = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        const c = src.indexOf('/js/cart.js');
        if (c === -1) continue;
        const p = src.indexOf('/js/printer-context.js');
        if (p === -1 || p > c) wrong.push(path.relative(INK, file));
    }
    assert.deepEqual(wrong, [],
        'Cart.addItem calls PrinterContext — a page that loads it after cart.js (or not at ' +
        'all) silently drops every printer_slug:\n  ' + wrong.join('\n  '));
});

// ─────────────────────────────────────────────────────────────────────────
// §2  checkout_completed has a caller again — and it is in the right place
// ─────────────────────────────────────────────────────────────────────────

test('§2 trackOrderCompleted is called by product code, not just defined', () => {
    const files = fs.readdirSync(path.join(INK, 'js')).filter((f) => f.endsWith('.js'));
    const callers = files.filter((f) =>
        f !== 'cart-analytics.js' && JS(f).includes('trackOrderCompleted('));
    assert.ok(callers.length > 0,
        'trackOrderCompleted() has no callers — this is the exact state commit 633d045 left ' +
        'the repo in on 2026-03-12, and checkout_completed recorded 4 events in five months');
});

test('§2 it fires from the confirmation page, NOT before confirmPayment', () => {
    // Both Stripe paths write sessionStorage.lastOrder and then call
    // stripe.confirmPayment(). The order exists there, but the money has not
    // moved and a 3DS challenge can still fail. An event fired at that point
    // counts ATTEMPTS, which is a worse number than none because it looks right.
    const payment = JS('payment-page.js');
    assert.ok(!payment.includes('trackOrderCompleted'),
        'payment-page.js must not emit checkout_completed — the payment has not been taken ' +
        'at any point in that file where the order number first exists');

    const confirmation = JS('order-confirmation-page.js');
    assert.ok(confirmation.includes('CartAnalytics.trackOrderCompleted('),
        'order-confirmation-page.js should be the one place that records a completed order');
});

test('§2 the confirmation page is enrolled — otherwise that call is a no-op', () => {
    const src = fs.readFileSync(path.join(INK, 'html', 'order-confirmation.html'), 'utf8');
    assert.ok(loads(src, 'cart-analytics.js'),
        'order-confirmation.html did not load cart-analytics.js before this change, so a ' +
        'trackOrderCompleted() call placed there would have been silently dead');
});

// ─────────────────────────────────────────────────────────────────────────
// §3  The conversion recorder's three guards
// ─────────────────────────────────────────────────────────────────────────

/** Execute markConversion in isolation with a scripted environment. */
function runMarkConversion({ orderData, paymentSucceeded = true, store = {}, twice = false }) {
    const src = JS('order-confirmation-page.js');
    const start = src.indexOf('        markConversion() {');
    assert.notEqual(start, -1, 'markConversion() not found in the source');
    const open = src.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(open + 1, i);

    const gtagCalls = [];
    const analyticsCalls = [];
    const ctx = {
        orderData,
        _conversionFired: false,
        _paymentSucceeded: paymentSucceeded,
    };
    const sandboxLocal = {
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
        },
        gtag: (...a) => gtagCalls.push(a),
        CartAnalytics: { trackOrderCompleted: (d) => analyticsCalls.push(d) },
        JSON, Array, Number, String, Object,
    };
    const fn = new Function(
        'localStorage', 'gtag', 'CartAnalytics', 'JSON', 'Array', 'Number', 'String', 'Object',
        `return function () {${body}};`,
    )(sandboxLocal.localStorage, sandboxLocal.gtag, sandboxLocal.CartAnalytics,
      JSON, Array, Number, String, Object);

    const first = fn.call(ctx);
    const second = twice ? fn.call(ctx) : undefined;
    return { first, second, gtagCalls, analyticsCalls, store };
}

test('§3 a completed order records exactly one gtag conversion and one cart event', () => {
    const r = runMarkConversion({ orderData: { orderNumber: 'ORD-1', total: 99.5, items: [{}] } });
    assert.equal(r.first, true);
    assert.equal(r.gtagCalls.length, 1);
    assert.equal(r.analyticsCalls.length, 1);
    assert.equal(r.analyticsCalls[0].order_number, 'ORD-1');
    assert.equal(r.analyticsCalls[0].total, 99.5);
});

test('§3 a FAILED Stripe redirect records nothing', () => {
    // ?redirect_status=failed lands on this same URL and renders this same page.
    const r = runMarkConversion({
        orderData: { orderNumber: 'ORD-2', total: 10 },
        paymentSucceeded: false,
    });
    assert.equal(r.first, false);
    assert.equal(r.gtagCalls.length, 0);
    assert.equal(r.analyticsCalls.length, 0);
});

test('§3 calling it twice in one pageload records once', () => {
    const r = runMarkConversion({
        orderData: { orderNumber: 'ORD-3', total: 10 },
        twice: true,
    });
    assert.equal(r.first, true);
    assert.equal(r.second, false);
    assert.equal(r.gtagCalls.length, 1);
});

test('§3 a RELOAD of the same order records nothing — including the Google Ads conversion', () => {
    // The pre-existing behaviour fired gtag('event','conversion') inline in both
    // branches with no dedupe at all, and this page deliberately keeps a
    // localStorage copy of the order for an hour so a hard refresh still renders.
    // One refresh therefore reported a second purchase of the same order, at
    // full value, to Google Ads.
    const store = {};
    const first = runMarkConversion({ orderData: { orderNumber: 'ORD-4', total: 42 }, store });
    assert.equal(first.gtagCalls.length, 1);

    const reload = runMarkConversion({ orderData: { orderNumber: 'ORD-4', total: 42 }, store });
    assert.equal(reload.first, false);
    assert.equal(reload.gtagCalls.length, 0, 'a refreshed receipt must not re-report the sale');
    assert.equal(reload.analyticsCalls.length, 0);
});

test('§3 a DIFFERENT order still records (positive control for the dedupe)', () => {
    // Without this, a dedupe bug that blocked everything would pass the test above.
    const store = {};
    runMarkConversion({ orderData: { orderNumber: 'ORD-5', total: 1 }, store });
    const other = runMarkConversion({ orderData: { orderNumber: 'ORD-6', total: 2 }, store });
    assert.equal(other.first, true);
    assert.equal(other.gtagCalls.length, 1);
});

test('§3 an order with no number records nothing', () => {
    const r = runMarkConversion({ orderData: { total: 5 } });
    assert.equal(r.first, false);
});

// ─────────────────────────────────────────────────────────────────────────
// §4  add_to_cart fires on the branch where the item IS in the cart
// ─────────────────────────────────────────────────────────────────────────

test('§4 there is exactly one place that emits add_to_cart', () => {
    const cart = JS('cart.js');
    const direct = (cart.match(/CartAnalytics\.trackAddToCart\(/g) || []).length;
    assert.equal(direct, 1,
        'add_to_cart should be emitted through the single _trackAdd() helper, so the two ' +
        'return paths in addItem cannot drift apart');
});

test('§4 the transport-failure branch emits; the server-rejected branch does not', () => {
    const cart = JS('cart.js');
    const catchIdx = cart.indexOf("DebugLog.error('Failed to sync cart to server:'");
    assert.notEqual(catchIdx, -1);
    const catchBlock = cart.slice(catchIdx, cart.indexOf('return;', catchIdx));
    assert.ok(catchBlock.includes('this._trackAdd(product)'),
        'the item is kept, saved and shown to the shopper on this branch — an add that the ' +
        'customer can see must be counted, or a spell of cart-API flakiness silently zeroes ' +
        'the metric while people are still buying');

    const rejectIdx = cart.indexOf("'Failed to add item to cart'");
    assert.notEqual(rejectIdx, -1);
    const rejectBlock = cart.slice(rejectIdx, cart.indexOf('return;', rejectIdx));
    assert.ok(!rejectBlock.includes('_trackAdd'),
        'the server refused and the line was rolled back — the cart does not contain it');
});
