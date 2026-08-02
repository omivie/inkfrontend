/**
 * Admin header shortcut contract
 * ==============================
 *
 * A privileged "Admin" shortcut lets a verified admin jump to /admin from any
 * page. It lives in the global site header's LEFT column (`.header-lead`,
 * after the phone/email contact block and hard against the logo).
 *
 * MOVED — Aug 2026: it used to sit at the head of the right-hand
 * `.header-actions` cluster. That slot is now reserved for the customer-facing
 * Business account button, so the shortcut was relocated to `.header-lead` —
 * a wrapper added around `.header-contact` in all 29 shared headers precisely
 * so the two can share the left grid track without overlapping.
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
 *   2. main.js#initAdminHeaderLink() creates and inserts the link into
 *      `.header-lead`, only after a server-side role check
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

test('every shared header ships the .header-lead wrapper the shortcut is injected into', () => {
    // ensureLink() bails when .header-lead is missing, so a page that skipped
    // the Aug 2026 wrapper edit would silently lose the Admin shortcut.
    for (const { file, header } of PAGES_WITH_HEADER) {
        assert.ok(header.includes('class="header-lead"'),
            `${rel(file)} is missing the .header-lead wrapper — main.js#initAdminHeaderLink has nowhere to inject the shortcut`);
        assert.match(header, /<div class="header-lead">\s*<div class="header-contact">/,
            `${rel(file)}: .header-lead must directly wrap .header-contact so the contact stack and the admin shortcut share the left grid track`);
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

test('initAdminHeaderLink() injects the link into .header-lead (not static markup)', () => {
    const fn = MAIN_JS.slice(MAIN_JS.indexOf('function initAdminHeaderLink('));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    assert.ok(body.includes("createElement('a')") || body.includes('createElement("a")'),
        'initAdminHeaderLink() must create the anchor element in JS');
    assert.ok(/header-admin-link/.test(body),
        'initAdminHeaderLink() must set the header-admin-link id on the injected node');
    assert.ok(/querySelector\((['"])\.header-lead\1\)/.test(body),
        'initAdminHeaderLink() must insert the link into .header-lead (the header\'s left column), not the right-hand .header-actions cluster');
    assert.ok(/insertBefore|appendChild/.test(body),
        'initAdminHeaderLink() must attach the injected link to the DOM');
    // The shortcut keeps the .header-actions__item styling even though it no
    // longer lives in .header-actions — that is what makes the move purely
    // positional (same shield icon, same icon-over-label treatment).
    assert.ok(/header-actions__item--admin/.test(body),
        'the injected link must keep the header-actions__item--admin class so its styling is unchanged by the move');
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
