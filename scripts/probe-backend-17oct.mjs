#!/usr/bin/env node
/**
 * probe-backend-17oct.mjs
 * =======================
 * Re-measures every claim of the backend's 17 Oct 2026 response that the
 * frontend now relies on (ERR-359..365). Each line says PASS / FAIL / SKIP; a
 * SKIP is not a pass, and any FAIL or SKIP makes the exit code non-zero.
 *
 * MODE: READ-ONLY. GETs, plus two server-side PREVIEWS that write nothing:
 *   - POST /api/admin/pricing/bulk  with dry_run:true (no confirm)
 *   - POST /api/admin/pricing/rules WITHOUT confirm (preview)
 * It never applies a price, never saves a rule, never applies points, never
 * places an order. Admin + cart checks need ADMIN_EMAIL / ADMIN_PASSWORD (env
 * or .env); without them those checks are SKIPPED and the run is not green.
 *
 *   npm run probe:backend-17oct
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const RENDER = process.env.RENDER_BASE || 'https://ink-backend-sg.onrender.com';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 400);

console.log(`probe:backend-17oct — MODE: READ-ONLY (GET + two server-side previews that write nothing) against ${API}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, skip: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS  ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL  ${m}`); };
const skip = (m) => { results.skip++; console.log(`  SKIP  ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));

async function get(url, headers = {}, opts = {}) {
    await sleep(PACE);
    const res = await fetch(url, { headers, ...opts });
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    return { status: res.status, body, headers: res.headers };
}
async function post(url, data, headers = {}) {
    await sleep(PACE);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    return { status: res.status, body };
}
function readEnv() {
    const out = {};
    try {
        for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
            if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
    } catch (_) { /* no .env */ }
    return out;
}

// ── Titles (ERR-359) ─────────────────────────────────────────────────────────
console.log('\n§1 display_name');
{
    const r = await get(`${API}/api/products/CLC3313KCMY`);
    const p = r.body && r.body.data;
    check(p && p.display_name === 'Brother LC3313 Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y',
        `PDP CLC3313KCMY display_name = composed title (got ${JSON.stringify(p && p.display_name)})`);
    const s = await get(`${API}/api/shop?brand=brother&category=toner&limit=50`);
    const rows = (s.body && s.body.data && s.body.data.products) || [];
    check(rows.length > 0 && rows.every((x) => typeof x.display_name === 'string' && x.display_name), `/api/shop rows all carry display_name (${rows.length} rows)`);
    const u = await get(`${API}/api/products/G74C0ZV0`);
    const up = u.body && u.body.data;
    // Measured 2026-10-18: an UNcomposed row's PDP display_name drops "<Brand> Genuine".
    // ProductName.composed() treats that suffix as "not composed" — this line says whether it still happens.
    console.log(`  INFO  uncomposed PDP display_name: ${JSON.stringify(up && up.display_name)} (stored: ${JSON.stringify(up && up.name)})`);
}

// ── Pack contents (ERR-360) ──────────────────────────────────────────────────
console.log('\n§2 constituents');
{
    const a = await get(`${API}/api/products/GLC432XLKCMY/constituents`);
    const d = a.body && a.body.data;
    check(d && d.contents_known === true && Array.isArray(d.constituents) && d.constituents.length === 4
        && d.constituents.every((c) => Number.isInteger(c.quantity)), 'GLC432XLKCMY: 4 rows, integer quantity, contents_known true');
    check(d && d.constituents.some((c) => c.page_yield === 3000), 'GLC432XLBK page_yield = 3000 (integer)');
    const t = await get(`${API}/api/products/G45BK-2PK/constituents`);
    const td = t.body && t.body.data;
    check(td && td.constituents && td.constituents.length === 1 && td.constituents[0].quantity === 2, 'G45BK-2PK: one row, quantity 2');
    const g = await get(`${API}/api/products/GPG645VPVP/constituents`);
    const gd = g.body && g.body.data;
    check(gd && gd.contents_known === false && gd.is_complete === true, 'GPG645VPVP: contents_known false, still buyable');
}

// ── Printer slugs + retired printers (ERR-361) ──────────────────────────────
console.log('\n§3 printers');
{
    const s = await get(`${API}/api/shop?brand=brother&category=toner&code=TN1070&limit=50`);
    const rows = (s.body && s.body.data && s.body.data.products) || [];
    const c = rows.find((x) => x.sku === 'CTN1070BK') || rows[0];
    check(c && Array.isArray(c.compatible_printer_slugs) && c.compatible_printer_slugs.length > 2,
        `TN1070 row carries the full compatible_printer_slugs (${c && c.compatible_printer_slugs && c.compatible_printer_slugs.length} slugs)`);
    const red = await get(`${API}/api/products/printer/brother-dpc-1510`, {}, { redirect: 'manual' });
    check(red.status === 301, `retired brother-dpc-1510 ⇒ 301 (got ${red.status})`);
    const fol = await get(`${API}/api/products/printer/brother-dpc-1510`);
    check(fol.body && fol.body.data && fol.body.data.printer && fol.body.data.printer.slug === 'brother-dcp-1510', 'followed body names printer.slug = brother-dcp-1510');
}

// ── Old pack slugs (ERR-365) ────────────────────────────────────────────────
console.log('\n§4 slug hops (what middleware.js slugHop() relies on)');
{
    const OLD = '/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-4-pack/CLC3313KCMY';
    const NEW = '/products/lc3313kcmy-compatible-ink-cartridge-for-brother-lc3313-kcmy-pack/CLC3313KCMY';
    const o = await get(`${RENDER}${OLD}`, { Accept: 'text/html' }, { redirect: 'manual' });
    check(o.status === 301 && (o.headers.get('location') || '').endsWith(NEW), `old slug ⇒ 301 to the new address (${o.status} ${o.headers.get('location')})`);
    const n = await get(`${RENDER}${NEW}`, { Accept: 'text/html' }, { redirect: 'manual' });
    const loc = n.headers.get('location') || '';
    // The backend says "passes through when none does"; measured 2026-10-18 it 301s to a search page.
    // middleware ignores any redirect that is not /products/<other slug>/<same SKU>, so both answers are safe.
    if (n.status >= 300 && n.status < 400 && !/\/products\/[^/]+\/CLC3313KCMY$/.test(new URL(loc, RENDER).pathname)) {
        console.log(`  INFO  current slug ⇒ ${n.status} ${loc} (NOT a pass-through; guarded in slugHop, reported in outbox 10-18 §2)`);
    } else {
        console.log(`  INFO  current slug ⇒ ${n.status} ${loc || '(no redirect)'}`);
    }
}

// ── Admin + cart (ERR-362/363/364) — need a login ──────────────────────────
console.log('\n§5 admin pricing + net sort + cart loyalty');
const env = readEnv();
const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
if (!email || !password) {
    skip('no ADMIN_EMAIL / ADMIN_PASSWORD — admin pricing, net sort and cart loyalty NOT measured');
} else {
    const cfg = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8');
    const anon = (cfg.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/) || [])[1];
    const tok = await post(`${SUPABASE}/auth/v1/token?grant_type=password`, { email, password }, { apikey: anon });
    const T = tok.body && tok.body.access_token;
    if (!T) {
        skip(`login refused (${tok.status}) — admin checks NOT measured`);
    } else {
        const H = { Authorization: `Bearer ${T}` };
        const list = await get(`${API}/api/admin/products?limit=5&sort=net_margin_incl_fixed_pct&order=asc`, H);
        const rows = (list.body && list.body.data && list.body.data.products) || [];
        check(list.body && list.body.ok && rows.length > 0, 'sort=net_margin_incl_fixed_pct accepted');
        const nums = rows.map((r) => r.net_margin_incl_fixed_pct).filter((v) => v != null);
        check(nums.every((v, i) => i === 0 || nums[i - 1] <= v), `rows ascend by net margin (${nums.join(', ')})`);
        check(rows.every((r) => 'gross_margin_pct' in r && 'price_source' in r && 'has_manual_price' in r), 'rows carry gross_margin_pct, price_source, has_manual_price');
        const prof = await get(`${API}/api/admin/products?limit=3&sort=profit_incl_fixed_ex_gst&order=asc`, H);
        check(prof.body && prof.body.ok, 'sort=profit_incl_fixed_ex_gst accepted');
        const ids = await get(`${API}/api/admin/products?page=1&limit=100&is_active=true&brand=brother&source=compatible&product_type=toner_cartridge&ids_only=true`, H);
        const idd = ids.body && ids.body.data;
        check(idd && Array.isArray(idd.ids) && idd.ids.length === idd.total, `ids_only answers {ids,total} (${idd && idd.ids && idd.ids.length}/${idd && idd.total})`);
        const rules = await get(`${API}/api/admin/pricing/rules`, H);
        check(rules.body && rules.body.ok && Array.isArray(rules.body.data.rules), `GET /pricing/rules (${rules.body && rules.body.data && rules.body.data.count} rules)`);
        // PREVIEWS — write nothing.
        const dry = await post(`${API}/api/admin/pricing/bulk`, { dry_run: true, target: { filter: { brand: 'brother', source: 'compatible', product_type: 'toner_cartridge' } }, action: 'adjust_pct', value: 5, lock: true }, H);
        const dd = dry.body && dry.body.data;
        check(dd && dd.dry_run === true && Number.isInteger(dd.affected) && Array.isArray(dd.sample), `bulk dry run (+5%) previews ${dd && dd.affected} rows, writes nothing`);
        const rp = await post(`${API}/api/admin/pricing/rules`, { filter: { brand: 'brother', source: 'compatible', product_type: 'toner_cartridge' }, margin_pct: 38 }, H);
        const rd = rp.body && rp.body.data;
        check(rd && rd.applied === false && Number.isInteger(rd.locked), `rule preview (no confirm): applied false, ${rd && rd.affected} would change, ${rd && rd.locked} locked`);
        const after = await get(`${API}/api/admin/pricing/rules`, H);
        check(after.body && after.body.data && after.body.data.count === (rules.body.data.count), 'negative control: the preview saved no rule');
        const cart = await get(`${API}/api/cart`, H);
        const lo = cart.body && cart.body.data && cart.body.data.loyalty;
        check(lo && ['full_cover_points', 'max_partial_points', 'shipping_estimated', 'max_redeemable_points'].every((k) => k in lo),
            'cart loyalty carries full_cover_points, max_partial_points, shipping_estimated');
    }
}

console.log(`\n# ${results.pass} pass, ${results.fail} fail, ${results.skip} skipped${results.skip ? ' (a skip is not a pass)' : ''}`);
process.exit(results.fail || results.skip ? 1 : 0);
