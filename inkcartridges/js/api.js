/**
 * API.JS
 * ======
 * API integration layer for InkCartridges.co.nz
 * Connects frontend to the backend API on Render
 */

const API = {
    /**
     * Default request timeout in milliseconds
     */
    REQUEST_TIMEOUT_MS: 15000,

    /**
     * Guest session ID — persisted in localStorage to survive cross-origin cookie blocking.
     * The backend returns this in response bodies and the X-Guest-Session header.
     * We send it back via X-Guest-Session on every request.
     */
    GUEST_SESSION_KEY: 'ink_guest_session_id',

    getGuestSessionId() {
        try { return localStorage.getItem(this.GUEST_SESSION_KEY); } catch (e) { return null; }
    },

    setGuestSessionId(id) {
        if (!id) return;
        try { localStorage.setItem(this.GUEST_SESSION_KEY, id); } catch (e) { /* ignore */ }
    },

    clearGuestSessionId() {
        try { localStorage.removeItem(this.GUEST_SESSION_KEY); } catch (e) { /* ignore */ }
    },

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
     * Shared fetch helper with timeout, 429 retry, and 401 token refresh.
     * Used by both request() and uploadProductImage().
     *
     * @param {string} url - Full URL to fetch
     * @param {object} fetchOptions - Options passed to fetch()
     * @param {object} opts - Extra options
     * @param {number} opts.timeoutMs - Timeout in ms (default: REQUEST_TIMEOUT_MS)
     * @param {boolean} opts.isRetry - Whether this is already a retry (prevents infinite loops)
     * @returns {Promise<Response>} The fetch Response object
     */
    MAX_AUTH_RETRIES: 2,
    MAX_RATE_LIMIT_RETRIES: 2,

    async _fetchWithAuth(url, fetchOptions = {}, opts = {}) {
        const timeoutMs = opts.timeoutMs || this.REQUEST_TIMEOUT_MS;
        const retryCount = opts.retryCount || 0;
        const rateLimitRetry = opts.rateLimitRetry || 0;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const method = (fetchOptions.method || 'GET').toUpperCase();
            const cacheMode = method === 'GET' ? 'default' : 'no-store';
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal,
                credentials: 'include',
                cache: cacheMode
            });
            clearTimeout(timeoutId);

            // Handle rate limiting — only retry idempotent GET requests (never retry mutations)
            if (response.status === 429) {
                const method = (fetchOptions.method || 'GET').toUpperCase();
                if (method === 'GET' && rateLimitRetry < this.MAX_RATE_LIMIT_RETRIES) {
                    const retryAfter = response.headers.get('Retry-After');
                    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, rateLimitRetry);
                    DebugLog.warn(`Rate limited on ${url}, retrying in ${delay}ms (attempt ${rateLimitRetry + 1})`);
                    await new Promise(r => setTimeout(r, delay));
                    return this._fetchWithAuth(url, fetchOptions, { ...opts, rateLimitRetry: rateLimitRetry + 1 });
                }
                DebugLog.warn(`Rate limited on ${url}${method !== 'GET' ? ' (non-GET, not retrying)' : ', max retries exceeded'}`);
                throw new Error('Too many requests. Please wait a moment.');
            }

            // Handle unauthorized — refresh token and retry with backoff
            if (response.status === 401 && retryCount < this.MAX_AUTH_RETRIES) {
                if (typeof Auth !== 'undefined') {
                    // Backoff: 500ms, 1000ms
                    const delay = 500 * (retryCount + 1);
                    await new Promise(r => setTimeout(r, delay));

                    const refreshed = await Auth.refreshSession();
                    if (refreshed) {
                        const headers = fetchOptions.headers instanceof Headers
                            ? new Headers(fetchOptions.headers)
                            : { ...fetchOptions.headers };
                        if (headers instanceof Headers) {
                            headers.set('Authorization', `Bearer ${Auth.session.access_token}`);
                        } else {
                            headers['Authorization'] = `Bearer ${Auth.session.access_token}`;
                        }
                        return this._fetchWithAuth(url, { ...fetchOptions, headers }, { timeoutMs, retryCount: retryCount + 1 });
                    }
                }
                throw new Error('Please sign in to continue.');
            }

            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out. Please check your connection and try again.');
            }
            throw error;
        }
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

        // Send guest session ID via header (survives cross-origin cookie blocking)
        const guestSession = this.getGuestSessionId();
        if (!token && guestSession) {
            headers['X-Guest-Session'] = guestSession;
        }

        try {
            const response = await this._fetchWithAuth(url, { ...options, headers });

            // Capture guest session ID from response header
            const respSessionId = response.headers.get('X-Guest-Session');
            if (respSessionId) {
                this.setGuestSessionId(respSessionId);
            }

            // Handle 204 No Content — DELETE endpoints return no body
            if (response.status === 204) {
                return { ok: true, data: null };
            }

            // Parse JSON safely — gateway errors (502/503/504) may return HTML
            let data;
            try {
                data = await response.json();
            } catch (_jsonErr) {
                const status = response.status;
                if (status >= 500) {
                    throw new Error('The server is temporarily unavailable. Please try again in a moment.');
                }
                throw new Error(`Unexpected response from server (HTTP ${status}).`);
            }

            // Normalize backend envelope: { ok, data, meta, error: { code, message, details } }
            // Map pagination from top-level meta into data for backward compat
            if (data.meta && data.data && typeof data.data === 'object') {
                data.data.pagination = data.meta;
            }

            // Check both HTTP status and envelope ok field
            const isError = !response.ok || data.ok === false;

            if (isError) {
                // Extract error info from structured error object
                const err = data.error || {};
                const errorCode = (typeof err === 'object' && err !== null) ? err.code : data.code;
                const errorMsg = (typeof err === 'object' && err !== null) ? (err.message || 'Unknown error') : (err || data.message || 'Unknown error');
                const errorDetails = (typeof err === 'object' && err !== null) ? err.details : data.details;

                DebugLog.warn('API Error:', response.status, errorMsg);

                // Return error response instead of throwing for specific codes
                // so callers can handle them with targeted UI
                if (errorCode === 'EMAIL_NOT_VERIFIED') {
                    return { ok: false, error: errorMsg, code: 'EMAIL_NOT_VERIFIED' };
                }
                if (errorCode === 'DISPOSABLE_EMAIL') {
                    return { ok: false, error: errorMsg, code: 'DISPOSABLE_EMAIL' };
                }
                if (errorCode === 'ACCOUNT_FLAGGED') {
                    return { ok: false, error: errorMsg, code: 'ACCOUNT_FLAGGED' };
                }

                // Return 409 conflicts with code so callers can handle them
                if (response.status === 409 && errorCode) {
                    return { ok: false, error: errorMsg, code: errorCode, data: data };
                }

                // Return order/payment errors with code so callers can show specific messages
                if (errorCode === 'ORDER_DB_ERROR' || errorCode === 'PAYMENT_ERROR' || errorCode === 'ORDER_TOTAL_TOO_LOW') {
                    return { ok: false, error: errorMsg, code: errorCode };
                }

                // Return validation errors with details so callers can show per-field messages
                if (errorCode === 'VALIDATION_FAILED') {
                    return { ok: false, error: errorMsg, code: errorCode, details: errorDetails };
                }


                // Return rate limit errors with retry_after so callers can handle them
                if (response.status === 429 || errorCode === 'RATE_LIMITED') {
                    return { ok: false, error: errorMsg, code: 'RATE_LIMITED', retry_after: data.retry_after };
                }

                // Build detailed error message
                let fullMsg = errorMsg;
                if (errorDetails) {
                    if (Array.isArray(errorDetails)) {
                        fullMsg += ': ' + errorDetails.map(d => d.message || d).join(', ');
                    } else if (typeof errorDetails === 'object') {
                        fullMsg += ': ' + JSON.stringify(errorDetails);
                    } else {
                        fullMsg += ': ' + errorDetails;
                    }
                }
                throw new Error(fullMsg);
            }

            // Capture guest session ID from response body (fallback to header)
            if (data.data && data.data.guest_session_id) {
                this.setGuestSessionId(data.data.guest_session_id);
            }

            return data;
        } catch (error) {
            DebugLog.error('API Error:', error);
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
    // SWR (stale-while-revalidate) in-memory cache for catalog GETs
    // =========================================================================

    _swrCache: new Map(),
    _swrInflight: new Map(),
    SWR_TTL_MS: 60000,

    /**
     * Fetch an endpoint with stale-while-revalidate semantics.
     * - Fresh cache hit (< ttl): returns cached data synchronously (via resolved promise).
     * - Stale cache hit: returns cached data AND kicks off a background refresh.
     * - Miss: awaits the network, caches, returns.
     * Mutations (POST/PUT/etc.) do not use this — only use for idempotent GET endpoints.
     */
    _swrClone(data) {
        try { return typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data)); }
        catch (e) { return data; }
    },

    async getWithSWR(endpoint, { ttl = this.SWR_TTL_MS } = {}) {
        const now = Date.now();
        const cached = this._swrCache.get(endpoint);

        if (cached && (now - cached.timestamp) < ttl) {
            return this._swrClone(cached.data);
        }

        if (cached) {
            // Stale — return stale immediately, revalidate in background (dedupe concurrent).
            if (!this._swrInflight.has(endpoint)) {
                const p = this.get(endpoint)
                    .then(fresh => {
                        this._swrCache.set(endpoint, { data: fresh, timestamp: Date.now() });
                        try {
                            window.dispatchEvent(new CustomEvent('swr:update', { detail: { endpoint, data: fresh } }));
                        } catch (e) { /* ignore */ }
                        return fresh;
                    })
                    .catch(() => { /* keep stale on failure */ })
                    .finally(() => this._swrInflight.delete(endpoint));
                this._swrInflight.set(endpoint, p);
            }
            return this._swrClone(cached.data);
        }

        // Miss — dedupe concurrent misses too.
        let inflight = this._swrInflight.get(endpoint);
        if (!inflight) {
            inflight = this.get(endpoint)
                .then(data => {
                    this._swrCache.set(endpoint, { data, timestamp: Date.now() });
                    return data;
                })
                .finally(() => this._swrInflight.delete(endpoint));
            this._swrInflight.set(endpoint, inflight);
        }
        return inflight;
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

        return this.getWithSWR(endpoint);
    },

    /**
     * Get shop data (products, series codes, category counts) in a single call
     * @param {Object} params - Query parameters
     */
    async getShopData(params = {}) {
        const qs = new URLSearchParams();
        if (params.brand) qs.append('brand', params.brand);
        if (params.category) qs.append('category', params.category);
        if (params.source) qs.append('source', params.source);
        if (params.page) qs.append('page', params.page);
        if (params.limit) qs.append('limit', params.limit);
        if (params.search) qs.append('search', params.search);
        if (params.code) qs.append('code', params.code);
        if (params.color) qs.append('color', params.color);
        if (params.sort) qs.append('sort', params.sort);
        return this.getWithSWR(`/api/shop?${qs.toString()}`);
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
     * Get related products for a given SKU
     * @param {string} sku - Product SKU
     */
    async getRelatedProducts(sku) {
        return this.get(`/api/products/${encodeURIComponent(sku)}/related`);
    },

    /**
     * Get frequently bought together products for a given SKU
     * @param {string} sku - Product SKU
     */
    async getBoughtTogether(sku) {
        return this.get(`/api/products/${encodeURIComponent(sku)}/bought-together`);
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
    // RIBBONS
    // =========================================================================

    /**
     * Get ribbon device brands with counts
     * @param {object} params - Optional { type }
     */
    async getRibbonDeviceBrands(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/ribbons/device-brands${query ? '?' + query : ''}`);
    },

    /**
     * Get ribbon device models (filtered by printer_brand)
     * @param {object} params - { printer_brand }
     */
    async getRibbonDeviceModels(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/ribbons/device-models${query ? '?' + query : ''}`);
    },

    /**
     * Get distinct ribbon brands for filter dropdowns
     * @param {object} params - Optional { type }
     */
    async getRibbonBrands(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/ribbons/brands${query ? '?' + query : ''}`);
    },

    /**
     * Get ribbon device brands from ribbon_brands table (Supabase REST direct)
     * Returns array of { id, name, slug, image_url, sort_order }
     * Uses direct fetch to avoid Auth timing issues on page load.
     */
    async getRibbonBrandsList() {
        try {
            const url = `${Config.SUPABASE_URL}/rest/v1/ribbon_brands?is_active=eq.true&order=sort_order.asc&select=id,name,slug,image_url,sort_order`;
            const resp = await fetch(url, {
                headers: {
                    'apikey': Config.SUPABASE_ANON_KEY,
                    'Accept': 'application/json',
                },
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            return { ok: true, data: { brands: data || [] } };
        } catch (e) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('[API] getRibbonBrandsList failed:', e.message);
            return { ok: false, data: { brands: [] } };
        }
    },

    /**
     * Get ribbons by device brand slug via Supabase RPC (bypasses broken backend filter)
     */
    async getRibbonsByBrand(brandSlug) {
        try {
            const url = `${Config.SUPABASE_URL}/rest/v1/rpc/get_ribbons_by_brand`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'apikey': Config.SUPABASE_ANON_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ brand_slug: brandSlug }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            return { ok: true, data: { products: data || [] } };
        } catch (e) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('[API] getRibbonsByBrand failed:', e.message);
            return { ok: false, data: { products: [] } };
        }
    },

    /**
     * Get distinct ribbon models for filter dropdowns
     * @param {object} params - Optional { brand, type }
     */
    async getRibbonModels(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/ribbons/models${query ? '?' + query : ''}`);
    },

    /**
     * Get ribbons with optional filters
     * @param {object} params - Filter parameters (printer_brand, printer_model, brand, type, color, search, sort, page, limit)
     */
    async getRibbons(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/ribbons${query ? '?' + query : ''}`);
    },

    /**
     * Get single ribbon by SKU
     * @param {string} sku - Ribbon SKU
     */
    async getRibbon(sku) {
        return this.get(`/api/ribbons/${encodeURIComponent(sku)}`);
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
        if (!query || query.length < 2) return { ok: true, data: { suggestions: [] } };
        return this.get(`/api/search/suggest?q=${encodeURIComponent(query)}&limit=${limit}`);
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

    async searchPrintersBulk(queries) {
        return this.post('/api/printers/search/bulk', { queries });
    },

    /**
     * Smart search - returns product cards for autocomplete dropdown
     * @param {string} query - Search query
     * @param {number} limit - Max results (default 48)
     */
    async smartSearch(query, limit = 48) {
        if (!query || query.length < 1) {
            return { ok: true, data: { products: [], total: 0 } };
        }
        const endpoint = (typeof searchConfig !== 'undefined' ? searchConfig.apiUrl : '/api/search/smart')
            + '?q=' + encodeURIComponent(query) + '&limit=' + limit;
        return this.get(endpoint);
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

    /**
     * Search cartridges by printer name/model
     * @param {string} query - Printer name or model query
     * @param {object} options - { limit, page }
     */
    async searchByPrinter(query, options = {}) {
        const params = new URLSearchParams({ q: query });
        if (options.limit) params.append('limit', options.limit);
        if (options.page) params.append('page', options.page);
        return this.get(`/api/search/by-printer?${params}`);
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
        const result = await this.delete('/api/cart');
        this.clearGuestSessionId();
        return result;
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
        const result = await this.post('/api/cart/merge');
        this.clearGuestSessionId();
        return result;
    },

    /**
     * Validate cart before checkout
     */
    async validateCart(turnstileToken, acknowledgePriceChanges) {
        const body = {};
        if (turnstileToken) body.turnstile_token = turnstileToken;
        if (acknowledgePriceChanges) body.acknowledge_price_changes = true;
        return this.post('/api/cart/validate', body);
    },

    /**
     * Validate an email address before signup (blocks disposable emails)
     * @param {string} email - Email to validate
     */
    async validateEmail(email) {
        return this.post('/api/account/validate-email', { email });
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

    /**
     * Get the user's loyalty stamp card (current cycle)
     */
    async getStampCard() {
        return this.get('/api/user/stamp-card');
    },

    /**
     * Get all earned loyalty coupons across cycles
     */
    async getLoyaltyCoupons() {
        return this.get('/api/user/loyalty-coupons');
    },

    /**
     * Get admin-granted personal coupons for the logged-in user
     * (coupons where email_restrictions includes the user's email)
     */
    async getPersonalCoupons() {
        return this.get('/api/user/coupons');
    },

    // =========================================================================
    // CHECKOUT HELPERS
    // =========================================================================

    /**
     * Prefill returning guest's name/address from shadow_accounts.
     * Non-blocking — returns null on failure so checkout continues normally.
     * @param {string} email - Guest email
     * @returns {Promise<object|null>} { first_name, last_name, address_line1, city, ... } or null
     */
    async guestPrefill(email) {
        try {
            return await this.post('/api/checkout/guest-prefill', { email });
        } catch {
            return null;
        }
    },

    // =========================================================================
    // ADDRESS AUTOCOMPLETE
    // =========================================================================

    /**
     * NZ Post address suggestions (primary for NZ addresses)
     * @param {string} query - Address search text
     * @param {number} max - Max results (default 5)
     */
    async nzpostSuggest(query, max = 5) {
        return this.get(`/api/address/nzpost/suggest?q=${encodeURIComponent(query)}&max=${max}`);
    },

    /**
     * NZ Post full address details by DPID
     * @param {string} dpid - NZ Post DPID identifier
     */
    async nzpostDetails(dpid) {
        return this.get(`/api/address/nzpost/details?dpid=${encodeURIComponent(dpid)}`);
    },

    /**
     * Google Places address autocomplete (fallback when NZ Post is unavailable)
     */
    async addressAutocomplete(query) {
        return this.get(`/api/address/autocomplete?q=${encodeURIComponent(query)}`);
    },

    /**
     * Google Place details by place_id
     */
    async addressDetails(placeId) {
        return this.get(`/api/address/details?place_id=${encodeURIComponent(placeId)}`);
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

    async getRecentTracking() {
        return this.get('/api/orders/recent-tracking');
    },

    async getOrderTracking(orderNumber) {
        return this.get(`/api/orders/track/${encodeURIComponent(orderNumber)}`);
    },

    /**
     * Check for a recent pending order (checkout timeout recovery)
     * Call when order creation times out to check if order was actually created
     */
    async checkPendingOrder() {
        return this.get('/api/orders/check-pending');
    },

    /**
     * Cancel a pending order (e.g. after payment failure)
     * @param {string} orderNumber - Order number to cancel
     */
    async cancelOrder(orderNumber) {
        return this.post(`/api/orders/${orderNumber}/cancel`);
    },

    /**
     * Capture a PayPal payment after user approval
     * @param {string} orderNumber - Order number (e.g., "ORD-ABC123-XYZ")
     * @param {string} paypalOrderId - PayPal order ID from createOrder response
     */
    async capturePaypal(orderNumber, paypalOrderId) {
        return this.post(`/api/orders/${orderNumber}/capture-paypal`, {
            paypal_order_id: paypalOrderId
        });
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

    async getEmailPreferences() {
        return this.get('/api/user/email-preferences');
    },

    async updateEmailPreferences(prefs) {
        return this.put('/api/user/email-preferences', prefs);
    },

    async resubscribeEmail(type) {
        return this.post('/api/user/email-preferences/resubscribe', { type });
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
     * Get shipping options for cart (weight-based rates from backend)
     * @param {object} data - { cart_total, items: [{product_id, quantity}], region, delivery_type }
     */
    async getShippingOptions(data) {
        return this.post('/api/shipping/options', data);
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

    async getSettings() {
        return this.request('/api/settings', { method: 'GET' });
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
        if (options.search) params.append('search', options.search);
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
     * Get order events / audit trail (admin)
     * @param {string} orderId - Order UUID
     */
    async getAdminOrderEvents(orderId) {
        return this.get(`/api/admin/orders/${orderId}/events`);
    },

    /**
     * Add a note/event to an order (admin)
     * @param {string} orderId - Order UUID
     * @param {object} data - { type, payload: { note } }
     */
    async createAdminOrderEvent(orderId, data) {
        return this.post(`/api/admin/orders/${orderId}/events`, data);
    },

    // =========================================================================
    // ADMIN REFUNDS
    // =========================================================================

    /**
     * Get refunds list (admin)
     * @param {object} options - { page, limit, dateFrom, dateTo, type, status, search }
     */
    async getAdminRefunds(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.dateFrom) params.append('dateFrom', options.dateFrom);
        if (options.dateTo) params.append('dateTo', options.dateTo);
        if (options.type) params.append('type', options.type);
        if (options.status) params.append('status', options.status);
        if (options.search) params.append('search', options.search);

        const queryString = params.toString();
        return this.get(`/api/admin/refunds${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Create a refund or chargeback (admin)
     * @param {object} data - { order_id, type, amount, reason_code, reason_note }
     */
    async createAdminRefund(data) {
        return this.post('/api/admin/refunds', data);
    },

    /**
     * Update refund status (admin)
     * @param {string} refundId - Refund UUID
     * @param {object} data - { status }
     */
    async updateAdminRefund(refundId, data) {
        return this.put(`/api/admin/refunds/${refundId}`, data);
    },

    // =========================================================================
    // ADMIN EXPORT
    // =========================================================================

    /**
     * Export data as CSV (admin)
     * @param {string} type - Export type ('orders' or 'refunds')
     * @param {object} options - { from, to, statuses }
     */
    async getAdminExport(type, options = {}) {
        const params = new URLSearchParams();
        if (options.from) params.append('from', options.from);
        if (options.to) params.append('to', options.to);
        if (options.statuses) params.append('statuses', options.statuses);

        const queryString = params.toString();
        const url = `${Config.API_URL}/api/admin/export/${type}${queryString ? '?' + queryString : ''}`;
        const token = await this.getToken();

        const response = await this._fetchWithAuth(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });

        if (!response.ok) throw new Error(`Export failed: ${response.status}`);

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${type}-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        return true;
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

        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // Use shared helper — handles timeout, 429 retry, and 401 refresh
        // Use longer timeout for file uploads (30s)
        const response = await this._fetchWithAuth(url, {
            method: 'POST',
            headers,
            body: formData
        }, { timeoutMs: 30000 });

        const data = await response.json();
        if (!response.ok) {
            const err = data.error || {};
            const msg = (typeof err === 'object' && err !== null) ? (err.message || 'Image upload failed') : (err || data.message || 'Image upload failed');
            throw new Error(msg);
        }
        return data;
    },

    /**
     * Delete product (admin)
     * @param {string} productId - Product UUID
     */
    async deleteProduct(productId) {
        return this.delete(`/api/admin/products/${productId}`);
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
     * @param {object} options - Filter options (page, limit, search, sort, order)
     */
    async getAdminCustomers(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.search) params.append('search', options.search);
        if (options.sort) params.append('sort', options.sort);
        if (options.order) params.append('order', options.order);

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
    async accountSync(turnstileToken) {
        const body = {};
        if (turnstileToken) body.turnstile_token = turnstileToken;
        return this.post('/api/account/sync', body);
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
    async getProductReviews(productId, params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.get(`/api/products/${productId}/reviews${query ? `?${query}` : ''}`);
    },

    /**
     * Get aggregate review summary for a product (average_rating, review_count, distribution).
     * Separate endpoint from the list — not embedded in getProductReviews.
     */
    async getReviewSummary(productId) {
        return this.get(`/api/products/${productId}/reviews/summary`);
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

    // Signup coupon endpoints removed — only promotional coupons (via cart) remain

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
    // ADMIN REVIEWS
    // =========================================================================

    /**
     * Get all reviews for moderation (admin)
     * @param {object} options - { page, limit, status }
     */
    async getAdminReviews(options = {}) {
        const params = new URLSearchParams();
        if (options.page) params.append('page', options.page);
        if (options.limit) params.append('limit', options.limit);
        if (options.status) params.append('status', options.status);

        const queryString = params.toString();
        return this.get(`/api/admin/reviews${queryString ? '?' + queryString : ''}`);
    },

    /**
     * Moderate a review (approve/reject)
     * @param {string} reviewId - Review UUID
     * @param {object} data - { status: 'approved'|'rejected', admin_notes }
     */
    async moderateReview(reviewId, data) {
        return this.put(`/api/admin/reviews/${reviewId}`, data);
    },

    // =========================================================================
    // ADMIN PRODUCT DIAGNOSTICS & BULK OPS
    // =========================================================================

    /**
     * Get product diagnostics (admin - super_admin/stock_manager only)
     */
    async getAdminProductDiagnostics() {
        return this.get('/api/admin/products/diagnostics');
    },

    /**
     * Bulk activate products (admin - super_admin/stock_manager only)
     * @param {object} data - { product_ids, activate_all, dry_run }
     */
    async bulkActivateProducts(data) {
        return this.post('/api/admin/products/bulk-activate', data);
    },

    /**
     * Update product by SKU (admin - super_admin/stock_manager only)
     * @param {string} sku - Product SKU
     * @param {object} data - { retail_price, stock_quantity, is_active }
     */
    async updateProductBySku(sku, data) {
        return this.put(`/api/admin/products/by-sku/${encodeURIComponent(sku)}`, data);
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
    },

    // =========================================================================
    // BUSINESS ACCOUNTS
    // =========================================================================

    /**
     * Submit business account application
     * @param {object} data - { company_name, nzbn, contact_name, contact_email, contact_phone, estimated_monthly_spend, industry }
     */
    async applyBusiness(data) {
        return this.post('/api/business/apply', data);
    },

    /**
     * Get business account status
     */
    async getBusinessStatus() {
        return this.get('/api/business/status');
    },

    /**
     * Get B2B dashboard data (credit limit, amount due, pricing tier)
     */
    async getBusinessDashboard() {
        return this.get('/api/business/dashboard');
    },

    /**
     * Get B2B invoices
     * @param {object} opts - { status: 'unpaid'|'paid', page, limit }
     */
    async getBusinessInvoices(opts = {}) {
        const params = new URLSearchParams();
        if (opts.status) params.set('status', opts.status);
        if (opts.page) params.set('page', opts.page);
        if (opts.limit) params.set('limit', opts.limit);
        const qs = params.toString();
        return this.get(`/api/business/invoices${qs ? '?' + qs : ''}`);
    },

    /**
     * Get top 5 previously purchased items for quick reorder
     */
    async getBusinessReorderItems() {
        return this.get('/api/business/reorder-items');
    },

    /**
     * Upload credit reference document for Net 30 application
     * @param {File} file - PDF, JPG, or PNG file
     */
    async uploadCreditReference(file) {
        const url = `${Config.API_URL}/api/business/credit-reference`;
        const token = await this.getToken();

        const formData = new FormData();
        formData.append('file', file);

        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await this._fetchWithAuth(url, {
            method: 'POST',
            headers,
            body: formData
        }, { timeoutMs: 30000 });

        const data = await response.json();
        if (!response.ok) {
            const err = data.error || {};
            const msg = (typeof err === 'object' && err !== null) ? (err.message || 'File upload failed') : (err || data.message || 'File upload failed');
            throw new Error(msg);
        }
        return data;
    },

    // =========================================================================
    // Customer P2 wrappers — waitlist, product counts, product series
    // =========================================================================

    /** Back-in-stock waitlist: subscribe. Auth optional (guest passes {email}). */
    async waitlistSubscribe(sku, body = {}) {
        return this.post(`/api/products/${encodeURIComponent(sku)}/waitlist`, body);
    },
    async waitlistUnsubscribe(sku) {
        return this.delete(`/api/products/${encodeURIComponent(sku)}/waitlist`);
    },
    async waitlistStatus(sku) {
        return this.get(`/api/products/${encodeURIComponent(sku)}/waitlist/status`);
    },
    async getAccountWaitlist() {
        return this.get('/api/account/waitlist');
    },

    /** Filter-badge counts per filter option. Uses same query params as /products. */
    async getProductCounts(filters = {}) {
        const qs = new URLSearchParams(filters).toString();
        return this.get(`/api/products/counts${qs ? '?' + qs : ''}`);
    },

    /** Other colors / variants sharing a series code. */
    async getProductSeries(code) {
        return this.get(`/api/products/series/${encodeURIComponent(code)}`);
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
    if (price == null) return '';
    return new Intl.NumberFormat(Config.LOCALE, {
        style: 'currency',
        currency: Config.CURRENCY
    }).format(price);
}

/**
 * Extract GST from a GST-inclusive amount.
 * Uses the rate from Config.settings if available, otherwise defaults to 15% NZ GST.
 * Formula: GST = inclusive_amount * rate / (1 + rate)
 * @param {number} inclusiveAmount - Total amount including GST
 * @returns {number} The GST component
 */
function calculateGST(inclusiveAmount) {
    if (inclusiveAmount == null || isNaN(inclusiveAmount)) return 0;
    const rate = (typeof Config !== 'undefined' && Config.settings?.GST_RATE != null)
        ? Config.settings.GST_RATE
        : 0.15;
    return inclusiveAmount * rate / (1 + rate);
}

/**
 * Get stock status display
 * @param {object} product - Product object
 * @returns {object} Status with class and text
 */
function getStockStatus(product) {
    // Use stock_status from API if available (in_stock / contact_us / out_of_stock)
    if (product.stock_status === 'contact_us') {
        return { class: 'contact-us', text: 'Contact Us for Stock Inquiry', icon: 'phone' };
    }
    if (product.stock_status === 'out_of_stock') {
        return { class: 'out-of-stock', text: 'Out of Stock', icon: 'x-circle' };
    }
    if (product.stock_status === 'in_stock') {
        return { class: 'in-stock', text: 'In Stock', icon: 'check-circle' };
    }
    // Fallback for endpoints that don't return stock_status (listing, search)
    const inStock = product.in_stock !== undefined ? product.in_stock : (product.stock_quantity > 0);
    if (!inStock) {
        // Genuine products with 0 stock → contact us (supplier may restock)
        if (product.source === 'genuine') {
            return { class: 'contact-us', text: 'Contact Us for Stock Inquiry', icon: 'phone' };
        }
        return { class: 'out-of-stock', text: 'Out of Stock', icon: 'x-circle' };
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
        return { class: 'badge-genuine', text: 'Genuine OEM' };
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
