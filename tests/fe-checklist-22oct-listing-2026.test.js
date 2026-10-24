/**
 * FE checklist 2026-10-22 — find what fits (ERR-370)
 * =============================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md (22 Oct version).
 *
 *   §37  "Find your {Brand} printer" leads the paid landings AND every brand /
 *        brand + ink|toner|drums code grid, brand-filtered; site search opens an
 *        EXACT printer / product only on the backend's explicit flag.
 *   §46  printer pages: buyable first, cartridges before parts, cheapest first.
 *   §27a the compatible guarantee is ONE line under the COMPATIBLE head (shop +
 *        search dropdown), the backend's words, never on a genuine column or a
 *        receipt roll.
 *   §25  Filter & Sort is inline above the first card, never a fixed overlay.
 *   §24  the consent banner is the one-row bar at every width, equal buttons.
 *   §32  fix 1: nothing on the first screen starts invisible; fix 2: the paid
 *        landings paint their final h1.
 *
 * Run: node --test tests/fe-checklist-22oct-listing-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');
const SHOP = stripComments(read('js/shop-page.js'));
const SHOP_HTML = read('html/shop.html');

/** A `name(...) {` method body from object-literal source, brace-matched (strings aware). */
function methodSrc(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0; let q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
/** Bind a method to `self` with named globals. */
function method(name, self = {}, globals = {}) {
    const { params, body, async } = methodSrc(SHOP, name);
    const keys = Object.keys(globals);
    const fn = new Function(...keys, `return (${async ? 'async ' : ''}function (${params}) ${body});`)(...keys.map((k) => globals[k]));
    return fn.bind(self);
}
function propLiteral(name) {
    const m = new RegExp(`\\n\\s+${name}: (\\{[\\s\\S]*?\\n        \\}|\\[[^\\]]*\\]),`).exec(SHOP);
    assert.ok(m, `${name} must exist`);
    return new Function(`return ${m[1]};`)();
}

// ═══ §37 the printer finder ═════════════════════════════════════════════════

test('§37 where the finder shows: landings (all brands), brand pages, brand + printer-category grids', () => {
    const CATS = propLiteral('PRINTER_FINDER_CATEGORIES');
    const run = (state, path = '/shop') => {
        const self = { state, PRINTER_FINDER_CATEGORIES: CATS };
        self._isPaidLanding = method('_isPaidLanding', self, { window: { location: { pathname: path } } });
        return method('_printerFinderBrand', self)();
    };
    assert.equal(run({ level: 'brands' }, '/ink-cartridges'), '', 'paid landing: all brands');
    assert.equal(run({ level: 'brands' }, '/toner-cartridges/'), '');
    assert.equal(run({ level: 'brands' }, '/shop'), null, 'bare /shop unchanged');
    assert.equal(run({ level: 'categories', brand: 'canon' }), 'canon', '/shop?brand=canon');
    assert.equal(run({ level: 'codes', brand: 'canon', category: 'ink' }), 'canon', 'the page ad visitors left from');
    assert.equal(run({ level: 'codes', brand: 'brother', category: 'toner' }), 'brother');
    assert.equal(run({ level: 'codes', brand: 'brother', category: 'consumable' }), 'brother', 'drums');
    for (const cat of ['ribbons', 'label_tape', 'paper', 'receipt']) {
        assert.equal(run({ level: 'codes', brand: 'brother', category: cat }), null, `${cat}: no printer model to type`);
    }
    for (const level of ['products', 'printer-products', 'search-results']) {
        assert.equal(run({ level, brand: 'canon', category: 'ink' }), null, `${level}: the shopper is already there`);
    }
});

function fakeFinderDom() {
    const mk = (extra = {}) => ({ hidden: true, dataset: {}, innerHTML: '', textContent: '', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, ...extra });
    const els = {
        'landing-printer-search': mk(),
        'landing-printer-search-label': mk(),
        'landing-printer-search-input': mk({ value: '', placeholder: '' }),
        'landing-printer-search-results': mk(),
    };
    return { els, document: { getElementById: (id) => els[id] || null } };
}

test('§37 brand pages say "Find your Canon printer" with a Canon example; landings keep the generic label', () => {
    const { els, document } = fakeFinderDom();
    const self = { PRINTER_FINDER_EXAMPLES: propLiteral('PRINTER_FINDER_EXAMPLES'), brandName: (s) => ({ canon: 'Canon', xyz: 'Xyz' }[s] || s) };
    const render = method('renderLandingPrinterSearch', self, { document, API: { searchPrinters: async () => ({ ok: true, data: [] }) }, debounce: (f) => f, Security: { escapeAttr: String, escapeHtml: String } });
    render('canon');
    assert.equal(els['landing-printer-search'].hidden, false);
    assert.equal(els['landing-printer-search-label'].textContent, 'Find your Canon printer');
    assert.equal(els['landing-printer-search-input'].placeholder, 'e.g. Canon PIXMA TS5360');
    assert.equal(els['landing-printer-search'].dataset.brand, 'canon');
    render('xyz');
    assert.equal(els['landing-printer-search-input'].placeholder, 'e.g. Xyz model number', 'an unlisted brand: no invented model');
    render('');
    assert.equal(els['landing-printer-search-label'].textContent, 'Enter your printer model');
    assert.equal(els['landing-printer-search'].dataset.brand, '');
    render(null);
    assert.equal(els['landing-printer-search'].hidden, true);
});

test('§37 the typeahead filters by the brand it is showing for (one request)', async () => {
    const { els, document } = fakeFinderDom();
    const calls = [];
    const self = { PRINTER_FINDER_EXAMPLES: {}, brandName: () => 'Canon' };
    const render = method('renderLandingPrinterSearch', self, {
        document, debounce: (f) => f, Security: { escapeAttr: String, escapeHtml: String },
        API: { searchPrinters: async (q, b) => { calls.push([q, b]); return { ok: true, data: [{ slug: 'canon-pixma-ts5360', brand_slug: 'canon', full_name: 'Canon PIXMA TS5360' }] }; } },
        buildPrinterUrl: (p) => `/shop?brand=${p.brand_slug}&printer_slug=${p.slug}`,
        PrinterName: { of: (p) => p.full_name },
        finderHelpHtml: () => '',
    });
    render('canon');
    els['landing-printer-search-input'].value = 'TS5360';
    await els['landing-printer-search-input'].listeners.input();
    assert.deepEqual(calls, [['TS5360', 'canon']]);
    assert.match(els['landing-printer-search-results'].innerHTML, /href="\/shop\?brand=canon&printer_slug=canon-pixma-ts5360"/,
        'choosing the printer opens its printer page');
});

test('§37 the finder sits under the h1, outside every level, and is decided before the level loads', () => {
    const h1 = SHOP_HTML.indexOf('id="drilldown-title"');
    const box = SHOP_HTML.indexOf('<section class="landing-printer-search"');
    const levels = SHOP_HTML.indexOf('class="drilldown-content"');
    assert.ok(h1 > 0 && h1 < box && box < levels);
    const load = methodSrc(SHOP, 'loadCurrentLevel').body;
    const first = load.indexOf('this.renderLandingPrinterSearch(this._printerFinderBrand())');
    assert.ok(first > 0 && first < load.indexOf('switch (this.state.level)'), 'before the level awaits — no shift');
    assert.doesNotMatch(methodSrc(SHOP, 'renderBrands').body, /renderLandingPrinterSearch/, 'ONE caller site, not two');
});

test('§37 exact search match: only on the backend\'s explicit word', () => {
    const t = method('_exactSearchTarget', {}, { URL });
    assert.equal(t({ matched_printer: { slug: 'brother-mfc-j4340dw-xl' } }, 1), null,
        'today\'s matched_printer carries no exact flag (measured: "brother mfc-j4340dw" → the XL)');
    assert.deepEqual(t({ matched_printer: { slug: 'brother-mfc-j4340dw', exact: true } }, 1), { kind: 'printer' });
    assert.equal(t({ matched_printer: { slug: 'x', exact: 'true' } }, 1), null, 'literal true only');
    assert.deepEqual(t({ exact_product: { sku: 'CLC233BK', slug: 's', url: '/products/clc233bk-x/CLC233BK' } }, 1),
        { kind: 'product', href: '/products/clc233bk-x/CLC233BK' });
    assert.deepEqual(t({ exact_product: { url: 'https://www.inkcartridges.co.nz/products/a/B1' } }, 1), { kind: 'product', href: '/products/a/B1' });
    assert.equal(t({ exact_product: { url: 'https://evil.example/products/a/B1' } }, 1), null, 'never a foreign redirect');
    assert.equal(t({ exact_product: { url: '/account' } }, 1), null, 'only a product path');
    assert.equal(t({ matched_printer: { slug: 'x', exact: true } }, 2), null, 'page 2 is browsing');
    assert.equal(t(null, 1), null);
});

test('§37 the redirect lives on the results page, ahead of the zero-results branch', () => {
    const body = methodSrc(SHOP, 'loadSearchResults').body;
    const exact = body.indexOf('this._exactSearchTarget(smartData, requestedPage)');
    assert.ok(exact > 0 && exact < body.indexOf('const smartCorrected'), 'before the literal reconciliation');
    assert.match(body, /if \(exactTarget && exactTarget\.kind === 'product'\) \{\s*window\.location\.replace\(exactTarget\.href\);\s*return;/);
    assert.match(body, /if \(\(products\.length === 0 \|\| exactTarget\) && smartData\?\.matched_printer\?\.slug\)/);
});

// ═══ §46 printer page order ═════════════════════════════════════════════════

function loadStock() {
    const api = stripComments(read('js/api.js'));
    const start = api.indexOf('function getStockStatus(');
    let depth = 0; let end = -1;
    for (let i = api.indexOf('{', start); i < api.length; i++) {
        if (api[i] === '{') depth++; else if (api[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    return new Function('OOS_STOCK_LABEL', 'DebugLog', `${api.slice(start, end)}; return getStockStatus;`)('Contact us', undefined);
}

test('§46 printer_fit: buyable first, cartridges before drums, cheapest first, stable', () => {
    const { ProductSort } = require('../inkcartridges/js/utils.js');
    const sort = method('_sortProductsBy', {}, { getStockStatus: loadStock(), ProductSort });
    const rows = [
        { sku: 'DRUM', name: 'Compatible Drum Unit', category: 'toner', retail_price: '20', in_stock: true },
        { sku: 'OOS-CHEAP', name: 'Compatible Toner Cartridge', category: 'toner', retail_price: '5', in_stock: false },
        { sku: 'T-30', name: 'Compatible Toner Cartridge', category: 'toner', retail_price: '30', in_stock: true },
        { sku: 'T-12', name: 'Compatible Toner Cartridge', category: 'toner', retail_price: '12', in_stock: true },
        { sku: 'T-12b', name: 'Compatible Toner Cartridge', category: 'toner', retail_price: '12', in_stock: true },
        { sku: 'T-NOPRICE', name: 'Compatible Toner Cartridge', category: 'toner', in_stock: true },
    ];
    assert.deepEqual(sort(rows, 'printer_fit').map((r) => r.sku), ['T-12', 'T-12b', 'T-30', 'T-NOPRICE', 'DRUM', 'OOS-CHEAP']);
    assert.deepEqual(rows.map((r) => r.sku)[0], 'DRUM', 'pure: the input is not reordered');
});

test('§46 only the printer page uses it, inside each source section, with no yield breaks', () => {
    const render = methodSrc(SHOP, 'renderProducts').body;
    assert.match(render, /\} else if \(this\.state\.level === 'printer-products'\) \{\s*sortedProducts = compatLast\(this\._sortProductsBy\(products, 'printer_fit'\)\);\s*breaks = new Set\(\);/);
    // An explicit shopper sort still wins (it is checked first).
    assert.ok(render.indexOf("if (sortMode !== 'recommended')") < render.indexOf("'printer_fit'"));
    // Compatible section still renders above Genuine on the printer page.
    const load = methodSrc(SHOP, 'loadPrinterProducts').body;
    assert.ok(load.indexOf('compatibleProducts') > 0);
});

// ═══ §27a compatible guarantee ══════════════════════════════════════════════

test('§27a CompatGuarantee reads the live shape and the checklist\'s shape, never invents text', () => {
    const { CompatGuarantee } = require('../inkcartridges/js/utils.js');
    const label = 'Compatible cartridges are covered by our 30-day satisfaction guarantee.';
    assert.equal(CompatGuarantee.pick({ warranty: { compatible_label: label } }), label, 'live /api/site/trust');
    assert.equal(CompatGuarantee.pick({ trust_signals: { warranty: { compatible_label: ` ${label} ` } } }), label);
    assert.equal(CompatGuarantee.pick({}), '');
    assert.equal(CompatGuarantee.pick({ warranty: { compatible_label: 7 } }), '');
    assert.equal(CompatGuarantee.pick(null), '');
    for (const f of ['js/utils.js', 'js/shop-page.js', 'js/search.js']) {
        assert.doesNotMatch(stripComments(read(f)), /30-day satisfaction guarantee/, `${f} must not type the guarantee`);
    }
});

test('§27a ONE line under the COMPATIBLE head; visibility has one owner and skips receipt rolls', () => {
    const head = SHOP_HTML.indexOf('id="compatible-title"');
    const line = SHOP_HTML.indexOf('id="compatible-guarantee"');
    const grid = SHOP_HTML.indexOf('id="compatible-products"');
    assert.ok(head < line && line < grid, 'between the COMPATIBLE head and the first card');
    assert.equal((SHOP_HTML.match(/compatible-guarantee/g) || []).length, 1, 'not on the Genuine section');
    const sync = methodSrc(SHOP, '_syncSourceColumns').body;
    assert.match(sync, /guarantee\.hidden = !guarantee\.textContent \|\| this\._isReceiptListing\(\);/);
    const render = methodSrc(SHOP, 'renderCompatGuarantee').body;
    assert.match(render, /el\.textContent = label;/, 'text, never HTML');
    assert.match(render, /el\.dataset\.guarantee = label \? 'ok' : 'absent';/, 'absence is recorded, loud');
    assert.doesNotMatch(render, /\.hidden\s*=/, 'the writer of the text does not also own visibility');
});

test('§27a the search dropdown shows it in the COMPATIBLE column only, escaped', () => {
    const src = stripComments(read('js/search.js'));
    assert.match(src, /\(source === 'compatible' && guarantee \? `<p class="smart-ac__guarantee">\$\{esc\(guarantee\)\}<\/p>` : ''\)/);
    assert.match(src, /const guarantee = \(typeof CompatGuarantee !== 'undefined'\) \? CompatGuarantee\.now\(\) : '';/);
    assert.match(src, /CompatGuarantee\.load\(\)\.catch\(\(\) => \{\}\)/, 'warmed before the first results paint');
});

// ═══ §25 Filter & Sort ══════════════════════════════════════════════════════

test('§25 Filter & Sort is inline in the header row, as an outline button — never a row or overlay of its own', () => {
    // In .drilldown-header__left: it shares the trail's row on a phone (a row of
    // its own pushed the first Add under the consent bar at 390x664).
    const left = SHOP_HTML.indexOf('class="drilldown-header__left"');
    const bar = SHOP_HTML.indexOf('id="filter-sort-bar"');
    const right = SHOP_HTML.indexOf('class="drilldown-header__right-group"');
    assert.ok(left < bar && bar < right, 'inside .drilldown-header__left, above every level');
    assert.equal((SHOP_HTML.match(/id="filter-sort-bar"/g) || []).length, 1);
    assert.match(SHOP_HTML, /class="filter-sort-bar__btn btn btn--outline" id="filter-sort-open"/, 'not the Add-button blue');
    assert.match(SHOP_HTML, /<span class="filter-sort-bar__label">Filter &amp; Sort<\/span>/, 'the name stays in the button (visually hidden on a phone)');
    const pages = stripComments(read('css/pages.css'));
    const rule = pages.match(/\n\.filter-sort-bar \{[^}]*\}/)[0];
    assert.doesNotMatch(rule, /position:\s*(fixed|sticky)/, 'never an overlay that can cover an Add');
    assert.match(pages.match(/\n\.filter-sort-bar__btn \{[^}]*\}/)[0], /min-height: 44px;/, 'tap target');
    assert.match(pages, /\.filter-sort-bar__label \{\s*position: absolute; width: 1px; height: 1px;/, 'visually hidden, not display:none (keeps the accessible name)');
    assert.doesNotMatch(stripComments(read('css/components.css')), /has-consent-banner \.filter-sort-bar/, 'no lift for a bar that is not fixed');
});

// ═══ §24 consent bar ════════════════════════════════════════════════════════

test('§24 one-row bar at EVERY width: short copy, no heading, no corner card', () => {
    const css = stripComments(read('css/components.css'));
    // The compact rules are top-level now, not inside (max-width: 768px).
    const at = css.indexOf('.consent-banner__heading,\n.consent-banner__body-long {\n    display: none;\n}');
    assert.ok(at > 0, 'heading + long body hidden unconditionally');
    const before = css.slice(0, at);
    assert.ok(before.lastIndexOf('@media') < before.lastIndexOf('}'), 'not inside a media query');
    assert.match(css, /\n\.consent-banner__body-short \{ display: inline; \}/);
    assert.doesNotMatch(css, /\.consent-banner__body-short \{ display: none; \}/);
    assert.doesNotMatch(css, /@media \(min-width: 1100px\) \{\s*(body\.page-shop )?\.consent-banner \{/);
});

test('§24 Decline and Accept carry EQUAL weight', () => {
    const css = stripComments(read('css/components.css'));
    const equal = css.match(/\n\.consent-banner__btn--accept,\n\.consent-banner__btn--decline \{([^}]*)\}/);
    assert.ok(equal, 'one shared rule for both buttons');
    const later = css.slice(css.indexOf(equal[0]) + equal[0].length);
    assert.doesNotMatch(later, /\.consent-banner__btn--(accept|decline) \{/, 'nothing after it re-styles one of them');
});

// ═══ §32 first screen ═══════════════════════════════════════════════════════

test('§32 fix 1: no entrance animation on body, main, levels or brand tiles', () => {
    const fx = stripComments(read('css/modern-effects.css'));
    assert.doesNotMatch(fx, /\nbody \{[^}]*animation/, 'body must not fade in');
    assert.doesNotMatch(fx, /\nmain \{[^}]*animation/, 'main must not slide in');
    const pages = stripComments(read('css/pages.css'));
    assert.doesNotMatch(pages, /\.drilldown-level \{[^}]*animation/);
    assert.doesNotMatch(pages, /brandTileIn/);
    assert.doesNotMatch(SHOP, /animationDelay/);
    const js = stripComments(read('js/modern-effects.js'));
    assert.match(js, /if \(rect\.top < window\.innerHeight && rect\.bottom > 0\) return;\s*el\.classList\.add\('will-animate'\);/,
        'an element already on screen never gets the opacity-0 class');
});

test('§32 fix 2: the paid landings paint their final h1 (spans equal landingH1)', () => {
    const h1 = (p) => method('landingH1', {}, { window: { location: { pathname: p } } })();
    const span = (cls) => {
        const m = SHOP_HTML.match(new RegExp(`<span class="drilldown-title__landing drilldown-title__landing--${cls}">([^<]+)</span>`));
        assert.ok(m, `${cls} span`);
        return m[1].replace(/&amp;/g, '&');
    };
    assert.equal(span('ink'), h1('/ink-cartridges'));
    assert.equal(span('toner'), h1('/toner-cartridges'));
    const gtag = read('js/gtag.js');
    assert.ok(gtag.indexOf("setAttribute('data-landing', 'ink')") < gtag.indexOf("gtag('config'"), 'marked before anything else runs');
    const css = stripComments(read('css/pages.css'));
    assert.match(css, /html\[data-landing="ink"\] \.drilldown-title__landing--ink/);
    // gtag.js is render-blocking on shop.html (no defer/async) — the premise.
    assert.match(SHOP_HTML, /<script src="\/js\/gtag\.js\?v=[0-9a-f]{8}"><\/script>/);
});

test('§37/§32 the first-paint finder hint in gtag.js agrees with _printerFinderBrand', () => {
    const gtag = read('js/gtag.js');
    const block = gtag.slice(gtag.indexOf('try {\n    var _landingPath'), gtag.indexOf('} catch (_) { /* never block analytics */ }') + 1) + ' catch (_) {}';
    const hint = (pathname, search) => {
        const attrs = {};
        new Function('location', 'document', 'URLSearchParams', block)(
            { pathname, search }, { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } }, URLSearchParams);
        return !!(attrs['data-finder'] || attrs['data-landing']);
    };
    const CATS = propLiteral('PRINTER_FINDER_CATEGORIES');
    const finder = (state, pathname) => {
        const self = { state, PRINTER_FINDER_CATEGORIES: CATS };
        self._isPaidLanding = method('_isPaidLanding', self, { window: { location: { pathname } } });
        return method('_printerFinderBrand', self)() !== null;
    };
    // [pathname, search, the state parseURLState produces for it]
    const table = [
        ['/ink-cartridges', '', { level: 'brands', category: 'ink' }],
        ['/toner-cartridges', '', { level: 'brands', category: 'toner' }],
        ['/shop', '', { level: 'brands' }],
        ['/shop', '?brand=canon', { level: 'categories', brand: 'canon' }],
        ['/shop', '?brand=canon&category=ink', { level: 'codes', brand: 'canon', category: 'ink' }],
        ['/shop', '?brand=brother&category=drums', { level: 'codes', brand: 'brother', category: 'consumable' }],
        ['/shop', '?brand=brother&category=ribbon', { level: 'codes', brand: 'brother', category: 'ribbons' }],
        ['/shop', '?brand=brother&category=ink&code=LC233', { level: 'products', brand: 'brother', category: 'ink' }],
        ['/shop', '?brand=brother&printer_slug=brother-mfc-j4620dw', { level: 'printer-products', brand: 'brother' }],
        ['/shop', '?q=TS5360', { level: 'search-results' }],
    ];
    for (const [p, q, state] of table) {
        assert.equal(hint(p, q), finder(state, p), `${p}${q}`);
    }
});
