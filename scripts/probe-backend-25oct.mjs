#!/usr/bin/env node
/**
 * probe-backend-25oct.mjs
 * =======================
 * Re-measures every claim of the backend's reply of 25 Oct 2026
 * (backend-docs/inbox/backend-response-2026-10-25.md) that the frontend now
 * relies on or that the reply says shipped. Each line says PASS / FAIL /
 * PENDING / SKIP:
 *   - PENDING = the reply says this ships "with the next deploy" and the live
 *     backend does not do it yet. It is NOT a pass: re-run after the deploy.
 *   - SKIP    = could not measure (no admin credentials). NOT a pass either.
 * Any FAIL, PENDING or SKIP makes the exit code non-zero.
 *
 * MODE: READ-ONLY in OUR repo — GET requests only (plus the Supabase password
 * grant that mints the admin token). It never saves a price, a rule or an
 * order. It is NOT invisible to the backend: the item-37 checks GET
 * /api/search/smart with 8 real product/printer terms, and every such GET
 * appends a search_analytics row (ERR-254). Real terms cannot carry the
 * zzprobe_ sentinel without measuring something else, so the notice below is
 * printed on every run instead of pretending otherwise.
 *
 * Admin checks need ADMIN_EMAIL / ADMIN_PASSWORD (env or repo-root .env).
 *
 *   npm run probe:backend-25oct
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEARCH_ANALYTICS_NOTICE } from './lib/probe-search-notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const WWW = process.env.WWW_BASE || 'https://www.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 450);
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

console.log(`probe:backend-25oct — MODE: READ-ONLY (GET only; admin token via password grant) against ${API}`);
console.log(SEARCH_ANALYTICS_NOTICE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, pending: 0, skip: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS     ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL     ${m}`); };
const pending = (m) => { results.pending++; console.log(`  PENDING  ${m}`); };
const skip = (m) => { results.skip++; console.log(`  SKIP     ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));
/** A claim the reply says ships with the NEXT deploy: not there yet ⇒ PENDING. */
const shipsNext = (ok, m) => (ok ? pass(m) : pending(m));

async function get(url, headers = {}) {
    await sleep(PACE);
    const res = await fetch(url, { headers, redirect: 'manual' });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body, text, location: res.headers.get('location') || '' };
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

const health = await get(`${API}/health`);
console.log(`  INFO     backend commit ${health.body && health.body.data && health.body.data.commit}`);

// ── §1 low-ticket floor: the applied and the held prices ────────────────────
console.log('\n§1 minimum unit profit — live prices');
const PRICES = {
    C81NBK: 7.49, C103BK: 7.49, C200XLBK: 7.49, CBCI3BK: 6.49, CLC37Y: 6.49,   // raised (ladder)
    C73NBK: 6.99, C73NC: 6.99, CBCI3C: 5.49, CBCI3M: 5.49,                      // held for live ads
    '637.01': 8.95, '651.01': 8.95, C174LOT: 10.95,                             // ribbons raised
    CBCI6KCMY: 20.99, C200XLKCMY: 28.49, C200XLCMY: 21.49, CIB3757CMY: 18.99,   // packs re-anchored
    CT0491BK: 5.79, CBCI6BK: 5.99,                                              // manual: untouched, owner decides
};
for (const [sku, want] of Object.entries(PRICES)) {
    const r = await get(`${API}/api/products/${encodeURIComponent(sku)}`);
    const got = r.body && r.body.data && r.body.data.retail_price;
    check(Number(got) === want, `${sku} retail ${got} (reply: ${want})`);
}

// ── §3 /receipt-rolls landing ────────────────────────────────────────────────
console.log('\n§3 /receipt-rolls');
{
    const nav = await get(`${API}/api/site/nav`);
    const cat = nav.body && nav.body.data && (nav.body.data.categories || []).find((c) => c.slug === 'receipt');
    check(cat && cat.path === '/receipt-rolls' && cat.landing === true, `nav receipt → ${cat && cat.path} (landing ${cat && cat.landing})`);
    const sm = await get(`${WWW}/sitemap.xml`);
    const smAll = [sm.text];
    for (const m of sm.text.matchAll(/<loc>([^<]+sitemap[^<]*\.xml)<\/loc>/g)) smAll.push((await get(m[1])).text);
    shipsNext(smAll.some((t) => t.includes('/receipt-rolls')), '/receipt-rolls is in the sitemap');
    const llms = await get(`${WWW}/llms.txt`);
    shipsNext(llms.text.includes('/receipt-rolls'), 'llms.txt links /receipt-rolls');
    const pr = await get(`${API}/api/prerender/category/receipt`);
    shipsNext(/rel="canonical" href="https:\/\/www\.inkcartridges\.co\.nz\/receipt-rolls"/.test(pr.text), 'category prerender canonical = /receipt-rolls');
}

// ── §4 follow-ups ────────────────────────────────────────────────────────────
console.log('\n§4 aliases, roll prerender, bot footer');
for (const alias of ['receipt-rolls', 'receipt-roll', 'receipt_roll', 'photo_paper', 'label-tape', 'ribbons', 'drum-units', 'Receipt-Rolls']) {
    const r = await get(`${API}/api/products?category=${encodeURIComponent(alias)}&limit=1`);
    check(r.status === 200, `/api/products?category=${alias} → ${r.status}`);
}
{
    const r = await get(`${API}/api/products?category=receipt&limit=1`);
    const p = r.body && r.body.data && (r.body.data.products || r.body.data)[0];
    if (!p) fail('no receipt roll to check the product prerender against');
    else {
        const pr = await get(`${API}/api/prerender/product/${encodeURIComponent(p.sku)}`);
        shipsNext(pr.text.includes('/receipt-rolls') && !/href="[^"]*brand=okin/i.test(pr.text) && !/See all Okin/i.test(pr.text),
            `${p.sku} prerender: breadcrumb via /receipt-rolls, no Okin brand links`);
        shipsNext(/Receipt Rolls/.test(pr.text) && /Printer Ribbons/.test(pr.text), `${p.sku} prerender: bot footer lists Printer Ribbons + Receipt Rolls`);
    }
}

// ── §5 item 46: printer prerender order ──────────────────────────────────────
console.log('\n§5 item 46 printer prerender, item 37 exact search');
{
    const pr = await get(`${WWW}/shop?brand=brother&printer_slug=brother-mfc-j4620dw`, { 'user-agent': BOT });
    // Product cards are the h3 titles; the page's <head>, nav and intro also
    // say "Genuine", so only the card titles are compared.
    const titles = [...pr.text.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    const firstGenuine = titles.findIndex((t) => /\bGenuine\b/.test(t));
    const lastCompatible = titles.map((t) => /\bCompatible\b/.test(t)).lastIndexOf(true);
    check(pr.status === 200 && lastCompatible > -1 && (firstGenuine === -1 || lastCompatible < firstGenuine),
        `printer prerender: all ${lastCompatible + 1} Compatible cards above the first Genuine card (#${firstGenuine + 1}, status ${pr.status})`);
}
// item 37 — matched_printer.exact. One query per case; the first must be exact.
const EXACT = [
    ['brother mfc-j4340dw', true, 'brother-mfc-j4340dw'],
    ['canon g7060', false], ['brother mfc-j4340', false], ['canon 540', false], ['epson 300', false], ['canon ts5360', false],
];
for (const [q, want, slug] of EXACT) {
    const r = await get(`${API}/api/search/smart?q=${encodeURIComponent(q)}&limit=1`);
    const mp = r.body && r.body.data && r.body.data.matched_printer;
    if (want) shipsNext(mp && mp.exact === true && mp.slug === slug, `"${q}" → ${mp ? `${mp.slug} exact=${mp.exact}` : 'no printer'} (want ${slug} exact=true)`);
    else check(!mp || mp.exact !== true, `"${q}" is NOT exact (${mp ? `${mp.slug} exact=${mp.exact}` : 'no printer'})`);
}
for (const [q, sku] of [['canon pg645', 'GPG645BK'], ['epson 288xl black', 'G288HYBK']]) {
    const r = await get(`${API}/api/search/smart?q=${encodeURIComponent(q)}&limit=1`);
    const ep = r.body && r.body.data && r.body.data.exact_product;
    check(ep && ep.sku === sku && /^\/products\/[^/]+\/[^/]+$/.test(ep.url || ''), `exact_product "${q}" → ${ep && ep.sku} ${ep && ep.url}`);
}

// ── Admin: §1 min_unit_profit + §2 NZ-day kpi bounds ────────────────────────
console.log('\n§1/§2 admin');
const env = readEnv();
const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
const anon = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
    || (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8')) || [])[1];
if (!email || !password || !anon) {
    skip('no ADMIN_EMAIL / ADMIN_PASSWORD — min_unit_profit and the kpi-summary NZ bounds NOT measured');
} else {
    await sleep(PACE);
    const tokRes = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon }, body: JSON.stringify({ email, password }),
    });
    const T = (await tokRes.json().catch(() => ({}))).access_token;
    if (!T) skip(`admin sign-in failed (${tokRes.status}) — admin checks NOT measured`);
    else {
        const H = { Authorization: `Bearer ${T}` };
        const tm = await get(`${API}/api/admin/pricing/tier-multipliers`, H);
        const mup = tm.body && tm.body.data && tm.body.data.min_unit_profit;
        shipsNext(mup && Number(mup.ex_gst) === 2.5, `tier-multipliers min_unit_profit = ${JSON.stringify(mup)}`);
        // §2: the reply's own example. 225 orders / $34,597.56 with NZ bounds
        // (226 / $34,630.55 was the UTC answer: order 2026102001 straddles).
        const k = await get(`${API}/api/admin/analytics/kpi-summary?date_from=2026-03-14&date_to=2026-10-19`, H);
        const d = (k.body && k.body.data) || {};
        const cur = d.current || d;
        const orders = Number(cur.total_orders ?? cur.orders ?? cur.order_count);
        const revenue = Number(cur.total_revenue ?? cur.revenue ?? cur.gross_revenue);
        if (!Number.isFinite(orders)) fail(`kpi-summary shape not understood: ${JSON.stringify(d).slice(0, 200)}`);
        else if (orders === 225) pass(`kpi-summary 2026-03-14..2026-10-19 on NZ days: ${orders} orders, $${revenue}`);
        else if (orders === 226) pending(`kpi-summary still on UTC bounds: ${orders} orders, $${revenue} (NZ answer 225 / $34,597.56)`);
        else fail(`kpi-summary ${orders} orders, $${revenue} — neither the UTC (226) nor the NZ (225) answer`);
    }
}

console.log(`\n# ${results.pass} pass, ${results.fail} fail, ${results.pending} pending, ${results.skip} skipped`
    + `${results.pending || results.skip ? ' (pending and skipped are NOT passes)' : ''}`);
process.exit(results.fail || results.pending || results.skip ? 1 : 0);
