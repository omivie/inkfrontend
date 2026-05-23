/**
 * Admin Products — compact SKU / Brand columns — May 2026
 * ========================================================
 *
 * Report: "the SKU and Brand columns have too much empty/white space."
 *
 * Root cause (not what it looked like): the per-column `col-w-*` widths were
 * only ever *hints*. The products DataTable renders `<table class="admin-table">`
 * which is `width:100%` with the default `table-layout:auto`. When the visible
 * columns don't fill the container, the browser stretches EVERY column
 * proportionally to soak up the surplus — `max-width` on a `<td>` is ignored in
 * that mode. Measured live: a 120px SKU rendered ~140px and a 90px Brand ~105px,
 * and on a wide (1900px) viewport they ballooned further. That stretch is the
 * "white space" — short values (a "HP" badge, a "G981YC" SKU) floating in a
 * column sized for the table, not for the content.
 *
 * Fix — three parts, all pinned below:
 *
 *   1. CSS: a `.admin-table--colsized` opt-in that switches the table to
 *      `table-layout: fixed`, so the `col-w-*` widths are honoured to the
 *      pixel and never stretched. Under fixed layout the surplus must go
 *      somewhere, so Name is the SOLE `width:auto` column and absorbs all of
 *      it (its title text uses the room instead of padding SKU/Brand). Every
 *      other column carries an explicit width — the invariant that keeps
 *      "exactly one absorber" true.
 *
 *   2. CSS: SKU 120→96px (fits a typical ≤9-char mono SKU; longer pack SKUs
 *      wrap via the existing break-all) and Brand 90→88px with the badge set
 *      to `white-space:normal` so the rare long ribbon brand (Fuji Xerox,
 *      Triumph-adler) wraps to two lines instead of clipping — strictly
 *      better than the old 90px nowrap, which clipped them.
 *
 *   3. JS: DataTable gained an optional `config.tableClass` (appended to the
 *      <table> in both the loading and main render paths); the products page
 *      passes `tableClass: 'admin-table--colsized'`.
 *
 * Live verification (Playwright, real admin table): with the class on, SKU
 * measured exactly 96px and Brand exactly 88px at both 1202px and 1900px
 * viewports (no inflation), Name absorbed the surplus (318px → 706px), and a
 * sweep of 100 rows plus injected worst-case brand names produced ZERO clipping
 * (Samsung/Panasonic single-line; Fuji Xerox / Triumph-adler wrapped cleanly).
 *
 * This suite is the static guard so the contract can't silently regress.
 *
 * Run: node --test tests/admin-products-column-compact.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS_SRC      = READ('inkcartridges/css/admin.css');
const TABLE_SRC    = READ('inkcartridges/js/admin/components/table.js');
const PRODUCTS_SRC = READ('inkcartridges/js/admin/pages/products.js');

// Pull the declaration block for a given selector (up to the closing brace).
function ruleFor(css, selector) {
  const i = css.indexOf(selector);
  if (i === -1) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  return css.slice(open + 1, close).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The fixed-layout opt-in
// ─────────────────────────────────────────────────────────────────────────────

test('.admin-table--colsized switches to table-layout: fixed', () => {
  const rule = ruleFor(CSS_SRC, '.admin-table--colsized {');
  assert.ok(rule, '.admin-table--colsized rule must exist');
  assert.match(rule, /table-layout:\s*fixed/, 'must set table-layout: fixed');
});

test('Name is the sole elastic absorber under colsized (width:auto, no max)', () => {
  const rule = ruleFor(CSS_SRC, '.admin-table--colsized td.col-w-name,');
  assert.ok(rule, 'colsized Name override must exist');
  assert.match(rule, /width:\s*auto/, 'Name must be width:auto so it absorbs surplus');
  assert.match(rule, /max-width:\s*none/, 'Name must drop its max-width cap to soak up width');
  // …and the truncate span must be allowed to grow into that reclaimed room.
  assert.match(
    CSS_SRC,
    /\.admin-table--colsized td\.col-w-name \.cell-truncate\s*\{[^}]*max-width:\s*none/,
    'the Name truncate span must lose its 280px cap under colsized'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SKU + Brand are tightened, and stay safe (wrap, never clip)
// ─────────────────────────────────────────────────────────────────────────────

test('SKU column is 96px and still wraps long SKUs', () => {
  const rule = ruleFor(CSS_SRC, '.admin-table td.col-w-sku,');
  assert.ok(rule, 'col-w-sku rule must exist');
  assert.match(rule, /width:\s*96px/, 'SKU width must be 96px (was 120px)');
  assert.match(rule, /min-width:\s*96px/, 'SKU min-width must be 96px');
  assert.match(rule, /word-break:\s*break-all/, 'long SKUs must still wrap, not overflow');
});

test('Brand column is 88px and wraps long brand badges instead of clipping', () => {
  const rule = ruleFor(CSS_SRC, '.admin-table td.col-w-brand,');
  assert.ok(rule, 'col-w-brand rule must exist');
  assert.match(rule, /width:\s*88px/, 'Brand width must be 88px (was 90px)');
  assert.match(rule, /min-width:\s*88px/, 'Brand min-width must be 88px');
  // The badge must be allowed to wrap so Panasonic / Triumph-adler don't clip.
  assert.match(
    CSS_SRC,
    /\.admin-table td\.col-w-brand \.admin-badge\s*\{[^}]*white-space:\s*normal/,
    'brand badge must be white-space:normal so long brands wrap rather than clip'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The "exactly one absorber" invariant — every other column has a width
// ─────────────────────────────────────────────────────────────────────────────
//
// table-layout:fixed only behaves if Name is the ONLY auto-width column. Any
// column the products table renders without an explicit width would steal a
// share of the surplus and re-introduce slack. Pin that each width class in
// play carries a width, including the two that have no col-w-* class.

test('every non-Name column carries an explicit width', () => {
  // Width classes referenced by the products column set.
  const widthClasses = [
    'col-w-sku', 'col-w-brand', 'col-w-price', 'col-w-pct',
    'col-w-type', 'col-w-dot', 'col-w-compat', 'col-w-fuin',
  ];
  for (const cls of widthClasses) {
    const re = new RegExp(`\\.admin-table td\\.${cls}[^{]*\\{[^}]*width:\\s*\\d+px`);
    assert.match(CSS_SRC, re, `${cls} must declare a px width`);
  }
  // The checkbox + image columns use bespoke classes, not col-w-*.
  assert.match(CSS_SRC, /\.admin-table \.cell-select\s*\{[^}]*width:\s*40px/, 'cell-select must be 40px wide');
  assert.match(CSS_SRC, /\.admin-table \.cell-image\s*\{[^}]*width:\s*60px/, 'cell-image must be 60px wide');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DataTable wiring — tableClass plumbed through both render paths
// ─────────────────────────────────────────────────────────────────────────────

test('DataTable appends config.tableClass in the loading + main render paths', () => {
  const occurrences = TABLE_SRC.match(
    /class="admin-table\$\{this\.config\.tableClass \? ' ' \+ this\.config\.tableClass : ''\}"/g
  );
  assert.ok(occurrences, 'tableClass must be interpolated onto the <table>');
  assert.equal(occurrences.length, 2, 'both setLoading() and _render() must honour tableClass');
});

test('products page opts into the fixed-layout class', () => {
  assert.match(
    PRODUCTS_SRC,
    /tableClass:\s*'admin-table--colsized'/,
    'products DataTable must pass tableClass: admin-table--colsized'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cache-bust tokens were bumped so the new CSS/JS actually ship
// ─────────────────────────────────────────────────────────────────────────────

test('admin.css cache token is shared and current across admin pages', () => {
  const adminHtmlDir = path.join(ROOT, 'inkcartridges/html/admin');
  const files = fs.readdirSync(adminHtmlDir).filter(f => f.endsWith('.html'));
  let referencing = 0;
  for (const f of files) {
    const html = fs.readFileSync(path.join(adminHtmlDir, f), 'utf8');
    if (!/admin\.css\?v=/.test(html)) continue;
    referencing++;
    // Token last bumped for the website-traffic load-retry empty-state (May 2026).
    assert.match(html, /admin\.css\?v=load-retry-may2026/, `${f} must use the bumped admin.css token`);
    assert.doesNotMatch(html, /admin\.css\?v=col-compact-may2026/, `${f} must drop the stale token`);
    assert.doesNotMatch(html, /admin\.css\?v=traffic-over-time-may2026/, `${f} must drop the prior token`);
    assert.doesNotMatch(html, /admin\.css\?v=traffic-bars-may2026/, `${f} must drop the prior token`);
    assert.doesNotMatch(html, /admin\.css\?v=skeleton-load-may2026/, `${f} must drop the prior token`);
  }
  assert.ok(referencing >= 10, `expected the token across the admin pages, saw ${referencing}`);
});

test('products page imports the bumped table.js token; APP_VERSION advanced', () => {
  assert.match(PRODUCTS_SRC, /components\/table\.js\?v=col-compact-may2026/,
    'products.js must import the bumped table.js version');
  const APP_SRC = READ('inkcartridges/js/admin/app.js');
  assert.match(APP_SRC, /APP_VERSION\s*=\s*'2026\.05\.23-load-retry'/,
    'APP_VERSION must be bumped so the SPA page modules re-fetch');
});
