/**
 * Orders Page — Triage queue with detail drawer
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
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
let _sort = 'created_at';
let _sortDir = 'desc';

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(status || 'Unknown')}</span>`;
}

function formatDate(d) {
  if (!d) return MISSING;
  try {
    return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return MISSING; }
}

function formatDateTime(d) {
  if (!d) return MISSING;
  try {
    return new Date(d).toLocaleString('en-NZ', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return MISSING; }
}

const COLUMNS = [
  {
    key: 'created_at', label: 'Date', sortable: true,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.created_at)}</span>`,
  },
  {
    key: 'order_number', label: 'Order #', sortable: true,
    render: (r) => `<span class="cell-mono">${esc(r.order_number || r.id?.slice(0, 8) || MISSING)}</span>`,
  },
  {
    key: 'customer', label: 'Customer',
    render: (r) => {
      const profile = r.user_profile || r.user_profiles || r.customer || {};
      const name = r.customer_name || profile.full_name
        || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
        || r.customer_email || profile.email || MISSING;
      return `<span class="cell-truncate">${esc(name)}</span>`;
    },
  },
  {
    key: 'status', label: 'Status', sortable: true,
    render: (r) => statusBadge(r.status),
  },
  {
    key: 'items', label: 'Items',
    render: (r) => {
      const count = r.item_count || r.items?.length || MISSING;
      return `<span class="cell-center">${count}</span>`;
    },
    align: 'center',
  },
  {
    key: 'total', label: 'Total', sortable: true,
    render: (r) => `<span class="cell-mono cell-right">${(r.total_amount ?? r.total) != null ? formatPrice(r.total_amount ?? r.total) : MISSING}</span>`,
    align: 'right',
  },
];

async function loadOrders() {
  _table.setLoading(true);
  const { from, to } = FilterState.getDateRange();
  const filters = {
    from, to,
    statuses: FilterState.get('statuses'),
    brands: FilterState.get('brands'),
    search: _search,
    sort: _sort,
    order: _sortDir,
  };
  const data = await AdminAPI.getOrders(filters, _page, 20);
  if (!_table) return; // destroyed during await
  if (!data) {
    _table.setData([], null);
    return;
  }
  const rows = Array.isArray(data) ? data : (data.orders || data.data || []);
  const pagination = data.pagination || {
    total: data.total || rows.length,
    page: _page,
    limit: 20,
  };
  _table.setData(rows, pagination);
}

async function openOrderDrawer(order) {
  const drawer = Drawer.open({
    title: `Order ${esc(order.order_number || order.id?.slice(0, 8) || '')}`,
  });
  if (!drawer) return;
  drawer.setLoading(true);

  // Fetch full order + events
  const [fullOrder, events] = await Promise.all([
    AdminAPI.getOrder(order.id),
    AdminAPI.getOrderEvents(order.id),
  ]);

  const o = fullOrder || order;
  let html = '';

  // Order Info
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Order Details</div>`;
  html += detailRow('Status', statusBadge(o.status));
  html += detailRow('Created', formatDateTime(o.created_at));
  const profile = o.user_profile || o.user_profiles || o.customer || {};
  const custName = o.customer_name || profile.full_name
    || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || o.customer_email || profile.email || MISSING;
  html += detailRow('Customer', esc(custName));
  html += detailRow('Email', esc(o.customer_email || profile.email || MISSING));
  const orderTotal = o.total_amount ?? o.total;
  if (orderTotal != null) html += detailRow('Total', `<span class="mono">${formatPrice(orderTotal)}</span>`);
  if (o.shipping_tier) html += detailRow('Shipping', esc(o.shipping_tier) + (o.shipping_fee != null ? ` (${formatPrice(o.shipping_fee)})` : ''));
  if (o.delivery_zone) html += detailRow('Zone', esc(o.delivery_zone));
  if (o.carrier || o.tracking_number) {
    html += detailRow('Carrier', esc(o.carrier || MISSING));
    html += detailRow('Tracking', esc(o.tracking_number || MISSING));
  }
  if (o.paid_at) html += detailRow('Paid', formatDateTime(o.paid_at));
  if (o.shipped_at) html += detailRow('Shipped', formatDateTime(o.shipped_at));
  if (o.delivered_at) html += detailRow('Delivered', formatDateTime(o.delivered_at));
  if (o.completed_at) html += detailRow('Completed', formatDateTime(o.completed_at));
  if (o.cancelled_at) html += detailRow('Cancelled', formatDateTime(o.cancelled_at));
  html += `</div>`;

  // Items
  if (o.items?.length) {
    html += `<div class="admin-detail-block">`;
    html += `<div class="admin-detail-block__title">Items (${o.items.length})</div>`;
    html += `<table class="admin-order-items"><thead><tr>`;
    html += `<th>Product</th><th>SKU</th><th>Qty</th><th>Price</th>`;
    const showCost = AdminAuth.isOwner();
    if (showCost) html += `<th>Cost</th>`;
    html += `</tr></thead><tbody>`;
    for (const item of o.items) {
      html += `<tr>`;
      html += `<td class="cell-truncate">${esc(item.product_name || item.name || MISSING)}</td>`;
      html += `<td class="mono">${esc(item.sku || MISSING)}</td>`;
      html += `<td>${item.qty ?? item.quantity ?? MISSING}</td>`;
      const itemPrice = item.sell_price ?? item.unit_price ?? item.price;
      html += `<td class="mono">${itemPrice != null ? formatPrice(itemPrice) : MISSING}</td>`;
      if (showCost) {
        html += `<td class="mono">${item.supplier_cost_snapshot != null ? formatPrice(item.supplier_cost_snapshot) : MISSING}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Timeline
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Timeline</div>`;
  if (events?.length) {
    html += `<div class="admin-timeline">`;
    for (const ev of events) {
      const dotClass = ev.type === 'status_change' ? 'cyan' : (ev.type === 'refund_created' || ev.type === 'refund') ? 'magenta' : 'yellow';
      html += `<div class="admin-timeline__item">`;
      html += `<div class="admin-timeline__dot admin-timeline__dot--${dotClass}"></div>`;
      html += `<div class="admin-timeline__time">${formatDateTime(ev.created_at)}</div>`;
      html += `<div class="admin-timeline__text"><strong>${esc(ev.type || 'Event')}</strong>`;
      if (ev.payload?.note) html += ` \u2014 ${esc(ev.payload.note)}`;
      if (ev.payload?.status) html += ` \u2192 ${statusBadge(ev.payload.status)}`;
      html += `</div></div>`;
    }
    html += `</div>`;
  } else {
    html += `<p class="admin-text-muted" data-tooltip="Requires order_events table">${MISSING} No timeline events</p>`;
  }
  html += `</div>`;

  // Actions
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Actions</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:8px">`;
  html += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="update-status">${icon('orders', 14, 14)} Update Status</button>`;
  html += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="add-tracking">${icon('fulfillment', 14, 14)} Add Tracking</button>`;
  html += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="add-note">${icon('dashboard', 14, 14)} Add Note</button>`;
  html += `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="create-refund">${icon('refunds', 14, 14)} Refund</button>`;
  html += `</div></div>`;

  drawer.setBody(html);
  bindDrawerActions(drawer, o);
}

function detailRow(label, value) {
  return `<div class="admin-detail-row"><span class="admin-detail-row__label">${label}</span><span class="admin-detail-row__value">${value}</span></div>`;
}

function bindDrawerActions(drawer, order) {
  const body = drawer.body;

  body.querySelector('[data-action="update-status"]')?.addEventListener('click', () => {
    showStatusModal(order);
  });

  body.querySelector('[data-action="add-tracking"]')?.addEventListener('click', () => {
    showTrackingModal(order);
  });

  body.querySelector('[data-action="add-note"]')?.addEventListener('click', () => {
    showNoteModal(order);
  });

  body.querySelector('[data-action="create-refund"]')?.addEventListener('click', () => {
    showRefundModal(order);
  });
}

// Backend state machine: valid transitions from each status
const STATUS_TRANSITIONS = {
  pending: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['completed'],
  completed: [],
  cancelled: [],
};

function showStatusModal(order) {
  const current = (order.status || '').toLowerCase();
  const allowed = STATUS_TRANSITIONS[current] || [];

  if (!allowed.length) {
    Toast.warning(`Order is ${current} — no further status transitions available`);
    return;
  }

  // If shipped is an option, show tracking fields inline
  const canShip = allowed.includes('shipped');
  const canCancel = allowed.includes('cancelled');

  let bodyHtml = `
    <div class="admin-form-group">
      <label>New Status</label>
      <select class="admin-select" id="modal-status">
        ${allowed.map(s => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>
  `;

  if (canShip) {
    bodyHtml += `
      <div id="tracking-fields" style="display:none">
        <div class="admin-form-group">
          <label>Carrier *</label>
          <select class="admin-select" id="modal-carrier">
            <option value="">Select carrier</option>
            <option value="NZ Post">NZ Post</option>
            <option value="CourierPost">CourierPost</option>
            <option value="Aramex">Aramex</option>
            <option value="DHL">DHL</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="admin-form-group">
          <label>Tracking Number *</label>
          <input class="admin-input" id="modal-tracking" placeholder="Required for shipped status">
        </div>
      </div>
    `;
  }

  if (canCancel && current === 'processing') {
    bodyHtml += `<div id="cancel-confirm" style="display:none"><div class="admin-form-help" style="color:var(--danger)">Cancelling a processing order requires confirmation. This may affect fulfillment.</div></div>`;
  }

  const modal = Modal.open({
    title: 'Update Status',
    body: bodyHtml,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Update</button>
    `,
  });
  if (!modal) return;

  // Show/hide tracking fields when shipped is selected
  const statusSelect = modal.body.querySelector('#modal-status');
  const trackingFields = modal.body.querySelector('#tracking-fields');
  const cancelConfirm = modal.body.querySelector('#cancel-confirm');

  statusSelect.addEventListener('change', () => {
    if (trackingFields) trackingFields.style.display = statusSelect.value === 'shipped' ? '' : 'none';
    if (cancelConfirm) cancelConfirm.style.display = statusSelect.value === 'cancelled' ? '' : 'none';
  });
  // Trigger initial state
  statusSelect.dispatchEvent(new Event('change'));

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newStatus = statusSelect.value;
    const body = { status: newStatus };

    // Shipped requires tracking
    if (newStatus === 'shipped') {
      const carrier = modal.body.querySelector('#modal-carrier')?.value;
      const tracking = modal.body.querySelector('#modal-tracking')?.value?.trim();
      if (!tracking) {
        Toast.warning('Tracking number is required for shipped status');
        return;
      }
      body.carrier = carrier || undefined;
      body.tracking_number = tracking;
    }

    // Processing → cancelled requires confirmation
    if (newStatus === 'cancelled' && current === 'processing') {
      body.confirm_processing_cancellation = true;
    }

    try {
      await AdminAPI.updateOrderStatus(order.id, newStatus, body);
      Toast.success(`Order updated to ${newStatus}`);
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
    title: 'Add Tracking',
    body: `
      <div class="admin-form-group">
        <label>Carrier</label>
        <select class="admin-select" id="modal-carrier">
          <option value="">Select carrier</option>
          <option value="NZ Post">NZ Post</option>
          <option value="CourierPost">CourierPost</option>
          <option value="Aramex">Aramex</option>
          <option value="DHL">DHL</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Tracking Number</label>
        <input class="admin-input" id="modal-tracking" placeholder="Enter tracking number">
      </div>
      <div class="admin-form-group">
        <label>Shipped At</label>
        <input class="admin-input" type="datetime-local" id="modal-shipped-at" value="${new Date().toISOString().slice(0, 16)}">
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Save Tracking</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const carrier = modal.body.querySelector('#modal-carrier').value;
    const tracking = modal.body.querySelector('#modal-tracking').value;
    const shippedAt = modal.body.querySelector('#modal-shipped-at').value;
    if (!carrier || !tracking) {
      Toast.warning('Please fill in carrier and tracking number');
      return;
    }
    try {
      await AdminAPI.updateTracking(order.id, carrier, tracking, shippedAt || null);
      Toast.success('Tracking info saved');
      Modal.close();
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function showNoteModal(order) {
  const modal = Modal.open({
    title: 'Add Note',
    body: `
      <div class="admin-form-group">
        <label>Internal Note</label>
        <textarea class="admin-textarea" id="modal-note" placeholder="Type a note\u2026" rows="4"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Add Note</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const note = modal.body.querySelector('#modal-note').value.trim();
    if (!note) { Toast.warning('Note cannot be empty'); return; }
    try {
      await AdminAPI.addOrderNote(order.id, note);
      Toast.success('Note added');
      Modal.close();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function showRefundModal(order) {
  const createdAt = new Date(order.created_at);
  const now = new Date();
  const minutesSinceCreation = (now - createdAt) / 60000;
  const canFullRefund = minutesSinceCreation <= 10;
  const total = order.total_amount ?? order.total ?? null;

  if (total == null || isNaN(total) || total <= 0) {
    Toast.error('Cannot create refund: order total is unavailable. Please reload the order.');
    return;
  }

  const modal = Modal.open({
    title: 'Create Refund',
    body: `
      <div class="admin-form-group">
        <label>Type</label>
        <select class="admin-select" id="refund-type">
          <option value="refund">Refund</option>
          <option value="chargeback">Chargeback</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Amount (NZD)</label>
        <input class="admin-input" type="number" step="0.01" min="0.01" id="refund-amount"
          max="${total}" value="${canFullRefund ? total : ''}"
          placeholder="${canFullRefund ? 'Full refund allowed' : 'Partial refund only'}">
        ${!canFullRefund ? '<div class="admin-form-help">Order is older than 10 minutes \u2014 partial refund only.</div>' : '<div class="admin-form-help">Full refund allowed (order within 10 min).</div>'}
      </div>
      <div class="admin-form-group">
        <label>Reason Code *</label>
        <select class="admin-select" id="refund-reason">
          <option value="">Select reason</option>
          <option value="damaged">Damaged in transit</option>
          <option value="wrong_item">Wrong item sent</option>
          <option value="not_received">Not received</option>
          <option value="defective">Defective product</option>
          <option value="customer_request">Customer request</option>
          <option value="duplicate">Duplicate order</option>
          <option value="fraud">Fraud / Unauthorized</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Notes (optional)</label>
        <textarea class="admin-textarea" id="refund-note" rows="2" placeholder="Additional details\u2026"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--danger" data-action="submit">Create Refund</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="submit"]').addEventListener('click', async () => {
    const type = modal.body.querySelector('#refund-type').value;
    const amount = parseFloat(modal.body.querySelector('#refund-amount').value);
    const reasonCode = modal.body.querySelector('#refund-reason').value;
    const reasonNote = modal.body.querySelector('#refund-note').value.trim();

    // Validation
    if (!amount || amount <= 0) { Toast.warning('Enter a valid amount'); return; }
    if (amount > total) { Toast.warning('Amount cannot exceed order total.'); return; }
    if (!canFullRefund && amount >= total) {
      Toast.warning('Full refund not allowed after 10 minutes. Use partial refund.');
      return;
    }
    if (!reasonCode) { Toast.warning('Reason code is required'); return; }

    const btn = modal.footer.querySelector('[data-action="submit"]');
    btn.disabled = true;
    btn.textContent = 'Processing\u2026';
    try {
      await AdminAPI.createRefund(order.id, { type, amount, reasonCode, reasonNote });
      Toast.success(`${type === 'chargeback' ? 'Chargeback' : 'Refund'} created for ${formatPrice(amount)}`);
      Modal.close();
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create Refund';
    }
  });
}

async function handleExport() {
  try {
    Toast.info('Preparing export\u2026');
    await AdminAPI.exportCSV('orders', FilterState.getParams());
    Toast.success('Orders exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

export default {
  title: 'Orders',

  async init(container) {
    _container = container;
    _page = 1;

    // Header
    const header = document.createElement('div');
    header.className = 'admin-page-header';
    header.innerHTML = `
      <h1>Orders</h1>
      <div class="admin-page-header__actions">
        <div style="position:relative">
          <input class="admin-input" type="search" placeholder="Search orders\u2026" id="order-search" style="width:220px;padding-left:32px">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)">${icon('search', 14, 14)}</span>
        </div>
        <button class="admin-btn admin-btn--ghost" id="export-orders-btn">
          ${icon('download', 14, 14)} Export CSV
        </button>
      </div>
    `;
    container.appendChild(header);

    // Table container
    const tableContainer = document.createElement('div');
    container.appendChild(tableContainer);

    _table = new DataTable(tableContainer, {
      columns: COLUMNS,
      rowKey: 'id',
      onRowClick: (row) => openOrderDrawer(row),
      onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadOrders(); },
      onPageChange: (page) => { _page = page; loadOrders(); },
      emptyMessage: 'No orders found',
      emptyIcon: icon('orders', 40, 40),
    });

    // Search
    const searchInput = header.querySelector('#order-search');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _search = searchInput.value.trim();
        _page = 1;
        loadOrders();
      }, 300);
    });

    // Export
    header.querySelector('#export-orders-btn').addEventListener('click', handleExport);

    await loadOrders();
  },

  destroy() {
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _search = '';
    _page = 1;
  },

  async onFilterChange() {
    _page = 1;
    if (_table) await loadOrders();
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    const input = document.getElementById('order-search');
    if (input && input.value !== query) input.value = query;
    if (_table) loadOrders();
  },
};
