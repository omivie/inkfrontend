'use strict';
/**
 * PDP "Pack contents & page yields" (owner, 15 Oct 2026), under the printer
 * list: "1 x Black (LC432XLBK): up to 3,000 pages" per cartridge in the box.
 *   - singles = themselves; packs = /api/products/:sku/constituents, each
 *     row's own `quantity` + integer `page_yield` (backend 2026-10-17, ERR-360);
 *   - no published yield => the line has no yield part (never invented);
 *   - `contents_known: false` => block hidden, `data-pack-contents` says why
 *     (fail-soft LOUD), never guessed from the pack's colour code;
 *   - own slot, so _mountCompat('') cannot wipe it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('html/product/index.html').replace(/<!--[\s\S]*?-->/g, '');
const JS = stripComments(read('js/product-detail-page.js'));
const API_JS = stripComments(read('js/api.js'));
const CSS = stripComments(read('css/pages.css'));

function method(src, name) {
    const m = new RegExp(`\\n        (?:async )?${name}\\(`).exec(src);
    assert.ok(m, `${name}() must exist`);
    const start = m.index;
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1).trim();
    }
    throw new Error(`unbalanced ${name}`);
}

const PURE = ['plausibleYield', 'yieldPhrase', 'displaySku', 'packContentsLines', 'packContentsHtml'];
const page = vm.runInNewContext(
    `({ MIN_PLAUSIBLE_YIELD: 50, ${PURE.map(n => method(JS, n)).join(',\n')} })`,
    { Security: { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') } }
);

test('yieldPhrase reads the leading count of every shape seen live, else ""', () => {
    assert.equal(page.yieldPhrase('3000'), 'up to 3,000 pages');
    assert.equal(page.yieldPhrase('1,600'), 'up to 1,600 pages');
    assert.equal(page.yieldPhrase('up to 550'), 'up to 550 pages');
    assert.equal(page.yieldPhrase('Up to 600'), 'up to 600 pages');
    assert.equal(page.yieldPhrase('250 ISO/IEC 24711'), 'up to 250 pages');
    assert.equal(page.yieldPhrase(833), 'up to 833 pages');
    for (const none of ['', null, undefined, '2 x 500 A4', '3', 'n/a']) {
        assert.equal(page.yieldPhrase(none), '', `${JSON.stringify(none)} has no yield`);
    }
});

test('displaySku drops only OUR marker for the product source', () => {
    assert.equal(page.displaySku('GLC432XLBK', 'genuine'), 'LC432XLBK');
    assert.equal(page.displaySku('CLC432XLBK', 'compatible'), 'LC432XLBK');
    assert.equal(page.displaySku('GCLI681BK', 'genuine'), 'CLI681BK');
    assert.equal(page.displaySku('CLI681BK', 'genuine'), 'CLI681BK', 'no G marker => unchanged');
});

test('single = one line of itself (page_yield_pages first, text fallback); no colour => nothing', () => {
    const base = { sku: 'GLC3317BK', source: 'genuine', pack_type: 'single', color: 'Black' };
    const text = page.packContentsLines({ ...base, pageYield: 'up to 550' }, null);
    assert.deepEqual(JSON.parse(JSON.stringify(text)), [{ qty: 1, color: 'Black', code: 'LC3317BK', yieldText: 'up to 550 pages' }]);
    assert.equal(page.packContentsLines({ ...base, page_yield_pages: 600, pageYield: 'bk 1,500 cl 1,000' }, null)[0].yieldText,
        'up to 600 pages', 'the backend integer wins over the text');
    assert.equal(page.packContentsLines({ ...base, page_yield_pages: null, pageYield: '' }, null)[0].yieldText, '');
    assert.equal(page.packContentsLines({ sku: 'X', pack_type: 'single', color: null }, null).length, 0);
});

// Live shape, GET /api/products/GLC432XLKCMY/constituents (2026-10-18).
const LC432XL = {
    pack_sku: 'GLC432XLKCMY', pack_type: 'value_pack', is_complete: true, contents_known: true,
    constituents: [
        { sku: 'GLC432XLBK', color: 'Black', quantity: 1, page_yield: 3000 },
        { sku: 'GLC432XLC', color: 'Cyan', quantity: 1, page_yield: 1500 },
        { sku: 'GLC432XLM', color: 'Magenta', quantity: 1, page_yield: null },
        { sku: 'GLC432XLY', color: 'Yellow', quantity: 1, page_yield: 1500 },
    ],
};

test('KCMY pack = the backend box list, each row its own yield; null yield stays empty', () => {
    const info = { sku: 'GLC432XLKCMY', source: 'genuine', pack_type: 'value_pack', color: 'KCMY' };
    assert.deepEqual(page.packContentsLines(info, LC432XL).map(l => `${l.qty} ${l.color} ${l.code} ${l.yieldText}`), [
        '1 Black LC432XLBK up to 3,000 pages',
        '1 Cyan LC432XLC up to 1,500 pages',
        '1 Magenta LC432XLM ',
        '1 Yellow LC432XLY up to 1,500 pages',
    ]);
});

test('twin pack = the row quantity (G45BK-2PK ⇒ G45BK × 2), never the name or savings count', () => {
    const contents = { contents_known: true, constituents: [{ sku: 'G45BK', color: 'Black', quantity: 2, page_yield: 833 }] };
    const info = { sku: 'G45BK-2PK', source: 'genuine', pack_type: 'multipack', name: 'HP Genuine 45BK 3-Pack', pack_savings_vs_singles: { cartridge_count: 1 } };
    const [line] = page.packContentsLines(info, contents);
    assert.equal(line.qty, 2);
    assert.equal(line.yieldText, 'up to 833 pages');
    assert.match(page.packContentsHtml(info, [line]), /2 x Black \(45BK\)[\s\S]*cartridges\./);
});

test('contents_known false / missing / no list => no lines (never guessed from colour code)', () => {
    const info = { sku: 'GPG645VPVP', pack_type: 'value_pack', color: 'Value Pack' };
    assert.equal(page.packContentsLines(info, { contents_known: false, is_complete: true, constituents: [] }).length, 0);
    assert.equal(page.packContentsLines(info, { ...LC432XL, contents_known: false }).length, 0, 'a list the backend disowns is not shown');
    assert.equal(page.packContentsLines(info, { constituents: LC432XL.constituents }).length, 0, 'absent flag = not known');
    assert.equal(page.packContentsLines(info, null).length, 0);
});

test('HTML: colon only with a yield, escaped, genuine/compatible note', () => {
    const lines = [{ qty: 1, color: 'Black', code: 'LC432XLBK', yieldText: 'up to 3,000 pages' }, { qty: 1, color: '<b>', code: 'X', yieldText: '' }];
    const g = page.packContentsHtml({ source: 'genuine', brandName: 'Brother' }, lines);
    assert.match(g, /Pack contents &amp; page yields/);
    assert.match(g, /<li><strong>1 x Black \(LC432XLBK\):<\/strong> up to 3,000 pages<\/li>/);
    assert.match(g, /<li><strong>1 x &lt;b&gt; \(X\)<\/strong><\/li>/);
    assert.match(g, /Genuine Brother cartridges\./);
    const c = page.packContentsHtml({ source: 'compatible', brandName: 'Brother', series_codes: ['LC432'] }, lines.slice(0, 1));
    assert.match(c, /Compatible cartridge, made to replace genuine Brother LC432\./);
    assert.equal(page.packContentsHtml({}, []), '');
});

test('wiring: own slot after the compat slot, one writer, loud state, API wrapper, phone order', () => {
    const compat = HTML.indexOf('id="product-compat-slot"');
    const slot = HTML.indexOf('<div class="product-gallery__contents" id="product-contents-slot" hidden>');
    assert.ok(compat > 0 && slot > compat && slot < HTML.indexOf('<div class="product-info">'));
    assert.equal((JS.match(/product-contents-slot/g) || []).length, 1, 'ONE writer');
    assert.doesNotMatch(method(JS, '_mountCompat'), /product-contents-slot/);
    const render = method(JS, 'renderPackContents');
    for (const state of ["'ok'", "'partial'", "'absent'", "'error'"]) assert.ok(render.includes(state), `state ${state}`);
    assert.match(render, /API\.getProductConstituents\(info\.sku\)/);
    assert.doesNotMatch(render, /API\.getProduct\(/, 'no per-constituent product read (ERR-360)');
    assert.match(JS, /this\.renderCompatiblePrinters\(info\);\s*this\.renderPackContents\(info\);/);
    assert.match(API_JS, /getProductConstituents\(sku\)\s*\{\s*return this\.getPublic\(`\/api\/products\/\$\{encodeURIComponent\(sku\)\}\/constituents`\)/);
    assert.match(CSS, /\.product-gallery__compat \{ order: 1; \}\s*(?:\.product-gallery > #pack-upsell \{ order: 1; \}\s*)?\.product-gallery__contents \{ order: 1; \}/);
});
