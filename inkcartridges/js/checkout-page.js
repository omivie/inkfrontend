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

            // Setup accordion for checkout sections
            this.setupAccordion();

            // Check email verification status
            await this.checkEmailVerification();

            // Track checkout started for analytics
            if (typeof CartAnalytics !== 'undefined') {
                CartAnalytics.trackCheckoutStarted();
            }
        },

        // Check email verification status (fail closed)
        async checkEmailVerification() {
            if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
                // Not logged in — guest checkout is fine
                this.isEmailVerified = true;
                return;
            }

            // OAuth users (e.g. Google) have inherently verified emails
            const provider = Auth.user?.app_metadata?.provider;
            if (provider && provider !== 'email') {
                this.isEmailVerified = true;
                return;
            }

            // Fast path: check Supabase session field
            if (Auth.user?.email_confirmed_at) {
                this.isEmailVerified = true;
                return;
            }

            // Fallback: check via backend API
            try {
                const response = await API.getVerificationStatus();
                if (response.ok && response.data) {
                    this.isEmailVerified = response.data.email_verified;
                } else {
                    // Fail closed — treat as unverified
                    this.isEmailVerified = false;
                }
            } catch (error) {
                // Fail closed — treat errors as unverified
                this.isEmailVerified = false;
            }

            if (!this.isEmailVerified) {
                this.showVerificationRequired();
            } else {
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
            // Check delivery type is selected
            if (!document.querySelector('input[name="delivery_type"]:checked')) {
                return false;
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
            // Fetch shipping from backend API with full item weights
            await this.fetchShippingFromAPI();

            this.totals.total = this.totals.subtotal - this.totals.discount + this.totals.shipping;
            this.updateTotalsDisplay();
            this.updateShippingInfo();
        },

        /**
         * Check if cart contains ONLY test products (SKU starts with TEST- or name contains "admin test")
         */
        _isTestProductCart() {
            return this.cartItems.length > 0 && this.cartItems.every(item =>
                (item.sku || '').toUpperCase().startsWith('TEST-') ||
                (item.name || '').toLowerCase().includes('admin test')
            );
        },

        async fetchShippingFromAPI() {
            const region = document.getElementById('region')?.value || '';
            const postalCode = document.getElementById('postcode')?.value || '';
            const deliveryType = document.querySelector('input[name="delivery_type"]:checked')?.value || 'urban';

            // Test products get free shipping automatically
            if (this._isTestProductCart()) {
                this.totals.shipping = 0;
                this._shippingResult = { fee: 0, tier: 'test-free', zone: '', zoneLabel: '', freeShipping: true, deliveryType: deliveryType, reason: 'Test product — free shipping' };
                return;
            }

            // Try backend API for accurate weight-based rates (skip if no region selected)
            if (region && typeof API !== 'undefined' && this.cartItems.length > 0) {
                try {
                    const payload = {
                        cart_total: this.totals.subtotal,
                        items: this.cartItems.map(item => ({
                            product_id: item.id,
                            quantity: item.quantity
                        })),
                        region: region,
                        postal_code: postalCode,
                        delivery_type: deliveryType
                    };
                    const response = await API.getShippingOptions(payload);
                    if (response.ok && response.data) {
                        const option = response.data.selected || response.data.options?.[0];
                        if (option && option.fee != null) {
                            this.totals.shipping = option.fee;
                            this._shippingResult = {
                                fee: option.fee,
                                tier: option.tier || 'standard',
                                zone: option.zone || '',
                                zoneLabel: option.zone_label || '',
                                freeShipping: option.fee === 0,
                                deliveryType: deliveryType,
                                reason: option.reason || ''
                            };
                            return;
                        }
                    }
                } catch (e) {
                    DebugLog.warn('Shipping API failed, using client-side fallback:', e.message);
                }
            }

            // Fallback: client-side estimate (uses light weight tier)
            if (typeof Shipping !== 'undefined') {
                const result = Shipping.calculate(this.cartItems, this.totals.subtotal, region, deliveryType);
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
                        <span class="source-badge source-badge--${(item.name || '').toLowerCase().startsWith('compatible ') ? 'compatible' : 'genuine'}">${(item.name || '').toLowerCase().startsWith('compatible ') ? 'COMPATIBLE' : 'GENUINE'}</span>
                        <h3 class="checkout-summary__item-title">${Security.escapeHtml(item.name || '')}</h3>
                        <p class="checkout-summary__item-variant">${Security.escapeHtml(item.brand || item.sku || '')}</p>
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

            // Delivery type (urban/rural) change recalculates shipping
            document.querySelectorAll('input[name="delivery_type"]').forEach(input => {
                input.addEventListener('change', () => {
                    this.updateShippingCost();
                });
            });
        },

        // Setup billing address toggle (different billing checkbox)
        setupBillingAddressToggle() {
            const differentBillingCheckbox = document.getElementById('different-billing');
            const billingFields = document.getElementById('billing-address-fields');

            if (!differentBillingCheckbox || !billingFields) return;

            const toggleBillingFields = () => {
                const showBilling = differentBillingCheckbox.checked;
                billingFields.style.display = showBilling ? 'block' : 'none';

                // Toggle required on billing fields
                const requiredFields = billingFields.querySelectorAll('input:not([name="billingAddress2"]), select');
                requiredFields.forEach(field => {
                    field.required = showBilling;
                });
            };

            differentBillingCheckbox.addEventListener('change', toggleBillingFields);
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

                // Restore billing toggle (invert sameAsShipping → differentBilling)
                const differentBillingCb = document.getElementById('different-billing');
                if (differentBillingCb && state.sameAsShipping !== undefined) {
                    differentBillingCb.checked = !state.sameAsShipping;
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

            // Clear validation errors on input/change
            form.addEventListener('input', (e) => {
                const field = e.target;
                if (field.classList.contains('is-error')) {
                    field.classList.remove('is-error');
                    const errorMsg = field.closest('.form-group')?.querySelector('.form-error');
                    if (errorMsg) errorMsg.remove();
                }
            });
            form.addEventListener('change', (e) => {
                const field = e.target;
                if (field.type === 'radio') {
                    const container = field.closest('.delivery-type-options');
                    if (container) {
                        container.classList.remove('is-error');
                        const errorMsg = container.parentElement.querySelector('.form-error');
                        if (errorMsg) errorMsg.remove();
                    }
                }
                if (field.classList.contains('is-error')) {
                    field.classList.remove('is-error');
                    const errorMsg = field.closest('.form-group')?.querySelector('.form-error');
                    if (errorMsg) errorMsg.remove();
                }
            });

            // Coupon code handler
            this.setupCouponHandler();
        },

        // Accordion: 2 steps (Contact, Shipping). Sections only change on explicit clicks.
        setupAccordion() {
            const form = document.getElementById('checkout-form');
            if (!form) return;

            const sections = form.querySelectorAll('fieldset.checkout-section');
            if (sections.length === 0) return;

            this._accordionSections = [];

            sections.forEach((section, idx) => {
                const heading = section.querySelector('.checkout-section__heading');
                if (!heading) return;

                // Create edit button (hidden initially)
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'checkout-section__edit-btn';
                editBtn.textContent = 'Edit';
                editBtn.hidden = true;
                heading.appendChild(editBtn);

                // Create summary div (hidden initially)
                const summary = document.createElement('div');
                summary.className = 'checkout-section__summary';
                summary.hidden = true;
                heading.after(summary);

                // Wrap body content in a collapsible div
                const body = document.createElement('div');
                body.className = 'checkout-section__body';
                const children = Array.from(section.children).filter(
                    el => el !== heading && el !== summary
                );
                children.forEach(child => body.appendChild(child));
                section.appendChild(body);

                // Continue button at bottom of body
                const continueBtn = document.createElement('button');
                continueBtn.type = 'button';
                continueBtn.className = 'btn btn--primary checkout-section__continue-btn';
                continueBtn.textContent = 'Continue';
                body.appendChild(continueBtn);

                const data = { section, heading, summary, editBtn, body, continueBtn, collapsed: false, index: idx };
                this._accordionSections.push(data);

                // Continue button handler
                continueBtn.addEventListener('click', () => {
                    if (this._validateAccordionSection(data)) {
                        this._collapseAccordionSection(data);
                        const nextIdx = this._accordionSections.indexOf(data) + 1;
                        const next = this._accordionSections[nextIdx];
                        if (next) {
                            this._expandAccordionSection(next);
                        } else {
                            // Last section — scroll to Continue to Payment
                            const payBtn = document.getElementById('continue-to-payment-btn');
                            if (payBtn) payBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }
                });

                // Heading click to expand collapsed section
                heading.addEventListener('click', () => {
                    if (data.collapsed) this._expandAccordionSection(data);
                });

                // Edit button click
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (data.collapsed) this._expandAccordionSection(data);
                });
            });

            // Initial state: first section open, rest collapsed
            this._accordionSections.forEach((data, idx) => {
                if (idx > 0) {
                    data.body.hidden = true;
                    data.continueBtn.hidden = true;
                    data.collapsed = true;
                    data.section.classList.add('is-collapsed');
                }
            });
        },

        // Validate required fields in a section, show errors if invalid
        _validateAccordionSection(data) {
            const { body } = data;

            // Clear previous errors
            body.querySelectorAll('.is-error').forEach(el => el.classList.remove('is-error'));
            body.querySelectorAll('.form-error').forEach(el => el.remove());

            let firstInvalid = null;
            const checkedRadioGroups = new Set();

            for (const field of body.querySelectorAll('input[required], select[required], textarea[required]')) {
                if (field.offsetParent === null) continue;

                // Radio buttons — validate once per group
                if (field.type === 'radio') {
                    if (checkedRadioGroups.has(field.name)) continue;
                    checkedRadioGroups.add(field.name);
                    const groupChecked = body.querySelector(`input[name="${field.name}"]:checked`);
                    if (!groupChecked) {
                        const container = field.closest('.delivery-type-options') || field.closest('.form-group');
                        if (container) {
                            container.classList.add('is-error');
                            if (!container.parentElement.querySelector('.form-error')) {
                                const errorMsg = document.createElement('div');
                                errorMsg.className = 'form-error';
                                errorMsg.textContent = 'Please select an option';
                                container.parentElement.appendChild(errorMsg);
                            }
                        }
                        if (!firstInvalid) firstInvalid = container || field;
                    }
                    continue;
                }

                // Text / select / textarea
                if (!field.value.trim()) {
                    field.classList.add('is-error');
                    const group = field.closest('.form-group');
                    if (group && !group.querySelector('.form-error')) {
                        const errorMsg = document.createElement('div');
                        errorMsg.className = 'form-error';
                        errorMsg.textContent = 'This field is required';
                        group.appendChild(errorMsg);
                    }
                    if (!firstInvalid) firstInvalid = field;
                }
            }

            if (firstInvalid) {
                firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (firstInvalid.focus) firstInvalid.focus({ preventScroll: true });
                return false;
            }
            return true;
        },

        // Get summary text for a collapsed section
        _getAccordionSummary(data) {
            const { section } = data;
            const esc = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;

            // Contact Information
            const email = section.querySelector('#email');
            if (email) {
                const phone = section.querySelector('#phone');
                const parts = [];
                if (email.value) parts.push(esc(email.value));
                if (phone && phone.value) parts.push(esc(phone.value));
                return parts.join(' · ');
            }

            // Shipping Address
            const firstName = section.querySelector('#first-name');
            if (firstName) {
                const lastName = section.querySelector('#last-name')?.value || '';
                const addr = section.querySelector('#address1')?.value || '';
                const city = section.querySelector('#city')?.value || '';
                const region = section.querySelector('#region');
                const regionText = region ? region.options[region.selectedIndex]?.text || '' : '';
                const postcode = section.querySelector('#postcode')?.value || '';
                const deliveryType = section.querySelector('input[name="delivery_type"]:checked');
                const deliveryLabel = deliveryType ? (deliveryType.value === 'rural' ? 'Rural' : 'Urban') : '';
                const addressLine = `${firstName.value} ${lastName}, ${addr}, ${city} ${regionText} ${postcode}`.replace(/\s+/g, ' ').trim();
                return esc(deliveryLabel ? `${addressLine} · ${deliveryLabel}` : addressLine);
            }

            return '';
        },

        _collapseAccordionSection(data) {
            if (data.collapsed) return;
            data.collapsed = true;
            data.section.classList.add('is-collapsed');
            data.body.hidden = true;
            data.continueBtn.hidden = true;
            data.summary.hidden = false;
            data.summary.textContent = this._getAccordionSummary(data);
            data.editBtn.hidden = false;
            data.heading.style.cursor = 'pointer';
        },

        _expandAccordionSection(data) {
            // Collapse all other sections first
            this._accordionSections.forEach(other => {
                if (other !== data && !other.collapsed) {
                    this._collapseAccordionSection(other);
                }
            });

            data.collapsed = false;
            data.section.classList.remove('is-collapsed');
            data.body.hidden = false;
            data.continueBtn.hidden = false;
            data.summary.hidden = true;
            data.editBtn.hidden = true;
            data.heading.style.cursor = '';

            // Focus first input (never touch billing checkbox state)
            const firstInput = data.body.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea');
            if (firstInput) firstInput.focus({ preventScroll: true });
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

                    if (response.ok && response.data) {
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
                    } else if (response.code === 'EMAIL_NOT_VERIFIED') {
                        alert('Please verify your email address before applying coupons. Check your inbox for a verification link.');
                        couponBtn.textContent = 'Apply';
                        couponBtn.disabled = false;
                        return;
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

        // Clear all validation errors from the form
        clearValidationErrors(form) {
            form.querySelectorAll('.is-error').forEach(el => el.classList.remove('is-error'));
            form.querySelectorAll('.form-error').forEach(el => el.remove());
            form.querySelectorAll('.delivery-type-options.is-error').forEach(el => el.classList.remove('is-error'));
        },

        // Validate all required fields, show red error styling, scroll to first error
        validateFormFields(form) {
            this.clearValidationErrors(form);

            let firstInvalid = null;

            // Validate all required inputs/selects
            const requiredFields = form.querySelectorAll('input[required], select[required], textarea[required]');
            const checkedRadioGroups = new Set();

            requiredFields.forEach(field => {
                // For radio buttons, validate once per group
                if (field.type === 'radio') {
                    if (checkedRadioGroups.has(field.name)) return;
                    checkedRadioGroups.add(field.name);

                    const groupChecked = form.querySelector(`input[name="${field.name}"]:checked`);
                    if (!groupChecked) {
                        const container = field.closest('.delivery-type-options') || field.closest('.form-group');
                        if (container) {
                            container.classList.add('is-error');
                            if (!container.querySelector('.form-error')) {
                                const errorMsg = document.createElement('div');
                                errorMsg.className = 'form-error';
                                errorMsg.textContent = 'Please select an option';
                                container.parentElement.appendChild(errorMsg);
                            }
                        }
                        if (!firstInvalid) firstInvalid = container || field;
                    }
                    return;
                }

                if (!field.value.trim() || !field.checkValidity()) {
                    field.classList.add('is-error');
                    const group = field.closest('.form-group');
                    if (group && !group.querySelector('.form-error')) {
                        const errorMsg = document.createElement('div');
                        errorMsg.className = 'form-error';
                        errorMsg.textContent = field.validationMessage || 'This field is required';
                        group.appendChild(errorMsg);
                    }
                    if (!firstInvalid) firstInvalid = field;
                }
            });

            if (firstInvalid) {
                firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                if (firstInvalid.focus) firstInvalid.focus({ preventScroll: true });
                return false;
            }

            return true;
        },

        // Handle "Continue to Payment" - validates form, saves data, redirects to payment page
        async handleContinueToPayment(form) {
            if (this.isSubmitting) return;

            // Block unverified authenticated users from proceeding to payment
            if (!this.isEmailVerified && typeof Auth !== 'undefined' && Auth.isAuthenticated()) {
                this.showVerificationRequired();
                return;
            }

            const continueBtn = document.getElementById('continue-to-payment-btn');
            const originalBtnText = continueBtn.innerHTML;

            // Validate form with custom error display
            if (!this.validateFormFields(form)) {
                return;
            }

            // Validate billing address if different billing is checked
            const differentBilling = document.getElementById('different-billing')?.checked;
            if (differentBilling) {
                const billingValidation = this.validateBillingAddress();
                if (!billingValidation.valid) {
                    const field = document.getElementById(billingValidation.focusField);
                    if (field) {
                        field.classList.add('is-error');
                        const group = field.closest('.form-group');
                        if (group && !group.querySelector('.form-error')) {
                            const errorMsg = document.createElement('div');
                            errorMsg.className = 'form-error';
                            errorMsg.textContent = billingValidation.message;
                            group.appendChild(errorMsg);
                        }
                        field.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        field.focus({ preventScroll: true });
                    }
                    return;
                }
            }

            // Check terms acceptance
            const termsCheckbox = document.getElementById('terms');
            if (!termsCheckbox.checked) {
                const group = termsCheckbox.closest('.form-group') || termsCheckbox.parentElement;
                if (group && !group.querySelector('.form-error')) {
                    const errorMsg = document.createElement('div');
                    errorMsg.className = 'form-error';
                    errorMsg.textContent = 'Please accept the Terms & Conditions to continue.';
                    group.appendChild(errorMsg);
                }
                termsCheckbox.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
                    sameAsShipping: !differentBilling,
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
                    deliveryType: document.querySelector('input[name="delivery_type"]:checked')?.value || 'urban',
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

                // Pre-fill phone if available (handles E.164 "+6402040437370" and spaced "+64 021234567" formats)
                const phone = user?.user_metadata?.phone;
                if (phone) {
                    const phoneInput = document.getElementById('phone');
                    const phoneCountrySelect = document.getElementById('phone-country');

                    if (phoneCountrySelect && phoneInput) {
                        // Check each dropdown country code option (longest first to match correctly)
                        const countryCodes = Array.from(phoneCountrySelect.options)
                            .map(o => o.value)
                            .filter(v => v.startsWith('+'))
                            .sort((a, b) => b.length - a.length);

                        let matched = false;
                        for (const code of countryCodes) {
                            if (phone.startsWith(code)) {
                                phoneCountrySelect.value = code;
                                const remainder = phone.slice(code.length).replace(/^\s+/, '');
                                // Convert to local format with leading 0
                                phoneInput.value = '0' + remainder;
                                matched = true;
                                break;
                            }
                        }
                        if (!matched) {
                            phoneInput.value = phone;
                        }
                    } else if (phoneInput) {
                        phoneInput.value = phone;
                    }
                }

                // Load profile from backend to fill any remaining gaps
                try {
                    const profileRes = await API.getProfile();
                    if (profileRes.ok && profileRes.data) {
                        const profile = profileRes.data;

                        const emailInput = document.getElementById('email');
                        if (emailInput && !emailInput.value && profile.email) {
                            emailInput.value = profile.email;
                        }

                        const firstNameInput = document.getElementById('first-name');
                        const lastNameInput = document.getElementById('last-name');
                        if (firstNameInput && !firstNameInput.value && profile.first_name) {
                            firstNameInput.value = profile.first_name;
                        }
                        if (lastNameInput && !lastNameInput.value && profile.last_name) {
                            lastNameInput.value = profile.last_name;
                        }

                        // Fill phone from profile if not already filled from Supabase metadata
                        const phoneInput = document.getElementById('phone');
                        if (phoneInput && !phoneInput.value && profile.phone) {
                            const phoneCountrySelect = document.getElementById('phone-country');
                            if (phoneCountrySelect) {
                                const countryCodes = Array.from(phoneCountrySelect.options)
                                    .map(o => o.value)
                                    .filter(v => v.startsWith('+'))
                                    .sort((a, b) => b.length - a.length);

                                let matched = false;
                                for (const code of countryCodes) {
                                    if (profile.phone.startsWith(code)) {
                                        phoneCountrySelect.value = code;
                                        const remainder = profile.phone.slice(code.length).replace(/^\s+/, '');
                                        phoneInput.value = '0' + remainder;
                                        matched = true;
                                        break;
                                    }
                                }
                                if (!matched) {
                                    phoneInput.value = profile.phone;
                                }
                            } else {
                                phoneInput.value = profile.phone;
                            }
                        }
                    }
                } catch (e) {
                    DebugLog.log('Could not load profile for prefill:', e.message);
                }

                // Try to load saved addresses
                this.loadSavedAddresses();
            }
        },

        // Load saved addresses for authenticated users
        async loadSavedAddresses() {
            try {
                const response = await API.getAddresses();
                if (response.ok && response.data) {
                    const addresses = Array.isArray(response.data) ? response.data : (response.data.addresses || []);
                    this.savedAddresses = addresses;
                    const defaultAddress = addresses.find(a => a.is_default) || addresses[0];

                    if (defaultAddress) {
                        this.fillAddressFields(defaultAddress);
                    }

                    // Render address picker if multiple addresses
                    if (addresses.length > 1) {
                        this.renderAddressPicker(addresses, defaultAddress);
                    }
                }
            } catch (error) {
                DebugLog.log('Could not load saved addresses:', error.message);
            }
        },

        // Fill shipping form fields from an address object
        fillAddressFields(address) {
            const fields = {
                'first-name': address.first_name || address.recipient_name?.split(' ')[0],
                'last-name': address.last_name || address.recipient_name?.split(' ').slice(1).join(' '),
                'company': address.company || '',
                'address1': address.address_line1 || '',
                'address2': address.address_line2 || '',
                'city': address.city || '',
                'region': address.region?.toLowerCase().replace(/\s+/g, '-') || '',
                'postcode': address.postal_code || ''
            };

            Object.entries(fields).forEach(([id, value]) => {
                const input = document.getElementById(id);
                if (input) {
                    input.value = value;
                }
            });

            // Do NOT auto-select delivery type — user must choose urban/rural manually

            this.updateShippingCost();
        },

        // Render address picker UI
        renderAddressPicker(addresses, selectedAddress) {
            const picker = document.getElementById('saved-addresses-picker');
            if (!picker) return;

            const selectedId = selectedAddress?.id || '';
            const cards = addresses.map(addr => {
                const id = addr.id;
                const isSelected = id === selectedId;
                const name = Security.escapeHtml(
                    addr.recipient_name ||
                    [addr.first_name, addr.last_name].filter(Boolean).join(' ') ||
                    ''
                );
                const line1 = Security.escapeHtml(addr.address_line1 || '');
                const city = Security.escapeHtml(addr.city || '');
                const region = Security.escapeHtml(addr.region || '');
                const postcode = Security.escapeHtml(addr.postal_code || '');
                const defaultBadge = addr.is_default ? ' <span class="address-card__badge">Default</span>' : '';

                return `<label class="address-card${isSelected ? ' address-card--selected' : ''}">
                    <input type="radio" name="saved_address" value="${Security.escapeAttr(id)}"${isSelected ? ' checked' : ''} class="address-card__radio">
                    <div class="address-card__content">
                        <div class="address-card__name">${name}${defaultBadge}</div>
                        <div class="address-card__detail">${line1}</div>
                        <div class="address-card__detail">${city}${region ? ', ' + region : ''} ${postcode}</div>
                    </div>
                </label>`;
            }).join('');

            picker.innerHTML = '<div class="address-picker__label">Saved addresses</div>' + cards;
            picker.style.display = '';

            // Bind radio change events
            picker.querySelectorAll('input[name="saved_address"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    this.selectSavedAddress(e.target.value);
                    // Update visual selection
                    picker.querySelectorAll('.address-card').forEach(c => c.classList.remove('address-card--selected'));
                    e.target.closest('.address-card').classList.add('address-card--selected');
                });
            });
        },

        // Select a saved address by ID and fill the form
        selectSavedAddress(addressId) {
            if (!this.savedAddresses) return;
            const address = this.savedAddresses.find(a => String(a.id) === String(addressId));
            if (address) {
                this.fillAddressFields(address);
            }
        }
    };

    // Initialize checkout page
    document.addEventListener('DOMContentLoaded', () => {
        CheckoutPage.init();
    });
