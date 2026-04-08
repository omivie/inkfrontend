/**
 * B2B Partners — Manage business account applications, approvals, and invoicing
 */
import { AdminAPI, AdminAuth, esc, icon } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { FilterState } from '../app.js';

const MISSING = '\u2014';
const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;

function formatDate(d) {
  if (!d) return MISSING;
  return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusBadge(status) {
  const s = (status || 'pending').toLowerCase();
  const map = {
    pending: 'pending',
    approved: 'delivered',
    declined: 'refunded',
    rejected: 'refunded',
  };
  return `<span class="admin-badge admin-badge--${map[s] || 'pending'}">${esc(status || 'pending')}</span>`;
}

function tierBadge(tier) {
  if (!tier) return MISSING;
  const colors = {
    bronze: '#b45309',
    silver: '#6b7280',
    gold: '#d97706',
  };
  const color = colors[tier.toLowerCase()] || '#6b7280';
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${color}18;color:${color}">${esc(tier)}</span>`;
}

// ---- State ----
let _container = null;
let _appTable = null;
let _invoiceTable = null;
let _page = 1;
let _invoicePage = 1;
let _search = '';
let _statusFilter = 'pending';

// ---- Application columns ----
const APP_COLUMNS = [
  { key: 'submitted_at', label: 'Date', sortable: true, render: (r) => `<span style="font-size:12px;white-space:nowrap">${formatDate(r.submitted_at || r.created_at)}</span>` },
  { key: 'company_name', label: 'Company', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:160px;font-weight:500">${esc(r.company_name || MISSING)}</span>` },
  { key: 'contact_name', label: 'Contact', render: (r) => esc(r.contact_name || MISSING) },
  { key: 'contact_email', label: 'Email', render: (r) => `<span class="cell-truncate" style="max-width:160px">${esc(r.contact_email || MISSING)}</span>` },
  { key: 'business_type', label: 'Type', render: (r) => esc(r.business_type || MISSING) },
  { key: 'estimated_monthly_spend', label: 'Est. Spend', render: (r) => esc(r.estimated_monthly_spend || MISSING) },
  { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
  { key: '_actions', label: '', align: 'right', render: (r) => {
    const s = (r.status || 'pending').toLowerCase();
    if (s === 'pending') {
      return `<button class="admin-btn admin-btn--xs admin-btn--primary b2b-action" data-id="${Security.escapeAttr(r.id)}" data-action="approve" style="margin-right:4px">Approve</button>`
           + `<button class="admin-btn admin-btn--xs admin-btn--ghost b2b-action" data-id="${Security.escapeAttr(r.id)}" data-action="decline" style="color:var(--danger);border-color:var(--danger)">Decline</button>`;
    }
    return '';
  }},
];

// ---- Invoice columns ----
const INVOICE_COLUMNS = [
  { key: 'invoice_number', label: 'Invoice #', sortable: true, render: (r) => `<span style="font-weight:500">${esc(r.invoice_number || r.id || MISSING)}</span>` },
  { key: 'company_name', label: 'Company', render: (r) => esc(r.company_name || r.business?.company_name || MISSING) },
  { key: 'order_number', label: 'Order', render: (r) => esc(r.order_number || MISSING) },
  { key: 'amount', label: 'Amount', sortable: true, render: (r) => `<span style="font-weight:500">${formatPrice(r.amount)}</span>` },
  { key: 'due_date', label: 'Due', sortable: true, render: (r) => formatDate(r.due_date) },
  { key: 'status', label: 'Status', render: (r) => {
    const s = (r.status || 'unpaid').toLowerCase();
    const map = { unpaid: 'pending', paid: 'delivered', overdue: 'refunded' };
    return `<span class="admin-badge admin-badge--${map[s] || 'pending'}">${esc(r.status || 'unpaid')}</span>`;
  }},
  { key: '_actions', label: '', align: 'right', render: (r) => {
    const s = (r.status || 'unpaid').toLowerCase();
    let btns = `<button class="admin-btn admin-btn--xs admin-btn--ghost inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="pdf" style="margin-right:4px" title="Generate PDF">${icon('download', 14, 14)}</button>`
             + `<button class="admin-btn admin-btn--xs admin-btn--ghost inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="email" style="margin-right:4px" title="Send Email">${icon('mail', 14, 14)}</button>`;
    if (s !== 'paid') btns += `<button class="admin-btn admin-btn--xs admin-btn--primary inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="record-payment" title="Record Payment">${icon('finance', 14, 14)}</button>`;
    return btns;
  }},
];

// ---- Data loading ----
async function loadApplications() {
  if (_appTable) _appTable.setLoading(true);
  const data = await AdminAPI.getBusinessApplications({
    status: _statusFilter,
    search: _search,
  }, _page, 20);
  if (!data) { if (_appTable) _appTable.setData([], null); return; }
  const rows = data.applications || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_appTable) _appTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _page, limit: 20 });
}

async function loadInvoices() {
  if (_invoiceTable) _invoiceTable.setLoading(true);
  const data = await AdminAPI.getBusinessInvoicesAdmin({}, _invoicePage, 20);
  if (!data) { if (_invoiceTable) _invoiceTable.setData([], null); return; }
  const rows = data.invoices || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_invoiceTable) _invoiceTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _invoicePage, limit: 20 });
}

// ---- Application detail drawer ----
async function openApplicationDrawer(app) {
  const d = Drawer.open({
    title: esc(app.company_name || 'Application Detail'),
    width: '480px',
    body: buildDrawerBody(app),
    footer: buildDrawerFooter(app),
  });
  if (!d) return;

  // Approve button
  d.footer.querySelector('#b2b-drawer-approve')?.addEventListener('click', async () => {
    const creditLimit = parseFloat(d.body.querySelector('#b2b-credit-limit')?.value) || 0;
    const pricingTier = d.body.querySelector('#b2b-pricing-tier')?.value || 'bronze';
    try {
      await AdminAPI.approveBusinessApplication(app.id, { credit_limit: creditLimit, pricing_tier: pricingTier });
      Toast.success(`${app.company_name || 'Application'} approved`);
      d.close();
      loadApplications();
    } catch (e) {
      Toast.error('Approval failed: ' + e.message);
    }
  });

  // Decline button
  d.footer.querySelector('#b2b-drawer-decline')?.addEventListener('click', async () => {
    const reason = prompt('Reason for declining (optional):') || '';
    try {
      await AdminAPI.declineBusinessApplication(app.id, reason);
      Toast.success(`${app.company_name || 'Application'} declined`);
      d.close();
      loadApplications();
    } catch (e) {
      Toast.error('Decline failed: ' + e.message);
    }
  });

  // Save settings button (for approved accounts)
  d.footer.querySelector('#b2b-drawer-save')?.addEventListener('click', async () => {
    const creditLimit = parseFloat(d.body.querySelector('#b2b-credit-limit')?.value) || 0;
    const pricingTier = d.body.querySelector('#b2b-pricing-tier')?.value || 'bronze';
    try {
      await AdminAPI.updateBusinessSettings(app.id, { credit_limit: creditLimit, pricing_tier: pricingTier });
      Toast.success('Settings updated');
      d.close();
      loadApplications();
    } catch (e) {
      Toast.error('Update failed: ' + e.message);
    }
  });
}

function buildDrawerBody(app) {
  const s = (app.status || 'pending').toLowerCase();
  const billing = app.billing_address || {};
  const shipping = app.shipping_address || {};

  return `
    <div style="margin-bottom:16px">${statusBadge(app.status)} ${tierBadge(app.pricing_tier)}</div>

    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Company Details</h3>
      <div class="admin-detail-row"><span>Company</span><span>${esc(app.company_name || MISSING)}</span></div>
      <div class="admin-detail-row"><span>NZBN</span><span>${esc(app.nzbn || MISSING)}</span></div>
      <div class="admin-detail-row"><span>Type</span><span>${esc(app.business_type || MISSING)}</span></div>
      <div class="admin-detail-row"><span>Industry</span><span>${esc(app.industry || MISSING)}</span></div>
    </div>

    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Contact</h3>
      <div class="admin-detail-row"><span>Name</span><span>${esc(app.contact_name || MISSING)}</span></div>
      <div class="admin-detail-row"><span>Email</span><span>${esc(app.contact_email || MISSING)}</span></div>
      <div class="admin-detail-row"><span>Phone</span><span>${esc(app.contact_phone || MISSING)}</span></div>
      <div class="admin-detail-row"><span>AP Email</span><span>${esc(app.ap_email || MISSING)}</span></div>
    </div>

    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Billing Address</h3>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.5">
        ${esc(billing.address1 || MISSING)}<br>
        ${billing.address2 ? esc(billing.address2) + '<br>' : ''}
        ${esc(billing.city || '')} ${esc(billing.region || '')} ${esc(billing.postcode || '')}
      </div>
    </div>

    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Shipping Address</h3>
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.5">
        ${esc(shipping.address1 || MISSING)}<br>
        ${shipping.address2 ? esc(shipping.address2) + '<br>' : ''}
        ${esc(shipping.city || '')} ${esc(shipping.region || '')} ${esc(shipping.postcode || '')}
      </div>
    </div>

    ${app.apply_net30 ? `
    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Net 30 Application</h3>
      <div class="admin-detail-row"><span>Est. Spend</span><span>${esc(app.estimated_monthly_spend || MISSING)}</span></div>
      ${app.credit_reference_url ? `<div class="admin-detail-row"><span>Credit Ref</span><a href="${Security.escapeAttr(app.credit_reference_url)}" target="_blank" rel="noopener" class="admin-link">Download</a></div>` : ''}
    </div>
    ` : ''}

    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Account Settings</h3>
      <div class="admin-form-group" style="margin-bottom:12px">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Credit Limit ($)</label>
        <input type="number" id="b2b-credit-limit" class="admin-input" style="width:100%" min="0" step="100" value="${app.credit_limit || 0}" placeholder="e.g. 5000">
      </div>
      <div class="admin-form-group">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Pricing Tier</label>
        <select id="b2b-pricing-tier" class="admin-select" style="width:100%">
          <option value="bronze"${(app.pricing_tier || '').toLowerCase() === 'bronze' ? ' selected' : ''}>Bronze</option>
          <option value="silver"${(app.pricing_tier || '').toLowerCase() === 'silver' ? ' selected' : ''}>Silver</option>
          <option value="gold"${(app.pricing_tier || '').toLowerCase() === 'gold' ? ' selected' : ''}>Gold</option>
        </select>
      </div>
    </div>

    <div class="admin-detail-row" style="margin-top:16px"><span>Submitted</span><span>${formatDate(app.submitted_at || app.created_at)}</span></div>
  `;
}

function buildDrawerFooter(app) {
  const s = (app.status || 'pending').toLowerCase();
  if (s === 'pending') {
    return `
      <button class="admin-btn admin-btn--primary" id="b2b-drawer-approve">Approve</button>
      <button class="admin-btn admin-btn--ghost" id="b2b-drawer-decline" style="color:var(--danger);border-color:var(--danger)">Decline</button>
    `;
  }
  return `<button class="admin-btn admin-btn--primary" id="b2b-drawer-save">Save Settings</button>`;
}

// ---- Invoice actions ----
async function handleInvoiceAction(invoiceId, action) {
  try {
    if (action === 'pdf') {
      await AdminAPI.generateInvoicePdf(invoiceId);
      Toast.success('PDF generated');
    } else if (action === 'email') {
      await AdminAPI.sendInvoiceEmail(invoiceId);
      Toast.success('Invoice email sent');
    } else if (action === 'record-payment') {
      if (!confirm('Record this invoice as paid?')) return;
      await AdminAPI.recordInvoicePayment(invoiceId);
      Toast.success('Payment recorded');
      loadInvoices();
    }
  } catch (e) {
    Toast.error(`Failed: ${e.message}`);
  }
}

// ---- Inline approve/decline from table ----
async function handleQuickAction(appId, action) {
  if (action === 'approve') {
    try {
      await AdminAPI.approveBusinessApplication(appId, { credit_limit: 0, pricing_tier: 'bronze' });
      Toast.success('Application approved (default settings)');
      loadApplications();
    } catch (e) { Toast.error('Approval failed: ' + e.message); }
  } else if (action === 'decline') {
    const reason = prompt('Reason for declining (optional):') || '';
    try {
      await AdminAPI.declineBusinessApplication(appId, reason);
      Toast.success('Application declined');
      loadApplications();
    } catch (e) { Toast.error('Decline failed: ' + e.message); }
  }
}

// ---- Render ----
function render() {
  _container.innerHTML = `
    <div class="admin-page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <h1 class="admin-page-title">${icon('customers', 22, 22)} B2B Partners</h1>
    </div>

    <div class="admin-tabs" id="b2b-status-tabs" style="margin-bottom:16px">
      <button class="admin-tab${_statusFilter === 'pending' ? ' active' : ''}" data-status="pending">Pending</button>
      <button class="admin-tab${_statusFilter === 'approved' ? ' active' : ''}" data-status="approved">Approved</button>
      <button class="admin-tab${_statusFilter === '' ? ' active' : ''}" data-status="">All</button>
    </div>
    <div id="b2b-app-table"></div>

    <div style="margin-top:40px">
      <h2 class="admin-page-title" style="font-size:1.1rem;margin-bottom:16px">${icon('finance', 20, 20)} Net 30 Invoices</h2>
      <div id="b2b-invoice-table"></div>
    </div>
  `;
}

export default {
  title: 'B2B Partners',

  async init(container) {
    _container = container;
    _page = 1;
    _invoicePage = 1;
    _search = '';
    _statusFilter = 'pending';

    FilterState.showBar(false);
    render();

    // Status tabs
    _container.querySelector('#b2b-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      _statusFilter = btn.dataset.status;
      _page = 1;
      _container.querySelectorAll('#b2b-status-tabs .admin-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.status === _statusFilter));
      loadApplications();
    });

    // Applications table
    _appTable = new DataTable(_container.querySelector('#b2b-app-table'), {
      columns: APP_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No business applications found',
      onPageChange: (page) => { _page = page; loadApplications(); },
      onRowClick: (row) => openApplicationDrawer(row),
    });

    // Inline approve/decline delegation
    _container.querySelector('#b2b-app-table').addEventListener('click', (e) => {
      const btn = e.target.closest('.b2b-action');
      if (!btn) return;
      e.stopPropagation();
      handleQuickAction(btn.dataset.id, btn.dataset.action);
    });

    // Invoices table
    _invoiceTable = new DataTable(_container.querySelector('#b2b-invoice-table'), {
      columns: INVOICE_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No invoices yet',
      onPageChange: (page) => { _invoicePage = page; loadInvoices(); },
    });

    // Invoice action delegation
    _container.querySelector('#b2b-invoice-table').addEventListener('click', (e) => {
      const btn = e.target.closest('.inv-action');
      if (!btn) return;
      e.stopPropagation();
      handleInvoiceAction(btn.dataset.id, btn.dataset.action);
    });

    await Promise.all([loadApplications(), loadInvoices()]);
  },

  destroy() {
    if (_appTable) { _appTable.destroy(); _appTable = null; }
    if (_invoiceTable) { _invoiceTable.destroy(); _invoiceTable = null; }
    _container = null;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    loadApplications();
  },

  onFilterChange() {},
};
