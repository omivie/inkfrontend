/**
 * ERR-403 — backend update 27 Nov 2026 (`backend-docs/inbox/backend-update-2026-11-27.md`).
 *
 * 26 printers of 7 brands (acroprint, axiohm, hypercom, optima, silver-reed,
 * verifone, vertex) have a printer page but NO brand page. Their brand crumb
 * linked to /shop?brand=<slug> — an empty listing today, a 404 once FE-2b ships.
 *
 *   _brandPage(slug)  the ONE reader: /api/brands row ⇒ 'yes' (no request);
 *                     else /api/schema/collection (404 ⇒ 'no'); a failure is
 *                     'unknown', never memoised, crumb kept.
 *   updateBreadcrumb  drops a brand LINK to a brand with no page (a current
 *                     brand item stays), and writes data-brand-page.
 *   updateSEO         the ONE #shop-schema writer (updateSchemaLD deleted: its
 *                     output was always overwritten); brand item = brand page,
 *                     left out for a brand with none; dateModified now survives.
 *   createBreadcrumbItem  the current crumb is TEXT (the search crumb carries ?q=).
 *
 * Executes the real methods out of shop-page.js against a stub DOM.
 * Run: node --test tests/brandless-printer-crumb-nov2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const SRC = stripComments(fs.readFileSync(path.join(__dirname, '..', 'inkcartridges', 'js', 'shop-page.js'), 'utf8'));
const BASE = 'https://www.inkcartridges.co.nz';

function methodSrc(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0; let q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(name, self, globals = {}) {
    const { params, body } = methodSrc(SRC, name);
    const keys = Object.keys(globals);
    return new Function(...keys, `return (function (${params}) ${body});`)(...keys.map((k) => globals[k])).bind(self);
}

// ── stub DOM ────────────────────────────────────────────────────────────────
function el(tag) {
    const node = {
        tag, children: [], dataset: {}, className: '', textContent: '', _html: null,
        classList: { list: [], add(c) { this.list.push(c); } },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {},
    };
    Object.defineProperty(node, 'innerHTML', {
        get() { return node._html; },
        set(v) { node._html = v; if (v === '') node.children = []; },
    });
    return node;
}
const crumbText = (li) => (li.children[0] && li.children[0].textContent) || '';

/** A ShopPage-shaped object wired with the real methods. */
function world({ state, brands = [], collection = {}, failCollection = false } = {}) {
    const calls = [];
    const warns = [];
    const byId = { 'shop-schema': el('script') };
    const document = {
        createElement: el,
        getElementById: (id) => byId[id] || null,
        querySelector: () => null,
        head: el('head'),
    };
    const API = {
        getCollectionSchema: async ({ brand }) => {
            calls.push(brand);
            if (failCollection) return { ok: false, code: 'INTERNAL_ERROR', status: 503 };
            return collection[brand] === 404
                ? { ok: false, error: 'brand not found', code: 'NOT_FOUND' }
                : { collectionPage: { '@type': 'CollectionPage' }, breadcrumbs: {} };
        },
    };
    const DebugLog = { warn: (m) => warns.push(m) };
    const self = {
        state: { level: 'printer-products', brand: null, category: null, code: null, printer: null, search: null, ...state },
        cache: { brands },
        brandInfo: {},
        categories: [],
        CATEGORY_CANONICAL_BY_INTERNAL: { consumable: 'drums', label_tape: 'label', ribbons: 'ribbon' },
        navigationVersion: 1,
        elements: { breadcrumbList: el('ol') },
        _isReceiptListing() { return false; },
        _collectionDateModified() { return '2026-11-28T00:00:00.000Z'; },
        navigateTo() {},
        rerenders: 0,
    };
    const g = { document, API, DebugLog };
    for (const name of ['_brandRow', '_knowsBrand', '_brandPage', 'brandName', 'createBreadcrumbItem', 'updateBreadcrumb', 'updateSEO']) {
        self[name] = method(name, self, g);
    }
    const realBreadcrumb = self.updateBreadcrumb;
    self.updateBreadcrumb = () => { self.rerenders++; return realBreadcrumb(); };
    return { self, calls, warns, schema: () => JSON.parse(byId['shop-schema'].textContent || '{}') };
}
const settle = () => new Promise((r) => setImmediate(r));
const SILVER = { brand: 'silver-reed', printer: 'silver-reed-tw-3000', printerName: 'Silver Reed TW-3000' };
const BROTHER = { brand: 'brother', printer: 'brother-mfc-j870', printerName: 'Brother MFC-J870' };
const BROTHER_ROW = [{ slug: 'brother', name: 'Brother' }];

// ── _brandPage ──────────────────────────────────────────────────────────────
test('a brand in /api/brands has a page — no request', () => {
    const w = world({ brands: BROTHER_ROW });
    assert.equal(w.self._brandPage('brother'), 'yes');
    assert.equal(w.self._brandPage('Brother'), 'yes', 'case-insensitive (the backend is too)');
    assert.deepEqual(w.calls, []);
});

test('a brand in the local brandInfo map has a page — no request (printer pages never load /api/brands)', () => {
    const w = world();
    w.self.brandInfo = { canon: { name: 'Canon' } };
    assert.equal(w.self._brandPage('canon'), 'yes');
    assert.deepEqual(w.calls, []);
});

test('collection 404 ⇒ "no", memoised (one request per slug)', async () => {
    const w = world({ collection: { 'silver-reed': 404 } });
    assert.equal(w.self._brandPage('silver-reed'), 'unknown', 'first call only starts the check');
    assert.equal(w.self._brandPage('silver-reed'), 'unknown', 'still pending');
    await settle();
    assert.equal(w.self._brandPage('silver-reed'), 'no');
    assert.deepEqual(w.calls, ['silver-reed']);
});

test('Okin (not in /api/brands, collection 200) ⇒ "yes"', async () => {
    const w = world();
    w.self._brandPage('okin');
    await settle();
    assert.equal(w.self._brandPage('okin'), 'yes');
});

test('a failed check is "unknown", NOT memoised (next call asks again), warns once', async () => {
    const w = world({ failCollection: true });
    w.self._brandPage('silver-reed');
    await settle();
    assert.equal(w.self._brandPage('silver-reed'), 'unknown');
    await settle();
    w.self._brandPage('silver-reed');
    await settle();
    assert.equal(w.calls.length, 3, 'each call after a failure is a real request (ERR-264)');
    assert.equal(w.warns.length, 1);
});

test('a "no" re-renders the crumb when that brand is still on screen', async () => {
    const w = world({ state: SILVER, collection: { 'silver-reed': 404 } });
    w.self._brandPage('silver-reed');
    await settle();
    assert.equal(w.self.rerenders, 1);
    const other = world({ state: BROTHER, brands: BROTHER_ROW, collection: { 'silver-reed': 404 } });
    other.self._brandPage('silver-reed');
    await settle();
    assert.equal(other.self.rerenders, 0, 'another brand on screen ⇒ no repaint');
});

// ── visible breadcrumb ──────────────────────────────────────────────────────
async function crumbs(w) {
    w.self._brandPage(w.self.state.brand);
    await settle();
    w.self.updateBreadcrumb();
    const list = w.self.elements.breadcrumbList;
    return { items: list.children.map(crumbText), state: list.dataset.brandPage };
}

test('silver-reed printer page: Shop › printer — no brand crumb', async () => {
    const r = await crumbs(world({ state: SILVER, collection: { 'silver-reed': 404 } }));
    assert.deepEqual(r.items, ['Shop', 'Silver Reed TW-3000']);
    assert.equal(r.state, 'no');
});

test('brother printer page keeps Shop › Brother › printer (control)', async () => {
    const r = await crumbs(world({ state: BROTHER, brands: BROTHER_ROW }));
    assert.deepEqual(r.items, ['Shop', 'Brother', 'Brother MFC-J870']);
    assert.equal(r.state, 'yes');
});

test('unknown (check failed) keeps the brand crumb, says unknown', async () => {
    const r = await crumbs(world({ state: SILVER, failCollection: true }));
    assert.deepEqual(r.items, ['Shop', 'Silver Reed', 'Silver Reed TW-3000']);
    assert.equal(r.state, 'unknown');
});

test('the brand as the CURRENT page stays (it is not a link)', async () => {
    const r = await crumbs(world({ state: { level: 'categories', brand: 'silver-reed' }, collection: { 'silver-reed': 404 } }));
    assert.deepEqual(r.items, ['Shop', 'Silver Reed']);
});

test('the current crumb is text: ?q= markup is not parsed', () => {
    const w = world();
    const li = w.self.createBreadcrumbItem('Search: "<img src=x>"', true);
    assert.equal(li._html, null, 'no innerHTML');
    assert.equal(li.children[0].textContent, 'Search: "<img src=x>"');
    assert.doesNotMatch(methodSrc(SRC, 'createBreadcrumbItem').body, /innerHTML/);
});

// ── #shop-schema ────────────────────────────────────────────────────────────
async function schemaFor(opts) {
    const w = world(opts);
    w.self._brandPage(w.self.state.brand);
    await settle();
    w.self.updateSEO();
    return w.schema();
}
const items = (s) => s.breadcrumb.itemListElement;

test('silver-reed printer: no brand ListItem, no item at /shop?brand=silver-reed', async () => {
    const s = await schemaFor({ state: SILVER, collection: { 'silver-reed': 404 } });
    assert.deepEqual(items(s).map((i) => i.name), ['Home', 'Shop', 'Silver Reed TW-3000']);
    assert.deepEqual(items(s).map((i) => i.position), [1, 2, 3]);
    assert.ok(!items(s).some((i) => i.item === `${BASE}/shop?brand=silver-reed`));
    assert.equal(s.url, `${BASE}/shop?brand=silver-reed&printer_slug=silver-reed-tw-3000`, 'canonical unchanged (FE-2 owns printer URLs)');
});

test('brother printer: brand item links the brand page, last item is the printer page', async () => {
    const s = await schemaFor({ state: BROTHER, brands: BROTHER_ROW });
    assert.deepEqual(items(s).map((i) => [i.name, i.item]), [
        ['Home', `${BASE}/`],
        ['Shop', `${BASE}/shop`],
        ['Brother', `${BASE}/shop?brand=brother`],
        ['Brother MFC-J870', `${BASE}/shop?brand=brother&printer_slug=brother-mfc-j870`],
    ]);
});

test('dateModified reaches #shop-schema (it never did while updateSchemaLD wrote it)', async () => {
    const s = await schemaFor({ state: BROTHER, brands: BROTHER_ROW });
    assert.equal(s.dateModified, '2026-11-28T00:00:00.000Z');
});

test('ONE #shop-schema writer: updateSchemaLD is gone', () => {
    assert.doesNotMatch(SRC, /updateSchemaLD/);
    assert.equal((SRC.match(/getElementById\('shop-schema'\)/g) || []).length, 1);
});

test('init asks early, right after parseURLState', () => {
    const init = methodSrc(SRC, 'init').body;
    const parse = init.indexOf('this.parseURLState()');
    const ask = init.indexOf('this._brandPage(this.state.brand)');
    assert.ok(parse > -1 && ask > parse && ask < init.indexOf('this.injectCollectionSchema()'));
});
