/**
 * ACCOUNT MOBILE NAV — pill bar (Jul 2026)
 * ========================================
 * Below 1024px the account sidebar used to stack its full ~800px tower (user
 * card + 9 nav buttons + trust panel) ABOVE the page content. The redesign
 * turns it into a compact user strip + ONE horizontally swipeable pill row —
 * pure CSS in pages.css's <=1024 account block (the 10 account pages' static
 * markup is untouched), plus an active-pill scrollIntoView in account.js.
 *
 * These assertions pin the pattern so it can't silently regress.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = read('inkcartridges/css/pages.css');
const ACCOUNT_JS = read('inkcartridges/js/account.js');

// The <=1024 account block (from its comment banner to the closing of the
// media query) — grab a generous slice to run the pill assertions against.
const mqStart = PAGES.indexOf('ACCOUNT NAV — mobile pill bar');
const MOBILE_BLOCK = PAGES.slice(mqStart, mqStart + 4000);

test('A1 the mobile account block exists inside a <=1024px media query', () => {
    assert.ok(mqStart > -1, 'the "ACCOUNT NAV — mobile pill bar" section must exist in pages.css');
    assert.match(MOBILE_BLOCK, /@media \(max-width: 1024px\)/,
        'the pill-bar rules must be scoped to <=1024px (desktop keeps the vertical sidebar)');
});

test('A2 the nav list is a horizontally scrollable single row', () => {
    assert.match(MOBILE_BLOCK, /\.account-nav__list\s*\{[^}]*display:\s*flex/s,
        '.account-nav__list must be a flex row on mobile');
    assert.match(MOBILE_BLOCK, /\.account-nav__list\s*\{[^}]*flex-wrap:\s*nowrap/s,
        'the row must not wrap (that would rebuild the tower)');
    assert.match(MOBILE_BLOCK, /\.account-nav__list\s*\{[^}]*overflow-x:\s*auto/s,
        'the row must scroll horizontally');
});

test('A3 section headings and trust panel are hidden on mobile', () => {
    assert.match(MOBILE_BLOCK, /\.account-nav__divider\s*\{\s*display:\s*none/s,
        'ACCOUNT/ORDERS dividers must be hidden in the pill row');
    assert.match(MOBILE_BLOCK, /\.account-sidebar__trust\s*\{\s*display:\s*none/s,
        'the trust bullets must be hidden on mobile (they remain on desktop)');
});

test('A4 pills are >=44px touch targets', () => {
    assert.match(MOBILE_BLOCK, /\.account-nav__item a\s*\{[^}]*min-height:\s*44px/s,
        'each pill must be a >=44px touch target');
});

test('A5 account.js centres the active pill on mobile', () => {
    assert.match(ACCOUNT_JS, /account-nav__item--active/,
        'account.js must look up the active pill');
    assert.match(ACCOUNT_JS, /scrollIntoView\(\{\s*block:\s*'nearest',\s*inline:\s*'center'\s*\}\)/,
        "the active pill must scrollIntoView with block:'nearest' (no vertical jump)");
});

test('A6 the contracts other code depends on survive', () => {
    // track-order-page.js detects the account mount via .account-sidebar;
    // account.js fills #user-name / #user-email. All 10 account pages must
    // keep them.
    const pages = ['index', 'settings', 'addresses', 'favourites', 'orders',
        'order-detail', 'loyalty', 'printers', 'track-order', 'personal-details'];
    for (const p of pages) {
        const html = read(`inkcartridges/html/account/${p}.html`);
        assert.ok(html.includes('account-sidebar'), `${p}.html must keep .account-sidebar`);
        assert.ok(html.includes('id="user-name"'), `${p}.html must keep #user-name`);
        assert.ok(html.includes('id="user-email"'), `${p}.html must keep #user-email`);
    }
});
