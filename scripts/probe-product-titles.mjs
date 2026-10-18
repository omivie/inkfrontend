#!/usr/bin/env node
/**
 * probe-product-titles.mjs
 * ========================
 * What title each live product SHOWS, now that the backend composes it
 * (`display_name`, backend response 2026-10-17; ERR-359 supersedes the FE
 * composer of ERR-341).
 *
 * Status per row:
 *   COMPOSED     backend composed a title; the storefront shows it verbatim.
 *                A COMPOSED row whose shown title differs from display_name is
 *                a BUG and fails the run (exit 1).
 *   KEPT         display_name is the stored name (not composed); the storefront
 *                shows the legacy display. KEPT:RENAMED = the legacy pack
 *                grammar still rewrites it (the owner-pending packs).
 *   MISSING      no display_name at all — the backend contract says it is
 *                always present; counted loudly, fails the run.
 *
 * READ-ONLY. No credentials, no write verb, no fixture. Public catalogue only.
 * CSV goes to stdout, the summary to stderr:
 *     npm run probe:product-titles > product-titles.csv
 *
 * Columns: sku, source, product_type, pack_type, color, stored name,
 *          display_name, shown title, status
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
const out = [['sku', 'source', 'product_type', 'pack_type', 'color', 'stored_name', 'display_name', 'shown_title', 'status'].join(',')];
const counts = {};
const bad = [];
for (const p of rows) {
    const shown = ProductName.clean(p);
    let status;
    if (typeof p.display_name !== 'string' || !p.display_name.trim()) status = 'MISSING';
    else if (ProductName.composed(p)) status = shown === p.display_name ? 'COMPOSED' : 'COMPOSED:SHOWN_DIFFERS';
    else status = shown === p.name ? 'KEPT' : 'KEPT:RENAMED';
    if (status === 'MISSING' || status === 'COMPOSED:SHOWN_DIFFERS') bad.push(`${p.sku} ${status}`);
    counts[status] = (counts[status] || 0) + 1;
    out.push([p.sku, p.source, p.product_type, p.pack_type, p.color, p.name, p.display_name, shown, status].map(csv).join(','));
}
console.log(out.join('\n'));
console.error(`read ${rows.length}/${total ?? '?'} products`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.error(`  ${k}: ${v}`);
if (bad.length) {
    console.error(`FAIL: ${bad.length} row(s) break the display_name contract:\n  ${bad.slice(0, 40).join('\n  ')}`);
    process.exitCode = 1;
}
