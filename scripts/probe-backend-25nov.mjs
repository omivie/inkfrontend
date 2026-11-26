#!/usr/bin/env node
/**
 * probe-backend-25nov.mjs
 * =======================
 * Re-measures the claims of the backend's reply of 25 Nov 2026 about the admin
 * money numbers (dashboard-summary / kpi-summary / pnl / dashboard-bundle /
 * refunds / expenses / invoice shadow orders / actions). Each line says
 * PASS / FAIL / INFO. INFO is a measurement the FE has to display, not a verdict.
 *
 * MODE: READ-ONLY (GET only; admin token via the Supabase password grant). It
 * never writes anything. Section A pins HISTORY: a figure can move for a real
 * reason if the owner edits a past order, expense or invoice; the FAIL line
 * says so, but it is still a FAIL.
 *
 * The analytics limiter is 20 requests/min per user, so analytics GETs are
 * paced >= 3.3 s apart. A RATE_LIMITED answer STOPS the probe (exit 2): the
 * run is INCOMPLETE, not a pass. Do not run it beside other admin traffic.
 *
 * Needs ADMIN_EMAIL / ADMIN_PASSWORD (env or repo-root .env).
 *
 *   npm run probe:backend-25nov
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 450);
const ANALYTICS_PACE = Math.max(3300, Number(process.env.PROBE_ANALYTICS_PACE_MS || 3300));

console.log(`probe:backend-25nov — MODE: READ-ONLY (GET only; admin token via password grant) against ${API}`);

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
const AUG = ['2026-08-01', '2026-08-31'];
const dsQ = ([f, t]) => `dashboard-summary?date_from=${f}&date_to=${t}&granularity=day`;
const kpiQ = ([f, t]) => `kpi-summary?date_from=${f}&date_to=${t}`;
const bunQ = ([f, t]) => `dashboard-bundle?date_from=${f}&date_to=${t}&granularity=day`;

const dsOct = (await A(dsQ(OCT))).data;
const kpiOct = (await A(kpiQ(OCT))).data;
const dsWin = (await A(dsQ(WIN))).data;
const kpiWin = (await A(kpiQ(WIN))).data;
if (!dsOct || !kpiOct || !dsWin || !kpiWin) stopped('a core analytics read failed — checks A..C cannot be measured');
const cO = dsOct.current, cW = dsWin.current, kO = kpiOct.current, kW = kpiWin.current;

// ── A. live-check table ──────────────────────────────────────────────────────
console.log('\nA. live-check table (history)');
for (const [k, v] of Object.entries({ orders: 52, revenue_incl_gst: 5877.15, refunds: 0, revenue_ex_gst: 5110.57, cogs: 3697.25, stripe_fees: 122.41, operating_expenses: 2766.89 })) {
    eq(`Oct 2026 dashboard-summary.${k}`, cO[k], v, { history: true });
}
eq('Oct 2026 kpi-summary.invoice_revenue', kO.invoice_revenue, 1074.27, { history: true });
eq('Oct 2026 kpi-summary.invoice_orders', kO.invoice_orders, 7, { history: true });
for (const [k, v] of Object.entries({ revenue_incl_gst: 6432.20, refunds: 59.40, revenue_ex_gst: 5593.22, cogs: 4942.07 })) {
    eq(`2026-10-26..2026-11-25 dashboard-summary.${k}`, cW[k], v, { history: true });
}

// ── B. ONE definition ────────────────────────────────────────────────────────
console.log('\nB. one definition (dashboard-summary = kpi-summary = pnl = bundle = series)');
const PAIRS = [['revenue_incl_gst', 'revenue'], ['refunds', 'refunds'], ['gross_profit', 'gross_profit'], ['stripe_fees', 'stripe_fees'],
    ['supplier_freight', 'supplier_freight'], ['operating_expenses', 'operating_expenses'], ['net_profit', 'net_profit'], ['orders', 'orders']];
for (const [name, c, k] of [['October', cO, kO], ['2026-10-26..2026-11-25', cW, kW]]) {
    for (const [dk, kk] of PAIRS) eq(`${name} dashboard-summary.${dk} == kpi-summary.${kk}`, c[dk], k[kk]);
}
{
    const pnl = (await A(`pnl?start_date=${OCT[0]}&end_date=${OCT[1]}`)).data;
    const p = pnl && (pnl.periods || []).find((x) => x.period === '2026-10');
    if (!p) fail('pnl has no period 2026-10');
    else {
        for (const [pk, kk] of [['revenue', 'revenue'], ['refunds', 'refunds'], ['gross_profit', 'gross_profit'], ['stripe_fees', 'stripe_fees'],
            ['supplier_freight', 'supplier_freight'], ['operating_expenses', 'operating_expenses'], ['net_profit', 'net_profit'], ['order_count', 'orders']]) {
            eq(`pnl 2026-10 .${pk} == kpi October .${kk}`, p[pk], kO[kk]);
        }
    }
}
for (const [name, range, k, ds] of [['October', OCT, kO, dsOct], ['2026-10-26..2026-11-25', WIN, kW, dsWin]]) {
    const b = (await A(bunQ(range))).data;
    if (!b) continue;
    const rev = ((b.revenue_series || {}).series) || [];
    const gp = ((b.gross_profit_series || {}).series) || [];
    const np = ((b.net_profit_series || {}).series) || [];
    eq(`${name} Σ bundle revenue_series.revenue == kpi revenue`, sum(rev, 'revenue'), k.revenue);
    eq(`${name} Σ bundle gross_profit_series.gross_profit == kpi gross_profit`, sum(gp, 'gross_profit'), k.gross_profit);
    // Each bucket's net profit is rounded to the cent on its own, so a sum of n buckets can
    // drift from the total by up to ½¢ per bucket (measured 2026-11-26: October −1890.77 vs
    // −1890.79 over 31 days). That bound is the tolerance — anything past it is a real gap.
    eq(`${name} Σ bundle net_profit_series.net_profit == kpi net_profit (±½¢ per bucket rounding)`, sum(np, 'net_profit'), k.net_profit, { tol: round2(Math.max(0.01, 0.005 * np.length)) });
    const opex = sum(np, 'operating_expenses');
    eq(`${name} Σ bundle net_profit_series.operating_expenses == kpi operating_expenses (±0.01 rounding)`, opex, k.operating_expenses, { tol: 0.01 });
    if (opex !== k.operating_expenses) info(`${name} opex rounding drift ${round2(opex - k.operating_expenses)}`);
    const s = ds.series || [];
    eq(`${name} Σ dashboard-summary series.revenue == its current.revenue_incl_gst`, sum(s, 'revenue'), ds.current.revenue_incl_gst);
    eq(`${name} Σ dashboard-summary series.gross_profit == its current.gross_profit`, sum(s, 'gross_profit'), ds.current.gross_profit);
    eq(`${name} Σ dashboard-summary series.net_profit == its current.net_profit (±½¢ per bucket rounding)`, sum(s, 'net_profit'), ds.current.net_profit, { tol: round2(Math.max(0.01, 0.005 * s.length)) });
}

// ── C. identities ────────────────────────────────────────────────────────────
console.log('\nC. identities (dashboard-summary current)');
for (const [name, c] of [['October', cO], ['2026-10-26..2026-11-25', cW]]) {
    eq(`${name} revenue_ex_gst == round(revenue_incl_gst/1.15, 2)`, c.revenue_ex_gst, round2(c.revenue_incl_gst / 1.15), { tol: 0.01 });
    eq(`${name} gross_profit == revenue_ex_gst - cogs`, c.gross_profit, round2(c.revenue_ex_gst - c.cogs), { tol: 0.02 });
    eq(`${name} net_profit == gross - stripe - freight - opex`, c.net_profit, round2(c.gross_profit - c.stripe_fees - c.supplier_freight - c.operating_expenses), { tol: 0.02 });
}

// ── D. pnl ?days is ignored ──────────────────────────────────────────────────
console.log('\nD. pnl ?days=120 and date_range');
{
    const d = (await A('pnl?days=120')).data;
    const dr = d && d.date_range;
    if (!dr) fail('pnl?days=120 returned no date_range');
    else {
        const span = Math.round((Date.parse(dr.end) - Date.parse(dr.start)) / 86400000) + 1;
        if (span !== 120) pass(`pnl?days=120 returned ${dr.start}..${dr.end} = ${span} days (!= 120): days is IGNORED, the FE must send start_date/end_date`);
        else info(`pnl?days=120 now returns a 120-day window ${dr.start}..${dr.end}: days looks honoured (expected-behaviour changed)`);
        check(dr.timezone === 'Pacific/Auckland' && !!dr.start && !!dr.end, `pnl date_range = ${JSON.stringify(dr)} (want start, end, timezone Pacific/Auckland)`);
    }
}

// ── E. invoice shadow orders ─────────────────────────────────────────────────
console.log('\nE. invoice shadow orders: created_at = issue_date T00:00:00');
async function pageAll(basePath, pick, limit) {
    const rows = [];
    let total = null;
    for (let page = 1; page <= 50; page++) {
        const r = await get(`${basePath}${basePath.includes('?') ? '&' : '?'}page=${page}&limit=${limit}`);
        if (!r.data) return { rows, total, failed: true };
        const got = pick(r.data);
        const pg = r.data.pagination || (r.body && r.body.meta) || (r.body && r.body.pagination) || {};
        if (pg.total != null) total = Number(pg.total);
        rows.push(...got);
        if (!got.length || (total != null && rows.length >= total) || (total == null && got.length < limit)) break;
    }
    return { rows, total, failed: false };
}
{
    const inv = await pageAll('/api/admin/invoices?', (d) => d.invoices || [], 100);
    const ord = await pageAll('/api/admin/orders?search=INV-', (d) => (Array.isArray(d) ? d : d.orders || []), 200);
    check(!inv.failed && (inv.total == null || inv.rows.length === inv.total), `invoices paged fully: ${inv.rows.length} of pagination.total ${inv.total}`);
    const shadows = ord.rows.filter((o) => o.channel === 'invoice');
    info(`orders?search=INV-: ${ord.rows.length} rows (pagination.total ${ord.total}), ${shadows.length} channel:'invoice'`);
    const byNum = new Map(inv.rows.map((i) => [`INV-${i.invoice_number}`, i]));
    const bad = [];
    let unmatched = 0;
    for (const o of shadows) {
        const i = byNum.get(o.order_number);
        if (!i) { unmatched++; continue; }
        if (!String(o.created_at).startsWith(`${i.issue_date}T00:00:00`)) bad.push(`${o.order_number} created_at ${o.created_at} vs issue_date ${i.issue_date}`);
    }
    check(bad.length === 0, `invoice shadow orders whose created_at != <issue_date>T00:00:00: ${bad.length} (expect 0)${bad.length ? ' — ' + bad.slice(0, 5).join('; ') : ''}`);
    if (unmatched) info(`${unmatched} channel:'invoice' order(s) had no invoice in the invoices list (not compared)`);
}

// ── F. refunds ───────────────────────────────────────────────────────────────
console.log('\nF. refunds');
{
    const today = nzDay(Date.now());
    const rf = await pageAll('/api/admin/refunds?', (d) => d.refunds || [], 100);
    const rows = rf.rows;
    const noStatus = rows.filter((r) => typeof r.order_status !== 'string');
    check(rows.length > 0 && noStatus.length === 0, `every refund row has string order_status (${rows.length} rows, ${noStatus.length} without)`);
    const pendingRows = rows.filter((r) => r.status === 'pending');
    info(`refund rows by status: ${JSON.stringify(rows.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {}))}`);
    const byDay = {};
    for (const r of rows.filter((x) => x.status === 'processed' && x.refunded_at)) {
        const d = nzDay(r.refunded_at);
        if (d >= '2026-09-01' && d <= today) byDay[d] = round2((byDay[d] || 0) + Number(r.amount));
    }
    const rs = (await A(`refunds-series?date_from=2026-09-01&date_to=${today}`)).data;
    if (rs) {
        const seriesDays = {};
        for (const s of rs.series || []) if (Number(s.total_amount) !== 0) seriesDays[s.date] = round2(Number(s.total_amount));
        const keys = [...new Set([...Object.keys(byDay), ...Object.keys(seriesDays)])].sort();
        const diffs = keys.filter((k) => (byDay[k] || 0) !== (seriesDays[k] || 0));
        check(diffs.length === 0, `refunds-series nonzero days ${JSON.stringify(seriesDays)} == processed refunds by NZ day of refunded_at ${JSON.stringify(byDay)}${diffs.length ? ` — differ on ${diffs.join(', ')}` : ''}`);
        if (pendingRows.length) {
            const leak = pendingRows.filter((r) => r.refunded_at && seriesDays[nzDay(r.refunded_at)] != null && !byDay[nzDay(r.refunded_at)]);
            check(leak.length === 0, `${pendingRows.length} pending refund(s) not counted in refunds-series (${leak.length} leaked)`);
        } else info('no pending refund exists right now — "pending must not appear" not measurable');
    }
}

// ── G. GST category ──────────────────────────────────────────────────────────
console.log('\nG. GST payment category');
{
    const cats = (await get('/api/admin/expense-categories')).data;
    const keys = ((cats && cats.categories) || []).map((c) => c.key);
    check(keys.includes('gst_payment'), `expense-categories lists gst_payment (${keys.length} keys)`);
    const ex = await pageAll('/api/admin/expenses?', (d) => d.items || [], 1000);
    const RE = /\bG\.?S\.?T\b|\bIRD\b|inland\s+revenue|tax\s+payment/i;
    const hits = ex.rows.filter((e) => !e.deleted_at && e.category === 'other' && (RE.test(e.name || '') || RE.test(e.payee || '')));
    check(!ex.failed && hits.length === 0, `non-deleted 'other' expenses that look like GST/IRD payments: ${hits.length} of ${ex.rows.length}${hits.length ? ' — ' + hits.map((e) => `${e.name || e.payee} ${e.amount} ${e.expense_date}`).join('; ') : ''}`);
    const es = (await get(`/api/admin/expenses/summary?from=${OCT[0]}&to=${OCT[1]}`)).data;
    eq('expenses/summary October operating_paid == dashboard-summary October operating_expenses', es && es.summary && es.summary.operating_paid, cO.operating_expenses);
}

// ── H. actions shape ─────────────────────────────────────────────────────────
console.log('\nH. actions shape');
{
    const act = dsOct.actions || {};
    for (const k of ['needs_tracking', 'missing_cost', 'under_margin_floor', 'out_of_stock']) {
        const a = act[k];
        check(a && Number.isInteger(a.count) && Array.isArray(a.rows) && a.rows.length <= 50 && a.rows.length <= a.count,
            `actions.${k}: count ${a && a.count}, rows ${a && a.rows && a.rows.length} (want integer count, rows <= 50 and <= count)`);
    }
    const unknown = (cO.cogs_unknown_orders || []).length;
    check(act.missing_cost && act.missing_cost.count === unknown, `actions.missing_cost.count ${act.missing_cost && act.missing_cost.count} == current.cogs_unknown_orders.length ${unknown}`);
    const umf = act.under_margin_floor || {};
    info(`under_margin_floor count ${umf.count}, first row margin_floor ${umf.rows && umf.rows[0] && umf.rows[0].margin_floor} — the FE low-margin alert uses a different rule (net margin < 10%)`);
}

// ── I. a range containing August 2026 ────────────────────────────────────────
console.log('\nI. August 2026 (unknown cost)');
{
    const ds = (await A(dsQ(AUG))).data;
    const kp = (await A(kpiQ(AUG))).data;
    if (ds) {
        const c = ds.current;
        info(`dashboard-summary Aug: gross_profit ${typeof c.gross_profit === 'number' ? 'is a number (' + c.gross_profit + ')' : JSON.stringify(c.gross_profit)}; cogs_unknown_orders lists INV-3275: ${JSON.stringify(c.cogs_unknown_orders || []).includes('INV-3275')} (${(c.cogs_unknown_orders || []).length} orders)`);
    }
    if (kp) info(`kpi-summary Aug: gross_profit ${kp.current.gross_profit === null ? 'null (dropped)' : JSON.stringify(kp.current.gross_profit)}, net_profit ${JSON.stringify(kp.current.net_profit)} — the dashboard must show this loudly`);
}

// ── J. negative control ──────────────────────────────────────────────────────
console.log('\nJ. negative control');
const ncOk = eq('NEGATIVE CONTROL October orders', cO.orders, 53, { quiet: true });
if (ncOk) {
    console.log('negative control did not fail — checks are not checking');
    process.exit(1);
}
info(`negative control: comparing October orders ${cO.orders} to a wrong 53 reports FAIL, as it must`);

if (HISTORY_NOTE) console.log('\nNOTE: a section-A figure above differs from the 2026-11-26 live check; history can move if the owner edited a past order/expense/invoice — still a FAIL until the table is re-pinned.');
console.log(`\n# ${results.pass} passed, ${results.fail} failed, ${results.info} info`);
process.exit(results.fail ? 1 : 0);
