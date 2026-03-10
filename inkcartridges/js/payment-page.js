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

        // Idempotency key — generated once per checkout session, reused on retry
        _idempotencyKey: null,
        getIdempotencyKey() {
            if (!this._idempotencyKey) {
                this._idempotencyKey = crypto.randomUUID().replace(/-/g, '');
            }
            return this._idempotencyKey;
        },

        // Stripe
        stripe: null,
        elements: null,
        paymentElementReady: false,

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

            // Initialize PayPal
            this.initPayPal();

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
                // Validate cart (non-blocking — log warning if it fails)
                try {
                    const validateResponse = await API.validateCart();
                    if (!validateResponse.ok) {
                        DebugLog.warn('Cart validation warning:', validateResponse.error);
                    }
                } catch (valError) {
                    DebugLog.warn('Cart validation unavailable:', valError.message);
                }

                // Load cart items — Cart object (localStorage + server) is primary source
                if (typeof Cart !== 'undefined') {
                    await Cart.init();
                    this.cartItems = Cart.items || [];
                }

                // Fallback: try API directly
                if (this.cartItems.length === 0) {
                    try {
                        const cartResponse = await API.getCart();
                        if (cartResponse.ok && cartResponse.data) {
                            this.cartItems = cartResponse.data.items || [];
                        }
                    } catch (apiErr) {
                        DebugLog.warn('API getCart failed:', apiErr.message);
                    }
                }

                if (this.cartItems.length === 0) {
                    alert('Your cart is empty.');
                    window.location.href = '/html/cart.html';
                    return;
                }

                this.renderOrderSummary();
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

                // Update cart items from server response first (need fresh prices for fallback)
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

                // Use backend-validated prices — frontend never computes totals
                // Prefer the shipping fee from checkout (from /api/shipping/options with real address)
                // over the cart summary's generic shipping estimate
                const checkoutShipping = this.checkoutData?.estimatedShipping;
                const shipping = checkoutShipping != null ? checkoutShipping : (summary.shipping ?? 0);

                this.totals = {
                    subtotal: summary.subtotal || 0,
                    shipping: shipping,
                    discount: summary.discount || 0,
                    total: (summary.subtotal || 0) + shipping - (summary.discount || 0)
                };

                // If server returned items but no subtotal, compute from items
                if (this.totals.subtotal === 0 && this.cartItems.length > 0) {
                    const estimatedSubtotal = this.cartItems.reduce((sum, item) => {
                        return sum + (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 0);
                    }, 0);
                    if (estimatedSubtotal > 0) {
                        this.totals.subtotal = estimatedSubtotal;
                        this.totals.total = estimatedSubtotal + this.totals.shipping - this.totals.discount;
                    }
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

                // Update Elements amount if already initialized
                if (this.elements) {
                    this.elements.update({ amount: Math.round(this.totals.total * 100) });
                }

            } catch (error) {
                DebugLog.warn('Server totals unavailable, using estimates:', error.message);

                // Fall back to Cart object totals
                if (typeof Cart !== 'undefined' && this.cartItems.length > 0) {
                    const subtotal = Cart.getSubtotal();
                    const checkoutData = this.checkoutData || {};
                    // Prefer the shipping fee persisted from checkout over recalculating
                    const shipping = checkoutData.estimatedShipping != null
                        ? checkoutData.estimatedShipping
                        : (typeof Shipping !== 'undefined'
                            ? Shipping.calculate(Cart.items, subtotal, checkoutData.region, checkoutData.deliveryType).fee
                            : 0);

                    this.totals = {
                        subtotal,
                        shipping,
                        discount: 0,
                        total: subtotal + shipping
                    };

                    document.getElementById('checkout-subtotal').textContent = `$${this.totals.subtotal.toFixed(2)}`;
                    document.getElementById('checkout-shipping').textContent = this.totals.shipping === 0 ? 'FREE' : `$${this.totals.shipping.toFixed(2)}`;
                    document.getElementById('checkout-total').textContent = `$${this.totals.total.toFixed(2)} NZD`;
                    document.getElementById('pay-button-text').textContent = `Pay $${this.totals.total.toFixed(2)} NZD`;

                    if (this.elements) {
                        this.elements.update({ amount: Math.round(this.totals.total * 100) });
                    }
                } else {
                    this.showError('Unable to calculate order total. Please refresh and try again.');
                    const payBtn = document.getElementById('pay-now-btn');
                    if (payBtn) payBtn.disabled = true;
                }
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

            // Create Elements with deferred intent (no client_secret needed yet)
            const totalCents = Math.round(this.totals.total * 100) || 100; // minimum 1 NZD
            this.elements = this.stripe.elements({
                mode: 'payment',
                amount: totalCents,
                currency: 'nzd',
                fonts: [
                    { cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' }
                ],
                appearance: {
                    theme: 'stripe',
                    variables: {
                        colorPrimary: '#267FB5',
                        colorBackground: '#ffffff',
                        colorText: '#1e293b',
                        colorDanger: '#ef4444',
                        fontFamily: '"Inter", system-ui, -apple-system, sans-serif',
                        fontSizeBase: '16px',
                        spacingUnit: '4px',
                        borderRadius: '8px'
                    },
                    rules: {
                        '.Input': {
                            border: '2px solid #e2e8f0',
                            boxShadow: 'none',
                            padding: '12px'
                        },
                        '.Input:focus': {
                            border: '2px solid #267FB5',
                            boxShadow: '0 0 0 4px rgba(38, 127, 181, 0.1)'
                        },
                        '.Input--invalid': {
                            border: '2px solid #ef4444',
                            boxShadow: '0 0 0 4px rgba(239, 68, 68, 0.1)'
                        }
                    }
                }
            });

            // Create and mount PaymentElement
            const paymentElement = this.elements.create('payment', {
                layout: 'tabs'
            });
            paymentElement.mount('#payment-element');

            // Handle PaymentElement events
            paymentElement.on('change', (event) => {
                const errorEl = document.getElementById('card-errors');

                if (event.complete) {
                    this.paymentElementReady = true;
                    errorEl.textContent = '';
                    this.showAuthorizationBox();
                } else {
                    this.paymentElementReady = false;
                    this.hideAuthorizationBox();
                }

                if (event.value?.type) {
                    DebugLog.log('Payment method selected:', event.value.type);
                }

                this.updatePayButton();
            });

            DebugLog.log('Stripe PaymentElement initialized successfully');
        },

        /**
         * Initialize PayPal button
         */
        initPayPal() {
            if (typeof paypal === 'undefined') {
                DebugLog.warn('PayPal SDK not loaded');
                const container = document.getElementById('paypal-button-container');
                const divider = document.querySelector('.payment-divider');
                if (container) container.style.display = 'none';
                if (divider) divider.style.display = 'none';
                return;
            }

            let orderNumber = null;

            paypal.Buttons({
                style: {
                    layout: 'vertical',
                    color: 'blue',
                    shape: 'rect',
                    label: 'pay',
                    height: 45
                },

                createOrder: async () => {
                    // Disable Stripe pay button to prevent double-submission
                    const payBtn = document.getElementById('pay-now-btn');
                    if (payBtn) payBtn.disabled = true;

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
                        shipping_tier: '',
                        shipping_zone: '',
                        delivery_type: this.checkoutData.deliveryType || 'urban',
                        save_address: this.checkoutData.saveAddress !== false,
                        customer_notes: this.checkoutData.orderNotes || '',
                        payment_method: 'paypal',
                        idempotency_key: this.getIdempotencyKey()
                    });

                    if (!orderResponse.ok) {
                        const errorMsg = orderResponse.error?.message || orderResponse.error || 'Failed to create order';
                        throw new Error(errorMsg);
                    }

                    orderNumber = orderResponse.data.order_number;
                    const paypalOrderId = orderResponse.data.paypal_order_id;

                    if (!paypalOrderId) {
                        throw new Error('PayPal order ID not returned from server');
                    }

                    return paypalOrderId;
                },

                onApprove: async (data) => {
                    try {
                        // Capture the PayPal payment
                        const captureResponse = await API.post(`/api/orders/${orderNumber}/capture-paypal`, {
                            paypal_order_id: data.orderID
                        });

                        if (!captureResponse.ok) {
                            throw new Error(captureResponse.error?.message || captureResponse.error || 'Payment capture failed');
                        }

                        // Clear cart
                        try { await API.clearCart(); } catch (e) { DebugLog.warn('Could not clear cart:', e); }
                        if (typeof Cart !== 'undefined') {
                            Cart.items = [];
                            document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => { el.textContent = '0'; });
                        }
                        localStorage.removeItem('inkcartridges_cart');

                        // Store order data for confirmation page
                        sessionStorage.setItem('lastOrder', JSON.stringify({
                            order_number: orderNumber,
                            email: this.checkoutData.email
                        }));
                        sessionStorage.removeItem('checkoutData');

                        // Track analytics
                        if (typeof CartAnalytics !== 'undefined') {
                            CartAnalytics.trackOrderCompleted({ order_number: orderNumber, total_amount: this.totals.total });
                        }

                        // Redirect to confirmation
                        window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(orderNumber)}`;

                    } catch (error) {
                        DebugLog.error('PayPal capture error:', error);
                        this.showError(error.message || 'Payment failed. Please try again.');
                    }
                },

                onCancel: () => {
                    DebugLog.log('PayPal payment cancelled');
                    if (typeof showToast === 'function') {
                        showToast('Payment cancelled', 'info');
                    }
                    // Re-enable Stripe pay button
                    this._idempotencyKey = null;
                    this.updatePayButton();
                },

                onError: (err) => {
                    DebugLog.error('PayPal error:', err);
                    if (typeof showToast === 'function') {
                        showToast('Payment error. Please try again.', 'error');
                    }
                    // Re-enable Stripe pay button
                    this._idempotencyKey = null;
                    this.updatePayButton();
                }
            }).render('#paypal-button-container');

            DebugLog.log('PayPal button initialized');
        },

        // Note: Apple Pay / Google Pay are handled natively by PaymentElement

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

            const canPay = this.paymentElementReady && this.paymentAuthorized;
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

            if (!this.paymentElementReady) {
                alert('Please complete your payment details.');
                return;
            }

            const payBtn = document.getElementById('pay-now-btn');
            const btnText = document.getElementById('pay-button-text');
            const originalText = btnText.textContent;

            this.isSubmitting = true;
            payBtn.disabled = true;

            try {
                // STEP 0: Validate PaymentElement form
                btnText.innerHTML = this.getLoadingHTML('Validating payment...');
                const { error: submitError } = await this.elements.submit();
                if (submitError) {
                    throw new Error(submitError.message);
                }

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
                    shipping_tier: '',
                    shipping_zone: '',
                    delivery_type: this.checkoutData.deliveryType || 'urban',
                    save_address: this.checkoutData.saveAddress !== false,
                    customer_notes: this.checkoutData.orderNotes || '',
                    idempotency_key: this.getIdempotencyKey()
                });

                // Handle duplicate/idempotent replay
                if (orderResponse.ok && orderResponse.data?.is_duplicate) {
                    const dupData = orderResponse.data;
                    const dupOrderNumber = dupData.order_number;

                    if (dupData.client_secret) {
                        // Payment wasn't completed — retry with the existing PaymentIntent
                        btnText.innerHTML = this.getLoadingHTML('Retrying payment...');

                        const { error: stripeError, paymentIntent } = await this.stripe.confirmPayment({
                            elements: this.elements,
                            clientSecret: dupData.client_secret,
                            confirmParams: {
                                return_url: `${window.location.origin}/html/order-confirmation.html?order=${encodeURIComponent(dupOrderNumber)}`,
                                payment_method_data: {
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
                            },
                            redirect: 'if_required'
                        });

                        if (stripeError) {
                            DebugLog.error('Stripe retry error:', stripeError);
                            try {
                                await API.cancelOrder(dupOrderNumber);
                            } catch (cancelErr) {
                                DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                            }
                            this._idempotencyKey = null;
                            throw new Error(stripeError.message);
                        }

                        if (paymentIntent.status !== 'succeeded') {
                            try {
                                await API.cancelOrder(dupOrderNumber);
                            } catch (cancelErr) {
                                DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                            }
                            this._idempotencyKey = null;
                            throw new Error('Payment was not completed. Please try again.');
                        }

                        // Payment succeeded — clear cart and redirect
                        try { await API.clearCart(); } catch (e) { DebugLog.warn('Could not clear cart:', e); }
                        if (typeof Cart !== 'undefined') {
                            Cart.items = [];
                            document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => { el.textContent = '0'; });
                        }
                        localStorage.removeItem('inkcartridges_cart');
                    }

                    // No client_secret means payment already succeeded — safe to redirect
                    sessionStorage.setItem('lastOrder', JSON.stringify({
                        order_number: dupOrderNumber,
                        email: this.checkoutData.email
                    }));
                    sessionStorage.removeItem('checkoutData');
                    window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(dupOrderNumber)}`;
                    return;
                }

                if (!orderResponse.ok) {
                    const errorCode = orderResponse.error?.code || '';
                    const errorMsg = orderResponse.error?.message || orderResponse.error || 'Failed to create order';

                    if (errorCode === 'DUPLICATE_ORDER') {
                        // Order already exists — only redirect if it has no pending payment
                        const existingOrder = orderResponse.error?.details?.order_number;
                        const existingClientSecret = orderResponse.error?.details?.client_secret;
                        if (existingOrder && !existingClientSecret) {
                            window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(existingOrder)}`;
                            return;
                        } else if (existingOrder && existingClientSecret) {
                            // Payment wasn't completed — show error so user retries
                            throw new Error('Your previous payment was not completed. Please try again.');
                        }
                    } else if (errorCode === 'DUPLICATE_REQUEST') {
                        // Concurrent request — wait and check
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                            const pending = await API.checkPendingOrder(this.getIdempotencyKey());
                            if (pending.ok && pending.data?.order_number) {
                                // Only redirect if payment was completed (no client_secret means paid)
                                if (!pending.data.client_secret) {
                                    window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(pending.data.order_number)}`;
                                    return;
                                }
                                // Has client_secret — payment still pending, let user retry
                                this._idempotencyKey = null;
                                throw new Error('Your previous payment was not completed. Please try again.');
                            }
                        } catch (e) {
                            if (e.message?.includes('not completed')) throw e;
                            /* fall through to error */
                        }
                    } else if (errorCode === 'PROMO_COUPON_LIMIT_REACHED') {
                        throw new Error('This coupon has reached its usage limit. Please remove it and try again.');
                    } else if (errorCode === 'ORDER_TOTAL_TOO_LOW') {
                        throw new Error('Your order total is below the minimum. Please add more items.');
                    } else if (errorCode === 'ACCOUNT_FLAGGED') {
                        if (typeof showToast === 'function') {
                            showToast('Your account has been flagged for review. Please contact support.', 'error', 0);
                        }
                        return; // Don't throw — just show toast
                    }
                    throw new Error(errorMsg);
                }

                const { client_secret, order_id, order_number, total_amount } = orderResponse.data;

                // STEP 3: Confirm payment with Stripe PaymentElement
                btnText.innerHTML = this.getLoadingHTML('Processing payment...');

                const { error: stripeError, paymentIntent } = await this.stripe.confirmPayment({
                    elements: this.elements,
                    clientSecret: client_secret,
                    confirmParams: {
                        return_url: `${window.location.origin}/html/order-confirmation.html?order=${encodeURIComponent(order_number)}`,
                        payment_method_data: {
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
                    },
                    redirect: 'if_required'
                });

                if (stripeError) {
                    DebugLog.error('Stripe error:', stripeError);
                    // Cancel the pending order to restore stock
                    try {
                        await API.cancelOrder(order_number);
                        DebugLog.log('Pending order cancelled:', order_number);
                    } catch (cancelErr) {
                        DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                    }
                    // Reset idempotency key so the user can retry with a new order
                    this._idempotencyKey = null;
                    throw new Error(stripeError.message);
                }

                if (paymentIntent.status !== 'succeeded') {
                    // Cancel the pending order to restore stock
                    try {
                        await API.cancelOrder(order_number);
                        DebugLog.log('Pending order cancelled:', order_number);
                    } catch (cancelErr) {
                        DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                    }
                    this._idempotencyKey = null;
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
                <span style="display:inline-flex;align-items:center;gap:8px">
                    <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
                        <path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"/>
                    </svg>
                    ${text}
                </span>
            `;
        },

        /**
         * Show error message
         */
        showError(message) {
            const errorEl = document.getElementById('card-errors');
            if (errorEl) {
                const esc = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;
                errorEl.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${esc(message)}
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
