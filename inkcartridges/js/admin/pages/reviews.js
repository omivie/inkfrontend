/**
 * Customer Reviews — Approve, reject, and moderate customer product reviews
 */
import { AdminAPI, AdminAuth, esc, icon } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { FilterState } from '../app.js';

const MISSING = '\u2014';

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _statusFilter = 'pending';

function stars(rating) {
  const n = Math.round(rating || 0);
  return '<span style="color:var(--yellow);letter-spacing:1px">' + '\u2605'.repeat(n) + '\u2606'.repeat(5 - n) + '</span>';
}

function formatDate(d) {
  if (!d) return MISSING;
  return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

const COLUMNS = [
  { key: 'created_at', label: 'Date', sortable: true, render: (r) => `<span style="font-size:12px;white-space:nowrap">${formatDate(r.created_at)}</span>` },
  { key: 'product_name', label: 'Product', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:180px">${esc(r.product_name || r.product?.name || MISSING)}</span>` },
  { key: 'customer_name', label: 'Customer', render: (r) => esc(r.customer_name || r.author_name || r.user?.name || MISSING) },
  { key: 'rating', label: 'Rating', sortable: true, render: (r) => stars(r.rating) },
  { key: 'review_text', label: 'Review', render: (r) => {
    const text = r.review_text || r.body || r.comment || '';
    return `<span class="cell-truncate" style="max-width:220px">${esc(text)}</span>`;
  }},
  { key: 'status', label: 'Status', render: (r) => {
    const s = (r.status || 'pending').toLowerCase();
    const cls = s === 'approved' ? 'delivered' : s === 'rejected' ? 'refunded' : 'pending';
    return `<span class="admin-badge admin-badge--${cls}">${esc(r.status || 'pending')}</span>`;
  }},
  { key: '_actions', label: '', align: 'right', render: (r) => {
    const s = (r.status || 'pending').toLowerCase();
    let btns = '';
    if (s !== 'approved') btns += `<button class="admin-btn admin-btn--xs admin-btn--primary rv-action" data-id="${Security.escapeAttr(r.id)}" data-action="approve" style="margin-right:4px">Approve</button>`;
    if (s !== 'rejected') btns += `<button class="admin-btn admin-btn--xs admin-btn--ghost rv-action" data-id="${Security.escapeAttr(r.id)}" data-action="reject" style="color:var(--danger);border-color:var(--danger)">Reject</button>`;
    return btns;
  }},
];

async function loadReviews() {
  if (_table) _table.setLoading(true);
  const data = await AdminAPI.getReviews({
    status: _statusFilter,
    search: _search,
  }, _page, 20);
  if (!data) { if (_table) _table.setData([], null); return; }
  const rows = data.reviews || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_table) _table.setData(rows, { total: meta.total || rows.length, page: meta.page || _page, limit: 20 });
}

async function updateStatus(reviewId, status) {
  try {
    await AdminAPI.updateReview(reviewId, { status });
    Toast.success(`Review ${status}`);
    loadReviews();
  } catch (e) {
    Toast.error(`Failed to ${status} review: ${e.message}`);
  }
}

function showReviewDetail(row) {
  const text = row.review_text || row.body || row.comment || 'No review text';
  const s = (row.status || 'pending').toLowerCase();
  let footerBtns = `<button class="admin-btn admin-btn--ghost" id="rv-detail-close">Close</button>`;
  if (s !== 'approved') footerBtns += `<button class="admin-btn admin-btn--primary" id="rv-detail-approve">Approve</button>`;
  if (s !== 'rejected') footerBtns += `<button class="admin-btn admin-btn--ghost" id="rv-detail-reject" style="color:var(--danger);border-color:var(--danger)">Reject</button>`;

  const m = Modal.open({
    title: 'Review Detail',
    body: `
      <div style="margin-bottom:12px">
        <strong>${esc(row.product_name || row.product?.name || 'Product')}</strong>
        <span style="margin-left:8px">${stars(row.rating)}</span>
      </div>
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">
        By ${esc(row.customer_name || row.author_name || 'Anonymous')} &middot; ${formatDate(row.created_at)}
      </div>
      <div style="line-height:1.6;white-space:pre-wrap">${esc(text)}</div>
    `,
    footer: footerBtns,
  });
  m.footer.querySelector('#rv-detail-close').addEventListener('click', () => m.close());
  m.footer.querySelector('#rv-detail-approve')?.addEventListener('click', async () => {
    await updateStatus(row.id, 'approved');
    m.close();
  });
  m.footer.querySelector('#rv-detail-reject')?.addEventListener('click', async () => {
    await updateStatus(row.id, 'rejected');
    m.close();
  });
}

function showBulkApproveModal() {
  const m = Modal.open({
    title: 'Bulk Approve Reviews',
    body: `
      <p>Approve all pending reviews with a minimum star rating:</p>
      <div class="admin-form-group" style="margin-top:12px">
        <label>Minimum Rating</label>
        <select class="admin-select" id="rv-bulk-rating" style="width:100%">
          <option value="1">1+ stars (all)</option>
          <option value="3">3+ stars</option>
          <option value="4" selected>4+ stars</option>
          <option value="5">5 stars only</option>
        </select>
      </div>
      <div id="rv-bulk-preview" style="margin-top:12px;font-size:13px;color:var(--text-muted)">Click Preview to see how many reviews will be approved.</div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" id="rv-bulk-cancel">Cancel</button>
      <button class="admin-btn admin-btn--ghost" id="rv-bulk-preview-btn">Preview</button>
      <button class="admin-btn admin-btn--primary" id="rv-bulk-confirm" disabled>Approve</button>
    `,
  });

  m.footer.querySelector('#rv-bulk-cancel').addEventListener('click', () => m.close());

  m.footer.querySelector('#rv-bulk-preview-btn').addEventListener('click', async () => {
    const rating = parseInt(m.body.querySelector('#rv-bulk-rating').value, 10);
    const previewEl = m.body.querySelector('#rv-bulk-preview');
    previewEl.textContent = 'Checking...';
    try {
      const result = await AdminAPI.bulkApproveReviews(rating, true);
      const count = result?.count ?? result?.affected ?? 0;
      previewEl.innerHTML = `<strong>${count}</strong> review${count !== 1 ? 's' : ''} will be approved.`;
      m.footer.querySelector('#rv-bulk-confirm').disabled = count === 0;
    } catch (e) {
      previewEl.textContent = 'Preview failed: ' + e.message;
    }
  });

  m.footer.querySelector('#rv-bulk-confirm').addEventListener('click', async () => {
    const rating = parseInt(m.body.querySelector('#rv-bulk-rating').value, 10);
    const btn = m.footer.querySelector('#rv-bulk-confirm');
    btn.disabled = true;
    btn.textContent = 'Approving...';
    try {
      const result = await AdminAPI.bulkApproveReviews(rating, false);
      const count = result?.count ?? result?.affected ?? 0;
      Toast.success(`${count} review${count !== 1 ? 's' : ''} approved`);
      m.close();
      loadReviews();
    } catch (e) {
      Toast.error('Bulk approve failed: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Approve';
    }
  });
}

function render() {
  _container.innerHTML = `
    <div class="admin-page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <h1 class="admin-page-title">${icon('orders', 22, 22)} Customer Reviews</h1>
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="rv-bulk-approve-btn">Bulk Approve</button>
    </div>
    <div class="admin-tabs" id="rv-status-tabs" style="margin-bottom:16px">
      <button class="admin-tab${_statusFilter === 'pending' ? ' active' : ''}" data-status="pending">Pending</button>
      <button class="admin-tab${_statusFilter === 'approved' ? ' active' : ''}" data-status="approved">Approved</button>
      <button class="admin-tab${_statusFilter === 'rejected' ? ' active' : ''}" data-status="rejected">Rejected</button>
      <button class="admin-tab${_statusFilter === '' ? ' active' : ''}" data-status="">All</button>
    </div>
    <div id="rv-table"></div>
  `;
}

export default {
  title: 'Customer Reviews',

  async init(container) {
    _container = container;
    _page = 1;
    _search = '';
    _statusFilter = 'pending';

    FilterState.showBar(false);
    render();

    // Status tabs
    _container.querySelector('#rv-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      _statusFilter = btn.dataset.status;
      _page = 1;
      _container.querySelectorAll('#rv-status-tabs .admin-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.status === _statusFilter));
      loadReviews();
    });

    // Bulk approve
    _container.querySelector('#rv-bulk-approve-btn').addEventListener('click', showBulkApproveModal);

    // Table
    _table = new DataTable(_container.querySelector('#rv-table'), {
      columns: COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No reviews found',
      onPageChange: (page) => { _page = page; loadReviews(); },
      onRowClick: (row) => showReviewDetail(row),
    });

    // Approve/Reject button delegation
    _container.querySelector('#rv-table').addEventListener('click', (e) => {
      const btn = e.target.closest('.rv-action');
      if (!btn) return;
      e.stopPropagation(); // prevent row click
      updateStatus(btn.dataset.id, btn.dataset.action === 'approve' ? 'approved' : 'rejected');
    });

    await loadReviews();
  },

  destroy() {
    if (_table) { _table.destroy(); _table = null; }
    _container = null;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    loadReviews();
  },

  onFilterChange() {},
};
