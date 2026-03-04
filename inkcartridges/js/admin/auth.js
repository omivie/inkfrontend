/**
 * AdminAuth — Role-gated admin authentication
 * Wraps the global Auth module with admin-specific verification
 */

const AdminAuth = {
  role: null,
  user: null,
  _ready: false,

  async init() {
    if (this._ready) return this;

    // Wait for main auth to be ready
    if (window.Auth && window.Auth.readyPromise) {
      await window.Auth.readyPromise;
    }

    if (!window.Auth || !window.Auth.isAuthenticated()) {
      window.location.href = '/html/account/login?redirect=' + encodeURIComponent('/html/admin/');
      throw new Error('Not authenticated');
    }

    // Verify admin role via backend
    try {
      const resp = await window.API.verifyAdmin();
      if (!resp || !resp.data) {
        window.location.href = '/html/account/';
        throw new Error('Not authorized as admin');
      }
      // Whitelist recognized roles — reject unknown values
      const ALLOWED_ROLES = { superadmin: 'owner', owner: 'owner', admin: 'admin' };
      const rawRole = (resp.data.role || '').toLowerCase().replace(/[^a-z]/g, '');
      if (!ALLOWED_ROLES[rawRole]) {
        DebugLog.error('[AdminAuth] Unrecognized role:', resp.data.role);
        window.location.href = '/html/account/';
        throw new Error('Unrecognized admin role');
      }
      this.role = ALLOWED_ROLES[rawRole];
    } catch (e) {
      DebugLog.error('[AdminAuth] Verification failed:', e);
      window.location.href = '/html/account/';
      throw e;
    }

    this.user = window.Auth.getUser();
    this._ready = true;
    return this;
  },

  isOwner() {
    return this.role === 'owner';
  },

  isAdmin() {
    return this.role === 'admin' || this.role === 'owner';
  },

  requireOwner() {
    if (!this.isOwner()) {
      throw new Error('Owner access required');
    }
  },

  getInitials() {
    if (!this.user) return '??';
    const email = this.user.email || '';
    const name = this.user.user_metadata?.full_name || this.user.user_metadata?.name || '';
    if (name) {
      return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    }
    return email.slice(0, 2).toUpperCase();
  },

  getRoleLabel() {
    return this.role === 'owner' ? 'Owner' : 'Admin';
  },

  getDisplayName() {
    if (!this.user) return 'Unknown';
    return this.user.user_metadata?.full_name
      || this.user.user_metadata?.name
      || this.user.email
      || 'Unknown';
  },

  async signOut() {
    await window.Auth.signOut();
    window.location.href = '/html/account/login';
  }
};

export { AdminAuth };
