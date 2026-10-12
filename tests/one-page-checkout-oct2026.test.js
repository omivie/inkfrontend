/**
 * One-page checkout, Shopify-style (ERR-316 phases 3–4, owner 2026-10-12/13:
 * "almost exactly like smartink.co.nz").
 *
 * /payment folded into /checkout. Every section is open; the card form mounts
 * at page load (PaymentPage.attach(null)); ONE "Pay now" collects + validates
 * the details (CheckoutPage.collectCheckoutData) before anything is charged.
 * This file runs js/payment-page.js in a VM and checks:
 *   - attach() initialises once;
 *   - embedded, calculateTotals syncs Stripe's amount (with the address-priced
 *     shipping) and paints NO summary row (CheckoutPage owns those);
 *   - Pay never reaches handlePayment when the details do not validate;
 *   - the /payment boot cannot run on /checkout (it would redirect-loop);
 *   - payment.html is only a redirect; the page reads like Shopify's.
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

test('attach(null) at page load mounts Stripe/Turnstile/PayPal ONCE', async () => {
    const { P } = load();
    const calls = [];
    for (const m of ['initWalletDiag', 'initStripe', 'initTurnstile', 'initPayPalButton', 'setupEventHandlers', 'renderPayReassurance']) {
        P[m] = () => calls.push(m);
    }
    let totals = 0;
    P.calculateTotals = async () => { totals++; };
    await P.attach(null);
    assert.equal(P.embedded, true);
    assert.equal(P.checkoutData, null, 'no details yet — the card form opens before they are typed');
    await P.attach(null);
    assert.equal(calls.filter((c) => c === 'initStripe').length, 1, 'never mounts a second card form');
    assert.equal(calls.filter((c) => c === 'initPayPalButton').length, 1, 'never renders PayPal twice');
    assert.equal(totals, 2);
});

test('embedded: calculateTotals syncs Stripe (address-priced shipping) and paints NO summary row', async () => {
    const ids = ['checkout-subtotal', 'checkout-shipping', 'checkout-total', 'checkout-discount-row', 'checkout-discount', 'checkout-loyalty-row', 'checkout-b2b-row'];
    const { P, nodes } = load({ ids, summary: { subtotal: 43.49, shipping: 7, discount: 0 } });
    let amount = null;
    P.elements = { update: (o) => { amount = o.amount; } };
    P.embedded = true;
    P.checkoutData = null;
    P.pendingShipping = 14; // rural, priced for the address CheckoutPage is showing
    for (const id of ids) nodes[id].textContent = 'CHECKOUTPAGE';
    await P.calculateTotals();
    for (const id of ids) assert.equal(nodes[id].textContent, 'CHECKOUTPAGE', `#${id} belongs to CheckoutPage on /checkout`);
    assert.equal(nodes['pay-button-text'].textContent, 'Pay now', "Shopify's label");
    assert.equal(amount, 5749, 'Stripe holds subtotal + the address-priced fee, not the cart estimate');

    // CONTROL: not embedded (the old /payment), the same call paints the rows.
    const two = load({ ids });
    two.P.checkoutData = { estimatedShipping: 7 };
    await two.P.calculateTotals();
    assert.equal(two.nodes['checkout-total'].textContent, '$50.49 NZD');
});

test('Pay now: details that do not validate never reach handlePayment; valid ones are charged as collected', async () => {
    const { P } = load();
    let paid = 0, totals = 0;
    P.embedded = true;
    P.handlePayment = async () => { paid++; };
    P.calculateTotals = async () => { totals++; };
    P.collect = async () => null;
    await P.payNow();
    assert.equal(paid, 0, 'a form with errors is never charged');
    P.collect = async () => ({ address1: '1 Queen St', estimatedShipping: 7 });
    await P.payNow();
    assert.equal(paid, 1);
    assert.equal(P.checkoutData.address1, '1 Queen St', 'the order is built from the form as it is at Pay');
    assert.equal(totals, 1, 'and the server total is re-read first');
});

test('Pay now refuses while the shipping fee is unknown — Stripe must never take goods only', async () => {
    const { P } = load();
    let paid = 0; const said = [];
    P.embedded = true;
    P.handlePayment = async () => { paid++; };
    P.calculateTotals = async () => {};
    P.showError = (m) => said.push(m);
    for (const fee of [null, undefined, NaN, '7']) {
        P.collect = async () => ({ address1: '1 Queen St', estimatedShipping: fee });
        await P.payNow();
    }
    assert.equal(paid, 0, 'null / missing / NaN / a string fee all stop before Stripe');
    assert.match(said[0], /Shipping is still being calculated/);
    P.collect = async () => ({ address1: '1 Queen St', estimatedShipping: 0 });
    await P.payNow();
    assert.equal(paid, 1, 'a real $0 (free shipping) pays');
});

test('PayPal collects + validates the details before its popup opens', () => {
    const code = stripComments(PAY_SRC);
    assert.match(code, /onClick: async \(data, actions\) => \{\s*if \(self\.embedded && typeof self\.collect === 'function'\) \{\s*const d = await self\.collect\(\);\s*if \(!d\) return actions\.reject\(\);/);
});

test('the /payment boot never runs on /checkout (it would read no sessionStorage and redirect-loop)', () => {
    const code = stripComments(PAY_SRC);
    const boot = code.slice(code.indexOf("document.addEventListener('DOMContentLoaded'"));
    assert.match(boot, /if \(!document\.getElementById\('payment-form'\)\) return;\s*if \(document\.getElementById\('checkout-form'\)\) return;/);
});

test('CheckoutPage: one button — collect runs every check, and the card form mounts at load', () => {
    const code = stripComments(read('js/checkout-page.js'));
    const collect = code.slice(code.indexOf('async collectCheckoutData(form)'), code.indexOf('_mountPayment(form) {'));
    const fields = collect.indexOf('this.validateFormFields(form)');
    const gate = collect.indexOf('await this._emailPassesGate()');
    const save = collect.indexOf("sessionStorage.setItem('checkoutData'");
    assert.ok(fields > 0 && fields < gate && gate < save, 'validate → email gate → record, in that order');
    assert.match(collect, /return checkoutData;/);
    assert.doesNotMatch(code, /window\.location\.href = '\/payment'/, 'never leaves the page to pay');
    assert.match(code, /PaymentPage\.collect = \(\) => this\.collectCheckoutData\(form\);\s*PaymentPage\.attach\(null\);/);
    assert.doesNotMatch(code, /setupAccordion|_accordionSections|continue-to-payment-btn/, 'no accordion, no Continue');
    const totals = code.slice(code.indexOf('updateTotalsDisplay() {'));
    assert.match(totals.slice(0, 700), /PaymentPage\.pendingShipping = Number\.isFinite\(this\.totals\.shipping\)[\s\S]{0,120}PaymentPage\.refreshTotalsSoon\(\)/);
});

test('checkout.html reads like Shopify: open sections in order, one Pay now, policy links', () => {
    const html = read('html/checkout.html');
    const formEnd = html.indexOf('</form>', html.indexOf('id="checkout-form"'));
    const pay = html.indexOf('id="payment-form"');
    assert.ok(formEnd > 0 && pay > formEnd, 'forms cannot nest');
    const order = ['>Contact</legend>', '>Delivery</legend>', '>Shipping method</h3>', 'id="payment-heading">Payment</h2>'].map((t) => html.indexOf(t));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), 'Contact, Delivery, Shipping method, Payment');
    assert.match(html, /id="pay-now-btn" class="pay-button" disabled>\s*<span id="pay-button-text">Pay now<\/span>/);
    assert.doesNotMatch(html, /continue-to-payment-btn|checkout-section__num|class="checkout-progress|payment-pending|payment-stale-note/);
    assert.match(html, /<nav class="checkout-policies"[\s\S]*Refund policy[\s\S]*Shipping[\s\S]*Privacy policy[\s\S]*Terms of service[\s\S]*Contact[\s\S]*<\/nav>/);
    // The detail fields (the summary's coupon box keeps its own placeholder).
    for (const m of html.matchAll(/<input type="(?:text|email|tel)"[^>]*class="(?:form-input|phone-number)"[^>]*>/g)) {
        assert.match(m[0], /placeholder=" "/, `floating label needs placeholder=" ": ${m[0].slice(0, 80)}`);
    }
    // GST: a fact, never a computed figure (the FE never computes tax).
    assert.match(html, /<p class="checkout-summary__tax">Including GST<\/p>/);
    assert.ok(html.indexOf('id="email"') < html.indexOf('id="reminder-consent-optin"')
        && html.indexOf('id="reminder-consent-optin"') < html.indexOf('id="phone"'), 'phone now lives in Delivery');
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
