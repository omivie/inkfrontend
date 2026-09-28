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
 *   §3  does sort_by=units|orders change the order, and is it echoed?
 *   §4  which fields exist per row (brand? order_count?)
 *   §5  do status/brand/category filters bite?  NEGATIVE CONTROL: an impossible
 *       value must return 0 rows, otherwise the filter is silently ignored
 *   §6  are cancelled/refunded orders counted by default?
 *   §7  is one SKU split across several rows? (BF-089)
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

  console.log('\n§3 sort_by');
  for (const s of ['units', 'orders']) {
    const r = await get(`${base}&result_limit=10&sort_by=${s}`);
    const changed = sig(r.rows) !== sig(r10.rows);
    const echo = r.meta && typeof r.meta === 'object' ? (r.meta.sort_by ?? r.meta.sortBy ?? null) : null;
    fact(`sort_by=${s}: order ${changed ? 'CHANGED' : 'unchanged'}; echo = ${JSON.stringify(echo)}`);
    if (s === 'units' && r.rows) fact(`  units-descending: ${desc(r.rows, units)}`);
  }

  console.log('\n§4 row fields');
  const keys = new Set((r500.rows || r10.rows).flatMap((r) => Object.keys(r)));
  fact(`keys: ${[...keys].sort().join(', ')}`);
  fact(`brand present: ${keys.has('brand')}; order_count present: ${keys.has('order_count') || keys.has('orders')}`);

  console.log('\n§5 filters (negative control: impossible value must give 0 rows)');
  for (const [k, v] of [['status_filter', 'zz_no_such_status'], ['brand_filter', 'zz-no-such-brand'], ['category_filter', 'zz_no_such_cat']]) {
    const r = await get(`${base}&result_limit=10&${k}=${v}`);
    fact(`${k}=${v} → HTTP ${r.status}, ${r.rows?.length ?? 'unreadable'} rows — ${r.rows?.length === 0 ? 'filter BITES' : 'filter IGNORED or rejected'}`);
  }

  console.log('\n§6 cancelled/refunded in default?');
  const rc = await get(`${base}&result_limit=10&status_filter=cancelled,refunded`);
  fact(`status_filter=cancelled,refunded → ${rc.rows?.length ?? 'unreadable'} rows (HTTP ${rc.status})`);
  const rp = await get(`${base}&result_limit=10&status_filter=paid,processing,shipped,delivered,completed`);
  if (rp.rows) {
    const same = sig(rp.rows) === sig(r10.rows) && rp.rows.every((r, i) => rev(r) === rev(r10.rows[i]));
    fact(`paid-only statuses vs default: ${same ? 'IDENTICAL (default already excludes, or filter ignored — see §5)' : 'DIFFER (default counts other statuses)'}`);
  }

  console.log('\n§7 one SKU, several rows? (BF-089 — the frontend merges by SKU until fixed)');
  const seen = {};
  for (const r of r500.rows || []) seen[r.product_sku] = (seen[r.product_sku] || 0) + 1;
  const dupes = Object.entries(seen).filter(([, n]) => n > 1).map(([s]) => s);
  fact(`${dupes.length} SKU(s) split across rows${dupes.length ? `: ${dupes.join(', ')}` : ' — BF-089 fixed; mergeBySku is now a no-op'}`);

  console.log(`\n${fails ? `\x1b[31m${fails} FAIL\x1b[0m` : '\x1b[32m0 FAIL\x1b[0m'} — facts above decide which rankings are LIVE.\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
