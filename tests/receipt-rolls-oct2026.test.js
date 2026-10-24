'use strict';
/**
 * Receipt rolls on the storefront (ERR-368, backend handoff 2026-10-23,
 * FE-MASTER-CHECKLIST item 48; the handoff text is in
 * backend-docs/inbox/receipt-rolls-FE-handoff-oct2026.md).
 *
 * The backend sells 19 Okin POS paper rolls, `product_type: 'receipt_roll'`.
 * Before this change:
 *   - www 301'd /shop?category=receipt (the nav feed's own link) to bare /shop,
 *     because `receipt` was missing from the edge allow-list;
 *   - /receipt-rolls was a 404;
 *   - a roll page carried the cartridge framing: a COMPATIBLE badge (the API
 *     sends source 'compatible'), the "not made by …" disclaimer, and a black
 *     colour block for the carbonless roll that ships no photo.
 *
 * What this file EXECUTES, not greps: the real middleware (redirect + bot
 * routing), the real canonicalizeCategory / BrandSource / ProductSort from
 * utils.js, SeoMeta's routing and h1 mirror, shop-page's parseURLState and
 * renderProducts, the PDP's view model, spec rows, printer slot and related
 * rail, and products.js's card image. The fixtures are the live payloads,
 * measured 2026-10-24.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(INK, p), 'utf8');

const MIDDLEWARE_SRC = read('middleware.js');
const SHOP_SRC = stripComments(read('js/shop-page.js'));
const PDP_SRC = stripComments(read('js/product-detail-page.js'));
const VERCEL = JSON.parse(read('vercel.json'));
const SeoMeta = require(path.join(INK, 'js', 'seo-meta.js'));

const SITE = 'https://www.inkcartridges.co.nz';
const BACKEND = 'https://ink-backend-sg.onrender.com';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36';

// The 19 SKUs in the order GET /api/products?category=receipt returns them
// (bond, carbonless, thermal, then size) — measured 2026-10-24.
const API_ORDER = [
    'CBR37X70P10', 'CBR44X75P10', 'CBR57X57P10', 'CBR76X70P5', 'CBR76X76P5',
    'CCR76X76P5',
    'CTR57X25P10', 'CTR57X38P10', 'CTR57X40P10', 'CTR57X47P10', 'CTR57X50P10', 'CTR57X50P4',
    'CTR57X57P10', 'CTR57X75P10', 'CTR76X48P5', 'CTR80X60P5', 'CTR80X70P5', 'CTR80X80P2', 'CTR80X80P5',
];
const PRICES = {
    CTR57X50P4: 5.79, CTR80X80P2: 8.79, CTR57X38P10: 9.79, CTR76X48P5: 9.79, CTR57X25P10: 10.49,
    CTR57X40P10: 10.49, CBR57X57P10: 11.49, CBR76X70P5: 13.49, CTR57X47P10: 13.49, CTR57X50P10: 13.49,
    CTR80X60P5: 13.79, CBR76X76P5: 15.79, CBR37X70P10: 16.49, CTR80X70P5: 17.79, CBR44X75P10: 18.49,
    CTR57X57P10: 18.49, CTR80X80P5: 18.79, CCR76X76P5: 19.79, CTR57X75P10: 28.49,
};
const NAME = (sku) => {
    const [, kind, w, d, n] = /^C(TR|BR|CR)(\d+)X(\d+)P(\d+)$/.exec(sku);
    const paper = kind === 'TR' ? 'Thermal Receipt' : kind === 'BR' ? 'Bond Paper' : 'Carbonless Paper';
    return `${paper} Rolls ${w}x${d}mm (Pack of ${n})`;
};
const roll = (sku, extra = {}) => ({
    id: `id-${sku}`, sku, name: NAME(sku), product_type: 'receipt_roll', source: 'compatible',
    category: 'CON-ROLLS', brand: { name: 'Okin', slug: 'okin' }, retail_price: PRICES[sku],
    color: null, color_hex: null, page_yield: null, series_codes: [], compatible_printers: [],
    image_url: sku === 'CCR76X76P5' ? null : `https://example.test/${sku}/product.jpg`,
    ...extra,
});
const ROLLS = API_ORDER.map((s) => roll(s));

const CTR80X80P5 = roll('CTR80X80P5', {
    name: 'Thermal Receipt Rolls 80x80mm, BPA Free (Pack of 5)',
    display_name: 'Thermal Receipt Rolls 80x80mm, BPA Free (Pack of 5)',
    manufacturer_part_number: 'ITR80X80',
    specifications: { paper: 'Thermal', bpa_free: true, roll_width_mm: 80, rolls_per_pack: 5, paper_weight_gsm: 60, roll_diameter_mm: 80 },
    trust_signals: { warranty: { compatible_label: 'Compatible cartridges are covered by our 30-day satisfaction guarantee.' } },
});
const CCR76X76P5 = roll('CCR76X76P5', {
    specifications: { paper: 'Carbonless 2-ply (white/yellow)', roll_width_mm: 76, rolls_per_pack: 5, paper_weight_gsm: 48, roll_diameter_mm: 76 },
});
const CTR57X25P10 = roll('CTR57X25P10', {
    specifications: { core: 'Coreless', paper: 'Thermal', bpa_free: true, roll_width_mm: 57, rolls_per_pack: 10, paper_weight_gsm: 60, roll_diameter_mm: 25 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Harness: one vm context with the REAL utils.js (BrandSource, ProductSort,
// ProductColors, canonicalizeCategory, ProductName) and products.js on top.
// ─────────────────────────────────────────────────────────────────────────────
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const Security = { escapeHtml, escapeAttr: escapeHtml, sanitizeUrl: (u) => u };

function browserContext() {
    const sb = {
        console, URL, URLSearchParams, setTimeout, clearTimeout, Security,
        document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; }, readyState: 'complete' },
        localStorage: { getItem() { return null; }, setItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {} },
        navigator: {}, location: { search: '', pathname: '/' },
        DebugLog: { log() {}, warn() {}, error() {} },
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        qualifiesForFreeShipping: () => false,
        storageUrl: (u) => u, storageUrlRaw: (u) => u, imageSrcset: () => '',
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(read('js/utils.js'), sb, { filename: 'utils.js' });
    vm.runInContext(read('js/products.js'), sb, { filename: 'products.js' });
    return sb;
}
const CTX = browserContext();

/** A method of a `{ ... }` controller object, by name, brace-matched (8-space indent). */
function method(src, name) {
    const m = new RegExp(`\\n        (?:async )?${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = src.indexOf('{', src.indexOf(')', m.index));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1).trim();
    }
    throw new Error(`unbalanced ${name}`);
}
/** A top-level `function name(` in an IIFE module (4-space indent). */
function fn(src, name) {
    const m = new RegExp(`\\n    function ${name}\\(`).exec(src);
    assert.ok(m, `function ${name}() must exist`);
    const open = src.indexOf('{', src.indexOf(')', m.index));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1).trim();
    }
    throw new Error(`unbalanced ${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Real middleware, executed (pattern: tests/chip-prerender-sep2026.test.js)
// ─────────────────────────────────────────────────────────────────────────────
let middlewareFn = null;
let tmpFile = null;
async function middleware() {
    if (middlewareFn) return middlewareFn;
    tmpFile = path.join(os.tmpdir(), `ic-mw-rolls-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, MIDDLEWARE_SRC);
    middlewareFn = (await import(`file://${tmpFile}`)).default;
    return middlewareFn;
}
test.after(() => { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); });

async function run(url, ua) {
    const mw = await middleware();
    const original = globalThis.fetch;
    let fetched = null;
    globalThis.fetch = async (target) => {
        fetched = String(target);
        return new Response('<html><head><title>stub</title></head><body></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    };
    try {
        const req = { url, headers: { get: (k) => (String(k).toLowerCase() === 'user-agent' ? ua : null) } };
        const res = await mw(req);
        return { res, fetched };
    } finally {
        globalThis.fetch = original;
    }
}
/** What a SHOPPER's document request gets: 'pass' (200 from the SPA) or the 301 target. */
async function edgeFor(search) {
    const { res } = await run(`${SITE}/shop${search}`, HUMAN);
    if (!res) return 'pass';
    assert.equal(res.status, 301, `unexpected status for ${search}`);
    return res.headers.get('location');
}

test('§1 P0 — /shop?category=receipt is no longer 301-ed to /shop (the reported bug)', async () => {
    assert.equal(await edgeFor('?category=receipt'), 'pass');
    assert.equal(await edgeFor('?brand=okin&category=receipt'), 'pass');
});

test('§1 the backend aliases 301 to `receipt`, keeping every other param', async () => {
    for (const alias of ['receipt-rolls', 'receipt-roll', 'receipt_roll']) {
        assert.equal(await edgeFor(`?category=${alias}`), `${SITE}/shop?category=receipt`, alias);
    }
    assert.equal(await edgeFor('?brand=okin&category=receipt-rolls'), `${SITE}/shop?brand=okin&category=receipt`);
});

test('§1 photo_paper (the paper category\'s product_type) now aliases to paper instead of being stripped', async () => {
    assert.equal(await edgeFor('?category=photo_paper'), `${SITE}/shop?category=paper`);
});

test('§1 NEGATIVE CONTROL — unknown categories are still stripped, existing ones still pass', async () => {
    assert.equal(await edgeFor('?category=junk'), `${SITE}/shop`);
    assert.equal(await edgeFor('?category=receipts'), `${SITE}/shop`, 'only the backend\'s three aliases — no guessing');
    for (const ok of ['ink', 'toner', 'ribbon', 'drums', 'label', 'paper']) assert.equal(await edgeFor(`?category=${ok}`), 'pass', ok);
});

test('§1 bots get the receipt category prerender on all three URLs that show the listing', async () => {
    const want = `${BACKEND}/api/prerender/category/receipt`;
    assert.equal((await run(`${SITE}/receipt-rolls`, GOOGLEBOT)).fetched, want);
    assert.equal((await run(`${SITE}/shop?category=receipt`, GOOGLEBOT)).fetched, want);
    // There is no Okin brand prerender (measured: /api/prerender/brand/okin?category=receipt → 404),
    // and the SPA shows the category listing here, so the bot must get the category page too.
    assert.equal((await run(`${SITE}/shop?brand=okin&category=receipt`, GOOGLEBOT)).fetched, want);
});

test('§1 the okin arm does not capture narrower shapes, and other brands are untouched', async () => {
    assert.equal((await run(`${SITE}/shop?brand=okin&category=receipt&code=X`, GOOGLEBOT)).fetched,
        `${BACKEND}/api/prerender/brand/okin?code=X&category=receipt`);
    assert.equal((await run(`${SITE}/shop?brand=brother&category=toner`, GOOGLEBOT)).fetched,
        `${BACKEND}/api/prerender/brand/brother?category=toner`);
    assert.equal((await run(`${SITE}/receipt-rolls`, HUMAN)).fetched, null, 'humans get the SPA');
});

test('§1 /receipt-rolls is routed: middleware matcher + vercel rewrite to the shop SPA', async () => {
    const { config } = await import(`file://${tmpFile || (await middleware(), tmpFile)}`);
    assert.ok(config.matcher.includes('/receipt-rolls'), 'middleware must run on /receipt-rolls');
    const rw = (VERCEL.rewrites || []).find((r) => r.source === '/receipt-rolls');
    assert.ok(rw, 'vercel.json must rewrite /receipt-rolls');
    assert.equal(rw.destination, '/html/shop');
    // Redirects run before rewrites. The only pattern-shaped sources that could
    // reach a bare one-segment path are the `-ink-cartridges` / `-toner-
    // cartridges` / ribbon catch-alls; none mentions receipt or rolls. (The live
    // probe, npm run probe:receipt-rolls, measures the 200 itself.)
    const hit = (VERCEL.redirects || []).filter((r) => /receipt|rolls/.test(r.source) || r.source === '/:path*');
    assert.deepEqual(hit, [], 'no vercel redirect may catch /receipt-rolls first');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 client ⇄ edge parity
// ─────────────────────────────────────────────────────────────────────────────
test('§2 canonicalizeCategory agrees with the edge on every slug the edge decides', async () => {
    const SLUGS = ['ink', 'toner', 'ribbon', 'drums', 'label', 'paper', 'receipt',
        'ribbons', 'ink-cartridges', 'photo_paper', 'receipt-rolls', 'receipt-roll', 'receipt_roll', 'junk'];
    for (const slug of SLUGS) {
        const edge = await edgeFor(`?category=${slug}`);
        const edgeSlug = edge === 'pass' ? slug : (new URL(edge).searchParams.get('category'));
        assert.equal(CTX.canonicalizeCategory(slug), edgeSlug, `client and edge disagree on "${slug}"`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 SeoMeta — same prerender as the edge, same title and h1 as the prerender
// ─────────────────────────────────────────────────────────────────────────────
const loc = (pathname, search = '') => ({ pathname, search });

test('§3 SeoMeta mirrors the edge for the three listing URLs, and not for narrower ones', () => {
    const want = '/api/prerender/category/receipt';
    assert.equal(SeoMeta.prerenderPathForLocation(loc('/receipt-rolls')), want);
    assert.equal(SeoMeta.prerenderPathForLocation(loc('/shop', '?category=receipt')), want);
    assert.equal(SeoMeta.prerenderPathForLocation(loc('/shop', '?brand=okin&category=receipt')), want);
    assert.notEqual(SeoMeta.prerenderPathForLocation(loc('/shop', '?brand=okin&category=receipt&q=80x80')), want);
    for (const l of [loc('/receipt-rolls'), loc('/shop', '?category=receipt'), loc('/shop', '?brand=okin&category=receipt')]) {
        assert.equal(SeoMeta.surfaceForLocation(l), 'category-receipt');
    }
});

test('§3 the fail-open title is the prerender\'s own title, and the copy claims no cartridges', () => {
    const built = SeoMeta.buildForSurface('category-receipt', { trust: {} });
    assert.equal(built.title, 'Thermal Receipt & EFTPOS Rolls NZ — Fast NZ Delivery');
    assert.doesNotMatch(built.description, /genuine|compatible|cartridge/i);
});

test('§3 reconcile mirrors the prerender h1 onto the roll listing (visually hidden, label filled)', async () => {
    const h1 = { textContent: '', hidden: true, classList: { removed: 0, remove() { this.removed++; } } };
    const label = { textContent: 'Receipt Rolls', hidden: false };
    const prevDoc = global.document; const prevFetch = global.fetch;
    global.document = { getElementById: (id) => ({ 'drilldown-title': h1, 'product-type-label': label })[id] || null, title: '', querySelector: () => null, head: { appendChild() {} } };
    global.fetch = async () => new Response('<html><head><title>Thermal Receipt &amp; EFTPOS Rolls NZ — Fast NZ Delivery</title><meta name="description" content="19 receipt rolls"></head><body><h1>Receipt Rolls NZ — Buy Online at InkCartridges.co.nz</h1></body></html>', { status: 200 });
    try {
        const ok = await SeoMeta.reconcile('/api/prerender/category/receipt', undefined, 'category-receipt');
        assert.equal(ok, true);
    } finally {
        global.document = prevDoc; global.fetch = prevFetch;
    }
    assert.equal(h1.textContent, 'Receipt Rolls NZ — Buy Online at InkCartridges.co.nz');
    assert.equal(h1.classList.removed, 0, 'kept visually hidden, like a code page');
    assert.equal(label.textContent, 'Receipt Rolls NZ — Buy Online at InkCartridges.co.nz', 'the shopper reads the crawled h1');
    assert.equal(SeoMeta.h1For('/api/prerender/category/receipt'), 'Receipt Rolls NZ — Buy Online at InkCartridges.co.nz');
});

test('§3 the SPA\'s own h1 constant is byte-identical to the prerender\'s', () => {
    assert.match(SHOP_SRC, /RECEIPT_H1: 'Receipt Rolls NZ — Buy Online at InkCartridges\.co\.nz'/);
    assert.match(SHOP_SRC, /title {7}= 'Thermal Receipt & EFTPOS Rolls NZ — Fast NZ Delivery';/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 shop-page: level, URL, order, heading badge
// ─────────────────────────────────────────────────────────────────────────────
function shopSelf(pathname, search) {
    const replaced = [];
    const self = vm.runInNewContext(`({
        CATEGORY_INTERNAL_BY_CANONICAL: { drums: 'consumable', label: 'label_tape', ribbon: 'ribbons' },
        CATEGORY_CANONICAL_BY_INTERNAL: { consumable: 'drums', label_tape: 'label', ribbons: 'ribbon' },
        SORT_OPTIONS: ['recommended', 'price_asc', 'price_desc', 'name_asc', 'name_desc'],
        state: {},
        _parseIntent() { return null; },
        _sourceFilterFrom() { return null; },
        _freshIntent() { return null; },
        ${method(SHOP_SRC, 'parseURLState')},
        ${method(SHOP_SRC, 'updateURL')},
        ${method(SHOP_SRC, '_isReceiptListing')},
    })`, {
        URLSearchParams,
        canonicalizeCategory: CTX.canonicalizeCategory,
        window: { location: { pathname, search } },
        history: { replaceState: (s, t, u) => replaced.push(u), pushState: (s, t, u) => replaced.push(u), state: null },
    });
    return { self, replaced };
}

test('§4 every listing URL lands on the products level with category receipt — no brand picker', () => {
    for (const [p, q] of [['/shop', '?category=receipt'], ['/shop', '?brand=okin&category=receipt'], ['/receipt-rolls', ''], ['/receipt-rolls/', '']]) {
        const { self } = shopSelf(p, q);
        self.parseURLState();
        assert.equal(self.state.category, 'receipt', `${p}${q}`);
        assert.equal(self.state.level, 'products', `${p}${q} must not show the one-tile brand picker`);
        assert.equal(self._isReceiptListing(), true);
    }
});

test('§4 a search or a code still wins over the roll listing', () => {
    const { self } = shopSelf('/shop', '?category=receipt&q=80x80');
    self.parseURLState();
    assert.equal(self.state.level, 'search-results');
    assert.equal(self._isReceiptListing(), false);
});

test('§4 updateURL keeps /receipt-rolls while on it, and never pushes /shop visitors onto it', () => {
    let { self, replaced } = shopSelf('/receipt-rolls', '');
    self.parseURLState();
    self.state.sort = 'price_asc';
    self.updateURL({ replace: true });
    assert.equal(replaced.pop(), '/receipt-rolls?sort=price_asc');
    ({ self, replaced } = shopSelf('/shop', '?category=receipt'));
    self.parseURLState();
    self.updateURL({ replace: true });
    assert.equal(replaced.pop(), '/shop?category=receipt', 'canonical is /shop?category=receipt until the backend sets landingPath');
});

function renderInto(products, sort = 'recommended') {
    const container = { innerHTML: '', cards: [], appendChild(c) { if (c.sku) this.cards.push(c.sku); } };
    const section = { hidden: true };
    const self = vm.runInNewContext(`({
        state: { sort: ${JSON.stringify(sort)} },
        _syncSourceColumns() {},
        _freshIntent() { return null; },
        createProductCard(p) { return { sku: p.sku }; },
        ${method(SHOP_SRC, '_sortProductsBy')},
        ${method(SHOP_SRC, 'renderProducts')},
    })`, {
        ProductSort: CTX.ProductSort, ProductIdentity: CTX.ProductIdentity,
        partitionCompatRows: vm.runInNewContext(`(${fn(SHOP_SRC, 'partitionCompatRows')})`, {}),
        document: { createElement: () => ({ setAttribute() {} }) },
        getStockStatus: () => ({ class: 'in-stock' }),
    });
    self.renderProducts(products, container, section, true);
    return container.cards;
}

test('§4 the listing keeps the API\'s order (bond, carbonless, thermal, then size)', () => {
    assert.deepEqual(renderInto(ROLLS.map((r) => ({ ...r }))), API_ORDER);
});

test('§4 NEGATIVE CONTROL — without the guard, byCodeThenColor WOULD reorder the rolls', () => {
    const resorted = CTX.ProductSort.byCodeThenColor(ROLLS.map((r) => ({ ...r }))).map((p) => p.sku);
    assert.notDeepEqual(resorted, API_ORDER, 'if this ever passes, the guard is no longer load-bearing — re-check');
});

test('§4 an explicit sort still applies on the roll listing', () => {
    const cards = renderInto(ROLLS.map((r) => ({ ...r })), 'price_asc');
    assert.equal(cards[0], 'CTR57X50P4');
    assert.equal(cards[cards.length - 1], 'CTR57X75P10');
});

test('§4 _syncSourceColumns hides the COMPATIBLE heading badge on the roll listing only', () => {
    const run = (category) => {
        const badge = { hidden: false };
        const self = vm.runInNewContext(`({
            state: ${JSON.stringify({ category, level: 'products' })},
            elements: {
                sourceSections: { classList: { toggle() {} }, querySelector: (sel) => sel === '.products-section__badge--compatible' ? badge : null },
                compatibleSection: { hidden: false }, genuineSection: { hidden: true },
                sourceJump: { hidden: false }, sourceJumpCompatible: { hidden: false },
            },
            ${method(SHOP_SRC, '_isReceiptListing')},
            ${method(SHOP_SRC, '_syncSourceColumns')},
        })`, { badge });
        self._syncSourceColumns();
        return badge.hidden;
    };
    assert.equal(run('receipt'), true);
    assert.equal(run('ink'), false, 'every other listing keeps its badge');
});

test('§4 the loader is ONE no-brand /api/products read, loud when partial, an error pane when it fails', () => {
    const body = method(SHOP_SRC, 'loadReceiptRolls');
    assert.match(body, /API\.getProducts\(\{ category: 'receipt', limit: 100 \}\)/);
    assert.match(body, /total > rows\.length/);
    assert.match(body, /Showing \$\{rows\.length\} of \$\{total\} receipt rolls\./);
    assert.match(body, /this\.showError\(/);
    assert.doesNotMatch(body, /getShopData|brand/, 'no brand: Okin stays out of the request and the page');
});

async function runLoader(response) {
    const calls = { rendered: null, error: null, empty: null, note: { hidden: true, textContent: '' } };
    const self = vm.runInNewContext(`({
        navigationVersion: 1,
        elements: { compatibleTitleText: {}, genuineTitleText: {}, compatibleProducts: {}, compatibleSection: {}, genuineProducts: {}, genuineSection: {}, levelProducts: { hidden: true } },
        showLoading() {},
        ${method(SHOP_SRC, 'loadReceiptRolls')},
    })`, {
        API: { getProducts: async () => response },
        DebugLog: { warn() {}, error() {} },
        sectionTitleText: (t) => t,
        document: { getElementById: (id) => (id === 'receipt-rolls-partial' ? calls.note : null) },
    });
    self.renderProducts = (rows, c, s, compat) => { if (compat) calls.rendered = rows.map((r) => r.sku); };
    self.showError = (msg) => { calls.error = msg; };
    self.showEmpty = (msg) => { calls.empty = msg; };
    await self.loadReceiptRolls(1);
    calls.self = self;
    return calls;
}

test('§4 loader: 19 of 19 renders every roll, no partial note', async () => {
    const c = await runLoader({ ok: true, data: { products: ROLLS }, meta: { total: 19 } });
    assert.deepEqual(c.rendered, API_ORDER);
    assert.equal(c.note.hidden, true);
    assert.equal(c.self.elements.levelProducts.hidden, false);
    assert.equal(c.self.elements.compatibleTitleText.textContent, 'Receipt Rolls');
});

test('§4 loader: a page short of meta.total renders what arrived AND says so on screen', async () => {
    const c = await runLoader({ ok: true, data: { products: ROLLS.slice(0, 10) }, meta: { total: 19 } });
    assert.equal(c.rendered.length, 10);
    assert.equal(c.note.hidden, false);
    assert.equal(c.note.textContent, 'Showing 10 of 19 receipt rolls.');
});

test('§4 loader: a failed read is the error pane, never "no rolls"', async () => {
    const c = await runLoader({ ok: false, error: { code: 'SERVER_ERROR' } });
    assert.match(c.error, /couldn't load receipt rolls/);
    assert.equal(c.empty, null);
    assert.equal(c.rendered, null);
});

test('§4 the /shop landing has a one-click tile and the footer a link, both to the listing', () => {
    const html = read('html/shop.html');
    assert.match(html, /id="receipt-rolls-section"[\s\S]{0,1200}href="\/shop\?category=receipt"/);
    assert.match(read('js/footer.js'), /<li><a href="\/shop\?category=receipt">Receipt Rolls<\/a><\/li>/);
    assert.doesNotMatch(html + read('js/footer.js'), /brand=okin/, 'no Okin brand link (handoff §3)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 cards: no colour block for a roll
// ─────────────────────────────────────────────────────────────────────────────
test('§5 BrandSource.isSourceless is true for a roll only; BrandSource.of is unchanged', () => {
    assert.equal(CTX.BrandSource.isSourceless(CCR76X76P5), true);
    assert.equal(CTX.BrandSource.isSourceless({ product: { product_type: 'receipt_roll' } }), true);
    assert.equal(CTX.BrandSource.isSourceless({ product_type: 'ink_cartridge', source: 'compatible' }), false);
    assert.equal(CTX.BrandSource.isSourceless(null), false);
    assert.equal(CTX.BrandSource.of(CCR76X76P5), 'compatible', 'search still partitions rolls by source');
});

test('§5 the carbonless roll (no photo) shows the neutral placeholder, not the black COMPATIBLE block', () => {
    const html = CTX.Products.getProductImageHTML(CCR76X76P5);
    assert.match(html, /placeholder-product\.svg/);
    assert.doesNotMatch(html, /color-block/);
});

test('§5 a roll WITH a photo falls back to the placeholder on error, never a colour block', () => {
    const html = CTX.Products.getProductImageHTML(CTR80X80P5);
    assert.match(html, /data-fallback="placeholder"/);
    assert.doesNotMatch(html, /color-block/);
});

test('§5 POSITIVE CONTROL — a compatible cartridge with no photo still gets its colour block', () => {
    const html = CTX.Products.getProductImageHTML({ sku: 'C02BK', name: 'Compatible 02 Black', source: 'compatible', product_type: 'ink_cartridge', color: 'Black', image_url: null });
    assert.match(html, /product-card__color-block/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 product page
// ─────────────────────────────────────────────────────────────────────────────
/** vm arrays come from another realm; compare their JSON shape. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function pdpSelf(product, globals = {}) {
    return vm.runInNewContext(`({
        MIN_PLAUSIBLE_YIELD: 50,
        product: ${JSON.stringify(product)},
        ${method(PDP_SRC, 'getProductInfo')},
        ${method(PDP_SRC, 'normalizeProductType')},
        ${method(PDP_SRC, 'normalizeCategory')},
        ${method(PDP_SRC, 'detectCategory')},
        ${method(PDP_SRC, 'extractBrand')},
        ${method(PDP_SRC, 'plausibleYield')},
        ${method(PDP_SRC, 'rollSpecRows')},
        ${method(PDP_SRC, 'renderSpecs')},
        ${method(PDP_SRC, 'renderCompatiblePrinters')},
        getColorStyle() { return ''; },
    })`, { Security, ProductName: CTX.ProductName, storageUrl: (u) => u, ...globals });
}

test('§6 the view model drops a roll\'s source (no badge, no disclaimer, no colour tile)', () => {
    const info = pdpSelf(CTR80X80P5).getProductInfo();
    assert.equal(info.category, 'receipt');
    assert.equal(info.isRoll, true);
    assert.equal(info.source, null, 'every `info.source` reader renders nothing for a null source');
    assert.equal(info.isCompatible, false);
});

test('§6 POSITIVE CONTROL — a compatible cartridge keeps its source', () => {
    const info = pdpSelf({ sku: 'C02BK', name: 'Compatible 02 Black', source: 'compatible', product_type: 'ink_cartridge', brand: { name: 'HP' } }).getProductInfo();
    assert.equal(info.source, 'compatible');
    assert.equal(info.isCompatible, true);
    assert.equal(info.isRoll, false);
});

test('§6 the badge, disclaimer and colour tile all key on info.source / info.isCompatible', () => {
    // So the null source above is what hides them; pinned so a refactor cannot re-key one on this.product.
    assert.match(PDP_SRC, /if \(info\.source === 'genuine'\) \{\s*badge\.textContent = 'GENUINE';/);
    assert.match(PDP_SRC, /\} else if \(info\.source === 'compatible'\) \{\s*badge\.textContent = 'COMPATIBLE';/);
    assert.match(method(PDP_SRC, 'renderComplianceDisclaimer'), /if \(!info \|\| info\.source !== 'compatible'\) return;/);
    assert.match(PDP_SRC, /if \(info\.isCompatible && colorStyle\) \{/);
});

test('§6 the cart line still carries the raw source (data shape unchanged)', () => {
    assert.match(PDP_SRC, /product_source: this\.product\.source \|\| info\.source \|\| null,/);
});

test('§6 spec rows: CTR80X80P5 — every handoff key, in order, each pill readable on its own', () => {
    const self = pdpSelf(CTR80X80P5);
    assert.deepEqual(plain(self.rollSpecRows(self.getProductInfo())), [
        ['Roll width', '80 mm wide'], ['Roll diameter', '80 mm diameter'], ['Paper', 'Thermal paper'],
        ['Paper weight', '60 gsm'], ['BPA', 'BPA free'], ['Rolls per pack', '5 rolls per pack'],
    ]);
    // The labels are visually hidden in #product-specs (shared chip CSS), so a
    // bare "80 mm" pill twice would be meaningless — every value names itself.
    for (const [, v] of plain(self.rollSpecRows(self.getProductInfo()))) assert.doesNotMatch(v, /^\d+( mm)?$|^Yes$|^No$/);
});

test('§6 spec rows: absent keys give no row (carbonless has no bpa_free; only the 57x25 has a core)', () => {
    let self = pdpSelf(CCR76X76P5);
    assert.deepEqual(plain(self.rollSpecRows(self.getProductInfo()).map((r) => r[0])),
        ['Roll width', 'Roll diameter', 'Paper', 'Paper weight', 'Rolls per pack']);
    self = pdpSelf(CTR57X25P10);
    assert.deepEqual(plain(self.rollSpecRows(self.getProductInfo()).find((r) => r[0] === 'Core')), ['Core', 'Coreless']);
});

test('§6 spec rows: nothing for a non-roll, nothing for a missing or junk specifications object', () => {
    assert.deepEqual(plain(pdpSelf({}).rollSpecRows({ isRoll: false, specifications: { roll_width_mm: 80 } })), []);
    assert.deepEqual(plain(pdpSelf({}).rollSpecRows({ isRoll: true })), []);
    assert.deepEqual(plain(pdpSelf({}).rollSpecRows({ isRoll: true, specifications: { roll_width_mm: 'abc', paper: '  ', rolls_per_pack: -1 } })), []);
});

test('§6 renderSpecs paints the rows into #product-specs, escaped, and shows it', () => {
    const el = { innerHTML: '', hidden: true };
    const self = pdpSelf(CTR80X80P5, { document: { getElementById: (id) => (id === 'product-specs' ? el : null) } });
    const info = self.getProductInfo();
    info.specifications = { ...info.specifications, paper: 'Thermal <b>x</b>' };
    self.renderSpecs(info);
    assert.equal(el.hidden, false);
    assert.match(el.innerHTML, /Roll width<\/span><span class="product-info__spec-value">80 mm wide/);
    assert.match(el.innerHTML, /Thermal &lt;b&gt;x&lt;\/b&gt;/);
    assert.doesNotMatch(el.innerHTML, /Page yield|Colour/, 'yield and colour are null on rolls');
});

test('§6 the printers block is empty for a roll, with no for-use-in or Supabase lookup', async () => {
    const mounted = [];
    const self = pdpSelf(CTR80X80P5, { API: new Proxy({}, { get() { throw new Error('no API call expected'); } }) });
    self._forUseInPromise = Promise.reject(new Error('must not be awaited'));
    self._forUseInPromise.catch(() => {});
    self._mountCompat = (html) => mounted.push(html);
    self._fetchPrinters = () => { throw new Error('no Supabase lookup expected'); };
    await self.renderCompatiblePrinters(self.getProductInfo());
    assert.deepEqual(mounted, ['']);
});

test('§6 breadcrumb: Receipt Rolls → the listing, Okin as text (no brand page link), no code crumb', () => {
    assert.match(PDP_SRC, /if \(info\.isRoll\) \{[\s\S]{0,200}innerHTML = '<a href="\/shop\?category=receipt">Receipt Rolls<\/a>';\s*document\.getElementById\('breadcrumb-brand'\)\.innerHTML = `<span>\$\{Security\.escapeHtml\(info\.brandName\)\}<\/span>`;/);
    assert.match(PDP_SRC, /if \(!isRibbon && !info\.isRoll\) \{/);
});

test('§6 related rail: the six cheapest other rolls, in price order (the prerender\'s "Related Okin Products")', () => {
    const body = method(PDP_SRC, 'renderRelatedProducts');
    assert.match(body, /\} else if \(info\.isRoll\) \{[\s\S]{0,900}API\.getProducts\(\{ category: 'receipt', limit: 100 \}\)/);
    assert.match(body, /\.sort\(\(a, b\) => price\(a\) - price\(b\)\)\.slice\(0, 6\)/);
    assert.match(body, /if \(pt === 'receipt_roll'\) return 'roll';/);
    assert.match(body, /productType === 'roll' \? 'Receipt Rolls' :/);
    assert.match(body, /const out = info\.isRoll \? arr :/, 'rolls keep price order, no family regroup');
    // What the prerender listed for CTR80X80P5 on 2026-10-24, simulated on the same rule:
    const price = (p) => p.retail_price;
    const six = ROLLS.filter((p) => p.sku !== 'CTR80X80P5').sort((a, b) => price(a) - price(b)).slice(0, 6).map((p) => p.sku);
    assert.deepEqual(six, ['CTR57X50P4', 'CTR80X80P2', 'CTR57X38P10', 'CTR76X48P5', 'CTR57X25P10', 'CTR57X40P10']);
});

test('§6 receipt_roll is a real admin product type and maps to the receipt shop category', async () => {
    const types = await import(path.join(INK, 'js/admin/utils/product-types.js'));
    assert.equal(types.productTypeNoun('receipt_roll'), 'Receipt Roll');
    assert.equal(types.PRODUCT_TYPE_LABELS.receipt_roll, 'Receipt Rolls');
    const codes = await import(path.join(INK, 'js/admin/utils/product-codes.js'));
    assert.equal(codes.PRODUCT_TYPE_TO_SHOP_CATEGORY.receipt_roll, 'receipt');
});
