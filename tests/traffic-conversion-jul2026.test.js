/**
 * Traffic & Conversion — frontend wiring (Jul 2026)
 * =================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The backend shipped six conversion surfaces (commits 17111a2 / 7b05d53 /
 * 5216261) and handed the storefront a list of things to render. Every one of
 * them is driven by a field that is ABSENT OR ZERO in production right now:
 *
 *   - review_count is 0 on every product sampled 2026-07-28
 *   - /api/site/trust returns null for all three counts (the nightly sweep has
 *     never run; refreshed_at is null)
 *   - waitlist_count needs >= 5 people waiting — no product qualifies yet
 *   - bought_for_this_printer needs >= 10 sales in 90 days — none qualify yet
 *
 * That is the whole reason this file is thorough. A feature you cannot see
 * today is a feature nobody will notice is broken until the data arrives —
 * possibly months later, in front of customers. Every assertion below exercises
 * the POPULATED branch that production cannot currently produce, and the empty
 * branch that it can.
 *
 * The other half is the traps. Three of them, all real:
 *
 *   §3  The handoff's example copy for pack savings was "Save $14.97 (19%)".
 *       Every pack-savings surface on this site suppresses the percent
 *       (value-pack-savings-no-percent.test.js). Following the handoff would
 *       have made this the only surface that showed one.
 *   §3  The handoff put waitlist_count "next to the notify-me / waitlist CTA".
 *       There is no such CTA — contact-button-may2026.md deleted the waitlist
 *       UI sitewide. Adding one back would have silently reversed that.
 *   §5  api.js used to fold a structured `details` object into the thrown
 *       error MESSAGE via JSON.stringify. The moment the backend added
 *       error.details.suggestion to a failed coupon (a plain 400, which is
 *       exactly the branch that does this), the shopper would have seen
 *       `Invalid coupon: {"suggestion":{"code":"SAVE10",...}}` — in checkout's
 *       case, inside an alert() dialog.
 *
 * WHAT IS PINNED HERE
 *   §1  Review stars on every card renderer, and the empty-state that must
 *       render NOTHING.
 *   §2  Trust-stat banding: "+" suffix, null hidden, never "0+" or "null+".
 *       The footer one-liner is now the ONLY mount point — the homepage
 *       big-number band was removed Aug 2026 and must not creep back.
 *   §3  PDP pack savings (dollars only), waitlist proof (no CTA), printer proof,
 *       and the printer_slug plumbing that makes the last one possible.
 *   §4  Dispatch countdown: absolute-deadline math, drift immunity, teardown.
 *   §5  Coupon suggestion on both transports; lockout carries none; api.js
 *       keeps structured details out of user copy.
 *
 * Run: node --test tests/traffic-conversion-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const READ = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const JS = (rel) => READ(path.join('js', rel));

const { TrustStats, DispatchCountdown, CouponSuggestion } = require(path.join(INK, 'js', 'utils.js'));

// ─────────────────────────────────────────────────────────────────────────
// Shared harness
// ─────────────────────────────────────────────────────────────────────────

/** Minimal escaping stubs matching js/security.js semantics closely enough. */
const SECURITY_STUB = {
    escapeHtml: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    escapeAttr(s) { return this.escapeHtml(s); },
    sanitizeUrl: (u) => u,
};

/**
 * Strip // and /* *\/ comments so a source scan can't match the very prose that
 * documents the rule it is checking. Deliberately naive — it only needs to be
 * right on the well-formed files in this repo, not on adversarial input.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A stand-in element with just the surface the renderers touch. */
function makeEl() {
    return { hidden: true, textContent: '', innerHTML: '', _children: [] };
}

/** document.getElementById over a fixed id → element map. */
function makeDoc(ids) {
    const els = {};
    ids.forEach((id) => { els[id] = makeEl(); });
    return {
        els,
        getElementById: (id) => els[id] || null,
        querySelector: () => null,
    };
}

/**
 * Pull a single object-literal method out of a source file by balanced-brace
 * scan, so the test executes the SHIPPING source rather than a copy of it.
 * Copies rot; this cannot.
 */
function extractMethod(src, name) {
    const start = src.indexOf(`\n        ${name}(info) {`);
    assert.notEqual(start, -1, `expected method ${name}(info) in the source`);
    const open = src.indexOf('{', start);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return src.slice(start, i + 1).trim();
}

/**
 * Instantiate one or more PDP renderer methods against stub globals.
 * ProductPage is a module-scoped const inside an IIFE (not exported), so the
 * methods are lifted out and re-hosted here.
 */
function loadPdpRenderers(names, ids) {
    const src = JS('product-detail-page.js');
    const doc = makeDoc(ids);
    const sandbox = {
        document: doc,
        Security: SECURITY_STUB,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        Number, parseInt, parseFloat, String, Object, Array, Math, JSON,
        console,
    };
    vm.createContext(sandbox);
    const body = names.map((n) => extractMethod(src, n)).join(',\n');
    const api = vm.runInContext(`({\n${body}\n})`, sandbox, { filename: 'pdp-renderers.js' });
    return { api, doc };
}

// ═════════════════════════════════════════════════════════════════════════
// §1  REVIEW STARS ON PRODUCT CARDS
// ═════════════════════════════════════════════════════════════════════════

/** Load js/products.js the way tests/value-pack-savings-no-percent.test.js does. */
function loadProducts() {
    const sandbox = {
        console, URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number,
        Boolean, Symbol, RegExp, parseInt, parseFloat,
        Security: SECURITY_STUB,
        ProductColors: {
            getStyle: () => null, getProductStyle: () => null,
            detectFromName: () => null, isPlaceholderSwatchImage: () => false,
        },
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        getSourceBadge: () => ({ class: 'genuine', text: 'GENUINE' }),
        qualifiesForFreeShipping: () => false,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        storageUrl: (u) => u,
        imageSrcset: () => '',
        DebugLog: { log() {}, warn() {}, error() {} },
        window: {},
        document: { addEventListener() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(JS('products.js'), ctx, { filename: 'products.js' });
    return sandbox.Products;
}

const RATED = {
    id: 'p1', sku: 'SKU-1', name: 'Rated product', brand: { name: 'Test' },
    image_url: 'https://example.com/p.jpg', retail_price: 40, in_stock: true,
    source: 'genuine', review_count: 12, average_rating: 4.7,
};

test('§1 a product WITH reviews renders filled stars and the count', () => {
    const html = loadProducts().renderCard({ ...RATED }, 0);
    assert.match(html, /class="product-card__rating"/, 'rating row must render');
    assert.match(html, /\(12\)/, 'review count must render in parentheses');
    // 4.7 rounds to 5 filled stars: five polygons, all fill="currentColor".
    const filled = (html.match(/product-card__star[^>]*fill="currentColor"/g) || []).length;
    assert.equal(filled, 5, '4.7 must round to 5 filled stars');
});

test('§1 a product with ZERO reviews renders no star row at all', () => {
    const Products = loadProducts();
    const html = Products.renderCard({ ...RATED, review_count: 0, average_rating: null }, 0);
    assert.doesNotMatch(html, /product-card__rating/,
        'review_count 0 must render NOTHING — not an empty star row');
    assert.doesNotMatch(html, /\(0\)/, 'must never paint "(0)"');
    assert.doesNotMatch(html, /0 reviews/i, 'must never paint "0 reviews"');
});

test('§1 a review_count with no average_rating still renders nothing', () => {
    // Defensive: a half-populated payload must not paint a zero-star row.
    const html = loadProducts().renderCard({ ...RATED, average_rating: null }, 0);
    assert.doesNotMatch(html, /product-card__rating/,
        'both fields are required — a missing average must suppress the row');
});

/**
 * The /shop grid uses its own renderer (ShopPage.createProductCard). Rather
 * than boot the whole page controller, lift the exact rating expression out of
 * the shipping source and evaluate it — same guarantee, no drift.
 */
function shopRatingExpr() {
    const src = JS('shop-page.js');
    const m = src.match(/const ratingHTML = ([\s\S]*?);\n\n/);
    assert.ok(m, 'expected `const ratingHTML = …` in shop-page.js createProductCard');
    return m[1];
}

function evalShopRating(product) {
    const Products = loadProducts();
    return vm.runInNewContext(`(${shopRatingExpr()})`, { product, Products, parseInt, parseFloat, Math });
}

test('§1 the /shop grid renderer emits stars for a rated product', () => {
    const html = evalShopRating({ ...RATED });
    assert.match(html, /product-card__rating/, 'shop cards must carry the rating row');
    assert.match(html, /\(12\)/);
});

test('§1 the /shop grid renderer emits nothing for an unrated product', () => {
    assert.equal(evalShopRating({ ...RATED, review_count: 0, average_rating: null }), '',
        'shop cards must render an empty string, not an empty element');
});

test('§1 every card renderer gates on review_count > 0 — identically', () => {
    // One drifting gate is how "0 reviews" ships on exactly one surface.
    const surfaces = {
        'products.js': JS('products.js'),
        'shop-page.js': JS('shop-page.js'),
        'landing.js': JS('landing.js'),
        'ribbons-page.js': JS('ribbons-page.js'),
        'favourites.js': JS('favourites.js'),
    };
    for (const [name, src] of Object.entries(surfaces)) {
        assert.match(src, /product-card__rating/,
            `${name} must render the rating row — it is a product-card surface`);
        assert.match(src, /average_rating && \w+\.review_count > 0/,
            `${name} must use the shared gate: average_rating truthy AND review_count > 0`);
    }
});

test('§1 the shop grid reuses Products._miniStars rather than re-implementing it', () => {
    const src = JS('shop-page.js');
    assert.match(src, /Products\._miniStars\(/,
        'shop-page must call the shared star renderer so the two cannot drift');
    assert.doesNotMatch(src, /<svg class="product-card__star"/,
        'shop-page must not inline its own star SVG');
});

test('§1 the search dropdown suppression is INTENTIONAL and still in place', () => {
    // The dropdown is height-constrained by design (search-dropdown-height).
    // Stars appear on the search RESULTS grid, which is shop-page.js.
    // If someone "fixes" this CSS thinking it is a bug, this test explains why.
    const css = READ('css/search.css');
    assert.match(css, /\.smart-ac__grid \.product-card__rating[\s\S]{0,200}display: none/,
        'the dropdown rating suppression must survive — it is deliberate, not an oversight');
});

// ═════════════════════════════════════════════════════════════════════════
// §2  SITEWIDE TRUST STATS
// ═════════════════════════════════════════════════════════════════════════

test('§2 band() appends "+" to a real count', () => {
    assert.equal(TrustStats.band(47), '47+');
    assert.equal(TrustStats.band(100), '100+');
    assert.equal(TrustStats.band(1), '1+');
});

test('§2 band() returns null — never a string — for absent or zero counts', () => {
    // Absence is NOT zero. "0+ customers served" is worse than saying nothing.
    for (const v of [null, undefined, 0, -3, NaN, Infinity, '47', {}, []]) {
        assert.equal(TrustStats.band(v), null, `band(${JSON.stringify(v)}) must be null`);
    }
});

test('§2 band() thousands-separates so big numbers stay readable', () => {
    assert.equal(TrustStats.band(12500), '12,500+');
});

test('§2 normalize() coerces the wire shape and preserves nulls', () => {
    const s = TrustStats.normalize({
        customers_served: 47, orders_shipped: 71, cartridges_sold: 100,
        founded_year: 2008, refreshed_at: '2026-07-27T03:00:00.000Z',
    });
    assert.deepEqual(s, {
        customersServed: 47, ordersShipped: 71, cartridgesSold: 100,
        foundedYear: 2008, refreshedAt: '2026-07-27T03:00:00.000Z',
    });
});

test('§2 normalize() survives the payload production actually returns today', () => {
    // Measured live 2026-07-28: every count null, refreshed_at null.
    const s = TrustStats.normalize({
        customers_served: null, orders_shipped: null, cartridges_sold: null,
        founded_year: 2008, refreshed_at: null,
    });
    assert.equal(s.customersServed, null);
    assert.equal(s.ordersShipped, null);
    assert.equal(s.cartridgesSold, null);
    assert.equal(s.foundedYear, 2008);
    assert.deepEqual(TrustStats.lines(s), [],
        'all-null stats must yield NO lines, so every mount point stays hidden');
});

test('§2 normalize() tolerates a missing or malformed stats object', () => {
    for (const bad of [undefined, null, 'nope', 42, []]) {
        const s = TrustStats.normalize(bad);
        assert.equal(s.customersServed, null);
        assert.deepEqual(TrustStats.lines(s), []);
    }
});

test('§2 lines() drops only the null slots and keeps display order', () => {
    const s = TrustStats.normalize({
        customers_served: 47, orders_shipped: null, cartridges_sold: 100,
    });
    assert.deepEqual(TrustStats.lines(s), [
        { key: 'customers', value: '47+', label: 'customers served' },
        { key: 'cartridges', value: '100+', label: 'cartridges sold' },
    ], 'a null count must vanish, not render as 0 — and the survivors keep their order');
});

test('§2 no rendered stat string can ever read "0+" or "null+"', () => {
    const rendered = TrustStats.lines(TrustStats.normalize({
        customers_served: 0, orders_shipped: null, cartridges_sold: 5,
    })).map((r) => `${r.value} ${r.label}`).join(' · ');
    assert.doesNotMatch(rendered, /0\+/);
    assert.doesNotMatch(rendered, /null/);
    assert.equal(rendered, '5+ cartridges sold');
});

test('§2 the footer is the only mount point, and it ships hidden', () => {
    const footer = JS('footer.js');
    assert.match(footer, /id="footer-trust-stats"[^>]*hidden/,
        'the footer stats line must ship hidden');
    assert.match(footer, /if \(!lines\.length\)[\s\S]{0,120}hidden = true/,
        'footer.js must re-hide its mount point when there are no lines');

    // The homepage big-number band was REMOVED (Aug 2026, owner's call): three
    // tiles under the hero trust bar reading "73+ customers served / 81+ orders
    // shipped / 100+ cartridges sold". It was never wrong — the nightly sweep
    // finally ran and the owner did not want those counts that prominent.
    // The footer one-liner is the surviving surface. Re-adding a homepage band
    // is a product decision, not a bug fix, so it fails here first.
    assert.doesNotMatch(READ('index.html'), /trust-stats/,
        'the homepage trust-stats band was removed — do not re-add it silently');
    assert.doesNotMatch(JS('landing.js'), /TrustStats/,
        'landing.js must not paint trust stats; the footer owns the only surface');
});

test('§2 TrustStats owns one shared fetch, and seo-meta.js delegates to it', () => {
    const seo = JS('seo-meta.js');
    assert.match(seo, /typeof TrustStats !== 'undefined'[\s\S]{0,300}TrustStats\.raw\(\)/,
        'SeoMeta.getTrust must prefer the shared TrustStats fetch');
    assert.match(seo, /TRUST_ENDPOINT: '\/api\/site\/trust'/,
        'the local fallback fetch must remain for pages without utils.js');
});

test('§2 trust rendering never interpolates a raw count into markup', () => {
    // Counts are backend numbers, but the labels sit in user-visible copy;
    // the surviving mount point uses textContent, never innerHTML.
    assert.match(JS('footer.js'), /el\.textContent = lines\.map/,
        'the footer line must be built with textContent');
});

// ═════════════════════════════════════════════════════════════════════════
// §3  PDP — PACK SAVINGS · WAITLIST PROOF · PRINTER PROOF
// ═════════════════════════════════════════════════════════════════════════

// Live payload, GW218CMY, fetched 2026-07-28.
const PACK_SAVINGS = {
    individual_total: 613.47, pack_price: 512.99, savings_amount: 100.48,
    savings_percent: 16, cartridge_count: 3, savings_per_cartridge: 33.49,
};

function renderPackSavings(info) {
    const { api, doc } = loadPdpRenderers(['renderPackSavingsVsSingles'], ['product-pack-savings']);
    api.renderPackSavingsVsSingles(info);
    return doc.els['product-pack-savings'];
}

test('§3 pack savings renders the dollar amount and the cartridge count', () => {
    const el = renderPackSavings({ pack_savings_vs_singles: PACK_SAVINGS });
    assert.equal(el.hidden, false, 'a qualifying pack must reveal the line');
    assert.match(el.innerHTML, /Save \$100\.48 vs buying all 3 individually/);
    assert.match(el.innerHTML, /\$33\.49 per cartridge/);
});

test('§3 pack savings NEVER renders a percent — the site-wide pack rule wins', () => {
    // The handoff's example copy was "Save $14.97 (19%) vs buying all 4
    // individually". Every other pack surface suppresses the percent
    // (value-pack-savings-no-percent.test.js), and the payload carries
    // savings_percent: 16 — so this is a live temptation, not a hypothetical.
    const el = renderPackSavings({ pack_savings_vs_singles: PACK_SAVINGS });
    assert.doesNotMatch(el.innerHTML, /%/,
        'pack savings must be dollars only — no percent, ever');
    assert.doesNotMatch(el.innerHTML, /16/,
        'savings_percent must not leak into the copy in any form');
});

test('§3 the pack-savings source never reads savings_percent at all', () => {
    const src = JS('product-detail-page.js');
    const method = extractMethod(src, 'renderPackSavingsVsSingles');
    assert.doesNotMatch(method, /savings_percent/,
        'the safest guarantee is not reading the field — do not "just compute it"');
});

test('§3 pack savings stays hidden when the field is absent or degenerate', () => {
    const cases = [
        undefined,
        { pack_savings_vs_singles: null },
        { pack_savings_vs_singles: {} },
        { pack_savings_vs_singles: { ...PACK_SAVINGS, savings_amount: 0 } },
        { pack_savings_vs_singles: { ...PACK_SAVINGS, savings_amount: -5 } },
        { pack_savings_vs_singles: { ...PACK_SAVINGS, cartridge_count: 1 } },
        { pack_savings_vs_singles: { ...PACK_SAVINGS, cartridge_count: null } },
    ];
    for (const info of cases) {
        const el = renderPackSavings(info);
        assert.equal(el.hidden, true, `must hide for ${JSON.stringify(info)}`);
        assert.equal(el.innerHTML, '', 'and must not leave stale copy behind');
    }
});

test('§3 pack savings drops the per-cartridge line when that figure is missing', () => {
    const el = renderPackSavings({
        pack_savings_vs_singles: { ...PACK_SAVINGS, savings_per_cartridge: null },
    });
    assert.equal(el.hidden, false);
    assert.match(el.innerHTML, /Save \$100\.48/);
    assert.doesNotMatch(el.innerHTML, /per cartridge/);
});

function renderWaitlist(info) {
    const { api, doc } = loadPdpRenderers(['renderWaitlistProof'], ['product-waitlist-proof']);
    api.renderWaitlistProof(info);
    return doc.els['product-waitlist-proof'];
}

test('§3 waitlist proof renders the count as plain social proof', () => {
    const el = renderWaitlist({ waitlist_count: 8 });
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, '8 people are waiting for this to come back');
});

test('§3 waitlist proof reads correctly at one', () => {
    // The backend gates at >= 5, but singular/plural is one string away from
    // "1 people are waiting" if the gate ever loosens.
    assert.equal(renderWaitlist({ waitlist_count: 1 }).textContent,
        '1 person is waiting for this to come back');
});

test('§3 waitlist proof can never paint "0 people are waiting"', () => {
    for (const v of [undefined, null, 0, -1, 'lots', {}]) {
        const el = renderWaitlist({ waitlist_count: v });
        assert.equal(el.hidden, true, `must hide for waitlist_count=${JSON.stringify(v)}`);
        assert.equal(el.textContent, '');
    }
});

test('§3 NO waitlist / notify-me CTA was reintroduced anywhere', () => {
    // contact-button-may2026.md retired the waitlist UI sitewide: every
    // out-of-stock product gets exactly one CTA and it goes to /contact. The
    // handoff asked for this count "next to the notify-me / waitlist CTA" —
    // rendering the proof is fine; resurrecting the CTA is not.
    const surfaces = ['product-detail-page.js', 'products.js', 'shop-page.js', 'cart.js'];
    for (const file of surfaces) {
        const src = JS(file);
        assert.doesNotMatch(src, /Notify me/i, `${file} must not offer a notify-me CTA`);
        assert.doesNotMatch(src, /API\.waitlistSubscribe/, `${file} must not call the waitlist API`);
    }
    // The API wrappers stay mounted (cached bundles must not 404) and unused.
    assert.match(JS('api.js'), /waitlistSubscribe\(/,
        'the waitlist API wrappers stay mounted — they are simply never called');
});

test('§3 the out-of-stock CTA is still the single "Contact us" button', () => {
    const src = JS('product-detail-page.js');
    assert.match(src, /const contactCtaPdp = `<a href="\/contact"[\s\S]{0,400}Contact us/,
        'the OOS CTA must still be one Contact-us anchor');
});

function renderPrinterProof(info) {
    const { api, doc } = loadPdpRenderers(['renderPrinterPurchaseProof'], ['product-printer-proof']);
    api.renderPrinterPurchaseProof(info);
    return doc.els['product-printer-proof'];
}

test('§3 printer proof names the printer and the window', () => {
    const el = renderPrinterProof({
        bought_for_this_printer: { count: 14, printer_name: 'Brother MFC-J5330DW', window_days: 90 },
    });
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, '14 bought in the last 90 days for the Brother MFC-J5330DW');
});

test('§3 printer proof degrades gracefully without a printer name', () => {
    const el = renderPrinterProof({ bought_for_this_printer: { count: 14, window_days: 30 } });
    assert.equal(el.textContent, '14 bought in the last 30 days');
});

test('§3 printer proof hides for absent or zero counts', () => {
    for (const bp of [undefined, null, {}, { count: 0 }, { count: 'many' }]) {
        const el = renderPrinterProof({ bought_for_this_printer: bp });
        assert.equal(el.hidden, true, `must hide for ${JSON.stringify(bp)}`);
    }
});

test('§3 printer_slug is plumbed end to end — shop card → PDP → API', () => {
    const shop = JS('shop-page.js');
    assert.match(shop, /printer_slug=\$\{encodeURIComponent\(ctx\)\}/,
        'shop cards must carry printer context onto the PDP href');

    const pdp = JS('product-detail-page.js');
    assert.match(pdp, /this\._printerSlug = \(params\.get\('printer_slug'\)/,
        'the PDP must read printer_slug from its own query string');
    assert.match(pdp, /API\.getProduct\(sku, \{ printerSlug: this\._printerSlug \}\)/,
        'the PDP must forward printer context to the product request');

    const api = JS('api.js');
    assert.match(api, /printer_slug: printerSlug/,
        'api.js must append printer_slug as a query param');
});

/** VM-load js/api.js and hand back the API object for real behavioural checks. */
function loadApi() {
    const sandbox = {
        console, URL, URLSearchParams, Map, Set, Promise, Date, JSON, Math,
        Object, Array, String, Number, Boolean, RegExp, Error,
        parseInt, parseFloat, encodeURIComponent,
        fetch: () => {}, setTimeout, clearTimeout, AbortController,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        DebugLog: { log() {}, warn() {}, error() {} },
        window: {}, document: { addEventListener() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(JS('api.js'), sandbox, { filename: 'api.js' });
    return sandbox.API;
}

test('§3 an absent printer context leaves the product URL byte-identical', () => {
    // A stray "?printer_slug=" would fragment the CDN cache key for every PDP
    // — and the common case has no printer context at all. Asserted
    // behaviourally rather than by regex so an internal refactor of the URL
    // builder cannot quietly break the guarantee while keeping the test green.
    const API = loadApi();
    const bare = '/api/products/C63BK';
    for (const empty of [undefined, null, '']) {
        assert.equal(API.catalogEndpoint(bare, { printer_slug: empty }), bare,
            `an empty printer_slug (${JSON.stringify(empty)}) must not even add "?"`);
    }
    assert.equal(
        API.catalogEndpoint(bare, { printer_slug: 'hp-deskjet-1112' }),
        '/api/products/C63BK?printer_slug=hp-deskjet-1112',
        'a real printer_slug must ride along as a query param');
});

test('§3 printer_slug is captured BEFORE any history rewrite runs', () => {
    // The /p/:sku resolver rewrites to `/products/:slug/:sku` with NO query
    // string, so reading the param after that point would lose it entirely.
    const src = JS('product-detail-page.js');
    const readAt = src.indexOf("this._printerSlug = (params.get('printer_slug')");
    const replaceAt = src.indexOf('window.history.replaceState');
    assert.ok(readAt > -1, 'the PDP must read printer_slug into controller state');
    assert.ok(replaceAt > -1, 'the canonical URL rewrite must still exist');
    assert.ok(readAt < replaceAt,
        'the param must be captured before the URL is normalised, or it is lost');
});

test('§3 printer context never leaks into the canonical link', () => {
    // The URL bar may keep ?printer_slug= (the canonical rewrite preserves the
    // query string, and a shared link then carries the same useful context) —
    // but <link rel=canonical> is built from the backend's canonical_url, so
    // search engines must never see the param.
    //
    // Comments are stripped first: this file necessarily *discusses* both
    // canonical_url and printer_slug in prose, and a comment-blind scan would
    // match its own documentation.
    const code = stripComments(JS('product-detail-page.js'));
    assert.match(code, /const canonicalUrl = info\.canonical_url/,
        'the canonical URL must still come from the backend field');
    assert.doesNotMatch(code, /canonicalUrl[\s\S]{0,200}printer_slug/,
        'the canonical URL must never be rewritten with printer context');
    assert.doesNotMatch(code, /canonicalPath[\s\S]{0,200}printer_slug/,
        'the canonical path rewrite must never add printer context');
});

// ═════════════════════════════════════════════════════════════════════════
// §4  SAME-DAY DISPATCH COUNTDOWN
// ═════════════════════════════════════════════════════════════════════════

test('§4 format() reads as hours+minutes above an hour', () => {
    assert.equal(DispatchCountdown.format(7200), '2h 00m');
    assert.equal(DispatchCountdown.format(7140), '1h 59m');
    // 17446 is the literal cutoff_remaining_seconds the PDP returned on 2026-07-28.
    assert.equal(DispatchCountdown.format(17446), '4h 50m');
});

test('§4 format() switches to minutes+seconds under an hour, zero-padded', () => {
    // Padding keeps the string width stable so the line does not jitter.
    assert.equal(DispatchCountdown.format(545), '9m 05s');
    assert.equal(DispatchCountdown.format(3599), '59m 59s');
    assert.equal(DispatchCountdown.format(45), '45s');
    assert.equal(DispatchCountdown.format(0), '0s');
});

test('§4 format() never goes negative', () => {
    assert.equal(DispatchCountdown.format(-500), '0s');
});

test('§4 eligibility requires the flag AND a positive seed', () => {
    assert.equal(DispatchCountdown.isEligible({ same_day_eligible: true, cutoff_remaining_seconds: 7200 }), true);
    // A `true` flag with no time left is an expired cache, not an opportunity.
    assert.equal(DispatchCountdown.isEligible({ same_day_eligible: true, cutoff_remaining_seconds: 0 }), false);
    assert.equal(DispatchCountdown.isEligible({ same_day_eligible: false, cutoff_remaining_seconds: 7200 }), false);
    assert.equal(DispatchCountdown.isEligible({}), false);
    assert.equal(DispatchCountdown.isEligible(null), false);
});

/** Controllable clock + timer harness. */
function harness(startMs) {
    let now = startMs;
    let tick = null;
    return {
        opts: {
            now: () => now,
            setInterval: (fn) => { tick = fn; return 1; },
            clearInterval: () => { tick = null; },
        },
        advance(ms) { now += ms; if (tick) tick(); },
        jump(ms) { now += ms; },
        get running() { return tick !== null; },
        fire() { if (tick) tick(); },
    };
}

test('§4 mount() paints immediately from the seed', () => {
    const el = makeEl();
    const h = harness(1000);
    DispatchCountdown.mount(el, { same_day_eligible: true, cutoff_remaining_seconds: 7140 }, h.opts);
    assert.equal(el.hidden, false);
    assert.equal(el.textContent, 'Order within 1h 59m for same-day dispatch');
});

test('§4 the countdown actually ticks down', () => {
    const el = makeEl();
    const h = harness(0);
    DispatchCountdown.mount(el, { same_day_eligible: true, cutoff_remaining_seconds: 125 }, h.opts);
    assert.equal(el.textContent, 'Order within 2m 05s for same-day dispatch');
    h.advance(1000);
    assert.equal(el.textContent, 'Order within 2m 04s for same-day dispatch');
    h.advance(64000);
    assert.equal(el.textContent, 'Order within 1m 00s for same-day dispatch');
});

test('§4 the deadline is ABSOLUTE, so a backgrounded tab cannot drift', () => {
    // This is the whole reason the seed is converted to a deadline rather than
    // decremented. Browsers clamp setInterval in background tabs to roughly one
    // call per minute; a decrementing counter would be minutes wrong on return.
    const el = makeEl();
    const h = harness(0);
    DispatchCountdown.mount(el, { same_day_eligible: true, cutoff_remaining_seconds: 3600 }, h.opts);
    assert.equal(el.textContent, 'Order within 1h 00m for same-day dispatch');
    // 10 real minutes pass; the interval only managed to fire once.
    h.jump(600000);
    h.fire();
    assert.equal(el.textContent, 'Order within 50m 00s for same-day dispatch',
        'the remaining time must be recomputed from the clock, not decremented per tick');
});

test('§4 reaching the cutoff hides the line and stops the timer', () => {
    const el = makeEl();
    const h = harness(0);
    DispatchCountdown.mount(el, { same_day_eligible: true, cutoff_remaining_seconds: 3 }, h.opts);
    assert.equal(h.running, true);
    h.advance(4000);
    assert.equal(el.hidden, true, 'a passed cutoff must not keep promising same-day dispatch');
    assert.equal(el.textContent, '');
    assert.equal(h.running, false, 'the interval must be cleared, not left spinning');
});

test('§4 an ineligible payload renders nothing and starts no timer', () => {
    for (const d of [null, {}, { same_day_eligible: false, cutoff_remaining_seconds: 7200 }]) {
        const el = makeEl();
        const h = harness(0);
        const handle = DispatchCountdown.mount(el, d, h.opts);
        assert.equal(handle, null);
        assert.equal(el.hidden, true);
        assert.equal(h.running, false);
    }
});

test('§4 re-mounting the same element stops the previous timer first', () => {
    // Cart.renderCartSignals re-runs after EVERY mutation. Without this, each
    // add-to-cart would stack another interval on the same element and the
    // number would tick several times a second.
    const el = makeEl();
    let live = 0;
    const opts = {
        now: () => 0,
        setInterval: () => { live++; return live; },
        clearInterval: () => { live--; },
    };
    const d = { same_day_eligible: true, cutoff_remaining_seconds: 7200 };
    DispatchCountdown.mount(el, d, opts);
    DispatchCountdown.mount(el, d, opts);
    DispatchCountdown.mount(el, d, opts);
    assert.equal(live, 1, 'exactly one interval may be live per element');
});

test('§4 the returned handle stops the timer', () => {
    const el = makeEl();
    const h = harness(0);
    const handle = DispatchCountdown.mount(el, { same_day_eligible: true, cutoff_remaining_seconds: 7200 }, h.opts);
    handle.stop();
    assert.equal(h.running, false);
});

test('§4 both mount points exist, ship hidden, and do not spam screen readers', () => {
    const pdp = READ('html/product/index.html');
    const cart = READ('html/cart.html');
    for (const [name, html, id] of [
        ['PDP', pdp, 'product-dispatch-countdown'],
        ['cart', cart, 'cart-dispatch-countdown'],
    ]) {
        const m = html.match(new RegExp(`<p[^>]*id="${id}"[\\s\\S]{0,200}?>`));
        assert.ok(m, `${name} must carry a #${id} element`);
        assert.match(m[0], /hidden/, `${name} countdown must ship hidden`);
        assert.match(m[0], /role="timer"/, `${name} countdown must be a timer`);
        assert.match(m[0], /aria-live="off"/,
            `${name} countdown must not be a live region — it changes every second`);
    }
});

test('§4 the countdown is ADDITIVE — the locked buy-box copy is untouched', () => {
    // product-buybox-may2026 locks this string because the backend prerender
    // ships it verbatim. Rewriting it here would desync SPA and prerender.
    const src = JS('product-detail-page.js');
    assert.match(src, /Order before \$\{Security\.escapeHtml\(dCutoff\)\} NZT for same-day dispatch/,
        'the locked delivery-row copy must survive verbatim');
    const pdpHtml = READ('html/product/index.html');
    const dl = pdpHtml.match(/<dl class="buy-box"[\s\S]*?<\/dl>/);
    assert.ok(dl, 'the buy-box <dl> must still exist');
    assert.doesNotMatch(dl[0], /dispatch-countdown/,
        'the countdown must live OUTSIDE the copy-locked buy-box');
});

test('§4 the cart stops its timer before re-seeding on every mutation', () => {
    assert.match(JS('cart.js'), /DispatchCountdown\.mount\(dispatchEl, hasItems \? meta\.delivery_estimate : null\)/,
        'an empty cart must pass null so the countdown hides');
});

// ═════════════════════════════════════════════════════════════════════════
// §5  COUPON SUGGESTION
// ═════════════════════════════════════════════════════════════════════════

const SUGGESTION = { code: 'SAVE10', label: '10% off', condition: 'on orders over $50' };

test('§5 the suggestion is read from the 400-apply shape (error.details)', () => {
    // POST /api/cart/coupon fails with HTTP 400 → error.details.suggestion.
    // api.js THROWS for a plain 400, so it arrives on the Error's .details.
    const thrown = Object.assign(new Error('Invalid coupon'), {
        code: 'COUPON_INVALID', status: 400, details: { suggestion: SUGGESTION },
    });
    assert.deepEqual(CouponSuggestion.pick(thrown), SUGGESTION);

    // And from a raw envelope, in case a caller hands one over unwrapped.
    assert.deepEqual(
        CouponSuggestion.pick({ ok: false, error: { details: { suggestion: SUGGESTION } } }),
        SUGGESTION);
});

test('§5 the suggestion is read from the 200-preview shape (data.suggestion)', () => {
    // POST /api/cart/coupon/preview fails with HTTP 200 + data.valid === false.
    assert.deepEqual(CouponSuggestion.pick({ valid: false, suggestion: SUGGESTION }), SUGGESTION);
    assert.deepEqual(CouponSuggestion.pick({ data: { valid: false, suggestion: SUGGESTION } }), SUGGESTION);
});

test('§5 a LOCKED response never yields a suggestion', () => {
    // The 429 lockout is a security control and deliberately carries none.
    // pick() refuses even if a future backend accidentally includes one.
    for (const code of ['COUPON_LOCKED', 'RATE_LIMITED']) {
        assert.equal(
            CouponSuggestion.pick({ code, details: { suggestion: SUGGESTION } }), null,
            `${code} must never surface a suggestion`);
    }
});

test('§5 a malformed or absent suggestion yields null, not a broken sentence', () => {
    for (const src of [
        null, undefined, {}, 'nope', 42,
        { details: {} },
        { details: { suggestion: null } },
        { details: { suggestion: 'SAVE10' } },
        { details: { suggestion: { label: '10% off' } } },
        { details: { suggestion: { code: '   ' } } },
    ]) {
        assert.equal(CouponSuggestion.pick(src), null, `must be null for ${JSON.stringify(src)}`);
    }
});

test('§5 the nudge copy never says WHY the tried code failed', () => {
    // Anti-enumeration is intentional: revealing "expired" vs "already used"
    // vs "does not exist" lets an attacker map the coupon space.
    const text = CouponSuggestion.text(SUGGESTION);
    assert.equal(text, 'That code didn’t work — try SAVE10 for 10% off on orders over $50.');
    for (const leak of [/expired/i, /already used/i, /minimum/i, /not found/i, /does not exist/i]) {
        assert.doesNotMatch(text, leak, 'the nudge must not explain the failure');
    }
});

test('§5 the nudge degrades cleanly as fields drop off', () => {
    assert.equal(CouponSuggestion.text({ code: 'SAVE10', label: '10% off', condition: null }),
        'That code didn’t work — try SAVE10 for 10% off.');
    assert.equal(CouponSuggestion.text({ code: 'SAVE10', label: null, condition: null }),
        'That code didn’t work — try SAVE10.');
    assert.equal(CouponSuggestion.text(null), null);
});

test('§5 api.js keeps a structured details OBJECT out of the user-facing message', () => {
    // The regression this prevents: `Invalid coupon: {"suggestion":{...}}`.
    const src = JS('api.js');
    assert.doesNotMatch(src, /fullMsg \+= ': ' \+ JSON\.stringify\(errorDetails\)/,
        'a details object must never be stringified into the message a shopper reads');
    assert.match(src, /if \(errorDetails !== undefined\) e\.details = errorDetails;/,
        'structured details must survive the throw so callers can read .suggestion');
    // Array details (per-field validation copy) ARE user-readable — keep them.
    assert.match(src, /errorDetails\.map\(d => d\.message \|\| d\)\.join\(', '\)/,
        'array details must keep their existing append behaviour');
});

test('§5 both coupon surfaces read BOTH transports', () => {
    for (const [name, src] of [['cart-page.js', JS('cart-page.js')], ['checkout-page.js', JS('checkout-page.js')]]) {
        assert.match(src, /CouponSuggestion/, `${name} must consult the shared suggestion helper`);
    }
    const cart = JS('cart-page.js');
    assert.match(cart, /setFailure\(reasonText\(data\), data\)/,
        'cart preview must pass the 200-preview body as the suggestion source');
    assert.match(cart, /setFailure\('Couldn’t apply that coupon right now[^']*', err\)/,
        'cart apply must pass the THROWN error, which is where a 400 lands');
    assert.match(cart, /setFailure\(res\?\.error \|\| reasonText\(res && res\.data\), res\)/,
        'cart apply must also handle the returned-envelope shape');
});

test('§5 the cart now has the 429 branch it was missing entirely', () => {
    const cart = JS('cart-page.js');
    assert.match(cart, /code === 'COUPON_LOCKED' \|\| code === 'RATE_LIMITED'/,
        'the cart must recognise the lockout — before Jul 2026 it had no 429 branch at all');
    assert.match(cart, /Too many tries — wait a minute and retry\./,
        'and must say so, rather than claiming the code is invalid');
});

test('§5 the suggested code fills the input — it is never auto-applied', () => {
    // Auto-applying would spend one of the shopper's limited attempts on a code
    // they did not choose, and the endpoint locks out after too many.
    for (const [name, src] of [['cart-page.js', JS('cart-page.js')], ['checkout-page.js', JS('checkout-page.js')]]) {
        const m = src.match(/btn\.addEventListener\('click', \(\) => \{[\s\S]{0,220}?\}\);/);
        assert.ok(m, `${name} must wire the suggestion chip`);
        assert.match(m[0], /\.value = suggestion\.code/, `${name} chip must fill the input`);
        assert.doesNotMatch(m[0], /applyCoupon|\.click\(\)|submit\(/,
            `${name} chip must NOT auto-submit the suggested code`);
    }
});

test('§5 the suggestion chip is built from DOM nodes, never innerHTML', () => {
    // code/label are backend strings landing in a page that takes payment.
    for (const [name, src] of [['cart-page.js', JS('cart-page.js')], ['checkout-page.js', JS('checkout-page.js')]]) {
        const start = src.indexOf('CouponSuggestion.pick');
        assert.notEqual(start, -1);
        const block = src.slice(start, start + 1400);
        assert.match(block, /createTextNode/, `${name} must use text nodes for the copy`);
        assert.match(block, /btn\.textContent = suggestion\.code/, `${name} must set the code via textContent`);
        assert.doesNotMatch(block, /innerHTML\s*=\s*[`'"].*\$\{/,
            `${name} must not interpolate the suggestion into an HTML string`);
    }
});

test('§5 checkout no longer reports coupon outcomes through alert()', () => {
    // A raw alert() was how a stringified suggestion object would have reached
    // a modal dialog. The coupon handler now reports inline like its own preview.
    const src = JS('checkout-page.js');
    const handler = src.slice(src.indexOf('setupCouponHandler'), src.indexOf('refreshAppliedCouponUI()'));
    assert.doesNotMatch(handler, /\balert\(/,
        'the coupon handler must report inline, not through a modal dialog');
});
