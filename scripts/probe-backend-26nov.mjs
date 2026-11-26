#!/usr/bin/env node
/**
 * probe-backend-26nov.mjs
 * =======================
 * Re-measures the backend's reply of 26 Nov 2026 to backend-asks-2026-11-26-dashboard-followup
 * (inbox/backend-asks-2026-11-26-dashboard-followup-backend-response.md, backend `bc40b01`,
 * migration 221). PASS / FAIL / INFO per line.
 *
 *   §1 revenue-series is net of refunds: Σ revenue = kpi revenue; Σ sales − Σ refunds = Σ revenue.
 *   §2 kpi refund_rate = processed refunds in range (refunds-series refund_count) ÷ orders × 100.
 *   §3 out_of_stock 813 (shopper view) vs margin/out-of-stock 608 (supplier feed) — INFO.
 *   §4 Σ daily buckets = the total, to the cent (dashboard-summary series + bundle).
 *   §6 Augmento free at $100 INCL GST: incl-GST fields on every Augmento consignment;
 *      order 2026112601 no longer billed. (`probe:supplier-freight` §7 grades every order.)
 *   §7 INV-3275's product-less line reaches its shadow order (NOT in the reply — expected FAIL
 *      until the backend ships it).
 *
 * MODE: READ-ONLY (GET only; admin token via the Supabase password grant). Analytics GETs paced
 * >= 3.3 s (20/min limiter); RATE_LIMITED stops the run (exit 2, INCOMPLETE — not a pass).
 * Needs ADMIN_EMAIL / ADMIN_PASSWORD (env or repo-root .env).
 *
 *   npm run probe:backend-26nov
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 450);
const ANALYTICS_PACE = Math.max(3300, Number(process.env.PROBE_ANALYTICS_PACE_MS || 3300));

console.log(`probe:backend-26nov — MODE: READ-ONLY (GET only; admin token via password grant) against ${API}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, info: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS  ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL  ${m}`); };
const info = (m) => { results.info++; console.log(`  INFO  ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (rows, k) => round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));

/** The ONE comparison every numeric check goes through (the negative control uses it too). */
function judge(got, want, tol) {
    return typeof got === 'number' && Number.isFinite(got) && Math.abs(got - want) <= tol;
}
let HISTORY_NOTE = false;
function eq(label, got, want, { tol = 0.005, history = false, quiet = false } = {}) {
    const ok = judge(got, want, tol);
    if (quiet) return ok;
    const line = `${label}: measured ${got} expected ${want}${tol > 0.005 ? ` (±${tol})` : ''}`;
    if (ok) pass(line);
    else {
        fail(line + (history ? '  [history: may have moved for a real reason if the owner edited a past order/expense/invoice]' : ''));
        if (history) HISTORY_NOTE = true;
    }
    return ok;
}

function stopped(why) {
    console.log(`\nSTOPPED ${why} — INCOMPLETE (not a pass)`);
    console.log(`# ${results.pass} passed, ${results.fail} failed, ${results.info} info (run stopped early)`);
    process.exit(2);
}
let H = {};
async function get(pathAndQuery, { analytics = false } = {}) {
    await sleep(analytics ? ANALYTICS_PACE : PACE);
    const res = await fetch(`${API}${pathAndQuery}`, { headers: H });
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (res.status === 429 || (body && body.error && body.error.code === 'RATE_LIMITED')) {
        stopped(`on ${pathAndQuery.split('?')[0]}: HTTP ${res.status} RATE_LIMITED`);
    }
    if (res.status !== 200 || !body || body.ok === false) {
        fail(`GET ${pathAndQuery} → HTTP ${res.status} ${JSON.stringify(body && body.error)}`);
        return { status: res.status, data: null, body };
    }
    return { status: res.status, data: body.data, body };
}
const A = (q) => get(`/api/admin/analytics/${q}`, { analytics: true });

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
// NZ calendar day of an instant — never toISOString().slice(0,10) (UTC day).
const nzDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

// ── sign in ──────────────────────────────────────────────────────────────────
const env = readEnv();
const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
const anon = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
    || (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8')) || [])[1];
if (!email || !password || !anon) {
    console.log('NOT RUN: no ADMIN_EMAIL / ADMIN_PASSWORD — every check here is an admin check; nothing measured (not a pass).');
    process.exit(1);
}
{
    const tokRes = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon }, body: JSON.stringify({ email, password }),
    });
    const T = (await tokRes.json().catch(() => ({}))).access_token;
    if (!T) { console.log(`NOT RUN: admin sign-in failed (${tokRes.status}) — nothing measured (not a pass).`); process.exit(1); }
    H = { Authorization: `Bearer ${T}` };
}

const OCT = ['2026-10-01', '2026-10-31'];
const WIN = ['2026-10-26', '2026-11-25'];
const rows = (d) => (Array.isArray(d) ? d : (d && Array.isArray(d.series) ? d.series : []));

// ── negative control: the shared comparison must reject a wrong figure ─────────
if (judge(52, 53, 0.005)) { console.log('negative control did not fail — checks are not checking'); process.exit(1); }
info('negative control: 52 vs a wrong 53 is rejected by the shared comparison, as it must be');

for (const [name, R] of [['October', OCT], ['2026-10-26..2026-11-25', WIN]]) {
    console.log(`\n§1 §2 §4 — ${name}`);
    const rs = rows((await A(`revenue-series?date_from=${R[0]}&date_to=${R[1]}`)).data);
    const k = (await A(`kpi-summary?date_from=${R[0]}&date_to=${R[1]}`)).data;
    const rf = rows((await A(`refunds-series?date_from=${R[0]}&date_to=${R[1]}`)).data);
    const ds = (await A(`dashboard-summary?date_from=${R[0]}&date_to=${R[1]}&granularity=day`)).data;
    const b = (await A(`dashboard-bundle?date_from=${R[0]}&date_to=${R[1]}&granularity=day`)).data;
    if (!k || !k.current || !ds || !ds.current) { fail(`${name}: kpi-summary or dashboard-summary did not answer`); continue; }
    // §1
    check(rs.length > 0 && rs.every((r) => 'sales' in r && 'refunds' in r), `${name} revenue-series rows carry sales + refunds (${rs.length} rows)`);
    eq(`${name} Σ revenue-series revenue == kpi revenue`, sum(rs, 'revenue'), Number(k.current.revenue));
    eq(`${name} Σ sales − Σ refunds == Σ revenue`, round2(sum(rs, 'sales') - sum(rs, 'refunds')), sum(rs, 'revenue'));
    // §2
    const refunded = rf.reduce((s, r) => s + (Number(r.refund_count) || 0), 0);
    const orders = Number(k.current.orders);
    eq(`${name} kpi refund_rate == processed refunds ÷ orders × 100 (${refunded} of ${orders})`,
        Number(k.current.refund_rate), Math.round((orders ? refunded / orders * 100 : 0) * 10) / 10, { tol: 0.05 });
    // §4 — exact now (the backend carries the rounding remainder into the last bucket)
    for (const key of ['revenue', 'gross_profit', 'net_profit']) {
        const want = key === 'revenue' ? Number(ds.current.revenue_incl_gst) : Number(ds.current[key]);
        eq(`${name} Σ dashboard-summary series.${key} == its total, exact`, sum(ds.series || [], key), want);
    }
    eq(`${name} Σ bundle net_profit_series == kpi net_profit, exact`, sum(rows(b && b.net_profit_series), 'net_profit'), Number(k.current.net_profit));
    eq(`${name} Σ bundle gross_profit_series == kpi gross_profit, exact`, sum(rows(b && b.gross_profit_series), 'gross_profit'), Number(k.current.gross_profit));
    eq(`${name} dashboard-summary net == kpi net`, Number(ds.current.net_profit), Number(k.current.net_profit));
    if (name === 'October') eq('October kpi refund_rate (backend live check)', Number(k.current.refund_rate), 0, { history: true });
    else eq('26 Oct–25 Nov kpi refund_rate (backend live check)', Number(k.current.refund_rate), 1.9, { tol: 0.05, history: true });
    // §3 INFO
    if (name === 'October') {
        const m = (await get('/api/admin/margin/out-of-stock?limit=1')).data;
        info(`§3 out_of_stock: dashboard-summary (shopper view) ${ds.actions && ds.actions.out_of_stock && ds.actions.out_of_stock.count}; margin/out-of-stock (supplier feed) ${m && m.total_out_of_stock}. The Dashboard tile shows the shopper view.`);
    }
}

// §6 — every Augmento consignment carries the incl-GST pair; the headline order is free.
console.log('\n§6 — Augmento free at $100 INCL GST');
const all = [];
for (let page = 1; page <= 20; page++) {
    const d = (await get(`/api/admin/orders?limit=100&page=${page}`)).data;
    const got = Array.isArray(d) ? d : ((d && d.orders) || []);
    all.push(...got);
    if (got.length < 100) break;
}
const aug = [];
for (const o of all) for (const c of ((o.supplier_freight && o.supplier_freight.consignments) || [])) if (/augmento/i.test(String(c.supplier || ''))) aug.push({ o, c });
check(aug.length > 0, `${aug.length} Augmento consignments over ${all.length} orders`);
const missingPair = aug.filter(({ c }) => c.goods_cost_ex_gst != null && (c.goods_cost_incl_gst == null || Number(c.free_threshold_incl_gst) !== 100));
check(missingPair.length === 0, `every costed Augmento consignment carries goods_cost_incl_gst + free_threshold_incl_gst 100 (${missingPair.length} without)`);
const wrongEx = aug.filter(({ c }) => c.free_threshold_ex_gst != null && Number(c.free_threshold_ex_gst) !== 86.96);
check(wrongEx.length === 0, `free_threshold_ex_gst is 86.96 on every Augmento consignment (${wrongEx.length} differ)`);
const head = all.find((o) => String(o.order_number) === '2026112601');
const hc = head && ((head.supplier_freight && head.supplier_freight.consignments) || [])[0];
check(!!hc && hc.billed === false && Number(hc.goods_cost_incl_gst) === 110.4,
    `2026112601: Augmento not billed on $110.40 incl GST (billed=${hc && hc.billed}, reason=${hc && hc.reason})`);
info('every order graded against the rule: run `npm run probe:supplier-freight` (§7)');

// §7 — not in the reply. INV-3275's only line has no product; its shadow order must carry it.
console.log('\n§7 — product-less invoice lines (INV-3275) — NOT answered in the 26 Nov reply');
const inv = all.find((o) => String(o.order_number) === 'INV-3275');
check(!!inv && Number(inv.items_count) > 0 && inv.cost_complete !== false,
    `INV-3275 shadow order carries its freight line (items_count=${inv && inv.items_count}, cost_complete=${inv && inv.cost_complete}) — pending backend §7`);

console.log(`\n# ${results.pass} passed, ${results.fail} failed, ${results.info} info`);
if (HISTORY_NOTE) console.log('# a [history] FAIL may be a real edit to a past record — check before calling it a regression.');
process.exit(results.fail ? 1 : 0);
