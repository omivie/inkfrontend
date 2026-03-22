/**
 * Customers Page — Customer directory with detail drawer + owner intelligence
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _sort = 'created_at';
let _sortDir = 'desc';

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

  // Fetch recent orders for this customer
  const ordersData = await AdminAPI.getOrders({ user_id: customer.id }, 1, 5);
  const orders = ordersData ? (Array.isArray(ordersData) ? ordersData : (ordersData.orders || ordersData.data || [])) : [];

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

  drawer.setBody(html);
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
      <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
      <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
      <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
      <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
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

export default {
  title: 'Customers',

  async init(container) {
    _container = container;
    FilterState.setVisibleFilters([]);
    _page = 1;
    _search = '';

    // Header
    const header = document.createElement('div');
    header.className = 'admin-page-header';
    header.innerHTML = `
      <h1>Customers</h1>
      <div class="admin-page-header__actions">
        <div style="position:relative">
          <input class="admin-input" type="search" placeholder="Search customers\u2026" id="customer-search" style="width:220px;padding-left:32px">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)">${icon('search', 14, 14)}</span>
        </div>
        ${exportDropdown('export-customers')}
      </div>
    `;
    container.appendChild(header);

    // Table container
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

    // Search
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

    // Export
    bindExportDropdown(header, 'export-customers', handleExport);

    await loadCustomers();
  },

  destroy() {
    Charts.destroyAll();
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _search = '';
    _page = 1;
  },

  async onFilterChange() {
    _page = 1;
    if (_table) await loadCustomers();
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    const input = document.getElementById('customer-search');
    if (input && input.value !== query) input.value = query;
    if (_table) loadCustomers();
  },
};
