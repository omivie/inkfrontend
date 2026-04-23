/**
 * Site Lock Page — Owner-only: toggle site-wide admin lockdown
 */
import { FilterState, esc } from '../app.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _locked = false;
let _message = '';

function getSb() {
  return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
}

async function loadSettings() {
  const sb = getSb();
  if (!sb) {
    _container.innerHTML = `
      <div class="admin-page-header"><h1>Site Lock</h1></div>
      <div class="admin-card" style="padding:var(--spacing-md)">
        <p style="color:var(--color-error,#dc2626)">Not authenticated. Please reload the page.</p>
      </div>
    `;
    return;
  }

  _container.innerHTML = `
    <div class="admin-page-header"><h1>Site Lock</h1></div>
    <div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `;

  const { data, error } = await sb
    .from('site_settings')
    .select('value')
    .eq('key', 'site_locked')
    .single();

  if (error) {
    _container.innerHTML = `
      <div class="admin-page-header"><h1>Site Lock</h1></div>
      <div class="admin-card" style="padding:var(--spacing-md)">
        <p style="color:var(--color-error,#dc2626);margin:0 0 8px;font-weight:600">Could not load site settings.</p>
        <p style="color:var(--text-secondary);margin:0;font-size:13px">
          Make sure the <code>site_settings</code> table exists in Supabase with a row
          where <code>key = 'site_locked'</code>. See the setup SQL in the plan.
        </p>
      </div>
    `;
    return;
  }

  _locked = data?.value?.enabled ?? false;
  _message = data?.value?.message ?? '';
  render();
}

async function saveLock(enabled) {
  const sb = getSb();
  if (!sb) { Toast.error('Not authenticated'); return; }

  const prev = _locked;
  _locked = enabled;
  renderStatus();

  const { error } = await sb
    .from('site_settings')
    .upsert(
      {
        key: 'site_locked',
        value: { enabled, message: _message },
        updated_at: new Date().toISOString(),
        updated_by: (typeof Auth !== 'undefined' && Auth.user?.id) ? Auth.user.id : null,
      },
      { onConflict: 'key' }
    );

  if (error) {
    Toast.error('Failed to update lock status.');
    _locked = prev;
    renderStatus();
    return;
  }

  Toast.success(enabled
    ? 'Site locked — only admin accounts can access any page.'
    : 'Site unlocked — open to all visitors.');
}

async function saveMessage() {
  const sb = getSb();
  if (!sb) { Toast.error('Not authenticated'); return; }

  const input = _container.querySelector('#sl-message');
  _message = input ? input.value.trim() : '';

  const btn = _container.querySelector('#sl-save-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const { error } = await sb
    .from('site_settings')
    .upsert(
      {
        key: 'site_locked',
        value: { enabled: _locked, message: _message },
        updated_at: new Date().toISOString(),
        updated_by: (typeof Auth !== 'undefined' && Auth.user?.id) ? Auth.user.id : null,
      },
      { onConflict: 'key' }
    );

  if (btn) { btn.disabled = false; btn.textContent = 'Save message'; }

  if (error) { Toast.error('Failed to save message.'); return; }
  Toast.success('Lockdown message saved.');
}

function renderStatus() {
  const badge = _container && _container.querySelector('#sl-badge');
  const toggle = _container && _container.querySelector('#sl-toggle');
  const banner = _container && _container.querySelector('#sl-banner');

  if (badge) {
    badge.textContent = _locked ? 'LOCKED' : 'UNLOCKED';
    badge.style.background = _locked ? '#fef2f2' : '#f0fdf4';
    badge.style.color = _locked ? '#dc2626' : '#16a34a';
    badge.style.borderColor = _locked ? '#fca5a5' : '#86efac';
  }
  if (toggle) toggle.checked = _locked;
  if (banner) {
    banner.style.background = _locked ? '#fef2f2' : '#f0fdf4';
    banner.style.borderColor = _locked ? '#fca5a5' : '#86efac';
  }
}

function render() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1>Site Lock</h1>
      <p class="admin-page-header__sub">Control public access to the store. When locked, visitors see a login prompt — only admin accounts can get through.</p>
    </div>

    <div id="sl-banner" class="admin-card" style="
      padding: var(--spacing-md);
      margin-bottom: var(--spacing-md);
      border: 1.5px solid;
      transition: background 0.2s, border-color 0.2s;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">
            Current Status
          </div>
          <span id="sl-badge" style="
            display: inline-block;
            padding: 5px 14px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.06em;
            border: 1.5px solid;
          "></span>
          <p style="margin:10px 0 0;font-size:13px;color:var(--text-secondary)" id="sl-hint"></p>
        </div>
        <label class="admin-toggle" style="transform:scale(1.4);transform-origin:right center;flex-shrink:0">
          <input type="checkbox" id="sl-toggle">
          <span class="admin-toggle__slider"></span>
        </label>
      </div>
    </div>

    <div class="admin-card" style="padding:var(--spacing-md)">
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px">Lockdown message</div>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;line-height:1.5">
        Shown to visitors on the login overlay. Leave blank for the default message.
      </p>
      <textarea
        id="sl-message"
        class="admin-input"
        rows="3"
        placeholder="e.g. We're doing some maintenance and will be back shortly."
        style="width:100%;box-sizing:border-box;resize:vertical;font-family:inherit"
      >${esc(String(_message))}</textarea>
      <button id="sl-save-msg" class="admin-btn admin-btn--primary admin-btn--sm" style="margin-top:10px">
        Save message
      </button>
    </div>
  `;

  renderStatus();

  const hint = _container.querySelector('#sl-hint');
  const toggle = _container.querySelector('#sl-toggle');

  function updateHint() {
    hint.textContent = toggle.checked
      ? 'The store is locked. Visitors will see a login prompt.'
      : 'The store is open. All visitors can browse normally.';
  }
  updateHint();

  toggle.addEventListener('change', () => {
    updateHint();
    saveLock(toggle.checked);
  });

  _container.querySelector('#sl-save-msg').addEventListener('click', saveMessage);
}

export default {
  title: 'Site Lock',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    await loadSettings();
  },

  destroy() {
    _container = null;
  },
};
