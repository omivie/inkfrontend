/**
 * CATALOG EDGE CACHE — CANONICAL URLS + ANONYMOUS PUBLIC READS (ERR-124)
 * ======================================================================
 *
 * Context: the backend put catalog GETs behind a Cloudflare Cache Rule
 * (`/api/shop`, `/api/products*`, `/api/brands`) and handed over a note saying
 * "no FE code changes required — just don't fragment the cache key". Verifying
 * that note against the live API on 2026-07-28 found the opposite: the caching
 * is real and fast (cf-cache-status: HIT, 44 ms vs 205 ms), but the frontend
 * was fragmenting the key in four places AND was attaching a bearer token to
 * every catalog read.
 *
 * The two invariants this file exists to hold:
 *
 *   1. ONE CANONICAL QUERY STRING. Cloudflare keys its cache on the full URL
 *      including the query string and does NOT normalise param order —
 *      measured: `?category=ink&brand=x` MISSes against a warm
 *      `?brand=x&category=ink`. Every catalog URL must therefore be serialized
 *      by API.catalogQuery/catalogEndpoint, never hand-rolled. Before this,
 *      `_productsForCode()` was actively minting a duplicate of a URL
 *      `getShopData()` had already warmed, on the codes-drilldown hot path.
 *
 *   2. PUBLIC READS CARRY NO IDENTITY. Measured live: a request with
 *      `Authorization: Bearer …` still returns `cf-cache-status: HIT`. A token
 *      changes what the ORIGIN would return but NOT the cache key, so an
 *      authenticated catalog response is eligible to be stored in — and served
 *      from — the SHARED anonymous entry. Catalog helpers therefore declare
 *      `{ anonymous: true }`, and `credentials` is derived from that explicit
 *      intent rather than sniffed off the headers.
 *
 * Run with: node --test tests/catalog-edge-cache-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const API_SRC = READ(JS('api.js'));
const CART_SRC = READ(JS('cart.js'));
const PDP_SRC = READ(JS('product-detail-page.js'));

/**
 * Strip line comments so "is this CODE present?" assertions can't be satisfied
 * — or falsely tripped — by prose. Several comments below deliberately quote
 * the very code they replaced, which would otherwise match its own guard.
 * Block comments are left alone on purpose: a naive /* … *​/ regex treats the
 * "/​*" inside a path like `/api/products/​*` as a comment opener and eats the
 * rest of the file (this bit us for real while writing these tests).
 */
const stripLineComments = (src) => src.replace(/^\s*\/\/[^\n]*$/gm, '');

/** Cross-realm values lose prototype identity, which breaks deepEqual. */
const plain = (x) => JSON.parse(JSON.stringify(x));

/**
 * Slice one object-literal method out of api.js: from its signature to the
 * line that closes it at method indentation (`    },`). Fixed-width windows
 * silently truncate once a method grows a long doc comment, turning a real
 * assertion into a vacuous one.
 */
function methodBody(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `${signature} must exist in api.js`);
    const end = src.indexOf('\n    },', start);
    return src.slice(start, end === -1 ? src.length : end);
}

/**
 * Load the real API object into a vm sandbox so the serializer tests exercise
 * the live implementation rather than a copy of it. api.js is a globals module
 * (`const API = { … }; window.API = API;`), so pointing `window` at the sandbox
 * itself makes those assignments land where we can read them.
 */
function loadAPI() {
    const sandbox = {
        console,
        Map, Set, Promise, Date, JSON, Error, Object, Array,
        String, Number, Boolean, RegExp, Math, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
        structuredClone: (v) => JSON.parse(JSON.stringify(v)),
        fetch: () => Promise.reject(new Error('network disabled in tests')),
        AbortController: class { constructor() { this.signal = {}; } abort() {} },
        Headers: class { constructor() { this._m = new Map(); } has() { return false; } get() { return null; } set() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) },
        location: { hostname: 'localhost', search: '', pathname: '/' },
        navigator: { userAgent: 'node' },
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
        Config: { API_URL: 'https://api.example.test', ITEMS_PER_PAGE: 20, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', settings: {} },
        Auth: undefined,
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
    assert.ok(sandbox.API && typeof sandbox.API === 'object', 'api.js must define a global API object');
    return sandbox.API;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — CATALOG_PARAM_ORDER is the ONE list, and catalogQuery obeys it
// ─────────────────────────────────────────────────────────────────────────────

test('§1 CATALOG_PARAM_ORDER exists, is frozen in shape, and leads with getShopData\'s historical order', () => {
    const API = loadAPI();
    assert.ok(Array.isArray(API.CATALOG_PARAM_ORDER), 'API.CATALOG_PARAM_ORDER must be an array');
    // The first seven entries are getShopData's original append order. Keeping
    // them means the storefront's hottest URLs keep the edge entries they
    // already hold — reordering here silently cold-starts the whole catalog.
    assert.deepEqual(
        plain(API.CATALOG_PARAM_ORDER).slice(0, 7),
        ['brand', 'category', 'source', 'page', 'limit', 'search', 'code'],
        'the leading params must stay in getShopData\'s historical order or every warm cache key is invalidated'
    );
    assert.equal(
        new Set(API.CATALOG_PARAM_ORDER).size,
        API.CATALOG_PARAM_ORDER.length,
        'no duplicate keys — a repeated key would emit the param twice'
    );
    // Exactly one declaration in the source: two lists is how vocabularies drift.
    const decls = API_SRC.match(/CATALOG_PARAM_ORDER\s*:/g) || [];
    assert.equal(decls.length, 1, 'CATALOG_PARAM_ORDER must be declared exactly once');
});

test('§1 catalogQuery emits canonical order regardless of the caller\'s key order', () => {
    const API = loadAPI();
    const a = API.catalogQuery({ brand: 'canon', category: 'ink', code: 'PG510', limit: 200 });
    const b = API.catalogQuery({ limit: 200, code: 'PG510', category: 'ink', brand: 'canon' });
    assert.equal(a, b, 'object key order must not leak into the URL — that is a second Cloudflare cache entry');
    assert.equal(a, 'brand=canon&category=ink&limit=200&code=PG510',
        'canonical order is CATALOG_PARAM_ORDER, not insertion order');
});

test('§1 catalogQuery drops empty values instead of emitting bare key=', () => {
    const API = loadAPI();
    assert.equal(API.catalogQuery({ brand: 'hp', category: '', source: null, code: undefined }), 'brand=hp',
        'empty params must vanish — "?brand=hp&category=" is a different cache key from "?brand=hp"');
    assert.equal(API.catalogQuery({}), '', 'no params → empty string');
    assert.equal(API.catalogQuery(), '', 'no argument must not throw');
});

test('§1 catalogQuery PRESERVES params outside the canonical list, deterministically', () => {
    const API = loadAPI();
    // Silently dropping an unknown param is far worse than an extra cache key:
    // the caller gets a wrong-but-plausible result set (the ERR-075 failure
    // mode). Extras are kept, sorted, after the known keys.
    const q = API.catalogQuery({ source: 'genuine', include_unavailable: 'true', brand: 'epson', printer_slug: 'x' });
    assert.equal(q, 'brand=epson&source=genuine&include_unavailable=true&printer_slug=x',
        'unknown params must survive, sorted, after the canonical ones');
    const swapped = API.catalogQuery({ printer_slug: 'x', include_unavailable: 'true', brand: 'epson', source: 'genuine' });
    assert.equal(q, swapped, 'extras must also be order-independent');
});

test('§1 catalogEndpoint omits the "?" entirely when nothing survives', () => {
    const API = loadAPI();
    assert.equal(API.catalogEndpoint('/api/products', {}), '/api/products',
        '"/api/products?" and "/api/products" would be two cache keys for one resource');
    assert.equal(API.catalogEndpoint('/api/products', { brand: 'hp' }), '/api/products?brand=hp');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the duplicate-key regression that started this (D1)
// ─────────────────────────────────────────────────────────────────────────────

test('§2 the codes drilldown and _productsForCode resolve to ONE byte-identical URL', () => {
    const API = loadAPI();
    // getShopData used to append limit BEFORE code; _productsForCode appended
    // code BEFORE limit. Same question, two URLs, two edge entries — and both
    // are asked on the hot path (shop-page codes drilldown, PDP related).
    const viaShop = API.catalogEndpoint('/api/shop', { brand: 'canon', category: 'ink', code: 'PG510', limit: 200 });
    const viaCode = API.catalogEndpoint('/api/shop', { brand: 'canon', category: 'ink', code: 'PG510', limit: 200 });
    assert.equal(viaShop, viaCode);
    assert.equal(viaShop, '/api/shop?brand=canon&category=ink&limit=200&code=PG510');

    // And the source no longer hand-builds either of them.
    const fn = API_SRC.slice(API_SRC.indexOf('async _productsForCode'), API_SRC.indexOf('Re-home truncated products'));
    assert.ok(fn.length > 0, '_productsForCode must still exist');
    assert.match(fn, /catalogEndpoint\(\s*['"]\/api\/shop['"]/,
        '_productsForCode must build its URL through catalogEndpoint');
    assert.ok(!/qs\.append/.test(fn), '_productsForCode must not hand-append params any more');
});

test('§2 no catalog builder hand-rolls a query string', () => {
    // These are the helpers whose URLs Cloudflare caches. Each must delegate to
    // catalogQuery/catalogEndpoint so all call sites share one cache key.
    const builders = [
        'async getShopData',
        'async getProducts',
        'async _productsForCode',
        'async getProductsByPrinter',
        'async getColorPacks',
        'async getProductCounts',
        'async getProductReviews',
    ];
    for (const sig of builders) {
        const body = stripLineComments(methodBody(API_SRC, sig));
        assert.ok(
            !/new URLSearchParams\(/.test(body),
            `${sig} must not construct its own URLSearchParams — hand-rolled param order is what fragmented the edge cache into four spellings of the same query`
        );
        assert.match(
            body, /catalogEndpoint\(|catalogQuery\(/,
            `${sig} must build its URL through the canonical serializer`
        );
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — nothing unique-per-request may ever reach a catalog URL
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, acc);
        else if (name.endsWith('.js')) acc.push(full);
    }
    return acc;
}

const ALL_JS = walk(path.join(ROOT, 'inkcartridges', 'js'));

test('§3 no cache-buster param is appended to any catalog request', () => {
    // A unique value per request makes EVERY call a guaranteed edge MISS and
    // silently un-does the whole optimisation. This is the regression that is
    // easiest to introduce by reflex ("just add a timestamp to force a refresh")
    // and hardest to notice, because the site still works — only slower.
    const banned = /[?&](_t|_|cb|nocache|bust|rand)=/;
    const offenders = [];
    for (const file of ALL_JS) {
        const src = READ(file);
        for (const line of src.split('\n')) {
            if (!/\/api\/(shop|products|brands|site|schema)/.test(line)) continue;
            if (banned.test(line)) offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [], 'cache-busting params on catalog URLs defeat the Cloudflare edge cache entirely');
});

test('§3 no Date.now()/Math.random() is interpolated into a catalog URL', () => {
    const offenders = [];
    for (const file of ALL_JS) {
        const src = READ(file);
        for (const line of src.split('\n')) {
            if (!/\/api\/(shop|products|brands|site|schema)/.test(line)) continue;
            if (/\$\{[^}]*(Date\.now|Math\.random)/.test(line)) {
                offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, [], 'a per-request timestamp in a catalog URL is a 100% MISS rate');
});

test('§3 tracking params never ride along on an API fetch URL', () => {
    // utm_*/gclid/fbclid belong on the PAGE url. Copying location.search onto an
    // API request would fragment the cache per ad click — the worst possible
    // case, because paid traffic is exactly the traffic you want served fast.
    const offenders = [];
    for (const file of ALL_JS) {
        const src = READ(file);
        for (const line of src.split('\n')) {
            if (!/\/api\//.test(line)) continue;
            if (/[?&](utm_[a-z]+|gclid|fbclid)=/.test(line)) {
                offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, [], 'tracking params must not be appended to API request URLs');
});

test('§3 catalogQuery would not smuggle a tracking param through the extras tail', () => {
    const API = loadAPI();
    // Extras are preserved by design (§1), so the guard against tracking params
    // has to live at the call sites — which §3 above scans. This test documents
    // the boundary explicitly so nobody "fixes" it by making extras silent.
    const q = API.catalogQuery({ brand: 'hp', utm_source: 'google' });
    assert.equal(q, 'brand=hp&utm_source=google',
        'catalogQuery is deliberately not a filter — it preserves what it is given, and the source scan is what keeps tracking params out');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — public reads carry no identity
// ─────────────────────────────────────────────────────────────────────────────

test('§4 request() honours { anonymous: true } by never reading a token', () => {
    const head = methodBody(API_SRC, 'async request(endpoint');
    assert.match(head, /const anonymous = !!options\.anonymous;/,
        'request() must read an explicit anonymous flag');
    assert.match(head, /const token = anonymous \? null : await this\.getToken\(\);/,
        'an anonymous request must short-circuit token retrieval entirely, not fetch-then-discard');
});

test('§4 an anonymous request sends no Authorization and no guest-session header', () => {
    const head = methodBody(API_SRC, 'async request(endpoint');
    // Authorization is gated on `token`, which is null when anonymous.
    assert.match(head, /if \(token\) \{\s*headers\['Authorization'\]/,
        'Authorization must be attached only when a token exists');
    assert.match(head, /if \(!token && !anonymous && guestSession\)/,
        'X-Guest-Session is per-visitor; sending it on a shared cached read invites the backend to vary on it');
});

test('§4 an anonymous response never seeds the guest session id', () => {
    const head = methodBody(API_SRC, 'async request(endpoint');
    assert.match(head, /if \(!anonymous\) \{[\s\S]{0,320}setGuestSessionId\(respSessionId\)/,
        'anonymous responses come off a SHARED edge entry — adopting an X-Guest-Session from one would hand every visitor the same guest cart');
});

test('§4 the 401 refresh-and-retry never fires for an anonymous read', () => {
    assert.match(API_SRC, /response\.status === 401 && retryCount < this\.MAX_AUTH_RETRIES && !opts\.anonymous/,
        'refreshing a token on a declared-anonymous read would re-attach auth to exactly the requests we made public');
});

test('§4 the authenticated 401 retry preserves its credentials mode', () => {
    // Before ERR-124 this recursion rebuilt opts from scratch. That was harmless
    // only while credentials was inferred from headers; now that it is explicit,
    // dropping it would silently downgrade an authed retry to 'omit'.
    assert.match(API_SRC, /_fetchWithAuth\(url, \{ \.\.\.fetchOptions, headers \}, \{ \.\.\.opts, timeoutMs, retryCount: retryCount \+ 1, credentials: 'include' \}\)/,
        'the 401 retry must carry opts through and stay authenticated');
});

test('§4 getPublic exists and is the only sanctioned public-GET door', () => {
    const API = loadAPI();
    assert.equal(typeof API.getPublic, 'function', 'API.getPublic must exist');
    const fn = methodBody(API_SRC, 'async getPublic');
    assert.match(fn, /anonymous: true/, 'getPublic must set the anonymous flag');
    assert.match(fn, /method: 'GET'/, 'getPublic is GET-only');
});

test('§4 getWithSWR resolves its fetcher ONCE so background revalidation stays anonymous', () => {
    const body = API_SRC.slice(API_SRC.indexOf('async getWithSWR'), API_SRC.indexOf('// PRODUCTS'));
    assert.match(body, /anonymous = false/, 'getWithSWR must accept an anonymous option');
    assert.match(body, /const fetcher = anonymous \? \(ep\) => this\.getPublic\(ep\) : \(ep\) => this\.get\(ep\)/,
        'one fetcher for all three branches');
    assert.ok(!/=\s*this\.get\(endpoint\)/.test(body),
        'no branch may call this.get(endpoint) directly — a stale-revalidate that re-attached the token would reintroduce the bug');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — every catalog helper actually declares itself public
// ─────────────────────────────────────────────────────────────────────────────

test('§5 each edge-cached helper is an anonymous read', () => {
    /** helper signature → the marker proving it opted in */
    const cases = [
        ['async getProducts', /anonymous: true/],
        ['async getShopData', /anonymous: true/],
        ['async _productsForCode', /anonymous: true/],
        ['async getProductsByPrinter', /getPublic\(/],
        ['async getColorPacks', /getPublic\(/],
        ['async getRelatedProducts', /getPublic\(/],
        ['async getBoughtTogether', /getPublic\(/],
        ['async getProductJsonLd', /getPublic\(/],
        ['async getProductCounts', /getPublic\(/],
        ['async getProductSeries', /getPublic\(/],
        ['async getProductReviews', /getPublic\(/],
        ['async getReviewSummary', /getPublic\(/],
        ['async getBrands', /anonymous: true/],
        ['async getSiteNav', /anonymous: true/],
        ['async getSettings', /getPublic\(/],
    ];
    for (const [sig, marker] of cases) {
        const body = stripLineComments(methodBody(API_SRC, sig));
        assert.match(body, marker,
            `${sig} reads an edge-cached endpoint, so it must declare itself anonymous — an attached token does not change Cloudflare's cache key, it just risks storing an authed body in the shared entry`);
    }
});

test('§5 private endpoints were NOT swept into the anonymous path', () => {
    // The blast radius check. These must still authenticate.
    for (const sig of ['async getCart', 'async getUserReviews', 'async getFavourites']) {
        if (API_SRC.indexOf(sig) === -1) continue; // named differently; skip rather than false-fail
        const body = stripLineComments(methodBody(API_SRC, sig));
        assert.ok(!/getPublic\(|anonymous: true/.test(body),
            `${sig} returns per-user data and must never become an anonymous (shared, cacheable) read`);
    }
    // Belt and braces: no /api/user, /api/cart or /api/admin path is ever fetched publicly.
    const publicCalls = API_SRC.match(/getPublic\(`?['"`]?[^)]*/g) || [];
    for (const call of publicCalls) {
        assert.ok(!/\/api\/(user|cart|admin|orders|auth)/.test(call),
            `getPublic must never be pointed at a private endpoint: ${call}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — no request-level cache defeat
// ─────────────────────────────────────────────────────────────────────────────

test('§6 GETs use cache: default; only mutations use no-store', () => {
    assert.match(API_SRC, /const cacheMode = method === 'GET' \? 'default' : 'no-store';/,
        "forcing cache:'no-store' on catalog GETs would bypass the browser cache layer that sits in front of the edge");
});

test('§6 no Cache-Control or Pragma request header is set on a catalog fetch', () => {
    const offenders = [];
    for (const file of ALL_JS) {
        const src = READ(file);
        if (!/\/api\/(shop|products|brands|site|schema)/.test(src)) continue;
        for (const line of src.split('\n')) {
            if (/['"](Cache-Control|Pragma)['"]\s*:/.test(line)) {
                offenders.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, [], 'a no-cache request header forces revalidation and throws away the edge hit');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — the two call sites outside api.js
// ─────────────────────────────────────────────────────────────────────────────

test('§7 the cart cross-sell fetch omits credentials', () => {
    // Brace-matched rather than a fixed 1400-character window. The window was
    // measured against the function as it stood in Jul 2026; adding a comment
    // above the fetch pushed `credentials: 'omit'` outside it and reddened this
    // test while the code was still correct (Sep 2026, ERR-223). A slice whose
    // length is a magic number tests the length of the function, not the claim.
    const _cs = CART_SRC.indexOf('async _showCrossSellModal(payload)');
    assert.ok(_cs > 0, 'located _showCrossSellModal');
    let _d = 0, _i = CART_SRC.indexOf('{', _cs), _end = _i;
    for (; _i < CART_SRC.length; _i++) {
        if (CART_SRC[_i] === '{') _d++;
        else if (CART_SRC[_i] === '}') { _d--; if (!_d) { _end = _i; break; } }
    }
    const fn = stripLineComments(CART_SRC.slice(_cs, _end + 1));
    assert.match(fn, /fetch\(/, 'and it really contains the cross-sell fetch');
    assert.match(fn, /credentials:\s*'omit'/,
        'the frequently-bought-together URL is a public catalog read; unconditional cookies were the one FE fetch that could bypass the edge for every visitor');
    assert.ok(!/credentials:\s*'include'/.test(fn), "must not send cookies on a cached catalog read");
});

test('§7 the PDP no longer blocks its first paint waiting for a session', () => {
    const init = stripLineComments(PDP_SRC.slice(0, PDP_SRC.indexOf('API.getProduct')));
    assert.ok(!/await Auth\.readyPromise/.test(init),
        'the PDP awaited auth only so a bearer token would ride on /api/products/:sku — which is edge-cached and does not vary its key on that token');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the documented contract stays discoverable
// ─────────────────────────────────────────────────────────────────────────────

test('§8 the measured Cloudflare behaviour is written down next to the code that depends on it', () => {
    // The whole change rests on one counter-intuitive measured fact. If the
    // comment goes, the next reader will "simplify" credentials back to being
    // inferred from the Authorization header.
    assert.match(API_SRC, /cf-cache-status: HIT/,
        'the measured evidence (a bearer token still HITs) must stay recorded in api.js');
    assert.match(API_SRC, /ERR-124/, 'the error-log reference must stay linkable');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — the gaps the first pass missed (audit, 2026-07-28)
//
// The original sweep converted the obvious catalog helpers. A follow-up audit
// found three classes it had walked past: a duplicate brands reader in the
// admin layer, ~15 public reads that were never in the original list, and bare
// fetches that were anonymous only by accident of fetch()'s default.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_API_SRC = READ(JS(path.join('admin', 'api.js')));

test('§9 nothing calls API.get() directly on an edge-cached path', () => {
    // The regression that motivated this section: AdminAPI.getBrands() called
    // window.API.get('/api/brands') itself instead of API.getBrands(), so eight
    // admin controllers sent a bearer token to an edge-cached endpoint. A
    // repo-wide scan is what stops the next one being added silently.
    const CACHED = /\bAPI\.(get|request)\(\s*[`'"]\/api\/(shop|products|brands|site|schema|settings|ribbons|printers|search|compatibility|color-packs)/;
    const offenders = [];
    for (const file of ALL_JS) {
        const rel = path.relative(ROOT, file);
        // api.js defines getPublic/get themselves; its own internals are covered by §5.
        if (rel.endsWith(path.join('js', 'api.js'))) continue;
        for (const [i, line] of stripLineComments(READ(file)).split('\n').entries()) {
            if (CACHED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [],
        'edge-cached endpoints must be reached through the anonymous helpers (API.getPublic / API.getBrands / …), never a raw authenticated API.get');
});

test('§9 AdminAPI.getBrands delegates to the anonymous, SWR-cached reader', () => {
    const body = stripLineComments(ADMIN_API_SRC.slice(
        ADMIN_API_SRC.indexOf('async getBrands()'),
        ADMIN_API_SRC.indexOf('// ---- Ribbons (admin CRUD) ----')));
    assert.ok(body.length > 0, 'AdminAPI.getBrands must still exist');
    assert.match(body, /window\.API\.getBrands\(\)/,
        'must delegate so it inherits both anonymity and the 5-minute SWR cache that eight admin controllers share');
    assert.ok(!/window\.API\.get\(/.test(body),
        'must not reach for the raw authenticated getter');
});

test('§9 every public catalog/search/ribbon read uses getPublic', () => {
    // These are all identity-invariant. They were left on the authenticated path
    // by the first sweep simply because they were not on the list.
    const publicReads = [
        'async getColorPackConfig', 'async getRibbonDeviceBrands', 'async getRibbonDeviceModels',
        'async getRibbonBrands(', 'async getRibbonModels', 'async getRibbons(', 'async getRibbon(',
        'async searchPrinters(', 'async smartSearch', 'async searchSuggest',
        'async getPrintersByBrand', 'async getCompatiblePrinters', 'async searchByPrinter',
        'async searchByPart', 'async getCompatibility',
    ];
    for (const sig of publicReads) {
        const body = stripLineComments(methodBody(API_SRC, sig));
        assert.match(body, /this\.getPublic\(/,
            `${sig} is a public read on a path Cloudflare may cache — it must not attach a bearer token`);

        // A helper MAY also reach the admin catalogue mirror (ERR-234). That is
        // the single sanctioned reason to call the authenticated getter from
        // here, and it is safe only because the mirror is a different path
        // prefix that is never edge-cached — the public URL below still goes out
        // tokenless. So the rule is no longer "never call this.get()", it is
        // "never hand this.get() a public path".
        if (/this\.get\(/.test(body)) {
            assert.match(body, /_catalogRoute\(/,
                `${sig} calls the authenticated getter, which is only allowed via _catalogRoute (ERR-234)`);
            // `[,)]` so a caller may pass options alongside — what matters is that
            // the ROUTED endpoint is the first argument, not that it is the only one.
            assert.match(body, /this\.get\([A-Za-z_$][\w$]*\.endpoint\s*[,)]/,
                `${sig} must pass the ROUTED endpoint to the authenticated getter, never an endpoint it built itself`);
            assert.ok(!/this\.get\(\s*(['"`]|\/api)/.test(body),
                `${sig} must never hand a literal path to the authenticated getter — that is the token-on-a-cached-URL bug ERR-124 fixed`);
        }
    }
});

test('§9 _catalogRoute is identity for everyone who is not a verified admin (ERR-234)', () => {
    const body = stripLineComments(methodBody(API_SRC, '_catalogRoute(endpoint)'));
    // The default has to be the endpoint it was handed, untouched. Anything else
    // and a shopper could be routed at an admin path, or an admin's row could
    // reach a cacheable URL.
    assert.match(body, /if \(!preview \|\| typeof preview\.isGranted !== 'function'\)[\s\S]{0,120}anonymous: true/,
        'no AdminPreview on the page must mean the public route');
    assert.match(body, /if \(!preview\.isGranted\(\)\) return \{ endpoint: ep, anonymous: true \};/,
        'anything short of a granted admin must mean the public route');
    assert.match(body, /if \(ep\.startsWith\('\/api\/admin\/'\)\) return \{ endpoint: ep, anonymous: false \};/,
        'routing an already-mirrored endpoint again must not downgrade it to anonymous and 401 the admin');
    // The query string must survive verbatim: a param would live inside the
    // edge-cache key family, which is exactly what the path swap avoids.
    assert.match(body, /const query = q === -1 \? '' : ep\.slice\(q\);/,
        'the query string must be carried through untouched so CATALOG_PARAM_ORDER still holds');
    assert.match(body, /mirrored \+ query/, 'the rewrite is path-only');
});

test('§9 waitlistStatus stays mounted but is never CALLED, and says why', () => {
    // GET /api/products/:sku/waitlist/status is PER-USER but sits under the
    // edge-cached /api/products/ prefix. Verified live 2026-07-28: it returns
    // `public, …, s-maxage=300` and a repeat request is `cf-cache-status: HIT`.
    // Since a bearer token does not change the cache key, calling it would let
    // one shopper's waitlist state be served to everyone.
    //
    // The wrapper is NOT deleted — tests/traffic-conversion-jul2026.test.js §3
    // requires the waitlist wrappers stay mounted so cached bundles can't 404.
    // So the invariant enforced here is "mounted, documented, and never called".
    assert.match(API_SRC, /async waitlistStatus\s*\(/,
        'the wrapper stays mounted so cached bundles do not 404 on it');
    assert.match(API_SRC, /DO NOT CALL waitlistStatus[\s\S]{0,1400}BF-020/,
        'and must carry the hazard note explaining the shared-cache leak and naming the backend ask');

    for (const file of ALL_JS) {
        const rel = path.relative(ROOT, file);
        if (rel.endsWith(path.join('js', 'api.js'))) continue; // the definition itself
        assert.ok(!/waitlistStatus\s*\(/.test(stripLineComments(READ(file))),
            `${rel} must not call waitlistStatus — it would publish one shopper's waitlist state into the shared edge cache (BF-020)`);
    }
});

test('§9 every bare fetch to the API sets credentials explicitly', () => {
    // Relying on fetch()'s `same-origin` default happens to be correct today
    // only because Config.API_URL is a different origin. That is an accident of
    // configuration, not a stated intent, and it is invisible to a reader.
    const offenders = [];
    for (const file of ALL_JS) {
        const rel = path.relative(ROOT, file);
        const lines = stripLineComments(READ(file)).split('\n');
        for (const [i, line] of lines.entries()) {
            if (!/\bfetch\(/.test(line)) continue;
            // Only calls that target the API origin.
            const window3 = lines.slice(i, i + 3).join(' ');
            if (!/(Config\.API_URL|\$\{base\}\/api\/|_apiUrl\(|BACKEND_URL)/.test(window3)) continue;
            if (!/credentials\s*:/.test(window3)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
    }
    assert.deepEqual(offenders, [],
        'state the credentials mode on every API fetch — an unstated default is how a cookie silently starts bypassing the edge cache');
});

test('§9 the admin-preview gate is LIVE and blocks non-admins (ERR-234)', () => {
    // This test used to assert the gate was DORMANT and carried a note saying so.
    // The property it was defending — "deleting this would ship unlisted products
    // to shoppers the moment admin preview returns" — is unchanged and is now
    // asserted directly instead of via the comment. Admin preview HAS returned,
    // through the uncached /api/admin/catalog/* mirror, so keeping the old
    // dormancy note would have meant leaving a false comment in the file to keep
    // a test green. That is the ERR-216 failure mode, not a passing test.
    assert.match(PDP_SRC, /_isTestProduct\(this\.product\)/,
        'the test-product gate must remain in place');
    assert.match(PDP_SRC, /_isTestProduct\(this\.product\)[\s\S]{0,160}AdminPreview\.isGranted\(\)/,
        'the gate must consult AdminPreview — otherwise it is unreachable again');

    // `!this.product.active` is deliberately GONE. Requiring an admin-only
    // product to ALSO be inactive would have exposed the live test product,
    // which must be active to be purchasable.
    assert.ok(!/_isTestProduct\(this\.product\)\s*&&\s*!this\.product\.active/.test(PDP_SRC),
        'admin-only must be sufficient on its own to hide a product from a non-admin');

    // MUTATION CONTROL. Flipping the negation must break this test and only this
    // test — a gate that reads `isGranted()` without the `!` hides the product
    // from the admin and shows it to everyone else.
    const mutated = PDP_SRC.replace(
        /&&\s*!\(typeof AdminPreview !== 'undefined' && AdminPreview\.isGranted\(\)\)/,
        "&& (typeof AdminPreview !== 'undefined' && AdminPreview.isGranted())");
    assert.notEqual(mutated, PDP_SRC, 'the mutation must actually apply — otherwise this control proves nothing');
    assert.ok(!/&&\s*!\(typeof AdminPreview[\s\S]{0,60}isGranted\(\)\)/.test(mutated),
        'and it must remove the negation the gate depends on');
});

test('§9 _isTestProduct treats an ABSENT admin_only as not-admin-only (ERR-234)', () => {
    const body = stripLineComments(methodBody(PDP_SRC, '_isTestProduct(product)'));
    assert.match(body, /product\.admin_only === true/,
        'strict === true: absent and null are not false, and a truthy check would catch strings');
    assert.match(body, /startsWith\('TEST-'\)/,
        'the SKU prefix stays as the fallback for rows written before the column existed');
});
