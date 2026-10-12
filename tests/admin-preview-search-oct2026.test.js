/**
 * ERR-317 — an admin could not see the admin-only test products on /search.
 *
 * Two causes, measured 2026-10-12 with a super_admin session:
 *   1. AdminPreview's capability check read /api/admin/catalog/shop?limit=1,
 *      which now answers 400 "Brand is required" ⇒ state 'unreachable' ⇒
 *      preview off for every admin on every page.
 *   2. /api/search/smart never returns TEST-/ADMIN- rows, even on the mirror.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codeOnly = require('./helpers/strip-comments.js');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('AdminPreview capability check does not use /shop (needs a brand, 400s without one)', () => {
  const src = read('inkcartridges/js/utils.js');
  const run = src.slice(src.indexOf('async _run()'), src.indexOf('_set(state, detail)'));
  assert.ok(run.length > 0, 'AdminPreview._run not found');
  assert.match(run, /API\.get\('\/api\/admin\/catalog\/products\?limit=1'\)/);
  assert.doesNotMatch(run, /catalog\/shop/);
});

test('search page adds admin-only rows from the literal route for a granted admin', () => {
  const src = read('inkcartridges/js/shop-page.js');
  const fn = src.slice(src.indexOf('async loadSearchResults('));
  const i = fn.indexOf('AdminPreview?.isGranted?.()');
  assert.ok(i > 0, 'admin-only lookup missing from loadSearchResults');
  const block = fn.slice(i - 60, i + 1500);
  assert.match(block, /requestedPage === 1/);
  assert.match(block, /\^\(TEST\|ADMIN\)-/);
  assert.match(block, /products = adminRows\.concat\(products\)/);
  assert.match(block, /DebugLog\.warn/, 'a failed lookup must be loud');
});

test('AdminPreview waits for Auth to restore the session before deciding "anonymous"', () => {
  const src = read('inkcartridges/js/utils.js');
  const run = src.slice(src.indexOf('async _run()'), src.indexOf('_set(state, detail)'));
  const wait = run.indexOf('Auth.readyPromise');
  const decide = run.indexOf("this._set('anonymous')");
  assert.ok(wait > 0, 'no wait on Auth.readyPromise');
  assert.ok(wait < decide, 'the wait must come before the anonymous verdict');
  assert.match(run, /Promise\.race\(\[Auth\.readyPromise/, 'the wait must be capped');
});
