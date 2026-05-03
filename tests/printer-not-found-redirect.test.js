/**
 * Printer-detail empty state — redirect contract
 * ================================================
 *
 * Pins the contract documented in
 *   readfirst/backend-passover.md
 *     ("Printer-detail empty state — verified, redirect on bad slug shipped")
 *
 * Why this exists: the backend's `sitemap-printers.xml` ships ~4,479 printer
 * slugs, and a non-trivial fraction are artefacts that either don't resolve
 * (`/api/products/printer/<slug>` → 404 NOT_FOUND) or fail backend-side slug
 * validation (`/api/products/printer/<bad-slug>` → 400 VALIDATION_FAILED on
 * the `^[a-z0-9_-]+$` regex once URL-decoded). Either way, the user lands
 * on /shop?printer_slug=<bad>; the page MUST redirect to /shop, not surface
 * a misleading "Failed to load products. Please try again." which looks
 * broken on retry.
 *
 * The fix lives in `js/shop-page.js` `loadPrinterProducts`. This test
 * verifies three layers of the contract:
 *
 *   1. The two predicates exist and are wired into the loader —
 *      `isPrinterNotFound(err)` (matches thrown 404s) and
 *      `isBadPrinterSlug(resp)` (matches `{ ok:false, code:NOT_FOUND|VALIDATION_FAILED }`).
 *   2. `window.location.replace('/shop')` is reachable from each of the
 *      three call-sites: inner-try 404, post-retry response shape, outer catch.
 *   3. The api.js layer actually produces those error shapes for those
 *      backend responses (so the predicates catch real traffic).
 *
 * Run with: node --test tests/printer-not-found-redirect.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHOP_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — predicates and redirect call-sites are present in shop-page.js
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — defines isPrinterNotFound predicate matching NOT_FOUND error messages', () => {
    assert.match(SHOP_PAGE_JS, /const\s+isPrinterNotFound\s*=\s*\(err\)\s*=>/,
        'isPrinterNotFound predicate missing — see backend-passover.md "Printer-detail empty state"');
    // Regex must catch both the human message and the bare error code.
    assert.match(SHOP_PAGE_JS, /isPrinterNotFound[\s\S]{0,200}NOT_FOUND/,
        'isPrinterNotFound regex must include NOT_FOUND token (the bare error code from envelope.error.code)');
    assert.match(SHOP_PAGE_JS, /isPrinterNotFound[\s\S]{0,200}printer.{0,30}not found/i,
        'isPrinterNotFound regex must match "Printer model not found" (the human message api.js throws)');
});

test('shop-page.js — defines isBadPrinterSlug predicate matching NOT_FOUND and VALIDATION_FAILED response codes', () => {
    assert.match(SHOP_PAGE_JS, /const\s+isBadPrinterSlug\s*=\s*\(resp\)\s*=>/,
        'isBadPrinterSlug predicate missing — needed for VALIDATION_FAILED responses that api.js returns rather than throws');
    const predicateBody = SHOP_PAGE_JS.match(/const\s+isBadPrinterSlug[\s\S]{0,300}/)[0];
    assert.match(predicateBody, /NOT_FOUND/,
        'isBadPrinterSlug must check for code === NOT_FOUND');
    assert.match(predicateBody, /VALIDATION_FAILED/,
        'isBadPrinterSlug must check for code === VALIDATION_FAILED');
    assert.match(predicateBody, /resp\.ok\s*===\s*false|ok\s*===\s*false/,
        'isBadPrinterSlug must guard on resp.ok === false (a 200 response with these codes would be a backend bug, not a missing printer)');
});

test('shop-page.js — loadPrinterProducts redirects to /shop on bad printer slug from each of the three failure paths', () => {
    // Extract the loadPrinterProducts function body so we don't false-match
    // redirects belonging to other loaders (loadPrinterModelProducts etc).
    const fn = extractFunction(SHOP_PAGE_JS, 'loadPrinterProducts');
    assert.ok(fn, 'loadPrinterProducts function not found in shop-page.js');

    const replaceMatches = fn.match(/window\.location\.replace\(\s*['"`]\/shop['"`]\s*\)/g) || [];
    assert.equal(replaceMatches.length, 3,
        `loadPrinterProducts must contain exactly 3 redirects to /shop (inner-try 404, post-retry bad-slug response, outer-catch 404). Found ${replaceMatches.length}.`);

    // The inner-try catch must short-circuit on NOT_FOUND BEFORE the 800ms
    // retry — retrying a 404 is wasted latency on every bad sitemap URL.
    const innerCatch = fn.match(/catch\s*\(\s*firstErr\s*\)[\s\S]*?await new Promise/);
    assert.ok(innerCatch, 'inner-try catch (firstErr) → 800ms retry block missing');
    assert.match(innerCatch[0], /isPrinterNotFound\(firstErr\)[\s\S]*?window\.location\.replace\(['"`]\/shop['"`]\)[\s\S]*?return/,
        'inner-try catch must redirect-and-return on NOT_FOUND BEFORE the 800ms retry — otherwise every bad sitemap URL costs an extra cold-start round-trip');

    // After the retry/response is settled, isBadPrinterSlug(response) must
    // run BEFORE the response.ok branch — otherwise a VALIDATION_FAILED
    // (which is response.ok === false) would fall through to "Failed to load".
    const responseHandling = fn.match(/if\s*\(navVersion[\s\S]{0,100}navigationVersion[\s\S]{0,100}\)[\s\S]{0,400}?if\s*\(\s*response\.ok/);
    assert.ok(responseHandling, 'response handling block (nav-version guard → response.ok branch) not found');
    assert.match(responseHandling[0], /isBadPrinterSlug\(response\)[\s\S]*?window\.location\.replace\(['"`]\/shop['"`]\)/,
        'isBadPrinterSlug check must redirect BEFORE the response.ok branch — otherwise VALIDATION_FAILED falls through to "Failed to load compatible products"');

    // The outer catch must redirect on NOT_FOUND too. (The retry call inside
    // the try will throw a fresh 404 on the second attempt; we don't want
    // that thrown error to surface as "Failed to load products. Please try
    // again." either.)
    const outerCatch = fn.match(/}\s*catch\s*\(\s*error\s*\)\s*{[\s\S]*$/);
    assert.ok(outerCatch, 'outer catch (error) block not found');
    assert.match(outerCatch[0], /isPrinterNotFound\(error\)[\s\S]*?window\.location\.replace\(['"`]\/shop['"`]\)/,
        'outer catch must redirect on NOT_FOUND — otherwise a 404 raised by the retry call surfaces as "Failed to load products. Please try again."');
});

test('shop-page.js — loadPrinterProducts retains a "Please try again" empty state for genuine network failures', () => {
    // Regression guard: the redirect should not have *replaced* the existing
    // "Failed to load" empty state — that's still the right UX for actual
    // 5xx / network failures (cold-start on Render, dropped connection).
    const fn = extractFunction(SHOP_PAGE_JS, 'loadPrinterProducts');
    assert.match(fn, /Failed to load products\. Please try again\./,
        'outer catch must still showEmpty("Failed to load products. Please try again.") for non-NOT_FOUND errors — only NOT_FOUND redirects');
    assert.match(fn, /Failed to load compatible products for this printer\./,
        'response.ok === false (non-NOT_FOUND, non-VALIDATION_FAILED) must still surface a clear empty message — only the slug-validation codes redirect');
});

test('shop-page.js — "No compatible products found for this printer." stays for valid-slug-but-no-products case', () => {
    // The third real case from the live-API audit: backend returns 200 with
    // a real `printer` object but `compatible_products: []`. That's NOT a
    // bad slug — it's an obscure printer with no SKUs in the catalog yet.
    // The clean empty-state message stays (the redirect would lose context).
    const fn = extractFunction(SHOP_PAGE_JS, 'loadPrinterProducts');
    assert.match(fn, /No compatible products found for this printer\./,
        'valid-slug, zero-products empty state must stay — that is not a "bad slug" case and should not redirect');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — api.js produces the error shapes that the predicates catch
// ─────────────────────────────────────────────────────────────────────────────

test('api.js — getProductsByPrinter returns { ok:false, code:NOT_FOUND } on backend 404 (does NOT throw)', async () => {
    // api.js special-cases 404/NOT_FOUND as a returned envelope rather
    // than a thrown Error (line ~243), so callers can branch on `code`
    // without try/catch. shop-page.js's `isBadPrinterSlug` catches this
    // shape and redirects to /shop. (Defense-in-depth: shop-page.js
    // ALSO checks `isPrinterNotFound(err)` in case a future api.js
    // change reverts to throwing.)
    const { API } = loadApi({
        fetchImpl: async (url) => {
            assert.match(url, /\/api\/products\/printer\/totally-fake-printer-12345$/,
                'URL must encode the slug as a single path segment');
            return mockResponse({
                status: 404,
                body: { ok: false, error: { code: 'NOT_FOUND', message: 'Printer model not found' } },
            });
        },
    });
    const resp = await API.getProductsByPrinter('totally-fake-printer-12345');
    assert.equal(resp.ok, false, '404 must return ok:false');
    assert.equal(resp.code, 'NOT_FOUND',
        'response.code must be NOT_FOUND so isBadPrinterSlug catches it and redirects to /shop');
});

test('api.js — getProductsByPrinter returns { ok:false, code:VALIDATION_FAILED } on backend 400 (does NOT throw)', async () => {
    // VALIDATION_FAILED is a special-case in api.js (line ~217) that returns
    // an envelope rather than throwing — preserves the per-field details so
    // form-style callers can render them. shop-page.js relies on that
    // contract: bad printer slugs (e.g. URL-decoded "$") come through
    // here, not through the catch block.
    const { API } = loadApi({
        fetchImpl: async () => mockResponse({
            status: 400,
            body: {
                ok: false,
                error: {
                    code: 'VALIDATION_FAILED',
                    message: 'Validation failed',
                    details: [{ field: 'printerSlug', message: 'Printer slug must contain only lowercase letters, numbers, hyphens, and underscores' }],
                },
            },
        }),
    });
    const resp = await API.getProductsByPrinter('acroprint-$100works');
    assert.equal(resp.ok, false, 'VALIDATION_FAILED must return ok:false (not throw)');
    assert.equal(resp.code, 'VALIDATION_FAILED', 'response.code must be VALIDATION_FAILED so isBadPrinterSlug catches it');
});

test('api.js — getProductsByPrinter URL-encodes the slug so chars like "$" survive transit instead of breaking the request line', () => {
    // `acroprint-$100works` came through URLSearchParams.get() decoded;
    // shoving it raw into the URL path would land the backend "$" in the
    // raw request URL (parsed differently by Express vs Node http parser).
    // Encoding it is the only way to surface VALIDATION_FAILED cleanly,
    // which is then caught by isBadPrinterSlug.
    const apiSrc = fs.readFileSync(API_JS_PATH, 'utf8');
    const fn = extractFunction(apiSrc, 'getProductsByPrinter');
    assert.match(fn, /encodeURIComponent\(printerSlug\)/,
        'getProductsByPrinter must encodeURIComponent(printerSlug) — otherwise special chars from URLSearchParams.get() break the request');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — predicate behavior on representative inputs
// ─────────────────────────────────────────────────────────────────────────────

test('predicates — isPrinterNotFound matches both human-message and code-only error strings, ignores unrelated', () => {
    // Re-construct the predicate by extracting it from the source. This
    // guarantees we test the actual regex shipping, not a re-implementation
    // that could drift.
    const isPrinterNotFound = extractPredicate(SHOP_PAGE_JS, 'isPrinterNotFound');

    // Real backend message (api.js builds errorMsg from envelope.error.message).
    assert.equal(isPrinterNotFound(new Error('Printer model not found')), true);
    // Bare error code if a future backend change shortens the message.
    assert.equal(isPrinterNotFound(new Error('NOT_FOUND')), true);
    // Detailed message (api.js appends details with `: ` for some codes).
    assert.equal(isPrinterNotFound(new Error('Printer model not found: details here')), true);
    // Mixed-case (regex is /i).
    assert.equal(isPrinterNotFound(new Error('printer not found')), true);

    // Genuine network failure — must NOT redirect.
    assert.equal(isPrinterNotFound(new Error('Failed to fetch')), false);
    // Cold-start 503.
    assert.equal(isPrinterNotFound(new Error('The server is temporarily unavailable. Please try again in a moment.')), false);
    // Null / undefined / empty (can happen in race conditions).
    assert.equal(isPrinterNotFound(null), false);
    assert.equal(isPrinterNotFound(undefined), false);
    assert.equal(isPrinterNotFound(new Error('')), false);
});

test('predicates — isBadPrinterSlug matches NOT_FOUND/VALIDATION_FAILED envelopes only when ok === false', () => {
    const isBadPrinterSlug = extractPredicate(SHOP_PAGE_JS, 'isBadPrinterSlug');

    // Real backend shape that triggers the redirect.
    assert.equal(isBadPrinterSlug({ ok: false, code: 'NOT_FOUND' }), true);
    assert.equal(isBadPrinterSlug({ ok: false, code: 'VALIDATION_FAILED', details: [] }), true);

    // The negative cases are checked for falsiness — the predicate short-
    // circuits with `&&`, so it returns the first falsy operand (null,
    // undefined, false) rather than the boolean `false`. The caller uses
    // `if (isBadPrinterSlug(resp))` so any falsy is correct behavior.
    assert.ok(!isBadPrinterSlug({ ok: true, data: { printer: {}, products: [] } }), '200 OK must not redirect');
    assert.ok(!isBadPrinterSlug({ ok: false, code: 'RATE_LIMITED' }), 'RATE_LIMITED must not redirect (it falls through to "Failed to load")');
    assert.ok(!isBadPrinterSlug({ ok: false, code: 'UNAUTHORIZED' }), 'UNAUTHORIZED must not redirect');
    assert.ok(!isBadPrinterSlug({ ok: false, error: 'something' }), 'unstructured error envelope must not redirect');
    // Defensively: if api.js ever drops the code field on a NOT_FOUND, we
    // must NOT match (that's a contract bug worth surfacing, not papering
    // over).
    assert.ok(!isBadPrinterSlug({ ok: false }), 'ok:false without a code must not redirect — surfacing a contract bug is more useful than silently masking it');
    assert.ok(!isBadPrinterSlug(null), 'null resp must not redirect');
    assert.ok(!isBadPrinterSlug(undefined), 'undefined resp must not redirect');
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a method body by name from a JS source string. This codebase uses
 * the big object-literal pattern in `shop-page.js` (8-space indent inside
 * an IIFE-wrapped App object) and `api.js` (4-space indent on the API
 * object). Both end methods with `},` on its own line at the same indent.
 * We anchor on the indent we discover at the header — a full JS tokenizer
 * is overkill for the assertions we need.
 *
 *   <indent> [async] <name>(args) { ... <indent> }, (or } at end-of-object)
 *
 * Returns null if the method can't be located.
 */
function extractFunction(src, name) {
    // Header: optional `async`, the method name, parens, opening brace.
    // Negative lookbehind on `.` and `\w` rules out call sites (`this.NAME(`).
    const headerRe = new RegExp(
        `(?<![.\\w])(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`,
        'gm',
    );
    let m;
    while ((m = headerRe.exec(src)) !== null) {
        // Require the match to be at the start of its own line (modulo
        // indent + optional `async `). Discover the indent width from this
        // line so we can locate the matching close at the same column.
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const linePrefix = src.slice(lineStart, m.index);
        const prefixMatch = linePrefix.match(/^( +)(?:async\s+)?$/);
        if (!prefixMatch) continue;
        const indent = prefixMatch[1];

        // Find the closing `},` (or `}` at end-of-object) at the same indent.
        const after = m.index + m[0].length;
        const closeRe = new RegExp(`\\n${indent}\\}(?:,|\\s*$)`, 'm');
        const tail = src.slice(after);
        const closeMatch = tail.match(closeRe);
        if (!closeMatch) continue;
        const end = after + closeMatch.index + closeMatch[0].indexOf('}') + 1;
        return src.slice(m.index, end);
    }
    return null;
}

/**
 * Extract a predicate (`const NAME = (arg) => ...;`) from JS source and
 * eval it back into a function we can call directly. This means the test
 * exercises the *exact regex* shipping in shop-page.js — no re-implementation.
 */
function extractPredicate(src, name) {
    // Match `const NAME = (arg) => <expr>;` — single-line arrow, no braces.
    const re = new RegExp(`const\\s+${name}\\s*=\\s*(\\(\\s*\\w+\\s*\\)\\s*=>\\s*[^\\n;]+)`);
    const m = src.match(re);
    if (!m) throw new Error(`predicate "${name}" not found as single-line arrow function in source`);
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]};`)();
}

/**
 * Load api.js into a vm sandbox with a fakeable fetch — same pattern as
 * tests/api-getproduct-fallback.test.js, copied so this test file is
 * self-contained.
 */
function loadApi({ fetchImpl } = {}) {
    const calls = [];
    const fetchSpy = async (url, opts) => {
        calls.push({ url, opts });
        return fetchImpl(url, opts, calls);
    };
    const sandbox = {
        console,
        fetch: fetchSpy,
        setTimeout,
        clearTimeout,
        AbortController,
        Headers: globalThis.Headers,
        URL,
        URLSearchParams,
        encodeURIComponent,
        Map,
        Promise,
        Date,
        JSON,
        Error,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Symbol,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: {
            _data: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
            setItem(k, v) { this._data[k] = String(v); },
            removeItem(k) { delete this._data[k]; },
        },
        document: { cookie: '' },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(API_JS_PATH, 'utf8'), ctx, { filename: 'api.js' });
    return { API: sandbox.API, calls };
}

function mockResponse({ status = 200, body = {}, ok }) {
    return {
        ok: ok != null ? ok : (status >= 200 && status < 300),
        status,
        headers: { get: () => null },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}
