/**
 * MOBILE NAV DRAWER SCROLL — Jul 2026 (ERR-103)
 * =============================================
 * The mobile hamburger drawer (.nav-menu) is position:absolute; top:100% under
 * the sticky header. When CARTRIDGE BRANDS expands, mega-nav.js relocates the
 * ~10-brand grid INSIDE the drawer, which then grows taller than the viewport.
 * With no bounded height and no overflow, the lower brands (EPSON, Fuji Xerox,
 * the "View all" links) fell below the fold with NO way to scroll to them.
 *
 * Fix: the drawer is its own scroll container (overflow-y:auto in layout.css)
 * and JS bounds its height to the measured space below its top edge
 * (main.js#setNavMenuBound), which stays correct across the four responsive
 * header modes and the scrolled/collapsed state. These string-contract tests
 * pin both halves so the regression can't silently return.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const LAYOUT = read('inkcartridges/css/layout.css');
const MAIN_JS = read('inkcartridges/js/main.js');

// ─────────────────────────────────────────────────────────────────────────────
// N1 — the base .nav-menu drawer is a scroll container
// ─────────────────────────────────────────────────────────────────────────────

test('N1 base .nav-menu is a scroll container (overflow-y:auto + overscroll-behavior:contain)', () => {
    // The base rule is the collapsed mobile dropdown: display:none then
    // position:absolute (see responsive-header-jul2026 R-gate). Grab that block
    // up to its closing brace and assert the drawer can scroll its own overflow.
    const m = LAYOUT.match(/\.nav-menu\s*\{\s*display:\s*none;[\s\S]*?position:\s*absolute[\s\S]*?\}/);
    assert.ok(m, 'could not locate the base .nav-menu (collapsed mobile drawer) rule');
    const block = m[0];
    assert.match(block, /overflow-y:\s*auto/,
        'the drawer must scroll its own overflow so lower brands stay reachable (ERR-103)');
    assert.match(block, /overscroll-behavior:\s*contain/,
        'overscroll-behavior:contain keeps the gesture inside the drawer (page/header stay put)');
});

// ─────────────────────────────────────────────────────────────────────────────
// N2 — JS bounds the open drawer height by MEASUREMENT, not a hardcoded number
// ─────────────────────────────────────────────────────────────────────────────

test('N2 setNavMenuBound measures the drawer top and bounds maxHeight to the viewport', () => {
    assert.match(MAIN_JS, /function\s+setNavMenuBound\s*\(/,
        'expected a setNavMenuBound helper that bounds the open drawer');
    // Measured, not a literal: derived from getBoundingClientRect().top and
    // window.innerHeight so it tracks every header mode + the collapsed state.
    assert.match(MAIN_JS, /getBoundingClientRect\(\)\.top/,
        'the bound must be measured from the drawer top, not a hardcoded header height');
    assert.match(MAIN_JS, /window\.innerHeight\s*-\s*top/,
        'maxHeight = innerHeight - top (space between the drawer top and the viewport bottom)');
    // Closing clears the inline cap so it never lingers on a hidden drawer.
    assert.match(MAIN_JS, /navMenu\.style\.maxHeight\s*=\s*['"]['"]/,
        'closing the drawer must clear the inline maxHeight');
});

test('N3 the drawer toggle calls setNavMenuBound with the open state', () => {
    assert.match(MAIN_JS, /classList\.toggle\('is-open'\)[\s\S]{0,160}setNavMenuBound\(navMenu,\s*isOpen\)/,
        'the hamburger toggle must (re)bound the drawer whenever it opens/closes');
});
