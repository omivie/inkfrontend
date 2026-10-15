#!/usr/bin/env node
/**
 * probe-pack-names.mjs
 * ====================
 * Draft the pack rename list for owner sign-off (owner, 2026-10-15).
 *
 * Customers read "4-Pack" as four of the same cartridge. The new grammar:
 * 4-colour packs end "KCMY-Pack", 3-colour packs "CMY-Pack", and every other
 * multi-item pack names its contents. Stored names are backend data, so the
 * frontend only rewrites them on display (ProductName.clean). This probe lists
 * every pack in the live catalogue with its stored name and the name the
 * storefront now shows, so the owner can approve the backend rename.
 *
 * READ-ONLY. No credentials, no write verb, no fixture. Public catalogue only.
 * CSV goes to stdout, the summary to stderr:
 *     npm run probe:pack-names > pack-names.csv
 *
 * Columns: sku, pack_type, color, stored name, proposed name, status
 *   status = RENAMED      the display rule rewrote it (CMY / KCMY packs)
 *          = NEEDS OWNER  a pack the display cannot name (2-Pack, 5-Pack,
 *                         Black/Colour, Value Pack colour) — the owner writes
 *                         its contents-based name; never guessed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const LIMIT = 200;
const here = path.dirname(fileURLToPath(import.meta.url));

console.error(`probe:pack-names — MODE: READ-ONLY (GET ${API}/api/products, no writes)`);

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

const PACK_NAME_RE = /\b\d+\s*-?\s*pack\b|\bvalue\s+pack\b|\bmultipack\b|\b(?:K?CMY|CMYK|BCMY)-Pack\b/i;
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
const out = [['sku', 'pack_type', 'color', 'stored_name', 'proposed_name', 'status'].join(',')];
const counts = { RENAMED: 0, 'NEEDS OWNER': 0 };
for (const p of rows) {
    const isPack = (p.pack_type && p.pack_type !== 'single') || PACK_NAME_RE.test(p.name || '');
    if (!isPack) continue;
    const shown = ProductName.clean(p);
    const renamed = /\b(?:KCMY|CMY)-Pack\b/.test(shown) && !/\b\d+\s*-?\s*pack\b/i.test(shown);
    const status = renamed ? 'RENAMED' : 'NEEDS OWNER';
    counts[status]++;
    out.push([p.sku, p.pack_type, p.color, p.name, renamed ? shown : '', status].map(csv).join(','));
}
console.log(out.join('\n'));
console.error(`read ${rows.length}/${total ?? '?'} products; packs: ${counts.RENAMED} RENAMED, ${counts['NEEDS OWNER']} NEEDS OWNER`);
