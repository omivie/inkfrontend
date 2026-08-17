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

/**
 * Columns verified to EXIST on the live `products` table (2026-08-17). The
 * explicit list is only safer than `*` if every name in it is real — PostgREST
 * 400s the whole query on an unknown column, which would be a worse outage than
 * the one being fixed. Nine plausible-sounding fields were rejected during this
 * work precisely because they are API-computed and not table columns:
 * in_stock, average_rating, review_count, canonical_url, original_price,
 * discount_amount, discount_percent, cost_per_page_display,
 * image_thumbnail_url, image_srcset.
 */
const REAL_COLUMNS = new Set([
    'id', 'sku', 'name', 'slug', 'retail_price', 'compare_price', 'image_url',
    'color', 'color_hex', 'pack_type', 'source', 'product_type',
    'stock_quantity', 'stock_status', 'is_active',
]);

/** Fields that are NOT columns on `products` — including one in the query would 400 it. */
const NOT_COLUMNS = [
    'in_stock', 'average_rating', 'review_count', 'canonical_url', 'original_price',
    'discount_percent', 'cost_per_page_display', 'image_thumbnail_url', 'image_srcset',
];

function relatedColsLiteral() {
    const m = /const RELATED_COLS = ([\s\S]*?);/.exec(src);
    assert.ok(m, 'RELATED_COLS must exist as a named constant, not an inline string');
    // Collapse the concatenated string literal into the actual column list.
    return m[1].replace(/['"`+\s]+/g, ' ').trim();
}

// ─── 1. No wildcard ────────────────────────────────────────────────────────

test('the curated lookup no longer selects *', () => {
    assert.ok(!/\.from\('products'\)[\s\S]{0,120}?\.select\('\*'\)/.test(src),
        "select('*') on products breaks for anon once cost_price is revoked");
});

test('there is no select(*) anywhere in the PDP', () => {
    const matches = src.match(/\.select\(\s*['"`]\s*\*/g) || [];
    assert.deepEqual(matches, [], 'a wildcard select returns cost_price implicitly');
});

// ─── 2. The explicit list is correct, and only contains real columns ────────

test('RELATED_COLS lists only columns that actually exist on products', () => {
    const cols = relatedColsLiteral()
        .replace(/brand:brands\([^)]*\)/, '')          // the aliased join is not a column
        .split(',').map((c) => c.trim()).filter(Boolean);
    const bogus = cols.filter((c) => !REAL_COLUMNS.has(c));
    assert.deepEqual(bogus, [],
        'an unknown column is a hard 400 — strictly worse than the wildcard this replaced:\n  '
        + bogus.join('\n  '));
});

test('RELATED_COLS contains none of the API-computed fields that would 400 the query', () => {
    const literal = relatedColsLiteral();
    const bad = NOT_COLUMNS.filter((c) => new RegExp(`\\b${c}\\b`).test(literal));
    assert.deepEqual(bad, [], 'these are computed by the API and are not table columns');
});

test('RELATED_COLS carries no cost-bearing column', () => {
    const literal = relatedColsLiteral();
    for (const c of ['cost_price', 'profit_ex_gst', 'margin_pct']) {
        assert.ok(!new RegExp(`\\b${c}\\b`).test(literal), `${c} must never reach the storefront`);
    }
});

test('RELATED_COLS covers what the card renderer actually reads', () => {
    const literal = relatedColsLiteral();
    // Products.renderCard + its helpers + the PDP's own inferSource/inferProductType.
    for (const needed of ['sku', 'name', 'slug', 'retail_price', 'image_url',
        'color', 'pack_type', 'source', 'product_type', 'stock_status']) {
        assert.match(literal, new RegExp(`\\b${needed}\\b`),
            `renderCard reads ${needed}; dropping it silently degrades the card`);
    }
});

test('the brands join is ALIASED to `brand`, because the renderer reads product.brand?.name', () => {
    assert.match(relatedColsLiteral(), /brand:brands\(\s*name\s*,\s*slug\s*\)/,
        'an unaliased brands(...) join arrives as `brands` and the brand line renders empty');
});

// ─── 3. The error is captured, not discarded ───────────────────────────────

test('the curated lookup destructures `error` and acts on it', () => {
    assert.match(src, /const \{ data: manualProducts, error: manualError \} = await sb\.from\('products'\)/,
        'dropping `error` is what made a permissions failure look like an empty curation');
    assert.match(src, /if \(manualError\)/, 'and it must be checked');
});

test('a failed curated lookup sets fetchFailed — an outage is not an empty result', () => {
    const i = src.indexOf('if (manualError)');
    const block = src.slice(i, i + 300);
    assert.match(block, /fetchFailed = true/,
        'the rail must record that it could not ask, so the empty state is not claimed');
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
