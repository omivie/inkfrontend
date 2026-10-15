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

const row = (id, product_type, series_codes) => ({ id, product_type, series_codes });
// Live shape, measured 2026-10-15 (Brother).
const TONER_ROWS = [
    row('GTN2415BK', 'toner_cartridge', ['TN2415', 'DR2415']),
    row('GTN2445BK', 'toner_cartridge', ['TN2445', 'TN2415', 'TN2449', 'DR2415']),
    row('CTN2445BK', 'toner_cartridge', ['TN2445', 'TN2415', 'TN2449', 'DR2415']),
    row('CTN2449BK', 'toner_cartridge', ['TN2449', 'DR2415']),
];
const DRUM_ROWS = [
    row('GDR2415BK', 'drum_unit', ['DR2415']),
    row('CDR2415BK', 'drum_unit', ['DR2415', 'TN2415', 'TN2449']),
    row('GDR2530BK', 'drum_unit', ['DR2530', 'TN2530']),
    row('CDR2530BK', 'drum_unit', ['DR2530', 'TN2530']),
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
    const body = ['_listingApiCategories', '_rowCarriesCode', '_pairedCode', '_walkListing', '_recountChipsFromListing'].map(methodSource).join(',\n');
    const shop = vm.runInContext(`({
        RELATED_CATEGORY: { toner: 'consumable', consumable: 'toner' },
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

test('toner tile DR2415 counts the 4 toners AND the 2 drums (6); TN2449 counts its drum', async () => {
    const { shop, warnings } = makeShop();
    const chips = [{ code: 'DR2415', count: 5 }, { code: 'TN2449', count: 4 }, { code: 'TN2530', count: 9 }];
    const r = await shop._recountChipsFromListing(chips);
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(r.codes.map(c => [c.code, c.count]))), [['DR2415', 6], ['TN2449', 3 + 1], ['TN2530', 2]]);
    assert.equal(shop._chipCountsFrom, 'listing-rows');
    assert.ok(warnings.some(w => /DR2415 series=5 rows=6/.test(w)), 'backend drift is logged per chip');
});

test('a chip no listing row carries is dropped (it would open empty)', async () => {
    const { shop } = makeShop();
    const r = await shop._recountChipsFromListing([{ code: 'DR9999', count: 2 }, { code: 'DR2530', count: 2 }]);
    assert.deepEqual([...r.codes.map(c => c.code)], ['DR2530']);
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
    assert.equal(rows.length, 4);
    assert.deepEqual(calls.map(c => c.page), [1]);
});

test('loadProductCodes recounts only RELATED categories and never caches a failed recount', () => {
    assert.match(SHOP_CODE, /this\._chipsDerivedFrom === 'backend' && this\.RELATED_CATEGORY\[this\.state\.category\]/);
    assert.match(SHOP_CODE, /if \(!productsUnavailable && !countsPartial\) \{\s*this\.cache\.products\[codesCacheKey\] = codes;/);
});

test('loadProducts fans out each alias over every category the tile spans', () => {
    assert.match(SHOP_CODE, /aliases\.flatMap\(alias =>\s*listingCategories\.map\(category => \(\{ alias, category, match: alias \}\)\)\)/);
    assert.match(SHOP_CODE, /listingCategories = this\.RELATED_CATEGORY\[this\.state\.category\]\s*\?\s*this\._listingApiCategories\(\)\s*:\s*\[loadApiCategory\]/);
});

test('a related-category row joins the click ONLY when it carries the code (Lexmark C544 ⇒ C540 drum)', () => {
    const { shop } = makeShop();
    assert.equal(shop._rowCarriesCode(row('GC540X35GBK', 'drum_unit', ['C540']), 'C544'), false);
    assert.equal(shop._rowCarriesCode(row('CDR2415BK', 'drum_unit', ['DR2415', 'TN2415']), 'TN2415'), true);
    assert.equal(shop._rowCarriesCode(row('X', 'ink_cartridge', ['604XL']), '604'), true, 'yield tier collapses');
    assert.equal(shop._rowCarriesCode(row('Y', 'ink_cartridge', ['CL511']), 'PG510/CL511'), true, 'pair half counts');
    assert.match(SHOP_CODE, /const related = requests\[i\]\.category !== listingCategories\[0\];/);
    assert.match(SHOP_CODE, /if \(related && !this\._rowCarriesCode\(p, requests\[i\]\.match\)\) continue;/);
});

// ERR-354 — owner 10-16: Brother TN1070 toner and DR1070 drum show together.
// Measured: ?code=TN1070 returns NO drums (both categories) although the drums
// are tagged ['DR1070','TN1070']; ?code=DR1070 returns all four rows.
test('Brother TN/DR pairing: _pairedCode swaps the prefix, Brother only', () => {
    const { shop } = makeShop();
    shop.state.brand = 'brother';
    assert.equal(shop._pairedCode('TN1070'), 'DR1070');
    assert.equal(shop._pairedCode('dr2425'), 'TN2425');
    assert.equal(shop._pairedCode('LC3317'), null, 'ink is not a toner/drum pair');
    shop.state.brand = 'hp';
    assert.equal(shop._pairedCode('TN1070'), null, 'negative control: other brands untouched');
});

test('Brother TN1070 click also asks the related category by DR1070, joined on the CLICKED code', () => {
    assert.match(SHOP_CODE, /const paired = listingCategories\.length > 1 \? this\._pairedCode\(code\) : null;/);
    assert.match(SHOP_CODE, /\.concat\(paired \? \[\{ alias: paired, category: listingCategories\[1\], match: code \}\] : \[\]\)/);
    // The drum the paired request returns joins because it carries TN1070.
    const { shop } = makeShop();
    assert.equal(shop._rowCarriesCode(row('CDR1070BK', 'drum_unit', ['DR1070', 'TN1070']), 'TN1070'), true);
});
