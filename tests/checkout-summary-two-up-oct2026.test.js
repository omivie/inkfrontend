/**
 * ERR-346 — /checkout summary on desktop: cart items two-up (left, right, next
 * row) and the coupon beside the loyalty-points card (owner 2026-10-16).
 *
 * The layout lives in ONE ≥1000px block at the end of cart-checkout.css; the
 * phone summary (collapsible, <1000) keeps one column. The coupon/points pair
 * only sits side by side because both are children of `.checkout-summary__discounts`
 * — moving either out of the wrapper silently stacks them again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('inkcartridges/html/checkout.html');
const CSS = stripComments(read('inkcartridges/css/cart-checkout.css'));

test('coupon and #cart-loyalty are both inside .checkout-summary__discounts', () => {
    const open = HTML.indexOf('<div class="checkout-summary__discounts">');
    assert.ok(open > 0, 'wrapper missing');
    const coupon = HTML.indexOf('class="checkout-summary__coupon"');
    const loyalty = HTML.indexOf('id="cart-loyalty"');
    const totals = HTML.indexOf('class="checkout-summary__totals"');
    assert.ok(open < coupon && coupon < loyalty && loyalty < totals, 'order: wrapper > coupon > loyalty, before totals');
    // Wrapper closes after the loyalty card: count div balance from wrapper to totals.
    const slice = HTML.slice(open, HTML.lastIndexOf("<div", totals));
    const opens = (slice.match(/<div\b/g) || []).length;
    const closes = (slice.match(/<\/div>/g) || []).length;
    assert.equal(opens, closes, 'wrapper is closed before the totals block');
});

test('desktop block: items two columns, discounts flex row; phone untouched', () => {
    const at = CSS.lastIndexOf('@media (min-width: 1000px)');
    assert.ok(at > 0);
    const block = CSS.slice(at);
    assert.match(block, /\.checkout-summary__items\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(block, /\.checkout-summary__discounts\s*\{[^}]*display:\s*flex/);
    assert.match(block, /\.checkout-summary__discounts\s*>\s*\*\s*\{[^}]*flex:\s*1 1 260px/);
    // No two-column rule leaks into a phone query.
    assert.doesNotMatch(CSS.replace(block, ''), /checkout-summary__items\s*\{[^}]*repeat\(2/);
});
