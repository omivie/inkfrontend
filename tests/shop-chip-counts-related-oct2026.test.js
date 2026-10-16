/**
 * Product-code tile count = products the tile opens; drums ⇄ toners (ERR-337)
 * ===========================================================================
 *
 * Owner, 2026-10-15: /shop?brand=brother&category=toner tile DR2415 said
 * "5 products" and opened 4. The backend's `series[].count` and its `?code=`
 * listing disagree about drum rows on a toner tile (and toner rows on a drum
 * tile). Owner decision: a drum that pairs with a toner shows WITH that toner,
 * and the toner with the drum.
 *
 * ERR-358 (owner 2026-10-16) REPLACED the code-based join: the related category
 * joins by PRINTER — partner-type rows (toner ⇄ drum only) sharing ≥1
 * `compatible_printers` slug with the tile's own-type rows (_printerPartners).
 *
 * The real methods are lifted out of shop-page.js and run against a stubbed
 * API.getShopData, wired to the real SeriesCodes from utils.js.
 *
 * Run with: node --test tests/shop-chip-counts-related-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = require('./helpers/strip-comments');

const SHOP_SRC = read('inkcartridges/js/shop-page.js');
const SHOP_CODE = stripComments(SHOP_SRC);
const UTILS_SRC = read('inkcartridges/js/utils.js');

/** Source of one (optionally async) object-literal method of shop-page.js. */
function methodSource(name) {
    const m = new RegExp(`\\n {8}(async )?${name}\\(`).exec(SHOP_SRC);
    assert.ok(m, `${name} must exist in shop-page.js`);
    const start = m.index + 1;
    let depth = 0;
    for (let j = SHOP_SRC.indexOf('{', start); j < SHOP_SRC.length; j++) {
        if (SHOP_SRC[j] === '{') depth++;
        else if (SHOP_SRC[j] === '}' && --depth === 0) return SHOP_SRC.slice(start, j + 1).trim();
    }
    assert.fail(`${name} must be brace-balanced`);
}

function loadSeriesCodes() {
    const start = UTILS_SRC.indexOf('const SeriesCodes = (function () {');
    assert.notEqual(start, -1, 'SeriesCodes IIFE must exist in utils.js');
    const tail = UTILS_SRC.slice(start);
    const src = tail.slice(0, tail.indexOf('\n})();') + '\n})();'.length);
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src + '\nglobalThis.__SC = SeriesCodes;', sandbox);
    return sandbox.__SC;
}

const row = (id, product_type, series_codes, printers = []) =>
    ({ id, product_type, series_codes, compatible_printers: printers.map(slug => ({ slug })) });
// Live code shape, measured 2026-10-15 (Brother); printers = the listing's 2-slug sample.
const L23 = ['brother-hl-l2350dw', 'brother-hl-l2375dw'];
const L51 = ['brother-hl-l5100dn'];
const TONER_ROWS = [
    row('GTN2415BK', 'toner_cartridge', ['TN2415', 'DR2415'], L23),
    row('GTN2445BK', 'toner_cartridge', ['TN2445', 'TN2415', 'TN2449', 'DR2415'], L23),
    row('CTN2445BK', 'toner_cartridge', ['TN2445', 'TN2415', 'TN2449', 'DR2415'], L23),
    row('CTN2449BK', 'toner_cartridge', ['TN2449', 'DR2415'], L23),
    row('GTN2530BK', 'toner_cartridge', ['TN2530'], L51),
];
const DRUM_ROWS = [
    // Untagged with any TN code: joins by printer alone (the old rule missed it).
    row('GDR2425BK', 'drum_unit', ['DR2425'], ['brother-hl-l2375dw']),
    row('CDR2425BK', 'drum_unit', ['DR2425'], ['brother-hl-l2375dw']),
    row('GDR2530BK', 'drum_unit', ['DR2530', 'TN2530'], L51),
    // Shares a printer but is not a drum: never a partner.
    row('GWT223CL', 'waste_toner', ['WT223CL'], L23),
];

function makeShop({ category = 'toner', failCategory = null } = {}) {
    const calls = [];
    const warnings = [];
    const API = {
        async getShopData(params) {
            calls.push(params);
            if (params.category === failCategory) return { ok: false, status: 503 };
            const rows = params.category === 'drums' ? DRUM_ROWS : TONER_ROWS;
            return { ok: true, data: { products: rows.slice((params.page - 1) * params.limit, params.page * params.limit) } };
        }
    };
    const sandbox = {
        API,
        window: { SeriesCodes: loadSeriesCodes() },
        DebugLog: { warn: (m) => warnings.push(m), error() {}, log() {} },
    };
    vm.createContext(sandbox);
    const body = ['_listingApiCategories', '_rowCarriesCode', '_printerPartners', '_walkListing', '_recountChipsFromListing'].map(methodSource).join(',\n');
    const shop = vm.runInContext(`({
        RELATED_CATEGORY: { toner: 'consumable', consumable: 'toner' },
        PRINTER_PAIR: { toner: ['toner_cartridge', 'drum_unit'], consumable: ['drum_unit', 'toner_cartridge'] },
        categories: [
            { id: 'toner', apiCategory: 'toner' },
            { id: 'consumable', apiCategory: 'drums' },
            { id: 'ink', apiCategory: 'ink' }
        ],
        state: { brand: 'brother', category: ${JSON.stringify(category)}, type: null },
        ${body}
    })`, sandbox);
    return { shop, calls, warnings };
}

test('RELATED_CATEGORY in shop-page.js pairs toner and drums both ways', () => {
    assert.match(SHOP_CODE, /RELATED_CATEGORY:\s*\{\s*toner:\s*'consumable',\s*consumable:\s*'toner'\s*\}/);
});

test('toner tiles count own rows by code PLUS drums sharing a printer (ERR-358)', async () => {
    const { shop, warnings } = makeShop();
    const chips = [{ code: 'TN2415', count: 3 }, { code: 'TN2449', count: 3 }, { code: 'TN2530', count: 2 }];
    const r = await shop._recountChipsFromListing(chips);
    assert.equal(r.ok, true);
    // TN2415: 3 toners + the 2 DR2425 drums (shared hl-l2375dw); the waste box shares too but is not a drum.
    // TN2530: 1 toner + its drum; the DR2425 drums share no printer with it.
    assert.deepEqual(JSON.parse(JSON.stringify(r.codes.map(c => [c.code, c.count]))), [['TN2415', 5], ['TN2449', 5], ['TN2530', 2]]);
    assert.equal(shop._chipCountsFrom, 'listing-rows');
    assert.ok(warnings.some(w => /TN2415 series=3 rows=5/.test(w)), 'backend drift is logged per chip');
});

test('a chip no own row carries is dropped (it would open empty) — drums alone never keep it', async () => {
    const { shop } = makeShop();
    const r = await shop._recountChipsFromListing([{ code: 'DR2530', count: 2 }, { code: 'TN2530', count: 2 }]);
    assert.deepEqual([...r.codes.map(c => c.code)], ['TN2530']);
});

test('drum page: drum tiles pull toners sharing a printer; a waste-box tile pulls none', async () => {
    const { shop } = makeShop({ category: 'consumable' });
    const r = await shop._recountChipsFromListing([{ code: 'DR2425', count: 2 }, { code: 'WT223CL', count: 1 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(r.codes.map(c => [c.code, c.count]))), [['DR2425', 2 + 4], ['WT223CL', 1]]);
});

test('_printerPartners: shared slug joins, partner type only, no slugs ⇒ nothing', () => {
    const { shop } = makeShop();
    const ids = (rows) => JSON.parse(JSON.stringify(rows.map(p => p.id)));
    assert.deepEqual(ids(shop._printerPartners([TONER_ROWS[0]], DRUM_ROWS)), ['GDR2425BK', 'CDR2425BK']);
    assert.deepEqual(ids(shop._printerPartners([TONER_ROWS[4]], DRUM_ROWS)), ['GDR2530BK']);
    assert.deepEqual(ids(shop._printerPartners([row('X', 'toner_cartridge', ['TN1'])], DRUM_ROWS)), [], 'no printers ⇒ no partners');
    shop.state.category = 'ink';
    assert.deepEqual(ids(shop._printerPartners(TONER_ROWS, DRUM_ROWS)), [], 'negative control: ink pairs with nothing');
});

test('walk failure keeps backend counts, flags it, and reports not-ok (caller must not cache)', async () => {
    const { shop, warnings } = makeShop({ failCategory: 'drums' });
    const chips = [{ code: 'DR2415', count: 5 }];
    const r = await shop._recountChipsFromListing(chips);
    assert.equal(r.ok, false);
    assert.equal(r.codes, chips);
    assert.equal(shop._chipCountsFrom, 'backend-series');
    assert.ok(warnings.some(w => /listing walk failed/.test(w)));
});

test('drums page spans drums + toner; ink spans only ink', () => {
    assert.deepEqual([...makeShop({ category: 'consumable' }).shop._listingApiCategories()], ['drums', 'toner']);
    assert.deepEqual([...makeShop({ category: 'ink' }).shop._listingApiCategories()], ['ink']);
});

test('walk pages until a short page', async () => {
    const { shop, calls } = makeShop();
    const rows = await shop._walkListing('toner');
    assert.equal(rows.length, 5);
    assert.deepEqual(calls.map(c => c.page), [1]);
});

test('loadProductCodes recounts only RELATED categories and never caches a failed recount', () => {
    assert.match(SHOP_CODE, /this\._chipsDerivedFrom === 'backend' && this\.RELATED_CATEGORY\[this\.state\.category\]/);
    assert.match(SHOP_CODE, /if \(!productsUnavailable && !countsPartial\) \{\s*this\.cache\.products\[codesCacheKey\] = codes;/);
});

test('click: ?code= asks the OWN category only; the related category joins by printer (ERR-358)', () => {
    assert.match(SHOP_CODE, /const requests = aliases\.map\(alias => \(\{ alias, category: loadApiCategory \}\)\);/);
    assert.match(SHOP_CODE, /const relatedRows = await this\._walkListing\(relatedCategory\)\.catch\(\(\) => null\);/);
    assert.match(SHOP_CODE, /if \(relatedRows === null\) \{\s*productsUnavailable = true;/, 'a failed walk is PARTIAL, never cached');
    assert.match(SHOP_CODE, /for \(const p of this\._printerPartners\(mergedProducts, relatedRows\)\)/);
    // ERR-354's TN/DR swap and the code-carrying join are gone.
    assert.doesNotMatch(SHOP_CODE, /_pairedCode|requests\[i\]\.match|listingCategories/);
});

test('_rowCarriesCode still decides OWN membership (yield tier, pair halves)', () => {
    const { shop } = makeShop();
    assert.equal(shop._rowCarriesCode(row('GC540X35GBK', 'drum_unit', ['C540']), 'C544'), false);
    assert.equal(shop._rowCarriesCode(row('X', 'ink_cartridge', ['604XL']), '604'), true, 'yield tier collapses');
    assert.equal(shop._rowCarriesCode(row('Y', 'ink_cartridge', ['CL511']), 'PG510/CL511'), true, 'pair half counts');
});
