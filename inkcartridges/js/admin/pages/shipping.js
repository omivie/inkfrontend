/**
 * Shipping Rates Page — Admin CRUD for zone-based shipping rates
 */
import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

let _container = null;
let _table = null;
let _page = 1;
let _search = '';

const ZONES = ['auckland', 'north-island', 'south-island'];
const ZONE_LABELS = { 'auckland': 'Auckland', 'north-island': 'North Island', 'south-island': 'South Island' };
const DELIVERY_TYPES = ['urban', 'rural'];
const TIERS = ['standard', 'heavy'];

function zoneBadge(zone) {
  const label = ZONE_LABELS[zone] || zone || MISSING;
  return `<span class="admin-badge admin-badge--${esc(zone || 'default')}">${esc(label)}</span>`;
}

function activeBadge(active) {
  if (active === false || active === 'false') return `<span class="admin-badge admin-badge--inactive">Inactive</span>`;
  return `<span class="admin-badge admin-badge--active">Active</span>`;
}

const COLUMNS = [
  {
    key: 'zone', label: 'Zone',
    render: (r) => zoneBadge(r.zone),
  },
  {
    key: 'tier_name', label: 'Tier',
    render: (r) => `<span class="cell-mono">${esc(r.tier_name || MISSING)}</span>`,
  },
  {
    key: 'delivery_type', label: 'Delivery Type',
    render: (r) => `<span style="text-transform:capitalize">${esc(r.delivery_type || MISSING)}</span>`,
  },
  {
    key: 'weight', label: 'Weight Range',
    render: (r) => {
      const min = r.min_weight_kg ?? 0;
      const max = r.max_weight_kg;
      if (max == null) return `${min}kg+`;
      return `${min}\u2013${max}kg`;
    },
  },
  {
    key: 'fee', label: 'Fee',
    render: (r) => `<span class="cell-mono">${r.fee != null ? formatPrice(r.fee) : MISSING}</span>`,
  },
  {
    key: 'eta', label: 'ETA',
    render: (r) => {
      const min = r.eta_min_days ?? '';
      const max = r.eta_max_days ?? '';
      if (!min && !max) return MISSING;
      return `${min}\u2013${max} days`;
    },
  },
  {
    key: 'is_active', label: 'Status',
    render: (r) => activeBadge(r.is_active),
  },
  {
    key: 'actions', label: '',
    render: (r) => `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-edit="${esc(r.id)}">Edit</button>`,
  },
];

async function loadRates() {
  _container.innerHTML = '';

  let html = `<div class="admin-page-header">
    <h1>${icon('suppliers', 20, 20)} Shipping Rates</h1>
    <button class="admin-btn admin-btn--primary" id="add-rate-btn">${icon('products', 14, 14)} Add Rate</button>
  </div>`;

  html += `<div id="rates-table"></div>`;
  _container.innerHTML = html;

  document.getElementById('add-rate-btn').addEventListener('click', () => openRateForm());

  await fetchAndRender();
}

async function fetchAndRender() {
  const tableEl = document.getElementById('rates-table');
  if (!tableEl) return;

  const data = await AdminAPI.getShippingRates({}, _page, 100);
  const rates = data?.rates || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || { total: rates.length, page: _page, limit: 100 };

  if (_table) _table.destroy();
  _table = new DataTable(tableEl, {
    columns: COLUMNS,
    data: rates,
    pagination,
    emptyMessage: 'No shipping rates configured.',
    onPageChange: (p) => { _page = p; fetchAndRender(); },
  });

  // Bind edit buttons
  tableEl.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rateId = btn.dataset.edit;
      const rate = rates.find(r => r.id === rateId);
      if (rate) openRateForm(rate);
    });
  });
}

function openRateForm(existing = null) {
  const isEdit = !!existing;
  const title = isEdit ? 'Edit Shipping Rate' : 'New Shipping Rate';

  let html = `<form id="rate-form" class="admin-form">`;

  html += `<div class="admin-form-row">
    <label class="admin-label">Zone</label>
    <select class="admin-select" name="zone" required>
      <option value="">Select zone</option>
      ${ZONES.map(z => `<option value="${z}"${existing?.zone === z ? ' selected' : ''}>${ZONE_LABELS[z]}</option>`).join('')}
    </select>
  </div>`;

  html += `<div class="admin-form-row">
    <label class="admin-label">Zone Label</label>
    <input class="admin-input" name="zone_label" value="${esc(existing?.zone_label || '')}" placeholder="e.g. Auckland" required>
  </div>`;

  html += `<div class="admin-form-row">
    <label class="admin-label">Tier Name</label>
    <select class="admin-select" name="tier_name" required>
      ${TIERS.map(t => `<option value="${t}"${existing?.tier_name === t ? ' selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
    </select>
  </div>`;

  html += `<div class="admin-form-row">
    <label class="admin-label">Delivery Type</label>
    <select class="admin-select" name="delivery_type" required>
      ${DELIVERY_TYPES.map(t => `<option value="${t}"${existing?.delivery_type === t ? ' selected' : ''}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join('')}
    </select>
  </div>`;

  html += `<div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div>
      <label class="admin-label">Min Weight (kg)</label>
      <input class="admin-input" name="min_weight_kg" type="number" step="0.01" min="0" value="${existing?.min_weight_kg ?? 0}">
    </div>
    <div>
      <label class="admin-label">Max Weight (kg)</label>
      <input class="admin-input" name="max_weight_kg" type="number" step="0.01" min="0" value="${existing?.max_weight_kg ?? ''}" placeholder="Leave empty for unlimited">
    </div>
  </div>`;

  html += `<div class="admin-form-row">
    <label class="admin-label">Fee (NZD)</label>
    <input class="admin-input" name="fee" type="number" step="0.01" min="0" value="${existing?.fee ?? ''}" required>
  </div>`;

  html += `<div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div>
      <label class="admin-label">ETA Min Days</label>
      <input class="admin-input" name="eta_min_days" type="number" min="1" value="${existing?.eta_min_days ?? 1}">
    </div>
    <div>
      <label class="admin-label">ETA Max Days</label>
      <input class="admin-input" name="eta_max_days" type="number" min="1" value="${existing?.eta_max_days ?? 3}">
    </div>
  </div>`;

  html += `<div class="admin-form-row">
    <label class="admin-label" style="display:flex;align-items:center;gap:6px">
      <input type="checkbox" name="is_active" style="accent-color:var(--cyan)" ${(existing?.is_active !== false) ? 'checked' : ''}>
      Active
    </label>
  </div>`;

  if (isEdit) {
    html += `<div style="display:flex;gap:8px;margin-top:16px">
      <button type="submit" class="admin-btn admin-btn--primary" style="flex:1">Save Changes</button>
      <button type="button" class="admin-btn admin-btn--danger" id="delete-rate-btn">Deactivate</button>
    </div>`;
  } else {
    html += `<button type="submit" class="admin-btn admin-btn--primary" style="width:100%;margin-top:16px">Create Rate</button>`;
  }

  html += `</form>`;

  const drawer = Drawer.open({ title, body: html, width: 420 });

  const form = document.getElementById('rate-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      zone: fd.get('zone'),
      zone_label: fd.get('zone_label'),
      tier_name: fd.get('tier_name'),
      delivery_type: fd.get('delivery_type'),
      min_weight_kg: parseFloat(fd.get('min_weight_kg')) || 0,
      max_weight_kg: fd.get('max_weight_kg') ? parseFloat(fd.get('max_weight_kg')) : null,
      fee: parseFloat(fd.get('fee')),
      eta_min_days: parseInt(fd.get('eta_min_days')) || 1,
      eta_max_days: parseInt(fd.get('eta_max_days')) || 3,
      is_active: form.querySelector('[name="is_active"]').checked,
    };

    try {
      if (isEdit) {
        await AdminAPI.updateShippingRate(existing.id, payload);
        Toast.success('Shipping rate updated');
      } else {
        await AdminAPI.createShippingRate(payload);
        Toast.success('Shipping rate created');
      }
      Drawer.close();
      fetchAndRender();
    } catch (err) {
      Toast.error(err.message || 'Failed to save rate');
    }
  });

  if (isEdit) {
    document.getElementById('delete-rate-btn')?.addEventListener('click', async () => {
      const confirmed = await Modal.confirm({
        title: 'Deactivate Rate',
        message: `Deactivate this ${ZONE_LABELS[existing.zone] || existing.zone} ${existing.tier_name} rate? This is a soft delete.`,
      });
      if (!confirmed) return;

      try {
        await AdminAPI.deleteShippingRate(existing.id);
        Toast.success('Rate deactivated');
        Drawer.close();
        fetchAndRender();
      } catch (err) {
        Toast.error(err.message || 'Failed to deactivate rate');
      }
    });
  }
}

export default {
  title: 'Shipping Rates',

  async init(container) {
    _container = container;
    _page = 1;
    await loadRates();
  },

  destroy() {
    if (_table) _table.destroy();
    _table = null;
    _container = null;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    fetchAndRender();
  },
};
