/**
 * Account sign-in redirect — trailing-slash 404 regression
 * ========================================================
 *
 * Origin: production bug 2026-05-21 — signing in (or completing Google OAuth,
 * or being bounced by the admin gate) redirected the browser to `/account/`
 * with a trailing slash. On Vercel (cleanUrls + the `/account/:path*` rewrite)
 * `/account/` resolves to the directory `/html/account/` and returns 404, while
 * `/account` (no slash, used by the nav) serves `/html/account/index.html`.
 *
 *   $ curl -L https://inkcartridges.co.nz/account/   → 404
 *   $ curl -L https://inkcartridges.co.nz/account     → 200
 *
 * Fix:
 *   1. Every in-app redirect/href target uses the slash-less `/account`
 *      (Security.safeRedirect default fallback, auth.js OAuth redirectTo,
 *      admin/auth.js gate bounces, personal-details breadcrumbs).
 *   2. A scoped Vercel redirect `/account/` → `/account` catches any
 *      bookmarked / externally-linked trailing-slash hit.
 *
 * These tests pin both halves so the trailing slash can't creep back in.
 *
 * Run with:
 *   node --test tests/account-trailing-slash-redirect.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = path.join(INK, 'js');

function read(rel) {
    return fs.readFileSync(path.join(INK, rel), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Security.safeRedirect default fallback must be slash-less.
//     This is the post-sign-in target when there is no ?redirect= param.
// ─────────────────────────────────────────────────────────────────────────────
test('security.js — safeRedirect default fallback is /account (no trailing slash)', () => {
    const src = read('js/security.js');
    const m = src.match(/safeRedirect\(url,\s*fallback\s*=\s*'([^']*)'\)/);
    assert.ok(m, 'safeRedirect signature with default fallback must exist');
    assert.equal(m[1], '/account',
        `BUG REGRESSION: safeRedirect falls back to "${m[1]}" — a trailing slash 404s on Vercel.`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) No JS file may redirect/route to the bare trailing-slash "/account/".
//     Sub-paths like "/account/login" are fine — only the bare directory 404s.
// ─────────────────────────────────────────────────────────────────────────────
test('js/ — no redirect target is the bare "/account/" (trailing slash 404s)', () => {
    const offenders = [];

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js')) continue;
            const src = fs.readFileSync(full, 'utf8');
            src.split('\n').forEach((line, i) => {
                // bare '/account/' or `${...origin}/account/` immediately closed —
                // i.e. nothing but the quote/backtick after the trailing slash.
                if (/['"`]\/account\/['"`]/.test(line) ||
                    /\/account\/`/.test(line)) {
                    offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
                }
            });
        }
    }
    walk(JS);

    assert.deepEqual(offenders, [],
        `These redirect/route targets use the bare trailing-slash "/account/" which 404s on Vercel — ` +
        `use "/account":\n${offenders.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Vercel safety-net redirect /account/ → /account exists and is well-formed.
// ─────────────────────────────────────────────────────────────────────────────
test('vercel.json — /account/ redirects to /account', () => {
    const cfg = JSON.parse(read('vercel.json'));
    const rule = cfg.redirects.find((r) => r.source === '/account/');
    assert.ok(rule, 'a redirect with source "/account/" must exist');
    assert.equal(rule.destination, '/account');
    assert.equal(rule.permanent, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) The /account rewrite that actually serves the page is still present.
// ─────────────────────────────────────────────────────────────────────────────
test('vercel.json — /account rewrite to /html/account is intact', () => {
    const cfg = JSON.parse(read('vercel.json'));
    const rw = cfg.rewrites.find((r) => r.source === '/account');
    assert.ok(rw, '/account rewrite must exist so the slash-less URL serves the page');
    assert.equal(rw.destination, '/html/account');
});
