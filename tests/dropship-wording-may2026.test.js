/**
 * Dropship wording contract — May 2026
 * ====================================
 *
 * The business runs from a small Auckland office (37A Archibald Road,
 * Kelston) and does not hold stock — every order is dispatched directly
 * by one of our New Zealand wholesale supplier partners. This test
 * pins the customer-facing copy to that reality so we never re-introduce
 * a "warehouse" claim that would misrepresent the operation.
 *
 * Compliance angle: the Fair Trading Act 1986 §13 prohibits false or
 * misleading representations about the business's place of operation,
 * and the Google Ads "Misrepresentation" policy independently requires
 * that what we tell shoppers about fulfilment matches reality.
 *
 * Scope of the pin:
 *   • Zero "warehouse" tokens on any footer-linked policy / about /
 *     contact page (terms, privacy, returns, shipping, about, faq, contact).
 *   • Zero bare "Address:" labels on those pages — the hero meta and
 *     the footer Contact column both use "Office:" since May 2026.
 *   • LegalConfig.supplierFulfillment string (rendered into the
 *     Shipping page via data-legal-bind="supplier-fulfillment") is
 *     warehouse-free and names the supplier-partner model.
 *   • Shipping page's #dropship section explains the supplier-direct
 *     dispatch model so customers can find one canonical explanation.
 *   • About page §3 ("How we work") and the FAQ "Where do orders ship
 *     from?" entry both reference the dropshipping model honestly.
 *
 * Run with: node --test tests/dropship-wording-may2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const JS   = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p)   => fs.readFileSync(p, 'utf8');

const FOOTER_LINKED_PAGES = [
    'about.html',   // /about
    'contact.html', // /contact
    'faq.html',     // /faq
    'terms.html',   // /terms
    'privacy.html', // /privacy
    'returns.html', // /returns
    'shipping.html',// /shipping
];

const SRC       = Object.fromEntries(FOOTER_LINKED_PAGES.map((p) => [p, READ(HTML(p))]));
const FOOTER_JS = READ(JS('footer.js'));
const CONFIG_JS = READ(JS('legal-config.js'));

// Helper: load LegalConfig in a sandbox so we can assert against the live
// strings rather than re-parsing the file with regexes.
function loadConfig() {
    const fn = new Function('window', CONFIG_JS + '\nreturn window.LegalConfig;');
    return fn({});
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — No "warehouse" wording anywhere customer-facing
// ─────────────────────────────────────────────────────────────────────────────

test('§1 zero "warehouse" tokens on any footer-linked policy / about / contact page', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        const matches = (SRC[page].match(/warehouse/gi) || []);
        assert.equal(matches.length, 0,
            `${page}: must contain zero "warehouse" tokens — found ${matches.length}. ` +
            `We don't have a warehouse; reword as "office" or "supplier partner".`);
    }
});

test('§1 footer.js (rendered on every page) contains zero "warehouse" tokens', () => {
    const matches = (FOOTER_JS.match(/warehouse/gi) || []);
    assert.equal(matches.length, 0,
        `footer.js: must contain zero "warehouse" tokens — found ${matches.length}`);
});

test('§1 LegalConfig.supplierFulfillment string is warehouse-free', () => {
    const cfg = loadConfig();
    assert.ok(typeof cfg.supplierFulfillment === 'string' && cfg.supplierFulfillment.length > 0,
        'LegalConfig.supplierFulfillment must be a non-empty string');
    assert.ok(!/warehouse/i.test(cfg.supplierFulfillment),
        `supplierFulfillment must not claim a warehouse; got: ${cfg.supplierFulfillment}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — "Office:" replaces the bare "Address:" label everywhere it appeared
// ─────────────────────────────────────────────────────────────────────────────

test('§2 footer.js Contact column uses "Office:" not "Address:"', () => {
    assert.match(FOOTER_JS, /<strong>Office:<\/strong>/,
        'footer.js Contact column must label the address line "Office:"');
    assert.ok(!/<strong>Address:<\/strong>/.test(FOOTER_JS),
        'footer.js must not use the bare "Address:" label — reframed to "Office:" in May 2026');
});

test('§2 about.html hero meta uses "Office:" label', () => {
    assert.match(SRC['about.html'], /<strong>Office:<\/strong>/,
        'about.html hero meta must label the address "Office:" not "Address:"');
    assert.ok(!/<strong>Address:<\/strong>/.test(SRC['about.html']),
        'about.html must not use the "Address:" label');
});

test('§2 contact.html contact-card label is "Office", not "Address"', () => {
    assert.match(SRC['contact.html'], /class="contact-card__label">Office</,
        'contact.html contact card must label the address block "Office"');
    assert.ok(!/class="contact-card__label">Address</.test(SRC['contact.html']),
        'contact.html must not use the "Address" contact-card label — reframed to "Office" in May 2026');
});

test('§2 no policy/about page renders a bare "<strong>Address:</strong>" label', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.ok(!/<strong>Address:<\/strong>/.test(SRC[page]),
            `${page}: must not render the bare "Address:" label — use "Office:" or omit the label`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — The dropship model is explained in canonical places customers can find
// ─────────────────────────────────────────────────────────────────────────────

test('§3 shipping.html #dropship section exists and explains supplier-direct dispatch', () => {
    const src = SRC['shipping.html'];
    assert.match(src, /id="dropship"/,
        'shipping.html must keep the #dropship section anchor (linked from FAQ and About)');
    assert.match(src, /supplier-direct dispatch|directly by .{0,40}supplier partners?/i,
        'shipping.html dropship section must explain the supplier-direct dispatch model');
    assert.match(src, /data-legal-bind="supplier-fulfillment"/,
        'shipping.html must render the supplier-fulfillment binding inside #dropship');
});

test('§3 shipping.html dropship section names supplier partners as the dispatch source', () => {
    // The semantic content of the section must clearly say cartridges
    // dispatch from supplier partners — not from "us" or "our location".
    const src = SRC['shipping.html'];
    assert.match(src, /(?:supplier partners?|wholesale supplier)/i,
        'shipping.html must use "supplier partners" / "wholesale supplier" terminology');
    assert.match(src, /Dispatched by supplier/i,
        'shipping.html must keep the "Dispatched by supplier" label that appears on PDP stock blocks');
});

test('§3 about.html "How we work" section discloses the dropship model', () => {
    const src = SRC['about.html'];
    assert.match(src, /id="how-we-work"/,
        'about.html must keep the #how-we-work section anchor');
    assert.match(src, /dropshipping/i,
        'about.html must use the word "dropshipping" so customers searching for it find a clear answer');
    assert.match(src, /supplier partners?/i,
        'about.html must name the NZ supplier-partner relationship');
});

test('§3 faq.html addresses the dropshipping question directly', () => {
    const src = SRC['faq.html'];
    // Must answer the question a curious customer would actually ask.
    assert.match(src, /Where do orders ship from\?|[Dd]o you dropship\?/,
        'faq.html must include a question about where orders ship from / dropshipping');
    assert.match(src, /\/shipping#dropship/,
        'faq.html must link out to /shipping#dropship for the full mechanics');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — The address itself (37A Archibald Road, Kelston) is still present —
//        we still operate from there, it just isn't a warehouse
// ─────────────────────────────────────────────────────────────────────────────

test('§4 the office address is still rendered on contact.html and about.html', () => {
    // Removing the address would break Google Merchant Center compliance
    // and the LocalBusiness JSON-LD on the homepage. Keep it visible.
    for (const page of ['contact.html', 'about.html']) {
        assert.match(SRC[page], /37A Archibald Road/,
            `${page}: must still render the office street address`);
        assert.match(SRC[page], /Kelston, Auckland 0602/,
            `${page}: must still render suburb + postcode`);
    }
});

test('§4 LegalConfig.address.street is unchanged (37A Archibald Road)', () => {
    const cfg = loadConfig();
    assert.equal(cfg.address.street, '37A Archibald Road',
        'office street address must remain "37A Archibald Road"');
    assert.equal(cfg.address.suburb, 'Kelston',
        'office suburb must remain "Kelston"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Cache busting: the supplier-fulfillment + footer copy changes must be
//        invalidated on production browsers so the new wording ships immediately
// ─────────────────────────────────────────────────────────────────────────────

test('§5 every footer-linked page references footer.js with the dropship-may2026 cache key', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.match(SRC[page], /\/js\/footer\.js\?v=dropship-may2026/,
            `${page}: must load footer.js with v=dropship-may2026 to invalidate the old "Address:" footer`);
    }
});

test('§5 every legal-binding page references legal-config.js with the dropship-may2026 cache key', () => {
    // legal-config.js carries the supplierFulfillment string; the cache key
    // must roll forward so the new copy renders for returning visitors.
    for (const page of FOOTER_LINKED_PAGES) {
        assert.match(SRC[page], /\/js\/legal-config\.js\?v=dropship-may2026/,
            `${page}: must load legal-config.js with v=dropship-may2026`);
    }
});
