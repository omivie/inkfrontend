/**
 * REWARDS-NUDGE.JS — guest loyalty-points account nudge (Jul 2026)
 * ================================================================
 * A compact, calm, NON-MODAL popover anchored under the header Account
 * button, shown to guests only, inviting them to create an account so
 * future orders earn loyalty points. No overlay, no focus trap, never
 * blocks navigation.
 *
 * Honesty contract (pinned by tests/rewards-nudge-jul2026.test.js):
 * every claim in CAMPAIGN copy is verified against the live loyalty
 * program (html/account/loyalty.html + cart loyalty control). The
 * program has no registration reward and no way to attach a guest
 * order after the fact, so the copy promises neither — it speaks only
 * about earning on future orders as an account holder.
 *
 * Frequency contract:
 *   - max once per browser session (sessionStorage flag + in-memory)
 *   - explicit dismissal (close ×, Escape, "Maybe later") hides it for
 *     CAMPAIGN.dismissDays via localStorage `ic_rewards_nudge`
 *   - outside click / conflicting menu opening hides it for the
 *     session only (weaker signal than an explicit dismissal)
 *   - signing in tears it down immediately and permanently
 *   - bump CAMPAIGN.version to re-arm every visitor (state resets)
 *
 * Depends on (all earlier in the defer chain): Config (BREAKPOINTS,
 * MQ_DESKTOP_NAV), Security (escapeHtml), utils.js (getStorage,
 * setStorage, DebugLog), Auth (readyPromise, isAuthenticated,
 * onAuthStateChange). Analytics (TrafficTracker / gtag) are optional
 * and guarded — they may be absent under DNT or ad blocking.
 */

'use strict';

(function () {
    // ─── Campaign configuration (edit copy/behaviour here) ──────────
    var CAMPAIGN = {
        version: 1,             // bump to re-arm after a dismissal cycle
        enabled: true,
        delayMs: 6000,          // shown ~6s after load once auth settles
        dismissDays: 7,         // explicit-dismissal cooldown
        trigger: 'timer',       // reserved for future: 'scroll' | 'exit'
        heading: 'Earn rewards on every order',
        body: 'Create a free account and earn 1 point for every $1 you spend (excluding shipping). 100 points = $1 off a future order.',
        ctaText: 'Create free account',
        ctaHref: '/account/login?tab=register',
        laterText: 'Maybe later',
        skipPaths: ['/cart']    // browsing pages only — never mid-funnel
    };

    var STORAGE_KEY = 'ic_rewards_nudge';
    var SESSION_KEY = 'ic_rewards_nudge_session';
    var AUTH_READY_TIMEOUT_MS = 1200;   // same race as traffic-tracker.js
    var RETRY_MS = 3000;
    var MAX_RETRIES = 5;
    var EDGE_MARGIN = 12;               // min gap to viewport edges
    var MAX_WIDTH = 360;

    var state = {
        el: null,
        anchor: null,
        open: false,
        shownAt: 0,
        retries: 0,
        bailed: false,
        shownThisPage: false,
        cleanups: []
    };

    // ─── Storage ─────────────────────────────────────────────────────
    function readState() {
        var s = getStorage(STORAGE_KEY, null);
        if (!s || s.v !== CAMPAIGN.version) {
            // Unknown or older campaign version → fresh state (re-arm)
            return { v: CAMPAIGN.version, dismissedAt: 0, ctaClickedAt: 0, lastShownAt: 0, shownCount: 0 };
        }
        return s;
    }

    function writeState(patch) {
        var s = readState();
        for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
        }
        setStorage(STORAGE_KEY, s);
        return s;
    }

    function sessionShown() {
        try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (_) { return false; }
    }

    function markSessionShown() {
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (_) { /* private mode */ }
    }

    // ─── Analytics (both layers optional — never throw) ─────────────
    function deviceCategory() {
        try {
            if (window.matchMedia(Config.MQ_DESKTOP_NAV).matches) return 'desktop';
            if (window.matchMedia('(min-width: ' + Config.BREAKPOINTS.tablet + 'px)').matches) return 'tablet';
        } catch (_) { /* fall through */ }
        return 'mobile';
    }

    function cartCount() {
        try { return parseInt(localStorage.getItem('cart_count'), 10) || 0; } catch (_) { return 0; }
    }

    function track(name, extra) {
        var props = {
            campaign_version: CAMPAIGN.version,
            trigger: CAMPAIGN.trigger,
            device: deviceCategory(),
            cart_count: cartCount()
        };
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) props[k] = extra[k];
        }
        try { if (window.TrafficTracker) TrafficTracker.send(name, props); } catch (_) { /* analytics never gate UX */ }
        try { if (typeof gtag === 'function') gtag('event', name, props); } catch (_) { /* consent-gated */ }
    }

    // ─── Eligibility gates ───────────────────────────────────────────
    function onSkippedPath() {
        // Normalize away the raw-file shape (/html/cart.html, local serve)
        // so skip rules match it AND the production pretty URL (/cart).
        var path = window.location.pathname
            .replace(/^\/html(?=\/)/, '')
            .replace(/\.html$/, '')
            .replace(/\/+$/, '') || '/';
        return CAMPAIGN.skipPaths.some(function (p) {
            return path === p || path.indexOf(p + '/') === 0;
        });
    }

    function authCookieHint() {
        // Synchronous pre-hydration hint set by auth.js — flash-free
        // guest check before the Supabase session has hydrated.
        try { return document.cookie.indexOf('__ink_auth=1') !== -1; } catch (_) { return false; }
    }

    function dismissedRecently() {
        var s = readState();
        if (!s.dismissedAt) return false;
        return (Date.now() - s.dismissedAt) < CAMPAIGN.dismissDays * 86400000;
    }

    function headerUiOpen() {
        // Any conflicting header surface: mega panels, mobile nav, search dropdown
        if (document.querySelector('.nav-mega-toggle[aria-expanded="true"]')) return true;
        if (document.querySelector('.nav-toggle[aria-expanded="true"]')) return true;
        if (document.querySelector('.smart-ac-dropdown.is-open')) return true;
        return false;
    }

    function userIsTyping() {
        var el = document.activeElement;
        if (!el) return false;
        if (el.isContentEditable) return true;
        var tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    // ─── DOM ─────────────────────────────────────────────────────────
    function buildEl() {
        if (state.el) return state.el;
        var esc = Security.escapeHtml;
        var redirect = encodeURIComponent(window.location.pathname + window.location.search);
        var href = CAMPAIGN.ctaHref + '&redirect=' + redirect;

        var el = document.createElement('aside');
        el.id = 'rewards-nudge';
        el.className = 'rewards-nudge';
        el.hidden = true;
        el.setAttribute('role', 'complementary');
        el.setAttribute('aria-labelledby', 'rewards-nudge-title');
        el.setAttribute('aria-describedby', 'rewards-nudge-body');
        el.innerHTML =
            '<button type="button" class="rewards-nudge__close" aria-label="Dismiss rewards message">' +
                '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
                    '<path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
                '</svg>' +
            '</button>' +
            '<div class="rewards-nudge__head">' +
                '<span class="rewards-nudge__icon" aria-hidden="true">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none">' +
                        '<path d="M12 2l2.4 6.2 6.6.3-5.2 4.2 1.8 6.3L12 15.4 6.4 19l1.8-6.3L3 8.5l6.6-.3L12 2z" fill="currentColor"/>' +
                    '</svg>' +
                '</span>' +
                '<h2 id="rewards-nudge-title" class="rewards-nudge__title">' + esc(CAMPAIGN.heading) + '</h2>' +
            '</div>' +
            '<p id="rewards-nudge-body" class="rewards-nudge__body">' + esc(CAMPAIGN.body) + '</p>' +
            '<a class="rewards-nudge__cta" href="' + Security.escapeAttr(href) + '">' + esc(CAMPAIGN.ctaText) + '</a>' +
            '<button type="button" class="rewards-nudge__later">' + esc(CAMPAIGN.laterText) + '</button>';

        document.body.appendChild(el);
        state.el = el;
        return el;
    }

    // ─── Positioning ─────────────────────────────────────────────────
    function position() {
        var el = state.el;
        var anchor = state.anchor;
        if (!el || !anchor) return;

        var vw = document.documentElement.clientWidth;
        var isNarrow = !window.matchMedia('(min-width: ' + Config.BREAKPOINTS.tablet + 'px)').matches;

        if (isNarrow) {
            // Compact card below the (sticky) header, full width minus margins
            el.classList.add('rewards-nudge--card');
            var header = document.querySelector('.site-header');
            var hb = header ? header.getBoundingClientRect().bottom : 0;
            el.style.setProperty('--rn-top', Math.max(hb + 8, EDGE_MARGIN) + 'px');
            el.style.setProperty('--rn-left', EDGE_MARGIN + 'px');
            el.style.setProperty('--rn-width', (vw - EDGE_MARGIN * 2) + 'px');
        } else {
            el.classList.remove('rewards-nudge--card');
            var rect = anchor.getBoundingClientRect();
            var width = Math.min(MAX_WIDTH, vw - EDGE_MARGIN * 2);
            var left = Math.min(Math.max(rect.right - width, EDGE_MARGIN), vw - width - EDGE_MARGIN);
            var top = rect.bottom + 10;
            var caretX = Math.min(Math.max(rect.left + rect.width / 2 - left, 16), width - 16);
            el.style.setProperty('--rn-top', Math.round(top) + 'px');
            el.style.setProperty('--rn-left', Math.round(left) + 'px');
            el.style.setProperty('--rn-width', Math.round(width) + 'px');
            el.style.setProperty('--rn-caret-x', Math.round(caretX) + 'px');
        }
    }

    // ─── Show / hide ─────────────────────────────────────────────────
    function addCleanup(target, event, handler, opts) {
        target.addEventListener(event, handler, opts);
        state.cleanups.push(function () { target.removeEventListener(event, handler, opts); });
    }

    function show() {
        if (state.open || state.bailed) return;
        var el = buildEl();
        state.shownThisPage = true;
        state.shownAt = Date.now();
        markSessionShown();
        var s = readState();
        writeState({ lastShownAt: state.shownAt, shownCount: (s.shownCount || 0) + 1 });

        position();
        el.hidden = false;
        // Two-step reveal so the opening transition runs (mega-panel convention)
        void el.offsetWidth;
        el.classList.add('is-open');
        state.open = true;
        track('rewards_nudge_shown', {});

        // Interaction listeners — attached only while visible
        addCleanup(document, 'keydown', onKeydown);
        addCleanup(document, 'click', onDocClick, true);
        addCleanup(document, 'focusin', onFocusIn);
        addCleanup(window, 'scroll', onReflow, { passive: true });
        addCleanup(window, 'resize', onReflow);

        el.querySelector('.rewards-nudge__close').addEventListener('click', function () { dismiss('close'); });
        el.querySelector('.rewards-nudge__later').addEventListener('click', function () { dismiss('later'); });
        el.querySelector('.rewards-nudge__cta').addEventListener('click', function () {
            writeState({ ctaClickedAt: Date.now() });
            track('rewards_nudge_cta_clicked', { dwell_ms: Date.now() - state.shownAt });
            // navigation proceeds; sendBeacon survives unload
        });
    }

    function hide(reason, persistDismissal) {
        if (!state.open) return;
        state.open = false;
        var el = state.el;

        state.cleanups.forEach(function (fn) { fn(); });
        state.cleanups = [];

        if (persistDismissal) writeState({ dismissedAt: Date.now() });
        track('rewards_nudge_dismissed', { reason: reason, dwell_ms: Date.now() - state.shownAt });

        // Restore focus to the Account anchor only if focus was inside the nudge
        if (el.contains(document.activeElement) && state.anchor) {
            state.anchor.focus();
        }

        el.classList.remove('is-open');
        var done = false;
        var finish = function () {
            if (done) return;
            done = true;
            el.hidden = true;
        };
        el.addEventListener('transitionend', finish, { once: true });
        setTimeout(finish, 250); // fallback if transitions are disabled
    }

    // Explicit dismissal → cooldown for CAMPAIGN.dismissDays
    function dismiss(reason) { hide(reason, true); }
    // Soft close (outside click / conflicting UI / sign-in) → session only
    function softClose(reason) { hide(reason, false); }

    // ─── Interaction handlers ────────────────────────────────────────
    function onKeydown(e) {
        if (e.key === 'Escape') dismiss('escape');
    }

    function onDocClick(e) {
        if (!state.open) return;
        var t = e.target;
        if (t.closest && t.closest('.rewards-nudge')) return; // inside
        if (t.closest && (t.closest('.nav-mega-toggle') || t.closest('.nav-toggle'))) {
            softClose('conflict'); // a header menu is opening
            return;
        }
        softClose('outside');
    }

    function onFocusIn(e) {
        // The search dropdown opens on input focus — treat as a conflict
        var t = e.target;
        if (t && t.closest && t.closest('.search-form') && !t.closest('.rewards-nudge')) {
            softClose('conflict');
        }
    }

    var reflowPending = false;
    function onReflow() {
        if (reflowPending || !state.open) return;
        reflowPending = true;
        window.requestAnimationFrame(function () {
            reflowPending = false;
            if (state.open) position();
        });
    }

    // ─── Trigger loop ────────────────────────────────────────────────
    function tryShow() {
        if (state.bailed || state.open || state.shownThisPage) return;
        try {
            if (window.Auth && Auth.isAuthenticated()) { state.bailed = true; return; }
        } catch (_) { /* keep going — guest assumption */ }

        if (document.visibilityState === 'hidden') {
            // Wait for the tab to come back rather than burning retries
            document.addEventListener('visibilitychange', function onVis() {
                document.removeEventListener('visibilitychange', onVis);
                setTimeout(tryShow, 1000);
            });
            return;
        }

        if (userIsTyping() || headerUiOpen()) {
            state.retries += 1;
            if (state.retries <= MAX_RETRIES) setTimeout(tryShow, RETRY_MS);
            return; // give up silently after MAX_RETRIES
        }

        show();
    }

    function init() {
        try {
            if (!CAMPAIGN.enabled) return;
            if (authCookieHint()) return;                 // signed in (fast path)
            state.anchor = document.querySelector('a.header-actions__item[href="/account"]');
            if (!state.anchor) return;                    // headerless page
            if (onSkippedPath()) return;                  // e.g. /cart
            if (sessionShown()) return;                   // once per session
            if (dismissedRecently()) return;              // 7-day cooldown

            // Tear down instantly if the visitor signs in while it's visible
            // (or before it shows) — registered once per page.
            if (window.Auth && typeof Auth.onAuthStateChange === 'function') {
                Auth.onAuthStateChange(function (event) {
                    if (event === 'SIGNED_IN') {
                        state.bailed = true;
                        if (state.open) softClose('signed_in');
                    }
                });
            }

            // Let auth hydrate (bounded — the nudge must never gate on a
            // slow network), then start the delay timer.
            var authSettled = (window.Auth && Auth.readyPromise && typeof Auth.readyPromise.then === 'function')
                ? Promise.race([
                    Auth.readyPromise,
                    new Promise(function (r) { setTimeout(r, AUTH_READY_TIMEOUT_MS); })
                ])
                : Promise.resolve();

            authSettled.then(function () {
                try {
                    if (window.Auth && Auth.isAuthenticated()) { state.bailed = true; return; }
                } catch (_) { /* guest assumption */ }
                setTimeout(tryShow, CAMPAIGN.delayMs);
            });
        } catch (err) {
            DebugLog.error('RewardsNudge init failed:', err);
        }
    }

    // Manual reopen hook (future "Earn points" header hint) — respects
    // auth + path gates but bypasses the frequency caps on purpose.
    function openManually() {
        if (!state.anchor || onSkippedPath()) return;
        try { if (window.Auth && Auth.isAuthenticated()) return; } catch (_) { /* guest assumption */ }
        state.bailed = false;
        state.shownThisPage = false;
        show();
    }

    window.RewardsNudge = { open: openManually, _state: state, _campaign: CAMPAIGN };

    document.addEventListener('DOMContentLoaded', init);
})();
