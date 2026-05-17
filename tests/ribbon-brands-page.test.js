/**
 * Ribbon Brands admin page — May 2026
 * ===================================
 *
 * Restores the ribbon-brand management surface that was lost when commit
 * c8fcf9e (10 May 2026) deleted the 1366-line two-tab pages/ribbons.js.
 * That commit's target was the redundant *Products* tab (a copy of All
 * Products); the *Brands* tab — the only ribbon-brand CRUD UI — was
 * collateral damage. The ribbon_brands API in js/admin/api.js
 * (getAdminRibbonBrands / createRibbonBrand / updateRibbonBrand /
 * deleteRibbonBrand / uploadRibbonBrandImage) was left fully orphaned.
 *
 * The fix is a focused, standalone page:
 *
 *   1. js/admin/pages/ribbon-brands.js — list + create/edit/delete modal
 *      + per-brand image upload. NOT named ribbons.js, so the contract in
 *      tests/no-admin-ribbons-tab.test.js (the deleted module stays
 *      deleted) is untouched. No redundant Products tab.
 *
 *   2. app.js NAV_ITEMS gains a `ribbon-brands` entry → routed at
 *      #ribbon-brands. The legacy `ribbons` → `products` redirect is kept.
 *
 * This test runs the page's real pure helpers — slugify() and
 * buildColumns() — extracted from source, plus source-contract checks on
 * the API wiring and routing.
 *
 * Run: node --test tests/ribbon-brands-page.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE_REL = 'inkcartridges/js/admin/pages/ribbon-brands.js';
const PAGE_SRC = READ(PAGE_REL);
const APP_SRC  = READ('inkcartridges/js/admin/app.js');
const API_SRC  = READ('inkcartridges/js/admin/api.js');

// Extract a top-level `function NAME(...) { ... }` body by brace matching.
function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `signature not found: ${signature}`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The page module exists and has the standard admin-page export shape
// ─────────────────────────────────────────────────────────────────────────────

test('pages/ribbon-brands.js exists with an init/destroy default export', () => {
  assert.ok(fs.existsSync(path.join(ROOT, PAGE_REL)), 'ribbon-brands.js must exist');
  assert.match(PAGE_SRC, /export default \{/, 'must have a default export');
  assert.match(PAGE_SRC, /async init\s*\(container\)/, 'export must define init(container)');
  assert.match(PAGE_SRC, /destroy\s*\(\)/, 'export must define destroy()');
});

test('the page is NOT a resurrection of the deleted ribbons.js module', () => {
  // no-admin-ribbons-tab.test.js pins that pages/ribbons.js stays deleted.
  assert.ok(!fs.existsSync(path.join(ROOT, 'inkcartridges/js/admin/pages/ribbons.js')),
    'the old pages/ribbons.js must remain deleted');
  // And the new page must not re-add a "Products" sub-tab — it is brands-only.
  assert.doesNotMatch(PAGE_SRC, /data-tab="products"/, 'no redundant Products tab');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CRUD is wired to the (previously orphaned) ribbon_brands API
// ─────────────────────────────────────────────────────────────────────────────

test('the page calls every ribbon_brands CRUD method', () => {
  for (const m of ['getAdminRibbonBrands', 'createRibbonBrand', 'updateRibbonBrand',
                    'deleteRibbonBrand', 'uploadRibbonBrandImage']) {
    assert.match(PAGE_SRC, new RegExp(`AdminAPI\\.${m}\\s*\\(`), `page must call AdminAPI.${m}`);
    assert.match(API_SRC,  new RegExp(`\\b${m}\\s*\\(`), `AdminAPI.${m} must still exist`);
  }
});

test('delete goes through a confirmation dialog', () => {
  assert.match(PAGE_SRC, /Modal\.confirm\(/, 'delete must use Modal.confirm');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Routing — nav entry added, legacy redirect preserved
// ─────────────────────────────────────────────────────────────────────────────

test('app.js NAV_ITEMS has a ribbon-brands entry', () => {
  assert.match(APP_SRC, /key:\s*'ribbon-brands'/, 'NAV_ITEMS must include ribbon-brands');
  assert.match(APP_SRC, /key:\s*'ribbon-brands',\s*label:\s*'Ribbon Brands'/,
    'the nav item must be labelled "Ribbon Brands"');
});

test('legacy "ribbons" → "products" redirect is still preserved', () => {
  assert.match(APP_SRC, /['"]ribbons['"]\s*:\s*['"]products['"]/,
    'ROUTE_REDIRECTS must keep "ribbons":"products" for old bookmarks');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Functional — run the page's real pure helpers
// ─────────────────────────────────────────────────────────────────────────────

test('slugify() produces clean, collision-resistant slugs', () => {
  const slugify = new Function(`${extractFunction(PAGE_SRC, 'function slugify(')}; return slugify;`)();
  assert.equal(slugify('Olympia'), 'olympia');
  assert.equal(slugify('Smith Corona'), 'smith-corona');
  assert.equal(slugify('  Triumph-Adler  '), 'triumph-adler');
  assert.equal(slugify('C.Itoh'), 'c-itoh');
  assert.equal(slugify('Brother!!! 2000'), 'brother-2000');
  assert.equal(slugify('---weird---'), 'weird', 'leading/trailing separators stripped');
});

test('buildColumns() renders image / placeholder / active-dot correctly', () => {
  const esc = (s) => String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = () => '<svg></svg>';
  const buildColumns = new Function('icon', 'esc', 'MISSING',
    `${extractFunction(PAGE_SRC, 'function buildColumns(')}; return buildColumns;`)(icon, esc, '—');

  const cols = buildColumns();
  assert.deepEqual(cols.map(c => c.key), ['image', 'name', 'slug', 'sort_order', 'is_active']);

  const imageCol = cols.find(c => c.key === 'image');
  assert.match(imageCol.render({ image_url: 'https://x/logo.png' }), /<img[^>]+logo\.png/,
    'a brand with an image renders an <img>');
  assert.match(imageCol.render({ image_url: '' }), /admin-product-thumb--empty/,
    'a brand without an image renders the placeholder');

  const activeCol = cols.find(c => c.key === 'is_active');
  assert.match(activeCol.render({ is_active: true }),  /admin-active-dot--on/);
  assert.match(activeCol.render({ is_active: false }), /admin-active-dot--off/);
  assert.match(activeCol.render({}), /admin-active-dot--on/, 'missing is_active defaults to active');

  const nameCol = cols.find(c => c.key === 'name');
  assert.match(nameCol.render({ name: '<script>' }), /&lt;script&gt;/, 'name is HTML-escaped');
  assert.equal(nameCol.render({}), '—', 'missing name shows the em-dash placeholder');
});
