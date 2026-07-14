/**
 * Merchant Center readiness — frontend contract (July 2026)
 * =========================================================
 *
 * Pins the frontend fixes made for the Google Merchant Center reinstatement
 * audit so they cannot silently regress:
 *   - product labelling never asserts "Genuine" from a default/missing source
 *   - related-products never badge an unknown source as GENUINE
 *   - shop section headers never double the source word ("Compatible Compatible")
 *   - the compatibility-model sanitizer strips brand doubling + yield artifacts
 *   - payment badges are consistent + complete across footer / cart / 404
 *   - the /genuine-vs-compatible page exists, is wired, and is linked
 *   - no page ships a static Admin link in its header source
 *
 * Run with: node --test tests/merchant-center-readiness.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');
const { ProductName } = require(path.join(SITE, 'js', 'utils.js'));

// ─────────────────────────────────────────────────────────────────────────────
// ProductName.compatModel — compatibility-label sanitizer
// ─────────────────────────────────────────────────────────────────────────────

test('compatModel collapses duplicated brand tokens', () => {
    assert.equal(ProductName.compatModel('Brother Brother HL-2130', 'Brother'), 'Brother HL-2130');
    assert.equal(ProductName.compatModel('HP HP DeskJet 2700', 'HP'), 'HP DeskJet 2700');
    assert.equal(ProductName.compatModel('OKI OKI', 'OKI'), 'OKI');
});

test('compatModel drops percentage / page-yield artifacts', () => {
    assert.equal(ProductName.compatModel('OKI 5%', 'OKI'), 'OKI');
    assert.equal(ProductName.compatModel('OKI 100 (3 PAGES', 'OKI'), 'OKI 100');
    assert.equal(ProductName.compatModel('Canon PIXMA (650 pages)', 'Canon'), 'Canon PIXMA');
});

test('compatModel leaves clean and cross-brand labels untouched', () => {
    assert.equal(ProductName.compatModel('Brother HL-2130', 'Brother'), 'Brother HL-2130');
    // Cross-brand contamination is left for the feed auditor to flag — the
    // frontend must not silently delete a real (if suspicious) model.
    assert.equal(ProductName.compatModel('HP ENVY 4520', 'OKI'), 'HP ENVY 4520');
    assert.equal(ProductName.compatModel('', 'HP'), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// PDP label integrity — never assert genuine from a default
// ─────────────────────────────────────────────────────────────────────────────

const PDP = read('js/product-detail-page.js');

test('PDP <title> prefix "Genuine" is gated on an explicit source', () => {
    assert.ok(PDP.includes("info.source === 'genuine' ? 'Genuine '"),
        'genuinePrefix must key off info.source === "genuine", not !isCompatible');
    assert.ok(!/genuinePrefix\s*=\s*\([^)]*!info\.isCompatible/.test(PDP),
        'genuinePrefix must not derive "Genuine" from !info.isCompatible');
});

test('related-products never invents a genuine source', () => {
    assert.ok(!PDP.includes("p.source || info.source || 'genuine'"),
        'inferSource must not fall back to a hardcoded "genuine"');
    assert.ok(/const sourceKnown =\s*info\.source === 'genuine' \|\| info\.source === 'compatible'/.test(PDP),
        'related products must compute sourceKnown from an explicit source');
    assert.ok(/const badge = !sourceKnown \? ''/.test(PDP),
        'the related-products badge must be suppressed when the source is unknown');
});

test('meta description keys the genuine/compatible word off source (unknown → neither)', () => {
    assert.ok(PDP.includes("if (info.source === 'genuine') {"),
        'generateMetaDescription must branch on explicit source');
    assert.ok(/else \{\s*\n\s*parts\.push\(info\.brandName\);/.test(PDP),
        'unknown source must get no genuine/compatible qualifier in the meta description');
});

test('PDP links the genuine-vs-compatible explainer beside the badge', () => {
    assert.ok(PDP.includes('/genuine-vs-compatible'),
        'PDP must link to /genuine-vs-compatible near the source badge');
});

// ─────────────────────────────────────────────────────────────────────────────
// Shop headings — no "Compatible Compatible" / "Original Original"
// ─────────────────────────────────────────────────────────────────────────────

const SHOP = read('js/shop-page.js');

test('shop exposes a base (unprefixed) product-type label', () => {
    assert.ok(SHOP.includes('getBaseProductTypeLabel()'),
        'shop-page must define getBaseProductTypeLabel()');
});

test('shop section headers use the base label so the source word is not doubled', () => {
    const m = SHOP.match(/async displayProductInfo\([\s\S]*?\n {8}\},/);
    assert.ok(m, 'displayProductInfo must exist');
    const body = m[0];
    assert.ok(body.includes('getBaseProductTypeLabel()'),
        'displayProductInfo must use getBaseProductTypeLabel() (not the prefixed getProductTypeLabel) for the two section headers');
    assert.ok(body.includes('${brandName} Compatible ${productType}')
        && body.includes('${brandName} Original ${productType}'),
        'section headers add exactly one source word');
});

// ─────────────────────────────────────────────────────────────────────────────
// Payment badge consistency
// ─────────────────────────────────────────────────────────────────────────────

const CANONICAL_PAYMENTS = ['Visa', 'Mastercard', 'American Express', 'PayPal', 'Apple Pay', 'Google Pay', 'Klarna'];

test('legal-config lists exactly the canonical accepted payment methods', () => {
    const legal = read('js/legal-config.js');
    for (const method of CANONICAL_PAYMENTS) {
        assert.ok(legal.includes(`'${method}'`),
            `legal-config paymentMethods must include ${method}`);
    }
});

test('footer, cart and 404 advertise the full canonical payment set', () => {
    // 404.html used to hand-roll its own footer (and its own payment badges).
    // Since the Jul 2026 redesign it renders the shared footer, so its badges
    // ARE js/footer.js's badges — asserting them against 404.html's own source
    // would now only ever test a copy that no longer exists. The 404 page's
    // footer contract is pinned in google-ads-compliance §11 instead.
    const surfaces = {
        'js/footer.js': read('js/footer.js'),
        'html/cart.html': read('html/cart.html'),
    };
    for (const [file, src] of Object.entries(surfaces)) {
        for (const method of CANONICAL_PAYMENTS) {
            const short = method === 'American Express' ? '(American Express|>Amex<)' : method;
            const re = new RegExp(`aria-label="${method}"|title="${method}"|${short}`, 'i');
            assert.ok(re.test(src), `${file} is missing the ${method} payment badge`);
        }
        assert.ok(!/afterpay|laybuy|zip pay/i.test(src),
            `${file} must not advertise a BNPL method the site does not offer`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// /genuine-vs-compatible page wiring
// ─────────────────────────────────────────────────────────────────────────────

test('genuine-vs-compatible page exists with a real H1 and OEM disclaimer', () => {
    const page = read('html/genuine-vs-compatible.html');
    assert.match(page, /<h1[^>]*>[^<]*Genuine vs Compatible/i);
    assert.match(page, /not (?:made|licensed|endorsed)/i);
    assert.ok(page.includes('hreflang="en-NZ"') && page.includes('hreflang="x-default"'),
        'the page must carry hreflang like every other page');
});

test('vercel routes /genuine-vs-compatible to the real page (no homepage redirect)', () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.ok(!(cfg.redirects || []).some(r => r.source === '/genuine-vs-compatible'),
        '/genuine-vs-compatible must not redirect to the homepage any more');
    const rw = (cfg.rewrites || []).find(r => r.source === '/genuine-vs-compatible');
    assert.ok(rw && rw.destination === '/html/genuine-vs-compatible',
        '/genuine-vs-compatible must rewrite to /html/genuine-vs-compatible');
});

test('the footer links to /genuine-vs-compatible', () => {
    assert.ok(read('js/footer.js').includes('/genuine-vs-compatible'),
        'footer.js must link to the genuine-vs-compatible page');
});

// ─────────────────────────────────────────────────────────────────────────────
// No static Admin link in page source
// ─────────────────────────────────────────────────────────────────────────────

test('no page ships href="/admin" or #header-admin-link in its header source', () => {
    function walk(dir, out = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'admin' && e.name !== 'node_modules') walk(p, out); }
            else if (e.name.endsWith('.html')) out.push(p);
        }
        return out;
    }
    for (const f of walk(SITE)) {
        const html = fs.readFileSync(f, 'utf8');
        const i = html.indexOf('<header');
        if (i === -1) continue;
        const header = html.slice(i, html.indexOf('</header>', i) + 9);
        assert.ok(!/id="header-admin-link"|href="\/admin"/.test(header),
            `${path.relative(ROOT, f)} exposes a static Admin link in its header`);
    }
});
