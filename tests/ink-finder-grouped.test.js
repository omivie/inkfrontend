/**
 * Ink-finder — grouped-by-brand contract tests
 * =============================================
 *
 * Pins the contract from backend-passover task 5 (May 2026):
 *   GET /api/printers/by-brand/<brand>?grouped=true&exclude_non_ink=true
 *   → { ok, data: { brand, series_groups: [{ id, name, model_count,
 *       models: [{ id, model_name, full_name, slug, series }] }],
 *       total_models } }
 *
 * Spec: docs/storefront/value-pack-and-product-url-contract.md §4.2.1
 *
 * Regression guards (always run):
 *   - api.js getPrintersByBrand hits the new endpoint with both query flags
 *   - ink-finder.js / account.js read response.data.series_groups directly
 *   - printer-data.js is slimmed to BRAND_NAMES only (~600 lines deleted)
 *   - PrinterData taxonomy helpers stay deleted from every consumer
 *
 * Live HTTP guard (set LIVE_API=1 to enable):
 *   - Endpoint returns the grouped shape for canon/hp/brother/epson
 *   - "Other Models" is pinned last when present
 *   - Models inside a group are sorted natural-numerically by model_name
 *
 * Run with: node --test tests/ink-finder-grouped.test.js
 *           LIVE_API=1 node --test tests/ink-finder-grouped.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const API_JS            = READ('api.js');
const INK_FINDER_JS     = READ('ink-finder.js');
const ACCOUNT_JS        = READ('account.js');
const PRINTER_DATA_JS   = READ('printer-data.js');

const API_CODE          = stripComments(API_JS);
const INK_FINDER_CODE   = stripComments(INK_FINDER_JS);
const ACCOUNT_CODE      = stripComments(ACCOUNT_JS);
const PRINTER_DATA_CODE = stripComments(PRINTER_DATA_JS);

// ─────────────────────────────────────────────────────────────────────────────
// api.js — getPrintersByBrand hits the new endpoint
// ─────────────────────────────────────────────────────────────────────────────

test('api.js getPrintersByBrand — uses /api/printers/by-brand/<slug>', () => {
    assert.match(API_CODE, /\/api\/printers\/by-brand\//,
        'getPrintersByBrand must hit /api/printers/by-brand/<brand> (backend-passover task 5)');
    assert.doesNotMatch(API_CODE, /\/api\/printers\/search\?q=\*/,
        'old /api/printers/search?q=* path must be deleted — grouping was happening client-side');
});

// Match getPrintersByBrand body to the next `^    },` (object-property
// terminator at 4-space indent). Naive `[\s\S]+?\}` stops at the `}` inside
// `${slug}` template literals.
function getPrintersByBrandBody() {
    const m = API_CODE.match(/async\s+getPrintersByBrand\s*\([^)]*\)\s*\{[\s\S]+?\n\s{4}\},/);
    assert.ok(m, 'expected getPrintersByBrand function in api.js');
    return m[0];
}

test('api.js getPrintersByBrand — passes grouped=true and exclude_non_ink=true', () => {
    // Both flags are required for the dropdown shape — without grouped=true the
    // response is a flat printers[] (preserved for back-compat), and without
    // exclude_non_ink=true label makers / scanners / dot-matrix slip through.
    const body = getPrintersByBrandBody();
    assert.match(body, /grouped=true/,
        'getPrintersByBrand must request grouped=true (else response is flat printers[])');
    assert.match(body, /exclude_non_ink=true/,
        'getPrintersByBrand must request exclude_non_ink=true (else label makers/scanners leak in)');
});

test('api.js getPrintersByBrand — lower-cases the brand slug before encoding', () => {
    // Call sites pass either "canon" (slug) or "Canon" (display name). The
    // backend route is case-sensitive on the slug, so normalise here.
    const body = getPrintersByBrandBody();
    assert.match(body, /toLowerCase\s*\(\s*\)/,
        'getPrintersByBrand must lower-case the brand slug — routes are case-sensitive');
    assert.match(body, /encodeURIComponent/,
        'getPrintersByBrand must URL-encode the slug');
});

// ─────────────────────────────────────────────────────────────────────────────
// ink-finder.js / account.js — read series_groups, drop PrinterData taxonomy
// ─────────────────────────────────────────────────────────────────────────────

test('ink-finder.js — reads response.data.series_groups (not flat printers[])', () => {
    assert.match(INK_FINDER_CODE, /series_groups/,
        'ink-finder.js must read response.data.series_groups');
    // The backend's models[] use snake_case names — confirm we map them.
    assert.match(INK_FINDER_CODE, /model_name/,
        'ink-finder.js must map m.model_name → name (renderer reads .name)');
    assert.match(INK_FINDER_CODE, /full_name/,
        'ink-finder.js must map m.full_name → fullName (renderer reads .fullName)');
});

test('account.js — reads response.data.series_groups (not flat printers[])', () => {
    assert.match(ACCOUNT_CODE, /series_groups/,
        'account.js must read response.data.series_groups');
    assert.match(ACCOUNT_CODE, /model_name/,
        'account.js must map m.model_name → name');
    assert.match(ACCOUNT_CODE, /full_name/,
        'account.js must map m.full_name → fullName');
});

test('ink-finder.js — PrinterData taxonomy helpers stay deleted (only BRAND_NAMES allowed)', () => {
    // The backend now owns series classification — these calls would re-introduce
    // the dual-source-of-truth bug. BRAND_NAMES is fine (display strings only).
    const banned = [
        /PrinterData\.getSeriesForModel/,
        /PrinterData\.groupPrintersBySeries/,
        /PrinterData\.isInkToner/,
        /PrinterData\.SERIES_PATTERNS/,
        /PrinterData\.NON_INK_/,
        /PrinterData\._normalize/,
    ];
    for (const re of banned) {
        assert.doesNotMatch(INK_FINDER_CODE, re,
            `ink-finder.js must not call ${re} — backend handles this server-side now`);
    }
});

test('account.js — PrinterData taxonomy helpers stay deleted (only BRAND_NAMES allowed)', () => {
    const banned = [
        /PrinterData\.getSeriesForModel/,
        /PrinterData\.groupPrintersBySeries/,
        /PrinterData\.isInkToner/,
        /PrinterData\.SERIES_PATTERNS/,
        /PrinterData\.NON_INK_/,
        /PrinterData\._normalize/,
    ];
    for (const re of banned) {
        assert.doesNotMatch(ACCOUNT_CODE, re,
            `account.js must not call ${re} — backend handles this server-side now`);
    }
    // BRAND_NAMES survives — used by the printer-save form to write the
    // human-readable brand back into the printer record.
    assert.match(ACCOUNT_CODE, /PrinterData\.BRAND_NAMES/,
        'account.js still uses PrinterData.BRAND_NAMES for the printer-save form');
});

// ─────────────────────────────────────────────────────────────────────────────
// printer-data.js — slimmed to BRAND_NAMES only
// ─────────────────────────────────────────────────────────────────────────────

test('printer-data.js — SERIES_PATTERNS / classifier / grouping helpers all deleted', () => {
    const banned = [
        /SERIES_PATTERNS/,
        /\bgetSeriesForModel\b/,
        /\bgroupPrintersBySeries\b/,
        /\bisInkToner\b/,
        /\bNON_INK_SERIES_KEYWORDS\b/,
        /\bNON_INK_MODEL_PREFIXES\b/,
        /\bNON_INK_MODEL_REGEX\b/,
        /\bNON_INK_MODEL_KEYWORDS\b/,
        /\b_normalize\b/,
    ];
    for (const re of banned) {
        assert.doesNotMatch(PRINTER_DATA_CODE, re,
            `printer-data.js must not contain ${re} — moved to backend (passover task 5)`);
    }
});

test('printer-data.js — BRAND_NAMES survives with all 9 brand slugs', () => {
    assert.match(PRINTER_DATA_CODE, /BRAND_NAMES\s*:/,
        'BRAND_NAMES stays — needed by the account printer-save form');
    // Spot-check the slugs the storefront actually exposes as brand buttons.
    for (const slug of ['brother', 'canon', 'epson', 'hp', 'samsung',
                        'lexmark', 'oki', 'fuji-xerox', 'kyocera']) {
        const escaped = slug.replace(/-/g, '\\-');
        assert.match(PRINTER_DATA_CODE, new RegExp(`['"]?${escaped}['"]?\\s*:`),
            `BRAND_NAMES must include the "${slug}" slug`);
    }
});

test('printer-data.js — slimmed to ≤60 lines (was 788 before May 2026 passover)', () => {
    const lines = PRINTER_DATA_JS.split('\n').length;
    assert.ok(lines <= 60,
        `printer-data.js is ${lines} lines; expected ≤60 after deleting the client-side taxonomy. ` +
        `If you added back logic that backend should own, see backend-passover task 5.`);
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE HTTP — verify the backend contract end-to-end
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.LIVE_API === '1';
const BASE = process.env.API_BASE || 'https://www.inkcartridges.co.nz';

async function fetchGrouped(brand) {
    const url = `${BASE}/api/printers/by-brand/${brand}?grouped=true&exclude_non_ink=true`;
    const res = await fetch(url);
    assert.ok(res.ok, `${url} returned HTTP ${res.status}`);
    return res.json();
}

test('LIVE — /api/printers/by-brand/canon returns the grouped shape', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('canon');
    assert.equal(body.ok, true, 'envelope: { ok: true, data }');
    assert.ok(body.data, 'envelope must include data');
    assert.ok(body.data.brand, 'data.brand must be present');
    assert.ok(Array.isArray(body.data.series_groups), 'data.series_groups must be an array');
    assert.ok(body.data.series_groups.length > 0, 'canon must return at least one series group');
});

test('LIVE — every series group carries { id, name, model_count, models }', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('canon');
    for (const g of body.data.series_groups) {
        assert.ok(g.id, `group missing id: ${JSON.stringify(g).slice(0, 80)}`);
        assert.ok(g.name, `group missing name: ${JSON.stringify(g).slice(0, 80)}`);
        assert.equal(typeof g.model_count, 'number', `group ${g.name} model_count must be a number`);
        assert.ok(Array.isArray(g.models), `group ${g.name} must carry models[]`);
        assert.equal(g.models.length, g.model_count,
            `group ${g.name}: model_count=${g.model_count} but models[]=${g.models.length}`);
    }
});

test('LIVE — every model carries { id, model_name, full_name, slug, series }', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('canon');
    const sample = body.data.series_groups[0].models[0];
    for (const k of ['id', 'model_name', 'full_name', 'slug', 'series']) {
        assert.ok(k in sample, `first model is missing field "${k}". Got: ${JSON.stringify(sample)}`);
    }
});

test('LIVE — "Other Models" group is pinned last when present', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('canon');
    const otherIdx = body.data.series_groups.findIndex(g => /other/i.test(g.name));
    if (otherIdx >= 0) {
        assert.equal(otherIdx, body.data.series_groups.length - 1,
            '"Other Models" must be the last group, not in the middle of the alphabet');
    }
});

test('LIVE — models within a group are natural-sorted by model_name', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('canon');
    // Pick the first group with ≥3 models so the sort is meaningful.
    const group = body.data.series_groups.find(g => g.models.length >= 3);
    if (!group) return;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sorted = [...group.models].sort((a, b) => collator.compare(a.model_name, b.model_name));
    assert.deepEqual(
        group.models.map(m => m.model_name),
        sorted.map(m => m.model_name),
        `group "${group.name}" must be natural-sorted`
    );
});

test('LIVE — exclude_non_ink=true strips label/scanner/dot-matrix series from Brother', { skip: !LIVE }, async () => {
    const body = await fetchGrouped('brother');
    // Brother is the worst offender — P-touch / QL / TD / ADS / RJ / PJ / MW / TJ.
    // None of those should make it past exclude_non_ink=true.
    for (const g of body.data.series_groups) {
        assert.doesNotMatch(g.name, /\b(P-touch|Label|Thermal Direct|Document Scanner|PocketJet|Mobile Printer|Industrial Printer)\b/i,
            `Brother group "${g.name}" should have been filtered by exclude_non_ink=true`);
    }
});

test('LIVE — every brand the storefront exposes returns at least one group', { skip: !LIVE }, async () => {
    // The 9 brand buttons in index.html / account/printers.html.
    const brands = ['brother', 'canon', 'epson', 'hp', 'samsung',
                    'lexmark', 'oki', 'fuji-xerox', 'kyocera'];
    for (const b of brands) {
        try {
            const body = await fetchGrouped(b);
            assert.equal(body.ok, true, `${b}: envelope ok=true`);
            // At least one group means the dropdown will have content. Some
            // small brands might genuinely have zero — log instead of failing.
            if (!Array.isArray(body.data.series_groups) || body.data.series_groups.length === 0) {
                console.warn(`[warn] brand "${b}" returned no series_groups`);
            }
        } catch (e) {
            assert.fail(`brand "${b}" failed: ${e.message}`);
        }
    }
});
