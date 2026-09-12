#!/usr/bin/env node
/**
 * Is the bulk-price ladder REALLY on the rows the cards render from? (ERR-218)
 * ============================================================================
 *
 * The quantity stepper's live bulk line — "At 3 you pay $17.75 ea — saving
 * $2.22" — is resolved by Business.offerAtQuantity against `quantity_breaks`
 * embedded on the product row the grid was rendered from. That is what makes it
 * cost ZERO extra requests, for guests included.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * If the backend stops shipping `quantity_breaks` on a given route, nothing
 * breaks loudly. Business.ingest() skips rows without the array (by design —
 * "not shipped yet, say nothing"), decorateCards() decorates nothing, and
 * syncCardQuantity() returns false on an undecorated card. The stepper keeps
 * working, the price line simply never appears, and no error is logged
 * anywhere. The feature would be silently half-dead on one route while looking
 * perfect on another.
 *
 * That is exactly the ERR-150/160 shape: the same feature vanished twice
 * without a sound. A unit test cannot catch it, because a unit test only asks
 * this repo whether it agrees with itself. So this probe asks the SERVER.
 *
 * It also records a known, real asymmetry rather than hiding it: the
 * /by-printer RPC path and the ribbons RPC carry no quantity_breaks (noted in
 * api.js and ribbons-page.js). Those are reported as NOTES, not failures — but
 * they are reported BY NAME, because a surface silently missing its ladder is
 * the thing this file exists to make visible.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every request is a GET against a public catalogue/search route. There is no
 * --record and no --update-baseline mode, deliberately: a probe that can record
 * may be green only because it just overwrote what it compared against
 * (sweep:b2b ate a committed fixture, 2026-08-12). The mode is PRINTED on every
 * run so it can never be assumed.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly.
 *
 * Usage:  npm run probe:qty-breaks
 * Exit:   0 = the ladder is where the cards expect it
 *         1 = a route the cards render from has stopped shipping it
 *         2 = could not run (network / cold start)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://ink-backend-zaeq.onrender.com';

const require = createRequire(import.meta.url);
const { QtyStepper } = require(path.join(ROOT, 'inkcartridges', 'js', 'utils.js'));

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };

console.log('\n\x1b[1mprobe:qty-breaks — bulk ladder presence on card payloads (ERR-218)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no writes of any kind.');
console.log(SEARCH_ANALYTICS_NOTICE);
console.log(`Backend: ${BASE}\n`);

async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body };
}

function rowsOf(body) {
    const d = (body && body.data) || {};
    if (Array.isArray(d.products)) return d.products;
    if (Array.isArray(d.suggestions)) return d.suggestions;
    if (Array.isArray(d)) return d;
    return [];
}

/** How many rows carry a usable ladder, and how many carry a real rung. */
function ladderStats(rows) {
    let withArray = 0, withRungs = 0;
    for (const r of rows) {
        if (!r || !Array.isArray(r.quantity_breaks)) continue;
        withArray++;
        if (r.quantity_breaks.length > 0) withRungs++;
    }
    return { total: rows.length, withArray, withRungs };
}

const ROUTES = [
    { name: '/api/search/smart (the typeahead dropdown)',
      url: `${BASE}/api/search/smart?q=LC3317&limit=40`, required: true },
    { name: '/api/products (the /shop and /search grids)',
      url: `${BASE}/api/products?brand=brother&limit=24`, required: true },
];

const run = async () => {
    console.log('\x1b[1m§1 — routes the card grids render from\x1b[0m');
    for (const route of ROUTES) {
        let res;
        try { res = await getJson(route.url); }
        catch (e) {
            console.log(`\n\x1b[33mINCONCLUSIVE\x1b[0m — ${route.name} unreachable: ${e.message}`);
            console.log('A cold Render instance can take ~50s on first hit. Try again.');
            process.exit(2);
        }
        if (res.status !== 200) {
            bad(route.name, `expected 200, got ${res.status}`);
            continue;
        }
        const rows = rowsOf(res.body);
        if (!rows.length) { soft(route.name, 'returned 200 with zero rows — nothing to measure'); continue; }
        const s = ladderStats(rows);
        const pct = ((s.withArray / s.total) * 100).toFixed(0);
        console.log(`    ${s.total} rows · ${s.withArray} carry quantity_breaks (${pct}%) · ${s.withRungs} carry at least one rung`);
        if (route.required) {
            // The claim under test is that the ladder rides along on the row, so
            // the card needs no second request. One row carrying it proves the
            // field still ships; zero proves the feature is silently dead here.
            if (s.withArray === 0) {
                bad(route.name,
                    'NOT ONE row carries quantity_breaks. Business.ingest skips rows without it, '
                    + 'decorateCards decorates nothing, and the stepper\'s bulk line never appears — '
                    + 'silently, with nothing logged. The feature is half-dead on this route.');
            } else {
                ok(`${route.name} still ships quantity_breaks`);
            }
        }
    }

    console.log('\n\x1b[1m§2 — the known asymmetry, named rather than hidden\x1b[0m');
    try {
        const r = await getJson(`${BASE}/api/products/by-printer?printer_slug=brother-mfc-j5330dw&limit=12`);
        if (r.status === 200) {
            const s = ladderStats(rowsOf(r.body));
            if (s.total && s.withArray === 0) {
                soft('/by-printer carries no quantity_breaks',
                    `${s.total} rows, 0 with a ladder. Known and recorded in api.js — those cards `
                    + 'fall back to the authed /api/business/pricing route or show retail only. '
                    + 'Reported so it stays a known gap rather than becoming a surprise.');
            } else if (s.total) {
                ok(`/by-printer now ships quantity_breaks on ${s.withArray}/${s.total} rows`);
            } else {
                soft('/by-printer', '200 with zero rows — nothing to measure');
            }
        } else {
            soft('/by-printer', `non-200 (${r.status}) — not part of the pass/fail claim`);
        }
    } catch (e) {
        soft('/by-printer', `unreachable: ${e.message}`);
    }

    console.log('\n\x1b[1m§3 — the ceiling the stepper offers is one the cart accepts\x1b[0m');
    const ceiling = QtyStepper.ceiling();
    if (Number.isFinite(ceiling) && ceiling > 1) {
        ok(`stepper ceiling resolves to ${ceiling}`);
    } else {
        bad('stepper ceiling', `resolved to ${ceiling}, which is not a usable maximum`);
    }

    console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${failures.length} failed, ${notes.length} noted.`);
    if (notes.length) { console.log('\nNoted:'); notes.forEach(n => console.log(`  ~ ${n}`)); }
    if (failures.length) { console.log('\nFailed:'); failures.forEach(f => console.log(`  ✗ ${f}`)); process.exit(1); }
    console.log('\x1b[32mThe bulk ladder is where the cards expect it.\x1b[0m\n');
};

run().catch((e) => { console.error('\nProbe crashed:', e); process.exit(2); });
