#!/usr/bin/env node
/**
 * Are the duplicate printer URLs consolidated — and has a new pair appeared?
 * ==========================================================================
 * ERR-242.
 *
 * `printer_models` holds some physical printers under more than one row because
 * the supplier feeds spell them differently. The backend unioned their link
 * sets so a customer gets the full cartridge list whichever spelling they land
 * on — and THAT is what created the SEO problem, because `sitemap-printers.xml`
 * selects on `product_compatibility!inner` and the previously-empty twin used to
 * be excluded automatically. Now it qualifies, and Google is handed two URLs
 * with byte-identical content.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * tests/printer-slug-canonical-sep2026.test.js proves the TABLE is internally
 * consistent and that our links use it. It cannot prove the table still matches
 * reality — the pairs come from a supplier feed nobody in this repo controls, so
 * a new spelling can appear next week and the test would stay green while a
 * sixteenth duplicate quietly entered the sitemap. §2 is the only thing that
 * catches that, and it is why this probe exists at all.
 *
 * It also reports the half we do NOT own. Googlebot does not read the SPA on
 * these URLs: middleware.js prerenders them and the BACKEND writes that page's
 * <link rel="canonical">. Measured 2026-09-09, it was self-referential on both
 * twins. §4 checks it, and is EXPECTED TO FAIL until the backend ships their
 * half — it says so on every run rather than looking like our bug.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * GETs against the public sitemap, the public API and public pages. There is no
 * --record and no --update-baseline, deliberately: a probe that can record may
 * be green only because it just overwrote what it compared against (sweep:b2b
 * ate a committed fixture, 2026-08-12). The mode is PRINTED on every run.
 *
 * It reads the REAL table out of inkcartridges/js/utils.js. It does not carry
 * its own copy — ERR-231's probe was certifying a replica of the thing it was
 * supposed to be checking, and agreed with it perfectly while both were wrong.
 *
 *   npm run probe:printer-canonicals
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.PROBE_API || 'https://api.inkcartridges.co.nz';
const SITE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const cannotRun = (m) => { console.log(`\n\x1b[33m▲ probe could not run\x1b[0m — ${m}`); process.exit(2); };

console.log('\n\x1b[1mprobe:printer-canonicals — duplicate printer URLs (ERR-242)\x1b[0m');
console.log('\x1b[36mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no writes.');
console.log(`Sitemap + API: ${API}    Site: ${SITE}\n`);

// ── The real table, loaded from the module that owns it ────────────────────
const utilsPath = path.join(ROOT, 'inkcartridges', 'js', 'utils.js');
if (!fs.existsSync(utilsPath)) cannotRun(`utils.js not found at ${utilsPath}`);
// utils.js is CommonJS and its module.exports sits inside an `if` block, so
// Node's named-export detection does not always see through it. Take the
// default (= module.exports) when the named binding is absent, rather than
// assuming either shape.
const utilsMod = await import(`file://${utilsPath}`).catch((e) => cannotRun(`could not load utils.js — ${e.message}`));
const PrinterSlug = (utilsMod && utilsMod.PrinterSlug) || (utilsMod && utilsMod.default && utilsMod.default.PrinterSlug);
if (!PrinterSlug || !PrinterSlug.DUPLICATES) cannotRun('utils.js does not export PrinterSlug');
const TABLE = PrinterSlug.DUPLICATES;
console.log(`Table under test: ${Object.keys(TABLE).length} pairs, read from inkcartridges/js/utils.js\n`);

/**
 * THE GROUPING RULE — and the one character it must NOT touch (ERR-249).
 *
 * This used to be `replace(/[^a-z0-9]/g, '')` — strip EVERY non-alphanumeric.
 * That merges `epson-1600k3` with `epson-1600k3+`, and those are two different
 * printers. `+` is part of the model name: LQ-300 vs LQ-300+, M880z vs M880z+.
 * Verified live 2026-09-12 — /api/printers/search returns both spellings as
 * separate rows, plus a third (`hp-color-laserjet-m880z+nfc`) which settles that
 * the suffix carries meaning.
 *
 * The old rule only got away with it by ACCIDENT: encodeURIComponent writes `+`
 * into the sitemap as `%2B`, so normalising the URL string rather than the slug
 * left `…k32b` and those five never grouped. An accident is not a safeguard.
 *
 * So we use the rule the backend shipped: two slugs are the same machine when
 * they differ only in SEPARATORS — hyphen, underscore, space — plus a TRAILING
 * FULL STOP, which is a data-entry artefact. Everything else is preserved.
 */
const strip = (s) => String(s)
    .toLowerCase()
    .replace(/\.+$/, '')        // a trailing full stop is an artefact
    .replace(/[-_\s]/g, '');    // separators only — NOT `+`, NOT `.` mid-slug

// Positive control for the rule itself, asserted before it is trusted. A
// grouping rule with no control is how 17,686 edit-distance "pairs" happened.
{
    const same = strip('printronix-103.23.') === strip('printronix-103.23');
    const differ = strip('epson-1600k3+') !== strip('epson-1600k3');
    const alsoDiffer = strip('brother-dcp-130c') !== strip('brother-dcp-135c');
    if (!same || !differ || !alsoDiffer) {
        cannotRun('the grouping rule failed its own control — refusing to report on it: '
            + `trailing-dot-merges=${same} plus-preserved=${differ} real-models-distinct=${alsoDiffer}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fetch the live sitemap ─────────────────────────────────────────────────
let xml;
try {
    const res = await fetch(`${API}/sitemap-printers.xml`);
    if (!res.ok) cannotRun(`sitemap-printers.xml answered ${res.status}`);
    xml = await res.text();
} catch (e) {
    cannotRun(`could not fetch the sitemap — ${e.message}`);
}
const rows = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    try {
        const u = new URL(m[1].replace(/&amp;/g, '&'));
        return { brand: u.searchParams.get('brand'), slug: u.searchParams.get('printer_slug') };
    } catch { return null; }
}).filter((r) => r && r.slug);

if (!rows.length) cannotRun('sitemap parsed to zero printer URLs — the format changed');
console.log(`\x1b[1m§1 the sitemap\x1b[0m`);
ok(`sitemap-printers.xml parsed — ${rows.length} printer URLs`);

// ── §2 THE DRIFT DETECTOR — and the input it lost ──────────────────────────
//
// 🚨 READ THIS BEFORE TRUSTING A GREEN §2.
//
// This section used to discover duplicate groups by grouping the live sitemap's
// own slugs. On 2026-09-10 the backend did what we asked in
// printer-canonicals-backend-brief-sep2026.md and DROPPED EVERY LOSER FROM THE
// SITEMAP. Measured 2026-09-12: 4,118 URLs, 0 losers, every winner present.
//
// Which means the detector's input no longer contains a single duplicate, and
// grouping it can only ever return zero. It would have passed forever, for the
// reason it was built to catch. A probe that goes green because its input was
// emptied is the shape recorded in feedback_live_probes: *a probe that records
// may be green because it just overwrote what it compared against* — arriving
// here from the other direction, where what was overwritten was the question.
//
// So the sitemap now answers a DIFFERENT question, honestly labelled: are any
// known losers still being submitted? Discovery moves to /api/printers/search,
// which sees both spellings of every pair — including the Printronix one, which
// the sitemap has never carried at all because its slug-shape gate rejects `.`.
console.log(`\n\x1b[1m§2 the sitemap — are any known LOSERS still submitted?\x1b[0m`);
console.log('      (this is no longer duplicate DISCOVERY — the losers were removed on request,');
console.log('       so grouping the sitemap can only ever find zero. Discovery is §2b.)');
{
    const live = new Set(rows.map((r) => String(r.slug).toLowerCase()));
    const stillSubmitted = Object.keys(TABLE).filter((loser) => live.has(loser));
    if (stillSubmitted.length === 0) {
        ok(`0 of ${Object.keys(TABLE).length} known losers appear in the sitemap`);
    } else {
        bad('a canonicalised loser is still being submitted to Google',
            `${stillSubmitted.length}: ${stillSubmitted.join(', ')}`);
    }
    const winners = new Set(Object.values(TABLE));
    const presentWinners = [...winners].filter((w) => live.has(w));
    console.log(`      ${presentWinners.length} of ${winners.size} winners are in the sitemap`);
    const absent = [...winners].filter((w) => !live.has(w));
    if (absent.length) {
        // Not a failure: printronix-103.23 is shape-excluded by design, and a
        // winner with no compat links legitimately never qualified. Named, so
        // the absence is visible rather than looking like an oversight.
        soft('a winner is not in the sitemap',
             `${absent.join(', ')} — expected for the Printronix pair (the sitemap's slug-shape `
             + `gate rejects the '.', so neither spelling has ever been submitted; the prerender `
             + `canonical is doing what it can). Any OTHER name here is a winner with no compat links.`);
    }
}

// ── §2b Discovery, from a source that can still SEE a duplicate ────────────
console.log(`\n\x1b[1m§2b re-derive the pairs from /api/printers/search — the drift detector\x1b[0m`);
const searchSlugs = new Map();   // slug -> brand
{
    // Seed from the table's own model names plus a sample of live sitemap
    // slugs, so a NEW spelling of a printer we already know about surfaces, and
    // so the corpus is not merely the table read back to itself (ERR-231: the
    // probe was certifying a replica of the thing it was checking).
    const seeds = new Set();
    for (const slug of [...Object.keys(TABLE), ...Object.values(TABLE)]) {
        const tail = String(slug).split('-').slice(1).join(' ').trim();
        if (tail) seeds.add(tail);
    }
    for (const r of rows.slice(0, 40)) {
        const tail = String(r.slug).split('-').slice(1).join(' ').trim();
        if (tail) seeds.add(tail);
    }
    // CAP AND SPACE THE DISCOVERY QUERIES — they are new load on the same
    // per-IP budget §3 needs immediately afterwards (ERR-249). The first run of
    // this section spent ~60 requests and §3's very first pair then reported
    // "could not compare: rate-limited", which the summary prints as a FAILURE.
    // The instrument was manufacturing its own bad news. Discovery is a sample,
    // not a census — it only has to be wide enough to surface a NEW spelling.
    const SEED_CAP = 28;
    const capped = [...seeds].slice(0, SEED_CAP);
    if (seeds.size > SEED_CAP) {
        console.log(`      sampling ${SEED_CAP} of ${seeds.size} seeds (paced, to leave §3 its rate budget)`);
    }
    let queried = 0;
    for (const q of capped) {
        try {
            const res = await fetch(`${API}/api/printers/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) continue;
            const j = await res.json();
            for (const row of (j.data || [])) {
                if (row && row.slug) {
                    searchSlugs.set(String(row.slug).toLowerCase(), row.brand?.slug || row.brand?.name || '');
                }
            }
            queried += 1;
        } catch { /* one bad query must not sink the section */ }
        await sleep(400);
    }
    console.log(`      ${queried} queries → ${searchSlugs.size} distinct printer slugs`);
    if (searchSlugs.size < 20) {
        soft('discovery is thin this run',
             `only ${searchSlugs.size} slugs came back from /api/printers/search, so §2b is NOT `
             + `a meaningful drift detector on this run. Reported rather than passed silently: `
             + `a check that declined to run must say so by name.`);
    }
}

const groups = new Map();
for (const [slug, brand] of searchSlugs) {
    const k = `${brand || ''}|${strip(slug)}`;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(slug);
}
const livePairs = [...groups.values()].filter((v) => v.size > 1).map((v) => [...v]);
console.log(`      printer feed contains ${livePairs.length} duplicate group(s) under the shipped rule`);

const uncovered = [];
for (const slugs of livePairs) {
    // Covered when exactly one member survives canonicalisation — i.e. every
    // other spelling is a known loser pointing at that one.
    const resolved = new Set(slugs.map((s) => PrinterSlug.canonical(s)));
    if (resolved.size !== 1) uncovered.push(slugs);
}
if (uncovered.length === 0) {
    ok(`every duplicate group in the live sitemap resolves to ONE url`);
} else {
    bad('a duplicate printer URL pair is NOT in the table',
        `${uncovered.length} group(s) the table does not cover — a new supplier spelling has appeared ` +
        `and both are advertised as separate pages:\n      ` +
        uncovered.map((g) => g.join('  ⟷  ')).join('\n      ') +
        `\n      Add it to PrinterSlug.DUPLICATES in inkcartridges/js/utils.js after checking ` +
        `BOTH sides return the same products (§3 below is the check).`);
}

// ── §3 Every table entry is still real, and still a true duplicate ─────────
// A deliberate cooldown between the two sections that share a per-IP budget.
// Without it §3's first pair lands inside the window §2b just filled, and a
// REFUSAL gets printed as a disagreement — the ERR-243 mistake, made by the
// probe against itself this time.
console.log(`\n      cooling down 20s so §3 does not read §2b's rate limit as a data difference…`);
await sleep(20000);

console.log(`\n\x1b[1m§3 every pair in the table is still two rows with the same products\x1b[0m`);
const liveSlugs = new Set(rows.map((r) => r.slug));
const entries = Object.entries(TABLE);
let checked = 0;
for (const [loser, winner] of entries) {
    if (!liveSlugs.has(loser) && !liveSlugs.has(winner)) {
        // ⚠️ ABSENT FROM THE SITEMAP HAS TWO CAUSES AND THEY NEED OPPOSITE ACTIONS.
        // "The rows were merged, retire the entry" is one. The other is that the
        // sitemap's slug-shape gate REFUSES the slug and always has — which is
        // the Printronix pair, where retiring the entry would drop the only
        // canonical the prerenderer has to work with. A slug carrying a
        // character the gate rejects has never been in the sitemap, so its
        // absence says nothing about the rows at all.
        const shapeExcluded = /[^a-z0-9-]/.test(loser) || /[^a-z0-9-]/.test(winner);
        if (shapeExcluded) {
            soft(`${loser} / ${winner}`,
                'neither spelling is sitemapped and neither ever was — the slug carries a character '
                + "the sitemap's shape gate rejects (a '.', here). This entry is PRERENDER-ONLY and "
                + 'must NOT be retired: it is what makes our internal links and the SPA canonical '
                + 'agree with the prerenderer. The durable fix is a server-side slug rename.');
        } else {
            soft(`${loser} / ${winner}`,
                'neither spelling is in the sitemap any more — the backend may have merged the rows; '
                + 'the entry may now be inert. Check /api/products/printer/ for both before retiring it.');
        }
        continue;
    }
    const fetchSet = async (slug) => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const res = await fetch(`${API}/api/products/printer/${encodeURIComponent(slug)}`);
            // PACE THE INSTRUMENT BEFORE BELIEVING ITS WORST NUMBER (ERR-243).
            // §2b now spends ~60 queries on this origin immediately above, so a
            // flat 3s retry was landing straight back in the same window and
            // reporting a REFUSAL as a disagreement — which §3 then prints as
            // "could not compare", a failure. Progressive backoff, and more of
            // them, because being slow is free and a false alarm is not.
            if (res.status === 429) { await sleep(4000 + attempt * 9000); continue; }
            if (!res.ok) return { err: `HTTP ${res.status}` };
            const j = await res.json().catch(() => null);
            const d = j && j.data;
            if (!d) return { err: 'no data envelope' };
            return { id: d.printer && d.printer.id, skus: (d.compatible_products || []).map((p) => p.sku).sort().join(',') };
        }
        return { err: 'rate-limited after 5 attempts (paced to 5 minutes) — NOT counted as agreement' };
    };
    const a = await fetchSet(loser);
    await sleep(700);
    const b = await fetchSet(winner);
    await sleep(700);
    if (a.err || b.err) {
        // NOT counted as "same" — a read we could not make is not a read that agreed.
        bad(`${loser} / ${winner}`, `could not compare: ${a.err || ''} ${b.err || ''}`.trim());
        continue;
    }
    if (a.skus !== b.skus) {
        bad(`${loser} / ${winner}`,
            'the two rows NO LONGER return the same products. Canonicalising them now hides ' +
            'real inventory — remove the entry, or ask the backend why the union regressed.');
        continue;
    }
    checked++;
}
if (checked) ok(`${checked}/${entries.length} pairs verified as two rows with identical product sets`);

// ── §4 The BACKEND's half — expected to fail until they ship it ────────────
console.log(`\n\x1b[1m§4 the prerendered canonical — THE BACKEND'S HALF, not ours\x1b[0m`);
console.log('      Googlebot gets a server-rendered page here, not the SPA, so the canonical');
console.log('      it reads is written by /api/prerender/… — we cannot set it from this repo.');
const sample = entries.slice(0, 4);
let backendDone = 0;

/**
 * 🚨 THE BRAND MUST NOT COME FROM THE SITEMAP. (ERR-249, found by this probe
 * reporting a false alarm on its first run after the backend shipped.)
 *
 * This used to read `rows.find(r => r.slug === loser).brand` — and the losers
 * were removed from the sitemap on OUR request, so that lookup now returns
 * undefined for every pair. The URL became `/shop?brand=&printer_slug=…`, and
 * `middleware.js` gates the printer prerender on `brandSlug && printerSlug`, so
 * an empty brand is served the SPA SHELL, whose canonical is a bare `/shop`.
 * §4 then reported "still self-references" about four canonicals that are in
 * fact correct — verified by hand the same day, all four naming the winner.
 *
 * A probe that loses an input does not go quiet; it starts lying confidently.
 * Brand now comes from the printer feed (which still carries both spellings),
 * then the WINNER's sitemap row, then the slug's own first segment.
 */
const brandFor = (loser, winner) => searchSlugs.get(loser)
    || searchSlugs.get(winner)
    || (rows.find((r) => r.slug === winner) || {}).brand
    || String(winner).split('-')[0];

for (const [loser, winner] of sample) {
    const brand = brandFor(loser, winner) || '';
    if (!brand) { soft(`${loser}`, 'no brand could be resolved — skipping rather than requesting an unbranded URL that is never prerendered'); continue; }
    const url = `${SITE}/shop?brand=${encodeURIComponent(brand)}&printer_slug=${encodeURIComponent(loser)}`;
    let html = '';
    try {
        const res = await fetch(url, { headers: { 'User-Agent': GOOGLEBOT } });
        html = await res.text();
    } catch (e) {
        soft(`${loser}`, `could not fetch as Googlebot — ${e.message}`);
        continue;
    }
    const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
        || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
    const href = m ? m[1].replace(/&amp;/g, '&') : null;
    if (!href) { soft(`${loser}`, 'no canonical found in the prerendered HTML'); continue; }
    // Whole-value, never substring: a winner slug can be a PREFIX of a longer
    // real model (measured: oki-mc-362dn sits inside oki-mc-362dnw).
    const canonicalSlug = (() => { try { return new URL(href).searchParams.get('printer_slug'); } catch { return null; } })();
    if (canonicalSlug === winner) { backendDone++; ok(`prerender canonical for ${loser} → ${winner}`); }
    else if (canonicalSlug === null && /\/shop\/?($|\?)/.test(href)) {
        // A bare /shop is the SPA SHELL's canonical, not a self-reference. That
        // means we were served the SPA — usually because the URL we asked for is
        // not one the prerenderer handles — so it is a PROBE fault, not a
        // backend one, and must not be reported as the backend's.
        soft(`${loser}`,
            `got the SPA shell (canonical ${href}), not the prerendered page. The prerender is gated `
            + `on brand AND printer_slug; brand resolved to "${brand}". This says nothing about the `
            + `backend's canonical — fix the request before reading anything into the answer.`);
    }
    else {
        soft(`prerender canonical for ${loser} still self-references`,
            `got ${href}\n      This is the backend's to fix — see printer-canonicals-backend-brief-sep2026.md. ` +
            'It is reported as a NOTE, not a failure, because no change in this repo can move it.');
    }
}
console.log(`      backend half: ${backendDone}/${sample.length} sampled pairs consolidated`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n\x1b[1mSummary\x1b[0m`);
console.log(`  passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
if (notes.length) {
    console.log('\n  Notes (not failures — mostly the backend half):');
    notes.forEach((n) => console.log(`    ~ ${n.split('\n')[0]}`));
}
if (failures.length) {
    console.log('\n\x1b[31m  FAILURES\x1b[0m');
    failures.forEach((f) => console.log(`    ✗ ${f.split('\n')[0]}`));
    process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — every duplicate group in the live sitemap resolves to one URL.\n');
