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
    // Transient retry (shop-transient-failure-recovery-may2026.md): Render free-tier
    // cold-starts and brief network blips made the first /api/shop?... call on a
    // cold visit reject — the codes drilldown then painted "Failed to load products.
    // Please try again." even though a reload-second-later succeeded. Two retries
    // (3 total attempts) cover ≥95% of cold-start cases; 300ms × 3ⁿ keeps the
    // user-visible delay under a second when the first attempt fails fast.
    MAX_TRANSIENT_RETRIES: 2,
    TRANSIENT_RETRY_BASE_MS: 300,

    async _fetchWithAuth(url, fetchOptions = {}, opts = {}) {
        const timeoutMs = opts.timeoutMs || this.REQUEST_TIMEOUT_MS;
        const retryCount = opts.retryCount || 0;
        const rateLimitRetry = opts.rateLimitRetry || 0;
        const transientRetry = opts.transientRetry || 0;
        const method = (fetchOptions.method || 'GET').toUpperCase();
        const isIdempotent = method === 'GET' || method === 'HEAD';

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const cacheMode = method === 'GET' ? 'default' : 'no-store';
            // Cross-origin cache safety (api-subdomain cutover, May 2026):
            // The storefront now calls https://api.inkcartridges.co.nz cross-origin.
            // Cloudflare's cache rule BYPASSES the edge cache whenever an sb-* /
            // __ink_auth cookie rides along, so sending cookies on public catalog
            // reads would defeat the whole cutover (a MISS for every visitor).
            // Auth is carried by the Authorization: Bearer header and guest carts
            // by the X-Guest-Session header — never by cookies — so we only attach
            // credentials when the request is actually authenticated. Anonymous
            // reads use 'omit' → cookies dropped cross-origin → cache HIT.
            const reqHeaders = fetchOptions.headers;
            const hasAuthHeader = reqHeaders instanceof Headers
                ? reqHeaders.has('Authorization')
                : !!(reqHeaders && (reqHeaders.Authorization || reqHeaders.authorization));
            const response = await fetch(url, {
                ...fetchOptions,
                signal: controller.signal,
                credentials: hasAuthHeader ? 'include' : 'omit',
                cache: cacheMode
            });
            clearTimeout(timeoutId);

            // Handle rate limiting — only retry idempotent GET requests (never retry mutations)
            if (response.status === 429) {
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

            // Transient 5xx — retry idempotent GETs only. POSTs/PUTs/DELETEs are
            // NEVER retried automatically (could double-charge, double-mutate);
            // the caller's mapError flow surfaces them. The 401-auth-refresh
            // branch below runs first when the original response is 401, so a
            // 401 won't be misclassified as transient.
            if (isIdempotent
                && response.status >= 500
                && response.status < 600
                && transientRetry < this.MAX_TRANSIENT_RETRIES) {
                const delay = this.TRANSIENT_RETRY_BASE_MS * Math.pow(3, transientRetry);
                DebugLog.warn(`Transient ${response.status} on ${url}, retrying in ${delay}ms (attempt ${transientRetry + 1}/${this.MAX_TRANSIENT_RETRIES})`);
                await new Promise(r => setTimeout(r, delay));
                return this._fetchWithAuth(url, fetchOptions, { ...opts, transientRetry: transientRetry + 1 });
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
            // Transient network/timeout — retry idempotent GETs only. We mirror
            // the 5xx branch above: TypeError is fetch()'s signal for "could
            // not reach the server" (DNS, TLS, connection refused, offline),
            // and AbortError fires when our REQUEST_TIMEOUT_MS guard trips
            // before Render's cold start finishes warming. Both classes are
            // safe to replay for a GET. Anything else (or any non-idempotent
            // method) propagates without replay.
            const isAbort = error && error.name === 'AbortError';
            const isNetwork = error && error.name === 'TypeError';
            if (isIdempotent
                && (isAbort || isNetwork)
                && transientRetry < this.MAX_TRANSIENT_RETRIES) {
                const delay = this.TRANSIENT_RETRY_BASE_MS * Math.pow(3, transientRetry);
                DebugLog.warn(`Transient ${isAbort ? 'timeout' : 'network error'} on ${url}, retrying in ${delay}ms (attempt ${transientRetry + 1}/${this.MAX_TRANSIENT_RETRIES})`);
                await new Promise(r => setTimeout(r, delay));
                return this._fetchWithAuth(url, fetchOptions, { ...opts, transientRetry: transientRetry + 1 });
            }
            if (isAbort) {
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

            // Capture x-request-id for log correlation. Backend (Render) sets this
            // on every response; surfacing it on errors lets a customer's "the form
            // broke" report be grepped against stderr without guessing timestamps.
            const requestId = response.headers.get('x-request-id') || null;

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
                    const e = new Error('The server is temporarily unavailable. Please try again in a moment.');
                    e.code = 'INTERNAL_ERROR';
                    e.status = status;
                    if (requestId) e.request_id = requestId;
                    throw e;
                }
                const e = new Error(`Unexpected response from server (HTTP ${status}).`);
                e.status = status;
                if (requestId) e.request_id = requestId;
                throw e;
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

                DebugLog.warn('API Error:', response.status, errorMsg, requestId ? `(req ${requestId})` : '');

                const withRid = (env) => requestId ? Object.assign(env, { request_id: requestId }) : env;

                // Return error response instead of throwing for specific codes
                // so callers can handle them with targeted UI
                if (errorCode === 'EMAIL_NOT_VERIFIED') {
                    return withRid({ ok: false, error: errorMsg, code: 'EMAIL_NOT_VERIFIED' });
                }
                if (errorCode === 'DISPOSABLE_EMAIL') {
                    return withRid({ ok: false, error: errorMsg, code: 'DISPOSABLE_EMAIL' });
                }
                if (errorCode === 'ACCOUNT_FLAGGED') {
                    return withRid({ ok: false, error: errorMsg, code: 'ACCOUNT_FLAGGED' });
                }

                // Return 409 conflicts with code so callers can handle them
                if (response.status === 409 && errorCode) {
                    return withRid({ ok: false, error: errorMsg, code: errorCode, data: data });
                }

                // Return order/payment errors with code so callers can show specific messages
                if (errorCode === 'ORDER_DB_ERROR' || errorCode === 'PAYMENT_ERROR' || errorCode === 'ORDER_TOTAL_TOO_LOW') {
                    return withRid({ ok: false, error: errorMsg, code: errorCode });
                }

                // Return validation errors with details so callers can show per-field messages
                if (errorCode === 'VALIDATION_FAILED') {
                    return withRid({ ok: false, error: errorMsg, code: errorCode, details: errorDetails });
                }


                // Return rate limit errors with retry_after so callers can handle them
                if (response.status === 429 || errorCode === 'RATE_LIMITED') {
                    return withRid({ ok: false, error: errorMsg, code: 'RATE_LIMITED', retry_after: data.retry_after });
                }

                // Stock-conflict — caller renders inline message on the line item
                if (errorCode === 'STOCK_INSUFFICIENT') {
                    return withRid({ ok: false, error: errorMsg, code: errorCode, details: errorDetails });
                }

                // Forbidden — caller decides between "verify email", "B2B only",
                // or generic deny. Backend's specific code wins when present.
                if (response.status === 403 || errorCode === 'FORBIDDEN') {
                    return withRid({ ok: false, error: errorMsg, code: errorCode || 'FORBIDDEN' });
                }

                // Unauthorized — caller redirects to login
                if (response.status === 401 || errorCode === 'UNAUTHORIZED') {
                    return withRid({ ok: false, error: errorMsg, code: 'UNAUTHORIZED' });
                }

                // Not found — caller may show "Couldn't find that product/order"
                if (response.status === 404 || errorCode === 'NOT_FOUND') {
                    return withRid({ ok: false, error: errorMsg, code: 'NOT_FOUND' });
                }

                // 5xx — return a structured envelope so callers can show a friendly
                // message AND the request_id (for Render-log grepping). Newsletter
                // and contact forms specifically rely on this branch to distinguish
                // a backend hiccup from validation failure.
                if (response.status >= 500) {
                    return withRid({
                        ok: false,
                        error: errorMsg,
                        code: errorCode || 'INTERNAL_ERROR',
                        status: response.status,
                    });
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
                const e = new Error(fullMsg);
                e.code = errorCode;
                e.status = response.status;
                if (requestId) e.request_id = requestId;
                throw e;
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
        const requestId = errorOrResponse.request_id
            || (errorOrResponse.error && errorOrResponse.error.request_id)
            || null;
        // Short prefix of the request id keeps the toast readable while still being
        // unique enough for log correlation (Render IDs are UUID v4 — 8 chars is
        // collision-safe within any reasonable log window).
        const ridShort = requestId ? String(requestId).slice(0, 8) : null;

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
                return {
                    code,
                    message: ridShort
                        ? `Server hiccup — please try again. If it keeps happening, contact us with reference ${ridShort}.`
                        : 'Server hiccup — please try again. If it keeps happening, contact us.',
                    request_id: requestId,
                    action: 'retry',
                };
            default:
                return {
                    code,
                    message: ridShort ? `${fallbackMessage} (ref ${ridShort})` : fallbackMessage,
                    request_id: requestId,
                };
        }
    },

    /**
     * Extract a plain user-facing string from any of the error shapes the
     * frontend deals with. The May-2026 backend ships `{ ok: false, error: {
     * code, message, request_id } }` for typed errors, but older endpoints
     * still return `{ ok: false, error: '<string>' }`. Without this helper,
     * page controllers that did `showError(response.error || 'fallback')`
     * coerced the object via .toString() and painted "[object Object]"
     * (most visibly on product 404 — see errors.md "[object Object] on
     * product 404" entry).
     *
     * Shapes handled, in order:
     *   - falsy / undefined                  → fallback
     *   - plain string                       → string
     *   - Error instance                     → err.message || fallback
     *   - { message: '...' }                 → message
     *   - { error: '...' }                   → error
     *   - { error: { message: '...' } }      → error.message
     *   - { error: { code, ... }, ... }      → code (last resort, never object)
     *   - anything else                      → fallback (never object→string coerce)
     *
     * @param {*} errorOrResponse - any of the above shapes
     * @param {string} [fallback='Something went wrong. Please try again.']
     * @returns {string} A safe-to-render string. Never returns "[object Object]".
     */
    extractErrorMessage(errorOrResponse, fallback = 'Something went wrong. Please try again.') {
        if (errorOrResponse == null) return fallback;
        if (typeof errorOrResponse === 'string') return errorOrResponse || fallback;
        // Error instance (thrown from request() or _fetchWithAuth())
        if (errorOrResponse instanceof Error) {
            return (errorOrResponse.message && String(errorOrResponse.message)) || fallback;
        }
        if (typeof errorOrResponse !== 'object') return fallback;
        // Direct .message on the envelope (e.g. mapError() return value)
        if (typeof errorOrResponse.message === 'string' && errorOrResponse.message) {
            return errorOrResponse.message;
        }
        // .error nested: string or { code, message }
        const inner = errorOrResponse.error;
        if (typeof inner === 'string' && inner) return inner;
        if (inner && typeof inner === 'object') {
            if (typeof inner.message === 'string' && inner.message) return inner.message;
            // Last resort: surface the machine code rather than letting an
            // object coerce. mapError() can later upgrade this to a friendly
            // sentence; the contract here is "never paint [object Object]".
            if (typeof inner.code === 'string' && inner.code) return inner.code;
        }
        return fallback;
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
    async get(endpoint, options = {}) {
        // Forward caller options (e.g. { signal } for AbortController) into
        // request → fetch. Previously the 2nd arg was silently dropped, so
        // admin callers passing { signal } couldn't abort in-flight reads.
        return this.request(endpoint, { ...options, method: 'GET' });
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
     * Get shop data (products, series codes, category counts) in a single call.
     *
     * Recovers compatible products that the backend's `code` filter drops.
     * The backend filters /api/shop?code=X by `series_codes` array contains;
     * compatible products in the catalog ship with `series_codes: []` (the
     * extraction job that runs for genuines never ran for compatibles — see
     * readfirst/catalog-defects-may2026.md §6 — "Backfill series_codes on
     * compatible products"). Without recovery the storefront looks like it
     * stocks no compatibles for any code: chips for compatible-only series
     * (HP 02, Epson 73N, …) never appear in the drilldown, and chips that
     * exist for genuine series (HP 564, Brother LC133, …) undercount and
     * hide their compatible siblings on click.
     *
     * Strategy: when a brand+category is supplied and the caller hasn't
     * narrowed to `source=genuine`, fire a parallel compatibles-only fetch
     * for the same brand+category, derive series codes from each compat's
     * name/SKU via `_enrichSeriesCodes`, and merge the missing rows back into
     * the primary response. The sidecar fetch is deduplicated by SWR so
     * across the codes drilldown + the code-filtered grid the customer pays
     * for it once per brand+category per session.
     *
     * The merge is conservative: if the sidecar call fails or returns empty,
     * the primary response stands. Code-filtered requests get extra products
     * (with `meta.total` bumped to match); unfiltered requests get extra
     * series entries (with merged counts). Genuine-source-only requests skip
     * the sidecar entirely (zero recovery is needed).
     *
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

        // Eligibility for compat-recovery sidecar — decided BEFORE awaiting so
        // primary and sidecar fire in parallel (halves cold-start latency on
        // Render). Recovery is skipped when:
        //  - no brand+category → can't dedupe the sidecar narrowly
        //  - source=genuine → caller asked for genuine only; no compats wanted
        //  - search= → server-side search match isn't a code drilldown
        const eligibleForRecovery = !!(params.brand
            && params.category
            && params.source !== 'genuine'
            && !params.search);

        const primaryPromise = this.getWithSWR(`/api/shop?${qs.toString()}`);
        let sidecarPromise = null;
        if (eligibleForRecovery) {
            const fbQs = new URLSearchParams();
            fbQs.append('brand', params.brand);
            fbQs.append('category', params.category);
            fbQs.append('source', 'compatible');
            fbQs.append('limit', '200');
            // Sidecar fires against /api/products, NOT /api/shop. The /api/shop
            // endpoint drops `pack_type=value_pack` rows on the source=compatible
            // filter — the bug surfaced for PGI650 (verified 2026-05-11):
            // /api/shop?brand=canon&category=ink&source=compatible returns 99
            // products, /api/products with the same filter returns 106 — the
            // missing 7 are KCMY/CMY value-packs (CPGI650KCMY, CPGI670KCMY,
            // CCLI671KCMY, CCLI681KCMY, CPGI520KCMY, CPGI525KCMY, CPGI5KCMY).
            // Without this swap the chip drilldown silently hides every
            // compatible multipack — the customer hits the chip and sees only
            // the black single, even when the catalog ships a colour pack.
            // .catch absorbs sidecar failure so it can never reject the
            // top-level Promise.all below.
            sidecarPromise = this.getWithSWR(`/api/products?${fbQs.toString()}`).catch(() => null);
        }

        // Await both. The primary may still throw (no try/catch around
        // primaryPromise — the codes drilldown's existing fallback path
        // expects a thrown error to trigger legacy mode). The sidecar
        // promise was wrapped in .catch(() => null) above so it can't reject.
        const [primary, sidecar] = await Promise.all([primaryPromise, sidecarPromise || Promise.resolve(null)]);

        // Skip merge when primary unhealthy or recovery wasn't requested.
        // We always return `primary` so the caller's existing branching on
        // `response.ok` / `response.data` semantics is unchanged.
        if (!eligibleForRecovery
            || !primary || !primary.ok || !primary.data
            || !sidecar || !sidecar.ok || !sidecar.data || !Array.isArray(sidecar.data.products)) {
            return this._finalizeShopData(primary, params);
        }

        // Enrich + merge in a try/catch — if any merge step throws (malformed
        // data, unexpected shape) the primary response stands. We never
        // surface a recovery failure to the caller because the alternative
        // (whole drilldown shows "Failed to load products") is strictly worse
        // than having the unrecovered primary render.
        try {
            // Enrich every compatible with derived series_codes (in place, on
            // the SWR-cloned objects we own — _swrClone deep-copies on every
            // read). _enrichSeriesCodes returns true when codes had to be
            // derived from name/sku (backend hadn't supplied them) and false
            // when the backend's series_codes array was already populated.
            //
            // Why we track the per-product enrichment flag (May 2026 fix):
            // The backend now ships `series_codes` on every product via /api/shop
            // AND /api/products (commit 5c99462 — see
            // project_series_codes_thin_extractor_may2026). That means the primary
            // /api/shop response's series[].count ALREADY includes every compatible
            // the sidecar would surface. Counting the sidecar's compats again in
            // the drilldown branch double-counts every chip:
            //
            //   /api/shop?brand=epson&category=ink  → series.81N.count = 8 (8 compats)
            //   /api/products?...&source=compatible → 8 more 81N compats (same rows)
            //   merged FE chip → 8 + 8 = 16 ❌ (customer saw 16; clicked → 8 products)
            //
            // The merge must skip products whose codes the backend already used.
            // The only safe signal we have for that is the existence of backend
            // series_codes BEFORE we enrich: if the array was populated, backend
            // had already classified the row and used it in its count; if empty,
            // backend skipped it and the sidecar count is the only thing pulling
            // that chip onto the grid. Enrichment-true is therefore both the
            // necessary signal that we own the count, and a defense-in-depth
            // recovery path if backend regresses on a future product.
            const compats = sidecar.data.products;
            const enrichedSet = new Set();
            for (const p of compats) {
                if (this._enrichSeriesCodes(p)) enrichedSet.add(p);
            }

            if (params.code) {
                // Code-filtered request: merge missing compatibles for that code.
                // The seen-set dedupe handles the double-count question here —
                // products already in primary (whether matched on backend
                // series_codes or recovered) are skipped regardless of enrichment.
                // We still consider ALL compats (not just enriched ones) because
                // /api/shop?code=X is known to drop value-pack rows on the
                // source=compatible filter; the sidecar is the recovery path for
                // those even when their series_codes were backend-supplied.
                const wanted = String(params.code).toUpperCase();
                const seen = new Set();
                for (const p of (primary.data.products || [])) {
                    if (p && (p.id || p.sku)) seen.add(p.id || p.sku);
                }
                const recovered = compats.filter(p => {
                    if (!p || seen.has(p.id || p.sku)) return false;
                    if (p.source !== 'compatible') return false;
                    const codes = (p.series_codes || []).map(c => String(c || '').toUpperCase());
                    return codes.includes(wanted);
                });
                if (recovered.length) {
                    primary.data.products = (primary.data.products || []).concat(recovered);
                    if (primary.meta && typeof primary.meta.total === 'number') {
                        primary.meta.total += recovered.length;
                    }
                }
            } else {
                // Codes drilldown request: merge compat counts into series[]
                // so chips for compatible-only series that backend missed show
                // up. Only enriched compats (backend `series_codes` was empty)
                // contribute counts — backend-classified compats are already
                // in primary.series[].count and would double-count otherwise.
                const seriesByCode = new Map();
                const seriesArr = Array.isArray(primary.data.series) ? primary.data.series : [];
                primary.data.series = seriesArr;
                for (const s of seriesArr) {
                    if (s && s.code) seriesByCode.set(String(s.code).toUpperCase(), s);
                }
                for (const p of compats) {
                    if (!p || p.source !== 'compatible') continue;
                    if (!enrichedSet.has(p)) continue; // backend already counted this row
                    const codes = p.series_codes || [];
                    // Per-product dedupe in case enrichment yielded multiples
                    // for the same family (eg a multi-printer compat naming
                    // "BCI3 BCI6").
                    const seen = new Set();
                    for (const raw of codes) {
                        const c = String(raw || '').toUpperCase();
                        if (!c || seen.has(c)) continue;
                        seen.add(c);
                        const existing = seriesByCode.get(c);
                        if (existing) {
                            existing.count = (existing.count || 0) + 1;
                        } else {
                            const entry = { code: c, count: 1 };
                            seriesByCode.set(c, entry);
                            seriesArr.push(entry);
                        }
                    }
                }
                // Stable sort: alphanumeric, matching how the codes drilldown
                // already orders chips client-side. Numeric-aware so "02" < "11".
                seriesArr.sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true, sensitivity: 'base' }));
            }
        } catch (mergeErr) {
            if (typeof DebugLog !== 'undefined' && DebugLog.warn) {
                DebugLog.warn('[API.getShopData] compat-recovery merge failed; returning primary unchanged', mergeErr);
            }
        }

        return this._finalizeShopData(primary, params);
    },

    /**
     * The post-processing every /api/shop response goes through, on BOTH of
     * getShopData's return paths (the compat-recovery skip and the merged one).
     *
     * Truncated-code repair runs LAST so its series_codes rewrite wins over the
     * manual override layer, but its chip detection is computed FIRST —
     * synchronously, off the untouched backend series list — so the manual layer
     * knows which codes it must not turn into duplicate tiles.
     */
    async _finalizeShopData(primary, params) {
        const truncated = this._detectTruncatedChips(primary, params);
        await this._applyManualCodes(primary, params, truncated);
        return this._repairTruncatedSeries(primary, params, truncated);
    },

    // ─── Truncated series-code repair (Canon bare-CL, Jul 2026) ───────────────
    // The backend's series_codes extractor caps Canon's bare `CL` prefix at two
    // digits: CL511 and CL513 both land as "CL51", CL641 and CL646 both land as
    // "CL64". Two things break as a result:
    //
    //   1. The backend still LABELS the merged pair chip "PG510/CL511", but it
    //      FILES each product under its own extracted code. The colour half was
    //      extracted as "CL51", so it never lands under the pair — clicking
    //      PG510/CL511 returns only the PG510 blacks. (`?code=CL511` → 0 hits.)
    //   2. The truncated code becomes its own chip that jams two unrelated
    //      series together (CL51 = CL511 + CL513).
    //
    // The real fix is one regex in the backend extractor. Until then this layer
    // re-derives the true code from the SKU and re-homes the products. It is
    // deliberately self-disabling: detection only fires when the backend's OWN
    // pair label proves a longer code exists, and SeriesCodes.trueCodeFromSku
    // only overrides when the SKU strictly extends the backend code. Once the
    // backend emits CL511, no suspects are found and nothing is rewritten.
    // Fail-open throughout — /shop can never break because a repair fetch failed.

    /** The SeriesCodes helper, in whichever scope we're running (page or test). */
    _seriesCodes() {
        if (typeof SeriesCodes !== 'undefined' && SeriesCodes) return SeriesCodes;
        if (typeof window !== 'undefined' && window.SeriesCodes) return window.SeriesCodes;
        return null;
    },

    /**
     * Synchronously spot chips the backend truncated. No fetches, no mutation.
     *
     * @returns {{chipByHalf: Map<string,Object>, halves: string[], suspectCodes: Set<string>}}
     */
    _detectTruncatedChips(primary, params) {
        const empty = { chipByHalf: new Map(), halves: [], suspectCodes: new Set() };
        try {
            const SC = this._seriesCodes();
            if (!SC || typeof SC.pairHalves !== 'function') return empty;
            if (!primary || !primary.ok || !primary.data) return empty;
            if (params && params.code) return empty;   // drilldown responses only
            const series = primary.data.series;
            if (!Array.isArray(series) || !series.length) return empty;

            // Every half of every merged pair chip → the chip that owns it.
            const chipByHalf = new Map();
            for (const chip of series) {
                if (!chip || !chip.code) continue;
                for (const half of SC.pairHalves(chip.code)) {
                    if (!chipByHalf.has(half)) chipByHalf.set(half, chip);
                }
            }
            if (!chipByHalf.size) return empty;
            const halves = [...chipByHalf.keys()];

            // A standalone chip whose code is a strict DIGIT-prefix of some pair
            // half is a truncation of it — the backend's own pair label is what
            // proves the longer code is real. "CL51" ⊂ "CL511"; "CL64" ⊂ "CL641".
            const suspectCodes = new Set();
            for (const chip of series) {
                const code = chip && chip.code ? String(chip.code).toUpperCase() : '';
                if (!code || code.indexOf('/') !== -1) continue;
                if (chipByHalf.has(code)) continue;   // it IS a half, not a truncation
                const isTruncation = halves.some(h =>
                    h.length > code.length &&
                    h.startsWith(code) &&
                    /^\d+$/.test(h.slice(code.length)));
                if (isTruncation) suspectCodes.add(code);
            }
            return { chipByHalf, halves, suspectCodes };
        } catch (e) {
            if (typeof DebugLog !== 'undefined' && DebugLog.warn) {
                DebugLog.warn('[API._detectTruncatedChips] skipped', e);
            }
            return empty;
        }
    },

    /** Fetch one code's products off /api/shop. Never throws. */
    async _productsForCode(brand, category, code) {
        const qs = new URLSearchParams();
        qs.append('brand', brand);
        qs.append('category', category);
        qs.append('code', code);
        qs.append('limit', '200');
        const res = await this.getWithSWR(`/api/shop?${qs.toString()}`).catch(() => null);
        return (res && res.ok && res.data && Array.isArray(res.data.products))
            ? res.data.products
            : [];
    },

    /**
     * Re-home truncated products onto the pair chip that actually owns them.
     * Handles both shapes of response:
     *   - drilldown (no params.code): rebuild the chip list.
     *   - code-filtered on a merged pair: recover the missing half's products,
     *     which is the deep-link / hard-refresh path where no chip cache exists.
     */
    async _repairTruncatedSeries(primary, params, truncated) {
        try {
            const SC = this._seriesCodes();
            if (!SC || typeof SC.trueCodeFromSku !== 'function') return primary;
            if (!primary || !primary.ok || !primary.data) return primary;
            if (!params || !params.brand || !params.category) return primary;

            if (params.code) {
                await this._repairPairCodeFilter(primary, params, SC);
                return primary;
            }

            const { chipByHalf, suspectCodes } = truncated || {};
            if (!suspectCodes || !suspectCodes.size) return primary;

            const series = primary.data.series;
            const suspects = series.filter(c =>
                c && c.code && suspectCodes.has(String(c.code).toUpperCase()));

            // Pass 1 — pull each suspect's products and sort them by the code
            // their SKU says they really carry.
            const fetched = await Promise.all(
                suspects.map(c => this._productsForCode(params.brand, params.category, c.code)));

            const rehomed = new Map();   // pair chip → products that belong to it
            const drop = new Set();

            suspects.forEach((chip, i) => {
                const code = String(chip.code).toUpperCase();
                const prods = fetched[i];
                if (!prods.length) return;

                const leftovers = [];
                for (const p of prods) {
                    const trueCode = SC.trueCodeFromSku(p && p.sku, code);
                    const target = (trueCode !== code) ? chipByHalf.get(trueCode) : null;
                    if (target) {
                        p.series_codes = [trueCode];
                        if (!rehomed.has(target)) rehomed.set(target, []);
                        rehomed.get(target).push(p);
                        continue;
                    }
                    // A product the SKU can't un-truncate is only stranded if no
                    // OTHER code of its own already puts it under a pair chip. The
                    // PG640/CL641 twin-packs are the case: SKU G-CAN-PG640-INK-2PK
                    // yields nothing, but they carry PG640 and so already sit in
                    // the pair — counting them as leftovers would keep the junk
                    // CL64 tile alive as a duplicate of PG640/CL641.
                    const homedElsewhere = ((p && p.series_codes) || []).some(c => {
                        const other = String(c || '').toUpperCase();
                        return other !== code && chipByHalf.has(other);
                    });
                    if (!homedElsewhere) leftovers.push(p);
                }

                // Only retire the suspect chip once every one of its products has
                // a new home — never silently drop products on the floor.
                if (!leftovers.length) {
                    drop.add(code);
                } else {
                    chip.count = leftovers.length;
                    chip.products = leftovers;
                }
            });

            if (!rehomed.size) return primary;

            // Pass 2 — a pair chip receiving products must end up holding its
            // COMPLETE set, not just the recovered half: shop-page reads
            // `chip.products` straight from the chip cache and skips its own
            // fetch, so a partial array would hide the products the backend
            // did file correctly (the PG510 blacks).
            const targets = [...rehomed.keys()];
            const owned = await Promise.all(
                targets.map(c => this._productsForCode(params.brand, params.category, c.code)));

            targets.forEach((chip, i) => {
                const extra = rehomed.get(chip);
                const base = owned[i];
                if (!base.length) {
                    // Couldn't confirm the chip's own products — bump the count so
                    // the tile is honest, but leave `products` unset so shop-page
                    // falls back to fetching rather than rendering a partial grid.
                    chip.count = (Number(chip.count) || 0) + extra.length;
                    return;
                }
                const merged = [];
                const seen = new Set();
                for (const p of base.concat(extra)) {
                    const key = (p && (p.id || p.sku)) || null;
                    if (key == null || seen.has(key)) continue;
                    seen.add(key);
                    merged.push(p);
                }
                chip.products = merged;
                chip.count = merged.length;
            });

            if (drop.size) {
                primary.data.series = series.filter(c =>
                    !(c && c.code && drop.has(String(c.code).toUpperCase())));
            }
        } catch (e) {
            if (typeof DebugLog !== 'undefined' && DebugLog.warn) {
                DebugLog.warn('[API._repairTruncatedSeries] skipped — chips left as backend sent them', e);
            }
        }
        return primary;
    },

    /**
     * Deep-link path: `?code=PG510/CL511` returns only the PG510 blacks, because
     * the CL511 products were filed under the truncated "CL51". For each half the
     * response is missing, re-request the half with its trailing digit shaved off
     * and keep only the products whose SKU proves they belong to this half (so
     * CL513 stays out of the PG510/CL511 grid).
     */
    async _repairPairCodeFilter(primary, params, SC) {
        const halves = SC.pairHalves(params.code);
        if (halves.length < 2) return;

        const products = Array.isArray(primary.data.products) ? primary.data.products : [];
        const seen = new Set(products.map(p => (p && (p.id || p.sku)) || null).filter(Boolean));
        const present = new Set();
        for (const p of products) {
            for (const c of (p && p.series_codes) || []) present.add(String(c).toUpperCase());
        }

        const recovered = [];
        for (const half of halves) {
            if (present.has(half)) continue;
            // One truncation level — the observed backend bug drops a single digit.
            const shaved = half.slice(0, -1);
            if (shaved.length < 3 || !/\d$/.test(shaved)) continue;

            const prods = await this._productsForCode(params.brand, params.category, shaved);
            for (const p of prods) {
                if (SC.trueCodeFromSku(p && p.sku, shaved) !== half) continue;
                const key = (p && (p.id || p.sku)) || null;
                if (key == null || seen.has(key)) continue;
                seen.add(key);
                p.series_codes = [half];
                recovered.push(p);
            }
        }

        if (recovered.length) {
            primary.data.products = products.concat(recovered);
            if (primary.meta && typeof primary.meta.total === 'number') {
                primary.meta.total += recovered.length;
            }
        }
    },

    // ─── Manual product codes (the product_codes override table) ──────────────
    // Admins assign categorisation codes in the product drawer; they persist to
    // the Supabase `product_codes` table (see inkcartridges/sql/product_codes.sql).
    // This block lets the storefront honour them:
    //   (1) a product WITH manual codes has its series_codes fully overridden;
    //   (2) the codes drilldown gains a chip for any purely-manual code;
    //   (3) clicking such a chip recovers the manually-tagged products the
    //       backend's series_codes filter never returned.
    // Fail-open throughout — any error leaves the backend response untouched, so
    // /shop can never break because the codes table is unreachable.

    _manualCodeCache: new Map(),   // key → { at:ms, value }
    _MANUAL_CODE_TTL: 60000,        // 60s — codes change rarely; admins see fresh on reload

    // apiCategory (the value shop-page passes as params.category) → product_type[].
    // Mirrors the category→product_type mapping in shop-page.js.
    _CATEGORY_PRODUCT_TYPES: {
        ink:     ['ink_cartridge', 'ink_bottle'],
        toner:   ['toner_cartridge'],
        drums:   ['drum_unit', 'waste_toner', 'belt_unit', 'fuser_kit', 'maintenance_kit'],
        label:   ['label_tape'],
        paper:   ['photo_paper'],
        ribbons: ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'],
    },

    /** GET against the Supabase REST API with the public anon key. JSON or null. */
    async _supabaseSelect(pathAndQuery) {
        try {
            const base = (typeof Config !== 'undefined' && Config.SUPABASE_URL) || '';
            const key  = (typeof Config !== 'undefined' && Config.SUPABASE_ANON_KEY) || '';
            if (!base || !key) return null;
            const res = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`, {
                headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        }
    },

    _manualCodeCacheGet(key) {
        const hit = this._manualCodeCache.get(key);
        if (hit && (Date.now() - hit.at) < this._MANUAL_CODE_TTL) return hit.value;
        return undefined;
    },
    _manualCodeCacheSet(key, value) {
        if (this._manualCodeCache.size > 240) this._manualCodeCache.clear();
        this._manualCodeCache.set(key, { at: Date.now(), value });
        return value;
    },

    /**
     * Manual codes for a set of product IDs → Map(productId → string[]).
     * IDs are chunked so the PostgREST `in.(…)` URL never grows unbounded.
     */
    async _fetchManualCodesByProduct(ids) {
        const map = new Map();
        const unique = [...new Set((ids || []).filter(Boolean))];
        if (!unique.length) return map;
        const CHUNK = 60;
        for (let i = 0; i < unique.length; i += CHUNK) {
            const slice = unique.slice(i, i + CHUNK);
            const cacheKey = 'codes:' + slice.join(',');
            let rows = this._manualCodeCacheGet(cacheKey);
            if (rows === undefined) {
                const list = slice.map(encodeURIComponent).join(',');
                rows = await this._supabaseSelect(`product_codes?select=product_id,code&product_id=in.(${list})`);
                this._manualCodeCacheSet(cacheKey, rows);
            }
            if (Array.isArray(rows)) {
                for (const r of rows) {
                    if (!r || !r.product_id || !r.code) continue;
                    if (!map.has(r.product_id)) map.set(r.product_id, []);
                    map.get(r.product_id).push(String(r.code).toUpperCase());
                }
            }
        }
        return map;
    },

    /**
     * Effective override codes for ONE product (the product_codes table) → string[].
     * The PDP uses this to honour a manually-assigned code the same way /shop does:
     * the override merge (_applyManualCodes) only runs on the getShopData path, so a
     * singly-loaded product (getProduct/getRibbon) never sees its manual codes. Reuses
     * the cached anon read below rather than forking a second query.
     */
    async getManualProductCodes(productId) {
        if (!productId) return [];
        const map = await this._fetchManualCodesByProduct([productId]);
        return (map && map.get(productId)) || [];
    },

    /** Manual chip counts for a brand+category → [{ code, count }]. */
    async _fetchManualChipCounts(brandSlug, productTypes) {
        if (!brandSlug || !Array.isArray(productTypes) || !productTypes.length) return [];
        const cacheKey = `chips:${brandSlug}:${productTypes.join(',')}`;
        let rows = this._manualCodeCacheGet(cacheKey);
        if (rows === undefined) {
            const types = productTypes.map(encodeURIComponent).join(',');
            rows = await this._supabaseSelect(
                `product_code_chip_counts?select=code,product_count`
                + `&brand_slug=eq.${encodeURIComponent(brandSlug)}&product_type=in.(${types})`);
            this._manualCodeCacheSet(cacheKey, rows);
        }
        if (!Array.isArray(rows)) return [];
        // View rows are per product_type — sum across types for one chip total.
        const byCode = new Map();
        for (const r of rows) {
            if (!r || !r.code) continue;
            const c = String(r.code).toUpperCase();
            byCode.set(c, (byCode.get(c) || 0) + (Number(r.product_count) || 0));
        }
        return [...byCode.entries()].map(([code, count]) => ({ code, count }));
    },

    /**
     * Normalise a code to the form stored in product_codes: uppercase, A-Z/0-9
     * and "/", with slashes collapsed and trimmed. Mirrors AdminAPI's
     * normalizeProductCode — the two must agree or a code the admin writes can't
     * be looked up here. "/" is kept because the backend's merged pair chips
     * (PG40/CL41) are real codes; stripping it made them unmatchable.
     */
    _normManualCode(code) {
        return String(code || '')
            .toUpperCase()
            .replace(/[^A-Z0-9/]/g, '')
            .replace(/\/{2,}/g, '/')
            .replace(/^\/+|\/+$/g, '');
    },

    /** Product IDs carrying a given manual code. */
    async _fetchProductIdsForCode(code) {
        const c = this._normManualCode(code);
        if (c.length < 2) return [];
        const cacheKey = 'forcode:' + c;
        let rows = this._manualCodeCacheGet(cacheKey);
        if (rows === undefined) {
            rows = await this._supabaseSelect(`product_codes?select=product_id&code=eq.${encodeURIComponent(c)}`);
            this._manualCodeCacheSet(cacheKey, rows);
        }
        return Array.isArray(rows) ? rows.map(r => r && r.product_id).filter(Boolean) : [];
    },

    /**
     * Apply the product_codes override layer to a /api/shop response, in place.
     * Runs at the tail of getShopData on the SWR-cloned response we own.
     * Fail-open: never throws — returns `primary` whatever happens.
     *
     * @param {Object} primary - the /api/shop response
     * @param {Object} params  - the original getShopData params
     */
    async _applyManualCodes(primary, params, truncated) {
        try {
            if (!primary || !primary.ok || !primary.data) return primary;
            const data = primary.data;
            const products = Array.isArray(data.products) ? data.products : [];

            // (1) Override series_codes on every returned product carrying
            //     manual codes — "manual fully replaces auto".
            if (products.length) {
                const codeMap = await this._fetchManualCodesByProduct(products.map(p => p && p.id));
                if (codeMap.size) {
                    for (const p of products) {
                        if (p && p.id && codeMap.has(p.id)) {
                            p.series_codes = [...new Set(codeMap.get(p.id))];
                        }
                    }
                }
            }

            // (2) Codes drilldown — ensure a chip exists for every manual code,
            //     so a purely-manual code (the LC57 case) still shows a tile.
            if (!params.code && params.brand && params.category && Array.isArray(data.series)) {
                const types = this._CATEGORY_PRODUCT_TYPES[String(params.category).toLowerCase()];
                if (types) {
                    const manualChips = await this._fetchManualChipCounts(params.brand, types);
                    if (manualChips.length) {
                        const have = new Set(data.series
                            .map(s => s && s.code && String(s.code).toUpperCase())
                            .filter(Boolean));
                        // A merged pair chip ("PG510/CL511") never equals either of
                        // its halves, so an exact-match `have` check lets a manual
                        // "PG510" push a duplicate tile covering the same products.
                        // Suppress anything the pair already speaks for: a half
                        // itself ("CL511"), a suffixed variant of one ("CL511CLR"),
                        // and the truncated code the repair pass is about to absorb
                        // ("CL51").
                        const halves = (truncated && truncated.halves) || [];
                        const suspects = (truncated && truncated.suspectCodes) || new Set();
                        const coveredByPair = code =>
                            suspects.has(code) || halves.some(h => code === h || code.startsWith(h));

                        let added = false;
                        for (const { code, count } of manualChips) {
                            if (!have.has(code) && !coveredByPair(code)) {
                                data.series.push({ code, count });
                                have.add(code);
                                added = true;
                            }
                        }
                        if (added) {
                            data.series.sort((a, b) => String(a.code)
                                .localeCompare(String(b.code), 'en', { numeric: true, sensitivity: 'base' }));
                        }
                    }
                }
            }

            // (3) Code-filtered grid — recover products manually tagged with
            //     the code that the backend's series_codes filter dropped.
            if (params.code && params.brand && params.category) {
                const manualIds = await this._fetchProductIdsForCode(params.code);
                if (manualIds.length) {
                    const present = new Set(products.map(p => p && p.id).filter(Boolean));
                    const missing = new Set(manualIds.filter(id => !present.has(id)));
                    if (missing.size) {
                        const fbQs = new URLSearchParams();
                        fbQs.append('brand', params.brand);
                        fbQs.append('category', params.category);
                        fbQs.append('limit', '200');
                        const pool = await this.getWithSWR(`/api/products?${fbQs.toString()}`).catch(() => null);
                        const poolProducts = (pool && pool.ok && pool.data && Array.isArray(pool.data.products))
                            ? pool.data.products : [];
                        // One batched read of every recoverable product's codes.
                        const ownCodes = await this._fetchManualCodesByProduct([...missing]);
                        const fallbackCode = this._normManualCode(params.code);
                        const recovered = [];
                        for (const p of poolProducts) {
                            if (!p || !p.id || !missing.has(p.id)) continue;
                            // Reflect the product's full manual code set.
                            p.series_codes = ownCodes.has(p.id)
                                ? [...new Set(ownCodes.get(p.id))]
                                : [fallbackCode];
                            recovered.push(p);
                            missing.delete(p.id);
                        }
                        if (recovered.length) {
                            data.products = products.concat(recovered);
                            if (primary.meta && typeof primary.meta.total === 'number') {
                                primary.meta.total += recovered.length;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            if (typeof DebugLog !== 'undefined' && DebugLog.warn) {
                DebugLog.warn('[API._applyManualCodes] skipped — manual codes not applied', e);
            }
        }
        return primary;
    },

    /**
     * Derive `series_codes` for a product whose backend value is empty.
     *
     * The backend's series-code extractor runs for genuine products (it reads
     * the manufacturer_part_number) but compatibles in the catalog ship with
     * `series_codes: []` because they don't carry that field. Their name and
     * SKU encode the family unambiguously:
     *
     *   sku  "C200XLBK"                                      → 200XL
     *   name "200XLBK Compatible Ink Cartridge for Epson 200XL C13T201192 Black"
     *                                                        → 200XL
     *   sku  "CBCI3CMY"                                      → BCI3
     *   name "BCI3CMY Compatible Ink Cartridge for Canon BCI3 BCI6 CMY 3-Pack"
     *                                                        → BCI3, BCI6
     *
     * Three patterns, applied in order; results unioned into one set:
     *
     *   1. SKU "C<CODE><COLOR_SUFFIX>" — the leading "C" is the catalog's
     *      compatible-prefix convention. Strip recognized colour/pack suffixes
     *      from the tail to recover the bare code.
     *   2. Leading word of the name e.g. "200XLBK" — same suffix-strip.
     *   3. Name "for <Brand> <CODE>[ <CODE2> …]" — captures multi-printer
     *      compatibles (Canon "BCI3 BCI6"). Tokens are kept only when they
     *      contain a digit (skips brand names, "PHOTO", etc).
     *
     * Mutates `product.series_codes` in place when at least one code is found.
     * No-op when the array is already populated (we trust the backend).
     *
     * @returns {boolean} true when codes were derived locally from name/sku,
     *   false when backend already supplied them (codes are still normalized)
     *   or when no codes could be derived. Callers (`getShopData`) use this
     *   to avoid double-counting compats the backend has already classified.
     */
    _enrichSeriesCodes(product) {
        if (!product || typeof product !== 'object') return false;
        const existing = Array.isArray(product.series_codes)
            ? product.series_codes.filter(c => c != null && String(c).trim())
            : [];
        if (existing.length) {
            // Normalize casing/whitespace even for backend-supplied values so
            // downstream comparisons (case-insensitive) hit consistently.
            product.series_codes = existing.map(c => String(c).trim().toUpperCase());
            return false; // backend supplied — not enriched locally
        }

        const codes = new Set();
        const sku = (product.sku || '').toString().trim();
        const name = (product.name || '').toString().trim();

        // Color/pack suffixes that trail a compatible's SKU body or name lead.
        // Order matters: longer suffixes first so PBK doesn't match BK then leave 'P',
        // MG/CY/YL beat the 1-char canon, and pack tokens (KCMY/CMYK/BCMY/CMY/MK)
        // win before single-letter colors so MK doesn't shred to "M" leaving a stray K.
        //
        // 1-char canon (K/C/M/Y) added May 2026 when backend collapsed the color
        // suffix (GLC73MG → GLC73M, GLC73CY → GLC73C). Without it the new SKUs fall
        // through and series_codes pick up "LC73M" instead of "LC73", breaking
        // compat grouping.
        //
        // The (?<!X)LC / (?<!X)LM lookbehinds keep "LC"/"LM" (light-cyan / light-
        // magenta specialty colors) from eating the "L" of an "XL" high-yield
        // body — e.g. "200XLC" must strip just the trailing "C", leaving "200XL",
        // not "200X". "200LC" still strips "LC" (preceded by a digit, not X).
        const COLOR_SUFFIX = /(?:KCMY|CMYK|BCMY|CMY|PBK|PCY|PMG|PYL|VLM|MK|PB|PC|PM|PY|MB|(?<!X)LC|(?<!X)LM|BK|CY|MG|YL|RD|GN|BL|VT|GR|WH|OR|PK|K|C|M|Y)$/;

        const stripSuffix = (token) => {
            if (!token) return '';
            let body = token.toUpperCase();
            // Strip recognized suffix once (avoids over-stripping eg "TN243BK" -> "TN243").
            const stripped = body.replace(COLOR_SUFFIX, '');
            // If stripping removed at least one char and what's left contains a
            // digit, treat that as the code. Otherwise return the body itself
            // when it already contains a digit (the SKU body IS the code).
            if (stripped !== body && /\d/.test(stripped) && stripped.length >= 2) return stripped;
            if (/\d/.test(body) && body.length >= 2) return body;
            return '';
        };

        // 1. SKU pattern: "C<body>"
        const skuMatch = sku.match(/^C([A-Z0-9-]+)$/i);
        if (skuMatch) {
            const code = stripSuffix(skuMatch[1]);
            if (code) codes.add(code);
        }

        if (name) {
            const upper = name.toUpperCase();

            // 2. Leading word of the name e.g. "200XLBK Compatible..."
            const lead = upper.match(/^([A-Z0-9-]+)\b/);
            if (lead) {
                const code = stripSuffix(lead[1]);
                if (code) codes.add(code);
            }

            // 3. "for <Brand> <CODE>[ <CODE2> …]" pattern. Capture body until
            // a paren, color word, pack token, or end of string.
            const STOP = '(?:\\(|BLACK|CYAN|MAGENTA|YELLOW|TRI[- ]?COLOU?R|LIGHT\\s+(?:CYAN|MAGENTA)|PHOTO\\s+(?:BLACK|CYAN|MAGENTA)|RED|BLUE|GREEN|GREY|GRAY|VIOLET|ORANGE|WHITE|PINK|CMY|KCMY|CMYK|\\d+\\s*-?\\s*PACK|VALUE\\s+PACK|MULTI-?PACK|XL\\s+VALUE)';
            const forMatch = upper.match(new RegExp(`\\bFOR\\s+[A-Z][A-Z0-9-]*\\s+(.+?)(?=\\s+${STOP}|$)`));
            if (forMatch && forMatch[1]) {
                forMatch[1].split(/\s+/).forEach(tok => {
                    const t = tok.replace(/[^A-Z0-9-]/g, '');
                    if (!t) return;
                    if (!/\d/.test(t)) return;          // skip brand words
                    if (t.length < 2 || t.length > 12) return;
                    codes.add(t);
                });
            }
        }

        if (codes.size) {
            product.series_codes = [...codes];
            return true;
        }
        return false;
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
     * see .claude/memory/errors.md). The fallback keeps user-facing product pages
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
        // Code comparison is case-insensitive — backend ships `not_found`
        // today and the historical contract is `NOT_FOUND`; either matches.
        const rawCode = primary.body && primary.body.error && primary.body.error.code;
        const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : rawCode;
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
            // Public read: omit cookies when anonymous so it hits the Cloudflare
            // edge cache (see api-subdomain cutover note in _fetchWithAuth).
            res = await fetch(url, { method: 'GET', headers, credentials: token ? 'include' : 'omit' });
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
     * Get products compatible with a printer — strict, via product_compatibility.
     *
     * Canonical endpoint per backend (2026-05-11): `/api/products/printer/:slug`
     * carries the full enrich + sanitize + pack-guard + cousin-collapse
     * pipeline. The previously-aliased `/api/printers/:slug/products` is
     * deprecated and was retired from the frontend on 2026-05-12.
     *
     * @param {string} printerSlug - Printer slug (e.g. "brother-mfc-j6945dw")
     * @param {object} [params] - Optional { page, limit, type, source }
     */
    async getProductsByPrinter(printerSlug, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = `/api/products/printer/${encodeURIComponent(printerSlug)}${query ? `?${query}` : ''}`;
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
        // SWR (5-min TTL) so the init + popstate + pageshow burst on the same
        // brand/category URL collapses to one request instead of tripping the
        // backend rate limiter (429). FE audit Jun 2026, ERR-049.
        return this.getWithSWR(`/api/schema/collection?${query}`, { ttl: 5 * 60 * 1000 });
    },

    /**
     * Get CollectionPage + BreadcrumbList JSON-LD for a printer landing page.
     * @param {string} printerSlug - Printer slug (e.g. "brother-mfc-j870")
     */
    async getPrinterSchema(printerSlug) {
        // SWR for the same burst-on-navigation reason as getCollectionSchema.
        return this.getWithSWR(`/api/schema/printer/${encodeURIComponent(printerSlug)}`, { ttl: 5 * 60 * 1000 });
    },

    /**
     * Get site-wide Organization / WebSite / LocalBusiness JSON-LD. Embed in every
     * page <head> per spec §5.6. Use SWR so repeated page loads don't re-fetch.
     */
    async getSiteSchema() {
        return this.getWithSWR('/api/schema/site', { ttl: 5 * 60 * 1000 });
    },

    /**
     * Get the canonical navigation feed (categories + brands + links) from the
     * one backend taxonomy, so the header/mega-nav/footer can never drift from
     * what /api/shop accepts (IA reorg, Jul 2026). CDN-cached 1h server-side;
     * SWR here for the same burst-collapse reason as getCollectionSchema
     * (ERR-049). Consumers fail open to their static markup on any error.
     */
    async getSiteNav() {
        return this.getWithSWR('/api/site/nav', { ttl: 5 * 60 * 1000 });
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
     * Typeahead suggest — the literal-substring search the dropdown uses.
     *
     * This is the SAME endpoint search.js's fetchSuggest hits, surfaced on
     * the API object so the full results page can reconcile against it.
     * /api/search/smart classifies "intent" and will autocorrect a query it
     * judges ambiguous (q=511 → "Lexmark MX 511"); /api/search/suggest does a
     * plain substring match and returns exactly what the dropdown shows.
     * loadSearchResults unions this shortlist into its fallback so the two
     * surfaces can never disagree. Pinned by
     * tests/search-results-parity-may2026.test.js.
     *
     * Returns a bare array of suggestion rows (never throws — yields [] on
     * any failure so the caller's reconcile path degrades gracefully). The
     * backend caps `limit` low (≈20); values above that return an empty set,
     * so callers should request 20 or fewer.
     *
     * @param {string} query - Raw user query.
     * @param {number} limit - Max rows (default 10, keep <= 20).
     * @returns {Promise<Array>} suggestion rows, or [] on miss/failure.
     */
    async searchSuggest(query, limit = 10) {
        if (!query || String(query).trim().length < 2) return [];
        try {
            const params = new URLSearchParams({ q: query, limit: String(limit) });
            const res = await this.get(`/api/search/suggest?${params}`);
            if (res && res.ok && res.data && Array.isArray(res.data.suggestions)) {
                return res.data.suggestions;
            }
        } catch (_) { /* swallow — caller treats [] as "no suggest data" */ }
        return [];
    },

    /**
     * Get printers for a brand, already grouped by series.
     *
     * Returns `{ ok, data: { brand, series_groups: [{ id, name, model_count,
     * models: [{ id, model_name, full_name, slug, series }] }], total_models } }`.
     * Groups are alphabetised with "Other Models" forced last; models inside
     * each group are natural-sorted by name. `exclude_non_ink=true` strips
     * label makers, scanners, dot-matrix, etc. so the ink-finder dropdown only
     * shows devices that take cartridges.
     *
     * Pass `{ grouped: false }` for the empty-state fallback documented in
     * readfirst/ink-finder-may2026.md — rare brands (e.g. Dymo) where the
     * series taxonomy collapses to one group so the cascade adds no value.
     * The flat shape is `{ ok, data: { brand, printers: [{ id, model_name,
     * full_name, slug, series }] } }`.
     *
     * Spec: readfirst/ink-finder-may2026.md (May 2026 wiring contract);
     * docs/storefront/value-pack-and-product-url-contract.md §4.2.1
     * (grouped endpoint shipped May 2026).
     *
     * @param {string} brand - Brand slug (e.g. "canon"). Lower-cased + URL-encoded.
     * @param {{ grouped?: boolean }} [opts] - { grouped: false } for the flat fallback.
     */
    async getPrintersByBrand(brand, opts) {
        const slug = encodeURIComponent(String(brand || '').toLowerCase());
        const grouped = !(opts && opts.grouped === false);
        const qs = grouped
            ? 'grouped=true&exclude_non_ink=true'
            : 'grouped=false&exclude_non_ink=true';
        return this.get(`/api/printers/by-brand/${slug}?${qs}`);
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
     * Apply (or update) a loyalty-points redemption directly to the live cart.
     * Backend re-validates and clamps; returns the FULL cart (same shape as getCart).
     * @param {number} points - positive integer, multiple of 100 (>= min_redemption_points)
     */
    async applyLoyaltyPoints(points) {
        return this.post('/api/cart/loyalty', { points });
    },

    /**
     * Remove the loyalty-points redemption from the cart. Idempotent.
     * Returns the refreshed full cart with loyalty.points_applied = 0.
     */
    async removeLoyaltyPoints() {
        return this.delete('/api/cart/loyalty');
    },

    /**
     * Get the user's loyalty points balance, ledger history and redemption options.
     * @param {{page?: number, limit?: number}} [opts]
     */
    async getLoyalty({ page = 1, limit = 20 } = {}) {
        const params = new URLSearchParams();
        params.append('page', page);
        params.append('limit', limit);
        return this.get(`/api/user/loyalty?${params.toString()}`);
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
     * Request a tracking update for an order (May 2026 request-based model).
     *
     * We no longer surface tracking automatically. The customer submits their
     * order number (and the email used to place the order) and we notify the
     * opted-in admins, who reply with the carrier + tracking number + status —
     * that admin action is what emails the customer their tracking details.
     *
     * The endpoint is intentionally NON-ENUMERATING: it returns a generic
     * success regardless of whether the order exists or the email matches, so
     * a stranger guessing order numbers learns nothing. The frontend therefore
     * shows the same confirmation for every 2xx response.
     *
     * @param {{ order_number: string, email?: string }} payload
     */
    async requestOrderTracking(payload) {
        return this.post('/api/orders/track-request', {
            order_number: payload.order_number,
            email: payload.email || null,
        });
    },

    /**
     * Look up live tracking for an order and return it for INLINE display
     * (June 2026 inline-tracking model).
     *
     * Unlike requestOrderTracking() — which only registers a "notify me when it
     * ships" request — this returns the full tracking payload in the HTTP
     * response so /track-order can render it immediately: status + status_label,
     * the progress timeline, tracking number / carrier / tracking_url, estimated
     * delivery, and the live courier `tracking_events`.
     *
     * Anti-enumeration (by backend design): a wrong email and a non-existent
     * order both return the SAME 404 envelope
     *   { ok:false, code:'NOT_FOUND', error:'<generic message>' }
     * Callers MUST NOT try to tell the customer which field was wrong — surface
     * response.error verbatim. Malformed input → VALIDATION_FAILED (with
     * details[]); too many lookups → RATE_LIMITED (15 req / 15 min per IP).
     *
     * @param {{ order_number: string, email: string }} payload
     */
    async trackLookup(payload) {
        return this.post('/api/orders/track-lookup', {
            order_number: payload.order_number,
            email: payload.email,
        });
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
// stock-enquiry-may2026 — single source of truth for the out-of-stock pill
// copy. Every OOS surface (PDP buy box, products grid, shop, ribbons) renders
// getStockStatus().text, so updating this one string re-labels the whole site.
// The pill carries the full call-to-action ("Contact Us For Stock Enquiries");
// the separate bottom-of-card / PDP button keeps the short "Contact us" label.
const OOS_STOCK_LABEL = 'Contact Us For Stock Enquiries';

function getStockStatus(product) {
    // contact-button-may2026.md / stock-enquiry-may2026 — for an out-of-stock
    // product the inline pill spells out the action, "Contact Us For Stock
    // Enquiries", instead of a bare "Out of stock" status. The class name
    // 'contact-us' is intentionally retained so existing CSS keeps working;
    // components.css lets this longer copy wrap inside the card footer row.
    if (product.stock_status === 'contact_us') {
        return { class: 'contact-us', text: OOS_STOCK_LABEL, icon: 'phone' };
    }
    if (product.stock_status === 'out_of_stock') {
        return { class: 'contact-us', text: OOS_STOCK_LABEL, icon: 'phone' };
    }
    if (product.stock_status === 'in_stock') {
        return { class: 'in-stock', text: 'In Stock', icon: 'check-circle' };
    }
    // Fallback for endpoints that don't return stock_status (listing, search)
    const inStock = product.in_stock !== undefined ? product.in_stock : (product.stock_quantity > 0);
    if (!inStock) {
        return { class: 'contact-us', text: OOS_STOCK_LABEL, icon: 'phone' };
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

// Make API available globally
window.API = API;
window.formatPrice = formatPrice;
window.getStockStatus = getStockStatus;
window.qualifiesForFreeShipping = qualifiesForFreeShipping;
window.calculateGST = calculateGST;
// Test hook — used by __tests__/search-enrichment.test.js. Not part of the
// public API surface; do not call from product code.
window._normalizeRpcSearchResponse = _normalizeRpcSearchResponse;
