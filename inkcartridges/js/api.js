/**
 * API.JS
 * ======
 * API integration layer for InkCartridges.co.nz
 * Connects frontend to the backend API on Render
 */

const API = {
    /**
     * Get the current access token from Supabase session
     */
    async getToken() {
        if (typeof Auth !== 'undefined' && Auth.session) {
            return Auth.session.access_token;
        }
        return null;
    },

    /**
     * Make an API request
     * @param {string} endpoint - API endpoint (e.g., '/api/products')
     * @param {object} options - Fetch options
     * @returns {Promise<object>} API response data
     */
    async request(endpoint, options = {}) {
        const url = `${Config.API_URL}${endpoint}`;
        const token = await this.getToken();

        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, {
                ...options,
                headers,
                credentials: 'include'  // Required for guest cart cookies
            });

            // Handle rate limiting
            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After') || 60;
                console.warn(`Rate limited. Retry after ${retryAfter}s`);
                throw new Error('Too many requests. Please wait a moment.');
            }

            // Handle unauthorized
            if (response.status === 401) {
                // Token expired - try to refresh
                if (typeof Auth !== 'undefined') {
                    const refreshed = await Auth.refreshSession();
                    if (refreshed) {
                        // Retry with new token
                        headers['Authorization'] = `Bearer ${Auth.session.access_token}`;
                        const retryResponse = await fetch(url, { ...options, headers, credentials: 'include' });
                        return await retryResponse.json();
                    }
                }
                throw new Error('Please sign in to continue.');
            }

            const data = await response.json();

            if (!response.ok) {
                // Log sanitized error info for debugging (never log full response — may contain tokens/PII)
                console.warn('API Error:', response.status, data.error || data.message || 'Unknown error');

                // Return error response instead of throwing for EMAIL_NOT_VERIFIED
                // This allows individual pages to handle verification status appropriately
                if (data.code === 'EMAIL_NOT_VERIFIED') {
                    return { success: false, error: data.error || 'Email not verified', code: 'EMAIL_NOT_VERIFIED' };
                }

                // Build detailed error message
                let errorMsg = data.error || data.message || 'Request failed';
                if (data.details) {
                    if (Array.isArray(data.details)) {
                        errorMsg += ': ' + data.details.map(d => d.message || d).join(', ');
                    } else if (typeof data.details === 'object') {
                        errorMsg += ': ' + JSON.stringify(data.details);
                    } else {
                        errorMsg += ': ' + data.details;
                    }
                }
                throw new Error(errorMsg);
            }

            return data;
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },

    /**
     * GET request helper
     */
    async get(endpoint) {
        return this.request(endpoint, { method: 'GET' });
    },

    /**
     * POST request helper
     */
    async post(endpoint, body) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    },

    /**
     * PUT request helper
     */
    async put(endpoint, body) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
    },

    /**
     * DELETE request helper
     */
    async delete(endpoint) {
        return this.request(endpoint, { method: 'DELETE' });
    },

    // =========================================================================
    // PRODUCTS
    // =========================================================================

    /**
     * Get products with optional filters
     * @param {object} filters - Filter parameters
     */
    async getProducts(filters = {}) {
        const params = new URLSearchParams();

        if (filters.page) params.append('page', filters.page);
        if (filters.limit) params.append('limit', filters.limit || Config.ITEMS_PER_PAGE);
        if (filters.category) params.append('category', filters.category);
        if (filters.brand) params.append('brand', filters.brand);
        if (filters.source) params.append('source', filters.source);
        if (filters.type) params.append('type', filters.type);
        if (filters.color) params.append('color', filters.color);
        if (filters.sort) params.append('sort', filters.sort);
        if (filters.search) params.append('search', filters.search);

        const queryString = params.toString();
        const endpoint = `/api/products${queryString ? '?' + queryString : ''}`;

        return this.get(endpoint);
    },

    /**
     * Get single product by SKU
     * @param {string} sku - Product SKU
     */
    async getProduct(sku) {
        return this.get(`/api/products/${sku}`);
    },

    /**
     * Get products compatible with a printer
     * @param {string} printerSlug - Printer slug
     */
    async getProductsByPrinter(printerSlug) {
        return this.get(`/api/products/printer/${printerSlug}`);
    },

    /**
     * Get auto-generated color packs for a printer
     * @param {string} printerSlug - Printer slug
     * @param {object} [params] - Optional query params (include_unavailable, source)
     */
    async getColorPacks(printerSlug, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = `/api/products/printer/${printerSlug}/color-packs${query ? `?${query}` : ''}`;
        return this.get(url);
    },

    /**
     * Get color pack configuration constants
     */
    async getColorPackConfig() {
        return this.get('/api/color-packs/config');
    },

    // =========================================================================
    // BRANDS
    // =========================================================================

    /**
     * Get all brands
     */
    async getBrands() {
        return this.get('/api/brands');
    },

    // =========================================================================
    // SEARCH
    // =========================================================================

    /**
     * Get search autocomplete suggestions
     * @param {string} query - Search query
     * @param {number} limit - Max suggestions
     */
    async getAutocomplete(query, limit = 8) {
        if (!query || query.length < 2) return { success: true, data: { suggestions: [] } };
        return this.get(`/api/search/autocomplete?q=${encodeURIComponent(query)}&limit=${limit}`);
    },

    /**
     * Search products by part number or name
     * @param {string} query - Search query
     * @param {object} options - Search options
     */
    async searchByPart(query, options = {}) {
        const params = new URLSearchParams({ q: query });
        if (options.type) params.append('type', options.type);
        if (options.limit) params.append('limit', options.limit);
        if (options.page) params.append('page', options.page);

        return this.get(`/api/search/by-part?${params}`);
    },

    /**
     * Search for printers
     * @param {string} query - Search query
     * @param {string} brand - Optional brand filter
     */
    async searchPrinters(query, brand = null) {
        const params = new URLSearchParams({ q: query || '*' });
        if (brand) params.append('brand', brand);

        return this.get(`/api/printers/search?${params}`);
    },

    /**
     * Get all printers for a brand
     * @param {string} brand - Brand slug
     */
    async getPrintersByBrand(brand) {
        return this.get(`/api/printers/search?q=*&brand=${encodeURIComponent(brand)}`);
    },

    /**
     * Get compatible printers for a product
     * @param {string} sku - Product SKU
     */
    async getCompatiblePrinters(sku) {
        return this.get(`/api/search/compatible-printers/${encodeURIComponent(sku)}`);
    },

    // =========================================================================
    // CART (requires authentication)
    // =========================================================================

    /**
     * Get user's cart
     */
    async getCart() {
        return this.get('/api/cart');
    },

    /**
     * Add item to cart
     * @param {string} productId - Product UUID
     * @param {number} quantity - Quantity to add
     */
    async addToCart(productId, quantity = 1) {
        return this.post('/api/cart/items', { product_id: productId, quantity });
    },

    /**
     * Update cart item quantity
     * @param {string} productId - Product UUID
     * @param {number} quantity - New quantity
     */
    async updateCartItem(productId, quantity) {
        return this.put(`/api/cart/items/${productId}`, { quantity });
    },

    /**
     * Remove item from cart
     * @param {string} productId - Product UUID
     */
    async removeFromCart(productId) {
        return this.delete(`/api/cart/items/${productId}`);
    },

    /**
     * Clear entire cart
     */
    async clearCart() {
        return this.delete('/api/cart');
    },

    /**
     * Get cart item count (for header badge)
     */
    async getCartCount() {
        return this.get('/api/cart/count');
    },

    /**
     * Merge guest cart into user cart (call immediately after sign-in)
     */
    async mergeCart() {
        return this.post('/api/cart/merge');
    },

    /**
     * Validate cart before checkout
     */
    async validateCart() {
        return this.post('/api/cart/validate');
    },

    /**
     * Apply a coupon code to the cart
     * @param {string} code - Coupon code
     */
    async applyCoupon(code) {
        return this.post('/api/cart/coupon', { code });
    },

    /**
     * Remove applied coupon from cart
     */
    async removeCoupon() {
        return this.delete('/api/cart/coupon');
    },

    /**
     * Get currently applied coupon
     */
    async getCoupon() {
        return this.get('/api/cart/coupon');
    },

    // =========================================================================
    // ORDERS (requires authentication)
    // =========================================================================

    /**
     * Create a new order
     * @param {object} orderData - Order details
     */
    async createOrder(orderData) {
        return this.post('/api/orders', orderData);
    },

    /**
     * Get user's orders
     * @param {object} options - Pagination options
     */
    async getOrders(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.status) params.append('status', options.status);

        const queryString = params.toString();
        return this.get(`/api/orders${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Get single order by order number
     * @param {string} orderNumber - Order number (e.g., "ORD-ABC123-XYZ")
     */
    async getOrder(orderNumber) {
        return this.get(`/api/orders/${orderNumber}`);
    },

    // =========================================================================
    // USER (requires authentication)
    // =========================================================================

    /**
     * Get user profile
     */
    async getProfile() {
        return this.get('/api/user/profile');
    },

    /**
     * Update user profile
     * @param {object} updates - Profile updates
     */
    async updateProfile(updates) {
        return this.put('/api/user/profile', updates);
    },

    /**
     * Get user's saved addresses
     */
    async getAddresses() {
        return this.get('/api/user/addresses');
    },

    /**
     * Add a new address
     * @param {object} address - Address data
     */
    async addAddress(address) {
        return this.post('/api/user/address', address);
    },

    /**
     * Update an address
     * @param {string} addressId - Address ID
     * @param {object} updates - Address updates
     */
    async updateAddress(addressId, updates) {
        return this.put(`/api/user/address/${addressId}`, updates);
    },

    /**
     * Delete an address
     * @param {string} addressId - Address ID
     */
    async deleteAddress(addressId) {
        return this.delete(`/api/user/address/${addressId}`);
    },

    // =========================================================================
    // USER PRINTERS (requires authentication)
    // =========================================================================

    /**
     * Get user's saved printers
     */
    async getUserPrinters() {
        return this.get('/api/user/printers');
    },

    /**
     * Add a printer to user's saved list
     * @param {object} printer - Printer data (model, brand, slug, nickname)
     */
    async addUserPrinter(printer) {
        return this.post('/api/user/printers', printer);
    },

    /**
     * Update a saved printer
     * @param {string} printerId - Printer ID
     * @param {object} updates - Printer updates
     */
    async updateUserPrinter(printerId, updates) {
        return this.put(`/api/user/printers/${printerId}`, updates);
    },

    /**
     * Delete a saved printer
     * @param {string} printerId - Printer ID
     */
    async deleteUserPrinter(printerId) {
        return this.delete(`/api/user/printers/${printerId}`);
    },

    // =========================================================================
    // USER FAVOURITES (requires authentication)
    // =========================================================================

    /**
     * Get user's favourite products
     */
    async getFavourites() {
        return this.get('/api/user/favourites');
    },

    /**
     * Add product to favourites
     * @param {string} productId - Product UUID
     */
    async addFavourite(productId) {
        return this.post('/api/user/favourites', { product_id: productId });
    },

    /**
     * Remove product from favourites
     * @param {string} productId - Product UUID
     */
    async removeFavourite(productId) {
        return this.delete(`/api/user/favourites/${productId}`);
    },

    /**
     * Sync localStorage favourites on login
     * @param {array} productIds - Array of product UUIDs
     */
    async syncFavourites(productIds) {
        return this.post('/api/user/favourites/sync', { product_ids: productIds });
    },

    /**
     * Check if a product is in user's favourites
     * @param {string} productId - Product UUID
     */
    async checkFavourite(productId) {
        return this.get(`/api/user/favourites/check/${productId}`);
    },

    // =========================================================================
    // USER SAVINGS
    // =========================================================================

    /**
     * Get user's savings summary
     */
    async getUserSavings() {
        return this.get('/api/user/savings');
    },

    // =========================================================================
    // SHIPPING
    // =========================================================================

    /**
     * Get all shipping rates (public)
     */
    async getShippingRates() {
        return this.get('/api/shipping/rates');
    },

    /**
     * Get personalized shipping options for cart
     * @param {object} data - Cart data (cart_total, item_count, postal_code)
     */
    async getShippingOptions(data) {
        return this.post('/api/shipping/options', data);
    },

    // =========================================================================
    // BUSINESS ACCOUNTS
    // =========================================================================

    /**
     * Submit business account application
     * @param {object} data - Application data
     */
    async submitBusinessApplication(data) {
        return this.post('/api/business/apply', data);
    },

    /**
     * Get current business account status
     */
    async getBusinessStatus() {
        return this.get('/api/business/status');
    },

    // =========================================================================
    // NEWSLETTER
    // =========================================================================

    /**
     * Subscribe email to newsletter
     * @param {object} data - { email, source }
     */
    async subscribe(data) {
        return this.post('/api/newsletter/subscribe', data);
    },

    // =========================================================================
    // EMAIL VERIFICATION
    // =========================================================================

    /**
     * Check if user's email is verified
     * @returns {Promise<object>} Verification status
     */
    async getVerificationStatus() {
        return this.get('/api/auth/verification-status');
    },

    /**
     * Resend verification email
     * @returns {Promise<object>} Result
     */
    async resendVerificationEmail() {
        return this.post('/api/auth/resend-verification');
    },

    // =========================================================================
    // CART ANALYTICS
    // =========================================================================

    /**
     * Send a cart analytics event
     * @param {object} event - Event data
     */
    async sendCartEvent(event) {
        return this.post('/api/analytics/cart-event', event);
    },

    /**
     * Get cart analytics summary
     * @param {object} options - Query options (period, etc.)
     */
    async getCartAnalyticsSummary(options = {}) {
        const params = new URLSearchParams();
        if (options.period) params.append('period', options.period);
        if (options.startDate) params.append('start_date', options.startDate);
        if (options.endDate) params.append('end_date', options.endDate);

        const queryString = params.toString();
        return this.get(`/api/analytics/cart-summary${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Get abandoned carts list
     * @param {object} options - Query options
     */
    async getAbandonedCarts(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.minValue) params.append('min_value', options.minValue);

        const queryString = params.toString();
        return this.get(`/api/analytics/abandoned-carts${queryString ? '?' + queryString : ''}`);
    },

    // =========================================================================
    // ADMIN API
    // =========================================================================

    /**
     * Verify admin access
     * @returns {Promise<object>} Admin verification result
     */
    async verifyAdmin() {
        return this.get('/api/admin/verify');
    },

    /**
     * Get admin orders list with filters
     * @param {object} options - Filter options
     */
    async getAdminOrders(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.status) params.append('status', options.status);
        if (options.customerEmail) params.append('customer_email', options.customerEmail);
        if (options.dateFrom) params.append('date_from', options.dateFrom);
        if (options.dateTo) params.append('date_to', options.dateTo);
        if (options.sort) params.append('sort', options.sort);

        const queryString = params.toString();
        return this.get(`/api/admin/orders${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Get single order by ID (admin)
     * @param {string} orderId - Order UUID
     */
    async getAdminOrder(orderId) {
        return this.get(`/api/admin/orders/${orderId}`);
    },

    /**
     * Update order status (admin)
     * @param {string} orderId - Order UUID
     * @param {object} data - Status update data (status, tracking_number, admin_notes)
     */
    async updateOrderStatus(orderId, data) {
        return this.put(`/api/admin/orders/${orderId}`, data);
    },

    /**
     * Get admin products list
     * @param {object} options - Filter options
     */
    async getAdminProducts(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.search) params.append('search', options.search);
        if (options.brand) params.append('brand', options.brand);
        if (options.isActive !== undefined) params.append('is_active', options.isActive);

        const queryString = params.toString();
        return this.get(`/api/admin/products${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Update product (admin) - simple update
     * @param {string} productId - Product UUID
     * @param {object} data - Product update data
     */
    async updateAdminProduct(productId, data) {
        return this.put(`/api/admin/products/${productId}`, data);
    },

    /**
     * Get single product for editing (admin)
     * @param {string} productId - Product UUID
     */
    async getAdminProductById(productId) {
        return this.get(`/api/admin/products/${productId}`);
    },

    /**
     * Upload product image (admin)
     * @param {string} productId - Product UUID
     * @param {File} file - Image file
     */
    async uploadProductImage(productId, file) {
        const url = `${Config.API_URL}/api/admin/products/${productId}/images`;
        const token = await this.getToken();

        const formData = new FormData();
        formData.append('image', file);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });

        return response.json();
    },

    /**
     * Delete product image (admin)
     * @param {string} productId - Product UUID
     * @param {string} imageId - Image UUID
     */
    async deleteProductImage(productId, imageId) {
        return this.delete(`/api/admin/products/${productId}/images/${imageId}`);
    },

    /**
     * Reorder product images (admin)
     * @param {string} productId - Product UUID
     * @param {array} images - Array of {id, sort_order, is_primary}
     */
    async reorderProductImages(productId, images) {
        return this.put(`/api/admin/products/${productId}/images/reorder`, { images });
    },

    /**
     * Get admin analytics overview
     * @param {number} timeRange - Days to analyze (1-365)
     */
    async getAdminAnalyticsOverview(timeRange = 30) {
        return this.get(`/api/admin/analytics/overview?timeRange=${timeRange}`);
    },

    /**
     * Get top products analytics
     * @param {object} options - Filter options
     */
    async getAdminTopProducts(options = {}) {
        const params = new URLSearchParams();
        if (options.metric) params.append('metric', options.metric);
        if (options.productType) params.append('productType', options.productType);
        if (options.compatibilityType) params.append('compatibilityType', options.compatibilityType);
        if (options.days) params.append('days', options.days);
        if (options.limit) params.append('limit', options.limit);

        const queryString = params.toString();
        return this.get(`/api/admin/analytics/top-products${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Get admin customers list with order stats
     * @param {object} options - Filter options (page, limit)
     */
    async getAdminCustomers(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);

        const queryString = params.toString();
        return this.get(`/api/admin/customers${queryString ? '?' + queryString : ''}`);
    },

    // =========================================================================
    // ACCOUNT SYNC (call after every login)
    // =========================================================================

    /**
     * Sync account after login — creates/updates user profile.
     * CRITICAL: Must be called immediately after every successful login.
     */
    async accountSync() {
        return this.post('/api/account/sync');
    },

    /**
     * Get full account info (profile + admin status + email verification)
     */
    async getAccountMe() {
        return this.get('/api/account/me');
    },

    // =========================================================================
    // REVIEWS
    // =========================================================================

    /**
     * Create a product review (user must have purchased the product)
     * @param {object} data - { product_id, rating (1-5), title, body }
     */
    async createReview(data) {
        return this.post('/api/reviews', data);
    },

    /**
     * Get approved reviews for a product
     * @param {string} productId - Product UUID
     */
    async getProductReviews(productId) {
        return this.get(`/api/products/${productId}/reviews`);
    },

    /**
     * Get rating summary for a product
     * @param {string} productId - Product UUID
     */
    async getProductReviewSummary(productId) {
        return this.get(`/api/products/${productId}/reviews/summary`);
    },

    /**
     * Get current user's reviews
     */
    async getUserReviews() {
        return this.get('/api/user/reviews');
    },

    /**
     * Update own review
     * @param {string} reviewId - Review UUID
     * @param {object} data - { rating, title, body }
     */
    async updateReview(reviewId, data) {
        return this.put(`/api/reviews/${reviewId}`, data);
    },

    /**
     * Delete own review
     * @param {string} reviewId - Review UUID
     */
    async deleteReview(reviewId) {
        return this.delete(`/api/reviews/${reviewId}`);
    },

    // =========================================================================
    // COUPONS
    // =========================================================================

    /**
     * Claim the one-time $5 NZD signup coupon (idempotent)
     */
    async claimSignupCoupon() {
        return this.post('/api/coupons/claim-signup');
    },

    /**
     * Get user's coupons
     */
    async getMyCoupons() {
        return this.get('/api/coupons/my');
    },

    /**
     * Redeem a coupon against an order
     * @param {object} data - Coupon redemption data
     */
    async redeemCoupon(data) {
        return this.post('/api/coupons/redeem', data);
    },

    // =========================================================================
    // CONTACT
    // =========================================================================

    /**
     * Submit contact form
     * @param {object} data - { name, email, subject, message }
     */
    async submitContactForm(data) {
        return this.post('/api/contact', data);
    },

    // =========================================================================
    // COMPATIBILITY
    // =========================================================================

    /**
     * Get compatible cartridges for a printer by UUID
     * @param {string} printerId - Printer UUID
     */
    async getCompatibility(printerId) {
        return this.get(`/api/compatibility/${printerId}`);
    },

    // =========================================================================
    // EMAIL VERIFICATION (additional)
    // =========================================================================

    /**
     * Verify email with token (returns session tokens on success)
     * @param {string} token - Verification token
     * @param {string} type - Token type (default: 'email')
     */
    async verifyEmail(token, type = 'email') {
        return this.post('/api/auth/verify-email', { token, type });
    },

    // =========================================================================
    // HEALTH CHECK
    // =========================================================================

    /**
     * Check if API is available
     */
    async healthCheck() {
        try {
            const response = await fetch(`${Config.API_URL}/health`);
            return response.ok;
        } catch {
            return false;
        }
    }
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================

/**
 * Format price as NZD currency
 * @param {number} price - Price value
 * @returns {string} Formatted price
 */
function formatPrice(price) {
    return new Intl.NumberFormat(Config.LOCALE, {
        style: 'currency',
        currency: Config.CURRENCY
    }).format(price);
}

/**
 * Get stock status display
 * @param {object} product - Product object
 * @returns {object} Status with class and text
 */
function getStockStatus(product) {
    if (!product.in_stock) {
        return { class: 'out-of-stock', text: 'Out of Stock', icon: 'x-circle' };
    }
    if (product.is_low_stock) {
        return { class: 'low-stock', text: `Low Stock - Only ${product.stock_quantity} left`, icon: 'alert-triangle' };
    }
    return { class: 'in-stock', text: 'In Stock', icon: 'check-circle' };
}

/**
 * Get source badge
 * @param {string} source - Product source (genuine/compatible)
 * @returns {object} Badge info
 */
function getSourceBadge(source) {
    if (source === 'genuine') {
        return { class: 'badge-genuine', text: 'Genuine' };
    }
    if (source === 'compatible') {
        return { class: 'badge-compatible', text: 'Compatible' };
    }
    return null;
}

// Make API available globally
window.API = API;
window.formatPrice = formatPrice;
window.getStockStatus = getStockStatus;
window.getSourceBadge = getSourceBadge;
