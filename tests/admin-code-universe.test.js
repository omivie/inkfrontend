/**
 * The code universe — Jul 2026
 * ============================
 *
 * Both code surfaces (the Product Codes page and the product drawer's tab) used
 * to show only ONE brand+category's chips, so ~1,200 of the ~1,214 codes that
 * exist were unreachable from either. AdminAPI.getCodeUniverse() is the shared
 * catalogue that fixed that.
 *
 * The tests below pin the three things that are easy to "optimise" back into
 * bugs:
 *
 *   1. THE SOURCE. The universe is a fan-out of /api/shop's `series[]`. It is
 *      tempting to rebuild it from a /api/products walk instead — one endpoint,
 *      21 pages, carries series_codes. That walk drops every merged PAIR code
 *      (PG40/CL41, PGI5/CLI8 — 18 of them): the backend synthesises those at
 *      series[] aggregation time and NO product carries one in series_codes.
 *      They are precisely the codes these surfaces exist to fix. Verified live.
 *
 *   2. THE SLASH. Codes normalise through AdminAPI.normalizeProductCode, which
 *      keeps "/". The drawer used to strip it locally, turning PG40/CL41 into
 *      PG40CL41 — a code no product carries, so toggling it wrote a dead override
 *      and renaming it silently touched nothing (ERR-061, fixed on the page, left
 *      live in the drawer because pair codes never reached it until now).
 *
 *   3. THE SCOPES. A code is not unique to one brand+category — 41 span several
 *      (HP's "410" ink, Brother's "410" toner). Every entry carries `scopes`, and
 *      every write walks THEM, not whatever brand the current view happens to
 *      show. A write scoped to the wrong brand finds nobody and reports success.
 *
 * Run: node --test tests/admin-code-universe.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const API = read('inkcartridges/js/admin/api.js');
const PAGE = read('inkcartridges/js/admin/pages/product-codes.js');
const PRODUCTS = read('inkcartridges/js/admin/pages/products.js');
const UTILS = read('inkcartridges/js/admin/utils/product-codes.js');

/** The body of a named method on the AdminAPI object literal. */
function method(src, name) {
  const start = src.indexOf(`  async ${name}(`) >= 0
    ? src.indexOf(`  async ${name}(`)
    : src.indexOf(`  ${name}(`);
  assert.ok(start > -1, `expected a ${name}() method`);
  const end = src.indexOf('\n  },', start);
  assert.ok(end > start, `could not find the end of ${name}()`);
  return src.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The universe exists and is built from /api/shop series
// ─────────────────────────────────────────────────────────────────────────────

test('AdminAPI exposes getCodeUniverse()', () => {
  assert.match(API, /async getCodeUniverse\(\s*\{[^}]*\}\s*=\s*\{\}\s*\)/,
    'AdminAPI.getCodeUniverse({ force }) must exist');
});

test('the universe is built from getShopData series, NOT from a /api/products walk', () => {
  const body = method(API, 'getCodeUniverse');
  assert.match(body, /window\.API\.getShopData\(\s*\{\s*brand:\s*brandSlug,\s*category\s*\}\s*\)/,
    'the universe must fan out getShopData({brand, category}) — that is the only source of the merged pair chips');
  assert.match(body, /data\.series/,
    'it must read data.series — the aggregate, not the products');
  assert.ok(!/\/api\/products/.test(body),
    'a /api/products walk carries NO merged pair codes (PG40/CL41) — it is not a valid source for the universe');
});

test('the fan-out does NOT pass limit — that URL misses CF and 504s on Canon', () => {
  const body = method(API, 'getCodeUniverse');
  assert.ok(!/getShopData\([^)]*limit/.test(body),
    'limit=1 looks free (series[] is an aggregate) but mints a cache key nothing else uses: it always misses CF, '
    + 'and api.inkcartridges.co.nz answered 504 for brand=canon&category=ink on it EVERY time — silently dropping '
    + 'the one brand whose merged pair codes this feature exists to fix. Send the storefront\'s shape.');
});

test('the fan-out is gentle and backs off — a burst gets 429d', () => {
  const body = method(API, 'getCodeUniverse');
  const n = Number(body.match(/const CONCURRENCY\s*=\s*(\d+)/)[1]);
  assert.ok(n <= 4, `CONCURRENCY must stay small (got ${n}) — at 12, the origin 429d and the build lost 40 of its 51 pairs`);
  assert.match(body, /const ATTEMPTS\s*=\s*\d+/, 'a failed pair must be retried');
  assert.match(body, /await backoff\(attempt - 1\)/,
    'the retry must WAIT — hammering through a 429 just earns another one');
});

test('the fan-out only covers brand+category pairs that have products', () => {
  const body = method(API, '_codeUniverseScopes');
  assert.match(body, /from\('products'\)[\s\S]{0,80}select\('brand_id, product_type'\)/,
    'pair discovery reads products(brand_id, product_type)');
  assert.match(body, /\.range\(from,\s*from \+ PAGE - 1\)/,
    'PostgREST caps a read at 1000 rows — the discovery must page');
  assert.match(body, /PRODUCT_TYPE_TO_SHOP_CATEGORY\[/,
    'product_type must map to its /shop category; types with none drill down nowhere');
});

test('concurrency is bounded — 51 parallel fetches from the SPA is how we got 429s before', () => {
  const body = method(API, 'getCodeUniverse');
  assert.match(body, /const CONCURRENCY\s*=\s*\d+/, 'the fan-out must cap concurrency');
  const n = Number(body.match(/const CONCURRENCY\s*=\s*(\d+)/)[1]);
  assert.ok(n >= 2 && n <= 12, `CONCURRENCY should be a small cap, got ${n}`);
});

test('a pair that will not load is REPORTED, never silently skipped', () => {
  // The whole bug class this feature keeps tripping over: a fail-soft that
  // quietly omits data. The first build skipped Canon and looked perfectly
  // healthy — 1,300 codes, no Canon in them.
  const body = method(API, 'getCodeUniverse');
  assert.match(body, /missed\.push\(\{ brandSlug, category \}\)/,
    'a pair that fails every attempt must land in `missed` so the UI can own up to it');
  assert.match(body, /const universe = \{ codes, missed \}/,
    'getCodeUniverse returns { codes, missed } — completeness is part of the answer');
  assert.match(body, /if \(!ok\) return null;/,
    'a wholly failed build returns null so callers fall back rather than show an empty catalogue');
});

test('a partial catalogue is never banked in the cache', () => {
  const body = method(API, 'getCodeUniverse');
  assert.match(body, /if \(!missed\.length\) this\._writeCodeUniverseCache\(universe\)/,
    'caching a partial build would freeze a transient outage into the UI for hours');
});

test('both surfaces admit when the catalogue is incomplete', () => {
  assert.match(PAGE, /_missed = universe\.missed \|\| \[\]/, 'the page tracks what failed to load');
  assert.match(PAGE, /This list is incomplete/,
    'the page must say so — a grid missing a brand looks exactly like a healthy one');
  assert.match(PRODUCTS, /missedScopes = catalogue\.missed \|\| \[\]/, 'the drawer tracks it too');
  assert.match(PRODUCTS, /didn’t load — codes from there are missing below/,
    'the drawer must say so in the "every other code" section');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Entries carry scopes, and writes follow them
// ─────────────────────────────────────────────────────────────────────────────

test('each entry carries code, count and scopes', () => {
  const body = method(API, 'getCodeUniverse');
  assert.match(body, /\{\s*code,\s*count:\s*0,\s*scopes:\s*\[\]\s*\}/,
    'an entry is { code, count, scopes[] }');
  assert.match(body, /entry\.scopes\.push\(\{\s*brandSlug,\s*category\s*\}\)/,
    'every brand+category a code appears in must be recorded');
});

test('the page renames/deletes over the CODE\'s scopes, not the pickers', () => {
  assert.match(PAGE, /async function applyCodeChange\(entry, toCode\)/,
    'applyCodeChange must take the entry (which knows its scopes), not a bare code string');
  assert.match(PAGE, /for \(const s of scopes\)[\s\S]{0,200}?applyBrandCodeChange\(\{[\s\S]{0,80}?brandSlug: s\.brandSlug,\s*category: s\.category/,
    'the write must loop the code\'s scopes — the pickers default to All, so there is no implied scope');
  assert.ok(!/applyBrandCodeChange\(\{[\s\S]{0,60}brandSlug: _brandSlug/.test(PAGE),
    'passing the picker\'s brand would edit the wrong products (or none) for any code that lives elsewhere');
});

test('the drawer renames/deletes over the CODE\'s scopes, not the product\'s', () => {
  assert.match(PRODUCTS, /const scopes = \(entry && entry\.scopes && entry\.scopes\.length\) \? entry\.scopes : \[ownScope\]/,
    'doBrandChange must resolve the tile\'s own scopes');
  assert.match(PRODUCTS, /for \(const s of scopes\)[\s\S]{0,240}?applyBrandCodeChange\(\{[\s\S]{0,120}?brandSlug: s\.brandSlug/,
    'a foreign tile belongs to another brand — using this product\'s brandSlug would walk an empty scope and report "0 products"');
});

test('membership hands each product back to the scope it came from', () => {
  assert.match(PAGE, /listBrandCategoryProducts\(\{\s*brandSlug: s\.brandSlug,\s*category: s\.category\s*\}\)/,
    'the candidate pool is the union across the code\'s scopes');
  assert.match(PAGE, /setCodeMembership\(\{\s*\n?\s*brandSlug: b\.scope\.brandSlug,\s*category: b\.scope\.category/,
    'setCodeMembership re-walks ONE brand+category, so the save must batch by scope');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The slash survives (ERR-061)
// ─────────────────────────────────────────────────────────────────────────────

test('the drawer normalises through AdminAPI.normalizeProductCode — no local slash-stripping', () => {
  assert.match(PRODUCTS, /const norm = \(raw\) => AdminAPI\.normalizeProductCode\(raw\)/,
    'the drawer must use the shared normaliser');
  assert.ok(!/replace\(\/\[\^A-Z0-9\]\/g, ''\)/.test(PRODUCTS),
    'stripping "/" turns PG40/CL41 into PG40CL41 — a code no product carries (ERR-061)');
});

test('the page normalises through AdminAPI.normalizeProductCode too', () => {
  assert.match(PAGE, /const norm = s => AdminAPI\.normalizeProductCode\(s\)/,
    'the page must use the shared normaliser');
});

test('normalizeProductCode keeps the slash', () => {
  const body = method(API, 'normalizeProductCode');
  assert.match(body, /replace\(\/\[\^A-Z0-9\/\]\/g, ''\)/,
    'the character class must permit "/" — merged pair chips are real codes');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cache invalidation
// ─────────────────────────────────────────────────────────────────────────────

test('every code write invalidates the universe snapshot', () => {
  const clear = method(API, '_clearStorefrontCodeCache');
  assert.match(clear, /this\._clearCodeUniverseCache\(\)/,
    'a rename adds one code and drops another — the cached universe is stale the moment anything is written');

  const set = method(API, 'setProductCodes');
  assert.match(set, /this\._clearStorefrontCodeCache\(\)/,
    'setProductCodes is the choke point for EVERY code write (including the drawer\'s Save, which reaches it directly) — invalidate there so no caller can forget');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scope labels
// ─────────────────────────────────────────────────────────────────────────────

test('describeScopes names every scope a code lives in', () => {
  assert.match(UTILS, /export function describeScopes\(scopes, brandName/,
    'a shared scope formatter keeps the page and the drawer saying the same thing');
  assert.match(UTILS, /export function categoryLabel\(value\)/,
    'category → label must be shared, not re-derived per page');
});

test('tiles and delete confirms show the scope', () => {
  assert.match(PAGE, /admin-pc-code__scope/,
    'a page tile must say which brand+type its code belongs to');
  assert.match(PAGE, /Delete \$\{esc\(c\.code\)\} from \$\{esc\(scopesOf\(c\)\)\}/,
    'the delete confirm must name the scopes it will reach');
  assert.match(PRODUCTS, /const where = describeScopes\(c\.scopes, brandNameOf\)/,
    'the drawer\'s delete confirm must name the scopes it will reach');
});
