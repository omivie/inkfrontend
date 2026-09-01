#!/usr/bin/env node
/**
 * probe-invoice-cash-basis.mjs — establish, against LIVE data, the five facts the
 * cash-basis invoice change depends on (ERR-197)
 * =====================================================================
 *
 * The owner wants invoiced sales to reach the dashboard's revenue and profit only
 * once the PAID slider is flipped, while the cost of the goods keeps landing on
 * the day the invoice was raised. The frontend does that by SUBTRACTING unpaid
 * invoices from the backend's (accrual) figures.
 *
 * That subtraction is only safe if a handful of things are true about the live
 * data. A unit test cannot see any of them — it reads source, not production.
 *
 * ── WHAT THIS PROBE ESTABLISHED, 2026-09-01 (read this before changing it) ──
 *
 * `source_order_id` is NOT on /api/admin/invoices list rows. Measured, absent.
 * The original plan treated that as the gate and would have stopped here.
 *
 * It is not the gate, because there is a better one. Every invoice the backend
 * counts materialises as a SHADOW ORDER numbered `INV-<invoice_number>`
 * (payment_method 'invoice'). That order is the thing the dashboard's revenue
 * actually contains, and it answers both questions the missing field would have:
 *
 *   1. WHETHER the backend counted this invoice — a matching INV- order exists.
 *      An invoice raised against a real order gets no shadow order (that is the
 *      backend's own double-count guard), so it simply will not join, and will
 *      not be deducted.
 *   2. WHICH DAY it counted it on — the shadow order's `created_at`, which is the
 *      invoice's ORDER date. This is NOT `issue_date`, the only date on the list
 *      row. They differ on 7 of 15 invoices, by up to 8 days and across month
 *      boundaries. Bucketing by `issue_date` would have moved money into the
 *      wrong month and left a phantom in the right one. INV-3277 is the clearest
 *      case: issue_date 2026-09-01, booked 2026-08-28, and the backend reports
 *      invoice_revenue = 0 for the whole of September.
 *
 * Proof, all three windows exact to the cent (§1b re-checks it every run):
 *      Jun 2026  1 order   $195.99   Jul  5 orders $1,551.92
 *      Aug 2026  8 orders  $3,661.23
 *
 * A second thing worth knowing: the shadow order's OWN status is 'paid' with a
 * `paid_at` for every invoice, including the nine the Invoices page shows as
 * unpaid. The order's paid state is decoupled from the invoice's and must never
 * be read as the answer to "has the customer paid?" — `invoices.status` is.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. There is no --record / --update-baseline mode and this
 * writes nothing, anywhere. That is deliberate: a probe that can record may pass
 * because it just overwrote what it was comparing against (sweep:b2b ate a
 * committed fixture, 2026-08-12). The mode is PRINTED on every run.
 *
 * Cold Render instances answer 404 for routes that plainly work, so the backend
 * is WARMED before anything is asserted and the list route is read TWICE.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly.
 *
 * Usage:  npm run probe:invoice-cash-basis   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** GST is 15%; an incl-GST figure becomes ex-GST by x20/23. ERR-111 basis. */
const EX = 20 / 23;
const round2 = (n) => Math.round(n * 100) / 100;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * A real gap worth reporting that the frontend already handles correctly, so it
 * must NOT redden the exit code. If a soft note could fail the run, the run gets
 * ignored — and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (name, why) => {
    notes.push(`SKIPPED: ${name} — ${why}`);
    console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${name}\n      ${why}`);
};

function readEnv() {
    const f = path.join(ROOT, '.env');
    if (!fs.existsSync(f)) return {};
    return Object.fromEntries(
        fs.readFileSync(f, 'utf8').split('\n')
            .filter(l => l.includes('=') && !l.trim().startsWith('#'))
            .map(l => [l.slice(0, l.indexOf('=')).trim(),
                       l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
}

async function main() {
    console.log('\n\x1b[1mprobe-invoice-cash-basis\x1b[0m — the five live facts ERR-197 rests on');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only; no --record mode exists, nothing is written)\n');

    const env = readEnv();
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
        console.error('Cannot run: ADMIN_EMAIL / ADMIN_PASSWORD missing from .env');
        process.exit(2);
    }

    const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
    });
    const session = await auth.json();
    if (!session.access_token) {
        console.error(`Cannot run: admin sign-in failed (${auth.status})`);
        console.error('These must be a super_admin — /api/admin/* 403s for anyone else.');
        process.exit(2);
    }
    const token = session.access_token;

    const get = async (p) => {
        const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: res.status, text, json };
    };

    // ---- 0. warm the instance ----------------------------------------------
    // Cold Render answers `404 Endpoint not found` for routes the admin visibly
    // uses. Every 404 below this line is therefore a real one.
    console.log('\x1b[1m0. Warming the backend\x1b[0m');
    let warm = null;
    for (let i = 1; i <= 4; i++) {
        warm = await get('/api/admin/invoices?page=1&limit=1');
        if (warm.status !== 404 && warm.status !== 502 && warm.status !== 503) break;
        console.log(`      attempt ${i}: HTTP ${warm.status} — cold, retrying`);
        await new Promise(r => setTimeout(r, 3000));
    }
    if (warm.status !== 200) {
        console.error(`\nCannot run: GET /api/admin/invoices is HTTP ${warm.status} even warm.`);
        console.error(warm.text.slice(0, 200));
        process.exit(2);
    }
    ok(`GET /api/admin/invoices → 200 (warm)`);

    const rowsOf = (d) => d?.invoices || d?.items || (Array.isArray(d) ? d : []);

    // ---- 1. THE GATE: the shadow-order join -------------------------------
    console.log('\n\x1b[1m1. THE GATE — every counted invoice joins to an INV- shadow order\x1b[0m');
    const first = await get('/api/admin/invoices?page=1&limit=100');
    const second = await get('/api/admin/invoices?page=1&limit=100');   // read twice, warm
    let sample = rowsOf(first.json?.data);
    const sample2 = rowsOf(second.json?.data);

    const ordRes = await get('/api/admin/orders?page=1&limit=200');
    const ordRows = Array.isArray(ordRes.json?.data)
        ? ordRes.json.data                                   // orders `data` is a BARE ARRAY (ERR-176)
        : (ordRes.json?.data?.orders || ordRes.json?.data?.items || []);
    const shadows = new Map();
    for (const o of ordRows) {
        const m = /^INV-(\d+)$/.exec(String(o.order_number || ''));
        if (m) shadows.set(m[1], o);
    }

    if (!sample.length) {
        bad('the list returns rows', 'zero invoices came back — nothing below can be established');
        sample = [];
    } else {
        ok(`${sample.length} invoices sampled (second read: ${sample2.length}), ${ordRows.length} orders, ${shadows.size} INV- shadows`);
        const keys = [...new Set(sample.flatMap(Object.keys))].sort();
        console.log(`      invoice list keys: ${keys.join(', ')}`);

        if (sample.some(r => 'source_order_id' in r)) {
            soft('source_order_id has APPEARED on list rows',
                 'the backend grew the field. The shadow-order join still works and is still the '
                 + 'authority on the booking DATE, so nothing has to change — but it is now possible '
                 + 'to cross-check the join against the field.');
        } else {
            ok('source_order_id absent as expected — the shadow-order join is the discriminator');
        }

        const unjoined = sample.filter(r => !shadows.has(String(r.invoice_number)));
        if (unjoined.length) {
            soft(`${unjoined.length}/${sample.length} invoice(s) have NO shadow order`,
                 `#${unjoined.map(r => r.invoice_number).join(', #')} — the backend did not count these, `
                 + 'so the deduction must skip them. That is the join doing its job, not an error.');
        } else {
            ok(`all ${sample.length} invoices join 1:1 to a shadow order`);
        }

        // The booking date is the SHADOW ORDER's created_at, not issue_date.
        let drifted = 0;
        for (const r of sample) {
            const o = shadows.get(String(r.invoice_number));
            if (!o) continue;
            const a = String(r.issue_date).slice(0, 10);
            const b = String(o.created_at).slice(0, 10);
            if (a !== b) {
                drifted++;
                if (drifted <= 8) console.log(`      #${r.invoice_number}: issue_date ${a} but booked ${b}${a.slice(0, 7) !== b.slice(0, 7) ? '  \x1b[33m← different MONTH\x1b[0m' : ''}`);
            }
        }
        if (drifted) {
            soft(`${drifted}/${shadows.size} invoices are booked on a different day than issue_date`,
                 'bucket by the shadow order\'s created_at. Bucketing by issue_date moves money '
                 + 'into the wrong month and leaves a phantom in the right one.');
        } else {
            ok('issue_date == shadow created_at on every invoice (today; do not rely on it)');
        }

        // The shadow order's own paid state is NOT the customer's.
        const shadowPaid = [...shadows.values()].filter(o => o.status === 'paid').length;
        const invUnpaid = sample.filter(r => r.status === 'unpaid').length;
        if (shadowPaid && invUnpaid) {
            soft(`${shadowPaid} shadow orders are status 'paid' while ${invUnpaid} invoices are unpaid`,
                 'the order\'s paid flag is decoupled from the invoice\'s. Read invoices.status — '
                 + 'never the order\'s — to answer "has the customer paid?"');
        }
    }

    // ---- 1b. the reconciliation that replaces the missing field -------------
    console.log('\n\x1b[1m1b. Per-period reconciliation against the backend\'s own invoice_revenue\x1b[0m');
    {
        const windows = [];
        const today = new Date();
        for (let i = 0; i < 4; i++) {
            const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
            const from = d.toISOString().slice(0, 10);
            const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
            windows.push([from, to]);
        }
        let checked = 0;
        for (const [from, to] of windows) {
            const k = await get(`/api/admin/analytics/kpi-summary?date_from=${from}&date_to=${to}`);
            if (k.status !== 200) { soft(`kpi-summary ${from}..${to}`, `HTTP ${k.status}`); continue; }
            const cur = k.json?.data?.kpis?.current ?? k.json?.data?.current ?? k.json?.data ?? {};
            const mine = sample.filter((r) => {
                const o = shadows.get(String(r.invoice_number));
                if (!o) return false;
                if (o.status === 'cancelled') return false;     // void
                const d = String(o.created_at).slice(0, 10);
                return d >= from && d <= to;
            });
            const sum = round2(mine.reduce((t, r) => t + Number(r.total_incl_gst ?? r.total ?? 0), 0));
            const beRev = Number(cur.invoice_revenue ?? 0);
            const beCnt = Number(cur.invoice_orders ?? 0);
            const delta = round2(sum - beRev);
            checked++;
            if (Math.abs(delta) <= 0.01 && mine.length === beCnt) {
                ok(`${from}..${to}  ${mine.length} invoices, $${sum} == invoice_revenue`);
            } else {
                bad(`${from}..${to} reconciles`,
                    `ours ${mine.length}/$${sum} vs backend ${beCnt}/$${beRev} (delta $${delta}). `
                    + 'The deduction MUST refuse to adjust a period that does not reconcile — '
                    + 'subtracting an amount the backend never added corrupts the dashboard.');
            }
        }
        if (!checked) skip('per-period reconciliation', 'kpi-summary answered no window');
    }

    // ---- 2. which status values actually exist ------------------------------
    console.log('\n\x1b[1m2. Status vocabulary in the wild\x1b[0m');
    {
        const counts = new Map();
        for (const r of sample) counts.set(r.status ?? '(null)', (counts.get(r.status ?? '(null)') || 0) + 1);
        for (const [s, n] of [...counts].sort()) console.log(`      ${String(s).padEnd(10)} ${n}`);
        // The page's dropdown offers only paid/unpaid/void, but INVOICE_STATUSES
        // (js/admin/api.js:86) includes 'draft'. A draft is UNPAID and must be
        // deducted too — but only if it exists.
        const draftQ = await get('/api/admin/invoices?page=1&limit=5&status=draft');
        const drafts = rowsOf(draftQ.json?.data);
        if (draftQ.status !== 200) {
            soft('status=draft query', `HTTP ${draftQ.status} — treat drafts as unreachable and deduct unpaid only`);
        } else if (drafts.length) {
            soft(`status=draft returns ${drafts.length} row(s)`,
                 'drafts exist and are unpaid — the deduction and the outstanding box must include them');
        } else {
            ok('status=draft returns 0 rows — unpaid alone covers the unrealised set');
        }
        const unpaidQ = await get('/api/admin/invoices?page=1&limit=1&status=unpaid');
        if (unpaidQ.status === 200) ok('status=unpaid filter answers 200');
        else bad('status=unpaid filter', `HTTP ${unpaidQ.status} — the outstanding box has no cheap query`);
    }

    // ---- 3. how big is the book, and what limit can we ask for? -------------
    console.log('\n\x1b[1m3. Row count and max usable limit (bounds the paging loop)\x1b[0m');
    {
        const pag = first.json?.data?.pagination
            ?? (first.json?.data?.total != null ? { total: first.json.data.total } : null);
        if (pag?.total != null) {
            ok(`pagination.total = ${pag.total} invoices`);
        } else {
            soft('pagination.total', 'absent — the paging loop cannot know when it is done except by an empty page');
        }
        const unpaidAll = await get('/api/admin/invoices?page=1&limit=1&status=unpaid');
        const upag = unpaidAll.json?.data?.pagination;
        if (upag?.total != null) console.log(`      unpaid: ${upag.total}`);

        for (const lim of [100, 200, 500]) {
            const r = await get(`/api/admin/invoices?page=1&limit=${lim}`);
            const n = rowsOf(r.json?.data).length;
            if (r.status !== 200) { soft(`limit=${lim}`, `HTTP ${r.status} — capped below this`); break; }
            console.log(`      limit=${lim} → ${n} rows`);
            if (n < lim && pag?.total > n) { soft(`limit=${lim} is silently capped at ${n}`, 'size the paging loop to the real cap, not the requested one'); break; }
        }
    }

    // ---- 4. the anti-double-count breadcrumbs on kpi-summary ---------------
    console.log('\n\x1b[1m4. kpi-summary provenance (the deduction\'s ceiling check)\x1b[0m');
    {
        // The route requires an explicit window — a bare call is a 400. Mirrors
        // analyticsQuery() in js/admin/api.js:218 (from/to → date_from/date_to).
        const to = new Date().toISOString().slice(0, 10);
        const from = '2020-01-01';
        const r = await get(`/api/admin/analytics/kpi-summary?date_from=${from}&date_to=${to}`);
        if (r.status !== 200) {
            bad('GET /api/admin/analytics/kpi-summary', `HTTP ${r.status} — guard #1 and the ceiling check have no input\n      ${r.text.slice(0, 160)}`);
        } else {
            const cur = r.json?.data?.kpis?.current ?? r.json?.data?.current ?? r.json?.data ?? {};
            const inc = cur.includes_invoices;
            if (inc === true) {
                ok('includes_invoices === true — the backend counts invoices, so there is something to deduct');
            } else {
                bad('includes_invoices === true',
                    `got ${JSON.stringify(inc)} — if the backend is NOT counting invoices there is nothing `
                    + 'to remove and the deduction must refuse (guard #1), not silently subtract twice');
            }
            for (const k of ['invoice_revenue', 'invoice_orders']) {
                if (cur[k] == null) soft(`${k} is ${JSON.stringify(cur[k])}`, 'the ceiling check degrades to "no ceiling" — the deduction must say so rather than assume one');
                else ok(`${k} = ${cur[k]}`);
            }
            console.log(`      revenue=${cur.revenue} gross_profit=${cur.gross_profit} net_profit=${cur.net_profit} orders=${cur.orders}`);
            if (cur.gross_profit == null || cur.net_profit == null) {
                soft('gross_profit / net_profit are null on kpi-summary',
                     'ERR-074 — recoverProfitFromSeries rebuilds these from the backend\'s own series. '
                     + 'The deduction applies to ITS output, downstream, never interleaved with it.');
            }
        }
    }

    // ---- 5. is total_incl_gst trustworthy as the deduction's input? --------
    console.log('\n\x1b[1m5. total_incl_gst sanity (the figure we subtract)\x1b[0m');
    {
        const withTotal = sample.filter(r => Number.isFinite(Number(r.total_incl_gst ?? r.total)));
        if (!withTotal.length) {
            bad('rows carry a numeric total', 'none did — the deduction has no input');
        } else {
            ok(`${withTotal.length}/${sample.length} rows carry a numeric total`);
            const neg = withTotal.filter(r => Number(r.total_incl_gst ?? r.total) < 0);
            if (neg.length) soft(`${neg.length} row(s) have a NEGATIVE total`,
                'credits/returns are legal (ERR-181/186) — the deduction must handle a negative, never floor it');
            // errors.md:355 — the LIST endpoint floors a negative supplier cost while
            // the DETAIL endpoint stores it. Confirm that defect is on cost, not total.
            const costFloored = sample.filter(r => r.cost_excl_gst === 0).length;
            const costNull = sample.filter(r => r.cost_excl_gst === null).length;
            console.log(`      cost_excl_gst: ${costFloored} exactly 0, ${costNull} null (null = UNKNOWN, never 0 — ERR-068)`);

            // Cross-check the two ways of getting an invoice's ex-GST revenue.
            // The deduction uses total x 20/23; normalizeInvoice re-derives
            // profit + cost. They must agree, or one of them is wrong.
            let checked = 0, disagreed = 0;
            for (const r of sample) {
                const total = Number(r.total_incl_gst ?? r.total);
                const p = r.profit_excl_gst, c = r.cost_excl_gst;
                if (!Number.isFinite(total) || p == null || c == null) continue;
                checked++;
                const a = round2(total * EX);
                const b = round2(Number(p) + Number(c));
                if (Math.abs(a - b) > 0.02) {
                    disagreed++;
                    if (disagreed <= 3) console.log(`      #${r.invoice_number}: total x20/23=${a} vs profit+cost=${b}`);
                }
            }
            if (!checked) {
                skip('ex-GST revenue cross-check', 'no row carried BOTH a total and a known profit+cost');
            } else if (disagreed) {
                soft(`${disagreed}/${checked} rows: total x 20/23 != profit + cost`,
                     'the two ex-GST revenue derivations disagree. Prefer total x 20/23 (the money is '
                     + 'authoritative) and treat the gap as a backend cost defect, but do not average them.');
            } else {
                ok(`${checked}/${checked} rows: total x 20/23 == profit + cost (the ERR-111 basis holds)`);
            }
        }
    }

    // ---- 6. what this probe deliberately does not do ------------------------
    console.log('\n\x1b[1m6. Not checked here\x1b[0m');
    skip('flipping a PAID slider end-to-end',
         'PATCH /:id/status is CORS-blocked in a browser (BF-021) so the PUT fallback is what '
         + 'actually runs, and a PUT rewrites a legal document. Verify by hand in the admin UI.');
    skip('whether the dashboard\'s adjusted figures are correct',
         'that is arithmetic over this data and is unit-tested in '
         + 'tests/dashboard-invoice-cash-basis-sep2026.test.js');

    // ---- summary -----------------------------------------------------------
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`\x1b[1mMODE: READ-ONLY\x1b[0m — nothing was written by this run.`);
    console.log(`${pass} passed, ${failures.length} failed, ${notes.length} note(s).`);
    if (notes.length) {
        console.log('\nNotes (do not fail the run):');
        for (const n of notes) console.log(`  ~ ${n}`);
    }
    if (failures.length) {
        console.log('\n\x1b[31mFailures:\x1b[0m');
        for (const f of failures) console.log(`  ✗ ${f}`);
        process.exit(1);
    }
    console.log('\n\x1b[32mAll hard checks passed.\x1b[0m');
    process.exit(0);
}

main().catch((e) => { console.error('Probe could not run:', e.message); process.exit(2); });
