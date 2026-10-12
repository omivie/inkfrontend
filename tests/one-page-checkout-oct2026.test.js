/**
 * One-page checkout (ERR-316 phase 3, owner 2026-10-12: "like smartink").
 *
 * /payment folded into /checkout. CheckoutPage validates the details, then
 * calls PaymentPage.attach(checkoutData), which mounts Stripe/Turnstile/PayPal
 * ONCE, under the form. This file runs js/payment-page.js in a VM and checks:
 *   - attach() initialises once; a second Continue only swaps the details;
 *   - embedded, calculateTotals paints the Pay label and syncs Stripe's
 *     amount but NEVER the summary rows (CheckoutPage owns those);
 *   - a detail edited after Continue makes every pay path refuse;
 *   - the /payment boot cannot run on /checkout (it would redirect-loop);
 *   - payment.html is only a redirect.
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
const PAY_SRC = read('js/payment-page.js');

function el(id) {
    return { id, textContent: '', hidden: false, disabled: false, dataset: {}, scrollIntoView() {}, writes: 0,
        set text(v) { this.textContent = v; this.writes++; } };
}

function load({ summary = { subtotal: 43.49, shipping: 7, discount: 0 }, ids = [] } = {}) {
    const nodes = {};
    for (const id of ['pay-button-text', 'pay-now-btn', 'payment-stale-note', 'checkout-payment', ...ids]) nodes[id] = el(id);
    const toasts = [];
    const ctx = {
        document: {
            getElementById: (id) => nodes[id] || null,
            addEventListener() {},
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        API: { getCart: async () => ({ ok: true, data: { summary, items: [] } }), extractErrorMessage: () => 'x' },
        showToast: (m) => toasts.push(m),
        DebugLog: { log() {}, warn() {}, error() {} },
        computeDiscountBreakdown: () => ({ loyalty: 0, b2b: 0, other: 0 }),
        businessDiscountLabel: () => '',
        setTimeout, clearTimeout,
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(PAY_SRC + '\n;globalThis.__PP = PaymentPage;', ctx);
    return { P: ctx.__PP, nodes, toasts };
}

test('attach() initialises Stripe/Turnstile/PayPal ONCE; a second Continue only swaps the details', async () => {
    const { P } = load();
    const calls = [];
    for (const m of ['initWalletDiag', 'initStripe', 'initTurnstile', 'initPayPalButton', 'setupEventHandlers', 'renderPayReassurance']) {
        P[m] = () => calls.push(m);
    }
    let totals = 0;
    P.calculateTotals = async () => { totals++; };
    await P.attach({ address1: '1 Queen St' });
    assert.deepEqual(calls.filter((c) => c === 'initStripe'), ['initStripe']);
    assert.equal(P.embedded, true);
    assert.equal(P._attached, true);
    await P.attach({ address1: '2 Queen St' });
    assert.equal(calls.filter((c) => c === 'initStripe').length, 1, 'never mounts a second card form');
    assert.equal(calls.filter((c) => c === 'initPayPalButton').length, 1, 'never renders PayPal twice');
    assert.equal(P.checkoutData.address1, '2 Queen St', 'the order is built from the NEW details');
    assert.equal(totals, 2, 'and the server total is re-read');
});

test('embedded: calculateTotals syncs Stripe and the Pay label, and paints NO summary row', async () => {
    const ids = ['checkout-subtotal', 'checkout-shipping', 'checkout-total', 'checkout-discount-row', 'checkout-discount', 'checkout-loyalty-row', 'checkout-b2b-row'];
    const { P, nodes } = load({ ids });
    let amount = null;
    P.elements = { update: (o) => { amount = o.amount; } };
    P.embedded = true;
    P.checkoutData = { estimatedShipping: 7 };
    for (const id of ids) nodes[id].textContent = 'CHECKOUTPAGE';
    await P.calculateTotals();
    for (const id of ids) assert.equal(nodes[id].textContent, 'CHECKOUTPAGE', `#${id} belongs to CheckoutPage on /checkout`);
    assert.equal(nodes['pay-button-text'].textContent, 'Pay $50.49 NZD');
    assert.equal(amount, 5049, 'Stripe charges the server total');

    // CONTROL: not embedded (the old /payment), the same call paints the rows.
    const two = load({ ids });
    two.P.checkoutData = { estimatedShipping: 7 };
    await two.P.calculateTotals();
    assert.equal(two.nodes['checkout-total'].textContent, '$50.49 NZD');
});

test('a detail edited after Continue: Pay refuses, the note shows; before attach nothing is marked', async () => {
    const { P, nodes, toasts } = load();
    P.markStale();
    assert.equal(P.detailsStale, false, 'nothing attached yet ⇒ nothing to go stale');
    P._attached = true;
    P.markStale();
    assert.equal(P.detailsStale, true);
    assert.equal(nodes['payment-stale-note'].hidden, false);
    assert.equal(nodes['checkout-payment'].dataset.state, 'stale');
    let submitted = false;
    P.elements = { submit: async () => { submitted = true; return {}; } };
    P.paymentElementReady = true;
    await P.handlePayment();
    assert.equal(submitted, false, 'no charge against the old address');
    assert.match(toasts.join(' '), /Update details/);
});

test('PayPal refuses before its popup opens when the details are stale', () => {
    const code = stripComments(PAY_SRC);
    assert.match(code, /onClick: \(data, actions\) => \{\s*if \(self\.detailsStale\) \{\s*self\._refuseStale\(\);\s*return actions\.reject\(\);/);
});

test('the /payment boot never runs on /checkout (it would read no sessionStorage and redirect-loop)', () => {
    const code = stripComments(PAY_SRC);
    const boot = code.slice(code.indexOf("document.addEventListener('DOMContentLoaded'"));
    assert.match(boot, /if \(!document\.getElementById\('payment-form'\)\) return;\s*if \(document\.getElementById\('checkout-form'\)\) return;/);
});

test('CheckoutPage: Continue opens the payment section in place; summary changes re-read the charge', () => {
    const code = stripComments(read('js/checkout-page.js'));
    const cont = code.slice(code.indexOf('async handleContinueToPayment(form)'), code.indexOf('async checkAuthAndPrefill()'));
    const save = cont.indexOf("sessionStorage.setItem('checkoutData'");
    const open = cont.indexOf('await this._openPayment(checkoutData)');
    assert.ok(save > 0 && open > save, 'validate → gate → save → open, in that order');
    assert.match(cont, /form\.addEventListener\('input', stale\)/, 'any edit after Continue marks the details stale');
    const totals = code.slice(code.indexOf('updateTotalsDisplay() {'));
    assert.match(totals.slice(0, 400), /PaymentPage\._attached\) PaymentPage\.refreshTotalsSoon\(\)/);
});

test('checkout.html carries the payment section OUTSIDE the details form, waiting until Continue', () => {
    const html = read('html/checkout.html');
    const formEnd = html.indexOf('</form>', html.indexOf('id="checkout-form"'));
    const pay = html.indexOf('id="payment-form"');
    assert.ok(formEnd > 0 && pay > formEnd, 'forms cannot nest');
    assert.match(html, /id="checkout-payment" data-state="waiting"/);
    assert.match(html, /id="payment-pending">Enter your contact and delivery details above/);
    assert.match(html, /id="pay-now-btn" class="pay-button" disabled/);
    for (const src of [/js\.stripe\.com\/v3/, /paypal\.com\/sdk\/js/, /turnstile\/v0\/api\.js/, /\/js\/payment-page\.js\?v=/]) {
        assert.match(html, src);
    }
});

test('payment.html is only a redirect to /checkout, and loads no payment code', () => {
    const html = read('html/payment.html');
    assert.match(html, /<meta http-equiv="refresh" content="0; url=\/checkout">/);
    assert.doesNotMatch(html, /payment-page\.js|js\.stripe\.com|paypal\.com\/sdk|id="payment-form"/);
});

test('cart wallet: a refused email is SAID on the wallet, not written to a #card-errors /cart lacks', () => {
    const code = stripComments(read('js/cart-wallet.js'));
    assert.match(code, /showEmailRejected\(msg\) \{ self\._say\(/);
});
