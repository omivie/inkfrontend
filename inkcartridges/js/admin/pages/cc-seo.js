/**
 * Control Center — Tab 2: SEO & Trust
 * Indexing status, SERP rankings, bulk review approval
 */
import { AdminAPI, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _el = null;
let _serpTable = null;
let _keyword = '';

function renderIndexingStatus(data) {
  const wrap = _el.querySelector('#cc-indexing-status');
  if (!data) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not load indexing data</div></div>';
    return;
  }
  const coverage = data.total_product_urls > 0
    ? ((data.seo_optimized / data.total_product_urls) * 100).toFixed(1)
    : '0.0';
  wrap.innerHTML = `
    <div class="admin-kpi-grid admin-kpi-grid--4">
      <div class="admin-kpi">
        <div class="admin-kpi__label">Total Product URLs</div>
        <div class="admin-kpi__value">${data.total_product_urls.toLocaleString()}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">SEO Optimized</div>
        <div class="admin-kpi__value">${data.seo_optimized.toLocaleString()}</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Coverage</div>
        <div class="admin-kpi__value">${coverage}%</div>
      </div>
      <div class="admin-kpi">
        <div class="admin-kpi__label">Pending Reindex</div>
        <div class="admin-kpi__value">${(data.recently_updated || 0).toLocaleString()}</div>
      </div>
    </div>
    ${!data.indexing_api_configured ? '<div style="font-size:12px;color:var(--yellow);margin-top:4px">Indexing API not configured</div>' : ''}
  `;
}

function trendArrow(history) {
  if (!history || history.length < 2) return '<span style="color:var(--text-muted)">&mdash;</span>';
  const curr = history[history.length - 1].position;
  const prev = history[history.length - 2].position;
  if (curr < prev) return `<span style="color:var(--success)">\u2191 ${prev - curr}</span>`;
  if (curr > prev) return `<span style="color:var(--danger)">\u2193 ${curr - prev}</span>`;
  return '<span style="color:var(--text-muted)">\u2192</span>';
}

const SERP_COLUMNS = [
  { key: 'keyword', label: 'Keyword', sortable: true },
  { key: 'current_position', label: 'Position', align: 'right', sortable: true, render: (r) => {
    const color = r.current_position <= 10 ? 'var(--success)' : r.current_position <= 30 ? 'var(--yellow)' : 'var(--danger)';
    return `<span class="cell-mono" style="color:${color};font-weight:600">${r.current_position}</span>`;
  }},
  { key: 'url', label: 'URL', render: (r) => `<span class="cell-truncate" style="max-width:200px;font-size:11px">${esc(r.url)}</span>` },
  { key: 'change', label: 'Change', align: 'center', render: (r) => trendArrow(r.history) },
  { key: 'last_checked', label: 'Last Checked', render: (r) => r.last_checked
    ? `<span class="cell-muted">${new Date(r.last_checked).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</span>`
    : '\u2014'
  },
];

async function loadSerpRankings() {
  if (_serpTable) _serpTable.setLoading(true);
  const data = await AdminAPI.getSerpRankings(_keyword);
  const rows = Array.isArray(data) ? data : [];
  if (_serpTable) _serpTable.setData(rows, null);
}

async function initReviewPanel() {
  const panel = _el.querySelector('#cc-review-panel');
  const previewBtn = panel.querySelector('#cc-review-preview-btn');
  const ratingSelect = panel.querySelector('#cc-review-rating');
  const resultBox = panel.querySelector('#cc-review-result');

  previewBtn.addEventListener('click', async () => {
    const minRating = parseInt(ratingSelect.value);
    previewBtn.disabled = true;
    previewBtn.textContent = 'Checking...';
    try {
      const data = await AdminAPI.bulkApproveReviews(minRating, true);
      if (!data) throw new Error('No response');
      resultBox.innerHTML = `
        <div class="cc-review-preview">
          <span><strong>${data.would_approve}</strong> pending ${minRating}+ star review${data.would_approve !== 1 ? 's' : ''}</span>
          ${data.would_approve > 0 ? `<button class="admin-btn admin-btn--primary admin-btn--sm" id="cc-review-approve-btn">Approve All</button>` : ''}
        </div>
      `;
      const approveBtn = resultBox.querySelector('#cc-review-approve-btn');
      if (approveBtn) {
        approveBtn.addEventListener('click', () => {
          Modal.confirm({
            title: 'Approve Reviews',
            message: `Approve ${data.would_approve} review${data.would_approve !== 1 ? 's' : ''} with ${minRating}+ stars?`,
            confirmLabel: 'Approve',
            onConfirm: async () => {
              const result = await AdminAPI.bulkApproveReviews(minRating, false);
              if (result) {
                Toast.success(`${result.approved_count} review${result.approved_count !== 1 ? 's' : ''} approved across ${result.products_affected} product${result.products_affected !== 1 ? 's' : ''}`);
                resultBox.innerHTML = '';
              }
            },
          });
        });
      }
    } catch (e) {
      Toast.error('Failed to check reviews');
    }
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview';
  });
}

export default {
  async init(el) {
    _el = el;
    _keyword = '';
    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title">Indexing Status</div>
        <div id="cc-indexing-status">
          <div class="admin-kpi-grid admin-kpi-grid--4">
            <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
            <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
            <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
            <div class="admin-kpi"><div class="admin-skeleton admin-skeleton--kpi"></div></div>
          </div>
        </div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">SERP Rankings</div>
        <div style="margin-bottom:0.75rem">
          <input type="text" class="admin-input" id="cc-serp-search" placeholder="Search keyword..." style="width:240px">
        </div>
        <div id="cc-serp-table"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Bulk Review Approval</div>
        <div id="cc-review-panel" class="cc-review-panel">
          <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
            <label style="font-size:13px">Minimum rating:</label>
            <select class="admin-select" id="cc-review-rating" style="width:80px">
              <option value="5">5 stars</option>
              <option value="4">4 stars</option>
              <option value="3">3 stars</option>
            </select>
            <button class="admin-btn admin-btn--ghost admin-btn--sm" id="cc-review-preview-btn">Preview</button>
          </div>
          <div id="cc-review-result"></div>
        </div>
      </div>
    `;

    // SERP search
    let searchTimer = null;
    el.querySelector('#cc-serp-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _keyword = e.target.value.trim();
        loadSerpRankings();
      }, 400);
    });

    // SERP table
    _serpTable = new DataTable(el.querySelector('#cc-serp-table'), {
      columns: SERP_COLUMNS,
      rowKey: 'keyword',
      emptyMessage: 'No ranking data available',
    });

    // Review panel
    initReviewPanel();

    // Load data
    const [indexData] = await Promise.allSettled([
      AdminAPI.getSeoIndexingStatus(),
      loadSerpRankings(),
    ]);
    renderIndexingStatus(indexData.status === 'fulfilled' ? indexData.value : null);
  },

  destroy() {
    if (_serpTable) { _serpTable.destroy(); _serpTable = null; }
    _el = null;
  },

  onSearch(query) {
    _keyword = query;
    const input = _el?.querySelector('#cc-serp-search');
    if (input) input.value = query;
    loadSerpRankings();
  },
};
