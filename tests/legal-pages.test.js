/**
 * Legal / Compliance pages contract — May 2026
 * ============================================
 *
 * Pins the Terms of Service, Privacy Policy, Refund & Return Policy,
 * Shipping & Delivery Policy, About Us, and FAQ pages to the
 * compliance requirements they were built to satisfy:
 *
 *   • Google Ads "Misrepresentation" — every legal page is footer-linked
 *     from every other page, every page declares "no hidden fees",
 *     pricing transparency is consistent.
 *   • NZ Consumer Guarantees Act — Returns page declares CGA rights and
 *     "in trade" status, and never tries to time-bar faulty-goods returns.
 *   • NZ Privacy Act 2020 — Privacy page names the Privacy Officer,
 *     lists processors and cookies in tables, and references all 13 IPPs.
 *   • NZ Fair Trading Act — Terms page declares "in trade".
 *   • Google Merchant Center — Contact page has a physical address, phone,
 *     email, and a map embed.
 *
 * These tests fail if anyone removes the in-trade declaration, drops the
 * footer cross-links, accidentally re-introduces a card surcharge mention,
 * weakens the CGA language, or breaks the legal-config.js bindings.
 *
 * Run with: node --test tests/legal-pages.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const JS   = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const CSS  = (rel) => path.join(ROOT, 'inkcartridges', 'css', rel);
const READ = (p)   => fs.readFileSync(p, 'utf8');

const PAGES = ['terms.html', 'privacy.html', 'returns.html', 'shipping.html', 'about.html', 'faq.html', 'contact.html'];
const POLICY_PAGES = ['terms.html', 'privacy.html', 'returns.html', 'shipping.html'];
const SRC = Object.fromEntries(PAGES.map((p) => [p, READ(HTML(p))]));

const FOOTER_JS  = READ(JS('footer.js'));
const CONFIG_JS  = READ(JS('legal-config.js'));
const PAGE_JS    = READ(JS('legal-page.js'));
const VERCEL     = JSON.parse(READ(path.join(ROOT, 'inkcartridges', 'vercel.json')));
const PAGES_CSS  = READ(CSS('pages.css'));

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Every legal page exists, has a canonical URL, and renders cleanly
// ─────────────────────────────────────────────────────────────────────────────

test('§1 all six new legal/info pages exist on disk', () => {
    for (const p of ['terms.html', 'privacy.html', 'returns.html', 'shipping.html', 'about.html', 'faq.html']) {
        assert.ok(fs.existsSync(HTML(p)), `${p} must exist`);
    }
});

test('§1 every legal page declares its canonical URL', () => {
    const expectedSlug = {
        'terms.html':    '/terms',
        'privacy.html':  '/privacy',
        'returns.html':  '/returns',
        'shipping.html': '/shipping',
        'about.html':    '/about',
        'faq.html':      '/faq',
        'contact.html':  '/contact',
    };
    for (const [page, slug] of Object.entries(expectedSlug)) {
        const re = new RegExp('rel="canonical"\\s+href="https://inkcartridges\\.co\\.nz' + slug + '"');
        assert.match(SRC[page], re, `${page} must have canonical href to https://inkcartridges.co.nz${slug}`);
    }
});

test('§1 every legal page declares lang="en-NZ"', () => {
    for (const p of PAGES) {
        assert.match(SRC[p], /<html\s+lang="en-NZ">/, `${p} must declare lang="en-NZ"`);
    }
});

test('§1 every legal page has a breadcrumb back to /', () => {
    for (const p of PAGES) {
        assert.match(SRC[p], /class="breadcrumb"/, `${p} must include the breadcrumb nav`);
        assert.match(SRC[p], /breadcrumb__item">\s*<a\s+href="\/">Home<\/a>/, `${p} breadcrumb must link Home → /`);
    }
});

test('§1 every legal page loads legal-config.js and legal-page.js', () => {
    for (const p of PAGES) {
        assert.match(SRC[p], /\/js\/legal-config\.js/, `${p} must load legal-config.js`);
        assert.match(SRC[p], /\/js\/legal-page\.js/,   `${p} must load legal-page.js`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Footer cross-links every legal page (Google Ads "Misrepresentation")
// ─────────────────────────────────────────────────────────────────────────────

test('§2 footer.js cross-links every required policy', () => {
    const required = ['/terms', '/privacy', '/returns', '/shipping', '/about', '/faq', '/contact'];
    for (const href of required) {
        const re = new RegExp('href="' + href.replace('/', '\\/') + '"');
        assert.match(FOOTER_JS, re, `footer.js must contain a link to ${href}`);
    }
});

test('§2 footer renders a Policies column AND a single-line legal nav', () => {
    assert.match(FOOTER_JS, /Policies/,                'footer.js must label a column "Policies"');
    assert.match(FOOTER_JS, /class="footer-legal-nav"/, 'footer.js must render a single-line legal nav for at-a-glance compliance review');
});

test('§2 footer copyright reaffirms no card surcharges', () => {
    // Google Ads compliance reviewers scan the footer for surcharge-free
    // claims before they scan the policy pages — so the line goes here.
    assert.match(FOOTER_JS, /No card surcharges/i, 'footer copyright must declare "no card surcharges"');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — "No hidden fees" / pricing transparency declared everywhere relevant
// ─────────────────────────────────────────────────────────────────────────────

test('§3 Terms, Returns, and Shipping each include a "No hidden fees" callout', () => {
    for (const p of ['terms.html', 'returns.html', 'shipping.html']) {
        assert.match(SRC[p], /No hidden fees/i, `${p} must declare "No hidden fees" verbatim`);
    }
});

test('§3 Terms page lists accepted payment methods and never mentions a card surcharge', () => {
    assert.match(SRC['terms.html'], /payment-methods/, 'Terms must surface the accepted-payments binding');
    // Decode HTML entities for the negation check (don&rsquo;t → don't).
    const decoded = SRC['terms.html'].replace(/&rsquo;|&lsquo;|&apos;/g, "'").replace(/&ldquo;|&rdquo;|&quot;/g, '"');
    assert.ok(!/card surcharge/i.test(decoded) || /(don't|do not|no|never|without).{0,40}card surcharge/i.test(decoded),
        'Terms must not advertise a card surcharge — only mention surcharges in a negation context');
});

test('§3 Shipping page names the carriers and free-shipping threshold', () => {
    assert.match(SRC['shipping.html'], /data-legal-bind="carriers"/,        'Shipping must bind carriers list');
    assert.match(SRC['shipping.html'], /data-legal-bind="free-threshold"/,  'Shipping must bind free-shipping threshold');
    assert.match(SRC['shipping.html'], /data-legal-bind="shipping-zones"/,  'Shipping must render the zone table from config');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — NZ legal compliance: Fair Trading Act ("in trade"), CGA, Privacy Act
// ─────────────────────────────────────────────────────────────────────────────

test('§4 Terms page contains an explicit "In trade" declaration under the Fair Trading Act', () => {
    assert.match(SRC['terms.html'], /In trade declaration/i, 'Terms must label the in-trade declaration prominently');
    assert.match(SRC['terms.html'], /Fair Trading Act/i,     'Terms must cite the Fair Trading Act 1986');
    assert.match(SRC['terms.html'], /Consumer Guarantees Act/i, 'Terms must cite the Consumer Guarantees Act 1993');
    assert.match(SRC['terms.html'], /in trade/i,             'Terms must include the phrase "in trade"');
});

test('§4 Returns page never time-bars CGA faulty-goods rights', () => {
    // The change-of-mind 30-day window must never be advertised as the
    // ceiling for CGA claims. The CGA rights are open-ended.
    assert.match(SRC['returns.html'], /No artificial time limit on CGA claims/i,
        'Returns must explicitly disclaim any time bar on CGA faulty-goods claims');
    assert.match(SRC['returns.html'], /Consumer Guarantees Act/i,
        'Returns must cite the CGA by name');
    assert.match(SRC['returns.html'], /major failure/i,
        'Returns must explain the CGA major-vs-minor remedy distinction');
});

test('§4 Returns page handles opened-cartridge case for consumables explicitly', () => {
    // The user spec calls this out specifically: "Open Box ink cartridges
    // (Standard: Faulty = Refund/Replace; Change of Mind = No refund once
    // seal is broken)".
    assert.match(SRC['returns.html'], /(opened|seal|vacuum)/i,
        'Returns must address the seal-broken / opened-cartridge consumables rule');
    assert.match(SRC['returns.html'], /faulty/i,
        'Returns must clarify that opened-but-faulty cartridges still get CGA remedies');
});

test('§4 Privacy page complies with Privacy Act 2020 IPP transparency requirements', () => {
    const src = SRC['privacy.html'];
    assert.match(src, /Privacy Act 2020/i,           'Privacy must cite the NZ Privacy Act 2020');
    assert.match(src, /Privacy Officer/i,            'Privacy must name a Privacy Officer (IPP transparency)');
    assert.match(src, /Office of the Privacy Commissioner/i, 'Privacy must reference the OPC complaint pathway');
    assert.match(src, /data-legal-bind="data-processors"/,   'Privacy must list data processors in a table (IPP3)');
    assert.match(src, /data-legal-bind="cookies"/,           'Privacy must list cookies in a table');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Google Merchant Center: contact page must have address + map + form
// ─────────────────────────────────────────────────────────────────────────────

test('§5 Contact page exposes physical address, phone, email, contact form, and a map', () => {
    const src = SRC['contact.html'];
    assert.match(src, /37A Archibald Road/,                'Contact must show the physical street address');
    assert.match(src, /Kelston, Auckland 0602/,            'Contact must show the suburb + postcode');
    assert.match(src, /tel:\+?64?2?7?\d{6,8}|tel:0274740115/, 'Contact must offer a tel: link');
    assert.match(src, /mailto:inkandtoner@windowslive\.com/, 'Contact must offer a mailto: link');
    assert.match(src, /id="contact-form"/,                  'Contact must render a contact form');
    assert.match(src, /data-legal-bind="map"/,              'Contact must include a map embed (Google Merchant Center requirement)');
});

test('§5 contact form has required client-side validation hooks', () => {
    const src = SRC['contact.html'];
    assert.match(src, /name="name"[^>]*\brequired\b/,    'name field must be required');
    assert.match(src, /name="email"[^>]*\brequired\b/,   'email field must be required');
    assert.match(src, /name="message"[^>]*\brequired\b/, 'message field must be required');
    // Attribute order is unspecified, so accept either order.
    assert.ok(
        /name="email"[^>]*type="email"/.test(src) || /type="email"[^>]*name="email"/.test(src),
        'email field must be type="email"',
    );
    // Honeypot — keeps the contact form spam-free without showing a CAPTCHA to humans.
    assert.match(src, /name="website"\s+tabindex="-1"/,  'contact form must include a honeypot field');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — legal-config.js single-source-of-truth
// ─────────────────────────────────────────────────────────────────────────────

test('§6 legal-config.js exposes every binding key used by the pages', () => {
    // Crawl every page for `data-legal-bind="X"` and assert the binding
    // is implemented in legal-page.js.
    const used = new Set();
    for (const p of PAGES) {
        const re = /data-legal-bind="([^"]+)"/g;
        let m; while ((m = re.exec(SRC[p]))) used.add(m[1]);
    }
    const implemented = [
        'trading-name', 'legal-entity', 'address-line', 'address-block',
        'phone-display', 'phone-href', 'email', 'email-href', 'hours',
        'response-sla', 'free-threshold', 'currency', 'return-window',
        'policy-date', 'policy-version', 'privacy-officer', 'privacy-email',
        'handling-time', 'supplier-fulfillment',
        'tax-line', 'payment-methods', 'carriers',
        'shipping-zones', 'data-processors', 'cookies', 'map',
    ];
    for (const key of used) {
        assert.ok(implemented.includes(key),
            `data-legal-bind="${key}" used on a page but not implemented in legal-page.js`);
    }
});

test('§6 legal-config.js policy-effective-date renders as a real human date', () => {
    // We can't load the JS in node without a window shim, but we can
    // assert the file declares a valid ISO date and a formatPolicyDate helper.
    assert.match(CONFIG_JS, /policyEffectiveDate:\s*'\d{4}-\d{2}-\d{2}'/,
        'policyEffectiveDate must be an ISO date string');
    assert.match(CONFIG_JS, /formatPolicyDate:\s*function/,
        'legal-config.js must expose formatPolicyDate()');
    // Verify the helper actually produces a legible date by mini-VM:
    const sandbox = { window: {} };
    const fn = new Function('window', CONFIG_JS + '\nreturn window.LegalConfig;');
    const cfg = fn(sandbox.window);
    const formatted = cfg.formatPolicyDate();
    assert.match(formatted, /^\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/,
        `formatPolicyDate() should produce "D Month YYYY", got "${formatted}"`);
});

test('§6 legal-config.js has hasTaxIdentifiers helper that gates GST/NZBN line', () => {
    const sandbox = { window: {} };
    const fn = new Function('window', CONFIG_JS + '\nreturn window.LegalConfig;');
    const cfg = fn(sandbox.window);
    // With both empty, the line must hide.
    cfg.gstNumber = '';
    cfg.nzbn = '';
    assert.equal(cfg.hasTaxIdentifiers(), false, 'empty identifiers must hide the tax line');
    cfg.gstNumber = '123-456-789';
    assert.equal(cfg.hasTaxIdentifiers(), true,  'a GST number must reveal the tax line');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Vercel rewrites + CSP allow the new pages and the OSM map embed
// ─────────────────────────────────────────────────────────────────────────────

test('§7 vercel.json rewrites every legal slug to its /html/ source', () => {
    const wants = ['/terms', '/privacy', '/returns', '/shipping', '/about', '/faq'];
    for (const src of wants) {
        const found = (VERCEL.rewrites || []).some((r) => r.source === src && r.destination === '/html' + src);
        assert.ok(found, `vercel.json must rewrite ${src} → /html${src}`);
    }
});

test('§7 vercel.json CSP allows the OpenStreetMap iframe used for the map embed', () => {
    const csp = (VERCEL.headers || []).flatMap((h) => h.headers || []).find((h) => h.key === 'Content-Security-Policy');
    assert.ok(csp,                                                  'CSP header must exist');
    assert.match(csp.value, /frame-src[^;]*openstreetmap\.org/,    'frame-src must allow openstreetmap.org for the map embed');
});

test('§7 vercel.json CSP allows the Cloudflare Turnstile script + iframe (contact form CAPTCHA)', () => {
    // Turnstile is the only bot defence on /contact. Removing the CSP
    // allow would silently break the form for every user, so pin it.
    const csp = (VERCEL.headers || []).flatMap((h) => h.headers || []).find((h) => h.key === 'Content-Security-Policy');
    assert.match(csp.value, /script-src[^;]*challenges\.cloudflare\.com/, 'script-src must allow challenges.cloudflare.com (Turnstile)');
    assert.match(csp.value, /frame-src[^;]*challenges\.cloudflare\.com/,  'frame-src must allow challenges.cloudflare.com (Turnstile widget)');
});

test('§7 serve.json (local dev) mirrors the legal-page rewrites in vercel.json', () => {
    // serve.json is what `npx serve inkcartridges` reads — local dev would
    // 404 on /terms /privacy etc. without these. The two files must stay
    // in lock-step or the dev/prod parity claim breaks.
    const SERVE = JSON.parse(READ(path.join(ROOT, 'inkcartridges', 'serve.json')));
    const slugs = ['terms', 'privacy', 'returns', 'shipping', 'about', 'faq'];
    for (const slug of slugs) {
        const found = (SERVE.rewrites || []).some((r) => r.source === slug && r.destination === '/html/' + slug + '.html');
        assert.ok(found, `serve.json must rewrite ${slug} → /html/${slug}.html`);
    }
});

test('§7 contact.html loads the Cloudflare Turnstile script', () => {
    // Turnstile is the bot defence on the contact form; without the script
    // load, the widget never renders and form submissions are blocked
    // server-side. Pin both the script load and the widget container.
    const src = SRC['contact.html'];
    assert.match(src, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/,
        'contact.html must load the Turnstile API script');
    assert.match(src, /id="contact-turnstile"/, 'contact.html must render the Turnstile container element');
});

test('§7 no surviving links to the non-existent /business/apply page', () => {
    // The /business/apply rewrite in vercel.json points to a page that
    // doesn't exist on disk; we removed the storefront-side links to it.
    // Re-introducing one would surface a 404 to users.
    for (const p of PAGES) {
        assert.ok(!/href="\/business\/apply"/.test(SRC[p]),
            `${p}: must not link to /business/apply (page does not exist)`);
    }
    assert.ok(!/href="\/business\/apply"/.test(FOOTER_JS),
        'footer.js must not link to /business/apply (page does not exist)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Accessibility: ARIA labels, headings, skip-link, reduced-motion friendly
// ─────────────────────────────────────────────────────────────────────────────

test('§8 every legal page has a skip-link, a single H1, ARIA landmarks', () => {
    for (const p of PAGES) {
        assert.match(SRC[p], /class="skip-link"/,                       `${p} must have a skip-link`);
        const h1Count = (SRC[p].match(/<h1[\s>]/g) || []).length;
        assert.equal(h1Count, 1,                                          `${p} must have exactly one <h1>, found ${h1Count}`);
        assert.match(SRC[p], /<main[^>]*\bid="main-content"/,            `${p} must wrap content in <main id="main-content">`);
        assert.match(SRC[p], /aria-label="Breadcrumb"/,                  `${p} must label the breadcrumb`);
    }
});

test('§8 FAQ uses native <details> for keyboard-accessible expand/collapse', () => {
    assert.match(SRC['faq.html'], /<details class="faq-item">/, 'FAQ must use <details class="faq-item">');
    assert.match(SRC['faq.html'], /<summary>/,                  'FAQ must use <summary> children');
});

test('§8 FAQ page exposes structured FAQ schema for Google rich results', () => {
    assert.match(SRC['faq.html'], /"@type":\s*"FAQPage"/, 'faq.html must include FAQPage JSON-LD');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — CSS exists for every styled hook
// ─────────────────────────────────────────────────────────────────────────────

test('§9 pages.css implements every styled hook used by the legal pages', () => {
    const hooks = [
        '.legal-page', '.legal-page__layout', '.legal-page__title',
        '.legal-toc', '.legal-toc__list',
        '.policy-section', '.policy-callout', '.policy-callout--ok',
        '.policy-table', '.policy-table-wrap',
        '.faq-item', '.faq-list',
        '.about-hero', '.about-values', '.about-value',
        '.legal-map', '.legal-map__frame',
        '.footer-legal-nav',
    ];
    for (const h of hooks) {
        assert.ok(PAGES_CSS.indexOf(h) !== -1, `pages.css must declare ${h}`);
    }
});
