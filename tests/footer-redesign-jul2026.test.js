'use strict';

/**
 * FOOTER REDESIGN — Jul 2026 (footer-redesign-jul2026.md)
 * =======================================================
 * The storefront footer is rendered entirely by the frontend: js/footer.js
 * replaces the innerHTML of <footer class="site-footer">. The backend serves a
 * bare crawler-only footer of its own (prerender.js buildFooter()), and the two
 * MUST agree on the compliance copy — a Google Ads reviewer comparing the bot
 * render against the hydrated SPA reads any difference as cloaking.
 *
 * Five zones: CMYK stripe · main grid · trust strip · bottom bar · legal.
 *
 * What this file pins, and why each one is here rather than "obvious":
 *
 *   §2  LOCKED COPY. The three compliance strings, byte-for-byte, against a
 *       BACKEND_MIRROR block transcribed from the live prerender. If either
 *       side is reworded without the other, this goes red. That is the whole
 *       point — the footer's transparency line went missing for two months
 *       once already (restored 2026-07-14) and nothing caught it.
 *
 *   §3  Every footer href resolves to a real vercel.json route. A footer link
 *       that 404s is the cheapest possible way to fail a Merchant Center audit.
 *
 *   §8  PALETTE LOCK. The handoff spec shipped its own hexes, each a near-miss
 *       of a token base.css already defines. Using them would have forked the
 *       palette — footer yellow ≠ site yellow. This bans the forked values.
 *
 *   §9  DRIFT KILLER. Every page's static <footer> must be byte-identical and
 *       every page must load footer.js. Root 404.html spent months hand-rolling
 *       its own footer copy and quietly rotted: by Jul 2026 it had no legal nav
 *       and NO trademark/CGA disclaimer at all. One footer, one source, or the
 *       drift comes back.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const FOOTER_JS = read('js/footer.js');
const LAYOUT_CSS = read('css/layout.css');
const VERCEL = JSON.parse(read('vercel.json'));

// legal-config.js is a browser IIFE that assigns `root.LegalConfig` (window OR
// globalThis), so requiring it populates the global rather than module.exports.
require(path.join(INK, 'js', 'legal-config.js'));
const LEGAL = globalThis.LegalConfig;

// The rendered template — everything inside footer.innerHTML = `…`.
const TEMPLATE = (() => {
    const m = FOOTER_JS.match(/footer\.innerHTML = `([\s\S]*?)`;/);
    assert.ok(m, 'footer.js must assign footer.innerHTML from a template literal');
    return m[1];
})();

// Slice a zone out of the template so "is this link in the grid?" can't be
// accidentally satisfied by a match somewhere else in the footer.
function zone(startMarker, endMarker) {
    const a = TEMPLATE.indexOf(startMarker);
    assert.notEqual(a, -1, `template is missing ${startMarker}`);
    const b = endMarker ? TEMPLATE.indexOf(endMarker, a) : TEMPLATE.length;
    assert.notEqual(b, -1, `template is missing ${endMarker}`);
    return TEMPLATE.slice(a, b);
}

const GRID = zone('class="footer-grid"', 'class="footer-trust"');
const TRUST = zone('class="footer-trust"', 'id="google-reviews-badge"');
const BOTTOM = zone('class="footer-bottom"', 'class="footer-legal"');

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the five zones
// ─────────────────────────────────────────────────────────────────────────────

test('§1 footer renders all five zones, in order', () => {
    const order = ['footer-stripe', 'footer-main', 'footer-trust', 'footer-bottom', 'footer-legal'];
    let cursor = -1;
    for (const z of order) {
        const at = TEMPLATE.indexOf(`class="${z}"`);
        assert.notEqual(at, -1, `zone .${z} must be rendered`);
        assert.ok(at > cursor, `zone .${z} is out of order — expected ${order.join(' → ')}`);
        cursor = at;
    }
});

test('§1 the CMYK stripe is decorative and hidden from assistive tech', () => {
    assert.match(TEMPLATE, /<div class="footer-stripe" aria-hidden="true"><\/div>/);
    // It reuses the header's gradient token rather than redeclaring the ramp,
    // so the two stripes can never drift apart.
    assert.match(LAYOUT_CSS, /\.footer-stripe\s*\{[^}]*background:\s*var\(--accent-strip-gradient\)/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — LOCKED COPY (byte-identical to the backend prerender)
// ─────────────────────────────────────────────────────────────────────────────

// Transcribed verbatim from the live crawler render:
//   curl -A Googlebot https://www.inkcartridges.co.nz/
// If the backend reworders any of these, this file must change in the SAME
// release — and vice versa. They are checked for cloaking mismatch.
const BACKEND_MIRROR = {
    trademark:
        'All product, brand, and printer names (HP, Canon, Epson, Brother, and others) are trademarks of ' +
        'their respective owners and are used only to indicate compatibility. Compatible cartridges sold on ' +
        'this site are not manufactured, endorsed, or sold by those brand owners; they are supplied by ' +
        'Office Consumables Ltd, trading as InkCartridges.co.nz. Your statutory rights under the New Zealand ' +
        'Consumer Guarantees Act 1993 are unaffected.',
    legalEntity:
        'InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).',
    copyright: '© 2026 Office Consumables Ltd. All rights reserved.',
};

test('§2 trademark / CGA disclaimer is byte-identical to the backend', () => {
    // Rendered with ${TRUST.legalEntity} / ${TRUST.tradingName} interpolated, so
    // resolve those the same way footer.js does before comparing.
    const rendered = TEMPLATE
        .replace(/\$\{TRUST\.legalEntity\}/g, 'Office Consumables Ltd')
        .replace(/\$\{TRUST\.tradingName\}/g, 'InkCartridges.co.nz');
    const m = rendered.match(/<p class="footer-disclaimer">\s*([\s\S]*?)\s*<\/p>/);
    assert.ok(m, 'a .footer-disclaimer paragraph must be rendered');
    assert.equal(m[1].replace(/\s+/g, ' ').trim(), BACKEND_MIRROR.trademark,
        'footer disclaimer has drifted from the backend prerender — this is a cloaking mismatch');
});

test('§2 the names in the disclaimer come from LegalConfig, never hardcoded', () => {
    assert.match(TEMPLATE, /supplied by \$\{TRUST\.legalEntity\}, trading as \$\{TRUST\.tradingName\}\./);
});

test('§2 legal-entity line: backend sentence + the NZD/GST/surcharge sentence', () => {
    assert.equal(LEGAL.disambiguationLine(), BACKEND_MIRROR.legalEntity,
        'LegalConfig.disambiguationLine() has drifted from the backend prerender');

    // The footer renders the backend's sentence PLUS the pricing-transparency
    // sentence. Google Ads reviewers scan the footer for a surcharge-free claim
    // before they open any policy page, so the line goes here (legal-pages §2).
    const line = BOTTOM.match(/<p class="footer-legal-line">([\s\S]*?)<\/p>/);
    assert.ok(line, 'a .footer-legal-line must be rendered');
    assert.match(line[1], /data-legal-bind="disambiguation">\$\{TRUST\.disambig\}</);
    assert.match(line[1], /Prices in NZD, GST inclusive\. No card surcharges\./);
});

test('§2 copyright names the legal entity and rolls the year automatically', () => {
    assert.equal(LEGAL.copyrightLine(), BACKEND_MIRROR.copyright,
        'LegalConfig.copyrightLine() has drifted from the backend prerender');
    assert.match(BOTTOM, /<p class="footer-copyright" data-legal-bind="copyright">\s*\$\{TRUST\.copyright\}/);
});

test('§2 TRUST is built lazily, so LegalConfig is really the source of truth', () => {
    // ERR-071: TRUST used to be an IIFE evaluated at load time. footer.js and
    // legal-config.js are both `defer` (document order), so LegalConfig was
    // ALWAYS undefined and the baked-in fallbacks rendered on every page — the
    // "single source of truth" contract was fiction. Build it at initFooter()
    // time (DOMContentLoaded), by which point every deferred script has run.
    assert.match(FOOTER_JS, /function buildTrust\(\)/,
        'TRUST must be built by a function, not an IIFE at load time');
    assert.match(FOOTER_JS, /function initFooter\(\)\s*\{[\s\S]*?const TRUST = buildTrust\(\);/,
        'initFooter() must build TRUST when it runs, not when the file loads');
    assert.ok(!/const TRUST = \(function \(\) \{/.test(FOOTER_JS),
        'the eager TRUST IIFE must not come back');
});

test('§2 every page loads legal-config.js BEFORE footer.js', () => {
    // The other half of ERR-071: lazy evaluation only helps if LegalConfig has
    // actually been loaded by the time the footer mounts.
    for (const file of pagesWithFooter()) {
        const src = fs.readFileSync(file, 'utf8');
        const lc = src.search(/<script[^>]+src="\/js\/legal-config\.js/);
        const fj = src.search(/<script[^>]+src="\/js\/footer\.js/);
        const rel = path.relative(ROOT, file);
        assert.notEqual(lc, -1, `${rel} must load legal-config.js`);
        assert.notEqual(fj, -1, `${rel} must load footer.js`);
        assert.ok(lc < fj, `${rel} loads legal-config.js AFTER footer.js — LegalConfig will be undefined`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — links: the spec's columns, de-duplicated, and every href a real route
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = {
    // Drum Units (/shop?category=drums) matches the bot footer's fourth category,
    // so a crawler and a human see the same four-category set — anti-cloaking §2c.
    Shop: ['/ink-cartridges', '/toner-cartridges', '/shop?category=drums', '/ribbons', '/shop'],
    Help: ['/track-order', '/shipping', '/returns', '/faq', '/contact'],
    Company: ['/about', '/genuine-vs-compatible', '/terms', '/privacy'],
};

test('§3 the three nav columns carry exactly the links the spec lists', () => {
    for (const [heading, hrefs] of Object.entries(COLUMNS)) {
        const col = GRID.slice(
            GRID.indexOf(`<summary class="footer-column__heading">${heading}</summary>`),
            GRID.indexOf('</details>', GRID.indexOf(`>${heading}</summary>`))
        );
        assert.ok(col, `the ${heading} column must exist`);
        const found = [...col.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(found, hrefs, `the ${heading} column's links are wrong or out of order`);
    }
});

test('§3 the Shop column lists Drum Units, matching the bot footer (anti-cloaking §2c)', () => {
    // The backend prerender footer lists FOUR categories to Googlebot inside its
    // <nav aria-label="Shop by category">: Ink Cartridges · Toner Cartridges ·
    // Drum Units · Printer Ribbons. Until 2026-07-15 the human Shop column carried
    // only three of them, so a crawler saw a category link a human didn't — the
    // wrong side of a Google Ads cloaking review (the matter behind the ad
    // suspension). This asserts the fourth category is present on its own merits,
    // so removing it goes red even if the order-equality pin above is loosened.
    const col = GRID.slice(
        GRID.indexOf('<summary class="footer-column__heading">Shop</summary>'),
        GRID.indexOf('</details>', GRID.indexOf('>Shop</summary>'))
    );
    assert.match(col, /<a href="\/shop\?category=drums">Drum Units<\/a>/,
        'the Shop column must link Drum Units → /shop?category=drums so the human footer lists the same four categories the bot footer does');
});

test('§3 each nav column is a <nav> with its own accessible name', () => {
    for (const heading of Object.keys(COLUMNS)) {
        assert.match(GRID, new RegExp(`<nav class="footer-column-nav" aria-label="${heading}">`),
            `the ${heading} column must be a landmark with an accessible name`);
    }
});

test('§3 every footer href resolves to a real vercel.json route', () => {
    // A dead footer link is the cheapest possible way to fail a Merchant Center
    // audit, and the footer ships on all 34 pages.
    const routes = new Set((VERCEL.rewrites || []).map((r) => r.source));
    const hrefs = [...TEMPLATE.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const href of new Set(hrefs)) {
        if (href === '/') continue; // the brand logo
        // A query string (e.g. /shop?category=drums) resolves via the base route's
        // rewrite — vercel passes the query through — so match on the path only.
        const routePath = href.split('?')[0];
        assert.ok(routes.has(routePath), `footer links to ${href}, which is not a route in vercel.json`);
    }
});

test('§3 the Shop column is STATIC — footer.js never fetches the nav feed', () => {
    // The feed-hydrated Categories column (GET /api/site/nav) was killed on
    // 2026-07-02 and must not come back. These four links are hand-curated.
    assert.ok(!/getSiteNav|fetch\(|api\/site\/nav/i.test(TEMPLATE));
    assert.ok(!FOOTER_JS.includes('footer-categories-links'));
});

test('§3 the duplicate single-line legal nav is gone, and the columns still carry every policy link', () => {
    // The row was restored on 2026-07-14 and removed again the same day on the
    // owner's call: every href in it was already one click away in the Help +
    // Company columns, so it was duplication, not coverage. The compliance
    // invariant was never "there is a legal row" — it is "an ads reviewer can
    // reach every policy surface from the footer". Assert THAT, so deleting a
    // column link goes red even though the row is gone.
    assert.ok(!FOOTER_JS.includes('footer-legal-nav'),
        'the duplicate legal-nav row must not come back — the columns already cover it');
    for (const href of ['/terms', '/privacy', '/returns', '/shipping', '/genuine-vs-compatible', '/about', '/faq', '/contact']) {
        assert.match(FOOTER_JS, new RegExp(`href="${href}"`),
            `the footer must still link to ${href} from a column`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — payment chips
// ─────────────────────────────────────────────────────────────────────────────

const CANONICAL_PAYMENTS = ['Visa', 'Mastercard', 'American Express', 'PayPal', 'Google Pay', 'Apple Pay', 'Klarna'];

test('§4 all seven payment chips, uniformly sized, none invented', () => {
    const chips = [...BOTTOM.matchAll(/<svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="([^"]+)">/g)]
        .map((m) => m[1]);
    assert.deepEqual(chips, CANONICAL_PAYMENTS, 'the payment chip set has changed');

    // "Uniform white chips, same treatment for all" — the old set mixed a blue
    // Amex tile and a pink Klarna tile in among white cards.
    const rects = [...BOTTOM.matchAll(/<rect width="48" height="30" rx="(\d+)" fill="([^"]+)"/g)];
    assert.equal(rects.length, CANONICAL_PAYMENTS.length, 'every chip needs the same base plate');
    for (const [, rx, fill] of rects) {
        assert.equal(rx, '5', 'every chip shares one corner radius');
        assert.equal(fill, '#FFFFFF', 'every chip is a white card');
    }
    assert.match(LAYOUT_CSS, /\.pay-card\s*\{[^}]*height:\s*26px/s);
});

test('§4 the footer advertises no payment method the site does not offer', () => {
    assert.ok(!/afterpay|laybuy|zip pay|amex express checkout/i.test(TEMPLATE));
});

test('§4 the WE ACCEPT label is an eyebrow, not a sentence', () => {
    assert.match(BOTTOM, /<span class="footer-payment__label">We accept<\/span>/);
    assert.match(LAYOUT_CSS, /\.footer-payment__label\s*\{[^}]*white-space:\s*nowrap/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — trust strip
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_ITEMS = [
    ['NZ-based support', 'Talk to a real person'],
    ['Tracked NZ-wide delivery', 'Every order, door to door'],
    ['Secure checkout', 'Encrypted &amp; card-safe'],
    ['15% GST included', 'Prices in NZD, no surprises'],
];

test('§5 four trust items, each a bold headline over a muted subline', () => {
    const heads = [...TRUST.matchAll(/<span class="footer-trust__headline">([^<]+)<\/span>/g)].map((m) => m[1]);
    const subs = [...TRUST.matchAll(/<span class="footer-trust__subline">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(heads, TRUST_ITEMS.map((i) => i[0]));
    assert.deepEqual(subs, TRUST_ITEMS.map((i) => i[1]));
});

test('§5 trust icons are decorative; the strip is a list on an elevated band', () => {
    const icons = [...TRUST.matchAll(/<svg class="footer-trust__icon" aria-hidden="true"/g)];
    assert.equal(icons.length, 4, 'each trust icon must be aria-hidden — the text carries the meaning');
    assert.match(TRUST, /<ul class="footer-trust__list">/);
    assert.match(LAYOUT_CSS, /\.footer-trust\s*\{[^}]*background:\s*var\(--footer-raised\)[\s\S]*?border-top:[\s\S]*?border-bottom:/s);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — accessibility
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the contact block is an <address> with a labelled <dl>', () => {
    assert.match(GRID, /<address class="footer-contact">[\s\S]*?<dl class="footer-contact__list">/);
    for (const label of ['Office', 'Phone', 'Email', 'Hours']) {
        assert.match(GRID, new RegExp(`<dt>${label}</dt>`), `the contact block must label ${label}`);
    }
    assert.match(GRID, /href="tel:\$\{TRUST\.phoneE164\}"/);
    assert.match(GRID, /href="mailto:\$\{TRUST\.email\}"/);
    // Phone digits line up when they're tabular.
    assert.match(LAYOUT_CSS, /\.footer-contact__digits\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
});

test('§6 every interactive element in the footer has a visible focus ring', () => {
    assert.match(LAYOUT_CSS,
        /\.site-footer a:focus-visible,\s*\.site-footer button:focus-visible,\s*\.site-footer input:focus-visible,\s*\.site-footer summary:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--footer-accent\)[^}]*outline-offset/s,
        'links, buttons, the email input and the accordion summaries all need a 2px accent ring');
});

test('§6 transitions are disabled under prefers-reduced-motion', () => {
    assert.match(LAYOUT_CSS,
        /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.site-footer \*[\s\S]*?transition: none/s);
});

test('§6 the nav columns stay keyboard-operable <details> accordions on mobile', () => {
    // Kept from the mobile-parity work: the stacked footer was a 2,081px wall.
    // The redesign moved Contact to LAST, so the "open on mobile" column can no
    // longer be found by index — footer.js reads which <details> shipped `open`.
    assert.match(FOOTER_JS, /let defaultOpen = 0;[\s\S]*?items\.forEach\(\(d, i\) => \{ if \(d\.open\) defaultOpen = i; \}\);/,
        'syncFooterAccordions must find the default-open column, not assume index 0');
    assert.match(FOOTER_JS, /d\.open = mq\.matches \? i === defaultOpen : true;/);
    assert.match(TEMPLATE, /<details class="footer-column" data-footer-accordion open>\s*<summary class="footer-column__heading">Contact<\/summary>/,
        'Contact is the column that stays open on a phone');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — responsive
// ─────────────────────────────────────────────────────────────────────────────

test('§7 grid is 5-up, then 2-up at 940px, then 1-up at 560px', () => {
    assert.match(LAYOUT_CSS, /\.footer-grid\s*\{[^}]*grid-template-columns:\s*2fr repeat\(3, 1fr\) 1\.3fr/s,
        'brand widest · 3 nav columns · contact');

    const at940 = LAYOUT_CSS.slice(LAYOUT_CSS.indexOf('@media (max-width: 940px)'));
    assert.match(at940, /\.footer-grid\s*\{\s*grid-template-columns:\s*repeat\(2, 1fr\)/s);
    assert.match(at940, /\.footer-brand,\s*\.footer-grid > \.footer-column\s*\{\s*grid-column:\s*1 \/ -1/s,
        'brand and contact each span the full width at 940px');
    assert.match(at940, /\.footer-trust__list\s*\{\s*grid-template-columns:\s*repeat\(2, 1fr\)/s,
        'trust strip goes 2-up at 940px');

    const at560 = LAYOUT_CSS.slice(LAYOUT_CSS.indexOf('@media (max-width: 560px)'));
    assert.match(at560, /\.footer-grid\s*\{\s*grid-template-columns:\s*1fr/s);
    assert.match(at560, /\.footer-trust__list\s*\{\s*grid-template-columns:\s*1fr/s, 'trust strip stacks 1-up');
    assert.match(at560, /\.footer-bottom__row\s*\{\s*flex-direction:\s*column/s, 'bottom bar stacks');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — PALETTE LOCK
// ─────────────────────────────────────────────────────────────────────────────

test('§8 the footer palette is sourced from the brand tokens', () => {
    const block = LAYOUT_CSS.slice(
        LAYOUT_CSS.indexOf('.site-footer {'),
        LAYOUT_CSS.indexOf('/* ==========================================================================\n   MAIN CONTENT LAYOUT')
    );
    assert.match(block, /--footer-ground:\s*var\(--ink-wash\)/);
    assert.match(block, /--footer-accent:\s*var\(--yellow-primary\)/);
    assert.match(block, /--footer-raised:\s*var\(--ink-wash-light\)/);
    assert.match(block, /background:\s*var\(--accent-strip-gradient\)/,
        'the CMYK stripe reuses the header stripe token — it must not redeclare the ramp');
});

test('§8 the spec\'s forked hexes never made it into the stylesheet', () => {
    // The handoff shipped --accent #F5C542, cyan #27AAE1, magenta #E6318C,
    // --ink-900 #0C1826. Every one is a near-miss of a token base.css already
    // has (#F4C430 / #267FB5 / #C71F6E / #0C1222). Shipping them literally would
    // mean the footer's yellow is not the site's yellow and the footer's stripe
    // does not match the header's — a palette fork nobody would ever notice in
    // review, and nobody could ever un-ship cleanly.
    // Scan declarations only — the comment above .site-footer quotes the spec's
    // hexes to explain why they were rejected, and that must not trip the guard.
    const declarations = LAYOUT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const hex of ['#F5C542', '#27AAE1', '#E6318C', '#0C1826', '#FFD35C', '#1A1305', '#8595A4', '#61707E']) {
        assert.ok(!new RegExp(hex, 'i').test(declarations),
            `layout.css declares ${hex} — that is the handoff spec's forked palette, not the brand palette`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — DRIFT KILLER: one footer, one source
// ─────────────────────────────────────────────────────────────────────────────

function walkHtml(dir, acc = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!['node_modules', '.git', '.vercel', 'scripts', 'admin'].includes(e.name)) walkHtml(p, acc);
        } else if (e.name.endsWith('.html')) {
            acc.push(p);
        }
    }
    return acc;
}

function pagesWithFooter() {
    return walkHtml(INK).filter((f) => fs.readFileSync(f, 'utf8').includes('<footer class="site-footer">'));
}

test('§9 every page ships the SAME static footer — byte-identical, no exceptions', () => {
    // Root 404.html hand-rolled its own ~80-line footer for months because it
    // was the one page that never loaded footer.js. It drifted exactly as you'd
    // expect: no legal nav, and NO trademark/CGA disclaimer at all — the page a
    // lost visitor lands on was the least compliant page on the site. This is
    // the assertion that stops a second copy of the footer ever existing.
    const pages = pagesWithFooter();
    assert.ok(pages.length >= 30, `expected the footer on 30+ pages, found ${pages.length}`);

    const byHash = new Map();
    for (const file of pages) {
        const src = fs.readFileSync(file, 'utf8');
        const m = src.match(/<footer class="site-footer">[\s\S]*?<\/footer>/);
        assert.ok(m, `${path.relative(ROOT, file)} has no <footer> block`);
        const h = crypto.createHash('sha256').update(m[0]).digest('hex').slice(0, 12);
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(path.relative(ROOT, file));
    }

    if (byHash.size !== 1) {
        const table = [...byHash.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .map(([h, files]) => `  ${h} ← ${files.length} page(s): ${files.slice(0, 4).join(', ')}${files.length > 4 ? ', …' : ''}`)
            .join('\n');
        assert.fail(`the static footer is not byte-identical across pages:\n${table}`);
    }
});

test('§9 the static footer is a noscript fallback only — the real one comes from footer.js', () => {
    const src = fs.readFileSync(pagesWithFooter()[0], 'utf8');
    const block = src.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
    assert.match(block, /^<footer class="site-footer"><noscript>[\s\S]*<\/noscript><\/footer>$/,
        'the static footer must contain nothing but the noscript fallback');
    // The fallback still has to carry the transparency facts for a no-JS crawler.
    assert.match(block, /Office Consumables Ltd \(NZBN 9429033934204, GST 94-509-459\)/);
    assert.match(block, /support@inkcartridges\.co\.nz/);
    assert.match(block, /Kelston/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — things the redesign must not have dropped
// ─────────────────────────────────────────────────────────────────────────────

test('§10 all three JSON-LD blocks survive the redesign', () => {
    for (const id of ['site-jsonld-organization', 'site-jsonld-website', 'site-jsonld-localbusiness']) {
        assert.match(TEMPLATE, new RegExp(`id="${id}"`), `${id} must still be emitted`);
    }
    // Structured data that disagrees with the bot render reads as cloaking.
    assert.match(TEMPLATE, /"legalName": "\$\{TRUST\.legalEntity\}"/);
    assert.match(TEMPLATE, /"propertyID": "NZBN", "value": "\$\{TRUST\.nzbn\}"/);
});

test('§10 the Google Customer Reviews badge still has its mount point', () => {
    assert.match(TEMPLATE, /<div id="google-reviews-badge"><\/div>/);
    assert.match(FOOTER_JS, /gapi\.ratingbadge\.render/);
});

test('§10 the newsletter form is intact, and still Turnstile-free', () => {
    assert.match(TEMPLATE, /<form class="newsletter__form footer-newsletter__form" novalidate>/);
    assert.match(TEMPLATE, /id="footer-newsletter-email"[^>]*autocomplete="email"/);
    assert.match(TEMPLATE, /<div class="newsletter-feedback" role="status" aria-live="polite" hidden><\/div>/);
    assert.match(FOOTER_JS, /bindNewsletterForm\(footer\.querySelector\('\.newsletter__form'\), 'footer'\)/);
    // The handoff spec called the endpoint "Turnstile-gated". It isn't: the
    // backend made the token optional in Jun 2026 and the footer form ships no
    // widget host, so no token is ever sent. Pinned in newsletter-subscribe-*.
    assert.ok(!TEMPLATE.includes('data-newsletter-turnstile'));
});
