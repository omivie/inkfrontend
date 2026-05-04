/**
 * Product-card title line-clamp contract
 * =======================================
 *
 * Pin every product-card / product-box title clamp at THREE lines.
 *
 * Background: long compatible-cartridge names ("Compatible Ink Cartridge
 * Replacement for Epson 81N Light Cyan …") were being truncated at two
 * lines, which dropped the SKU and made cards in the same row visually
 * indistinguishable. The fix bumps every clamp to 3 lines and the
 * matching min-height calc on the search-page card so card heights stay
 * consistent.
 *
 * If anyone re-introduces a 2-line clamp (or forgets to bump the
 * min-height multiplier), these tests fail.
 *
 * Run with: node --test tests/product-card-title-clamp.test.js
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
 * Extract the body of the first CSS rule matching `selector` (literal,
 * not regex). Returns the text between `{` and the matching `}`.
 */
function ruleBody(css, selector) {
    const idx = css.indexOf(selector);
    assert.ok(idx !== -1, `selector not found: ${selector}`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    assert.ok(open !== -1 && close !== -1, `unterminated rule: ${selector}`);
    return css.slice(open + 1, close);
}

function clampValue(body) {
    const m = body.match(/-webkit-line-clamp\s*:\s*(\d+)/);
    return m ? Number(m[1]) : null;
}

// ─── Product card titles (catalog grids, search results, smart dropdown) ────

test('components.css — .product-card__title clamps to 3 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.product-card__title {');
    assert.equal(clampValue(body), 3, 'main product-card title must clamp at 3');
});

test('pages.css — .product-card__title (search-page override) clamps to 3 lines', () => {
    const css = loadCss('pages.css');
    // pages.css contains a .product-card__title override scoped to the
    // search/shop list view. Find it by looking for the min-height calc
    // so we don't collide with components.css definitions if the build
    // ever inlines them.
    const idx = css.indexOf('min-height: calc(var(--font-size-xs)');
    assert.ok(idx !== -1, 'expected pages.css min-height calc anchor');
    const ruleStart = css.lastIndexOf('.product-card__title', idx);
    const open = css.indexOf('{', ruleStart);
    const close = css.indexOf('}', open);
    const body = css.slice(open + 1, close);
    assert.equal(clampValue(body), 3, 'search-page product-card title must clamp at 3');
    assert.match(
        body,
        /min-height:\s*calc\(var\(--font-size-xs\)\s*\*\s*1\.3\s*\*\s*3\)/,
        'min-height multiplier must match the 3-line clamp',
    );
});

test('search.css — .smart-ac__grid .product-card__title clamps to 3 lines', () => {
    const css = loadCss('search.css');
    const body = ruleBody(css, '.smart-ac__grid .product-card__title {');
    assert.equal(clampValue(body), 3, 'dropdown grid product card title must clamp at 3');
});

// ─── Product list / box titles (legacy product-box variant) ────────────────

test('pages.css — .product-box__title clamps to 3 lines', () => {
    const css = loadCss('pages.css');
    const body = ruleBody(css, '.product-box__title {');
    assert.equal(clampValue(body), 3);
});

// ─── Smart autocomplete row title (list view, not grid) ────────────────────

test('search.css — .smart-ac__name clamps to 3 lines', () => {
    const css = loadCss('search.css');
    const body = ruleBody(css, '.smart-ac__name {');
    assert.equal(clampValue(body), 3);
});

// ─── Cross-sell modal product list ─────────────────────────────────────────

test('components.css — .crosssell-modal__name clamps to 3 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.crosssell-modal__name {');
    assert.equal(clampValue(body), 3);
});

// ─── Favourites grid (account/favourites) ──────────────────────────────────

test('components.css — .favourite-item__name clamps to 3 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.favourite-item__name {');
    assert.equal(clampValue(body), 3);
});

test('pages.css — .dash-fav-card__name clamps to 3 lines', () => {
    const css = loadCss('pages.css');
    const body = ruleBody(css, '.dash-fav-card__name {');
    assert.equal(clampValue(body), 3);
});

// ─── Sanity check: no orphan 2-line clamps left in product-card scopes ─────

test('no .product-card / .product-box / .smart-ac selector still clamps at 2 lines', () => {
    const files = ['components.css', 'pages.css', 'search.css'];
    for (const file of files) {
        const css = loadCss(file);
        // Walk every selector block and flag any product-facing card that
        // still says line-clamp: 2. We allow .smart-ac__grid sub-selectors
        // that don't touch the title (none currently use clamp).
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = ruleRe.exec(css)) !== null) {
            const selector = m[1].trim();
            const body = m[2];
            if (!/-webkit-line-clamp\s*:\s*2\b/.test(body)) continue;
            const productFacing = /\b(product-card|product-box|smart-ac__name|smart-ac__grid|favourite-item|dash-fav-card|crosssell-modal__name)\b/.test(
                selector,
            );
            assert.ok(
                !productFacing,
                `${file}: product-facing rule still clamps at 2 lines → ${selector}`,
            );
        }
    }
});
