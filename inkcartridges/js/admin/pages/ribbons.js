/**
 * Ribbons Page — Manage ribbon brands & products
 * Two-tab layout: Brands | Products
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { RichTextEditor } from '../components/rich-text-editor.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';
const RIBBON_TYPES = [
  { value: 'printer_ribbon', label: 'Printer Ribbon' },
  { value: 'typewriter_ribbon', label: 'Typewriter Ribbon' },
  { value: 'correction_tape', label: 'Correction Tape' },
];

// ── State ────────────────────────────────────────────────────────────────
let _container = null;
let _tab = 'products'; // 'brands' | 'products'
let _brandsTable = null;
let _productsTable = null;
let _ribbonBrands = [];

// Products filters
let _pSearch = '';
let _pBrandFilter = '';
let _pTypeFilter = '';
let _pActiveFilter = '';
let _pSort = 'name';
let _pSortDir = 'asc';
let _pPage = 1;
let _pLimit = 300;

// Active modal/drawer tracking
let _activeModal = null;

// ── Helpers ──────────────────────────────────────────────────────────────
function formGroup(label, inputHtml) {
  return `<div class="admin-form-group"><label>${label}</label>${inputHtml}</div>`;
}

function buildSelect(id, options, selected) {
  let html = `<select class="admin-select" id="${id}">`;
  for (const opt of options) {
    const value = typeof opt === 'object' ? opt.value : opt;
    const label = typeof opt === 'object' ? opt.label : opt.charAt(0).toUpperCase() + opt.slice(1);
    const sel = selected && String(selected).toLowerCase() === String(value).toLowerCase() ? ' selected' : '';
    html += `<option value="${esc(value)}"${sel}>${esc(label)}</option>`;
  }
  html += '</select>';
  return html;
}

function toggleHtml(id, checked) {
  return `<label class="admin-toggle"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="admin-toggle__slider"></span></label>`;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function brandSelect(currentId) {
  let html = `<select class="admin-select" id="edit-ribbon-brand"><option value="">Select device brand</option>`;
  for (const b of _ribbonBrands) {
    const sel = currentId === b.id ? ' selected' : '';
    html += `<option value="${esc(b.id)}"${sel}>${esc(b.name)}</option>`;
  }
  html += '</select>';
  return html;
}

// ── Tab Rendering ────────────────────────────────────────────────────────
function renderShell() {
  _container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'admin-page-header';
  header.innerHTML = `
    <div class="admin-page-header__top">
      <h1>Ribbons</h1>
    </div>
    <div class="admin-tab-bar" id="ribbon-tabs">
      <button class="admin-tab-bar__btn${_tab === 'brands' ? ' active' : ''}" data-tab="brands">Brands</button>
      <button class="admin-tab-bar__btn${_tab === 'products' ? ' active' : ''}" data-tab="products">Products</button>
    </div>
  `;
  _container.appendChild(header);

  const body = document.createElement('div');
  body.id = 'ribbon-body';
  _container.appendChild(body);

  // Tab switching
  header.querySelector('#ribbon-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-tab-bar__btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    if (tab === _tab) return;
    _tab = tab;
    header.querySelectorAll('.admin-tab-bar__btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderTab();
  });

  renderTab();
}

function renderTab() {
  const body = document.getElementById('ribbon-body');
  if (!body) return;
  body.innerHTML = '';
  if (_tab === 'brands') renderBrandsTab(body);
  else renderProductsTab(body);
}

// ══════════════════════════════════════════════════════════════════════════
//  BRANDS TAB
// ══════════════════════════════════════════════════════════════════════════
function renderBrandsTab(container) {
  const toolbar = document.createElement('div');
  toolbar.className = 'admin-toolbar';
  toolbar.innerHTML = `
    <div style="flex:1"></div>
    <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-brand-btn">${icon('plus', 14, 14)} Add Brand</button>
  `;
  container.appendChild(toolbar);

  toolbar.querySelector('#add-brand-btn').addEventListener('click', () => openBrandModal(null));

  const tableWrap = document.createElement('div');
  container.appendChild(tableWrap);

  _brandsTable = new DataTable(tableWrap, {
    columns: buildBrandColumns(),
    rowKey: 'id',
    onRowClick: (row) => openBrandModal(row),
    emptyMessage: 'No ribbon brands yet',
  });

  loadBrands();
}

function buildBrandColumns() {
  return [
    {
      key: 'image', label: '', className: 'cell-center cell-image',
      render: (r) => r.image_url
        ? `<img class="admin-product-thumb" src="${esc(r.image_url)}" alt="" loading="lazy">`
        : `<div class="admin-product-thumb admin-product-thumb--empty">${icon('products', 16, 16)}</div>`,
    },
    { key: 'name', label: 'Name', sortable: true, render: (r) => esc(r.name || MISSING) },
    { key: 'slug', label: 'Slug', render: (r) => `<span class="cell-mono">${esc(r.slug || MISSING)}</span>` },
    { key: 'sort_order', label: 'Order', align: 'center', render: (r) => String(r.sort_order ?? 0) },
    {
      key: 'is_active', label: 'Active', align: 'center',
      render: (r) => {
        const active = r.is_active !== false;
        return `<span class="admin-active-dot admin-active-dot--${active ? 'on' : 'off'}"></span>`;
      },
    },
  ];
}

async function loadBrands() {
  if (_brandsTable) _brandsTable.setLoading(true);
  const data = await AdminAPI.getAdminRibbonBrands();
  _ribbonBrands = data || [];
  if (_brandsTable) _brandsTable.setData(_ribbonBrands);
}

function openBrandModal(brand) {
  const isEdit = !!brand;
  const title = isEdit ? `Edit Brand: ${brand.name}` : 'New Brand';

  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:14px">
      ${formGroup('Name <span class="required-star">*</span>', `<input class="admin-input" id="edit-brand-name" value="${esc(brand?.name || '')}">`)}
      ${formGroup('Slug', `<input class="admin-input" id="edit-brand-slug" value="${esc(brand?.slug || '')}" placeholder="auto-generated from name">`)}
      ${formGroup('Sort Order', `<input class="admin-input" id="edit-brand-order" type="number" value="${brand?.sort_order ?? 0}">`)}
      ${formGroup('Active', toggleHtml('edit-brand-active', brand?.is_active !== false))}
      ${isEdit ? `
        <div class="admin-form-group">
          <label>Brand Image</label>
          <div id="brand-image-preview" style="margin-bottom:8px">
            ${brand.image_url ? `<img src="${esc(brand.image_url)}" style="max-width:120px;max-height:80px;border-radius:var(--radius);border:1px solid var(--border)">` : '<span class="admin-text-muted" style="font-size:13px">No image</span>'}
          </div>
          <input type="file" id="brand-image-upload" accept="image/png,image/jpeg,image/webp,image/gif">
        </div>
      ` : ''}
    </div>
  `;

  let footerHtml = `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`;
  if (isEdit) footerHtml += `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="delete" style="margin-right:auto">Delete</button>`;
  footerHtml += `<button class="admin-btn admin-btn--primary" data-action="save">${isEdit ? 'Save Changes' : 'Create Brand'}</button>`;

  const modal = Modal.open({ title, body: bodyHtml, footer: footerHtml });
  if (!modal) return;

  // Auto-slug from name
  const nameInput = modal.body.querySelector('#edit-brand-name');
  const slugInput = modal.body.querySelector('#edit-brand-slug');
  nameInput.addEventListener('input', () => {
    if (!isEdit || !brand.slug) slugInput.value = slugify(nameInput.value);
  });

  // Image upload
  if (isEdit) {
    const fileInput = modal.body.querySelector('#brand-image-upload');
    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
          Toast.success('Uploading image...');
          const result = await AdminAPI.uploadRibbonBrandImage(brand.id, file);
          if (result?.image_url) {
            brand.image_url = result.image_url;
            modal.body.querySelector('#brand-image-preview').innerHTML =
              `<img src="${esc(result.image_url)}" style="max-width:120px;max-height:80px;border-radius:var(--radius);border:1px solid var(--border)">`;
            Toast.success('Image uploaded');
          }
        } catch (e) {
          Toast.error(`Image upload failed: ${e.message}`);
        }
      });
    }
  }

  // Cancel
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  // Delete
  if (isEdit) {
    modal.footer.querySelector('[data-action="delete"]').addEventListener('click', () => {
      Modal.close();
      Modal.confirm({
        title: 'Delete Brand',
        message: `Are you sure you want to delete "${brand.name}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deleteRibbonBrand(brand.id);
            Toast.success('Brand deleted');
            loadBrands();
          } catch (e) {
            Toast.error(`Delete failed: ${e.message}`);
          }
        },
      });
    });
  }

  // Save
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { Toast.error('Name is required'); nameInput.focus(); return; }
    const slug = slugInput.value.trim() || slugify(name);
    const sort_order = parseInt(modal.body.querySelector('#edit-brand-order').value, 10) || 0;
    const is_active = !!modal.body.querySelector('#edit-brand-active').checked;

    const saveBtn = modal.footer.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';

    try {
      if (isEdit) {
        await AdminAPI.updateRibbonBrand(brand.id, { name, slug, sort_order, is_active });
        Toast.success('Brand updated');
      } else {
        await AdminAPI.createRibbonBrand({ name, slug, sort_order, is_active });
        Toast.success('Brand created');
      }
      Modal.close();
      loadBrands();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Brand';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  PRODUCTS TAB
// ══════════════════════════════════════════════════════════════════════════
function renderProductsTab(container) {
  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'admin-toolbar';

  let brandOpts = '<option value="">All Brands</option>';
  for (const b of _ribbonBrands) {
    brandOpts += `<option value="${esc(b.id)}">${esc(b.name)}</option>`;
  }

  let typeOpts = '<option value="">All Types</option>';
  for (const t of RIBBON_TYPES) {
    typeOpts += `<option value="${esc(t.value)}">${esc(t.label)}</option>`;
  }

  toolbar.innerHTML = `
    <div class="admin-search" style="flex:1;max-width:260px">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" placeholder="Search ribbons\u2026" id="ribbon-product-search">
    </div>
    <select class="admin-select" id="ribbon-brand-filter">${brandOpts}</select>
    <select class="admin-select" id="ribbon-type-filter">${typeOpts}</select>
    <select class="admin-select" id="ribbon-active-filter">
      <option value="">All Status</option>
      <option value="true">Active</option>
      <option value="false">Inactive</option>
    </select>
    <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-ribbon-btn">${icon('plus', 14, 14)} Add Ribbon</button>
  `;
  container.appendChild(toolbar);

  // Bind filters
  const searchInput = toolbar.querySelector('#ribbon-product-search');
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => { _pSearch = searchInput.value.trim(); _pPage = 1; loadRibbonProducts(); }, 300);
  });
  toolbar.querySelector('#ribbon-brand-filter').addEventListener('change', (e) => { _pBrandFilter = e.target.value; _pPage = 1; loadRibbonProducts(); });
  toolbar.querySelector('#ribbon-type-filter').addEventListener('change', (e) => { _pTypeFilter = e.target.value; _pPage = 1; loadRibbonProducts(); });
  toolbar.querySelector('#ribbon-active-filter').addEventListener('change', (e) => { _pActiveFilter = e.target.value; _pPage = 1; loadRibbonProducts(); });
  toolbar.querySelector('#add-ribbon-btn').addEventListener('click', () => openRibbonProductModal(null));

  // Table
  const tableWrap = document.createElement('div');
  container.appendChild(tableWrap);

  _productsTable = new DataTable(tableWrap, {
    columns: buildProductColumns(),
    rowKey: 'id',
    onRowClick: (row) => openRibbonProductModal(row),
    onSort: (key, dir) => { _pSort = key; _pSortDir = dir; loadRibbonProducts(); },
    onPageChange: (page) => { _pPage = page; loadRibbonProducts(); },
    onLimitChange: (limit) => { _pLimit = limit; _pPage = 1; loadRibbonProducts(); },
    emptyMessage: 'No ribbon products found',
  });

  loadRibbonProducts();
}

function buildProductColumns() {
  const isOwner = AdminAuth.isOwner();
  const cols = [
    {
      key: 'image', label: '', className: 'cell-center cell-image',
      render: (r) => {
        const img = r.image_url;
        const url = img && typeof storageUrl === 'function' ? storageUrl(img) : img;
        return url
          ? `<img class="admin-product-thumb" src="${esc(url)}" alt="" loading="lazy">`
          : `<div class="admin-product-thumb admin-product-thumb--empty">${icon('products', 16, 16)}</div>`;
      },
    },
    { key: 'name', label: 'Name', sortable: true, render: (r) => `<span class="cell-truncate">${esc(r.name || MISSING)}</span>` },
    { key: 'sku', label: 'SKU', render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>` },
    {
      key: 'ribbon_brand', label: 'Device Brand', sortable: false,
      render: (r) => {
        const brand = r.ribbon_brands?.name || '';
        return brand ? `<span class="admin-badge admin-badge--processing">${esc(brand)}</span>` : MISSING;
      },
    },
    {
      key: 'product_type', label: 'Type',
      render: (r) => {
        const t = RIBBON_TYPES.find(t => t.value === r.product_type);
        return t ? `<span class="admin-badge admin-badge--info">${esc(t.label)}</span>` : esc(r.product_type || MISSING);
      },
    },
    {
      key: 'retail_price', label: 'Price', sortable: true, align: 'right',
      render: (r) => `<span class="cell-mono cell-right">${r.retail_price != null ? formatPrice(r.retail_price) : MISSING}</span>`,
    },
  ];

  if (isOwner) {
    cols.push({
      key: 'cost_price', label: 'Cost', sortable: true, align: 'right',
      render: (r) => `<span class="cell-mono cell-right">${r.cost_price != null ? formatPrice(r.cost_price) : MISSING}</span>`,
    });
  }

  cols.push({
    key: 'is_active', label: 'Active', align: 'center',
    render: (r) => {
      const active = r.is_active !== false;
      return `<span class="admin-active-dot admin-active-dot--${active ? 'on' : 'off'}"></span>`;
    },
  });

  return cols;
}

async function loadRibbonProducts() {
  if (_productsTable) _productsTable.setLoading(true);
  const result = await AdminAPI.getRibbonProducts({
    search: _pSearch,
    ribbon_brand_id: _pBrandFilter,
    product_type: _pTypeFilter,
    is_active: _pActiveFilter,
    sort: _pSort,
    sortDir: _pSortDir,
    page: _pPage,
    limit: _pLimit,
  });
  if (!_productsTable) return;
  const products = result?.products || [];
  _productsTable.setData(products, result ? { total: result.total, page: result.page, limit: result.limit } : null);
}

// ══════════════════════════════════════════════════════════════════════════
//  PRODUCT EDIT MODAL (full-screen, tabbed — matches Products & SKUs)
// ══════════════════════════════════════════════════════════════════════════
function openRibbonProductModal(product) {
  if (_activeModal) closeRibbonProductModal();
  const isEdit = !!product;
  const isOwner = AdminAuth.isOwner();

  const modal = document.createElement('div');
  modal.className = 'admin-product-modal';
  modal.innerHTML = `
    <div class="admin-product-modal__inner">
      <div class="admin-product-modal__header">
        <button class="admin-product-modal__close" data-action="close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="admin-product-modal__title">${esc(isEdit ? (product.name || product.sku || 'Ribbon') : 'New Ribbon Product')}</div>
        <div class="admin-product-modal__actions">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="cancel">Cancel</button>
          ${isEdit ? `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="delete" style="margin-right:8px">Delete</button>` : ''}
          <button class="admin-btn admin-btn--primary admin-btn--sm" data-action="save">${isEdit ? 'Save Changes' : 'Create Product'}</button>
        </div>
      </div>
      <div class="admin-product-modal__layout">
        <div class="admin-product-modal__sidebar" id="rpm-sidebar">
          <div style="display:flex;align-items:center;justify-content:center;height:120px;background:var(--surface-hover);border-radius:var(--radius);color:var(--text-muted)">
            ${icon('products', 32, 32)}
          </div>
        </div>
        <div class="admin-product-modal__main">
          <div class="admin-product-modal__tabs" id="rpm-tabs"></div>
          <div class="admin-product-modal__tab-panels" id="rpm-panels">
            <div style="padding:40px;text-align:center;color:var(--text-muted)">${isEdit ? 'Loading product\u2026' : ''}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  _activeModal = modal;
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));

  // Close handlers
  modal.querySelector('[data-action="close"]').addEventListener('click', closeRibbonProductModal);
  modal.querySelector('[data-action="cancel"]').addEventListener('click', closeRibbonProductModal);
  const onKeyDown = (e) => { if (e.key === 'Escape' && _activeModal === modal) closeRibbonProductModal(); };
  document.addEventListener('keydown', onKeyDown);
  modal._removeKeyHandler = () => document.removeEventListener('keydown', onKeyDown);

  if (isEdit) {
    // Fetch full product data then build tabs
    AdminAPI.getRibbonProduct(product.id).then(full => {
      if (_activeModal !== modal) return;
      const data = full || product;
      buildRibbonSidebar(modal, data);
      buildRibbonTabs(modal, data, isOwner, true);
      bindRibbonModalActions(modal, data, isOwner, true);
    });
  } else {
    buildRibbonTabs(modal, {}, isOwner, false);
    bindRibbonModalActions(modal, {}, isOwner, false);
  }
}

function closeRibbonProductModal() {
  if (!_activeModal) return;
  _activeModal._removeKeyHandler?.();
  _activeModal._descEditor?.destroy();
  _activeModal.classList.remove('open');
  setTimeout(() => _activeModal?.remove(), 300);
  _activeModal = null;
}

function buildRibbonSidebar(modal, full) {
  const sidebar = modal.querySelector('#rpm-sidebar');
  const img = full.image_url && typeof storageUrl === 'function' ? storageUrl(full.image_url) : full.image_url;
  const active = full.is_active !== false;
  const price = full.retail_price;

  sidebar.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em">
      Image
    </div>
    <div class="admin-product-gallery" id="ribbon-gallery">
      ${img ? `<div class="admin-product-gallery__item"><img src="${esc(img)}" alt="" loading="lazy"></div>` : '<div class="admin-product-gallery__empty">No image</div>'}
    </div>
    <div class="admin-dropzone" id="ribbon-image-dropzone">
      <span>${icon('download', 20, 20)} Drop image or click to upload</span>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" id="ribbon-image-upload" hidden>
    </div>
    <div class="admin-product-modal__sidebar-stats">
      <div class="admin-product-modal__sidebar-stat">
        <span class="admin-badge admin-badge--${active ? 'completed' : 'failed'}">${active ? 'Active' : 'Inactive'}</span>
      </div>
      ${price != null ? `<div class="admin-product-modal__sidebar-stat"><strong>${formatPrice(price)}</strong><span>NZD</span></div>` : ''}
    </div>
  `;

  // Image upload binding
  const dropzone = sidebar.querySelector('#ribbon-image-dropzone');
  const fileInput = sidebar.querySelector('#ribbon-image-upload');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file || !full.id) return;
    try {
      await AdminAPI.uploadProductImage(full.id, file);
      Toast.success('Image uploaded');
      // Refresh
      const updated = await AdminAPI.getRibbonProduct(full.id);
      if (updated) buildRibbonSidebar(modal, updated);
    } catch (e) {
      Toast.error(`Upload failed: ${e.message}`);
    }
  });
}

function buildRibbonTabs(modal, full, isOwner, isEdit) {
  const tabsEl = modal.querySelector('#rpm-tabs');
  const panelsEl = modal.querySelector('#rpm-panels');

  const tabs = ['Basic Info', 'Description', 'Compatibility', 'Related Products', 'Pricing', 'Inventory', 'SEO'];
  tabsEl.innerHTML = tabs.map((t, i) =>
    `<button class="admin-product-modal__tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t)}</button>`
  ).join('');

  // ── Basic Info ──
  const basicHtml = `
    <div class="admin-form-row">
      ${formGroup('SKU <span class="required-star">*</span>', `<input class="admin-input" id="edit-sku" value="${esc(full.sku || '')}">`)}
      ${formGroup('Name <span class="required-star">*</span>', `<input class="admin-input" id="edit-name" value="${esc(full.name || '')}">`)}
    </div>
    <div class="admin-form-row">
      ${formGroup('Product Type', buildSelect('edit-type', RIBBON_TYPES, full.product_type || 'printer_ribbon'))}
      ${formGroup('Device Brand', brandSelect(full.ribbon_brand_id))}
    </div>
    <div class="admin-form-row">
      ${formGroup('Color', `<input class="admin-input" id="edit-color" value="${esc(full.color || '')}">`)}
      ${formGroup('Source', buildSelect('edit-source', ['compatible', 'genuine', 'remanufactured'], full.source || 'compatible'))}
    </div>
  `;

  // ── Description (Rich Text) ──
  const descHtml = `
    <div class="admin-form-group">
      <label>Product Description (Rich Text)</label>
      <div id="desc-editor-mount"></div>
    </div>
  `;

  // ── Compatibility (rich text, same toolbar as description) ──
  const compatHtml = `
    <div class="admin-form-group">
      <label>Compatible Devices</label>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Paste text or HTML listing compatible devices. Formatting is preserved as-is on the product page.</p>
      <div id="compat-editor-mount"></div>
    </div>
  `;

  // ── Related Products ──
  const existingSkus = Array.isArray(full.related_product_skus) ? full.related_product_skus : [];
  const relatedHtml = `
    <div class="admin-form-group">
      <label>Related Products</label>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Search and select products to show in the "Related Products" section on the product page.</p>
      <div style="position:relative;margin-bottom:12px">
        <input class="admin-input" id="related-search" placeholder="Search by name or SKU\u2026" autocomplete="off">
        <div id="related-search-results" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:var(--surface);border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:240px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.15)"></div>
      </div>
      <div id="related-selected" style="display:flex;flex-direction:column;gap:6px"></div>
      <input type="hidden" id="edit-related-skus" value="${esc(existingSkus.join(','))}">
    </div>
  `;

  // ── Pricing ──
  let pricingHtml = `
    <div class="admin-form-row">
      ${formGroup('Retail Price (NZD) <span class="required-star">*</span>', `<input class="admin-input" id="edit-retail-price" type="number" step="0.01" value="${full.retail_price ?? ''}">`)}
      ${formGroup('Compare Price', `<input class="admin-input" id="edit-compare-price" type="number" step="0.01" value="${full.compare_at_price || full.compare_price || ''}">`)}
    </div>
    ${isOwner ? formGroup('Supplier Price', `<input class="admin-input" id="edit-cost-price" type="number" step="0.01" value="${full.cost_price ?? ''}">`) : ''}
  `;

  // ── Inventory ──
  const inventoryHtml = `
    <div class="admin-form-row">
      ${formGroup('Weight (kg)', `<input class="admin-input" id="edit-weight" type="number" step="0.01" min="0" value="${full.weight_kg ?? ''}">`)}
      <div class="admin-form-group"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Active', toggleHtml('edit-active', full.is_active !== false))}
      <div class="admin-form-group"></div>
    </div>
  `;

  // ── SEO ──
  const seoHtml = `
    ${formGroup('Meta Title', `<input class="admin-input" id="edit-meta-title" value="${esc(full.meta_title || '')}">`)}
    ${formGroup('Meta Description', `<textarea class="admin-textarea" id="edit-meta-desc" rows="3">${esc(full.meta_description || '')}</textarea>`)}
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" value="${esc((Array.isArray(full.tags) ? full.tags : []).join(', '))}">`)}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3">${esc(full.internal_notes || '')}</textarea>`)}
  `;

  const panelContents = [basicHtml, descHtml, compatHtml, relatedHtml, pricingHtml, inventoryHtml, seoHtml];
  panelsEl.innerHTML = panelContents.map((content, i) =>
    `<div class="admin-product-modal__tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${content}</div>`
  ).join('');

  // Tab switching
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-product-modal__tab');
    if (!btn) return;
    const idx = btn.dataset.tab;
    tabsEl.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    panelsEl.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  });

  // Mount rich text editors
  const editorMount = modal.querySelector('#desc-editor-mount');
  if (editorMount) {
    const editor = new RichTextEditor(editorMount, {
      initialValue: full.description_html || '',
      placeholder: 'Enter product description with formatting\u2026',
      minHeight: 200,
    });
    modal._descEditor = editor;
  }

  const compatMount = modal.querySelector('#compat-editor-mount');
  if (compatMount) {
    const compatEditor = new RichTextEditor(compatMount, {
      initialValue: full.compatible_devices_html || '',
      placeholder: 'Paste or type compatible devices\u2026',
      minHeight: 200,
    });
    modal._compatEditor = compatEditor;
  }

  // Mount Related Products search & selection
  initRelatedProductsPicker(modal, existingSkus);
}

async function initRelatedProductsPicker(modal, initialSkus) {
  const searchInput = modal.querySelector('#related-search');
  const resultsEl = modal.querySelector('#related-search-results');
  const selectedEl = modal.querySelector('#related-selected');
  const hiddenInput = modal.querySelector('#edit-related-skus');
  if (!searchInput || !resultsEl || !selectedEl || !hiddenInput) return;

  const selectedSkus = [...initialSkus];

  const syncHidden = () => { hiddenInput.value = selectedSkus.join(','); };

  const renderSelectedItem = (p) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface-raised, #f5f5f5);border:1px solid var(--border);border-radius:6px;';
    row.dataset.sku = p.sku;
    const img = p.image_url ? `<img src="${esc(p.image_url)}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;flex-shrink:0" onerror="this.style.display='none'">` : '';
    row.innerHTML = `
      ${img}
      <span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name || p.sku)}</span>
      <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(p.sku)}</span>
      <button type="button" style="background:none;border:none;cursor:pointer;color:var(--danger, #e53e3e);font-size:16px;padding:0 4px;line-height:1" title="Remove">&times;</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      const idx = selectedSkus.indexOf(p.sku);
      if (idx !== -1) selectedSkus.splice(idx, 1);
      row.remove();
      syncHidden();
    });
    return row;
  };

  // Load existing selected products
  if (initialSkus.length > 0) {
    try {
      const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
      if (sb) {
        const { data: products } = await sb.from('products').select('sku, name, image_url').in('sku', initialSkus);
        if (products) {
          const bysku = {};
          products.forEach(p => { bysku[p.sku] = p; });
          initialSkus.forEach(sku => {
            const p = bysku[sku];
            if (p) selectedEl.appendChild(renderSelectedItem(p));
          });
        }
      }
    } catch (_) {}
  }

  let debounceTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { resultsEl.style.display = 'none'; return; }
    debounceTimer = setTimeout(() => searchProducts(q), 300);
  });

  searchInput.addEventListener('blur', () => {
    setTimeout(() => { resultsEl.style.display = 'none'; }, 200);
  });

  async function searchProducts(q) {
    try {
      const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
      if (!sb) return;
      const { data: results } = await sb.from('products')
        .select('sku, name, image_url, retail_price')
        .or(`name.ilike.%${q}%,sku.ilike.%${q}%`)
        .eq('is_active', true)
        .limit(15);
      if (!results?.length) {
        resultsEl.innerHTML = '<div style="padding:10px;font-size:13px;color:var(--text-muted)">No products found</div>';
        resultsEl.style.display = 'block';
        return;
      }
      resultsEl.innerHTML = results.map(p => {
        const alreadyAdded = selectedSkus.includes(p.sku);
        const img = p.image_url ? `<img src="${esc(p.image_url)}" style="width:28px;height:28px;object-fit:contain;border-radius:3px;flex-shrink:0" onerror="this.style.display='none'">` : '<div style="width:28px"></div>';
        return `<div class="related-search-item" data-sku="${esc(p.sku)}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:${alreadyAdded ? 'default' : 'pointer'};opacity:${alreadyAdded ? '0.5' : '1'};border-bottom:1px solid var(--border-light, #eee);font-size:13px;${alreadyAdded ? '' : ''}" ${alreadyAdded ? 'data-added' : ''}>
          ${img}
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name || p.sku)}</span>
          <span style="font-size:11px;color:var(--text-muted);flex-shrink:0">${esc(p.sku)}</span>
          ${alreadyAdded ? '<span style="font-size:10px;color:var(--text-muted)">Added</span>' : ''}
        </div>`;
      }).join('');
      resultsEl.style.display = 'block';

      resultsEl.querySelectorAll('.related-search-item:not([data-added])').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const sku = item.dataset.sku;
          if (selectedSkus.includes(sku)) return;
          const p = results.find(r => r.sku === sku);
          if (!p) return;
          selectedSkus.push(sku);
          selectedEl.appendChild(renderSelectedItem(p));
          syncHidden();
          item.style.opacity = '0.5';
          item.style.cursor = 'default';
          item.setAttribute('data-added', '');
          item.insertAdjacentHTML('beforeend', '<span style="font-size:10px;color:var(--text-muted)">Added</span>');
        });
      });
    } catch (_) {}
  }
}

function bindRibbonModalActions(modal, product, isOwner, isEdit) {
  const val = (id) => modal.querySelector(`#${id}`)?.value?.trim() ?? '';
  const chk = (id) => !!modal.querySelector(`#${id}`)?.checked;

  const switchToTab = (tabIdx) => {
    const idx = String(tabIdx);
    modal.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    modal.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  };

  const requireField = (fieldId, tabIdx, message) => {
    const el = modal.querySelector(`#${fieldId}`);
    if (!el) return false;
    if (el.value.trim()) { el.style.borderColor = ''; return false; }
    switchToTab(tabIdx);
    el.style.borderColor = 'var(--danger)';
    el.focus();
    if (!el.nextElementSibling?.classList?.contains('field-error')) {
      const err = document.createElement('div');
      err.className = 'field-error';
      err.style.cssText = 'font-size:11px;color:var(--danger);margin-top:4px';
      err.textContent = message;
      el.after(err);
    }
    el.addEventListener('input', () => {
      el.style.borderColor = '';
      if (el.nextElementSibling?.classList?.contains('field-error')) el.nextElementSibling.remove();
    }, { once: true });
    return true;
  };

  // Delete
  if (isEdit) {
    modal.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      Modal.confirm({
        title: 'Delete Ribbon Product',
        message: `Delete "${product.name || product.sku}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deleteRibbonProduct(product.id);
            Toast.success('Product deleted');
            closeRibbonProductModal();
            loadRibbonProducts();
          } catch (e) {
            Toast.error(`Delete failed: ${e.message}`);
          }
        },
      });
    });
  }

  // Save
  modal.querySelector('[data-action="save"]').addEventListener('click', async () => {
    // Validate
    if (requireField('edit-sku', 0, 'SKU is required')) return;
    if (requireField('edit-name', 0, 'Name is required')) return;
    const retailPrice = parseFloat(val('edit-retail-price'));
    if (!retailPrice || retailPrice <= 0) {
      requireField('edit-retail-price', 4, 'A valid retail price is required');
      return;
    }

    const tagsRaw = val('edit-tags');
    const relatedRaw = val('edit-related-skus');
    const data = {
      sku: val('edit-sku'),
      name: val('edit-name'),
      product_type: val('edit-type') || 'printer_ribbon',
      ribbon_brand_id: val('edit-ribbon-brand') || null,
      color: val('edit-color') || null,
      source: val('edit-source') || 'compatible',
      retail_price: retailPrice,
      compare_price: parseFloat(val('edit-compare-price')) || null,
      weight_kg: parseFloat(val('edit-weight')) || null,
      is_active: chk('edit-active'),
      meta_title: val('edit-meta-title') || null,
      meta_description: val('edit-meta-desc') || null,
      tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
      internal_notes: val('edit-admin-notes') || null,
      description_html: modal._descEditor?.getValue() || null,
      compatible_devices_html: modal._compatEditor?.getValue() || null,
      related_product_skus: relatedRaw ? relatedRaw.split(',').filter(Boolean) : [],
    };
    if (isOwner) data.cost_price = parseFloat(val('edit-cost-price')) || null;

    const saveBtn = modal.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    saveBtn.textContent = isEdit ? 'Saving\u2026' : 'Creating\u2026';

    try {
      if (isEdit) {
        await AdminAPI.updateRibbonProduct(product.id, data);
        Toast.success('Product updated');
      } else {
        await AdminAPI.createRibbonProduct(data);
        Toast.success('Product created');
      }
      saveBtn.disabled = false;
      saveBtn.innerHTML = isEdit ? `${icon('orders', 14, 14)} Save Changes` : `${icon('orders', 14, 14)} Create Product`;
      loadRibbonProducts();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.innerHTML = isEdit ? `${icon('orders', 14, 14)} Save Changes` : `${icon('orders', 14, 14)} Create Product`;
    }
  });

  // Enter key triggers save (except in textareas and contentEditable)
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
      e.preventDefault();
      modal.querySelector('[data-action="save"]')?.click();
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  PAGE EXPORT
// ══════════════════════════════════════════════════════════════════════════
export default {
  title: 'Ribbons',

  async init(container) {
    _container = container;
    _tab = 'products';
    _pSearch = '';
    _pBrandFilter = '';
    _pTypeFilter = '';
    _pActiveFilter = '';
    _pSort = 'name';
    _pSortDir = 'asc';
    _pPage = 1;

    FilterState.showBar(false);

    // Load brands first (needed for product filter dropdowns)
    const brands = await AdminAPI.getAdminRibbonBrands();
    if (_container !== container) return;
    _ribbonBrands = brands || [];

    renderShell();
  },

  destroy() {
    if (_activeModal) closeRibbonProductModal();
    if (_brandsTable) { _brandsTable.destroy(); _brandsTable = null; }
    if (_productsTable) { _productsTable.destroy(); _productsTable = null; }
    _container = null;
    _ribbonBrands = [];
  },

  onSearch(query) {
    if (_tab === 'products') {
      _pSearch = query;
      _pPage = 1;
      const input = document.getElementById('ribbon-product-search');
      if (input) input.value = query;
      loadRibbonProducts();
    }
  },
};
