/**
 * PUBLIC VOLUME PRICING (Aug 2026)
 * ================================
 * Volume pricing stopped being a business-account privilege. Every shopper —
 * signed-out guests included — sees the quantity ladder and is charged it.
 *
 * Brief: public-volume-pricing-backend-brief-aug2026.md (BF-032…BF-038)
 * Sibling suite: business-account-pricing-jul2026.test.js still owns the ladder
 * MATHS (collapsing, flooring, effective_percent). This file owns the question
 * that changed: WHO gets a ladder, and what it costs to give them one.
 *
 * The four properties worth breaking a build over:
 *
 *   1. A guest gets a ladder and fires ZERO requests to /api/business/*.
 *      The ladder rides on the catalog payload the page already fetched. If
 *      this regresses into a fetch, every grid paint gains a round-trip for
 *      100% of traffic to serve data that is public and edge-cacheable.
 *
 *   2. ABSENCE IS NOT AN EMPTY LADDER. A product with no `quantity_breaks` is a
 *      backend that has not shipped BF-032; a product with an empty array is
 *      "this band has no discount". Collapsing the two turns a missing feature
 *      into a confident "no discount available" — ERR-063/068/073/149.
 *
 *   3. The public cache survives an auth change; the per-account cache does
 *      NOT. Public prices are identical for everyone, so binning them on
 *      sign-in would blank every painted grid for no reason. Anything the
 *      AUTHED route returned still gets binned, so if a per-account rate is
 *      ever reintroduced it cannot leak to the next shopper.
 *
 *   4. A business account is not regressed. Until BF-032 ships there is no
 *      public ladder at all, and the legacy authed route has to keep them whole.
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

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const BUSINESS_SRC = JS('business.js');
const BUSINESS_CODE = stripComments(BUSINESS_SRC);
const PDP_SRC = JS('product-detail-page.js');
const PDP_CODE = stripComments(PDP_SRC);
const CART_SRC = JS('cart.js');
const CART_PAGE_SRC = JS('cart-page.js');
const CART_PAGE_CODE = stripComments(CART_PAGE_SRC);
const CHECKOUT_SRC = JS('checkout-page.js');
const CHECKOUT_CODE = stripComments(CHECKOUT_SRC);

/**
 * Pull one top-level `function name(...) {...}` out of a source file by
 * brace-matching. Same technique as business-account-pricing-jul2026.test.js —
 * running all of cart-page.js would need a full DOM.
 */
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must be a top-level function declaration`);
    let depth = 0;
    let i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1) + (open === -1 ? '' : '');
}

/** The coupon-clamp helpers, actually executed. */
function loadClampHelpers() {
    // couponClampText() closes over the module-level fallback constant, so it
    // has to come along or the fallback path throws instead of returning copy.
    const copyLine = CART_PAGE_SRC.match(/^const COUPON_CLAMPED_COPY = .*$/m);
    assert.ok(copyLine, 'the clamp fallback copy must be a module-level const');

    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(
        copyLine[0] + '\n' +
        extractFunction(CART_PAGE_SRC, 'isCouponClamped') + '\n' +
        extractFunction(CART_PAGE_SRC, 'couponClampText') + '\n' +
        ';globalThis.__c = isCouponClamped; globalThis.__t = couponClampText;',
        sandbox
    );
    return { isCouponClamped: sandbox.__c, couponClampText: sandbox.__t };
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness — mirrors business-account-pricing-jul2026.test.js so the two suites
// drive the module the same way. `__calls` records every API URL, which is how
// "a guest fires no request" is asserted as a FACT rather than an intention.
// ─────────────────────────────────────────────────────────────────────────────
function loadBusiness() {
    const auth = { initialized: true, user: null, isAuthenticated: () => false, onAuthStateChange() {} };
    const calls = [];
    const api = { get: async (url) => { calls.push(url); return { ok: false }; } };
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
    B.__calls = calls;
    B.__warnings = warnings;
    return B;
}

/** Sign the harness in as an approved business account. */
function signInAsBusiness(B, pricingData) {
    B.__auth.user = { id: 'u-1' };
    B.__auth.isAuthenticated = () => true;
    B.__api.get = async (url) => {
        B.__calls.push(url);
        if (url.indexOf('/api/business/status') === 0) {
            return { ok: true, data: { status: 'approved', application: { company_name: 'Acme Print Co' } } };
        }
        return pricingData ? { ok: true, data: pricingData } : { ok: false };
    };
    return B;
}

/**
 * A live-shaped catalog product carrying the public ladder (BF-032).
 *
 * The rungs are derived from `retail` rather than hardcoded: describeLadder()
 * drops any rung priced at or above retail, so a fixture with fixed prices and a
 * variable retail silently produces an EMPTY ladder — which looks identical to
 * the feature being broken. The live shape at $22.49 is the 4/7/8 band.
 */
function productWithLadder(sku = 'CLC133CMY', retail = 22.49) {
    const rung = (min, pct) => {
        const price = Math.round(retail * (1 - pct / 100) * 100) / 100;
        return {
            min_quantity: min,
            discount_percent: pct,
            business_price: price,
            effective_percent: pct,
            savings_amount: Math.round((retail - price) * 100) / 100,
            floored: false
        };
    };
    return {
        sku,
        name: 'Compatible Brother LC133 CMY 3-pack',
        retail_price: retail,
        price_includes_gst: true,
        quantity_breaks: [rung(3, 3), rung(4, 4), rung(7, 7), rung(8, 9)]
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// A DOM small enough to be honest about: only what the decorators actually use.
// ─────────────────────────────────────────────────────────────────────────────
function fakeCard(sku) {
    const card = {
        _sku: sku,
        _html: '',
        _children: {},
        getAttribute: (n) => (n === 'data-sku' ? sku : (n === 'data-quantity' ? '1' : null)),
        querySelector(sel) {
            if (sel === '.product-card__price-block') return card._priceBlock;
            if (sel === '.product-card__biz-price') {
                return card._priceBlock._html.indexOf('product-card__biz-price') !== -1 ? {} : null;
            }
            return null;
        }
    };
    card._priceBlock = {
        _html: '',
        querySelector: () => (card._priceBlock._html.indexOf('product-card__biz-price') !== -1 ? {} : null),
        insertAdjacentHTML(_pos, html) { card._priceBlock._html += html; }
    };
    return card;
}

function fakeGrid(cards) {
    return { querySelectorAll: (sel) => (sel.indexOf('product-card') !== -1 ? cards : []) };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. A guest gets a ladder, and it costs nothing
// ═════════════════════════════════════════════════════════════════════════════

test('a signed-out guest gets a ladder from the catalog payload, with ZERO requests', async () => {
    const B = loadBusiness();
    assert.equal(B.__auth.isAuthenticated(), false, 'this test is about a guest');

    assert.equal(B.ingest(productWithLadder()), 1);

    const ladder = await B.getLadderFor('CLC133CMY');
    assert.ok(ladder, 'a guest must get a ladder');
    assert.equal(ladder.entry.minQuantity, 3);
    assert.equal(ladder.entry.businessPrice, 21.82);
    assert.equal(ladder.best.businessPrice, 20.47);

    assert.deepEqual(B.__calls, [],
        'the ladder is public data on a payload we already had — fetching it would add a ' +
        'round-trip to every grid paint for every visitor');
});

test('the guest path never touches /api/business/* even when many SKUs are asked for', async () => {
    const B = loadBusiness();
    B.ingest([productWithLadder('A', 20), productWithLadder('B', 30), productWithLadder('C', 40)]);

    const { items, missed } = await B.getPricing(['A', 'B', 'C']);
    assert.equal(items.size, 3);
    assert.deepEqual(missed, [], 'a resolved SKU is not a miss');
    assert.deepEqual(B.__calls, []);
});

test('an un-ingested SKU is silent retail for a guest — not a miss, not a request', async () => {
    const B = loadBusiness();
    B.ingest(productWithLadder('A', 20));

    const { items, missed } = await B.getPricing(['A', 'UNKNOWN-1']);
    assert.equal(items.size, 1);
    assert.deepEqual(missed, [],
        'a guest was never promised a ladder for that SKU; calling it a MISS would ' +
        'make the console shout on every ordinary page');
    assert.deepEqual(B.__calls, [], 'and it must not go looking');
    assert.equal(await B.getLadderFor('UNKNOWN-1'), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Absence is not an empty ladder
// ═════════════════════════════════════════════════════════════════════════════

test('ingest IGNORES a product with no quantity_breaks — a missing field is not "no discount"', async () => {
    const B = loadBusiness();
    const notShippedYet = { sku: 'X1', retail_price: 22.49 };   // pre-BF-032 payload

    assert.equal(B.ingest(notShippedYet), 0, 'nothing to take in');
    assert.equal(B._ladderCache.has('X1'), false,
        'storing it would answer "no discount" to every later question about X1, ' +
        'including the authed fallback a business account still depends on');
});

test('ingest DOES store an empty quantity_breaks — that is a real answer', async () => {
    const B = loadBusiness();
    assert.equal(B.ingest({ sku: 'X2', retail_price: 22.49, quantity_breaks: [] }), 1);
    assert.equal(B._ladderCache.has('X2'), true);

    // describeLadder still returns null (nothing to render) — but silently,
    // because "this band has no volume discount" is documented and legitimate.
    assert.equal(await B.getLadderFor('X2'), null);
    assert.deepEqual(B.__warnings, [], 'an empty band is not a payload we failed to understand');
});

test('a business account still reaches the authed route for a SKU ingest could not answer', async () => {
    const B = loadBusiness();
    signInAsBusiness(B, {
        source: 'volume',
        items: [{
            sku: 'X1', found: true, is_active: true, retail_price: 22.49,
            quantity_breaks: [{ min_quantity: 3, business_price: 21.82, effective_percent: 3, savings_amount: 0.67 }]
        }]
    });
    B.ingest({ sku: 'X1', retail_price: 22.49 });   // no quantity_breaks — must not shadow

    const ladder = await B.getLadderFor('X1');
    assert.ok(ladder, 'an approved account must not lose pricing before BF-032 ships');
    assert.ok(B.__calls.some(u => u.indexOf('/api/business/pricing') === 0),
        'the legacy route is the compatibility path and must still be consulted');
});

test('ingest is defensive about junk and never throws', () => {
    const B = loadBusiness();
    const junk = [null, undefined, 42, 'nope', {}, { sku: '' }, { sku: 'A' },
        { sku: 'A', retail_price: 0, quantity_breaks: [] },
        { sku: 'A', retail_price: -1, quantity_breaks: [] },
        { sku: 'A', retail_price: 'abc', quantity_breaks: [] },
        { sku: 'A', retail_price: 10, quantity_breaks: 'not-an-array' }];
    assert.equal(B.ingest(junk), 0);
    assert.equal(B.ingest(null), 0);
    assert.equal(B.ingest(undefined), 0);
    assert.equal(B._ladderCache.size, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Two caches, and the split is a safety property
// ═════════════════════════════════════════════════════════════════════════════

test('the PUBLIC ladder survives an auth change; the per-account cache does not', async () => {
    const B = loadBusiness();
    B.ingest(productWithLadder('A', 20));
    B._priceCache.set('SECRET', { sku: 'SECRET', found: true, retail_price: 99, quantity_breaks: [] });

    B.reset();   // what Auth.onAuthStateChange fires

    assert.equal(B._ladderCache.has('A'), true,
        'a public price cannot change because someone signed in — and binning it would ' +
        'blank every grid already painted at the moment the session resolves');
    assert.equal(B._priceCache.size, 0,
        'anything the AUTHED route returned still goes, so a per-account rate could ' +
        'never survive into the next shopper\'s session');

    const ladder = await B.getLadderFor('A');
    assert.ok(ladder, 'and the public ladder still renders after the reset');
});

test('signing in does not discard a public ladder mid-session', async () => {
    const B = loadBusiness();
    B.ingest(productWithLadder('A', 20));
    assert.ok(await B.getLadderFor('A'));

    B.__auth.user = { id: 'u-9' };
    B.__auth.isAuthenticated = () => true;
    B._syncCacheOwner();   // the guard every cache read runs through

    assert.ok(await B.getLadderFor('A'), 'the ladder must not blink out on sign-in');
});

test('reset() does not mention the public cache — the omission is deliberate and documented', () => {
    const body = BUSINESS_SRC.slice(BUSINESS_SRC.indexOf('reset() {'));
    const fn = body.slice(0, body.indexOf('\n    },') + 1);
    assert.doesNotMatch(stripComments(fn), /_ladderCache/,
        'clearing it would be the regression this whole test guards');
    assert.match(BUSINESS_SRC, /_ladderCache` is deliberately NOT cleared/,
        'and the next reader must be told why, or they will "fix" it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. No auth handshake in front of a public price
// ═════════════════════════════════════════════════════════════════════════════

test('getPricing resolves the public ladder BEFORE it ever asks about the account', async () => {
    const B = loadBusiness();
    let statusAsked = false;
    B.__auth.initialized = false;                   // Auth still booting
    B.__auth.isAuthenticated = () => { statusAsked = true; return false; };
    B.ingest(productWithLadder('A', 20));

    const { items } = await B.getPricing(['A']);
    assert.equal(items.size, 1);
    assert.equal(statusAsked, false,
        'getStatus() awaits Auth for up to 3 SECONDS — queueing a guest grid paint ' +
        'behind an auth handshake to render a public price would be absurd');
});

test('the public branch is physically ahead of the getStatus gate in the source', () => {
    const fn = BUSINESS_CODE.slice(BUSINESS_CODE.indexOf('async getPricing('));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    const ladderAt = body.indexOf('_ladderCache');
    const statusAt = body.indexOf('getStatus()');
    assert.ok(ladderAt !== -1 && statusAt !== -1);
    assert.ok(ladderAt < statusAt,
        'reordering these silently reintroduces the auth wait for every guest');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The decorators actually decorate for a guest
// ═════════════════════════════════════════════════════════════════════════════

test('decorateCards decorates a GUEST grid, with no request', async () => {
    const B = loadBusiness();
    B.ingest([productWithLadder('A', 22.49), productWithLadder('B', 30)]);

    const cards = [fakeCard('A'), fakeCard('B')];
    const decorated = await B.decorateCards(fakeGrid(cards));

    assert.equal(decorated, 2, 'both guest cards must carry a bulk price');
    assert.match(cards[0]._priceBlock._html, /Bulk price/);
    assert.match(cards[0]._priceBlock._html, /Buy 3\+/, 'a price with no quantity is a lie at qty 1');
    assert.deepEqual(B.__calls, []);
});

test('decorateCards no-ops for a guest with no ladder — and still fires no request', async () => {
    const B = loadBusiness();
    const cards = [fakeCard('A')];
    assert.equal(await B.decorateCards(fakeGrid(cards)), 0);
    assert.equal(cards[0]._priceBlock._html, '');
    assert.deepEqual(B.__calls, [],
        'the guard must short-circuit before the authed route, or every grid paint ' +
        'costs a status call for a visitor who has no account');
});

test('hasLadderFor is the cheap guard, and it is honest about a partial grid', () => {
    const B = loadBusiness();
    B.ingest(productWithLadder('A', 20));
    assert.equal(B.hasLadderFor(['A']), true);
    assert.equal(B.hasLadderFor(['B']), false);
    assert.equal(B.hasLadderFor(['B', 'A']), true, 'one ladder is reason enough to decorate');
    assert.equal(B.hasLadderFor([]), false);
    assert.equal(B.hasLadderFor(null), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Every surface that paints cards hands its payload over
// ═════════════════════════════════════════════════════════════════════════════

test('every grid that renders product cards ingests the payload it rendered from', () => {
    // Without ingest() the overlay silently falls back to business-accounts-only,
    // which looks exactly like the feature not being finished.
    const GRIDS = [
        ['shop-page.js', /Business\.ingest\(products\)/],
        ['ribbons-page.js', /Business\.ingest\(ribbons\)/],
        ['landing.js', /Business\.ingest\(products\)/],
        ['favourites.js', /Business\.ingest\(/],
        ['products.js', /Business\.ingest\(products\)/],
        ['filters.js', /decorateBusinessPricing\(productGrid, products\)/]
    ];
    for (const [file, re] of GRIDS) {
        assert.match(stripComments(JS(file)), re, `${file} must hand its payload to ingest()`);
    }
});

test('the shared products.js helper ingests before it decorates', () => {
    const code = stripComments(JS('products.js'));
    // Anchor on the DEFINITION (trailing brace), not the first call site.
    const fn = code.slice(code.indexOf('decorateBusinessPricing(container, products) {'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    const ingestAt = body.indexOf('Business.ingest');
    const decorateAt = body.indexOf('Business.decorateCards');
    assert.ok(ingestAt !== -1 && decorateAt !== -1);
    assert.ok(ingestAt < decorateAt, 'decorating before ingesting reads an empty cache');
});

test('the PDP ingests its own product before asking for the ladder', () => {
    const fn = PDP_CODE.slice(PDP_CODE.indexOf('async renderVolumePricing('));
    const body = fn.slice(0, fn.indexOf('\n        },'));
    const ingestAt = body.indexOf('Business.ingest(this.product)');
    const ladderAt = body.indexOf('Business.getLadderFor');
    assert.ok(ingestAt !== -1, 'the PDP holds the product; it must not re-fetch the ladder');
    assert.ok(ingestAt < ladderAt);
});

test('the cart ingests its own lines — /cart is a surface you can land on cold', () => {
    const code = stripComments(CART_SRC);
    const fn = code.slice(code.indexOf('decorateVolumeNudges: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /Business\.ingest\(/,
        'no grid or PDP has run on a direct visit to /cart, so nothing else has ' +
        'handed a ladder over — and the nudge is the whole point of a volume scheme');
    assert.ok(body.indexOf('Business.ingest') < body.indexOf('Business.decorateCartLines'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Copy: nothing public claims to be about business accounts
// ═════════════════════════════════════════════════════════════════════════════

test('the PDP block says "Buy more, save more", never "Business volume pricing"', () => {
    assert.match(PDP_SRC, /volume-pricing__eyebrow">Buy more, save more</);
    assert.doesNotMatch(PDP_CODE, /Business volume pricing/i);
});

test('the product-page container is not labelled a business surface for screen readers', () => {
    const html = HTML('html/product/index.html');
    const section = html.slice(html.indexOf('id="volume-pricing"') - 200, html.indexOf('id="volume-pricing"') + 300);
    assert.doesNotMatch(section, /aria-label="[^"]*[Bb]usiness/,
        'a guest using a screen reader would be told this is an account feature');
    assert.match(section, /aria-label="Quantity price breaks"/);
});

test('the card overlay label names no account type', () => {
    const B = loadBusiness();
    B.ingest(productWithLadder('A', 22.49));
    const html = B.cardMarkup(B.describeLadder(B._ladderCache.get('A')));
    assert.match(html, /Bulk price/);

    // Assert on what a SHOPPER reads, not the markup: the class names and the
    // `business-card-price` test id are internal and are pinned by the sibling
    // suite, so renaming them here would be churn with a cost and no benefit.
    const visible = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.doesNotMatch(visible, /[Bb]usiness/,
        `no visible word may claim an account type, read: "${visible}"`);
});

test('no storefront surface still advertises volume pricing as a business-only perk', () => {
    // /business and the account panel may describe the ACCOUNT; they may not
    // claim the ladder is something the account unlocks.
    const denied = HTML('html/business.html');
    const gate = denied.slice(denied.indexOf('id="business-denied"'), denied.indexOf('id="business-unavailable"'));
    assert.doesNotMatch(gate, /This area is for approved business accounts\. Volume pricing,/,
        'volume pricing is not gated any more, so it cannot head the gated list');

    const panel = HTML('html/account/index.html');
    const desc = panel.slice(panel.indexOf('business-panel__desc'), panel.indexOf('business-panel__desc') + 600);
    assert.doesNotMatch(desc, /%/, 'never promise a rate: the ladder is per-band and per-quantity');
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. What must NOT change
// ═════════════════════════════════════════════════════════════════════════════

test('#product-price microdata is still public qty-1 retail — a quantity price there is cloaking', () => {
    const fn = PDP_CODE.slice(PDP_CODE.indexOf('async renderVolumePricing('));
    const body = fn.slice(0, fn.indexOf('\n        },'));
    assert.doesNotMatch(body, /product-price/,
        'the ladder renders into #volume-pricing and must never touch the microdata price');
    assert.doesNotMatch(body, /itemprop/);
});

test('the coupon lock is still business-only and still fails OPEN', () => {
    for (const [name, code] of [['cart-page.js', CART_PAGE_CODE], ['checkout-page.js', CHECKOUT_CODE]]) {
        assert.match(code, /Business\.isActive\(\)/,
            `${name} must still gate the lock on the ACCOUNT, not on "this cart has a discount" — ` +
            'gating on the discount would silently kill promo codes for every shopper buying 3+');
    }
    // A failed status check must never lock a retail customer out of coupons.
    const lock = CART_PAGE_CODE.slice(CART_PAGE_CODE.indexOf('async function initBusinessCouponLock'));
    const body = lock.slice(0, lock.indexOf('\n}') + 2);
    assert.match(body, /catch[\s\S]{0,80}return;/,
        'an unreachable status endpoint must fail open, not lock the field');
});

test('the frontend still never computes a price', () => {
    const BANNED = [
        /retail[A-Za-z_]*\s*\*\s*\(\s*1\s*-/i,
        /\*\s*\(\s*1\s*-\s*[A-Za-z_.]*(percent|pct)/i,
        /(percent|pct)[A-Za-z_]*\s*\/\s*100\s*\*/i
    ];
    // ingest() is a new way for a price to enter the module — it must copy the
    // backend's rungs across verbatim and invent nothing.
    const fn = BUSINESS_CODE.slice(BUSINESS_CODE.indexOf('ingest(productOrList)'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    for (const re of BANNED) assert.doesNotMatch(body, re);
    assert.match(body, /quantity_breaks: p\.quantity_breaks/,
        'the rungs are passed through by reference — never rebuilt, never recomputed');
    assert.doesNotMatch(body, /discount_percent/, 'the ceiling has no place on a render path');
});

test('business prices are still never written to web storage', () => {
    const storage = BUSINESS_CODE.match(/(localStorage|sessionStorage)\.[a-zA-Z]+\(([^)]*)\)/g) || [];
    for (const hit of storage) {
        assert.match(hit, /HEADER_HINT_KEY/,
            `only the header hint may touch web storage, found: ${hit}`);
    }
});

test('the module still documents that guests fire no business request', () => {
    assert.match(BUSINESS_SRC, /guest therefore still fires ZERO requests/i,
        'this is the invariant the whole design turns on; say it where it will be read');
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. The cart parser carries the ladder through (ERR-150)
// ═════════════════════════════════════════════════════════════════════════════

test('_parseServerCart preserves quantity_breaks and retail_price on every line', () => {
    // The item map is a WHITELIST — every field not named is discarded. Omitting
    // these two made decorateVolumeNudges ingest `undefined` for every line, so
    // no cart nudge ever rendered, silently, for anyone (ERR-150).
    const fn = CART_SRC.slice(CART_SRC.indexOf('_parseServerCart: function'));
    const body = fn.slice(0, fn.indexOf('return { items'));
    assert.match(body, /quantity_breaks:\s*Array\.isArray\(item\.quantity_breaks\)/,
        'the line ladder must survive the parser');
    assert.match(body, /retail_price:\s*item\.product\.retail_price/,
        'the ladder is compared against retail, so retail must survive under its own name');
});

test('a server cart line ingests and produces a nudge for a guest', async () => {
    const B = loadBusiness();
    // The shape _parseServerCart now emits, with the live nesting: the ladder is
    // at the ITEM level while sku/retail_price come off item.product.
    const line = {
        sku: 'CLC133CMY',
        retail_price: 22.49,
        quantity: 3,
        quantity_breaks: productWithLadder('CLC133CMY', 22.49).quantity_breaks
    };
    assert.equal(B.ingest([line]), 1, 'a parsed cart line must be ingestable as-is');

    const ladder = await B.getLadderFor('CLC133CMY');
    assert.ok(ladder);
    const nudge = B.nudgeMarkup(ladder, 3, 99);
    assert.match(nudge, /Add 1 more to reach 4\+/,
        'at qty 3 the next rung is 4+ — this is the whole point of the cart surface');
    assert.deepEqual(B.__calls, []);
});

test('decorateVolumeNudges hands the parsed lines straight to ingest', () => {
    const code = stripComments(CART_SRC);
    const fn = code.slice(code.indexOf('decorateVolumeNudges: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /Business\.ingest\(this\.items\)/,
        'pass the parsed lines through unchanged — re-mapping them to a local shape ' +
        'is exactly how the field went missing in the first place (ERR-150)');
    assert.ok(body.indexOf('Business.ingest') < body.indexOf('Business.decorateCartLines'));
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. The coupon clamp is explained, never silent (BF-035)
// ═════════════════════════════════════════════════════════════════════════════

test('isCouponClamped only fires on an explicit true', () => {
    const { isCouponClamped } = loadClampHelpers();
    assert.equal(isCouponClamped({ limited_by_volume_pricing: true }), true);
    for (const notClamped of [null, undefined, {}, { limited_by_volume_pricing: false },
        { limited_by_volume_pricing: 'true' }, { limited_by_volume_pricing: 1 }]) {
        assert.equal(isCouponClamped(notClamped), false,
            'a truthy-ish value is not the flag: inventing a clamp explains away a ' +
            'discount that was never reduced');
    }
});

test('couponClampText prefers the backend wording and always has a fallback', () => {
    const { couponClampText } = loadClampHelpers();
    assert.equal(
        couponClampText({ limited_by_volume_pricing: true, message: '  Capped at your floor.  ' }),
        'Capped at your floor.',
        'the server explains its own arithmetic better than we can guess at it');
    for (const blank of [null, {}, { message: '   ' }, { message: 42 }]) {
        const text = couponClampText(blank);
        assert.ok(text && text.trim().length > 10, 'never an empty explanation');
        assert.doesNotMatch(text, /business/i,
            'the clamp applies to every shopper — naming an account type would be wrong ' +
            'for almost everyone who sees it');
    }
});

test('the cart renders the clamp note only when the flag is set', () => {
    const code = stripComments(CART_SRC);
    const fn = code.slice(code.indexOf('_renderDiscountRows: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /cart-coupon-note/, 'the cart needs somewhere to say it');
    assert.match(body, /isCouponClamped|limited_by_volume_pricing/);
    assert.match(body, /couponNote\.hidden = true/,
        'and it must go away again when the next cart is not clamped');
    assert.match(HTML('html/cart.html'), /id="cart-coupon-note"[^>]*hidden/,
        'it ships hidden — an empty note next to the totals is a rendering bug');
});

test('the parser keeps the WHOLE coupon object, not just code and amount', () => {
    const fn = CART_SRC.slice(CART_SRC.indexOf('_parseServerCart: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /self\.serverCoupon\s*=/,
        'limited_by_volume_pricing and message were being discarded at this boundary');
    assert.match(body, /coupon: self\.serverCoupon/, 'and returned so callers can read it');
});

test('the checkout pill escapes the backend message and wraps it onto its own line', () => {
    // Anchor on the DEFINITION, not the first call site.
    const code = CHECKOUT_CODE.slice(CHECKOUT_CODE.indexOf('async refreshAppliedCouponUI('));
    const body = code.slice(0, code.indexOf('\n        },'));
    assert.match(body, /Security\.escapeHtml\(this\.couponClampText\(coupon\)\)/,
        'the pill is an innerHTML template and the message is backend-supplied');

    // The base pill is a single-line flex row; a whole sentence must not squeeze
    // the code and the Remove button.
    const css = fs.readFileSync(path.join(ROOT, 'css', 'pages.css'), 'utf8');
    assert.match(css, /\.coupon-applied--limited\s*\{[^}]*flex-wrap:\s*wrap/,
        'the clamped variant has to wrap');
    assert.match(css, /\.coupon-applied--limited \.coupon-applied__desc\s*\{[^}]*flex:\s*1 0 100%/);
});

test('both apply paths mention the clamp at the moment the code is applied', () => {
    // The summary note alone is not enough: applying is when the shopper compares
    // the number against what the code promised.
    assert.match(CART_PAGE_CODE, /isCouponClamped\(serverCoupon\)/,
        'cart-page apply path must check for the clamp');
    assert.match(CHECKOUT_CODE, /this\.isCouponClamped\(appliedCouponBlock\)/,
        'checkout apply path must check for the clamp');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. volume_discount cutover — both spellings resolve
// ═════════════════════════════════════════════════════════════════════════════

test('computeDiscountBreakdown reads volume_discount AND the b2b_discount alias', () => {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(CART_SRC, 'computeDiscountBreakdown') +
        ';globalThis.__b = computeDiscountBreakdown;', sandbox);
    const compute = sandbox.__b;

    const block = { company_name: null, effective_percent: 3, discount_amount: 2.01, source: 'volume' };

    // The current field.
    let r = compute({ discount: 2.01, volume_discount: block }, 2.01);
    assert.equal(r.b2b, 2.01);
    assert.equal(r.b2bMeta.source, 'volume');

    // The transitional alias, so the backend can drop it whenever without a
    // frontend deploy — and so we keep working if they drop it tomorrow.
    r = compute({ discount: 2.01, b2b_discount: block }, 2.01);
    assert.equal(r.b2b, 2.01);
    assert.equal(r.b2bMeta.source, 'volume');

    // Bare numbers, both spellings.
    assert.equal(compute({ discount: 5, volume_discount: 5 }, 5).b2b, 5);
    assert.equal(compute({ discount: 5, b2b_discount: 5 }, 5).b2b, 5);
});

test('the parser folds the volume block under BOTH keys, or the surfaces split-brain', () => {
    const fn = CART_SRC.slice(CART_SRC.indexOf('_parseServerCart: function'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /summary\.volume_discount = volumeBlock/);
    assert.match(body, /summary\.b2b_discount = volumeBlock/,
        'cart and checkout call computeDiscountBreakdown with no second source, so they ' +
        'see the metadata ONLY via this fold — writing one key and reading the other ' +
        'silently drops the company label and the floored note on those two surfaces');
});

test('order-totals normalise accepts volume_discount in every live shape', () => {
    // order-totals.js is an IIFE that exports onto window/module — mirrors
    // loadOrderTotals() in order-totals-jul2026.test.js.
    const sandbox = { console, Math, JSON, Number, String, Array, Object, module: { exports: {} } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.formatPrice = (n) => '$' + Number(n).toFixed(2);
    vm.runInContext(JS('order-totals.js'), vm.createContext(sandbox), { filename: 'order-totals.js' });
    const OT = sandbox.OrderTotals;
    assert.ok(OT, 'OrderTotals must load');

    const obj = { company_name: 'Acme Print Co', discount_amount: 4.68, source: 'volume' };
    assert.equal(OT.normalise({ volume_discount: obj }).b2bDiscount, 4.68);
    assert.equal(OT.normalise({ volume_discount: obj }).b2bMeta.company_name, 'Acme Print Co');
    assert.equal(OT.normalise({ volume_discount: 4.68 }).b2bDiscount, 4.68);
    // The alias still works, and normalise stays idempotent over its own output.
    assert.equal(OT.normalise({ b2b_discount: obj }).b2bDiscount, 4.68);
    const once = OT.normalise({ volume_discount: obj });
    assert.equal(OT.normalise(once).b2bMeta.company_name, 'Acme Print Co');
});
