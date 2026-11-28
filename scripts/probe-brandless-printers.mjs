#!/usr/bin/env node
/**
 * probe-brandless-printers.mjs — ERR-403
 * ======================================
 * Measures the backend update of 27 Nov 2026 (backend-docs/inbox/backend-update-2026-11-27.md) and the
 * contract the FE relies on for it: /api/schema/collection?brand=<slug> answers 404 exactly for brands
 * with no brand page, and every brand the FE treats as "known" (an /api/brands row, or the local
 * brandInfo map in shop-page.js — ShopPage._brandPage skips the request for those) DOES have a page.
 *
 * MODE: READ-ONLY. GET only, paced 700 ms (shared backend limiter), roughly 70 requests.
 * Each line says PASS / FAIL / NOT MEASURED; any FAIL ⇒ exit 1. NOT MEASURED is never counted as a pass.
 *
 *   npm run probe:brandless-printers
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.inkcartridges.co.nz';
const WWW = 'https://www.inkcartridges.co.nz';
const PACE_MS = 700;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log(`probe:brandless-printers — MODE: READ-ONLY (GET only, paced ${PACE_MS} ms)  ${new Date().toISOString()}`);

const results = { pass: 0, fail: 0, unmeasured: 0 };
const check = (ok, m) => { results[ok ? 'pass' : 'fail']++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m}`); };
const unmeasured = (m) => { results.unmeasured++; console.log(`  NOT MEASURED  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url) {
    const wait = last + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'inkcartridges-fe-probe (read-only)' } });
}
const collectionStatus = async (slug) => (await get(`${API}/api/schema/collection?brand=${encodeURIComponent(slug)}`)).status;

// ── §1 sitemap: which printer brands have no brand page ─────────────────────
console.log('\n§1 sitemap-printers.xml — brands with no brand page');
const xml = await (await get(`${WWW}/sitemap-printers.xml`)).text();
const printers = [...xml.matchAll(/brand=([a-z0-9-]+)&amp;printer_slug=([a-z0-9-]+)/g)].map((m) => ({ brand: m[1], slug: m[2] }));
const sitemapBrands = [...new Set(printers.map((p) => p.brand))].sort();
check(printers.length > 0, `${printers.length} printer URLs, ${sitemapBrands.length} brands`);
const noPage = [];
for (const b of sitemapBrands) {
    const s = await collectionStatus(b);
    if (s === 404) noPage.push(b);
    else if (s !== 200) check(false, `${b}: /api/schema/collection ${s} (neither 200 nor 404)`);
}
const noPagePrinters = printers.filter((p) => noPage.includes(p.brand));
console.log(`  INFO  no brand page: ${noPage.join(', ') || '(none)'} — ${noPagePrinters.length} printer URLs`);
console.log('        (backend 2026-11-27: acroprint, axiohm, hypercom, optima, silver-reed, verifone, vertex — 26)');

// ── §2 the FE shortcut: every "known" brand has a page ──────────────────────
console.log('\n§2 brands ShopPage._brandPage answers "yes" for without asking');
const brandsBody = await (await get(`${API}/api/brands`)).json();
const rows = Array.isArray(brandsBody) ? brandsBody : (brandsBody.data?.brands || brandsBody.data || []);
const apiSlugs = rows.map((r) => r.slug || r.id).filter(Boolean);
const shopSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/shop-page.js'), 'utf8');
const infoBlock = shopSrc.slice(shopSrc.indexOf('brandInfo: {'), shopSrc.indexOf('\n        },', shopSrc.indexOf('brandInfo: {')));
const localSlugs = [...infoBlock.matchAll(/^ {12}'?([a-z0-9-]+)'?:\s*\{/gm)].map((m) => m[1]);
check(apiSlugs.length > 0 && localSlugs.length > 0, `/api/brands ${apiSlugs.length} slugs, local brandInfo ${localSlugs.length} slugs`);
for (const b of [...new Set([...apiSlugs, ...localSlugs])].sort()) {
    const s = await collectionStatus(b);
    if (s !== 200) check(false, `${b}: known to the FE but /api/schema/collection ${s} — its crumb would link a missing page`);
}
check(true, 'every known brand checked (a FAIL line above names any that broke the shortcut)');

// ── §3 controls ─────────────────────────────────────────────────────────────
console.log('\n§3 controls');
check(await collectionStatus('okin') === 200, 'okin (inactive brand row, active products) ⇒ 200');
check(await collectionStatus('zz-not-a-brand') === 404, 'zz-not-a-brand ⇒ 404 (negative control)');
check(await collectionStatus('Brother') === 200, 'Brother (mixed case) ⇒ 200');

// ── §4 /api/shop answers 200 for brands with no page (backend claim 2) ──────
console.log('\n§4 /api/shop?brand=<no-page brand> ⇒ 200 with empty counts');
for (const b of noPage) {
    const r = await get(`${API}/api/shop?brand=${encodeURIComponent(b)}`);
    const body = r.status === 200 ? await r.json() : null;
    check(r.status === 200 && body && Object.keys(body.data?.counts || {}).length === 0, `${b}: ${r.status}`);
}

// ── §5 the backend's own printer crumbs leave the brand out ─────────────────
console.log('\n§5 /api/schema/printer/<slug> breadcrumbs carry no brand crumb');
for (const p of noPagePrinters) {
    const r = await get(`${API}/api/schema/printer/${encodeURIComponent(p.slug)}`);
    if (r.status !== 200) { check(false, `${p.slug}: ${r.status}`); continue; }
    const items = (await r.json()).breadcrumbs?.itemListElement || [];
    const brandUrl = `${WWW}/shop?brand=${p.brand}`;
    check(items.length > 0 && !items.some((i) => i.item === brandUrl), `${p.slug}: ${items.map((i) => i.name).join(' › ')}`);
}

// ── claims with no sample URL in the note ───────────────────────────────────
console.log('\nbackend claims with no sample in the note');
unmeasured('claim 1 — crawler printer pages no longer list discontinued products (no discontinued SKU named)');
unmeasured('claim 3 — 352 retired printer URLs of no-page brands 301 to /shop (no retired URL named)');

// ── FE-2b (not live: branch seo-phase2-preview only) ────────────────────────
console.log('\nFE-2b on www (pending owner approval — informational, not counted)');
for (const p of ['/shop?brand=zz-not-a-brand', '/shop?brand=okin']) {
    const r = await fetch(`${WWW}${p}`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
    console.log(`  INFO  ${p} → ${r.status} x-robots-tag=${r.headers.get('x-robots-tag') || '-'} (FE-2b target: zz 404+noindex, okin 200)`);
    await sleep(PACE_MS);
}

console.log(`\n${results.pass} PASS, ${results.fail} FAIL, ${results.unmeasured} NOT MEASURED`);
process.exit(results.fail ? 1 : 0);
