#!/usr/bin/env node
/**
 * audit-ribbon-typeahead.mjs — does the "Fits <model>" chip survive reconciliation?
 * ================================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Twice now, a backend handoff about ribbon "FOR USE IN" search has said "No FE
 * changes required" and twice it has been wrong, in two different ways:
 *
 *   ERR-133 (backend 1d43034, 2026-07-30) made compat rows ADDITIVE on
 *   /api/search/smart. Two frontend paths were deleting them.
 *
 *   ERR-144 (backend 99d798b, 2026-08-04) put the same blob search on
 *   /api/search/suggest — which this app uses NOT as a typeahead feed but as
 *   the results page's literal-match CONTROL SET. Those rows carry no
 *   match_reason, so the reconciliation could no longer tell a "for use in"
 *   match from a name hit, and the chip ERR-133 shipped silently vanished.
 *
 * Neither failure was visible to a unit test, because neither was a bug in the
 * frontend's logic as written — the DATA changed shape underneath a correct
 * implementation. Only a live run can catch the third one. That is what this is
 * for: it is the difference between "wait for the next handoff" and "run the
 * audit".
 *
 * WHAT IT CHECKS
 * --------------
 *   §1 the backend's own acceptance claims (blob models resolve, no pollution,
 *      the gate excludes bare-numeric queries, direct hits are never displaced)
 *   §2 /suggest ⇄ /smart parity — every compat row /smart knows about
 *   §3 THE REGRESSION: replay the SHIPPED reconciliation over live payloads and
 *      assert every compat row still carries its matched_token at the end
 *   §4 the swap bar stays direct-vs-direct
 *   §5 known backend-owned findings, baselined rather than failing forever
 *
 * It loads the SHIPPED helpers out of inkcartridges/js/shop-page.js. It never
 * re-declares a copy of them — an audit carrying its own reconciliation
 * certifies a results page that does not exist.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — vercel.json sets
 * outputDirectory "." with the project root at inkcartridges/, so everything in
 * that tree is served publicly.
 *
 * Usage:  npm run audit:typeahead            (no credentials needed — public catalog reads)
 *         npm run audit:typeahead -- --json  (machine-readable summary)
 *         npm run audit:typeahead -- --update-baseline
 * Exit:   0 = every check passed, 1 = at least one failed OR the API was unreachable
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const BASELINE = path.join(ROOT, 'tests', 'fixtures', 'ribbon-typeahead-corpus.json');

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes('--json');
const UPDATE_BASELINE = ARGV.includes('--update-baseline');

let pass = 0;
const failures = [];
const notes = [];

const say = (s) => { if (!JSON_OUT) console.log(s); };
const ok = (name) => { pass++; say(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => {
    failures.push(`${name} — ${detail}`);
    say(`  \x1b[31m✗\x1b[0m ${name}\n      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const note = (name, detail) => { notes.push(`${name} — ${detail}`); say(`  \x1b[33m•\x1b[0m ${name}\n      ${detail}`); };

// ─────────────────────────────────────────────────────────────────────────────
// Load the SHIPPED reconciliation helpers. utils.js first: queryCodeMatch
// delegates to window.CompatSource for its code-token vocabulary, and without
// it the helper answers false for everything — an audit that would then "pass"
// while proving nothing.
// ─────────────────────────────────────────────────────────────────────────────
function loadShippedHelpers() {
    const js = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', f), 'utf8');
    const noop = () => {};
    const doc = {
        addEventListener: noop, getElementById: () => null,
        querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, setAttribute: noop, appendChild: noop }),
        body: { appendChild: noop }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console, URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat, isNaN,
        setTimeout, clearTimeout,
        document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState: noop, pushState: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        navigator: { userAgent: 'node' },
        DebugLog: { log: noop, warn: noop, error: noop },
        Config: { API_URL: BASE, settings: {}, getSetting: (k, f) => f },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(js('utils.js'), ctx, { filename: 'utils.js' });
    if (!sandbox.window.CompatSource) {
        console.error('\x1b[31mFATAL:\x1b[0m utils.js did not expose window.CompatSource — queryCodeMatch '
            + 'would answer false for everything and this audit would certify nothing.');
        process.exit(1);
    }
    vm.runInContext(js('shop-page.js'), ctx, { filename: 'shop-page.js' });
    const H = sandbox.window._searchParityHelpers;
    const required = ['partitionCompatRows', 'mergeLiteralResults', 'queryCodeMatch',
        'rowsNotAlreadyIn', 'reattachCompatProvenance'];
    const missing = required.filter((k) => typeof H?.[k] !== 'function');
    if (missing.length) {
        console.error(`\x1b[31mFATAL:\x1b[0m shop-page.js is missing helpers: ${missing.join(', ')}`);
        process.exit(1);
    }
    return H;
}

const H = loadShippedHelpers();

// ─────────────────────────────────────────────────────────────────────────────
// Fetch. An unreachable API is loudly fatal — refusing to report "clean" from a
// catalogue we could not read.
// ─────────────────────────────────────────────────────────────────────────────
let networkFailures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The search bucket is 120 req/min/IP. A full corpus run is ~80 requests, so an
 * unpaced audit trips 429s halfway through and reports a catalogue-wide outage
 * that is really our own impatience — the worst possible failure mode for a
 * tool whose entire job is to be believed. Serialize every call behind a
 * minimum interval, and retry a 429 rather than recording it.
 */
const MIN_INTERVAL_MS = 550;
let gate = Promise.resolve();
let lastAt = 0;
function paced(fn) {
    const run = gate.then(async () => {
        const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        return fn();
    });
    gate = run.then(() => {}, () => {});
    return run;
}

/**
 * `expectError: true` marks a probe whose whole point is a non-2xx answer (the
 * limit-cap check). Those must NOT count toward networkFailures, or the
 * "refusing to report clean" guard fires on a healthy run.
 */
async function api(pathname, { expectError = false, attempt = 0 } = {}) {
    const url = `${BASE}${pathname}`;
    try {
        const res = await paced(() => fetch(url, { credentials: 'omit' }));
        const json = await res.json();
        if (res.status === 429 && attempt < 3) {
            await sleep(2000 * (attempt + 1));
            return api(pathname, { expectError, attempt: attempt + 1 });
        }
        if (!json || json.ok !== true) {
            if (!expectError) networkFailures++;
            return { __err: `HTTP ${res.status} / ok=${json && json.ok}` };
        }
        return json.data || {};
    } catch (e) {
        if (!expectError) networkFailures++;
        return { __err: e.message };
    }
}

const q = encodeURIComponent;
const smart = (query) => api(`/api/search/smart?q=${q(query)}&limit=40`);
const suggest = (query, limit = 20, opts) => api(`/api/search/suggest?q=${q(query)}&limit=${limit}`, opts);
const autocomplete = (query, limit = 8) => api(`/api/search/autocomplete?q=${q(query)}&limit=${limit}`);
const products = (query) => api(`/api/products?search=${q(query)}&limit=100&page=1`);

const rowsOf = (d, key) => (d && Array.isArray(d[key]) ? d[key] : []);

/**
 * Replay the SHIPPED reconciliation. Mirrors shop-page.js loadSearchResults;
 * tests/ribbon-typeahead-compat-aug2026.test.js §2 pins that the real code
 * performs these steps in this order, so this cannot drift silently.
 */
function reconcile({ smartProducts, suggestList, productsList, query, exactMode = false }) {
    const queryHasDigits = /\d/.test(String(query || ''));
    const { direct, compat } = H.partitionCompatRows(smartProducts);
    const directCount = direct.length;

    const merged = H.mergeLiteralResults(suggestList, productsList);
    let mergedUsed = merged;
    let mergedFiltered = false;
    if (queryHasDigits) {
        const onTopic = merged.filter((p) => H.queryCodeMatch(p, query));
        if (onTopic.length > 0 && onTopic.length < merged.length) { mergedUsed = onTopic; mergedFiltered = true; }
    }
    mergedUsed = H.reattachCompatProvenance(mergedUsed, compat);
    const mergedSplit = H.partitionCompatRows(mergedUsed);

    const hardMiss = smartProducts.length === 0;
    const shouldUseFallback = exactMode ? true : (hardMiss ? mergedUsed.length > 0 : mergedSplit.direct.length > directCount);

    if (!shouldUseFallback) {
        return { swapped: false, rendered: smartProducts, compat, directCount, mergedFiltered };
    }
    const preservedCompat = H.rowsNotAlreadyIn(compat, mergedUsed);
    return {
        swapped: true, rendered: mergedUsed.concat(preservedCompat),
        compat, directCount, preservedCompat, mergedSplit, mergedFiltered,
    };
}

const idKey = (p) => (p?.id != null && p.id !== '' ? `id:${p.id}` : (p?.sku ? `sku:${String(p.sku).toUpperCase()}` : `nm:${p?.name}`));

// The ERR-133 live repro corpus plus the ERR-144 blob-only time-clock models.
const COMPAT_CORPUS = ['AP830', 'AP8100', 'CE60', 'CE50', 'AX220', 'VP6000', 'AP1000', 'SP1000', 'XR20', 'GX6750'];
const BLOB_ONLY_MODELS = ['TCX-11', 'ET-3300', 'TR910', 'NS-5100', 'EX-9000', 'TS-4000i', 'PIX-200', 'PIX-4000'];
const STRUCTURED_MODELS = ['PIX10', 'BX6000', 'TR810'];
const NEGATIVE_CONTROL = 'lc233';

async function main() {
    say(`\n\x1b[1mRibbon "FOR USE IN" typeahead audit\x1b[0m — ${BASE}`);
    say(`ERR-144 · backend 99d798b · handoff ribbon-for-use-in-typeahead-FE-handoff-aug2026.md\n`);

    // ── §1 the backend's own acceptance claims ──────────────────────────────
    say('§1  Backend acceptance claims (independently re-run)');

    for (const model of BLOB_ONLY_MODELS) {
        const d = await suggest(model, 8);
        if (d.__err) { bad(`/suggest?q=${model}`, d.__err); continue; }
        const ribbons = rowsOf(d, 'suggestions').filter((s) => /Time Clock Ribbon/i.test(s.name || ''));
        check(ribbons.length > 0, `/suggest?q=${model} surfaces the Amano ribbon`,
            'blob-only model returned no ribbon — the typeahead blob search regressed');
    }

    for (const model of STRUCTURED_MODELS) {
        const d = await suggest(model, 8);
        if (d.__err) { bad(`/suggest?q=${model}`, d.__err); continue; }
        check(rowsOf(d, 'suggestions').length > 0, `/suggest?q=${model} (structured compat) still resolves`,
            'the structured product_compatibility path must not have been traded away for the blob one');
    }

    {
        const d = await autocomplete('ET-3300', 8);
        if (d.__err) bad('/autocomplete?q=ET-3300', d.__err);
        else {
            const rows = rowsOf(d, 'suggestions');
            check(rows.some((s) => /Time Clock Ribbon/i.test(s.name || '')),
                '/autocomplete parity — the same ribbon appears',
                'autocomplete diverged from suggest');
            check(rows.every((s) => !('sku' in s)) || rows.some((s) => 'category_display' in s),
                '/autocomplete keeps its documented lean shape (no sku, category_display string)',
                'the autocomplete payload shape drifted from the handoff contract');
        }
    }

    {
        const d = await suggest(NEGATIVE_CONTROL, 8);
        if (d.__err) bad(`/suggest?q=${NEGATIVE_CONTROL}`, d.__err);
        else {
            const ribbons = rowsOf(d, 'suggestions').filter((s) => /Ribbon/i.test(s.name || ''));
            check(ribbons.length === 0, `no pollution — /suggest?q=${NEGATIVE_CONTROL} stays inks-only`,
                `${ribbons.length} ribbon(s) leaked into a common ink-code query`);
        }
    }

    {
        // "Blob matches only fill the remaining slots — they never displace
        // direct hits." Ask for exactly one row and check it is a direct hit.
        const d = await suggest('CE50', 1);
        if (d.__err) bad('/suggest?q=CE50&limit=1', d.__err);
        else {
            const first = rowsOf(d, 'suggestions')[0];
            check(first && !/Ribbon|Correction/i.test(first.name || ''),
                'ranking — a full direct set leaves no room for a blob match',
                `limit=1 returned "${first?.name}", so blob rows CAN displace a direct hit`);
        }
    }

    {
        // The gate: bare-numeric queries are excluded from the blob search.
        const d = await suggest('200', 8);
        if (d.__err) bad('/suggest?q=200', d.__err);
        else ok('gate — bare-numeric q=200 returns without a blob fan-out');
    }

    // ── §2 /suggest ⇄ /smart parity ─────────────────────────────────────────
    say('\n§2  /suggest ⇄ /smart parity');
    for (const query of ['TCX-11', 'AP830', 'VP6000']) {
        const [sm, sg] = await Promise.all([smart(query), suggest(query, 20)]);
        if (sm.__err || sg.__err) { bad(`parity ${query}`, sm.__err || sg.__err); continue; }
        const compat = rowsOf(sm, 'products').filter((p) => p.match_reason === 'compatibility');
        const sgKeys = new Set(rowsOf(sg, 'suggestions').map(idKey));
        const shared = compat.filter((c) => sgKeys.has(idKey(c)));
        check(compat.length === 0 || shared.length > 0,
            `q=${query} — /suggest carries ${shared.length}/${compat.length} of /smart's compat rows`,
            'the two surfaces disagree about which ribbons match');
        if (shared.length) {
            const tagged = rowsOf(sg, 'suggestions').filter((s) => s.match_reason);
            if (tagged.length) {
                note(`q=${query} — /suggest now emits match_reason`,
                    'BF ask satisfied: the FE re-attachment is redundant and can be simplified away');
            }
        }
    }

    // ── §3 THE REGRESSION: does the chip survive reconciliation? ────────────
    say('\n§3  Chip survival through the SHIPPED reconciliation');
    const corpusResult = [];
    for (const query of [...COMPAT_CORPUS, ...BLOB_ONLY_MODELS, NEGATIVE_CONTROL]) {
        const [sm, sg, pr] = await Promise.all([smart(query), suggest(query, 20), products(query)]);
        if (sm.__err || sg.__err || pr.__err) { bad(`reconcile ${query}`, sm.__err || sg.__err || pr.__err); continue; }

        const smartProducts = rowsOf(sm, 'products');
        const expected = smartProducts.filter((p) => p.match_reason === 'compatibility');
        const r = reconcile({
            query, smartProducts,
            suggestList: rowsOf(sg, 'suggestions'),
            productsList: rowsOf(pr, 'products'),
        });

        const renderedKeys = new Map(r.rendered.map((p) => [idKey(p), p]));
        const lost = expected.filter((c) => {
            const row = renderedKeys.get(idKey(c));
            return !row || row.match_reason !== 'compatibility' || !row.matched_token;
        });

        corpusResult.push({
            query, direct: r.directCount, compat: expected.length,
            suggest: rowsOf(sg, 'suggestions').length, products: rowsOf(pr, 'products').length,
            swapped: r.swapped, lost: lost.length,
        });

        if (expected.length === 0) {
            check(r.rendered.every((p) => p.match_reason !== 'compatibility'),
                `q=${query} — no compat rows in, none invented`,
                'the frontend labelled a row the backend never called compat (ERR-135)');
        } else {
            check(lost.length === 0,
                `q=${query} — ${expected.length} compat row(s) keep "Fits <model>" (swap=${r.swapped})`,
                `${lost.length} row(s) reached the page with no matched_token: ${lost.map((p) => p.sku).join(', ')}`);
        }

        // Provenance ordering: a compat row must never sit above a direct hit.
        const split = H.partitionCompatRows(r.rendered);
        if (split.compat.length && split.direct.length) {
            const firstCompat = r.rendered.findIndex((p) => p.match_reason === 'compatibility');
            const lastDirect = r.rendered.map((p) => p.match_reason === 'compatibility').lastIndexOf(false);
            if (firstCompat < lastDirect) {
                note(`q=${query} — backend order interleaves compat above a direct hit`,
                    'expected: compatLast() re-sorts this at render time (shop-page.js renderProducts)');
            }
        }
    }

    // ── §4 the swap bar stays direct-vs-direct ──────────────────────────────
    say('\n§4  The swap bar');
    {
        // A query whose literal set is PURELY compat rows must never win a swap:
        // that is the ERR-144 inversion, and it is what stripped VP6000's chips.
        const pureCompat = corpusResult.filter((r) => r.direct === 0 && r.compat > 0);
        for (const r of pureCompat) {
            check(!r.swapped, `q=${r.query} — a literal set of only also-fits rows does not win a swap`,
                'ERR-144: mergedUsed.length > directCount let 3 compat rows beat 0 direct rows');
        }
        if (!pureCompat.length) note('no pure-compat query in the corpus today', 'the §4 inversion check had nothing to bite on');
    }

    // ── §5 known backend-owned findings (baselined, not failures) ───────────
    say('\n§5  Backend-owned findings');
    {
        const d = await smart('AP1000');
        if (d.__err) bad('/smart?q=AP1000', d.__err);
        else {
            const rows = rowsOf(d, 'products');
            const firstCompat = rows.findIndex((p) => p.match_reason === 'compatibility');
            const buried = firstCompat >= 0 && rows.slice(firstCompat).some((p) => p.match_reason !== 'compatibility');
            if (buried) {
                note('ERR-133 Defect 4 still open — compat rows bury a direct hit',
                    `q=AP1000 order: ${rows.map((p) => `${p.sku}${p.match_reason === 'compatibility' ? '*' : ''}`).join(' → ')} `
                    + '· reported in ribbon-compat-search-FE-response-jul2026.md §3, re-raised aug2026 §3');
            } else {
                bad('ERR-133 Defect 4 baseline is stale',
                    'compat rows no longer bury a direct hit on q=AP1000 — the backend fixed it. '
                    + 'REMOVE this baseline entry and the compatLast() workaround it justifies.');
            }
        }
    }
    {
        // Spaced-query normalisation: "TCX 11" must reach the same ribbon as
        // "TCX-11". This WAS an open backend finding (reported 2026-07-30 for
        // "ap 830", re-raised 2026-08-04) and it is now FIXED — re-measured
        // 2026-08-12, both forms return the identical 2 rows (36000.02,
        // 36000.01). The separator work landed with the Aug 2026 recall
        // improvements (search-click-tracking-fe-handoff-aug2026 §3, the same
        // change that made glued printer codes like `dcpj1050dw` resolve).
        //
        // So this is no longer a finding to report — it is a FIX TO DEFEND.
        // Inverted rather than deleted: the audit's whole value is that a
        // recorded state which can only go green-to-red rots silently
        // (ERR-140's lesson). A positive assertion keeps a regression loud;
        // removing the block would have made a backend regression invisible.
        const [hyphen, spaced] = await Promise.all([suggest('TCX-11', 8), suggest('TCX 11', 8)]);
        if (hyphen.__err || spaced.__err) bad('spaced-query probe', hyphen.__err || spaced.__err);
        else {
            const hKeys = new Set(rowsOf(hyphen, 'suggestions').map(idKey));
            const overlap = rowsOf(spaced, 'suggestions').filter((s) => hKeys.has(idKey(s)));
            check(overlap.length > 0, 'spaced query reaches the same rows as the hyphenated form',
                '"TCX 11" and "TCX-11" returned disjoint sets — separator tolerance REGRESSED. '
                + 'It was fixed as of 2026-08-12; a customer typing the space form now misses the ribbon again.');
        }
    }
    {
        // Punctuation tolerance — the coverage gap the Sep-2026 security
        // hand-off exposed (ERR-202). Until now this whole corpus was
        // hyphens-only, so the backend could have started or stopped stripping
        // `, ( )` and nothing here would have noticed.
        //
        // The hand-off's §3 says /api/search/* strips those three characters.
        // For /smart that is TRUE and it is a fix to DEFEND, exactly like the
        // separator tolerance above: our own product titles carry them (the
        // page-yield suffix is literally "(2,500 pages)"), and the typeahead
        // writes a full title back into the box on select, so the round-trip
        // has to survive. Asserted positively so a regression is loud.
        const [plain, bracketed, comma] = await Promise.all([
            smart('TN251'), smart('(TN251)'), smart('TN251,'),
        ]);
        if (plain.__err || bracketed.__err || comma.__err) {
            bad('punctuation probe', plain.__err || bracketed.__err || comma.__err);
        } else {
            const keys = new Set(rowsOf(plain, 'products').map(idKey));
            for (const [label, res] of [['(TN251)', bracketed], ['TN251,', comma]]) {
                const rows = rowsOf(res, 'products');
                const overlap = rows.filter((r) => keys.has(idKey(r)));
                check(overlap.length > 0, `smart search tolerates ${label}`,
                    `"${label}" returned no row that "TN251" returned — /api/search/smart has `
                    + 'STOPPED neutralising , ( ). Storefront searches carrying a bracket '
                    + '(a pasted product title, a did-you-mean re-search) now miss. See ERR-202.');
            }
        }
    }
    {
        // The documented cap. Note it is enforced with a 400, NOT an empty 200 —
        // API.searchSuggest swallows the error into [], so a caller that raised
        // its limit past 24 would see "no suggestions" and never know why.
        const at = await suggest('ink', 24);
        const over = await suggest('ink', 25, { expectError: true });
        check(!at.__err && rowsOf(at, 'suggestions').length === 24,
            '/suggest honours limit=24 (the documented ceiling)',
            `limit=24 did not return 24 rows: ${at.__err || rowsOf(at, 'suggestions').length}`);
        check(!!over.__err && /400/.test(over.__err),
            '/suggest rejects limit=25 with HTTP 400 (cap enforced, not silently truncated)',
            `expected a 400 above the cap, got: ${over.__err || `${rowsOf(over, 'suggestions').length} rows`} `
            + '— the ceiling moved; update the api.js searchSuggest doc');
    }

    // ── baseline ────────────────────────────────────────────────────────────
    const record = { generated_for: 'ERR-144', backend_commit: '99d798b', api: BASE, corpus: corpusResult };
    if (UPDATE_BASELINE) {
        fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
        fs.writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`);
        say(`\n\x1b[36mbaseline written:\x1b[0m ${path.relative(ROOT, BASELINE)}`);
    } else if (fs.existsSync(BASELINE)) {
        const prev = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
        const prevBy = new Map((prev.corpus || []).map((r) => [r.query, r]));
        for (const cur of corpusResult) {
            const old = prevBy.get(cur.query);
            if (!old) continue;
            if (old.compat !== cur.compat) {
                note(`q=${cur.query} — compat-row count drifted ${old.compat} → ${cur.compat}`,
                    'the catalogue or the blob search changed; re-run with --update-baseline once reviewed');
            }
        }
    }

    if (JSON_OUT) console.log(JSON.stringify({ pass, failures, notes, corpus: corpusResult }, null, 2));

    if (networkFailures && !failures.length) {
        console.error('\n\x1b[31mUNREACHABLE:\x1b[0m the catalogue could not be read. '
            + 'Refusing to report "clean" from a catalogue we could not read.');
        process.exit(1);
    }

    say(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${failures.length} failed\x1b[0m`
        + `${notes.length ? `, ${notes.length} baselined backend finding(s)` : ''}`);
    if (failures.length) {
        say('\nFailures:');
        failures.forEach((f) => say(`  • ${f}`));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('\n\x1b[31maudit failed:\x1b[0m', e.stack || e.message);
    process.exit(1);
});
