/**
 * FE checklist 2026-10-22 — tracking + compliance (ERR-369)
 * =============================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md (22 Oct version).
 *
 *   §35  /privacy names the Google Ads + Microsoft Advertising tags in the
 *        processor list, the cookie table and the cookie paragraph, in the words
 *        the backend's prerendered page uses; nothing on the site denies them.
 *   §45  ONE GA4 property, G-YJXTSGLM28 (the owner's, fed by the server's
 *        purchase events); G-SDQELG0FGD appears in no HTML and no gtag config.
 *        (The exact-set pins live in ga4-ecommerce-events-sep2026.test.js.)
 *   §34  gclid / gbraid / wbraid: captured together, a new ad click replaces
 *        all three, 90-day expiry, gbraid/wbraid sent on BOTH order bodies.
 *   §33  error / Retry states send `client_error` "<surface> <METHOD> <path>
 *        <status>", the failing request read from the one fetch layer.
 *   §43  `grid_ready <ms>` once per page; grid Add buttons file
 *        `add_to_cart:<product id>`; the cart POST carries X-Session-Id;
 *        `ic_internal` / navigator.webdriver silence the beacon.
 *
 * Behaviour is EXECUTED where it can be (utils.js required, main.js / api.js
 * functions run in a vm), so a test cannot pass on a comment.
 *
 * Run: node --test tests/fe-checklist-22oct-tracking-2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const code = (rel) => stripComments(read(rel));

/** Brace-matched body of `function name(` in src (comments stripped first). */
function fnSource(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} must exist`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}

function memStorage(init = {}) {
    const m = new Map(Object.entries(init));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m,
    };
}

// ═══ §35 privacy ════════════════════════════════════════════════════════════

test('§35 dataProcessors names Google Ads / Microsoft Advertising in the backend\'s words', () => {
    const src = read('js/legal-config.js');
    assert.ok(src.includes("{ name: 'Google Ads / Microsoft Advertising', purpose: 'Advertising measurement: ad-click identifiers, the value of orders that followed an ad click, and cookie-based audiences of site visitors', region: 'United States' }"),
        'the processor row must match the spec (and the prerendered page) word for word');
});

test('§35 the cookie table has an Advertising row that does NOT claim to be optional', () => {
    const src = read('js/legal-config.js');
    const row = src.match(/\{ category: 'Advertising',[^}]*\}/);
    assert.ok(row, 'an "Advertising" cookie row must exist');
    assert.match(row[0], /Google Ads tag, Microsoft Advertising \(UET\) tag/);
    // gtag.js declares only analytics_storage — the ad tags are not behind the
    // bar, so "Optional" would be a false statement on a legal page.
    assert.match(row[0], /optional: false/);
    assert.match(row[0], /status: '[^']+'/, 'an explicit status label, not the derived "Required"');
    assert.match(code('js/gtag.js'), /gtag\('consent', 'default', \{\s*analytics_storage:[^}]*\}\);/,
        'premise check: consent mode still declares analytics_storage only');
    assert.match(code('js/legal-page.js'), /escapeHtml\(c\.status \|\| \(c\.optional \? 'Optional' : 'Required'\)\)/,
        'the renderer honours (and escapes) the status override');
});

test('§35 the cookie paragraph carries the owner-approved sentence', () => {
    const html = read('html/privacy.html');
    assert.ok(html.includes("Google Ads and Microsoft Advertising tags set cookies that tell us which ads led to an order, and let those platforms build audiences of our site's visitors, which we can use to decide who sees our ads."));
    assert.doesNotMatch(html, /Analytics and advertising cookies are optional/,
        'advertising cookies are not behind the consent bar — the page must not say they are optional');
});

test('§35 no page or script says the site uses no advertising cookies / profile', () => {
    const hits = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(html|js)$/.test(e.name)) {
                const txt = e.name.endsWith('.js') ? stripComments(fs.readFileSync(full, 'utf8')) : fs.readFileSync(full, 'utf8');
                if (/no advertising profile|do not use third-party advertising|no advertising cookies/i.test(txt)) hits.push(path.relative(INK, full));
            }
        }
    };
    walk(INK);
    assert.deepEqual(hits, []);
});

// ═══ §45 GA4 ════════════════════════════════════════════════════════════════

test('§45 every page loads gtag/js for G-YJXTSGLM28 and none for G-SDQELG0FGD', () => {
    const htmls = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full); else if (e.name.endsWith('.html')) htmls.push(full);
        }
    };
    walk(INK);
    let loaders = 0;
    for (const f of htmls) {
        const s = fs.readFileSync(f, 'utf8');
        assert.ok(!s.includes('G-SDQELG0FGD'), `${path.relative(INK, f)} still names the retired property`);
        if (s.includes('gtag/js?id=G-YJXTSGLM28')) loaders++;
    }
    assert.ok(loaders >= 40, `the loader must be on every storefront page (found ${loaders})`);
});

// ═══ §34 click ids ══════════════════════════════════════════════════════════

function loadClickIds({ search = '', store = {}, now = 1_000_000 } = {}) {
    const src = code('js/main.js');
    const prelude = src.match(/var CLICK_ID_KEYS = [^;]+;\s*var CLICK_ID_TTL_MS = [^;]+;/);
    assert.ok(prelude, 'CLICK_ID_KEYS / CLICK_ID_TTL_MS must exist');
    const localStorage = memStorage(store);
    const ctx = {
        URLSearchParams, localStorage, Number, String,
        window: { location: { search } },
        Date: { now: () => now },
    };
    vm.createContext(ctx);
    vm.runInContext(prelude[0] + fnSource(src, 'captureClickIds') + fnSource(src, 'getClickIds') + fnSource(src, 'getGclid')
        + ';this.api={captureClickIds,getClickIds,getGclid};', ctx);
    return { ...ctx.api, localStorage, ctx };
}

test('§34 gbraid alone is captured and read back; gclid stays null', () => {
    const { captureClickIds, getClickIds, getGclid } = loadClickIds({ search: '?brand=hp&gbraid=FE_TEST_1' });
    captureClickIds();
    assert.deepEqual({ ...getClickIds() }, { gbraid: 'FE_TEST_1' });
    assert.equal(getGclid(), null);
});

test('§34 gclid + gbraid together are both kept', () => {
    const { captureClickIds, getClickIds } = loadClickIds({ search: '?gclid=G1&gbraid=B1' });
    captureClickIds();
    assert.deepEqual({ ...getClickIds() }, { gclid: 'G1', gbraid: 'B1' });
});

test('§34 a NEW ad click replaces ALL THREE — no old gclid beside a new gbraid', () => {
    const t = loadClickIds({ search: '?gbraid=NEW', store: { gclid: 'OLD', wbraid: 'OLDW', gclid_expiry: String(9e15) } });
    t.captureClickIds();
    assert.deepEqual({ ...t.getClickIds() }, { gbraid: 'NEW' });
    assert.equal(t.localStorage.getItem('gclid'), null);
});

test('§34 a landing with no click id leaves the stored set alone', () => {
    const t = loadClickIds({ search: '?brand=hp', store: { gclid: 'KEEP', gclid_expiry: String(9e15) } });
    t.captureClickIds();
    assert.deepEqual({ ...t.getClickIds() }, { gclid: 'KEEP' });
});

test('§34 the set expires together after 90 days', () => {
    const t = loadClickIds({ search: '?wbraid=W', now: 0 });
    t.captureClickIds();
    assert.equal(t.localStorage.getItem('gclid_expiry'), String(90 * 24 * 60 * 60 * 1000));
    t.ctx.Date.now = () => 90 * 24 * 60 * 60 * 1000 + 1;
    assert.deepEqual({ ...t.getClickIds() }, {});
    assert.equal(t.localStorage.getItem('wbraid'), null);
});

test('§34 both order bodies (card/points AND PayPal) spread clickIdFields', () => {
    const src = code('js/payment-page.js');
    assert.equal((src.match(/\.\.\.this\.clickIdFields\(\)/g) || []).length, 1, 'the _orderPayload body');
    // ERR-376: PayPal's body IS _orderPayload now — no second spread to keep in step.
    assert.equal((src.match(/\.\.\.self\.clickIdFields\(\)/g) || []).length, 0, 'no hand-copied PayPal body');
    assert.match(src, /self\._orderPayload\('paypal', 'paypal'\)/, 'the PayPal body');
    const m = src.match(/clickIdFields\(\) \{[\s\S]*?\n        \},/);
    assert.ok(m);
    const fn = new Function('getClickIds', `return ({ ${m[0].replace(/,\s*$/, '')} }).clickIdFields();`);
    assert.deepEqual(fn(() => ({ gclid: 'G', gbraid: 'B', wbraid: 'W' })), { gbraid: 'B', wbraid: 'W' },
        'gclid has its own key; the spread adds only the iPhone ids');
    assert.deepEqual(fn(() => ({})), {}, 'absent ids are omitted, never null');
});

// ═══ §33 / §43 ClientBeacon ═════════════════════════════════════════════════

function freshBeacon() {
    delete require.cache[require.resolve('../inkcartridges/js/utils.js')];
    const { ClientBeacon } = require('../inkcartridges/js/utils.js');
    return ClientBeacon;
}

test('§33 client_error names surface, method, path and status from API.lastFailure', () => {
    const B = freshBeacon();
    const sent = [];
    global.window = { TrafficTracker: { send: (t, x) => sent.push([t, x.element]) }, addEventListener() {} };
    global.API = { lastFailure: { method: 'GET', path: '/api/shop?brand=hp&printer_slug=hp-deskjet-2820e', status: 429, at: Date.now() } };
    try {
        assert.equal(B.error('shop-drilldown'), true);
        assert.deepEqual(sent, [['client_error', 'shop-drilldown GET /api/shop?brand=hp&printer_slug=hp-deskjet-2820e 429']]);
        assert.equal(B.error('shop-drilldown'), false, 'the same failure on a re-render is one row, not many');
        global.API.lastFailure = { method: 'GET', path: '/api/shop?brand=x', status: 'timeout', at: Date.now() };
        B.error('shop-drilldown');
        assert.equal(sent[1][1], 'shop-drilldown GET /api/shop?brand=x timeout');
    } finally { delete global.window; delete global.API; }
});

test('§33 a stale or missing failure says "unknown", never blames an old request', () => {
    const B = freshBeacon();
    const sent = [];
    global.window = { TrafficTracker: { send: (t, x) => sent.push(x.element) }, addEventListener() {} };
    global.API = { lastFailure: { method: 'GET', path: '/api/old', status: 500, at: Date.now() - 60000 } };
    try {
        B.error('pdp');
        assert.deepEqual(sent, ['pdp unknown']);
    } finally { delete global.window; delete global.API; }
});

test('§33 the element is capped at the API\'s 512', () => {
    const B = freshBeacon();
    const sent = [];
    global.window = { TrafficTracker: { send: (t, x) => sent.push(x.element) }, addEventListener() {} };
    try {
        B.error('search-dropdown', { method: 'GET', path: '/api/search/smart?q=' + 'x'.repeat(900), status: 500 });
        assert.equal(sent[0].length, 512);
    } finally { delete global.window; }
});

test('§43 beacons fired before the deferred tracker loads are queued and flushed once', () => {
    const B = freshBeacon();
    global.window = { addEventListener() {} };
    try {
        B.gridReady();
        B.error('cart-pricing', { method: 'POST', path: '/api/cart/validate', status: 503 });
        assert.equal(B._queue.length, 2);
        const sent = [];
        global.window.TrafficTracker = { send: (t, x) => sent.push([t, x.element]) };
        B._flush();
        B._flush();
        assert.equal(sent.length, 2, 'flushed exactly once');
        assert.match(sent[0][1], /^grid_ready \d+$/);
        assert.equal(sent[1][1], 'cart-pricing POST /api/cart/validate 503');
    } finally { delete global.window; }
});

test('§43 grid_ready is ONE beacon per page load, element "grid_ready <ms>"', () => {
    const B = freshBeacon();
    const sent = [];
    global.window = { TrafficTracker: { send: (t, x) => sent.push([t, x.element]) }, addEventListener() {} };
    try {
        assert.equal(B.gridReady(), true);
        assert.equal(B.gridReady(), false);
        assert.equal(sent.length, 1);
        assert.equal(sent[0][0], 'grid_ready');
        assert.match(sent[0][1], /^grid_ready \d+$/);
    } finally { delete global.window; }
});

test('§33/§43 the tracker announces itself so the queue can flush', () => {
    assert.match(code('js/traffic-tracker.js'), /dispatchEvent\(new Event\('traffic-tracker:ready'\)\)/);
    assert.match(code('js/utils.js'), /window\.addEventListener\('traffic-tracker:ready', \(\) => ClientBeacon\._flush\(\)\)/);
});

// ═══ §33 the fetch layer records the failure ════════════════════════════════

function loadApi(fetchImpl) {
    const src = read('js/api.js');
    const ctx = {
        console, URL, URLSearchParams, AbortController, Headers, Promise, JSON, Math, Date, Error, Number, String, Object, Array,
        setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
        fetch: fetchImpl,
        location: { href: 'https://www.inkcartridges.co.nz/shop', origin: 'https://www.inkcartridges.co.nz', hostname: 'www.inkcartridges.co.nz' },
        localStorage: memStorage(), sessionStorage: memStorage(),
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
        Config: { API_URL: 'https://api.inkcartridges.co.nz' },
        document: { cookie: '' },
        navigator: {},
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src + '\n;this.__API = API;', ctx);
    return ctx.__API;
}

const resp = (status, body = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: async () => body,
});

test('§33 a 4xx response is recorded with method, path+query and status', async () => {
    const API = loadApi(async () => resp(404, { ok: false, error: { code: 'NOT_FOUND' } }));
    await API._fetchWithAuth('https://api.inkcartridges.co.nz/api/shop?brand=hp&printer_slug=x', { method: 'GET' });
    assert.equal(API.lastFailure.method, 'GET');
    assert.equal(API.lastFailure.path, '/api/shop?brand=hp&printer_slug=x');
    assert.equal(API.lastFailure.status, 404);
});

test('§33 a 429 that is not retried is recorded as 429', async () => {
    const API = loadApi(async () => resp(429));
    await assert.rejects(API._fetchWithAuth('https://api.inkcartridges.co.nz/api/cart/items', { method: 'POST' }));
    assert.equal(API.lastFailure.status, 429);
    assert.equal(API.lastFailure.method, 'POST');
});

test('§33 a network failure is recorded as "network"', async () => {
    const API = loadApi(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(API._fetchWithAuth('https://api.inkcartridges.co.nz/api/cart/items', { method: 'POST' }));
    assert.equal(API.lastFailure.status, 'network');
});

test('§33 a success records nothing (negative control)', async () => {
    const API = loadApi(async () => resp(200, { ok: true, data: {} }));
    await API._fetchWithAuth('https://api.inkcartridges.co.nz/api/shop', { method: 'GET' });
    assert.equal(API.lastFailure, null);
});

test('§33 the anon REST path records its failures too', async () => {
    const API = loadApi(async () => resp(503));
    const r = await API._anonRest('https://x.supabase.co/rest/v1/rpc/get_ribbons_by_brand', { method: 'POST' }, 'ribbons');
    assert.equal(r.ok, false);
    assert.equal(API.lastFailure.path, '/rest/v1/rpc/get_ribbons_by_brand');
    assert.equal(API.lastFailure.status, 503);
});

test('§33 every catalogue error state reports through ClientBeacon', () => {
    const shop = code('js/shop-page.js');
    const showError = shop.slice(shop.indexOf('showError(message, onRetry) {'), shop.indexOf('LEVEL LOADERS'));
    assert.match(showError, /ClientBeacon\.error\('shop-drilldown'\)/);
    // After the admin-repaint early return: a suppressed repaint is not a shopper error.
    assert.ok(showError.indexOf('ClientBeacon.error') > showError.indexOf('this._adminRepaint'));
    assert.match(fnSource(code('js/search.js'), 'renderError'), /ClientBeacon\.error\('search-dropdown'\)/);
    const pdp = code('js/product-detail-page.js');
    const pdpErr = pdp.slice(pdp.indexOf('showError(message) {'), pdp.indexOf('showError(message) {') + 1500);
    assert.match(pdpErr, /ClientBeacon\.error\('pdp'\)/);
    const cart = code('js/cart.js');
    const notice = cart.slice(cart.indexOf('_renderPricingNotice(shortfall) {'), cart.indexOf('_renderPricingNotice(shortfall) {') + 1500);
    assert.match(notice, /if \(degraded && typeof ClientBeacon !== 'undefined'\) ClientBeacon\.error\('cart-pricing'\)/);
    assert.match(code('js/ribbons-page.js'), /ClientBeacon\.error\(`ribbons-\$\{surface\}`\)/);
});

// ═══ §43 grid_ready / add_to_cart / X-Session-Id / ic_internal ═════════════

test('§43 grid_ready fires from the shop grid, the PDP and the ribbon grid', () => {
    const shop = code('js/shop-page.js');
    const render = shop.slice(shop.indexOf('\n        renderProducts('), shop.indexOf('\n        createProductCard('));
    assert.match(render, /if \(sortedProducts\.length && typeof ClientBeacon !== 'undefined'\) ClientBeacon\.gridReady\(\);/,
        'only once a card exists — an empty grid is not "ready"');
    assert.match(code('js/product-detail-page.js'), /this\.renderProduct\(\);\s*if \(typeof ClientBeacon !== 'undefined'\) ClientBeacon\.gridReady\(\);/);
    assert.match(code('js/ribbons-page.js'), /if \(items\.length && typeof ClientBeacon !== 'undefined'\) ClientBeacon\.gridReady\(\);/);
});

test('§43 every grid Add button carries data-track="add_to_cart:<product id>"', () => {
    for (const [file, id] of [['js/shop-page.js', 'product.id'], ['js/products.js', 'product.id'], ['js/ribbons-page.js', 'ribbonId']]) {
        const src = read(file);
        assert.ok(src.includes(`data-track="add_to_cart:\${Security.escapeAttr(String(${id}))}"`), `${file} grid Add`);
    }
    // The tracker reads data-track first, so the label is exactly that string.
    assert.match(code('js/traffic-tracker.js'), /if \(el\.dataset && el\.dataset\.track\) return cap\(el\.dataset\.track\);/);
});

test('§43 ic_internal and navigator.webdriver silence the beacon, not the ids', () => {
    const src = code('js/traffic-tracker.js');
    const isInternal = fnSource(src, 'isInternal');
    const run = (nav, store) => new Function('navigator', 'localStorage', `${isInternal}; return isInternal();`)(nav, store);
    assert.equal(run({}, memStorage({ ic_internal: '1' })), true);
    assert.equal(run({ webdriver: true }, memStorage()), true);
    assert.equal(run({ webdriver: false }, memStorage()), false, 'a shopper browser sends');
    assert.equal(run({}, { getItem() { throw new Error('blocked'); } }), false, 'blocked storage never throws');
    assert.match(fnSource(src, 'send'), /^function send\(payload\) \{\s*if \(isInternal\(\)\) return;/,
        'send() checks first, before building a request');
    // The DNT / admin early returns stay at load; the internal check must NOT
    // move there, or search + cart identity would vanish for QA too.
    const head = src.slice(0, src.indexOf('const SESSION_KEY'));
    assert.doesNotMatch(head, /ic_internal|isInternal/);
});
