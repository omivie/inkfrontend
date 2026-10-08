/**
 * FE master checklist, 8 Oct re-issue: items 19 and 20
 * =============================================================================
 * Source: the backend's FE-MASTER-CHECKLIST-oct2026 (8 Oct). The other open
 * items of that issue (18, the compatible-PDP fold, compatible_alternatives[].id)
 * belong to a peer session and have their own suite.
 *
 *   §19  An UNTICKED "Email me when my cartridges are likely running low" box
 *        on /checkout. Only a tick sends `reminder_consent: true` on
 *        POST /api/orders (the backend records consent for a literal true
 *        only). It is the same for guests and signed-in shoppers, and on BOTH
 *        order rails (Stripe and PayPal).
 *   §20  The cart's Apple Pay / Google Pay button appeared 2–3 s after the page
 *        (measured 8 Oct: 3.3 s with a cold cache). Three changes:
 *        - hold the space from the first paint;
 *        - start Stripe.js and payment-page.js while the cart loads;
 *        - mount the Express Checkout Element on a provisional amount.
 *        Every figure the sheet shows is still the server's.
 *
 * Behaviour is EXECUTED: the real cart-wallet.js runs in a vm against a fake
 * Stripe and a fake script loader with a timeline, and the real methods are
 * extracted from checkout-page.js and payment-page.js.
 *
 * Run: node --test tests/fe-master-checklist-8oct-2026.test.js
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (src, re, label) => assert.ok(re.test(src), `${label || ''} — expected ${re}`);
const hasNot = (src, re, label) => assert.ok(!re.test(src), `${label || ''} — must not match ${re}`);

function extractMethod(raw, name) {
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
    const { params, body, async } = extractMethod(read(file), name);
    const ctx = vm.createContext({ setTimeout, clearTimeout, Promise, JSON, Math, Number, String, Array, Object, ...globals });
    const fn = vm.runInContext(`(${async ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}

// ═══ §19 reorder-reminder consent ════════════════════════════════════════════

test('§19 /checkout carries ONE unticked reminder box, near the email, visible to every shopper', () => {
    const html = stripComments(read('html/checkout.html'));
    const m = /<label class="checkout-optin" id="reminder-consent-optin"([^>]*)>([\s\S]*?)<\/label>/.exec(html);
    assert.ok(m, 'the box exists');
    hasNot(m[1], /hidden/, 'not hidden: guests AND signed-in shoppers see it');
    const input = /<input[^>]*id="reminder-consent"[^>]*>/.exec(m[2]);
    assert.ok(input, 'the checkbox');
    has(input[0], /type="checkbox"/);
    hasNot(input[0], /\bchecked\b/, 'a pre-ticked box is not consent');
    has(input[0], /autocomplete="off"/, 'no form-restore of an old tick');
    has(m[2], /Email me when my cartridges are likely running low, so I can reorder in time\./, 'the backend copy, verbatim');
    // Near the email field: in the same form-group, after the email input.
    const email = html.indexOf('id="email"');
    const box = html.indexOf('id="reminder-consent-optin"');
    const phone = html.indexOf('id="phone"');
    assert.ok(email > 0 && email < box && box < phone, 'between the email and phone fields');
});

test('§19 the box starts unticked on EVERY visit, including a bfcache restore', () => {
    const src = stripComments(read('js/checkout-page.js'));
    has(src, /this\.setupGuestCartEmail\(\);\s*this\.setupReminderConsent\(\);/, 'wired in init()');
    const box = { checked: true };
    const listeners = {};
    const run = method('js/checkout-page.js', 'setupReminderConsent', {}, {
        document: { getElementById: (id) => (id === 'reminder-consent' ? box : null) },
        window: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
    });
    run();
    assert.equal(box.checked, false, 'forced unticked at load');
    box.checked = true;
    listeners.pageshow({ persisted: true });
    assert.equal(box.checked, false, 'forced unticked on a bfcache restore');
    box.checked = true;
    listeners.pageshow({ persisted: false });
    assert.equal(box.checked, true, 'a normal load already ran init');
    // Never restored from saved checkout state.
    const restore = extractMethod(read('js/checkout-page.js'), 'restoreCheckoutState').body;
    hasNot(restore, /reminder/i, 'restoreCheckoutState never brings a tick back');
});

test('§19 checkoutData carries the tick to /payment as a strict boolean', () => {
    const src = stripComments(read('js/checkout-page.js'));
    has(src, /reminderConsent: document\.getElementById\('reminder-consent'\)\?\.checked === true,/);
});

test('§19 only a literal true becomes `reminder_consent: true`; otherwise the key is ABSENT', () => {
    // JSON: the method runs in a vm realm, so its objects have another Object.prototype.
    const field = (d) => JSON.stringify(method('js/payment-page.js', 'reminderConsentField')(d));
    assert.equal(field({ reminderConsent: true }), '{"reminder_consent":true}');
    for (const v of [false, undefined, null, 'true', 1, 'on']) {
        assert.equal(field({ reminderConsent: v }), '{}', `reminderConsent: ${JSON.stringify(v)}`);
    }
    assert.equal(field(null), '{}');
    assert.equal(field(undefined), '{}');
});

test('§19 BOTH order rails send it (Stripe and PayPal), from the one helper', () => {
    const src = stripComments(read('js/payment-page.js'));
    const stripe = extractMethod(read('js/payment-page.js'), 'createStripeOrder').body;
    has(stripe, /\.\.\.this\.reminderConsentField\(this\.checkoutData\),/, 'Stripe (card, /payment wallet, cart wallet)');
    has(src, /payment_method: 'paypal',[\s\S]{0,200}\.\.\.self\.reminderConsentField\(self\.checkoutData\),/, 'PayPal');
    assert.equal((src.match(/reminderConsentField\(/g) || []).length, 3, 'one definition + two call sites');
    hasNot(src, /reminder_consent:\s*false/, 'never sends false');
});

test('§19 the cart wallet asks no consent question, so it sends nothing', () => {
    const CartWallet = require(path.join(ROOT, 'inkcartridges/js/cart-wallet.js'));
    const ev = {
        billingDetails: { email: 'a@b.nz', phone: '+6421000000' },
        shippingAddress: { name: 'Mary Smith', address: { line1: '1 Queen St', city: 'Auckland', state: 'Auckland', postal_code: '1010', country: 'NZ' } },
    };
    const { data } = CartWallet.toCheckoutData(ev, { fee: 7, tier: '', zone: 'auckland' });
    assert.equal('reminderConsent' in data, false);
    assert.equal(JSON.stringify(method('js/payment-page.js', 'reminderConsentField')(data)), '{}');
});

// ═══ §20 the cart wallet appears with the page ═══════════════════════════════

const WALLET_SRC = read('js/cart-wallet.js');

/**
 * The real cart-wallet.js in a vm with a timeline. Scripts "load" after
 * `stripeMs` / `pageMs`. The cart fills its local lines at `localAt` ms and is
 * "ready" (with server totals) at `readyMs`. Stripe's ECE reports `apm` 10 ms
 * after mount.
 */
function wallet(opts = {}) {
    const {
        flag = true, storage = {}, storageThrows = false, signedIn = true,
        localItems = 1, serverItems = localItems, localAt = 0, readyMs = 80,
        summary = { subtotal: 67.49, discount: 0, shipping: 7, qualifies_for_free_shipping: false },
        stripeMs = 20, pageMs = 20, pageOk = true, apm = { applePay: false, googlePay: true },
    } = opts;
    const t0 = Date.now();
    const log = [];
    const at = (what, extra) => log.push({ what, t: Date.now() - t0, ...(extra !== undefined ? { extra } : {}) });
    const box = { dataset: { wallet: 'loading' }, hidden: false };
    const status = { textContent: '', hidden: true };
    const handlers = {};
    const line = () => ({ id: 'p1', quantity: 1 });
    const Cart = { items: [], serverSummary: null, loading: true };
    setTimeout(() => { if (localItems) Cart.items = Array.from({ length: localItems }, line); at('local-items'); }, localAt);
    const store = Object.assign(Object.create(null), storage);
    const ctx = {
        module: { exports: {} }, console, setTimeout, clearTimeout, Promise, URLSearchParams, JSON, Math, Number, String, Array, Object,
        Config: { DARK_FEATURES: { cartWallet: flag }, STRIPE_PUBLISHABLE_KEY: 'pk_test' },
        Auth: { isAuthenticated: () => signedIn },
        Cart,
        CartDeepLink: {
            _waitForCartReady: () => new Promise((r) => setTimeout(() => {
                Cart.items = Array.from({ length: serverItems }, line);
                Cart.serverSummary = serverItems ? summary : null;
                Cart.loading = false;
                at('cart-ready');
                r(true);
            }, readyMs)),
        },
        localStorage: {
            getItem: (k) => { if (storageThrows) throw new Error('blocked'); return k in store ? store[k] : null; },
            setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store[k] = String(v); },
            removeItem: (k) => { if (storageThrows) throw new Error('blocked'); delete store[k]; },
        },
        document: {
            getElementById: (id) => (id === 'cart-wallet' ? box : id === 'cart-wallet-status' ? status : null),
            createElement: () => ({}),
            head: {
                appendChild: (s) => {
                    const stripe = /stripe/.test(s.src);
                    at(stripe ? 'load:stripe' : (/payment-page/.test(s.src) ? 'load:payment-page' : 'load:other'));
                    setTimeout(() => {
                        if (stripe) ctx.Stripe = fakeStripe;
                        else if (/payment-page/.test(s.src) && pageOk) ctx.PaymentPage = {};
                        if (/payment-page/.test(s.src) && !pageOk) s.onerror(); else s.onload();
                    }, stripe ? stripeMs : pageMs);
                },
            },
        },
    };
    function fakeStripe() {
        return {
            elements(o) {
                at('elements', o.amount);
                return {
                    update(u) { at('update', u.amount); },
                    create() {
                        return {
                            on(name, fn) { handlers[name] = fn; },
                            mount() { at('mount'); setTimeout(() => { at('ece-ready'); handlers.ready({ availablePaymentMethods: apm }); }, 10); },
                        };
                    },
                };
            },
        };
    }
    vm.createContext(ctx);
    vm.runInContext(WALLET_SRC, ctx);
    const w = ctx.module.exports;
    ctx.window = { location: { search: '', origin: 'https://www.inkcartridges.co.nz' } };
    const first = (what) => log.find((e) => e.what === what);
    return { w, box, status, log, first, store, handlers, Cart };
}

test('§20 `loading` is VISIBLE (it holds the space); none / error / off hide the box', () => {
    const { w, box } = wallet();
    for (const [state, hidden] of [['loading', false], ['ready', false], ['none', true], ['error', true], ['off', true]]) {
        w._setState(state, 'x');
        assert.equal(box.hidden, hidden, state);
        assert.equal(box.dataset.wallet, state);
    }
});

test('§20 the markup ships visible as data-wallet="loading", with a 48px placeholder, and Stripe preconnects', () => {
    const html = read('html/cart.html');
    has(html, /<div class="cart-wallet" id="cart-wallet" data-testid="cart-wallet" data-wallet="loading">/);
    hasNot(html, /id="cart-wallet"[^>]*\shidden/, 'not hidden at first paint');
    has(html, /<link rel="preconnect" href="https:\/\/js\.stripe\.com">/);
    has(html, /<link rel="preconnect" href="https:\/\/b\.stripecdn\.com">/);
    // Preload = the SAME URL CartWallet._load injects, no crossorigin on either,
    // or the browser fetches Stripe.js twice.
    has(html, /<link rel="preload" href="https:\/\/js\.stripe\.com\/v3\/" as="script">/);
    assert.equal(require(path.join(ROOT, 'inkcartridges/js/cart-wallet.js')).STRIPE_JS, 'https://js.stripe.com/v3/');
    hasNot(stripComments(WALLET_SRC), /crossOrigin/, '_load injects a plain script');
    const css = stripComments(read('css/pages.css'));
    has(css, /#cart-wallet-element \{ min-height: 48px; \}/, 'the slot is the button height (buttonHeight: 48) in every state');
    has(css, /\.cart-wallet\[data-wallet="loading"\] #cart-wallet-element \{[^}]*background:/, 'a visible placeholder while loading');
    has(css, /\.cart-wallet\[hidden\] \{ display: none; \}/);
    has(stripComments(WALLET_SRC), /buttonHeight: 48,/, 'placeholder and button are the same height');
});

test('§20 prepaint: flag off ⇒ off; a remembered no-wallet device ⇒ hidden; else loading; blocked storage is safe', () => {
    let h = wallet({ flag: false });
    h.w.prepaint();
    assert.equal(h.w.state, 'off');
    assert.equal(h.box.hidden, true);
    h = wallet({ storage: { 'inkc.cartWallet.noDevice': '1' } });
    h.w.prepaint();
    assert.equal(h.w.state, 'none');
    assert.equal(h.w.why, 'remembered-no-wallet');
    assert.equal(h.box.hidden, true);
    h = wallet();
    h.w.prepaint();
    assert.equal(h.w.state, 'loading');
    assert.equal(h.box.hidden, false);
    h = wallet({ storageThrows: true });
    h.w.prepaint();
    assert.equal(h.w.state, 'loading', 'storage throwing ⇒ the placeholder, never a crash');
    has(stripComments(WALLET_SRC), /window\.CartWallet = CartWallet;\s*CartWallet\.prepaint\(\);/, 'runs as the deferred script evaluates');
});

test('§20 Stripe.js and payment-page.js start BEFORE the cart is ready, and the ECE mounts before it too', async () => {
    const h = wallet({ readyMs: 80, stripeMs: 20 });
    const done = h.w.init();
    await sleep(60);
    assert.equal(h.w.state, 'loading', 'ECE ready but the amount is provisional ⇒ still loading');
    assert.equal(h.box.hidden, false, 'the placeholder stays');
    await done;
    const ready = h.first('cart-ready').t;
    assert.ok(h.first('load:stripe').t < ready, 'Stripe.js requested before the cart was ready');
    assert.ok(h.first('load:payment-page').t < ready, 'payment-page.js requested before the cart was ready');
    assert.ok(h.first('mount').t < ready, 'mounted on the local lines, before the server total');
    assert.equal(h.first('elements').extra, 50, 'the provisional amount is STRIPE_MIN_NZD_CENTS');
    assert.equal(h.first('update').extra, 7449, 'then the SERVER total: 67.49 + 7.00');
    assert.ok(h.first('update').t >= ready);
    assert.equal(h.w.state, 'ready');
    assert.equal(h.w._serverAmount, true);
});

test('§20 never `ready` on a provisional amount, and a tap cannot open the sheet before the server total', async () => {
    const h = wallet({ readyMs: 120 });
    const done = h.w.init();
    await sleep(70);
    assert.equal(h.w.state, 'loading');
    let resolved = null;
    h.handlers.click({ resolve: (o) => { resolved = o; } });
    assert.equal(resolved, null, 'the sheet stays closed');
    assert.match(h.status.textContent, /updating your total/);
    await done;
    assert.equal(h.w.state, 'ready');
    h.handlers.click({ resolve: (o) => { resolved = o; } });
    assert.deepEqual(resolved.shippingRates[0].amount, 700, 'the server shipping figure');
});

test('§20 a cart the server empties (or never prices) ⇒ none, never a button', async () => {
    let h = wallet({ localItems: 1, serverItems: 0 });
    await h.w.init();
    assert.equal(h.w.state, 'none');
    assert.equal(h.w.why, 'no-server-total');
    assert.equal(h.box.hidden, true);
    assert.equal(h.log.filter((e) => e.what === 'update').length, 0, 'no amount from a cart that is not priced');

    h = wallet({ localItems: 0, serverItems: 0 });
    await h.w.init();
    assert.equal(h.w.state, 'none');
    assert.equal(h.first('mount'), undefined, 'an empty cart never mounts the ECE');
});

test('§20 an empty LOCAL cart waits for the server cart, then mounts (a returning guest on a new device)', async () => {
    const h = wallet({ localItems: 0, serverItems: 1, readyMs: 30 });
    await h.w.init();
    assert.ok(h.first('mount').t >= h.first('cart-ready').t);
    await sleep(20);
    assert.equal(h.w.state, 'ready');
});

test('§20 no wallet on this device ⇒ hidden and REMEMBERED; a wallet later clears the memory', async () => {
    let h = wallet({ apm: { applePay: false, googlePay: false } });
    await h.w.init();
    await sleep(20);
    assert.equal(h.w.state, 'none');
    assert.equal(h.w.why, 'no-wallet-on-device');
    assert.equal(h.store['inkc.cartWallet.noDevice'], '1');

    h = wallet({ storage: { 'inkc.cartWallet.noDevice': '1' } });
    h.w.prepaint();
    assert.equal(h.box.hidden, true, 'remembered ⇒ no placeholder');
    await h.w.init();
    await sleep(20);
    assert.equal(h.w.state, 'ready', 'still mounted: a wallet appears ⇒ shown');
    assert.equal('inkc.cartWallet.noDevice' in h.store, false, 'memory cleared');

    h = wallet({ storageThrows: true, apm: {} });
    await h.w.init();
    await sleep(20);
    assert.equal(h.w.state, 'none', 'blocked storage changes nothing else');
});

test('§20 payment-page.js failing to load ⇒ error, never a live button that cannot pay', async () => {
    const h = wallet({ pageOk: false });
    await h.w.init();
    await sleep(20);
    assert.equal(h.w.state, 'error');
    assert.equal(h.w.why, 'payment-page-js');
    assert.equal(h.box.hidden, true);
});

test('§20 _confirm is where payment-page.js is awaited, and a failed load fails the sheet loudly', async () => {
    const body = extractMethod(WALLET_SRC, 'init').body;
    hasNot(body, /await this\._pageP/, 'init never waits for payment-page.js');
    hasNot(body, /const okPage = await/, 'the old serial await is gone');
    const confirm = extractMethod(WALLET_SRC, '_confirm').body;
    has(confirm, /await \(this\._pageP \|\|/);

    const h = wallet();
    h.w._pageP = Promise.resolve(false);
    h.w.shipping = { fee: 7, tier: '', zone: 'auckland' };
    let failed = null;
    await h.w._confirm({
        billingDetails: { email: 'a@b.nz' },
        shippingAddress: { name: 'Mary Smith', address: { line1: '1 Queen St', city: 'Auckland', postal_code: '1010', country: 'NZ' } },
        paymentFailed: (o) => { failed = o; },
    });
    assert.equal(failed.reason, 'fail');
    assert.match(h.status.textContent, /Proceed to Checkout/);
});

test('§20 sync: a mounted wallet still `loading` follows the server total; off / error are left alone', async () => {
    const h = wallet({ readyMs: 250 });
    const done = h.w.init();
    await sleep(120); // past the first-lines poll (50ms) + Stripe load + the ECE's own ready
    assert.equal(h.w.state, 'loading');
    // The cart settles a server total before CartDeepLink's poll notices.
    h.Cart.serverSummary = { subtotal: 202.47, discount: 4.05, shipping: 0, qualifies_for_free_shipping: true };
    h.w.sync();
    assert.equal(h.first('update').extra, 19842);
    assert.equal(h.w.state, 'ready');
    await done;
    for (const st of ['off', 'error']) {
        h.w._setState(st, 'x');
        const before = h.log.length;
        h.w.sync();
        assert.equal(h.log.length, before, st);
    }
});
