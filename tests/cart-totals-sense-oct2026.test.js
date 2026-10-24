/**
 * Cart and checkout totals that make sense (ERR-316 phase 5 + ERR-320, owner
 * 2026-10-13: "check … the total price and shipping all make sense and are
 * correct").
 *
 *  - ERR-320: /checkout stored the server's AGGREGATE `summary.discount`
 *    (coupon + loyalty + volume) as the coupon discount after a coupon
 *    re-read, then subtracted loyalty and volume again — the panel total
 *    fell below what Stripe charges. The coupon part is now the shared
 *    computeDiscountBreakdown split.
 *  - The cart's local fallback said "You've qualified for FREE shipping!"
 *    from a hardcoded $100 while the row above read "Calculated at checkout"
 *    under "Total before shipping" (no server pricing). It never says it now.
 *  - The cart line: the unit price moved under the name so the name, the
 *    value-pack pill and the volume nudge stop wrapping at a third of the row.
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
const CART = read('js/cart.js');
const CHECKOUT = read('js/checkout-page.js');

function method(src, name) {
    const i = src.indexOf(`\n        ${name}(`);
    assert.ok(i > 0, `${name} found`);
    const open = src.indexOf('{', i);
    let d = 0, k = open;
    for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; }
    return src.slice(i, k + 1).trim();
}

test('ERR-320: the coupon part of a summary excludes loyalty and volume — they are subtracted once, on their own rows', () => {
    // computeDiscountBreakdown is a top-level function in cart.js: run it.
    const fnStart = CART.indexOf('function computeDiscountBreakdown(');
    let d = 0, k = CART.indexOf('{', fnStart);
    for (; k < CART.length; k++) { if (CART[k] === '{') d++; else if (CART[k] === '}' && --d === 0) break; }
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(CART.slice(fnStart, k + 1) + '\n;globalThis.cdb = computeDiscountBreakdown;', ctx);
    const self = {};
    const body = method(CHECKOUT, '_couponPart').replace(/^_couponPart\(summary, data\)/, 'function (summary, data)');
    const couponPart = vm.runInContext(`(${body})`, Object.assign(ctx, { computeDiscountBreakdown: ctx.cdb })).bind(self);

    const summary = { subtotal: 200, discount: 18, loyalty_discount_amount: 5, volume_discount: { discount_amount: 3 } };
    assert.equal(couponPart(summary, {}), 10, 'aggregate 18 − loyalty 5 − volume 3 = the coupon 10');
    assert.equal(couponPart({ discount: 6 }, {}), 6, 'a coupon-only cart keeps its whole discount');
    assert.equal(couponPart(null, {}), 0);
});

test('ERR-320: no coupon path stores the aggregate summary.discount as the coupon discount', () => {
    const code = stripComments(CHECKOUT);
    assert.doesNotMatch(code, /this\.totals\.discount = summary\.discount;/);
    assert.doesNotMatch(code, /\? summary\.discount : 0;/);
    assert.doesNotMatch(code, /: \(summary\.discount \|\| 0\)\)/);
    assert.doesNotMatch(code, /coupon\.discount_amount \|\| summary\?\.discount \|\| 0/);
    assert.equal((code.match(/this\._couponPart\(|self\._couponPart\(/g) || []).length, 4, 'all four coupon re-reads use the split');
});

test('the cart never prints a local "you qualify for free shipping" — only the server can make that promise', () => {
    const code = stripComments(CART);
    assert.doesNotMatch(code, /You've qualified for FREE shipping!/);
    assert.match(code, /if \(spendMore && spendMore\.qualifies\) \{\s*shippingMsgEl\.hidden = true;/);
    // ERR-371 (item 23b, owner 2026-10-24): the server's message shows in BOTH
    // states, verbatim — "you qualify" is the SERVER's words, never ours — and
    // the only locally composed copy is the "Add $X more" nudge, never a qualify.
    assert.match(code, /let copy = summary\.free_shipping_message \|\| '';/);
    assert.match(code, /if \(!copy && !summary\.qualifies_for_free_shipping/);
});

test('cart line: unit price moves under the name on desktop; pill and nudge span the full line', () => {
    const css = read('css/cart-checkout.css');
    const block = css.slice(css.indexOf('/* ── Cart line: name, value-pack pill and volume nudge on ONE line'));
    assert.match(block, /@media \(min-width: 769px\)/);
    assert.match(block, /grid-template-columns: 80px minmax\(0, 1fr\) auto auto auto;/);
    assert.match(block, /section\.cart-page \.cart-item__details \{ display: contents; \}/);
    assert.match(block, /:is\(\.cart-line-pack, \.cart-item__volume-nudge\) \{\s*grid-column: 2 \/ -1;/);
    assert.match(block, /section\.cart-page \.cart-item__price \{ display: none; \}/);
    assert.match(block, /section\.cart-page \.cart-item__price-mobile \{\s*display: block;/);
    // The same figure on both cells (ERR-307): markup still renders both.
    assert.match(CART, /cart-item__price-mobile/);
});

test('coupon codes and loyalty points are entered at checkout only; the cart keeps the totals rows and the chip (ERR-316 phase 6)', () => {
    const cart = read('html/cart.html');
    assert.doesNotMatch(cart, /id="cart-discount"|id="cart-coupon-form"|id="cart-coupon-input"|id="cart-loyalty-form"/);
    for (const id of ['cart-savings-row', 'cart-loyalty-row', 'cart-b2b-row', 'cart-coupon-note', 'cart-loyalty-chip']) {
        assert.match(cart, new RegExp(`id="${id}"`), `${id} still reports what was applied`);
    }
    const checkout = read('html/checkout.html');
    assert.match(checkout, /id="coupon-code"/);
    assert.match(checkout, /id="cart-loyalty-form"/);
    // A failed ?coupon= recovery link says where to retry, since the field moved.
    assert.match(stripComments(read('js/cart-page.js')), /if \(!det && !input\) \{\s*if \(typeof showToast === 'function'\) showToast\('You can enter ' \+ code \+ ' at checkout\.'/);
});

test('cart summary starts level with the "Cart" title on desktop (ERR-342: summary from row 2, guarantees in row 1)', () => {
    const css = read('css/cart-checkout.css');
    const block = css.slice(css.indexOf('/* ── No dead band beside "Cart"'));
    assert.match(block, /@media \(min-width: 1025px\)/);
    assert.match(block, /grid-template-rows: auto 1fr;/);
    assert.match(block, /section\.cart-page #cart-layout:not\(\[hidden\]\) \{ display: contents; \}/);
    assert.match(block, /\.cart-summary \{ grid-column: 2; grid-row: 2; \}/);
});
