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

// ERR-347 — "Edit cart" lives in the header beside the bag, not under the items.
test('"Edit cart" is the header bag link label, not a summary link', () => {
    assert.doesNotMatch(HTML, /class="checkout-summary__edit"/);
    assert.match(HTML, /<a href="\/cart" class="checkout-header__bag">\s*<span class="checkout-header__bag-label">Edit cart<\/span>/);
    assert.match(CSS, /\.checkout-header__bag-label\s*\{/);
});

// ERR-348 — every PDF-quote box shows a grey "Optional" placeholder until typed in.
test('quote dialog inputs carry placeholder="Optional", greyed', () => {
    const JS = read('inkcartridges/js/cart-quote-pdf.js');
    assert.match(JS, /HEADER_FIELDS\.map\([\s\S]*?<input[^>]*placeholder="Optional"/);
    assert.match(CSS, /\.quote-pdf__dialog \.form-input::placeholder\s*\{[^}]*color:\s*#9ca3af/);
    assert.doesNotMatch(CSS, /\.quote-pdf__dialog \.form-input:focus::placeholder/);
});

// ERR-349 — quote dialog buttons: Cancel flush left, Download flush right, stack on narrow phones.
test('quote dialog actions span the dialog, not right-aligned', () => {
    const rule = CSS.match(/\.quote-pdf__dialog-actions\s*\{[^}]*\}/)[0];
    assert.doesNotMatch(rule, /justify-content:\s*flex-end/);
    assert.match(rule, /flex-wrap:\s*wrap/);
    assert.match(CSS, /\.quote-pdf__dialog-actions \.btn\s*\{[^}]*flex:\s*1 1 140px/);
});

// ERR-350 — the sticky summary must show every line on a laptop screen AND the page must
// scroll from the right column. An inner scroller (overflow:auto) trapped the wheel and
// clipped the qty badges; a too-tall column now pins by its bottom via --summary-top.
test('sticky summary pins by its bottom; no inner scroller', () => {
    const block = CSS.slice(CSS.lastIndexOf('@media (min-width: 1000px)'));
    assert.match(block, /\.checkout-sidebar \.checkout-summary\s*\{\s*top:\s*var\(--summary-top,\s*10px\)/);
    assert.doesNotMatch(block, /\.checkout-sidebar \.checkout-summary\s*\{[^}]*overflow/);
    assert.doesNotMatch(block, /overscroll-behavior/);
    const JS = read('inkcartridges/js/checkout-page.js');
    assert.match(JS, /this\.pinSummary\(\);/);
    const fn = JS.slice(JS.indexOf('pinSummary() {'), JS.indexOf('setupSummaryDisclosure() {'));
    assert.match(fn, /Math\.min\(10,\s*window\.innerHeight - summary\.offsetHeight - 6\)/);
    assert.match(fn, /new ResizeObserver\(update\)\.observe\(summary\)/);
    assert.match(block, /\.checkout-summary__trust\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
    // Cells start-aligned, or a short cell's price drops to its taller neighbour's height.
    assert.match(block, /\.checkout-summary__items\s*\{[^}]*align-items:\s*start/);
});
