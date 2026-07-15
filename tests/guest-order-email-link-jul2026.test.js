/**
 * Guest-aware "View your order" email link → /orders/track alias (Jul 2026)
 * =========================================================================
 *
 * Backend change (separate repo, already deployed): order emails
 * (invoice/confirmation, tracking notification, refund) made the
 * "View your order →" button guest-aware —
 *   • member (order has user_id) → ${SITE_URL}/account/orders   (unchanged)
 *   • guest  (no user_id)        → ${SITE_URL}/orders/track?order=<ORDER_NUMBER>
 *
 * The backend note assumed the public Track Order page already lived at
 * `/orders/track`. It does NOT — in this repo the page is served at the
 * canonical `/track-order` (vercel.json rewrite → /html/track-order;
 * <link rel="canonical"> = …/track-order). `/orders/track` matched no rewrite
 * and no redirect catch-all, so every guest clicking the new button hit a 404.
 *
 * Fix: a single 301 redirect `/orders/track` → `/track-order` in vercel.json.
 * Vercel evaluates redirects before rewrites/filesystem and preserves the query
 * string when the destination has none, so `/orders/track?order=123` →
 * `/track-order?order=123`, where the existing `?order=` prefill runs. Keeping
 * one canonical URL (redirect, not rewrite) avoids a duplicate-content surface.
 *
 * The FE "enhancement" the note requested — prefill the order-number field from
 * `?order=` — was ALREADY implemented in track-order-page.js. This suite pins
 * BOTH halves so neither the route nor the prefill can silently rot:
 *   1. Route:   the /orders/track → /track-order redirect exists, is permanent,
 *               is a redirect (not a rewrite), and does not self-loop.
 *   2. Prefill: the controller reads ?order= and assigns it as input.value
 *               (untrusted display text — never via innerHTML); the
 *               #track-order-number contract still exists on the page.
 *
 * Run with:
 *   node --test tests/guest-order-email-link-jul2026.test.js
 *   (also picked up by `npm test` from inkcartridges/)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

const VERCEL = JSON.parse(read('vercel.json'));
const CTRL_SRC = read('js/track-order-page.js');
const PUB_HTML = read('html/track-order.html');

// path-to-regexp lite — same subset as tests/vercel-redirects.test.js, enough
// to prove the alias does not match its own destination (the loop class).
function compileVercelSource(source) {
    let out = '';
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '(') {
            let depth = 1;
            let j = i + 1;
            while (j < source.length && depth > 0) {
                if (source[j] === '\\' && j + 1 < source.length) { j += 2; continue; }
                if (source[j] === '(') depth++;
                else if (source[j] === ')') depth--;
                if (depth > 0) j++;
            }
            out += source.slice(i, j + 1);
            i = j + 1;
        } else if (ch === ':') {
            let j = i + 1;
            while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
            const isStar = source[j] === '*';
            if (isStar) j++;
            out += isStar ? '(?:.*)' : '[^/]+';
            i = j;
        } else if (ch === '/') {
            out += '/';
            i++;
        } else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    return new RegExp('^' + out + '/?$');
}

// ─── 1. Route: /orders/track → /track-order ─────────────────────────────────

test('vercel.json: a redirect maps /orders/track → /track-order', () => {
    const rule = VERCEL.redirects.find((r) => r.source === '/orders/track');
    assert.ok(rule,
        'guest order emails link to /orders/track — a redirect to the canonical ' +
        '/track-order MUST exist or every guest hits a 404');
    assert.equal(rule.destination, '/track-order',
        'must land on the canonical Track Order page');
    assert.equal(rule.permanent, true,
        'permanent (301) — matches every other redirect in this file');
});

test('vercel.json: /orders/track is a REDIRECT, not a rewrite (single canonical)', () => {
    // A rewrite would serve the page at two live URLs; the canonical tag points
    // at /track-order, so the alias must forward, not duplicate.
    const rw = (VERCEL.rewrites || []).find((r) => r.source === '/orders/track');
    assert.equal(rw, undefined,
        '/orders/track must not also be a rewrite — that would create a duplicate ' +
        'content surface alongside the canonical /track-order');
});

test('vercel.json: /orders/track redirect does not self-loop', () => {
    // Guard against the ERR_TOO_MANY_REDIRECTS class pinned by
    // tests/vercel-redirects.test.js: the destination must not match the source.
    const rule = VERCEL.redirects.find((r) => r.source === '/orders/track');
    const re = compileVercelSource(rule.source);
    assert.equal(re.test('/track-order'), false,
        'source pattern must not match its own destination');
    // And the canonical page must not itself be swept into any redirect source
    // (that would chain the alias onward). The generic convergence check lives
    // in tests/vercel-redirects.test.js; here we assert the direct hop settles.
    const onward = VERCEL.redirects.find((r) => compileVercelSource(r.source).test('/track-order'));
    assert.equal(onward, undefined,
        '/track-order must be a fixed point — no redirect may re-match it');
});

test('vercel.json: the canonical /track-order rewrite is still intact', () => {
    // The redirect is useless if the destination stops serving the page.
    const rw = VERCEL.rewrites.find((r) => r.source === '/track-order');
    assert.ok(rw, '/track-order rewrite must exist so the canonical URL serves the page');
    assert.equal(rw.destination, '/html/track-order');
});

// ─── 2. Prefill: ?order= populates the order-number field ───────────────────

test('track-order-page.js: reads the ?order= query param via URLSearchParams', () => {
    assert.match(CTRL_SRC, /new URLSearchParams\(\s*window\.location\.search\s*\)/,
        'must read the query string');
    assert.match(CTRL_SRC, /\.get\(\s*['"]order['"]\s*\)/,
        "must read the 'order' param the guest email appends");
});

test('track-order-page.js: prefills #track-order-number as input.value (never innerHTML)', () => {
    // Isolate the deep-link block so the assertion is about the prefill sink,
    // not some unrelated .value elsewhere in the controller.
    const start = CTRL_SRC.indexOf("get('order')");
    assert.ok(start !== -1, "the ?order= read must be present");
    const block = CTRL_SRC.slice(start, start + 360);

    assert.match(block, /getElementById\(\s*['"]track-order-number['"]\s*\)/,
        'must target the order-number input');
    assert.match(block, /\.value\s*=/,
        'the untrusted param must be assigned as input.value — a safe text sink');
    assert.doesNotMatch(block, /innerHTML/,
        'the ?order= param must NEVER be routed through innerHTML (untrusted display text)');
});

test('track-order.html: the #track-order-number input contract still exists', () => {
    assert.match(PUB_HTML, /id=["']track-order-number["']/,
        'the prefill target must exist on the public Track Order page');
    // Guests only need to type their email; the page keeps a separate email field.
    assert.match(PUB_HTML, /id=["']track-email["']/,
        'the checkout-email field the guest fills in must remain');
});
