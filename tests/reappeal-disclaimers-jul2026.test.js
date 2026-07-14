/**
 * Google Ads / Merchant Center re-appeal — compliance disclaimer parity
 * =====================================================================
 *
 * Pins the frontend hand-off outcome (frontend-handoff-jul2026.md). The SPA
 * must render the same compliance copy the backend already serves to bots
 * (mismatch = "cloaking"), and /genuine-vs-compatible must be crawlable.
 *
 * Regression guards:
 *   1. /genuine-vs-compatible is NOT redirected to "/" and IS rewritten to the
 *      static page (vercel.json).
 *   2. Global footer carries the trademark / Consumer Guarantees Act disclaimer,
 *      interpolating the legal + trading name (not hardcoded).
 *   3. Compatible PDPs render the vetted third-party / CGA disclaimer panel,
 *      keyed off `source === 'compatible'`; genuine products render nothing.
 *   4. /returns exposes the "Refund processing window" (3–5 business-day SLA).
 *
 * Run with: node --test tests/reappeal-disclaimers-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');

test('vercel.json: no genuine-vs-compatible → "/" redirect, has static rewrite', () => {
    const cfg = JSON.parse(READ('vercel.json'));

    const badRedirect = (cfg.redirects || []).find(
        (r) => /genuine-vs-compatible/.test(r.source) && r.destination === '/'
    );
    assert.equal(badRedirect, undefined,
        'the /genuine-vs-compatible → / 308 redirect must be removed');

    const rewrite = (cfg.rewrites || []).find(
        (r) => r.source === '/genuine-vs-compatible'
    );
    assert.ok(rewrite, 'a rewrite for /genuine-vs-compatible must exist');
    assert.equal(rewrite.destination, '/html/genuine-vs-compatible',
        'bots + humans get the same static page (anti-cloaking)');
});

test('genuine-vs-compatible page title aligned with backend canonical', () => {
    const html = READ('html/genuine-vs-compatible.html');
    assert.match(html, /<title>Genuine vs Compatible Ink Cartridges[\s\S]*What's the Difference\?[\s\S]*<\/title>/);
});

test('footer: trademark / Consumer Guarantees Act disclaimer, interpolated names', () => {
    const src = READ('js/footer.js');
    assert.match(src, /class="footer-disclaimer"/,
        'a .footer-disclaimer element must be rendered');
    assert.match(src, /trademarks of their respective owners and are used only to indicate compatibility/);
    assert.match(src, /not manufactured, endorsed, or sold by those brand owners/);
    assert.match(src, /New Zealand Consumer Guarantees Act 1993 are unaffected/);
    // Names come from TRUST (mirrors backend organization.legal_name /
    // trading_name) — not hardcoded literals.
    assert.match(src, /\$\{TRUST\.legalEntity\}/);
    assert.match(src, /\$\{TRUST\.tradingName\}/);
});

test('footer .footer-disclaimer has its own full-width band', () => {
    const css = READ('css/layout.css');
    // Was `flex-basis: 100%`, back when the disclaimer was one flex child of the
    // bottom bar. The Jul 2026 redesign gives it its own zone (.footer-legal),
    // so flex-basis would be a dead property kept alive only to satisfy a test.
    // The intent is unchanged: the disclaimer spans the full width and is never
    // squeezed into a column beside the payment chips.
    assert.match(css, /\.footer-disclaimer\s*\{[\s\S]*?width:\s*100%/);
    assert.match(css, /\.footer-legal\s*\{[\s\S]*?border-top:/,
        'the disclaimer sits in its own band, separated by a hairline');
});

test('PDP: compatible-only compliance disclaimer, keyed off source', () => {
    const src = READ('js/product-detail-page.js');

    assert.match(src, /renderComplianceDisclaimer\s*\(info\)/,
        'renderComplianceDisclaimer method must exist');
    // Guarded on the trusted `source` field, NOT isCompatible. Extract just the
    // method body (definition → the next method) so we don't scan renderProduct.
    const body = src.slice(
        src.indexOf('renderComplianceDisclaimer(info) {'),
        src.indexOf('renderPackSuggestion(info) {')
    );
    assert.ok(body, 'method body must be extractable');
    assert.match(body, /info\.source\s*!==\s*'compatible'/);
    assert.doesNotMatch(body, /isCompatible/,
        'disclaimer must key off source, not isCompatible');

    // The method is invoked from renderProduct.
    assert.match(src, /this\.renderComplianceDisclaimer\(info\)/);

    // Vetted copy present; OEM brand escaped.
    assert.match(src, /This is a compatible \(third-party\) \$\{type\} designed to work in the \$\{oem\} printers/);
    assert.match(src, /It is not manufactured, endorsed, or sold by \$\{oem\}/);
    assert.match(src, /12-month replacement warranty on compatible cartridges/);
    assert.match(src, /New Zealand Consumer Guarantees Act 1993 are unaffected/);
    assert.match(src, /Security\.escapeHtml\(info\.brandName/,
        'OEM brand name must be HTML-escaped');
    // Banned: never assert anything about the OEM's own warranty.
    assert.doesNotMatch(src, /won't void|will not void|does not void your/i);
});

test('PDP .compat-disclaimer panel styled', () => {
    const css = READ('css/pages.css');
    assert.match(css, /\.compat-disclaimer\s*\{/);
});

test('/returns exposes the Refund processing window (3–5 business day SLA)', () => {
    const html = READ('html/returns.html');
    assert.match(html, /Refund processing window/i);
    assert.match(html, /3&ndash;5 business days|3–5 business days/,
        'the 3–5 business-day processing SLA must be stated');
    assert.match(html, /in addition to your statutory rights under the New Zealand Consumer Guarantees Act 1993/);
});
