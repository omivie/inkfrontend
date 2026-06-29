/**
 * Retail wording contract — May 2026 (supersedes dropship-wording-may2026.test.js)
 * ================================================================================
 *
 * The customer-facing site presents InkCartridges.co.nz as a normal NZ retailer:
 * we ship orders from New Zealand on the NZ Post and Aramex networks. The site
 * must not disclose, hint at, or describe a dropship/supplier-direct fulfilment
 * model, and it also must not falsely claim a warehouse we don't own. The lane
 * between those two errors is narrow but real: speak about dispatch, courier
 * networks, and handling time without naming who physically holds the cartridge.
 *
 * Compliance angle: the Fair Trading Act 1986 §13 prohibits *false or misleading*
 * representations. Removing the dropship disclosure does not, by itself, breach
 * §13 — what would breach §13 is making a positive false claim (e.g. "ships from
 * our warehouse" when we don't own one). Hence this test pins the *absence* of
 * both:
 *   • supplier-partner / dropship / "we don't hold stock" / "dispatched directly
 *     by" / "wholesale supplier" tokens (the prior disclosure copy), AND
 *   • "warehouse" tokens (the prior false-claim risk).
 *
 * Scope of the pin:
 *   • Zero forbidden tokens on any footer-linked policy / about / contact page
 *     (terms, privacy, returns, shipping, about, faq, contact).
 *   • Zero forbidden tokens in shared scripts that render copy site-wide
 *     (footer.js, legal-config.js, legal-page.js).
 *   • LegalConfig must not export a `supplierFulfillment` key, and legal-page.js
 *     must not declare a `'supplier-fulfillment'` data-binding.
 *   • shipping.html must not carry an `id="dropship"` anchor, and no page may
 *     link to `/shipping#dropship`.
 *   • "Office:" label is preserved (carried forward from the May 2026 dropship
 *     wording rollout — still valid for the same reason: we operate from an
 *     office, never a warehouse).
 *   • Office address (37A Archibald Road, Kelston) still rendered on contact &
 *     about — required by Google Merchant Center and LocalBusiness JSON-LD.
 *   • Cache key on footer.js + legal-config.js is `v=retail-may2026` so the new
 *     copy reaches returning browsers immediately.
 *
 * Run with: node --test tests/retail-wording-may2026.test.js
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

const SRC        = Object.fromEntries(FOOTER_LINKED_PAGES.map((p) => [p, READ(HTML(p))]));
const FOOTER_JS  = READ(JS('footer.js'));
const CONFIG_JS  = READ(JS('legal-config.js'));
const LEGAL_JS   = READ(JS('legal-page.js'));

function loadConfig() {
    const fn = new Function('window', CONFIG_JS + '\nreturn window.LegalConfig;');
    return fn({});
}

// Tokens we never want a customer to see. Each entry is { pattern, label }.
// `pattern` is a case-insensitive regex; `label` is the human reason it's banned.
const FORBIDDEN_TOKENS = [
    { pattern: /supplier[\s\-]+partners?/i,        label: '"supplier partner(s)" — implies dropship fulfilment' },
    { pattern: /wholesale\s+suppliers?/i,          label: '"wholesale supplier(s)" — names the upstream channel' },
    { pattern: /dropship(?:ping|ped)?/i,           label: '"dropship/dropshipping/dropshipped" — explicit disclosure' },
    { pattern: /drop[\s\-]ship/i,                  label: '"drop ship/drop-ship" — explicit disclosure variant' },
    { pattern: /don['’]?t\s+hold\s+stock/i,        label: '"don\'t hold stock" — admission' },
    { pattern: /do\s+not\s+hold\s+stock/i,         label: '"do not hold stock" — admission' },
    { pattern: /dispatched\s+directly\s+by/i,      label: '"dispatched directly by" — names a third-party dispatcher' },
    { pattern: /supplier[\s\-]+direct/i,           label: '"supplier-direct" — names the dropship model' },
    { pattern: /supplier[\s\-]+fulfil/i,           label: '"supplier-fulfilment" — references the binding key' },
    { pattern: /warehouse/i,                       label: '"warehouse" — false claim, we don\'t own one' },
];

function scanForbidden(haystack, sourceLabel) {
    const hits = [];
    for (const { pattern, label } of FORBIDDEN_TOKENS) {
        const m = haystack.match(new RegExp(pattern.source, 'gi'));
        if (m && m.length) hits.push(`${label} (${m.length}× in ${sourceLabel}: ${JSON.stringify(m.slice(0, 3))})`);
    }
    return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Zero forbidden tokens on any customer-facing surface
// ─────────────────────────────────────────────────────────────────────────────

test('§1 zero forbidden dropship/warehouse tokens on any footer-linked page', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        const hits = scanForbidden(SRC[page], page);
        assert.equal(hits.length, 0,
            `${page} contains banned wording:\n  - ${hits.join('\n  - ')}`);
    }
});

test('§1 zero forbidden tokens in footer.js (rendered on every page)', () => {
    const hits = scanForbidden(FOOTER_JS, 'footer.js');
    assert.equal(hits.length, 0, `footer.js contains banned wording:\n  - ${hits.join('\n  - ')}`);
});

test('§1 zero forbidden tokens in legal-config.js (renders policy bindings)', () => {
    const hits = scanForbidden(CONFIG_JS, 'legal-config.js');
    assert.equal(hits.length, 0, `legal-config.js contains banned wording:\n  - ${hits.join('\n  - ')}`);
});

test('§1 zero forbidden tokens in legal-page.js (renders policy bindings)', () => {
    const hits = scanForbidden(LEGAL_JS, 'legal-page.js');
    assert.equal(hits.length, 0, `legal-page.js contains banned wording:\n  - ${hits.join('\n  - ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — The legacy "supplier-fulfillment" binding is fully retired
// ─────────────────────────────────────────────────────────────────────────────

test('§2 LegalConfig must not export a supplierFulfillment key', () => {
    const cfg = loadConfig();
    assert.equal(cfg.supplierFulfillment, undefined,
        'LegalConfig.supplierFulfillment must be removed — the dropship disclosure is retired');
});

test('§2 legal-page.js must not declare the supplier-fulfillment binding', () => {
    assert.ok(!/supplier-fulfillment/i.test(LEGAL_JS),
        'legal-page.js must not declare a supplier-fulfillment binding');
});

test('§2 no page renders data-legal-bind="supplier-fulfillment"', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.ok(!/data-legal-bind="supplier-fulfillment"/.test(SRC[page]),
            `${page}: must not render the retired supplier-fulfillment binding`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — The #dropship anchor is gone and nothing links to it
// ─────────────────────────────────────────────────────────────────────────────

test('§3 shipping.html must not carry an #dropship section anchor', () => {
    assert.ok(!/id="dropship"/.test(SRC['shipping.html']),
        'shipping.html must not declare id="dropship" — the section is retired');
});

test('§3 no footer-linked page links to /shipping#dropship', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.ok(!/\/shipping#dropship/.test(SRC[page]),
            `${page}: must not link to the retired /shipping#dropship anchor`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — "Office:" label preserved (carried forward) — we still operate from an
//        Auckland office; this is true and remains the only neutral label.
// ─────────────────────────────────────────────────────────────────────────────

test('§4 footer.js Contact column uses "Office:" not "Address:"', () => {
    assert.match(FOOTER_JS, /<strong>Office:<\/strong>/,
        'footer.js Contact column must label the address line "Office:"');
    assert.ok(!/<strong>Address:<\/strong>/.test(FOOTER_JS),
        'footer.js must not use the bare "Address:" label');
});

test('§4 about.html hero meta uses "Office:" label', () => {
    assert.match(SRC['about.html'], /<strong>Office:<\/strong>/,
        'about.html hero meta must label the address "Office:" not "Address:"');
});

test('§4 contact.html contact-card label is "Office", not "Address"', () => {
    assert.match(SRC['contact.html'], /class="contact-card__label">Office</,
        'contact.html contact card must label the address block "Office"');
});

test('§4 no policy/about page renders a bare "<strong>Address:</strong>" label', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.ok(!/<strong>Address:<\/strong>/.test(SRC[page]),
            `${page}: must not render the bare "Address:" label — use "Office:" or omit it`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Office address still present where Merchant Center / LocalBusiness
//        JSON-LD expects to find it (carried forward from the prior contract)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the office address is still rendered on contact.html and about.html', () => {
    for (const page of ['contact.html', 'about.html']) {
        assert.match(SRC[page], /37A Archibald Road/,
            `${page}: must still render the office street address`);
        assert.match(SRC[page], /Kelston, Auckland 0602/,
            `${page}: must still render suburb + postcode`);
    }
});

test('§5 LegalConfig.address.street is unchanged (37A Archibald Road)', () => {
    const cfg = loadConfig();
    assert.equal(cfg.address.street, '37A Archibald Road');
    assert.equal(cfg.address.suburb, 'Kelston');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Cache busting: every footer-linked page must reference the new
//        retail-may2026 cache key on footer.js + legal-config.js so the
//        prior dropship disclosure cannot persist on a returning browser.
// ─────────────────────────────────────────────────────────────────────────────

test('§6 every footer-linked page loads footer.js with the current cache key', () => {
    // The cache key rides forward with every footer.js change. retail-may2026
    // shipped the retail-wording rewrite; mobile-parity-may2026 bumped it when
    // the footer link columns became <details> accordions (S0.5);
    // newsletter-feedback-jun2026 bumped it when the footer Subscribe form gained
    // an inline aria-live confirmation (ERR-052). The retail wording itself is
    // still asserted by the §1 content scan above regardless of the cache key —
    // the key only guarantees deployed clients refetch.
    for (const page of FOOTER_LINKED_PAGES) {
        assert.match(SRC[page], /\/js\/footer\.js\?v=newsletter-feedback-jun2026/,
            `${page}: must load footer.js with v=newsletter-feedback-jun2026 (bumped from mobile-parity-may2026)`);
    }
});

test('§6 every legal-binding page loads legal-config.js with v=retail-may2026', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.match(SRC[page], /\/js\/legal-config\.js\?v=retail-may2026/,
            `${page}: must load legal-config.js with v=retail-may2026`);
    }
});

test('§6 the prior dropship-may2026 cache key is gone from every page', () => {
    for (const page of FOOTER_LINKED_PAGES) {
        assert.ok(!/v=dropship-may2026/.test(SRC[page]),
            `${page}: must no longer reference the v=dropship-may2026 cache key`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Positive copy that should still be present (replaced text, not removed)
// ─────────────────────────────────────────────────────────────────────────────

test('§7 about.html "How we work" section still exists and reads as a normal retailer', () => {
    const src = SRC['about.html'];
    assert.match(src, /id="how-we-work"/,
        'about.html must keep the #how-we-work section anchor');
    // Must mention NZ-based courier networks (the customer-readable replacement
    // for the prior dropship disclosure).
    assert.match(src, /NZ\s*Post|Aramex/i,
        'about.html "How we work" must mention the NZ courier networks orders ship on');
});

test('§7 shipping.html lead text describes dispatch without naming a partner', () => {
    const src = SRC['shipping.html'];
    assert.match(src, /Tracked courier on every order/i,
        'shipping.html lead must still open with the courier promise');
    // Same-day-dispatch promise was qualified May 2026 for Google Ads
    // "Misrepresentation" compliance: Auckland-metro only, 2pm cutoff,
    // business days. See readfirst/google-ads-compliance-may2026.md.
    assert.match(src, /Auckland metro[\s\S]{0,80}\b2pm\b[\s\S]{0,80}same-day/i,
        'shipping.html lead must qualify same-day dispatch to Auckland metro before 2pm on a business day');
});

test('§7 faq.html still answers "Where do orders ship from?"', () => {
    const src = SRC['faq.html'];
    assert.match(src, /Where do orders ship from\?/,
        'faq.html must keep the "Where do orders ship from?" entry');
    // The new answer points at /shipping (no anchor) for full detail.
    assert.match(src, /href="\/shipping"/,
        'faq.html answer must link to /shipping for full detail');
});
