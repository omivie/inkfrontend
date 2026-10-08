/**
 * ERR-301 — paid laptop visitors could not see a price or an Add button
 * ======================================================================
 *
 * backend-docs/inbox/ad-clicks-to-orders-FE-handoff-oct2026.md (2026-10-02;
 * supersedes ad-visitor-dropoff-… and paid-traffic-conversion-…, 1 Oct).
 * 54 tracked paid visits, 0 orders. On a laptop the product page put Add to
 * Cart at y 703 under the consent bar and the Google badge, the series page
 * put its first price at y 635, `code=288XL` led with standard 288, a
 * `pack=value_pack` ad landed on every single, and a genuine product with no
 * photo showed a grey "No Image" box.
 *
 * This suite pins the shipped functions and markup. The rendered geometry is
 * measured by `npm run probe:ad-visitor-dropoff` (four handoff viewports,
 * negative controls), which a source test cannot see.
 *
 *   §1 PDP markup: Price + Availability, then Add, then the promise, the
 *      ladder line, then Delivery/Returns/countdown/savings
 *   §2 renderPromise: verbatim backend copy, escaped, reviews link only via
 *      TrustStats.googleReviewsUrl, no fit guarantee
 *   §3 consent: a bottom-left card from 1100px; the badge lift only below it
 *   §4 ProductSort.byCodeThenColor { preferYield } on the live 288 family
 *   §5 the ad's intent: parse, freshness, fetch fan-out, cache key, URL
 *   §6 h1 on a code page (shop-page updateTitle + SeoMeta.reconcile)
 *   §7 BrandSource.tile — the GENUINE tile, and every surface that uses it
 *   §8 the short-laptop compact card is height-gated
 *
 * Run: node --test tests/ad-visitor-dropoff-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, 'inkcartridges', p), 'utf8');

const PDP_HTML = read('html/product/index.html');
const PDP_SRC = read('js/product-detail-page.js');
const SHOP_SRC = read('js/shop-page.js');
const SHOP_HTML = read('html/shop.html');
const API_SRC = read('js/api.js');
const SEO_SRC = read('js/seo-meta.js');
const PAGES_CSS = read('css/pages.css');
const COMPONENTS_CSS = read('css/components.css');

const SECURITY = {
    escapeHtml: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    escapeAttr: (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    sanitizeUrl: (u) => u,
};

/** Lift `name(args) { … }` out of an object literal, brace-matched from its body. */
function liftMethod(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist in the shipped source`);
    let i = src.indexOf('(', start), pd = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (!pd) break; }
    }
    let depth = 0, end = i;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    return src.slice(start, end + 1);
}

function liftInto(src, signatures, globals) {
    const sandbox = Object.assign({ console }, globals);
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.__lifted = {\n${signatures.map((s) => liftMethod(src, s)).join(',\n')}\n};`, sandbox);
    return sandbox.__lifted;
}

/** The real utils.js in a sandbox (BrandSource, ProductSort, TrustStats). */
function loadUtils() {
    const sb = {
        console, URL, URLSearchParams, setTimeout, clearTimeout, Security: SECURITY,
        document: { addEventListener() {}, querySelector() { return null; }, getElementById() { return null; }, readyState: 'complete' },
        localStorage: { getItem() { return null; }, setItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {} },
        navigator: {}, location: { search: '', pathname: '/' },
    };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(read('js/utils.js'), sb, { filename: 'utils.js' });
    return sb;
}
const UTILS = loadUtils();

// ─────────────────────────────────────────────────────────────────────────────
// §1 PDP markup — the decision first
// ─────────────────────────────────────────────────────────────────────────────

test('§1 PDP: Price + Availability, then Add, then promise, ladder line, then the terms block', () => {
    const at = (needle) => {
        const i = PDP_HTML.indexOf(needle);
        assert.ok(i >= 0, `${needle} must be in html/product/index.html`);
        return i;
    };
    const order = [
        'id="product-buybox"',
        'id="product-price"',
        'id="product-stock"',
        'class="product-info__actions"',
        'id="add-to-cart-btn"',
        'id="product-promise"',
        'id="volume-pricing-summary"',
        'id="product-terms"',
        'id="product-buybox-terms"',
        'id="product-delivery"',
        'id="product-returns"',
        'id="product-dispatch-countdown"',
        'id="product-pack-savings"',
        'id="product-printer-proof"',
        'id="pack-upsell"',
    ].map((n) => [n, at(n)]);
    for (let k = 1; k < order.length; k++) {
        assert.ok(order[k - 1][1] < order[k][1], `${order[k - 1][0]} must come before ${order[k][0]}`);
    }
});

test('§1 PDP: the Offer microdata stays on the Price/Availability <dl>; the terms <dl> carries none', () => {
    const offer = PDP_HTML.match(/<dl[^>]*id="product-buybox"[^>]*>/)[0];
    assert.match(offer, /itemprop="offers"/);
    assert.match(offer, /itemtype="https:\/\/schema\.org\/Offer"/);
    const terms = PDP_HTML.match(/<dl[^>]*id="product-buybox-terms"[\s\S]*?<\/dl>/)[0];
    assert.doesNotMatch(terms, /itemprop=/, 'Delivery/Returns rows never carried microdata — moving them out of the Offer is safe');
});

test('§1 PDP: phones keep the fit + value lines ABOVE Add in the DOM (the >=1100 order:2 drops them on desktop)', () => {
    assert.ok(PDP_HTML.indexOf('id="product-fit"') < PDP_HTML.indexOf('id="add-to-cart-btn"'));
    assert.ok(PDP_HTML.indexOf('id="product-value-lines"') < PDP_HTML.indexOf('id="add-to-cart-btn"'));
});

test('§1 PDP: the price-block CLS reserve fits the two rows it now holds, and the short-window rungs are gated', () => {
    const css = stripComments(PAGES_CSS);
    const m = css.match(/\.product-info__pricing \{ min-height: (\d+)px;/);
    assert.ok(m, 'the reserve rule must exist');
    assert.ok(Number(m[1]) <= 100, `a 208px reserve was sized for four rows; two need ~88 (got ${m[1]})`);
    assert.match(css, /@media \(min-width: 1100px\) and \(max-height: 620px\) \{[\s\S]*?\.product-info__title \{ min-height: 0; \}/);
});

test('§1 PDP: cost-per-page and renderError target the new blocks', () => {
    const code = stripComments(PDP_SRC);
    assert.match(code, /getElementById\('product-terms'\)[\s\S]{0,200}insertAdjacentHTML\('afterbegin'[\s\S]{0,200}product-cost-per-page/);
    assert.match(code, /const termsBlock = document\.getElementById\('product-terms'\);\s*if \(termsBlock\) termsBlock\.hidden = true;/);
    assert.match(code, /const promiseBlock = document\.getElementById\('product-promise'\);\s*if \(promiseBlock\) promiseBlock\.hidden = true;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 renderPromise
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_PROMISE = {   // GET /api/products/GGI690KCMY, 2026-10-02
    label: 'Not sure it fits? 30-day returns on unopened items',
    how_to_check: 'Search your printer model to see the cartridges listed for it. Every product page lists the printers it fits.',
    description: 'Unopened items can be returned within 30 days.',
};
const LIVE_ORG = { google_reviews_url: 'https://www.google.com/maps/search/?api=1&query=Office%20Consumables%20Ltd&query_place_id=ChIJ8bGI52pBDW0RIf8Y7CddGQk' };

function runPromise(info, { trustStats = UTILS.TrustStats } = {}) {
    const el = { innerHTML: '', hidden: true };
    const lifted = liftInto(PDP_SRC, ['renderPromise(info) {'], {
        Security: SECURITY,
        TrustStats: trustStats,
        document: { getElementById: (id) => (id === 'product-promise' ? el : null) },
    });
    lifted.renderPromise(info);
    return el;
}

test('§2 the backend label and how-to-check render verbatim, under Add, with the reviews link', () => {
    const el = runPromise({ trust_signals: { compatibility_promise: LIVE_PROMISE, organization: LIVE_ORG } });
    assert.equal(el.hidden, false);
    assert.match(el.innerHTML, /<p class="product-promise__label">Not sure it fits\? 30-day returns on unopened items<\/p>/);
    assert.match(el.innerHTML, /<a class="product-promise__how" href="\/\?scroll=ink-finder">Search your printer model/);
    assert.match(el.innerHTML, /<a class="product-promise__reviews" href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=[^"]+" target="_blank" rel="noopener">See our reviews on Google<\/a>/);
    assert.doesNotMatch(el.innerHTML, /★|stars?|rating|\(\d+\)/i, 'no star rating or review count (handoff §6)');
});

test('§2 every value is escaped', () => {
    const el = runPromise({ trust_signals: { compatibility_promise: { label: '<img src=x onerror=alert(1)>', how_to_check: '"><script>' } } });
    assert.doesNotMatch(el.innerHTML, /<img|<script/);
    assert.match(el.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('§2 a non-Google or non-https reviews URL is refused (TrustStats.googleReviewsUrl owns the rule)', () => {
    for (const url of ['http://www.google.com/maps', 'https://evil.example/maps', 'javascript:alert(1)']) {
        const el = runPromise({ trust_signals: { compatibility_promise: LIVE_PROMISE, organization: { google_reviews_url: url } } });
        assert.doesNotMatch(el.innerHTML, /product-promise__reviews/, `${url} must not be linked`);
    }
});

test('§2 nothing from the backend ⇒ hidden; never invents copy', () => {
    const el = runPromise({ trust_signals: {} });
    assert.equal(el.hidden, true);
    assert.equal(el.innerHTML, '');
    const none = runPromise({});
    assert.equal(none.hidden, true);
});

test('§2 the label moved, it was not copied: renderFitCheck no longer prints it', () => {
    const fn = stripComments(liftMethod(PDP_SRC, 'renderFitCheck(info) {'));
    assert.doesNotMatch(fn, /product-fit__promise-label|product-fit__how/);
    assert.doesNotMatch(stripComments(PDP_SRC), /guaranteed (to )?fit|fits your printer/i, 'no fit guarantee (inv 13)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 consent card
// ─────────────────────────────────────────────────────────────────────────────

test('§3 from 1100px the consent banner is a bottom-left card', () => {
    const css = stripComments(COMPONENTS_CSS);
    const i = css.indexOf('@media (min-width: 1100px) {\n    .consent-banner {');
    assert.ok(i > 0, 'the card block must exist');
    const block = css.slice(i, css.indexOf('\n}', i));
    assert.match(block, /left: 16px;/);
    assert.match(block, /right: auto;/);
    const w = Number((block.match(/width: (\d+)px;/) || [])[1]);
    assert.ok(w > 0 && w <= 380, `card width ${w}`);
    assert.match(block, /flex-direction: column;/);
});

test('§3 the badge lift applies ONLY below 1100px — nothing is raised over the card', () => {
    const css = stripComments(COMPONENTS_CSS);
    const rule = 'body.has-consent-banner #google-reviews-badge {\n    bottom: var(--consent-banner-height, 0px) !important;\n}';
    const at = css.indexOf(rule);
    assert.ok(at > 0, 'the ERR-233 lift rule is unchanged inside');
    assert.equal(css.indexOf(rule, at + 1), -1, 'exactly one lift rule');
    const media = css.lastIndexOf('@media', at);
    assert.match(css.slice(media, at), /^@media \(max-width: 1099\.98px\) \{\s*$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 sort: the yield the ad asked for leads its family
// ─────────────────────────────────────────────────────────────────────────────

// The live /api/shop?brand=epson&category=ink&code=288 rows (2026-10-02), trimmed.
const ROWS_288 = [
    ['G288BK', 'STD', 'Black', 'single'], ['G288C', 'STD', 'Cyan', 'single'],
    ['G288M', 'STD', 'Magenta', 'single'], ['G288Y', 'STD', 'Yellow', 'single'],
    ['G288HYBK', 'XL', 'Black', 'single'], ['G288HYC', 'XL', 'Cyan', 'single'],
    ['G288HYM', 'XL', 'Magenta', 'single'], ['G288HYY', 'XL', 'Yellow', 'single'],
].map(([sku, yield_tier, color, pack_type]) => ({
    sku, yield_tier, color, pack_type, source: 'genuine', product_type: 'ink_cartridge',
    series_codes: ['288'], brand: { name: 'Epson' }, name: `Epson Genuine ${sku}`,
}));

test('§4 default order is unchanged: STD block, then XL', () => {
    const out = UTILS.ProductSort.byCodeThenColor(ROWS_288).map((p) => p.sku);
    assert.deepEqual(out.slice(0, 4), ['G288BK', 'G288C', 'G288M', 'G288Y']);
});

test('§4 preferYield: 1 (code=288XL) puts the XL block first, colour order kept, family intact', () => {
    const out = UTILS.ProductSort.byCodeThenColor(ROWS_288, { preferYield: 1 }).map((p) => p.sku);
    assert.deepEqual(out, ['G288HYBK', 'G288HYC', 'G288HYM', 'G288HYY', 'G288BK', 'G288C', 'G288M', 'G288Y']);
    const breaks = UTILS.ProductSort.rowBreakIndices(UTILS.ProductSort.byCodeThenColor(ROWS_288, { preferYield: 1 }));
    assert.deepEqual(Array.from(breaks), [4], 'one row break, between the XL and STD blocks');
});

test('§4 preferYield null/absent behaves exactly like no option', () => {
    const a = UTILS.ProductSort.byCodeThenColor(ROWS_288).map((p) => p.sku);
    assert.deepEqual(UTILS.ProductSort.byCodeThenColor(ROWS_288, { preferYield: null }).map((p) => p.sku), a);
    assert.deepEqual(UTILS.ProductSort.byCodeThenColor(ROWS_288, {}).map((p) => p.sku), a);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 the ad's intent
// ─────────────────────────────────────────────────────────────────────────────

const INTENT = liftInto(SHOP_SRC, ['_parseIntent(rawCode, code, rawPack)', '_freshIntent()'], {});

test('§5 _parseIntent: 288XL → yield 1, requested kept; XXL → 2; value_pack only', () => {
    assert.deepEqual({ ...INTENT._parseIntent('288XL', '288', null) }, { code: '288', requested: '288XL', yieldPref: 1, pack: null });
    assert.deepEqual({ ...INTENT._parseIntent('812xxl', '812', null) }, { code: '812', requested: '812XXL', yieldPref: 2, pack: null });
    assert.deepEqual({ ...INTENT._parseIntent('564', '564', 'value_pack') }, { code: '564', requested: null, yieldPref: null, pack: 'value_pack' });
    assert.equal(INTENT._parseIntent('288', '288', null), null, 'nothing beyond the family ⇒ no intent');
    assert.equal(INTENT._parseIntent('288', '288', 'multipack'), null, 'only the documented pack filter');
    assert.equal(INTENT._parseIntent(null, null, 'value_pack'), null, 'no code ⇒ no intent');
});

test('§5 _freshIntent: stale the moment the page moves to another family', () => {
    const nav = { state: { code: '288', intent: { code: '288', requested: '288XL', yieldPref: 1, pack: null } }, _freshIntent: INTENT._freshIntent };
    assert.equal(nav._freshIntent().requested, '288XL');
    nav.state.code = '604';
    assert.equal(nav._freshIntent(), null);
});

test('§5 loadProducts sends the requested code UNCHANGED beside the family, and passes pack', () => {
    const fn = stripComments(liftMethod(SHOP_SRC, 'async loadProducts(navVersion)'));
    assert.match(fn, /const intent = this\._freshIntent\(\);/);
    assert.match(fn, /if \(intent && intent\.requested && !aliases\.includes\(intent\.requested\)\) aliases\.unshift\(intent\.requested\);/);
    assert.match(fn, /code: alias,\s*limit: 200,\s*\.\.\.\(packFilter \? \{ pack: packFilter \} : \{\}\)/);
    assert.match(fn, /-products-\$\{code\}\$\{packFilter \? `-pack-\$\{packFilter\}` : ''\}/, 'a pack answer is cached under its own key');
    assert.match(fn, /if \(mergedProducts\.length === 0 && !packFilter\) \{\s*\/?\/?[\s\S]{0,40}codesCacheKey9/, 'the whole-family chip cache is skipped for a pack request');
});

test('§5 getShopData: no compatible sidecar when a pack is requested (it would merge singles back)', () => {
    const fn = stripComments(liftMethod(API_SRC, 'async getShopData(params = {})'));
    assert.match(fn, /&& !params\.search\s*&& !params\.pack\);/);
});

test('§5 the address bar keeps the ad\'s code and pack while on that family; the canonical does not', () => {
    const fn = stripComments(liftMethod(SHOP_SRC, 'updateURL({ replace = false } = {}) {'));
    assert.match(fn, /params\.set\('code', \(_intent && _intent\.requested\) \|\| this\.state\.code\)/);
    assert.match(fn, /if \(_intent && _intent\.pack\) params\.set\('pack', _intent\.pack\);/);
    assert.match(SHOP_HTML, /<a class="drilldown-header__all" id="family-all-link" href="\/shop" hidden><\/a>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 a code page's h1 names the code
// ─────────────────────────────────────────────────────────────────────────────

test('§6 updateTitle: a code page writes brand + code into the (hidden) h1 AND the visible label', () => {
    const fn = stripComments(liftMethod(SHOP_SRC, 'updateTitle() {'));
    assert.match(fn, /if \(this\.state\.level === 'products' && this\.state\.code\) \{/);
    assert.match(fn, /productType = mirrored \|\| \[brand, this\.state\.code, productType\]\.filter\(Boolean\)\.join\(' '\);\s*this\.elements\.title\.textContent = productType;/);
    assert.match(fn, /this\.elements\.productTypeLabel\.textContent = productType;/);
});

test('§6 SeoMeta.reconcile mirrors the prerender h1 on a brand CODE page, hidden, into the label', () => {
    const code = stripComments(SEO_SRC);
    assert.match(code, /const codePage = surface === 'brand' && \/\[\?&\]code=\/\.test\(prerenderPath \|\| ''\);/);
    assert.match(code, /if \(\(surface === 'printer' \|\| codePage\) && head\.h1\) \{[\s\S]{0,120}this\._setH1\(head\.h1, surface === 'printer'\);/);
    // Run _setH1 for real: reveal=false keeps visually-hidden and fills the label.
    const h1 = { textContent: '', hidden: true, classList: { removed: 0, remove() { this.removed++; } } };
    const label = { textContent: 'Inkjet Cartridges', hidden: false };
    const lifted = liftInto(SEO_SRC, ['_setH1(text, reveal = true)'], {
        document: { getElementById: (id) => ({ 'drilldown-title': h1, 'product-type-label': label })[id] || null },
    });
    lifted._setH1('Epson 288 / 288XL Ink Cartridges', false);
    assert.equal(h1.textContent, 'Epson 288 / 288XL Ink Cartridges');
    assert.equal(h1.classList.removed, 0, 'still visually hidden on a code page');
    assert.equal(label.textContent, 'Epson 288 / 288XL Ink Cartridges', 'the shopper reads the crawled h1');
    lifted._setH1('HP ENVY 6130E Ink NZ');
    assert.equal(h1.classList.removed, 1, 'a printer hub still reveals it');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 the GENUINE tile
// ─────────────────────────────────────────────────────────────────────────────

const G288HYBK = { source: 'genuine', brand: { name: 'Epson' }, series_codes: ['288'], yield_tier: 'XL', color: 'Black', sku: 'G288HYBK', image_url: null };

test('§7 BrandSource.tile: genuine ⇒ brand + GENUINE + code, from backend fields only', () => {
    const html = UTILS.BrandSource.tile(G288HYBK);
    assert.match(html, /^<div class="genuine-tile" role="img" aria-label="Epson Genuine 288XL Black">/);
    assert.match(html, /<span class="genuine-tile__brand">Epson<\/span><span class="genuine-tile__label">Genuine<\/span><span class="genuine-tile__code">288XL Black<\/span>/);
    assert.doesNotMatch(html, /style=|color-block|background/, 'neutral: never a colour swatch (ERR-143)');
});

test('§7 compatible and UNKNOWN source get no tile — never inferred from a name (ERR-157)', () => {
    assert.equal(UTILS.BrandSource.tile({ ...G288HYBK, source: 'compatible' }), '');
    const { source, ...unknown } = G288HYBK;
    assert.equal(UTILS.BrandSource.tile({ ...unknown, name: 'Epson Genuine 288XL Black' }), '');
});

test('§7 escaped, hidden on request, and revealTile swaps a failed image for it', () => {
    const html = UTILS.BrandSource.tile({ ...G288HYBK, brand: { name: '<b>x</b>' }, color: '"><img>' }, { hidden: true, cls: 'genuine-tile--sm' });
    assert.doesNotMatch(html, /<b>|<img>/);
    assert.match(html, /class="genuine-tile genuine-tile--sm"[^>]* hidden>/);
    const tile = { hidden: true, classList: { contains: (c) => c === 'genuine-tile' } };
    const img = { style: {}, nextElementSibling: tile };
    assert.equal(UTILS.BrandSource.revealTile(img), true);
    assert.equal(tile.hidden, false);
    assert.equal(img.style.display, 'none');
    assert.equal(UTILS.BrandSource.revealTile({ nextElementSibling: null }), false);
});

test('§7 without Security loaded the tile is refused rather than emitted unescaped', () => {
    const sb = { console, document: { addEventListener() {} }, localStorage: { getItem() { return null; }, setItem() {} }, navigator: {}, location: { search: '' } };
    sb.window = sb; sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(read('js/utils.js'), sb);
    assert.equal(sb.BrandSource.tile(G288HYBK), '');
});

test('§7 every image surface uses the tile for a genuine no-image row and on a failed genuine image', () => {
    const surfaces = {
        'js/products.js': 2, 'js/shop-page.js': 2, 'js/product-detail-page.js': 2, 'js/cart.js': 2,
        'js/favourites.js': 2, 'js/checkout-page.js': 2, 'js/order-confirmation-page.js': 2,
        'js/order-detail-page.js': 2, 'js/payment-page.js': 1, 'js/ribbons-page.js': 2,
    };
    for (const [file, min] of Object.entries(surfaces)) {
        const n = (stripComments(read(file)).match(/BrandSource\.tile\(/g) || []).length;
        assert.ok(n >= min, `${file}: expected ≥ ${min} BrandSource.tile calls, found ${n}`);
    }
    for (const file of ['js/products.js', 'js/cart.js', 'js/product-detail-page.js', 'js/order-confirmation-page.js', 'js/ribbons-page.js']) {
        assert.match(stripComments(read(file)), /BrandSource\.revealTile\(this\)/, `${file}: the error handler must try the tile`);
    }
    assert.doesNotMatch(read('js/payment-page.js'), /src="\$\{[^}]*placeholder\.png/, 'placeholder.png never existed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 the compact /shop card is a short-laptop layout only
// ─────────────────────────────────────────────────────────────────────────────

test('§8 compact card rules live only inside the height-gated media blocks', () => {
    const css = stripComments(PAGES_CSS);
    const sel = '.shop-page .products-row .product-card .product-card__image-wrapper';
    let at = -1;
    const blocks = [];
    while ((at = css.indexOf(sel, at + 1)) !== -1) blocks.push(css.slice(css.lastIndexOf('@media', at), at));
    assert.equal(blocks.length, 2, 'two tiers: <= 800 and <= 620 tall');
    assert.match(blocks[0], /^@media \(min-width: 1100px\) and \(max-height: 800px\)/);
    assert.match(blocks[1], /^@media \(min-width: 1100px\) and \(max-height: 620px\)/);
});
