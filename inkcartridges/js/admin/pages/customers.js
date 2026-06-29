/**
 * Customers Page — Customer directory with detail drawer + owner intelligence
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
// Invoicing address is stored as string[]; edited as a \n-joined textarea.
const linesToText = (a) => (Array.isArray(a) ? a.join('\n') : (a || ''));
const textToLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _sort = 'first_name';
let _sortDir = 'asc';
let _activeTab = 'all'; // all | contacts | reviews
let _subTabModule = null;

const COLUMNS = [
  {
    key: 'first_name', label: 'Name', sortable: true,
    render: (r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.full_name || r.email || MISSING;
      return `<span class="cell-truncate">${esc(name)}</span>`;
    },
  },
  {
    key: 'email', label: 'Email',
    render: (r) => `<span class="cell-truncate cell-muted">${esc(r.email || MISSING)}</span>`,
  },
  {
    key: 'order_count', label: 'Orders', sortable: true,
    render: (r) => `<span class="cell-center">${r.order_count ?? MISSING}</span>`,
    align: 'center',
  },
  {
    key: 'total_spent', label: 'Total Spent', sortable: true,
    render: (r) => `<span class="cell-mono cell-right">${r.total_spent != null ? formatPrice(r.total_spent) : MISSING}</span>`,
    align: 'right',
  },
  {
    key: 'last_order_date', label: 'Last Order', sortable: true,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.last_order_date || r.last_order_at)}</span>`,
  },
  {
    key: 'created_at', label: 'Joined', sortable: true,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.created_at)}</span>`,
  },
];

async function loadCustomers() {
  _table.setLoading(true);
  const filters = { search: _search, sort: _sort, order: _sortDir };
  const data = await AdminAPI.getCustomers(filters, _page, 20);
  if (!_table) return; // destroyed during await
  if (!data) { _table.setData([], null); return; }
  const rows = Array.isArray(data) ? data : (data.customers || data.data || []);
  const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: 20 };
  _table.setData(rows, pagination);
}

async function openCustomerDrawer(customer) {
  const drawer = Drawer.open({
    title: esc([customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || 'Customer'),
    width: '560px',
  });
  if (!drawer) return;
  drawer.setLoading(true);

  // Fetch recent orders + loyalty in parallel (loyalty is fail-soft / 404 until
  // the backend ships /api/admin/customers/:id/loyalty — see admin-loyalty-endpoints-jun2026.md).
  const [ordersRes, loyaltyRes] = await Promise.allSettled([
    AdminAPI.getOrders({ user_id: customer.id }, 1, 5),
    AdminAPI.getCustomerLoyalty(customer.id),
  ]);
  if (!drawer.el.isConnected) return; // drawer closed during await
  const ordersData = ordersRes.status === 'fulfilled' ? ordersRes.value : null;
  const orders = ordersData ? (Array.isArray(ordersData) ? ordersData : (ordersData.orders || ordersData.data || [])) : [];
  let loyaltyState = loyaltyRes.status === 'fulfilled' ? loyaltyRes.value : null;

  let html = '';

  // Profile
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Profile</div>`;
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.full_name || MISSING;
  html += detailRow('Name', esc(name));
  html += detailRow('Email', esc(customer.email || MISSING));
  html += detailRow('Joined', formatDate(customer.created_at));
  if (customer.account_type) html += detailRow('Account', esc(customer.account_type));
  if (customer.phone) html += detailRow('Phone', esc(customer.phone));
  html += `</div>`;

  // Customer KPIs
  const orderCount = customer.order_count ?? orders.length;
  const totalSpent = customer.total_spent;
  const aov = (totalSpent != null && orderCount > 0) ? totalSpent / orderCount : null;
  html += `<div class="admin-kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">`;
  html += miniKpi('Orders', orderCount != null ? orderCount : MISSING);
  html += miniKpi('Total Spent', totalSpent != null ? formatPrice(totalSpent) : MISSING);
  html += miniKpi('Avg Order', aov != null ? formatPrice(aov) : MISSING);
  html += miniKpi('Last Active', formatDate(customer.last_order_date || customer.last_order_at));
  html += `</div>`;

  // Recent Orders
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Recent Orders</div>`;
  if (orders.length) {
    html += `<table class="admin-order-items"><thead><tr><th>Date</th><th>Order #</th><th>Status</th><th class="cell-right">Total</th></tr></thead><tbody>`;
    for (const o of orders.slice(0, 5)) {
      const s = String(o.status || '').toLowerCase();
      html += `<tr>`;
      html += `<td class="cell-nowrap">${formatDate(o.created_at)}</td>`;
      html += `<td class="mono">${esc(o.order_number || o.id?.slice(0, 8) || MISSING)}</td>`;
      html += `<td><span class="admin-badge admin-badge--${esc(s)}">${esc(o.status || 'Unknown')}</span></td>`;
      html += `<td class="cell-right mono">${(o.total_amount ?? o.total) != null ? formatPrice(o.total_amount ?? o.total) : MISSING}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<p class="admin-text-muted">No orders found</p>`;
  }
  html += `</div>`;

  // Loyalty Points
  html += loyaltyPanelBlock(loyaltyState);

  // Saved invoicing profile (owner-only)
  html += invoicingBlock(customer);

  drawer.setBody(html);

  // Owner-only: wire the "Adjust points" action. The button is only rendered for
  // owners (loyaltyPanelBlock), so this is a no-op for non-owner admins.
  const adjustBtn = drawer.body.querySelector('#cust-loyalty-adjust');
  if (adjustBtn) {
    adjustBtn.addEventListener('click', () => openAdjustModal({
      customer,
      getState: () => loyaltyState,
      onAdjusted: (updated) => {
        if (updated) loyaltyState = updated;
        if (!drawer.el.isConnected) return;
        const panel = drawer.body.querySelector('#cust-loyalty-panel');
        if (panel) panel.innerHTML = loyaltyPanelInner(loyaltyState);
      },
    }));
  }

  // Owner-only: save the invoicing profile. Fail-soft until the backend ships.
  const invSaveBtn = drawer.body.querySelector('#cust-invoicing-save');
  if (invSaveBtn) {
    invSaveBtn.addEventListener('click', async () => {
      const scope = drawer.body.querySelector('#cust-invoicing');
      if (!scope) return;
      const payload = collectInvoicing(scope);
      invSaveBtn.disabled = true;
      const orig = invSaveBtn.textContent;
      invSaveBtn.textContent = 'Saving…';
      try {
        await AdminAPI.updateCustomerInvoicing(customer.id, payload);
        if (!drawer.el.isConnected) return;
        customer.invoicing = payload; // keep in-memory row in sync for re-open
        Toast.success('Invoicing details saved');
      } catch (e) {
        Toast.error(e.message || 'Could not save — the invoicing backend may not be live yet.');
      } finally {
        if (drawer.el.isConnected) { invSaveBtn.disabled = false; invSaveBtn.textContent = orig; }
      }
    });
  }
}

// ---- Loyalty points (admin view + adjust) ----
const LOYALTY_LEDGER_LABELS = {
  earn: 'Earned', bonus: 'Bonus', redeem: 'Redeemed',
  clawback: 'Reversed', restore: 'Restored', adjust: 'Adjustment',
};

// Inner content of the loyalty panel (re-rendered after an adjustment). Fail-soft:
// a null `loyalty` (e.g. backend still 404) shows a muted notice, never crashes.
function loyaltyPanelInner(loyalty) {
  if (!loyalty) return `<p class="admin-text-muted">Loyalty data unavailable.</p>`;
  const rate = loyalty.redemption_rate || 100;
  const balance = Number(loyalty.points_balance) || 0;
  const lifetime = loyalty.lifetime_earned;
  let h = `<div class="admin-kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">`;
  h += miniKpi('Points', balance.toLocaleString('en-NZ'));
  h += miniKpi('Value', formatPrice(balance / rate));
  h += miniKpi('Lifetime earned', lifetime != null ? Number(lifetime).toLocaleString('en-NZ') : MISSING);
  h += `</div>`;
  const ledger = Array.isArray(loyalty.ledger) ? loyalty.ledger : [];
  if (ledger.length) {
    h += `<table class="admin-order-items"><thead><tr><th>Date</th><th>Type</th><th class="cell-right">Points</th><th>Reason</th></tr></thead><tbody>`;
    for (const L of ledger.slice(0, 5)) {
      const pts = Number(L.points) || 0;
      const sign = pts > 0 ? '+' : '';
      h += `<tr>`;
      h += `<td class="cell-nowrap">${formatDate(L.created_at)}</td>`;
      h += `<td>${esc(LOYALTY_LEDGER_LABELS[L.type] || L.type || MISSING)}</td>`;
      h += `<td class="cell-right mono">${sign}${pts.toLocaleString('en-NZ')}</td>`;
      h += `<td>${esc(L.reason || L.order_number || MISSING)}</td>`;
      h += `</tr>`;
    }
    h += `</tbody></table>`;
  } else {
    h += `<p class="admin-text-muted">No points activity yet.</p>`;
  }
  return h;
}

// ---- Saved invoicing profile (owner-only) ----
// A reusable bill-to / deliver-to profile stored on the customer so the Invoices
// editor can pre-fill from it (preferred over scraping their latest order). The
// backend route PUT /api/admin/customers/:id/invoicing is fail-soft until live.
function invField(label, name, value, type = 'text') {
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <input class="admin-input" type="${type}" data-if="${name}" value="${escA(value)}"></label>`;
}
function invArea(label, name, value) {
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <textarea class="admin-input inv-textarea" data-if="${name}" rows="2">${esc(value)}</textarea></label>`;
}
function invoicingBlock(customer) {
  if (!AdminAuth.isOwner()) return '';
  const inv = customer.invoicing || {};
  const b = inv.bill_to || {};
  const d = inv.deliver_to || {};
  return `<div class="admin-detail-block">
    <div class="admin-detail-block__title">Invoicing details</div>
    <p class="admin-text-muted" style="margin-top:0;font-size:12px">Used to pre-fill invoices for this customer (falls back to their latest order address).</p>
    <div id="cust-invoicing">
      <div class="inv-section__title" style="margin-top:4px">Bill to</div>
      <div class="inv-grid-2">
        ${invField('Attn', 'bill_to.attn', b.attn || '')}
        ${invField('Name', 'bill_to.name', b.name || '')}
        ${invField('Company / line', 'bill_to.company', b.company || '')}
        ${invField('Phone', 'bill_to.phone', b.phone || '')}
        ${invField('Email', 'bill_to.email', b.email || '', 'email')}
      </div>
      ${invArea('Address (one line per row)', 'bill_to.address', linesToText(b.address))}
      <div class="inv-section__title" style="margin-top:8px">Deliver to (optional)</div>
      <div class="inv-grid-2">
        ${invField('Attn', 'deliver_to.attn', d.attn || '')}
        ${invField('Company / line', 'deliver_to.company', d.company || '')}
        ${invField('Phone', 'deliver_to.phone', d.phone || '')}
      </div>
      ${invArea('Delivery address', 'deliver_to.address', linesToText(d.address))}
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="cust-invoicing-save" type="button" style="margin-top:8px">${icon('check', 13, 13)} Save invoicing details</button>
    </div>
  </div>`;
}
function collectInvoicing(scope) {
  const out = { bill_to: {}, deliver_to: {} };
  scope.querySelectorAll('[data-if]').forEach((el) => {
    const [grp, key] = el.dataset.if.split('.');
    out[grp][key] = key === 'address' ? textToLines(el.value) : el.value.trim();
  });
  return out;
}

function loyaltyPanelBlock(loyalty) {
  const adjustBtn = AdminAuth.isOwner()
    ? `<button class="admin-btn admin-btn--ghost admin-btn--sm" id="cust-loyalty-adjust" type="button">${icon('finance', 13, 13)} Adjust points</button>`
    : '';
  return `<div class="admin-detail-block">
    <div class="admin-detail-block__title" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span>Loyalty Points</span>${adjustBtn}
    </div>
    <div id="cust-loyalty-panel">${loyaltyPanelInner(loyalty)}</div>
  </div>`;
}

function adjustForm(balance, rate) {
  return `
    <p class="admin-text-muted" style="margin-top:0">Current balance: <strong>${balance.toLocaleString('en-NZ')} pts</strong> (${formatPrice(balance / (rate || 100))})</p>
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      <div class="admin-form-group">
        <label>Direction *</label>
        <select class="admin-select" id="lp-dir">
          <option value="add">Add points</option>
          <option value="remove">Remove points</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Points *</label>
        <input class="admin-input" type="number" min="1" step="1" id="lp-points" placeholder="e.g. 500">
      </div>
    </div>
    <div class="admin-form-group">
      <label>Reason *</label>
      <input class="admin-input" id="lp-reason" maxlength="200" placeholder="e.g. Goodwill credit for delayed order">
    </div>
  `;
}

// Validate + build the signed adjustment payload. Returns null (and toasts) on
// invalid input. Backend also re-validates (INSUFFICIENT_BALANCE etc.).
function collectAdjust(body, balance) {
  const dir = body.querySelector('#lp-dir').value;
  const raw = parseInt(body.querySelector('#lp-points').value, 10);
  const reason = body.querySelector('#lp-reason').value.trim();
  if (!Number.isInteger(raw) || raw <= 0) { Toast.warning('Enter a whole number of points greater than zero'); return null; }
  if (!reason) { Toast.warning('A reason is required'); return null; }
  const points = dir === 'remove' ? -raw : raw;
  if (points < 0 && Math.abs(points) > balance) {
    Toast.warning(`Cannot remove more than the current balance (${balance.toLocaleString('en-NZ')} pts)`);
    return null;
  }
  return { points, reason, type: 'adjust' };
}

function openAdjustModal({ customer, getState, onAdjusted }) {
  const state = getState() || {};
  const balance = Number(state.points_balance) || 0;
  const rate = state.redemption_rate || 100;
  const who = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || 'Customer';
  const modal = Modal.open({
    title: `Adjust points — ${who}`,
    body: adjustForm(balance, rate),
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Save adjustment</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  const saveBtn = modal.footer.querySelector('[data-action="save"]');
  saveBtn.addEventListener('click', async () => {
    const payload = collectAdjust(modal.body, balance);
    if (!payload) return;
    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await AdminAPI.adjustCustomerPoints(customer.id, payload);
      Toast.success('Points adjusted');
      Modal.close();
      await onAdjusted(updated);
    } catch (e) {
      Toast.error(`Adjustment failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = orig;
    }
  });
}

function detailRow(label, value) {
  return `<div class="admin-detail-row"><span class="admin-detail-row__label">${label}</span><span class="admin-detail-row__value">${value}</span></div>`;
}

function miniKpi(label, value) {
  return `<div class="admin-kpi" style="padding:12px 14px"><div class="admin-kpi__label">${esc(label)}</div><div class="admin-kpi__value" style="font-size:18px">${esc(String(value))}</div></div>`;
}

async function handleExport(format = 'csv') {
  try {
    Toast.info(`Preparing ${format.toUpperCase()} export\u2026`);
    await AdminAPI.exportData('customers', format, FilterState.getParams());
    Toast.success('Customers exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

async function renderOwnerIntel(container) {
  if (!AdminAuth.isOwner()) return;

  const section = document.createElement('div');
  section.className = 'admin-section admin-mb-lg';
  section.innerHTML = `
    <div class="admin-section__header"><h2 class="admin-section__title">Customer Intelligence</h2></div>
    <div class="admin-kpi-grid" id="intel-kpis">
      <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
    </div>
    <div class="admin-grid-2 admin-mb">
      <div class="admin-card admin-card--cyan">
        <div class="admin-card__title">LTV Distribution</div>
        <div class="admin-chart-box"><canvas id="chart-ltv"></canvas></div>
      </div>
      <div class="admin-card admin-card--magenta">
        <div class="admin-card__title">Cohort Retention</div>
        <div id="cohort-table" style="overflow-x:auto;max-height:300px"></div>
      </div>
    </div>
  `;
  container.appendChild(section);

  // Fetch intelligence data in parallel
  const [ltv, cohorts, churn, nps, repeat] = await Promise.allSettled([
    AdminAPI.getCustomerLTV(),
    AdminAPI.getCohorts(),
    AdminAPI.getChurn(),
    AdminAPI.getNPS(),
    AdminAPI.getRepeatPurchase(),
  ]);

  const ltvData = ltv.value;
  const cohortsData = cohorts.value;
  const churnData = churn.value;
  const npsData = nps.value;
  const repeatData = repeat.value;

  // KPIs
  const kpiGrid = section.querySelector('#intel-kpis');
  const avgLtv = ltvData?.avg_ltv ?? ltvData?.average;
  const churnRate = churnData?.churn_rate ?? churnData?.rate;
  const npsScore = npsData?.score ?? npsData?.nps;
  const repeatRate = repeatData?.rate ?? repeatData?.repeat_rate;

  kpiGrid.innerHTML = `
    ${miniKpi('Avg LTV', avgLtv != null ? formatPrice(avgLtv) : MISSING)}
    ${miniKpi('Churn Rate', churnRate != null ? `${Number(churnRate).toFixed(1)}%` : MISSING)}
    ${miniKpi('NPS Score', npsScore != null ? npsScore : MISSING)}
    ${miniKpi('Repeat Rate', repeatRate != null ? `${Number(repeatRate).toFixed(1)}%` : MISSING)}
  `;

  // LTV Chart
  const customers = ltvData?.customers || ltvData?.data || [];
  if (customers.length) {
    const labels = customers.slice(0, 15).map(c => c.name || c.email?.split('@')[0] || '?');
    const values = customers.slice(0, 15).map(c => c.ltv || c.lifetime_value || 0);
    const colors = Charts.getThemeColors();
    Charts.bar('chart-ltv', {
      labels, datasets: [{ label: 'LTV', data: values, backgroundColor: colors.cyan + 'cc', borderRadius: 4 }],
      options: { indexAxis: 'y', plugins: { tooltip: { callbacks: { label: (ctx) => formatPrice(ctx.raw) } } } },
    });
  }

  // Cohort Table
  const cohortEl = section.querySelector('#cohort-table');
  const cohortRows = cohortsData?.cohorts || cohortsData?.data || [];
  if (cohortRows.length) {
    let tableHtml = '<table class="admin-table admin-cohort-table"><thead><tr><th>Cohort</th>';
    const maxMonths = Math.min(6, Math.max(...cohortRows.map(c => (c.retention || c.months || []).length)));
    for (let i = 0; i < maxMonths; i++) tableHtml += `<th>M${i}</th>`;
    tableHtml += '</tr></thead><tbody>';
    for (const c of cohortRows.slice(0, 8)) {
      tableHtml += `<tr><td class="cell-nowrap">${esc(c.cohort || c.month || MISSING)}</td>`;
      const vals = c.retention || c.months || [];
      for (let i = 0; i < maxMonths; i++) {
        const v = vals[i];
        if (v != null) {
          const pct = Number(v);
          const intensity = Math.min(1, pct / 100);
          tableHtml += `<td class="cell-center cell-mono" style="background:rgba(38,127,181,${(intensity * 0.5).toFixed(2)})">${pct.toFixed(0)}%</td>`;
        } else {
          tableHtml += `<td class="cell-center cell-muted">${MISSING}</td>`;
        }
      }
      tableHtml += '</tr>';
    }
    tableHtml += '</tbody></table>';
    cohortEl.innerHTML = tableHtml;
  } else {
    cohortEl.innerHTML = `<p class="admin-text-muted">Cohort data unavailable</p>`;
  }
}

// ---- Tab: All Customers ----
async function renderCustomersTab(container) {
  const header = document.createElement('div');
  header.className = 'admin-page-header';
  header.innerHTML = `
    <h1>Customers</h1>
    <div class="admin-page-header__actions">
      <div style="position:relative">
        <input class="admin-input" type="search" placeholder="Search\u2026" id="customer-search" style="width:220px;padding-left:32px">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)">${icon('search', 14, 14)}</span>
      </div>
      ${exportDropdown('export-customers')}
    </div>
  `;
  container.appendChild(header);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'admin-mb-lg';
  container.appendChild(tableContainer);

  _table = new DataTable(tableContainer, {
    columns: COLUMNS,
    rowKey: 'id',
    onRowClick: (row) => openCustomerDrawer(row),
    onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadCustomers(); },
    onPageChange: (page) => { _page = page; loadCustomers(); },
    emptyMessage: 'No customers found',
    emptyIcon: icon('customers', 40, 40),
  });

  const searchInput = header.querySelector('#customer-search');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      _search = searchInput.value.trim();
      _page = 1;
      loadCustomers();
    }, 300);
  });

  bindExportDropdown(header, 'export-customers', handleExport);
  await loadCustomers();
}

function destroyCustomersTab() {
  Charts.destroyAll();
  if (_table) _table.destroy();
  _table = null;
}

// ---- Tab switching ----
async function switchCustomerTab(tab) {
  if (tab === _activeTab) return;
  if (tab === 'contacts' && !AdminAuth.isOwner()) return; // owner-only surface

  if (_activeTab === 'all') destroyCustomersTab();
  if (_subTabModule?.destroy) _subTabModule.destroy();
  _subTabModule = null;

  _activeTab = tab;
  _container.querySelectorAll('.admin-tab[data-cust-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.custTab === tab);
  });

  const content = _container.querySelector('#customers-tab-content');
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (tab === 'all') {
    content.innerHTML = '';
    await renderCustomersTab(content);
  } else if (tab === 'contacts') {
    try {
      const mod = await import('./contacts.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Contacts</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  } else if (tab === 'reviews') {
    try {
      const mod = await import('./reviews.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Reviews</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  }
}

export default {
  title: 'Customers',

  async init(container) {
    _container = container;
    FilterState.setVisibleFilters([]);
    _page = 1;
    _search = '';
    _activeTab = 'all';
    _subTabModule = null;

    // Tab bar. Contacts is owner-only — the backend gates /api/admin/contacts to
    // super_admin (matching the standalone-invoices owner gate), so a non-owner
    // admin would only see 403s. Hide the tab rather than show a broken surface.
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-tabs';
    const contactsTab = AdminAuth.isOwner()
      ? '<button class="admin-tab" data-cust-tab="contacts">Contacts</button>'
      : '';
    tabBar.innerHTML = `
      <button class="admin-tab active" data-cust-tab="all">All Customers</button>
      ${contactsTab}
      <button class="admin-tab" data-cust-tab="reviews">Reviews</button>
    `;
    container.appendChild(tabBar);

    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cust-tab]');
      if (btn) switchCustomerTab(btn.dataset.custTab);
    });

    const content = document.createElement('div');
    content.id = 'customers-tab-content';
    container.appendChild(content);

    await renderCustomersTab(content);
  },

  destroy() {
    if (_activeTab === 'all') destroyCustomersTab();
    if (_subTabModule?.destroy) _subTabModule.destroy();
    _subTabModule = null;
    _container = null;
    _search = '';
    _page = 1;
    _activeTab = 'all';
  },

  async onFilterChange() {
    _page = 1;
    if (_activeTab === 'all' && _table) {
      await loadCustomers();
    } else if (_subTabModule?.onFilterChange) {
      _subTabModule.onFilterChange();
    }
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    if (_activeTab === 'all') {
      const input = document.getElementById('customer-search');
      if (input && input.value !== query) input.value = query;
      if (_table) loadCustomers();
    } else if (_subTabModule?.onSearch) {
      _subTabModule.onSearch(query);
    }
  },
};
