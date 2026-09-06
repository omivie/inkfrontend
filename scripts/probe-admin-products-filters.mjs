#!/usr/bin/env node
/**
 * probe-admin-products-filters.mjs — when the Products list falls back, what does it lose?
 * ========================================================================================
 *
 * THE INCIDENT. The admin Products list showed "Genuine" selected in the Source
 * dropdown and a full page of rows badged "Compatible", under the toast
 * "Product search fell back to the backend — results may match slightly
 * differently". Both facts are one bug: `loadProducts()` has three routes, and
 * the FALLBACK one rebuilds its filter object from scratch —
 *
 *     const filters = { search: _search, sort: _sort, order: _sortDir };
 *     if (_brandFilter) filters.brand = _brandFilter;
 *     if (_activeFilter !== '') filters.active = _activeFilter;
 *
 * — dropping `source`, `product_type`, `has_images` and `stock_status`, all four
 * of which `/api/admin/products` supports and the OTHER backend route already
 * sends. The dropdown is rendered once and never re-synced, so it keeps saying
 * "Genuine" over rows nobody filtered.
 *
 * WHAT THIS PROBE IS FOR. Two questions the repo cannot answer about itself:
 *
 *   1. WHY does the direct-Supabase leg fail? `DebugLog.warn` is a no-op off
 *      localhost (ERR-193), so the operator sees "fell back" and never the
 *      cause. §1 issues the EXACT `selectCols` string read out of the shipped
 *      products.js with a real admin JWT, and on failure bisects it column by
 *      column until it can NAME the column and the PostgREST code. Measured
 *      2026-09-06 as `anon`: every column in that list reads 200 except
 *      `cost_price`, which is 401 / 42501 (the ERR-170 revoke). Whether that
 *      revoke now reaches `authenticated` too is exactly what §1 asks.
 *
 *   2. Does the backend actually honour the filters the fix is about to send it?
 *      A fix that forwards `source=genuine` to an endpoint that ignores it is
 *      the same bug wearing a different hat. §2 asks for each filter and counts
 *      the rows that disagree with it.
 *
 * §4 measures the sourcing fields on the backend leg, because `productOrigin()`
 * reads `supplier_sku ? 'supplier_pack' : 'in_house_pack'` — on a view that does
 * not return the field at all, ABSENCE prints a confident "Assembled" badge.
 *
 * ── READ-ONLY, WITH NO WRITE PATH AT ALL ────────────────────────────────────
 * Every request is a GET besides the sign-in. There is no --record, no baseline,
 * no fixture and no write verb of any kind, and the mode is printed on every
 * run. A probe that can record is a probe that can pass because it just
 * overwrote what it was comparing against — that is how `sweep:b2b` ate a
 * committed fixture on 2026-08-12.
 *
 * Lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel output
 * directory and is served publicly.
 *
 * Usage:  npm run probe:admin-products      (needs ADMIN_EMAIL / ADMIN_PASSWORD in .env)
 *         npm run probe:admin-products -- --fast   (no inter-request pacing)
 * Exit:   0 = every check passed
 *         1 = a real finding
 *         2 = the probe could not run — deliberately NOT 1, because "we could
 *             not look" must never be reported as "we looked and it was fine".
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const FAST = ARGS.includes('--fast');

const BASE = process.env.API_BASE || 'https://ink-backend-zaeq.onrender.com';
const SUPABASE = process.env.SUPABASE_URL || 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';

const DELAY_MS = FAST ? 0 : Number(process.env.PROBE_DELAY_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const notes = [];
const ok = (name, detail) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => {
  failures.push(`${name} — ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
const soft = (name, detail) => {
  notes.push(`${name} — ${detail}`);
  console.log(`  \x1b[33m~\x1b[0m ${name}\n      ${String(detail).split('\n').join('\n      ')}`);
};
/** A check that DECLINED TO RUN says so by name. A skip is not a pass. */
const skip = (name, why) => {
  notes.push(`SKIPPED: ${name} — ${why}`);
  console.log(`  \x1b[90m⊘ SKIPPED\x1b[0m ${name}\n      ${why}`);
};

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

/**
 * The column list the page ACTUALLY ships, read out of products.js. Retyping it
 * here would mean the probe eventually measures a select nobody sends.
 */
function shippedSelectCols() {
  const f = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'products.js');
  if (!fs.existsSync(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/const selectCols = '([^']+)'/);
  return m ? m[1] : null;
}

/** Split a PostgREST select list on top-level commas (embeds carry their own). */
function splitSelect(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Pull one top-level `function name(...) { ... }` out of a source file. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/**
 * The SHIPPED paginationFrom(), so §3 can check what the page does with a
 * missing pagination block rather than only that the block is missing.
 */
function shippedPaginationFrom() {
  const f = path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'products.js');
  if (!fs.existsSync(f)) return null;
  const src = extractFunction(fs.readFileSync(f, 'utf8'), 'paginationFrom');
  if (!src) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`const _page = 1;\n${src}\nreturn paginationFrom;`)();
  } catch { return null; }
}

async function main() {
  console.log('\n\x1b[1mprobe-admin-products-filters\x1b[0m — when the Products list falls back, what does it lose?');
  console.log('\x1b[36mMODE: READ-ONLY\x1b[0m  (GET only besides the sign-in; no recording mode exists, nothing is written)\n');

  const env = readEnv();
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('\x1b[31mCANNOT RUN\x1b[0m — ADMIN_EMAIL / ADMIN_PASSWORD not set (.env or environment).');
    console.error('The Supabase leg runs as the signed-in admin; the anon role cannot stand in for it.');
    console.error('Nothing was verified. Do NOT read this as a pass.\n');
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
  let claimRole = '(unreadable)';
  try {
    claimRole = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64').toString()).role;
  } catch { /* keep the placeholder */ }
  const JWT = session.access_token;
  const SB_H = { apikey: ANON, Authorization: `Bearer ${JWT}` };
  const API_H = { Authorization: `Bearer ${JWT}` };
  console.log(`Signed in as ${email}  —  JWT role claim: \x1b[1m${claimRole}\x1b[0m`);
  console.log('\x1b[90mThis is the same role the browser sends from the admin Products page.\x1b[0m\n');

  /** PostgREST answers a ranged read with 206, not 200. Both are success. */
  const sbOk = (st) => st === 200 || st === 206;
  const sbGet = async (qs) => {
    const res = await fetch(`${SUPABASE}/rest/v1/products?${qs}`, { headers: { ...SB_H, Prefer: 'count=exact' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    await sleep(DELAY_MS);
    return { status: res.status, json, text, range: res.headers.get('content-range') };
  };
  const apiGet = async (p) => {
    const res = await fetch(BASE + p, { headers: API_H });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    await sleep(DELAY_MS);
    return { status: res.status, json, text };
  };

  // ── §1 — WHY does the direct-Supabase leg fall back? ──────────────────────
  console.log('\x1b[1m§1  The direct-Supabase leg — the one the fallback replaces\x1b[0m');
  const selectCols = shippedSelectCols();
  let supabaseLegHealthy = null;
  if (!selectCols) {
    skip('read the shipped selectCols', 'could not find `const selectCols = \'…\'` in pages/products.js — the probe would be measuring a guess');
  } else {
    const cols = splitSelect(selectCols);
    console.log(`  \x1b[90m${cols.length} columns/embeds, read from pages/products.js\x1b[0m`);
    const full = await sbGet(`select=${encodeURIComponent(selectCols)}&limit=1`);
    if (sbOk(full.status)) {
      supabaseLegHealthy = true;
      ok('the shipped select succeeds as the signed-in admin', `200, ${full.range || 'no range header'}`);
    } else {
      supabaseLegHealthy = false;
      bad('the shipped select FAILS as the signed-in admin',
        `HTTP ${full.status} ${full.json?.code || ''} ${full.json?.message || full.text.slice(0, 160)}\n`
        + 'Every load of the Products list therefore takes the fallback route, which is the one that drops filters.');
      // Bisect: name the column(s), not just the failure.
      const guilty = [];
      for (const c of cols) {
        const one = await sbGet(`select=${encodeURIComponent(c)}&limit=1`);
        if (!sbOk(one.status)) guilty.push(`${c} → ${one.status} ${one.json?.code || ''} ${one.json?.message || ''}`.trim());
      }
      if (guilty.length) {
        console.log('      \x1b[1mthe column(s) responsible:\x1b[0m');
        for (const g of guilty) console.log(`        • ${g}`);
      } else {
        console.log('      \x1b[33mno single column fails alone\x1b[0m — the fault is in the combination (an embed, or a row-level policy).');
      }
    }
  }

  // ── §2 — does the backend honour the filters the fallback must forward? ───
  console.log('\n\x1b[1m§2  /api/admin/products — does it honour each filter the fallback will now send?\x1b[0m');
  const FILTER_CHECKS = [
    { q: 'source=genuine', field: 'source', want: (v) => v === 'genuine', label: 'source=genuine' },
    { q: 'source=compatible', field: 'source', want: (v) => v === 'compatible', label: 'source=compatible' },
    { q: 'product_type=toner_cartridge', field: 'product_type', want: (v) => v === 'toner_cartridge', label: 'product_type=toner_cartridge' },
    { q: 'stock_status=in_stock', field: 'stock_status', want: (v) => v === 'in_stock', label: 'stock_status=in_stock' },
  ];
  const rowsOf = (d) => (Array.isArray(d) ? d : (d?.products || d?.data || []));
  for (const chk of FILTER_CHECKS) {
    const res = await apiGet(`/api/admin/products?limit=100&page=1&${chk.q}`);
    if (res.status !== 200) { bad(chk.label, `HTTP ${res.status} — ${res.text.slice(0, 140)}`); continue; }
    const rows = rowsOf(res.json?.data ?? res.json);
    if (!rows.length) { soft(chk.label, '0 rows came back — the filter cannot be shown to work on an empty set (see ERR-201: half the states never ran)'); continue; }
    const absent = rows.filter((r) => !(chk.field in r)).length;
    if (absent === rows.length) { soft(chk.label, `the endpoint does not return \`${chk.field}\` at all — cannot verify from the payload`); continue; }
    const wrong = rows.filter((r) => chk.field in r && !chk.want(r[chk.field]));
    if (wrong.length) {
      bad(chk.label, `${wrong.length} of ${rows.length} rows disagree (e.g. ${wrong[0].sku} = ${JSON.stringify(wrong[0][chk.field])}). Forwarding this filter would NOT fix the list.`);
    } else {
      ok(chk.label, `${rows.length}/${rows.length} rows match`);
    }
  }
  // has_images has no single field to read back; compare totals instead.
  const [imgYes, imgNo, imgAll] = [
    await apiGet('/api/admin/products?limit=1&page=1&has_images=true'),
    await apiGet('/api/admin/products?limit=1&page=1&has_images=false'),
    await apiGet('/api/admin/products?limit=1&page=1'),
  ];
  const totalOf = (r) => r.json?.data?.pagination?.total ?? r.json?.pagination?.total
    ?? r.json?.data?.total ?? r.json?.total ?? r.json?.data?.count ?? null;
  const [ty, tn, ta] = [totalOf(imgYes), totalOf(imgNo), totalOf(imgAll)];
  if (ta == null) {
    // Say what the envelope DID contain, so "could not read a total" is a lead
    // rather than a shrug.
    const env = imgAll.json?.data ?? imgAll.json;
    console.log(`      \x1b[90menvelope keys: ${env && typeof env === 'object' ? Object.keys(env).join(', ') : typeof env}`
      + `${env?.pagination ? ` | pagination: ${JSON.stringify(env.pagination)}` : ''}\x1b[0m`);
  }
  if ([ty, tn, ta].some((v) => v == null)) {
    soft('has_images', `could not read a total from the payload (has=${ty}, none=${tn}, all=${ta})`);
  } else if (ty === ta && tn === ta) {
    bad('has_images', `both arms return the full catalogue (${ta}) — the param is ignored`);
  } else {
    ok('has_images', `has=${ty}, none=${tn}, unfiltered=${ta}${ty + tn === ta ? ' (they sum)' : ' (they do NOT sum — worth a look)'}`);
  }

  // ── §3 — how big does the fallback THINK the catalogue is? ────────────────
  console.log('\n\x1b[1m§3  Paging: can the operator reach product 101 of 3,000-odd?\x1b[0m');
  const sbGenuine = await sbGet('select=id&source=eq.genuine&limit=1');
  const sbTotal = sbOk(sbGenuine.status) && sbGenuine.range ? Number(String(sbGenuine.range).split('/')[1]) : null;
  const apiGenuine = await apiGet('/api/admin/products?limit=100&page=1&source=genuine');
  const apiGenuineRows = rowsOf(apiGenuine.json?.data ?? apiGenuine.json);
  const apiTotal = totalOf(apiGenuine);
  if (apiTotal == null) {
    soft('/api/admin/products returns NO pagination block',
      `envelope carries only [${Object.keys(apiGenuine.json?.data ?? apiGenuine.json ?? {}).join(', ')}]`
      + (sbTotal != null ? `; the real figure for this filter is ${sbTotal}.` : '.')
      + ' A backend gap, not a frontend one — the check below is whether the page tells the truth about it.');
    // THE GATE: the page must not turn that absence into a number. It used to
    // substitute rows.length, so the footer read "1-100 of 100" over 3,398 rows
    // and Next went grey — 3,298 products unreachable (ERR-220).
    const paginationFrom = shippedPaginationFrom();
    if (!paginationFrom) {
      skip('the page reports an unknown total honestly', 'could not load paginationFrom() out of products.js');
    } else {
      const p = paginationFrom(apiGenuine.json?.data ?? apiGenuine.json, apiGenuineRows, 100);
      if (p && p.totalUnknown && p.total == null) {
        ok('the page reports the unknown total as unknown', `totalUnknown, hasMore=${p.hasMore}`);
      } else {
        bad('the page invents a total it was never given',
          `paginationFrom() returned total=${p && p.total} for a payload with no pagination block — `
          + `the footer will claim the catalogue is ${p && p.total} products long.`);
      }
    }
  } else if (sbTotal != null && sbTotal !== apiTotal) {
    soft('genuine totals differ', `Supabase ${sbTotal} vs backend ${apiTotal}`);
  } else {
    ok('genuine total', `${apiTotal} on the backend leg${sbTotal != null ? ` (Supabase agrees: ${sbTotal})` : ''}`);
  }

  // Does page 2 exist at all, whatever the footer believes?
  const p1 = await apiGet('/api/admin/products?limit=100&page=1');
  const p2 = await apiGet('/api/admin/products?limit=100&page=2');
  const r1 = rowsOf(p1.json?.data ?? p1.json);
  const r2 = rowsOf(p2.json?.data ?? p2.json);
  if (!r1.length || !r2.length) {
    skip('page 2', `page1=${r1.length} rows, page2=${r2.length} rows`);
  } else if (r1[0]?.sku === r2[0]?.sku) {
    bad('?page= is ignored', `page 1 and page 2 both start at ${r1[0]?.sku} — paging past the first 100 is impossible`);
  } else {
    ok('?page= works on the backend', `p1 starts ${r1[0]?.sku}, p2 starts ${r2[0]?.sku} — the rows exist, only the FOOTER cannot count them`);
  }

  // ── §4 — the sourcing fields on the fallback leg ──────────────────────────
  console.log('\n\x1b[1m§4  Sourcing fields on the backend leg (what Supplier / Origin are drawn from)\x1b[0m');
  const sample = await apiGet('/api/admin/products?limit=100&page=1');
  const sRows = rowsOf(sample.json?.data ?? sample.json);
  if (!sRows.length) {
    skip('sourcing fields', `no rows came back (HTTP ${sample.status})`);
  } else {
    for (const field of ['supplier', 'supplier_sku', 'pack_type', 'cost_price', 'source', 'origin']) {
      const present = sRows.filter((r) => field in r).length;
      const nonNull = sRows.filter((r) => r[field] != null).length;
      console.log(`  ${field.padEnd(13)} present in ${String(present).padStart(3)}/${sRows.length}   non-null in ${String(nonNull).padStart(3)}/${sRows.length}`);
    }
    const packRows = sRows.filter((r) => ['value_pack', 'multipack'].includes(String(r.pack_type || '').toLowerCase()));
    const skuPresent = packRows.filter((r) => 'supplier_sku' in r).length;
    if (packRows.length && skuPresent === 0) {
      soft('the backend list carries pack_type but no supplier_sku',
        `${packRows.length} of the first ${sRows.length} rows are packs with no supplier field of any kind. `
        + 'The page fills them from Supabase (§5); the check below is what it renders if that fails.');
      // THE GATE: an ABSENT supplier_sku must answer nothing. It used to read as
      // "no supplier code" and print a confident "Assembled" (ERR-220).
      let productOrigin = null;
      try {
        ({ productOrigin } = await import(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'utils', 'sourcing.js')));
      } catch { /* reported below */ }
      if (!productOrigin) {
        skip('Origin refuses to guess', 'could not import utils/sourcing.js');
      } else {
        const guessed = packRows.filter((r) => productOrigin(r) != null);
        if (guessed.length) {
          bad('Origin is derived from half the data',
            `${guessed.length} pack rows with no supplier_sku still resolve to `
            + `"${productOrigin(guessed[0])}" — a badge derived from a field this view never fetched.`);
        } else {
          ok('Origin refuses to guess without supplier_sku', `all ${packRows.length} unfetched pack rows resolve to the em-dash`);
        }
      }
    } else if (!packRows.length) {
      skip('Origin derivation', 'no value_pack / multipack rows in the first 100 — nothing to derive from');
    } else {
      ok('Origin derivation', `${skuPresent}/${packRows.length} pack rows carry supplier_sku, so the badge is drawn from real data`);
    }
  }

  // ── §5 — the read the fix now leans on ────────────────────────────────────
  console.log('\n\x1b[1m§5  The sourcing enrichment read (what fills Supplier / Origin on the backend leg)\x1b[0m');
  const enrich = await sbGet('select=sku,supplier,supplier_sku,pack_type&limit=5');
  if (!sbOk(enrich.status)) {
    bad('enrichSourcingFields\u2019 read is refused too',
      `HTTP ${enrich.status} ${enrich.json?.code || ''} ${enrich.json?.message || ''} — `
      + 'the Supplier column cannot be filled from anywhere, and Origin must stay an em-dash.');
  } else {
    const withSku = (enrich.json || []).filter((r) => r.supplier_sku != null).length;
    ok('the enrichment read still works as the signed-in admin',
      `HTTP ${enrich.status}, ${(enrich.json || []).length} rows, ${withSku} carrying a supplier_sku `
      + '(it names no privileged column, so the refusal in §1 does not reach it)');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1mSummary\x1b[0m — ${pass} passed, ${failures.length} finding(s), ${notes.length} note(s)`);
  if (supabaseLegHealthy === false) {
    console.log('\x1b[33mThe direct-Supabase leg is DOWN for the signed-in admin.\x1b[0m The Products list is');
    console.log('running on the fallback on every load — which is why a filter dropped there is not a rare');
    console.log('edge case but the permanent behaviour of the page.');
    console.log('');
    console.log('\x1b[1mWhich surfaces this reaches, and which it cannot:\x1b[0m');
    console.log('  BROKEN   — any admin or storefront read that goes DIRECTLY to PostgREST with the anon');
    console.log('             key or a signed-in JWT and names a privileged column. Same shape as ERR-193,');
    console.log('             where one refused direct read printed the empty-shelf copy across 63 ribbon');
    console.log('             brand pages for 44 hours with no alert.');
    console.log('  UNAFFECTED — anything going through /api/… . The backend holds its own service-role');
    console.log('             credentials, so it still serves cost to super_admin (100/100 rows above), and');
    console.log('             e.g. the Orders supplier-cost column reads supplier_cost_snapshot from');
    console.log('             GET /api/admin/orders/:id and is untouched (verified by probe:orders-supplier).');
    console.log('  \x1b[90mSo: grep for `.from(\'products\')` and a privileged column name — not for pages that');
    console.log('  look catalogue-shaped.\x1b[0m');
  }
  if (failures.length) {
    console.log('\nFindings:');
    for (const f of failures) console.log(`  • ${f}`);
  }
  if (notes.length) {
    console.log('\nNotes:');
    for (const n of notes) console.log(`  • ${n}`);
  }
  console.log('');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n\x1b[31mCANNOT RUN\x1b[0m — ${e && e.stack ? e.stack : e}`);
  console.error('Nothing was verified. Do NOT read this as a pass.\n');
  process.exit(2);
});
