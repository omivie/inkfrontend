/**
 * Products & SKUs Page — Full CRUD with image management
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { RichTextEditor } from '../components/rich-text-editor.js';
import { computeProfitability, marginBadge, markupBadge, formatProfitDollars } from '../utils/profitability.js';

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
let _compatController = null;
let _page = 1;
let _search = '';
let _sort = 'name';
let _sortDir = 'asc';
let _brandFilter = '';
let _activeFilter = '';
let _imageFilter = '';
let _sourceFilter = '';
let _typeFilter = '';
let _stockFilter = '';
let _brands = [];
let _diagnostics = null;
let _bulkBar = null;
let _activeProductTab = 'products'; // products | ribbons | review
let _subProductModule = null;
const DIAG_CACHE_KEY = 'admin_product_diagnostics';

function invalidateDiagCache() {
  localStorage.removeItem(DIAG_CACHE_KEY);
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
      key: 'name', label: 'Name', sortable: true, className: 'col-w-name',
      render: (r) => `<div style="display:flex;align-items:center;gap:6px;min-width:0"><button class="copy-name-btn" data-copy="${esc(r.name || '')}" title="Copy name" style="margin:0;flex-shrink:0">${icon('copy', 15, 15)}</button><span class="cell-truncate" style="display:block;flex:1;min-width:0;max-width:280px">${esc(r.name || MISSING)}</span></div>`,
    },
    {
      key: 'sku', label: 'SKU', sortable: true, className: 'col-w-sku',
      render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>`,
    },
    {
      key: 'brand', label: 'Brand', sortable: true, className: 'col-w-brand',
      render: (r) => {
        const brand = extractBrandName(r);
        return brand ? `<span class="admin-badge admin-badge--processing">${esc(brand)}</span>` : MISSING;
      },
    },
    {
      key: 'retail_price', label: 'Price', sortable: true, className: 'col-w-price',
      render: (r) => {
        const price = r.retail_price ?? r.cost_price;
        return `<span class="cell-mono cell-right">${price != null ? formatPrice(price) : MISSING}</span>`;
      },
      align: 'right',
    },
  ];

  if (isOwner) {
    cols.push({
      key: 'cost_price', label: 'Cost', sortable: true, className: 'col-w-price',
      render: (r) => `<span class="cell-mono cell-right">${r.cost_price != null ? formatPrice(r.cost_price) : MISSING}</span>`,
      align: 'right',
    });
    cols.push({
      key: 'margin_pct', label: 'Margin %', sortable: true, className: 'col-w-pct',
      render: (r) => {
        const { marginPct } = computeProfitability(r);
        return marginPct == null ? MISSING : marginBadge(marginPct);
      },
      align: 'right',
    });
    cols.push({
      key: 'markup_pct', label: 'Markup %', sortable: true, className: 'col-w-pct',
      render: (r) => {
        const { markupPct } = computeProfitability(r);
        return markupPct == null ? MISSING : markupBadge(markupPct);
      },
      align: 'right',
    });
    cols.push({
      key: 'profit_ex_gst', label: 'Profit $', sortable: true, className: 'col-w-pct',
      render: (r) => {
        const { profitDollars } = computeProfitability(r);
        return `<span class="cell-mono cell-right">${formatProfitDollars(profitDollars)}</span>`;
      },
      align: 'right',
    });
  }

  cols.push({
    key: 'source', label: 'Type', sortable: true, className: 'col-w-type',
    render: (r) => {
      if (!r.source) return MISSING;
      const sourceMap = { genuine: 'genuine', compatible: 'compatible', remanufactured: 'remanufactured', ribbon: 'ribbon' };
      const cls = sourceMap[r.source] || 'compatible';
      return `<span class="source-badge source-badge--${cls}">${esc(r.source)}</span>`;
    },
  });

  cols.push(
    {
      key: 'is_active', label: 'Active', sortable: true, className: 'col-w-dot',
      render: (r) => {
        const active = r.is_active !== false;
        return `<span class="admin-active-dot admin-active-dot--${active ? 'on' : 'off'}" data-tooltip="${active ? 'Active' : 'Inactive'}"></span>`;
      },
      align: 'center',
    },
    {
      key: 'import_locked', label: 'Lock', sortable: true, className: 'cell-center col-w-dot',
      render: (r) => {
        const locked = !!r.import_locked;
        const isRibbon = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'].includes(r.product_type);
        const lockedTitle = isRibbon
          ? 'Locked \u2014 import skips this product entirely'
          : 'Price locked \u2014 import updates other fields but preserves price';
        const unlockedTitle = isRibbon
          ? 'Not locked \u2014 import will update this product'
          : 'Price unlocked \u2014 import will update all fields including price';
        return `<button class="import-lock-btn${locked ? ' import-lock-btn--active' : ''}${!isRibbon ? ' import-lock-btn--price' : ''}" data-product-id="${r.id}" data-locked="${locked}" data-ribbon="${isRibbon}" title="${locked ? lockedTitle : unlockedTitle}">${icon(locked ? 'lock' : 'lock-open', 14, 14)}${!isRibbon ? '<span class="import-lock-btn__marker">$</span>' : ''}</button>`;
      },
      align: 'center',
    },
    {
      key: 'compat', label: 'Compat', sortable: false, className: 'col-w-compat',
      render: (r) => `<span class="admin-text-muted" data-compat-sku="${esc(r.sku || '')}" style="font-size:0.75rem;">—</span>`,
      align: 'center',
    },
  );

  return cols;
}

async function loadCompatCounts() {
  if (_compatController) _compatController.abort();
  _compatController = new AbortController();
  const signal = _compatController.signal;

  const cells = document.querySelectorAll('[data-compat-sku]');
  if (!cells.length) return;
  const batch = 5;
  const arr = Array.from(cells);
  for (let i = 0; i < arr.length; i += batch) {
    if (signal.aborted) return;
    const slice = arr.slice(i, i + batch);
    await Promise.all(slice.map(async (cell) => {
      if (signal.aborted) return;
      const sku = cell.dataset.compatSku;
      if (!sku) return;
      try {
        const res = await window.API.getCompatiblePrinters(sku);
        if (signal.aborted) return;
        const printers = res?.data?.compatible_printers || res?.data?.printers || [];
        const count = Array.isArray(printers) ? printers.length : 0;
        if (count > 0) {
          cell.outerHTML = `<span class="admin-badge admin-badge--delivered" style="font-size:0.72rem;">${count} printer${count !== 1 ? 's' : ''}</span>`;
        } else {
          cell.outerHTML = `<span class="admin-badge admin-badge--pending" style="font-size:0.72rem;">⚠ None</span>`;
        }
      } catch {
        if (!signal.aborted) cell.outerHTML = `<span class="admin-text-muted" style="font-size:0.72rem;">—</span>`;
      }
    }));
    if (i + batch < arr.length && !signal.aborted) await new Promise(r => setTimeout(r, 300));
  }
}

function productHasImage(p) {
  if (p.images && p.images.length > 0) return true;
  if (p.primary_image || p.image_url) return true;
  return false;
}

async function loadProducts() {
  _table.setLoading(true);
  const LIMIT = 100;

  // Backend route: server handles margin/markup/profit sort and has_images filter
  // (avoids fetching the entire products table to JS just to sort/filter in memory).
  const needsBackend =
    _sort === 'margin_pct' || _sort === 'markup_pct' || _sort === 'profit_ex_gst' ||
    !!_imageFilter || !!_sourceFilter || !!_typeFilter || !!_stockFilter;
  if (needsBackend) {
    const filters = { search: _search, sort: _sort, order: _sortDir };
    if (_brandFilter) filters.brand = _brandFilter;
    if (_activeFilter !== '') filters.active = _activeFilter;
    if (_imageFilter === 'has-images') filters.has_images = 'true';
    else if (_imageFilter === 'no-images') filters.has_images = 'false';
    if (_sourceFilter) filters.source = _sourceFilter;
    if (_typeFilter) filters.product_type = _typeFilter;
    if (_stockFilter) filters.stock_status = _stockFilter;
    const data = await AdminAPI.getProducts(filters, _page, LIMIT);
    if (!_table) return;
    if (!data) { _table.setData([], null); return; }
    const rows = Array.isArray(data) ? data : (data.products || data.data || []);
    const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: LIMIT };
    _table.setData(rows, pagination);
    loadCompatCounts();
    return;
  }

  // Try direct Supabase query first (faster — skips Render backend hop)
  const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
  if (sb) {
    try {
      const selectCols = 'id, sku, name, retail_price, cost_price, is_active, import_locked, image_url, color, source, weight_kg, page_yield, category, product_type, brand_id, description, description_html, compatible_devices_html, compare_price, meta_title, meta_description, tags, internal_notes, brands(name, slug)';
      let query = sb.from('products').select(selectCols, { count: 'exact' });

      // Brand filter
      if (_brandFilter) query = query.eq('brand_id', _brandFilter);

      // Search filter
      if (_search) query = query.or(`name.ilike.%${_search}%,sku.ilike.%${_search}%`);

      // Active filter
      if (_activeFilter !== '') query = query.eq('is_active', _activeFilter === 'true');

      // Sorting — map column keys to DB columns. Margin/markup/profit and image
      // filters are routed to the backend earlier (see needsBackend), so we don't
      // handle them here.
      const sortMap = { brand: 'brand_id' };
      const sortCol = sortMap[_sort] || _sort || 'name';
      query = query.order(sortCol, { ascending: _sortDir !== 'desc' });

      // Pagination
      const offset = (_page - 1) * LIMIT;
      query = query.range(offset, offset + LIMIT - 1);

      const { data: rows, count, error } = await query;
      if (!_table) return;
      if (error) throw error;

      // Map brand names and resolve image URLs from joined brands table
      const mapped = (rows || []).map(p => ({
        ...p,
        brand_name: p.brands?.name || '',
        image_url: p.image_url ? storageUrl(p.image_url) : null,
      }));
      const pagination = { total: count || mapped.length, page: _page, limit: LIMIT };
      _table.setData(mapped, pagination);
      loadCompatCounts();
      return;
    } catch (e) {
      // Fall through to backend API
    }
  }

  // Fallback: use backend API
  const filters = { search: _search, sort: _sort, order: _sortDir };
  if (_brandFilter) filters.brand = _brandFilter;
  if (_activeFilter !== '') filters.active = _activeFilter;
  const data = await AdminAPI.getProducts(filters, _page, LIMIT);
  if (!_table) return;
  if (!data) { _table.setData([], null); return; }
  const rows = Array.isArray(data) ? data : (data.products || data.data || []);
  const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: LIMIT };
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
  // Resume compat count loading for any cells still showing placeholders
  loadCompatCounts();
}

async function openProductDrawer(product) {
  // Close any existing modal first
  if (_activeModal) closeProductModal();
  // Pause background compat loading so modal API calls aren't rate-limited
  if (_compatController) _compatController.abort();

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

  // Fetch full product data — merge with list data so Supabase-only fields
  // (description_html, compatible_devices_html) aren't lost
  const apiData = await AdminAPI.getProduct(product.id);
  const full = apiData ? { ...product, ...apiData } : product;
  const isOwner = AdminAuth.isOwner();

  // Update title with full name
  modal.querySelector('.admin-product-modal__title').textContent = full.name || full.sku || 'Product';

  // Insert import lock toggle in header
  const isRibbonProduct = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'].includes(full.product_type);
  const lockTitle = (locked) => {
    if (isRibbonProduct) return locked ? 'Locked \u2014 import skips this product entirely' : 'Not locked \u2014 import will update this product';
    return locked ? 'Price locked \u2014 import updates other fields but preserves price' : 'Price unlocked \u2014 import will update all fields including price';
  };
  const lockLabel = (locked) => {
    if (isRibbonProduct) return locked ? 'Locked' : 'Unlocked';
    return locked ? 'Price locked' : 'Price unlocked';
  };
  const lockBtn = document.createElement('button');
  lockBtn.className = 'import-lock-toggle' + (full.import_locked ? ' import-lock-toggle--active' : '') + (isRibbonProduct ? '' : ' import-lock-toggle--price');
  lockBtn.title = lockTitle(full.import_locked);
  lockBtn.innerHTML = `${icon(full.import_locked ? 'lock' : 'lock-open', 14, 14)}<span class="import-lock-toggle__label">${lockLabel(full.import_locked)}</span>`;
  const headerActions = modal.querySelector('.admin-product-modal__actions');
  headerActions.parentNode.insertBefore(lockBtn, headerActions);

  lockBtn.addEventListener('click', async () => {
    lockBtn.disabled = true;
    try {
      const result = await AdminAPI.toggleImportLock(full.id);
      const locked = !!result.import_locked;
      full.import_locked = locked;
      lockBtn.className = 'import-lock-toggle' + (locked ? ' import-lock-toggle--active' : '') + (isRibbonProduct ? '' : ' import-lock-toggle--price');
      lockBtn.title = lockTitle(locked);
      lockBtn.innerHTML = `${icon(locked ? 'lock' : 'lock-open', 14, 14)}<span class="import-lock-toggle__label">${lockLabel(locked)}</span>`;
      if (_table) {
        const row = _table.data.find(r => String(r.id) === String(full.id));
        if (row) row.import_locked = locked;
        const tableBtn = document.querySelector(`.import-lock-btn[data-product-id="${full.id}"]`);
        if (tableBtn) {
          tableBtn.dataset.locked = String(locked);
          tableBtn.classList.toggle('import-lock-btn--active', locked);
          tableBtn.innerHTML = `${icon(locked ? 'lock' : 'lock-open', 14, 14)}${!isRibbonProduct ? '<span class="import-lock-btn__marker">$</span>' : ''}`;
        }
      }
      Toast.success(locked ? (isRibbonProduct ? 'Import locked' : 'Price locked') : (isRibbonProduct ? 'Import unlocked' : 'Price unlocked'));
    } catch (err) {
      Toast.error(`Lock toggle failed: ${err.message}`);
    } finally {
      lockBtn.disabled = false;
    }
  });

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

  // Build tabs (Basic Info, Description, For Use In, Pricing, Inventory, SEO, Advanced — no Compatibility/FAQ)
  const tabsEl = modal.querySelector('#pm-tabs');
  const panelsEl = modal.querySelector('#pm-panels');
  const tabNames = ['Basic Info', 'Description', 'For Use In', 'Pricing', 'Inventory', 'SEO', 'Advanced'];
  const empty = {};

  tabsEl.innerHTML = tabNames.map((t, i) =>
    `<button class="admin-product-modal__tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t)}</button>`
  ).join('');

  const basicHtml = `
    <div class="admin-form-row">
      <div class="admin-form-group"><label>SKU<span class="required-star">*</span></label><input class="admin-input" id="edit-sku" placeholder="e.g. LC-3317BK"></div>
      <div class="admin-form-group"><label>Name<span class="required-star">*</span></label><input class="admin-input" id="edit-name" placeholder="Product name"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Brand', buildBrandSelect(null))}
      ${formGroup('Product Type', buildSelect('edit-type', [
        { value: 'ink_cartridge',    label: 'Ink Cartridge' },
        { value: 'ink_bottle',       label: 'Ink Bottle' },
        { value: 'toner_cartridge',  label: 'Toner Cartridge' },
        { value: 'drum_unit',        label: 'Drum Unit' },
        { value: 'waste_toner',      label: 'Waste Toner' },
        { value: 'belt_unit',        label: 'Belt Unit' },
        { value: 'fuser_kit',        label: 'Fuser Kit' },
        { value: 'fax_film',         label: 'Fax Film' },
        { value: 'fax_film_refill',  label: 'Fax Film Refill' },
        { value: 'printer_ribbon',   label: 'Printer Ribbon' },
        { value: 'typewriter_ribbon', label: 'Typewriter Ribbon' },
        { value: 'correction_tape',  label: 'Correction Tape' },
        { value: 'label_tape',       label: 'Label Tape' },
        { value: 'photo_paper',      label: 'Photo Paper' },
        { value: 'printer',          label: 'Printer' },
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
      ${formGroup('Weight (kg)', `<input class="admin-input" id="edit-weight" type="number" step="0.01" min="0" placeholder="0.00">`)}
      <div class="admin-form-group"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Active', toggleHtml('edit-active', true))}
      <div class="admin-form-group"></div>
    </div>
  `;

  const seoHtml = `
    ${formGroup('Meta Title', `<input class="admin-input" id="edit-meta-title" placeholder="Page title for search results">`)}
    ${formGroup('Meta Description', `<textarea class="admin-textarea" id="edit-meta-desc" rows="3" placeholder="Brief description for search results\u2026"></textarea>`)}
  `;

  const descHtml = `
    <div class="admin-form-group">
      <label>Product Description (Rich Text)</label>
      <div id="desc-editor-mount"></div>
    </div>
  `;

  const forUseInHtml = `
    <div class="admin-form-group">
      <label>Compatible Devices / For Use In</label>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Paste text or HTML listing compatible devices. Formatting is preserved as-is on the product page.</p>
      <div id="compat-editor-mount"></div>
    </div>
  `;

  const advancedHtml = `
    ${formGroup('Page Yield', `<input class="admin-input" id="edit-page-yield" type="number" min="0" placeholder="e.g. 300">`)}
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" placeholder="e.g. black, compatible, brother">`)}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3" placeholder="Notes visible only to admins\u2026"></textarea>`)}
  `;

  panelsEl.innerHTML = [basicHtml, descHtml, forUseInHtml, pricingHtml, inventoryHtml, seoHtml, advancedHtml].map((content, i) =>
    `<div class="admin-product-modal__tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${content}</div>`
  ).join('');

  // Mount rich text editors for create modal
  const descMount = modal.querySelector('#desc-editor-mount');
  if (descMount) {
    modal._descEditor = new RichTextEditor(descMount, {
      placeholder: 'Enter product description with formatting\u2026',
      minHeight: 400,
    });
  }
  const compatMount = modal.querySelector('#compat-editor-mount');
  if (compatMount) {
    modal._compatEditor = new RichTextEditor(compatMount, {
      placeholder: 'Paste or type compatible devices\u2026',
      minHeight: 400,
    });
  }

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
      requireField('edit-retail-price', 3, 'A valid retail price is required');
      return;
    }

    const sku = val('edit-sku');
    const name = val('edit-name');
    const tagsRaw = val('edit-tags');
    const data = {
      sku,
      name,
      brand_id: val('edit-brand') || null,
      product_type: val('edit-type') || null,
      color: val('edit-color') || null,
      source: val('edit-source') || null,
      retail_price: retailPrice,
      compare_at_price: parseFloat(val('edit-compare-price')) || null,
      weight_kg: parseFloat(val('edit-weight')) || null,
      is_active: chk('edit-active'),
      description_html: modal._descEditor?.getValue() || null,
      compatible_devices_html: modal._compatEditor?.getValue() || null,
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
      invalidateDiagCache();
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
  const price = full.retail_price;
  const statsHtml = `
    <div class="admin-product-modal__sidebar-stats">
      <div class="admin-product-modal__sidebar-stat">
        <span class="admin-badge admin-badge--${active ? 'completed' : 'failed'}">${active ? 'Active' : 'Inactive'}</span>
      </div>
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

  // Determine if this is a manually-compatible product type (ribbons, correction tape)
  const manualCompatTypes = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'];
  const isManualCompat = manualCompatTypes.includes(full.product_type);

  const tabs = ['Basic Info', 'Description', 'For Use In', 'Pricing', 'Inventory', 'SEO', 'Advanced',
    ...(isManualCompat ? [] : ['Compatibility']), 'FAQ'];
  tabsEl.innerHTML = tabs.map((t, i) =>
    `<button class="admin-product-modal__tab${i === 0 ? ' active' : ''}" data-tab="${i}">${esc(t)}</button>`
  ).join('');

  // Basic Info panel
  let basicHtml = `
    <div class="admin-form-row">
      ${formGroup('SKU', `<input class="admin-input" id="edit-sku" value="${esc(full.sku || '')}">`)}
      ${formGroup('Name', `<input class="admin-input" id="edit-name" value="${esc(full.name || '')}">`, 'name')}
    </div>
    <div class="admin-form-row">
      ${formGroup('Brand', buildBrandSelect(full.brand_id || full.brand), 'brand_id')}
      ${formGroup('Product Type', buildSelect('edit-type', [
        { value: 'ink_cartridge',    label: 'Ink Cartridge' },
        { value: 'ink_bottle',       label: 'Ink Bottle' },
        { value: 'toner_cartridge',  label: 'Toner Cartridge' },
        { value: 'drum_unit',        label: 'Drum Unit' },
        { value: 'waste_toner',      label: 'Waste Toner' },
        { value: 'belt_unit',        label: 'Belt Unit' },
        { value: 'fuser_kit',        label: 'Fuser Kit' },
        { value: 'fax_film',         label: 'Fax Film' },
        { value: 'fax_film_refill',  label: 'Fax Film Refill' },
        { value: 'printer_ribbon',   label: 'Printer Ribbon' },
        { value: 'typewriter_ribbon', label: 'Typewriter Ribbon' },
        { value: 'correction_tape',  label: 'Correction Tape' },
        { value: 'label_tape',       label: 'Label Tape' },
        { value: 'photo_paper',      label: 'Photo Paper' },
        { value: 'printer',          label: 'Printer' },
      ], full.product_type), 'product_type')}
    </div>
    <div class="admin-form-row">
      ${formGroup('Color', `<input class="admin-input" id="edit-color" value="${esc(full.color || '')}">`, 'color')}
      ${formGroup('Source', buildSelect('edit-source', ['genuine', 'compatible', 'remanufactured'], full.source), 'source')}
    </div>
  `;

  // Pricing panel
  let pricingHtml = `
    <div class="admin-form-row">
      ${formGroup('Retail Price', `<input class="admin-input" id="edit-retail-price" type="number" step="0.01" value="${full.retail_price || ''}">`, 'retail_price')}
      ${formGroup('Compare Price', `<input class="admin-input" id="edit-compare-price" type="number" step="0.01" value="${full.compare_at_price || full.compare_price || ''}">`, 'compare_at_price')}
    </div>
    ${isOwner ? formGroup('Supplier Price', `<input class="admin-input" id="edit-cost-price" type="number" step="0.01" value="${full.cost_price || ''}">`, 'cost_price') : ''}
  `;

  // Inventory panel
  let inventoryHtml = `
    <div class="admin-form-row">
      ${formGroup('Weight (kg)', `<input class="admin-input" id="edit-weight" type="number" step="0.01" min="0" value="${full.weight_kg ?? ''}">`, 'weight_kg')}
      <div class="admin-form-group"></div>
    </div>
    <div class="admin-form-row">
      ${formGroup('Active', toggleHtml('edit-active', full.is_active !== false), 'is_active')}
      <div class="admin-form-group"></div>
    </div>
  `;

  // SEO panel
  let seoHtml = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="generate-seo">${icon('search', 12, 12)} Generate</button>
    </div>
    ${formGroup('Meta Title', `<input class="admin-input" id="edit-meta-title" value="${esc(full.meta_title || '')}">`, 'meta_title')}
    ${formGroup('Meta Description', `<textarea class="admin-textarea" id="edit-meta-desc" rows="3">${esc(full.meta_description || '')}</textarea>`, 'meta_description')}
  `;

  // Advanced panel
  let advancedHtml = `
    ${formGroup('Page Yield', `<input class="admin-input" id="edit-page-yield" type="number" min="0" value="${full.page_yield ?? ''}">`, 'page_yield')}
    ${formGroup('Tags (comma-separated)', `<input class="admin-input" id="edit-tags" value="${esc((full.tags || []).join(', '))}">`, 'tags')}
    ${formGroup('Internal Notes', `<textarea class="admin-textarea" id="edit-admin-notes" rows="3">${esc(full.internal_notes || '')}</textarea>`)}
  `;

  // Compatibility panel
  let compatHtml = `
    <div id="compat-section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <label id="compat-heading" style="font-weight:600">Compatible Printers (0)</label>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-add-btn">+ Add Printer</button>
      </div>

      <div id="compat-search-wrap" style="display:none;margin-bottom:10px;position:relative">
        <input class="admin-input" id="compat-search" placeholder="Search printer models\u2026" autocomplete="off">
        <div id="compat-suggestions" class="admin-compat-suggestions"></div>
      </div>

      <div class="admin-compat-printers" id="compat-printers"><span class="admin-text-muted">Loading\u2026</span></div>

      <div id="compat-bulk-wrap" style="margin-top:10px;display:none">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-bulk-btn">Apply to all variants with prefix &ldquo;<span id="compat-prefix"></span>&rdquo;</button>
      </div>

      <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)">

      <div style="margin-bottom:8px">
        <label style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Bulk Import</label>
      </div>
      <textarea id="compat-bulk-textarea" class="admin-input" rows="14"
        placeholder="Paste raw compatibility text \u2014 any format:\nBrother CE70 Brother CE80 Brother CE320\nPhilips ET600 Philips ET800 Philips ET850\nBrother MFC-J995DW / MFC-J805DW / MFC-J995DW XL\n\nClick \u201cParse Text\u201d first to clean it into one model per line."></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-parse-text-btn">Parse Text</button>
        <button class="admin-btn admin-btn--primary admin-btn--sm" id="compat-find-btn">Find Printers</button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-add-matched-btn" style="display:none"></button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="compat-create-unmatched-btn" style="display:none"></button>
      </div>
      <div id="compat-parse-msg" style="font-size:12px;color:var(--text-muted);margin-top:6px;display:none"></div>
      <div id="compat-bulk-results" style="margin-top:12px"></div>
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

  // Description panel (Rich Text)
  const descHtml = `
    <div class="admin-form-group">
      <label>Product Description (Rich Text)</label>
      <div id="desc-editor-mount"></div>
    </div>
  `;

  // For Use In panel (Rich Text)
  const forUseInHtml = `
    <div class="admin-form-group">
      <label>Compatible Devices / For Use In</label>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">Paste text or HTML listing compatible devices. Formatting is preserved as-is on the product page.</p>
      <div id="compat-editor-mount"></div>
    </div>
  `;

  const panelContents = [basicHtml, descHtml, forUseInHtml, pricingHtml, inventoryHtml, seoHtml, advancedHtml,
    ...(isManualCompat ? [] : [compatHtml]), faqHtml];
  panelsEl.innerHTML = panelContents.map((content, i) =>
    `<div class="admin-product-modal__tab-panel${i === 0 ? ' active' : ''}" data-panel="${i}">${content}</div>`
  ).join('');

  // Mount rich text editors
  const descMount = modal.querySelector('#desc-editor-mount');
  if (descMount) {
    modal._descEditor = new RichTextEditor(descMount, {
      initialValue: full.description_html || '',
      placeholder: 'Enter product description with formatting\u2026',
      minHeight: 400,
    });
  }
  const compatDevMount = modal.querySelector('#compat-editor-mount');
  if (compatDevMount) {
    modal._compatEditor = new RichTextEditor(compatDevMount, {
      initialValue: full.compatible_devices_html || '',
      placeholder: 'Paste or type compatible devices\u2026',
      minHeight: 400,
    });
  }

  // Wire tab switching
  tabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-product-modal__tab');
    if (!btn) return;
    const idx = btn.dataset.tab;
    tabsEl.querySelectorAll('.admin-product-modal__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === idx));
    panelsEl.querySelectorAll('.admin-product-modal__tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === idx));
  });

  // ── Manual Override Indicators ──────────────────────────────────────────
  applyOverrideBadges(modal, full);
}

/**
 * Renders pin badges on fields that have manual overrides, and wires
 * click-to-toggle so admins can unpin fields to let the feed take over.
 */
function applyOverrideBadges(modal, product) {
  const overrides = product.manual_overrides || {};
  const productId = product.id;

  // Find all form groups tagged with data-override-field
  const groups = modal.querySelectorAll('[data-override-field]');
  for (const group of groups) {
    const field = group.dataset.overrideField;
    const label = group.querySelector('label');
    if (!label) continue;

    // Remove any existing badge
    label.querySelector('.override-badge')?.remove();

    const isPinned = !!overrides[field];
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = `override-badge${isPinned ? ' override-badge--active' : ''}`;
    badge.title = isPinned
      ? 'Pinned — this value won\u2019t be overwritten by feed imports. Click to unpin.'
      : 'Not pinned — feed imports may update this value. Click to pin.';
    badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l0 10"/><path d="M18.364 5.636a9 9 0 1 1-12.728 0"/><circle cx="12" cy="12" r="3"/></svg>`;

    // Pin icon — simpler and more recognizable
    badge.innerHTML = isPinned
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5"><path d="M16 3a3 3 0 0 0-2.12.88L9.17 8.59a1.5 1.5 0 0 1-.71.39L5 10l-.7.7a1 1 0 0 0 0 1.42l3.58 3.58-5.3 5.3 1.42 1.42 5.3-5.3 3.58 3.58a1 1 0 0 0 1.42 0l.7-.7 1.02-3.46a1.5 1.5 0 0 1 .39-.71l4.71-4.71A3 3 0 0 0 16 3z"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 3a3 3 0 0 0-2.12.88L9.17 8.59a1.5 1.5 0 0 1-.71.39L5 10l-.7.7a1 1 0 0 0 0 1.42l3.58 3.58-5.3 5.3 1.42 1.42 5.3-5.3 3.58 3.58a1 1 0 0 0 1.42 0l.7-.7 1.02-3.46a1.5 1.5 0 0 1 .39-.71l4.71-4.71A3 3 0 0 0 16 3z"/></svg>`;

    badge.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newState = !badge.classList.contains('override-badge--active');
      badge.style.opacity = '0.5';
      badge.style.pointerEvents = 'none';
      try {
        const result = await AdminAPI.updateProductOverrides(productId, { [field]: newState });
        // Update local overrides from response
        const updated = result?.manual_overrides ?? (newState ? { ...overrides, [field]: true } : { ...overrides });
        if (!newState) delete updated[field];
        product.manual_overrides = updated;
        // Re-render badges
        applyOverrideBadges(modal, product);
        Toast.success(newState ? `${field.replace(/_/g, ' ')} pinned` : `${field.replace(/_/g, ' ')} unpinned`);
      } catch (err) {
        Toast.error(`Override update failed: ${err.message}`);
        badge.style.opacity = '';
        badge.style.pointerEvents = '';
      }
    });

    label.appendChild(badge);
  }
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

function formGroup(label, inputHtml, overrideField) {
  if (overrideField) {
    return `<div class="admin-form-group" data-override-field="${esc(overrideField)}"><label>${esc(label)}</label>${inputHtml}</div>`;
  }
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

  // Compatibility management
  {
    let compatPrinters = [];

    const container    = modal.querySelector('#compat-printers');
    const heading      = modal.querySelector('#compat-heading');
    const addBtn       = modal.querySelector('#compat-add-btn');
    const searchWrap   = modal.querySelector('#compat-search-wrap');
    const searchInput  = modal.querySelector('#compat-search');
    const suggestions  = modal.querySelector('#compat-suggestions');
    const bulkTextarea   = modal.querySelector('#compat-bulk-textarea');
    const parseTextBtn   = modal.querySelector('#compat-parse-text-btn');
    const findBtn        = modal.querySelector('#compat-find-btn');
    const addMatchedBtn      = modal.querySelector('#compat-add-matched-btn');
    const createUnmatchedBtn = modal.querySelector('#compat-create-unmatched-btn');
    const parseMsg   = modal.querySelector('#compat-parse-msg');
    const bulkResults  = modal.querySelector('#compat-bulk-results');
    const bulkWrap     = modal.querySelector('#compat-bulk-wrap');
    const bulkBtn      = modal.querySelector('#compat-bulk-btn');
    const prefixEl     = modal.querySelector('#compat-prefix');

    const isRibbon  = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'].includes(product.product_type);
    const skuPrefix = product.sku ? product.sku.replace(/[A-Z]+$/, '') : '';
    const showBulk  = !isRibbon && skuPrefix && skuPrefix !== product.sku;

    // ── Helpers ─────────────────────────────────────────────────────────────

    function printerId(p) {
      return String(typeof p === 'object' ? (p.id || p.printer_id || '') : '');
    }
    function printerName(p) {
      return typeof p === 'string' ? p : (p.full_name || p.model_name || p.model || p.name || String(p));
    }

    // Known brands (sorted longest-first so "Fuji Xerox" matches before "Xerox")
    const _COMPAT_BRANDS = [
      'Fuji Xerox',
      'Amano', 'Brother', 'Canon', 'Casio', 'Epson', 'HP',
      'Kyocera', 'Lanier', 'Lexmark', 'Minolta', 'OKI', 'Olympia', 'Panasonic',
      'Philips', 'Samsung', 'Sears', 'Sharp', 'Xerox',
    ];

    // Aliases to normalise before parsing (case-insensitive)
    const _COMPAT_ALIASES = [
      ['CasioWriter', 'Casio'],
      ['SamSung',     'Samsung'],
    ];

    // Noise phrases — strip from match point to end-of-segment
    const _NOISE_RE = [
      /\s+correcti(?:b|c)le\s+ribbons?\b.*/i,
      /\s+correction\s+ribbons?\b.*/i,
      /\s+is\s+also\s+used\b.*/i,
      /\s+also\s+used\s+in\b.*/i,
      /\s+for\s+use\s+in\b.*/i,
      /\s+following\s+models?\b.*/i,
      /\s+compatible\s+with\b.*/i,
      /\s+equiv(?:alent|\.)\b.*/i,
      /\s+typewriter\s+(?:ribbons?|supplies)\b.*/i,
      /\s+printer\s+ribbons?\b.*/i,
      /\s+\(see\s+also\b.*/i,
    ];

    function _stripNoise(s) {
      let out = s;
      for (const re of _NOISE_RE) out = out.replace(re, '');
      return out.trim();
    }

    /** True if segment starts with a known brand AND has model content after it */
    function _isValidModel(s) {
      const sl = s.trim().toLowerCase();
      const brand = _COMPAT_BRANDS.find(b => sl.startsWith(b.toLowerCase()));
      if (!brand) return false;
      const rest = s.trim().slice(brand.length).trim();
      return rest.length > 0 && /[a-z0-9]/i.test(rest);
    }

    /**
     * Find all positions in `line` where a known brand starts.
     * Longer brands take priority over shorter ones to avoid "Xerox" matching inside "Fuji Xerox".
     * Only matches at start-of-string or after whitespace.
     */
    function _findBrandPositions(line) {
      const covered = new Set(); // chars already claimed by a longer brand match
      const positions = [];

      for (const brand of _COMPAT_BRANDS) { // already sorted longest-first
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // (^|\s)(brand)(?=\s|$)  — capture leading whitespace so we get exact brand start pos
        const re = new RegExp(`(^|\\s)(${escaped})(?=\\s|$)`, 'gi');
        let m;
        while ((m = re.exec(line)) !== null) {
          const pos = m.index + m[1].length; // skip any leading space
          if (!covered.has(pos)) {
            positions.push(pos);
            for (let i = pos; i < pos + brand.length; i++) covered.add(i);
          }
        }
      }

      return positions.sort((a, b) => a - b);
    }

    /**
     * Parse raw compatibility text into clean "Brand Model" strings.
     *
     * Handles all three formats:
     *   • Explicit delimiters  — "Brother MFC-J995DW / MFC-J805DW / MFC-J995DW XL"
     *   • Brand-as-delimiter   — "Philips ET600 Philips ET800 Philips ET850"
     *   • Multiple brands      — "Casio CW220 Epson CRII Epson CRIIE Epson CRIV"
     *   • Run-together brands  — "Brother CE35Brother CE40" → inserts space first
     *   • Noise phrases        — "Brother EM100 Typewriter Ribbons" → "Brother EM100"
     */
    function parseBulkText(raw) {
      // 1. Normalise aliases across the entire text
      let text = raw;
      for (const [alias, canonical] of _COMPAT_ALIASES) {
        text = text.replace(new RegExp(alias, 'gi'), canonical);
      }

      // 2. Insert space before any brand name that is directly preceded by a letter/digit
      //    (handles "35Brother" → "35 Brother", "CE35Brother" → "CE35 Brother")
      for (const brand of _COMPAT_BRANDS) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`([a-zA-Z0-9])(${escaped})`, 'g'), '$1 $2');
      }

      const queries = [];

      for (const rawLine of text.split(/\n/).map(s => s.trim()).filter(Boolean)) {
        // 3. Strip noise from the full line first
        const line = _stripNoise(rawLine);
        if (!line) continue;

        // 4. Explicit delimiters: / , ;
        if (/[\/,;]/.test(line)) {
          const segs = line.split(/\s*[\/,;]\s*/);
          const words = segs[0].trim().split(/\s+/);
          const brandEnd = (() => { const i = words.findIndex(w => /^\d/.test(w)); return i === -1 ? words.length : i; })();
          const brand = words.slice(0, brandEnd).join(' ');
          const firstModel = words.slice(brandEnd).join(' ');
          const first = firstModel ? `${brand} ${firstModel}`.trim() : brand;
          if (_isValidModel(first)) queries.push(first);
          for (let i = 1; i < segs.length; i++) {
            const s = _stripNoise(segs[i].trim());
            if (!s) continue;
            // Prefix brand if this segment has no brand of its own
            const hasBrand = _COMPAT_BRANDS.some(b => s.toLowerCase().startsWith(b.toLowerCase()));
            const entry = (brand && !hasBrand) ? `${brand} ${s}` : s;
            if (_isValidModel(entry)) queries.push(entry);
          }
          continue;
        }

        // 5. Find all brand positions in this line
        const positions = _findBrandPositions(line);

        if (positions.length === 0) {
          // No known brand — include as-is (may be an uncommon brand)
          if (/\s/.test(line)) queries.push(line);
          continue;
        }

        if (positions.length === 1) {
          // Single brand occurrence — take from brand start onwards (drops any leading junk)
          const seg = _stripNoise(line.slice(positions[0]).trim());
          if (_isValidModel(seg)) queries.push(seg);
          continue;
        }

        // 6. Multiple brand positions — split at each one
        for (let i = 0; i < positions.length; i++) {
          const seg = _stripNoise(line.slice(positions[i], positions[i + 1] ?? line.length).trim());
          if (seg && _isValidModel(seg)) queries.push(seg);
        }
      }

      return [...new Set(queries.filter(Boolean))];
    }

    // ── Render ───────────────────────────────────────────────────────────────

    function renderCompatBadges() {
      const label = isRibbon ? 'Compatible Devices' : 'Compatible Printers';
      if (heading) heading.textContent = `${label} (${compatPrinters.length})`;
      if (!container) return;
      if (compatPrinters.length === 0) {
        container.innerHTML = `
          <div style="background:var(--yellow-light,#fffbe6);border:1px solid var(--yellow,#f0a500);border-radius:6px;padding:10px 12px;font-size:0.85em;">
            <strong>No compatible ${isRibbon ? 'devices' : 'printers'} linked</strong><br>
            <span style="color:var(--text-muted)">Paste a bulk list below and click &ldquo;${isRibbon ? 'Find Devices' : 'Find Printers'}&rdquo;.</span>
          </div>`;
        return;
      }
      container.innerHTML = compatPrinters.map(p => {
        const name = printerName(p);
        const id   = printerId(p);
        return `<span class="admin-badge">${esc(name)}<button class="compat-remove" data-printer-id="${esc(String(id))}" title="Remove">\u00d7</button></span>`;
      }).join('');
    }

    // ── Remove (delegated on badge container) ────────────────────────────────

    container?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.compat-remove');
      if (!btn) return;
      const id = btn.dataset.printerId;
      btn.disabled = true;
      try {
        if (!product.sku) return;
        await AdminAPI.removeCompatiblePrinter(product.sku, id);
        compatPrinters = compatPrinters.filter(p => printerId(p) !== id);
        renderCompatBadges();
      } catch (err) {
        Toast.error(`Remove failed: ${err.message}`);
        btn.disabled = false;
      }
    });

    // ── + Add Printer (single search) ────────────────────────────────────────

    if (findBtn && isRibbon) findBtn.textContent = 'Find Devices';

    addBtn?.addEventListener('click', () => {
      const open = searchWrap.style.display !== 'none';
      searchWrap.style.display = open ? 'none' : 'block';
      if (!open) { searchInput.value = ''; suggestions.innerHTML = ''; searchInput.focus(); }
    });

    let _searchTimer = null;
    searchInput?.addEventListener('input', () => {
      clearTimeout(_searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 2) { suggestions.innerHTML = ''; return; }
      _searchTimer = setTimeout(async () => {
        try {
          const resp = await window.API.searchPrinters(q);
          const list = resp?.data?.printers || resp?.data || [];
          if (!Array.isArray(list) || list.length === 0) {
            suggestions.innerHTML = `<div class="admin-compat-suggestions__item" style="color:var(--text-muted)">No results</div>`;
            return;
          }
          suggestions.innerHTML = list.slice(0, 10).map(p =>
            `<div class="admin-compat-suggestions__item" data-printer-id="${esc(String(p.id || ''))}" data-printer-name="${esc(printerName(p))}">${esc(printerName(p))}</div>`
          ).join('');
        } catch (_) {
          suggestions.innerHTML = `<div class="admin-compat-suggestions__item" style="color:var(--text-muted)">Search failed</div>`;
        }
      }, 300);
    });

    suggestions?.addEventListener('click', async (e) => {
      const item = e.target.closest('.admin-compat-suggestions__item');
      if (!item?.dataset.printerId || !product.sku) return;
      const pid  = item.dataset.printerId;
      const name = item.dataset.printerName;
      if (compatPrinters.some(p => printerId(p) === pid)) { searchWrap.style.display = 'none'; return; }
      item.style.opacity = '0.5';
      try {
        await AdminAPI.addCompatiblePrinter(product.sku, pid);
        compatPrinters.push({ id: pid, full_name: name });
        renderCompatBadges();
        searchWrap.style.display = 'none';
        searchInput.value = '';
        suggestions.innerHTML = '';
      } catch (err) {
        Toast.error(`Add failed: ${err.message}`);
        item.style.opacity = '1';
      }
    });

    document.addEventListener('click', (e) => {
      if (searchWrap && !searchWrap.contains(e.target) && e.target !== addBtn) {
        searchWrap.style.display = 'none';
      }
    });

    // ── Bulk: Parse Text ─────────────────────────────────────────────────────

    parseTextBtn?.addEventListener('click', () => {
      const raw = bulkTextarea.value.trim();
      if (!raw) return;
      const parsed = parseBulkText(raw);
      if (parsed.length === 0) return;
      bulkTextarea.value = parsed.join('\n');
      parseMsg.textContent = `Extracted ${parsed.length} model${parsed.length !== 1 ? 's' : ''} \u2014 review then click Find Printers`;
      parseMsg.style.display = 'block';
      // Reset any previous search results
      bulkResults.innerHTML = '';
      addMatchedBtn.style.display = 'none';
      createUnmatchedBtn.style.display = 'none';
    });

    // ── Bulk: Find Printers ──────────────────────────────────────────────────

    let _sessionMatches = [];   // matched results from last Find run

    findBtn?.addEventListener('click', async () => {
      const raw = bulkTextarea.value.trim();
      if (!raw) { Toast.error('Paste some models first'); return; }
      const names = parseBulkText(raw);
      if (names.length === 0) { Toast.error('No models found \u2014 try Parse Text first'); return; }

      findBtn.disabled = true;
      parseMsg.style.display = 'none';
      addMatchedBtn.style.display = 'none';
      createUnmatchedBtn.style.display = 'none';
      _sessionMatches = [];
      bulkResults.innerHTML = '';

      {
        // ── Search printer_models, then link ─────────────────────────────────
        findBtn.textContent = 'Searching\u2026';
        bulkResults.innerHTML = `<div style="color:var(--text-muted);font-size:12px">Searching 0 / ${names.length}\u2026</div>`;
        const results = [];

        try {
          // Try bulk endpoint first, fall back to sequential individual calls
          try {
            const bulkResp = await window.API.searchPrintersBulk(names);
            for (const r of (bulkResp?.data?.results || [])) {
              results.push(r.printer ? { query: r.query, printer: r.printer, matched: true } : { query: r.query, matched: false });
            }
          } catch (_) {
            for (let i = 0; i < names.length; i += 5) {
              const batch = names.slice(i, i + 5);
              const batchRes = await Promise.all(batch.map(async name => {
                try {
                  const resp = await window.API.searchPrinters(name);
                  const list = resp?.data?.printers || resp?.data || [];
                  const top = Array.isArray(list) ? list[0] : null;
                  return top ? { query: name, printer: top, matched: true } : { query: name, matched: false };
                } catch (_e) { return { query: name, matched: false }; }
              }));
              results.push(...batchRes);
              bulkResults.innerHTML = `<div style="color:var(--text-muted);font-size:12px">Searching ${Math.min(i + 5, names.length)} / ${names.length}\u2026</div>`;
              if (i + 5 < names.length) await new Promise(r => setTimeout(r, 300));
            }
          }

          // Render results
          const matched   = results.filter(r => r.matched);
          const unmatched = results.filter(r => !r.matched);
          _sessionMatches = matched;

          bulkResults.innerHTML = results.map(r => {
            if (r.matched) {
              const name = printerName(r.printer);
              const alreadyLinked = compatPrinters.some(p => printerId(p) === String(r.printer.id || r.printer.printer_id || ''));
              return `<div class="admin-compat-parse-result admin-compat-parse-result--matched">
                <span>&#10003;</span>
                <span class="result-name">${esc(name)}</span>
                ${alreadyLinked ? '<span style="font-size:11px;color:var(--text-muted)">(already linked)</span>' : ''}
              </div>`;
            }
            return `<div class="admin-compat-parse-result admin-compat-parse-result--unmatched">
              <span>&#8212;</span>
              <span class="result-query">${esc(r.query)}</span>
              <span style="font-size:11px;color:var(--text-muted)">not found</span>
              <button class="admin-btn admin-btn--ghost admin-btn--sm compat-create-one-btn" style="font-size:11px;padding:2px 8px;margin-left:auto" data-query="${esc(r.query)}">Create</button>
            </div>`;
          }).join('');

          // Show action buttons
          const newMatches = matched.filter(r => !compatPrinters.some(p => printerId(p) === String(r.printer.id || r.printer.printer_id || '')));
          if (newMatches.length > 0) {
            addMatchedBtn.textContent = `Add ${newMatches.length} Matched Printer${newMatches.length !== 1 ? 's' : ''}`;
            addMatchedBtn.style.display = 'inline-flex';
          }
          if (unmatched.length > 0) {
            createUnmatchedBtn.textContent = `Create All Unmatched (${unmatched.length})`;
            createUnmatchedBtn.style.display = 'inline-flex';
            createUnmatchedBtn._queries = unmatched.map(r => r.query);
          }
        } catch (err) {
          Toast.error(`Search failed: ${err.message}`);
          bulkResults.innerHTML = '';
        }
      }

      findBtn.disabled = false;
      findBtn.textContent = isRibbon ? 'Find Devices' : 'Find Printers';
    });

    // ── Bulk: Add Matched ────────────────────────────────────────────────────

    addMatchedBtn?.addEventListener('click', async () => {
      if (!product.sku) return;
      addMatchedBtn.disabled = true;
      addMatchedBtn.textContent = 'Adding\u2026';
      let added = 0;
      for (const r of _sessionMatches) {
        const pid  = String(r.printer.id || r.printer.printer_id || '');
        const name = printerName(r.printer);
        try {
          const { status } = await AdminAPI.ensureCompatibility(
            product.sku, pid, compatPrinters.map(p => printerId(p))
          );
          if (status === 'added') { compatPrinters.push({ id: pid, full_name: name }); added++; }
          // Append inline status chip to the result row
          bulkResults.querySelectorAll('.admin-compat-parse-result--matched').forEach(row => {
            if (row.querySelector('.result-name')?.textContent === name && !row.querySelector('.compat-status-chip')) {
              const chip = document.createElement('span');
              chip.className = `compat-status-chip compat-status-chip--${status === 'added' ? 'added' : 'linked'}`;
              chip.textContent = status === 'added' ? 'Linked' : 'Already linked';
              row.appendChild(chip);
            }
          });
        } catch (_) {}
      }
      renderCompatBadges();
      addMatchedBtn.style.display = 'none';
      _sessionMatches = [];
      if (added > 0) Toast.success(`Linked ${added} printer${added !== 1 ? 's' : ''}`);
      addMatchedBtn.disabled = false;
    });

    // ── Bulk: Create All Unmatched ───────────────────────────────────────────

    createUnmatchedBtn?.addEventListener('click', async () => {
      const queries = createUnmatchedBtn._queries;
      if (!queries?.length || !product.sku) return;
      createUnmatchedBtn.disabled = true;
      let linked = 0;
      for (let i = 0; i < queries.length; i += 3) {
        createUnmatchedBtn.textContent = `Working\u2026 (${i}/${queries.length})`;
        const batch = queries.slice(i, i + 3);
        await Promise.all(batch.map(async (query) => {
          try {
            const { id, name, wasCreated } = await AdminAPI.getOrCreatePrinterId(query);
            const { status } = await AdminAPI.ensureCompatibility(
              product.sku, id, compatPrinters.map(p => printerId(p))
            );
            if (status === 'added') { compatPrinters.push({ id, full_name: name }); linked++; }
            // Flip the unmatched row to matched with status chips
            bulkResults.querySelectorAll('.admin-compat-parse-result--unmatched').forEach(row => {
              if (row.querySelector('.result-query')?.textContent === query) {
                row.className = 'admin-compat-parse-result admin-compat-parse-result--matched';
                row.innerHTML = `
                  <span>&#10003;</span>
                  <span class="result-name">${esc(name)}</span>
                  <span class="compat-status-chip compat-status-chip--${wasCreated ? 'created' : 'found'}">${wasCreated ? 'Created' : 'Already existed'}</span>
                  <span class="compat-status-chip compat-status-chip--${status === 'added' ? 'added' : 'linked'}">${status === 'added' ? 'Linked' : 'Already linked'}</span>`;
              }
            });
          } catch (_) {}
        }));
        if (i + 3 < queries.length) await new Promise(r => setTimeout(r, 200));
      }
      renderCompatBadges();
      createUnmatchedBtn.style.display = 'none';
      Toast.success(`Created and linked ${linked} printer${linked !== 1 ? 's' : ''}`);
      createUnmatchedBtn.disabled = false;
    });

    // ── Bulk results: individual Create buttons ──────────────────────────────

    bulkResults?.addEventListener('click', async (e) => {
      const btn = e.target.closest('.compat-create-one-btn');
      if (!btn || !product.sku) return;
      const query = btn.dataset.query;
      btn.disabled = true;
      btn.textContent = 'Working\u2026';
      try {
        const { id, name, wasCreated } = await AdminAPI.getOrCreatePrinterId(query);
        const { status } = await AdminAPI.ensureCompatibility(
          product.sku, id, compatPrinters.map(p => printerId(p))
        );
        if (status === 'added') { compatPrinters.push({ id, full_name: name }); renderCompatBadges(); }
        const row = btn.closest('.admin-compat-parse-result');
        if (row) {
          row.className = 'admin-compat-parse-result admin-compat-parse-result--matched';
          row.innerHTML = `
            <span>&#10003;</span>
            <span class="result-name">${esc(name)}</span>
            <span class="compat-status-chip compat-status-chip--${wasCreated ? 'created' : 'found'}">${wasCreated ? 'Created' : 'Already existed'}</span>
            <span class="compat-status-chip compat-status-chip--${status === 'added' ? 'added' : 'linked'}">${status === 'added' ? 'Linked' : 'Already linked'}</span>`;
        }
        if (status === 'added') Toast.success(`Linked: ${name}`);
        else Toast.info(`${name} — already linked`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Create';
        Toast.error(`Failed: ${err.message}`);
      }
    });

    // ── Bulk apply to variants ────────────────────────────────────────────────

    if (showBulk && bulkWrap && bulkBtn && prefixEl) {
      prefixEl.textContent = skuPrefix;
      bulkWrap.style.display = 'block';
      bulkBtn.addEventListener('click', async () => {
        if (compatPrinters.length === 0) { Toast.error('No printers to apply'); return; }
        const ids = compatPrinters.map(p => typeof p === 'object' ? (p.id || p.printer_id) : null).filter(Boolean);
        bulkBtn.disabled = true;
        bulkBtn.textContent = 'Applying\u2026';
        try {
          await AdminAPI.bulkApplyCompatibility(skuPrefix, ids);
          Toast.success(`Applied to all variants with prefix \u201c${skuPrefix}\u201d`);
        } catch (err) {
          Toast.error(`Bulk apply failed: ${err.message}`);
        } finally {
          bulkBtn.disabled = false;
          bulkBtn.innerHTML = `Apply to all variants with prefix \u201c<span id="compat-prefix">${esc(skuPrefix)}</span>\u201d`;
        }
      });
    }

    // ── Initial load ─────────────────────────────────────────────────────────

    if (product.sku && window.API?.getCompatiblePrinters) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
      Promise.race([window.API.getCompatiblePrinters(product.sku), timeout])
        .then(resp => {
          compatPrinters = resp?.data?.compatible_printers || resp?.data?.printers || resp?.data || [];
          if (!Array.isArray(compatPrinters)) compatPrinters = [];
          renderCompatBadges();
        })
        .catch(() => { compatPrinters = []; renderCompatBadges(); });
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
    let primaryUrl = null;
    for (const file of valid) {
      try {
        const img = await uploadImage(product.id, file);
        uploaded++;
        if (img && img.is_primary) primaryUrl = img.image_url || img.url || null;
      } catch { /* uploadImage already toasts errors */ }
    }
    if (uploaded > 0) {
      Toast.success(`${uploaded} image${uploaded > 1 ? 's' : ''} uploaded`);
      // Update product list row thumbnail if a primary image was uploaded
      if (primaryUrl && _table) {
        const row = _table.data.find(r => String(r.id) === String(product.id));
        if (row) {
          row.image_url = primaryUrl;
          if (!row.images) row.images = [];
          row.images.unshift({ image_url: primaryUrl, is_primary: true });
        }
        // Find the row's thumbnail via the table DOM
        const tableRows = document.querySelectorAll('.admin-table tbody tr');
        for (const tr of tableRows) {
          const lockBtn = tr.querySelector(`.import-lock-btn[data-product-id="${product.id}"]`);
          if (lockBtn) {
            const imgCell = tr.querySelector('.cell-image');
            if (imgCell) {
              imgCell.innerHTML = `<img class="admin-product-thumb" src="${esc(primaryUrl)}" alt="" loading="lazy">`;
            }
            break;
          }
        }
      }
    }
    dropzone.classList.remove('uploading');
    dropzone.querySelector('span').innerHTML = `${icon('download', 20, 20)} Drop images or click to upload`;
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
      brand_id: val('edit-brand') || null,
      product_type: val('edit-type'),
      color: val('edit-color'),
      source: val('edit-source'),
      retail_price: numVal('edit-retail-price'),
      compare_at_price: numVal('edit-compare-price'),
      is_active: chk('edit-active'),
      description_html: modal._descEditor?.getValue() || null,
      compatible_devices_html: modal._compatEditor?.getValue() || null,
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
      const result = await AdminAPI.updateProduct(product.id, data);
      // Update override badges if the backend auto-flagged fields
      if (result?.manual_overrides) {
        product.manual_overrides = result.manual_overrides;
      }
      invalidateDiagCache();
      Toast.success('Product updated');
      const saveBtn = modal.querySelector('[data-action="save"]');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
      loadProducts();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
      const saveBtn = modal.querySelector('[data-action="save"]');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
    }
  });

  buildFaqSection(modal, product);
}

async function uploadImage(productId, file) {
  const res = await AdminAPI.uploadProductImage(productId, file);
  const img = res?.data || res;
  const imageUrl = img.image_url || img.url || '';
  const imageId = img.id || img.image_id || '';

  // Append to gallery in-place instead of re-opening the drawer
  const gallery = document.querySelector('#product-gallery');
  if (gallery) {
    const empty = gallery.querySelector('.admin-product-gallery__empty');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'admin-product-gallery__item';
    item.dataset.imageId = imageId;
    item.dataset.imageUrl = imageUrl;
    item.innerHTML = `<img src="${esc(imageUrl)}" alt="" loading="lazy" data-fallback="broken-parent">`
      + `<button class="admin-product-gallery__delete" data-delete-image="${esc(String(imageId))}" title="Remove image"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
    gallery.appendChild(item);

    // Wire delete handler on the new item
    const delBtn = item.querySelector('[data-delete-image]');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        item.style.opacity = '0.4';
        try {
          if (imageId) {
            await AdminAPI.deleteProductImage(productId, imageId);
          }
          Toast.success('Image removed');
          item.remove();
          if (gallery && !gallery.querySelector('.admin-product-gallery__item')) {
            gallery.innerHTML = '<div class="admin-product-gallery__empty">No images yet</div>';
          }
        } catch (err) {
          item.style.opacity = '1';
          Toast.error(`Delete failed: ${err.message}`);
        }
      });
    }

    // Handle broken image
    const imgEl = item.querySelector('img');
    if (imgEl) {
      imgEl.addEventListener('error', function() {
        this.parentElement.classList.add('admin-product-gallery__item--broken');
      }, { once: true });
    }
  }

  return img;
}

function renderDiagnostics(container) {
  if (!_container || !AdminAuth.isOwner()) return;
  const panel = container.querySelector('#diag-panel');
  if (!panel) return;
  const d = _diagnostics;
  const isLoading = !d;
  panel.innerHTML = `
    <div class="admin-kpi-grid${isLoading ? ' admin-kpi-grid--loading' : ''}" style="grid-template-columns:repeat(4,1fr)">
      ${diagKpi('Total Products',        d?.total ?? d?.total_products ?? MISSING)}
      ${diagKpi('Active',                d?.active ?? d?.active_count ?? MISSING)}
      ${diagKpi('Missing Images',        d?.missing_images ?? MISSING)}
      ${diagKpi('Missing Prices',        d?.missing_prices ?? MISSING)}
      ${diagKpi('Missing Weight',        d?.missing_weight ?? MISSING)}
      ${diagKpi('Missing Compatibility', d?.missing_compatibility ?? (d ? 'N/A' : MISSING))}
    </div>
  `;
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
  if (_imageFilter === 'has-images') p.set('has_images', 'true');
  else if (_imageFilter === 'no-images') p.set('has_images', 'false');
  if (_sourceFilter) p.set('source', _sourceFilter);
  if (_typeFilter) p.set('product_type', _typeFilter);
  if (_stockFilter) p.set('stock_status', _stockFilter);
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
    const head = [
      'Name', 'SKU', 'Brand', 'Price',
      ...(isOwner ? ['Cost', 'Margin %', 'Markup %', 'Profit $'] : []),
      'Active',
    ];
    const body = all.map(p => {
      const brand = extractBrandName(p) || MISSING;
      const price = p.retail_price ?? p.cost_price;
      const prof = isOwner ? computeProfitability(p) : null;
      const pctCell = (v) => (v == null ? MISSING : `${v.toFixed(1)}%`);
      const dollarCell = (v) => (v == null ? MISSING : formatPrice(v));
      return [
        p.name || MISSING,
        p.sku || MISSING,
        brand,
        price != null ? formatPrice(price) : MISSING,
        ...(isOwner ? [
          p.cost_price != null ? formatPrice(p.cost_price) : MISSING,
          pctCell(prof.marginPct),
          pctCell(prof.markupPct),
          dollarCell(prof.profitDollars),
        ] : []),
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
    printer_ribbon: 'Printer Ribbon',
    typewriter_ribbon: 'Typewriter Ribbon',
    correction_tape: 'Correction Tape',
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
  if (['ribbon', 'printer_ribbon', 'typewriter_ribbon', 'correction_tape'].includes(type)) {
    const ribbonLabel = type === 'typewriter_ribbon' ? 'typewriter ribbon' : type === 'correction_tape' ? 'correction tape' : 'printer ribbon';
    metaDesc = `Buy ${sourcePart}${brand} ${code || name}${colorPart} ${ribbonLabel} in NZ. In stock, ships fast. ${qualityNote} Free delivery on orders over $100 inc GST.`.trim();
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
      // Build update payloads — backend requires retail_price
      const payloads = ids.map(id => {
        const row = _table.data.find(r => String(r.id) === id);
        return {
          id,
          data: {
            is_active: activate,
            retail_price: row?.retail_price ?? 0,
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
        invalidateDiagCache();
        Toast.success(`${done} product${done > 1 ? 's' : ''} deleted`);
      }
      loadProducts();
    },
  });
}

// ---- Tab switching for Products / Ribbons / Review ----
async function switchProductTab(tab) {
  if (tab === _activeProductTab) return;

  // Destroy current
  if (_activeProductTab === 'products') destroyProductsContent();
  if (_subProductModule?.destroy) _subProductModule.destroy();
  _subProductModule = null;

  _activeProductTab = tab;
  _container.querySelectorAll('.admin-tab[data-prod-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.prodTab === tab);
  });

  const content = _container.querySelector('#products-tab-content');
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (tab === 'products') {
    content.innerHTML = '';
    await renderProductsContent(content);
  } else if (tab === 'ribbons') {
    try {
      const mod = await import('./ribbons.js');
      _subProductModule = mod.default;
      content.innerHTML = '';
      await _subProductModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Ribbons</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  }
}

function destroyProductsContent() {
  if (_table) _table.destroy();
  if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
  _table = null;
}

async function renderProductsContent(contentEl) {
  const container = contentEl;
  _page = 1;
  _search = '';

  // Load brands for filter + edit form
  const brandsData = await AdminAPI.getBrands();
  if (_container === null) return;
  _brands = brandsData && Array.isArray(brandsData) ? brandsData : [];

  // Hide global filter bar — products page uses local toolbar instead
  FilterState.showBar(false);

    // Compact single-row toolbar: filters on left, actions + diagnostics on right
    const header = document.createElement('div');
    header.className = 'admin-page-header admin-page-header--with-toolbar';
    let brandOpts = '<option value="">All Brands</option>';
    for (const b of _brands) {
      const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
      const val = (typeof b === 'object' && b.id) ? b.id : name;
      brandOpts += `<option value="${esc(val)}">${esc(name)}</option>`;
    }
    const isOwner = AdminAuth.isOwner();
    const ownerControls = isOwner ? `
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="diag-trigger" aria-expanded="false" title="Toggle product diagnostics">
        <span class="diag-chevron" style="display:inline-flex;transition:transform .15s"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span>
        Diagnostics
      </button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-seo-btn">${icon('search', 14, 14)} Generate SEO</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-activate-btn">${icon('products', 14, 14)} Bulk Activate</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="bulk-deactivate-btn">${icon('products', 14, 14)} Bulk Deactivate</button>
    ` : '';
    header.innerHTML = `
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
        <select class="admin-select" id="source-filter">
          <option value="">All Sources</option>
          <option value="genuine">Genuine</option>
          <option value="compatible">Compatible</option>
          <option value="remanufactured">Remanufactured</option>
          <option value="ribbon">Ribbon</option>
        </select>
        <select class="admin-select" id="type-filter">
          <option value="">All Types</option>
          <option value="ink_cartridge">Ink Cartridge</option>
          <option value="toner_cartridge">Toner</option>
          <option value="printer_ribbon">Printer Ribbon</option>
          <option value="typewriter_ribbon">Typewriter Ribbon</option>
          <option value="correction_tape">Correction Tape</option>
          <option value="drum">Drum</option>
          <option value="maintenance_kit">Maintenance Kit</option>
          <option value="paper">Paper</option>
        </select>
        <select class="admin-select" id="stock-filter">
          <option value="">All Stock</option>
          <option value="in_stock">In Stock</option>
          <option value="low_stock">Low Stock</option>
          <option value="out_of_stock">Out of Stock</option>
        </select>
        <span style="flex:1 1 auto"></span>
        ${ownerControls}
        <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-product-btn">${icon('products', 14, 14)} Add Product</button>
        ${exportDropdown('export-products')}
      </div>
      <div id="diag-panel" hidden style="margin-top:12px"></div>
    `;
    container.appendChild(header);

    // Diagnostics toggle (owner only)
    if (isOwner) {
      const trigger = header.querySelector('#diag-trigger');
      const panel = header.querySelector('#diag-panel');
      const chevron = trigger?.querySelector('.diag-chevron');
      trigger?.addEventListener('click', () => {
        const open = panel.hasAttribute('hidden');
        if (open) {
          panel.removeAttribute('hidden');
          if (chevron) chevron.style.transform = 'rotate(90deg)';
          trigger.setAttribute('aria-expanded', 'true');
        } else {
          panel.setAttribute('hidden', '');
          if (chevron) chevron.style.transform = '';
          trigger.setAttribute('aria-expanded', 'false');
        }
      });

      header.querySelector('#bulk-seo-btn')?.addEventListener('click', () => bulkGenerateSEO());

      header.querySelector('#bulk-activate-btn')?.addEventListener('click', async () => {
        try {
          const preview = await AdminAPI.bulkActivate({ dry_run: true });
          const p = preview?.data ?? preview;
          const count = p?.count ?? p?.affected ?? p?.eligible ?? p?.total ?? '?';
          Modal.confirm({
            title: 'Bulk Activate Products',
            message: `This will activate ${count} eligible products. Proceed?`,
            confirmLabel: 'Activate All',
            confirmClass: 'admin-btn--primary',
            onConfirm: async () => {
              await AdminAPI.bulkActivate({ dry_run: false });
              invalidateDiagCache();
              Toast.success('Products activated');
              loadProducts();
            },
          });
        } catch (e) {
          Toast.error(`Bulk activate failed: ${e.message}`);
        }
      });

      header.querySelector('#bulk-deactivate-btn')?.addEventListener('click', async () => {
        try {
          const preview = await AdminAPI.bulkDeactivate({ dry_run: true, deactivate_all: true });
          const p = preview?.data ?? preview;
          const count = p?.count ?? p?.affected ?? p?.eligible ?? p?.total ?? '?';
          Modal.confirm({
            title: 'Bulk Deactivate Products',
            message: `This will deactivate ${count} eligible products. Proceed?`,
            confirmLabel: 'Deactivate All',
            confirmClass: 'admin-btn--danger',
            onConfirm: async () => {
              await AdminAPI.bulkDeactivate({ dry_run: false, deactivate_all: true });
              invalidateDiagCache();
              Toast.success('Products deactivated');
              loadProducts();
            },
          });
        } catch (e) {
          Toast.error(`Bulk deactivate failed: ${e.message}`);
        }
      });
    }

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
      onSort: (key, dir) => {
        if (key === null) { _sort = 'name'; _sortDir = 'asc'; }
        else { _sort = key; _sortDir = dir; }
        _page = 1;
        loadProducts();
      },
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

    // Import lock toggle (event delegation)
    tableContainer.addEventListener('click', async (e) => {
      const btn = e.target.closest('.import-lock-btn');
      if (!btn) return;
      e.stopPropagation();
      const productId = btn.dataset.productId;
      btn.disabled = true;
      btn.style.opacity = '0.5';
      try {
        const result = await AdminAPI.toggleImportLock(productId);
        const locked = !!result.import_locked;
        btn.dataset.locked = String(locked);
        const isRibbon = btn.dataset.ribbon === 'true';
        btn.classList.toggle('import-lock-btn--active', locked);
        btn.innerHTML = `${icon(locked ? 'lock' : 'lock-open', 14, 14)}${!isRibbon ? '<span class="import-lock-btn__marker">$</span>' : ''}`;
        btn.title = isRibbon
          ? (locked ? 'Locked \u2014 import skips this product entirely' : 'Not locked \u2014 import will update this product')
          : (locked ? 'Price locked \u2014 import updates other fields but preserves price' : 'Price unlocked \u2014 import will update all fields including price');
        const row = _table.data.find(r => String(r.id) === productId);
        if (row) row.import_locked = locked;
        Toast.success(locked ? (isRibbon ? 'Import locked' : 'Price locked') : (isRibbon ? 'Import unlocked' : 'Price unlocked'));
      } catch (err) {
        Toast.error(`Lock toggle failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.style.opacity = '';
      }
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

    // Source / product_type / stock_status filters (backend-only)
    header.querySelector('#source-filter')?.addEventListener('change', (e) => {
      _sourceFilter = e.target.value; _page = 1; loadProducts();
    });
    header.querySelector('#type-filter')?.addEventListener('change', (e) => {
      _typeFilter = e.target.value; _page = 1; loadProducts();
    });
    header.querySelector('#stock-filter')?.addEventListener('change', (e) => {
      _stockFilter = e.target.value; _page = 1; loadProducts();
    });

    // Export
    bindExportDropdown(header, 'export-products', handleExport);
    header.querySelector('#add-product-btn')?.addEventListener('click', () => openCreateProductModal());

    // Show cached diagnostics instantly if available
    const DIAG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    try {
      const cached = JSON.parse(localStorage.getItem(DIAG_CACHE_KEY));
      if (cached?.data) {
        _diagnostics = cached.data;
        renderDiagnostics(container);
      }
    } catch { /* no cache or invalid */ }

    // Load products, then refresh diagnostics in background
    await loadProducts();

    // Refresh diagnostics via Supabase (non-blocking)
    const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
    if (sb) {
      // Quick check: has anything changed since cache?
      const cachedEntry = (() => { try { return JSON.parse(localStorage.getItem(DIAG_CACHE_KEY)); } catch { return null; } })();
      const isFresh = cachedEntry && (Date.now() - cachedEntry.ts < DIAG_CACHE_TTL);

      if (!isFresh) {
        // Run full diagnostics queries
        (async () => {
          try {
            const [totalR, activeR, noPriceR, noWeightR, noImageR, noCompatR] = await Promise.all([
              sb.from('products').select('id', { count: 'exact', head: true }),
              sb.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
              sb.from('products').select('id', { count: 'exact', head: true }).is('retail_price', null),
              sb.from('products').select('id', { count: 'exact', head: true }).is('weight_kg', null),
              sb.from('products').select('id', { count: 'exact', head: true }).is('image_url', null),
              (async () => { try { return await sb.rpc('count_missing_compatibility'); } catch { return null; } })(),
            ]);
            const fresh = {
              total: totalR.count,
              active: activeR.count,
              missing_images: noImageR.count,
              missing_prices: noPriceR.count,
              missing_weight: noWeightR.count,
              missing_compatibility: noCompatR?.data ?? null,
            };
            _diagnostics = fresh;
            localStorage.setItem(DIAG_CACHE_KEY, JSON.stringify({ data: fresh, ts: Date.now() }));
            if (_container === container) renderDiagnostics(container);
          } catch { /* diagnostics are optional */ }
        })();
      }
    } else {
      // Fallback to API endpoint if no Supabase client
      (async () => {
        try {
          const raw = await AdminAPI.getProductDiagnostics();
          _diagnostics = raw?.data ?? raw;
          localStorage.setItem(DIAG_CACHE_KEY, JSON.stringify({ data: _diagnostics, ts: Date.now() }));
          if (_container === container) renderDiagnostics(container);
        } catch { /* optional */ }
      })();
    }
}

export default {
  title: 'Products',

  async init(container) {
    _container = container;
    _activeProductTab = 'products';
    _subProductModule = null;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-tabs';
    tabBar.innerHTML = `
      <button class="admin-tab active" data-prod-tab="products">All Products</button>
      <button class="admin-tab" data-prod-tab="ribbons">Ribbons</button>
    `;
    container.appendChild(tabBar);

    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-prod-tab]');
      if (btn) switchProductTab(btn.dataset.prodTab);
    });

    const content = document.createElement('div');
    content.id = 'products-tab-content';
    container.appendChild(content);

    await renderProductsContent(content);
  },

  destroy() {
    if (_activeProductTab === 'products') destroyProductsContent();
    if (_subProductModule?.destroy) _subProductModule.destroy();
    _subProductModule = null;
    _container = null;
    _search = '';
    _page = 1;
    _brandFilter = '';
    _activeFilter = '';
    _imageFilter = '';
    _sourceFilter = '';
    _typeFilter = '';
    _stockFilter = '';
    _brands = [];
    _diagnostics = null;
    _activeProductTab = 'products';
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    if (_activeProductTab === 'products') {
      const input = document.getElementById('product-search');
      if (input && input.value !== query) input.value = query;
      if (_table) loadProducts();
    } else if (_subProductModule?.onSearch) {
      _subProductModule.onSearch(query);
    }
  },
};
