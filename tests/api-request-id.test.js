/**
 * API error correlation contract — request_id propagation
 * ========================================================
 *
 * Backend (Render) emits an `x-request-id` UUID on every response. The
 * dev's stderr lines look like `Newsletter subscribe error: <stack>` —
 * grep-able only if the customer reports a correlation id.
 *
 * This test pins:
 *
 *   1. api.js `request()` reads `x-request-id` from response headers.
 *   2. Every error-envelope branch that can return `{ ok: false }` also
 *      threads `request_id` through (via the `withRid()` helper).
 *   3. The 5xx branch returns a structured envelope (does NOT throw a
 *      generic Error) so callers can show the friendly message + ref id.
 *   4. Thrown Errors from `request()` carry `error.request_id`.
 *   5. `mapError()` produces an `INTERNAL_ERROR` message that includes
 *      the short reference id when available.
 *   6. `landing.js` newsletter handler routes 5xx responses through
 *      mapError and logs the request_id to console for screenshot capture.
 *   7. `contact-page.js` shows the short reference id on a 500 fallback.
 *
 * Run with: node --test tests/api-request-id.test.js
 *
 * Why this exists: a customer-reported "newsletter subscribe broke" was
 * unrecoverable in stderr because we couldn't tie any log line to a user.
 * If this test ever fails, log correlation will silently degrade and the
 * next 500 will be just as undebuggable.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const vm     = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS   = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (p)   => fs.readFileSync(p, 'utf8');

const API_SRC      = READ(JS('api.js'));
const LANDING_SRC  = READ(JS('landing.js'));
const CONTACT_SRC  = READ(JS('contact-page.js'));

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Static guarantees: api.js wires x-request-id through every branch
// ─────────────────────────────────────────────────────────────────────────────

test('api.js reads x-request-id from response headers', () => {
    assert.match(
        API_SRC,
        /response\.headers\.get\(['"]x-request-id['"]\)/,
        'request() must capture x-request-id from response headers'
    );
});

test('api.js exposes a withRid helper inside the error branch', () => {
    assert.match(API_SRC, /const\s+withRid\s*=\s*\(env\)\s*=>/);
});

test('every {ok:false} return in the error branch is wrapped with withRid', () => {
    // Slice from `if (isError)` to the closing `throw` so we look only at the
    // error branch and ignore unrelated `{ok:false}` returns elsewhere in the
    // file (auth retries, etc).
    const start = API_SRC.indexOf('if (isError) {');
    assert.ok(start > -1, 'isError branch must exist');
    const branch = API_SRC.slice(start, start + 4000);

    // Count `return { ok: false` vs `return withRid({ ok: false`
    const bare    = branch.match(/return\s*\{\s*ok:\s*false/g) || [];
    const wrapped = branch.match(/return\s+withRid\(\{\s*ok:\s*false/g) || [];

    assert.equal(
        bare.length, 0,
        `Found ${bare.length} bare \`return { ok: false }\` in error branch — must use withRid()`
    );
    assert.ok(wrapped.length >= 8, `Expected ≥8 withRid-wrapped returns, got ${wrapped.length}`);
});

test('5xx branch returns an envelope (does not throw) with status + INTERNAL_ERROR fallback', () => {
    assert.match(
        API_SRC,
        /response\.status\s*>=\s*500[\s\S]{0,400}withRid\(\{[\s\S]{0,200}code:\s*errorCode\s*\|\|\s*['"]INTERNAL_ERROR['"]/,
        '5xx must return withRid({ ok:false, code: errorCode || "INTERNAL_ERROR", status })'
    );
});

test('thrown Errors from request() carry request_id, code, status', () => {
    // The final throw (after building fullMsg) must attach request_id.
    assert.match(
        API_SRC,
        /const\s+e\s*=\s*new\s+Error\(fullMsg\);[\s\S]{0,200}e\.request_id\s*=\s*requestId/
    );
    // The non-JSON 5xx throw also attaches request_id.
    assert.match(
        API_SRC,
        /temporarily unavailable[\s\S]{0,300}e\.request_id\s*=\s*requestId/
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Behavioural: load mapError into a sandbox and assert outputs
// ─────────────────────────────────────────────────────────────────────────────

function loadMapError() {
    // Sandbox-load just the mapError function. We extract by string slicing —
    // safer than evaling the whole file (which references DOM/window globals).
    const start = API_SRC.indexOf('mapError(errorOrResponse) {');
    assert.ok(start > -1, 'mapError must exist');
    // Find matching closing brace for the function. Counting braces is overkill;
    // mapError ends at the line `},` immediately followed by `showError(`.
    const end = API_SRC.indexOf('showError(errorOrResponse)', start);
    assert.ok(end > -1, 'showError must follow mapError');
    const fnSrc = API_SRC.slice(start, end).replace(/,\s*$/, '');
    const wrapper = `(function(){ const obj = { ${fnSrc} }; return obj.mapError; })()`;
    return vm.runInNewContext(wrapper);
}

test('mapError on INTERNAL_ERROR with request_id includes 8-char ref in message', () => {
    const mapError = loadMapError();
    const out = mapError({
        ok: false,
        code: 'INTERNAL_ERROR',
        error: 'database boom',
        request_id: 'a197fd7c-9493-4863-a2c5-31602a2cd8d3',
    });
    assert.equal(out.code, 'INTERNAL_ERROR');
    assert.match(out.message, /reference a197fd7c/, `expected ref in message, got: ${out.message}`);
    assert.equal(out.request_id, 'a197fd7c-9493-4863-a2c5-31602a2cd8d3');
});

test('mapError on INTERNAL_ERROR without request_id falls back gracefully', () => {
    const mapError = loadMapError();
    const out = mapError({ ok: false, code: 'INTERNAL_ERROR', error: 'boom' });
    assert.equal(out.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(out.message, /reference/);
    assert.match(out.message, /Server hiccup/);
    assert.equal(out.request_id, null);
});

test('mapError on a generic unknown code appends (ref XXXXXXXX) when request_id present', () => {
    const mapError = loadMapError();
    const out = mapError({
        ok: false,
        code: 'SOMETHING_ELSE',
        error: 'weird thing',
        request_id: 'deadbeef-cafe-1234-5678-9abcdef01234',
    });
    assert.match(out.message, /\(ref deadbeef\)/);
});

test('mapError reads request_id nested under .error too', () => {
    const mapError = loadMapError();
    const out = mapError({ code: 'INTERNAL_ERROR', error: { request_id: 'abc12345-xxxx' } });
    assert.match(out.message, /reference abc12345/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — Newsletter (landing.js) and contact form propagate the contract
// ─────────────────────────────────────────────────────────────────────────────

test('landing.js newsletter handler routes INTERNAL_ERROR through mapError', () => {
    assert.match(
        LANDING_SRC,
        /res\.code\s*===\s*['"]INTERNAL_ERROR['"][\s\S]{0,200}API\.mapError\(res\)\.message/,
        'newsletter must call API.mapError(res) for INTERNAL_ERROR responses'
    );
});

test('landing.js newsletter logs request_id to console.warn for screenshot capture', () => {
    assert.match(LANDING_SRC, /console\.warn\(\s*['"]\[newsletter\]\s+subscribe failed/);
    assert.match(LANDING_SRC, /request_id:\s*res\.request_id/);
});

test('landing.js newsletter catch block also logs request_id when err carries it', () => {
    assert.match(LANDING_SRC, /err\.request_id[\s\S]{0,200}console\.warn\(\s*['"]\[newsletter\]\s+subscribe threw/);
});

test('contact-page.js shows the short ref on the fetch fallback 500 path', () => {
    assert.match(
        CONTACT_SRC,
        /r\.status\s*>=\s*500[\s\S]{0,400}\(ref\s*'\s*\+\s*String\(rid\)\.slice\(0,\s*8\)/
    );
});

test('contact-page.js routes API.submitContactForm 5xx through mapError', () => {
    assert.match(
        CONTACT_SRC,
        /res\.code\s*===\s*['"]INTERNAL_ERROR['"][\s\S]{0,300}API\.mapError\(res\)/
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — No regression: we don't drop request_id on the legacy paths
// ─────────────────────────────────────────────────────────────────────────────

test('api.js DebugLog.warn includes request_id when available', () => {
    assert.match(
        API_SRC,
        /DebugLog\.warn\(['"]API Error:['"][^)]*requestId/,
        'API Error log must include request_id for diagnostic correlation'
    );
});
