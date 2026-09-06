/**
 * Cart analytics had its own private session id (Sep 2026)
 * ========================================================
 * ERR-223 · hand-off `add-to-cart-tracking-FE-handoff-sep2026.md` §3
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The backend now writes its own `add_to_cart` row into `cart_analytics_events`
 * from POST /api/cart/items, because the API request that creates the cart line
 * cannot be blocked, dropped on an SPA route change, or lost when a tab
 * backgrounds mid-tap — all of which the beacon can be, and all commoner on
 * mobile, the population under investigation. Its hand-off says:
 *
 *   "Both rows are written; readers that count DISTINCT session_id are
 *    unaffected by the overlap."
 *
 * THAT WAS FALSE WHEN IT WAS WRITTEN, and this file is why it is true now.
 *
 * `cart-analytics.js` minted its OWN id — `cs_…` in sessionStorage — unrelated
 * to the `ts_…` id `traffic-tracker.js` mints and that `traffic_events`, the
 * search `?sid=` and the click beacon all carry. So the beacon's row said
 * `cs_X` and the server's row said `ts_Y` FOR THE SAME ADD, and a DISTINCT
 * count saw two sessions where there was one. `cart_viewed` stayed pure `cs_`,
 * so `add_to_cart` would have become the only rung of the funnel mixing two id
 * spaces — the rung the whole investigation is about.
 *
 * The column was 100% populated throughout. That is the trap worth remembering:
 * **a populated column that joins to nothing is worse than a null one.** A null
 * is visibly missing and gets fixed; a populated one looks like working data
 * and gets reported.
 *
 * THE RULE: never mint an analytics id outside traffic-tracker.js. This file
 * asks it, and keeps its own `cs_` id only as a named last resort for the cases
 * where the tracker deliberately does not exist (DNT, /admin) — an honest
 * unjoinable id rather than a shared lie. Removing that fallback would be a
 * behaviour change, not a cleanup.
 *
 * Run: node --test tests/cart-analytics-session-identity-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CA_SRC = read('inkcartridges/js/cart-analytics.js');
const TT_SRC = read('inkcartridges/js/traffic-tracker.js');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CA_CODE = codeOnly(CA_SRC);

/**
 * Run the real cart-analytics.js with a scripted TrafficTracker.
 * @param {object|null|undefined} ids what window.TrafficTracker.getIds() answers;
 *   `undefined` means there is no TrafficTracker at all (DNT / admin).
 */
function load(ids, opts = {}) {
    const session = Object.create(null);
    const local = Object.create(null);
    const sent = [];
    const listeners = {};

    const ctx = {
        console,
        sessionStorage: {
            getItem: (k) => (k in session ? session[k] : null),
            setItem: (k, v) => { session[k] = String(v); },
            removeItem: (k) => { delete session[k]; },
        },
        localStorage: {
            getItem: (k) => (k in local ? local[k] : null),
            setItem: (k, v) => { local[k] = String(v); },
            removeItem: (k) => { delete local[k]; },
        },
        document: {
            addEventListener: (ev, fn) => { listeners[ev] = fn; },
            querySelector: () => null,
        },
        location: { pathname: '/shop', href: 'https://inkcartridges.co.nz/shop' },
        addEventListener: () => {},
        DebugLog: { log() {}, warn() {}, error() {}, info() {} },
        Config: { API_URL: 'https://api.example.test' },
        fetch: (url, init) => {
            sent.push({ url, body: JSON.parse(init.body) });
            return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
        },
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    if (ids !== undefined) ctx.TrafficTracker = { getIds: () => ids };
    if (opts.extraGlobals) Object.assign(ctx, opts.extraGlobals);

    vm.createContext(ctx);
    vm.runInContext(CA_SRC, ctx);
    return { ctx, CA: ctx.window.CartAnalytics, session, sent, listeners };
}

const TS = 'ts_mfa1b2c_9x8y7z6w';
const TV = '7f3a1c22-0d9e-4b11-8a55-2e6c4d9f0a13';

// ═══════════════════════════════════════════════════════════════════════════
// 1. One id space
// ═══════════════════════════════════════════════════════════════════════════

test('§1 the shared traffic session id is what gets sent', () => {
    const { CA } = load({ session_id: TS, visitor_id: TV });
    assert.equal(CA.currentSessionId(), TS,
        'the beacon row and the server row must describe the SAME session');
});

test('§1 it does not mint a cs_ id when the shared one is available', () => {
    const { CA, session } = load({ session_id: TS, visitor_id: TV });
    CA.currentSessionId();
    assert.equal(session.cart_session_id, undefined,
        'minting a second id we never send is how the two id spaces started');
});

test('§1 track() reads the resolved id, never a stale init-time one', () => {
    // traffic-tracker.js is injected by gtag.js via createElement('script'), and
    // a dynamically-inserted script is ASYNC whatever .defer says — so it can
    // land AFTER DOMContentLoaded, which is when init() runs. Resolving once at
    // init would lock some page loads onto the fallback and not others: a race
    // that reads as flaky data rather than as a bug.
    assert.match(CA_CODE, /session_id: this\.currentSessionId\(\)/);
    assert.doesNotMatch(CA_CODE, /session_id: this\.sessionId\b/,
        'no event may be built from the id captured at init time');
});

test('§1 init() does not resolve or mint the id', () => {
    // Brace-matched: slicing to the next method name would swallow the
    // definitions that follow init() and the ban would match its own subject.
    const start = CA_CODE.indexOf('init() {');
    assert.ok(start > 0, 'located init()');
    let depth = 0, i = CA_CODE.indexOf('{', start), end = i;
    for (; i < CA_CODE.length; i++) {
        if (CA_CODE[i] === '{') depth++;
        else if (CA_CODE[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const init = CA_CODE.slice(start, end + 1);
    assert.match(init, /setupUnloadTracking/, 'and it really is init()');
    assert.doesNotMatch(init, /getOrCreateSessionId|currentSessionId/,
        'init runs before traffic-tracker.js may have loaded');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The fallback — kept, named, and honest
// ═══════════════════════════════════════════════════════════════════════════

test('§2 with no TrafficTracker at all it still produces an id', () => {
    // DNT and /admin both return before window.TrafficTracker is assigned. The
    // backend requires a session_id, so the event still needs one.
    const { CA } = load(undefined);
    const id = CA.currentSessionId();
    assert.match(id, /^cs_/, 'the local last-resort id');
    assert.equal(CA.currentSessionId(), id, 'and it is stable within the session');
});

test('§2 an unusable id (storage sentinels suppressed upstream) falls back too', () => {
    // traffic-tracker.js returns null from getIds() when the only ids available
    // are 'anon' / 'ts_fallback' — a shared id is worse than no id.
    for (const answer of [null, {}, { visitor_id: TV }]) {
        const { CA } = load(answer);
        assert.match(CA.currentSessionId(), /^cs_/,
            `getIds() -> ${JSON.stringify(answer)} must not become the session id`);
    }
});

test('§2 the fallback is REMOVED from the code only over this test\'s dead body', () => {
    // Removing a fallback is a behaviour change, not a cleanup (ERR-158).
    assert.match(CA_CODE, /getOrCreateSessionId\(\)/);
    assert.match(CA_CODE, /'cs_' \+ Date\.now\(\)/);
});

test('§2 it never mints an id that traffic-tracker would not have', () => {
    // The ONE place allowed to mint an analytics identity is traffic-tracker.js.
    // Anything here that reads its storage keys directly is a second minter.
    assert.doesNotMatch(CA_CODE, /ic_traffic_session|ic_traffic_visitor/,
        'read the accessor, never the tracker\'s private storage keys');
    assert.match(TT_SRC, /window\.TrafficTracker = \{/, 'and the accessor really is on window');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The payload the backend receives
// ═══════════════════════════════════════════════════════════════════════════

test('§3 add_to_cart is sent with the shared session id', async () => {
    const { CA, sent } = load({ session_id: TS, visitor_id: TV });
    await CA.track('add_to_cart', { product_id: 'p-1', quantity: 2 });
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/api\/analytics\/cart-event$/);
    assert.equal(sent[0].body.session_id, TS);
    assert.equal(sent[0].body.event_type, 'add_to_cart');
    assert.equal(sent[0].body.product_id, 'p-1');
    assert.equal(sent[0].body.quantity, 2);
});

test('§3 visitor_id rides along when known', () => {
    const { CA } = load({ session_id: TS, visitor_id: TV });
    const payload = CA.buildBackendPayload({ event_type: 'cart_viewed', session_id: TS });
    assert.equal(payload.visitor_id, TV,
        'a visitor id is what joins a cart across sessions to one person');
});

test('§3 and is OMITTED, never null, when it is not', () => {
    // Absence is not a value. `visitor_id: null` is a claim we cannot support.
    const { CA } = load({ session_id: TS });
    const payload = CA.buildBackendPayload({ event_type: 'cart_viewed', session_id: TS });
    assert.ok(!('visitor_id' in payload));

    const none = load(undefined);
    const p2 = none.CA.buildBackendPayload({ event_type: 'cart_viewed', session_id: 'cs_x' });
    assert.ok(!('visitor_id' in p2));
});

test('§3 the accepted-event whitelist is unchanged', () => {
    const { CA } = load({ session_id: TS });
    assert.deepEqual(JSON.parse(JSON.stringify(CA.BACKEND_EVENT_TYPES)),
        ['add_to_cart', 'remove_from_cart', 'checkout_started', 'checkout_completed', 'cart_viewed']);
    assert.equal(CA.buildBackendPayload({ event_type: 'potential_abandonment' }), null,
        'a type the backend does not accept is still stored locally only');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The post-order reset now governs only the fallback
// ═══════════════════════════════════════════════════════════════════════════

test('§4 completing an order clears the local id without minting a new one', () => {
    const { CA, session } = load(undefined);
    CA.currentSessionId();
    assert.match(session.cart_session_id, /^cs_/);

    CA.trackOrderCompleted({ order_number: 'X1', total: 10, items: [] });
    assert.equal(session.cart_session_id, undefined, 'cleared');
    assert.equal(CA.sessionId, null,
        'and NOT eagerly re-minted — the next event resolves it, tracker first');
});

test('§4 under the shared id a session is the tracker\'s window, not the order', () => {
    // Deliberate change of meaning: two orders minutes apart are now ONE
    // session, exactly as traffic_events and search already record it. That is
    // the point of having one id space.
    const { CA } = load({ session_id: TS, visitor_id: TV });
    CA.trackOrderCompleted({ order_number: 'X1', total: 10, items: [] });
    assert.equal(CA.currentSessionId(), TS);
});
