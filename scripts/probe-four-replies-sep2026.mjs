#!/usr/bin/env node
/**
 * probe:four-replies — the backend's answer to our four 2026-09-28 replies (ERR-294)
 * and its round-2 answer of 2026-09-29 (ERR-299: BF-088, BF-091, BF-092, BF-093)
 * ================================================================================
 * backend-docs/inbox/fe-four-replies-backend-response-sep2026.md and
 * backend-docs/inbox/fe-best-sellers-and-four-replies-round2-backend-response-sep2026.md.
 * The unit suites (tests/four-replies-backend-response-sep2026.test.js,
 * tests/round2-backend-response-sep2026.test.js) prove the shipped functions;
 * this proves the LIVE contract they rest on, and (with --browser) the pages.
 *
 *   §R  every ribbon: /api/ribbons/:sku carries description_html +
 *       related_product_skus (BF-084), and series_codes = its product_codes
 *       override, else [] (BF-085). The storefront no longer checks either.
 *   §V  cross-type visitors (BF-086): every product_code_visitors row is listed
 *       by /api/shop?brand&category=<visited>&code. 0 rows today ⇒ printed as
 *       UNMEASURED, never as a pass (a skip is not a pass).
 *   §C  BF-088: every product_codes override code is in /api/shop `series`,
 *       under itself or its base chip (yield tier stripped: 950XL → 950), and
 *       code=950XL / code=950 list the same products. HARD since ERR-299: the
 *       storefront's chip-count read is deleted, so a gap is a missing tile.
 *       BF-091: /api/products/counts drums = ?category=drums meta.total per
 *       brand. HARD since ERR-299: the landing hides a 0/absent tile with no
 *       confirming read — THIS comparison is the drift detector now.
 *   §D  BF-092: /api/ribbons/:sku related_products resolves related_product_skus
 *       (prefix-tolerant, saved order) with in_stock/stock_status on each card.
 *   §E  BF-093: display_name on every printer surface the storefront reads it
 *       from; BF-094 (open ask): /api/shop listing compatible_printers[] and
 *       /api/printers/search still LACK it — printed SOFT while open.
 *   §P  both color-packs routes 404 (the deleted block had nothing to call).
 *   §S  search URLs carry X-Robots-Tag noindex; a brand hub does NOT (control).
 *   §O  old-site slugs keep the part number; a ribbon slug still goes to /ribbons.
 *   §N  display_name (the casing mirror was deleted 2026-10-06, BF-094) vs the
 *       backend's prerender <h1> for a sample of printers per brand.
 *   §A  --admin: failed import runs carry error_message; image-audit brand =
 *       slug or id, garbage = 400 UNKNOWN_BRAND (needs ADMIN_EMAIL/PASSWORD).
 *   §B  --browser: /toner-cartridges tiles; printer hub H1 = prerender H1 and no
 *       color-packs request; a redirected PDP asks for-use-in ONCE with the
 *       response's SKU; a ribbon PDP makes NO direct Supabase products read at
 *       all (BF-092 — the curated rail comes from /api/ribbons/:sku).
 *   §Q  --search: the ONE pinned alias query ("canon pg540"). It WRITES one
 *       search_analytics row (endpoint=smart) — off by default, printed when on.
 *
 * MODE: READ-ONLY. GETs only (plus the admin sign-in under --admin). No search is
 * made unless --search is passed. Analytics are aborted in the browser; this
 * probe counts API requests and reads rendered text, not transport (the
 * ctx.route CORS caveat does not apply to a request COUNT).
 *
 *   npm run probe:four-replies
 *   npm run probe:four-replies -- --admin --browser
 *   PROBE_BASE=http://localhost:3000 npm run probe:four-replies -- --browser
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { printSearchAnalyticsNotice } from './lib/probe-search-notice.mjs';

const require = createRequire(import.meta.url);

const argv = new Set(process.argv.slice(2));
const API = process.env.PROBE_API || 'https://ink-backend-sg.onrender.com';
const SITE = (process.env.PROBE_SITE || 'https://www.inkcartridges.co.nz').replace(/\/+$/, '');
const BASE = (process.env.PROBE_BASE || SITE).replace(/\/+$/, '');
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 700);

let pass = 0, fail = 0, softs = 0, unmeasured = 0;
const ok = (n, d = '') => { pass++; console.log(`  \x1b[32m✔\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  \x1b[31m✖ ${n}\x1b[0m${d ? ` — ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n, d) : bad(n, d));
const soft = (n, d) => { softs++; console.log(`  \x1b[33m⚠ ${n}\x1b[0m — ${d}`); };
const skip = (n, d) => { unmeasured++; console.log(`  \x1b[36m○ UNMEASURED ${n}\x1b[0m — ${d}`); };
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`probe:four-replies — \x1b[33mMODE: READ-ONLY\x1b[0m (GET only${argv.has('--admin') ? ', plus the admin sign-in' : ''}; `
    + `${argv.has('--search') ? '\x1b[31m--search: ONE real search_analytics row will be written\x1b[0m' : 'no search is made'})`);
// §Q is a REAL product term ("canon pg540") — it cannot carry the zz sentinel
// without measuring something else, so it is opt-in and says what it writes.
if (argv.has('--search')) printSearchAnalyticsNotice();
console.log(`API ${API}  SITE ${SITE}${argv.has('--browser') ? `  BASE ${BASE}` : ''}`);

/** GET JSON, waiting out a 429 (100 req/60s per IP, shared across endpoints — ERR-266). */
async function getJson(url, init = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
        await pause(DELAY_MS);
        const r = await fetch(url, init).catch(() => null);
        if (!r) return { status: 0, body: null };
        if (r.status === 429) { await pause((Number(r.headers.get('retry-after')) || 20) * 1000); continue; }
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body, headers: r.headers };
    }
    return { status: 429, body: null };
}
const sb = async (q) => (await getJson(`${SUPABASE}/rest/v1/${q}`, { headers: { apikey: ANON } })).body;

// ── §R ribbons ──────────────────────────────────────────────────────────────
head('§R ribbons: fields (BF-084) and override-or-[] codes (BF-085)');
{
    const ribbons = [];
    for (let page = 1; page <= 10; page++) {
        const r = await getJson(`${API}/api/ribbons?limit=100&page=${page}`);
        const rows = r.body?.data?.ribbons || [];
        ribbons.push(...rows);
        if (rows.length < 100) break;
    }
    const overrides = await sb('product_codes?select=product_id,code');
    if (!ribbons.length || !Array.isArray(overrides)) {
        bad('ribbon list + product_codes readable', `${ribbons.length} ribbons, product_codes ${Array.isArray(overrides) ? 'ok' : 'UNREADABLE'}`);
    } else {
        const byId = new Map();
        for (const o of overrides) byId.set(o.product_id, [...(byId.get(o.product_id) || []), String(o.code).toUpperCase()]);
        // Every ribbon with an override, plus a spread of the rest (the budget is per IP).
        const sample = [...ribbons.filter((r) => byId.has(r.id)), ...ribbons.filter((r) => !byId.has(r.id)).filter((_, i) => i % 8 === 0)];
        let missing = 0, wrong = 0;
        const wrongList = [];
        for (const r of sample) {
            const row = (await getJson(`${API}/api/ribbons/${encodeURIComponent(r.sku)}`)).body?.data;
            if (!row) { missing++; continue; }
            if (!('description_html' in row) || !('related_product_skus' in row)) missing++;
            const want = (byId.get(row.id) || []).slice().sort().join(',');
            const got = (row.series_codes || []).map((c) => String(c).toUpperCase()).sort().join(',');
            if (want !== got) { wrong++; wrongList.push(`${r.sku}: want [${want}] got [${got}]`); }
        }
        check(`/api/ribbons/:sku carries description_html + related_product_skus`, missing === 0,
            `${sample.length - missing}/${sample.length} (of ${ribbons.length} ribbons; ${sample.filter((r) => byId.has(r.id)).length} with an override)`);
        check('ribbon series_codes = its override, else []', wrong === 0, wrong ? wrongList.slice(0, 5).join('; ') : `${sample.length}/${sample.length}`);
    }
}

// ── §V visitors ─────────────────────────────────────────────────────────────
head('§V cross-type visitors listed by /api/shop (BF-086)');
{
    const tags = await sb('product_codes?select=product_id,code,chip_category&chip_category=not.is.null');
    if (!Array.isArray(tags)) bad('product_codes.chip_category readable', 'UNREADABLE');
    else if (!tags.length) skip('visitor rows', '0 tagged rows exist — the backend\'s pinned test is the only evidence until an admin tags one; re-run then');
    else {
        for (const t of tags) {
            const prod = (await sb(`products?select=sku,brand_id,brands(slug)&id=eq.${t.product_id}`))?.[0];
            const brand = prod?.brands?.slug;
            const r = await getJson(`${API}/api/shop?brand=${brand}&category=${t.chip_category}&code=${encodeURIComponent(t.code)}&limit=200`);
            const skus = (r.body?.data?.products || []).map((p) => p.sku);
            check(`${prod?.sku} under ${brand} · ${t.chip_category} · ${t.code}`, skus.includes(prod?.sku), `${skus.length} rows`);
        }
    }
}

// ── §C chips + counts ───────────────────────────────────────────────────────
head('§C override codes are in /api/shop series (BF-088) · counts = category totals (BF-091)');
{
    // The probe may read the view; the STOREFRONT no longer does (ERR-299).
    const rows = await sb('product_code_chip_counts?select=brand_slug,product_type,code,product_count');
    const CAT = { ink_cartridge: 'ink', ink_bottle: 'ink', toner_cartridge: 'toner', label_tape: 'label', photo_paper: 'paper' };
    for (const t of ['drum_unit', 'waste_toner', 'maintenance_box', 'belt_unit', 'fuser_kit', 'fax_film', 'fax_film_refill']) CAT[t] = 'drums';
    const groups = new Map();
    for (const r of rows || []) {
        const c = CAT[r.product_type];
        if (!c) continue;
        const k = `${r.brand_slug}|${c}`;
        groups.set(k, new Set([...(groups.get(k) || []), String(r.code).toUpperCase()]));
    }
    if (!Array.isArray(rows)) bad('product_code_chip_counts readable', 'UNREADABLE — BF-088 unmeasured');
    else {
        // The backend's rule: a yield tier is stripped from each code to name its chip.
        const base = (c) => c.replace(/(XXL|XL|HY)$/, '');
        const gaps = [];
        let n = 0;
        for (const [k, codes] of groups) {
            const [brand, cat] = k.split('|');
            const series = new Set(((await getJson(`${API}/api/shop?brand=${brand}&category=${cat}&limit=1`)).body?.data?.series || [])
                .flatMap((x) => String(x.code).toUpperCase().split('/')));
            for (const c of codes) { n++; if (!series.has(c) && !series.has(base(c))) gaps.push(`${brand}·${cat}·${c}`); }
        }
        check(`${n} override codes: each is in series, under itself or its base chip`, gaps.length === 0, gaps.join(', ') || `${groups.size} brand·category groups`);
    }
    const a = (await getJson(`${API}/api/shop?brand=hp&category=ink&code=950XL&limit=50`)).body?.data?.products || [];
    const b2 = (await getJson(`${API}/api/shop?brand=hp&category=ink&code=950&limit=50`)).body?.data?.products || [];
    const sig = (xs) => xs.map((p) => p.sku).sort().join(',');
    check('code=950XL and code=950 list the same products (one chip, not two)', a.length > 0 && sig(a) === sig(b2), `${sig(a)} | ${sig(b2)}`);

    const brands = ['epson', 'canon', 'brother', 'hp', 'lexmark'];
    const counts = (await getJson(`${API}/api/products/counts?brands=${brands.join(',')}`)).body?.data || {};
    const lines = [];
    let drift = 0;
    for (const br of brands) {
        const total = (await getJson(`${API}/api/shop?brand=${br}&category=drums&limit=1`)).body?.meta?.total;
        const said = counts[br]?.drums ?? 0;   // absent = 0 is the storefront's reading now
        if (typeof total !== 'number' || total !== said) drift++;
        lines.push(`${br} ${said}/${total}`);
    }
    check('BF-091: /api/products/counts drums = ?category=drums for every sampled brand (counts/total)', drift === 0, lines.join(', '));
}

// ── §D ribbon related cards ─────────────────────────────────────────────────
head('§D /api/ribbons/:sku related_products (BF-092)');
for (const [sku, want] of [['307.11', ['C141LOT', 'C143LOT']], ['153.11', ['C143LOT']], ['72200.01', ['72200.02']]]) {
    const d = (await getJson(`${API}/api/ribbons/${encodeURIComponent(sku)}`)).body?.data;
    const cards = Array.isArray(d?.related_products) ? d.related_products : null;
    check(`${sku}: related_products = ${want.join(', ')} in saved order, each with stock_status`,
        !!cards && cards.map((c) => c.sku).join(',') === want.join(',') && cards.every((c) => 'stock_status' in c && 'in_stock' in c),
        cards ? cards.map((c) => `${c.sku} ${c.sale_price} ${c.stock_status}`).join('; ') : `related_products ${JSON.stringify(d?.related_products)}`);
}
{
    const d = (await getJson(`${API}/api/ribbons/691.01`)).body?.data;
    check('CONTROL 691.01 (nothing curated): related_products = []', Array.isArray(d?.related_products) && d.related_products.length === 0,
        JSON.stringify(d?.related_products));
}

// ── §E printer display_name ─────────────────────────────────────────────────
head('§E display_name on printer rows (BF-093) and on listing + search rows (BF-094)');
{
    const has = (p) => typeof p?.display_name === 'string' && p.display_name.trim().length > 0;
    const pdp = (await getJson(`${API}/api/products/GTN2445BK`)).body?.data || {};
    const cp = pdp.compatible_printers || [];
    const top = (pdp.compatible_printers_grouped || []).flatMap((g) => g.top_models || []);
    check('PDP compatible_printers[] carry display_name', cp.length > 0 && cp.every(has), `${cp.filter(has).length}/${cp.length}; e.g. "${cp.find((p) => /L2375DW/.test(p.full_name))?.display_name}"`);
    check('PDP compatible_printers_grouped[].top_models[] carry display_name', top.length > 0 && top.every(has), `${top.filter(has).length}/${top.length}`);
    const bb = (await getJson(`${API}/api/printers/by-brand/brother`)).body?.data;
    const flat = Array.isArray(bb) ? bb : bb?.printers || [];
    check('/api/printers/by-brand/brother rows carry display_name', flat.length > 0 && flat.every(has), `${flat.filter(has).length}/${flat.length}`);
    for (const pth of ['/api/printers/brother-hl-l2375dw/products?limit=1', '/api/products/printer/brother-hl-l2375dw?limit=1']) {
        const pr = (await getJson(`${API}${pth}`)).body?.data?.printer;
        check(`${pth.split('?')[0]} printer.display_name = "Brother HL-L2375DW"`, pr?.display_name === 'Brother HL-L2375DW', `${pr?.full_name} → ${pr?.display_name}`);
    }
    const listing = ((await getJson(`${API}/api/shop?brand=brother&category=toner&limit=20`)).body?.data?.products || [])
        .flatMap((p) => p.compatible_printers || []);
    const search = (await getJson(`${API}/api/printers/search?q=L2375`)).body?.data || [];
    // BF-094 built (backend 2026-10-06) and the FE mirror DELETED the same day:
    // a row without display_name now prints its raw full_name, so this is a
    // hard check. An EMPTY answer fails too — it would pass `every` vacuously.
    for (const [name, xs] of [['/api/shop listing compatible_printers[]', listing], ['/api/printers/search?q=L2375', search]]) {
        check(`${name} rows carry display_name (BF-094)`, xs.length > 0 && xs.every(has), `${xs.filter(has).length}/${xs.length}`);
    }
}

// ── §P color-packs ──────────────────────────────────────────────────────────
head('§P both color-packs routes are gone');
for (const p of ['/api/printers/brother-hl-l2375dw/color-packs', '/api/products/printer/brother-hl-l2375dw/color-packs']) {
    const r = await getJson(`${API}${p}`);
    check(p, r.status === 404, `HTTP ${r.status}`);
}

// ── §S / §O the site (Vercel) ───────────────────────────────────────────────
async function headOf(url, ua) {
    await pause(DELAY_MS);
    const r = await fetch(url, { redirect: 'manual', headers: ua ? { 'User-Agent': ua } : {} }).catch(() => null);
    return r ? { status: r.status, robots: r.headers.get('x-robots-tag'), location: r.headers.get('location') } : null;
}
head('§S search URLs noindexed at the edge (control: a brand hub is not)');
{
    const GBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
    for (const u of ['/shop?search=zzprobe-noindex', '/shop?q=zzprobe-noindex', '/search?q=zzprobe-noindex']) {
        for (const ua of [null, GBOT]) {
            const r = await headOf(`${SITE}${u}`, ua);
            check(`${u} ${ua ? '(Googlebot)' : '(browser)'} → X-Robots-Tag noindex`, /noindex/.test(r?.robots || ''), `${r?.status} ${r?.robots}`);
        }
    }
    const control = await headOf(`${SITE}/shop?brand=hp`);
    check('CONTROL /shop?brand=hp carries no noindex', !/noindex/.test(control?.robots || ''), `${control?.status} ${control?.robots}`);
}
head('§O old-site slugs keep the part number');
for (const [from, want] of [
    ['/fuji-xerox-ct201304-toner-cartridge-cyan', '/shop?search=fuji-xerox-ct201304+cyan'],
    ['/brother-lc73-inkjet-cartridge-black-lc73bk', '/shop?search=brother-lc73+black-lc73bk'],
    ['/brother-typewriter-model-listing-for-ribbons', '/ribbons'],
]) {
    const r = await headOf(`${SITE}${from}`);
    const loc = (r?.location || '').replace(/^https?:\/\/[^/]+/, '');
    // Compare what the page READS: Vercel serves vercel.json's "+" as "%20",
    // and both decode to the same search term (measured 2026-09-28).
    const parse = (u) => { const x = new URL(u, SITE); return `${x.pathname}|${x.searchParams.get('search') ?? ''}`; };
    check(`${from} → ${want}`, r?.status === 308 && parse(loc) === parse(want), `${r?.status} ${loc}`);
}

// ── §N printer display names ────────────────────────────────────────────────
head('§N display_name = the backend prerender <h1> (sample per brand)');
{
    const SUFFIX = / (Ink|Toner|Ink &amp; Toner|Ink & Toner) NZ$/;
    const brandList = (await getJson(`${API}/api/brands`)).body?.data;
    const slugs = (Array.isArray(brandList) ? brandList : brandList?.brands || []).map((b) => b.slug);
    let n = 0;
    const offDisplay = [];
    for (const b of slugs) {
        const ps = (await getJson(`${API}/api/printers/by-brand/${b}?limit=2000`)).body?.data?.printers || [];
        const caps = ps.filter((p) => /\b[A-Z]{3,}\b|^Brother [A-Z]+ /.test(p.full_name));
        for (const p of caps.filter((_, i) => i % Math.max(1, Math.ceil(caps.length / 4)) === 0).slice(0, 4)) {
            const html = (await getJson(`${API}/api/prerender/printer/${b}/${p.slug}`)).body;
            const h1 = typeof html === 'string' ? (html.match(/<h1>([^<]*)/) || [])[1] : null;
            if (!h1) continue;
            n++;
            const theirs = h1.replace(SUFFIX, '').replace(/&amp;/g, '&');
            if (p.display_name !== theirs) offDisplay.push(`"${p.full_name}" → display_name "${p.display_name}" / page "${theirs}"`);
        }
    }
    check(`${n} printers: display_name (BF-093) = the page's name`, offDisplay.length === 0, offDisplay.slice(0, 6).join('; '));
}

// ── §A admin ────────────────────────────────────────────────────────────────
if (argv.has('--admin')) {
    head('§A admin: import-status reasons, image-audit brand');
    const env = fs.existsSync('.env') ? Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })) : {};
    const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
    const tok = email && password ? (await (await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    })).json()).access_token : null;
    if (!tok) bad('admin sign-in', 'ADMIN_EMAIL / ADMIN_PASSWORD missing or refused');
    else {
        const auth = { headers: { Authorization: `Bearer ${tok}` } };
        const st = (await getJson(`${API}/api/admin/supplier/import-status`, auth)).body?.data || {};
        const runs = ['genuine', 'compatible'].flatMap((f) => (st[f]?.recent_runs || []).map((r) => ({ f, ...r })));
        check('every run carries the error_message key', runs.length > 0 && runs.every((r) => 'error_message' in r), `${runs.length} runs`);
        const failed = runs.filter((r) => r.status === 'failed');
        if (!failed.length) skip('a failed run\'s reason', 'no failed run in the 5-run window');
        else check('every failed run says why', failed.every((r) => typeof r.error_message === 'string' && r.error_message.trim()),
            failed.map((r) => `${r.f} ${r.started_at.slice(0, 10)}: ${r.error_message}`).join('; '));
        const hp = ((await getJson(`${API}/api/brands`)).body?.data || []).find?.((b) => b.slug === 'hp');
        for (const [label, v, want] of [['slug', 'hp', 200], ['id', hp?.id, 200], ['garbage', 'zzprobe', 400]]) {
            const r = await getJson(`${API}/api/admin/image-audit/stats?brand=${encodeURIComponent(v)}`, auth);
            check(`image-audit brand=${label} → ${want}`, r.status === want && (want !== 400 || r.body?.error?.code === 'UNKNOWN_BRAND'), `HTTP ${r.status} ${r.body?.error?.code || ''}`);
        }
    }
}

// ── §Q the one pinned search ────────────────────────────────────────────────
if (argv.has('--search')) {
    head('§Q alias search (WRITES one search_analytics row)');
    const d = (await getJson(`${API}/api/search/smart?q=${encodeURIComponent('canon pg540')}&limit=20`)).body?.data || {};
    check('"canon pg540" → no own rows, alias_suggestion.note + alias_results', (d.products || []).length === 0
        && typeof d.alias_suggestion?.note === 'string' && (d.alias_results || []).length > 0,
        `${(d.alias_results || []).length} alias rows → "${d.alias_suggestion?.search_query}"`);
}

// ── §B browser ──────────────────────────────────────────────────────────────
if (argv.has('--browser')) {
    const { chromium } = await import('playwright');
    const ANALYTICS = /googletagmanager|google-analytics|bat\.bing|doubleclick|googleadservices|\/api\/analytics\//;
    const browser = await chromium.launch();
    const open = async (path, wait) => {
        await pause(6000);   // one page is ~15 API calls against a shared per-IP budget
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await ctx.route(ANALYTICS, (r) => r.abort());
        const page = await ctx.newPage();
        const reqs = [];
        page.on('request', (r) => reqs.push(r.url()));
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(wait, null, { timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        return { page, ctx, reqs };
    };
    head(`§B pages (${BASE})`);
    {
        const { page, ctx } = await open('/toner-cartridges', () => document.querySelectorAll('.drilldown-box__count').length
            && [...document.querySelectorAll('.drilldown-box__count')].some((e) => e.textContent));
        const tiles = await page.$$eval('.drilldown-box--brand', (els) => els.map((e) => ({ brand: e.dataset.brand, hidden: e.hidden, count: e.querySelector('.drilldown-box__count')?.textContent || '' })));
        const hp = tiles.find((t) => t.brand === 'hp');
        check('/toner-cartridges: HP shows its TONER count', /^430 products$|^\d+ products$/.test(hp?.count || '') && hp.count !== '870 products', hp?.count);
        const dymo = tiles.find((t) => t.brand === 'dymo');
        check('/toner-cartridges: Dymo tile hidden (no toner)', !dymo || dymo.hidden, dymo ? `hidden=${dymo.hidden}` : 'not offered');
        await ctx.close();
    }
    {
        const path = '/shop?brand=brother&printer_slug=brother-hl-l2375dw';
        const { page, ctx, reqs } = await open(path, () => /HL-L2375DW/.test(document.getElementById('drilldown-title')?.textContent || ''));
        const html = (await getJson(`${API}/api/prerender/printer/brother/brother-hl-l2375dw`)).body;
        const want = typeof html === 'string' ? (html.match(/<h1>([^<]*)/) || [])[1] : null;
        const h1 = await page.$eval('#drilldown-title', (e) => ({ text: e.textContent.trim(), visible: !e.hidden && !e.classList.contains('visually-hidden') }));
        check('printer hub: visible H1 = the prerender H1', h1.visible && h1.text === want, `"${h1.text}" vs "${want}"`);
        check('printer hub: no color-packs request', !reqs.some((u) => /color-packs/.test(u)));
        const heads = await page.$$eval('.products-section__title', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
        check('printer hub: no heading says its source word twice', heads.every((t) => !/(Compatible|Genuine).*\b(Compatible|Original)\b/.test(t)), heads.join(' | '));
        await ctx.close();
    }
    {
        const { ctx, reqs } = await open('/products/x/C65BK', () => document.documentElement.getAttribute('data-for-use-in'));
        const fui = reqs.filter((u) => /\/for-use-in/.test(u)).map((u) => new URL(u).pathname);
        check('redirected PDP (/products/x/C65BK): for-use-in asked ONCE, with the response SKU', fui.length === 1 && /C65XLBK/.test(fui[0]), fui.join(', ') || 'none');
        await ctx.close();
    }
    {
        const { ctx, reqs } = await open('/ribbon/72200.01', () => document.getElementById('product-title') && !document.querySelector('#product-title .skeleton'));
        const rest = reqs.filter((u) => /supabase\.co\/rest\/v1\//.test(u)).map((u) => decodeURIComponent(u));
        // Every retired read: the field enrich (products?sku=eq.), both code tables,
        // and since BF-092 (ERR-299) the curated rail's products?sku=in.(…) too.
        const retired = rest.filter((u) => /\/products\?|\/product_codes\b|\/product_code_visitors\b/.test(u));
        check('ribbon PDP: NO direct products / product_codes / visitor read (BF-084/085/092)', retired.length === 0, retired.map((u) => u.slice(0, 90)).join(', '));
        await ctx.close();
    }
    {
        const { page, ctx } = await open('/ribbon/307.11', () => document.querySelector('#ribbon-col-right .product-card'));
        const skus = await page.$$eval('#ribbon-col-right .product-card', (els) => els.map((e) => e.dataset.sku || e.querySelector('[data-sku]')?.dataset.sku || ''));
        check('ribbon PDP 307.11: related rail shows C141LOT, C143LOT (server-resolved)', skus.join(',') === 'C141LOT,C143LOT', skus.join(',') || 'no cards');
        await ctx.close();
    }
    {
        const { page, ctx } = await open('/ribbons', () => document.querySelector('.shop-section-card__title'));
        const titles = await page.$$eval('h1, h2', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
        check('/ribbons: "Typewriter & Printer Ribbons" once', titles.filter((t) => t === 'Typewriter & Printer Ribbons').length === 1, titles.slice(0, 4).join(' | '));
        await ctx.close();
    }
    await browser.close();
}

console.log(`\n  mode: READ-ONLY   passed: ${pass}   failed: ${fail}   soft: ${softs}   unmeasured: ${unmeasured}`
    + (unmeasured ? '  (UNMEASURED is not a pass)' : ''));
process.exit(fail ? 1 : 0);
