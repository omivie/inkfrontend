/**
 * Canon BCI→CI genuine-name canonicalisation (May 2026)
 * ======================================================
 *
 * Background: 2026-05-20 the backend supplier-name normalizer began stripping
 * the leading "B" from every Canon DSNZ genuine SKU/name. "Canon Genuine
 * BCI-3e" → "Canon Genuine CI-3e", "BCI-6" → "CI-6", and the pack SKU
 * GBCI3ECMY moved from
 *   "Canon Genuine BCI3eCMY Ink Cartridge BCI3e CMY 3-Pack"
 * to
 *   "Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)".
 *
 * SKUs are unchanged (still G…) and compatible-product names still carry the
 * BCI prefix because they reference the original Canon model designation.
 *
 * This rename has these frontend invariants this file pins:
 *
 *   1. The compatible-side series-code extractor in api.js still recovers
 *      `BCI3, BCI6` from a compat name like "BCI3CMY Compatible Ink Cartridge
 *      for Canon BCI3 BCI6 CMY 3-Pack". Compats are how the /shop chip-grid
 *      surfaces brand families for which the catalog has no genuines yet, and
 *      regressing this would empty the Canon ink chip grid.
 *
 *   2. The new genuine name "Canon Genuine CI3ECMY Ink Cartridge CI3E CMY
 *      3-Pack" must NOT be detected as compatible by Cart._isCompatible or
 *      Favourites._isCompatible. The leading-word `^compatible\b` regex is
 *      the last-resort path for legacy localStorage rows that predate
 *      product_source, so any genuine name that begins with a non-"compatible"
 *      token must fall through to false.
 *
 *   3. Cart and Favourites both read `name` from the live server response on
 *      every hydrate path — never from a localStorage-only snapshot. After
 *      the rename, a user who favourited / carted GBCI3ECMY under its old
 *      name will see the new name on the next page load.
 *
 *   4. The PDP URL normaliser is unconditional, so a visit to the old slug
 *      `/products/canon-genuine-bci3ecmy-…/GBCI3ECMY` ends with the polished
 *      `/products/canon-genuine-ci3ecmy-…/GBCI3ECMY` in the URL bar via
 *      history.replaceState (humans) or backend 301 on /p/:sku (the canonical
 *      short URL — proxied through vercel.json).
 *
 * Backend dev's note (2026-05-20):
 *   "Compatible names still carry BCI prefix … the Canon ink chip grid will
 *   show CI3 (genuine) and BCI3 (compatible) as separate chips for the same
 *   physical cartridge family. Not new behaviour, but the split widens after
 *   this change. If they want a single merged chip, that's a backend
 *   extractSeriesCodes change."
 *
 * So this file deliberately ALLOWS the BCI/CI split — the dual-chip render
 * is the documented short-term outcome, and merging would need a backend
 * change to extractSeriesCodes.
 *
 * Run with: node --test tests/canon-bci-to-ci-rename-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'inkcartridges', 'js');
const HTML_ROOT = path.join(ROOT, 'inkcartridges');

function readSource(rel) {
    return fs.readFileSync(path.join(JS_DIR, rel), 'utf8');
}

// ─── Load api.js into a sandbox so we can exercise _enrichSeriesCodes ───────
// Pattern copied from tests/compatible-products-recovery.test.js — api.js
// pulls in Config / DebugLog / fetch / localStorage globals, so we stub them.

function loadApi() {
    const sandbox = {
        console,
        fetch: async () => ({
            ok: true, status: 200,
            headers: { get: () => null },
            async json() { return { ok: true, data: {} }; },
            async text() { return '{}'; },
        }),
        setTimeout, clearTimeout, AbortController,
        Headers: globalThis.Headers,
        URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error,
        Object, Array, String, Number, Boolean, Symbol, RegExp,
        structuredClone: globalThis.structuredClone,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: {
            _data: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
            setItem(k, v) { this._data[k] = String(v); },
            removeItem(k) { delete this._data[k]; },
        },
        document: { cookie: '' },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(readSource('api.js'), ctx, { filename: 'api.js' });
    return sandbox.API;
}

// ─── Lift a method body from cart.js / favourites.js as a standalone fn ─────
// Both files are browser modules that wouldn't load standalone (Auth, Cart,
// CartAnalytics, document, …). For helper methods like _isCompatible we can
// pull the body via regex and `new Function` it, which is what
// tests/genuine-no-color-tile.test.js already does.

function liftIsCompatible(source) {
    // _isCompatible(item) { … } — body delimited by the next `\n    },` line
    // (4-space indent for module-level methods on the object literal).
    const m = source.match(/_isCompatible\s*[:=]?\s*(?:function\s*)?\(item\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, '_isCompatible not found in source');
    return new Function('item', m[1]);
}

// ─── (1) compat extractor still recovers BCI3 / BCI6 ─────────────────────────

const API = loadApi();

test('compat name "BCI3CMY Compatible … Canon BCI3 BCI6 CMY 3-Pack" → BCI3 + BCI6', () => {
    const product = {
        sku: 'CBCI3CMY',
        name: 'BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack',
        series_codes: []
    };
    const enriched = API._enrichSeriesCodes(product);
    assert.equal(enriched, true, 'must enrich locally — backend ships [] for compats');
    const set = new Set(product.series_codes);
    assert.ok(set.has('BCI3'), `expected BCI3 in series_codes, got ${[...set].join(',')}`);
    assert.ok(set.has('BCI6'), `expected BCI6 in series_codes, got ${[...set].join(',')}`);
});

test('compat single-colour "BCI3BK Compatible … Canon BCI3" → BCI3', () => {
    const product = {
        sku: 'CBCI3BK',
        name: 'BCI3BK Compatible Ink Cartridge for Canon BCI3 Black',
        series_codes: []
    };
    API._enrichSeriesCodes(product);
    assert.ok((product.series_codes || []).map(c => c.toUpperCase()).includes('BCI3'),
        `BCI3 must extract from compatible name; got ${product.series_codes}`);
});

test('compat SKU pattern works even if name copy drifts', () => {
    // Sanity: even if backend's normaliser ever leaked into compatible names
    // (it should not), the SKU pattern alone should recover the code.
    const product = {
        sku: 'CBCI3CMY',
        name: 'Compatible Replacement Ink for Canon CMY Multi-Pack',
        series_codes: []
    };
    API._enrichSeriesCodes(product);
    assert.ok((product.series_codes || []).some(c => /^BCI3/.test(c.toUpperCase())),
        `compat SKU "C<code>" path must still extract; got ${product.series_codes}`);
});

test('genuine "Canon Genuine CI3ECMY …" with backend-supplied [CI3E] passes through', () => {
    const product = {
        sku: 'GBCI3ECMY',
        name: 'Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)',
        series_codes: ['CI3E']
    };
    const enriched = API._enrichSeriesCodes(product);
    assert.equal(enriched, false, 'backend-supplied codes must not re-enrich');
    assert.deepEqual(product.series_codes, ['CI3E']);
});

// ─── (2) new genuine names are NOT mis-detected as compatible ───────────────

const cartSrc = readSource('cart.js');
const favSrc = readSource('favourites.js');
const isCompatibleCart = liftIsCompatible(cartSrc);
const isCompatibleFav = liftIsCompatible(favSrc);

test('Cart._isCompatible — new genuine "Canon Genuine CI3ECMY …" returns false', () => {
    const renamedGenuine = {
        name: 'Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)',
        product_source: 'genuine'
    };
    assert.equal(isCompatibleCart(renamedGenuine), false);
});

test('Cart._isCompatible — name-only fallback rejects "Canon Genuine CI…"', () => {
    // Legacy localStorage row missing product_source — only the leading-word
    // /^compatible\b/ regex fires. The new "Canon Genuine CI…" name must
    // fall through to false.
    const legacy = {
        name: 'Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)'
        // no product_source, no source
    };
    assert.equal(isCompatibleCart(legacy), false,
        'genuine name must not match the /^compatible\\b/ regex');
});

test('Cart._isCompatible — compat with BCI prefix still detected', () => {
    const compat = {
        name: 'Compatible Ink Cartridge Replacement for Canon BCI3 BCI6 CMY 3-Pack',
        product_source: 'compatible'
    };
    assert.equal(isCompatibleCart(compat), true);
});

test('Favourites._isCompatible — mirrors Cart._isCompatible for renamed genuine', () => {
    const renamedGenuine = {
        name: 'Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)',
        product_source: 'genuine'
    };
    assert.equal(isCompatibleFav(renamedGenuine), false);
});

test('Favourites._isCompatible — name-only fallback rejects "Canon Genuine CI…"', () => {
    const legacy = {
        name: 'Canon Genuine CI3ECMY Ink Cartridge CI3E CMY 3-Pack (280 pages)'
    };
    assert.equal(isCompatibleFav(legacy), false);
});

// ─── (3) cart + favourites hydrate name from live server, not localStorage ──

test('cart._parseServerCart sources name from item.product.name (live, not cached)', () => {
    // The parser must read name from item.product.name on every load — that's
    // how the rename propagates. If anyone ever wires it to read from a stored
    // snapshot first, this test fails.
    const idx = cartSrc.indexOf('_parseServerCart');
    assert.ok(idx !== -1);
    const slice = cartSrc.slice(idx, idx + 4000);
    assert.match(slice, /name\s*:\s*item\.product\.name/,
        '_parseServerCart must map name from item.product.name (live API field)');
});

test('favourites.loadFromServer sources name from fav.product.name (live, not cached)', () => {
    const idx = favSrc.indexOf('loadFromServer');
    assert.ok(idx !== -1);
    const slice = favSrc.slice(idx, idx + 4000);
    assert.match(slice, /name\s*:\s*fav\.product\?\.name/,
        'loadFromServer must map name from fav.product?.name (live API field)');
});

test('cart.init calls loadCart so names refresh on every page load', () => {
    // The init() flow must end up calling loadCart() unconditionally — that's
    // what makes the cart "self-healing" after a backend rename.
    const idx = cartSrc.indexOf('async init()');
    assert.ok(idx !== -1, 'Cart.init must exist');
    // Find the body of init() (next 4000 chars is plenty)
    const slice = cartSrc.slice(idx, idx + 4000);
    assert.match(slice, /this\.loadCart\s*\(/, 'Cart.init must call this.loadCart()');
});

test('favourites.init calls loadFromServer when authenticated', () => {
    const idx = favSrc.indexOf('async init()');
    assert.ok(idx !== -1, 'Favourites.init must exist');
    const slice = favSrc.slice(idx, idx + 2000);
    assert.match(slice, /this\.loadFromServer\s*\(/,
        'Favourites.init must call this.loadFromServer() in the authenticated branch');
});

// ─── (4) zero hardcoded "Canon BCI" marketing copy in HTML / CSS ────────────

test('no hardcoded "Canon BCI" / "BCI-3e" / "BCI-6" copy in storefront HTML / CSS', () => {
    const tokens = [
        /\bcanon\s+BCI-?3e\b/i,
        /\bcanon\s+BCI-?6\b/i,
        /\bcanon\s+BCI\b/i,
    ];
    const offenders = [];
    const stack = [HTML_ROOT];
    while (stack.length) {
        const dir = stack.pop();
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'node_modules' || ent.name === 'assets') continue;
                stack.push(full);
                continue;
            }
            if (!/\.(html|css)$/i.test(ent.name)) continue;
            const txt = fs.readFileSync(full, 'utf8');
            for (const re of tokens) {
                if (re.test(txt)) {
                    offenders.push(`${path.relative(ROOT, full)} :: ${re.source}`);
                    break;
                }
            }
        }
    }
    assert.deepEqual(offenders, [],
        `hardcoded Canon BCI copy will mismatch the renamed catalogue:\n  ${offenders.join('\n  ')}`);
});

// ─── (5) PDP normaliser is unconditional (covers loser-slug → new slug) ─────

test('product-detail-page.js URL normaliser fires unconditionally on every load', () => {
    const pdpSrc = readSource('product-detail-page.js');
    // Pin the unconditional replaceState that handles the old
    // `/products/canon-genuine-bci3ecmy-…/GBCI3ECMY` URL → new polished slug.
    // Must NOT be gated on cameFromShortUrl.
    assert.match(pdpSrc, /history\.replaceState\s*\(/,
        'PDP must call history.replaceState to swap the URL bar to canonical');
    const idx = pdpSrc.indexOf('canonicalPath !== window.location.pathname');
    assert.ok(idx !== -1,
        'PDP must compare canonicalPath against current path before swapping');
    // The branch around that comparison must not require cameFromShortUrl.
    const window = pdpSrc.slice(Math.max(0, idx - 500), idx + 200);
    assert.equal(/cameFromShortUrl/.test(window), false,
        'PDP normaliser must be unconditional, not gated on cameFromShortUrl');
});

// ─── (6) /p/:sku stays proxied so backend 301 still fires for old slugs ─────

test('vercel.json keeps /p/:sku proxied to backend so slug_redirects fires', () => {
    const vercelJson = JSON.parse(
        fs.readFileSync(path.join(HTML_ROOT, 'vercel.json'), 'utf8'));
    const rewrite = (vercelJson.rewrites || []).find(r => r.source === '/p/:sku');
    assert.ok(rewrite, '/p/:sku rewrite must exist');
    assert.match(rewrite.destination, /onrender\.com\/p\/:sku$/,
        '/p/:sku must pass through to Render backend (preserves backend 301)');
});
