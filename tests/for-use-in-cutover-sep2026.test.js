/**
 * "FOR USE IN" — off the anon key, onto the endpoint (ERR-243, Sep 2026)
 * ======================================================================
 *
 * THE BUG. Every PDP load fired this, with the public anon key that ships in
 * the page:
 *
 *   GET /rest/v1/products?sku=eq.CTN258XLBK
 *         &select=id,description_html,compatible_devices_html,related_product_skus
 *
 * `compatible_devices_html` is the admin-authored machine list, and read that
 * way it was BULK-DUMPABLE: drop the `sku=eq.` filter and every list in the
 * catalogue comes back in one request. The data now lives in
 * `product_compat_devices` (backend mig 131) — RLS on, service-role only — and
 * GET /api/products/:sku/for-use-in is its only door.
 *
 * WHAT THIS FILE PINS THAT A GREP WOULD NOT
 * -----------------------------------------
 * Removing the column from the select is the easy half and §1 covers it. The
 * half that can go wrong silently is §3: the old read answered `null` both for
 * "this product has no list" and for "the read failed", and the renderer could
 * not tell them apart. On a ribbon PDP — which shows NOTHING without this copy
 * (ERR-086) — both painted an identical blank page. That is ERR-193's shape
 * exactly, and it ran for 44 hours on 63 pages last time with no symptom.
 *
 * So the three outcomes are now distinct, and §3 exercises all three against the
 * real function rather than asserting that a comment promises they exist:
 *
 *   'ok'          endpoint returned a list        → render it
 *   'none'        endpoint returned null          → there IS no list
 *   'unavailable' 429 / 5xx / network / bad shape → WE DO NOT KNOW
 *
 * The first version of the migration comparison, run by hand, reported "43 of
 * 91 lists missing" and was WRONG: the endpoint is rate-limited 40/min/IP and a
 * 429 body has no `for_use_in_html` key, so `data.for_use_in_html ?? null` read
 * a refusal as an absence. §3's hasOwnProperty assertions are that bug pinned.
 *
 * Run with: node --test tests/for-use-in-cutover-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'inkcartridges', 'js');
const PDP = fs.readFileSync(path.join(JS_DIR, 'product-detail-page.js'), 'utf8');
const API_JS = fs.readFileSync(path.join(JS_DIR, 'api.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// §1  The anon read no longer asks for the column
// ─────────────────────────────────────────────────────────────────────────

test('§1 the enrich select does NOT name compatible_devices_html', () => {
    const m = PDP.match(/const enrichUrl = `[^`]+`/);
    assert.ok(m, 'the Supabase enrich URL must still be findable');
    assert.doesNotMatch(m[0], /compatible_devices_html/,
        'the admin machine list must not be read with the anon key — it is bulk-dumpable that way');
});

test('§1 the enrich select still carries the three columns that DID not move', () => {
    // Backend mig 132 drops ONE column. Dropping more from this select would be
    // a silent feature removal: description_html feeds the ribbon description
    // and related_product_skus feeds the curated rail.
    const m = PDP.match(/const enrichUrl = `[^`]+`/)[0];
    for (const col of ['id', 'description_html', 'related_product_skus']) {
        assert.match(m, new RegExp(`\\b${col}\\b`), `${col} must stay in the enrich select`);
    }
});

test('§1 no other file reads compatible_devices_html off PostgREST', () => {
    const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
    const offenders = files.filter((f) => {
        const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
        // A select list naming the column — comments about it are fine and there
        // are several, deliberately, explaining why it is gone.
        return /select=[^`'"\n]*compatible_devices_html/.test(src);
    });
    assert.deepEqual(offenders, [], 'nothing may select compatible_devices_html from PostgREST');
});

test('§1 the admin editor is untouched — it still WRITES the column', () => {
    // The admin drawer dual-writes so the storefront kept working during the
    // cutover. This test exists so nobody "tidies" the write away and silently
    // stops the backend's mig-131 sync from having a source.
    const admin = fs.readFileSync(path.join(JS_DIR, 'admin', 'pages', 'products.js'), 'utf8');
    assert.match(admin, /compatible_devices_html/,
        'the admin product editor must still own this field');
});

// ─────────────────────────────────────────────────────────────────────────
// §2  The endpoint is fetched the one way that is safe
// ─────────────────────────────────────────────────────────────────────────

test('§2 API.getForUseIn goes through getPublic', () => {
    // getPublic sets anonymous:true. The endpoint is edge-cached (measured
    // s-maxage=300, cf-cache-status: HIT), so a bearer or X-Guest-Session on it
    // is ERR-124/159: one shared cache entry, per-visitor headers.
    const fn = API_JS.match(/async getForUseIn\(sku\)\s*\{[\s\S]*?\n    \},/);
    assert.ok(fn, 'API.getForUseIn must exist');
    assert.match(fn[0], /this\.getPublic\(/,
        'must use getPublic (anonymous:true) — never get()/request() with a token');
    assert.match(fn[0], /encodeURIComponent\(sku\)/,
        'SKUs contain dots and slashes-adjacent characters; encode them');
});

test('§2 the PDP fetches it in PARALLEL with the enrich, not after it', () => {
    // Both are needed before render. Awaiting them in series would have made a
    // security fix cost a round trip on every product page.
    const idxStart = PDP.indexOf('const forUseInPromise = this._fetchForUseIn(sku);');
    const idxEnrich = PDP.indexOf('const enrichUrl =');
    const idxAwait = PDP.indexOf('await forUseInPromise;');
    assert.ok(idxStart > -1, 'the for-use-in fetch must be started explicitly');
    assert.ok(idxStart < idxEnrich, 'it must START before the enrich fetch');
    assert.ok(idxAwait > idxEnrich, 'and be AWAITED after it, so the two overlap');
});

test('§2 _fetchForUseIn is the ONLY caller of API.getForUseIn', () => {
    // The helper awaits it internally — that is fine and necessary. What must
    // not exist is a SECOND call site in the load path, which would serialise
    // the two requests again and quietly undo §2's whole point.
    const calls = (PDP.match(/API\.getForUseIn\(/g) || []).length;
    assert.equal(calls, 1, `API.getForUseIn must be called exactly once in the PDP, found ${calls}`);
    const fn = PDP.match(/async _fetchForUseIn\(sku\)\s*\{[\s\S]*?\n        \},/);
    assert.ok(fn && /API\.getForUseIn\(/.test(fn[0]),
        'the single call site must be inside _fetchForUseIn');
});

// ─────────────────────────────────────────────────────────────────────────
// §3  The three outcomes, exercised against the real function
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lift `_fetchForUseIn` out of the page IIFE and run it against a fake API and
 * a fake document. Behaviour, not source text — a comment claiming three states
 * exist is exactly what this is guarding against.
 */
function loadFetcher(apiImpl) {
    const src = PDP.match(/async _fetchForUseIn\(sku\)\s*\{[\s\S]*?\n        \},/);
    assert.ok(src, '_fetchForUseIn must be findable');
    const attrs = {};
    const sandbox = {
        API: apiImpl,
        DebugLog: { warn() {}, error() {} },
        document: { documentElement: { setAttribute(k, v) { attrs[k] = v; }, getAttribute: (k) => attrs[k] } },
    };
    vm.createContext(sandbox);
    const holder = vm.runInContext(`({ ${src[0].replace(/,$/, '')} })`, sandbox);
    return { holder, attrs };
}

test('§3 a returned list is state "ok"', async () => {
    const { holder, attrs } = loadFetcher({
        getForUseIn: async () => ({ ok: true, data: { sku: 'X', for_use_in_html: '<p>STAR LC2410</p>' } }),
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'ok');
    assert.equal(out.html, '<p>STAR LC2410</p>');
    assert.equal(attrs['data-for-use-in'], 'ok', 'the state must be recorded on <html>');
});

test('§3 an explicit null is state "none" — the product HAS no list', async () => {
    const { holder, attrs } = loadFetcher({
        getForUseIn: async () => ({ ok: true, data: { sku: 'X', for_use_in_html: null } }),
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'none');
    assert.equal(out.html, null);
    assert.equal(attrs['data-for-use-in'], 'none');
});

test('§3 whitespace-only html is "none", not a blank block', async () => {
    const { holder } = loadFetcher({
        getForUseIn: async () => ({ ok: true, data: { sku: 'X', for_use_in_html: '   \n  ' } }),
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'none');
});

test('§3 a 429 envelope is "unavailable" — NEVER "none"', async () => {
    // THE BUG THIS PINS. A 429 body has no for_use_in_html key. Reading that as
    // null reported 43 of 91 lists as missing when none were.
    let calls = 0;
    const { holder, attrs } = loadFetcher({
        getForUseIn: async () => { calls++; return { ok: false, error: { code: 'rate_limited' } }; },
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'unavailable', 'a refusal is not an absence');
    assert.equal(attrs['data-for-use-in'], 'unavailable');
    assert.equal(calls, 2, 'it must retry once before giving up — the limiter clears in under a minute');
});

test('§3 a 200 whose envelope LACKS the key is "unavailable", not "none"', async () => {
    // ABSENT ≠ null (ERR-199). `?? null` would call this "no list".
    const { holder } = loadFetcher({
        getForUseIn: async () => ({ ok: true, data: { sku: 'X' } }),
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'unavailable');
});

test('§3 a THROWN network error is "unavailable", not a crash', async () => {
    // API.request() throws on network failure rather than answering a falsy
    // envelope — the assumption that made a fallback dead code in ERR-216.
    const { holder } = loadFetcher({
        getForUseIn: async () => { throw new TypeError('Failed to fetch'); },
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'unavailable');
});

test('§3 a transient failure that clears on retry resolves to the real answer', async () => {
    let n = 0;
    const { holder } = loadFetcher({
        getForUseIn: async () => {
            n++;
            if (n === 1) return { ok: false };
            return { ok: true, data: { for_use_in_html: '<p>OKI ML182</p>' } };
        },
    });
    const out = await holder._fetchForUseIn('X');
    assert.equal(out.state, 'ok', 'the retry must be able to succeed, not just be counted');
    assert.equal(n, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// §4  The renderer honours the distinction
// ─────────────────────────────────────────────────────────────────────────

test('§4 the renderer reads the fetched state, not the dropped column', () => {
    const fn = PDP.match(/async renderCompatiblePrinters\(info\)\s*\{[\s\S]*?\n        \},/);
    assert.ok(fn, 'renderCompatiblePrinters must be findable');
    assert.doesNotMatch(fn[0], /info\.compatible_devices_html/,
        'the renderer must not read a column that is about to be dropped');
    assert.match(fn[0], /forUseIn\.state === 'ok'/,
        'it must render only on the state that means "we have a list"');
});

test('§4 "unavailable" on a ribbon shows a notice, not a blank', () => {
    // A ribbon PDP is nothing but this block. A blank one reads as "fits
    // nothing" — an assertion we have no right to make when the read failed.
    const fn = PDP.match(/async renderCompatiblePrinters\(info\)\s*\{[\s\S]*?\n        \},/)[0];
    assert.match(fn, /forUseIn\.state === 'unavailable' && info\.category === 'ribbon'/,
        'the unavailable state must be handled explicitly for ribbons');
    assert.match(fn, /data-for-use-in-state="unavailable"/,
        'the painted block must declare which state it is showing');
    assert.match(fn, /for-use-in-retry/, 'and offer a retry rather than a dead end');
});

test('§4 "unavailable" on a NON-ribbon falls through to the compat fallbacks', () => {
    // Non-ribbons have three more sources below (grouped, flat, printer join),
    // so they lose nothing and must not get a notice they do not need.
    const fn = PDP.match(/async renderCompatiblePrinters\(info\)\s*\{[\s\S]*?\n        \},/)[0];
    const idxUnavailable = fn.indexOf("forUseIn.state === 'unavailable'");
    const idxRibbonGuard = fn.indexOf("if (info.category === 'ribbon') return;");
    assert.ok(idxUnavailable > -1 && idxRibbonGuard > idxUnavailable,
        'the ribbon-only notice must come BEFORE the ribbon short-circuit, so non-ribbons keep falling through');
});

test('§4 the ok-state block is still injected into the ribbon left column', () => {
    const fn = PDP.match(/async renderCompatiblePrinters\(info\)\s*\{[\s\S]*?\n        \},/)[0];
    assert.match(fn, /ribbon-col-left/);
    assert.match(fn, /ribbon-detail-columns/);
    assert.match(fn, /FOR USE IN:/);
});

// ─────────────────────────────────────────────────────────────────────────
// §5  The probe exists and can be run
// ─────────────────────────────────────────────────────────────────────────

test('§5 probe:for-use-in exists and is registered', () => {
    // ERR-229: "a probe nobody can run does not exist."
    const probe = path.join(ROOT, 'scripts', 'probe-for-use-in.mjs');
    assert.ok(fs.existsSync(probe), 'scripts/probe-for-use-in.mjs must exist');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['probe:for-use-in'], 'node scripts/probe-for-use-in.mjs');
});

test('§5 the probe treats a 429 as a failure to measure, never as "no list"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-for-use-in.mjs'), 'utf8');
    assert.match(src, /429/, 'the probe must know about the rate limit');
    assert.match(src, /hasOwnProperty\.call\(j\.data, 'for_use_in_html'\)/,
        'the probe must distinguish an absent key from a null value — the exact bug that ' +
        'produced a false "43 of 91 missing" report');
    // Assert the ban BEHAVIOURALLY, not by grepping for the flag names. Both the
    // docstring and the mandatory MODE banner say the words "--record" and
    // "--update-baseline" precisely in order to state that the probe has
    // neither, and a text grep cannot tell an explanation from a use — the same
    // blindness that let ERR-230 hide four raw console.* inside an inline script.
    // What actually makes a probe unable to record is that it reads no flags and
    // writes no files, so pin that.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /process\.argv/,
        'READ-ONLY: this probe takes no flags at all, so there is no mode to get wrong');
    assert.doesNotMatch(code, /writeFileSync|createWriteStream|appendFileSync|\bfs\.write/,
        'a probe that can write may be green only because it overwrote what it compared against');
    assert.doesNotMatch(code, /\.route\(/,
        'a route handler re-issues requests outside the browser\'s own enforcement');
    // Positive controls, so the comment-stripper cannot pass everything by
    // stripping too much, and so "no writes" cannot be satisfied by "no code".
    assert.match(code, /chromium\.launch\(\)/, 'the stripped source must still contain the real code');
    assert.match(src, /MODE: READ-ONLY/, 'the mode must be PRINTED on every run, never assumed');
});
