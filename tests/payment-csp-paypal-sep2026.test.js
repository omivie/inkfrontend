/**
 * Our own CSP was blocking the PayPal SDK on production (Sep 2026)
 * ================================================================
 * ERR-225
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Found while walking the mobile checkout funnel on the LIVE site. Verbatim,
 * from production:
 *
 *   Executing inline script violates the following Content Security Policy
 *   directive 'script-src 'self' … https://www.paypal.com https://*.paypal.com
 *   … 'sha256-0JmmTUETUXDHkK3pNmvl/MoDE5MN0DDwFCnqKmhR2Go=''. Either the
 *   'unsafe-inline' keyword, a hash
 *   ('sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='), or a nonce is
 *   required to enable inline execution. The action has been blocked.
 *     @ https://www.paypal.com/sdk/js?client-id=…
 *
 * `script-src` allows the paypal.com ORIGIN, so the SDK file downloads fine and
 * `payment-page.js` even logs "PayPal button initialized successfully". The SDK
 * then executes an INLINE script, which the same directive forbids — so an
 * entire payment method was dead at the last step of the funnel, on every
 * device, while the page reported success.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE
 * -----------------------------------
 * It pins that the hash is present and explains why. It CANNOT verify the hash
 * still MATCHES what PayPal executes: the blocked script is created by the SDK
 * at runtime, not carried in its body (measured — the 99,898-byte SDK response
 * contains no `<script` at all), so there is nothing to recompute offline. Only
 * a real browser can adjudicate that, which is exactly how this was found.
 *
 * A hash is therefore a FRAGILE fix and is treated as one: `npm run
 * probe:payment-csp` re-reads the deployed header AND watches PayPal's SDK body
 * for change, so the day PayPal ships a new SDK we are told to re-verify rather
 * than finding out from a customer who could not pay.
 *
 * Run: node --test tests/payment-csp-paypal-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges/vercel.json'), 'utf8'));

const PAYPAL_INLINE_HASH = "'sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='";

/**
 * The hash this suite used to insist on keeping (ERR-230).
 *
 * commit df17277 added it to script-src describing it as the PayPal inline
 * script hash. It was a wrong guess: it has never matched any inline script in
 * this repo, at that commit or any since. ERR-225 — PayPal downloading but not
 * running, "initialized successfully" logged over a dead payment method, 0 of 46
 * mobile checkouts completing — happened BECAUSE that hash was wrong. 071f446
 * then added the real one (n8Se…) and left the wrong one in place, and the test
 * below pinned it with the comment "the original site hash must survive".
 *
 * So a suite written to stop a silent CSP failure was guarding a value that
 * protected nothing, while three of the site's own inline scripts were being
 * refused in production. It is asserted ABSENT now, and §1b below replaces the
 * intent it was reaching for with something that can actually detect the problem.
 */
const RETIRED_WRONG_HASH = "'sha256-0JmmTUETUXDHkK3pNmvl/MoDE5MN0DDwFCnqKmhR2Go='";

/** The Content-Security-Policy value as actually configured. */
function csp() {
    const headers = [];
    for (const entry of VERCEL.headers || []) {
        for (const h of entry.headers || []) {
            if (/^content-security-policy$/i.test(h.key)) headers.push(h.value);
        }
    }
    assert.equal(headers.length, 1, `expected exactly one CSP header, found ${headers.length}`);
    return headers[0];
}
const directive = (name) => {
    const m = csp().split(';').map(s => s.trim()).find(s => s.startsWith(name + ' '));
    assert.ok(m, `${name} directive must exist`);
    return m;
};

test('§1 the PayPal inline-script hash is allowlisted in script-src', () => {
    // Without this, https://*.paypal.com lets the SDK download and then the SDK
    // cannot run — the worst shape of failure, because the page logs success.
    assert.ok(directive('script-src').includes(PAYPAL_INLINE_HASH),
        'PayPal is blocked at the last step of checkout without this hash');
});

test('§1 the hash that never matched anything is gone (ERR-230)', () => {
    const s = directive('script-src');
    assert.ok(!s.includes(RETIRED_WRONG_HASH),
        'df17277 guessed the PayPal hash wrong; n8Se… superseded it and this one covers no script');
    assert.notEqual(PAYPAL_INLINE_HASH, RETIRED_WRONG_HASH);
});

test('§1b EVERY executable inline script has a matching hash in script-src', () => {
    // The assertion the old §1 was reaching for and could not make. A hash in
    // the policy proves nothing on its own — what matters is whether the scripts
    // we actually ship are permitted. This walks the tree, hashes each inline
    // block the way a browser does (sha256 of the exact body, base64), and fails
    // on any that script-src would refuse.
    //
    // When it caught this for the first time it found three: the homepage
    // scroll-restoration guard, the personal-details toast helper, and the
    // sync-report redirect — all refused in production, none logging anywhere
    // but the console. All three are external files now, so the expected state
    // is zero inline scripts; the test does not require that, only that whatever
    // is inline can run.
    const s = directive('script-src');
    const unsafeInline = /'unsafe-inline'/.test(s);
    const allowed = new Set([...s.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]));

    const htmlFiles = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
            else if (e.name.endsWith('.html')) htmlFiles.push(p);
        }
    })(path.join(ROOT, 'inkcartridges'));

    const refused = [];
    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, 'utf8');
        for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
            // ld+json is data, never executed, and not subject to script-src.
            if (/type\s*=\s*["']application\/ld\+json/.test(m[1] || '')) continue;
            if (!m[2].trim()) continue;
            const hash = crypto.createHash('sha256').update(m[2], 'utf8').digest('base64');
            if (unsafeInline || allowed.has(hash)) continue;
            const line = html.slice(0, m.index).split('\n').length;
            refused.push(`${path.relative(ROOT, file)}:${line} needs 'sha256-${hash}'`);
        }
    }
    assert.deepEqual(refused, [],
        `inline script(s) the deployed CSP will refuse:\n  ${refused.join('\n  ')}`);
});

test('§1 the origin allowance is still there too — the hash does not replace it', () => {
    // The hash permits the inline execution; the origin permits the download.
    // Both are required and they are not substitutes.
    const s = directive('script-src');
    for (const origin of ['https://www.paypal.com', 'https://*.paypal.com', 'https://*.paypalobjects.com']) {
        assert.ok(s.includes(origin), `${origin} must remain in script-src`);
    }
});

test('§2 unsafe-inline was NOT used to solve this', () => {
    // The lazy fix. It would unblock PayPal and every injected script on the
    // payment page along with it — on the one page where that matters most.
    assert.ok(!directive('script-src').includes("'unsafe-inline'"),
        "script-src must never carry 'unsafe-inline'");
});

test('§2 Stripe is still allowed — the payment path has two providers', () => {
    const s = directive('script-src');
    assert.ok(s.includes('https://js.stripe.com'), 'a CSP edit that breaks Stripe breaks all payment');
    const frame = directive('frame-src');
    assert.ok(frame.includes('https://js.stripe.com'));
    assert.ok(frame.includes('https://*.paypal.com'));
});

test('§2 Turnstile is still allowed — a guest cannot pay without it', () => {
    // payment-page.js hard-gates the Pay button on a Turnstile token for
    // guests, so losing this origin would disable guest checkout entirely.
    assert.ok(directive('script-src').includes('https://challenges.cloudflare.com'));
    assert.ok(directive('frame-src').includes('https://challenges.cloudflare.com'));
});

test('§3 connect-src still reaches both API hosts', () => {
    const c = directive('connect-src');
    for (const host of ['https://api.inkcartridges.co.nz', 'https://ink-backend-zaeq.onrender.com']) {
        assert.ok(c.includes(host), `${host} must stay reachable`);
    }
});

test('§3 the CSP is a single well-formed header', () => {
    const value = csp();
    assert.ok(!value.includes(';;'), 'empty directive');
    assert.ok(!/\s;\s*$/.test(value.trim()), 'trailing semicolon');
    for (const required of ['default-src', 'script-src', 'style-src', 'frame-src', 'connect-src', 'frame-ancestors']) {
        assert.ok(value.includes(required + ' '), `${required} must be present`);
    }
});
