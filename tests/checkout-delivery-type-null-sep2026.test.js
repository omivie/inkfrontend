/**
 * ERR-248 — the frontend was about to fabricate the value the backend had just
 * stopped fabricating
 * =============================================================================
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * We asked the backend to persist `orders.delivery_type` and NOT to backfill it,
 * on this argument (fe-backend-asks-sep2026.md §1):
 *
 *     "Every historical order was submitted by a form that could not express the
 *      difference, so 'urban' there is not a fact, it is a guess that will look
 *      like data forever. NULL on old rows is the honest value and lets us tell
 *      'we did not ask' from 'they said urban'."
 *
 * They agreed, and went further: they removed `Joi.string().valid('urban','rural')
 * .default('urban')` from order-create entirely, so a client that sends nothing
 * records NULL rather than a default.
 *
 * And then our own payload handed the guess straight back:
 *
 *     delivery_type: this.checkoutData.deliveryType || 'urban'      (Stripe)
 *     delivery_type: self.checkoutData.deliveryType || 'urban'      (PayPal)
 *     deliveryType: ...:checked')?.value || 'urban'                 (upstream)
 *
 * With those three in place the backend's change is a no-op with extra steps:
 * every order records "urban", recorded-urban is indistinguishable from
 * assumed-urban forever, and we would have stopped backfilling the past only to
 * start fabricating the future one row at a time.
 *
 * THIS IS NOT THEORETICAL. Measured against production 2026-09-12: the column is
 * live and writing — order 2026091201 recorded `urban` with
 * `supplier_freight.delivery_type_basis: "recorded"` — and NULL on the other 166
 * of 167. Every order from here is either an honest record or a permanent guess.
 *
 * THE HALF THAT IS EASY TO GET WRONG (§3)
 * ---------------------------------------
 * The rule is NOT "no `|| 'urban'` anywhere". The QUOTE sites must keep theirs.
 * A quote has to show the shopper a price, urban is the conservative one, and it
 * matches the backend's own quote-side default — `POST /api/shipping/options`
 * still defaults, and `POST /api/orders` re-prices server-side regardless, so
 * nothing a customer is charged changes here. Only the RECORD refuses to invent.
 *
 * §3 is therefore a POSITIVE CONTROL, not decoration: it fails if someone reads
 * the headline as a blanket ban and strips the defaults out of the pricing path.
 * Deleting them would change what a customer is charged, which is the one
 * outcome this whole change was designed not to have.
 *
 * §5 exists because a guard that cannot see its subject cannot fail (ERR-253):
 * every `doesNotMatch` below is paired with a proof that the text it is scanning
 * still contains the live code it is scanning for.
 *
 * Source text cannot prove a radio is on screen or that a payload left the
 * browser — `npm run probe:checkout-delivery` measures that against production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The shared one-pass stripper, NOT a local two-regex copy. A `//` comment
// containing a slash-star — every time anyone writes a path with a wildcard —
// opens a block comment to the naive version and deletes live code as far as the
// next terminator, silently. ERR-253 measured 22,251 characters vanishing across
// 35 test files, which is how "X is not allowed anywhere" guards went green over
// code they had never read.
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const CHECKOUT_JS = read('js', 'checkout-page.js');
const PAYMENT_JS = read('js', 'payment-page.js');
const ACCOUNT_JS = read('js', 'account.js');
const SHIPPING_JS = read('js', 'shipping.js');
const RATES_JS = read('js', 'admin', 'pages', 'shipping-rates.js');
const CHECKOUT_HTML = read('html', 'checkout.html');

const CHECKOUT_CODE = stripComments(CHECKOUT_JS);
const PAYMENT_CODE = stripComments(PAYMENT_JS);
const ACCOUNT_CODE = stripComments(ACCOUNT_JS);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the ORDER RECORD never invents a delivery type
// ─────────────────────────────────────────────────────────────────────────────

test("§1 neither order-create payload defaults delivery_type to 'urban'", () => {
    assert.doesNotMatch(PAYMENT_CODE, /delivery_type:\s*\w+\.checkoutData\.deliveryType\s*\|\|\s*'urban'/,
        "payment-page.js must not re-apply the default the backend deleted on 2026-09-10. "
        + "With this line present, `orders.delivery_type` is 'urban' on 100% of orders and the "
        + "column can never distinguish a stated urban from an unasked one.");
});

test('§1 both payloads OMIT the key rather than sending it, and they agree', () => {
    const spreads = PAYMENT_CODE.match(
        /\.\.\.\((?:this|self)\.checkoutData\.deliveryType \? \{ delivery_type: (?:this|self)\.checkoutData\.deliveryType \} : \{\}\)/g) || [];
    assert.equal(spreads.length, 2,
        'exactly two — the Stripe payload and the PayPal payload. An order that recorded a '
        + 'delivery type on one payment rail and not the other would be a fact about the '
        + 'payment method, not about the address.');

    // Omission, not an explicit null: "a client that sends nothing now records
    // NULL" is the sentence the backend documented and therefore the one that is
    // tested on their side. An explicit `delivery_type: null` would have to
    // survive a Joi `.valid()` list naming only two strings, and we have not
    // measured that it does.
    assert.doesNotMatch(PAYMENT_CODE, /delivery_type:\s*null/,
        'send nothing, do not send null — absence is the path with a stated contract');
});

test('§1 positive control — the payloads still carry delivery_type at all', () => {
    // Without this, §1 above passes just as well on a file where the field was
    // deleted, renamed, or commented out. The bug we are guarding against is a
    // wrong VALUE, so the field has to still be there to have a value.
    assert.match(PAYMENT_CODE, /delivery_type/,
        'payment-page.js must still send a delivery type when it has one');
    assert.match(PAYMENT_CODE, /checkoutData\.deliveryType/,
        'and it must still read it from the checkout hand-off');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the upstream store keeps "not asked" distinguishable
// ─────────────────────────────────────────────────────────────────────────────

test("§2 checkout stores null, not 'urban', when nothing is checked", () => {
    assert.match(CHECKOUT_CODE,
        /const deliveryType = document\.querySelector\('input\[name="delivery_type"\]:checked'\)\?\.value \|\| null;/,
        'the value that goes into checkoutData is the radio or null');
    assert.match(CHECKOUT_CODE, /deliveryType: deliveryType,/,
        'and the stored key reads that local, not a fresh defaulted query');
});

test('§2 null and not undefined, because this object is JSON in sessionStorage', () => {
    // `checkoutData` is JSON.stringify'd into sessionStorage and re-read on
    // payment.html. An `undefined` value drops the key entirely on the way
    // through, and payment-page.js could then not tell "the shopper was never
    // asked" from "the hand-off did not survive".
    assert.match(CHECKOUT_CODE, /sessionStorage\.setItem\('checkoutData', JSON\.stringify\(checkoutData\)\)/,
        'the round-trip this depends on must still be a JSON one');
    assert.doesNotMatch(CHECKOUT_CODE,
        /const deliveryType = document\.querySelector\('input\[name="delivery_type"\]:checked'\)\?\.value;/,
        'a bare optional-chain yields undefined, which vanishes in JSON');
});

test('§2 a missing control is LOUD, not silently defaulted', () => {
    // Fail-soft must be loud: the null is the honest record, but the absence of a
    // delivery-type control on a submitted checkout is a bug worth a log line.
    const idx = CHECKOUT_CODE.indexOf("const deliveryType = document.querySelector('input[name=\"delivery_type\"]:checked')?.value || null;");
    assert.notEqual(idx, -1, 'the store site must exist for this assertion to mean anything');
    const after = CHECKOUT_CODE.slice(idx, idx + 900);
    assert.match(after, /if \(!deliveryType\)/, 'the empty case must be branched on');
    assert.match(after, /DebugLog\.error\(/,
        'and reported — a skip is not a pass. Raw console.* is banned, so DebugLog is the alarm.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — POSITIVE CONTROL: the QUOTE sites keep their default
// ─────────────────────────────────────────────────────────────────────────────
//
// If this section ever fails, the change that broke it changed what a customer
// is charged. Read this comment before "fixing" it.

test("§3 the shipping-options quote still defaults to 'urban'", () => {
    assert.match(CHECKOUT_CODE,
        /const deliveryType = document\.querySelector\('input\[name="delivery_type"\]:checked'\)\?\.value \|\| 'urban';/,
        'the quote path must still produce a price when nothing is selected — this is the '
        + 'call that feeds POST /api/shipping/options, not the order record');
});

test("§3 Shipping.calculate still defaults to 'urban'", () => {
    assert.match(stripComments(SHIPPING_JS), /deliveryType = deliveryType \|\| 'urban';/,
        'the client-side fallback quote must still pick a band');
});

test("§3 the saved-address form still defaults to 'urban'", () => {
    assert.match(ACCOUNT_CODE, /input\[name="delivery_type"\]:checked'\)\?\.value \|\| 'urban'/,
        'an address is a preference the modal always asks for — the urban radio carries '
        + '`checked` in addresses.html and form.reset() restores it — so there is no silence '
        + 'here for a fallback to mistranslate, and its consumer already guards on null');
});

test("§3 the admin shipping-rates table still labels a blank row 'urban'", () => {
    assert.match(stripComments(RATES_JS), /r\.delivery_type \|\| 'urban'/,
        'a rate row is a rate, not an order');
});

test('§3 the rule is a boundary, not a ban — the defaults still exist in numbers', () => {
    // A floor, not an exact count: the point is that stripping the pricing path
    // bare fails here. Four is what remains after the record sites gave theirs up.
    const remaining = [CHECKOUT_CODE, ACCOUNT_CODE, stripComments(SHIPPING_JS), stripComments(RATES_JS)]
        .join('\n').match(/\|\| 'urban'/g) || [];
    assert.ok(remaining.length >= 4,
        `the quote path must keep its defaults; found ${remaining.length}. If you came here `
        + 'after deleting them, put them back: they decide what a shopper is quoted.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the markup that makes the record site a dead branch
// ─────────────────────────────────────────────────────────────────────────────

test('§4 both radios are required and exactly one is checked in the markup', () => {
    const radios = CHECKOUT_HTML.match(/<input[^>]*name="delivery_type"[^>]*>/g) || [];
    assert.equal(radios.length, 2, 'urban and rural');
    assert.ok(radios.every(r => /\brequired\b/.test(r)),
        'both required — this is the submit gate that makes the null branch unreachable '
        + 'on a working page');
    assert.equal(radios.filter(r => /\bchecked\b/.test(r)).length, 1,
        'exactly one checked — ERR-235 was the state where NEITHER was, while the page '
        + 'had already quoted urban');
});

test('§4 init leaves one selected rather than clearing the group', () => {
    // ERR-235: the markup's `checked` was a no-op because init()'s first act was
    // `forEach(r => r.checked = false)`. If that ever comes back, the null branch
    // stops being unreachable and every order records nothing.
    assert.match(CHECKOUT_CODE, /radios\.forEach\(r => \{ r\.checked = \(r\.value === DeliveryArea\.URBAN\); \}\);/,
        '_normaliseDeliveryType must still land on exactly one');
    assert.doesNotMatch(CHECKOUT_CODE, /forEach\(r => r\.checked = false\)/,
        'the blanket clear is what ERR-235 removed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — the guards above can actually see what they are scanning
// ─────────────────────────────────────────────────────────────────────────────

test('§5 stripComments did not eat the code these assertions read', () => {
    // Every doesNotMatch above is vacuously true over a string that lost the
    // region it was meant to scan. Name a live token from each file and prove it
    // survived the strip.
    for (const [label, code, token] of [
        ['payment-page.js', PAYMENT_CODE, 'checkoutData.deliveryType'],
        ['checkout-page.js', CHECKOUT_CODE, "sessionStorage.setItem('checkoutData'"],
        ['account.js', ACCOUNT_CODE, '#address-delivery-type'],
    ]) {
        assert.ok(code.includes(token),
            `${label}: the stripped source lost ${token}, so every scan over it is meaningless`);
    }
    // And that stripping removed something — a no-op stripper would also pass above.
    assert.ok(PAYMENT_CODE.length < PAYMENT_JS.length,
        'the stripper must actually strip, or the comment-blind assertions are untested');
});

test('§5 the comments explaining the split survive in the shipped source', () => {
    // Not decoration: the next reader's alternative to this comment is
    // re-deriving the quote-vs-record distinction from scratch, and getting it
    // wrong in the direction that changes prices.
    assert.match(PAYMENT_JS, /OMITTED, NEVER GUESSED/,
        'payment-page.js must explain why the key is absent rather than defaulted');
    assert.match(CHECKOUT_JS, /THE QUOTE SITES KEEP THEIR `\|\| 'urban'` ON PURPOSE/,
        'checkout-page.js must name the sites that are deliberately not changing');
});
