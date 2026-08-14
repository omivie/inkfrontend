#!/usr/bin/env node
/**
 * sweep-business-pricing.mjs
 * ==========================
 * Live oracle for the B2B volume-discount matrix.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frontend never computes a business price — it renders what
 * `GET /api/business/pricing` sends. That makes the storefront immune to a
 * backend re-seed, and it makes the frontend's *recorded knowledge* of the
 * matrix rot silently instead. On 2026-08-02 the matrix was re-seeded
 * (migration 127): top discount 18% -> 10%, 4 price bands -> 6, break
 * quantities 3/5/10/20 -> 3/4/7/8 (under $100) and 2/3/... ($100+). Every
 * number recorded in tests/business-account-pricing-jul2026.test.js became
 * false, and all 74 tests stayed green, because the fixtures were inline
 * literals asserting against themselves.
 *
 * This script is the fix: it sweeps the WHOLE catalog against production and
 * writes an inert record that the test suite reads. A re-seed is then a
 * failing `npm run sweep:b2b:check` and a visible `git diff`, not a surprise
 * six weeks later.
 *
 * NOT under inkcartridges/. `vercel.json` sets `outputDirectory: "."` with the
 * Vercel project root at `inkcartridges/`, so everything in that tree is served
 * publicly (inkcartridges/scripts/fit-audit.js is live on the web right now).
 * The record contains a full per-account price list for the catalog and must
 * never deploy.
 *
 * Two passes:
 *
 *   1. CATALOG pass — anonymous `GET /api/products?page&limit`, the same public
 *      reader the storefront uses, walked to exhaustion. Hard-fails if the
 *      collected count disagrees with `pagination.total`: a plausible-but-short
 *      catalog is precisely the failure this exists to prevent.
 *
 *   2. PRICING pass — TWO ROUTES, and the catalog decides which:
 *
 *      a. If the public products carry `quantity_breaks` (BF-032 — volume
 *         pricing is public now), pass 1 already collected every ladder. Pass 2
 *         is free, needs no credentials, and issues no requests. Every row must
 *         carry the field: a product with no discount sends an EMPTY array, so
 *         a MISSING one means the ladder is only half-published and the sweep
 *         stops rather than record "no discount" for the silent half.
 *
 *      b. Otherwise the ladder is still business-only: sign in as an approved
 *         account and sweep every SKU through `/api/business/pricing` in serial
 *         chunks of 100. Credentials are mandatory here, because an anonymous
 *         sweep of a gated endpoint returns "0 ladders found" and looks clean.
 *
 *      Either way each item is normalised by the REAL `describeLadder()` loaded
 *      out of inkcartridges/js/business.js, never a reimplementation — if the
 *      sweep re-derived the collapse rule it could certify a UI that does not
 *      exist.
 *
 * Usage:
 *   node scripts/sweep-business-pricing.mjs             # sweep + write the record
 *   node scripts/sweep-business-pricing.mjs --check     # sweep + diff, never write (exit 1 on drift)
 *   node scripts/sweep-business-pricing.mjs --markdown  # print the band table for docs
 *   node scripts/sweep-business-pricing.mjs --json      # machine-readable summary on stdout
 *
 * Credentials come from .env (gitignored) or the environment — never argv,
 * which leaks into `ps`. Required only on route (b); on route (a) they are
 * optional and buy one extra thing: the cart consistency gate, which re-derives
 * a real cart's discount from the ladders and asserts it to the cent.
 *   BUSINESS_EMAIL=...
 *   BUSINESS_PASSWORD=...
 *   API_BASE=...            (optional; defaults to the Render origin)
 *
 * Exit codes: 0 clean · 1 drift (--check), a failed precondition, or a partial
 * sweep. A partial sweep NEVER writes a record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');
const RECORD_PATH = path.join(ROOT, 'tests', 'fixtures', 'business-pricing-sweep.json');

const ARGS = new Set(process.argv.slice(2));
// SAFE MODE IS THE DEFAULT (2026-08-12). This script used to WRITE the committed
// record whenever it was run without `--check` — i.e. the read-only mode was the
// opt-in one, and `npm run sweep:b2b` (the obvious thing to type when you mean
// "see if anything drifted") silently overwrote the fixture it was meant to be
// compared against. It did exactly that on 2026-08-12, replacing a July snapshot
// with a throwaway test cart; caught only by `git status`.
//
// A probe that records is a probe whose green result may be green BECAUSE it just
// overwrote the thing it was comparing against. So recording is now `--record`,
// explicit, and the mode is printed before any work starts.
//
// `--check` is still accepted and still means read-only — it is the default now,
// so the flag is a no-op kept for the committed `sweep:b2b:check` script and any
// muscle memory. Sibling scripts agree on this polarity: audit-ribbon-typeahead
// writes only under `--update-baseline`, audit-search-click-beacon never writes.
const RECORD_MODE = ARGS.has('--record');
const CHECK_ONLY = !RECORD_MODE;
const MARKDOWN = ARGS.has('--markdown');
const JSON_OUT = ARGS.has('--json');

const MIGRATION_NOTE = 'backend re-seed 2026-08-02 (migration 127, backend commit a9bff6d)';

// Mirrors Business.MAX_SKUS_PER_CALL — the backend caps ?skus= at 100.
const MAX_SKUS_PER_CALL = 100;
// Serial, not Promise.all. /api/business/pricing is rate-limited to 120/min/user,
// i.e. one call every 500ms sustained. 250ms sweeps 4,015 SKUs in 41 calls and
// trips RATE_LIMITED at chunk 25 — measured, not theorised. 650ms leaves headroom
// for the storefront if the same account has a tab open, and the whole sweep still
// finishes in well under a minute of wall clock.
const CHUNK_DELAY_MS = 650;
const RATE_LIMIT_BACKOFF_MS = 60000;
const MAX_CHUNK_ATTEMPTS = 3;
const PAGE_LIMIT = 200;

// ──────────────────────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────────────────────

/** Minimal .env reader — no dependency, and the file is gitignored. */
function loadDotEnv() {
    const p = path.join(ROOT, '.env');
    if (!fs.existsSync(p)) return;
    for (const rawLine of fs.readFileSync(p, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadDotEnv();

/**
 * Read a config constant out of the shipped config.js rather than duplicating
 * it. If the Supabase project or the API origin ever moves, the sweep follows
 * the storefront instead of quietly authenticating against the wrong tenant.
 */
function configConstant(name) {
    const src = fs.readFileSync(path.join(SITE, 'js', 'config.js'), 'utf8');
    const m = new RegExp(`${name}:\\s*'([^']+)'`).exec(src);
    if (!m) throw new Error(`config.js no longer defines ${name} — update the sweep`);
    return m[1];
}

const SUPABASE_URL = configConstant('SUPABASE_URL');
const SUPABASE_ANON_KEY = configConstant('SUPABASE_ANON_KEY');
const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';

// ──────────────────────────────────────────────────────────────────────────
// Output helpers
// ──────────────────────────────────────────────────────────────────────────

const quiet = JSON_OUT || MARKDOWN;
const say = (...a) => { if (!quiet) console.log(...a); };
const die = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The one interpreter. Loads the SHIPPED Business module and returns it, using
 * the same `new Function` shim tests/business-account-pricing-jul2026.test.js
 * uses: business.js declares `const Business = {...}` at top level and only
 * touches `window` in a trailing guard, so a minimal context suffices.
 */
function loadBusiness() {
    const src = fs.readFileSync(path.join(SITE, 'js', 'business.js'), 'utf8');
    const warnings = [];
    const factory = new Function(
        'Auth', 'API', 'Security', 'DebugLog', 'formatPrice', 'window', 'document',
        src + '\nreturn Business;'
    );
    const B = factory(
        { initialized: true, user: null, isAuthenticated: () => false, onAuthStateChange() {} },
        { get: async () => ({ ok: false }) },
        { escapeHtml: (s) => String(s), escapeAttr: (s) => String(s) },
        { log() {}, warn: (...a) => warnings.push(a.map(String).join(' ')), error() {}, info() {} },
        (n) => '$' + Number(n).toFixed(2),
        undefined,
        undefined
    );
    B.__warnings = warnings;
    return B;
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP
// ──────────────────────────────────────────────────────────────────────────

async function getJson(url, headers) {
    const res = await fetch(url, { headers: headers || {} });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`${url} -> HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`); }
    if (!res.ok && !body) throw new Error(`${url} -> HTTP ${res.status}`);
    return { status: res.status, body };
}

/** Supabase password grant -> access token. */
async function signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password })
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.access_token) {
        throw new Error(`sign-in failed (HTTP ${res.status}): ${body ? (body.error_description || body.msg || JSON.stringify(body)) : 'no body'}`);
    }
    return body.access_token;
}

// ──────────────────────────────────────────────────────────────────────────
// PASS 1 — catalog
// ──────────────────────────────────────────────────────────────────────────

/**
 * Walk /api/products anonymously. Param order is `page` then `limit` to match
 * API.CATALOG_PARAM_ORDER (js/api.js) so the sweep warms the storefront's
 * existing Cloudflare edge keys rather than minting a parallel set (ERR-124).
 */
async function collectCatalog() {
    const rows = [];
    let page = 1;
    let meta = null;
    let endedCleanly = false;
    let guard = 0;

    for (;;) {
        if (++guard > 200) throw new Error('catalog walk exceeded 200 pages — refusing to loop');
        const url = `${API_BASE}/api/products?page=${page}&limit=${PAGE_LIMIT}`;
        const { body } = await getJson(url);
        if (!body || body.ok === false) {
            throw new Error(`catalog page ${page} failed: ${JSON.stringify(body && body.error)}`);
        }
        const data = body.data || body;
        const items = data.products || data.items || (Array.isArray(data) ? data : []);
        // Pagination lives in the envelope's `meta`, NOT in `data.pagination`.
        // Reading the wrong object yields `undefined` for has_next, which reads
        // as "keep going" and walks straight off the end of the catalog into a
        // 500 (pages past total_pages return INTERNAL_ERROR, not an empty page).
        meta = body.meta || data.pagination || {};

        for (const p of items) {
            if (p && typeof p.sku === 'string' && p.sku.trim()) {
                // `quantity_breaks` on a PUBLIC product is BF-032: the ladder is
                // no longer business-only, so the catalog walk can answer pass 2
                // on its own and the sweep needs no credentials at all. Captured
                // whenever present; main() decides whether it is usable.
                rows.push({
                    sku: p.sku.trim(),
                    name: p.name || null,
                    retail_price: p.retail_price,
                    quantity_breaks: Array.isArray(p.quantity_breaks) ? p.quantity_breaks : null
                });
            }
        }
        say(`  page ${page}: +${items.length} (running ${rows.length}${meta.total ? '/' + meta.total : ''})`);

        // An EMPTY page ends pagination — a short page does not (a ?limit=200
        // that answers 198 is normal here; ERR-134).
        if (meta.has_next === false) { endedCleanly = true; break; }
        if (!items.length) { endedCleanly = true; break; }
        page++;
    }

    // De-dupe defensively; a SKU served on two pages would inflate the count
    // and make the reconciliation below pass for the wrong reason.
    const seen = new Set();
    const unique = rows.filter(r => (seen.has(r.sku) ? false : (seen.add(r.sku), true)));

    const total = Number.isFinite(Number(meta.total)) ? Number(meta.total) : null;
    if (total === null) {
        throw new Error('/api/products returned no meta.total — cannot prove the walk was complete');
    }
    if (!endedCleanly) {
        throw new Error('catalog walk did not terminate on has_next=false — refusing to sweep a possibly-truncated catalog');
    }
    if (Number.isFinite(Number(meta.total_pages)) && page !== Number(meta.total_pages)) {
        throw new Error(`catalog walk stopped on page ${page} but meta.total_pages says ${meta.total_pages}`);
    }
    if (!unique.length) throw new Error('catalog walk collected zero SKUs');

    // The backend's `meta.total` is a COUNT QUERY; the pages serve slightly
    // fewer rows than it claims (4015 served vs 4022 counted on 2026-08-02,
    // with no null SKUs and no duplicates). That gap is the backend's, not
    // ours, so it is RECORDED rather than swallowed — but a large gap means a
    // genuinely truncated walk and must stop the sweep, because a
    // wrong-but-plausible catalog is exactly what this guard exists to prevent.
    const shortfall = total - unique.length;
    if (shortfall < 0 || shortfall > Math.max(20, total * 0.01)) {
        throw new Error(
            `catalog walk collected ${unique.length} unique SKUs but meta.total says ${total} ` +
            `(shortfall ${shortfall}). Too large to be the known count-query drift; refusing to continue.`
        );
    }
    if (shortfall > 0) {
        say(`     note: meta.total ${total} exceeds the ${unique.length} rows actually served (shortfall ${shortfall}) — recorded`);
    }
    // How much of the catalog answered the pricing question by itself.
    const withLadder = unique.filter(r => r.quantity_breaks !== null).length;

    return { skus: unique, total, shortfall, withLadder };
}

/**
 * Build the pass-2 result straight out of the catalog walk.
 *
 * Only legal when EVERY row carried `quantity_breaks`. A partial answer is not
 * a smaller answer — it is an inconsistent backend, and normalising the silent
 * rows to "no discount" would put a confident, wrong matrix into the record
 * that the whole suite then asserts against. Same rule as the catalog
 * shortfall guard above: a plausible-but-incomplete sweep must stop.
 */
function ladderFromCatalog(catalog) {
    const missing = catalog.skus.filter(r => r.quantity_breaks === null);
    if (missing.length) {
        die(
            `${missing.length} of ${catalog.skus.length} public products carry no quantity_breaks ` +
            `(e.g. ${missing.slice(0, 5).map(r => r.sku).join(', ')}).\n` +
            '  A product with no volume discount must send an EMPTY array, not omit the field —\n' +
            '  otherwise "no discount" and "not implemented" are indistinguishable and the record\n' +
            '  would be confidently wrong. Refusing to sweep a half-published ladder.'
        );
    }
    const answered = new Map();
    for (const r of catalog.skus) {
        answered.set(r.sku, {
            sku: r.sku,
            found: true,
            is_active: true,
            retail_price: r.retail_price,
            quantity_breaks: r.quantity_breaks
        });
    }
    return answered;
}

// ──────────────────────────────────────────────────────────────────────────
// PASS 2 — pricing
// ──────────────────────────────────────────────────────────────────────────

async function sweepPricing(skus, token) {
    const headers = { Authorization: `Bearer ${token}` };
    const answered = new Map();
    let calls = 0;

    for (let i = 0; i < skus.length; i += MAX_SKUS_PER_CALL) {
        const chunk = skus.slice(i, i + MAX_SKUS_PER_CALL);
        const url = `${API_BASE}/api/business/pricing?skus=${encodeURIComponent(chunk.join(','))}`;

        let status, body;
        for (let attempt = 1; ; attempt++) {
            ({ status, body } = await getJson(url, headers));
            const rateLimited = status === 429 ||
                (body && body.error && body.error.code === 'RATE_LIMITED');
            if (!rateLimited) break;
            if (attempt >= MAX_CHUNK_ATTEMPTS) {
                throw new Error(
                    `pricing chunk ${calls + 1} still RATE_LIMITED after ${attempt} attempts — ` +
                    'raise CHUNK_DELAY_MS rather than retrying harder'
                );
            }
            say(`  chunk ${calls + 1}: rate limited, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s (attempt ${attempt})`);
            await sleep(RATE_LIMIT_BACKOFF_MS);
        }

        if (!body || body.ok !== true || !body.data) {
            throw new Error(`pricing chunk ${calls + 1} failed (HTTP ${status}): ${JSON.stringify(body && body.error)}`);
        }
        // The ERR-139 detector: v2 moved every price field inside
        // quantity_breaks[] and nothing shouted. A source we do not recognise
        // stops the sweep rather than recording a shape we cannot interpret.
        if (body.data.source !== 'volume') {
            throw new Error(`pricing chunk returned source="${body.data.source}", expected "volume" — the payload model has changed`);
        }
        for (const item of body.data.items || []) {
            if (item && typeof item.sku === 'string') answered.set(item.sku, item);
        }
        calls++;
        say(`  chunk ${calls}: ${chunk.length} requested, ${answered.size} answered so far`);
        if (i + MAX_SKUS_PER_CALL < skus.length) await sleep(CHUNK_DELAY_MS);
    }

    const unanswered = skus.filter(s => !answered.has(s));
    if (unanswered.length) {
        throw new Error(
            `${unanswered.length} SKU(s) were never answered (e.g. ${unanswered.slice(0, 5).join(', ')}). ` +
            'A partial sweep must not emit a record.'
        );
    }
    return answered;
}

// ──────────────────────────────────────────────────────────────────────────
// Analysis
// ──────────────────────────────────────────────────────────────────────────

/** "3:4,4:5,7:8,8:10" — the raw server ladder, ceiling percents, pre-collapse. */
function ladderKey(item) {
    return (item.quantity_breaks || [])
        .slice()
        .sort((a, b) => Number(a.min_quantity) - Number(b.min_quantity))
        .map(b => `${Number(b.min_quantity)}:${Number(b.discount_percent)}`)
        .join(',');
}

function analyse(answered, catalog, Business) {
    const totals = {
        catalog_skus: catalog.skus.length,
        catalog_pagination_total: catalog.total,
        catalog_pagination_shortfall: catalog.shortfall,
        requested: answered.size,
        answered: 0,
        not_found: 0,
        inactive: 0,
        unanswered: 0,
        empty_ladder: 0,
        no_ladder_after_normalise: 0,
        // Two floored counts, deliberately. `any_floored_raw` is how many SKUs
        // the SERVER marked floored on any rung; `any_floored` is how many still
        // show a floored rung after collapsing. They differ whenever flooring
        // flattened the tail so hard that every floored rung was a duplicate and
        // got collapsed away — the customer never sees those, so a single number
        // would answer two different questions and be wrong for one of them.
        any_floored_raw: 0,
        any_floored: 0,
        collapsed_rungs_total: 0,
        rungs_dropped_at_or_above_retail: 0
    };

    const bands = new Map();
    const floored = [];
    const noLadder = [];
    let minPct = Infinity;
    let maxPct = -Infinity;
    let cheapest = null;
    let dearest = null;
    let cleanUnder100 = null;
    let entryAtTwo = null;

    for (const item of answered.values()) {
        totals.answered++;
        if (item.found === false) { totals.not_found++; continue; }
        if (item.is_active === false) { totals.inactive++; continue; }

        const retail = Number(item.retail_price);
        const breaks = Array.isArray(item.quantity_breaks) ? item.quantity_breaks : [];
        if (!breaks.length) { totals.empty_ladder++; continue; }

        if (breaks.some(b => b && b.floored === true)) totals.any_floored_raw++;

        const ladder = Business.describeLadder(item);
        if (!ladder) {
            totals.no_ladder_after_normalise++;
            if (noLadder.length < 5) noLadder.push(item);
            continue;
        }

        totals.collapsed_rungs_total += ladder.collapsed;
        // A rung can vanish for reasons `collapsed` does not count: qty < 2, a
        // non-positive price, or business_price >= retail_price. At a 0.5%
        // entry rung the third is reachable on cheap SKUs, and the ladder then
        // silently starts a rung higher than the matrix says.
        totals.rungs_dropped_at_or_above_retail += (ladder.droppedAtOrAboveRetail || 0);
        if (ladder.anyFloored) {
            totals.any_floored++;
            if (floored.length < 10) floored.push(item);
        }

        const key = ladderKey(item);
        if (!bands.has(key)) {
            bands.set(key, { ladder: key, min: retail, max: retail, n: 0, example_sku: item.sku });
        }
        const band = bands.get(key);
        band.n++;
        if (retail < band.min) { band.min = retail; band.example_sku = item.sku; }
        if (retail > band.max) band.max = retail;

        for (const rung of ladder.breaks) {
            if (rung.percent != null) {
                if (rung.percent < minPct) minPct = rung.percent;
                if (rung.percent > maxPct) maxPct = rung.percent;
            }
        }

        if (!cheapest || retail < Number(cheapest.retail_price)) cheapest = item;
        if (!dearest || retail > Number(dearest.retail_price)) dearest = item;
        if (!cleanUnder100 && retail < 100 && !ladder.anyFloored && ladder.collapsed === 0) cleanUnder100 = item;
        if (!entryAtTwo && ladder.entry.minQuantity === 2) entryAtTwo = item;
    }

    const bandList = [...bands.values()]
        .map(b => {
            const rungs = b.ladder.split(',').map(s => s.split(':').map(Number));
            return {
                ...b,
                min: round2(b.min),
                max: round2(b.max),
                entry_quantity: rungs[0][0],
                top_quantity: rungs[rungs.length - 1][0],
                top_percent: rungs[rungs.length - 1][1]
            };
        })
        .sort((a, b) => a.min - b.min);

    return {
        totals,
        bands: bandList,
        percent_range: {
            min: Number.isFinite(minPct) ? minPct : null,
            max: Number.isFinite(maxPct) ? maxPct : null
        },
        max_effective_percent: Number.isFinite(maxPct) ? maxPct : null,
        floored_examples: floored,
        // Verbatim items whose every rung floored away to retail, so
        // describeLadder() returns null and the product renders plain retail.
        // A population that did not exist before the Aug-2026 re-seed.
        no_ladder_examples: noLadder,
        sample_ladders: {
            clean_under_100: cleanUnder100,
            entry_at_two: entryAtTwo,
            cheapest,
            most_expensive: dearest
        }
    };
}

/** The signed-in account's live cart, for the consistency gate. Optional. */
async function fetchCart(token) {
    try {
        const { body } = await getJson(`${API_BASE}/api/cart`, { Authorization: `Bearer ${token}` });
        if (!body || body.ok !== true || !body.data) return null;
        const d = body.data;
        const items = d.items || d.cart_items || [];
        // `volume_discount` is the only field name now — the `b2b_discount`
        // alias was dropped by the backend on 2026-08-10 (ERR-158).
        //
        // WHY THIS RETURNS A REASON INSTEAD OF null. The old code read both
        // spellings specifically because a hard cutover here would return null
        // and SILENTLY disable the consistency gate: the suite skips that test
        // when the cart record is absent, so it would go green while checking
        // nothing. That hazard is real and it outlives the alias — a cart that
        // is empty, unauthenticated, or simply below the volume threshold hits
        // exactly the same path. So absence is now reported as a NAMED reason
        // that travels into the record, and the gate fails on a reason it does
        // not recognise rather than skipping on a bare null.
        const isObj = (v) => !!v && typeof v === 'object';
        const b2b = isObj(d.volume_discount) ? d.volume_discount : null;
        const summaryAmount = d.summary ? d.summary.volume_discount : undefined;
        if (!items.length) return { unavailable: 'cart-empty' };
        if (!b2b) return { unavailable: 'no-volume-discount-on-cart' };
        return {
            lines: items
                .map(i => ({ sku: (i.sku || (i.product && i.product.sku) || '').trim(), quantity: Number(i.quantity) }))
                .filter(l => l.sku && Number.isFinite(l.quantity)),
            volume_discount: b2b,
            summary_volume_discount: summaryAmount
        };
    } catch {
        return null;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Record shaping + drift detection
// ──────────────────────────────────────────────────────────────────────────

/** Fields whose change means "the matrix moved" — what --check compares. */
function driftView(record) {
    return {
        source: record.source,
        bands: record.bands.map(b => ({
            ladder: b.ladder, min: b.min, max: b.max, n: b.n,
            entry_quantity: b.entry_quantity, top_quantity: b.top_quantity, top_percent: b.top_percent
        })),
        percent_range: record.percent_range,
        max_effective_percent: record.max_effective_percent,
        catalog_skus: record.totals.catalog_skus
    };
}

function markdownTable(record) {
    const rows = record.bands.map(b =>
        `| $${b.min.toFixed(2)} – $${b.max.toFixed(2)} | ${b.ladder.replace(/,/g, ', ')} | ${b.n} |`
    );
    return [
        `<!-- generated by scripts/sweep-business-pricing.mjs on ${record.captured_at} — do not hand-edit -->`,
        '',
        '| retail range | ladder (`qty:%`) | SKUs |',
        '|---|---|---|',
        ...rows,
        '',
        `Range ${record.percent_range.min}%–${record.percent_range.max}% · ` +
        `${record.totals.answered} SKUs answered · ${record.totals.any_floored} floored · ` +
        `${record.totals.empty_ladder} with no ladder.`
    ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
    const email = process.env.BUSINESS_EMAIL;
    const password = process.env.BUSINESS_PASSWORD;

    const Business = loadBusiness();
    if (typeof Business.describeLadder !== 'function') {
        die('inkcartridges/js/business.js no longer exposes describeLadder() — the sweep must not re-implement it');
    }

    // State the mode BEFORE doing any work. The whole defect this inversion fixes
    // was that nothing in the command name or its output told you it would write.
    say(`\nVolume-pricing sweep\n  API   ${API_BASE}`);
    say(RECORD_MODE
        ? `  MODE  RECORD — this run WILL OVERWRITE ${path.relative(ROOT, RECORD_PATH)}\n`
        : `  MODE  check (read-only) — nothing on disk will change; use --record to re-record\n`);

    say('1/4  catalog walk (anonymous)…');
    const catalog = await collectCatalog();
    say(`     ${catalog.skus.length} SKUs, walk terminated on has_next=false (meta.total ${catalog.total})`);

    // Which pass 2 do we need? The public catalog carrying `quantity_breaks` is
    // BF-032 — the ladder is public, so the anonymous walk we just did already
    // holds every number, and signing in would be theatre. Until then the authed
    // route is the only source and credentials are mandatory: an anonymous sweep
    // of a gated endpoint reports "0 ladders found" as a clean result, which is
    // the exact silent-zero failure this script exists to prevent.
    const publicLadder = catalog.withLadder > 0;
    say(publicLadder
        ? `     ${catalog.withLadder} carry a PUBLIC quantity_breaks — no sign-in needed\n`
        : '     no public quantity_breaks yet (pre-BF-032) — the authed route is required\n');

    let token = null;
    let answered;

    if (publicLadder) {
        say('2/4  skipping sign-in (the ladder is public)…\n');
        say('3/4  reading ladders off the catalog walk…');
        answered = ladderFromCatalog(catalog);
        say(`     ${answered.size} answered, 0 requests\n`);
        // Optional: a token still buys the cart consistency gate below.
        if (email && password) token = await signIn(email, password);
    } else {
        if (!email || !password) {
            die(
                'BUSINESS_EMAIL and BUSINESS_PASSWORD are required (put them in .env, which is gitignored).\n' +
                '  The public catalog carries no quantity_breaks yet, so the ladder is still only\n' +
                '  available from /api/business/pricing, which 401s without an approved business\n' +
                '  session — and an anonymous sweep would report "0 ladders found" as a clean\n' +
                '  result. Refusing to run.'
            );
        }
        say(`2/4  signing in as ${email}…`);
        token = await signIn(email, password);
        const status = await getJson(`${API_BASE}/api/business/status`, { Authorization: `Bearer ${token}` });
        if (!status.body || status.body.ok !== true || !status.body.data) {
            die(`/api/business/status did not answer: ${JSON.stringify(status.body)}`);
        }
        const sd = status.body.data;
        if (!['approved', 'active'].includes(sd.status)) {
            die(`this account's business status is "${sd.status}" — an approved account is required to sweep pricing`);
        }
        if ('pricing_tier' in sd) {
            console.error('⚠  /api/business/status has grown pricing_tier back — v2 retired tiers; investigate before trusting this sweep');
        }
        say(`     approved${sd.application && sd.application.company_name ? ` (${sd.application.company_name})` : ''}\n`);

        say('3/4  pricing sweep…');
        answered = await sweepPricing(catalog.skus.map(s => s.sku), token);
        say(`     ${answered.size} answered\n`);
    }

    say('4/4  analysing…');
    const analysis = analyse(answered, catalog, Business);

    // The cart consistency gate needs a real signed-in cart. Without credentials
    // the sweep is still complete — every ladder came from the public walk — but
    // that one cross-check is absent, and silence is not the same as agreement.
    if (!token) {
        say('     note: no credentials, so the cart consistency gate was NOT run\n');
    }
    const cart = token ? await fetchCart(token) : { unavailable: 'no-credentials' };
    if (cart && !cart.unavailable) {
        // The consistency gate needs the ladder for every line in the cart, not
        // just the four sample SKUs: it re-derives each line's rung from these
        // and asserts the sum equals the server's own `discount_amount`. Stored
        // verbatim so the test does no arithmetic the storefront doesn't do.
        cart.ladders = {};
        for (const line of cart.lines) {
            const item = answered.get(line.sku);
            if (item) cart.ladders[line.sku] = item;
        }
        const missing = cart.lines.filter(l => !cart.ladders[l.sku]).map(l => l.sku);
        if (missing.length) {
            console.error(`⚠  cart line(s) absent from the pricing sweep: ${missing.join(', ')} — the consistency gate will be recorded without them`);
        }
    }

    const record = {
        captured_at: new Date().toISOString(),
        api_base: API_BASE,
        source: 'volume',
        migration_note: MIGRATION_NOTE,
        ...analysis,
        cart
    };
    record.totals.unanswered = 0; // proven above; sweepPricing throws otherwise

    if (MARKDOWN) { console.log(markdownTable(record)); return; }

    // Report
    say('');
    for (const b of record.bands) {
        say(`  $${String(b.min.toFixed(2)).padStart(8)} – $${String(b.max.toFixed(2)).padEnd(9)}  ${b.ladder.padEnd(22)}  ${String(b.n).padStart(4)} SKUs`);
    }
    say('');
    say(`  bands ${record.bands.length} · range ${record.percent_range.min}%–${record.percent_range.max}%`);
    say(`  answered ${record.totals.answered} · not_found ${record.totals.not_found} · empty_ladder ${record.totals.empty_ladder} · no_ladder_after_normalise ${record.totals.no_ladder_after_normalise}`);
    say(`  floored ${record.totals.any_floored_raw} raw / ${record.totals.any_floored} still visible after collapse · collapsed rungs ${record.totals.collapsed_rungs_total} · dropped at/above retail ${record.totals.rungs_dropped_at_or_above_retail}`);
    // Name the reason. "none" read as "nothing to check here"; a named reason
    // is the difference between a gate that was satisfied and one that never ran.
    say(`  cart ${cart && !cart.unavailable
        ? `${cart.lines.length} line(s), discount_amount ${cart.volume_discount.discount_amount}`
        : `UNAVAILABLE (${(cart && cart.unavailable) || 'unknown'}) — the consistency gate did NOT run`}`);
    if (Business.__warnings.length) {
        say(`\n  describeLadder warned ${Business.__warnings.length}x:`);
        for (const w of [...new Set(Business.__warnings)].slice(0, 5)) say(`    ${w}`);
    }

    if (JSON_OUT) console.log(JSON.stringify(record, null, 2));

    if (CHECK_ONLY) {
        if (!fs.existsSync(RECORD_PATH)) {
            die(`no committed record at ${path.relative(ROOT, RECORD_PATH)}; create one with \`npm run sweep:b2b:record\``);
        }
        const committed = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
        const a = JSON.stringify(driftView(committed), null, 2);
        const b = JSON.stringify(driftView(record), null, 2);
        if (a === b) {
            console.log('\n✔ the committed sweep record still matches production.\n');
            return;
        }
        console.error('\n✖ THE B2B MATRIX HAS DRIFTED from the committed record.\n');
        const al = a.split('\n');
        const bl = b.split('\n');
        for (let i = 0; i < Math.max(al.length, bl.length); i++) {
            if (al[i] !== bl[i]) {
                if (al[i] !== undefined) console.error(`  - committed: ${al[i].trim()}`);
                if (bl[i] !== undefined) console.error(`  + live:      ${bl[i].trim()}`);
            }
        }
        console.error(
            `\n  Drift is not automatically wrong — the catalogue moves. To accept it, run\n` +
            `  \`npm run sweep:b2b:record\`, REVIEW THE DIFF, then re-read\n` +
            `  tests/business-account-pricing-jul2026.test.js and the /business page copy.\n` +
            `  Note the record embeds the CART the sweep read, so record from a cart you\n` +
            `  meant to snapshot — not whatever happened to be in the browser.\n`
        );
        process.exit(1);
    }

    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
    fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
    say(`\n✔ RECORDED — overwrote ${path.relative(ROOT, RECORD_PATH)}`);
    say(`  Review the diff before committing: git diff ${path.relative(ROOT, RECORD_PATH)}\n`);
}

main().catch(e => die(e && e.message ? e.message : String(e)));
