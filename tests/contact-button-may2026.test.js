/**
 * Contact-us OOS CTA contract — May 2026
 * =======================================
 *
 * Pin the rule from `readfirst/contact-button-may2026.md`:
 *
 *   When `product.in_stock === false` (or stock_status is out_of_stock /
 *   contact_us, or stock_quantity ≤ 0), every product card and the PDP
 *   buy box render ONE primary "Contact us" CTA pointing at /contact.
 *   No "Notify me" string survives anywhere; no UI surface calls the
 *   waitlist API; the inline duplicate "Contact Us" pill above the
 *   price collapses to "Out of stock".
 *
 * The waitlist endpoints stay mounted on the backend for cached older
 * bundles, but the storefront source code MUST NOT reference them in any
 * UI render path. These tests fail if anyone re-introduces the old
 * Notify-me branch, the waitlist injection on the PDP, or a duplicate
 * "Contact Us" pill text in getStockStatus.
 *
 * Run with: node --test tests/contact-button-may2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT     = path.resolve(__dirname, '..');
const JS       = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const HTML     = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const CSS      = (rel) => path.join(ROOT, 'inkcartridges', 'css', rel);
const READ     = (p)   => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const PRODUCTS_SRC = READ(JS('products.js'));
const SHOP_SRC     = READ(JS('shop-page.js'));
const PDP_SRC      = READ(JS('product-detail-page.js'));
const API_SRC      = READ(JS('api.js'));
const CART_SRC     = READ(JS('cart.js'));
const RIBBONS_SRC  = READ(JS('ribbons-page.js'));
const CONTACT_JS   = READ(JS('contact-page.js'));

const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);
const SHOP_CODE     = stripComments(SHOP_SRC);
const PDP_CODE      = stripComments(PDP_SRC);
const API_CODE      = stripComments(API_SRC);
const CART_CODE     = stripComments(CART_SRC);
const RIBBONS_CODE  = stripComments(RIBBONS_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — "Notify me" is gone from every render path
// ─────────────────────────────────────────────────────────────────────────────

test('§1 no UI render path emits the literal "Notify me" string', () => {
    for (const [label, code] of [
        ['products.js',           PRODUCTS_CODE],
        ['shop-page.js',          SHOP_CODE],
        ['product-detail-page.js', PDP_CODE],
        ['cart.js',               CART_CODE],
        ['ribbons-page.js',       RIBBONS_CODE],
    ]) {
        assert.ok(
            !/Notify\s*me/i.test(code),
            `${label}: "Notify me" must not appear in any UI render path (contact-button-may2026.md)`,
        );
    }
});

test('§1 no render path emits data-action="notify"', () => {
    for (const [label, code] of [
        ['products.js',  PRODUCTS_CODE],
        ['shop-page.js', SHOP_CODE],
    ]) {
        assert.ok(
            !/data-action\s*=\s*["']notify["']/.test(code),
            `${label}: data-action="notify" attribute must not be emitted`,
        );
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — OOS branch in card renderers points at /contact
// ─────────────────────────────────────────────────────────────────────────────

test('§2 products.js renderCard OOS branch renders "Contact us" → /contact handler', () => {
    // The OOS branch must produce a CTA that says "Contact us" and the
    // matching click handler must navigate to /contact.
    assert.match(PRODUCTS_CODE, /Contact us/, 'products.js must include "Contact us" CTA copy');
    assert.match(PRODUCTS_CODE, /data-action\s*=\s*["']contact["']/,
        'products.js must mark the OOS CTA with data-action="contact"');
    assert.match(
        PRODUCTS_CODE,
        /window\.location\.href\s*=\s*['"]\/contact['"]/,
        'products.js click handler must navigate to /contact',
    );
});

test('§2 shop-page.js card renderer OOS branch points at /contact', () => {
    assert.match(SHOP_CODE, /Contact us/, 'shop-page.js must include "Contact us" CTA copy');
    assert.match(SHOP_CODE, /data-action\s*=\s*["']contact["']/,
        'shop-page.js must mark the OOS CTA with data-action="contact"');
    assert.match(
        SHOP_CODE,
        /window\.location\.href\s*=\s*['"]\/contact['"]/,
        'shop-page.js click handler must navigate to /contact',
    );
});

test('§2 ribbons-page.js OOS branch renders Contact us → /contact', () => {
    assert.match(RIBBONS_CODE, /Contact us/, 'ribbons-page.js must include "Contact us" CTA copy');
    assert.match(RIBBONS_CODE, /data-action\s*=\s*["']contact["']/,
        'ribbons-page.js must mark the OOS CTA with data-action="contact"');
    assert.match(
        RIBBONS_CODE,
        /window\.location\.href\s*=\s*['"]\/contact['"]/,
        'ribbons-page.js click handler must navigate to /contact',
    );
});

test('§2 cart.js cross-sell modal renders Contact us when in_stock === false', () => {
    // The crosssell card lives inside an outer <a class="crosssell-modal__card">,
    // so we render a button with data-action="contact" rather than a nested <a>.
    assert.match(CART_CODE, /in_stock\s*===\s*false[\s\S]{0,400}Contact us/,
        'cart.js cross-sell must branch on in_stock === false → "Contact us"');
    assert.match(CART_CODE, /data-action\s*=\s*["']contact["']/,
        'cart.js cross-sell must mark the OOS CTA with data-action="contact"');
    assert.match(CART_CODE, /window\.location\.href\s*=\s*['"]\/contact['"]/,
        'cart.js must wire a global handler that navigates contact buttons to /contact');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — PDP buy box: <a href="/contact"> CTA, no waitlist injection
// ─────────────────────────────────────────────────────────────────────────────

test('§3 PDP main CTA renders <a href="/contact">Contact us when OOS or contact-us', () => {
    // The PDP isn't nested inside another anchor, so the spec's <a href> form
    // is preserved literally.
    assert.match(PDP_CODE, /href=["']\/contact["']/, 'PDP must render an <a href="/contact"> CTA');
    assert.match(PDP_CODE, /Contact us/, 'PDP CTA copy must read "Contact us"');
    assert.match(
        PDP_CODE,
        /stockStatus\.class\s*===\s*['"]out-of-stock['"][\s\S]{0,200}stockStatus\.class\s*===\s*['"]contact-us['"]/,
        'PDP must collapse out-of-stock and contact-us states into the same Contact us branch',
    );
});

test('§3 PDP waitlist injection method (_injectWaitlistButton) is removed', () => {
    assert.doesNotMatch(PDP_SRC, /_injectWaitlistButton/,
        'PDP must not declare or call _injectWaitlistButton — the waitlist UI is removed');
    assert.doesNotMatch(PDP_SRC, /Notify me when back in stock/,
        'PDP must not contain the "Notify me when back in stock" string');
    assert.doesNotMatch(PDP_SRC, /API\.waitlist(Subscribe|Unsubscribe|Status)/,
        'PDP must not call any waitlist API helper');
});

test('§3 PDP "Call to Order" tel: CTA is replaced by Contact us', () => {
    // The previous contact-us state used a tel: anchor labelled "Call to Order".
    // Spec says single primary "Contact us" CTA; tel: link must be gone from
    // the buy box / sticky bar. (The header still has a separate phone link.)
    const pdpStripped = stripComments(PDP_SRC);
    assert.doesNotMatch(pdpStripped, /Call to Order/,
        'PDP buy box must not render "Call to Order" tel: link (replaced by Contact us)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — getStockStatus pill text drops the duplicate "Contact Us"
// ─────────────────────────────────────────────────────────────────────────────

test('§4 getStockStatus returns "Out of stock" — never "Contact Us" — for OOS', () => {
    const m = API_CODE.match(/function getStockStatus\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, 'expected to find getStockStatus in api.js');
    const body = m[1];
    assert.doesNotMatch(body, /text:\s*['"]Contact Us['"]/,
        'getStockStatus must not return text "Contact Us" — that duplicates the new CTA button');
    assert.match(body, /text:\s*['"]Out of stock['"]/,
        'getStockStatus must surface OOS pills as "Out of stock"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — /contact route exists (vercel rewrite + html + js)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 vercel.json rewrites /contact → /html/contact', () => {
    const vercel = JSON.parse(READ(path.join(ROOT, 'inkcartridges', 'vercel.json')));
    const hit = (vercel.rewrites || []).find(
        (r) => r.source === '/contact' && r.destination === '/html/contact',
    );
    assert.ok(hit, 'vercel.json must rewrite /contact → /html/contact so the OOS link resolves');
});

test('§5 inkcartridges/html/contact.html exists with form posting to /api/contact path', () => {
    const html = READ(HTML('contact.html'));
    assert.match(html, /<form[^>]+id=["']contact-form["']/,
        'contact.html must include a #contact-form');
    assert.match(html, /name=["']email["']/,
        'contact.html must collect email');
    assert.match(html, /name=["']message["']/,
        'contact.html must collect a message');
    assert.match(html, /contact-page\.js/,
        'contact.html must load /js/contact-page.js');
    assert.match(html, /challenges\.cloudflare\.com\/turnstile/,
        'contact.html must load Cloudflare Turnstile (POST /api/contact requires a token)');
});

test('§5 contact-page.js posts to /api/contact with a turnstile_token', () => {
    assert.match(CONTACT_JS, /\/api\/contact/,
        'contact-page.js must target /api/contact');
    assert.match(CONTACT_JS, /turnstile_token/,
        'contact-page.js must include a turnstile_token in the payload');
    assert.match(CONTACT_JS, /TURNSTILE_SITE_KEY/,
        'contact-page.js must read Config.TURNSTILE_SITE_KEY');
    // Honeypot + error-callback per the contact-page.js / errors.md lesson:
    // missing error callbacks make Turnstile render failures invisible.
    assert.match(CONTACT_JS, /error-callback/,
        'contact-page.js must register a Turnstile error-callback');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — CSS: notify-btn dead rules are gone; contact-btn keeps hit target
// ─────────────────────────────────────────────────────────────────────────────

test('§6 components.css drops the dead .product-card__notify-btn rules', () => {
    const css = READ(CSS('components.css'));
    assert.doesNotMatch(css, /\.product-card__notify-btn\b/,
        'components.css must not retain .product-card__notify-btn rules — the class is dead');
});

test('§6 components.css keeps a .product-card__contact-btn rule with ≥44px hit target', () => {
    const css = READ(CSS('components.css'));
    const idx = css.indexOf('.product-card__contact-btn');
    assert.ok(idx !== -1, 'expected .product-card__contact-btn rule in components.css');
    const open  = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    const body  = css.slice(open + 1, close);
    assert.match(body, /min-height\s*:\s*44px/,
        'contact CTA must guarantee ≥44px hit target (WCAG 2.5.5)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — `waitlist_available` must NOT influence card rendering anywhere
// ─────────────────────────────────────────────────────────────────────────────

test('§7 no card-render path branches on product.waitlist_available', () => {
    for (const [label, code] of [
        ['products.js',           PRODUCTS_CODE],
        ['shop-page.js',          SHOP_CODE],
        ['product-detail-page.js', PDP_CODE],
    ]) {
        assert.doesNotMatch(code, /\.waitlist_available\b/,
            `${label}: must not branch on .waitlist_available — spec says ignore that field`);
    }
});
