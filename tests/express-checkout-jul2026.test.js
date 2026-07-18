/**
 * STRIPE EXPRESS CHECKOUT ELEMENT — Jul 2026
 * ==========================================
 * Adds Stripe's Express Checkout Element (ECE) — a one-tap wallet-button row
 * (Link / Apple Pay / Google Pay) ABOVE the card form on /payment — per the
 * backend dev's spec (stripe-link-express-checkout-fe-spec-jul2026.md, Option A).
 *
 * The spec's snippets assume a CONFIRMED-intent flow (elements({clientSecret})),
 * but this app uses DEFERRED intent: the PaymentIntent/order is created only on
 * pay, inside createStripeOrder(). So the wiring here diverges from the spec on
 * purpose, and these string-contract tests pin the parts that are easy to break:
 *
 *  - ECE mounts ABOVE the card form, with an "or pay with card" divider.
 *  - ECE uses a SEPARATE Elements instance (eceElements) so eceElements.submit()
 *    never cross-validates the (usually-incomplete) card Payment Element.
 *  - The card Payment Element hides Apple/Google Pay (wallets:'never') so wallets
 *    render ONCE — in the ECE row.
 *  - Guest Turnstile is gated at the 'click' event (before the sheet opens).
 *  - event.paymentFailed(...) is called on failure or the wallet sheet hangs.
 *  - The ECE confirm omits payment_method_data.billing_details (wallet supplies it)
 *    and confirms on eceElements; it reuses createStripeOrder('stripe-wallet').
 *  - Both Elements instances stay amount-synced; the block is removed if the total
 *    is unknown or no wallet is eligible.
 *  - CSP frame-src allows pay.google.com (Google Pay sheet).
 *
 * Repo has no jsdom — these are static source checks, not executed Stripe flows.
 * Run with: node --test tests/express-checkout-jul2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAY_JS = read('inkcartridges/js/payment-page.js');
const PAY_HTML = read('inkcartridges/html/payment.html');
const VERCEL = read('inkcartridges/vercel.json');

// Slice of JUST the initExpressCheckout METHOD (not its call site in initStripe),
// bounded by the "Note: PayPal" comment that immediately follows the method.
const eceStart = PAY_JS.indexOf('initExpressCheckout({ appearance, fonts, totalCents }) {');
const ECE = PAY_JS.slice(eceStart, PAY_JS.indexOf('// Note: PayPal uses a separate custom integration'));

// ─────────────────────────────────────────────────────────────────────────────
// E1 — markup: ECE mounts above the card form with a divider
// ─────────────────────────────────────────────────────────────────────────────

test('E1 payment.html has the ECE wrapper/element/divider ABOVE #payment-element', () => {
    assert.match(PAY_HTML, /id="express-checkout-wrapper"/, 'missing #express-checkout-wrapper');
    assert.match(PAY_HTML, /id="express-checkout-element"/, 'missing #express-checkout-element mount');
    assert.match(PAY_HTML, /class="express-divider"[^>]*>\s*<span>or pay with card<\/span>/,
        'missing the "or pay with card" divider');

    const eceIdx = PAY_HTML.indexOf('id="express-checkout-element"');
    const cardIdx = PAY_HTML.indexOf('id="payment-element"');
    assert.ok(eceIdx > -1 && cardIdx > -1 && eceIdx < cardIdx,
        'the Express Checkout element must appear ABOVE the card Payment Element');
});

test('E1b payment.html styles the express divider (::before/::after 1px rules)', () => {
    assert.match(PAY_HTML, /\.express-divider::before,\s*\n\s*\.express-divider::after/,
        'express divider ::before/::after rules missing');
});

// ─────────────────────────────────────────────────────────────────────────────
// E2 — separate Elements instance + expressCheckout create options
// ─────────────────────────────────────────────────────────────────────────────

test('E2 ECE uses a SEPARATE Elements instance (this.eceElements), not the card one', () => {
    assert.match(PAY_JS, /eceElements:\s*null/, 'expected a dedicated eceElements state field');
    assert.match(ECE, /this\.eceElements\s*=\s*this\.stripe\.elements\(\{/,
        'ECE must create its own stripe.elements() instance');
    assert.match(ECE, /this\.eceElements\.create\(\s*['"]expressCheckout['"]/,
        "must create the 'expressCheckout' element on the ECE instance");
});

test('E2b expressCheckout options: contact/address not required + buttonHeight 48', () => {
    assert.match(ECE, /emailRequired:\s*false/);
    assert.match(ECE, /phoneNumberRequired:\s*false/);
    assert.match(ECE, /billingAddressRequired:\s*false/);
    assert.match(ECE, /shippingAddressRequired:\s*false/);
    assert.match(ECE, /buttonHeight:\s*48/, 'buttonHeight 48 keeps the tap target >= --tap-min');
});

// ─────────────────────────────────────────────────────────────────────────────
// E3 — wallets render ONCE: card Payment Element hides Apple/Google Pay
// ─────────────────────────────────────────────────────────────────────────────

test('E3 card Payment Element sets wallets:{applePay:never, googlePay:never}', () => {
    assert.match(PAY_JS, /wallets:\s*\{\s*applePay:\s*['"]never['"],\s*googlePay:\s*['"]never['"]\s*\}/,
        'Apple/Google Pay must be removed from the card tab so they live only in the ECE row');
});

// ─────────────────────────────────────────────────────────────────────────────
// E4 — empty-state hide + guest Turnstile gated at 'click'
// ─────────────────────────────────────────────────────────────────────────────

test('E4 ready handler removes the wrapper when no wallet is eligible (all-false too)', () => {
    assert.match(ECE, /\.on\(\s*['"]ready['"]/, "missing ECE 'ready' handler");
    assert.match(ECE, /Object\.values\(apm\)\.some\(Boolean\)/,
        'empty-state check must treat an all-false availablePaymentMethods map as empty');
    assert.match(ECE, /getElementById\(\s*['"]express-checkout-wrapper['"]\s*\)\?\.remove\(\)/,
        'no eligible wallet must remove the whole block (no empty gap)');
});

test('E4b click handler gates guests on the Turnstile token and only then resolves', () => {
    assert.match(ECE, /\.on\(\s*['"]click['"]/, "missing ECE 'click' handler");
    assert.match(ECE, /this\.isGuestCheckout\s*&&\s*!this\.turnstileToken/,
        'guests without a Turnstile token must be blocked before the wallet sheet opens');
    assert.match(ECE, /event\.resolve\(\)/, 'a registered click handler must call event.resolve() to open the sheet');
});

// ─────────────────────────────────────────────────────────────────────────────
// E5 — confirm: deferred sequence, own instance, no billing_details, paymentFailed
// ─────────────────────────────────────────────────────────────────────────────

test('E5 confirm submits the ECE instance, reuses createStripeOrder(stripe-wallet)', () => {
    assert.match(ECE, /\.on\(\s*['"]confirm['"]/, "missing ECE 'confirm' handler");
    assert.match(ECE, /this\.eceElements\.submit\(\)/, 'confirm must submit the ECE instance (deferred flow)');
    assert.match(ECE, /this\.createStripeOrder\(\s*['"]stripe-wallet['"]\s*\)/,
        "wallet attempts must use the 'stripe-wallet' idempotency label to avoid card collisions");
});

test('E5b confirm uses eceElements and does NOT pass payment_method_data (wallet supplies billing)', () => {
    const confirmIdx = ECE.indexOf(".on('confirm'");
    const confirmBlock = ECE.slice(confirmIdx);
    assert.match(confirmBlock, /confirmPayment\(\{[\s\S]*?elements:\s*this\.eceElements/,
        'ECE must confirm on its own Elements instance');
    // Match the actual object key (with colon), not the explanatory comment.
    assert.doesNotMatch(confirmBlock, /payment_method_data\s*:/,
        'ECE confirm must omit the payment_method_data.billing_details key — the wallet supplies them');
});

test('E5c confirm calls event.paymentFailed() on failure so the wallet sheet never hangs', () => {
    assert.match(ECE, /event\.paymentFailed\(/,
        'every pre-redirect failure must call event.paymentFailed() or the sheet hangs on its spinner');
});

// ─────────────────────────────────────────────────────────────────────────────
// E6 — shared order helper + card path still wired to it
// ─────────────────────────────────────────────────────────────────────────────

test('E6 createStripeOrder is the single order-creation helper; card path uses it', () => {
    assert.match(PAY_JS, /async\s+createStripeOrder\(\s*idempotencyLabel\s*\)/,
        'expected the extracted createStripeOrder(idempotencyLabel) helper');
    assert.match(PAY_JS, /this\.createStripeOrder\(\s*['"]stripe['"]\s*\)/,
        'the card path (handlePayment) must call createStripeOrder(\'stripe\')');
    // The helper returns a discriminated result the callers branch on.
    assert.match(PAY_JS, /status:\s*['"]confirm['"]/);
    assert.match(PAY_JS, /status:\s*['"]navigated['"]/);
    assert.match(PAY_JS, /status:\s*['"]handled['"]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// E7 — amount stays in sync; block removed if the total is unknown
// ─────────────────────────────────────────────────────────────────────────────

test('E7 calculateTotals syncs the ECE amount and hides the block on totals failure', () => {
    assert.match(PAY_JS, /this\.eceElements\.update\(\{\s*amount:\s*amountCents\s*\}\)/,
        'the wallet sheet total must track the card total (coupon/points re-apply re-runs calculateTotals)');
    // In the catch (totals failed) the wrapper is removed so no wallet confirms a $1 fallback.
    const catchIdx = PAY_JS.indexOf('Server totals unavailable');
    const catchBlock = PAY_JS.slice(catchIdx, catchIdx + 800);
    assert.match(catchBlock, /getElementById\(\s*['"]express-checkout-wrapper['"]\s*\)\?\.remove\(\)/,
        'a totals failure must remove the Express Checkout block');
});

// ─────────────────────────────────────────────────────────────────────────────
// E8 — dead selector fix + CSP + cache token
// ─────────────────────────────────────────────────────────────────────────────

test('E8 showEmailVerificationRequired no longer references the dead #submit-payment id', () => {
    assert.doesNotMatch(PAY_JS, /getElementById\(\s*['"]submit-payment['"]\s*\)/,
        "'#submit-payment' never existed — the button is #pay-now-btn");
});

test('E8b CSP frame-src allows pay.google.com for the Google Pay sheet', () => {
    const csp = VERCEL.match(/"Content-Security-Policy"[\s\S]*?"value":\s*"([^"]+)"/);
    assert.ok(csp, 'CSP header not found in vercel.json');
    const frameSrc = csp[1].match(/frame-src ([^;]+);/);
    assert.ok(frameSrc, 'frame-src directive not found');
    assert.match(frameSrc[1], /https:\/\/pay\.google\.com/, 'Google Pay needs pay.google.com in frame-src');
});

test('E8c payment.html references payment-page.js with an 8-hex cache token', () => {
    assert.match(PAY_HTML, /\/js\/payment-page\.js\?v=[0-9a-f]{8}/,
        'payment-page.js must carry a build-stamped ?v= token (bump via npm run build)');
});
