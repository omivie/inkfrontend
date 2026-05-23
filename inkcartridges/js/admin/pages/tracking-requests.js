/**
 * Tracking Requests — admin queue for customer-initiated tracking requests.
 *
 * Flow (May 2026 request-based tracking model):
 *   1. Customer submits their order number on /track-order.
 *   2. Backend records a request row + emails admins who opted into
 *      `notify_tracking_requests` (managed on the Settings page).
 *   3. Admin opens this page, clicks "Add tracking & notify", enters the
 *      carrier + tracking number, and submits — the backend writes the
 *      tracking onto the order, advances it to `shipped`, marks the request
 *      fulfilled, and emails the customer their tracking details.
 *
 * This page is the ONLY surface that closes the loop, so it must never leave a
 * request in an ambiguous state: every action reloads the list and refreshes
 * the sidebar badge.
 */
import { AdminAPI, FilterState, icon, esc, refreshTrackingRequestsBadge } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

let _container = null;
let _status = 'pending';

const CARRIERS = ['NZ Post', 'CourierPost', 'Aramex', 'DHL', 'Other'];

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-NZ', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return esc(String(iso)); }
}

function statusBadge(status) {
  const s = String(status || 'pending').toLowerCase();
  const label = { pending: 'Pending', fulfilled: 'Fulfilled', dismissed: 'Dismissed' }[s] || s;
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(label)}</span>`;
}

async function load() {
  renderShell('<div style="display:flex;align-items:center;justify-content:center;min-height:30vh"><div class="admin-loading__spinner"></div></div>');

  const data = await AdminAPI.getTrackingRequests({ status: _status }, 1, 100);
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
      <p class="admin-page-header__sub">Customers who asked for tracking on their order. Add the tracking number to notify them by email.</p>
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
    const trackingLine = r.tracking_number
      ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Tracking</span><span class="admin-detail-row__value">${esc(r.carrier ? r.carrier + ' · ' : '')}${esc(r.tracking_number)}</span></div>`
      : '';
    const noteLine = r.note
      ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Note</span><span class="admin-detail-row__value">${esc(r.note)}</span></div>`
      : '';

    const actions = pending ? `
      <button class="admin-btn admin-btn--primary admin-btn--sm" data-fulfill="${esc(String(r.id))}">${icon('fulfillment', 13, 13)} Add tracking &amp; notify</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-dismiss="${esc(String(r.id))}">Dismiss</button>
    ` : '';

    return `
      <div class="admin-card" style="margin-bottom:var(--spacing-md,16px);padding:var(--spacing-md,16px)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="min-width:220px;flex:1">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
              <span style="font-weight:700;font-size:15px">${esc(r.order_number || '—')}</span>
              ${statusBadge(r.status)}
            </div>
            <div class="admin-detail-row"><span class="admin-detail-row__label">Customer</span><span class="admin-detail-row__value">${esc(r.email || '—')}</span></div>
            <div class="admin-detail-row"><span class="admin-detail-row__label">Requested</span><span class="admin-detail-row__value">${fmtDate(r.created_at)}</span></div>
            ${r.fulfilled_at ? `<div class="admin-detail-row"><span class="admin-detail-row__label">Fulfilled</span><span class="admin-detail-row__value">${fmtDate(r.fulfilled_at)}</span></div>` : ''}
            ${trackingLine}
            ${noteLine}
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">${actions}</div>
        </div>
      </div>
    `;
  }).join('');
}

function showFulfillModal(request) {
  const modal = Modal.open({
    title: `Add tracking — ${request.order_number || 'order'}`,
    body: `
      <p class="admin-text-muted" style="margin-bottom:12px">This will mark the order as shipped and email the tracking details to <strong>${esc(request.email || 'the customer')}</strong>.</p>
      <div class="admin-form-group">
        <label>Carrier</label>
        <select class="admin-select" id="tr-carrier">
          <option value="">Select carrier</option>
          ${CARRIERS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </div>
      <div class="admin-form-group">
        <label>Tracking Number *</label>
        <input class="admin-input" id="tr-tracking" placeholder="e.g. ABC123456789NZ" autocomplete="off">
      </div>
      <div class="admin-form-group">
        <label>Note to customer <span class="admin-text-muted">(optional)</span></label>
        <input class="admin-input" id="tr-note" placeholder="e.g. Dispatched today, allow 2–3 working days" autocomplete="off">
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Send tracking</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const tracking = modal.body.querySelector('#tr-tracking')?.value?.trim();
    const carrier = modal.body.querySelector('#tr-carrier')?.value || null;
    const note = modal.body.querySelector('#tr-note')?.value?.trim() || null;
    if (!tracking) {
      Toast.warning('Enter a tracking number to notify the customer.');
      return;
    }
    const saveBtn = modal.footer.querySelector('[data-action="save"]');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Sending…'; }
    try {
      await AdminAPI.fulfillTrackingRequest(request.id, { carrier, tracking_number: tracking, status: 'shipped', note });
      Toast.success('Tracking sent to the customer');
      Modal.close();
      await load();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Send tracking'; }
    }
  });
}

async function dismiss(id) {
  if (!confirm('Dismiss this request without sending tracking?')) return;
  try {
    await AdminAPI.dismissTrackingRequest(id);
    Toast.success('Request dismissed');
    await load();
  } catch (e) {
    Toast.error(`Failed: ${e.message}`);
  }
}

function bindEvents(requests) {
  _container.querySelectorAll('[data-status-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _status = btn.dataset.statusTab;
      load();
    });
  });
  _container.querySelector('[data-action="refresh"]')?.addEventListener('click', () => load());

  const byId = (id) => requests.find(r => String(r.id) === String(id));
  _container.querySelectorAll('[data-fulfill]').forEach(btn => {
    btn.addEventListener('click', () => {
      const req = byId(btn.dataset.fulfill);
      if (req) showFulfillModal(req);
    });
  });
  _container.querySelectorAll('[data-dismiss]').forEach(btn => {
    btn.addEventListener('click', () => dismiss(btn.dataset.dismiss));
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
