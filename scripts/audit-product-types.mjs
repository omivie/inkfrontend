#!/usr/bin/env node
/**
 * audit-product-types.mjs
 * =======================
 * Live oracle for the `product_type` vocabulary.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-13 the backend added a product type — `maintenance_box`, for
 * waste-ink collectors — and the handoff said the frontend needed "~2 small
 * changes (one <option>, one error-toast tweak)".
 *
 * The frontend was in fact carrying SIX independent type vocabularies, and the
 * new value was missing from every one. Nothing broke. A filter for a type that
 * does not exist returns zero rows; a product whose type is not in a membership
 * list is quietly filed under "ink"; a label map with no entry yields an empty
 * string and the meta title just… has a gap where the noun goes. This is the
 * fourth time the same shape of bug has been logged here (ERR-075, ERR-132,
 * ERR-150, ERR-160), and every time it was found by a person noticing, not by a
 * check failing.
 *
 * The audit runs BOTH directions, because both have bitten:
 *
 *   A type we OFFER that has ZERO live rows        → the `drum`/`paper`/
 *                                                    `maintenance_kit` trap: a
 *                                                    dropdown entry that can
 *                                                    only ever return nothing.
 *   A type that is LIVE and we do not OFFER        → the `maintenance_box`
 *                                                    trap: real products the
 *                                                    admin cannot filter to,
 *                                                    re-select, or label.
 *
 * NOT under inkcartridges/. `vercel.json` sets `outputDirectory: "."` with the
 * Vercel project root at `inkcartridges/`, so everything in that tree is served
 * publicly. Audit tooling belongs in this directory.
 *
 * ONE VOCABULARY. Every check loads the SHIPPED lists out of
 * inkcartridges/js — the admin vocabulary module, api.js's category map,
 * shop-page.js's consumable list, the product-codes category map. It never
 * declares a type list of its own: an audit carrying its own copy certifies a
 * UI that does not exist.
 *
 * READ-ONLY. There is no --record, no --update-baseline, no write path of any
 * kind, and the mode is printed on every run. A probe that can record is a
 * probe that can pass because it just overwrote what it was comparing against
 * (that is how `sweep:b2b` ate a committed fixture on 2026-08-12). If this
 * script is ever taught to write, it stops being evidence.
 *
 * Usage:
 *   npm run audit:types
 *   node scripts/audit-product-types.mjs --json     # machine-readable
 *
 * Env:
 *   API_BASE=...   (optional; defaults to the Render origin)
 *
 * Exit codes: 0 clean · 1 any drift, or an unreachable/short catalogue.
 *
 * An unreachable API is a FAILURE, never a silent pass. "I could not read the
 * catalogue" and "the catalogue agrees with us" are different sentences, and
 * collapsing them is the absence-read-as-zero mistake itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');

const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const PAGE_LIMIT = 200;

/**
 * Pace between catalogue pages.
 *
 * This walks ~21 pages of /api/products back to back. On 2026-08-31 the backend
 * reported that hammering that endpoint reliably 502s their whole instance —
 * health endpoint included — for several minutes (ERR-188 is that outage from
 * this side). Same constant, same reason, in every script that walks it.
 */
const REQUEST_DELAY_MS = Number(process.env.PROBE_DELAY_MS || 650);

const MAX_PAGE_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = 20000;

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
const rule = (ch = '─') => say(ch.repeat(78));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Two buckets, and the difference decides the exit code.
//
//   findings          — FRONTEND-owned drift. We can fix these in this repo, so
//                       they block, always, with no baseline to age into silence.
//   backendConditions — states of the live catalogue we do not control (the
//                       known pagination shortfall, reported 2026-08-03). Always
//                       PRINTED, never swallowed, but they cannot make a
//                       correct frontend fail forever — that is how a gate gets
//                       --warn-only'd into irrelevance.
//
// A backend condition is not a pass: it is named, counted and repeated in the
// summary line, so "clean" never quietly means "clean, apart from the part I
// could not read".
const findings = [];
const backendConditions = [];
const notes = [];
const fail = (check, subject, detail) => findings.push({ check, subject, detail });
const backendCondition = (check, subject, detail) => backendConditions.push({ check, subject, detail });
const note = (msg) => { notes.push(msg); };

// ──────────────────────────────────────────────────────────────────────────
// The one interpreter — load the SHIPPED vocabularies
// ──────────────────────────────────────────────────────────────────────────

function readSite(rel) {
    const p = path.join(SITE, rel);
    if (!fs.existsSync(p)) {
        console.error(`\n✖ cannot find ${p} — is this running from the repo root?\n`);
        process.exit(1);
    }
    return fs.readFileSync(p, 'utf8');
}

/** The string values of an array literal assigned to `name` in `src`. */
function arrayLiteral(src, name, where) {
    const m = src.match(new RegExp(`${name}\\s*[:=]\\s*\\[([^\\]]*)\\]`));
    if (!m) {
        console.error(`\n✖ could not read ${name} out of ${where} — the audit cannot certify a list it cannot find\n`);
        process.exit(1);
    }
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

async function loadVocabulary() {
    // The admin vocabulary is a plain ES module with no DOM references, so it
    // imports directly — the real objects, not a reconstruction.
    const typesUrl = new URL(`file://${path.join(SITE, 'js/admin/utils/product-types.js')}`);
    const types = await import(typesUrl.href);
    if (!Array.isArray(types.PRODUCT_TYPES) || !types.PRODUCT_TYPES.length) {
        console.error('\n✖ product-types.js did not export a usable PRODUCT_TYPES\n');
        process.exit(1);
    }

    const apiSrc = readSite('js/api.js');
    const shopSrc = readSite('js/shop-page.js');
    const codesSrc = readSite('js/admin/utils/product-codes.js');

    // PRODUCT_TYPE_TO_SHOP_CATEGORY, parsed from its object literal.
    const catBlock = codesSrc.match(/PRODUCT_TYPE_TO_SHOP_CATEGORY\s*=\s*\{([\s\S]*?)\n\};/);
    if (!catBlock) {
        console.error('\n✖ could not read PRODUCT_TYPE_TO_SHOP_CATEGORY out of utils/product-codes.js\n');
        process.exit(1);
    }
    const shopCategoryByType = Object.fromEntries(
        [...catBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(m => [m[1], m[2]]));

    return {
        types,
        apiDrums: arrayLiteral(apiSrc, 'drums', 'js/api.js _CATEGORY_PRODUCT_TYPES'),
        shopConsumables: arrayLiteral(shopSrc, 'const CONSUMABLE_PRODUCT_TYPES', 'js/shop-page.js'),
        shopCategoryByType,
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Catalogue walk
// ──────────────────────────────────────────────────────────────────────────

async function getJsonWithBackoff(url) {
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
        let body = null;
        try {
            // GET, never HEAD. A HEAD probe against this origin once produced a
            // fake regression report (ERR-159) — the edge answers it differently.
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            body = await res.json();
        } catch (err) {
            if (attempt === MAX_PAGE_ATTEMPTS) throw new Error(`${url}: ${err.message}`);
            await sleep(1500 * attempt);
            continue;
        }
        const code = body && body.error && body.error.code;
        if (code !== 'RATE_LIMITED') return body;
        if (attempt === MAX_PAGE_ATTEMPTS) break;
        say(`    rate limited — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`);
        await sleep(RATE_LIMIT_BACKOFF_MS);
    }
    throw new Error(`rate limited after ${MAX_PAGE_ATTEMPTS} attempts: ${url}`);
}

/**
 * Walk /api/products anonymously. Param order is `page` then `limit` to match
 * API.CATALOG_PARAM_ORDER (js/api.js) so the sweep warms the storefront's
 * existing Cloudflare edge keys rather than minting a parallel set (ERR-124).
 */
async function collectCatalog() {
    const rows = [];
    let page = 1;
    let meta = null;
    let removedFromPage = 0;
    let sawRemovedKey = false;
    let endedCleanly = false;
    let guard = 0;

    say(`\nWalking ${API_BASE}/api/products …`);
    for (;;) {
        if (++guard > 200) throw new Error('catalog walk exceeded 200 pages — refusing to loop');
        if (page > 1) await sleep(REQUEST_DELAY_MS);
        const body = await getJsonWithBackoff(`${API_BASE}/api/products?page=${page}&limit=${PAGE_LIMIT}`);
        if (!body || body.ok === false) {
            throw new Error(`catalog page ${page} failed: ${JSON.stringify(body && body.error)}`);
        }
        const data = body.data || body;
        const items = data.products || data.items || (Array.isArray(data) ? data : []);
        meta = body.meta || data.pagination || {};
        // The API counts `total` BEFORE its per-page pack guard and dedup run, so a
        // page can legitimately return fewer rows than the total implies. Since
        // 2026-08-31 it reports how many it dropped, and the gap reconciles exactly:
        //     sum(returned) + sum(removed_from_page) === total
        // Count the KEY, not a truthy value: a page that removed nothing reports 0,
        // and an endpoint that never gained the field also reads 0.
        if (Object.prototype.hasOwnProperty.call(meta, 'removed_from_page')) {
            sawRemovedKey = true;
            removedFromPage += Number(meta.removed_from_page) || 0;
        }
        rows.push(...items.filter(p => p && typeof p.sku === 'string' && p.sku.trim()));
        say(`  page ${page}: +${items.length} (running ${rows.length}${meta.total ? '/' + meta.total : ''})`);

        if (meta.has_next === false || items.length === 0) { endedCleanly = true; break; }
        page++;
    }

    if (!endedCleanly) throw new Error('catalog walk did not terminate on has_next=false');
    if (rows.length === 0) throw new Error('catalog walk returned ZERO products — refusing to report "clean"');

    // Loud but not fatal: report the shortfall AND keep auditing what is
    // readable. Partial-ness belongs in the result, never swallowed.
    if (typeof meta.total === 'number' && rows.length !== meta.total) {
        if (sawRemovedKey && removedFromPage === Math.abs(meta.total - rows.length)) {
            // Fully explained. Reporting a solved gap as an open backend condition
            // makes a fixed thing read as a live limitation (ERR-184/186).
            note(`meta.total claims ${meta.total}; ${rows.length} returned + ${removedFromPage} removed_from_page reconciles exactly. Nothing is hiding in the difference.`);
        } else {
        backendCondition('L0-catalogue-count-mismatch', `${API_BASE}/api/products`,
                `walked to has_next=false and collected ${rows.length} products, but meta.total claims ${meta.total} — ${Math.abs(meta.total - rows.length)} row(s) are counted by the API but never served by it. Known and reported to the backend 2026-08-03 (the colour audit carries the same finding). Everything below was checked against the ${rows.length} rows that ARE reachable: a type existing ONLY in the gap would look absent here, so "offered but empty" is a weaker claim than usual on this run.`);
        }
    }
    return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Checks
// ──────────────────────────────────────────────────────────────────────────

function audit(vocab, rows) {
    const { types, apiDrums, shopConsumables, shopCategoryByType } = vocab;
    const {
        PRODUCT_TYPES, PRODUCT_TYPE_LABELS, RETIRED_PRODUCT_TYPES,
        TYPE_FILTER_OPTIONS, TYPE_FILTER_GROUPS, productTypeNoun,
    } = types;

    const live = new Map();          // product_type → count
    let untyped = 0;
    for (const p of rows) {
        const t = (p.product_type || '').trim();
        if (!t) { untyped++; continue; }
        live.set(t, (live.get(t) || 0) + 1);
    }

    say('\nLIVE product_type distribution');
    rule();
    const sorted = [...live.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, n] of sorted) {
        const offered = PRODUCT_TYPES.includes(t);
        say(`  ${String(n).padStart(5)}  ${t.padEnd(20)} ${offered ? '' : '  ← NOT IN THE FE VOCABULARY'}`);
    }
    if (untyped) note(`${untyped} live product(s) have no product_type at all — they fall through every type-led surface to a name-based guess.`);

    say('\nChecks');
    rule();

    // T1 — a type we offer that matches nothing. The drum/paper trap.
    //
    // `printer` is exempt: printers are a separate admin tab backed by a
    // different table, and /api/products does not serve them. An exemption is
    // written down here rather than silently skipped.
    const OFFER_EXEMPT = new Set(['printer']);
    for (const t of PRODUCT_TYPES) {
        if (OFFER_EXEMPT.has(t)) continue;
        if (!live.has(t)) {
            fail('T1-offered-but-empty', t,
                `PRODUCT_TYPE_OPTIONS offers '${t}' but the live catalogue has zero rows with it. Either the type is dead (retire it — see RETIRED_PRODUCT_TYPES) or nothing has been created with it yet. Selecting it in the type filter returns an empty table with no explanation.`);
        }
    }

    // T2 — a live type we do not offer. The maintenance_box trap.
    for (const [t, n] of live) {
        if (PRODUCT_TYPES.includes(t)) continue;
        fail('T2-live-but-unoffered', t,
            `${n} live product(s) carry product_type '${t}', which no frontend menu offers. Their rows cannot be filtered to, their type cannot be re-selected in the editor without falling back to the "(legacy)" option, and PRODUCT_TYPE_LABELS has no label for them.`);
    }

    // T3 — a live type with no admin label.
    for (const [t, n] of live) {
        if (PRODUCT_TYPE_LABELS[t] || RETIRED_PRODUCT_TYPES[t]) continue;
        fail('T3-live-but-unlabelled', t, `${n} live product(s) carry '${t}' and no vocabulary entry names it — the drawer prints the raw enum.`);
    }

    // T4 — a live type with no SEO noun. An empty noun is an empty word in a
    // customer-facing meta title, which is how this was noticed at all.
    for (const [t, n] of live) {
        if (productTypeNoun(t)) continue;
        fail('T4-live-but-no-seo-noun', t, `${n} live product(s) carry '${t}' and generateSEO() has no noun for it — their generated meta title says nothing about what the product is.`);
    }

    // T5 — every filter value still resolves to something real.
    const groupKeys = new Set(Object.keys(TYPE_FILTER_GROUPS));
    for (const opt of TYPE_FILTER_OPTIONS) {
        if (!opt.value) continue;
        if (groupKeys.has(opt.value)) {
            const members = TYPE_FILTER_GROUPS[opt.value];
            const total = members.reduce((s, t) => s + (live.get(t) || 0), 0);
            if (!total) fail('T5-filter-group-empty', opt.value, `the "${opt.label}" umbrella expands to [${members.join(', ')}] and matches zero live rows.`);
            continue;
        }
        if (!PRODUCT_TYPES.includes(opt.value)) {
            fail('T5-filter-value-not-a-type', opt.value,
                `the "${opt.label}" filter value is neither a real product_type nor a group key — it silently returns nothing (this is exactly what 'drum' and 'paper' did).`);
        }
    }

    // T6 — the drums family must agree across the three surfaces that carry it.
    // A facet count computed from a different list than the query it labels is
    // a WRONG number, which reads as confidently as a right one.
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (!eq(apiDrums, shopConsumables)) {
        fail('T6-drums-family-drift', 'api.js vs shop-page.js',
            `API._CATEGORY_PRODUCT_TYPES.drums = [${apiDrums.join(', ')}] but shop-page CONSUMABLE_PRODUCT_TYPES = [${shopConsumables.join(', ')}]. The request side and the facet-count side must be the same membership.`);
    }
    for (const t of apiDrums) {
        if (shopCategoryByType[t] !== 'drums') {
            fail('T6-drums-family-drift', t,
                `api.js files '${t}' under the drums category but PRODUCT_TYPE_TO_SHOP_CATEGORY says '${shopCategoryByType[t] || '(missing)'}' — the drawer's code picker would scope it wrongly, or offer nothing.`);
        }
    }

    // T7 — every live type reaches a /shop category (or is exempt).
    for (const [t, n] of live) {
        if (OFFER_EXEMPT.has(t)) continue;
        if (!shopCategoryByType[t]) {
            fail('T7-no-shop-category', t, `${n} live product(s) carry '${t}' with no entry in PRODUCT_TYPE_TO_SHOP_CATEGORY — the product drawer's code picker has nothing to scope against.`);
        }
    }

    // T8 — a retired type must actually be dead. If rows come back, the
    // retirement was wrong and the menu is hiding real products.
    for (const t of Object.keys(RETIRED_PRODUCT_TYPES)) {
        if (live.has(t)) {
            fail('T8-retired-type-is-alive', t,
                `'${t}' is listed as retired, but ${live.get(t)} live product(s) still carry it. A retired type is hidden from every menu — those products cannot be filtered to or re-typed.`);
        }
    }

    return { live: Object.fromEntries(sorted), untyped, total: rows.length };
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

async function main() {
    say('');
    rule('═');
    say('  PRODUCT TYPE AUDIT — the frontend vocabulary vs the live catalogue');
    say(`  MODE: READ-ONLY (this script has no write path — nothing is recorded)`);
    say(`  API:  ${API_BASE}`);
    rule('═');

    const vocab = await loadVocabulary();
    say(`\nShipped vocabulary: ${vocab.types.PRODUCT_TYPES.length} offered type(s), ` +
        `${Object.keys(vocab.types.RETIRED_PRODUCT_TYPES).length} retired.`);

    let rows;
    try {
        rows = await collectCatalog();
    } catch (err) {
        console.error(`\n✖ CATALOGUE UNREADABLE — ${err.message}`);
        console.error('  This is a FAILURE, not a pass. Nothing was verified.\n');
        process.exit(1);
    }

    const summary = audit(vocab, rows);

    if (!findings.length) {
        say('  ✓ every offered type has live products');
        say('  ✓ every live type is offered, labelled and has an SEO noun');
        say('  ✓ every filter value resolves to real rows');
        say('  ✓ the drums family agrees across api.js, shop-page.js and product-codes.js');
        say('  ✓ no retired type still has products');
    } else {
        for (const f of findings) say(`  ✖ [${f.check}] ${f.subject}\n      ${f.detail}`);
    }

    if (backendConditions.length) {
        say('\nBackend conditions — NOT frontend drift, and NOT ignored');
        rule();
        for (const f of backendConditions) say(`  ! [${f.check}] ${f.subject}\n      ${f.detail}`);
    }

    if (notes.length) {
        say('\nNotes');
        rule();
        for (const n of notes) say(`  · ${n}`);
    }

    const verdict = findings.length
        ? `✖ ${findings.length} frontend finding(s)`
        : (backendConditions.length
            ? `✓ frontend vocabulary clean, with ${backendConditions.length} backend condition(s) above`
            : '✓ clean');

    say('');
    rule('═');
    say(`  ${verdict} — ${summary.total} products, ${Object.keys(summary.live).length} distinct type(s)`);
    rule('═');
    say('');

    if (JSON_OUT) {
        console.log(JSON.stringify({
            mode: 'read-only', api_base: API_BASE, ...summary, findings, backend_conditions: backendConditions, notes,
        }, null, 2));
    }

    process.exit(findings.length ? 1 : 0);
}

main().catch(err => {
    console.error(`\n✖ audit crashed: ${err && err.stack || err}\n`);
    process.exit(1);
});
