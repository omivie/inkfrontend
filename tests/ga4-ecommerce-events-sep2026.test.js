/**
 * GA4 browser ecommerce events — the funnel GA4 could not draw (Sep 2026)
 * =======================================================================
 *
 * ERR-256 · backend handoff `ga4-ecommerce-events-FE-handoff-sep2026.md`
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * GA4 received NO ecommerce events from the browser. Purchases arrived
 * server-side through the Measurement Protocol, so revenue was right and
 * everything above it was empty — GA4 literally could not draw
 * view -> cart -> checkout -> purchase, and nobody could say where a mobile
 * funnel converting at 1.65% (against desktop's 8.6%, on 64% of ad clicks) lost
 * people. Measured before the change: zero occurrences of `view_item`,
 * `begin_checkout` or `add_shipping_info` anywhere in `inkcartridges/js/`.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 * Every failure mode here is silent. An analytics tag that reports the wrong
 * number looks exactly like one that reports the right number; the only symptom
 * arrives weeks later as a decision made on a bad figure.
 *
 *   1. AN UNSCOPED EVENT REACHES THE GOOGLE ADS ACCOUNT. gtag.js configures
 *      THREE destinations — G-SDQELG0FGD, a second GA4 property G-YJXTSGLM28
 *      that appears nowhere else in the repo, and AW-18032498762 — and an event
 *      with no `send_to` goes to all three. Every pre-existing custom event on
 *      this site (contact_form_submit, faq_open, quote_started) omits it. For an
 *      ecommerce-shaped event that would put add-to-cart hits into the account
 *      the owner bids from, against the backend's own acceptance criterion that
 *      its duplicated-conversion monitor stays 22/22. §2.
 *
 *   2. `value` READ AS THE RESULTING CART LINE TOTAL. The handoff says
 *      "value = line total". Read literally that is BF-060/ERR-223 verbatim: a
 *      line holding 2, add 1, and `confirmed.quantity` says 3, so the obvious
 *      formula reported a $290.97 three-unit add for one $96.99 cartridge. Every
 *      unit test passed, because one add to an EMPTY line is indistinguishable
 *      from a delta. Only a SECOND add to the same line exposes it. §5.
 *
 *   3. A FABRICATED DIMENSION. `getProductInfo().brandName` resolves through
 *      `extractBrand(name)` — a hardcoded five-brand read of the product NAME —
 *      and then to the literal `'Unknown'`. A missing brand is visibly missing
 *      and gets fixed; `'Unknown'` becomes one of the biggest rows in a report
 *      and is indistinguishable from a real brand. ERR-157. §4, §9.
 *
 *   4. A BROWSER `purchase` DOUBLE-COUNTING REVENUE. The server already posts
 *      one with the order's transaction_id, and MP dedup is unreliable. Nothing
 *      in the code stops a future reader from "completing the set". §3.
 *
 *   5. AN INVENTED `'urban'`. Three quote sites read
 *      `...:checked')?.value || 'urban'`, which is how the page quoted a rate
 *      nobody had chosen (ERR-235). A shipping_tier dimension that defaults to
 *      urban would report a delivery area as measured when it was assumed. §7.
 *
 *   6. AN ENROLMENT GAP. "Every surface calls X" is a list nobody maintains —
 *      ERR-194: cart-analytics.js sat on THREE pages behind a `typeof` guard
 *      that was therefore an off-switch at every real add-to-cart entry point,
 *      and add_to_cart recorded 56 events in its whole history. So enrolment is
 *      a SET EQUALITY here, never a count (ERR-214). §8.
 *
 * BEHAVIOUR IS EXECUTED, NOT GREPPED. §4–§7 run the real gtag.js in a vm with a
 * recording `gtag`, because the VALUES are the bug and `assert.match(/items/)`
 * cannot see a value. Source assertions (§9, §10) run on stripComments() output
 * so an assertion can never be satisfied by the prose explaining it.
 *
 * Run: node --test tests/ga4-ecommerce-events-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(INK, 'js', rel), 'utf8');

const GTAG_SRC = JS('gtag.js');
const GTAG_CODE = stripComments(GTAG_SRC);

const PROPERTY = 'G-SDQELG0FGD';
const SECOND_PROPERTY = 'G-YJXTSGLM28';
const ADS_TAG = 'AW-18032498762';

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
/** Never pin the ?v= cache token — it is stamped at deploy time (ERR-067). */
const loads = (src, file) => new RegExp(`src="/js/${file.replace('.', '\\.')}(\\?v=[a-f0-9]+)?"`).test(src);

/**
 * Run the real gtag.js in a sandbox with a recording `gtag`.
 *
 * The WHOLE file is executed — not a lifted slice — so the consent line, the
 * three configs and the tracker injection all have to survive too. `window`
 * must BE the global object exactly as in a browser: gtag.js opens with
 * `window.dataLayer = window.dataLayer || []` and reads a BARE `dataLayer` on
 * the next line, so a sandbox with `window` as a separate plain object makes
 * those two different variables and the file throws on load.
 */
function loadGtag({ deliveryArea = true } = {}) {
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
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(GTAG_SRC, ctx, { filename: 'gtag.js' });
    // Replace the real shim with a recorder AFTER load, so the file's own
    // bootstrap runs untouched.
    ctx.gtag = (...args) => { calls.push(args); };
    // utils.js loads AFTER this head script, so the module reads DeliveryArea at
    // call time. deliveryArea:false reproduces the page where it is not there.
    if (deliveryArea) ctx.DeliveryArea = { URBAN: 'urban', RURAL: 'rural' };
    return { ctx, calls, ga4: ctx.window.Ga4Ecommerce, ads: ctx.window.AdsConversions };
}

/**
 * Cross-realm normaliser. Objects built inside the vm carry that realm's
 * Object.prototype, so deepEqual against a literal written here reports "same
 * structure but not reference-equal". What we want to assert about is the shape
 * handed to gtag, not which realm allocated it.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The exact payload production returns from POST /api/cart/items (2026-09-06). */
const confirmed = (over = {}) => ({
    message: 'Added to cart',
    id: '3971df49-7431-4af8-aff5-d884481ffda4',
    product_id: '397ee9ab-a5da-4338-aa95-12b215f4529c',
    quantity: 2,
    quantity_added: 2,
    price_snapshot: 65.49,
    product: {
        sku: 'GLC3333M',
        name: 'Brother Genuine LC3333M Ink Cartridge LC3333 Magenta (1,500 pages)',
        retail_price: 65.49,
        source: 'genuine',
    },
    ...over,
});

/** A PDP product as /api/products/:sku returns it. */
const pdpProduct = (over = {}) => ({
    id: '397ee9ab',
    sku: 'GLC3333M',
    name: 'Brother Genuine LC3333M Ink Cartridge LC3333 Magenta (1,500 pages)',
    brand: { name: 'Brother' },
    product_type: 'ink_cartridge',
    category: 'CON-INK',
    retail_price: 65.49,
    source: 'genuine',
    ...over,
});

/** A cart whose pricing the server confirmed. */
const serverCart = (over = {}) => ({
    items: [
        { sku: 'GLC3333M', name: 'Brother Genuine LC3333M', brand: 'Brother', price: 65.49, quantity: 2 },
        { sku: 'CLC37BK', name: 'Compatible LC37BK', brand: 'Brother', price: 19.99, quantity: 1 },
    ],
    getSubtotal: () => 144.97,
    hasServerPricing: () => true,
    ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The module exists, and it exists ON WINDOW
// ═══════════════════════════════════════════════════════════════════════════

test('§1 Ga4Ecommerce is on window, not a bare const', () => {
    // ERR-156/ERR-167: `Config` and `Security` are bare consts, so every
    // `window.X?.y ? y : fallback` guard against them was an OFF SWITCH and the
    // fallback was the only branch that ever ran. All four call sites reach this
    // through a `typeof` guard, so the global has to genuinely exist.
    const { ga4 } = loadGtag();
    assert.ok(ga4, 'window.Ga4Ecommerce must exist — grep the `window.X =` line');
    assert.match(GTAG_SRC, /window\.Ga4Ecommerce = Ga4Ecommerce/);
});

test('§1 the four events the handoff asked for are the four methods that exist', () => {
    const { ga4 } = loadGtag();
    for (const m of ['viewItem', 'addToCart', 'beginCheckout', 'addShippingInfo']) {
        assert.equal(typeof ga4[m], 'function', `Ga4Ecommerce.${m} must be a function`);
    }
});

test('§1 it names the property the handoff names', () => {
    const { ga4 } = loadGtag();
    assert.equal(ga4.PROPERTY, PROPERTY);
    assert.equal(ga4.CURRENCY, 'NZD');
});

test('§1 AdsConversions still exists alongside it — this is an addition, not a move', () => {
    const { ads } = loadGtag();
    assert.ok(ads, 'AdsConversions must survive; the Ads tag is live money');
    assert.equal(typeof ads.addToCart, 'function');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. send_to — the scoping that keeps ecommerce events out of the ad account
// ═══════════════════════════════════════════════════════════════════════════

test('§2 the hazard is real: this file configures three destinations', () => {
    // The negative control for the whole section. If gtag.js only ever
    // configured one target, `send_to` would be decoration and every assertion
    // below would pass for the wrong reason.
    assert.match(GTAG_CODE, new RegExp(`gtag\\('config', '${PROPERTY}'`));
    assert.match(GTAG_CODE, new RegExp(`gtag\\('config', '${SECOND_PROPERTY}'`),
        'a second GA4 property is configured — an unscoped event reaches it too');
    assert.match(GTAG_CODE, new RegExp(`gtag\\('config', '${ADS_TAG}'`),
        'the Ads tag is configured — an unscoped event reaches the ad account');
});

test('§2 EVERY event is scoped to the one GA4 property', () => {
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct());
    ga4.addToCart(confirmed(), { priorQuantity: 0, requestedQuantity: 2 });
    ga4.beginCheckout(serverCart());
    ga4.addShippingInfo('urban', serverCart());

    assert.equal(calls.length, 4, 'all four events fired');
    const names = calls.map((c) => c[1]);
    assert.deepEqual(names, ['view_item', 'add_to_cart', 'begin_checkout', 'add_shipping_info']);

    for (const [, name, params] of calls) {
        assert.equal(params.send_to, PROPERTY, `${name} must name its one destination`);
        assert.equal(params.currency, 'NZD', `${name} must carry NZD`);
    }
});

test('§2 no event can reach the Ads account or the orphan second property', () => {
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct());
    ga4.addToCart(confirmed(), {});
    ga4.beginCheckout(serverCart());
    ga4.addShippingInfo('rural', serverCart());

    for (const [, name, params] of calls) {
        const to = String(params.send_to);
        assert.ok(!to.includes('AW-'), `${name} must never route to an Ads tag (got ${to})`);
        assert.ok(!to.includes(SECOND_PROPERTY), `${name} must not feed the orphan property`);
    }
});

test('§2 the GA4 destination is a named constant, not a literal per call site', () => {
    // One owner for the vocabulary, exactly like ADS. A literal repeated four
    // times is four chances to typo a property id into a silent black hole.
    const emits = GTAG_CODE.match(/send_to: GA4\.PROPERTY/g) || [];
    assert.ok(emits.length >= 1, 'events must route via GA4.PROPERTY');
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    assert.doesNotMatch(ga4Section, new RegExp(`send_to: '${PROPERTY}'`),
        'do not inline the property id at a call site — use GA4.PROPERTY');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. NO browser purchase — the double-count guard
// ═══════════════════════════════════════════════════════════════════════════

test('§3 no file in js/ emits a browser GA4 purchase event', () => {
    // The server posts `purchase` via the Measurement Protocol with the order's
    // transaction_id. A browser twin double-counts revenue unless both carry an
    // identical transaction_id AND GA4 dedups them — and MP dedup is unreliable.
    const dir = path.join(INK, 'js');
    const offenders = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            const code = stripComments(fs.readFileSync(full, 'utf8'));
            if (/gtag\(\s*'event'\s*,\s*'purchase'/.test(code)) offenders.push(path.relative(INK, full));
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [],
        'purchase is SERVER-SIDE ONLY. A browser twin double-counts revenue:\n  ' + offenders.join('\n  '));
});

test('§3 the module emits ONLY the four events, by allowlist', () => {
    // A BLOCKLIST WAS NOT ENOUGH, and this is how that was found: a mutation
    // that added `purchase(order) { this._emit('purchase', ...) }` sailed past
    // the grep above, because that grep looks for `gtag('event', 'purchase'` and
    // the module routes everything through its own _emit(). Blocklisting the one
    // name you thought of leaves every other way of spelling it open. So this
    // asserts the SET of event names the module can emit, and a fifth one of any
    // kind fails here whether or not anybody predicted it.
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    const emitted = (ga4Section.match(/_emit\('([a-z_]+)'/g) || [])
        .map((m) => m.slice(7, -1))
        .sort();
    assert.deepEqual(emitted, ['add_shipping_info', 'add_to_cart', 'begin_checkout', 'view_item'],
        'these four and nothing else — a browser `purchase` double-counts revenue');
    // And _emit() really is the only door. Not "no gtag() in the module" — the
    // emitter itself has to call it — but EXACTLY ONE call, inside _emit, which
    // is the single line that stamps send_to. A second one anywhere else is an
    // event that can reach all three configured destinations.
    const doors = (ga4Section.match(/gtag\('event'/g) || []).length;
    assert.equal(doors, 1, `${doors} gtag('event') calls in the module — there must be exactly one`);
    const emitBody = ga4Section.slice(ga4Section.indexOf('_emit(eventName, params)'));
    assert.match(emitBody.slice(0, emitBody.indexOf('\n    },')), /gtag\('event', eventName/,
        'the one call must be the generic one inside _emit');
});

test('§3 Ga4Ecommerce has no purchase method, and says why', () => {
    const { ga4 } = loadGtag();
    assert.equal(ga4.purchase, undefined, 'there must be no browser purchase to call');
    assert.ok(!Object.keys(ga4).includes('purchase'));
    // The reason has to outlive the person who knew it, or the next reader
    // "completes the set" and doubles the revenue figure.
    assert.match(GTAG_SRC, /THERE IS NO purchase\(\) HERE, DELIBERATELY/);
    assert.match(GTAG_SRC, /MP dedup is unreliable|dedup is unreliable/);
});

test('§3 the Ads purchase conversion is untouched — it is a different thing', () => {
    // order-confirmation-page.js fires the Google Ads purchase conversion behind
    // three tested guards. It is not a GA4 event and must not be swept up by
    // the rule above.
    const conf = stripComments(JS('order-confirmation-page.js'));
    assert.match(conf, /gtag\('event', 'conversion'/, 'the Ads purchase conversion must still be there');
    assert.match(conf, /W1laCPGzpJQcEMqwyJZD/, 'with its own label literal (live money, three guards)');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. view_item
// ═══════════════════════════════════════════════════════════════════════════

test('§4 it sends the SKU as item_id, with the raw product_type as the category', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.viewItem(pdpProduct());
    assert.equal(r.sent, true);

    const params = plain(calls[0][2]);
    assert.equal(params.items.length, 1);
    assert.deepEqual(params.items[0], {
        item_id: 'GLC3333M',
        item_name: 'Brother Genuine LC3333M Ink Cartridge LC3333 Magenta (1,500 pages)',
        item_brand: 'Brother',
        // The authoritative DB enum, which is what the handoff asked for and
        // what the product feed carries — NOT getProductInfo()'s normalised
        // 'ink' display bucket, whose fallback chain ends in reading the name.
        item_category: 'ink_cartridge',
        price: 65.49,
        quantity: 1,
    });
});

test('§4 value is the unit retail, GST-inclusive', () => {
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct());
    assert.equal(plain(calls[0][2]).value, 65.49);
});

test('§4 a brand of "Unknown" is OMITTED, never reported', () => {
    // getProductInfo() resolves brandName to the literal 'Unknown' when the
    // field is absent AND the five-brand name sniff misses. Reporting it makes a
    // fabricated brand indistinguishable from a real one in every report.
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct({ brand: 'Unknown' }));
    const item = plain(calls[0][2]).items[0];
    assert.equal('item_brand' in item, false, 'Unknown is not a brand');
    assert.equal(item.item_id, 'GLC3333M', 'the rest of the item still goes');
});

test('§4 a positive control — a REAL brand string is reported', () => {
    // Without this, the test above could pass because item_brand is never sent
    // at all, and the whole dimension would be silently missing.
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct({ brand: 'Epson' }));
    assert.equal(plain(calls[0][2]).items[0].item_brand, 'Epson');
});

test('§4 an absent brand or category is omitted, not blanked', () => {
    const { ga4, calls } = loadGtag();
    ga4.viewItem(pdpProduct({ brand: null, product_type: null }));
    const item = plain(calls[0][2]).items[0];
    assert.equal('item_brand' in item, false);
    assert.equal('item_category' in item, false);
});

test('§4 no SKU means no event — we cannot say what was viewed', () => {
    const { ga4, calls } = loadGtag();
    assert.deepEqual(plain(ga4.viewItem(pdpProduct({ sku: '  ' }))), { sent: false, reason: 'no-sku' });
    assert.equal(calls.length, 0);
});

test('§4 a missing price fires the event WITHOUT a value, never a $0.00', () => {
    // Number(null) IS 0. Coercing before checking the type turns "the server did
    // not report a price" into a confident zero — ERR-219/ERR-068 absence-as-zero.
    const { ga4, calls } = loadGtag();
    const r = ga4.viewItem(pdpProduct({ retail_price: null }));
    assert.deepEqual(plain(r), { sent: true, reason: 'no-price' });
    const params = plain(calls[0][2]);
    assert.equal('value' in params, false);
    assert.equal('price' in params.items[0], false);
});

test('§4 a genuine zero price IS a price', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.viewItem(pdpProduct({ retail_price: 0 }));
    assert.equal(r.sent, true);
    assert.equal(r.value, 0);
    assert.equal(plain(calls[0][2]).items[0].price, 0);
});

test('§4 one fire per SKU per page load; a different SKU still fires', () => {
    const { ga4, calls } = loadGtag();
    assert.equal(ga4.viewItem(pdpProduct()).sent, true);
    assert.deepEqual(plain(ga4.viewItem(pdpProduct())), { sent: false, reason: 'already-sent' });
    assert.equal(calls.length, 1);
    assert.equal(ga4.viewItem(pdpProduct({ sku: 'CLC37BK' })).sent, true);
    assert.equal(calls.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. add_to_cart — and its numeric parity with the Ads tag
// ═══════════════════════════════════════════════════════════════════════════

test('§5 QUANTITY IS A DELTA — the server reports the resulting LINE TOTAL', () => {
    // The case that hid BF-060: a line already holding 2, add 1 more, response
    // says `quantity: 3`. Sending that through reported a THREE-unit add.
    const { ga4, calls } = loadGtag();
    const r = ga4.addToCart(
        confirmed({ quantity: 3, quantity_added: 1, price_snapshot: 96.99 }),
        { priorQuantity: 2, requestedQuantity: 1 },
    );
    assert.equal(r.quantity, 1, 'ONE cartridge was added');
    assert.equal(r.value, 96.99, 'one unit, not three');
    assert.notEqual(r.value, 290.97, 'this is the exact number the bug reported');
    assert.equal(plain(calls[0][2]).items[0].quantity, 1);
});

test('§5 the server quantity_added wins over the local derivation', () => {
    const { ga4 } = loadGtag();
    // Local context would derive 5-1 = 4; the server says 2 and the server wins.
    const r = ga4.addToCart(
        confirmed({ quantity: 5, quantity_added: 2, price_snapshot: 10 }),
        { priorQuantity: 1, requestedQuantity: 4 },
    );
    assert.equal(r.quantity, 2);
    assert.equal(r.value, 20);
});

test('§5 an absent quantity_added falls back to the derivation, NOT the line total', () => {
    const { ga4 } = loadGtag();
    const payload = confirmed({ quantity: 3, price_snapshot: 96.99 });
    delete payload.quantity_added;
    const r = ga4.addToCart(payload, { priorQuantity: 2, requestedQuantity: 1 });
    assert.equal(r.quantity, 1, 'derived 3 - 2, not the line total 3');
    assert.equal(r.value, 96.99);
});

test('§5 a stale-low local cart can never INFLATE the delta', () => {
    const { ga4 } = loadGtag();
    const payload = confirmed({ quantity: 9, price_snapshot: 10 });
    delete payload.quantity_added;
    // The server holds 9 (a line from another device); we asked for 1. Derived
    // would be 9, which over-reports — the one direction that costs money.
    const r = ga4.addToCart(payload, { priorQuantity: 0, requestedQuantity: 1 });
    assert.equal(r.quantity, 1);
});

test('§5 a stock clamp downward is honoured', () => {
    const { ga4 } = loadGtag();
    const payload = confirmed({ quantity: 2, price_snapshot: 10 });
    delete payload.quantity_added;
    // Asked for 5, stock allowed 2 — the delta really is 2.
    const r = ga4.addToCart(payload, { priorQuantity: 0, requestedQuantity: 5 });
    assert.equal(r.quantity, 2);
});

test('§5 PARITY — GA4 and the Ads tag report the same quantity and value', () => {
    // The two platforms are fed the same payload and must agree, or one account
    // says $96.99 and the other says $290.97 about the same add and no assertion
    // spans both. Both read through the SAME shared readers, so this is
    // structural rather than a coincidence — this test is what proves it.
    const cases = [
        [confirmed({ quantity: 3, quantity_added: 1, price_snapshot: 96.99 }), { priorQuantity: 2, requestedQuantity: 1 }],
        [confirmed(), { priorQuantity: 0, requestedQuantity: 2 }],
        [confirmed({ quantity: 9, quantity_added: undefined, price_snapshot: 5 }), { priorQuantity: 0, requestedQuantity: 1 }],
        [confirmed({ price_snapshot: null }), { priorQuantity: 0, requestedQuantity: 2 }],
    ];
    for (const [payload, context] of cases) {
        const env = loadGtag();
        const g = env.ga4.addToCart(payload, context);
        const a = env.ads.addToCart(payload, context);
        const gp = plain(env.calls[0][2]);
        const ap = plain(env.calls[1][2]);
        assert.equal(gp.items[0].quantity, ap.items[0].quantity,
            'GA4 and Ads must report the same quantity');
        assert.equal(g.value, a.value, 'GA4 and Ads must report the same value');
        assert.equal('value' in gp, 'value' in ap,
            'they must agree on whether a value is reportable at all');
    }
});

test('§5 PARITY positive control — the wrong formula really would differ', () => {
    // If the two implementations both read `confirmed.quantity`, the parity test
    // above would still pass. This pins that the number they agree on is the
    // RIGHT one by showing what the wrong one would have been.
    const payload = confirmed({ quantity: 3, quantity_added: 1, price_snapshot: 96.99 });
    const lineTotalFormula = payload.price_snapshot * payload.quantity;
    assert.ok(Math.abs(lineTotalFormula - 290.97) < 0.005,
        `the bug reported this (${lineTotalFormula})`);
    const { ga4 } = loadGtag();
    assert.equal(ga4.addToCart(payload, { priorQuantity: 2, requestedQuantity: 1 }).value, 96.99);
});

test('§5 descriptors supply the two dimensions the server payload has not got', () => {
    const { ga4, calls } = loadGtag();
    ga4.addToCart(confirmed(), { priorQuantity: 0, requestedQuantity: 2 },
        { brand: 'Brother', category: 'ink_cartridge' });
    const item = plain(calls[0][2]).items[0];
    assert.equal(item.item_brand, 'Brother');
    assert.equal(item.item_category, 'ink_cartridge');
});

test('§5 absent descriptors mean the dimensions are OMITTED, not guessed', () => {
    // 6 of the 9 add-to-cart surfaces pass no brand, and only the PDP passes a
    // product_type. Those adds must carry no brand/category rather than a value
    // read out of the product name.
    const { ga4, calls } = loadGtag();
    ga4.addToCart(confirmed(), { priorQuantity: 0, requestedQuantity: 2 }, {});
    const item = plain(calls[0][2]).items[0];
    assert.equal('item_category' in item, false);
    assert.equal('item_brand' in item, false,
        'the server payload carries no brand and none was supplied');
    assert.equal(item.item_id, 'GLC3333M');
});

test('§5 a placeholder descriptor is dropped like any other', () => {
    const { ga4, calls } = loadGtag();
    ga4.addToCart(confirmed(), {}, { brand: 'Unknown', category: 'n/a' });
    const item = plain(calls[0][2]).items[0];
    assert.equal('item_brand' in item, false);
    assert.equal('item_category' in item, false);
});

test('§5 no SKU means no event', () => {
    const { ga4, calls } = loadGtag();
    const payload = confirmed();
    payload.product.sku = '';
    assert.deepEqual(plain(ga4.addToCart(payload, {})), { sent: false, reason: 'no-sku' });
    assert.equal(calls.length, 0);
});

test('§5 a missing price_snapshot fires WITHOUT a value, and says so', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.addToCart(confirmed({ price_snapshot: null }), { priorQuantity: 0, requestedQuantity: 2 });
    assert.deepEqual(plain(r), { sent: true, reason: 'no-price', quantity: 2 });
    assert.equal('value' in plain(calls[0][2]), false);
});

test('§5 it never falls back to retail_price or a local price', () => {
    // price_snapshot is what the shopper is actually charged. retail_price is
    // list. This frontend never computes a price, and a number invented for an
    // analytics property is worse than a missing one.
    const { ga4, calls } = loadGtag();
    ga4.addToCart(confirmed({ price_snapshot: null, product: { sku: 'X', retail_price: 999 } }), {});
    const item = plain(calls[0][2]).items[0];
    assert.equal('price' in item, false, 'retail_price must not stand in for price_snapshot');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. begin_checkout
// ═══════════════════════════════════════════════════════════════════════════

test('§6 value is the SERVER subtotal, and the provenance is in the return', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.beginCheckout(serverCart());
    assert.equal(r.sent, true);
    assert.equal(r.value, 144.97);
    assert.equal(r.valueSource, 'server', 'partialness belongs in the RETURN VALUE');
    assert.equal(plain(calls[0][2]).value, 144.97);
});

test('§6 a degraded cart still reports, and says the value is local', () => {
    const { ga4 } = loadGtag();
    const r = ga4.beginCheckout(serverCart({ getSubtotal: () => 165.47, hasServerPricing: () => false }));
    assert.equal(r.sent, true);
    assert.equal(r.value, 165.47);
    assert.equal(r.valueSource, 'local',
        'a local estimate is reportable, but it must never be indistinguishable from a confirmed one');
});

test('§6 GOODS ONLY — shipping and getTotal are not read', () => {
    // At begin_checkout the shopper has not reached the delivery section, so
    // getTotal() carries a guessed urban shipping estimate (ERR-235). A guess
    // must not become the funnel's headline number (ERR-241/255).
    const { ga4 } = loadGtag();
    let totalCalls = 0;
    const cart = serverCart({ getTotal: () => { totalCalls++; return 999; }, getShipping: () => { totalCalls++; return 9; } });
    const r = ga4.beginCheckout(cart);
    assert.equal(totalCalls, 0, 'neither getTotal() nor getShipping() may be consulted');
    assert.equal(r.value, 144.97);
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    assert.doesNotMatch(ga4Section, /getTotal\(/, 'the module must not reach for getTotal');
});

test('§6 items carry every line that can be named', () => {
    const { ga4, calls } = loadGtag();
    ga4.beginCheckout(serverCart());
    const items = plain(calls[0][2]).items;
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        item_id: 'GLC3333M', item_name: 'Brother Genuine LC3333M',
        item_brand: 'Brother', price: 65.49, quantity: 2,
    });
    // A cart line has no product_type: neither the local push whitelist nor
    // _parseServerCart carries one, so the dimension is absent, not guessed.
    assert.equal('item_category' in items[0], false);
});

test('§6 a line with no SKU is dropped, and the rest still go', () => {
    const { ga4, calls } = loadGtag();
    const cart = serverCart();
    cart.items = [{ name: 'nameless', price: 1, quantity: 1 }, cart.items[0]];
    const r = ga4.beginCheckout(cart);
    assert.equal(r.sent, true);
    assert.equal(r.items, 1);
    assert.equal(plain(calls[0][2]).items.length, 1);
});

test('§6 an empty cart cannot begin a checkout', () => {
    const { ga4, calls } = loadGtag();
    assert.deepEqual(plain(ga4.beginCheckout({ items: [] })), { sent: false, reason: 'empty-cart' });
    assert.equal(calls.length, 0);
});

test('§6 once per page load', () => {
    const { ga4, calls } = loadGtag();
    assert.equal(ga4.beginCheckout(serverCart()).sent, true);
    assert.deepEqual(plain(ga4.beginCheckout(serverCart())), { sent: false, reason: 'already-sent' });
    assert.equal(calls.length, 1);
});

test('§6 no Cart at all is reported, not crashed through', () => {
    const { ga4 } = loadGtag();
    assert.deepEqual(plain(ga4.beginCheckout()), { sent: false, reason: 'no-cart' });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. add_shipping_info
// ═══════════════════════════════════════════════════════════════════════════

test('§7 the tier is reported when the shopper chose one', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.addShippingInfo('rural', serverCart());
    assert.equal(r.sent, true);
    assert.equal(r.tier, 'rural');
    assert.equal(plain(calls[0][2]).shipping_tier, 'rural');
    assert.equal(plain(calls[0][2]).value, 144.97);
});

test('§7 NOTHING CHECKED never becomes "urban"', () => {
    // Three quote sites read `...:checked')?.value || 'urban'`, which is how the
    // page quoted an urban rate before anyone touched the control (ERR-235). The
    // funnel rung is real, so the event fires — but the tier is absent and the
    // return says why, exactly as the submit path records null.
    for (const bad of [null, undefined, '', '   ']) {
        const { ga4, calls } = loadGtag();
        const r = ga4.addShippingInfo(bad, serverCart());
        assert.equal(r.sent, true, 'the step still happened');
        assert.equal(r.reason, 'no-tier');
        assert.equal('tier' in r, false);
        assert.equal('shipping_tier' in plain(calls[0][2]), false,
            `a tier of ${JSON.stringify(bad)} must not be reported as urban`);
    }
});

test('§7 an unrecognised tier is not passed through either', () => {
    const { ga4, calls } = loadGtag();
    const r = ga4.addShippingInfo('URBAN!!', serverCart());
    assert.equal(r.reason, 'no-tier');
    assert.equal('shipping_tier' in plain(calls[0][2]), false);
});

test('§7 the vocabulary comes from DeliveryArea, the one owner of that rule', () => {
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    assert.match(ga4Section, /DeliveryArea\.URBAN/);
    assert.match(ga4Section, /DeliveryArea\.RURAL/);
    // Read at CALL time, not load time: utils.js loads after this head script.
    const { ga4 } = loadGtag({ deliveryArea: false });
    const r = ga4.addShippingInfo('urban', serverCart());
    assert.equal(r.sent, true, 'a page without DeliveryArea must still report the step');
    assert.equal(r.tier, 'urban');
});

test('§7 a repeated Continue with the same tier does not inflate the step', () => {
    const { ga4, calls } = loadGtag();
    assert.equal(ga4.addShippingInfo('urban', serverCart()).sent, true);
    assert.deepEqual(plain(ga4.addShippingInfo('urban', serverCart())), { sent: false, reason: 'already-sent' });
    assert.equal(calls.length, 1);
});

test('§7 a genuine urban -> rural change DOES re-fire', () => {
    // A boolean guard would record the first tier for ever, so a shopper who
    // corrected their delivery area would be reported at the wrong one. This is
    // why the guard stores the tier and not a flag.
    const { ga4, calls } = loadGtag();
    ga4.addShippingInfo('urban', serverCart());
    const r = ga4.addShippingInfo('rural', serverCart());
    assert.equal(r.sent, true);
    assert.equal(r.tier, 'rural');
    assert.equal(calls.length, 2);
    assert.equal(plain(calls[1][2]).shipping_tier, 'rural');
});

test('§7 a null tier is a state the guard remembers too', () => {
    const { ga4, calls } = loadGtag();
    assert.equal(ga4.addShippingInfo(null, serverCart()).sent, true);
    assert.deepEqual(plain(ga4.addShippingInfo(null, serverCart())), { sent: false, reason: 'already-sent' });
    assert.equal(calls.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7b. AN EMPTY CART IS NOT A CART WORTH $0.00
//
// Found by npm run probe:ga4-events on 2026-09-13, not by reasoning: a real
// add_shipping_info hit went out carrying `value=0`. On /checkout the cart held
// ZERO lines while hasServerPricing() answered TRUE and getSubtotal() answered
// 0 — the server had returned an empty cart together with a summary, so the
// figure was "server-confirmed" and it was zero. The allowance that let it
// through was written for a unit PRICE, where a genuine 0 is a real price. A
// cart with lines in it cannot be worth 0, and a cart with no lines has no
// value at all. ERR-063/068/073/075/076/149/150, pointed at a GA4 property.
// ═══════════════════════════════════════════════════════════════════════════

test('§7b an empty cart reports NO value — never a confident 0', () => {
    const { ga4 } = loadGtag();
    // The exact shape measured on the wire: no lines, server pricing "ok", 0.
    const emptyButPriced = { items: [], getSubtotal: () => 0, hasServerPricing: () => true };
    const r = ga4.addShippingInfo('urban', emptyButPriced);
    assert.equal(r.sent, false, 'a delivery area on an empty cart is not a funnel step');
    assert.equal(r.reason, 'empty-cart');
});

test('§7b and no hit goes out at all in that state', () => {
    const { ga4, calls } = loadGtag();
    ga4.addShippingInfo('urban', { items: [], getSubtotal: () => 0, hasServerPricing: () => true });
    assert.equal(calls.length, 0, 'value=0 must not reach Google — it did, before this was fixed');
});

test('§7b begin_checkout and add_shipping_info agree about an empty cart', () => {
    // The symmetry IS the requirement. If one fired and the other refused, GA4
    // would show add_shipping_info above its own parent step, and a funnel that
    // reads as a data bug gets distrusted wholesale.
    const { ga4 } = loadGtag();
    const empty = { items: [], getSubtotal: () => 0, hasServerPricing: () => true };
    assert.equal(ga4.beginCheckout(empty).reason, 'empty-cart');
    assert.equal(ga4.addShippingInfo('urban', empty).reason, 'empty-cart');
});

test('§7b a zero-valued cart that DOES have lines still reports 0 honestly', () => {
    // The positive control. The fix must key on the LINE COUNT, not on the value
    // being zero — otherwise a genuinely free line (a $0 promotional item) would
    // be silently dropped from the funnel, which is the opposite error.
    const { ga4, calls } = loadGtag();
    const freebie = {
        items: [{ sku: 'FREE1', name: 'Free sample', price: 0, quantity: 1 }],
        getSubtotal: () => 0,
        hasServerPricing: () => true,
    };
    const r = ga4.addShippingInfo('urban', freebie);
    assert.equal(r.sent, true);
    assert.equal(r.value, 0, 'a real cart of real zero-priced lines is worth 0, and that is reportable');
    assert.equal(plain(calls[0][2]).value, 0);
    assert.equal(plain(calls[0][2]).items.length, 1);
});

test('§7b the guard asks the LINE COUNT, not the number', () => {
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    const cv = ga4Section.slice(ga4Section.indexOf('_cartValue(cart) {'));
    const body = cv.slice(0, cv.indexOf('\n    },'));
    assert.match(body, /Array\.isArray\(cart\.items\)/,
        'the question is whether there are lines');
    assert.doesNotMatch(body, /value === 0|=== 0 \? null/,
        'never key the guard on the value being zero — that would drop a genuinely free line');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Enrolment — a SET, never a count (ERR-194 / ERR-214)
// ═══════════════════════════════════════════════════════════════════════════

test('§8 the tree actually has pages to check (guards a vacuous pass)', () => {
    assert.ok(HTML.length >= 40, `expected 40+ html files, found ${HTML.length}`);
    const withGtag = HTML.filter((f) => loads(fs.readFileSync(f, 'utf8'), 'gtag.js'));
    assert.ok(withGtag.length >= 35,
        `expected 35+ pages loading gtag.js, found ${withGtag.length} — if this drops, ` +
        'the tests below can pass by checking nothing');
});

test('§8 every page that can add to cart loads gtag.js', () => {
    const missing = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        if (!loads(src, 'cart.js')) continue;
        if (!loads(src, 'gtag.js')) missing.push(path.relative(INK, file));
    }
    assert.deepEqual(missing, [],
        'These pages add to cart but cannot emit add_to_cart — `typeof Ga4Ecommerce !== ' +
        "'undefined'` is an off-switch there:\n  " + missing.join('\n  '));
});

test('§8 every page carrying a GA4 fire site loads gtag.js, in the HEAD, first', () => {
    // gtag.js must be parsed before the controller that calls into it. It is a
    // blocking head script, so "before" is genuinely guaranteed — but only if
    // the tags are in that order.
    const controllers = ['product-detail-page.js', 'cart.js', 'checkout-page.js'];
    const problems = [];
    for (const file of HTML) {
        const src = fs.readFileSync(file, 'utf8');
        const owned = controllers.filter((c) => loads(src, c));
        if (!owned.length) continue;
        const rel = path.relative(INK, file);
        if (!loads(src, 'gtag.js')) { problems.push(`${rel} — no gtag.js (loads ${owned.join(', ')})`); continue; }
        const g = src.indexOf('/js/gtag.js');
        for (const c of owned) {
            const ci = src.indexOf(`/js/${c}`);
            if (ci !== -1 && ci < g) problems.push(`${rel} — ${c} is listed before gtag.js`);
        }
    }
    assert.deepEqual(problems, [], problems.join('\n  '));
});

test('§8 the PDP and checkout are both genuinely enrolled', () => {
    // Named explicitly: the set assertions above would pass if these pages
    // stopped loading their own controllers.
    for (const [rel, controller] of [
        ['html/product/index.html', 'product-detail-page.js'],
        ['html/checkout.html', 'checkout-page.js'],
    ]) {
        const src = fs.readFileSync(path.join(INK, rel), 'utf8');
        assert.ok(loads(src, controller), `${rel} must load ${controller}`);
        assert.ok(loads(src, 'gtag.js'), `${rel} must load gtag.js`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Absence over invention — source rules, on stripped code
// ═══════════════════════════════════════════════════════════════════════════

test('§9 gtag.js never divides by 1.15, anywhere in the file', () => {
    // Both platforms want the shopper-facing price. Deliberately whole-file:
    // a slice anchored on one function stops testing the claim the moment a
    // shared helper moves above it.
    assert.doesNotMatch(GTAG_CODE, /1\.15/,
        'GST-inclusive figures pass through untouched — there is no /1.15 in this file');
});

test('§9 the module never invents a placeholder label', () => {
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    assert.doesNotMatch(ga4Section, /'Unknown'/, 'never report Unknown as a dimension');
    assert.doesNotMatch(ga4Section, /\|\| 'urban'/, 'never substitute urban for a tier nobody chose');
    assert.doesNotMatch(ga4Section, /brandName/,
        'brandName carries the name-sniff and the Unknown fallback — read the authoritative brand');
});

test('§9 the placeholder list is real, and lowercase-insensitive', () => {
    // A positive control on the filter itself: without this the test above
    // passes on a module that simply never looks at a brand.
    const { ga4, calls } = loadGtag();
    for (const label of ['Unknown', 'UNKNOWN', 'unknown', 'N/A', 'none', '-']) {
        const env = loadGtag();
        env.ga4.viewItem(pdpProduct({ brand: label }));
        assert.equal('item_brand' in plain(env.calls[0][2]).items[0], false,
            `${label} must not be reported as a brand`);
    }
    ga4.viewItem(pdpProduct({ brand: 'Unknown Brands Ltd' }));
    assert.equal(plain(calls[0][2]).items[0].item_brand, 'Unknown Brands Ltd',
        'only an EXACT placeholder is dropped — a real name containing it survives');
});

test('§9 money is type-checked before it is coerced', () => {
    // Number(null) is 0 and so is Number(''). The check must be on the TYPE.
    const code = GTAG_CODE.slice(GTAG_CODE.indexOf('function readMoney'));
    const body = code.slice(0, code.indexOf('\n}'));
    assert.match(body, /typeof raw === 'number'/);
    assert.match(body, /typeof raw === 'string'/);
    const { ga4 } = loadGtag();
    for (const bad of [null, undefined, '', '   ', {}, [], NaN, 'abc']) {
        const env = loadGtag();
        const r = env.ga4.viewItem(pdpProduct({ retail_price: bad }));
        assert.equal(r.reason, 'no-price', `${JSON.stringify(bad)} is not a price`);
    }
    assert.equal(ga4.viewItem(pdpProduct({ retail_price: '65.49' })).value, 65.49,
        'a numeric string the backend sent IS a price');
});

test('§9 nothing here throws into a page', () => {
    const { ga4 } = loadGtag();
    const junk = [null, undefined, 0, 'x', [], true];
    for (const j of junk) {
        assert.equal(ga4.viewItem(j).sent, false);
        assert.equal(ga4.addToCart(j, j, j).sent, false);
    }
    // A cart whose getters explode must be reported, not propagated.
    const hostile = { items: [{ sku: 'A', price: 1, quantity: 1 }], getSubtotal() { throw new Error('boom'); } };
    assert.deepEqual(plain(ga4.beginCheckout(hostile)), { sent: false, reason: 'threw' });
    assert.deepEqual(plain(ga4.addShippingInfo('urban', hostile)), { sent: false, reason: 'threw' });
});

test('§9 a missing gtag is reported, never assumed', () => {
    // An ad blocker can remove the shim. Analytics never gates UX.
    const env = loadGtag();
    env.ctx.gtag = undefined;
    assert.deepEqual(plain(env.ga4.viewItem(pdpProduct())), { sent: false, reason: 'no-gtag' });
    assert.deepEqual(plain(env.ga4.beginCheckout(serverCart())), { sent: false, reason: 'no-gtag' });
    assert.deepEqual(plain(env.ga4.addShippingInfo('urban', serverCart())), { sent: false, reason: 'no-gtag' });
});

test('§9 consent is NOT gated here — Consent Mode owns that', () => {
    // analytics_storage is denied until the banner is accepted. Google models or
    // drops pre-consent hits by design; a second gate would suppress hits the
    // platform is built to handle, and would be a second implementation of a
    // policy that already has an owner (ERR-227).
    const ga4Section = GTAG_CODE.slice(GTAG_CODE.indexOf('const Ga4Ecommerce'));
    assert.doesNotMatch(ga4Section, /cookie_consent/,
        'the module must not read the consent key — gtag.js:9 and consent-banner.js own it');
    const env = loadGtag();   // no consent stored: the default branch is 'denied'
    assert.equal(env.ga4.viewItem(pdpProduct()).sent, true,
        'events must still be emitted pre-consent; Consent Mode decides what happens to them');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. The fire sites — a module nobody calls is the ERR-194 failure again
// ═══════════════════════════════════════════════════════════════════════════

const PDP_CODE = stripComments(JS('product-detail-page.js'));
const CART_CODE = stripComments(JS('cart.js'));
const CHECKOUT_CODE = stripComments(JS('checkout-page.js'));

test('§10 view_item fires from the PDP load flow, once', () => {
    assert.match(PDP_CODE, /Ga4Ecommerce\.viewItem\(this\.product\)/,
        'the PDP must pass the RAW product — getProductInfo() normalises the category ' +
        'and resolves brand to Unknown');
    // renderProduct() having exactly one caller is what makes this one fire per
    // page load. If it ever gains a second, this test says so.
    const callers = (PDP_CODE.match(/this\.renderProduct\(\)/g) || []).length;
    assert.equal(callers, 1,
        `renderProduct() has ${callers} callers — view_item is placed beside it and would ` +
        'double-fire; move it or dedupe it');
});

test('§10 the admin test product never enters GA4', () => {
    // The shopper path 404s at the _isTestProduct gate, but an admin holding an
    // AdminPreview grant falls THROUGH it and renders the page (ERR-234/246).
    const at = PDP_CODE.indexOf('Ga4Ecommerce.viewItem');
    assert.notEqual(at, -1);
    const guard = PDP_CODE.slice(Math.max(0, at - 400), at);
    assert.match(guard, /_isTestProduct\(this\.product\)/,
        'the view_item call must be guarded by the test-product check');
});

test('§10 add_to_cart is gated on serverConfirmed and nothing else', () => {
    assert.match(CART_CODE, /Ga4Ecommerce\.addToCart\(serverConfirmed,/);
    const at = CART_CODE.indexOf('Ga4Ecommerce.addToCart');
    const guard = CART_CODE.slice(Math.max(0, at - 200), at);
    assert.match(guard, /if \(serverConfirmed && typeof Ga4Ecommerce !== 'undefined'\)/,
        'the same single nullable that licenses the Ads conversion — no second condition to drift');
});

test('§10 add_to_cart is NOT inside the rejected or transport-failure branches', () => {
    // An add the server refused did not happen; an add that never got a 2xx has
    // no server price or delta. Both must stay out.
    //
    // This used to search for a literal `return;` between the refusal message
    // and the GA4 call. That pinned the RETURN STATEMENT'S PUNCTUATION as a
    // proxy for the invariant, and it broke the moment addItem started
    // returning a result object instead of undefined (ERR-269) — a change that
    // does not touch this invariant at all. Match any return, and then name the
    // branch, so the assertion fails when the exit disappears rather than when
    // its spelling changes.
    const at = CART_CODE.indexOf('Ga4Ecommerce.addToCart');
    const before = CART_CODE.slice(0, at);
    const rejected = before.lastIndexOf('Failed to add item to cart');
    assert.notEqual(rejected, -1, 'the server-rejected branch has moved or been renamed');
    const tail = before.slice(rejected);
    assert.match(tail, /\breturn\b[\s;{]/,
        'the GA4 call must sit AFTER the server-rejected branch has returned');
    assert.match(tail, /reason: 'server-rejected'/,
        "that exit must be the server-rejected one — an add the server refused is not revenue");
    assert.match(CART_CODE.slice(at - 600, at), /_trackAdd\(product\)/,
        'it belongs in the success tail, beside the first-party tracker');
});

test('§10 add_to_cart passes the caller descriptors it actually has', () => {
    const at = CART_CODE.indexOf('Ga4Ecommerce.addToCart');
    const call = CART_CODE.slice(at, at + 400);
    assert.match(call, /brand: product\.brand/);
    assert.match(call, /category: product\.product_type/);
    assert.match(call, /priorQuantity: priorQty/);
    assert.match(call, /requestedQuantity: addedQty/);
});

test('§10 the PDP hands product_type to the cart so add_to_cart can name a category', () => {
    assert.match(PDP_CODE, /product_type: info\.product_type/,
        'the PDP is the only add-to-cart surface that knows the authoritative product_type');
    // And it must stay a pass-through: putting it in the line whitelist would
    // change the persisted cart shape and the composite key's neighbourhood.
    const push = CART_CODE.slice(CART_CODE.indexOf('this.items.push({'), CART_CODE.indexOf('this.items.push({') + 700);
    assert.doesNotMatch(push, /product_type/,
        'product_type must NOT be persisted onto a cart line — it is read at the event and dropped');
});

test('§10 begin_checkout fires where the first-party beacon fires', () => {
    assert.match(CHECKOUT_CODE, /Ga4Ecommerce\.beginCheckout\(\)/);
    const beacon = CHECKOUT_CODE.indexOf('CartAnalytics.trackCheckoutStarted()');
    const ga4 = CHECKOUT_CODE.indexOf('Ga4Ecommerce.beginCheckout()');
    assert.ok(beacon !== -1 && ga4 !== -1 && ga4 > beacon && ga4 - beacon < 400,
        'the two must describe the same moment, so either can audit the other');
});

test('§10 add_shipping_info has BOTH emitters, and one shared helper', () => {
    assert.match(CHECKOUT_CODE, /_emitShippingInfo\(data\)/, 'the accordion Continue path');
    assert.match(CHECKOUT_CODE, /this\._emitShippingInfo\(null\)/, 'the submit backstop');
    const defs = (CHECKOUT_CODE.match(/_emitShippingInfo\(data\) \{/g) || []).length;
    assert.equal(defs, 1, 'one definition — the tier vocabulary must not be read in two places');
    const helper = CHECKOUT_CODE.slice(CHECKOUT_CODE.indexOf('_emitShippingInfo(data) {'));
    const body = helper.slice(0, helper.indexOf('\n        },'));
    assert.match(body, /input\[name="delivery_type"\]/);
    assert.doesNotMatch(body, /\|\| 'urban'/, 'record null, never an invented urban (ERR-235)');
    assert.match(body, /\|\| null/);
});

test('§10 the delivery section is found by its CONTROL, not by an index', () => {
    // The radios live inside the Shipping Address fieldset, so `index === 1` is
    // right today and moves silently the next time a section is reordered.
    const helper = CHECKOUT_CODE.slice(CHECKOUT_CODE.indexOf('_emitShippingInfo(data) {'));
    const body = helper.slice(0, helper.indexOf('\n        },'));
    assert.match(body, /data\.section && data\.section\.querySelector/);
    assert.doesNotMatch(body, /index === 1|data\.index/,
        'an index is a coincidence; asking which section contains the control is not');
});

test('§10 every call site reaches the module through a typeof guard', () => {
    // gtag.js is a blocking head script so the global is normally there, but an
    // ad blocker can remove the whole file. Analytics never breaks a page.
    for (const [name, code] of [['product-detail-page.js', PDP_CODE], ['cart.js', CART_CODE], ['checkout-page.js', CHECKOUT_CODE]]) {
        const calls = code.split('Ga4Ecommerce.').length - 1;
        assert.ok(calls >= 1, `${name} should call Ga4Ecommerce`);
        assert.match(code, /typeof Ga4Ecommerce !== 'undefined'/,
            `${name} must guard on the global's existence`);
    }
});
