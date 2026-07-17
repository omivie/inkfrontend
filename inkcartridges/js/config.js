/**
 * CONFIG.JS
 * =========
 * Configuration settings for InkCartridges.co.nz
 *
 * Business settings are loaded from server via loadSettings()
 */

const Config = {
    // Backend API base URL.
    //  • Production (www + apex) → https://api.inkcartridges.co.nz : a direct,
    //    Cloudflare-proxied, edge-cached path to Render. This removes the flaky
    //    Browser→Cloudflare→Vercel→Render hop that caused /shop 504s and the
    //    long skeleton-loader hangs (api-subdomain cutover, May 2026). The apex
    //    and www origins are the two the backend CORS allow-list accepts.
    //  • localhost / Vercel previews / anything else → Render origin direct. The
    //    backend already accepts these origins, and this path needs no Vercel
    //    /api rewrite (which has been removed from vercel.json).
    API_URL: (location.hostname === 'www.inkcartridges.co.nz' || location.hostname === 'inkcartridges.co.nz')
        ? 'https://api.inkcartridges.co.nz'
        : 'https://ink-backend-zaeq.onrender.com',

    // Supabase configuration
    SUPABASE_URL: 'https://lmdlgldjgcanknsjrcxh.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo',

    // Stripe publishable key (live)
    STRIPE_PUBLISHABLE_KEY: 'pk_live_51SmAlV0gOo8rzNMQBLJQotyOPNrteypuFswEwkJI1jWFje998ocCXNBRK7lPBiV0T9LSbwR2tgfn8s1PFvjgckTb00skCnpapN',

    // PayPal client ID (live)
    PAYPAL_CLIENT_ID: 'ASCSnoeTrj2EkqTuWH_JBnuCzYzGVcGk05BpeeTu46up60pJIBsbVN0Z6Prvj9Bjq6YXsGYNOOfKwHAG',

    // Cloudflare Turnstile site key (empty = Turnstile disabled, set when backend enables it)
    TURNSTILE_SITE_KEY: '0x4AAAAAACoGsire3IW5cBB9',

    // App settings
    ITEMS_PER_PAGE: 20,
    SEARCH_DEBOUNCE_MS: 300,

    // Responsive breakpoints (responsive rebuild Jul 2026) — the JS mirror of
    // the header breakpoint system documented in css/base.css. Keep in sync:
    //   compact 480 · tablet 768 · desktopNav 1100 (full nav row only >=1100,
    //   where its ~870px of nowrap links + 200px search genuinely fit).
    BREAKPOINTS: { compact: 480, tablet: 768, desktopNav: 1100 },
    // matchMedia string for the desktop-nav gate; JS "mobile" = !matches,
    // exactly complementary to the CSS @media (min-width: 1100px) blocks.
    MQ_DESKTOP_NAV: '(min-width: 1100px)',

    // Currency formatting
    CURRENCY: 'NZD',
    LOCALE: 'en-NZ',

    // Business settings (loaded from server, these are fallback defaults)
    // Shipping fees are now zone + weight + delivery-type based (see shipping.js)
    settings: {
        FREE_SHIPPING_THRESHOLD: 100,
        LOW_STOCK_THRESHOLD: 10,
        CRITICAL_STOCK_THRESHOLD: 2,
        GST_RATE: 0.15,
        FEATURES: {},
        loaded: false
    },

    /**
     * Load business settings from server
     * Call this early in app initialization
     */
    async loadSettings() {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch(`${this.API_URL}/api/settings`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (response.ok) {
                const data = await response.json();
                if (data.ok && data.data) {
                    this.settings = {
                        ...this.settings,
                        ...data.data,
                        loaded: true
                    };
                }
            }
        } catch (error) {
            clearTimeout(timeoutId);
            DebugLog.warn('Could not load settings from server, using defaults:', error.message);
        }
        return this.settings;
    },

    /**
     * Get a setting value
     */
    getSetting(key, defaultValue = null) {
        return this.settings[key] ?? defaultValue;
    }
};
