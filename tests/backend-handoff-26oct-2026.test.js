/**
 * Backend handoff 26 Oct 2026 (backend-docs/inbox/fe-handoff-26oct2026.md),
 * items 49–58 — ERR-376.
 *
 *  51 (P0) a refused Pay press must not add the cart again: no cart sync
 *     before the order, the payload's quantities are the summary's, and the
 *     guest Turnstile token is spent on EVERY order answer.
 *  50 (P0) privacy: the phone-call paragraph and the Google Customer Reviews
 *     processor, byte for byte the prerendered page's words.
 *  52 shipping re-quoted on a postcode edit and before Pay; Pay never confirms
 *     a total the shopper has not seen; number pad for postcodes.
 *  53 the Payment Element never re-asks name / email / phone.
 *  55 the reviews badge is hidden while the cart drawer is open.
 *  56 the pack-swap chip says what it compares and never drops units.
 *  57 PayPal redirect return / cancel land on /checkout and capture safely.
 *  58 "1 item", never "1 items"; /cart/ redirects to /cart.
 *  49 owner-only "Below web price" / "Margin N%" chips on invoice and
 *     quick-order lines, from the quote.
 * (54, Afterpay in the accepted-payments rows, is pinned in
 *  footer-redesign-jul2026 §4 and merchant-center-readiness.)
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
const PAY_CODE = stripComments(PAY_SRC);
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Run payment-page.js in a VM with a stub world; returns PaymentPage + the stubs. */
function loadPay({ cartItems = [], serverItems = [], createOrder, guest = false } = {}) {
    const calls = { createOrder: [], addToCart: 0, reset: 0, confirm: 0, errors: [] };
    const nodes = {};
    const node = (id) => (nodes[id] = nodes[id] || { id, textContent: '', innerHTML: '', disabled: false, dataset: {}, classList: { add() {}, remove() {} }, scrollIntoView() {} });
    const store = {};
    const ctx = {
        document: { getElementById: node, addEventListener() {}, querySelectorAll: () => [] },
        sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        localStorage: { removeItem() {} },
        window: { location: { origin: 'https://www.example', href: '', search: '' } },
        Cart: { items: cartItems },
        Auth: { isAuthenticated: () => !guest, getUser: () => (guest ? null : { id: 'u1' }) },
        API: {
            getCart: async () => ({ ok: true, data: { summary: { subtotal: 54.09, shipping: 7, discount: 0 }, items: serverItems } }),
            addToCart: async () => { calls.addToCart++; return { ok: true }; },
            createOrder: async (b) => { calls.createOrder.push(plain(b)); return createOrder ? createOrder(b) : { ok: true, data: { order_number: 'N1', client_secret: 'cs', total_amount: 61.09, shipping_cost: 7 } }; },
            cancelOrder: async () => ({ ok: true }),
            extractErrorMessage: (r, d) => d,
        },
        showToast() {},
        DebugLog: { log() {}, warn() {}, error() {} },
        computeDiscountBreakdown: () => ({ loyalty: 0, b2b: 0, other: 0 }),
        businessDiscountLabel: () => '',
        getGclid: () => null, getGaClientId: () => null,
        TextEncoder, crypto: globalThis.crypto,
        setTimeout, clearTimeout, console, Promise,
    };
    vm.createContext(ctx);
    vm.runInContext(PAY_SRC + '\n;globalThis.__PP = PaymentPage;', ctx);
    const P = ctx.__PP;
    P.resetTurnstile = function () { calls.reset++; this.turnstileToken = null; };
    P.showError = (m) => calls.errors.push(m);
    P.checkoutData = { firstName: 'A', lastName: 'B', email: 'a@b.nz', phone: '021', address1: '1 St', city: 'Akl', region: 'auckland', postcode: '1010' };
    return { P, calls, ctx, store, nodes };
}

// ─── 51 ─────────────────────────────────────────────────────────────────────

test('51: no cart sync before the order — POST /api/cart/items is never called from payment-page.js', () => {
    assert.doesNotMatch(PAY_CODE, /API\.addToCart\(/, 'STEP 0.5 ADDED every line on every press (order 2026100602: 3 bought, 9 charged)');
    assert.doesNotMatch(PAY_CODE, /STEP 0\.5/);
    assert.equal((PAY_CODE.match(/API\.createOrder\(/g) || []).length, 1, 'one raw POST, inside _createOrderSpendingToken');
});

test('51: embedded, the payload carries the SUMMARY quantity even when the server cart was inflated', async () => {
    const line = { id: 'p-63xl', name: 'HP 63XL Black', quantity: 3, price: 54.09 / 3, printer_slug: null };
    // The server cart reads 9 — what three refused presses of the old STEP 0.5 left.
    const { P, calls } = loadPay({ cartItems: [line], serverItems: [{ product: { id: 'p-63xl', sku: 'H63XL' }, quantity: 9 }] });
    P.embedded = true;
    P.elements = { update() {} };
    await P.calculateTotals();
    assert.equal(P.cartItems[0].quantity, 3);
    await P.createStripeOrder('stripe');
    assert.equal(calls.addToCart, 0);
    assert.deepEqual(calls.createOrder[0].items.map((i) => i.quantity), [3]);
});

test('51: the Turnstile token is spent on EVERY order answer — success, refusal envelope, email refusal, throw', async () => {
    const answers = [
        { ok: true, data: { order_number: 'N1', client_secret: 'cs' } },
        { ok: false, code: 'ORDER_TOTAL_TOO_LOW', error: 'x' },
        { ok: false, code: 'VALIDATION_FAILED', error: 'email', details: [{ field: 'guest_email', message: 'bad email' }] },
        'throw',
    ];
    for (const a of answers) {
        const { P, calls } = loadPay({ cartItems: [{ id: 'p', quantity: 1 }], createOrder: () => { if (a === 'throw') throw new Error('400'); return a; } });
        P.showEmailRejected = () => {};
        try { await P.createStripeOrder('stripe'); } catch (_) { /* refusals throw — the reset still ran */ }
        assert.equal(calls.reset, 1, `reset after ${a === 'throw' ? 'a throw' : a.code || 'success'}`);
    }
    for (const fn of ['createPointsOrder']) {
        const { P, calls } = loadPay({ cartItems: [{ id: 'p', quantity: 1 }], createOrder: () => ({ ok: false, code: 'POINTS_NOT_APPLIED' }) });
        await P[fn]();
        assert.equal(calls.reset, 1, fn);
    }
});

test('51: a guest order sends the token held NOW (a retry body never re-sends the spent one)', async () => {
    const { P, calls } = loadPay({ guest: true, cartItems: [{ id: 'p', quantity: 1 }] });
    P.turnstileToken = 'fresh';
    await P._createOrderSpendingToken({ guest_email: 'a@b.nz', turnstile_token: 'spent' });
    assert.equal(calls.createOrder[0].turnstile_token, 'fresh');
    assert.equal(P.turnstileToken, null, 'spent after the answer');
});

test('51: PayPal builds its body with the ONE _orderPayload and posts through the wrapper', () => {
    const paypal = PAY_CODE.slice(PAY_CODE.indexOf('createOrder: async () => {'), PAY_CODE.indexOf('onApprove: async'));
    assert.match(paypal, /self\._orderPayload\('paypal', 'paypal'\)/);
    assert.equal((paypal.match(/self\._createOrderSpendingToken\(orderPayload\)/g) || []).length, 2, 'first try and the stale-duplicate retry');
    assert.doesNotMatch(paypal, /shipping_address:/, 'no hand-copied body');
});

// ─── 52 ─────────────────────────────────────────────────────────────────────

test('52: Pay re-quotes BEFORE collecting the details (card and PayPal)', async () => {
    const { P } = loadPay();
    const order = [];
    P.embedded = true;
    P.requote = async () => { order.push('requote'); };
    P.collect = async () => { order.push('collect'); return null; };
    await P.payNow();
    assert.deepEqual(order, ['requote', 'collect']);
    assert.match(PAY_CODE, /if \(typeof self\.requote === 'function'\) await self\.requote\(\);\s*const d = await self\.collect\(\);/);
});

test('52: an order total the shopper has not seen is painted and NOT confirmed; the next press confirms', () => {
    const { P, calls } = loadPay();
    let painted = null;
    P.shownTotal = () => 61.09;
    P.showServerTotal = (o) => { painted = o; };
    assert.equal(P.orderTotalCheck({ total_amount: 61.09 }), 'match');
    assert.equal(P.orderTotalCheck({ total_amount: 66.09, shipping_cost: 12 }), 'changed');
    assert.equal(painted.shipping_cost, 12);
    assert.match(calls.errors[0], /Your total is now \$66\.09/);
    // The panel now shows the order's figure; the replayed order matches it.
    P.shownTotal = () => 66.09;
    assert.equal(P.orderTotalCheck({ total_amount: 66.09 }), 'match');
    // Even if a re-quote repainted the parts, the figure already shown counts.
    P.shownTotal = () => 61.09;
    assert.equal(P.orderTotalCheck({ total_amount: 66.09 }), 'match');
    // No total in the answer: confirm, but say so — never a silent pass.
    assert.equal(P.orderTotalCheck({}), 'unverified');
});

test('52: handlePayment stops before confirmPayment when the total changed', async () => {
    const { P } = loadPay({ createOrder: () => ({ ok: true, data: { order_number: 'N1', client_secret: 'cs', total_amount: 66.09, shipping_cost: 12 } }) });
    let confirmed = 0;
    P.paymentElementReady = true;
    P.elements = { submit: async () => ({}) };
    P.stripe = { confirmPayment: async () => { confirmed++; return {}; } };
    P.cartItems = [{ id: 'p', quantity: 1 }];
    P.shownTotal = () => 61.09;
    P.showServerTotal = () => {};
    await P.handlePayment();
    assert.equal(confirmed, 0);
    assert.equal(P.isSubmitting, false, 'Pay is usable again');
    await P.handlePayment();
    assert.equal(confirmed, 1, 'second press: the figure on screen IS the order total');
});

test('52: postcode edits re-quote (debounced, 4 digits, only on change) and price the area labels', () => {
    const src = stripComments(read('js/checkout-page.js'));
    assert.match(src, /getElementById\('postcode'\)[\s\S]{0,400}addEventListener\('input', typeof debounce === 'function' \? debounce\(requote, this\.POSTCODE_REQUOTE_MS\) : requote\)/);
    assert.match(src, /if \(!pc \|\| pc === this\._quotedPostcode\) return;/);
    assert.match(src, /_quotablePostcode\(\) \{[\s\S]{0,160}\/\^\\d\{4\}\$\//);
    const refresh = src.slice(src.indexOf('async _refreshDeliveryPrices()'), src.indexOf('async _refreshDeliveryPrices()') + 2600);
    assert.match(refresh, /\.\.\.\(postalCode \? \{ postal_code: postalCode \} : \{\}\)/);
    assert.match(refresh, /const key = region \+ '\|' \+ postalCode \+ '\|'/);
    assert.match(refresh, /if \(\(!region && !postalCode\)/);
});

test('52: both postcode inputs open the number pad and keep type="text" (leading zeros)', () => {
    const html = read('html/checkout.html');
    assert.match(html, /<input type="text" inputmode="numeric" id="postcode"/);
    assert.match(html, /<input type="text" inputmode="numeric" id="billing-postcode"/);
});

// ─── 53 ─────────────────────────────────────────────────────────────────────

test('53: the Payment Element never asks name / email / phone; confirm always passes all three', () => {
    assert.match(PAY_CODE, /fields: \{ billingDetails: \{ name: 'never', email: 'never', phone: 'never' \} \}/);
    const confirm = PAY_CODE.slice(PAY_CODE.indexOf('payment_method_data: {'), PAY_CODE.indexOf('payment_method_data: {') + 500);
    assert.match(confirm, /name: `\$\{this\.checkoutData\.firstName\} \$\{this\.checkoutData\.lastName\}`/);
    assert.match(confirm, /email: this\.checkoutData\.email,/);
    assert.match(confirm, /phone: this\.checkoutData\.phone \|\| '',/, "'' — a 'never' field must be passed, undefined errors");
});

// ─── 50 ─────────────────────────────────────────────────────────────────────

const PHONE_PARA = "We may phone existing customers about their orders, reorders, quotes and account options. If you would rather we didn't, tell us and we won't call again.";
const GCR_ITEM = 'Google Customer Reviews (an optional survey Google may offer after an order) — only if you opt in: your email address, order number, delivery country, estimated delivery date and the barcodes of the products you ordered, so Google can send you the survey.';

test('50: /privacy carries the phone-call paragraph byte for byte, in the purpose section', () => {
    const html = read('html/privacy.html');
    const why = html.slice(html.indexOf('id="why"'), html.indexOf('id="legal-basis"'));
    assert.ok(why.includes(`<p>${PHONE_PARA}</p>`), 'straight apostrophes, no entities');
});

test('50: the processor table lists Google Customer Reviews in the prerendered page’s words', () => {
    const ctx = { window: {} };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('js/legal-config.js'), ctx);
    const cfg = ctx.window.LegalConfig || ctx.LegalConfig;
    const rows = cfg.dataProcessors;
    const i = rows.findIndex((r) => r.name === 'Google Customer Reviews');
    assert.notEqual(i, -1);
    assert.equal(`${rows[i].name} ${rows[i].purpose}`, GCR_ITEM);
    assert.equal(rows[i - 1].name, 'Google Ads / Microsoft Advertising', 'after Google Ads and Microsoft Advertising');
    assert.ok(cfg.paymentMethods.includes('Afterpay'), 'item 54: the legal pages list Afterpay too');
});

// ─── 55 ─────────────────────────────────────────────────────────────────────

test('55: the Google reviews badge is hidden while the cart drawer is open', () => {
    const css = read('css/components.css');
    assert.match(css, /html\.cart-drawer-open #google-reviews-badge \{\s*display: none !important;\s*\}/);
});

// ─── 56 + 58 (cart.js) ──────────────────────────────────────────────────────

function cartMethod(name, self, globals = {}) {
    const src = read('js/cart.js');
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, name);
    let depth = 0; const open = m.index + m[0].length - 1; let end = open;
    for (let i = open; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i; break; } }
    const ctx = vm.createContext({
        formatPrice: (n) => '$' + Number(n).toFixed(2),
        Security: { escapeAttr: (s) => String(s), escapeHtml: (s) => String(s) },
        ...globals,
    });
    const fn = vm.runInContext(`(${/async/.test(m[0]) ? 'async ' : ''}function (${m[1]}) ${src.slice(open, end + 1)})`, ctx);
    return (...a) => fn.apply(self, a);
}

test('56: the chip names the set and the singles it is measured against', () => {
    const self = {};
    self.packChipLabel = cartMethod('packChipLabel', self);
    self.cartItemKey = () => 'k';
    const render = cartMethod('renderLinePackSuggestion', self);
    const ps = { sku: 'BLC233VP', pack_price: '31.99', savings_amount: '2.27', individual_total: '34.26', cartridge_count: 4 };
    const one = render({ key: 'k1', quantity: 1, pack_suggestion_for_line: ps });
    assert.match(one, /4-cartridge set \$31\.99 — \$2\.27 less than the 4 singles/);
    assert.doesNotMatch(one, /save up to|best value/i);
    assert.equal(render({ key: 'k3', quantity: 3, pack_suggestion_for_line: ps }), '', 'hidden on a line of 3');
    assert.match(self.packChipLabel({ savings_amount: 2.27 }, 2.27), /^Value pack — \$2\.27 less than buying the singles$/, 'no count ⇒ no invented number');
});

test('56: the swap takes ONE single off a line that grew, never the whole line', async () => {
    const ops = [];
    const self = {
        items: [{ key: 'k1', quantity: 3 }],
        addItem: async (p) => ops.push(['add', p.quantity]),
        updateQuantity: async (k, q) => ops.push(['qty', k, q]),
        removeItem: async (k) => ops.push(['remove', k]),
        cartItemKey: (i) => i.key,
    };
    const API = { getProduct: async () => ({ ok: true, data: { id: 'pack', name: 'Pack', retail_price: 31.99 } }) };
    const swap = cartMethod('_swapLineForPack', self, { API, showToast() {} });
    await swap('k1', 'BLC233VP');
    assert.deepEqual(ops, [['add', 1], ['qty', 'k1', 2]], 'one pack in, ONE single out — 2 singles stay');
    self.items = [{ key: 'k2', quantity: 1 }];
    ops.length = 0;
    await swap('k2', 'BLC233VP');
    assert.deepEqual(ops, [['add', 1], ['remove', 'k2']]);
});

test('58: the subtotal label is written whole — "1 item", "2 items"', () => {
    const label = cartMethod('_itemsLabel', {});
    assert.equal(label(1), '1 item');
    assert.equal(label(2), '2 items');
    assert.equal(label(0), '0 items');
    const src = stripComments(read('js/cart.js'));
    assert.equal((src.match(/itemCountEl\.textContent = this\._itemsLabel\(itemCount\)/g) || []).length, 2, 'both writers');
    assert.match(read('html/cart.html'), /Subtotal \(<span id="cart-item-count">0 items<\/span>\)/);
});

// ─── 57 + /cart/ routes ─────────────────────────────────────────────────────

test('57 + 58: www routes — PayPal return/cancel land on /checkout, /cart/ redirects to /cart', () => {
    const v = JSON.parse(read('vercel.json')).redirects;
    const find = (src) => v.find((r) => r.source === src);
    assert.deepEqual(plain(find('/checkout/paypal-return')), { source: '/checkout/paypal-return', destination: '/checkout?paypal=return', permanent: false });
    assert.deepEqual(plain(find('/checkout/paypal-cancel')), { source: '/checkout/paypal-cancel', destination: '/checkout?paypal=cancelled', permanent: false });
    assert.equal(find('/cart/').destination, '/cart');
    const s = JSON.parse(read('serve.json')).redirects;
    assert.ok(s.some((r) => r.source === 'checkout/paypal-return' && r.destination === '/checkout?paypal=return'), 'local dev mirror (ERR-092)');
    assert.ok(s.some((r) => r.source === 'checkout/paypal-cancel'));
});

test('57: a redirect return captures ONLY the order this tab created, matched by PayPal’s token', async () => {
    const { P, store, ctx } = loadPay();
    let captured = null;
    ctx.API.capturePaypal = async (n, t) => { captured = [n, t]; return { ok: true, data: { status: 'paid' } }; };
    ctx.API.clearCart = async () => ({ ok: true });

    let out = await P.resumePayPalReturn('PP-1');
    assert.equal(out.status, 'refused', 'nothing remembered ⇒ never guess');
    assert.match(out.text, /do not pay again/);
    assert.equal(captured, null);

    P._rememberPayPalOrder('2026102801', 'PP-1');
    assert.equal(JSON.parse(store.paypalPending).order_number, '2026102801');
    out = await P.resumePayPalReturn('PP-OTHER');
    assert.equal(out.status, 'refused', 'a token for another PayPal order is not ours');

    out = await P.resumePayPalReturn('PP-1');
    assert.equal(out.status, 'navigated');
    assert.deepEqual(captured, ['2026102801', 'PP-1']);
    assert.equal(ctx.window.location.href, '/order-confirmation?order=2026102801');
    assert.equal(store.paypalPending, undefined, 'cleared after capture');
});

test('57: the popup path and the redirect path share one finish; createOrder remembers the order', () => {
    const approve = PAY_CODE.slice(PAY_CODE.indexOf('onApprove: async'), PAY_CODE.indexOf('onCancel:'));
    assert.match(approve, /await self\._finishPayPalPaid\(orderNumber\);/);
    assert.equal((PAY_CODE.match(/self\._rememberPayPalOrder\(/g) || []).length, 3, 'replay, retry and fresh order');
    const co = stripComments(read('js/checkout-page.js'));
    assert.match(co, /mode === 'cancelled'/);
    assert.match(co, /window\.history\.replaceState\(null, '', '\/checkout'\)/, 'a reload cannot capture twice');
});

// ─── 49 (admin) ─────────────────────────────────────────────────────────────

function loadQuote() {
    const src = read('js/admin/utils/invoice-quote.js');
    const exposed = new Set();
    const stripped = src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        .replace(/export\s+(async\s+)?(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, a, kw, id) => { exposed.add(id); return `${a || ''}${kw} ${id}`; });
    const sb = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Date, RegExp };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(stripped + '\n;' + [...exposed].map((id) => `try{globalThis.${id}=${id}}catch(_){}`).join('\n'), sb);
    return sb;
}

test('49: every quoted line sends cost_source, and the cost the save records', () => {
    const Q = loadQuote();
    const { body } = Q.quoteRequestBody({ lines: [
        { code: 'A', qty: 1, unitCost: 10, priceSource: Q.PRICE_MANUAL, supplierCost: '0', costSource: 'manual' },
        { code: 'B', qty: 1, unitCost: 0, supplierCost: 7.5, costSource: 'auto' },
        { code: 'C', qty: 1, unitCost: 0, supplierCost: '', costSource: 'manual' },
        { code: 'D', qty: 1, unitCost: 0, supplierCost: null, costSource: 'auto' },
    ] });
    const li = plain(body.line_items);
    assert.equal(li[0].supplier_cost_excl_gst, 0, 'a typed $0 counts (warranty / exchange stock)');
    assert.equal(li[0].unit_cost_excl_gst, 10);
    assert.equal(li[1].supplier_cost_excl_gst, 7.5);
    assert.ok(!('supplier_cost_excl_gst' in li[2]), "a blank box is unknown — never Number('') = 0");
    assert.equal(li[2].cost_source, 'manual', 'manual + no cost tells the backend the cost is UNKNOWN');
    assert.ok(!('supplier_cost_excl_gst' in li[3]));
    assert.deepEqual(li.map((l) => l.cost_source), ['manual', 'auto', 'manual', 'auto']);
});

test('49: normalizeQuote keeps gross_margin_pct and below_web_price, null stays null', () => {
    const Q = loadQuote();
    const q = Q.normalizeQuote({ data: { lines: [
        { position: 0, gross_margin_pct: 12.5, below_web_price: true },
        { position: 1, gross_margin_pct: null, below_web_price: null },
        { position: 2, gross_margin_pct: '0', below_web_price: false },
    ] } });
    assert.deepEqual(plain(q.lines.map((l) => [l.grossMarginPct, l.belowWebPrice])), [[12.5, true], [null, null], [0, false]]);
});

test('49: warning chips — both, one, none; the level is ONE named constant', () => {
    const Q = loadQuote();
    assert.equal(Q.THIN_MARGIN_PCT, 20);
    const both = Q.quoteWarningChips({ belowWebPrice: true, grossMarginPct: 12.5 });
    assert.equal(both.length, 2);
    assert.match(both[0], />Below web price</);
    assert.match(both[1], />Margin 12\.5%</);
    assert.equal(Q.quoteWarningChips({ belowWebPrice: false, grossMarginPct: 20 }).length, 0, '20% is not under 20');
    assert.equal(Q.quoteWarningChips({ belowWebPrice: null, grossMarginPct: null }).length, 0, 'unknown shows nothing');
    assert.deepEqual(plain(Q.quoteWarningChips(null)), []);
});

test('49: both editors show the chips owner-only, re-quote on a cost edit, and never gate the save', () => {
    for (const [file, price] of [['js/admin/pages/invoices.js', 'unitCost'], ['js/admin/pages/quick-order.js', 'unitPrice']]) {
        const src = stripComments(read(file));
        assert.match(src, /if \(canSeeCost\(\)\) bits\.push\(\.\.\.quoteWarningChips\(ql\)\);/, file);
        assert.ok(src.includes(`if (f === 'code' || f === 'qty' || f === '${price}' || f === 'supplierCost') scheduleQuote();`), file);
        assert.doesNotMatch(src, /belowWebPrice|grossMarginPct/, `${file}: only the chip helper reads them — nothing else can block a save`);
    }
});
