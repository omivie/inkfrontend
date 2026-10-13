/**
 * Cart drawer (ERR-316): the slide-in cart that opens after Add to Cart.
 *
 * Behavioural where it matters, run against js/cart-drawer.js in a VM with a
 * hand-rolled Cart and DOM:
 *   - a non-silent `cart:item-added` opens it; a silent one (the ?add= deep
 *     link's twelve adds) never does;
 *   - it is not even listening on /cart, /checkout or /payment;
 *   - the subtotal is the SERVER's figure, "Updating…" while a change is in
 *     flight, and WORDS (never a sum of the lines) with no server summary;
 *   - an upsell with no buyable rows hides the section;
 *   - Escape closes it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'cart-drawer.js'), 'utf8');
const CART_SRC = fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'cart.js'), 'utf8');

function load({ pathname = '/products/x/Y', cart = {} } = {}) {
    const listeners = {};
    const document = {
        readyState: 'complete',
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        documentElement: { classList: { add() {}, remove() {} } },
    };
    const Cart = Object.assign({
        items: [],
        serverSummary: null,
        getItemCount() { return this.items.reduce((n, i) => n + i.quantity, 0); },
        hasServerPricing() { return !!(this.serverSummary && this.serverSummary.subtotal !== undefined); },
        _summaryPending() { return false; },
    }, cart);
    const ctx = {
        window: { location: { pathname } },
        document,
        Cart,
        Security: { escapeHtml: String, escapeAttr: String },
        formatPrice: (n) => '$' + Number(n).toFixed(2),
        getStockStatus: (p) => ({ class: p.contact ? 'contact-us' : 'in-stock' }),
        requestAnimationFrame: (fn) => fn(),
        setTimeout,
        module: { exports: {} },
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return { Drawer: ctx.module.exports, listeners, Cart };
}

function fire(listeners, detail) {
    for (const fn of listeners['cart:item-added'] || []) fn({ detail });
}

test('a non-silent add opens the drawer; a silent add never does', () => {
    const { Drawer, listeners } = load();
    let opened = 0;
    Drawer.open = () => { opened++; };
    Drawer._loadUpsell = () => {};
    fire(listeners, { sku: 'A', silent: true });
    assert.equal(opened, 0, 'the deep link adds silently and must not open a drawer twelve times');
    fire(listeners, { sku: 'A', silent: false });
    assert.equal(opened, 1);
});

test('not listening on the pages that already show the cart', () => {
    for (const p of ['/cart', '/checkout', '/payment', '/html/cart.html']) {
        const { listeners } = load({ pathname: p });
        assert.equal((listeners['cart:item-added'] || []).length, 0, `${p} must keep its own surface`);
    }
    assert.equal((load({ pathname: '/cartridges/brother' }).listeners['cart:item-added'] || []).length, 1,
        'a path that merely starts with "cart" is not the cart page');
});

test('subtotal: the server figure, "Updating…" in flight, words with no summary — never a sum', () => {
    const items = [{ key: 'a', quantity: 2, price: 10 }, { key: 'b', quantity: 1, price: 5 }];

    let { Drawer } = load({ cart: { items, serverSummary: { subtotal: 23.45, discount: 1.5 } } });
    let html = Drawer._totalsHtml(items);
    assert.match(html, /data-pricing="server"/);
    assert.match(html, /\$23\.45/, 'the server subtotal, not 2×10+5');
    assert.match(html, /Subtotal \(3 items\)/);
    assert.match(html, /Discount<\/dt><dd>&minus;\$1\.50/);

    ({ Drawer } = load({ cart: { items, serverSummary: { subtotal: 23.45 }, _summaryPending: () => true } }));
    html = Drawer._totalsHtml(items);
    assert.match(html, /data-pricing="pending"/);
    assert.match(html, /Updating…/);
    assert.doesNotMatch(html, /\$23\.45/, 'the old quantity\'s figure must not sit beside the new quantity');

    ({ Drawer } = load({ cart: { items, serverSummary: null } }));
    html = Drawer._totalsHtml(items);
    assert.match(html, /data-pricing="unpriced"/);
    assert.doesNotMatch(html, /\$25\.00/, 'no server summary ⇒ no locally added-up total');
    assert.match(html, /could not confirm prices/, 'and the shopper is told so');
});

test('the drawer source does no price arithmetic', () => {
    const code = stripComments(SRC);
    assert.doesNotMatch(code, /\.price\s*\*|\*\s*\w+\.quantity|reduce\([^)]*price/,
        'line and cart figures come from Cart.lineTotalHtml and the server summary only');
    assert.match(code, /Cart\.lineTotalHtml\(item\)/);
});

test('an upsell with no buyable rows hides the section', () => {
    const { Drawer } = load({ cart: { items: [{ sku: 'IN-CART', quantity: 1 }] } });
    const list = { innerHTML: 'x' };
    const section = { hidden: false, querySelector: () => list };
    Drawer.root = { querySelector: (sel) => (sel === '#cart-drawer-upsell' ? section : null) };

    Drawer._upsell = [];
    Drawer._renderUpsell();
    assert.equal(section.hidden, true, 'no rows ⇒ hidden');

    Drawer._upsell = [{ sku: 'IN-CART', retail_price: 9 }, { sku: 'C', retail_price: 9, contact: true }, { sku: 'NOPRICE' }];
    Drawer._renderUpsell();
    assert.equal(section.hidden, true, 'already in cart, contact-us and unpriced rows are not upsells');

    Drawer._upsell = [{ sku: 'OK', retail_price: 12.5, id: 'p1', name: 'Fine' }];
    Drawer._renderUpsell();
    assert.equal(section.hidden, false);
    assert.match(list.innerHTML, /add-to-cart-btn/, 'the add goes through Cart.bindEvents\' delegate');
    assert.match(list.innerHTML, /\$12\.50/);
});

test('Escape closes the drawer', () => {
    const { Drawer } = load();
    let closed = 0;
    Drawer.close = () => { closed++; };
    let prevented = false;
    Drawer._onKey({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(closed, 1);
    assert.equal(prevented, true);
});

test('cart.js: the toast yields to the drawer, the event carries the cross-sell hint, both repaint hooks exist', () => {
    const code = stripComments(CART_SRC);
    assert.match(code, /!product\.silent && !this\.drawerHandlesAdds\(\)/);
    assert.match(code, /crossSell: crossSellPayload \|\| null/);
    assert.equal((code.match(/if \(typeof CartDrawer !== 'undefined'\) CartDrawer\.refresh\(\);/g) || []).length, 2,
        'updateUI and _updateCartSummaryDOM (the debounced qty path) both repaint the drawer');
});

test('every page that loads cart.js loads the drawer right after it', () => {
    const root = path.join(__dirname, '..', 'inkcartridges');
    const pages = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) { if (!['node_modules', 'scripts', '.vercel'].includes(e.name)) walk(path.join(dir, e.name)); }
            else if (e.name.endsWith('.html')) pages.push(path.join(dir, e.name));
        }
    })(root);
    const missing = [];
    for (const f of pages) {
        const html = fs.readFileSync(f, 'utf8');
        const c = html.indexOf('/js/cart.js?v=');
        if (c < 0) continue;
        const d = html.indexOf('/js/cart-drawer.js?v=');
        if (d < c) missing.push(path.relative(root, f));
    }
    assert.deepEqual(missing, []);
});

test('loyalty chip at the top of the drawer: same writer as the cart page, hidden with an empty cart (ERR-333)', () => {
    const code = stripComments(SRC);
    const chipAt = code.indexOf('id="cart-drawer-loyalty"');
    assert.ok(chipAt > 0 && chipAt < code.indexOf('cart-drawer__body'), 'the chip sits above the lines, not in the footer');
    assert.match(code, /class="cart-summary__loyalty-chip cart-drawer__loyalty"/, 'the cart page\'s green chip look');

    const el = (extra = {}) => Object.assign({ hidden: false, innerHTML: '' }, extra);
    const nodes = { '#cart-drawer-lines': el(), '#cart-drawer-totals': el(), '.cart-drawer__foot': el(), '#cart-drawer-loyalty': el() };
    const filled = [];
    const { Drawer, Cart } = load({ cart: { items: [{ key: 'a', quantity: 1 }], lineTotalHtml: () => '', getItemImageHTML: () => '',
        maxQuantityFor: () => 9, _fillLoyaltyChip: (c) => filled.push(c) } });
    Drawer.root = { hidden: false, querySelector: (sel) => nodes[sel] };
    Drawer._renderUpsell = () => {};
    Drawer.isOpen = () => true;
    Drawer.refresh();
    assert.deepEqual(filled, [nodes['#cart-drawer-loyalty']], 'Cart._fillLoyaltyChip writes it — no second copy of the message logic');

    Cart.items = [];
    Drawer.refresh();
    assert.equal(nodes['#cart-drawer-loyalty'].hidden, true, 'empty cart ⇒ no chip');
    assert.equal(filled.length, 1);
});
