#!/usr/bin/env node
/**
 * probe-orders-invoice-sent.mjs — WHICH REGIME is the Orders "Invoice sent"
 * column actually answering under, and is the fallback still sound?
 * =====================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-01 the backend handed over
 * `readfirst/orders-invoice-sent-column-FE-handoff-sep2026.md`, which opens
 * "**FE action required.** The backend now tells you, per order row, whether the
 * 'Invoice sent' column applies at all… Shipped in `GET /api/admin/orders`."
 *
 * Run against live production the same day — backend `/health` reporting commit
 * 01c29cba and `db: connected` — `channel`, `invoice_id` and `invoice_sent` were
 * ABSENT from every row of the list AND of the detail endpoint, under every
 * opt-in param tried. `?channel=` is worse than absent: it is accepted and
 * ignored, returning the complete unfiltered set for `zzznope` (the ERR-151 /
 * ERR-173 decoy family, where the request looks filtered, rows come back, the
 * page repaints, and every row is wrong).
 *
 * No unit test can see any of that. It reads source, not production. And the
 * frontend cannot see it either: the fallback renders a completely plausible
 * cell, so a column silently answering from the weaker of two sources looks
 * exactly like one answering from the stronger. This probe is the only thing in
 * the repo that can say which.
 *
 * A green run here is the evidence for the sentence "the Invoice sent column is
 * reading the backend's own answer today". A yellow run is the evidence for
 * "it is still on the fallback, and here is what the fallback cannot see".
 *
 * WHAT IT MEASURES
 * ----------------
 *   1  THE HEADLINE — are the three fields on the payload yet? (the regime)
 *   2  Is the fallback ladder still sound? payment_method vs the INV- prefix,
 *      across every page. 146 of 146 with zero disagreements on 2026-09-01.
 *   3  Is `?channel=` still a decoy? (it must never be trusted as a filter)
 *   4  Does live data exist for each render branch — never sent, legacy stamp,
 *      counted, and RESENT? A branch with no live data has never been seen work.
 *   5  THE GAP `invoice_id` WOULD CLOSE — invoice-channel orders whose invoice
 *      was demonstrably emailed from the Invoices page, which this column cannot
 *      see. This is the number the handoff exists to fix.
 *   6  BF-046 watchdog — has anything started stamping public.invoices.emailed_at?
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * Join an order to an invoice by parsing `INV-3277` into invoice number 3277.
 * It works on all 15 live rows and it is still refused: handoff Rule 2 forbids
 * deriving identity from the order number, and `public.invoices` and
 * `admin_invoices` are two systems this repo has a standing rule never to
 * conflate. §5 REPORTS the gap rather than papering over it, because a number
 * the backend can close is worth more than a guess the frontend can make.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET except the admin sign-in. There is no --record /
 * --update-baseline mode and this writes nothing, anywhere. That is deliberate:
 * a probe that can record may pass because it just overwrote what it was
 * comparing against (sweep:b2b ate a committed fixture, 2026-08-12). The mode is
 * PRINTED on every run so it can never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:orders-invoice-sent   (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** The three fields the handoff says ship on every order row. */
const HANDOFF_FIELDS = ['channel', 'invoice_id', 'invoice_sent'];
/** A channel value no backend can plausibly honour. Proves the param is a decoy. */
const NONSENSE_CHANNEL = 'zzznope';
const PAGE_LIMIT = 50;
const MAX_PAGES = 12;

const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/**
 * A real gap worth reporting that the frontend already handles correctly, so it
 * must NOT redden the exit code. If a soft note could fail the run, the run gets
 * ignored — and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
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

/**
 * Load the SHIPPED channel derivation rather than re-implementing it.
 *
 * The whole point of §2 is "does the ladder the frontend actually uses still
 * agree with the order numbers?". A copy of that ladder in this file would drift
 * from the page and start certifying something nobody ships. Same rule, same
 * reason, as probe-lookalike-rows.mjs loading ProductIdentity out of utils.js.
 */
function loadShippedChannel() {
    const file = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'order-profit.js');
    if (!fs.existsSync(file)) return null;
    const src = fs.readFileSync(file, 'utf8')
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/export\s+(const|let|var|function|class)\s+/gm, '$1 ');
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Math, Number, Object, Array, String, Boolean, JSON, Date, RegExp, Error,
        DebugLog: { warn() {}, log() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try {
        vm.runInContext(src + '\n;this.__ch = typeof orderChannel === "function" ? orderChannel : null;',
            sandbox, { filename: 'order-profit.js' });
    } catch { return null; }
    return sandbox.__ch || null;
}

async function main() {
    console.log('\n\x1b[1mprobe-orders-invoice-sent\x1b[0m — which regime is the Invoice sent column answering under?');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only besides the sign-in; no --record mode exists, nothing is written)\n');

    const env = readEnv();
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    if (!email || !password) {
        // A skip is not a pass. Exit 2 and name the variable that is missing.
        console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
        console.error('These must be a super_admin — the admin orders endpoints 403 for anyone else.');
        console.error('Nothing was verified. Do NOT read this as a pass.\n');
        process.exit(2);
    }

    const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const session = await auth.json();
    if (!session.access_token) {
        console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (${auth.status}). Nothing was verified.\n`);
        process.exit(2);
    }
    const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}` };
    const get = async (p) => {
        const res = await fetch(BASE + p, { headers: H });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: res.status, json, text };
    };
    // PostgREST only reports a total when it is ASKED to. Without
    // `Prefer: count=exact` the Content-Range is `0-0/*` and a naive read of it
    // prints "0 of 0" — a fabricated denominator, which is worse than no number.
    const rest = (q, extra = {}) => fetch(`${SUPABASE}/rest/v1/${q}`, { headers: { ...H, ...extra } });
    const COUNTED = { Prefer: 'count=exact', Range: '0-0' };
    const countOf = (resp) => {
      const total = (resp.headers.get('content-range') || '').split('/')[1];
      return total && total !== '*' ? Number(total) : null;   // null = NOT ZERO, unknown
    };
    // `/api/admin/orders` returns `data` as a BARE ARRAY; customers/contacts do
    // not (ERR-176). Normalise the same way the page does rather than assuming.
    const rowsOf = (j) => {
        const d = j?.data;
        return Array.isArray(d) ? d : (d?.orders || d?.invoices || d?.items || []);
    };
    console.log(`Signed in as ${email}\n`);

    // ---- 1. THE HEADLINE: which regime is live? ---------------------------
    console.log('\x1b[1m1. Are the handoff\'s three fields on the order payload?\x1b[0m');
    let regime = 'LOCAL';
    let firstPage = [];
    {
        const r = await get(`/api/admin/orders?page=1&limit=${PAGE_LIMIT}`);
        if (r.status !== 200) {
            bad('GET /api/admin/orders returns 200', `got ${r.status} — nothing below could be measured`);
            console.error('\nCannot continue without the order list.\n');
            process.exit(2);
        }
        firstPage = rowsOf(r.json);
        const present = HANDOFF_FIELDS.filter(f => firstPage.some(o => Object.prototype.hasOwnProperty.call(o, f)));
        const absent = HANDOFF_FIELDS.filter(f => !present.includes(f));

        if (present.includes('invoice_sent')) {
            regime = 'SERVER';
            ok('`invoice_sent` is on the payload', `regime is \x1b[1mSERVER\x1b[0m — the column reads the backend's own answer`);
            if (absent.length) {
                soft('not all three fields shipped', `present: ${present.join(', ')} · absent: ${absent.join(', ')}. `
                    + 'The column gates on invoice_sent alone so it still works, but the Channel badge falls '
                    + 'back to payment_method without `channel`.');
            } else {
                ok('all three fields present', HANDOFF_FIELDS.join(', '));
            }
            const applicable = firstPage.filter(o => o.invoice_sent !== null && o.invoice_sent !== undefined);
            console.log(`      of ${firstPage.length} rows, \x1b[1m${applicable.length}\x1b[0m carry a non-null invoice_sent`);
            // The whole point of the handoff. If every row is applicable, the
            // channel rule is not being applied server-side after all.
            if (applicable.length === firstPage.length && firstPage.length > 2) {
                bad('the backend applied the channel rule',
                    `EVERY one of ${firstPage.length} rows has a non-null invoice_sent. The column would print `
                    + 'an outstanding task on every website checkout — the exact noise this change removes.');
            } else {
                ok('the channel rule is applied server-side',
                    `${firstPage.length - applicable.length} of ${firstPage.length} rows are correctly not-applicable`);
            }
        } else {
            // NOT a hard failure: the frontend handles this correctly and says so
            // out loud. It IS the single most important line of the run.
            soft('the handoff\'s fields have NOT shipped',
                `absent from every row: ${absent.join(', ')}.\n`
                + 'The Orders column is on its FALLBACK regime: the channel rule is answered from\n'
                + '`payment_method`, and the send record from public.invoices + order_events. That\n'
                + 'fallback CANNOT see a send made from the Invoices page (see §5).\n'
                + 'The handoff says "Shipped in GET /api/admin/orders" — measured here, it is not.');
        }
        const health = await get('/health');
        const commit = health.json?.data?.commit;
        console.log(`      backend commit: ${commit ? commit.slice(0, 10) : '(unreported)'} · db: ${health.json?.data?.db || '?'}`);
        console.log(`      \x1b[1mREGIME: ${regime}\x1b[0m`);
    }

    // ---- 2. Is the fallback ladder still sound? ---------------------------
    console.log('\n\x1b[1m2. The fallback: does payment_method still agree with the order numbers?\x1b[0m');
    const orderChannel = loadShippedChannel();
    let allOrders = [];
    {
        for (let p = 1; p <= MAX_PAGES; p++) {
            const r = await get(`/api/admin/orders?page=${p}&limit=${PAGE_LIMIT}`);
            const rows = rowsOf(r.json);
            if (r.status !== 200 || !rows.length) break;
            allOrders = allOrders.concat(rows);
            if (rows.length < PAGE_LIMIT) break;
        }
        console.log(`      walked \x1b[1m${allOrders.length}\x1b[0m orders`);

        if (!orderChannel) {
            // A derivation we could not load is a check that did not run.
            skip('payment_method vs INV- prefix',
                'could not evaluate orderChannel() out of js/admin/utils/order-profit.js. '
                + 'The ladder was NOT verified — do not read this section as a pass.');
        } else if (!allOrders.length) {
            skip('payment_method vs INV- prefix', 'no orders came back; nothing to compare.');
        } else {
            const prefix = (o) => /^INV-/i.test(String(o.order_number || ''));
            const disagree = allOrders.filter(o => (orderChannel(o) === 'invoice') !== prefix(o));
            const invoiceRows = allOrders.filter(o => orderChannel(o) === 'invoice');
            console.log(`      the shipped ladder calls \x1b[1m${invoiceRows.length}\x1b[0m of them invoiced sales`);
            if (disagree.length) {
                // Under LOCAL this decides whether a row's column is blanked, so a
                // disagreement is a row we may be blanking wrongly.
                const detail = disagree.slice(0, 8)
                    .map(o => `${o.order_number} (payment_method=${JSON.stringify(o.payment_method)}, channel=${JSON.stringify(o.channel)})`)
                    .join('\n');
                if (regime === 'SERVER') {
                    soft(`${disagree.length} order(s) where the ladder and the number prefix disagree`,
                        `harmless under the SERVER regime (the ladder is not consulted), but it is what the\n`
                        + `fallback would rely on if the backend rolled back:\n${detail}`);
                } else {
                    bad(`${disagree.length} order(s) where the ladder and the number prefix disagree`,
                        `the fallback decides which rows the column applies to, so each of these is a row\n`
                        + `that may be blanked or not-blanked wrongly:\n${detail}`);
                }
            } else {
                ok('every order agrees', `${allOrders.length} of ${allOrders.length}, zero disagreements`);
            }
            const noSignal = allOrders.filter(o => !o.channel && !o.payment_method && prefix(o));
            if (noSignal.length) {
                soft(`${noSignal.length} INV- order(s) carry neither channel nor payment_method`,
                    'the ladder falls through to the order-number prefix for these, which is the weakest rung.');
            }
        }
    }

    // ---- 3. Is ?channel= a decoy? ----------------------------------------
    console.log('\n\x1b[1m3. Is `?channel=` a real filter, or accepted and ignored?\x1b[0m');
    {
        const baseline = await get(`/api/admin/orders?page=1&limit=${PAGE_LIMIT}`);
        const nRows = rowsOf(baseline.json).length;
        const results = {};
        for (const v of ['invoice', 'web', 'quick_order', NONSENSE_CHANNEL]) {
            const r = await get(`/api/admin/orders?page=1&limit=${PAGE_LIMIT}&channel=${v}`);
            results[v] = { status: r.status, n: rowsOf(r.json).length };
        }
        const nonsense = results[NONSENSE_CHANNEL];
        console.log(`      baseline ${nRows} rows · `
            + Object.entries(results).map(([k, v]) => `${k}=${v.n}`).join(' · '));
        if (nonsense.n >= nRows && nonsense.status === 200) {
            // Reported, never relied on. The frontend passes no `channel` param.
            soft('`?channel=` is a DECOY',
                `channel=${NONSENSE_CHANNEL} returns ${nonsense.n} of ${nRows} rows — accepted, ignored, `
                + 'full set returned (the ERR-151/173 family). The frontend must never send it as a filter, '
                + 'and never read a filtered-looking response as filtered.');
        } else if (nonsense.status >= 400) {
            ok('`?channel=` validates its input', `nonsense value → ${nonsense.status}`);
        } else {
            ok('`?channel=` appears to filter', `nonsense value returned ${nonsense.n} of ${nRows}`);
        }
        // Whatever it does, the page must not be sending it.
        const apiSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');
        if (/params\.set\(\s*['"]channel['"]/.test(apiSrc)) {
            bad('the frontend does not send `channel=`',
                'js/admin/api.js sets a `channel` param on the orders request. A decoy that reaches the URL '
                + 'returns a full table that looks filtered.');
        } else {
            ok('the frontend never sends `channel=`');
        }
    }

    // ---- 4. Does live data exist for each render branch? ------------------
    //
    // A branch with no live data has never been seen work. `×N` had shipped a
    // month, had a passing unit test, and was unreachable in the case that
    // mattered (ERR-180). So count the rows before believing a feature works.
    console.log('\n\x1b[1m4. Live data behind each render branch\x1b[0m');
    let invoices = [];
    {
        for (let p = 1; p <= MAX_PAGES; p++) {
            const r = await get(`/api/admin/invoices?page=${p}&limit=${PAGE_LIMIT}`);
            const rows = rowsOf(r.json);
            if (r.status !== 200 || !rows.length) break;
            invoices = invoices.concat(rows);
            if (rows.length < PAGE_LIMIT) break;
        }
        if (!invoices.length) {
            skip('render-branch coverage', '/api/admin/invoices returned no rows; nothing to count.');
        } else {
            const sent = invoices.filter(i => i.emailed_at);
            const legacy = invoices.filter(i => i.emailed_at && num(i.email_count) === 0);
            const counted = invoices.filter(i => num(i.email_count) > 0);
            const resent = invoices.filter(i => num(i.email_count) > 1);
            const never = invoices.filter(i => !i.emailed_at);
            console.log(`      ${invoices.length} invoices · \x1b[1m${never.length}\x1b[0m never sent`
                + ` · \x1b[1m${legacy.length}\x1b[0m legacy stamp (a date, count 0)`
                + ` · \x1b[1m${counted.length}\x1b[0m counted · \x1b[1m${resent.length}\x1b[0m resent`);
            const branches = [
                ['"Not sent" (never emailed)', never.length],
                ['a date with NO ×N (legacy stamp — count unknown)', legacy.length],
                ['a date with a real tally', counted.length],
                ['×N (sent more than once)', resent.length],
            ];
            for (const [label, n] of branches) {
                if (n > 0) ok(`live data exists for ${label}`, `${n} invoice(s)`);
                else soft(`NO live data for ${label}`,
                    'this branch has never rendered in production. Not a fault — but it is untested '
                    + 'by anything except the unit tests until it does.');
            }
            if (legacy.length) {
                ok('the legacy-stamp branch is load-bearing',
                    `${legacy.length} invoice(s) have a send date beside email_count 0 — UNKNOWN, not zero. `
                    + 'The column must show the date and NO ×N for these.');
            }
        }
    }

    // ---- 5. THE GAP invoice_id WOULD CLOSE --------------------------------
    console.log('\n\x1b[1m5. The gap: sends this column cannot see\x1b[0m');
    {
        const invoiceOrders = orderChannel
            ? allOrders.filter(o => orderChannel(o) === 'invoice')
            : allOrders.filter(o => /^INV-/i.test(String(o.order_number || '')));
        const emailedInvoices = invoices.filter(i => i.emailed_at).length;

        if (regime === 'SERVER') {
            ok('the backend answers this column now',
                'sends made from the Invoices page reach it through invoice_sent — the gap below is closed');
        } else if (!invoiceOrders.length || !invoices.length) {
            skip('the Invoices-page gap', 'no invoice-channel orders or no invoices to compare.');
        } else {
            // MEASURED, NOT JOINED. We deliberately do not map INV-<n> onto
            // invoice_number <n> to attribute a send to an order: handoff Rule 2
            // forbids deriving identity from the order number, and public.invoices
            // is not admin_invoices. The two totals are reported side by side and
            // the reader is told exactly what the frontend refuses to infer.
            soft(`${emailedInvoices} invoice(s) have been emailed that this column cannot attribute`,
                `${invoiceOrders.length} invoice-channel orders are in the list, and ${emailedInvoices} of `
                + `${invoices.length} invoices carry an emailed_at — but those sends live in admin_invoices / `
                + 'standalone_invoice_emails, which the Orders page has never read.\n'
                + 'The frontend REFUSES to bridge this by parsing INV-<n> into invoice_number <n>: that is an '
                + 'inference the backend owns (handoff Rule 2), and public.invoices is a different table from '
                + 'admin_invoices.\n'
                + '`invoice_id` on the order row is what closes it. Until then these orders correctly read '
                + '"Not recorded", with a tooltip that says so.');
        }
    }

    // ---- 6. BF-046 watchdog ----------------------------------------------
    console.log('\n\x1b[1m6. BF-046 watchdog — is public.invoices.emailed_at stamped yet?\x1b[0m');
    {
        const total = await rest('invoices?select=id', COUNTED);
        const stamped = await rest('invoices?select=id&emailed_at=not.is.null', COUNTED);
        // A ranged request succeeds as 206 Partial Content, not 200. Treating 206
        // as a failure would have reported this section as unrunnable forever.
        const readable = (r) => r.status === 200 || r.status === 206;
        if (!readable(total) || !readable(stamped)) {
            skip('public.invoices readable', `select returned ${total.status}/${stamped.status}; the fallback's server half was not checked.`);
        } else if (countOf(total) === null || countOf(stamped) === null) {
            // A denominator we could not read is not a denominator of zero.
            skip('the emailed_at stamp count',
                 'PostgREST did not return a Content-Range total, so the ratio is unknown. '
                 + 'This is NOT "0 stamped".');
        } else {
            const m = countOf(total);
            const n = countOf(stamped);
            console.log(`      \x1b[1m${n} of ${m}\x1b[0m rows carry a send stamp`);
            if (n === 0) {
                soft('emailed_at is stamped by the backend',
                    'still 0. The invoice emailed automatically at checkout is recorded nowhere, so under the '
                    + 'fallback regime only resends fired from the Orders page appear. This is BF-046: '
                    + 'readfirst/order-invoice-emailed-at-backend-brief-aug2026.md');
            } else {
                ok(`the backend is stamping sends (${n} rows) — BF-046 has landed, at least in part`);
            }
        }
    }

    // ---- 7. the one thing this probe refuses to do ------------------------
    console.log('\n\x1b[1m7. Not checked here\x1b[0m');
    skip('POST /api/admin/orders/:id/resend-invoice',
         'exercising it would send a real email to a real customer. The resend path is unit-tested '
         + 'instead: tests/admin-orders-invoice-sent-channel-sep2026.test.js §5.');
    // The message has to follow the measurement, not restate what was true when
    // this file was written. A probe that narrates a stale regime is a probe that
    // will one day certify one.
    if (regime === 'SERVER') {
        skip('the LOCAL fallback end to end',
             'the backend is answering, so the fallback path is not exercised by this run. '
             + '§2 above still checks that its channel ladder would be correct if the backend '
             + 'rolled back; the rest of it is pinned by '
             + 'tests/admin-orders-invoice-sent-channel-sep2026.test.js §3.');
    } else {
        skip('the SERVER regime end to end',
             'no live row carries invoice_sent, so its four render branches cannot be exercised '
             + 'against production. They are pinned by '
             + 'tests/admin-orders-invoice-sent-channel-sep2026.test.js §1-§2. '
             + 'Re-run this probe the day §1 above turns green.');
    }

    // ---- summary ----------------------------------------------------------
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`\x1b[1mMODE: READ-ONLY\x1b[0m — nothing was written by this run.`);
    console.log(`\x1b[1mREGIME: ${regime}\x1b[0m — ${regime === 'SERVER'
        ? 'the column reads the backend\'s invoice_sent field.'
        : 'the column is on its fallback; the backend fields have not shipped.'}`);
    console.log(`${pass} passed, ${failures.length} failed, ${notes.length} note(s).`);
    if (notes.length) {
        console.log('\nNotes (do not fail the run):');
        for (const n of notes) console.log(`  ~ ${n.split('\n')[0]}`);
    }
    if (failures.length) {
        console.log('\n\x1b[31mFailures:\x1b[0m');
        for (const f of failures) console.log(`  ✗ ${f.split('\n')[0]}`);
        process.exit(1);
    }
    console.log('\n\x1b[32mAll hard checks passed.\x1b[0m\n');
    process.exit(0);
}

main().catch((e) => { console.error('Probe could not run:', e.message); process.exit(2); });
