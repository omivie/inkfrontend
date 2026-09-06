#!/usr/bin/env node
/**
 * probe-lexmark-chip-grouping.mjs — the Lexmark/OKI chip collapse, live (ERR-216)
 * ==============================================================================
 *
 * ── WHY A PROBE AND NOT A TEST ──────────────────────────────────────────────
 * tests/lexmark-chip-grouping-sep2026.test.js pins the FRONTEND's behaviour
 * against a fixture of the chip vocabulary as it stood on 2026-09-06. That is
 * the right shape for a unit test and the wrong shape for this question, because
 * the thing that broke was a DISAGREEMENT between a frontend grammar and live
 * backend data. A fixture cannot notice the data moving again.
 *
 * This probe asks the live catalogue the one question the fixture cannot:
 * *does every code the backend is emitting right now survive the code path that
 * turns it into a chip?* It loads the SHIPPED extractor out of shop-page.js and
 * calls it — it does not re-implement the derivation, because a probe carrying
 * its own copy proves only that the copy works.
 *
 * ── READ-ONLY, WITH NO WRITE PATH AT ALL ────────────────────────────────────
 * Every request is an anonymous GET. There is no --record, no --update-baseline,
 * no fixture file and no write verb of any kind, and the mode is printed on
 * every run. A probe that can record is a probe that can pass because it just
 * overwrote what it was comparing against — that is how `sweep:b2b` ate a
 * committed fixture on 2026-08-12.
 *
 * ── WHAT IT MEASURES ────────────────────────────────────────────────────────
 *   1. Every live series_codes value on nine brands survives PRIORITY 0.
 *   2. The Lexmark/OKI collapse is still in force (no full MPN is a chip).
 *   3. Chip -> ?code= -> rows round-trips: the rows come back carrying the chip.
 *   4. Retired MPN codes still resolve, and what they ACTUALLY return (the
 *      hand-off claimed they return the whole platform grid; they return a
 *      subset — that discrepancy is reported as a measurement, never assumed).
 *   5. The four renamed SKUs 301 to their new SKUs.
 *   6. A positive control: a code that cannot exist must return zero rows, so
 *      the round-trip check cannot pass by matching everything.
 *
 * ── WHAT IT DOES NOT MEASURE ────────────────────────────────────────────────
 * Rendering. It never opens a browser, so it cannot tell you the chip grid drew
 * correctly — only that the data reaching it is coherent with the code that
 * consumes it. It also does not check the admin drawer (no credentials here).
 *
 * Usage:  npm run probe:chip-grouping
 *         npm run probe:chip-grouping -- --fast    (no inter-request pacing)
 *         npm run probe:chip-grouping -- --json
 * Exit:   0 = every check passed
 *         1 = a real finding
 *         2 = the probe could not run — deliberately NOT 1, because "we could
 *             not look" must never be reported as "we looked and it was fine".
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ARGS = new Set(process.argv.slice(2));
const FAST = ARGS.has('--fast');
const JSON_OUT = ARGS.has('--json');
const API_BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 350);
const RATE_LIMIT_BACKOFF_MS = 8000;
const SERVER_ERROR_BACKOFF_MS = 15000;

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

async function get(pathname, { redirect = 'follow' } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
            res = await fetch(`${API_BASE}${pathname}`, { redirect });
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

async function getJson(pathname) {
    const res = await get(pathname);
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; }
    catch { return { status: res.status, body: null, raw: text.slice(0, 200) }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation under test — lifted from the shipped files, never re-written.
// ─────────────────────────────────────────────────────────────────────────────

function loadShippedExtractor() {
    const shopSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
    const utilsSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'utils.js'), 'utf8');

    const scStart = utilsSrc.indexOf('const SeriesCodes = (function () {');
    if (scStart === -1) cannotRun('SeriesCodes not found in utils.js — the file has moved.');
    const scTail = utilsSrc.slice(scStart);
    const scEnd = scTail.indexOf('\n})();');
    if (scEnd === -1) cannotRun('SeriesCodes IIFE is not closed as expected.');
    const scBox = { console };
    vm.createContext(scBox);
    vm.runInContext(scTail.slice(0, scEnd + 6) + '\nglobalThis.__SC = SeriesCodes;', scBox);
    const SeriesCodes = scBox.__SC;

    const method = (name, extra = {}) => {
        const lines = shopSrc.split('\n');
        const idx = lines.findIndex(l => new RegExp(`^\\s{8}${name}\\(`).test(l));
        if (idx === -1) cannotRun(`${name} not found in shop-page.js — the file has moved.`);
        const start = lines.slice(0, idx).join('\n').length + 1;
        let depth = 0, end = -1;
        for (let j = shopSrc.indexOf('{', start); j < shopSrc.length; j++) {
            if (shopSrc[j] === '{') depth++;
            else if (shopSrc[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        const box = { console, DebugLog: { warn() {}, error() {}, log() {} }, ...extra };
        vm.createContext(box);
        return vm.runInContext(`({${shopSrc.slice(start, end + 1).replace(/^\s*/, '')}})`, box);
    };

    const ex = method('extractProductCodes', { window: { SeriesCodes } });
    const nc = method('normalizeCode');
    return (brand, products) => {
        const host = {
            state: { brand },
            normalizeCode: nc.normalizeCode,
            extractProductCodes: ex.extractProductCodes,
        };
        return JSON.parse(JSON.stringify(host.extractProductCodes(products))).map(c => c.code);
    };
}

const BRANDS = ['brother', 'canon', 'epson', 'hp', 'lexmark', 'oki', 'samsung', 'kyocera', 'fuji-xerox'];
const CATEGORIES = ['ink', 'toner', 'consumable'];
/** MPN-shaped: long enough and mixed enough that it cannot be a platform stem. */
const looksLikeFullMpn = (code) => /^\d{2}[A-Z][A-Z0-9]{4,}$/.test(code) || /^[A-Z]\d{3}[A-Z]\d[A-Z]{2,}$/.test(code);

async function main() {
    say('\n\x1b[1mLexmark / OKI chip grouping — live probe (ERR-216)\x1b[0m');
    say('  MODE: \x1b[1mREAD-ONLY\x1b[0m (no write path, no baseline file, no credentials)');
    say(`  API : ${API_BASE}`);
    say(`  Pace: ${DELAY_MS}ms between requests${FAST ? ' (--fast)' : ''}\n`);

    const extract = loadShippedExtractor();

    // ── 1. Every live series_codes value survives PRIORITY 0 ────────────────
    say('\x1b[1m1. Every live series_codes value survives the shipped extractor\x1b[0m');
    let measuredAnything = false;
    const rejected = [];
    for (const brand of BRANDS) {
        const codes = new Set();
        for (const category of CATEGORIES) {
            const { body } = await getJson(`/api/shop?brand=${brand}&category=${category}&limit=200`);
            for (const p of (body?.data?.products || [])) {
                for (const c of (p.series_codes || [])) codes.add(String(c));
            }
        }
        if (!codes.size) { note(`${brand}: no series_codes seen — skipped, not passed`); continue; }
        measuredAnything = true;
        const lost = [];
        for (const c of codes) {
            const out = extract(brand, [{ id: c, sku: '', series_codes: [c] }]);
            if (!out.includes(c.toUpperCase().replace(/[\s-]/g, ''))) lost.push(c);
        }
        if (lost.length) {
            rejected.push({ brand, lost });
            bad(`${brand}: ${lost.length}/${codes.size} live codes are dropped by the extractor`,
                lost.slice(0, 12).join(', '));
        } else {
            ok(`${brand}: all ${codes.size} live codes survive`);
        }
    }
    if (!measuredAnything) cannotRun('No series_codes came back for any brand — the catalogue read failed.');

    // ── 2. The collapse is still in force ───────────────────────────────────
    say('\n\x1b[1m2. The Lexmark/OKI collapse is still in force\x1b[0m');
    for (const brand of ['lexmark', 'oki']) {
        const { body } = await getJson(`/api/products/series?brand=${brand}`);
        const chips = (body?.data || []).map(c => c.code);
        if (!chips.length) { note(`${brand}: series endpoint returned nothing — skipped`); continue; }
        const mpnish = chips.filter(looksLikeFullMpn);
        if (mpnish.length) {
            bad(`${brand}: ${mpnish.length} chip(s) look like un-collapsed MPNs`, mpnish.slice(0, 10).join(', '));
        } else {
            ok(`${brand}: ${chips.length} chips, none MPN-shaped`);
        }
    }

    // ── 3. Chip → ?code= → rows round-trip ──────────────────────────────────
    say('\n\x1b[1m3. Each chip round-trips: the rows it returns carry it back\x1b[0m');
    for (const brand of ['lexmark', 'oki']) {
        const { body } = await getJson(`/api/shop?brand=${brand}&category=toner`);
        const chips = (body?.data?.series || []).map(s => s.code).slice(0, 12);
        if (!chips.length) { note(`${brand}: no toner chips — skipped`); continue; }
        let broken = 0;
        for (const chip of chips) {
            const { body: r } = await getJson(
                `/api/shop?brand=${brand}&category=toner&code=${encodeURIComponent(chip)}&limit=200`);
            const rows = r?.data?.products || [];
            if (!rows.length) { broken++; bad(`${brand} chip "${chip}" returns zero products`); continue; }
            const missing = rows.filter(p => !(p.series_codes || []).map(String).includes(chip));
            if (missing.length) {
                broken++;
                bad(`${brand} chip "${chip}": ${missing.length}/${rows.length} rows do not carry it`,
                    missing.slice(0, 3).map(p => `${p.sku}=[${(p.series_codes || []).join('|')}]`).join('  '));
            }
        }
        if (!broken) ok(`${brand}: ${chips.length} chips all round-trip cleanly`);
    }

    // ── 4. Retired MPN codes — what they ACTUALLY return ────────────────────
    say('\n\x1b[1m4. Retired MPN codes still resolve (and by how much they differ)\x1b[0m');
    const stemProbe = await getJson('/api/shop?brand=lexmark&category=toner&code=20&limit=200');
    const stemCount = (stemProbe.body?.data?.products || []).length;
    if (!stemCount) {
        note('the "20" platform returned nothing — cannot compare retired codes against it');
    } else {
        for (const legacy of ['20N3HK0', '20N3H', '20N30', '20N3']) {
            const { body } = await getJson(
                `/api/shop?brand=lexmark&category=toner&code=${legacy}&limit=200`);
            const rows = body?.data?.products || [];
            if (!rows.length) {
                bad(`retired code "${legacy}" returns zero products — an old link is now a dead end`);
                continue;
            }
            const stems = [...new Set(rows.flatMap(p => p.series_codes || []))];
            if (rows.length === stemCount) {
                ok(`"${legacy}" → ${rows.length} rows (same as the "20" chip)`);
            } else {
                // NOT a finding: it resolves, which is what matters for the link.
                // Recorded because the hand-off said these return the same grid.
                note(`"${legacy}" → ${rows.length} rows vs ${stemCount} for the "20" chip ` +
                     `(a SUBSET, not the platform grid — hand-off §3 says otherwise); ` +
                     `rows filed under [${stems.join(', ')}]`);
            }
            if (stems.length === 1 && stems[0] !== legacy) {
                ok(`  …and the FE can adopt "${stems[0]}" from the rows themselves`);
            }
        }
    }

    // ── 5. The renamed SKUs still resolve ───────────────────────────────────
    say('\n\x1b[1m5. The four renamed SKUs 301 to their new identity\x1b[0m');
    const renames = [
        ['G150KBK', 'G71C0Z10BK'], ['G150KCMY', 'G71C0Z50CMY'],
        ['G170K', 'G71C0W00'], ['G28KBK', 'G81C1XK0BK'],
    ];
    for (const [oldSku, newSku] of renames) {
        const res = await get(`/api/products/${oldSku}`, { redirect: 'manual' });
        if (res.status === 301 || res.status === 302) {
            const loc = res.headers.get('location') || '';
            if (loc.endsWith(`/${newSku}`)) ok(`${oldSku} → 301 → ${newSku}`);
            else bad(`${oldSku} redirects, but to "${loc}" not ${newSku}`);
        } else if (res.status === 200) {
            note(`${oldSku} answers 200 directly (no redirect) — the old SKU is still live`);
        } else {
            bad(`${oldSku} answers ${res.status} — an old product URL is broken`);
        }
    }

    // ── 6. Positive control ─────────────────────────────────────────────────
    say('\n\x1b[1m6. Positive control\x1b[0m');
    const { body: ctrl } = await getJson(
        '/api/shop?brand=lexmark&category=toner&code=ZZZNOTACODE999&limit=200');
    const ctrlRows = ctrl?.data?.products || [];
    if (ctrlRows.length) {
        bad(`a nonsense code returned ${ctrlRows.length} products — the code filter is not filtering`,
            'every round-trip check above is therefore meaningless');
    } else {
        ok('a nonsense code returns zero rows — the code filter really filters');
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    say('');
    say(`  ${pass} check(s) passed, ${findings.length} finding(s), ${notes.length} note(s).`);
    if (JSON_OUT) console.log(JSON.stringify({ pass, findings, notes, rejected }, null, 2));
    if (findings.length) {
        say('\n  \x1b[31mFindings:\x1b[0m');
        for (const f of findings) say(`   • ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
        say('');
        process.exit(1);
    }
    say('  \x1b[32mClean.\x1b[0m\n');
    process.exit(0);
}

main().catch((err) => {
    console.error(`\n✖ probe crashed: ${err && err.stack ? err.stack : err}`);
    process.exit(2);
});
