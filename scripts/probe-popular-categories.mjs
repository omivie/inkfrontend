#!/usr/bin/env node
/**
 * probe-popular-categories.mjs — does /api/products/popular still FILTER?
 * =======================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09-10, passing one of our internal category ids to
 * `/api/products/popular` was a hard 400. The landing shelves were built around
 * that: a category absent from `POPULAR_CATEGORY_API` asked for nothing, and a
 * wrong value announced itself with an error.
 *
 * That is over. `consumable` and `cartridge` now answer **200 with no filter** —
 * they are retired aliases that resolve to "popular across every category". So
 * passing our `consumable` straight through no longer 400s; it quietly fills a
 * Drums & Supplies shelf with ink and toner, and every HTTP-level check stays
 * green while it happens.
 *
 * ***THE STATUS CODE CAN NO LONGER TELL YOU YOU ARE WRONG. ONLY READING
 * `product_type` ON THE ROWS CAN.***
 *
 * `tests/landing-popular-products-sep2026.test.js` said exactly that, and said
 * it was why `probe:landing-popular` reads product_type. It does not — that
 * probe is a Playwright DOM check that never calls this endpoint (measured
 * 2026-09-16: zero mentions of `products/popular` or `product_type` in it). The
 * guard the comment described did not exist. This file is that guard.
 *
 * WHAT IT MEASURES
 * ----------------
 *   §1  Every value in the SHIPPED `POPULAR_CATEGORY_API` returns rows whose
 *       `product_type` belongs to that family. A single foreign type fails.
 *   §2  The traps: `consumable` and `cartridge` must come back MIXED, which is
 *       what proves the translation in §1 is still load-bearing rather than
 *       superstition. If the backend ever makes them filter correctly, this
 *       goes red and the map can be simplified — a change either way is news.
 *   §3  POSITIVE CONTROL: `bogus` still 400s, so a 200 means something.
 *
 * It loads the map out of the shipped `js/shop-page.js`. A probe that
 * re-declares the thing it checks is certifying a replica (ERR-231).
 *
 * -- READ-ONLY. ---------------------------------------------------------------
 * Every request is an unauthenticated GET. There is no recording mode and no
 * flag parsing, deliberately: a probe that can record may pass because it has
 * just overwritten the thing it was comparing against. The mode is PRINTED on
 * every run so it can never be assumed.
 *
 * `/api/products/popular` is NOT a `/api/search/*` route, so unlike the search
 * probes this one writes no `search_analytics` row (ERR-254). Stated because
 * "it's a GET" is not by itself a reason to believe that.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly (ERR-229).
 *
 * Usage:  npm run probe:popular-categories
 *         API_BASE=https://ink-backend-zaeq.onrender.com npm run probe:popular-categories
 * Exit:   0 = every hard check passed · 1 = at least one failed · 2 = could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeQuery } from './lib/probe-search-notice.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'inkcartridges');
const BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const LIMIT = 12;

const failures = [];
const notes = [];
const ok = (n, d) => console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`);
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${String(d).split('\n').join('\n      ')}`); };
const skip = (n, why) => { notes.push(`SKIPPED: ${n} — ${why}`); console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${n}\n      ${why}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/**
 * The product_type families, transcribed from the backend's own taxonomy in
 * `fe-backend-asks-backend-response-sep2026.md` §5 and re-measured 2026-09-10.
 * A type outside its family is the silent-no-filter failure this probe exists
 * to catch.
 */
const FAMILY = {
    ink: ['ink_cartridge', 'ink_bottle'],
    toner: ['toner_cartridge'],
    ribbons: ['printer_ribbon', 'typewriter_ribbon', 'calculator_ribbon', 'correction_tape'],
    drums: ['waste_toner', 'maintenance_box', 'drum_unit', 'belt_unit', 'fuser_kit', 'fax_film', 'fax_film_refill'],
    paper: ['photo_paper'],
    label: ['label_tape'],
};

console.log('\n\x1b[1mprobe:popular-categories — does /api/products/popular still FILTER?\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m Unauthenticated GETs only. No --record exists, and this');
console.log('endpoint is not /api/search/*, so it writes no search_analytics row.');
console.log(`Target: ${BASE}\n`);

/** The SHIPPED map, never a copy of it. */
function loadMap() {
    const src = fs.readFileSync(path.join(SITE, 'js', 'shop-page.js'), 'utf8');
    const m = src.match(/POPULAR_CATEGORY_API:\s*\{([^}]+)\}/);
    if (!m) return null;
    const out = {};
    for (const [, k, v] of m[1].matchAll(/([A-Za-z_]+)\s*:\s*'([^']+)'/g)) out[k] = v;
    return Object.keys(out).length ? out : null;
}

async function popular(category) {
    const url = `${BASE}/api/products/popular?category=${encodeURIComponent(category)}&limit=${LIMIT}`;
    const r = await fetch(url, { headers: { Origin: 'https://inkcartridges.co.nz' } });
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON — leave null */ }
    const rows = (body && body.data && body.data.products) || [];
    return { status: r.status, rows, types: rows.map((p) => p && p.product_type).filter(Boolean) };
}

const tally = (types) => Object.entries(types.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ');

async function main() {
    const MAP = loadMap();
    if (!MAP) {
        console.error('\x1b[31mcould not read POPULAR_CATEGORY_API out of js/shop-page.js\x1b[0m');
        process.exit(2);
    }

    head('§1  every mapped category comes back FILTERED to its own family');
    console.log(`      shipped map: ${JSON.stringify(MAP)}`);
    for (const [feId, apiId] of Object.entries(MAP)) {
        const family = FAMILY[apiId];
        if (!family) {
            // A SKIP IS NOT A PASS, and here it would be worse than that.
            //
            // Found by this file's own red-proof: pointing the shipped map at
            // `cartridge` — the no-filter alias this probe exists to catch —
            // produced exit 0, because `cartridge` has no FAMILY entry and the
            // check politely declined to run. The sabotage walked straight
            // through the guard written to stop it.
            //
            // A value in the SHIPPED map with no verified family is a finding in
            // its own right: either the map gained a translation nobody
            // measured, or the backend taxonomy moved. Both are news.
            bad(`${feId} → ${apiId} is in the shipped map but has no verified family`,
                `no product_type family is recorded for "${apiId}", so this category cannot be `
                + 'checked and must not be reported as fine. Either add its family to FAMILY from '
                + 'the backend taxonomy, or take the value out of POPULAR_CATEGORY_API.');
            continue;
        }
        let r;
        try { r = await popular(apiId); } catch (e) { bad(`${feId} → ${apiId}`, `request failed: ${e.message}`); continue; }
        if (r.status !== 200) { bad(`${feId} → ${apiId}`, `expected 200, got ${r.status}`); continue; }
        if (!r.types.length) {
            soft(`${feId} → ${apiId}`, `200 with ${r.rows.length} rows but no product_type on any of them — `
                + 'the shelf would paint, and this check cannot see what it painted.');
            continue;
        }
        const foreign = [...new Set(r.types.filter((t) => !family.includes(t)))];
        if (foreign.length) {
            bad(`${feId} → ${apiId} returned types from OUTSIDE its family`,
                `foreign: ${foreign.join(', ')}\nall rows: ${tally(r.types)}\n`
                + `expected only: ${family.join(', ')}\n`
                + 'This is the silent-no-filter failure: the status is 200, the shelf paints, and the '
                + 'products are wrong. Check whether this value has become a retired alias.');
        } else {
            ok(`${feId} → ${apiId}`, `${r.rows.length} rows, all in family (${tally(r.types)})`);
        }
    }

    head('§2  the traps — the values that 200 but do NOT filter');
    for (const alias of ['consumable', 'cartridge']) {
        let r;
        try { r = await popular(alias); } catch (e) { bad(`?category=${alias}`, `request failed: ${e.message}`); continue; }
        if (r.status !== 200) {
            soft(`?category=${alias} is no longer accepted (${r.status})`,
                'it used to be a hard 400, then a 200 with no filter. A third answer is news either '
                + 'way — re-read the backend taxonomy before changing the map.');
            continue;
        }
        const drums = FAMILY.drums;
        const outside = [...new Set(r.types.filter((t) => !drums.includes(t)))];
        if (outside.length) {
            ok(`?category=${alias} is still a NO-FILTER alias`,
                `${tally(r.types)} — so translating ${alias} → drums is still load-bearing. `
                + 'Passing it through would put ink and toner on a drums shelf.');
        } else {
            bad(`?category=${alias} now looks like it FILTERS to drums`,
                `${tally(r.types)}\nMeasured 2026-09-10 this alias meant "no filter". If the backend has `
                + 'made it filter, that is good news and the map comment in js/shop-page.js is now wrong — '
                + 'but verify with the backend before simplifying, because a small sample can look filtered '
                + 'by chance.');
        }
    }

    head('§3  POSITIVE CONTROL — a 200 only means something if a 400 is still possible');
    try {
        const r = await popular(probeQuery('bogus_category'));
        if (r.status === 400) {
            ok('an unknown category still 400s', 'so the 200s above are decisions, not a shrug');
        } else {
            bad('an unknown category no longer 400s', `got ${r.status} with ${r.rows.length} rows `
                + `(${tally(r.types) || 'no types'}). Every check above is now untrustworthy: if this `
                + 'endpoint answers 200 to anything, "it answered 200" proves nothing at all.');
        }
    } catch (e) { bad('positive control', `request failed: ${e.message}`); }

    head('Result');
    for (const n of notes) console.log(`  \x1b[33m~\x1b[0m ${n}`);
    if (failures.length) {
        console.log(`\n\x1b[31m${failures.length} FAILURE(S)\x1b[0m`);
        for (const f of failures) console.log(`  - ${f}`);
        process.exit(1);
    }
    console.log('\n\x1b[32mAll checks passed.\x1b[0m');
}

main().catch((e) => { console.error(e); process.exit(2); });
