#!/usr/bin/env node
/**
 * probe-bundle-response-sep2026.mjs — does production still match what we built on? (ERR-286)
 * ==========================================================================================
 *
 * The backend answered all 42 documents of backend-asks-2026-09-20.md in
 * backend-docs/inbox/backend-asks-42-doc-bundle-response-sep2026.md (dated
 * 2026-09-21, deployed as commit 372f740). The frontend changed in step with it
 * on 2026-09-25. Every one of those changes rests on a fact MEASURED in
 * production, not read off their document — and this probe is those
 * measurements, re-runnable, so the day one of them stops being true we hear
 * about it from a red line instead of from a shopper.
 *
 * What would be invisibly wrong without it:
 *   §2  /api/admin/products went `strictQuery`. An unknown param, or a value
 *       outside an enum, is a 400 — and AdminAPI.getProducts turns a 400 into
 *       an EMPTY TABLE. Four column sorts did exactly that on 2026-09-25. The
 *       sort list is read out of the shipped products.js (backendCanSort), not
 *       retyped here, so the probe measures what the page actually sends.
 *       `brand` takes a SLUG or a brand ID since 2026-09-25 (BF-070 c); a
 *       name or a comma list is 400 UNKNOWN_BRAND. Checked with the SAME brand
 *       both ways (counts must match) plus both refusals. The server product
 *       export is RETIRED (type=products → 400); the page builds CSV itself.
 *   §3  the image audit's split, and that "Recoverable only" + pending is the
 *       true recoverable set (recoverable_only alone includes the 730-row
 *       watermark hold). `status=watermark_hold` is accepted (BF-070 d). The
 *       image-audit `brand` resolves a SLUG only — a UUID is 404, which is why
 *       the page's dropdown sends slugs.
 *   §4  the order detail carries the delete contract + invoice_sent the modal
 *       now reads FIRST; invoice rows carry the portal link. The invoice list
 *       is strictQuery (negative control), `linked=true|false` partitions it,
 *       and every sort invoices.js offers is accepted (BF-070 g). Import status
 *       returns ≤5 runs per feed with `dry_run` (BF-070 h); failures PRINTED.
 *   §5  public: past_the_end (with a real total on /api/ribbons, BF-070 a), the
 *       series shard, the homepage count <= the claimable count the backend
 *       publishes for exactly that assertion.
 *   §6  BF-027 tripwire: where the FE yield DETECTOR (run with the backend
 *       field stripped) reads a higher tier than the backend sends. 3 on
 *       2026-09-25, 0 on 2026-09-28 net of G288BXLCMY — which the backend keeps
 *       STD on purpose (a 288XL black + STANDARD C/M/Y, backend §2 e). utils.js
 *       dropped its max() merge at that 0 and now trusts the backend, so a new
 *       disagreement here is a row the storefront would MERGE into the wrong
 *       yield row. It is a failure, not a note.
 *
 * ── READ-ONLY. EVERY REQUEST IS A GET (plus the admin sign-in). ─────────────
 * There is no --write, no --record and no fixture. Deliberately NOT exercised:
 * POST /api/admin/feed-files/product-list (overwrites the stored price list),
 * POST /api/admin/import/supplier-price-list (rewrites supplier_offers),
 * restore-legacy (puts an image live). No /api/search/* call is made, so no
 * search_analytics row is written (ERR-254/271).
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is served publicly.
 *
 * Usage:  npm run probe:bundle-response              (admin checks need ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:bundle-response -- --public  (skip the admin sections, SAID as skipped)
 * Exit:   0 = every check passed
 *         1 = a real finding
 *         2 = could not run — "we could not look" is never "we looked and it was fine"
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ARGS = process.argv.slice(2);
const PUBLIC_ONLY = ARGS.includes('--public');

const API = process.env.API_BASE || 'https://ink-backend-sg.onrender.com';
const SITE = 'https://www.inkcartridges.co.nz';
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const DELAY_MS = Number(process.env.PROBE_DELAY_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const skip = (n, why) => { notes.push(`SKIPPED: ${n} — ${why}`); console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${n}\n      ${why}`); };
const check = (cond, n, d) => (cond ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/**
 * GET only. Origin set like the browser; no Content-Type on a bodyless GET (ERR-282).
 *
 * A 429 is WAITED OUT (retry-after, up to 3 times), never returned as data.
 * The origin allows 100 requests / 60 s per IP across every endpoint, and this
 * probe makes ~60 before §6 pages the whole catalogue. On 2026-09-28 a run hit
 * the limit: §6 stopped paging at 1,799 of 4,114 and still passed, and
 * /api/site/trust read as "catalog_claimable_count absent". Both were 429s.
 * ***A probe that reads a 429 as missing data measures its own request rate***
 * (ERR-243, ERR-291). A 429 that outlasts the retries is returned AS a 429, and
 * every caller below checks the status before it reads a field.
 */
async function get(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Origin: SITE, ...headers } });
    const text = await res.text();
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(65, Number(res.headers.get('retry-after')) || 20);
      console.log(`  \x1b[90m… 429 on ${url.replace(API, '')} — waiting ${wait}s (rate limit, not data)\x1b[0m`);
      await sleep(wait * 1000);
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    await sleep(DELAY_MS);
    return { status: res.status, json, text, headers: res.headers };
  }
}

function readEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return {};
  return Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
}

/** The sort keys the SHIPPED page will send — read from products.js, never retyped. */
function shippedBackendSorts() {
  const src = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/products.js'), 'utf8');
  const m = src.match(/function backendCanSort\(key\) \{\s*return \[([\s\S]*?)\]\.includes\(key\);/);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
}

console.log('─'.repeat(78));
console.log('probe:bundle-response — MODE: READ-ONLY (GET only, plus the admin sign-in)');
console.log(`api: ${API}   site: ${SITE}`);
console.log('No /api/search call is made — this probe writes no search_analytics row.');
console.log('─'.repeat(78));

// ── §1 which build are we measuring? ───────────────────────────────────────
section('§1 the deployed backend');
{
  const r = await get(`${API}/health`);
  if (r.status !== 200 || !r.json?.data) {
    console.error(`\x1b[31mCANNOT RUN\x1b[0m — /health answered HTTP ${r.status}. Nothing was verified.\n`);
    process.exit(2);
  }
  const d = r.json.data;
  ok(`commit ${String(d.commit || '?').slice(0, 7)}`, `db ${d.db}, catalog ${d.catalog}`);
  check(d.catalog === 'readable', '/health probes the catalogue read path (the 09-17 outage was invisible to it)',
    `catalog = ${JSON.stringify(d.catalog)}`);
}

// ── §2 admin products under strictQuery ────────────────────────────────────
let H = null;
if (PUBLIC_ONLY) {
  skip('§2–§4 admin checks', '--public was passed. The admin half is NOT verified by this run.');
} else {
  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
    console.error('Run with --public to check only the public half, SAID as partial.\n');
    process.exit(2);
  }
  const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await auth.json();
  if (!session.access_token) {
    console.error(`\x1b[31mCANNOT RUN\x1b[0m — admin sign-in failed (HTTP ${auth.status}). Nothing was verified.\n`);
    process.exit(2);
  }
  H = { Authorization: `Bearer ${session.access_token}` };
}

if (H) {
  section('§2 /api/admin/products — every value the page sends must be accepted');
  // A param may appear ONCE: `limit=5&limit=200` is an array to the backend
  // and a 400 — so a caller's own limit replaces the default, never joins it.
  const P = (qs = '') => get(`${API}/api/admin/products?page=1${/(^|&)limit=/.test(qs) ? '' : '&limit=5'}${qs ? `&${qs}` : ''}`, H);
  {
    // NEGATIVE CONTROL. If an unknown param is NOT refused, every "accepted"
    // below proves nothing — the endpoint would be accepting everything.
    const neg = await P('zz_probe_unknown=1');
    check(neg.status === 400, 'negative control: an unknown param is a 400 (strictQuery is on)',
      `HTTP ${neg.status} — strictQuery is off; the accept checks below would be vacuous`);
  }
  const sorts = shippedBackendSorts();
  if (!sorts) bad('read backendCanSort() from products.js', 'the list could not be parsed — the probe would test a replica');
  else {
    const refused = [];
    for (const key of sorts) {
      const r = await P(`sort=${key}&order=desc`);
      if (r.status !== 200) refused.push(`${key} → ${r.status}`);
    }
    check(!refused.length, `all ${sorts.length} sorts products.js sends are accepted`,
      `refused: ${refused.join(', ')} — each one renders an EMPTY Products table`);
    for (const col of ['brand', 'supplier', 'is_active', 'import_locked']) {
      const r = await P(`sort=${col}`);
      if (r.status === 200) soft(`sort=${col} is accepted now`, 'products.js can add it to backendCanSort()');
    }
  }
  for (const [qs, why] of [
    ['is_active=all', '"All statuses" — absence means ACTIVE ONLY'],
    ['pack_type=packs', 'Pack filter: packs'], ['pack_type=single', "Pack filter: singles (our 'singles' 400s)"],
    ['supplier=dsnz', 'Supplier filter'], ['product_type_group=ribbons', 'the grouped type'],
    ['limit=200', 'the export page size'],
  ]) {
    const r = await P(qs);
    check(r.status === 200, `${qs} accepted`, `HTTP ${r.status} (${why}) — ${String(JSON.stringify(r.json?.error?.details || r.json?.error)).slice(0, 200)}`);
  }
  {
    const all = await P('is_active=all');
    const def = await P('');
    const a = all.json?.data?.pagination?.total;
    const d = def.json?.data?.pagination?.total;
    if (Number.isFinite(a) && Number.isFinite(d)) {
      if (a > d) ok(`no is_active = ACTIVE ONLY (${d} of ${a}) — the page must send is_active=all`, 'it does');
      else soft('is_active default changed', `default ${d}, all ${a} — backendProductFilters() may not need 'all' any more`);
    } else bad('pagination totals', 'data.pagination.total missing — BF-045 regressed, the footer prints "of many" again');
  }
  {
    // brand takes ONE slug or ONE id (BF-070 c). The same brand both ways must
    // answer the same total; a name and a comma list are refused, not ignored.
    const brands = await get(`${API}/api/admin/brands`, H);
    const list = brands.json?.data?.brands || brands.json?.data || [];
    const hpRow = (Array.isArray(list) ? list : []).find((b) => b && b.slug === 'hp');
    const unf = (await P('')).json?.data?.pagination?.total;
    const bySlug = (await P('brand=hp')).json?.data?.pagination?.total;
    const byId = hpRow ? (await P(`brand=${hpRow.id}`)).json?.data?.pagination?.total : undefined;
    if (!hpRow) bad('brand id', '/api/admin/brands has no hp row — cannot test brand=<id>');
    else check(Number.isFinite(bySlug) && bySlug === byId && bySlug < unf,
      `brand=<hp id> filters exactly like brand=hp (${byId} = ${bySlug} of ${unf}) — products.js sends the id`,
      `id ${byId} vs slug ${bySlug} vs unfiltered ${unf} — a UUID is being ignored again (the pre-2026-09-25 bug)`);
    for (const v of ['HP', 'hp,canon']) {
      const r = await P(`brand=${encodeURIComponent(v)}`);
      const code = r.json?.error?.code || r.json?.code;
      check(r.status === 400 && code === 'UNKNOWN_BRAND', `brand=${v} is 400 UNKNOWN_BRAND, not the whole catalogue`,
        `HTTP ${r.status} ${code || ''} — a refused brand must never answer every row`);
    }
    const rv = await P('is_reviewed=false&brand=hp');
    check(rv.status === 200, 'Product Review sends is_reviewed=false + a brand slug — accepted', `HTTP ${rv.status}`);
    const hp = await P('brand=hp&limit=50');
    const rows = hp.json?.data?.products || [];
    const off = rows.filter((r) => String(r.brand_name || r.brand || '').toLowerCase() !== 'hp');
    check(rows.length && !off.length, `brand=hp filters (${rows.length} rows, all HP)`,
      `${off.length} non-HP rows — the slug no longer filters`);
    const row = rows[0] || {};
    for (const k of ['supplier', 'supplier_sku', 'admin_only']) {
      check(k in row, `rows carry \`${k}\` (BF-044a)`, `absent — Supplier/Origin fall back to enrichSourcingFields()`);
    }
  }
  {
    // RETIRED 2026-09-25 (BF-070 b): type=products is a 400. The page's
    // client-side CSV is the only product export. A 200 here means it came back.
    const g = await get(`${API}/api/admin/export/products?format=csv`, H);
    check(g.status === 400, '/api/admin/export/products is retired (400)',
      `HTTP ${g.status} — the route is back; re-measure its filters before anything points at it`);
  }

  section('§3 image audit — the split, and "Recoverable only"');
  {
    const st = await get(`${API}/api/admin/image-audit/stats`, H);
    const b = st.json?.data?.missing_image_breakdown;
    check(b && ['recoverable', 'never_had_one', 'watermark_hold'].every((k) => Number.isFinite(b[k])),
      `stats split: ${b ? `${b.recoverable} recoverable · ${b.watermark_hold} watermark hold · ${b.never_had_one} never had one` : 'absent'}`,
      'missing_image_breakdown is absent or partial — the KPI card hides itself (absent is not zero)');
    if (b) {
      const rec = await get(`${API}/api/admin/image-audit/list?page=1&limit=1&recoverable_only=true&status=pending`, H);
      const t = rec.json?.meta?.total ?? rec.json?.data?.pagination?.total;
      check(t === b.recoverable, `recoverable_only + status=pending = the true recoverable set (${t})`,
        `list says ${t}, stats says ${b.recoverable} — "Recoverable only" would include or drop rows`);
      const hold = await get(`${API}/api/admin/image-audit/list?page=1&limit=1&status=watermark_hold`, H);
      const ht = hold.json?.meta?.total ?? hold.json?.data?.pagination?.total;
      check(hold.status === 200 && Number.isFinite(ht) && ht > 0, `status=watermark_hold is accepted (${ht} rows) — the Status dropdown offers it`,
        `HTTP ${hold.status} — the page's "Watermark hold" choice would show an error`);
      const bySlug = await get(`${API}/api/admin/image-audit/list?page=1&limit=1&brand=hp`, H);
      const byId = await get(`${API}/api/admin/image-audit/list?page=1&limit=1&brand=ab434033-68c9-4c6a-94d7-3525a42074c5`, H);
      check(bySlug.status === 200, 'image-audit brand=hp (a slug) filters', `HTTP ${bySlug.status} — the page's brand dropdown sends slugs`);
      if (byId.status === 200) soft('image-audit brand=<uuid> is accepted now', 'the dropdown could send ids like /api/admin/products; slugs still work');
      else ok(`image-audit brand=<uuid> → ${byId.status}`, 'so the dropdown sends the slug (it sent the UUID until 2026-09-28 and the grid read "All clean")');
    }
  }

  section('§4 order detail + invoices + supplier mappings');
  {
    const list = await get(`${API}/api/admin/orders?page=1&limit=1`, H);
    const o = (Array.isArray(list.json?.data) ? list.json.data : (list.json?.data?.orders || []))[0];
    if (!o) bad('an order to read', `list answered HTTP ${list.status} with no rows`);
    else {
      const d = await get(`${API}/api/admin/orders/${encodeURIComponent(o.id)}`, H);
      const ord = d.json?.data?.order || d.json?.data || {};
      const missing = ['deletable', 'delete_method', 'delete_blocked_reason', 'invoice_sent', 'loyalty_discount_amount']
        .filter((k) => !Object.prototype.hasOwnProperty.call(ord, k));
      check(!missing.length, 'order detail carries the 5 fields the modal reads detail-first',
        `absent: ${missing.join(', ')} — the modal falls back to the list row for these`);
    }
    const inv = await get(`${API}/api/admin/invoices?page=1&limit=5`, H);
    const rows = inv.json?.data?.invoices || [];
    check(rows.length && rows.every((r) => 'business_account_id' in r && 'business_account_name' in r),
      `invoice rows carry the portal link (${rows.length} checked)`, 'absent — the Portal column renders "—" (unknown)');
    // strictQuery since 2026-09-25 — the negative control first, or every
    // "accepted" below proves nothing.
    const I = (qs) => get(`${API}/api/admin/invoices?page=1&limit=1${qs ? `&${qs}` : ''}`, H);
    const itot = (r) => r.json?.data?.pagination?.total;
    const neg = await I('zz_probe_unknown=1');
    check(neg.status === 400, 'negative control: /api/admin/invoices refuses an unknown param (strictQuery)',
      `HTTP ${neg.status} — the accept checks below would be vacuous`);
    const [all, yes, no] = [await I(''), await I('linked=true'), await I('linked=false')];
    check([all, yes, no].every((r) => Number.isFinite(itot(r))) && itot(yes) + itot(no) === itot(all),
      `linked=true (${itot(yes)}) + linked=false (${itot(no)}) = all (${itot(all)}) — the Portal filter is the server's`,
      `true ${itot(yes)} + false ${itot(no)} ≠ ${itot(all)} — a row is in neither or both`);
    const invSrc = fs.readFileSync(path.join(ROOT, 'inkcartridges/js/admin/pages/invoices.js'), 'utf8');
    const cols = invSrc.slice(invSrc.indexOf('const COLUMNS = ['));
    const sortKeys = [...cols.slice(0, cols.indexOf('\n];')).matchAll(/\{ key: '([a-z_]+)'[^\n]*sortable: true/g)].map((x) => x[1]);
    if (!sortKeys.length) bad('read invoices.js sortable columns', 'none parsed — the probe would test a replica');
    for (const k of sortKeys) {
      const r = await I(`sort=${k}&order=desc`);
      check(r.status === 200, `invoice sort=${k} accepted`, `HTTP ${r.status} — clicking that column header would blank the list`);
    }
    const is = await get(`${API}/api/admin/supplier/import-status`, H);
    for (const feed of ['genuine', 'compatible']) {
      const f = is.json?.data?.[feed];
      const runs = f?.recent_runs;
      if (!f || !Array.isArray(runs)) { bad(`import-status ${feed}`, `HTTP ${is.status}, no recent_runs — Site Health → Infra shows "No import run on record"`); continue; }
      const failed = runs.filter((r) => r.status === 'failed');
      check(runs.length <= 5 && runs.every((r) => 'dry_run' in r) && f.latest,
        `import-status ${feed}: ${runs.length} runs, latest ${f.latest?.status}${f.latest?.dry_run ? ' (DRY RUN)' : ''}`,
        'shape changed — utils/importStatus.js reads latest + recent_runs[].dry_run');
      if (failed.length) soft(`${feed} feed: ${failed.length} of the last ${runs.length} runs FAILED`,
        failed.map((r) => (r.started_at || '').slice(0, 10)).join(', ') + ' — Site Health → Infra flags it; a supplier/backend question, not a FE bug');
    }
    const m = await get(`${API}/api/admin/supplier-offers/mappings?page=1&limit=1`, H);
    check(m.status === 200 && Array.isArray(m.json?.data?.mappings), 'GET /supplier-offers/mappings answers a list',
      `HTTP ${m.status} — the Manual mappings panel shows a failed read`);
    const ff = await get(`${API}/api/admin/feed-files`, H);
    check(ff.status === 200, 'GET /api/admin/feed-files is open to an owner token (Ask 5)',
      `HTTP ${ff.status} — the upload/import panel will fail; the cron gate may be back`);
  }
}

// ── §5 public ──────────────────────────────────────────────────────────────
section('§5 public surfaces');
{
  const p = await get(`${API}/api/products?limit=200&page=40`);
  check(p.json?.meta?.past_the_end === true && Number.isFinite(p.json?.meta?.total),
    `/api/products past the end says so, with the real total (${p.json?.meta?.total})`,
    `meta = ${JSON.stringify(p.json?.meta)}`);
  const r = await get(`${API}/api/ribbons?limit=200&page=2`);
  check(r.json?.meta?.past_the_end === true && Number.isFinite(r.json?.meta?.total),
    `/api/ribbons past the end says so, with the real total (${r.json?.meta?.total}) — BF-070 a`,
    `meta = ${JSON.stringify(r.json?.meta)} — total: null came back`);
  const t = await get(`${API}/api/ribbons?type=bogus_zzz`);
  check(t.status === 400, '/api/ribbons refuses an unknown type (it used to return all 109)', `HTTP ${t.status}`);
  const slug = await get(`${API}/api/products/by-slug/zzz-no-such-slug-probe`);
  check(slug.status === 404, 'by-slug 404s an impossible slug (it 500\'d for every slug)', `HTTP ${slug.status}`);
  const trust = await get(`${API}/api/site/trust`);
  const claimable = trust.status === 200 ? trust.json?.data?.stats?.catalog_claimable_count : undefined;
  if (trust.status !== 200) bad('/api/site/trust', `HTTP ${trust.status} — could not read the claimable count (not "absent")`);
  const home = await get(`${SITE}/`, { 'User-Agent': GOOGLEBOT });
  const claims = [...home.text.matchAll(/(\d[\d,]*)\+ ink cartridges/gi)].map((m) => Number(m[1].replace(/,/g, '')));
  if (trust.status !== 200) { /* reported above */ }
  else if (!Number.isFinite(claimable)) bad('catalog_claimable_count', 'absent from /api/site/trust');
  else if (!claims.length) soft('homepage count claim', 'no "N+ ink cartridges" phrase found in the prerender — nothing to compare');
  else check(claims.every((c) => c <= claimable), `homepage claims ${Math.max(...claims)}+ ≤ ${claimable} claimable`,
    `the homepage claims ${Math.max(...claims)}+ but only ${claimable} are claimable — an over-claim`);
  const sm = await get(`${SITE}/sitemap-series.xml`, { 'User-Agent': GOOGLEBOT });
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].length;
  check(sm.status === 200 && locs > 0, `sitemap-series.xml lists ${locs} chip pages`, `HTTP ${sm.status}, ${locs} <loc>`);
}

// ── §6 BF-027 — is the yield-tier merge inert yet? ─────────────────────────
section('§6 BF-027 — where the FE yield detector still RAISES the backend tier');
{
  const { ProductSort } = require(path.join(ROOT, 'inkcartridges/js/utils.js'));
  const tierOf = (yt) => ({ XXL: 2, XL: 1, STD: 0 })[String(yt || '').toUpperCase()] ?? -1;
  const all = [];
  let expected = null;
  let readError = null;
  for (let page = 1; page <= 30; page++) {
    const r = await get(`${API}/api/products?limit=200&page=${page}`);
    if (r.status !== 200) { readError = `page ${page} → HTTP ${r.status}`; break; }
    all.push(...(r.json?.data?.products || []));
    if (Number.isFinite(r.json?.meta?.total)) expected = r.json.meta.total;
    if (!r.json?.meta?.has_next) break;
  }
  // A partial read proves nothing about the rows it did not read.
  // BF-079 (measured 2026-09-28): with limit ≥ 100 two value packs, G252VPVP and
  // G728300MLCMY, are dropped from their page AFTER the slice (pages 17 and 26 at
  // limit=100 return 99 rows) while `meta.total` still counts them; at limit=10
  // both are present. So a full read at limit=200 is 2 short of `total` until
  // the backend fixes it. That is reported as its OWN failure, never absorbed.
  if (readError || expected == null) {
    bad('§6 read the whole catalogue', `${all.length} of ${expected ?? '?'} products${readError ? ` (${readError})` : ''} — the comparison below is over a partial set`);
  } else if (all.length !== expected) {
    bad('/api/products pages add up to meta.total (BF-079)', `${all.length} rows read, total says ${expected} — rows are dropped after the page slice (2026-09-28: G252VPVP, G728300MLCMY at limit ≥ 100)`);
  }
  // G288BXLCMY: a 288XL black + STANDARD C/M/Y mixed pack. The backend keeps
  // it STD on purpose (2026-09-25 §2 e) — our detector reads "BXL" and raises
  // it. That is a disagreement about the data, not a gap in their rules.
  const EXEMPT = new Set(['G288BXLCMY']);
  // The DETECTOR's reading, with the backend field stripped — yieldTier() itself
  // returns the backend tier now, so asking it would compare a value to itself
  // and could never fail (ERR-258).
  const detectorTier = (p) => ProductSort.yieldTier({ ...p, yield_tier: undefined });
  const absent = all.filter((p) => tierOf(p.yield_tier) < 0).length;
  const higher = all.filter((p) => tierOf(p.yield_tier) >= 0 && detectorTier(p) > tierOf(p.yield_tier));
  const raised = higher.filter((p) => !EXEMPT.has(p.sku));
  const exempt = higher.filter((p) => EXEMPT.has(p.sku));
  if (!all.length) bad('catalogue read', '0 products — §6 measured nothing');
  if (absent) soft(`${absent} products carry no yield_tier`, 'the detector stands alone for those');
  if (exempt.length) ok(`exempt: ${exempt.map((p) => p.sku).join(', ')} — detector says higher, backend keeps STD on purpose (mixed-capacity pack)`);
  check(all.length && !raised.length, `backend yield_tier ≥ the detector on all ${all.length} products (net of the exemption)`,
    `${raised.length} rows where the name says a higher yield than the backend sends: ${raised.map((p) => `${p.sku} (backend ${p.yield_tier})`).join(', ')} — utils.js trusts the backend, so these merge into the wrong yield row. BF-027 regression? Report it; do not re-add max().`);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(78));
console.log(`  mode: READ-ONLY${PUBLIC_ONLY ? ' (--public: admin half NOT checked)' : ''}   passed: ${pass}   failed: ${failures.length}   notes: ${notes.length}`);
if (notes.length) { console.log('\n  Notes (not failures):'); notes.forEach((n) => console.log(`    ~ ${n}`)); }
if (failures.length) {
  console.log('\n\x1b[31m  FAILURES\x1b[0m');
  failures.forEach((f) => console.log(`    ✗ ${f}`));
  process.exit(1);
}
console.log('\n\x1b[32m  OK\x1b[0m — production still matches what the frontend was built on.\n');
