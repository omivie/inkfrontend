#!/usr/bin/env node
/**
 * probe-orders-delivery-type.mjs
 * ==============================
 * Does an admin order actually carry its delivery area, and do we read it from
 * the place it is actually in? (ERR-253)
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend added `orders.delivery_type` and told us, in writing:
 *
 *     GET /api/admin/orders           -> data[].delivery_type
 *     GET /api/admin/orders/:orderId  -> data.delivery_type
 *
 * The second line is WRONG, and it is wrong in the most expensive way an API
 * note can be: the detail route answers `{ok, data: {order: {…}}}`, so
 * `resp.data.delivery_type` is `undefined` on every order, forever, with no
 * error and no log line. A reader coded from that sentence would show "not
 * recorded" on 100% of orders and never find out. So this probe asserts the
 * PATH, not just the presence — ERR-167's shape: when the fallback is the only
 * branch that ever runs, the guard IS the bug.
 *
 * THE SECOND THING IT EXISTS FOR is that "live" is not "populated". The column
 * shipped without a backfill, deliberately, so that a guess is never stored as
 * a fact. Measured at the time of writing: `orders.delivery_type` is null on
 * 166 of 167 live orders. A probe that failed on that would be demanding the
 * backend fabricate history. So an all-null population is a PASS here, and the
 * counts are PRINTED — reporting the emptiness is the job, not failing on it.
 *
 * THE THIRD is the one that would actually cost money. The backend also
 * publishes what it can DERIVE, with provenance, in `supplier_freight`:
 *
 *     recorded  the order says so                        (exact)
 *     snapshot  summed from the stored courier cost      (exact)
 *     charged   inverted from the fee the customer paid  (exact)
 *     assumed   urban, and it says so
 *
 * Reading only the column reports "unknown" on 99% of orders while the answer
 * for most of them is already in the payload. So this checks both, in order,
 * through the SHIPPED reader (`deliveryFactsForOrder`) rather than a replica of
 * it — ERR-231's probe certified a copy of the escaper and missed the bug in
 * the real one.
 *
 * NOT under inkcartridges/. `vercel.json` sets outputDirectory to ".", so
 * everything in that tree is served publicly (ERR-229). Audit tooling lives here.
 *
 * USAGE
 *   npm run probe:orders-delivery-type
 *
 * EXIT CODES
 *   0  every assertion held
 *   1  a real regression
 *   2  could not run (no credentials, sign-in refused, network)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'inkcartridges');

const API = 'https://api.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const LIST_LIMIT = 300;
/** Detail fetches are rate-limited; small batches with a pause. */
const DETAIL_SAMPLE = 40;
const DETAIL_BATCH = 5;
const BATCH_PAUSE_MS = 1100;

const VALID = new Set(['urban', 'rural']);

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => {
    failures.push(`${n} — ${d}`);
    console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`);
};
const soft = (n, d) => {
    notes.push(`${n} — ${d}`);
    console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (n, why) => {
    notes.push(`SKIPPED: ${n} — ${why}`);
    console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${n}\n      ${why}`);
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv() {
    const f = path.join(ROOT, '.env');
    if (!fs.existsSync(f)) return {};
    return Object.fromEntries(
        fs.readFileSync(f, 'utf8').split('\n')
            .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
            .map((l) => [l.slice(0, l.indexOf('=')).trim(),
                l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
    );
}

async function main() {
    console.log('\x1b[1mAdmin orders — delivery area and its provenance (ERR-253)\x1b[0m');
    console.log('\x1b[90mMODE: READ-ONLY. Every request is a GET except the sign-in.');
    console.log('This script has no recording flag and cannot write to production.\x1b[0m');

    const env = readEnv();
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
        console.error('\n\x1b[31mCannot run:\x1b[0m ADMIN_EMAIL / ADMIN_PASSWORD missing from .env');
        process.exit(2);
    }

    // The SHIPPED reader, not a replica of it.
    let SF;
    try {
        SF = await import(pathToFileURL(path.join(SITE, 'js/admin/utils/supplier-freight.js')).href);
    } catch (e) {
        console.error(`\n\x1b[31mCannot run:\x1b[0m could not import supplier-freight.js — ${e.message}`);
        process.exit(2);
    }
    if (typeof SF.deliveryFactsForOrder !== 'function') {
        console.error('\n\x1b[31mCannot run:\x1b[0m supplier-freight.js does not export deliveryFactsForOrder');
        process.exit(2);
    }

    let token;
    try {
        const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { apikey: ANON, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
        });
        token = (await r.json())?.access_token;
    } catch (e) {
        console.error(`\n\x1b[31mCannot run:\x1b[0m sign-in failed — ${e.message}`);
        process.exit(2);
    }
    if (!token) {
        console.error('\n\x1b[31mCannot run:\x1b[0m sign-in returned no access token');
        process.exit(2);
    }
    const H = { Authorization: `Bearer ${token}` };

    // ── §1 The list route ───────────────────────────────────────────────────
    head('§1  GET /api/admin/orders — the key is present on every row');
    const listResp = await fetch(`${API}/api/admin/orders?limit=${LIST_LIMIT}`, { headers: H });
    if (listResp.status !== 200) {
        bad('the orders list answers 200', `got ${listResp.status}`);
        return report();
    }
    const rows = (await listResp.json())?.data || [];
    if (!rows.length) {
        skip('every list row carries delivery_type', 'the orders list came back empty');
        return report();
    }

    // hasOwnProperty, not truthiness: ABSENT, null and a value are three states
    // and two of them look alike (ERR-199). An absent key means the column was
    // not projected, which is a different bug from an unrecorded value.
    const missingKey = rows.filter((o) => !Object.prototype.hasOwnProperty.call(o, 'delivery_type'));
    if (missingKey.length) {
        bad('every list row carries the delivery_type KEY',
            `${missingKey.length} of ${rows.length} rows do not have the key at all. That is the `
            + 'column not being projected, not an unrecorded value — and a caller that forgets to '
            + 'project it silently falls back to inference, which on a rural parcel is half the freight.');
    } else {
        ok('every list row carries the delivery_type KEY', `${rows.length} rows`);
    }

    const tally = { urban: 0, rural: 0, null: 0, other: 0 };
    for (const o of rows) {
        const v = o.delivery_type;
        if (v === null || v === undefined) tally.null++;
        else if (VALID.has(v)) tally[v]++;
        else tally.other++;
    }
    if (tally.other) {
        bad('delivery_type is only urban | rural | null',
            `${tally.other} rows carry some other value. The vocabulary has three states and the `
            + 'display layer only knows those three.');
    } else {
        ok('delivery_type is only urban | rural | null',
            `urban ${tally.urban} · rural ${tally.rural} · null ${tally.null}`);
    }

    // AN ALL-NULL POPULATION IS EXPECTED AND MUST NOT FAIL. The column shipped
    // with no backfill on purpose. Reporting it is the job.
    if (tally.urban + tally.rural === 0) {
        soft('nothing has recorded a delivery area yet',
            `all ${tally.null} orders are null. That is the DESIGNED state — the column was added `
            + 'without a backfill so that a guess is never stored as a fact. It becomes non-zero as '
            + 'new orders arrive. The admin UI must read this as "Not recorded", never as urban.');
    } else {
        ok('the write path is live — some orders have recorded an area',
            `${tally.urban + tally.rural} of ${rows.length} recorded`);
    }

    // ── §2 The detail route, and the path the hand-off got wrong ────────────
    head('§2  GET /api/admin/orders/:id — the key is at data.order, NOT data');
    const sample = rows.slice(0, DETAIL_SAMPLE);
    const details = [];
    for (let i = 0; i < sample.length; i += DETAIL_BATCH) {
        const batch = sample.slice(i, i + DETAIL_BATCH);
        const got = await Promise.all(batch.map(async (o) => {
            const r = await fetch(`${API}/api/admin/orders/${o.id}`, { headers: H });
            if (r.status !== 200) return null;
            return r.json();
        }));
        details.push(...got.filter(Boolean));
        if (i + DETAIL_BATCH < sample.length) await sleep(BATCH_PAUSE_MS);
    }
    if (!details.length) {
        skip('the detail route carries delivery_type', 'no detail payload could be fetched');
        return report();
    }

    const atDataOrder = details.filter((d) => d?.data?.order
        && Object.prototype.hasOwnProperty.call(d.data.order, 'delivery_type')).length;
    const atDataDirect = details.filter((d) => d?.data
        && Object.prototype.hasOwnProperty.call(d.data, 'delivery_type')).length;

    if (atDataOrder === details.length) {
        ok('delivery_type lives at data.order.delivery_type', `${atDataOrder} of ${details.length}`);
    } else {
        bad('delivery_type lives at data.order.delivery_type',
            `only ${atDataOrder} of ${details.length} detail payloads have it there`);
    }

    // THE ASSERTION THE HAND-OFF EARNED. Its note said `data.delivery_type`.
    // If that ever becomes true the backend has reshaped the envelope, which is
    // worth knowing; right now, coding to that sentence yields undefined forever.
    if (atDataDirect === 0) {
        ok('and NOT at data.delivery_type — the hand-off note was wrong',
            'coding `resp.data.delivery_type` from the backend note would read undefined on every '
            + 'order, with no error: the detail envelope is {ok, data:{order:{…}}}');
    } else {
        soft('data.delivery_type has appeared',
            `${atDataDirect} of ${details.length} payloads now carry it at the top level too. The `
            + 'envelope has been reshaped; re-read both paths before relying on either.');
    }

    // ── §3 Provenance, through the shipped reader ───────────────────────────
    head('§3  Provenance — reading the column ALONE would report unknown on almost everything');
    const basisTally = {};
    let factsKnown = 0;
    let columnKnown = 0;
    let badBasisValue = 0;
    for (const d of details) {
        const order = d.data.order;
        const facts = SF.deliveryFactsForOrder(order);
        if (facts.deliveryType) factsKnown++;
        if (order.delivery_type) columnKnown++;
        const b = facts.basis || '(none)';
        basisTally[b] = (basisTally[b] || 0) + 1;
        if (facts.deliveryType !== null && !VALID.has(facts.deliveryType)) badBasisValue++;
    }
    if (badBasisValue) {
        bad('the shipped reader only ever yields urban | rural | null',
            `${badBasisValue} orders produced something else`);
    } else {
        ok('the shipped reader only ever yields urban | rural | null');
    }
    ok('basis distribution', Object.entries(basisTally).map(([k, v]) => `${k} ${v}`).join(' · '));

    if (factsKnown >= columnKnown) {
        ok('reading both beats reading the column alone',
            `column alone: ${columnKnown} of ${details.length} known · with provenance: `
            + `${factsKnown} of ${details.length}`);
    } else {
        bad('reading both beats reading the column alone',
            `the reader resolved FEWER orders (${factsKnown}) than the raw column (${columnKnown}), `
            + 'which means it is discarding a recorded value');
    }

    // POSITIVE CONTROL. If deliveryFactsForOrder silently returned null for
    // everything, every assertion above would still be green — "no data" and
    // "reader broken" look identical from here. So feed it a known-good order.
    const control = SF.deliveryFactsForOrder({
        delivery_type: 'rural',
        supplier_freight: { delivery_type: 'urban', delivery_type_basis: 'assumed', parcel_weight_kg: 1.2 },
    });
    if (control.deliveryType === 'rural' && control.basis === 'assumed') {
        ok('positive control: a recorded value WINS over a derived one, and the basis is carried');
    } else {
        bad('positive control: a recorded value WINS over a derived one',
            `fed {delivery_type:'rural'} over a derived 'urban' and got `
            + `${JSON.stringify(control)} — the reader is not preferring the recorded column, so `
            + 'every count above is meaningless');
    }

    // NEGATIVE CONTROL — absence must stay absence, never become 'urban'.
    const empty = SF.deliveryFactsForOrder({});
    if (empty.deliveryType === null) {
        ok('negative control: an order with nothing recorded yields null, not urban');
    } else {
        bad('negative control: an order with nothing recorded yields null, not urban',
            `got ${JSON.stringify(empty)}. ERR-235 is what happens when a guess is stored as a fact.`);
    }

    return report();
}

function report() {
    console.log('');
    if (notes.length) {
        console.log('\x1b[1mNotes\x1b[0m');
        for (const n of notes) console.log(`  ${n}`);
        console.log('');
    }
    if (failures.length) {
        console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${pass} passed`);
        process.exit(1);
    }
    console.log(`\x1b[32mAll ${pass} checks passed\x1b[0m${notes.length ? ` (${notes.length} note(s))` : ''}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(`\n\x1b[31mProbe crashed:\x1b[0m ${e.stack || e.message}`);
    process.exit(2);
});
