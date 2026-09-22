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
 * Geometry contract (ERR-276, pinned by
 * tests/mobile-cta-occlusion-sep2026.test.js and measured by
 * `npm run probe:mobile-cta`): below Config.BREAKPOINTS.tablet this
 * popover is not a popover. position() turns it into a fixed,
 * full-width card at --z-popover pinned under the sticky header, and
 * on the buying path that card lands on the Add to Cart button. So it
 * never shows there on a phone; it re-arms for the add-to-cart toast
 * instead. Desktop behaviour is unchanged in every respect.
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
        delayMs: 3000,          // MINIMUM dwell before the nudge may appear (owner-tuned Jul 17, was 6s)
        dismissDays: 7,         // explicit-dismissal cooldown
        /* 'scroll' — the visitor must have actually looked at something first.
         *
         * On a timer this fired 3s after load, which on mobile meant a 366x248
         * card covering 27.5% of the first screen with ZERO product cards
         * rendered on it (measured, /ink-cartridges at 390x844, ERR-224). Asking
         * someone to open an account before they have seen a single product is
         * asking at the worst possible moment, and it lands on the 64% of paid
         * traffic that arrives on mobile.
         *
         * 'scroll' keeps delayMs as a floor and adds evidence: the visitor has
         * moved down the page. If they never scroll, they never see it — which
         * is the correct outcome, not a missed one. 'timer' still works and is
         * what every other page can fall back to. */
        trigger: 'scroll',      // 'timer' | 'scroll'  ('exit' reserved)
        scrollThresholdPx: 600, // ~one mobile viewport; also cleared by a tall desktop scroll
        heading: 'Earn rewards on every order',
        body: 'Create a free account and earn 1 point for every $1 you spend (excluding shipping). 100 points = $1 off a future order.',
        ctaText: 'Create free account',
        ctaHref: '/account/login?tab=register',
        laterText: 'Maybe later',
        skipPaths: ['/cart'],   // browsing pages only — never mid-funnel

        /* NARROW VIEWPORTS ONLY — never over the buy button on a phone (ERR-276).
         *
         * `skipPaths` above is about FUNNEL STAGE and applies at every width.
         * This list is about GEOMETRY, and it only exists because of what
         * position() does below 768px: the nudge stops being a small popover
         * anchored to the Account button and becomes a `position: fixed`,
         * `vw - 24px` wide card pinned at `header.bottom + 8px`, at
         * --z-popover (600), re-pinned on every scroll by onReflow(). Measured
         * on a 390x844 iPhone it occupies y 144-392 — 248px, 37% of the visual
         * viewport — and #add-to-cart-btn sits at y 264-312, inside it.
         * `elementFromPoint` at that button's own centre returns the nudge.
         *
         * The trigger makes it worse rather than better: scrollThresholdPx is
         * 600, so on a PDP the card mounts at precisely the moment the shopper
         * scrolls down to the price. It is absent from the DOM at 1s, 3s and
         * 6s, which is why a QA pass that loads the page and waits reports this
         * fixed when it is not.
         *
         * EVERY SPELLING OF THE PATH IS HERE, and that is the part worth
         * checking before editing. onSkippedPath()'s normaliser turns the
         * local raw-file shape /html/product/index.html into `/product/index`,
         * which '/products' does NOT match — production serves the same page at
         * /products/:slug/:sku (vercel.json). Listing only the production
         * spelling would leave the gate dead on `npx serve`, where it gets
         * developed and demoed. '/ribbon' covers /ribbon/:sku without matching
         * the /ribbons browsing hub, which keeps its nudge on purpose.
         *
         * '/p' is the fourth PDP spelling and the one that nearly got away.
         * vercel.json rewrites /p/:sku to the backend, which 301s to
         * /products/:slug/:sku, so in production the browser only ever ends up
         * on the long form and '/p' looks redundant. It is not: serve.json
         * rewrites `p/**` to the PDP with NO redirect, so `npx serve` — where
         * this is developed and demoed — stays on /p/CLC37BK and the gate would
         * have been dead there. Caught by running the probe against localhost,
         * not by reading the list. It cannot over-match: pathMatches tests
         * `path === '/p'` or a '/p/' prefix, so /payment, /privacy and
         * /products are all untouched.
         *
         * /checkout and /payment do not load this file today. They are listed
         * anyway: the gate should be right the day somebody adds the script
         * tag, not the day somebody notices it is missing. */
        narrowSkipPaths: ['/products', '/product', '/p', '/ribbon', '/cart', '/checkout', '/payment'],

        /* The nudge is MOVED, not cancelled. When the gate above suppresses it,
         * it re-arms for the add-to-cart moment — the toast, when the buy
         * button has already been pressed and covering it costs nothing. */
        postAddDelayMs: 900
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
        /* ERR-276. Both are READ BY THE PROBE, not just by this file:
         * `npm run probe:mobile-cta` asserts suppressed === true on a PDP at
         * 390px and false at 1280px, which is a far more direct question than
         * "is a card covering the button right now" and it cannot be fooled by
         * a nudge that simply has not mounted yet. Exposed via
         * window.RewardsNudge._state. */
        suppressed: false,
        postAddArmed: false,
        /* ERR-280: below the tablet breakpoint the card lives IN the document,
           not over it. Set once by placeInFlow() so onReflow() cannot keep
           re-inserting it further down the page on every scroll frame. */
        placedInFlow: false,
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
    /* Normalize away the raw-file shape (/html/cart.html, local serve) so skip
     * rules match it AND the production pretty URL (/cart).
     *
     * `raw` is a TEST SEAM, and it is here on purpose. The alternative was a
     * test that re-implements this three-line normaliser and then asserts
     * against its own copy — which is how a probe once certified a REPLICA of
     * the search escaper while the real one was broken (ERR-231). Passing the
     * path in lets tests/mobile-cta-occlusion-sep2026.test.js run THIS
     * function, over every URL spelling the site serves, with no DOM at all.
     * Production never passes it. */
    function normalizedPath(raw) {
        var pathname = (typeof raw === 'string') ? raw : window.location.pathname;
        return pathname
            .replace(/^\/html(?=\/)/, '')
            .replace(/\.html$/, '')
            .replace(/\/+$/, '') || '/';
    }

    // ONE matcher, two lists. Both gates below normalise identically, so a path
    // spelling that is understood by one is understood by the other — the thing
    // that goes wrong otherwise is a second, subtly different copy of this
    // three-line normaliser (ERR-276).
    function pathMatches(list, raw) {
        var path = normalizedPath(raw);
        return (list || []).some(function (p) {
            return path === p || path.indexOf(p + '/') === 0;
        });
    }

    function onSkippedPath() {
        return pathMatches(CAMPAIGN.skipPaths);
    }

    /* THE SINGLE OWNER OF "is this a phone" for this file (ERR-276).
     *
     * position() used to spell this inline. The eligibility gate and the layout
     * branch must agree by construction: a gate that thinks it is desktop while
     * position() renders the fixed card is exactly the bug being fixed, one
     * media query away.
     *
     * Failure is treated as DESKTOP deliberately. matchMedia is universal in
     * every browser that can run this file, so a throw means a stubbed DOM (the
     * node:vm test harness), and defaulting to the desktop branch there keeps
     * the previous behaviour rather than silently suppressing the nudge
     * everywhere. */
    function isNarrow() {
        try {
            return !window.matchMedia('(min-width: ' + Config.BREAKPOINTS.tablet + 'px)').matches;
        } catch (_) {
            return false;
        }
    }

    function onNarrowSkippedPath() {
        return isNarrow() && pathMatches(CAMPAIGN.narrowSkipPaths);
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
        /* The cross-sell modal, which is the whole reason the post-add trigger
         * needs a back-off (ERR-276). cart.js#_showCrossSellModal appends
         * `.crosssell-modal` immediately after a successful add — the same
         * moment this nudge is now armed for. It is z-index 10000
         * (components.css:1602), far above --z-popover, so the nudge would not
         * cover it; it would sit invisible UNDERNEATH it and burn its
         * once-per-session budget on a card nobody ever saw.
         *
         * Safe as a liveness test: close() is `overlay.remove()`
         * (cart.js#_showCrossSellModal), so the node is gone from the DOM when
         * the modal is dismissed, and this selector cannot latch on. */
        if (document.querySelector('.crosssell-modal')) return true;
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

    // ─── Placement ───────────────────────────────────────────────────

    /**
     * The first thing in the page's own content that starts BELOW the fold.
     * The card is inserted before it, so the insertion shifts only pixels the
     * shopper cannot currently see.
     *
     * It descends rather than only looking at <main>'s direct children,
     * because a page whose <main> holds one full-height section (the shop
     * family is exactly this: main > .shop-page > .drilldown-content > …)
     * would otherwise offer no candidate at all and land the card after the
     * entire page, where nobody would reach it.
     *
     * It stops descending at any container that is not block-level. Inserting
     * into a grid or a flex row would make the card a GRID ITEM one column
     * wide, which is a different bug wearing this fix's clothes.
     */
    function flowAnchor() {
        var main = document.getElementById('main-content') || document.querySelector('main');
        return main ? searchForFold(main, 0) : null;
    }

    /**
     * THE STRADDLER WINS, AND THAT ORDERING IS THE WHOLE POINT.
     *
     * A container is searched for the first child that starts below the fold,
     * but a child that STRADDLES the fold is descended into first. The first
     * draft did it the other way round and landed the card 740px below the
     * viewport on /ink-cartridges: `main`'s children are `.shop-page` (which
     * straddles, and holds everything the shopper is looking at) and a
     * `.container` far below it, so taking the first child below the fold
     * skipped the entire page and put the card after it.
     *
     * Descending first puts the card at the nearest point below the fold
     * instead of the nearest point below the fold AT THE TOP LEVEL, which is a
     * different and much worse thing. Depth is capped so a deeply nested
     * layout cannot turn this into a walk of the whole tree on every show().
     */
    function searchForFold(container, depth) {
        var vh = window.innerHeight;
        var kids = container.children;
        var straddling = null;
        var firstBelow = null;

        for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (k === state.el || k.hidden) continue;
            var r = k.getBoundingClientRect();
            if (r.height === 0) continue;
            if (r.top >= vh) { if (!firstBelow) firstBelow = k; }
            else if (r.bottom > vh) straddling = k;
        }

        if (straddling && depth < 4 && isBlockLevel(straddling)) {
            var inner = searchForFold(straddling, depth + 1);
            if (inner) return inner;
        }
        return firstBelow ? { parent: container, before: firstBelow } : null;
    }

    /* Only block containers are descended into. Inserting between the items of
       a grid or a flex row would make the card a GRID ITEM one column wide —
       a different bug wearing this fix's clothes. */
    function isBlockLevel(el) {
        try {
            var d = window.getComputedStyle(el).display;
            return d === 'block' || d === 'flow-root';
        } catch (_) {
            return false;
        }
    }

    /**
     * Move the card into the document once, below the fold.
     *
     * ONCE is the load-bearing word: position() is called from onReflow() on
     * every scroll frame, and re-running the search each time would walk the
     * card down the page ahead of the shopper and never let them reach it.
     */
    function placeInFlow(el) {
        if (state.placedInFlow && el.parentNode && el.parentNode !== document.body) return;
        var spot = flowAnchor();
        if (spot) {
            spot.parent.insertBefore(el, spot.before);
        } else {
            /* Nothing below the fold — a page shorter than one screen. The end
               of the content is still off the bottom of it, so appending there
               keeps the promise this fix makes: the card never covers anything.
               If there is no <main> at all it stays where buildEl() put it. */
            var main = document.getElementById('main-content') || document.querySelector('main');
            if (main) main.appendChild(el);
        }
        state.placedInFlow = true;
    }

    /** Back to the popover, for a rotation that crosses the breakpoint. */
    function restoreToBody(el) {
        if (!state.placedInFlow) return;
        document.body.appendChild(el);
        state.placedInFlow = false;
    }

    // ─── Positioning ─────────────────────────────────────────────────
    function position() {
        var el = state.el;
        var anchor = state.anchor;
        if (!el || !anchor) return;

        var vw = document.documentElement.clientWidth;
        // isNarrow() is shared with the eligibility gate on purpose (ERR-276) —
        // see its definition. This used to be a second copy of the same
        // media query.

        if (isNarrow()) {
            /* IN FLOW, NOT OVER THE PAGE (ERR-280).
               Until 2026-09-22 this branch made the card `position: fixed` at
               --z-popover (600), pinned at `header.bottom + 8`. A fixed card
               owns a CONSTANT BAND of the viewport, so anything in normal flow
               travels up through it and is un-tappable while it is inside —
               which is the whole of ERR-224 (27.5% of the first screen on
               /ink-cartridges), the whole of ERR-276 (the Add to Cart button on
               every PDP) and, measured by `npm run probe:mobile-cta` §7, a card
               Add button at 32 of 92 scroll offsets on /ink-cartridges after
               ERR-276 had supposedly fixed it.

               ERR-276's gate was a PATH LIST, so it could only ever be as
               complete as the list — and the surface it did not cover is the
               one 68% of paid clicks land on. The mechanism is what is wrong on
               a phone: there is no band of a 390px viewport that is not either
               product or chrome. So below the tablet breakpoint the card stops
               being an overlay. It is inserted into the document just below the
               fold and the shopper scrolls into it, which covers nothing, ever,
               and cannot regress into covering something later.

               Placing it BELOW the fold is what keeps this free: a layout shift
               of content nobody can see scores no CLS, and /ink-cartridges is
               at 0.0088 with 0.1 the threshold (`npm run probe:shop-cls`).
               Desktop is untouched — the anchored popover below is unchanged. */
            el.classList.add('rewards-nudge--card');
            placeInFlow(el);
        } else {
            el.classList.remove('rewards-nudge--card');
            restoreToBody(el);
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
        /* ERR-280: click-outside-to-close is POPOVER behaviour. In flow the
           card is a block of the page like any other, and closing it because
           the shopper tapped a product would delete it on the first tap they
           make — on the surface it was moved in-flow to serve. It keeps its
           own close button and "Maybe later", which is how an in-flow card is
           meant to be dismissed. */
        if (state.placedInFlow) return;
        softClose('outside');
    }

    function onFocusIn(e) {
        // The search dropdown opens on input focus — treat as a conflict.
        // Only while the card is a popover: in flow it is nowhere near the
        // dropdown and there is nothing to be in conflict with (ERR-280).
        if (state.placedInFlow) return;
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

    /* THE NUDGE IS MOVED, NOT CANCELLED (ERR-276).
     *
     * Suppressing it on the phone buying path is the P0 fix, but "never ask a
     * mobile visitor to make an account" is not the outcome anyone wanted —
     * mobile is the majority of real traffic. So the ask relocates to the one
     * moment on that path where a popover costs nothing: the add-to-cart toast.
     * The buy button has already been pressed; covering it is now free.
     *
     * ONE-SHOT, and it removes its own listener before doing anything else. The
     * `?add=SKU:QTY` reorder deep link fires up to twelve adds in a row
     * (js/cart-deep-link.js), so an un-removed listener would queue twelve
     * show() attempts for one gesture.
     *
     * THE EMITTER LIVES IN ANOTHER FILE, which is the failure mode this comment
     * exists to flag: cart.js dispatches `cart:item-added`, this file listens.
     * Neither names the other in code, so a future edit can delete one half and
     * leave a green suite behind — ERR-214, where hash-locked markup and hand
     * enrolment left ten dead search boxes for four months. The pairing is
     * pinned as a pairing by tests/mobile-cta-occlusion-sep2026.test.js: the
     * dispatch in cart.js and the listener here are asserted in the SAME test,
     * so removing either one fails it.
     *
     * The delay lets the toast land first, and tryShow()'s existing back-off
     * (MAX_RETRIES x RETRY_MS) covers the cross-sell modal that may open in the
     * same instant — see headerUiOpen(). */
    function armPostAddTrigger() {
        if (state.postAddArmed) return;
        state.postAddArmed = true;
        var onAdded = function () {
            document.removeEventListener('cart:item-added', onAdded);
            state.suppressed = false;
            setTimeout(tryShow, CAMPAIGN.postAddDelayMs || 900);
        };
        try {
            document.addEventListener('cart:item-added', onAdded);
        } catch (_) { /* stubbed DOM in the node:vm harness — nothing to arm */ }
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

                /* THE P0 GATE (ERR-276). Narrow viewport + the money path =
                 * never on the way in. See CAMPAIGN.narrowSkipPaths for the
                 * measurement, and armPostAddTrigger() for where it goes
                 * instead. Desktop never reaches this branch: isNarrow() is
                 * false, so scheduleByTrigger runs exactly as before. */
                if (onNarrowSkippedPath()) {
                    state.suppressed = true;
                    armPostAddTrigger();
                    return;
                }
                scheduleByTrigger(tryShow);
            });
        } catch (err) {
            DebugLog.error('RewardsNudge init failed:', err);
        }
    }

    /**
     * Hand `tryShow` to whichever trigger the campaign is configured for.
     *
     * `delayMs` is a FLOOR in both modes, never the whole condition: the auth
     * check has to settle first, and a nudge that races the page render is the
     * thing being fixed here.
     *
     * 'scroll' waits for the visitor to move down the page as well. The listener
     * is passive and removes itself on the first qualifying scroll, so this
     * costs nothing on a page nobody scrolls. There is deliberately NO timer
     * fallback: a visitor who never scrolled has not looked at anything, and
     * showing them the nudge anyway is exactly the behaviour this replaces.
     */
    function scheduleByTrigger(tryShow) {
        if (CAMPAIGN.trigger !== 'scroll') {
            setTimeout(tryShow, CAMPAIGN.delayMs);
            return;
        }

        var floorPassed = false;
        var fired = false;
        var threshold = CAMPAIGN.scrollThresholdPx || 600;

        function scrolledEnough() {
            var y = window.pageYOffset || document.documentElement.scrollTop || 0;
            return y >= threshold;
        }

        function attempt() {
            if (fired || !floorPassed || !scrolledEnough()) return;
            fired = true;
            window.removeEventListener('scroll', attempt);
            tryShow();
        }

        setTimeout(function () {
            floorPassed = true;
            // A visitor who has already scrolled past the mark during the floor
            // (a fast reader, or a restored scroll position) qualifies now.
            attempt();
        }, CAMPAIGN.delayMs);

        window.addEventListener('scroll', attempt, { passive: true });
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

    /* `_pathMatches` and `_normalizePath` are exported for the same reason the
     * `raw` seam above exists: so the suite exercises the real matcher rather
     * than a copy of it. `_state` and `_campaign` are read by
     * `npm run probe:mobile-cta` in a live browser. Nothing in js/ calls any of
     * the underscore-prefixed members. */
    window.RewardsNudge = {
        open: openManually,
        _state: state,
        _campaign: CAMPAIGN,
        _pathMatches: pathMatches,
        _normalizePath: normalizedPath,
        /* ERR-280. Exported for the same reason _pathMatches is: the choice of
           insertion point is arithmetic with a right and a wrong answer, and a
           test that greps for the recursion cannot tell whether the straddling
           child is searched BEFORE the first child below the fold — which is
           the difference between landing the card 117px below the fold and
           landing it 740px below, after the whole page. Driven directly by
           tests/mobile-atc-dead-zone-sep2026.test.js. */
        _searchForFold: searchForFold,
    };

    document.addEventListener('DOMContentLoaded', init);
})();
