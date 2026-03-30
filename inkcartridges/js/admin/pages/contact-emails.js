/**
 * Notification Recipients Page — Owner-only: Manage notification recipient emails & preferences
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _emails = [];
let _preferences = {}; // map of contact_email_id -> preference row

const NOTIFICATION_TYPES = [
  { key: 'notify_orders',    label: 'Customer Orders' },
  { key: 'notify_contact',   label: 'Contact Form' },
  { key: 'notify_low_stock', label: 'Low Stock Alerts' },
  { key: 'notify_refunds',   label: 'Refunds & Chargebacks' },
  { key: 'notify_signups',   label: 'New Account Signups' },
  { key: 'notify_reviews',   label: 'Product Reviews' },
];

function getSb() {
  return (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
}

async function loadEmails() {
  _container.innerHTML = `
    <div class="admin-page-header"><h1>Notification Recipients</h1></div>
    <div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `;

  // Fetch emails from backend + preferences from Supabase in parallel
  const [emailData, prefsResult] = await Promise.all([
    AdminAPI.getContactEmails(),
    loadPreferences(),
  ]);

  _emails = Array.isArray(emailData) ? emailData : emailData?.emails || [];

  // Ensure every email has a preferences row
  await ensurePreferences();

  render();
}

async function loadPreferences() {
  const sb = getSb();
  if (!sb) return;
  const { data, error } = await sb.from('notification_preferences').select('*');
  if (error) {
    console.warn('[NotifRecipients] Failed to load preferences:', error.message);
    return;
  }
  _preferences = {};
  if (data) {
    data.forEach(p => _preferences[p.contact_email_id] = p);
  }
}

async function ensurePreferences() {
  const sb = getSb();
  if (!sb) return;

  const missing = _emails.filter(e => {
    const id = e.id || e.email;
    return !_preferences[id];
  });
  if (missing.length === 0) return;

  const rows = missing.map(e => ({
    contact_email_id: e.id || e.email,
    notify_orders: true,
    notify_contact: true,
  }));

  const { error } = await sb.from('notification_preferences').upsert(rows, { onConflict: 'contact_email_id' });
  if (error) {
    console.warn('[NotifRecipients] Failed to ensure preferences:', error.message);
    return;
  }

  // Re-fetch to get complete rows
  await loadPreferences();
}

function render() {
  let html = `
    <div class="admin-page-header">
      <h1>Notification Recipients</h1>
      <p class="admin-page-header__sub">Manage who receives each type of notification.</p>
    </div>
  `;

  if (_emails.length) {
    for (const entry of _emails) {
      const id = entry.id || entry.email;
      const email = entry.email || entry;
      const prefs = _preferences[id] || {};

      html += `
        <div class="admin-card" style="margin-bottom:var(--spacing-md)">
          <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--spacing-md);border-bottom:1px solid var(--color-border-light, #e2e8f0)">
            <span style="font-weight:600;font-size:14px">${esc(String(email))}</span>
            <button class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger" data-remove-id="${esc(String(id))}">Remove</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(190px, 1fr));gap:var(--spacing-sm);padding:var(--spacing-md)">
      `;

      for (const type of NOTIFICATION_TYPES) {
        const checked = prefs[type.key] !== false;
        html += `
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <label class="admin-toggle">
              <input type="checkbox" ${checked ? 'checked' : ''} data-email-id="${esc(String(id))}" data-pref-key="${type.key}">
              <span class="admin-toggle__slider"></span>
            </label>
            <span style="color:var(--text-secondary)">${type.label}</span>
          </label>
        `;
      }

      html += `</div></div>`;
    }
  } else {
    html += `<div class="admin-card"><p class="admin-text-muted" style="padding:var(--spacing-md)">No recipient emails configured. Add one below.</p></div>`;
  }

  // Add email row
  html += `
    <div class="admin-card" style="margin-top:var(--spacing-md)">
      <div style="display:flex;gap:8px;padding:var(--spacing-md);align-items:center">
        <input type="email" id="new-email-input" class="admin-input" placeholder="recipient@example.com" style="flex:1">
        <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-email-btn">${icon('mail', 14, 14)} Add</button>
      </div>
    </div>
  `;

  _container.innerHTML = html;
  bindEvents();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function addEmail(email) {
  if (!isValidEmail(email)) {
    Toast.error('Please enter a valid email address.');
    return;
  }
  try {
    await AdminAPI.addContactEmail(email);
    Toast.success(`Added ${email}`);
    await loadEmails();
  } catch (e) {
    Toast.error(`Failed to add: ${e.message}`);
  }
}

async function removeEmail(id) {
  if (!confirm('Remove this recipient email?')) return;
  try {
    await AdminAPI.removeContactEmail(id);
    Toast.success('Email removed');
    await loadEmails();
  } catch (e) {
    Toast.error(`Failed to remove: ${e.message}`);
  }
}

async function updatePreference(emailId, key, value) {
  const sb = getSb();
  if (!sb) { Toast.error('Not authenticated'); return; }

  const { error } = await sb
    .from('notification_preferences')
    .update({ [key]: value, updated_at: new Date().toISOString() })
    .eq('contact_email_id', emailId);

  if (error) {
    Toast.error('Failed to update preference');
    // Revert the toggle
    const toggle = _container.querySelector(`input[data-email-id="${emailId}"][data-pref-key="${key}"]`);
    if (toggle) toggle.checked = !value;
    return;
  }

  // Update local state
  if (_preferences[emailId]) _preferences[emailId][key] = value;
}

function bindEvents() {
  // Add button
  const addBtn = _container.querySelector('#add-email-btn');
  const input = _container.querySelector('#new-email-input');
  if (addBtn && input) {
    addBtn.addEventListener('click', () => addEmail(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addEmail(input.value.trim());
    });
  }

  // Remove buttons
  _container.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => removeEmail(btn.dataset.removeId));
  });

  // Toggle switches
  _container.querySelectorAll('input[data-email-id][data-pref-key]').forEach(toggle => {
    toggle.addEventListener('change', () => {
      updatePreference(toggle.dataset.emailId, toggle.dataset.prefKey, toggle.checked);
    });
  });
}

export default {
  title: 'Notification Recipients',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    await loadEmails();
  },

  destroy() {
    _container = null;
    _emails = [];
    _preferences = {};
  },
};
