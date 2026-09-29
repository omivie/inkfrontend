#!/usr/bin/env node
/**
 * probe-best-sellers — what can GET /api/admin/analytics/top-products-rpc rank by?
 *
 * The Best Sellers tab (Performance hub) and the dashboard "Most Bought" card offer
 * three rankings: revenue, units, orders. Which of them are LIVE depends on facts
 * only the server can answer, so this probe measures them instead of assuming:
 *
 *   §1  does result_limit above 10 return more rows?   (can units be ranked client-side?)
 *   §2  is the default order revenue-descending?
 *   §3  an unknown parameter (sort_by) is REFUSED with 400 VALIDATION_FAILED,
 *       and every parameter the loader sends is accepted (BF-090, ERR-299)
 *   §4  the fields the loader maps exist on every row (BF-089: sale_skus,
 *       product_id, brand, product_type, pack_type)
 *   §5  do status/brand/category/supplier filters bite?  NEGATIVE CONTROL: an
 *       impossible category/supplier must return 0 rows; an impossible STATUS
 *       must be a 400; a storefront slug (`ink`) is not a category CODE (0 rows)
 *       while CON-INK is (>0) — the filter bar sends codes
 *   §6  are cancelled orders reachable on purpose (status_filter=cancelled)?
 *   §7  one row per product: no SKU on two rows (BF-089)
 *
 * MODE: READ-ONLY. GET only, besides the admin sign-in. Nothing is recorded.
 * Paced (PROBE_DELAY_MS, default 700ms) — the limiter is 100 req/60s per IP,
 * shared across endpoints; an unpaced run 429s and the failure MOVES.
 *
 * Usage:  npm run probe:best-sellers      (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.API_BASE || 'https://ink-backend-sg.onrender.com';
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(
    fs.readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(),
        l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
  );
}

let fails = 0;
const pass = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const fail = (m) => { fails++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const fact = (m) => console.log(`  \x1b[36mFACT\x1b[0m ${m}`);

async function main() {
  console.log('\n\x1b[1mprobe-best-sellers\x1b[0m — what can top-products-rpc rank by?');
  console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only besides the sign-in; nothing is written)\n');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set. Nothing was verified. Do NOT read this as a pass.\n');
    process.exit(2);
  }
  const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await auth.json();
  if (!session.access_token) {
    console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (${auth.status}). Nothing was verified.\n`);
    process.exit(2);
  }
  const H = { Authorization: `Bearer ${session.access_token}` };

  const get = async (qs) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${BASE}/api/admin/analytics/top-products-rpc?${qs}`, { headers: H });
      const text = await res.text();
      await sleep(DELAY_MS);
      if (res.status === 429) { console.log('  \x1b[90m429 — waiting 20s\x1b[0m'); await sleep(20000); continue; }
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      const body = json?.data ?? json;
      const rows = Array.isArray(body) ? body : (Array.isArray(body?.products) ? body.products : null);
      return { status: res.status, json, rows, meta: Array.isArray(body) ? json?.meta ?? null : body };
    }
    return { status: 429, json: null, rows: null, meta: null };
  };
  const sig = (rows) => (rows || []).map((r) => r.product_sku || r.sku || r.product_name).join('|');
  const units = (r) => Number(r.units_sold ?? r.units ?? r.quantity ?? 0);
  const desc = (rows, f) => rows.every((r, i) => i === 0 || f(rows[i - 1]) >= f(r));

  // All-time window: the widest set, so ordering and truncation are visible.
  const base = `date_from=2020-01-01&date_to=${new Date().toISOString().slice(0, 10)}`;

  console.log('§1 row cap');
  const r10 = await get(`${base}&result_limit=10`);
  const r500 = await get(`${base}&result_limit=500`);
  if (!r10.rows) { fail(`result_limit=10 unreadable (HTTP ${r10.status})`); process.exit(1); }
  fact(`result_limit=10 → ${r10.rows.length} rows; result_limit=500 → ${r500.rows?.length ?? 'unreadable'} rows (HTTP ${r500.status})`);
  const wide = r500.rows && r500.rows.length > 10;
  fact(wide ? 'wide fetch WORKS — units can be ranked client-side over the full set'
            : 'capped at 10 — a client-side units ranking would be ranked on a TRUNCATED set');

  console.log('\n§2 default order');
  const rev = (r) => Number(r.revenue ?? r.total ?? 0);
  (desc(r500.rows || r10.rows, rev) ? pass : fail)('default order is revenue-descending');

  console.log('\n§3 strict parameters (BF-090)');
  {
    const r = await get(`${base}&result_limit=10&sort_by=units`);
    const field = r.json?.error?.details?.[0]?.field;
    (r.status === 400 && r.json?.error?.code === 'VALIDATION_FAILED' && field === 'sort_by' ? pass : fail)(
      `sort_by (unknown) → 400 VALIDATION_FAILED naming it (HTTP ${r.status}, field ${field})`);
    // Every key the admin loader can send (admin/api.js analyticsQuery + result_limit).
    const g = await get(`${base}&result_limit=10&granularity=day&brand_filter=HP&supplier_filter=zz&status_filter=paid&category_filter=CON-INK`);
    (g.status === 200 ? pass : fail)(`every parameter the loader sends is accepted (HTTP ${g.status})`);
  }

  console.log('\n§4 row fields');
  const keys = new Set((r500.rows || r10.rows).flatMap((r) => Object.keys(r)));
  fact(`keys: ${[...keys].sort().join(', ')}`);
  for (const k of ['product_sku', 'product_name', 'revenue', 'units_sold', 'order_count', 'sale_skus', 'product_id', 'brand', 'product_type', 'pack_type']) {
    const rows = r500.rows || [];
    const missing = rows.filter((r) => !(k in r)).length;
    (missing === 0 ? pass : fail)(`every row carries ${k}${missing ? ` (${missing} rows lack it)` : ''}`);
  }
  const gone = (r500.rows || []).filter((r) => r.pack_type == null);
  fact(`${gone.length} row(s) with pack_type null (product no longer exists → "not in catalogue")`);
  const soldAs = (r500.rows || []).filter((r) => (r.sale_skus || []).some((x) => x !== r.product_sku));
  fact(`${soldAs.length} product(s) sold under another SKU, e.g. ${soldAs.slice(0, 3).map((r) => `${r.product_sku} <- ${r.sale_skus.join('/')}`).join('; ')}`);

  console.log('\n§5 filters (negative controls)');
  for (const [k, v] of [['brand_filter', 'zz-no-such-brand'], ['category_filter', 'zz_no_such_cat'], ['supplier_filter', 'zz-no-such-supplier'], ['category_filter', 'ink']]) {
    const r = await get(`${base}&result_limit=10&${k}=${v}`);
    (r.status === 200 && r.rows?.length === 0 ? pass : fail)(`${k}=${v} → 0 rows (HTTP ${r.status}, ${r.rows?.length ?? 'unreadable'} rows)`);
  }
  {
    const r = await get(`${base}&result_limit=10&status_filter=zz_no_such_status`);
    (r.status === 400 ? pass : fail)(`status_filter=zz_no_such_status → 400 (HTTP ${r.status})`);
  }
  for (const [k, v] of [['category_filter', 'CON-INK'], ['brand_filter', 'hp'], ['brand_filter', 'HP']]) {
    const r = await get(`${base}&result_limit=500&${k}=${v}`);
    (r.rows?.length > 0 ? pass : fail)(`POSITIVE CONTROL ${k}=${v} → ${r.rows?.length ?? 'unreadable'} rows`);
  }

  console.log('\n§6 cancelled: excluded by default, reachable on purpose');
  const rc = await get(`${base}&result_limit=10&status_filter=cancelled,refunded`);
  (rc.rows?.length > 0 ? pass : fail)(`status_filter=cancelled,refunded → ${rc.rows?.length ?? 'unreadable'} rows (HTTP ${rc.status})`);
  const rp = await get(`${base}&result_limit=10&status_filter=paid,processing,shipped,delivered,completed`);
  if (rp.rows) {
    const same = sig(rp.rows) === sig(r10.rows) && rp.rows.every((r, i) => rev(r) === rev(r10.rows[i]));
    fact(`paid-only statuses vs default: ${same ? 'IDENTICAL (default already excludes, or filter ignored — see §5)' : 'DIFFER (default counts other statuses)'}`);
  }

  console.log('\n§7 one row per product (BF-089)');
  const seen = {};
  for (const r of r500.rows || []) seen[r.product_sku] = (seen[r.product_sku] || 0) + 1;
  const dupes = Object.entries(seen).filter(([, n]) => n > 1).map(([s]) => s);
  (dupes.length === 0 && (r500.rows || []).length > 0 ? pass : fail)(
    `${(r500.rows || []).length} rows, ${Object.keys(seen).length} distinct SKUs${dupes.length ? ` — split: ${dupes.join(', ')}` : ''}`);

  console.log(`\n  mode: READ-ONLY   ${fails ? `\x1b[31m${fails} FAIL\x1b[0m` : '\x1b[32m0 FAIL\x1b[0m'} — the Best Sellers tab and dashboard card rest on the checks above.\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
