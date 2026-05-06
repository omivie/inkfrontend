/**
 * Product-image background contract — May 2026
 * =============================================
 *
 * Every surface that paints a region BEHIND a cartridge photo must
 * resolve to pure white (`#FFFFFF`). The contract is enforced through
 * a single CSS variable, `--product-image-bg`, defined in base.css and
 * referenced by every product-image rule across the storefront.
 *
 * Background: prior to this fix the various surfaces leaned on
 * `--off-white` (`#F9F9F9`), `--steel-50` (`#F8FAFC`), or
 * `--color-background-alt` (also `#F8FAFC`). Cartridge photos are
 * shipped as transparent-PNG / white-bg JPGs, so the slightly grey
 * tile read as a "white box inside a grey frame" — exactly the
 * bug the screenshot in the May 2026 ticket called out.
 *
 * If anyone re-introduces a grey background on a product-image
 * surface (or breaks the variable wiring), these tests fail.
 *
 * Run with: node --test tests/product-image-bg-white.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS_DIR = path.join(ROOT, 'inkcartridges', 'css');

function loadCss(file) {
    return fs.readFileSync(path.join(CSS_DIR, file), 'utf8');
}

/**
 * Find every rule whose selector ends with the literal anchor
 * (`<selector> {`) and return the body of the first one that declares
 * a background. Some selectors appear multiple times in a stylesheet
 * (e.g. an aspect-ratio override on `.product-card__image-wrapper`
 * inside `.related-products__grid` plus the canonical card rule that
 * paints the background) — we want the painter, not the geometry-only
 * override.
 */
function ruleBody(css, anchor) {
    let from = 0;
    let lastBody = null;
    while (true) {
        const idx = css.indexOf(anchor, from);
        if (idx === -1) break;
        const open = css.indexOf('{', idx);
        const close = css.indexOf('}', open);
        if (open === -1 || close === -1) break;
        const body = css.slice(open + 1, close);
        lastBody = body;
        if (/background(?:-color)?\s*:/.test(body)) return body;
        from = close + 1;
    }
    assert.ok(lastBody !== null, `anchor not found: ${anchor}`);
    return lastBody;
}

function backgroundValue(body) {
    const m = body.match(/background(?:-color)?\s*:\s*([^;]+);/);
    return m ? m[1].trim() : null;
}

// ─── 1. The variable itself must resolve to white ─────────────────────────

test('base.css — defines --product-image-bg as pure white', () => {
    const css = loadCss('base.css');
    // Must define the variable.
    assert.match(
        css,
        /--product-image-bg\s*:\s*var\(--white-primary\)\s*;/,
        '--product-image-bg must alias --white-primary',
    );
    // And --white-primary must still be #FFFFFF.
    assert.match(
        css,
        /--white-primary\s*:\s*#FFFFFF\s*;/i,
        '--white-primary must remain pure white',
    );
});

// ─── 2. Every product-image surface uses the variable ─────────────────────

const SURFACES = [
    // [css file, selector anchor, human label]
    ['components.css', '.product-card__image-wrapper {',                       'shop / search / related card image'],
    ['components.css', '.favourite-item__image {',                             'favourites grid card image'],
    ['pages.css',      '.product-card__image-wrapper {',                       'shop-page card image (pages.css override)'],
    ['pages.css',      '.dash-fav-card__image {',                              'dashboard favourites image'],
    ['pages.css',      '.product-box__image {',                                'legacy product-box image'],
    ['pages.css',      '.cart-item__image {',                                  'cart line-item image'],
    ['pages.css',      '.product-gallery__main {',                             'PDP gallery main (default)'],
    ['pages.css',      '.product-detail__layout .product-gallery__main {',    'PDP gallery main (scoped layout)'],
    ['pages.css',      '.product-gallery__thumb {',                            'PDP gallery thumb'],
    ['pages.css',      '.order-item__image {',                                 'order detail line-item image'],
    ['pages.css',      '.checkout-summary__item-image {',                      'checkout summary line-item image'],
    ['search.css',     '.smart-ac__grid .product-card--skeleton .product-card__image-wrapper {', 'smart-AC dropdown skeleton card'],
];

for (const [file, anchor, label] of SURFACES) {
    test(`${file} — ${label} uses var(--product-image-bg)`, () => {
        const css = loadCss(file);
        const body = ruleBody(css, anchor);
        const bg = backgroundValue(body);
        assert.ok(bg, `${anchor} must declare a background`);
        assert.equal(
            bg,
            'var(--product-image-bg)',
            `${anchor} must paint via --product-image-bg, got: ${bg}`,
        );
    });
}

// ─── 3. Sanity: no product-image rule sneaks back in with a grey tile ─────

test('no product-image surface paints --off-white / --steel-50 / --color-background-alt', () => {
    // Only the product-image scopes — section backgrounds, badges, and
    // chrome may legitimately use the grey tokens.
    const PRODUCT_IMAGE_SCOPES = /\b(product-card__image-wrapper|favourite-item__image|dash-fav-card__image|product-box__image|cart-item__image|product-gallery__main|product-gallery__thumb|order-item__image|checkout-summary__item-image)\b/;
    const FORBIDDEN_TOKENS = /var\(--off-white\)|var\(--steel-50\)|var\(--color-background-alt\)|#f7fafc|#f8fafc|#f9f9f9/i;

    const files = ['base.css', 'components.css', 'pages.css', 'layout.css', 'search.css', 'modern-effects.css', 'checkout-compact.css'];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;

    for (const file of files) {
        const css = loadCss(file);
        let m;
        while ((m = ruleRe.exec(css)) !== null) {
            const selector = m[1].trim();
            const body = m[2];
            if (!PRODUCT_IMAGE_SCOPES.test(selector)) continue;
            const bgMatch = body.match(/background(?:-color)?\s*:\s*([^;]+);/);
            if (!bgMatch) continue;
            const value = bgMatch[1];
            assert.ok(
                !FORBIDDEN_TOKENS.test(value),
                `${file}: product-image rule reverts to grey → ${selector.slice(0, 80)} { background: ${value} }`,
            );
        }
    }
});
