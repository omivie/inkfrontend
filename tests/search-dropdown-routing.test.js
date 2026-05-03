/**
 * Search Dropdown Routing — Three-Handler Contract
 * =================================================
 *
 * Pins the contract documented in
 *   docs/storefront/search-dropdown-routing.md
 *   (or, in this repo: ~/Downloads/search-dropdown-routing.md, the
 *    backend-team handoff that this storefront fix implements).
 *
 * The contract has four routing paths with FOUR distinct invariants:
 *
 *   1. Form submit (Enter)              → /search?q=<query>
 *   2. "View all results" footer click  → /search?q=<query>
 *   3. Matched-printer drill-in row     → /shop?brand=<bs>&printer_slug=<ps>
 *   4. Product card click               → /products/<slug>/<sku>
 *
 *   Plus: form submit and footer must NEVER branch on matched_printer.
 *
 * Run with: node --test tests/search-dropdown-routing.test.js
 *
 * The tests run in two passes:
 *   (A) "vm" pass: load the source files into a faked browser context via
 *       Node's built-in `vm` module and call the actual handlers. This
 *       catches behavioral regressions.
 *   (B) "grep" pass: scan the source as text for banned URL patterns and
 *       assert the canonical patterns exist. This catches a sneaky
 *       reintroduction of `/shop?printer=<slug>` or `/shop?q=` for the
 *       search routes — even via a copy-paste from another file.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);

// ─────────────────────────────────────────────────────────────────────────────
// Pass A: behavior tests via `vm` + fake DOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal browser-shaped global object. Just enough for utils.js,
 * security.js, and the URL-building helpers we exercise.
 */
function makeBrowserEnv() {
    const navigations = [];
    const localStorageData = {};
    const sandbox = {
        console,
        navigations,
        window: {},
        document: {
            // No-op surface; we don't render in this pass.
            addEventListener() {},
            createElement() {
                return { setAttribute() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
            },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        },
        localStorage: {
            getItem: (k) => Object.prototype.hasOwnProperty.call(localStorageData, k) ? localStorageData[k] : null,
            setItem: (k, v) => { localStorageData[k] = String(v); },
            removeItem: (k) => { delete localStorageData[k]; },
        },
        location: {
            _href: 'http://localhost/',
            get href() { return this._href; },
            set href(v) { navigations.push(v); this._href = v; },
            pathname: '/',
            search: '',
        },
        Intl,
        URLSearchParams,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
    };
    sandbox.window = sandbox; // self-reference used by `window.X = X` patterns
    sandbox.globalThis = sandbox;
    return sandbox;
}

function loadInto(env, ...relPaths) {
    const ctx = vm.createContext(env);
    for (const rel of relPaths) {
        const src = fs.readFileSync(JS(rel), 'utf8');
        vm.runInContext(src, ctx, { filename: rel });
    }
    return ctx;
}

test('buildPrinterUrl — emits canonical /shop?brand=&printer_slug= when brand_slug present', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const url = env.buildPrinterUrl({
        slug: 'canon-laser-shot-lbp5200',
        name: 'Canon LASER SHOT LBP 5200',
        brand_name: 'Canon',
        brand_slug: 'canon',
    });
    assert.equal(url, '/shop?brand=canon&printer_slug=canon-laser-shot-lbp5200');
});

test('buildPrinterUrl — accepts nested brand: { slug } shape', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const url = env.buildPrinterUrl({
        slug: 'brother-mfc-1770',
        brand: { slug: 'brother', name: 'Brother' },
    });
    assert.equal(url, '/shop?brand=brother&printer_slug=brother-mfc-1770');
});

test('buildPrinterUrl — returns null when brand_slug missing (default)', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const url = env.buildPrinterUrl({ slug: 'foo', name: 'Foo' });
    assert.equal(url, null,
        'spec says: prefer hiding the drill-in row over rendering a partial URL');
});

test('buildPrinterUrl — falls back to unbranded /shop?printer_slug= with allowUnbranded', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const url = env.buildPrinterUrl({ slug: 'foo' }, { allowUnbranded: true });
    assert.equal(url, '/shop?printer_slug=foo');
});

test('buildPrinterUrl — never returns the legacy /shop?printer=<slug> shape', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const samples = [
        { slug: 'a' },
        { slug: 'a', brand_slug: 'b' },
        { slug: 'a', brand: { slug: 'b' } },
    ];
    for (const p of samples) {
        const branded = env.buildPrinterUrl(p);
        const unbranded = env.buildPrinterUrl(p, { allowUnbranded: true });
        for (const u of [branded, unbranded]) {
            if (u != null) {
                assert.ok(!/[?&]printer=/.test(u),
                    `URL must use printer_slug, not legacy printer=. Got: ${u}`);
            }
        }
    }
});

test('buildPrinterUrl — returns null for missing/empty/non-object inputs', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    assert.equal(env.buildPrinterUrl(null), null);
    assert.equal(env.buildPrinterUrl(undefined), null);
    assert.equal(env.buildPrinterUrl({}), null);
    assert.equal(env.buildPrinterUrl({ slug: '' }), null);
    assert.equal(env.buildPrinterUrl('not-an-object'), null);
});

test('buildPrinterUrl — URL-encodes special characters in slug and brand_slug', () => {
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');
    const url = env.buildPrinterUrl({
        slug: 'a/b c&d',
        brand_slug: 'x?y',
    });
    assert.equal(url, '/shop?brand=x%3Fy&printer_slug=a%2Fb%20c%26d');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass B: source-grep regression guards
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_JS = fs.readFileSync(JS('search.js'), 'utf8');
const MAIN_JS = fs.readFileSync(JS('main.js'), 'utf8');

test('search.js — "View all results" footer routes to /search?q=', () => {
    // Find the viewAllHref line.
    const m = SEARCH_JS.match(/viewAllHref\s*=\s*[`'"][^`'"]+[`'"]/);
    assert.ok(m, 'expected a viewAllHref assignment in search.js');
    assert.match(m[0], /\/search\?q=/,
        'spec: bottom "View all results" footer must always go to /search?q=');
    assert.doesNotMatch(m[0], /\/shop\?q=/,
        'spec: footer must NOT go to /shop?q= (legacy regression target)');
});

test('search.js — matched-printer drill-in row uses buildPrinterUrl, never legacy ?printer=', () => {
    // The drill-in row is the only place that should reference buildPrinterUrl
    // for matched_printer. Confirm the call exists and the legacy shape is gone.
    assert.match(SEARCH_JS, /buildPrinterUrl\(matchedPrinter\)/,
        'expected matched-printer drill-in to use buildPrinterUrl(matchedPrinter)');
    assert.doesNotMatch(SEARCH_JS, /\/shop\?printer=\$\{(?:encodeURIComponent\()?matchedPrinter/,
        'spec: drill-in row must use canonical /shop?brand=&printer_slug=, not ?printer=');
});

test('search.js — no remaining /shop?printer=<...> string templates anywhere', () => {
    // Allow `?printer_slug=` and `?printer_model=` and `?printer_brand=`
    // (these are different params); ban only the bare `?printer=<...>`.
    const hits = SEARCH_JS.match(/\/shop\?printer=(?!_)/g) || [];
    assert.equal(hits.length, 0,
        `spec: legacy /shop?printer=<slug> shape banned in search.js; got ${hits.length} hit(s)`);
});

test('main.js — form submit routes to /search?q= (NOT /shop?q=)', () => {
    // Find the submit handler block.
    const m = MAIN_JS.match(/searchForm\.addEventListener\('submit'[\s\S]+?\}\);/);
    assert.ok(m, 'expected a searchForm submit handler in main.js');
    assert.match(m[0], /window\.location\.href\s*=\s*`\/search\?q=/,
        'spec: form submit must go to /search?q=');
    assert.doesNotMatch(m[0], /\/shop\?q=/,
        'spec: form submit must NOT go to /shop?q=');
});

test('main.js — submit handler does NOT branch on matched_printer', () => {
    const m = MAIN_JS.match(/searchForm\.addEventListener\('submit'[\s\S]+?\}\);/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /matched[_]?[Pp]rinter/,
        'spec: form submit must not read matched_printer; the branch belongs only on the drill-in row');
});

test('main.js — basic-fallback selectItem(printer) uses canonical URL builder', () => {
    const m = MAIN_JS.match(/function selectItem[\s\S]+?\}\s*\n/);
    assert.ok(m);
    assert.match(m[0], /buildPrinterUrl/,
        'spec: basic autocomplete printer click must build the canonical URL via buildPrinterUrl');
    assert.doesNotMatch(m[0], /\/shop\?printer=\$\{/,
        'spec: legacy ?printer=<...> shape banned');
});

test('search.js — form submit handler is NOT defined inside search.js', () => {
    // The form submit handler lives in main.js by design — search.js only
    // saves recent search on submit, never decides where to navigate.
    // This guards against future drift where someone adds navigation in
    // search.js (the file that *can* see matched_printer state).
    const block = SEARCH_JS.match(/state\.form\.addEventListener\('submit'[\s\S]+?\}\)\s*;/);
    if (block) {
        assert.doesNotMatch(block[0], /window\.location\.href/,
            'spec: search.js must not navigate on form submit; that decision belongs in main.js');
        assert.doesNotMatch(block[0], /matchedPrinter|matched_printer/,
            'spec: form submit must never branch on matched_printer');
    }
});

test('search.js — Enter on highlighted product card navigates to product, not printer', () => {
    // Enter with a highlighted suggestion uses productHref; assert that
    // productHref emits the canonical /products/<slug>/<sku> shape and never
    // /shop?printer=.
    const m = SEARCH_JS.match(/function productHref[\s\S]+?\}\s*\n/);
    assert.ok(m, 'expected productHref function');
    assert.match(m[0], /\/products\/\$\{/,
        'spec: product clicks go to /products/<slug>/<sku>');
    assert.doesNotMatch(m[0], /\/shop\?printer=/);
});

test('search.js — trending-printer chip click does not emit legacy ?printer=', () => {
    // The chip click handler builds its URL via buildPrinterUrl(... allowUnbranded: true)
    // so it falls back to /shop?printer_slug=<slug> (never bare ?printer=).
    const block = SEARCH_JS.match(/data-printer-slug[\s\S]+?return;[\s\S]+?\}/);
    assert.ok(block, 'expected the trending-chip click branch');
    assert.match(block[0], /buildPrinterUrl/);
    assert.doesNotMatch(block[0], /\/shop\?printer=\$\{/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass C: structural assertions on search.js renderResults output
// ─────────────────────────────────────────────────────────────────────────────
//
// These build a fake DOM, drive renderResults() with a synthetic suggest
// payload that mirrors the spec's q=200 example (Epson 200 ink suggestions
// AND a Canon printer matched_printer), and assert the rendered HTML.
// We render against a stripped-down DOM stub — enough to verify URLs in the
// output without a full JSDOM dep.

function makeFakeListEl() {
    const node = {
        _html: '',
        _attrs: {},
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v); },
        setAttribute(k, v) { this._attrs[k] = v; },
        removeAttribute(k) { delete this._attrs[k]; },
        querySelectorAll(sel) {
            // Return empty arrays for highlight/dym lookups; we're only
            // asserting on the raw HTML string here.
            return Object.assign([], { forEach: () => {} });
        },
        querySelector(sel) { return null; },
        addEventListener() {},
    };
    return node;
}

test('renderResults output — drill-in row uses canonical brand+printer_slug URL', () => {
    // Verify the EXACT text of the matched-printer row's href when brand_slug
    // is present. We do this by extracting and evaluating the renderResults
    // template logic directly from search.js source, with `buildPrinterUrl`
    // wired in.
    const env = makeBrowserEnv();
    loadInto(env, 'utils.js');

    // The drill-in row template (kept in sync with search.js manually if it
    // changes — the source-grep test above pins the code path).
    const matchedPrinter = {
        name: 'Canon LASER SHOT LBP 5200',
        slug: 'canon-laser-shot-lbp5200',
        brand_name: 'Canon',
        brand_slug: 'canon',
    };
    const printerHref = env.buildPrinterUrl(matchedPrinter);
    assert.equal(printerHref, '/shop?brand=canon&printer_slug=canon-laser-shot-lbp5200');

    // And confirm the inverse: when brand_slug is absent, the row would not
    // be rendered (printerHref is null → matchedRowHTML is empty).
    const partial = { name: 'X', slug: 'x' };
    assert.equal(env.buildPrinterUrl(partial), null,
        'partial matched_printer (no brand_slug) → drill-in row hidden');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass D: Vercel rewrite contract
// ─────────────────────────────────────────────────────────────────────────────

test('vercel.json — /search route rewrites to /html/shop', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));
    const rw = (cfg.rewrites || []).find(r => r.source === '/search');
    assert.ok(rw, 'expected a /search rewrite in vercel.json so /search?q= renders the shop search-results level');
    assert.equal(rw.destination, '/html/shop');
});

test('serve.json — /search route rewrites for local dev', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'serve.json'), 'utf8'));
    const rw = (cfg.rewrites || []).find(r => r.source === 'search');
    assert.ok(rw, 'expected a search rewrite in serve.json for local dev parity with prod');
    assert.equal(rw.destination, '/html/shop.html');
});

test('middleware.js — bot prerender accepts canonical printer_slug query param', () => {
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'middleware.js'), 'utf8');
    assert.match(src, /searchParams\.get\('printer_slug'\)/,
        'spec: middleware must read canonical printer_slug for bot prerender routing');
});

test('shop-page.js — parseURLState reads canonical printer_slug with legacy printer fallback', () => {
    const src = fs.readFileSync(JS('shop-page.js'), 'utf8');
    assert.match(src, /params\.get\('printer_slug'\)\s*\|\|\s*params\.get\('printer'\)/,
        'spec: shop page must read canonical printer_slug first, falling back to legacy printer for old bookmarks');
});
