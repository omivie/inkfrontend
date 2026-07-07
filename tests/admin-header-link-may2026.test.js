/**
 * Admin header shortcut contract
 * ==============================
 *
 * A privileged "Admin" shortcut lets a verified admin jump to /admin from any
 * page. It lives in the global site header (`.header-actions`, beside the
 * Account button).
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
    assert.ok(body.includes('.header-actions') || body.includes("querySelector('.header-actions')"),
        'initAdminHeaderLink() must insert the link into .header-actions');
    assert.ok(/insertBefore|appendChild/.test(body),
        'initAdminHeaderLink() must attach the injected link to the DOM');
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
