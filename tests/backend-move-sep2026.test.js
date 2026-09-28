/**
 * Backend move to Render Singapore + storefront speed fixes — backend handoff 2026-09-28
 * ======================================================================================
 *
 * backend-docs/inbox/fe-handoff-page-speed-and-backend-move-sep2026.md. Every claim
 * the handoff makes about a live endpoint was measured before it was built on
 * (scripts/probe-backend-move.mjs); where the handoff was wrong, the section says so.
 *
 *   §0  The Vercel side names `ink-backend-sg`, never the retired `ink-backend-zaeq`.
 *       The old service is switched off once this ships; a rewrite still naming it
 *       would 404 the sitemap, the feeds, robots.txt and every bot prerender.
 *   §4a site-guard reads GET /api/site/lock, not site_settings straight from
 *       Supabase — one uncached Mumbai round trip fewer on every page view — and
 *       still fails OPEN on every failure.
 *
 * Run with: node --test tests/backend-move-sep2026.test.js
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

const OLD_HOST = 'ink-backend-zaeq.onrender.com';
const NEW_ORIGIN = 'https://ink-backend-sg.onrender.com';

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, out); }
        else if (/\.(js|mjs|html|json)$/.test(e.name)) out.push(abs);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// §0 No shipped file names the old backend host
// ─────────────────────────────────────────────────────────────────────────────

test('§0 nothing under the web root or scripts/ names the old Render host', () => {
    // The web root is what Vercel serves and runs (middleware, rewrites, CSP,
    // every fallback). scripts/ is here too: a probe defaulting to a switched-off
    // host fails on a DNS error and reads like an outage, not a stale default.
    // ONE exemption: the probe that measures the old host against the new one
    // (and reports when it has gone quiet) has to name it.
    const EXEMPT = new Set([path.join(ROOT, 'scripts/probe-backend-move.mjs')]);
    const files = [...walk(INK), ...walk(path.join(ROOT, 'scripts'))].filter((f) => !EXEMPT.has(f));
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes(OLD_HOST))
        .map((f) => path.relative(ROOT, f));
    assert.deepEqual(hits, [], `still naming ${OLD_HOST}:\n  ${hits.join('\n  ')}`);
});

test('§0 middleware and every Render-bound rewrite target the Singapore service', () => {
    assert.match(read('middleware.js'), new RegExp(`^const BACKEND = '${NEW_ORIGIN}';`, 'm'));
    const vercel = JSON.parse(read('vercel.json'));
    const renderBound = vercel.rewrites.filter((r) => /onrender\.com/.test(r.destination));
    // sitemap, sitemap-:path, robots, llms, 3 feeds, /p, /html/p, /product-by-name, /shop, /html/shop
    assert.ok(renderBound.length >= 12, `expected the full Render-bound rewrite set, got ${renderBound.length}`);
    for (const r of renderBound) {
        assert.ok(r.destination.startsWith(`${NEW_ORIGIN}/`), `${r.source} → ${r.destination}`);
    }
    const csp = vercel.headers.flatMap((h) => h.headers)
        .find((h) => h.key === 'Content-Security-Policy').value;
    const connect = csp.match(/connect-src ([^;]*)/)[1].split(/\s+/);
    assert.ok(connect.includes(NEW_ORIGIN), 'connect-src allows the non-production API origin');
});

test('§0 the four pre-Config mirrors of Config.API_URL agree on every host', () => {
    // config.js, pdp-prefetch.js, site-guard.js and traffic-tracker.js each carry
    // the same host rule because three of them run before config.js exists. A
    // mirror left on the old host would break only off-production — silently.
    const configExpr = read('js/config.js').match(/API_URL: (\(location\.hostname[\s\S]*?'),\n/)[1];
    const prefetch = read('js/pdp-prefetch.js').match(/function apiBase\(host\) \{[\s\S]*?\n {4}\}/)[0];
    const guardExpr = read('js/site-guard.js').match(/const BACKEND_URL = ([\s\S]*?);/)[1];
    const tracker = read('js/traffic-tracker.js').match(/function getApiUrl\(\) \{[\s\S]*?\n {4}\}/)[0];
    for (const hostname of ['www.inkcartridges.co.nz', 'inkcartridges.co.nz', 'localhost', 'feink.vercel.app']) {
        const ctx = { location: { hostname } };
        const want = vm.runInNewContext(configExpr, ctx);
        assert.equal(vm.runInNewContext(`${prefetch}; apiBase(${JSON.stringify(hostname)})`, {}), want, `pdp-prefetch @ ${hostname}`);
        assert.equal(vm.runInNewContext(guardExpr, ctx), want, `site-guard @ ${hostname}`);
        assert.equal(vm.runInNewContext(`${tracker}; getApiUrl()`, ctx), want, `traffic-tracker @ ${hostname}`);
    }
    assert.equal(vm.runInNewContext(configExpr, { location: { hostname: 'localhost' } }), NEW_ORIGIN);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4a site-guard reads the lock from the API, and still fails open
// ─────────────────────────────────────────────────────────────────────────────

function guardFn(name) {
    const src = read('js/site-guard.js');
    const m = src.match(new RegExp(`  async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
    assert.ok(m, `site-guard.js must define ${name}`);
    return m[0];
}

async function lockWith(fetchImpl) {
    const ctx = { BACKEND_URL: 'https://api.test', fetch: fetchImpl, calls: [] };
    return vm.runInNewContext(`${guardFn('getLockStatus')}; getLockStatus()`, ctx);
}

test('§4a the lock is read from GET /api/site/lock, anonymously, and never from site_settings', async () => {
    const src = stripComments(read('js/site-guard.js'));
    assert.doesNotMatch(src, /site_settings/, 'the direct Supabase read is gone');
    let seen;
    const got = await lockWith(async (url, opts) => {
        seen = { url, opts };
        return { ok: true, json: async () => ({ ok: true, data: { enabled: true, message: 'Back soon' } }) };
    });
    assert.equal(seen.url, 'https://api.test/api/site/lock');
    assert.equal(seen.opts.credentials, 'omit', 'anonymous ⇒ one shared edge-cache entry');
    assert.deepEqual({ ...got }, { enabled: true, message: 'Back soon' });
});

test('§4a every failure reads as UNLOCKED (fail-open, as the Supabase read was)', async () => {
    const cases = {
        'network error': async () => { throw new TypeError('Failed to fetch'); },
        '503': async () => ({ ok: false, status: 503, json: async () => ({}) }),
        'non-JSON body': async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }),
        'ok:false envelope': async () => ({ ok: true, json: async () => ({ ok: false, error: 'x' }) }),
        'no data': async () => ({ ok: true, json: async () => ({ ok: true }) }),
    };
    for (const [label, impl] of Object.entries(cases)) {
        assert.equal(await lockWith(impl), null, label);
    }
});

test('§4a PRESERVED (green before this change too): unlocked or no supabase-js ⇒ open; locked ⇒ overlay', async () => {
    const run = guardFn('run');
    const ctx = (lock, supabase) => ({
        location: { pathname: '/shop' },
        window: supabase ? { supabase } : {},
        getLockStatus: async () => lock,
        initClient: () => { throw new Error('initClient must not run'); },
        showOverlay: () => { ctx.shown = true; },
    });
    // Unlocked: returns before any client work (initClient would throw).
    const unlocked = ctx({ enabled: false }, null);
    await vm.runInNewContext(`${run}; run()`, unlocked);
    // Locked, but supabase-js failed to load: open, as before this change.
    const noSb = ctx({ enabled: true, message: 'x' }, null);
    noSb.showOverlay = () => { throw new Error('overlay must not show without supabase-js'); };
    await vm.runInNewContext(`${run}; run()`, noSb);
    // Locked with supabase-js and no admin session: the overlay shows.
    let shown = null;
    const locked = {
        location: { pathname: '/shop' },
        window: { supabase: { createClient() {} } },
        getLockStatus: async () => ({ enabled: true, message: 'Back soon' }),
        initClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
        isAdminSession: async () => false,
        showOverlay: (m) => { shown = m; },
    };
    await vm.runInNewContext(`${run}; run()`, locked);
    assert.equal(shown, 'Back soon');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 PDP: the gallery paints from the product response
// ─────────────────────────────────────────────────────────────────────────────

const PDP_SRC = stripComments(read('js/product-detail-page.js'));
const PDP_INIT = PDP_SRC.slice(PDP_SRC.indexOf('this.product = response.data;'),
    PDP_SRC.indexOf('this.renderProduct();', PDP_SRC.indexOf('this.product = response.data;')));

test('§2 a non-ribbon PDP awaits nothing between the product response and renderProduct()', () => {
    // Every `await` left in that window must be inside a branch that a
    // well-formed non-ribbon /api/products/:sku row does not enter.
    // (The two inside the enrich IIFE run off the main path: nothing awaits
    // the IIFE unless the row lacks its fields.)
    const awaits = (PDP_INIT.match(/await [^;(]+/g) || []).map((a) => a.trim());
    assert.deepEqual(awaits, ['await fetch', 'await enrichResp.json', 'await enrichPromise',
        'await API.getManualProductCodes', 'await enrichPromise'],
        'only the enrich fallback, the ribbon branch and the missing-fields branch may await');
    assert.match(PDP_INIT, /const needsEnrich = this\.product\.id == null\s*\|\| !hasOwn\('description_html'\) \|\| !hasOwn\('related_product_skus'\);/,
        'the Supabase enrich runs only when the row lacks the fields');
    assert.match(PDP_INIT, /const enrichPromise = needsEnrich \?/);
    assert.match(PDP_INIT, /if \(isRibbonRow\) \{[\s\S]*?getManualProductCodes[\s\S]*?\} else if \(enrichPromise\) \{/,
        'product_codes is read for ribbons only');
});

test('§2 the enrich fallback is LOUD when a non-ribbon row arrives without the fields', () => {
    assert.match(PDP_INIT, /if \(!isRibbonRow && typeof DebugLog !== 'undefined' && DebugLog\.warn\) \{\s*DebugLog\.warn\('\[PDP\] product row lacks/);
});

function utilsImageFns(apiUrl) {
    const src = read('js/utils.js');
    const pick = (name) => {
        const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
        assert.ok(m, `utils.js must define ${name}`);
        return m[0];
    };
    return vm.runInNewContext(`${pick('optimizedImageUrl')}\n${pick('storageUrl')}\n${pick('imageSrcset')}\n`
        + '({ storageUrl, imageSrcset })', { Config: { API_URL: apiUrl } });
}

test('§2 the hero preload asks for EXACTLY the URLs the <img> will ask for', () => {
    // A mismatch downloads the LCP image twice. The <img> is built in
    // renderProduct from storageUrl(image_url) + imageSrcset(raw, [400,600,800]).
    const prefetch = require(path.join(INK, 'js/pdp-prefetch.js'));
    const base = 'https://api.inkcartridges.co.nz';
    const u = utilsImageFns(base);
    const pdp = read('js/product-detail-page.js');
    const sizes = pdp.match(/sizes="([^"]+)"/)[1];
    assert.match(pdp, /imageSrcset\(info\.image_url_raw, \[400, 600, 800\]\)/, 'the widths the mirror copies');
    for (const raw of [
        'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/images/products/C02BK/main.png',
        'images/products/a b&c/x.webp',
    ]) {
        const hero = prefetch.heroImage(raw, base);
        assert.equal(hero.href, u.storageUrl(raw), `href for ${raw}`);
        assert.equal(hero.srcset, u.imageSrcset(raw, [400, 600, 800]), `srcset for ${raw}`);
        assert.equal(hero.sizes, sizes, 'sizes');
    }
    assert.equal(prefetch.heroImage('/assets/images/placeholder-product.svg', base), null, 'local asset: no preload');
    assert.equal(prefetch.heroImage('', base), null);
    assert.equal(prefetch.heroImage('https://x.test/images/color-swatch-v2.png', base), null,
        'the legacy swatch is replaced by a colour block, so preloading it wastes the fetch');
});

test('§2 the preload is injected once, marked data-lcp-product, and only for a real product', () => {
    const { preloadHero } = require(path.join(INK, 'js/pdp-prefetch.js'));
    const appended = [];
    const doc = {
        head: { appendChild: (el) => appended.push(el) },
        createElement: () => { const attrs = {}; return { attrs, setAttribute: (k, v) => { attrs[k] = v; } }; },
        querySelector: () => (appended.length ? appended[0] : null),
    };
    const body = { ok: true, data: { image_url: 'https://x.test/p.png' } };
    const link = preloadHero(doc, body, 'https://api.test');
    assert.equal(link.rel, 'preload');
    assert.equal(link.as, 'image');
    assert.equal(link.attrs.fetchpriority, 'high');
    assert.equal(link.attrs['data-lcp-product'], 'pdp-hero',
        'Products._preloadLCPImage skips when this marker exists (no below-fold card promoted)');
    assert.equal(preloadHero(doc, body, 'https://api.test'), null, 'never twice');
    assert.equal(appended.length, 1);
    assert.equal(preloadHero({ ...doc, querySelector: () => null }, { ok: false, error: {} }, 'x'), null, 'error envelope: nothing');
    assert.match(read('js/products.js'), /if \(document\.querySelector\('link\[rel="preload"\]\[data-lcp-product\]'\)\) return;/,
        'the card helper still honours the marker');
});

test('§2 renderCompatiblePrinters paints the machine list when it lands, not before render', () => {
    const fn = PDP_SRC.match(/async renderCompatiblePrinters\(info\) \{[\s\S]*?const forUseIn = this\._forUseIn \|\| \{\};/);
    assert.ok(fn);
    assert.match(fn[0], /if \(this\._forUseInPromise\) await this\._forUseInPromise;/);
    assert.match(PDP_SRC, /this\._forUseInPromise = this\._fetchForUseIn\(sku\);/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 The Google Customer Reviews badge waits for idle
// ─────────────────────────────────────────────────────────────────────────────

const FOOTER = stripComments(read('js/footer.js'));

function runFooterGcr({ pathname, withIdle = true }) {
    // Run the real block (from `window.___gcfg` to the end of its IIFE) against
    // a fake window/document and record what it injects, and when.
    const start = FOOTER.lastIndexOf('(function () {', FOOTER.indexOf('window.___gcfg'));
    const end = FOOTER.indexOf('})();', FOOTER.indexOf('loadPlatformOnce();')) + 5;
    const block = FOOTER.slice(start, end);
    const injected = [];
    const listeners = {};
    const idle = [];
    const win = {
        addEventListener: (t, fn) => { listeners[t] = fn; },
        removeEventListener: (t) => { delete listeners[t]; },
    };
    if (withIdle) win.requestIdleCallback = (fn) => idle.push(fn);
    const ctx = {
        window: win,
        location: { pathname },
        localStorage: { getItem: () => null },
        setTimeout: (fn) => idle.push(fn),
        document: {
            querySelector: () => (injected.length ? injected[0] : null),
            createElement: () => ({}),
            head: { appendChild: (el) => injected.push(el) },
            getElementById: () => null,
            addEventListener: () => {},
            documentElement: { style: { setProperty() {} } },
        },
        ResizeObserver: undefined,
        MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    };
    ctx.window.document = ctx.document;
    vm.runInNewContext(block, ctx);
    return { injected, listeners, idle, win };
}

test('§5 platform.js is NOT injected at footer init on an ordinary page, only when idle', () => {
    const r = runFooterGcr({ pathname: '/shop' });
    assert.equal(r.injected.length, 0, 'nothing injected synchronously');
    assert.equal(r.idle.length, 0, 'no idle callback before the load event');
    r.listeners.load();
    assert.equal(r.injected.length, 0, 'load alone does not inject it');
    assert.equal(r.idle.length, 1, 'one idle callback queued after load');
    r.idle[0]();
    assert.equal(r.injected.length, 1);
    assert.match(r.injected[0].src, /platform\.js\?onload=renderOptIn$/);
    r.listeners.scroll && r.listeners.scroll();
    assert.equal(r.injected.length, 1, 'a later scroll does not inject it again');
});

test('§5 the first scroll loads it before idle; no requestIdleCallback falls back to a timer', () => {
    const r = runFooterGcr({ pathname: '/products/x/C02BK' });
    assert.ok(r.listeners.scroll && r.listeners.pointerdown && r.listeners.keydown);
    r.listeners.pointerdown();
    assert.equal(r.injected.length, 1);
    const noIdle = runFooterGcr({ pathname: '/', withIdle: false });
    noIdle.listeners.load();
    assert.equal(noIdle.injected.length, 0);
    assert.equal(noIdle.idle.length, 1, 'setTimeout fallback queued');
});

test('§5 PRESERVED: order confirmation still loads it at once (the survey is that page\'s purpose)', () => {
    for (const pathname of ['/order-confirmation', '/html/order-confirmation']) {
        assert.equal(runFooterGcr({ pathname }).injected.length, 1, pathname);
    }
});

test('§5 the confirmation survey goes through the consent gate, never gapi.surveyoptin directly', () => {
    const oc = stripComments(read('js/order-confirmation-page.js'));
    assert.doesNotMatch(oc, /surveyoptin\.render/, 'a direct render skipped the consent check (ERR-227)');
    assert.match(oc, /window\.__gcrRenderSurvey\(\)/);
    assert.match(FOOTER, /window\.__gcrRenderSurvey = renderSurveyIfConsented;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 No GET /api/cart when no cart can exist
// ─────────────────────────────────────────────────────────────────────────────

function cartMethod(name) {
    const src = read('js/cart.js');
    const m = src.match(new RegExp(`\\n    ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\},`));
    assert.ok(m, `Cart.${name} must exist`);
    return m[0].trim().replace(/,$/, '');
}

test('§6 the skip predicate: only no session + no lines + no pending removal skips the read', () => {
    const make = (sid, pending) => vm.runInNewContext(`({ _pendingOps: ${JSON.stringify(pending)}, ${cartMethod('_noServerCartToRead')} })`,
        { API: { getGuestSessionId: () => sid } });
    assert.equal(make(null, [])._noServerCartToRead(0), true, 'first-time visitor: skip');
    assert.equal(make(null, [])._noServerCartToRead(2), false,
        'local lines without a session (a failed first add) still need the re-push path');
    assert.equal(make('9b2c…', [])._noServerCartToRead(0), false, 'a session may hold lines this browser lost');
    assert.equal(make(null, [{ op: 'remove' }])._noServerCartToRead(0), false, 'a pending removal is owed a read');
});

test('§6 loadCart consults it on the signed-out path only, and still clears `loading`', () => {
    const fn = cartMethod('async loadCart');
    const iAuth = fn.indexOf('if (this.isAuthenticated) {');
    const iSkip = fn.indexOf('} else if (this._noServerCartToRead(localItemCount)) {');
    const iGet = fn.indexOf('await API.getCart()');
    assert.ok(iAuth > -1 && iSkip > iAuth && iGet > iSkip, 'auth first, then the skip, then the guest read');
    assert.match(fn.slice(iSkip, iGet), /this\._losePricing\(PRICING\.LOCAL_ONLY\);/,
        'same end state as "both sides empty"');
    assert.match(fn, /finally \{[\s\S]*?this\.loading = false;/,
        'the skip is inside the try, so the finally still clears loading (cart-deep-link.js polls it)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §1 Search: the literal-match repair starts WITH /smart on a digit query
// ─────────────────────────────────────────────────────────────────────────────
//
// The handoff asked us to drop /products?search= and /search/suggest. They are
// not duplicates: they fire only when /smart misses or autocorrects badly and
// repair real bugs (ERR-133/144/264). The owner chose to keep them and start
// them early on the queries where they matter.

const SHOP = stripComments(read('js/shop-page.js'));
const SEARCH_FN = SHOP.slice(SHOP.indexOf('async loadSearchResults(navVersion)'),
    SHOP.indexOf('async ', SHOP.indexOf('async loadSearchResults(navVersion)') + 30));

test('§1 a digit or exact query starts products?search= and suggest BEFORE awaiting /smart', () => {
    const iSpec = SEARCH_FN.indexOf('const speculate = /\\d/.test(String(searchQuery || \'\')) || !!this.state.exact;');
    const iSmart = SEARCH_FN.indexOf('await API.smartSearch(');
    assert.ok(iSpec > -1 && iSmart > iSpec, 'the speculation is decided, and started, before /smart is awaited');
    const spec = SEARCH_FN.slice(iSpec, iSmart);
    assert.match(spec, /fallback: API\.getProducts\(\{ search: searchQuery, limit: SEARCH_PAGE_SIZE, page: requestedPage \}\)/);
    assert.match(spec, /suggest: requestedPage === 1 \? API\.searchSuggest\(searchQuery, 20\) : Promise\.resolve\(\[\]\)/,
        'suggest stays page-1 only');
    assert.match(spec, /speculative\.fallback\.catch\(\(\) => \{\}\)/, 'an unused rejection is not an unhandled one');
});

test('§1 the repair consumes the speculative promises, and still fires the same calls for a word query', () => {
    const iRepair = SEARCH_FN.indexOf('if (hardMiss || softMiss || hijack || exactMode) {');
    const block = SEARCH_FN.slice(iRepair, iRepair + 1200);
    assert.match(block, /await Promise\.all\(speculative\s*\? \[speculative\.fallback, speculative\.suggest\]/);
    assert.match(block, /: \[\s*API\.getProducts\(\{ search: searchQuery, limit: SEARCH_PAGE_SIZE, page: requestedPage \}\)/,
        'no speculation ⇒ exactly the calls it made before');
    // Exactly two getProducts({ search… }) sites in the function: the speculative
    // one and the non-speculative repair. A third would double-fetch.
    assert.equal((SEARCH_FN.match(/API\.getProducts\(\{ search: searchQuery/g) || []).length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 Brand page: no dead ribbons count, schema not held behind the level
// ─────────────────────────────────────────────────────────────────────────────

test('§3 loadCategories no longer asks /api/ribbons for a tile it never renders', () => {
    const fn = SHOP.slice(SHOP.indexOf('async loadCategories(navVersion)'), SHOP.indexOf('async loadProductCodes(navVersion)'));
    assert.ok(fn.length > 100);
    assert.doesNotMatch(fn, /getRibbons\(/);
    assert.doesNotMatch(fn, /ribbonPromise/);
    assert.match(fn, /cat\.id !== 'ribbons' && categoryCounts\[cat\.id\] > 0/,
        'the filter that made the count dead is still there — if ribbons ever become a tile, the count comes back with it');
});

test('§3 init injects the collection schema BEFORE awaiting the level loader', () => {
    const init = SHOP.slice(SHOP.indexOf('this.parseURLState();'), SHOP.indexOf("window.addEventListener('popstate'"));
    const iSchema = init.indexOf('this.injectCollectionSchema();');
    const iLevel = init.indexOf('await this.loadCurrentLevel(this.navigationVersion);');
    assert.ok(iSchema > -1 && iLevel > -1 && iSchema < iLevel, 'schema first, level after');
    assert.doesNotMatch(init.slice(iSchema, iSchema + 40), /await/, 'and it is not awaited');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4b Ribbon brands ride on /api/site/nav; related rails stop reading product_codes
// ─────────────────────────────────────────────────────────────────────────────

const API_CODE = stripComments(read('js/api.js'));

test('§4b getRibbonBrandsList reads site/nav first; the direct read is the null-only fallback', () => {
    const fn = API_CODE.match(/async _fetchRibbonBrandsList\(\) \{[\s\S]*?\n    \},/)[0];
    assert.match(fn, /await this\.getSiteNav\(\)/);
    assert.match(fn, /if \(Array\.isArray\(list\)\) return \{ ok: true, data: \{ brands: list \} \};/,
        'an array — even an empty one — is the answer');
    assert.match(fn, /return this\._fetchRibbonBrandsDirect\(\);/);
    assert.match(fn, /DebugLog\.warn\(/, 'the fallback says so');
});

test('§2 _applyManualCodes: ribbon rows only in step 1, no by-code product_codes read in step 3', () => {
    const fn = API_CODE.match(/async _applyManualCodes\(primary, params, truncated\) \{[\s\S]*?\n    \},/)[0];
    assert.match(fn, /const ribbonRows = products\.filter\(p => p && ribbonTypes\.includes\(p\.product_type\)\);/);
    assert.match(fn, /this\._fetchManualCodesByProduct\(ribbonRows\.map\(p => p\.id\)\)/);
    assert.doesNotMatch(API_CODE, /_fetchProductIdsForCode/, 'the same-type recovery reader is gone');
    assert.match(fn, /const summary = await this\._fetchVisitorRows\(params\.brand\);/,
        'visitor ids are asked for only when the brand summary says the chip has visitors');
});
