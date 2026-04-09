/**
 * Orders Page — Full-page modal detail + bulk selection/delete
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
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
let _activeModal = null;
let _bulkBar = null;
let _activeTab = 'orders'; // orders | refunds | compliance
let _subTabModule = null;

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
  {
    key: '_actions', label: '',
    render: (r) => {
      const st = (r.status || '').toLowerCase();
      if (st === 'completed') return '';
      return `<button class="admin-btn admin-btn--ghost admin-btn--xs order-track-btn"
        data-order-id="${esc(r.id)}" data-action="quick-status"
        title="Update status">${icon('orders', 12, 12)} Status</button>`;
    },
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
  if (!_table) return;
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

// ---- Bulk bar ----

function updateBulkBar(selected) {
  const count = selected.size;
  if (count === 0) {
    if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
    return;
  }
  if (!_bulkBar) {
    _bulkBar = document.createElement('div');
    _bulkBar.className = 'admin-bulk-bar';
    document.body.appendChild(_bulkBar);
  }
  _bulkBar.innerHTML = `
    <span class="admin-bulk-bar__count">${count} selected</span>
    <div class="admin-bulk-bar__actions">
      <button class="admin-btn admin-btn--sm admin-btn--danger" data-bulk="delete">Delete</button>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-bulk="clear">Clear</button>
    </div>
  `;
  _bulkBar.querySelector('[data-bulk="delete"]').addEventListener('click', bulkDelete);
  _bulkBar.querySelector('[data-bulk="clear"]').addEventListener('click', () => {
    if (_table) _table.clearSelection();
    updateBulkBar(new Set());
  });
}

async function bulkDelete() {
  if (!_table) return;
  const selected = _table.getSelected();
  const count = selected.size;
  if (count === 0) return;

  Modal.confirm({
    title: 'Delete Orders',
    message: `Permanently delete ${count} order${count > 1 ? 's' : ''}? This cannot be undone.`,
    confirmLabel: `Delete ${count}`,
    confirmClass: 'admin-btn--danger',
    onConfirm: async () => {
      const ids = [...selected];
      let done = 0;
      let failed = 0;
      let firstError = null;
      Toast.info(`Deleting ${count} order${count > 1 ? 's' : ''}\u2026`);
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map(id => AdminAPI.deleteOrder(id)));
        for (const r of results) {
          if (r.status === 'fulfilled') done++;
          else { failed++; firstError = firstError || r.reason?.message; }
        }
      }
      if (_table) _table.clearSelection();
      updateBulkBar(new Set());
      if (failed > 0) {
        Toast.error(`${done} deleted, ${failed} failed${firstError ? `: ${firstError}` : ''}`);
      } else {
        Toast.success(`${done} order${done > 1 ? 's' : ''} deleted`);
      }
      loadOrders();
    },
  });
}

// ---- Full-page order modal ----

function closeOrderModal() {
  if (!_activeModal) return;
  const modal = _activeModal;
  _activeModal = null;
  if (modal._removeKeyHandler) modal._removeKeyHandler();
  modal.classList.remove('open');
  setTimeout(() => modal.remove(), 220);
}

async function openOrderModal(order) {
  if (_activeModal) closeOrderModal();

  const modal = document.createElement('div');
  modal.className = 'admin-product-modal';
  modal.innerHTML = `
    <div class="admin-product-modal__inner">
      <div class="admin-product-modal__header">
        <button class="admin-product-modal__close" data-action="close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="admin-product-modal__title">${esc(order.order_number || order.id?.slice(0, 8) || 'Order')}</div>
        <div class="admin-product-modal__actions" id="om-header-actions">
          ${statusBadge(order.status)}
        </div>
      </div>
      <div class="admin-product-modal__scroll" id="om-content">
        <div style="padding:40px;text-align:center;color:var(--text-muted)">Loading order&hellip;</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  _activeModal = modal;

  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));

  modal.querySelector('[data-action="close"]').addEventListener('click', closeOrderModal);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && _activeModal === modal) {
      closeOrderModal();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  document.addEventListener('keydown', onKeyDown);
  modal._removeKeyHandler = () => document.removeEventListener('keydown', onKeyDown);

  // Fetch full data
  const [fullOrder, events, breakdown] = await Promise.all([
    AdminAPI.getOrder(order.id),
    AdminAPI.getOrderEvents(order.id),
    AdminAPI.getOrderBreakdown(order.id),
  ]);
  if (_activeModal !== modal) return; // closed during fetch

  const o = fullOrder || order;

  // Update header title (actions + badge will be set by buildOrderModalContent)
  modal.querySelector('.admin-product-modal__title').textContent = o.order_number || o.id?.slice(0, 8) || 'Order';

  // Build single-page content
  buildOrderModalContent(modal, o, events || [], breakdown);
}

function buildOrderModalContent(modal, o, events, breakdown) {
  const showCost = AdminAuth.isOwner();
  const omRow = (label, value) =>
    `<div class="om-meta-row"><span>${label}</span><span>${value}</span></div>`;

  const profile = o.user_profile || o.user_profiles || o.customer || {};
  const custName = o.customer_name || profile.full_name
    || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || MISSING;
  const custEmail = o.customer_email || profile.email || o.guest_email || MISSING;
  const orderTotal = o.total_amount ?? o.total;

  // Meta grid
  let metaLeft = omRow('Customer', esc(custName));
  metaLeft += omRow('Email', esc(custEmail));
  if (orderTotal != null) metaLeft += omRow('Total', `<strong>${formatPrice(orderTotal)}</strong>`);
  if (o.shipping_fee != null) metaLeft += omRow('Shipping', formatPrice(o.shipping_fee));
  if (o.shipping_tier) metaLeft += omRow('Tier', esc(o.shipping_tier));
  if (o.delivery_zone) metaLeft += omRow('Zone', esc(o.delivery_zone));
  if (o.source) metaLeft += omRow('Source', esc(o.source));

  let metaRight = omRow('Created', formatDate(o.created_at));
  if (o.paid_at) metaRight += omRow('Paid', formatDate(o.paid_at));
  if (o.shipped_at) metaRight += omRow('Shipped', formatDate(o.shipped_at));
  if (o.delivered_at) metaRight += omRow('Delivered', formatDate(o.delivered_at));
  if (o.completed_at) metaRight += omRow('Completed', formatDate(o.completed_at));
  if (o.cancelled_at) metaRight += omRow('Cancelled', formatDate(o.cancelled_at));

  // Shipping address — shown inline as middle meta column
  const addr = o.shipping_address || {};
  const hasAddr = addr.address_line1 || o.shipping_address_line1;
  let metaMiddle = '';
  if (hasAddr) {
    const name = addr.recipient_name || o.shipping_recipient_name || '';
    const phone = addr.phone || o.shipping_phone || '';
    const line1 = addr.address_line1 || o.shipping_address_line1 || '';
    const line2 = addr.address_line2 || o.shipping_address_line2 || '';
    const city = addr.city || o.shipping_city || '';
    const region = addr.region || o.shipping_region || '';
    const postal = addr.postal_code || o.shipping_postal_code || '';
    const country = addr.country || o.shipping_country || 'New Zealand';
    const parts = [name, phone, line1, line2,
      city && region ? `${city}, ${region} ${postal}`.trim() : (city || region),
      country,
    ].filter(Boolean).map(p => esc(p)).join('<br>');
    metaMiddle = `<div class="om-meta-addr-label">Ship to</div><address style="font-style:normal;line-height:1.7;font-size:0.9rem">${parts}</address>`;
  }

  const metaSection = `<div class="om-meta-grid${metaMiddle ? ' om-meta-grid--3col' : ''}"><div>${metaLeft}</div>${metaMiddle ? `<div>${metaMiddle}</div>` : ''}<div>${metaRight}</div></div>`;

  // Items section
  let itemsHtml = '';
  if (o.items?.length) {
    itemsHtml += `<table class="admin-order-items"><thead><tr>`;
    itemsHtml += `<th>Product</th><th>SKU</th><th>Qty</th><th>Price</th>`;
    if (showCost) itemsHtml += `<th>Cost</th><th>Profit</th>`;
    itemsHtml += `</tr></thead><tbody>`;
    let totalPrice = 0, totalCost = 0;
    for (const item of o.items) {
      const itemPrice = item.sell_price ?? item.unit_price ?? item.price;
      const qty = item.qty ?? item.quantity ?? 0;
      totalPrice += (itemPrice ?? 0) * qty;
      if (showCost) totalCost += (item.supplier_cost_snapshot ?? 0) * qty;
      itemsHtml += `<tr>
        <td class="cell-truncate">${item.sku ? `<a href="${item.slug ? `/products/${esc(item.slug)}/${esc(item.sku)}` : `/html/product/?sku=${encodeURIComponent(item.sku)}`}" target="_blank" style="color:var(--text);text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px">${esc(item.product_name || item.name || item.description || MISSING)}</a>` : esc(item.product_name || item.name || item.description || MISSING)}</td>
        <td class="mono">${esc(item.sku || MISSING)}</td>
        <td>${item.qty ?? item.quantity ?? MISSING}</td>
        <td class="mono">${itemPrice != null ? formatPrice(itemPrice) : MISSING}</td>
        ${showCost ? `<td class="mono">${item.supplier_cost_snapshot != null ? formatPrice(item.supplier_cost_snapshot) : MISSING}</td><td></td>` : ''}
      </tr>`;
    }
    const profit = totalPrice - totalCost;
    itemsHtml += `</tbody><tfoot><tr class="admin-order-items__total">
      <td colspan="3"></td>
      <td class="mono"><strong>${formatPrice(totalPrice)}</strong></td>
      ${showCost ? `<td class="mono"><strong>${formatPrice(totalCost)}</strong></td><td class="mono" style="color:var(--success-text,#15803d)"><strong>${formatPrice(profit)}</strong></td>` : ''}
    </tr></tfoot></table>`;
  } else {
    itemsHtml += `<p class="admin-text-muted">${MISSING} No items</p>`;
  }

  // Financial breakdown section (from order-breakdown endpoint)
  let breakdownHtml = '';
  if (breakdown) {
    breakdownHtml += `<div class="om-section-title">Financial Breakdown</div>`;
    breakdownHtml += `<div class="om-meta-grid">`;
    let bLeft = '';
    if (breakdown.subtotal_excl_gst != null) bLeft += omRow('Subtotal (excl. GST)', formatPrice(breakdown.subtotal_excl_gst));
    if (breakdown.gst_amount != null) bLeft += omRow('GST (15%)', formatPrice(breakdown.gst_amount));
    if (breakdown.total_incl_gst != null) bLeft += omRow('Total (incl. GST)', `<strong>${formatPrice(breakdown.total_incl_gst)}</strong>`);
    if (breakdown.shipping_fee != null) bLeft += omRow('Shipping', formatPrice(breakdown.shipping_fee));
    let bRight = '';
    if (breakdown.payment_method) {
      const pm = breakdown.payment_method;
      if (pm.type === 'card' || pm.card_brand) {
        bRight += omRow('Payment', `${esc(pm.card_brand || 'Card')} ****${esc(pm.last4 || '????')}`);
      } else if (pm.type === 'paypal' || pm.paypal_email) {
        bRight += omRow('Payment', `PayPal${pm.paypal_email ? ' — ' + esc(pm.paypal_email) : ''}`);
      } else {
        bRight += omRow('Payment', esc(pm.type || pm.method || 'Unknown'));
      }
    }
    if (breakdown.invoice_number) bRight += omRow('Invoice #', esc(breakdown.invoice_number));
    if (breakdown.receipt_url) bRight += omRow('Receipt', `<a href="${Security.escapeAttr(breakdown.receipt_url)}" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:underline">View Receipt</a>`);
    breakdownHtml += `<div>${bLeft}</div><div>${bRight}</div></div>`;
  }

  // Tracking section (conditional — address is now in the meta grid)
  let shippingHtml = '';
  if (o.carrier || o.tracking_number) {
    shippingHtml += `<div class="om-section-title">Tracking</div>`;
    shippingHtml += `<div class="admin-detail-block"><div class="admin-detail-row"><span class="admin-detail-row__label">Carrier</span><span class="admin-detail-row__value">${esc(o.carrier || MISSING)}</span></div>`;
    shippingHtml += `<div class="admin-detail-row"><span class="admin-detail-row__label">Tracking #</span><span class="admin-detail-row__value">${esc(o.tracking_number || MISSING)}</span></div></div>`;
  }

  // Timeline section (conditional)
  let timelineHtml = '';
  if (events.length) {
    timelineHtml += `<div class="om-section-title">Timeline</div>`;
    timelineHtml += `<div class="admin-timeline">`;
    for (const ev of events) {
      const dotClass = ev.type === 'status_change' ? 'cyan'
        : (ev.type === 'refund_created' || ev.type === 'refund') ? 'magenta' : 'yellow';
      timelineHtml += `<div class="admin-timeline__item">
        <div class="admin-timeline__dot admin-timeline__dot--${dotClass}"></div>
        <div class="admin-timeline__time">${formatDateTime(ev.created_at)}</div>
        <div class="admin-timeline__text"><strong>${esc(ev.type || 'Event')}</strong>`;
      if (ev.payload?.note) timelineHtml += ` \u2014 ${esc(ev.payload.note)}`;
      if (ev.payload?.status) timelineHtml += ` \u2192 ${statusBadge(ev.payload.status)}`;
      timelineHtml += `</div></div>`;
    }
    timelineHtml += `</div>`;
  }

  // Actions — moved into header
  const btns = [
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="update-status">${icon('orders', 13, 13)} Update Status</button>`,
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="add-note">${icon('dashboard', 13, 13)} Add Note</button>`,
    `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="create-refund">${icon('refunds', 13, 13)} Refund</button>`,
  ];
  if (o.status === 'cancelled') {
    btns.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" style="color:var(--danger);border-color:var(--danger)" data-action="delete">${icon('trash', 13, 13)} Delete</button>`);
  }
  modal.querySelector('#om-header-actions').innerHTML =
    `<div class="om-header-btns">${btns.join('')}</div>${statusBadge(o.status)}`;

  modal.querySelector('#om-content').innerHTML = [metaSection, itemsHtml, breakdownHtml, shippingHtml, timelineHtml]
    .filter(Boolean).join('');

  bindModalActions(modal, o);
}

function bindModalActions(modal, order) {
  modal.querySelector('[data-action="update-status"]')?.addEventListener('click', () => showStatusModal(order));
  modal.querySelector('[data-action="add-note"]')?.addEventListener('click', () => showNoteModal(order));
  modal.querySelector('[data-action="create-refund"]')?.addEventListener('click', () => showRefundModal(order));

  if (order.status === 'cancelled') {
    modal.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      Modal.confirm({
        title: 'Delete Order',
        message: `Permanently delete ${esc(order.order_number || order.id?.slice(0, 8) || 'this order')}? This cannot be undone.`,
        confirmLabel: 'Delete',
        confirmClass: 'admin-btn--danger',
        onConfirm: async () => {
          try {
            await AdminAPI.deleteOrder(order.id);
            Toast.success('Order deleted');
            closeOrderModal();
            loadOrders();
          } catch (e) {
            Toast.error(`Delete failed: ${e.message}`);
          }
        },
      });
    });
  }
}

const ALL_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled'];

function showStatusModal(order) {
  const current = (order.status || '').toLowerCase();
  const allowed = ALL_STATUSES.filter(s => s !== current);

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

  const modal = Modal.open({
    title: 'Update Status',
    body: bodyHtml,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Update</button>
    `,
  });
  if (!modal) return;

  const statusSelect = modal.body.querySelector('#modal-status');
  const trackingFields = modal.body.querySelector('#tracking-fields');

  statusSelect.addEventListener('change', () => {
    if (trackingFields) trackingFields.style.display = statusSelect.value === 'shipped' ? '' : 'none';
  });
  statusSelect.dispatchEvent(new Event('change'));

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newStatus = statusSelect.value;
    const body = { status: newStatus };

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

    try {
      // Backend requires paid → processing → shipped; bridge automatically when needed
      if (newStatus === 'shipped' && current === 'paid') {
        await AdminAPI.updateOrderStatus(order.id, 'processing', { status: 'processing' });
      }
      await AdminAPI.updateOrderStatus(order.id, newStatus, body);
      Toast.success(`Order updated to ${newStatus}`);
      Modal.close();
      closeOrderModal();
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
      closeOrderModal();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create Refund';
    }
  });
}

// ---- Create Order Drawer ----

function openCreateOrderDrawer() {
  const drawer = Drawer.open({ title: 'New Order', width: '600px' });
  if (!drawer) return;

  const formHtml = `
    <form id="create-order-form" novalidate>
      <div class="admin-form-group">
        <label>Customer Name *</label>
        <input class="admin-input" type="text" name="customer_name" placeholder="Full name" required>
      </div>
      <div class="admin-form-group">
        <label>Customer Email *</label>
        <input class="admin-input" type="email" name="customer_email" placeholder="email@example.com" required>
      </div>
      <div class="admin-form-group">
        <label>Status</label>
        <select class="admin-select" name="status">
          <option value="pending">Pending (Invoice sent)</option>
          <option value="paid">Paid (Already paid)</option>
        </select>
      </div>

      <div class="admin-detail-block__title" style="margin:16px 0 8px">Line Items</div>
      <div id="line-items">
        <div class="create-order-item" style="display:grid;grid-template-columns:1fr 64px 96px 32px;gap:8px;align-items:start;margin-bottom:8px">
          <input class="admin-input" type="text" name="description" placeholder="Description *" required>
          <input class="admin-input" type="number" name="qty" placeholder="Qty" min="1" value="1" style="text-align:center">
          <input class="admin-input" type="number" name="unit_price" placeholder="Price" min="0" step="0.01">
          <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm remove-item-btn" style="display:none;padding:6px" title="Remove">${icon('close', 12, 12)}</button>
        </div>
      </div>
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="add-item-btn" style="margin-bottom:16px">+ Add Item</button>

      <div class="admin-form-group">
        <label>Notes <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
        <textarea class="admin-textarea" name="notes" rows="3" placeholder="Internal notes\u2026"></textarea>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px">
        <button type="button" class="admin-btn admin-btn--ghost" id="cancel-order-btn">Cancel</button>
        <button type="submit" class="admin-btn admin-btn--primary" id="submit-order-btn">Create Order</button>
      </div>
    </form>
  `;
  drawer.setBody(formHtml);

  const body = drawer.body;

  function updateRemoveButtons() {
    const rows = body.querySelectorAll('.create-order-item');
    rows.forEach(row => {
      const btn = row.querySelector('.remove-item-btn');
      if (btn) btn.style.display = rows.length > 1 ? '' : 'none';
    });
  }

  function addItemRow() {
    const row = document.createElement('div');
    row.className = 'create-order-item';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 64px 96px 32px;gap:8px;align-items:start;margin-bottom:8px';
    row.innerHTML = `
      <input class="admin-input" type="text" name="description" placeholder="Description *" required>
      <input class="admin-input" type="number" name="qty" placeholder="Qty" min="1" value="1" style="text-align:center">
      <input class="admin-input" type="number" name="unit_price" placeholder="Price" min="0" step="0.01">
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm remove-item-btn" style="padding:6px" title="Remove">${icon('close', 12, 12)}</button>
    `;
    row.querySelector('.remove-item-btn').addEventListener('click', () => {
      row.remove();
      updateRemoveButtons();
    });
    body.querySelector('#line-items').appendChild(row);
    updateRemoveButtons();
  }

  body.querySelector('.remove-item-btn').addEventListener('click', function () {
    this.closest('.create-order-item').remove();
    updateRemoveButtons();
  });

  body.querySelector('#add-item-btn').addEventListener('click', addItemRow);
  body.querySelector('#cancel-order-btn').addEventListener('click', () => Drawer.close());

  body.querySelector('#create-order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const customerName = form.querySelector('[name="customer_name"]').value.trim();
    const customerEmail = form.querySelector('[name="customer_email"]').value.trim();
    const status = form.querySelector('[name="status"]').value;
    const notes = form.querySelector('[name="notes"]').value.trim();

    const itemRows = body.querySelectorAll('.create-order-item');
    const items = [];
    for (const row of itemRows) {
      const description = row.querySelector('[name="description"]').value.trim();
      const qty = parseInt(row.querySelector('[name="qty"]').value, 10) || 1;
      const unit_price = parseFloat(row.querySelector('[name="unit_price"]').value);
      if (!description || isNaN(unit_price) || unit_price <= 0) continue;
      items.push({ description, qty, unit_price });
    }

    if (!customerName) { Toast.warning('Customer name is required'); return; }
    if (!customerEmail) { Toast.warning('Customer email is required'); return; }
    if (!items.length) { Toast.warning('Add at least one item with a description and price'); return; }

    const submitBtn = body.querySelector('#submit-order-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating\u2026';

    try {
      await AdminAPI.createOrder({
        customer_name: customerName,
        customer_email: customerEmail,
        status,
        source: 'manual',
        items,
        notes: notes || undefined,
      });
      Toast.success('Order created');
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(e.message || 'Failed to create order');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Order';
    }
  });
}

async function handleExport(format = 'csv') {
  try {
    Toast.info(`Preparing ${format.toUpperCase()} export\u2026`);
    await AdminAPI.exportData('orders', format, FilterState.getParams());
    Toast.success('Orders exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

// ---- Tab: Orders (renders the orders table) ----
async function renderOrdersTab(container) {
  // Header
  const header = document.createElement('div');
  header.className = 'admin-page-header';
  header.innerHTML = `
    <h1>Orders</h1>
    <div class="admin-page-header__actions">
      <button class="admin-btn admin-btn--primary" id="create-order-btn">${icon('plus', 14, 14)} New Order</button>
      ${exportDropdown('export-orders')}
    </div>
  `;
  container.appendChild(header);

  const tableContainer = document.createElement('div');
  container.appendChild(tableContainer);

  _table = new DataTable(tableContainer, {
    columns: COLUMNS,
    rowKey: 'id',
    selectable: true,
    onSelectionChange: (sel) => updateBulkBar(sel),
    onRowClick: (row) => openOrderModal(row),
    onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadOrders(); },
    onPageChange: (page) => { _page = page; loadOrders(); },
    emptyMessage: 'No orders found',
    emptyIcon: icon('orders', 40, 40),
  });

  tableContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="quick-status"]');
    if (!btn) return;
    e.stopPropagation();
    const orderId = btn.dataset.orderId;
    const order = (_table.data || []).find(r => r.id === orderId);
    if (order) showStatusModal(order);
  });

  header.querySelector('#create-order-btn').addEventListener('click', openCreateOrderDrawer);
  bindExportDropdown(header, 'export-orders', handleExport);

  await loadOrders();
}

function destroyOrdersTab() {
  if (_table) _table.destroy();
  _table = null;
  if (_activeModal) closeOrderModal();
  if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
}

// ---- Tab switching ----
async function switchTab(tab) {
  if (tab === _activeTab) return;

  // Destroy current sub-tab
  if (_activeTab === 'orders') destroyOrdersTab();
  if (_subTabModule?.destroy) _subTabModule.destroy();
  _subTabModule = null;

  _activeTab = tab;

  // Update tab bar UI
  _container.querySelectorAll('.admin-tab[data-order-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.orderTab === tab);
  });

  const content = _container.querySelector('#orders-tab-content');
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (tab === 'orders') {
    content.innerHTML = '';
    await renderOrdersTab(content);
  } else if (tab === 'refunds') {
    try {
      const mod = await import('./refunds.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Refunds</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  } else if (tab === 'compliance') {
    try {
      const mod = await import('./cc-compliance.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Compliance</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  }
}

export default {
  title: 'Orders',

  async init(container) {
    _container = container;
    _page = 1;
    _activeTab = 'orders';
    _subTabModule = null;
    FilterState.setVisibleFilters(['statuses']);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-tabs';
    tabBar.innerHTML = `
      <button class="admin-tab active" data-order-tab="orders">Orders</button>
      <button class="admin-tab" data-order-tab="refunds">Refunds</button>
      ${AdminAuth.isOwner() ? '<button class="admin-tab" data-order-tab="compliance">Compliance</button>' : ''}
    `;
    container.appendChild(tabBar);

    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-order-tab]');
      if (btn) switchTab(btn.dataset.orderTab);
    });

    // Tab content area
    const content = document.createElement('div');
    content.id = 'orders-tab-content';
    container.appendChild(content);

    await renderOrdersTab(content);
  },

  destroy() {
    FilterState.setVisibleFilters(null);
    if (_activeTab === 'orders') destroyOrdersTab();
    if (_subTabModule?.destroy) _subTabModule.destroy();
    _subTabModule = null;
    _container = null;
    _search = '';
    _page = 1;
    _activeTab = 'orders';
  },

  async onFilterChange() {
    _page = 1;
    if (_activeTab === 'orders' && _table) {
      await loadOrders();
    } else if (_subTabModule?.onFilterChange) {
      _subTabModule.onFilterChange();
    }
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    if (_activeTab === 'orders') {
      const input = document.getElementById('order-search');
      if (input && input.value !== query) input.value = query;
      if (_table) loadOrders();
    } else if (_subTabModule?.onSearch) {
      _subTabModule.onSearch(query);
    }
  },
};
