/**
 * Series-codes thin extractor — frontend contract tests
 * =====================================================
 *
 * Pins the May 2026 cleanup that follows backend commit 5c99462 (which
 * projects `series_codes` on /api/products in addition to /api/shop).
 *
 * What the cleanup did:
 *   - Bumped the chip cache key from v7 → v8 so any stale v7 in-memory
 *     entries (with phantom combo chips like LC37LC57 / IB3757 / LC39KCMY2
 *     from the deleted fallback ladder) are invalidated on next SPA nav.
 *   - Deleted the 8 client-side fallback branches in
 *     Shop.extractProductCodes that ran when PRIORITY 0 produced no codes:
 *       1. Brand-pattern regex on `name`
 *       2. `manufacturer_part_number` normalization
 *       3. Brother IB-combo split (IB3757 → LC37 + LC57)
 *       4. Brother B-code-from-name inference (B131 → LC131)
 *       5. Brother B-code/IB-code-from-SKU inference
 *       6. Generic single-letter fallback pattern on `name`
 *       7. PRIORITY 5 SKU-prefix-strip
 *       8. PRIORITY 6 last-resort name-split
 *
 * Why this file exists:
 *   The fallback ladder generated phantoms whenever its regex over-matched
 *   a pack name. With backend authoritative on `series_codes`, the ladder
 *   is permanently dead code — but the only thing stopping it from being
 *   silently re-added during a future refactor is a contract test. This
 *   file IS that contract test.
 *
 * Customer-visible expectation:
 *   /shop?brand=brother&category=ink shows exactly the chips the backend
 *   says exist — no LC37LC57, no IB3757, no LC39KCMY2, no "INK-CARTRIDGE"
 *   boilerplate chips, no over-eager fallback regex output.
 *
 * Spec lives in code + tests (the durable source of truth) — there is no
 * standalone markdown handoff doc per the May 2026 no-ghost-files policy.
 *
 * Run: node --test tests/series-codes-thin-extractor-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const SHOP_SRC = fs.readFileSync(JS('shop-page.js'), 'utf8');
const SHOP_CODE = stripComments(SHOP_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// 1. PRIORITY 0 — backend series_codes path is intact
// ─────────────────────────────────────────────────────────────────────────────

test('extractProductCodes reads product.series_codes (PRIORITY 0 path)', () => {
    assert.match(SHOP_CODE, /Array\.isArray\(product\.series_codes\)\s*&&\s*product\.series_codes\.length/,
        'extractProductCodes must consume backend-supplied series_codes');
});

test('extractProductCodes normalizeCode applied to each series_codes entry', () => {
    // The series_codes loop runs each raw entry through normalizeCode so
    // backend "LC131CMY" → "LC131" (color-suffix strip) survives. Deleting
    // this normalization would break the chip merge across colors.
    assert.match(
        SHOP_CODE,
        /for\s*\(const\s+raw\s+of\s+product\.series_codes\)\s*\{[\s\S]{0,200}normalizeCode\(String\(raw[\s\S]{0,200}foundCodes\.add\(code\)/,
        'each raw series_codes entry must be normalized + added to foundCodes'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dead fallback branches — must stay deleted
// ─────────────────────────────────────────────────────────────────────────────

test('extractProductCodes does NOT contain the name-regex fallback branch', () => {
    // The deleted block ran `name.matchAll(pattern)` gated on
    // `foundCodes.size === 0`. Catch any future reintroduction.
    assert.doesNotMatch(SHOP_CODE, /name\.matchAll\(pattern\)/,
        'name-regex fallback branch must stay deleted (relied on per-brand pattern over product name)');
});

test('extractProductCodes does NOT contain the manufacturer_part_number fallback', () => {
    // The deleted block read `mpn` (= product.manufacturer_part_number) and
    // normalized it when foundCodes was empty.
    assert.doesNotMatch(SHOP_CODE, /normalizedMpn/,
        'MPN fallback branch must stay deleted (could re-introduce LC33173-style over-matches)');
});

test('extractProductCodes does NOT split IB-combo codes (IB3757 phantom guard)', () => {
    assert.doesNotMatch(SHOP_CODE, /ibComboPattern/,
        'IB-combo splitter must stay deleted — generated IB3757/LC37LC57 phantoms');
    // Double-check: no Brother-specific "B(\\d{4,})" digit-split logic
    assert.doesNotMatch(SHOP_CODE, /digits\.length\s*\/\s*2/,
        'IB digit-split math must stay deleted (was used to halve IB3757 → 37+57)');
});

test('extractProductCodes does NOT contain the Brother B-code-from-name branch', () => {
    assert.doesNotMatch(SHOP_CODE, /bCodePattern/,
        'B-code-from-name branch must stay deleted (B131 → LC131 inference)');
});

test('extractProductCodes does NOT contain the Brother B-code/IB-code SKU branch', () => {
    // The deleted block parsed `BRO-IB####` and `BRO-B####` out of SKUs.
    assert.doesNotMatch(SHOP_CODE, /BRO-IB\\d/,
        'Brother SKU IB-combo branch must stay deleted');
    assert.doesNotMatch(SHOP_CODE, /skuBCode/,
        'Brother SKU B-code branch must stay deleted');
});

test('extractProductCodes does NOT contain the generic fallback pattern', () => {
    // Deleted: /\b[A-Z]{1,3}[-]?\d{1,4}(?:XL)?[A-Z]{0,3}\b/ with paperSizes guard.
    assert.doesNotMatch(SHOP_CODE, /fallbackPattern/,
        'generic single-letter fallback pattern must stay deleted (was the source of "LC39KCMY2"-class over-matches)');
    assert.doesNotMatch(SHOP_CODE, /paperSizes\s*=\s*new\s+Set\(\['A0'/,
        'paperSizes guard (only used by the fallback pattern) must stay deleted');
});

test('extractProductCodes does NOT contain the PRIORITY 5 SKU-prefix-strip branch', () => {
    // Deleted: the giant per-brand inference block that prepended LC/TN/DR/T/C
    // to a stripped SKU. Identifying signatures:
    assert.doesNotMatch(SHOP_CODE, /PRIORITY 5/,
        'PRIORITY 5 SKU-prefix-strip header comment must be gone');
    assert.doesNotMatch(SHOP_CODE, /okiModelMatch/,
        'OKI-specific SKU-strip helper must stay deleted');
    assert.doesNotMatch(SHOP_CODE, /brandPrefixes\[brand\]/,
        'brandPrefixes lookup (only used by PRIORITY 5) must stay deleted from extractProductCodes');
});

test('extractProductCodes does NOT contain the PRIORITY 6 name-split branch', () => {
    assert.doesNotMatch(SHOP_CODE, /PRIORITY 6/,
        'PRIORITY 6 last-resort header comment must be gone');
    // The boilerplate-strip + split(/\s+/) + slice(0, 3) chain
    assert.doesNotMatch(SHOP_CODE, /Compatible\\s\+\[A-Za-z/,
        'PRIORITY 6 boilerplate-strip regex must stay deleted');
    assert.doesNotMatch(SHOP_CODE, /\.slice\(0,\s*3\)\s*\.join\('-'\)/,
        'PRIORITY 6 token-join must stay deleted (was last source of "INK-CARTRIDGE-REPLACEMENT" chips)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Branches we explicitly KEEP
// ─────────────────────────────────────────────────────────────────────────────

test('extractProductCodes still runs additive SKU sweep (no-op safety net)', () => {
    // The handoff explicitly preserved the un-gated SKU regex — it's a
    // defensive sweep that should only fire if backend ever fails to send
    // series_codes. In steady state it's a no-op (set dedupe).
    assert.match(SHOP_CODE, /pattern\.lastIndex\s*=\s*0[\s\S]{0,200}sku\.matchAll\(pattern\)/,
        'additive SKU-regex sweep must remain (defensive safety net per handoff)');
});

test('extractProductCodes still applies HP numeric-vs-OEM tie-break', () => {
    // This block is independent of the fallback ladder; it dedupes when
    // backend sends both numeric series ("62") and OEM ("C2P04AA") for HP.
    assert.match(SHOP_CODE, /brand\s*===\s*['"]hp['"]\s*&&\s*foundCodes\.size\s*>\s*1/,
        'HP numeric-vs-OEM tie-break must remain (independent of deleted ladder)');
});

test('extractProductCodes still feeds chips through SeriesCodes.collapseChipList', () => {
    // The yield-collapse (v7 contract) must keep working alongside the v8
    // series_codes-only path. Without this, /shop XL chips would re-split.
    assert.match(SHOP_CODE, /SeriesCodes\.collapseChipList\(codes\)/,
        'chip list must still flow through SeriesCodes.collapseChipList post-cleanup');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cache versioning — v8 active, legacy read-side fallback intact
// ─────────────────────────────────────────────────────────────────────────────

test('chip cache write key is v8', () => {
    // The loadProductCodes write-side cache key
    assert.match(SHOP_CODE, /\$\{this\.state\.brand\}-\$\{categoryId\}-\$\{typeKey\}-codes-v8\b/,
        'loadProductCodes must write the v8 cache key');
});

test('chip cache read ladder is v8 → v7 → v6 → v5 → v4', () => {
    // The two read-side fallback ladders in loadProducts must both list v8 first.
    // Match each ladder independently so failures point at the right block.
    const ladder = /codesCacheKey8[\s\S]{0,200}codesCacheKey7[\s\S]{0,200}codesCacheKey6[\s\S]{0,200}codesCacheKey5[\s\S]{0,200}codesCacheKey4/;
    const matches = SHOP_CODE.match(new RegExp(ladder, 'g')) || [];
    assert.ok(matches.length >= 2,
        `loadProducts must reference the v8→v4 ladder at least twice (primary + post-loadProductCodes refresh); found ${matches.length}`);
});

test('_codeAliasesFor consults v8 chip cache', () => {
    // The collapsed-code → aliases lookup that powers loadProducts fan-out
    // must point at the new v8 key, otherwise click-through still hits v7.
    assert.match(SHOP_CODE, /_codeAliasesFor\s*\([\s\S]{0,600}codes-v8-final/,
        '_codeAliasesFor must read codes-v8-final');
});
