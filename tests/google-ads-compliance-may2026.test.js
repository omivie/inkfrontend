/**
 * Google Ads "Unacceptable Business Practices" remediation contract —
 * May 2026
 * ==========================================================================
 *
 * The backend (ink_backend) and the frontend SPA both serve the same URLs.
 * Google fetches every page TWICE — once as a bot (sees the backend
 * prerender) and once as a real browser (sees the SPA-rendered HTML). If
 * the two disagree on any load-bearing fact (legal entity, NZBN, GST,
 * address, phone, support email, marketing claims, JSON-LD), Google treats
 * the difference as cloaking and the appeal fails.
 *
 * This file pins the SPA half of the contract. The backend half lives in
 * ink_backend/src/utils/trustSignals.js + __tests__/ai-seo-readiness.test.js.
 *
 * Source spec: readfirst/google-ads-compliance-may2026.md
 * (mirrors backend hand-off: /Users/matcha/Downloads/frontend-google-ads-fixes.md)
 *
 * Run: node --test tests/google-ads-compliance-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const HTML = (rel) => path.join(INK, rel);
const JS = (rel) => path.join(INK, 'js', rel);
const CSS = (rel) => path.join(INK, 'css', rel);
const READ = (abs) => fs.readFileSync(abs, 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// Canonical business-fact table — mirrors backend trustSignals.js exactly.
// Every value below MUST be present in legal-config.js and the static
// JSON-LD blocks on the home page + footer.
// ─────────────────────────────────────────────────────────────────────────
const FACTS = {
    legalEntity:    'Office Consumables Ltd',
    tradingName:    'InkCartridges.co.nz',
    nzbn:           '9429033934204',
    gstNumber:      '94-509-459',
    email:          'support@inkcartridges.co.nz',
    phoneDisplay:   '027 474 0115',
    phoneE164:      '+64274740115',
    phoneSchema:    '+64-27-474-0115',
    addressStreet:  '37A Archibald Road',
    addressSuburb:  'Kelston',
    addressCity:    'Auckland',
    addressPost:    '0602',
    disambiguation: 'InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).',
    returnFaultyDays: 30,
    returnChangeDays: 14,
    compatibleWarrantyMonths: 12,
    dispatchHourNZ:   2,           // 2pm cutoff (NOT 12pm)
};

// ─────────────────────────────────────────────────────────────────────────
// Forbidden phrases — Google Ads "Misrepresentation" / "Unacceptable
// Business Practices" triggers. Stored case-sensitively where the
// capitalisation matters for marketing impact (eg. "Lowest Price" the
// product badge), case-insensitively for headline / FAQ copy.
// ─────────────────────────────────────────────────────────────────────────
const FORBIDDEN = [
    // §1 hero / superlatives
    /save up to/i,
    /up to 70%/i,
    /\b70% off\b/i,
    /guaranteed cheapest/i,
    /lowest price (in )?nz/i,
    /lowest in nz/i,
    /\b#1 in nz\b/i,
    /best price guaranteed/i,
    /beat any price/i,

    // §3 trust badges
    /\bbeat genuine\b/i,
    /\b100% safe\b/i,
    /\brisk[- ]free\b/i,

    // §5/§6 marketing claims
    /identical to genuine/i,
    /same as genuine/i,
    /\bwon['’]?t void (your|the|my)? ?(printer )?warranty\b/i,

    // §7/§8 urgency
    /\blimited[- ]time offer\b/i,
    /\btoday only\b/i,
    /\bhurry,? (this )?offer\b/i,
    /\bexpires? soon\b/i,
    /wait! ?don['’]?t miss/i,
    /sale ends in \[/i,
    /\bsarah from auckland\b/i,
    /\bjust (bought|purchased) (this|it)\b/i,
    /\bviewing (now|right now)\b/i,
    /\bpeople are viewing\b/i,

    // §7 newsletter pressure
    /\bexclusive deals?\b/i,
    /\bexclusive offers?\b/i,
    /\blowest prices? first\b/i,
    /\bsave big\b/i,

    // §coordination: stale email / phone / address
    /inkandtoner@windowslive\.com/i,
    /\b2 Queen Street\b/i,
    /09[ -]?813[ -]?3?882?/,
];

const FILES_TO_SCAN = [
    HTML('index.html'),
    HTML('404.html'),
    HTML('html/index.html'),
    HTML('html/about.html'),
    HTML('html/returns.html'),
    HTML('html/contact.html'),
    HTML('html/privacy.html'),
    HTML('html/terms.html'),
    HTML('html/shipping.html'),
    HTML('html/faq.html'),
    HTML('html/shop.html'),
    HTML('html/ribbons.html'),
    HTML('html/cart.html'),
    HTML('html/checkout.html'),
    HTML('html/payment.html'),
    HTML('html/order-confirmation.html'),
    HTML('html/account/login.html'),
    HTML('html/account/forgot-password.html'),
    HTML('html/account/reset-password.html'),
    HTML('html/account/index.html'),
    HTML('html/account/orders.html'),
    HTML('html/account/order-detail.html'),
    HTML('html/account/addresses.html'),
    HTML('html/account/personal-details.html'),
    HTML('html/account/printers.html'),
    HTML('html/account/favourites.html'),
    HTML('html/account/loyalty.html'),
    HTML('html/account/track-order.html'),
    HTML('html/account/settings.html'),
    HTML('html/account/verify-email.html'),
    HTML('html/product/index.html'),
    JS('footer.js'),
    JS('legal-config.js'),
    JS('legal-page.js'),
    JS('products.js'),
    JS('shop-page.js'),
    JS('ribbons-page.js'),
    JS('product-detail-page.js'),
    JS('landing.js'),
    CSS('components.css'),
    CSS('search.css'),
    CSS('pages.css'),
];

// ─────────────────────────────────────────────────────────────────────────
// §1. No forbidden copy anywhere.
// ─────────────────────────────────────────────────────────────────────────
// Strip JS/CSS comments + HTML comments before scanning. Forbidden phrases
// in code comments are intentional guard prose, not user-visible copy.
function stripComments(src, ext) {
    let s = src;
    if (ext === '.js' || ext === '.css') {
        // Block comments first, then line comments. Naive but sufficient
        // — we're scanning static repo source, not preserving semantics.
        s = s.replace(/\/\*[\s\S]*?\*\//g, '');
        if (ext === '.js') {
            s = s.replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
        }
    } else if (ext === '.html') {
        s = s.replace(/<!--[\s\S]*?-->/g, '');
    }
    return s;
}

for (const filePath of FILES_TO_SCAN) {
    test(`forbidden-copy sweep: ${path.relative(ROOT, filePath)}`, () => {
        let src;
        try {
            src = READ(filePath);
        } catch (e) {
            assert.fail(`Expected file to exist: ${filePath} (${e.code})`);
            return;
        }
        const clean = stripComments(src, path.extname(filePath));
        for (const rx of FORBIDDEN) {
            const m = clean.match(rx);
            if (m) {
                const idx = clean.indexOf(m[0]);
                const ctx = clean.slice(Math.max(0, idx - 40), Math.min(clean.length, idx + m[0].length + 40));
                assert.fail(`Forbidden pattern ${rx} found in ${path.relative(ROOT, filePath)}: …${ctx.replace(/\s+/g, ' ').trim()}…`);
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §2. legal-config.js carries the canonical facts.
// ─────────────────────────────────────────────────────────────────────────
const LEGAL_CFG_SRC = READ(JS('legal-config.js'));

test('legal-config.js sets legalEntity = Office Consumables Ltd', () => {
    assert.match(LEGAL_CFG_SRC, /legalEntity:\s*['"]Office Consumables Ltd['"]/);
});
test('legal-config.js sets tradingName = InkCartridges.co.nz', () => {
    assert.match(LEGAL_CFG_SRC, /tradingName:\s*['"]InkCartridges\.co\.nz['"]/);
});
test('legal-config.js sets nzbn = 9429033934204', () => {
    assert.match(LEGAL_CFG_SRC, /nzbn:\s*['"]9429033934204['"]/);
});
test('legal-config.js sets gstNumber = 94-509-459 (with dashes)', () => {
    assert.match(LEGAL_CFG_SRC, /gstNumber:\s*['"]94-509-459['"]/);
});
test('legal-config.js sets email = support@inkcartridges.co.nz', () => {
    assert.match(LEGAL_CFG_SRC, /email:\s*['"]support@inkcartridges\.co\.nz['"]/);
});
test('legal-config.js sets privacyOfficerEmail = support@inkcartridges.co.nz', () => {
    assert.match(LEGAL_CFG_SRC, /privacyOfficerEmail:\s*['"]support@inkcartridges\.co\.nz['"]/);
});
test('legal-config.js carries a 30-day change-of-mind returnWindowDaysChange', () => {
    // Aligned to 30 days on 2026-07-07 to match backend SITE_CHANGE_OF_MIND_DAYS
    // (owner decision) so /api/site/trust.returns.change_of_mind_days agrees.
    assert.match(LEGAL_CFG_SRC, /returnWindowDaysChange:\s*30/);
});
test('legal-config.js carries a 30-day faulty-goods returnWindowDaysFaulty', () => {
    assert.match(LEGAL_CFG_SRC, /returnWindowDaysFaulty:\s*30/);
});
test('legal-config.js carries the 12-month compatible-warranty constant', () => {
    assert.match(LEGAL_CFG_SRC, /compatibleWarrantyMonths:\s*12/);
});
test('legal-config.js exposes disambiguationLine() helper', () => {
    assert.match(LEGAL_CFG_SRC, /disambiguationLine\s*:\s*function\b/);
});
test('legal-config.js handlingTime mentions 2pm + Auckland metro qualifier', () => {
    const re = /handlingTime:\s*['"][^'"]*\b2(?::00)?pm[^'"]*Auckland metro[^'"]*['"]/i;
    const reAlt = /handlingTime:\s*['"][^'"]*Auckland metro[^'"]*\b2(?::00)?pm[^'"]*['"]/i;
    assert.ok(re.test(LEGAL_CFG_SRC) || reAlt.test(LEGAL_CFG_SRC),
        'handlingTime must mention both "2pm" and "Auckland metro"');
});

// ─────────────────────────────────────────────────────────────────────────
// §3. footer.js — disambiguation, copyright, legalName JSON-LD.
// ─────────────────────────────────────────────────────────────────────────
const FOOTER_SRC = READ(JS('footer.js'));

test('footer.js declares the TRUST fallback constants', () => {
    assert.match(FOOTER_SRC, /legalEntity[^,]*Office Consumables Ltd/);
    assert.match(FOOTER_SRC, /nzbn[^,]*9429033934204/);
    assert.match(FOOTER_SRC, /gstNumber[^,]*94-509-459/);
    assert.match(FOOTER_SRC, /support@inkcartridges\.co\.nz/);
});
test('footer.js renders the disambiguation line element', () => {
    assert.match(FOOTER_SRC, /data-legal-bind="disambiguation"/);
});
test('footer.js Organization JSON-LD carries legalName + alternateName + email', () => {
    assert.match(FOOTER_SRC, /"@type":\s*"Organization"/);
    assert.match(FOOTER_SRC, /"legalName":\s*"\$\{TRUST\.legalEntity\}"/);
    assert.match(FOOTER_SRC, /"alternateName":\s*"\$\{TRUST\.tradingName\}"/);
    assert.match(FOOTER_SRC, /"email":\s*"\$\{TRUST\.email\}"/);
});
test('footer.js LocalBusiness JSON-LD carries NZBN + GST identifiers', () => {
    assert.match(FOOTER_SRC, /"@type":\s*"LocalBusiness"/);
    assert.match(FOOTER_SRC, /"identifier":\s*\[/);
    assert.match(FOOTER_SRC, /"propertyID":\s*"NZBN"/);
    assert.match(FOOTER_SRC, /"propertyID":\s*"GST"/);
});

// ─────────────────────────────────────────────────────────────────────────
// §4. legal-page.js — exposes the new bindings.
// ─────────────────────────────────────────────────────────────────────────
const LEGAL_PAGE_SRC = READ(JS('legal-page.js'));

for (const key of ['disambiguation', 'legal-entity', 'nzbn', 'gst-number',
                   'copyright', 'return-window-faulty', 'return-window-change',
                   'compatible-warranty', 'dispatch-cutoff']) {
    test(`legal-page.js binds [data-legal-bind="${key}"]`, () => {
        const rx = new RegExp(`['"\`]${key}['"\`]\\s*:`);
        assert.match(LEGAL_PAGE_SRC, rx);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §5. Static JSON-LD on the homepage — Organization / LocalBusiness must
// name the legal entity, carry legalName + alternateName + email +
// NZBN/GST identifiers. The two index.html copies (root + html/) both
// ship as static prerenders.
// ─────────────────────────────────────────────────────────────────────────
for (const rel of ['index.html', 'html/index.html']) {
    const src = READ(HTML(rel));
    test(`${rel}: Organization JSON-LD names Office Consumables Ltd as legalName`, () => {
        assert.match(src, /"@type":\s*"Organization"/);
        assert.match(src, /"legalName":\s*"Office Consumables Ltd"/);
        assert.match(src, /"alternateName":\s*"InkCartridges\.co\.nz"/);
    });
    test(`${rel}: Organization JSON-LD carries NZBN + GST identifier objects`, () => {
        assert.match(src, /"propertyID":\s*"NZBN"[^}]*"value":\s*"9429033934204"/);
        assert.match(src, /"propertyID":\s*"GST"[^}]*"value":\s*"94-509-459"/);
    });
    test(`${rel}: Organization JSON-LD carries canonical support email`, () => {
        assert.match(src, /"email":\s*"support@inkcartridges\.co\.nz"/);
    });
}

// LocalBusiness only present in inkcartridges/index.html (richer schema set)
test('index.html: LocalBusiness JSON-LD names Office Consumables Ltd', () => {
    const src = READ(HTML('index.html'));
    assert.match(src, /"@type":\s*"LocalBusiness"[\s\S]{0,200}"legalName":\s*"Office Consumables Ltd"/);
});

// ─────────────────────────────────────────────────────────────────────────
// §6. Disambiguation line is present on every legal-page hero. We don't
// require it on every account/transactional page (footer carries it
// there) — but the bot-crawled SEO pages must show it inline.
// ─────────────────────────────────────────────────────────────────────────
const LEGAL_PAGE_FILES = [
    'html/about.html',
    'html/returns.html',
    'html/contact.html',
    'html/privacy.html',
    'html/terms.html',
    'html/shipping.html',
    'html/faq.html',
];
for (const rel of LEGAL_PAGE_FILES) {
    const src = READ(HTML(rel));
    test(`${rel}: hero / first section renders the disambiguation line`, () => {
        assert.match(src, /data-legal-bind="disambiguation"/,
            `${rel} must carry an inline [data-legal-bind="disambiguation"] anchor`);
        // And the fallback text must be the exact backend sentence.
        assert.match(src, /InkCartridges\.co\.nz is operated by Office Consumables Ltd \(NZBN 9429033934204, GST 94-509-459\)\./);
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §7. /about — required content (mirrors backend prerender).
// ─────────────────────────────────────────────────────────────────────────
const ABOUT_SRC = READ(HTML('html/about.html'));

test('/about includes a "Business Details" section with NZBN + GST', () => {
    assert.match(ABOUT_SRC, /Business details/i);
    assert.match(ABOUT_SRC, /data-legal-bind="nzbn"/);
    assert.match(ABOUT_SRC, /data-legal-bind="gst-number"/);
});
test('/about includes a Consumer Rights section linking to /returns', () => {
    assert.match(ABOUT_SRC, /Consumer rights/i);
    assert.match(ABOUT_SRC, /href="\/returns"/);
});
test('/about includes a Where We Ship section', () => {
    assert.match(ABOUT_SRC, /Where we ship/i);
});
test('/about references the 12-month compatible warranty', () => {
    assert.match(ABOUT_SRC, /data-legal-bind="compatible-warranty"/);
});

// ─────────────────────────────────────────────────────────────────────────
// §8. /returns — change-of-mind window is 30 days, faulty is 30 days.
// ─────────────────────────────────────────────────────────────────────────
const RETURNS_SRC = READ(HTML('html/returns.html'));

test('/returns binds the change-of-mind window', () => {
    assert.match(RETURNS_SRC, /data-legal-bind="return-window-change"/);
});
test('/returns binds the 30-day faulty window', () => {
    assert.match(RETURNS_SRC, /data-legal-bind="return-window-faulty"/);
});
test('/returns lists the 12-month compatible-warranty in the snapshot', () => {
    assert.match(RETURNS_SRC, /data-legal-bind="compatible-warranty"/);
});
test('/returns address block names Office Consumables Ltd', () => {
    assert.match(RETURNS_SRC, /data-legal-bind="legal-entity"/);
});

// ─────────────────────────────────────────────────────────────────────────
// §9. "Lowest Price" badge fully retired from card render code.
// ─────────────────────────────────────────────────────────────────────────
test('products.js does NOT render the Lowest Price comparative badge', () => {
    const src = READ(JS('products.js'));
    assert.doesNotMatch(src, /product-card__badge--lowest-price/);
    assert.doesNotMatch(src, /is_lowest_in_market/);
});
test('shop-page.js does NOT render the Lowest Price comparative badge', () => {
    const src = READ(JS('shop-page.js'));
    assert.doesNotMatch(src, /product-card__badge--lowest-price/);
    assert.doesNotMatch(src, /is_lowest_in_market/);
});

// ─────────────────────────────────────────────────────────────────────────
// §10. PDP emits ZERO client-side Product/Breadcrumb/FAQ JSON-LD.
// (Backend prerender is authoritative; client-side injection would risk
//  brand.name divergence between bot- and SPA-rendered HTML.)
// ─────────────────────────────────────────────────────────────────────────
test('product-detail-page.js carries no client-side Product/FAQ JSON-LD', () => {
    const src = READ(JS('product-detail-page.js'));
    // Must not CALL Schema.injectProduct(...) or DEFINE updateProductSchema(...).
    // A comment referencing the deleted helpers is allowed (it's the guard).
    assert.doesNotMatch(src, /Schema\.injectProduct\s*\(/);
    assert.doesNotMatch(src, /\bupdateProductSchema\s*(?:[:(]|\s*=\s*function)/);
    // The protective comment must remain so a future editor doesn't
    // re-introduce client-side schema emission.
    assert.match(src, /do not re-introduce[\s\S]{0,80}client-side Product/i);
});

// ─────────────────────────────────────────────────────────────────────────
// §11. NoScript footer fallback names Office Consumables Ltd
// (Google's bot may render with JS disabled — the noscript footer is the
// only bot-visible disambiguation if footer.js never runs.)
// ─────────────────────────────────────────────────────────────────────────
// inkcartridges/404.html ships a fully-rendered static footer (no noscript
// fallback — it's served as a hard 404 before any JS runs), so it gets its
// own dedicated assertion below.
const NOSCRIPT_FILES = [
    'index.html', 'html/index.html', 'html/404.html',
    'html/about.html', 'html/contact.html', 'html/returns.html',
    'html/terms.html', 'html/privacy.html', 'html/shipping.html',
    'html/faq.html', 'html/shop.html', 'html/ribbons.html',
    'html/cart.html', 'html/checkout.html', 'html/payment.html',
    'html/order-confirmation.html',
];
for (const rel of NOSCRIPT_FILES) {
    const src = READ(HTML(rel));
    test(`${rel}: noscript footer names Office Consumables Ltd + support email`, () => {
        // Each page has exactly one noscript footer and it must carry the
        // disambiguation sentence + the new email + the Kelston address.
        assert.match(src, /<footer class="site-footer"><noscript>[\s\S]*?Office Consumables Ltd[\s\S]*?support@inkcartridges\.co\.nz[\s\S]*?Kelston[\s\S]*?<\/footer>/);
    });
}

test('inkcartridges/404.html static footer carries the disambiguation line + new copyright', () => {
    const src = READ(HTML('404.html'));
    assert.match(src, /Office Consumables Ltd\. All rights reserved\./);
    assert.match(src, /InkCartridges\.co\.nz is operated by Office Consumables Ltd \(NZBN 9429033934204, GST 94-509-459\)\./);
    assert.match(src, /support@inkcartridges\.co\.nz/);
    assert.match(src, /Kelston/);
});
