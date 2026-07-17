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
