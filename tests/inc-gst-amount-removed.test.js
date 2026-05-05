/**
 * Inc. GST $X.XX dollar-breakdown removal — May 2026
 * ─────────────────────────────────────────────────────────────
 * The old PDP + product-card surfaces rendered both:
 *   • a "Incl. GST" trust badge (HTML), and
 *   • a JS-injected "Inc. GST $X.XX" dollar breakdown.
 *
 * Two labels saying the same thing is visual noise. The dollar breakdown
 * was removed; the "Incl. GST" copy is now the single GST trust signal
 * across the storefront.
 *
 * This file is the authoritative pin — if a future refactor re-adds
 * "Inc. GST $..." to any of these renderers, the build fails here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const PDP_JS    = path.join(ROOT, 'js', 'product-detail-page.js');
const PRODUCTS  = path.join(ROOT, 'js', 'products.js');
const SHOP_JS   = path.join(ROOT, 'js', 'shop-page.js');
const PDP_HTML  = path.join(ROOT, 'html', 'product', 'index.html');
const COMPONENTS_CSS = path.join(ROOT, 'css', 'components.css');

// Surfaces that must not regress.
const RENDERERS = [
    { label: 'PDP renderer (product-detail-page.js)', file: PDP_JS },
    { label: 'card renderer (products.js)',           file: PRODUCTS },
    { label: 'shop card renderer (shop-page.js)',     file: SHOP_JS },
];

// Match every dollar-breakdown shape we can think of, so that re-adding
// the line in a slightly different format still trips the guard.
//   "Inc. GST $5.99"
//   "Inc. GST ${formatPrice(...)}"
//   "Inc GST $5.99"
//   "inc. gst $5.99"
const DOLLAR_BREAKDOWN_RE = /Inc\.?\s*GST\s*\$/i;

for (const { label, file } of RENDERERS) {
    test(`${label} — no "Inc. GST $..." dollar breakdown`, () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(src, DOLLAR_BREAKDOWN_RE,
            `${file} must not render the legacy "Inc. GST $X.XX" dollar breakdown`);
    });
}

test('PDP HTML keeps the "Incl. GST" trust badge beside the price', () => {
    const html = fs.readFileSync(PDP_HTML, 'utf8');
    assert.match(html, /class="product-info__gst">Incl\. GST</,
        'PDP must continue to render the static "Incl. GST" badge');
});

test('PDP renderer does not inject the legacy product-detail__gst-line span', () => {
    const src = fs.readFileSync(PDP_JS, 'utf8');
    assert.doesNotMatch(src, /product-detail__gst-line/,
        'product-detail__gst-line was removed; PDP must not re-inject it');
});

test('Card renderers ship a static "Incl. GST" trust label', () => {
    for (const { label, file } of RENDERERS.filter(r => r.file !== PDP_JS)) {
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /Incl\. GST/,
            `${label} must keep the "Incl. GST" trust label on cards`);
    }
});

test('CSS no longer carries the orphan .product-detail__gst-line rule', () => {
    const css = fs.readFileSync(COMPONENTS_CSS, 'utf8');
    assert.doesNotMatch(css, /\.product-detail__gst-line\s*\{/,
        '.product-detail__gst-line was removed in May 2026; do not re-add');
});

test('Card renderers no longer compute a per-card gst_amount', () => {
    // Backend still ships gst_amount (additive — checkout uses it). But the
    // card renderers stopped reading it when the dollar breakdown was
    // dropped, so a fresh "const gstAmount = ..." line on a card path is a
    // signal someone is re-adding the old UI.
    for (const { label, file } of RENDERERS.filter(r => r.file !== PDP_JS)) {
        const src = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(src, /const\s+gstAmount\s*=/,
            `${label} must not re-introduce a per-card gstAmount calculation`);
    }
});
