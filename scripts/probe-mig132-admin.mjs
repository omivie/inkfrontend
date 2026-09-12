/**
 * probe:mig132-admin — every column the admin asks PostgREST for still exists
 * ==========================================================================
 *
 * WHY THIS EXISTS (ERR-244)
 *
 * On 2026-09-10 backend migration 132 dropped `products.compatible_devices_html`.
 * Three places in this repo were still naming it, and PostgREST does not skip a
 * column it cannot find — it refuses the WHOLE statement:
 *
 *     {"code":"42703","message":"column products.compatible_devices_html does not exist"}   400
 *
 * So one dead name took ~30 live columns down with it, three times over:
 *
 *   js/admin/pages/products.js  selectCols            → the Products list fell
 *       through to the ERR-220 fallback, which drops filters SILENTLY and
 *       fabricates `total: rows.length` ("1–100 of 100" of 3,398).
 *   js/admin/api.js             RIBBON_PRODUCT_COLS   → the ribbon admin read
 *       nothing at all.
 *   js/admin/api.js             persistRichTextColumns → wrote BOTH rich-text
 *       columns in one `update()`, so the dropped one 42703'd and
 *       `description_html`'s repair died with it. That repair is the only thing
 *       keeping <b>/<i>/<u>/<a> alive past the backend's sanitiser (ERR-034),
 *       and it failed through DebugLog.warn — a no-op off localhost (ERR-193).
 *       Every product save was silently stripping the operator's formatting.
 *
 * None of that had a symptom an operator could report, and no test could see it:
 * the column lists are strings, and the schema they describe lives somewhere
 * else entirely. ***A COLUMN LIST IS A JOINT CLAIM ABOUT THE SCHEMA, AND IT IS
 * ONLY AS LIVE AS ITS DEADEST MEMBER.*** So it has to be measured against the
 * real database, not grepped.
 *
 * WHAT IT DOES
 *   §1  Parse every `select=`/`.select(` column list the admin sends to
 *       PostgREST out of the source, and ask the live database for each one.
 *   §2  Ask for each column INDIVIDUALLY, so a failure names the dead column
 *       instead of just the list it was in.
 *   §3  Positive control — a column that is genuinely gone must still 400, or
 *       §1 and §2 are passing because nothing is being checked.
 *   §4  The rich-text repair writes one column per statement.
 *
 * MODE: READ-ONLY. Every request is a GET with `limit=0` — no rows come back,
 * nothing is written, and no --record flag exists.
 *
 *   npm run probe:mig132-admin
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n\x1b[1mprobe:mig132-admin — the admin’s column lists vs the live schema (ERR-244)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY.\x1b[0m Every request is a GET with limit=0. No writes, no --record.\n');

// ── Config, read from the shipped file so it cannot drift ──────────────────
const configSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'config.js'), 'utf8');
const SUPABASE_URL = (configSrc.match(/SUPABASE_URL:\s*['"]([^'"]+)['"]/) || [])[1];
const ANON_KEY = (configSrc.match(/eyJ[A-Za-z0-9_.-]{40,}/) || [])[0];
if (!SUPABASE_URL || !ANON_KEY) cannotRun('could not read SUPABASE_URL / anon key out of js/config.js');

const API_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');
const PRODUCTS_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'products.js'), 'utf8');

/**
 * OPTIONAL OWNER TOKEN.
 *
 * The anon key cannot read `cost_price` (403 by design, ERR-170), and that one
 * column sits inside the Products list — so anonymously, §1 can only answer
 * "permission denied", which says NOTHING about whether the columns exist. A
 * probe that reports a permission answer as a schema answer is the ERR-243
 * mistake; a probe that quietly settles for it is the weaker version of the
 * same thing. With credentials it becomes a real check.
 *
 *   PROBE_EMAIL=… PROBE_PASSWORD=… npm run probe:mig132-admin
 *
 * Read-only either way: still a GET with limit=0.
 */
let AUTH_TOKEN = null;
if (process.env.PROBE_EMAIL && process.env.PROBE_PASSWORD) {
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST',
            headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: process.env.PROBE_EMAIL, password: process.env.PROBE_PASSWORD }),
        });
        const j = await res.json().catch(() => ({}));
        AUTH_TOKEN = j.access_token || null;
        console.log(AUTH_TOKEN
            ? '\x1b[36mAUTH: signed in — the full Products list can be checked.\x1b[0m\n'
            : `\x1b[33mAUTH: sign-in failed (${res.status}) — falling back to the anon key.\x1b[0m\n`);
    } catch (e) {
        console.log(`\x1b[33mAUTH: sign-in threw (${e.message}) — falling back to the anon key.\x1b[0m\n`);
    }
} else {
    console.log('\x1b[36mAUTH: anonymous. Set PROBE_EMAIL / PROBE_PASSWORD to also check cost-bearing columns.\x1b[0m\n');
}

/** Ask PostgREST for a column list. limit=0 → no rows, just a schema verdict. */
async function askFor(table, cols) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(cols)}&limit=0`;
    const res = await fetch(url, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${AUTH_TOKEN || ANON_KEY}` },
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, code: body.code, message: body.message };
}

// ── The column lists the admin actually sends ──────────────────────────────
// Parsed out of the source rather than restated here: a copy would agree with
// itself forever while the real list rotted (ERR-231 — the probe was certifying
// a replica of the thing it was checking).
const LISTS = [];
{
    const ribbon = API_SRC.match(/const RIBBON_PRODUCT_COLS = '([^']+)'/);
    if (ribbon) LISTS.push({ name: 'RIBBON_PRODUCT_COLS (js/admin/api.js)', table: 'products', cols: ribbon[1] });
    const sel = PRODUCTS_SRC.match(/const selectCols = '([^']+)'/);
    if (sel) LISTS.push({ name: 'selectCols (js/admin/pages/products.js)', table: 'products', cols: sel[1] });
}
if (!LISTS.length) cannotRun('found no column lists to check — the source shape changed, which is itself worth a look');

// Embedded relations (`brands(...)`, `product_images(...)`) are joins, not
// columns; they are kept in the whole-list check but excluded from the
// per-column pass, which is about `products` columns only.
const splitCols = (cols) => cols
    .replace(/\w+\([^)]*\)/g, '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

// ── §1 whole lists ─────────────────────────────────────────────────────────
console.log('\x1b[1m§1 every admin column list resolves against the live schema\x1b[0m');
for (const list of LISTS) {
    const r = await askFor(list.table, list.cols);
    if (r.ok) {
        ok(`${list.name} — ${splitCols(list.cols).length} columns, all resolve`);
    } else if (r.code === '42703') {
        bad(list.name,
            `PostgREST refused the WHOLE list: ${r.message}. Every other column in it is unreachable `
            + 'too — this is not a degraded read, it is a 400. §2 below names the dead column.');
    } else if (r.status === 401 || r.status === 403) {
        // Not a schema answer. An RLS/grant refusal says nothing about whether
        // the columns exist, and must never be recorded as if it did.
        soft(list.name, `${r.status} ${r.code || ''} — a permission answer, not a schema answer. `
            + 'This run cannot tell you whether these columns exist. '
            + (AUTH_TOKEN
                ? 'Even signed in — so this is RLS, and worth asking the backend about.'
                : 'Re-run with PROBE_EMAIL / PROBE_PASSWORD to check it properly '
                  + '(the list contains cost_price, which is 403 to anon by design — ERR-170).'));
    } else {
        bad(list.name, `unexpected ${r.status} ${r.code || ''} ${r.message || ''}`);
    }
    await sleep(200);
}

// ── §2 one column at a time ────────────────────────────────────────────────
console.log('\n\x1b[1m§2 each column individually — so a failure NAMES the dead one\x1b[0m');
const dead = [];
const checked = new Set();
for (const list of LISTS) {
    for (const col of splitCols(list.cols)) {
        const key = `${list.table}.${col}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const r = await askFor(list.table, col);
        if (!r.ok && r.code === '42703') dead.push({ key, where: list.name, message: r.message });
        await sleep(120);
    }
}
if (dead.length === 0) {
    ok(`all ${checked.size} distinct columns exist`);
} else {
    for (const d of dead) {
        bad(`${d.key} DOES NOT EXIST`,
            `named by ${d.where}. ${d.message}\n      `
            + 'Remove it from that list. Until you do, every column beside it is unreadable and the '
            + 'page is running on whatever fallback it has — which, for the Products list, drops '
            + 'filters silently and fabricates its own row total (ERR-220).');
    }
}

// ── §3 positive control ────────────────────────────────────────────────────
console.log('\n\x1b[1m§3 positive control — a column that IS gone must still 400\x1b[0m');
{
    const gone = await askFor('products', 'sku,compatible_devices_html');
    if (gone.ok) {
        // Either the backend rolled migration 132 back, or this probe is not
        // actually asking the database anything. Both are worth stopping for.
        bad('the control column came back ALIVE',
            'products.compatible_devices_html answered 200. Migration 132 dropped it on 2026-09-10, '
            + 'so either it was restored (tell the backend — the admin editor could be re-wired) or '
            + 'this probe is not reaching the real schema and §1/§2 above proved nothing.');
    } else if (gone.code === '42703') {
        ok('products.compatible_devices_html is gone, and asking for it is a hard 400 — §1/§2 are real');
    } else {
        soft('control inconclusive', `expected 42703, got ${gone.status} ${gone.code || ''}`);
    }
    const alive = await askFor('products', 'sku,description_html');
    if (alive.ok) ok('control — a column that DOES exist answers 200 (the check can pass, not just fail)');
    else soft('control inconclusive', `products.description_html answered ${alive.status} ${alive.code || ''}`);
}

// ── §4 the rich-text repair writes one column per statement ────────────────
console.log('\n\x1b[1m§4 the rich-text repair cannot let one dead column kill a live one\x1b[0m');
{
    const fn = API_SRC.slice(API_SRC.indexOf('async persistRichTextColumns('));
    const body = fn.slice(0, fn.indexOf('\n  },'));
    if (!body) {
        soft('persistRichTextColumns not found', 'the function was renamed — re-point this check');
    } else {
        const perColumn = /for \(const col of cols\)/.test(body) && /\{ \[col\]:/.test(body);
        if (perColumn) {
            ok('persistRichTextColumns sends ONE column per update() — a dead name takes only itself');
        } else {
            bad('persistRichTextColumns batches its columns again',
                'A single update() naming two columns is refused entirely when one of them is dropped, '
                + 'so the surviving column silently stops being repaired and the operator loses their '
                + 'formatting with no symptom. That was ERR-244.');
        }
        if (/failed: \[\]|result\.failed/.test(body)) {
            ok('and it reports WHICH columns failed, rather than a bare boolean');
        } else {
            bad('the repair result is not granular', 'a bare false reads the same as "nothing to do"');
        }
    }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mSummary\x1b[0m');
console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
if (notes.length) {
    console.log('\n  Notes (not failures):');
    for (const n of notes) console.log(`    ~ ${n}`);
}
if (failures.length) {
    console.log('\n\x1b[31m  FAILURES\x1b[0m');
    for (const f of failures) console.log(`    ✗ ${f}`);
    process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — every column the admin asks for exists.');
