/**
 * Admin Products PACK filter — Jul 2026
 * =====================================
 *
 * The Products page gets a 7th toolbar dropdown, `#pack-filter`, splitting the
 * catalog into singles vs multi-cartridge packs (owner request: "filter out
 * CMY and KCMY packs"). Scope confirmed with owner: a pack = CMY, KCMY,
 * Value Pack, Multipack. 'Tri-Colour' is deliberately a SINGLE — it's one
 * cartridge body holding three inks (see the ProductColors.OPTIONS comment).
 *
 * Invariants this file guards:
 *
 * 1. ONE vocabulary — `ProductColors.PACK_VALUES` in js/utils.js, and every
 *    entry must exist in ProductColors.OPTIONS. A filter value that doesn't
 *    exactly match a stored products.color string doesn't error, it silently
 *    matches ZERO rows — the ERR-075 drum/paper failure mode.
 *
 * 2. Supabase-only routing — /api/admin/products has NO color param. If the
 *    pack filter ever rode the backend route (margin sort / image / stock
 *    active), the table would show UNFILTERED rows under an active filter.
 *    `needsBackend` must AND with `!_packFilter`, exactly like `!typeGroup`.
 *
 * 3. NULL colors are singles — a bare `not.in` drops NULL rows (SQL
 *    three-valued logic); "Singles Only" must keep legacy uncoloured products
 *    via the `color.is.null` arm.
 *
 * 4. No silent export mismatch — the backend export endpoint ignores the pack
 *    filter, so CSV/Excel exports must WARN; the PDF path filters client-side
 *    and warns if the rows carry no color field at all.
 *
 * ── 2026-09-25 (ERR-286): invariants 2, 3 and 4 were INVERTED, not deleted ──
 * The backend grew `pack_type=packs|single` (BF-044a) and went strictQuery. So:
 *   2. the pack filter no longer forces the Supabase path — both legs answer it;
 *   3. it is keyed on the `pack_type` COLUMN on both legs, not on colour names.
 *      The colour rule missed 32 live packs whose colour is a plain hue
 *      (`G45BK-2PK` = "Black" + multipack), measured by cross-tabbing all
 *      4,387 rows. The NULL-colour trap it guarded is gone with it: pack_type
 *      is never NULL on a live row;
 *   4. exports are built client-side from the list's own filters, because the
 *      server export ignored every filter (see handleExport).
 * Invariant 1 (the PACK_VALUES vocabulary) is untouched — the storefront uses it.
 *
 * Run: node --test tests/admin-pack-filter.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const UTILS = read('inkcartridges/js/utils.js');
const PRODUCTS = read('inkcartridges/js/admin/pages/products.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. One shared vocabulary, and every value is REAL
// ─────────────────────────────────────────────────────────────────────────────

test('ProductColors.PACK_VALUES lists the four multi-cartridge pack colors', () => {
  const m = UTILS.match(/PACK_VALUES:\s*\[([^\]]+)\]/);
  assert.ok(m, 'js/utils.js must define ProductColors.PACK_VALUES');
  for (const v of ['CMY', 'KCMY', 'Value Pack', 'Multipack']) {
    assert.ok(m[1].includes(`'${v}'`), `PACK_VALUES must include '${v}'`);
  }
  assert.ok(!m[1].includes('Tri-Colour'),
    "'Tri-Colour' is ONE cartridge with three inks — it is a single, not a pack");
});

test('every PACK_VALUES entry is a canonical OPTIONS value (ERR-075 guard)', () => {
  const opts = UTILS.match(/OPTIONS:\s*\[([\s\S]*?)\n\s*\]/);
  assert.ok(opts, 'ProductColors.OPTIONS must exist');
  const optionValues = new Set([...opts[1].matchAll(/value:\s*'([^']*)'/g)].map(m => m[1]));

  const packs = [...UTILS.match(/PACK_VALUES:\s*\[([^\]]+)\]/)[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
  assert.ok(packs.length >= 4, 'expected a populated pack list');
  for (const v of packs) {
    assert.ok(optionValues.has(v),
      `pack value '${v}' is not in ProductColors.OPTIONS — it would match ZERO rows silently (the drum/paper failure mode)`);
  }
});

test('products.js keys the pack filter on pack_type — never on a colour-name list', () => {
  assert.ok(!/ProductColors\.PACK_VALUES/.test(PRODUCTS),
    'the admin pack filter is back on colour names — that rule missed 32 live packs (ERR-286)');
  assert.ok(!/\[\s*'CMY'\s*,\s*'KCMY'/.test(PRODUCTS),
    'products.js must not hardcode its own pack-color array either');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The dropdown offers exactly the three states the query understands
// ─────────────────────────────────────────────────────────────────────────────

test('#pack-filter offers "" / singles / packs and nothing else', () => {
  const sel = PRODUCTS.match(/<select[^>]*id="pack-filter"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(sel, 'products.js must render a #pack-filter select');
  const values = [...sel[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(values, ['', 'singles', 'packs'],
    'option values must be exactly the states the query predicate handles — anything else silently matches nothing');
});

test('#pack-filter change reloads from page 1', () => {
  assert.match(PRODUCTS, /#pack-filter'\)\?\.addEventListener\('change',[\s\S]{0,120}?_packFilter = e\.target\.value;\s*_page = 1;\s*loadProducts\(\)/,
    'the pack filter must follow the standard toolbar wiring (state, reset page, reload)');
});

test('destroy() resets _packFilter like the other filters', () => {
  assert.match(PRODUCTS, /destroy\(\)\s*\{[\s\S]*?_packFilter = '';[\s\S]*?\}/,
    'a stale pack filter would survive navigation away and back');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Query routing and NULL handling
// ─────────────────────────────────────────────────────────────────────────────

test('an active pack/supplier filter no longer steers the route — both legs answer it', () => {
  assert.match(PRODUCTS, /const\s+needsBackend\s*=\s*isMarginSort\s*\|\|\s*!!_imageFilter\s*\|\|\s*!!_stockFilter;/,
    'needsBackend must depend only on what the Supabase leg cannot compute');
});

test('the Supabase leg keys packs on pack_type, exactly like the backend', () => {
  assert.match(PRODUCTS, /_packFilter === 'packs'\) query = query\.neq\('pack_type', 'single'\)/);
  assert.match(PRODUCTS, /_packFilter === 'singles'\) query = query\.eq\('pack_type', 'single'\)/);
  assert.ok(!/query\.in\(\s*'color'\s*,\s*PACKS\s*\)/.test(PRODUCTS), 'the colour-name rule is back');
});

test('the forced-Supabase image filter is JOIN-AWARE (ERR-091)', () => {
  // The pack filter forces the Supabase path, where the image filter used to be
  // the approximation `image_url IS NULL`. Images live in TWO places — legacy
  // products.image_url AND the product_images table: 356 live products have
  // product_images rows with image_url NULL, so "No Images" + "Singles Only"
  // showed rows with visible thumbnails. Both branches must consult BOTH sources.
  assert.match(PRODUCTS, /\.or\(\s*'image_url\.not\.is\.null,product_images\.not\.is\.null'\s*\)/,
    'has-images must OR legacy image_url with the product_images embed');
  assert.match(PRODUCTS, /\.is\(\s*'image_url'\s*,\s*null\s*\)\.is\(\s*'product_images'\s*,\s*null\s*\)/,
    'no-images must require BOTH image_url AND product_images to be null');
});

test('selectCols keeps the product_images embed the null-filters depend on', () => {
  // PostgREST embed-null filtering (product_images=is.null / not.is.null) only
  // works when the relation is embedded in the select — dropping the embed makes
  // the image filter throw 42703 at runtime (caught → backend fallback + warning,
  // but the filter itself dies). Pin the dependency.
  assert.match(PRODUCTS, /const selectCols = '[^']*product_images\(/,
    'the Supabase select list must embed product_images(…) — the join-aware image filter depends on it');
});

test('both backend legs send the pack filter and name what they cannot apply', () => {
  const builder = PRODUCTS.match(/function backendProductFilters\(\)[\s\S]+?\n\}/);
  assert.ok(builder, 'backendProductFilters() must exist');
  assert.match(builder[0], /_packFilter === 'singles'\) filters\.pack_type = 'single'/,
    "'singles' must be translated — it is outside the backend enum and 400s");
  const fallback = PRODUCTS.match(/\/\/ Fallback: use backend API[\s\S]{0,1400}/);
  assert.ok(fallback, 'the backend fallback block must exist');
  assert.match(fallback[0], /warnLostToBackend\(\)/, 'the fallback must still say what it could not apply');
  const planned = PRODUCTS.match(/if \(needsBackend\) \{[\s\S]{0,200}/);
  assert.match(planned[0], /warnLostToBackend\(\)/, 'and so must the planned backend leg');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exports never lie about their scope
// ─────────────────────────────────────────────────────────────────────────────

test('CSV/Excel are built from the list\'s own filters, not the server export', () => {
  const body = PRODUCTS.match(/async function\s+handleExport\s*\([^)]*\)\s*\{[\s\S]+?\n\}/);
  assert.ok(body, 'handleExport must exist');
  assert.ok(!/exportData\(\s*'products'/.test(PRODUCTS),
    "the server product export is back — it ignored every filter and 500'd on brands= (ERR-286)");
  assert.match(body[0], /exportProductsCSV\(/);
  const csv = PRODUCTS.match(/async function\s+exportProductsCSV\s*\([\s\S]+?\n\}/);
  assert.match(csv[0], /fetchFilteredProductsForExport\(\)/);
});

test('PDF and CSV share ONE filtered fetch, and neither re-filters by colour', () => {
  const pdf = PRODUCTS.match(/async function\s+exportProductsPDF\s*\([\s\S]+?\n\}/);
  assert.match(pdf[0], /fetchFilteredProductsForExport\(\)/);
  const fetchAll = PRODUCTS.match(/async function\s+fetchFilteredProductsForExport\s*\([\s\S]+?\n\}/);
  assert.match(fetchAll[0], /backendProductFilters\(\)/, 'the export must use the list\'s builder');
  assert.ok(!/PACKS\.includes\(p\.color\)/.test(PRODUCTS),
    'a client-side colour re-filter over server-filtered rows drops the 32 hue-coloured packs');
  assert.match(pdf[0], /_packFilter\)\s*filterParts\.push\(/,
    'the PDF filter-summary line must mention the active pack filter');
});

test('the CSV cell escaper defuses formula injection and keeps negatives', async () => {
  const fn = PRODUCTS.match(/function csvCell\(v\) \{[\s\S]+?\n\}/);
  assert.ok(fn, 'csvCell must exist');
  // eslint-disable-next-line no-new-func
  const csvCell = new Function(`${fn[0]}; return csvCell;`)();
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-12.5'), '-12.5', 'a negative number is data, not a formula');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0', 'a real zero stays a zero');
});
