/**
 * CONFIG.JS
 * =========
 * Configuration settings for InkCartridges.co.nz
 *
 * Business settings are loaded from server via loadSettings()
 */

const Config = {
    // Backend API URL - Direct connection (backend has CORS enabled)
    API_URL: 'https://ink-backend-zaeq.onrender.com',

    // Supabase configuration
    SUPABASE_URL: 'https://lmdlgldjgcanknsjrcxh.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo',

    // Stripe publishable key (test mode)
    STRIPE_PUBLISHABLE_KEY: 'pk_test_51SmAlV0gOo8rzNMQVrfwNbzDajKddyVErPdWIiyQq5v55fwF7dqMAIKWZKQZasgV8bsZvEBySGROi75iJQZBvLf3001YEfdJ8N',

    // Cloudflare Turnstile site key (empty = Turnstile disabled, set when backend enables it)
    TURNSTILE_SITE_KEY: '',

    // App settings
    ITEMS_PER_PAGE: 20,
    SEARCH_DEBOUNCE_MS: 300,

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
