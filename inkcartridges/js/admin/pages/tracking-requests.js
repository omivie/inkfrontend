/**
 * Tracking Requests — admin queue for customer-initiated tracking requests.
 *
 * Flow (June 2026 request-based tracking model)
 * =============================================
 *   1. Customer submits their order number + email on /track-order.
 *   2. Backend records a row in `order_tracking_requests` and emails the
 *      opted-in admins (Settings → notify_tracking_requests).
 *   3. Admin opens THIS page, clicks "Open order to add tracking", which deep
 *      links to the order. Adding a tracking number on the order update form
 *      (PUT /api/admin/orders/:id) is what closes the loop.
 *   4. The backend then AUTOMATICALLY flips any pending request for that order
 *      to `fulfilled` and emails the customer the shipping confirmation.
 *
 * There is deliberately NO inline "fulfil" or "dismiss" action here: the
 * backend exposes no such endpoint. Fulfilment is a side-effect of setting
 * tracking on the order, so the single source of truth for "is it shipped" is
 * the order itself. This page reads the queue and routes the admin to the order.
 *
 * Verified backend contract (June 2026):
 *   GET /api/admin/tracking-requests?status=pending|fulfilled|all →
 *     { ok:true, data:{ requests:[{ id, order_number, email, status,
 *       fulfilled_at, created_at, order:{ status, tracking_number, carrier } }],
 *       total } }
 */
import { AdminAPI, FilterState, icon, esc, refreshTrackingRequestsBadge } from '../app.js';

let _container = null;
let _status = 'pending';

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-NZ', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return esc(String(iso)); }
}

function statusBadge(status) {
  // Backend statuses are only 'pending' | 'fulfilled'.
  const s = String(status || 'pending').toLowerCase();
  const label = { pending: 'Pending', fulfilled: 'Fulfilled' }[s] || s;
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(label)}</span>`;
}

// The order's own status (paid / processing / shipped / …) shown for context.
function orderStatusBadge(status) {
  if (!status) return '';
  const s = String(status).toLowerCase();
  return `<span class="admin-badge admin-badge--${esc(s)}" title="Current order status">${esc(s)}</span>`;
}

async function load() {
  renderShell('<div style="display:flex;align-items:center;justify-content:center;min-height:30vh"><div class="admin-loading__spinner"></div></div>');

  const data = await AdminAPI.getTrackingRequests({ status: _status });
  if (data === null) {
    renderShell(`
      <div class="admin-card" style="padding:var(--spacing-md,16px)">
        <p class="admin-text-muted">Couldn't load tracking requests. The server may be waking up — try Refresh in a moment.</p>
      </div>
    `);
    bindEvents([]);
    return;
  }
  const requests = data?.requests || (Array.isArray(data) ? data : []);
  renderShell(renderList(requests));
  bindEvents(requests);
  refreshTrackingRequestsBadge();
}

function renderShell(inner) {
  const tabs = [
    { key: 'pending', label: 'Pending' },
    { key: 'fulfilled', label: 'Fulfilled' },
    { key: 'all', label: 'All' },
  ];
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1>Tracking Requests</h1>
      <p class="admin-page-header__sub">Customers who asked for tracking on their order. Open the order and add a tracking number — the customer is emailed automatically and the request clears itself.</p>
    </div>
    <div class="admin-segmented" style="display:inline-flex;gap:4px;margin-bottom:var(--spacing-md, 16px);background:var(--bg-subtle,#f1f5f9);padding:4px;border-radius:8px">
      ${tabs.map(t => `
        <button class="admin-btn admin-btn--sm ${_status === t.key ? 'admin-btn--primary' : 'admin-btn--ghost'}" data-status-tab="${t.key}">${t.label}</button>
      `).join('')}
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-action="refresh" title="Refresh">${icon('search', 13, 13)} Refresh</button>
    </div>
    <div id="tracking-requests-body">${inner}</div>
  `;
}

function renderList(requests) {
  if (!requests.length) {
    const msg = _status === 'pending'
      ? 'No pending tracking requests. You\'re all caught up.'
      : 'No tracking requests to show.';
    return `<div class="admin-card"><p class="admin-text-muted" style="padding:var(--spacing-md,16px)">${esc(msg)}</p></div>`;
  }

  return requests.map(r => {
    const pending = String(r.status || 'pending').toLowerCase() === 'pending';
    const order = r.order || {};
    const carrier = order.carrier || null;
    const trackingNumber = order.tracking_number || null;
    const trackingLine = trackingNumber
      ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Tracking</span><span class="admin-detail-row__value">${esc(carrier ? carrier + ' · ' : '')}${esc(trackingNumber)}</span></div>`
      : '';
    const orderStatusLine = order.status
      ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Order status</span><span class="admin-detail-row__value">${orderStatusBadge(order.status)}</span></div>`
      : '';

    // Pending requests route to the order so the admin can add tracking there.
    // (Adding tracking is what auto-fulfils the request + emails the customer.)
    const actions = pending ? `
      <button class="admin-btn admin-btn--primary admin-btn--sm" data-open-order="${esc(String(r.order_number || ''))}">${icon('orders', 13, 13)} Open order to add tracking</button>
    ` : '';

    return `
      <div class="admin-card" style="margin-bottom:var(--spacing-md,16px);padding:var(--spacing-md,16px)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="min-width:220px;flex:1">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
              <span style="font-weight:700;font-size:15px">${esc(r.order_number || '—')}</span>
              ${statusBadge(r.status)}
            </div>
            <div class="admin-detail-row"><span class="admin-detail-row__label">Customer</span><span class="admin-detail-row__value">${esc(r.email || '—')}</span></div>
            <div class="admin-detail-row"><span class="admin-detail-row__label">Requested</span><span class="admin-detail-row__value">${fmtDate(r.created_at)}</span></div>
            ${orderStatusLine}
            ${r.fulfilled_at ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Fulfilled</span><span class="admin-detail-row__value">${fmtDate(r.fulfilled_at)}</span></div>` : ''}
            ${trackingLine}
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">${actions}</div>
        </div>
      </div>
    `;
  }).join('');
}

function openOrder(orderNumber) {
  if (!orderNumber) return;
  // Deep-link the Orders page to this order: it seeds the search and auto-opens
  // the order drawer where the admin enters carrier + tracking number.
  window.location.hash = `orders?focus=${encodeURIComponent(orderNumber)}`;
}

function bindEvents(requests) {
  _container.querySelectorAll('[data-status-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _status = btn.dataset.statusTab;
      load();
    });
  });
  _container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => load());

  _container.querySelectorAll('[data-open-order]').forEach(btn => {
    btn.addEventListener('click', () => openOrder(btn.dataset.openOrder));
  });
}

export default {
  title: 'Tracking Requests',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    _status = 'pending';
    await load();
  },

  destroy() {
    _container = null;
  },
};
