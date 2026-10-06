/**
 * Checkout funnel (ERR-305) — backend handoff ad-clicks-to-orders §8 (2 Oct
 * 2026 walk of the paid visitor's path) and FE master checklist items 1, 2, 3,
 * 4, 9, 11 and the cart half of 6.
 *
 * Logic is EXECUTED (methods lifted from the shipping source and run in a vm);
 * markup is read from the shipping HTML. The live geometry and timing are
 * measured by `npm run probe:checkout-funnel -- --seed`.
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
const html = (rel) => read(rel).replace(/<!--[\s\S]*?-->/g, '');

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
/** Compile a method from a shipping file into a function called with `self` as this. */
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = extractMethod(read(file), name);
    const ctx = vm.createContext({ formatPrice: (n) => '$' + Number(n).toFixed(2), setTimeout, clearTimeout, Promise, ...globals });
    const fn = vm.runInContext(`(${async ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}
/** Values built inside a vm have another realm's Object.prototype; compare their data. */
const plain = (v) => JSON.parse(JSON.stringify(v));
/** A tiny id → element map standing in for the DOM. */
function fakeDom(ids) {
    const els = {};
    for (const id of ids) els[id] = { id, textContent: '', hidden: true, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } };
    return { els, document: { getElementById: (id) => els[id] || null } };
}

const LIVE_SUMMARY = { // GET /api/cart, guest, one CCLI681XXLBK — measured 2026-10-05
    subtotal: 30.79, shipping: 7, discount: 0, total: 37.79, is_shipping_estimate: true,
    free_shipping_threshold: 100, qualifies_for_free_shipping: false,
};

// ═══ §8.3 / item 4 — one shipping figure, inside the cart total ═══════════════

test('§8.3 cart total row SHOWS the server total; it never adds one up', () => {
    const model = method('js/cart.js', '_totalRowModel');
    assert.deepEqual(plain(model(LIVE_SUMMARY, 30.79)), { label: 'Estimated total', value: 37.79, source: 'server' });
    assert.deepEqual(plain(model({ ...LIVE_SUMMARY, is_shipping_estimate: false }, 30.79)), { label: 'Total', value: 37.79, source: 'server' });
    assert.deepEqual(plain(model({ subtotal: 120, shipping: 0, total: 120, qualifies_for_free_shipping: true }, 120)),
        { label: 'Total', value: 120, source: 'server' });
    // No server total ⇒ the ERR-296 label and the pre-shipping figure, marked fallback.
    assert.deepEqual(plain(model(null, 30.79)), { label: 'Total before shipping', value: 30.79, source: 'fallback' });
    assert.deepEqual(plain(model({ subtotal: 30.79 }, 30.79)), { label: 'Total before shipping', value: 30.79, source: 'fallback' });
    // A total whose shipping is unknown or a 0 that is not "free" is not an estimated total.
    assert.equal(model({ total: 30.79, shipping: 0 }, 30.79).source, 'fallback', 'absence is never read as free shipping');
    assert.equal(model({ total: NaN, shipping: 7 }, 30.79).source, 'fallback');
    // The model body contains no money arithmetic at all.
    const body = stripComments(extractMethod(read('js/cart.js'), '_totalRowModel').body);
    assert.doesNotMatch(body, /[-+]\s*s\.(shipping|subtotal|discount)|s\.total\s*[-+]/);
});

test('§8.3 both cart renderers paint the total through renderTotalRow (and the sticky bar label)', () => {
    const code = stripComments(read('js/cart.js'));
    assert.doesNotMatch(code, /totalEl\.textContent = formatPrice\(cartTotal\)/, 'no renderer may paint subtotal − discount directly');
    assert.equal((code.match(/this\.renderTotalRow\(cartTotal\)/g) || []).length, 2, '_updateCartSummaryDOM and renderCart');
    const { els, document } = fakeDom(['cart-total', 'cart-total-label', 'cart-total-row', 'cart-sticky-label']);
    const self = { serverSummary: LIVE_SUMMARY, _totalRowModel: method('js/cart.js', '_totalRowModel') };
    method('js/cart.js', 'renderTotalRow', self, { document })(30.79);
    assert.equal(els['cart-total'].textContent, '$37.79 NZD');
    assert.equal(els['cart-total-label'].textContent, 'Estimated total');
    assert.equal(els['cart-total-row'].dataset.totalSource, 'server');
    assert.equal(els['cart-sticky-label'].textContent, 'Estimated total');
    self.serverSummary = null;
    method('js/cart.js', 'renderTotalRow', self, { document })(30.79);
    assert.equal(els['cart-total-label'].textContent, 'Total before shipping');
    assert.equal(els['cart-sticky-label'].textContent, 'Before shipping');
    assert.equal(els['cart-total-row'].dataset.totalSource, 'fallback', 'the partial state is LOUD');
});

test('§8.3 the shipping row is labelled an estimate only while the server says so', () => {
    const { els, document } = fakeDom(['cart-shipping', 'cart-shipping-label']);
    const self = { serverSummary: LIVE_SUMMARY, _shippingRowText: method('js/cart.js', '_shippingRowText') };
    const run = () => method('js/cart.js', 'renderShippingRow', self, { document })();
    run();
    assert.equal(els['cart-shipping'].textContent, '$7.00 · free over $100');
    assert.equal(els['cart-shipping-label'].textContent, 'Shipping (est.)');
    self.serverSummary = { ...LIVE_SUMMARY, is_shipping_estimate: false };
    run();
    assert.equal(els['cart-shipping-label'].textContent, 'Shipping');
    self.serverSummary = { qualifies_for_free_shipping: true };
    run();
    assert.equal(els['cart-shipping'].textContent, 'Free');
    assert.equal(els['cart-shipping-label'].textContent, 'Shipping');
});

test('§8.3 checkout: no placeholder figure — the cart\'s server estimate, else "Calculating…"', async () => {
    const est = (summary) => method('js/checkout-page.js', '_cartShippingEstimate', {}, { Cart: { serverSummary: summary } })();
    assert.equal(est(LIVE_SUMMARY).fee, 7);
    assert.equal(est({ qualifies_for_free_shipping: true, shipping: 0 }).fee, 0);
    assert.equal(est({ shipping: 0 }), null, 'a 0 that is not "qualifies" is not free');
    assert.equal(est(null), null);

    // No address yet: the local $12 table must NOT be consulted.
    let calculated = 0;
    const run = async (summary, fields) => {
        const self = { cartItems: [{ id: 'p1', quantity: 1 }], totals: { subtotal: 30.79 }, _cartShippingEstimate: method('js/checkout-page.js', '_cartShippingEstimate', {}, { Cart: { serverSummary: summary } }) };
        const document = { getElementById: (id) => ({ value: fields[id] || '' }), querySelector: () => null };
        await method('js/checkout-page.js', 'fetchShippingFromAPI', self, {
            document, Shipping: { calculate: () => { calculated++; return { fee: 12 }; } },
            API: { getShippingOptions: async () => { throw new Error('must not be asked without an address'); } },
            DebugLog: { warn() {}, log() {} },
        })();
        return self;
    };
    let self = await run(LIVE_SUMMARY, {});
    assert.equal(self.totals.shipping, 7);
    assert.equal(self._shippingSource, 'cart-estimate');
    self = await run(null, {});
    assert.equal(self.totals.shipping, null, 'nothing known ⇒ nothing printed');
    assert.equal(self._shippingSource, 'pending');
    assert.equal(calculated, 0, 'the local table never paints first (it said $12.00, then the server said $7.00)');

    const html_ = html('html/checkout.html');
    assert.match(html_, /id="checkout-shipping" data-shipping-source="pending">Calculating…</);
    assert.match(html_, /id="checkout-total">Calculating…</);
    const disp = stripComments(extractMethod(read('js/checkout-page.js'), 'updateTotalsDisplay').body);
    assert.match(disp, /Number\.isFinite\(this\.totals\.total\)/);
    assert.match(disp, /Calculating\\u2026/);
});

test('§8.3 checkout asks the server by postcode alone, and the local table only after the server failed', async () => {
    const asked = [];
    let calculated = 0;
    const self = { cartItems: [{ id: 'p1', quantity: 1 }], totals: { subtotal: 30.79 }, _cartShippingEstimate: () => null };
    const document = { getElementById: (id) => ({ value: id === 'postcode' ? '9016' : '' }), querySelector: () => null };
    const g = {
        document, DebugLog: { warn() {}, log() {} },
        Shipping: { calculate: () => { calculated++; return { fee: 12 }; } },
        API: { getShippingOptions: async (p) => { asked.push(p); const o = { fee: 7, zone: 'south-island', zone_label: 'South Island', tier: 'light' }; return { ok: true, data: { ...o, options: [o] } }; } },
    };
    await method('js/checkout-page.js', 'fetchShippingFromAPI', self, g)();
    assert.equal(asked[0].postal_code, '9016');
    assert.equal('region' in asked[0], false, 'an empty region is not sent');
    assert.equal(self.totals.shipping, 7);
    assert.equal(self._shippingSource, 'server');
    assert.equal(calculated, 0);
    g.API.getShippingOptions = async () => { throw new Error('503'); };
    await method('js/checkout-page.js', 'fetchShippingFromAPI', self, g)();
    assert.equal(calculated, 1);
    assert.equal(self._shippingSource, 'local-fallback', 'a local figure is always marked as one');
});

test('§8.3 a coupon or points change never swaps an address-priced fee for the generic cart estimate', () => {
    const est = method('js/checkout-page.js', '_cartShippingEstimate', {}, { Cart: { serverSummary: LIVE_SUMMARY } });
    const self = { totals: { subtotal: 30.79, shipping: 14 }, _shippingSource: 'server', _cartShippingEstimate: est };
    method('js/checkout-page.js', '_adoptCartShipping', self)(LIVE_SUMMARY);
    assert.equal(self.totals.shipping, 14, 'the rural fee for the typed address stays');
    self._shippingSource = 'pending'; self.totals.shipping = null;
    method('js/checkout-page.js', '_adoptCartShipping', self)(LIVE_SUMMARY);
    assert.equal(self.totals.shipping, 7, 'before an address, the cart estimate fills the gap');
    const code = stripComments(read('js/checkout-page.js'));
    assert.doesNotMatch(code, /\.totals\.shipping = (summary|s)\.shipping/, 'no path copies the cart estimate over a priced fee');
    assert.doesNotMatch(code, /shippingEl\.textContent = this\.totals\.shipping === 0/, 'ONE renderer paints the shipping cell (updateTotalsDisplay)');
});

// ═══ item 6 (cart half) — points to be earned ═════════════════════════════════

test('item 6: "Points to be earned" reads loyalty.earn_on_this_order; absent is hidden, never 0', () => {
    const { els, document } = fakeDom(['cart-points-earn', 'cart-points-earn-value']);
    const run = (loyalty, count = 1) => method('js/cart.js', 'renderPointsEarn', { loyalty, getItemCount: () => count }, { document })();
    run({ guest: true, earn_on_this_order: 30 });
    assert.equal(els['cart-points-earn'].hidden, false);
    assert.equal(els['cart-points-earn-value'].textContent, '30 points');
    assert.equal(els['cart-points-earn'].dataset.points, '30');
    run(null);
    assert.equal(els['cart-points-earn'].hidden, true);
    assert.equal(els['cart-points-earn'].dataset.points, 'absent');
    run({ earn_on_this_order: 0 });
    assert.equal(els['cart-points-earn'].hidden, true);
    assert.equal(els['cart-points-earn'].dataset.points, 'zero');
    run({ earn_on_this_order: 30 }, 0);
    assert.equal(els['cart-points-earn'].hidden, true, 'an emptied cart earns nothing');
    assert.match(html('html/cart.html'), /id="cart-points-earn"[^>]*data-points="absent" hidden>/);
});

// ═══ §8.1 / item 9 — Proceed to Checkout in under a second ════════════════════

test('§8.1 the click never waits for Turnstile, and waits for validate at most the cap', async () => {
    const code = stripComments(read('js/cart.js'));
    assert.doesNotMatch(code, /_takeTurnstileToken|prefetchTurnstile|getTurnstileToken/);
    const cap = Number((code.match(/CHECKOUT_VALIDATE_CAP_MS:\s*(\d+)/) || [])[1]);
    assert.ok(cap > 0 && cap < 1000, `cap ${cap}ms`);

    const hung = { CHECKOUT_VALIDATE_CAP_MS: 40, validateCart: () => new Promise(() => {}) };
    const t0 = Date.now();
    assert.deepEqual(plain(await method('js/cart.js', '_validateWithinCap', hung)()), { timedOut: true });
    assert.ok(Date.now() - t0 < 500);
    const quick = { CHECKOUT_VALIDATE_CAP_MS: 1000, validateCart: async () => ({ valid: true }) };
    assert.deepEqual(plain(await method('js/cart.js', '_validateWithinCap', quick)()), { valid: true });
    const broken = { CHECKOUT_VALIDATE_CAP_MS: 1000, validateCart: async () => { throw new Error('503'); } };
    await assert.rejects(method('js/cart.js', '_validateWithinCap', broken)(), /503/, 'a failure still reaches the proceed-anyway catch');
});

test('§8.1 the button answers at once, a second click is ignored, and there is ONE navigation', () => {
    const fn = stripComments(extractMethod(read('js/cart.js'), 'bindCheckoutButton').body);
    const busy = fn.indexOf('self._setCheckoutBusy(checkoutLink, true)');
    const wait = fn.indexOf('await self._validateWithinCap()');
    assert.ok(busy > 0 && busy < wait, 'feedback before the first await');
    assert.match(fn, /getAttribute\('aria-busy'\) === 'true'\) return;/);
    assert.equal((fn.match(/window\.location\.href = '\/checkout'/g) || []).length, 1);
    assert.match(fn, /addEventListener\('pageshow'/, 'a bfcached /cart gets its button back');
});

test('§8.1 payment: Pay is not disabled waiting for the bot check; a press waits behind a spinner', async () => {
    const btn = { disabled: true };
    const document = { getElementById: () => btn };
    const update = (self) => method('js/payment-page.js', 'updatePayButton', self, { document })();
    update({ paymentElementReady: true, isGuestCheckout: true, turnstileToken: null });
    assert.equal(btn.disabled, false, 'card complete ⇒ Pay enabled, token or not');
    update({ paymentElementReady: false, isGuestCheckout: false });
    assert.equal(btn.disabled, true);

    const self = { turnstileToken: null, _turnstileWaiters: [], TURNSTILE_REFRESH_MS: 10, isSubmitting: false, resetTurnstile() {} };
    const wait = method('js/payment-page.js', '_awaitTurnstileToken', self);
    const pending = wait(5000);
    method('js/payment-page.js', '_onTurnstileToken', self)('tok-1');
    assert.equal(await pending, 'tok-1', 'a press waiting for the token gets it the moment it lands');
    clearTimeout(self._turnstileRefreshTimer);
    self.turnstileToken = null;
    assert.equal(await wait(20), null, 'and gives up after the cap');

    const pay = stripComments(extractMethod(read('js/payment-page.js'), 'handlePayment').body);
    assert.match(pay, /await this\._awaitTurnstileToken\(this\.TURNSTILE_PAY_WAIT_MS\)/);
    assert.match(stripComments(read('js/payment-page.js')), /appearance: 'interaction-only'/);
});

// ═══ §8.4 / item 1 — no ticks before paying ═══════════════════════════════════

test('§8.4 no "I authorize this payment" tick; no Terms tick; the agreement line sits under Pay', () => {
    const payJs = stripComments(read('js/payment-page.js'));
    assert.doesNotMatch(payJs, /paymentAuthorized|AuthorizationBox|authorize-payment/);
    const pay = html('html/payment.html').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(pay, /id="authorize-payment"|I authorize this payment|class="payment-authorization/);
    // \sid= — `data-testid="pay-terms"` contains the bare substring too (red-proof caught it).
    const btn = pay.search(/\sid="pay-now-btn"/), terms = pay.search(/\sid="pay-terms"/);
    assert.ok(btn > 0 && terms > btn, 'the line follows the Pay button');
    assert.match(pay, /By placing this order you agree to our <a href="\/terms"[^>]*>Terms &amp; Conditions<\/a> and <a href="\/privacy"[^>]*>Privacy Policy<\/a>\./);
    assert.doesNotMatch(html('html/checkout.html'), /id="terms"/);
    assert.doesNotMatch(stripComments(read('js/checkout-page.js')), /getElementById\('terms'\)|termsAccepted/);
});

// ═══ §8.2 / item 3 — the button that leads on is the one you see ══════════════

test('§8.2 checkout button directly after the money rows; Continue Shopping is a text link', () => {
    const cart = html('html/cart.html');
    const iTotals = cart.indexOf('class="cart-summary__totals"');
    const iCta = cart.indexOf('id="checkout-btn"');
    const iMsg = cart.indexOf('id="cart-shipping-message"');
    const iBar = cart.indexOf('id="cart-shipping-bar"');
    const iOptin = cart.indexOf('id="cart-guest-email"');
    assert.ok(iTotals > 0 && iTotals < iCta, 'money rows, then the button');
    assert.ok(iCta < iMsg && iCta < iBar, 'the free-shipping message and bar went below it (they put it at y 829 of 768)');
    assert.ok(iCta < iOptin, 'ERR-302 order kept');
    assert.match(cart, /<a href="\/shop" class="cart-actions__continue">/);
    assert.doesNotMatch(cart, /<a href="\/shop" class="btn btn--secondary">\s*<svg[\s\S]{0,400}Continue Shopping/);
    const css = read('css/pages.css');
    assert.match(css, /\.cart-actions__continue \{[^}]*text-decoration: underline/);
    assert.match(css, /body:has\(#cart-layout\) \.toast-container \{ top: var\(--spacing-6\); bottom: auto; \}/,
        'a desktop toast landed on the moved button for ~6s');
    // 1280x551 / 1366x599 / 1536x695: the money rows alone end below the fold,
    // so the sticky bar serves laptops too — right-aligned, clear of the
    // bottom-LEFT consent card, and not lifted over it.
    assert.match(css, /@media \(min-width: 769px\) \{\s*\.cart-sticky-bar \{ display: block; \}\s*\.cart-sticky-bar__inner \{ justify-content: flex-end; \}/);
    assert.match(css, /@media \(min-width: 1100px\) \{\s*body\.has-consent-banner \.cart-sticky-bar \{ bottom: 0; \}/);
});

// ═══ §8.5 / item 11 — polish ═══════════════════════════════════════════════════

test('§8.5 the payment summary prints the region LABEL; the API still gets the slug', () => {
    const line = method('js/payment-page.js', 'regionLine');
    assert.equal(line({ city: 'Kelston', region: 'auckland', regionLabel: 'Auckland', postcode: '0602' }), 'Kelston, Auckland 0602');
    assert.equal(line({ city: 'Auckland', region: 'auckland', regionLabel: 'Auckland', postcode: '0627' }), 'Auckland 0627', 'was "Auckland, auckland 0627"');
    assert.equal(line({ city: 'Napier', region: 'hawkes-bay', postcode: '4110' }), 'Napier, Hawkes Bay 4110', 'old checkoutData without a label');
    const co = stripComments(read('js/checkout-page.js'));
    assert.match(co, /region: formData\.get\('region'\),\s*regionLabel:/);
    const pay = stripComments(read('js/payment-page.js'));
    // The slug when there is one; omitted (never '') when a wallet address has none (BF-100).
    assert.match(pay, /\.\.\.\(this\.checkoutData\.region \? \{ region: this\.checkoutData\.region \} : \{\}\),/, 'the order still carries the slug');
});

test('§8.5 NZ Post suggest asks for 8', () => {
    assert.match(stripComments(read('js/api.js')), /async nzpostSuggest\(query, max = 8\)/);
});

// ═══ item 2 — Apple Pay / Google Pay from the cart (ships OFF) ════════════════

const CartWallet = require(path.join(ROOT, 'js/cart-wallet.js'));

test('item 2: OFF by default; on only by the flag or ?wallet=1', () => {
    assert.match(stripComments(read('js/config.js')), /cartWallet: false,/);
    assert.equal(CartWallet.isEnabled({ DARK_FEATURES: { cartWallet: false } }, ''), false);
    assert.equal(CartWallet.isEnabled({ DARK_FEATURES: { cartWallet: true } }, ''), true);
    assert.equal(CartWallet.isEnabled({ DARK_FEATURES: {} }, '?wallet=1'), true);
    assert.equal(CartWallet.isEnabled({ DARK_FEATURES: {} }, '?wallet=yes'), false);
    assert.match(html('html/cart.html'), /<div class="cart-wallet" id="cart-wallet" data-testid="cart-wallet" hidden>/);
});

test('item 2: the wallet address becomes the SAME checkoutData the card path sends — and never guesses', () => {
    assert.equal(CartWallet.regionSlug('Auckland'), 'auckland');
    assert.equal(CartWallet.regionSlug("Hawke's Bay"), 'hawkes-bay');
    assert.equal(CartWallet.regionSlug('Manawatū-Whanganui'), 'manawatu-wanganui');
    assert.equal(CartWallet.regionSlug('Canterbury Region'), 'canterbury');
    assert.equal(CartWallet.regionSlug(''), '');
    assert.equal(CartWallet.regionSlug('Kelston'), '', 'not a region ⇒ no region, never a guess');

    const ship = { fee: 7, tier: 'light', zone: 'auckland' };
    const ev = {
        billingDetails: { email: 'a@b.nz', phone: '+6421000000' },
        shippingAddress: { name: 'Mary Jane Smith', address: { line1: '37A Archibald Road', city: 'Auckland', state: 'Auckland', postal_code: '0602', country: 'NZ' } },
    };
    const { data } = CartWallet.toCheckoutData(ev, ship);
    assert.equal(data.firstName, 'Mary Jane');
    assert.equal(data.lastName, 'Smith');
    assert.equal(data.region, 'auckland');
    assert.equal(data.estimatedShipping, 7);
    assert.equal('deliveryType' in data, false, 'delivery_type is omitted, never guessed (ERR-25x)');
    assert.equal(data.saveAddress, false, 'a wallet address is not saved behind the shopper\'s back');

    // BF-100 (backend 2026-10-06): region is optional — a blank or unknown
    // `state` sends NO region (the zone comes from the postcode), never a guess.
    for (const state of ['', 'Kelston']) {
        const blank = { ...ev, shippingAddress: { ...ev.shippingAddress, address: { ...ev.shippingAddress.address, state } } };
        const r = CartWallet.toCheckoutData(blank, ship);
        assert.equal(r.error, undefined, `state ${JSON.stringify(state)} is accepted`);
        assert.equal(r.data.region, '', 'no region, never a guess');
        assert.equal(r.data.postcode, '0602');
    }
    // …but city and a 4-digit postal_code stay required.
    for (const postal_code of ['602', '06021', 'AB12', '']) {
        const bad = { ...ev, shippingAddress: { ...ev.shippingAddress, address: { ...ev.shippingAddress.address, postal_code } } };
        assert.ok(CartWallet.toCheckoutData(bad, ship).error, `postal_code ${JSON.stringify(postal_code)} refused`);
    }
    const noCity = { ...ev, shippingAddress: { ...ev.shippingAddress, address: { ...ev.shippingAddress.address, city: '' } } };
    assert.match(CartWallet.toCheckoutData(noCity, ship).error, /incomplete/);
    const au = { ...ev, shippingAddress: { ...ev.shippingAddress, address: { ...ev.shippingAddress.address, country: 'AU' } } };
    assert.match(CartWallet.toCheckoutData(au, ship).error, /New Zealand/);
    assert.match(CartWallet.toCheckoutData(ev, null).error, /price delivery/);
    assert.match(CartWallet.toCheckoutData({ ...ev, billingDetails: {} }, ship).error, /email/);
});

test('item 2: ONE order path — the cart wallet calls PaymentPage.createStripeOrder, and /payment boots only on /payment', () => {
    const src = stripComments(read('js/cart-wallet.js'));
    assert.match(src, /Object\.create\(PaymentPage\)/);
    assert.match(src, /ctx\.createStripeOrder\('stripe-cart-wallet'\)/);
    assert.doesNotMatch(src, /API\.createOrder\(/, 'no second order builder to drift');
    assert.match(src, /event\.paymentFailed\(/);
    const boot = stripComments(read('js/payment-page.js'));
    assert.match(boot, /DOMContentLoaded', \(\) => \{\s*if \(!document\.getElementById\('payment-form'\)\) return;/);
    // Unversioned: a ?v= literal in JS is never restamped by the deploy and would
    // pin a stale build as immutable (page-load-latency §2).
    assert.match(src, /PAYMENT_PAGE_JS: '\/js\/payment-page\.js',/);
});
