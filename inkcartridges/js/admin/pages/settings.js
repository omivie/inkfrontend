/**
 * Settings Page — Owner-only: Alert thresholds, preferences, exports
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
import { Toast } from '../components/toast.js';

const MISSING = '\u2014';

let _container = null;

async function loadSettings() {
  const thresholds = await AdminAPI.getAlertThresholds();
  const thresholdList = thresholds?.thresholds || thresholds?.data || (Array.isArray(thresholds) ? thresholds : []);

  let html = `<div class="admin-page-header"><h1>Settings</h1></div>`;

  // Account Info
  html += `<div class="admin-settings-section">`;
  html += `<h2 class="admin-settings-section__title">${icon('customers', 16, 16)} Account</h2>`;
  html += `<div class="admin-card">`;
  html += settingsRow('Name', esc(AdminAuth.getDisplayName()));
  html += settingsRow('Role', `<span class="admin-badge admin-badge--${AdminAuth.isOwner() ? 'owner' : 'admin'}">${esc(AdminAuth.getRoleLabel())}</span>`);
  html += settingsRow('Email', esc(AdminAuth.user?.email || MISSING));
  html += `</div></div>`;

  // Display
  html += `<div class="admin-settings-section">`;
  html += `<h2 class="admin-settings-section__title">${icon('sun', 16, 16)} Display</h2>`;
  html += `<div class="admin-card">`;
  const isDark = document.body.dataset.theme !== 'light';
  html += `<div class="admin-settings-row"><span>Theme</span><div class="admin-flex">`;
  html += `<button class="admin-btn admin-btn--sm ${isDark ? 'admin-btn--primary' : 'admin-btn--ghost'}" data-set-theme="dark">${icon('moon', 14, 14)} Dark</button>`;
  html += `<button class="admin-btn admin-btn--sm ${!isDark ? 'admin-btn--primary' : 'admin-btn--ghost'}" data-set-theme="light">${icon('sun', 14, 14)} Light</button>`;
  html += `</div></div>`;
  html += `</div></div>`;

  // Alert Thresholds
  html += `<div class="admin-settings-section">`;
  html += `<h2 class="admin-settings-section__title">${icon('analytics', 16, 16)} Alert Thresholds</h2>`;
  if (thresholdList.length) {
    html += `<div class="admin-card">`;
    html += `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Metric</th><th>Threshold</th><th>Severity</th><th class="cell-center">Enabled</th><th>Cooldown (hrs)</th><th>Action</th></tr></thead><tbody>`;
    for (const t of thresholdList) {
      html += `<tr data-threshold-id="${esc(String(t.id))}">`;
      html += `<td>${esc(t.metric || t.name || MISSING)}</td>`;
      html += `<td><input class="admin-input" style="width:100px" type="number" step="any" value="${t.threshold_value ?? t.threshold ?? t.value ?? ''}" data-field="threshold"></td>`;
      html += `<td><select class="admin-select" style="width:100px" data-field="severity">`;
      for (const sev of ['low', 'medium', 'high', 'critical']) {
        html += `<option value="${sev}"${t.severity === sev ? ' selected' : ''}>${sev.charAt(0).toUpperCase() + sev.slice(1)}</option>`;
      }
      html += `</select></td>`;
      html += `<td class="cell-center"><input type="checkbox" style="accent-color:var(--cyan)" data-field="enabled"${(t.is_enabled ?? t.enabled) !== false ? ' checked' : ''}></td>`;
      html += `<td><input class="admin-input" style="width:80px" type="number" value="${t.cooldown_hours ?? t.cooldown_minutes ?? t.cooldown ?? 1}" data-field="cooldown_hours"></td>`;
      html += `<td><button class="admin-btn admin-btn--ghost admin-btn--sm" data-save-threshold="${esc(String(t.id))}">Save</button></td>`;
      html += `</tr>`;
    }
    html += `</tbody></table></div></div>`;
  } else {
    html += `<div class="admin-card"><p class="admin-text-muted">No alert thresholds configured. Thresholds will appear once the backend endpoint is available.</p></div>`;
  }
  html += `</div>`;

  // Exports
  html += `<div class="admin-settings-section">`;
  html += `<h2 class="admin-settings-section__title">${icon('download', 16, 16)} Data Exports</h2>`;
  html += `<div class="admin-card"><div style="display:flex;gap:8px;flex-wrap:wrap">`;
  html += exportDropdown('export-settings-orders', 'Orders');
  html += exportDropdown('export-settings-refunds', 'Refunds');
  html += exportDropdown('export-settings-customers', 'Customers');
  html += exportDropdown('export-settings-products', 'Products');
  html += `</div></div></div>`;

  _container.innerHTML = html;
  bindEvents();
}

function settingsRow(label, value) {
  return `<div class="admin-settings-row"><span class="admin-settings-row__label">${label}</span><span>${value}</span></div>`;
}

function bindEvents() {
  // Theme buttons
  _container.querySelectorAll('[data-set-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.body.dataset.theme = btn.dataset.setTheme;
      localStorage.setItem('admin-theme', btn.dataset.setTheme);
      // Refresh to update theme toggle icon in topbar
      loadSettings();
      Toast.success(`Theme set to ${btn.dataset.setTheme}`);
    });
  });

  // Save threshold buttons
  _container.querySelectorAll('[data-save-threshold]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = btn.dataset.saveThreshold;
      const data = {
        threshold_value: parseFloat(row.querySelector('[data-field="threshold"]').value),
        severity: row.querySelector('[data-field="severity"]').value,
        is_enabled: row.querySelector('[data-field="enabled"]').checked,
        cooldown_hours: parseFloat(row.querySelector('[data-field="cooldown_hours"]').value) || 1,
      };
      try {
        await AdminAPI.updateAlertThreshold(id, data);
        Toast.success('Threshold updated');
      } catch (e) {
        Toast.error(`Failed: ${e.message}`);
      }
    });
  });

  // Export dropdowns
  const exportTypes = ['orders', 'refunds', 'customers', 'products'];
  for (const type of exportTypes) {
    bindExportDropdown(_container, `export-settings-${type}`, async (format) => {
      try {
        Toast.info(`Exporting ${type} as ${format.toUpperCase()}\u2026`);
        await AdminAPI.exportData(type, format, FilterState.getParams());
        Toast.success(`${type} exported`);
      } catch (e) {
        Toast.error(`Export failed: ${e.message}`);
      }
    });
  }
}

export default {
  title: 'Settings',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    await loadSettings();
  },

  destroy() {
    _container = null;
  },
};
