/**
 * Business Account VOLUME pricing (B2B v2) — frontend contract
 * ============================================================
 * Written July 2026 (ERR-139). Re-banded 2026-08-02 (ERR-140) — the MECHANISM
 * below is unchanged; only the matrix moved. See §12 for the recorded bands.
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
 * 2. FLOORING PRODUCES DUPLICATE RUNGS, and no handoff has ever mentioned it.
 *    Live, `GDR2025BK` charges $180.79 at BOTH 6+ and 7+, and `GW213CMY`
 *    charges $1,124.49 at 3+, 5+ AND 6+. Rendering the ladder verbatim tells a
 *    customer to buy three more units for a price they already had.
 *    `describeLadder()` collapses any rung that is not strictly cheaper than the
 *    one before it, and §1 pins that. The Aug-2026 re-band made this MORE
 *    common, not less: 39 SKUs floor (was 8), and the deepest two rungs are now
 *    a single unit apart in every band.
 *
 * 3. AT QUANTITY 1 A BUSINESS ACCOUNT PAYS FULL RETAIL. The entry rung is 2+ in
 *    the three $100+ bands and 3+ in the three below — never 1. There is no such
 *    thing as "the business price" of a SKU, only the price at a quantity. Every
 *    surface that shows a business price must show the quantity that unlocks it,
 *    and the PDP sticky buy-bar must track the quantity box rather than being
 *    locked once.
 *
 * 3b. A LADDER CAN FLOOR AWAY ENTIRELY. 13 live SKUs come back with all four
 *    rungs priced AT retail (`effective_percent: 0`, `savings_amount: 0`).
 *    `describeLadder()` drops every rung and returns null, so they render plain
 *    retail with no B2B surface at all — correct, and silent, because it is a
 *    real answer rather than a broken payload. §1 pins that it stays silent.
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
 * EVERY FIXTURE BELOW WAS CAPTURED LIVE on 2026-08-02 from the production API
 * with a real approved business account (full 4,015-SKU sweep). They are not
 * illustrations from the handoff — the v1 handoff was wrong about the status
 * value AND the entry rung, and v1 shipped broken twice by trusting the
 * document. Re-capture them with `npm run sweep:b2b`, which prints the fixtures
 * and the LIVE_BANDS literal below ready to paste.
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
// LIVE-CAPTURED FIXTURES — production API, real approved account, 2026-08-02.
// Re-capture with `npm run sweep:b2b`.
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
        { min_quantity: 3, discount_percent: 3, business_price: 33.94, effective_percent: 3, savings_amount: 1.05, floored: false },
        { min_quantity: 4, discount_percent: 4, business_price: 33.59, effective_percent: 4, savings_amount: 1.4, floored: false },
        { min_quantity: 7, discount_percent: 7, business_price: 32.54, effective_percent: 7, savings_amount: 2.45, floored: false },
        { min_quantity: 8, discount_percent: 9, business_price: 31.84, effective_percent: 9, savings_amount: 3.15, floored: false }
    ]
};

/**
 * A clean ladder in the $100–$300 band, where the ENTRY RUNG IS 2+.
 * The three $100+ bands start discounting one unit earlier than the three below
 * them, so "the entry rung is 3+" — true of every band before Aug 2026 and
 * still written into three code comments — is now false for 2,261 of 4,015 SKUs.
 * Qty 1 is still full retail everywhere, which is the claim that matters.
 */
const LIVE_LADDER_ENTRY_TWO = {
    sku: 'C126ACMY', found: true, is_active: true, retail_price: 110.99,
    quantity_breaks: [
        { min_quantity: 2, discount_percent: 2, business_price: 108.77, effective_percent: 2, savings_amount: 2.22, floored: false },
        { min_quantity: 3, discount_percent: 3, business_price: 107.66, effective_percent: 3, savings_amount: 3.33, floored: false },
        { min_quantity: 6, discount_percent: 6, business_price: 104.33, effective_percent: 6, savings_amount: 6.66, floored: false },
        { min_quantity: 7, discount_percent: 8, business_price: 102.11, effective_percent: 8, savings_amount: 8.88, floored: false }
    ]
};

/**
 * The $500+ band, whose entry rung discounts by a FRACTIONAL half a percent.
 * 722 SKUs sit here. `formatPercent` must render "0.5%" — a Math.round-style
 * tidy-up would turn the entry rung into "0%" (a rung advertising nothing) or
 * "1%" (a number the checkout will not honour).
 */
const LIVE_LADDER_TOP_BAND = {
    sku: 'C206XKCMY', found: true, is_active: true, retail_price: 520.49,
    quantity_breaks: [
        { min_quantity: 2, discount_percent: 0.5, business_price: 517.89, effective_percent: 0.5, savings_amount: 2.6, floored: false },
        { min_quantity: 3, discount_percent: 1, business_price: 515.29, effective_percent: 1, savings_amount: 5.2, floored: false },
        { min_quantity: 5, discount_percent: 3, business_price: 504.88, effective_percent: 3, savings_amount: 15.61, floored: false },
        { min_quantity: 6, discount_percent: 5, business_price: 494.47, effective_percent: 5, savings_amount: 26.02, floored: false }
    ]
};

/**
 * A FLOORED ladder. The 6+ and 7+ rungs are the SAME price ($180.79), the same
 * savings ($11.00) and the same effective 5.7% — the loss floor stopped the
 * ladder at 6 while the API kept emitting the 7+ rung with its unreached 8%
 * ceiling. Rendering both tells the customer to buy one more unit for $0.
 */
const LIVE_LADDER_FLOORED = {
    sku: 'GDR2025BK', found: true, is_active: true, retail_price: 191.79,
    quantity_breaks: [
        { min_quantity: 2, discount_percent: 2, business_price: 187.95, effective_percent: 2, savings_amount: 3.84, floored: false },
        { min_quantity: 3, discount_percent: 3, business_price: 186.04, effective_percent: 3, savings_amount: 5.75, floored: false },
        { min_quantity: 6, discount_percent: 6, business_price: 180.79, effective_percent: 5.7, savings_amount: 11, floored: true },
        { min_quantity: 7, discount_percent: 8, business_price: 180.79, effective_percent: 5.7, savings_amount: 11, floored: true }
    ]
};

/** Floored harder — 3+, 5+ and 6+ are all $1,124.49, so only TWO rungs survive. */
const LIVE_LADDER_FLOORED_HARD = {
    sku: 'GW213CMY', found: true, is_active: true, retail_price: 1133.99,
    quantity_breaks: [
        { min_quantity: 2, discount_percent: 0.5, business_price: 1128.32, effective_percent: 0.5, savings_amount: 5.67, floored: false },
        { min_quantity: 3, discount_percent: 1, business_price: 1124.49, effective_percent: 0.8, savings_amount: 9.5, floored: true },
        { min_quantity: 5, discount_percent: 3, business_price: 1124.49, effective_percent: 0.8, savings_amount: 9.5, floored: true },
        { min_quantity: 6, discount_percent: 5, business_price: 1124.49, effective_percent: 0.8, savings_amount: 9.5, floored: true }
    ]
};

/**
 * FLOORED ALL THE WAY TO NOTHING — 13 live SKUs look like this. Every rung is
 * priced AT retail with `effective_percent: 0` and `savings_amount: 0`, because
 * the item is already so close to cost that no rung clears the 5% net floor.
 * `describeLadder()` must drop all four and return null, so the product renders
 * plain retail with no B2B surface — and must do it SILENTLY, because this is a
 * real answer, not the unrecognised-payload case that has to warn.
 */
const LIVE_LADDER_ALL_FLOORED = {
    sku: 'GCE74KCMY', found: true, is_active: true, retail_price: 2502.99,
    quantity_breaks: [
        { min_quantity: 2, discount_percent: 0.5, business_price: 2502.99, effective_percent: 0, savings_amount: 0, floored: true },
        { min_quantity: 3, discount_percent: 1, business_price: 2502.99, effective_percent: 0, savings_amount: 0, floored: true },
        { min_quantity: 5, discount_percent: 3, business_price: 2502.99, effective_percent: 0, savings_amount: 0, floored: true },
        { min_quantity: 6, discount_percent: 5, business_price: 2502.99, effective_percent: 0, savings_amount: 0, floored: true }
    ]
};

/** The cart's one qualifying line: 4 x CTN1070BK, on the 4+ rung at $0.98/unit. */
const LIVE_LADDER_CART_LINE = {
    sku: 'CTN1070BK', found: true, is_active: true, retail_price: 24.49,
    quantity_breaks: [
        { min_quantity: 3, discount_percent: 3, business_price: 23.76, effective_percent: 3, savings_amount: 0.73, floored: false },
        { min_quantity: 4, discount_percent: 4, business_price: 23.51, effective_percent: 4, savings_amount: 0.98, floored: false },
        { min_quantity: 7, discount_percent: 7, business_price: 22.78, effective_percent: 7, savings_amount: 1.71, floored: false },
        { min_quantity: 8, discount_percent: 9, business_price: 22.29, effective_percent: 9, savings_amount: 2.2, floored: false }
    ]
};

/** A SKU that is not in the catalog — a real answer, NOT a miss. */
const LIVE_NOT_FOUND = { sku: 'NOPE-1', found: false };

/**
 * THE SIX LIVE PRICE BANDS, min/max retail observed across all 4,015 SKUs on
 * 2026-08-02 (ERR-140). Bands are half-open [min, max) on the GST-inclusive unit
 * price. Cheaper items discount deeper, and the deepest rung is 10%.
 *
 * The $100+ band split into three on 2026-08-02, and with it the entry rung
 * changed: the three bands under $100 start at 3+, the three at $100 and above
 * start at 2+. Nothing in shipped code depends on either number — this is a
 * written RECORD so the next re-band is a readable diff rather than an
 * investigation.
 *
 * `n` counts SKUs that produce a RENDERABLE ladder, so the six add up to 4,002
 * rather than 4,015: the other 13 carry the $500+ signature but floor away to
 * nothing (see LIVE_LADDER_ALL_FLOORED). Kept as a literal because a literal is
 * what makes a re-band show up in `git diff` — and cross-checked below against
 * the swept record so it cannot quietly rot. Regenerate both with
 * `npm run sweep:b2b`; `npm run sweep:b2b:check` fails on drift without writing.
 */
const LIVE_BANDS = [
    { ladder: '3:4,4:5,7:8,8:10', min: 5.49, max: 19.99, n: 312 },
    { ladder: '3:3,4:4,7:7,8:9', min: 20.49, max: 49.99, n: 811 },
    { ladder: '3:2,4:3,7:6,8:8', min: 50.49, max: 99.99, n: 618 },
    { ladder: '2:2,3:3,6:6,7:8', min: 100.49, max: 299.99, n: 1100 },
    { ladder: '2:1,3:2,6:5,7:7', min: 300.49, max: 497.49, n: 452 },
    { ladder: '2:0.5,3:1,5:3,6:5', min: 500.49, max: 7654.49, n: 709 }
];

/** Catalog SKUs answered by the pricing endpoint in that sweep. */
const LIVE_SKU_COUNT = 4015;
/** ...of which this many floor away to no ladder at all and render plain retail. */
const LIVE_NO_LADDER_COUNT = 13;

/**
 * The record written by `npm run sweep:b2b` — the live oracle behind every
 * number above. Absent on a fresh clone (it is a large generated artefact), so
 * the tests that use it skip rather than fail; they are a cross-check on the
 * literals, not a substitute for them.
 */
const SWEEP_RECORD = (() => {
    try {
        return JSON.parse(fs.readFileSync(
            path.join(__dirname, 'fixtures', 'business-pricing-sweep.json'), 'utf8'));
    } catch { return null; }
})();

/**
 * GET /api/cart for the same account (re-read 2026-08-02; shape unchanged).
 * `summary.b2b_discount` is a bare NUMBER; the metadata OBJECT sits at the
 * RESPONSE top level (the handoff documents it inside `summary`, and reading
 * only that shape rendered b2b = 0 with the row permanently hidden).
 * `summary.discount` INCLUDES the b2b amount — both are 3.92.
 * `pricing_tier` and `discount_percent` are GONE from the block.
 *
 * Six lines; only CTN1070BK x 4 reaches a rung, and it reaches the 4+ one:
 * $0.98 x 4 = $3.92, which is the whole cart discount. `effective_percent` is
 * 0.5 across the WHOLE cart while that one line got 4% — the reason the row
 * label must never present it as the customer's rate.
 */
const LIVE_CART = {
    b2b_discount: {
        company_name: 'Home',
        effective_percent: 0.5,
        discount_amount: 3.92,
        floored_line_count: 0,
        source: 'volume'
    },
    summary: {
        subtotal: 730.41,
        discount: 3.92,
        coupon_discount: 0,
        b2b_discount: 3.92,          // <- a NUMBER, not the object
        loyalty_discount_amount: 0,
        total: 726.49
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
        [[3, 33.94, 1.05, 3], [4, 33.59, 1.4, 4], [7, 32.54, 2.45, 7], [8, 31.84, 3.15, 9]]
    );

    // Every price is the API's own. Nothing is retail x (1 - pct).
    for (const rung of ladder.breaks) {
        const src = LIVE_LADDER_CLEAN.quantity_breaks.find(b => b.min_quantity === rung.minQuantity);
        assert.equal(rung.businessPrice, src.business_price);
        assert.equal(rung.savings, src.savings_amount);
    }

    assert.equal(ladder.entry.minQuantity, 3, 'entry rung is the cheapest quantity, not the deepest discount');
    assert.equal(ladder.best.minQuantity, 8);
});

test('describeLadder: COLLAPSES a floored duplicate rung — 6+ and 7+ are the same price', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);

    // The API sent four rungs. The last two charge $180.79 each, so advertising
    // "Buy 7+" would tell the customer to buy one more unit for nothing. The
    // Aug-2026 bands put the deepest two rungs a single unit apart, so this is
    // now the difference between a real offer and an insulting one.
    assert.equal(ladder.breaks.length, 3, 'the duplicate 7+ rung must not be rendered');
    assert.equal(ladder.collapsed, 1);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [2, 3, 6]);
    assert.equal(ladder.best.minQuantity, 6);
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
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [2, 3]);
    assert.equal(ladder.best.businessPrice, 1124.49);
});

test('describeLadder: an ENTIRELY floored ladder returns null SILENTLY and renders retail', () => {
    // 13 live SKUs price all four rungs AT retail because the item is already
    // too close to cost for any rung to clear the 5% net floor. Every rung is
    // dropped, so there is no ladder — the product must fall back to plain
    // retail with no B2B surface, and must NOT warn: this is a real answer, not
    // the unrecognised-payload case. Warning here would cry wolf on 13 SKUs and
    // train the next person to ignore the warning that actually matters.
    const B = loadBusiness();
    assert.equal(B.describeLadder(LIVE_LADDER_ALL_FLOORED), null);
    assert.equal(B.__warnings.length, 0, 'a legitimately empty ladder must not warn');

    // And nothing downstream can be coaxed into rendering one.
    assert.equal(B.offerAtQuantity(null, 10), null);
    assert.equal(B.nudgeMarkup(null, 1, 100), '');
});

test('describeLadder: percent is always effective_percent, never the discount_percent ceiling', () => {
    const B = loadBusiness();
    const floored = B.describeLadder(LIVE_LADDER_FLOORED);
    const rung6 = floored.breaks.find(r => r.minQuantity === 6);

    assert.equal(rung6.percent, 5.7, 'the REALISED percent');
    assert.notEqual(rung6.percent, 6, 'never the ceiling the floor prevented');
    assert.equal(rung6.floored, true);

    // And on an unfloored rung the two are equal anyway, so one rule covers both.
    const clean = loadBusiness().describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(clean.breaks[0].percent, 3);
});

test('describeLadder: rungs dropped AT OR ABOVE retail are counted, not silently lost', () => {
    // Three ways a rung can vanish, and only one of them is `collapsed`. Without
    // a count for the at-or-above-retail case, a ladder that starts a rung higher
    // than the recorded matrix says looks identical to one that never had that
    // rung — and the sweep would certify a matrix the customer isn't being shown.
    // The conservation law below is the check:
    //   breaks + collapsed + droppedAtOrAboveRetail === rungs the API sent
    const B = loadBusiness();

    const all = B.describeLadder(LIVE_LADDER_ALL_FLOORED);
    assert.equal(all, null, 'four rungs at retail leave no ladder at all');

    const partial = B.describeLadder({
        sku: 'X', found: true, is_active: true, retail_price: 20,
        quantity_breaks: [
            { min_quantity: 2, business_price: 20, savings_amount: 0, effective_percent: 0 },   // at retail
            { min_quantity: 3, business_price: 19.5, savings_amount: 0.5, effective_percent: 2.5 },
            { min_quantity: 6, business_price: 19.5, savings_amount: 0.5, effective_percent: 2.5 } // duplicate
        ]
    });
    assert.equal(partial.droppedAtOrAboveRetail, 1, 'the at-retail rung is counted');
    assert.equal(partial.collapsed, 1, 'the duplicate is counted separately');
    assert.equal(partial.breaks.length, 1);
    assert.equal(partial.entry.minQuantity, 3, 'the ladder starts a rung above the matrix');
    assert.equal(partial.breaks.length + partial.collapsed + partial.droppedAtOrAboveRetail, 3,
        'every rung the API sent is accounted for exactly once');

    // A clean live ladder loses nothing, so the law holds trivially there too.
    const clean = B.describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(clean.droppedAtOrAboveRetail, 0);
    assert.equal(clean.breaks.length + clean.collapsed + clean.droppedAtOrAboveRetail,
        LIVE_LADDER_CLEAN.quantity_breaks.length);
});

test('formatPercent: a real discount NEVER renders as "-0%" or as nothing at all', () => {
    // The PDP chip prints "&minus;" + this string, so a percent that rounds to
    // zero would print "-0%" beside a price that IS genuinely below retail. And
    // returning '' is worse: the chip's ternary reads falsy as "no percent to
    // show" and drops the badge entirely — absence read as zero, the exact
    // failure mode this module exists to prevent (ERR-063/068/139).
    const B = loadBusiness();
    assert.equal(B.formatPercent(0.03), '<0.1%');
    assert.equal(B.formatPercent(0.04), '<0.1%');
    assert.ok(B.formatPercent(0.03), 'must be truthy or the chip omits the badge');

    // The boundary: 0.05 rounds up to a real 0.1%, so it is NOT the floor case.
    assert.equal(B.formatPercent(0.05), '0.1%');

    // A genuine zero (or junk) is still nothing — there is no discount to state.
    assert.equal(B.formatPercent(0), '0%');
    assert.equal(B.formatPercent(NaN), '');
    assert.equal(B.formatPercent(null), '');

    // And describeLadder never hands a zero percent through in the first place:
    // it stores null, so the chip omits the badge rather than claiming "0%".
    const zeroPct = B.describeLadder({
        sku: 'X', found: true, is_active: true, retail_price: 20,
        quantity_breaks: [{ min_quantity: 3, business_price: 19, savings_amount: 1, effective_percent: 0 }]
    });
    assert.equal(zeroPct.breaks[0].percent, null);
});

test('describeLadder: a FRACTIONAL percent survives intact — 0.5% is not 0% and not 1%', () => {
    // The $500+ band's entry rung discounts by half a percent across 722 SKUs.
    // Rounding it to an integer either erases the offer or advertises double it.
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_TOP_BAND);
    assert.equal(ladder.entry.percent, 0.5);
    assert.equal(ladder.entry.businessPrice, 517.89);
    assert.equal(B.formatPercent(0.5), '0.5%');
    assert.equal(B.formatPercent(ladder.breaks[1].percent), '1%', 'a whole number stays whole');

    // The floored fraction from a different band survives too.
    assert.equal(B.formatPercent(B.describeLadder(LIVE_LADDER_FLOORED_HARD).breaks[1].percent), '0.8%');
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
            { min_quantity: 4, business_price: 20, savings_amount: 0, effective_percent: 0 },   // at retail
            { min_quantity: 7, business_price: 21, savings_amount: -1 },                        // above retail
            { min_quantity: 8, business_price: 18, savings_amount: 2, effective_percent: 10 }   // the only real one
        ]
    });
    assert.equal(ladder.breaks.length, 1);
    assert.equal(ladder.breaks[0].minQuantity, 8);
});

test('describeLadder: qty 2 is a REAL rung and must not be dropped with qty 1', () => {
    // The `minQuantity < 2` guard used to sit below every live band's entry rung
    // (3+), so it was invisible. Since Aug 2026 the three $100+ bands enter at
    // 2+, which puts 2,261 SKUs' entry rung exactly on that boundary — tightening
    // the guard to `< 3` would silently delete the entry rung of over half the
    // catalog while every other rung kept working.
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_ENTRY_TWO);
    assert.equal(ladder.entry.minQuantity, 2, 'the 2+ rung survives');
    assert.equal(ladder.entry.businessPrice, 108.77);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [2, 3, 6, 7]);
    assert.equal(ladder.collapsed, 0);
});

test('describeLadder: sorts an out-of-order ladder before collapsing it', () => {
    const B = loadBusiness();
    const shuffled = {
        sku: 'X', found: true, is_active: true, retail_price: 34.99,
        quantity_breaks: LIVE_LADDER_CLEAN.quantity_breaks.slice().reverse()
    };
    const ladder = B.describeLadder(shuffled);
    assert.deepEqual(ladder.breaks.map(r => r.minQuantity), [3, 4, 7, 8]);
    assert.equal(ladder.collapsed, 0, 'reordering must not be mistaken for a duplicate');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Quantity resolution — the price is a function of quantity, not of the SKU
// ═════════════════════════════════════════════════════════════════════════════

test('offerAtQuantity: at qty 1 a business account pays FULL RETAIL, in EVERY band', () => {
    const B = loadBusiness();

    // Under $100 the entry rung is 3+, so 1 and 2 both get nothing.
    const cheap = B.describeLadder(LIVE_LADDER_CLEAN);
    assert.equal(B.offerAtQuantity(cheap, 1), null, 'the entry rung is 3+, so qty 1 gets nothing');
    assert.equal(B.offerAtQuantity(cheap, 2), null);

    // At $100+ the entry rung is 2+ — qty 2 now DOES buy something, and qty 1
    // still does not. This is the single claim every surface depends on: a price
    // shown without a quantity beside it is a lie at qty 1.
    const dear = B.describeLadder(LIVE_LADDER_ENTRY_TWO);
    assert.equal(B.offerAtQuantity(dear, 1), null, 'no band has ever had a qty-1 rung');
    assert.equal(B.offerAtQuantity(dear, 2).minQuantity, 2);
    assert.equal(B.offerAtQuantity(dear, 2).businessPrice, 108.77);

    // Including the $500+ band, whose entry rung is a half-percent.
    assert.equal(B.offerAtQuantity(B.describeLadder(LIVE_LADDER_TOP_BAND), 1), null);
});

test('offerAtQuantity: every boundary lands on the deepest rung actually reached', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CLEAN);
    const at = (q) => { const r = B.offerAtQuantity(ladder, q); return r ? r.minQuantity : null; };

    assert.equal(at(3), 3, 'exactly at the break');
    assert.equal(at(4), 4);
    assert.equal(at(5), 4, 'between breaks stays on the lower rung');
    assert.equal(at(6), 4);
    assert.equal(at(7), 7);
    assert.equal(at(8), 8);
    assert.equal(at(1000), 8, 'past the top rung stays on the top rung');
});

test('offerAtQuantity: a collapsed ladder never resolves to a rung that was not rendered', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);
    assert.equal(B.offerAtQuantity(ladder, 25).minQuantity, 6,
        'buying 25 charges the 6+ price, which is what the collapsed chip advertises');
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
    assert.equal(from1.rung.businessPrice, 33.94);
    assert.equal(from1.lineSavingsAtBreak, 3.15, '1.05 x 3');

    const from3 = B.nextBreak(ladder, 3);
    assert.equal(from3.unitsAway, 1);
    assert.equal(from3.quantityAtBreak, 4);
    assert.equal(from3.lineSavingsAtBreak, 5.6, '1.40 x 4');

    assert.equal(B.nextBreak(ladder, 8), null, 'already on the deepest rung');
    assert.equal(B.nextBreak(ladder, 500), null);
});

test('nextBreak: a $100+ shopper holding ONE unit is one unit away from a discount', () => {
    // Before Aug 2026 every band entered at 3+, so the first nudge a shopper
    // ever saw asked for two more units. On 2,261 SKUs it now asks for one —
    // the cheapest nudge the scheme has ever been able to make.
    const B = loadBusiness();
    const next = B.nextBreak(B.describeLadder(LIVE_LADDER_ENTRY_TWO), 1);
    assert.equal(next.unitsAway, 1);
    assert.equal(next.quantityAtBreak, 2);
    assert.equal(next.lineSavingsAtBreak, 4.44, '2.22 x 2');
    assert.match(B.nudgeMarkup(B.describeLadder(LIVE_LADDER_ENTRY_TWO), 1, 100),
        /Add 1 more to reach 2\+/);
});

test('nextBreak: on a collapsed ladder the top rung is the COLLAPSED one, so no phantom nudge', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_FLOORED);
    assert.equal(B.nextBreak(ladder, 6), null,
        'never nudge toward 7+ when 7+ charges the same as 6+');
});

test('lineSavings: total saved on a line is the rung savings times the quantity', () => {
    const B = loadBusiness();
    const ladder = B.describeLadder(LIVE_LADDER_CART_LINE);
    assert.equal(B.lineSavings(ladder, 4), 3.92, '0.98 x 4');
    assert.equal(B.lineSavings(ladder, 2), 0, 'below the entry rung there is no saving');
    assert.equal(B.lineSavings(ladder, 0), 0);
});

test('CONSISTENCY GATE: the ladder reproduces the live cart discount to the cent', () => {
    // The cart's b2b_discount.discount_amount is computed by the backend and is
    // AUTHORITATIVE. This proves the frontend's reading of the ladder agrees
    // with what the server actually charged — if the two ever diverge, the
    // "add N more" nudges and the PDP chips are lying about money.
    //
    // Live cart (2026-08-02): 6 lines, and only CTN1070BK x 4 reaches a rung —
    // the 4+ one, which did not exist before the re-band. Every other line is a
    // single unit, and no band discounts at qty 1.
    const B = loadBusiness();
    const lines = [
        { ladder: B.describeLadder(LIVE_LADDER_CART_LINE), quantity: 4 },
        { ladder: B.describeLadder(LIVE_LADDER_CLEAN), quantity: 1 }
    ];
    const total = lines.reduce((sum, l) => sum + B.lineSavings(l.ladder, l.quantity), 0);
    assert.equal(Math.round(total * 100) / 100, LIVE_CART.b2b_discount.discount_amount);
    assert.equal(Math.round(total * 100) / 100, 3.92);
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
    assert.match(BUSINESS_CODE, /_priceCache\s*:\s*new Map\(\)/, 'the cache is in memory only');

    // sessionStorage is permitted for exactly ONE thing: the header shortcut's
    // instant-show hint, which holds a USER ID and never money (Aug 2026). This
    // enumerates every use and pins each to that key, so the original invariant
    // — no negotiated price ever reaches web storage — is enforced more tightly
    // than the old blanket ban, not less.
    const uses = BUSINESS_CODE.match(/sessionStorage\s*\.\s*\w+\s*\([^)]*\)/g) || [];
    assert.ok(uses.length > 0,
        'expected the header hint to use sessionStorage — if the hint was removed, restore the blanket ban');
    for (const use of uses) {
        assert.match(use, /this\.HEADER_HINT_KEY/,
            `sessionStorage in business.js may only ever hold HEADER_HINT_KEY — found: ${use}`);
    }
    // And the hint must be keyed to the user id, so one account's answer can
    // never reveal the shortcut for the next person to sign in on this browser.
    assert.match(BUSINESS_CODE, /_writeHeaderHint\(\s*status\.active && uid \? uid : null\s*\)/,
        'the hint value must be the user id, gated on an active status');
});

test('the cache is dropped on every auth state change', () => {
    // The callback also re-evaluates the header shortcut now, so this pins the
    // reset() call inside the callback rather than the whole arrow body.
    assert.match(BUSINESS_CODE, /onAuthStateChange\(\s*\(\)\s*=>\s*\{[\s\S]{0,300}?this\.reset\(\)/,
        'onAuthStateChange must still bin the cache before anything else reads it');
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
    assert.match(BUSINESS_SRC, /AT QUANTITY 1 EVERYONE PAYS FULL RETAIL/);
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

    assert.equal(r.b2b, 3.92, 'reading only the documented shape rendered 0 and hid the row');
    assert.equal(r.loyalty, 0);
    assert.equal(r.other, 0, 'summary.discount INCLUDES the b2b amount — it must be netted out');
    assert.equal(r.b2bMeta.source, 'volume');
    assert.equal(r.b2bMeta.company_name, 'Home');
});

test('computeDiscountBreakdown: still reads the object if the backend moves it into summary', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const r = computeDiscountBreakdown(
        Object.assign({}, LIVE_CART.summary, { b2b_discount: LIVE_CART.b2b_discount }), 3.92);
    assert.equal(r.b2b, 3.92);
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
    assert.equal(businessDiscountLabel(LIVE_CART.b2b_discount), 'Volume discount — Home');
    assert.equal(businessDiscountLabel({ company_name: '  Acme Print Co  ' }), 'Volume discount — Acme Print Co');

    // effective_percent is the realised rate over the WHOLE cart (0.7% live on a
    // cart whose one qualifying line got 5%), so it must not ride in this label.
    assert.doesNotMatch(businessDiscountLabel(LIVE_CART.b2b_discount), /%/);
});

test('businessDiscountLabel: the no-company fallback never claims a business account (ERR-149)', () => {
    const { businessDiscountLabel } = loadCartHelpers();

    // This row is UNGATED — cart.js, checkout-page.js, payment-page.js and
    // order-totals.js all print it purely on "server reported an amount > 0".
    // While volume pricing was business-only that made "Business account" a safe
    // fallback; once retail carts are discounted it tells a guest they have an
    // account they never opened. An absent company_name is the server declining
    // to name a company, not evidence about the shopper.
    for (const meta of [{}, null, undefined, { company_name: 123 }, { company_name: '   ' }]) {
        const label = businessDiscountLabel(meta);
        assert.equal(label, 'Volume discount',
            `no company name must fall back to the neutral label, got "${label}"`);
        assert.doesNotMatch(label, /business/i,
            'the fallback must not assert anything about the shopper\'s account type');
    }
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
    assert.match(html, /Add 3 more to reach 7\+/);
    assert.match(html, /\$22\.78 each/);
    assert.match(html, /saving \$11\.97 on this line/, '1.71 x 7');
    assert.match(html, /data-break-quantity="7"/);

    assert.equal(B.nudgeMarkup(ladder, 8, 100), '', 'no nudge on the deepest rung');
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
    // "Bulk price", not "Business bulk price": every shopper gets the ladder now,
    // so naming an account type on a public card would be false for most readers.
    assert.match(html, /Bulk price/);
    assert.doesNotMatch(html, /Business/);
    assert.match(html, /\$33\.94/, 'the ENTRY rung — the achievable one');
    assert.match(html, / ea/);
    assert.match(html, /Buy 3\+/, 'a price with no quantity beside it is a lie at qty 1');
    assert.match(html, /down to \$31\.84 at 8\+/);
    assert.match(html, /data-testid="business-card-price"/);

    // And on a $100+ card the quantity in the claim is 2+, not 3+.
    const dear = B.cardMarkup(B.describeLadder(LIVE_LADDER_ENTRY_TWO));
    assert.match(dear, /Buy 2\+/);
    assert.match(dear, /down to \$102\.11 at 7\+/);
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
    // The backend's own sentence is passed through verbatim when it sends one.
    assert.match(b2bCouponText(LIVE_COUPON_PREVIEW), /automatic volume pricing/);
    assert.match(b2bCouponText(LIVE_COUPON_APPLY_ERROR), /automatic volume pricing/);

    // OUR fallback no longer explains the rule with "business accounts get
    // automatic volume pricing" — every shopper does now, so that clause stopped
    // being a reason and became a non-sequitur. It states the rule and what
    // survives it, and asserts no rationale it cannot support (BF-036).
    for (const blank of [null, {}, { message: '   ' }]) {
        const text = b2bCouponText(blank);
        assert.match(text, /promo codes/i, 'name the thing that was refused');
        assert.match(text, /can’t be combined|cannot be combined/i);
        assert.match(text, /loyalty points still work/i,
            'say what DOES still work, or the message is pure denial');
    }
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

    // It must still SAY what works — but via the shared constant, not its own
    // copy of the sentence. The lock used to inline a duplicate of
    // B2B_COUPON_COPY, so the field's wording and the apply/preview wording
    // could drift apart without either one looking wrong on its own.
    assert.match(body, /B2B_COUPON_COPY/,
        'the lock must reuse the module constant, not carry a second copy of the copy');
    assert.match(CART_PAGE_SRC, /const B2B_COUPON_COPY = '[^']*loyalty points still work/i,
        'and that constant must say what DOES still work');
    const inlineCopies = (stripComments(CART_PAGE_SRC).match(/loyalty points still work/gi) || []);
    assert.equal(inlineCopies.length, 1,
        `the sentence must exist in exactly ONE executable place, found ${inlineCopies.length}`);
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
        // The entry rung is band-dependent since Aug 2026: 3+ under $100, 2+ at
        // $100 and above. Never 1, in any band, ever — that is the invariant.
        const entry = item.quantity_breaks[0].min_quantity;
        assert.ok(entry === 2 || entry === 3, `entry rung must be 2 or 3, saw ${entry}`);
        assert.equal(entry, item.retail_price >= 100 ? 2 : 3,
            'the entry rung must match the band recorded in LIVE_BANDS');

        // And the ladder the live backend sends must still be one this file's
        // recorded matrix describes — otherwise the bands moved again.
        const signature = item.quantity_breaks
            .map(b => `${b.min_quantity}:${b.discount_percent}`).join(',');
        assert.ok(LIVE_BANDS.some(b => b.ladder === signature),
            `live ladder ${signature} matches no recorded band — re-run npm run sweep:b2b`);

        assert.equal(priced.data.items.find(i => i.sku === 'NOPE-1').found, false);
    });

test('the six live price bands are recorded so a re-band is a visible diff', () => {
    // Not an assertion about the backend — a written record of what was swept on
    // 2026-08-02 (4,015 SKUs, 39 floored, 13 floored all the way to no ladder at
    // all, 0 unanswered), so the next person can tell "the bands changed" from
    // "my code broke". Regenerate with `npm run sweep:b2b`.
    assert.equal(LIVE_BANDS.length, 6, 'the $100+ band split into three on 2026-08-02');
    assert.equal(LIVE_BANDS.reduce((n, b) => n + b.n, 0) + LIVE_NO_LADDER_COUNT, LIVE_SKU_COUNT,
        'every answered SKU either lands in a band or floors away to no ladder');

    for (const band of LIVE_BANDS) {
        // Four rungs, ascending, each a deeper discount than the last.
        const rungs = band.ladder.split(',').map(r => r.split(':').map(Number));
        assert.equal(rungs.length, 4, `${band.ladder}: every band has four rungs`);
        for (let i = 1; i < rungs.length; i++) {
            assert.ok(rungs[i][0] > rungs[i - 1][0], `${band.ladder}: quantities ascend`);
            assert.ok(rungs[i][1] > rungs[i - 1][1], `${band.ladder}: each rung discounts deeper`);
        }
        // NO BAND HAS EVER HAD A QTY-1 RUNG. This is the one number the
        // storefront's copy depends on: a business price shown without a
        // quantity beside it is a lie at qty 1.
        assert.ok(rungs[0][0] >= 2, `${band.ladder}: the entry rung is never 1`);
        // Under $100 the entry is 3+; at $100 and above it is 2+.
        assert.equal(rungs[0][0], band.min >= 100 ? 2 : 3,
            `${band.ladder}: entry rung must match the band's price range`);
        // 10% is the deepest discount the scheme offers (was 18% before Aug 2026).
        assert.ok(rungs[3][1] <= 10, `${band.ladder}: nothing discounts past 10%`);
    }

    // Bands are half-open [min, max) and must not overlap once sorted by price.
    for (let i = 1; i < LIVE_BANDS.length; i++) {
        assert.ok(LIVE_BANDS[i].min > LIVE_BANDS[i - 1].max,
            'the recorded bands must not overlap');
    }
    // Cheaper items discount deeper — the whole premise of banding by price.
    const deepest = LIVE_BANDS.map(b => Number(b.ladder.split(',').pop().split(':')[1]));
    for (let i = 1; i < deepest.length; i++) {
        assert.ok(deepest[i] <= deepest[i - 1], 'a dearer band never out-discounts a cheaper one');
    }
});

test('the sweep record EXISTS — its absence must not quietly unpin the literals', () => {
    // Every other record-backed test below is `skip`ped when SWEEP_RECORD is
    // null, which is right for a developer mid-sweep and WRONG as a resting
    // state: delete tests/fixtures/business-pricing-sweep.json and the literals
    // above silently stop being checked against anything, three tests report
    // "skipped" in a wall of green, and the suite is back to asserting that a
    // hand-typed matrix equals itself. That is the exact shape of the failure
    // this whole file was rewritten to end (ERR-140), so the record's absence
    // is a hard failure on its own rather than an inference from a skip count.
    assert.ok(SWEEP_RECORD,
        'tests/fixtures/business-pricing-sweep.json is missing or unparseable — run `npm run sweep:b2b`. ' +
        'Without it the LIVE_BANDS literals are pinned to nothing.');
    assert.equal(SWEEP_RECORD.source, 'volume',
        'the record was captured from a pricing model this file does not describe');
    assert.ok(Array.isArray(SWEEP_RECORD.bands) && SWEEP_RECORD.bands.length,
        'the record carries no bands — a partial sweep must never have been written');
});

test('the recorded bands match the swept record, so the literals above cannot rot',
    { skip: !SWEEP_RECORD && 'no sweep record — run npm run sweep:b2b' }, () => {
        // The literals are what a reviewer reads in a diff; the record is what
        // production actually said. Pinning them to each other is the only thing
        // that stops the readable copy drifting away from the true one — which is
        // exactly how the July fixtures survived a whole re-band still green.
        assert.deepEqual(
            SWEEP_RECORD.bands.map(b => ({ ladder: b.ladder, min: b.min, max: b.max, n: b.n })),
            LIVE_BANDS.map(b => ({ ladder: b.ladder, min: b.min, max: b.max, n: b.n })));

        assert.equal(SWEEP_RECORD.totals.answered, LIVE_SKU_COUNT);
        assert.equal(SWEEP_RECORD.totals.no_ladder_after_normalise, LIVE_NO_LADDER_COUNT);
        assert.equal(SWEEP_RECORD.percent_range.max, 10, 'the top discount is 10%, down from 18%');
        assert.equal(SWEEP_RECORD.percent_range.min, 0.5);

        // Nothing went unanswered — a partial sweep must never be recorded as a
        // clean one, or "the bands changed" and "the sweep half-failed" look alike.
        assert.equal(SWEEP_RECORD.totals.unanswered, 0);
        assert.equal(SWEEP_RECORD.totals.not_found, 0);
    });

test('the swept record is SELF-consistent, so an edited record cannot pose as a re-band',
    { skip: !SWEEP_RECORD && 'no sweep record — run npm run sweep:b2b' }, () => {
        // `top_percent`, `entry_quantity` and `top_quantity` are DERIVED by the
        // sweep from the `ladder` string, so in a genuine capture they agree by
        // construction. If they disagree, the file was edited after it was
        // written — and a hand-edited record is indistinguishable from a real
        // re-band until you check this. (Caught exactly that on 2026-08-02: a
        // record claiming a 12% top rung while its own derived top_percent said
        // 10 and the live API said 10.)
        for (const band of SWEEP_RECORD.bands) {
            const rungs = band.ladder.split(',').map(s => s.split(':').map(Number));
            assert.equal(band.entry_quantity, rungs[0][0], `${band.ladder}: entry_quantity is derived`);
            assert.equal(band.top_quantity, rungs[rungs.length - 1][0], `${band.ladder}: top_quantity is derived`);
            assert.equal(band.top_percent, rungs[rungs.length - 1][1], `${band.ladder}: top_percent is derived`);
        }

        // The headline percent must be the deepest rung any band actually offers.
        const deepest = Math.max(...SWEEP_RECORD.bands.map(b => b.top_percent));
        assert.equal(SWEEP_RECORD.max_effective_percent, deepest);
        assert.equal(SWEEP_RECORD.percent_range.max, deepest);

        // And the band counts must add up to what the sweep says it answered.
        const counted = SWEEP_RECORD.bands.reduce((n, b) => n + b.n, 0);
        assert.equal(counted + SWEEP_RECORD.totals.no_ladder_after_normalise +
            SWEEP_RECORD.totals.not_found + SWEEP_RECORD.totals.inactive +
            SWEEP_RECORD.totals.empty_ladder,
            SWEEP_RECORD.totals.answered,
            'every answered SKU must be accounted for exactly once');
    });

test('the swept cart still reproduces its own b2b discount to the cent',
    { skip: !SWEEP_RECORD && 'no sweep record — run npm run sweep:b2b' }, () => {
        // The fixture cart above is a snapshot; this proves the snapshot matches
        // the live cart the sweep read at the same moment.
        assert.deepEqual(SWEEP_RECORD.cart.b2b_discount, LIVE_CART.b2b_discount);
        assert.equal(SWEEP_RECORD.cart.summary_b2b_discount, LIVE_CART.summary.b2b_discount,
            'the number in summary and the object at the top level must still agree');

        // And the fixture ladders reproduce that cart's discount independently:
        // only CTN1070BK x 4 qualifies, on the 4+ rung.
        const B = loadBusiness();
        const line = SWEEP_RECORD.cart.lines.find(l => l.sku === 'CTN1070BK');
        assert.equal(line.quantity, 4);
        assert.equal(B.lineSavings(B.describeLadder(LIVE_LADDER_CART_LINE), line.quantity),
            SWEEP_RECORD.cart.b2b_discount.discount_amount);
    });
