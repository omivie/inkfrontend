/**
 * The backend's answer to our four 2026-09-28 replies
 * (backend-docs/inbox/fe-four-replies-backend-response-sep2026.md) — ERR-294.
 *
 * §A  the direct Supabase reads the backend made redundant are GONE
 *     (BF-084 ribbon fields, BF-085 ribbon codes, BF-086 chip_category)
 * §B  the printer page's "Colour Pack Bundles" is deleted, request and all
 * §C  for-use-in is keyed on the RESPONSE's SKU and never retries a 404
 * §D  /ink-cartridges + /toner-cartridges show per-category brand counts, and
 *     hide a 0/absent brand directly (BF-091 made counts = ?category=; ERR-299
 *     retired the confirming read)
 * §E  the printer hub's visible <h1> mirrors the prerender's
 * §F  a regional alias ("canon pg540" → PG-640) renders its note + rows
 * §G  search URLs are noindexed (header AND meta); old-site slugs keep the part number
 * §H  PDP detail lines: printer names as the backend prints them (re-measured,
 *     119 words), no doubled brand, no supplier "Model:" on compatibles
 * §I  section headings say the source word once; /ribbons says its title once
 * §J  admin: a failed import run shows WHY; image-audit brand = slug or id
 *
 * Every section that can EXECUTES the shipped code (vm / require / import) —
 * a grep proves a spelling, not a branch (ERR-253, ERR-258). The grep-only
 * checks are the ones where absence IS the claim (a deleted read, a deleted block).
 * Red-proof: python3 scripts/redproof-four-replies-sep2026.py
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const REPO = path.join(__dirname, '..');
const ROOT = path.join(REPO, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const U = require('../inkcartridges/js/utils.js');
const plain = (v) => JSON.parse(JSON.stringify(v));

const API_SRC = read('js/api.js');
const SHOP_SRC = read('js/shop-page.js');
const PDP_SRC = read('js/product-detail-page.js');
const SEO_SRC = read('js/seo-meta.js');
const UTILS_SRC = read('js/utils.js');

/** Brace-matched method body `name(params) { … }` out of an object literal. */
function extractMethod(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
            return `${/async\s/.test(m[0]) ? 'async ' : ''}${name}(${m[1]}) ${src.slice(open, i + 1)}`;
        }
    }
    throw new Error(`unbalanced ${name}`);
}

/** Every storefront script (not the admin, which writes product_codes on purpose). */
function storefrontScripts() {
    const dir = path.join(ROOT, 'js');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
}

// ─────────────────────────────────────────────────────────────────────────────
// §A  Direct Supabase reads retired (BF-084/085/086)
// ─────────────────────────────────────────────────────────────────────────────

test('§A no storefront script reads product_codes or product_code_visitors', () => {
    for (const [f, src] of storefrontScripts()) {
        const code = stripComments(src);
        assert.doesNotMatch(code, /product_codes\?|product_code_visitors/, `${f} still reads a table the backend now serves`);
    }
});

test('§A a ribbon PDP awaits no product_codes read; the enrich is a LOUD fallback for every row', () => {
    const init = stripComments(PDP_SRC);
    const win = init.slice(init.indexOf('this.product = response.data;'), init.indexOf('this.renderProduct();', init.indexOf('this.product = response.data;')));
    assert.doesNotMatch(win, /getManualProductCodes|isRibbonRow/);
    assert.match(win, /if \(needsEnrich\) \{\s*if \(typeof DebugLog !== 'undefined' && DebugLog\.warn\) \{\s*DebugLog\.warn\('\[PDP\] product row lacks/);
});

function loadApi(fetchImpl) {
    const ctx = {
        window: {}, console, URLSearchParams, URL, TextEncoder, AbortController, setTimeout, clearTimeout,
        fetch: fetchImpl || (async () => ({ ok: false, json: async () => null })),
        Config: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', API_URL: 'https://api.test', getSetting: (k, d) => d },
        DebugLog: { warn() {}, error() {}, log() {}, info() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        Security: { escapeHtml: (s) => s, escapeAttr: (s) => s },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
    return ctx.window.API;
}

test('§A _finalizeShopData makes NO Supabase read and leaves the server series alone (ERR-299 removed the last one)', async () => {
    // ERR-294 kept ONE read here (product_code_chip_counts, for the 950XL tile);
    // the backend folds 950XL into 950 (BF-088) so ERR-299 deleted it.
    let fetched = 0;
    const API = loadApi(async () => { fetched++; throw new Error('no fetch'); });
    API.getWithSWR = async () => { throw new Error('no pool may be fetched'); };
    const chips = { ok: true, data: { products: [], series: [{ code: '950', count: 2 }, { code: 'TN155', count: 7 }] } };
    const ribbons = { ok: true, data: { products: [{ id: 'r', product_type: 'printer_ribbon', series_codes: [] }] } };
    await API._finalizeShopData(chips, { brand: 'hp', category: 'ink' });
    await API._finalizeShopData(ribbons, {});
    assert.equal(fetched, 0);
    assert.deepEqual(plain(chips.data.series), [{ code: '950', count: 2 }, { code: 'TN155', count: 7 }]);
    assert.deepEqual(plain(ribbons.data.products[0].series_codes), [], 'a ribbon keeps the backend\'s [] — never re-derived');
    for (const gone of ['_applyManualCodes', '_fetchManualChipCounts', '_supabaseSelect', '_manualCodeCache']) {
        assert.equal(API[gone], undefined, `${gone} is gone`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §B  "Colour Pack Bundles" deleted (both color-packs routes 404)
// ─────────────────────────────────────────────────────────────────────────────

test('§B no storefront script, page or stylesheet carries the colour-pack block', () => {
    for (const [f, src] of storefrontScripts()) {
        assert.doesNotMatch(stripComments(src), /color-packs|loadColorPacks|getColorPack/, f);
    }
    assert.doesNotMatch(read('html/shop.html'), /color-packs-section|Colour Pack Bundles/);
    assert.doesNotMatch(read('css/pages.css'), /\.color-pack/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §C  for-use-in: the response's SKU, and no retry on a 404
// ─────────────────────────────────────────────────────────────────────────────

function forUseIn(api) {
    const obj = vm.runInNewContext(`({ ${extractMethod(PDP_SRC, '_fetchForUseIn')} })`, {
        API: api, DebugLog: { warn() {} }, document: { documentElement: { setAttribute() {} } }, Object,
    });
    return obj;
}

test('§C a 404 is asked ONCE; a 429 / 5xx / throw is asked twice', async () => {
    for (const [label, resp, expected] of [
        ['404', { ok: false, code: 'NOT_FOUND' }, 1],
        ['429', { ok: false, code: 'RATE_LIMITED' }, 2],
        ['5xx', { ok: false, code: 'INTERNAL_ERROR' }, 2],
        ['throw', null, 2],
    ]) {
        let calls = 0;
        const obj = forUseIn({ getForUseIn: async () => { calls++; if (!resp) throw new Error('net'); return resp; } });
        const out = await obj._fetchForUseIn('C65XLBK');
        assert.equal(calls, expected, label);
        assert.equal(out.state, 'unavailable', label);
    }
    let calls = 0;
    const ok = await forUseIn({ getForUseIn: async () => { calls++; return { ok: true, data: { for_use_in_html: '<p>x</p>' } }; } })._fetchForUseIn('X');
    assert.equal(ok.state, 'ok');
    assert.equal(calls, 1);
});

test('§C the PDP asks for-use-in with the product response\'s SKU, not the URL\'s', () => {
    assert.match(stripComments(PDP_SRC), /this\._forUseInPromise = this\._fetchForUseIn\(this\.product\.sku \|\| sku\);/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §D  Per-category brand counts on the landings
// ─────────────────────────────────────────────────────────────────────────────

function brandCounts({ category, counts, totals }) {
    const body = extractMethod(SHOP_SRC, '_loadBrandCounts');
    const tiles = {};
    const boxes = {};
    const grid = { querySelector(sel) {
        let m = sel.match(/data-count="([^"]+)"/);
        if (m) return (tiles[m[1]] = tiles[m[1]] || { textContent: '' });
        m = sel.match(/data-brand="([^"]+)"/);
        return (boxes[m[1]] = boxes[m[1]] || { hidden: false });
    } };
    const warned = [];
    const confirmCalls = [];
    const api = {
        getProductCounts: async () => ({ ok: true, data: counts }),
        // Retired by ERR-299; a call would be recorded and fail the tests below.
        getCategoryTotal: async (b, c) => { confirmCalls.push(`${b}/${c}`); return totals[b]; },
    };
    const obj = vm.runInNewContext(`({ ${body} })`, { API: api, CSS: { escape: (s) => s }, Number, Object, Set, Promise, DebugLog: { warn: (m) => warned.push(m) } });
    obj.elements = { brandsGrid: grid };
    obj.state = { category };
    obj.navigationVersion = 1;
    obj.categories = [
        { id: 'ink', apiCategory: 'ink' }, { id: 'toner', apiCategory: 'toner' },
        { id: 'consumable', apiCategory: 'drums' }, { id: 'ribbons', apiCategory: 'ribbons' },
    ];
    return { run: (slugs) => obj._loadBrandCounts(slugs.map((slug) => ({ slug }))), tiles, boxes, warned, confirmCalls };
}

// Shape measured 2026-09-29 (after BF-091): GET /api/products/counts?brands=hp,dymo,epson,…
const COUNTS = {
    hp: { ink: 400, toner: 430, drums: 33, paper: 7 },
    dymo: { label: 103 },
    epson: { ink: 317, drums: 5, paper: 23, ribbon: 32 },
    canon: { ink: 381, toner: 156, drums: 12, paper: 20, ribbon: 4 },
};

test('§D /toner-cartridges: HP shows 430 (not 870); a 0/absent brand is hidden with NO confirming read', async () => {
    const d = brandCounts({ category: 'toner', counts: COUNTS, totals: {} });
    await d.run(['hp', 'dymo', 'epson', 'canon']);
    assert.equal(d.tiles.hp.textContent, '430 products');
    assert.equal(d.tiles.canon.textContent, '156 products');
    assert.deepEqual(d.confirmCalls, [], 'BF-091: counts come from the same taxonomy as ?category= — absent means 0');
    assert.equal(d.boxes.dymo.hidden, true);
    assert.equal(d.boxes.epson.hidden, true);
    assert.equal(d.boxes.hp, undefined, 'a stocked brand is never touched');
});

test('§D drums: epson 5 is COUNTED now (was absent before BF-091) and shown', async () => {
    const d = brandCounts({ category: 'consumable', counts: COUNTS, totals: {} });
    await d.run(['epson', 'hp', 'dymo']);
    assert.equal(d.tiles.epson.textContent, '5 products');
    assert.equal(d.boxes.epson, undefined, 'not hidden');
    assert.equal(d.tiles.hp.textContent, '33 products');
    assert.equal(d.boxes.dymo.hidden, true);
});

test('§D a FAILED counts request keeps every tile (unmeasured, not empty)', async () => {
    const d = brandCounts({ category: 'toner', counts: null, totals: {} });
    await d.run(['dymo', 'epson']);
    assert.equal(d.boxes.dymo?.hidden ?? false, false);
    assert.equal(d.boxes.epson?.hidden ?? false, false);
});

test('§D a brand the counts endpoint does not know is left alone (blank, visible, unconfirmed)', async () => {
    const d = brandCounts({ category: 'ink', counts: COUNTS, totals: {} });
    await d.run(['zz', 'hp']);
    assert.equal(d.tiles.zz, undefined);
    assert.deepEqual(d.confirmCalls, [], 'an unknown brand is not a zero');
    assert.equal(d.tiles.hp.textContent, '400 products');
});

test('§D /shop (no category) keeps the cross-category sum and confirms nothing', async () => {
    const d = brandCounts({ category: undefined, counts: COUNTS, totals: {} });
    await d.run(['hp', 'dymo']);
    assert.equal(d.tiles.hp.textContent, '870 products');
    assert.equal(d.tiles.dymo.textContent, '103 products');
    assert.deepEqual(d.confirmCalls, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// §E  Printer hub <h1> = the prerender's <h1>
// ─────────────────────────────────────────────────────────────────────────────

function loadSeoMeta(title) {
    const store = {};
    const ctx = {
        console, URLSearchParams,
        sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
        document: { title: '', addEventListener() {}, querySelector: () => null, getElementById: (id) => (id === 'drilldown-title' ? title : null) },
        window: {},
        fetch: async () => ({ ok: true, text: async () => PRERENDER }),
        Config: { API_URL: 'https://api.test' },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(SEO_SRC, ctx, { filename: 'seo-meta.js' });
    return ctx.window.SeoMeta;
}

// The shape GET /api/prerender/printer/brother/brother-hl-l2375dw served on 2026-09-28.
const PRERENDER = `<!DOCTYPE html><html><head>
  <title>Brother HL-L2375DW Toner Cartridges | Fast NZ Delivery</title>
  <meta name="description" content="5 toner cartridges for the Brother HL-L2375DW &mdash; genuine &amp; compatible.">
</head><body><h1>Brother HL-L2375DW Toner NZ</h1><h1>second</h1></body></html>`;

test('§E extractHead returns the first <h1> as decoded text', () => {
    const S = loadSeoMeta(null);
    assert.equal(S.extractHead(PRERENDER).h1, 'Brother HL-L2375DW Toner NZ');
    assert.equal(S.extractHead('<h1 class="x">Ink <em>&amp;</em>\n Toner</h1>').h1, 'Ink & Toner', 'tags dropped, entities decoded, whitespace collapsed');
    assert.equal(S.extractHead('<h1>  </h1>').h1, null);
});

test('§E reconcile on the PRINTER surface writes the visible H1; any other surface leaves it', async () => {
    const title = { textContent: 'Shop Ink Cartridges & Toner NZ', hidden: true, classList: { removed: [], remove(c) { this.removed.push(c); } } };
    const S = loadSeoMeta(title);
    const path = '/api/prerender/printer/brother/brother-hl-l2375dw';
    assert.equal(await S.reconcile(path, undefined, 'brand'), true);
    assert.equal(title.textContent, 'Shop Ink Cartridges & Toner NZ', 'a brand page keeps its own H1');
    assert.equal(await S.reconcile(path, undefined, 'printer'), true);
    assert.equal(title.textContent, 'Brother HL-L2375DW Toner NZ');
    assert.equal(title.hidden, false);
    assert.deepEqual(title.classList.removed, ['visually-hidden']);
    assert.equal(S.h1For(path), 'Brother HL-L2375DW Toner NZ', 'shop-page reads the same answer');
    assert.equal(S.h1For('/api/prerender/printer/x/y'), null);
    assert.match(S.PRERENDER_CACHE_PREFIX, /_v2:$/, 'v1 heads carry no h1 — bumped');
});

test('§E updateTitle prints the mirrored H1 on a printer hub, the printer name until it lands', () => {
    // updateTitle also toggles the service row (FE master checklist item 5);
    // lift the real method beside it — with no document it returns at once.
    const body = extractMethod(SHOP_SRC, '_syncServiceRow') + ',\n' + extractMethod(SHOP_SRC, 'updateTitle');
    const run = (mirrored) => {
        const title = { textContent: '', hidden: true, classList: { add() {}, remove() { this.gone = true; } } };
        const obj = vm.runInNewContext(`({ ${body} })`, {
            SeoMeta: { h1For: () => mirrored, prerenderPathForLocation: () => '/p' },
            PrinterName: U.PrinterName, window: { location: {} },
        });
        obj.elements = { title, productTypeLabel: { hidden: false }, yieldBanner: { hidden: false } };
        obj.state = { level: 'printer-products', printerName: 'Brother HL L2375DW' };
        obj.updateTitle();
        return title;
    };
    assert.equal(run('Brother HL-L2375DW Toner NZ').textContent, 'Brother HL-L2375DW Toner NZ');
    const fallback = run(null);
    assert.equal(fallback.textContent, 'Brother HL-L2375DW', 'fallback is the display name (hyphen mirrored)');
    assert.equal(fallback.hidden, false);
    assert.equal(fallback.classList.gone, true, 'visible, not visually-hidden');
});

test('§E the printer name is display-cased where it is stored, so breadcrumb, H1 and headings agree', () => {
    const code = stripComments(SHOP_SRC);
    // The printer object's own display_name first (BF-093, ERR-299), else the mirror.
    assert.match(code, /this\.state\.printerName = \(typeof PrinterName !== 'undefined'\)\s*\? \(\(printerData && PrinterName\.of\(printerData\)\) \|\| PrinterName\.display\(rawPrinterName \|\| ''\) \|\| rawPrinterName\)/);
    assert.equal(U.PrinterName.display(U.PrinterName.display('Brother HL L2375DW')), 'Brother HL-L2375DW', 'display() is idempotent');
});

// ─────────────────────────────────────────────────────────────────────────────
// §F  Regional alias search
// ─────────────────────────────────────────────────────────────────────────────

function shopHelpers() {
    const doc = {
        addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console, URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp, Object, Array, String, Number, Boolean, Error, Math,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout, document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node' }, DebugLog: { log() {}, warn() {}, error() {} },
        Config: { API_URL: 'https://backend.test', settings: {}, getSetting(k, f) { return f; } },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, ctx, { filename: 'utils.js' });
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    return sandbox.window._searchParityHelpers;
}

// Measured 2026-09-28: GET /api/search/smart?q=canon%20pg540
const PG540 = {
    products: [], total: 0,
    alias_suggestion: { from: 'PG-540', to: ['PG-640'], note: 'PG-540 is the UK/EU code. NZ printers use PG-640. Check the code on your old cartridge before you order.', search_query: 'canon pg640' },
    alias_results: [{ sku: 'GPG640BK' }, { sku: 'GPG640VPVP' }, { sku: 'GPG640XLBK' }, { sku: 'CPG640XLBK' }, { sku: 'GPG640XXLBK' }],
};

test('§F searchAlias reads the measured shape, and only when /smart has no rows of its own', () => {
    const H = shopHelpers();
    const a = H.searchAlias(PG540, []);
    assert.equal(a.searchQuery, 'canon pg640');
    assert.deepEqual(plain(a.to), ['PG-640']);
    assert.equal(a.rows.length, 5);
    assert.match(a.note, /^PG-540 is the UK\/EU code/);
    assert.equal(H.searchAlias(PG540, [{ sku: 'X' }]), null, 'own rows win');
    assert.equal(H.searchAlias({ ...PG540, alias_results: [] }, []), null, 'no rows ⇒ the zero-results page, not an empty banner');
    assert.equal(H.searchAlias({ ...PG540, alias_suggestion: { note: '  ' } }, []), null);
    assert.equal(H.searchAlias(null, []), null);
    assert.equal(H.searchAlias({ ...PG540, alias_suggestion: { ...PG540.alias_suggestion, search_query: '' } }, []).searchQuery, 'PG-640');
});

test('§F loadSearchResults renders the alias rows, skips the literal swap, drops the pager', () => {
    const code = stripComments(SHOP_SRC);
    const fn = code.slice(code.indexOf('async loadSearchResults('), code.indexOf('renderSearchBanners(smartData, searchQuery) {'));
    assert.match(fn, /alias = searchAlias\(smartData, products\);\s*if \(alias\) products = alias\.rows;/);
    assert.ok(fn.indexOf('alias = searchAlias(') < fn.indexOf('smartSkus.add('), 'alias rows count as /smart-sourced for the click beacon');
    assert.match(fn, /if \(!alias && smartData && smartData\.pagination/);
    assert.match(fn, /&& !smartData\?\.did_you_mean\s*&& !alias;/, 'softMiss cannot swap an alias page for a literal "pg540" search');
});

test('§F the banner leads, escapes the backend\'s note, and links the alias search encoded', () => {
    const fn = extractMethod(stripComments(SHOP_SRC), 'renderSearchBanners');
    assert.ok(fn.indexOf('search-alias-banner') < fn.indexOf('printer-hero'), 'the note reads before anything else');
    assert.match(fn, /Security\.escapeHtml\(alias\.note\)/);
    assert.match(fn, /href="\/search\?q=\$\{encodeURIComponent\(alias\.searchQuery\)\}"/);
    assert.match(fn, /Security\.escapeHtml\(toLabel\)/);
    assert.match(read('css/search.css'), /\.search-alias-banner \{/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §G  Search noindex + old-site slug redirects
// ─────────────────────────────────────────────────────────────────────────────

const VERCEL = JSON.parse(read('vercel.json'));

test('§G /shop?search=, /shop?q= and /search carry X-Robots-Tag: noindex, follow', () => {
    const rule = (source, key) => VERCEL.headers.find((h) => h.source === source
        && (key ? (h.has || []).some((c) => c.type === 'query' && c.key === key) : !h.has));
    for (const [source, key] of [['/shop', 'search'], ['/shop', 'q'], ['/search', null]]) {
        const r = rule(source, key);
        assert.ok(r, `${source}${key ? `?${key}=` : ''} rule`);
        assert.deepEqual(plain(r.headers), [{ key: 'X-Robots-Tag', value: 'noindex, follow' }]);
    }
    const bare = VERCEL.headers.filter((h) => h.source === '/shop' && !h.has && (h.headers || []).some((x) => x.key === 'X-Robots-Tag'));
    assert.deepEqual(bare, [], 'bare /shop and brand/printer hubs stay indexable');
});

test('§G the SPA sets meta robots noindex on search results too (the other side of the mirror)', () => {
    assert.match(stripComments(SHOP_SRC), /if \(\(brand && category && code\) \|\| this\.state\.level === 'search-results'\) \{/);
});

/** Vercel's first matching redirect, for the regex-group sources this file uses. */
function redirectFor(p) {
    for (const r of VERCEL.redirects) {
        if (/:/.test(r.source)) continue;
        const m = new RegExp(`^${r.source}$`).exec(p);
        if (m) return r.destination.replace(/\$(\d)/g, (_, i) => m[Number(i)]);
    }
    return null;
}

test('§G old-site slugs keep the part number (the backend\'s two examples + a colourless one)', () => {
    assert.equal(redirectFor('/fuji-xerox-ct201304-toner-cartridge-cyan'), '/shop?search=fuji-xerox-ct201304+cyan');
    assert.equal(redirectFor('/brother-lc73-inkjet-cartridge-black-lc73bk'), '/shop?search=brother-lc73+black-lc73bk');
    assert.equal(redirectFor('/hp-564-ink-cartridges'), '/shop?search=hp-564');
    assert.equal(redirectFor('/brother-typewriter-model-listing-for-ribbons'), '/ribbons', 'ribbon catch-alls still win');
    for (const r of VERCEL.redirects.filter((x) => /-(ink|inkjet|toner)-cartridges?-\(/.test(x.source))) {
        assert.equal(r.destination, '/shop?search=$1+$2', r.source);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §H  PDP detail lines
// ─────────────────────────────────────────────────────────────────────────────

// raw full_name (GET /api/printers/by-brand/<b>) → display part of the backend
// prerender <h1> (GET /api/prerender/printer/<b>/<slug>), measured 2026-09-28.
const MEASURED_0928 = [
    ['Brother MFC L2740DW', 'Brother MFC-L2740DW'], ['Brother HL L2300D', 'Brother HL-L2300D'],
    ['Brother DCP J525W', 'Brother DCP-J525W'], ['Brother FAX 1010', 'Brother FAX-1010'],
    ['Brother PT 10', 'Brother PT-10'], ['Brother QL 100', 'Brother QL-100'],
    ['Brother HL 7300DX PLUS', 'Brother HL-7300DX Plus'], ['Brother HL 1210W PRINTER', 'Brother HL-1210W Printer'],
    ['Brother BF 70', 'Brother BF 70'], ['Brother DPC 1510', 'Brother DPC 1510'], ['Brother GL 100', 'Brother GL 100'],
    ['Brother TD 4000', 'Brother TD 4000'], ['Brother P-TOUCH PT 90', 'Brother P-TOUCH PT 90'],
    ['Brother PTOUCH TAPE', 'Brother PTOUCH TAPE'], ['Brother HLL-3210CDW', 'Brother HLL-3210CDW'],
    ['Brother VC 500W FULL COLOUR LABEL PRINTER', 'Brother VC 500W FULL Colour LABEL Printer'],
    ['HP DESKJET 930C', 'HP DeskJet 930C'], ['HP COLOR LASERJET M855XH', 'HP Color LaserJet M855XH'],
    ['HP ENVY PRO 6400', 'HP ENVY Pro 6400'], ['HP DESK 2621', 'HP Desk 2621'],
    ['HP BUSINESS INKJET 1000', 'HP Business Inkjet 1000'], ['HP COLOR COPIER 170', 'HP Color Copier 170'],
    ['HP DESIGNJET 111', 'HP DesignJet 111'], ['HP DESKJ 1112', 'HP Deskj 1112'],
    ['HP COLOR LASERJET ENTERPRISE FLOW MFP M776Z', 'HP Color LaserJet Enterprise Flow MFP M776Z'],
    ['HP ENVY INSPIRE', 'HP ENVY Inspire'], ['HP LASER JET ENTERPRISE M651', 'HP Laser Jet Enterprise M651'],
    ['HP OFFICEJET 200 MOBILE', 'HP OfficeJet 200 Mobile'], ['HP NEVERSTOP LASER 1001NW', 'HP Neverstop Laser 1001NW'],
    ['HP DESIGNJET Z3200 24-IN POSTSCRIPT PHOTO', 'HP DesignJet Z3200 24-IN PostScript Photo'],
    ['HP DESIGNJET Z3200 RANGE', 'HP DesignJet Z3200 Range'], ['HP DESKJET 3000 PRINETR J310A', 'HP DeskJet 3000 Prinetr J310A'],
    ['HP LASERJET PRO 400 TONER', 'HP LaserJet Pro 400 Toner'], ['HP OFFICEJET 250 MOBILE AIO PRINTER', 'HP OfficeJet 250 Mobile AIO Printer'],
    ['HP AMP 120', 'HP AMP 120'], ['HP COLOR LASERJET M880Z+NFC', 'HP Color LaserJet M880Z+NFC'],
    ['HP LaserJet Pro MFP M428fdw', 'HP LaserJet Pro MFP M428fdw'],
    ['Canon LASER SHOT LBP 2900', 'Canon LASER SHOT LBP 2900'], ['Canon IMAGECLASS MF 4890DN', 'Canon IMAGECLASS MF 4890DN'],
    ['Canon PIXMA HOME TS 5360', 'Canon PIXMA Home TS 5360'], ['Canon G660 PHOTO PRINTER', 'Canon G660 Photo Printer'],
    ['Canon imagePROGRAF PRO 1100', 'Canon imagePROGRAF Pro 1100'], ['Canon PIXMA G SERIES G2600', 'Canon PIXMA G Series G2600'],
    ['Canon PIXMA PRO 9000 MARK II', 'Canon PIXMA Pro 9000 MARK II'], ['Canon MAXIFY GX3060 MEGATANK', 'Canon MAXIFY GX3060 MEGATANK'],
    ['Canon FAXPHONE L75', 'Canon FAXPHONE L75'], ['Canon IMAGERUNNER ADVANCE 400', 'Canon IMAGERUNNER ADVANCE 400'],
    ['Epson ECOTANK ET 8500', 'Epson EcoTank ET 8500'], ['Epson STYLUS C110', 'Epson Stylus C110'],
    ['Epson WORKFORCE PRO 3720', 'Epson WorkForce Pro 3720'], ['Epson EXPRESSION HOME XP 240', 'Epson Expression Home XP 240'],
    ['Epson EXPRESSION PREMIUM XP 520', 'Epson Expression PREMIUM XP 520'], ['Epson STYLUS OFFICE T30', 'Epson Stylus OFFICE T30'],
    ['Epson WORK FORCE 3620', 'Epson WORK FORCE 3620'], ['Epson SURECOLOR SC P600', 'Epson SURECOLOR SC P600'],
    ['Fuji Xerox DOCUCENTRE C2000', 'Fuji Xerox DocuCentre C2000'], ['Fuji Xerox DOCUPRINT 202', 'Fuji Xerox DocuPrint 202'],
    ['Fuji Xerox PHASER 3200MFP', 'Fuji Xerox Phaser 3200MFP'], ['Fuji Xerox APEOSPORT IV C2270', 'Fuji Xerox APEOSPORT IV C2270'],
    ['Fuji Xerox 700 DIGITAL COLOR PRESS', 'Fuji Xerox 700 DIGITAL Color PRESS'], ['Fuji Xerox WORKCENTRE 220', 'Fuji Xerox WORKCENTRE 220'],
    ['FUJI 4310SD', 'Fuji 4310SD'], ['FUJI PRINT 3410SD', 'Fuji Print 3410SD'], ['FUJI FIB 4570', 'Fuji FIB 4570'],
    ['Kyocera TASKALFA 2020', 'Kyocera TASKalfa 2020'], ['Kyocera TASKALPHA 2552CI', 'Kyocera TASKALPHA 2552CI'],
    ['Kyocera ECOSYS M2035dn', 'Kyocera ECOSYS M2035dn'],
    ['Dymo LABELMANAGER WIRELESS PNP', 'Dymo LABELMANAGER Wireless PNP'], ['Dymo LABELWRITER 450 TWINTURBO', 'Dymo LABELWRITER 450 TWINTURBO'],
    ['Samsung CLP 620ND', 'Samsung CLP 620ND'], ['Samsung SCX-4623FW', 'Samsung SCX-4623FW'],
    ['Lexmark MS 823', 'Lexmark MS 823'], ['OKI MC 780', 'OKI MC 780'], ['Panasonic KX-P1595', 'Panasonic KX-P1595'],
];

test('§H PrinterName.display matches the backend prerender for every printer measured on 2026-09-28', () => {
    for (const [raw, backend] of MEASURED_0928) assert.equal(U.PrinterName.display(raw), backend, raw);
});

test('§H withoutBrand: one brand word, taken off only when it leads', () => {
    const P = U.PrinterName;
    assert.equal(P.withoutBrand('Brother HL L2300D', 'Brother'), 'HL-L2300D', 'hyphen found BEFORE the brand is cut');
    assert.equal(P.withoutBrand('HP COLOR LASERJET 5500', 'HP'), 'Color LaserJet 5500');
    assert.equal(P.withoutBrand('Fuji Xerox DOCUPRINT 202', 'Fuji Xerox'), 'DocuPrint 202');
    assert.equal(P.withoutBrand('Brotherhood 5', 'Brother'), 'Brotherhood 5', 'a word that merely starts with the brand stays');
    assert.equal(P.withoutBrand('Brother', 'Brother'), 'Brother');
    assert.equal(P.withoutBrand('Canon PIXMA MG3660', ''), 'Canon PIXMA MG3660');
});

test('§H the grouped "Fits <brand>" row lists models without the brand again', () => {
    const body = extractMethod(PDP_SRC, '_renderGroupedPrinterCompat');
    let html = '';
    const obj = vm.runInNewContext(`({ ${body} })`, {
        Array, Number, PrinterName: U.PrinterName, ProductName: U.ProductName,
        Security: { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) },
        document: { querySelector: () => ({ insertAdjacentHTML: (_, h) => { html = h; } }) },
    });
    obj._printerHubHref = (p) => `/shop?printer_slug=${p.slug}`;
    obj._printerLabel = (n) => U.PrinterName.display(n);
    // Measured 2026-09-28: CTN2345BK compatible_printers_grouped
    obj._renderGroupedPrinterCompat({ category: 'toner', compatible_printers_grouped: [{ brand: 'Brother', brand_slug: 'brother', total: 6,
        top_models: [{ full_name: 'Brother HL L2300D', slug: 'brother-hl-l2300d' }, { full_name: 'Brother MFC L2700DW', slug: 'brother-mfc-l2700dw' }] }] });
    assert.match(html, /Fits Brother<\/span>/);
    assert.match(html, />HL-L2300D<\/a>, <a[^>]*>MFC-L2700DW<\/a>/);
    assert.doesNotMatch(html, /Brother Brother|Brother HL/);
    assert.match(html, /\+4 more/);
});

test('§H "Model:" is printed for a genuine row only (a compatible\'s MPN is the supplier\'s code)', () => {
    const code = stripComments(PDP_SRC);
    const line = code.match(/const showModel = [^;]+;\s*document\.getElementById\('product-sku'\)\.textContent = [^;]+;/);
    assert.ok(line, 'the SKU line must exist');
    const f = new Function('info', 'document', `${line[0]}`);
    const run = (info) => { const el = {}; f(info, { getElementById: () => el }); return el.textContent; };
    assert.equal(run({ sku: 'CTN2345BK', source: 'compatible', manufacturer_part_number: 'IBTN2345' }), 'SKU: CTN2345BK');
    assert.equal(run({ sku: 'GTN2345', source: 'genuine', manufacturer_part_number: 'TN-2345' }), 'SKU: GTN2345 | Model: TN-2345');
    assert.equal(run({ sku: 'GX', source: 'genuine', manufacturer_part_number: null }), 'SKU: GX');
});

// ─────────────────────────────────────────────────────────────────────────────
// §I  Headings
// ─────────────────────────────────────────────────────────────────────────────

test('§I sectionTitleText: the badge carries the source word, the text never repeats it', () => {
    const H = shopHelpers();
    assert.equal(H.sectionTitleText(' Cartridges'), 'Cartridges', 'the backend\'s "Compatible Compatible Cartridges" case');
    assert.equal(H.sectionTitleText('Brother  Inkjet Cartridges'), 'Brother Inkjet Cartridges');
    assert.equal(H.sectionTitleText('Compatible Toner products'), 'Toner products');
    assert.equal(H.sectionTitleText('Original products for "x"'), 'products for "x"');
    assert.equal(H.sectionTitleText('cartridges for Brother HL-L2375DW'), 'cartridges for Brother HL-L2375DW');
});

test('§I every heading writer goes through sectionTitleText; search sets its titles AFTER displayProductInfo', () => {
    const code = stripComments(SHOP_SRC);
    const writes = code.match(/(compatible|genuine)TitleText\.textContent = [^;]+;/g) || [];
    assert.ok(writes.length >= 6);
    for (const w of writes) assert.match(w, /= (sectionTitleText\(|forPrinter;|searchTitle;)/, w);
    const fn = code.slice(code.indexOf('async loadSearchResults('), code.indexOf('renderSearchBanners(smartData, searchQuery) {'));
    assert.ok(fn.indexOf('await this.displayProductInfo(filteredProducts') < fn.indexOf('const searchTitle'),
        'displayProductInfo overwrote the search headings on every search until ERR-294');
    const html = read('html/shop.html');
    assert.match(html, /products-section__badge--compatible">Compatible<\/span>/, 'the badge still says it once');
});

test('§I /ribbons: the page title appears once, as the h1', () => {
    const html = read('html/ribbons.html').replace(/<!--[\s\S]*?-->/g, '');
    assert.equal((html.match(/Typewriter &amp; Printer Ribbons<\/h[12]>/g) || []).length, 1);
    assert.match(html, /<h1 class="drilldown-title" id="drilldown-title">Typewriter &amp; Printer Ribbons<\/h1>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §J  Admin
// ─────────────────────────────────────────────────────────────────────────────

let S;
test.before(async () => { S = await import(path.join(ROOT, 'js/admin/utils/importStatus.js')); });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Measured 2026-09-28: GET /api/admin/supplier/import-status, genuine feed.
const run = (started, status, error_message = null) => ({ status, started_at: started, finished_at: started, dry_run: false, products_upserted: 0, errors: 0, warnings: 0, feed_row_count: 0, error_message });
const NOW = Date.parse('2026-09-28T07:00:00Z');

test('§J a failed run shows the recorded reason; one without a reason says so', () => {
    const feed = { recent_runs: [
        run('2026-09-27T14:00:03Z', 'completed'),
        run('2026-09-26T14:00:03Z', 'failed', 'Detected abandoned run (process crash or forced termination)'),
        run('2026-09-23T14:00:06Z', 'failed', 'Parent process: import-all.js killed by timeout'),
        run('2026-09-22T14:00:00Z', 'failed', '   '),
    ] };
    const html = S.importFeedsHtml({ genuine: feed, compatible: null }, esc, NOW);
    assert.match(html, /cc2-infra__runreason">Detected abandoned run \(process crash or forced termination\)</);
    assert.match(html, /cc2-infra__runreason">Parent process: import-all\.js killed by timeout</);
    assert.match(html, /cc2-infra__runreason">No reason recorded\.</, 'a blank reason is no reason');
    assert.equal((html.match(/cc2-infra__runreason/g) || []).length, 3, 'completed runs carry no reason line');
});

test('§J the latest-failed reason names the cause; the reason text is escaped', () => {
    const f = S.summarizeFeed({ recent_runs: [run('2026-09-28T01:00:00Z', 'failed', 'genuine step exceeded 60 min')] }, NOW);
    assert.equal(f.reasons[0], 'The latest run failed: genuine step exceeded 60 min');
    const g = S.summarizeFeed({ recent_runs: [run('2026-09-28T01:00:00Z', 'failed')] }, NOW);
    assert.equal(g.reasons[0], 'The latest run failed, and it recorded no reason.');
    const html = S.importFeedsHtml({ genuine: { recent_runs: [run('2026-09-28T01:00:00Z', 'failed', '<img src=x onerror=alert(1)>')] } }, esc, NOW);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img src=x/);
    assert.equal(S.failureReason({ error_message: 42 }), null);
});

test('§J image-audit brand option is the slug, else the id — never a name (a name 400s UNKNOWN_BRAND)', () => {
    const src = stripComments(read('js/admin/pages/genuine-image-audit.js'));
    const loop = src.slice(src.indexOf('for (const b of _brands) {'), src.indexOf('brandOpts +=', src.indexOf('for (const b of _brands) {')));
    const pick = new Function('b', `${loop.slice(loop.indexOf('const val'), loop.indexOf('const sel'))}; return val;`.replace(/if \(!val\) continue;/, 'if (!val) return null;'));
    assert.equal(pick({ slug: 'hp', id: 'uuid', name: 'HP' }), 'hp');
    assert.equal(pick({ id: 'uuid', name: 'HP' }), 'uuid');
    assert.equal(pick({ name: 'HP' }), null, 'no slug, no id ⇒ not offered');
    assert.equal(pick('HP'), null, 'a bare name is not offered');
});
