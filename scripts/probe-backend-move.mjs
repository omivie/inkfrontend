#!/usr/bin/env node
/**
 * probe-backend-move.mjs — does every claim in the 2026-09-28 backend handoff hold,
 * and does the storefront actually load the way the frontend changes say it does?
 * =================================================================================
 *
 * backend-docs/inbox/fe-handoff-page-speed-and-backend-move-sep2026.md moved the API
 * from Render Oregon (ink-backend-zaeq) to Singapore (ink-backend-sg) and gave the
 * frontend fields and endpoints that replace direct Supabase reads. Each section
 * below measures one of those claims BEFORE the frontend relies on it, and prints
 * where it does not hold. tests/backend-move-sep2026.test.js pins the code side.
 *
 *   §H  every Vercel rewrite that goes to Render answers on ink-backend-sg (and,
 *       while it still runs, matches the old host byte for byte)
 *   §L  GET /api/site/lock answers what site_settings holds
 *   §N  /api/site/nav `ribbon_brands` = the direct ribbon_brands read, row for row
 *   §O  EVERY product_codes override row: GET /api/products/:sku carries the
 *       override as series_codes, and GET /api/shop?brand&category&code lists it
 *   §R  the ribbon gaps the handoff does not mention (BF-080, BF-081): /api/ribbons/:sku
 *       lacks description_html/related_product_skus, and a ribbon with NO override
 *       still gets derived series_codes (ERR-086 says it has none)
 *   §W  (--browser) a first-time visitor's real load, against --site (default live):
 *       PDP, brand page and a zzprobe_-prefixed digit search (writes one excluded
 *       search_analytics row per search endpoint — the notice is printed)
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * Every request is a GET. No --record, no baseline, no fixture, and the mode is
 * printed on every run. §W's search uses a `zzprobe` query, the prefix the backend
 * excludes from search analytics (ERR-254/271); every other analytics or ads
 * beacon is aborted inside the browser before it leaves. ctx.route() bypasses
 * CORS (memory: feedback_playwright_route_bypasses_cors), so NOTHING here makes a
 * transport/CORS claim — §W measures which requests happen and in what order.
 *
 * Paced at 800 ms: the API rate-limits 100 requests / 60 s per IP, SHARED across
 * endpoints and across every session on this machine (ERR-266). A 429 is reported
 * as "could not look", never as a finding.
 *
 * Usage:  npm run probe:backend-move
 *         npm run probe:backend-move -- --browser [--site=http://localhost:3000]
 *         npm run probe:backend-move -- --browser-only --site=http://localhost:3000   (§W alone)
 * Exit:   0 all checks passed · 1 a real finding · 2 the probe could not run
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { SEARCH_ANALYTICS_NOTICE, probeQuery } from './lib/probe-search-notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const BROWSER_ONLY = ARGS.includes('--browser-only');
const BROWSER = BROWSER_ONLY || ARGS.includes('--browser');
const SITE = (ARGS.find((a) => a.startsWith('--site=')) || '--site=https://www.inkcartridges.co.nz').slice(7);
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const NEW = 'https://ink-backend-sg.onrender.com';
const OLD = 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8')
    .match(/SUPABASE_ANON_KEY: '([^']+)'/)[1];
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('probe:backend-move — READ-ONLY (GET only; no record mode exists)');
if (BROWSER) console.log(SEARCH_ANALYTICS_NOTICE);
console.log(`  API ${API} · site ${SITE}${BROWSER ? ' · browser ON' : ''}\n`);

let pass = 0;
const failures = [];
const notes = [];
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (c, n, d) => (c ? ok(n) : bad(n, d));

class CouldNotLook extends Error {}
async function get(url, { json = true, headers = {} } = {}) {
    // A 429 is the shared per-IP budget (other sessions count against it too):
    // wait out the 60 s window and ask again, up to 3 times, then give up LOUDLY.
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers, redirect: 'manual' });
        const body = json ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
        if (DELAY_MS) await sleep(DELAY_MS);
        if (res.status !== 429) return { status: res.status, body };
        if (attempt === 3) throw new CouldNotLook(`429 RATE_LIMITED on ${url} after 3 waits`);
        console.log(`  ·  429 on ${url.replace(/^https:\/\/[^/]+/, '')} — waiting 61 s (attempt ${attempt + 1}/3)`);
        await sleep(61000);
    }
}
const rest = (q) => get(`${SUPABASE}/rest/v1/${q}`, { headers: { apikey: ANON } });
const norm = (codes) => [...new Set((codes || []).map((c) => String(c).trim().toUpperCase()))].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The storefront's own type → category map, read from the shipped source.
const API_SRC = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/api.js'), 'utf8');
const CAT_TYPES = vm.runInNewContext(`(${API_SRC.match(/_CATEGORY_PRODUCT_TYPES: (\{[\s\S]*?\n    \}),/)[1]})`);
const categoryOf = (type) => Object.keys(CAT_TYPES).find((c) => CAT_TYPES[c].includes(type)) || null;

try {
    if (!BROWSER_ONLY) {
    // ── §H ─────────────────────────────────────────────────────────────────
    console.log('§H Render-bound rewrites answer on the Singapore host');
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'inkcartridges/vercel.json'), 'utf8'));
    const SAMPLE = { ':sku': 'C02BK', ':path': 'products' };
    // A rewrite with `has: query` only fires with that query, so ask with it.
    const dests = vercel.rewrites.filter((r) => /onrender\.com/.test(r.destination)).map((r) => {
        const q = (r.has || []).filter((h) => h.type === 'query').map((h) => `${h.key}=canon-pixma-mg3660`).join('&');
        return r.destination.replace(/:sku|:path/g, (k) => SAMPLE[k]) + (q ? `?${q}` : '');
    });
    let oldAlive = false;
    try { oldAlive = (await get(`${OLD}/health`, { json: false })).status === 200; } catch (e) { if (e instanceof CouldNotLook) throw e; }
    for (const d of dests) {
        check(d.startsWith(NEW + '/'), `rewrite names the new host: ${d.replace(NEW, '')}`, d);
        const now = await get(d, { json: false });
        check(now.status < 400, `${d.replace(NEW, '')} answers on ink-backend-sg`, `HTTP ${now.status}`);
        if (!oldAlive) continue;
        const was = await get(d.replace(NEW, OLD), { json: false });
        // Feeds stamp their generation time (google-promotions: effective dates
        // start "now"), so compare with ISO timestamps masked — and say so.
        const mask = (b) => b.toString('utf8').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<ts>');
        const exact = Buffer.compare(was.body, now.body) === 0;
        check(was.status === now.status && (exact || mask(was.body) === mask(now.body)),
            `${d.replace(NEW, '')} identical on both hosts${exact ? '' : ' (modulo generation timestamps)'}`,
            `old ${was.status}/${was.body.length}B · new ${now.status}/${now.body.length}B`);
    }
    if (!oldAlive) soft('old host', 'ink-backend-zaeq /health does not answer — parity checks skipped (expected after switch-off)');

    // ── §L ─────────────────────────────────────────────────────────────────
    console.log('\n§L site lock');
    const lock = await get(`${API}/api/site/lock`);
    const row = await rest('site_settings?select=value&key=eq.site_locked');
    const direct = row.body && row.body[0] ? row.body[0].value : null;
    check(lock.body && lock.body.ok === true && lock.body.data && typeof lock.body.data.enabled === 'boolean',
        '/api/site/lock answers { enabled, message }', JSON.stringify(lock.body));
    if (direct) {
        check(!!lock.body.data.enabled === !!direct.enabled && (lock.body.data.message || null) === (direct.message || null),
            '/api/site/lock = site_settings.site_locked (may lag ≤ 60 s behind a change)',
            `api ${JSON.stringify(lock.body.data)} · db ${JSON.stringify(direct)}`);
    } else {
        soft('site_settings.site_locked', `direct read returned ${row.status}; the API is the only source now`);
    }

    // ── §N ─────────────────────────────────────────────────────────────────
    console.log('\n§N ribbon brands');
    const nav = await get(`${API}/api/site/nav`);
    const viaNav = nav.body && nav.body.data ? nav.body.data.ribbon_brands : undefined;
    const viaDb = (await rest('ribbon_brands?is_active=eq.true&order=sort_order.asc&select=id,name,slug,image_url,sort_order')).body;
    check(Array.isArray(viaNav), '/api/site/nav carries ribbon_brands', `got ${JSON.stringify(viaNav)}`);
    if (Array.isArray(viaNav) && Array.isArray(viaDb)) {
        const key = (r) => [r.id, r.name, r.slug, r.image_url, r.sort_order].join('|');
        check(same(viaNav.map(key), viaDb.map(key)), `ribbon_brands identical to the direct read (${viaNav.length} rows, same order)`,
            `nav ${viaNav.length} · db ${viaDb.length}`);
    }

    // ── §O ─────────────────────────────────────────────────────────────────
    console.log('\n§O every product_codes override row');
    const rows = (await rest('product_codes?select=product_id,code,chip_category')).body || [];
    const byProduct = new Map();
    for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) || []), r]);
    const visitors = rows.filter((r) => r.chip_category);
    console.log(`  ·  ${rows.length} rows over ${byProduct.size} products; ${visitors.length} carry chip_category (cross-type visitors)`);
    const ids = [...byProduct.keys()];
    const prods = ids.length
        ? (await rest(`products?select=id,sku,product_type,is_active&id=in.(${ids.join(',')})`)).body || []
        : [];
    let held = 0; let checked = 0;
    for (const p of prods) {
        if (!p.is_active) { console.log(`  ·  ${p.sku}: inactive, skipped`); continue; }
        checked++;
        const want = norm(byProduct.get(p.id).map((r) => r.code));
        const detail = await get(`${API}/api/products/${encodeURIComponent(p.sku)}`);
        const got = norm(detail.body && detail.body.data && detail.body.data.series_codes);
        const detailOk = same(got, want);
        const cat = categoryOf(p.product_type);
        const brand = detail.body && detail.body.data && detail.body.data.brand && detail.body.data.brand.slug;
        const missingUnder = [];
        for (const code of want) {
            const shop = await get(`${API}/api/shop?brand=${encodeURIComponent(brand)}&category=${cat}&code=${encodeURIComponent(code)}&limit=200`);
            const skus = ((shop.body && shop.body.data && shop.body.data.products) || []).map((x) => x.sku);
            if (!skus.includes(p.sku)) missingUnder.push(code);
        }
        if (detailOk && !missingUnder.length) { held++; continue; }
        bad(`${p.sku} (${p.product_type})`, [
            detailOk ? null : `/api/products series_codes ${JSON.stringify(got)} ≠ override ${JSON.stringify(want)}`,
            missingUnder.length ? `/api/shop?brand=${brand}&category=${cat} does not list it under ${missingUnder.join(', ')}` : null,
        ].filter(Boolean).join(' · '));
    }
    check(held === checked, `override rows honoured by the backend: ${held}/${checked} active products`,
        `${checked - held} product(s) above — the storefront must not drop its own override read for these`);
    if (visitors.length) soft('cross-type visitors', `${visitors.length} row(s) with chip_category — the handoff does not cover these; api.js keeps its visitor recovery`);

    // ── §R ─────────────────────────────────────────────────────────────────
    console.log('\n§R ribbons (not covered by the handoff — BF-080, BF-081)');
    const ribbonList = await get(`${API}/api/ribbons?limit=20`);
    const ribbons = ((ribbonList.body && (ribbonList.body.data?.ribbons || ribbonList.body.data?.products || ribbonList.body.data)) || [])
        .filter((r) => r && r.sku).slice(0, 8);
    const overridden = new Set(prods.map((p) => p.sku));
    let derived = 0; let missingFields = 0;
    for (const r of ribbons) {
        const rib = await get(`${API}/api/ribbons/${encodeURIComponent(r.sku)}`);
        const d = (rib.body && rib.body.data) || {};
        if (!('description_html' in d) || !('related_product_skus' in d)) missingFields++;
        if (overridden.has(r.sku)) continue;
        const prod = await get(`${API}/api/products/${encodeURIComponent(r.sku)}`);
        const codes = (prod.body && prod.body.data && prod.body.data.series_codes) || [];
        if (codes.length) derived++;
    }
    soft('GET /api/ribbons/:sku', `${missingFields}/${ribbons.length} sampled ribbons lack description_html/related_product_skus — the ribbon PDP keeps its Supabase enrich`);
    soft('ribbon series_codes', `${derived} sampled ribbon(s) with NO override still get derived series_codes — ERR-086 says none; the storefront keeps the ribbon override read`);

    } // !BROWSER_ONLY

    // ── §W ─────────────────────────────────────────────────────────────────
    if (BROWSER) {
        console.log(`\n§W first-time visitor, real browser (390×664) — ${SITE}`);
        const { chromium } = await import('playwright');
        const browser = await chromium.launch();
        const WRITES = /\/api\/analytics\/|\/api\/cart-analytics|google-analytics\.com|googletagmanager\.com\/g\/collect|doubleclick\.net|googleadservices\.com|bat\.bing\.com|\/pagead\//;
        const load = async (urlPath) => {
            const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true,
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
            await ctx.route(WRITES, (r) => r.abort());
            const page = await ctx.newPage();
            const reqs = [];
            const t0 = Date.now();
            page.on('request', (q) => reqs.push({ url: q.url(), start: Date.now() - t0, end: null, q }));
            page.on('requestfinished', (q) => { const r = reqs.find((x) => x.q === q); if (r) r.end = Date.now() - t0; });
            let dcl = null;
            page.on('domcontentloaded', () => { dcl = Date.now() - t0; });
            await page.goto(SITE + urlPath, { waitUntil: 'load', timeout: 60000 });
            await page.waitForTimeout(7000);
            // LCP as the browser reports it (buffered), for comparison with the
            // handoff's single-sample numbers. A measurement, not a check: one
            // load, from wherever this runs.
            const lcp = await page.evaluate(() => new Promise((res) => {
                let last = null;
                try {
                    new PerformanceObserver((l) => { const e = l.getEntries(); last = e[e.length - 1]; })
                        .observe({ type: 'largest-contentful-paint', buffered: true });
                } catch (_) { /* unsupported */ }
                setTimeout(() => res(last ? Math.round(last.startTime) : null), 100);
            }));
            console.log(`  ·  ${urlPath}: LCP ${lcp == null ? 'n/a' : lcp + ' ms'} (one load)`);
            const out = { reqs, dcl, page, ctx };
            return out;
        };
        const find = (reqs, rx) => reqs.filter((r) => rx.test(r.url));
        try {
            // PDP
            const pdp = await load('/products/x/C02BK');
            const prod = find(pdp.reqs, /\/api\/products\/C02BK(\?|$)/)[0];
            const heroes = find(pdp.reqs, /\/api\/images\/optimize\?url=[^&]*C02BK|\/api\/images\/optimize/)
                .filter((r) => r.start >= (prod ? prod.start : 0));
            check(!find(pdp.reqs, /supabase\.co\/rest\/v1\/(products|product_codes)\b/).length,
                'PDP: no direct Supabase products/product_codes read', find(pdp.reqs, /supabase\.co\/rest/).map((r) => r.url.slice(0, 110)).join(' | '));
            // Say what is LEFT, not only what is gone: the visitor summary
            // (product_code_visitors) stays until BF-082.
            const leftover = find(pdp.reqs, /supabase\.co\/rest\/v1\//).map((r) => r.url.replace(/^.*\/rest\/v1\//, '').split('?')[0]);
            soft('PDP: direct Supabase reads still made', leftover.length ? `${leftover.length}: ${[...new Set(leftover)].join(', ')}` : 'none');
            const preload = await pdp.page.$('link[rel="preload"][data-lcp-product="pdp-hero"]');
            check(!!preload, 'PDP: hero preload injected by pdp-prefetch', 'no link[data-lcp-product=pdp-hero]');
            const heroSrc = await pdp.page.$eval('#product-image img', (i) => i.currentSrc).catch(() => null);
            const heroHits = heroSrc ? pdp.reqs.filter((r) => r.url === heroSrc).length : 0;
            check(heroHits === 1, 'PDP: the hero image is downloaded exactly once (preload URL = <img> URL)', `${heroHits} request(s) for ${heroSrc}`);
            if (prod && heroes.length) {
                const first = Math.min(...heroes.map((r) => r.start));
                console.log(`  ·  PDP: product ${prod.start}→${prod.end} ms · first optimised image starts ${first} ms (Δ ${first - prod.end} ms after the product)`);
                check(first - prod.end < 400, 'PDP: the first image starts within 400 ms of the product response', `Δ ${first - prod.end} ms`);
            }
            const fiu = find(pdp.reqs, /for-use-in/)[0];
            if (fiu && heroes.length) console.log(`  ·  PDP: for-use-in ends ${fiu.end} ms — the gallery no longer waits for it`);
            for (const [label, run] of [['PDP', pdp]]) {
                check(!find(run.reqs, /\/api\/cart(\?|$)/).length, `${label}: no GET /api/cart for a first-time visitor`, 'requested');
                check(!find(run.reqs, /site_settings|ribbon_brands/).length, `${label}: no site_settings / ribbon_brands Supabase read`, 'requested');
                const plat = find(run.reqs, /apis\.google\.com\/js\/platform\.js/)[0];
                check(!plat || plat.start > run.dcl, `${label}: platform.js starts after DOMContentLoaded`, plat ? `${plat.start} ms vs DCL ${run.dcl} ms` : '');
                console.log(`  ·  ${label}: platform.js ${plat ? `started ${plat.start} ms (DCL ${run.dcl} ms)` : 'not loaded in the window (idle never came / no interaction)'}`);
            }
            await pdp.ctx.close();

            // Brand page
            const brand = await load('/shop?brand=brother');
            check(!find(brand.reqs, /\/api\/ribbons\?/).length, 'brand page: no /api/ribbons count call (it fed a tile that never renders)', 'requested');
            const shopReq = find(brand.reqs, /\/api\/shop\?brand=brother(&|$)/)[0];
            const schema = find(brand.reqs, /\/api\/schema\/collection/)[0];
            if (shopReq && schema) {
                console.log(`  ·  brand: /api/shop ${shopReq.start}→${shopReq.end} ms · schema starts ${schema.start} ms`);
                check(schema.start <= shopReq.end, 'brand page: schema starts without waiting for the level to load', `schema ${schema.start} ms > shop end ${shopReq.end} ms`);
            } else {
                bad('brand page: /api/shop and /api/schema/collection both requested', `shop ${!!shopReq} · schema ${!!schema}`);
            }
            check(!find(brand.reqs, /\/api\/cart(\?|$)/).length, 'brand page: no GET /api/cart for a first-time visitor', 'requested');
            check(!find(brand.reqs, /supabase\.co\/rest\/v1\/ribbon_brands/).length, 'brand page: mega-nav ribbons come from /api/site/nav', 'direct read seen');
            await brand.ctx.close();

            // Digit search (zzprobe_-prefixed ⇒ excluded from search analytics)
            const term = probeQuery('2450');
            const s = await load(`/search?q=${encodeURIComponent(term)}`);
            const smart = find(s.reqs, /\/api\/search\/smart\?/)[0];
            const lit = find(s.reqs, new RegExp(`/api/products\\?[^#]*search=${term}`))[0];
            const sug = find(s.reqs, /\/api\/search\/suggest\?/)[0];
            if (smart && lit && sug) {
                console.log(`  ·  search: smart ${smart.start}→${smart.end} · products ${lit.start} · suggest ${sug.start} ms`);
                check(lit.start < smart.end && sug.start < smart.end, 'digit search: the literal set starts alongside /search/smart',
                    `products ${lit.start} / suggest ${sug.start} vs smart end ${smart.end}`);
            } else {
                bad('digit search: smart + products + suggest all requested', `smart ${!!smart} · products ${!!lit} · suggest ${!!sug}`);
            }
            await s.ctx.close();
        } finally {
            await browser.close();
        }
    }
} catch (err) {
    console.error(`\n\x1b[31mprobe could not run:\x1b[0m ${err.message}`);
    process.exit(2);
}

console.log(`\n${pass}/${pass + failures.length} checks passed${notes.length ? `, ${notes.length} measured note(s)` : ''}.`);
if (failures.length) { console.log('\nFINDINGS:'); failures.forEach((f) => console.log(`  - ${f}`)); }
process.exit(failures.length ? 1 : 0);
