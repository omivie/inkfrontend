/**
 * Shipping Rates Page — CRUD for zone/weight-based shipping fees.
 * Backend: /api/admin/shipping/rates (GET/POST/PUT/DELETE)
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _table = null;

const ZONES = [
  { value: 'auckland', label: 'Auckland' },
  { value: 'north-island', label: 'North Island' },
  { value: 'south-island', label: 'South Island' },
];

const COLUMNS = [
  { key: 'tier_name', label: 'Tier', sortable: true, render: (r) => esc(r.tier_name || '') },
  { key: 'zone_label', label: 'Zone', render: (r) => esc(r.zone_label || r.zone || '') },
  {
    key: 'delivery_type', label: 'Delivery', render: (r) => {
      const v = r.delivery_type || 'urban';
      return `<span class="admin-badge admin-badge--processing">${esc(v)}</span>`;
    }
  },
  {
    key: 'weight', label: 'Weight (kg)', align: 'right',
    render: (r) => `${Number(r.min_weight_kg ?? 0).toFixed(1)} – ${r.max_weight_kg == null ? '∞' : Number(r.max_weight_kg).toFixed(1)}`
  },
  { key: 'fee', label: 'Fee', align: 'right', render: (r) => `$${Number(r.fee || 0).toFixed(2)}` },
  {
    key: 'eta', label: 'ETA (days)', align: 'center',
    render: (r) => `${r.eta_min_days ?? '?'}–${r.eta_max_days ?? '?'}`
  },
  {
    key: 'is_active', label: 'Active', align: 'center',
    render: (r) => {
      const a = r.is_active !== false;
      return `<span class="admin-badge ${a ? 'admin-badge--delivered' : 'admin-badge--refunded'}">${a ? 'Yes' : 'No'}</span>`;
    }
  },
];

async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getShippingRates();
    const rows = Array.isArray(data) ? data : (data?.rates || data?.rows || []);
    _table.setData(rows);
  } catch (e) {
    Toast.error(`Failed to load rates: ${e.message}`);
    _table.setData([]);
  }
}

function rateForm(existing = {}) {
  const e = existing || {};
  const zoneOpts = ZONES.map(z => `<option value="${z.value}" ${e.zone === z.value ? 'selected' : ''}>${z.label}</option>`).join('');
  return `
    <div class="admin-form-group">
      <label>Tier Name *</label>
      <input class="admin-input" id="sr-tier" value="${esc(e.tier_name || '')}" placeholder="Auckland Urban">
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Zone *</label>
        <select class="admin-select" id="sr-zone">${zoneOpts}</select>
      </div>
      <div class="admin-form-group">
        <label>Delivery Type *</label>
        <select class="admin-select" id="sr-delivery">
          <option value="urban" ${e.delivery_type === 'urban' ? 'selected' : ''}>Urban</option>
          <option value="rural" ${e.delivery_type === 'rural' ? 'selected' : ''}>Rural</option>
        </select>
      </div>
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Min Weight (kg) *</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="sr-min-weight" value="${e.min_weight_kg ?? 0}">
      </div>
      <div class="admin-form-group">
        <label>Max Weight (kg)</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="sr-max-weight" value="${e.max_weight_kg ?? ''}" placeholder="∞ leave blank">
      </div>
    </div>
    <div class="admin-form-group">
      <label>Fee ($) *</label>
      <input class="admin-input" type="number" step="0.01" min="0" id="sr-fee" value="${e.fee ?? ''}">
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>ETA Min (days)</label>
        <input class="admin-input" type="number" min="0" id="sr-eta-min" value="${e.eta_min_days ?? 1}">
      </div>
      <div class="admin-form-group">
        <label>ETA Max (days)</label>
        <input class="admin-input" type="number" min="0" id="sr-eta-max" value="${e.eta_max_days ?? 2}">
      </div>
    </div>
    <div class="admin-form-group">
      <label style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="sr-active" ${e.is_active !== false ? 'checked' : ''}> <span>Active</span>
      </label>
    </div>
  `;
}

function collect(body) {
  const tier_name = body.querySelector('#sr-tier').value.trim();
  const zone = body.querySelector('#sr-zone').value;
  const delivery_type = body.querySelector('#sr-delivery').value;
  const min_weight_kg = parseFloat(body.querySelector('#sr-min-weight').value) || 0;
  const maxRaw = body.querySelector('#sr-max-weight').value;
  const max_weight_kg = maxRaw === '' ? null : parseFloat(maxRaw);
  const fee = parseFloat(body.querySelector('#sr-fee').value);
  const eta_min_days = parseInt(body.querySelector('#sr-eta-min').value, 10);
  const eta_max_days = parseInt(body.querySelector('#sr-eta-max').value, 10);
  const is_active = body.querySelector('#sr-active').checked;

  if (!tier_name) { Toast.warning('Tier name required'); return null; }
  if (isNaN(fee) || fee < 0) { Toast.warning('Valid fee required'); return null; }
  if (max_weight_kg != null && max_weight_kg <= min_weight_kg) { Toast.warning('Max weight must exceed min'); return null; }

  return { tier_name, zone, delivery_type, min_weight_kg, max_weight_kg, fee, eta_min_days, eta_max_days, is_active };
}

function openForm(existing = null) {
  const modal = Modal.open({
    title: existing ? `Edit ${existing.tier_name}` : 'New Shipping Rate',
    body: rateForm(existing),
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">${existing ? 'Save' : 'Create'}</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const payload = collect(modal.body);
    if (!payload) return;
    try {
      if (existing?.id) {
        await AdminAPI.updateShippingRate(existing.id, payload);
        Toast.success('Rate updated');
      } else {
        await AdminAPI.createShippingRate(payload);
        Toast.success('Rate created');
      }
      Modal.close();
      await loadData();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
    }
  });
}

function openRow(row) {
  const modal = Modal.open({
    title: row.tier_name || 'Rate',
    body: `
      <div class="admin-detail-block">
        <div class="admin-detail-row"><span>Zone</span><span>${esc(row.zone_label || row.zone)}</span></div>
        <div class="admin-detail-row"><span>Delivery</span><span>${esc(row.delivery_type || '—')}</span></div>
        <div class="admin-detail-row"><span>Weight</span><span>${Number(row.min_weight_kg || 0).toFixed(2)} – ${row.max_weight_kg == null ? '∞' : Number(row.max_weight_kg).toFixed(2)} kg</span></div>
        <div class="admin-detail-row"><span>Fee</span><span>$${Number(row.fee || 0).toFixed(2)}</span></div>
        <div class="admin-detail-row"><span>ETA</span><span>${row.eta_min_days}–${row.eta_max_days} business days</span></div>
        <div class="admin-detail-row"><span>Active</span><span>${row.is_active !== false ? 'Yes' : 'No'}</span></div>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--danger" data-action="delete">${icon('trash', 13, 13)} Delete</button>
      <div style="flex:1"></div>
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Close</button>
      <button class="admin-btn admin-btn--primary" data-action="edit">Edit</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="edit"]').addEventListener('click', () => { Modal.close(); openForm(row); });
  modal.footer.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete rate "${row.tier_name}"?`)) return;
    try {
      await AdminAPI.deleteShippingRate(row.id);
      Toast.success('Rate deleted');
      Modal.close();
      await loadData();
    } catch (e) {
      Toast.error(`Delete failed: ${e.message}`);
    }
  });
}

export default {
  title: 'Shipping Rates',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--spacing-4)">
          <div>
            <h1 style="margin:0">Shipping Rates</h1>
            <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">Zone + weight + delivery-type shipping fees</p>
          </div>
          <button class="admin-btn admin-btn--primary" id="new-rate-btn">${icon('plus', 14, 14)} New Rate</button>
        </div>
        <div id="rates-table"></div>
      </div>
    `;
    _table = new DataTable(container.querySelector('#rates-table'), {
      columns: COLUMNS, rowKey: 'id',
      onRowClick: (row) => openRow(row),
      emptyMessage: 'No shipping rates configured.',
    });
    container.querySelector('#new-rate-btn').addEventListener('click', () => openForm(null));
    await loadData();
  },

  destroy() {
    if (_table) _table.destroy?.();
    _table = null;
    _container = null;
  },
};
