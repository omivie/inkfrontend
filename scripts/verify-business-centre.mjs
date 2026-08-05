#!/usr/bin/env node
/**
 * verify-business-centre.mjs — assert the LIVE /api/business/* contract
 * =====================================================================
 *
 * The unit suite pins what the frontend does with a response. Nothing in it can
 * notice that the backend started omitting a field, renamed one, or began
 * returning 0 where it used to return null — and those are the failures that
 * reach a customer as a confident wrong number rather than an error.
 *
 * This walks all six endpoints with a real approved-business token and checks:
 *   - every field the page reads is PRESENT (absent ≠ null ≠ 0)
 *   - the R2 ban holds: no supplier cost / margin / profit on any customer route
 *   - the filters the status dropdown offers are actually accepted
 *   - cross-account access is refused with 403, not 404
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be
 * one URL away from the internet.
 *
 * Usage:  npm run verify:business          (needs BUSINESS_EMAIL / BUSINESS_PASSWORD in .env)
 * Exit:   0 = every check passed, 1 = at least one failed
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** Never allowed on a customer-facing response (brief R2). */
const BANNED = /supplier_cost|cost_excl_gst|profit_excl_gst|profit|margin_percent|cost_source/i;

let pass = 0;
const failures = [];

const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

/**
 * Present and of the right kind. `null` is a legitimate value for every money
 * field (R1: "not reported"); UNDEFINED is not, because an absent key is what
 * the frontend cannot tell apart from zero.
 */
function nullableNumber(obj, key, where) {
    if (!(key in obj)) return bad(`${where}.${key}`, 'ABSENT — omitting a field to mean zero is the R1 violation');
    const v = obj[key];
    if (v === null || typeof v === 'number') return ok(`${where}.${key} = ${v === null ? 'null' : v}`);
    bad(`${where}.${key}`, `expected number|null, got ${typeof v} (${JSON.stringify(v)})`);
}

function readEnv() {
    const file = path.join(ROOT, '.env');
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(
        fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
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

async function main() {
    const env = readEnv();
    const email = process.env.BUSINESS_EMAIL || env.BUSINESS_EMAIL;
    const password = process.env.BUSINESS_PASSWORD || env.BUSINESS_PASSWORD;
    if (!email || !password) {
        console.error('BUSINESS_EMAIL / BUSINESS_PASSWORD not set (.env or environment).');
        process.exit(2);
    }

    const token = await signIn(email, password);
    const get = async (p) => {
        const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* PDF route streams bytes */ }
        return { status: res.status, json, text };
    };

    console.log(`\nBusiness Centre live contract — ${email}\n`);

    // ── §6 account/summary ───────────────────────────────────────────────────
    console.log('§6  GET /api/business/account/summary');
    const summary = await get('/api/business/account/summary');
    check(summary.status === 200, 'responds 200', `got ${summary.status}`);
    const s = summary.json?.data || {};
    for (const k of ['outstanding_balance', 'overdue_balance', 'credit_limit', 'credit_remaining']) {
        nullableNumber(s, k, 'summary');
    }
    for (const k of ['unpaid_invoice_count', 'overdue_invoice_count']) nullableNumber(s, k, 'summary');
    check(!BANNED.test(summary.text), 'no cost/margin field leaks (R2)', 'a banned field appeared');

    // ── §1 analytics/series ──────────────────────────────────────────────────
    console.log('\n§1  GET /api/business/analytics/series');
    const series = await get('/api/business/analytics/series?granularity=month');
    check(series.status === 200, 'responds 200', `got ${series.status}`);
    const d = series.json?.data || {};
    check(Array.isArray(d.points), 'points is an array', `got ${typeof d.points}`);
    check(!!d.coverage && 'orders_missing_discount_breakdown' in d.coverage,
        'coverage.orders_missing_discount_breakdown present (0 is real)',
        'absent — the caveat cannot be trusted to stay hidden');
    check(!!d.coverage && 'orders_counted' in d.coverage,
        'coverage.orders_counted present',
        'absent — the page needs it to tell "no orders" from "ordered, saved nothing"');
    if (d.points?.[0]) {
        for (const k of ['spend_incl_gst', 'b2b_savings', 'other_savings']) nullableNumber(d.points[0], k, 'points[0]');
        check('period_start' in d.points[0], 'points[0].period_start present', 'absent — nothing to plot against');
    }
    for (const k of ['lifetime_spend_incl_gst', 'lifetime_b2b_savings', 'lifetime_other_savings']) {
        nullableNumber(d.totals || {}, k, 'totals');
    }
    check(!BANNED.test(series.text), 'no cost/margin field leaks (R2)', 'a banned field appeared');

    // ── §1b the range + grain the Performance overview depends on ────────────
    // The chart labels its axis from the ECHO, not from what it asked for, and
    // says so on the page when the two differ. These checks are what tell you
    // whether that warning should be firing.
    console.log('\n§1b analytics/series honours from / to / granularity');
    const today = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

    const windowed = await get(`/api/business/analytics/series?from=${yearAgo}&to=${today}&granularity=month`);
    check(windowed.status === 200, 'accepts from/to/granularity', `got ${windowed.status}`);
    const w = windowed.json?.data || {};
    check(w.from === yearAgo && w.to === today,
        'echoes the window it served',
        `asked ${yearAgo}..${today}, got ${w.from}..${w.to} — the page will warn about this`);

    const weekly = await get(`/api/business/analytics/series?from=${yearAgo}&to=${today}&granularity=week`);
    check(weekly.json?.data?.granularity === 'week',
        'honours granularity=week',
        `echoed "${weekly.json?.data?.granularity}" — the page will show the grain-mismatch note`);
    check((weekly.json?.data?.points || []).length > (w.points || []).length,
        'weekly really is a finer grain than monthly',
        'same bucket count at both grains — the parameter is being ignored');

    // NOT a pass/fail — a measurement, and the reason the "All" preset asks for
    // `first_order_at` rather than a wide floor. Probed 2026-08-05, an old
    // `from` is neither clamped nor rejected: it returns one bucket per month
    // since that date, nearly all empty. Any threshold here would just be a
    // number someone invented, so print the count and let the reader judge.
    const wide = await get(`/api/business/analytics/series?from=2000-01-01&to=${today}&granularity=month`);
    console.log(`    note: from=2000-01-01 returns ${(wide.json?.data?.points || []).length} monthly buckets ` +
        '— unclamped, which is why "All" asks for first_order_at instead');

    // OPEN QUESTION for the backend: the brief does not say whether `coverage`
    // is scoped to the requested window or to the account's whole history. The
    // page defends against both (an empty `points` also routes to the empty
    // state), but the answer decides whether that test can be trusted alone.
    const narrow = await get(`/api/business/analytics/series?from=${today}&to=${today}&granularity=month`);
    const narrowCount = narrow.json?.data?.coverage?.orders_counted;
    const wholeCount = d.coverage?.orders_counted;
    console.log(`    note: coverage.orders_counted — one-day window ${narrowCount}, default window ${wholeCount}. ` +
        (wholeCount ? (narrowCount === wholeCount
            ? 'EQUAL ⇒ coverage is NOT window-scoped.'
            : 'DIFFERENT ⇒ coverage IS window-scoped.')
            : 'INCONCLUSIVE while the account has no orders — re-run once it does.'));

    // ── §2 top-products ──────────────────────────────────────────────────────
    console.log('\n§2  GET /api/business/top-products');
    const top = await get('/api/business/top-products?limit=8');
    check(top.status === 200, 'responds 200', `got ${top.status}`);
    check(Array.isArray(top.json?.data?.items), 'items is an array', 'absent array = MALFORMED, not empty');
    const item = top.json?.data?.items?.[0];
    if (item) {
        check(!/^\/html\//.test(item.product_url || ''), 'product_url is not /html/…', item.product_url);
        check(!('price' in item) && !('unit_price' in item),
            'carries NO price (today’s price comes from the live pricing path)',
            'a historical price on this payload would be re-presented as today’s');
    } else {
        console.log('    (no items on this account — field checks skipped)');
    }
    check(!BANNED.test(top.text), 'no cost/margin field leaks (R2)', 'a banned field appeared');

    // ── §3 invoices + the filters the dropdown offers ────────────────────────
    console.log('\n§3  GET /api/business/invoices');
    const list = await get('/api/business/invoices?limit=20&page=1');
    check(list.status === 200, 'responds 200', `got ${list.status}`);
    check(Array.isArray(list.json?.data?.invoices), 'invoices is an array', 'absent = MALFORMED');
    const pg = list.json?.data?.pagination;
    check(!!pg && typeof pg.total === 'number',
        'pagination.total present — the pager depends on it',
        'without it the page cannot say "showing 20 of N" and a cap goes silent');
    check(!BANNED.test(list.text), 'no cost/margin field leaks (R2)', 'a banned field appeared');

    // Every value the status dropdown offers must actually be accepted.
    for (const status of ['unpaid', 'paid', 'overdue', 'void', 'all']) {
        const r = await get(`/api/business/invoices?limit=5&status=${status}`);
        check(r.status === 200, `?status=${status} accepted`, `got ${r.status} — the filter offers it`);
    }

    // ── §4/§5 invoice detail + PDF, when there is one to look at ─────────────
    const first = list.json?.data?.invoices?.[0];
    if (first?.id) {
        console.log('\n§4  GET /api/business/invoices/:id');
        const det = await get(`/api/business/invoices/${encodeURIComponent(first.id)}`);
        check(det.status === 200, 'responds 200', `got ${det.status}`);
        const inv = det.json?.data || {};
        check(Array.isArray(inv.lines), 'lines is an array', 'absent = MALFORMED, not a blank invoice');
        if (inv.lines?.[0]) {
            check('unit_price_excl_gst' in inv.lines[0],
                'lines[].unit_price_excl_gst (the unambiguous customer-facing name)',
                'absent — unit_cost_excl_gst sits one word from supplier_cost_excl_gst');
        }
        check(!BANNED.test(det.text), 'no cost/margin field leaks (R2)', 'a banned field appeared');

        console.log('\n§5  GET /api/business/invoices/:id/pdf');
        const pdf = await get(`/api/business/invoices/${encodeURIComponent(first.id)}/pdf`);
        check([200, 409].includes(pdf.status),
            `stored PDF answers 200 or 409 (got ${pdf.status})`,
            '404 is ambiguous with "no such invoice"; only 409 licenses the stamped local copy');
    } else {
        console.log('\n§4/§5  (no invoices linked to this account — detail and PDF checks skipped)');
        console.log('       This is EXPECTED until an operator can set business_account_id.');
    }

    // ── Ownership ────────────────────────────────────────────────────────────
    console.log('\n§4  cross-account access');
    const other = await get('/api/business/invoices/00000000-0000-4000-8000-000000000000');
    check([403, 404].includes(other.status), `refused (got ${other.status})`, 'must not return someone else’s invoice');
    check(other.json?.error?.code !== undefined || other.status === 404,
        'error code lives at .error.code on the wire (api.js flattens it)',
        'the envelope changed shape');

    // ── Result ───────────────────────────────────────────────────────────────
    console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${failures.length} failed\x1b[0m`);
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  • ${f}`));
        process.exit(1);
    }
}

main().catch((e) => { console.error('\n\x1b[31mverify failed:\x1b[0m', e.message); process.exit(1); });
