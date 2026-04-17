/**
 * B2B Partners Hub — Standalone admin page for business account management
 */
import { AdminAPI, AdminAuth, esc, icon, FilterState } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';

const MISSING = '—';
const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;

function formatDate(d) {
  if (!d) return MISSING;
  return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusBadge(status) {
  const s = (status || 'pending').toLowerCase();
  const map = { pending: 'pending', approved: 'delivered', declined: 'refunded', rejected: 'refunded', active: 'delivered', suspended: 'refunded' };
  return `<span class="admin-badge admin-badge--${map[s] || 'pending'}">${esc(status || 'pending')}</span>`;
}

function tierBadge(tier) {
  if (!tier) return MISSING;
  const colors = { bronze: '#b45309', silver: '#6b7280', gold: '#d97706' };
  const color = colors[tier.toLowerCase()] || '#6b7280';
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${color}18;color:${color}">${esc(tier)}</span>`;
}

// ---- State ----
let _container = null;
let _activeTab = 'applications'; // applications | accounts | invoices
let _appTable = null;
let _accountTable = null;
let _invoiceTable = null;
let _appPage = 1;
let _accountPage = 1;
let _invoicePage = 1;
let _search = '';
let _statusFilter = 'pending';
let _invoiceStatusFilter = '';

// ---- Applications columns ----
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
      return `<button class="admin-btn admin-btn--xs admin-btn--primary b2b-app-action" data-id="${Security.escapeAttr(r.id)}" data-action="approve" style="margin-right:4px">Approve</button>`
           + `<button class="admin-btn admin-btn--xs admin-btn--ghost b2b-app-action" data-id="${Security.escapeAttr(r.id)}" data-action="decline" style="color:var(--danger);border-color:var(--danger)">Decline</button>`;
    }
    return '';
  }},
];

// ---- Accounts columns ----
const ACCOUNT_COLUMNS = [
  { key: 'company_name', label: 'Company', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:180px;font-weight:500">${esc(r.company_name || MISSING)}</span>` },
  { key: 'pricing_tier', label: 'Tier', render: (r) => tierBadge(r.pricing_tier) },
  { key: 'credit_limit', label: 'Credit Limit', sortable: true, render: (r) => `<span style="font-weight:500">${formatPrice(r.credit_limit)}</span>` },
  { key: 'credit_used', label: 'Credit Used', render: (r) => {
    const pct = r.credit_limit > 0 ? Math.round((r.credit_used / r.credit_limit) * 100) : 0;
    return `<span>${formatPrice(r.credit_used)}</span> <span style="font-size:11px;color:var(--text-muted)">(${pct}%)</span>`;
  }},
  { key: 'net30_approved', label: 'Net 30', render: (r) => r.net30_approved
    ? `<span style="color:var(--success);font-weight:600">Yes</span>`
    : `<span style="color:var(--text-muted)">No</span>` },
  { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
  { key: 'approved_at', label: 'Since', render: (r) => formatDate(r.approved_at) },
];

// ---- Invoices columns ----
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
    let btns = `<button class="admin-btn admin-btn--xs admin-btn--ghost inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="pdf" style="margin-right:4px" title="Download PDF">${icon('download', 14, 14)}</button>`
             + `<button class="admin-btn admin-btn--xs admin-btn--ghost inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="email" style="margin-right:4px" title="Send Email">${icon('mail', 14, 14)}</button>`;
    if (s !== 'paid') btns += `<button class="admin-btn admin-btn--xs admin-btn--primary inv-action" data-id="${Security.escapeAttr(r.id)}" data-action="record-payment" title="Record Payment">${icon('finance', 14, 14)}</button>`;
    return btns;
  }},
];

// ---- Data loading ----
async function loadStats() {
  const statsEl = _container?.querySelector('#b2b-stats');
  if (!statsEl) return;
  const data = await AdminAPI.getBusinessStats();
  if (!data) return;
  statsEl.innerHTML = `
    <div class="admin-kpi">
      <div class="admin-kpi__label">Approved Partners</div>
      <div class="admin-kpi__value">${data.total_approved ?? MISSING}</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi__label">Pending Applications</div>
      <div class="admin-kpi__value">${data.pending_count ?? MISSING}</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi__label">Net 30 Outstanding</div>
      <div class="admin-kpi__value">${data.net30_outstanding != null ? formatPrice(data.net30_outstanding) : MISSING}</div>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi__label">MTD Invoiced</div>
      <div class="admin-kpi__value">${data.mtd_invoiced != null ? formatPrice(data.mtd_invoiced) : MISSING}</div>
    </div>
  `;
}

async function loadApplications() {
  if (_appTable) _appTable.setLoading(true);
  const data = await AdminAPI.getBusinessApplications({ status: _statusFilter, search: _search }, _appPage, 20);
  if (!data) { if (_appTable) _appTable.setData([], null); return; }
  const rows = data.applications || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_appTable) _appTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _appPage, limit: 20 });
}

async function loadAccounts() {
  if (_accountTable) _accountTable.setLoading(true);
  const data = await AdminAPI.getBusinessAccounts({ search: _search }, _accountPage, 20);
  if (!data) { if (_accountTable) _accountTable.setData([], null); return; }
  const rows = data.accounts || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_accountTable) _accountTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _accountPage, limit: 20 });
}

async function loadInvoices() {
  if (_invoiceTable) _invoiceTable.setLoading(true);
  const data = await AdminAPI.getBusinessInvoicesAdmin({ status: _invoiceStatusFilter, search: _search }, _invoicePage, 20);
  if (!data) { if (_invoiceTable) _invoiceTable.setData([], null); return; }
  const rows = data.invoices || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_invoiceTable) _invoiceTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _invoicePage, limit: 20 });
}

// ---- Application drawer ----
async function openApplicationDrawer(app) {
  const d = Drawer.open({
    title: esc(app.company_name || 'Application Detail'),
    width: '480px',
    body: buildAppDrawerBody(app),
    footer: buildAppDrawerFooter(app),
  });
  if (!d) return;

  d.footer.querySelector('#b2b-drawer-approve')?.addEventListener('click', async () => {
    const creditLimit = parseFloat(d.body.querySelector('#b2b-credit-limit')?.value) || 0;
    const pricingTier = d.body.querySelector('#b2b-pricing-tier')?.value || 'bronze';
    const net30 = d.body.querySelector('#b2b-net30')?.checked ?? app.apply_net30 ?? false;
    try {
      await AdminAPI.approveBusinessApplication(app.id, { credit_limit: creditLimit, pricing_tier: pricingTier, net30_approved: net30 });
      Toast.success(`${app.company_name || 'Application'} approved`);
      d.close();
      loadApplications();
      loadStats();
    } catch (e) { Toast.error('Approval failed: ' + e.message); }
  });

  d.footer.querySelector('#b2b-drawer-decline')?.addEventListener('click', async () => {
    const reason = prompt('Reason for declining (optional):') || '';
    try {
      await AdminAPI.declineBusinessApplication(app.id, reason);
      Toast.success(`${app.company_name || 'Application'} declined`);
      d.close();
      loadApplications();
    } catch (e) { Toast.error('Decline failed: ' + e.message); }
  });

  d.footer.querySelector('#b2b-drawer-save')?.addEventListener('click', async () => {
    const creditLimit = parseFloat(d.body.querySelector('#b2b-credit-limit')?.value) || 0;
    const pricingTier = d.body.querySelector('#b2b-pricing-tier')?.value || 'bronze';
    const net30 = d.body.querySelector('#b2b-net30')?.checked ?? false;
    try {
      await AdminAPI.updateBusinessSettings(app.id, { credit_limit: creditLimit, pricing_tier: pricingTier, net30_approved: net30 });
      Toast.success('Settings updated');
      d.close();
      loadApplications();
    } catch (e) { Toast.error('Update failed: ' + e.message); }
  });
}

function buildAppDrawerBody(app) {
  const billing = app.billing_address || {};
  const shipping = app.shipping_address || {};
  return `
    <div style="margin-bottom:16px">${statusBadge(app.status)} ${tierBadge(app.pricing_tier)}</div>
    <div class="admin-detail-section">
      <h3 class="admin-detail-heading">Company</h3>
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
      <div style="font-size:13px;color:var(--text-secondary);line-height:1.6">
        ${esc(billing.address1 || MISSING)}<br>
        ${billing.address2 ? esc(billing.address2) + '<br>' : ''}
        ${esc(billing.city || '')} ${esc(billing.region || '')} ${esc(billing.postcode || '')}
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
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Credit Limit (NZD)</label>
        <input type="number" id="b2b-credit-limit" class="admin-input" style="width:100%" min="0" step="100" value="${app.credit_limit || 0}">
      </div>
      <div class="admin-form-group" style="margin-bottom:12px">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Pricing Tier</label>
        <select id="b2b-pricing-tier" class="admin-select" style="width:100%">
          <option value="bronze"${(app.pricing_tier || '').toLowerCase() === 'bronze' ? ' selected' : ''}>Bronze (5% off)</option>
          <option value="silver"${(app.pricing_tier || '').toLowerCase() === 'silver' ? ' selected' : ''}>Silver (10% off)</option>
          <option value="gold"${(app.pricing_tier || '').toLowerCase() === 'gold' ? ' selected' : ''}>Gold (15% off)</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" id="b2b-net30" ${app.net30_approved || app.apply_net30 ? 'checked' : ''}>
          Approve Net 30 terms
        </label>
      </div>
    </div>
    <div class="admin-detail-row" style="margin-top:16px"><span>Submitted</span><span>${formatDate(app.submitted_at || app.created_at)}</span></div>
  `;
}

function buildAppDrawerFooter(app) {
  const s = (app.status || 'pending').toLowerCase();
  if (s === 'pending') {
    return `
      <button class="admin-btn admin-btn--primary" id="b2b-drawer-approve">Approve</button>
      <button class="admin-btn admin-btn--ghost" id="b2b-drawer-decline" style="color:var(--danger);border-color:var(--danger)">Decline</button>
    `;
  }
  return `<button class="admin-btn admin-btn--primary" id="b2b-drawer-save">Save Settings</button>`;
}

// ---- Account drawer ----
function openAccountDrawer(account) {
  const d = Drawer.open({
    title: esc(account.company_name || 'Business Account'),
    width: '420px',
    body: `
      <div style="margin-bottom:16px">${statusBadge(account.status)} ${tierBadge(account.pricing_tier)}</div>
      <div class="admin-detail-section">
        <h3 class="admin-detail-heading">Account Details</h3>
        <div class="admin-detail-row"><span>Partner since</span><span>${formatDate(account.approved_at)}</span></div>
        <div class="admin-detail-row"><span>Net 30</span><span>${account.net30_approved ? 'Approved' : 'Not approved'}</span></div>
      </div>
      <div class="admin-detail-section">
        <h3 class="admin-detail-heading">Credit</h3>
        <div class="admin-detail-row"><span>Limit</span><span>${formatPrice(account.credit_limit)}</span></div>
        <div class="admin-detail-row"><span>Used</span><span>${formatPrice(account.credit_used)}</span></div>
        <div class="admin-detail-row"><span>Remaining</span><span>${formatPrice((account.credit_limit || 0) - (account.credit_used || 0))}</span></div>
      </div>
      <div class="admin-detail-section">
        <h3 class="admin-detail-heading">Edit Settings</h3>
        <div class="admin-form-group" style="margin-bottom:12px">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Credit Limit (NZD)</label>
          <input type="number" id="acct-credit-limit" class="admin-input" style="width:100%" min="0" step="100" value="${account.credit_limit || 0}">
        </div>
        <div class="admin-form-group" style="margin-bottom:12px">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Pricing Tier</label>
          <select id="acct-pricing-tier" class="admin-select" style="width:100%">
            <option value="bronze"${(account.pricing_tier || '').toLowerCase() === 'bronze' ? ' selected' : ''}>Bronze (5% off)</option>
            <option value="silver"${(account.pricing_tier || '').toLowerCase() === 'silver' ? ' selected' : ''}>Silver (10% off)</option>
            <option value="gold"${(account.pricing_tier || '').toLowerCase() === 'gold' ? ' selected' : ''}>Gold (15% off)</option>
          </select>
        </div>
        <div class="admin-form-group" style="margin-bottom:12px">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Account Status</label>
          <select id="acct-status" class="admin-select" style="width:100%">
            <option value="active"${account.status === 'active' ? ' selected' : ''}>Active</option>
            <option value="suspended"${account.status === 'suspended' ? ' selected' : ''}>Suspended</option>
          </select>
        </div>
        <div class="admin-form-group">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
            <input type="checkbox" id="acct-net30" ${account.net30_approved ? 'checked' : ''}>
            Net 30 approved
          </label>
        </div>
      </div>
    `,
    footer: `<button class="admin-btn admin-btn--primary" id="acct-save-btn">Save Changes</button>`,
  });
  if (!d) return;

  d.footer.querySelector('#acct-save-btn')?.addEventListener('click', async () => {
    try {
      await AdminAPI.updateBusinessSettings(account.id, {
        credit_limit: parseFloat(d.body.querySelector('#acct-credit-limit')?.value) || 0,
        pricing_tier: d.body.querySelector('#acct-pricing-tier')?.value || 'bronze',
        status: d.body.querySelector('#acct-status')?.value || 'active',
        net30_approved: d.body.querySelector('#acct-net30')?.checked ?? false,
      });
      Toast.success('Account updated');
      d.close();
      loadAccounts();
    } catch (e) { Toast.error('Update failed: ' + e.message); }
  });
}

// ---- Invoice actions ----
async function handleInvoiceAction(invoiceId, action) {
  try {
    if (action === 'pdf') {
      const result = await AdminAPI.generateInvoicePdf(invoiceId);
      // PDFs are in a private bucket — backend returns a signed URL
      const signedUrl = result?.signed_url || result?.pdf_url;
      if (signedUrl) window.open(signedUrl, '_blank');
      else Toast.warning('PDF not available yet');
      Toast.success('PDF generated');
    } else if (action === 'email') {
      await AdminAPI.sendInvoiceEmail(invoiceId);
      Toast.success('Invoice email sent');
    } else if (action === 'record-payment') {
      if (!confirm('Record this invoice as paid?')) return;
      await AdminAPI.recordInvoicePayment(invoiceId);
      Toast.success('Payment recorded');
      loadInvoices();
      loadStats();
    }
  } catch (e) { Toast.error(`Failed: ${e.message}`); }
}

// ---- Quick actions from app table ----
async function handleQuickAppAction(appId, action) {
  if (action === 'approve') {
    try {
      await AdminAPI.approveBusinessApplication(appId, { credit_limit: 0, pricing_tier: 'bronze' });
      Toast.success('Application approved (default settings — update tier/credit in the drawer)');
      loadApplications();
      loadStats();
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

// ---- Tab rendering ----
function renderApplicationsTab(content) {
  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div class="admin-tabs" id="app-status-tabs" style="margin-bottom:0">
        <button class="admin-tab${_statusFilter === 'pending' ? ' active' : ''}" data-app-status="pending">Pending</button>
        <button class="admin-tab${_statusFilter === 'approved' ? ' active' : ''}" data-app-status="approved">Approved</button>
        <button class="admin-tab${_statusFilter === '' ? ' active' : ''}" data-app-status="">All</button>
      </div>
    </div>
    <div id="app-table-wrap"></div>
  `;

  content.querySelector('#app-status-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-app-status]');
    if (!btn) return;
    _statusFilter = btn.dataset.appStatus;
    _appPage = 1;
    content.querySelectorAll('#app-status-tabs .admin-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.appStatus === _statusFilter));
    loadApplications();
  });

  _appTable = new DataTable(content.querySelector('#app-table-wrap'), {
    columns: APP_COLUMNS,
    rowKey: 'id',
    emptyMessage: 'No business applications found',
    onPageChange: (page) => { _appPage = page; loadApplications(); },
    onRowClick: (row) => openApplicationDrawer(row),
  });

  content.querySelector('#app-table-wrap').addEventListener('click', (e) => {
    const btn = e.target.closest('.b2b-app-action');
    if (!btn) return;
    e.stopPropagation();
    handleQuickAppAction(btn.dataset.id, btn.dataset.action);
  });

  loadApplications();
}

function renderAccountsTab(content) {
  content.innerHTML = `<div id="acct-table-wrap"></div>`;

  _accountTable = new DataTable(content.querySelector('#acct-table-wrap'), {
    columns: ACCOUNT_COLUMNS,
    rowKey: 'id',
    emptyMessage: 'No approved business accounts yet',
    onPageChange: (page) => { _accountPage = page; loadAccounts(); },
    onRowClick: (row) => openAccountDrawer(row),
  });

  loadAccounts();
}

function renderInvoicesTab(content) {
  content.innerHTML = `
    <div style="margin-bottom:16px">
      <div class="admin-tabs" id="inv-status-tabs">
        <button class="admin-tab${_invoiceStatusFilter === '' ? ' active' : ''}" data-inv-status="">All</button>
        <button class="admin-tab${_invoiceStatusFilter === 'unpaid' ? ' active' : ''}" data-inv-status="unpaid">Unpaid</button>
        <button class="admin-tab${_invoiceStatusFilter === 'overdue' ? ' active' : ''}" data-inv-status="overdue">Overdue</button>
        <button class="admin-tab${_invoiceStatusFilter === 'paid' ? ' active' : ''}" data-inv-status="paid">Paid</button>
      </div>
    </div>
    <div id="inv-table-wrap"></div>
  `;

  content.querySelector('#inv-status-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inv-status]');
    if (!btn) return;
    _invoiceStatusFilter = btn.dataset.invStatus;
    _invoicePage = 1;
    content.querySelectorAll('#inv-status-tabs .admin-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.invStatus === _invoiceStatusFilter));
    loadInvoices();
  });

  _invoiceTable = new DataTable(content.querySelector('#inv-table-wrap'), {
    columns: INVOICE_COLUMNS,
    rowKey: 'id',
    emptyMessage: 'No invoices yet',
    onPageChange: (page) => { _invoicePage = page; loadInvoices(); },
  });

  content.querySelector('#inv-table-wrap').addEventListener('click', (e) => {
    const btn = e.target.closest('.inv-action');
    if (!btn) return;
    e.stopPropagation();
    handleInvoiceAction(btn.dataset.id, btn.dataset.action);
  });

  loadInvoices();
}

function switchTab(tab) {
  if (tab === _activeTab) return;
  destroyCurrentTab();
  _activeTab = tab;

  _container.querySelectorAll('.b2b-hub-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.hubTab === tab));

  const content = _container.querySelector('#b2b-hub-content');
  content.innerHTML = '';

  if (tab === 'applications') renderApplicationsTab(content);
  else if (tab === 'accounts') renderAccountsTab(content);
  else if (tab === 'invoices') renderInvoicesTab(content);
}

function destroyCurrentTab() {
  if (_appTable) { _appTable.destroy(); _appTable = null; }
  if (_accountTable) { _accountTable.destroy(); _accountTable = null; }
  if (_invoiceTable) { _invoiceTable.destroy(); _invoiceTable = null; }
}

export default {
  title: 'B2B Partners',

  async init(container) {
    _container = container;
    _appPage = 1;
    _accountPage = 1;
    _invoicePage = 1;
    _search = '';
    _statusFilter = 'pending';
    _invoiceStatusFilter = '';
    _activeTab = 'applications';

    FilterState.showBar(false);

    container.innerHTML = `
      <div class="admin-page-header" style="margin-bottom:16px">
        <h1 class="admin-page-title">${icon('customers', 22, 22)} B2B Partners</h1>
      </div>

      <div class="admin-kpi-grid" id="b2b-stats" style="margin-bottom:24px">
        <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
        <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
        <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
        <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
      </div>

      <div class="admin-tabs" style="margin-bottom:20px">
        <button class="admin-tab b2b-hub-tab active" data-hub-tab="applications">Applications</button>
        <button class="admin-tab b2b-hub-tab" data-hub-tab="accounts">Approved Accounts</button>
        <button class="admin-tab b2b-hub-tab" data-hub-tab="invoices">Net 30 Invoices</button>
      </div>

      <div id="b2b-hub-content"></div>
    `;

    container.querySelector('.admin-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.b2b-hub-tab');
      if (btn) switchTab(btn.dataset.hubTab);
    });

    const content = container.querySelector('#b2b-hub-content');
    renderApplicationsTab(content);
    loadStats();
  },

  destroy() {
    destroyCurrentTab();
    _container = null;
  },

  onSearch(query) {
    _search = query;
    _appPage = 1;
    _accountPage = 1;
    _invoicePage = 1;
    if (_activeTab === 'applications') loadApplications();
    else if (_activeTab === 'accounts') loadAccounts();
    else if (_activeTab === 'invoices') loadInvoices();
  },

  onFilterChange() {},
};
