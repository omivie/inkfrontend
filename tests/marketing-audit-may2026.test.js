/**
 * Marketing audit — May 2026
 * ==========================
 *
 * Pins the storefront half of the May 16 2026 backend release described in
 * `marketing-audit-may-2026.md` (technical SEO + CRO data hooks). The release
 * is fully additive on the API side; this file guards the five frontend
 * actions it asked for so a later refactor cannot silently undo them.
 *
 * §1  Four new product-detail fields wired to CRO copy
 *   §1.1  cost_per_page_display — value anchor under the price (PDP + card)
 *   §1.2  stock_urgency / stock_urgency_label — genuine-only scarcity cue
 *   §1.3  is_oem_verified — "Verified genuine product image" trust badge
 *   §1.4  compatible_printers_grouped — collapses 40-printer dumps
 *
 * §2  compatible_printers[] now carries slug + brand_slug — the PDP builds
 *     printer-hub deep links (/shop?brand=…&printer_slug=…) from them.
 *
 * §3  WebP image migration — isPlaceholderSwatchImage must detect a swatch
 *     whose extension changed from .png to .webp.
 *
 * §4  Prerender JSON-LD — the PDP must NOT emit client-side Product /
 *     BreadcrumbList / FAQPage JSON-LD (the backend prerender layer is the
 *     single source). middleware.js must route AdsBot / StoreBot to that
 *     prerender layer so the removal is safe for every Google crawler.
 *
 * Static-source assertions are deliberate: they pin the *contract shape* in
 * the renderers, which is what regresses, and they run without a DOM.
 *
 * Run with: node --test tests/marketing-audit-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const PDP_JS   = path.join(ROOT, 'js', 'product-detail-page.js');
const PRODUCTS = path.join(ROOT, 'js', 'products.js');
const UTILS    = path.join(ROOT, 'js', 'utils.js');
const PDP_HTML = path.join(ROOT, 'html', 'product', 'index.html');
const MIDDLEWARE = path.join(ROOT, 'middleware.js');
const COMPONENTS_CSS = path.join(ROOT, 'css', 'components.css');

const pdpSrc        = fs.readFileSync(PDP_JS, 'utf8');
const productsSrc   = fs.readFileSync(PRODUCTS, 'utf8');
const pdpHtml       = fs.readFileSync(PDP_HTML, 'utf8');
const middlewareSrc = fs.readFileSync(MIDDLEWARE, 'utf8');
const componentsCss = fs.readFileSync(COMPONENTS_CSS, 'utf8');

// Strip /* */ and // comments so a contract reference inside a comment can
// never satisfy (or trip) a code-shape assertion.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const pdpCode      = stripComments(pdpSrc);
const productsCode = stripComments(productsSrc);

// ─────────────────────────────────────────────────────────────────────────────
// §1.1 — cost_per_page_display value anchor
// ─────────────────────────────────────────────────────────────────────────────

test('§1.1 PDP renders cost_per_page_display near the price', () => {
    assert.match(pdpCode, /info\.cost_per_page_display/,
        'PDP must read info.cost_per_page_display');
    assert.match(pdpCode, /product-cost-per-page/,
        'PDP must render the .product-cost-per-page element');
    assert.match(pdpCode, /data-testid="cost-per-page"/,
        'PDP cost-per-page element needs a stable data-testid');
    // It must be appended into the pricing block, i.e. near the price.
    assert.match(pdpCode, /product-info__pricing[\s\S]{0,400}product-cost-per-page/,
        'cost-per-page must be placed in/near .product-info__pricing, not the spec table');
});

test('§1.1 cost_per_page is escaped, never computed client-side', () => {
    assert.match(pdpCode, /Security\.escapeHtml\(String\(info\.cost_per_page_display\)\)/,
        'cost_per_page_display must be escaped before injection');
    // The frontend must not divide price by yield itself — backend owns it.
    assert.doesNotMatch(pdpCode, /retail_price\s*\/\s*[\w.]*(?:page_?yield|yield)/i,
        'PDP must not compute cost-per-page from price / yield');
});

test('§1.1 product card renders cost_per_page_display defensively', () => {
    assert.match(productsCode, /product\.cost_per_page_display/,
        'product card must read product.cost_per_page_display');
    assert.match(productsCode, /product-card__cost-per-page/,
        'product card must render the .product-card__cost-per-page element');
    // Defensive: a ternary that renders nothing when the field is absent.
    assert.match(productsCode, /product\.cost_per_page_display\s*\?/,
        'card cost-per-page must be a guarded (ternary) render');
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.2 — stock_urgency / stock_urgency_label (genuine only)
// ─────────────────────────────────────────────────────────────────────────────

test('§1.2 PDP renders stock_urgency only for genuine products', () => {
    assert.match(pdpCode, /info\.stock_urgency/,
        'PDP must read info.stock_urgency');
    assert.match(pdpCode, /info\.stock_urgency_label/,
        'PDP must read info.stock_urgency_label');
    // The genuine gate is mandatory — compatibles are pinned at qty 100, so
    // an urgency label there would be a false scarcity claim.
    assert.match(pdpCode, /info\.source\s*===\s*'genuine'[\s\S]{0,200}stock_urgency/,
        'PDP must gate the urgency UI on source === genuine');
});

test('§1.2 PDP labels low + medium urgency, flips the buy box only on low', () => {
    // Both low and medium carry a label.
    assert.match(pdpCode, /stockUrgency\s*===\s*'low'\s*\|\|\s*stockUrgency\s*===\s*'medium'/,
        'PDP must render the label for both low and medium urgency');
    // The attention-red buy box is reserved for low.
    assert.match(pdpCode, /stockUrgency\s*===\s*'low'[\s\S]{0,200}product-info__actions--urgent/,
        "PDP must add .product-info__actions--urgent only when urgency === 'low'");
    assert.match(pdpCode, /data-testid="stock-urgency"/,
        'urgency pill needs a stable data-testid');
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.3 — is_oem_verified trust badge
// ─────────────────────────────────────────────────────────────────────────────

test('§1.3 PDP renders the OEM-verified badge on a strict === true', () => {
    // Strict equality: a falsy/missing value must never read as "fake".
    assert.match(pdpCode, /info\.is_oem_verified\s*===\s*true/,
        'PDP must gate the OEM badge on info.is_oem_verified === true');
    assert.match(pdpCode, /oem-verified/,
        'PDP must render the .oem-verified badge');
    assert.match(pdpCode, /data-testid="oem-verified"/,
        'OEM badge needs a stable data-testid');
    assert.match(pdpCode, /Verified genuine product image/,
        'OEM badge copy must read "Verified genuine product image"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §1.4 — compatible_printers_grouped
// ─────────────────────────────────────────────────────────────────────────────

test('§1.4 PDP renders compatible_printers_grouped via _renderGroupedPrinterCompat', () => {
    assert.match(pdpCode, /_renderGroupedPrinterCompat\s*\(/,
        'PDP must define/call _renderGroupedPrinterCompat');
    assert.match(pdpCode, /info\.compatible_printers_grouped/,
        'PDP must read info.compatible_printers_grouped');
    assert.match(pdpCode, /top_models/,
        'grouped renderer must read each group.top_models');
    assert.match(pdpCode, /\+\$\{remaining\}\s*more/,
        'grouped renderer must render the "+N more" overflow count');
    assert.match(pdpCode, /data-testid="compat-grouped"/,
        'grouped compatibility banner needs a stable data-testid');
});

test('§1.4 grouped renderer is tried before the Supabase fallback', () => {
    // The fast path must short-circuit before _fetchPrinters (Supabase).
    const groupedIdx = pdpCode.indexOf('_renderGroupedPrinterCompat(info)');
    const fetchIdx   = pdpCode.indexOf('_fetchPrinters(info.sku)');
    assert.ok(groupedIdx > -1 && fetchIdx > -1, 'both code paths must exist');
    assert.ok(groupedIdx < fetchIdx,
        'the grouped fast path must run before the Supabase fallback');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — compatible_printers[] slug + brand_slug → printer-hub deep links
// ─────────────────────────────────────────────────────────────────────────────

test('§2 PDP builds printer-hub deep links from slug + brand_slug', () => {
    assert.match(pdpCode, /_printerHubHref\s*\(/,
        'PDP must define a _printerHubHref helper');
    assert.match(pdpCode, /brand=\$\{encodeURIComponent\([\s\S]*?\)\}&printer_slug=\$\{encodeURIComponent\([\s\S]*?\)\}/,
        'printer links must target /shop?brand=…&printer_slug=…');
    assert.match(pdpCode, /entry\.brand_slug/,
        '_printerHubHref must use the API-supplied brand_slug');
    assert.match(pdpCode, /_renderFlatPrinterCompat\s*\(/,
        'PDP must define _renderFlatPrinterCompat for the flat compatible_printers[] path');
});

test('§2 flat compatible_printers path requires the new slug data', () => {
    // The flat fast path must only fire when at least one entry has a slug —
    // otherwise the Supabase fallback (sibling fan-out) is the better source.
    assert.match(pdpCode, /printers\.some\(p\s*=>\s*p\.slug\)/,
        'flat path must check that compatible_printers[] entries carry slug');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — WebP migration: isPlaceholderSwatchImage detects .webp swatches
// ─────────────────────────────────────────────────────────────────────────────

function loadProductColors() {
    const loc = { hostname: 'localhost', protocol: 'http:', pathname: '/', search: '', href: 'http://localhost/' };
    const sandbox = {
        console, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Error,
        Map, Set, Promise, encodeURIComponent, decodeURIComponent,
        location: loc,
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} },
        module: { exports: {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(UTILS, 'utf8'), sandbox, { filename: 'utils.js' });
    return sandbox.ProductColors || (sandbox.window && sandbox.window.ProductColors);
}

test('§3 isPlaceholderSwatchImage detects swatches after the WebP migration', () => {
    const PC = loadProductColors();
    assert.ok(PC && typeof PC.isPlaceholderSwatchImage === 'function',
        'ProductColors.isPlaceholderSwatchImage must be exported');
    // Legacy .png and migrated .webp / .jpg swatches all detected.
    for (const url of [
        'https://x/products/c-can-cl41-ink-rd/color-swatch-v4.png',
        'https://x/products/c-can-cl41-ink-rd/color-swatch-v4.webp',
        'https://x/y/color-swatch.webp',
        'https://x/y/color-swatch-v2.jpg',
        'https://x/y/color-swatch-v9.webp?cb=1',
    ]) {
        assert.strictEqual(PC.isPlaceholderSwatchImage(url), true, `should match: ${url}`);
    }
    // Real product photos — including real .webp photos — never match: the
    // discriminator is the `color-swatch` stem, not the extension.
    for (const url of [
        'https://x/products/G-BRO-TN150-TNR-BK/G-BRO-TN150-TNR-BK-1776932847052.webp',
        'https://x/foo/photo.jpg',
        '/assets/images/placeholder-product.svg',
    ]) {
        assert.strictEqual(PC.isPlaceholderSwatchImage(url), false, `should reject: ${url}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — no client-side Product/Breadcrumb/FAQ JSON-LD on the PDP
// ─────────────────────────────────────────────────────────────────────────────

test('§4 PDP HTML ships no static JSON-LD <script> blocks', () => {
    assert.doesNotMatch(pdpHtml, /application\/ld\+json/,
        'product/index.html must not ship static JSON-LD — the prerender layer owns it');
    assert.doesNotMatch(pdpHtml, /id="product-schema"/,
        'the static #product-schema block must be removed');
    assert.doesNotMatch(pdpHtml, /id="breadcrumb-schema"/,
        'the static #breadcrumb-schema block must be removed');
});

test('§4 PDP JS emits no client-side Product / Breadcrumb / FAQ JSON-LD', () => {
    assert.doesNotMatch(pdpCode, /Schema\.injectProduct\s*\(/,
        'PDP must not call Schema.injectProduct (that emits Product/Breadcrumb/FAQ JSON-LD)');
    assert.doesNotMatch(pdpCode, /getElementById\(\s*['"]product-schema['"]\s*\)/,
        'PDP must not write to a #product-schema script tag');
    assert.doesNotMatch(pdpCode, /getElementById\(\s*['"]breadcrumb-schema['"]\s*\)/,
        'PDP must not write to a #breadcrumb-schema script tag');
    // No function should be (re)building a Product schema object.
    assert.doesNotMatch(pdpCode, /updateProductSchema\s*\(\s*info/,
        'updateProductSchema must stay removed — no client-side Product JSON-LD');
    assert.doesNotMatch(pdpCode, /createElement\(['"]script['"]\)[\s\S]{0,160}application\/ld\+json/,
        'PDP must not append ld+json <script> elements at runtime');
});

test('§4 PDP still reads faq_schema only as visible-accordion data', () => {
    // The FAQ accordion is on-page UI, not JSON-LD — keeping the data read is
    // correct; it just must not be emitted as a <script type=ld+json>.
    assert.match(pdpCode, /seo\.jsonLd[\s\S]{0,120}faq_schema/,
        'PDP may still read seo.jsonLd.faq_schema to populate the visible FAQ accordion');
});

test('§4 middleware routes AdsBot + StoreBot to the prerender layer', () => {
    // Removing client-side JSON-LD is only safe if every Google crawler that
    // reads structured data is served the prerendered HTML. AdsBot/StoreBot
    // UAs do not contain the substring "googlebot", so they need explicit
    // tokens in BOT_PATTERN.
    const botLine = middlewareSrc.match(/const BOT_PATTERN\s*=\s*\/([^\n]*)\/i/);
    assert.ok(botLine, 'middleware.js must define BOT_PATTERN');
    assert.match(botLine[1], /adsbot-google/, 'BOT_PATTERN must include adsbot-google');
    assert.match(botLine[1], /storebot-google/, 'BOT_PATTERN must include storebot-google');
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS — the four CRO surfaces must have styling
// ─────────────────────────────────────────────────────────────────────────────

test('CSS — every marketing-audit surface is styled in components.css', () => {
    for (const sel of [
        '.product-cost-per-page',
        '.product-card__cost-per-page',
        '.stock-urgency',
        '.stock-urgency--low',
        '.stock-urgency--medium',
        '.product-info__actions--urgent',
        '.oem-verified',
        '.product-printers-banner--grouped',
        '.compat-group',
    ]) {
        assert.ok(componentsCss.includes(sel),
            `components.css must style ${sel}`);
    }
});
