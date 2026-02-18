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
        this.sessionId = this.getOrCreateSessionId();
        this.setupUnloadTracking();
        // Cart Analytics initialized
    },

    /**
     * Get or create a unique session ID for tracking
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
            session_id: this.sessionId,
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
            console.error('Failed to send analytics event:', error);
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
            console.error('Failed to store event locally:', e);
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

        // Clear session for next order
        sessionStorage.removeItem('cart_session_id');
        this.sessionId = this.getOrCreateSessionId();
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
                session_id: this.sessionId,
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
            console.error('Error getting cart value:', e);
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
            console.error('Error getting cart count:', e);
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
