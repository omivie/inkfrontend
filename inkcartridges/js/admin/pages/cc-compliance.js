/**
 * Control Center — Tab 4: Orders & Compliance Audit
 * Payment breakdown chart, invoice preview, audit log
 */
import { AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;

let _el = null;
let _logTable = null;
let _logPage = 1;
let _logAction = '';
let _blobUrls = [];

// Default date range: last 90 days
function defaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

async function loadPaymentBreakdown() {
  const startInput = _el.querySelector('#cc-pay-start');
  const endInput = _el.querySelector('#cc-pay-end');
  const chartWrap = _el.querySelector('#cc-payment-chart-wrap');
  const summaryWrap = _el.querySelector('#cc-payment-summary');

  chartWrap.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:200px"></div>';
  summaryWrap.innerHTML = '';

  const data = await AdminAPI.getPaymentBreakdown(startInput.value, endInput.value);
  if (!data) {
    chartWrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not load payment data</div></div>';
    return;
  }

  // Summary KPIs
  const s = data.summary || {};
  summaryWrap.innerHTML = `
    <div class="admin-kpi-grid admin-kpi-grid--3" style="margin-bottom:1rem">
      <div class="admin-kpi">
        <div class="admin-kpi__label">Total Orders</div>
        <div class="admin-kpi__value">${(s.total_orders || 0).toLocaleString()}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Total Revenue</div>
        <div class="admin-kpi__value">${formatPrice(s.total_revenue || 0)}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Avg Order</div>
        <div class="admin-kpi__value">${s.total_orders > 0 ? formatPrice((s.total_revenue || 0) / s.total_orders) : '\u2014'}</div>
      </div>
    </div>
  `;

  // Doughnut chart
  const labels = [];
  const values = [];
  const colors = [];
  const themeColors = Charts.getThemeColors();

  if (data.stripe) {
    labels.push(`Stripe (${data.stripe.percentage?.toFixed(1) || 0}%)`);
    values.push(data.stripe.total || 0);
    colors.push(themeColors.cyan);
  }
  if (data.paypal) {
    labels.push(`PayPal (${data.paypal.percentage?.toFixed(1) || 0}%)`);
    values.push(data.paypal.total || 0);
    colors.push(themeColors.yellow);
  }

  if (values.length === 0) {
    chartWrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No payment data for this period</div></div>';
    return;
  }

  chartWrap.innerHTML = '<div class="cc-chart-wrap"><canvas id="cc-pay-chart"></canvas></div>';
  await Charts.doughnut('cc-pay-chart', {
    labels,
    data: values,
    colors,
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatPrice(ctx.raw)}`,
          },
        },
      },
    },
  });
}

async function handleInvoicePreview() {
  const input = _el.querySelector('#cc-invoice-id');
  const orderId = input.value.trim();
  if (!orderId) { Toast.warning('Enter an order ID'); return; }

  const btn = _el.querySelector('#cc-invoice-btn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const blobUrl = await AdminAPI.getInvoicePreviewUrl(orderId);
    _blobUrls.push(blobUrl);
    Modal.open({
      title: `Invoice \u2014 Order ${esc(orderId)}`,
      body: `<iframe src="${blobUrl}" style="width:100%;height:70vh;border:none"></iframe>`,
      className: 'admin-modal--wide',
      onClose: () => {
        URL.revokeObjectURL(blobUrl);
        _blobUrls = _blobUrls.filter(u => u !== blobUrl);
      },
    });
  } catch (e) {
    Toast.error('Failed to load invoice');
  }
  btn.disabled = false;
  btn.textContent = 'Preview';
}

const LOG_COLUMNS = [
  { key: 'created_at', label: 'Time', sortable: true, render: (r) =>
    `<span class="cell-muted" style="font-size:12px">${new Date(r.created_at).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>`
  },
  { key: 'user_id', label: 'User', render: (r) => `<span class="cell-mono" style="font-size:11px">${esc((r.user_id || '').slice(0, 8))}...</span>` },
  { key: 'action', label: 'Action', render: (r) => {
    const labelMap = {
      pricing_offset_changed: 'Pricing Offset',
      reconcile_triggered: 'Reconciliation',
      reviews_bulk_approved: 'Reviews Approved',
    };
    return `<span class="admin-badge admin-badge--processing">${esc(labelMap[r.action] || r.action)}</span>`;
  }},
  { key: 'resource_type', label: 'Resource', render: (r) => esc(r.resource_type || '\u2014') },
  { key: 'ip_address', label: 'IP', render: (r) => `<span class="cell-mono cell-muted" style="font-size:11px">${esc(r.ip_address || '\u2014')}</span>` },
];

async function loadAuditLogs() {
  if (_logTable) _logTable.setLoading(true);
  const resp = await AdminAPI.getAuditLogs({
    action: _logAction,
    page: _logPage,
    limit: 50,
  });
  if (!resp) { if (_logTable) _logTable.setData([], null); return; }
  const rows = resp.data || [];
  const meta = resp.metadata || {};
  if (_logTable) _logTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _logPage, limit: 50 });
}

export default {
  async init(el) {
    _el = el;
    _logPage = 1;
    _logAction = '';
    _blobUrls = [];
    const dates = defaultDates();

    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title">Payment Breakdown</div>
        <div class="cc-date-range">
          <label>From</label>
          <input type="date" id="cc-pay-start" value="${dates.start}">
          <label>To</label>
          <input type="date" id="cc-pay-end" value="${dates.end}">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="cc-pay-apply">Apply</button>
        </div>
        <div id="cc-payment-summary"></div>
        <div id="cc-payment-chart-wrap"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Invoice Preview</div>
        <div class="cc-invoice-form">
          <input type="text" id="cc-invoice-id" placeholder="Order ID" class="admin-input">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="cc-invoice-btn">Preview</button>
        </div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Audit Log</div>
        <div style="margin-bottom:0.75rem">
          <select class="admin-select" id="cc-log-action" style="width:200px">
            <option value="">All actions</option>
            <option value="pricing_offset_changed">Pricing Offset Changed</option>
            <option value="reconcile_triggered">Reconcile Triggered</option>
            <option value="reviews_bulk_approved">Reviews Bulk Approved</option>
          </select>
        </div>
        <div id="cc-audit-table"></div>
      </div>
    `;

    // Payment date range
    el.querySelector('#cc-pay-apply').addEventListener('click', () => loadPaymentBreakdown());

    // Invoice preview
    el.querySelector('#cc-invoice-btn').addEventListener('click', () => handleInvoicePreview());
    el.querySelector('#cc-invoice-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleInvoicePreview();
    });

    // Audit log filter
    el.querySelector('#cc-log-action').addEventListener('change', (e) => {
      _logAction = e.target.value;
      _logPage = 1;
      loadAuditLogs();
    });

    // Audit log table
    _logTable = new DataTable(el.querySelector('#cc-audit-table'), {
      columns: LOG_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No audit log entries',
      onPageChange: (page) => { _logPage = page; loadAuditLogs(); },
    });

    // Load data
    await Promise.allSettled([loadPaymentBreakdown(), loadAuditLogs()]);
  },

  destroy() {
    if (_logTable) { _logTable.destroy(); _logTable = null; }
    Charts.destroy('cc-pay-chart');
    for (const url of _blobUrls) URL.revokeObjectURL(url);
    _blobUrls = [];
    _el = null;
  },
};
