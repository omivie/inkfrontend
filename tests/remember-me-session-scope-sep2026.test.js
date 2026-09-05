/**
 * REMEMBER ME — SESSION SCOPE (ERR-209)
 * =====================================
 * The contract:
 *
 *   The "Remember me" checkbox on /account/login had NEVER been read. Measured
 *   in a live browser with a getter spy on the element: ticking it ON produced
 *   0 reads of `.checked`, 0 lookups of `#remember-me`, and `Auth.signIn`
 *   received exactly 2 arguments. Checked and unchecked persisted identically —
 *   localStorage token, refresh token, and a 7-day `__ink_auth` cookie — so the
 *   box promised a shared-machine protection the code did not implement.
 *
 *   Now: ticked (the default) = exactly the old behaviour. Unticked = the token
 *   lives in sessionStorage and `__ink_auth` becomes a session cookie, so the
 *   session ends when the browser closes.
 *
 * Two rules this file exists to defend:
 *
 *   ABSENT MEANS REMEMBERED. A missing `ic_auth_persist` flag is a user who was
 *   never offered the choice, not one who declined it. It must never sign
 *   anybody out (§5).
 *
 *   getItem HAS NO FALLBACK. In session mode it reads sessionStorage only, so a
 *   stale localStorage token cannot resurrect a session the user ended. Adding
 *   a fallback there re-creates the original bug (§1).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const AUTH_SRC = read('js/auth.js');
const LOGIN_SRC = read('js/login-page.js');
const LOGIN_HTML = read('html/account/login.html');
const PREFIX = 'sb-lmdlgldjgcanknsjrcxh-auth-token';

/** Map-backed Web Storage stand-in. */
function makeStore(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
        get length() { return m.size; },
        key(i) { return [...m.keys()][i] ?? null; },
        getItem(k) { return m.has(k) ? m.get(k) : null; },
        setItem(k, v) { m.set(k, String(v)); },
        removeItem(k) { m.delete(k); },
        clear() { m.clear(); },
        _dump() { return Object.fromEntries(m); }
    };
}

/**
 * Evaluate auth.js in a sandbox. `supabase` is left undefined so init() bails
 * at its SDK check without touching the network.
 */
function loadAuth({ local = {}, session = {} } = {}) {
    const localStorage = makeStore(local);
    const sessionStorage = makeStore(session);
    const cookies = [];
    const sandbox = {
        localStorage,
        sessionStorage,
        console,
        document: {
            addEventListener() {},
            set cookie(v) { cookies.push(v); },
            get cookie() { return cookies[cookies.length - 1] || ''; }
        },
        window: {},
        Config: { SUPABASE_URL: 'https://lmdlgldjgcanknsjrcxh.supabase.co', SUPABASE_ANON_KEY: 'anon' },
        DebugLog: { warn() {}, error() {}, log() {} },
        Promise
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(AUTH_SRC, sandbox);
    return { Auth: sandbox.window.Auth, localStorage, sessionStorage, cookies };
}

// ---------------------------------------------------------------------------
// §1 Adapter semantics — the core of the feature
// ---------------------------------------------------------------------------

test('§1a no flag → remembered: reads and writes localStorage', () => {
    const { Auth, localStorage, sessionStorage } = loadAuth();
    assert.strictEqual(Auth._persistMode(), 'local');
    Auth._storageAdapter.setItem(PREFIX, 'tok');
    assert.strictEqual(localStorage.getItem(PREFIX), 'tok');
    assert.strictEqual(sessionStorage.getItem(PREFIX), null);
    assert.strictEqual(Auth._storageAdapter.getItem(PREFIX), 'tok');
});

test('§1b session mode: setItem writes sessionStorage AND clears localStorage', () => {
    const { Auth, localStorage, sessionStorage } = loadAuth({ local: { 'ic_auth_persist': 'session' } });
    assert.strictEqual(Auth._persistMode(), 'session');
    Auth._storageAdapter.setItem(PREFIX, 'tok');
    assert.strictEqual(sessionStorage.getItem(PREFIX), 'tok');
    assert.strictEqual(localStorage.getItem(PREFIX), null, 'no persistent copy may be left behind');
});

test('§1c NO RESURRECTION: session mode ignores a stale localStorage token', () => {
    const { Auth } = loadAuth({ local: { 'ic_auth_persist': 'session', [PREFIX]: 'stale-token' } });
    assert.strictEqual(
        Auth._storageAdapter.getItem(PREFIX), null,
        'getItem must not fall back to localStorage — that fallback IS the original bug'
    );
});

test('§1d POSITIVE CONTROL: remembered mode really does return the token', () => {
    // Without this, an implementation that returns null for everything would
    // sail through §1c and look correct while being useless (ERR-181/183).
    const { Auth } = loadAuth({ local: { [PREFIX]: 'live-token' } });
    assert.strictEqual(Auth._storageAdapter.getItem(PREFIX), 'live-token');
});

test('§1e removeItem clears BOTH stores, in either mode', () => {
    for (const mode of ['local', 'session']) {
        const { Auth, localStorage, sessionStorage } = loadAuth({
            local: { 'ic_auth_persist': mode, [PREFIX]: 'a' },
            session: { [PREFIX]: 'b' }
        });
        Auth._storageAdapter.removeItem(PREFIX);
        assert.strictEqual(localStorage.getItem(PREFIX), null, `local not cleared in ${mode} mode`);
        assert.strictEqual(sessionStorage.getItem(PREFIX), null, `session not cleared in ${mode} mode`);
    }
});

test('§1f _isAuthKey matches bare, chunked and verifier keys — and nothing else', () => {
    const { Auth } = loadAuth();
    for (const k of [PREFIX, `${PREFIX}.0`, `${PREFIX}-code-verifier`]) {
        assert.ok(Auth._isAuthKey(k), `${k} should be an auth key`);
    }
    for (const k of ['sg-auth', 'ic_auth_persist', 'inkcartridges_cart', 'cart_count', null]) {
        assert.ok(!Auth._isAuthKey(k), `${k} should NOT be an auth key`);
    }
});

test('§1g _reconcilePersistence purges localStorage in session mode only', () => {
    const seed = { [PREFIX]: 'x', [`${PREFIX}-code-verifier`]: 'y', 'inkcartridges_cart': 'keep' };

    const a = loadAuth({ local: { ...seed, 'ic_auth_persist': 'session' }, session: { [PREFIX]: 'live' } });
    a.Auth._reconcilePersistence();
    assert.strictEqual(a.localStorage.getItem(PREFIX), null);
    assert.strictEqual(a.localStorage.getItem(`${PREFIX}-code-verifier`), null);
    assert.strictEqual(a.localStorage.getItem('inkcartridges_cart'), 'keep', 'must not touch unrelated keys');
    assert.strictEqual(a.sessionStorage.getItem(PREFIX), 'live', 'must not touch sessionStorage');

    const b = loadAuth({ local: { ...seed } });
    b.Auth._reconcilePersistence();
    assert.strictEqual(b.localStorage.getItem(PREFIX), 'x', 'no-op when remembered');
});

test('§1h setPersistMode MOVES an existing token rather than dropping it', () => {
    // A signed-in user who signs in again with the box unticked keeps working
    // in the current tab; the session just downgrades to tab lifetime.
    const down = loadAuth({ local: { [PREFIX]: 'tok' } });
    down.Auth.setPersistMode(false);
    assert.strictEqual(down.sessionStorage.getItem(PREFIX), 'tok', 'token should move, not vanish');
    assert.strictEqual(down.localStorage.getItem(PREFIX), null);
    assert.strictEqual(down.localStorage.getItem('ic_auth_persist'), 'session');

    const up = loadAuth({ local: { 'ic_auth_persist': 'session' }, session: { [PREFIX]: 'tok' } });
    up.Auth.setPersistMode(true);
    assert.strictEqual(up.localStorage.getItem(PREFIX), 'tok');
    assert.strictEqual(up.sessionStorage.getItem(PREFIX), null);
    assert.strictEqual(up.localStorage.getItem('ic_auth_persist'), 'local');
});

// ---------------------------------------------------------------------------
// §2 Cookie shape
// ---------------------------------------------------------------------------

test('§2a remembered mode emits the unchanged 7-day cookie', () => {
    const { Auth, cookies } = loadAuth();
    Auth._setAuthCookie();
    assert.strictEqual(cookies.at(-1), '__ink_auth=1; path=/; SameSite=Strict; max-age=604800');
});

test('§2b session mode emits a session cookie — no max-age, no expires', () => {
    const { Auth, cookies } = loadAuth({ local: { 'ic_auth_persist': 'session' } });
    Auth._setAuthCookie();
    const c = cookies.at(-1);
    assert.ok(!/max-age/i.test(c), `session cookie must carry no max-age, got: ${c}`);
    assert.ok(!/expires/i.test(c), `session cookie must carry no expires, got: ${c}`);
    assert.ok(c.includes('__ink_auth=1') && c.includes('path=/') && c.includes('SameSite=Strict'));
});

test('§2c _clearAuthCookie still expires immediately', () => {
    const { Auth, cookies } = loadAuth();
    Auth._clearAuthCookie();
    assert.match(cookies.at(-1), /max-age=0/);
});

// ---------------------------------------------------------------------------
// §3 Wiring — the assertions that would have caught the original bug
// ---------------------------------------------------------------------------

test('§3a the checkbox exists and defaults to CHECKED', () => {
    const m = LOGIN_HTML.match(/<input[^>]*id="remember-me"[^>]*>/);
    assert.ok(m, '#remember-me must exist in login.html');
    assert.match(m[0], /\schecked\b/, 'must default to checked: wiring it up must not shorten existing sessions');
});

test('§3b the login handler reads the checkbox BEFORE calling Auth.signIn', () => {
    assert.ok(LOGIN_SRC.includes("getElementById('remember-me')"), 'the checkbox must actually be read');
    const setAt = LOGIN_SRC.indexOf('Auth.setPersistMode');
    const signAt = LOGIN_SRC.indexOf('Auth.signIn(');
    assert.ok(setAt !== -1, 'login-page.js must call Auth.setPersistMode');
    assert.ok(signAt !== -1 && setAt < signAt, 'the mode must be set before signIn, or supabase writes to the wrong store');
});

test('§3c the OAuth handler records the mode BEFORE redirecting away', () => {
    // signInWithOAuth navigates to the provider and returns to /account, which
    // has no checkbox. Recorded late = never recorded (ERR-151→155).
    const slice = LOGIN_SRC.slice(LOGIN_SRC.indexOf('socialProviders'));
    const setAt = slice.indexOf('Auth.setPersistMode');
    const signAt = slice.indexOf('await signIn()');
    assert.ok(setAt !== -1, 'the social handler must record the persistence mode');
    assert.ok(signAt !== -1 && setAt < signAt, 'must be recorded before signIn() navigates away');
});

test('§3d createClient passes the storage adapter', () => {
    // Deleting this is a behaviour change, not cleanup (ERR-158): it silently
    // returns every user to unconditional localStorage.
    const slice = AUTH_SRC.slice(AUTH_SRC.indexOf('supabase.createClient('));
    assert.match(slice.slice(0, 400), /storage:\s*this\._storageAdapter/);
});

test('§3e signOut clears the flag and the cookie', () => {
    const slice = AUTH_SRC.slice(AUTH_SRC.indexOf('async signOut()'));
    assert.match(slice.slice(0, 2000), /removeItem\(Auth\.PERSIST_KEY\)/);
    assert.match(slice.slice(0, 2000), /_clearAuthCookie\(\)/);
});

// ---------------------------------------------------------------------------
// §4 Cross-file hygiene — the ways this feature can be defeated from elsewhere
// ---------------------------------------------------------------------------

test('§4a sessionStorage.clear() appears exactly once, in auth.js signOut', () => {
    // In session mode that call also evicts the auth token, so a second call
    // site anywhere would silently sign non-remembered users out.
    const hits = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        if (!e.name.endsWith('.js')) return;
        const code = fs.readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
            .replace(/^\s*\/\/.*$/gm, '');      // line comments
        const n = (code.match(/sessionStorage\s*\.\s*clear\s*\(/g) || []).length;
        if (n) hits.push(`${path.relative(ROOT, p)} x${n}`);
    });
    walk(path.join(ROOT, 'js'));
    assert.deepStrictEqual(hits, ['js/auth.js x1'], `unexpected sessionStorage.clear() call sites: ${hits.join(', ')}`);
});

test('§4b no other page builds a bare Supabase client on the default storageKey', () => {
    // A two-arg createClient shares auth.js's storageKey but defaults to
    // localStorage, writing the token to disk whatever the checkbox said.
    const offenders = [];
    for (const f of ['js/verify-email-page.js', 'js/reset-password-page.js']) {
        const src = read(f);
        const m = src.match(/supabase\.createClient\(([\s\S]{0,300}?)\)\s*;/);
        if (!m) continue;
        if (!/auth\s*:/.test(m[1])) offenders.push(f);
    }
    assert.deepStrictEqual(offenders, [], `these persist sessions regardless of "Remember me": ${offenders.join(', ')}`);
});

test('§4c site-guard cannot race the main client for the OAuth hash', () => {
    // run() excludes only /admin*, and /account is the OAuth landing page.
    assert.match(read('js/site-guard.js'), /storageKey:\s*'sg-auth'[\s\S]{0,120}detectSessionInUrl:\s*false/);
});

// ---------------------------------------------------------------------------
// §5 Migration — nobody signed in today gets logged out by this change
// ---------------------------------------------------------------------------

test('§5 an absent flag leaves an existing localStorage session untouched', () => {
    const { Auth, localStorage } = loadAuth({ local: { [PREFIX]: 'existing-session' } });
    Auth._reconcilePersistence();
    assert.strictEqual(localStorage.getItem(PREFIX), 'existing-session');
    assert.strictEqual(Auth._storageAdapter.getItem(PREFIX), 'existing-session');
});
