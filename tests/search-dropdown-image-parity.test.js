/**
 * Search Dropdown ⇄ /search Results — Image Rendering Parity
 * ==========================================================
 *
 * Pins the "Image rendering parity (added 2026-05-20)" section of
 *   docs/storefront/search-dropdown-routing.md
 *   (in this repo: ~/Downloads/search-dropdown-routing.md, the backend-team
 *    handoff this storefront fix implements).
 *
 * The regression: /search?q=915xl rendered all six HP 915XL tiles with
 * photos, but the typeahead dropdown for the same query showed bare
 * `<img alt>` text for the magenta tile (HP Genuine 915XLM). Same product
 * row, same backend `image_url`. The backend was proven innocent — it ships
 * an identical, reachable URL on both surfaces.
 *
 * Root cause (storefront): both `src` and `srcset` route through
 * /api/images/optimize. When that endpoint transiently fails for ONE tile
 * (429 / cold-cache timeout / one bad conversion), the optimized URL errors
 * while the file itself is fine. The /search results grid (shop-page.js)
 * recovered because it carried `data-raw-src` (the direct Supabase URL) and
 * bound an error handler that retried it. The dropdown did neither:
 *   1. Products.getProductImageHTML (the shared renderer the dropdown uses)
 *      emitted NO data-raw-src.
 *   2. search.js renderResults never called Products.bindImageFallbacks —
 *      it was the ONLY card surface in the repo that skipped it.
 *
 * The fix unifies the fallback strategy ("Pick one fallback strategy and
 * apply it to both renderers", per the spec):
 *   - getProductImageHTML now emits data-raw-src (mirrors shop-page.js).
 *   - search.js renderResults now calls Products.bindImageFallbacks.
 *
 * Run with: node --test tests/search-dropdown-image-parity.test.js
 *
 * Two passes:
 *   (A) behavior — load utils.js + products.js into a vm + fake DOM, drive
 *       getProductImageHTML() and bindImageFallbacks() for real.
 *   (B) source-grep — guard the wiring against silent regression (e.g. a
 *       refactor that drops the bindImageFallbacks call, or a copy-paste that
 *       strips data-raw-src from one branch).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);

const API_URL = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE_URL = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const SAMPLE_PATH = 'images/products/G-HP-915XL-INK-MG/product.webp';

// ─────────────────────────────────────────────────────────────────────────────
// Pass A: behavior via `vm` + fake DOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Browser-shaped global with just enough surface for utils.js + products.js
 * to load and for getProductImageHTML / bindImageFallbacks to run. Security
 * is not attached to window in security.js (it's a frozen const), so we
 * supply a faithful escapeHtml/escapeAttr stub here.
 */
function makeEnv() {
    const sandbox = {
        console,
        window: {},
        document: { addEventListener() {} },
        location: { hostname: 'test', href: 'http://test/' },
        Config: { API_URL, SUPABASE_URL },
        Security: {
            escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
            escapeAttr: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        },
        Intl,
        URL,
        URLSearchParams,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    return sandbox;
}

function loadProducts() {
    const env = makeEnv();
    const ctx = vm.createContext(env);
    for (const rel of ['utils.js', 'products.js']) {
        vm.runInContext(fs.readFileSync(JS(rel), 'utf8'), ctx, { filename: rel });
    }
    return env;
}

test('storageUrl and storageUrlRaw produce DIFFERENT URLs (the failure window)', () => {
    const env = loadProducts();
    const opt = env.storageUrl(SAMPLE_PATH);
    const raw = env.storageUrlRaw(SAMPLE_PATH);
    assert.match(opt, /\/api\/images\/optimize\?/, 'optimized src must route through the optimize endpoint');
    assert.match(raw, /\/storage\/v1\/object\/public\/public-assets\//, 'raw must be the direct Supabase object URL');
    assert.notEqual(opt, raw,
        'precondition: opt !== raw, so data-raw-src is meaningful — if they were equal there would be nothing to retry');
});

test('getProductImageHTML — the 915XLM magenta tile carries data-raw-src for the retry', () => {
    const env = loadProducts();
    // The actual regression row. "Magenta" in the name makes ProductColors
    // detect a color, so it takes the color-block branch (with a hidden swatch
    // sibling) — but the load-bearing fix is the data-raw-src on the <img>,
    // present on either branch.
    const html = env.Products.getProductImageHTML({
        image_url: SAMPLE_PATH,
        name: 'HP Genuine 915XLM Ink Cartridge 915XL Magenta',
        source: 'genuine',
    });
    assert.match(html, /data-fallback="(placeholder|color-block)"/, 'renders an <img> with a data-fallback hook');
    assert.match(html, /data-raw-src="/,
        'spec 2026-05-20: dropdown <img> MUST carry data-raw-src so a failed optimize URL can retry the raw Supabase URL — this is the exact 915XLM regression');
    const raw = env.storageUrlRaw(SAMPLE_PATH);
    assert.ok(html.includes(`data-raw-src="${env.Security.escapeAttr(raw)}"`),
        'data-raw-src value must be the raw Supabase URL, byte-identical to the shop-page.js results grid');
});

test('getProductImageHTML — placeholder branch (no detectable color) carries data-raw-src', () => {
    const env = loadProducts();
    // A genuine product whose name evokes no color → ProductColors returns no
    // style → the placeholder-fallback <img> branch.
    const html = env.Products.getProductImageHTML({
        image_url: SAMPLE_PATH,
        name: 'HP Genuine 962 Setup Ink Cartridge',
        source: 'genuine',
    });
    assert.match(html, /data-fallback="placeholder"\s+data-raw-src="/,
        'spec: the placeholder branch must append data-raw-src directly after data-fallback');
});

test('getProductImageHTML — color-block branch also carries data-raw-src', () => {
    const env = loadProducts();
    const html = env.Products.getProductImageHTML({
        image_url: SAMPLE_PATH,
        name: 'Brother LC-3319XL Compatible Ink Cartridge Cyan',
        color: 'Cyan',
        source: 'compatible',
    });
    // A compatible product with a known color + a real image takes the
    // colorStyle branch (data-fallback="color-block"). It must ALSO get
    // data-raw-src — the spec's "pick one fallback strategy" means BOTH img
    // branches retry raw before dropping to the color block.
    assert.match(html, /data-fallback="color-block"/, 'compatible-with-color-and-image takes the color-block branch');
    assert.match(html, /data-raw-src="/,
        'spec: the color-block branch must also carry data-raw-src — parity with shop-page.js:3156');
});

test('getProductImageHTML — sets NO crossOrigin (parity point 4)', () => {
    const env = loadProducts();
    const html = env.Products.getProductImageHTML({ image_url: SAMPLE_PATH, name: 'x', source: 'genuine' });
    assert.doesNotMatch(html, /crossorigin/i,
        'spec point 4: do not set crossOrigin unless the /search card does too (it does not) — a mismatch forces a fresh request that bypasses the cached working response');
});

test('getProductImageHTML — src and srcset both route through the optimize endpoint (same as /search)', () => {
    const env = loadProducts();
    const html = env.Products.getProductImageHTML({ image_url: SAMPLE_PATH, name: 'x', source: 'genuine' });
    // Spec point 1: use the same src value the backend image pipeline returns,
    // no extra transformation. Both surfaces send src + srcset through
    // /api/images/optimize; the ONLY recovery path is data-raw-src.
    assert.match(html, /src="[^"]*\/api\/images\/optimize\?/, 'src must be the optimized URL');
    assert.match(html, /srcset="[^"]*\/api\/images\/optimize\?/, 'srcset must be optimized URLs (matches shop-page.js)');
});

// ── bindImageFallbacks: the error → raw-retry → placeholder/color-block ladder ──

/** Minimal fake <img> supporting the surface bindImageFallbacks touches. */
function makeFakeImg({ fallback, rawSrc, src = 'http://opt/url', hasSrcset = true, nextSibling = null }) {
    const listeners = {};
    return {
        dataset: Object.assign({}, fallback ? { fallback } : {}, rawSrc ? { rawSrc } : {}),
        src,
        style: {},
        _srcset: hasSrcset ? 'a 200w, b 400w' : undefined,
        nextElementSibling: nextSibling,
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeAttribute(name) {
            if (name === 'srcset') this._srcset = undefined;
            if (name === 'data-fallback') this.dataset.fallback = undefined;
        },
        fireError() { for (const fn of (listeners.error || [])) fn.call(this); },
    };
}

function bindAndGet(env, imgs) {
    const container = { querySelectorAll: () => imgs };
    env.Products.bindImageFallbacks(container);
    return imgs;
}

test('bindImageFallbacks — first error retries the raw URL and drops srcset', () => {
    const env = loadProducts();
    const img = makeFakeImg({ fallback: 'placeholder', rawSrc: 'http://raw/url', src: 'http://opt/url' });
    bindAndGet(env, [img]);
    img.fireError();
    assert.equal(img.src, 'http://raw/url',
        'spec: on first error the optimized src must fall back to the raw Supabase URL — this is what recovers the 915XLM magenta tile');
    assert.equal(img._srcset, undefined,
        'srcset must be stripped on retry so the browser does not re-pick a failing optimized candidate');
});

test('bindImageFallbacks — second error (raw also dead) drops to the SVG placeholder', () => {
    const env = loadProducts();
    const img = makeFakeImg({ fallback: 'placeholder', rawSrc: 'http://raw/url', src: 'http://opt/url' });
    bindAndGet(env, [img]);
    img.fireError(); // → raw
    img.fireError(); // raw also failed → placeholder
    assert.equal(img.src, '/assets/images/placeholder-product.svg',
        'spec: when the raw URL also fails, fall back to the GENUINE placeholder — same terminal state as /search');
});

test('bindImageFallbacks — color-block branch reveals the sibling swatch when raw is exhausted', () => {
    const env = loadProducts();
    const sibling = { style: {} };
    // No rawSrc here (rawAttr is omitted when raw === optimized): first error
    // goes straight to the color-block reveal.
    const img = makeFakeImg({ fallback: 'color-block', src: 'http://opt/url', hasSrcset: false, nextSibling: sibling });
    bindAndGet(env, [img]);
    img.fireError();
    assert.equal(img.style.display, 'none', 'failed image is hidden');
    assert.equal(sibling.style.display, 'flex', 'the styled color block sibling is revealed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass B: source-grep regression guards
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCTS_SRC = fs.readFileSync(JS('products.js'), 'utf8');
const SEARCH_SRC = fs.readFileSync(JS('search.js'), 'utf8');
const SHOP_SRC = fs.readFileSync(JS('shop-page.js'), 'utf8');

test('products.js — getProductImageHTML computes rawImageUrl via storageUrlRaw', () => {
    assert.match(PRODUCTS_SRC, /const\s+rawImageUrl\s*=[^\n]*storageUrlRaw\(product\.image_url\)/,
        'getProductImageHTML must derive the raw URL via storageUrlRaw, matching shop-page.js:3145');
    assert.match(PRODUCTS_SRC, /const\s+rawAttr\s*=[^\n]*data-raw-src=/,
        'getProductImageHTML must build a data-raw-src attribute fragment');
});

test('products.js — BOTH img branches of getProductImageHTML emit ${rawAttr}', () => {
    // Pull the getProductImageHTML body and count rawAttr interpolations on the
    // two image-bearing branches (color-block + placeholder).
    const body = PRODUCTS_SRC.match(/getProductImageHTML\([\s\S]+?\n {4}\},/);
    assert.ok(body, 'expected to locate getProductImageHTML body');
    const colorBlock = /data-fallback="color-block"\$\{rawAttr\}/.test(body[0]);
    const placeholder = /data-fallback="placeholder"\$\{rawAttr\}/.test(body[0]);
    assert.ok(colorBlock, 'color-block <img> must append ${rawAttr}');
    assert.ok(placeholder, 'placeholder <img> must append ${rawAttr}');
});

test('search.js — renderResults binds image fallbacks on the dropdown list', () => {
    assert.match(SEARCH_SRC, /Products\.bindImageFallbacks\(state\.list\)/,
        'spec: the dropdown MUST call Products.bindImageFallbacks(state.list) — it was the only card surface that skipped it');
});

test('search.js — still renders cards via Products.renderCard (renderer fix flows through)', () => {
    assert.match(SEARCH_SRC, /Products\.renderCard\(adaptForCard\(p\)/,
        'the data-raw-src fix lives in the shared Products renderer; the dropdown must keep delegating to it');
});

test('shop-page.js — results grid remains the data-raw-src reference surface (lockstep guard)', () => {
    // If shop-page.js ever drops data-raw-src, the "parity" target moves and
    // this whole contract is moot. Pin it so the two surfaces stay aligned.
    assert.match(SHOP_SRC, /data-raw-src="\$\{Security\.escapeAttr\(rawImageUrl\)\}"/,
        'shop-page.js results grid must keep emitting data-raw-src — it is the parity reference');
    assert.match(SHOP_SRC, /Products\.bindImageFallbacks\(container\)/,
        'shop-page.js must keep binding the shared fallback handler');
});

test('repo — every card-rendering surface that uses renderCard also binds image fallbacks', () => {
    // The dropdown was the lone omission. Guard against a NEW surface shipping
    // renderCard output without binding fallbacks. We only assert search.js
    // here (the historically-broken one); the broad invariant is documented.
    const surfaces = ['shop-page.js', 'filters.js', 'landing.js', 'search.js'];
    for (const f of surfaces) {
        const src = fs.readFileSync(JS(f), 'utf8');
        assert.match(src, /bindImageFallbacks/,
            `${f} renders product cards and must bind image fallbacks for parity`);
    }
});
