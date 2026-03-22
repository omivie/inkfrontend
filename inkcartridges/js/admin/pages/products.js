/**
 * Products & SKUs Page — Full CRUD with image management
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

/** Extract a brand name string from a product object, handling all API shapes */
function extractBrandName(p) {
  const raw = p.brand_name || p.brand || '';
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return raw.name || raw.brand || raw.brand_name || '';
  return String(raw);
}

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _sort = 'name';
let _sortDir = 'asc';
let _brandFilter = '';
let _activeFilter = '';
let _imageFilter = '';
let _brands = [];
let _diagnostics = null;
let _bulkBar = null;

function stockBadge(product) {
  const qty = product.stock_quantity;
  if (qty == null) return `<span class="admin-badge admin-badge--pending">Unknown</span>`;
  if (qty <= 0) return `<span class="admin-badge admin-badge--failed">Out of stock</span>`;
  if (product.is_low_stock || (product.low_stock_threshold && qty <= product.low_stock_threshold))
    return `<span class="admin-badge admin-badge--pending">Low (${qty})</span>`;
  return `<span class="admin-badge admin-badge--completed">In stock (${qty})</span>`;
}

function buildColumns() {
  const isOwner = AdminAuth.isOwner();
  const cols = [
    {
      key: 'images', label: '',
      render: (r) => {
        const img = r.images?.[0] || r.primary_image || r.image_url;
        if (img) {
          const raw = typeof img === 'string' ? img : img.image_url || img.url || img.thumbnail_url || (img.path && typeof storageUrl === 'function' ? storageUrl(img.path) : img.path);
          return `<img class="admin-product-thumb" src="${esc(raw || '')}" alt="" loading="lazy">`;
        }
        return `<div class="admin-product-thumb admin-product-thumb--empty">${icon('products', 16, 16)}</div>`;
      },
      className: 'cell-center cell-image',
    },
    {
      key: 'name', label: 'Name', sortable: true,
      render: (r) => `<button class="copy-name-btn" data-copy="${esc(r.name || '')}" title="Copy name">${icon('copy', 15, 15)}</button><span class="cell-truncate">${esc(r.name || MISSING)}</span>`,
    },
    {
      key: 'sku', label: 'SKU',
      render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>`,
    },
    {
      key: 'brand', label: 'Brand', sortable: true,
      render: (r) => {
        const brand = extractBrandName(r);
        return brand ? `<span class="admin-badge admin-badge--processing">${esc(brand)}</span>` : MISSING;
      },
    },
    {
      key: 'retail_price', label: 'Price', sortable: true,
      render: (r) => {
        const price = r.retail_price ?? r.cost_price;
        return `<span class="cell-mono cell-right">${price != null ? formatPrice(price) : MISSING}</span>`;
      },
      align: 'right',
    },
  ];

  if (isOwner) {
    cols.push({
      key: 'cost_price', label: 'Cost', sortable: true,
      render: (r) => `<span class="cell-mono cell-right">${r.cost_price != null ? formatPrice(r.cost_price) : MISSING}</span>`,
      align: 'right',
    });
  }

  cols.push(
    {
      key: 'stock_quantity', label: 'Stock', sortable: true,
      render: (r) => {
        const qty = r.stock_quantity;
        const isLow = r.is_low_stock || (r.low_stock_threshold && qty <= r.low_stock_threshold);
        const color = qty <= 0 ? 'var(--danger)' : isLow ? 'var(--yellow)' : 'var(--text)';
        return `<span class="cell-mono cell-center" style="color:${color}">${qty != null ? qty : MISSING}</span>`;
      },
      align: 'center',
    },
    {
      key: 'status', label: 'Status',
      render: (r) => stockBadge(r),
    },
    {
      key: 'is_active', label: 'Active',
      render: (r) => {
        const active = r.is_active !== false;
        return `<span class="admin-active-dot admin-active-dot--${active ? 'on' : 'off'}" data-tooltip="${active ? 'Active' : 'Inactive'}"></span>`;
      },
      align: 'center',
    },
    {
      key: 'compat', label: 'Compat', sortable: false,
      render: (r) => `<span class="admin-text-muted" data-compat-sku="${esc(r.sku || '')}" style="font-size:0.75rem;">—</span>`,
      align: 'center',
    },
  );

  return cols;
}

async function loadCompatCounts() {
  const cells = document.querySelectorAll('[data-compat-sku]');
  if (!cells.length) return;
  const batch = 5;
  const arr = Array.from(cells);
  for (let i = 0; i < arr.length; i += batch) {
    const slice = arr.slice(i, i + batch);
    await Promise.all(slice.map(async (cell) => {
      const sku = cell.dataset.compatSku;
      if (!sku) return;
      try {
        const res = await window.API.getCompatiblePrinters(sku);
        const printers = res?.data?.compatible_printers || res?.data?.printers || [];
        const count = Array.isArray(printers) ? printers.length : 0;
        if (count > 0) {
          cell.outerHTML = `<span class="admin-badge admin-badge--delivered" style="font-size:0.72rem;">${count} printer${count !== 1 ? 's' : ''}</span>`;
        } else {
          cell.outerHTML = `<span class="admin-badge admin-badge--pending" style="font-size:0.72rem;">⚠ None</span>`;
        }
      } catch {
        cell.outerHTML = `<span class="admin-text-muted" style="font-size:0.72rem;">—</span>`;
      }
    }));
    if (i + batch < arr.length) await new Promise(r => setTimeout(r, 100));
  }
}

function productHasImage(p) {
  if (p.images && p.images.length > 0) return true;
  if (p.primary_image || p.image_url) return true;
  return false;
}

async function loadProducts() {
  _table.setLoading(true);
  const filters = { search: _search, sort: _sort, order: _sortDir };
  if (_brandFilter) filters.brand = _brandFilter;
  if (_activeFilter !== '') filters.active = _activeFilter;

  // When image filter is active, we need to paginate client-side since
  // the backend doesn't support filtering by image presence
  if (_imageFilter) {
    const PAGE_SIZE = 100;
    let all = [];
    let page = 1;
    // Fetch all matching products (respecting other filters)
    while (true) {
      const data = await AdminAPI.getProducts(filters, page, 200);
      if (!_table) return; // destroyed during await
      const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
      if (!rows.length) break;
      all = all.concat(rows);
      const total = data?.pagination?.total || data?.total;
      if (total && all.length >= total) break;
      if (rows.length < 200) break;
      page++;
    }
    // Apply image filter
    const filtered = all.filter(p =>
      _imageFilter === 'no-images' ? !productHasImage(p) : productHasImage(p)
    );
    // Client-side pagination
    const start = (_page - 1) * PAGE_SIZE;
    const pageRows = filtered.slice(start, start + PAGE_SIZE);
    _table.setData(pageRows, { total: filtered.length, page: _page, limit: PAGE_SIZE });
    loadCompatCounts();
    return;
  }

  const data = await AdminAPI.getProducts(filters, _page, 200);
  if (!_table) return; // destroyed during await
  if (!data) { _table.setData([], null); return; }
  const rows = Array.isArray(data) ? data : (data.products || data.data || []);
  const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: 200 };
  _table.setData(rows, pagination);
  loadCompatCounts();
}

let _activeModal = null;

function closeProductModal() {
  if (!_activeModal) return;
  const modal = _activeModal;
  _activeModal = null;
  modal.classList.remove('open');
  setTimeout(() => modal.remove(), 220);
}

async function openProductDrawer(product) {
  // Close any existing modal first
  if (_activeModal) closeProductModal();

  // Build modal shell immediately (loading state)
  const modal = document.createElement('div');
  modal.className = 'admin-product-modal';
  modal.innerHTML = `
    <div class="admin-product-modal__inner">
      <div class="admin-product-modal__header">
        <button class="admin-product-modal__close" data-action="close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="admin-product-modal__title">${esc(product.name || product.sku || 'Product')}</div>
        <div class="admin-product-modal__actions">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="cancel">Cancel</button>
          <button class="admin-btn admin-btn--primary admin-btn--sm" data-action="save">${icon('orders', 14, 14)} Save Changes</button>
        </div>
      </div>
      <div class="admin-product-modal__layout">
        <div class="admin-product-modal__sidebar" id="pm-sidebar">
          <div style="display:flex;align-items:center;justify-content:center;height:120px;background:var(--surface-hover);border-radius:var(--radius);color:var(--text-muted)">
            ${icon('products', 32, 32)}
          </div>
          <div class="admin-product-modal__sidebar-stats">
            <div class="admin-product-modal__sidebar-stat"><span>Loading&hellip;</span></div>
          </div>
        </div>
        <div class="admin-product-modal__main">
          <div class="admin-product-modal__tabs" id="pm-tabs"></div>
          <div class="admin-product-modal__tab-panels" id="pm-panels">
            <div style="padding:40px;text-align:center;color:var(--text-muted)">Loading product&hellip;</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  _activeModal = modal;

  // Trigger open animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => modal.classList.add('open'));
  });

  // Wire close handlers immediately
  modal.querySelector('[data-action="close"]').addEventListener('click', closeProductModal);

  // Escape key
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && _activeModal === modal) {
      closeProductModal();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  document.addEventListener('keydown', onKeyDown);
  modal._removeKeyHandler = () => document.removeEventListener('keydown', onKeyDown);

  // Fetch full product data
  const full = await AdminAPI.getProduct(product.id) || product;
  const isOwner = AdminAuth.isOwner();

  // Update title with full name
  modal.querySelector('.admin-product-modal__title').textContent = full.name || full.sku || 'Product';

  // Build sidebar
  buildProductModalSidebar(modal, full);

  // Build tabbed content
  buildProductModalTabs(modal, full, isOwner);

  // Wire action buttons
  bindProductModalActions(modal, full);
}

function openCreateProductModal() {
  if (_activeModal) closeProductModal();

  const isOwner = AdminAuth.isOwner();
  const modal = document.createElement('div');
  modal.className = 'admin-product-modal';
  modal.innerHTML = `
    <div class="admin-product-modal__inner">
      <div class="admin-product-modal__header">
        <button class="admin-product-modal__close" data-action="close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="admin-product-modal__title">New Product</div>
        <div class="admin-product-modal__actions">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="cancel">Cancel</button>
          <button class="admin-btn admin-btn--primary admin-btn--sm" data-action="create">${icon('products', 14, 14)} Create Product</button>
        </div>
      </div>
      <div class="admin-product-modal__layout">
        <div class="admin-product-modal__sidebar" id="pm-sidebar">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:140px;background:var(--surface-hover);border-radius:var(--radius);color:var(--text-muted)">
            ${icon('products', 36, 36)}
            <span style="font-size:12px">Images can be added after creation</span>
          </div>
        </div>
        <div class="admin-product-modal__main">
          <div class="admin-product-modal__tabs" id="pm-tabs"></div>
          <div class="admin-product-modal__tab-panels" id="pm-panels"></div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  _activeModal = modal;

  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));

  const closeCreate = () => {
    modal._removeKeyHandler?.();
    modal.classList.remove('open');
    setTimeout(() => modal.remove(), 300);
    if (_activeModal === modal) _activeModal = null;
  };

  modal.querySelector('[data-action="close"]').addEventListener('click', closeCreate);
  modal.querySelector('[data-action="cancel"]').addEventListener('click', closeCreate);

  const onKeyDown = (e) => { if (e.key === 'Escape' && _activeModal === modal) { closeCreate(); document.removeEventListener('keydown', onKeyDown); } };
  document.addEventListener('keydown', onKeyDown);
  modal._removeKeyHandler = () => document.removeEventListener('keydown', onKeyDown);

  // Build tabs (Basic Info, Pricing, Inventory, SEO, Advanced — no Compatibility/FAQ)
  const tabsEl = modal.querySelector('#pm-tabs');
  const panelsEl = modal.querySelector('#pm-panels');
  const tabNames = ['Basic Info', 'Pricing', 'Inventory', 'SEO', 'Advanced'];
  const empty = {};

  tabsEl.innerHTML = tabNames.map((t, i) =>
    `<button class="admin-product-modal__tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t)}</button>`
  ).join('');

  const basicHtml = `
    <div class="admin-form-row">
      <div class="admin-form-group"><label>SKU<span class="required-star">*</span></label><input class="admin-input" id="edit-sku" placeholder="e.g. LC-3317BK"></div>
      <div class="admin-form-group"><label>Name<span class="required-star">*</span></label><input class="admin-input" id="edit-name" placeholder="Product name"></div>
    </div>
    ${formGroup('Description', `<textarea class="admin-textarea" id="edit-description" rows="4" placeholder="Optional product description\u2026"></textarea>`)}
    <div class="admin-form-row">
      ${formGroup('Brand', buildBrandSelect(null))}
      ${formGroup('Product Type', buildSelect('edit-type', [
        { value: 'ink_cartridge',   label: 'Ink Cartridge' },
        { value: 'ink_bottle',      label: 'Ink Bottle' },
        { value: 'toner_cartridge', label: 'Toner Cartridge' },
        { value: 'drum_unit',       label: 'Drum Unit' },
        { value: 'waste_toner',     label: 'Waste Toner' },
        { value: 'belt_unit',       label: 'Belt Unit' },
        { value: 'fuser_kit',       label: 'Fuser Kit' },
        { value: 'fax_film',        label: 'Fax Film' },
        { value: 'fax_film_refill', label: 'Fax Film Refill' },
        { value: 'ribbon',          label: 'Ribbon' },
        { value: 'label_tape',      label: 'Label Tape' },
        { value: 'photo_paper',     label: 'Photo Paper' },
        { value: 'printer',         label: 'Printer' },
      ], empty.product_type))}
    </div>
    <div class="admin-form-row">
      ${formGroup('Color', `<input class="admin-input" id="edit-color" placeholder="e.g. Black">`)}
      ${formGroup('Source', buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], empty.source))}
    </div>
  `;

  const pricingHtml = `
    <div class="admin-form-row">
      <div class="admin-form-group"><label>Retail Price (NZD)<span class="required-star">*</span></label><input class="admin-input" id="edit-retail-price" type="number" step="0.01" placeholder="0.00"></div>
      ${formGroup('Compare Price', `<input class="admin-input" id="edit-compare-price" type="number" step="0.01" placeholder="0.00">`)}
    </div>
    ${isOwner ? formGroup('Supplier Price', `<input class="admin-input" id="edit-cost-price" type="number" step="0.01" placeholder="0.00">`) : ''}
  `;

  const inventoryHtml = `
    <div class="admin-form-row">
      ${formGroup('Stock Qty', `<input class="admin-input" id="edit-stock" type="number" min="0" placeholder="0">`)}
      ${formGroup('Low Stock Threshold', `<input class="admin-input" id="edit-low-threshold" type="number" min="0" placeholder="5">`)}
    </div>
    <div class="admin-form-row">
      ${formGroup('Weight (kg)', `<input class="admin-input" id="edit-weight" type="number" step="0.01" min="0" placeholder="0.00">`)}
      <div class="admin-form-group"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Active', toggleHtml('edit-active', true))}
      ${formGroup('Track Inventory', toggleHtml('edit-track-inventory', true))}
    </div>
  `;

  const seoHtml = `
    ${formGroup('Meta Title', `<input class="admin-input" id="edit-meta-title" placeholder="Page title for search results">`)}
    ${formGroup('Meta Description', `<textarea class="admin-textarea" id="edit-meta-desc" rows="3" placeholder="Brief description for search results\u2026"></textarea>`)}
  `;

  const advancedHtml = `
    ${formGroup('Page Yield', `<input class="admin-input" id="edit-page-yield" type="number" min="0" placeholder="e.g. 300">`)}
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" placeholder="e.g. black, compatible, brother">`)}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3" placeholder="Notes visible only to admins\u2026"></textarea>`)}
  `;

  panelsEl.innerHTML = [basicHtml, pricingHtml, inventoryHtml, seoHtml, advancedHtml].map((content, i) =>
    `<div class="admin-product-modal__tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${content}</div>`
  ).join('');

  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-product-modal__tab');
    if (!btn) return;
    const idx = btn.dataset.tab;
    tabsEl.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    panelsEl.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  });

  const switchToTab = (tabIdx) => {
    const idx = String(tabIdx);
    tabsEl.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    panelsEl.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  };

  const requireField = (fieldId, tabIdx, message) => {
    const el = modal.querySelector(`#${fieldId}`);
    if (!el) return false;
    if (el.value.trim()) { el.style.borderColor = ''; el.nextElementSibling?.remove(); return false; }
    switchToTab(tabIdx);
    el.style.borderColor = 'var(--danger)';
    el.focus();
    if (!el.nextElementSibling || !el.nextElementSibling.classList.contains('field-error')) {
      const err = document.createElement('div');
      err.className = 'field-error';
      err.style.cssText = 'font-size:11px;color:var(--danger);margin-top:4px';
      err.textContent = message;
      el.after(err);
    }
    el.addEventListener('input', () => {
      el.style.borderColor = '';
      el.nextElementSibling?.classList.contains('field-error') && el.nextElementSibling.remove();
    }, { once: true });
    return true;
  };

  modal.querySelector('[data-action="create"]').addEventListener('click', async () => {
    const val = (id) => modal.querySelector(`#${id}`)?.value?.trim() ?? '';
    const chk = (id) => !!modal.querySelector(`#${id}`)?.checked;

    // Validate required fields — redirect user to the tab containing the missing field
    if (requireField('edit-sku', 0, 'SKU is required')) return;
    if (requireField('edit-name', 0, 'Product name is required')) return;
    const retailPrice = parseFloat(val('edit-retail-price'));
    if (!retailPrice || retailPrice <= 0) {
      requireField('edit-retail-price', 1, 'A valid retail price is required');
      return;
    }

    const sku = val('edit-sku');
    const name = val('edit-name');
    const tagsRaw = val('edit-tags');
    const data = {
      sku,
      name,
      description: val('edit-description') || null,
      brand_id: val('edit-brand') || null,
      product_type: val('edit-type') || null,
      color: val('edit-color') || null,
      source: val('edit-source') || null,
      retail_price: retailPrice,
      compare_at_price: parseFloat(val('edit-compare-price')) || null,
      stock_quantity: parseInt(val('edit-stock'), 10) || 0,
      low_stock_threshold: parseInt(val('edit-low-threshold'), 10) || null,
      weight_kg: parseFloat(val('edit-weight')) || null,
      is_active: chk('edit-active'),
      track_inventory: chk('edit-track-inventory'),
      meta_title: val('edit-meta-title') || null,
      meta_description: val('edit-meta-desc') || null,
      page_yield: parseInt(val('edit-page-yield'), 10) || null,
      tags: tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [],
      internal_notes: val('edit-admin-notes') || null,
    };
    if (isOwner) data.cost_price = parseFloat(val('edit-cost-price')) || null;

    const saveBtn = modal.querySelector('[data-action="create"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating\u2026';

    try {
      const result = await AdminAPI.createProduct(data);
      const newProduct = result?.product ?? result;
      closeCreate();
      Toast.success('Product created');
      loadProducts();
      if (newProduct?.id) openProductDrawer(newProduct);
    } catch (e) {
      Toast.error(`Create failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.innerHTML = `${icon('products', 14, 14)} Create Product`;
    }
  });
}

function buildProductModalSidebar(modal, full) {
  const sidebar = modal.querySelector('#pm-sidebar');

  // Build image list
  let images = full.images || [];
  if (!images.length) {
    const fallback = full.primary_image || full.image_url || '';
    const fbRaw = typeof fallback === 'object' ? (fallback.image_url || fallback.url || (fallback.path && typeof storageUrl === 'function' ? storageUrl(fallback.path) : fallback.path) || '') : fallback;
    if (fbRaw) images = [{ image_url: fbRaw, id: '' }];
  }

  let galleryHtml = `<div class="admin-product-gallery" id="product-gallery">`;
  if (images.length) {
    for (const img of images) {
      const rawPath = typeof img === 'string' ? img : img.image_url || img.url || img.thumbnail_url || (img.path && typeof storageUrl === 'function' ? storageUrl(img.path) : img.path) || '';
      const imgId = typeof img === 'object' ? (img.id || img.image_id || '') : '';
      if (!rawPath) continue;
      galleryHtml += `<div class="admin-product-gallery__item" data-image-id="${esc(String(imgId))}" data-image-url="${esc(rawPath)}">`;
      galleryHtml += `<img src="${esc(rawPath)}" alt="${esc((typeof img === 'object' ? img.alt_text : '') || full.name || '')}" loading="lazy" data-fallback="broken-parent">`;
      galleryHtml += `<button class="admin-product-gallery__delete" data-delete-image="${esc(String(imgId))}" title="Remove image"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
      galleryHtml += `</div>`;
    }
  } else {
    galleryHtml += `<div class="admin-product-gallery__empty">No images yet</div>`;
  }
  galleryHtml += `</div>`;

  // Quick stats
  const active = full.is_active !== false;
  const qty = full.stock_quantity;
  const price = full.retail_price;
  const statsHtml = `
    <div class="admin-product-modal__sidebar-stats">
      <div class="admin-product-modal__sidebar-stat">
        <span class="admin-badge admin-badge--${active ? 'completed' : 'failed'}">${active ? 'Active' : 'Inactive'}</span>
      </div>
      ${qty != null ? `<div class="admin-product-modal__sidebar-stat"><strong>${qty}</strong><span>in stock</span></div>` : ''}
      ${price != null ? `<div class="admin-product-modal__sidebar-stat"><strong>${formatPrice(price)}</strong><span>NZD</span></div>` : ''}
    </div>
  `;

  sidebar.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em">
      Images
    </div>
    ${galleryHtml}
    <div class="admin-dropzone" id="image-dropzone">
      <span>${icon('download', 20, 20)} Drop images or click to upload</span>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple id="image-upload" hidden>
    </div>
    ${statsHtml}
  `;
}

function buildProductModalTabs(modal, full, isOwner) {
  const tabsEl = modal.querySelector('#pm-tabs');
  const panelsEl = modal.querySelector('#pm-panels');

  const tabs = ['Basic Info', 'Pricing', 'Inventory', 'SEO', 'Advanced', 'Compatibility', 'FAQ'];
  tabsEl.innerHTML = tabs.map((t, i) =>
    `<button class="admin-product-modal__tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t)}</button>`
  ).join('');

  // Basic Info panel
  let basicHtml = `
    <div class="admin-form-row">
      ${formGroup('SKU', `<input class="admin-input" id="edit-sku" value="${esc(full.sku || '')}">`)}
      ${formGroup('Name', `<input class="admin-input" id="edit-name" value="${esc(full.name || '')}">`)}
    </div>
    ${formGroup('Description', `<textarea class="admin-textarea" id="edit-description" rows="4">${esc(full.description || '')}</textarea>`)}
    <div class="admin-form-row">
      ${formGroup('Brand', buildBrandSelect(full.brand_id || full.brand))}
      ${formGroup('Product Type', buildSelect('edit-type', [
        { value: 'ink_cartridge',   label: 'Ink Cartridge' },
        { value: 'ink_bottle',      label: 'Ink Bottle' },
        { value: 'toner_cartridge', label: 'Toner Cartridge' },
        { value: 'drum_unit',       label: 'Drum Unit' },
        { value: 'waste_toner',     label: 'Waste Toner' },
        { value: 'belt_unit',       label: 'Belt Unit' },
        { value: 'fuser_kit',       label: 'Fuser Kit' },
        { value: 'fax_film',        label: 'Fax Film' },
        { value: 'fax_film_refill', label: 'Fax Film Refill' },
        { value: 'ribbon',          label: 'Ribbon' },
        { value: 'label_tape',      label: 'Label Tape' },
        { value: 'photo_paper',     label: 'Photo Paper' },
        { value: 'printer',         label: 'Printer' },
      ], full.product_type))}
    </div>
    <div class="admin-form-row">
      ${formGroup('Color', `<input class="admin-input" id="edit-color" value="${esc(full.color || '')}">`)}
      ${formGroup('Source', buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], full.source))}
    </div>
  `;

  // Pricing panel
  let pricingHtml = `
    <div class="admin-form-row">
      ${formGroup('Retail Price', `<input class="admin-input" id="edit-retail-price" type="number" step="0.01" value="${full.retail_price || ''}">`)}
      ${formGroup('Compare Price', `<input class="admin-input" id="edit-compare-price" type="number" step="0.01" value="${full.compare_at_price || full.compare_price || ''}">`)}
    </div>
    ${isOwner ? formGroup('Supplier Price', `<input class="admin-input" id="edit-cost-price" type="number" step="0.01" value="${full.cost_price || ''}">`) : ''}
  `;

  // Inventory panel
  let inventoryHtml = `
    <div class="admin-form-row">
      ${formGroup('Stock Qty', `<input class="admin-input" id="edit-stock" type="number" min="0" value="${full.stock_quantity ?? ''}">`)}
      ${formGroup('Low Stock Threshold', `<input class="admin-input" id="edit-low-threshold" type="number" min="0" value="${full.low_stock_threshold ?? ''}">`)}
    </div>
    <div class="admin-form-row">
      ${formGroup('Weight (kg)', `<input class="admin-input" id="edit-weight" type="number" step="0.01" min="0" value="${full.weight_kg ?? ''}">`)}
      <div class="admin-form-group"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Active', toggleHtml('edit-active', full.is_active !== false))}
      ${formGroup('Track Inventory', toggleHtml('edit-track-inventory', full.track_inventory !== false))}
    </div>
  `;

  // SEO panel
  let seoHtml = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="generate-seo">${icon('search', 12, 12)} Generate</button>
    </div>
    ${formGroup('Meta Title', `<input class="admin-input" id="edit-meta-title" value="${esc(full.meta_title || '')}">`)}
    ${formGroup('Meta Description', `<textarea class="admin-textarea" id="edit-meta-desc" rows="3">${esc(full.meta_description || '')}</textarea>`)}
  `;

  // Advanced panel
  let advancedHtml = `
    ${formGroup('Page Yield', `<input class="admin-input" id="edit-page-yield" type="number" min="0" value="${full.page_yield ?? ''}">`)}
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" value="${esc((full.tags || []).join(', '))}">`)}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3">${esc(full.internal_notes || '')}</textarea>`)}
  `;

  // Compatibility panel
  let compatHtml = `
    <div class="admin-form-group" id="compat-section">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <label id="compat-heading">Compatible Printers</label>
        <div style="display:flex;gap:6px">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-paste-btn">Paste Bulk</button>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-add-btn">+ Add Printer</button>
        </div>
      </div>
      <div id="compat-search-wrap" style="display:none;margin-bottom:8px;position:relative">
        <input class="admin-input" id="compat-search" placeholder="Search printers\u2026" autocomplete="off">
        <div id="compat-suggestions" class="admin-compat-suggestions"></div>
      </div>
      <div id="compat-paste-wrap" class="admin-compat-paste-wrap" style="display:none">
        <textarea id="compat-paste-area" class="admin-input admin-compat-paste-area" placeholder="Paste printer compatibility list\u2026&#10;Each line: Brand Model1 / Model2 / Model3&#10;Example: Brother 1500 / 2000 / Charger11"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <button class="admin-btn admin-btn--sm admin-btn--primary" id="compat-parse-btn">Find Printers</button>
          <button class="admin-btn admin-btn--sm admin-btn--ghost" id="compat-add-matched-btn" style="display:none"></button>
        </div>
        <div id="compat-parse-results" class="admin-compat-parse-results"></div>
      </div>
      <div class="admin-compat-printers" id="compat-printers"><span class="admin-text-muted">Loading\u2026</span></div>
      <div id="compat-bulk-wrap" style="margin-top:10px;display:none">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-bulk-btn">Apply to all variants with prefix &ldquo;<span id="compat-prefix"></span>&rdquo;</button>
      </div>
      <div id="compat-unmatched-wrap" style="display:none;margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <label style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Unmatched Models (not in DB)</label>
          <div style="display:flex;gap:4px">
            <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-create-all-btn" style="font-size:11px;padding:2px 8px">Create All</button>
            <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-clear-unmatched-btn" style="font-size:11px;padding:2px 8px">Clear</button>
          </div>
        </div>
        <div id="compat-unmatched-list" class="admin-compat-unmatched-list"></div>
      </div>
    </div>
  `;

  // FAQ panel
  let faqHtml = `
    <div id="faq-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">FAQs</span>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="faq-add-btn">+ Add FAQ</button>
      </div>
      <div id="faq-add-form" style="display:none;margin-bottom:16px;padding:12px;background:var(--input-bg);border:1px solid var(--border);border-radius:var(--radius)">
        <div class="admin-form-group">
          <label>Question</label>
          <input class="admin-input" id="faq-new-question" placeholder="Enter question\u2026">
        </div>
        <div class="admin-form-group">
          <label>Answer</label>
          <textarea class="admin-textarea" id="faq-new-answer" rows="3" placeholder="Enter answer\u2026"></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="admin-btn admin-btn--primary admin-btn--sm" id="faq-save-new-btn">Save</button>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="faq-cancel-add-btn">Cancel</button>
        </div>
      </div>
      <div id="faq-list"><span class="admin-text-muted" style="font-size:13px">Loading\u2026</span></div>
    </div>
  `;

  const panelContents = [basicHtml, pricingHtml, inventoryHtml, seoHtml, advancedHtml, compatHtml, faqHtml];
  panelsEl.innerHTML = panelContents.map((content, i) =>
    `<div class="admin-product-modal__tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${content}</div>`
  ).join('');

  // Wire tab switching
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-product-modal__tab');
    if (!btn) return;
    const idx = btn.dataset.tab;
    tabsEl.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    panelsEl.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  });
}

async function buildFaqSection(modal, product) {
  const productId = product.id;
  const token = () => window.Auth?.session?.access_token;
  const base = `${Config.SUPABASE_URL}/rest/v1/product_faqs`;
  const headers = () => ({
    'apikey': Config.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token()}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  });

  let faqs = [];

  async function loadFaqs() {
    const resp = await fetch(`${base}?product_id=eq.${productId}&order=order_index.asc,created_at.asc`, {
      headers: headers()
    });
    if (!resp.ok) throw new Error('Failed to load FAQs');
    faqs = await resp.json();
  }

  function renderFaqList() {
    const list = modal.querySelector('#faq-list');
    if (!faqs.length) {
      list.innerHTML = `<div class="admin-text-muted" style="font-size:13px;padding:12px 0">No FAQs yet. Click &ldquo;+ Add FAQ&rdquo; to create one.</div>`;
      return;
    }
    list.innerHTML = faqs.map((faq, i) => `
      <div class="admin-faq-item" data-faq-id="${esc(String(faq.id))}">
        <div class="admin-faq-item__view">
          <div class="admin-faq-item__q">${esc(faq.question)}</div>
          <div class="admin-faq-item__a">${esc(faq.answer)}</div>
          <div class="admin-faq-item__actions">
            <button class="admin-btn admin-btn--ghost admin-btn--sm faq-edit-btn" data-idx="${i}">Edit</button>
            <button class="admin-btn admin-btn--ghost admin-btn--sm faq-delete-btn" data-faq-id="${esc(String(faq.id))}" style="color:var(--danger)">Delete</button>
          </div>
        </div>
        <div class="admin-faq-item__edit" style="display:none">
          <div class="admin-form-group">
            <label>Question</label>
            <input class="admin-input faq-edit-question" value="${esc(faq.question)}">
          </div>
          <div class="admin-form-group">
            <label>Answer</label>
            <textarea class="admin-textarea faq-edit-answer" rows="3">${esc(faq.answer)}</textarea>
          </div>
          <div style="display:flex;gap:8px">
            <button class="admin-btn admin-btn--primary admin-btn--sm faq-save-edit-btn" data-faq-id="${esc(String(faq.id))}">Save</button>
            <button class="admin-btn admin-btn--ghost admin-btn--sm faq-cancel-edit-btn">Cancel</button>
          </div>
        </div>
      </div>
    `).join('');
  }

  // Initial load
  try {
    await loadFaqs();
    renderFaqList();
  } catch (e) {
    modal.querySelector('#faq-list').innerHTML = `<div class="admin-text-muted" style="font-size:13px">Failed to load FAQs.</div>`;
  }

  // Add FAQ toggle
  modal.querySelector('#faq-add-btn').addEventListener('click', () => {
    modal.querySelector('#faq-add-form').style.display = 'block';
    modal.querySelector('#faq-new-question').focus();
  });
  modal.querySelector('#faq-cancel-add-btn').addEventListener('click', () => {
    modal.querySelector('#faq-add-form').style.display = 'none';
    modal.querySelector('#faq-new-question').value = '';
    modal.querySelector('#faq-new-answer').value = '';
  });

  // Save new FAQ
  modal.querySelector('#faq-save-new-btn').addEventListener('click', async () => {
    const q = modal.querySelector('#faq-new-question').value.trim();
    const a = modal.querySelector('#faq-new-answer').value.trim();
    if (!q || !a) { Toast.error('Question and answer are required'); return; }
    const btn = modal.querySelector('#faq-save-new-btn');
    btn.disabled = true;
    try {
      const resp = await fetch(base, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ product_id: productId, question: q, answer: a, order_index: faqs.length }),
      });
      if (!resp.ok) throw new Error('Save failed');
      const [created] = await resp.json();
      faqs.push(created);
      renderFaqList();
      modal.querySelector('#faq-add-form').style.display = 'none';
      modal.querySelector('#faq-new-question').value = '';
      modal.querySelector('#faq-new-answer').value = '';
      Toast.success('FAQ added');
    } catch (e) {
      Toast.error(`Add failed: ${e.message}`);
    } finally { btn.disabled = false; }
  });

  // Delegate edit/delete/save/cancel on list
  modal.querySelector('#faq-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.admin-faq-item');
    if (!item) return;

    // Toggle edit view
    if (e.target.closest('.faq-edit-btn')) {
      item.querySelector('.admin-faq-item__view').style.display = 'none';
      item.querySelector('.admin-faq-item__edit').style.display = 'block';
      return;
    }
    if (e.target.closest('.faq-cancel-edit-btn')) {
      item.querySelector('.admin-faq-item__view').style.display = 'block';
      item.querySelector('.admin-faq-item__edit').style.display = 'none';
      return;
    }

    // Save edit
    if (e.target.closest('.faq-save-edit-btn')) {
      const faqId = e.target.closest('.faq-save-edit-btn').dataset.faqId;
      const q = item.querySelector('.faq-edit-question').value.trim();
      const a = item.querySelector('.faq-edit-answer').value.trim();
      if (!q || !a) { Toast.error('Question and answer are required'); return; }
      const btn = e.target.closest('.faq-save-edit-btn');
      btn.disabled = true;
      try {
        const resp = await fetch(`${base}?id=eq.${faqId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ question: q, answer: a }),
        });
        if (!resp.ok) throw new Error('Update failed');
        const idx = faqs.findIndex(f => f.id === faqId);
        if (idx !== -1) { faqs[idx].question = q; faqs[idx].answer = a; }
        renderFaqList();
        Toast.success('FAQ updated');
      } catch (e) {
        Toast.error(`Update failed: ${e.message}`);
      } finally { btn.disabled = false; }
      return;
    }

    // Delete
    if (e.target.closest('.faq-delete-btn')) {
      const faqId = e.target.closest('.faq-delete-btn').dataset.faqId;
      if (!confirm('Delete this FAQ?')) return;
      try {
        const resp = await fetch(`${base}?id=eq.${faqId}`, {
          method: 'DELETE',
          headers: headers(),
        });
        if (!resp.ok) throw new Error('Delete failed');
        faqs = faqs.filter(f => f.id !== faqId);
        renderFaqList();
        Toast.success('FAQ deleted');
      } catch (e) {
        Toast.error(`Delete failed: ${e.message}`);
      }
    }
  });
}

function formGroup(label, inputHtml) {
  return `<div class="admin-form-group"><label>${esc(label)}</label>${inputHtml}</div>`;
}

function buildSelect(id, options, selected) {
  let html = `<select class="admin-select" id="${id}">`;
  for (const opt of options) {
    const value = typeof opt === 'object' ? opt.value : opt;
    const label = typeof opt === 'object' ? opt.label : opt.charAt(0).toUpperCase() + opt.slice(1);
    const sel = (selected || '').toLowerCase() === value.toLowerCase() ? ' selected' : '';
    html += `<option value="${esc(value)}"${sel}>${esc(label)}</option>`;
  }
  html += '</select>';
  return html;
}

function buildBrandSelect(currentBrand) {
  let html = `<select class="admin-select" id="edit-brand"><option value="">Select brand</option>`;
  for (const b of _brands) {
    const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
    const id = typeof b === 'object' ? (b.id || name) : name;
    const sel = (String(currentBrand) === String(id) || String(currentBrand) === name) ? ' selected' : '';
    html += `<option value="${esc(String(id))}"${sel}>${esc(name)}</option>`;
  }
  html += '</select>';
  return html;
}

function toggleHtml(id, checked) {
  return `<label class="admin-toggle"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="admin-toggle__slider"></span></label>`;
}

function bindProductModalActions(modal, product) {
  // Enter key triggers save (except in textareas)
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      e.stopPropagation();
      modal.querySelector('[data-action="save"]')?.click();
    }
  });

  // Compatibility management (editable)
  {
    let compatPrinters = [];
    const container = modal.querySelector('#compat-printers');
    const heading = modal.querySelector('#compat-heading');
    const addBtn = modal.querySelector('#compat-add-btn');
    const searchWrap = modal.querySelector('#compat-search-wrap');
    const searchInput = modal.querySelector('#compat-search');
    const suggestions = modal.querySelector('#compat-suggestions');
    const pasteBtn = modal.querySelector('#compat-paste-btn');
    const pasteWrap = modal.querySelector('#compat-paste-wrap');
    const pasteArea = modal.querySelector('#compat-paste-area');
    const parseBtn = modal.querySelector('#compat-parse-btn');
    const addMatchedBtn = modal.querySelector('#compat-add-matched-btn');
    const parseResults = modal.querySelector('#compat-parse-results');
    const unmatchedWrap = modal.querySelector('#compat-unmatched-wrap');
    const unmatchedList = modal.querySelector('#compat-unmatched-list');
    const clearUnmatchedBtn = modal.querySelector('#compat-clear-unmatched-btn');
    const createAllBtn = modal.querySelector('#compat-create-all-btn');

    // Helpers: embed/extract unmatched block inside internal_notes
    const UM_START = '=== Unmatched Compatibility Models ===';
    const UM_END = '=====================================';
    function getUnmatchedNote(notes) {
      const s = (notes || '').indexOf(UM_START);
      const e = (notes || '').indexOf(UM_END);
      if (s === -1 || e === -1) return '';
      return notes.slice(s + UM_START.length, e).trim();
    }
    function setUnmatchedNote(notes, csv) {
      const base = (notes || '').replace(new RegExp('\\n?' + UM_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + UM_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'), '').trim();
      if (!csv) return base;
      return `${base ? base + '\n\n' : ''}${UM_START}\n${csv}\n${UM_END}`;
    }
    function renderUnmatchedNote(csv) {
      if (!unmatchedWrap || !unmatchedList) return;
      if (csv) {
        unmatchedList.textContent = csv;
        unmatchedWrap.style.display = 'block';
      } else {
        unmatchedWrap.style.display = 'none';
        unmatchedList.textContent = '';
      }
    }

    // Show existing unmatched note on load
    renderUnmatchedNote(getUnmatchedNote(product.internal_notes));

    // Clear button
    if (clearUnmatchedBtn) {
      clearUnmatchedBtn.addEventListener('click', async () => {
        clearUnmatchedBtn.disabled = true;
        try {
          const newNotes = setUnmatchedNote(product.internal_notes, '');
          await AdminAPI.updateProduct(product.id, { internal_notes: newNotes });
          product.internal_notes = newNotes;
          renderUnmatchedNote('');
        } catch (err) {
          Toast.error(`Clear failed: ${err.message}`);
        } finally { clearUnmatchedBtn.disabled = false; }
      });
    }
    // Create All button — creates all stored unmatched models in the DB and links them
    if (createAllBtn) {
      createAllBtn.addEventListener('click', async () => {
        if (!product.sku) return;
        const csv = getUnmatchedNote(product.internal_notes);
        const names = csv ? csv.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (names.length === 0) return;
        createAllBtn.disabled = true;
        createAllBtn.textContent = 'Creating\u2026';
        let created = 0;
        const remaining = [];
        for (const name of names) {
          try {
            const newPrinter = await AdminAPI.createPrinter(name);
            const id = String(newPrinter.id || newPrinter.printer_id || '');
            const displayName = newPrinter.full_name || newPrinter.name || name;
            if (id) {
              await AdminAPI.addCompatiblePrinter(product.sku, id);
              compatPrinters.push({ id, full_name: displayName });
              created++;
            } else {
              remaining.push(name);
            }
          } catch (_) {
            remaining.push(name);
          }
        }
        renderCompatBadges();
        const newNotes = setUnmatchedNote(product.internal_notes, remaining.join(', '));
        try {
          await AdminAPI.updateProduct(product.id, { internal_notes: newNotes });
          product.internal_notes = newNotes;
        } catch (_) {}
        renderUnmatchedNote(remaining.join(', '));
        if (created > 0) Toast.success(`Created ${created} printer${created > 1 ? 's' : ''}`);
        createAllBtn.disabled = false;
        createAllBtn.textContent = 'Create All';
      });
    }
    const bulkWrap = modal.querySelector('#compat-bulk-wrap');
    const bulkBtn = modal.querySelector('#compat-bulk-btn');
    const prefixEl = modal.querySelector('#compat-prefix');

    // Derive SKU prefix: strip trailing uppercase letters (LC3313BK → LC3313, TN3440 → TN3440)
    const skuPrefix = product.sku ? product.sku.replace(/[A-Z]+$/, '') : '';
    const showBulk = skuPrefix && skuPrefix !== product.sku;

    function renderCompatBadges() {
      if (heading) heading.textContent = `Compatible Printers (${compatPrinters.length})`;
      if (!container) return;
      if (compatPrinters.length > 0) {
        container.innerHTML = compatPrinters.map(p => {
          const name = typeof p === 'string' ? p : (p.full_name || p.model_name || p.model || p.name || String(p));
          const id = typeof p === 'object' ? (p.id || p.printer_id || '') : '';
          return `<span class="admin-badge">${esc(name)}<button class="compat-remove" data-printer-id="${esc(String(id))}" title="Remove">\u00d7</button></span>`;
        }).join('');
      } else {
        container.innerHTML = `
          <div style="background:var(--yellow-light,#fffbe6);border:1px solid var(--yellow,#f0a500);border-radius:6px;padding:10px 12px;font-size:0.85em;">
            <strong>No compatible printers found</strong><br>
            <span style="color:var(--text-muted);">This product has no printer associations in the database. It won't appear in printer-based searches or \u201cYou May Also Need\u201d sections on the storefront.</span>
          </div>`;
      }
    }

    // Remove printer handler (delegated)
    if (container) {
      container.addEventListener('click', async (e) => {
        const btn = e.target.closest('.compat-remove');
        if (!btn || !product.sku) return;
        const printerId = btn.dataset.printerId;
        btn.disabled = true;
        try {
          await AdminAPI.removeCompatiblePrinter(product.sku, printerId);
          compatPrinters = compatPrinters.filter(p => String(typeof p === 'object' ? (p.id || p.printer_id) : '') !== String(printerId));
          renderCompatBadges();
        } catch (err) {
          Toast.error(`Remove failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    }

    // Add printer toggle
    if (addBtn && searchWrap && searchInput) {
      addBtn.addEventListener('click', () => {
        const visible = searchWrap.style.display !== 'none';
        searchWrap.style.display = visible ? 'none' : 'block';
        if (!visible) { searchInput.value = ''; suggestions.innerHTML = ''; searchInput.focus(); }
      });

      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const q = searchInput.value.trim();
        if (q.length < 2) { suggestions.innerHTML = ''; return; }
        searchTimer = setTimeout(async () => {
          try {
            const resp = await window.API.searchPrinters(q);
            const results = resp?.data?.printers || resp?.data || [];
            if (!Array.isArray(results) || results.length === 0) {
              suggestions.innerHTML = '<div class="admin-compat-suggestions__item" style="color:var(--text-muted)">No results</div>';
              return;
            }
            suggestions.innerHTML = results.slice(0, 10).map(p => {
              const name = p.full_name || p.model_name || p.model || p.name || String(p);
              return `<div class="admin-compat-suggestions__item" data-printer-id="${esc(String(p.id || ''))}" data-printer-name="${esc(name)}">${esc(name)}</div>`;
            }).join('');
          } catch (_) {
            suggestions.innerHTML = '<div class="admin-compat-suggestions__item" style="color:var(--text-muted)">Search failed</div>';
          }
        }, 300);
      });

      suggestions.addEventListener('click', async (e) => {
        const item = e.target.closest('.admin-compat-suggestions__item');
        if (!item || !item.dataset.printerId || !product.sku) return;
        const printerId = item.dataset.printerId;
        const printerName = item.dataset.printerName;
        // Don't add duplicates
        if (compatPrinters.some(p => String(typeof p === 'object' ? (p.id || p.printer_id) : '') === String(printerId))) {
          searchWrap.style.display = 'none';
          return;
        }
        item.style.opacity = '0.5';
        try {
          await AdminAPI.addCompatiblePrinter(product.sku, printerId);
          compatPrinters.push({ id: printerId, full_name: printerName });
          renderCompatBadges();
          searchWrap.style.display = 'none';
          searchInput.value = '';
          suggestions.innerHTML = '';
        } catch (err) {
          Toast.error(`Add failed: ${err.message}`);
          item.style.opacity = '1';
        }
      });

      // Close suggestions on outside click
      document.addEventListener('click', (e) => {
        if (!searchWrap.contains(e.target) && e.target !== addBtn) {
          searchWrap.style.display = 'none';
        }
      }, { once: false });
    }

    // Bulk paste
    function parsePrinterBulkText(raw) {
      const queries = [];
      const lines = raw.split(/\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const segments = line.split(/\s*\/\s*|\s*,\s*|\s*;\s*|\s+-\s+/);
        if (segments.length === 1) { queries.push(line.trim()); continue; }
        // Brand = words in first segment before the first digit-starting word
        const words = segments[0].trim().split(/\s+/);
        let brandEnd = words.findIndex(w => /^\d/.test(w));
        if (brandEnd === -1) brandEnd = words.length;
        const brand = words.slice(0, brandEnd).join(' ');
        const firstModel = words.slice(brandEnd).join(' ');
        if (firstModel) queries.push(`${brand} ${firstModel}`.trim());
        else queries.push(brand);
        for (let i = 1; i < segments.length; i++) {
          const seg = segments[i].trim();
          if (seg) queries.push(`${brand} ${seg}`);
        }
      }
      return [...new Set(queries)];
    }

    if (pasteBtn && pasteWrap && pasteArea && parseBtn && addMatchedBtn && parseResults) {
      let pasteMatches = [];
      let lastResults = [];

      pasteBtn.addEventListener('click', () => {
        const visible = pasteWrap.style.display !== 'none';
        pasteWrap.style.display = visible ? 'none' : 'block';
        if (!visible) { pasteArea.value = ''; parseResults.innerHTML = ''; addMatchedBtn.style.display = 'none'; pasteMatches = []; pasteArea.focus(); }
        // Close the single-add search if open
        if (!visible && searchWrap) searchWrap.style.display = 'none';
      });

      parseBtn.addEventListener('click', async () => {
        const raw = pasteArea.value.trim();
        if (!raw) return;
        const names = parsePrinterBulkText(raw);
        if (names.length === 0) return;

        parseBtn.disabled = true;
        parseBtn.textContent = 'Searching\u2026';
        addMatchedBtn.style.display = 'none';
        pasteMatches = [];

        parseResults.innerHTML = `<div id="compat-parse-progress" style="color:var(--text-muted);font-size:12px">Searching 0 / ${names.length}\u2026</div>`;
        const progressEl = parseResults.querySelector('#compat-parse-progress');

        const BATCH = 20;
        const results = [];
        lastResults = results;
        for (let i = 0; i < names.length; i += BATCH) {
          const batch = names.slice(i, i + BATCH);
          const batchResults = await Promise.all(batch.map(async name => {
            try {
              const resp = await window.API.searchPrinters(name);
              const list = resp?.data?.printers || resp?.data || [];
              const top = Array.isArray(list) ? list[0] : null;
              return top ? { query: name, printer: top, matched: true } : { query: name, matched: false };
            } catch (_) {
              return { query: name, matched: false };
            }
          }));
          results.push(...batchResults);
          if (progressEl) progressEl.textContent = `Searching ${Math.min(i + BATCH, names.length)} / ${names.length}\u2026`;
        }

        pasteMatches = results.filter(r => r.matched);
        const newMatches = pasteMatches.filter(r => {
          const id = String(r.printer.id || r.printer.printer_id || '');
          return !compatPrinters.some(p => String(typeof p === 'object' ? (p.id || p.printer_id) : '') === id);
        });

        parseResults.innerHTML = results.map(r => {
          if (r.matched) {
            const resolvedName = r.printer.full_name || r.printer.model_name || r.printer.model || r.printer.name || '';
            return `<div class="admin-compat-parse-result admin-compat-parse-result--matched">
              <span>&#10003;</span>
              <span class="result-name">${esc(resolvedName)}</span>
              <span class="result-query">(searched: ${esc(r.query)})</span>
            </div>`;
          }
          return `<div class="admin-compat-parse-result admin-compat-parse-result--unmatched" data-query="${esc(r.query)}">
            <span>&#8212;</span>
            <span class="result-query">${esc(r.query)}</span>
            <span style="font-size:11px">not found</span>
            <button class="admin-btn admin-btn--ghost admin-btn--sm compat-create-btn" style="font-size:11px;padding:2px 8px;margin-left:auto" data-query="${esc(r.query)}">Create</button>
          </div>`;
        }).join('');

        if (newMatches.length > 0) {
          addMatchedBtn.textContent = `Add ${newMatches.length} Printer${newMatches.length > 1 ? 's' : ''}`;
          addMatchedBtn.style.display = 'inline-flex';
        }

        // Auto-save unmatched names immediately after search
        const unmatchedNow = results.filter(r => !r.matched).map(r => r.query);
        if (unmatchedNow.length > 0 && product.id) {
          const existing = getUnmatchedNote(product.internal_notes);
          const existingSet = new Set(existing ? existing.split(',').map(s => s.trim()).filter(Boolean) : []);
          unmatchedNow.forEach(n => existingSet.add(n));
          const merged = [...existingSet].join(', ');
          const newNotes = setUnmatchedNote(product.internal_notes, merged);
          renderUnmatchedNote(merged); // show immediately in UI
          try {
            await AdminAPI.updateProduct(product.id, { internal_notes: newNotes });
            product.internal_notes = newNotes;
          } catch (err) {
            Toast.error(`Could not save unmatched note: ${err.message}`);
          }
        }

        parseBtn.disabled = false;
        parseBtn.textContent = 'Find Printers';
      });

      addMatchedBtn.addEventListener('click', async () => {
        if (!product.sku) return;
        const toAdd = pasteMatches.filter(r => {
          const id = String(r.printer.id || r.printer.printer_id || '');
          return !compatPrinters.some(p => String(typeof p === 'object' ? (p.id || p.printer_id) : '') === id);
        });
        if (toAdd.length === 0) return;

        addMatchedBtn.disabled = true;
        addMatchedBtn.textContent = 'Adding\u2026';
        let added = 0;
        for (const r of toAdd) {
          const id = String(r.printer.id || r.printer.printer_id || '');
          const name = r.printer.full_name || r.printer.model_name || r.printer.model || r.printer.name || '';
          try {
            await AdminAPI.addCompatiblePrinter(product.sku, id);
            compatPrinters.push({ id, full_name: name });
            added++;
          } catch (_) {}
        }
        renderCompatBadges();
        pasteWrap.style.display = 'none';
        pasteArea.value = '';
        parseResults.innerHTML = '';
        addMatchedBtn.style.display = 'none';
        pasteMatches = [];
        if (added > 0) Toast.success(`Added ${added} printer${added > 1 ? 's' : ''}`);
        addMatchedBtn.disabled = false;
      });
    }

    // Individual "Create" button on unmatched search result rows
    if (parseResults) {
      parseResults.addEventListener('click', async (e) => {
        const btn = e.target.closest('.compat-create-btn');
        if (!btn || !product.sku) return;
        const query = btn.dataset.query;
        if (!query) return;
        btn.disabled = true;
        btn.textContent = 'Creating\u2026';
        try {
          const newPrinter = await AdminAPI.createPrinter(query);
          const id = String(newPrinter.id || newPrinter.printer_id || '');
          const name = newPrinter.full_name || newPrinter.name || query;
          if (id) {
            await AdminAPI.addCompatiblePrinter(product.sku, id);
            compatPrinters.push({ id, full_name: name });
            renderCompatBadges();
          }
          // Update row to matched style
          const row = btn.closest('.admin-compat-parse-result');
          if (row) {
            row.className = 'admin-compat-parse-result admin-compat-parse-result--matched';
            row.innerHTML = `<span>&#10003;</span><span class="result-name">${esc(name)}</span><span class="result-query">(created)</span>`;
          }
          // Remove from unmatched notes
          const existing = getUnmatchedNote(product.internal_notes);
          const updated = existing.split(',').map(s => s.trim()).filter(s => s && s !== query).join(', ');
          const newNotes = setUnmatchedNote(product.internal_notes, updated);
          await AdminAPI.updateProduct(product.id, { internal_notes: newNotes });
          product.internal_notes = newNotes;
          renderUnmatchedNote(updated);
          Toast.success(`Created printer: ${name}`);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Create';
          Toast.error(`Failed to create: ${err.message}`);
        }
      });
    }

    // Bulk apply
    if (showBulk && bulkWrap && bulkBtn && prefixEl) {
      prefixEl.textContent = skuPrefix;
      bulkWrap.style.display = 'block';
      bulkBtn.addEventListener('click', async () => {
        if (compatPrinters.length === 0) { Toast.error('No printers to apply'); return; }
        const printerIds = compatPrinters.map(p => typeof p === 'object' ? (p.id || p.printer_id) : null).filter(Boolean);
        bulkBtn.disabled = true;
        bulkBtn.textContent = 'Applying\u2026';
        try {
          await AdminAPI.bulkApplyCompatibility(skuPrefix, printerIds);
          Toast.success(`Applied to all variants with prefix \u201c${skuPrefix}\u201d`);
        } catch (err) {
          Toast.error(`Bulk apply failed: ${err.message}`);
        } finally {
          bulkBtn.disabled = false;
          bulkBtn.innerHTML = `Apply to all variants with prefix \u201c<span id="compat-prefix">${esc(skuPrefix)}</span>\u201d`;
        }
      });
    }

    // Load printers
    if (product.sku && window.API?.getCompatiblePrinters) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
      Promise.race([window.API.getCompatiblePrinters(product.sku), timeout]).then(response => {
        compatPrinters = response?.data?.compatible_printers || response?.data?.printers || response?.data || [];
        if (!Array.isArray(compatPrinters)) compatPrinters = [];
        renderCompatBadges();
      }).catch(() => {
        compatPrinters = [];
        renderCompatBadges();
      });
    } else {
      renderCompatBadges();
    }
  }

  // Bind image error fallbacks
  modal.querySelectorAll('img[data-fallback="broken-parent"]').forEach(img => {
    img.addEventListener('error', function() {
      this.parentElement.classList.add('admin-product-gallery__item--broken');
    }, { once: true });
  });


  // Image upload (supports multiple files)
  const dropzone = modal.querySelector('#image-dropzone');
  const fileInput = modal.querySelector('#image-upload');
  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  async function uploadFiles(files) {
    const valid = [...files].filter(f => ALLOWED_TYPES.includes(f.type));
    if (valid.length === 0) {
      Toast.error('Unsupported format. Use PNG, JPG, WebP, or GIF.');
      return;
    }
    dropzone.classList.add('uploading');
    dropzone.querySelector('span').textContent = `Uploading ${valid.length} image${valid.length > 1 ? 's' : ''}\u2026`;
    let uploaded = 0;
    for (const file of valid) {
      try {
        await uploadImage(product.id, file);
        uploaded++;
      } catch { /* uploadImage already toasts errors */ }
    }
    if (uploaded > 0) Toast.success(`${uploaded} image${uploaded > 1 ? 's' : ''} uploaded`);
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('dragover');
      if (e.dataTransfer?.files?.length) await uploadFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', async () => {
      if (fileInput.files?.length) await uploadFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  // Image delete buttons
  modal.querySelectorAll('[data-delete-image]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const imageId = btn.dataset.deleteImage;
      const item = btn.closest('.admin-product-gallery__item');
      if (item) item.style.opacity = '0.4';
      try {
        if (imageId) {
          await AdminAPI.deleteProductImage(product.id, imageId);
        } else {
          await AdminAPI.updateProduct(product.id, {
            image_url: null,
            primary_image: null,
            retail_price: product.retail_price,
            stock_quantity: product.stock_quantity ?? 0,
          });
        }
        Toast.success('Image removed');
        if (item) item.remove();
        const gallery = modal.querySelector('#product-gallery');
        if (gallery && !gallery.querySelector('.admin-product-gallery__item')) {
          gallery.innerHTML = '<div class="admin-product-gallery__empty">No images yet</div>';
        }
      } catch (err) {
        if (item) item.style.opacity = '1';
        Toast.error(`Delete failed: ${err.message}`);
      }
    });
  });

  // Generate SEO — calls backend AI endpoint, falls back to local template
  modal.querySelector('[data-action="generate-seo"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const titleEl = modal.querySelector('#edit-meta-title');
    const descEl = modal.querySelector('#edit-meta-desc');
    btn.disabled = true;
    btn.textContent = 'Generating\u2026';
    try {
      const result = await AdminAPI.generateProductSEO(product.sku);
      if (titleEl) titleEl.value = result?.meta_title || '';
      if (descEl) descEl.value = result?.meta_description || '';
      Toast.success('SEO regenerated');
    } catch (err) {
      Toast.error(`SEO generation failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('search', 12, 12)} Generate`;
    }
  });

  // Cancel
  modal.querySelector('[data-action="cancel"]')?.addEventListener('click', closeProductModal);

  // Save
  modal.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const val = (id) => modal.querySelector(`#${id}`)?.value?.trim() ?? '';
    const numVal = (id) => { const v = val(id); return v !== '' ? Number(v) : null; };
    const chk = (id) => !!modal.querySelector(`#${id}`)?.checked;

    const tagsRaw = val('edit-tags');
    const tagsArr = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const data = {
      sku: val('edit-sku'),
      name: val('edit-name'),
      description: val('edit-description'),
      brand_id: val('edit-brand') || null,
      product_type: val('edit-type'),
      color: val('edit-color'),
      source: val('edit-source'),
      retail_price: numVal('edit-retail-price'),
      compare_at_price: numVal('edit-compare-price'),
      stock_quantity: numVal('edit-stock'),
      low_stock_threshold: numVal('edit-low-threshold'),
      is_active: chk('edit-active'),
      track_inventory: chk('edit-track-inventory'),
      meta_title: val('edit-meta-title'),
      meta_description: val('edit-meta-desc'),
      page_yield: numVal('edit-page-yield'),
      weight_kg: numVal('edit-weight'),
      tags: tagsArr,
      internal_notes: val('edit-admin-notes'),
    };

    if (AdminAuth.isOwner()) {
      data.cost_price = numVal('edit-cost-price');
    }

    try {
      await AdminAPI.updateProduct(product.id, data);
      Toast.success('Product updated');
      closeProductModal();
      loadProducts();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
    }
  });

  buildFaqSection(modal, product);
}

async function uploadImage(productId, file) {
  await AdminAPI.uploadProductImage(productId, file);
  // Re-open drawer to refresh gallery
  const product = await AdminAPI.getProduct(productId);
  if (product) openProductDrawer(product);
}

function renderDiagnostics(container) {
  if (!_container || !AdminAuth.isOwner()) return;
  const d = _diagnostics;
  const isLoading = !d;

  const section = document.createElement('div');
  section.className = 'admin-section';
  section.innerHTML = `
    <div class="admin-section__header">
      <h2 class="admin-section__title">Product Diagnostics</h2>
      <div style="display:flex;gap:8px">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-seo-btn">${icon('search', 14, 14)} Generate SEO</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-activate-btn">${icon('products', 14, 14)} Bulk Activate</button>
      </div>
    </div>
    <div class="admin-kpi-grid${isLoading ? ' admin-kpi-grid--loading' : ''}" style="grid-template-columns:repeat(4,1fr)">
      ${diagKpi('Total Products',        d?.total ?? d?.total_products ?? MISSING)}
      ${diagKpi('Active',                d?.active ?? d?.active_count ?? MISSING)}
      ${diagKpi('Missing Images',        d?.missing_images ?? MISSING)}
      ${diagKpi('Missing Prices',        d?.missing_prices ?? MISSING)}
      ${diagKpi('Missing Weight',        d?.missing_weight ?? MISSING)}
      ${diagKpi('Missing Compatibility', d?.missing_compatibility ?? (d ? 'N/A' : MISSING))}
      ${diagKpi('Zero Stock',            d?.zero_stock ?? MISSING, 'danger')}
      ${diagKpi('Critical Stock (\u22645)', d?.critical_stock ?? MISSING, 'warning')}
    </div>
  `;
  // Remove any existing diagnostics section before inserting updated one
  container.querySelector(':scope > .admin-section.diag-section')?.remove();
  section.classList.add('diag-section');

  const ref = container.querySelector(':scope > .admin-mb-lg');
  if (ref) container.insertBefore(section, ref);
  else container.appendChild(section);

  section.querySelector('#bulk-seo-btn')?.addEventListener('click', () => bulkGenerateSEO());

  section.querySelector('#bulk-activate-btn')?.addEventListener('click', async () => {
    try {
      const preview = await AdminAPI.bulkActivate({ dry_run: true });
      const count = preview?.count ?? preview?.affected ?? '?';
      Modal.confirm({
        title: 'Bulk Activate Products',
        message: `This will activate ${count} eligible products. Proceed?`,
        confirmLabel: 'Activate All',
        confirmClass: 'admin-btn--primary',
        onConfirm: async () => {
          await AdminAPI.bulkActivate({ dry_run: false });
          Toast.success('Products activated');
          loadProducts();
        },
      });
    } catch (e) {
      Toast.error(`Bulk activate failed: ${e.message}`);
    }
  });
}

function diagKpi(label, value, variant = null) {
  const cls = variant ? ` admin-kpi--${variant}` : '';
  const isMissing = value === MISSING;
  const valCls = isMissing ? ' admin-kpi__value--missing' : '';
  return `<div class="admin-kpi${cls}" style="padding:12px 14px"><div class="admin-kpi__label">${esc(label)}</div><div class="admin-kpi__value${valCls}" style="font-size:18px">${esc(String(value))}</div></div>`;
}

function getProductExportParams() {
  const p = new URLSearchParams(FilterState.getParams());
  if (_search) p.set('search', _search);
  if (_brandFilter) p.set('brand', _brandFilter);
  if (_activeFilter !== '') p.set('active', _activeFilter);
  if (_sort) p.set('sort', _sort);
  if (_sortDir) p.set('order', _sortDir);
  return p.toString();
}

async function handleExport(format = 'csv') {
  try {
    if (format === 'pdf') {
      await exportProductsPDF();
      return;
    }
    Toast.info(`Preparing ${format.toUpperCase()} export\u2026`);
    await AdminAPI.exportData('products', format, getProductExportParams());
    Toast.success('Products exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

async function exportProductsPDF() {
  Toast.info('Preparing PDF export\u2026');
  try {
    // Fetch all products matching current filters (same logic as loadProducts)
    const filters = { search: _search, sort: _sort, order: _sortDir };
    const globalBrands = FilterState.get('brands') || [];
    if (_brandFilter) {
      filters.brand = _brandFilter;
    } else if (globalBrands.length) {
      filters.brand = globalBrands.join(',');
    }
    if (_activeFilter !== '') filters.active = _activeFilter;

    let all = [];
    let page = 1;
    while (true) {
      const data = await AdminAPI.getProducts(filters, page, 200);
      const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
      if (!rows.length) break;
      all = all.concat(rows);
      const total = data?.pagination?.total || data?.total;
      if (total && all.length >= total) break;
      if (rows.length < 200) break;
      page++;
    }

    // Apply client-side image filter if active
    if (_imageFilter) {
      all = all.filter(p =>
        _imageFilter === 'no-images' ? !productHasImage(p) : productHasImage(p)
      );
    }

    if (!all.length) {
      Toast.error('No products to export');
      return;
    }

    const isOwner = AdminAuth.isOwner();

    // Load jsPDF dynamically — always attempt if window.jspdf is missing
    if (!window.jspdf || !window.jspdf.jsPDF) {
      const loadScript = (url) => new Promise((resolve, reject) => {
        // Remove any previously failed script with same src
        const existing = document.querySelector(`script[src="${url}"]`);
        if (existing) existing.remove();
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Failed to load: ${url}`));
        document.head.appendChild(s);
      });
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js');
    }

    if (!window.jspdf || !window.jspdf.jsPDF) {
      throw new Error('jsPDF library failed to initialize. Please hard-refresh the page (Ctrl+Shift+R) and try again.');
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // Title and metadata
    doc.setFontSize(16);
    doc.text('Products Export', 14, 15);
    doc.setFontSize(9);
    doc.setTextColor(100);

    // Filter summary
    const filterParts = [];
    if (_search) filterParts.push(`Search: "${_search}"`);
    if (_brandFilter) filterParts.push(`Brand: ${_brandFilter}`);
    if (_activeFilter !== '') filterParts.push(`Status: ${_activeFilter === 'true' ? 'Active' : 'Inactive'}`);
    if (_imageFilter) filterParts.push(`Images: ${_imageFilter === 'no-images' ? 'Missing' : 'Has images'}`);
    const summary = filterParts.length ? filterParts.join(' | ') : 'All products';
    doc.text(`${summary}  \u2022  ${all.length} products  \u2022  ${new Date().toLocaleDateString('en-NZ')}`, 14, 21);
    doc.setTextColor(0);

    // Table columns
    const head = ['Name', 'SKU', 'Brand', 'Price', ...(isOwner ? ['Cost'] : []), 'Stock', 'Active'];
    const body = all.map(p => {
      const brand = extractBrandName(p) || MISSING;
      const price = p.retail_price ?? p.cost_price;
      return [
        p.name || MISSING,
        p.sku || MISSING,
        brand,
        price != null ? formatPrice(price) : MISSING,
        ...(isOwner ? [p.cost_price != null ? formatPrice(p.cost_price) : MISSING] : []),
        p.stock_quantity != null ? String(p.stock_quantity) : 'Unknown',
        p.is_active !== false ? 'Yes' : 'No',
      ];
    });

    doc.autoTable({
      head: [head],
      body,
      startY: 26,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [41, 98, 255], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 247, 250] },
      didDrawPage: (data) => {
        const pageCount = doc.internal.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(
          `Page ${data.pageNumber} of ${pageCount}`,
          doc.internal.pageSize.getWidth() / 2, doc.internal.pageSize.getHeight() - 8,
          { align: 'center' }
        );
      },
    });

    doc.save(`products-${new Date().toISOString().slice(0, 10)}.pdf`);
    Toast.success('Products exported as PDF');
  } catch (e) {
    Toast.error(`PDF export failed: ${e.message}`);
  }
}

// ---- SEO Metadata Generator ----

function generateSEO(product) {
  const rawBrand = product.brand_name || product.brand || '';
  const brand = typeof rawBrand === 'object' ? (rawBrand.name || rawBrand.brand || '') : rawBrand;
  const name = product.name || '';
  const type = (product.product_type || 'ink').toLowerCase();
  const source = (product.source || '').toLowerCase();
  const color = product.color || '';

  // Extract cartridge code from name (e.g. "Brother B131" → "B131")
  const codeMatch = name.match(/\b([A-Z]{1,3}[\-]?\d{2,5}[A-Z]*(?:XL)?)\b/i);
  const code = codeMatch ? codeMatch[1] : '';

  // Readable type labels
  const typeLabel = {
    ink_cartridge: 'Ink Cartridge',
    ink_bottle: 'Ink Bottle',
    toner_cartridge: 'Toner Cartridge',
    drum_unit: 'Drum Unit',
    waste_toner: 'Waste Toner',
    belt_unit: 'Belt Unit',
    fuser_kit: 'Fuser Kit',
    fax_film: 'Fax Film',
    fax_film_refill: 'Fax Film Refill',
    ribbon: 'Printer Ribbon',
    label_tape: 'Label Tape',
    photo_paper: 'Photo Paper',
    printer: 'Printer',
  }[type] || '';
  const sourceLabel = source === 'genuine' ? 'Genuine' : source === 'compatible' ? 'Compatible' : source === 'remanufactured' ? 'Remanufactured' : '';

  // ---- Meta Title (50-60 chars ideal) ----
  // Pattern: "Buy {Brand} {Code} {Type} NZ | InkCartridges.co.nz"
  let metaTitle;
  if (code && sourceLabel) {
    metaTitle = `Buy ${brand} ${code} ${typeLabel} NZ - ${sourceLabel} | InkCartridges.co.nz`;
  } else if (code) {
    metaTitle = `Buy ${brand} ${code} ${typeLabel} NZ | InkCartridges.co.nz`;
  } else {
    metaTitle = `Buy ${name} NZ | InkCartridges.co.nz`;
  }
  if (metaTitle.length > 60) {
    metaTitle = `Buy ${brand} ${code || name.split(' ').slice(1, 3).join(' ')} NZ | InkCartridges.co.nz`;
  }

  // ---- Meta Description (150-160 chars ideal) ----
  const colorPart = color && color.toLowerCase() !== 'n/a' ? ` ${color}` : '';
  const sourcePart = sourceLabel ? `${sourceLabel.toLowerCase()} ` : '';
  const qualityNote = sourceLabel === 'Genuine' ? 'OEM quality guaranteed.' : sourceLabel === 'Compatible' ? 'Quality tested, NZ warranty.' : '';
  let metaDesc;
  if (type === 'ribbon') {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name}${colorPart} printer ribbon in NZ. In stock, ships fast. ${qualityNote} Free delivery on orders over $100 inc GST.`.trim();
  } else if (type === 'drum_unit') {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name} drum unit in NZ. In stock, ships fast. ${qualityNote} Free delivery on orders over $100 inc GST.`.trim();
  } else {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name}${colorPart} ${typeLabel.toLowerCase()} in NZ. In stock, ships fast. ${qualityNote} Free delivery on orders over $100 inc GST.`.trim();
  }
  if (metaDesc.length > 160) {
    metaDesc = metaDesc.substring(0, 157) + '...';
  }

  return { meta_title: metaTitle.trim(), meta_description: metaDesc.trim() };
}

async function bulkGenerateSEO() {
  Modal.confirm({
    title: 'Generate SEO Metadata',
    message: 'This will generate meta titles and descriptions for all active products. Existing metadata will be overwritten. Continue?',
    confirmLabel: 'Generate SEO',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      const btn = _container?.querySelector('#bulk-seo-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Generating\u2026'; }
      try {
        const result = await AdminAPI.bulkGenerateAllSeo();
        const { updated = 0, failed = 0 } = result?.data ?? result ?? {};
        if (failed > 0) {
          Toast.info(`Done: ${updated} updated, ${failed} failed`);
        } else {
          Toast.success(`SEO generated for ${updated} products`);
        }
        loadProducts();
      } catch (e) {
        Toast.error(`SEO generation failed: ${e.message}`);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `${icon('search', 14, 14)} Generate SEO`; }
      }
    },
  });
}

async function regenerateAllSEO() {
  Modal.confirm({
    title: 'Regenerate All SEO',
    message: 'This will regenerate SEO metadata for all active products via the backend AI. Existing metadata will be overwritten. Continue?',
    confirmLabel: 'Regenerate All',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      const btn = _container?.querySelector('#regen-all-seo-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Regenerating\u2026'; }
      try {
        const result = await AdminAPI.bulkGenerateAllSeo();
        const { updated = 0, failed = 0 } = result?.data ?? result ?? {};
        if (failed > 0) {
          Toast.info(`Done: ${updated} updated, ${failed} failed`);
        } else {
          Toast.success(`SEO regenerated for ${updated} products`);
        }
        loadProducts();
      } catch (e) {
        Toast.error(`Regenerate All SEO failed: ${e.message}`);
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `${icon('search', 14, 14)} Regenerate All SEO`; }
      }
    },
  });
}

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
      <button class="admin-btn admin-btn--sm admin-btn--danger" data-bulk="deactivate">Deactivate</button>
      <button class="admin-btn admin-btn--sm admin-btn--primary" data-bulk="activate">Activate</button>
      <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
      <button class="admin-btn admin-btn--sm admin-btn--danger" data-bulk="delete">Delete</button>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-bulk="clear">Clear</button>
    </div>
  `;
  _bulkBar.querySelector('[data-bulk="deactivate"]').addEventListener('click', () => bulkSetActive(false));
  _bulkBar.querySelector('[data-bulk="activate"]').addEventListener('click', () => bulkSetActive(true));
  _bulkBar.querySelector('[data-bulk="delete"]').addEventListener('click', () => bulkDelete());
  _bulkBar.querySelector('[data-bulk="clear"]').addEventListener('click', () => {
    if (_table) _table.clearSelection();
    updateBulkBar(new Set());
  });
}

async function bulkSetActive(activate) {
  if (!_table) return;
  const selected = _table.getSelected();
  const count = selected.size;
  if (count === 0) return;

  const action = activate ? 'activate' : 'deactivate';
  Modal.confirm({
    title: `Bulk ${activate ? 'Activate' : 'Deactivate'} Products`,
    message: `This will ${action} ${count} product${count > 1 ? 's' : ''}. Proceed?`,
    confirmLabel: `${activate ? 'Activate' : 'Deactivate'} ${count}`,
    confirmClass: activate ? 'admin-btn--primary' : 'admin-btn--danger',
    onConfirm: async () => {
      const ids = [...selected];
      let done = 0;
      let failed = 0;
      Toast.info(`${activate ? 'Activating' : 'Deactivating'} ${count} products\u2026`);
      // Build update payloads — backend requires retail_price & stock_quantity
      const payloads = ids.map(id => {
        const row = _table.data.find(r => String(r.id) === id);
        return {
          id,
          data: {
            is_active: activate,
            retail_price: row?.retail_price ?? 0,
            stock_quantity: row?.stock_quantity ?? 0,
          },
        };
      });
      // Process in batches of 5
      for (let i = 0; i < payloads.length; i += 5) {
        const batch = payloads.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map(p => AdminAPI.updateProduct(p.id, p.data))
        );
        for (const r of results) {
          if (r.status === 'fulfilled') done++;
          else failed++;
        }
      }
      if (_table) _table.clearSelection();
      updateBulkBar(new Set());
      if (failed > 0) {
        Toast.error(`${done} ${action}d, ${failed} failed`);
      } else {
        Toast.success(`${done} product${done > 1 ? 's' : ''} ${action}d`);
      }
      loadProducts();
    },
  });
}

async function bulkDelete() {
  if (!_table) return;
  const selected = _table.getSelected();
  const count = selected.size;
  if (count === 0) return;

  Modal.confirm({
    title: 'Delete Products',
    message: `This will permanently delete ${count} product${count > 1 ? 's' : ''}. This action cannot be undone. Proceed?`,
    confirmLabel: `Delete ${count}`,
    confirmClass: 'admin-btn--danger',
    onConfirm: async () => {
      const ids = [...selected];
      let done = 0;
      let failed = 0;
      Toast.info(`Deleting ${count} product${count > 1 ? 's' : ''}\u2026`);
      // Process in batches of 5
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map(id => AdminAPI.deleteProduct(id))
        );
        for (const r of results) {
          if (r.status === 'fulfilled') done++;
          else failed++;
        }
      }
      if (_table) _table.clearSelection();
      updateBulkBar(new Set());
      if (failed > 0) {
        Toast.error(`${done} deleted, ${failed} failed`);
      } else {
        Toast.success(`${done} product${done > 1 ? 's' : ''} deleted`);
      }
      loadProducts();
    },
  });
}

export default {
  title: 'Products & SKUs',

  async init(container) {
    _container = container;
    _page = 1;
    _search = '';

    // Load brands for filter + edit form
    const brandsData = await AdminAPI.getBrands();
    if (_container !== container) return; // destroyed or re-routed during await
    _brands = brandsData && Array.isArray(brandsData) ? brandsData : [];

    // Hide global filter bar — products page uses local toolbar instead
    FilterState.showBar(false);

    // Header with two-row layout: title+actions row, then filter toolbar
    const header = document.createElement('div');
    header.className = 'admin-page-header admin-page-header--with-toolbar';
    let brandOpts = '<option value="">All Brands</option>';
    for (const b of _brands) {
      const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
      brandOpts += `<option value="${esc(name)}">${esc(name)}</option>`;
    }
    header.innerHTML = `
      <div class="admin-page-header__top">
        <h1>Products &amp; SKUs</h1>
        <div class="admin-page-header__actions">
          <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-product-btn">${icon('products', 14, 14)} Add Product</button>
          ${exportDropdown('export-products')}
        </div>
      </div>
      <div class="admin-toolbar">
        <div class="admin-search" id="product-search-wrap">
          <span class="admin-search__icon">${icon('search', 14, 14)}</span>
          <input type="search" placeholder="Search\u2026" id="product-search">
        </div>
        <select class="admin-select" id="brand-filter">${brandOpts}</select>
        <select class="admin-select" id="active-filter">
          <option value="">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
        <select class="admin-select" id="image-filter">
          <option value="">All Images</option>
          <option value="no-images">No Images</option>
          <option value="has-images">Has Images</option>
        </select>
      </div>
    `;
    container.appendChild(header);

    // Table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'admin-mb-lg';
    container.appendChild(tableContainer);

    // Show skeleton diagnostics immediately (before data loads)
    renderDiagnostics(container);

    _table = new DataTable(tableContainer, {
      columns: buildColumns(),
      rowKey: 'id',
      selectable: true,
      onSelectionChange: (sel) => updateBulkBar(sel),
      onRowClick: (row) => openProductDrawer(row),
      onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadProducts(); },
      onPageChange: (page) => { _page = page; loadProducts(); },
      emptyMessage: 'No products found',
      emptyIcon: icon('products', 40, 40),
    });

    // Copy name buttons (event delegation)
    tableContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-name-btn');
      if (!btn) return;
      e.stopPropagation();
      const name = btn.dataset.copy;
      navigator.clipboard.writeText(name).then(() => Toast.success('Copied to clipboard')).catch(() => Toast.error('Copy failed'));
    });

    // Search
    const searchInput = header.querySelector('#product-search');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { _search = searchInput.value.trim(); _page = 1; loadProducts(); }, 300);
    });

    // Brand filter
    header.querySelector('#brand-filter').addEventListener('change', (e) => {
      _brandFilter = e.target.value; _page = 1; loadProducts();
    });

    // Active filter
    header.querySelector('#active-filter').addEventListener('change', (e) => {
      _activeFilter = e.target.value; _page = 1; loadProducts();
    });

    // Image filter
    header.querySelector('#image-filter').addEventListener('change', (e) => {
      _imageFilter = e.target.value; _page = 1; loadProducts();
    });

    // Export
    bindExportDropdown(header, 'export-products', handleExport);
    header.querySelector('#add-product-btn')?.addEventListener('click', () => openCreateProductModal());

    // Load products + try diagnostics endpoint
    const [, diag] = await Promise.allSettled([loadProducts(), AdminAPI.getProductDiagnostics()]);
    const raw = diag.value;
    _diagnostics = raw?.data ?? raw;

    // Compute diagnostics by paginating through all products
    try {
      let all = [];
      let page = 1;
      let totalFromApi = null;
      while (true) {
        const data = await AdminAPI.getProducts({}, page, 200);
        const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
        if (totalFromApi === null) {
          totalFromApi = data?.pagination?.total ?? data?.total ?? null;
        }
        if (rows.length === 0) break;
        all = all.concat(rows);
        if (all.length >= (totalFromApi || Infinity) || rows.length < 200) break;
        page++;
      }
      if (all.length > 0 || totalFromApi != null) {
        const hasCompatField = all.some(p => 'compatible_printers' in p || 'printer_count' in p);
        _diagnostics = {
          total: totalFromApi ?? all.length,
          active: all.filter(p => p.is_active !== false).length,
          missing_images: all.filter(p => !p.images?.length && !p.primary_image && !p.image_url).length,
          missing_prices: all.filter(p => p.retail_price == null).length,
          missing_weight: all.filter(p => !p.weight_kg && p.weight_kg !== 0).length,
          missing_compatibility: hasCompatField
            ? all.filter(p => !(p.compatible_printers?.length) && !(p.printer_count)).length
            : null,
          zero_stock: all.filter(p => (p.stock_quantity ?? 0) === 0).length,
          critical_stock: all.filter(p => (p.stock_quantity ?? 0) > 0 && (p.stock_quantity ?? 0) <= 5).length,
        };
      }
    } catch { /* ignore */ }

    if (_container !== container) return; // destroyed or re-routed during await
    renderDiagnostics(container);
  },

  destroy() {
    if (_table) _table.destroy();
    if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
    _table = null;
    _container = null;
    _search = '';
    _page = 1;
    _brandFilter = '';
    _activeFilter = '';
    _imageFilter = '';
    _brands = [];
    _diagnostics = null;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    // Sync the page-level search input
    const input = document.getElementById('product-search');
    if (input && input.value !== query) input.value = query;
    if (_table) loadProducts();
  },
};
