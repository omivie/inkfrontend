#!/usr/bin/env node
/**
 * probe-guides.mjs
 * ================
 * Do the /guides pages (checklist item 41) still point at things that exist?
 *
 * The guides are hand-authored static HTML (backend plan Appendix A §6: "any
 * later copy change is made by hand"), but what they link to is live data:
 * product slugs are renamed (826 packs on 2026-10-15), SKUs retire, printer
 * rows lose their products. Nothing in a unit test can see that, so this
 * measures it. For every guide page it checks:
 *   - each /products/<slug>/<SKU> link: the SKU is live AND its current slug
 *     is the one linked (a stale slug costs a redirect hop, or a 404);
 *   - each /shop?brand=…&printer_slug=… link: the printer lists products;
 *   - each external maker-support link answers 2xx/3xx.
 *
 * MODE: READ-ONLY. GET requests only, paced; no search endpoint is called, so
 * nothing lands in search_analytics (ERR-254). No credentials, no files written.
 *
 *   npm run probe:guides            (exit 1 on any finding, 2 if it could not look)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'inkcartridges');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const PACE = Number(process.env.PROBE_PACE_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`probe:guides — MODE: READ-ONLY (GET only, ${PACE}ms pace, no search endpoints) against ${API}`);

const pages = [path.join(SITE, 'html', 'guides.html'),
    ...fs.readdirSync(path.join(SITE, 'html', 'guides')).filter((f) => f.endsWith('.html')).map((f) => path.join(SITE, 'html', 'guides', f))];
if (pages.length < 10) { console.log(`only ${pages.length} guide pages found — could not look`); process.exit(2); }

const products = new Map(); // SKU -> {slug, pages}
const printerLinks = new Map(); // slug -> pages
const external = new Map(); // url -> pages
for (const f of pages) {
    const html = fs.readFileSync(f, 'utf8');
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const name = path.relative(SITE, f);
    for (const m of main.matchAll(/href="\/products\/([^/"]+)\/([^/"]+)"/g)) {
        const e = products.get(m[2]) || { slug: m[1], pages: new Set() };
        if (e.slug !== m[1]) console.log(`  NOTE  ${m[2]} linked under two slugs`);
        e.pages.add(name); products.set(m[2], e);
    }
    for (const m of main.matchAll(/href="\/shop\?brand=([^&"]+)&amp;printer_slug=([^"&]+)"/g)) {
        (printerLinks.get(m[2]) || printerLinks.set(m[2], new Set()).get(m[2])).add(name);
    }
    for (const m of main.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
        const u = m[1].replace(/&amp;/g, '&');
        (external.get(u) || external.set(u, new Set()).get(u)).add(name);
    }
}
console.log(`  ${pages.length} pages · ${products.size} products · ${printerLinks.size} printers · ${external.size} external links`);

let findings = 0; let unreachable = 0;
const bad = (m) => { findings++; console.log(`  FAIL  ${m}`); };

async function get(url, init = {}) {
    await sleep(PACE);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url, { redirect: 'manual', ...init });
            if (res.status === 429) { await sleep(20000); continue; }
            let body = null;
            try { body = await res.json(); } catch (_) { /* not JSON */ }
            return { status: res.status, body };
        } catch (e) { if (attempt === 2) return null; await sleep(3000); }
    }
    return null;
}

console.log('\n§1 product links');
for (const [sku, { slug, pages: ps }] of products) {
    const r = await get(`${API}/api/products/${encodeURIComponent(sku)}`);
    if (!r) { unreachable++; console.log(`  ????  ${sku} unreachable`); continue; }
    const d = r.body && r.body.data;
    if (r.status !== 200 || !d) bad(`${sku} → ${r.status} (on ${[...ps].join(', ')})`);
    else if (d.is_active === false) bad(`${sku} is inactive (on ${[...ps].join(', ')})`);
    else if (d.slug !== slug) bad(`${sku} slug moved: linked ${slug}, now ${d.slug} (on ${[...ps].join(', ')})`);
}

console.log('\n§2 printer links');
for (const [slug, ps] of printerLinks) {
    const r = await get(`${API}/api/products/printer/${encodeURIComponent(slug)}`);
    if (!r) { unreachable++; console.log(`  ????  ${slug} unreachable`); continue; }
    const d = r.body && r.body.data;
    const rows = Array.isArray(d) ? d : (d && (d.compatible_products || d.products)) || [];
    if (r.status !== 200 || rows.length === 0) bad(`printer ${slug} → ${r.status}, ${rows.length} products (on ${[...ps].join(', ')})`);
}

console.log('\n§3 maker support links');
for (const [url, ps] of external) {
    const r = await get(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; inkcartridges-guides-linkcheck)' } });
    if (!r) { unreachable++; console.log(`  ????  ${url} unreachable`); continue; }
    if (r.status >= 400) bad(`${url} → ${r.status} (on ${[...ps].join(', ')})`);
}

console.log(`\n# ${findings} finding(s), ${unreachable} unreachable`);
if (findings) process.exit(1);
if (unreachable) { console.log('could not look at everything — NOT a pass'); process.exit(2); }
console.log('every guide link resolves');
