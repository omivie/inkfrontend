#!/usr/bin/env node
/**
 * probe-data-capture.mjs — is the Aug-2026 data-tracking capture actually reachable?
 * =================================================================================
 *
 * The backend shipped migrations 153–155 and handed over
 * `data-tracking-capture-fe-handoff-aug2026.md`. Four of its claims cannot be
 * checked by reading code, and two of them are wrong in a way that would have
 * broken the site. This probe re-measures all of them on demand, so none of it
 * has to be remembered:
 *
 *   §1  CORS. `X-Session-Id`/`X-Visitor-Id` are NOT on the allow-list, and PATCH
 *       is not an allowed method. The first would have taken site search down
 *       (a browser fails the preflight and never sends the request); the second
 *       is BF-021, and it makes the new quick-order outcome endpoint unreachable.
 *   §2  Edge cache. This section used to assert cf-cache-status: DYNAMIC on the
 *       two search endpoints, as a tripwire: while search was uncached the
 *       ?sid=/?vid= params cost nothing, and the day it became cached they
 *       would shatter the shared entry one visitor at a time. THE TRIPWIRE
 *       FIRED — BF-039 closed 2026-09-10 and this probe went red before any
 *       hand-off reached us. The params came off the two search helpers the
 *       same day (ERR-253), and the section now guards the state that replaced
 *       it, in both directions: the endpoints must really be cached, and our
 *       own code must really keep the URL clean. This
 *       section FAILS the moment DYNAMIC stops being true, which is the point.
 *   §3  Are the params honoured, or a decoy? Measured honestly: they are
 *       INDISTINGUISHABLE from a decoy from outside (ERR-151), and this says so
 *       rather than reporting a green tick it has not earned.
 *   §4  The conversion funnel's real shape — including that `window_days` is a
 *       decoy, and that the funnel is currently non-monotonic.
 *   §5  The quick-order outcome route: live, validating, and unreachable.
 *   §6  `search/top-converting`'s `orders`/`conversion_pct` — the one number that
 *       proves §1.1 landed, once orders accumulate.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET or an OPTIONS, with ONE exception, stated on every run:
 * §5 issues a single deliberately-invalid PATCH — an all-zero UUID AND an
 * out-of-enum outcome — purely to read the validator's answer. It cannot match a
 * row and cannot write. There is no --record mode and this probe writes nothing,
 * anywhere. A probe that can record may be green because it just overwrote what
 * it compared against (sweep:b2b ate a committed fixture, 2026-08-12), so the
 * mode is printed every run and can never be assumed.
 *
 * Probes WARM and repeatedly: a single probe against a cold Render host is not a
 * measurement (it once returned `404 Endpoint not found` for routes the admin
 * demonstrably uses — see errors.md, ERR-188's "measurement trap").
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:data-capture        (admin sections need ADMIN_EMAIL /
 *                                            ADMIN_PASSWORD in .env)
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import { printSearchAnalyticsNotice } from './lib/probe-search-notice.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD = 'https://api.inkcartridges.co.nz';
const RENDER = 'https://ink-backend-zaeq.onrender.com';
const ORIGIN = 'https://inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** Cannot match a row on any route, whatever the rest of the body says. */
const UNMATCHABLE_UUID = '00000000-0000-4000-8000-000000000000';

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * A real limit worth reporting, but one the frontend already accommodates — so
 * it must NOT redden the exit code. If a soft note could fail the run, the run
 * gets ignored, and a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function readEnv() {
    try {
        const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
        return Object.fromEntries(raw.split('\n').filter((l) => l.includes('=')).map((l) => {
            const i = l.indexOf('=');
            return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }));
    } catch { return {}; }
}

/** Warm the host and retry once — a cold Render instance answers nonsense. */
async function req(url, init = {}, attempt = 0) {
    try {
        const res = await fetch(url, { ...init, headers: { Origin: ORIGIN, ...(init.headers || {}) } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, headers: res.headers, text, json };
    } catch (err) {
        if (attempt < 2) return req(url, init, attempt + 1);
        return { status: 0, headers: new Headers(), text: String(err && err.message), json: null };
    }
}

const preflight = (url, method, headers) => req(url, {
    method: 'OPTIONS',
    headers: {
        'Access-Control-Request-Method': method,
        ...(headers ? { 'Access-Control-Request-Headers': headers } : {}),
    },
});

console.log('\x1b[1mprobe-data-capture\x1b[0m — Aug 2026 data-tracking capture');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m GET/OPTIONS only, plus ONE deliberately-invalid');
console.log('PATCH in §5 (unmatchable UUID + out-of-enum value) to read the validator.');
console.log('No --record mode exists. This probe writes nothing.\n');

// warm both hosts before measuring anything
await Promise.all([req(`${PROD}/api/search/smart?q=warm&limit=1`), req(`${RENDER}/api/search/smart?q=warm&limit=1`)]);

// ── §1 CORS ────────────────────────────────────────────────────────────────
// THIS PROBE IS A WRITER (ERR-254). Every GET to /api/search/ has the backend
// write a `search_analytics` row, fire-and-forget, so the MODE: READ-ONLY
// banner above is true of this repo and false of their database. Said out
// loud rather than left to the reader.
printSearchAnalyticsNotice();

head('§1  CORS — can the browser send what the handoff asked for?');
{
    // BF-054 CLOSED 2026-09-08. This block used to assert the headers were NOT
    // allowed and softly note the day they were. That day came, the frontend
    // now DEPENDS on them (traffic-tracker.js USE_ID_HEADERS, api.js's
    // per-helper `identify: true`, search.js's typeahead), and a browser does
    // not degrade if they go away — it fails the preflight and takes site
    // search down. So this is a hard check now, in the opposite direction.
    for (const [label, base] of [['prod (api.inkcartridges.co.nz)', PROD], ['render origin', RENDER]]) {
        const pre = await preflight(`${base}/api/search/smart?q=x`, 'GET', 'x-session-id,x-visitor-id');
        const allowH = (pre.headers.get('access-control-allow-headers') || '').toLowerCase();
        const hasIds = allowH.includes('x-session-id') && allowH.includes('x-visitor-id');
        check(hasIds, `${label}: X-Session-Id / X-Visitor-Id ARE allowed (BF-054 closed)`,
            `allow-headers: ${allowH || '(none)'}\n`
            + '      ⇒ the frontend sends both on /api/search/smart and /suggest. Without them '
            + 'in this list the browser fails the preflight and NEVER SENDS THE SEARCH — this is '
            + 'not a lost analytics column, it is site search down. Revert '
            + 'traffic-tracker.js USE_ID_HEADERS to false immediately, then talk to the backend.');

        // NEGATIVE CONTROL — the reason the line above can be believed.
        // A preflight that answers 204 to everything proves nothing (ERR-223:
        // "a preflight 204s whatever you ask ⇒ curl can't adjudicate CORS"). If
        // a header nobody has ever heard of also comes back allowed, this
        // endpoint is echoing the request and the check above is worthless.
        const bogus = await preflight(`${base}/api/search/smart?q=x`, 'GET', 'x-totally-bogus-header');
        const bogusAllow = (bogus.headers.get('access-control-allow-headers') || '').toLowerCase();
        check(!bogusAllow.includes('x-totally-bogus-header'),
            `${label}: the allow-list is a real list, not an echo of the request`,
            `asking for x-totally-bogus-header returned it as allowed (${bogusAllow}). This `
            + 'endpoint echoes Access-Control-Request-Headers, so the assertion above measures '
            + 'nothing at all — the only way to know whether the id headers work is a real browser.');
    }
    // ── BF-021 LANDED 2026-09-10. THIS FLIPPED FROM A NOTE TO A HARD CHECK. ──
    //
    // It used to assert PATCH was ABSENT, and softly note it if it ever showed
    // up. That was right while nothing depended on it. Three live admin writes
    // depend on it now, and each is the ONLY verb its route answers:
    //
    //     PATCH /api/admin/quick-orders/:id/outcome
    //     PATCH /api/admin/invoices/:id/status
    //     PATCH /api/admin/business/accounts/:id
    //
    // A method missing from that list is one the BROWSER refuses to send: the
    // preflight still answers 204, every curl and server-side test passes, and
    // the real UI is dead. That is how BF-021 lasted from 2026-07-30 to
    // 2026-09-10 — six weeks — with nobody able to point at a failing request.
    // So losing it again must be a red probe, not a quiet one.
    //
    // Measured 2026-09-12: GET,POST,PUT,PATCH,DELETE,OPTIONS.
    const pre = await preflight(`${PROD}/api/admin/quick-orders/${UNMATCHABLE_UUID}/outcome`, 'PATCH');
    const allowM = (pre.headers.get('access-control-allow-methods') || '').toUpperCase();
    check(allowM.includes('PATCH'),
        `PATCH is an allowed method — BF-021 stays closed (allow-methods: ${allowM || '(none)'})`,
        'PATCH has DISAPPEARED from Access-Control-Allow-Methods. This is not a lost analytics '
        + 'column: the quick-order outcome modal, the invoice status toggle and the business '
        + 'account manage drawer all stop working in the browser, while curl and every '
        + 'server-side test keep passing. Three admin writes are dead until it is restored. '
        + `Got: ${allowM || '(none)'}`);

    // NEGATIVE CONTROL — the only reason to believe the line above.
    // A preflight that echoes whatever it is asked would "allow" PATCH no matter
    // what the server actually does (ERR-223: a preflight 204s whatever you ask,
    // so curl cannot adjudicate CORS on its own).
    const bogusPre = await preflight(`${PROD}/api/admin/quick-orders/${UNMATCHABLE_UUID}/outcome`, 'BOGUSVERB');
    const bogusAllowM = (bogusPre.headers.get('access-control-allow-methods') || '').toUpperCase();
    check(!bogusAllowM.includes('BOGUSVERB'),
        'the allow-methods list is a real static list, not an echo (BOGUSVERB not returned)',
        `asking for BOGUSVERB returned it as allowed (${bogusAllowM}). This endpoint echoes `
        + 'Access-Control-Request-Method, so the PATCH assertion above measures nothing at all.');
}

// ── §2 Edge cache ──────────────────────────────────────────────────────────
/**
 * Read a shipped source file with its comments removed.
 *
 * Comments removed because the files this checks deliberately EXPLAIN the
 * pattern they no longer use — api.js carries a tombstone naming the retired
 * identifySearch helper, search.js says why the params are gone. A ban that
 * also bans its own explanation is a ban nobody can document.
 *
 * This is the same scanner the test suite uses (tests/helpers/strip-comments.js)
 * rather than a second copy, because a replica of an escaper is how ERR-231's
 * probe came to certify something other than the shipped rule. Inlined as a
 * dynamic import so the probe still runs if tests/ is ever pruned from a
 * deployment checkout.
 */
const stripJsComments = (await import('../tests/helpers/strip-comments.js')).default;
const readJs = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', rel), 'utf8');
const codeOnly = (src) => stripJsComments(src);

head('§2  Edge cache — search IS cached now, so the URL must stay shared');
{
    // ── THIS SECTION USED TO ASSERT THE EXACT OPPOSITE, AND IT WAS RIGHT TO ──
    //
    // It asserted `cf-cache-status: DYNAMIC` on both search endpoints, with the
    // failure text "the endpoint is now served from the shared cache, so
    // sid/vid have become part of the cache key". That was a tripwire, not a
    // preference: while search was uncached the params cost nothing, and the
    // day it became cached they would start shattering the shared entry one
    // visitor at a time.
    //
    // The tripwire fired. BF-039 closed on 2026-09-10 and this probe went red
    // before any hand-off reached us. The params came off the two search
    // helpers the same day (ERR-253), so the section now guards the state that
    // replaced it — which takes TWO assertions, because either alone is
    // satisfiable by a mistake:
    //
    //   (a) the endpoints really are cached — else we removed a transport for
    //       a benefit that does not exist;
    //   (b) our own code really does keep the URL clean — else (a) is true and
    //       we are still paying full price for it.
    //
    // ***A CACHE THAT EXISTS AND A CACHE KEY WE SHARE ARE DIFFERENT CLAIMS.***
    for (const [label, url] of [
        ['/api/search/smart', `${PROD}/api/search/smart?q=brother%20lc3319&limit=2`],
        ['/api/search/suggest', `${PROD}/api/search/suggest?q=lc33&limit=3`],
    ]) {
        // A colo fills per edge node, so one request proves nothing either way:
        // measured MISS → HIT → MISS → HIT on a fresh query, `age: 0` on both
        // hits. Ask until it hits or we run out of patience.
        let cf = '';
        let hits = 0;
        for (let i = 0; i < 6; i++) {
            const r = await req(url);
            cf = (r.headers.get('cf-cache-status') || '').toUpperCase();
            if (cf === 'HIT' || cf === 'REVALIDATED' || cf === 'STALE' || cf === 'UPDATING') { hits++; break; }
            await new Promise((r2) => setTimeout(r2, 400));
        }
        check(hits > 0,
            `${label} IS edge-cached (reached cf-cache-status: ${cf})`,
            `${label} never reached a cache HIT in 6 attempts (last: ${cf || 'absent'}). Either `
            + 'the Cloudflare Cache Rule has stopped matching /api/search/ — in which case every '
            + 'search is back on a ~2.3s origin and is spending from a 30/min bucket — or the '
            + 'origin has stopped sending s-maxage. npm run audit:edge-cache splits those two.');
    }

    // (b) — and this half is a SOURCE check on purpose. The network cannot tell
    // you what your own code sends; only the code can. A browser run would be
    // better still, which is why probe:mobile-ux exists, but a grep here is the
    // cheap guard that catches a re-added param the day it lands.
    const SEARCH_ID_PARAM = /\/api\/search\/[a-z]+[^`'"\n]*[?&](sid|vid)=/;
    for (const rel of ['api.js', 'search.js', 'quote-page.js']) {
        const src = codeOnly(readJs(rel));
        check(!SEARCH_ID_PARAM.test(src) && !/identifySearch\(/.test(src),
            `${rel} puts no sid/vid in a /api/search/ URL`,
            `${rel} is building a /api/search/ URL that carries sid= or vid=, or is calling the `
            + 'retired identifySearch() helper. The URL is the edge cache key: a per-visitor '
            + 'param gives every visitor a private entry and hands back a measured 60x '
            + '(MISS 3.39s vs HIT 0.057s). Use { identify: true } — the header is not part of '
            + 'the key. POST /api/cart/items is the one place the param is still correct.');
    }

    // POSITIVE CONTROL for the check above. If `codeOnly` or the regex is
    // broken, the three assertions pass by accident — which is the family of
    // failure that let 22,251 characters of source go unexamined across this
    // repo's suites. So prove the matcher can still see a violation.
    check(SEARCH_ID_PARAM.test("fetch(`/api/search/smart?q=${q}&sid=abc`)"),
        'the sid-in-URL matcher can still detect a violation (positive control)',
        'the regex guarding the cache key no longer matches a known-bad URL, so the three '
        + 'assertions above cannot fail and mean nothing.');

    // And the cart POST must have KEPT its param — the scope control.
    check(/identifyUrl\('\/api\/cart\/items'\)/.test(codeOnly(readJs('api.js'))),
        'POST /api/cart/items still carries ?sid= — this change was scoped to search',
        'the cart POST has lost identifyUrl. It is not edge-cached and the param is the '
        + 'transport that measurably lands its rows; removing it as "unused" loses cart '
        + 'attribution entirely.');
}

// ── §3 Are the params honoured? ────────────────────────────────────────────
head('§3  ?sid= / ?vid= — accepted, and honestly reported');
{
    const plain = await req(`${PROD}/api/search/smart?q=lc3319&limit=2`);
    const withIds = await req(`${PROD}/api/search/smart?q=lc3319&limit=2&sid=ts_probe_readonly&vid=${UNMATCHABLE_UUID}`);
    check(withIds.status === 200, 'a search carrying the ids still returns 200',
        `got ${withIds.status} — the ids are being REJECTED and every search would break`);
    check(plain.text === withIds.text, 'the ids do not change the result set',
        'the response differs with the ids attached — they are influencing search output, which '
        + 'they must not');

    const malformed = await req(`${PROD}/api/search/smart?q=lc3319&limit=1&sid=bad%20id%21`);
    const decoy = await req(`${PROD}/api/search/smart?q=lc3319&limit=1&zzqxnope=bad%20id%21`);
    if (malformed.status === decoy.status) {
        soft('acceptance is NOT proof of capture',
            `a malformed sid and a nonsense param both answer ${malformed.status}, so from outside `
            + '?sid= is indistinguishable from a decoy (the ERR-151 shape). The handoff says a bad '
            + 'id is dropped rather than 400ing, which is consistent with this — but it means the '
            + 'only real acceptance signal is §6 going non-null. Do not read a green §3 as "the '
            + 'join key is working".');
    } else {
        ok(`a malformed sid is rejected (${malformed.status}) where a decoy param is not (${decoy.status}) — the param IS read`);
    }
}

// ── admin sections ─────────────────────────────────────────────────────────
const env = readEnv();
let token = null;
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    const r = await req(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    });
    token = r.json?.access_token || null;
}
const authed = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : null;

if (!authed) {
    head('§4–§6  admin sections');
    soft('skipped — no admin session',
        'set ADMIN_EMAIL / ADMIN_PASSWORD in .env to measure the funnel, the quick-order outcome '
        + 'route and search attribution. A SKIP IS NOT A PASS: these sections were not run.');
} else {
    // ── §4 Conversion funnel ────────────────────────────────────────────────
    head('§4  Conversion funnel — shape, decoys and monotonicity');
    const base = await req(`${PROD}/api/admin/analytics/conversion-funnel`, { headers: authed });
    const d = base.json?.data || null;
    if (!d) {
        bad('conversion-funnel did not return a payload', `status ${base.status}: ${base.text.slice(0, 160)}`);
    } else {
        check(d.meta && typeof d.meta === 'object', 'meta is present', 'meta missing');
        console.log(`      meta: window_days=${d.meta?.window_days} product_viewers=${d.meta?.product_viewers} sessions=${d.meta?.sessions}`);
        console.log(`      overall_conversion_rate: ${JSON.stringify(d.overall_conversion_rate)}`);

        if (d.meta?.data_gap === true) {
            soft('meta.data_gap is true', 'migration 155 is not in place; the card renders the gap, not a number');
        } else {
            ok('no data_gap — the funnel is a real aggregate, not the old (sessions × 10) estimate');
        }

        // window_days is a decoy: prove it rather than trusting it.
        const w7 = await req(`${PROD}/api/admin/analytics/conversion-funnel?window_days=7`, { headers: authed });
        const w999 = await req(`${PROD}/api/admin/analytics/conversion-funnel?window_days=999`, { headers: authed });
        if (w7.text === base.text && w999.text === base.text) {
            soft('window_days is a DECOY — accepted and ignored',
                `7, 999 and no param all return the identical payload (meta.window_days stays `
                + `${d.meta?.window_days}). The dashboard card must label itself from the ECHO and `
                + 'say it does not follow the page date filter — which it does.');
        } else {
            ok('window_days is honoured — the card could now follow the page filter');
        }

        // A funnel is monotonic by construction.
        const stages = Array.isArray(d.funnel) ? d.funnel : [];
        let ceiling = null;
        const broken = [];
        for (const s of stages) {
            const c = Number.isFinite(Number(s?.count)) ? Number(s.count) : null;
            if (c != null && ceiling != null && c > ceiling) broken.push(`${s.stage} (${c} > ${ceiling})`);
            else if (c != null) ceiling = c;
        }
        console.log(`      stages: ${stages.map((s) => `${s.stage}=${s.count}`).join(' → ')}`);
        if (broken.length) {
            soft('the funnel is NOT monotonic',
                `${broken.join(', ')}. This is the add_to_cart emitter, repaired 2026-08-31 — `
                + 'cart-analytics.js was loaded on 3 pages while cart.js is on 33. The dashboard '
                + 'card names the broken stage and withholds the overall rate rather than printing '
                + `the backend's own drop_off (${JSON.stringify(d.drop_off)}). Expect this note to `
                + 'clear once the fix has a full 30-day window behind it.');
        } else {
            ok('the funnel is monotonic — add_to_cart is emitting again');
        }
    }

    // ── §5 Quick-order outcome ──────────────────────────────────────────────
    head('§5  Quick-order outcome — live, validating, unreachable');
    {
        const list = await req(`${PROD}/api/admin/quick-orders?limit=3`, { headers: authed });
        const rows = list.json?.data?.quick_orders || [];
        console.log(`      quick_orders rows: ${list.json?.data?.pagination?.total ?? rows.length}`);
        if (!rows.length) {
            soft('there are ZERO quick orders in production',
                'the outcome column and modal are built and correct, but nothing can be recorded '
                + 'against them yet, and the new display fields cannot be confirmed on a real row.');
        } else {
            const r = rows[0];
            const fields = ['outcome', 'reason_lost', 'discount_offered', 'competitor_price',
                'final_negotiated_price', 'decided_at'];
            const missing = fields.filter((f) => !(f in r));
            check(missing.length === 0, 'the record returns all six outcome fields (null included)',
                `missing from the list row: ${missing.join(', ')}`);
        }

        // ONE deliberately-invalid PATCH. Unmatchable id AND an out-of-enum
        // value: it cannot write, whichever check the server runs first.
        const invalid = await req(`${PROD}/api/admin/quick-orders/${UNMATCHABLE_UUID}/outcome`, {
            method: 'PATCH', headers: authed,
            body: JSON.stringify({ outcome: 'probe_invalid_enum_do_not_store' }),
        });
        const msg = JSON.stringify(invalid.json?.error?.details || invalid.json?.error?.message || '');
        check(invalid.status === 400 && /outcome/.test(msg),
            'the route is LIVE and validates the enum (400 on a bad outcome)',
            `expected 400 naming "outcome", got ${invalid.status}: ${invalid.text.slice(0, 200)}`);
        if (invalid.status === 400) console.log(`      ${msg.slice(0, 150)}`);

        for (const [verb, url] of [
            ['POST', `${PROD}/api/admin/quick-orders/${UNMATCHABLE_UUID}/outcome`],
            ['PUT', `${PROD}/api/admin/quick-orders/${UNMATCHABLE_UUID}/outcome`],
        ]) {
            const r = await req(url, { method: verb, headers: authed, body: JSON.stringify({ outcome: 'probe_invalid_enum_do_not_store' }) });
            check(r.status === 404, `${verb} on /outcome is not a route (404) — no fallback verb exists`,
                `${verb} answered ${r.status}; if it is a real route the FE could use it instead of `
                + 'waiting for BF-021');
        }
    }

    // ── §6 Search attribution ───────────────────────────────────────────────
    head('§6  Search → order attribution (the acceptance signal for §1.1)');
    {
        const r = await req(`${PROD}/api/admin/analytics/search/top-converting?result_limit=5`, { headers: authed });
        const rows = Array.isArray(r.json?.data) ? r.json.data : [];
        const gap = r.json?.meta?.data_gap === true;
        const attributed = rows.filter((x) => x && x.orders != null).length;
        console.log(`      ${rows.length} terms, ${attributed} with a non-null \`orders\``);
        if (gap || attributed === 0) {
            soft('orders / conversion_pct are still null for every term',
                'EXPECTED until searches carrying ?sid=/?vid= produce orders. This is the number '
                + 'that proves the join key landed — re-run this in a week or two. '
                + `Backend note: ${r.json?.meta?.note || '(none)'}`);
        } else {
            ok(`search→order attribution is LIVE — ${attributed} of ${rows.length} terms carry order counts`);
        }
    }

    // ── §7 Return requests ──────────────────────────────────────────────────
    head('§7  Return requests');
    {
        const r = await req(`${PROD}/api/orders/ORD-PROBE-UNMATCHABLE/return-request`, {
            method: 'OPTIONS',
            headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
        });
        const allowM = (r.headers.get('access-control-allow-methods') || '').toUpperCase();
        check(allowM.includes('POST'), 'POST /return-request is reachable from the browser',
            `allow-methods: ${allowM || '(none)'}`);
        soft('the `reason` enum could not be enumerated (BF-055)',
            'POST /return-request is aggressively rate-limited by design — it answers '
            + '429 RATE_LIMITED "Too many return requests. Please contact support directly." after '
            + 'very few attempts. Only `faulty` is confirmed. The form renders the server\'s own '
            + 'validation `details` verbatim so a rejected value names itself.');
    }
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1mSummary\x1b[0m  ${pass} passed, ${failures.length} failed, ${notes.length} noted`);
if (notes.length) {
    console.log('\nNotes (real limits the frontend already accommodates — these do not fail the run):');
    notes.forEach((n) => console.log(`  ~ ${n}`));
}
if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
}
process.exit(failures.length ? 1 : 0);
