/**
 * ANALYTICS.JS
 * ============
 * Unified front-end analytics layer for InkCartridges.co.nz
 *
 * Single source of truth for all event tracking.
 * Pushes to dataLayer (GTM) if available, falls back to CartAnalytics backend,
 * and always stores events locally for debugging.
 *
 * Usage: Analytics.track('cta_click', { cta_name: 'Find My Cartridge', location: 'hero' })
 */

const Analytics = {
    /** @type {Array} Local event log for debugging */
    _log: [],

    /** @type {boolean} Whether user has accepted cookie consent */
    _hasConsent: localStorage.getItem('cookie_consent') === 'accepted',

    /**
     * Core tracking method.
     * @param {string} event - Snake_case event name (see MEASUREMENT_PLAN.md)
     * @param {Object} [props={}] - Event properties
     */
    track(event, props = {}) {
        const payload = {
            event,
            ...props,
            page_path: window.location.pathname,
            page_title: document.title,
            timestamp: new Date().toISOString()
        };

        // Only send to external services if user has consented
        if (this._hasConsent) {
            // 1. Push to dataLayer (GTM / GA4) if present
            if (window.dataLayer) {
                window.dataLayer.push({ event, ...props });
            }

            // 2. Forward to CartAnalytics backend if available
            if (typeof CartAnalytics !== 'undefined' && CartAnalytics.track) {
                CartAnalytics.track(event, props);
            }
        }

        // 3. Local log always works (no external data sent)
        this._log.push(payload);
        if (this._log.length > 200) this._log.shift();
    },

    /**
     * Auto-bind click tracking to elements with [data-track] attribute.
     * Format: data-track="event_name" data-track-*="property"
     * Example: <a data-track="cta_click" data-track-cta="Shop Now" data-track-location="hero">
     */
    bindClickTracking() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('[data-track]');
            if (!el) return;

            const event = el.dataset.track;
            const props = {};

            // Gather all data-track-* attributes as properties
            for (const [key, val] of Object.entries(el.dataset)) {
                if (key !== 'track' && key.startsWith('track')) {
                    // Convert trackCtaName → cta_name
                    const propName = key
                        .replace('track', '')
                        .replace(/([A-Z])/g, '_$1')
                        .toLowerCase()
                        .replace(/^_/, '');
                    props[propName] = val;
                }
            }

            this.track(event, props);
        });
    },

    /**
     * Track phone and email link clicks
     */
    bindContactTracking() {
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[href^="tel:"], a[href^="mailto:"]');
            if (!link) return;

            const isPhone = link.href.startsWith('tel:');
            this.track('contact_click', {
                type: isPhone ? 'phone' : 'email',
                value: link.href.replace(/^(tel:|mailto:)/, '')
            });
        });
    },

    /**
     * Track search submissions
     */
    bindSearchTracking() {
        document.querySelectorAll('form[role="search"], .search-form').forEach(form => {
            form.addEventListener('submit', () => {
                const input = form.querySelector('input[type="search"], input[name="q"]');
                if (input && input.value.trim()) {
                    this.track('search', { query: input.value.trim() });
                }
            });
        });
    },

    /**
     * Track newsletter/email capture
     */
    bindEmailCapture() {
        const form = document.querySelector('.newsletter-form, .newsletter');
        if (!form) return;

        form.addEventListener('submit', (e) => {
            this.track('email_capture', {
                location: 'footer_newsletter'
            });
        });
    },

    /**
     * Track page view
     */
    trackPageView() {
        this.track('page_view', {
            page_path: window.location.pathname,
            page_title: document.title,
            referrer: document.referrer || '(direct)'
        });
    },

    /**
     * Initialize all auto-tracking
     */
    init() {
        this.trackPageView();
        this.bindClickTracking();
        this.bindContactTracking();
        this.bindSearchTracking();
        this.bindEmailCapture();
    }
};

/**
 * Cookie Consent Banner
 * Shows on first visit, stores preference in localStorage.
 * Analytics only sends to external services after consent.
 */
const CookieConsent = {
    show() {
        if (localStorage.getItem('cookie_consent')) return;

        const banner = document.createElement('div');
        banner.className = 'cookie-consent';
        banner.setAttribute('role', 'dialog');
        banner.setAttribute('aria-label', 'Cookie consent');
        banner.innerHTML = `
            <p class="cookie-consent__text">
                We use cookies to improve your experience and analyse site traffic.
                <a href="/html/privacy.html">Privacy Policy</a>
            </p>
            <div class="cookie-consent__actions">
                <button class="cookie-consent__btn cookie-consent__btn--accept" data-consent="accept">Accept</button>
                <button class="cookie-consent__btn cookie-consent__btn--decline" data-consent="decline">Decline</button>
            </div>
        `;

        document.body.appendChild(banner);
        requestAnimationFrame(() => banner.classList.add('is-visible'));

        banner.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-consent]');
            if (!btn) return;

            const accepted = btn.dataset.consent === 'accept';
            localStorage.setItem('cookie_consent', accepted ? 'accepted' : 'declined');
            Analytics._hasConsent = accepted;

            // If accepted, update GA4 consent and replay page_view
            if (accepted && typeof gtag === 'function') {
                gtag('consent', 'update', {
                    analytics_storage: 'granted'
                });
            }

            banner.classList.remove('is-visible');
            setTimeout(() => banner.remove(), 300);
        });
    }
};

// Initialize after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    Analytics.init();
    CookieConsent.show();
});

// Make available globally
window.Analytics = Analytics;
