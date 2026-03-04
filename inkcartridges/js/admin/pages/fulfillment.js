/**
 * Fulfillment Page — Shipping operations view with SLA KPIs + order triage
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

function formatDateTime(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return MISSING; }
}

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(status || 'Unknown')}</span>`;
}

let _container = null;
let _table = null;
let _page = 1;
let _sort = 'created_at';
let _sortDir = 'desc';
let _activeTab = 'ready';
let _workQueue = null;

const TAB_STATUSES = {
  ready: ['processing'],
  transit: ['shipped'],
  late: ['shipped'],
  all: [],
};

const COLUMNS = [
  {
    key: 'order_number', label: 'Order #', sortable: true,
    render: (r) => `<span class="cell-mono">${esc(r.order_number || r.id?.slice(0, 8) || MISSING)}</span>`,
  },
  {
    key: 'customer', label: 'Customer',
    render: (r) => {
      const profile = r.user_profile || r.user_profiles || r.customer || {};
      const name = r.customer_name || profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || r.customer_email || MISSING;
      return `<span class="cell-truncate">${esc(name)}</span>`;
    },
  },
  {
    key: 'status', label: 'Status', sortable: true,
    render: (r) => statusBadge(r.status),
  },
  {
    key: 'carrier', label: 'Carrier',
    render: (r) => esc(r.carrier || MISSING),
  },
  {
    key: 'tracking_number', label: 'Tracking',
    render: (r) => r.tracking_number ? `<span class="cell-mono">${esc(r.tracking_number)}</span>` : `<span class="cell-muted">${MISSING}</span>`,
  },
  {
    key: 'shipped_at', label: 'Shipped', sortable: true,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.shipped_at)}</span>`,
  },
  {
    key: 'estimated_delivery', label: 'Est. Delivery',
    render: (r) => {
      const est = r.estimated_delivery || r.estimated_delivery_at;
      if (!est) return `<span class="cell-muted">${MISSING}</span>`;
      const isLate = new Date(est) < new Date();
      return `<span class="cell-nowrap" style="${isLate ? 'color:var(--danger)' : ''}">${formatDate(est)}</span>`;
    },
  },
];

async function loadOrders() {
  _table.setLoading(true);
  const { from, to } = FilterState.getDateRange();
  const statuses = TAB_STATUSES[_activeTab] || [];
  const filters = { from, to, sort: _sort, order: _sortDir };
  if (statuses.length) filters.statuses = statuses;

  const data = await AdminAPI.getOrders(filters, _page, 20);
  if (!_table) return; // destroyed during await
  if (!data) { _table.setData([], null); return; }

  let rows = Array.isArray(data) ? data : (data.orders || data.data || []);

  // Client-side filter for "late" tab: shipped but past estimated delivery
  if (_activeTab === 'late') {
    const now = new Date();
    rows = rows.filter(r => {
      const est = r.estimated_delivery || r.estimated_delivery_at;
      return est && new Date(est) < now;
    });
  }

  const pagination = data.pagination || { total: _activeTab === 'late' ? rows.length : (data.total || rows.length), page: _page, limit: 20 };
  _table.setData(rows, pagination);
}

async function openFulfillmentDrawer(order) {
  const drawer = Drawer.open({
    title: `Order ${esc(order.order_number || order.id?.slice(0, 8) || '')}`,
  });
  if (!drawer) return;
  drawer.setLoading(true);

  const full = await AdminAPI.getOrder(order.id) || order;

  let html = '';

  // Order Info
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Order Details</div>`;
  html += detailRow('Status', statusBadge(full.status));
  html += detailRow('Created', formatDateTime(full.created_at));
  const profile = full.user_profile || full.user_profiles || full.customer || {};
  const custName = full.customer_name || profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || full.customer_email || MISSING;
  html += detailRow('Customer', esc(custName));
  html += detailRow('Email', esc(full.customer_email || profile.email || MISSING));
  const total = full.total_amount ?? full.total;
  if (total != null) html += detailRow('Total', `<span class="mono">${formatPrice(total)}</span>`);
  if (full.shipping_tier) html += detailRow('Shipping', esc(full.shipping_tier));
  if (full.delivery_zone) html += detailRow('Zone', esc(full.delivery_zone));
  html += `</div>`;

  // Shipment Info
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Shipment</div>`;
  html += detailRow('Carrier', esc(full.carrier || MISSING));
  html += detailRow('Tracking', full.tracking_number ? `<span class="mono">${esc(full.tracking_number)}</span>` : MISSING);
  if (full.shipped_at) html += detailRow('Shipped', formatDateTime(full.shipped_at));
  if (full.delivered_at) html += detailRow('Delivered', formatDateTime(full.delivered_at));
  const est = full.estimated_delivery || full.estimated_delivery_at;
  if (est) {
    const isLate = new Date(est) < new Date() && !full.delivered_at;
    html += detailRow('Est. Delivery', `<span style="${isLate ? 'color:var(--danger);font-weight:600' : ''}">${formatDate(est)}${isLate ? ' (LATE)' : ''}</span>`);
  }
  html += `</div>`;

  // Items
  if (full.items?.length) {
    html += `<div class="admin-detail-block">`;
    html += `<div class="admin-detail-block__title">Items (${full.items.length})</div>`;
    html += `<table class="admin-order-items"><thead><tr><th>Product</th><th>SKU</th><th>Qty</th></tr></thead><tbody>`;
    for (const item of full.items) {
      html += `<tr><td class="cell-truncate">${esc(item.product_name || item.name || MISSING)}</td>`;
      html += `<td class="mono">${esc(item.sku || MISSING)}</td>`;
      html += `<td>${item.qty ?? item.quantity ?? MISSING}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Actions
  const isPending = ['processing', 'paid'].includes((full.status || '').toLowerCase());
  const isShipped = (full.status || '').toLowerCase() === 'shipped';
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Actions</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:8px">`;
  if (isPending) {
    html += `<button class="admin-btn admin-btn--primary admin-btn--sm" data-action="ship">${icon('fulfillment', 14, 14)} Mark Shipped</button>`;
  }
  html += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="tracking">${icon('fulfillment', 14, 14)} Update Tracking</button>`;
  if (isShipped) {
    html += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="complete">${icon('orders', 14, 14)} Mark Delivered</button>`;
  }
  html += `</div></div>`;

  drawer.setBody(html);

  // Bind actions
  drawer.body.querySelector('[data-action="ship"]')?.addEventListener('click', async () => {
    showShipModal(full);
  });
  drawer.body.querySelector('[data-action="tracking"]')?.addEventListener('click', () => {
    showTrackingModal(full);
  });
  drawer.body.querySelector('[data-action="complete"]')?.addEventListener('click', async () => {
    try {
      await AdminAPI.updateOrderStatus(full.id, 'completed', {});
      Toast.success('Order marked as delivered');
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function detailRow(label, value) {
  return `<div class="admin-detail-row"><span class="admin-detail-row__label">${label}</span><span class="admin-detail-row__value">${value}</span></div>`;
}

function showShipModal(order) {
  const modal = Modal.open({
    title: 'Mark as Shipped',
    body: `
      <div class="admin-form-group"><label>Carrier *</label><select class="admin-select" id="ship-carrier"><option value="">Select carrier</option><option value="NZ Post">NZ Post</option><option value="CourierPost">CourierPost</option><option value="Aramex">Aramex</option><option value="DHL">DHL</option><option value="Other">Other</option></select></div>
      <div class="admin-form-group"><label>Tracking Number *</label><input class="admin-input" id="ship-tracking" placeholder="Enter tracking number"></div>
      <div class="admin-form-group"><label>Shipped At</label><input class="admin-input" type="datetime-local" id="ship-date" value="${new Date().toISOString().slice(0, 16)}"></div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-action="save">Ship Order</button>`,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const tracking = modal.body.querySelector('#ship-tracking').value.trim();
    if (!tracking) { Toast.warning('Tracking number required'); return; }
    const carrier = modal.body.querySelector('#ship-carrier').value;
    const shippedAt = modal.body.querySelector('#ship-date').value;
    try {
      await AdminAPI.updateOrderStatus(order.id, 'shipped', { carrier, tracking_number: tracking, shipped_at: shippedAt });
      Toast.success('Order shipped');
      Modal.close();
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function showTrackingModal(order) {
  const modal = Modal.open({
    title: 'Update Tracking',
    body: `
      <div class="admin-form-group"><label>Carrier</label><select class="admin-select" id="track-carrier"><option value="">Select carrier</option><option value="NZ Post"${order.carrier === 'NZ Post' ? ' selected' : ''}>NZ Post</option><option value="CourierPost"${order.carrier === 'CourierPost' ? ' selected' : ''}>CourierPost</option><option value="Aramex"${order.carrier === 'Aramex' ? ' selected' : ''}>Aramex</option><option value="DHL"${order.carrier === 'DHL' ? ' selected' : ''}>DHL</option><option value="Other">Other</option></select></div>
      <div class="admin-form-group"><label>Tracking Number</label><input class="admin-input" id="track-number" value="${esc(order.tracking_number || '')}"></div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button><button class="admin-btn admin-btn--primary" data-action="save">Save</button>`,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const carrier = modal.body.querySelector('#track-carrier').value;
    const tracking = modal.body.querySelector('#track-number').value.trim();
    if (!carrier || !tracking) { Toast.warning('Please fill in carrier and tracking'); return; }
    try {
      await AdminAPI.updateTracking(order.id, carrier, tracking, null);
      Toast.success('Tracking updated');
      Modal.close();
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

export default {
  title: 'Fulfillment',

  async init(container) {
    _container = container;
    _page = 1;
    _activeTab = 'ready';

    // Header
    const header = document.createElement('div');
    header.className = 'admin-page-header';
    header.innerHTML = `<h1>Fulfillment</h1>`;
    container.appendChild(header);

    // Fetch SLA + work queue in parallel
    const params = FilterState.getParams();
    const signal = FilterState.getAbortSignal();
    const [slaRes, wqRes] = await Promise.allSettled([
      AdminAPI.getFulfillmentSLA(params, signal),
      AdminAPI.getWorkQueue(signal),
    ]);
    const sla = slaRes.value;
    _workQueue = wqRes.value;

    // SLA KPIs
    const kpiRow = document.createElement('div');
    kpiRow.className = 'admin-kpi-grid';
    kpiRow.style.gridTemplateColumns = 'repeat(3, 1fr)';
    const median = sla?.median_hours;
    const pct48 = sla?.pct_48h;
    const trackCov = sla?.tracking_coverage;
    kpiRow.innerHTML = `
      <div class="admin-kpi"><div class="admin-kpi__label">Median Ship Time</div><div class="admin-kpi__value" style="font-size:22px">${median != null ? `${Number(median).toFixed(1)}h` : MISSING}</div></div>
      <div class="admin-kpi"><div class="admin-kpi__label">Shipped within 48h</div><div class="admin-kpi__value" style="font-size:22px">${pct48 != null ? `${Number(pct48).toFixed(0)}%` : MISSING}</div></div>
      <div class="admin-kpi"><div class="admin-kpi__label">Tracking Coverage</div><div class="admin-kpi__value" style="font-size:22px">${trackCov != null ? `${(Number(trackCov) * 100).toFixed(0)}%` : MISSING}</div></div>
    `;
    container.appendChild(kpiRow);

    // Work Queue cards
    const queueGrid = document.createElement('div');
    queueGrid.className = 'admin-queue-grid admin-mb';
    const qItems = [
      { label: 'Orders to Ship', key: 'orders_to_ship', iconType: 'warn', ic: 'orders' },
      { label: 'Missing Tracking', key: 'missing_tracking', iconType: 'warn', ic: 'fulfillment' },
      { label: 'Late Deliveries', key: 'late_deliveries', iconType: 'danger', ic: 'suppliers' },
    ];
    let qHtml = '';
    for (const q of qItems) {
      const count = _workQueue?.[q.key];
      qHtml += `<div class="admin-queue-item"><div class="admin-queue-item__icon admin-queue-item__icon--${q.iconType}">${icon(q.ic)}</div><div><div class="admin-queue-item__count">${count != null ? count : MISSING}</div><div class="admin-queue-item__label">${esc(q.label)}</div></div></div>`;
    }
    queueGrid.innerHTML = qHtml;
    container.appendChild(queueGrid);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'admin-tabs';
    tabs.id = 'fulfillment-tabs';
    const tabDefs = [
      { key: 'ready', label: 'Ready to Ship' },
      { key: 'transit', label: 'In Transit' },
      { key: 'late', label: 'Late' },
      { key: 'all', label: 'All' },
    ];
    for (const t of tabDefs) {
      tabs.innerHTML += `<button class="admin-tab${t.key === _activeTab ? ' active' : ''}" data-tab="${t.key}">${t.label}</button>`;
    }
    container.appendChild(tabs);

    tabs.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _activeTab = btn.dataset.tab;
        _page = 1;
        tabs.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
        loadOrders();
      });
    });

    // Table
    const tableContainer = document.createElement('div');
    container.appendChild(tableContainer);

    _table = new DataTable(tableContainer, {
      columns: COLUMNS,
      rowKey: 'id',
      onRowClick: (row) => openFulfillmentDrawer(row),
      onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadOrders(); },
      onPageChange: (page) => { _page = page; loadOrders(); },
      emptyMessage: 'No orders found',
      emptyIcon: icon('fulfillment', 40, 40),
    });

    await loadOrders();
  },

  destroy() {
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _page = 1;
    _workQueue = null;
  },

  async onFilterChange() {
    _page = 1;
    if (_table) await loadOrders();
  },
};
