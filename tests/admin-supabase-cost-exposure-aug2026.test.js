/**
 * Supplier cost must not ride the public Supabase client (ERR-170, Aug 2026)
 * =========================================================================
 *
 * `products.cost_price` is our buy price. It has never been in an API response —
 * the backend strips it — but the frontend also talks to PostgREST directly with
 * the anon key that ships in the bundle, and several admin surfaces selected the
 * column that way.
 *
 * Postgres column grants are per-ROLE, and every signed-in user of this site —
 * admin or shopper — is the same `authenticated` role. So as long as any admin
 * surface reads `cost_price` through supabase-js, the backend cannot revoke that
 * column from `authenticated`, and any self-signup account can read the whole
 * supplier-cost table. Getting these reads onto the admin REST API (which gates
 * on super_admin) is what unblocks that revoke.
 *
 * MEASURED LIVE 2026-08-17, and worth writing down because the backend brief
 * assumed otherwise:
 *   - GET /api/admin/products returns `cost_price` on list AND detail, so the
 *     migration is lossless. (The brief's product-search comment claimed "there
 *     is NO evidence /api/admin/products returns it" — there is.)
 *   - Revoking `cost_price` alone would NOT close the hole: `profit_ex_gst` and
 *     `margin_pct` are columns on the same table and each recovers the cost from
 *     the retail price. All three must go.
 *
 * This file is the enrolment gate. "Every surface has been migrated" is a claim
 * nobody can keep true by hand — public volume pricing already vanished twice
 * that way (ERR-150, ERR-160) — so the sweep runs on every test run instead.
 *
 * Run with: node --test tests/admin-supabase-cost-exposure-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'inkcartridges', 'js');
const ADMIN = path.join(JS, 'admin');

/** Every column on `products` that reveals, or reconstructs, our supplier cost. */
const COST_COLUMNS = ['cost_price', 'profit_ex_gst', 'margin_pct'];

/**
 * The ONE remaining admin surface allowed to select a cost column via supabase-js,
 * and exactly why.
 *
 * pages/products.js runs the Products list through PostgREST rather than
 * /api/admin/products because the REST endpoint cannot express three of the
 * page's filters (pack, supplier, product-type GROUP) and does not return the
 * sourcing fields (`supplier`, `supplier_sku`) that the Supplier and Origin
 * columns render — that gap is why warnIfSourcingFieldsMissing() exists.
 *
 * So dropping the column here would either blank the owner's Cost column on the
 * DEFAULT view or silently unfilter the list. Neither is acceptable, and neither
 * is fixable from the frontend: it needs those filters and fields added to
 * /api/admin/products (tracked as BF-044). Until then this entry documents the
 * exception; it must not grow.
 */
const ALLOWED = new Set(['pages/products.js']);

function adminJsFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.js')) out.push(p);
        }
    };
    walk(ADMIN);
    return out;
}

/**
 * Strip comments before scanning. Half this codebase's value is in its prose, and
 * the prose talks about `cost_price` constantly — matching it would make the gate
 * fire on documentation and train everyone to ignore it.
 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Find `.select(...)` argument strings in a source file. */
function selectArgs(src) {
    const out = [];
    const re = /\.select\(\s*(['"`])([\s\S]*?)\1/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[2]);
    // A select fed from a variable — capture those declarations too.
    const varRe = /(?:const|let|var)\s+\w*[Ss]electCols\w*\s*=\s*([\s\S]{0,600}?);/g;
    while ((m = varRe.exec(src)) !== null) out.push(m[1]);
    return out;
}

// ─── The sweep ─────────────────────────────────────────────────────────────

test('no admin supabase select carries a cost-bearing column (except the documented one)', () => {
    const offenders = [];
    for (const file of adminJsFiles()) {
        const rel = path.relative(ADMIN, file);
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        for (const arg of selectArgs(src)) {
            const hit = COST_COLUMNS.filter((c) => new RegExp(`\\b${c}\\b`).test(arg));
            if (hit.length) offenders.push(`${rel}: ${hit.join(', ')}`);
        }
    }
    const unexpected = offenders.filter((o) => !ALLOWED.has(o.split(':')[0]));
    assert.deepEqual(unexpected, [],
        'these reads keep cost_price readable by every authenticated account:\n  '
        + unexpected.join('\n  '));
});

test('the documented exception is still real — the allowlist must not outlive its reason', () => {
    // An allowlist entry that no longer matches anything is worse than none: it
    // reads as a live exception while quietly permitting nothing, and the next
    // person adds to it instead of deleting it. (ERR-063 was an allowlist that
    // silently stopped covering what it claimed to.)
    for (const rel of ALLOWED) {
        const src = stripComments(fs.readFileSync(path.join(ADMIN, rel), 'utf8'));
        const stillReads = selectArgs(src).some((arg) => /\bcost_price\b/.test(arg));
        assert.ok(stillReads,
            `${rel} no longer selects cost_price — remove it from ALLOWED and tell the backend `
            + `that phase 2 (REVOKE … FROM authenticated) is unblocked`);
    }
});

test('no admin supabase read uses select(*) on products — it drags cost in implicitly', () => {
    // The subtle half: `*` never mentions cost_price, so a grep for the column
    // name misses it entirely while the query returns it.
    const offenders = [];
    for (const file of adminJsFiles()) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        const re = /\.from\(\s*['"]products['"]\s*\)[\s\S]{0,200}?\.select\(\s*(['"`])([\s\S]*?)\1/g;
        let m;
        while ((m = re.exec(src)) !== null) {
            if (/^\s*\*/.test(m[2])) offenders.push(`${path.relative(ADMIN, file)}: select('${m[2].slice(0, 40)}…')`);
        }
    }
    assert.deepEqual(offenders, [],
        'a wildcard select returns every column, cost included:\n  ' + offenders.join('\n  '));
});

test('the ribbon reads enumerate their columns and exclude all three cost columns', () => {
    const api = fs.readFileSync(path.join(ADMIN, 'api.js'), 'utf8');
    const m = /const RIBBON_PRODUCT_COLS = ([\s\S]*?);/.exec(api);
    assert.ok(m, 'RIBBON_PRODUCT_COLS must exist as the single enumerated list');
    for (const c of COST_COLUMNS) {
        assert.ok(!new RegExp(`\\b${c}\\b`).test(m[1]), `RIBBON_PRODUCT_COLS must not include ${c}`);
    }
    assert.match(m[1], /\bsku\b/, 'and must still carry what the ribbon admin renders');
});

// ─── The storefront must be clean outright — no allowlist ──────────────────

test('NO non-admin code selects a cost column, or reads products with select(*)', () => {
    // A signed-out visitor hitting a wildcard select is the ERR-170 breakage:
    // once the column is revoked from `anon`, PostgREST fails the WHOLE query
    // with 42501, so the feature dies for logged-out users only.
    const offenders = [];
    for (const entry of fs.readdirSync(JS, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const src = stripComments(fs.readFileSync(path.join(JS, entry.name), 'utf8'));
        for (const arg of selectArgs(src)) {
            if (COST_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(arg))) {
                offenders.push(`${entry.name}: selects a cost column`);
            }
            if (/^\s*\*/.test(arg)) offenders.push(`${entry.name}: select('*')`);
        }
    }
    assert.deepEqual(offenders, [], 'storefront code must never do either:\n  ' + offenders.join('\n  '));
});

// ─── The picker migration must not have lost the cost ──────────────────────

test('the product picker still resolves a cost — migrating the source must not drop the feature', () => {
    const src = fs.readFileSync(path.join(ADMIN, 'components', 'product-search.js'), 'utf8');
    assert.match(src, /AdminAPI\.getProducts\(\{ search: q \}/,
        'the picker must fetch through the admin API');
    assert.ok(!/\.from\(\s*['"]products['"]\s*\)[\s\S]{0,200}?cost_price/.test(stripComments(src)),
        'and must no longer read cost through supabase-js');
    // productCostExGst is what invoices/quick-order call to fill "Our Cost".
    assert.match(src, /export function productCostExGst/,
        'the cost resolver must survive the migration');
    assert.match(src, /costOrNull\(/,
        'and must keep UNKNOWN distinct from $0 (ERR-068)');
});

test('the picker never renders the cost in the dropdown', () => {
    // The dropdown is the one admin surface an operator might turn toward a
    // customer. The cost reaches onPick; it must not reach the screen.
    const src = fs.readFileSync(path.join(ADMIN, 'components', 'product-search.js'), 'utf8');
    const render = src.slice(src.indexOf('render: (p) =>'), src.indexOf('onPick'));
    assert.ok(!/cost/i.test(render.replace(/\/\/.*$/gm, '')),
        'no cost may appear in the rendered dropdown row');
});
