#!/usr/bin/env node
/**
 * probe-invoice-sent.mjs — assert the LIVE shape the Orders page's
 * "Invoice sent" column reads, and report whether the backend has started
 * stamping sends yet
 * =====================================================================
 *
 * The column answers "when did this customer's invoice last go out?" from two
 * places, neither of which is on the order payload:
 *
 *   public.invoices.emailed_at   the server's own record. Wins when present.
 *   order_events (note + marker)  the resends fired from the admin Orders page.
 *
 * As of 2026-08-28 `emailed_at` is NULL on all 126 rows — the column exists but
 * NOTHING writes it, including the invoice email sent automatically at checkout.
 * That is the subject of readfirst/order-invoice-emailed-at-backend-brief-aug2026.md
 * (BF-046). Until it lands, every order honestly reads "Not recorded".
 *
 * A unit test cannot notice any of this. It reads source, not production. This
 * probe checks the things that would silently darken the column:
 *   - the exact SELECT the frontend issues still returns 200 (an unknown column
 *     is a hard 400 from PostgREST, and the whole column would go blank)
 *   - the columns we deliberately DON'T select are still not there (they belong
 *     to admin_invoices, a DIFFERENT table — selecting them 400s)
 *   - order_events is still readable, and WHICH `type` values exist in the wild
 *   - **how many invoices carry a send stamp** — the single number the backend
 *     brief is asking to move. 0 today; when it climbs, the handoff has landed
 *     and the Supabase read here can eventually be retired.
 *   - and, for the OTHER invoice system, whether any admin_invoice has ever been
 *     sent more than once. The Invoicing page's ×N marker had never rendered in
 *     production, which is exactly the condition under which a counter can be
 *     wrong for a month without anyone noticing.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. There is no --record / --update-baseline mode and this
 * writes nothing, anywhere. That is deliberate: a probe that can record may pass
 * because it just overwrote what it was comparing against (sweep:b2b ate a
 * committed fixture, 2026-08-12). The mode is PRINTED on every run so it can
 * never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:invoice-sent      (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 * Exit:   0 = every hard check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const BASE = 'https://ink-backend-zaeq.onrender.com';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** The exact column list js/admin/api.js selects. Kept in lockstep on purpose. */
const FE_COLUMNS = 'id,order_id,invoice_number,invoice_date,emailed_at';
/** admin_invoices columns that are NOT on public.invoices — selecting one 400s. */
const FOREIGN_COLUMNS = ['emailed_to', 'email_count', 'last_emailed_at', 'status'];

const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };

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
    console.log('\n\x1b[1mprobe-invoice-sent\x1b[0m — "Invoice sent" column, live shape');
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
        process.exit(2);
    }
    const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}` };
    const rest = (q, extra = {}) => fetch(`${SUPABASE}/rest/v1/${q}`, { headers: { ...H, ...extra } });

    // ---- 1. the frontend's exact select still works -------------------------
    console.log('\x1b[1m1. The SELECT the Orders page issues\x1b[0m');
    {
        const r = await rest(`invoices?select=${FE_COLUMNS}&limit=5`);
        if (r.status !== 200) {
            bad('invoices select returns 200', `got ${r.status} — the column would render "Can't check" for every order`);
        } else {
            const rows = await r.json();
            ok(`invoices?select=${FE_COLUMNS} → 200 (${rows.length} rows)`);
            const missing = rows.length
                ? FE_COLUMNS.split(',').filter(c => !(c in rows[0]))
                : FE_COLUMNS.split(',');
            if (rows.length && missing.length) bad('every selected column is present', `absent: ${missing.join(', ')}`);
            else if (rows.length) ok('every selected column is present on the row');
            const linked = rows.filter(x => x.order_id).length;
            if (rows.length && linked !== rows.length) {
                soft('every invoice links to an order', `${rows.length - linked}/${rows.length} have a null order_id — those orders can never resolve a send date`);
            } else if (rows.length) ok('every sampled invoice carries an order_id');
        }
    }

    // ---- 2. the columns we must NOT select ---------------------------------
    console.log('\n\x1b[1m2. Guard: admin_invoices columns are not on public.invoices\x1b[0m');
    for (const col of FOREIGN_COLUMNS) {
        const r = await rest(`invoices?select=${col}&limit=1`);
        if (r.status === 400) {
            ok(`invoices.${col} is correctly NOT a column (400)`);
        } else if (r.status === 200) {
            soft(`invoices.${col} now EXISTS`, 'the schema grew — worth reading before widening the frontend select');
        } else {
            soft(`invoices.${col} probe inconclusive`, `status ${r.status}`);
        }
    }

    // ---- 3. order_events readable, and which types exist -------------------
    console.log('\n\x1b[1m3. order_events (where our own resend records live)\x1b[0m');
    {
        const r = await rest('order_events?select=order_id,type,created_at,payload&limit=500');
        if (r.status !== 200) {
            bad('order_events is readable', `got ${r.status} — resends recorded from the admin would be invisible`);
        } else {
            const rows = await r.json();
            ok(`order_events readable (${rows.length} rows sampled)`);
            const types = [...new Set(rows.map(x => x.type))].sort();
            console.log(`      types in the wild: ${types.join(', ') || '(none)'}`);
            const marked = rows.filter(x =>
                x?.payload?.kind === 'invoice_sent'
                || (typeof x?.payload?.note === 'string' && x.payload.note.startsWith('[invoice-sent]')));
            console.log(`      invoice-send records written by the admin: ${marked.length}`);
            if (types.includes('invoice_sent')) {
                soft('a real `invoice_sent` event type now exists',
                     'the backend enum grew — the frontend can stop writing these as notes');
            }
        }
    }

    // ---- 4. THE HEADLINE NUMBER -------------------------------------------
    console.log('\n\x1b[1m4. Has the backend started stamping sends?\x1b[0m');
    {
        const total = await rest('invoices?select=id', { Prefer: 'count=exact', Range: '0-0' });
        const stamped = await rest('invoices?select=id&emailed_at=not.is.null', { Prefer: 'count=exact', Range: '0-0' });
        const countOf = (resp) => {
            const cr = resp.headers.get('content-range') || '';
            const n = cr.split('/')[1];
            return n === '*' ? 0 : Number(n);
        };
        const m = countOf(total);
        const n = countOf(stamped);
        console.log(`      \x1b[1m${n} of ${m}\x1b[0m invoices carry a send stamp (emailed_at)`);
        if (n === 0) {
            soft('emailed_at is stamped by the backend',
                 `still 0 of ${m}. The automatic checkout email is not recorded, so every order reads `
                 + '"Not recorded" — correct, but blank. This is BF-046: '
                 + 'readfirst/order-invoice-emailed-at-backend-brief-aug2026.md');
        } else {
            ok(`the backend is stamping sends (${n} of ${m}) — BF-046 has landed, at least in part`);
        }
    }

    // ---- 5. watchdog: has the field reached the order payload? -------------
    console.log('\n\x1b[1m5. Watchdog: is a send field on the order payload yet?\x1b[0m');
    {
        const r = await fetch(`${BASE}/api/admin/orders?page=1&limit=1`, { headers: H });
        const body = await r.json().catch(() => null);
        const row = (body?.data?.orders || body?.data || [])[0];
        if (!row) {
            soft('order list payload readable', `status ${r.status} — could not sample a row`);
        } else {
            const found = ['invoice_emailed_at', 'emailed_at', 'invoice_email_count', 'invoice_number']
                .filter(k => k in row);
            if (found.length) {
                soft('the order payload now carries invoice-send fields',
                     `${found.join(', ')} — §4 of the brief has landed; the Supabase read in `
                     + 'AdminAPI.getOrderInvoicesByOrderIds can be retired');
            } else {
                ok('order rows still carry no send field (expected today — the column reads Supabase directly)');
            }
        }
    }

    // ---- 6. the OTHER invoice system: the Invoicing page's SENT column -----
    //
    // admin_invoices is a DIFFERENT table with a DIFFERENT send record, and the
    // Invoicing page's SENT column reads it. It is checked here rather than in a
    // probe of its own because the one mistake worth catching is confusing the
    // two, and that is easiest to see side by side.
    //
    // The table is not readable over PostgREST at all (RLS: 0 rows to an admin
    // JWT, and emailed_at/email_count are not even columns of what that name
    // resolves to) — the fields come off the API's list response instead. So the
    // check is: does /api/admin/invoices still carry them, and has any invoice
    // ever actually been sent more than once? A ×N that has never once rendered
    // in production is a feature nobody has seen work.
    console.log('\n\x1b[1m6. The OTHER system: admin_invoices (the Invoicing page)\x1b[0m');
    {
        const r = await fetch(`${BASE}/api/admin/invoices?page=1&limit=100`, { headers: H });
        const body = await r.json().catch(() => null);
        const rows = body?.data?.invoices || (Array.isArray(body?.data) ? body.data : []);
        if (r.status !== 200 || !Array.isArray(rows) || !rows.length) {
            soft('/api/admin/invoices sampled', `status ${r.status} — could not sample the SENT column's source`);
        } else {
            const miss = ['emailed_at', 'email_count'].filter(k => !(k in rows[0]));
            if (miss.length) {
                bad('the list row still carries emailed_at + email_count',
                    `absent: ${miss.join(', ')} — the SENT column would go blank for every invoice`);
            } else {
                ok(`/api/admin/invoices rows carry emailed_at + email_count (${rows.length} sampled)`);
            }
            const stamped = rows.filter(x => x.emailed_at).length;
            const counted = rows.filter(x => num(x.email_count) > 0).length;
            const resent = rows.filter(x => num(x.email_count) > 1).length;
            // A real emailed_at next to email_count 0 is a send that predates the
            // log table. The frontend treats that as "at least one, count
            // unknown" — a FLOOR — rather than zero. If this number is ever 0,
            // the legacy branch is dead code and can go.
            const legacy = rows.filter(x => x.emailed_at && num(x.email_count) === 0).length;
            console.log(`      \x1b[1m${stamped}\x1b[0m of ${rows.length} sent · ${counted} with a logged count `
                        + `· \x1b[1m${legacy}\x1b[0m legacy (a date but email_count 0)`);
            console.log(`      invoices sent MORE THAN ONCE: \x1b[1m${resent}\x1b[0m`);
            if (!resent) {
                soft('an invoice has been sent more than once',
                     'still 0 — the SENT column\'s ×N has never rendered in production. '
                     + 'Not a fault: nothing has been resent yet. Worth re-reading the day it is.');
            } else {
                ok(`${resent} invoice(s) carry email_count > 1 — the ×N marker has live data`);
            }
            if (legacy) {
                soft(`${legacy} invoice(s) have a send date with email_count 0`,
                     'sends that predate the log table. The frontend reports these as a FLOOR '
                     + '("1 recorded send or more") and carries them across a resend, which the '
                     + 'server count alone cannot do — see tests/admin-invoice-send-count-aug2026.test.js');
            }
        }
    }

    // ---- 7. the one thing this probe refuses to do -------------------------
    console.log('\n\x1b[1m7. Not checked here\x1b[0m');
    skip('POST /api/admin/orders/:id/resend-invoice response shape',
         'exercising it would send a real invoice email to a real customer. '
         + 'Verify by hand from the admin UI against a test order.');
    skip('POST /api/admin/invoices/:id/email (the Invoicing page\'s send)',
         'same reason — it emails a real customer. The send COUNT is unit-tested '
         + 'instead: tests/admin-invoice-send-count-aug2026.test.js');

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
