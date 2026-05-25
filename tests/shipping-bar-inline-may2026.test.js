/**
 * Shipping bar inline-with-breadcrumb contract — May 2026
 * ========================================================
 *
 * On /shop, the "Free shipping on orders over $100 • Fast NZ-wide delivery"
 * pill must live INSIDE .drilldown-header alongside the breadcrumb so the
 * H1 lifts up and the top-right corner of the page is no longer empty
 * whitespace.
 *
 * Background: previously the pill was a standalone .shipping-info-bar
 * sibling that sat below .drilldown-header AND below the H1, eating ~40px
 * of vertical real-estate above the product grid for no information gain
 * (the breadcrumb row had a wide empty right side it could have used).
 *
 * What this file pins
 * -------------------
 *  §1 The shop.html shipping pill is a child of .drilldown-header (via
 *     .drilldown-header__right-group), NOT a sibling sitting below it,
 *     and NOT below the <h1>.
 *  §2 The pill carries the .shipping-info-bar--inline modifier so it
 *     picks up the compact padding / zero-margin variant.
 *  §3 The new .drilldown-header__right-group wrapper exists in CSS with
 *     margin-left:auto so it pushes the pill to the right side.
 *  §4 The .shipping-info-bar--inline base rule exists in CSS with
 *     margin: 0 (so it does NOT re-add the standalone-variant air).
 *  §5 There is exactly ONE shipping-info-bar in shop.html (no duplicate
 *     leftover from the move).
 *  §6 The pages.css cache-bust on shop.html includes the
 *     "shipping-inline-may2026" key so deployed clients refetch.
 *  §7 Mobile (≤480px) collapses the right-group + pill to full-width so
 *     they don't sit stranded right-aligned on a narrow viewport.
 *
 * Run with: node --test tests/shipping-bar-inline-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHOP_HTML_PATH = path.join(ROOT, 'inkcartridges', 'html', 'shop.html');
const PAGES_CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'pages.css');

const SHOP_HTML = fs.readFileSync(SHOP_HTML_PATH, 'utf8');
const PAGES_CSS = fs.readFileSync(PAGES_CSS_PATH, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// §1–2 + §5  shop.html structure
// ─────────────────────────────────────────────────────────────────────────────

test('§1 shipping pill lives INSIDE .drilldown-header (not as a standalone sibling)', () => {
    const headerOpen = SHOP_HTML.indexOf('<div class="drilldown-header">');
    assert.notEqual(headerOpen, -1, '.drilldown-header must exist on /shop');
    const titleStart = SHOP_HTML.indexOf('<h1 class="drilldown-title"', headerOpen);
    assert.notEqual(titleStart, -1, '<h1 class="drilldown-title"> must follow .drilldown-header');

    const headerBlock = SHOP_HTML.slice(headerOpen, titleStart);
    assert.match(
        headerBlock,
        /shipping-info-bar/,
        'shop.html shipping pill must be a descendant of .drilldown-header so it sits to the right of the breadcrumb'
    );
    assert.match(
        headerBlock,
        /drilldown-header__right-group/,
        '.drilldown-header__right-group wrapper must hold the yield banner + inline shipping pill'
    );
});

test('§1 shipping pill is NOT a standalone block below the H1 any more', () => {
    const titleEnd = SHOP_HTML.indexOf('</h1>');
    assert.notEqual(titleEnd, -1, '<h1>…</h1> must exist');
    const sectionStart = SHOP_HTML.indexOf('<section class="drilldown-content"', titleEnd);
    assert.notEqual(sectionStart, -1, '<section class="drilldown-content"> must follow the H1');
    const between = SHOP_HTML.slice(titleEnd, sectionStart);
    assert.doesNotMatch(
        between,
        /shipping-info-bar/,
        'standalone .shipping-info-bar between <h1> and <section> must be removed — pill now lives inline in the header'
    );
});

test('§2 the moved pill carries the --inline modifier', () => {
    assert.match(
        SHOP_HTML,
        /class="shipping-info-bar shipping-info-bar--inline"/,
        'inline pill must carry both .shipping-info-bar and .shipping-info-bar--inline'
    );
});

test('§5 exactly one shipping-info-bar element on /shop (no dup left behind)', () => {
    const hits = SHOP_HTML.match(/class="[^"]*shipping-info-bar[^"]*"/g) || [];
    assert.equal(
        hits.length,
        1,
        `expected exactly 1 .shipping-info-bar element on /shop; found ${hits.length}: ${JSON.stringify(hits)}`
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §3–4  CSS contract
// ─────────────────────────────────────────────────────────────────────────────

test('§3 .drilldown-header__right-group exists with margin-left:auto', () => {
    const rule = PAGES_CSS.match(/\.drilldown-header__right-group\s*\{[^}]*\}/);
    assert.ok(rule, '.drilldown-header__right-group rule must exist in pages.css');
    assert.match(
        rule[0],
        /margin-left:\s*auto/,
        '.drilldown-header__right-group must use margin-left:auto so the pill pushes to the right'
    );
    assert.match(
        rule[0],
        /flex-wrap:\s*wrap/,
        '.drilldown-header__right-group must wrap so it falls below the breadcrumb on narrow viewports'
    );
});

test('§4 .shipping-info-bar--inline base rule kills standalone vertical margin', () => {
    // The BASE rule lives outside any @media block; responsive overrides
    // appear in @media (max-width: 768px) and 480px without margin: 0.
    const rules = [...PAGES_CSS.matchAll(/\.shipping-info-bar--inline\s*\{[^}]*\}/g)].map((m) => m[0]);
    const baseRule = rules.find((r) => /margin:\s*0/.test(r));
    assert.ok(
        baseRule,
        '.shipping-info-bar--inline base rule must exist with margin:0 — parent .drilldown-header owns vertical rhythm'
    );
});

test('§4 the standalone .shipping-info-bar still keeps its 12px/20px margin', () => {
    // Non-inline usage (if anyone re-adds it elsewhere) must remain a
    // self-spaced block.
    const baseMatch = PAGES_CSS.match(/\.shipping-info-bar\s*\{[^}]*\}/);
    assert.ok(baseMatch, 'base .shipping-info-bar rule must still exist');
    assert.match(
        baseMatch[0],
        /margin:\s*12px\s+0\s+20px/,
        'base .shipping-info-bar must keep its 12px 0 20px margin for any standalone usage'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §6  Cache-bust
// ─────────────────────────────────────────────────────────────────────────────

test('§6 shop.html pages.css link uses the current cache key', () => {
    // The cache key rides forward with every CSS rollout — it was
    // shipping-inline-may2026 when the inline bar shipped; the 4-line
    // title clamp release bumped it; stock-enquiry-may2026 bumped it
    // again; mobile-parity-may2026 bumped it for the mobile-parity audit;
    // buybox-may2026 bumped it when the four-row PDP buy-box landed.
    // The guarantee is that shop.html requests the *current* pages.css
    // build so deployed clients refetch.
    assert.match(
        SHOP_HTML,
        /pages\.css\?v=buybox-may2026/,
        'shop.html must cache-bust pages.css with the current key so deployed clients pull the new rules'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §7  Mobile guard
// ─────────────────────────────────────────────────────────────────────────────

test('§7 mobile (≤480px) collapses the right-group + pill to full-width', () => {
    // Find the 480px @media block that contains the .drilldown-header
    // overrides — there are several 480px blocks in the file, we want the
    // shop-page one specifically.
    const blocks = [...PAGES_CSS.matchAll(/@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/g)];
    const dropdownBlock = blocks
        .map((m) => m[1])
        .find((body) => /\.drilldown-header__right-group/.test(body));
    assert.ok(dropdownBlock, '480px @media block containing .drilldown-header__right-group must exist');
    assert.match(
        dropdownBlock,
        /\.drilldown-header__right-group\s*\{[^}]*width:\s*100%/,
        '.drilldown-header__right-group must be width:100% under the 480px breakpoint'
    );
    assert.match(
        dropdownBlock,
        /\.shipping-info-bar--inline\s*\{[^}]*width:\s*100%/,
        '.shipping-info-bar--inline must be width:100% under the 480px breakpoint'
    );
});

test('tablet (≤768px) collapses right-group to full-width when wrapped', () => {
    const blocks = [...PAGES_CSS.matchAll(/@media \(max-width: 768px\)\s*\{([\s\S]*?)\n\}/g)];
    const tabletBlock = blocks
        .map((m) => m[1])
        .find((body) => /\.drilldown-header__right-group/.test(body));
    assert.ok(tabletBlock, '768px @media block containing .drilldown-header__right-group must exist');
    assert.match(
        tabletBlock,
        /\.drilldown-header__right-group\s*\{[^}]*width:\s*100%/,
        'on tablets, .drilldown-header__right-group must collapse to width:100% so the pill is not stranded right-aligned'
    );
});
