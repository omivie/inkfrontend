/**
 * Business Account pricing (B2B) — frontend contract — July 2026
 * ==============================================================
 *
 * What shipped (ERR-110)
 * ----------------------
 * The backend shipped B2B "Business Account" pricing
 * (business-account-pricing-FE-handoff.md). Nothing was wired on the frontend:
 * repo-wide greps for /api/business, pricing_tier and b2b_discount returned
 * zero hits, and the cart b2b block was an explicitly deferred TODO because the
 * payload shape could not be verified without a business account. The handoff
 * supplies that shape.
 *
 * THE RULE THIS FILE EXISTS TO PROTECT
 * ------------------------------------
 * The tier % (5/10/15) is a CEILING, not a guarantee. The backend caps each
 * unit's discount so the unit still nets >= 5% after Stripe fees ("never sell
 * at a loss"), so on thin-margin items the realised discount is SMALLER than
 * the tier % (`floored:true`) or zero. Therefore:
 *
 *     retail x (1 - tier%)  !=  what checkout charges
 *
 * Any client-side reconstruction of a business price is a bug that shows the
 * customer a number the checkout will not honour. These tests ban the
 * arithmetic outright and pin the verbatim-render path.
 *
 * Also pinned
 * -----------
 * - `missed` is part of getPricing()'s RETURN VALUE. A SKU the server declined
 *   to answer for must never be conflated with a SKU that genuinely has no
 *   business discount — the ERR-063/068/073 "absence read as healthy zero"
 *   failure mode.
 * - Business prices are per-account: NO localStorage/sessionStorage, and the
 *   in-memory cache is dropped whenever the signed-in user changes.
 * - The PDP's #product-price itemprop="price" microdata still carries RETAIL.
 *   Writing a per-account price there would be cloaking and would poison the
 *   Merchant Center feed.
 * - cart.js's two summary renderers both go through one shared breakdown. They
 *   had drifted (only the surgical path rendered the loyalty row and netted it
 *   out, so on a fresh cart load the loyalty row stayed hidden until a qty
 *   change) — adding a third discount line to two divergent paths would have
 *   doubled that bug.
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
const PDP_SRC = JS('product-detail-page.js');

// ─────────────────────────────────────────────────────────────────────────────
// Load the Business module into a sandbox so the pure helpers actually EXECUTE.
// business.js declares `const Business = {...}` at top level and only touches
// `window` in a trailing guard, so a minimal context is enough.
// ─────────────────────────────────────────────────────────────────────────────
// Evaluated in THIS realm (not a vm context) so the Arrays/Maps it returns are
// host-native and deepStrictEqual works. `window`/`document` arrive undefined,
// so the trailing browser-only bootstrap block is skipped.
// `auth` and `api` are mutable objects captured by closure — swap their members
// per test to drive the module.
function loadBusiness() {
    const auth = { initialized: true, user: null, isAuthenticated: () => false, onAuthStateChange() {} };
    const api = { get: async () => ({ ok: false }) };
    const factory = new Function(
        'Auth', 'API', 'Security', 'DebugLog', 'formatPrice', 'window', 'document',
        BUSINESS_SRC + '\nreturn Business;'
    );
    const B = factory(
        auth,
        api,
        { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) },
        { log() {}, warn() {}, error() {}, info() {} },
        (n) => '$' + Number(n).toFixed(2),
        undefined,
        undefined
    );
    B.__auth = auth;
    B.__api = api;
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
 * Slice out just the renderBusinessPrice() method body.
 * Anchored on the method DECLARATION and on the Value-pack doc comment that
 * follows it — `renderPackSuggestion(info)` also appears earlier in the file as
 * a call site, which would produce an empty slice.
 */
function pdpPanelSource() {
    const start = PDP_SRC.indexOf('async renderBusinessPrice(info)');
    assert.notEqual(start, -1, 'renderBusinessPrice must exist as a method declaration');
    const end = PDP_SRC.indexOf('* Value-pack upsell', start);
    assert.notEqual(end, -1, 'the Value-pack doc comment must still follow the panel');
    const slice = PDP_SRC.slice(start, end);
    assert.ok(slice.length > 500, 'sanity: the panel body was located');
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

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — copied verbatim from business-account-pricing-FE-handoff.md.
// ─────────────────────────────────────────────────────────────────────────────

/** The handoff's own example: gold tier, one clean line and one floored line. */
const PRICING_FIXTURE = {
    pricing_tier: 'gold',
    tier_percent: 15,
    items: [
        {
            sku: 'GTN251BK', found: true, is_active: true,
            retail_price: 34.99, business_price: 29.74, tier_percent: 15,
            effective_percent: 15.0, savings_amount: 5.25, floored: false
        },
        {
            sku: 'GTN251C', found: true, is_active: true,
            retail_price: 119.99, business_price: 112.49, tier_percent: 15,
            effective_percent: 6.3, savings_amount: 7.50, floored: true
        },
        { sku: 'NOPE-1', found: false }
    ]
};

// ── LIVE-VERIFIED payloads ───────────────────────────────────────────────────
// Captured 2026-07-20 from the production API with a real approved business
// account. These matter more than the handoff's examples: on two points the
// live contract does NOT match the doc, and both mismatches silently rendered
// NOTHING before they were caught in the browser.

/**
 * GET /api/business/status for a real approved account.
 * MISMATCH #1: the handoff describes an "active business account"; the API
 * actually reports status:"approved". Testing for 'active' denied business
 * pricing to every genuinely approved customer.
 */
const LIVE_STATUS = {
    status: 'approved',
    application: { company_name: 'Home', submitted_at: '2026-04-18T01:20:11.036596+00:00' },
    credit_limit: 0,
    credit_remaining: 0,
    pricing_tier: 'bronze',
    net30_approved: true
};

/** GET /api/business/pricing — matches the handoff exactly. */
const LIVE_PRICING_ITEM = {
    sku: 'GDK22225BK', found: true, is_active: true,
    retail_price: 35.79, business_price: 34, tier_percent: 5,
    effective_percent: 5, savings_amount: 1.79, floored: false
};

/**
 * GET /api/cart for the same account.
 * MISMATCH #2: the handoff documents `summary.b2b_discount` as the metadata
 * OBJECT. Live, summary.b2b_discount is a bare NUMBER and the object sits at
 * the RESPONSE top level. Reading only the documented shape produced b2b = 0
 * and the row never appeared.
 * Also proves `summary.discount` INCLUDES the b2b amount (both are 4.68).
 */
const LIVE_CART = {
    b2b_discount: {
        pricing_tier: 'bronze', discount_percent: 5, effective_percent: 5,
        discount_amount: 4.68, floored_line_count: 0, source: 'b2b_tier'
    },
    summary: {
        subtotal: 93.96,
        discount: 4.68,
        coupon_discount: 0,
        b2b_discount: 4.68,          // <- a NUMBER, not the object
        loyalty_discount_amount: 0,
        total: 89.28
    }
};

/** The handoff's cart b2b_discount block. */
const B2B_BLOCK = {
    pricing_tier: 'gold',
    discount_percent: 15,
    effective_percent: 12.4,
    discount_amount: 18.60,
    floored_line_count: 1,
    source: 'b2b_tier'
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. describeOffer() — the verbatim-render contract
// ═════════════════════════════════════════════════════════════════════════════

test('describeOffer: renders the API business_price verbatim, never tier maths', () => {
    const B = loadBusiness();
    const clean = PRICING_FIXTURE.items[0];
    const offer = B.describeOffer(clean);

    assert.equal(offer.businessPrice, 29.74, 'business_price must be passed through untouched');
    assert.equal(offer.retailPrice, 34.99, 'retail_price must be passed through untouched');
    assert.equal(offer.savings, 5.25, 'savings_amount must be passed through untouched');
    assert.equal(offer.floored, false, 'this line is not floored');

    // The trap this whole feature exists to avoid.
    const computed = Number((clean.retail_price * (1 - clean.tier_percent / 100)).toFixed(2));
    assert.equal(offer.businessPrice, computed,
        'sanity: on an UNfloored line the tier maths happens to agree — which is exactly ' +
        'why a developer might wrongly trust it (see the floored case below)');
});

test('describeOffer: FLOORED line — tier maths would understate the price the customer pays', () => {
    const B = loadBusiness();
    const floored = PRICING_FIXTURE.items[1];
    const offer = B.describeOffer(floored);

    assert.equal(offer.businessPrice, 112.49, 'must render the floored business_price');
    assert.equal(offer.floored, true, 'floored flag must survive');

    const computed = Number((floored.retail_price * (1 - floored.tier_percent / 100)).toFixed(2));
    assert.notEqual(offer.businessPrice, computed,
        'the whole point: retail x (1 - tier%) = ' + computed + ' but checkout charges 112.49');
    assert.ok(computed < offer.businessPrice,
        'client-side maths would promise a LOWER price than checkout honours — a broken promise');
});

test('describeOffer: percent is always effective_percent, never the tier ceiling', () => {
    const B = loadBusiness();
    assert.equal(B.describeOffer(PRICING_FIXTURE.items[0]).percent, 15,
        'unfloored: effective == tier, so 15 either way');
    assert.equal(B.describeOffer(PRICING_FIXTURE.items[1]).percent, 6.3,
        'floored: must show the REALISED 6.3%, never the advertised 15% ceiling');
});

test('describeOffer: suppressed for unfound, inactive, zero-savings and junk input', () => {
    const B = loadBusiness();
    assert.equal(B.describeOffer(PRICING_FIXTURE.items[2]), null, 'found:false => no panel');
    assert.equal(B.describeOffer(null), null, 'null => no panel');
    assert.equal(B.describeOffer(undefined), null, 'undefined (a missed SKU) => no panel');
    assert.equal(B.describeOffer({}), null, 'empty object => no panel');
    assert.equal(
        B.describeOffer({ sku: 'X', found: true, is_active: false, retail_price: 10, business_price: 9, savings_amount: 1 }),
        null, 'is_active:false => no panel');
    assert.equal(
        B.describeOffer({ sku: 'X', found: true, retail_price: 10, business_price: 10, savings_amount: 0 }),
        null, 'savings_amount:0 (already at/under the floor) => plain retail, no badge');
    assert.equal(
        B.describeOffer({ sku: 'X', found: true, retail_price: 10, business_price: null, savings_amount: 2 }),
        null, 'unusable business_price => no panel rather than "$null"');
});

test('formatPercent: 15 -> "15%", 6.3 -> "6.3%"', () => {
    const B = loadBusiness();
    assert.equal(B.formatPercent(15), '15%', 'whole numbers must not render as 15.0%');
    assert.equal(B.formatPercent(15.0), '15%', 'a float-typed whole number is still whole');
    assert.equal(B.formatPercent(6.3), '6.3%', 'one decimal is preserved');
    assert.equal(B.formatPercent(NaN), '', 'junk renders nothing, not "NaN%"');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Batching + de-duplication
// ═════════════════════════════════════════════════════════════════════════════

test('normalizeSkus: trims, drops blanks, de-dupes, preserves order', () => {
    const B = loadBusiness();
    assert.deepEqual(
        B.normalizeSkus(['  A ', 'B', 'A', '', null, 'C', undefined, '   ']),
        ['A', 'B', 'C'],
        'a grid that repeats a SKU must not burn quota or breach the 100 cap');
    assert.deepEqual(B.normalizeSkus(null), [], 'junk input yields an empty list, not a throw');
});

test('chunk: splits at MAX_SKUS_PER_CALL = 100 (the backend contract cap)', () => {
    const B = loadBusiness();
    assert.equal(B.MAX_SKUS_PER_CALL, 100, 'handoff: max 100 SKUs per call');

    const many = Array.from({ length: 250 }, (_, i) => 'SKU' + i);
    const chunks = B.chunk(many, B.MAX_SKUS_PER_CALL);
    assert.equal(chunks.length, 3, '250 SKUs must become 3 calls');
    assert.deepEqual(chunks.map(c => c.length), [100, 100, 50], 'no chunk may exceed 100');
    assert.deepEqual(chunks.flat(), many, 'chunking must not lose or reorder a SKU');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Status gating
// ═════════════════════════════════════════════════════════════════════════════

test('readStatus: recognises a tier, and an explicit negative always wins', () => {
    const B = loadBusiness();
    assert.deepEqual(B.readStatus({ pricing_tier: 'gold' }), { active: true, tier: 'gold' },
        'a recognised tier means an active business account');
    assert.deepEqual(B.readStatus({ active: true, pricing_tier: 'Silver' }), { active: true, tier: 'silver' },
        'tier is normalised to lower case');
    assert.deepEqual(B.readStatus({ active: false, pricing_tier: 'gold' }), { active: false, tier: null },
        'active:false beats a stale tier — a revoked account must NOT get business prices');
    assert.deepEqual(B.readStatus({ status: 'suspended', pricing_tier: 'gold' }), { active: false, tier: null },
        'a non-active status beats a stale tier');
    assert.deepEqual(B.readStatus({}), { active: false, tier: null }, 'empty payload => retail');
    assert.deepEqual(B.readStatus(null), { active: false, tier: null }, 'null payload => retail');
    assert.deepEqual(B.readStatus({ pricing_tier: 'platinum' }), { active: false, tier: null },
        'an unrecognised tier is not silently honoured');
});

test('readStatus: LIVE payload — status:"approved" must grant business pricing', () => {
    const B = loadBusiness();
    // Regression guard for the real bug: an earlier draft tested
    // `status === 'active'` (the handoff's prose word) and denied pricing to
    // every genuinely approved account. Caught only in the browser.
    assert.deepEqual(B.readStatus(LIVE_STATUS), { active: true, tier: 'bronze' },
        'the production status value is "approved", NOT "active"');
    assert.ok(B.ACTIVE_STATUSES.includes('approved'),
        '"approved" must stay on the allow-list');
});

test('readStatus: applications that are not yet approved get retail', () => {
    const B = loadBusiness();
    for (const status of ['pending', 'submitted', 'rejected', 'suspended', 'closed']) {
        assert.deepEqual(B.readStatus({ ...LIVE_STATUS, status }), { active: false, tier: null },
            `status:"${status}" must NOT unlock business pricing`);
    }
});

test('describeOffer: LIVE pricing item renders the real charged price', () => {
    const B = loadBusiness();
    assert.deepEqual(B.describeOffer(LIVE_PRICING_ITEM), {
        businessPrice: 34, retailPrice: 35.79, savings: 1.79, percent: 5, floored: false
    }, 'verified in-browser as "Your business price $34.00 retail $35.79 Save $1.79 (5%)"');
});

test('business.js: guests never fire a business request', () => {
    assert.match(BUSINESS_CODE, /if\s*\(!this\._isAuthenticated\(\)\)\s*return INACTIVE/,
        'getStatus must short-circuit before any request for a signed-out visitor');
    assert.match(BUSINESS_CODE, /if\s*\(!status\.active\)\s*return result/,
        'getPricing must short-circuit for a non-business account');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Fail-soft must be LOUD — `missed` lives in the return value
// ═════════════════════════════════════════════════════════════════════════════

/** Put the module into a signed-in, active-business state. */
function asBusinessUser(B, apiGet) {
    B.__auth.user = { id: 'user-1' };
    B.__auth.isAuthenticated = () => true;
    B.__api.get = apiGet;
    B.reset();
    return B;
}

test('getPricing: a failed call reports `missed`, never a silent empty result', async () => {
    const B = loadBusiness();
    // Backend down: api.js resolves 5xx as { ok:false } rather than throwing.
    asBusinessUser(B, async (url) => url.includes('/status')
        ? { ok: true, data: { pricing_tier: 'gold' } }
        : { ok: false, code: 'SERVER_ERROR' });

    const res = await B.getPricing(['A', 'B']);
    assert.equal(res.items.size, 0, 'a failed call yields no items');
    assert.deepEqual(res.missed, ['A', 'B'],
        'and it MUST say so — an empty items map alone reads as "no business discount"');
});

test('getPricing: a thrown error also lands in `missed`', async () => {
    const B = loadBusiness();
    asBusinessUser(B, async (url) => {
        if (url.includes('/status')) return { ok: true, data: { pricing_tier: 'gold' } };
        throw new Error('network down');
    });

    const res = await B.getPricing(['A']);
    assert.deepEqual(res.missed, ['A'], 'an exception must not silently become "no discount"');
});

test('getPricing: found:false is kept as a real answer, NOT a miss', async () => {
    const B = loadBusiness();
    asBusinessUser(B, async (url) => url.includes('/status')
        ? { ok: true, data: { pricing_tier: 'gold' } }
        : { ok: true, data: PRICING_FIXTURE });

    const res = await B.getPricing(['GTN251BK', 'GTN251C', 'NOPE-1']);
    assert.equal(res.missed.length, 0, 'the server answered for every SKU — nothing is missed');
    assert.equal(res.items.get('NOPE-1').found, false,
        'found:false is a real, trustworthy answer: this SKU is not in the catalog');
    assert.equal(res.items.get('GTN251C').business_price, 112.49, 'floored item survives intact');
    assert.equal(res.tier, 'gold', 'the tier travels with the result');
});

test('getPricing: a SKU the server never answered for is a miss, not a "no discount"', async () => {
    const B = loadBusiness();
    // Ask for 2, server returns only 1 row.
    asBusinessUser(B, async (url) => url.includes('/status')
        ? { ok: true, data: { pricing_tier: 'gold' } }
        : { ok: true, data: { items: [PRICING_FIXTURE.items[0]] } });

    const res = await B.getPricing(['GTN251BK', 'GHOST']);
    assert.deepEqual(res.missed, ['GHOST'],
        'a silently dropped SKU must surface as missed, or it masquerades as a healthy zero');
});

test('getPricing: a guest fires NO request at all', async () => {
    const B = loadBusiness();
    let calls = 0;
    B.__api.get = async () => { calls++; return { ok: true, data: {} }; };
    B.reset();

    const res = await B.getPricing(['A', 'B']);
    assert.equal(calls, 0, 'signed-out visitors must never hit /api/business/*');
    assert.equal(res.items.size, 0, 'and get nothing back');
    assert.equal(res.missed.length, 0,
        'not a MISS either — a guest having no business price is correct, not a failure');
});

test('getPricing: a retail (non-business) signed-in user fires status only, never pricing', async () => {
    const B = loadBusiness();
    const urls = [];
    asBusinessUser(B, async (url) => {
        urls.push(url);
        return url.includes('/status') ? { ok: true, data: { active: false } } : { ok: true, data: {} };
    });

    const res = await B.getPricing(['A']);
    assert.deepEqual(urls, ['/api/business/status'], 'no pricing call for a retail account');
    assert.equal(res.items.size + res.missed.length, 0, 'nothing shown, nothing flagged');
});

test('getPricing: 250 SKUs become exactly 3 calls, each within the 100 cap', async () => {
    const B = loadBusiness();
    const batches = [];
    asBusinessUser(B, async (url) => {
        if (url.includes('/status')) return { ok: true, data: { pricing_tier: 'gold' } };
        const skus = decodeURIComponent(url.split('skus=')[1]).split(',');
        batches.push(skus.length);
        return { ok: true, data: { items: skus.map(sku => ({ sku, found: false })) } };
    });

    const many = Array.from({ length: 250 }, (_, i) => 'SKU' + i);
    const res = await B.getPricing(many);
    assert.deepEqual(batches.sort((a, b) => b - a), [100, 100, 50], 'batched to the contract cap');
    assert.equal(res.items.size, 250, 'every SKU accounted for');
    assert.equal(res.missed.length, 0, 'and none lost in the chunking');
});

test('getPricing: the second call for the same SKU is served from cache', async () => {
    const B = loadBusiness();
    let pricingCalls = 0;
    asBusinessUser(B, async (url) => {
        if (url.includes('/status')) return { ok: true, data: { pricing_tier: 'gold' } };
        pricingCalls++;
        return { ok: true, data: PRICING_FIXTURE };
    });

    await B.getPricing(['GTN251BK']);
    await B.getPricing(['GTN251BK']);
    assert.equal(pricingCalls, 1, 'a repeat request must not re-hit the API');
});

test('business.js: `missed` is a declared part of the return value and is warned about', () => {
    assert.match(BUSINESS_CODE, /const result = \{ items: new Map\(\), missed: \[\]/,
        'getPricing must build a result carrying BOTH items and missed');
    assert.match(BUSINESS_CODE, /if \(result\.missed\.length\)[\s\S]{0,200}DebugLog\.warn/,
        'a partial result must be announced, not swallowed');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Per-account safety — no cross-user leakage
// ═════════════════════════════════════════════════════════════════════════════

test('business.js: business prices are NEVER written to web storage', () => {
    assert.doesNotMatch(BUSINESS_CODE, /localStorage/,
        'business prices are per-account and must not survive in shared browser storage');
    assert.doesNotMatch(BUSINESS_CODE, /sessionStorage/,
        'ditto sessionStorage — the handoff forbids caching across users');
});

test('business.js: the cache is dropped whenever the signed-in user changes', () => {
    assert.match(BUSINESS_CODE, /_syncCacheOwner\(\)\s*\{[\s\S]*?this\.reset\(\)/,
        'a user-id mismatch must bin the cache before it can be read');
    assert.match(BUSINESS_CODE, /Auth\.onAuthStateChange\(\(\)\s*=>\s*this\.reset\(\)\)/,
        'sign-in/sign-out must also reset');
    assert.match(BUSINESS_CODE, /reset\(\)\s*\{[\s\S]*?_priceCache\.clear\(\)/,
        'reset must actually clear the price cache');
});

test('cache owner switch: user B never sees user A prices', () => {
    const B = loadBusiness();
    let uid = 'user-A';
    B._userId = () => uid;

    B._syncCacheOwner();
    B._priceCache.set('GTN251BK', PRICING_FIXTURE.items[0]);
    assert.equal(B._priceCache.size, 1, 'user A cached a price');

    uid = 'user-B';
    B._syncCacheOwner();
    assert.equal(B._priceCache.size, 0, 'switching user MUST empty the cache');

    uid = null; // signed out
    B._priceCache.set('GTN251BK', PRICING_FIXTURE.items[0]);
    B._syncCacheOwner();
    assert.equal(B._priceCache.size, 0, 'signing out MUST empty the cache');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. NO client-side price reconstruction anywhere
// ═════════════════════════════════════════════════════════════════════════════

test('no surface recomputes a business price from the tier percent', () => {
    const surfaces = {
        'business.js': BUSINESS_CODE,
        'product-detail-page.js': stripComments(PDP_SRC),
        'cart.js': CART_CODE,
        'checkout-page.js': stripComments(JS('checkout-page.js')),
        'payment-page.js': stripComments(JS('payment-page.js')),
        'products.js': stripComments(JS('products.js'))
    };
    // Any arithmetic that divides a tier/discount percent by 100 is the
    // signature of a client-side reconstruction.
    const BANNED = [
        /tier_percent\s*\/\s*100/,
        /discount_percent\s*\/\s*100/,
        /effective_percent\s*\/\s*100/,
        /retail_price\s*\*\s*\(/,
        /business_price\s*=\s*[^;]*retail/
    ];
    for (const [name, code] of Object.entries(surfaces)) {
        for (const re of BANNED) {
            assert.doesNotMatch(code, re,
                `${name} must not derive a business price (${re}) — the loss floor makes it wrong`);
        }
    }
});

test('business.js documents the ceiling-not-guarantee rule', () => {
    assert.match(BUSINESS_SRC, /CEILING, not a guarantee/,
        'the reason this module never computes prices must be stated where the next dev will read it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Cart summary breakdown — one shared helper, no double counting
// ═════════════════════════════════════════════════════════════════════════════

test('computeDiscountBreakdown: splits the aggregate without double-counting', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const b = computeDiscountBreakdown({
        discount: 30.00,
        loyalty_discount_amount: 5.00,
        b2b_discount: B2B_BLOCK
    });
    assert.equal(b.loyalty, 5.00, 'loyalty component');
    assert.equal(b.b2b, 18.60, 'b2b component, verbatim from the API');
    assert.equal(Number(b.other.toFixed(2)), 6.40, 'You Save = 30.00 - 5.00 - 18.60, so nothing is counted twice');
    assert.equal(Number((b.loyalty + b.b2b + b.other).toFixed(2)), b.total, 'the three rows must sum to the aggregate');
});

test('computeDiscountBreakdown: LIVE shape — number in summary, object at top level', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    // The exact call cart.js/payment-page.js make against the real payload.
    const b = computeDiscountBreakdown(LIVE_CART.summary, undefined, LIVE_CART.b2b_discount);

    assert.equal(b.b2b, 4.68, 'the amount must be found even though summary.b2b_discount is a NUMBER');
    assert.equal(b.b2bMeta.pricing_tier, 'bronze', 'the tier must come from the top-level OBJECT');
    assert.equal(b.other, 0,
        'live: discount === b2b, so nothing is left for "You Save" — the row must hide, ' +
        'proving summary.discount INCLUDES the B2B amount');

    const { businessDiscountLabel } = loadCartHelpers();
    assert.equal(businessDiscountLabel(b.b2bMeta), 'Business account (Bronze tier)',
        'verified in-browser on /cart and /checkout');
});

test('computeDiscountBreakdown: numeric-only payload still yields the amount', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    // If the backend ever stops sending the top-level object, the money must
    // still be right — only the tier name degrades.
    const b = computeDiscountBreakdown(LIVE_CART.summary);
    assert.equal(b.b2b, 4.68, 'the bare number is a valid amount source');
    assert.equal(b.b2bMeta, null, 'no object => no tier label, but the row still renders');
});

test('computeDiscountBreakdown: documented (object-in-summary) shape also works', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    // If the backend later aligns with its own doc, nothing here breaks.
    const b = computeDiscountBreakdown({ discount: 18.60, b2b_discount: B2B_BLOCK });
    assert.equal(b.b2b, 18.60, 'object-in-summary must keep working');
    assert.equal(b.b2bMeta.pricing_tier, 'gold', 'and still supply the tier');
});

test('cart.js: the response-level b2b object is normalised into the summary', () => {
    // One boundary fix, so all ~15 `this.serverSummary = parsed.summary`
    // assignments carry the tier without being touched individually.
    assert.match(CART_CODE, /summary\.b2b_discount = responseData\.b2b_discount/,
        '_parseServerCart must fold the top-level object into the summary');
});

test('computeDiscountBreakdown: "other" can never go negative', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    // Defensive: if the backend ever reports components exceeding the aggregate
    // we must not render "-$-4.00".
    const b = computeDiscountBreakdown({
        discount: 10.00,
        loyalty_discount_amount: 6.00,
        b2b_discount: { discount_amount: 8.00 }
    });
    assert.equal(b.other, 0, 'clamped at zero, so the You Save row simply hides');
});

test('computeDiscountBreakdown: absent b2b block is 0, not NaN', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    for (const summary of [null, undefined, {}, { discount: 12 }, { b2b_discount: null }]) {
        const b = computeDiscountBreakdown(summary);
        assert.equal(b.b2b, 0, 'guest / retail carts carry b2b_discount:null — must read as 0');
        assert.equal(b.b2bMeta, null, 'and no meta');
        assert.ok(Number.isFinite(b.other), 'other must stay a real number');
    }
});

test('computeDiscountBreakdown: floored meta survives for the explainer note', () => {
    const { computeDiscountBreakdown } = loadCartHelpers();
    const b = computeDiscountBreakdown({ discount: 18.60, b2b_discount: B2B_BLOCK });
    assert.equal(b.b2bMeta.floored_line_count, 1, 'floored_line_count drives the "best possible price" note');
    assert.equal(b.b2bMeta.effective_percent, 12.4, 'realised % must be available to render');
    assert.equal(b.b2bMeta.discount_percent, 15, 'the ceiling is carried but is NOT what gets shown');
});

test('businessDiscountLabel: names the tier, degrades gracefully', () => {
    const { businessDiscountLabel } = loadCartHelpers();
    assert.equal(businessDiscountLabel(B2B_BLOCK), 'Business account (Gold tier)', 'tier is title-cased');
    assert.equal(businessDiscountLabel({}), 'Business account', 'no tier => plain label, never "undefined tier"');
    assert.equal(businessDiscountLabel(null), 'Business account', 'null meta => plain label');
});

test('cart.js: BOTH summary renderers go through the one shared helper', () => {
    const calls = CART_CODE.match(/this\._renderDiscountRows\(/g) || [];
    assert.equal(calls.length, 2,
        'renderCartPage() and _updateCartSummaryDOM() must both delegate — they had drifted, ' +
        'and only the surgical path rendered/netted the loyalty row (ERR-110)');

    // The old divergent inline blocks must be gone from both paths.
    assert.doesNotMatch(CART_CODE, /const loyaltyDiscount = \(this\.serverSummary/,
        'the inline loyalty netting must live only inside the shared helper');
    assert.match(CART_CODE, /_renderDiscountRows: function\(discount\)/,
        'the shared helper must exist');
    assert.match(CART_CODE, /setRow\('cart-b2b-row', 'cart-b2b-discount'/,
        'the helper must render the business-account row');
});

test('cart.js: the floored note uses effective_percent, never the tier ceiling', () => {
    const helper = CART_CODE.slice(
        CART_CODE.indexOf('_renderDiscountRows: function'),
        CART_CODE.indexOf('_updateCartSummaryDOM: function')
    );
    assert.ok(helper.length > 200, 'sanity: the helper body was located');
    assert.match(helper, /effective_percent/, 'the realised % is what gets shown');
    assert.doesNotMatch(helper, /discount_percent/,
        'the tier ceiling must never be rendered — on a floored cart it is not what the customer got');
    assert.match(helper, /best possible price/,
        'flooring must be explained, not left as an unexplained shortfall');
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. PDP — additive panel, microdata untouched
// ═════════════════════════════════════════════════════════════════════════════

test('PDP: renders the business panel and is wired into renderProduct', () => {
    assert.match(PDP_SRC, /async renderBusinessPrice\(info\)/, 'the panel renderer must exist');
    assert.match(PDP_SRC, /this\.renderBusinessPrice\(info\);/, 'and must be called during render');
    assert.match(PDP_SRC, /Business\.describeOffer\(item\)/, 'display model comes from the shared helper');
    assert.match(PDP_SRC, /id="business-price"/, 'panel carries a stable id');
});

test('PDP: itemprop="price" microdata still carries RETAIL, not the business price', () => {
    // The buy-box <dl> mirrors the backend prerender and feeds Merchant Center.
    // Writing a per-account price into it would be cloaking.
    assert.match(PDP_SRC, /priceEl\.setAttribute\('content', price\.toFixed\(2\)\)/,
        'the microdata price must still be the public retail price');

    const panel = pdpPanelSource();
    assert.ok(panel.length > 500, 'sanity: the panel body was located');
    assert.doesNotMatch(panel, /setAttribute\('content'/,
        'the business panel must never rewrite the schema.org price');
    assert.doesNotMatch(panel, /getElementById\('product-price'\)/,
        'the business panel must not touch the public price element at all');
    assert.match(panel, /insertAdjacentHTML\('afterend'/,
        'the panel is ADDITIVE — inserted outside the buy-box, replacing nothing');
});

test('PDP: the sticky buy-bar shows the BUSINESS price, not retail', () => {
    // Found in the browser: the sticky mobile Add-to-Cart bar mirrors
    // #product-price (which must stay at public retail for the itemprop
    // microdata), so it displayed $35.79 while the panel directly above it said
    // $34.00 — retail on the buy button, business price in the panel.
    assert.match(PDP_SRC, /if \(stickyPrice\.dataset\.businessLocked === '1'\) return;/,
        'the mirror must stand down once a business price owns the bar');
    assert.match(pdpPanelSource(), /stickyPrice\.dataset\.businessLocked = '1'/,
        'and the panel must claim it');
    assert.match(pdpPanelSource(), /stickyPrice\.textContent = formatPrice\(offer\.businessPrice\)/,
        'with the business price the cart will actually charge');
});

test('PDP: stale-navigation guard — never paint a price for a product you left', () => {
    const panel = pdpPanelSource();
    assert.match(panel, /this\.product\.sku !== sku/,
        'an in-flight response must be discarded if the shopper navigated away');
});

test('PDP: every rendered value is escaped', () => {
    const panel = pdpPanelSource();
    const interpolations = panel.match(/\$\{(?!\s*(?:pct|note)\s*\})[^}]*\}/g) || [];
    for (const expr of interpolations) {
        assert.match(expr, /Security\.escapeHtml/,
            `dynamic HTML must be escaped, unescaped interpolation found: ${expr}`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Summary rows exist on every funnel page
// ═════════════════════════════════════════════════════════════════════════════

test('cart / checkout / payment / confirmation all carry a business-account row', () => {
    assert.match(HTML('html/cart.html'), /id="cart-b2b-row"/, 'cart summary row');
    assert.match(HTML('html/cart.html'), /id="cart-b2b-note"/, 'cart floored-lines note');
    assert.match(HTML('html/checkout.html'), /id="checkout-b2b-row"/, 'checkout summary row');
    assert.match(HTML('html/payment.html'), /id="checkout-b2b-row"/, 'payment summary row');
    assert.match(HTML('html/order-confirmation.html'), /id="totals-b2b-row"/, 'confirmation row');
});

test('every business row ships hidden — retail shoppers must never glimpse it', () => {
    const rows = [
        ['html/cart.html', 'cart-b2b-row'],
        ['html/cart.html', 'cart-b2b-note'],
        ['html/checkout.html', 'checkout-b2b-row'],
        ['html/payment.html', 'checkout-b2b-row'],
        ['html/order-confirmation.html', 'totals-b2b-row'],
        ['html/account/index.html', 'dash-business-panel']
    ];
    for (const [file, id] of rows) {
        const html = HTML(file);
        const tag = html.slice(html.indexOf(`id="${id}"`));
        const end = tag.indexOf('>');
        assert.match(tag.slice(0, end), /\bhidden\b/,
            `${file} #${id} must ship with the hidden attribute`);
    }
});

test('checkout-page.js reads the B2B discount from the server, never derives it', () => {
    const src = JS('checkout-page.js');
    assert.match(src, /Cart\.serverSummary/,
        'checkout estimates other totals locally, but a floored per-line discount CANNOT be estimated');
    assert.match(src, /computeDiscountBreakdown\(serverSummary\)/,
        'it must go through the one shared breakdown helper');
    assert.match(src, /this\.totals\.b2bDiscount \|\| 0\)/,
        'and subtract it from the displayed total');
});

test('payment-page.js nets B2B out of the generic discount line', () => {
    const src = JS('payment-page.js');
    assert.match(src, /computeDiscountBreakdown\(summary, this\.totals\.discount, cartData\.b2b_discount\)/,
        'payment reads the real cart summary AND the response-level b2b object — ' +
        'shared helper, no local re-derivation');
    assert.match(src, /checkout-b2b-row/, 'and renders the row');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Listing tiles + account panel + assets
// ═════════════════════════════════════════════════════════════════════════════

test('both card renderers expose data-sku so the overlay can find them', () => {
    assert.match(JS('products.js'), /data-sku="\$\{Security\.escapeAttr\(product\.sku\)\}"/,
        'products.js cards already carried data-sku');
    assert.match(JS('shop-page.js'), /card\.setAttribute\('data-sku', product\.sku\)/,
        'shop-page.js cards did NOT — the overlay cannot match them without it');
});

test('grids invoke the overlay after render', () => {
    assert.match(JS('products.js'), /this\.decorateBusinessPricing\(container\)/,
        'products.js grids must decorate');
    assert.match(JS('shop-page.js'), /Business\.decorateCards\(container\)/,
        'shop-page.js grid must decorate');
    assert.match(BUSINESS_CODE, /if \(!\(await this\.isActive\(\)\)\) return 0/,
        'and the overlay must cost a guest nothing');
});

test('decorateCards never double-decorates an already-decorated card', () => {
    assert.match(BUSINESS_CODE, /!card\.querySelector\('\.product-card__biz-price'\)/,
        're-rendering a grid must not stack duplicate business prices');
});

test('account dashboard: business panel is gated on an active account', () => {
    assert.match(JS('account.js'), /async loadBusinessStatus\(\)/, 'loader must exist');
    assert.match(JS('account.js'), /this\.loadBusinessStatus\(\);/, 'and be called from loadDashboard');
    assert.match(JS('account.js'), /if \(!active\) return;/,
        'retail customers must never see the panel');
    assert.match(HTML('html/account/index.html'), /id="dash-business-panel"/, 'panel markup present');
});

test('CSS: business surfaces are styled and hide cleanly', () => {
    const css = CSS('pages.css');
    for (const cls of ['.business-price', '.business-panel', '.product-card__biz-price',
        '.cart-summary__row--b2b', '.checkout-summary__row--b2b', '.confirmation-totals__row--b2b']) {
        assert.ok(css.includes(cls), `pages.css must style ${cls}`);
    }
    assert.match(css, /\.business-price\[hidden\]\s*\{\s*display:\s*none;/,
        'hidden panels must actually hide');
    assert.doesNotMatch(css.slice(css.indexOf('BUSINESS ACCOUNT PRICING')), /var\(--green-600/,
        '--green-600 is undefined repo-wide and always falls back; use --color-success-green');
});

test('business.js is loaded on every customer-facing page, after auth.js', () => {
    const pages = ['html/product/index.html', 'html/shop.html', 'html/cart.html',
        'html/checkout.html', 'html/payment.html', 'html/order-confirmation.html',
        'html/account/index.html', 'html/index.html', 'index.html'];
    for (const page of pages) {
        const html = HTML(page);
        assert.match(html, /src="\/js\/business\.js/, `${page} must load business.js`);
        assert.ok(html.indexOf('/js/auth.js') < html.indexOf('/js/business.js'),
            `${page}: defer preserves DOCUMENT ORDER, so auth.js must precede business.js`);
        assert.ok(html.indexOf('/js/api.js') < html.indexOf('/js/business.js'),
            `${page}: api.js must precede business.js`);
    }
});

test('business.js carries a build-stamped ?v= cache token', () => {
    // Bumped by `npm run build` (md5 of contents). Never pin the token itself.
    assert.match(HTML('html/product/index.html'), /\/js\/business\.js\?v=[0-9a-f]{8}/,
        'business.js must be cache-busted like every other asset — run npm run build');
    assert.match(HTML('html/cart.html'), /\/js\/cart\.js\?v=[0-9a-f]{8}/,
        'cart.js changed, so its token must have been restamped too');
});
