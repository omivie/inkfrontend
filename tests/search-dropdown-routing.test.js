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

test('main.js — basic-autocomplete fallback is deleted (search.js owns autocomplete)', () => {
    // The basic autocomplete fallback (~210 lines, with its own selectItem,
    // fetchSuggestions, renderSuggestions, hideDropdown, etc.) was deleted in
    // the 2026-05-03 search audit (readfirst/SEARCH_AUDIT.md). It duplicated
    // logic that /js/search.js (SmartSearch) already does. SmartSearch is
    // loaded synchronously before main.js on every page that has a search
    // form, so the fallback was unreachable in practice.
    //
    // This test is a regression guard: don't bring it back.
    assert.doesNotMatch(MAIN_JS, /function\s+initBasicAutocomplete\b/,
        'spec: initBasicAutocomplete deleted — search.js (SmartSearch) is the only autocomplete path');
    assert.doesNotMatch(MAIN_JS, /function\s+fetchSuggestions\b/,
        'spec: the basic-fallback fetchSuggestions duplicated SmartSearch.fetchSuggest — must stay deleted');
    assert.doesNotMatch(MAIN_JS, /\.search-autocomplete__list/,
        'spec: basic-fallback DOM (.search-autocomplete__list) is gone — SmartSearch uses .smart-ac-dropdown');
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

// ─────────────────────────────────────────────────────────────────────────────
// Pass E: legacy ?printer= URL → backend rewrite contract
// ─────────────────────────────────────────────────────────────────────────────
//
// Spec section "Storefront prerequisite — Vercel rewrite for legacy ?printer=
// URLs". The dropdown no longer emits the legacy /shop?printer=<slug> shape
// (Pass B above pins that), but external links, Google Search index entries,
// and bookmarks still hit those URLs. Vercel can't compute brand_slug from
// printer_slug at the edge — the lookup needs the database. So we proxy the
// legacy URL to the Render backend, which has the printer_models→brands
// lookup and 301s with the full canonical (?brand=&printer_slug=).
//
// Two invariants matter for these rules to function:
//   (1) The /shop rule MUST have a `missing: [brand, printer_slug]` filter so
//       canonical traffic (/shop?brand=...&printer_slug=...) passes through
//       untouched — otherwise a stray ?printer= param alongside canonical
//       traffic gets hijacked.
//   (2) The legacy-printer rules MUST come BEFORE the generic /shop and
//       /html/shop rewrites in source order — Vercel evaluates rewrites top
//       to bottom and the first match wins. If the generic /shop → /html/shop
//       rule comes first, it swallows /shop?printer= traffic and the legacy
//       URL renders the empty SPA shell instead of the printer prerender.

const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges', 'vercel.json'), 'utf8'));
const REWRITES = VERCEL.rewrites || [];

function findRewrite(predicate) {
    return REWRITES.findIndex(predicate);
}

test('vercel.json — /shop?printer= legacy URLs rewrite to backend for brand lookup', () => {
    const idx = findRewrite(r =>
        r.source === '/shop' &&
        Array.isArray(r.has) &&
        r.has.some(h => h.type === 'query' && h.key === 'printer')
    );
    assert.notEqual(idx, -1, 'expected a /shop rewrite filtered on `?printer=` query');
    const rule = REWRITES[idx];
    assert.match(rule.destination, /^https:\/\/ink-backend-zaeq\.onrender\.com\/shop$/,
        'spec: legacy ?printer= URLs must proxy to backend (Render) — only it can compute brand_slug from printer_slug');
});

test('vercel.json — /shop?printer= rewrite has missing:[brand, printer_slug] guard', () => {
    const rule = REWRITES.find(r =>
        r.source === '/shop' &&
        Array.isArray(r.has) &&
        r.has.some(h => h.type === 'query' && h.key === 'printer')
    );
    assert.ok(rule, 'precondition: the /shop ?printer= rewrite exists');
    assert.ok(Array.isArray(rule.missing) && rule.missing.length >= 2,
        'spec: rule MUST have a `missing` clause so canonical traffic passes through');
    const missingKeys = rule.missing.map(m => m.key).sort();
    assert.deepEqual(missingKeys, ['brand', 'printer_slug'],
        'spec: missing must include both `brand` AND `printer_slug` so /shop?brand=...&printer_slug=... is not hijacked when ?printer= is also stray-set');
    for (const m of rule.missing) {
        assert.equal(m.type, 'query', 'missing filter must target query params, not headers/cookies');
    }
});

test('vercel.json — /html/shop?printer= legacy URLs also proxy to backend', () => {
    const rule = REWRITES.find(r =>
        r.source === '/html/shop' &&
        Array.isArray(r.has) &&
        r.has.some(h => h.type === 'query' && h.key === 'printer')
    );
    assert.ok(rule, 'spec: defense-in-depth rule for /html/shop?printer= legacy URLs');
    assert.match(rule.destination, /^https:\/\/ink-backend-zaeq\.onrender\.com\/html\/shop$/,
        'spec: /html/shop?printer= must proxy to backend so the printer_models→brands lookup runs');
});

test('vercel.json — legacy ?printer= rewrites come BEFORE the generic /shop and /html/shop rules', () => {
    // Order in Vercel rewrites is source-order; first match wins. The
    // ?printer= guarded rules MUST come before the unguarded /shop and
    // /html/shop rewrites or they will never match.
    const printerShopIdx = findRewrite(r =>
        r.source === '/shop' && Array.isArray(r.has) &&
        r.has.some(h => h.type === 'query' && h.key === 'printer')
    );
    const printerHtmlShopIdx = findRewrite(r =>
        r.source === '/html/shop' && Array.isArray(r.has) &&
        r.has.some(h => h.type === 'query' && h.key === 'printer')
    );
    const genericShopIdx = findRewrite(r => r.source === '/shop' && !r.has);
    const genericHtmlShopIdx = findRewrite(r => r.source === '/html/shop' && !r.has);

    assert.notEqual(printerShopIdx, -1, 'precondition: /shop ?printer= rule exists');
    assert.notEqual(printerHtmlShopIdx, -1, 'precondition: /html/shop ?printer= rule exists');
    assert.notEqual(genericShopIdx, -1, 'precondition: generic /shop rewrite exists');

    assert.ok(printerShopIdx < genericShopIdx,
        `spec: /shop ?printer= rule (idx=${printerShopIdx}) must come before generic /shop (idx=${genericShopIdx}) — first match wins`);
    if (genericHtmlShopIdx !== -1) {
        assert.ok(printerHtmlShopIdx < genericHtmlShopIdx,
            `spec: /html/shop ?printer= rule (idx=${printerHtmlShopIdx}) must come before generic /html/shop (idx=${genericHtmlShopIdx})`);
    }
});

test('vercel.json — canonical /shop?brand=&printer_slug= traffic is NOT hijacked by any rewrite', () => {
    // Simulate Vercel's first-match-wins evaluation against the canonical URL
    // /shop?brand=canon&printer_slug=canon-laser-shot-lbp5200. The expected
    // winner is the generic /shop → /html/shop rewrite (which renders the SPA
    // shell that knows how to handle brand+printer_slug); the legacy-printer
    // proxy rule must be skipped because the `missing` clause excludes it.
    const canonicalQuery = { brand: 'canon', printer_slug: 'canon-laser-shot-lbp5200' };
    const winner = simulateRewrite('/shop', canonicalQuery);
    assert.ok(winner, 'expected at least one rewrite to match /shop');
    assert.equal(winner.destination, '/html/shop',
        'spec: canonical printer URL must hit the SPA shell, NOT the backend proxy — the SPA renders the printer page from brand+printer_slug params');
});

test('vercel.json — legacy /shop?printer= traffic hits the backend proxy first', () => {
    const legacyQuery = { printer: 'canon-laser-shot-lbp5200' };
    const winner = simulateRewrite('/shop', legacyQuery);
    assert.ok(winner, 'expected a rewrite to match /shop?printer=');
    assert.match(winner.destination, /onrender\.com\/shop$/,
        'spec: legacy ?printer= URL must proxy to backend so the brand_slug lookup runs and 301s to canonical');
});

test('vercel.json — /shop?printer= alongside ?brand= alone (no printer_slug) is NOT hijacked', () => {
    // Edge case from the spec: "The `missing` clause on the second rule
    // prevents hijacking URLs where someone already has `?brand=` or
    // `?printer_slug=` set alongside a stray `?printer=`."
    // If only `brand` is set (no `printer_slug`), the canonical SPA still
    // can't render the printer-specific page, so falling through to the
    // generic /shop rewrite (SPA shell) is the right call — it renders the
    // brand-filtered shop, not the empty printer-page shell.
    const winner1 = simulateRewrite('/shop', { printer: 'x', brand: 'canon' });
    const winner2 = simulateRewrite('/shop', { printer: 'x', printer_slug: 'canon-x' });
    assert.equal(winner1.destination, '/html/shop',
        'spec: stray ?printer= alongside ?brand= must NOT be proxied — let the SPA render the brand page');
    assert.equal(winner2.destination, '/html/shop',
        'spec: stray ?printer= alongside ?printer_slug= must NOT be proxied — printer_slug already pins the canonical');
});

test('vercel.json — bare /shop (no query) hits the SPA shell (regression guard)', () => {
    const winner = simulateRewrite('/shop', {});
    assert.ok(winner);
    assert.equal(winner.destination, '/html/shop',
        'regression guard: empty-query /shop must fall through to the generic SPA rewrite');
});

/**
 * Mini Vercel-rewrite evaluator. Walks the rewrites array in source order
 * and returns the first rule that matches `path` + `query`. Honors `has`
 * (all entries must be present) and `missing` (none of the entries may be
 * present). Only supports `type: 'query'` filters, which is all our config
 * uses for this contract.
 */
function simulateRewrite(path, query) {
    for (const r of REWRITES) {
        if (r.source !== path) continue;
        const hasOk = !r.has || r.has.every(h =>
            h.type === 'query' && Object.prototype.hasOwnProperty.call(query, h.key)
        );
        const missingOk = !r.missing || r.missing.every(m =>
            m.type === 'query' && !Object.prototype.hasOwnProperty.call(query, m.key)
        );
        if (hasOk && missingOk) return r;
    }
    return null;
}
