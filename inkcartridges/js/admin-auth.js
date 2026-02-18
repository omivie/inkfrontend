/**
 * ADMIN AUTH MODULE
 * Handles admin authentication and authorization
 * Based on frontend-backend-admin-contract.md
 */

const AdminAuth = {
    // Admin state
    isAdmin: false,
    role: null,
    roles: [],
    email: null,
    verified: false,

    /**
     * Initialize admin authentication
     * Call this on every admin page load
     * @returns {Promise<boolean>} True if user has admin access
     */
    async init() {
        // Wait for Auth to be ready
        if (typeof Auth !== 'undefined' && !Auth.initialized) {
            await this.waitForAuth();
        }

        // Check if user is logged in
        if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
            this.redirectToLogin();
            return false;
        }

        // Verify admin access
        const verified = await this.verifyAdminAccess();

        if (!verified) {
            this.showAccessDenied();
            return false;
        }

        this.verified = true;
        this.updateUI();
        return true;
    },

    /**
     * Wait for Auth module to initialize
     */
    async waitForAuth() {
        return new Promise((resolve) => {
            const check = setInterval(() => {
                if (typeof Auth !== 'undefined' && Auth.initialized) {
                    clearInterval(check);
                    resolve();
                }
            }, 100);

            // Timeout after 5 seconds
            setTimeout(() => {
                clearInterval(check);
                resolve();
            }, 5000);
        });
    },

    /**
     * Verify admin access via API
     * Admin must have super_admin role in admin_roles table
     * @returns {Promise<boolean>}
     */
    async verifyAdminAccess() {
        try {
            if (typeof API === 'undefined') {
                console.error('AdminAuth: API not available');
                return false;
            }

            const response = await API.verifyAdmin();

            if (response.success && response.data?.is_admin) {
                this.isAdmin = true;
                this.role = response.data.role;
                this.roles = response.data.roles || [response.data.role];
                this.email = response.data.email;
                return true;
            }

            return false;
        } catch (error) {
            console.error('AdminAuth: Verification failed', error);
            return false;
        }
    },

    /**
     * Check if user has a specific role
     * @param {string} role - Role to check
     * @returns {boolean}
     */
    hasRole(role) {
        return this.roles.includes(role) || this.roles.includes('super_admin');
    },

    /**
     * Check if user can perform an action
     * @param {string} action - Action to check
     * @returns {boolean}
     */
    canPerform(action) {
        const permissions = {
            // Order permissions
            'view_orders': ['super_admin', 'order_manager', 'stock_manager'],
            'update_orders': ['super_admin', 'order_manager'],
            'cancel_orders': ['super_admin', 'order_manager'],

            // Product permissions
            'view_products': ['super_admin', 'order_manager', 'stock_manager'],
            'update_products': ['super_admin', 'stock_manager'],
            'manage_inventory': ['super_admin', 'stock_manager'],

            // Customer permissions
            'view_customers': ['super_admin', 'order_manager'],

            // Analytics permissions
            'view_analytics': ['super_admin', 'order_manager', 'stock_manager'],

            // Settings permissions
            'manage_settings': ['super_admin']
        };

        const allowedRoles = permissions[action] || ['super_admin'];
        return this.roles.some(role => allowedRoles.includes(role));
    },

    /**
     * Redirect to login page
     */
    redirectToLogin() {
        const currentPath = window.location.pathname;
        window.location.href = `/html/account/login.html?redirect=${encodeURIComponent(currentPath)}`;
    },

    /**
     * Show access denied message
     */
    showAccessDenied() {
        const main = document.querySelector('main') || document.body;
        main.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; text-align: center; padding: 2rem;">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#C71F6E" stroke-width="2" style="margin-bottom: 1rem;">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <h1 style="font-size: 1.5rem; color: #1a1a1a; margin: 0 0 0.5rem;">Access Denied</h1>
                <p style="color: #64748b; margin: 0 0 1.5rem;">You don't have permission to access the admin panel.</p>
                <a href="/html/index.html" style="color: #267FB5; text-decoration: none; font-weight: 500;">
                    &larr; Return to Homepage
                </a>
            </div>
        `;
    },

    /**
     * Update UI based on admin role
     */
    updateUI() {
        // Show admin email in header if element exists
        const adminEmailEl = document.getElementById('admin-email');
        if (adminEmailEl && this.email) {
            adminEmailEl.textContent = this.email;
        }

        // Show admin role badge if element exists
        const adminRoleEl = document.getElementById('admin-role');
        if (adminRoleEl && this.role) {
            const roleLabels = {
                'super_admin': 'Super Admin',
                'order_manager': 'Order Manager',
                'stock_manager': 'Stock Manager'
            };
            adminRoleEl.textContent = roleLabels[this.role] || this.role;
        }

        // Hide/show elements based on permissions
        document.querySelectorAll('[data-permission]').forEach(el => {
            const permission = el.dataset.permission;
            if (!this.canPerform(permission)) {
                el.style.display = 'none';
            }
        });

        // Hide/show elements based on role
        document.querySelectorAll('[data-role]').forEach(el => {
            const requiredRole = el.dataset.role;
            if (!this.hasRole(requiredRole)) {
                el.style.display = 'none';
            }
        });
    },

    /**
     * Logout admin
     */
    async logout() {
        if (typeof Auth !== 'undefined') {
            await Auth.signOut();
        }
        window.location.href = '/html/account/login.html';
    }
};

// Make available globally
window.AdminAuth = AdminAuth;
