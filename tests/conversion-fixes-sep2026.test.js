/**
 * Conversion fixes + value-proposition spotlight (backend handoff 2026-09-23,
 * owner goal 2026-09-27). One suite for the FE half of that handoff.
 *
 * Every section EXECUTES the shipping code (middleware imported as a module,
 * browser modules run in a vm) rather than grepping for it — a grep can only
 * prove a spelling exists, not that the branch runs (ERR-253, ERR-258).
 *
 * §1  middleware — backend 301s pass through as 301s; bare /shop prerenders;
 *     upstream x-robots-tag is never forwarded
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const BACKEND = 'https://ink-backend-zaeq.onrender.com';
const SITE = 'https://www.inkcartridges.co.nz';

// ─────────────────────────────────────────────────────────────────────────────
// §1 — middleware, imported and executed
// ─────────────────────────────────────────────────────────────────────────────

let middlewareFn = null;
let tmpFile = null;
async function loadMiddleware() {
    if (middlewareFn) return middlewareFn;
    // ES module inside a CJS package: copy to .mjs (same trick as
    // chip-prerender-sep2026.test.js; `node --check` is a no-op on it).
    tmpFile = path.join(os.tmpdir(), `ic-mw-conv-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, read('middleware.js'));
    middlewareFn = (await import(`file://${tmpFile}`)).default;
    return middlewareFn;
}
test.after(() => { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });

function fakeRequest(url, ua = GOOGLEBOT) {
    return { url, headers: { get: (n) => (String(n).toLowerCase() === 'user-agent' ? ua : null) } };
}

/** Run the middleware with a stubbed backend; returns {res, calls}. */
async function run(url, backend, ua) {
    const fn = await loadMiddleware();
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (target, init) => { calls.push({ target: String(target), init }); return backend(); };
    try {
        return { res: await fn(fakeRequest(url, ua)), calls };
    } finally {
        globalThis.fetch = original;
    }
}

const html200 = (extra = {}) => () => new Response('<html><title>stub</title></html>', {
    status: 200, headers: { 'Content-Type': 'text/html', ...extra },
});

test('§1 backend 301 on a legacy SKU is passed through as OUR 301 (measured defect: was 200)', async () => {
    const loc = `${SITE}/products/brother-genuine-lc531bk-ink-cartridge-lc531-black/GLC531BK`;
    const { res, calls } = await run(`${SITE}/products/x/G-BRO-LC531BK-INK-BK`,
        () => new Response(null, { status: 301, headers: { Location: loc } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual', 'fetch must not follow the backend redirect');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), loc);
});

test('§1 every 3xx flavour becomes a 301; a relative Location resolves against www, never the backend', async () => {
    for (const status of [301, 302, 307, 308]) {
        const { res } = await run(`${SITE}/product/old-slug`,
            () => new Response(null, { status, headers: { Location: '/products/new/GNEW1' } }));
        assert.equal(res.status, 301, `status ${status}`);
        assert.equal(res.headers.get('location'), `${SITE}/products/new/GNEW1`);
    }
});

test('§1 a 3xx with no Location falls through to the SPA (no half-redirect)', async () => {
    const { res } = await run(`${SITE}/products/x/GABC`, () => new Response(null, { status: 302 }));
    assert.equal(res, undefined);
});

test('§1 negative control: a 200 still renders the prerender body as 200', async () => {
    const { res } = await run(`${SITE}/products/x/GLC3329XLBK`, html200());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-prerendered'), 'true');
    assert.match(await res.text(), /stub/);
});

test('§1 upstream x-robots-tag is NEVER forwarded to www', async () => {
    const { res } = await run(`${SITE}/products/x/GLC3329XLBK`,
        html200({ 'X-Robots-Tag': 'noindex, nofollow' }));
    assert.equal(res.headers.get('x-robots-tag'), null);
});

test('§1 bare /shop prerenders /api/prerender/shop for crawlers', async () => {
    const { calls } = await run(`${SITE}/shop`, html200());
    assert.equal(calls[0].target, `${BACKEND}/api/prerender/shop`);
});

test('§1 /shop with any param does NOT get the whole-shop prerender', async () => {
    for (const qs of ['?q=hp', '?search=65', '?gclid=abc', '?type=ink']) {
        const { calls } = await run(`${SITE}/shop${qs}`, html200());
        assert.ok(!calls.some((c) => c.target.endsWith('/api/prerender/shop')), qs);
    }
});

test('§1 humans never reach the prerender (control)', async () => {
    const { res, calls } = await run(`${SITE}/shop`, html200(), HUMAN);
    assert.equal(res, undefined);
    assert.equal(calls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared loaders — the SHIPPED files, executed
// ─────────────────────────────────────────────────────────────────────────────

const stripComments = require('./helpers/strip-comments');
const vm = require('node:vm');
const U = require('../inkcartridges/js/utils.js');
const Security = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), escapeAttr: (s) => String(s).replace(/"/g, '&quot;') };

/** Body of `name(...) { ... }` inside an object literal, brace-matched. */
function extractMethod(src, name) {
    // Both object-literal spellings: `name(a) {` and `name: function (a) {`.
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { params: m[1], body: src.slice(open, i + 1) }; }
    }
    throw new Error(`unbalanced ${name}`);
}
/** Compile a method from a source file into a callable bound to `self`. */
function method(file, name, self = {}, globals = {}) {
    const { params, body } = extractMethod(read(file), name);
    const ctx = vm.createContext({ Security, formatPrice: (n) => '$' + Number(n).toFixed(2), ...globals });
    const fn = vm.runInContext(`(function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}

const LIVE_VP = {   // GET /api/site/value-props, measured 2026-09-27 (tiers trimmed)
    loyalty: { active: true, points_per_dollar: 1, points_per_dollar_off: 100, welcome_bonus_points: 200,
        headline: 'Earn 1 point for every $1 you spend', detail: '100 points = $1 off a future order.' },
    volume_pricing: { active: true, starts_at_quantity: 2, max_discount_percent: 10,
        headline: 'Buy more, pay less per cartridge', detail: 'Order 2 or more…',
        tiers: [
            { min_price: 0, max_price: 20, min_quantity: 3, discount_percent: 4 },
            { min_price: 0, max_price: 20, min_quantity: 4, discount_percent: 5 },
            { min_price: 500, max_price: null, min_quantity: 2, discount_percent: 0.5 },
        ] },
    value_packs: { active: true, headline: 'Full sets in one value pack', detail: 'A value pack holds every colour…' },
    free_shipping: { active: true, threshold: 100, headline: 'Free shipping on orders over $100', detail: 'NZ-wide.' },
};

// ─────────────────────────────────────────────────────────────────────────────
// §2 ValueProps — one source for programme facts, fail-soft LOUDLY
// ─────────────────────────────────────────────────────────────────────────────

test('§2 accessors normalise the live shape', () => {
    const V = U.ValueProps;
    assert.deepEqual({ ...V.loyalty(LIVE_VP) }, { pointsPerDollar: 1, pointsPerDollarOff: 100, welcomeBonus: 200,
        headline: LIVE_VP.loyalty.headline, detail: LIVE_VP.loyalty.detail });
    assert.equal(V.freeShipping(LIVE_VP).threshold, 100);
    assert.equal(V.volume(LIVE_VP).tiers.length, 3);
    assert.ok(V.packs(LIVE_VP));
});

test('§2 an inactive or malformed programme reads as null — never advertised', () => {
    const V = U.ValueProps;
    assert.equal(V.loyalty({ loyalty: { ...LIVE_VP.loyalty, active: false } }), null);
    assert.equal(V.loyalty({ loyalty: { ...LIVE_VP.loyalty, points_per_dollar: 0 } }), null);
    assert.equal(V.freeShipping({ free_shipping: { active: true, threshold: null } }), null);
    assert.equal(V.volume({}), null);
    assert.equal(V.packs(null), null);
});

test('§2 pointsFor is integer-cent maths, floor, and prints nothing for < 1 point', () => {
    const V = U.ValueProps; const L = V.loyalty(LIVE_VP);
    assert.deepEqual({ ...V.pointsFor(71.49, L) }, { points: 71, value: 0.71 }, 'the backend\'s own example');
    assert.deepEqual({ ...V.pointsFor(0.1 + 0.2 + 0.7, L) }, { points: 1, value: 0.01 }, 'float noise must not lose a point');
    assert.equal(V.pointsFor(0.99, L), null);
    assert.equal(V.pointsFor(NaN, L), null);
    assert.equal(V.pointsFor(50, null), null);
});

test('§2 load() on a failed read returns ok:false WITH the reason (the loud half)', async () => {
    const V = Object.create(U.ValueProps);
    V._promise = null;
    const orig = { fetch: globalThis.fetch, ss: globalThis.sessionStorage };
    globalThis.sessionStorage = { getItem: () => null, setItem() {} };
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    try {
        const r = await V.load();
        assert.equal(r.ok, false);
        assert.match(r.error, /503/);
    } finally { globalThis.fetch = orig.fetch; globalThis.sessionStorage = orig.ss; }
});

test('§2 the strip is built from numbers, links each fact, and drops inactive programmes', () => {
    const V = U.ValueProps;
    const items = V.stripItems(LIVE_VP).map((i) => ({ ...i }));
    assert.deepEqual(items.map((i) => i.text), ['Free shipping over $100', 'Earn points on every order',
        'Lower prices when you buy more', 'Full sets in value packs']);
    assert.deepEqual(items.map((i) => i.href), ['/shipping', '/rewards', '/bulk-pricing', '/value-packs']);
    const noShip = V.stripItems({ ...LIVE_VP, free_shipping: { active: false, threshold: 100 } });
    assert.ok(!noShip.some((i) => /shipping/i.test(i.text)), 'an inactive threshold is never re-asserted');
    assert.deepEqual(V.stripItems({}), [], 'nothing confirmed, nothing said');
});

test('§2 bindAll hides the scope of a fact it could not confirm', async () => {
    const V = Object.create(U.ValueProps);
    const mk = (attr) => { const scope = { hidden: false }; return { scope, el: { textContent: 'Free shipping over $100', hidden: false,
        getAttribute: () => attr, closest: () => scope } }; };
    const a = mk('free_shipping.headline');
    const root = { querySelectorAll: () => [a.el] };
    V.load = async () => ({ ok: false, error: 'HTTP 503' });
    const r = await V.bindAll(root);
    assert.equal(r.ok, false);
    assert.equal(a.scope.hidden, true, 'a literal "$100" must not stay on screen unconfirmed');
    V.load = async () => ({ ok: true, data: LIVE_VP });
    await V.bindAll(root);
    assert.equal(a.scope.hidden, false);
    assert.equal(a.el.textContent, LIVE_VP.free_shipping.headline, 'verbatim from the API');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 printer names — SAME as the backend's crawler pages (measured fixtures)
// ─────────────────────────────────────────────────────────────────────────────

test('§3 PrinterName.display matches the backend prerender <h1> for every measured printer', () => {
    // raw full_name (GET /api/printers/search) → backend h1 (GET /api/prerender/printer/…), 2026-09-27
    const MEASURED = [
        ['HP COLOR LASERJET 5500', 'HP Color LaserJet 5500'],
        ['HP OFFICEJET PRO 8710', 'HP OfficeJet Pro 8710'],
        ['HP DESKJET 3630', 'HP DeskJet 3630'],
        ['HP DESK 3630', 'HP Desk 3630'],
        ['HP LASERJET ENTERPRISE M506', 'HP LaserJet Enterprise M506'],
        ['HP PAGEWIDE PRO 477DW', 'HP PageWide Pro 477DW'],
        ['HP COLOR LASERJET CM 1312', 'HP Color LaserJet CM 1312'],
        ['HP ENVY 4500', 'HP ENVY 4500'],
        ['Kyocera ECOSYS M2040DN', 'Kyocera ECOSYS M2040DN'],
        ['Fuji Xerox PHASER 5500', 'Fuji Xerox PHASER 5500'],
        ['Brother MFC J5930DW', 'Brother MFC J5930DW'],
        ['HP LaserJet Pro MFP M428fdw', 'HP LaserJet Pro MFP M428fdw'],
        ['Lexmark CS310dn', 'Lexmark CS310dn'],
        ['Canon PIXMA MG3660', 'Canon PIXMA MG3660'],
        ['Epson EcoTank ET-2720', 'Epson EcoTank ET-2720'],
    ];
    for (const [raw, backend] of MEASURED) assert.equal(U.PrinterName.display(raw), backend, raw);
    assert.equal(U.PrinterName.display(null), '');
});

test('§3 fitsLine: two models then +N, nothing when the row has no list', () => {
    const P = (n) => ({ full_name: n });
    assert.equal(U.PrinterName.fitsLine([P('Brother MFC J5930DW'), P('Brother MFC J6935DW'), P('A'), P('B')]),
        'Fits Brother MFC J5930DW, Brother MFC J6935DW +2');
    assert.equal(U.PrinterName.fitsLine([P('HP COLOR LASERJET 5500')]), 'Fits HP Color LaserJet 5500');
    assert.equal(U.PrinterName.fitsLine(undefined), '', 'listing payloads carry no compatible_printers today');
    assert.equal(U.PrinterName.fitsLine([]), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 PDP — the dispatch promise follows `same_day_eligible`
// ─────────────────────────────────────────────────────────────────────────────

test('§4 dispatch clause: true → locked copy (+ scope), false → next business day, absent → nothing', () => {
    const clause = method('js/product-detail-page.js', '_dispatchClause');
    const promise = 'Auckland metro orders placed before 14:00 NZT on a business day are dispatched the same day.';
    const yes = clause({ same_day_eligible: true, promise }, '2pm');
    assert.match(yes, /Order before 2pm NZT for same-day dispatch \(Auckland metro\)/);
    // Measured 2026-09-27 20:55-equivalent: the API said false and the PDP still promised same-day.
    const no = clause({ same_day_eligible: false, promise }, '2pm');
    assert.match(no, /Ships next business day/);
    assert.doesNotMatch(no, /same-day/i, 'never the same-day claim when the API says it cannot be kept');
    assert.equal(clause({}, '2pm'), '', 'unknown eligibility is not a promise either way');
    assert.equal(clause(undefined, '2pm'), '');
    assert.doesNotMatch(clause({ same_day_eligible: true, promise: 'nationwide' }, '2pm'), /Auckland/);
});

test('§4 the delivery row is built through _dispatchClause, not the old unconditional string', () => {
    const src = stripComments(read('js/product-detail-page.js'));
    const fn = extractMethod(src, 'renderBuyBoxDeliveryAndReturns').body;
    assert.match(fn, /this\._dispatchClause\(delivery, dCutoff\)/);
    assert.doesNotMatch(fn, /same-day dispatch/, 'the claim lives only in the gated helper');
});

test('§4 pack offer copy uses the backend numbers and count exactly as returned', () => {
    const src = stripComments(read('js/product-detail-page.js'));
    const fn = extractMethod(src, 'renderPackSuggestion').body;
    assert.match(fn, /Buy the full set/);
    assert.match(fn, /parseInt\(ps\.cartridge_count, 10\)/);
    assert.match(fn, /vs buying the \$\{count\} separately/);
    assert.match(fn, /savings <= 0/, 'no saving ⇒ no card (the pack is not cheaper)');
});

test('§4 PDP fit + value slots sit ABOVE the Add button, and ship hidden', () => {
    const html = read('html/product/index.html');
    const fit = html.indexOf('id="product-fit"');
    const vl = html.indexOf('id="product-value-lines"');
    const add = html.indexOf('id="add-to-cart-btn"');
    assert.ok(fit > 0 && vl > 0 && fit < add && vl < add, 'printer fit and value lines precede Add to Cart');
    assert.match(html, /id="product-fit"[^>]*hidden/);
    assert.match(html, /id="product-value-lines"[^>]*hidden/);
    assert.match(html, /class="btn btn--primary atc-confirmation__checkout"/, 'after Add, Checkout is right there');
});

test('§4 points line: goods only, the rung price at the quantity in the box, integer cents', () => {
    const line = { hidden: true, textContent: '' };
    const self = { _loyalty: { pointsPerDollar: 1, pointsPerDollarOff: 100 }, _unitPrice: 33.49, _volumeLadder: null };
    const doc = { getElementById: (id) => (id === 'product-points-line' ? line : id === 'qty-input' ? { value: '3' } : null) };
    const sync = method('js/product-detail-page.js', 'syncPointsLine', self,
        { document: doc, ValueProps: U.ValueProps, Business: { offerAtQuantity: () => ({ businessPrice: 32.49 }) } });
    sync();
    assert.equal(line.textContent, 'Earn 100 points ($1.00) on this order', '33.49 × 3 = 100.47 → 100 points');
    self._volumeLadder = { breaks: [] };
    sync();
    assert.equal(line.textContent, 'Earn 97 points ($0.97) on this order', 'at 3+ the rung price 32.49 × 3 = 97.47 applies');
    self._loyalty = null; line.hidden = false;
    sync();
    assert.equal(line.textContent, 'Earn 97 points ($0.97) on this order', 'no loyalty ⇒ the function leaves the line alone (renderValueLines never created it)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 cart + checkout
// ─────────────────────────────────────────────────────────────────────────────

test('§5 cart shipping row: server numbers only, never "free" from absence', () => {
    const row = method('js/cart.js', '_shippingRowText');
    assert.equal(row({}, true), 'Free');
    assert.equal(row({ shipping: 7, is_shipping_estimate: true, free_shipping_threshold: 100 }, false), 'From $7.00 · free over $100');
    assert.equal(row({ shipping: 7, is_shipping_estimate: false }, false), '$7.00');
    assert.equal(row({ shipping: 0 }, false), 'Calculated at checkout', 'a 0 that is not "qualifies" is not free');
    assert.equal(row(null, false), 'Calculated at checkout');
    assert.equal(row({ shipping: 7, is_shipping_estimate: true }, false), 'From $7.00', 'no threshold ⇒ no threshold clause');
});

test('§5 the cross-sell modal never opens on a phone, and leads with Checkout on desktop', () => {
    const src = stripComments(read('js/cart.js'));
    const fn = extractMethod(src, '_showCrossSellModal').body;
    assert.match(fn.slice(0, 600), /matchMedia\(`\(min-width: \$\{tablet\}px\)`\)\.matches\) return;/,
        'the phone bail-out must run FIRST, before any fetch');
    const foot = fn.indexOf('crosssell-modal__foot'), grid = fn.indexOf('crosssell-modal__grid');
    assert.ok(foot > 0 && foot < grid, 'the way on comes before the upsell');
    assert.match(fn, /href="\/checkout" class="btn btn--primary crosssell-modal__checkout"/);
    assert.match(fn, /crosssell-modal__keep/);
});

test('§5 guest loyalty chip keeps the message verbatim and adds a link, never a gate', () => {
    const src = stripComments(read('js/cart.js'));
    const fn = extractMethod(src, '_renderLoyaltyChip').body;
    assert.match(fn, /chipEl\.textContent = lo\.message;/);
    assert.match(fn, /lo\.guest === true/);
    assert.match(fn, /\/account\/login\?tab=register/);
});

test('§5 checkout points line comes from the cart, and the guest link opens a new tab', () => {
    const el = { hidden: true, textContent: '', children: [], appendChild(c) { this.children.push(c); } };
    const doc = { getElementById: () => el, createElement: () => ({}), createTextNode: (t) => ({ t }) };
    const render = method('js/checkout-page.js', 'renderPointsLine', {}, { document: doc,
        Cart: { loyalty: { guest: true, earn_on_this_order: 71, earn_value_dollars: 0.71 } } });
    render();
    assert.equal(el.textContent, 'Earn 71 points ($0.71) on this order.');
    const a = el.children.find((c) => c.href);
    assert.equal(a.target, '_blank', 'never navigate a half-filled checkout away');
    assert.equal(el.hidden, false);
    const none = { hidden: false, textContent: 'x' };
    method('js/checkout-page.js', 'renderPointsLine', {}, { document: { getElementById: () => none }, Cart: { loyalty: null } })();
    assert.equal(none.hidden, true, 'no earn figure ⇒ no line');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 paid landing pages
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the shelf takes 8 rows WITH images; the pack rail takes packs not already shown', () => {
    const self = { POPULAR_ROW_LIMIT: 8, VALUE_PACK_RAIL_LIMIT: 8 };
    const split = method('js/shop-page.js', 'splitPopularRows', self);
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ sku: `S${i}`, image_url: i % 5 === 4 ? null : 'x', pack_type: i % 3 === 0 ? 'value_pack' : 'single' });
    const { shelf, packs } = split(rows);
    assert.equal(shelf.length, 8);
    assert.ok(shelf.every((r) => r.image_url), 'a paid landing page of placeholder tiles sells nothing');
    const onShelf = new Set(shelf.map((r) => r.sku));
    assert.ok(packs.every((r) => r.pack_type === 'value_pack' && !onShelf.has(r.sku)));
    assert.ok(packs.findIndex((r) => !r.image_url) === -1 || packs.slice(packs.findIndex((r) => !r.image_url)).every((r) => !r.image_url),
        'image-bearing packs first');
    assert.deepEqual(JSON.parse(JSON.stringify(split(null))), { shelf: [], packs: [] });
});

test('§6 each paid landing has its own h1; every other URL keeps the old one', () => {
    for (const [p, want] of [['/ink-cartridges', 'Ink Cartridges NZ — Genuine & Compatible'],
        ['/toner-cartridges/', 'Toner Cartridges NZ — Genuine & Compatible'], ['/shop', null]]) {
        const h1 = method('js/shop-page.js', 'landingH1', {}, { window: { location: { pathname: p } } });
        assert.equal(h1(), want, p);
    }
});

test('§6 the printer box is FIRST on the landing, uses /api/printers/search (no search_analytics write)', () => {
    const html = read('html/shop.html');
    const box = html.indexOf('id="landing-printer-search"'), shelf = html.indexOf('id="popular-row"');
    assert.ok(box > 0 && box < shelf);
    const fn = extractMethod(stripComments(read('js/shop-page.js')), 'renderLandingPrinterSearch').body;
    assert.match(fn, /API\.searchPrinters\(q\)/);
    assert.doesNotMatch(fn, /smartSearch|\/api\/search\//, 'ERR-254: a typeahead must not file searches');
    assert.match(fn, /PrinterName\.display/);
});

test('§6 the popular grid reserves one placeholder per shelf slot', () => {
    const grid = read('html/shop.html').match(/id="popular-row-grid">([\s\S]*?)<\/div>\s*<\/section>/)[1];
    assert.equal((grid.match(/product-card--placeholder/g) || []).length, 8);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 PDP early product fetch
// ─────────────────────────────────────────────────────────────────────────────

test('§7 pdp-prefetch picks the SKU from every PDP spelling, and skips what it must', () => {
    const P = require('../inkcartridges/js/pdp-prefetch.js');
    const L = (pathname, search = '') => ({ pathname, search, hostname: 'www.inkcartridges.co.nz' });
    assert.equal(P.skuFromLocation(L('/products/brother-lc3329xl/GLC3329XLBK')), 'GLC3329XLBK');
    assert.equal(P.skuFromLocation(L('/p/CLC37BK')), 'CLC37BK');
    assert.equal(P.skuFromLocation(L('/html/product/index.html', '?sku=GTN258BK')), 'GTN258BK');
    assert.equal(P.skuFromLocation(L('/products/x/GLC3329XLBK', '?printer_slug=brother-mfc')), null, 'printer context changes the request');
    assert.equal(P.skuFromLocation(L('/product/some-slug')), null, 'slug-only URLs need a lookup first');
    assert.equal(P.skuFromLocation(L('/ribbon/R123')), null, 'ribbons use another endpoint');
    assert.equal(P.skuFromLocation(L('/products/x/%E0%A4%A')), null, 'a malformed escape is skipped, not thrown');
});

test('§7 pdp-prefetch targets the SAME host Config.API_URL would', () => {
    const P = require('../inkcartridges/js/pdp-prefetch.js');
    const cfg = read('js/config.js');
    for (const host of ['www.inkcartridges.co.nz', 'inkcartridges.co.nz', 'localhost', 'x.vercel.app']) {
        const ctx = vm.createContext({ location: { hostname: host }, window: {}, console, document: { addEventListener() {} } });
        const api = vm.runInContext(`${cfg}\n;Config.API_URL`, ctx);
        assert.equal(P.apiBase(host), api, host);
    }
});

test('§7 getProduct consumes the prefetch once, only for its own path and the public route', () => {
    const fn = extractMethod(stripComments(read('js/api.js')), 'getProduct').body;
    assert.match(fn, /pre\.path === primaryPath && pre\.promise && this\._catalogRoute\(primaryPath\)\.anonymous/);
    assert.match(fn, /window\.__pdpPrefetch = null;/, 'consumed once');
    assert.match(fn, /primary\.kind === 'network-error'\) primary = null/, 'a failed head fetch is retried, not trusted');
    const html = read('html/product/index.html');
    const pre = html.indexOf('/js/pdp-prefetch.js'), firstDefer = html.indexOf('<script defer');
    assert.ok(pre > 0 && pre < firstDefer && !/<script[^>]*defer[^>]*pdp-prefetch/.test(html), 'loaded early and synchronously');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 explainer pages + dark-shipped joint items
// ─────────────────────────────────────────────────────────────────────────────

test('§8 /bulk-pricing lists each band\'s own breaks — no "—" that reads as "no discount"', () => {
    const { ValuePages } = require('../inkcartridges/js/value-pages.js');
    global.Security = Security;
    try {
        const html = ValuePages.tiersTableHtml(LIVE_VP.volume_pricing.tiers);
        assert.match(html, /\$0 – \$20<\/th><td>3\+ 4% off · 4\+ 5% off<\/td>/);
        assert.match(html, /\$500 and over<\/th><td>2\+ 0\.5% off<\/td>/);
        assert.doesNotMatch(html, /—/);
        assert.doesNotMatch(html, /up to|max/i, 'max_discount_percent is never printed');
        assert.equal(ValuePages.tiersTableHtml([]), '');
    } finally { delete global.Security; }
});

test('§8 the three pages + /review are routed in BOTH rewrite tables and carry no numbers in markup', () => {
    const vj = JSON.parse(read('vercel.json')), sj = JSON.parse(read('serve.json'));
    for (const slug of ['rewards', 'bulk-pricing', 'value-packs', 'review']) {
        assert.ok(vj.rewrites.some((r) => r.source === `/${slug}` && r.destination === `/html/${slug}`), `vercel ${slug}`);
        assert.ok(sj.rewrites.some((r) => r.source === slug && r.destination === `/html/${slug}.html`), `serve ${slug}`);
        const main = read(`html/${slug}.html`).match(/<main[\s\S]*<\/main>/)[0].replace(/<!--[\s\S]*?-->/g, '');
        assert.doesNotMatch(main, /\d+\s*%|\$\d/, `${slug}: every figure must come from the API`);
    }
    assert.match(read('html/review.html'), /<meta name="robots" content="noindex, nofollow">/);
});

test('§8 the §6a halves ship DARK and the consent box is unticked', () => {
    const cfg = read('js/config.js');
    assert.match(cfg, /DARK_FEATURES:\s*\{\s*guestCartEmail:\s*false,\s*guestReviews:\s*false,?\s*\}/);
    const box = read('html/checkout.html').match(/<input type="checkbox" id="guest-cart-email-consent"[^>]*>/)[0];
    assert.doesNotMatch(box, /checked/, 'NZ UEMA: consent is given by the shopper, never pre-ticked');
    assert.match(read('html/checkout.html'), /id="guest-cart-email-optin" hidden/);
    const fn = extractMethod(stripComments(read('js/checkout-page.js')), 'setupGuestCartEmail').body;
    assert.match(fn, /DARK_FEATURES\.guestCartEmail === true/);
    assert.match(fn, /if \(!box\.checked/);
});

test('§8 review form validation', () => {
    const { ReviewPage } = require('../inkcartridges/js/review-page.js');
    assert.equal(ReviewPage.validate({ rating: 5, title: '', body: 'Fits my MFC.' }), null);
    assert.match(ReviewPage.validate({ rating: 0, body: 'x' }), /star rating/);
    assert.match(ReviewPage.validate({ rating: 6, body: 'x' }), /star rating/);
    assert.match(ReviewPage.validate({ rating: 4, body: '   ' }), /sentence/);
    assert.match(ReviewPage.validate({ rating: 4, body: 'x'.repeat(2001) }), /2000/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 truthfulness (compliance: inv 9 / inv 13)
// ─────────────────────────────────────────────────────────────────────────────

function allStorefront(ext) {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'admin' || e.name === 'node_modules' || e.name === 'scripts') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else if (ext.some((x) => e.name.endsWith(x))) out.push(f);
    } };
    walk(ROOT);
    return out;
}

test('§9 ONE spelling of support hours across the storefront (owner: Mon–Fri 9am–5pm)', () => {
    const offenders = allStorefront(['.html', '.js']).filter((f) => /8am|8pm|7 days a week|, 7 days/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], 'the 8am–8pm / 7 days claim had no source');
});

test('§9 banned claims appear in none of the new copy', () => {
    const BANNED = /save up to|lowest price|best price|cheapest|guaranteed to fit|zero risk|risk[- ]free/i;
    const files = ['js/value-pages.js', 'js/review-page.js', 'js/pdp-prefetch.js', 'html/rewards.html', 'html/bulk-pricing.html',
        'html/value-packs.html', 'html/review.html'];
    // Comments are stripped: the modules' own docblocks NAME the banned phrases.
    for (const f of files) assert.doesNotMatch(f.endsWith('.js') ? stripComments(read(f)) : read(f).replace(/<!--[\s\S]*?-->/g, ''), BANNED, f);
    for (const [f, name] of [['js/product-detail-page.js', 'renderFitCheck'], ['js/product-detail-page.js', 'renderValueLines'],
        ['js/utils.js', 'fitsLine'], ['js/shop-page.js', 'renderLandingPrinterSearch']]) {
        assert.doesNotMatch(extractMethod(read(f), name).body, BANNED, `${f}#${name}`);
    }
});

test('§9 "3+ price", not "Bulk price", on cards — the rung\'s own quantity', () => {
    assert.match(read('js/business.js'), /\$\{Security\.escapeHtml\(this\.breakLabel\(entry\)\)\} price<\/span>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 overlays — inline only, and the value strip is one piece of markup
// ─────────────────────────────────────────────────────────────────────────────

test('§10 the value strip is in flow, identical on every header page, and never fixed', () => {
    const pages = allStorefront(['.html']).filter((f) => fs.readFileSync(f, 'utf8').includes('<header class="site-header">'));
    assert.ok(pages.length >= 34);
    const blocks = new Set(pages.map((f) => {
        const m = fs.readFileSync(f, 'utf8').match(/<aside class="value-strip"[\s\S]*?<\/aside>/);
        assert.ok(m, `${path.relative(ROOT, f)} is missing the value strip`);
        return m[0];
    }));
    assert.equal(blocks.size, 1, 'one markup everywhere');
    const css = stripComments(read('css/layout.css'));
    const rule = css.slice(css.indexOf('.value-strip {'), css.indexOf('}', css.indexOf('.value-strip {')));
    assert.doesNotMatch(rule, /position:\s*(fixed|sticky|absolute)/);
    assert.match(rule, /min-height:\s*32px/, 'height reserved before JS fills it (CLS)');
});

test('§10 the phone consent banner is one row with the short wording', () => {
    const css = stripComments(read('css/components.css'));
    const i = css.indexOf('@media (max-width: 768px) {\n    .consent-banner {');
    assert.ok(i > 0);
    const block = css.slice(i, css.indexOf('\n}', i));
    assert.doesNotMatch(block, /flex-direction:\s*column/, 'the 148px stack is gone');
    assert.match(block, /\.consent-banner__body-long\s*\{\s*display:\s*none/);
    assert.match(read('js/consent-banner.js'), /bodyShort: 'We use analytics cookies\.'/);
});

test('§10 the phone header hides on scroll-down only when it is safe to', () => {
    const src = stripComments(read('js/main.js'));
    assert.match(src, /header\.matches\(':focus-within'\)\) return false/, 'never while typing in search');
    assert.match(src, /menu\.classList\.contains\('is-open'\)\) return false/, 'never with the menu open');
    assert.match(src, /classList\.toggle\('site-header--offscreen'/, 'geometry-settled signal for the sticky-ATC observer (ERR-280)');
    assert.match(stripComments(read('css/layout.css')), /\.site-header--hidden\s*\{\s*transform:\s*translateY\(-100%\)/);
});

test('§10 desktop: fit + value lines move BELOW Add (order), phones keep DOM order (above)', () => {
    const css = stripComments(read('css/pages.css'));
    const i = css.indexOf('@media (min-width: 1100px) {\n    .product-info {\n        display: flex;');
    assert.ok(i > 0, 'the wide-layout reorder block must exist');
    const block = css.slice(i, css.indexOf('\n}', i));
    assert.match(block, /#product-fit,\s*\.product-info > #product-value-lines,\s*\.product-info > #product-specs\s*\{\s*order:\s*1;/);
    assert.match(css, /\.product-detail__layout > \* \{ min-width: 0; \}/, 'the info column must not overflow its phone track');
});
