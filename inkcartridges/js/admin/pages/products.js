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
      className: 'cell-center',
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
  // Prefer page-level filter; fall back to global FilterState brands
  const globalBrands = FilterState.get('brands') || [];
  if (_brandFilter) {
    filters.brand = _brandFilter;
  } else if (globalBrands.length) {
    filters.brand = globalBrands.join(',');
  }
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
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="generate-image">${icon('download', 12, 12)} Generate</button>
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

  const tabs = ['Basic Info', 'Pricing', 'Inventory', 'SEO', 'Advanced'];
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
    ${formGroup('Meta Keywords', `<input class="admin-input" id="edit-meta-keywords" value="${esc(full.meta_keywords || '')}">`)}
  `;

  // Advanced panel
  let advancedHtml = `
    ${formGroup('Page Yield', `<input class="admin-input" id="edit-page-yield" type="number" min="0" value="${full.page_yield ?? ''}">`)}
    <div class="admin-form-group">
      <label id="compat-heading">Compatible Printers</label>
      <div class="admin-compat-printers" id="compat-printers"><span class="admin-text-muted">Loading&hellip;</span></div>
    </div>
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" value="${esc((full.tags || []).join(', '))}">`)}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3">${esc(full.admin_notes || '')}</textarea>`)}
  `;

  const panelContents = [basicHtml, pricingHtml, inventoryHtml, seoHtml, advancedHtml];
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

  // Async-load compatible printers (non-blocking)
  if (product.sku && window.API?.getCompatiblePrinters) {
    const container = modal.querySelector('#compat-printers');
    window.API.getCompatiblePrinters(product.sku).then(response => {
      const printers = response?.data?.compatible_printers || response?.data?.printers || response?.data || [];
      const count = Array.isArray(printers) ? printers.length : 0;
      const heading = modal.querySelector('#compat-heading');
      if (heading) heading.textContent = `Compatible Printers (${count})`;
      if (container) {
        if (count > 0) {
          container.innerHTML = printers.map(p => {
            const name = typeof p === 'string' ? p : (p.full_name || p.model_name || p.model || p.name || String(p));
            return `<span class="admin-badge">${esc(name)}</span>`;
          }).join('');
        } else {
          container.innerHTML = `
            <div style="background:var(--yellow-light,#fffbe6);border:1px solid var(--yellow,#f0a500);border-radius:6px;padding:10px 12px;font-size:0.85em;">
              <strong>No compatible printers found</strong><br>
              <span style="color:var(--text-muted);">This product has no printer associations in the database. It won't appear in printer-based searches or "You May Also Need" sections on the storefront.</span>
            </div>`;
        }
      }
    }).catch(() => {
      const container = modal.querySelector('#compat-printers');
      if (container) container.innerHTML = '<span class="admin-text-muted">Could not load</span>';
    });
  } else {
    const container = modal.querySelector('#compat-printers');
    if (container) container.innerHTML = '<span class="admin-text-muted">No SKU</span>';
  }

  // Bind image error fallbacks
  modal.querySelectorAll('img[data-fallback="broken-parent"]').forEach(img => {
    img.addEventListener('error', function() {
      this.parentElement.classList.add('admin-product-gallery__item--broken');
    }, { once: true });
  });

  // Generate image for this product
  modal.querySelector('[data-action="generate-image"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Generating\u2026';
    try {
      const success = await generateProductImage(product);
      if (success) {
        Toast.success('Image generated and saved');
        const updated = await AdminAPI.getProduct(product.id);
        if (updated) openProductDrawer(updated);
        loadProducts();
      }
    } catch (err) {
      Toast.error(`Image generation failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('download', 12, 12)} Generate`;
    }
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

  // Generate SEO
  modal.querySelector('[data-action="generate-seo"]')?.addEventListener('click', async () => {
    const seo = generateSEO(product);
    const data = {
      retail_price: product.retail_price,
      stock_quantity: product.stock_quantity ?? 0,
    };
    if (seo.meta_title) data.meta_title = seo.meta_title;
    if (seo.meta_description) data.meta_description = seo.meta_description;
    if (seo.meta_keywords) data.meta_keywords = seo.meta_keywords.substring(0, 200);

    try {
      await AdminAPI.updateProduct(product.id, data);
      const titleEl = modal.querySelector('#edit-meta-title');
      const descEl = modal.querySelector('#edit-meta-desc');
      const keywordsEl = modal.querySelector('#edit-meta-keywords');
      if (titleEl) titleEl.value = seo.meta_title;
      if (descEl) descEl.value = seo.meta_description;
      if (keywordsEl) keywordsEl.value = seo.meta_keywords;
      Toast.success('SEO generated and saved');
    } catch (e) {
      Toast.error(`SEO save failed: ${e.message}`);
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
      meta_keywords: val('edit-meta-keywords'),
      page_yield: numVal('edit-page-yield'),
      weight_kg: numVal('edit-weight'),
      tags: tagsArr,
      admin_notes: val('edit-admin-notes'),
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
}

async function uploadImage(productId, file) {
  await AdminAPI.uploadProductImage(productId, file);
  // Re-open drawer to refresh gallery
  const product = await AdminAPI.getProduct(productId);
  if (product) openProductDrawer(product);
}

function renderDiagnostics(container) {
  if (!_container || !AdminAuth.isOwner() || !_diagnostics) return;
  const d = _diagnostics;

  const section = document.createElement('div');
  section.className = 'admin-section';
  section.innerHTML = `
    <div class="admin-section__header">
      <h2 class="admin-section__title">Product Diagnostics</h2>
      <div style="display:flex;gap:8px">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-images-btn">${icon('download', 14, 14)} Generate Images</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-seo-btn">${icon('search', 14, 14)} Generate SEO</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-activate-btn">${icon('products', 14, 14)} Bulk Activate</button>
      </div>
    </div>
    <div class="admin-kpi-grid" style="grid-template-columns:repeat(4,1fr)">
      ${diagKpi('Total Products', d.total ?? d.total_products ?? MISSING)}
      ${diagKpi('Active', d.active ?? d.active_count ?? MISSING)}
      ${diagKpi('Missing Images', d.missing_images ?? MISSING)}
      ${diagKpi('Missing Prices', d.missing_prices ?? MISSING)}
    </div>
  `;
  // Remove any existing diagnostics section before inserting updated one
  container.querySelector(':scope > .admin-section.diag-section')?.remove();
  section.classList.add('diag-section');

  const ref = container.querySelector(':scope > .admin-mb-lg');
  if (ref) container.insertBefore(section, ref);
  else container.appendChild(section);

  section.querySelector('#bulk-images-btn')?.addEventListener('click', () => bulkGenerateImages());
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

function diagKpi(label, value) {
  return `<div class="admin-kpi" style="padding:12px 14px"><div class="admin-kpi__label">${esc(label)}</div><div class="admin-kpi__value" style="font-size:18px">${esc(String(value))}</div></div>`;
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

// ---- Product Image Generator ----

// Color map matching ProductColors from utils.js
const COLOR_HEX = {
  'black': '#1a1a1a', 'cyan': '#00bcd4', 'magenta': '#e91e63', 'yellow': '#ffeb3b',
  'red': '#f44336', 'blue': '#2196f3', 'green': '#4caf50', 'photo black': '#000000',
  'matte black': '#2d2d2d', 'light cyan': '#80deea', 'light magenta': '#f48fb1',
  'gray': '#9e9e9e', 'grey': '#9e9e9e', 'light gray': '#bdbdbd', 'light grey': '#bdbdbd',
};

// Multi-pack color arrays (ordered stripe colors)
const PACK_COLORS = {
  'cmy': ['#00bcd4', '#e91e63', '#ffeb3b'],
  'bcmy': ['#1a1a1a', '#00bcd4', '#e91e63', '#ffeb3b'],
  'kcmy': ['#1a1a1a', '#00bcd4', '#e91e63', '#ffeb3b'],
  'cmyk': ['#00bcd4', '#e91e63', '#ffeb3b', '#1a1a1a'],
  'tri-color': ['#00bcd4', '#e91e63', '#ffeb3b'],
  'tri-colour': ['#00bcd4', '#e91e63', '#ffeb3b'],
  '4-pack': ['#1a1a1a', '#00bcd4', '#e91e63', '#ffeb3b'],
  '4 pack': ['#1a1a1a', '#00bcd4', '#e91e63', '#ffeb3b'],
  'color': ['#00bcd4', '#e91e63', '#ffeb3b'],
  'colour': ['#00bcd4', '#e91e63', '#ffeb3b'],
};

function detectProductColor(product) {
  const color = (product.color || '').toLowerCase().trim();
  if (PACK_COLORS[color]) return { type: 'pack', colors: PACK_COLORS[color] };
  if (COLOR_HEX[color]) return { type: 'single', hex: COLOR_HEX[color] };
  // Detect from name
  if (typeof ProductColors !== 'undefined') {
    const detected = ProductColors.detectFromName(product.name);
    if (detected) {
      if (PACK_COLORS[detected]) return { type: 'pack', colors: PACK_COLORS[detected] };
      if (COLOR_HEX[detected]) return { type: 'single', hex: COLOR_HEX[detected] };
    }
  }
  return null;
}

function renderColorCanvas(colorInfo, size = 400) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size * 0.06; // rounded corner radius

  // Clipping path with rounded corners
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.clip();

  if (colorInfo.type === 'single') {
    ctx.fillStyle = colorInfo.hex;
    ctx.fillRect(0, 0, size, size);
  } else if (colorInfo.type === 'pack') {
    const count = colorInfo.colors.length;
    const stripeW = size / count;
    colorInfo.colors.forEach((hex, i) => {
      ctx.fillStyle = hex;
      ctx.fillRect(i * stripeW, 0, stripeW + 1, size); // +1 to prevent gaps
    });
  }

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

async function generateProductImage(product, silent = false) {
  const source = (product.source || '').toLowerCase();
  const isCompatible = source === 'compatible' || source === 'remanufactured' ||
    (product.name || '').toLowerCase().startsWith('compatible ') ||
    (product.sku || '').match(/^I[A-Z]/);
  const isGenuine = source === 'genuine' && !isCompatible;
  const isPack = /pack|value\s*pack|combo/i.test(product.name || '');

  // Compatible products: generate color block/stripes
  if (isCompatible) {
    const colorInfo = detectProductColor(product);
    if (!colorInfo) {
      if (!silent) Toast.error('Cannot detect color for this product');
      return false;
    }
    const canvas = renderColorCanvas(colorInfo);
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], `${product.sku || 'product'}-color.jpg`, { type: 'image/jpeg' });
    await AdminAPI.uploadProductImage(product.id, file);
    return true;
  }

  // Genuine packs: find individual genuine products and composite their images
  if (isGenuine && isPack) {
    // Extract cartridge code from name
    const codeMatch = (product.name || '').match(/\b([A-Z]{1,3}[\-]?\d{2,5}[A-Z]*(?:XL)?)\b/i);
    if (!codeMatch) {
      if (!silent) Toast.error('Cannot extract cartridge code from product name');
      return false;
    }
    const code = codeMatch[1];
    const brand = (product.brand_name || (typeof product.brand === 'object' ? product.brand?.name : product.brand) || '').toLowerCase().replace(/\s+/g, '-');

    // Search for individual genuine products with this code
    const searchResp = await AdminAPI.getProducts({ search: code, brand: brand }, 1, 50);
    const allResults = Array.isArray(searchResp) ? searchResp : (searchResp?.products || searchResp?.data || []);

    // Filter to individual genuine products (not packs) with images
    const singles = allResults.filter(p => {
      const pSource = (p.source || '').toLowerCase();
      const pName = (p.name || '').toLowerCase();
      return pSource === 'genuine' && !(/pack|value\s*pack|combo/i.test(pName)) && (p.images?.length || p.primary_image || p.image_url);
    });

    if (singles.length === 0) {
      if (!silent) Toast.error('No individual genuine product images found for this pack');
      return false;
    }

    // Upload each individual product's image as an image for this pack
    let uploaded = 0;
    for (const single of singles) {
      const imgRaw = single.primary_image || single.image_url || (single.images?.[0]?.image_url || single.images?.[0]?.url || (single.images?.[0]?.path && typeof storageUrl === 'function' ? storageUrl(single.images?.[0]?.path) : single.images?.[0]?.path) || single.images?.[0]);
      const imgUrl = imgRaw;
      if (!imgUrl || typeof imgUrl !== 'string') continue;

      try {
        // Fetch the image and re-upload it
        const resp = await fetch(imgUrl);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const ext = imgUrl.split('.').pop()?.split('?')[0] || 'png';
        const file = new File([blob], `${product.sku || 'pack'}-${single.sku || uploaded}.${ext}`, { type: blob.type || 'image/png' });
        await AdminAPI.uploadProductImage(product.id, file);
        uploaded++;
      } catch { /* skip failed images */ }
    }

    if (uploaded === 0) {
      if (!silent) Toast.error('Failed to fetch individual product images');
      return false;
    }
    return true;
  }

  // Genuine single product: generate color block as fallback
  if (isGenuine && !isPack) {
    const colorInfo = detectProductColor(product);
    if (!colorInfo) {
      if (!silent) Toast.error('No color detected and not a pack product — upload an image manually');
      return false;
    }
    const canvas = renderColorCanvas(colorInfo);
    const blob = await canvasToBlob(canvas);
    const file = new File([blob], `${product.sku || 'product'}-color.jpg`, { type: 'image/jpeg' });
    await AdminAPI.uploadProductImage(product.id, file);
    return true;
  }

  if (!silent) Toast.error('Cannot generate image for this product type');
  return false;
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
  // Pattern: "{Brand} {Code} {Type} - {Source} | InkCartridges NZ"
  let metaTitle;
  if (code && sourceLabel) {
    metaTitle = `${brand} ${code} ${typeLabel} - ${sourceLabel} | InkCartridges NZ`;
  } else if (code) {
    metaTitle = `${brand} ${code} ${typeLabel} | InkCartridges NZ`;
  } else {
    metaTitle = `${name} | InkCartridges NZ`;
  }
  // Trim if too long
  if (metaTitle.length > 60) {
    metaTitle = `${brand} ${code || name.split(' ').slice(1, 3).join(' ')} | InkCartridges NZ`;
  }

  // ---- Meta Description (150-160 chars ideal) ----
  const colorPart = color ? ` ${color}` : '';
  const sourcePart = sourceLabel ? `${sourceLabel.toLowerCase()} ` : '';
  let metaDesc;
  if (type === 'ribbon') {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name}${colorPart} printer ribbon online at InkCartridges.co.nz. Fast NZ-wide delivery. Free shipping over $100.`;
  } else if (type === 'drum_unit') {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name} drum unit online at InkCartridges.co.nz. Fast NZ-wide delivery. Free shipping over $100.`;
  } else {
    metaDesc = `Buy ${sourcePart}${brand} ${code || name}${colorPart} ${typeLabel.toLowerCase()} online at InkCartridges.co.nz. Fast NZ-wide delivery. Free shipping over $100.`;
  }
  if (metaDesc.length > 160) {
    metaDesc = metaDesc.substring(0, 157) + '...';
  }

  // ---- Meta Keywords ----
  const keywords = new Set();
  if (brand) {
    keywords.add(`${brand} ${type} cartridge`.toLowerCase());
    keywords.add(`${brand} ink`.toLowerCase());
    keywords.add(`buy ${brand} ink nz`.toLowerCase());
  }
  if (code) {
    keywords.add(`${brand} ${code}`.toLowerCase());
    keywords.add(`${code} cartridge`.toLowerCase());
    keywords.add(`${code} ${type}`.toLowerCase());
  }
  if (sourceLabel) {
    keywords.add(`${sourceLabel} ${brand} ${type}`.toLowerCase());
  }
  if (color && color.toLowerCase() !== 'n/a') {
    keywords.add(`${brand} ${color} ${type}`.toLowerCase());
  }
  keywords.add(`printer ${type} nz`.toLowerCase());
  keywords.add('ink cartridges nz');
  let metaKeywords = [...keywords].join(', ');
  // Backend limit: 200 chars — trim to last full keyword
  if (metaKeywords.length > 200) {
    metaKeywords = metaKeywords.substring(0, 200);
    const lastComma = metaKeywords.lastIndexOf(',');
    if (lastComma > 0) metaKeywords = metaKeywords.substring(0, lastComma);
  }

  return { meta_title: metaTitle.trim(), meta_description: metaDesc.trim(), meta_keywords: metaKeywords.trim() };
}

async function bulkGenerateImages() {
  // First, scan to find products needing images
  Toast.info('Scanning products for missing images\u2026');
  let allProducts = [];
  try {
    let page = 1;
    while (true) {
      const data = await AdminAPI.getProducts({}, page, 200);
      const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
      if (rows.length === 0) break;
      allProducts = allProducts.concat(rows);
      const total = data?.pagination?.total ?? data?.total ?? 0;
      if (allProducts.length >= total || rows.length < 200) break;
      page++;
    }
  } catch (e) {
    Toast.error(`Failed to scan products: ${e.message}`);
    return;
  }

  // Filter to compatible products without any images (genuine/original images are added manually)
  const isCompatibleProduct = (p) => {
    const src = (p.source || '').toLowerCase();
    if (src === 'compatible' || src === 'remanufactured') return true;
    // Fallback: detect by name if source field is missing/null
    if ((p.name || '').toLowerCase().startsWith('compatible ')) return true;
    // Fallback: detect by SKU prefix (compatible SKUs start with 'I')
    if ((p.sku || '').match(/^I[A-Z]/)) return true;
    return false;
  };

  const noImage = allProducts.filter(p =>
    (!p.images || p.images.length === 0) && !p.primary_image && !p.image_url
  );
  const needsImages = noImage.filter(p => isCompatibleProduct(p));

  // Debug: log what we found to help diagnose issues
  const skippedGenuine = noImage.length - needsImages.length;
  DebugLog.log(`[BulkImages] ${allProducts.length} total products, ${noImage.length} without images, ${needsImages.length} compatible, ${skippedGenuine} genuine/unknown skipped`);
  if (noImage.length > 0 && needsImages.length === 0) {
    // Log a sample to help debug source field values
    const sample = noImage.slice(0, 5).map(p => ({ name: p.name, source: p.source, sku: p.sku }));
    DebugLog.log('[BulkImages] Sample products without images (source field check):', sample);
  }

  if (needsImages.length === 0) {
    Toast.success(`All compatible products already have images! (${skippedGenuine} genuine products without images skipped)`);
    return;
  }

  // Build preview of first 3 products
  const previewItems = needsImages.slice(0, 3);
  let previewHTML = `
    <p style="margin:0 0 12px;color:var(--text-secondary)">
      Found <strong>${needsImages.length}</strong> compatible products without images.<br>
      Color block/stripe images will be generated.<br>
      Genuine/original products are skipped (add images manually).
    </p>
    <div style="margin:12px 0;border:1px solid var(--steel-200,#e2e8f0);border-radius:6px;overflow:hidden">
      <div style="padding:6px 10px;background:var(--steel-100,#f1f5f9);font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">Preview (${Math.min(3, needsImages.length)} of ${needsImages.length})</div>`;
  for (const p of previewItems) {
    const brand = typeof p.brand === 'object' ? p.brand?.name : p.brand || '';
    const color = detectProductColor(p);
    const colorDot = color?.hex
      ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color.hex};border:1px solid rgba(0,0,0,0.15);vertical-align:middle;margin-right:4px"></span>`
      : '';
    previewHTML += `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-top:1px solid var(--steel-200,#e2e8f0)">
        ${colorDot}
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name || '')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(p.sku || '')} · ${esc(brand)}</div>
        </div>
      </div>`;
  }
  if (needsImages.length > 3) {
    previewHTML += `<div style="padding:6px 10px;font-size:11px;color:var(--text-muted);border-top:1px solid var(--steel-200,#e2e8f0)">…and ${needsImages.length - 3} more</div>`;
  }
  previewHTML += `</div><p style="margin:8px 0 0;font-size:13px;color:var(--text-muted)">This may take several minutes.</p>`;

  const modal = Modal.open({
    title: 'Bulk Generate Images',
    body: previewHTML,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm">Generate ${needsImages.length} Images</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
    const btn = modal.footer.querySelector('[data-action="confirm"]');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      await (async () => {
      let generated = 0;
      let skipped = 0;
      let failed = 0;
      const total = needsImages.length;

      Toast.info(`Generating images: 0 / ${total}\u2026`);

      for (let i = 0; i < needsImages.length; i++) {
        const product = needsImages[i];

        // Update progress every 10 products
        if (i > 0 && i % 10 === 0) {
          Toast.info(`Generating images: ${i} / ${total} (${generated} done, ${skipped} skipped, ${failed} failed)\u2026`);
        }

        try {
          const result = await generateProductImage(product, true);
          if (result) {
            generated++;
          } else {
            skipped++;
          }
        } catch {
          failed++;
        }

        // Small delay to avoid overwhelming the backend
        if (i % 5 === 4) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Final summary
      if (generated > 0) {
        Toast.success(`Done! ${generated} images generated, ${skipped} skipped, ${failed} failed`);
      } else if (skipped > 0) {
        Toast.info(`No images generated. ${skipped} products skipped (no color detected or no pack components found). ${failed} failed.`);
      } else {
        Toast.error(`Image generation failed for all ${total} products`);
      }

      // Refresh the diagnostics and product list
      loadProducts();

      // Update diagnostics count
      if (_diagnostics) {
        _diagnostics.missing_images = Math.max(0, (_diagnostics.missing_images || 0) - generated);
        renderDiagnostics(_container);
      }
      })();
    } catch (e) {
      DebugLog.error('[BulkImages] error:', e);
    }
    Modal.close();
  });
}

async function bulkGenerateSEO() {
  Modal.confirm({
    title: 'Generate SEO Metadata',
    message: 'This will auto-generate meta titles, descriptions, and keywords for all products missing SEO data. Existing metadata will NOT be overwritten. Continue?',
    confirmLabel: 'Generate SEO',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      Toast.info('Scanning products\u2026');

      try {
        // Fetch all products
        let page = 1;
        let allProducts = [];
        while (true) {
          const data = await AdminAPI.getProducts({}, page, 200);
          const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
          if (rows.length === 0) break;
          allProducts = allProducts.concat(rows);
          const total = data?.pagination?.total || data?.total || 0;
          if (allProducts.length >= total || rows.length < 200) break;
          page++;
        }

        // Filter to products missing SEO
        const needsSEO = allProducts.filter(p =>
          !p.meta_title || !p.meta_description || !p.meta_keywords
        );

        if (needsSEO.length === 0) {
          Toast.success('All products already have SEO metadata!');
          return;
        }

        Toast.info(`Generating SEO for ${needsSEO.length} products\u2026`);

        let updated = 0;
        let failed = 0;

        for (const product of needsSEO) {
          // Fetch full product detail for better data
          const full = await AdminAPI.getProduct(product.id) || product;
          const seo = generateSEO(full);
          const data = {
            retail_price: full.retail_price,
            stock_quantity: full.stock_quantity ?? 0,
          };

          // Only fill in missing fields
          let hasNew = false;
          if (!full.meta_title) { data.meta_title = seo.meta_title; hasNew = true; }
          if (!full.meta_description) { data.meta_description = seo.meta_description; hasNew = true; }
          if (!full.meta_keywords) { data.meta_keywords = seo.meta_keywords; hasNew = true; }

          if (!hasNew) continue;

          try {
            await AdminAPI.updateProduct(product.id, data);
            updated++;
          } catch {
            failed++;
          }
        }

        if (failed > 0) {
          Toast.info(`Done: ${updated} updated, ${failed} failed`);
        } else {
          Toast.success(`SEO generated for ${updated} products`);
        }
        loadProducts();
      } catch (e) {
        Toast.error(`SEO generation failed: ${e.message}`);
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

    // Header with filters
    const header = document.createElement('div');
    header.className = 'admin-page-header';
    let brandOpts = '<option value="">All Brands</option>';
    for (const b of _brands) {
      const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
      brandOpts += `<option value="${esc(name)}">${esc(name)}</option>`;
    }
    header.innerHTML = `
      <h1>Products & SKUs</h1>
      <div class="admin-page-header__actions">
        <div style="position:relative">
          <input class="admin-input" type="search" placeholder="Search products\u2026" id="product-search" style="width:200px;padding-left:32px">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-muted)">${icon('search', 14, 14)}</span>
        </div>
        <select class="admin-select" id="brand-filter" style="width:140px">${brandOpts}</select>
        <select class="admin-select" id="active-filter" style="width:120px">
          <option value="">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
        <select class="admin-select" id="image-filter" style="width:140px">
          <option value="">All Images</option>
          <option value="no-images">No Images</option>
          <option value="has-images">Has Images</option>
        </select>
        ${exportDropdown('export-products')}
      </div>
    `;
    container.appendChild(header);

    // Table
    const tableContainer = document.createElement('div');
    tableContainer.className = 'admin-mb-lg';
    container.appendChild(tableContainer);

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
        _diagnostics = {
          total: totalFromApi ?? all.length,
          active: all.filter(p => p.is_active !== false).length,
          missing_images: all.filter(p => !p.images?.length && !p.primary_image && !p.image_url).length,
          missing_prices: all.filter(p => p.retail_price == null).length,
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

  async onFilterChange() {
    // Sync page-level brand dropdown with global filter
    const globalBrands = FilterState.get('brands') || [];
    const brandSelect = document.getElementById('brand-filter');
    if (brandSelect && globalBrands.length === 1) {
      brandSelect.value = globalBrands[0];
      _brandFilter = globalBrands[0];
    } else if (brandSelect && globalBrands.length === 0 && !_brandFilter) {
      brandSelect.value = '';
    }
    _page = 1;
    if (_table) await loadProducts();
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
