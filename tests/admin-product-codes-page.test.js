/**
 * Product Codes page — wiring contract (Jul 2026)
 * ===============================================
 *
 * /admin#product-codes edits the /shop drilldown chips by CODE rather than by
 * product. It is owner-only, so it must be registered in BOTH gates (the nav flag
 * and the route's ownerPages array — they are independent lists, and updating only
 * one ships either an invisible page or an unguarded one). The cache-busting
 * versions must be bumped or live browsers never load the new module at all.
 *
 * It also pins the two hazards this page is built around:
 *   • ERR-046 — page modules import ../app.js BARE. A ?v= there gives app.js a
 *     second module URL, boot() runs twice, and the admin 429s itself.
 *   • ERR-045 — every await must be followed by a liveness re-check, or a reply
 *     that lands after the user navigated away renders into a dead container.
 *
 * Run with: node --test tests/admin-product-codes-page.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const read = (p) => fs.readFileSync(p, 'utf8');

const appJs = read(path.join(ADMIN, 'app.js'));
const pageJs = read(path.join(ADMIN, 'pages', 'product-codes.js'));
const utilJs = read(path.join(ADMIN, 'utils', 'product-codes.js'));
const cssSrc = read(path.join(ROOT, 'inkcartridges', 'css', 'admin.css'));
const indexHtml = read(path.join(ROOT, 'inkcartridges', 'html', 'admin', 'index.html'));

// ── Registration ─────────────────────────────────────────────────────────────

test('nav registers an owner-only Product Codes item under Catalog & Data Ops', () => {
  assert.match(appJs, /key:\s*'product-codes'[^}]*ownerOnly:\s*true/,
    'NAV_ITEMS must have an owner-only product-codes entry');

  const catalogIdx = appJs.indexOf("section: 'Catalog & Data Ops'");
  const systemIdx = appJs.indexOf("section: 'System'");
  const pageIdx = appJs.indexOf("key: 'product-codes'");
  assert.ok(catalogIdx > 0 && pageIdx > catalogIdx && pageIdx < systemIdx,
    'product-codes belongs to the Catalog & Data Ops section');
});

test('route gate blocks #product-codes for non-owners', () => {
  const m = appJs.match(/const ownerPages = \[([^\]]*)\]/);
  assert.ok(m, 'ownerPages array must exist');
  assert.match(m[1], /'product-codes'/,
    "ownerPages must include 'product-codes' so a typed/bookmarked hash is gated too");
});

test('the page module exists and exports the router contract', () => {
  assert.match(pageJs, /export default/);
  assert.match(pageJs, /async init\(/);
  assert.match(pageJs, /destroy\(\)/);
  assert.match(pageJs, /title:\s*'Product Codes'/);
});

test('cache-busting versions were bumped off the previous release', () => {
  const appVer = appJs.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.notEqual(appVer, '2026.07.12-invoice-cogs', 'APP_VERSION must be bumped');
  assert.match(appVer, /^\d{4}\.\d{2}\.\d{2}/, 'APP_VERSION keeps the date-prefixed format');

  // The page module is imported as ./pages/<key>.js?v=${APP_VERSION}, but app.js
  // itself is only re-fetched if index.html's own ?v= moves.
  assert.doesNotMatch(indexHtml, /app\.js\?v=2026-07-12a\b/, "index.html app.js ?v= must be bumped");
  assert.doesNotMatch(indexHtml, /admin\.css\?v=2026-07-11a\b/, 'index.html admin.css ?v= must be bumped');
});

// ── Hazards ──────────────────────────────────────────────────────────────────

test('the page imports ../app.js BARE — a ?v= there double-boots the admin', () => {
  // ERR-046: a versioned import gives app.js a second module URL, so boot() runs
  // twice and the admin rate-limits itself.
  assert.match(pageJs, /from '\.\.\/app\.js'/);
  assert.doesNotMatch(pageJs, /from '\.\.\/app\.js\?v=/,
    'page modules must import the shell without a version query');
});

test('async work is guarded against a destroyed page (ERR-045)', () => {
  assert.match(pageJs, /let _alive = false/);
  assert.match(pageJs, /_loadToken/, 'a monotonic token drops superseded loads');
  assert.match(pageJs, /if \(!_alive\|\|| if \(!_alive\)/,
    'liveness is re-checked after awaits');

  const destroy = pageJs.slice(pageJs.indexOf('destroy()'));
  assert.match(destroy, /_alive = false/);
  assert.match(destroy, /_loadToken\+\+/, 'bump the token so in-flight replies are ignored');
  assert.match(destroy, /Drawer\.close\(\)/, 'an open membership drawer must not survive navigation');
});

// ── Behaviour the page exists for ────────────────────────────────────────────

test('the page offers rename, delete, membership and add', () => {
  assert.match(pageJs, /data-act="rename-go"/, 'rename');
  assert.match(pageJs, /data-act="delete-go"/, 'delete');
  assert.match(pageJs, /data-act="members"/, 'a tile click edits which products carry the code');
  assert.match(pageJs, /promptNewCode/, '+ Add code');

  assert.match(pageJs, /AdminAPI\.applyBrandCodeChange\(/, 'rename/delete cascade brand-wide');
  assert.match(pageJs, /AdminAPI\.setCodeMembership\(/, 'membership writes the add/remove diff');
  assert.match(pageJs, /AdminAPI\.listBrandCategoryProducts\(/, 'the candidate pool');
});

test('a zero-product result is reported, not swallowed', () => {
  // This is the exact silent failure the slash fix addresses: before Jul 2026,
  // renaming PG40/CL41 normalised it to PG40CL41, matched nothing, and reported
  // success anyway. A walk that finds nobody must say so.
  assert.match(pageJs, /if \(!products\)/);
  assert.match(pageJs, /nothing changed/i);
});

test('the page lists EVERY code, and searches them', () => {
  // Until Jul 2026 the page was hard-scoped to one brand+category, so ~1,200 of
  // the ~1,214 codes that exist could not be seen or found from here.
  assert.match(pageJs, /AdminAPI\.getCodeUniverse\(/,
    'the grid is the whole catalogue, not one brand+category slice');
  assert.match(pageJs, /id="pcp-filter"/, 'and a search box narrows it');
  assert.match(pageJs, /SHOP_CATEGORIES/, 'categories come from the shared util');
});

test('the brand and type pickers are FILTERS, defaulting to All', () => {
  assert.match(pageJs, /id="pcp-brand"/);
  assert.match(pageJs, /id="pcp-category"/);
  assert.match(pageJs, /<option value="">All brands<\/option>/,
    'brand must offer All — a code you cannot find reads as a code that does not exist');
  assert.match(pageJs, /<option value="">All types<\/option>/, 'type must offer All');
});

test('a filter never survives the visit that set it', () => {
  // _brandSlug/_category are module-level and outlive navigation. Left alone,
  // last visit's narrowing silently carries over: you return, see a slice, and
  // read it as the whole catalogue.
  const destroyAt = pageJs.indexOf('\n  destroy() {');
  const init = pageJs.slice(pageJs.indexOf('async init('), destroyAt);
  assert.match(init, /_brandSlug = ''/, 'init must reset the brand filter');
  assert.match(init, /_category = ''/, 'init must reset the type filter');

  const destroy = pageJs.slice(destroyAt);
  assert.match(destroy, /_brandSlug = ''/, 'destroy must reset it too');
  assert.match(destroy, /_category = ''/, 'destroy must reset it too');

  assert.ok(!/_category = 'ink'/.test(pageJs), 'no sticky Canon/ink default');
});

test('the override caveat is surfaced, not hidden', () => {
  // Deleting a backend-derived code only overrides it on the storefront — a future
  // import can re-derive it. Users must not be told a deletion is permanent.
  const m = pageJs.match(/admin-pcp-caveat">([\s\S]*?)<\/p>/);
  assert.ok(m, 'the caveat paragraph must be rendered');
  assert.match(m[1], /come back after a product import/i,
    'the caveat must name the import that can resurrect a deleted code');
  assert.match(m[1], /only overrides them/i,
    'and must not imply a deletion is permanent');
  assert.match(cssSrc, /\.admin-pcp-caveat/, 'and it is styled');
});

test('the page reuses the drawer tab’s chip CSS rather than forking it', () => {
  for (const cls of ['admin-pc-grid', 'admin-pc-code', 'admin-pc-act', 'admin-pc-rename']) {
    assert.match(pageJs, new RegExp(cls), `page emits .${cls}`);
    assert.match(cssSrc, new RegExp(`\\.${cls}`), `.${cls} exists in admin.css`);
  }
  // The new-to-this-page classes must also be styled, or the membership drawer
  // renders as unstyled checkboxes.
  for (const cls of ['admin-pcm-row', 'admin-pcm-list', 'admin-pcp-note']) {
    assert.match(cssSrc, new RegExp(`\\.${cls}`), `.${cls} must be styled`);
  }
});

test('the shared util exposes what both surfaces need', () => {
  assert.match(utilJs, /export const PRODUCT_TYPE_TO_SHOP_CATEGORY/);
  assert.match(utilJs, /export const SHOP_CATEGORIES/);
  assert.match(utilJs, /export function isValidProductCode/);
  assert.match(utilJs, /export function describeCodesWriteError/);
});
