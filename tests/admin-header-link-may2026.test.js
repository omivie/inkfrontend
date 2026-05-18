/**
 * Admin header shortcut contract (May 2026)
 * =========================================
 *
 * The admin panel used to be reachable only from a sidebar link buried on
 * the /account page. This contract moves a privileged "Admin" shortcut into
 * the global site header (`.header-actions`, beside the Account button) so
 * an admin can jump to /admin from any page.
 *
 * Hard requirements:
 *   1. The link ships in EVERY customer-facing page's header markup, so the
 *      navbar stays byte-identical (project_navbar_parity_may2026). It is
 *      NOT injected by JS — injection would diverge the markup hash.
 *   2. The link ships with the `hidden` attribute. It is invisible to
 *      guests and to signed-in non-admins by default. This is the security
 *      default: if the JS never runs, nobody sees an admin link.
 *   3. main.js#initAdminHeaderLink() is the ONLY thing that unhides it, and
 *      only after a server-side role check (API.verifyAdmin →
 *      GET /api/admin/verify). Client state is never trusted for the gate;
 *      the /admin route itself re-verifies server-side regardless.
 *   4. layout.css carries `.header-actions__item[hidden] { display: none }`
 *      — without it the `display: flex` on `.header-actions__item` (author
 *      CSS) beats the UA `[hidden]` rule and the link shows for everyone.
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
            if (entry.name === 'admin' || entry.name === 'business') continue;
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

const LINK_TAG = '<a href="/admin" class="header-actions__item header-actions__item--admin" id="header-admin-link" hidden>';

test('every customer-facing page with a header ships the admin shortcut', () => {
    assert.ok(PAGES_WITH_HEADER.length >= 20,
        `expected 20+ pages with a site-header, found ${PAGES_WITH_HEADER.length}`);
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(header.includes(LINK_TAG),
            `${rel(file)} is missing the canonical admin header link:\n  ${LINK_TAG}`);
    }
});

test('admin link ships hidden by default — invisible until JS verifies the role', () => {
    for (const { file, header } of PAGES_WITH_HEADER) {
        // Pull just the admin anchor open tag and assert `hidden` is on it.
        const i = header.indexOf('id="header-admin-link"');
        assert.notEqual(i, -1, `${rel(file)} has no #header-admin-link`);
        const open = header.slice(header.lastIndexOf('<a ', i), header.indexOf('>', i) + 1);
        assert.ok(/\shidden(\s|>)/.test(open),
            `${rel(file)} renders #header-admin-link WITHOUT the hidden attribute — it would show for guests. Tag: ${open}`);
    }
});

test('admin link lives inside .header-actions, between Account and Favourites', () => {
    for (const { file, header } of PAGES_WITH_HEADER) {
        const actionsStart = header.indexOf('<div class="header-actions">');
        const actionsEnd = header.indexOf('</div>', actionsStart);
        const adminPos = header.indexOf('id="header-admin-link"');
        assert.ok(adminPos > actionsStart && adminPos < actionsEnd,
            `${rel(file)}: admin link is not inside <div class="header-actions">`);

        const account = header.indexOf('href="/account"');
        const favourites = header.indexOf('href="/account/favourites"');
        assert.ok(account !== -1 && favourites !== -1, `${rel(file)}: missing account/favourites links`);
        assert.ok(adminPos > account && adminPos < favourites,
            `${rel(file)}: admin link must sit between the Account and Favourites buttons`);
    }
});

test('admin link points at /admin and carries the --admin modifier class', () => {
    for (const { file, header } of PAGES_WITH_HEADER) {
        const i = header.indexOf('id="header-admin-link"');
        const open = header.slice(header.lastIndexOf('<a ', i), header.indexOf('>', i) + 1);
        assert.ok(open.includes('href="/admin"'), `${rel(file)}: admin link href is not /admin`);
        assert.ok(open.includes('header-actions__item--admin'),
            `${rel(file)}: admin link is missing the header-actions__item--admin modifier class`);
        assert.ok(open.includes('header-actions__item '),
            `${rel(file)}: admin link must keep the base header-actions__item class for header layout`);
    }
});

test('the admin link is static markup, never JS-injected (keeps navbar byte-identical)', () => {
    const jsDir = path.join(HTML_ROOT, 'js');
    for (const f of fs.readdirSync(jsDir)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        assert.ok(!/createElement[\s\S]{0,200}header-admin-link/.test(src)
                  && !/innerHTML[\s\S]{0,200}header-admin-link/.test(src),
            `js/${f} appears to inject #header-admin-link into the DOM — the link must be static HTML so every page's navbar stays byte-identical`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// main.js — the reveal logic
// ─────────────────────────────────────────────────────────────────────────────

const MAIN_JS = fs.readFileSync(path.join(HTML_ROOT, 'js', 'main.js'), 'utf8');

test('main.js defines initAdminHeaderLink() and runs it on DOMContentLoaded', () => {
    assert.ok(MAIN_JS.includes('function initAdminHeaderLink('),
        'main.js must define initAdminHeaderLink()');
    assert.ok(/DOMContentLoaded[\s\S]{0,400}initAdminHeaderLink\(\)/.test(MAIN_JS),
        'main.js must call initAdminHeaderLink() on DOMContentLoaded');
});

test('initAdminHeaderLink() gates the reveal on a server-side admin check', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes('API.verifyAdmin'),
        'initAdminHeaderLink() must call API.verifyAdmin() — the server is the source of truth for the admin role');
    assert.ok(body.includes('getElementById(\'header-admin-link\')'),
        'initAdminHeaderLink() must target #header-admin-link');
    assert.ok(body.includes('isAuthenticated'),
        'initAdminHeaderLink() must skip guests via Auth.isAuthenticated() so it never fires a verify call for logged-out visitors');
    assert.ok(/link\.hidden\s*=/.test(body),
        'initAdminHeaderLink() must toggle link.hidden');
    assert.ok(body.includes('Auth.readyPromise'),
        'initAdminHeaderLink() must await Auth.readyPromise so the session is resolved before deciding');
});

test('initAdminHeaderLink() re-evaluates on auth state changes (sign-in / sign-out)', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes('onAuthStateChange'),
        'initAdminHeaderLink() must register Auth.onAuthStateChange so the link appears/disappears on sign-in/sign-out without a reload');
});

// ─────────────────────────────────────────────────────────────────────────────
// layout.css — the [hidden] insulation
// ─────────────────────────────────────────────────────────────────────────────

const LAYOUT_CSS = fs.readFileSync(path.join(HTML_ROOT, 'css', 'layout.css'), 'utf8');

test('layout.css forces .header-actions__item[hidden] to display:none', () => {
    assert.match(LAYOUT_CSS, /\.header-actions__item\[hidden\]\s*\{\s*display:\s*none;?\s*\}/,
        'layout.css must declare `.header-actions__item[hidden] { display: none }` — otherwise the base `display: flex` (author CSS) overrides the UA [hidden] rule and the admin link shows for everyone');
});

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

test('layout.css cache key is bumped so the new CSS actually ships', () => {
    let stale = 0;
    let total = 0;
    for (const { file } of PAGES_WITH_HEADER) {
        const html = fs.readFileSync(file, 'utf8');
        const m = html.match(/layout\.css\?v=([^"'\s]+)/);
        if (!m) continue;
        total++;
        if (m[1] === 'chrome-lock-may2026') stale++;
    }
    assert.equal(stale, 0,
        `${stale}/${total} pages still reference the pre-admin-link layout.css cache key — bump it so the .header-actions__item[hidden] rule ships`);
});
