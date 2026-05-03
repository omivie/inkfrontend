/**
 * Vercel redirect rules — loop & catch-all hygiene
 * =================================================
 *
 * Pins behaviour of `inkcartridges/vercel.json` redirects.
 *
 * Origin: production bug 2026-05-03 — `/ribbons` and `/ribbons?printer_brand=*`
 * returned `HTTP/2 308` with `Location: /ribbons` (i.e. the URL it just
 * received), causing `ERR_TOO_MANY_REDIRECTS` in browsers. Cause: a catch-all
 * `/([^/]*[Rr]ibbon[^/]*)` redirect intended for legacy product pages
 * (`/panasonic-ribbon`, `/typewriter-ribbon`, …) also matched the canonical
 * `/ribbons`, redirecting it to itself.
 *
 * The fix is a negative lookahead in the source pattern. These tests:
 *   1. Pin that the canonical /ribbons does NOT match the catch-all anymore.
 *   2. Pin that legacy ribbon/typewriter paths still DO redirect to /ribbons.
 *   3. Generic loop check: every redirect rule's destination must not match
 *      its own source — so the next catch-all somebody adds doesn't reopen
 *      the same class of bug.
 *
 * Run with:
 *   node --test tests/vercel-redirects.test.js
 *   (also picked up by `npm test` from inkcartridges/)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const VERCEL_JSON = path.join(INK, 'vercel.json');

const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
// Path-to-regexp lite — converts a Vercel `source` string into a JS RegExp.
//
// We only support the subset used in this repo's vercel.json:
//   • `:param`             → [^/]+
//   • `:param*`            → (?:.*)        (zero-or-more of anything, `*` is greedy
//                                            and may span slashes per Vercel/Next semantics)
//   • `(regex)`            → kept verbatim (path-to-regexp passes custom regex through)
//   • literal text         → escaped except for `/`
// Anchors: ^source$. Trailing `/` is accepted.
//
// This is enough to catch the bug class — a wholesale path-to-regexp fork is
// not warranted here.
// ─────────────────────────────────────────────────────────────────────────────
function compileVercelSource(source) {
    let out = '';
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '(') {
            // Custom regex group — copy until matching close paren (account for nesting).
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
            // :param or :param*  — read identifier (alnum + underscore).
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
            // Escape regex meta chars in literals.
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            i++;
        }
    }
    return new RegExp('^' + out + '/?$');
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) The /ribbons self-redirect bug — pinned out.
// ─────────────────────────────────────────────────────────────────────────────

function findRule(predicate) {
    return cfg.redirects.find(predicate);
}

test('vercel.json — [Rr]ibbon catch-all does NOT match canonical /ribbons (the production bug)', () => {
    const rule = findRule((r) => /\[Rr\]ibbon/.test(r.source));
    assert.ok(rule, '[Rr]ibbon catch-all rule must exist');
    const re = compileVercelSource(rule.source);
    assert.equal(re.test('/ribbons'), false,
        `BUG REGRESSION: source=${rule.source} matches /ribbons → ERR_TOO_MANY_REDIRECTS in browser. ` +
        `The pattern must exclude the canonical /ribbons via a negative lookahead.`);
});

test('vercel.json — [Rr]ibbon catch-all does NOT match canonical /ribbons with query string-stripped form', () => {
    // Vercel matches against the path only (query string is preserved across the redirect).
    // /ribbons?printer_brand=amano → matcher sees "/ribbons" → must NOT match.
    const rule = findRule((r) => /\[Rr\]ibbon/.test(r.source));
    const re = compileVercelSource(rule.source);
    assert.equal(re.test('/ribbons'), false);
});

test('vercel.json — [Rr]ibbon catch-all DOES still redirect legacy ribbon URLs', () => {
    const rule = findRule((r) => /\[Rr\]ibbon/.test(r.source));
    const re = compileVercelSource(rule.source);
    const legacy = [
        '/ribbon',                                          // singular → canonical
        '/Ribbon',                                          // capitalised
        '/Ribbons',                                         // capitalised plural (case mismatch with canonical)
        '/panasonic-ribbon',
        '/brother-typewriter-ribbon',
        '/group-4-olivetti-ribbon-black-red',
        '/old-typewriter-ribbon-cassettes',
        '/foo-ribbons-bar',                                 // ribbons in middle
    ];
    for (const p of legacy) {
        assert.equal(re.test(p), true,
            `legacy URL ${p} must still redirect to /ribbons via the catch-all`);
    }
});

test('vercel.json — [Rr]ibbon catch-all destination is exactly /ribbons (a misroute would just hide the loop)', () => {
    const rule = findRule((r) => /\[Rr\]ibbon/.test(r.source));
    assert.equal(rule.destination, '/ribbons');
    assert.equal(rule.permanent, true);
});

test('vercel.json — [Tt]ypewriter catch-all does not loop on its destination', () => {
    const rule = findRule((r) => /\[Tt\]ypewriter/.test(r.source));
    assert.ok(rule, '[Tt]ypewriter catch-all must exist');
    const re = compileVercelSource(rule.source);
    assert.equal(re.test('/ribbons'), false,
        '[Tt]ypewriter rule must not match /ribbons (would chain into the [Rr]ibbon rule)');
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Generic invariant — no redirect destination may re-match its own source.
//
// A catch-all whose destination satisfies its own pattern is, by definition,
// an infinite redirect loop. Vercel will return 308 → 308 → … until the
// browser gives up with ERR_TOO_MANY_REDIRECTS.
// ─────────────────────────────────────────────────────────────────────────────
test('vercel.json — no redirect rule self-matches its destination (loop invariant)', () => {
    const offenders = [];
    for (const rule of cfg.redirects) {
        const re = compileVercelSource(rule.source);
        // Strip query string from destination — Vercel's matcher operates on the path only.
        const destPath = rule.destination.split('?')[0].split('#')[0];

        // Only meaningful when destination is a same-origin path (starts with `/`).
        if (!destPath.startsWith('/')) continue;

        // Skip rules whose destination contains a backref ($1/$2/…) or a :param
        // placeholder — those expand at runtime to values that vary by request,
        // and the static destination string isn't a real URL we can test.
        if (/\$\d+/.test(destPath) || /:[A-Za-z_]/.test(destPath)) continue;

        if (re.test(destPath)) {
            offenders.push({ source: rule.source, destination: rule.destination });
        }
    }
    assert.deepEqual(offenders, [],
        `Redirect rules whose destination re-matches their source — these cause infinite loops:\n` +
        JSON.stringify(offenders, null, 2));
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Cross-rule loop check — destination must not match any earlier rule
//     in a way that produces a cycle. Vercel iterates the redirect list and
//     re-applies it; after ~5 hops the user sees ERR_TOO_MANY_REDIRECTS.
//
//     We approximate by walking up to 10 hops from each rule's destination
//     and asserting we reach a fixed point.
// ─────────────────────────────────────────────────────────────────────────────
test('vercel.json — every redirect destination converges within 10 hops', () => {
    const compiled = cfg.redirects.map((r) => ({
        re: compileVercelSource(r.source),
        rule: r,
    }));

    function step(p) {
        for (const { re, rule } of compiled) {
            if (re.test(p)) {
                let dest = rule.destination.split('?')[0].split('#')[0];
                if (!dest.startsWith('/')) return null;            // off-origin: stop walking
                if (/\$\d+/.test(dest) || /:[A-Za-z_]/.test(dest)) return null; // dynamic backref
                return dest;
            }
        }
        return null;
    }

    const failures = [];
    for (const { rule } of compiled) {
        const start = rule.destination.split('?')[0].split('#')[0];
        if (!start.startsWith('/')) continue;
        if (/\$\d+/.test(start) || /:[A-Za-z_]/.test(start)) continue;

        let current = start;
        const seen = new Set([current]);
        for (let i = 0; i < 10; i++) {
            const next = step(current);
            if (next === null) break;                              // settled — no rule matches
            if (seen.has(next)) {
                failures.push({ rule: rule.source, chain: [...seen, next].join(' → ') });
                break;
            }
            seen.add(next);
            current = next;
        }
    }
    assert.deepEqual(failures, [],
        `Redirect chains form a cycle:\n${JSON.stringify(failures, null, 2)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Sanity — the /ribbons rewrite (line 103-ish) is still present so the
//     canonical URL actually serves content once we let it through the
//     redirect layer.
// ─────────────────────────────────────────────────────────────────────────────
test('vercel.json — /ribbons rewrite to /html/ribbons is intact', () => {
    const rw = cfg.rewrites.find((r) => r.source === '/ribbons');
    assert.ok(rw, '/ribbons rewrite must exist so the canonical URL serves /html/ribbons.html');
    assert.equal(rw.destination, '/html/ribbons');
});
