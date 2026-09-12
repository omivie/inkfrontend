/**
 * The admin-only test product
 * ===========================
 * ERR-234 · Sep 2026
 *
 * A product only an admin can see, priced at Stripe's NZD floor, used to
 * exercise the real buying pipeline. The enforcement that matters is the
 * BACKEND's — public catalogue endpoints never return the row, so the shared
 * Cloudflare entry can never hold one. This file guards the frontend half.
 *
 * ── THE ONE TEST IN THIS FILE THAT MATTERS MOST ────────────────────────────
 *
 * `_catalogRoute` must be the IDENTITY function for everyone who is not a
 * verified admin. It is executed here, not grepped, against every non-granted
 * state — because a router that quietly rewrote a shopper's URL would either
 * 401 them or, far worse, put an admin path into a shared cache. "A test that
 * greps for a name proves a name" (ERR-233 addendum).
 *
 * ── AND THE ONE THAT IS EASIEST TO GET WRONG ───────────────────────────────
 *
 * The mirror table is EXACT-MATCH, not a prefix rewrite. `/api/products` is
 * mirrored; `/api/products/:sku/related` and `/api/products/printer/:slug` are
 * not, because the backend does not mirror them. A blanket prefix rule would
 * send an admin to a route nobody implemented and 404 a page that worked —
 * silence on an unimplemented route is how ERR-166 ran for months.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const API_SRC = read('inkcartridges/js/api.js');
const UTILS_SRC = read('inkcartridges/js/utils.js');
const PDP_SRC = read('inkcartridges/js/product-detail-page.js');
const CHECKOUT_SRC = read('inkcartridges/js/checkout-page.js');
const PAYMENT_SRC = read('inkcartridges/js/payment-page.js');
const SEARCH_SRC = read('inkcartridges/js/search.js');
const AUTH_SRC = read('inkcartridges/js/auth.js');
const SHOP_SRC = read('inkcartridges/js/shop-page.js');
const ADMIN_PRODUCTS_SRC = read('inkcartridges/js/admin/pages/products.js');
const CART_SRC = read('inkcartridges/js/cart.js');
const PROBE_SRC = read('scripts/probe-admin-only-product.mjs');
const PKG = JSON.parse(read('package.json'));

const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Lift an object-literal method out of api.js and run it for real. */
function liftMethod(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist in the shipped source`);
  // Brace-match from the body's `{`, NOT the first `{` after the name — a
  // default parameter like `getProducts(filters = {})` closes immediately and
  // would yield an empty body that passes nothing and fails everything.
  let p = src.indexOf('(', start), pd = 0, i = p;
  for (; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (!pd) break; }
  }
  let depth = 0, end = i;
  for (i = src.indexOf('{', i); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return src.slice(start, end + 1);
}

/**
 * Build a minimal API stand-in carrying the two real routing methods, so the
 * shipped code runs rather than being pattern-matched.
 */
function makeRouter(adminPreview) {
  const sandbox = { window: adminPreview === undefined ? {} : { AdminPreview: adminPreview } };
  vm.createContext(sandbox);
  const src = `globalThis.API = { ${liftMethod(API_SRC, '_mirrorCatalogPath(path)')}, ${liftMethod(API_SRC, '_catalogRoute(endpoint)')} };`;
  vm.runInContext(src, sandbox);
  return sandbox.API;
}

const GRANTED = { isGranted: () => true, ensure() {} };
const NOT_GRANTED = (state) => ({ isGranted: () => false, ensure() {}, state });

// ─────────────────────────────────────────────────────────────────────────────
// §1 — identity for everyone who is not a verified admin
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_URLS = [
  '/api/shop',
  '/api/shop?brand=canon&category=ink&page=1&limit=24',
  '/api/products',
  '/api/products?brand=hp&source=compatible&limit=200',
  '/api/products/TEST-ADMIN-001',
  '/api/products/GS0720560BK?printer_slug=hp-officejet-pro-9720',
  '/api/search/smart?q=tn2130&limit=40',
  '/api/search/suggest?q=tn21&limit=10',
];

test('§1 no AdminPreview on the page at all → every URL is returned untouched', () => {
  const API = makeRouter(undefined);
  for (const url of PUBLIC_URLS) {
    const r = API._catalogRoute(url);
    assert.equal(r.endpoint, url, `${url} must be byte-identical`);
    assert.equal(r.anonymous, true, `${url} must stay anonymous`);
  }
});

test('§1 every non-granted state routes publicly — this is the security default', () => {
  for (const state of ['unknown', 'anonymous', 'refused', 'unreachable', 'unsupported']) {
    const API = makeRouter(NOT_GRANTED(state));
    for (const url of PUBLIC_URLS) {
      const r = API._catalogRoute(url);
      assert.equal(r.endpoint, url, `${state}: ${url} must be byte-identical`);
      assert.equal(r.anonymous, true, `${state}: ${url} must stay anonymous`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the rewrite swaps the PATH and never the query
// ─────────────────────────────────────────────────────────────────────────────

test('§2 a granted admin is routed to the mirror, path-only, query verbatim', () => {
  const API = makeRouter(GRANTED);
  const cases = [
    ['/api/shop', '/api/admin/catalog/shop'],
    ['/api/shop?brand=canon&category=ink', '/api/admin/catalog/shop?brand=canon&category=ink'],
    ['/api/products', '/api/admin/catalog/products'],
    ['/api/products?brand=hp&limit=200', '/api/admin/catalog/products?brand=hp&limit=200'],
    ['/api/products/TEST-ADMIN-001', '/api/admin/catalog/products/TEST-ADMIN-001'],
    ['/api/search/smart?q=tn2130&limit=40', '/api/admin/catalog/search/smart?q=tn2130&limit=40'],
    ['/api/search/suggest?q=tn21', '/api/admin/catalog/search/suggest?q=tn21'],
  ];
  for (const [input, expected] of cases) {
    const r = API._catalogRoute(input);
    assert.equal(r.endpoint, expected, input);
    assert.equal(r.anonymous, false, `${input} must carry a token on the mirror`);
    // The query survives character for character. A rewrite that reordered or
    // re-encoded params would shatter CATALOG_PARAM_ORDER's canonical form.
    const q = input.indexOf('?');
    if (q !== -1) assert.ok(r.endpoint.endsWith(input.slice(q)), `${input}: query must be verbatim`);
  }
});

test('§2 no admin= param is ever added — a param lives INSIDE the cache key', () => {
  const API = makeRouter(GRANTED);
  for (const url of PUBLIC_URLS) {
    const r = API._catalogRoute(url);
    assert.ok(!/[?&]admin=/.test(r.endpoint), `${url} must not gain an admin param`);
    assert.ok(!/[?&]preview=/.test(r.endpoint), `${url} must not gain a preview param`);
  }
});

test('§2 the mirror table is EXACT-MATCH — unmirrored routes stay public', () => {
  const API = makeRouter(GRANTED);
  // The backend mirrors five routes. Everything else must be left alone, or an
  // admin is sent to a path nobody implemented.
  const notMirrored = [
    '/api/products/TEST-ADMIN-001/related',
    '/api/products/TEST-ADMIN-001/bought-together',
    '/api/products/printer/hp-officejet-pro-9720',
    '/api/products/by-slug/some-slug',
    '/api/search/by-printer?q=x',
    '/api/brands',
    '/api/ribbons',
  ];
  for (const url of notMirrored) {
    const r = API._catalogRoute(url);
    assert.equal(r.endpoint, url, `${url} is not mirrored and must be left alone`);
    assert.equal(r.anonymous, true, `${url} must stay anonymous`);
  }
});

test('§2 routing is idempotent — an /api/admin/ path never downgrades to anonymous', () => {
  // getPublic → _catalogRoute can run over an endpoint a caller already routed.
  // If the second pass returned anonymous:true the token would be stripped and
  // the admin would get a 401 on every catalogue read.
  for (const preview of [undefined, NOT_GRANTED('refused'), GRANTED]) {
    const API = makeRouter(preview);
    const r = API._catalogRoute('/api/admin/catalog/shop?brand=hp');
    assert.equal(r.endpoint, '/api/admin/catalog/shop?brand=hp');
    assert.equal(r.anonymous, false, 'an admin path always needs a token');
  }
});

test('§2 a null/undefined endpoint does not throw', () => {
  const API = makeRouter(GRANTED);
  for (const bad of [null, undefined, '']) {
    const r = API._catalogRoute(bad);
    assert.equal(r.anonymous, true);
    assert.equal(r.endpoint, '');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — enrolment lives in a test, not in a list somebody maintains
// ─────────────────────────────────────────────────────────────────────────────

test('§3 every catalogue transport routes through _catalogRoute (ERR-150/160)', () => {
  // "Every surface calls X" is a list nobody maintains — that feature vanished
  // twice. These are the transports an admin-only row has to arrive through.
  const enrolled = [
    ['async getProducts', API_SRC],
    ['async getShopData', API_SRC],
    ['async smartSearch', API_SRC],
    ['async searchSuggest', API_SRC],
    ['async _rawJsonFetch', API_SRC],
  ];
  for (const [sig, src] of enrolled) {
    const body = codeOnly(liftMethod(src, sig));
    assert.match(body, /_catalogRoute\(/, `${sig} must consult _catalogRoute`);
  }
  // The header dropdown builds its own URL and never enters API.request.
  assert.match(codeOnly(SEARCH_SRC), /API\._catalogRoute\(/,
    'search.js fetchSmart is the highest-volume search surface and must route itself');
});

test('§3 the PDP and the shop grid repaint when admin preview arrives', () => {
  // Admin preview resolves over the network and is never awaited before first
  // paint, so an admin's FIRST render is the public one. Without a repaint the
  // owner sees "Product not found" forever.
  assert.match(codeOnly(PDP_SRC), /admin-preview:ready/,
    'the PDP must retry once admin preview turns on');
  assert.match(codeOnly(SHOP_SRC), /admin-preview:ready/,
    'the shop grid must repaint once admin preview turns on');
  // ...and must not yank a page out from under a reader who already has one.
  assert.match(codeOnly(PDP_SRC), /if \(this\.product \|\| this\._adminRetried\) return;/,
    'a PDP that already rendered must not be reloaded');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — AdminPreview's five states, and the loud one
// ─────────────────────────────────────────────────────────────────────────────

test('§4 an absent mirror is "unsupported", never "there are none"', () => {
  const body = codeOnly(liftMethod(UTILS_SRC, 'async _run()'));
  // MEASURED: API.request() returns { ok:false, code:'NOT_FOUND' } on a 404 and
  // carries NO status field. A check on probe.status === 404 would never fire.
  assert.match(body, /probe\.code === 'NOT_FOUND'/,
    "the 404 test must use `code`, because api.js does not put `status` on a 404 envelope");
  assert.ok(!/probe\.status === 404/.test(body),
    'probe.status is absent on a 404 — testing it is the ERR-199 absent-vs-null trap');
  assert.match(body, /_set\('unsupported'/, 'an absent mirror gets its own named state');
});

test('§4 unreachable is never rendered as a refusal, and retries exactly once (ERR-188)', () => {
  const body = codeOnly(liftMethod(UTILS_SRC, 'async _run()'));
  assert.match(body, /if \(!this\._retried\)/, 'exactly one retry, not a storm');
  assert.match(body, /_set\('unreachable'/, 'and it stays a distinct state');
  const explain = codeOnly(liftMethod(UTILS_SRC, 'explain()'));
  assert.match(explain, /This is not a refusal/,
    'the unreachable copy must say plainly that it is not a refusal');
  assert.match(explain, /NOT "there are none"/,
    'the unsupported copy must refuse the absence-as-zero reading out loud');
});

test('§4 no session means no request at all', () => {
  const body = codeOnly(liftMethod(UTILS_SRC, 'async _run()'));
  assert.match(body, /Auth\.isAuthenticated\(\)/, 'signed-out is decided locally');
  assert.match(body, /if \(!signedIn\) return this\._set\('anonymous'\);/,
    'an anonymous shopper must cost zero extra requests');
});

test('§4 verifyAdmin is wrapped — API.request() THROWS on network failure (ERR-216)', () => {
  const body = codeOnly(liftMethod(UTILS_SRC, 'async _run()'));
  assert.match(body, /try \{ resp = await API\.verifyAdmin\(\); \} catch/,
    'an unguarded verify would take every catalogue read down with it');
});

test('§4 the admin role is NOT cached client-side — the stub stays false', () => {
  // sessionStorage is user-controlled. Reviving this would hand any visitor the
  // admin view by editing one key.
  const stub = codeOnly(liftMethod(UTILS_SRC, 'function isCachedSuperAdmin()'));
  assert.match(stub, /return false;/, 'isCachedSuperAdmin must remain a hard false');
  assert.ok(!/AdminPreview/.test(stub), 'and must not be quietly rewired to AdminPreview');
});

test('§4 the state machine EXECUTES correctly for all six real outcomes', async () => {
  // The strongest test in this file: the shipped AdminPreview is run, not read.
  // Every assertion above this one is about the text of the module; this one is
  // about what it does. ERR-224 shipped 21 green source-grep tests over a layout
  // that was wrong on screen.
  function liftConst(name) {
    const start = UTILS_SRC.indexOf(`const ${name} = {`);
    assert.ok(start >= 0, `${name} must exist`);
    let d = 0, i = UTILS_SRC.indexOf('{', start), end = i;
    for (; i < UTILS_SRC.length; i++) {
      if (UTILS_SRC[i] === '{') d++;
      else if (UTILS_SRC[i] === '}') { d--; if (!d) { end = i; break; } }
    }
    return UTILS_SRC.slice(start, end + 1) + ';';
  }

  async function run({ signedIn, verify, verifyThrows, probe, probeThrows }) {
    const events = [];
    const sandbox = {
      setTimeout, console,
      // CustomEvent is a GLOBAL in a browser. Putting it only on the fake
      // `window` made every dispatch throw into _set's catch and report zero
      // events while still passing — a green run that proved nothing.
      CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
      window: { dispatchEvent: (e) => events.push(e.type) },
      document: {
        getElementById: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, remove() {} }),
        body: { appendChild() {} },
      },
      DebugLog: { error() {}, warn() {} },
      Auth: { isAuthenticated: () => signedIn },
      API: {
        verifyAdmin: async () => { if (verifyThrows) throw new Error('network'); return verify; },
        get: async () => { if (probeThrows) throw new Error('network'); return probe; },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(liftConst('AdminAccess') + liftConst('AdminPreview')
      + 'globalThis.AdminPreview = AdminPreview;', sandbox);
    sandbox.AdminPreview.ensure();
    await new Promise(r => setTimeout(r, 30));
    return { state: sandbox.AdminPreview.state, granted: sandbox.AdminPreview.isGranted(), events };
  }

  const ADMIN = { ok: true, data: { role: 'super_admin', roles: ['super_admin'] } };
  const NOT_FOUND = { ok: false, code: 'NOT_FOUND', error: 'Endpoint not found' };

  const cases = [
    ['signed out',              { signedIn: false },                                    'anonymous'],
    ['admin, mirror present',   { signedIn: true, verify: ADMIN, probe: { ok: true } },  'granted'],
    ['admin, mirror ABSENT',    { signedIn: true, verify: ADMIN, probe: NOT_FOUND },     'unsupported'],
    ['admin, probe threw',      { signedIn: true, verify: ADMIN, probeThrows: true },    'unreachable'],
    ['signed-in non-admin',     { signedIn: true, verify: { ok: true, data: {} } },      'refused'],
    ['verify threw',            { signedIn: true, verifyThrows: true },                  'unreachable'],
  ];

  for (const [label, input, expected] of cases) {
    const out = await run(input);
    assert.equal(out.state, expected, `${label}: expected ${expected}, got ${out.state}`);
    // isGranted() is the ONLY question the router asks. Exactly one state may
    // answer yes — anything else routes a shopper at an admin path.
    assert.equal(out.granted, expected === 'granted', `${label}: isGranted() must be ${expected === 'granted'}`);
    // Every outcome must announce itself, so nothing fails silently.
    assert.ok(out.events.includes('admin-preview:change'), `${label}: must dispatch admin-preview:change`);
    // ...and only a real grant may trigger the repaint the PDP and grid listen for.
    assert.equal(out.events.includes('admin-preview:ready'), expected === 'granted',
      `${label}: admin-preview:ready must fire if and only if access was granted`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — the frontend stops pricing test carts
// ─────────────────────────────────────────────────────────────────────────────

test('§5 a test cart no longer gets free shipping in the browser', () => {
  const fn = codeOnly(liftMethod(CHECKOUT_SRC, 'async fetchShippingFromAPI()'));
  assert.ok(!/tier: 'test-free'/.test(fn),
    'the frontend must not zero-rate shipping the backend will then charge for');
  assert.ok(!/_isTestProductCart\(\)\) \{[\s\S]{0,120}this\.totals\.shipping = 0/.test(fn),
    'the displayed total must equal the charged total');
});

test('§5 _isTestProductCart no longer keys off an operator-editable product NAME', () => {
  const fn = codeOnly(liftMethod(CHECKOUT_SRC, '_isTestProductCart()'));
  assert.ok(!/admin test/.test(fn),
    'a real product called "…Admin Test Page Yield…" must not price itself differently');
  assert.match(fn, /item\.admin_only === true/, 'admin_only is the authoritative signal');
  assert.match(fn, /startsWith\('TEST-'\)/, 'the SKU prefix stays as the fallback');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Stripe's NZD floor
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the floor is 50 NZD cents and is refused visibly, not by Stripe after authorisation', () => {
  assert.match(PAYMENT_SRC, /STRIPE_MIN_NZD_CENTS = 50/,
    "Stripe's published NZD minimum is 0.50 (docs.stripe.com/currencies)");
  const init = codeOnly(PAYMENT_SRC);
  assert.match(init, /totalCents < STRIPE_MIN_NZD_CENTS/,
    'a sub-minimum total must be caught before the card form is mounted');
  assert.match(init, /Math\.round\(this\.totals\.total \* 100\) >= STRIPE_MIN_NZD_CENTS/,
    'the wallet button must use the floor, not > 0 — a $0.20 total fails at confirm');
});

test('§6 the $1 fallback is still there for an UNLOADED total, and only that', () => {
  // `|| 100` is correct when server totals have not arrived. It is a lie when
  // the total is genuinely 0. Both must remain distinguishable.
  assert.match(PAYMENT_SRC, /Math\.round\(this\.totals\.total \* 100\) \|\| 100/,
    'the unloaded-total fallback stays');
  assert.match(PAYMENT_SRC, /this\.totals\.total > 0 && totalCents < STRIPE_MIN_NZD_CENTS/,
    'and the guard only fires on a total that is actually present');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — identity changes must not leave admin rows in the cache
// ─────────────────────────────────────────────────────────────────────────────

test('§7 signing in or out purges the catalogue cache and re-arms admin preview', () => {
  const fn = codeOnly(liftMethod(API_SRC, 'purgeCatalogCache()'));
  assert.match(fn, /this\._swrCache\.clear\(\)/, 'a 60s TTL outlives a sign-out');
  assert.match(fn, /this\._swrInflight\.clear\(\)/, 'including a revalidation already in flight');
  assert.match(fn, /preview\.state = 'unknown'/, 'the next read must re-decide who is looking');
  assert.match(codeOnly(AUTH_SRC), /API\.purgeCatalogCache\(\)/,
    'and the auth state change must actually call it');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the admin form, and what it must NOT do yet
// ─────────────────────────────────────────────────────────────────────────────

test('§8 admin_only is owner-gated and sent only when deliberately ticked', () => {
  const src = codeOnly(ADMIN_PRODUCTS_SRC);
  assert.match(src, /if \(isOwner && chk\('edit-admin-only'\)\) data\.admin_only = true;/,
    'create must not put a new key on every product the day this ships');
  assert.match(src, /hasOwnProperty\.call\(product \|\| \{\}, 'admin_only'\)/,
    'edit may only send it both ways once the record actually carries the key');
});

test('§8 admin_only is NOT yet added to any PostgREST select', () => {
  // MEASURED: PostgREST answers 400 / 42703 for an unknown column, not an empty
  // set. Adding it before the backend migration would take down the admin
  // Products list outright — the ERR-193 shape, where a failed read printed
  // empty-shelf copy on 63 brand pages for 44 hours.
  const selects = ADMIN_PRODUCTS_SRC.match(/const selectCols = '[^']*'/g) || [];
  assert.ok(selects.length > 0, 'located the products select');
  for (const sel of selects) {
    assert.ok(!/admin_only/.test(sel),
      'admin_only must not enter a PostgREST select until the column exists');
  }
});

test('§8 the retail-price > 0 guard is untouched — $0.50 passes it already', () => {
  assert.match(ADMIN_PRODUCTS_SRC, /if \(!retailPrice \|\| retailPrice <= 0\)/,
    'the guard protects real products and the test product does not need it relaxed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — the probe exists and is runnable
// ─────────────────────────────────────────────────────────────────────────────

test('§9 the probe is registered in package.json — one nobody can run does not exist', () => {
  assert.equal(PKG.scripts['probe:admin-only'], 'node scripts/probe-admin-only-product.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/probe-admin-only-product.mjs')),
    'and the file it names must be there');
});

test('§9 the probe lives at the repo root, not under the published web root (ERR-229)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'inkcartridges/scripts/probe-admin-only-product.mjs')),
    'inkcartridges/ is served publicly — a probe that reads .env must never live there');
});


// ─────────────────────────────────────────────────────────────────────────────
// §10 — the refusal contract (ERR-246)
//
// The backend's handoff (admin-only-test-product-FE-handoff-sep2026.md §4)
// commits to 403 ADMIN_ONLY_PRODUCT and 400 MIXED_TEST_CART on POST
// /api/cart/items, POST /api/cart/validate and POST /api/orders.
//
// WHY THE 400 IS THE DANGEROUS ONE. api.js returns an {ok:false} envelope for a
// whitelist of codes and THROWS for every other 400. cart.js:addItem catches a
// throw in its TRANSPORT-failure arm, which keeps the item, saves it, and tells
// the shopper "Item saved locally. It will sync when connection is restored."
// It would never sync — the server was not down, it was saying no. That is
// ERR-139 (B2B_COUPON_EXCLUDED) arriving a second time through the same door.
//
// So these tests EXECUTE api.js's real error mapping rather than grepping for a
// code literal, and they carry both controls the house rules ask for: a negative
// control proving the whitelist was not simply opened, and a mutation control
// proving the new branch is the thing doing the work.
// ─────────────────────────────────────────────────────────────────────────────

/** Load the real api.js in a vm whose fetch answers one canned response. */
function loadApiWithResponse(status, body, src) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => body,
    }),
    DebugLog: { log() {}, warn() {}, error() {} },
    Config: { API_URL: 'http://x', SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k', settings: {} },
    Auth: { isAuthenticated: () => false, getSession: async () => null },
    location: { hostname: 'localhost', href: 'http://localhost/', search: '' },
    navigator: { onLine: true, userAgent: 'node' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { cookie: '', addEventListener() {}, querySelector: () => null },
    setTimeout, clearTimeout, AbortController, URLSearchParams, TextEncoder,
    performance: { now: () => 0 },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src || API_SRC, sandbox, { filename: 'api.js' });
  assert.equal(typeof sandbox.API, 'object', 'api.js must evaluate to an API object');
  return sandbox.API;
}

test('§10 both refusal codes come back as an envelope and are NEVER thrown', async () => {
  for (const [status, code] of [[403, 'ADMIN_ONLY_PRODUCT'], [400, 'MIXED_TEST_CART']]) {
    const API = loadApiWithResponse(status, { ok: false, error: { code, message: 'Refused.' } });
    let res, threw = null;
    try { res = await API.post('/api/cart/items', {}); } catch (e) { threw = e; }
    assert.equal(threw, null, `${status} ${code} must not throw — a throw lands in the transport-failure arm`);
    assert.equal(res.ok, false);
    assert.equal(res.code, code, 'the backend’s own code must survive, not be flattened to FORBIDDEN');
    assert.equal(res.error, 'Refused.', 'and its message, because the server knows who is asking and we do not');
  }
});

test('§10 NEGATIVE CONTROL — an unrelated plain 400 still throws', async () => {
  // Without this, a change that simply stopped throwing for every 400 would make
  // the test above pass while quietly turning fourteen callers' error handling
  // inside out. The whitelist has to stay a whitelist.
  const API = loadApiWithResponse(400, { ok: false, error: { code: 'SOMETHING_ELSE', message: 'Nope.' } });
  await assert.rejects(() => API.post('/api/cart/items', {}), /Nope\./);
});

test('§10 MUTATION CONTROL — delete the branch and MIXED_TEST_CART throws again', async () => {
  // Proves the branch is load-bearing rather than decorative, and pins the exact
  // failure it prevents. If this test ever passes with the branch present, the
  // envelope is coming from somewhere else and §10's first test is a coincidence.
  const mutated = API_SRC.replace(
    /if \(errorCode === 'ADMIN_ONLY_PRODUCT' \|\| errorCode === 'MIXED_TEST_CART'\) \{[\s\S]*?\n                \}\n/,
    ''
  );
  assert.notEqual(mutated, API_SRC, 'the mutation must actually remove something');
  const API = loadApiWithResponse(400, { ok: false, error: { code: 'MIXED_TEST_CART', message: 'On its own.' } });
  const MUT = loadApiWithResponse(400, { ok: false, error: { code: 'MIXED_TEST_CART', message: 'On its own.' } }, mutated);
  const kept = await API.post('/api/cart/items', {});
  assert.equal(kept.code, 'MIXED_TEST_CART');
  await assert.rejects(() => MUT.post('/api/cart/items', {}),
    'without the branch a plain-400 refusal throws, which is the bug this shipped to fix');
});

test('§10 the codes are matched on the CODE, never on the status', () => {
  // The handoff puts ADMIN_ONLY_PRODUCT at 403 and MIXED_TEST_CART at 400. The
  // 403 branch below would carry the former by accident of its status; keying to
  // the code means a backend that swaps the two cannot reopen the throwing path.
  const code = codeOnly(API_SRC);
  assert.match(code, /errorCode === 'ADMIN_ONLY_PRODUCT' \|\| errorCode === 'MIXED_TEST_CART'/,
    'one branch, both codes, read off errorCode');
  assert.doesNotMatch(code, /response\.status === 403 && errorCode === 'ADMIN_ONLY_PRODUCT'/,
    'never gate a refusal code on a status number we do not own');
});

test('§10 AdminOnlyRefusal is ONE vocabulary, exported, and reachable off window (ERR-167)', () => {
  // ERR-167: utils.js declares bare `const`s, so half the guards in this repo
  // read `window.X?.y` against a name that was never on window and silently took
  // the fallback branch forever. Check the assignment line exists, not just the
  // const.
  assert.match(UTILS_SRC, /if \(typeof window !== 'undefined'\) window\.AdminOnlyRefusal = AdminOnlyRefusal;/,
    'the window assignment is what makes every typeof guard in cart/checkout/payment real');

  const { AdminOnlyRefusal } = require(path.join(ROOT, 'inkcartridges/js/utils.js'));
  assert.ok(AdminOnlyRefusal, 'and it must be on module.exports so this test can run it');

  assert.deepEqual(AdminOnlyRefusal.CODES, ['ADMIN_ONLY_PRODUCT', 'MIXED_TEST_CART']);
  assert.equal(AdminOnlyRefusal.is({ code: 'ADMIN_ONLY_PRODUCT' }), true);
  assert.equal(AdminOnlyRefusal.is({ code: 'MIXED_TEST_CART' }), true);
  assert.equal(AdminOnlyRefusal.is({ code: 'FORBIDDEN' }), false, 'a generic 403 is not this rule');
  assert.equal(AdminOnlyRefusal.is(null), false);
  assert.equal(AdminOnlyRefusal.is('MIXED_TEST_CART'), false, 'a bare string is not an envelope');

  const err = Object.assign(new Error('thrown'), { code: 'MIXED_TEST_CART' });
  assert.equal(AdminOnlyRefusal.is(err), true, 'a thrown Error carrying .code is the second shape');

  assert.equal(AdminOnlyRefusal.isMixed({ code: 'MIXED_TEST_CART' }), true);
  assert.equal(AdminOnlyRefusal.isMixed({ code: 'ADMIN_ONLY_PRODUCT' }), false,
    'the two rules have different remedies and must not share copy');

  // The server's wording wins; ours is the neutral fallback.
  assert.equal(AdminOnlyRefusal.text({ code: 'ADMIN_ONLY_PRODUCT', error: 'Admins only.' }), 'Admins only.');
  assert.match(AdminOnlyRefusal.text({ code: 'MIXED_TEST_CART' }), /on its own/i);
  assert.match(AdminOnlyRefusal.text({ code: 'ADMIN_ONLY_PRODUCT' }), /available to buy/i);
  assert.doesNotMatch(AdminOnlyRefusal.text({ code: 'ADMIN_ONLY_PRODUCT' }), /admin/i,
    'the fallback must not confirm to a stranger that a hidden product exists');
});

test('§10 the cart’s refusal branch runs BEFORE the "saved locally" arm can see it', () => {
  // Index ordering rather than presence: both strings exist in addItem() and the
  // whole defect was which one a refusal reached.
  const code = codeOnly(CART_SRC);
  const refusal = code.indexOf('AdminOnlyRefusal.is(response)');
  const local = code.indexOf('Item saved locally');
  assert.ok(refusal > 0, 'addItem must consult AdminOnlyRefusal on the server-rejected path');
  assert.ok(local > 0, 'and the transport-failure copy must still be there for real outages');
  assert.ok(refusal < local,
    'the refusal is handled on the !response.ok path, which returns before the catch arm exists');
});

test('§10 validateCart returns a terminal `blocked` instead of throwing', () => {
  // EXECUTED. A refusal thrown here is caught by bindCheckoutButton's
  // proceed-anyway arm, which walks the shopper to a checkout that cannot
  // complete and fails them after they have typed a card in.
  const body = liftMethod(CART_SRC, 'async validateCart(acknowledgePriceChanges)');
  const { AdminOnlyRefusal } = require(path.join(ROOT, 'inkcartridges/js/utils.js'));

  const run = async (response) => {
    const sandbox = {
      AdminOnlyRefusal,
      DebugLog: { log() {}, warn() {}, error() {} },
      Auth: { getTurnstileToken: async () => null },
      API: {
        validateCart: async () => response,
        extractErrorMessage: (r, fb) => (r && r.error) || fb,
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(`globalThis.Cart = { validationState: 'unknown', validationErrors: [], ${body} };`, sandbox);
    return sandbox.Cart;
  };

  return (async () => {
    for (const code of ['ADMIN_ONLY_PRODUCT', 'MIXED_TEST_CART']) {
      const Cart = await run({ ok: false, code, error: 'Refused.' });
      const out = await Cart.validateCart();
      assert.equal(out.valid, false);
      assert.equal(out.blocked, true, `${code} must be terminal, not retried`);
      // Compared element-wise, not deepEqual: the array is built inside the vm
      // realm, so its prototype is a different Array and a strict deep compare
      // fails on two lists that are identical.
      assert.equal(out.errors.length, 1);
      assert.equal(out.errors[0], 'Refused.', 'and it carries the server’s own sentence');
      assert.equal(Cart.validationState, 'blocked');
    }

    // NEGATIVE CONTROL: a genuine infrastructure failure must still throw, or the
    // proceed-anyway arm stops working and a flaky validate call strands shoppers.
    const Cart = await run({ ok: false, code: 'RATE_LIMITED', error: 'Slow down.' });
    await assert.rejects(() => Cart.validateCart(), /Slow down\./,
      'an outage is not a refusal and must keep reaching the catch that lets them through');
  })();
});

test('§10 bindCheckoutButton stops on `blocked` before the advisory warnings', () => {
  const code = codeOnly(CART_SRC);
  const blocked = code.indexOf('if (result.blocked)');
  const advisory = code.indexOf('result.errors && result.errors.length > 0');
  const navigate = code.indexOf("window.location.href = '/checkout'");
  assert.ok(blocked > 0, 'the handler must read the terminal state');
  assert.ok(blocked < advisory, 'a refusal is not a stock warning and must not be toasted as advisory');
  assert.ok(blocked < navigate, 'and it must be decided before the navigation line is reached');
});

test('§10 both order-creation paths refuse terminally', () => {
  const code = codeOnly(PAYMENT_SRC);
  const hits = code.match(/AdminOnlyRefusal\.is\(/g) || [];
  assert.ok(hits.length >= 2,
    'Stripe and PayPal create orders on separate code paths — ERR-225 is what one-path-only costs');
  assert.match(code, /AdminOnlyRefusal\.is\(orderResponse\)/, 'the Stripe path');
  assert.match(code, /AdminOnlyRefusal\.is\(response\)/, 'the PayPal path');
});

test('§10 the discount hint is LABELLING — it assigns to no total', () => {
  // ERR-234 deleted a browser-side rule that zero-rated shipping on a test cart
  // while the backend re-priced the same cart, so the total shown was not the
  // total charged. This replacement must never be able to do that again.
  const code = codeOnly(CHECKOUT_SRC);
  const start = code.indexOf('noteTestCartDiscounts(couponInput, couponBtn)');
  assert.ok(start > 0, '_isTestProductCart must finally have a caller');
  const end = code.indexOf('setupCouponHandler()', start);
  const fn = code.slice(start, end);
  assert.doesNotMatch(fn, /this\.totals/, 'a labelling function must not touch totals');
  assert.doesNotMatch(fn, /shipping\s*=/, 'and must not price shipping — that is the ERR-234 rule');
  assert.match(fn, /AdminOnlyRefusal\.DISCOUNT_HINT/, 'one hint, from the one vocabulary');

  // Loyalty is folded into canRedeem rather than disabled once on setup, because
  // render() re-runs on every cart refresh and would hand the buttons back.
  assert.match(code, /const canRedeem = maxPts > 0 && !couponApplied && !testCart;/,
    'the points controls must honour the same rule, inside render()');
});

test('§10 _isTestProductCart still reads the flag and the SKU, never a product NAME', () => {
  // Re-asserted here because §10 gave it a caller: a rule keyed on
  // operator-editable text is what ERR-234 removed, and it now has consequences
  // for what the shopper is shown rather than only for a dead function.
  const { AdminOnlyRefusal } = require(path.join(ROOT, 'inkcartridges/js/utils.js'));
  assert.ok(AdminOnlyRefusal, 'sanity: the vocabulary loads');

  const body = liftMethod(CHECKOUT_SRC, '_isTestProductCart()');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`globalThis.make = (items) => ({ cartItems: items, ${body} });`, sandbox);
  const isTest = (items) => sandbox.make(items)._isTestProductCart();

  assert.equal(isTest([]), false, 'an empty cart is not a test cart');
  assert.equal(isTest([{ sku: 'TEST-ADMIN-001' }]), true);
  assert.equal(isTest([{ sku: 'test-admin-001' }]), true, 'case-insensitive on the prefix');
  assert.equal(isTest([{ admin_only: true, sku: 'C02BK' }]), true, 'the flag is authoritative');
  assert.equal(isTest([{ sku: 'TEST-ADMIN-001' }, { sku: 'C02BK' }]), false, 'a mixed cart is not an all-test cart');
  assert.equal(isTest([{ name: 'HP 02 Admin Test Page Yield Black' }]), false,
    'a real product whose NAME contains "admin test" must never be priced differently');
  assert.equal(isTest([{ admin_only: false, sku: 'C02BK' }]), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 — the probe measures the edge, and does it where the hazard lives
//
// MEASURED BY HAND 2026-09-10 on api.inkcartridges.co.nz: warm a catalogue URL
// anonymously, then repeat it carrying an admin bearer — cf-cache-status: HIT,
// serving `public, s-maxage=300`. The same authed request against the Render
// origin answers `private, no-store`. The origin's guard is real and is never
// consulted, which is why _catalogRoute swaps the PATH rather than trusting a
// header, and why §0b of the probe exists.
// ─────────────────────────────────────────────────────────────────────────────

test('§11 the probe measures the CDN host, not whatever API_BASE happens to be', () => {
  // A cache assertion against the Render origin is green because every /api/*
  // path there answers DYNAMIC — nothing is cached, so nothing was exercised.
  // That is the ERR-233 failure mode: a green localhost stub proving nothing.
  assert.match(PROBE_SRC, /const EDGE = process\.env\.EDGE_BASE \|\| 'https:\/\/api\.inkcartridges\.co\.nz'/,
    'the edge host must be its own constant, defaulting to the CDN');
  assert.match(PROBE_SRC, /edge=\$\{EDGE\}/, 'and it must be printed in the banner with the others');
  assert.match(PROBE_SRC, /which is the ORIGIN — §0b is the edge measurement/,
    '§3 must say so when it measured the origin instead of the edge');
});

test('§11 §0b runs BEFORE the column gate — a section that cannot run is not a section', () => {
  // The column does not exist yet, so an edge measurement gated behind it would
  // be a hundred lines nobody has ever executed. §0b needs neither the column
  // nor the seed row: it measures the transport.
  const edgeSection = PROBE_SRC.indexOf('§0b the edge');
  const gate = PROBE_SRC.indexOf('CANNOT RUN${C.x} — the backend brief has not been applied');
  assert.ok(edgeSection > 0, 'the edge section must exist');
  assert.ok(gate > 0, 'and the deferred column gate must still be there');
  assert.ok(edgeSection < gate, '§0b has to execute before the probe gives up on the column');
  assert.match(PROBE_SRC, /§0b above DID run and its readings are real/,
    'and the give-up message must distinguish what ran from what did not');
});

test('§11 §0b refuses to conclude anything if it never observed a cache HIT', () => {
  // A skip is not a pass. If the instrument never saw the edge cache anything,
  // every "not cached" reading below it is true for the wrong reason.
  assert.match(PROBE_SRC, /could not warm a cache entry[\s\S]{0,200}nothing in this section was measured/,
    'the warm-failure branch must say what it failed to measure');
  const warnIdx = PROBE_SRC.indexOf('could not warm a cache entry');
  const push = PROBE_SRC.indexOf("findings.push('__CANNOT_RUN__')", warnIdx);
  assert.ok(push > warnIdx && push - warnIdx < 400,
    'and it must push __CANNOT_RUN__ so the verdict exits 2 rather than 0');
  assert.match(PROBE_SRC, /the instrument works/, 'the positive control must be reported when it passes');
});

test('§11 the mirror’s ANONYMOUS refusal must be no-store too', () => {
  // Measured: this zone caches 4xx — /api/shop?limit=1 answered 400 with
  // cf-cache-status: HIT. A cacheable 401 on a mirror route would be served to
  // the admin who came next, and the mirror would fail exactly the way a
  // header-only fix fails.
  assert.match(PROBE_SRC, /REFUSES anonymously without no-store/,
    'the refusal path needs its own assertion, not just the 200 path');
  assert.match(PROBE_SRC, /a cached refusal would be served to the next admin/,
    'and the reason has to be written down where the assertion is');
});

test('§11 the seed row’s empty answer is reported as ambiguous, never as a pass', () => {
  // `200 []` from anon PostgREST means EITHER "never created" OR "created and
  // correctly hidden". One value, two meanings is the ERR-243 shape; the
  // resolution is to name both and let the admin leg decide.
  assert.match(PROBE_SRC, /EITHER it was never created OR RLS is hiding it correctly/,
    'both readings must be printed, because the probe genuinely cannot tell them apart');
  assert.doesNotMatch(PROBE_SRC, /pass\(`?anon PostgREST says/,
    'and neither reading may be scored as a pass');
});

test('§11 no source this feature owns can blind codeOnly() with a stray /*', () => {
  // MET WHILE WRITING §0b, and it is worth generalising.
  //
  // A `//` line containing a path glob — `every /api/… path`, written with an
  // asterisk — is harmless to JavaScript and catastrophic to this repo's
  // comment-stripper: the `/*` opens a block-comment match that runs to the
  // next `*/` and silently deletes live code from what every codeOnly()
  // assertion is reading. It ate 1.1KB of the probe including
  // `const FAST = process.argv...`, and 1.9KB of utils.js including
  // `const AdminPreview = {` and its whole state block — which means a source
  // assertion about those lines could only ever have passed vacuously.
  //
  // Scoped to the files this change owns. search.js and js/admin/api.js carry
  // the same defect today and are being edited by other sessions; they are
  // reported to those sessions rather than fixed from here.
  const OWNED = {
    'inkcartridges/js/api.js': API_SRC,
    'inkcartridges/js/utils.js': UTILS_SRC,
    'inkcartridges/js/cart.js': CART_SRC,
    'inkcartridges/js/checkout-page.js': CHECKOUT_SRC,
    'inkcartridges/js/payment-page.js': PAYMENT_SRC,
    'scripts/probe-admin-only-product.mjs': PROBE_SRC,
  };
  const strays = [];
  for (const [name, src] of Object.entries(OWNED)) {
    src.split('\n').forEach((line, i) => {
      const slash = line.indexOf('//');
      const block = line.indexOf('/*');
      if (slash >= 0 && block > slash) strays.push(`${name}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.deepEqual(strays, [],
    'a /* inside a // comment opens a block comment for every codeOnly() reader:\n  ' + strays.join('\n  '));

  // POSITIVE CONTROL: the detector must actually fire on the shape it is for.
  const planted = ['// a glob like /api/x/' + '* in prose'];
  const found = planted.filter((line) => {
    const slash = line.indexOf('//');
    const block = line.indexOf('/*');
    return slash >= 0 && block > slash;
  });
  assert.equal(found.length, 1, 'the detector must catch a planted stray, or it proves nothing');
});

test('§11 no comment in the probe can blind codeOnly() (met while writing §0b)', () => {
  // A `//` line containing a path glob — `every /api/* path` — is harmless to
  // JavaScript and catastrophic to this repo's comment-stripper: the `/*` opens a
  // block-comment match that runs to the next `*/` and silently deletes live code
  // from what every codeOnly() assertion is reading. It ate 1.1KB here, including
  // `const FAST = process.argv...`, and the only symptom was one assertion in
  // this file failing for a reason that looked unrelated.
  //
  // Guarded by size: no block comment may exceed the header docstring, which is
  // the longest legitimate one in the file.
  const matches = PROBE_SRC.match(/\/\*[\s\S]*?\*\//g) || [];
  const longest = matches.reduce((a, m) => Math.max(a, m.length), 0);
  const header = (PROBE_SRC.match(/^#![^\n]*\n(\/\*\*[\s\S]*?\*\/)/) || [])[1] || '';
  assert.ok(header.length > 500, 'sanity: the header docstring is the long one');
  assert.equal(longest, header.length,
    'a `/*` outside a real comment is swallowing code — check for a path glob in a // line');
});

test('§11 the probe is still READ-ONLY, behaviourally and not by flag name', () => {
  // Copied from tests/for-use-in-cutover-sep2026.test.js §5: assert the absence
  // of write capability, not the absence of a --record string.
  const code = codeOnly(PROBE_SRC);
  assert.doesNotMatch(code, /writeFileSync|createWriteStream|appendFileSync|\bfs\.write/,
    'a probe that can write may be green only because it overwrote what it compared against');
  const verbs = code.match(/method:\s*'(\w+)'/g) || [];
  for (const v of verbs) {
    assert.match(v, /'GET'|'POST'/, 'only GETs and the sign-in POST');
  }
  assert.equal((code.match(/method:\s*'POST'/g) || []).length, 1,
    'exactly one POST in the file: the Supabase sign-in');
  const argv = code.match(/process\.argv\S*/g) || [];
  assert.deepEqual(argv, ["process.argv.includes('--fast');"],
    'the only flag this probe reads is --fast, which changes pacing and nothing else');
  // Positive controls, so the comment-stripper cannot pass everything by
  // stripping too much.
  assert.match(code, /cf-cache-status/, 'the stripped source must still contain the real measurement');
  assert.match(PROBE_SRC, /MODE: READ-ONLY/, 'the mode must be PRINTED on every run, never assumed');
});
