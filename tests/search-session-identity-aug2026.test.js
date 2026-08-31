/**
 * Search → order join key (Aug 2026)
 * ==================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `search_analytics` (11,976 rows) and `search_clicks` stored an IP and nothing
 * else, so a search could never be joined to the order it produced. That is why
 * `/api/admin/analytics/search/top-converting` answers `orders: null,
 * conversion_pct: null` to this day — measured live 2026-08-31, along with the
 * backend's own `meta.data_gap: true` and the note "search_analytics has no link
 * to resulting orders". It is a stub, not a bug.
 *
 * The fix is to send the ids the traffic beacon already mints, so search,
 * pageviews and orders land on one key.
 *
 * THE TRAP THIS FILE EXISTS TO KEEP CLOSED
 * ----------------------------------------
 * The handoff's own recommendation would have taken the site down. It calls
 * `X-Session-Id` / `X-Visitor-Id` headers the default that "works on all GET
 * search endpoints". Measured against production, on both hosts:
 *
 *   OPTIONS /api/search/smart   (Access-Control-Request-Headers: x-session-id)
 *     → 204, Access-Control-Allow-Headers:
 *       Content-Type,Authorization,X-Requested-With,X-Request-Id,
 *       X-Guest-Session,X-Attribution-Source
 *
 * Neither id header is on that list, and a browser does not degrade when a
 * requested header is not allowed — it fails the preflight and never sends the
 * request. Adding those headers would have broken site search for every customer
 * in order to gain an analytics column. §2 below fails if anyone adds them back.
 *
 * Run: node --test tests/search-session-identity-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(INK, 'js', rel), 'utf8');

/**
 * Run traffic-tracker.js in a scripted browser and hand back its window export.
 * The real file, never a copy — a copied id vocabulary is the bug this prevents.
 */
function loadTracker({ dnt = false, pathname = '/shop', session = null, visitor = null,
                       sessionThrows = false, visitorThrows = false } = {}) {
    const sessionStore = {};
    const localStore = {};
    if (session) sessionStore.ic_traffic_session = JSON.stringify({ id: session, last: Date.now() });
    if (visitor) localStore.ic_traffic_visitor = visitor;

    const win = {
        doNotTrack: dnt ? '1' : null,
        addEventListener() {},
        location: { pathname, search: '', href: 'https://x/' + pathname },
        innerWidth: 1200, innerHeight: 800,
    };
    const sandbox = {
        window: win,
        navigator: { doNotTrack: dnt ? '1' : null, userAgent: 'test', language: 'en-NZ', sendBeacon: () => true },
        location: win.location,
        document: {
            readyState: 'complete',
            referrer: '',
            addEventListener() {},
            createElement: () => ({ }),
        },
        screen: { width: 1440, height: 900 },
        history: { pushState() {}, replaceState() {} },
        crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
        sessionStorage: {
            getItem: (k) => { if (sessionThrows) throw new Error('blocked'); return k in sessionStore ? sessionStore[k] : null; },
            setItem: (k, v) => { if (sessionThrows) throw new Error('blocked'); sessionStore[k] = v; },
        },
        localStorage: {
            getItem: (k) => { if (visitorThrows) throw new Error('blocked'); return k in localStore ? localStore[k] : null; },
            setItem: (k, v) => { if (visitorThrows) throw new Error('blocked'); localStore[k] = v; },
        },
        fetch: () => Promise.resolve({ ok: true }),
        setTimeout, clearTimeout, Date, Math, JSON, URL, URLSearchParams, Object, Array, String, Number, Blob: function () {},
        console: { log() {}, warn() {}, error() {} },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(JS('traffic-tracker.js'), sandbox, { filename: 'traffic-tracker.js' });
    return sandbox.window.TrafficTracker || null;
}

// ─────────────────────────────────────────────────────────────────────────
// §1  The accessor: read-only, validated, opt-out-respecting
// ─────────────────────────────────────────────────────────────────────────

test('§1 getIds returns the ids the beacon already established', () => {
    const tt = loadTracker({ session: 'ts_abc_123', visitor: 'v-1' });
    // Spread into this realm first: an object built inside the vm has a different
    // Object.prototype, which deepStrictEqual counts as a difference.
    assert.deepEqual({ ...tt.getIds() }, { session_id: 'ts_abc_123', visitor_id: 'v-1' });
});

test('§1 DNT means there is no accessor at all — opt-out is inherited, not re-implemented', () => {
    assert.equal(loadTracker({ dnt: true }), null,
        'traffic-tracker returns before assigning window.TrafficTracker under DNT, so a ' +
        'search cannot obtain ids for a visitor who opted out. Never mint them elsewhere.');
});

test('§1 /admin pages mint and expose nothing', () => {
    assert.equal(loadTracker({ pathname: '/admin' }), null);
});

test('§1 a malformed id is dropped, never sanitised', () => {
    // The backend rejects a malformed id outright rather than repairing it,
    // because a mangled id groups with nothing and still looks like real data.
    const tt = loadTracker({ session: 'ts_ok', visitor: 'v-1' });
    assert.equal(tt._usableId('has space'), null);
    assert.equal(tt._usableId('bang!'), null);
    assert.equal(tt._usableId('a'.repeat(129)), null);
    assert.equal(tt._usableId(''), null);
    assert.equal(tt._usableId(null), null);
    // …and everything the real minters produce passes.
    assert.equal(tt._usableId('ts_lz9k2_ab12cd34'), 'ts_lz9k2_ab12cd34');
    assert.equal(tt._usableId('11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
    assert.equal(tt._usableId('v_lz9k2_abcdefghij'), 'v_lz9k2_abcdefghij');
});

test('§1 the collision sentinels are suppressed by name', () => {
    // getVisitorId()/getSessionId() answer 'anon' / 'ts_fallback' when web
    // storage throws — private browsing, quota, a locked-down profile. Both
    // satisfy the id pattern, so without this every such visitor on earth merges
    // into ONE visitor and reads downstream as a single enormous customer.
    // A shared id is worse than no id: no id is an honest gap.
    const tt = loadTracker({ session: 'ts_ok', visitor: 'v-1' });
    assert.equal(tt._usableId('anon'), null);
    assert.equal(tt._usableId('ts_fallback'), null);

    const blocked = loadTracker({ sessionThrows: true, visitorThrows: true });
    assert.equal(blocked.getIds(), null, 'private browsing must yield no ids, not shared ones');
});

test('§1 a half-known identity still joins (partial beats nothing)', () => {
    const tt = loadTracker({ visitor: 'v-1', sessionThrows: true });
    assert.deepEqual({ ...tt.getIds() }, { visitor_id: 'v-1' });
});

// ─────────────────────────────────────────────────────────────────────────
// §2  Transport — params, never headers
// ─────────────────────────────────────────────────────────────────────────

test('§2 identifyQuery stamps sid/vid onto a params object', () => {
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    assert.deepEqual(tt.identifyQuery({ q: 'lc3319' }), { q: 'lc3319', sid: 'ts_s', vid: 'v_v' });
});

test('§2 identifyQuery handles URLSearchParams (searchSuggest builds one)', () => {
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    const usp = tt.identifyQuery(new URLSearchParams({ q: 'lc' }));
    assert.equal(usp.get('sid'), 'ts_s');
    assert.equal(usp.get('vid'), 'v_v');
});

test('§2 no ids means NO params — an empty sid= is a different, wrong answer', () => {
    const tt = loadTracker({ sessionThrows: true, visitorThrows: true });
    const params = tt.identifyQuery({ q: 'lc3319' });
    assert.deepEqual(params, { q: 'lc3319' });
    assert.equal(tt.identifyUrl('https://api/x?q=1'), 'https://api/x?q=1');
    assert.deepEqual(tt.identifyBody({ q: 'a', sku: 'B' }), { q: 'a', sku: 'B' });
});

test('§2 identifyUrl appends correctly with and without an existing query', () => {
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    assert.equal(tt.identifyUrl('https://api/s?q=1'), 'https://api/s?q=1&sid=ts_s&vid=v_v');
    assert.equal(tt.identifyUrl('https://api/s'), 'https://api/s?sid=ts_s&vid=v_v');
});

test('§2 identifyBody stamps the POST field names, not the query ones', () => {
    // sendBeacon cannot set headers, so the click beacon carries them in-body —
    // and the body contract names them session_id / visitor_id, not sid / vid.
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    assert.deepEqual(tt.identifyBody({ q: 'a', sku: 'B' }),
        { q: 'a', sku: 'B', session_id: 'ts_s', visitor_id: 'v_v' });
});

test('§2 the id HEADERS are off, and nothing in js/ sets them', () => {
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    assert.equal(tt._useIdHeaders(), false,
        'X-Session-Id / X-Visitor-Id are not on the backend CORS allow-list; turning this on ' +
        'does not degrade search, it takes it down');
    assert.deepEqual(tt.identifyHeaders({}), {});

    const files = fs.readdirSync(path.join(INK, 'js')).filter((f) => f.endsWith('.js'));
    const offenders = files.filter((f) => {
        if (f === 'traffic-tracker.js') return false;   // owns the (disabled) switch
        return /['"`]X-(Session|Visitor)-Id['"`]/i.test(JS(f));
    });
    assert.deepEqual(offenders, [],
        'a custom header on a cross-origin GET turns it into a preflighted request that the ' +
        'backend refuses — the search never fires');
});

// ─────────────────────────────────────────────────────────────────────────
// §3  Every customer-initiated search carries the key
// ─────────────────────────────────────────────────────────────────────────

test('§3 API.smartSearch and API.searchSuggest identify their queries', () => {
    const api = JS('api.js');
    const smart = api.slice(api.indexOf('async smartSearch('), api.indexOf('async searchSuggest('));
    assert.ok(/catalogEndpoint\('\/api\/search\/smart', this\.identifySearch\(/.test(smart));

    const suggest = api.slice(api.indexOf('async searchSuggest('));
    assert.ok(/this\.identifySearch\(new URLSearchParams/.test(suggest.slice(0, 900)));
});

test('§3 the header dropdown — the highest-volume surface — identifies its raw fetch', () => {
    const src = JS('search.js');
    assert.ok(src.includes('window.TrafficTracker.identifyUrl'),
        'search.js is a raw fetch that never enters API.request, so it must ask for the ids ' +
        'itself; anything added in api.js does not reach it');
});

test('§3 the quote page identifies its product lookup', () => {
    assert.ok(JS('quote-page.js').includes('window.TrafficTracker.identifyUrl'));
});

test('§3 the click beacon carries the ids in its body', () => {
    const src = JS('search-click-beacon.js');
    assert.ok(/identify\(payload\);/.test(src));
    assert.ok(src.includes('tt.identifyBody'));
});

test('§3 the click beacon still fires under DNT — CTR must stay unbiased', () => {
    // traffic-tracker honours DNT; this file deliberately does not, because the
    // backend cannot tell a suppressed click from an absent one and gating it
    // would skew CTR-by-position invisibly. Both invariants hold at once: under
    // DNT the click is still counted, it just carries no identity.
    const src = JS('search-click-beacon.js');
    assert.ok(!/navigator\.doNotTrack/.test(src),
        'adding a DNT gate here would bias CTR-by-position invisibly');
});

// ─────────────────────────────────────────────────────────────────────────
// §4  Machine-generated queries must NOT be attributed to a customer
// ─────────────────────────────────────────────────────────────────────────

test('§4 the product-detail recovery lookups are deliberately NOT identified', () => {
    // Both call /api/search/smart, and neither is a search: one is
    // API.getProduct's fallback when /api/products/:sku is unhealthy, the other
    // de-slugs a URL segment. Stamping a visitor's id on those files a search
    // the customer never ran and then credits it with whatever order follows —
    // inflating the very search→order conversion this whole feature creates.
    const api = JS('api.js');
    const fb = api.indexOf('_rawJsonFetch(`/api/search/smart?q=${encoded}');
    assert.notEqual(fb, -1);
    const around = api.slice(fb - 1400, fb);
    assert.ok(/DELIBERATELY NOT identified/.test(around),
        'the omission must be documented at the call site, or the next reader "fixes" it');
    const call = api.slice(fb, fb + 200);
    assert.ok(!/sid=|identifySearch/.test(call));

    const pdp = JS('product-detail-page.js');
    const slugFb = pdp.indexOf("/api/search/smart?q=${encodeURIComponent(q)}&limit=20");
    assert.notEqual(slugFb, -1);
    assert.ok(!/identifyUrl/.test(pdp.slice(slugFb - 400, slugFb + 200)));
});

// ─────────────────────────────────────────────────────────────────────────
// §5  Edge-cache safety — the assumption that makes params free
// ─────────────────────────────────────────────────────────────────────────

test('§5 the cache hazard is documented where the params are added', () => {
    // /api/search/smart answers cf-cache-status: DYNAMIC today, so sid/vid cost
    // nothing. If it is ever added to the Cloudflare Cache Rule they become part
    // of the cache key and shatter the shared entry one visitor at a time —
    // which is the ERR-124/159 failure in reverse. probe:data-capture fails the
    // moment DYNAMIC stops being true.
    const api = JS('api.js');
    const smart = api.slice(api.indexOf('async smartSearch('), api.indexOf('return this.getPublic(endpoint);'));
    assert.ok(/Cache Rule/.test(smart) && /cf-cache-status|DYNAMIC/.test(smart));
});
