/**
 * /shop toner & drum code tiles: the backend owns the numbers (ERR-384)
 * =====================================================================
 *
 * History. ERR-337/358/379 (Oct–Nov 2026): the backend's `series[].count`, its
 * `?code=` listing and its `series_codes` disagreed about drums on toner tiles,
 * so the storefront walked whole categories (up to 20 pages each) to recount
 * every tile, joined drums to toners by printer itself, and dropped drum codes
 * that had leaked onto the toner grid.
 *
 * Backend 5c8b73b (2026-11-20) fixed all three at the source, and it was
 * measured before anything here was deleted: `probe:chip-counts` across every
 * brand `/api/brands` lists = 0 tile ≠ click and 0 cross-type tiles
 * (errors.md ERR-384 has the numbers). Owner approved removing the walk.
 *
 * What this file pins:
 *   §1 the walk, the printer join and the partner-code filter are GONE — a
 *      half-revert would bring back 20-page walks on every toner page;
 *   §2 tile counts are the backend's (no recount, cache only an answer);
 *   §3 an old tile link (?category=toner&code=DR2415) is moved to the
 *      category whose tile that code is, instead of a dead end;
 *   §4 the probe is now the only drift detector, so it must keep checking.
 *
 * Run with: node --test tests/shop-code-tiles-backend-owned-nov2026.test.js
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
const PROBE_SRC = read('scripts/probe-chip-counts.mjs');

/** Source of one (optionally async) object-literal method of shop-page.js. */
function methodSource(name) {
    const m = new RegExp(`\\n {8}(async )?${name}\\(`).exec(SHOP_SRC);
    assert.ok(m, `${name} must exist in shop-page.js`);
    const start = m.index + 1;
    let depth = 0;
    // The BODY brace ends the signature line — a destructured parameter
    // ({ packFilter = null } = {}) has braces of its own before it.
    for (let j = SHOP_SRC.indexOf('{\n', start); j < SHOP_SRC.length; j++) {
        if (SHOP_SRC[j] === '{') depth++;
        else if (SHOP_SRC[j] === '}' && --depth === 0) return SHOP_SRC.slice(start, j + 1).trim();
    }
    assert.fail(`${name} must be brace-balanced`);
}

// ── §1 removed ───────────────────────────────────────────────────────────────

test('§1 the FE recount walk, printer join and partner-code filter are deleted', () => {
    for (const gone of ['_recountChipsFromListing', '_walkListing', '_printerPartners',
        '_partnerOnlyCode', '_listingApiCategories', '_rowCarriesCode', 'PRINTER_PAIR',
        'RELATED_WALK_FAILED', '_chipsDroppedAsPartner', '_chipCountsFrom']) {
        assert.ok(!SHOP_CODE.includes(gone), `${gone} is back — the backend owns pairing since 5c8b73b (ERR-384)`);
    }
});

// ── §2 backend counts ────────────────────────────────────────────────────────

test('§2 loadProductCodes caches the backend chip list as-is once it is an answer', () => {
    const fn = stripComments(methodSource('loadProductCodes'));
    assert.ok(!/countsPartial/.test(fn), 'no recount ⇒ no partial-recount flag');
    assert.match(fn, /if \(!productsUnavailable\) \{\s*this\.cache\.products\[codesCacheKey\] = codes;/,
        'ERR-264 still holds: an outage is never memoised');
});

test('§2 a code click asks the OWN category only — the backend listing already holds the pairs', () => {
    const fn = stripComments(methodSource('loadProducts'));
    const ask = fn.slice(fn.indexOf('const requests = aliases.map('), fn.indexOf('const seenIds'));
    assert.match(ask, /category: loadApiCategory/);
    assert.ok(!/relatedCategory/.test(fn));
});

// ── §3 old tile links ────────────────────────────────────────────────────────

function makeShop({ category = 'toner', code = 'DR2415', answer } = {}) {
    const calls = [];
    const warnings = [];
    const urls = [];
    const sandbox = {
        API: { async getShopData(params) { calls.push(params); return answer(params); } },
        DebugLog: { warn: (m) => warnings.push(m), error() {}, log() {} },
    };
    vm.createContext(sandbox);
    const shop = vm.runInContext(`({
        RELATED_CATEGORY: { toner: 'consumable', consumable: 'toner' },
        categories: [
            { id: 'ink', apiCategory: 'ink' },
            { id: 'toner', apiCategory: 'toner' },
            { id: 'consumable', apiCategory: 'drums' },
        ],
        state: { brand: 'brother', category: ${JSON.stringify(category)}, code: ${JSON.stringify(code)} },
        ${methodSource('_adoptPartnerCategory')}
    })`, sandbox);
    shop.updateURL = (opts) => urls.push([shop.state.category, opts]);
    return { shop, calls, warnings, urls };
}

const DRUMS = [{ id: 'GDR2415BK', product_type: 'drum_unit' }, { id: 'CDR2415BK', product_type: 'drum_unit' }];

test('§3 ?category=toner&code=DR2415 becomes the drums DR2415 page (replaceState, not a navigation)', async () => {
    const { shop, calls, urls, warnings } = makeShop({
        answer: (p) => ({ ok: true, data: { products: p.category === 'drums' ? DRUMS : [] } }),
    });
    const rows = await shop._adoptPartnerCategory(['DR2415']);
    assert.deepEqual([...rows.map(r => r.id)], ['GDR2415BK', 'CDR2415BK']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].category, 'drums', 'asks the partner category by its API slug');
    assert.equal(calls[0].code, 'DR2415');
    assert.equal(shop.state.category, 'consumable');
    assert.deepEqual(JSON.parse(JSON.stringify(urls)), [['consumable', { replace: true }]]);
    assert.ok(warnings.some(w => /old tile link/.test(w)), 'the move is logged');
});

test('§3 drums + TN code moves to toner; every yield alias is asked and de-duplicated', async () => {
    const T = { id: 'GTN2445BK', product_type: 'toner_cartridge' };
    const { shop, calls } = makeShop({
        category: 'consumable', code: 'TN2445',
        answer: () => ({ ok: true, data: { products: [T] } }),
    });
    const rows = await shop._adoptPartnerCategory(['TN2445', 'TN2445XL']);
    assert.equal(calls.length, 2);
    assert.deepEqual([...rows.map(r => r.id)], ['GTN2445BK']);
    assert.equal(shop.state.category, 'toner');
});

test('§3 a truly empty code stays put: no rows ⇒ null, state and URL untouched', async () => {
    const { shop, urls } = makeShop({ answer: () => ({ ok: true, data: { products: [] } }) });
    assert.equal(await shop._adoptPartnerCategory(['ZZ999']), null);
    assert.equal(shop.state.category, 'toner');
    assert.equal(urls.length, 0);
});

test('§3 a failed partner ask is LOUD and changes nothing', async () => {
    const { shop, warnings, urls } = makeShop({
        answer: () => { throw Object.assign(new Error('429'), { code: 'RATE_LIMITED' }); },
    });
    assert.equal(await shop._adoptPartnerCategory(['DR2415']), null);
    assert.ok(warnings.some(w => /RATE_LIMITED/.test(w) && /may be wrong/.test(w)));
    assert.equal(urls.length, 0);
});

test('§3 ink (no partner) never asks anything', async () => {
    const { shop, calls } = makeShop({ category: 'ink', code: 'LC431', answer: () => assert.fail('asked') });
    assert.equal(await shop._adoptPartnerCategory(['LC431']), null);
    assert.equal(calls.length, 0);
});

test('§3 loadProducts adopts only on a real empty, and never caches the adopted rows under the old key', () => {
    const fn = stripComments(methodSource('loadProducts'));
    assert.match(fn, /if \(!mergedProducts\.length && !productsUnavailable\) \{\s*const adopted = await this\._adoptPartnerCategory\(aliases/,
        'an outage is not an empty listing — never redirect on a failure');
    assert.match(fn, /if \(adoptedCategory\) \{\s*\} else if \(mergedProducts\.length > 0 && !productsUnavailable\) \{\s*this\.cache\.products\[productCacheKey\] = mergedProducts;/,
        'adopted rows are neither cached nor reported as a PARTIAL outage');
});

// ── §4 the probe is the drift detector now ───────────────────────────────────

test('§4 probe:chip-counts mirrors the storefront tile and checks cross-type tiles, read-only', () => {
    assert.match(PROBE_SRC, /READ-ONLY/);
    assert.match(PROBE_SRC, /\/api\/brands/, 'every brand the API lists, not a stale hard-coded nine');
    assert.match(PROBE_SRC, /CROSS-TYPE/);
    assert.match(PROBE_SRC, /X\{1,3\}L/, 'yield variants collapse as SeriesCodes.collapseChipList does');
    assert.ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/.test(PROBE_SRC), 'GET only');
    assert.match(PROBE_SRC, /process\.exit\(fails\.length \|\| crossType\.length \? 1 : 0\)/);
});
