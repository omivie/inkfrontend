/**
 * Google Ads add-to-cart conversion (Sep 2026)
 * ============================================
 * ERR-223 · hand-off `add-to-cart-tracking-FE-handoff-sep2026.md` §1
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The `Shopping Cart` conversion action (id 7710654861, category ADD_TO_CART)
 * has existed for ~6 months and `conversion_last_conversion_date` is EMPTY. Not
 * once, across 771 ad clicks in 30 days. It is a WEBPAGE_CODELESS action —
 * Google's automatic event detection, which scrapes the page for cart-like
 * interactions and needs a full page load to observe. An SPA add-to-cart never
 * produces one. So the rung of the funnel between "viewed" and "checked out"
 * has never been measured, while the account runs at ~2.2x break-even CPC and
 * mobile converts at 1.65% against desktop's 10.53%.
 *
 * THE THREE RULES THIS FILE PINS, AND WHY EACH ONE IS A REAL FAILURE
 * ------------------------------------------------------------------
 * 1. FIRE ONLY ON A CONFIRMED SERVER ADD. `Cart.addItem` has four exits and the
 *    internal funnel beacon fires on three of them — deliberately, because in
 *    three of them the item really is in the shopper's cart. Google Ads may
 *    fire on ONE: the 2xx. A conversion recorded for an add the server refused
 *    (out of stock, inactive pack) is a conversion that did not happen, in the
 *    account the owner bids real money from.
 *
 * 2. THE VALUE IS THE SERVER'S OR IT IS ABSENT. `price_snapshot` is what the
 *    shopper is actually charged. The local `product.price` a card was rendered
 *    from is NOT a substitute — this frontend never computes a price, and an
 *    invented number in an ad platform is worse than a missing one because it
 *    is silent and it is what Smart Bidding optimises against. Both
 *    `price_snapshot` and `retail_price` are GST-INCLUSIVE and stay that way:
 *    the ad platform wants the shopper-facing price, so a `/1.15` anywhere in
 *    this path is a bug.
 *
 * 3. ENROLMENT. This is the ERR-150/160 lesson and ERR-194 is the local proof:
 *    `cart-analytics.js` was loaded on THREE pages while `cart.js` is on 33, so
 *    `typeof CartAnalytics !== 'undefined'` was an off-switch at every real
 *    add-to-cart entry point and the metric read 56 events in its whole
 *    history. "Every page loads X" is a list nobody maintains unless a test
 *    maintains it. AdsConversions therefore lives in gtag.js, and §2 asserts
 *    gtag.js really is on every page that can add to cart.
 *
 * Run: node --test tests/ads-add-to-cart-conversion-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Source with comments stripped.
 *
 * Every `doesNotMatch` below MUST read this rather than the raw file. The
 * comments in these files deliberately quote the thing being banned — the
 * addToCart comment says "no /1.15", the api.js comment names the
 * `X-Session-Id` header it refuses to send — so a ban asserted against raw
 * source fails on its own explanation. A test that forbids documenting the
 * rule it enforces is a test nobody can satisfy honestly.
 */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const GTAG_SRC = read('inkcartridges/js/gtag.js');
const CART_SRC = read('inkcartridges/js/cart.js');
const API_SRC = read('inkcartridges/js/api.js');
const CONFIRM_SRC = read('inkcartridges/js/order-confirmation-page.js');
const GTAG_CODE = codeOnly(GTAG_SRC);
const CART_CODE = codeOnly(CART_SRC);
const API_CODE = codeOnly(API_SRC);

/** The balanced `{ … }` block that follows `marker`, comments and all. */
function blockAfter(src, marker, from = 0) {
    const start = src.indexOf(marker, from);
    assert.ok(start >= 0, `could not locate ${marker}`);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced block after ${marker}`);
}

/** The real labels, as the live Google Ads account reports them. */
const TAG_ID = 'AW-18032498762';
const ADD_TO_CART_LABEL = 'AW-18032498762/e3c8CI2D3dwcEMqwyJZD'; // action 7710654861
const PURCHASE_LABEL = 'AW-18032498762/W1laCPGzpJQcEMqwyJZD';    // action 7558732273

/**
 * Run the real gtag.js in a sandbox with a recording `gtag`, and hand back both
 * the module surface and every call it made. The whole file is executed — not a
 * lifted slice — so the consent line, the configs and the tracker injection all
 * have to survive too.
 */
function loadGtag() {
    const calls = [];
    const store = {};
    const ctx = {
        document: {
            head: { appendChild() {} },
            documentElement: { appendChild() {} },
            createElement: () => ({}),
        },
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        console,
    };
    // `window` must BE the global object, exactly as it is in a browser.
    // gtag.js opens with `window.dataLayer = window.dataLayer || []` and then
    // reads a BARE `dataLayer` on the next line; with `window` as a separate
    // plain object those are two different variables and the file throws on
    // load. A sandbox that does not model this cannot test this file.
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(GTAG_SRC, ctx);
    // gtag.js defines `function gtag(){dataLayer.push(arguments)}`; replace it
    // with a recorder AFTER load so the file's own bootstrap runs untouched.
    const bootstrapCalls = (ctx.dataLayer || []).map((a) => Array.from(a));
    ctx.gtag = (...args) => { calls.push(args); };
    return { ctx, calls, bootstrapCalls, ads: ctx.window.AdsConversions };
}

/**
 * Cross-realm normaliser.
 *
 * Objects built INSIDE the vm context carry that realm's Object.prototype, so
 * `assert.deepEqual` reports "same structure but not reference-equal" against a
 * literal written out here. Round-tripping through JSON gives a same-realm
 * value, which is what we actually want to assert about — the shape handed to
 * gtag, not which realm allocated it.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The exact payload production returns from POST /api/cart/items (2026-09-06). */
const confirmed = (over = {}) => ({
    message: 'Added to cart',
    id: '3971df49-7431-4af8-aff5-d884481ffda4',
    product_id: '397ee9ab-a5da-4338-aa95-12b215f4529c',
    quantity: 2,
    price_snapshot: 65.49,
    product: {
        sku: 'GLC3333M',
        name: 'Brother Genuine LC3333M Ink Cartridge LC3333 Magenta (1,500 pages)',
        retail_price: 65.49,
        source: 'genuine',
    },
    ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The tag itself
// ═══════════════════════════════════════════════════════════════════════════

test('§1 AdsConversions is on window, not a bare const', () => {
    // ERR-156/ERR-167: `Config` and `Security` are bare consts, so every
    // `window.X?.y ? y : fallback` guard against them was an OFF SWITCH and the
    // fallback was the only branch that ever ran. cart.js reaches this through
    // a `typeof` guard, so the global has to genuinely exist.
    const { ads } = loadGtag();
    assert.ok(ads, 'window.AdsConversions must exist — grep the `window.X =` line');
    assert.equal(typeof ads.addToCart, 'function');
    assert.match(GTAG_SRC, /window\.AdsConversions = AdsConversions/);
});

test('§1 it sends the real Shopping Cart label, and NZD', () => {
    const { ads, calls } = loadGtag();
    const r = ads.addToCart(confirmed());
    assert.equal(calls.length, 1, 'exactly one conversion per confirmed add');

    const [eventKeyword, eventName, params] = calls[0];
    assert.equal(eventKeyword, 'event');
    // Google's own generated snippet for this action uses 'conversion'. What
    // routes the hit is send_to + the label, not the event name.
    assert.equal(eventName, 'conversion');
    assert.equal(params.send_to, ADD_TO_CART_LABEL);
    assert.equal(params.currency, 'NZD');
    assert.equal(r.sent, true);
});

test('§1 value is price_snapshot x quantity added — the SERVER unit price', () => {
    const { ads, calls } = loadGtag();
    // empty line, add 2 -> server total 2, delta 2
    ads.addToCart(confirmed(), { priorQuantity: 0, requestedQuantity: 2 });
    assert.equal(calls[0][2].value, 130.98);   // 65.49 x 2
});

test('§1 it never divides by 1.15 anywhere', () => {
    // The ad platform wants the shopper-facing price. price_snapshot and
    // retail_price are both GST-inclusive and are passed through as-is.
    const fn = GTAG_CODE.slice(GTAG_CODE.indexOf('addToCart(confirmed'));
    assert.ok(fn.length > 200, 'located addToCart in the comment-stripped source');
    assert.doesNotMatch(fn, /1\.15/, 'no GST arithmetic belongs in an ad tag');
});

test('§1 the item is the SKU, tagged retail', () => {
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed(), { priorQuantity: 0, requestedQuantity: 2 });
    assert.deepEqual(plain(calls[0][2].items), [
        { id: 'GLC3333M', google_business_vertical: 'retail', quantity: 2 },
    ]);
});

test('§1 the server\'s own quantity_added wins when present', () => {
    // Added by the backend on 2026-09-06 in answer to BF-060, because
    // `quantity` is the resulting LINE TOTAL and could not change meaning (the
    // cart UI depends on it). Verified live the same day: empty line + 2 ->
    // quantity_added 2; then + 1 -> quantity 3, quantity_added 1.
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 96.99, quantity: 3, quantity_added: 1 }),
        { priorQuantity: 2, requestedQuantity: 1 });
    assert.equal(calls[0][2].items[0].quantity, 1);
    assert.equal(calls[0][2].value, 96.99);
});

test('§1 quantity_added is trusted over the local derivation when they disagree', () => {
    // The server knows what it actually inserted; the local cart is a cache and
    // can be stale. If they disagree, the server is right.
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 10, quantity: 9, quantity_added: 2 }),
        { priorQuantity: 0, requestedQuantity: 5 });   // derivation would say 5
    assert.equal(calls[0][2].items[0].quantity, 2);
    assert.equal(calls[0][2].value, 20);
});

test('§1 an absent or junk quantity_added falls back to the derivation, NOT the line total', () => {
    // This is the whole reason the derivation is kept. Without it a response
    // without the field falls through to `quantity` — the LINE TOTAL — and the
    // triple-value bug returns silently. Removing a fallback is a behaviour
    // change, not a cleanup (ERR-158).
    for (const junk of [undefined, null, 0, -1, '', 'abc', NaN, {}]) {
        const { ads, calls } = loadGtag();
        const c = confirmed({ price_snapshot: 96.99, quantity: 3 });
        if (junk !== undefined) c.quantity_added = junk;
        ads.addToCart(c, { priorQuantity: 2, requestedQuantity: 1 });
        assert.equal(calls[0][2].items[0].quantity, 1,
            `quantity_added ${JSON.stringify(junk)} must fall back to the delta, never to 3`);
        assert.equal(calls[0][2].value, 96.99);
    }
});

test('§1 the two paths AGREE on the case that hid the bug — an add to an empty line', () => {
    // The trap is that the wrong formula is RIGHT here: on an empty line the
    // line total IS the delta, so this case cannot distinguish them. Pinning
    // the agreement keeps that fact executable rather than folkloric.
    const withField = loadGtag();
    withField.ads.addToCart(confirmed({ price_snapshot: 50, quantity: 2, quantity_added: 2 }),
        { priorQuantity: 0, requestedQuantity: 2 });
    const withoutField = loadGtag();
    withoutField.ads.addToCart(confirmed({ price_snapshot: 50, quantity: 2 }),
        { priorQuantity: 0, requestedQuantity: 2 });
    assert.equal(withField.calls[0][2].value, withoutField.calls[0][2].value);
    assert.equal(withField.calls[0][2].value, 100);
});

test('§1 QUANTITY IS A DELTA — the server reports the resulting LINE TOTAL', () => {
    // The bug this replaces, measured in a real browser 2026-09-06: a line
    // holding 2, add 1 more, response says quantity: 3. Sent straight through
    // that reported a 3-unit add at $290.97 for a shopper who added ONE $96.99
    // cartridge — triple value, silently, on every add to an existing line.
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 96.99, quantity: 3 }),
        { priorQuantity: 2, requestedQuantity: 1 });
    assert.equal(calls[0][2].items[0].quantity, 1, 'ONE was added, not three');
    assert.equal(calls[0][2].value, 96.99, 'and it is worth one cartridge');
});

test('§1 a stock clamp is honoured — the smaller true delta is reported', () => {
    // Asked for 5, the server line went 0 -> 2. Two were added.
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 10, quantity: 2 }),
        { priorQuantity: 0, requestedQuantity: 5 });
    assert.equal(calls[0][2].items[0].quantity, 2);
    assert.equal(calls[0][2].value, 20);
});

test('§1 a stale-low local cart can never INFLATE the delta', () => {
    // The server may hold a line added on another device, so `priorQuantity`
    // can be too low and the raw delta too high. Over-reporting is the
    // direction that costs money, so the delta is capped at what was requested.
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 10, quantity: 9 }),
        { priorQuantity: 0, requestedQuantity: 1 });
    assert.equal(calls[0][2].items[0].quantity, 1, 'never more than was asked for');
    assert.equal(calls[0][2].value, 10);
});

test('§1 with no server quantity it falls back to what was requested', () => {
    const { ads, calls } = loadGtag();
    const c = confirmed({ price_snapshot: 10 });
    delete c.quantity;
    ads.addToCart(c, { priorQuantity: 3, requestedQuantity: 2 });
    assert.equal(calls[0][2].items[0].quantity, 2);
    assert.equal(calls[0][2].value, 20);
});

test('§1 and with no context at all it still reports one unit, never a line total', () => {
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 10, quantity: 7 }));
    assert.equal(calls[0][2].items[0].quantity, 1,
        'an uninstrumented caller must under-report, not over-report');
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. Absence is reported, never invented — the ERR-063/068 line
// ═══════════════════════════════════════════════════════════════════════════

test('§1b a missing price_snapshot fires the conversion WITHOUT a value', () => {
    // The add really happened, so the funnel rung must be recorded. But we do
    // not know what it was worth, and a made-up number is worse than none: it
    // is silent, and it is what Smart Bidding optimises against.
    const { ads, calls } = loadGtag();
    const c = confirmed();
    delete c.price_snapshot;
    const r = ads.addToCart(c);

    assert.equal(calls.length, 1, 'still fires — the add is real');
    assert.ok(!('value' in calls[0][2]), 'but carries NO value key');
    assert.equal(calls[0][2].currency, 'NZD');
    assert.equal(r.sent, true);
    assert.equal(r.reason, 'no-price', 'and the partialness is in the RETURN VALUE');
});

test('§1b it never falls back to retail_price or a local price', () => {
    const { ads, calls } = loadGtag();
    const c = confirmed();
    delete c.price_snapshot;
    c.product.retail_price = 65.49;
    c.price = 99.99; // a card's local price, the tempting wrong answer
    ads.addToCart(c);
    assert.ok(!('value' in calls[0][2]),
        'retail_price is LIST price and a local price is not the server\'s — ' +
        'this frontend never computes a price');
});

test('§1b a zero price is a price; null/undefined are not', () => {
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed({ price_snapshot: 0 }));
    assert.equal(calls[0][2].value, 0, 'a genuine zero is zero — ERR-068');

    // Number(null) === 0 and Number('') === 0. Coercing before range-checking
    // turns "not reported" into a confident $0.00 — ERR-219/ERR-068, aimed at
    // the account the owner bids from. Each of these must omit `value`.
    for (const absent of [null, undefined, '', '   ', 'abc', {}, [], NaN]) {
        const g = loadGtag();
        g.ads.addToCart(confirmed({ price_snapshot: absent }));
        assert.equal(g.calls.length, 1, `${String(absent)}: still fires`);
        assert.ok(!('value' in g.calls[0][2]),
            `price_snapshot ${JSON.stringify(absent)} must NOT become $0.00`);
    }

    // Positive control: a numeric string IS a price, so the guard above is
    // rejecting absence rather than rejecting everything.
    const g3 = loadGtag();
    g3.ads.addToCart(confirmed({ price_snapshot: '12.50', quantity: 2 }),
        { priorQuantity: 0, requestedQuantity: 2 });
    assert.equal(g3.calls[0][2].value, 25);
});

test('§1b no SKU means no conversion — we cannot say what was bought', () => {
    const { ads, calls } = loadGtag();
    const c = confirmed();
    c.product.sku = '';
    const r = ads.addToCart(c);
    assert.equal(calls.length, 0);
    assert.deepEqual(plain(r), { sent: false, reason: 'no-sku' });
});

test('§1b it reports rather than throws when gtag is absent or input is junk', () => {
    // An analytics tag must never take an add-to-cart down with it.
    const { ads } = loadGtag();
    assert.deepEqual(plain(ads.addToCart(null)), { sent: false, reason: 'no-payload' });
    assert.deepEqual(plain(ads.addToCart(undefined)), { sent: false, reason: 'no-payload' });

    const noGtag = loadGtag();
    noGtag.ctx.gtag = undefined;
    assert.deepEqual(plain(noGtag.ads.addToCart(confirmed())), { sent: false, reason: 'no-gtag' });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Enrolment — the ERR-194 shape, refused
// ═══════════════════════════════════════════════════════════════════════════

/** Every .html in the deployed tree. */
function htmlFiles(dir = INK, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) htmlFiles(full, out);
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}
const HTML = htmlFiles();
const loads = (src, file) => new RegExp(`src="/js/${file.replace('.', '\\.')}(\\?v=[a-f0-9]+)?"`).test(src);

test('§2 the tree actually has pages to check (guards a vacuous pass)', () => {
    assert.ok(HTML.length >= 30, `expected 30+ html files, found ${HTML.length}`);
    const withCart = HTML.filter((f) => loads(fs.readFileSync(f, 'utf8'), 'cart.js'));
    assert.ok(withCart.length >= 30,
        `expected 30+ pages loading cart.js, found ${withCart.length} — if this drops, the ` +
        'test below can pass by checking nothing');
});

test('§2 EVERY page that loads cart.js also loads gtag.js', () => {
    // This is what makes `typeof AdsConversions !== 'undefined'` in cart.js a
    // guard rather than an off-switch. ERR-194 is the same sentence with
    // cart-analytics.js in it, and it cost the metric its entire history.
    const missing = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        if (!loads(src, 'cart.js')) continue;
        if (!loads(src, 'gtag.js')) missing.push(path.relative(INK, file));
    }
    assert.deepEqual(missing, [],
        'These pages can add to cart but cannot report the conversion:\n  ' + missing.join('\n  '));
});

test('§2 gtag.js is in the HEAD, before cart.js, on every such page', () => {
    // gtag.js is a blocking HEAD script and cart.js is a deferred body script,
    // so AdsConversions is always defined by the time an add can happen. A page
    // that reverses them is a copy-paste that did not follow the pattern.
    const wrong = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        const c = src.indexOf('/js/cart.js');
        if (c === -1) continue;
        const g = src.indexOf('/js/gtag.js');
        if (g === -1 || g > c) wrong.push(path.relative(INK, file));
    }
    assert.deepEqual(wrong, [], wrong.join('\n  '));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. One vocabulary for the Ads labels
// ═══════════════════════════════════════════════════════════════════════════

test('§3 the purchase label in order-confirmation-page.js has not drifted', () => {
    // The purchase tag is live money behind three tested guards, so it keeps its
    // own literal rather than reading this registry — this change must not be
    // able to move it. What a test CAN do is make the two impossible to drift.
    assert.match(CONFIRM_SRC, new RegExp(`send_to: '${PURCHASE_LABEL}'`),
        'the deployed purchase conversion must still send the account label for action 7558732273');
    assert.match(GTAG_SRC, new RegExp(`PURCHASE: '${PURCHASE_LABEL}'`),
        'and the registry must name the same one');
});

test('§3 both labels sit under the one tag id already configured site-wide', () => {
    assert.match(GTAG_SRC, new RegExp(`gtag\\('config', '${TAG_ID}'`),
        'one global site tag, two labels — never a second AW- tag');
    assert.ok(ADD_TO_CART_LABEL.startsWith(TAG_ID + '/'));
    assert.ok(PURCHASE_LABEL.startsWith(TAG_ID + '/'));
});

test('§3 the add-to-cart label is not accidentally the purchase label', () => {
    // Copy-pasting the purchase snippet is the obvious way to build this, and it
    // would report every add-to-cart as a PURCHASE, at full value, into the
    // primary conversion Smart Bidding optimises on.
    assert.notEqual(ADD_TO_CART_LABEL, PURCHASE_LABEL);
    const { ads, calls } = loadGtag();
    ads.addToCart(confirmed());
    assert.notEqual(calls[0][2].send_to, PURCHASE_LABEL,
        'an add-to-cart must never report into the purchase action');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The call site — the branch that licenses the tag
// ═══════════════════════════════════════════════════════════════════════════

test('§4 cart.js captures the server payload instead of discarding the response', () => {
    assert.match(CART_SRC, /serverConfirmed = response\.data \|\| null;/,
        'the 2xx payload carries price_snapshot / quantity / product.sku and used to be thrown away');
});

test('§4 the Ads conversion is gated on serverConfirmed, nothing else', () => {
    assert.match(CART_CODE, /if \(serverConfirmed && typeof AdsConversions !== 'undefined'\) \{/,
        'one condition, and it is the presence of a confirmed server payload');
    assert.match(CART_CODE, /AdsConversions\.addToCart\(serverConfirmed, \{\s*priorQuantity: priorQty,\s*requestedQuantity: addedQty,\s*\}\);/,
        'and it hands over what the line held, so the LINE TOTAL can be turned back into a delta');
    assert.match(CART_CODE, /const priorQty = existingItem \? \(existingItem\.quantity \|\| 0\) : 0;/);
    // priorQty must be read BEFORE the local mutation, or it is already wrong.
    assert.ok(CART_CODE.indexOf('const priorQty =') < CART_CODE.indexOf('existingItem.quantity += '),
        'the local cart is mutated before the server answers — read the prior quantity first');
});

test('§4 serverConfirmed is assigned on exactly ONE branch', () => {
    // If a second assignment ever appears, the branch table in the comment above
    // the call stops being true and the tag can fire on an add the server never
    // accepted. This is the whole safety property of the design.
    // The `let serverConfirmed = null` declaration is not an assignment of a
    // value that licenses the tag, so it is anchored out rather than counted.
    assert.match(CART_CODE, /let serverConfirmed = null;/, 'declared once');
    const assignments = CART_CODE.match(/^\s+serverConfirmed = (?!null)/gm) || [];
    assert.equal(assignments.length, 1,
        `serverConfirmed is assigned ${assignments.length} times; exactly one (the 2xx) is correct`);
});

test('§4 the Ads call is NOT inside the transport-failure catch', () => {
    // That branch keeps the item, saves it and shows it in the cart — so the
    // internal beacon fires there, deliberately. But there was no 2xx, so there
    // is nothing to tell Google. API.request THROWS on a plain 400, which lands
    // here with the item still in the cart, which is exactly why this matters.
    // Brace-matched, NOT sliced to the next `showToast(` — the catch block
    // contains one of its own ("Item saved locally…"), so an end-marker slice
    // stops short of `_trackAdd` and the assertion below passes vacuously.
    const catchBlock = blockAfter(CART_SRC, '} catch (error) {', CART_SRC.indexOf('async addItem(product)'));
    assert.ok(catchBlock.length > 100, 'located the transport-failure catch');
    assert.match(catchBlock, /Item saved locally/, 'and it really is the transport-failure one');
    assert.match(catchBlock, /this\._trackAdd\(product\);/, 'the internal beacon DOES fire here');
    assert.doesNotMatch(catchBlock, /AdsConversions/, 'Google Ads must NOT');
});

test('§4 the Ads call is NOT inside the server-rejected branch', () => {
    const start = CART_SRC.indexOf('if (!response.ok) {');
    const end = CART_SRC.indexOf('serverConfirmed = response.data');
    const rejected = CART_SRC.slice(start, end);
    assert.ok(rejected.length > 100, 'located the rejection branch');
    assert.doesNotMatch(rejected, /AdsConversions/);
    assert.doesNotMatch(rejected, /_trackAdd/, 'neither tracker fires on a rolled-back add');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The join key on the cart POST (hand-off §2, the half that was outstanding)
// ═══════════════════════════════════════════════════════════════════════════

test('§5 POST /api/cart/items carries ?sid=/?vid=', () => {
    // Without it the row the backend now writes server-side from this request
    // lands with session_id: null and joins to nothing.
    assert.match(API_SRC, /return this\.post\(this\.identifyUrl\('\/api\/cart\/items'\), \{ product_id: productId, quantity \}\);/);
});

test('§5 and it does NOT use the X-Session-Id header the hand-off asked for', () => {
    // BF-054, re-measured 2026-09-06: the header is absent from
    // Access-Control-Allow-Headers, and a browser fails the preflight and never
    // sends the request. On this endpoint that means nobody can add to cart.
    assert.doesNotMatch(API_CODE, /X-Session-Id/,
        'a browser fails the preflight and never sends the request at all');
    assert.doesNotMatch(API_CODE, /X-Visitor-Id/);
    // Positive control: the ban is real, not an artefact of over-stripping.
    assert.match(API_SRC, /X-Session-Id/,
        'api.js must still EXPLAIN in a comment why the header is not used');
});

test('§5 identifyUrl is a forwarder to the one owner of the id vocabulary', () => {
    const fn = API_SRC.match(/identifyUrl\(url\) \{[\s\S]*?\n    \},/)[0];
    assert.match(fn, /window\.TrafficTracker/,
        'ids come from traffic-tracker.js — nothing else may mint one');
    assert.doesNotMatch(fn, /Math\.random|Date\.now/, 'and this must never mint one itself');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Found in the browser while verifying the above — the cross-sell URL
// ═══════════════════════════════════════════════════════════════════════════

test('§6 the cold-cache cross-sell URL is resolved against the API host', () => {
    // Measured in a real browser 2026-09-06, and then against production:
    //   https://www.inkcartridges.co.nz/api/products/<sku>/bought-together -> 404
    //   https://api.inkcartridges.co.nz/api/products/<sku>/bought-together -> 200
    // The backend returns a ROOT-RELATIVE `frequently_bought_together_url`, and
    // fetching it as-is resolved it against the storefront origin, where
    // nothing proxies /api/. Every cold-cache cross-sell died silently: the
    // failure path is a bare `return` and the caller is `.catch(() => {})`.
    const fn = blockAfter(CART_SRC, 'async _showCrossSellModal(payload)');
    assert.match(fn, /Config\.API_URL/,
        'a root-relative /api/ path must be prefixed with the API host');
    assert.doesNotMatch(codeOnly(fn), /fetch\(payload\.url\b/,
        'fetching payload.url directly is the 404');
});

test('§6 an absolute URL from the backend is left alone', () => {
    // If the server ever starts returning a fully-qualified URL, rewriting it
    // would be us overriding a decision it already made.
    const fn = codeOnly(blockAfter(CART_SRC, 'async _showCrossSellModal(payload)'));
    assert.match(fn, /\^https\?:/, 'absolute URLs are detected and passed through');
});
