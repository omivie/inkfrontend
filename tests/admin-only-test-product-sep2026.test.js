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
