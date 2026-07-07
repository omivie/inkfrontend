/**
 * Mobile UX Audit (July 2026)
 * ===========================
 *
 * Pins the storefront's response to the backend's mobile-ux-audit-jul2026.md.
 * This is the follow-up to mobile-parity-may2026 and, like it, verifies each
 * fix against the real HTML/CSS/JS of this vanilla static SPA (the audit was
 * written in Playwright idioms; live E2E lives in the e2e spec).
 *
 * Five workstreams:
 *   WS1 Foundation — mobile ergonomic tokens, theme-color/color-scheme meta on
 *       every storefront page, header/footer/sticky-atc tap targets → 48/44px.
 *   WS2 Sticky compact mobile header — .site-header pins on mobile + JS toggle.
 *   WS3 Filter & Sort sheet — shop `sort` param + client-side sort + sheet UI.
 *   WS4 Cart conversion signals — delivery/trust/free-ship-unlock/pack-swap/
 *       cart_saved_until wired from the cart response.
 *   WS5 Backend image fields — prefer image_thumbnail_url / image_srcset.
 *
 * Run with: node --test tests/mobile-ux-audit-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const BASE = read('css/base.css');
const LAYOUT = read('css/layout.css');
const PAGES = read('css/pages.css');
const MAIN_JS = read('js/main.js');
const SHOP_JS = read('js/shop-page.js');
const CART_JS = read('js/cart.js');
const PRODUCTS_JS = read('js/products.js');
const SHOP_HTML = read('html/shop.html');
const CART_HTML = read('html/cart.html');

// Same storefront page-set the navbar/mobile-parity suites walk.
function walkHtml(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'admin' || e.name === 'business') continue;
            walkHtml(p, out);
        } else if (e.name.endsWith('.html') && !e.name.startsWith('_')) {
            // Skip local dev harnesses (e.g. _qo-harness.html) — not shipped pages.
            out.push(p);
        }
    }
    return out;
}
const STOREFRONT_PAGES = walkHtml(APP).filter((f) =>
    fs.readFileSync(f, 'utf8').includes('<meta name="viewport"'));

// ─────────────────────────────────────────────────────────────────────────────
// WS1 — Foundation: tokens + meta + tap targets
// ─────────────────────────────────────────────────────────────────────────────

test('WS1 base.css :root defines the mobile ergonomic tokens (additive)', () => {
    for (const token of ['--tap-min', '--tap-gap', '--safe-bottom', '--header-h',
        '--step-body', '--step-h1', '--step-h2', '--step-h3', '--measure']) {
        assert.match(BASE, new RegExp(token.replace(/[-]/g, '\\-') + '\\s*:'),
            `base.css :root must define ${token}`);
    }
    assert.match(BASE, /--tap-min:\s*48px/, '--tap-min must be 48px (WCAG 2.5.5)');
    assert.match(BASE, /--step-body:\s*clamp\(1rem,/, '--step-body must never drop below 16px');
});

test('WS1 every storefront page ships theme-color + color-scheme meta', () => {
    assert.ok(STOREFRONT_PAGES.length >= 25, `expected 25+ pages, found ${STOREFRONT_PAGES.length}`);
    for (const file of STOREFRONT_PAGES) {
        const html = fs.readFileSync(file, 'utf8');
        assert.match(html, /<meta name="theme-color" content="#267FB5">/,
            `${path.relative(ROOT, file)} missing theme-color meta`);
        assert.match(html, /<meta name="color-scheme" content="light">/,
            `${path.relative(ROOT, file)} missing color-scheme meta`);
    }
});

test('WS1 header + hamburger + nav-search hit the 48px --tap-min target', () => {
    assert.match(LAYOUT, /\.header-actions__item\s*\{[^}]*min-(width|height):\s*var\(--tap-min\)/s,
        'header-actions__item must use --tap-min');
    assert.match(LAYOUT, /\.nav-toggle\s*\{[^}]*width:\s*var\(--tap-min\);[^}]*height:\s*var\(--tap-min\)/s,
        'nav-toggle must be a --tap-min square');
    assert.match(LAYOUT, /\.search-form--nav\s+\.search-form__button\s*\{[^}]*min-height:\s*var\(--tap-min\)/s,
        'nav search submit must be --tap-min tall');
});

test('WS1 footer links become >=44px tap rows on mobile (padding, not font-size)', () => {
    assert.match(LAYOUT, /@media \(max-width: 768px\)[\s\S]*\.footer-links a\s*\{[\s\S]*?min-height:\s*44px/,
        'footer links need a 44px line box inside the mobile breakpoint');
});

test('WS1 the PDP sticky-atc button reaches --tap-min (was 45px)', () => {
    assert.match(PAGES, /\.sticky-atc__btn\s*\{[\s\S]*?min-height:\s*var\(--tap-min\)/,
        '.sticky-atc__btn must set min-height: var(--tap-min)');
});

// ─────────────────────────────────────────────────────────────────────────────
// WS2 — Sticky compact mobile header
// ─────────────────────────────────────────────────────────────────────────────

test('WS2 .site-header is position:sticky inside the mobile breakpoint', () => {
    assert.match(LAYOUT, /@media \(max-width: 768px\)[\s\S]*\.site-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/,
        '.site-header must pin (sticky, top:0) on mobile');
    assert.match(LAYOUT, /\.site-header--scrolled\b/,
        'a scrolled compact state class must exist');
});

test('WS2 main.js wires initStickyHeader() into the init path', () => {
    assert.match(MAIN_JS, /function initStickyHeader\s*\(/, 'initStickyHeader must be defined');
    assert.match(MAIN_JS, /initStickyHeader\(\);/, 'initStickyHeader must be called on load');
    assert.match(MAIN_JS, /site-header--scrolled/, 'it must toggle the scrolled state class');
    assert.match(MAIN_JS, /requestAnimationFrame/, 'scroll handler should be rAF-throttled');
});

// ─────────────────────────────────────────────────────────────────────────────
// WS3 — Mobile Filter & Sort sheet
// ─────────────────────────────────────────────────────────────────────────────

test('WS3 shop.html ships the Filter & Sort bar + full-screen sheet', () => {
    assert.match(SHOP_HTML, /id="filter-sort-bar"/, 'filter-sort bar markup missing');
    assert.match(SHOP_HTML, /id="filter-sort-sheet"[^>]*role="dialog"[^>]*aria-modal="true"/,
        'sheet must be a modal dialog');
    assert.match(SHOP_HTML, /name="fs-sort" value="price_asc"/, 'price-asc sort option missing');
    assert.match(SHOP_HTML, /name="fs-source" value="compatible"/, 'compatible source filter missing');
    assert.match(SHOP_HTML, /id="fs-instock"/, 'in-stock toggle missing');
    assert.match(SHOP_HTML, /id="filter-sort-apply"/, 'apply button missing');
});

test('WS3 shop-page.js parses & emits the sort param and an in_stock flag', () => {
    assert.match(SHOP_JS, /SORT_OPTIONS:\s*\['recommended', 'price_asc', 'price_desc', 'name_asc', 'name_desc'\]/,
        'SORT_OPTIONS vocabulary must match the backend param');
    assert.match(SHOP_JS, /this\.state\.sort\s*=\s*this\.SORT_OPTIONS\.includes/,
        'parseURLState must validate sort against SORT_OPTIONS');
    assert.match(SHOP_JS, /params\.set\('sort', this\.state\.sort\)/, 'updateURL must emit sort');
    assert.match(SHOP_JS, /params\.set\('in_stock', '1'\)/, 'updateURL must emit in_stock');
});

test('WS3 renderProducts applies the client-side sort + in-stock refinement', () => {
    assert.match(SHOP_JS, /_sortProductsBy\(/, 'a client-side sort helper must exist');
    assert.match(SHOP_JS, /this\.state\.inStock/, 'renderProducts must honour the in-stock filter');
    // 'recommended' must still use the canonical byCodeThenColor grouping.
    assert.match(SHOP_JS, /sortMode !== 'recommended'[\s\S]*?ProductSort\.byCodeThenColor/,
        "recommended must keep byCodeThenColor; only explicit sorts flatten");
});

test('WS3 the bar shows only on product-list levels and the sheet is wired', () => {
    assert.match(SHOP_JS, /FILTER_SORT_LEVELS:\s*\['products', 'printer-products', 'printer-model-products', 'search-results'\]/,
        'the bar must be gated to the product-list levels');
    assert.match(SHOP_JS, /function\s+initFilterSort|initFilterSort\s*\(/, 'initFilterSort must exist');
    assert.match(SHOP_JS, /updateFilterSortBar\(\)/, 'the bar visibility must update per level');
});

// ─────────────────────────────────────────────────────────────────────────────
// WS4 — Cart conversion signals
// ─────────────────────────────────────────────────────────────────────────────

test('WS4 cart.html ships the signal containers', () => {
    for (const id of ['cart-free-ship-unlock', 'cart-delivery', 'cart-saved-until', 'cart-trust-signals']) {
        assert.match(CART_HTML, new RegExp(`id="${id}"`), `cart.html missing #${id}`);
    }
});

test('WS4 cart.js consumes every new cart-response field', () => {
    for (const field of ['trust_signals', 'delivery_estimate', 'free_shipping_unlock',
        'pack_suggestion_for_line', 'cart_saved_until']) {
        assert.match(CART_JS, new RegExp(field), `cart.js must read ${field}`);
    }
    assert.match(CART_JS, /serverCartMeta/, 'cart.js must stash the response meta');
    assert.match(CART_JS, /renderCartSignals/, 'renderCartSignals must exist and run');
});

test('WS4 per-line value-pack swap is dollars-only + escaped + one-tap', () => {
    assert.match(CART_JS, /renderLinePackSuggestion/, 'per-line pack renderer must exist');
    assert.match(CART_JS, /_swapLineForPack/, 'a one-tap swap handler must exist');
    // Value-pack convention: dollars only, never a percent, on the swap chip.
    const packFn = CART_JS.slice(CART_JS.indexOf('renderLinePackSuggestion'),
        CART_JS.indexOf('renderCartSignals'));
    assert.ok(!/savings_percent/.test(packFn),
        'the swap chip must not surface a percent (value-pack $-only convention)');
    assert.match(CART_JS, /Security\.escapeHtml/, 'dynamic signal HTML must be escaped');
});

// ─────────────────────────────────────────────────────────────────────────────
// WS5 — Prefer backend image fields
// ─────────────────────────────────────────────────────────────────────────────

test('WS5 card + shop-grid + cart images prefer image_thumbnail_url / image_srcset', () => {
    assert.match(PRODUCTS_JS, /product\.image_thumbnail_url\s*\n?\s*\|\|/,
        'products.js must prefer image_thumbnail_url with a fallback');
    assert.match(PRODUCTS_JS, /product\.image_srcset\s*\n?\s*\|\|/,
        'products.js must prefer image_srcset with a fallback');
    assert.match(SHOP_JS, /product\.image_thumbnail_url\s*\n?\s*\|\|/,
        'shop-page grid must prefer image_thumbnail_url');
    assert.match(CART_JS, /item\.image_thumbnail_url\s*\n?\s*\|\|/,
        'cart line item must prefer image_thumbnail_url');
});
