/**
 * Admin — ribbon "Related Products" picker — July 2026 (ERR-085)
 * =============================================================
 *
 * Ribbons are owner-curated, not backend-derived. Two shipped changes:
 *
 *   1. PDP (product-detail-page.js): the ribbon branch of renderRelatedProducts
 *      no longer unions a backend code-family fetch — related products come ONLY
 *      from the curated related_product_skus (prefix-tolerant per ERR-084).
 *      (Pinned by tests/pdp-ribbon-related-by-code-jul2026.test.js §3.)
 *
 *   2. Admin (products.js + api.js): a "Related Products" picker in the ribbon
 *      drawer's For Use In tab — previously related_product_skus had NO admin UI
 *      at all (DB-only). A chips list + the shared product autocomplete
 *      (components/product-search.js), seeded from the saved SKUs and persisted
 *      via a direct Supabase write (AdminAPI.setRelatedProductSkus), gated so a
 *      failed seed can never wipe the saved list.
 *
 * These are source-level assertions (products.js is a browser ES module wired to
 * the DOM — not unit-loadable), the same style as
 * tests/pdp-ribbon-related-by-code-jul2026.test.js.
 *
 * Run: node --test tests/admin-related-products-picker-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const PRODUCTS_RAW = read('inkcartridges/js/admin/pages/products.js');
const PRODUCTS = stripComments(PRODUCTS_RAW);
const API = stripComments(read('inkcartridges/js/admin/api.js'));
const PDP = stripComments(read('inkcartridges/js/product-detail-page.js'));

// ── 1. The picker shell lives in the For Use In tab, ribbon-only ────────────
test('products.js imports the shared product autocomplete', () => {
  assert.match(PRODUCTS, /import \{ attachProductAutocomplete \} from '\.\.\/components\/product-search\.js';/);
});

test('the Related Products shell (group / chips / search) is rendered', () => {
  assert.match(PRODUCTS, /id="related-products-group"/);
  assert.match(PRODUCTS, /id="related-products-chips"/);
  assert.match(PRODUCTS, /id="related-product-search"/);
});

test('the shell is appended to forUseInHtml inside the isManualCompat (ribbon) block', () => {
  // forUseInHtml is only extended with ribbon sections under `if (isManualCompat)`.
  const gate = PRODUCTS.indexOf('if (isManualCompat) {');
  const groupIdx = PRODUCTS.indexOf('id="related-products-group"');
  assert.ok(gate !== -1 && groupIdx > gate,
    'the Related Products shell must sit inside the ribbon-only isManualCompat block');
  // And it must be part of the For Use In panel string, not Product Codes.
  assert.match(PRODUCTS, /forUseInHtml \+= `[\s\S]*id="related-products-group"/);
});

test('the helptext states related is manual-only (no backend auto-fill)', () => {
  assert.match(PRODUCTS_RAW, /only<\/strong> related products shown[\s\S]*nothing is auto-filled from the backend/);
});

// ── 2. wireRelatedProductsSection — behaviour contract ──────────────────────
test('wireRelatedProductsSection exists and no-ops for non-ribbon products', () => {
  assert.match(PRODUCTS, /async function wireRelatedProductsSection\(modal, full\) \{/);
  const start = PRODUCTS.indexOf('async function wireRelatedProductsSection');
  const body = PRODUCTS.slice(start, start + 4000);
  assert.match(body, /const group = modal\.querySelector\('#related-products-group'\);\s*\n\s*if \(!group\) return;/,
    'must return early when the ribbon-only shell is absent');
});

test('it is wired into the drawer open flow', () => {
  assert.match(PRODUCTS, /wireRelatedProductsSection\(modal, full\);/);
});

test('selection seeds from related_product_skus and resolves prefix-tolerantly', () => {
  const start = PRODUCTS.indexOf('async function wireRelatedProductsSection');
  const body = PRODUCTS.slice(start, start + 4000);
  assert.match(body, /related_product_skus/, 'must read the saved related SKUs');
  // Exact, then C-, then G-prefixed candidate (mirrors the PDP resolver, ERR-084).
  assert.match(body, /\[up, 'C' \+ up, 'G' \+ up\]/, 'candidate order must be exact → C → G');
});

test('it never relates a product to itself, and chips are alphabetical', () => {
  const start = PRODUCTS.indexOf('async function wireRelatedProductsSection');
  const body = PRODUCTS.slice(start, start + 4000);
  assert.match(body, /key === selfSku/, 'must exclude the product itself');
  assert.match(body, /\.sort\(\(a, b\) => String\(a\.name\)\.localeCompare\(String\(b\.name\)/,
    'chips must be sorted alphabetically by product name');
});

test('a failed seed leaves the loaded flag false so save cannot wipe the list', () => {
  const start = PRODUCTS.indexOf('async function wireRelatedProductsSection');
  const body = PRODUCTS.slice(start, start + 4000);
  assert.match(body, /modal\._relatedProductsLoaded = false;/, 'starts false');
  assert.match(body, /modal\._relatedProductsLoaded = true;/, 'set true only after a clean seed');
  assert.match(body, /modal\._relatedProductSkus = \(\) =>/, 'exposes the picked SKUs to save');
  assert.match(body, /attachProductAutocomplete\(searchEl, \{/, 'wires the shared product autocomplete');
});

test('chip escaping goes through esc()', () => {
  const start = PRODUCTS.indexOf('async function wireRelatedProductsSection');
  const body = PRODUCTS.slice(start, start + 4000);
  assert.match(body, /esc\(p\.name\)/);
  assert.match(body, /esc\(p\.sku\)/);
});

// ── 3. Save + teardown ──────────────────────────────────────────────────────
test('save persists via AdminAPI.setRelatedProductSkus, gated on load + ribbon type', () => {
  assert.match(PRODUCTS,
    /if \(modal\._relatedProductsLoaded && RIBBON_PRODUCT_TYPES\.includes\(data\.product_type\)\) \{[\s\S]*AdminAPI\.setRelatedProductSkus\(product\.id, modal\._relatedProductSkus\(\)\)/,
    'the write must be gated on a clean seed AND ribbon-family type');
});

test('the autocomplete is destroyed on modal close (no leaked document listeners)', () => {
  assert.match(PRODUCTS, /modal\._relatedProductsAc\?\.destroy\?\.\(\)/);
});

// ── 4. AdminAPI.setRelatedProductSkus — direct Supabase write ───────────────
test('AdminAPI.setRelatedProductSkus writes products.related_product_skus directly', () => {
  assert.match(API, /async setRelatedProductSkus\(productId, skus\) \{/);
  const start = API.indexOf('async setRelatedProductSkus');
  const body = API.slice(start, start + 900);
  assert.match(body, /\.from\('products'\)\s*\n?\s*\.update\(\{ related_product_skus: clean\.length \? clean : null \}\)/,
    'must update the column directly (empty → null) — the backend PUT does not round-trip it');
  assert.match(body, /\.eq\('id', productId\)/);
  assert.match(body, /new Set\(\)|seen\.add/, 'SKUs are de-duped before writing');
});

// ── 5. Cross-check: the PDP really is manual-only now ───────────────────────
test('PDP ribbon related is manual-only (no getShopData in the ribbon branch)', () => {
  const ribbon = PDP.slice(
    PDP.indexOf("if (info.category === 'ribbon') {"),
    PDP.indexOf('} else {', PDP.indexOf("if (info.category === 'ribbon') {"))
  );
  assert.doesNotMatch(ribbon, /getShopData/);
  assert.match(ribbon, /info\.related_product_skus/);
});
