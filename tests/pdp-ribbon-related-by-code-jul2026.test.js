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

// UPDATE (ERR-294, 2026-09-28): §1–§2 are now the BACKEND's job. It applies the
// owner-manual ribbon rule itself (BF-085): a ribbon carries only its
// product_codes override, else `series_codes: []` — measured 691.01/72200.01 → [],
// C-OKI-720-RIB-BK → ["720"], on both /api/ribbons/:sku and /api/products/:sku.
// So the per-product override reader and the PDP's load-merge are DELETED, and
// what these tests pin now is that they stay deleted.

test('the per-product product_codes reader is gone from api.js (BF-085)', () => {
  assert.doesNotMatch(API, /async getManualProductCodes\(|_fetchManualCodesByProduct/,
    'the backend emits override-aware series_codes for ribbons; a second read could only disagree with it');
});

test('the PDP enrichment fallback still fetches the product id', () => {
  assert.match(PDP, /rest\/v1\/products\?sku=eq\.\$\{encodeURIComponent\(this\.product\.sku \|\| sku\)\}&select=id,/,
    'the enrichment select must include id when it runs (a row that arrived without one)');
});

test('the PDP takes series_codes from the product response — no override read on load', () => {
  assert.doesNotMatch(PDP, /API\.getManualProductCodes\(/, 'no PDP-side product_codes read');
  assert.doesNotMatch(PDP, /manualCodes/, 'no load-merge of an override');
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
