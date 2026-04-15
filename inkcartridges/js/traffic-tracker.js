/**
 * TRAFFIC TRACKER
 * ===============
 * Lightweight first-party pageview + click tracker.
 * Sends events to the backend which persists them to Supabase.
 * Read by the admin "Website Traffic" page.
 */
(function () {
    'use strict';

    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    if (location.pathname.startsWith('/html/admin') || location.pathname.startsWith('/admin')) return;

    const SESSION_KEY = 'ic_traffic_session';
    const VISITOR_KEY = 'ic_traffic_visitor';
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

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

    function getApiUrl() {
        if (typeof Config !== 'undefined' && Config.API_URL) return Config.API_URL;
        return (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
            ? 'http://localhost:3001'
            : 'https://ink-backend-zaeq.onrender.com';
    }

    function send(payload) {
        const url = getApiUrl() + '/api/analytics/traffic-event';
        const body = JSON.stringify(payload);
        try {
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

    function baseEvent(type, extra) {
        return Object.assign({
            session_id: getSessionId(),
            visitor_id: getVisitorId(),
            event_type: type,
            path: location.pathname + location.search,
            referrer: document.referrer || '',
            user_agent: navigator.userAgent || '',
            language: navigator.language || '',
            screen_w: screen.width || 0,
            screen_h: screen.height || 0,
            viewport_w: window.innerWidth || 0,
            viewport_h: window.innerHeight || 0,
            ts: new Date().toISOString(),
        }, extra || {});
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

    init();
    window.TrafficTracker = { trackPageview, send: (type, extra) => send(baseEvent(type, extra)) };
})();
