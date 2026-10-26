#!/usr/bin/env node
/**
 * Do the receipt rolls reach shoppers and crawlers, and does the backend still
 * answer the way the storefront assumes?
 * =============================================================================
 * ERR-368 (backend handoff 2026-10-23, FE-MASTER-CHECKLIST item 48).
 *
 * tests/receipt-rolls-oct2026.test.js EXECUTES the middleware, SeoMeta, the
 * listing and the PDP against fixtures. It cannot prove the live chain:
 *   - www answers 200 (not the old 301 → /shop) on the three listing URLs;
 *   - the backend's aliases 301 to `receipt`, junk is still stripped;
 *   - a crawler gets the category prerender, and its <title>/<h1> still match
 *     the words the SPA prints (cloaking parity — read from shop-page.js, not
 *     copied here);
 *   - the API still returns every roll, grouped bond → carbonless → thermal,
 *     with the `specifications` keys the PDP spec pills read;
 *   - where the nav feed points the category (NOTE: when it says
 *     /receipt-rolls — set by the backend 2026-10-25; now REQUIRED, §4 fails otherwise).
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * GETs only, against public pages, the public API and the public prerender.
 * No --record, no --write, no login. The mode is PRINTED below.
 *
 * Exit: 0 = the chain holds
 *       1 = a real finding
 *       2 = could not run (network / cold start). "We could not look" is never
 *           reported as "we looked and it was fine".
 *
 * Run: npm run probe:receipt-rolls
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = 'https://www.inkcartridges.co.nz';
const API = 'https://api.inkcartridges.co.nz';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36';

// The SPA's own words, read from source so this probe cannot certify a replica.
const SHOP_SRC = readFileSync(path.join(ROOT, 'inkcartridges/js/shop-page.js'), 'utf8');
const SPA_H1 = /RECEIPT_H1: '([^']+)'/.exec(SHOP_SRC)?.[1];
const SPA_TITLE = /title {7}= '(Thermal Receipt[^']+)'/.exec(SHOP_SRC)?.[1];
const SPEC_KEYS = ['roll_width_mm', 'roll_diameter_mm', 'paper', 'paper_weight_gsm', 'rolls_per_pack'];

console.log('probe:receipt-rolls — mode: READ-ONLY (GET only, no login, nothing recorded)\n');

const findings = [];
const notes = [];
let unreachable = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => { findings.push(msg); console.log(`  FAIL  ${msg}`); };
const note = (msg) => { notes.push(msg); console.log(`  note  ${msg}`); };

async function get(url, { ua = HUMAN, json = false } = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': ua, Accept: json ? 'application/json' : 'text/html' } });
            if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
            const body = await res.text();
            return { status: res.status, location: res.headers.get('location'), body };
        } catch (e) {
            if (attempt === 3) { unreachable++; console.log(`  ????  ${url} — ${e.message}`); return null; }
            await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
    return null;
}
const pace = () => new Promise((r) => setTimeout(r, 400));

// ── §1 shoppers: status codes ───────────────────────────────────────────────
console.log('§1 www, as a shopper');
for (const p of ['/shop?category=receipt', '/receipt-rolls', '/shop?brand=okin&category=receipt']) {
    const r = await get(WWW + p); await pace();
    if (!r) continue;
    if (r.status === 200) ok(`${p} → 200`);
    else bad(`${p} → ${r.status}${r.location ? ` ${r.location}` : ''} (expected 200)`);
}
const redirects = [
    ['/shop?category=receipt-rolls', '/receipt-rolls'], // one hop to the landing (reply 2026-10-25 §3)
    ['/shop?category=receipt-roll', '/receipt-rolls'], // one hop to the landing (reply 2026-10-25 §3)
    ['/shop?category=receipt_roll', '/receipt-rolls'], // one hop to the landing (reply 2026-10-25 §3)
    ['/shop?brand=okin&category=receipt-rolls', '/shop?brand=okin&category=receipt'],
    ['/shop?category=photo_paper', '/shop?category=paper'],
    ['/shop?category=junk', '/shop'], // NEGATIVE CONTROL — still stripped
];
for (const [from, to] of redirects) {
    const r = await get(WWW + from); await pace();
    if (!r) continue;
    const loc = r.location ? new URL(r.location, WWW) : null;
    const got = loc ? loc.pathname + loc.search : null;
    if (r.status === 301 && got === to) ok(`${from} → 301 ${to}`);
    else bad(`${from} → ${r.status} ${got || ''} (expected 301 ${to})`);
}

// ── §2 crawlers: prerender + parity ─────────────────────────────────────────
console.log('\n§2 www, as Googlebot');
if (!SPA_H1 || !SPA_TITLE) bad('could not read RECEIPT_H1 / the roll <title> out of shop-page.js — the parity check has nothing to compare');
for (const p of ['/receipt-rolls', '/shop?category=receipt', '/shop?brand=okin&category=receipt']) {
    const r = await get(WWW + p, { ua: BOT }); await pace();
    if (!r) continue;
    const title = /<title>([^<]*)<\/title>/i.exec(r.body)?.[1]?.replace(/&amp;/g, '&').trim();
    const h1 = /<h1[^>]*>([^<]*)<\/h1>/i.exec(r.body)?.[1]?.replace(/&amp;/g, '&').trim();
    if (r.status !== 200) { bad(`${p} (bot) → ${r.status}`); continue; }
    if (title === SPA_TITLE && h1 === SPA_H1) ok(`${p} (bot) → prerender, title + h1 = the SPA's`);
    else bad(`${p} (bot) → title "${title}" / h1 "${h1}" — the SPA prints "${SPA_TITLE}" / "${SPA_H1}"`);
}

// ── §3 the API the listing and PDP read ─────────────────────────────────────
console.log('\n§3 api, the data the storefront reads');
const list = await get(`${API}/api/products?category=receipt&limit=100`, { json: true }); await pace();
if (list) {
    let body = null;
    try { body = JSON.parse(list.body); } catch { bad(`/api/products?category=receipt → not JSON (${list.status})`); }
    const rows = body?.data?.products || (Array.isArray(body?.data) ? body.data : null);
    if (!rows) bad(`/api/products?category=receipt → no rows (${list.status})`);
    else {
        const total = body.meta?.total;
        if (total !== rows.length) bad(`meta.total ${total} but ${rows.length} rows — the listing would show its partial note`);
        else ok(`${rows.length} rolls, meta.total ${total}`);
        if (rows.length !== 19) note(`catalogue now has ${rows.length} rolls (19 at handoff) — fine, the listing has no hard count`);
        const rank = (p) => ({ Bond: 0, Carbonless: 1, Thermal: 2 })[String(p.specifications?.paper || p.name).split(/\s/)[0]] ?? 9;
        const ranks = rows.map(rank);
        if (ranks.every((r, i) => i === 0 || r >= ranks[i - 1])) ok('API order is bond → carbonless → thermal (the listing keeps it)');
        else bad(`API order is no longer grouped by paper: ${rows.map((p) => p.sku).join(', ')}`);
        const notRoll = rows.filter((p) => p.product_type !== 'receipt_roll').map((p) => p.sku);
        if (notRoll.length) bad(`non-roll rows in the category: ${notRoll.join(', ')}`);
        else ok('every row is product_type receipt_roll');
    }
}
for (const [sku, expectImage] of [['CTR80X80P5', true], ['CCR76X76P5', false]]) {
    const r = await get(`${API}/api/products/${sku}`, { json: true }); await pace();
    if (!r) continue;
    let p = null;
    try { p = JSON.parse(r.body).data; } catch { bad(`/api/products/${sku} → not JSON (${r.status})`); continue; }
    const missing = SPEC_KEYS.filter((k) => p?.specifications?.[k] == null);
    if (missing.length) bad(`${sku}: specifications missing ${missing.join(', ')} — its spec pills would be short`);
    else ok(`${sku}: specifications carry ${SPEC_KEYS.length}/${SPEC_KEYS.length} keys`);
    if (!expectImage && p?.image_url) note(`${sku} now has a photo (${p.image_url}) — the placeholder no longer shows, as intended`);
    if (Array.isArray(p?.compatible_printers) && p.compatible_printers.length) note(`${sku} now lists ${p.compatible_printers.length} printers — the PDP still shows none for rolls`);
}

// ── §4 the backend's landingPath (promised in its reply of 2026-10-25 §3) ──
// The FE now canonicalises the roll category to /receipt-rolls; if the
// backend's nav ever stops nominating it, the SPA follows the feed but this
// fails, because shopper-facing canonical and bot prerender would split.
console.log('\n§4 nav feed nominates /receipt-rolls');
const nav = await get(`${API}/api/site/nav`, { json: true });
if (nav) {
    try {
        const cat = JSON.parse(nav.body).data.categories.find((c) => c.slug === 'receipt');
        if (!cat) bad('/api/site/nav no longer lists the receipt category');
        else if (cat.path === '/receipt-rolls' && cat.landing === true) ok('nav receipt path /receipt-rolls (landing: true)');
        else bad(`nav receipt path ${cat.path} (landing: ${cat.landing}) — expected /receipt-rolls, landing true`);
    } catch { bad('/api/site/nav → not parseable'); }
}

console.log(`\n${findings.length} finding(s), ${notes.length} note(s), ${unreachable} unreachable`);
if (findings.length) process.exit(1);
if (unreachable) { console.log('could not look at everything — NOT a pass'); process.exit(2); }
process.exit(0);
