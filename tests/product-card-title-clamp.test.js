/**
 * Product-card title line-clamp contract
 * =======================================
 *
 * Pin every product-card / product-box title clamp at FOUR lines.
 *
 * Background: long compatible-cartridge names ("Compatible Ink Cartridge
 * Replacement for Epson 81N Light Cyan …") and verbose genuine names
 * ("OKI Genuine MB451HYBK Toner Cartridge MB451HY High-Yield …") were
 * being truncated at three lines, which dropped the trailing SKU /
 * yield / page-count and forced a hover to read the full name. The fix
 * bumps every clamp to 4 lines and the matching min-height calc on the
 * search-page card so card heights stay consistent across a row.
 *
 * If anyone re-introduces a 2- or 3-line clamp (or forgets to bump the
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

test('components.css — .product-card__title clamps to 4 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.product-card__title {');
    assert.equal(clampValue(body), 4, 'main product-card title must clamp at 4');
});

test('pages.css — .product-card__title (search-page override) clamps to 4 lines', () => {
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
    assert.equal(clampValue(body), 4, 'search-page product-card title must clamp at 4');
    assert.match(
        body,
        /min-height:\s*calc\(var\(--font-size-xs\)\s*\*\s*1\.3\s*\*\s*4\)/,
        'min-height multiplier must match the 4-line clamp',
    );
});

test('pages.css — .product-card__title reveals the full name on hover', () => {
    const css = loadCss('pages.css');
    const body = ruleBody(css, '.product-card:hover .product-card__title {');
    assert.match(
        body,
        /-webkit-line-clamp\s*:\s*unset/,
        'hover must lift the clamp so the whole name is readable',
    );
});

test('search.css — .smart-ac__grid .product-card__title clamps to 4 lines', () => {
    const css = loadCss('search.css');
    const body = ruleBody(css, '.smart-ac__grid .product-card__title {');
    assert.equal(clampValue(body), 4, 'dropdown grid product card title must clamp at 4');
});

// ─── Product list / box titles (legacy product-box variant) ────────────────

test('pages.css — .product-box__title clamps to 4 lines', () => {
    const css = loadCss('pages.css');
    const body = ruleBody(css, '.product-box__title {');
    assert.equal(clampValue(body), 4);
});

// ─── Smart autocomplete row title (list view, not grid) ────────────────────

test('search.css — .smart-ac__name clamps to 4 lines', () => {
    const css = loadCss('search.css');
    const body = ruleBody(css, '.smart-ac__name {');
    assert.equal(clampValue(body), 4);
});

// ─── Cross-sell modal product list ─────────────────────────────────────────

test('components.css — .crosssell-modal__name clamps to 4 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.crosssell-modal__name {');
    assert.equal(clampValue(body), 4);
});

// ─── Favourites grid (account/favourites) ──────────────────────────────────

test('components.css — .favourite-item__name clamps to 4 lines', () => {
    const css = loadCss('components.css');
    const body = ruleBody(css, '.favourite-item__name {');
    assert.equal(clampValue(body), 4);
});

test('pages.css — .dash-fav-card__name clamps to 4 lines', () => {
    const css = loadCss('pages.css');
    const body = ruleBody(css, '.dash-fav-card__name {');
    assert.equal(clampValue(body), 4);
});

// ─── Sanity check: no orphan 2/3-line clamps left in product-card scopes ───

test('no .product-card / .product-box / .smart-ac selector still clamps below 4 lines', () => {
    const files = ['components.css', 'pages.css', 'search.css'];
    for (const file of files) {
        const css = loadCss(file);
        // Walk every selector block and flag any product-facing card that
        // still clamps below 4 lines. We allow .smart-ac__grid sub-selectors
        // that don't touch the title (none currently use clamp).
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = ruleRe.exec(css)) !== null) {
            const selector = m[1].trim();
            const body = m[2];
            if (!/-webkit-line-clamp\s*:\s*[23]\b/.test(body)) continue;
            const productFacing = /\b(product-card|product-box|smart-ac__name|smart-ac__grid|favourite-item|dash-fav-card|crosssell-modal__name)\b/.test(
                selector,
            );
            assert.ok(
                !productFacing,
                `${file}: product-facing rule clamps below 4 lines → ${selector}`,
            );
        }
    }
});

// ─── Cache-bust: every HTML page must request the bumped CSS build ─────────

// The three card CSS files share one rollout token. It advances whenever any
// of them changes; stock-enquiry-may2026 superseded 4line-clamp-may2026 when
// the out-of-stock pill copy update touched components.css. mobile-parity-may2026
// superseded it when the mobile-parity audit touched all three card CSS files.
// buybox-may2026 superseded it when the four-row PDP buy-box landed in pages.css.
// loading-spinner-jun2026 superseded it when the loading-state rework reshaped the
// product-card skeletons (pages.css) and normalised all three card CSS files.
// track-lookup-inline-jun2026 superseded it when the inline order-tracking
// rework added the .tracking-detail/.tracking-note display rules to pages.css.
test('all HTML pages agree on ONE cache token for the three card CSS files', () => {
    const htmlRoot = path.join(ROOT, 'inkcartridges');
    const htmlFiles = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(full);
            } else if (entry.name.endsWith('.html')) {
                htmlFiles.push(full);
            }
        }
    })(htmlRoot);

    // The real invariant is that the three card CSS files resolve to ONE token across
    // all pages — not that the token still equals this feature's era literal
    // (CARD_CSS_TOKEN), which every later CSS release necessarily invalidates.
    // Derive the expected token from the pages themselves: whatever the majority use,
    // every page must agree with. (Sitewide, for every asset: asset-cache-tokens §1.)
    const seen = {};
    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, 'utf8');
        for (const cssName of ['components.css', 'pages.css', 'search.css']) {
            const re = new RegExp(`${cssName}\\?v=([a-zA-Z0-9-]+)`, 'g');
            let m;
            while ((m = re.exec(html)) !== null) {
                (seen[cssName] ||= {});
                (seen[cssName][m[1]] ||= []).push(path.relative(ROOT, file));
            }
        }
    }

    const stale = [];
    for (const [cssName, byTok] of Object.entries(seen)) {
        const toks = Object.entries(byTok).sort((a, b) => b[1].length - a[1].length);
        const [canonical] = toks[0];
        for (const [tok, files] of toks.slice(1)) {
            for (const f of files) stale.push(`${f} → ${cssName}?v=${tok} (rest of the site is on v=${canonical})`);
        }
    }
    assert.deepEqual(stale, [],
        `These pages disagree with the rest of the site on a CSS cache token — someone bumped\n`
        + `some references and missed these, so they will serve stale CSS:\n${stale.join('\n')}`);
});
