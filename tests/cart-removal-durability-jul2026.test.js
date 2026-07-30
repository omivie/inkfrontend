/**
 * DURABLE CART REMOVALS — July 2026 (ERR-136)
 * ===========================================
 *
 * The incident
 * ------------
 * "Remove an item, refresh immediately, the item is back. Wait a few seconds
 * before refreshing and it stays removed."
 *
 * The backend half is fixed and deployed: every cart request used to make a
 * network round-trip to Supabase Auth (`auth.getUser`) before the delete SQL was
 * even issued, so `DELETE /api/cart/items/:productId` was slow enough that an
 * immediate refresh ABORTED the in-flight request before it committed. Cart
 * routes now verify the token locally against the project JWKS.
 *
 * That narrows the race. It does not close it, and it is not the only cause —
 * the frontend had a second, latency-independent path to the same symptom (see
 * §6).
 *
 * THE RULE THIS FILE EXISTS TO PROTECT
 * ------------------------------------
 * Correctness needs THREE independent mechanisms, and the tempting
 * "simplification" is to delete one as redundant. Each covers a hole the other
 * two cannot:
 *
 *   1. JOURNAL  — durability. The intent is written down BEFORE the request
 *      leaves, so it survives unload/crash/offline. It is the ONLY mechanism
 *      that covers a pre-dispatch abort: API.request() awaits getToken() (and
 *      may sit inside Auth.refreshSession()) before fetch is called, so
 *      `keepalive` has nothing to protect yet.
 *   2. FILTER   — correctness of every paint while an intent is unconfirmed.
 *      Between the journal write and the confirmation, localStorage AND the
 *      server both still contain the row.
 *   3. EPOCH GUARD — ordering. A GET issued before a mutation landed must never
 *      be adopted after it. Without this the fix is FLAKY rather than fixed:
 *      replay confirms, drops the journal entry, then an earlier in-flight GET
 *      resolves still carrying the item — the journal is now empty so the filter
 *      correctly no longer matches, and `this.items = parsed.items` puts it
 *      straight back and re-saves it.
 *
 * `keepalive: true` is a fourth, purely latency-side measure. It is not
 * load-bearing and must not be mistaken for the fix.
 *
 * Sections
 * --------
 *   §1  The pure core actually EXECUTES (parse/validate/plan/classify).
 *   §2  `removed` is never coerced — an unknown count is not zero.
 *   §3  keepalive + encodeURIComponent plumbing, behaviourally.
 *   §4  Ordering: the journal is written BEFORE the local mutation.
 *   §5  First paint is not delayed (ERR-121).
 *   §6  The filter is applied at every adoption AND every re-push site.
 *   §7  Every API.getCart() is epoch-guarded.
 *   §8  Bounded retries, and exhaustion is LOUD.
 *   §9  Identity: a removal is never replayed against another cart.
 *   §10 Rollback is surgical, never a whole-array snapshot.
 *   §11 Double-click cannot fire two DELETEs or hit the wrong row.
 *   §12 One quantity cap; debounced changes survive unload.
 *   §13 Lifecycle: sign-out, clear, order completion, bfcache.
 *   §14 Hygiene: one vocabulary, no raw console, escaped output.
 *
 * Run: node --test tests/cart-removal-durability-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const HTML = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = (rel) => fs.readFileSync(path.join(ROOT, 'css', rel), 'utf8');

/**
 * Strip comments so a literal inside a comment can't satisfy a source
 * assertion. Block comments first — the naive line-comment-first order eats the
 * `//` inside a URL and corrupts the rest of the file (the ERR-124 trap).
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CART_SRC = JS('cart.js');
const CART_CODE = stripComments(CART_SRC);
const API_SRC = JS('api.js');
const API_CODE = stripComments(API_SRC);
const MAIN_SRC = JS('main.js');
const MAIN_CODE = stripComments(MAIN_SRC);
const CART_HTML = HTML('html/cart.html');
const COMPONENTS_CSS = CSS('components.css');

/**
 * Slice one object-literal method out of a globals module: from its DECLARATION
 * to the line that closes it at method indentation.
 *
 * Anchored on a newline plus exactly four spaces, i.e. method indentation. A bare
 * `indexOf(signature)` finds the first CALL instead — `this.loadCart()`,
 * `this.bindEvents()` and `this.getGuestCartItems()` are all invoked earlier in
 * the file than they are declared — which silently slices the wrong method and
 * turns the assertion vacuous rather than failing it.
 *
 * Fixed-width windows have the same failure mode once a method grows a doc
 * comment, so the end is found by brace-column, not by length.
 */
function methodBody(src, signature) {
    const anchor = '\n    ' + signature;
    const start = src.indexOf(anchor);
    assert.notEqual(start, -1, `${signature} must exist as a declaration at method indentation`);
    // Nothing else in the file may declare it twice.
    assert.equal(src.indexOf(anchor, start + 1), -1,
        `${signature} must be declared exactly once`);
    const end = src.indexOf('\n    },', start + 1);
    const body = src.slice(start, end === -1 ? src.length : end);
    assert.ok(body.length > 40, `sanity: ${signature} body was located, got ${body.length} chars`);
    return body;
}

/** The doc comment immediately preceding a declaration. */
function docCommentFor(src, signature) {
    const start = src.indexOf('\n    ' + signature);
    assert.notEqual(start, -1, `${signature} must exist`);
    const open = src.lastIndexOf('/**', start);
    assert.notEqual(open, -1, `${signature} must carry a doc comment`);
    return src.slice(open, start);
}

/**
 * Execute the pure core for real.
 *
 * The five decision functions plus their constants live at cart.js top level,
 * immediately before `const Cart = {`, precisely so they can be run rather than
 * pattern-matched. Evaluated in THIS realm so returned Arrays/Objects are
 * host-native and deepEqual works.
 */
function loadDurabilityCore() {
    const start = CART_SRC.indexOf('const PENDING_OPS_KEY = ');
    assert.notEqual(start, -1,
        'the pending-op journal constants must be declared at cart.js top level');
    const end = CART_SRC.indexOf('const Cart = {', start);
    assert.notEqual(end, -1, '`const Cart = {` must follow the pure core');
    const block = CART_SRC.slice(start, end);
    assert.ok(block.length > 2000, 'sanity: the pure core block was located');

    const factory = new Function('window', 'DebugLog', block + `
        return {
            PENDING_OPS_KEY, PENDING_OP_VERSION, MAX_PENDING_OP_ATTEMPTS,
            MAX_PENDING_OP_DEFERRALS, PENDING_OP_MAX_AGE_MS, MAX_PENDING_OPS,
            makePendingRemoval, readPendingOps, isPendingRemoved,
            planPendingReplay, classifyRemovalOutcome
        };`);
    return factory(undefined, { log() {}, warn() {}, error() {}, info() {} });
}

/**
 * Load the real API object into a vm sandbox with a RECORDING fetch, so the
 * keepalive/escaping tests exercise the live implementation instead of a copy.
 * api.js is a globals module, so pointing `window` at the sandbox works.
 */
function loadAPI(onFetch) {
    const calls = [];
    const sandbox = {
        console,
        Map, Set, Promise, Date, JSON, Error, Object, Array,
        String, Number, Boolean, RegExp, Math, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
        structuredClone: (v) => JSON.parse(JSON.stringify(v)),
        fetch: (url, init) => {
            calls.push({ url, init });
            return Promise.resolve(onFetch ? onFetch(url, init) : {
                ok: true, status: 200,
                headers: { get: () => null },
                json: () => Promise.resolve({ ok: true, data: { message: 'ok', removed: 1 } })
            });
        },
        AbortController: class { constructor() { this.signal = {}; } abort() {} },
        Headers: class { constructor() { this._m = new Map(); } has() { return false; } get() { return null; } set() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ setAttribute() {}, classList: { add() {} } }) },
        location: { hostname: 'localhost', search: '', pathname: '/' },
        navigator: { userAgent: 'node', onLine: true },
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
        Config: { API_URL: 'https://api.example.test', ITEMS_PER_PAGE: 20, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', settings: {} },
        Auth: undefined,
        window: {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInContext(API_SRC, vm.createContext(sandbox), { filename: 'api.js' });
    assert.ok(sandbox.API && typeof sandbox.API === 'object', 'api.js must define a global API object');
    return { API: sandbox.API, calls };
}

const rec = (over) => Object.assign({
    v: 1, op: 'remove', id: 'p1', key: 'core:SKU1', sku: 'SKU1', name: 'Item One',
    qty: 1, idx: 0, auth: false, uid: null, sid: 's1',
    at: 1000, attempts: 0, deferrals: 0, lastAt: 0
}, over || {});

// ─────────────────────────────────────────────────────────────────────────────
// §1 — The pure core actually executes
// ─────────────────────────────────────────────────────────────────────────────

test('§1.1 makePendingRemoval captures identity, index and quantity', () => {
    const C = loadDurabilityCore();
    const r = C.makePendingRemoval(
        { id: 'abc', key: 'core:X1', sku: 'X1', name: 'Cartridge X1', quantity: 3 },
        { idx: 2, authenticated: true, uid: 'u9', sid: 'ignored', now: 5000 }
    );
    assert.equal(r.v, C.PENDING_OP_VERSION);
    assert.equal(r.op, 'remove', 'op is reserved so a future setQty/clear cannot be misread');
    assert.equal(r.id, 'abc');
    assert.equal(r.key, 'core:X1');
    assert.equal(r.qty, 3, 'quantity is kept so an honest restore is possible');
    assert.equal(r.idx, 2, 'index is kept so rollback can be surgical');
    assert.equal(r.auth, true);
    assert.equal(r.uid, 'u9');
    assert.equal(r.sid, null, 'an authenticated record must not carry a guest sid');
    assert.equal(r.at, 5000);
    assert.equal(r.attempts, 0);
    assert.equal(r.deferrals, 0);

    const g = C.makePendingRemoval({ id: 'd', key: 'core:D' }, { authenticated: false, sid: 'sess', now: 1 });
    assert.equal(g.auth, false);
    assert.equal(g.uid, null);
    assert.equal(g.sid, 'sess', 'a guest record must carry the sid it was authored under');
    assert.equal(g.qty, 1, 'a missing quantity defaults to 1, never 0 or NaN');
});

test('§1.2 readPendingOps drops anything it cannot honour, and never throws', () => {
    const C = loadDurabilityCore();

    // Corrupt JSON must not throw on a first-paint path.
    const corrupt = C.readPendingOps('{not json', 0);
    assert.deepEqual(corrupt.records, []);
    assert.equal(corrupt.dropped[0].reason, 'corrupt');

    assert.deepEqual(C.readPendingOps(null, 0).records, []);
    assert.deepEqual(C.readPendingOps('', 0).records, []);
    assert.equal(C.readPendingOps('{"v":1}', 0).dropped[0].reason, 'corrupt',
        'an object with no ops array is corrupt, not silently empty');

    // Unknown version / unknown op are dropped, never guessed at.
    const mixed = C.readPendingOps(JSON.stringify({
        v: 1,
        ops: [rec(), rec({ id: 'p2', key: 'core:S2', v: 99 }), rec({ id: 'p3', key: 'core:S3', op: 'setQty' })]
    }), 0);
    assert.equal(mixed.records.length, 1, 'only the well-formed record survives');
    assert.deepEqual(mixed.dropped.map((d) => d.reason).sort(), ['unsupported_op', 'version']);

    // Missing id cannot address a DELETE.
    assert.equal(C.readPendingOps(JSON.stringify({ v: 1, ops: [rec({ id: null })] }), 0).records.length, 0);
    // Missing/zero timestamp defeats the age cap.
    assert.equal(C.readPendingOps(JSON.stringify({ v: 1, ops: [rec({ at: 0 })] }), 0).records.length, 0);
});

test('§1.3 readPendingOps age-sweeps, so an expired intent can never replay even once', () => {
    const C = loadDurabilityCore();
    // Must exceed the age cap, or `at` goes negative and the record is rejected as
    // malformed instead — which would pass for the wrong reason.
    const now = C.PENDING_OP_MAX_AGE_MS * 3;
    const fresh = rec({ at: now - 1000 });
    const stale = rec({ id: 'p2', key: 'core:S2', at: now - C.PENDING_OP_MAX_AGE_MS - 1 });

    const out = C.readPendingOps(JSON.stringify({ v: 1, ops: [fresh, stale] }), now);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].id, 'p1');
    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0].reason, 'expired');
    assert.ok(C.PENDING_OP_MAX_AGE_MS > 0, 'the age cap must be a real positive bound');
});

test('§1.4 readPendingOps enforces the attempt, deferral and size caps', () => {
    const C = loadDurabilityCore();

    assert.equal(
        C.readPendingOps(JSON.stringify({ v: 1, ops: [rec({ attempts: C.MAX_PENDING_OP_ATTEMPTS })] }), 0).dropped[0].reason,
        'attempts_exhausted', 'a record cannot be retried forever');
    assert.equal(
        C.readPendingOps(JSON.stringify({ v: 1, ops: [rec({ deferrals: C.MAX_PENDING_OP_DEFERRALS })] }), 0).dropped[0].reason,
        'deferrals_exhausted');

    // Overflow drops the OLDEST, so a pathological loop cannot eat the quota.
    const many = [];
    for (let i = 0; i < C.MAX_PENDING_OPS + 5; i++) {
        many.push(rec({ id: 'p' + i, key: 'core:S' + i, at: 1000 + i }));
    }
    const out = C.readPendingOps(JSON.stringify({ v: 1, ops: many }), 0);
    assert.equal(out.records.length, C.MAX_PENDING_OPS);
    assert.equal(out.dropped.length, 5);
    assert.ok(out.dropped.every((d) => d.reason === 'overflow'));
    const survivingAts = out.records.map((r) => r.at);
    assert.equal(Math.min(...survivingAts), 1005, 'the five oldest are the ones dropped');
});

test('§1.5 isPendingRemoved is KEY-FIRST — a cross-sell removal cannot hide the core row', () => {
    const C = loadDurabilityCore();
    const coreRec = [rec({ key: 'core:SKU1', id: 'p1' })];

    assert.equal(C.isPendingRemoved({ id: 'p1', key: 'core:SKU1' }, coreRec), true,
        'exact key match');
    assert.equal(C.isPendingRemoved({ id: 'p1', key: 'cross-sell:SKU1' }, coreRec), false,
        'THE REGRESSION THIS PINS: same product id, different line — must NOT match');
    assert.equal(C.isPendingRemoved({ id: 'p2', key: 'core:SKU2' }, coreRec), false);

    // And the reverse direction.
    const xsRec = [rec({ key: 'cross-sell:SKU1', id: 'p1' })];
    assert.equal(C.isPendingRemoved({ id: 'p1', key: 'core:SKU1' }, xsRec), false);

    // When either side has no key, the product id is the best evidence available
    // and filtering is the safer failure — it matches the shopper's intent.
    assert.equal(C.isPendingRemoved({ id: 'p1' }, coreRec), true);
    assert.equal(C.isPendingRemoved({ id: 'p1', key: 'core:SKU1' }, [rec({ key: null })]), true);

    assert.equal(C.isPendingRemoved(null, coreRec), false, 'never throws on a null row');
    assert.equal(C.isPendingRemoved({ id: 'p1' }, []), false);
    assert.equal(C.isPendingRemoved({ id: 'p1' }, null), false);
});

test('§1.6 planPendingReplay never aims a removal at a cart it does not own', () => {
    const C = loadDurabilityCore();
    const authed = (over) => rec(Object.assign({ auth: true, uid: 'u1', sid: null }, over));

    // Authenticated, same user -> replay.
    let p = C.planPendingReplay([authed()], { authenticated: true, uid: 'u1' });
    assert.equal(p.replay.length, 1);

    // Authenticated, DIFFERENT user -> dropped. Never mutate another user's cart.
    p = C.planPendingReplay([authed()], { authenticated: true, uid: 'u2' });
    assert.equal(p.replay.length, 0);
    assert.equal(p.drop[0].reason, 'other_user');

    // Signed out -> DEFERRED, not dropped. The row is still in that user's
    // server cart, so it becomes deliverable again on sign-in. This is why the
    // SIGNED_OUT handler must not purge the journal.
    p = C.planPendingReplay([authed()], { authenticated: false, sid: 'whatever' });
    assert.equal(p.defer[0].reason, 'signed_out');
    assert.equal(p.drop.length, 0);

    // Guest with the SAME sid -> replay.
    p = C.planPendingReplay([rec({ sid: 's1' })], { authenticated: false, sid: 's1' });
    assert.equal(p.replay.length, 1);

    // Guest whose sid is gone/rotated -> dropped. That cart is unreachable from
    // this browser (no token => credentials:'omit' => the httpOnly guest cookie
    // never rides along), so the intent is unsatisfiable AND harmless.
    for (const now of [{ authenticated: false, sid: 's2' }, { authenticated: false, sid: null }]) {
        p = C.planPendingReplay([rec({ sid: 's1' })], now);
        assert.equal(p.replay.length, 0);
        assert.equal(p.drop[0].reason, 'guest_session_gone');
    }

    // Guest record, now signed in: deferred until the merge, replayed after it.
    p = C.planPendingReplay([rec()], { authenticated: true, uid: 'u1' });
    assert.equal(p.defer[0].reason, 'awaiting_merge',
        'the merge copies the un-deleted row into the user cart — replay must follow it');
    p = C.planPendingReplay([rec()], { authenticated: true, uid: 'u1', retarget: true });
    assert.equal(p.replay.length, 1);
});

test('§1.7 classifyRemovalOutcome — the whole truth table', () => {
    const C = loadDurabilityCore();
    const call = (resp, err, opts) => C.classifyRemovalOutcome(resp, err, opts);
    const ok = (removed) => ({ ok: true, data: removed === undefined ? {} : { removed } });

    // Success shapes.
    assert.equal(call(ok(1), null, {}), 'confirmed');
    assert.equal(call(ok(3), null, {}), 'confirmed');

    // 204 -> {ok:true,data:null}. `removed` is NOT reported. Never read as 0.
    assert.equal(call({ ok: true, data: null }, null, {}), 'confirmed_unverified');
    // Field absent entirely (older deploy) — non-breaking, still not 0.
    assert.equal(call(ok(undefined), null, {}), 'confirmed_unverified');
    assert.equal(call({ ok: true, data: { removed: 'x' } }, null, {}), 'confirmed_unverified',
        'a non-numeric count is unknown, not zero');

    // removed:0 — the fresh/replay distinction is the point.
    assert.equal(call(ok(0), null, { replay: false }), 'confirmed_unverified',
        'FRESH 0 may mean "resolved against a different cart" — must be verified, not terminal');
    assert.equal(call(ok(0), null, { replay: true }), 'absent',
        'REPLAYED 0 is the correct idempotent outcome, not an error');

    // Rejections and transients.
    assert.equal(call({ ok: false, code: 'NOT_FOUND' }, null, {}), 'absent');
    assert.equal(call({ ok: false, status: 404 }, null, {}), 'absent');
    assert.equal(call({ ok: false, code: 'UNAUTHORIZED' }, null, {}), 'defer');
    assert.equal(call({ ok: false, status: 401 }, null, {}), 'defer');
    assert.equal(call({ ok: false, code: 'FORBIDDEN' }, null, {}), 'reject');
    assert.equal(call({ ok: false, code: 'RATE_LIMITED' }, null, {}), 'defer');
    assert.equal(call({ ok: false, status: 500 }, null, {}), 'retry');
    assert.equal(call({ ok: false, code: 'WEIRD' }, null, {}), 'reject');

    // Thrown transport errors.
    const err = (over) => Object.assign(new Error('x'), over);
    assert.equal(call(null, err({ code: 'RATE_LIMITED' }), {}), 'defer');
    assert.equal(call(null, err({ status: 503 }), {}), 'retry');
    assert.equal(call(null, new TypeError('fetch failed'), { online: true }), 'retry');

    // OFFLINE must never burn the attempt budget.
    assert.equal(call(null, new TypeError('fetch failed'), { online: false }), 'defer');
    assert.equal(call({ ok: false, status: 500 }, null, { online: false }), 'defer');
    assert.equal(call(null, null, { online: false }), 'defer');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — `removed` is never coerced
// ─────────────────────────────────────────────────────────────────────────────

test('§2 an unknown `removed` count is never read as zero (the ERR-122 failure mode)', () => {
    assert.ok(/typeof\s+data\.removed\s*===\s*'number'/.test(CART_CODE) ||
              /typeof\s+\w+\.removed\s*===\s*'number'/.test(CART_CODE),
        'the count must be guarded with a typeof number check');

    for (const bad of [/removed\s*\?\?\s*0/, /removed\s*\|\|\s*0/, /Number\(\s*\w*\.?removed\s*\)/]) {
        assert.ok(!bad.test(CART_CODE),
            `cart.js must not coerce an unknown removed count: ${bad}`);
    }
    assert.ok(/removed === null/.test(CART_CODE),
        'the not-reported case must be handled explicitly as null');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — keepalive + encodeURIComponent, behaviourally
// ─────────────────────────────────────────────────────────────────────────────

test('§3.1 API.delete/put forward options, spread BEFORE method so the verb cannot be overridden', () => {
    const del = methodBody(API_SRC, 'async delete(endpoint');
    assert.ok(/async delete\(endpoint, options = \{\}\)/.test(del), 'delete must accept options');
    assert.ok(/\{ \.\.\.options, method: 'DELETE' \}/.test(del),
        'options must be spread BEFORE method');

    const put = methodBody(API_SRC, 'async put(endpoint');
    assert.ok(/async put\(endpoint, body, options = \{\}\)/.test(put), 'put must accept options');
    assert.ok(put.indexOf('...options') < put.indexOf("method: 'PUT'"),
        'options must be spread BEFORE method');
});

test('§3.2 request() does not strip keepalive on its way to fetch', () => {
    // The destructure exists to pull out request()-level flags. If `keepalive`
    // were ever added to it, every cart mutation would silently stop surviving
    // unload with no other visible symptom.
    const destructure = API_CODE.match(/const \{[^}]*\} = options;/);
    assert.ok(destructure, 'request() must destructure its request-level flags');
    assert.ok(!/keepalive/.test(destructure[0]),
        'keepalive must NOT be destructured out of the fetch options');
    assert.ok(/\.\.\.fetchOptions/.test(API_CODE),
        'the remaining options must be spread into fetch');
});

test('§3.3 removeFromCart really sends keepalive and a percent-encoded id', async () => {
    const { API, calls } = loadAPI();
    const res = await API.removeFromCart('a/b?c#d', { keepalive: true });

    assert.equal(calls.length, 1, 'exactly one request');
    assert.ok(calls[0].url.endsWith('/api/cart/items/a%2Fb%3Fc%23d'),
        `id must be percent-encoded, got: ${calls[0].url}`);
    assert.equal(calls[0].init.keepalive, true, 'keepalive must reach fetch');
    assert.equal(calls[0].init.method, 'DELETE');
    // And the envelope, including the new count, is handed back untouched.
    assert.equal(res.ok, true);
    assert.equal(res.data.removed, 1);
});

test('§3.4 updateCartItem escapes its id and forwards keepalive for the unload flush', async () => {
    const { API, calls } = loadAPI();
    await API.updateCartItem('x/y', 2, { keepalive: true });
    assert.ok(calls[0].url.endsWith('/api/cart/items/x%2Fy'), calls[0].url);
    assert.equal(calls[0].init.keepalive, true);
    assert.equal(calls[0].init.method, 'PUT');
});

test('§3.5 clearCart drops the guest sid ONLY on a confirmed clear', async () => {
    const body = { ok: true, data: { message: 'Cart cleared', removed: 0 } };
    const failing = () => ({
        ok: false, status: 500, headers: { get: () => null },
        json: () => Promise.resolve({ ok: false, error: 'boom' })
    });

    // Losing the sid after a FAILED delete orphans a still-populated guest cart:
    // the sid is the only handle this browser has on it.
    const bad = loadAPI(failing);
    let cleared = false;
    bad.API.clearGuestSessionId = () => { cleared = true; };
    await bad.API.clearCart().catch(() => {});
    assert.equal(cleared, false, 'a failed clear must NOT discard the guest session id');

    const good = loadAPI(() => ({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) }));
    let cleared2 = false;
    good.API.clearGuestSessionId = () => { cleared2 = true; };
    await good.API.clearCart();
    assert.equal(cleared2, true, 'a confirmed clear discards the sid as before');
});

test('§3.6 every cart mutation in cart.js passes keepalive', () => {
    assert.ok(/API\.removeFromCart\(actualId, \{ keepalive: true \}\)/.test(CART_CODE),
        'the fresh removal must be keepalive');
    assert.ok(/API\.removeFromCart\(rec\.id, \{ keepalive: true \}\)/.test(CART_CODE),
        'the replayed removal must be keepalive — the replay itself can be interrupted');
    assert.ok(/API\.updateCartItem\([^)]*\{ keepalive: true \}\)/.test(CART_CODE),
        'the unload-time quantity flush must be keepalive');
    assert.ok(/getCartCount/.test(API_SRC) === false,
        'dead API.getCartCount must be gone');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — Ordering: journal BEFORE the local mutation
// ─────────────────────────────────────────────────────────────────────────────

test('§4 removeItem journals the intent before it touches items or localStorage', () => {
    const body = methodBody(CART_SRC, 'async removeItem(itemId)');
    const journal = body.indexOf('_journalRemoval');
    const filter = body.indexOf('this.items = this.items.filter');
    const save = body.indexOf('this.saveToLocalStorage()');
    const request = body.indexOf('await API.removeFromCart');

    assert.ok(journal !== -1, 'removeItem must journal the intent');
    assert.ok(filter !== -1 && save !== -1 && request !== -1, 'sanity: the landmarks exist');
    assert.ok(journal < filter, 'the journal write must precede the local filter');
    assert.ok(journal < save, 'the journal write must precede saveToLocalStorage');
    assert.ok(save < request, 'the optimistic paint still precedes the request');
    assert.ok(journal < request, 'a crash before dispatch must still leave an intent to replay');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — First paint is not delayed (ERR-121)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 loadCart hydrates synchronously before first paint and never awaits the replay', () => {
    const body = methodBody(CART_SRC, 'async loadCart()');
    const hydrate = body.indexOf('_hydratePendingOps');
    const fromLocal = body.indexOf('this.loadFromLocalStorage()');
    const firstPaint = body.indexOf('this.updateUI()');
    const replay = body.indexOf('this.replayPendingOps');

    assert.ok(hydrate !== -1 && fromLocal !== -1 && firstPaint !== -1 && replay !== -1);
    assert.ok(hydrate < fromLocal, 'the journal must be read before the mirror is painted');
    assert.ok(fromLocal < firstPaint, 'sanity: localStorage still paints first');
    assert.ok(replay > firstPaint, 'the replay must be fanned out AFTER the first render');

    // The hydrate must not introduce an await ahead of the paint. Comments are
    // stripped first — the surrounding prose legitimately contains the word
    // "await", and matching that would make this assertion fail for a lie.
    const preamble = stripComments(body.slice(0, firstPaint));
    assert.ok(!/\bawait\b/.test(preamble),
        'nothing may be awaited between loadCart() entry and the first updateUI()');

    // And the replay must not be awaited in loadCart at all.
    assert.ok(!/await\s+this\.replayPendingOps/.test(stripComments(body)),
        'awaiting the replay would put a network round trip between paint and fan-out');

    // ...but in the post-merge flow it MUST be awaited, and in the right order.
    const merge = methodBody(CART_SRC, 'async mergeGuestCartAndLoad()');
    assert.ok(/await this\.replayPendingOps\(\{ reason: 'post-merge', retarget: true \}\)/.test(merge),
        'the post-merge replay must be awaited');
    assert.ok(merge.indexOf('API.mergeCart()') < merge.indexOf('await this.replayPendingOps'),
        'replay must follow the merge that copied the un-deleted row across');
    assert.ok(merge.indexOf('await this.replayPendingOps') < merge.indexOf('await this.loadFromServer()'),
        'replay must precede the reconciling GET, or the GET re-adopts the row');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — The filter is applied everywhere, including the re-push paths
// ─────────────────────────────────────────────────────────────────────────────

test('§6.1 every server-cart adoption site subtracts pending removals', () => {
    for (const sig of ['async loadFromServer()', 'async syncWithServer()', 'async loadCart()', 'loadFromLocalStorage()']) {
        const body = methodBody(CART_SRC, sig);
        assert.ok(/_filterPendingRemovals/.test(body),
            `${sig} must route its item list through _filterPendingRemovals`);
    }
});

test('§6.2 the two paths that push local state BACK to the server are filtered too', () => {
    // getGuestCartItems feeds loadCart's guest re-push loop. An unfiltered mirror
    // re-addToCart's a row the shopper just removed, resurrecting it INTO the
    // server — the reported symptom with no race involved at all.
    const guest = methodBody(CART_SRC, 'getGuestCartItems()');
    assert.ok(/_filterPendingRemovals/.test(guest),
        'getGuestCartItems must be filtered — it feeds API.addToCart');

    // The legacy migration loop in the merge has the same shape.
    const merge = methodBody(CART_SRC, 'async mergeGuestCartAndLoad()');
    assert.ok(/legacyItems = this\._filterPendingRemovals\(legacyItems\)/.test(merge),
        'legacy items must be filtered before they are re-added');
    assert.ok(merge.indexOf('_filterPendingRemovals(legacyItems)') < merge.indexOf('API.addToCart'),
        'the filter must precede the re-add');
});

test('§6.3 syncWithServer filters BEFORE its empty-cart guard', () => {
    const body = methodBody(CART_SRC, 'async syncWithServer()');
    const filter = body.indexOf('parsed.items = this._filterPendingRemovals(parsed.items)');
    const guard = body.indexOf('parsed.items.length === 0');
    assert.ok(filter !== -1 && guard !== -1);
    assert.ok(filter < guard,
        '"the server had items but all of them are pending removals" is a LEGITIMATELY empty ' +
        'cart; filtering after the guard takes the fallback branch and resurrects the local copy');
});

test('§6.4 there is exactly ONE filter implementation', () => {
    const decls = CART_CODE.match(/_filterPendingRemovals\s*\(items\)\s*\{/g) || [];
    assert.equal(decls.length, 1, 'the filter must be declared once, not reimplemented per caller');
    // The old in-flight-only inline filter must be gone.
    assert.ok(!/Cart\._removingItems\.has\(item\.id\) && !Cart\._removingItems\.has\(item\.key\)/.test(CART_CODE),
        'the inline _removingItems-only filter must be replaced by the shared one');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — Every API.getCart() is epoch-guarded
// ─────────────────────────────────────────────────────────────────────────────

test('§7.1 no API.getCart() call site can adopt a stale snapshot', () => {
    const gets = (CART_CODE.match(/API\.getCart\(\)/g) || []).length;
    // `this.`-prefixed so the declarations are not counted as uses.
    const begins = (CART_CODE.match(/this\._beginSnapshot\(\)/g) || []).length;
    const checks = (CART_CODE.match(/this\._snapshotStale\(/g) || []).length;

    assert.ok(gets >= 4, `sanity: expected the known getCart sites, found ${gets}`);
    assert.equal(begins, gets,
        `every API.getCart() must capture an epoch first (${gets} gets vs ${begins} captures) — ` +
        'a new call site cannot be added without one');
    assert.equal(checks, gets,
        `every API.getCart() must compare the epoch after (${gets} gets vs ${checks} checks)`);
});

test('§7.2 the epoch is bumped on every local mutation and every confirmation', () => {
    const bumps = (CART_CODE.match(/_mutationEpoch\+\+/g) || []).length;
    assert.ok(bumps >= 8, `expected the epoch to be bumped at every mutation site, found ${bumps}`);

    for (const sig of ['async removeItem(itemId)', 'async addItem(product)', 'async clear()',
                       'async updateQuantity(itemId, quantity)', '_debouncedQuantityUpdate: function(itemId, quantity)']) {
        assert.ok(/_mutationEpoch\+\+/.test(methodBody(CART_SRC, sig)),
            `${sig} must bump the mutation epoch`);
    }
});

test('§7.3 a stale snapshot is discarded, re-fetched a BOUNDED number of times, then declared honest', () => {
    const body = methodBody(CART_SRC, 'async _handleStaleSnapshot(where)');
    assert.ok(/_staleRefetches/.test(body), 'the refetch budget must be tracked');
    assert.ok(/_staleRefetches < 2/.test(body), 'the refetch budget must be bounded');
    assert.ok(/serverSummary = null/.test(body),
        'on exhaustion the UI must admit it has no server totals rather than invent them');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Bounded, and exhaustion is LOUD
// ─────────────────────────────────────────────────────────────────────────────

test('§8.1 replayPendingOps returns structured partial-ness, not a boolean', () => {
    const body = methodBody(CART_SRC, 'async _runPendingReplay(opts)');
    for (const key of ['attempted', 'confirmed', 'absent', 'deferred', 'dropped', 'failed']) {
        assert.ok(new RegExp(key + ':').test(body), `the summary must report \`${key}\``);
    }
    assert.ok(/failed\.push\(/.test(body), 'failures must be enumerated, not counted');
    assert.ok(/attempts_exhausted/.test(body) && /rejected/.test(body),
        'a failure must carry WHY it failed');
});

test('§8.2 a real attempt increments attempts; a deferral does not', () => {
    const body = methodBody(CART_SRC, 'async _runPendingReplay(opts)');
    const deferBlock = body.slice(body.indexOf("if (state === 'defer')"), body.indexOf("if (state === 'retry')"));
    assert.ok(/deferrals: rec\.deferrals \+ 1/.test(deferBlock), 'a deferral bumps deferrals');
    assert.ok(!/attempts: /.test(deferBlock),
        'offline/401/429 must NOT burn the attempt budget — they are not verdicts');
});

test('§8.3 exhaustion reconciles to the server and says so out loud', () => {
    const body = methodBody(CART_SRC, 'async _runPendingReplay(opts)');
    assert.ok(/await this\.loadFromServer\(\)/.test(body),
        'after a failure the UI must show the truth, not the optimistic guess');
    assert.ok(/still_present/.test(body),
        'an unverified drop must be checked against the reconciled cart');

    const notice = methodBody(CART_SRC, '_renderRemovalNotice(result)');
    assert.ok(/cart-removal-notice/.test(notice), 'there must be a durable inline channel');
    assert.ok(/showToast/.test(notice), 'plus a toast to draw attention');
    assert.ok(/Security\.escapeHtml/.test(notice), 'product names are dynamic — must be escaped');
    assert.ok(/failed\.length === 0/.test(notice),
        'the notice must be hidden when nothing failed — never flashed while merely in flight');
});

test('§8.4 the inline notice element exists on the cart page and starts hidden', () => {
    assert.ok(/id="cart-removal-notice"/.test(CART_HTML), 'the notice element must exist');
    const el = CART_HTML.match(/<p[^>]*id="cart-removal-notice"[^>]*>/)[0];
    assert.ok(/\bhidden\b/.test(el), 'it must start hidden');
    assert.ok(/aria-live="polite"/.test(el), 'a failure must be announced');
    assert.ok(/role="status"/.test(el));
    assert.ok(/class="alert alert--warning"/.test(el), 'reuses the existing alert component');
    assert.ok(/\.alert--warning\s*\{/.test(COMPONENTS_CSS), '.alert--warning must exist in CSS');
    // Three call sites pass type 'warning'; it used to fall back to the neutral base.
    assert.ok(/\.toast--warning\s*\{/.test(COMPONENTS_CSS), '.toast--warning must exist in CSS');
});

test('§8.5 a non-durable journal downgrades to the loud path instead of promising a replay', () => {
    assert.ok(/_pendingOpsDurable = false/.test(CART_CODE),
        'a failed journal write must be recorded');
    const body = methodBody(CART_SRC, 'async removeItem(itemId)');
    assert.ok(/!this\._pendingOpsDurable/.test(body),
        'if nothing can replay the intent, a transient failure must roll back rather than lie');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — Identity
// ─────────────────────────────────────────────────────────────────────────────

test('§9 the frontend never overrides the guest session header to reach an old cart', () => {
    // Re-sending a retired sid is actively unsafe: api.js writes any
    // X-Guest-Session RESPONSE header straight back into localStorage, so a
    // replay could resurrect a guest session checkout deliberately retired.
    assert.ok(!/X-Guest-Session/.test(CART_CODE),
        'cart.js must not construct or override the guest-session header');
    assert.ok(/if \(!anonymous\)/.test(API_CODE),
        'api.js must still gate the response-header capture on !anonymous (ERR-124)');

    const identity = methodBody(CART_SRC, '_cartIdentity()');
    assert.ok(/Auth\.getUser/.test(identity), 'the user id must come from Auth');
    assert.ok(/API\.getGuestSessionId/.test(identity), 'the guest sid must come from API');
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Rollback is surgical
// ─────────────────────────────────────────────────────────────────────────────

test('§10.1 removeItem and addItem no longer ROLL BACK from a whole-array snapshot', () => {
    for (const sig of ['async removeItem(itemId)', 'async addItem(product)']) {
        const body = methodBody(CART_SRC, sig);
        // The rollback snapshot specifically. A rollback of remove-A landing after
        // remove-B succeeded would resurrect B.
        assert.ok(!/previousItems/.test(body),
            `${sig} must not keep a whole-cart rollback snapshot`);
        assert.ok(!/this\.items = previousItems/.test(body),
            `${sig} must not restore a whole-array snapshot`);
    }
    // removeItem re-inserts exactly the row it took out, at its recorded index.
    const remove = methodBody(CART_SRC, 'async removeItem(itemId)');
    assert.ok(/this\.items\.splice\(at, 0, removedItem\)/.test(remove),
        'removeItem must re-insert the single row at its recorded index');
    assert.ok(/const already = this\.items\.some/.test(remove),
        're-insert must be idempotent in case the row is already back');

    // addItem undoes just its own delta.
    const add = methodBody(CART_SRC, 'async addItem(product)');
    assert.ok(/hadExisting/.test(add),
        'addItem must know whether it created the line or incremented one');
    assert.ok(/this\.items\.splice\(at, 1\)/.test(add),
        'addItem must remove only the line it added');
    // The remaining deep copy in addItem is the pre-existing server-returned-empty
    // guard, not a rollback — it is now epoch-guarded and is deliberately kept.
    assert.ok(/itemsAfterAdd/.test(add), 'the server-empty guard is retained');
});

test('§10.2 clear() keeps its whole-array restore — a clear IS the whole array', () => {
    const body = methodBody(CART_SRC, 'async clear()');
    assert.ok(/JSON\.parse\(JSON\.stringify\(this\.items\)\)/.test(body),
        'clear legitimately snapshots everything');
    assert.ok(/purgePendingOps/.test(body),
        'a confirmed clear subsumes every pending removal in it');
    // The mirror must not be dropped before the server has confirmed.
    const removeMirror = body.indexOf('localStorage.removeItem(this.STORAGE_KEY)');
    const request = body.indexOf('await API.clearCart()');
    assert.ok(removeMirror > request,
        'the localStorage mirror must only be dropped AFTER a confirmed clear');
});

test('§10.3 a transient failure does NOT roll back — the journal owns it', () => {
    const body = methodBody(CART_SRC, 'async removeItem(itemId)');
    const idx = body.indexOf("if (state === 'retry' || state === 'defer')");
    assert.notEqual(idx, -1, 'the transient branch must exist');
    const branch = body.slice(idx, body.indexOf('//', idx + 200) + 1 || idx + 400);
    assert.ok(!/splice\(at, 0, removedItem\)/.test(branch),
        'a transient failure must leave the UI optimistic: the removal WILL happen, so ' +
        '"Item not removed" would be a lie in the other direction');
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 — Double-click
// ─────────────────────────────────────────────────────────────────────────────

test('§11 a double-click can neither fire two DELETEs nor hit the wrong row', () => {
    const body = methodBody(CART_SRC, 'async removeItem(itemId)');
    const guard = body.indexOf('_removingItems.has(actualId)');
    const request = body.indexOf('await API.removeFromCart');
    assert.ok(guard !== -1 && guard < request, 'removeItem must early-return if already removing');
    assert.ok(/state: 'in_flight'/.test(body), 'the guard must report why it declined');

    // The id guard alone is insufficient: updateUI() rebuilds #cart-items via
    // innerHTML between the two clicks, so the second can land on a DIFFERENT
    // item's button at the same coordinates.
    const bind = methodBody(CART_SRC, 'bindEvents: function()');
    const dis = bind.indexOf('removeBtn.disabled = true');
    const await_ = bind.indexOf('await this.removeItem(itemId)');
    assert.ok(dis !== -1 && await_ !== -1 && dis < await_,
        'the button must be disabled BEFORE the await');
    assert.ok(/if \(removeBtn\.disabled\) return;/.test(bind), 're-entry must be refused');
    assert.ok(/aria-busy/.test(bind), 'the row must announce itself as busy');
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 — Quantity
// ─────────────────────────────────────────────────────────────────────────────

test('§12.1 there is ONE quantity cap and no bare 99 survives', () => {
    assert.ok(/MAX_QUANTITY: 100/.test(CART_CODE), 'the cap must be declared once');
    assert.ok(!/Math\.min\([^)]*,\s*99\)/.test(CART_CODE),
        'updateQuantity used to clamp to 99 while six other sites used 100, so a ' +
        'programmatic set-to-100 silently became 99');
    const uses = (CART_CODE.match(/MAX_QUANTITY/g) || []).length;
    assert.ok(uses >= 5, `every cap site must reference the constant, found ${uses}`);
    assert.ok(!/const maxQty = 100/.test(CART_CODE), 'no literal cap may remain');
});

test('§12.2 a debounced quantity change survives an immediate reload', () => {
    assert.ok(/_quantityPending/.test(CART_CODE), 'pending values must be remembered');
    const flush = methodBody(CART_SRC, '_flushPendingQuantityUpdates()');
    assert.ok(/keepalive: true/.test(flush), 'the flush must survive unload');
    assert.ok(/clearTimeout/.test(flush), 'the debounce timer must be cancelled, not raced');

    const bind = methodBody(CART_SRC, '_bindDurabilityListeners()');
    assert.ok(/'pagehide'/.test(bind), 'pagehide must trigger the flush');
    assert.ok(/visibilitychange/.test(bind), 'iOS Safari is unreliable on pagehide');
    assert.ok(!/beforeunload/.test(CART_CODE),
        'beforeunload would prompt the shopper on a routine cart action, and Chrome ' +
        'ignores it without a prior gesture anyway — pagehide is the correct hook');
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 — Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('§13.1 SIGNED_OUT clears the cart mirror but NOT the journal', () => {
    const init = methodBody(CART_SRC, 'async init()');
    const idx = init.indexOf("event === 'SIGNED_OUT'");
    assert.notEqual(idx, -1);
    const branch = init.slice(idx, init.indexOf('});', idx));
    assert.ok(/localStorage\.removeItem\(this\.STORAGE_KEY\)/.test(branch),
        'the cart mirror is still cleared on sign-out');
    assert.ok(!/purgePendingOps/.test(branch),
        'an authenticated removal that never confirmed is still in that user\'s SERVER ' +
        'cart — purging here resurrects it on the next sign-in');
});

test('§13.2 replay is re-kicked whenever a deferred intent becomes deliverable', () => {
    const init = methodBody(CART_SRC, 'async init()');
    assert.ok(/token-refresh/.test(init), 'a 401-deferred removal is deliverable after a refresh');
    assert.ok(/session-restore/.test(init), 'a session restore must also re-kick');

    const bind = methodBody(CART_SRC, '_bindDurabilityListeners()');
    assert.ok(/'online'/.test(bind), 'coming back online makes deferrals deliverable');
    assert.ok(/'pageshow'/.test(bind) && /event\.persisted/.test(bind),
        'a Back into a bfcached /cart runs no init(), so it must replay on pageshow');
});

test('§13.3 concurrent replay callers collapse into one pass', () => {
    const body = methodBody(CART_SRC, 'async replayPendingOps(opts)');
    assert.ok(/_replayInFlight/.test(body), 'a shared in-flight promise must exist');
    assert.ok(/if \(this\._replayInFlight\) return this\._replayInFlight;/.test(body),
        'the init + auth-change + pageshow burst must not fire N replays');
});

test('§13.4 replay is SEQUENTIAL, so one 429 does not become N deferrals', () => {
    const body = methodBody(CART_SRC, 'async _runPendingReplay(opts)');
    assert.ok(/for \(let i = 0; i < plan\.replay\.length; i\+\+\)/.test(body),
        'the replay loop must be sequential');
    assert.ok(!/Promise\.all\(plan\.replay/.test(body),
        'parallel deletes against a 60 req/min limiter turn one 429 into N deferrals');
});

test('§13.5 completing an order purges the journal', () => {
    for (const rel of ['order-confirmation-page.js', 'payment-page.js']) {
        assert.ok(/purgePendingOps\('order completed'\)/.test(JS(rel)),
            `${rel} must purge pending ops — a stale intent must never fire against a fresh cart`);
    }
});

test('§13.6 the journal is read-modify-write, so a sibling tab is not clobbered', () => {
    const body = methodBody(CART_SRC, '_mutatePendingOps(mutate)');
    assert.ok(/_hydratePendingOps\(\)/.test(body),
        'every mutation must re-read storage first — two tabs share this key');
});

test('§13.7 re-adding or re-quantifying a line cancels its pending removal', () => {
    assert.ok(/_dropPendingOpsFor/.test(methodBody(CART_SRC, 'async addItem(product)')),
        '"remove -> re-add -> refresh" must not replay a DELETE against the re-added row');
    assert.ok(/_dropPendingOpsFor/.test(methodBody(CART_SRC, 'async updateQuantity(itemId, quantity)')));
    assert.ok(/_dropPendingOpsFor/.test(methodBody(CART_SRC, '_debouncedQuantityUpdate: function(itemId, quantity)')));
});

// ─────────────────────────────────────────────────────────────────────────────
// §14 — Hygiene
// ─────────────────────────────────────────────────────────────────────────────

test('§14.1 the journal key is one vocabulary, declared once', () => {
    const literals = (CART_CODE.match(/'inkcartridges_cart_pending_ops'/g) || []).length;
    assert.equal(literals, 1, 'the storage key must be a single literal (ERR-123: no second literal)');
    assert.ok(/PENDING_OPS_KEY: PENDING_OPS_KEY/.test(CART_CODE),
        'the Cart-level accessor must reference the module constant, not restate it');
    // Distinct from the cart mirror — conflating them would wipe the cart.
    assert.notEqual('inkcartridges_cart_pending_ops', 'inkcartridges_cart');
});

test('§14.2 zero raw console.* in the touched files', () => {
    for (const [name, code] of [['cart.js', CART_CODE], ['api.js', API_CODE], ['main.js', MAIN_CODE]]) {
        const hits = (code.match(/(^|[^.\w])console\.\w+/g) || []);
        assert.deepEqual(hits, [], `${name} must log through DebugLog only, found: ${hits.join(', ')}`);
    }
});

test('§14.3 the header cart badge selector actually matches the shipped markup', () => {
    // `.cart-count` appears in ZERO storefront headers; the badge is
    // `class="cart-badge" id="cart-count"`. updateCartCount() — and the
    // initCartBadgeFromStorage() cold paint that depends on it — were therefore
    // complete no-ops on all 29 pages.
    const body = MAIN_SRC.slice(MAIN_SRC.indexOf('function updateCartCount(count)'));
    const sel = body.match(/\$\$\(([^)]+)\)/)[1];
    for (const needed of ['.cart-badge', '#cart-count']) {
        assert.ok(sel.includes(needed), `updateCartCount must select ${needed}, got ${sel}`);
    }
    // The badge is deliberately aria-hidden (mobile-parity S0.1); the accessible
    // name lives on the enclosing link.
    assert.ok(/aria-hidden'\) !== 'true'/.test(body),
        'an aria-hidden badge must not be given an aria-label');
    assert.ok(/class="cart-badge" id="cart-count" aria-hidden="true"/.test(CART_HTML),
        'sanity: the shipped badge markup is what we think it is');
});

test('§14.3b the line-item template never uses `this` — the map callback is not bound to Cart', () => {
    // Caught live: routing the quantity cap through `this.MAX_QUANTITY` inside
    // `this.items.map(function(item){...})` threw on every render, so the cart page
    // painted ZERO line items. Every static assertion still passed, because the
    // constant was referenced exactly as required — just from the wrong receiver.
    // The callback already closes over `const self = this` for this reason.
    const anchor = 'cartItems.innerHTML = this.items.map(function(item) {';
    const start = CART_SRC.indexOf(anchor);
    assert.notEqual(start, -1, 'the line-item template must still be built by a map callback');
    const end = CART_SRC.indexOf("}).join('');", start);
    assert.notEqual(end, -1, 'the map callback must terminate');
    const body = CART_SRC.slice(start + anchor.length, end);

    assert.ok(/const self = this;/.test(CART_SRC.slice(start - 200, start)),
        'the callback must close over `self`');
    const leaks = body.match(/\bthis\./g) || [];
    assert.deepEqual(leaks, [],
        `the map callback runs unbound in strict mode, so \`this\` is undefined — ` +
        `use \`self\`. Found ${leaks.length} leak(s).`);
});

test('§14.4 the dead self-reference in removeItem is gone', () => {
    const body = methodBody(CART_SRC, 'async removeItem(itemId)');
    assert.ok(!/const self = this;/.test(body), 'the unused self alias must be removed');
});

test('§14.5 the module documents WHY all three mechanisms are required', () => {
    // Without this note the next reader deletes one as redundant. That is the
    // single most likely way this bug comes back.
    const header = CART_SRC.slice(0, CART_SRC.indexOf('const Cart = {'));
    assert.ok(/ERR-136/.test(header), 'the incident must be citable from the source');
    for (const word of ['JOURNAL', 'FILTER', 'EPOCH']) {
        assert.ok(header.includes(word), `the header must name the ${word} mechanism`);
    }
    assert.ok(/keepalive/.test(header) && /not the correctness mechanism|not load-bearing/i.test(header),
        'the header must say that keepalive is a latency measure, not the fix');
    // api.js must carry the same warning at the point of temptation — in the doc
    // comment, which precedes the signature and so is NOT part of the method body.
    const del = docCommentFor(API_SRC, 'async delete(endpoint');
    assert.ok(/before dispatch/.test(del) && /getToken/.test(del),
        'delete() must record that keepalive cannot cover a pre-dispatch abort');
    assert.ok(/journal/i.test(del),
        'delete() must point at the journal as the actual durability mechanism');
});
