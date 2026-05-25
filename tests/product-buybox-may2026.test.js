/**
 * Product page buy-box — May 2026
 * ===============================
 *
 * Pins the storefront half of the backend release described in
 * `readfirst/product-page-buybox-may2026.md`. The PDP renders a single
 * four-row buy-box card — Price · Availability · Delivery · Returns —
 * in the exact order Googlebot sees in the prerendered HTML so the SPA
 * and the bot surface read identically (Google's no-cloaking rule).
 *
 * What this file guards:
 *   §A  HTML scaffold: <dl class="buy-box"> with the four rows, in order.
 *   §B  Required IDs and microdata (Offer / price / priceCurrency).
 *   §C  PDP JS reads data.delivery_estimate.{label,dispatch_cutoff_human}
 *       and data.trust_signals.returns.{days,url_path}, with the exact
 *       copy locked by the spec ("Order before … NZT for same-day dispatch",
 *       "${days}-day returns · Policy ›").
 *   §D  PDP JS falls back to the spec's locked copy on pre-May-2026
 *       payloads — never paints a blank Delivery/Returns row.
 *   §E  PDP JS sets the schema.org `content` attribute on the price span
 *       so GMC reads the numeric value, not the formatted string.
 *   §F  Legacy .product-trust-strip is gone from both HTML and CSS
 *       (folded into the buy-box rows; redundant copy is now banned).
 *   §G  Returns URL goes through a sanitiser so a misconfigured backend
 *       env var cannot punch javascript:/foreign-host links into the row.
 *
 * Static-source assertions are deliberate — they pin the *contract shape*
 * in the renderers, which is what regresses, and they run without a DOM.
 *
 * Run with: node --test tests/product-buybox-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const PDP_JS   = path.join(ROOT, 'js', 'product-detail-page.js');
const PDP_HTML = path.join(ROOT, 'html', 'product', 'index.html');
const PAGES_CSS = path.join(ROOT, 'css', 'pages.css');

const pdpSrc  = fs.readFileSync(PDP_JS, 'utf8');
const pdpHtml = fs.readFileSync(PDP_HTML, 'utf8');
const pagesCss = fs.readFileSync(PAGES_CSS, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const pdpCode = stripComments(pdpSrc);

// ─────────────────────────────────────────────────────────────────────────────
// §A — HTML scaffold: four-row <dl class="buy-box"> in locked order
// ─────────────────────────────────────────────────────────────────────────────

test('§A PDP HTML ships a <dl class="buy-box"> with id="product-buybox"', () => {
    assert.match(pdpHtml, /<dl[^>]+class="buy-box"[^>]*id="product-buybox"|<dl[^>]+id="product-buybox"[^>]*class="buy-box"/,
        'PDP must wrap the buy-box in a <dl class="buy-box" id="product-buybox">');
});

test('§A buy-box rows appear in the locked order: Price → Availability → Delivery → Returns', () => {
    const buyBoxMatch = pdpHtml.match(/<dl[^>]*id="product-buybox"[\s\S]*?<\/dl>/);
    assert.ok(buyBoxMatch, 'buy-box <dl> not found in PDP HTML');
    const block = buyBoxMatch[0];
    const labels = [...block.matchAll(/<dt[^>]*>([^<]+)<\/dt>/g)].map(m => m[1].trim());
    assert.deepEqual(labels, ['Price', 'Availability', 'Delivery', 'Returns'],
        'buy-box <dt> labels must be exactly Price · Availability · Delivery · Returns in this order');
});

test('§A buy-box has the four expected value <dd> classes', () => {
    for (const klass of [
        'buy-box__value--price',
        'buy-box__value--availability',
        'buy-box__value--delivery',
        'buy-box__value--returns',
    ]) {
        assert.match(pdpHtml, new RegExp(`class="[^"]*${klass}[^"]*"`),
            `buy-box must carry a .${klass} <dd>`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §B — Required IDs and Schema.org Offer microdata
// ─────────────────────────────────────────────────────────────────────────────

test('§B buy-box wraps an itemtype="https://schema.org/Offer"', () => {
    assert.match(pdpHtml, /<dl[^>]*itemprop="offers"[^>]*itemscope[^>]*itemtype="https:\/\/schema\.org\/Offer"/,
        'buy-box <dl> must wrap a schema.org/Offer (price/priceCurrency/availability live inside)');
});

test('§B price <span> carries id="product-price" and itemprop="price"', () => {
    assert.match(pdpHtml, /<span[^>]*id="product-price"[^>]*itemprop="price"/,
        '#product-price must declare itemprop="price" so GMC reads the value');
});

test('§B priceCurrency is NZD and lives inside the price <dd>', () => {
    assert.match(pdpHtml, /<meta[^>]+itemprop="priceCurrency"[^>]+content="NZD"/,
        'Offer must emit <meta itemprop="priceCurrency" content="NZD">');
});

test('§B Availability <dd> keeps id="product-stock" (existing renderers depend on it)', () => {
    assert.match(pdpHtml, /<dd[^>]*id="product-stock"/,
        '#product-stock id must remain so stock + urgency rendering still binds');
});

test('§B Delivery + Returns <dd> elements carry stable IDs and testids', () => {
    assert.match(pdpHtml, /id="product-delivery"[\s\S]*data-testid="buy-box-delivery"|data-testid="buy-box-delivery"[\s\S]*id="product-delivery"/,
        'Delivery <dd> must have id="product-delivery" and data-testid="buy-box-delivery"');
    assert.match(pdpHtml, /id="product-returns"[\s\S]*data-testid="buy-box-returns"|data-testid="buy-box-returns"[\s\S]*id="product-returns"/,
        'Returns <dd> must have id="product-returns" and data-testid="buy-box-returns"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §C — PDP JS reads the new payload fields with the locked copy
// ─────────────────────────────────────────────────────────────────────────────

test('§C PDP reads delivery_estimate.label and dispatch_cutoff_human', () => {
    assert.match(pdpCode, /delivery_estimate/,
        'PDP must read data.delivery_estimate');
    assert.match(pdpCode, /\.label\b/,
        'PDP must read delivery_estimate.label');
    assert.match(pdpCode, /dispatch_cutoff_human/,
        'PDP must read delivery_estimate.dispatch_cutoff_human');
});

test('§C PDP reads trust_signals.returns.days and url_path', () => {
    assert.match(pdpCode, /trust_signals/,
        'PDP must read data.trust_signals');
    assert.match(pdpCode, /\.returns\b/,
        'PDP must read trust_signals.returns');
    assert.match(pdpCode, /url_path/,
        'PDP must read trust_signals.returns.url_path');
});

test('§C Delivery row emits the exact locked copy "Order before … NZT for same-day dispatch"', () => {
    assert.match(pdpCode, /Order before \$\{[^}]*\}[^]*NZT for same-day dispatch/,
        'Delivery copy must read: ${label} · Order before ${cutoff} NZT for same-day dispatch');
});

test('§C Returns row emits "${days}-day returns" and links to Policy', () => {
    assert.match(pdpCode, /\$\{rDays\}-day returns/,
        'Returns copy must read: ${days}-day returns');
    assert.match(pdpCode, /Policy/,
        'Returns row must link to the Policy');
});

// ─────────────────────────────────────────────────────────────────────────────
// §D — Spec-locked fallbacks for pre-May-2026 payloads
// ─────────────────────────────────────────────────────────────────────────────

test('§D PDP falls back to the spec-locked delivery copy when the API omits it', () => {
    assert.match(pdpCode, /SPEC_DELIVERY_LABEL\s*=\s*'1–4 business days NZ-wide'/,
        'PDP must hard-code the spec-locked delivery label as a fallback');
    assert.match(pdpCode, /SPEC_DELIVERY_CUTOFF\s*=\s*'2pm'/,
        'PDP must hard-code the spec-locked dispatch cutoff ("2pm") as a fallback');
});

test('§D PDP falls back to 30 days / /returns when trust_signals.returns is absent', () => {
    assert.match(pdpCode, /SPEC_RETURNS_DAYS\s*=\s*30/,
        'PDP must hard-code 30-day returns as a fallback');
    assert.match(pdpCode, /SPEC_RETURNS_URL\s*=\s*'\/returns'/,
        'PDP must hard-code /returns as a fallback URL');
});

// ─────────────────────────────────────────────────────────────────────────────
// §E — schema.org `content` attribute on the price
// ─────────────────────────────────────────────────────────────────────────────

test('§E PDP sets itemprop="price" `content` attribute to the numeric value', () => {
    assert.match(pdpCode, /priceEl\.setAttribute\(['"]content['"],\s*price\.toFixed\(2\)\)/,
        'PDP must set <span itemprop="price" content="X.XX"> — GMC reads the attribute, not the visible string');
});

// ─────────────────────────────────────────────────────────────────────────────
// §F — Legacy .product-trust-strip is gone
// ─────────────────────────────────────────────────────────────────────────────

test('§F PDP HTML no longer renders the legacy .product-trust-strip', () => {
    assert.doesNotMatch(pdpHtml, /class="product-trust-strip"/,
        '.product-trust-strip was folded into the buy-box rows — do not re-add (duplicates row copy)');
});

test('§F pages.css no longer defines an active .product-trust-strip rule', () => {
    // Allow the rule name to appear in a removal-explanation comment, but
    // never in a live `.product-trust-strip { ... }` declaration.
    const cssNoComments = pagesCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(cssNoComments, /\.product-trust-strip\s*\{/,
        '.product-trust-strip CSS rule was removed in buybox-may2026 — do not re-add');
});

// ─────────────────────────────────────────────────────────────────────────────
// §G — Returns URL sanitiser
// ─────────────────────────────────────────────────────────────────────────────

test('§G PDP runs the returns URL through a sanitiser, not raw interpolation', () => {
    assert.match(pdpCode, /_safeReturnsUrl/,
        'Returns URL must pass through _safeReturnsUrl — a misconfigured backend env var cannot punch javascript: or foreign hosts into the PDP');
});
