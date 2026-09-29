/**
 * Curated related products must not die quietly for signed-out visitors (ERR-170)
 * ==============================================================================
 *
 * A ribbon PDP resolves its owner-curated `related_product_skus` by querying
 * PostgREST directly. That query did two things wrong, and only one of them is
 * about columns:
 *
 *   1. `select('*')` — `products` carries `cost_price` (plus `profit_ex_gst` and
 *      `margin_pct`, which recover it), and the backend is revoking those from
 *      the public `anon` role. Under column-level privileges PostgREST fails the
 *      WHOLE wildcard select with 42501. Signed-IN visitors keep working because
 *      they are the `authenticated` role; signed-OUT visitors get nothing. A bug
 *      that only exists when you are logged out is one nobody testing the admin
 *      will ever see.
 *
 *   2. The error was DISCARDED. `const { data } = await …` dropped `error`, the
 *      optional chaining below swallowed the null, and the rail rendered its
 *      empty state — which reads as "the owner curated nothing for this ribbon".
 *      That is a claim, and we had no basis for it. Worse, the error pane the
 *      non-ribbon path uses was gated on `info.category !== 'ribbon'`, so even
 *      once the flag was set the ribbon path could never show it.
 *
 * Note the ordering risk this file exists to protect: the column fix must be
 * DEPLOYED BEFORE the backend runs the revoke. If the revoke lands first, every
 * curated ribbon rail goes blank for logged-out shoppers and looks like a content
 * problem.
 *
 * Run with: node --test tests/pdp-related-select-columns-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PDP = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');
const src = fs.readFileSync(PDP, 'utf8');

// ─── 1. No wildcard ────────────────────────────────────────────────────────

test('the curated lookup no longer selects *', () => {
    assert.ok(!/\.from\('products'\)[\s\S]{0,120}?\.select\('\*'\)/.test(src),
        "select('*') on products breaks for anon once cost_price is revoked");
});

test('there is no select(*) anywhere in the PDP', () => {
    const matches = src.match(/\.select\(\s*['"`]\s*\*/g) || [];
    assert.deepEqual(matches, [], 'a wildcard select returns cost_price implicitly');
});

// ─── 2. The curated lookup moved to the server (BF-092, ERR-299) ─────────────
// The RELATED_COLS read this file used to pin is GONE: GET /api/ribbons/:sku
// resolves the curated list itself (`related_products`), so no anon read of
// `products` is left for the cost_price revoke to break. What ERR-170 was
// really about — a failed lookup must not read as an empty curation — still
// holds, and is pinned below and RUN in pdp-related-sku-prefix-jul2026.test.js.

test('the ribbon rail makes no direct products read at all', () => {
    assert.doesNotMatch(src, /RELATED_COLS|manualProducts|manualError/);
});

test('a failed curated lookup (related_products null/absent) sets fetchFailed', () => {
    const i = src.indexOf('const curated = ribbonRelatedCards(info);');
    assert.ok(i > -1);
    const block = src.slice(i, i + 400);
    assert.match(block, /if \(curated\.failed\) \{\s*fetchFailed = true;/);
    assert.match(block, /DebugLog\.(error|warn)/, 'and leave something to debug from');
});

test('the ribbon path can now REACH the error pane', () => {
    // The remaining half of the bug: fetchFailed was set but the render was gated
    // on `info.category !== 'ribbon'`, so the flag had no effect on the one path
    // that needed it.
    const iFail = src.indexOf('related.length === 0 && fetchFailed');
    const iCat = src.indexOf("related.length === 0 && info.category !== 'ribbon'");
    assert.ok(iFail > -1, 'a category-independent failure guard must exist');
    assert.ok(iCat > -1, 'and the silent-hide guard must still exist for genuine singletons');
    assert.ok(iFail < iCat, 'the failure guard must come FIRST or ribbons fall through it again');
});

test('a genuinely empty curation still hides silently', () => {
    const m = /if\s*\(related\.length === 0 && info\.category !== 'ribbon'\)\s*\{([\s\S]{0,200}?)\}/.exec(src);
    assert.ok(m, 'the silent path must exist');
    assert.ok(!/_renderRelatedError/.test(m[1]),
        '767 legitimate singletons must not grow an error box');
});

// ─── 4. The other products read is untouched ───────────────────────────────

test('the id-only compatibility lookup is left alone — it was never at risk', () => {
    assert.match(src, /\.from\('products'\)\s*\n?\s*\.select\('id'\)/,
        'selecting a single non-cost column is unaffected by the revoke and should not churn');
});
