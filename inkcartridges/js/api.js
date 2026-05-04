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

                // Stock-conflict — caller renders inline message on the line item
                if (errorCode === 'STOCK_INSUFFICIENT') {
                    return { ok: false, error: errorMsg, code: errorCode, details: errorDetails };
                }

                // Forbidden — caller decides between "verify email", "B2B only",
                // or generic deny. Backend's specific code wins when present.
                if (response.status === 403 || errorCode === 'FORBIDDEN') {
                    return { ok: false, error: errorMsg, code: errorCode || 'FORBIDDEN' };
                }

                // Unauthorized — caller redirects to login
                if (response.status === 401 || errorCode === 'UNAUTHORIZED') {
                    return { ok: false, error: errorMsg, code: 'UNAUTHORIZED' };
                }

                // Not found — caller may show "Couldn't find that product/order"
                if (response.status === 404 || errorCode === 'NOT_FOUND') {
                    return { ok: false, error: errorMsg, code: 'NOT_FOUND' };
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
     * Map a backend `{ ok: false, code, error, details }` response (or a thrown
     * Error with .code) to a friendly user-facing { message, action } pair.
     * Spec §6 lists the canonical codes; this helper centralises the mapping
     * so callers don't repeat the same switch in every page controller.
     *
     * @param {object|Error} errorOrResponse
     * @returns {{ code: string, message: string, action?: string, retry_after?: number, details?: any[] }}
     */
    mapError(errorOrResponse) {
        if (!errorOrResponse) {
            return { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
        }
        const code = errorOrResponse.code
            || (errorOrResponse.error && errorOrResponse.error.code)
            || 'INTERNAL_ERROR';
        const fallbackMessage = errorOrResponse.message
            || (typeof errorOrResponse.error === 'string' ? errorOrResponse.error : null)
            || (errorOrResponse.error && errorOrResponse.error.message)
            || 'Something went wrong. Please try again.';

        switch (code) {
            case 'VALIDATION_FAILED':
                return {
                    code,
                    message: fallbackMessage,
                    details: errorOrResponse.details || (errorOrResponse.error && errorOrResponse.error.details),
                    action: 'inline-field-errors',
                };
            case 'NOT_FOUND':
                return {
                    code,
                    message: "We couldn't find what you were looking for.",
                    action: 'back-to-shop',
                };
            case 'UNAUTHORIZED':
                return { code, message: 'Please sign in to continue.', action: 'login' };
            case 'FORBIDDEN':
                return { code, message: fallbackMessage || 'You don’t have permission to do that.' };
            case 'RATE_LIMITED':
                return {
                    code,
                    message: 'Slow down for a sec — try again in a minute.',
                    retry_after: errorOrResponse.retry_after,
                    action: 'retry-later',
                };
            case 'STOCK_INSUFFICIENT':
                return {
                    code,
                    message: 'Stock dropped while you were shopping. Adjust the quantity to continue.',
                    details: errorOrResponse.details,
                    action: 'reduce-quantity',
                };
            case 'EMAIL_NOT_VERIFIED':
                return {
                    code,
                    message: 'Please verify your email to use this feature.',
                    action: 'resend-verification',
                };
            case 'IDEMPOTENCY_CONFLICT':
                return {
                    code,
                    message: 'This action was already completed.',
                    action: 'treat-as-success',
                };
            case 'INTERNAL_ERROR':
            default:
                return { code, message: fallbackMessage };
        }
    },

    /**
     * Show a toast (or fall back to alert) for a backend error response.
     * Use when you don't have a dedicated inline display target — e.g. cross-page
     * cart mutations, login-required actions, idempotency conflicts.
     */
    showError(errorOrResponse) {
        const mapped = this.mapError(errorOrResponse);
        if (typeof showToast === 'function') {
            const tone = mapped.code === 'IDEMPOTENCY_CONFLICT' ? 'success'
                : (mapped.code === 'RATE_LIMITED' ? 'warning' : 'error');
            showToast(mapped.message, tone, 5000);
        } else {
            // eslint-disable-next-line no-alert
            alert(mapped.message);
        }
        return mapped;
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
     * Get single product by SKU.
     *
     * Primary: GET /api/products/<sku>. This is the canonical detail endpoint
     * and returns the richest payload (including manufacturer_part_number,
     * description_html, color_hex, and related fields the search endpoints
     * don't include).
     *
     * Fallback: when the singular endpoint throws (5xx, network, timeout) or
     * its response envelope is non-ok with no recoverable error code, hit
     * /api/search/smart?q=<sku> and pick the suggestion whose `sku` matches
     * exactly. The smart payload covers everything the product page needs
     * for first paint (name, slug, retail_price, color, image_url, brand,
     * category, description, in_stock, stock_quantity, source, pack_type) and
     * the existing Supabase enrichment in product-detail-page.js fills in
     * description_html / compatible_devices_html / related_product_skus when
     * the smart `description` field is HTML-only.
     *
     * Why this fallback exists: the singular endpoint has been observed to
     * return 500 INTERNAL_ERROR for specific product families (most notably
     * the Epson Genuine 200 ink series — see errors.md for repro and the
     * backend-passover note). The fallback keeps user-facing product pages
     * loading even when the canonical endpoint regresses. A genuine NOT_FOUND
     * (404 envelope, code === 'NOT_FOUND') is preserved as-is — we only
     * shadow server-side errors, never legitimate "this SKU doesn't exist"
     * results.
     *
     * @param {string} sku - Product SKU
     * @returns {Promise<{ ok: boolean, data?: object, error?: string, source?: string }>}
     */
    async getProduct(sku) {
        if (sku == null || sku === '') {
            return { ok: false, error: 'No SKU provided' };
        }
        const encoded = encodeURIComponent(sku);

        // Use a raw fetch (not this.get) so we can distinguish 404 from 5xx.
        // request() throws on both; we need to fall back only on 5xx/network.
        const primary = await this._rawJsonFetch(`/api/products/${encoded}`);

        // Happy path: primary returned a healthy envelope.
        if (primary.kind === 'ok' && primary.body && primary.body.ok && primary.body.data) {
            return primary.body;
        }

        // Genuine 404 / not-found envelope: do NOT fall back. Surfacing a
        // fuzzy near-neighbor here would mislead the user into thinking they
        // reached the real product page for a SKU that doesn't exist.
        const code = primary.body && primary.body.error && primary.body.error.code;
        const isGenuineMissing = primary.kind === 'http-error' && (primary.status === 404 || code === 'NOT_FOUND');
        if (isGenuineMissing) {
            return primary.body || { ok: false, error: 'Product not found' };
        }

        // Anything else (5xx, network, JSON parse failure, malformed envelope):
        // fall back to /api/search/smart and pick the exact SKU match. Smart's
        // payload covers everything the product page needs for first paint
        // (name, slug, retail_price, color, image_url, brand, category,
        // description, in_stock, stock_quantity, source, pack_type).
        if (typeof DebugLog !== 'undefined') {
            DebugLog.warn(`[API.getProduct] /api/products/${sku} unhealthy (${primary.kind}/${primary.status || ''}) — trying search-smart fallback`);
        }
        const fb = await this._rawJsonFetch(`/api/search/smart?q=${encoded}&limit=10`);
        const products = fb.kind === 'ok' && fb.body && fb.body.ok && fb.body.data && Array.isArray(fb.body.data.products)
            ? fb.body.data.products : [];
        const match = products.find(p => p && p.sku === sku);
        if (match) {
            // Mirror smart's `description` (HTML body) onto description_html
            // so the product page renderer reads it through the same field
            // it would have got from the canonical detail endpoint.
            if (match.description && !match.description_html) {
                match.description_html = match.description;
            }
            // Smart returns `category: { name, slug }` (object), but the
            // canonical detail endpoint returns `category` as a string code
            // (e.g. "CON-RIBBON"). product-detail-page.js → normalizeCategory()
            // expects a string. Flatten so the renderer doesn't crash with
            // "raw.toLowerCase is not a function".
            if (match.category && typeof match.category === 'object') {
                match.category = match.category.slug || match.category.name || null;
            }
            return { ok: true, data: match, source: 'search-smart-fallback' };
        }

        // Both paths failed.
        return {
            ok: false,
            error: 'Product detail endpoint is temporarily unavailable. Please try again.',
        };
    },

    /**
     * Internal helper for getProduct's fallback machinery. Wraps fetch in a
     * uniform `{ kind, status?, body? }` shape so the caller can branch on
     * the *kind* of failure (network vs 4xx vs 5xx vs malformed JSON) without
     * relying on thrown-Error string matching.
     *
     * Bypasses request() because that helper throws on every non-ok envelope
     * and collapses the distinction between 404-genuine-missing and 500-broken.
     * Honors the same Authorization + X-Guest-Session headers so behavior in
     * authed contexts matches request() byte-for-byte.
     */
    async _rawJsonFetch(endpoint) {
        const url = `${Config.API_URL}${endpoint}`;
        const token = await this.getToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const guestSession = this.getGuestSessionId();
        if (!token && guestSession) headers['X-Guest-Session'] = guestSession;

        let res;
        try {
            res = await fetch(url, { method: 'GET', headers, credentials: 'include' });
        } catch (err) {
            return { kind: 'network-error', error: err && err.message };
        }
        let body = null;
        try { body = await res.json(); } catch (_) { /* body stays null */ }
        if (res.status >= 200 && res.status < 300 && body) {
            return { kind: 'ok', status: res.status, body };
        }
        return { kind: 'http-error', status: res.status, body };
    },

    /**
     * Get products compatible with a printer
     * @param {string} printerSlug - Printer slug
     */
    async getProductsByPrinter(printerSlug) {
        return this.get(`/api/products/printer/${encodeURIComponent(printerSlug)}`);
    },

    /**
     * Get products strictly compatible with a printer (via product_compatibility table).
     * Uses the dedicated printer-products endpoint which returns only products linked
     * to the exact printer — no fuzzy name matching.
     * @param {string} printerSlug - Printer slug (e.g. "brother-mfc-j6945dw")
     * @param {object} [params] - Optional { page, limit, type, source }
     */
    async getPrinterProducts(printerSlug, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = `/api/printers/${encodeURIComponent(printerSlug)}/products${query ? `?${query}` : ''}`;
        return this.get(url);
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
        const url = `/api/products/printer/${encodeURIComponent(printerSlug)}/color-packs${query ? `?${query}` : ''}`;
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
    // SEO SCHEMA (CollectionPage + BreadcrumbList for brand/category/printer pages)
    // =========================================================================

    /**
     * Get CollectionPage + BreadcrumbList JSON-LD for a brand and/or category page.
     * At least one of brand/category required. Slugs validated server-side.
     * @param {object} params - { brand?, category? }
     */
    async getCollectionSchema(params = {}) {
        const qs = new URLSearchParams();
        if (params.brand) qs.append('brand', params.brand);
        if (params.category) qs.append('category', params.category);
        const query = qs.toString();
        if (!query) return { ok: false, error: 'brand or category required' };
        return this.get(`/api/schema/collection?${query}`);
    },

    /**
     * Get CollectionPage + BreadcrumbList JSON-LD for a printer landing page.
     * @param {string} printerSlug - Printer slug (e.g. "brother-mfc-j870")
     */
    async getPrinterSchema(printerSlug) {
        return this.get(`/api/schema/printer/${encodeURIComponent(printerSlug)}`);
    },

    /**
     * Get site-wide Organization / WebSite / LocalBusiness JSON-LD. Embed in every
     * page <head> per spec §5.6. Use SWR so repeated page loads don't re-fetch.
     */
    async getSiteSchema() {
        return this.getWithSWR('/api/schema/site', { ttl: 5 * 60 * 1000 });
    },

    /**
     * Get the dedicated Product / BreadcrumbList / FAQ JSON-LD payload for a SKU.
     * `/api/products/:sku` already embeds a `seo.jsonLd` blob; this dedicated
     * endpoint is the canonical source per spec §5.6 — embed verbatim.
     */
    async getProductJsonLd(sku) {
        return this.get(`/api/products/${encodeURIComponent(sku)}/jsonld`);
    },

    // =========================================================================
    // SEARCH
    // =========================================================================

    // Three search-related API methods were deleted in the 2026-05-03 search
    // audit (readfirst/SEARCH_AUDIT.md):
    //   - getAutocomplete(q, limit)        — used only by initBasicAutocomplete (deleted)
    //   - getAutocompleteRich(q, limit)    — never called anywhere
    //   - searchByPart(q, options)         — never called anywhere
    // /api/search/suggest is now invoked directly from search.js's fetchSuggest;
    // /api/search/smart is the canonical search endpoint via API.smartSearch.

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
     * Smart search — full search-results page (per frontend-search-spec §2.1).
     * Returns full envelope: products, facets, total, pagination,
     * matched_printer?, did_you_mean?, corrected_from?
     * @param {string} query - Raw user query (no client-side normalization).
     * @param {number|object} limitOrOpts - max results, or { limit, page, include }
     */
    async smartSearch(query, limitOrOpts = 24) {
        if (!query || query.length < 1) {
            return { ok: true, data: { products: [], total: 0 } };
        }
        const opts = typeof limitOrOpts === 'object' && limitOrOpts !== null
            ? limitOrOpts
            : { limit: limitOrOpts };
        const params = new URLSearchParams({ q: query });
        params.set('limit', String(opts.limit ?? 24));
        if (opts.page) params.set('page', String(opts.page));
        // Default include: compat (printer-compat expansion) + description (for cards)
        params.set('include', opts.include || 'compat,description');
        // (Previously: `typeof searchConfig !== 'undefined' ? searchConfig.apiUrl : '/api/search/smart'` —
        //  `searchConfig` was never defined anywhere; the fallback was the
        //  only branch ever taken. Inlined to its actual value.)
        return this.get(`/api/search/smart?${params}`);
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
     *
     * Normalizes the response shape so callers can treat `/by-printer` rows
     * the same as `/smart` rows. Per the May 2026 search-enrichment contract
     * (search-enrichment-may2026.md, "Note for /by-printer + /by-part"):
     *   - the RPC path uses `product_id` instead of `id`
     *   - canonical_url, slug, original_price, discount_* may be omitted on
     *     the RPC path (the fallback path returns the full shape)
     *
     * We map `product_id` → `id` before returning so card renderers — which
     * read `product.id` for `data-product-id` (Add-to-Cart, favourites) —
     * keep working without per-call-site shimming.
     *
     * @param {string} query - Printer name or model query
     * @param {object} options - { limit, page }
     */
    async searchByPrinter(query, options = {}) {
        const params = new URLSearchParams({ q: query });
        if (options.limit) params.append('limit', options.limit);
        if (options.page) params.append('page', options.page);
        const res = await this.get(`/api/search/by-printer?${params}`);
        return _normalizeRpcSearchResponse(res);
    },

    /**
     * Search cartridges by manufacturer part / SKU.
     *
     * Symmetric with `searchByPrinter` — the RPC path emits `product_id`
     * instead of `id` and may omit canonical_url + savings fields. We
     * normalize on the client so renderers never see two product shapes.
     *
     * @param {string} query - Part number or SKU query
     * @param {object} options - { limit, page }
     */
    async searchByPart(query, options = {}) {
        const params = new URLSearchParams({ q: query });
        if (options.limit) params.append('limit', options.limit);
        if (options.page) params.append('page', options.page);
        const res = await this.get(`/api/search/by-part?${params}`);
        return _normalizeRpcSearchResponse(res);
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
     * Preview a coupon BEFORE applying — read-only validation that returns
     * actionable failure reasons (minimum_order_required / account_too_new /
     * already_used) so we can inline-correct the user.
     * Always returns HTTP 200; validity is in body.data.valid.
     * @param {string} code - Coupon code
     */
    async previewCoupon(code) {
        return this.post('/api/cart/coupon/preview', { code });
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
     * Delete legacy product image_url (admin). Used when a product has no
     * entries in the managed images array and only a legacy/feed image_url.
     * @param {string} productId - Product UUID
     */
    async deleteProductImageUrl(productId) {
        return this.delete(`/api/admin/products/${productId}/image-url`);
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
     * Bulk deactivate products (admin - super_admin/stock_manager only)
     * @param {object} data - { product_ids, deactivate_all, dry_run }
     */
    async bulkDeactivateProducts(data) {
        return this.post('/api/admin/products/bulk-deactivate', data);
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
 * Normalize a `/api/search/by-printer` or `/api/search/by-part` response so
 * downstream renderers see the same shape as `/api/search/smart`.
 *
 * Per the May 2026 search-enrichment contract:
 *   - the RPC path emits `product_id` (not `id`) and may omit `canonical_url`,
 *     `slug`, `original_price`, `discount_amount`, `discount_percent`
 *   - the fallback path returns the full smart-search shape
 *
 * We always set `id ← product_id || id`. The optional fields stay optional —
 * card renderers already fall back to `compare_price` for savings and to
 * `slug + sku` for URL construction when canonical_url is missing.
 *
 * Returns the response unchanged on error or unexpected shape so callers'
 * existing error paths still trigger.
 *
 * @param {object} res - Raw API envelope { ok, data: { products: [...] } }
 * @returns {object} Same envelope, products with normalized `id`.
 */
function _normalizeRpcSearchResponse(res) {
    if (!res || !res.ok || !res.data || !Array.isArray(res.data.products)) {
        return res;
    }
    const products = res.data.products.map(p => {
        if (!p || typeof p !== 'object') return p;
        // product_id → id is the only mandatory normalization. Don't clobber
        // an already-present id (the fallback path supplies one).
        if (p.id == null && p.product_id != null) {
            return { ...p, id: p.product_id };
        }
        return p;
    });
    return { ...res, data: { ...res.data, products } };
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
        return { class: 'contact-us', text: 'Contact Us', icon: 'phone' };
    }
    if (product.stock_status === 'out_of_stock') {
        return { class: 'contact-us', text: 'Contact Us', icon: 'phone' };
    }
    if (product.stock_status === 'in_stock') {
        return { class: 'in-stock', text: 'In Stock', icon: 'check-circle' };
    }
    // Fallback for endpoints that don't return stock_status (listing, search)
    const inStock = product.in_stock !== undefined ? product.in_stock : (product.stock_quantity > 0);
    if (!inStock) {
        return { class: 'contact-us', text: 'Contact Us', icon: 'phone' };
    }
    return { class: 'in-stock', text: 'In Stock', icon: 'check-circle' };
}

/**
 * Free-shipping qualification — single source of truth for product-card and PDP
 * pills, the schema.org shipping rate, and any future surface that needs to
 * answer "does this individual product, on its own, qualify for free NZ
 * shipping?" Threshold reads from Config (loaded from /api/settings) so it
 * stays in lockstep with the cart progress bar and checkout shipping logic.
 *
 * Stock status is intentionally NOT a gate: a Contact-Us product that meets
 * the threshold still ships free once the customer completes the contact
 * flow, and hiding the pill there would mis-represent the offer.
 *
 * @param {object} product
 * @returns {boolean}
 */
function qualifiesForFreeShipping(product) {
    if (!product || product.retail_price == null) return false;
    const threshold = (typeof Config !== 'undefined' && Config.getSetting)
        ? Config.getSetting('FREE_SHIPPING_THRESHOLD', 100)
        : 100;
    return product.retail_price >= threshold;
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
window.qualifiesForFreeShipping = qualifiesForFreeShipping;
window.getSourceBadge = getSourceBadge;
window.calculateGST = calculateGST;
// Test hook — used by __tests__/search-enrichment.test.js. Not part of the
// public API surface; do not call from product code.
window._normalizeRpcSearchResponse = _normalizeRpcSearchResponse;
