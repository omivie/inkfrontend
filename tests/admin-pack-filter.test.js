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

test('products.js reads ProductColors.PACK_VALUES — no hand-rolled second list', () => {
  assert.match(PRODUCTS, /ProductColors\.PACK_VALUES/,
    'the filter must bind to the canonical list');
  assert.ok(!/\[\s*'CMY'\s*,\s*'KCMY'/.test(PRODUCTS),
    'products.js must not hardcode its own pack-color array — that is how vocabularies drift dead');
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

test('an active pack filter is forced down the Supabase path', () => {
  // /api/admin/products has no color param — routing an active pack filter to
  // the backend would show unfiltered rows while the dropdown says otherwise.
  assert.match(PRODUCTS, /const\s+needsBackend\s*=\s*!typeGroup\s*&&\s*!_packFilter\s*&&/,
    'needsBackend must AND with !_packFilter');
});

test('"packs" queries .in("color", PACKS); "singles" keeps NULL colors', () => {
  assert.match(PRODUCTS, /query\.in\(\s*'color'\s*,\s*PACKS\s*\)/,
    '"Packs Only" must be .in("color", PACKS)');
  assert.match(PRODUCTS, /color\.is\.null\s*,\s*color\.not\.in\./,
    '"Singles Only" must include the color.is.null arm — a bare not.in drops NULL-color rows (SQL three-valued logic)');
});

test('backend fallback path warns instead of silently ignoring the pack filter', () => {
  const fallback = PRODUCTS.match(/\/\/ Fallback: use backend API[\s\S]{0,600}/);
  assert.ok(fallback, 'the backend fallback block must exist');
  assert.match(fallback[0], /_packFilter\)\s*Toast\.warning/,
    'if Supabase is down, the admin must be TOLD the pack filter was dropped — unfiltered rows under an active filter is a silent lie');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Exports never lie about their scope
// ─────────────────────────────────────────────────────────────────────────────

test('CSV/Excel export warns when the pack filter is active', () => {
  const body = PRODUCTS.match(/async function\s+handleExport\s*\([^)]*\)\s*\{[\s\S]+?\n\}/);
  assert.ok(body, 'handleExport must exist');
  assert.match(body[0], /_packFilter\)\s*Toast\.warning/,
    'the backend export has no pack param — the admin must be warned the export is unfiltered');
});

test('PDF export filters by pack client-side and guards a missing color field', () => {
  const body = PRODUCTS.match(/async function\s+exportProductsPDF\s*\([\s\S]+?\n\}/);
  assert.ok(body, 'exportProductsPDF must exist');
  assert.match(body[0], /_packFilter === 'packs' \? PACKS\.includes\(p\.color\) : !PACKS\.includes\(p\.color\)/,
    'the PDF path must apply the pack filter client-side like the image filter');
  assert.match(body[0], /!all\.some\(p => p\.color != null\)[\s\S]{0,200}?Toast\.warning/,
    'if the export rows carry no color at all, filtering would classify everything as a single — warn instead');
  assert.match(body[0], /_packFilter\)\s*filterParts\.push\(/,
    'the PDF filter-summary line must mention the active pack filter');
});
