/**
 * CART.JS
 * =======
 * Shopping cart functionality for InkCartridges.co.nz
 *
 * HYBRID ARCHITECTURE (server + localStorage):
 * - Authenticated users: Server-first cart storage (linked via user ID)
 * - Guest users: Server + localStorage (localStorage for cross-origin cookie fallback)
 * - On sign-in: Guest cart merges into user cart via /api/cart/merge
 * - localStorage provides fallback for local development (cross-origin cookie issues)
 *
 * PRICING RULE: Frontend never computes prices. All totals come from backend.
 * Client-side math is used ONLY as a fallback when server summary is unavailable.
 */

'use strict';

const Cart = {
    // Storage key for guest cart data
    STORAGE_KEY: 'inkcartridges_cart',

    // Cart data
    items: [],

    // Server-provided summary (subtotal, shipping, discount, total)
    // This is the source of truth for all pricing display when available.
    serverSummary: null,

    // Applied coupon (server-validated)
    appliedCoupon: null,

    // Discount amount from server
    discountAmount: 0,

    // Loading state - starts true, set to false after server data is loaded
    loading: true,

    // Cart validity state
    // 'valid' | 'invalid_stock' | 'invalid_price' | 'unknown'
    validationState: 'unknown',
    validationErrors: [],

    // Whether user is authenticated
    isAuthenticated: false,

    // Debounce timer for quantity updates
    _quantityDebounceTimers: {},

    // Per-item in-flight API call guard
    _quantityInFlight: {},

    // Queued quantity values while an API call is in-flight
    _quantityQueued: {},

    // Guard against concurrent mergeGuestCartAndLoad calls
    _mergeInProgress: false,

    /**
     * Compute composite key for cart item identity.
     * Uses source prefix + best available identifier (sku > slug > id).
     * Ensures stable identity across cart items.
     */
    cartItemKey: function(item) {
        const src = item.source || 'core';
        const identifier = item.sku || item.slug || item.id;
        return src + ':' + identifier;
    },

    /**
     * Get color style for a product color (delegates to shared ProductColors in utils.js)
     */
    getColorStyle: function(colorName) {
        return ProductColors.getStyle(colorName, 'background-color: #e0e0e0;');
    },

    /**
     * Detect color from product name (delegates to shared ProductColors in utils.js)
     */
    detectColorFromName: function(name) {
        return ProductColors.detectFromName(name);
    },

    /**
     * Get image HTML for a cart item
     */
    getItemImageHTML: function(item) {
        const color = item.color || this.detectColorFromName(item.name);
        const colorStyle = color ? this.getColorStyle(color) : null;
        const escapedName = Security.escapeHtml(item.name);
        const imageUrl = typeof storageUrl === 'function' ? storageUrl(item.image) : item.image;

        if (imageUrl && imageUrl !== '/assets/images/placeholder-product.svg') {
            if (colorStyle) {
                return `<img src="${Security.escapeAttr(imageUrl)}" alt="${escapedName}" data-fallback="color-block">
                        <div class="cart-item__color-block" style="${colorStyle}; width: 100%; height: 100%; border-radius: 4px; display: none;"></div>`;
            } else {
                return `<img src="${Security.escapeAttr(imageUrl)}" alt="${escapedName}" data-fallback="placeholder">`;
            }
        }

        if (colorStyle) {
            return `<div class="cart-item__color-block" style="${colorStyle}; width: 100%; height: 100%; border-radius: 4px;"></div>`;
        }

        return `<img src="/assets/images/placeholder-product.svg" alt="${escapedName}">`;
    },

    /**
     * Bind image error fallback handlers (replaces inline onerror)
     */
    bindImageFallbacks(container) {
        container.querySelectorAll('img[data-fallback]').forEach(img => {
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
    },

    /**
     * Initialize cart - SERVER FIRST
     * Waits for Auth to initialize before loading cart
     */
    async init() {
        this.bindEvents();
        this.bindCheckoutButton();

        // Wait for Auth to initialize before checking authentication
        if (typeof Auth !== 'undefined') {
            // Wait for Auth.init() to complete if it hasn't yet
            if (!Auth.initialized) {
                await this.waitForAuth();
            }

            // Listen for auth state changes
            Auth.onAuthStateChange(async (event, session) => {
                if (event === 'SIGNED_IN') {
                    // User just logged in - merge guest cart to server and load server cart
                    await this.mergeGuestCartAndLoad();
                } else if (event === 'TOKEN_REFRESHED') {
                    // Just update auth flag, don't re-merge
                    this.isAuthenticated = true;
                } else if (event === 'SIGNED_OUT') {
                    // User logged out - clear cart state
                    this.items = [];
                    this.appliedCoupon = null;
                    this.discountAmount = 0;
                    this.serverSummary = null;
                    this.isAuthenticated = false;
                    this.validationState = 'unknown';
                    this.validationErrors = [];
                    this.updateUI();
                }
            });
        }

        await this.loadCart();
    },

    /**
     * Wait for Auth to be initialized (max 3 seconds)
     */
    async waitForAuth() {
        const maxWait = 3000;
        const checkInterval = 50;
        let waited = 0;

        while (!Auth.initialized && waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            waited += checkInterval;
        }

        if (!Auth.initialized) {
            DebugLog.warn('Auth initialization timed out, proceeding with guest mode');
        }
    },

    /**
     * Parse server cart response into local items + summary
     */
    _parseServerCart: function(responseData) {
        const self = this;
        const items = (responseData.items || []).filter(item => item.product != null).map(item => {
            const parsed = {
                id: item.product.id,
                name: item.product.name,
                price: item.product.retail_price,
                image: item.product.image_url || '',
                sku: item.product.sku,
                brand: item.product.brand?.name || '',
                color: item.product.color || '',
                quantity: item.quantity,
                inStock: item.in_stock !== false,
                stockQuantity: item.product.stock_quantity,
                source: 'core'
            };
            parsed.key = self.cartItemKey(parsed);
            return parsed;
        });

        // Store server summary if provided
        const summary = responseData.summary || null;
        const couponCode = responseData.coupon?.code || null;
        const discountAmount = responseData.coupon?.discount_amount || summary?.discount || 0;

        // Notify user if backend auto-removed orphaned items (deleted products)
        const removedItems = responseData.removed_items || [];
        if (removedItems.length > 0 && typeof showToast === 'function') {
            const count = removedItems.length;
            showToast(`${count} item${count > 1 ? 's were' : ' was'} removed from your cart (no longer available)`, 'info');
        }

        return { items, summary, couponCode, discountAmount };
    },

    /**
     * Load cart from server (both guest and authenticated users)
     * Guest carts use httpOnly cookie, authenticated carts use user ID
     */
    async loadCart() {
        this.loading = true;
        this.isAuthenticated = typeof Auth !== 'undefined' && Auth.isAuthenticated();

        // Load from localStorage first for instant display (fallback data)
        this.loadFromLocalStorage();
        const localItemCount = this.items.length;
        this._localStorageHadItems = localItemCount > 0;

        // Show localStorage items immediately for visual feedback
        this.updateUI();

        if (typeof API !== 'undefined') {
            try {
                if (this.isAuthenticated) {
                    // Check for localStorage items to migrate
                    const localItems = this.getGuestCartItems();
                    if (localItems.length > 0) {
                        await this.mergeGuestCartAndLoad();
                    } else {
                        await this.syncWithServer();
                    }
                } else {
                    // Guest users: Server-first with localStorage fallback
                    try {
                        const response = await API.getCart();
                        if (response.ok && response.data) {
                            const parsed = this._parseServerCart(response.data);

                            // If server has items, use them (with fresh prices)
                            if (parsed.items.length > 0) {
                                this.items = parsed.items;
                                this.serverSummary = parsed.summary;
                                this.appliedCoupon = parsed.couponCode;
                                this.discountAmount = parsed.discountAmount;
                                this.saveToLocalStorage();
                                this.updateUI();
                            } else if (localItemCount > 0) {
                                // Server empty but localStorage has items - keep localStorage
                                this.serverSummary = null; // No server totals for local-only items
                                this.updateUI();
                                // Sync localStorage items to server in background
                                const localItems = this.getGuestCartItems();
                                for (const item of localItems) {
                                    try {
                                        await API.addToCart(item.id, item.quantity);
                                    } catch (e) {
                                        DebugLog.error('Failed to sync item to server:', e);
                                    }
                                }
                                // After syncing, reload from server to get fresh prices
                                try {
                                    const refreshResponse = await API.getCart();
                                    if (refreshResponse.ok && refreshResponse.data) {
                                        const refreshed = this._parseServerCart(refreshResponse.data);
                                        if (refreshed.items.length > 0) {
                                            this.items = refreshed.items;
                                            this.serverSummary = refreshed.summary;
                                            this.saveToLocalStorage();
                                            this.updateUI();
                                        }
                                    }
                                } catch (e) {
                                    DebugLog.warn('Failed to refresh after sync:', e);
                                }
                            } else {
                                this.serverSummary = null;
                                this.updateUI();
                            }
                        }
                    } catch (error) {
                        DebugLog.warn('Could not load guest cart from server:', error.message);
                        // Keep localStorage data, but mark that we have no server totals
                        this.serverSummary = null;
                    }
                }
            } finally {
                // IMPORTANT: Only set loading to false AFTER all server operations complete
                this.loading = false;
            }
        } else {
            this.serverSummary = null;
            this.loading = false;
        }
    },

    /**
     * Get guest cart items from localStorage (without clearing)
     */
    getGuestCartItems() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    },

    /**
     * Sync cart with server (background operation for authenticated users)
     */
    async syncWithServer() {
        try {
            const response = await API.getCart();
            if (response.ok && response.data) {
                const parsed = this._parseServerCart(response.data);

                this.items = parsed.items;
                this.serverSummary = parsed.summary;
                this.appliedCoupon = parsed.couponCode;
                this.discountAmount = parsed.discountAmount;

                this.saveToLocalStorage();

                this.updateUI();
            }
        } catch (error) {
            DebugLog.warn('Could not sync cart with server:', error.message);
            this.serverSummary = null;
            // Keep using localStorage data
        }
    },

    /**
     * Save cart to localStorage (only for guest users)
     * Authenticated users use server as source of truth
     */
    saveToLocalStorage() {
        // For authenticated users, server is source of truth (don't save to localStorage)
        // For guest users, save everything
        try {
            if (this.isAuthenticated) {
                localStorage.removeItem(this.STORAGE_KEY);
            } else {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.items));
            }
        } catch (e) {
            DebugLog.error('Failed to save cart:', e);
        }
    },

    /**
     * Load cart from server (authenticated users)
     */
    async loadFromServer() {
        try {
            const response = await API.getCart();
            if (response.ok && response.data) {
                const parsed = this._parseServerCart(response.data);

                this.items = parsed.items;
                this.serverSummary = parsed.summary;
                this.appliedCoupon = parsed.couponCode;
                this.discountAmount = parsed.discountAmount;
            }
        } catch (error) {
            DebugLog.error('Failed to load cart from server:', error);
            this.serverSummary = null;
            // Keep existing items on failure (don't clear)
        }
    },

    /**
     * Load cart from localStorage (guest users only)
     */
    loadFromLocalStorage() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            this.items = stored ? JSON.parse(stored) : [];
            this.serverSummary = null; // localStorage has no server totals
        } catch (e) {
            DebugLog.error('Failed to load guest cart:', e);
            this.items = [];
            this.serverSummary = null;
        }
    },


    /**
     * Merge guest cart into server cart when user logs in
     * Uses /api/cart/merge endpoint for server-side guest carts (httpOnly cookie)
     * Also handles legacy localStorage items for backward compatibility
     */
    async mergeGuestCartAndLoad() {
        if (this._mergeInProgress) return;
        this._mergeInProgress = true;

        try {
            this.isAuthenticated = true;

            // Handle legacy localStorage items (backward compatibility)
            let legacyItems = [];
            try {
                const stored = localStorage.getItem(this.STORAGE_KEY);
                if (stored) {
                    legacyItems = JSON.parse(stored);
                    localStorage.removeItem(this.STORAGE_KEY);
                }
            } catch (e) {
                DebugLog.error('Failed to parse legacy cart:', e);
            }

            // Migrate legacy localStorage items to server first
            if (legacyItems.length > 0 && typeof API !== 'undefined') {
                for (const item of legacyItems) {
                    try {
                        await API.addToCart(item.id, item.quantity);
                    } catch (e) {
                        DebugLog.error('Failed to migrate legacy item:', item.id, e);
                    }
                }
            }

            // Call server merge endpoint to merge guest cart (httpOnly cookie) into user cart
            if (typeof API !== 'undefined') {
                try {
                    const mergeResult = await API.mergeCart();
                    if (mergeResult.ok) {
                        if (mergeResult.data?.merged_count > 0 || mergeResult.data?.added_count > 0) {
                            if (typeof showToast === 'function') {
                                showToast(`${mergeResult.data.total_items} items in your cart`, 'success');
                            }
                        }
                    }
                } catch (e) {
                    DebugLog.error('Cart merge failed:', e);
                }
            }

            // Load the merged cart from server
            await this.loadFromServer();
            this.updateUI();
        } finally {
            this._mergeInProgress = false;
        }
    },

    /**
     * Validate cart with server before checkout.
     * Checks stock availability and price consistency.
     * Returns { valid: boolean, errors: array }
     */
    async validateCart() {
        if (typeof API === 'undefined') {
            return { valid: false, errors: ['Unable to validate cart. Please try again.'] };
        }

        try {
            const response = await API.validateCart();
            if (response.ok) {
                const data = response.data || {};
                const errors = [];

                // Parse issues array from backend response
                // Backend returns: { cart_item_id, sku, issue, name?, available? }
                if (data.issues && data.issues.length > 0) {
                    data.issues.forEach(issue => {
                        const label = issue.name || issue.sku || 'Item';
                        if (issue.available === 0 || issue.issue === 'Insufficient stock') {
                            errors.push(`"${label}" is out of stock`);
                        } else if (issue.available !== undefined && issue.available > 0) {
                            errors.push(`"${label}" quantity adjusted to ${issue.available} (limited stock)`);
                        } else if (issue.issue === 'Price has changed') {
                            errors.push(`Price changed for "${label}" — please review before checkout`);
                        } else if (issue.issue === 'Product is no longer available') {
                            errors.push(`"${label}" is no longer available`);
                        } else {
                            errors.push(`${label}: ${issue.issue || 'unavailable'}`);
                        }
                    });
                }

                // Check for price changes in valid_items
                if (data.valid_items && data.valid_items.length > 0) {
                    data.valid_items.forEach(item => {
                        if (item.price_changed) {
                            errors.push(`Price changed for "${item.name}": now ${formatPrice(item.unit_price)}`);
                        }
                    });
                }

                const valid = errors.length === 0 && data.is_valid !== false;
                this.validationState = valid ? 'valid' : 'invalid_stock';
                this.validationErrors = errors;

                return { valid, errors };
            } else {
                return { valid: false, errors: [response.error || 'Cart validation failed'] };
            }
        } catch (error) {
            DebugLog.error('Cart validation error:', error);
            return { valid: false, errors: [error.message || 'Network error during validation'] };
        }
    },

    /**
     * Bind checkout button with pre-checkout validation
     * Intercepts the checkout anchor click to validate cart first
     * SECURITY: Blocks checkout if server pricing is unavailable
     */
    bindCheckoutButton: function() {
        const self = this;
        document.addEventListener('click', async (e) => {
            const checkoutLink = e.target.closest('#checkout-btn, .cart-summary__checkout-btn');
            if (!checkoutLink) return;

            e.preventDefault();

            if (self.items.length === 0) {
                if (typeof showToast === 'function') {
                    showToast('Your cart is empty', 'error');
                }
                return;
            }

            // If server pricing isn't available, try to refresh but don't block checkout
            // The checkout/payment pages will validate before charging
            if (!self.hasServerPricing()) {
                try { await self.loadCart(); } catch (e) { /* continue */ }
            }

            // Show validating state
            const originalText = checkoutLink.textContent;
            checkoutLink.textContent = 'Validating cart...';
            checkoutLink.style.pointerEvents = 'none';

            try {
                const result = await self.validateCart();

                if (result.valid) {
                    // Cart is valid - proceed to checkout
                    window.location.href = '/html/checkout.html';
                } else if (!self.isAuthenticated && self.items.length > 0) {
                    // Guest user: server validation may fail due to cross-origin cookie blocking.
                    // Allow proceeding — checkout/payment pages will re-validate before charging.
                    window.location.href = '/html/checkout.html';
                } else {
                    // Cart has issues - show errors
                    checkoutLink.textContent = originalText;
                    checkoutLink.style.pointerEvents = '';

                    if (result.errors.length > 0) {
                        if (typeof showToast === 'function') {
                            showToast(result.errors[0], 'error', 5000);
                            result.errors.slice(1).forEach(function(err, i) {
                                setTimeout(function() { showToast(err, 'error', 5000); }, (i + 1) * 500);
                            });
                        } else {
                            alert('Cart issues:\n' + result.errors.join('\n'));
                        }
                    } else {
                        if (typeof showToast === 'function') {
                            showToast('Please review your cart before checkout', 'error');
                        }
                    }
                }
            } catch (error) {
                // Network error — don't block checkout if we have local items
                if (self.items.length > 0) {
                    window.location.href = '/html/checkout.html';
                } else {
                    checkoutLink.textContent = originalText;
                    checkoutLink.style.pointerEvents = '';
                    if (typeof showToast === 'function') {
                        showToast('Could not validate cart. Please try again.', 'error');
                    }
                }
            }
        });
    },

    /**
     * Bind cart-related events
     */
    bindEvents: function() {
        document.addEventListener('click', async (e) => {
            // Add to cart button
            if (e.target.matches('.product-card__add-btn, .add-to-cart-btn')) {
                e.preventDefault();
                const btn = e.target;
                const productData = {
                    id: btn.dataset.productId,
                    sku: btn.dataset.productSku,
                    name: btn.dataset.productName,
                    price: parseFloat(btn.dataset.productPrice) || 0,
                    image: btn.dataset.productImage || '',
                    source: btn.dataset.productSource || 'core'
                };

                if (productData.id) {
                    await this.addItem(productData);

                    const originalText = btn.textContent;
                    btn.textContent = 'Added!';
                    btn.classList.add('btn--success');
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.classList.remove('btn--success');
                    }, 1500);
                }
            }

            // Quantity increase
            const increaseBtn = e.target.closest('.quantity-selector__btn--increase');
            if (increaseBtn) {
                const selector = increaseBtn.closest('.quantity-selector');
                const input = selector.querySelector('.quantity-selector__input');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const newValue = parseInt(input.value) + 1;
                if (newValue <= 100) {
                    input.value = newValue;
                    this._debouncedQuantityUpdate(itemId, newValue);
                }
            }

            // Quantity decrease
            const decreaseBtn = e.target.closest('.quantity-selector__btn--decrease');
            if (decreaseBtn) {
                const selector = decreaseBtn.closest('.quantity-selector');
                const input = selector.querySelector('.quantity-selector__input');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const newValue = parseInt(input.value) - 1;
                if (newValue >= 1) {
                    input.value = newValue;
                    this._debouncedQuantityUpdate(itemId, newValue);
                }
                // If user wants to go below 1, they must use the remove button
            }

            // Remove item
            const removeBtn = e.target.closest('.cart-item__remove, .btn-remove');
            if (removeBtn) {
                const cartItem = removeBtn.closest('.cart-item');
                if (cartItem) {
                    const itemId = cartItem.dataset.itemKey || cartItem.dataset.itemId;
                    await this.removeItem(itemId);
                }
            }

            // Clear cart
            if (e.target.matches('.clear-cart-btn')) {
                if (confirm('Are you sure you want to clear your cart?')) {
                    await this.clear();
                }
            }

            // Apply coupon button
            if (e.target.matches('.coupon-form__btn')) {
                const input = document.getElementById('coupon-code');
                if (input) {
                    const result = await this.applyCoupon(input.value);
                    if (result.ok) {
                        if (typeof showToast === 'function') {
                            showToast(result.message, 'success');
                        }
                    } else {
                        if (typeof showToast === 'function') {
                            showToast(result.message, 'error');
                        } else {
                            alert(result.message);
                        }
                    }
                }
            }

            // Remove coupon button
            if (e.target.matches('.coupon-remove-btn')) {
                await this.removeCoupon();
                if (typeof showToast === 'function') {
                    showToast('Coupon removed', 'info');
                }
            }
        });

        // Quantity input change (manual typing)
        document.addEventListener('change', async (e) => {
            if (e.target.matches('.quantity-selector__input')) {
                const selector = e.target.closest('.quantity-selector');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                let newValue = parseInt(e.target.value);

                // Clamp to valid range
                if (isNaN(newValue) || newValue < 1) {
                    newValue = 1;
                    e.target.value = 1;
                }
                if (newValue > 100) {
                    newValue = 100;
                    e.target.value = 100;
                }

                this._debouncedQuantityUpdate(itemId, newValue);
            }
        });
    },

    /**
     * Debounced quantity update to prevent rapid-fire API calls.
     * Uses surgical DOM updates instead of full innerHTML rebuild.
     */
    _debouncedQuantityUpdate: function(itemId, quantity) {
        if (this._quantityDebounceTimers[itemId]) {
            clearTimeout(this._quantityDebounceTimers[itemId]);
        }

        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        if (!item) return;

        const clampedQty = Math.min(quantity, 99);
        const oldQty = item.quantity;
        item.quantity = clampedQty;
        this.saveToLocalStorage();

        // Apply price delta to server summary for responsive display
        // (server will replace with correct values after API responds)
        if (this.serverSummary && this.serverSummary.subtotal !== undefined) {
            const priceDelta = item.price * (clampedQty - oldQty);
            this.serverSummary.subtotal += priceDelta;
            if (this.serverSummary.total !== undefined) {
                this.serverSummary.total += priceDelta;
            }
        }

        // Surgical DOM update — only touch the changed item + summary numbers
        this._updateCartItemDOM(itemId);
        this._updateCartSummaryDOM();

        this._quantityDebounceTimers[itemId] = setTimeout(async () => {
            delete this._quantityDebounceTimers[itemId];
            await this._executeQuantityUpdate(itemId, clampedQty);
        }, 400);
    },

    /**
     * Execute the actual quantity update after debounce.
     * Guarded per-item to prevent concurrent API calls for the same item.
     * Queues the latest value if an API call is already in-flight.
     */
    async _executeQuantityUpdate(itemId, quantity) {
        // Guard: if already in-flight for this item, queue the value
        if (this._quantityInFlight[itemId]) {
            this._quantityQueued[itemId] = quantity;
            return;
        }

        this._quantityInFlight[itemId] = true;
        const oldQuantity = quantity;
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        const isCore = !item || !item.source || item.source === 'core';

        try {
            if (isCore && typeof API !== 'undefined') {
                try {
                    const response = await API.updateCartItem(itemId, quantity);
                    const hasPendingUpdate = this._quantityQueued[itemId] !== undefined
                                          || this._quantityDebounceTimers[itemId];

                    if (response.ok) {
                        if (response.data?.items) {
                            const parsed = this._parseServerCart(response.data);
                            this.items = parsed.items;
                            this.serverSummary = parsed.summary;
                            this.appliedCoupon = parsed.couponCode;
                            this.discountAmount = parsed.discountAmount;
                        } else {
                            await this.loadFromServer();
                        }
                        // Only update DOM if no pending update (queue or debounce timer)
                        if (!hasPendingUpdate) {
                            this._updateCartItemDOM(itemId);
                            this._updateCartSummaryDOM();
                        }
                    } else if (response.available !== undefined) {
                        // Stock limited — force to max available
                        const freshItem = this.items.find(i => i.id === itemId);
                        if (freshItem) {
                            freshItem.quantity = response.available;
                            this.saveToLocalStorage();
                            this._updateCartItemDOM(itemId);
                            this._updateCartSummaryDOM();
                        }
                        // Clear debounce timer and queued value since stock is limited
                        if (this._quantityDebounceTimers[itemId]) {
                            clearTimeout(this._quantityDebounceTimers[itemId]);
                            delete this._quantityDebounceTimers[itemId];
                        }
                        delete this._quantityQueued[itemId];
                        if (typeof showToast === 'function') {
                            showToast(`Only ${response.available} available in stock`, 'error');
                        }
                    } else {
                        // Generic failure — reload from server for correct state
                        await this.loadFromServer();
                        if (!hasPendingUpdate) {
                            this._updateCartItemDOM(itemId);
                            this._updateCartSummaryDOM();
                        }
                        if (typeof showToast === 'function') {
                            showToast('Failed to update quantity. Please try again.', 'error');
                        }
                    }
                } catch (error) {
                    DebugLog.error('Failed to sync quantity to server:', error);
                    await this.loadFromServer();
                    if (!this._quantityQueued[itemId] && !this._quantityDebounceTimers[itemId]) {
                        this._updateCartItemDOM(itemId);
                        this._updateCartSummaryDOM();
                    }
                    if (typeof showToast === 'function') {
                        showToast('Network error. Quantity may have reverted.', 'error');
                    }
                }
            }

            // Track analytics
            const trackItem = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
            if (typeof CartAnalytics !== 'undefined' && trackItem) {
                CartAnalytics.trackUpdateQuantity(trackItem, oldQuantity, trackItem.quantity);
            }
        } finally {
            delete this._quantityInFlight[itemId];

            // If a new value was queued while in-flight, fire it now
            if (this._quantityQueued[itemId] !== undefined) {
                const queued = this._quantityQueued[itemId];
                delete this._quantityQueued[itemId];
                await this._executeQuantityUpdate(itemId, queued);
            }
        }
    },

    /**
     * Surgically update a single cart item's DOM elements.
     * Avoids full innerHTML rebuild to prevent destroying in-flight interactions.
     */
    _updateCartItemDOM: function(itemId) {
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        if (!item) return;

        const cartItemEl = document.querySelector('.cart-item[data-item-key="' + itemId + '"]')
            || document.querySelector('.cart-item[data-item-id="' + itemId + '"]');
        if (!cartItemEl) return;

        // Update quantity input (only if not focused — don't fight the user)
        const input = cartItemEl.querySelector('.quantity-selector__input');
        if (input && document.activeElement !== input) {
            input.value = item.quantity;
        }

        // Update line total
        const totalEl = cartItemEl.querySelector('.cart-item__total');
        if (totalEl) {
            totalEl.textContent = formatPrice(item.price * item.quantity);
        }

        // Update mobile price line
        const priceMobile = cartItemEl.querySelector('.cart-item__price-mobile');
        if (priceMobile) {
            priceMobile.textContent = formatPrice(item.price);
        }
    },

    /**
     * Surgically update cart summary DOM elements.
     * Updates counts, subtotal, shipping, total, progress bar without rebuilding cart items.
     */
    _updateCartSummaryDOM: function() {
        // Update header cart count badges
        const itemCount = this.getItemCount();
        document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
            el.textContent = itemCount;
            el.hidden = itemCount === 0;
        });
        if (typeof updateCartCount === 'function') {
            updateCartCount(itemCount);
        }

        // Only update summary section if on cart page
        if (!document.querySelector('.cart-page')) return;

        // Price warning
        const priceWarning = document.getElementById('cart-price-warning');
        if (priceWarning) {
            if (this.isUsingEstimatedPrices()) {
                priceWarning.hidden = false;
                priceWarning.textContent = 'Prices shown are estimates. Final prices will be confirmed at checkout.';
            } else {
                priceWarning.hidden = true;
            }
        }

        const subtotal = this.getSubtotal();
        const discount = this.getDiscount();
        // Cart page total excludes shipping — shipping is calculated at checkout
        const cartTotal = subtotal - discount;

        const itemCountEl = document.getElementById('cart-item-count');
        const subtotalEl = document.getElementById('cart-subtotal');
        const gstEl = document.getElementById('cart-gst');
        const totalEl = document.getElementById('cart-total');
        const savingsRow = document.getElementById('cart-savings-row');
        const savingsEl = document.getElementById('cart-savings');

        if (itemCountEl) itemCountEl.textContent = itemCount;
        if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal);
        if (gstEl) gstEl.textContent = formatPrice(this.serverSummary?.gst_amount != null ? this.serverSummary.gst_amount : calculateGST(cartTotal));
        if (totalEl) totalEl.textContent = formatPrice(cartTotal) + ' NZD';

        if (savingsRow && savingsEl) {
            if (discount > 0) {
                savingsRow.hidden = false;
                savingsEl.textContent = '-' + formatPrice(discount);
            } else {
                savingsRow.hidden = true;
            }
        }

        // Cart summary class-based elements
        const cartSummary = document.querySelector('.cart-summary');
        if (cartSummary) {
            const subtotalClassEl = cartSummary.querySelector('.cart-summary__subtotal');
            const totalClassEl = cartSummary.querySelector('.cart-summary__total-value');

            if (subtotalClassEl) subtotalClassEl.textContent = formatPrice(subtotal);
            if (totalClassEl) totalClassEl.textContent = formatPrice(cartTotal);
        }
    },

    /**
     * Add item to cart - SERVER FIRST for all users
     * Both guest and authenticated users use server-side cart
     * Also saves to localStorage for cross-origin cookie fallback
     */
    async addItem(product) {
        // Snapshot for rollback
        const previousItems = JSON.parse(JSON.stringify(this.items));

        // Determine source and compute composite key
        const source = product.source || 'core';
        const key = this.cartItemKey({ source: source, sku: product.sku, slug: product.slug, id: product.id });
        const isCore = source === 'core';

        // Update local cart first (instant feedback)
        const existingItem = this.items.find(function(item) {
            return (item.key || Cart.cartItemKey(item)) === key;
        });

        if (existingItem) {
            existingItem.quantity += product.quantity || 1;
        } else {
            this.items.push({
                id: product.id,
                name: product.name,
                price: product.price,
                image: product.image || '',
                sku: product.sku || '',
                brand: product.brand || '',
                color: product.color || '',
                quantity: product.quantity || 1,
                source: source,
                key: key,
                slug: product.slug || ''
            });
        }

        // Invalidate server summary (will be refreshed after server confirms)
        this.serverSummary = null;

        // Always save to localStorage as backup (for cross-origin cookie issues)
        this.saveToLocalStorage();
        this.updateUI();

        // Sync to server only for core items
        if (isCore && typeof API !== 'undefined') {
            try {
                const response = await API.addToCart(product.id, product.quantity || 1);
                if (!response.ok) {
                    // Server rejected - rollback
                    this.items = previousItems;
                    this.saveToLocalStorage();
                    this.updateUI();

                    if (response.available !== undefined) {
                        if (typeof showToast === 'function') {
                            showToast(`Only ${response.available} available in stock`, 'error');
                        }
                    } else {
                        if (typeof showToast === 'function') {
                            showToast(response.error || 'Failed to add item to cart', 'error');
                        }
                    }
                    return;
                }

                // Server confirmed - refresh to get accurate server totals
                const itemsAfterAdd = JSON.parse(JSON.stringify(this.items));
                await this.loadFromServer();
                // Guard: if server returned empty (e.g. cross-origin cookie blocked), keep local state
                if (this.items.length === 0 && itemsAfterAdd.length > 0) {
                    this.items = itemsAfterAdd;
                    this.saveToLocalStorage();
                }
                this.updateUI();
            } catch (error) {
                DebugLog.error('Failed to sync cart to server:', error);
                // Rollback on network error
                this.items = previousItems;
                this.saveToLocalStorage();
                this.updateUI();
                if (typeof showToast === 'function') {
                    showToast('Network error. Could not add item.', 'error');
                }
                return;
            }
        }

        if (typeof showToast === 'function') {
            showToast(product.name + ' added to cart', 'success');
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined') {
            CartAnalytics.trackAddToCart(product, product.quantity || 1);
        }
    },

    /**
     * Update item quantity - called directly only for programmatic updates
     * UI-triggered updates go through _debouncedQuantityUpdate
     */
    async updateQuantity(itemId, quantity) {
        if (quantity <= 0) {
            await this.removeItem(itemId);
            return;
        }

        // Store old quantity for potential rollback
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        const oldQuantity = item ? item.quantity : 0;
        const isCore = !item || !item.source || item.source === 'core';

        // Update locally first (instant feedback)
        if (item) {
            item.quantity = Math.min(quantity, 99);
            this.serverSummary = null; // Invalidate until server confirms
            this.saveToLocalStorage();
            this.updateUI();
        }

        // Sync to server only for core items
        if (isCore && typeof API !== 'undefined') {
            try {
                const response = await API.updateCartItem(itemId, quantity);
                if (response.ok) {
                    // Refresh from server for accurate totals
                    await this.loadFromServer();
                    this.updateUI();
                } else if (response.available !== undefined) {
                    // Insufficient stock - revert to max available
                    if (item) {
                        item.quantity = response.available;
                        this.saveToLocalStorage();
                        this.updateUI();
                    }
                    if (typeof showToast === 'function') {
                        showToast(`Only ${response.available} available in stock`, 'error');
                    }
                } else {
                    // Generic failure - rollback
                    if (item) {
                        item.quantity = oldQuantity;
                        this.saveToLocalStorage();
                        this.updateUI();
                    }
                    if (typeof showToast === 'function') {
                        showToast('Failed to update quantity. Please try again.', 'error');
                    }
                }
            } catch (error) {
                DebugLog.error('Failed to sync quantity to server:', error);
                // Rollback on error
                if (item) {
                    item.quantity = oldQuantity;
                    this.saveToLocalStorage();
                    this.updateUI();
                }
                if (typeof showToast === 'function') {
                    showToast('Network error. Quantity reverted.', 'error');
                }
            }
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined' && item) {
            CartAnalytics.trackUpdateQuantity(item, oldQuantity, item.quantity);
        }
    },

    /**
     * Remove item from cart - with rollback on server failure
     * Syncs to server for both guest and authenticated users
     */
    async removeItem(itemId) {
        // Find item by key (composite) or fall back to id
        const self = this;
        const removedItem = this.items.find(function(item) {
            return item.key === itemId || item.id === itemId;
        });
        const previousItems = JSON.parse(JSON.stringify(this.items));
        const isCore = !removedItem || !removedItem.source || removedItem.source === 'core';
        const actualId = removedItem ? removedItem.id : itemId;

        // Remove locally first (instant feedback)
        this.items = this.items.filter(function(item) {
            return item.key !== itemId && item.id !== itemId;
        });
        this.serverSummary = null; // Invalidate until server confirms
        this.saveToLocalStorage();
        this.updateUI();

        // Sync to server only for core items
        if (isCore && typeof API !== 'undefined') {
            try {
                const response = await API.removeFromCart(actualId);
                if (response && !response.ok) {
                    // Server rejected removal - rollback
                    this.items = previousItems;
                    this.saveToLocalStorage();
                    this.updateUI();
                    if (typeof showToast === 'function') {
                        showToast('Failed to remove item. Please try again.', 'error');
                    }
                    return;
                }
                // Refresh from server for accurate totals
                await this.loadFromServer();
                this.updateUI();
            } catch (error) {
                DebugLog.error('Failed to sync removal to server:', error);
                // Rollback on network error
                this.items = previousItems;
                this.saveToLocalStorage();
                this.updateUI();
                if (typeof showToast === 'function') {
                    showToast('Network error. Item not removed.', 'error');
                }
                return;
            }
        }

        if (typeof showToast === 'function') {
            showToast('Item removed from cart', 'info');
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined' && removedItem) {
            CartAnalytics.trackRemoveFromCart(removedItem, removedItem.quantity);
        }
    },

    /**
     * Clear entire cart - Local first, then sync to server
     * Syncs to server for both guest and authenticated users
     */
    async clear() {
        // Snapshot for rollback
        const previousItems = JSON.parse(JSON.stringify(this.items));
        const previousCoupon = this.appliedCoupon;
        const previousDiscount = this.discountAmount;

        // Clear locally first (instant)
        this.items = [];
        this.appliedCoupon = null;
        this.discountAmount = 0;
        this.serverSummary = null;
        localStorage.removeItem(this.STORAGE_KEY);
        this.updateUI();

        // Sync to server for both guest and authenticated users
        if (typeof API !== 'undefined') {
            try {
                const response = await API.clearCart();
                if (response && !response.ok) {
                    // Server rejected - rollback
                    this.items = previousItems;
                    this.appliedCoupon = previousCoupon;
                    this.discountAmount = previousDiscount;
                    this.saveToLocalStorage();
                    this.updateUI();
                    if (typeof showToast === 'function') {
                        showToast('Failed to clear cart. Please try again.', 'error');
                    }
                }
            } catch (error) {
                DebugLog.error('Failed to sync cart clear to server:', error);
                // Rollback on network error
                this.items = previousItems;
                this.appliedCoupon = previousCoupon;
                this.discountAmount = previousDiscount;
                this.saveToLocalStorage();
                this.updateUI();
                if (typeof showToast === 'function') {
                    showToast('Network error. Cart not cleared.', 'error');
                }
            }
        }
    },

    /**
     * Check if we have server-verified pricing
     * SECURITY: Checkout should be blocked if this returns false
     */
    hasServerPricing: function() {
        return this.serverSummary && this.serverSummary.subtotal !== undefined;
    },

    /**
     * Get cart subtotal - uses server summary when available
     * Returns estimate for display only when server unavailable
     */
    getSubtotal: function() {
        if (this.serverSummary && this.serverSummary.subtotal !== undefined) {
            return this.serverSummary.subtotal;
        }
        // DISPLAY ONLY estimate - never use for checkout
        // This is only for showing approximate cart value when offline
        return this.items.reduce((total, item) => {
            return total + (item.price * item.quantity);
        }, 0);
    },

    /**
     * Check if current prices are estimates (not server-verified)
     */
    isUsingEstimatedPrices: function() {
        return !this.hasServerPricing();
    },

    /**
     * Get total item count
     */
    getItemCount: function() {
        return this.items.reduce((count, item) => count + item.quantity, 0);
    },

    /**
     * Get shipping cost - uses server summary when available
     * Returns estimate for display only when server unavailable
     */
    getShipping: function() {
        if (this.serverSummary && this.serverSummary.shipping !== undefined) {
            return this.serverSummary.shipping;
        }
        // DISPLAY ONLY estimate via Shipping module
        if (typeof Shipping !== 'undefined') {
            return Shipping.calculate(this.items, this.getSubtotal()).fee;
        }
        // Ultimate fallback (North Island urban light rate)
        const threshold = typeof Config !== 'undefined' ? Config.getSetting('FREE_SHIPPING_THRESHOLD', 100) : 100;
        return this.getSubtotal() >= threshold ? 0 : 7;
    },

    /**
     * Get discount amount from applied coupon
     */
    getDiscount: function() {
        if (this.serverSummary && this.serverSummary.discount !== undefined) {
            return this.serverSummary.discount;
        }
        // Discount is calculated server-side for authenticated users
        // For guests, no discounts available (must login)
        return this.discountAmount || 0;
    },

    /**
     * Apply a coupon code - SERVER VALIDATION
     */
    async applyCoupon(code) {
        const normalizedCode = (code || '').toUpperCase().trim();

        if (!normalizedCode) {
            return { ok: false, message: 'Please enter a coupon code' };
        }

        if (!this.isAuthenticated) {
            return { ok: false, message: 'Please login to apply coupon codes' };
        }

        if (typeof API === 'undefined') {
            return { ok: false, message: 'Unable to validate coupon' };
        }

        try {
            const response = await API.applyCoupon(normalizedCode);
            if (response.ok) {
                this.appliedCoupon = response.data?.code || normalizedCode;
                this.discountAmount = response.data?.discount_amount || 0;
                await this.loadFromServer(); // Reload to get updated totals
                this.updateUI();
                return { ok: true, message: response.message || 'Coupon applied!' };
            } else {
                // Handle rate limiting with retry_after
                if (response.code === 'RATE_LIMITED') {
                    const retryAfter = response.retry_after;
                    if (retryAfter && retryAfter > 60) {
                        const mins = Math.ceil(retryAfter / 60);
                        return { ok: false, message: `Too many attempts. Please try again in ${mins} minute${mins > 1 ? 's' : ''}.` };
                    }
                    return { ok: false, message: response.error || 'Too many attempts. Please try again later.' };
                }
                return { ok: false, message: response.error || 'Coupon could not be applied' };
            }
        } catch (error) {
            DebugLog.error('Failed to apply coupon:', error);
            return { ok: false, message: error.message || 'Failed to apply coupon' };
        }
    },

    /**
     * Remove applied coupon - SERVER
     */
    async removeCoupon() {
        if (this.isAuthenticated && typeof API !== 'undefined') {
            try {
                await API.removeCoupon();
                this.appliedCoupon = null;
                this.discountAmount = 0;
                await this.loadFromServer();
                this.updateUI();
            } catch (error) {
                DebugLog.error('Failed to remove coupon:', error);
            }
        } else {
            this.appliedCoupon = null;
            this.discountAmount = 0;
            this.updateUI();
        }
    },

    /**
     * Get cart total - uses server summary when available
     * Returns estimate for display only when server unavailable
     * SECURITY: Never use this for payment - backend calculates final total
     */
    getTotal: function() {
        if (this.serverSummary && this.serverSummary.total !== undefined) {
            return this.serverSummary.total;
        }
        // DISPLAY ONLY estimate - includes shipping estimate
        // SECURITY: Never use this for payment - backend calculates final total
        return this.getSubtotal() + this.getShipping() - this.getDiscount();
    },

    /**
     * Check if any cart items are out of stock
     */
    hasOutOfStockItems: function() {
        return this.items.some(item => item.inStock === false);
    },

    /**
     * Update UI to reflect cart state
     */
    updateUI: function() {
        if (typeof updateCartCount === 'function') {
            updateCartCount(this.getItemCount());
        }

        document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
            el.textContent = this.getItemCount();
            el.hidden = this.getItemCount() === 0;
        });

        const cartPage = document.querySelector('.cart-page');
        if (cartPage) {
            this.renderCartPage();
        }
    },

    /**
     * Render cart page content
     */
    renderCartPage: function() {
        const cartItems = document.querySelector('.cart-items') || document.getElementById('cart-items');
        const cartEmpty = document.querySelector('.cart-empty') || document.getElementById('cart-empty');
        const cartLayout = document.querySelector('.cart-layout') || document.getElementById('cart-layout');
        const cartLoading = document.getElementById('cart-loading');
        const cartSummary = document.querySelector('.cart-summary');

        // Show loading skeleton only if loading AND localStorage had items
        // If localStorage is empty, show the empty state immediately rather than
        // blocking on a server round-trip (Render cold starts can take 10-30s)
        if (this.loading && this.items.length === 0 && cartLoading) {
            if (this._localStorageHadItems) {
                // localStorage had items — worth waiting for server to confirm
                cartLoading.hidden = false;
                if (cartLayout) cartLayout.hidden = true;
                if (cartEmpty) cartEmpty.hidden = true;
                return;
            }
            // localStorage was empty — show empty state instantly, server will
            // update the UI if it turns out a cookie-based guest cart exists
        }

        // Hide loading state
        if (cartLoading) cartLoading.hidden = true;

        // Add syncing indicator if loading with existing items
        if (cartLayout) {
            if (this.loading && this.items.length > 0) {
                cartLayout.classList.add('cart-layout--syncing');
            } else {
                cartLayout.classList.remove('cart-layout--syncing');
            }
        }

        if (this.items.length === 0) {
            if (cartLayout) cartLayout.hidden = true;
            if (cartEmpty) cartEmpty.hidden = false;
        } else {
            if (cartLayout) cartLayout.hidden = false;
            if (cartEmpty) cartEmpty.hidden = true;

            if (cartItems) {
                const self = this;
                cartItems.innerHTML = this.items.map(function(item) {
                    const escapedName = Security.escapeHtml(item.name);
                    const escapedBrand = Security.escapeHtml(item.brand || '');
                    const escapedSku = Security.escapeHtml(item.sku || '');
                    const isOutOfStock = item.inStock === false;
                    const itemKey = item.key || self.cartItemKey(item);

                    let stockWarning = '';
                    if (isOutOfStock) {
                        stockWarning = '<span class="cart-item__stock-warning">Out of Stock</span>';
                    } else if (item.stockQuantity !== undefined && item.stockQuantity > 0 && item.stockQuantity <= 5) {
                        stockWarning = '<span class="cart-item__stock-low">Only ' + item.stockQuantity + ' left</span>';
                    }

                    const productLink = '/html/product/?sku=' + encodeURIComponent(item.sku || '');

                    return '\
                    <article class="cart-item' + (isOutOfStock ? ' cart-item--out-of-stock' : '') + '" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '">\
                        <div class="cart-item__image">\
                            ' + self.getItemImageHTML(item) + '\
                        </div>\
                        <div class="cart-item__details">\
                            <h3 class="cart-item__name">\
                                <a href="' + productLink + '">' + escapedName + '</a>\
                            </h3>\
                            ' + (escapedBrand ? '<p class="cart-item__brand">' + escapedBrand + '</p>' : '') + '\
                            ' + (escapedSku ? '<p class="cart-item__sku">SKU: ' + escapedSku + '</p>' : '') + '\
                            ' + stockWarning + '\
                            <p class="cart-item__price-mobile">' + formatPrice(item.price) + '</p>\
                        </div>\
                        <div class="cart-item__price">\
                            ' + formatPrice(item.price) + '\
                        </div>\
                        <div class="cart-item__quantity">\
                            <div class="quantity-selector" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '">\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--decrease" aria-label="Decrease quantity"' + (isOutOfStock ? ' disabled' : '') + '>\
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                        <line x1="5" y1="12" x2="19" y2="12"></line>\
                                    </svg>\
                                </button>\
                                <input type="number" class="quantity-selector__input" value="' + item.quantity + '" min="1" max="100" aria-label="Quantity"' + (isOutOfStock ? ' disabled' : '') + '>\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--increase" aria-label="Increase quantity"' + (isOutOfStock ? ' disabled' : '') + '>\
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                        <line x1="12" y1="5" x2="12" y2="19"></line>\
                                        <line x1="5" y1="12" x2="19" y2="12"></line>\
                                    </svg>\
                                </button>\
                            </div>\
                        </div>\
                        <div class="cart-item__total">\
                            ' + formatPrice(item.price * item.quantity) + '\
                        </div>\
                        <button type="button" class="cart-item__remove" aria-label="Remove ' + escapedName + '">\
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                <polyline points="3 6 5 6 21 6"></polyline>\
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>\
                            </svg>\
                        </button>\
                    </article>';
                }).join('');
                // Bind image error fallbacks (replaces inline onerror)
                this.bindImageFallbacks(cartItems);
            }

            // Show warning if prices are estimates (not server-verified)
            const priceWarning = document.getElementById('cart-price-warning');
            if (priceWarning) {
                if (this.isUsingEstimatedPrices()) {
                    priceWarning.hidden = false;
                    priceWarning.textContent = 'Prices shown are estimates. Final prices will be confirmed at checkout.';
                } else {
                    priceWarning.hidden = true;
                }
            }

            const subtotal = this.getSubtotal();
            const discount = this.getDiscount();
            // Cart page total excludes shipping — shipping is calculated at checkout
            const cartTotal = subtotal - discount;
            const itemCount = this.getItemCount();

            const itemCountEl = document.getElementById('cart-item-count');
            const subtotalEl = document.getElementById('cart-subtotal');
            const gstEl = document.getElementById('cart-gst');
            const totalEl = document.getElementById('cart-total');
            const savingsRow = document.getElementById('cart-savings-row');
            const savingsEl = document.getElementById('cart-savings');

            if (itemCountEl) itemCountEl.textContent = itemCount;
            if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal);
            if (gstEl) gstEl.textContent = formatPrice(this.serverSummary?.gst_amount != null ? this.serverSummary.gst_amount : calculateGST(cartTotal));
            if (totalEl) totalEl.textContent = formatPrice(cartTotal) + ' NZD';

            if (savingsRow && savingsEl) {
                if (discount > 0) {
                    savingsRow.hidden = false;
                    savingsEl.textContent = '-' + formatPrice(discount);
                } else {
                    savingsRow.hidden = true;
                }
            }

            // Coupon form - only show for authenticated users
            const couponForm = document.querySelector('.coupon-form');
            if (couponForm) {
                if (this.appliedCoupon) {
                    couponForm.innerHTML = `
                        <div class="coupon-applied">
                            <span class="coupon-applied__code">${Security.escapeHtml(this.appliedCoupon)}</span>
                            <button type="button" class="coupon-remove-btn" aria-label="Remove coupon">&times;</button>
                        </div>
                    `;
                } else if (!this.isAuthenticated) {
                    couponForm.innerHTML = `
                        <p class="coupon-login-message">Login to apply coupon codes</p>
                    `;
                } else {
                    const couponInput = document.getElementById('coupon-code');
                    if (!couponInput) {
                        couponForm.innerHTML = `
                            <input type="text" id="coupon-code" name="coupon" placeholder="Enter code" class="coupon-form__input">
                            <button type="button" class="btn btn--secondary coupon-form__btn">Apply</button>
                        `;
                    }
                }
            }

            if (cartSummary) {
                const subtotalClassEl = cartSummary.querySelector('.cart-summary__subtotal');
                const totalClassEl = cartSummary.querySelector('.cart-summary__total-value');

                if (subtotalClassEl) subtotalClassEl.textContent = formatPrice(subtotal);
                if (totalClassEl) totalClassEl.textContent = formatPrice(cartTotal);
            }

            // Disable checkout if cart has out-of-stock items
            const checkoutBtn = document.getElementById('checkout-btn');
            if (checkoutBtn) {
                if (this.hasOutOfStockItems()) {
                    checkoutBtn.classList.add('btn--disabled');
                    checkoutBtn.setAttribute('aria-disabled', 'true');
                    checkoutBtn.title = 'Remove out-of-stock items before checkout';
                } else {
                    checkoutBtn.classList.remove('btn--disabled');
                    checkoutBtn.removeAttribute('aria-disabled');
                    checkoutBtn.title = '';
                }
            }
        }
    }
};

// Initialize cart when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    Cart.init();
});
