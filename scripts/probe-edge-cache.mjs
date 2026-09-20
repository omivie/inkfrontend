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

/**
 * THE ORIGIN HEADER IS PART OF THE CACHE KEY, AND THIS PROBE USED TO OMIT IT.
 * (ERR-273)
 *
 * Every response from this API carries `vary: Origin, Accept-Encoding`. A
 * visitor's `fetch()` runs on https://www.inkcartridges.co.nz, so the browser
 * sends `Origin: https://www.inkcartridges.co.nz` on every cross-origin GET and
 * fills the entry keyed to it. This probe sent no Origin at all, so for its whole
 * life it measured a DIFFERENT edge entry than the one the site uses.
 *
 * ***THIS IS ERR-159 WITH THE AXIS CHANGED.*** That was "we measured a METHOD no
 * visitor uses" (HEAD). This is "we measured an ORIGIN no visitor uses", found the
 * same way — by reading the response headers instead of the verdict. The verdict
 * happened to agree, which is exactly why it went unnoticed for seven weeks: both
 * keys are cacheable, so cached-vs-not read the same and the probe was right by
 * coincidence rather than by measurement.
 *
 * The apex 307s to www and the home page's canonical is www, so www is the origin
 * essentially every real request carries.
 */
const SITE_ORIGIN = process.env.PROBE_ORIGIN || 'https://www.inkcartridges.co.nz';

/**
 * A cookie shaped like a signed-in Supabase session. Sent to ONE endpoint, as a
 * negative control (see the `bypass` rows below). It is not a real token and
 * authenticates nothing — the origin's cache middleware keys off the cookie's
 * PRESENCE, which is the whole point: a signed-in response must never be stored
 * at the edge, and that must be provable without a real session.
 */
const FAKE_SESSION_COOKIE = 'sb-access-token=probe-not-a-real-token';
const JSON_OUT = process.argv.includes('--json');
const MARKDOWN = process.argv.includes('--markdown');
const QUIET = JSON_OUT || MARKDOWN;

/** Pause between the two requests, so the edge has a moment to store the first. */
import { printSearchAnalyticsNotice, probeQuery } from './lib/probe-search-notice.mjs';

const SETTLE_MS = 600;
/** A cold POP can MISS twice in a row; give a cacheable endpoint one more go. */
// Raised from 2 to 5 on 2026-09-12 (ERR-253). A colo fills per EDGE NODE, not
// per colo, so consecutive requests can land on different nodes and each one
// misses until it has filled: measured on a fresh query in AKL,
// MISS → HIT → MISS → HIT, with `age: 0` on both hits. Two attempts therefore
// report a genuinely-cached endpoint as header-only roughly half the time, and
// a probe that cries wolf on a coin flip is a probe people stop running.
// `attempts` is printed, so the cost of the raise stays visible.
const HIT_RETRIES = 5;

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

    // ✅ BF-039 CLOSED 2026-09-10. The origin had been asking the edge to cache
    // search for five minutes all along; the Cache Rule listed
    // /api/search/popular where it should have said /api/search/ — a
    // seven-character edit, no code. Measured here on a cold query:
    // MISS 3.39s then HIT 0.057s. This row FLIPPED from header-only to cached,
    // which is exactly the change this probe exists to notice, and it noticed
    // it before anyone told us.
    // SYNTHETIC TERMS, not real SKUs (ERR-254). This probe asks whether a URL is
    // STORED, which does not depend on whether the query matched anything — so it
    // can afford a `zzprobe_` term, and a term that costs the backend a row in
    // its live top-search-terms list to answer a question that did not need one
    // is pollution we chose. The two rows below used to be `LC133` and `lc73xl`.
    // 🚨 BF-039 HAS REGRESSED — REOPENED 2026-09-20 BY THIS PROBE.
    //
    // These two rows read `cached` from 2026-09-10, when the Cache Rule gained a
    // /api/search/ clause and search went MISS 3.39s -> HIT 0.057s. Measured today,
    // the WHOLE family is DYNAMIC: /search/smart, /search/suggest, /search/popular
    // and /search/by-part, twice each, with /api/site/nav, /api/ribbons,
    // /api/printers/trending and /api/brands all HITting in the same run as
    // positive controls. The origin still sends
    // `public, max-age=0, s-maxage=300, stale-while-revalidate=600`, and DYNAMIC
    // means Cloudflare never considered the path — so this is the RULE, not the
    // origin, and not this probe's new Origin header (DYNAMIC with and without it).
    //
    // ***THE SUSPECT IS THE FIX DIRECTLY ABOVE.*** The 2026-09-17 edit that added
    // /api/ribbons, /api/printers and /api/site to close BF-014/BF-019 appears to
    // have dropped /api/search/ from the same expression. Three endpoints gained
    // caching and two lost it in one change, and the backend's own write-up
    // re-verified only the three it was adding. A Cache Rule is a single expression
    // with no per-clause test, which is exactly the shape that loses a clause
    // silently.
    //
    // Kept as `header-only` rather than deleted or left expecting 'cached': that is
    // the REAL measured state, it is what this probe splits out precisely so an
    // origin that is right cannot be blamed for a rule that is wrong, and leaving
    // the expectation at 'cached' would make every future run red for a reason
    // already known. Carried as an ask in the outbox reply.
    { path: `/api/search/smart?q=${encodeURIComponent(probeQuery('edgecache'))}&limit=3`, expect: 'header-only',
      note: 'BF-039 REOPENED 2026-09-20 — origin cacheable, edge says DYNAMIC. Whole '
          + '/api/search/* family, measured with /api/brands + /api/site/nav HITting as controls' },
    // Its sibling, added the same day. The two search endpoints are separately
    // reachable and separately cacheable, so one row cannot speak for both —
    // and /suggest is the one the typeahead hits hardest.
    { path: `/api/search/suggest?q=${encodeURIComponent(probeQuery('edgecache'))}&limit=5`, expect: 'header-only',
      note: 'BF-039 REOPENED 2026-09-20 — same as /smart. This is the endpoint the typeahead '
          + 'hits hardest, so the regression costs one origin read per keystroke-settle' },
    // ✅ BF-014 (/api/site/*) and BF-019 CLOSED 2026-09-17. The Cache Rule
    // expression gained /api/site, /api/ribbons and /api/printers, keeping "use
    // cache-control header if present" as the edge TTL — which matters, because a
    // FIXED edge TTL would be wrong for one of these groups either way
    // (/api/site/* wants 3600s, the other two 300s) and would outlive the purge
    // that fires on an admin price edit.
    //
    // ⚠️ ALL THREE OF THESE ROWS SAID `header-only` UNTIL 2026-09-20, AND ONE OF
    // THEM WAS THIS PROBE'S ONLY NEGATIVE CONTROL. The /api/site/nav row used to
    // carry the note "it is the negative control for the two search rows: if this
    // ever reads cached at the same time they do, the probe has stopped
    // discriminating." That is precisely what happened — the backend fixed it. The
    // control did not fail, it SUCCEEDED and then evaporated, which is the more
    // dangerous outcome: flipping the row to `cached` and stopping there would
    // leave a run where every single expectation is "cached", and a probe whose
    // every row expects the same answer cannot tell you the answer was measured.
    // The `bypass` and `uncached` rows at the bottom are the replacement, and they
    // are red-proofed rather than asserted (ERR-273).
    //
    // /api/site/nav was ALSO broken at the origin, in a way worth remembering: the
    // route set `public, max-age=3600` with res.set(), which replaced the
    // middleware's Cache-Control but left its `Pragma: no-cache` and `Expires: 0`
    // behind — a response claiming to be public while carrying two do-not-cache
    // headers. Verified gone 2026-09-20: neither header is present.
    { path: '/api/site/nav', expect: 'cached',
      note: 'BF-014 closed 2026-09-17 — public, max-age=300, s-maxage=3600, swr=86400. '
          + 'Read by api.js:2754 (getWithSWR, anonymous) and the mega-nav' },
    // Shipped in the same change and nothing was watching it. A sibling that is
    // fixed by the same rule but absent from the probe is a row that can regress
    // silently, which is the whole argument for listing it.
    { path: '/api/site/trust', expect: 'cached',
      note: 'BF-014 closed 2026-09-17 — same headers as /site/nav; added here because the '
          + 'rule covers /api/site/* and one path cannot speak for the prefix' },
    { path: '/api/ribbons', expect: 'cached',
      note: 'BF-019 closed 2026-09-17 — public, max-age=0, s-maxage=300, swr=600. The origin '
          + 'half had already landed by 2026-09-12 (it used to answer private, no-store); this '
          + 'is the Cache Rule half arriving' },
    { path: '/api/printers/trending?limit=5', expect: 'cached',
      note: 'BF-019 closed 2026-09-17 — search.js:107 fetches this on EVERY page load with '
          + "credentials:'omit', so the gap was costing one origin hit per page view. NB this "
          + 'response carries TWO vary headers (Origin, Accept-Encoding AND Accept-Encoding), '
          + 'i.e. two middlewares both set it — harmless, reported not fixed' },

    { path: '/api/settings', expect: 'uncached',
      note: 'BF-014' },
    { path: '/api/schema/site', expect: 'uncached',
      note: 'BF-014 — feeds JSON-LD; FE caches it 5 min in memory' },

    // ── THE NEGATIVE CONTROLS ───────────────────────────────────────────────
    //
    // Three of them, because after 2026-09-17 there is no legitimately
    // `header-only` endpoint left and every other row above expects 'cached'. A
    // run in which every expectation is the same answer proves nothing about the
    // instrument. These rows are the reason a green run means something, so they
    // are red-proofed by hand: point each at a known-cacheable path and confirm
    // the run goes red BEFORE trusting it.
    //
    // 1. A SESSION MUST NEVER BE STORED. This is also the privacy guard. If a
    //    cookie-bearing response ever became cacheable, the edge would serve one
    //    signed-in visitor's body to the next person — which is the mechanism
    //    behind ERR-234/246, where the edge served an authed request the anon
    //    body. The cookie is fake on purpose: the middleware keys off PRESENCE,
    //    so this is provable without a real token.
    //    ⚠️ THIS ROW MUST USE A COLD KEY, AND FINDING OUT WHY IS THE POINT.
    //    Written first without the cache-buster, it came back HIT, and the
    //    obvious reading — "a signed-in response is being cached" — was wrong.
    //    Measured both ways 2026-09-20:
    //
    //      cookie + COLD key  -> private, no-store + BYPASS   (origin refuses)
    //      cookie + WARM key  -> HIT, with the ANON body      (edge does not care)
    //
    //    Those are two different guarantees and only the first one holds. The
    //    origin never lets a session response into the cache; the edge will
    //    happily serve an already-stored anonymous entry to a cookie-bearing
    //    request. For /api/ribbons that is harmless — the anon body IS the public
    //    body — but it is the ERR-234/246 mechanism verbatim, and it is the reason
    //    every catalogue read in api.js declares `anonymous: true` and sends
    //    `credentials: 'omit'`: a personalised body must never be requested from a
    //    shared key in the first place.
    //
    //    So this row asserts the guarantee that actually exists. `_cb` is ignored
    //    by the backend and costs exactly one origin read per run.
    { path: `/api/ribbons?_cb=${Date.now()}`, label: '/api/ribbons  [+ sb-* cookie, COLD key]',
      expect: 'bypass', cookie: FAKE_SESSION_COOKIE,
      note: 'the same path as the cached row above — the only differences are the cookie and a '
          + 'cold key. A WARM key returns HIT with the anon body, which is a separate and '
          + 'weaker guarantee (see the comment above); do not "fix" this row by dropping _cb' },

    // 2. A FOREIGN ORIGIN MUST NOT BE SERVED FROM OUR ENTRY. Measured
    //    2026-09-20: an Origin outside the allowlist answers `private, no-store`
    //    + BYPASS, so the CORS layer and the cache layer agree. This is the row
    //    that proves `vary: Origin` is load-bearing rather than decorative, and
    //    therefore that sending the real Origin above was not superstition.
    { path: '/api/site/trust', label: '/api/site/trust  [+ foreign Origin]',
      expect: 'bypass', origin: 'https://example.invalid',
      note: 'an Origin off the allowlist must not reach our cached entry' },

    // 3. ADMIN IS NEVER ELIGIBLE. /api/admin/* is served private, no-store and
    //    reads DYNAMIC even on a 401, so it exercises the "the edge never
    //    considered this cacheable" path that no other row does.
    { path: '/api/admin/analytics/search', expect: 'uncached',
      note: 'DYNAMIC on a 401 — admin responses are never edge-eligible. Note the cost of this '
          + 'being correct: a granted admin is the only visitor who cannot ride an origin wobble '
          + 'out on a cached body (ERR-266/BF-066)' },

    // 4. THE OMITTED-ORIGIN CONTROL. This is the same catalog path as the first
    //    row, fetched with NO Origin header — the way this probe fetched
    //    EVERYTHING until 2026-09-20. It is kept as a visible row rather than
    //    deleted, because the finding is not "we added a header", it is "the key
    //    we were measuring was not the key visitors fill". If this row and the
    //    first row ever disagree, the Origin is doing something new and the note
    //    above needs re-reading.
    { path: '/api/products?page=1&limit=20', label: '/api/products  [NO Origin header]',
      expect: 'cached', noOrigin: true,
      note: 'ERR-273 — the key this probe used to measure. Cacheable too, which is exactly why '
          + 'omitting the Origin never showed up as a wrong verdict' },
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

async function probeOnce(url, endpoint) {
    // The default is the browser's Origin, because the browser's entry is the one
    // worth knowing about (ERR-273). `noOrigin: true` opts a row out, and exactly
    // one row does, deliberately, as the control that keeps this visible.
    const headers = {};
    if (!(endpoint && endpoint.noOrigin)) headers.Origin = SITE_ORIGIN;
    if (endpoint && endpoint.origin) headers.Origin = endpoint.origin;
    if (endpoint && endpoint.cookie) headers.Cookie = endpoint.cookie;

    const init = { method: 'GET', redirect: 'follow', headers };
    assertNoHeadRequests(init);
    const res = await fetch(url, init);
    // Drain the body. An undrained response can keep the socket open and, more
    // to the point, a visitor's GET downloads the body — so should ours, or we
    // are timing something the visitor never does. Kept as TEXT, because the
    // leak scan below needs it and re-fetching to look would be a second
    // request against a different cache state.
    const body = await res.text();
    return {
        status: res.status,
        cacheControl: res.headers.get('cache-control'),
        cfStatus: res.headers.get('cf-cache-status'),
        age: res.headers.get('age'),
        // getSetCookie-style duplicates matter here: two middlewares both setting
        // Vary is a real observation, and `get()` joins them with ', '.
        vary: res.headers.get('vary'),
        body,
        sentOrigin: headers.Origin || null,
    };
}

/**
 * Fields that must never appear in a body the edge is allowed to store.
 *
 * `cost_price` was readable with the PUBLIC key until Aug 2026 (ERR-170) and
 * `admin_only` gates a product the storefront must not show (ERR-234/246). The
 * backend states that no cached body carries them. Stating it is free; this costs
 * one substring scan on a body we already downloaded, and a leak here is worse
 * than a cache miss because the edge would then serve it to everyone.
 */
const MUST_NOT_BE_CACHED = ['cost_price', 'manual_retail_price', 'admin_only'];

function leakedFields(body) {
    if (!body) return [];
    return MUST_NOT_BE_CACHED.filter(f => body.includes(`"${f}"`));
}

async function probe(endpoint) {
    const url = `${API_BASE}${endpoint.path}`;
    const first = await probeOnce(url, endpoint);

    let last = first;
    let attempts = 1;
    // A row we EXPECT to bypass must not be retried into looking like a miss —
    // BYPASS is terminal by design, and five retries would just be five more
    // origin reads. Same for an expected-uncached row.
    const chasingAHit = endpoint.expect === 'cached';
    for (let i = 0; chasingAHit && i < HIT_RETRIES; i++) {
        if (HIT_STATUSES.has(String(last.cfStatus || '').toUpperCase())) break;
        await new Promise(r => setTimeout(r, SETTLE_MS));
        last = await probeOnce(url, endpoint);
        attempts++;
    }

    const cf = String(last.cfStatus || '').toUpperCase();
    const headerCacheable = isCacheableHeader(first.cacheControl);
    const edgeCached = HIT_STATUSES.has(cf);

    // BYPASS is its own answer and must not be folded into 'uncached'. They are
    // different facts: 'uncached' means the origin never offered this response to
    // the cache, 'bypass' means the edge was OFFERED something and refused it
    // because the request carried a session. Collapsing them would let a
    // privacy regression (a signed-in body becoming cacheable) read as a
    // routine expectation change.
    const bypassed = cf === 'BYPASS' || String(first.cfStatus || '').toUpperCase() === 'BYPASS';

    const actual = bypassed ? 'bypass'
        : (!headerCacheable ? 'uncached'
        : (edgeCached ? 'cached' : 'header-only'));

    const leaked = actual === 'cached' ? leakedFields(first.body) : [];

    return {
        path: endpoint.path,
        label: endpoint.label || endpoint.path,
        note: endpoint.note,
        expect: endpoint.expect,
        actual,
        ok: actual === endpoint.expect && leaked.length === 0,
        leaked,
        httpStatus: first.status,
        cacheControl: first.cacheControl,
        cfFirst: first.cfStatus,
        cfLast: last.cfStatus,
        age: last.age,
        vary: first.vary,
        sentOrigin: first.sentOrigin,
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
    bypass:        'BYPASS (session present — correctly not stored)',
};

function markdownTable(rows) {
    const out = [
        `Measured ${new Date().toISOString()} against ${API_BASE}, real GETs, unauthenticated,`,
        `\`Origin: ${SITE_ORIGIN}\` unless the row says otherwise (responses \`vary: Origin\`).`,
        '',
        '| Endpoint | `cache-control` | cf-cache-status | Verdict |',
        '|---|---|---|---|',
    ];
    for (const r of rows) {
        const cf = r.cfFirst === r.cfLast ? r.cfFirst : `${r.cfFirst} → ${r.cfLast}`;
        out.push(`| \`${r.label || r.path}\` | \`${r.cacheControl || '(none)'}\` | ${cf} | ${VERDICT[r.actual]} |`);
    }
    return out.join('\n');
}

async function main() {
    say(`\n  edge-cache probe · ${API_BASE}`);
    say('  GET only — never HEAD (ERR-159)');
    // Printed, not assumed. `vary: Origin` is in every response, so the Origin IS
    // part of what was measured, and a reader who does not know which one was sent
    // does not know which cache entry the table below describes (ERR-273).
    say(`  Origin: ${SITE_ORIGIN}  — part of the cache key (vary: Origin)\n`);
    // THIS PROBE IS A WRITER (ERR-254). Two of the rows below are
    // /api/search/ URLs, and every GET to those makes the backend write a
    // `search_analytics` row. 'GET only' is a statement about OUR side.
    printSearchAnalyticsNotice();

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
        const w = Math.max(...rows.map(r => (r.label || r.path).length));
        for (const r of rows) {
            const mark = r.ok ? ' ok ' : 'FAIL';
            const cf = r.cfFirst === r.cfLast ? String(r.cfFirst) : `${r.cfFirst}→${r.cfLast}`;
            say(`  ${mark}  ${(r.label || r.path).padEnd(w)}  ${String(cf).padEnd(14)}  ${VERDICT[r.actual] || r.actual}`);
            if (r.leaked && r.leaked.length) {
                say(`        🚨 the CACHED body carries ${r.leaked.join(', ')} — the edge will serve`);
                say('        this to every visitor. See ERR-170 (cost_price was public) and');
                say('        ERR-234/246 (the edge served an authed request the anon body).');
            }
            if (!r.ok) {
                say(`        expected ${VERDICT[r.expect] || r.expect}`);
                if (r.error) say(`        error: ${r.error}`);
                else say(`        cache-control: ${r.cacheControl || '(none)'}`);
            }
        }
        say('');
        for (const r of rows) {
            if (r.actual === 'header-only') {
                say(`  note  ${r.label || r.path}`);
                say(`        origin says cacheable, edge is not storing it — ${r.note}`);
            }
        }
        // As of 2026-09-17 no row is EXPECTED to be header-only. That state is
        // still detected and still printed above, because it is the one the
        // Cache Rule regresses into — but its absence is now the normal case, so
        // say so rather than leaving a silent section a reader reads as "nothing
        // to report".
        if (!rows.some(r => r.actual === 'header-only')) {
            say('  note  no endpoint is in the header-only state (Cache Rule gap) — the state');
            say('        BF-014/BF-019 sat in for two months. This is what fixed looks like.');
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
