/**
 * Contact Emails Page — Owner-only: Manage contact form recipient emails
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _emails = [];

async function loadEmails() {
  _container.innerHTML = `
    <div class="admin-page-header"><h1>Contact Form Recipients</h1></div>
    <div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
      <div class="admin-loading__spinner"></div>
    </div>
  `;

  const data = await AdminAPI.getContactEmails();
  _emails = Array.isArray(data) ? data : data?.emails || [];
  render();
}

function render() {
  let html = `<div class="admin-page-header"><h1>Contact Form Recipients</h1><p class="admin-page-header__sub">Emails listed here will receive contact form submissions.</p></div>`;

  html += `<div class="admin-card">`;

  if (_emails.length) {
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Email Address</th><th style="width:100px;text-align:center">Action</th></tr></thead><tbody>`;
    for (const entry of _emails) {
      const id = entry.id || entry.email;
      const email = entry.email || entry;
      html += `<tr>`;
      html += `<td>${esc(String(email))}</td>`;
      html += `<td style="text-align:center"><button class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger" data-remove-id="${esc(String(id))}">Remove</button></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  } else {
    html += `<p class="admin-text-muted" style="padding:var(--spacing-md)">No recipient emails configured. Add one below.</p>`;
  }

  // Add email row
  html += `
    <div style="display:flex;gap:8px;padding:var(--spacing-md);border-top:1px solid var(--color-border-light, #e2e8f0);align-items:center">
      <input type="email" id="new-email-input" class="admin-input" placeholder="recipient@example.com" style="flex:1">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-email-btn">${icon('mail', 14, 14)} Add</button>
    </div>
  `;

  html += `</div>`;

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
}

export default {
  title: 'Contact Emails',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    await loadEmails();
  },

  destroy() {
    _container = null;
    _emails = [];
  },
};
