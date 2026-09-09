/**
 * CONSENT-BANNER.JS
 * =================
 * Writes the `cookie_consent` key that gtag.js has always read and nobody ever set.
 *
 * THE BUG THIS FIXES (ERR-227)
 * ----------------------------
 * js/gtag.js line 9 opens every page with:
 *
 *     gtag('consent', 'default', {
 *         analytics_storage: localStorage.getItem('cookie_consent') === 'accepted'
 *             ? 'granted' : 'denied'
 *     });
 *
 * That key was READ in exactly one place and WRITTEN in none — zero writes in the
 * whole repository. So the ternary took its right-hand branch for 100% of visitors
 * since the day it shipped: GA4 ran in cookieless ping mode for everyone, forever,
 * and nothing anywhere said so. A consent gate with no way to consent is not a
 * privacy feature, it is an off switch that looks like one.
 *
 * WHY THIS ONLY TOUCHES analytics_storage
 * ---------------------------------------
 * Read the default call again: it declares ONE consent type. Under Google Consent
 * Mode, a type you never mention is granted — so `ad_storage` is granted today and
 * Google Ads conversion tracking works. Adding `ad_storage: 'denied'` here, which
 * is the reflexive "complete" thing to do, would silently switch off the exact ad
 * measurement the mobile-checkout work (ERR-224) exists to rescue: mobile is ~64%
 * of paid-search traffic and is being bid on with numbers we already know are
 * short. So this banner controls analytics storage and says exactly that in its
 * copy. It does not over-claim, and it does not quietly widen its own remit.
 *
 * If ad consent is ever wanted, it is a deliberate decision with a revenue
 * consequence attached, taken with the Ads account open — not a line added here
 * because the list looked incomplete.
 *
 * DO NOT ROUTE THIS THROUGH setStorage() FROM utils.js
 * ---------------------------------------------------
 * `setStorage` JSON-stringifies, so it would persist `"accepted"` WITH QUOTES,
 * and gtag.js compares against the bare string `accepted`. The tidy-looking
 * refactor to the house helper re-breaks consent permanently and silently — the
 * banner would disappear on click and analytics would stay denied for ever. The
 * raw localStorage calls below are deliberate, and
 * tests/consent-mode-sep2026.test.js pins them.
 *
 * SHAPE
 * -----
 * A slim bottom bar, never a full-screen interstitial. This ships days after
 * ERR-224, where 400px of dead whitespace and an 858px summary put the first
 * checkout field 1,621px down an 844px viewport; adding an overlay that covers a
 * phone screen would be the same mistake wearing a different hat. While the bar is
 * visible it adds its own measured height as bottom padding on <body>, so it can
 * never sit on top of a Continue button. `npm run probe:mobile-checkout-fold`
 * measures that on the live checkout rather than trusting this comment.
 *
 * Not a dialog: no role="dialog", no aria-modal, no focus trap, no scroll lock.
 * Nothing here may block a shopper from reaching the catalogue.
 *
 * Enrolled on every page that loads gtag.js (38 of 43), pinned by the enrolment
 * test in tests/consent-mode-sep2026.test.js — ERR-214 is what hand-maintained
 * enrolment does: markup hash-locked across 30 pages, the runtime added by hand,
 * and 10 pages drifted for four months while looking fine.
 */

(function () {
    'use strict';

    /* Every tunable and every string lives here, so copy changes never go hunting
       through DOM code. Bump `version` to re-ask everyone after a policy change:
       a stored decision from an older version is treated as unanswered. */
    var CONSENT = {
        version: 1,
        storageKey: 'cookie_consent',   // fixed by gtag.js:9 — not ours to rename
        versionKey: 'cookie_consent_v',
        accepted: 'accepted',
        declined: 'declined',
        skipPathPrefixes: ['/admin'],   // staff tooling, not a public visitor
        heading: 'Analytics cookies',
        body: 'We use Google Analytics to understand which pages help people find the right cartridge. No advertising profile is built from it.',
        acceptText: 'Accept',
        declineText: 'Decline',
        privacyText: 'Privacy policy',
        privacyHref: '/privacy'
    };

    var EL_ID = 'consent-banner';

    /* ── Storage. Raw, deliberately. See the file header. ────────────────────── */

    function readDecision() {
        try {
            var v = localStorage.getItem(CONSENT.storageKey);
            if (v !== CONSENT.accepted && v !== CONSENT.declined) return null;
            /* A decision recorded under an older policy version is not a decision
               about this one. Absent version = version 1, so existing accepts are
               honoured rather than re-prompted on the day this ships. */
            var stored = parseInt(localStorage.getItem(CONSENT.versionKey) || '1', 10);
            if (stored !== CONSENT.version) return null;
            return v;
        } catch (_) {
            /* Private mode / storage disabled. Returning null shows the banner;
               the click handler will fail to persist and the banner will return on
               the next page. That is the honest behaviour — pretending a decision
               was stored when it was not is how a consent record becomes fiction. */
            return null;
        }
    }

    function writeDecision(value) {
        try {
            localStorage.setItem(CONSENT.storageKey, value);
            localStorage.setItem(CONSENT.versionKey, String(CONSENT.version));
            return true;
        } catch (_) {
            return false;
        }
    }

    /* ── Consent Mode ────────────────────────────────────────────────────────── */

    function applyConsent(value) {
        /* gtag.js is a blocking <head> script so `gtag` is normally defined by now,
           but an ad blocker can remove it. Never let analytics plumbing throw into
           a click handler whose real job is dismissing the bar. */
        try {
            if (typeof gtag === 'function') {
                gtag('consent', 'update', {
                    analytics_storage: value === CONSENT.accepted ? 'granted' : 'denied'
                });
            }
        } catch (_) { /* analytics never gates UX */ }
    }

    /* ── The bar ─────────────────────────────────────────────────────────────── */

    /* Built with createElement + textContent throughout: no innerHTML, so there is
       no escaping question to get wrong and no dependency on `Security` (which is a
       bare const and is NOT on window — ERR-167). */
    function build() {
        var el = document.createElement('section');
        el.id = EL_ID;
        el.className = 'consent-banner';
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', CONSENT.heading);

        var text = document.createElement('div');
        text.className = 'consent-banner__text';

        var strong = document.createElement('strong');
        strong.className = 'consent-banner__heading';
        strong.textContent = CONSENT.heading;
        text.appendChild(strong);

        var p = document.createElement('p');
        p.className = 'consent-banner__body';
        p.textContent = CONSENT.body;

        var link = document.createElement('a');
        link.className = 'consent-banner__link';
        link.href = CONSENT.privacyHref;
        link.textContent = CONSENT.privacyText;
        p.appendChild(document.createTextNode(' '));
        p.appendChild(link);
        text.appendChild(p);

        var actions = document.createElement('div');
        actions.className = 'consent-banner__actions';

        var decline = document.createElement('button');
        decline.type = 'button';
        decline.className = 'consent-banner__btn consent-banner__btn--decline';
        decline.textContent = CONSENT.declineText;

        var accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'consent-banner__btn consent-banner__btn--accept';
        accept.textContent = CONSENT.acceptText;

        actions.appendChild(decline);
        actions.appendChild(accept);

        el.appendChild(text);
        el.appendChild(actions);

        decline.addEventListener('click', function () { decide(CONSENT.declined); });
        accept.addEventListener('click', function () { decide(CONSENT.accepted); });

        return el;
    }

    /* Reserve exactly the space the bar occupies, so a fixed bar at the bottom of
       the viewport can never cover a primary action (the Continue button on
       checkout is the one that matters). Measured from the rendered box rather
       than assumed from a constant — a constant reserving space for content is a
       measurement someone declined to take (ERR-189/196). */
    function reserveSpace(el) {
        try {
            var h = Math.ceil(el.getBoundingClientRect().height);
            if (h > 0) document.body.style.setProperty('--consent-banner-height', h + 'px');
            document.body.classList.add('has-consent-banner');
        } catch (_) { /* non-fatal: the bar still works, it just may overlap */ }
    }

    /* ERR-233: measuring ONCE was not enough, and the second reader made that
       visible. This bar's height is not a constant: its text wraps, so it is
       61px on a wide desktop and 148px on a phone, and it re-wraps whenever the
       viewport changes or anything alters its padding.

       Until now the only consumer was body padding-bottom, where a stale value
       is a cosmetic gap nobody reports. Then the badge-lift rule in
       components.css started spending the same property to move a fixed element
       out of the bar's way, and a stale value became an overlap: measured on the
       deployed site, the bar grew 61px -> 78px, the lift still moved the badge
       61px, and 17px of the collision came straight back.

       So keep the measurement live for as long as the bar exists. Observing the
       element is exact and cheap; a resize listener alone would miss a re-wrap
       caused by anything other than the window changing size. */
    function watchSize(el) {
        try {
            if (typeof ResizeObserver !== 'function') {
                var onResize = function () { reserveSpace(el); };
                window.addEventListener('resize', onResize);
                return function () { window.removeEventListener('resize', onResize); };
            }
            var ro = new ResizeObserver(function () {
                if (document.getElementById(EL_ID)) reserveSpace(el);
            });
            ro.observe(el);
            return function () { ro.disconnect(); };
        } catch (_) {
            return function () {};
        }
    }

    function releaseSpace() {
        try {
            document.body.classList.remove('has-consent-banner');
            document.body.style.removeProperty('--consent-banner-height');
        } catch (_) { /* non-fatal */ }
    }

    var unwatchSize = null;

    function decide(value) {
        writeDecision(value);
        applyConsent(value);
        if (unwatchSize) { unwatchSize(); unwatchSize = null; }
        var el = document.getElementById(EL_ID);
        if (el && el.parentNode) el.parentNode.removeChild(el);
        releaseSpace();
    }

    function skipped() {
        var p = location.pathname || '';
        for (var i = 0; i < CONSENT.skipPathPrefixes.length; i++) {
            if (p.indexOf(CONSENT.skipPathPrefixes[i]) === 0) return true;
        }
        return false;
    }

    function show() {
        if (skipped()) return;
        if (readDecision() !== null) return;
        if (document.getElementById(EL_ID)) return;

        var el = build();
        document.body.appendChild(el);
        reserveSpace(el);
        unwatchSize = watchSize(el);

        /* Two-step reveal so the CSS transition runs (rewards-nudge.js pattern). */
        void el.offsetWidth;
        el.classList.add('is-open');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', show);
    } else {
        show();
    }

    /* Test/debug surface only. Deliberately assigned to window (unlike Config and
       Security, whose bare-const invisibility is a documented hazard) so the live
       probe can read the decision back without reaching into localStorage itself. */
    window.ConsentBanner = {
        read: readDecision,
        decide: decide,
        CONSENT: CONSENT
    };
})();
