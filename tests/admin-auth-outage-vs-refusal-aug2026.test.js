/**
 * Admin access: an outage is not a refusal (ERR-188)
 * ==================================================
 *
 * On 2026-08-31 the API backend returned 502 on every route for ~22 minutes.
 * The owner — whose role was, and remained, `super_admin` — could not tell that
 * from having lost their admin rights, because every failure inside
 * AdminAuth.init() took the same exit: a silent `location.href = '/account'`.
 * No message was rendered anywhere, and the header's Admin link quietly deleted
 * itself at the same time.
 *
 * THE RULE THIS FILE PINS: refuse only on an authoritative negative. A 403, or
 * a 200 that grants nothing, is the server answering "no". A 502, a timeout, a
 * rate-limit, a 404 on the route itself, or any unreadable error is a
 * NON-ANSWER, and a non-answer must never be rendered as "you are not an
 * admin".
 *
 * The subtle half is that `API.request()` has TWO 5xx shapes: a non-JSON 5xx
 * (the Render/Cloudflare HTML gateway page) THROWS, while a JSON 5xx envelope
 * RETURNS `{ ok:false, code:'INTERNAL_ERROR' }` without throwing. Code that
 * only wraps the call in try/catch handles the first and silently mis-reads the
 * second as a refusal — which is exactly what both call sites did.
 *
 * Run with: node --test tests/admin-auth-outage-vs-refusal-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'inkcartridges', 'js');

const { AdminAccess } = require(path.join(JS, 'utils.js'));

const AUTH_SRC = fs.readFileSync(path.join(JS, 'admin', 'auth.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(JS, 'admin', 'app.js'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(JS, 'main.js'), 'utf8');
const GUARD_SRC = fs.readFileSync(path.join(JS, 'site-guard.js'), 'utf8');
const UTILS_SRC = fs.readFileSync(path.join(JS, 'utils.js'), 'utf8');

// The live shape, copied from a real GET /api/admin/verify on 2026-08-31.
const LIVE_GRANT = {
    ok: true,
    data: { is_admin: true, role: 'super_admin', roles: ['super_admin'], email: 'owner@example.com' }
};

/* ── AdminAccess.classify — the vocabulary ─────────────────────────────── */

test('classify: the live super_admin payload grants owner', () => {
    const out = AdminAccess.classify(LIVE_GRANT);
    assert.equal(out.state, 'granted');
    assert.equal(out.role, 'owner');
});

test('classify: a role that arrives only in roles[] still grants', () => {
    assert.equal(AdminAccess.classify({ ok: true, data: { roles: ['admin'] } }).role, 'admin');
    // owner outranks admin when both are present
    assert.equal(AdminAccess.classify({ ok: true, data: { role: 'admin', roles: ['super_admin'] } }).role, 'owner');
});

test('classify: POSITIVE CONTROL — a 200 that grants nothing is a REFUSAL', () => {
    // Without this the suite could pass by calling everything "unreachable",
    // which would break the redirect that genuinely non-admin users must get.
    const out = AdminAccess.classify({ ok: true, data: null });
    assert.equal(out.state, 'refused');
    assert.equal(out.role, null);
});

test('classify: an unrecognised role is refused, never waved through on is_admin', () => {
    const out = AdminAccess.classify({ ok: true, data: { is_admin: true, role: 'order_manager' } });
    assert.equal(out.state, 'refused');
});

test('classify: 403 is refused; 401 is signed-out', () => {
    assert.equal(AdminAccess.classify({ ok: false, code: 'FORBIDDEN', status: 403 }).state, 'refused');
    assert.equal(AdminAccess.classify({ ok: false, code: 'UNAUTHORIZED', status: 401 }).state, 'signed-out');
});

test('classify: BOTH 5xx shapes are unreachable, not refusals', () => {
    // Shape 1 — JSON envelope, RETURNED (does not throw). This is the one the
    // old `!resp.data` check silently read as "not an admin".
    assert.equal(AdminAccess.classify({ ok: false, code: 'INTERNAL_ERROR', status: 502 }).state, 'unreachable');
    // Shape 2 — non-JSON gateway page, THROWN out of API.request().
    const thrown = Object.assign(new Error('The server is temporarily unavailable.'),
        { code: 'INTERNAL_ERROR', status: 502 });
    assert.equal(AdminAccess.classify(null, thrown).state, 'unreachable');
});

test('classify: transient and broken-deploy answers are unreachable', () => {
    for (const resp of [
        { ok: false, code: 'RATE_LIMITED', status: 429 },
        { ok: false, code: 'NOT_FOUND', status: 404 },   // route missing from the deploy
        { ok: false, status: 418 },                       // unreadable negative
    ]) {
        assert.equal(AdminAccess.classify(resp).state, 'unreachable',
            `${JSON.stringify(resp)} must not be reported as a refusal`);
    }
    assert.equal(AdminAccess.classify(null, new TypeError('Failed to fetch')).state, 'unreachable');
    assert.equal(AdminAccess.classify(undefined).state, 'unreachable');
});

test('classify: carries the request id through, for log correlation', () => {
    const out = AdminAccess.classify({ ok: false, status: 502, code: 'INTERNAL_ERROR', request_id: 'req-abc' });
    assert.equal(out.requestId, 'req-abc');
});

/* ── AdminAuth.init — what actually navigates ──────────────────────────── */

/**
 * Run the shipped js/admin/auth.js in a sandbox.
 *
 * `verifyQueue` is consumed one entry per call (the last entry repeats), so a
 * retry ladder can be driven deterministically. An Error instance is thrown;
 * anything else is resolved. setTimeout is stubbed to fire immediately and
 * record its delay, so the real 2s/5s ladder costs no wall-clock here.
 */
function runInit(verifyQueue, { authenticated = true } = {}) {
    const navigations = [];
    const delays = [];
    let calls = 0;

    const windowStub = {
        Auth: {
            readyPromise: Promise.resolve(),
            isAuthenticated: () => authenticated,
            getUser: () => ({ id: 'u1', email: 'owner@example.com' }),
        },
        API: {
            verifyAdmin: async () => {
                const item = verifyQueue[Math.min(calls, verifyQueue.length - 1)];
                calls++;
                if (item instanceof Error) throw item;
                return item;
            },
        },
        AdminAccess,
        location: {
            get href() { return navigations[navigations.length - 1]; },
            set href(v) { navigations.push(v); },
        },
    };

    const sandbox = {
        window: windowStub,
        DebugLog: { warn() {}, error() {}, log() {} },
        setTimeout: (fn, ms) => { delays.push(ms); return fn(); },
        Promise, Object, Error, Array, String, Number, JSON, encodeURIComponent,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // Strip the ESM export so the module body can run as a classic script.
    // `const AdminAuth` lands in the context's global LEXICAL scope, which is not
    // a property of the sandbox object — so bridge it out explicitly.
    vm.runInContext(
        AUTH_SRC.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '') + '\nglobalThis.AdminAuth = AdminAuth;',
        sandbox
    );

    return {
        AdminAuth: sandbox.AdminAuth,
        navigations,
        delays,
        get calls() { return calls; },
    };
}

test('init: an outage THROWS and does not navigate anywhere', async () => {
    const gateway = Object.assign(new Error('The server is temporarily unavailable.'),
        { code: 'INTERNAL_ERROR', status: 502 });
    const h = runInit([gateway]);

    await assert.rejects(() => h.AdminAuth.init(), (err) => {
        assert.equal(err.reason, 'unreachable');
        assert.equal(err.access.state, 'unreachable');
        assert.equal(err.access.status, 502);
        return true;
    });

    // THE HEART OF ERR-188: the operator stays on /admin and gets told.
    assert.deepEqual(Array.from(h.navigations), [],
        'an unreachable backend must NOT redirect — that is what read as a lockout');
});

test('init: the NON-THROWING 5xx envelope is also an outage, not a refusal', async () => {
    const h = runInit([{ ok: false, code: 'INTERNAL_ERROR', status: 502 }]);
    await assert.rejects(() => h.AdminAuth.init(), (err) => err.reason === 'unreachable');
    assert.deepEqual(Array.from(h.navigations), []);
});

test('init: POSITIVE CONTROL — a real refusal still redirects to /account', async () => {
    const h = runInit([{ ok: true, data: null }]);
    await assert.rejects(() => h.AdminAuth.init(), (err) => err.reason === 'refused');
    assert.deepEqual(Array.from(h.navigations), ['/account']);
});

test('init: an unrecognised role redirects to /account', async () => {
    const h = runInit([{ ok: true, data: { is_admin: true, role: 'order_manager' } }]);
    await assert.rejects(() => h.AdminAuth.init(), (err) => err.reason === 'refused');
    assert.deepEqual(Array.from(h.navigations), ['/account']);
});

test('init: a 401 sends the user to log in again, carrying /admin/ back', async () => {
    const h = runInit([{ ok: false, code: 'UNAUTHORIZED', status: 401 }]);
    await assert.rejects(() => h.AdminAuth.init(), (err) => err.reason === 'signed-out');
    assert.equal(h.navigations.length, 1);
    assert.match(h.navigations[0], /^\/account\/login\?redirect=%2Fadmin%2F$/);
});

test('init: a granted session sets the role and navigates nowhere', async () => {
    const h = runInit([LIVE_GRANT]);
    const out = await h.AdminAuth.init();
    assert.equal(out.role, 'owner');
    assert.equal(h.AdminAuth.isOwner(), true);
    assert.equal(h.AdminAuth.isAdmin(), true);
    assert.deepEqual(Array.from(h.navigations), []);
});

test('init: retries an outage on a 0/2s/5s ladder, then gives up loudly', async () => {
    const gateway = Object.assign(new Error('502'), { code: 'INTERNAL_ERROR', status: 502 });
    const h = runInit([gateway]);
    await assert.rejects(() => h.AdminAuth.init(), (err) => err.reason === 'unreachable');
    assert.equal(h.calls, 3, 'one 2s retry cannot span a restart — three attempts');
    assert.deepEqual(Array.from(h.delays), [2000, 5000]);
});

test('init: recovers when a retry succeeds', async () => {
    const gateway = Object.assign(new Error('502'), { code: 'INTERNAL_ERROR', status: 502 });
    const h = runInit([gateway, LIVE_GRANT]);
    const out = await h.AdminAuth.init();
    assert.equal(out.role, 'owner');
    assert.equal(h.calls, 2);
    assert.deepEqual(Array.from(h.navigations), []);
});

test('init: a REFUSAL is never retried — the server already answered', async () => {
    const h = runInit([{ ok: true, data: null }]);
    await assert.rejects(() => h.AdminAuth.init());
    assert.equal(h.calls, 1, 'retrying a refusal only delays a correct redirect');
});

test('init: a signed-out visitor goes to login without calling verify', async () => {
    const h = runInit([LIVE_GRANT], { authenticated: false });
    await assert.rejects(() => h.AdminAuth.init());
    assert.equal(h.calls, 0);
    assert.match(h.navigations[0], /^\/account\/login\?redirect=/);
});

/* ── Enrolment: the surfaces must actually use the vocabulary ──────────── */

test('utils.js publishes AdminAccess on window for the classic scripts', () => {
    // main.js is a classic script and admin/auth.js is a module; both reach it
    // through the global. A bare const would be invisible to `window.X` reads —
    // the ERR-167 trap.
    assert.match(UTILS_SRC, /window\.AdminAccess = AdminAccess/);
});

test('admin/auth.js branches on classify(), and never on a message string', () => {
    assert.match(AUTH_SRC, /AdminAccess/);
    assert.match(AUTH_SRC, /classify\(/);
    // The old shape: one catch-all that redirected on any failure.
    assert.doesNotMatch(AUTH_SRC, /catch \(e2\)/,
        'the single-retry-then-redirect ladder is what ERR-188 removed');
});

test('app.js renders the outage state instead of following a redirect', () => {
    assert.match(APP_SRC, /renderBackendUnavailable/);
    assert.match(APP_SRC, /reason === 'unreachable'/);
    assert.match(APP_SRC, /Admin Centre unavailable/);
    // It must say the thing the operator could not tell on the day.
    assert.match(APP_SRC, /not<\/strong> a problem with your account/);
});

test('main.js: a non-answer must not retract the admin link or the hint', () => {
    assert.match(MAIN_SRC, /AdminAccess\.classify/);
    assert.match(MAIN_SRC, /state === 'unreachable'/);
    // The old test — false for an outage as well as for a genuine refusal.
    assert.doesNotMatch(MAIN_SRC, /var isAdmin = !!\(res && res\.ok && res\.data\)/);
});

test('site-guard.js: a 502 retries instead of denying', () => {
    assert.doesNotMatch(GUARD_SRC, /if \(!res\.ok\) return false;/,
        'a 502 returning false skipped the cold-start retry entirely');
    assert.match(GUARD_SRC, /if \(!res\.ok\) return null;/);
    assert.match(GUARD_SRC, /res\.status === 401 \|\| res\.status === 403/);
});

/* ── The two role lists must agree ─────────────────────────────────────── */

test('site-guard.js and AdminAccess answer identically for every spelling', () => {
    // site-guard.js is self-contained BY DESIGN (it must work when nothing else
    // has loaded), so its copy is duplicated rather than imported. This test is
    // what stops the two from drifting — and they HAD drifted: site-guard
    // accepted the literal 'super_admin' while admin/auth.js accepted it only
    // after stripping the underscore.
    const m = GUARD_SRC.match(/const ROLE_KEYS = \[([^\]]*)\]/);
    assert.ok(m, 'site-guard.js must expose its role keys as ROLE_KEYS');
    const guardKeys = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

    const normalise = (raw) => String(raw || '').toLowerCase().replace(/[^a-z]/g, '');

    for (const spelling of ['super_admin', 'superadmin', 'SUPER-ADMIN', 'Owner', 'owner',
                            'admin', 'ADMIN', 'order_manager', 'stock_manager', '', null]) {
        const guardSays = guardKeys.includes(normalise(spelling));
        const accessSays = AdminAccess.normalizeRole(spelling) !== null;
        assert.equal(guardSays, accessSays,
            `disagreement on "${spelling}": site-guard=${guardSays} AdminAccess=${accessSays}`);
    }
});

test('the recognised roles are exactly owner and admin, and super_admin maps to owner', () => {
    assert.equal(AdminAccess.normalizeRole('super_admin'), 'owner');
    assert.equal(AdminAccess.normalizeRole('superadmin'), 'owner');
    assert.equal(AdminAccess.normalizeRole('owner'), 'owner');
    assert.equal(AdminAccess.normalizeRole('admin'), 'admin');
    assert.equal(AdminAccess.normalizeRole('order_manager'), null);
});
