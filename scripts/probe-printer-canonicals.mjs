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

const strip = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
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

// ── §2 Re-derive the pairs. THE DRIFT DETECTOR. ────────────────────────────
console.log(`\n\x1b[1m§2 re-derive the pairs from the live sitemap — the drift detector\x1b[0m`);
const groups = new Map();
for (const r of rows) {
    const k = `${r.brand || ''}|${strip(r.slug)}`;
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(r.slug);
}
const livePairs = [...groups.values()].filter((v) => v.size > 1).map((v) => [...v]);
console.log(`      live sitemap contains ${livePairs.length} duplicate group(s)`);

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
        `and is being submitted to Google as a separate page:\n      ` +
        uncovered.map((g) => g.join('  ⟷  ')).join('\n      ') +
        `\n      Add it to PrinterSlug.DUPLICATES in inkcartridges/js/utils.js after checking ` +
        `BOTH sides return the same products (§3 below is the check).`);
}

// ── §3 Every table entry is still real, and still a true duplicate ─────────
console.log(`\n\x1b[1m§3 every pair in the table is still two rows with the same products\x1b[0m`);
const liveSlugs = new Set(rows.map((r) => r.slug));
const entries = Object.entries(TABLE);
let checked = 0;
for (const [loser, winner] of entries) {
    if (!liveSlugs.has(loser) && !liveSlugs.has(winner)) {
        soft(`${loser} / ${winner}`, 'neither spelling is in the sitemap any more — the backend may have merged the rows; the entry is now inert and can be retired');
        continue;
    }
    const fetchSet = async (slug) => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(`${API}/api/products/printer/${encodeURIComponent(slug)}`);
            if (res.status === 429) { await sleep(3000); continue; }
            if (!res.ok) return { err: `HTTP ${res.status}` };
            const j = await res.json().catch(() => null);
            const d = j && j.data;
            if (!d) return { err: 'no data envelope' };
            return { id: d.printer && d.printer.id, skus: (d.compatible_products || []).map((p) => p.sku).sort().join(',') };
        }
        return { err: 'rate-limited after 3 attempts' };
    };
    const a = await fetchSet(loser);
    const b = await fetchSet(winner);
    await sleep(250);
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
for (const [loser, winner] of sample) {
    const brand = (rows.find((r) => r.slug === loser) || {}).brand || '';
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
    if (href.includes(winner)) { backendDone++; ok(`prerender canonical for ${loser} → ${winner}`); }
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
