/**
 * SITE-GUARD.JS
 * =============
 * Lockdown guard — if an admin enables site-wide lockdown, this script
 * intercepts every public page and shows a login overlay.
 * Self-contained: no dependency on auth.js or config.js.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://lmdlgldjgcanknsjrcxh.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtZGxnbGRqZ2Nhbmtuc2pyY3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc1MTg1NjksImV4cCI6MjA4MzA5NDU2OX0.7Wk6k6avT5AUJnTkJ5VKlzJ54Tm6lbdx9WPnJsXb5Mo';
  const BACKEND_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'https://ink-backend-zaeq.onrender.com'
    : '';

  let _sb = null;

  function initClient() {
    if (_sb) return _sb;
    if (typeof supabase === 'undefined' || !supabase.createClient) return null;
    // Use a separate storageKey so this client's session doesn't conflict
    // with auth.js's Supabase client (different localStorage namespace).
    _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: 'sg-auth', persistSession: true }
    });
    return _sb;
  }

  async function getLockStatus() {
    const sb = initClient();
    if (!sb) return null;
    try {
      const { data, error } = await sb
        .from('site_settings')
        .select('value')
        .eq('key', 'site_locked')
        .single();
      if (error || !data) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  async function isAdminSession(session) {
    if (!session?.access_token) return false;

    async function tryVerify() {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(`${BACKEND_URL}/api/admin/verify`, {
          credentials: 'include',
          headers: { 'Authorization': `Bearer ${session.access_token}` },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) return false;
        const body = await res.json();
        return body.ok && ['owner', 'admin', 'superadmin', 'super_admin'].includes(body.data?.role);
      } catch {
        clearTimeout(t);
        return null; // null = failed (distinct from false = not admin)
      }
    }

    const first = await tryVerify();
    if (first !== null) return first;

    // Backend likely cold-starting — wait 4s then retry once
    await new Promise(r => setTimeout(r, 4000));
    const second = await tryVerify();
    return second === true;
  }

  function injectStyles() {
    if (document.getElementById('sg-styles')) return;
    const style = document.createElement('style');
    style.id = 'sg-styles';
    style.textContent = `
      #sg-overlay {
        position: fixed; inset: 0; z-index: 999999;
        background: rgba(12, 18, 34, 0.97);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      #sg-card {
        background: #fff; border-radius: 16px; padding: 40px 36px;
        width: 100%; max-width: 420px; margin: 16px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      }
      #sg-logo {
        display: flex; align-items: center; gap: 10px; margin-bottom: 28px;
      }
      #sg-logo svg { color: #267FB5; flex-shrink: 0; }
      #sg-logo-name {
        font-size: 15px; font-weight: 700; color: #111111; letter-spacing: -0.3px;
      }
      #sg-title {
        font-size: 22px; font-weight: 700; color: #111111; margin: 0 0 8px;
      }
      #sg-subtitle {
        font-size: 14px; color: #64748B; margin: 0 0 28px; line-height: 1.55;
      }
      #sg-form { display: flex; flex-direction: column; gap: 14px; }
      .sg-field { display: flex; flex-direction: column; gap: 5px; }
      .sg-label { font-size: 13px; font-weight: 600; color: #334155; }
      .sg-input {
        padding: 11px 14px; border: 1.5px solid #E2E8F0;
        border-radius: 8px; font-size: 14px; color: #111111;
        background: #F8FAFC; outline: none;
        transition: border-color 0.15s, background 0.15s;
        width: 100%; box-sizing: border-box;
      }
      .sg-input:focus { border-color: #267FB5; background: #fff; }
      #sg-error {
        font-size: 13px; color: #dc2626;
        background: #fef2f2; border: 1px solid #fca5a5;
        border-radius: 6px; padding: 9px 12px;
        display: none; margin-top: 2px;
      }
      #sg-btn {
        width: 100%; padding: 12px; margin-top: 4px;
        background: #267FB5; color: #fff;
        border: none; border-radius: 8px;
        font-size: 15px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
        letter-spacing: -0.2px;
      }
      #sg-btn:hover:not(:disabled) { background: #1A5A82; }
      #sg-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      #sg-footer {
        text-align: center; font-size: 12px; color: #94A3B8;
        margin-top: 24px; line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  function showOverlay(message) {
    injectStyles();

    const safeMsg = message
      ? message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      : 'We\'re making some updates and will be back shortly. We appreciate your patience.';

    const overlay = document.createElement('div');
    overlay.id = 'sg-overlay';
    overlay.innerHTML = `
      <div id="sg-card">
        <div id="sg-logo">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9V2h12v7"/>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
          </svg>
          <span id="sg-logo-name">InkCartridges.co.nz</span>
        </div>
        <h1 id="sg-title">We'll be back soon</h1>
        <p id="sg-subtitle">${safeMsg}</p>
        <form id="sg-form" novalidate>
          <div class="sg-field">
            <label class="sg-label" for="sg-email">Email address</label>
            <input class="sg-input" id="sg-email" type="email" placeholder="admin@example.com" autocomplete="email" required>
          </div>
          <div class="sg-field">
            <label class="sg-label" for="sg-password">Password</label>
            <input class="sg-input" id="sg-password" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autocomplete="current-password" required>
          </div>
          <div id="sg-error" role="alert"></div>
          <button type="submit" id="sg-btn">Sign in</button>
        </form>
        <p id="sg-footer">InkCartridges.co.nz &mdash; Staff sign in</p>
      </div>
    `;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('#sg-form');
    const errorEl = overlay.querySelector('#sg-error');
    const btn = overlay.querySelector('#sg-btn');
    const emailInput = overlay.querySelector('#sg-email');

    emailInput.focus();

    function setError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = msg ? 'block' : 'none';
    }

    function setLoading(loading) {
      btn.disabled = loading;
      btn.textContent = loading ? 'Signing in…' : 'Sign in';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = emailInput.value.trim();
      const password = overlay.querySelector('#sg-password').value;

      if (!email || !password) {
        setError('Please enter your email and password.');
        return;
      }

      setLoading(true);
      setError('');

      try {
        const sb = initClient();
        if (!sb) {
          setError('Authentication unavailable. Please reload the page.');
          setLoading(false);
          return;
        }

        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) {
          setError(error.message || 'Sign-in failed. Please check your email and password.');
          setLoading(false);
          return;
        }

        btn.textContent = 'Verifying access…';
        const ok = await isAdminSession(data.session);
        if (!ok) {
          await sb.auth.signOut();
          setError('Access denied — this account does not have admin permissions. If you believe this is an error, try again in a moment.');
          setLoading(false);
          return;
        }

        overlay.remove();
      } catch {
        setError('Something went wrong. Please try again.');
        setLoading(false);
      }
    });
  }

  async function run() {
    const path = location.pathname;
    if (path.startsWith('/admin') || path.startsWith('/admin')) return;

    if (!window.supabase?.createClient) return;

    const lock = await getLockStatus();
    if (!lock?.enabled) return;

    const sb = initClient();
    if (sb) {
      const { data: { session } } = await sb.auth.getSession();
      if (await isAdminSession(session)) return;
    }

    showOverlay(lock.message || '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
