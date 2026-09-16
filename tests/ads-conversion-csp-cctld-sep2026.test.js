/**
 * Our own CSP was blocking the Google Ads first-party conversion beacon (Sep 2026)
 * ==============================================================================
 * ERR-260
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Found by `npm run probe:ga4-events` against production, on the first run where
 * the add-to-cart conversion actually fired while the probe was watching the
 * wire. Verbatim, from `www.inkcartridges.co.nz`:
 *
 *   Connecting to 'https://www.google.co.nz/pagead/1p-conversion/18032498762/
 *   ?…&en=conversion&…&label=e3c8CI2D3dwcEMqw…&gcs=G1-1&…' violates the
 *   following Content Security Policy directive: "connect-src 'self' …
 *   https://*.google.com …". The action has been blocked.
 *
 * `en=conversion`, our add-to-cart label, consent granted — and blocked. Twice
 * per add.
 *
 * ***`https://*.google.com` DOES NOT MATCH `www.google.co.nz`.*** Google Ads
 * fires its first-party conversion beacon at the VISITOR'S COUNTRY DOMAIN, which
 * for this shop's entire market is `google.co.nz`. A wildcard on one registrable
 * domain says nothing about another. Same family as ERR-225 (an allowed origin is
 * not an allowed script) reached from a third direction: an allowed DOMAIN is not
 * an allowed COUNTRY DOMAIN.
 *
 * WHY IT HID FOR SO LONG — THREE REASONS, EACH ENOUGH ON ITS OWN
 * -------------------------------------------------------------
 *   1. `img-src 'self' https: data:` allows ANY https image, and most of Google's
 *      other calls to the cctld are pixels. Measured in the same run:
 *      `google.co.nz/ads/ga-audiences` 200 and `google.co.nz/pagead/1p-user-list/`
 *      200, both fine. Only `1p-conversion` is a FETCH, and only fetches are
 *      governed by `connect-src`. So the host looked reachable.
 *   2. The canonical conversion still lands. Measured: 200 from
 *      `www.googleadservices.com/pagead/conversion/18032498762/`. So the
 *      conversion is counted and no number in the Ads UI goes to zero — what is
 *      lost is the first-party/enhanced signal, which has no dashboard of its own.
 *   3. Localhost has NO CSP at all (`serve.json` sets no headers), so every local
 *      run is green by construction. The only place this is observable is
 *      production, with a real conversion firing, with something watching the
 *      wire.
 *
 * WHAT IS ACTUALLY LOST, STATED CAREFULLY
 * ---------------------------------------
 * Not "conversions are broken" — they are not, and saying so would be the easy
 * overstatement. The blocked request is the first-party conversion measurement
 * that carries the enhanced-conversion and consent-mode inputs (`ezwbk`, `pscrd`,
 * `cerd`, `fsk`). Losing it degrades attribution and enhanced-conversion matching
 * exactly where third-party cookies are unavailable — i.e. mobile Safari, which
 * is most of the 64% of ad clicks this whole area of work exists for.
 *
 * THE FIX IS ONE HOST, AND IT GRANTS NOTHING NEW IN SUBSTANCE
 * ----------------------------------------------------------
 * `https://*.google.co.nz` in `connect-src`. `https://*.google.com` was already
 * there, so this is the same party at the same trust level on its NZ domain.
 *
 * KNOWN AND DELIBERATE LIMIT: a visitor served a DIFFERENT cctld
 * (`google.com.au`, …) still loses this beacon. CSP has no wildcard that spans
 * registrable domains (`https://*.google.*` is not valid), the list of Google
 * cctlds is unbounded, and this shop ships only within New Zealand. So the
 * residual is a small slice of traffic losing an enhanced signal whose canonical
 * conversion still lands. That is a measured trade, not an oversight — which is
 * why it is written here rather than left for someone to rediscover.
 *
 * Run: node --test tests/ads-conversion-csp-cctld-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges/vercel.json'), 'utf8'));

/** The single Content-Security-Policy header value. */
function csp() {
    const found = [];
    for (const rule of VERCEL.headers || []) {
        for (const h of rule.headers || []) {
            if (h.key === 'Content-Security-Policy') found.push(h.value);
        }
    }
    assert.equal(found.length, 1, 'exactly one enforced CSP header — two would be an intersection nobody reads');
    return found[0];
}

/** One directive's token list. */
function directive(name) {
    const part = csp().split(';').map((s) => s.trim()).find((s) => s.startsWith(name + ' '));
    assert.ok(part, `${name} must be present`);
    return part.split(/\s+/).slice(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The fix
// ═══════════════════════════════════════════════════════════════════════════

test('§1 connect-src reaches the Google NZ country domain', () => {
    // The blocked beacon was https://www.google.co.nz/pagead/1p-conversion/…
    const c = directive('connect-src');
    assert.ok(c.includes('https://*.google.co.nz'),
        'the Ads first-party conversion beacon goes to the visitor\'s cctld; without this it is '
        + 'blocked and the enhanced-conversion signal is silently lost');
});

test('§1b and the .com wildcard is still there — this is an addition, not a swap', () => {
    // A negative control on my own fix: if someone "tidied" *.google.com away
    // while adding the cctld, the same class of block reappears for every
    // google.com endpoint, which is most of them.
    const c = directive('connect-src');
    assert.ok(c.includes('https://*.google.com'));
    assert.ok(c.includes('https://www.googleadservices.com'),
        'the canonical conversion endpoint — the one that still landed while the 1p beacon was blocked');
    assert.ok(c.includes('https://*.doubleclick.net'));
});

test('§1c the wildcard genuinely covers the measured host', () => {
    // `https://*.google.co.nz` must match `www.google.co.nz`. Assert the shape
    // rather than trusting the star: a bare `https://google.co.nz` would NOT
    // match the www host, and that mistake is invisible until production.
    const token = directive('connect-src').find((t) => t.includes('google.co.nz'));
    assert.equal(token, 'https://*.google.co.nz',
        'a bare https://google.co.nz does not match www.google.co.nz');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Why this could not be seen locally, or from source
// ═══════════════════════════════════════════════════════════════════════════

test('§2 localhost has no CSP, so a local run proves nothing about this', () => {
    // Recorded as an assertion because it is the reason three days of green
    // localhost probe runs said nothing. If serve.json ever grows headers, this
    // fails and someone gets to delete a paragraph of the docstring above.
    const serve = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges/serve.json'), 'utf8'));
    const hasCsp = JSON.stringify(serve).includes('Content-Security-Policy');
    assert.equal(hasCsp, false,
        'serve.json now sets a CSP — local runs can exercise it, and the docstring above is stale');
});

test('§2b img-src still allows any https, which is why the pixels looked fine', () => {
    // The diagnosis hinged on this: pixel calls to google.co.nz returned 200
    // while the fetch was blocked, so the host appeared reachable.
    assert.ok(directive('img-src').includes('https:'),
        'if this ever tightens, the Google cctld pixels need explicit entries too');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The header is still well-formed
// ═══════════════════════════════════════════════════════════════════════════

test('§3 the CSP survived the edit', () => {
    const value = csp();
    assert.ok(!value.includes(';;'), 'empty directive');
    assert.ok(!/\s;\s*$/.test(value.trim()), 'trailing semicolon');
    assert.ok(!/\s\s/.test(value), 'double space — a token may have been dropped');
    for (const required of ['default-src', 'script-src', 'style-src', 'frame-src', 'connect-src',
        'img-src', 'frame-ancestors', 'base-uri', 'form-action']) {
        assert.ok(value.includes(required + ' '), `${required} must be present`);
    }
});
