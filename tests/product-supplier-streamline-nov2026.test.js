/**
 * ERR-399 — Ribbons are Streamline (backend fe97a98, 2026-11-26).
 *
 * The backend moved 96 ribbon products to `products.supplier = 'ribbon'`,
 * printed as "Streamline" on order lines and freight consignments, and shipped
 * POST /api/admin/products/bulk-supplier (previews unless `dry_run:false`).
 * Handoff: backend-docs/inbox/product-supplier-streamline-FE-handoff-nov2026.md
 *
 * Wire shapes below are the ones MEASURED live on 2026-11-26 (dry-run no-ops
 * only; `npm run probe:supplier-streamline` re-measures them, READ-ONLY).
 *
 * Run: node --test tests/product-supplier-streamline-nov2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges/js/admin');
const PRODUCTS = stripComments(fs.readFileSync(path.join(ADMIN, 'pages/products.js'), 'utf8'));
const API_SRC = fs.readFileSync(path.join(ADMIN, 'api.js'), 'utf8');

let S; let B;
test.before(async () => {
  S = await import(path.join(ADMIN, 'utils/sourcing.js'));
  B = await import(path.join(ADMIN, 'utils/supplier-bulk.js'));
});

// ── 1. Vocabulary ────────────────────────────────────────────────────────────

test('ribbon is labelled Streamline everywhere the shared vocabulary reaches', () => {
  assert.equal(S.supplierLabel('ribbon'), 'Streamline');
  const cell = S.productSupplierCell({ supplier: 'ribbon' });
  assert.match(cell, />Streamline</);
  assert.doesNotMatch(cell, /not in the known supplier list/, 'a known key must not be flagged as a guess');
  assert.match(S.supplierFilterOptions('ribbon'), /<option value="ribbon" selected>Streamline<\/option>/);
});

test('every order-line NAME reduces to the products KEY (Streamline -> ribbon)', () => {
  for (const [key, label] of Object.entries(S.SUPPLIER_LABELS)) {
    assert.equal(S.supplierSlug(label), key, `${label} must round-trip to ${key}`);
    assert.equal(S.supplierSlug(key), key, `${key} must stay ${key}`);
    assert.equal(S.supplierLabel(S.supplierSlug(label)), label);
  }
  assert.equal(S.supplierSlug(' streamline '), 'ribbon');
  // [CONTROL] the old rule still holds for names that ARE their lowercased key.
  assert.equal(S.supplierSlug('Okin'), 'okin');
  assert.equal(S.supplierSlug('unknown'), null);
});

test('stored `unknown` reads "Unassigned"; a field the view never loaded stays the loud em-dash', () => {
  const assigned = S.productSupplierCell({ supplier: 'unknown' });
  assert.match(assigned, />Unassigned</);
  assert.match(assigned, /admin-text-muted/);
  const absent = S.productSupplierCell({});
  assert.match(absent, />—</);
  assert.doesNotMatch(absent, /Unassigned/, 'absence must never be presented as an assignment');
  // supplierLabel's contract is unchanged: unknown is not a supplier name.
  assert.equal(S.supplierLabel('unknown'), null);
});

test('the supplier key rule matches the backend validator', () => {
  for (const ok of ['ribbon', 'dsnz', 'consumables_co_nz', 'x1']) assert.ok(S.SUPPLIER_KEY_RE.test(ok), ok);
  for (const bad of ['Bad-Key', 'Streamline', '', 'a b', 'ribbon;drop']) assert.ok(!S.SUPPLIER_KEY_RE.test(bad), bad);
});

// ── 2. normaliseBulkSupplierResult — live shapes ────────────────────────────

const LIVE_NOOP = { dry_run: true, would_change: 0, supplier: 'ribbon', requested: 3, not_found: 0, unchanged: 3, refused_genuine: [], products: [] };
const LIVE_GENUINE = { dry_run: true, would_change: 0, supplier: 'dsnz', requested: 2, not_found: 1, unchanged: 0, refused_genuine: ['G-OKI-720-RIB-BK'], products: [] };
const LIVE_CHANGE = {
  dry_run: true, would_change: 1, supplier: 'augmento', requested: 1, not_found: 0, unchanged: 0, refused_genuine: [],
  products: [{ id: 'bbd46f7c-1471-4b11-b409-e9af128c0693', sku: 'C314LOT', name: '314LOT Olivetti Compatible Correction Ribbon Tape', product_type: 'correction_tape', from: 'ribbon', to: 'augmento' }],
};

test('live preview shapes land in exactly one bucket each', () => {
  const noop = B.normaliseBulkSupplierResult(['a', 'b', 'c'], [LIVE_NOOP]);
  assert.deepEqual([noop.dryRun, noop.changeCount, noop.unchangedCount, noop.unaccounted], [true, 0, 3, 0]);

  const gen = B.normaliseBulkSupplierResult(['g', 'missing'], [LIVE_GENUINE]);
  assert.deepEqual(gen.refusedGenuine, ['G-OKI-720-RIB-BK']);
  assert.equal(gen.notFoundCount, 1);
  assert.equal(gen.unaccounted, 0);

  const ch = B.normaliseBulkSupplierResult(['bbd46f7c-1471-4b11-b409-e9af128c0693'], [LIVE_CHANGE]);
  assert.equal(ch.changeCount, 1);
  assert.deepEqual(ch.changes[0], LIVE_CHANGE.products[0]);
  assert.equal(ch.supplier, 'augmento');
  assert.equal(ch.countMismatch, false);
});

test('an applied reply (`changed`, dry_run:false) is read as applied; chunks add up', () => {
  const applied = { ...LIVE_CHANGE, dry_run: false, would_change: undefined, changed: 1 };
  const r = B.normaliseBulkSupplierResult(['x', 'a', 'b', 'c'], [applied, { ...LIVE_NOOP, dry_run: false }]);
  assert.equal(r.dryRun, false);
  assert.equal(r.changeCount, 1);
  assert.equal(r.unchangedCount, 3);
  assert.equal(r.unaccounted, 0);
});

test('LOUD: counts that do not add up become `unaccounted`, never "unchanged"', () => {
  const r = B.normaliseBulkSupplierResult(['a', 'b', 'c', 'd'], [{ ...LIVE_NOOP, unchanged: 1 }]);
  assert.equal(r.unaccounted, 3);
  const m = B.normaliseBulkSupplierResult(['a'], [{ ...LIVE_CHANGE, would_change: 2 }]);
  assert.equal(m.countMismatch, true, 'a count that disagrees with the listed rows must be flagged');
});

test('a reply that does not say dry_run is UNKNOWN, never assumed preview or applied', () => {
  const { dry_run, ...noFlag } = LIVE_NOOP; // eslint-disable-line no-unused-vars
  assert.equal(B.normaliseBulkSupplierResult(['a', 'b', 'c'], [noFlag]).dryRun, null);
  assert.equal(B.normaliseBulkSupplierResult(['a', 'b', 'c'], [LIVE_NOOP, { ...LIVE_NOOP, dry_run: false }]).dryRun, null,
    'mixed chunks are not one answer');
  assert.equal(B.normaliseBulkSupplierResult(['a'], [null]).dryRun, null);
});

test('counts may arrive as arrays; garbage is not counted as zero changes when rows are listed', () => {
  const r = B.normaliseBulkSupplierResult(['a', 'b'], [{ dry_run: true, would_change: 'lots', unchanged: ['b'], not_found: [], refused_genuine: [], products: [LIVE_CHANGE.products[0]] }]);
  assert.equal(r.changeCount, 1, 'falls back to the listed rows');
  assert.equal(r.unchangedCount, 1);
});

test('chunkIds de-duplicates, keeps order, and respects the 500 cap', () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `id${i}`);
  const chunks = B.chunkIds([...ids, 'id0', '', null]);
  assert.deepEqual(chunks.map((c) => c.length), [500, 500, 1]);
  assert.equal(chunks[0][0], 'id0');
  assert.equal(B.MAX_IDS_PER_CALL, 500);
});

test('only an owner may set suppliers in this UI (stock_manager cannot sign in to it)', () => {
  assert.equal(B.canSetSupplier('owner'), true);
  for (const r of ['admin', '', null, 'super_admin']) assert.equal(B.canSetSupplier(r), false, String(r));
  assert.match(B.setSupplierBlockedReason('admin'), /owner/);
  assert.equal(B.setSupplierBlockedReason('owner'), null);
});

test('the confirm-step warning is the backend handoff text, verbatim', () => {
  assert.equal(B.SUPPLIER_CHANGE_WARNING,
    "Changing a product's supplier puts it under that supplier's import. If that supplier's feed doesn't list it, the next import can deactivate it.");
});

// ── 3. AdminAPI.bulkSetSupplier — always sends dry_run ──────────────────────

function extractMethod(src, name) {
  const start = src.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function apiWith(post) {
  const body = extractMethod(API_SRC, 'bulkSetSupplier');
  // eslint-disable-next-line no-new-func
  return new Function('window', 'SUPPLIER_KEY_RE', 'SUPPLIER_BULK_MAX', 'productWriteError',
    `return { ${body} };`)({ API: { post } }, S.SUPPLIER_KEY_RE, B.MAX_IDS_PER_CALL,
    (resp, msg) => Object.assign(new Error(msg), { code: resp?.error?.code }));
}

test('bulkSetSupplier sends dry_run:true unless told dryRun:false — never omits it', async () => {
  const sent = [];
  const api = apiWith(async (url, body) => { sent.push({ url, body }); return { ok: true, data: LIVE_NOOP }; });
  assert.deepEqual(await api.bulkSetSupplier(['a', 'a', 'b'], 'ribbon'), LIVE_NOOP);
  await api.bulkSetSupplier(['a'], 'ribbon', { dryRun: false });
  await api.bulkSetSupplier(['a'], 'ribbon', {});
  assert.equal(sent[0].url, '/api/admin/products/bulk-supplier');
  assert.deepEqual(sent[0].body, { product_ids: ['a', 'b'], supplier: 'ribbon', dry_run: true });
  assert.equal(sent[1].body.dry_run, false);
  assert.equal(sent[2].body.dry_run, true);
});

test('bulkSetSupplier refuses bad input before any request, and throws on a refusal', async () => {
  let calls = 0;
  const api = apiWith(async () => { calls++; return { ok: false, error: { code: 'VALIDATION_FAILED' } }; });
  await assert.rejects(api.bulkSetSupplier(['a'], 'Streamline'), /not a supplier key/);
  await assert.rejects(api.bulkSetSupplier([], 'ribbon'), /1 to 500/);
  await assert.rejects(api.bulkSetSupplier(Array.from({ length: 501 }, (_, i) => `i${i}`), 'ribbon'), /1 to 500/);
  assert.equal(calls, 0);
  await assert.rejects(api.bulkSetSupplier(['a'], 'ribbon'), (e) => e.code === 'VALIDATION_FAILED');
});

// ── 4. The page wiring ──────────────────────────────────────────────────────

test('the bulk bar offers Set supplier through the same gate as its handler', () => {
  assert.match(PRODUCTS, /const canSupplier = canSetSupplier\(AdminAuth\.role\)/);
  assert.match(PRODUCTS, /data-bulk="supplier" disabled title=/, 'non-owners see it disabled with the reason');
  assert.match(PRODUCTS, /if \(canSupplier\) _bulkBar\.querySelector\('\[data-bulk="supplier"\]'\)/);
  assert.match(PRODUCTS, /async function bulkSetSupplier\(\)[\s\S]*?if \(!canSetSupplier\(AdminAuth\.role\)\)/);
});

test('preview first; apply only from a confirmed preview, with the SAME ids', () => {
  const flow = PRODUCTS.slice(PRODUCTS.indexOf('async function bulkSetSupplier()'), PRODUCTS.indexOf('function showSupplierResult('));
  assert.match(flow, /runSupplierChunks\(ids, supplier, true\)/, 'the first call is a dry run');
  assert.match(flow, /if \(plan\.dryRun !== true\)/, 'an unconfirmed preview stops the flow');
  assert.match(flow, /runSupplierChunks\(ids, supplier, false\)/, 'apply re-sends the previewed ids');
  assert.match(flow, /plan\.changeCount \? `<button[^`]*data-action="apply"/, 'no apply button when nothing would change');
  assert.match(flow, /SUPPLIER_CHANGE_WARNING/);
});

test('every bucket is rendered — genuine refusals and not-found are never silent', () => {
  const html = PRODUCTS.slice(PRODUCTS.indexOf('function supplierPlanHtml('), PRODUCTS.indexOf('async function bulkSetSupplier()'));
  for (const k of ['plan.refusedGenuine', 'plan.notFoundCount', 'plan.unchangedCount', 'plan.unaccounted', 'plan.countMismatch']) {
    assert.ok(html.includes(k), `${k} must be rendered`);
  }
});

test('Augmento terms now name Streamline too (same $100 incl GST rule)', () => {
  assert.match(PRODUCTS, /Augmento and Streamline when our cost is under \$100 incl GST/);
});
