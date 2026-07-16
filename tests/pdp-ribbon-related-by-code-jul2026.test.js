/**
 * Ribbon PDP "related products" driven by product codes — Jul 2026
 * ================================================================
 *
 * A code assigned in the admin Product Codes tab had NO effect on a ribbon's
 * PDP "related products" section, for two independent reasons:
 *
 *   1. The ribbon branch of renderRelatedProducts() sourced related products
 *      ONLY from the curated `related_product_skus` column — it never consulted
 *      series_codes / product codes. (Ink/toner already used a code path.)
 *
 *   2. The manual `product_codes` override is merged into series_codes ONLY on
 *      the /shop path (getShopData → _applyManualCodes). The PDP loads via
 *      getProduct/getRibbon, which skip that merge, so the assigned code was
 *      invisible to the PDP entirely.
 *
 * The fix: apply the override on PDP load (API.getManualProductCodes) and give
 * ribbons a code-based related path (curated SKUs first, then the brand+ribbons+code
 * family). These source-level checks pin both halves so neither regresses.
 *
 * UPDATE (ERR-085, Jul 16 2026): the shared-code family union in §3 was RETIRED
 * for ribbons — the owner decided ribbon related products are manual-only, edited
 * in the drawer's For Use In "Related Products" picker. §1–§2 stand (the override
 * reader + PDP load-merge are still used for /shop code parity); §3 now asserts
 * the ribbon branch is curated-only with NO backend code-family call.
 *
 * Run: node --test tests/pdp-ribbon-related-by-code-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const API = read('inkcartridges/js/api.js');
const PDP = read('inkcartridges/js/product-detail-page.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The manual override is readable for a single product
// ─────────────────────────────────────────────────────────────────────────────

test('API exposes getManualProductCodes, reusing the shared override reader', () => {
  assert.match(API, /async getManualProductCodes\(productId\)/,
    'the PDP needs a per-product read of the product_codes override');
  const start = API.indexOf('async getManualProductCodes(');
  const body = API.slice(start, API.indexOf('\n    },', start));
  assert.match(body, /this\._fetchManualCodesByProduct\(\[productId\]\)/,
    'it must delegate to the existing cached anon reader, not fork a second query');
  assert.match(body, /if \(!productId\) return \[\];/,
    'a missing id returns no codes rather than querying for everything');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The PDP applies the override on load (so /shop and the PDP agree)
// ─────────────────────────────────────────────────────────────────────────────

test('the PDP enrichment fetches the product id', () => {
  assert.match(PDP, /rest\/v1\/products\?sku=eq\.\$\{encodeURIComponent\(sku\)\}&select=id,/,
    'the enrichment select must include id — product_codes is keyed by product id, not sku');
});

test('a manual product_codes override replaces series_codes on the PDP', () => {
  assert.match(PDP, /const manualCodes = await API\.getManualProductCodes\(this\.product\.id\)/,
    'the PDP must read the override for the loaded product');
  assert.match(PDP, /if \(manualCodes\.length\)\s*\{?\s*this\.product\.series_codes = manualCodes;/,
    'a non-empty override fully replaces series_codes — matching /shop\'s "codes set here replace the auto-detected ones"');
  // ERR-086: with no override, a ribbon carries NO codes (never a derived fallback).
  assert.match(PDP, /else if \(this\.product\.category === 'ribbon'\)[\s\S]{0,400}?this\.product\.series_codes = \[\];/,
    'a ribbon with no override is cleared to no codes (owner-manual)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ribbon related products are OWNER-CURATED ONLY (ERR-085, Jul 16 2026)
//    The ERR-082 shared-code family union was intentionally RETIRED for ribbons:
//    the owner decided ribbons are manual, not backend-derived. The ribbon branch
//    must now resolve ONLY the curated related_product_skus (still prefix-tolerant
//    per ERR-084) and make NO backend code-family call.
// ─────────────────────────────────────────────────────────────────────────────

const RIBBON_BRANCH = PDP.slice(
  PDP.indexOf("if (info.category === 'ribbon') {"),
  PDP.indexOf('} else {', PDP.indexOf("if (info.category === 'ribbon') {"))
);

test('the ribbon branch still honours the curated related_product_skus', () => {
  assert.match(PDP, /const manualSkus = info\.related_product_skus;/,
    'curated related_product_skus must still feed the ribbon section');
  assert.match(RIBBON_BRANCH, /relatedSkuCandidates\(/,
    'and resolve them prefix-tolerantly (ERR-084)');
});

test('the ribbon branch makes NO backend code-family fetch (manual-only, ERR-085)', () => {
  assert.doesNotMatch(RIBBON_BRANCH, /getShopData/,
    'ribbons must not auto-fill related products from the backend code family');
  assert.doesNotMatch(RIBBON_BRANCH, /extractProductCode/,
    'no code-derived related fetch may remain in the ribbon branch');
});
