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
    if (location.pathname.startsWith('/admin') || location.pathname.startsWith('/admin')) return;

    const SESSION_KEY = 'ic_traffic_session';
    const VISITOR_KEY = 'ic_traffic_visitor';
    const UTM_RID_KEY = 'utm_rid'; // sessionStorage; spec-mandated key name
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
    const AUTH_READY_TIMEOUT_MS = 1200; // bound first-pageview wait so tracking never blocks the page

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

    function labelFor(el) {
        if (!el) return null;
        if (el.dataset && el.dataset.track) return el.dataset.track.slice(0, 80);
        if (el.id) return ('#' + el.id).slice(0, 80);
        const a = el.closest && el.closest('a[href]');
        if (a) {
            try {
                const u = new URL(a.href, location.href);
                return ('link:' + (u.hostname === location.hostname ? u.pathname : u.hostname)).slice(0, 80);
            } catch (_) { return 'link'; }
        }
        const btn = el.closest && el.closest('button');
        if (btn) return ('btn:' + (btn.textContent || '').trim().slice(0, 40)) || 'btn';
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
     * TRANSPORT — measured against production 2026-08-31, and it is NOT what the
     * handoff recommends. `X-Session-Id` / `X-Visitor-Id` are absent from the
     * backend's CORS allow-list:
     *
     *   OPTIONS /api/search/smart  (Access-Control-Request-Headers: x-session-id)
     *     → 204, Access-Control-Allow-Headers:
     *       Content-Type,Authorization,X-Requested-With,X-Request-Id,
     *       X-Guest-Session,X-Attribution-Source          ← neither id header
     *
     * A browser does not degrade there — it fails the preflight and NEVER SENDS
     * THE SEARCH AT ALL. Taking the handoff's "default, works on all GET search
     * endpoints" at face value would have broken site search for every customer
     * to gain an analytics column. So GET search uses the documented ?sid=/?vid=
     * fallback instead, which is free here: /api/search/smart and /suggest both
     * answer `cf-cache-status: DYNAMIC` on both hosts, so the extra params
     * fragment no edge cache (the ERR-124/159 hazard does not bite). The POST
     * click beacon carries them in its body, as specified.
     *
     * USE_ID_HEADERS is the one-line switch for the day the allow-list gains
     * them. Leave it false until `npm run probe:data-capture` says otherwise —
     * flipping it early does not degrade, it takes search down.
     * ────────────────────────────────────────────────────────────────────── */
    const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
    const COLLIDING_IDS = ['anon', 'ts_fallback'];
    const USE_ID_HEADERS = false; // BF-054 — see probe:data-capture §1

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
     * Headers, for the day BF-054 lands. Returns {} today so a caller that
     * spreads it is already written correctly and needs no edit later.
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
