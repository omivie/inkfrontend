/**
 * Admin Ribbons TYPE filter — Jul 2026 (supersedes admin-ribbon-source-filter)
 * ============================================================================
 *
 * The Products page needs one filter that shows every ribbon at once: printer
 * ribbons (82), typewriter ribbons (22) and correction tape (6).
 *
 * That umbrella already existed — in the WRONG dropdown. It was a fake value
 * ("ribbon") in `#source-filter`, which conflates two axes: source is
 * genuine/compatible/remanufactured, ribbon-ness is a product_type. It now lives
 * in `#type-filter` as `value="ribbons"`, a TYPE_FILTER_GROUPS key that expands
 * to `.in('product_type', RIBBON_PRODUCT_TYPES)`.
 *
 * The same commit fixed the type dropdown's two DEAD options. `drum` and `paper`
 * are /shop CATEGORY slugs, not product_type values — the columns say `drum_unit`
 * (182 products) and `photo_paper` (74). Neither had ever matched a row. A filter
 * value that isn't a real product_type doesn't error, it silently returns nothing,
 * so the bug was invisible for months and had been copy-pasted into a second page.
 * Hence: ONE vocabulary module, and a test that every option value is real.
 *
 * Run: node --test tests/admin-ribbon-type-filter.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TYPES = read('inkcartridges/js/admin/utils/product-types.js');
const PRODUCTS = read('inkcartridges/js/admin/pages/products.js');
const PENDING = read('inkcartridges/js/admin/pages/pending-changes.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. One shared vocabulary
// ─────────────────────────────────────────────────────────────────────────────

test('RIBBON_PRODUCT_TYPES lists the three ribbon types', () => {
  const m = TYPES.match(/export const RIBBON_PRODUCT_TYPES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'utils/product-types.js must export RIBBON_PRODUCT_TYPES');
  for (const t of ['printer_ribbon', 'typewriter_ribbon', 'correction_tape']) {
    assert.ok(m[1].includes(`'${t}'`), `RIBBON_PRODUCT_TYPES must include '${t}'`);
  }
});

test('TYPE_FILTER_GROUPS maps "ribbons" to RIBBON_PRODUCT_TYPES', () => {
  assert.match(TYPES, /export const TYPE_FILTER_GROUPS\s*=\s*\{\s*ribbons:\s*RIBBON_PRODUCT_TYPES\s*\}/,
    'the "ribbons" filter value must expand to the ribbon type list');
});

test('both pages import the vocabulary rather than hand-rolling a dropdown', () => {
  for (const [name, src] of [['products.js', PRODUCTS], ['pending-changes.js', PENDING]]) {
    assert.match(src, /from\s+'\.\.\/utils\/product-types\.js'/,
      `${name} must import the shared type vocabulary`);
    assert.match(src, /typeFilterOptions\(/,
      `${name} must build its type <select> from typeFilterOptions() — a hand-written option list is how drum/paper drifted dead`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every option value is REAL — the drum/paper regression guard
// ─────────────────────────────────────────────────────────────────────────────

test('every TYPE_FILTER_OPTIONS value is a real product_type or a group key', () => {
  const labels = TYPES.match(/export const PRODUCT_TYPE_LABELS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(labels, 'PRODUCT_TYPE_LABELS must exist');
  const realTypes = new Set([...labels[1].matchAll(/(\w+):\s*'/g)].map(m => m[1]));

  const groups = TYPES.match(/export const TYPE_FILTER_GROUPS\s*=\s*\{([^}]*)\}/);
  const groupKeys = new Set([...groups[1].matchAll(/(\w+):/g)].map(m => m[1]));

  const opts = TYPES.match(/export const TYPE_FILTER_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(opts, 'TYPE_FILTER_OPTIONS must exist');
  const values = [...opts[1].matchAll(/value:\s*'([^']*)'/g)].map(m => m[1]);

  assert.ok(values.length > 5, 'expected a populated type menu');
  for (const v of values) {
    if (v === '') continue;   // "All Types"
    assert.ok(realTypes.has(v) || groupKeys.has(v),
      `type filter value '${v}' is neither a real product_type nor a group key — it would match ZERO rows (this is exactly what 'drum' and 'paper' did)`);
  }
});

test('the dead "drum" and "paper" values are gone, and the real columns are offered', () => {
  const opts = TYPES.match(/export const TYPE_FILTER_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/)[1];
  const values = [...opts.matchAll(/value:\s*'([^']*)'/g)].map(m => m[1]);
  assert.ok(!values.includes('drum'), "'drum' is a category slug, not a product_type — use drum_unit");
  assert.ok(!values.includes('paper'), "'paper' is a category slug, not a product_type — use photo_paper");
  assert.ok(values.includes('drum_unit'), 'drum_unit (182 products) must be filterable');
  assert.ok(values.includes('photo_paper'), 'photo_paper (74 products) must be filterable');
  assert.ok(values.includes('ribbons'), 'the "All Ribbons" umbrella must be offered');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A grouped type queries with .in(), a single type with .eq()
// ─────────────────────────────────────────────────────────────────────────────

test('Supabase path applies a grouped type via .in("product_type", …)', () => {
  assert.match(PRODUCTS, /if\s*\(typeGroup\)\s*query\s*=\s*query\.in\(\s*'product_type'\s*,\s*typeGroup\s*\)/,
    'a grouped type must be applied as .in("product_type", typeGroup)');
  assert.match(PRODUCTS, /else if\s*\(_typeFilter\)\s*query\s*=\s*query\.eq\(\s*'product_type'\s*,\s*_typeFilter\s*\)/,
    'a single type must still be applied as .eq("product_type", _typeFilter)');
});

test('a grouped type is forced down the Supabase path', () => {
  // The backend's product_type param takes ONE value — only .in() can span the
  // three ribbon types. If image/stock/margin-sort routed a grouped type to the
  // backend, the umbrella would silently collapse to a single type.
  assert.match(PRODUCTS, /const\s+typeGroup\s*=\s*typeFilterGroup\(_typeFilter\)\s*;[\s\S]{0,300}?const\s+needsBackend\s*=\s*!typeGroup\s*&&/,
    'needsBackend must AND with !typeGroup');
});

test('image, stock and margin-sort still work under a grouped type', () => {
  assert.match(PRODUCTS, /typeGroup\s*&&\s*_imageFilter\s*===\s*'has-images'[\s\S]{0,120}?\.not\(\s*'image_url'\s*,\s*'is'\s*,\s*null\s*\)/,
    'grouped type + has-images must use .not("image_url", "is", null)');
  assert.match(PRODUCTS, /typeGroup\s*&&\s*_stockFilter[\s\S]{0,120}?\.eq\(\s*'stock_status'\s*,\s*_stockFilter\s*\)/,
    'grouped type + stock filter must use .eq("stock_status", _stockFilter)');
  assert.match(PRODUCTS, /typeGroup\s*&&\s*isMarginSort/,
    'grouped type must detect a margin sort and handle it client-side');
  assert.match(PRODUCTS, /computeProfitability\s*\(\s*[ab]\s*\)/,
    'the client-side sort must call computeProfitability(row)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Export sees the same scope as the table
// ─────────────────────────────────────────────────────────────────────────────

test('export emits a grouped type as a comma list', () => {
  const body = PRODUCTS.match(/function\s+getProductExportParams\s*\([^)]*\)\s*\{[\s\S]+?\n\}/);
  assert.ok(body, 'getProductExportParams must exist');
  assert.match(body[0], /if\s*\(typeGroup\)\s*p\.set\(\s*'product_type'\s*,\s*typeGroup\.join\(\s*','\s*\)\s*\)/,
    'a grouped type must export as product_type=printer_ribbon,typewriter_ribbon,correction_tape');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The fake "ribbon" SOURCE is gone from both pages
// ─────────────────────────────────────────────────────────────────────────────

test('#source-filter no longer offers a "Ribbon" option', () => {
  for (const [name, src] of [['products.js', PRODUCTS], ['pending-changes.js', PENDING]]) {
    assert.ok(!/<option\s+value="ribbon"[^>]*>Ribbon<\/option>/.test(src),
      `${name}: "Ribbon" is a product_type, not a source — the option belongs in #type-filter`);
  }
});

test('no .eq("source", "ribbon") anywhere — that was the original bug', () => {
  assert.ok(!/\.eq\(\s*['"]source['"]\s*,\s*['"]ribbon['"]\s*\)/.test(PRODUCTS),
    'source="ribbon" only ever matched the 34 legacy rows');
});

test('real source values still filter with .eq("source", _sourceFilter)', () => {
  assert.match(PRODUCTS, /if\s*\(_sourceFilter\)\s*query\s*=\s*query\.eq\(\s*'source'\s*,\s*_sourceFilter\s*\)/,
    'genuine/compatible/remanufactured must still use .eq("source", …)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Pending Changes filters clients-side — it must honour groups too
// ─────────────────────────────────────────────────────────────────────────────

test('pending-changes matches a grouped type through matchesTypeFilter', () => {
  assert.match(PENDING, /matchesTypeFilter\(\s*pf\.product_type\s*,\s*cached\.product_type\s*\)/,
    'a plain !== comparison would make "All Ribbons" match nothing on this page');
});
