#!/usr/bin/env node
/**
 * Is anything non-web still downloadable from the live site? (ERR-229)
 * ====================================================================
 *
 * `inkcartridges/vercel.json` sets `outputDirectory: "."` and the Vercel Root
 * Directory is `inkcartridges/`, so every file in that tree is served. Measured
 * on production before the fix (Sep 2026):
 *
 *     GET /sql/analytics_function_grants.sql   200  application/x-sql  5714 B
 *     GET /sql/product_codes.sql               200  application/x-sql  8365 B
 *     GET /sql/admin_ui_prefs.sql              200
 *     GET /sql/order_tracking_requests.sql     200
 *     GET /sql/quote_uploads.sql               200
 *     GET /scripts/fit-audit.js                200
 *     GET /scripts/canonicalise-page-copy.mjs  200
 *     GET /scripts/stamp-versions.js           200
 *     GET /serve.json  /vercel.json  /middleware.js   200
 *
 * Those files publish our RLS policies, our grants, our table shapes, and a
 * written recipe for minting an `authenticated` JWT from the anon key.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * tests/public-surface-sep2026.test.js proves the REPO is clean. It cannot prove
 * the DEPLOYMENT is, and those are different claims: the repo half was fixed by
 * moving files, the deployment half depends on a Vercel Root Directory setting
 * that lives in a dashboard nobody can grep, plus a middleware denylist that
 * only exists at the edge. A green test suite alongside a 200 on
 * /sql/product_codes.sql is exactly the state this project was in for two
 * months. Only a real request to the real host can tell you which one you have.
 *
 * WHAT THIS PROBE CANNOT DO, STATED PLAINLY
 * -----------------------------------------
 * It cannot enumerate the deployment. It asks about a KNOWN list of paths — the
 * ones that were measured live, plus the immovable four. A new non-web file
 * added tomorrow is caught by the test suite, not by this. The two halves are
 * complements; neither is sufficient.
 *
 * It also cannot distinguish "404 because the file is gone" from "404 because
 * the whole site is down", so §0 checks a page that must be 200 first and
 * refuses to report a pass if the site itself is unreachable.
 *
 * ── READ-ONLY. THE MODE IS PRINTED BEFORE ANY WORK. ─────────────────────────
 * GETs only. No --record, no baseline file, nothing written anywhere.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly. That is the very bug this probe
 * watches for, so putting it in the wrong place would publish the list of
 * everything worth stealing.
 *
 * Usage:  npm run probe:public-surface
 *         SITE_BASE=https://<preview>.vercel.app npm run probe:public-surface
 * Exit:   0 = nothing non-web is reachable
 *         1 = something non-web is being served
 *         2 = could not run (network / site down). "We could not look" is never
 *             reported as "we looked and it was fine".
 */

const SITE = (process.env.SITE_BASE || 'https://www.inkcartridges.co.nz').replace(/\/$/, '');

/** Paths that were measured 200 on production and must now be gone. */
const MUST_BE_GONE = [
    ['/sql/analytics_function_grants.sql', 'grants + the JWT-minting recipe'],
    ['/sql/product_codes.sql', 'RLS policies; advertises blanket authenticated insert/delete'],
    ['/sql/admin_ui_prefs.sql', 'RLS policies on an auth.users-keyed table'],
    ['/sql/order_tracking_requests.sql', 'table shape + fulfilment logic'],
    ['/sql/quote_uploads.sql', 'storage bucket policy — anon insert'],
    ['/scripts/fit-audit.js', 'internal audit tooling'],
    ['/scripts/canonicalise-page-copy.mjs', 'internal maintenance tooling'],
    ['/scripts/stamp-versions.js', 'build script — cannot move, denied at the edge'],
    ['/serve.json', 'dev routing config — cannot move, denied at the edge'],
    ['/vercel.json', 'the full routing + header config — cannot move, denied at the edge'],
    ['/middleware.js', 'edge middleware source — cannot move, denied at the edge'],
];

/** Pages that must keep working, so a 404 sweep cannot pass by taking the site down. */
const MUST_BE_ALIVE = [
    ['/', 'the homepage'],
    ['/shop', 'the shop'],
];

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:public-surface — is anything non-web downloadable? (ERR-229)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — GETs only, no writes, no baseline file.');
console.log(`Site: ${SITE}\n`);

const get = async (p) => {
    const res = await fetch(`${SITE}${p}`, { redirect: 'follow' });
    const body = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', body, url: res.url };
};

const run = async () => {
    // ── §0 — the site is up, so a 404 means absence and not an outage ──────
    console.log('\x1b[1m§0 — the site is actually up\x1b[0m');
    for (const [p, what] of MUST_BE_ALIVE) {
        let r;
        try { r = await get(p); } catch (e) { cannotRun(`${SITE}${p} unreachable: ${e.message}`); }
        if (r.status !== 200) {
            cannotRun(`${what} (${p}) answered ${r.status}, not 200 — every 404 below would be `
                + 'meaningless. Fix or wait for the site before trusting this probe.');
        }
        ok(`${what} answers 200`);
    }

    // ── §1 — nothing non-web is served ────────────────────────────────────
    console.log('\n\x1b[1m§1 — non-web files must not be downloadable\x1b[0m');
    for (const [p, why] of MUST_BE_GONE) {
        let r;
        try { r = await get(p); } catch (e) { cannotRun(`${SITE}${p} unreachable: ${e.message}`); }

        if (r.status === 404 || r.status === 403) {
            ok(`${p} → ${r.status}`);
            continue;
        }
        if (r.status === 200) {
            // Distinguish a real file from the SPA 404 page, which also 200s on
            // some hosts. A served .sql is unmistakable; so is a JSON config.
            const looksReal = !/<!doctype html/i.test(r.body.slice(0, 200));
            bad(`${p} IS STILL BEING SERVED (200, ${r.body.length} B${looksReal ? '' : ', HTML — may be the SPA shell'})`,
                `${why}. Anyone on the internet can read this.`);
            continue;
        }
        soft(`${p} → ${r.status}`, 'not 404, not 200 — check what this host is doing with it');
    }

    // ── §2 — what this probe did NOT check ────────────────────────────────
    console.log('\n\x1b[1m§2 — what this probe did NOT check\x1b[0m');
    soft('it did not enumerate the deployment',
        'it asks about a fixed list. A NEW non-web file under inkcartridges/ is caught by '
        + 'tests/public-surface-sep2026.test.js, not by this probe. Run both.');
    soft('it did not verify the Vercel Root Directory setting',
        'that lives in the Vercel dashboard and cannot be read from here. The 404s above are '
        + 'evidence it is still inkcartridges/, not proof.');

    // ── summary ───────────────────────────────────────────────────────────
    console.log(`\n\x1b[1mSummary\x1b[0m  ${pass} passed, ${failures.length} failed, ${notes.length} noted`);
    if (notes.length) {
        console.log('\x1b[33mNotes\x1b[0m');
        for (const n of notes) console.log(`  ~ ${n}`);
    }
    if (failures.length) {
        console.log('\x1b[31mFailures\x1b[0m');
        for (const f of failures) console.log(`  ✗ ${f}`);
        console.log('\nMove the file to the repo root (outside inkcartridges/), or add its path to '
            + 'NON_WEB_PATH + config.matcher in inkcartridges/middleware.js.');
        process.exit(1);
    }
    console.log('\n\x1b[32mNothing non-web is reachable on this host.\x1b[0m\n');
};

run().catch((e) => cannotRun(e.message));
