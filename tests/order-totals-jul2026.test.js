/**
 * Order money: ONE shared source of truth (Jul 2026)
 * ==================================================
 *
 * Pins `js/order-totals.js`, the single definition of how a customer-facing
 * ORDER's money is read and displayed. It replaced three divergent copies:
 * /order-confirmation, /account/order-detail, and (new) the receipt PDF.
 *
 * These are BEHAVIOURAL assertions against the real module in a `vm` sandbox,
 * not source-text greps. That is deliberate: the earn-basis and fail-soft rules
 * used to be pinned by matching the *implementation* text in
 * order-confirmation-page.js, which meant the pin broke the moment the code was
 * refactored and told us nothing about whether the RULE still held. Same lesson
 * as ERR-073. Pin the rule.
 *
 * THE CENTRAL CONTRACT: null means NOT REPORTED, 0 means REPORTED AS ZERO, and
 * the two are never collapsed. Most of the tests below exist to hold that line,
 * because absence-as-zero is this codebase's most-repeated defect
 * (ERR-063/068/073/075/076).
 *
 * Run with: node --test tests/order-totals-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');

/**
 * Load the real order-totals.js into a sandbox. `formatPrice` is stubbed to a
 * predictable `$N.NN` so assertions can match exact strings without depending
 * on the host's Intl data.
 */
function loadOrderTotals(opts = {}) {
    const sandbox = {
        console,
        Math,
        JSON,
        Number,
        String,
        Array,
        Object,
        module: { exports: {} }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.formatPrice = (n) => '$' + Number(n).toFixed(2);
    if (opts.businessDiscountLabel) sandbox.businessDiscountLabel = opts.businessDiscountLabel;
    if (opts.noFormatPrice) delete sandbox.formatPrice;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(JS('order-totals.js'), ctx, { filename: 'order-totals.js' });
    return sandbox.OrderTotals;
}

const rowFor = (rows, key) => rows.find((r) => r.key === key);

/**
 * Objects built inside a vm context have that context's prototypes, so
 * assert.deepStrictEqual against a host-realm literal fails on prototype
 * identity alone. Copy across the realm boundary before comparing.
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Strip comments before asserting on code. The purity checks below are about
 * what the module DOES; prose in a docblock that merely mentions sessionStorage
 * or the DOM is not a violation.
 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

// ─────────────────────────────────────────────────────────────────────────────
// The module surface
// ─────────────────────────────────────────────────────────────────────────────

test('exports normalise / rows / format / formatPoints / ascii on window', () => {
    const OT = loadOrderTotals();
    assert.equal(typeof OT.normalise, 'function');
    assert.equal(typeof OT.rows, 'function');
    assert.equal(typeof OT.format, 'function');
    assert.equal(typeof OT.formatPoints, 'function');
    assert.equal(typeof OT.ascii, 'function');
});

test('order-totals.js is pure — no DOM, no fetch, no storage, no console', () => {
    const src = stripComments(JS('order-totals.js'));
    // A money helper that touches the DOM cannot be shared with the PDF builder.
    assert.doesNotMatch(src, /document\./, 'must not touch the DOM');
    assert.doesNotMatch(src, /getElementById|querySelector/, 'must not query the DOM');
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/, 'must not do I/O');
    assert.doesNotMatch(src, /localStorage|sessionStorage/, 'must not touch storage');
    // House rule: zero raw console.* anywhere under inkcartridges/js (ERR-035).
    assert.doesNotMatch(src, /(^|[^.\w])console\.(log|warn|error|info|debug)\s*\(/, 'must not use raw console.*');
});

// ─────────────────────────────────────────────────────────────────────────────
// null vs 0 — the honesty contract
// ─────────────────────────────────────────────────────────────────────────────

test('unknown is null, reported-zero is 0 — never collapsed', () => {
    const OT = loadOrderTotals();

    const empty = OT.normalise({});
    assert.equal(empty.subtotal, null, 'absent subtotal is null, not 0');
    assert.equal(empty.shipping, null, 'absent shipping is null, not 0');
    assert.equal(empty.gstAmount, null, 'absent gst is null, not 0');
    assert.equal(empty.total, null, 'absent total is null, not 0');
    assert.equal(empty.loyaltyDiscount, null);
    assert.equal(empty.pointsEarned, null);

    const zeroed = OT.normalise({ subtotal: 0, shipping_fee: 0, gst_amount: 0, total: 0 });
    assert.equal(zeroed.subtotal, 0, 'reported 0 stays 0');
    assert.equal(zeroed.shipping, 0);
    assert.equal(zeroed.gstAmount, 0);
    assert.equal(zeroed.total, 0);
});

test('junk values normalise to null, not NaN and not 0', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ subtotal: 'abc', shipping_fee: '', total: undefined, gst_amount: NaN });
    assert.equal(t.subtotal, null);
    assert.equal(t.shipping, null);
    assert.equal(t.total, null);
    assert.equal(t.gstAmount, null);
});

test('numeric strings are accepted — APIs send "12.50"', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ subtotal: '12.50', total: '19.50', shipping_fee: '7.00' });
    assert.equal(t.subtotal, 12.5);
    assert.equal(t.total, 19.5);
    assert.equal(t.shipping, 7);
});

// ─────────────────────────────────────────────────────────────────────────────
// The points-earned estimate — the DEC-004 exception, and the honesty fix
// ─────────────────────────────────────────────────────────────────────────────

test('estimate basis is order value EX-SHIPPING: total 57, shipping 7 -> 50 pts', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ total: 57, shipping_fee: 7 });
    assert.equal(t.pointsEarnedEstimate, 50);
});

test('UNKNOWN shipping collapses the estimate to null — it is NOT treated as free', () => {
    // This is the bug being fixed. The old code did
    //   order.shippingCost || order.shipping_cost || 0
    // so an order with unreported shipping estimated off the FULL total and
    // overstated the points by the shipping amount. Unknown is not zero.
    const OT = loadOrderTotals();
    const t = OT.normalise({ total: 57 });
    assert.equal(t.shipping, null);
    assert.equal(t.pointsEarnedEstimate, null, 'no shipping figure => no estimate at all');
    assert.equal(rowFor(OT.rows(t), 'earned'), undefined, 'and therefore no earned row');
});

test('UNKNOWN total collapses the estimate to null', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ shipping_fee: 7 });
    assert.equal(t.pointsEarnedEstimate, null);
});

test('genuinely-free shipping still estimates: total 42, shipping 0 -> 42 pts', () => {
    const OT = loadOrderTotals();
    assert.equal(OT.normalise({ total: 42, shipping_fee: 0 }).pointsEarnedEstimate, 42);
});

test('estimate floors and never goes negative', () => {
    const OT = loadOrderTotals();
    assert.equal(OT.normalise({ total: 57.99, shipping_fee: 7 }).pointsEarnedEstimate, 50);
    assert.equal(OT.normalise({ total: 5, shipping_fee: 9 }).pointsEarnedEstimate, 0);
});

test('backend points_earned WINS over the estimate and drops the ~ marker', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ total: 57, shipping_fee: 7, points_earned: 43 });
    assert.equal(t.pointsEarned, 43);
    const row = rowFor(OT.rows(t), 'earned');
    assert.equal(row.value, '+43 pts');
    assert.equal(row.note, undefined, 'a confirmed figure needs no estimate caveat');
});

test('estimated earn is marked with ~ AND carries an explanatory note', () => {
    const OT = loadOrderTotals();
    const row = rowFor(OT.rows(OT.normalise({ total: 57, shipping_fee: 7 })), 'earned');
    assert.match(row.value, /^≈ \+50 pts$/, 'estimate is prefixed with the approximation sign');
    assert.match(row.note, /Estimate/i, 'and says so in words, not just a glyph');
    assert.match(row.note, /excluding shipping/i, 'and states the basis');
    // Must not promise a timing the backend does not guarantee. Retro points are
    // immediate now, and no "24h" copy has ever existed in this repo — do not
    // introduce one via the note.
    assert.doesNotMatch(row.note, /24\s*h|24 hours|business day|overnight/i);
});

test('zero earned points render no row (not "+0 pts")', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ total: 0, shipping_fee: 0, points_earned: 0 });
    assert.equal(rowFor(OT.rows(t), 'earned'), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// rows(): order, labels, visibility
// ─────────────────────────────────────────────────────────────────────────────

test('row order is stable: subtotal, shipping, discounts, gst, total, earned', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({
        subtotal: 100, shipping_fee: 7, gst_amount: 13.04, total: 92,
        loyalty_discount_amount: 5, loyalty_points_redeemed: 500,
        b2b_discount_amount: 4, discount_amount: 15, coupon_code: 'SAVE10',
        points_earned: 85
    });
    assert.deepEqual(
        plain(OT.rows(t).map((r) => r.key)),
        ['subtotal', 'shipping', 'loyalty', 'b2b', 'coupon', 'gst', 'total', 'earned']
    );
});

test('shipping has three distinct states: unknown, FREE, and an amount', () => {
    const OT = loadOrderTotals();
    const shipping = (order) => rowFor(OT.rows(OT.normalise(order)), 'shipping');

    const unknown = shipping({});
    assert.equal(unknown.kind, 'unknown');
    assert.equal(unknown.value, '—', 'unreported shipping is an em-dash, never FREE and never $0.00');

    const free = shipping({ shipping_fee: 0 });
    assert.equal(free.kind, 'free');
    assert.equal(free.value, 'FREE');

    const paid = shipping({ shipping_fee: 7.5 });
    assert.equal(paid.kind, 'money');
    assert.equal(paid.value, '$7.50');
});

test('unreported subtotal renders an em-dash, NOT the total', () => {
    // The /account/order-detail bug: `order.subtotal || order.total` printed the
    // TOTAL under the "Subtotal" label, which is silently wrong on every
    // discounted order.
    const OT = loadOrderTotals();
    const row = rowFor(OT.rows(OT.normalise({ total: 84.98 })), 'subtotal');
    assert.equal(row.kind, 'unknown');
    assert.equal(row.value, '—');
    assert.doesNotMatch(row.value, /84\.98/, 'the total must never masquerade as the subtotal');
});

test('GST fail-softs to "Included" when not reported — never $0.00', () => {
    const OT = loadOrderTotals();
    const absent = rowFor(OT.rows(OT.normalise({ total: 10 })), 'gst');
    assert.equal(absent.kind, 'included');
    assert.equal(absent.value, 'Included');

    const reported = rowFor(OT.rows(OT.normalise({ total: 10, gst_amount: 1.3 })), 'gst');
    assert.equal(reported.kind, 'money');
    assert.equal(reported.value, '$1.30');
});

test('loyalty row is omitted at 0 and shown as a negative when redeemed', () => {
    const OT = loadOrderTotals();
    assert.equal(rowFor(OT.rows(OT.normalise({ loyalty_discount_amount: 0 })), 'loyalty'), undefined);

    const row = rowFor(OT.rows(OT.normalise({ loyalty_discount_amount: 5 })), 'loyalty');
    assert.equal(row.kind, 'negative');
    assert.equal(row.value, '-$5.00');
    assert.equal(row.label, 'Loyalty points applied');
});

test('loyalty label carries the POINT COUNT when the backend reports it', () => {
    // loyalty_points_redeemed exists on the order row but was read nowhere
    // before Jul 2026, so the row could say "-$12.00" but never "1,200 pts".
    const OT = loadOrderTotals();
    const t = OT.normalise({ loyalty_discount_amount: 12, loyalty_points_redeemed: 1200 });
    assert.equal(t.loyaltyPoints, 1200);
    assert.equal(rowFor(OT.rows(t), 'loyalty').label, 'Loyalty points applied (1,200 pts)');
});

test('B2B row uses businessDiscountLabel when cart.js is present, plain label otherwise', () => {
    // The injected stub mirrors the REAL businessDiscountLabel in cart.js, which
    // labels the row with `company_name`. It used to spell a `pricing_tier` here
    // ("Business account (gold tier)") — dead vocabulary since v2 retired the
    // flat bronze/silver/gold tiers, and it survived only because the stub is
    // injected, so the test could keep passing against a field the API no longer
    // sends. Under volume pricing there is no account-level rate to name.
    const withLabel = loadOrderTotals({
        businessDiscountLabel: (meta) => `Volume discount — ${meta.company_name}`
    });
    const t = { b2bDiscount: 4.68, b2bMeta: { company_name: 'Acme Print Co' } };
    assert.equal(rowFor(withLabel.rows(t), 'b2b').label, 'Volume discount — Acme Print Co');

    // The receipt PDF and order-detail do not load cart.js — must not hard-depend.
    // The built-in fallback must also not claim a business account: this row is
    // ungated and prints wherever the server reports an amount (ERR-149).
    const bare = loadOrderTotals();
    assert.equal(rowFor(bare.rows(t), 'b2b').label, 'Volume discount');
    assert.doesNotMatch(rowFor(bare.rows(t), 'b2b').label, /business/i);
});

test('coupon row is the aggregate discount NET of loyalty and B2B — no double count', () => {
    // discount_amount is the total of every discount (loyalty + b2b + coupon),
    // per loyalty-page.js:262-265. Showing it whole alongside its own components
    // would count the same dollars twice.
    const OT = loadOrderTotals();
    const t = OT.normalise({
        discount_amount: 15,
        loyalty_discount_amount: 5,
        b2b_discount_amount: 4,
        coupon_code: 'SAVE10'
    });
    assert.equal(t.otherDiscount, 6);
    assert.equal(rowFor(OT.rows(t), 'coupon').value, '-$6.00');
    assert.equal(rowFor(OT.rows(t), 'coupon').label, 'Discount (SAVE10)');
});

test('coupon row vanishes when the aggregate is fully explained by loyalty + B2B', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ discount_amount: 9, loyalty_discount_amount: 5, b2b_discount_amount: 4 });
    assert.equal(t.otherDiscount, 0);
    assert.equal(rowFor(OT.rows(t), 'coupon'), undefined);
});

test('an aggregate SMALLER than its components floors at 0 rather than going negative', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ discount_amount: 3, loyalty_discount_amount: 5 });
    assert.equal(t.otherDiscount, 0);
});

test('unreported total renders an em-dash total row', () => {
    const OT = loadOrderTotals();
    const row = rowFor(OT.rows(OT.normalise({ subtotal: 10 })), 'total');
    assert.equal(row.kind, 'unknown');
    assert.equal(row.value, '—');
});

// ─────────────────────────────────────────────────────────────────────────────
// Both payload shapes — raw API row AND transformAPIOrder/sessionStorage output
// ─────────────────────────────────────────────────────────────────────────────

test('accepts the raw GET /api/orders/{n} shape', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({
        order_number: 'INK-10432',
        created_at: '2026-07-28T02:00:00Z',
        subtotal: 89.98,
        shipping_fee: 0,
        gst_amount: 11.08,
        total: 84.98,
        loyalty_discount_amount: 5,
        order_items: [
            { product_sku: 'CN-045', product_name: 'Canon 045 Black', quantity: 2, unit_price: 44.99, line_total: 89.98 }
        ]
    });
    assert.equal(t.orderNumber, 'INK-10432');
    assert.equal(t.items.length, 1);
    assert.equal(t.items[0].sku, 'CN-045');
    assert.equal(t.items[0].lineTotal, 89.98);
    assert.equal(t.total, 84.98);
});

test('accepts the camelCase transformAPIOrder / sessionStorage snapshot shape', () => {
    // payment-page.js#buildOrderSnapshot writes this to sessionStorage and the
    // confirmation page reads it back when the API call fails. If normalise only
    // understood snake_case, that offline path would regress to all-em-dashes.
    const OT = loadOrderTotals();
    const t = OT.normalise({
        orderNumber: 'INK-10432',
        shippingCost: 7,
        total: 57,
        items: [{ sku: 'HP-63', name: 'HP 63 Black', quantity: 1, price: 39.99 }]
    });
    assert.equal(t.orderNumber, 'INK-10432');
    assert.equal(t.shipping, 7);
    assert.equal(t.items[0].sku, 'HP-63');
    assert.equal(t.items[0].unitPrice, 39.99);
    assert.equal(t.pointsEarnedEstimate, 50, 'the estimate works on the snapshot shape too');
});

test('line total falls back to qty x unit price, and is null when neither is knowable', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ items: [
        { name: 'A', quantity: 3, price: 10 },
        { name: 'B' }
    ] });
    assert.equal(t.items[0].lineTotal, 30);
    assert.equal(t.items[1].lineTotal, null, 'unknown line total is null, not 0');
    assert.equal(t.items[1].name, 'B');
});

test('items default to an empty array and a nameless item gets a safe label', () => {
    const OT = loadOrderTotals();
    assert.deepEqual(plain(OT.normalise({}).items), []);
    assert.deepEqual(plain(OT.normalise(null).items), []);
    assert.equal(OT.normalise({ items: [{}] }).items[0].name, 'Item');
});

test('nested product object supplies sku/name when the flat fields are absent', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ order_items: [{ product: { sku: 'BR-TN2450', name: 'Brother TN-2450' }, quantity: 1 }] });
    assert.equal(t.items[0].sku, 'BR-TN2450');
    assert.equal(t.items[0].name, 'Brother TN-2450');
});

test('invoice number is read from the nested invoice block or a flat field', () => {
    const OT = loadOrderTotals();
    assert.equal(OT.normalise({ invoice: { invoice_number: 'INV-2001' } }).invoiceNumber, 'INV-2001');
    assert.equal(OT.normalise({ invoice_number: 'INV-2002' }).invoiceNumber, 'INV-2002');
    assert.equal(OT.normalise({}).invoiceNumber, null);
});

test('the two live B2B payload shapes both work (number vs object)', () => {
    // cart.js:32-43 documents this: the handoff said summary.b2b_discount was the
    // metadata object; live it is a NUMBER, and the object arrives elsewhere.
    const OT = loadOrderTotals();
    const asNumber = OT.normalise({ b2b_discount: 4.68 });
    assert.equal(asNumber.b2bDiscount, 4.68);
    assert.equal(asNumber.b2bMeta, null);

    // The live metadata object is { company_name, effective_percent,
    // discount_amount, floored_line_count, source } — no pricing_tier since v2.
    const asObject = OT.normalise({
        b2b_discount: { company_name: 'Acme Print Co', discount_amount: 4.68, source: 'volume' }
    });
    assert.equal(asObject.b2bDiscount, 4.68);
    assert.equal(asObject.b2bMeta.company_name, 'Acme Print Co');
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation guard (the ERR-113 consistency-gate habit)
// ─────────────────────────────────────────────────────────────────────────────

test('footing reconciles when the rows add up', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ subtotal: 89.98, shipping_fee: 0, loyalty_discount_amount: 5, discount_amount: 5, total: 84.98 });
    assert.equal(t.footing.checkable, true);
    assert.equal(t.footing.reconciles, true);
    assert.equal(t.footing.delta, 0);
});

test('footing flags a disagreement instead of silently rewriting the total', () => {
    const OT = loadOrderTotals();
    const t = OT.normalise({ subtotal: 100, shipping_fee: 0, total: 80 });
    assert.equal(t.footing.reconciles, false);
    assert.equal(t.footing.delta, -20);
    // The customer must still see what they were actually charged.
    assert.equal(rowFor(OT.rows(t), 'total').value, '$80.00');
});

test('footing is not checkable when subtotal or total is unknown', () => {
    const OT = loadOrderTotals();
    assert.equal(OT.normalise({ total: 80 }).footing.checkable, false);
    assert.equal(OT.normalise({ subtotal: 80 }).footing.checkable, false);
    assert.equal(OT.normalise({}).footing.reconciles, true, 'unknown must not read as a failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// format / formatPoints / ascii
// ─────────────────────────────────────────────────────────────────────────────

test('format delegates to the shared formatPrice, and falls back when absent', () => {
    assert.equal(loadOrderTotals().format(7.5), '$7.50');
    assert.equal(loadOrderTotals({ noFormatPrice: true }).format(7.5), '$7.50');
    assert.equal(loadOrderTotals().format(null), '—', 'unknown money is an em-dash');
});

test('formatPoints groups thousands in en-NZ', () => {
    const OT = loadOrderTotals();
    assert.equal(OT.formatPoints(1200), '1,200');
    assert.equal(OT.formatPoints(85), '85');
    assert.equal(OT.formatPoints(null), '—');
});

test('ascii() folds glyphs jsPDF standard fonts cannot encode', () => {
    // jsPDF's built-in times/helvetica are WinAnsi/cp1252. U+2248 and U+2212 are
    // NOT in cp1252 and vanish or corrupt silently in the PDF, so every string
    // the PDF draws goes through this.
    const OT = loadOrderTotals();
    assert.equal(OT.ascii('≈ +50 pts'), '~ +50 pts');
    assert.equal(OT.ascii('—'), '-');
    assert.equal(OT.ascii('−5'), '-5');
    assert.equal(OT.ascii('it’s'), "it's");
    assert.equal(OT.ascii('“x”'), '"x"');
    assert.equal(OT.ascii('a b'), 'a b');
    assert.equal(OT.ascii(null), '');
    // ASCII passes through untouched.
    assert.equal(OT.ascii('Canon 045 Black $44.99'), 'Canon 045 Black $44.99');
});

test('every rows() value survives ascii() as printable ASCII', () => {
    // Guards the PDF against a future row introducing an unencodable glyph.
    const OT = loadOrderTotals();
    const t = OT.normalise({
        subtotal: 100, shipping_fee: 0, total: 92,
        loyalty_discount_amount: 5, loyalty_points_redeemed: 500,
        b2b_discount_amount: 4, discount_amount: 15, coupon_code: 'SAVE10'
    });
    const all = OT.rows(t);
    // Include the unknown-state rows too.
    all.push(...OT.rows(OT.normalise({})));
    for (const r of all) {
        for (const s of [r.label, r.value, r.note || '']) {
            assert.match(OT.ascii(s), /^[\x20-\x7e]*$/, `not ASCII-safe after fold: ${JSON.stringify(s)}`);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence — normalise() must be safe to run on its own output
// ─────────────────────────────────────────────────────────────────────────────

test('normalise(normalise(x)) === normalise(x) — every money field round-trips', () => {
    // THIS IS NOT ACADEMIC. order-confirmation-page.js normalises twice: once in
    // transformAPIOrder (whose output is what the rest of the page and
    // sessionStorage carry) and again in renderTotals. A field that only survives
    // the first pass silently disappears from the UI. The coupon row did exactly
    // that — `otherDiscount` is DERIVED from `discount_amount`, which the
    // transform does not carry forward, so the second pass rebuilt it as null.
    // Found in a live browser; both passes look correct read in isolation.
    const OT = loadOrderTotals();
    const raw = {
        order_number: 'INK-10432', created_at: '2026-07-28T02:00:00Z',
        customer_email: 'buyer@example.com',
        subtotal: 89.98, shipping_fee: 0, gst_amount: 11.08, total: 84.98,
        loyalty_discount_amount: 5, loyalty_points_redeemed: 500,
        b2b_discount: { company_name: 'Acme Print Co', discount_amount: 4, source: 'volume' },
        discount_amount: 15, coupon_code: 'SAVE10', points_earned: 85,
        order_items: [{ product_sku: 'CN-045', product_name: 'Canon 045 Black', quantity: 2, unit_price: 44.99, line_total: 89.98 }]
    };

    const once = OT.normalise(raw);
    const twice = OT.normalise(once);

    const FIELDS = ['subtotal', 'shipping', 'gstAmount', 'total', 'loyaltyDiscount',
        'loyaltyPoints', 'b2bDiscount', 'otherDiscount', 'couponCode', 'pointsEarned',
        'pointsEarnedEstimate', 'orderNumber', 'email'];
    for (const f of FIELDS) {
        assert.deepEqual(plain(twice[f]), plain(once[f]), `${f} did not survive a second normalise()`);
    }
    assert.equal(twice.items.length, once.items.length, 'items must survive');
    assert.equal(twice.b2bMeta && twice.b2bMeta.company_name, 'Acme Print Co', 'b2b metadata must survive');

    // And the rendered rows must be identical, which is what the user actually sees.
    assert.deepEqual(plain(OT.rows(twice)), plain(OT.rows(once)));
});

test('a shipping TIER NAME is never mistaken for a shipping cost', () => {
    // `shipping` is overloaded: the tier name on a raw order, the numeric cost on
    // normalise()'s own output. Reading it must never turn "Standard Shipping"
    // into a number, and must never let it shadow a real shipping_fee.
    const OT = loadOrderTotals();
    assert.equal(OT.normalise({ shipping: 'Standard Shipping' }).shipping, null,
        'a tier name is not a cost — it must read as NOT REPORTED');
    assert.equal(OT.normalise({ shipping: 'Overnight Express', shipping_fee: 7 }).shipping, 7,
        'a real figure must win over the tier name');
    assert.equal(OT.normalise({ shipping: 'Standard Shipping', shipping_fee: 0 }).shipping, 0,
        'and FREE shipping must still read as 0, not as the tier name');
    // The confirmation page's transform emits BOTH: shipping (tier) + shippingCost.
    assert.equal(OT.normalise({ shipping: 'Standard Shipping', shippingCost: 5.5 }).shipping, 5.5);
});

test('the coupon row survives a second normalise (the regression itself)', () => {
    const OT = loadOrderTotals();
    const once = OT.normalise({ discount_amount: 15, loyalty_discount_amount: 5, b2b_discount_amount: 4, coupon_code: 'SAVE10' });
    assert.equal(once.otherDiscount, 6);
    const twice = OT.normalise(once);
    assert.equal(twice.otherDiscount, 6, 'the derived coupon amount must not vanish on re-normalise');
    assert.equal(rowFor(OT.rows(twice), 'coupon').value, '-$6.00');
    assert.equal(rowFor(OT.rows(twice), 'coupon').label, 'Discount (SAVE10)');
});

test('normalise never throws on garbage input', () => {
    const OT = loadOrderTotals();
    for (const bad of [null, undefined, 0, '', 'nope', [], true]) {
        const t = OT.normalise(bad);
        assert.equal(t.total, null);
        assert.equal(OT.rows(t).length >= 4, true, 'still yields the always-on rows');
    }
    assert.equal(OT.rows(null).length >= 4, true);
});
