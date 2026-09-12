#!/usr/bin/env node
/**
 * Did the "FOR USE IN" cutover keep every list, and is the anon read gone?
 * =========================================================================
 * ERR-243.
 *
 * The PDP used to read `products.compatible_devices_html` straight off
 * PostgREST with the anon key that ships in the page:
 *
 *   GET /rest/v1/products?sku=eq.CTN258XLBK
 *         &select=id,description_html,compatible_devices_html,related_product_skus
 *
 * Read that way it was BULK-DUMPABLE — drop the `sku=eq.` filter and every
 * admin-authored machine list came back in one request. It now comes from
 * GET /api/products/:sku/for-use-in, backed by `product_compat_devices`
 * (backend mig 131) with RLS on and no anon grant.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * The backend will run migration 132 and DROP the column once we confirm the
 * cutover. That is irreversible. A ribbon PDP shows NOTHING without this copy
 * (ERR-086), so a list that fails to migrate does not error — it renders a
 * blank page that looks exactly like a ribbon with no listed machines. That is
 * ERR-193 precisely: a failed read printing the empty-shelf copy on 63 pages
 * for 44 hours, with no symptom. §2 is the gate that has to be green before
 * anyone runs mig 132.
 *
 * THE MISTAKE THIS PROBE IS BUILT NOT TO REPEAT
 * ---------------------------------------------
 * The first version of this comparison, run by hand, reported "43 of 91 lists
 * missing" and nearly sent the backend a false alarm. They were not missing.
 * The endpoint is rate-limited to 40/min/IP (`forUseInLimiter`) and a 429 body
 * has no `for_use_in_html` key, so `resp.data.for_use_in_html ?? null` read a
 * REFUSAL as an absence. Re-run paced, it was 0 missing out of 90 reachable.
 * So: this probe paces itself under the limit, retries a 429, and counts a 429
 * as a FAILURE TO MEASURE — never as "no data". A read we could not make is not
 * a read that agreed.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * GETs only. There is no --record and no --update-baseline, deliberately: a
 * probe that can record may be green only because it just overwrote what it
 * compared against (sweep:b2b ate a committed fixture, 2026-08-12). The mode is
 * PRINTED on every run, and so is which of the two comparison modes it took.
 *
 *   npm run probe:for-use-in
 */

import { chromium } from 'playwright';

const API = process.env.PROBE_API || 'https://api.inkcartridges.co.nz';
const SITE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.PROBE_ANON_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

// Measured 2026-09-09: 91 products carried a non-null compatible_devices_html.
// A floor, not an equality — admins add and remove these. A drop below it after
// mig 132 means the migration lost lists.
const MEASURED_FLOOR = 80;
// 2.0s ⇒ 30 req/min against a 40/min limiter. 1.6s (37.5/min) was measured too
// close: a live run lost two SKUs to 429s and correctly refused to certify the
// migration on an incomplete comparison. Headroom is cheaper than a re-run.
const PACE_MS = 2000;
// A ribbon whose whole page is the FOR USE IN block.
const RIBBON_PDP = '/product/star-69101-printer-ribbon';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n\x1b[1mprobe:for-use-in — the FOR USE IN cutover (ERR-243)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no writes.');
console.log(`API: ${API}   Site: ${SITE}\n`);

/** One endpoint read. Distinguishes "no list" from "could not ask". */
async function forUseIn(sku) {
    for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
            res = await fetch(`${API}/api/products/${encodeURIComponent(sku)}/for-use-in`);
        } catch (e) {
            return { unreachable: `network: ${e.message}` };
        }
        // Progressive backoff. The window is 60s, so a flat retry can spend all
        // four attempts inside the same window and give up while still limited.
        if (res.status === 429) { await sleep(5000 + attempt * 12000); continue; }
        if (!res.ok) return { unreachable: `HTTP ${res.status}` };
        const j = await res.json().catch(() => null);
        if (!j || j.ok !== true || !j.data) return { unreachable: 'no data envelope' };
        // hasOwnProperty, not `?? null` — ABSENT and null are different answers,
        // and reading the first as the second is the bug this probe was built to
        // stop repeating (ERR-199 is the same distinction).
        if (!Object.prototype.hasOwnProperty.call(j.data, 'for_use_in_html')) {
            return { unreachable: 'envelope carried no for_use_in_html key' };
        }
        return { html: j.data.for_use_in_html };
    }
    return { unreachable: 'rate-limited after 4 attempts (40/min) — NOT counted as "no list"' };
}

// ── §1 Which comparison is even possible? ─────────────────────────────────
console.log('\x1b[1m§1 which mode can this run in?\x1b[0m');
let columnRows = null;
try {
    const res = await fetch(
        `${SUPABASE}/rest/v1/products?compatible_devices_html=not.is.null&select=sku,compatible_devices_html&limit=500`,
        { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
    if (res.ok) columnRows = await res.json();
    else notes.push(`supabase column read answered ${res.status}`);
} catch (e) {
    notes.push(`supabase column read failed: ${e.message}`);
}

const MODE = Array.isArray(columnRows) && columnRows.length ? 'PRE-MIGRATION' : 'POST-MIGRATION';
if (MODE === 'PRE-MIGRATION') {
    console.log(`\x1b[36m      COMPARISON MODE: PRE-MIGRATION\x1b[0m — products.compatible_devices_html still readable,`);
    console.log(`      so every list can be compared old-source vs new-source. ${columnRows.length} rows carry one.`);
    ok('the pre-migration comparison is available — this is the strong check');
} else {
    console.log(`\x1b[36m      COMPARISON MODE: POST-MIGRATION\x1b[0m — products.compatible_devices_html is gone or`);
    console.log('      unreadable (mig 132 has run). The old source no longer exists, so the');
    console.log('      strong comparison is NOT possible and §2 degrades to a coverage floor.');
    soft('running the weaker post-migration check', 'no old source to compare against; §2 asserts a coverage floor instead');
}

// ── §2 Nothing was lost ───────────────────────────────────────────────────
console.log(`\n\x1b[1m§2 no machine list was lost in the cutover\x1b[0m`);
if (MODE === 'PRE-MIGRATION') {
    let identical = 0, normalised = 0;
    const missing = [], unmeasurable = [];
    for (const row of columnRows) {
        const out = await forUseIn(row.sku);
        if (out.unreachable) { unmeasurable.push(`${row.sku} (${out.unreachable})`); await sleep(PACE_MS); continue; }
        if (out.html == null || String(out.html).trim() === '') { missing.push(row.sku); await sleep(PACE_MS); continue; }
        if (out.html === row.compatible_devices_html) identical++;
        else normalised++;   // sanitiser: <br> → <br />, &nbsp; → space, trailing trim
        await sleep(PACE_MS);   // 30/min, comfortably under the 40/min limit
    }
    console.log(`      ${identical} byte-identical, ${normalised} differing only by sanitiser normalisation`);
    if (unmeasurable.length) {
        bad('some lists could not be measured', `${unmeasurable.length}: ${unmeasurable.slice(0, 6).join(', ')}` +
            '\n      These are NOT "no list" — the comparison is incomplete and mig 132 must NOT run yet.');
    } else {
        ok('every product with a list was reachable — the comparison is complete');
    }
    if (missing.length) {
        bad('the endpoint has NO list for a product whose column has one',
            `${missing.length} SKU(s): ${missing.slice(0, 10).join(', ')}` +
            '\n      Running backend migration 132 now would delete these permanently.');
    } else {
        ok(`all ${columnRows.length} lists survive on the endpoint — mig 132 is safe to run`);
    }
} else {
    // Walk the ribbon catalogue — the surface that depends on this copy.
    //
    // 🚨 THIS ASKED FOR limit=500 AND READ THE REFUSAL AS AN EMPTY CATALOGUE.
    //
    // `/api/ribbons` caps `limit` at 200 and answers a **400**, not a clamp —
    // the same shape as the business-applications endpoint (ERR-151). The old
    // code read `j.data.ribbons` off that error envelope, got `[]`, and reported
    // "the ribbon catalogue came back empty — cannot establish coverage".
    //
    // Which is a REFUSAL scored as an ABSENCE, in the probe written to record
    // exactly that lesson (ERR-243: a 429 body has no `for_use_in_html` key, and
    // reading its absence as "no list" nearly sent the backend a data-loss
    // alarm). It exits 2 rather than green, so it was never a false pass — but a
    // false alarm sends someone hunting a data-loss problem that does not exist.
    //
    // Measured 2026-09-12: limit=200 → 109 ribbons, limit=500 → 400. The status
    // is checked FIRST now, and an error is named as an error.
    let ribbons = [];
    try {
        const res = await fetch(`${API}/api/ribbons?limit=200`);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            cannotRun(`/api/ribbons answered ${res.status} — this is a REFUSAL, not an empty catalogue. `
                + `${body.slice(0, 200)}`);
        }
        const j = await res.json().catch(() => null);
        if (!j || j.ok !== true || !j.data) cannotRun('/api/ribbons returned no usable envelope');
        ribbons = j.data.ribbons || j.data.products || (Array.isArray(j.data) ? j.data : []);
    } catch (e) { cannotRun(`could not list ribbons — ${e.message}`); }
    if (!ribbons.length) {
        cannotRun('/api/ribbons answered 200 with zero ribbons — the catalogue really is empty, '
            + 'which is itself the alarm (ERR-193 blanked 63 brand pages for 44h)');
    }
    let withList = 0, unmeasurable = 0;
    for (const r of ribbons) {
        const out = await forUseIn(r.sku);
        if (out.unreachable) unmeasurable++;
        else if (out.html && String(out.html).trim()) withList++;
        await sleep(PACE_MS);
    }
    console.log(`      ${withList} of ${ribbons.length} ribbons carry a list; ${unmeasurable} unmeasurable`);
    if (unmeasurable) bad('some lists could not be measured', `${unmeasurable} reads failed — coverage is a floor, not a fact`);
    if (withList >= MEASURED_FLOOR) ok(`coverage ${withList} is at or above the ${MEASURED_FLOOR} measured before the migration`);
    else bad('coverage dropped below the pre-migration floor',
        `${withList} < ${MEASURED_FLOOR} measured on 2026-09-09. Lists were lost.`);
}

// ── §3 The anon read is actually gone, in a real browser ──────────────────
console.log(`\n\x1b[1m§3 the PDP no longer asks PostgREST for compatible_devices_html\x1b[0m`);
console.log('      Source greps prove a string is absent from a file. Only the browser can');
console.log('      prove the request is absent from the wire — that is the ERR-194 lesson.');
console.log(`      \x1b[36mNOTE: §3 and §4 measure the DEPLOYED bundle at ${SITE}\x1b[0m, not your`);
console.log('      working tree. Before the cutover ships they SHOULD fail. To check an');
console.log('      unlanded change:  PROBE_BASE=http://localhost:3000 npm run probe:for-use-in');
let browser;
try {
    browser = await chromium.launch();
} catch (e) {
    soft('browser checks skipped', `playwright could not launch — ${e.message}. §3 and §4 DID NOT RUN.`);
}
if (browser) {
    // No ctx.route() anywhere in this file, ever: a route handler re-issues
    // requests outside the browser's own enforcement and would make a transport
    // claim that is not the browser's.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    try {
        await page.goto(`${SITE}${RIBBON_PDP}`, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (e) {
        soft('ribbon PDP did not settle', e.message);
    }

    const legacy = requests.filter((u) => u.includes('/rest/v1/products') && u.includes('compatible_devices_html'));
    if (legacy.length === 0) ok('no PostgREST request names compatible_devices_html');
    else bad('the anon read is STILL firing', `${legacy.length} request(s), e.g. ${legacy[0].slice(0, 160)}` +
        `\n      The backend cannot run mig 132 while this is on the wire. If the cutover is` +
        `\n      merged but not yet deployed, ${SITE} is simply still serving the old bundle.`);

    const endpointCalls = requests.filter((u) => /\/api\/products\/[^/]+\/for-use-in/.test(u));
    if (endpointCalls.length) ok(`the PDP calls /api/products/:sku/for-use-in (${endpointCalls.length}×)`);
    else bad('the PDP never called the for-use-in endpoint', 'the cutover did not take effect on this page');

    // ── §4 The block actually paints, and the three states are distinct ────
    console.log(`\n\x1b[1m§4 the block paints, and 'could not ask' is not shown as 'no list'\x1b[0m`);
    const state = await page.evaluate(() => document.documentElement.getAttribute('data-for-use-in'));
    const block = await page.evaluate(() => {
        const el = document.querySelector('.product-compat-devices');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
            state: el.getAttribute('data-for-use-in-state'),
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            w: Math.round(r.width), h: Math.round(r.height),
        };
    });

    if (!state) {
        bad('no data-for-use-in state on <html>', 'the renderer could not record which of the three outcomes happened — ' +
            'that is the ERR-193 blind spot this cutover was supposed to close');
    } else {
        ok(`recorded state: ${state}`);
    }
    if (state === 'unavailable') {
        bad('the endpoint could not be reached from the browser',
            'the PDP is showing its "could not load" notice. This is the LOUD path working, ' +
            'but the endpoint is down or rate-limiting real visitors.');
    } else if (state === 'ok') {
        if (block && block.h > 0 && block.w > 0) ok(`FOR USE IN painted — ${block.w}x${block.h}px, "${block.text.slice(0, 60)}…"`);
        else bad('state is ok but nothing painted', `block=${JSON.stringify(block)} — the list was fetched and then dropped on the floor`);
    } else if (state === 'none') {
        bad(`${RIBBON_PDP} reports NO list`,
            'this ribbon had one on 2026-09-09. Either the probe fixture is stale (pick another ' +
            'ribbon) or a list was genuinely lost.');
    }
    await browser.close();
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1mSummary\x1b[0m  (comparison mode: ${MODE})`);
console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
if (notes.length) { console.log('\n  Notes:'); notes.forEach((n) => console.log(`    ~ ${String(n).split('\n')[0]}`)); }
if (failures.length) {
    console.log('\n\x1b[31m  FAILURES\x1b[0m');
    failures.forEach((f) => console.log(`    ✗ ${f.split('\n')[0]}`));
    console.log('\n  \x1b[31mDo NOT ask the backend to run migration 132.\x1b[0m\n');
    process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — every list survives the cutover and the anon read is off the wire.');
if (MODE === 'PRE-MIGRATION') console.log('  Backend migration 132 is safe to run.\n');
else console.log('  (post-migration mode — coverage floor only, see §1)\n');
