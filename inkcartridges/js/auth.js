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

    /**
     * Initialize Supabase client
     */
    async init() {
        // Check if Supabase is loaded
        if (typeof supabase === 'undefined' || !supabase.createClient) {
            console.warn('Supabase SDK not loaded. Auth features disabled.');
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

            // Listen for auth changes
            this.supabase.auth.onAuthStateChange(async (event, session) => {
                const wasAuthenticated = this.isAuthenticated();
                this.session = session;
                this.user = session?.user ?? null;
                const isNowAuthenticated = this.isAuthenticated();

                // Handle sign in events - sync data
                if (event === 'SIGNED_IN' || (isNowAuthenticated && !wasAuthenticated)) {
                    // CRITICAL: Sync account profile (creates profile if first login)
                    if (typeof API !== 'undefined') {
                        try {
                            await API.accountSync();
                        } catch (e) {
                            // Account sync failed silently — profile-dependent features may not work
                        }
                    }

                    // Merge guest cart to user cart
                    if (typeof API !== 'undefined') {
                        try {
                            await API.mergeCart();
                        } catch (e) {
                            // Cart merge failed silently
                        }
                    }

                    // Sync favourites from localStorage to server
                    if (typeof Favourites !== 'undefined' && Favourites.syncOnLogin) {
                        try {
                            await Favourites.syncOnLogin();
                        } catch (e) {
                            // Favourites sync failed silently
                        }
                    }
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

            return true;
        } catch (error) {
            console.error('Auth init error:', error);
            this.initialized = true; // Mark initialized even on error so we don't hang
            return false;
        }
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
            password
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

        // Clear favourites localStorage to prevent data leakage on shared devices
        try {
            localStorage.removeItem('inkcartridges_favourites');
        } catch (e) { /* storage may be unavailable */ }

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
        if (!this.supabase) return { success: false, error: 'Auth not initialized' };

        try {
            const { data, error } = await this.supabase.auth.updateUser({
                password: newPassword
            });

            if (error) {
                return { success: false, error: error.message };
            }

            return { success: true, data };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    /**
     * Refresh the session
     */
    async refreshSession() {
        if (!this.supabase) return false;

        const { data: { session }, error } = await this.supabase.auth.refreshSession();
        if (error) {
            console.error('Session refresh failed:', error);
            return false;
        }

        this.session = session;
        this.user = session?.user ?? null;
        return true;
    },

    /**
     * Send password reset email
     * @param {string} email
     */
    async resetPassword(email) {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { data, error } = await this.supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/html/account/reset-password.html`
        });

        return { data, error };
    },

    /**
     * Sign in with Google
     */
    async signInWithGoogle() {
        if (!this.supabase) return { error: { message: 'Auth not initialized' } };

        const { data, error } = await this.supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: `${window.location.origin}/html/account/index.html`
            }
        });

        return { data, error };
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
            const returnUrl = redirectUrl || window.location.href;
            window.location.href = `/html/account/login.html?redirect=${encodeURIComponent(returnUrl)}`;
            return false;
        }
        return true;
    },

    /**
     * Check if email is verified and show banner if not
     */
    async checkEmailVerification() {
        if (!this.isAuthenticated()) return;

        try {
            const response = await API.getVerificationStatus();
            if (response.success && response.data) {
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
                if (response.success) {
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

// Initialize auth when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Auth.init();
});

// Make Auth available globally
window.Auth = Auth;
