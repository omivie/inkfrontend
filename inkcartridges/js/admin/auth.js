/**
 * AdminAuth — Role-gated admin authentication
 * Wraps the global Auth module with admin-specific verification
 */

const AdminAuth = {
  role: null,
  user: null,
  _ready: false,

  /**
   * Resolve this session's admin role.
   *
   * FOUR OUTCOMES, and keeping them apart is the entire point of this method
   * (ERR-188). Until Aug 2026 every failure took the same exit — a silent
   * `location.href = '/account'` — so a 22-minute backend outage was
   * indistinguishable, from the operator's side, from having lost their admin
   * rights. Nothing was logged where they could see it and no message was ever
   * shown.
   *
   *   granted      → resolve; `this.role` is 'owner' or 'admin'
   *   refused      → redirect to /account. The server answered no; that answer
   *                  is final and the redirect is correct.
   *   signed-out   → redirect to login, carrying /admin/ as the return path.
   *   unreachable  → **THROW, AND DO NOT NAVIGATE.** We have no answer, so the
   *                  page stays put and boot() renders the outage state in
   *                  place. Redirecting here is what told the owner they were
   *                  locked out of their own site.
   *
   * The rejection carries `err.access` (an AdminAccess outcome) and
   * `err.reason`, so boot() branches on a typed value rather than sniffing a
   * message string.
   */
  async init() {
    if (this._ready) return this;

    // Wait for main auth to be ready
    if (window.Auth && window.Auth.readyPromise) {
      await window.Auth.readyPromise;
    }

    if (!window.Auth || !window.Auth.isAuthenticated()) {
      this._toLogin();
      throw this._fail('signed-out', 'Not authenticated');
    }

    const outcome = await this._verify();

    if (outcome.state === 'granted') {
      this.role = outcome.role;
      this.user = window.Auth.getUser();
      this._ready = true;
      return this;
    }

    if (outcome.state === 'signed-out') {
      DebugLog.warn('[AdminAuth] Session rejected by the backend — re-authenticating');
      this._toLogin();
      throw this._fail('signed-out', 'Session expired', outcome);
    }

    if (outcome.state === 'unreachable') {
      // NO REDIRECT. See the contract above.
      DebugLog.error('[AdminAuth] Could not verify admin role — backend unreachable:', outcome);
      throw this._fail('unreachable', 'Could not reach the backend to verify admin access', outcome);
    }

    DebugLog.error('[AdminAuth] Access refused for this account:', outcome);
    window.location.href = '/account';
    throw this._fail('refused', 'Not authorized as admin', outcome);
  },

  /**
   * Call GET /api/admin/verify, retrying ONLY while the answer is "no answer".
   *
   * The ladder is 0s / 2s / 5s. One 2s retry (the previous behaviour) cannot
   * span a Render restart: the outage on 2026-08-31 ran 22 minutes, and even an
   * ordinary cold start outlives it. A refusal is never retried — the server has
   * already answered, and asking again would just delay a correct redirect.
   *
   * Both failure shapes are handled here, which is why callers get an outcome
   * rather than a raw response: a non-JSON 5xx (the Render HTML gateway page)
   * THROWS out of API.request(), while a JSON 5xx envelope RETURNS
   * `{ ok:false, code:'INTERNAL_ERROR' }` without throwing. The old code wrapped
   * only the throw, so the returned shape fell straight through to the
   * `!resp.data` branch and was reported as "not an admin" with no retry at all.
   */
  async _verify() {
    const Access = this._access();
    const DELAYS = [2000, 5000];

    for (let attempt = 0; ; attempt++) {
      let outcome;
      try {
        outcome = Access.classify(await window.API.verifyAdmin());
      } catch (e) {
        outcome = Access.classify(null, e);
      }

      if (outcome.state !== 'unreachable' || attempt >= DELAYS.length) return outcome;

      DebugLog.warn(
        `[AdminAuth] verify unreachable (status ${outcome.status || 'n/a'}), ` +
        `retry ${attempt + 1}/${DELAYS.length} in ${DELAYS[attempt]}ms`
      );
      await new Promise(r => setTimeout(r, DELAYS[attempt]));
    }
  },

  /**
   * The shared role/outcome vocabulary, off `window` because utils.js is a
   * classic script and this is a module.
   *
   * Read directly and asserted, NEVER `window.AdminAccess?.x ? … : fallback`.
   * A guard like that around a global that turns out not to exist is an off
   * switch, not a safety net — the fallback becomes the only branch that ever
   * runs and nothing ever says so (ERR-167). If this is missing the page is
   * broken and should say the word "broken".
   */
  _access() {
    const Access = window.AdminAccess;
    if (!Access || typeof Access.classify !== 'function') {
      throw new Error('AdminAccess is unavailable — utils.js did not load before the admin app');
    }
    return Access;
  },

  _toLogin() {
    window.location.href = '/account/login?redirect=' + encodeURIComponent('/admin/');
  },

  /** Typed rejection so boot() branches on a value, not on message text. */
  _fail(reason, message, outcome) {
    const err = new Error(message);
    err.reason = reason;
    err.access = outcome || null;
    return err;
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
    window.location.href = '/account/login';
  }
};

export { AdminAuth };
