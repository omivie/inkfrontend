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
        isGuestCheckout: false,
        turnstileToken: null,
        turnstileWidgetId: undefined,


        // Idempotency key — deterministic SHA-256 hash including payment method
        async getIdempotencyKey(paymentMethod) {
            // Build deterministic string from user ID + sorted item IDs + address + payment method
            const user = typeof Auth !== 'undefined' ? Auth.getUser() : null;
            const userId = user?.id || 'guest';
            const sortedItemIds = this.cartItems
                .map(item => `${item.id}:${item.quantity}`)
                .sort()
                .join(',');
            const addr = this.checkoutData || {};
            const addressStr = [addr.address1, addr.address2, addr.city, addr.region, addr.postcode].join('|');
            const raw = userId + sortedItemIds + addressStr + (paymentMethod || '');

            const encoded = new TextEncoder().encode(raw);
            const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
                showToast('No checkout data found. Please fill in your details first.', 'error');
                setTimeout(() => { window.location.href = '/html/checkout.html'; }, 1500);
                return;
            }

            // Display shipping summary
            this.displayShippingSummary();

            // Load cart
            await this.loadCart();

            // Initialize Stripe
            this.initStripe();

            // Initialize Turnstile (guest-only bot protection)
            this.initTurnstile();

            // Initialize PayPal button (custom integration, not via Stripe)
            this.initPayPalButton();

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
                if (!data) return null;
                sessionStorage.removeItem('checkoutData');
                return JSON.parse(data);
            } catch (e) {
                DebugLog.error('Failed to load checkout data:', e);
                return null;
            }
        },

        /**
         * Display shipping summary
         */
        displayShippingSummary() {
            const leftCol = document.getElementById('shipping-col-left');
            const rightCol = document.getElementById('shipping-col-right');
            if (!this.checkoutData) return;

            const d = this.checkoutData;
            // esc() provided by utils.js

            if (leftCol) {
                leftCol.innerHTML = `
                    <p><strong>${esc(d.firstName)} ${esc(d.lastName)}</strong></p>
                    <p>${esc(d.address1)}${d.address2 ? ', ' + esc(d.address2) : ''}</p>
                    <p>${esc(d.city)}, ${esc(d.region)} ${esc(d.postcode)}</p>
                `;
            }
            if (rightCol) {
                rightCol.innerHTML = `
                    <p>${esc(d.email)}</p>
                    ${d.phone ? `<p>${esc(d.phone)}</p>` : ''}
                `;
            }
        },

        /**
         * Load cart items from server (authoritative source)
         */
        async loadCart() {
            try {
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
                    showToast('Your cart is empty.', 'error');
                    setTimeout(() => { window.location.href = '/html/cart.html'; }, 1500);
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

            // esc() provided by utils.js
            const escAttr = typeof Security !== 'undefined' ? Security.escapeAttr : (s) => s;
            container.innerHTML = this.cartItems.map(item => `
                <li class="checkout-summary__item">
                    <div class="checkout-summary__item-image">
                        <img src="${escAttr(item.image || '/assets/images/placeholder.png')}" alt="${escAttr(item.name)}" loading="lazy" data-fallback="placeholder">
                        <span class="checkout-summary__item-qty">${parseInt(item.quantity) || 0}</span>
                    </div>
                    <div class="checkout-summary__item-details">
                        <span class="checkout-summary__item-name">${esc(item.name)}</span>
                        <span class="checkout-summary__item-variant">${esc(item.sku || '')}</span>
                    </div>
                    <span class="checkout-summary__item-price">$${(parseFloat(item.price) * parseInt(item.quantity)).toFixed(2)}</span>
                </li>
            `).join('');

            // Bind image error fallbacks
            if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
                Products.bindImageFallbacks(container);
            }
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
                        image: typeof storageUrl === 'function' ? storageUrl(item.product?.image_url) : (item.product?.image_url || '/assets/images/placeholder.png')
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
                DebugLog.warn('Server totals unavailable:', error.message);
                this.showError('Unable to load order total. Please refresh and try again.');
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
                layout: 'tabs',
                defaultValues: {
                    billingDetails: {
                        name: `${this.checkoutData.firstName || ''} ${this.checkoutData.lastName || ''}`.trim(),
                        email: this.checkoutData.email || '',
                        phone: this.checkoutData.phone || ''
                    }
                }
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

        // Note: Apple Pay / Google Pay are handled natively by PaymentElement
        // PayPal uses a separate custom integration (PayPal JS SDK), see initPayPalButton()

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

            const turnstileOk = !this.isGuestCheckout || !!this.turnstileToken;
            const canPay = this.paymentElementReady && this.paymentAuthorized && turnstileOk;
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
                showToast('Please authorize the payment before proceeding.', 'error');
                return;
            }

            if (!this.paymentElementReady) {
                showToast('Please complete your payment details.', 'error');
                return;
            }

            if (this.isGuestCheckout && !this.turnstileToken) {
                showToast('Please complete the human verification check.', 'error');
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

                // STEP 0.5: Ensure cart items are on the server before validation
                // Cross-origin cookie issues or rate limits may leave the server cart empty
                if (this.cartItems.length > 0) {
                    btnText.innerHTML = this.getLoadingHTML('Preparing cart...');
                    for (const item of this.cartItems) {
                        try {
                            await API.addToCart(item.id, item.quantity);
                        } catch (e) {
                            DebugLog.warn('Cart sync failed for item:', item.id, e.message);
                        }
                    }
                }

                // Create order on backend
                // Backend creates PaymentIntent and validates all prices server-side
                btnText.innerHTML = this.getLoadingHTML('Creating order...');

                // Build items array from cart
                const items = this.cartItems.map(item => ({
                    product_id: item.id,
                    quantity: item.quantity
                }));

                const isGuest = typeof Auth === 'undefined' || !Auth.isAuthenticated();
                const orderResponse = await API.createOrder({
                    items: items,
                    shipping_address: {
                        first_name: this.checkoutData.firstName,
                        last_name: this.checkoutData.lastName,
                        phone: this.checkoutData.phone || '',
                        address_line_1: this.checkoutData.address1,
                        address_line_2: this.checkoutData.address2 || '',
                        city: this.checkoutData.city,
                        region: this.checkoutData.region,
                        postal_code: this.checkoutData.postcode,
                        country: 'NZ'
                    },
                    shipping_tier: this.checkoutData.shippingTier || '',
                    shipping_zone: this.checkoutData.shippingZone || '',
                    delivery_type: this.checkoutData.deliveryType || 'urban',
                    estimated_shipping: this.checkoutData.estimatedShipping ?? null,
                    save_address: this.checkoutData.saveAddress !== false,
                    customer_notes: this.checkoutData.orderNotes || '',
                    payment_method: 'stripe',
                    idempotency_key: await this.getIdempotencyKey('stripe'),
                    ...(isGuest && { guest_email: this.checkoutData.email }),
                    ...(isGuest && this.checkoutData.phone && { guest_phone: this.checkoutData.phone }),
                    ...(isGuest && this.turnstileToken && { turnstile_token: this.turnstileToken })
                });

                // Handle duplicate/idempotent replay
                if (orderResponse.ok && orderResponse.data?.is_duplicate) {
                    const dupData = orderResponse.data;
                    const dupOrderNumber = dupData.order_number;
                    const dupPaymentMethod = dupData.payment_method;

                    // If duplicate is from a different payment method (e.g. cancelled PayPal),
                    // cancel it and create a fresh Stripe order
                    if (dupPaymentMethod && dupPaymentMethod !== 'stripe') {
                        try {
                            await API.cancelOrder(dupOrderNumber);
                            DebugLog.log('Cancelled stale', dupPaymentMethod, 'order:', dupOrderNumber);
                        } catch (cancelErr) {
                            DebugLog.warn('Could not cancel stale order:', cancelErr.message);
                        }
                        throw new Error('A previous payment attempt was cleared. Please click Pay again.');
                    }

                    if (dupData.client_secret) {
                        // Payment wasn't completed — retry with the existing PaymentIntent
                        btnText.innerHTML = this.getLoadingHTML('Retrying payment...');

                        // Store order data before confirmPayment (redirect may happen)
                        sessionStorage.setItem('lastOrder', JSON.stringify({
                            order_number: dupOrderNumber,
                            email: this.checkoutData.email
                        }));

                        const { error: stripeError } = await this.stripe.confirmPayment({
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
                            }
                        });

                        // If confirmPayment succeeds without redirect (card), it returns here.
                        // If it redirects (PayPal), this code won't execute — confirmation page handles it.
                        if (stripeError) {
                            console.error('[Payment] Stripe confirmPayment error (retry):', stripeError.code, stripeError.decline_code, stripeError.message);
                            sessionStorage.removeItem('lastOrder');
                            try {
                                await API.cancelOrder(dupOrderNumber);
                            } catch (cancelErr) {
                                DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                            }
                            throw new Error(this.getStripeErrorMessage(stripeError));
                        }

                        // If we reach here, payment succeeded without redirect — clear cart and redirect
                        try { await API.clearCart(); } catch (e) { DebugLog.warn('Could not clear cart:', e); }
                        if (typeof Cart !== 'undefined') {
                            Cart.items = [];
                            document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => { el.textContent = '0'; });
                        }
                        localStorage.removeItem('inkcartridges_cart');
                    }

                    // No client_secret — verify payment method before assuming paid
                    if (!dupPaymentMethod) {
                        // Unknown state: no client_secret AND no payment_method info
                        // Fetch order status to verify it's actually paid before redirecting
                        try {
                            const orderCheck = await API.getOrder(dupOrderNumber);
                            if (orderCheck.ok && orderCheck.data?.status === 'paid') {
                                sessionStorage.setItem('lastOrder', JSON.stringify({
                                    order_number: dupOrderNumber,
                                    email: this.checkoutData.email
                                }));
                                sessionStorage.removeItem('checkoutData');
                                window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(dupOrderNumber)}`;
                                return;
                            }
                        } catch (e) {
                            DebugLog.warn('Could not verify duplicate order status:', e.message);
                        }
                        // Not confirmed paid — cancel and let user retry
                        try {
                            await API.cancelOrder(dupOrderNumber);
                        } catch (cancelErr) {
                            DebugLog.warn('Could not cancel ambiguous order:', cancelErr.message);
                        }
                        throw new Error('A previous payment attempt was cleared. Please click Pay again.');
                    }

                    // Same payment method (stripe), no client_secret = already paid — redirect
                    sessionStorage.setItem('lastOrder', JSON.stringify({
                        order_number: dupOrderNumber,
                        email: this.checkoutData.email
                    }));
                    sessionStorage.removeItem('checkoutData');
                    window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(dupOrderNumber)}`;
                    return;
                }

                if (!orderResponse.ok) {
                    const errorCode = orderResponse.code || '';
                    const errorMsg = orderResponse.error || 'Failed to create order';

                    if (errorCode === 'DUPLICATE_ORDER') {
                        const details = orderResponse.data?.error?.details || orderResponse.data?.details || {};
                        const existingOrder = details.order_number;
                        const existingClientSecret = details.client_secret;
                        const existingPaymentMethod = details.payment_method;

                        // Stale order from different payment method (e.g. cancelled PayPal) — cancel and retry
                        if (existingOrder && existingPaymentMethod && existingPaymentMethod !== 'stripe') {
                            try {
                                await API.cancelOrder(existingOrder);
                                DebugLog.log('Cancelled stale', existingPaymentMethod, 'order:', existingOrder);
                            } catch (cancelErr) {
                                DebugLog.warn('Could not cancel stale order:', cancelErr.message);
                            }
                            throw new Error('A previous payment attempt was cleared. Please click Pay again.');
                        }

                        if (existingOrder && !existingClientSecret) {
                            // Same payment method or unknown, no client_secret
                            if (!existingPaymentMethod) {
                                // Unknown state — verify order is actually paid before redirecting
                                try {
                                    const orderCheck = await API.getOrder(existingOrder);
                                    if (orderCheck.ok && orderCheck.data?.status === 'paid') {
                                        window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(existingOrder)}`;
                                        return;
                                    }
                                } catch (e) {
                                    DebugLog.warn('Could not verify duplicate order status:', e.message);
                                }
                                // Not confirmed paid — cancel and let user retry
                                try {
                                    await API.cancelOrder(existingOrder);
                                } catch (cancelErr) {
                                    DebugLog.warn('Could not cancel ambiguous order:', cancelErr.message);
                                }
                                throw new Error('A previous payment attempt was cleared. Please click Pay again.');
                            }
                            // payment_method is 'stripe' and no client_secret = already paid
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
                            const pending = await API.checkPendingOrder(await this.getIdempotencyKey('stripe'));
                            if (pending.ok && pending.data?.order_number) {
                                // Only redirect if payment was completed (no client_secret means paid)
                                if (!pending.data.client_secret) {
                                    window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(pending.data.order_number)}`;
                                    return;
                                }
                                // Has client_secret — payment still pending, let user retry
        
                                throw new Error('Your previous payment was not completed. Please try again.');
                            }
                        } catch (e) {
                            if (e.message?.includes('not completed')) throw e;
                            /* fall through to error */
                        }
                    } else if (errorCode === 'EMAIL_NOT_VERIFIED') {
                        this.showEmailVerificationRequired();
                        return;
                    } else if (errorCode === 'PROMO_COUPON_LIMIT_REACHED') {
                        throw new Error('This coupon has reached its usage limit. Please remove it and try again.');
                    } else if (errorCode === 'ORDER_TOTAL_TOO_LOW') {
                        throw new Error('Your order total is below the minimum. Please add more items.');
                    } else if (errorCode === 'ACCOUNT_FLAGGED') {
                        if (typeof showToast === 'function') {
                            showToast('Your account has been flagged for review. Please contact support.', 'error', 0);
                        }
                        return; // Don't throw — just show toast
                    } else if (errorCode === 'DISPOSABLE_EMAIL') {
                        this.resetTurnstile();
                        throw new Error('Please use a permanent email address for your order.');
                    } else if (errorCode === 'IP_FLAGGED') {
                        if (typeof showToast === 'function') {
                            showToast('Unable to process your order. Please contact support.', 'error', 0);
                        }
                        return;
                    } else if (errorCode === 'TURNSTILE_MISSING') {
                        this.resetTurnstile();
                        throw new Error('Please complete the security check and try again.');
                    } else if (errorCode === 'TURNSTILE_FAILED') {
                        this.resetTurnstile();
                        throw new Error('Security verification failed. Please complete the check and try again.');
                    }
                    throw new Error(errorMsg);
                }

                const { client_secret, order_id, order_number, total_amount } = orderResponse.data;

                // STEP 3: Store order data before confirmPayment
                // confirmPayment may redirect (PayPal, 3DS) before post-payment code runs
                sessionStorage.setItem('lastOrder', JSON.stringify({
                    order_number: order_number,
                    email: this.checkoutData.email
                }));

                // STEP 4: Confirm payment with Stripe PaymentElement
                btnText.innerHTML = this.getLoadingHTML('Processing payment...');

                const { error: stripeError } = await this.stripe.confirmPayment({
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
                    }
                });

                // If we reach here, confirmPayment returned without redirecting (e.g. error)
                // Successful payments redirect to return_url — confirmation page handles the rest
                if (stripeError) {
                    console.error('[Payment] Stripe confirmPayment error:', stripeError.code, stripeError.decline_code, stripeError.message);
                    sessionStorage.removeItem('lastOrder');
                    // Cancel the pending order to restore stock
                    try {
                        await API.cancelOrder(order_number);
                        DebugLog.log('Pending order cancelled:', order_number);
                    } catch (cancelErr) {
                        DebugLog.warn('Could not cancel pending order:', cancelErr.message);
                    }
                    throw new Error(this.getStripeErrorMessage(stripeError));
                }

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
         * Map a Stripe error to a user-friendly message.
         * Stripe's raw messages are sometimes too technical for customers.
         */
        getStripeErrorMessage(stripeError) {
            const code = stripeError?.code;
            const declineCode = stripeError?.decline_code;
            const friendly = {
                card_declined:           'Your card was declined. Please try a different card or contact your bank.',
                insufficient_funds:      'Your card has insufficient funds. Please try a different card.',
                expired_card:            'Your card has expired. Please use a different card.',
                incorrect_cvc:           'Incorrect security code (CVV). Please check and try again.',
                incorrect_number:        'Your card number is incorrect. Please check and try again.',
                invalid_number:          'Your card number is invalid. Please check and try again.',
                invalid_expiry_month:    'Your card expiry month is invalid.',
                invalid_expiry_year:     'Your card expiry year is invalid.',
                processing_error:        'An error occurred processing your card. Please try again in a moment.',
                do_not_honor:            'Your card was declined. Please contact your bank or try a different card.',
                lost_card:               'Your card was declined. Please try a different card.',
                stolen_card:             'Your card was declined. Please try a different card.',
                pickup_card:             'Your card was declined. Please try a different card.',
                fraudulent:              'Your card was declined. Please try a different card.',
                generic_decline:         'Your card was declined. Please contact your bank or try a different card.',
                payment_intent_authentication_failure: 'Payment authentication failed. Please try again.',
            };
            return friendly[declineCode] || friendly[code] || stripeError?.message || 'Payment failed. Please try again.';
        },

        /**
         * Show error message and scroll it into view.
         */
        showError(message) {
            const errorEl = document.getElementById('card-errors');
            if (errorEl) {
                // esc() provided by utils.js
                errorEl.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${esc(message)}
                `;
                errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        },

        showEmailVerificationRequired() {
            const errorEl = document.getElementById('card-errors');
            if (errorEl) {
                errorEl.innerHTML = `
                    <div style="display:flex;flex-direction:column;gap:10px">
                        <div style="display:flex;align-items:center;gap:6px">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <strong>Email verification required.</strong>
                        </div>
                        <p style="margin:0;font-size:14px;color:#555">Please verify your email address before placing an order. Check your inbox for a verification link.</p>
                        <button type="button" class="btn btn--secondary btn--sm" id="payment-resend-verification-btn">
                            Resend Verification Email
                        </button>
                    </div>
                `;
                errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                document.getElementById('payment-resend-verification-btn')?.addEventListener('click', async (e) => {
                    const btn = e.target;
                    btn.disabled = true;
                    btn.textContent = 'Sending\u2026';
                    try {
                        await API.resendVerificationEmail();
                        if (typeof showToast === 'function') {
                            showToast('Verification email sent! Check your inbox.', 'success');
                        }
                        btn.textContent = 'Email Sent';
                    } catch (err) {
                        if (typeof showToast === 'function') {
                            showToast('Failed to resend. Please try again.', 'error');
                        }
                        btn.disabled = false;
                        btn.textContent = 'Resend Verification Email';
                    }
                });
            }

            // Re-enable pay button so user can retry after verifying
            this.isSubmitting = false;
            const submitBtn = document.getElementById('submit-payment');
            if (submitBtn) {
                submitBtn.disabled = false;
                const btnText = submitBtn.querySelector('.btn__text') || submitBtn;
                btnText.textContent = 'Pay Now';
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
        },

        /**
         * Initialize Cloudflare Turnstile widget for guest checkouts.
         * Widget is shown only when the user is not authenticated.
         */
        initTurnstile() {
            this.isGuestCheckout = typeof Auth === 'undefined' || !Auth.isAuthenticated();
            if (!this.isGuestCheckout) return;

            const siteKey = (typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY) || '';
            if (!siteKey) return;

            const container = document.getElementById('turnstile-container');
            if (container) container.style.display = '';

            const self = this;
            const doRender = () => {
                self.turnstileWidgetId = turnstile.render('#turnstile-widget', {
                    sitekey: siteKey,
                    callback: (token) => { self.turnstileToken = token; self.updatePayButton(); },
                    'expired-callback': () => { self.turnstileToken = null; self.updatePayButton(); },
                    'error-callback': () => { self.turnstileToken = null; self.updatePayButton(); }
                });
            };

            if (typeof turnstile !== 'undefined') {
                doRender();
            } else {
                // Poll until Turnstile SDK is ready (loaded async/defer)
                let attempts = 0;
                const poll = setInterval(() => {
                    if (typeof turnstile !== 'undefined') {
                        clearInterval(poll);
                        doRender();
                    } else if (++attempts > 20) {
                        clearInterval(poll);
                        DebugLog.warn('Turnstile SDK did not load in time');
                    }
                }, 250);
            }
        },

        /**
         * Reset the Turnstile widget after a failed/expired challenge.
         */
        resetTurnstile() {
            if (typeof turnstile !== 'undefined' && this.turnstileWidgetId !== undefined) {
                turnstile.reset(this.turnstileWidgetId);
            }
            this.turnstileToken = null;
        },

        /**
         * Initialize PayPal button using PayPal JS SDK (popup approach)
         * Separate from Stripe — backend has its own PayPal integration
         */
        initPayPalButton() {
            const container = document.getElementById('paypal-button-container');
            if (!container) {
                DebugLog.warn('PayPal button container not found');
                return;
            }

            // Wait for PayPal SDK to load
            if (typeof paypal === 'undefined') {
                DebugLog.warn('PayPal SDK not loaded');
                container.innerHTML = '<p style="color: var(--gray-500); font-size: 0.8125rem; text-align: center;">PayPal unavailable. Please use card payment.</p>';
                return;
            }

            const self = this;

            paypal.Buttons({
                style: {
                    layout: 'vertical',
                    color: 'gold',
                    shape: 'rect',
                    label: 'paypal',
                    height: 48
                },

                createOrder: async () => {
                    console.log('[PayPal] createOrder called — building payload...');
                    // Build order payload with payment_method: 'paypal'
                    const items = self.cartItems.map(item => ({
                        product_id: item.id,
                        quantity: item.quantity
                    }));

                    const isGuest = typeof Auth === 'undefined' || !Auth.isAuthenticated();
                    const orderPayload = {
                        items: items,
                        shipping_address: {
                            first_name: self.checkoutData.firstName,
                            last_name: self.checkoutData.lastName,
                            phone: self.checkoutData.phone || '',
                            address_line_1: self.checkoutData.address1,
                            address_line_2: self.checkoutData.address2 || '',
                            city: self.checkoutData.city,
                            region: self.checkoutData.region,
                            postal_code: self.checkoutData.postcode,
                            country: 'NZ'
                        },
                        shipping_tier: self.checkoutData.shippingTier || '',
                        shipping_zone: self.checkoutData.shippingZone || '',
                        delivery_type: self.checkoutData.deliveryType || 'urban',
                        estimated_shipping: self.checkoutData.estimatedShipping ?? null,
                        save_address: self.checkoutData.saveAddress !== false,
                        customer_notes: self.checkoutData.orderNotes || '',
                        payment_method: 'paypal',
                        idempotency_key: await self.getIdempotencyKey('paypal'),
                        ...(isGuest && { guest_email: self.checkoutData.email }),
                        ...(isGuest && self.checkoutData.phone && { guest_phone: self.checkoutData.phone }),
                        ...(isGuest && self.turnstileToken && { turnstile_token: self.turnstileToken })
                    };

                    console.log('[PayPal] Sending order payload:', JSON.stringify(orderPayload, null, 2));

                    const response = await API.createOrder(orderPayload);
                    console.log('[PayPal] API response:', JSON.stringify(response, null, 2));

                    if (!response.ok) {
                        const errorCode = response.code || '';
                        console.error('[PayPal] API returned error:', errorCode, response.error);
                        if (errorCode === 'ORDER_TOTAL_TOO_LOW') {
                            throw new Error('Your order total is below the minimum. Please add more items.');
                        } else if (errorCode === 'DISPOSABLE_EMAIL') {
                            self.resetTurnstile();
                            throw new Error('Please use a permanent email address for your order.');
                        } else if (errorCode === 'IP_FLAGGED') {
                            self.showError('Unable to process your order. Please contact support.');
                            throw new Error('IP_FLAGGED'); // halt PayPal flow
                        } else if (errorCode === 'TURNSTILE_MISSING') {
                            self.resetTurnstile();
                            throw new Error('Please complete the security check and try again.');
                        } else if (errorCode === 'TURNSTILE_FAILED') {
                            self.resetTurnstile();
                            throw new Error('Security verification failed. Please complete the check and try again.');
                        } else if (errorCode === 'EMAIL_NOT_VERIFIED') {
                            self.showEmailVerificationRequired();
                            throw new Error('EMAIL_NOT_VERIFIED');
                        }
                        throw new Error(response.error || 'Failed to create PayPal order');
                    }

                    const data = response.data;

                    // Handle duplicate order replay
                    if (data.is_duplicate && data.paypal_order_id) {
                        console.log('[PayPal] Duplicate order — reusing paypal_order_id:', data.paypal_order_id);
                        self._pendingPayPalOrderNumber = data.order_number;
                        return data.paypal_order_id;
                    }

                    // Stale duplicate (cancelled or missing paypal_order_id) — cancel and retry
                    if (data.is_duplicate && !data.paypal_order_id) {
                        console.log('[PayPal] Stale duplicate order (status:', data.status, ') — cancelling and retrying...');
                        try {
                            await API.cancelOrder(data.order_number);
                            console.log('[PayPal] Cancelled stale order:', data.order_number);
                        } catch (cancelErr) {
                            console.warn('[PayPal] Could not cancel stale order:', cancelErr.message);
                        }
                        // Retry with a fresh idempotency key
                        orderPayload.idempotency_key = await self.getIdempotencyKey('paypal-retry-' + Date.now());
                        const retryResponse = await API.createOrder(orderPayload);
                        console.log('[PayPal] Retry API response:', JSON.stringify(retryResponse, null, 2));

                        if (!retryResponse.ok) {
                            throw new Error(retryResponse.error || 'Failed to create PayPal order on retry');
                        }
                        const retryData = retryResponse.data;
                        if (!retryData.paypal_order_id) {
                            throw new Error('Server did not return a PayPal order on retry. Please contact support.');
                        }
                        self._pendingPayPalOrderNumber = retryData.order_number;
                        console.log('[PayPal] Retry succeeded. order_number:', retryData.order_number, 'paypal_order_id:', retryData.paypal_order_id);
                        return retryData.paypal_order_id;
                    }

                    if (data.payment_method !== 'paypal' || !data.paypal_order_id) {
                        console.error('[PayPal] Missing paypal_order_id in response. payment_method:', data.payment_method, 'paypal_order_id:', data.paypal_order_id);
                        throw new Error('Server did not return a PayPal order. Please try again.');
                    }

                    // Store order number for capture step
                    self._pendingPayPalOrderNumber = data.order_number;
                    console.log('[PayPal] Order created. order_number:', data.order_number, 'paypal_order_id:', data.paypal_order_id);
                    return data.paypal_order_id;
                },

                onApprove: async (data) => {
                    console.log('[PayPal] onApprove — user approved. orderID:', data.orderID);
                    // User approved payment in PayPal popup — capture it
                    try {
                        const orderNumber = self._pendingPayPalOrderNumber;
                        if (!orderNumber) {
                            throw new Error('Order number not found. Please try again.');
                        }

                        console.log('[PayPal] Capturing payment for order:', orderNumber);
                        const captureResponse = await API.capturePaypal(orderNumber, data.orderID);
                        console.log('[PayPal] Capture response:', JSON.stringify(captureResponse, null, 2));

                        if (captureResponse.ok && captureResponse.data?.status === 'paid') {
                            // Payment successful — clear cart and redirect
                            try { await API.clearCart(); } catch (e) { DebugLog.warn('Could not clear cart:', e); }
                            if (typeof Cart !== 'undefined') {
                                Cart.items = [];
                                document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => { el.textContent = '0'; });
                            }
                            localStorage.removeItem('inkcartridges_cart');

                            sessionStorage.setItem('lastOrder', JSON.stringify({
                                order_number: orderNumber,
                                email: self.checkoutData.email
                            }));
                            sessionStorage.removeItem('checkoutData');
                            window.location.href = `/html/order-confirmation.html?order=${encodeURIComponent(orderNumber)}`;
                        } else {
                            self.showError(captureResponse.error?.message || 'Payment capture failed. Please contact support.');
                        }
                    } catch (error) {
                        DebugLog.error('PayPal capture error:', error);
                        self.showError(error.message || 'Something went wrong capturing your PayPal payment.');
                    }
                },

                onCancel: () => {
                    console.log('[PayPal] Payment cancelled by user');
                    self.showError('PayPal payment was cancelled. You can try again or use a different payment method.');
                },

                onError: (err) => {
                    console.error('[PayPal] SDK onError fired:', err);
                    console.error('[PayPal] Error message:', err?.message || String(err));
                    // Skip generic error if we already showed a specific UI (e.g. email verification)
                    if (err?.message === 'EMAIL_NOT_VERIFIED') return;
                    self.showError('Something went wrong with PayPal. Please try again or use a different payment method.');
                }
            }).render('#paypal-button-container').then(() => {
                DebugLog.log('PayPal button initialized successfully');
            }).catch((err) => {
                DebugLog.error('PayPal button render failed:', err);
                const container = document.getElementById('paypal-button-container');
                if (container) container.innerHTML = '<p style="color: var(--color-error, #dc2626); font-size: 0.8125rem; text-align: center;">PayPal is unavailable. Please use card payment.</p>';
            });
        }
    };

    // Initialize when ready
    document.addEventListener('DOMContentLoaded', () => {
        if (typeof Auth !== 'undefined') {
            let initialized = false;
            const checkAuth = setInterval(() => {
                if (Auth.initialized && !initialized) {
                    initialized = true;
                    clearInterval(checkAuth);
                    PaymentPage.init();
                }
            }, 100);

            setTimeout(() => {
                clearInterval(checkAuth);
                if (!initialized) {
                    initialized = true;
                    PaymentPage.init();
                }
            }, 3000);
        } else {
            PaymentPage.init();
        }
    });
