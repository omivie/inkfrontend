#!/usr/bin/env node
/**
 * probe-product-supplier-streamline.mjs — ribbons are Streamline (ERR-399)
 * ========================================================================
 * Re-measures backend fe97a98 (2026-11-26) against the FE that consumes it:
 *
 *   §1  GET /api/admin/products?supplier=ribbon — every row is `ribbon`, the
 *       active + inactive total is 96, and the FE labels it "Streamline".
 *   §2  bulk-supplier PREVIEW of ribbon rows -> `ribbon`: all unchanged, and
 *       the shipped normaliser accounts for every id.
 *   §3  PREVIEW of a genuine row + a uuid that matches nothing -> refused_genuine
 *       carries the SKU, not_found = 1.
 *   §4  negative controls: bad key -> 400, empty list -> 400, 501 ids -> 400;
 *       and the normaliser flags a reply whose counts do not add up.
 *   §5  ribbon orders: line suppliers say "Streamline", consignments carry
 *       supplier_basis "product", and supplierSlug("Streamline") === "ribbon";
 *       no supplier_basis value outside the five measured on 2026-11-26.
 *
 * ── MODE: READ-ONLY. It owns its own safety. ───────────────────────────────
 * GETs, plus bulk-supplier calls that ALWAYS send `dry_run: true` AND whose
 * target supplier is the one every row in the request already has (or a
 * genuine row the server never moves, or ids that match nothing). So even a
 * server that ignored `dry_run` would change nothing. There is no
 * `dry_run:false`, no --record, no fixture. The mode is printed on every run.
 *
 * Needs ADMIN_EMAIL / ADMIN_PASSWORD (env or repo-root .env).
 *   npm run probe:supplier-streamline
 * Exit: 0 all passed · 1 a real finding · 2 could not run (never a pass).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const SUPABASE = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
const PACE = Number(process.env.PROBE_PACE_MS || 500);
const RIBBON_TOTAL = 96; // handoff: "96 products were moved in production"

console.log(`probe:supplier-streamline — MODE: READ-ONLY (GETs + bulk-supplier dry_run:true previews whose target equals the current supplier) against ${API}`);

const S = await import(path.join(ROOT, 'inkcartridges/js/admin/utils/sourcing.js'));
const B = await import(path.join(ROOT, 'inkcartridges/js/admin/utils/supplier-bulk.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, info: 0 };
const pass = (m) => { results.pass++; console.log(`  PASS  ${m}`); };
const fail = (m) => { results.fail++; console.log(`  FAIL  ${m}`); };
const info = (m) => { results.info++; console.log(`  INFO  ${m}`); };
const check = (ok, m) => (ok ? pass(m) : fail(m));
function stopped(why) {
  console.log(`\nSTOPPED ${why} — INCOMPLETE (not a pass)`);
  process.exit(2);
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

const env = readEnv();
const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
const anon = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY
  || (/SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'inkcartridges/js/config.js'), 'utf8')) || [])[1];
if (!email || !password || !anon) stopped('no ADMIN_EMAIL / ADMIN_PASSWORD — nothing measured');
const tokRes = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', apikey: anon }, body: JSON.stringify({ email, password }),
});
const TOKEN = (await tokRes.json().catch(() => ({}))).access_token;
if (!TOKEN) stopped(`admin sign-in failed (${tokRes.status})`);
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function call(method, p, body) {
  await sleep(PACE);
  const res = await fetch(`${API}${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (res.status === 429 || json?.error?.code === 'RATE_LIMITED') stopped(`${method} ${p.split('?')[0]} rate-limited`);
  return { status: res.status, json };
}
const get = (p) => call('GET', p);
/** The ONLY write-verb door. It cannot send anything but a preview. */
const preview = (ids, supplier) => call('POST', '/api/admin/products/bulk-supplier', { product_ids: ids, supplier, dry_run: true });

// §1 ─────────────────────────────────────────────────────────────────────────
console.log('\n§1 the ribbon supplier on the Products list');
const active = await get('/api/admin/products?supplier=ribbon&is_active=true&limit=200&page=1');
const inactive = await get('/api/admin/products?supplier=ribbon&is_active=false&limit=200&page=1');
if (active.status !== 200 || inactive.status !== 200) stopped(`list read failed (${active.status}/${inactive.status})`);
const rows = [...(active.json.data.products || []), ...(inactive.json.data.products || [])];
const total = (active.json.data.pagination?.total ?? NaN) + (inactive.json.data.pagination?.total ?? NaN);
check(total === RIBBON_TOTAL, `ribbon rows active+inactive = ${total} (handoff: ${RIBBON_TOTAL})`);
check(rows.length === total, `every counted row came back (${rows.length} of ${total})`);
const offKey = rows.filter((r) => r.supplier !== 'ribbon');
check(offKey.length === 0, `every row the filter returned holds supplier "ribbon" (${offKey.length} do not)`);
const genuineRibbon = rows.filter((r) => r.source === 'genuine');
check(genuineRibbon.length === 0, `no genuine product sits under ribbon (${genuineRibbon.length})`);
check(S.supplierLabel('ribbon') === 'Streamline' && /Streamline/.test(S.productSupplierCell(rows[0] || {})),
  'the shipped FE labels the key "Streamline"');
info(`ribbon product types: ${[...new Set(rows.map((r) => r.product_type))].join(', ')}`);

// §2 ─────────────────────────────────────────────────────────────────────────
console.log('\n§2 preview: ribbon rows -> ribbon (a no-op by construction)');
const ribbonIds = rows.slice(0, 5).map((r) => r.id);
const p2 = await preview(ribbonIds, 'ribbon');
check(p2.status === 200 && p2.json?.ok === true, `preview answered 200 (got ${p2.status})`);
const d2 = p2.json?.data || {};
check(d2.dry_run === true, `reply says dry_run:true (got ${JSON.stringify(d2.dry_run)})`);
check(d2.would_change === 0 && d2.unchanged === ribbonIds.length,
  `all ${ribbonIds.length} unchanged (would_change ${d2.would_change}, unchanged ${d2.unchanged})`);
const n2 = B.normaliseBulkSupplierResult(ribbonIds, [d2]);
check(n2.unaccounted === 0 && !n2.countMismatch && n2.dryRun === true, 'shipped normaliser accounts for every id');
check(typeof d2.unchanged === 'number' && typeof d2.not_found === 'number' && Array.isArray(d2.refused_genuine) && Array.isArray(d2.products),
  'shape still: unchanged/not_found counts, refused_genuine + products arrays (the FE reads exactly this)');

// §3 ─────────────────────────────────────────────────────────────────────────
console.log('\n§3 preview: a genuine row + an id that matches nothing');
const gen = await get('/api/admin/products?source=genuine&supplier=dsnz&limit=1&page=1');
const g = gen.json?.data?.products?.[0];
if (!g) stopped('no genuine dsnz product to preview against');
const GHOST = '00000000-0000-4000-8000-000000000000';
const p3 = await preview([g.id, GHOST], 'dsnz');
const d3 = p3.json?.data || {};
check(p3.status === 200 && d3.dry_run === true, `preview answered 200 dry_run:true (got ${p3.status})`);
check(Array.isArray(d3.refused_genuine) && d3.refused_genuine.includes(g.sku), `refused_genuine names ${g.sku} (${JSON.stringify(d3.refused_genuine)})`);
check(d3.not_found === 1, `not_found = 1 for the ghost id (got ${d3.not_found})`);
const n3 = B.normaliseBulkSupplierResult([g.id, GHOST], [d3]);
check(n3.unaccounted === 0, `shipped normaliser accounts for both ids (unaccounted ${n3.unaccounted})`);

// §4 ─────────────────────────────────────────────────────────────────────────
console.log('\n§4 negative controls');
const bad = await preview([g.id], 'Bad-Key');
check(bad.status === 400 && bad.json?.error?.code === 'VALIDATION_FAILED', `bad key refused 400 VALIDATION_FAILED (got ${bad.status})`);
check(!S.SUPPLIER_KEY_RE.test('Bad-Key'), 'FE key rule refuses it before a request too');
const empty = await preview([], 'ribbon');
check(empty.status === 400, `empty id list refused (got ${empty.status})`);
const many = await preview(Array.from({ length: 501 }, () => crypto.randomUUID()), 'ribbon');
check(many.status === 400 && /500/.test(JSON.stringify(many.json?.error)), `501 well-formed ids refused for the 500 cap (got ${many.status} ${JSON.stringify(many.json?.error?.details?.[0]?.message)})`);
const broken = B.normaliseBulkSupplierResult(['a', 'b', 'c'], [{ dry_run: true, would_change: 0, unchanged: 1, not_found: 0, refused_genuine: [], products: [] }]);
check(broken.unaccounted === 2, `[CONTROL] the normaliser flags counts that do not add up (unaccounted ${broken.unaccounted})`);

// §5 ─────────────────────────────────────────────────────────────────────────
console.log('\n§5 orders say Streamline');
check(S.supplierSlug('Streamline') === 'ribbon', 'supplierSlug("Streamline") === "ribbon"');
let seen = 0;
const bases = new Set();
for (let page = 1; page <= 3 && seen < 3; page++) {
  const list = await get(`/api/admin/orders?limit=50&page=${page}`);
  if (list.status !== 200) stopped(`orders list read failed (${list.status})`);
  const d = list.json?.data;
  const orders = Array.isArray(d) ? d : (d?.orders || []);
  if (!orders.length) stopped(`orders page ${page} came back empty or in an unknown shape`);
  for (const o of orders) {
    const cons = o?.supplier_freight?.consignments || [];
    for (const c of cons) bases.add(String(c.supplier_basis));
    const streamline = cons.filter((c) => c.supplier === 'Streamline');
    if (!streamline.length || seen >= 3) continue;
    seen++;
    check(streamline.every((c) => c.supplier_basis === 'product'), `order ${o.order_number}: Streamline consignment supplier_basis "product"`);
    check(streamline.every((c) => Number(c.free_threshold_incl_gst) === 100), `order ${o.order_number}: Streamline free threshold $100 incl GST (Augmento terms)`);
    const detail = await get(`/api/admin/orders/${o.id}`);
    const items = (detail.json?.data?.order || detail.json?.data)?.items || [];
    const names = items.flatMap((i) => (i.suppliers || []).map((x) => x.name));
    check(names.includes('Streamline') && !names.includes('Ribbon'), `order ${o.order_number}: line suppliers ${JSON.stringify([...new Set(names)])}`);
  }
}
if (!seen) fail('no order with a Streamline consignment in the latest 150 — the backend reassignment did not reach orders');
// The handoff documents snapshot / fulfillment / product. Live also carries
// `default` (in-house COMPATIBLE packs -> Augmento, e.g. 2026112602 CTN259CMY)
// and `source_rule` (in-house GENUINE packs -> DSNZ, e.g. INV-3297), measured
// 2026-11-26 over 300 orders; asked of the backend in outbox §8. The FE renders
// no basis label, so these are a drift watch: a NEW value fails.
const KNOWN_BASES = ['snapshot', 'fulfillment', 'product', 'default', 'source_rule', 'undefined', 'null'];
const unknownBases = [...bases].filter((b) => !KNOWN_BASES.includes(b));
check(unknownBases.length === 0, `consignment supplier_basis values are all known (${[...bases].join(', ')})`);

console.log(`\n# ${results.pass} passed, ${results.fail} failed, ${results.info} info`);
process.exit(results.fail ? 1 : 0);
