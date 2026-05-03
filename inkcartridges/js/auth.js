/**
 * AUTH.JS
 * =======
 * Supabase Authentication for InkCartridges.co.nz
 */

const Auth = {
    supabase: null,
    session: null,
    user: null,
    listeners: [],
    initialized: false,
    readyPromise: null,
    _resolveReady: null,

    /**
     * Initialize Supabase client
     */
    async init() {
        // Create ready promise if not already created
        if (!this.readyPromise) {
            this.readyPromise = new Promise(resolve => { this._resolveReady = resolve; });
        }

        // Check if Supabase is loaded
        if (typeof supabase === 'undefined' || !supabase.createClient) {
            DebugLog.warn('Supabase SDK not loaded. Auth features disabled.');
            if (this._resolveReady) this._resolveReady();
            return false;
        }

        try {
            this.supabase = supabase.createClient(
                Config.SUPABASE_URL,
                Config.SUPABASE_ANON_KEY
            );

            // Get initial session
            const { data: { session } } = await this.supabase.auth.getSession();
            this.session = session;
            this.user = session?.user ?? null;
            if (session) this._setAuthCookie(); else this._clearAuthCookie();

            // Listen for auth changes
            this.supabase.auth.onAuthStateChange(async (event, session) => {
                const wasAuthenticated = this.isAuthenticated();
                this.session = session;
                this.user = session?.user ?? null;
                const isNowAuthenticated = this.isAuthenticated();
                if (isNowAuthenticated) this._setAuthCookie(); else this._clearAuthCookie();

                // Handle sign in events - sync data
                if (event === 'SIGNED_IN' || (isNowAuthenticated && !wasAuthenticated)) {
                    // CRITICAL: Sync account profile first (creates profile if first login)
                    if (typeof API !== 'undefined') {
                        try {
                            const turnstileToken = await this.getTurnstileToken();
                            const syncResult = await API.accountSync(turnstileToken);
                            if (syncResult && !syncResult.ok && syncResult.code === 'DISPOSABLE_EMAIL') {
                                if (typeof showToast === 'function') {
                                    showToast('This email provider is not supported. Please use a permanent email address.', 'error', 0);
                                }
                                return; // Stop post-login flow
                            }
                        } catch (e) {
                            DebugLog.warn('accountSync failed:', e.message);
                            if (typeof showToast === 'function') {
                                showToast('Account sync failed. Some features may not work.', 'error');
                            }
                        }
                    }

                    // Run remaining calls in parallel — they are independent of each other
                    const postLoginTasks = [];

                    if (typeof API !== 'undefined') {
                        postLoginTasks.push(
                            API.getAccountMe().catch(e => {
                                DebugLog.warn('getAccountMe failed:', e.message);
                            })
                        );
                    }

                    if (typeof Favourites !== 'undefined') {
                        postLoginTasks.push(
                            Favourites.onAuthStateChange(true).catch(e => {
                                DebugLog.warn('loadFavourites failed:', e.message);
                            })
                        );
                    }

                    await Promise.allSettled(postLoginTasks);
                }

                // Handle sign out - notify favourites to reload from localStorage
                if (event === 'SIGNED_OUT' && typeof Favourites !== 'undefined' && Favourites.onAuthStateChange) {
                    Favourites.onAuthStateChange(false);
                }

                // Notify listeners
                this.listeners.forEach(callback => callback(event, session));

                // Update UI
                this.updateUI();
            });

            // Initial UI update
            this.updateUI();

            // Mark as initialized
            this.initialized = true;
            if (this._resolveReady) this._resolveReady();

            return true;
        } catch (error) {
            DebugLog.error('Auth init error:', error);
            this.initialized = true; // Mark initialized even on error so we don't hang
            if (this._resolveReady) this._resolveReady();
            return false;
        }
    },

    /**
     * Get a Turnstile token for bot verification.
     * Dynamically loads the Turnstile script to avoid editing all HTML files.
     * Returns null if Turnstile is not configured or fails (non-blocking).
     */
    async getTurnstileToken() {
        const siteKey = typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY;
        if (!siteKey) return null;

        // Dynamically load Turnstile script if not already present
        if (typeof turnstile === 'undefined') {
            await new Promise((resolve) => {
                const existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
                if (existing) { existing.addEventListener('load', resolve); return; }
                const s = document.createElement('script');
                s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                s.onload = resolve;
                s.onerror = () => resolve(); // Don't block login if script fails
                document.head.appendChild(s);
            });
        }

        if (typeof turnstile === 'undefined') return null;

        // Create a hidden container for the invisible widget
        let container = document.getElementById('auth-turnstile');
        if (!container) {
            container = document.createElement('div');
            container.id = 'auth-turnstile';
            container.style.display = 'none';
            document.body.appendChild(container);
        }

        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 8000);
            const done = (val) => { clearTimeout(timeout); resolve(val); };
            // Remove any previous widget in this container
            turnstile.remove('#auth-turnstile');
            turnstile.render('#auth-turnstile', {
                sitekey: siteKey,
                action: 'account-sync',
                execution: 'execute',
                appearance: 'interaction-only',
                callback: (token) => done(token),
                'error-callback': () => done(null),
                'expired-callback': () => done(null)
            });
            turnstile.execute('#auth-turnstile');
        });
    },

    /**
     * Sign up with email and password
     * @param {string} email
     * @param {string} password
     */
    async signUp(email, password) {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { data, error } = await this.supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: `${window.location.origin}/account/verify-email`
            }
        });

        return { data, error };
    },

    /**
     * Sign in with email and password
     * @param {string} email
     * @param {string} password
     */
    async signIn(email, password) {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { data, error } = await this.supabase.auth.signInWithPassword({
            email,
            password
        });

        return { data, error };
    },

    /**
     * Sign out
     */
    async signOut() {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { error } = await this.supabase.auth.signOut();

        // Clear local cart on sign out
        if (typeof Cart !== 'undefined') {
            Cart.clear();
        }
        try { localStorage.removeItem('cart_count'); } catch (e) { /* ignore */ }

        // Clear favourites in memory on sign out
        if (typeof Favourites !== 'undefined') {
            Favourites.onAuthStateChange(false);
        }

        // Clear any session-specific data (e.g., order data from payment flow)
        try {
            sessionStorage.clear();
        } catch (e) { /* storage may be unavailable */ }

        return { error };
    },

    /**
     * Update user password
     * @param {string} newPassword - The new password
     */
    async updatePassword(newPassword) {
        if (!this.supabase) return { ok: false, error: 'Auth not initialized' };

        try {
            const { data, error } = await this.supabase.auth.updateUser({
                password: newPassword
            });

            if (error) {
                return { ok: false, error: error.message };
            }

            return { ok: true, data };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    /**
     * Refresh the session
     */
    async refreshSession() {
        if (!this.supabase) return false;

        const { data: { session }, error } = await this.supabase.auth.refreshSession();
        if (error) {
            DebugLog.error('Session refresh failed:', error);
            return false;
        }

        this.session = session;
        this.user = session?.user ?? null;
        return true;
    },

    /**
     * Send password reset email via backend.
     * Backend always returns success to prevent email enumeration.
     * @param {string} email
     */
    async resetPassword(email) {
        try {
            const res = await fetch(`${Config.API_URL}/api/auth/request-password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });

            if (res.status === 429) {
                return { error: { message: 'Too many requests. Please wait a minute before trying again.' } };
            }

            if (!res.ok) {
                let msg = 'Failed to send reset email. Please try again.';
                try {
                    const body = await res.json();
                    msg = body?.error?.message || body?.message || msg;
                } catch (_) { /* ignore */ }
                return { error: { message: msg } };
            }

            return { data: { ok: true } };
        } catch (err) {
            return { error: { message: 'Network error. Please check your connection and try again.' } };
        }
    },

    /**
     * Sign in with Google
     */
    async signInWithGoogle() {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { data, error } = await this.supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/account/`,
                queryParams: {
                    prompt: 'select_account'
                }
            }
        });

        return { data, error };
    },

    _setAuthCookie() {
        document.cookie = '__ink_auth=1; path=/; SameSite=Strict; max-age=604800';
    },

    _clearAuthCookie() {
        document.cookie = '__ink_auth=; path=/; SameSite=Strict; max-age=0';
    },

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return !!this.session;
    },

    /**
     * Get current user
     */
    getUser() {
        return this.user;
    },

    /**
     * Add auth state change listener
     * @param {function} callback
     */
    onAuthStateChange(callback) {
        this.listeners.push(callback);
    },

    /**
     * Update UI based on auth state
     */
    updateUI() {
        const authLinks = document.querySelectorAll('.auth-link');
        const userMenus = document.querySelectorAll('.user-menu');
        const guestMenus = document.querySelectorAll('.guest-menu');
        const userNames = document.querySelectorAll('.user-name');

        if (this.isAuthenticated()) {
            // Show user menus, hide guest menus
            authLinks.forEach(el => el.style.display = 'none');
            guestMenus.forEach(el => el.style.display = 'none');
            userMenus.forEach(el => el.style.display = 'block');

            // Update user name displays
            if (this.user) {
                const displayName = this.user.user_metadata?.full_name ||
                    this.user.email?.split('@')[0] ||
                    'User';
                userNames.forEach(el => el.textContent = displayName);
            }
        } else {
            // Show guest menus, hide user menus
            authLinks.forEach(el => el.style.display = 'block');
            guestMenus.forEach(el => el.style.display = 'block');
            userMenus.forEach(el => el.style.display = 'none');
        }
    },

    /**
     * Require authentication - redirect if not logged in
     * @param {string} redirectUrl - URL to redirect after login
     */
    requireAuth(redirectUrl = null) {
        if (!this.isAuthenticated()) {
            const returnUrl = redirectUrl || window.location.pathname;
            // Ensure returnUrl is a relative path (safeRedirect rejects absolute URLs)
            const safePath = returnUrl.startsWith('/') ? returnUrl : new URL(returnUrl, window.location.origin).pathname;
            window.location.href = `/account/login?redirect=${encodeURIComponent(safePath)}`;
            return false;
        }
        return true;
    },

    /**
     * Require verified email — redirects unverified users to verify-email page.
     * Returns true if verified (or not applicable), false if redirecting.
     */
    async requireVerifiedEmail() {
        // Guest browsing is fine
        if (!this.isAuthenticated()) return true;

        // OAuth users (e.g. Google) have inherently verified emails
        const provider = this.user?.app_metadata?.provider;
        if (provider && provider !== 'email') return true;

        // Fast path: check Supabase session field
        if (this.user?.email_confirmed_at) return true;

        // Fallback: check via backend API
        try {
            const response = await API.getVerificationStatus();
            if (response.ok && response.data && response.data.email_verified) {
                return true;
            }
        } catch (error) {
            // Fail closed — treat errors as unverified
        }

        // Unverified — redirect
        window.location.href = '/account/verify-email';
        return false;
    },

    /**
     * Check if email is verified and show banner if not
     */
    async checkEmailVerification() {
        if (!this.isAuthenticated()) return;

        try {
            const response = await API.getVerificationStatus();
            if (response.ok && response.data) {
                const isVerified = response.data.email_verified;
                if (!isVerified) {
                    this.showVerificationBanner();
                }
                return isVerified;
            }
        } catch (error) {
            // Could not check verification status
        }
        return false; // Deny by default if verification check fails
    },

    /**
     * Show email verification banner
     */
    showVerificationBanner() {
        // Don't show if already showing
        if (document.getElementById('verification-banner')) return;

        const banner = document.createElement('div');
        banner.id = 'verification-banner';
        banner.className = 'verification-banner';
        banner.innerHTML = `
            <div class="verification-banner__content">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>Please verify your email address to place orders.</span>
                <button type="button" class="verification-banner__btn" id="resend-verification-btn">
                    Resend Email
                </button>
                <button type="button" class="verification-banner__close" aria-label="Dismiss">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        `;

        // Insert at the top of the page
        document.body.insertBefore(banner, document.body.firstChild);

        // Handle resend button
        document.getElementById('resend-verification-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Sending...';

            try {
                const response = await API.resendVerificationEmail();
                if (response.ok) {
                    btn.textContent = 'Email Sent!';
                    setTimeout(() => {
                        btn.textContent = 'Resend Email';
                        btn.disabled = false;
                    }, 3000);
                } else {
                    btn.textContent = 'Failed - Try Again';
                    btn.disabled = false;
                }
            } catch (error) {
                btn.textContent = 'Failed - Try Again';
                btn.disabled = false;
            }
        });

        // Handle close button
        banner.querySelector('.verification-banner__close').addEventListener('click', () => {
            banner.remove();
        });
    }
};

// Create ready promise eagerly so consumers can await it before init() runs
Auth.readyPromise = new Promise(resolve => { Auth._resolveReady = resolve; });

// Initialize auth when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Auth.init();
});

// Make Auth available globally
window.Auth = Auth;
