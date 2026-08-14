#!/usr/bin/env node
/**
 * probe-edge-cache.mjs
 * ====================
 * Measures whether the public API is actually being edge-cached, with GETs.
 *
 * WHY THIS EXISTS (ERR-159)
 * -------------------------
 * On 2026-08-09 we told the backend that the catalog API was not being
 * edge-cached at all, and quoted this as evidence:
 *
 *     curl -sI https://api.inkcartridges.co.nz/api/products?page=1&limit=20
 *     → cache-control: private, no-store, no-cache, must-revalidate, …
 *     → cf-cache-status: DYNAMIC
 *
 * The header was real. The conclusion was wrong. `curl -I` sends **HEAD**, and
 * the origin's cache-header middleware only marked GET as cacheable — every
 * other method got the hard `private, no-store` treatment. We had measured a
 * method no visitor uses. Real GETs were returning
 * `public, max-age=0, s-maxage=300, stale-while-revalidate=600` and going
 * MISS → HIT the whole time.
 *
 * The root cause of the WRONG REPORT, though, is not the flag. It is that the
 * probe was typed by hand into a document, run once, and never committed —
 * so it could not be re-run, reviewed, or regression-checked. There was no
 * cache probe anywhere in this repo. That is what this file fixes.
 *
 * THIS SCRIPT NEVER ISSUES A HEAD REQUEST. Not as an option, not behind a
 * flag. A HEAD response tells you what HEAD gets, and the only question worth
 * asking is what a visitor's GET gets. `assertNoHeadRequests()` below is a
 * real guard, not a comment.
 *
 * NOT under inkcartridges/. `vercel.json` sets `outputDirectory: "."` with the
 * Vercel project root at `inkcartridges/`, so everything in that tree is served
 * publicly. Audit tooling belongs in this directory.
 *
 * WHAT IT CHECKS
 * --------------
 * Each endpoint is fetched TWICE. A cacheable endpoint should MISS then HIT.
 * Two independent assertions, because they fail for different reasons:
 *
 *   1. HEADER  — does the origin mark this response cacheable at all?
 *                Failing this is an origin/middleware problem.
 *   2. EDGE    — does Cloudflare actually store it (`cf-cache-status` reaching
 *                HIT on the second request)? Failing this while (1) passes
 *                means the Cache Rule does not match the path — which is
 *                exactly the state /api/search/smart and /api/site/nav are in.
 *
 * Splitting them is the point. A single pass/fail would have reported
 * /api/search/smart as "not cached" and sent the backend hunting through
 * middleware that is already correct.
 *
 * Endpoints known to be uncached are listed too, with `expect: 'uncached'`, so
 * the report is a complete picture rather than a list of things that pass. They
 * do not fail the run — they are backend-owned (BF-014/BF-019) and tracked in
 * .claude/memory/backend-fixes.md. They DO fail if they start being cached
 * without us noticing, because that is a change worth seeing.
 *
 * USAGE
 * -----
 *   npm run audit:edge-cache
 *   npm run audit:edge-cache -- --json     machine-readable, for a handoff doc
 *   npm run audit:edge-cache -- --markdown a table to paste into a backend brief
 *   API_BASE=https://... npm run audit:edge-cache
 *
 * EXIT CODES
 *   0  every endpoint matched its expectation
 *   1  a regression: something expected-cached is not cached, or vice versa
 *   2  the probe could not run (network, DNS, all requests failed)
 */

'use strict';

const API_BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const JSON_OUT = process.argv.includes('--json');
const MARKDOWN = process.argv.includes('--markdown');
const QUIET = JSON_OUT || MARKDOWN;

/** Pause between the two requests, so the edge has a moment to store the first. */
const SETTLE_MS = 600;
/** A cold POP can MISS twice in a row; give a cacheable endpoint one more go. */
const HIT_RETRIES = 2;

const say = (...a) => { if (!QUIET) console.log(...a); };

// ──────────────────────────────────────────────────────────────────────────
// What we probe
// ──────────────────────────────────────────────────────────────────────────
//
// `expect`:
//   'cached'   — must send a cacheable header AND reach HIT at the edge
//   'uncached' — currently neither; recorded so the report is complete, and
//                asserted so a silent change in either direction is visible
//   'header-only' — origin marks it cacheable but the CDN does not store it.
//                This is a REAL, measured state (Cache Rule gap), not a
//                placeholder. Recorded as its own expectation so it can't be
//                confused with either of the other two.
const ENDPOINTS = [
    { path: '/api/products?page=1&limit=20', expect: 'cached',
      note: 'the catalog walk that carries quantity_breaks — the volume ladder rides this' },
    { path: '/api/brands', expect: 'cached',
      note: 'taxonomy' },
    { path: '/api/products?page=1&limit=1', expect: 'cached',
      note: 'second catalog shape, proves param order is part of the key' },

    { path: '/api/search/smart?q=LC133&limit=3', expect: 'header-only',
      note: 'BF-039 — cacheable header, Cache Rule does not match /api/search/*' },
    { path: '/api/site/nav', expect: 'header-only',
      note: 'BF-040 — public, max-age=3600 but still DYNAMIC' },

    { path: '/api/ribbons', expect: 'uncached',
      note: 'BF-019, re-verified with real GETs 2026-08-12 — genuinely no-store' },
    { path: '/api/printers/trending?limit=5', expect: 'uncached',
      note: 'BF-019 — search.js fetches this on every page load' },
    { path: '/api/settings', expect: 'uncached',
      note: 'BF-014' },
    { path: '/api/schema/site', expect: 'uncached',
      note: 'BF-014 — feeds JSON-LD; FE caches it 5 min in memory' },
];

// ──────────────────────────────────────────────────────────────────────────
// Probe
// ──────────────────────────────────────────────────────────────────────────

/**
 * The guard the whole file exists for.
 *
 * Kept as an executable check rather than a convention: a future edit adding
 * `method: 'HEAD'` to make the probe "cheaper" would silently reproduce the
 * exact misreport this script was written to prevent, and it would look like
 * an optimisation in review.
 */
function assertNoHeadRequests(init) {
    const method = (init && init.method ? String(init.method) : 'GET').toUpperCase();
    if (method !== 'GET') {
        throw new Error(
            `probe-edge-cache issues GET only; refused ${method}. ` +
            'A HEAD response describes what HEAD gets, not what a visitor gets — ' +
            'that misread is ERR-159 and this guard exists to stop it recurring.'
        );
    }
}

/** `cf-cache-status` values that mean "the edge served this without the origin". */
const HIT_STATUSES = new Set(['HIT', 'REVALIDATED', 'UPDATING', 'STALE']);

function isCacheableHeader(cacheControl) {
    if (!cacheControl) return false;
    const cc = cacheControl.toLowerCase();
    if (cc.includes('no-store') || cc.includes('private')) return false;
    return cc.includes('public') || cc.includes('s-maxage') || cc.includes('max-age');
}

async function probeOnce(url) {
    const init = { method: 'GET', redirect: 'follow' };
    assertNoHeadRequests(init);
    const res = await fetch(url, init);
    // Drain the body. An undrained response can keep the socket open and, more
    // to the point, a visitor's GET downloads the body — so should ours, or we
    // are timing something the visitor never does.
    await res.arrayBuffer();
    return {
        status: res.status,
        cacheControl: res.headers.get('cache-control'),
        cfStatus: res.headers.get('cf-cache-status'),
        age: res.headers.get('age'),
        vary: res.headers.get('vary'),
    };
}

async function probe(endpoint) {
    const url = `${API_BASE}${endpoint.path}`;
    const first = await probeOnce(url);

    let last = first;
    let attempts = 1;
    for (let i = 0; i < HIT_RETRIES; i++) {
        if (HIT_STATUSES.has(String(last.cfStatus || '').toUpperCase())) break;
        await new Promise(r => setTimeout(r, SETTLE_MS));
        last = await probeOnce(url);
        attempts++;
    }

    const headerCacheable = isCacheableHeader(first.cacheControl);
    const edgeCached = HIT_STATUSES.has(String(last.cfStatus || '').toUpperCase());

    const actual = !headerCacheable ? 'uncached'
        : (edgeCached ? 'cached' : 'header-only');

    return {
        path: endpoint.path,
        note: endpoint.note,
        expect: endpoint.expect,
        actual,
        ok: actual === endpoint.expect,
        httpStatus: first.status,
        cacheControl: first.cacheControl,
        cfFirst: first.cfStatus,
        cfLast: last.cfStatus,
        age: last.age,
        attempts,
        headerCacheable,
        edgeCached,
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

const VERDICT = {
    cached:        'edge-cached',
    'header-only': 'HEADER ONLY (Cache Rule gap)',
    uncached:      'not cacheable',
};

function markdownTable(rows) {
    const out = [
        `Measured ${new Date().toISOString()} against ${API_BASE}, real GETs, unauthenticated.`,
        '',
        '| Endpoint | `cache-control` | cf-cache-status | Verdict |',
        '|---|---|---|---|',
    ];
    for (const r of rows) {
        const cf = r.cfFirst === r.cfLast ? r.cfFirst : `${r.cfFirst} → ${r.cfLast}`;
        out.push(`| \`${r.path}\` | \`${r.cacheControl || '(none)'}\` | ${cf} | ${VERDICT[r.actual]} |`);
    }
    return out.join('\n');
}

async function main() {
    say(`\n  edge-cache probe · ${API_BASE}`);
    say('  GET only — never HEAD (ERR-159)\n');

    const rows = [];
    let transportFailures = 0;
    for (const endpoint of ENDPOINTS) {
        try {
            rows.push(await probe(endpoint));
        } catch (err) {
            transportFailures++;
            rows.push({
                path: endpoint.path, note: endpoint.note, expect: endpoint.expect,
                actual: 'error', ok: false, error: String(err && err.message || err),
            });
        }
    }

    if (transportFailures === ENDPOINTS.length) {
        console.error('\n  every request failed — the probe could not run (network/DNS?)\n');
        process.exit(2);
    }

    if (JSON_OUT) {
        console.log(JSON.stringify({
            probed_at: new Date().toISOString(), api_base: API_BASE,
            method: 'GET', results: rows,
        }, null, 2));
    } else if (MARKDOWN) {
        console.log(markdownTable(rows));
    } else {
        const w = Math.max(...rows.map(r => r.path.length));
        for (const r of rows) {
            const mark = r.ok ? ' ok ' : 'FAIL';
            const cf = r.cfFirst === r.cfLast ? String(r.cfFirst) : `${r.cfFirst}→${r.cfLast}`;
            say(`  ${mark}  ${r.path.padEnd(w)}  ${String(cf).padEnd(14)}  ${VERDICT[r.actual] || r.actual}`);
            if (!r.ok) {
                say(`        expected ${VERDICT[r.expect] || r.expect}`);
                if (r.error) say(`        error: ${r.error}`);
                else say(`        cache-control: ${r.cacheControl || '(none)'}`);
            }
        }
        say('');
        for (const r of rows) {
            if (r.actual === 'header-only') {
                say(`  note  ${r.path}`);
                say(`        origin says cacheable, edge is not storing it — ${r.note}`);
            }
        }
    }

    const failures = rows.filter(r => !r.ok);
    if (failures.length) {
        console.error(`\n  ${failures.length} endpoint(s) did not match expectation — see above.`);
        console.error('  A change in EITHER direction is a finding: update ENDPOINTS here and');
        console.error('  .claude/memory/backend-fixes.md in the same commit, so the record and');
        console.error('  the probe cannot disagree.\n');
        process.exit(1);
    }
    say('  all endpoints matched expectation\n');
}

main().catch(err => {
    console.error('probe-edge-cache failed:', err);
    process.exit(2);
});
