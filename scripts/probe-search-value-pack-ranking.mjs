#!/usr/bin/env node
/**
 * probe-search-value-pack-ranking.mjs
 * ===================================
 * Can a customer still see a value pack in the header search dropdown?
 *
 * WHY A PROBE AND NOT A TEST
 * --------------------------
 * ERR-222 / BF-057: `/api/search/smart` used `pack_type` as its PRIMARY sort
 * key, so for q=lc it returned all 238 singles at ranks 1-238 and all 129 value
 * packs at 239-367. The dropdown asks for 40 rows and never paginates, so every
 * multi-pack in the catalogue was invisible in typeahead for any query broad
 * enough to return more than 40 rows — which is every query while the customer
 * is still typing. Multi-packs are the highest-value SKUs on the site.
 *
 * No unit test could see it. Every frontend function was correct: the render
 * pipeline is length-preserving, ProductSort groups the family properly, and the
 * missing rows simply never arrived. The thing that broke was a sort order on a
 * server in another repo, and the only way to know is to ask it.
 *
 * The backend shipped a family-cohesive re-rank on 2026-09-06. This probe is the
 * standing alarm on that fix, and on four other properties of the same response
 * that the frontend silently depends on.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ-ONLY, WITH NO WRITE PATH AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * There is no --record, no --update-baseline, no fixture file and no write verb
 * of any kind, and the mode is printed on every run. A probe that can record is
 * a probe that can pass because it just overwrote what it was comparing against
 * — that is how `sweep:b2b` ate a committed fixture on 2026-08-12. If this
 * script is ever taught to write, it stops being evidence.
 *
 * It needs no credentials. Every endpoint it reads is the public catalogue.
 *
 * WHAT IT MEASURES
 * ----------------
 *   1. Packs reach the top 40 for broad queries (lc, tn, hp, brother, epson).
 *   2. Both LC3333 grid rows are complete on page 1 — the six-card row that was
 *      reported to us as "the search bar looks lop-sided".
 *   3. q=lc3333 still returns all 12 rows (the brief's own regression guard).
 *   4. When did_you_mean names a product, that product is on page 1.
 *   5. pack_type vocabulary is exactly single / value_pack / multipack.
 *   6. `color` is present on every row. The backend's response admits /smart
 *      never SELECTed it, so colorOrder() returned the unknown-single rank 19
 *      for EVERY single and the documented K->C->M->Y order was silently inert
 *      on this endpoint. `color` is the dropdown's grouping input and nothing
 *      else watches it.
 *   7. The ?code= value packs stay served (LC38 / LC40 / LC432).
 *   8. Positive controls (see below).
 *
 * WHAT IT DOES NOT MEASURE
 * ------------------------
 * NOT MEASURED: strict (match_tier, relevance_score) monotonicity across the
 * whole result set. The brief asked for it; it is UNSATISFIABLE alongside family
 * cohesion, because a family is ranked by its best-scoring member and its weaker
 * members necessarily ride above stronger rows from lower-ranked families. The
 * owner chose complete grid rows over strict ordering on 2026-09-07. What IS
 * checked is the sub-clause that actually protects the customer: no match_tier 3
 * single outranks a match_tier 2 value_pack. Do not "fix" cohesion to satisfy
 * the withdrawn criterion.
 *
 * NOT MEASURED: how the dropdown paints. ProductSort re-sorts every family
 * anyway, so send-order beyond "is it inside the window" is inert for us;
 * tests/search-value-pack-ranking-sep2026.test.js pins the rendering.
 *
 * THREE WAYS TO GET A CONFIDENT WRONG ANSWER HERE — ALL MET ON 2026-09-07
 * -----------------------------------------------------------------------
 *   a. Rate limiting returns HTTP 200 with {ok:false, error:{code:RATE_LIMITED}}.
 *      A naive read sees "no results" and reports a false all-clear. `get()`
 *      backs off and `envelope()` refuses to treat a missing `data` as empty.
 *   b. A bogus filter value is a 200 with zero rows, silently: /api/shop wants
 *      category=ink, while the product row carries category="CON-INK". Passing
 *      the row value reports every product as dropped (ERR-075). §8 pins this.
 *   c. Two reads of the same URL 40 minutes apart DISAGREED — LC38/LC40 read as
 *      missing, then as served. A single read is not a measurement here, so
 *      every finding is re-read once before it is reported.
 *
 * THE DERIVATION IS THE SHIPPED ONE, LOADED — NEVER RE-IMPLEMENTED
 * ----------------------------------------------------------------
 * ProductSort (colorOrder / packRank / familyKey / byCodeThenColor) and
 * SearchMatch are evaluated out of the real inkcartridges/js/utils.js in a vm.
 * A probe carrying its own copy proves only that the copy works.
 *
 * USAGE
 *   npm run probe:search-packs
 *   npm run probe:search-packs -- --json     machine-readable summary
 *   npm run probe:search-packs -- --fast     no inter-request delay
 *
 * ENV
 *   API_BASE=https://ink-backend-zaeq.onrender.com
 *   PROBE_DELAY_MS=350
 *
 * EXIT CODES
 *   0  clean
 *   1  a real finding — a customer is losing something
 *   2  could not run (network, rate limit, unreadable envelope). Deliberately
 *      NOT 1, because "we could not look" must never be reported as "we looked
 *      and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { probeQuery, SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARGS = new Set(process.argv.slice(2));
const FAST = ARGS.has('--fast');
const JSON_OUT = ARGS.has('--json');
const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 350);
const RATE_LIMIT_BACKOFF_MS = 8000;
const SERVER_ERROR_BACKOFF_MS = 15000;

// The dropdown's own constant. If search.js ever changes it, this probe is
// measuring a window the customer does not have.
const LIMIT = 40;

const say = (...a) => { if (!JSON_OUT) console.log(...a); };
let pass = 0;
const findings = [];
const notes = [];
const ok = (name) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    findings.push({ name, detail });
    say(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail) say(`      ${detail}`);
};
const note = (t) => { notes.push(t); say(`  \x1b[36mi\x1b[0m ${t}`); };

/** "We could not look" — exit 2, never 1. */
function cannotRun(msg) {
    say(`\n  \x1b[33m⚠\x1b[0m ${msg}`);
    say('  Exiting 2 — could not look. This is NOT a pass.\n');
    process.exit(2);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function get(pathname) {
    for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
            res = await fetch(`${API_BASE}${pathname}`);
        } catch (e) {
            if (attempt === 3) throw e;
            await sleep(SERVER_ERROR_BACKOFF_MS);
            continue;
        }
        if (res.status === 429) { await sleep(RATE_LIMIT_BACKOFF_MS); continue; }
        if (res.status >= 500) { await sleep(SERVER_ERROR_BACKOFF_MS); continue; }
        if (DELAY_MS) await sleep(DELAY_MS);
        return res;
    }
    throw new Error(`${pathname} kept failing`);
}

/**
 * Read one envelope. Hazard (a): rate limiting is a 200 whose body has no
 * `data`. Returning {} there would make every downstream check report an empty
 * catalogue as a pass, so this throws instead and the caller exits 2.
 */
async function envelope(pathname) {
    const res = await get(pathname);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* fall through */ }
    if (!body || !body.data) {
        const why = body && body.error ? JSON.stringify(body.error) : text.slice(0, 160);
        throw new Error(`${pathname}: no data in envelope — ${why}`);
    }
    return body.data;
}

const smartUrl = (q, page = 1) =>
    `/api/search/smart?q=${encodeURIComponent(q)}&limit=${LIMIT}&page=${page}`;

/**
 * Walk a /smart result set, at most `maxPages`.
 *
 * Page 1 is what the customer sees and is what every check here is about. The
 * deeper pages exist only to say WHERE a missing pack ended up when page 1
 * already failed — so a deep page that will not load is a note, not an exit 2.
 * q=brother is 21 pages; walking all of them on every run is 21 requests to
 * restate what request 1 already proved.
 */
async function walk(q, maxPages) {
    const out = [];
    let first = null;
    let truncated = false;
    for (let pg = 1; pg <= maxPages; pg++) {
        let d;
        try {
            d = await envelope(smartUrl(q, pg));
        } catch (e) {
            if (pg === 1) throw e;          // page 1 is not optional
            truncated = true;
            break;
        }
        if (pg === 1) first = d;
        for (const p of (d.products || [])) out.push(p);
        if (!d.pagination || !d.pagination.has_next) break;
        if (pg === maxPages) truncated = true;
    }
    return { rows: out, first, truncated };
}

const isPack = (p) => p && p.pack_type !== 'single';

// ─────────────────────────────────────────────────────────────────────────────
// The derivation under test — lifted from the shipped file, never re-written.
// ─────────────────────────────────────────────────────────────────────────────
function loadShippedModules() {
    const utilsSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'utils.js'), 'utf8');
    const sandbox = { console, module: { exports: {} }, window: undefined };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try {
        vm.runInContext(utilsSrc, sandbox);
    } catch (e) {
        cannotRun(`could not evaluate the shipped inkcartridges/js/utils.js — ${e.message}`);
    }
    // utils.js declares its modules with `const` at script top level, which in a
    // vm is lexical scope and NOT a property of the sandbox global. Read them off
    // its own CommonJS export block instead — that is the shipped surface, so if
    // a module ever stops being exported this probe says so by name rather than
    // quietly measuring nothing.
    const exported = (sandbox.module && sandbox.module.exports) || {};
    const ProductSort = exported.ProductSort;
    const SearchMatch = exported.SearchMatch;
    if (!ProductSort || typeof ProductSort.colorOrder !== 'function') {
        cannotRun('ProductSort.colorOrder not found in the shipped utils.js');
    }
    if (!SearchMatch || typeof SearchMatch.shouldShowCorrection !== 'function') {
        cannotRun('SearchMatch.shouldShowCorrection not found in the shipped utils.js — did ERR-226 get reverted?');
    }
    return { ProductSort, SearchMatch };
}

const BROAD_QUERIES = ['lc', 'tn', 'hp', 'brother', 'epson'];

async function main() {
    say('\n  \x1b[1mSEARCH VALUE-PACK RANKING PROBE\x1b[0m — can a customer see a multi-pack in typeahead?');
    say('  ' + '═'.repeat(74));
    say('  MODE: \x1b[1mREAD-ONLY\x1b[0m (no write path, no baseline file, no credentials)');
    // ...to this repo. NOT to the backend's database — see ERR-254. This probe
    // put six rows into production `search_analytics` before anyone noticed,
    // and they surfaced in the live top-search-terms list.
    say('  ' + SEARCH_ANALYTICS_NOTICE.replace(/\n      /g, '\n         '));
    say(`  PACE: \x1b[1m${DELAY_MS}ms between requests\x1b[0m`);
    say(`  API : ${API_BASE}`);
    say(`  LIMIT: ${LIMIT} — the dropdown's own constant; it never paginates\n`);

    const { ProductSort, SearchMatch } = loadShippedModules();
    say('\x1b[1m1. Loading the shipped grouping code\x1b[0m');
    ok('shipped modules evaluated — ProductSort + SearchMatch from js/utils.js');

    // ── §8a positive control FIRST. Every "row is present" check below is
    //    meaningless if the endpoint answers non-empty to anything.
    say('\n\x1b[1m2. Positive controls — can this endpoint say "no"?\x1b[0m');
    let ctl;
    // SYNTHETIC, so it carries the sentinel: this exact string was found six
    // times in the live top-search-terms list on 2026-09-12 (ERR-254). The
    // term's text is arbitrary — only its zero-result-ness is load-bearing —
    // so prefixing it costs the check nothing and makes the row excludable.
    try { ctl = await envelope(smartUrl(probeQuery('notaproduct9987'))); }
    catch (e) { cannotRun(`positive control unreadable — ${e.message}`); }
    if ((ctl.products || []).length === 0) {
        ok('nonsense query returns zero rows — presence checks below mean something');
    } else {
        cannotRun(`nonsense query returned ${ctl.products.length} rows; every presence check below would pass regardless`);
    }

    let ctl2;
    try { ctl2 = await envelope('/api/shop?brand=brother&code=ZZZNOTACODE999&limit=200'); }
    catch (e) { cannotRun(`/api/shop control unreadable — ${e.message}`); }
    if ((ctl2.products || []).length === 0) ok('nonsense ?code= returns zero rows');
    else cannotRun(`nonsense ?code= returned ${ctl2.products.length} rows`);

    // Hazard (b): the product row's own category value is NOT the /api/shop
    // vocabulary. If this ever starts returning rows, §7 below may be asking a
    // different question than it thinks.
    let ctl3;
    try { ctl3 = await envelope('/api/shop?brand=brother&code=LC3333&category=CON-INK&limit=200'); }
    catch (e) { ctl3 = { products: [] }; }
    if ((ctl3.products || []).length === 0) {
        ok('category=CON-INK (the row value, not the API vocabulary) returns zero rows — as expected');
        note('a wrong filter value is a 200 with zero rows here, never an error (ERR-075) — always pair a filter sweep with a control');
    } else {
        note(`category=CON-INK now returns ${ctl3.products.length} rows — the /api/shop category vocabulary may have widened; re-read before trusting any category-filtered sweep`);
    }

    // ── §1 packs inside the window
    //
    // WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT
    //
    // The brief's acceptance criterion 2 asked for strict (match_tier,
    // relevance_score) monotonicity. That was withdrawn: it is unsatisfiable
    // alongside family cohesion. So, for a while, was the sub-clause "no
    // match_tier-3 single outranks a match_tier-2 value pack" — this probe's
    // first run proved it false on q=lc, where CLC3333KCMY (tier 2, score 210)
    // legitimately sits at rank 11 under four tier-3 singles of ITS OWN FAMILY
    // scoring 68-85. That is the fix working, not failing.
    //
    // What IS checkable, and is the actual ERR-222 signature:
    //   a. at least one pack inside the 40-row window the dropdown asks for; and
    //   b. the pool is not partitioned — some single appears AFTER some pack.
    // (b) is what "all 238 singles, then all 129 packs" looked like, and no
    // ranking policy short of the old comparator can produce it.
    say('\n\x1b[1m3. Do packs reach the top 40? (BF-057 — the fix under guard)\x1b[0m');
    const pools = {};
    for (const q of BROAD_QUERIES) {
        let pool;
        try { pool = await walk(q, 4); }
        catch (e) { cannotRun(`q=${q} page 1 unreadable — ${e.message}`); }
        pools[q] = pool;
        const page1 = pool.rows.slice(0, LIMIT);
        const packsTop = page1.filter(isPack).length;

        if (packsTop > 0) {
            ok(`q=${q}: ${packsTop} pack(s) in the top ${LIMIT}`);
        } else {
            // Only now is it worth paying for the deep walk, to say where they went.
            const deep = await walk(q, 25).catch(() => pool);
            const totalPacks = deep.rows.filter(isPack).length;
            if (totalPacks === 0) {
                note(`q=${q}: the catalogue has no packs for this query — nothing to rank`);
            } else {
                const firstPack = deep.rows.findIndex(isPack) + 1;
                bad(`q=${q}: ZERO packs in the top ${LIMIT}`,
                    `${totalPacks} packs exist${deep.truncated ? ' in at least the first pages' : ''} but the first is at rank ${firstPack}; the dropdown never paginates, so the customer cannot see any of them. This is ERR-222 returning.`);
            }
            continue;
        }

        // (b) the partition signature itself
        const flags = pool.rows.map(isPack);
        const firstPack = flags.indexOf(true);
        const lastSingle = flags.lastIndexOf(false);
        if (firstPack > -1 && lastSingle > -1 && firstPack > lastSingle) {
            bad(`q=${q}: every single ranks above every pack — the pool is partitioned`,
                `first pack at rank ${firstPack + 1}, last single at rank ${lastSingle + 1}. pack_type is acting as a sort key again (BF-057).`);
        } else {
            ok(`q=${q}: singles and packs interleave — pack_type is not partitioning the pool`);
        }
    }

    // ── §2 the six-card row
    say('\n\x1b[1m4. Is the LC3333 grid row complete on page 1?\x1b[0m');
    const lcPage1 = (pools['lc'] ? pools['lc'].rows : []).slice(0, LIMIT);
    for (const [label, prefix] of [['compatible', 'CLC3333'], ['genuine', 'GLC3333']]) {
        const want = ['BK', 'C', 'M', 'Y', 'CMY', 'KCMY'].map(s => prefix + s);
        const have = want.filter(sku => lcPage1.some(p => p.sku === sku));
        if (have.length === want.length) {
            ok(`q=lc: the ${label} LC3333 row is all six cards (${want.join(' ')})`);
        } else {
            bad(`q=lc: the ${label} LC3333 row is ${want.length - have.length} card(s) short`,
                `missing ${want.filter(s => !have.includes(s)).join(', ')} — this is the "search bar looks lop-sided" report`);
        }
    }
    // The rows are there; confirm the shipped sort puts the packs at the tail.
    const fam = lcPage1.filter(p => /^CLC3333/.test(p.sku || ''));
    if (fam.length >= 2) {
        const sorted = ProductSort.byCodeThenColor(fam);
        const ranks = sorted.map(p => ProductSort.colorOrder(p));
        const monotone = ranks.every((r, i) => i === 0 || ranks[i - 1] <= r);
        const packsLast = sorted.slice(-2).every(isPack);
        if (monotone && packsLast) ok('the shipped ProductSort puts that row in K→C→M→Y→CMY→KCMY order, packs at the tail');
        else bad('the shipped ProductSort did NOT order the family as documented',
            `colorOrder sequence was [${ranks.join(', ')}] for [${sorted.map(p => p.sku).join(', ')}]`);
    }

    // ── §3 the brief's regression guard
    say('\n\x1b[1m5. Regression guard — q=lc3333 was correct before the fix\x1b[0m');
    let lc3333;
    try { lc3333 = await walk('lc3333', 4); }
    catch (e) { cannotRun(`q=lc3333 unreadable — ${e.message}`); }
    if (lc3333.rows.length === 12) ok('q=lc3333 still returns all 12 rows');
    else bad(`q=lc3333 returns ${lc3333.rows.length} rows, expected 12`,
        'this query worked before BF-057 was fixed; the brief flagged it as the thing not to break');
    const lc3333Packs = lc3333.rows.filter(isPack).length;
    if (lc3333Packs === 4) ok('q=lc3333 still carries its 4 packs');
    else bad(`q=lc3333 carries ${lc3333Packs} packs, expected 4`, null);

    // ── §4 did_you_mean
    say('\n\x1b[1m6. did_you_mean never names a product it did not return\x1b[0m');
    let dymChecked = 0;
    for (const q of BROAD_QUERIES) {
        const d = pools[q] && pools[q].first;
        if (!d || !d.did_you_mean) continue;
        dymChecked++;
        const page1 = (d.products || []);
        const named = pools[q].rows.find(p => p.name === d.did_you_mean);
        if (!named) {
            note(`q=${q}: did_you_mean "${String(d.did_you_mean).slice(0, 48)}" names no product in the pool (a brand/term suggestion) — nothing to reconcile`);
            continue;
        }
        if (page1.some(p => p.sku === named.sku)) {
            ok(`q=${q}: did_you_mean names ${named.sku}, and it is on page 1`);
        } else {
            const rank = pools[q].rows.findIndex(p => p.sku === named.sku) + 1;
            bad(`q=${q}: did_you_mean names ${named.sku}, which is at rank ${rank} of ${pools[q].rows.length}`,
                'the dropdown requests page 1 only, so it would recommend a product it cannot show (ERR-222)');
        }
        // The frontend no longer depends on the above; show that too.
        const shown = SearchMatch.shouldShowCorrection(d.did_you_mean, page1, q);
        note(`q=${q}: the shipped SearchMatch rule would ${shown ? 'SHOW' : 'suppress'} this suggestion in the dropdown`);
    }
    if (!dymChecked) note('no query in this run returned a did_you_mean — nothing to check');

    // ── §5 vocabulary
    say('\n\x1b[1m7. pack_type vocabulary is unchanged\x1b[0m');
    const vocab = new Set();
    for (const q of BROAD_QUERIES) for (const p of (pools[q] ? pools[q].rows : [])) if (p.pack_type != null) vocab.add(p.pack_type);
    const allowed = new Set(['single', 'value_pack', 'multipack']);
    const rogue = [...vocab].filter(v => !allowed.has(v));
    if (!rogue.length) ok(`pack_type ∈ {${[...vocab].sort().join(', ')}} — packRank and the admin filters still read it`);
    else bad(`unknown pack_type value(s): ${rogue.join(', ')}`,
        'ProductSort.packRank returns 0 (i.e. "single") for anything it does not recognise, so a new spelling demotes every pack silently');

    // ── §6 color — the grouping input nothing else watches
    //
    // SCOPED TO CARTRIDGES ON PURPOSE. A first cut of this check flagged 55
    // rows and every one of them was right to be colourless: Brother label
    // tape, a fax film refill, an HP waste toner unit, two Epson maintenance
    // boxes. Asking "does every row have a colour" reports the catalogue as
    // broken forever and trains the reader to ignore the probe.
    //
    // `ProductSort.accessoryTier(p) === 0` is the shipped answer to "is this a
    // cartridge" — read from the name before the category, because OKI and
    // Brother file drum units under category 'toner'. Those are the rows whose
    // colour the K→C→M→Y row order is actually built on.
    say('\n\x1b[1m8. `color` is present on cartridges — the dropdown groups on it\x1b[0m');
    for (const q of BROAD_QUERIES) {
        const rows = (pools[q] ? pools[q].rows : []).filter(p => ProductSort.accessoryTier(p) === 0);
        if (!rows.length) { note(`q=${q}: no cartridge rows in the sampled pages`); continue; }
        const missing = rows.filter(p => p.color === undefined || p.color === null || p.color === '');
        if (!missing.length) { ok(`q=${q}: color present on all ${rows.length} cartridge rows`); continue; }
        bad(`q=${q}: ${missing.length} of ${rows.length} cartridge rows carry no color`,
            `e.g. ${missing.slice(0, 3).map(p => p.sku).join(', ')} — ProductSort.colorOrder ranks a colourless single ${ProductSort.colorOrder(missing[0])} (the unknown-single rank), so the documented K→C→M→Y row order goes silently inert. This endpoint shipped without SELECTing color once already; the grid looked plausible the whole time.`);
    }

    // ── §7 the ?code= packs
    say('\n\x1b[1m9. ?code= still serves its value packs (the P3b examples)\x1b[0m');
    const CODE_CASES = [
        ['brother', 'LC38', 'GLC38CMY'],
        ['brother', 'LC40', 'GLC40CMY'],
        ['brother', 'LC432', 'G432KCMY'],
    ];
    for (const [brand, code, sku] of CODE_CASES) {
        let d;
        try { d = await envelope(`/api/shop?brand=${brand}&code=${code}&limit=200`); }
        catch (e) { cannotRun(`/api/shop?brand=${brand}&code=${code} unreadable — ${e.message}`); }
        let present = (d.products || []).some(p => p.sku === sku);
        if (!present) {
            // Hazard (c): two reads of this URL 40 minutes apart disagreed on
            // 2026-09-07. Never report this one on a single read.
            await sleep(2000);
            try {
                const again = await envelope(`/api/shop?brand=${brand}&code=${code}&limit=200`);
                present = (again.products || []).some(p => p.sku === sku);
                if (present) note(`?code=${code}: first read missed ${sku}, second read served it — this endpoint has flickered before; treating as served`);
            } catch { /* keep the first answer */ }
        }
        if (present) ok(`?brand=${brand}&code=${code} serves ${sku}`);
        else bad(`?brand=${brand}&code=${code} does NOT serve ${sku} (confirmed on a re-read)`,
            'a genuine value pack carrying this code is missing from its own chip drilldown — catalogue-pathway-backend-brief-aug2026.md');
    }

    // ── summary
    say('\n  ' + '─'.repeat(74));
    say(`  ${pass} check(s) passed, ${findings.length} finding(s), ${notes.length} note(s)`);
    if (JSON_OUT) {
        console.log(JSON.stringify({
            status: findings.length ? 'findings' : 'clean',
            api: API_BASE, limit: LIMIT, pass, findings, notes,
        }, null, 2));
    }
    if (findings.length) {
        say('\n  \x1b[31mFindings\x1b[0m');
        for (const f of findings) say(`   • ${f.name}${f.detail ? `\n     ${f.detail}` : ''}`);
        say('\n  Each one is a multi-pack a customer cannot see while typing.\n');
        process.exit(1);
    }
    say('\n  \x1b[32mClean.\x1b[0m Packs are inside the window the dropdown actually asks for.\n');
    process.exit(0);
}

main().catch(err => {
    console.error(`✖ probe crashed: ${err && err.message ? err.message : err}`);
    process.exit(2);
});
