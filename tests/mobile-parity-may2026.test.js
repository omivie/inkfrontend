/**
 * Mobile Parity audit (May 2026)
 * ==============================
 *
 * Pins the fixes from readfirst/mobile-parity-may2026.md — the storefront's
 * response to the backend dev's mobile-parity-audit-may2026.md. The audit was
 * written against the live site in React/Next idioms; this is a vanilla-JS
 * static SPA, so each fix is verified against the real HTML/CSS/JS here.
 *
 * The suite has two halves:
 *   1. NEW FIXES — assertions for the gaps we closed (S0.1/S0.6 header a11y,
 *      S1.5 card touch targets, S2.1 PDP buy-box overflow, S1.1/S1.2 search
 *      dropdown, S3.1 cart sticky bar, S3.2 coupon UI, S0.3 brand picker,
 *      S0.5 footer accordion, S2.4 breadcrumb dedupe, S0.11 scrollbar gutter).
 *   2. REGRESSION GUARDS — audit findings that were ALREADY shipped and must
 *      stay that way (S0.2 PDP title has no "Save up to 70%", S0.7 PDP sticky
 *      buy bar, S1.4 the per-card source chip stays removed).
 *
 * Run with: node --test tests/mobile-parity-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const LAYOUT = read('css/layout.css');
const COMPONENTS = read('css/components.css');
const PAGES = read('css/pages.css');
const SEARCH = read('css/search.css');
const MAIN_JS = read('js/main.js');
const CART_PAGE_JS = read('js/cart-page.js');
const SHOP_PAGE_JS = read('js/shop-page.js');
const FOOTER_JS = read('js/footer.js');
const CART_HTML = read('html/cart.html');
const PRODUCT_HTML = read('html/product/index.html');
const PDP_JS = read('js/product-detail-page.js');
const PRODUCTS_JS = read('js/products.js');

function walkHtml(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'admin' || e.name === 'business') continue;
            walkHtml(p, out);
        } else if (e.name.endsWith('.html')) {
            out.push(p);
        }
    }
    return out;
}
const HEADER_PAGES = walkHtml(APP).filter((f) => fs.readFileSync(f, 'utf8').includes('<header class="site-header">'));

// ─────────────────────────────────────────────────────────────────────────────
// S0.1 — header icon-only links have accessible names + 44px touch targets
// ─────────────────────────────────────────────────────────────────────────────

test('S0.1 every page header gives the icon-only action links an aria-label', () => {
    assert.ok(HEADER_PAGES.length >= 20, `expected 20+ header pages, found ${HEADER_PAGES.length}`);
    const required = [
        '<a href="/account" class="header-actions__item" aria-label="Account">',
        '<a href="/account/favourites" class="header-actions__item" aria-label="Favourites">',
        '<a href="/cart" class="header-actions__item" aria-label="Cart">',
        // The Admin shortcut is no longer static markup — it is JS-injected for
        // verified admins only (MC audit, Jul 2026), with its aria-label set in
        // main.js#initAdminHeaderLink. See admin-header-link-may2026.test.js.
        '<button class="nav-toggle" aria-expanded="false" aria-controls="nav-menu" aria-label="Open navigation menu">',
    ];
    for (const file of HEADER_PAGES) {
        const html = fs.readFileSync(file, 'utf8');
        for (const needle of required) {
            assert.ok(html.includes(needle),
                `${path.relative(ROOT, file)} is missing header a11y token: ${needle}`);
        }
    }
});

test('S0.1 the cart count badge is aria-hidden (count is announced via the link label)', () => {
    for (const file of HEADER_PAGES) {
        const html = fs.readFileSync(file, 'utf8');
        assert.ok(html.includes('<span class="cart-badge" id="cart-count" aria-hidden="true">'),
            `${path.relative(ROOT, file)} cart badge must be aria-hidden`);
    }
});

test('S0.1 updateCartCount() syncs the cart link aria-label to "Cart, N items"', () => {
    assert.match(MAIN_JS, /header-actions__item\[href="\/cart"\]/,
        'main.js updateCartCount must target the header cart link');
    assert.match(MAIN_JS, /Cart, \$\{n\} item/,
        'main.js must set an aria-label like "Cart, N items"');
});

test('S0.1 layout.css enforces >=44px touch targets for header action links, hamburger, search button', () => {
    // The Jul 2026 mobile-ux audit (§5b) raised these from the 44px Apple floor
    // to the 48px WCAG AAA target via the --tap-min token. Accept the token
    // (or a literal 44/48) so both eras pass. Effective size is pinned to 48px
    // by mobile-ux-audit-jul2026.test.js.
    assert.match(LAYOUT, /\.header-actions__item\s*\{[^}]*min-(width|height):\s*(var\(--tap-min\)|4[48]px)/s,
        'header-actions__item needs a >=44px min touch target');
    assert.match(LAYOUT, /\.nav-toggle\s*\{[^}]*width:\s*(var\(--tap-min\)|4[48]px);[^}]*height:\s*(var\(--tap-min\)|4[48]px)/s,
        'nav-toggle must be a >=44px square');
    assert.match(LAYOUT, /\.search-form--nav\s+\.search-form__button\s*\{[^}]*min-height:\s*(var\(--tap-min\)|4[48]px)/s,
        'nav search submit must be >=44px tall');
});

// ─────────────────────────────────────────────────────────────────────────────
// S0.6 — tap-to-call phone stays visible on mobile
// ─────────────────────────────────────────────────────────────────────────────

test('S0.6 the tel: utility link is shown on mobile (mailto hidden)', () => {
    // Inside a max-width media query, .header-contact is re-shown and the
    // mailto item is hidden, leaving the tap-to-call phone visible.
    assert.match(LAYOUT, /\.header-contact__item\[href\^="mailto:"\]\s*\{\s*display:\s*none/s,
        'email item should be hidden on mobile');
    assert.match(LAYOUT, /\.header-contact__item\[href\^="tel:"\]\s*\{[^}]*min-height:\s*44px/s,
        'tel item should be a visible 44px tap target on mobile');
    // It must NOT be unconditionally display:none — assert it is re-shown.
    assert.match(LAYOUT, /@media \(max-width: 768px\)[\s\S]*\.header-contact\s*\{[\s\S]*?display:\s*flex/,
        'header-contact must be re-shown (display:flex) inside a mobile media query');
});

// ─────────────────────────────────────────────────────────────────────────────
// S1.5 — product card buttons reach 44px on mobile
// ─────────────────────────────────────────────────────────────────────────────

test('S1.5 product card add-to-cart + favourites buttons hit 44px under 768px', () => {
    assert.match(COMPONENTS, /@media \(max-width: 768px\)[\s\S]*\.product-card__add-btn[\s\S]*?min-height:\s*44px/,
        'product-card add button needs min-height 44px on mobile');
    assert.match(COMPONENTS, /\.favourite-item__remove\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/,
        'favourites remove button needs to be 44×44 on mobile');
});

// ─────────────────────────────────────────────────────────────────────────────
// S2.1 — PDP buy box no longer overflows at 375px
// ─────────────────────────────────────────────────────────────────────────────

test('S2.1 PDP buy box becomes a 2-col grid at <=480 so the favourite button stays in-viewport', () => {
    assert.match(PAGES, /@media \(max-width: 480px\)[\s\S]*\.product-info__actions\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*1fr 48px/,
        'product-info__actions must be a 1fr/48px grid at <=480px');
    assert.match(PAGES, /\.product-info__actions\s+\.quantity-selector\s*\{[\s\S]*?grid-column:\s*1 \/ -1/,
        'the quantity selector should span its own row');
});

// ─────────────────────────────────────────────────────────────────────────────
// S1.1 / S1.2 — search dropdown mobile layout
// ─────────────────────────────────────────────────────────────────────────────

test('S1.1 the search dropdown grid is single-column horizontal-thumb at <=480', () => {
    assert.match(SEARCH, /@media \(max-width: 480px\)[\s\S]*\.smart-ac__grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
        'smart-ac grid must be single-column at <=480');
    assert.match(SEARCH, /\.smart-ac__grid\s+\.product-card__link\s*\{[\s\S]*?grid-template-columns:\s*64px 1fr/,
        'cards become a 64px thumb + content row');
    // The 4-line title clamp from the title-clamp contract must NOT be reduced.
    assert.ok(!/\.smart-ac__grid\s+\.product-card__title\s*\{[^}]*-webkit-line-clamp:\s*2/.test(SEARCH),
        'must not clamp dropdown titles below 4 lines (title-clamp contract)');
});

test('S1.2 the printer drill-in row is sticky and the dropdown uses dvh on mobile', () => {
    assert.match(SEARCH, /\.smart-ac__top-row--printer\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/,
        'printer drill-in row must be sticky at the top');
    assert.match(SEARCH, /max-height:\s*70dvh/,
        'mobile dropdown max-height must use dvh (keyboard/toolbar aware)');
});

// ─────────────────────────────────────────────────────────────────────────────
// S3.1 — cart sticky checkout bar
// ─────────────────────────────────────────────────────────────────────────────

test('S3.1 cart.html ships a sticky checkout bar reusing the checkout delegation', () => {
    assert.match(CART_HTML, /id="cart-sticky-bar"/, 'cart sticky bar markup missing');
    assert.match(CART_HTML, /id="cart-sticky-total"/, 'cart sticky bar needs a total element');
    // CTA must wear .cart-summary__checkout-btn so cart.js validation runs.
    assert.match(CART_HTML, /id="cart-sticky-checkout"[^>]*class="[^"]*cart-summary__checkout-btn/,
        'sticky CTA must carry .cart-summary__checkout-btn to reuse the validate-then-checkout delegation');
});

test('S3.1 the sticky bar is mobile-only, safe-area aware, and JS-driven by an IntersectionObserver', () => {
    assert.match(PAGES, /\.cart-sticky-bar\s*\{[\s\S]*?position:\s*fixed/, 'cart-sticky-bar must be position:fixed');
    assert.match(PAGES, /\.cart-sticky-bar\s*\{[\s\S]*?env\(safe-area-inset-bottom/,
        'cart-sticky-bar must honour env(safe-area-inset-bottom) (S0.8)');
    assert.match(PAGES, /@media \(max-width: 768px\)[\s\S]*\.cart-sticky-bar\s*\{[\s\S]*?display:\s*block/,
        'cart-sticky-bar is mobile-only');
    assert.match(CART_PAGE_JS, /function initStickyCheckoutBar/, 'cart-page.js must define initStickyCheckoutBar');
    assert.match(CART_PAGE_JS, /IntersectionObserver/, 'sticky bar must be IntersectionObserver-driven');
});

// ─────────────────────────────────────────────────────────────────────────────
// S3.2 — coupon entry UI wired to the existing preview/apply API
// ─────────────────────────────────────────────────────────────────────────────

test('S3.2 cart.html exposes a "Have a coupon?" disclosure with an input + apply', () => {
    assert.match(CART_HTML, /id="cart-coupon-form"/, 'coupon form missing');
    assert.match(CART_HTML, /id="cart-coupon-input"/, 'coupon input missing');
    assert.match(CART_HTML, /Have a coupon\?/, 'coupon disclosure summary missing');
    assert.match(CART_HTML, /aria-live="polite"/, 'coupon feedback must be an aria-live region');
});

test('S3.2 cart-page.js wires preview (idle/blur) + apply (submit)', () => {
    assert.match(CART_PAGE_JS, /function initCouponForm/, 'initCouponForm missing');
    assert.match(CART_PAGE_JS, /API\.previewCoupon/, 'must call API.previewCoupon for inline validation');
    assert.match(CART_PAGE_JS, /API\.applyCoupon/, 'must call API.applyCoupon on submit');
});

// ─────────────────────────────────────────────────────────────────────────────
// S0.3 — category-without-brand renders a brand picker, not an error
// ─────────────────────────────────────────────────────────────────────────────

test('S0.3 a category-only URL routes to the brand picker (level=brands), not the chip grid', () => {
    // category && brand → codes; category alone → brands.
    assert.match(SHOP_PAGE_JS, /this\.state\.category && this\.state\.brand\)\s*\{\s*this\.state\.level = 'codes'/,
        'brand+category must still drill into codes');
    assert.match(SHOP_PAGE_JS, /else if \(this\.state\.category\)\s*\{[\s\S]*?this\.state\.level = 'brands'/,
        'category alone must show the brand picker');
});

test('S0.3 the brand picker re-labels the section and routes tile clicks to brand+category codes', () => {
    assert.match(SHOP_PAGE_JS, /Choose a brand to see/, 'category picker needs a contextual heading');
    assert.match(SHOP_PAGE_JS, /navigateTo\('codes', \{ brand: brandId, category: this\.state\.category \}\)/,
        'category-picker tile must navigate to codes carrying both brand and category');
    // navigateTo must honour data.brand for the codes case (was this.state.brand only).
    assert.match(SHOP_PAGE_JS, /case 'codes':[\s\S]*?brand:\s*data\.brand \|\| this\.state\.brand/,
        'navigateTo codes case must honour an explicitly-passed brand');
});

// ─────────────────────────────────────────────────────────────────────────────
// S0.5 — footer link columns collapse into accordions on mobile
// ─────────────────────────────────────────────────────────────────────────────

test('S0.5 footer columns are <details> accordions, expanded on desktop / collapsible on mobile', () => {
    assert.match(FOOTER_JS, /<details class="footer-column" data-footer-accordion open>/,
        'first footer column should be an open <details>');
    assert.match(FOOTER_JS, /<summary class="footer-column__heading">Contact<\/summary>/,
        'footer headings should be <summary>');
    assert.match(FOOTER_JS, /function syncFooterAccordions/, 'footer.js must manage open state by viewport');
    assert.match(LAYOUT, /summary\.footer-column__heading\s*\{[\s\S]*?list-style:\s*none/,
        'summary marker should be reset');
    assert.match(LAYOUT, /@media \(max-width: 768px\)[\s\S]*summary\.footer-column__heading[\s\S]*?min-height:\s*44px/,
        'mobile footer summary must be a 44px tap target');
});

// ─────────────────────────────────────────────────────────────────────────────
// S2.4 / S0.11 — polish
// ─────────────────────────────────────────────────────────────────────────────

test('S2.4 the PDP breadcrumb current item (duplicates the H1) is hidden at <=480', () => {
    assert.match(PAGES, /@media \(max-width: 480px\)[\s\S]*#breadcrumb-product\s*\{[\s\S]*?display:\s*none/,
        '#breadcrumb-product must be hidden on phones (it repeats the H1)');
});

test('S0.11 the desktop scrollbar gutter is released on mobile', () => {
    assert.match(PAGES, /@media \(max-width: 768px\)[\s\S]*html\s*\{[\s\S]*?overflow-y:\s*auto/,
        'html overflow-y should be auto on mobile to reclaim the gutter');
});

test('S0.8 the PDP and cart opt into the safe-area via viewport-fit=cover', () => {
    assert.match(PRODUCT_HTML, /viewport-fit=cover/, 'PDP viewport must enable safe-area insets');
    assert.match(CART_HTML, /viewport-fit=cover/, 'cart viewport must enable safe-area insets');
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARDS — audit findings that were ALREADY done and must stay done
// ─────────────────────────────────────────────────────────────────────────────

test('S0.2 (regression) the runtime PDP title carries no "Save up to 70%" / forbidden suffix', () => {
    const forbidden = /save up to|70%|lowest|guaranteed|hurry/i;
    // The computed title template lives in product-detail-page.js.
    const titleLines = PDP_JS.split('\n').filter((l) => /document\.title|computedTitle|seo\.title/.test(l));
    for (const line of titleLines) {
        assert.ok(!forbidden.test(line), `PDP title line contains a forbidden Google-Ads token: ${line.trim()}`);
    }
    assert.match(PDP_JS, /NZ \| InkCartridges\.co\.nz/, 'PDP title should use the locked-in "<name> NZ | InkCartridges.co.nz" pattern');
});

test('S0.7 (regression) the PDP keeps its mobile sticky add-to-cart bar', () => {
    assert.match(PRODUCT_HTML, /id="sticky-atc"/, 'PDP sticky add-to-cart markup must remain');
    assert.match(PAGES, /\.sticky-atc\s*\{[\s\S]*?position:\s*fixed/, '.sticky-atc must stay position:fixed');
    assert.match(PAGES, /@media \(max-width: 768px\)[\s\S]*\.sticky-atc\s*\{[\s\S]*?display:\s*block/, '.sticky-atc is mobile-only');
});

test('S1.4 (regression) the per-card COMPATIBLE/GENUINE source chip stays removed from list cards', () => {
    assert.ok(!/getSourceBadge/.test(PRODUCTS_JS),
        'products.js must not reintroduce getSourceBadge — the per-card source chip was retired (source-chip-removal-may2026)');
    assert.ok(!/product-card__badge--(compatible|genuine)/.test(PRODUCTS_JS),
        'products.js must not render a per-card source-chip badge');
});
