#!/usr/bin/env node
/**
 * probe-order-discount.mjs — assert the LIVE admin order payload carries the
 * discount fields the profit math now depends on
 * =====================================================================
 *
 * ERR-168: admin profit was computed as Σ(unit_price × qty) and never subtracted
 * `orders.discount_amount`, so every volume-discounted order overstated profit by
 * discount/1.15. The frontend fix nets it out — but the fix is INERT if the
 * backend stops sending the field, and inert in the worst possible way: the
 * guard treats an absent `discount_amount` as $0, which is exactly the pre-fix
 * behaviour and looks perfectly healthy on screen.
 *
 * A unit test cannot notice that. This can. It walks the live admin endpoints
 * with a real super_admin token and checks:
 *   - GET /api/admin/orders/:id  carries discount_amount  (the detail path — the
 *     one both the modal and the list column derive profit from)
 *   - GET /api/admin/orders      carries it on LIST rows too (backend 52abc83),
 *     which is what the Total column's sub-line reads with no extra fetch
 *   - the field is a NUMBER or null, never absent (absent ≠ 0 — the whole point)
 *   - the arithmetic still holds on a real row: total ≈ (Σ line ex-GST −
 *     discount/1.15) × 1.15 + shipping
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. This probe has no --record / --update-baseline mode
 * and writes nothing, anywhere. That is deliberate: a probe that can record may
 * pass because it just overwrote what it was comparing against (sweep:b2b ate a
 * committed fixture, 2026-08-12). The mode is printed on every run so it can
 * never be assumed.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file here that reads .env must never be one
 * URL away from the internet.
 *
 * Usage:  npm run probe:order-discount            (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:order-discount -- 20260817000002 20260812000001
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

/** The orders named in the backend brief as known-discounted. Overridable via argv. */
const DEFAULT_ORDERS = ['20260817000002', '20260817000001', '20260812000003', '20260812000001'];

const GST = 0.15;

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/**
 * A gap that is real and worth reporting to the backend, but that the frontend
 * already handles correctly — so it must NOT redden the exit code. Keeping these
 * separate is the point: if a soft note could fail the run, the run gets ignored,
 * and then a hard failure gets ignored with it.
 */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const checkSoft = (cond, name, detail) => (cond ? ok(name) : soft(name, detail));
const money = (n) => (n == null ? 'null' : `$${Number(n).toFixed(2)}`);

/**
 * Present, and a number or null. An ABSENT key is the failure that matters here:
 * `Number(undefined)` is NaN, our guard reads that as "no discount", and the
 * result is indistinguishable from a genuinely undiscounted order.
 */
function nullableNumber(obj, key, where) {
    if (!obj || !(key in obj)) {
        return bad(`${where}.${key}`, 'ABSENT — the fix reads an absent field as $0, so this silently restores ERR-168');
    }
    const v = obj[key];
    if (v === null || typeof v === 'number') return ok(`${where}.${key} = ${v === null ? 'null' : money(v)}`);
    // A numeric string still works through Number(), but say so — it is a contract drift.
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) {
        return ok(`${where}.${key} = ${money(Number(v))} (sent as a STRING — tolerated, but the contract says number)`);
    }
    bad(`${where}.${key}`, `expected number|null, got ${typeof v} (${JSON.stringify(v)})`);
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

async function main() {
    console.log('\n\x1b[1mOrder-discount live contract probe\x1b[0m');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET; this probe writes nothing.\n');

    const env = readEnv();
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    if (!email || !password) {
        console.error('ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
        console.error('These must be a super_admin — the orders endpoints 403 for anyone else.');
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

    const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
    const orderNumbers = wanted.length ? wanted : DEFAULT_ORDERS;
    console.log(`Signed in as ${email}\n`);

    // ── 1. The LIST payload ──────────────────────────────────────────────────
    console.log('\x1b[1mGET /api/admin/orders — list rows (backend 52abc83)\x1b[0m');
    const list = await get('/api/admin/orders?page=1&limit=50');
    if (list.status !== 200) {
        bad('GET /api/admin/orders', `HTTP ${list.status} — ${list.text.slice(0, 160)}`);
        return report();
    }
    const rows = list.json?.data?.orders || list.json?.data?.items || list.json?.data || [];
    check(Array.isArray(rows) && rows.length > 0, 'list returned rows', `got ${JSON.stringify(rows).slice(0, 120)}`);
    if (Array.isArray(rows) && rows.length) {
        nullableNumber(rows[0], 'discount_amount', 'list[0]');
        check('coupon_code' in rows[0], 'list[0].coupon_code present',
            'ABSENT — the Total sub-line can still render, but never names the promo code');
        const discountedRows = rows.filter((r) => Number(r.discount_amount) > 0);
        check(discountedRows.length > 0, `${discountedRows.length} of ${rows.length} recent orders carry a discount`,
            'no discounted orders in the last 50 — cannot prove the field is populated, only that it exists');
    }

    // ── 2. The DETAIL payload, per named order ───────────────────────────────
    for (const num of orderNumbers) {
        console.log(`\n\x1b[1mGET /api/admin/orders/${num} — detail\x1b[0m`);
        const row = (Array.isArray(rows) ? rows : []).find(
            (r) => String(r.order_number) === String(num));
        const id = row?.id || num;
        const res = await get(`/api/admin/orders/${encodeURIComponent(id)}`);
        if (res.status !== 200) {
            bad(`order ${num}`, `HTTP ${res.status} — ${res.text.slice(0, 160)}`);
            continue;
        }
        const o = res.json?.data?.order ?? res.json?.data ?? null;
        if (!o) { bad(`order ${num}`, 'no order object in the envelope'); continue; }

        nullableNumber(o, 'discount_amount', `order ${num}`);
        check('coupon_code' in o, `order ${num}.coupon_code present`, 'ABSENT on the detail payload');
        // The brief said this is "exposed if you ever want to label the split".
        // On the ADMIN route it is not (verified live 2026-08-17). We only use it
        // to caption the loyalty portion, and orderDiscountParts() reads an absent
        // value as $0 with applies:false, so nothing is miscomputed — the caption
        // simply doesn't appear. Reported, not failed.
        checkSoft('loyalty_discount_amount' in o, `order ${num}.loyalty_discount_amount present`,
            'ABSENT on the admin route (the brief said it was exposed). Labelling only — the money is '
            + 'derived from the discount_amount aggregate, so no figure is affected.');

        // ── 3. The arithmetic, on a real row ─────────────────────────────────
        const items = Array.isArray(o.items) ? o.items : (Array.isArray(o.order_items) ? o.order_items : []);
        const gross = items.reduce((s, it) => {
            const price = it.sell_price ?? it.unit_price ?? it.price ?? 0;
            const qty = it.qty ?? it.quantity ?? 0;
            return s + Number(price) * Number(qty);
        }, 0);
        const discIncl = Number(o.discount_amount);
        const discExGst = Number.isFinite(discIncl) && discIncl > 0 ? discIncl / (1 + GST) : 0;
        const netRev = gross - discExGst;
        const total = Number(o.total_amount ?? o.total);
        const shipping = Number(o.shipping_fee ?? o.shipping_cost ?? 0) || 0;
        const impliedTotal = netRev * (1 + GST) + shipping;

        console.log(`      lines ex-GST ${money(gross)} · discount ${money(discIncl)} incl `
            + `(${money(discExGst)} ex) · realised revenue ${money(netRev)} · shipping ${money(shipping)}`);
        console.log(`      implied total ${money(impliedTotal)} vs charged ${money(total)}`);

        if (Number.isFinite(total)) {
            const drift = Math.abs(impliedTotal - total);
            check(drift <= 0.05,
                `order ${num}: realised revenue reconciles to the charged total (drift ${money(drift)})`,
                `drift ${money(drift)} — netting discount/1.15 out of the line sum does NOT reproduce the `
                + `charged total. Either the discount is not GST-inclusive, or it is not an order-level `
                + `reduction of the line prices. The FE fix assumes both.`);
        }
        if (discIncl > 0) {
            check(discExGst < gross,
                `order ${num}: discount is below the line total (revenue stays positive)`,
                `discount ex-GST ${money(discExGst)} >= line sum ${money(gross)} — profit resolves to UNKNOWN`);
        }
    }

    report();
}

function report() {
    console.log(`\n${'─'.repeat(64)}`);
    if (notes.length) {
        console.log(`\x1b[33m${notes.length} note${notes.length === 1 ? '' : 's'} for the backend\x1b[0m `
            + `(handled correctly by the frontend, not failures):\n`);
        notes.forEach((n) => console.log(`  • ${n}`));
        console.log('');
    }
    if (failures.length === 0) {
        console.log(`\x1b[32m${pass} checks passed.\x1b[0m The discount contract holds; the ERR-168 fix has real data to work with.\n`);
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
