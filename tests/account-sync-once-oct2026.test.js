/**
 * Account sync runs once per user, not on every SIGNED_IN (ERR-322, Oct 2026)
 * ============================================================================
 *
 * supabase-js emits SIGNED_IN on every page load with a stored session and on
 * tab refocus; /account synced again on load. POST /api/account/sync is limited
 * to 5 per 15 min per IP (measured: `ratelimit-policy: 5;w=900`), so a shopper
 * with several tabs open got 429 and the "Account sync failed. Some features may
 * not work." toast on almost every page.
 *
 * Contract: Auth.syncAccount() calls the API only when no fresh success marker
 * exists; the marker is written only on ok; concurrent callers share one call;
 * SIGNED_OUT clears the marker so a real sign-in always syncs.
 *
 * Run with: node --test tests/account-sync-once-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripComments } = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges', 'js');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'auth.js'), 'utf8');
const ACCOUNT_SRC = fs.readFileSync(path.join(ROOT, 'account.js'), 'utf8');

function makeStorage() {
    const map = new Map();
    return {
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

function loadAuth({ reply, storage, calls = [], navigator }) {
    const sandbox = {
        window: { addEventListener() {} }, document: { cookie: '', addEventListener() {} }, console,
        localStorage: storage || makeStorage(), sessionStorage: makeStorage(), navigator,
        DebugLog: { warn() {}, error() {}, log() {} },
        Config: {},
        API: { accountSync: async (t) => { calls.push(t); return reply(calls.length); } },
        module: { exports: {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(AUTH_SRC, sandbox);
    const Auth = sandbox.module.exports.Auth;
    Auth.user = { id: 'u1' };
    Auth.getTurnstileToken = async () => null;
    Auth.captureRetroClaim = () => {};
    return { Auth, calls, storage: sandbox.localStorage };
}

test('second call within TTL skips the network and says so', async () => {
    const { Auth, calls } = loadAuth({ reply: () => ({ ok: true }) });
    assert.equal((await Auth.syncAccount()).ok, true);
    const second = await Auth.syncAccount();
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...second }, { ok: true, skipped: true });
});

test('a failed sync writes no marker, so the next caller retries', async () => {
    const { Auth, calls } = loadAuth({ reply: (n) => (n === 1 ? { ok: false, code: 'INTERNAL_ERROR' } : { ok: true }) });
    await Auth.syncAccount();
    await Auth.syncAccount();
    await Auth.syncAccount();
    assert.equal(calls.length, 2);
});

test('a thrown sync (429 on POST) writes no marker and propagates', async () => {
    const { Auth, calls } = loadAuth({ reply: (n) => { if (n === 1) { const e = new Error('rl'); e.code = 'RATE_LIMITED'; throw e; } return { ok: true }; } });
    await assert.rejects(Auth.syncAccount(), /rl/);
    await Auth.syncAccount();
    assert.equal(calls.length, 2);
});

test('concurrent callers share one request', async () => {
    const { Auth, calls } = loadAuth({ reply: () => ({ ok: true }) });
    await Promise.all([Auth.syncAccount(), Auth.syncAccount(), Auth.syncAccount()]);
    assert.equal(calls.length, 1);
});

test('expired marker syncs again; sign-out clears the marker', async () => {
    const { Auth, calls, storage } = loadAuth({ reply: () => ({ ok: true }) });
    await Auth.syncAccount();
    storage.setItem('ic_account_synced:u1', String(Date.now() - Auth.SYNC_TTL_MS - 1));
    await Auth.syncAccount();
    assert.equal(calls.length, 2);
    Auth._clearSyncMarkers();
    await Auth.syncAccount();
    assert.equal(calls.length, 3);
});

test('tabs sharing storage + Web Locks: one sign-in broadcast to N tabs = one request', async () => {
    // Minimal Web Locks: FIFO per name, like the browser.
    let chain = Promise.resolve();
    const navigator = { locks: { request: (_n, fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; } } };
    const storage = makeStorage();
    const calls = [];
    const tabs = [1, 2, 3, 4].map(() => loadAuth({ reply: () => ({ ok: true }), storage, calls, navigator }).Auth);
    const results = await Promise.all(tabs.map((a) => a.syncAccount()));
    assert.equal(calls.length, 1);
    assert.equal(results.filter((r) => r.skipped).length, 3);
});

test('wiring: both callers route through syncAccount; SIGNED_OUT clears markers', () => {
    const auth = stripComments(AUTH_SRC);
    const account = stripComments(ACCOUNT_SRC);
    assert.equal((auth.match(/API\.accountSync\(/g) || []).length, 1, 'auth.js calls API.accountSync only inside syncAccount');
    assert.match(auth, /await this\.syncAccount\(\)/);
    assert.match(auth, /event === 'SIGNED_OUT'\) this\._clearSyncMarkers\(\)/);
    assert.doesNotMatch(account, /API\.accountSync\(/);
    assert.match(account, /Auth\.syncAccount\(\)/);
});
