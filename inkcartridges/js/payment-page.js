    /**
     * PAYMENT PAGE - Stripe Integration
     * Modern payment processing with Stripe Elements
     */
    const PaymentPage = {
        // State
        cartItems: [],
        totals: { subtotal: 0, shipping: 0, discount: 0, total: 0 },
        checkoutData: null,
        isSubmitting: false,
        paymentAuthorized: false,

        // Stripe
        stripe: null,
        cardElement: null,
        cardComplete: false,

        /**
         * Initialize the payment page
         */
        async init() {
            DebugLog.log('Payment page initializing...');

            // Load checkout data
            this.checkoutData = this.loadCheckoutData();
            if (!this.checkoutData) {
                alert('No checkout data found. Please fill in your details first.');
                window.location.href = '/html/checkout.html';
                return;
            }

            // Display shipping summary
            this.displayShippingSummary();

            // Load cart
            await this.loadCart();

            // Initialize Stripe
            this.initStripe();

            // Setup event handlers
            this.setupEventHandlers();

            // Track payment page view for analytics
            if (typeof CartAnalytics !== 'undefined') {
                CartAnalytics.trackPaymentStarted();
            }
        },

        /**
         * Load checkout data from session storage
         */
        loadCheckoutData() {
            try {
                const data = sessionStorage.getItem('checkoutData');
                return data ? JSON.parse(data) : null;
            } catch (e) {
                DebugLog.error('Failed to load checkout data:', e);
                return null;
            }
        },

        /**
         * Display shipping summary
         */
        displayShippingSummary() {
            const container = document.getElementById('shipping-details');
            if (!container || !this.checkoutData) return;

            const d = this.checkoutData;
            const esc = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;
            container.innerHTML = `
                <p><strong>${esc(d.firstName)} ${esc(d.lastName)}</strong></p>
                <p>${esc(d.address1)}${d.address2 ? ', ' + esc(d.address2) : ''}</p>
                <p>${esc(d.city)}, ${esc(d.region)} ${esc(d.postcode)}</p>
                <p>${esc(d.email)}</p>
                ${d.phone ? `<p>${esc(d.phone)}</p>` : ''}
            `;
        },

        /**
         * Load cart items from server (authoritative source)
         */
        async loadCart() {
            try {
                // First, validate cart exists with backend
                const validateResponse = await API.validateCart();

                if (!validateResponse.ok) {
                    // Cart validation failed (items out of stock, prices changed, etc.)
                    DebugLog.error('Cart validation failed:', validateResponse.error);
                    alert('Some items in your cart have changed. Please review your cart.');
                    window.location.href = '/html/cart.html';
                    return;
                }

                // Use Cart object if available (already synced with server)
                if (typeof Cart !== 'undefined') {
                    await Cart.init();
                    this.cartItems = Cart.items || [];
                } else {
                    // Fallback: load from server directly
                    const cartResponse = await API.getCart();
                    if (cartResponse.ok && cartResponse.data) {
                        this.cartItems = cartResponse.data.items || [];
                    }
                }

                if (this.cartItems.length === 0) {
                    alert('Your cart is empty.');
                    window.location.href = '/html/cart.html';
                    return;
                }

                this.renderOrderSummary();
                // Calculate totals from backend (async)
                await this.calculateTotals();

            } catch (error) {
                DebugLog.error('Error loading cart:', error);
                this.showError('Unable to load cart. Please try again.');
            }
        },

        /**
         * Render order summary items
         */
        renderOrderSummary() {
            const container = document.getElementById('checkout-items');
            if (!container) return;

            if (this.cartItems.length === 0) {
                container.innerHTML = '<li class="checkout-summary__empty">Your cart is empty</li>';
                return;
            }

            const esc = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;
            const escAttr = typeof Security !== 'undefined' ? Security.escapeAttr : (s) => s;
            container.innerHTML = this.cartItems.map(item => `
                <li class="checkout-summary__item">
                    <div class="checkout-summary__item-image">
                        <img src="${escAttr(item.image || '/assets/images/placeholder.png')}" alt="${escAttr(item.name)}" loading="lazy">
                        <span class="checkout-summary__item-qty">${parseInt(item.quantity) || 0}</span>
                    </div>
                    <div class="checkout-summary__item-details">
                        <span class="checkout-summary__item-name">${esc(item.name)}</span>
                        <span class="checkout-summary__item-variant">${esc(item.sku || '')}</span>
                    </div>
                    <span class="checkout-summary__item-price">$${(parseFloat(item.price) * parseInt(item.quantity)).toFixed(2)}</span>
                </li>
            `).join('');
        },

        /**
         * Calculate totals from cart API
         * Uses GET /api/cart which returns validated totals from backend
         */
        async calculateTotals() {
            try {
                // Show loading state
                document.getElementById('checkout-subtotal').textContent = 'Loading...';
                document.getElementById('checkout-shipping').textContent = 'Loading...';
                document.getElementById('checkout-total').textContent = 'Loading...';
                document.getElementById('pay-button-text').textContent = 'Loading...';

                // Get cart with validated totals from backend
                const response = await API.getCart();

                if (!response.ok || !response.data) {
                    throw new Error(response.error || 'Failed to load cart');
                }

                const cartData = response.data;
                const summary = cartData.summary || {};

                // Use backend-validated prices — frontend never computes totals
                this.totals = {
                    subtotal: summary.subtotal || 0,
                    shipping: summary.shipping ?? 0,
                    discount: summary.discount || 0,
                    total: summary.total || 0
                };

                // Update cart items from server response
                if (cartData.items && cartData.items.length > 0) {
                    this.cartItems = cartData.items.map(item => ({
                        id: item.product?.id || item.id,
                        sku: item.product?.sku || '',
                        name: item.product?.name || 'Product',
                        price: item.product?.retail_price || item.price_snapshot || 0,
                        quantity: item.quantity,
                        image: item.product?.image_url || '/assets/images/placeholder.png'
                    }));
                    this.renderOrderSummary();
                }

                // Update display with backend values
                document.getElementById('checkout-subtotal').textContent = `$${this.totals.subtotal.toFixed(2)}`;
                document.getElementById('checkout-shipping').textContent = this.totals.shipping === 0 ? 'FREE' : `$${this.totals.shipping.toFixed(2)}`;

                // Show discount if present
                const discountRow = document.getElementById('checkout-discount-row');
                const discountEl = document.getElementById('checkout-discount');
                if (discountRow && discountEl && this.totals.discount > 0) {
                    discountRow.hidden = false;
                    discountEl.textContent = `-$${this.totals.discount.toFixed(2)}`;
                }

                document.getElementById('checkout-total').textContent = `$${this.totals.total.toFixed(2)} NZD`;
                document.getElementById('pay-button-text').textContent = `Pay $${this.totals.total.toFixed(2)} NZD`;

                // Initialize Apple Pay / Google Pay if available
                this.initPaymentRequestButton(this.totals.total);

            } catch (error) {
                DebugLog.error('Error calculating totals:', error);
                this.showError('Unable to calculate order total. Please refresh and try again.');

                // Disable payment if we can't validate prices
                const payBtn = document.getElementById('pay-now-btn');
                if (payBtn) payBtn.disabled = true;
            }
        },

        /**
         * Initialize Stripe
         */
        initStripe() {
            if (typeof Stripe === 'undefined') {
                DebugLog.error('Stripe.js not loaded');
                this.showError('Payment system unavailable. Please refresh the page.');
                return;
            }

            const stripeKey = typeof Config !== 'undefined' ? Config.STRIPE_PUBLISHABLE_KEY : null;
            if (!stripeKey) {
                DebugLog.error('Stripe publishable key not found');
                this.showError('Payment configuration error. Please contact support.');
                return;
            }

            // Initialize Stripe
            this.stripe = Stripe(stripeKey);

            // Create Elements with custom styling
            const elements = this.stripe.elements({
                fonts: [
                    { cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' }
                ]
            });

            // Create Card Element
            this.cardElement = elements.create('card', {
                style: {
                    base: {
                        fontSize: '16px',
                        fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
                        fontSmoothing: 'antialiased',
                        color: '#1e293b',
                        '::placeholder': {
                            color: '#94a3b8'
                        },
                        iconColor: '#267FB5'
                    },
                    invalid: {
                        color: '#ef4444',
                        iconColor: '#ef4444'
                    }
                },
                hidePostalCode: true,
                disableLink: true
            });

            // Mount to container
            this.cardElement.mount('#card-element');

            // Handle card element events
            this.cardElement.on('change', (event) => {
                const container = document.getElementById('card-element');
                const errorEl = document.getElementById('card-errors');

                // Update container styling
                container.classList.remove('card-input-container--focus', 'card-input-container--error', 'card-input-container--complete');

                if (event.error) {
                    container.classList.add('card-input-container--error');
                    errorEl.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        ${event.error.message}
                    `;
                } else {
                    errorEl.textContent = '';
                }

                if (event.complete) {
                    container.classList.add('card-input-container--complete');
                    this.cardComplete = true;
                    this.showAuthorizationBox();
                } else {
                    this.cardComplete = false;
                    this.hideAuthorizationBox();
                }

                this.updatePayButton();
            });

            this.cardElement.on('focus', () => {
                document.getElementById('card-element').classList.add('card-input-container--focus');
            });

            this.cardElement.on('blur', () => {
                document.getElementById('card-element').classList.remove('card-input-container--focus');
            });

            DebugLog.log('Stripe initialized successfully');
        },

        /**
         * Initialize Payment Request Button for Apple Pay / Google Pay
         * Call this after order total is known
         */
        async initPaymentRequestButton(totalAmount, currency = 'nzd') {
            if (!this.stripe) {
                DebugLog.log('Stripe not initialized, skipping Payment Request Button');
                return;
            }

            try {
                // Create payment request
                const paymentRequest = this.stripe.paymentRequest({
                    country: 'NZ',
                    currency: currency,
                    total: {
                        label: 'InkCartridges.co.nz',
                        amount: Math.round(totalAmount * 100) // Convert to cents
                    },
                    requestPayerName: true,
                    requestPayerEmail: true
                });

                // Check if Apple Pay / Google Pay is available
                const result = await paymentRequest.canMakePayment();

                if (result) {
                    DebugLog.log('Express checkout available:', result.applePay ? 'Apple Pay' : 'Google Pay');

                    // Create and mount the button
                    const elements = this.stripe.elements();
                    const prButton = elements.create('paymentRequestButton', {
                        paymentRequest: paymentRequest,
                        style: {
                            paymentRequestButton: {
                                type: 'default',
                                theme: 'dark',
                                height: '48px'
                            }
                        }
                    });

                    prButton.mount('#payment-request-button');

                    // Show the express checkout section
                    document.getElementById('express-checkout-section').hidden = false;

                    // Handle payment method event
                    paymentRequest.on('paymentmethod', async (ev) => {
                        try {
                            // Build items array from cart
                            const items = this.cartItems.map(item => ({
                                product_id: item.id,
                                quantity: item.quantity
                            }));

                            // Create order on backend (mirrors card payment flow)
                            const orderResponse = await API.createOrder({
                                items: items,
                                shipping_address: {
                                    recipient_name: `${this.checkoutData.firstName} ${this.checkoutData.lastName}`,
                                    phone: this.checkoutData.phone || '',
                                    address_line1: this.checkoutData.address1,
                                    address_line2: this.checkoutData.address2 || '',
                                    city: this.checkoutData.city,
                                    region: this.checkoutData.region,
                                    postal_code: this.checkoutData.postcode,
                                    country: 'NZ'
                                },
                                shipping_tier: this.checkoutData.shippingTier || 'standard',
                                shipping_zone: this.checkoutData.shippingZone || '',
                                delivery_type: this.checkoutData.deliveryType || 'urban',
                                save_address: true,
                                customer_notes: this.checkoutData.orderNotes || '',
                                idempotency_key: crypto.randomUUID().replace(/-/g, '')
                            });

                            if (!orderResponse.ok) {
                                ev.complete('fail');
                                this.showError(orderResponse.error || 'Failed to create order');
                                return;
                            }

                            const { client_secret, order_number, total_amount } = orderResponse.data;

                            // Confirm the payment with the express payment method
                            const { paymentIntent, error: confirmError } = await this.stripe.confirmCardPayment(
                                client_secret,
                                { payment_method: ev.paymentMethod.id },
                                { handleActions: false }
                            );

                            if (confirmError) {
                                ev.complete('fail');
                                this.showError(confirmError.message);
                            } else if (paymentIntent.status === 'requires_action') {
                                ev.complete('success');
                                // Handle 3D Secure if needed
                                const { error } = await this.stripe.confirmCardPayment(client_secret);
                                if (error) {
                                    this.showError(error.message);
                                } else {
                                    await this.completeExpressOrder(order_number, total_amount);
                                }
                            } else {
                                ev.complete('success');
                                await this.completeExpressOrder(order_number, total_amount);
                            }
                        } catch (error) {
                            ev.complete('fail');
                            this.showError(error.message);
                        }
                    });
                } else {
                    DebugLog.log('Express checkout not available on this device/browser');
                }
            } catch (error) {
                DebugLog.log('Payment Request Button error:', error.message);
            }
        },

        /**
         * Complete order after successful express checkout payment
         */
        async completeExpressOrder(order_number, total_amount) {
            try {
                await API.clearCart();
            } catch (e) {
                DebugLog.warn('Could not clear cart via API:', e);
            }

            if (typeof Cart !== 'undefined') {
                Cart.items = [];
                document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
                    el.textContent = '0';
                });
            }
            localStorage.removeItem('inkcartridges_cart');

            sessionStorage.setItem('lastOrder', JSON.stringify({
                order_number: order_number,
                email: this.checkoutData.email
            }));
            sessionStorage.removeItem('checkoutData');

            if (typeof CartAnalytics !== 'undefined') {
                CartAnalytics.trackOrderCompleted({ order_number, total_amount });
            }

            window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(order_number)}`;
        },

        /**
         * Setup event handlers
         */
        setupEventHandlers() {
            // Authorization checkbox
            const authorizeCheckbox = document.getElementById('authorize-payment');
            const authContainer = document.getElementById('payment-authorization');

            if (authorizeCheckbox) {
                // Reset state on page load
                authorizeCheckbox.checked = false;
                this.paymentAuthorized = false;

                authorizeCheckbox.addEventListener('change', () => {
                    this.paymentAuthorized = authorizeCheckbox.checked;

                    if (authorizeCheckbox.checked && authContainer) {
                        authContainer.classList.add('authorized');
                    } else if (authContainer) {
                        authContainer.classList.remove('authorized');
                    }

                    this.updatePayButton();
                });
            }

            // Form submission
            const form = document.getElementById('payment-form');
            if (form) {
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    await this.handlePayment();
                });
            }
        },

        /**
         * Update pay button state
         */
        updatePayButton() {
            const payBtn = document.getElementById('pay-now-btn');
            if (!payBtn) return;

            const canPay = this.cardComplete && this.paymentAuthorized;
            payBtn.disabled = !canPay;
        },

        /**
         * Handle payment submission - SECURE FLOW
         * 1. Validate cart with backend (prices, stock)
         * 2. Create order on backend (creates PaymentIntent, returns client_secret)
         * 3. Confirm payment with Stripe using backend's client_secret
         * 4. Clear cart and redirect to confirmation
         */
        async handlePayment() {
            if (this.isSubmitting) return;

            if (!this.paymentAuthorized) {
                alert('Please authorize the payment before proceeding.');
                return;
            }

            if (!this.cardComplete) {
                alert('Please complete your card details.');
                return;
            }

            const payBtn = document.getElementById('pay-now-btn');
            const btnText = document.getElementById('pay-button-text');
            const originalText = btnText.textContent;

            this.isSubmitting = true;
            payBtn.disabled = true;

            try {
                // STEP 1: Validate cart is still valid
                btnText.innerHTML = this.getLoadingHTML('Validating cart...');

                const validateResponse = await API.validateCart();
                if (!validateResponse.ok || (validateResponse.data && !validateResponse.data.is_valid)) {
                    const issues = validateResponse.data?.issues || [];
                    const issueMsg = issues.length > 0
                        ? issues.map(i => i.issue).join(', ')
                        : 'Cart validation failed. Items may have changed.';
                    throw new Error(issueMsg);
                }

                // STEP 2: Create order on backend
                // Backend creates PaymentIntent and validates all prices server-side
                btnText.innerHTML = this.getLoadingHTML('Creating order...');

                // Build items array from cart
                const items = this.cartItems.map(item => ({
                    product_id: item.id,
                    quantity: item.quantity
                }));

                const orderResponse = await API.createOrder({
                    items: items,
                    shipping_address: {
                        recipient_name: `${this.checkoutData.firstName} ${this.checkoutData.lastName}`,
                        phone: this.checkoutData.phone || '',
                        address_line1: this.checkoutData.address1,
                        address_line2: this.checkoutData.address2 || '',
                        city: this.checkoutData.city,
                        region: this.checkoutData.region,
                        postal_code: this.checkoutData.postcode,
                        country: 'NZ'
                    },
                    shipping_tier: this.checkoutData.shippingTier || 'standard',
                    shipping_zone: this.checkoutData.shippingZone || '',
                    delivery_type: this.checkoutData.deliveryType || 'urban',
                    save_address: true,
                    customer_notes: this.checkoutData.orderNotes || '',
                    idempotency_key: crypto.randomUUID().replace(/-/g, '')
                });

                if (!orderResponse.ok) {
                    throw new Error(orderResponse.error || 'Failed to create order');
                }

                const { client_secret, order_id, order_number, total_amount } = orderResponse.data;

                // STEP 3: Confirm payment with Stripe
                btnText.innerHTML = this.getLoadingHTML('Processing payment...');

                const { error: stripeError, paymentIntent } = await this.stripe.confirmCardPayment(
                    client_secret,
                    {
                        payment_method: {
                            card: this.cardElement,
                            billing_details: {
                                name: `${this.checkoutData.firstName} ${this.checkoutData.lastName}`,
                                email: this.checkoutData.email,
                                phone: this.checkoutData.phone || undefined,
                                address: {
                                    line1: this.checkoutData.address1,
                                    line2: this.checkoutData.address2 || undefined,
                                    city: this.checkoutData.city,
                                    state: this.checkoutData.region,
                                    postal_code: this.checkoutData.postcode,
                                    country: 'NZ'
                                }
                            }
                        }
                    }
                );

                if (stripeError) {
                    DebugLog.error('Stripe error:', stripeError);
                    throw new Error(stripeError.message);
                }

                if (paymentIntent.status !== 'succeeded') {
                    throw new Error('Payment was not completed. Please try again.');
                }

                // STEP 4: Clear cart and redirect
                // Backend webhook will update order status when payment succeeds
                btnText.innerHTML = this.getLoadingHTML('Completing order...');

                // Clear cart via API
                try {
                    await API.clearCart();
                } catch (e) {
                    DebugLog.warn('Could not clear cart via API:', e);
                }

                // Also clear local storage and update cart badge
                if (typeof Cart !== 'undefined') {
                    Cart.items = [];
                    document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
                        el.textContent = '0';
                    });
                }
                localStorage.removeItem('inkcartridges_cart');

                // Store minimal order data for confirmation page
                sessionStorage.setItem('lastOrder', JSON.stringify({
                    order_number: order_number,
                    email: this.checkoutData.email
                }));
                sessionStorage.removeItem('checkoutData');

                // Track order completed for analytics
                if (typeof CartAnalytics !== 'undefined') {
                    CartAnalytics.trackOrderCompleted({ order_number, total_amount });
                }

                // Redirect to confirmation
                window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(order_number)}`;

            } catch (error) {
                DebugLog.error('Payment error:', error);
                this.showError(error.message || 'Payment failed. Please try again.');

                btnText.textContent = originalText;
                payBtn.disabled = false;
                this.isSubmitting = false;
            }
        },

        /**
         * Helper: Get loading spinner HTML
         */
        getLoadingHTML(text) {
            return `
                <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"/>
                </svg>
                ${text}
            `;
        },

        /**
         * Show error message
         */
        showError(message) {
            const errorEl = document.getElementById('card-errors');
            if (errorEl) {
                errorEl.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${message}
                `;
            }
        },

        /**
         * Show authorization box when card is complete
         */
        showAuthorizationBox() {
            const authContainer = document.getElementById('payment-authorization');
            if (authContainer && !authContainer.classList.contains('authorized')) {
                authContainer.classList.add('visible');
            }
        },

        /**
         * Hide authorization box when card is incomplete
         */
        hideAuthorizationBox() {
            const authContainer = document.getElementById('payment-authorization');
            const authorizeCheckbox = document.getElementById('authorize-payment');

            if (authContainer) {
                authContainer.classList.remove('visible');
                authContainer.classList.remove('authorized');
            }

            // Reset authorization state
            if (authorizeCheckbox) {
                authorizeCheckbox.checked = false;
            }
            this.paymentAuthorized = false;
        }
    };

    // Initialize when ready
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof Auth !== 'undefined') {
            const checkAuth = setInterval(() => {
                if (Auth.initialized) {
                    clearInterval(checkAuth);
                    PaymentPage.init();
                }
            }, 100);

            setTimeout(() => {
                clearInterval(checkAuth);
                PaymentPage.init();
            }, 3000);
        } else {
            PaymentPage.init();
        }
    });
