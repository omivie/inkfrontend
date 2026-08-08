/**
 * RESPONSIVE HEADER REBUILD — Jul 2026
 * ====================================
 * The site header used to be a desktop layout continuously squeezed:
 *   - .logo-block was position:absolute + transform-centered, so the contact
 *     block and action icons freely overlapped it between ~481–1000px, and
 *     the ≤480 fallback (overflow:hidden + justify-content:center) clipped
 *     the logo's LEFT edge at 390px.
 *   - The desktop nav row appeared at 769px but measures ~870px of nowrap
 *     links + a 200px-min search — at 790px it clipped off-screen.
 *
 * The rebuild is mobile-first with content-driven modes:
 *   base (compact mobile) → min-width 480 → 768 (tablet grid, still
 *   hamburger) → 1100 (desktop nav, where it genuinely fits).
 * Breakpoints are single-sourced: css/base.css docs + Config.BREAKPOINTS /
 * Config.MQ_DESKTOP_NAV in js/config.js, consumed by mega-nav.js/search.js.
 *
 * These tests pin the invariants so the old failure modes can't ship again.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LAYOUT = read('inkcartridges/css/layout.css');
const BASE = read('inkcartridges/css/base.css');
const CONFIG_JS = read('inkcartridges/js/config.js');
const MEGA_NAV_JS = read('inkcartridges/js/mega-nav.js');
const SEARCH_JS = read('inkcartridges/js/search.js');

// ─────────────────────────────────────────────────────────────────────────────
// R1 — the logo is never absolutely positioned again
// ─────────────────────────────────────────────────────────────────────────────

test('R1 .logo-block is never position:absolute (the root cause of the 700/790px overlaps)', () => {
    // Anchor to line starts so prose comments mentioning .logo-block
    // (the section header does) can't be mistaken for rules.
    const blocks = LAYOUT.match(/^\s*\.logo-block[^{]*\{[^}]*\}/gm) || [];
    assert.ok(blocks.length >= 1, '.logo-block must still be styled in layout.css');
    for (const block of blocks) {
        assert.ok(!/position:\s*absolute/.test(block),
            `.logo-block must stay in flow — found position:absolute in: ${block}`);
        assert.ok(!/transform:\s*translate/.test(block),
            `.logo-block must not be transform-centered — found in: ${block}`);
    }
    // The ≤480 left-edge clip came from overflow:hidden on a center-justified
    // flex child. Neither half may return.
    for (const block of blocks) {
        assert.ok(!/overflow:\s*hidden/.test(block),
            '.logo-block must not clip its contents (390px left-edge clip, Jul 2026)');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — the desktop nav only exists where it fits (>=1100px)
// ─────────────────────────────────────────────────────────────────────────────

test('R2 the desktop nav row is gated at (min-width: 1100px)', () => {
    // The horizontal nav-menu (position:static, row) must live inside the
    // desktop gate; the base .nav-menu must be the collapsed dropdown.
    assert.match(LAYOUT, /@media \(min-width: 1100px\)[\s\S]*?\.nav-menu\s*\{[\s\S]*?flex-direction:\s*row/,
        'the horizontal nav row must be inside @media (min-width: 1100px)');
    assert.match(LAYOUT, /\.nav-menu\s*\{\s*display:\s*none;[\s\S]*?position:\s*absolute/,
        'the base .nav-menu must be the collapsed mobile dropdown');
    assert.match(LAYOUT, /@media \(min-width: 1100px\)[\s\S]*?\.nav-toggle\s*\{\s*display:\s*none/,
        'the hamburger must hide only at >=1100px');
    // No other rule may re-show the desktop nav earlier (e.g. a stray 768 gate).
    assert.ok(!/@media \(min-width: 76[89]px\)[\s\S]{0,2000}?\.nav-menu\s*\{[\s\S]{0,200}?flex-direction:\s*row/.test(LAYOUT),
        'the desktop nav must not come back at a ~768px gate');
});

test('R2b the mega panels use the same hamburger range as the nav (max-width: 1099.98px)', () => {
    assert.match(LAYOUT, /@media \(max-width: 1099\.98px\)[\s\S]*?\.brands-mega/,
        'brands mega mobile restyle must cover the whole hamburger range');
    assert.match(LAYOUT, /@media \(max-width: 1099\.98px\)[\s\S]*?\.ribbons-mega/,
        'ribbons mega mobile restyle must cover the whole hamburger range');
    assert.match(LAYOUT, /@media \(max-width: 1099\.98px\)[\s\S]*?\.site-header\s*\{[\s\S]*?position:\s*sticky/,
        'the sticky header must cover the whole hamburger range');
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — JS breakpoints are single-sourced in Config
// ─────────────────────────────────────────────────────────────────────────────

test('R3 Config declares the breakpoint system', () => {
    assert.match(CONFIG_JS, /BREAKPOINTS:\s*\{\s*compact:\s*480,\s*tablet:\s*768,\s*desktopNav:\s*1100\s*\}/,
        'Config.BREAKPOINTS must declare compact/tablet/desktopNav');
    assert.match(CONFIG_JS, /MQ_DESKTOP_NAV:\s*'\(min-width: 1100px\)'/,
        'Config.MQ_DESKTOP_NAV must match the CSS desktop gate');
});

test('R3b mega-nav.js derives isMobile from Config.MQ_DESKTOP_NAV (no pinned 768)', () => {
    assert.match(MEGA_NAV_JS, /Config\.MQ_DESKTOP_NAV/,
        'mega-nav.js must read Config.MQ_DESKTOP_NAV');
    assert.ok(!/MOBILE_BREAKPOINT\s*=\s*768/.test(MEGA_NAV_JS),
        'the old pinned MOBILE_BREAKPOINT = 768 must not return');
});

test('R3c search.js derives its mobile check from Config.BREAKPOINTS (no pinned 640)', () => {
    assert.match(SEARCH_JS, /Config\.BREAKPOINTS/,
        'search.js must read Config.BREAKPOINTS');
    assert.ok(!/innerWidth\s*<=\s*640/.test(SEARCH_JS),
        'the old pinned innerWidth <= 640 must not return');
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — fluid container padding (both the token and the header chrome-lock)
// ─────────────────────────────────────────────────────────────────────────────

test('R4 --container-padding is a fluid clamp() in :root AND the .site-header chrome lock', () => {
    assert.match(BASE, /--container-padding:\s*clamp\(/,
        'base.css :root must declare a fluid --container-padding');
    const lock = LAYOUT.match(/\.site-header\s*\{[^}]*\}/);
    assert.ok(lock, 'the .site-header chrome-lock rule must exist');
    assert.match(lock[0], /--container-padding:\s*clamp\(/,
        'the chrome lock must mirror the fluid padding (not a pinned 32px)');
    assert.match(lock[0], /--container-max-width:\s*1200px/,
        'the chrome lock must keep --container-max-width: 1200px');
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — dead code stays dead
// ─────────────────────────────────────────────────────────────────────────────

test('R5 retired header CSS does not return (.search-wrapper / storefront .mobile-menu / .top-bar)', () => {
    assert.ok(!/\.search-wrapper\s*[,{]/.test(LAYOUT),
        '.search-wrapper CSS was retired (markup removed May 2026) — do not reintroduce');
    assert.ok(!/^\.mobile-menu\s*\{/m.test(LAYOUT),
        'the orphaned storefront .mobile-menu overlay CSS was removed Jul 2026');
    assert.ok(!/\.top-bar\s*[,{]/.test(LAYOUT),
        'the unused .top-bar utility bar CSS was removed Jul 2026');
});

// ─────────────────────────────────────────────────────────────────────────────
// R6 — the left column is a real wrapper (.header-lead), Aug 2026
//
// The Admin shortcut moved out of the right-hand .header-actions cluster (that
// slot is reserved for the Business account button) into the header's LEFT
// column, beside the logo. It cannot simply share the left grid cell with
// .header-contact: at 1100px that track measures ~280px and the phone+email
// block alone fills it, so a justify-self:end sibling would render ON TOP of
// the email — the exact overlap class of bug R1 exists to prevent. The
// .header-lead flex wrapper makes the track size to the sum instead.
// ─────────────────────────────────────────────────────────────────────────────

test('R6 .header-lead owns the left column and never absolutely positions itself', () => {
    const blocks = LAYOUT.match(/^\s*\.header-lead\s*\{[^}]*\}/gm) || [];
    assert.ok(blocks.length >= 1, '.header-lead must be styled in layout.css');
    for (const block of blocks) {
        assert.ok(!/position:\s*absolute/.test(block),
            `.header-lead must stay in flow — found position:absolute in: ${block}`);
    }
    // It is a flex row so the contact stack and the admin shortcut sit side by
    // side rather than stacking.
    assert.match(LAYOUT, /^\s*\.header-lead\s*\{[^}]*display:\s*flex/m,
        '.header-lead must be display:flex');
    // space-between belongs to the GRID mode only. On mobile the lead is its
    // own full-width row, where space-between would fling the admin shortcut to
    // the far right, under the cart icon.
    assert.match(LAYOUT, /@media \(min-width: 768px\)[\s\S]*?\.header-lead\s*\{[^}]*justify-content:\s*space-between/,
        '.header-lead must use space-between at >=768px so the admin shortcut is pushed to the column\'s inner edge, beside the logo');
    assert.match(LAYOUT, /^\s*\.header-lead\s*\{[^}]*justify-content:\s*flex-start/m,
        'the base (mobile) .header-lead must keep the admin shortcut beside the contact chip, not right-aligned under the cart');
    // The grid placement lives on the WRAPPER now, not on .header-contact —
    // otherwise the contact stack and the wrapper fight for column 1.
    assert.match(LAYOUT, /@media \(min-width: 768px\)[\s\S]*?\.header-lead\s*\{[^}]*grid-column:\s*1/,
        '.header-lead must take grid-column 1 at >=768px');
    const contactBlocks = LAYOUT.match(/^\s*\.header-contact\s*\{[^}]*\}/gm) || [];
    for (const block of contactBlocks) {
        assert.ok(!/grid-column/.test(block),
            `.header-contact must no longer place itself in the grid — that moved to .header-lead. Found: ${block}`);
    }
});

test('R6b the scrolled collapse hides .header-lead, preserving the ERR-101 height delta', () => {
    // Hiding only .header-contact would leave the admin shortcut holding the
    // row open, collapsing the reclaimed height to ~0 while initStickyHeader
    // still assumes a ~44px delta against its 56px hysteresis gap.
    assert.match(LAYOUT, /\.site-header--scrolled\s+\.header-lead\s*\{\s*display:\s*none/,
        'the scrolled header must hide .header-lead (the whole left column), not just .header-contact');
    assert.ok(!/\.site-header--scrolled\s+\.header-contact\s*\{/.test(LAYOUT),
        'the old .site-header--scrolled .header-contact rule must be gone — it no longer collapses the row (ERR-101)');
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — the Admin shortcut pins to the WINDOW's right edge, not the container's
//
// Owner request (Aug 2026): Admin belongs at the far right of the white bar,
// out past the action cluster. The cluster's right edge is the 1200px
// container's content edge, so reaching the window edge means anchoring to
// .header-main — which is full-bleed — rather than to .container.
//
// This is a containing-block contract, and it fails SILENTLY: if .container is
// positioned too, the pin resolves against the 1200px box and Admin lands back
// beside the cart. That reads as a wrong `right` value, not as the ancestor bug
// it actually is, which is why both halves are pinned here.
// ─────────────────────────────────────────────────────────────────────────────

// This file's rules are heavily commented, and those comments quote the very
// declarations being asserted against ("NO `position: relative` here"). Strip
// comments before testing a block or the prose fails the test.
const declarationsOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('R7 .header-main is the positioned ancestor and .header-main .container is not', () => {
    const mainBlocks = (LAYOUT.match(/^\s*\.header-main\s*\{[^}]*\}/gm) || []).map(declarationsOnly);
    assert.ok(mainBlocks.length >= 1, '.header-main must be styled in layout.css');
    assert.ok(mainBlocks.some((b) => /position:\s*relative/.test(b)),
        '.header-main must be position:relative — it is the containing block the pinned Admin shortcut anchors to. Without it the pin falls through to .site-header and Admin drifts out of the white bar.');

    const containerBlocks = (LAYOUT.match(/^\s*\.header-main \.container\s*\{[^}]*\}/gm) || []).map(declarationsOnly);
    assert.ok(containerBlocks.length >= 1, '.header-main .container must be styled in layout.css');
    for (const block of containerBlocks) {
        assert.ok(!/position:\s*(relative|absolute|sticky)/.test(block),
            `.header-main .container must stay unpositioned, or it steals the containing block from .header-main and the pinned Admin shortcut snaps back to the 1200px container edge. Nothing anchors to it (.cart-badge anchors to .header-actions__icon). Found: ${block}`);
    }

    // .primary-nav .container IS relative on purpose — it anchors .nav-menu.
    // Different selector; the rule above must not be "tidied" to cover it.
    assert.match(LAYOUT, /\.primary-nav \.container\s*\{[^}]*position:\s*relative/,
        '.primary-nav .container must stay position:relative — .nav-menu is absolutely positioned against it');
});

test('R7b the Admin pin is gated on there being a gutter to pin into', () => {
    // Below the gate the container fills the viewport, so a pinned Admin would
    // land on top of the cart — a customer-facing break, not a cosmetic one.
    const pin = LAYOUT.match(/@media \(min-width: (\d+)px\)\s*\{\s*\.header-actions__item--admin\s*\{([^}]*)\}/);
    assert.ok(pin, 'a min-width media query must pin .header-actions__item--admin (MODE E)');
    assert.ok(Number(pin[1]) >= 1300,
        `the Admin pin must not engage before ~1300px — measured, a 1280px viewport leaves only ~5px between the cluster and the pinned shortcut. Found ${pin[1]}px.`);
    assert.match(pin[2], /position:\s*absolute/, 'the pinned Admin shortcut must be position:absolute');
    assert.match(pin[2], /right:/, 'the pinned Admin shortcut must be offset from the RIGHT edge');

    // Below 1100 it is hidden outright (five icon-only items at the 48px tap
    // floor do not fit the track — ERR-148).
    assert.match(LAYOUT, /^\s*\.header-actions__item--admin\s*\{\s*display:\s*none/m,
        'Admin must default to display:none — it is only affordable at >=1100px');
    assert.match(LAYOUT, /@media \(min-width: 1100px\)[\s\S]*?\.header-actions__item--admin\s*\{[^}]*display:\s*flex/,
        'Admin must be revealed at >=1100px');
});
