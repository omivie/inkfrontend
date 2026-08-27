#!/usr/bin/env node
/**
 * probe-invoice-pickers.mjs — can the New Invoice "Start from" boxes actually
 * find a customer?  (ERR-176)
 * =====================================================================
 *
 * Two pickers sit at the top of the invoice editor: "Existing order" (imports an
 * order) and "Fill details from…" (fills the bill-to). Both reported "No matches"
 * for a real paying customer, and neither could say why — a frontend cannot tell
 * an empty result from an unread envelope. The two causes were:
 *
 *   1. `/api/admin/orders` answers `{ok, data:[ …rows… ]}` — `data` is a BARE
 *      ARRAY. The picker read `data?.orders` off it and got `undefined`, so it
 *      rendered "No matches" for every query ever typed, valid order numbers
 *      included. THAT is the assertion below that matters most: if the backend
 *      ever wraps the rows in `{orders:[…]}` instead, this probe says so before
 *      a user does.
 *   2. The party picker searched Contacts + Customers only. A GUEST checkout
 *      (`user_id: null`) has neither row — it exists only as an order — so the
 *      dropdown was reporting "not looked" as "not found".
 *
 * So this probe does not just hit URLs: it imports the SHIPPED module
 * (js/admin/utils/party-search.js) and drives it against the live API, which is
 * the only way to prove the code the admin actually runs finds the customer.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET. There is no --record / --write mode and this probe
 * writes nothing, anywhere. The mode is printed on every run so it can never be
 * assumed (sweep:b2b once went green by overwriting the fixture it compared
 * against, 2026-08-12).
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly. A file that reads .env must never be one URL
 * away from the internet.
 *
 * Usage:  npm run probe:invoice-pickers            (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:invoice-pickers -- Wright  (force the name token to probe)
 * Exit:   0 = every check passed, 1 = at least one failed, 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const PARTY_MODULE = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'party-search.js');

let pass = 0;
const failures = [];
const notes = [];
const ok = (name) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
/** A real limit worth reporting that the frontend already accommodates honestly. */
const soft = (name, detail) => {
    notes.push(`${name} — ${detail}`);
    console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

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

/** The name the picker renders for an order row, byte-for-byte. */
const orderName = (o) => String(o.customer_name || o.shipping_recipient_name || '');

async function main() {
    console.log('\n\x1b[1mNew Invoice "Start from" pickers — live contract probe\x1b[0m');
    console.log('\x1b[36mMODE: READ-ONLY\x1b[0m — every request is a GET; this probe writes nothing.\n');

    const env = readEnv();
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    if (!email || !password) {
        // A skip is not a pass. Exit 2 and name the missing variable.
        console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
        console.error('These must be a super_admin — /api/admin/* 403s for anyone else.');
        console.error('Nothing was verified. Do NOT read this as a pass.\n');
        process.exit(2);
    }

    const { searchParties, ordersFrom, orderToParty } = await import(pathToFileURL(PARTY_MODULE).href);

    const token = await signIn(email, password);
    const get = async (p) => {
        const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: res.status, json, text };
    };
    console.log(`Signed in as ${email}\n`);

    // ── 1. The envelope the whole bug turned on ──────────────────────────────
    console.log('\x1b[1m1. Envelope — GET /api/admin/orders\x1b[0m');
    const base = await get('/api/admin/orders?page=1&limit=20');
    if (base.status !== 200) {
        bad('GET /api/admin/orders', `HTTP ${base.status} — ${base.text.slice(0, 160)}`);
        return report();
    }
    const isArray = Array.isArray(base.json?.data);
    check(isArray, 'data is a bare ARRAY (what the FE normaliser is written for)',
        `data is ${base.json?.data === undefined ? 'absent' : 'an object with keys ' + Object.keys(base.json.data).join(',')}`
        + ' — the shape moved; re-check ordersFrom() in utils/party-search.js');
    const baseRows = ordersFrom(base.json?.data);
    check(baseRows.length > 0, `ordersFrom() unwrapped ${baseRows.length} rows`,
        'the shipped normaliser got nothing out of a 200 response — the pickers are blind again');
    if (!baseRows.length) return report();
    // The exact expression that shipped broken, kept as a live tripwire.
    check(base.json.data.orders === undefined,
        'reading `.orders` off the response still yields undefined (the ERR-176 shape)',
        'the backend now sends {orders:[…]} — harmless (ordersFrom handles both), note the change');

    // ── 2. Is a GUEST reachable at all? ──────────────────────────────────────
    console.log('\n\x1b[1m2. Guest reachability — the customer that started this\x1b[0m');
    const forced = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0];
    const guest = baseRows.find((r) => !r.user_id && orderName(r).trim().split(/\s+/).length > 1);
    check(!!guest, 'a guest order (user_id: null) exists to probe with',
        'no guest checkout in the newest 20 orders — pass a name token as an argument');
    const nameToken = forced || (guest ? orderName(guest).trim().split(/\s+/).pop() : '');
    if (!nameToken) return report();
    console.log(`  \x1b[2mprobing with "${nameToken}"${guest ? ` (from guest order ${guest.order_number})` : ''}\x1b[0m`);

    const api = {
        listContacts: async (f, page, limit) => (await get(`/api/admin/contacts?page=${page}&limit=${limit}&search=${encodeURIComponent(f.search)}`)).json?.data ?? null,
        getCustomers: async (f, page, limit) => (await get(`/api/admin/customers?page=${page}&limit=${limit}&search=${encodeURIComponent(f.search)}`)).json?.data ?? null,
        getOrders: async (f, page, limit) => (await get(`/api/admin/orders?page=${page}&limit=${limit}&search=${encodeURIComponent(f.search)}`)).json?.data ?? null,
    };

    // ── 3. The shipped party search, driven live ─────────────────────────────
    console.log('\n\x1b[1m3. searchParties() against the live API\x1b[0m');
    const { sections, failed } = await searchParties(nameToken, api);
    check(failed.length === 0, 'every source answered',
        `these could not be searched: ${failed.join(', ')} — an empty dropdown here is NOT a "no match"`);
    const orderSec = sections.find((s) => /Orders/.test(s.title));
    check(!!orderSec, `an Orders section came back (${orderSec?.items.length || 0} rows)`,
        `no Orders section for "${nameToken}" — a guest checkout is unfindable in the party picker again`);
    // A forced token is the operator's own query — it says nothing about the guest
    // order the probe happened to pick, so only assert that pairing when the token
    // was derived FROM that order.
    if (guest && orderSec && !forced) {
        const hit = orderSec.items.find((o) => o.order_number === guest.order_number);
        check(!!hit, `guest order ${guest.order_number} is in the dropdown`,
            `"${nameToken}" did not surface ${guest.order_number} — the search no longer reaches the order it came from`);
        if (hit) {
            const party = orderToParty(hit);
            check(!!(party.name && party.email && party.address),
                `orderToParty filled name/email/address (${party.name}, ${party.email})`,
                `a picked order would fill blanks: name="${party.name}" email="${party.email}" address="${party.address}"`);
        }
    }
    if (orderSec) {
        console.log(`  \x1b[2morders: ${orderSec.items.map((o) => `${o.order_number} ${orderName(o)}`).join(' · ')}\x1b[0m`);
    }
    console.log(`  \x1b[2msections: ${sections.map((s) => `${s.title}(${s.items.length})`).join(' · ') || 'none'}\x1b[0m`);

    // ── 4. Sibling envelopes (they are NOT the same shape) ───────────────────
    console.log('\n\x1b[1m4. Contacts / Customers envelopes\x1b[0m');
    const cts = await get('/api/admin/contacts?page=1&limit=2');
    const cus = await get('/api/admin/customers?page=1&limit=2');
    check(Array.isArray(cts.json?.data?.contacts), 'contacts → data.contacts[]',
        `HTTP ${cts.status}, data keys: ${Object.keys(cts.json?.data || {}).join(',') || '—'}`);
    check(Array.isArray(cus.json?.data?.customers), 'customers → data.customers[]',
        `HTTP ${cus.status}, data keys: ${Object.keys(cus.json?.data || {}).join(',') || '—'}`);

    // ── 5. The two limits the UI has to be honest about ──────────────────────
    console.log('\n\x1b[1m5. Known backend limits (soft — the UI must NOT promise past them)\x1b[0m');
    const anEmail = baseRows.map((r) => r.customer_email || r.guest_email).find(Boolean);
    if (anEmail) {
        const byEmail = await get(`/api/admin/orders?page=1&limit=8&customer_email=${encodeURIComponent(anEmail)}`);
        const emailRows = ordersFrom(byEmail.json?.data);
        if (emailRows.length) ok(`orders CAN be found by email now (${anEmail}) — the picker message can be relaxed`);
        else soft('orders are still not searchable by email',
            `customer_email=${anEmail} → 0 rows (BF-046). The order box must keep saying so instead of a bare "no matches".`);
    }
    const twoWord = baseRows.map((r) => orderName(r)).find((n) => n.trim().split(/\s+/).length > 1);
    if (twoWord) {
        const wide = await get(`/api/admin/customers?page=1&limit=6&search=${encodeURIComponent(twoWord)}`);
        const narrow = await get(`/api/admin/customers?page=1&limit=6&search=${encodeURIComponent(twoWord.split(/\s+/).pop())}`);
        const wideN = (wide.json?.data?.customers || []).length;
        const narrowN = (narrow.json?.data?.customers || []).length;
        if (wideN === 0 && narrowN > 0) {
            soft('customers?search= cannot match a multi-word name',
                `"${twoWord}" → 0 rows but "${twoWord.split(/\s+/).pop()}" → ${narrowN}. searchParties() widens to the longest token for this reason.`);
        } else ok(`customers?search= handled "${twoWord}" (${wideN} rows) — widening is belt-and-braces`);
    }

    report();
}

function report() {
    console.log('');
    if (notes.length) console.log(`\x1b[33m${notes.length} note(s)\x1b[0m — measured limits, not failures.`);
    if (!failures.length) {
        console.log(`\x1b[32m${pass} check(s) passed.\x1b[0m The invoice pickers can reach a guest customer.\n`);
        process.exit(0);
    }
    console.log(`\x1b[31m${failures.length} check(s) FAILED\x1b[0m (of ${failures.length + pass}):`);
    failures.forEach((f) => console.log(`  • ${f}`));
    console.log('');
    process.exit(1);
}

main().catch((e) => {
    console.error(`\n\x1b[31mCANNOT RUN\x1b[0m — ${e.message}\nNothing was verified. Do NOT read this as a pass.\n`);
    process.exit(2);
});
