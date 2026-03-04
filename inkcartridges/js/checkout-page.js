    // Checkout page state
    const CheckoutPage = {
        cartItems: [],
        totals: { subtotal: 0, shipping: 0, discount: 0, total: 0 },
        appliedCoupon: null,
        isSubmitting: false,
        isEmailVerified: false,

        // Get image HTML for an item (uses ProductColors from utils.js)
        getItemImageHTML(item) {
            const color = item.color || (typeof ProductColors !== 'undefined' ? ProductColors.detectFromName(item.name) : null);
            const colorStyle = color && typeof ProductColors !== 'undefined' ? ProductColors.getStyle(color) : null;

            const esc = typeof Security !== 'undefined' ? Security.escapeAttr : (s) => s;

            if (item.image) {
                if (colorStyle) {
                    return `<img src="${esc(item.image)}" alt="${esc(item.name)}" width="50" height="50" style="object-fit: contain;"
                                data-fallback="color-block">
                            <div style="${colorStyle} width: 50px; height: 50px; border-radius: 4px; display: none;"></div>`;
                } else {
                    return `<img src="${esc(item.image)}" alt="${esc(item.name)}" width="50" height="50" style="object-fit: contain;"
                                data-fallback="placeholder">`;
                }
            } else if (colorStyle) {
                return `<div style="${colorStyle} width: 50px; height: 50px; border-radius: 4px;"></div>`;
            }
            return `<svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="6" y="2" width="12" height="20" rx="2"/></svg>`;
        },

        // Initialize checkout page
        async init() {
            await this.loadCart();
            this.renderCart();
            this.setupFormHandlers();
            this.setupShippingHandlers();
            this.setupBillingAddressToggle();
            this.setupProgressValidation();

            // Wait for Auth to initialize, then check auth status
            await this.checkAuthAndPrefill();

            // Restore any saved checkout state (after auth prefill, so auth data takes priority)
            this.restoreCheckoutState();

            // Check email verification status
            await this.checkEmailVerification();

            // Track checkout started for analytics
            if (typeof CartAnalytics !== 'undefined') {
                CartAnalytics.trackCheckoutStarted();
            }
        },

        // Check email verification status
        async checkEmailVerification() {
            if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
                // Not logged in - assume verified for guest checkout
                this.isEmailVerified = true;
                return;
            }

            try {
                const response = await API.getVerificationStatus();
                DebugLog.log('Verification status response:', response);

                if (response.success && response.data) {
                    this.isEmailVerified = response.data.email_verified;
                } else {
                    // If API returns success: false but no specific "not verified" indication, assume verified
                    this.isEmailVerified = true;
                }
            } catch (error) {
                DebugLog.log('Verification check error:', error.message);
                // If error message contains "already verified" or "verified", they ARE verified
                // Also if we get any error, assume verified to not block checkout
                if (error.message) {
                    const msg = error.message.toLowerCase();
                    if (msg.includes('verified') || msg.includes('not found')) {
                        this.isEmailVerified = true;
                    }
                }
                // Default to verified to not block users
                this.isEmailVerified = true;
            }

            // Only show verification required if explicitly NOT verified
            if (this.isEmailVerified === false) {
                this.showVerificationRequired();
            } else {
                // Remove any existing verification message
                const existingMsg = document.getElementById('verification-required');
                if (existingMsg) existingMsg.remove();
            }
        },

        // Show verification required message
        showVerificationRequired() {
            const formWrapper = document.querySelector('.checkout-form-wrapper');
            if (!formWrapper) return;

            const existingMsg = document.getElementById('verification-required');
            if (existingMsg) return;

            const verificationDiv = document.createElement('div');
            verificationDiv.id = 'verification-required';
            verificationDiv.className = 'verification-required';
            verificationDiv.innerHTML = `
                <h3 class="verification-required__title">Email Verification Required</h3>
                <p class="verification-required__text">Please verify your email address before completing your order. Check your inbox for a verification link.</p>
                <button type="button" class="btn btn--secondary btn--sm" id="resend-verification-btn">
                    Resend Verification Email
                </button>
            `;

            formWrapper.insertBefore(verificationDiv, formWrapper.firstChild);

            // Resend verification handler
            document.getElementById('resend-verification-btn')?.addEventListener('click', async () => {
                try {
                    await API.resendVerificationEmail();
                    alert('Verification email sent! Please check your inbox.');
                } catch (error) {
                    alert('Failed to resend verification email. Please try again.');
                }
            });
        },

        // Setup progress indicator validation
        setupProgressValidation() {
            const form = document.getElementById('checkout-form');
            if (!form) return;

            // Details section fields (Contact + Shipping Address + Shipping Method)
            const detailsFields = ['email', 'phone', 'first-name', 'last-name', 'address1', 'city', 'region', 'postcode'];

            // Payment section fields
            const paymentFields = ['card-number', 'card-expiry', 'card-cvc', 'card-name'];

            // Listen for input changes
            form.addEventListener('input', () => {
                this.updateProgressIndicators();
            });

            form.addEventListener('change', () => {
                this.updateProgressIndicators();
            });

            // Initial check
            this.updateProgressIndicators();
        },

        // Check if details section is complete
        isDetailsComplete() {
            const requiredFields = ['email', 'phone', 'first-name', 'last-name', 'address1', 'city', 'region', 'postcode'];

            for (const fieldId of requiredFields) {
                const field = document.getElementById(fieldId);
                if (!field || !field.value.trim()) {
                    return false;
                }
                // Basic email validation
                if (fieldId === 'email' && !field.value.includes('@')) {
                    return false;
                }
            }
            return true;
        },

        // Payment happens on payment.html, so always false here
        isPaymentComplete() {
            return false;
        },

        // Update all progress indicators
        updateProgressIndicators() {
            const detailsComplete = this.isDetailsComplete();
            const paymentComplete = this.isPaymentComplete();

            // Get all progress indicator containers
            const progressContainers = document.querySelectorAll('.checkout-progress');

            progressContainers.forEach(container => {
                const detailsStep = container.querySelector('[data-step="details"]');
                const paymentStep = container.querySelector('[data-step="payment"]');

                if (detailsStep) {
                    if (detailsComplete) {
                        detailsStep.classList.remove('checkout-progress__step--active');
                        detailsStep.classList.add('checkout-progress__step--completed');
                        detailsStep.querySelector('.checkout-progress__number').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
                    } else {
                        detailsStep.classList.add('checkout-progress__step--active');
                        detailsStep.classList.remove('checkout-progress__step--completed');
                        detailsStep.querySelector('.checkout-progress__number').textContent = '2';
                    }
                }

                if (paymentStep) {
                    if (paymentComplete && detailsComplete) {
                        paymentStep.classList.remove('checkout-progress__step--active');
                        paymentStep.classList.add('checkout-progress__step--completed');
                        paymentStep.querySelector('.checkout-progress__number').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
                    } else if (detailsComplete) {
                        paymentStep.classList.add('checkout-progress__step--active');
                        paymentStep.classList.remove('checkout-progress__step--completed');
                        paymentStep.querySelector('.checkout-progress__number').textContent = '3';
                    } else {
                        paymentStep.classList.remove('checkout-progress__step--active');
                        paymentStep.classList.remove('checkout-progress__step--completed');
                        paymentStep.querySelector('.checkout-progress__number').textContent = '3';
                    }
                }
            });
        },

        // Load cart from Cart object (server-first for authenticated users)
        async loadCart() {
            DebugLog.log('📦 CheckoutPage.loadCart() starting...');

            // Wait for Cart to be initialized
            if (typeof Cart !== 'undefined') {
                DebugLog.log('📦 Cart found, loading:', Cart.loading, 'items:', Cart.items?.length);

                // Wait for Cart to finish loading (with 10 second timeout)
                const maxWait = 10000;
                const startTime = Date.now();

                await new Promise(resolve => {
                    const check = () => {
                        if (!Cart.loading) {
                            DebugLog.log('📦 Cart finished loading, items:', Cart.items?.length);
                            resolve();
                        } else if (Date.now() - startTime > maxWait) {
                            DebugLog.warn('📦 Cart loading timeout, proceeding anyway');
                            resolve();
                        } else {
                            setTimeout(check, 50);
                        }
                    };
                    check();
                });

                this.cartItems = Cart.items || [];
                this.appliedCoupon = Cart.appliedCoupon;
                DebugLog.log('📦 Loaded cartItems:', this.cartItems.length);
            } else {
                DebugLog.warn('📦 Cart not available');
                this.cartItems = [];
                this.appliedCoupon = null;
            }

            if (this.cartItems.length === 0) {
                DebugLog.log('📦 Cart is empty, redirecting to cart page');
                window.location.href = '/html/cart.html';
                return;
            }

            DebugLog.log('📦 Proceeding with checkout, items:', this.cartItems.length);

            // DISPLAY ONLY - Calculate estimated totals for UI
            // SECURITY: These values are NEVER sent to payment processor.
            // Backend recalculates all totals when creating the order in payment.html
            this.totals.subtotal = this.cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            this.calculateDiscount();
            this.updateShippingCost();
        },

        // SECURITY: Discount comes from backend only
        // Cart object stores server-validated discount amount
        calculateDiscount() {
            // Use discount from Cart object (which is server-validated)
            if (typeof Cart !== 'undefined' && Cart.discountAmount) {
                this.totals.discount = Cart.discountAmount;
            } else {
                this.totals.discount = 0;
            }
        },

        // Update shipping cost and UI info (ETA, spend-more, split shipment)
        // NOTE: Final shipping cost is validated server-side during checkout
        // These are estimates only - backend has final authority
        async updateShippingCost() {
            // Calculate shipping via Shipping module
            this.setFallbackShipping();

            this.totals.total = this.totals.subtotal - this.totals.discount + this.totals.shipping;
            this.updateTotalsDisplay();
            this.updateShippingInfo();
        },

        /**
         * DISPLAY ONLY - Shipping estimate for UI
         * SECURITY: These values are NEVER used for payment.
         * Backend calculates actual shipping in API.createOrder()
         * The PaymentIntent amount is set server-side.
         */
        setFallbackShipping() {
            // DISPLAY ONLY - backend has final authority on shipping cost
            const region = document.getElementById('region')?.value || '';
            if (typeof Shipping !== 'undefined') {
                const result = Shipping.calculate(this.cartItems, this.totals.subtotal, region);
                this.totals.shipping = result.fee;
                this._shippingResult = result;
            } else {
                this.totals.shipping = this.totals.subtotal >= 100 ? 0 : 9.95;
                this._shippingResult = null;
            }
        },

        /**
         * Update shipping info display (ETA, spend-more, tier label, split shipment)
         */
        updateShippingInfo() {
            if (typeof Shipping === 'undefined') return;

            const region = document.getElementById('region')?.value || '';
            const result = this._shippingResult || Shipping.calculate(this.cartItems, this.totals.subtotal, region);

            // Update shipping label with zone and tier
            const labelEl = document.getElementById('checkout-shipping-label');
            if (labelEl) {
                const zoneLabel = result.zoneLabel || '';
                if (result.tier === 'free') {
                    labelEl.textContent = 'Shipping';
                } else if (result.tier === 'heavy' && zoneLabel) {
                    labelEl.textContent = `Heavy \u2013 ${zoneLabel} (est.)`;
                } else if (zoneLabel) {
                    labelEl.textContent = `${zoneLabel} Shipping (est.)`;
                } else {
                    labelEl.textContent = 'Shipping (est.)';
                }
            }

            // Spend-more message
            const spendMoreEl = document.getElementById('checkout-spend-more');
            const spendMoreText = document.getElementById('checkout-spend-more-text');
            if (spendMoreEl && spendMoreText) {
                const spendMore = Shipping.getSpendMore(this.totals.subtotal);
                if (!spendMore.qualifies) {
                    const priceStr = typeof formatPrice === 'function' ? formatPrice(spendMore.needed) : `$${spendMore.needed.toFixed(2)}`;
                    spendMoreText.textContent = `Add ${priceStr} more for FREE shipping`;
                    spendMoreEl.hidden = false;
                } else {
                    spendMoreEl.hidden = true;
                }
            }

            // ETA based on selected region (reuses `region` from line above)
            const etaEl = document.getElementById('checkout-eta');
            const etaText = document.getElementById('checkout-eta-text');
            if (etaEl && etaText) {
                const eta = Shipping.getETA(region);
                if (eta) {
                    etaText.textContent = `Estimated delivery: ${eta}`;
                    etaEl.hidden = false;
                } else {
                    etaEl.hidden = true;
                }
            }

            // Split shipment flag
            const splitEl = document.getElementById('checkout-split-shipment');
            if (splitEl) {
                splitEl.hidden = !Shipping.maySplitShipment(this.cartItems);
            }

            // Track analytics event (once per region change)
            if (typeof Analytics !== 'undefined' && region) {
                Analytics.track('shipping_calculated', {
                    tier: result.tier,
                    fee: result.fee,
                    zone: result.zone,
                    region: region,
                    freeShipping: result.freeShipping,
                    splitShipment: Shipping.maySplitShipment(this.cartItems)
                });
            }
        },

        // Update totals display
        updateTotalsDisplay() {
            const subtotalEl = document.getElementById('checkout-subtotal');
            const shippingEl = document.getElementById('checkout-shipping');
            const discountRow = document.getElementById('checkout-discount-row');
            const discountEl = document.getElementById('checkout-discount');
            const totalEl = document.getElementById('checkout-total');

            if (subtotalEl) subtotalEl.textContent = `$${this.totals.subtotal.toFixed(2)}`;
            if (shippingEl) {
                shippingEl.textContent = this.totals.shipping === 0 ? 'FREE' : `$${this.totals.shipping.toFixed(2)}`;
                shippingEl.classList.toggle('text-success', this.totals.shipping === 0);
            }

            // Show discount if applied
            if (discountRow && discountEl) {
                if (this.totals.discount > 0) {
                    discountRow.hidden = false;
                    discountEl.textContent = `-$${this.totals.discount.toFixed(2)}`;
                } else {
                    discountRow.hidden = true;
                }
            }

            if (totalEl) totalEl.textContent = `$${this.totals.total.toFixed(2)} NZD`;
        },

        // Render cart items
        renderCart() {
            const itemsContainer = document.getElementById('checkout-items');
            if (!itemsContainer) return;

            itemsContainer.innerHTML = this.cartItems.map(item => `
                <li class="checkout-summary__item">
                    <div class="checkout-summary__item-image">
                        ${this.getItemImageHTML(item)}
                        <span class="checkout-summary__item-qty">${item.quantity}</span>
                    </div>
                    <div class="checkout-summary__item-details">
                        <h3 class="checkout-summary__item-title">${item.name}</h3>
                        <p class="checkout-summary__item-variant">${item.brand || item.sku || ''}</p>
                    </div>
                    <span class="checkout-summary__item-price">$${(item.price * item.quantity).toFixed(2)}</span>
                </li>
            `).join('');

            // Bind image fallback handlers
            itemsContainer.querySelectorAll('img[data-fallback]').forEach(img => {
                img.addEventListener('error', function() {
                    if (this.dataset.fallback === 'color-block') {
                        this.style.display = 'none';
                        const sibling = this.nextElementSibling;
                        if (sibling) sibling.style.display = 'flex';
                    } else if (this.dataset.fallback === 'placeholder') {
                        this.removeAttribute('data-fallback');
                        this.src = '/assets/images/placeholder-product.svg';
                    }
                }, { once: true });
            });

            this.updateTotalsDisplay();
        },

        // Setup shipping option handlers
        setupShippingHandlers() {
            const shippingInputs = document.querySelectorAll('input[name="shipping"]');
            shippingInputs.forEach(input => {
                input.addEventListener('change', () => {
                    // Update visual state
                    document.querySelectorAll('.shipping-option').forEach(opt => {
                        opt.classList.remove('shipping-option--selected');
                    });
                    input.closest('.shipping-option')?.classList.add('shipping-option--selected');

                    // Recalculate shipping
                    this.updateShippingCost();
                });
            });

            // Region change recalculates shipping fee and updates ETA
            const regionSelect = document.getElementById('region');
            if (regionSelect) {
                regionSelect.addEventListener('change', () => {
                    this.updateShippingCost();
                });
            }
        },

        // Setup billing address same as shipping toggle
        setupBillingAddressToggle() {
            const sameAsShippingCheckbox = document.getElementById('same-as-shipping');
            const billingFields = document.getElementById('billing-address-fields');

            if (!sameAsShippingCheckbox || !billingFields) return;

            const toggleBillingFields = () => {
                const isSameAsShipping = sameAsShippingCheckbox.checked;
                billingFields.style.display = isSameAsShipping ? 'none' : 'block';

                // Toggle required on billing fields
                const requiredFields = billingFields.querySelectorAll('input:not([name="billingAddress2"]), select');
                requiredFields.forEach(field => {
                    field.required = !isSameAsShipping;
                });
            };

            sameAsShippingCheckbox.addEventListener('change', toggleBillingFields);
            // Initial state
            toggleBillingFields();
        },

        // Validate billing address fields when not same as shipping
        validateBillingAddress() {
            const fields = [
                { id: 'billing-first-name', name: 'First Name' },
                { id: 'billing-last-name', name: 'Last Name' },
                { id: 'billing-address1', name: 'Address' },
                { id: 'billing-city', name: 'City' },
                { id: 'billing-region', name: 'Region' },
                { id: 'billing-postcode', name: 'Postcode' }
            ];

            for (const field of fields) {
                const el = document.getElementById(field.id);
                if (!el || !el.value.trim()) {
                    return {
                        valid: false,
                        message: `Please enter your billing ${field.name.toLowerCase()}.`,
                        focusField: field.id
                    };
                }
            }

            // Validate postcode format
            const postcode = document.getElementById('billing-postcode')?.value;
            if (postcode && !/^[0-9]{4}$/.test(postcode)) {
                return {
                    valid: false,
                    message: 'Please enter a valid 4-digit postcode.',
                    focusField: 'billing-postcode'
                };
            }

            return { valid: true };
        },

        // Restore checkout state from session storage
        restoreCheckoutState() {
            try {
                // Check both storage keys - checkoutData (from payment page flow) and checkout_state (older format)
                let saved = sessionStorage.getItem('checkoutData');
                let storageKey = 'checkoutData';

                if (!saved) {
                    saved = sessionStorage.getItem('checkout_state');
                    storageKey = 'checkout_state';
                }

                if (!saved) return;

                const state = JSON.parse(saved);
                // Only restore if saved within last 30 minutes
                if (Date.now() - state.savedAt > 30 * 60 * 1000) {
                    sessionStorage.removeItem(storageKey);
                    return;
                }

                // Restore form fields
                const fields = [
                    'email', 'phone', 'firstName', 'lastName', 'company',
                    'address1', 'address2', 'city', 'region', 'postcode',
                    'billingFirstName', 'billingLastName', 'billingAddress1',
                    'billingAddress2', 'billingCity', 'billingRegion', 'billingPostcode',
                    'orderNotes'
                ];

                fields.forEach(field => {
                    const el = document.querySelector(`[name="${field}"]`);
                    if (el && state[field]) {
                        el.value = state[field];
                    }
                });

                // Restore billing same as shipping
                const sameAsShipping = document.getElementById('same-as-shipping');
                if (sameAsShipping && state.sameAsShipping !== undefined) {
                    sameAsShipping.checked = state.sameAsShipping;
                    // Trigger toggle
                    const billingFields = document.getElementById('billing-address-fields');
                    if (billingFields) {
                        billingFields.style.display = state.sameAsShipping ? 'none' : 'block';
                    }
                }

                // Restore save address checkbox
                const saveAddressCheckbox = document.getElementById('save-address');
                if (saveAddressCheckbox && state.saveAddress) {
                    saveAddressCheckbox.checked = true;
                }

                // Restore terms checkbox if it was checked
                const termsCheckbox = document.getElementById('terms');
                if (termsCheckbox && state.termsAccepted) {
                    termsCheckbox.checked = true;
                }

                DebugLog.log('Restored checkout state from session');
            } catch (e) {
                DebugLog.warn('Failed to restore checkout state:', e);
            }
        },

        // Setup form submission handler
        setupFormHandlers() {
            const form = document.getElementById('checkout-form');
            if (!form) return;

            const continueBtn = document.getElementById('continue-to-payment-btn');

            // "Continue to Payment" - validates form and redirects to payment page
            if (continueBtn) {
                continueBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    await this.handleContinueToPayment(form);
                });
            }

            // Coupon code handler
            this.setupCouponHandler();
        },

        // Setup coupon code handler
        setupCouponHandler() {
            const couponInput = document.querySelector('.coupon-form__input');
            const couponBtn = document.querySelector('.coupon-form__btn');

            if (!couponInput || !couponBtn) return;

            couponBtn.addEventListener('click', async () => {
                const code = couponInput.value.trim();
                if (!code) {
                    alert('Please enter a coupon code');
                    return;
                }

                couponBtn.disabled = true;
                couponBtn.textContent = 'Applying...';

                try {
                    const response = await API.applyCoupon(code);

                    if (response.success && response.data) {
                        this.appliedCoupon = response.data.code;
                        this.totals.discount = response.data.discount_amount || 0;

                        // Update display
                        const discountRow = document.getElementById('checkout-discount-row');
                        const discountEl = document.getElementById('checkout-discount');
                        if (discountRow && discountEl) {
                            discountRow.hidden = false;
                            discountEl.textContent = `-$${this.totals.discount.toFixed(2)}`;
                        }

                        // Recalculate total
                        this.totals.total = this.totals.subtotal - this.totals.discount + this.totals.shipping;
                        document.getElementById('checkout-total').textContent = `$${this.totals.total.toFixed(2)} NZD`;

                        // Show success
                        couponInput.value = '';
                        couponInput.placeholder = `${code} applied!`;
                        couponBtn.textContent = 'Applied';
                        couponBtn.style.background = '#10b981';

                        alert(response.message || `Coupon applied! You saved $${this.totals.discount.toFixed(2)}`);
                    } else {
                        throw new Error(response.error || 'Invalid coupon code');
                    }
                } catch (error) {
                    DebugLog.error('Coupon error:', error);
                    alert(error.message || 'Invalid coupon code');
                    couponBtn.textContent = 'Apply';
                    couponBtn.disabled = false;
                }
            });

            // Allow enter key to apply coupon
            couponInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    couponBtn.click();
                }
            });
        },

        // Handle "Continue to Payment" - validates form, saves data, redirects to payment page
        async handleContinueToPayment(form) {
            if (this.isSubmitting) return;

            const continueBtn = document.getElementById('continue-to-payment-btn');
            const originalBtnText = continueBtn.innerHTML;

            // Validate form
            if (!form.checkValidity()) {
                form.reportValidity();
                return;
            }

            // Validate billing address if not same as shipping
            const sameAsShipping = document.getElementById('same-as-shipping')?.checked;
            if (!sameAsShipping) {
                const billingValidation = this.validateBillingAddress();
                if (!billingValidation.valid) {
                    alert(billingValidation.message);
                    document.getElementById(billingValidation.focusField)?.focus();
                    return;
                }
            }

            // Check terms acceptance
            const termsCheckbox = document.getElementById('terms');
            if (!termsCheckbox.checked) {
                alert('Please accept the Terms & Conditions to continue.');
                termsCheckbox.focus();
                return;
            }

            this.isSubmitting = true;
            continueBtn.disabled = true;
            continueBtn.innerHTML = `
                <svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" stroke-opacity="0.25"/>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"/>
                </svg>
                Saving Details...
            `;

            try {
                // Collect all form data
                const formData = new FormData(form);

                // Combine country code and phone number
                const phoneCountry = formData.get('phone-country') || '+64';
                const phoneNumber = formData.get('phone') || '';
                const fullPhone = phoneNumber ? `${phoneCountry} ${phoneNumber}` : '';

                // Build checkout data object to pass to payment page
                const checkoutData = {
                    // Contact
                    email: formData.get('email'),
                    phone: fullPhone,
                    // Shipping address
                    firstName: formData.get('firstName'),
                    lastName: formData.get('lastName'),
                    company: formData.get('company'),
                    address1: formData.get('address1'),
                    address2: formData.get('address2'),
                    city: formData.get('city'),
                    region: formData.get('region'),
                    postcode: formData.get('postcode'),
                    // Billing
                    sameAsShipping: sameAsShipping,
                    billingFirstName: formData.get('billingFirstName'),
                    billingLastName: formData.get('billingLastName'),
                    billingAddress1: formData.get('billingAddress1'),
                    billingAddress2: formData.get('billingAddress2'),
                    billingCity: formData.get('billingCity'),
                    billingRegion: formData.get('billingRegion'),
                    billingPostcode: formData.get('billingPostcode'),
                    // Notes
                    orderNotes: formData.get('orderNotes'),
                    // Save address preference
                    saveAddress: formData.get('saveAddress') === 'on',
                    // Shipping tier and zone (for backend)
                    shippingTier: this._shippingResult?.tier || 'standard',
                    shippingZone: this._shippingResult?.zone || '',
                    estimatedShipping: this.totals.shipping,
                    // Terms accepted
                    termsAccepted: document.getElementById('terms')?.checked || false,
                    // Timestamp
                    savedAt: Date.now()
                };

                // Save to sessionStorage
                sessionStorage.setItem('checkoutData', JSON.stringify(checkoutData));
                DebugLog.log('Checkout data saved, redirecting to payment page');

                // Redirect to payment page
                window.location.href = '/html/payment.html';

            } catch (error) {
                DebugLog.error('Error saving checkout data:', error);
                alert('An error occurred. Please try again.');

                continueBtn.disabled = false;
                continueBtn.innerHTML = originalBtnText;
                this.isSubmitting = false;
            }
        },

        // Check auth and prefill form
        async checkAuthAndPrefill() {
            await new Promise(resolve => setTimeout(resolve, 100));

            const loginPrompt = document.getElementById('login-prompt');
            const welcomeMessage = document.getElementById('welcome-message');
            const userDisplayName = document.getElementById('user-display-name');

            if (typeof Auth !== 'undefined' && Auth.isAuthenticated()) {
                const user = Auth.getUser();

                if (loginPrompt) loginPrompt.style.display = 'none';
                if (welcomeMessage) welcomeMessage.style.display = 'flex';

                // Show "Save address for next time" checkbox for authenticated users
                const saveAddressRow = document.getElementById('save-address-row');
                if (saveAddressRow) {
                    saveAddressRow.style.display = 'block';
                }

                const displayName = user?.user_metadata?.full_name ||
                                   user?.email?.split('@')[0] ||
                                   'Customer';
                if (userDisplayName) userDisplayName.textContent = displayName;

                // Pre-fill email
                const emailInput = document.getElementById('email');
                if (emailInput && user?.email) {
                    emailInput.value = user.email;
                }

                // Pre-fill name if available
                const fullName = user?.user_metadata?.full_name;
                if (fullName) {
                    const nameParts = fullName.split(' ');
                    const firstNameInput = document.getElementById('first-name');
                    const lastNameInput = document.getElementById('last-name');

                    if (firstNameInput && nameParts[0]) {
                        firstNameInput.value = nameParts[0];
                    }
                    if (lastNameInput && nameParts.length > 1) {
                        lastNameInput.value = nameParts.slice(1).join(' ');
                    }
                }

                // Pre-fill phone if available (handles "+64 21 123 4567" format)
                const phone = user?.user_metadata?.phone;
                if (phone) {
                    const phoneInput = document.getElementById('phone');
                    const phoneCountrySelect = document.getElementById('phone-country');

                    // Try to parse country code from phone
                    const phoneMatch = phone.match(/^(\+\d{1,3})\s*(.*)$/);
                    if (phoneMatch && phoneCountrySelect && phoneInput) {
                        const countryCode = phoneMatch[1];
                        const phoneNumber = phoneMatch[2];
                        // Set country code if it exists in the dropdown
                        const option = phoneCountrySelect.querySelector(`option[value="${countryCode}"]`);
                        if (option) {
                            phoneCountrySelect.value = countryCode;
                        }
                        phoneInput.value = phoneNumber;
                    } else if (phoneInput) {
                        // Fallback: put whole number in phone field
                        phoneInput.value = phone;
                    }
                }

                // Try to load saved addresses
                this.loadSavedAddresses();
            }
        },

        // Load saved addresses for authenticated users
        async loadSavedAddresses() {
            try {
                const response = await API.getAddresses();
                if (response.success && response.data) {
                    const addresses = Array.isArray(response.data) ? response.data : (response.data.addresses || []);
                    const defaultAddress = addresses.find(a => a.is_default) || addresses[0];

                    if (defaultAddress) {
                        // Pre-fill shipping address from saved address
                        const fields = {
                            'first-name': defaultAddress.first_name || defaultAddress.recipient_name?.split(' ')[0],
                            'last-name': defaultAddress.last_name || defaultAddress.recipient_name?.split(' ').slice(1).join(' '),
                            'company': defaultAddress.company,
                            'address1': defaultAddress.address_line1,
                            'address2': defaultAddress.address_line2,
                            'city': defaultAddress.city,
                            'region': defaultAddress.region?.toLowerCase().replace(/\s+/g, '-'),
                            'postcode': defaultAddress.postal_code
                        };

                        Object.entries(fields).forEach(([id, value]) => {
                            if (value) {
                                const input = document.getElementById(id);
                                if (input && !input.value) {
                                    input.value = value;
                                }
                            }
                        });
                    }
                }
            } catch (error) {
                DebugLog.log('Could not load saved addresses:', error.message);
            }
        }
    };

    // Initialize checkout page
    document.addEventListener('DOMContentLoaded', () => {
        CheckoutPage.init();
    });
