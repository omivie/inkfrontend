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
  assert.match(PDP, /if \(manualCodes\.length\) this\.product\.series_codes = manualCodes;/,
    'a non-empty override fully replaces series_codes — matching /shop\'s "codes set here replace the auto-detected ones"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ribbons resolve related products by code (no longer code-blind)
// ─────────────────────────────────────────────────────────────────────────────

test('the api category map routes ribbons to the ribbons shop category', () => {
  assert.match(PDP, /apiCategoryMap = \{[^}]*ribbon:\s*'ribbons'[^}]*\}/,
    'ribbon must map to the ribbons /shop category so a code lookup is possible');
});

test('the ribbon branch fetches the shared-code family AND keeps curated SKUs', () => {
  // Curated list preserved (no regression for hand-set ribbons).
  assert.match(PDP, /const manualSkus = info\.related_product_skus;/,
    'curated related_product_skus must still be honoured');
  // Code family fetched, scoped to the ribbon's own brand + ribbons.
  const ribbonBranch = PDP.slice(PDP.indexOf("if (info.category === 'ribbon') {"),
    PDP.indexOf('} else {', PDP.indexOf("if (info.category === 'ribbon') {")));
  assert.match(ribbonBranch, /const code = this\.extractProductCode\(info\);/,
    'the ribbon branch must resolve the product code (which now reflects the manual override)');
  assert.match(ribbonBranch, /API\.getShopData\(\{ brand: brandSlug, category: 'ribbons', code, limit: 200 \}\)/,
    'the ribbon branch must pull the same-code family from /shop, scoped to brand + ribbons');
  assert.match(ribbonBranch, /addProducts\(res\.data\.products\.filter\(p => p\.sku !== info\.sku\)\)/,
    'and add them (excluding the current product) through the shared dedup');
});
