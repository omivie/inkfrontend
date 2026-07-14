/**
 * Truncated series-code repair — Canon bare-CL (Jul 2026)
 * ======================================================
 *
 * The backend's series_codes extractor caps Canon's bare `CL` prefix at two
 * digits, so CL511 and CL513 both land as "CL51", and CL641/CL646 both land as
 * "CL64". Two customer-visible failures follow (both reproduced against the
 * live API on 2026-07-12):
 *
 *   1. The backend LABELS the merged pair chip "PG510/CL511" but FILES each
 *      product under its own extracted code. The colour cartridges were
 *      extracted as "CL51", so they never land under the pair — clicking
 *      PG510/CL511 returned 2 products, both PG510 *black*. (`?code=CL511`
 *      returns 0 hits from the backend; the colour half is unreachable.)
 *   2. The truncated code became its own tile jamming two unrelated series
 *      together: CL51 = CL511 + CL513; CL64 = CL641 + CL646.
 *
 * A third failure was ours: someone hand-patched this via the admin Product
 * Codes picker, and `_applyManualCodes` only skipped a manual code on an EXACT
 * match against a backend series code. "PG510" !== "PG510/CL511", so it pushed
 * duplicate PG510 / CL511 / CL511CLR tiles alongside the pair — 48 chips
 * rendered where the backend sent 45.
 *
 * The durable fix is one regex in the BACKEND extractor (allow CL\d{3}). This
 * repair layer is a stopgap, and is deliberately SELF-DISABLING: detection only
 * fires when the backend's own pair label proves a longer code exists, and
 * trueCodeFromSku only overrides when the SKU strictly extends the backend
 * code. Once the backend emits CL511 there are no suspects and nothing is
 * rewritten — which is what the "self-disables" tests below pin.
 *
 * Run: node --test tests/shop-canon-code-repair.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const { SeriesCodes } = require(JS('utils.js'));
const SHOP_CODE = READ(JS('shop-page.js'));

// ─────────────────────────────────────────────────────────────────────────────
// Load api.js in THIS realm (not a vm sandbox — cross-realm arrays break
// deepStrictEqual). It is declarations-only at top level: an object literal
// plus `window.X = ...` assignments, so it evaluates cleanly against a stub
// window with no DOM.
// ─────────────────────────────────────────────────────────────────────────────
const API_CODE = READ(JS('api.js'));

function loadAPI() {
    const win = {};
    const factory = new Function(
        'window', 'SeriesCodes', 'Config', 'DebugLog', 'fetch',
        `${API_CODE}\n;return window.API;`);
    return factory(
        win,
        SeriesCodes,
        { API_URL: '', SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
        { log() {}, warn() {}, error() {} },
        async () => { throw new Error('no network in tests'); });
}

// The live Canon ink drilldown, trimmed to the chips that matter.
const CANON_SERIES = () => ([
    { code: 'CL38', count: 1 },            // genuine 2-digit code — must not be touched
    { code: 'CL51', count: 3 },            // truncation of CL511 *and* CL513
    { code: 'CL64', count: 2 },            // truncation of CL641 *and* CL646
    { code: 'PG40/CL41', count: 4 },       // pair the backend already gets right
    { code: 'PG50', count: 1 },
    { code: 'PG510/CL511', count: 2 },     // black-only: the CL511 half is stranded
    { code: 'PG512/CL513', count: 1 },     // black-only
    { code: 'PG640/CL641', count: 1 },     // black-only
    { code: 'PG645/CL646', count: 1 },     // black-only
    { code: 'PGI520/CLI521', count: 15 },  // CLI codes are unaffected
]);

// What /api/shop?code=X returns, keyed by X.
const PRODUCTS_BY_CODE = {
    'CL51': [
        { id: 'p-gcl511', sku: 'GCL511', series_codes: ['CL51'] },
        { id: 'p-ccl511clr', sku: 'CCL511CLR', series_codes: ['CL51'] },
        { id: 'p-ccl513clr', sku: 'CCL513CLR', series_codes: ['CL51'] },
    ],
    'CL64': [
        { id: 'p-gcl641', sku: 'GCL641', series_codes: ['CL64'] },
        { id: 'p-gcl646', sku: 'GCL646', series_codes: ['CL64'] },
        // The twin-packs: an opaque SKU the un-truncator can't read, but they
        // carry PG640 too, so they already sit under the PG640/CL641 pair.
        { id: 'p-2pk', sku: 'G-CAN-PG640-INK-2PK', series_codes: ['PG640', 'CL64'] },
    ],
    'PG510/CL511': [
        { id: 'p-gpg510bk', sku: 'GPG510BK', series_codes: ['PG510'] },
        { id: 'p-cpg510bk', sku: 'CPG510BK', series_codes: ['PG510'] },
    ],
    'PG512/CL513': [
        { id: 'p-gpg512bk', sku: 'GPG512BK', series_codes: ['PG512'] },
    ],
    'PG640/CL641': [
        { id: 'p-gpg640bk', sku: 'GPG640BK', series_codes: ['PG640'] },
        { id: 'p-2pk', sku: 'G-CAN-PG640-INK-2PK', series_codes: ['PG640', 'CL64'] },
    ],
    'PG645/CL646': [{ id: 'p-gpg645bk', sku: 'GPG645BK', series_codes: ['PG645'] }],
};

/** Stub the one network seam the repair layer uses, and count the calls. */
function stubShop(API, byCode = PRODUCTS_BY_CODE) {
    const calls = [];
    API._productsForCode = async (brand, category, code) => {
        calls.push(code);
        // Deep-clone so a test can't see mutations leak between fetches.
        return JSON.parse(JSON.stringify(byCode[String(code).toUpperCase()] || []));
    };
    return calls;
}

const chip = (series, code) => series.find(c => c.code === code);
const skus = (chipObj) => (chipObj.products || []).map(p => p.sku).sort();

async function runDrilldown(API, series = CANON_SERIES()) {
    const params = { brand: 'canon', category: 'ink' };
    const primary = { ok: true, data: { series, products: [] } };
    const truncated = API._detectTruncatedChips(primary, params);
    await API._repairTruncatedSeries(primary, params, truncated);
    return { primary, truncated, series: primary.data.series };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SeriesCodes.trueCodeFromSku — the one SKU regex, and its guardrails
// ─────────────────────────────────────────────────────────────────────────────

test('trueCodeFromSku un-truncates the code the backend cut short', () => {
    assert.equal(SeriesCodes.trueCodeFromSku('GCL511', 'CL51'), 'CL511');
    assert.equal(SeriesCodes.trueCodeFromSku('CCL511CLR', 'CL51'), 'CL511');
    assert.equal(SeriesCodes.trueCodeFromSku('CCL513CLR', 'CL51'), 'CL513');
    assert.equal(SeriesCodes.trueCodeFromSku('GCL641', 'CL64'), 'CL641');
    assert.equal(SeriesCodes.trueCodeFromSku('GCL646XL', 'CL64'), 'CL646');
});

test('trueCodeFromSku leaves genuine short codes alone (CL38, CL41 are real)', () => {
    assert.equal(SeriesCodes.trueCodeFromSku('GCL38', 'CL38'), 'CL38');
    assert.equal(SeriesCodes.trueCodeFromSku('GCL41', 'CL41'), 'CL41');
    assert.equal(SeriesCodes.trueCodeFromSku('GPG50BK', 'PG50'), 'PG50');
});

test('trueCodeFromSku self-disables once the backend emits the full code', () => {
    // Post-backend-fix: the SKU code merely equals the backend code, so the
    // whole repair layer becomes a no-op rather than fighting the backend.
    assert.equal(SeriesCodes.trueCodeFromSku('GCL511', 'CL511'), 'CL511');
    assert.equal(SeriesCodes.trueCodeFromSku('CCL513CLR', 'CL513'), 'CL513');
});

test('trueCodeFromSku only accepts a DIGIT extension, never a letter tail', () => {
    // "CL51" → "CL51BK" is a colour marker, not a longer series code.
    assert.equal(SeriesCodes.trueCodeFromSku('GCL51BK', 'CL51'), 'CL51');
    // An unrelated SKU body must never override the backend.
    assert.equal(SeriesCodes.trueCodeFromSku('G-CAN-PG640-INK-2PK', 'CL64'), 'CL64');
    assert.equal(SeriesCodes.trueCodeFromSku('', 'CL51'), 'CL51');
    assert.equal(SeriesCodes.trueCodeFromSku('GCL511', ''), '');
});

test('pairHalves splits a merged pair chip and ignores a plain one', () => {
    assert.deepEqual(SeriesCodes.pairHalves('PG510/CL511'), ['PG510', 'CL511']);
    assert.deepEqual(SeriesCodes.pairHalves('PGI520/CLI521'), ['PGI520', 'CLI521']);
    assert.deepEqual(SeriesCodes.pairHalves('CLI42'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. _detectTruncatedChips — data-driven, no hardcoded Canon list
// ─────────────────────────────────────────────────────────────────────────────

test('detects exactly the truncated chips, and no false positives', () => {
    const API = loadAPI();
    const primary = { ok: true, data: { series: CANON_SERIES() } };
    const { suspectCodes } = API._detectTruncatedChips(primary, { brand: 'canon', category: 'ink' });

    assert.deepEqual([...suspectCodes].sort(), ['CL51', 'CL64']);
    // CL38/PG50 are genuine standalone codes; PG40/CL41 is a correct pair; the
    // halves of a pair are not themselves truncations.
    for (const safe of ['CL38', 'PG50', 'PG40/CL41', 'PGI520/CLI521']) {
        assert.ok(!suspectCodes.has(safe), `${safe} must not be flagged`);
    }
});

test('detection self-disables when the backend stops truncating', () => {
    const API = loadAPI();
    const fixed = [
        { code: 'CL511', count: 2 },
        { code: 'CL513', count: 1 },
        { code: 'PG510/CL511', count: 4 },
        { code: 'PG512/CL513', count: 2 },
    ];
    const { suspectCodes } = API._detectTruncatedChips(
        { ok: true, data: { series: fixed } }, { brand: 'canon', category: 'ink' });
    assert.equal(suspectCodes.size, 0, 'a correct backend must produce zero suspects');
});

test('a brand with no merged pair chips is never touched', () => {
    const API = loadAPI();
    const epson = [{ code: '604', count: 4 }, { code: '603', count: 4 }, { code: 'T512', count: 6 }];
    const { suspectCodes } = API._detectTruncatedChips(
        { ok: true, data: { series: epson } }, { brand: 'epson', category: 'ink' });
    assert.equal(suspectCodes.size, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. _repairTruncatedSeries — the drilldown chip grid
// ─────────────────────────────────────────────────────────────────────────────

test('the truncated CL51 / CL64 tiles are retired once every product is re-homed', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    assert.equal(chip(series, 'CL51'), undefined, 'CL51 was two series in a trenchcoat');
    assert.equal(chip(series, 'CL64'), undefined);
    assert.equal(series.length, CANON_SERIES().length - 2);
});

test('CL511 colour cartridges land under PG510/CL511, alongside the blacks', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    const pair = chip(series, 'PG510/CL511');
    // The bug: this tile used to hold only the 2 PG510 blacks.
    assert.deepEqual(skus(pair), ['CCL511CLR', 'CPG510BK', 'GCL511', 'GPG510BK']);
    assert.equal(pair.count, 4, 'count must match the products actually behind the tile');
});

test('CL513 goes to PG512/CL513, NOT to PG510/CL511', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    // Both were truncated to the same "CL51", so the SKU is the only thing that
    // can tell them apart. Getting this wrong puts a CL513 cartridge in front of
    // a customer shopping for a CL511 printer.
    assert.deepEqual(skus(chip(series, 'PG512/CL513')), ['CCL513CLR', 'GPG512BK']);
    assert.ok(!skus(chip(series, 'PG510/CL511')).includes('CCL513CLR'));
});

test('a pair chip receiving products holds its COMPLETE set, never just the recovered half', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    // shop-page reads chip.products from the cache and skips its own fetch, so a
    // partial array would silently hide the products the backend filed correctly.
    for (const code of ['PG510/CL511', 'PG512/CL513']) {
        const c = chip(series, code);
        const halves = SeriesCodes.pairHalves(code);
        for (const half of halves) {
            assert.ok(c.products.some(p => p.series_codes.includes(half)),
                `${code} must contain its ${half} half`);
        }
        assert.equal(c.count, c.products.length);
    }
});

test('correct chips are left exactly as the backend sent them', async () => {
    const API = loadAPI();
    const calls = stubShop(API);
    const { series } = await runDrilldown(API);

    // PG40/CL41 and PGI520/CLI521 already work — no refetch, no mutation.
    assert.deepEqual(chip(series, 'PG40/CL41'), { code: 'PG40/CL41', count: 4 });
    assert.deepEqual(chip(series, 'PGI520/CLI521'), { code: 'PGI520/CLI521', count: 15 });
    assert.deepEqual(chip(series, 'CL38'), { code: 'CL38', count: 1 });
    assert.ok(!calls.includes('PG40/CL41'), 'must not fetch a chip it has no repair for');
});

test('repaired products carry their true code in series_codes', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    const byS = {};
    for (const c of series) for (const p of c.products || []) byS[p.sku] = p.series_codes;
    assert.deepEqual(byS['GCL511'], ['CL511']);
    assert.deepEqual(byS['CCL513CLR'], ['CL513']);
    assert.deepEqual(byS['GPG510BK'], ['PG510'], 'an already-correct product is untouched');
});

test('a twin-pack already homed via its other code does not keep the junk tile alive', async () => {
    const API = loadAPI();
    stubShop(API);
    const { series } = await runDrilldown(API);

    // G-CAN-PG640-INK-2PK is unreadable to the un-truncator, but it carries
    // PG640 — so it is NOT stranded, and CL64 must still retire. Treating it as
    // a leftover would leave a CL64 tile duplicating PG640/CL641.
    assert.equal(chip(series, 'CL64'), undefined);
    const pair = chip(series, 'PG640/CL641');
    assert.deepEqual(skus(pair), ['G-CAN-PG640-INK-2PK', 'GCL641', 'GPG640BK']);
    assert.equal(pair.count, 3, 'the twin-pack must be counted once, not twice');
});

test('a suspect keeps its leftovers rather than dropping products on the floor', async () => {
    const API = loadAPI();
    // GCL599 has no pair chip to go to — CL51 must survive holding it.
    stubShop(API, {
        ...PRODUCTS_BY_CODE,
        'CL51': [
            { id: 'p-gcl511', sku: 'GCL511', series_codes: ['CL51'] },
            { id: 'p-orphan', sku: 'GCL51ORPHAN', series_codes: ['CL51'] },
        ],
    });
    const { series } = await runDrilldown(API);

    const leftover = chip(series, 'CL51');
    assert.ok(leftover, 'must not retire a chip whose products have nowhere to go');
    assert.deepEqual(skus(leftover), ['GCL51ORPHAN']);
    assert.equal(leftover.count, 1);
});

test('a failed repair fetch leaves the backend response untouched (fail-open)', async () => {
    const API = loadAPI();
    API._productsForCode = async () => { throw new Error('backend down'); };
    const params = { brand: 'canon', category: 'ink' };
    const primary = { ok: true, data: { series: CANON_SERIES(), products: [] } };
    const truncated = API._detectTruncatedChips(primary, params);

    await assert.doesNotReject(() => API._repairTruncatedSeries(primary, params, truncated));
    assert.ok(chip(primary.data.series, 'CL51'), 'chips stay as the backend sent them');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. _repairPairCodeFilter — the deep-link / hard-refresh path (no chip cache)
// ─────────────────────────────────────────────────────────────────────────────

test('deep-linking straight to ?code=PG510/CL511 still recovers the colour half', async () => {
    const API = loadAPI();
    stubShop(API);
    const params = { brand: 'canon', category: 'ink', code: 'PG510/CL511' };
    const primary = {
        ok: true,
        meta: { total: 2 },
        data: { products: JSON.parse(JSON.stringify(PRODUCTS_BY_CODE['PG510/CL511'])) },
    };

    await API._repairTruncatedSeries(primary, params, API._detectTruncatedChips(primary, params));

    const got = primary.data.products.map(p => p.sku).sort();
    assert.deepEqual(got, ['CCL511CLR', 'CPG510BK', 'GCL511', 'GPG510BK']);
    assert.ok(!got.includes('CCL513CLR'), 'the other truncated series must stay out');
    assert.equal(primary.meta.total, 4);
});

test('deep-linking to an already-correct pair fires no recovery fetch', async () => {
    const API = loadAPI();
    const calls = stubShop(API);
    const params = { brand: 'canon', category: 'ink', code: 'PG40/CL41' };
    const primary = {
        ok: true,
        data: {
            products: [
                { id: 'a', sku: 'GPG40BK', series_codes: ['PG40'] },
                { id: 'b', sku: 'GCL41', series_codes: ['CL41'] },
            ],
        },
    };
    await API._repairTruncatedSeries(primary, params, API._detectTruncatedChips(primary, params));

    assert.equal(calls.length, 0, 'both halves are present — nothing to recover');
    assert.equal(primary.data.products.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. _applyManualCodes — the duplicate-tile bug
// ─────────────────────────────────────────────────────────────────────────────

test('a manual code the pair chip already speaks for does not spawn a duplicate tile', async () => {
    const API = loadAPI();
    const params = { brand: 'canon', category: 'ink' };
    const primary = { ok: true, data: { series: CANON_SERIES(), products: [] } };
    const truncated = API._detectTruncatedChips(primary, params);

    // The live product_codes rows: a hand-patch that used to render 3 extra tiles.
    API._fetchManualCodesByProduct = async () => new Map();
    API._fetchManualChipCounts = async () => ([
        { code: 'PG510', count: 2 },       // a half of PG510/CL511
        { code: 'CL511', count: 1 },       // the other half
        { code: 'CL511CLR', count: 1 },    // a suffixed variant of a half
        { code: 'CL51', count: 1 },        // the truncated code the repair absorbs
    ]);

    await API._applyManualCodes(primary, params, truncated);

    const codes = primary.data.series.map(c => c.code);
    for (const dupe of ['PG510', 'CL511', 'CL511CLR']) {
        assert.ok(!codes.includes(dupe), `${dupe} is already covered by PG510/CL511`);
    }
    assert.equal(codes.filter(c => c === 'CL51').length, 1, 'must not re-add the absorbed CL51');
    assert.deepEqual(codes.sort(), CANON_SERIES().map(c => c.code).sort(),
        'the manual layer must add no chips at all here');
});

test('a genuinely new manual code still gets its tile', async () => {
    const API = loadAPI();
    const params = { brand: 'canon', category: 'ink' };
    const primary = { ok: true, data: { series: CANON_SERIES(), products: [] } };
    const truncated = API._detectTruncatedChips(primary, params);

    API._fetchManualCodesByProduct = async () => new Map();
    API._fetchManualChipCounts = async () => ([{ code: 'LC57', count: 2 }]);

    await API._applyManualCodes(primary, params, truncated);
    assert.ok(primary.data.series.some(c => c.code === 'LC57'),
        'the purely-manual-code case must keep working');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. shop-page wiring
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page bumps the chip cache to v9', () => {
    assert.match(SHOP_CODE, /codes-v9/,
        'chip shape changed (counts + products), so v8 caches must not be served');
    assert.ok(!/codes-v8-final/.test(SHOP_CODE),
        'no v8 key may still be read, or a stale split CL51 tile survives the deploy');
});

test('getShopData runs detection before the manual layer and repair after it', () => {
    const detect = API_CODE.indexOf('_detectTruncatedChips(primary, params)');
    const manual = API_CODE.indexOf('this._applyManualCodes(primary, params, truncated)');
    const repair = API_CODE.indexOf('this._repairTruncatedSeries(primary, params, truncated)');

    assert.ok(detect > 0 && manual > 0 && repair > 0, 'all three must be wired into getShopData');
    assert.ok(detect < manual,
        'the manual layer needs the suspect set to avoid pushing duplicate tiles');
    assert.ok(manual < repair,
        'repair must run last so its series_codes rewrite wins over a stale manual override');
});
