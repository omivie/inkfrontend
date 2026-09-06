/**
 * Navbar parity contract (May 2026)
 * =================================
 *
 * The customer-facing site ships a SINGLE canonical site-header. Every
 * page that renders chrome must use byte-identical markup so the search
 * input, nav menu, contact strip, and mega menus stay locked at the
 * same width and position regardless of which page the user lands on.
 *
 * Why this exists: shop.html and ribbons.html previously wrapped the
 * search form in `<div class="search-wrapper">` (giving it a fixed 50%
 * width), while every other page used the bare `.search-form--nav`
 * (with `flex: 1 1 auto; max-width: 50%`). The two paths produced
 * different rendered widths — most visibly the search bar grew when
 * you clicked into shop. There were also 13 distinct navbar variants
 * across 25 pages (whitespace drift, an orphan "For Business" link,
 * a missing ribbons-mega heading on cart/404, etc.).
 *
 * Contract:
 *   1. Every customer-facing page that renders <header class="site-header">
 *      ships byte-identical header HTML — verified by sha256 hash.
 *   2. The active nav item is computed at runtime from data-nav-match
 *      on each link (initActiveNavLink() in main.js) — never hardcoded
 *      via inline `nav-menu__link--active`, since that would diverge
 *      the markup.
 *   3. The legacy `.search-wrapper` and `<div class="search-results">`
 *      DOM are gone — SmartSearch creates its own dropdown.
 *   4. Shop-specific filter preservation lives in shop-page.js
 *      (setupSearchForm injects hidden inputs at submit time) so the
 *      shop navbar stays identical to every other page.
 *
 * Pages intentionally exempt: checkout funnel + auth screens
 * (checkout/payment/order-confirmation, login, forgot/reset/verify
 * password). These render no site-header on purpose.
 *
 * Run with: node --test tests/navbar-parity-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const HTML_ROOT = path.join(ROOT, 'inkcartridges');

function walkHtml(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Admin pages have their own chrome (admin-nav.js); skip.
            //
            // `business` was skipped here until Aug 2026 — a fossil of
            // html/business/{index,apply}.html, deleted in 68ab525 (2026-04-22).
            // This walk is the byte-identical-header check, so the skip meant a
            // page could opt out of header parity by living in a folder named
            // `business`. The new Business Centre is html/business.html and is
            // checked like every other page.
            if (entry.name === 'admin') continue;
            walkHtml(p, out);
        } else if (entry.name.endsWith('.html') && !p.endsWith('/admin.html')) {
            out.push(p);
        }
    }
    return out;
}

function extractSiteHeader(html) {
    const start = html.indexOf('<header class="site-header">');
    if (start === -1) return null;
    let depth = 0;
    let i = start;
    while (i < html.length) {
        if (html.substr(i, 7) === '<header') depth++;
        if (html.substr(i, 9) === '</header>') {
            depth--;
            if (depth === 0) return html.substring(start, i + 9);
        }
        i++;
    }
    return null;
}

function hash(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}

function rel(p) {
    return path.relative(ROOT, p);
}

const ALL_HTML = walkHtml(HTML_ROOT);
const PAGES_WITH_HEADER = ALL_HTML
    .map((file) => ({ file, header: extractSiteHeader(fs.readFileSync(file, 'utf8')) }))
    .filter((p) => p.header !== null);

test('every customer-facing page that ships a site-header has byte-identical markup', () => {
    assert.ok(PAGES_WITH_HEADER.length >= 20,
        `expected 20+ pages with site-header, found ${PAGES_WITH_HEADER.length}`);

    const hashes = new Map();
    for (const { file, header } of PAGES_WITH_HEADER) {
        const h = hash(header);
        if (!hashes.has(h)) hashes.set(h, []);
        hashes.get(h).push(rel(file));
    }

    if (hashes.size !== 1) {
        const lines = [];
        for (const [h, files] of hashes) {
            lines.push(`  hash ${h.slice(0, 12)} (${files.length} files):`);
            files.slice(0, 6).forEach((f) => lines.push(`    ${f}`));
            if (files.length > 6) lines.push(`    ...and ${files.length - 6} more`);
        }
        assert.fail(`Expected 1 distinct site-header, found ${hashes.size}:\n${lines.join('\n')}`);
    }
});

test('canonical site-header keeps every load-bearing element', () => {
    const [{ header }] = PAGES_WITH_HEADER;
    const required = [
        '<header class="site-header">',
        '<div class="header-main">',
        'href="tel:0274740115"',
        'href="mailto:support@inkcartridges.co.nz"',
        // The IC brand mark at the inner edge of the left column. Static markup
        // (unlike the JS-injected Admin/Business shortcuts) — it is public
        // branding, shown to every visitor.
        'class="header-lead__logo"',
        'src="/apple-touch-icon.png"',
        '<div class="logo-block">',
        '<a href="/account"',
        // The Admin shortcut is NOT in static markup — it is JS-injected for
        // verified admins only (MC audit, Jul 2026). See admin-header-link test.
        '<a href="/account/favourites"',
        '<a href="/cart"',
        'id="cart-count"',
        '<nav class="primary-nav"',
        '<button class="nav-toggle"',
        'id="nav-menu"',
        'href="/" class="nav-menu__link" data-nav-match="/"',
        'href="/shop" class="nav-menu__link" data-nav-match="/shop',
        'href="/?scroll=ink-finder"',
        'class="nav-menu__link nav-mega-toggle"',
        'aria-controls="brands-mega"',
        'class="nav-menu__link nav-ribbons-toggle"',
        'aria-controls="ribbons-mega"',
        'data-nav-match="/ribbons"',
        '<form class="search-form search-form--nav" id="site-search-form"',
        'name="q"',
        'maxlength="200"',
        'id="brands-mega"',
        'id="ribbons-mega"',
        'Select your typewriter or printer brand',
    ];
    for (const needle of required) {
        assert.ok(header.includes(needle),
            `canonical site-header is missing required token: ${needle}`);
    }
});

test('site-header markup never hardcodes nav-menu__link--active (computed at runtime)', () => {
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(!header.includes('nav-menu__link--active'),
            `${rel(file)} hardcodes nav-menu__link--active in markup — must be applied via initActiveNavLink() in main.js so navbars stay byte-identical`);
    }
});

test('legacy search-wrapper and search-results DOM are gone from every header', () => {
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(!header.includes('class="search-wrapper"'),
            `${rel(file)} still renders the legacy <div class="search-wrapper"> — drop it; SmartSearch creates its own dropdown`);
        assert.ok(!header.includes('id="search-results"'),
            `${rel(file)} still renders the dead <div id="search-results"> — drop it`);
        assert.ok(!header.includes('id="shop-search-form"'),
            `${rel(file)} uses legacy id="shop-search-form" — switch to canonical id="site-search-form"`);
    }
});

test('initActiveNavLink() is wired in main.js and runs on DOMContentLoaded', () => {
    const main = fs.readFileSync(path.join(HTML_ROOT, 'js', 'main.js'), 'utf8');
    assert.ok(main.includes('function initActiveNavLink('),
        'main.js must define initActiveNavLink()');
    assert.ok(/DOMContentLoaded[\s\S]{0,400}initActiveNavLink\(\)/.test(main),
        'main.js must call initActiveNavLink() on DOMContentLoaded');
    assert.ok(main.includes('data-nav-match'),
        'initActiveNavLink() must read data-nav-match from nav links');
});

test('shop-page.js setupSearchForm targets the canonical site-search-form id', () => {
    const shop = fs.readFileSync(path.join(HTML_ROOT, 'js', 'shop-page.js'), 'utf8');
    assert.ok(shop.includes("getElementById('site-search-form')"),
        'shop-page.js must read the canonical id="site-search-form" — the legacy id was removed in May 2026 navbar parity rollout');
    assert.ok(!shop.includes("getElementById('shop-search-form')"),
        'shop-page.js still references the dead id="shop-search-form"');
});

test('every page with a site-header includes main.js so the active link lights up', () => {
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        assert.ok(/<script[^>]+src=["']\/js\/main\.js/.test(html),
            `${rel(file)} ships the site-header but does not load /js/main.js — the active nav link won't light up`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chrome-lock invariants (May 2026 — second-pass fix)
// =============================================================================
// The first pass made the markup byte-identical, but the search bar still
// rendered different widths on shop pages. Root cause: shop pages set
// `body.page-shop { --container-max-width: 1240px; --container-padding: 24px }`
// to widen the product grid, and that custom-property override cascaded INTO
// the navbar's `.container` (which is shared with the main grid). Net effect:
// shop's nav inner area was 56px wider, and the search form's `flex: 1 1 auto`
// expanded to fill that extra space.
//
// The fix re-declares the same custom properties on `.site-header` so any
// page-level override is shadowed before it can reach the navbar.
// ─────────────────────────────────────────────────────────────────────────────

const LAYOUT_CSS = fs.readFileSync(path.join(HTML_ROOT, 'css', 'layout.css'), 'utf8');
const PAGES_CSS  = fs.readFileSync(path.join(HTML_ROOT, 'css', 'pages.css'), 'utf8');

function extractRuleBody(css, selector) {
    const idx = css.indexOf(selector + ' {');
    if (idx === -1) return null;
    const before = css[idx - 1];
    if (before && !/[\s}\/*]/.test(before)) return null;
    let depth = 0, i = idx;
    while (i < css.length) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.substring(idx, i + 1);
        }
        i++;
    }
    return null;
}

test('chrome lock — .site-header re-declares --container-max-width to shadow page-level overrides', () => {
    const body = extractRuleBody(LAYOUT_CSS, '.site-header');
    assert.ok(body, '.site-header rule must exist in layout.css');
    assert.match(body, /--container-max-width\s*:\s*1200px/,
        '.site-header must re-declare --container-max-width: 1200px so body.page-shop (1240px) and any future page-level override cannot bleed into the navbar.');
    assert.match(body, /--container-padding\s*:/,
        '.site-header must re-declare --container-padding so the chrome cannot inherit body.page-shop\'s 24px override.');
});

test('chrome lock — body.page-* container overrides are still insulated by the .site-header lock', () => {
    const overrides = [...PAGES_CSS.matchAll(/body\.page-[a-z0-9-]+\s*\{[^}]*--container-(?:max-width|padding)[^}]*\}/g)];
    if (overrides.length > 0) {
        const headerLock = extractRuleBody(LAYOUT_CSS, '.site-header') || '';
        assert.match(headerLock, /--container-max-width/,
            `pages.css declares ${overrides.length} body.page-* container override(s); .site-header must re-declare --container-max-width to insulate the chrome. Current overrides:\n` +
            overrides.map(m => '  ' + m[0].slice(0, 80) + '...').join('\n'));
    }
});

test('chrome lock — layout.css cache key is bumped so the fix actually ships', () => {
    let stale = 0;
    let total = 0;
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        const m = html.match(/layout\.css\?v=([^"'\s]+)/);
        if (!m) continue;
        total++;
        // Reject the pre-fix key. Any string containing 'chrome-lock' or a
        // later-dated marker is fine.
        if (m[1] === '2c8b28f0') stale++;
    }
    assert.equal(stale, 0,
        `${stale}/${total} HTML pages still reference layout.css?v=2c8b28f0 (the pre-fix key). Bump to v=chrome-lock-may2026 (or a later marker).`);
});

/**
 * THE RUNTIME BEHIND THE HEADER (ERR-214, Sep 2026)
 * =================================================
 * Everything above proves the header MARKUP is byte-identical on every page.
 * Nothing above proved the JavaScript that makes that markup DO anything was
 * loaded — and for four months it was not. Ten pages
 * (privacy/terms/returns/shipping/about/faq/contact/genuine-vs-compatible/
 * quote/track-order) shipped the hash-locked search form and never loaded
 * js/search.js, so typing in it did nothing at all, silently: main.js logs the
 * miss through DebugLog, which is a no-op off localhost (ERR-193).
 *
 * The lesson is the split: markup parity was enforced by a test, runtime parity
 * was a list maintained by hand, and the hand-maintained half rotted. A header
 * can be hash-identical on 30 pages while the code animating it runs on 20.
 * Enrolment belongs in a test (ERR-150/160), so it lives here, beside the hash.
 *
 * KNOWN STALE, TRACKED: the comment at js/main.js:502 still ASSERTS this rule
 * ("loaded before /js/main.js on every page that has a search form") as though
 * it were already true. It is not documentation of the invariant — THIS FILE is.
 * Rewriting it moves main.js's ?v= token on all 34 pages that load it, which
 * could not be committed cleanly while other sessions held edits in those pages;
 * see ERR-214. If you are editing main.js anyway, fix that comment.
 *
 * ORDER IS ASSERTED, and the tempting reason not to is wrong. "They are all
 * `defer`, so document order cannot matter" is false of this tree: root
 * 404.html:259-261 loads products.js, search.js and main.js with NO `defer`
 * attribute at all, so there document order is the only thing sequencing them.
 * It is also one attribute-deletion away from being false anywhere else.
 *
 * `defer` itself is deliberately NOT asserted, for that same reason — root
 * 404.html predates the convention, so a blanket check would go red for a
 * reason unrelated to this contract.
 */

// Match the PATH and ignore the ?v= token. Never pin a cache-busting token in
// a test — its whole purpose is to move (ERR-067).
function loadsScript(html, file) {
    return new RegExp(`<script[^>]+src="/js/${file}\\.js(\\?[^"]*)?"`).test(html);
}

// Position of the same tag, for the ordering check. -1 when absent.
function scriptIndex(html, file) {
    const m = new RegExp(`<script[^>]+src="/js/${file}\\.js(\\?[^"]*)?"`).exec(html);
    return m ? m.index : -1;
}

test('every page shipping the header search form also ships the runtime behind it', () => {
    const broken = [];
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        const missing = ['products', 'search'].filter((m) => !loadsScript(html, m));
        if (missing.length) broken.push(`${rel(file)} -> missing ${missing.join(' + ')}`);
    }
    assert.deepEqual(broken, [],
        'These pages render the search bar but never load the JS that makes it work.\n' +
        'window.SmartSearch is defined ONLY by js/search.js, and js/search.js hard-bails\n' +
        'to "Search is temporarily unavailable" without Products.renderCard from\n' +
        'js/products.js. Add both <script defer> tags before /js/main.js:\n  ' +
        broken.join('\n  '));
});

test('no page loads search.js without products.js', () => {
    // The mirror-image failure, and the louder one: SmartSearch initialises,
    // opens its dropdown, then paints "Search is temporarily unavailable.
    // Please try again." at every keystroke (js/search.js:403). /business and
    // /account/loyalty did exactly this in production.
    const broken = ALL_HTML.filter((f) => {
        const html = fs.readFileSync(f, 'utf8');
        return loadsScript(html, 'search') && !loadsScript(html, 'products');
    }).map(rel);
    assert.deepEqual(broken, [],
        'search.js without products.js paints "Search is temporarily unavailable."\n' +
        'in the dropdown on every keystroke (js/search.js:403):\n  ' + broken.join('\n  '));
});

test('every customer-facing page loads the lockdown guard', () => {
    // Same commit (61fd2f6), same nine pages, bigger blast radius: site-guard.js
    // is what shows the login overlay when an admin enables site-wide lockdown.
    // A page missing it stays publicly readable THROUGH a lockdown — the one
    // state where the site is supposed to be shut. Predicate is every
    // customer-facing page, header or not (walkHtml already skips admin/),
    // because lockdown is not a chrome feature.
    const broken = ALL_HTML
        .filter((f) => !loadsScript(fs.readFileSync(f, 'utf8'), 'site-guard'))
        .map(rel);
    assert.deepEqual(broken, [],
        'site-guard.js intercepts every public page when admin enables site-wide\n' +
        'lockdown. A page without it stays publicly readable through a lockdown:\n  ' +
        broken.join('\n  '));
});

test('products.js loads before search.js loads before main.js', () => {
    // On the 29 pages using `defer` this is copy-paste discipline rather than
    // correctness: deferred classic scripts execute in document order before
    // DOMContentLoaded, and every cross-module read here happens in a
    // DOMContentLoaded-or-later callback (main.js initSearch() reads
    // SmartSearch; search.js renderResults() reads Products.renderCard), so
    // nothing is dereferenced at evaluation time.
    //
    // On root 404.html it is correctness: those three tags carry no `defer`,
    // so they execute where they sit.
    //
    // Discipline is worth pinning anyway. A page that lists them out of order
    // is a page that did not follow the pattern, and not following the pattern
    // is exactly how the next page ends up missing a tag altogether — which is
    // the bug this whole block exists for.
    const problems = [];
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        const chain = ['products', 'search', 'main'].map((n) => [n, scriptIndex(html, n)]);
        if (chain.some(([, i]) => i < 0)) continue;   // presence is the other test's job
        for (let i = 1; i < chain.length; i++) {
            if (chain[i][1] < chain[i - 1][1]) {
                problems.push(`${rel(file)} -> ${chain[i][0]}.js is loaded before ${chain[i - 1][0]}.js`);
            }
        }
    }
    assert.deepEqual(problems, [],
        'Canonical order (html/shop.html): ...cart-analytics.js, favourites.js,\n' +
        'products.js, search.js, main.js...\n  ' + problems.join('\n  '));
});
