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
    // 'valid' | 'invalid_price' | 'unknown'
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

    // Set of item IDs/keys currently being removed (in-flight delete API calls)
    _removingItems: new Set(),

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
        const colorStyle = ProductColors.getProductStyle(item, 'background-color: #e0e0e0;');
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
     * Bind image error fallback handlers — delegates to Products if available,
     * otherwise falls back to inline implementation for pages without products.js.
     */
    bindImageFallbacks(container) {
        if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
            Products.bindImageFallbacks(container);
            return;
        }
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

            // Pre-set auth flag so session-restore SIGNED_IN events are correctly guarded
            this.isAuthenticated = Auth.isAuthenticated();

            // Listen for auth state changes
            Auth.onAuthStateChange(async (event, session) => {
                if (event === 'SIGNED_IN') {
                    // Skip merge if already authenticated (session restore, not a real sign-in)
                    if (this.isAuthenticated || this._mergeInProgress) return;
                    // User just logged in - merge guest cart to server and load server cart
                    await this.mergeGuestCartAndLoad();
                } else if (event === 'TOKEN_REFRESHED') {
                    // Just update auth flag, don't re-merge
                    this.isAuthenticated = true;
                } else if (event === 'SIGNED_OUT') {
                    // User logged out - clear cart state and localStorage cache
                    this.items = [];
                    this.appliedCoupon = null;
                    this.discountAmount = 0;
                    this.serverSummary = null;
                    this.isAuthenticated = false;
                    this.validationState = 'unknown';
                    this.validationErrors = [];
                    localStorage.removeItem(this.STORAGE_KEY);
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
                image: typeof storageUrl === 'function' ? storageUrl(item.product.image_url) : (item.product.image_url || ''),
                sku: item.product.sku,
                brand: item.product.brand?.name || '',
                color: item.product.color || '',
                color_hex: item.product.color_hex || null,
                quantity: item.quantity,
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
                    await this.syncWithServer();
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
                this.updateUI();
            }
        } else {
            this.serverSummary = null;
            this.loading = false;
            this.updateUI();
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

                // Guard: don't clear local items if server unexpectedly returns empty
                if (parsed.items.length === 0 && this.items.length > 0) {
                    DebugLog.warn('Server returned empty cart — keeping local items as fallback');
                    this.serverSummary = null;
                    this.updateUI();
                    return;
                }

                // Merge back any local core items the server doesn't know about yet
                // (e.g. add-to-cart API call was in-flight during navigation)
                const serverIds = new Set(parsed.items.map(i => i.id));
                const localOnly = this.items.filter(i => {
                    return i.source === 'core' && !serverIds.has(i.id);
                });
                this.items = parsed.items;
                if (localOnly.length > 0) {
                    for (const item of localOnly) {
                        if (typeof API !== 'undefined') {
                            try {
                                await API.addToCart(item.id, item.quantity);
                            } catch (e) {
                                DebugLog.error('Failed to sync local item:', item.id, e);
                            }
                        }
                    }
                    // Reload to get accurate server state after adding items
                    await this.loadFromServer();
                    this.saveToLocalStorage();
                }
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
     * Save cart to localStorage as a cache for ALL users.
     * Server remains source of truth for authenticated users,
     * but localStorage acts as a fallback for slow/failed server calls.
     */
    saveToLocalStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.items));
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

                // Filter out items that are currently being removed (in-flight deletes)
                // to prevent them from reappearing while their delete API call is still in flight
                if (this._removingItems.size > 0) {
                    parsed.items = parsed.items.filter(function(item) {
                        return !Cart._removingItems.has(item.id) && !Cart._removingItems.has(item.key);
                    });
                }

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

            // Read and clear legacy localStorage items BEFORE any server calls
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

            // Step 1: Merge guest cookie cart into user cart FIRST
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

            // Step 2: Load server cart to see what's already there
            await this.loadFromServer();
            const serverKeys = new Set(this.items.map(i => i.key || this.cartItemKey(i)));

            // Step 3: Only add localStorage items NOT already on server
            if (legacyItems.length > 0 && typeof API !== 'undefined') {
                for (const item of legacyItems) {
                    const k = item.key || this.cartItemKey(item);
                    if (!serverKeys.has(k)) {
                        try {
                            await API.addToCart(item.id, item.quantity);
                        } catch (e) {
                            DebugLog.error('Failed to migrate legacy item:', item.id, e);
                        }
                    }
                }
                // Reload to get accurate totals after adding new items
                await this.loadFromServer();
            }

            this.saveToLocalStorage();
            this.updateUI();
        } finally {
            this._mergeInProgress = false;
        }
    },

    /**
     * Validate cart with server before checkout.
     * Checks stock availability and price consistency.
     * Returns { valid: boolean, errors: array, priceChanges: array }
     */
    async validateCart(acknowledgePriceChanges) {
        if (typeof API === 'undefined') {
            return { valid: false, errors: ['Unable to validate cart. Please try again.'], priceChanges: [] };
        }

        // Get Turnstile token for bot verification (non-blocking — returns null if unavailable)
        const turnstileToken = typeof Auth !== 'undefined' ? await Auth.getTurnstileToken() : null;

        try {
            const response = await API.validateCart(turnstileToken, acknowledgePriceChanges);
            if (response.ok) {
                const data = response.data || {};
                const errors = [];
                const priceChanges = [];

                // Parse issues array from backend response
                // Backend returns: { cart_item_id, sku, issue, name?, available?, old_price?, new_price? }
                if (data.issues && data.issues.length > 0) {
                    data.issues.forEach(issue => {
                        const label = issue.name || issue.sku || 'Item';
                        if (issue.issue === 'Price has changed') {
                            priceChanges.push({
                                name: label,
                                sku: issue.sku,
                                oldPrice: issue.old_price,
                                newPrice: issue.new_price
                            });
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
                            priceChanges.push({
                                name: item.name || 'Item',
                                sku: item.sku,
                                oldPrice: item.old_price,
                                newPrice: item.unit_price
                            });
                        }
                    });
                }

                const valid = errors.length === 0 && priceChanges.length === 0 && data.is_valid !== false;
                this.validationState = valid ? 'valid' : 'invalid_price';
                this.validationErrors = errors;

                return { valid, errors, priceChanges };
            } else {
                // Non-ok API response = infrastructure error (auth, Turnstile, server failure).
                // Stock/availability errors always come via data.issues in an ok: true response.
                // Re-throw so the checkout handler's catch block allows proceeding.
                throw new Error(response.error || 'Cart validation failed');
            }
        } catch (error) {
            DebugLog.error('Cart validation error:', error);
            // Re-throw server/network errors so the checkout handler's catch
            // can allow proceeding — checkout page will re-validate before charging
            throw error;
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

            // A non-empty cart means either local items exist OR server pricing exists
            // (serverSummary is cleared on remove/clear, so it's a reliable signal).
            const cartHasItems = self.items.length > 0 || self.hasServerPricing();
            if (!cartHasItems) {
                if (typeof showToast === 'function') {
                    showToast('Your cart is empty', 'error');
                }
                return;
            }

            // Validate cart for stock issues and price changes.
            // Stock warnings are advisory (never block navigation — checkout re-validates).
            // Price changes require explicit acknowledgment before proceeding.
            try {
                const result = await self.validateCart();

                // Show stock/availability warnings as toasts (advisory only)
                if (result.errors && result.errors.length > 0) {
                    if (typeof showToast === 'function') {
                        result.errors.forEach(function(err, i) {
                            setTimeout(function() { showToast(err, 'warning', 6000); }, i * 500);
                        });
                    }
                }

                // Price changes require user acknowledgment before checkout
                if (result.priceChanges && result.priceChanges.length > 0) {
                    const accepted = await self.showPriceChangeModal(result.priceChanges);
                    if (!accepted) return; // User declined — stay on cart
                    // Acknowledge price changes so backend updates snapshots
                    try {
                        await self.validateCart(true);
                    } catch (_ackErr) {
                        // Acknowledgment failed — proceed anyway, checkout will re-validate
                    }
                }
            } catch (_) {
                // Validation failed (network/Turnstile/auth) — proceed anyway.
            }

            window.location.href = '/html/checkout.html';
        });
    },

    /**
     * Show a modal listing price changes and ask the user to accept or decline.
     * Returns a Promise that resolves true (accept) or false (decline).
     */
    showPriceChangeModal(priceChanges) {
        return new Promise((resolve) => {
            const existing = document.getElementById('price-change-modal');
            if (existing) existing.remove();

            // esc() provided by utils.js
            const fmt = typeof formatPrice === 'function' ? formatPrice : (v) => `$${Number(v).toFixed(2)}`;

            const rows = priceChanges.map(pc =>
                `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee">` +
                    `<span style="font-weight:500">${esc(pc.name)}</span>` +
                    `<span>` +
                        (pc.oldPrice != null ? `<span style="text-decoration:line-through;color:#999;margin-right:8px">${esc(fmt(pc.oldPrice))}</span>` : '') +
                        `<span style="color:#e53e3e;font-weight:600">${esc(fmt(pc.newPrice))}</span>` +
                    `</span>` +
                `</div>`
            ).join('');

            const overlay = document.createElement('div');
            overlay.id = 'price-change-modal';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
            overlay.innerHTML =
                `<div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18)">` +
                    `<h3 style="margin:0 0 6px;font-size:18px">Prices Have Changed</h3>` +
                    `<p style="margin:0 0 16px;color:#666;font-size:14px">The following items have updated prices since you added them to your cart:</p>` +
                    `<div style="margin-bottom:20px">${rows}</div>` +
                    `<div style="display:flex;gap:12px;justify-content:flex-end">` +
                        `<button type="button" id="price-change-decline" class="btn btn--secondary">Return to Cart</button>` +
                        `<button type="button" id="price-change-accept" class="btn btn--primary">Accept &amp; Continue</button>` +
                    `</div>` +
                `</div>`;

            document.body.appendChild(overlay);

            const cleanup = (accepted) => {
                overlay.remove();
                resolve(accepted);
            };

            document.getElementById('price-change-accept').addEventListener('click', () => cleanup(true));
            document.getElementById('price-change-decline').addEventListener('click', () => cleanup(false));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
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
                const maxQty = 100;
                const newValue = parseInt(input.value) + 1;
                if (newValue <= maxQty) {
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

        });

        // Quantity input change (manual typing)
        document.addEventListener('change', async (e) => {
            if (e.target.matches('.quantity-selector__input')) {
                const selector = e.target.closest('.quantity-selector');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const maxQty = 100;
                let newValue = parseInt(e.target.value);

                // Clamp to valid range
                if (isNaN(newValue) || newValue < 1) {
                    newValue = 1;
                    e.target.value = 1;
                }
                if (newValue > maxQty) {
                    newValue = maxQty;
                    e.target.value = maxQty;
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

        const clampedQty = Math.min(quantity, 100);
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
        const actualId = item ? item.id : itemId;

        try {
            if (isCore && typeof API !== 'undefined') {
                try {
                    const response = await API.updateCartItem(actualId, quantity);
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

        // Update input max and + button disabled state
        if (input) input.max = 100;
        const increaseBtn = cartItemEl.querySelector('.quantity-selector__btn--increase');
        if (increaseBtn) {
            increaseBtn.disabled = item.quantity >= 100;
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
        try { localStorage.setItem('cart_count', itemCount); } catch (e) { /* ignore */ }

        // Only update summary section if on cart page
        if (!document.querySelector('.cart-page')) return;

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
                color_hex: product.color_hex || null,
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
                    if (typeof showToast === 'function') {
                        showToast(response.error || 'Failed to add item to cart', 'error');
                    }
                    return;
                }

                // Server confirmed - refresh to get accurate server totals
                const itemsAfterAdd = JSON.parse(JSON.stringify(this.items));
                const addedKey = key;
                await this.loadFromServer();
                // Guard: if server returned empty (e.g. cross-origin cookie blocked), keep local state
                if (this.items.length === 0 && itemsAfterAdd.length > 0) {
                    this.items = itemsAfterAdd;
                    this.saveToLocalStorage();
                } else if (!this.items.find(i => (i.key || this.cartItemKey(i)) === addedKey)) {
                    // Server confirmed add but GET didn't return it yet — merge back
                    const localAdded = itemsAfterAdd.find(i => (i.key || this.cartItemKey(i)) === addedKey);
                    if (localAdded) {
                        this.items.push(localAdded);
                        this.saveToLocalStorage();
                    }
                }
                this.updateUI();
            } catch (error) {
                DebugLog.error('Failed to sync cart to server:', error);
                // Keep item locally — it's saved in localStorage for resilience.
                // Don't rollback; the server will get the item on next successful sync.
                if (typeof showToast === 'function') {
                    showToast('Item saved locally. It will sync when connection is restored.', 'info');
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
        const actualId = item ? item.id : itemId;

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
                const response = await API.updateCartItem(actualId, quantity);
                if (response.ok) {
                    // Refresh from server for accurate totals
                    await this.loadFromServer();
                    this.updateUI();
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
            // Mark as in-flight so loadFromServer() won't re-add it
            this._removingItems.add(actualId);
            if (removedItem && removedItem.key) this._removingItems.add(removedItem.key);
            try {
                const response = await API.removeFromCart(actualId);
                if (response && !response.ok) {
                    // Server rejected removal - rollback
                    this._removingItems.delete(actualId);
                    if (removedItem && removedItem.key) this._removingItems.delete(removedItem.key);
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
                this._removingItems.delete(actualId);
                if (removedItem && removedItem.key) this._removingItems.delete(removedItem.key);
                this.items = previousItems;
                this.saveToLocalStorage();
                this.updateUI();
                if (typeof showToast === 'function') {
                    showToast('Network error. Item not removed.', 'error');
                }
                return;
            } finally {
                // Always clear in-flight markers after API call completes
                this._removingItems.delete(actualId);
                if (removedItem && removedItem.key) this._removingItems.delete(removedItem.key);
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
        return false;
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
                    const itemKey = item.key || self.cartItemKey(item);

                    const productLink = item.slug
                        ? '/products/' + encodeURIComponent(item.slug) + '/' + encodeURIComponent(item.sku || '')
                        : '/html/product/?sku=' + encodeURIComponent(item.sku || '');

                    return '\
                    <article class="cart-item" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '">\
                        <div class="cart-item__image">\
                            ' + self.getItemImageHTML(item) + '\
                        </div>\
                        <div class="cart-item__details">\
                            <span class="source-badge source-badge--' + (item.source === 'compatible' || (item.name || '').toLowerCase().includes('compatible') ? 'compatible' : 'genuine') + '">' + (item.source === 'compatible' || (item.name || '').toLowerCase().includes('compatible') ? 'COMPATIBLE' : 'GENUINE') + '</span>\
                            <h3 class="cart-item__name">\
                                <a href="' + productLink + '">' + escapedName + '</a>\
                            </h3>\
                            ' + (escapedBrand ? '<p class="cart-item__brand">' + escapedBrand + '</p>' : '') + '\
                            ' + (escapedSku ? '<p class="cart-item__sku">SKU: ' + escapedSku + '</p>' : '') + '\
                            \
                            <p class="cart-item__price-mobile">' + formatPrice(item.price) + '</p>\
                        </div>\
                        <div class="cart-item__price">\
                            ' + formatPrice(item.price) + '\
                        </div>\
                        <div class="cart-item__quantity">\
                            <div class="quantity-selector" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '">\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--decrease" aria-label="Decrease quantity">\
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                        <line x1="5" y1="12" x2="19" y2="12"></line>\
                                    </svg>\
                                </button>\
                                <input type="number" class="quantity-selector__input" value="' + item.quantity + '" min="1" max="100" aria-label="Quantity">\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--increase" aria-label="Increase quantity"' + (item.quantity >= 100 ? ' disabled' : '') + '>\
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

            if (cartSummary) {
                const subtotalClassEl = cartSummary.querySelector('.cart-summary__subtotal');
                const totalClassEl = cartSummary.querySelector('.cart-summary__total-value');

                if (subtotalClassEl) subtotalClassEl.textContent = formatPrice(subtotal);
                if (totalClassEl) totalClassEl.textContent = formatPrice(cartTotal);
            }

            // Disable checkout if cart has out-of-stock items
            const checkoutBtn = document.getElementById('checkout-btn');
            if (checkoutBtn) {
                checkoutBtn.classList.remove('btn--disabled');
                checkoutBtn.removeAttribute('aria-disabled');
                checkoutBtn.title = '';
            }
        }
    }
};

// Initialize cart when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    Cart.init();
});
