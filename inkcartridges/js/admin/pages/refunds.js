/**
 * Refunds & Chargebacks Page
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { Charts } from '../components/charts.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

let _container = null;
let _table = null;
let _page = 1;
let _tab = 'queue'; // queue | all | analytics
let _search = '';

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(status || 'Unknown')}</span>`;
}

function typeBadge(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'chargeback') return `<span class="admin-refund-type admin-refund-type--chargeback">${icon('refunds', 12, 12)} Chargeback</span>`;
  return `<span class="admin-refund-type admin-refund-type--partial">${icon('refunds', 12, 12)} Refund</span>`;
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
    return new Date(d).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return MISSING; }
}

const COLUMNS = [
  {
    key: 'created_at', label: 'Created', sortable: false,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.created_at)}</span>`,
  },
  {
    key: 'order_number', label: 'Order',
    render: (r) => `<span class="cell-mono">${esc(r.order_number || r.order_id?.slice(0, 8) || MISSING)}</span>`,
  },
  {
    key: 'type', label: 'Type',
    render: (r) => typeBadge(r.type),
  },
  {
    key: 'amount', label: 'Amount',
    render: (r) => `<span class="cell-mono">${r.amount != null ? formatPrice(r.amount) : MISSING}</span>`,
    align: 'right',
  },
  {
    key: 'status', label: 'Status',
    render: (r) => statusBadge(r.status),
  },
  {
    key: 'reason_code', label: 'Reason',
    render: (r) => esc(r.reason_code || MISSING),
  },
  {
    key: 'refunded_at', label: 'Processed',
    render: (r) => `<span class="cell-nowrap">${formatDateTime(r.refunded_at)}</span>`,
  },
];

async function loadRefunds() {
  _table.setLoading(true);
  const { from, to } = FilterState.getDateRange();
  const filters = {
    from, to,
    status: _tab === 'queue' ? 'pending' : undefined,
    search: _search,
  };
  const data = await AdminAPI.getRefunds(filters, _page, 20);
  if (!_table) return; // destroyed during await
  if (!data) {
    _table.setData([], null);
    return;
  }
  const rows = Array.isArray(data) ? data : (data.refunds || data.data || []);
  const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: 20 };
  _table.setData(rows, pagination);
}

function renderContent() {
  if (!_container) return;
  Charts.destroyAll();

  let html = '';

  // Header
  html += `<div class="admin-page-header">
    <h1>Refunds & Chargebacks</h1>
    <div class="admin-page-header__actions">
      <button class="admin-btn admin-btn--primary" id="create-refund-btn">
        ${icon('refunds', 14, 14)} Create Refund
      </button>
    </div>
  </div>`;

  // Tabs
  html += `<div class="admin-tabs">
    <button class="admin-tab${_tab === 'queue' ? ' active' : ''}" data-tab="queue">Queue (Pending/Failed)</button>
    <button class="admin-tab${_tab === 'all' ? ' active' : ''}" data-tab="all">All Refunds</button>
    ${AdminAuth.isOwner() ? `<button class="admin-tab${_tab === 'analytics' ? ' active' : ''}" data-tab="analytics">Analytics</button>` : ''}
  </div>`;

  // Table container
  html += `<div id="refunds-table-container"></div>`;

  // Analytics (owner only)
  if (_tab === 'analytics' && AdminAuth.isOwner()) {
    html += `
      <div class="admin-grid-2 admin-mt-lg">
        <div class="admin-card admin-card--magenta">
          <div class="admin-card__title">Refund Rate Over Time</div>
          <div class="admin-chart-box"><canvas id="chart-refund-rate"></canvas></div>
        </div>
        <div class="admin-card admin-card--yellow">
          <div class="admin-card__title">Reasons Breakdown</div>
          <div class="admin-chart-box"><canvas id="chart-refund-reasons"></canvas></div>
        </div>
      </div>
    `;
  }

  _container.innerHTML = html;

  // Bind tabs
  _container.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _tab = btn.dataset.tab;
      _page = 1;
      renderContent();
      if (_tab !== 'analytics') loadRefunds();
    });
  });

  // Create refund
  _container.querySelector('#create-refund-btn')?.addEventListener('click', () => showCreateRefundFlow());

  // Init table (skip for analytics tab)
  if (_tab !== 'analytics') {
    const tableContainer = _container.querySelector('#refunds-table-container');
    _table = new DataTable(tableContainer, {
      columns: COLUMNS,
      rowKey: 'id',
      onRowClick: (row) => openRefundDrawer(row),
      onPageChange: (page) => { _page = page; loadRefunds(); },
      emptyMessage: _tab === 'queue' ? 'No pending refunds' : 'No refunds found',
      emptyIcon: icon('refunds', 40, 40),
    });
    loadRefunds();
  } else if (AdminAuth.isOwner()) {
    loadRefundAnalytics();
  }
}

function openRefundDrawer(refund) {
  const drawer = Drawer.open({
    title: `${refund.type === 'chargeback' ? 'Chargeback' : 'Refund'} Details`,
  });
  if (!drawer) return;

  let html = '';
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Refund Information</div>`;
  html += detailRow('Type', typeBadge(refund.type));
  html += detailRow('Status', statusBadge(refund.status));
  html += detailRow('Amount', refund.amount != null ? `<span class="mono">${formatPrice(refund.amount)}</span>` : MISSING);
  html += detailRow('Order', `<span class="mono">${esc(refund.order_number || refund.order_id?.slice(0, 8) || MISSING)}</span>`);
  html += detailRow('Reason', esc(refund.reason_code || MISSING));
  if (refund.reason_note) html += detailRow('Notes', esc(refund.reason_note));
  html += detailRow('Created', formatDateTime(refund.created_at));
  html += detailRow('Processed', formatDateTime(refund.refunded_at));
  if (refund.processed_by) html += detailRow('Processed By', esc(refund.processed_by));
  html += `</div>`;

  // Actions for pending refunds
  if (refund.status === 'pending') {
    html += `<div class="admin-detail-block">`;
    html += `<div class="admin-detail-block__title">Actions</div>`;
    html += `<div style="display:flex;gap:8px">`;
    html += `<button class="admin-btn admin-btn--primary admin-btn--sm" data-action="process">Mark Processed</button>`;
    html += `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="fail">Mark Failed</button>`;
    html += `</div></div>`;
  }

  drawer.setBody(html);

  // Bind actions
  drawer.body.querySelector('[data-action="process"]')?.addEventListener('click', async () => {
    try {
      await AdminAPI.updateRefundStatus(refund.id, 'processed');
      Toast.success('Refund marked as processed');
      Drawer.close();
      loadRefunds();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });

  drawer.body.querySelector('[data-action="fail"]')?.addEventListener('click', async () => {
    try {
      await AdminAPI.updateRefundStatus(refund.id, 'failed');
      Toast.warning('Refund marked as failed');
      Drawer.close();
      loadRefunds();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function detailRow(label, value) {
  return `<div class="admin-detail-row"><span class="admin-detail-row__label">${label}</span><span class="admin-detail-row__value">${value}</span></div>`;
}

function showCreateRefundFlow() {
  const modal = Modal.open({
    title: 'Create Refund',
    body: `
      <div class="admin-form-group">
        <label>Order Number *</label>
        <input class="admin-input" id="cr-order" placeholder="Enter order number to search">
        <div class="admin-form-help" id="cr-order-info"></div>
      </div>
      <div class="admin-form-group">
        <label>Type</label>
        <select class="admin-select" id="cr-type">
          <option value="refund">Refund</option>
          <option value="chargeback">Chargeback</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Amount (NZD) *</label>
        <input class="admin-input" type="number" step="0.01" min="0.01" id="cr-amount" placeholder="Enter amount">
        <div class="admin-form-help" id="cr-amount-help"></div>
      </div>
      <div class="admin-form-group">
        <label>Reason Code *</label>
        <select class="admin-select" id="cr-reason">
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
        <textarea class="admin-textarea" id="cr-note" rows="2"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--danger" data-action="submit">Create Refund</button>
    `,
  });
  if (!modal) return;

  // Order lookup with debounce
  let lookupTimer;
  let foundOrder = null;
  const orderInput = modal.body.querySelector('#cr-order');
  const orderInfo = modal.body.querySelector('#cr-order-info');
  const amountHelp = modal.body.querySelector('#cr-amount-help');

  orderInput.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(async () => {
      const val = orderInput.value.trim();
      if (!val) { orderInfo.textContent = ''; foundOrder = null; return; }
      orderInfo.textContent = 'Searching\u2026';
      const result = await AdminAPI.getOrders({ search: val }, 1, 1);
      const orders = Array.isArray(result) ? result : (result?.orders || result?.data || []);
      if (orders.length) {
        foundOrder = orders[0];
        const created = new Date(foundOrder.created_at);
        const minAgo = ((Date.now() - created) / 60000).toFixed(0);
        const canFull = minAgo <= 10;
        const orderTotal = foundOrder.total_amount ?? foundOrder.total ?? 0;
        orderInfo.innerHTML = `Found: ${esc(foundOrder.order_number || foundOrder.id?.slice(0, 8))} \u2014 ${formatPrice(orderTotal)} \u2014 ${esc(foundOrder.status || '')}`;
        amountHelp.textContent = canFull
          ? `Full refund allowed (order is ${minAgo}min old, within 10min window)`
          : `Partial refund only (order is ${minAgo}min old, past 10min window)`;
      } else {
        foundOrder = null;
        orderInfo.textContent = 'No order found';
        amountHelp.textContent = '';
      }
    }, 400);
  });

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="submit"]').addEventListener('click', async () => {
    if (!foundOrder) { Toast.warning('Please find an order first'); return; }
    const type = modal.body.querySelector('#cr-type').value;
    const amount = parseFloat(modal.body.querySelector('#cr-amount').value);
    const reasonCode = modal.body.querySelector('#cr-reason').value;
    const reasonNote = modal.body.querySelector('#cr-note').value.trim();

    if (!amount || amount <= 0) { Toast.warning('Enter a valid amount'); return; }
    if (!reasonCode) { Toast.warning('Reason code is required'); return; }

    // Full refund rule enforcement
    const created = new Date(foundOrder.created_at);
    const minAgo = (Date.now() - created) / 60000;
    const refundTotal = foundOrder.total_amount ?? foundOrder.total;
    if (minAgo > 10 && refundTotal && amount >= refundTotal) {
      Toast.warning('Full refund not allowed after 10 minutes. Use partial refund.');
      return;
    }

    const btn = modal.footer.querySelector('[data-action="submit"]');
    btn.disabled = true;
    btn.textContent = 'Processing\u2026';
    try {
      await AdminAPI.createRefund(foundOrder.id, { type, amount, reasonCode, reasonNote });
      Toast.success(`${type === 'chargeback' ? 'Chargeback' : 'Refund'} created`);
      Modal.close();
      loadRefunds();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create Refund';
    }
  });
}

async function loadRefundAnalytics() {
  const params = FilterState.getParams();
  const signal = FilterState.getAbortSignal();
  const data = await AdminAPI.getRefundAnalytics(params, signal);

  if (!data) {
    const charts = _container.querySelectorAll('.admin-chart-box');
    charts.forEach(c => {
      c.innerHTML = `<div class="admin-empty" style="height:100%"><div class="admin-empty__text" data-tooltip="Requires analytics_refunds_series RPC">${MISSING} Analytics data unavailable</div></div>`;
    });
    return;
  }

  // Refund rate chart
  if (data.series?.length) {
    const colors = Charts.getThemeColors();
    await Charts.line('chart-refund-rate', {
      labels: data.series.map(d => d.date?.slice(5) || ''),
      datasets: [{
        label: 'Refund Rate %',
        data: data.series.map(d => {
          if (!d.total_orders) return 0;
          return ((d.refund_count / d.total_orders) * 100).toFixed(1);
        }),
        borderColor: colors.magenta,
        backgroundColor: colors.magenta + '18',
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        pointRadius: 2,
      }],
    });
  }

  // Reasons breakdown
  if (data.reasons?.length) {
    const colors = Charts.getThemeColors();
    const palette = [colors.magenta, colors.yellow, colors.cyan, colors.success, '#60a5fa', '#a78bfa'];
    await Charts.bar('chart-refund-reasons', {
      labels: data.reasons.map(r => r.reason || r.reason_code || 'Unknown'),
      datasets: [{
        label: 'Count',
        data: data.reasons.map(r => r.count || 0),
        backgroundColor: data.reasons.map((_, i) => palette[i % palette.length] + 'cc'),
        borderRadius: 4,
      }],
      options: { indexAxis: 'y' },
    });
  }
}

export default {
  title: 'Refunds & Chargebacks',

  async init(container) {
    _container = container;
    _page = 1;
    _tab = 'queue';
    renderContent();
  },

  destroy() {
    Charts.destroyAll();
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _search = '';
  },

  async onFilterChange() {
    _page = 1;
    if (_tab === 'analytics' && AdminAuth.isOwner()) {
      loadRefundAnalytics();
    } else if (_table) {
      loadRefunds();
    }
  },
};
