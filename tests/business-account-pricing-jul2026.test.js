/**
 * Business Account VOLUME pricing (B2B v2) — frontend contract — July 2026
 * ========================================================================
 *
 * WHAT HAPPENED (ERR-139)
 * -----------------------
 * The backend replaced the flat bronze/silver/gold account tiers with a per-line
 * VOLUME discount: the % depends on (the product's price band x the line
 * quantity). Every price field moved from the TOP LEVEL of a pricing item into
 * `quantity_breaks[]`, and `pricing_tier` disappeared from both
 * /api/business/status and the cart's `b2b_discount` block.
 *
 * The v1 frontend did not error. `describeOffer()` read `item.business_price`,
 * got `undefined`, and returned null — which this module's own fail-soft
 * contract renders as "no business discount, show retail". The PDP panel and
 * every card overlay silently stopped existing for every business customer, on
 * every page, with a clean console. The file that warns about
 * absence-read-as-a-healthy-zero was taken out by exactly that.
 *
 * THE RULES THIS FILE EXISTS TO PROTECT
 * -------------------------------------
 * 1. Each rung's `discount_percent` is a CEILING. The backend caps every unit's
 *    discount so it still nets >= 5% after Stripe fees, so on thin-margin items
 *    the realised discount is smaller (`floored:true`). Therefore
 *
 *        retail x (1 - discount_percent)  !=  what checkout charges
 *
 *    Any client-side reconstruction of a business price is a bug that shows a
 *    number the checkout will not honour. These tests ban the arithmetic and pin
 *    the verbatim-render path. `percent` is ALWAYS `effective_percent`.
 *
 * 2. FLOORING PRODUCES DUPLICATE RUNGS, and the handoff does not mention it.
 *    Live, `GDR2025BK` charges $180.79 at BOTH 10+ and 20+, and
 *    `GTN2530XLBK-2PK` charges $271.49 at 5+, 10+ AND 20+. Rendering the ladder
 *    verbatim tells a customer to buy 20 for a price they already had at 10.
 *    `describeLadder()` collapses any rung that is not strictly cheaper than the
 *    one before it, and §1 pins that.
 *
 * 3. AT QUANTITY 1 A BUSINESS ACCOUNT PAYS FULL RETAIL — the entry rung is 3+
 *    across every live band. There is no longer such a thing as "the business
 *    price" of a SKU, only the price at a quantity. Every surface that shows a
 *    business price must show the quantity that unlocks it, and the PDP sticky
 *    buy-bar must track the quantity box rather than being locked once.
 *
 * 4. `missed` is part of getPricing()'s RETURN VALUE. A SKU the server declined
 *    to answer for must never be conflated with a SKU that genuinely has no
 *    ladder — the ERR-063/068/073/110 failure mode. Same reason an unrecognised
 *    payload shape WARNS rather than shrugging.
 *
 * 5. Business prices are per-account: NO localStorage/sessionStorage, and the
 *    in-memory cache is dropped whenever the signed-in user changes.
 *
 * 6. The PDP's #product-price itemprop="price" microdata still carries RETAIL.
 *    A per-account price there would be cloaking and would poison the Merchant
 *    Center feed.
 *
 * 7. Volume pricing and promo coupons are MUTUALLY EXCLUSIVE. `apply` answers
 *    400 B2B_COUPON_EXCLUDED and `preview` answers 200
 *    {valid:false, reason:'b2b_volume_pricing'}. api.js only returns envelopes
 *    for a whitelist of codes — without the branch this file pins, that 400
 *    THROWS and the cart tells the customer "couldn't apply that coupon right
 *    now, please try again" about a code that can never work, while offering
 *    them a different code that also can't.
 *
 * EVERY FIXTURE BELOW WAS CAPTURED LIVE on 2026-07-31 from the production API
 * with a real approved business account (full 1,197-SKU sweep). They are not
 * illustrations from the handoff — on several points the handoff and the live
 * contract disagree, and v1 shipped broken twice by trusting the document.
 *
 * Run: node --test tests/business-account-pricing-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const HTML = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = (rel) => fs.readFileSync(path.join(ROOT, 'css', rel), 'utf8');

/** Strip comments so a literal inside a comment can't satisfy a source assertion. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const BUSINESS_SRC = JS('business.js');
const BUSINESS_CODE = stripComments(BUSINESS_SRC);
const CART_SRC = JS('cart.js');
const CART_CODE = stripComments(CART_SRC);
const CART_PAGE_SRC = JS('cart-page.js');
const CART_PAGE_CODE = stripComments(CART_PAGE_SRC);
const CHECKOUT_SRC = JS('checkout-page.js');
const CHECKOUT_CODE = stripComments(CHECKOUT_SRC);
const API_CODE = stripComments(JS('api.js'));
const PDP_SRC = JS('product-detail-page.js');
const ACCOUNT_CODE = stripComments(JS('account.js'));

// ─────────────────────────────────────────────────────────────────────────────
// Load the Business module so the pure helpers actually EXECUTE.
// business.js declares `const Business = {...}` at top level and only touches
// `window` in a trailing guard, so a minimal context is enough.
//
// Evaluated in THIS realm (not a vm context) so the Arrays/Maps it returns are
// host-native and deepStrictEqual works. `window`/`document` arrive undefined,
// so the trailing browser-only bootstrap block is skipped.
// `auth` and `api` are mutable objects captured by closure — swap their members
// per test to drive the module. `__warnings` collects every DebugLog.warn so a
// test can assert the module was LOUD, not just that it returned null.
// ─────────────────────────────────────────────────────────────────────────────
function loadBusiness() {
    const auth = { initialized: true, user: null, isAuthenticated: () => false, onAuthStateChange() {} };
    const api = { get: async () => ({ ok: false }) };
    const warnings = [];
    const factory = new Function(
        'Auth', 'API', 'Security', 'DebugLog', 'formatPrice', 'window', 'document',
        BUSINESS_SRC + '\nreturn Business;'
    );
    const B = factory(
        auth,
        api,
        { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) },
        { log() {}, warn: (...a) => warnings.push(a.map(String).join(' ')), error() {}, info() {} },
        (n) => '$' + Number(n).toFixed(2),
        undefined,
        undefined
    );
    B.__auth = auth;
    B.__api = api;
    B.__warnings = warnings;
    return B;
}

/** A Business instance already signed in as an approved business account. */
function loadActiveBusiness(pricingResponse) {
    const B = loadBusiness();
    B.__auth.user = { id: 'u-1' };
    B.__auth.isAuthenticated = () => true;
    B.__api.get = async (url) => {
        if (url.indexOf('/api/business/status') === 0) return { ok: true, data: LIVE_STATUS };
        return pricingResponse
            ? { ok: true, data: pricingResponse }
            : { ok: false };
    };
    return B;
}

/**
 * Pull one top-level `function name(...) {...}` out of a source file by
 * brace-matching, then execute just that function. Avoids running all of
 * cart.js (which would need a full DOM).
 */
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must be a top-level function declaration`);
    let depth = 0;
    let i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(i > open, `${name} braces must balance`);
    return src.slice(start, i + 1);
}

/**
 * Slice out the PDP's volume-pricing renderers (renderVolumePricing, _qtyMax,
 * syncVolumePricing). Anchored on the method DECLARATION and on the Value-pack
 * doc comment that follows the block.
 */
function pdpVolumeSource() {
    const start = PDP_SRC.indexOf('async renderVolumePricing(info)');
    assert.notEqual(start, -1, 'renderVolumePricing must exist as a method declaration');
    const end = PDP_SRC.indexOf('* Value-pack upsell', start);
    assert.notEqual(end, -1, 'the Value-pack doc comment must still follow the volume block');
    const slice = PDP_SRC.slice(start, end);
    assert.ok(slice.length > 1000, 'sanity: the volume block was located');
    return slice;
}

function loadCartHelpers() {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(CART_SRC, 'computeDiscountBreakdown') + '\n' +
        extractFunction(CART_SRC, 'businessDiscountLabel') + '\n' +
        ';globalThis.__b = computeDiscountBreakdown; globalThis.__l = businessDiscountLabel;',
        sandbox
    );
    return { computeDiscountBreakdown: sandbox.__b, businessDiscountLabel: sandbox.__l };
}

function loadCouponHelpers() {
    // b2bCouponText() closes over the module-level B2B_COUPON_COPY, so the
    // constant has to come along or the fallback path throws a ReferenceError
    // instead of returning copy.
    const copyLine = CART_PAGE_SRC.match(/^const B2B_COUPON_COPY = .*$/m);
    assert.ok(copyLine, 'the fallback copy must be a module-level const');

    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(
        copyLine[0] + '\n' +
        extractFunction(CART_PAGE_SRC, 'isB2BCouponExcluded') + '\n' +
        extractFunction(CART_PAGE_SRC, 'b2bCouponText') + '\n' +
        ';globalThis.__x = isB2BCouponExcluded; globalThis.__t = b2bCouponText;',
        sandbox
    );
    return { isB2BCouponExcluded: sandbox.__x, b2bCouponText: sandbox.__t };
}

// ═════════════════════════════════════════════════════════════════════════════
// LIVE-CAPTURED FIXTURES — production API, real approved account, 2026-07-31.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/business/status.
 * NOTE WHAT IS GONE: `pricing_tier`. v1 accepted a recognised tier as evidence
 * of an active account; with the field removed, `status` is the only signal —
 * and it is "approved", never "active" (the v1 handoff's prose said "active",
 * which denied pricing to every genuinely approved customer).
 */
const LIVE_STATUS = {
    status: 'approved',
    application: { company_name: 'Home', submitted_at: '2026-04-18T01:20:11.036596+00:00' },
    credit_limit: 0,
    credit_remaining: 0,
    net30_approved: true
};

/** GET /api/business/pricing — a clean, unfloored ladder in the $20–$50 band. */
const LIVE_LADDER_CLEAN = {
    sku: 'CLC431XLY', found: true, is_active: true, retail_price: 34.99,
    quantity_breaks: [
        { min_quantity: 3, discount_percent: 5, business_price: 33.24, effective_percent: 5, savings_amount: 1.75, floored: false },
        { min_quantity: 5, discount_percent: 8, business_price: 32.19, effective_percent: 8, savings_amount: 2.8, floored: false },
        { min_quantity: 10, discount_percent: 11, business_price: 31.14, effective_percent: 11, savings_amount: 3.85, floored: false },
        { min_quantity: 20, discount_percent: 14, business_price: 30.09, effective_percent: 14, savings_amount: 4.9, floored: false }
    ]
};

/**
 * A FLOORED ladder. The 10+ and 20+ rungs are the SAME price ($180.79), the
 * same savings ($11.00) and the same effective 5.7% — the loss floor stopped
 * the ladder at 10 while the API kept emitting the 20+ rung with its unreached
 * 10% ceiling. Rendering both tells the customer to buy 10 more for $0.
 */
const LIVE_LADDER_FLOORED = {
    sku: 'GDR2025BK', found: true, is_active: true, retail_price: 191.79,
    quantity_breaks: [
        { min_quantity: 3, discount_percent: 3, business_price: 186.04, effective_percent: 3, savings_amount: 5.75, floored: false },
        { min_quantity: 5, discount_percent: 5, business_price: 182.2, effective_percent: 5, savings_amount: 9.59, floored: false },
        { min_quantity: 10, discount_percent: 7, business_price: 180.79, effective_percent: 5.7, savings_amount: 11, floored: true },
        { min_quantity: 20, discount_percent: 10, business_price: 180.79, effective_percent: 5.7, savings_amount: 11, floored: true }
    ]
};

/** Floored harder — 5+, 10+ and 20+ are all $271.49, so only TWO rungs survive. */
const LIVE_LADDER_FLOORED_HARD = {
    sku: 'GTN2530XLBK-2PK', found: true, is_active: true, retail_price: 282.99,
    quantity_breaks: [
        { min_quantity: 3, discount_percent: 3, business_price: 274.5, effective_percent: 3, savings_amount: 8.49, floored: false },
        { min_quantity: 5, discount_percent: 5, business_price: 271.49, effective_percent: 4.1, savings_amount: 11.5, floored: true },
        { min_quantity: 10, discount_percent: 7, business_price: 271.49, effective_percent: 4.1, savings_amount: 11.5, floored: true },
        { min_quantity: 20, discount_percent: 10, business_price: 271.49, effective_percent: 4.1, savings_amount: 11.5, floored: true }
    ]
};

/** The cart's one qualifying line: 4 x CTN1070BK, on the 3+ rung at $1.22/unit. */
const LIVE_LADDER_CART_LINE = {
    sku: 'CTN1070BK', found: true, is_active: true, retail_price: 24.49,
    quantity_breaks: [
        { min_quantity: 3, discount_percent: 5, business_price: 23.27, effective_percent: 5, savings_amount: 1.22, floored: false },
        { min_quantity: 5, discount_percent: 8, business_price: 22.53, effective_percent: 8, savings_amount: 1.96, floored: false },
        { min_quantity: 10, discount_percent: 11, business_price: 21.8, effective_percent: 11, savings_amount: 2.69, floored: false },
        { min_quantity: 20, discount_percent: 14, business_price: 21.06, effective_percent: 14, savings_amount: 3.43, floored: false }
    ]
};

/** A SKU that is not in the catalog — a real answer, NOT a miss. */
const LIVE_NOT_FOUND = { sku: 'NOPE-1', found: false };

/**
 * The four live price bands, min/max retail observed across all 1,197 SKUs.
 * Cheaper items discount deeper. Every band's ENTRY RUNG IS 3+ — the handoff's
 * TL;DR says "Buy 5+ / Buy 10+" and its worked example uses percentages that
 * match no live band at all.
 */
const LIVE_BANDS = [
    { ladder: '3:6,5:10,10:14,20:18', min: 5.49, max: 19.99, n: 113 },
    { ladder: '3:5,5:8,10:11,20:14', min: 20.49, max: 49.99, n: 358 },
    { ladder: '3:4,5:6,10:9,20:12', min: 50.79, max: 98.99, n: 206 },
    { ladder: '3:3,5:5,10:7,20:10', min: 100.79, max: 2968.99, n: 520 }
];

/**
 * GET /api/cart for the same account.
 * `summary.b2b_discount` is a bare NUMBER; the metadata OBJECT sits at the
 * RESPONSE top level (the handoff documents it inside `summary`, and reading
 * only that shape rendered b2b = 0 with the row permanently hidden).
 * `summary.discount` INCLUDES the b2b amount — both are 4.88.
 * `pricing_tier` and `discount_percent` are GONE from the block.
 */
const LIVE_CART = {
    b2b_discount: {
        company_name: 'Home',
        effective_percent: 0.7,
        discount_amount: 4.88,
        floored_line_count: 0,
        source: 'volume'
    },
    summary: {
        subtotal: 730.41,
        discount: 4.88,
        coupon_discount: 0,
        b2b_discount: 4.88,          // <- a NUMBER, not the object
        loyalty_discount_amount: 0,
        total: 725.53
    }
};

/** POST /api/cart/coupon/preview for a business account — 200, not an error. */
const LIVE_COUPON_PREVIEW = {
    valid: false,
    reason: 'b2b_volume_pricing',
    message: 'Business accounts receive automatic volume pricing; promo codes can’t be combined.'
};

/** POST /api/cart/coupon for a business account — 400, via api.js's envelope. */
const LIVE_COUPON_APPLY_ERROR = {
    ok: false,
    code: 'B2B_COUPON_EXCLUDED',
    error: 'Business accounts receive automatic volume pricing; promo codes can’t be combined.'
};

/** The RETIRED v1 item shape — a rollback must be loud, not silent. */
const V1_ITEM_SHAPE = {
    sku: 'GDK22225BK', found: true, is_active: true,
    retail_price: 35.79, business_price: 34, tier_percent: 5,
    effective_percent: 5, savings_amount: 1.79, floored: false
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. describeLadder() — the verbatim-render + rung-collapsing contract
// ═════════════════════════════════════════════════════════════════════════════

test('describeLadder: renders every API figure verbatim, never percentage maths', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);

    assert.equal(ladder.retailPrice, 34.99);
    assert.equal(ladder.breaks.length, 4);
    assert.equal(ladder.collapsed, 0);
    assert.equal(ladder.anyFloored, false);

    assert.deepEqual(
        ladder.breaks.map(r => [r.minQuantity, r.businessPrice, r.savings, r.percent]),
        [[3, 33.24, 1.75, 5], [5, 32.19, 2.8, 8], [10, 31.14, 3.85, 11], [20, 30.09, 4.9, 14]]
    );

    // Every price is the API's own. Nothing is retail x (1 - pct).
    for (const rung of ladder.breaks) {
        const src = LIVE_LADDER_CLEAN.quantity_breaks.find(b => b.min_quantity === rung.minQuantity);
        assert.equal(rung.businessPrice, src.business_price);
        assert.equal(rung.savings, src.savings_amount);
    }

    assert.equal(ladder.entry.minQuantity, 3, 'entry rung is the cheapest quantity, not the deepest discount');
    assert.equal(ladder.best.minQuantity, 20);
});

test('describeLadder: COLLAPSES a floored duplicate rung — 10+ and 20+ are the same price', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);

    // The API sent four rungs. The last two charge $180.79 each, so advertising
    // "Buy 20+" would tell the customer to buy ten more units for nothing.
    assert.equal(ladder.breaks.length, 3, 'the duplicate 20+ rung must not be rendered');
    assert.equal(ladder.collapsed, 1);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [3, 5, 10]);
    assert.equal(ladder.best.minQuantity, 10);
    assert.equal(ladder.best.businessPrice, 180.79);
    assert.equal(ladder.anyFloored, true);

    // Strictly decreasing, always.
    for (let i = 1; i < ladder.breaks.length; i++) {
        assert.ok(ladder.breaks[i].businessPrice < ladder.breaks[i - 1].businessPrice,
            'every rendered rung must be strictly cheaper than the one before it');
    }
});

test('describeLadder: three duplicate rungs collapse to one — only TWO breaks survive', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED_HARD);
    assert.equal(ladder.breaks.length, 2);
    assert.equal(ladder.collapsed, 2);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [3, 5]);
    assert.equal(ladder.best.businessPrice, 271.49);
});

test('describeLadder: percent is always effective_percent, never the discount_percent ceiling', () => {
    const B = loadBusiness();
    const floored = B.describeLadder(LIVE_LADDER_FLOORED);
    const rung10 = floored.breaks.find(r => r.minQuantity === 10);

    assert.equal(rung10.percent, 5.7, 'the REALISED percent');
    assert.notEqual(rung10.percent, 7, 'never the ceiling the floor prevented');
    assert.equal(rung10.floored, true);

    // And on an unfloored rung the two are equal anyway, so one rule covers both.
    const clean = loadBusiness().describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(clean.breaks[0].percent, 5);
});

test('describeLadder: null for unfound, inactive, empty ladders and junk — silently, those are legitimate', () => {
    const B = loadBusiness();
    assert.equal(B.describeLadder(LIVE_NOT_FOUND), null);
    assert.equal(B.describeLadder({ sku: 'X', found: true, is_active: false, retail_price: 10, quantity_breaks: [] }), null);
    // An EMPTY quantity_breaks is documented: this band has no volume discount.
    assert.equal(B.describeLadder({ sku: 'X', found: true, is_active: true, retail_price: 10, quantity_breaks: [] }), null);
    assert.equal(B.describeLadder(null), null);
    assert.equal(B.describeLadder('nope'), null);
    assert.equal(B.describeLadder({ sku: 'X', found: true, retail_price: 0, quantity_breaks: [] }), null);
    assert.equal(B.__warnings.length, 0, 'legitimate empties must not spam the console');
});

test('describeLadder: the RETIRED v1 payload shape returns null LOUDLY, not silently', () => {
    const B = loadBusiness();
    assert.equal(B.describeLadder(V1_ITEM_SHAPE), null);
    assert.equal(B.__warnings.length, 1, 'an unrecognised payload must warn');
    const warning = B.__warnings[0];
    assert.match(warning, /GDK22225BK/);
    assert.match(warning, /quantity_breaks is absent/);
    assert.match(warning, /v1 shape/i, 'name the retired shape so the diagnosis is instant');
    assert.match(warning, /NO volume ladder is being shown/,
        'say what the customer is actually losing — this is the failure that shipped');
});

test('describeLadder: drops rungs that are not volume breaks or offer no saving', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder({
        sku: 'X', found: true, is_active: true, retail_price: 20,
        quantity_breaks: [
            { min_quantity: 1, business_price: 19, savings_amount: 1, effective_percent: 5 },   // qty 1 is not a break
            { min_quantity: 5, business_price: 20, savings_amount: 0, effective_percent: 0 },   // at retail
            { min_quantity: 10, business_price: 21, savings_amount: -1 },                        // above retail
            { min_quantity: 20, business_price: 18, savings_amount: 2, effective_percent: 10 }   // the only real one
        ]
    });
    assert.equal(ladder.breaks.length, 1);
    assert.equal(ladder.breaks[0].minQuantity, 20);
});

test('describeLadder: sorts an out-of-order ladder before collapsing it', () => {
    const B = loadBusiness();
    const shuffled = {
        sku: 'X', found: true, is_active: true, retail_price: 34.99,
        quantity_breaks: LIVE_LADDER_CLEAN.quantity_breaks.slice().reverse()
    };
    const ladder = B.describeLadder(shuffled);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [3, 5, 10, 20]);
    assert.equal(ladder.collapsed, 0, 'reordering must not be mistaken for a duplicate');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Quantity resolution — the price is a function of quantity, not of the SKU
// ═════════════════════════════════════════════════════════════════════════════

test('offerAtQuantity: at 1 and 2 a business account pays FULL RETAIL', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(B.offerAtQuantity(ladder, 1), null, 'the entry rung is 3+, so qty 1 gets nothing');
    assert.equal(B.offerAtQuantity(ladder, 2), null);
});

test('offerAtQuantity: every boundary lands on the deepest rung actually reached', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);
    const at = (q) => { const r = B.offerAtQuantity(ladder, q); return r ? r.minQuantity : null; };

    assert.equal(at(3), 3, 'exactly at the break');
    assert.equal(at(4), 3, 'between breaks stays on the lower rung');
    assert.equal(at(5), 5);
    assert.equal(at(9), 5);
    assert.equal(at(10), 10);
    assert.equal(at(19), 10);
    assert.equal(at(20), 20);
    assert.equal(at(1000), 20, 'past the top rung stays on the top rung');
});

test('offerAtQuantity: a collapsed ladder never resolves to a rung that was not rendered', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);
    assert.equal(B.offerAtQuantity(ladder, 25).minQuantity, 10,
        'buying 25 charges the 10+ price, which is what the collapsed chip advertises');
    assert.equal(B.offerAtQuantity(ladder, 25).businessPrice, 180.79);
});

test('offerAtQuantity: junk input yields null rather than a wrong rung', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(B.offerAtQuantity(ladder, NaN), null);
    assert.equal(B.offerAtQuantity(ladder, 'many'), null);
    assert.equal(B.offerAtQuantity(null, 10), null);
    assert.equal(B.offerAtQuantity({}, 10), null);
});

test('nextBreak: tells the shopper exactly how many more units and what it is worth', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);

    const from1 = B.nextBreak(ladder, 1);
    assert.equal(from1.unitsAway, 2);
    assert.equal(from1.quantityAtBreak, 3);
    assert.equal(from1.rung.businessPrice, 33.24);
    assert.equal(from1.lineSavingsAtBreak, 5.25, '1.75 x 3');

    const from4 = B.nextBreak(ladder, 4);
    assert.equal(from4.unitsAway, 1);
    assert.equal(from4.quantityAtBreak, 5);
    assert.equal(from4.lineSavingsAtBreak, 14, '2.80 x 5');

    assert.equal(B.nextBreak(ladder, 20), null, 'already on the deepest rung');
    assert.equal(B.nextBreak(ladder, 500), null);
});

test('nextBreak: on a collapsed ladder the top rung is the COLLAPSED one, so no phantom nudge', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);
    assert.equal(B.nextBreak(ladder, 10), null,
        'never nudge toward 20+ when 20+ charges the same as 10+');
});

test('lineSavings: total saved on a line is the rung savings times the quantity', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CART_LINE);
    assert.equal(B.lineSavings(ladder, 4), 4.88, '1.22 x 4');
    assert.equal(B.lineSavings(ladder, 2), 0, 'below the entry rung there is no saving');
    assert.equal(B.lineSavings(ladder, 0), 0);
});

test('CONSISTENCY GATE: the ladder reproduces the live cart discount to the cent', () => {
    // The cart's b2b_discount.discount_amount is computed by the backend and is
    // AUTHORITATIVE. This proves the frontend's reading of the ladder agrees
    // with what the server actually charged — if the two ever diverge, the
    // "add N more" nudges and the PDP chips are lying about money.
    //
    // Live cart: 6 lines, only CTN1070BK x 4 reaches its entry rung.
    const B = loadBusiness();
    const lines = [
        { ladder: B.describeLadder(LIVE_LADDER_CART_LINE), quantity: 4 },
        { ladder: B.describeLadder(LIVE_LADDER_CLEAN), quantity: 1 }
    ];
    const total = lines.reduce((sum, l) => sum + B.lineSavings(l.ladder, l.quantity), 0);
    assert.equal(Math.round(total * 100) / 100, LIVE_CART.b2b_discount.discount_amount);
    assert.equal(Math.round(total * 100) / 100, 4.88);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. readStatus() — the v2 status shape
// ═════════════════════════════════════════════════════════════════════════════

test('readStatus: the LIVE tier-less payload must still grant business pricing', () => {
    const B = loadBusiness();
    const s = B.readStatus(LIVE_STATUS);
    assert.equal(s.active, true, 'status:"approved" with no pricing_tier is an ACTIVE account');
    assert.equal(s.companyName, 'Home');
    assert.equal(s.net30Approved, true);
    assert.equal(s.creditLimit, 0);
    assert.equal(s.creditRemaining, 0);
    assert.equal('tier' in s, false, 'there is no tier concept left to leak');
});

test('readStatus: an explicit negative always wins, and unapproved applications get retail', () => {
    const B = loadBusiness();
    assert.equal(B.readStatus({ status: 'approved', is_active: false }).active, false);
    assert.equal(B.readStatus({ status: 'pending' }).active, false);
    assert.equal(B.readStatus({ status: 'rejected' }).active, false);
    assert.equal(B.readStatus({ status: 'suspended' }).active, false);
    assert.equal(B.readStatus({}).active, false, 'no signal at all means retail');
    assert.equal(B.readStatus(null).active, false);

    // Every inactive result is fully shaped, so a caller destructuring it can
    // never read undefined and render "undefined" into the panel.
    const off = B.readStatus({ status: 'pending' });
    assert.deepEqual(Object.keys(off).sort(),
        ['active', 'companyName', 'creditLimit', 'creditRemaining', 'net30Approved']);
    assert.equal(off.companyName, null);
});

test('readStatus: an ABSENT credit limit is null, not zero (ERR-063/068)', () => {
    const B = loadBusiness();
    const s = B.readStatus({ status: 'approved', application: { company_name: 'Acme' } });
    assert.equal(s.creditLimit, null, 'not reported is not $0');
    assert.equal(s.creditRemaining, null);
    assert.equal(s.net30Approved, false);
    // But a real zero survives as a real zero.
    assert.equal(B.readStatus({ status: 'approved', credit_limit: 0 }).creditLimit, 0);
    assert.equal(B.readStatus({ status: 'approved', credit_limit: 'junk' }).creditLimit, null);
});

test('readStatus: an inactive result is a COPY — callers cannot poison the shared constant', () => {
    const B = loadBusiness();
    const a = B.readStatus({ status: 'pending' });
    a.active = true;
    assert.equal(B.readStatus({ status: 'pending' }).active, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Network, cache and the fail-soft-LOUDLY contract
// ═════════════════════════════════════════════════════════════════════════════

test('guests never fire a business request', async () => {
    const B = loadBusiness();
    let calls = 0;
    B.__api.get = async () => { calls++; return { ok: true, data: LIVE_STATUS }; };
    const status = await B.getStatus();
    assert.equal(status.active, false);
    assert.equal(calls, 0, 'a guest must not hit /api/business/* on every page');
});

test('getPricing: a failed call reports `missed`, never a silent empty result', async () => {
    const B = loadActiveBusiness(null);
    const { items, missed } = await B.getPricing(['A', 'B']);
    assert.equal(items.size, 0);
    assert.deepEqual(missed, ['A', 'B']);
    assert.ok(B.__warnings.some(w => /pricing unavailable for 2 SKU/.test(w)),
        'a silent miss is the ERR-063 failure mode');
});

test('getPricing: a thrown error also lands in `missed`', async () => {
    const B = loadActiveBusiness(null);
    B.__api.get = async (url) => {
        if (url.indexOf('/api/business/status') === 0) return { ok: true, data: LIVE_STATUS };
        throw new Error('network down');
    };
    const { items, missed } = await B.getPricing(['A']);
    assert.equal(items.size, 0);
    assert.deepEqual(missed, ['A']);
});

test('getPricing: found:false is a real ANSWER, not a miss', async () => {
    const B = loadActiveBusiness({ source: 'volume', items: [LIVE_NOT_FOUND] });
    const { items, missed } = await B.getPricing(['NOPE-1']);
    assert.deepEqual(missed, [], 'the server answered; it just said the SKU does not exist');
    assert.equal(items.get('NOPE-1').found, false);
    assert.equal(B.describeLadder(items.get('NOPE-1')), null);
});

test('getPricing: a SKU the server never answered for is a miss, not a "no discount"', async () => {
    const B = loadActiveBusiness({ source: 'volume', items: [LIVE_LADDER_CLEAN] });
    const { items, missed } = await B.getPricing(['CLC431XLY', 'GHOST']);
    assert.equal(items.size, 1);
    assert.deepEqual(missed, ['GHOST']);
});

test('getPricing: an unexpected `source` warns — the model changing must never be quiet again', async () => {
    const B = loadActiveBusiness({ source: 'b2b_tier', items: [LIVE_LADDER_CLEAN] });
    await B.getPricing(['CLC431XLY']);
    assert.ok(B.__warnings.some(w => /source is "b2b_tier", not "volume"/.test(w)),
        'this is precisely the change that went undetected and killed v1');
});

test('getPricing: 250 SKUs become exactly 3 calls, each within the 100 cap', async () => {
    const B = loadActiveBusiness(null);
    const sizes = [];
    B.__api.get = async (url) => {
        if (url.indexOf('/api/business/status') === 0) return { ok: true, data: LIVE_STATUS };
        const skus = decodeURIComponent(url.split('skus=')[1]).split(',');
        sizes.push(skus.length);
        return { ok: true, data: { source: 'volume', items: skus.map(s => ({ sku: s, found: false })) } };
    };
    const skus = Array.from({ length: 250 }, (_, i) => 'SKU' + i);
    await B.getPricing(skus);
    assert.equal(sizes.length, 3);
    assert.deepEqual(sizes.slice().sort((a, b) => b - a), [100, 100, 50]);
    assert.ok(sizes.every(n => n <= B.MAX_SKUS_PER_CALL));
});

test('getPricing: the second call for the same SKU is served from cache', async () => {
    const B = loadActiveBusiness({ source: 'volume', items: [LIVE_LADDER_CLEAN] });
    let pricingCalls = 0;
    const inner = B.__api.get;
    B.__api.get = async (url) => {
        if (url.indexOf('/api/business/pricing') === 0) pricingCalls++;
        return inner(url);
    };
    await B.getPricing(['CLC431XLY']);
    await B.getPricing(['CLC431XLY']);
    assert.equal(pricingCalls, 1);
});

test('a change of signed-in user throws the price cache away before it can be read', async () => {
    const B = loadActiveBusiness({ source: 'volume', items: [LIVE_LADDER_CLEAN] });
    await B.getPricing(['CLC431XLY']);
    assert.equal(B._priceCache.size, 1);

    B.__auth.user = { id: 'someone-else' };
    B._syncCacheOwner();
    assert.equal(B._priceCache.size, 0, "one shopper's negotiated prices must never reach another");
    assert.equal(B._statusPromise, null);
});

test('business prices are NEVER written to web storage', () => {
    assert.doesNotMatch(BUSINESS_CODE, /localStorage/, 'per-account prices must not persist');
    assert.doesNotMatch(BUSINESS_CODE, /sessionStorage/);
    assert.match(BUSINESS_CODE, /_priceCache\s*:\s*new Map\(\)/, 'the cache is in memory only');
});

test('the cache is dropped on every auth state change', () => {
    assert.match(BUSINESS_CODE, /onAuthStateChange\(\s*\(\)\s*=>\s*this\.reset\(\)\s*\)/);
});

test('`missed` is a declared part of the return value and is documented as such', () => {
    assert.match(BUSINESS_SRC, /@returns \{Promise<\{items: Map<string, object>, missed: Array<string>\}>\}/);
    // The doc comment wraps, so match across the line break rather than pinning
    // one particular wrapping of the sentence.
    assert.match(BUSINESS_SRC, /missed`? is part of[\s\S]{0,40}return value/i);
});

test('business.js documents the ceiling-not-guarantee rule and the duplicate-rung hazard', () => {
    assert.match(BUSINESS_SRC, /CEILING/);
    assert.match(BUSINESS_SRC, /never sell at a loss/i);
    assert.match(BUSINESS_SRC, /DUPLICATE RUNGS/i);
    assert.match(BUSINESS_SRC, /AT QUANTITY 1 A BUSINESS ACCOUNT PAYS FULL RETAIL/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. No surface reconstructs a price from a percentage
// ═════════════════════════════════════════════════════════════════════════════

test('no surface computes a business price from a percentage', () => {
    // `retail x (1 - pct)` / `retail * pct / 100` in any spelling. On a floored
    // item this produces a price checkout refuses to honour.
    const BANNED = [
        /retail[A-Za-z_]*\s*\*\s*\(\s*1\s*-/i,
        /\*\s*\(\s*1\s*-\s*[A-Za-z_.]*(percent|pct|tier)/i,
        /(percent|pct|tier)[A-Za-z_]*\s*\/\s*100\s*\*/i,
        /\*\s*[A-Za-z_.]*(percent|pct)[A-Za-z_]*\s*\/\s*100/i
    ];
    for (const src of [BUSINESS_CODE, stripComments(PDP_SRC), CART_CODE, stripComments(JS('products.js'))]) {
        for (const re of BANNED) {
            assert.doesNotMatch(src, re, `banned business-price arithmetic: ${re}`);
        }
    }
});

test('discount_percent (the ceiling) is never read by a render path', () => {
    // business.js is the ONE interpreter of the ladder, and it reads
    // effective_percent. `discount_percent` appearing anywhere in executable
    // frontend code would mean a surface is about to advertise a ceiling.
    assert.doesNotMatch(BUSINESS_CODE, /discount_percent/,
        'the ceiling has no render use; effective_percent is what landed');
    assert.match(BUSINESS_CODE, /effective_percent/);
});

test('the pricing tier is gone from every executable line in the storefront', () => {
    const files = [
        'business.js', 'cart.js', 'cart-page.js', 'checkout-page.js',
        'account.js', 'order-totals.js', 'payment-page.js',
        'order-confirmation-page.js', 'product-detail-page.js', 'products.js'
    ];
    for (const f of files) {
        const code = stripComments(JS(f));
        assert.doesNotMatch(code, /pricing_tier/, `${f} still reads pricing_tier`);
        assert.doesNotMatch(code, /tier_percent/, `${f} still reads tier_percent`);
        assert.doesNotMatch(code, /Business\.tierLabel/, `${f} still calls the removed tierLabel`);
        assert.doesNotMatch(code, /Business\.describeOffer/, `${f} still calls the removed describeOffer`);
    }
    assert.doesNotMatch(BUSINESS_CODE, /\bTIERS\b/);
    assert.doesNotMatch(BUSINESS_CODE, /tierLabel/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Cart summary — shapes, label and the shared renderer
// ═════════════════════════════════════════════════════════════════════════════

test('computeDiscountBreakdown: LIVE shape — number in summary, object at top level', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const r = computeDiscountBreakdown(LIVE_CART.summary, LIVE_CART.summary.discount, LIVE_CART.b2b_discount);

    assert.equal(r.b2b, 4.88, 'reading only the documented shape rendered 0 and hid the row');
    assert.equal(r.loyalty, 0);
    assert.equal(r.other, 0, 'summary.discount INCLUDES the b2b amount — it must be netted out');
    assert.equal(r.b2bMeta.source, 'volume');
    assert.equal(r.b2bMeta.company_name, 'Home');
});

test('computeDiscountBreakdown: still reads the object if the backend moves it into summary', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const r = computeDiscountBreakdown(
        Object.assign({}, LIVE_CART.summary, { b2b_discount: LIVE_CART.b2b_discount }), 4.88);
    assert.equal(r.b2b, 4.88);
    assert.equal(r.b2bMeta.source, 'volume');
});

test('computeDiscountBreakdown: b2b and loyalty are both netted out of "You Save"', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const r = computeDiscountBreakdown(
        { discount: 30, loyalty_discount_amount: 10, b2b_discount: 15 }, 30);
    assert.equal(r.b2b, 15);
    assert.equal(r.loyalty, 10);
    assert.equal(r.other, 5, 'the same dollars must never be shown twice');
});

test('businessDiscountLabel: names the COMPANY and never a percentage', () => {
    const { businessDiscountLabel } = loadCartHelpers();
    assert.equal(businessDiscountLabel(LIVE_CART.b2b_discount), 'Business account — Home');
    assert.equal(businessDiscountLabel({ company_name: '  Acme Print Co  ' }), 'Business account — Acme Print Co');
    assert.equal(businessDiscountLabel({}), 'Business account');
    assert.equal(businessDiscountLabel(null), 'Business account');
    assert.equal(businessDiscountLabel({ company_name: 123 }), 'Business account');

    // effective_percent is the realised rate over the WHOLE cart (0.7% live on a
    // cart whose one qualifying line got 5%), so it must not ride in this label.
    assert.doesNotMatch(businessDiscountLabel(LIVE_CART.b2b_discount), /%/);
});

test('the cart b2b note frames effective_percent as a cart-wide average, never a rate', () => {
    assert.match(CART_SRC, /across your cart/,
        'an unqualified "you saved 0.7%" reads as the customer\'s discount rate and is wrong');
    assert.doesNotMatch(CART_CODE, /You saved \$\{/);
});

test('BOTH cart summary renderers go through the one shared discount helper', () => {
    // They had drifted once (only the surgical path rendered the loyalty row).
    const calls = CART_CODE.match(/this\._renderDiscountRows\(/g) || [];
    assert.equal(calls.length, 2, `expected exactly the two call sites, saw ${calls.length}`);
    assert.match(CART_CODE, /_renderDiscountRows:\s*function/);
});

test('cart lines carry the SKU and quantity the volume nudge needs', () => {
    // The line markup is built by string concatenation, so the attributes are
    // separated by quote characters — match across them.
    assert.match(CART_CODE, /class="cart-item"[\s\S]{0,260}data-sku=/,
        'the nudge decorator finds lines by SKU');
    assert.match(CART_CODE, /class="cart-item"[\s\S]{0,320}data-quantity=/);
    // And the surgical quantity path repaints it — the drift that bit the
    // loyalty row must not repeat for the nudge.
    assert.match(CART_CODE, /setAttribute\('data-quantity'/);
});

test('the volume nudge is decorated on BOTH the full paint and the quantity change', () => {
    const calls = CART_CODE.match(/this\.decorateVolumeNudges\(/g) || [];
    assert.equal(calls.length, 2,
        `the full paint and the surgical quantity path must both repaint, saw ${calls.length}`);
    assert.match(CART_CODE, /decorateVolumeNudges:\s*function/);
});

test('nudgeMarkup: states the units, the unit price and the line total, and escapes everything', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CART_LINE);
    const html = B.nudgeMarkup(ladder, 4, 100);
    assert.match(html, /Add 1 more to reach 5\+/);
    assert.match(html, /\$22\.53 each/);
    assert.match(html, /saving \$9\.80 on this line/, '1.96 x 5');
    assert.match(html, /data-break-quantity="5"/);

    assert.equal(B.nudgeMarkup(ladder, 20, 100), '', 'no nudge on the deepest rung');
    assert.equal(B.nudgeMarkup(ladder, 4, 4), '',
        'a break beyond the line quantity cap must not be offered');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. PDP — the ladder, the microdata, and the quantity-reactive buy bar
// ═════════════════════════════════════════════════════════════════════════════

test('PDP: the volume ladder renders and is wired into renderProduct', () => {
    const src = pdpVolumeSource();
    assert.match(stripComments(PDP_SRC), /this\.renderVolumePricing\(info\)/,
        'renderProduct must call it');
    assert.match(src, /Business\.getLadderFor\(sku\)/);
    assert.match(src, /volume-pricing__chip/);
    assert.match(src, /section\.hidden = false/);

    const html = HTML('html/product/index.html');
    assert.match(html, /id="volume-pricing"[^>]*hidden/,
        'the section must ship hidden — guests and retail shoppers never see it');
    assert.match(html, /data-testid="volume-pricing"/);
});

test('PDP: the ladder sits OUTSIDE the buy-box <dl> that carries the microdata', () => {
    const html = HTML('html/product/index.html');
    const dlStart = html.indexOf('<dl class="buy-box"');
    const dlEnd = html.indexOf('</dl>', dlStart);
    const section = html.indexOf('id="volume-pricing"');
    assert.ok(dlStart !== -1 && section !== -1);
    assert.ok(section > dlEnd, 'a per-account price inside the offers microdata is cloaking');
});

test('PDP: itemprop="price" microdata still carries RETAIL, not a business price', () => {
    const code = stripComments(PDP_SRC);
    // Comments stripped: the volume block DISCUSSES #product-price at length
    // (explaining why it is left alone), it just must never write to it.
    const src = stripComments(pdpVolumeSource());
    assert.doesNotMatch(src, /product-price/,
        'the volume renderer must never touch the microdata element');
    assert.doesNotMatch(src, /setAttribute\(\s*['"]content['"]/);
    assert.match(code, /getElementById\('product-price'\)/,
        'sanity: the retail element still exists and is still written by the retail path');
    assert.match(HTML('html/product/index.html'), /id="product-price"[^>]*itemprop="price"/);
});

test('PDP: the sticky buy-bar tracks the QUANTITY, it is not locked to one price', () => {
    const src = pdpVolumeSource();
    // The bar must show what this add-to-cart will actually charge: the rung's
    // unit price when one applies, retail when the quantity is below the entry.
    assert.match(src, /offerAtQuantity/);
    assert.match(src, /rung \? rung\.businessPrice : ladder\.retailPrice/,
        'below the entry rung the sticky price is RETAIL, because that is what is charged');
    assert.match(src, /businessLocked = '1'/, 'the generic mirror must still be held off');

    // And the quantity controls repaint it.
    const code = stripComments(PDP_SRC);
    assert.match(code, /onQtyChanged\s*=\s*\(\)\s*=>\s*this\.syncVolumePricing\(\)/);
    const wired = code.match(/onQtyChanged\(\);/g) || [];
    assert.equal(wired.length, 3, 'decrease, increase and change must all repaint the ladder');
});

test('PDP: a break beyond the quantity cap is shown but NOT tappable', () => {
    const src = pdpVolumeSource();
    assert.match(src, /reachable\s*=\s*rung\.minQuantity <= maxQty/);
    assert.match(src, /aria-disabled="true"/);
    assert.match(src, /_qtyMax/, 'the cap is read from the box, never duplicated as a literal');
});

test('PDP: stale-navigation guard — never paint a ladder for a product you left', () => {
    assert.match(pdpVolumeSource(), /this\.product\.sku !== sku\) return/);
});

test('PDP: every value interpolated into HTML is escaped', () => {
    // Only the markup-building half of the block can inject; the live status
    // line is written with textContent and is covered by the next test.
    const src = stripComments(pdpVolumeSource());
    const htmlPart = src.slice(0, src.indexOf('section.hidden = false'));
    assert.ok(htmlPart.length > 400, 'sanity: the markup half was located');

    const interpolations = htmlPart.match(/\$\{[^}]*\}/g) || [];
    assert.ok(interpolations.length >= 3, 'sanity: there are interpolations to check');
    for (const expr of interpolations) {
        assert.match(expr,
            // Escaped; or an integer this module derived itself (a break
            // quantity); or the chip string it just built; or a choice between
            // two hard-coded tag-name literals.
            /Security\.escapeHtml|Security\.escapeAttr|^\$\{rung\.minQuantity\}$|^\$\{chips\}$|^\$\{reachable \? 'button' : 'span'\}$/,
            `unescaped interpolation in the volume ladder markup: ${expr}`);
    }
});

test('PDP: the live status line is written with textContent, never innerHTML', () => {
    const src = stripComments(pdpVolumeSource());
    const sync = src.slice(src.indexOf('syncVolumePricing()'));
    assert.match(sync, /status\.textContent = parts\.join/);
    assert.doesNotMatch(sync, /status\.innerHTML/);
    assert.doesNotMatch(sync, /insertAdjacentHTML/);
});

test('PDP: the floored explainer never advertises the ceiling it did not reach', () => {
    const src = pdpVolumeSource();
    assert.match(src, /ladder\.anyFloored/);
    assert.match(src, /lowest we can go/i);
    assert.doesNotMatch(src, /discount_percent/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Card grids — every surface that shows a price shows the ladder
// ═════════════════════════════════════════════════════════════════════════════

test('cardMarkup: the quantity is part of the claim — never a bare "business price"', () => {
    const B = loadBusiness();
    const html = B.cardMarkup(B.describeLadder(LIVE_LADDER_CLEAN));
    assert.match(html, /Business bulk price/);
    assert.match(html, /\$33\.24/, 'the ENTRY rung — the achievable one');
    assert.match(html, / ea/);
    assert.match(html, /Buy 3\+/, 'a price with no quantity beside it is a lie at qty 1');
    assert.match(html, /down to \$30\.09 at 20\+/);
    assert.match(html, /data-testid="business-card-price"/);
});

test('cardMarkup: a single-rung ladder does not claim a second, better price', () => {
    const B = loadBusiness();
    const one = B.describeLadder({
        sku: 'X', found: true, is_active: true, retail_price: 20,
        quantity_breaks: [{ min_quantity: 3, business_price: 19, savings_amount: 1, effective_percent: 5 }]
    });
    const html = B.cardMarkup(one);
    assert.match(html, /Buy 3\+/);
    assert.doesNotMatch(html, /down to/);
});

test('every grid that renders product cards invokes the bulk overlay', () => {
    const grids = {
        'products.js': /decorateBusinessPricing\(/,
        'shop-page.js': /Business\.decorateCards\(/,
        'filters.js': /decorateBusinessPricing\(/,
        'ribbons-page.js': /Business\.decorateCards\(/,
        'favourites.js': /Business\.decorateCards\(/,
        'landing.js': /Business\.decorateCards\(/
    };
    for (const [file, re] of Object.entries(grids)) {
        assert.match(stripComments(JS(file)), re,
            `${file} paints product cards but never decorates them — a business ` +
            'customer would see volume pricing on some pages and not others');
    }
});

test('every card renderer emits the data-sku the overlay finds cards by', () => {
    for (const file of ['products.js', 'shop-page.js', 'ribbons-page.js', 'favourites.js', 'landing.js']) {
        assert.match(stripComments(JS(file)), /data-sku|dataset\.sku/, `${file} emits no SKU`);
    }
});

test('the overlay resolves its target by ORDERED lookup, not one comma-joined selector', () => {
    // querySelector('a, b') returns the first match in DOCUMENT order across the
    // whole list, so a wrapper would beat the price block nested inside it.
    assert.match(BUSINESS_CODE, /PRICE_BLOCK_SELECTORS\s*:\s*\[/);
    assert.match(BUSINESS_CODE, /for \(const sel of this\.PRICE_BLOCK_SELECTORS\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Coupons are mutually exclusive with volume pricing
// ═════════════════════════════════════════════════════════════════════════════

test('api.js RETURNS an envelope for B2B_COUPON_EXCLUDED instead of throwing', () => {
    // Without this branch a plain 400 throws, and the cart's generic catch says
    // "Couldn't apply that coupon right now. Please try again." about a code
    // that can never work — while offering a different code that also can't.
    assert.match(API_CODE, /errorCode === 'B2B_COUPON_EXCLUDED'/);
    const branch = API_CODE.slice(API_CODE.indexOf("errorCode === 'B2B_COUPON_EXCLUDED'"));
    assert.match(branch.slice(0, 200), /return withRid\(\{ ok: false, error: errorMsg, code: errorCode \}\)/);
});

test('isB2BCouponExcluded recognises BOTH channels the backend answers on', () => {
    const { isB2BCouponExcluded } = loadCouponHelpers();

    assert.equal(isB2BCouponExcluded(LIVE_COUPON_APPLY_ERROR), true, 'apply: 400 envelope');
    assert.equal(isB2BCouponExcluded(LIVE_COUPON_PREVIEW), true, 'preview: 200 reason');
    assert.equal(isB2BCouponExcluded({ data: LIVE_COUPON_PREVIEW }), true, 'preview wrapped in data');
    assert.equal(isB2BCouponExcluded(Object.assign(new Error('x'), { code: 'B2B_COUPON_EXCLUDED' })), true,
        'the throw path must still be recognised');

    assert.equal(isB2BCouponExcluded({ code: 'COUPON_LOCKED' }), false);
    assert.equal(isB2BCouponExcluded({ reason: 'expired' }), false);
    assert.equal(isB2BCouponExcluded(null), false);
    assert.equal(isB2BCouponExcluded(undefined), false);
});

test('b2bCouponText prefers the backend wording and always has a fallback', () => {
    const { b2bCouponText } = loadCouponHelpers();
    assert.match(b2bCouponText(LIVE_COUPON_PREVIEW), /automatic volume pricing/);
    assert.match(b2bCouponText(LIVE_COUPON_APPLY_ERROR), /automatic volume pricing/);
    assert.match(b2bCouponText(null), /volume pricing/);
    assert.match(b2bCouponText({}), /loyalty points still work/i,
        'say what DOES still work, or the message is pure denial');
    assert.match(b2bCouponText({ message: '   ' }), /volume pricing/, 'blank is not a message');
});

test('the exclusion NEVER routes through the suggestion nudge, on any of the three paths', () => {
    // setFailure/setFailureHint attach a CouponSuggestion. Offering a business
    // customer a different code spends one of their limited attempts against an
    // endpoint that locks out, on a code that also cannot be combined.
    for (const [file, code] of [['cart-page.js', CART_PAGE_CODE], ['checkout-page.js', CHECKOUT_CODE]]) {
        const hits = code.match(/isB2BCouponExcluded\([^)]*\)/g) || [];
        assert.ok(hits.length >= 3,
            `${file} must handle the exclusion on preview, apply-response AND apply-throw, saw ${hits.length}`);
        // No B2B branch may call the suggestion renderer.
        const bad = /isB2BCouponExcluded\([^)]*\)\)\s*\{[^}]*setFailure/;
        assert.doesNotMatch(code, bad, `${file} attaches a suggestion to the exclusion`);
    }
});

test('the coupon field is disabled up front for a business account, on both pages', () => {
    assert.match(CART_PAGE_CODE, /function initBusinessCouponLock/);
    assert.match(CART_PAGE_CODE, /initBusinessCouponLock\(\);/, 'and it is actually called');
    assert.match(CART_PAGE_CODE, /b2bLocked/);
    assert.match(CART_PAGE_CODE, /const locked = pointsOn \|\| b2bLocked/,
        'the B2B lock ORs with the points lock and never lifts');

    assert.match(CHECKOUT_CODE, /lockCouponForBusinessAccount/);
    assert.match(CHECKOUT_CODE, /this\.lockCouponForBusinessAccount\(couponInput, couponBtn\)/);

    assert.match(HTML('html/cart.html'), /id="cart-coupon-blocked"[^>]*hidden/,
        'the explanation ships hidden and is unhidden only for a business account');
});

test('a failed status check must NOT lock a retail customer out of coupons', () => {
    // Anchor on the DEFINITION, not the first mention — the call site comes
    // first in cart-page.js and would slice the wrong body.
    const bodies = [
        CART_PAGE_CODE.slice(CART_PAGE_CODE.indexOf('async function initBusinessCouponLock')),
        CHECKOUT_CODE.slice(CHECKOUT_CODE.indexOf('async lockCouponForBusinessAccount('))
    ];
    for (const body of bodies) {
        assert.ok(body, 'the lock must exist');
        const head = body.slice(0, 800);
        assert.match(head, /catch[\s\S]{0,140}return;/,
            'an unreachable /api/business/status must fail OPEN for coupons');
        assert.match(head, /if \(!active\) return;/);
    }
});

test('LOYALTY POINTS ARE NOT BLOCKED — only coupons are', () => {
    const lock = CART_PAGE_SRC.slice(CART_PAGE_SRC.indexOf('async function initBusinessCouponLock'));
    const body = stripComments(lock.slice(0, lock.indexOf('\n}') + 2));

    // The lock may SAY that points still work — that is the whole point of the
    // copy. It must not TOUCH a points control.
    assert.doesNotMatch(body, /cart-loyalty/, 'the lock must not reach into the loyalty control');
    assert.doesNotMatch(body, /loyalty[A-Za-z]*\.disabled/i);
    assert.doesNotMatch(body, /applyLoyalty|removeLoyalty|renderCartLoyalty/);
    assert.match(body, /loyalty points still work/i, 'and it must say what DOES still work');
});

test('the ?coupon= recovery link does not reopen a dead field for a business account', () => {
    const auto = CART_PAGE_CODE.slice(CART_PAGE_CODE.indexOf('async function autoApplyCouponFromUrl'));
    const body = auto.slice(0, 2600);
    assert.match(body, /isB2BCouponExcluded\(res\)/);
    assert.match(body, /isB2BCouponExcluded\(err\)/);
    // The B2B branches must not call revealCouponForRetry.
    const b2bBranch = body.slice(body.indexOf('isB2BCouponExcluded(res)'));
    const untilNextElse = b2bBranch.slice(0, b2bBranch.indexOf('} else {'));
    assert.doesNotMatch(untilNextElse, /revealCouponForRetry/,
        'prefilling a disabled field under a toast that just explained the rule invites an argument with it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Account dashboard
// ═════════════════════════════════════════════════════════════════════════════

test('account dashboard: the panel is gated on an active account and names the COMPANY', () => {
    assert.match(ACCOUNT_CODE, /if \(!status\.active\) return;/);
    assert.match(ACCOUNT_CODE, /status\.companyName/);
    assert.match(ACCOUNT_CODE, /panel\.hidden = false/);

    const html = HTML('html/account/index.html');
    assert.match(html, /id="dash-business-panel"[^>]*hidden/);
    assert.match(html, /id="dash-business-company"/);
    assert.doesNotMatch(html, /dash-business-tier/, 'there is no tier to name any more');
    assert.doesNotMatch(html, /tier rate/, 'the old copy promised a rate that no longer exists');
});

test('account dashboard: an absent credit limit renders NOTHING, not $0', () => {
    assert.match(ACCOUNT_CODE, /status\.creditLimit != null && status\.creditLimit > 0/);
    const html = HTML('html/account/index.html');
    assert.match(html, /id="dash-business-credit"[^>]*hidden/);
    assert.match(html, /id="dash-business-net30"[^>]*hidden/);
});

test('account dashboard: no percentage is promised on the panel', () => {
    const html = HTML('html/account/index.html');
    const panel = html.slice(html.indexOf('id="dash-business-panel"'), html.indexOf('</section>', html.indexOf('id="dash-business-panel"')));
    assert.doesNotMatch(panel, /\d+\s*%/, 'the rate varies by band and quantity; any single number contradicts a PDP');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Styling
// ═════════════════════════════════════════════════════════════════════════════

test('CSS: every volume surface is styled and hides cleanly', () => {
    const css = CSS('pages.css');
    for (const sel of [
        '.volume-pricing', '.volume-pricing[hidden]', '.volume-pricing__chips',
        '.volume-pricing__chip', '.volume-pricing__chip--active', '.volume-pricing__status',
        '.volume-pricing__note', '.product-card__biz-price', '.product-card__biz-unit',
        '.cart-item__volume-nudge', '.business-panel__company', '.business-panel__facts',
        '.cart-coupon__blocked'
    ]) {
        assert.ok(css.includes(sel), `missing style: ${sel}`);
    }
    assert.doesNotMatch(css, /\.business-price__/, 'the v1 PDP panel styles are dead weight');
    assert.doesNotMatch(css, /\.business-panel__tier/);
});

test('CSS: the chips meet the 48px tap target and scroll rather than wrap', () => {
    const css = CSS('pages.css');
    const block = css.slice(css.indexOf('.volume-pricing__chip {'), css.indexOf('.volume-pricing__chip-qty'));
    assert.match(block, /min-height:\s*var\(--tap-min/);
    const chips = css.slice(css.indexOf('.volume-pricing__chips {'), css.indexOf('.volume-pricing__chip {'));
    assert.match(chips, /overflow-x:\s*auto/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. LIVE contract check — opt-in, so the suite stays offline-safe
//     Run with: LIVE_API=1 BUSINESS_TOKEN=<jwt> node --test tests/business-account-pricing-jul2026.test.js
// ═════════════════════════════════════════════════════════════════════════════

const LIVE = process.env.LIVE_API === '1' && !!process.env.BUSINESS_TOKEN;

test('LIVE: the backend still sends the volume shape these fixtures assume',
    { skip: !LIVE && 'set LIVE_API=1 and BUSINESS_TOKEN to run' }, async () => {
        const base = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
        const headers = { Authorization: 'Bearer ' + process.env.BUSINESS_TOKEN };

        const status = await (await fetch(base + '/api/business/status', { headers })).json();
        assert.equal(status.ok, true);
        assert.ok(['approved', 'active'].includes(status.data.status));
        assert.equal('pricing_tier' in status.data, false, 'the tier must stay gone');

        const priced = await (await fetch(
            base + '/api/business/pricing?skus=CLC431XLY,NOPE-1', { headers })).json();
        assert.equal(priced.data.source, 'volume');
        const item = priced.data.items.find(i => i.sku === 'CLC431XLY');
        assert.ok(Array.isArray(item.quantity_breaks) && item.quantity_breaks.length);
        for (const b of item.quantity_breaks) {
            for (const key of ['min_quantity', 'business_price', 'effective_percent', 'savings_amount']) {
                assert.ok(typeof b[key] === 'number', `quantity_breaks[].${key} must be a number`);
            }
        }
        assert.equal(item.quantity_breaks[0].min_quantity, 3, 'the entry rung is 3+, not the doc’s 5+');
        assert.equal(priced.data.items.find(i => i.sku === 'NOPE-1').found, false);
    });

test('the four live price bands are recorded so a re-band is a visible diff', () => {
    // Not an assertion about the backend — a written record of what was swept on
    // 2026-07-31 (1,197 SKUs, 8 floored, 0 empty ladders, 0 unanswered), so the
    // next person can tell "the bands changed" from "my code broke".
    assert.equal(LIVE_BANDS.length, 4);
    assert.equal(LIVE_BANDS.reduce((n, b) => n + b.n, 0), 1197);
    for (const band of LIVE_BANDS) {
        assert.match(band.ladder, /^3:\d+,5:\d+,10:\d+,20:\d+$/, 'every band starts at 3+');
    }
});
