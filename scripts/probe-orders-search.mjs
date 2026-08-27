#!/usr/bin/env node
/**
 * probe-orders-search.mjs — does GET /api/admin/orders actually honour ?search= ?
 * =====================================================================
 *
 * The admin Orders page ships a search box wired to the server's `search` param
 * (AdminAPI.getOrders, js/admin/api.js). The frontend cannot tell a working
 * filter from an ignored one: if the backend drops the param and returns the
 * whole table, the box looks alive — you type, rows come back, the page repaints
 * — and every one of those rows is wrong. ERR-151 is that exact failure on a
 * different admin endpoint (`?user_id=` / `?search=` were DECOYS: accepted,
 * ignored, full table returned).
 *
 * So the assertion that matters is not "does search return rows", it is:
 *   - a real name token returns rows AND EVERY ROW MATCHES IT
 *   - a nonsense token returns FEWER rows than the unfiltered baseline
 * The second check is the one that catches an ignored param. Without it a probe
 * that only asserted "200 + rows" would go green against a backend that filters
 * nothing at all.
 *
 * Also measured (2026-08-28): EMAIL IS NOT SEARCHABLE on this endpoint at all.
 * `search=<address>` and `search=<local part>` both return 0, and `customer_email=`
 * returns 0 for every real address (400 when the row's customer_email is null).
 * api.js routes any query containing '@' to customer_email, so every email query
 * is a guaranteed-empty result. That is a NOTE here rather than a failure on one
 * condition: the Orders box must not PROMISE email. It doesn't — it offers name
 * and order #, and spells out an email-shaped miss instead of failing silently.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. No --record / --update-baseline mode exists and this
 * probe writes nothing, anywhere. A probe that can record may be green because
 * it just overwrote what it compared against (sweep:b2b ate a committed fixture,
 * 2026-08-12). The mode is printed on every run so it can never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:orders-search           (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:orders-search -- Richie (force the name token to probe)
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** A token no customer can plausibly carry. Used to prove the param is honoured. */
const NONSENSE = 'zzqxnope';
const BASELINE_LIMIT = 50;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * A real limit worth reporting, but one the frontend can honestly accommodate —
 * so it must NOT redden the exit code. If a soft note could fail the run, the run
 * gets ignored, and a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

/**
 * The customer-name fallback chain, byte-for-byte the one the Orders list column
 * renders (js/admin/pages/orders.js — COLUMNS 'customer'). The probe must judge a
 * match on the SAME string the admin sees, or it proves something nobody looks at.
 */
function rowName(r) {
    const profile = r.user_profile || r.user_profiles || r.customer || {};
    return String(
        r.customer_name || profile.full_name
        || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
        || ''
    );
}
function rowEmail(r) {
    const profile = r.user_profile || r.user_profiles || r.customer || {};
    return String(r.customer_email || profile.email || r.guest_email || '');
}
/** Everything a "search customer, email, order #" box could legitimately match on. */
function rowHaystack(r) {
    return `${rowName(r)} ${rowEmail(r)} ${r.order_number || ''} ${r.id || ''}`.toLowerCase();
}

function readEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(
        fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
            const i = l.indexOf('=');
            return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    );
}

async function signIn(email, password) {
    const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    const json = await res.json();
    if (!json.access_token) throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
    return json.access_token;
}

const rowsOf = (json) => json?.data?.orders || json?.data?.items || json?.data || [];

async function main() {
    console.log('\n\x1b[1mAdmin orders ?search= live contract probe\x1b[0m');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET; this probe writes nothing.\n');

    const env = readEnv();
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    if (!email || !password) {
        // A skip is not a pass. Exit 2 and say which variable is missing, by name.
        console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
        console.error('These must be a super_admin — the admin orders endpoints 403 for anyone else.');
        console.error('Nothing was verified. Do NOT read this as a pass.\n');
        process.exit(2);
    }

    const token = await signIn(email, password);
    const get = async (p) => {
        const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: res.status, json, text };
    };
    console.log(`Signed in as ${email}\n`);

    // ── 1. Baseline ──────────────────────────────────────────────────────────
    console.log(`\x1b[1m1. Baseline — GET /api/admin/orders?page=1&limit=${BASELINE_LIMIT}\x1b[0m`);
    const base = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}`);
    if (base.status !== 200) {
        bad('GET /api/admin/orders', `HTTP ${base.status} — ${base.text.slice(0, 160)}`);
        return report();
    }
    const baseRows = rowsOf(base.json);
    const baseTotal = base.json?.data?.pagination?.total ?? baseRows.length;
    check(baseRows.length > 0, `baseline returned ${baseRows.length} rows (total ${baseTotal})`,
        'no orders at all — nothing to probe against');
    if (!baseRows.length) return report();

    // Pick a real name token from live data — never hardcode a customer, the probe
    // has to survive the data changing underneath it.
    const named = baseRows.find((r) => rowName(r).trim().length > 2);
    const forced = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
    const token1 = forced || (named ? rowName(named).trim().split(/\s+/)[0] : '');
    if (!token1) {
        bad('name token', 'no baseline row carries a customer name — cannot probe name matching');
        return report();
    }
    const expectedByName = baseRows.filter((r) => rowName(r).toLowerCase().includes(token1.toLowerCase()));
    console.log(`  \x1b[2mprobe token "${token1}" — ${expectedByName.length} of the ${baseRows.length} baseline rows carry it\x1b[0m`);

    // ── 2. Does ?search= match a customer NAME? ───────────────────────────────
    console.log(`\n\x1b[1m2. Name match — GET /api/admin/orders?search=${token1}\x1b[0m`);
    const byName = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&search=${encodeURIComponent(token1)}`);
    if (byName.status !== 200) {
        bad(`?search=${token1}`, `HTTP ${byName.status} — ${byName.text.slice(0, 160)}`);
    } else {
        const rows = rowsOf(byName.json);
        check(rows.length > 0, `?search=${token1} returned ${rows.length} rows`,
            `returned 0 rows, but ${expectedByName.length} baseline rows carry that name — `
            + 'the backend does not match on customer name. A name search box cannot ship server-side.');
        if (rows.length) {
            const offenders = rows.filter((r) => !rowHaystack(r).includes(token1.toLowerCase()));
            check(offenders.length === 0,
                `every one of the ${rows.length} rows matches "${token1}" on name, email or order #`,
                `${offenders.length} row(s) match nothing searchable — e.g. `
                + offenders.slice(0, 3).map((r) => `${r.order_number}/"${rowName(r)}"`).join(', ')
                + ' — the param is being partially ignored');
            const byActualName = rows.filter((r) => rowName(r).toLowerCase().includes(token1.toLowerCase()));
            check(byActualName.length > 0, `${byActualName.length} row(s) matched on the NAME field specifically`,
                'rows came back but none matched on name — the filter hit order_number/email only, '
                + 'so "search by name" would be a false promise');
        }
    }

    // ── 3. The check that catches an IGNORED param (ERR-151) ─────────────────
    console.log(`\n\x1b[1m3. Not-ignored guard — GET /api/admin/orders?search=${NONSENSE}\x1b[0m`);
    const nonsense = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&search=${NONSENSE}`);
    if (nonsense.status !== 200) {
        bad(`?search=${NONSENSE}`, `HTTP ${nonsense.status} — ${nonsense.text.slice(0, 160)}`);
    } else {
        const rows = rowsOf(nonsense.json);
        check(rows.length < baseRows.length,
            `nonsense token returned ${rows.length} rows vs ${baseRows.length} unfiltered — the param IS honoured`,
            `returned the SAME ${rows.length} rows as the unfiltered list — the backend is IGNORING ?search= `
            + '(ERR-151 shape). Any search box built on this would filter nothing while looking like it works.');
        if (rows.length && rows.length < baseRows.length) {
            soft(`?search=${NONSENSE} returned ${rows.length} rows rather than 0`,
                'filtered, but not to empty — worth a glance at what it matched on');
        }
    }

    // ── 4. Email is NOT searchable — measured, and the UI must not promise it ─
    //
    // Measured 2026-08-28 against live data: `search=<full address>` returns 0 for
    // every address in the table, `search=<local part>` returns 0 too (a hit on
    // "sean" is a match on the NAME Sean Fleet, not on sean@riderstudio.co.nz),
    // and `customer_email=` returns 0 for every real address — and 400s outright
    // when the row's customer_email is null. So api.js's '@' branch
    // (getOrders: `if (search.includes('@')) params.set('customer_email', …)`)
    // routes every email query into a guaranteed-empty result.
    //
    // This is a NOTE, not a failure, on one condition: the Orders search box must
    // not claim to search email. It doesn't — the placeholder says "customer name
    // or order #", and an email-shaped query gets a spelled-out empty state rather
    // than a bare "no orders found". If that promise ever creeps back into the
    // placeholder, this note is the receipt showing it was never true.
    const withEmail = baseRows.find((r) => rowEmail(r).includes('@'));
    console.log('\n\x1b[1m4. Email search — expected UNSUPPORTED (UI must not promise it)\x1b[0m');
    if (!withEmail) {
        soft('email search', 'no baseline row carries an email — not probed');
    } else {
        const full = rowEmail(withEmail);
        const local = full.split('@')[0];
        const viaSearch = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&search=${encodeURIComponent(full)}`);
        const viaLocal = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&search=${encodeURIComponent(local)}`);
        const viaParam = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&customer_email=${encodeURIComponent(full)}`);
        const n = (x) => (x.status === 200 ? rowsOf(x.json).length : `HTTP ${x.status}`);
        const anyWorks = (viaSearch.status === 200 && rowsOf(viaSearch.json).length > 0)
            || (viaParam.status === 200 && rowsOf(viaParam.json).length > 0);
        if (anyWorks) {
            // A pleasant surprise is still a contract change — say so loudly enough to act on.
            soft('email search now WORKS on the backend',
                `search=<full> -> ${n(viaSearch)}, customer_email=<full> -> ${n(viaParam)}. `
                + 'The Orders placeholder deliberately promises only name + order #; it can be widened now.');
        } else {
            soft('email is not searchable (as expected)',
                `search=<full> -> ${n(viaSearch)}, search=<local "${local}"> -> ${n(viaLocal)}, `
                + `customer_email=<full> -> ${n(viaParam)}. api.js routes '@' queries to customer_email, `
                + 'which never matches — so the UI promises name + order # only, and names an email-shaped '
                + 'query in its empty state instead of failing silently.');
        }
    }

    // ── 5. Order number ──────────────────────────────────────────────────────
    const numbered = baseRows.find((r) => r.order_number);
    console.log('\n\x1b[1m5. Order number — GET /api/admin/orders?search=<order_number>\x1b[0m');
    if (!numbered) {
        soft('order-number match', 'no baseline row carries an order_number — not probed');
    } else {
        const num = String(numbered.order_number);
        const byNum = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}&search=${encodeURIComponent(num)}`);
        const rows = byNum.status === 200 ? rowsOf(byNum.json) : [];
        check(rows.some((r) => String(r.order_number) === num),
            `?search=${num} returned the matching order (${rows.length} row(s))`,
            `HTTP ${byNum.status}, ${rows.length} rows, none of them ${num} — the #orders?focus= deep-link `
            + 'from Tracking Requests relies on this and would land on an empty list');
    }


    // ── 6. search must COMPOSE with the page's other filters ─────────────────
    // The Orders page sends search alongside status + date_from/date_to on every
    // keystroke. A backend that treated search as exclusive — dropping the status
    // filter whenever a query is present — would quietly widen the result set past
    // what the Status chip says is showing, which is a lie the UI can't detect.
    console.log('\n\x1b[1m6. Composition — search + status together\x1b[0m');
    const statusRow = baseRows.find((r) => r.status);
    if (!token1 || !statusRow) {
        soft('composition', 'no token or no status on baseline rows — not probed');
    } else {
        const st = statusRow.status;
        const combo = await get(`/api/admin/orders?page=1&limit=${BASELINE_LIMIT}`
            + `&search=${encodeURIComponent(token1)}&status=${encodeURIComponent(st)}`);
        const rows = combo.status === 200 ? rowsOf(combo.json) : [];
        const wrong = rows.filter((r) => r.status !== st);
        check(combo.status === 200 && wrong.length === 0,
            `search=${token1}&status=${st} returned ${rows.length} row(s), all status="${st}"`,
            `${wrong.length} row(s) came back with a different status `
            + `(${[...new Set(wrong.map((r) => r.status))].join(', ')}) — search is overriding the `
            + 'status filter, so the list would show rows the Status chip excludes');
    }

    report();
}

function report() {
    console.log(`\n${'─'.repeat(64)}`);
    if (notes.length) {
        console.log(`\x1b[33m${notes.length} note${notes.length === 1 ? '' : 's'}\x1b[0m `
            + '(real limits the frontend can accommodate, not failures):\n');
        notes.forEach((n) => console.log(`  • ${n}`));
        console.log('');
    }
    if (failures.length === 0) {
        console.log(`\x1b[32m${pass} checks passed.\x1b[0m `
            + 'GET /api/admin/orders honours ?search= — an Orders search box has a real filter behind it.\n');
        process.exit(0);
    }
    console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${pass} passed:\n`);
    failures.forEach((f) => console.log(`  • ${f}`));
    console.log('');
    process.exit(1);
}

main().catch((e) => {
    console.error(`\n\x1b[31mProbe could not run:\x1b[0m ${e.message}\n`);
    process.exit(2);
});
