/**
 * TRAFFIC TRACKER
 * ===============
 * Lightweight first-party pageview + click tracker.
 * Sends events to the backend which persists them to Supabase.
 * Read by the admin "Website Traffic" page.
 *
 * Campaign attribution (campaign-visitor-tracking-may2026.md):
 *  - `utm_rid` is captured from the first pageview URL and persisted in
 *    sessionStorage so every subsequent event in the same tab forwards it.
 *  - For signed-in visitors we attach `Authorization: Bearer <token>` so the
 *    backend can match against the campaign-recipient table. sendBeacon can't
 *    carry custom headers, so the authenticated path uses `fetch` with
 *    `keepalive: true`. Anonymous visits keep using sendBeacon (most reliable
 *    on unload). Spec: readfirst/campaign-visitor-tracking-may2026.md
 */
(function () {
    'use strict';

    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    if (location.pathname.startsWith('/admin')) return;

    const SESSION_KEY = 'ic_traffic_session';
    const VISITOR_KEY = 'ic_traffic_visitor';
    const UTM_RID_KEY = 'utm_rid'; // sessionStorage; spec-mandated key name
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    const AUTH_READY_TIMEOUT_MS = 1200; // bound first-pageview wait so tracking never blocks the page

    /**
     * Cap for the click `element` value. ONE constant for every branch of
     * labelFor(), applied AFTER the prefix, so 200 means the same thing wherever
     * it is read.
     *
     * This is a MEASUREMENT, not a round number. Measured 2026-09-03 across all
     * 4,085 live products (`canonical_url` from /api/products):
     *
     *     max length of ("link:" + pathname) ......... 113 chars
     *     95th percentile ............................  99 chars
     *     truncated at the old cap of 80 ............. 2,380 (58.3%)
     *     ...of those, losing the ENTIRE SKU segment . 2,380 (all of them)
     *     truncated at 120 ...........................     0
     *
     * The old cap was applied after the 5-char "link:" prefix as well, so only 75
     * path characters survived — and the SKU is the LAST path segment, which is
     * what the backend resolves a click to a product with. It recovered 66% by
     * slug prefix; the rest were unattributable
     * (readfirst/analytics-dashboards-FE-handoff-sep2026.md, job 1).
     *
     * 200 clears the measured worst case by 87 characters. The API accepts 512
     * and the column is unlimited, so the headroom is free. If a product slug
     * ever grows past this, `npm run probe:analytics-dashboards` §8 fails.
     */
    const ELEMENT_MAX_CHARS = 200;

    function uuid() {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
    }

    function getVisitorId() {
        try {
            let v = localStorage.getItem(VISITOR_KEY);
            if (!v) {
                v = uuid();
                localStorage.setItem(VISITOR_KEY, v);
            }
            return v;
        } catch (_) {
            return 'anon';
        }
    }

    function getSessionId() {
        try {
            const now = Date.now();
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.id && (now - parsed.last) < SESSION_TIMEOUT_MS) {
                    parsed.last = now;
                    sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
                    return parsed.id;
                }
            }
            const id = 'ts_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, last: now }));
            return id;
        } catch (_) {
            return 'ts_fallback';
        }
    }

    function getUtmRid() {
        try {
            let v = sessionStorage.getItem(UTM_RID_KEY);
            if (v) return v;
            const fromUrl = new URLSearchParams(location.search).get(UTM_RID_KEY);
            if (fromUrl) {
                // Token is opaque to the storefront — never decode, just forward.
                // Length-cap defends against URL-bomb edge cases without altering content.
                v = String(fromUrl).slice(0, 512);
                sessionStorage.setItem(UTM_RID_KEY, v);
                return v;
            }
        } catch (_) { /* private mode etc. — fall through */ }
        return null;
    }

    function getApiUrl() {
        if (typeof Config !== 'undefined' && Config.API_URL) return Config.API_URL;
        return (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
            ? 'http://localhost:3001'
            : 'https://ink-backend-zaeq.onrender.com';
    }

    // Resolve the current Supabase access token, optionally waiting for Auth.init().
    // Returns null synchronously on the first pageview if Auth hasn't hydrated yet
    // and the readyPromise doesn't resolve within AUTH_READY_TIMEOUT_MS — by design:
    // analytics must never gate the page. The backend uses optionalAuth so anonymous
    // events still record (just without `authenticated_visitors` attribution).
    async function getAccessToken() {
        try {
            const a = window.Auth;
            if (!a) return null;
            if (a.session && a.session.access_token) return a.session.access_token;
            if (a.readyPromise && typeof a.readyPromise.then === 'function') {
                let timer;
                const timeout = new Promise(resolve => {
                    timer = setTimeout(resolve, AUTH_READY_TIMEOUT_MS);
                });
                await Promise.race([a.readyPromise, timeout]);
                clearTimeout(timer);
                return (window.Auth && window.Auth.session && window.Auth.session.access_token) || null;
            }
        } catch (_) { /* never throw out of analytics */ }
        return null;
    }

    async function send(payload) {
        const url = getApiUrl() + '/api/analytics/traffic-event';
        const body = JSON.stringify(payload);
        try {
            const token = await getAccessToken();
            if (token) {
                // Authenticated: must use fetch so we can attach Authorization.
                // keepalive: true lets the request survive page unload (size-capped
                // at ~64KB per the spec — our payloads are well under).
                fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body,
                    keepalive: true,
                    credentials: 'omit',
                }).catch(() => { /* analytics must never break the page */ });
                return;
            }
            // Anonymous: sendBeacon is still the most reliable unload-time delivery.
            if (navigator.sendBeacon) {
                const blob = new Blob([body], { type: 'application/json' });
                if (navigator.sendBeacon(url, blob)) return;
            }
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
                credentials: 'omit',
            }).catch(() => {});
        } catch (_) { /* analytics must never break the page */ }
    }

    function getUtms() {
        try {
            const p = new URLSearchParams(location.search);
            return {
                utm_source: p.get('utm_source') || null,
                utm_medium: p.get('utm_medium') || null,
                utm_campaign: p.get('utm_campaign') || null,
                utm_term: p.get('utm_term') || null,
                utm_content: p.get('utm_content') || null,
                gclid: p.get('gclid') || null,
                fbclid: p.get('fbclid') || null,
            };
        } catch (_) { return {}; }
    }

    function baseEvent(type, extra) {
        const evt = Object.assign({
            session_id: getSessionId(),
            visitor_id: getVisitorId(),
            event_type: type,
            path: location.pathname + location.search,
            referrer: document.referrer || '',
        }, getUtms(), {
            user_agent: navigator.userAgent || '',
            language: navigator.language || '',
            screen_w: screen.width || 0,
            screen_h: screen.height || 0,
            viewport_w: window.innerWidth || 0,
            viewport_h: window.innerHeight || 0,
            ts: new Date().toISOString(),
        }, extra || {});
        const rid = getUtmRid();
        if (rid) evt.utm_rid = rid;
        return evt;
    }

    function trackPageview() {
        send(baseEvent('pageview'));
    }

    /**
     * One cap, applied AFTER the prefix, for every branch of labelFor().
     * Previously three branches capped at 80 and the button branch capped its
     * text at 40 BEFORE concatenation (a 44-char ceiling), so the same column
     * carried two different budgets and neither was named.
     */
    function cap(value) {
        return String(value).slice(0, ELEMENT_MAX_CHARS);
    }

    function labelFor(el) {
        if (!el) return null;
        if (el.dataset && el.dataset.track) return cap(el.dataset.track);
        if (el.id) return cap('#' + el.id);
        const a = el.closest && el.closest('a[href]');
        if (a) {
            try {
                const u = new URL(a.href, location.href);
                return cap('link:' + (u.hostname === location.hostname ? u.pathname : u.hostname));
            } catch (_) { return 'link'; }
        }
        const btn = el.closest && el.closest('button');
        if (btn) {
            // The old form was `('btn:' + text) || 'btn'`, whose fallback could
            // never run: the left operand always held at least the truthy 'btn:',
            // so a button with no text recorded the literal "btn:".
            const text = (btn.textContent || '').trim();
            return text ? cap('btn:' + text) : 'btn';
        }
        return null;
    }

    function onClick(e) {
        const target = e.target.closest('a, button, [data-track]');
        if (!target) return;
        const label = labelFor(target);
        if (!label) return;
        send(baseEvent('click', { element: label }));
    }

    function init() {
        // Capture utm_rid as early as possible so it's persisted even if the user
        // bounces before DOMContentLoaded fires.
        getUtmRid();

        // Fire pageview after DOM is settled so referrer is reliable.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', trackPageview, { once: true });
        } else {
            trackPageview();
        }
        document.addEventListener('click', onClick, { capture: true, passive: true });

        // SPA-style path changes (history API) — history.pushState isn't used much here
        // but wiring it up cheaply guards future changes.
        let lastPath = location.pathname + location.search;
        const checkPath = () => {
            const now = location.pathname + location.search;
            if (now !== lastPath) {
                lastPath = now;
                trackPageview();
            }
        };
        window.addEventListener('popstate', checkPath);
        const origPush = history.pushState;
        history.pushState = function () {
            const r = origPush.apply(this, arguments);
            setTimeout(checkPath, 0);
            return r;
        };
    }

    /* ──────────────────────────────────────────────────────────────────────
     * ANALYTICS IDENTITY — the join key, shared with search
     * (data-tracking-capture-fe-handoff-aug2026 §1.1)
     *
     * search_analytics (11,976 rows) and search_clicks stored an IP and nothing
     * else, so a search could never be joined to the order it produced. That is
     * why /api/admin/analytics/search/top-converting has always answered
     * `orders: null, conversion_pct: null` — a stub, not a bug.
     *
     * The fix is to send the ids THIS module already mints, so search, pageviews
     * and orders land on one key. Three rules make that safe, and they live here
     * — one owner, one vocabulary — rather than at six call sites:
     *
     * 1. NEVER MINT FROM A SEARCH. These readers only ever return what the
     *    pageview beacon already established. Both opt-outs at the top of this
     *    file (DNT, and any /admin path) return before `window.TrafficTracker`
     *    is ever assigned, so a page that must not be tracked has no accessor to
     *    call and sends no ids. Opt-out is INHERITED, never re-implemented — a
     *    second copy of that rule is a second thing to get wrong.
     *
     * 2. VALIDATE, NEVER SANITISE. The backend rejects a malformed id outright
     *    rather than cleaning it up, because a mangled id groups with nothing and
     *    still looks like real data. We hold the same line one step earlier: an
     *    id that fails ID_PATTERN is simply not sent.
     *
     * 3. SUPPRESS THE COLLISION SENTINELS. getVisitorId()/getSessionId() answer
     *    the literals 'anon' / 'ts_fallback' when web storage throws — private
     *    browsing, quota, a locked-down profile. Both satisfy ID_PATTERN, so
     *    without this every such visitor on earth would merge into ONE visitor
     *    and read downstream as a single enormous customer. A shared id is worse
     *    than no id: no id is an honest gap, a shared one is a lie with a number
     *    on it.
     *
     * TRANSPORT — BF-054 is CLOSED, and this note used to say the opposite.
     *
     * Measured 2026-08-31, when it was true: `X-Session-Id` / `X-Visitor-Id`
     * were absent from Access-Control-Allow-Headers, so a browser did not
     * degrade — it failed the preflight and NEVER SENT THE SEARCH AT ALL.
     * Taking that handoff's "works on all GET search endpoints" at face value
     * would have broken site search for every customer to gain an analytics
     * column. That is why the switch below shipped OFF with the reasoning
     * attached rather than as a TODO.
     *
     * Re-measured 2026-09-09, after the backend shipped the allow-list:
     *
     *   OPTIONS /api/shop  (Access-Control-Request-Headers: x-session-id,x-visitor-id)
     *     → 204, Access-Control-Allow-Headers:
     *       Content-Type,Authorization,X-Requested-With,X-Request-Id,
     *       X-Guest-Session,X-Attribution-Source,X-Session-Id,X-Visitor-Id
     *
     *   ...on https://inkcartridges.co.nz, https://www.inkcartridges.co.nz AND
     *   http://localhost:3000 — all three, because an allow-list that only
     *   covers www is a header that works in production and not in dev.
     *
     * WITH A NEGATIVE CONTROL, which is the whole reason to trust it: asking
     * for `x-totally-bogus-header` returns the SAME list, unchanged. The
     * preflight is not echoing what it is asked. That distinction is exactly
     * what ERR-223 recorded ("a preflight 204s whatever you ask ⇒ curl can't
     * adjudicate CORS") — a preflight that answers 204 to everything proves
     * nothing, and this one demonstrably does not.
     *
     * ONE TRANSPORT ON SEARCH NOW — THE HEADER. The note above used to end
     * "when the header is confirmed landing rows, the params come off — and not
     * before (ERR-158)". Both halves of that condition arrived on 2026-09-10,
     * and this is the record of them (ERR-253).
     *
     *   1. THE HEADER LANDS ROWS, AND THE PARAMS NEVER COULD. The backend
     *      measured the switch-on: smart searches went 0 session ids on 09-05
     *      through 09-08, then 37 of 115 on 09-09 — the day the allow-list
     *      deployed. And the reason the params produced nothing for six months
     *      was never CORS: `validate(schema, 'query')` runs Joi with
     *      `stripUnknown: true` and REPLACES `req.query` with the validated
     *      value, and `sid`/`vid` were in none of the three search schemas, so
     *      they were deleted before the handler read them. Two independent
     *      faults, one per transport, presenting as one symptom. Carrying both
     *      until an answer arrived is the only reason we did not drop the
     *      working half to keep the broken one.
     *
     *   2. /api/search/* IS NOW EDGE-CACHED, which is the condition the note
     *      below this one named in advance. Measured here 2026-09-10 against
     *      api.inkcartridges.co.nz on a cold query:
     *
     *        GET /api/search/smart?q=hp305xl   MISS  3.39s
     *        GET /api/search/smart?q=hp305xl   HIT   0.057s      ← 60x
     *        GET /api/search/suggest?q=lc73xl  MISS, MISS, HIT
     *
     *      Cloudflare's cache key is the URL and EXCLUDES custom request
     *      headers. A per-visitor `?sid=` therefore gives every visitor their
     *      own cache entry and hands all of that back, one visitor at a time.
     *      The header cannot do that, because it is not in the key.
     *
     *      SECOND, INDEPENDENT REASON, measured the same day: an edge HIT does
     *      not reach the origin, so it does not spend rate-limit budget.
     *      `ratelimit-remaining` went 29 → 28 across two MISSes and did not
     *      move across two HITs. Shattering the cache key would push every
     *      search to a 2.3s origin AND spend from the search bucket.
     *
     *      THE BUCKET IS PER ENDPOINT, NOT PER PREFIX. The backend's own
     *      response document says "/api/search/* is governed by ONE limiter,
     *      30/min". Measured 2026-09-12, it is not:
     *
     *        /api/search/smart        ratelimit-policy: 30;w=60
     *        /api/search/by-printer   ratelimit-policy: 30;w=60
     *        /api/search/suggest      ratelimit-policy: 120;w=60
     *        /api/search/autocomplete ratelimit-policy: 120;w=60
     *
     *      None of them carry `x-ratelimit-*` — the global /api/ limiter really
     *      does skip /search/. Never port a number from one of these to
     *      another; the tight one is the dropdown's.
     *
     * WHAT STAYED. `identifyQuery()` and `identifyUrl()` below are NOT dead and
     * must not be tidied away: POST /api/cart/items still carries `?sid=`, it is
     * not edge-cached, and it is the transport that measurably lands ITS rows
     * (pinned by ads-add-to-cart-conversion-sep2026 §5). This change is scoped
     * to the two search endpoints and nothing else.
     *
     * The header is enrolled PER-HELPER in api.js `request()`, never globally:
     * it makes a GET non-simple, and the CORS-preflight cache is keyed by full
     * URL, so a blanket stamp would add an OPTIONS round-trip per distinct
     * catalog and typeahead URL on the site.
     * ────────────────────────────────────────────────────────────────────── */
    const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
    const COLLIDING_IDS = ['anon', 'ts_fallback'];
    const USE_ID_HEADERS = true; // BF-054 closed 2026-09-08 — see probe:data-capture §1

    /** The id, or null. Null means "we don't know", and nothing is sent. */
    function usableId(value) {
        if (typeof value !== 'string') return null;
        if (!ID_PATTERN.test(value)) return null;
        if (COLLIDING_IDS.indexOf(value) !== -1) return null;
        return value;
    }

    /**
     * { session_id, visitor_id } — either key may be absent, and the whole
     * result is null when neither id is usable. A partial answer is still worth
     * sending: a visitor id with no session still joins a search to a person.
     */
    function getIds() {
        const out = {};
        const session = usableId(getSessionId());
        const visitor = usableId(getVisitorId());
        if (session) out.session_id = session;
        if (visitor) out.visitor_id = visitor;
        return (session || visitor) ? out : null;
    }

    /**
     * Stamp ?sid=/?vid= onto a GET search request. Accepts a plain params object
     * (API.catalogEndpoint) or a URLSearchParams (API.searchSuggest), and returns
     * the same kind it was given, unchanged when there is nothing to add — an
     * empty `sid=` is not a smaller version of the truth, it is a different and
     * wrong one.
     */
    function identifyQuery(params) {
        const ids = getIds();
        if (!ids) return params;
        const isUsp = params && typeof params.append === 'function';
        const target = params || {};
        if (ids.session_id) { isUsp ? target.set('sid', ids.session_id) : (target.sid = ids.session_id); }
        if (ids.visitor_id) { isUsp ? target.set('vid', ids.visitor_id) : (target.vid = ids.visitor_id); }
        return target;
    }

    /** Stamp ?sid=/?vid= onto an already-built URL string (the raw-fetch callers). */
    function identifyUrl(url) {
        const ids = getIds();
        if (!ids || typeof url !== 'string' || !url) return url;
        const parts = [];
        if (ids.session_id) parts.push('sid=' + encodeURIComponent(ids.session_id));
        if (ids.visitor_id) parts.push('vid=' + encodeURIComponent(ids.visitor_id));
        if (!parts.length) return url;
        return url + (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
    }

    /** Stamp session_id/visitor_id into a POST body (the click beacon). */
    function identifyBody(body) {
        const ids = getIds();
        if (!ids || !body || typeof body !== 'object') return body;
        if (ids.session_id) body.session_id = ids.session_id;
        if (ids.visitor_id) body.visitor_id = ids.visitor_id;
        return body;
    }

    /**
     * Stamp the ids onto a headers object, in place, and return it.
     *
     * This returned `{}` unchanged for six months while BF-054 was open, so
     * every call site was already written correctly and none of them needed
     * editing when the allow-list landed — the switch above was the only edit.
     * It still returns the object untouched whenever there is no usable id
     * (DNT, /admin, private browsing, a sentinel), so an unknown visitor sends
     * no header rather than a placeholder one.
     */
    function identifyHeaders(headers) {
        const target = headers || {};
        if (!USE_ID_HEADERS) return target;
        const ids = getIds();
        if (!ids) return target;
        if (ids.session_id) target['X-Session-Id'] = ids.session_id;
        if (ids.visitor_id) target['X-Visitor-Id'] = ids.visitor_id;
        return target;
    }

    init();
    window.TrafficTracker = {
        trackPageview,
        send: (type, extra) => send(baseEvent(type, extra)),
        // The analytics join key. Read-only: these never mint an id that the
        // pageview beacon has not already established, and they do not exist at
        // all under DNT or on /admin.
        getIds,
        identifyQuery,
        identifyUrl,
        identifyBody,
        identifyHeaders,
        // exposed for tests + diagnostics; do not rely on these in product code
        _usableId: usableId,
        _useIdHeaders: () => USE_ID_HEADERS,
        _getUtmRid: getUtmRid,
        _getAccessToken: getAccessToken,
    };
})();
