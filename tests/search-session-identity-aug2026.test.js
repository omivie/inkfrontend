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
// CODE ONLY. Every "this must not appear" assertion below runs through this,
// because the files it reads deliberately EXPLAIN the patterns they no longer
// use — api.js carries a tombstone naming identifySearch, search.js says why
// the params are gone. A ban that also bans its own explanation is a ban
// nobody can document (ERR-253).
const stripComments = require('./helpers/strip-comments');
const CODE = (rel) => stripComments(JS(rel));

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
// §2  Transport — the tracker's own stamping functions (both still exist:
//     the cart POST uses the params, search uses the header)
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

test('§2 the id HEADERS are ON — BF-054 closed 2026-09-08', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right to.
    // Until 2026-09-08 X-Session-Id / X-Visitor-Id were absent from the
    // backend's Access-Control-Allow-Headers, and a browser does not degrade
    // there — it fails the preflight and never sends the search at all. The
    // assertion was "off, and nothing in js/ sets them", and it was load-bearing.
    //
    // The backend shipped the allow-list. Re-measured against production
    // 2026-09-09 on all three origins WITH A NEGATIVE CONTROL (a bogus header
    // name is not echoed back, so it is a real static list and not a preflight
    // that agrees with anything — the ERR-223 trap). `npm run probe:data-capture`
    // §1 is the live check and now fails if the allow-list ever loses them again.
    const tt = loadTracker({ session: 'ts_s', visitor: 'v_v' });
    assert.equal(tt._useIdHeaders(), true,
        'the CORS allow-list carries both headers now; the switch is the one line that turns ' +
        'six months of anonymous search data back on');
    assert.deepEqual(tt.identifyHeaders({}),
        { 'X-Session-Id': 'ts_s', 'X-Visitor-Id': 'v_v' });

    // It stamps IN PLACE onto whatever it is given, so a caller that already
    // built an Authorization header does not lose it.
    assert.deepEqual(tt.identifyHeaders({ Authorization: 'Bearer x' }),
        { Authorization: 'Bearer x', 'X-Session-Id': 'ts_s', 'X-Visitor-Id': 'v_v' });
});

test('§2 an unusable id sends NO header rather than a placeholder one', () => {
    // Validate, never sanitise. A shared or malformed id is worse than none:
    // no id is an honest gap, a shared one is a lie with a number on it.
    for (const bad of ['anon', 'ts_fallback']) {
        const tt = loadTracker({ session: bad, visitor: bad });
        assert.deepEqual(tt.identifyHeaders({}), {},
            `the ${bad} collision sentinel must never reach a header`);
    }
    const malformed = loadTracker({ session: 'has space', visitor: 'v_ok' });
    const headers = malformed.identifyHeaders({});
    assert.equal(headers['X-Session-Id'], undefined,
        'an id failing ID_PATTERN is omitted, not trimmed into something plausible');
    assert.equal(headers['X-Visitor-Id'], 'v_ok', 'and the good one still goes');
});

test('§2 the header vocabulary has exactly ONE owner in js/', () => {
    // The scan below is unchanged from when this feature was OFF — but it now
    // asserts something different and still worth having. api.js and search.js
    // both send these headers; neither spells them, because both call
    // TrafficTracker.identifyHeaders(). One file names the header, so there is
    // one place to change if the backend ever renames it, and no call site can
    // drift to a near-miss spelling (ERR-216: grep for the parser, not the promise).
    const files = fs.readdirSync(path.join(INK, 'js')).filter((f) => f.endsWith('.js'));
    const offenders = files.filter((f) => {
        if (f === 'traffic-tracker.js') return false;   // owns the vocabulary
        return /['"`]X-(Session|Visitor)-Id['"`]/i.test(JS(f));
    });
    assert.deepEqual(offenders, [],
        'no file may spell the header itself — call TrafficTracker.identifyHeaders()');

    // Positive control: the scan can actually find the literal it hunts for.
    assert.match(JS('traffic-tracker.js'), /['"`]X-Session-Id['"`]/,
        'sanity — the owner really does contain the literal, so an empty offender ' +
        'list means "nobody else spells it", not "the regex matches nothing"');
});

test('§2 the header is enrolled PER-HELPER in api.js, never applied globally', () => {
    // A custom header makes a GET non-simple, so the browser preflights it, and
    // the CORS-preflight cache is keyed by FULL URL. Stamping every request
    // would add an OPTIONS round-trip per distinct catalog and typeahead URL on
    // the site. Enrolment is a declared option — the same contract as
    // `anonymous: true` — so a new identified endpoint is a decision.
    const api = JS('api.js');
    assert.match(api, /if \(options\.identify\) \{\s*\n\s*this\.identifyHeaders\(headers\);/,
        'request() must stamp the ids only when the caller asked for it');
    // "Not global" stated so it can actually fail: there is exactly ONE stamp
    // in the whole file, and the assertion above proves that one is guarded.
    // (An earlier draft of this test used a /^\s*this\.identifyHeaders/m
    // negative — which matched the guarded line itself and could never fail.)
    const stamps = api.match(/this\.identifyHeaders\(headers\)/g) || [];
    assert.equal(stamps.length, 1,
        'an unconditional second stamp would preflight every catalog GET on the site');

    // And the two search helpers are the ones that asked.
    const smart = api.slice(api.indexOf('async smartSearch('), api.indexOf('async searchSuggest('));
    assert.match(smart, /identify: true/,
        '/api/search/smart writes the search_analytics row — it must carry the id');
    const suggest = api.slice(api.indexOf('async searchSuggest('));
    assert.match(suggest.slice(0, 2000), /identify: true/,
        '/api/search/suggest too');
});

test('§2 the header typeahead stamps the ids on its own raw fetch', () => {
    // search.js:fetchSmart never enters API.request, so the per-helper enrolment
    // does not reach it. It is also the highest-volume search surface on the
    // site — leaving it out would leave most search_analytics rows anonymous
    // while the test suite looked green (ERR-150/160: "every surface calls X"
    // is a list nobody maintains, so the enrolment lives HERE).
    const search = JS('search.js');
    const fn = search.slice(search.indexOf('async function fetchSmart('));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.match(body, /TrafficTracker\.identifyHeaders\(headers\)/,
        'the typeahead must ask for the ids itself');
    assert.ok(body.indexOf('identifyHeaders') < body.indexOf('await fetch('),
        'and it must do so BEFORE the fetch, or the headers object is already spent');
});

// ─────────────────────────────────────────────────────────────────────────
// §3  Every customer-initiated search carries the key
// ─────────────────────────────────────────────────────────────────────────

test('§3 the two search helpers identify by HEADER, and put NOTHING in the URL', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right to. Until
    // 2026-09-10 both helpers called `this.identifySearch(...)` to stamp
    // ?sid=/?vid= onto the query, because that was the only transport we had
    // any evidence for and the header was CORS-blocked.
    //
    // Two things changed on the same day, and either alone would have been
    // enough (ERR-253):
    //
    //   1. The params were measured to have never delivered a row. The backend
    //      runs Joi with stripUnknown over req.query and REPLACES it, and the
    //      search schemas never listed sid/vid — so they were deleted before
    //      the handler read them. The header, by contrast, took session ids
    //      from 0/115 to 37/115 on the day its allow-list shipped.
    //   2. /api/search/ joined the Cloudflare Cache Rule. The cache key is the
    //      URL and excludes custom request headers, so a per-visitor param
    //      gives every visitor a private entry. Measured cold: MISS 3.39s then
    //      HIT 0.057s on the shared URL.
    //
    // So the URL must now be clean and the header must remain. Both halves are
    // asserted, because dropping the param without keeping the header is the
    // failure this file has always existed to prevent.
    const api = CODE('api.js');
    const smart = api.slice(api.indexOf('async smartSearch('), api.indexOf('async searchSuggest('));
    assert.doesNotMatch(smart, /identifySearch\(/,
        'smartSearch must not put the ids in the URL — the URL is the edge cache key');
    assert.match(smart, /identify: true/,
        'and it must still send them as headers, or six months of anonymous rows come back');

    const suggest = api.slice(api.indexOf('async searchSuggest('), api.indexOf('async searchSuggest(') + 1400);
    assert.doesNotMatch(suggest, /identifySearch\(/, '/api/search/suggest is edge-cached too');
    assert.match(suggest, /identify: true/);

    // The forwarder itself is gone, so there is no half-live path to fall into.
    assert.doesNotMatch(api, /^\s*identifySearch\(params\) \{/m,
        'identifySearch had exactly these two callers; it must not linger as dead code');
});

test('§3 the header dropdown — the highest-volume surface — stamps the header on its raw fetch', () => {
    const src = CODE('search.js');
    assert.ok(src.includes('window.TrafficTracker.identifyHeaders'),
        'search.js is a raw fetch that never enters API.request, so it must ask for the ids ' +
        'itself; anything added in api.js does not reach it');
    assert.ok(!src.includes('window.TrafficTracker.identifyUrl'),
        'and it must not put them in the URL — this is the surface that generates the most ' +
        'distinct cache keys, so it is the one a per-visitor param hurts most');
});

test('§3 the quote page SWAPPED its transport — it did not merely lose one', () => {
    // The trap in this change. quote-page.js is the only one of the four call
    // sites that had identifyUrl and NO header stamp at all: it is a raw fetch,
    // so api.js's per-helper `identify: true` never reached it. Deleting the
    // param here without adding the header would not have fallen back to
    // anything — a real customer typing a real quote line would have gone
    // anonymous, silently, with this suite still green.
    const src = CODE('quote-page.js');
    assert.ok(src.includes('window.TrafficTracker.identifyHeaders'),
        'the header stamp must have been ADDED here in the same change');
    assert.ok(!src.includes('window.TrafficTracker.identifyUrl'),
        'and the param stamp removed');
});

test('§3 the cart POST keeps ?sid= — this change is scoped to search', () => {
    // The negative control for §3. POST /api/cart/items is not edge-cached and
    // the param is the transport that measurably lands its rows, so it must be
    // untouched. If a later tidy-up deletes identifyUrl as "unused", this fails.
    const api = CODE('api.js');
    assert.match(api, /identifyUrl\('\/api\/cart\/items'\)/,
        'the cart POST still carries the query-param join key');
    assert.match(api, /^\s*identifyUrl\(url\) \{/m,
        'and the forwarder it needs is still defined');
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

test('§5 the cache-key reasoning is recorded where the URL is built', () => {
    // THIS ASSERTION COULD NOT FAIL, AND IT SPENT WEEKS THAT WAY (ERR-253).
    //
    // It used to slice with the end marker 'return this.getPublic(endpoint);'.
    // That line stopped existing the day `{ identify: true }` was added to it,
    // so indexOf returned -1, and `slice(start, -1)` runs to one character
    // short of END OF FILE. The "smartSearch" it then searched for "Cache Rule"
    // was most of api.js. Any mention anywhere would have satisfied it.
    //
    // Same family as the negative control in ERR-237 that matched the guarded
    // line itself. The fix is to make the slice prove it found its own end.
    const api = JS('api.js');
    const start = api.indexOf('async smartSearch(');
    assert.notEqual(start, -1, 'smartSearch must exist');
    const end = api.indexOf('async searchSuggest(', start);
    assert.ok(end > start, 'the slice must terminate at a marker that really exists');
    const smart = api.slice(start, end);

    // Positive control: the slice is the function, not the file.
    assert.ok(smart.length < 12000,
        `the smartSearch slice should be one function, got ${smart.length} characters — `
        + 'if this blows up, the end marker has drifted again and the assertions below mean nothing');

    assert.match(smart, /cache key/i,
        'the reason the ids are NOT in this URL must be written where the URL is built');
    assert.match(smart, /MISS|HIT|edge-cached/,
        'and it must carry the measurement, not just the claim');
});
