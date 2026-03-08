/**
 * Product Review Page — Review queue for newly imported products
 */
import { AdminAPI, icon, esc, updateReviewBadge } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

let _container = null;
let _table = null;
let _tableEl = null;
let _page = 1;
let _search = '';
let _brandFilter = '';
let _sort = 'created_at';
let _sortDir = 'desc';
let _totalCount = 0;
let _brands = [];

function buildColumns() {
  return [
    {
      key: 'images', label: '',
      render: (r) => {
        const img = r.images?.[0] || r.primary_image || r.image_url;
        if (img) {
          const raw = typeof img === 'string' ? img : img.image_url || img.url || img.thumbnail_url || img.path;
          return `<img class="admin-product-thumb" src="${esc(raw || '')}" alt="" loading="lazy">`;
        }
        return `<div class="admin-product-thumb admin-product-thumb--empty">${icon('products', 16, 16)}</div>`;
      },
      className: 'cell-center',
    },
    {
      key: 'name', label: 'Name', sortable: true,
      render: (r) => `<span class="cell-truncate">${esc(r.name || MISSING)}</span>`,
    },
    {
      key: 'sku', label: 'SKU',
      render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>`,
    },
    {
      key: 'brand', label: 'Brand', sortable: true,
      render: (r) => {
        const raw = r.brand_name || r.brand || '';
        const brand = typeof raw === 'object' ? (raw.name || raw.brand || '') : raw;
        return brand ? `<span class="admin-badge admin-badge--processing">${esc(brand)}</span>` : MISSING;
      },
    },
    {
      key: 'retail_price', label: 'Price', sortable: true,
      render: (r) => `<span class="cell-mono cell-right">${r.retail_price != null ? formatPrice(r.retail_price) : MISSING}</span>`,
      align: 'right',
    },
    {
      key: 'created_at', label: 'Added', sortable: true,
      render: (r) => {
        if (!r.created_at) return MISSING;
        const d = new Date(r.created_at);
        return `<span class="admin-text-muted">${d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}</span>`;
      },
    },
    {
      key: 'actions', label: '',
      render: (r) => `<button class="admin-btn admin-btn--primary admin-btn--sm" data-accept="${esc(r.id)}">Accept</button>`,
      className: 'cell-center',
    },
  ];
}

async function loadPage() {
  _container.innerHTML = '';

  // Load brands for filter
  const brands = await AdminAPI.getBrands();
  if (!_container) return; // destroyed during await
  if (brands && Array.isArray(brands)) {
    _brands = brands.map(b => typeof b === 'string' ? b : b.name || b.brand || String(b));
  }

  let html = `<div class="admin-page-header">
    <div style="display:flex;align-items:center;gap:10px">
      <h1>${icon('orders', 20, 20)} Product Review</h1>
      <span class="admin-badge admin-badge--pending" id="review-count-badge" style="font-size:12px">0</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <select class="admin-select admin-select--sm" id="review-brand-filter" style="min-width:140px">
        <option value="">All brands</option>
        ${_brands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}
      </select>
    </div>
  </div>`;

  html += `<div id="review-table"></div>`;
  _container.innerHTML = html;

  // Brand filter
  document.getElementById('review-brand-filter').addEventListener('change', (e) => {
    _brandFilter = e.target.value;
    _page = 1;
    fetchAndRender();
  });

  _tableEl = document.getElementById('review-table');
  _table = new DataTable(_tableEl, {
    columns: buildColumns(),
    rowKey: 'id',
    emptyMessage: 'All products reviewed',
    emptyIcon: `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    onRowClick: (row) => openDetailDrawer(row),
    onSort: (key, dir) => {
      _sort = key;
      _sortDir = dir;
      _page = 1;
      fetchAndRender();
    },
    onPageChange: (p) => {
      _page = p;
      fetchAndRender();
    },
  });

  _table.setSort(_sort, _sortDir);
  await fetchAndRender();
}

async function fetchAndRender() {
  if (!_table) return;
  _table.setLoading(true);

  const filters = { sort: _sort, order: _sortDir };
  if (_search) filters.search = _search;
  if (_brandFilter) filters.brand = _brandFilter;

  const data = await AdminAPI.getUnreviewedProducts(filters, _page, 200);
  if (!_table) return; // destroyed during await
  const products = data?.products || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || { total: products.length, page: _page, limit: 200 };

  _totalCount = pagination.total || 0;
  updateCountBadge(_totalCount);
  updateReviewBadge(_totalCount);

  _table.setData(products, pagination);
  _table.setSort(_sort, _sortDir);
  bindAcceptButtons(products);
}

function updateCountBadge(count) {
  const badge = document.getElementById('review-count-badge');
  if (badge) badge.textContent = count;
}

function bindAcceptButtons(products) {
  if (!_tableEl) return;
  _tableEl.querySelectorAll('[data-accept]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.accept;
      const product = products.find(p => String(p.id) === id);
      if (product) acceptProduct(product, btn.closest('tr'));
    });
  });
}

async function acceptProduct(product, rowEl) {
  // Optimistic: animate row out
  if (rowEl) {
    rowEl.classList.add('admin-row-exit');
  }

  // Optimistic count update
  _totalCount = Math.max(0, _totalCount - 1);
  updateCountBadge(_totalCount);
  updateReviewBadge(_totalCount);

  try {
    await AdminAPI.reviewProduct(product.id, true);
  } catch (e) {
    Toast.error(`Failed to accept: ${e.message}`);
    // Revert on failure
    if (rowEl) rowEl.classList.remove('admin-row-exit');
    _totalCount += 1;
    updateCountBadge(_totalCount);
    updateReviewBadge(_totalCount);
    return;
  }

  // Show undo toast
  const productName = product.name || product.sku || 'Product';
  const toastEl = Toast.success(`${productName} accepted`, 5000);

  if (toastEl) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'admin-toast__undo';
    undoBtn.textContent = 'Undo';
    toastEl.querySelector('.admin-toast__message').after(undoBtn);

    let undone = false;
    undoBtn.addEventListener('click', async () => {
      if (undone) return;
      undone = true;
      try {
        await AdminAPI.reviewProduct(product.id, false);
        Toast.info('Undone');
      } catch (e) {
        Toast.error(`Undo failed: ${e.message}`);
      }
      toastEl.remove();
      fetchAndRender();
    });

    // Reload table when toast expires (if not undone)
    setTimeout(() => {
      if (!undone) fetchAndRender();
    }, 5200);
  } else {
    // No toast element — just reload
    setTimeout(() => fetchAndRender(), 300);
  }
}

function openDetailDrawer(product) {
  const img = product.images?.[0] || product.primary_image || product.image_url;
  const imgUrl = img ? (typeof img === 'string' ? img : img.image_url || img.url || img.thumbnail_url || img.path) : null;

  const brand = product.brand_name || product.brand || '';
  const brandStr = typeof brand === 'object' ? (brand.name || brand.brand || '') : brand;

  let body = '<div class="admin-form" style="pointer-events:auto">';

  if (imgUrl) {
    body += `<div style="text-align:center;margin-bottom:16px">
      <img src="${esc(imgUrl)}" alt="" style="max-width:100%;max-height:220px;border-radius:var(--radius-lg);background:var(--surface)">
    </div>`;
  }

  const fields = [
    ['Name', product.name],
    ['SKU', product.sku],
    ['Brand', brandStr],
    ['Price', product.retail_price != null ? formatPrice(product.retail_price) : null],
    ['Cost', product.cost_price != null ? formatPrice(product.cost_price) : null],
    ['Type', product.product_type || product.type],
    ['Color', product.color],
    ['Source', product.source],
    ['Stock', product.stock_quantity != null ? String(product.stock_quantity) : null],
  ];

  for (const [label, value] of fields) {
    body += `<div class="admin-form-row" style="padding:6px 0;border-bottom:1px solid var(--border)">
      <span class="admin-text-muted" style="min-width:80px;display:inline-block">${label}</span>
      <span>${esc(value || MISSING)}</span>
    </div>`;
  }

  if (product.description) {
    body += `<div style="margin-top:12px">
      <div class="admin-text-muted" style="margin-bottom:4px">Description</div>
      <div style="font-size:13px;line-height:1.5;color:var(--text-secondary)">${esc(product.description)}</div>
    </div>`;
  }

  body += '</div>';

  const footerHtml = `<button class="admin-btn admin-btn--primary" style="width:100%" id="drawer-accept-btn">Accept Product</button>`;

  const drawer = Drawer.open({
    title: 'Product Details',
    body,
    footer: footerHtml,
    width: '440px',
  });

  document.getElementById('drawer-accept-btn')?.addEventListener('click', async () => {
    Drawer.close();
    // Find row in table
    const row = _tableEl?.querySelector(`tr[data-row-key="${product.id}"]`);
    acceptProduct(product, row);
  });
}

export default {
  title: 'Product Review',

  async init(container) {
    _container = container;
    _page = 1;
    _search = '';
    _brandFilter = '';
    _sort = 'created_at';
    _sortDir = 'desc';
    _totalCount = 0;
    _brands = [];
    await loadPage();
  },

  destroy() {
    if (_table) _table.destroy();
    _table = null;
    _tableEl = null;
    _container = null;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    fetchAndRender();
  },
};
