/**
 * Admin Ribbon source filter — May 2026
 * ======================================
 *
 * The Products page header (inkcartridges/js/admin/pages/products.js) exposes a
 * `#source-filter` <select> with options All Sources / Genuine / Compatible /
 * Remanufactured / Ribbon. Selecting "Ribbon" used to issue
 * `.eq('source','ribbon')` against Supabase, which only matches the 34 legacy
 * rows where `source = 'ribbon'`. The newer ~82 ribbons live under
 * `source = 'compatible'` or `source = 'genuine'` with
 * `product_type IN ('printer_ribbon','typewriter_ribbon','correction_tape')`.
 *
 * Result before the fix: searching "ribbon" from the table returned 116 rows
 * (name match), but selecting "Ribbon" from the source filter returned 34 —
 * silently hiding ~70% of the ribbon catalog from admins, including every
 * compatible ribbon and every correction tape SKU.
 *
 * The fix expands the "Ribbon" option into a product_type umbrella:
 *
 *   1. RIBBON_PRODUCT_TYPES is the canonical list at module scope.
 *   2. `_sourceFilter === 'ribbon'` triggers `.in('product_type', RIBBON_PRODUCT_TYPES)`
 *      on the Supabase query (the legacy `.eq('source', 'ribbon')` path is gone
 *      for that value).
 *   3. The ribbon umbrella ALWAYS uses the Supabase path. The backend's
 *      `source=ribbon` filter has the same legacy bug, so we can't rely on it
 *      even when image/stock filters or margin sort are active. We therefore
 *      fold those filters into the Supabase query (image_url IS [NOT] NULL,
 *      stock_status =, plus client-side margin/markup/profit sort using
 *      computeProfitability).
 *   4. CSV/PDF export translates `_sourceFilter='ribbon'` into a
 *      `product_type=printer_ribbon,typewriter_ribbon,correction_tape` query
 *      param so the export endpoint sees the same scope as the table.
 *
 * Spec: readfirst/admin-ribbon-source-filter-may2026.md
 *
 * Run: node --test tests/admin-ribbon-source-filter.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PRODUCTS_ADMIN = path.join(ROOT, 'inkcartridges/js/admin/pages/products.js');
const SRC = fs.readFileSync(PRODUCTS_ADMIN, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Canonical list of ribbon product_types
// ─────────────────────────────────────────────────────────────────────────────

test('RIBBON_PRODUCT_TYPES constant is declared and lists the three ribbon types', () => {
  const m = SRC.match(/const\s+RIBBON_PRODUCT_TYPES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, "expected `const RIBBON_PRODUCT_TYPES = [ ... ]` at module scope");
  const list = m[1];
  for (const t of ['printer_ribbon', 'typewriter_ribbon', 'correction_tape']) {
    assert.ok(list.includes(`'${t}'`),
      `RIBBON_PRODUCT_TYPES must include '${t}' (verified ${
        t === 'printer_ribbon' ? '88' : t === 'typewriter_ribbon' ? '22' : '6'
      } rows in production)`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Supabase query expands ribbon source → product_type IN (...)
// ─────────────────────────────────────────────────────────────────────────────

test('Supabase path uses .in("product_type", RIBBON_PRODUCT_TYPES) when ribbon is selected', () => {
  // Look for a branch on _sourceFilter === 'ribbon' that calls .in('product_type', RIBBON_PRODUCT_TYPES).
  const branch = SRC.match(/_sourceFilter\s*===\s*'ribbon'[\s\S]{0,400}?\.in\(\s*'product_type'\s*,\s*RIBBON_PRODUCT_TYPES\s*\)/);
  assert.ok(branch,
    'Supabase loadProducts must branch on _sourceFilter === "ribbon" and call .in("product_type", RIBBON_PRODUCT_TYPES)');
});

test('Legacy .eq("source", "ribbon") is gone from the Supabase path', () => {
  // Hard rule: the literal `eq('source', 'ribbon')` (or with double quotes)
  // must not appear anywhere in the file — it was the bug.
  const badSingle = /\.eq\(\s*'source'\s*,\s*'ribbon'\s*\)/.test(SRC);
  const badDouble = /\.eq\(\s*"source"\s*,\s*"ribbon"\s*\)/.test(SRC);
  assert.equal(badSingle, false, 'No .eq(\'source\', \'ribbon\') — that was the bug');
  assert.equal(badDouble, false, 'No .eq("source", "ribbon") — that was the bug');
});

test('Generic source filter still goes through .eq for non-ribbon values', () => {
  // Other source values (genuine/compatible/remanufactured) should still use
  // .eq('source', _sourceFilter) — only "ribbon" is special.
  const m = SRC.match(/else if\s*\(\s*_sourceFilter\s*\)\s*\{\s*[\s\S]{0,200}?\.eq\(\s*'source'\s*,\s*_sourceFilter\s*\)/);
  assert.ok(m, 'non-ribbon source values must still use .eq("source", _sourceFilter)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. needsBackend forces Supabase when ribbon umbrella is active
// ─────────────────────────────────────────────────────────────────────────────

test('Backend route is bypassed when source=ribbon (so backend bug cannot leak through)', () => {
  // The needsBackend gate must short-circuit on the ribbon umbrella, otherwise
  // image-filter / stock-filter / margin-sort combos would route to backend
  // which still maps source=ribbon to only 34 rows.
  const m = SRC.match(/const\s+ribbonUmbrella\s*=\s*_sourceFilter\s*===\s*'ribbon'\s*;[\s\S]{0,300}?const\s+needsBackend\s*=\s*!ribbonUmbrella\s*&&/);
  assert.ok(m, 'needsBackend must AND with !ribbonUmbrella to keep ribbon on the Supabase path');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Image, stock, and margin-sort filters work in the ribbon umbrella path
// ─────────────────────────────────────────────────────────────────────────────

test('Supabase ribbon path supports image filter (has-images / no-images)', () => {
  assert.ok(/ribbonUmbrella\s*&&\s*_imageFilter\s*===\s*'has-images'[\s\S]{0,120}?\.not\(\s*'image_url'\s*,\s*'is'\s*,\s*null\s*\)/.test(SRC),
    'ribbon umbrella + has-images must use .not("image_url", "is", null)');
  assert.ok(/ribbonUmbrella\s*&&\s*_imageFilter\s*===\s*'no-images'[\s\S]{0,120}?\.is\(\s*'image_url'\s*,\s*null\s*\)/.test(SRC),
    'ribbon umbrella + no-images must use .is("image_url", null)');
});

test('Supabase ribbon path supports stock filter via products.stock_status column', () => {
  assert.ok(/ribbonUmbrella\s*&&\s*_stockFilter[\s\S]{0,120}?\.eq\(\s*'stock_status'\s*,\s*_stockFilter\s*\)/.test(SRC),
    'ribbon umbrella + stock filter must use .eq("stock_status", _stockFilter)');
});

test('Supabase ribbon path sorts margin/markup/profit client-side via computeProfitability', () => {
  // The margin/markup/profit columns aren't in the products table — backend
  // computes them. For the ribbon umbrella we must compute on the client.
  assert.ok(/ribbonUmbrella\s*&&\s*isMarginSort/.test(SRC),
    'ribbon umbrella must detect margin/markup/profit sort and handle it locally');
  assert.ok(/computeProfitability\s*\(\s*[ab]\s*\)/.test(SRC),
    'client-side sort must call computeProfitability(row) on each row');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Export query string respects the ribbon umbrella
// ─────────────────────────────────────────────────────────────────────────────

test('CSV/PDF export translates source=ribbon into product_type=printer_ribbon,typewriter_ribbon,correction_tape', () => {
  // getProductExportParams used to set source=ribbon directly; now it must
  // emit a comma list of ribbon product_types so the export endpoint
  // returns the same 116 rows the on-screen table shows.
  const m = SRC.match(/_sourceFilter\s*===\s*'ribbon'[\s\S]{0,300}?p\.set\(\s*'product_type'\s*,\s*RIBBON_PRODUCT_TYPES\.join\(\s*','\s*\)\s*\)/);
  assert.ok(m, 'export must translate ribbon to product_type=printer_ribbon,typewriter_ribbon,correction_tape');

  // The export must NOT pass source=ribbon any more.
  const exportBody = SRC.match(/function\s+getProductExportParams\s*\([^)]*\)\s*\{[\s\S]+?\n\}/);
  assert.ok(exportBody, 'getProductExportParams function must exist');
  // Inside the function, the only place 'ribbon' appears must be the umbrella
  // detection, never as a value passed via p.set('source', ...).
  const badSourceSet = /p\.set\(\s*'source'\s*,\s*'ribbon'\s*\)/.test(exportBody[0]);
  assert.equal(badSourceSet, false, 'export must not call p.set("source", "ribbon") — that was the bug');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The dropdown still surfaces a "Ribbon" option (UX contract)
// ─────────────────────────────────────────────────────────────────────────────

test('#source-filter <select> still offers a "Ribbon" option (value="ribbon")', () => {
  // The dropdown must keep the user-facing entry — we are fixing the query,
  // not removing the affordance.
  assert.ok(/<option\s+value="ribbon">Ribbon<\/option>/.test(SRC),
    'source-filter must still expose <option value="ribbon">Ribbon</option>');
});
