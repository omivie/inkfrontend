/**
 * Promotions Page — CRUD for coupon codes.
 * Backend: /api/admin/promotions (GET/POST/PUT/DELETE)
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _table = null;
let _rows = [];

const COLUMNS = [
  { key: 'code', label: 'Code', sortable: true, render: (r) => `<span class="cell-mono">${esc(r.code || '')}</span>` },
  { key: 'description', label: 'Description', render: (r) => esc(r.description || '') },
  {
    key: 'discount', label: 'Discount', align: 'right',
    render: (r) => r.discount_type === 'percentage'
      ? `${Number(r.discount_value).toFixed(0)}%`
      : `$${Number(r.discount_value).toFixed(2)}`
  },
  {
    key: 'min_order_amount', label: 'Min Order', align: 'right',
    render: (r) => r.min_order_amount ? `$${Number(r.min_order_amount).toFixed(2)}` : '—'
  },
  {
    key: 'usage', label: 'Used / Limit', align: 'right',
    render: (r) => `${r.times_used ?? 0} / ${r.usage_limit ?? '∞'}`
  },
  {
    key: 'status', label: 'Status', align: 'center',
    render: (r) => {
      const active = r.is_active !== false;
      const cls = active ? 'admin-badge--delivered' : 'admin-badge--refunded';
      return `<span class="admin-badge ${cls}">${active ? 'Active' : 'Disabled'}</span>`;
    }
  },
  {
    key: 'expires_at', label: 'Expires', render: (r) => r.expires_at
      ? new Date(r.expires_at).toLocaleDateString('en-NZ')
      : '—'
  },
];

async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getPromotions();
    _rows = Array.isArray(data) ? data : (data?.promotions || data?.rows || []);
    _table.setData(_rows);
  } catch (e) {
    Toast.error(`Failed to load promotions: ${e.message}`);
    _table.setData([]);
  }
}

function promotionForm(existing = {}) {
  const e = existing || {};
  return `
    <div class="admin-form-group">
      <label>Code *</label>
      <input class="admin-input" id="pf-code" value="${esc(e.code || '')}" placeholder="SAVE10" ${e.id ? 'readonly' : ''}>
    </div>
    <div class="admin-form-group">
      <label>Description</label>
      <input class="admin-input" id="pf-description" value="${esc(e.description || '')}" placeholder="10% off sitewide">
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Type *</label>
        <select class="admin-select" id="pf-type">
          <option value="percentage" ${e.discount_type === 'percentage' ? 'selected' : ''}>Percentage %</option>
          <option value="fixed_amount" ${e.discount_type === 'fixed_amount' ? 'selected' : ''}>Fixed $</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Value *</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="pf-value" value="${e.discount_value ?? ''}">
      </div>
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Min Order ($)</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="pf-min" value="${e.min_order_amount ?? ''}">
      </div>
      <div class="admin-form-group">
        <label>Usage Limit</label>
        <input class="admin-input" type="number" min="1" id="pf-limit" value="${e.usage_limit ?? ''}" placeholder="Unlimited">
      </div>
    </div>
    <div class="admin-form-group">
      <label>Expires At</label>
      <input class="admin-input" type="datetime-local" id="pf-expires" value="${e.expires_at ? new Date(e.expires_at).toISOString().slice(0, 16) : ''}">
    </div>
    <div class="admin-form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="pf-active" ${e.is_active !== false ? 'checked' : ''}>
        <span>Active</span>
      </label>
    </div>
  `;
}

function collectForm(body) {
  const code = body.querySelector('#pf-code').value.trim().toUpperCase();
  const description = body.querySelector('#pf-description').value.trim();
  const discount_type = body.querySelector('#pf-type').value;
  const discount_value = parseFloat(body.querySelector('#pf-value').value);
  const min = body.querySelector('#pf-min').value;
  const limit = body.querySelector('#pf-limit').value;
  const expires = body.querySelector('#pf-expires').value;
  const is_active = body.querySelector('#pf-active').checked;

  if (!code) { Toast.warning('Code is required'); return null; }
  if (isNaN(discount_value) || discount_value < 0) { Toast.warning('Valid discount value required'); return null; }
  if (discount_type === 'percentage' && discount_value > 100) { Toast.warning('Percentage cannot exceed 100'); return null; }

  const payload = { code, description: description || null, discount_type, discount_value, is_active };
  if (min !== '') payload.min_order_amount = parseFloat(min);
  if (limit !== '') payload.usage_limit = parseInt(limit, 10);
  if (expires) payload.expires_at = new Date(expires).toISOString();
  return payload;
}

function openForm(existing = null) {
  const modal = Modal.open({
    title: existing ? `Edit ${existing.code}` : 'New Promotion',
    body: promotionForm(existing),
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">${existing ? 'Save' : 'Create'}</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const payload = collectForm(modal.body);
    if (!payload) return;
    try {
      if (existing?.id) {
        await AdminAPI.updatePromotion(existing.id, payload);
        Toast.success('Promotion updated');
      } else {
        await AdminAPI.createPromotion(payload);
        Toast.success('Promotion created');
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
    title: `${row.code}`,
    body: `
      <div class="admin-detail-block">
        <div class="admin-detail-row"><span>Code</span><span class="cell-mono">${esc(row.code)}</span></div>
        <div class="admin-detail-row"><span>Description</span><span>${esc(row.description || '—')}</span></div>
        <div class="admin-detail-row"><span>Discount</span><span>${row.discount_type === 'percentage' ? row.discount_value + '%' : '$' + Number(row.discount_value).toFixed(2)}</span></div>
        <div class="admin-detail-row"><span>Min Order</span><span>${row.min_order_amount ? '$' + Number(row.min_order_amount).toFixed(2) : '—'}</span></div>
        <div class="admin-detail-row"><span>Usage</span><span>${row.times_used ?? 0} / ${row.usage_limit ?? '∞'}</span></div>
        <div class="admin-detail-row"><span>Expires</span><span>${row.expires_at ? new Date(row.expires_at).toLocaleString('en-NZ') : 'Never'}</span></div>
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
  modal.footer.querySelector('[data-action="edit"]').addEventListener('click', () => {
    Modal.close();
    openForm(row);
  });
  modal.footer.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete promotion "${row.code}"? This cannot be undone.`)) return;
    try {
      await AdminAPI.deletePromotion(row.id);
      Toast.success('Promotion deleted');
      Modal.close();
      await loadData();
    } catch (e) {
      Toast.error(`Delete failed: ${e.message}`);
    }
  });
}

export default {
  title: 'Promotions',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--spacing-4)">
          <div>
            <h1 style="margin:0">Promotions</h1>
            <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">Manage coupon codes and discount rules</p>
          </div>
          <button class="admin-btn admin-btn--primary" id="new-promo-btn">${icon('plus', 14, 14)} New Promotion</button>
        </div>
        <div id="promo-table"></div>
      </div>
    `;

    const tableDiv = container.querySelector('#promo-table');
    _table = new DataTable(tableDiv, {
      columns: COLUMNS,
      rowKey: 'id',
      onRowClick: (row) => openRow(row),
      emptyMessage: 'No promotions yet. Create your first coupon code.',
    });

    container.querySelector('#new-promo-btn').addEventListener('click', () => openForm(null));
    await loadData();
  },

  destroy() {
    if (_table) _table.destroy?.();
    _table = null;
    _container = null;
    _rows = [];
  },
};
