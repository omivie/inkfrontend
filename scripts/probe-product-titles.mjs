#!/usr/bin/env node
/**
 * probe-product-titles.mjs
 * ========================
 * Old vs new product title for every live product (owner, 2026-10-15, ERR-341).
 *
 * The storefront now shows a descriptive Smart Ink style title built by
 * ProductName.clean. Rows it cannot build keep the old display name; this probe
 * counts them by reason (ProductName.composeMiss) so the fallback is never silent.
 * The owner reviews the CSV, and it is the spec for the backend rename.
 *
 * READ-ONLY. No credentials, no write verb, no fixture. Public catalogue only.
 * CSV goes to stdout, the summary to stderr:
 *     npm run probe:product-titles > product-titles.csv
 *
 * Columns: sku, source, product_type, pack_type, color, yield_tier, page_yield,
 *          stored name, shown title, status (COMPOSED or KEPT:<reason>)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const LIMIT = 200;
const here = path.dirname(fileURLToPath(import.meta.url));

console.error(`probe:product-titles — MODE: READ-ONLY (GET ${API}/api/products, no writes)`);

// Reuse the storefront's own rule, never a copy of it.
const stubWindow = {
    location: { hostname: 'localhost', protocol: 'http:', href: 'http://localhost/' },
    addEventListener: () => {},
    document: { addEventListener: () => {}, readyState: 'complete' },
};
const ctx = {
    window: stubWindow, document: stubWindow.document, console,
    navigator: { userAgent: 'node-probe' },
    setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.createContext(ctx);
vm.runInContext(
    `(function(){ ${fs.readFileSync(path.join(here, '..', 'inkcartridges', 'js', 'utils.js'), 'utf8')}\n window.ProductName = ProductName; })();`,
    ctx);
const { ProductName } = ctx.window;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let total = null;
for (let page = 1; ; page++) {
    const res = await fetch(`${API}/api/products?limit=${LIMIT}&page=${page}`);
    if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status} — list is INCOMPLETE, do not hand it to the owner`);
    const body = await res.json();
    rows.push(...(body.data?.products || []));
    total = body.meta?.total ?? total;
    if (!body.meta?.has_next) break;
    await sleep(300);   // paced: shared IP with the site's limiter
}
if (total != null && rows.length < total) {
    console.error(`WARNING: read ${rows.length} of ${total} products — list is PARTIAL`);
}

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const out = [['sku', 'source', 'product_type', 'pack_type', 'color', 'yield_tier', 'page_yield', 'stored_name', 'shown_title', 'status'].join(',')];
const counts = {};
for (const p of rows) {
    const miss = ProductName.composeMiss(p);
    const status = miss ? `KEPT:${miss}` : 'COMPOSED';
    counts[status] = (counts[status] || 0) + 1;
    out.push([p.sku, p.source, p.product_type, p.pack_type, p.color, p.yield_tier, p.page_yield, p.name, ProductName.clean(p), status].map(csv).join(','));
}
console.log(out.join('\n'));
console.error(`read ${rows.length}/${total ?? '?'} products`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.error(`  ${k}: ${v}`);
