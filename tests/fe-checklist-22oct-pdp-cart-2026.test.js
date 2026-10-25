/**
 * FE checklist 2026-10-22 — PDP / cart / checkout (ERR-371)
 * =============================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md (22 Oct version).
 *
 *   §16  "Up to 550" from compatible_alternatives[].page_yield → "Up to 550 pages".
 *   §26a "3+ $66.14 each · See all prices" from the ladder's first rung, in the
 *        Availability row (the price row has no room at 1280–1366: it wrapped
 *        and pushed Add down 26px — measured).
 *   §27b a compatible PDP prints warranty.compatible_label under the fit line.
 *   §23a the cart is line items first on one column (no summary order:-1).
 *   §23b the free-shipping line + bar sit between Shipping and the total; the
 *        tick only when the cart qualifies; the server's words in both states.
 *   §23c the drawer shows summary.free_shipping_message while remaining > 0
 *        (+ the unlock tiles from the cart page's own builder), nothing at 0.
 *   §29  where the drawer does not run, the add toast carries the next step and
 *        one free-shipping line.
 *   §28  the checkout summary ships collapsed (no fold-after-paint on phones).
 *   §30  the checkout reassurance list comes from the cart response / trust API;
 *        the guarantee only when the cart holds a compatible product.
 *   §31  phone tap areas; the pay line's number from /api/site/trust contact.
 *   +    Pay focuses the field that blocks it.
 *
 * Run: node --test tests/fe-checklist-22oct-pdp-cart-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

/** `name(...) {` or `name: function(...) {` from object-literal source. */
function methodSrc(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0; let q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = methodSrc(stripComments(read(file)), name);
    const keys = Object.keys(globals);
    return new Function(...keys, `return (${async ? 'async ' : ''}function (${params}) ${body});`)(...keys.map((k) => globals[k])).bind(self);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const Security = { escapeHtml: esc, escapeAttr: esc };
const formatPrice = (n) => '$' + Number(n).toFixed(2);

// ═══ §16 ════════════════════════════════════════════════════════════════════

test('§16 "Up to 550" reads "Up to 550 pages"; other free text is still refused', () => {
    const f = method('js/product-detail-page.js', 'pageYieldText');
    assert.equal(f('Up to 550'), 'Up to 550 pages');
    assert.equal(f('up to 1,200'), 'Up to 1,200 pages');
    assert.equal(f('1,000'), '1,000 pages');
    assert.equal(f(2500), '2,500 pages');
    assert.equal(f('approx 1000'), '');
    assert.equal(f('Up to 0'), '');
    assert.equal(f('Up to many'), '');
    assert.equal(f(null), '');
});

// ═══ §27b ═══════════════════════════════════════════════════════════════════

function promiseDom() {
    const el = { innerHTML: '', hidden: true };
    return { el, document: { getElementById: (id) => (id === 'product-promise' ? el : null) } };
}
const { CompatGuarantee } = require('../inkcartridges/js/utils.js');
const LABEL = 'Compatible cartridges are covered by our 30-day satisfaction guarantee.';
const TS = { compatibility_promise: { label: 'Not sure it fits? <b>Ask</b>' }, warranty: { compatible_label: LABEL } };

test('§27b a compatible PDP prints the guarantee directly under the fit line, escaped', () => {
    const { el, document } = promiseDom();
    method('js/product-detail-page.js', 'renderPromise', {}, { document, Security, CompatGuarantee, TrustStats: undefined })({ source: 'compatible', trust_signals: TS });
    const fit = el.innerHTML.indexOf('product-promise__label');
    const g = el.innerHTML.indexOf('product-promise__guarantee');
    assert.ok(fit >= 0 && g > fit, 'fit line, then the guarantee');
    assert.ok(el.innerHTML.includes(LABEL));
    assert.ok(el.innerHTML.includes('&lt;b&gt;Ask&lt;/b&gt;'), 'escaped');
});

test('§27b a genuine PDP (and a roll, source null) never gets it here', () => {
    for (const source of ['genuine', null]) {
        const { el, document } = promiseDom();
        method('js/product-detail-page.js', 'renderPromise', {}, { document, Security, CompatGuarantee, TrustStats: undefined })({ source, trust_signals: TS });
        assert.ok(!el.innerHTML.includes('product-promise__guarantee'), String(source));
    }
});

// ═══ §26a ═══════════════════════════════════════════════════════════════════

function stockDom() {
    const children = [];
    const stock = {
        children,
        appendChild(c) { c.parentElement = stock; children.push(c); return c; },
    };
    const byId = { 'product-stock': stock };
    const document = {
        getElementById: (id) => byId[id] || children.find((c) => c.id === id) || null,
        createElement: () => ({ dataset: {}, innerHTML: '', parentElement: null, remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); this.parentElement = null; } }),
    };
    return { stock, children, document };
}
const Business = { breakLabel: (r) => `${r.minQuantity}+` };

test('§26a the first rung prints in the Availability row, from the server\'s figures', () => {
    const { children, document } = stockDom();
    const sync = method('js/product-detail-page.js', 'syncBreakLine', {}, { document, Security, Business, formatPrice });
    sync({ entry: { minQuantity: 3, businessPrice: 66.14 } });
    assert.equal(children.length, 1);
    assert.equal(children[0].id, 'product-break-line');
    assert.equal(children[0].innerHTML, '3+ $66.14 each · <a class="product-info__break-link" href="#volume-pricing">See all prices</a>');
    sync({ entry: { minQuantity: 4, businessPrice: 23.51 } });
    assert.equal(children.length, 1, 'idempotent: updated, not duplicated');
    assert.match(children[0].innerHTML, /^4\+ \$23\.51 each/);
    sync(null);
    assert.equal(children.length, 0, 'no ladder ⇒ no line');
    sync({ entry: { minQuantity: 3, businessPrice: NaN } });
    assert.equal(children.length, 0, 'an unreadable rung is not printed');
});

test('§26a the line is wired into the ladder render and never says "on all orders"', () => {
    const pdp = stripComments(read('js/product-detail-page.js'));
    assert.match(pdp, /if \(!ladder\) \{ this\.syncBreakLine\(null\); return; \}\s*this\._volumeLadder = ladder;\s*this\.syncBreakLine\(ladder\);/);
    assert.doesNotMatch(pdp, /on all orders/i);
    assert.doesNotMatch(read('html/product/index.html'), /id="product-break-line"/, 'built in the Availability row, not the full price row');
});

// ═══ §23a / §23b ════════════════════════════════════════════════════════════

test('§23a one column = DOM order on /cart: no summary/assurance/skeleton order:-1', () => {
    const layout = stripComments(read('css/layout.css'));
    assert.doesNotMatch(layout, /\.cart-summary \{\s*order: -1;/);
    assert.doesNotMatch(layout, /\.cart-summary\s*\{\s*order:\s*-1/);
    assert.match(layout, /\.checkout-summary \{\s*order: -1;\s*\}/, 'checkout keeps its summary first (out of scope)');
    assert.doesNotMatch(stripComments(read('css/cart-checkout.css')), /\.cart-assurance \{ order: -1; \}/);
    assert.doesNotMatch(stripComments(read('css/pages.css')), /\.cart-loading__summary \{\s*order: -1;/);
    const cart = read('html/cart.html');
    assert.ok(cart.indexOf('id="cart-items"') < cart.indexOf('<aside class="cart-summary">'), 'items come first in the DOM');
});

test('§23b free-shipping line + bar between Shipping and the total; tick only when qualified', () => {
    const cart = read('html/cart.html');
    const order = ['id="cart-shipping"', 'id="cart-shipping-message"', 'id="cart-shipping-bar"', 'id="cart-total-row"', 'id="checkout-btn"']
        .map((k) => cart.indexOf(k));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'Shipping, message, bar, total, button');
    assert.match(cart, /<svg class="cart-summary__shipping-tick"/);
    assert.match(stripComments(read('css/pages.css')), /\.cart-summary__shipping-message:not\(\.cart-summary__shipping-message--success\) \.cart-summary__shipping-tick \{ display: none; \}/);
    // The tick class is set ONLY from the server's qualifies flag.
    assert.match(stripComments(read('js/cart.js')), /\+ \(summary\.qualifies_for_free_shipping \? ' cart-summary__shipping-message--success' : ''\);/);
    // A quiet row, not the 57px banner it was standalone (/cart loads cart-checkout.css, not checkout-compact.css).
    assert.match(read('html/cart.html'), /\/css\/cart-checkout\.css\?v=/);
    assert.match(stripComments(read('css/cart-checkout.css')), /\.cart-summary__totals \.cart-summary__shipping-message \{\s*margin: 0;/);
});

// ═══ §23c drawer ════════════════════════════════════════════════════════════

function drawerFreeShip(cartState) {
    const Cart = Object.assign({
        _summaryPending: () => false,
        hasServerPricing: () => true,
        serverSummary: {},
        serverCartMeta: {},
        freeShipChipsHtml: (rows, loc) => rows.map((r) => `<a data-loc="${loc}">${r.sku}</a>`).join(''),
    }, cartState);
    return method('js/cart-drawer.js', '_freeShipHtml', {}, { Cart, Security })();
}

test('§23c the drawer shows the server\'s message while remaining > 0, verbatim', () => {
    const html = drawerFreeShip({ serverSummary: { free_shipping_message: 'Add $55.51 more to qualify for free shipping.', free_shipping_remaining: 55.51 } });
    assert.equal(html, '<p class="cart-drawer__freeship-msg">Add $55.51 more to qualify for free shipping.</p>');
});

test('§23c nothing at 0, nothing while a change is in flight, nothing without server pricing', () => {
    assert.equal(drawerFreeShip({ serverSummary: { free_shipping_message: 'x', free_shipping_remaining: 0 } }), '');
    assert.equal(drawerFreeShip({ _summaryPending: () => true, serverSummary: { free_shipping_message: 'x', free_shipping_remaining: 5 } }), '');
    assert.equal(drawerFreeShip({ hasServerPricing: () => false, serverSummary: { free_shipping_message: 'x', free_shipping_remaining: 5 } }), '');
    assert.equal(drawerFreeShip({ serverSummary: { free_shipping_remaining: 5 } }), '', 'never a gap composed here');
});

test('§23c unlock tiles go under the line, from the cart page\'s own builder', () => {
    const html = drawerFreeShip({
        serverSummary: { free_shipping_message: 'Add $12.00 more', free_shipping_remaining: 12 },
        serverCartMeta: { free_shipping_unlock: { qualifies: false, suggested_products: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }, { sku: 'D' }] } },
    });
    assert.match(html, /<div class="cart-addon-row cart-drawer__freeship-tiles"><a data-loc="drawer">A<\/a><a data-loc="drawer">B<\/a><a data-loc="drawer">C<\/a><\/div>$/);
    const cart = stripComments(read('js/cart.js'));
    assert.match(cart, /const chips = this\.freeShipChipsHtml\(suggestions, 'cart'\);/, 'the cart page uses the same builder');
    const drawer = stripComments(read('js/cart-drawer.js'));
    assert.match(drawer, /const freeship = this\.root\.querySelector\('#cart-drawer-freeship'\);\s*if \(freeship\) \{/, 'null-tolerant (the ERR-333 test fakes querySelector)');
});

// ═══ §29 toast ══════════════════════════════════════════════════════════════

function toastFor(pathname, summary) {
    let last = null;
    const made = [];
    const toast = {
        children: [],
        querySelector: (sel) => (sel === '.toast__message' ? { parentNode: { insertBefore: (n) => made.push(n) } } : null),
        appendChild: (n) => made.push(n),
    };
    const showToast = (msg, type, ms) => { last = { msg, type, ms }; return toast; };
    const document = { createElement: () => ({ className: '', innerHTML: '' }) };
    method('js/cart.js', '_addedToast', { serverSummary: summary }, { showToast, document, Security, window: { location: { pathname } } })({ name: 'CLC233BK' });
    return { last, html: made[0] && made[0].innerHTML };
}

test('§29 /cart: Checkout + the server\'s free-shipping line, 6 seconds', () => {
    const { last, html } = toastFor('/cart', { free_shipping_message: 'Add $91.01 more to qualify for free shipping.' });
    assert.equal(last.ms, 6000);
    assert.equal(last.msg, 'CLC233BK added to cart');
    assert.match(html, /<p class="toast__ship">Add \$91\.01 more to qualify for free shipping\.<\/p>/);
    assert.match(html, /<a class="toast__action" href="\/checkout">Checkout<\/a>/);
    assert.doesNotMatch(html, /href="\/cart"/);
});

test('§29 /checkout: View cart; a qualifying cart says "Free shipping unlocked"', () => {
    const { html } = toastFor('/checkout', { qualifies_for_free_shipping: true, free_shipping_message: 'ignored' });
    assert.match(html, /<p class="toast__ship">Free shipping unlocked<\/p>/);
    assert.match(html, /<a class="toast__action" href="\/cart">View cart<\/a>/);
});

test('§29 the decorated toast replaces the plain one only where the drawer does not run', () => {
    const cart = stripComments(read('js/cart.js'));
    assert.match(cart, /if \(typeof showToast === 'function' && !product\.silent && !this\.drawerHandlesAdds\(\)\) \{\s*this\._addedToast\(product\);/);
    assert.match(stripComments(read('css/components.css')), /\.toast:has\(\.toast__next\) \{ flex-wrap: wrap; \}/, 'toast CSS stays in components.css (ERR-321)');
});

// ═══ §28 / §30 checkout ═════════════════════════════════════════════════════

test('§28 the checkout summary ships collapsed (the collapse rule is phone-only)', () => {
    const html = read('html/checkout.html');
    assert.match(html, /<aside class="checkout-summary is-collapsed">/);
    assert.match(html, /id="checkout-summary-toggle"\s*aria-expanded="false"/);
});

function reassure({ meta = {}, site = {}, items = [] }) {
    const els = { 'checkout-reassure': { innerHTML: '', hidden: true, dataset: {} }, 'checkout-reassure-pay': { innerHTML: '', hidden: true, dataset: {} } };
    const run = method('js/checkout-page.js', 'renderReassurance', { cartItems: items }, {
        document: { getElementById: (id) => els[id] || null },
        Cart: { serverCartMeta: meta },
        TrustStats: { raw: async () => site },
        BrandSource: { isCompatible: (it) => it.source === 'compatible' },
        Security,
    });
    return run().then(() => els);
}
const META = {
    delivery_estimate: { promise: 'Order by 12pm for same-day dispatch (Auckland metro) — 1–3 business days NZ-wide' },
    trust_signals: { returns: { label: '30-day returns' }, guarantee: { label: '30-day satisfaction guarantee' }, tax_invoice: { label: 'GST tax invoice emailed with every order' } },
};

test('§30 four facts from the cart response, in both places, escaped', async () => {
    const els = await reassure({ meta: META, items: [{ source: 'compatible' }] });
    for (const el of Object.values(els)) {
        assert.equal(el.hidden, false);
        assert.equal((el.innerHTML.match(/<li>/g) || []).length, 4);
        assert.equal(el.dataset.reassure, 'ok');
    }
    assert.match(els['checkout-reassure'].innerHTML, /^<li>Order by 12pm/);
});

test('§30 a genuine-only cart never shows the compatible guarantee', async () => {
    const els = await reassure({ meta: META, items: [{ source: 'genuine' }] });
    assert.doesNotMatch(els['checkout-reassure'].innerHTML, /satisfaction guarantee/);
    assert.equal((els['checkout-reassure'].innerHTML.match(/<li>/g) || []).length, 3);
    assert.equal(els['checkout-reassure'].dataset.reassure, 'ok');
});

test('§30 missing cart pieces come from /api/site/trust; nothing at all ⇒ hidden, said', async () => {
    const els = await reassure({ meta: { delivery_estimate: META.delivery_estimate }, site: META.trust_signals, items: [{ source: 'compatible' }] });
    assert.equal((els['checkout-reassure'].innerHTML.match(/<li>/g) || []).length, 4, 'trust API filled returns/guarantee/invoice');
    const none = await reassure({ meta: {}, site: {}, items: [] });
    assert.equal(none['checkout-reassure'].hidden, true);
    assert.equal(none['checkout-reassure'].dataset.reassure, 'absent');
});

test('§30 markup: under the total, and once under Pay (phones only)', () => {
    const html = read('html/checkout.html');
    assert.ok(html.indexOf('class="checkout-summary__tax"') < html.indexOf('id="checkout-reassure"'));
    assert.ok(html.indexOf('id="pay-now-btn"') < html.indexOf('id="checkout-reassure-pay"'));
    assert.match(stripComments(read('css/cart-checkout.css')), /@media \(min-width: 1025px\) \{\s*\.checkout-reassure--pay \{ display: none !important; \}/);
    assert.doesNotMatch(stripComments(read('js/checkout-page.js')), /30-day returns|GST tax invoice emailed/, 'never typed');
});

// ═══ §31 + blocking field ═══════════════════════════════════════════════════

test('§31 the pay line\'s number comes from /api/site/trust contact (literal only as fallback)', () => {
    const src = stripComments(read('js/payment-page.js'));
    assert.match(src, /contact\.phone_tel_href\.replace\(\/\[\^\+\\d\]\/g, ''\)/);
    assert.match(src, /href="tel:\$\{Security\.escapeAttr\(tel \|\| '\+64274740115'\)\}">\$\{Security\.escapeHtml\(shown \|\| '027 474 0115'\)\}<\/a>/);
});

test('§31 phone hit areas grow without moving the layout', () => {
    const pages = stripComments(read('css/pages.css'));
    const block = pages.slice(pages.lastIndexOf('@media (max-width: 768px) {\n    .product-info__badge-help,'));
    assert.match(block, /padding: 10px 0;\s*margin-top: -10px;\s*margin-bottom: -10px;/);
    const layout = stripComments(read('css/layout.css'));
    assert.match(layout, /\.value-strip__list \{ padding: 7px 0; \}\s*\.value-strip__item a \{ display: inline-block; padding: 7px 0; margin: -7px 0; \}/);
    assert.match(layout, /\.value-strip \{\s*min-height: 32px;/, 'the strip keeps its reserved height');
});

test('Pay focuses what blocks it: email, delivery type, verification', () => {
    const src = stripComments(read('js/checkout-page.js'));
    assert.match(src, /this\._showEmailError\(v\.message\);\s*field\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\);\s*if \(typeof field\.focus === 'function'\) field\.focus\(\{ preventScroll: true \}\);/);
    assert.match(src, /const first = deliverySection\.querySelector\('input\[name="delivery_type"\]'\);\s*if \(first\) first\.focus\(\{ preventScroll: true \}\);/);
    assert.doesNotMatch(src, /setTimeout\(\(\) => \{\s*deliverySection\.scrollIntoView/, 'no delayed scroll');
    assert.match(src, /this\.showVerificationRequired\(\);\s*const msg = document\.getElementById\('verification-required'\);\s*if \(msg\) msg\.scrollIntoView/);
});

test('cart sticky bar: the real button counts as visible only when fully above the consent bar', () => {
    const src = stripComments(read('js/cart-page.js'));
    assert.match(src, /const clear = entry\.isIntersecting && r\.top >= 0 && r\.bottom <= usable\(\);/);
    assert.match(src, /getPropertyValue\('--consent-banner-height'\)/);
    assert.doesNotMatch(src, /lastShouldShow = !entry\.isIntersecting;/, 'partly-on-screen-under-the-bar is not visible');
});
