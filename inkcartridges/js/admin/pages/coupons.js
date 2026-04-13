/**
 * Coupons Page — CRUD + audit trail for /api/admin/coupons.
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _table = null;
let _logTable = null;
let _rows = [];
let _logs = [];
let _activeTab = 'coupons';
let _filters = { search: '', is_active: '', discount_type: '' };
let _logFilters = { coupon_id: '', user_email: '', from: '', to: '' };

function statusOf(r) {
  if (r.is_active === false) return { label: 'Inactive', cls: 'admin-badge--refunded' };
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return { label: 'Expired', cls: 'admin-badge--cancelled' };
  if (r.usage_limit != null && (r.usage_count ?? 0) >= r.usage_limit) return { label: 'Exhausted', cls: 'admin-badge--pending' };
  return { label: 'Active', cls: 'admin-badge--delivered' };
}

const COLUMNS = [
  { key: 'code', label: 'Code', sortable: true, render: (r) => `<span class="cell-mono"><strong>${esc(r.code || '')}</strong></span>` },
  {
    key: 'discount', label: 'Discount', align: 'right',
    render: (r) => r.discount_type === 'percentage'
      ? `${Number(r.discount_value).toFixed(0)}%`
      : `$${Number(r.discount_value).toFixed(2)}`,
  },
  {
    key: 'status', label: 'Status', align: 'center',
    render: (r) => {
      const s = statusOf(r);
      return `<span class="admin-badge ${s.cls}">${s.label}</span>`;
    },
  },
  {
    key: 'usage', label: 'Usage', align: 'right',
    render: (r) => `${r.usage_count ?? 0} / ${r.usage_limit ?? '∞'}`,
  },
  {
    key: 'restricted', label: 'Restricted To',
    render: (r) => {
      const n = Array.isArray(r.allowed_emails) ? r.allowed_emails.length : 0;
      if (!n) return '<span style="color:var(--text-muted)">Anyone</span>';
      return `<span class="admin-badge admin-badge--processing">${n} email${n === 1 ? '' : 's'}</span>`;
    },
  },
  {
    key: 'expires_at', label: 'Expires',
    render: (r) => r.expires_at ? new Date(r.expires_at).toLocaleDateString('en-NZ') : 'Never',
  },
  {
    key: 'actions', label: '', align: 'right',
    render: (r) => `
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="edit" data-id="${esc(r.id)}">Edit</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${esc(r.id)}">${icon('trash', 12, 12)}</button>
    `,
  },
];

const LOG_COLUMNS = [
  { key: 'used_at', label: 'Date / Time', render: (r) => new Date(r.used_at).toLocaleString('en-NZ') },
  { key: 'code', label: 'Coupon', render: (r) => `<span class="cell-mono">${esc(r.coupon?.code || '—')}</span>` },
  { key: 'user_email', label: 'User Email', render: (r) => esc(r.user_email || '—') },
  {
    key: 'order_id', label: 'Order', render: (r) => r.order_id
      ? `<a href="#orders/${esc(r.order_id)}">${esc(String(r.order_id).slice(0, 8))}</a>`
      : '—',
  },
  { key: 'ip_address', label: 'IP', render: (r) => esc(r.ip_address || '—') },
];

// ---------- Coupons data ----------
async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  try {
    const params = {};
    if (_filters.search) params.search = _filters.search;
    if (_filters.is_active) params.is_active = _filters.is_active;
    if (_filters.discount_type) params.discount_type = _filters.discount_type;
    const data = await AdminAPI.getCoupons(params);
    _rows = Array.isArray(data) ? data : (data?.coupons || []);
    _table.setData(_rows);
  } catch (e) {
    Toast.error(`Failed to load coupons: ${e.message}`);
    _table.setData([]);
  }
}

async function loadLogs() {
  if (!_logTable) return;
  _logTable.setLoading(true);
  try {
    const params = {};
    if (_logFilters.coupon_id) params.coupon_id = _logFilters.coupon_id;
    if (_logFilters.user_email) params.user_email = _logFilters.user_email;
    if (_logFilters.from) params.from = new Date(_logFilters.from).toISOString();
    if (_logFilters.to) params.to = new Date(_logFilters.to).toISOString();
    const data = await AdminAPI.getCouponLogs(params);
    _logs = Array.isArray(data) ? data : (data?.logs || []);
    _logTable.setData(_logs);
  } catch (e) {
    Toast.error(`Failed to load logs: ${e.message}`);
    _logTable.setData([]);
  }
}

// ---------- Form ----------
function couponForm(existing = {}) {
  const e = existing || {};
  const isPct = e.discount_type === 'percentage';
  const toLocal = (iso) => iso ? new Date(iso).toISOString().slice(0, 16) : '';
  const emails = Array.isArray(e.allowed_emails) ? e.allowed_emails.join(', ') : '';
  return `
    <div class="admin-form-group">
      <label>Code *</label>
      <input class="admin-input" id="cf-code" value="${esc(e.code || '')}" placeholder="SAVE10" maxlength="50" ${e.id ? 'readonly' : ''} style="text-transform:uppercase">
      <small style="color:var(--text-muted)">2–50 chars. Letters, numbers, hyphens, underscores.</small>
    </div>
    <div class="admin-form-group">
      <label>Description</label>
      <textarea class="admin-input" id="cf-description" rows="2" maxlength="500" placeholder="$10 off your order">${esc(e.description || '')}</textarea>
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Discount Type *</label>
        <select class="admin-select" id="cf-type">
          <option value="fixed_amount" ${!isPct ? 'selected' : ''}>Fixed Amount ($)</option>
          <option value="percentage" ${isPct ? 'selected' : ''}>Percentage (%)</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Value *</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="cf-value" value="${e.discount_value ?? ''}">
      </div>
    </div>
    <div class="admin-form-group" id="cf-maxd-wrap" style="${isPct ? '' : 'display:none'}">
      <label>Max Discount Amount ($)</label>
      <input class="admin-input" type="number" step="0.01" min="0" id="cf-maxd" value="${e.max_discount_amount ?? ''}" placeholder="Cap for percentage">
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Minimum Order ($)</label>
        <input class="admin-input" type="number" step="0.01" min="0" id="cf-min" value="${e.minimum_order_amount ?? ''}">
      </div>
      <div class="admin-form-group">
        <label>Max Uses (Total)</label>
        <input class="admin-input" type="number" min="1" id="cf-limit" value="${e.usage_limit ?? ''}" placeholder="Unlimited">
      </div>
    </div>
    <div class="admin-form-group">
      <label>Max Uses Per User</label>
      <input class="admin-input" type="number" min="1" id="cf-per-user" value="${e.usage_limit_per_user ?? 1}">
    </div>
    <div class="admin-form-group">
      <label>Restricted Emails</label>
      <textarea class="admin-input" id="cf-emails" rows="2" placeholder="alice@example.com, bob@example.com">${esc(emails)}</textarea>
      <small style="color:var(--text-muted)">Comma or newline separated. Leave empty for any email.</small>
    </div>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Starts At</label>
        <input class="admin-input" type="datetime-local" id="cf-starts" value="${toLocal(e.starts_at)}">
      </div>
      <div class="admin-form-group">
        <label>Expires At</label>
        <input class="admin-input" type="datetime-local" id="cf-expires" value="${toLocal(e.expires_at)}">
      </div>
    </div>
    <div class="admin-form-group">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="cf-active" ${e.is_active !== false ? 'checked' : ''}>
        <span>Active</span>
      </label>
    </div>
  `;
}

function collectForm(body) {
  const code = body.querySelector('#cf-code').value.trim().toUpperCase();
  const description = body.querySelector('#cf-description').value.trim();
  const discount_type = body.querySelector('#cf-type').value;
  const discount_value = parseFloat(body.querySelector('#cf-value').value);
  const maxd = body.querySelector('#cf-maxd').value;
  const min = body.querySelector('#cf-min').value;
  const limit = body.querySelector('#cf-limit').value;
  const perUser = body.querySelector('#cf-per-user').value;
  const emailsRaw = body.querySelector('#cf-emails').value;
  const starts = body.querySelector('#cf-starts').value;
  const expires = body.querySelector('#cf-expires').value;
  const is_active = body.querySelector('#cf-active').checked;

  if (!/^[A-Z0-9_-]{2,50}$/.test(code)) {
    Toast.warning('Code must be 2–50 chars, uppercase letters, numbers, hyphens, underscores.');
    return null;
  }
  if (isNaN(discount_value) || discount_value <= 0) {
    Toast.warning('Valid positive discount value required.');
    return null;
  }
  if (discount_type === 'percentage' && discount_value > 100) {
    Toast.warning('Percentage cannot exceed 100.');
    return null;
  }
  if (starts && expires && new Date(expires) <= new Date(starts)) {
    Toast.warning('Expiry must be after start date.');
    return null;
  }

  const payload = { code, discount_type, discount_value, is_active };
  if (description) payload.description = description;
  if (discount_type === 'percentage' && maxd !== '') payload.max_discount_amount = parseFloat(maxd);
  if (min !== '') payload.minimum_order_amount = parseFloat(min);
  if (limit !== '') payload.usage_limit = parseInt(limit, 10);
  if (perUser !== '') payload.usage_limit_per_user = parseInt(perUser, 10);
  const emails = emailsRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (emails.length) payload.allowed_emails = emails;
  if (starts) payload.starts_at = new Date(starts).toISOString();
  if (expires) payload.expires_at = new Date(expires).toISOString();
  return payload;
}

function openForm(existing = null) {
  const modal = Modal.open({
    title: existing ? `Edit ${existing.code}` : 'New Coupon',
    body: couponForm(existing),
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">${existing ? 'Save' : 'Create'}</button>
    `,
  });
  if (!modal) return;

  const typeSel = modal.body.querySelector('#cf-type');
  const maxdWrap = modal.body.querySelector('#cf-maxd-wrap');
  typeSel.addEventListener('change', () => {
    maxdWrap.style.display = typeSel.value === 'percentage' ? '' : 'none';
  });

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const payload = collectForm(modal.body);
    if (!payload) return;
    try {
      if (existing?.id) {
        await AdminAPI.updateCoupon(existing.id, payload);
        Toast.success('Coupon updated');
      } else {
        await AdminAPI.createCoupon(payload);
        Toast.success('Coupon created');
      }
      Modal.close();
      await loadData();
    } catch (e) {
      if (e.code === 409) Toast.error('A coupon with this code already exists.');
      else Toast.error(`Save failed: ${e.message}`);
    }
  });
}

function confirmDelete(row) {
  const modal = Modal.open({
    title: `Delete "${row.code}"?`,
    body: `
      <p>Choose how to remove this coupon:</p>
      <ul style="color:var(--text-muted);font-size:13px;line-height:1.7;padding-left:18px">
        <li><strong>Deactivate</strong> — keeps the record for audit but blocks future use.</li>
        <li><strong>Delete permanently</strong> — removes it from the database. Cannot be undone.</li>
      </ul>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <div style="flex:1"></div>
      <button class="admin-btn admin-btn--danger" data-action="hard">Delete permanently</button>
      <button class="admin-btn admin-btn--primary" data-action="soft">Deactivate</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  const run = async (permanent) => {
    try {
      await AdminAPI.deleteCoupon(row.id, permanent);
      Toast.success(permanent ? 'Coupon deleted' : 'Coupon deactivated');
      Modal.close();
      await loadData();
    } catch (e) {
      Toast.error(`Delete failed: ${e.message}`);
    }
  };
  modal.footer.querySelector('[data-action="soft"]').addEventListener('click', () => run(false));
  modal.footer.querySelector('[data-action="hard"]').addEventListener('click', () => run(true));
}

// ---------- Rendering ----------
function switchTab(tab) {
  _activeTab = tab;
  _container.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  _container.querySelector('#tab-coupons').style.display = tab === 'coupons' ? '' : 'none';
  _container.querySelector('#tab-logs').style.display = tab === 'logs' ? '' : 'none';
  if (tab === 'logs') {
    populateLogCouponSelect();
    loadLogs();
  }
}

function populateLogCouponSelect() {
  const sel = _container.querySelector('#lf-coupon');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">All coupons</option>` + _rows.map((r) =>
    `<option value="${esc(r.id)}" ${current === r.id ? 'selected' : ''}>${esc(r.code)}</option>`
  ).join('');
}

export default {
  title: 'Coupons',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--spacing-4)">
          <div>
            <h1 style="margin:0">Coupons</h1>
            <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">Create and manage discount codes. Track every redemption in the audit log.</p>
          </div>
          <button class="admin-btn admin-btn--primary" id="new-coupon-btn">${icon('plus', 14, 14)} New Coupon</button>
        </div>

        <div class="admin-tabs" style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:var(--spacing-4)">
          <button class="admin-tab is-active" data-tab="coupons" style="padding:10px 16px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--text-muted);font-weight:500;cursor:pointer">Coupons</button>
          <button class="admin-tab" data-tab="logs" style="padding:10px 16px;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--text-muted);font-weight:500;cursor:pointer">Usage Logs</button>
        </div>

        <div id="tab-coupons">
          <div class="admin-filters" style="display:flex;gap:var(--spacing-2);margin-bottom:var(--spacing-3);flex-wrap:wrap">
            <input class="admin-input" id="cf-search" placeholder="Search code or description" style="flex:1;min-width:220px">
            <select class="admin-select" id="cf-active-filter" style="min-width:140px">
              <option value="">All statuses</option>
              <option value="true">Active only</option>
              <option value="false">Inactive only</option>
            </select>
            <select class="admin-select" id="cf-type-filter" style="min-width:160px">
              <option value="">All types</option>
              <option value="fixed_amount">Fixed amount</option>
              <option value="percentage">Percentage</option>
            </select>
          </div>
          <div id="coupons-table"></div>
        </div>

        <div id="tab-logs" style="display:none">
          <div class="admin-filters" style="display:flex;gap:var(--spacing-2);margin-bottom:var(--spacing-3);flex-wrap:wrap">
            <select class="admin-select" id="lf-coupon" style="min-width:180px"><option value="">All coupons</option></select>
            <input class="admin-input" id="lf-email" placeholder="Filter by email" style="flex:1;min-width:200px">
            <input class="admin-input" type="date" id="lf-from" title="From date">
            <input class="admin-input" type="date" id="lf-to" title="To date">
            <button class="admin-btn admin-btn--ghost" id="lf-reset">Reset</button>
          </div>
          <div id="logs-table"></div>
        </div>
      </div>
    `;

    // Coupons table
    _table = new DataTable(container.querySelector('#coupons-table'), {
      columns: COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No coupons yet. Create your first code above.',
    });

    // Logs table
    _logTable = new DataTable(container.querySelector('#logs-table'), {
      columns: LOG_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No usage logged for the selected filters.',
    });

    // Tabs
    container.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // New button
    container.querySelector('#new-coupon-btn').addEventListener('click', () => openForm(null));

    // Coupon filters (debounced search)
    const searchInput = container.querySelector('#cf-search');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _filters.search = searchInput.value.trim();
        loadData();
      }, 250);
    });
    container.querySelector('#cf-active-filter').addEventListener('change', (e) => {
      _filters.is_active = e.target.value;
      loadData();
    });
    container.querySelector('#cf-type-filter').addEventListener('change', (e) => {
      _filters.discount_type = e.target.value;
      loadData();
    });

    // Row action buttons (edit/delete) — delegated on table container
    container.querySelector('#coupons-table').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-row-action]');
      if (!btn) return;
      ev.stopPropagation();
      const row = _rows.find((r) => r.id === btn.dataset.id);
      if (!row) return;
      if (btn.dataset.rowAction === 'edit') openForm(row);
      else if (btn.dataset.rowAction === 'delete') confirmDelete(row);
    });

    // Log filters
    container.querySelector('#lf-coupon').addEventListener('change', (e) => {
      _logFilters.coupon_id = e.target.value;
      loadLogs();
    });
    const emailInput = container.querySelector('#lf-email');
    let emailTimer;
    emailInput.addEventListener('input', () => {
      clearTimeout(emailTimer);
      emailTimer = setTimeout(() => {
        _logFilters.user_email = emailInput.value.trim();
        loadLogs();
      }, 250);
    });
    container.querySelector('#lf-from').addEventListener('change', (e) => {
      _logFilters.from = e.target.value;
      loadLogs();
    });
    container.querySelector('#lf-to').addEventListener('change', (e) => {
      _logFilters.to = e.target.value;
      loadLogs();
    });
    container.querySelector('#lf-reset').addEventListener('click', () => {
      _logFilters = { coupon_id: '', user_email: '', from: '', to: '' };
      container.querySelector('#lf-coupon').value = '';
      container.querySelector('#lf-email').value = '';
      container.querySelector('#lf-from').value = '';
      container.querySelector('#lf-to').value = '';
      loadLogs();
    });

    await loadData();
  },

  onSearch(query) {
    if (_activeTab !== 'coupons') return;
    _filters.search = query;
    const input = _container?.querySelector('#cf-search');
    if (input) input.value = query;
    loadData();
  },

  destroy() {
    _table?.destroy?.();
    _logTable?.destroy?.();
    _table = null;
    _logTable = null;
    _container = null;
    _rows = [];
    _logs = [];
  },
};
