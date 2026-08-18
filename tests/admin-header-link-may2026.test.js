/**
 * Admin header shortcut contract
 * ==============================
 *
 * A privileged "Admin" shortcut lets a verified admin jump to /admin from any
 * page. It lives at the FAR RIGHT of the global site header — appended LAST in
 * the `.header-actions` cluster, past the cart.
 *
 * MOVED TWICE — it began at the HEAD of `.header-actions`; in Aug 2026 it was
 * relocated to the left column (`.header-lead`) to free the leading slot for
 * the customer-facing Business Centre button; days later it returned to
 * `.header-actions` as the LAST item, so the two privileged shortcuts bracket
 * the customer ones (Business first, Admin last) and the left column's inner
 * edge could take the IC brand mark instead. `.header-lead` survives the move
 * and now hosts that mark — see the wrapper test below.
 *
 * REVISED — Google Merchant Center audit (Jul 2026):
 * The link used to ship in every page's static markup as `hidden`. That put
 * `href="/admin"` in the public HTML source of every customer-facing page,
 * which reads as advertising a private admin surface. The link is now
 * INJECTED BY JS (main.js#initAdminHeaderLink) only after the account is
 * verified as admin, and is absent from static page markup entirely.
 *
 * Hard requirements:
 *   1. NO customer-facing page ships the admin link (or a bare href="/admin")
 *      in its static header markup — guests/customers never receive it.
 *   2. main.js#initAdminHeaderLink() creates and appends the link to
 *      `.header-actions`, only after a server-side role check
 *      (API.verifyAdmin → GET /api/admin/verify). Client state is never
 *      trusted for the gate; /admin re-verifies server-side regardless.
 *   3. Guests are skipped (Auth.isAuthenticated) so no verify call fires for
 *      logged-out visitors; the link is removed on sign-out.
 *
 * Run with: node --test tests/admin-header-link-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML_ROOT = path.join(ROOT, 'inkcartridges');

function walkHtml(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Admin pages have their own chrome; skip (matches navbar-parity).
            //
            // `business` used to be skipped here too — a fossil of
            // html/business/{index,apply}.html, deleted in 68ab525 (2026-04-22,
            // "remove all B2B functionality site-wide"). The directory has not
            // existed since, and leaving the skip armed meant the Aug-2026
            // Business Centre would have been exempted from this walk by the
            // mere act of living in a folder. It is a FLAT file
            // (html/business.html) for the same reason; the skip is gone so
            // that choice is no longer load-bearing.
            if (entry.name === 'admin') continue;
            walkHtml(p, out);
        } else if (entry.name.endsWith('.html')) {
            out.push(p);
        }
    }
    return out;
}

function extractSiteHeader(html) {
    const start = html.indexOf('<header class="site-header">');
    if (start === -1) return null;
    const end = html.indexOf('</header>', start);
    return end === -1 ? null : html.substring(start, end + 9);
}

function rel(p) {
    return path.relative(ROOT, p);
}

const PAGES_WITH_HEADER = walkHtml(HTML_ROOT)
    .map((file) => ({ file, header: extractSiteHeader(fs.readFileSync(file, 'utf8')) }))
    .filter((p) => p.header !== null);

// ─────────────────────────────────────────────────────────────────────────────
// Static markup must NOT advertise /admin
// ─────────────────────────────────────────────────────────────────────────────

test('no customer-facing page ships the admin link in static header markup', () => {
    assert.ok(PAGES_WITH_HEADER.length >= 20,
        `expected 20+ pages with a site-header, found ${PAGES_WITH_HEADER.length}`);
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(!header.includes('id="header-admin-link"'),
            `${rel(file)} still ships #header-admin-link in static markup — it must be JS-injected for verified admins only (MC audit)`);
        assert.ok(!header.includes('href="/admin"'),
            `${rel(file)} still advertises href="/admin" in the header — the admin route must not appear in public page source`);
    }
});

test('every shared header ships the .header-actions cluster the shortcut is appended to', () => {
    // ensureLink() bails when .header-actions is missing, so a page that lost
    // the cluster would silently lose the Admin shortcut.
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(header.includes('class="header-actions"'),
            `${rel(file)} is missing the .header-actions cluster — main.js#initAdminHeaderLink has nowhere to append the shortcut`);
    }
});

test('the .header-lead wrapper survives the move and holds the IC brand mark', () => {
    // The wrapper is load-bearing, not a fossil of the Aug-2026 admin placement.
    // The left grid track is ~350px at 1100px and the phone+email stack alone
    // nearly fills it, so a `justify-self: end` sibling in the same grid CELL
    // renders ON TOP of the email (same overlap class as ERR-088). The flex
    // wrapper makes the track size to the sum instead. The sibling is now the
    // brand mark rather than the admin link, so the wrapper matters MORE: the
    // mark ships for every visitor, not just verified admins.
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.match(header, /<div class="header-lead">\s*<div class="header-contact">/,
            `${rel(file)}: .header-lead must directly wrap .header-contact so the contact stack and the brand mark share the left grid track without overlapping`);
        assert.match(header, /<a href="\/" class="header-lead__logo"[\s\S]*?src="\/apple-touch-icon\.png"[\s\S]*?<\/a>\s*<\/div>/,
            `${rel(file)}: .header-lead must end with the IC brand mark — space-between is what pushes it to the track's inner edge, beside the wordmark`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// main.js — the injection + reveal logic
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_JS = fs.readFileSync(path.join(HTML_ROOT, 'js', 'main.js'), 'utf8');

test('main.js defines initAdminHeaderLink() and runs it on DOMContentLoaded', () => {
    assert.ok(MAIN_JS.includes('function initAdminHeaderLink('),
        'main.js must define initAdminHeaderLink()');
    assert.ok(/DOMContentLoaded[\s\S]{0,400}initAdminHeaderLink\(\)/.test(MAIN_JS),
        'main.js must call initAdminHeaderLink() on DOMContentLoaded');
});

test('initAdminHeaderLink() injects the link into .header-actions (not static markup)', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes("createElement('a')") || body.includes('createElement("a")'),
        'initAdminHeaderLink() must create the anchor element in JS');
    assert.ok(/header-admin-link/.test(body),
        'initAdminHeaderLink() must set the header-admin-link id on the injected node');
    assert.ok(/querySelector\((['"])\.header-actions\1\)/.test(body),
        'initAdminHeaderLink() must insert the link into the right-hand .header-actions cluster, not .header-lead (the left column now holds the IC brand mark)');
    assert.ok(/appendChild/.test(body),
        'initAdminHeaderLink() must APPEND the link so it lands LAST in the cluster, past the cart. ' +
        'insertBefore would put it at the head, where business.js puts the Business Centre button.');
    assert.ok(/header-actions__item--admin/.test(body),
        'the injected link must keep the header-actions__item--admin class — that is the rule it shares with --business, so the two privileged shortcuts can never drift apart');
});

test('initAdminHeaderLink() gates the reveal on a server-side admin check', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes('API.verifyAdmin'),
        'initAdminHeaderLink() must call API.verifyAdmin() — the server is the source of truth for the admin role');
    assert.ok(body.includes('isAuthenticated'),
        'initAdminHeaderLink() must skip guests via Auth.isAuthenticated() so it never fires a verify call for logged-out visitors');
    assert.ok(body.includes('Auth.readyPromise'),
        'initAdminHeaderLink() must await Auth.readyPromise so the session is resolved before deciding');
});

test('initAdminHeaderLink() removes the link for guests / non-admins', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(/removeChild|\.remove\(\)/.test(body),
        'initAdminHeaderLink() must remove the injected link when the account is not an admin');
});

test('initAdminHeaderLink() re-evaluates on auth state changes (sign-in / sign-out)', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes('onAuthStateChange'),
        'initAdminHeaderLink() must register Auth.onAuthStateChange so the link appears/disappears on sign-in/sign-out without a reload');
});

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE (<1100px) — the drawer entry, added Aug 2026
//
// The header shortcut is desktop-only: below 1100px the action cluster is
// icon-only and a fifth 48px item does not fit the right grid track (ERR-148),
// so `.header-actions__item--admin` is display:none there. For months that
// meant an admin on a phone had NO route to /admin but typing the URL. The
// same verified reveal now also injects an "Admin Centre" row into the mobile
// nav drawer, which is a vertical list and costs no horizontal budget.
//
// The pair must stay mutually exclusive: exactly one Admin entry at every
// width, never two, never none.
// ─────────────────────────────────────────────────────────────────────────────

test('initAdminHeaderLink() also injects the mobile drawer entry (<1100px has no header shortcut)', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes('function ensureNavItem('),
        'initAdminHeaderLink() must define ensureNavItem() — below 1100px the header cluster hides Admin, so the drawer is the only entry point on a phone');
    assert.ok(/getElementById\((['"])nav-menu\1\)/.test(body),
        'ensureNavItem() must append into #nav-menu — the mobile drawer');
    assert.ok(/nav-menu__item--admin/.test(body),
        'the injected drawer row must carry .nav-menu__item--admin — that class is what hides it again at >=1100px, where the header shortcut takes over');
    assert.ok(/nav-admin-item/.test(body),
        'the drawer row needs the nav-admin-item id so the reveal is idempotent and the sign-out path can find it');
});

test('the drawer entry is created by the SAME reveal as the header shortcut', () => {
    // One reveal, two surfaces. If ensureNavItem() were called from anywhere
    // but ensureLink(), a future change to the gate would move one and not the
    // other — an unverified account keeping an /admin row in its menu.
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    const ensure = body.slice(body.indexOf('function ensureLink('));
    assert.ok(ensure.slice(0, ensure.indexOf('\n    }')).includes('ensureNavItem()'),
        'ensureLink() must call ensureNavItem() so both surfaces appear behind the one API.verifyAdmin() gate');
});

test('sign-out removes BOTH surfaces, not just the header shortcut', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    const remove = body.slice(body.indexOf('function removeLink('));
    const removeBody = remove.slice(0, remove.indexOf('\n    }') + 6);
    assert.ok(removeBody.includes('header-admin-link') && removeBody.includes('nav-admin-item'),
        'removeLink() must drop the drawer row as well as the header link — otherwise a revoked admin (or a signed-out browser) keeps an /admin row in its menu');
});

test('layout.css shows exactly one Admin entry at every width', () => {
    // The two gates are complementary by construction:
    //   <1100px  header shortcut display:none  (base rule) + drawer row visible
    //   >=1100px header shortcut display:flex  (MODE D)    + drawer row hidden
    assert.ok(LAYOUT_CSS.includes('.nav-menu__item--admin'),
        'layout.css must style the drawer entry');
    const modeD = LAYOUT_CSS.slice(LAYOUT_CSS.indexOf('@media (min-width: 1100px) {'));
    const modeDBlock = modeD.slice(0, modeD.indexOf('\n}\n'));
    assert.match(modeDBlock, /\.header-actions__item--admin\s*\{[^}]*display:\s*flex/,
        'MODE D (>=1100px) must reveal the header shortcut');
    assert.match(modeDBlock, /\.nav-menu__item--admin\s*\{[^}]*display:\s*none/,
        'MODE D (>=1100px) must hide the drawer row — otherwise an admin sees TWO Admin entries, and the horizontal nav row (already at its measured five-link limit) gains a sixth link and clips');
});

// ─────────────────────────────────────────────────────────────────────────────
// layout.css — the --admin modifier styling still ships
// ─────────────────────────────────────────────────────────────────────────────

const LAYOUT_CSS = fs.readFileSync(path.join(HTML_ROOT, 'css', 'layout.css'), 'utf8');

test('layout.css styles the --admin modifier so the shortcut reads as privileged', () => {
    assert.ok(LAYOUT_CSS.includes('.header-actions__item--admin'),
        'layout.css must style .header-actions__item--admin');
});

// ─────────────────────────────────────────────────────────────────────────────
// The header shortcut REPLACES the old /account sidebar link ("instead of")
// ─────────────────────────────────────────────────────────────────────────────

test('the legacy /account sidebar admin link is fully removed', () => {
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        assert.ok(!html.includes('id="admin-nav-item"'),
            `${rel(file)} still ships the legacy sidebar #admin-nav-item — the admin shortcut now lives only in the global header`);
        assert.ok(!html.includes('account-nav__item--admin'),
            `${rel(file)} still ships the legacy .account-nav__item--admin sidebar entry`);
    }
});

test('account.js no longer carries the dead checkAdminAccess() sidebar logic', () => {
    const accountJs = fs.readFileSync(path.join(HTML_ROOT, 'js', 'account.js'), 'utf8');
    assert.ok(!accountJs.includes('checkAdminAccess'),
        'account.js still references checkAdminAccess() — the sidebar admin link is gone; the header link (main.js) owns admin reveal now');
    assert.ok(!accountJs.includes("getElementById('admin-nav-item')"),
        'account.js still looks up the removed #admin-nav-item element');
});
