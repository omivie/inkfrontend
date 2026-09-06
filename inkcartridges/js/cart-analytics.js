/**
 * CART ANALYTICS
 * Tracks cart events for abandonment analysis
 */

const CartAnalytics = {
    sessionId: null,
    checkoutStarted: false,
    paymentStarted: false,

    /**
     * Initialize cart analytics
     */
    init() {
        // Deliberately does NOT resolve the id here. See currentSessionId():
        // traffic-tracker.js is injected dynamically and can land after
        // DOMContentLoaded, so reading it now would lock some page loads onto
        // the `cs_` fallback. Minting eagerly would also write a
        // `cart_session_id` we will normally never send.
        this.setupUnloadTracking();
        // Cart Analytics initialized
    },

    /**
     * ONE SESSION ID, SHARED WITH EVERY OTHER ANALYTICS SURFACE (ERR-223).
     *
     * ── THE BUG THIS REPLACES ────────────────────────────────────────────────
     * This file used to mint its OWN id — `cs_…` in sessionStorage — with no
     * relationship to the `ts_…` id `traffic-tracker.js` mints and that
     * `traffic_events`, the search `?sid=`, and the click beacon all carry. Two
     * id spaces for one visitor. `cart_analytics_events.session_id` was
     * therefore 100% populated and joined to NOTHING, which is a worse failure
     * than a null column: a null is visibly missing, a populated column that
     * joins to nothing looks like working data.
     *
     * It got sharper the moment the backend started writing its own
     * `add_to_cart` row from POST /api/cart/items. That row carries the
     * `ts_…` id (api.js addToCart sends ?sid=). This beacon's row carried
     * `cs_…`. Same add, two rows, two different ids — so a reader counting
     * DISTINCT session_id saw TWO sessions for one add, and `add_to_cart`
     * became the only rung of the funnel mixing id spaces while `cart_viewed`
     * stayed pure `cs_`. The hand-off's claim that "readers that count DISTINCT
     * session_id are unaffected by the overlap" was true only once this changed.
     *
     * ── WHY IT RESOLVES AT SEND TIME, NOT IN init() ──────────────────────────
     * `traffic-tracker.js` is injected by gtag.js via createElement('script'),
     * and a dynamically-inserted script is ASYNC no matter what `.defer` is set
     * to — so it can land after DOMContentLoaded, which is when init() runs.
     * Resolving once at init would have read an absent tracker and locked this
     * file onto the `cs_` fallback forever, on some page loads and not others.
     * That is a race that would have looked like flaky data, not like a bug.
     *
     * ── WHY THE `cs_` ID STILL EXISTS ────────────────────────────────────────
     * It is the LAST RESORT, not the default. TrafficTracker is deliberately
     * absent under DNT and on /admin (both opt-outs return before
     * `window.TrafficTracker` is assigned), and it suppresses the collision
     * sentinels 'anon'/'ts_fallback' by name so that every private-browsing
     * visitor on earth does not merge into one enormous customer. In those
     * cases this event still needs SOME id — the backend requires one — so it
     * gets an honest unjoinable one rather than a shared lie. That is the same
     * stance search-click-beacon.js already takes.
     *
     * NEVER MINT AN ANALYTICS ID OUTSIDE traffic-tracker.js. This function does
     * not; it asks, and falls back to a local id that is scoped to this file.
     */
    getOrCreateSessionId() {
        let sessionId = sessionStorage.getItem('cart_session_id');
        if (!sessionId) {
            sessionId = 'cs_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
            sessionStorage.setItem('cart_session_id', sessionId);
        }
        return sessionId;
    },

    /**
     * { session_id, visitor_id } from the one owner of that vocabulary, or null.
     * `window.` is load-bearing: TrafficTracker really is on window, unlike
     * `Config`/`Security`, whose `window.X?.` guards were silent off-switches
     * (ERR-156/ERR-167). Grep the `window.X =` line before copying this shape.
     */
    trafficIds() {
        try {
            const tt = typeof window !== 'undefined' ? window.TrafficTracker : null;
            return (tt && typeof tt.getIds === 'function') ? tt.getIds() : null;
        } catch (_) {
            return null;
        }
    },

    /** The shared `ts_…` id when it is knowable; the local `cs_…` id otherwise. */
    currentSessionId() {
        const ids = this.trafficIds();
        if (ids && ids.session_id) return ids.session_id;
        if (!this.sessionId) this.sessionId = this.getOrCreateSessionId();
        return this.sessionId;
    },

    /**
     * Get user ID if logged in
     */
    getUserId() {
        if (typeof Auth !== 'undefined' && Auth.user) {
            return Auth.user.id;
        }
        return null;
    },

    /**
     * Track an event
     */
    async track(eventType, data = {}) {
        const event = {
            session_id: this.currentSessionId(),
            user_id: this.getUserId(),
            event_type: eventType,
            timestamp: new Date().toISOString(),
            page_url: window.location.pathname,
            ...data
        };

        // Store locally for redundancy
        this.storeEventLocally(event);

        // Send to backend
        try {
            await this.sendToBackend(event);
        } catch (error) {
            DebugLog.error('Failed to send analytics event:', error);
        }
    },

    /**
     * Store event in localStorage as backup
     */
    storeEventLocally(event) {
        try {
            const events = JSON.parse(localStorage.getItem('cart_analytics_events') || '[]');
            events.push(event);
            // Keep only last 50 events locally
            if (events.length > 50) {
                events.shift();
            }
            localStorage.setItem('cart_analytics_events', JSON.stringify(events));
        } catch (e) {
            DebugLog.error('Failed to store event locally:', e);
        }
    },

    // Event types the backend accepts
    BACKEND_EVENT_TYPES: ['add_to_cart', 'remove_from_cart', 'checkout_started', 'checkout_completed', 'cart_viewed'],

    /**
     * Build a backend-safe payload (only accepted fields and event types)
     * Returns null if event type is not accepted by backend
     */
    buildBackendPayload(event) {
        if (!this.BACKEND_EVENT_TYPES.includes(event.event_type)) return null;
        const payload = {
            event_type: event.event_type,
            session_id: event.session_id
        };
        if (event.product_id) payload.product_id = event.product_id;
        if (event.quantity != null) payload.quantity = event.quantity;
        // visitor_id is ADDITIVE and optional. Measured 2026-09-06: the endpoint
        // accepts it with a 200 rather than rejecting the request, but whether it
        // is PERSISTED could not be verified from outside the database — so it is
        // sent and flagged for the backend to confirm, never reported as working.
        // A visitor id is what joins a cart across sessions to one person.
        const ids = this.trafficIds();
        if (ids && ids.visitor_id) payload.visitor_id = ids.visitor_id;
        return payload;
    },

    /**
     * Send event to backend API
     * Backend accepts: { event_type, session_id, product_id?, quantity? }
     * Only sends event types the backend schema allows
     */
    async sendToBackend(event) {
        const apiUrl = typeof Config !== 'undefined' ? Config.API_URL : '';
        if (!apiUrl) return;

        const payload = this.buildBackendPayload(event);
        if (!payload) return; // Event type not accepted by backend — store locally only

        try {
            await fetch(`${apiUrl}/api/analytics/cart-event`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                credentials: 'include'
            });
        } catch (error) {
            // Silently fail - analytics shouldn't break the site
        }
    },

    /**
     * Track: Item added to cart
     */
    trackAddToCart(product, quantity = 1) {
        this.track('add_to_cart', {
            product_id: product.id,
            product_sku: product.sku,
            product_name: product.name,
            product_price: product.price,
            quantity: quantity,
            cart_value: this.getCartValue()
        });
    },

    /**
     * Track: Item removed from cart
     */
    trackRemoveFromCart(product, quantity = 1) {
        this.track('remove_from_cart', {
            product_id: product.id,
            product_sku: product.sku,
            product_name: product.name,
            quantity: quantity,
            cart_value: this.getCartValue()
        });
    },

    /**
     * Track: Cart quantity updated
     */
    trackUpdateQuantity(product, oldQty, newQty) {
        this.track('update_quantity', {
            product_id: product.id,
            product_sku: product.sku,
            old_quantity: oldQty,
            new_quantity: newQty,
            cart_value: this.getCartValue()
        });
    },

    /**
     * Track: Cart viewed
     */
    trackCartViewed() {
        this.track('cart_viewed', {
            cart_value: this.getCartValue(),
            item_count: this.getCartItemCount()
        });
    },

    /**
     * Track: Checkout started (details page)
     */
    trackCheckoutStarted() {
        if (this.checkoutStarted) return; // Only track once per session
        this.checkoutStarted = true;
        sessionStorage.setItem('checkout_started', 'true');

        this.track('checkout_started', {
            cart_value: this.getCartValue(),
            item_count: this.getCartItemCount()
        });
    },

    /**
     * Track: Payment page reached
     */
    trackPaymentStarted() {
        if (this.paymentStarted) return; // Only track once per session
        this.paymentStarted = true;
        sessionStorage.setItem('payment_started', 'true');

        this.track('payment_started', {
            cart_value: this.getCartValue(),
            item_count: this.getCartItemCount()
        });
    },

    /**
     * Track: Order completed
     */
    trackOrderCompleted(orderData) {
        // Clear abandonment flags
        sessionStorage.removeItem('checkout_started');
        sessionStorage.removeItem('payment_started');

        this.track('checkout_completed', {
            order_number: orderData.order_number,
            order_total: orderData.total,
            item_count: orderData.items?.length || 0
        });

        // Clear the FALLBACK session for the next order.
        //
        // Since ERR-223 this only governs the `cs_` last-resort id (DNT,
        // /admin, storage-sentinel cases). When the shared `ts_…` id is
        // available it is the traffic tracker's 30-minute sliding window that
        // defines a session, exactly as it does for `traffic_events` and
        // search — so two orders placed minutes apart are now correctly ONE
        // session rather than two. That is a deliberate change of meaning and
        // it is the point of having one id space.
        sessionStorage.removeItem('cart_session_id');
        this.sessionId = null;
    },

    /**
     * Track: Potential abandonment (page unload)
     */
    trackPotentialAbandonment() {
        const cartValue = this.getCartValue();
        const checkoutStarted = sessionStorage.getItem('checkout_started') === 'true';
        const paymentStarted = sessionStorage.getItem('payment_started') === 'true';

        // Only track if there's something in the cart or checkout was started
        if (cartValue > 0 || checkoutStarted) {
            // Store full event locally for analysis
            const event = {
                session_id: this.currentSessionId(),
                user_id: this.getUserId(),
                event_type: 'potential_abandonment',
                timestamp: new Date().toISOString(),
                page_url: window.location.pathname,
                cart_value: cartValue,
                checkout_started: checkoutStarted,
                payment_started: paymentStarted,
                item_count: this.getCartItemCount()
            };

            this.storeEventLocally(event);

            // Don't send to backend — 'potential_abandonment' is not an accepted event type.
            // This data is stored locally only.
        }
    },

    /**
     * Setup tracking for page unload (potential abandonment)
     */
    setupUnloadTracking() {
        // Track when user leaves checkout/payment pages
        const isCheckoutPage = window.location.pathname.includes('checkout') ||
                               window.location.pathname.includes('payment');

        if (isCheckoutPage) {
            window.addEventListener('beforeunload', () => {
                this.trackPotentialAbandonment();
            });

            // Also track visibility change (user switches tabs)
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    this.trackPotentialAbandonment();
                }
            });
        }
    },

    /**
     * Get current cart value
     */
    getCartValue() {
        try {
            if (typeof Cart !== 'undefined' && Cart.items) {
                return Cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            }
            const stored = localStorage.getItem('inkcartridges_cart');
            if (stored) {
                const items = JSON.parse(stored);
                return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            }
        } catch (e) {
            DebugLog.error('Error getting cart value:', e);
        }
        return 0;
    },

    /**
     * Get current cart item count
     */
    getCartItemCount() {
        try {
            if (typeof Cart !== 'undefined' && Cart.items) {
                return Cart.items.reduce((sum, item) => sum + item.quantity, 0);
            }
            const stored = localStorage.getItem('inkcartridges_cart');
            if (stored) {
                const items = JSON.parse(stored);
                return items.reduce((sum, item) => sum + item.quantity, 0);
            }
        } catch (e) {
            DebugLog.error('Error getting cart count:', e);
        }
        return 0;
    },

    /**
     * Get stored email for recovery
     */
    getRecoveryEmail() {
        // Check checkout data first
        try {
            const checkoutData = sessionStorage.getItem('checkoutData');
            if (checkoutData) {
                const data = JSON.parse(checkoutData);
                return data.email;
            }
        } catch (e) {}

        // Check if user is logged in
        if (typeof Auth !== 'undefined' && Auth.user) {
            return Auth.user.email;
        }

        return null;
    }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    CartAnalytics.init();
});

// Make available globally
window.CartAnalytics = CartAnalytics;
