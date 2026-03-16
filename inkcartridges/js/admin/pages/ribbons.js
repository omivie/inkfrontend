/**
 * Ribbons Page — Admin CRUD for printer/typewriter ribbons & correction tapes
 * Follows the same pattern as Products & SKUs page
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _sort = 'name';
let _sortDir = 'asc';
let _brandFilter = '';
let _typeFilter = '';
let _activeFilter = '';
let _brands = [];
let _lastRibbons = [];

const RIBBON_TYPES = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'];
const RIBBON_TYPE_LABELS = {
  'printer_ribbon': 'Printer Ribbon',
  'typewriter_ribbon': 'Typewriter Ribbon',
  'correction_tape': 'Correction Tape',
};

function stockBadge(ribbon) {
  const qty = ribbon.stock_quantity;
  if (qty == null) return `<span class="admin-badge admin-badge--pending">Unknown</span>`;
  if (qty <= 0) return `<span class="admin-badge admin-badge--failed">Out of stock</span>`;
  if (qty <= 10) return `<span class="admin-badge admin-badge--pending">Low (${qty})</span>`;
  return `<span class="admin-badge admin-badge--completed">In stock (${qty})</span>`;
}

function typeBadge(type) {
  const label = RIBBON_TYPE_LABELS[type] || type || MISSING;
  return `<span class="admin-badge admin-badge--processing">${esc(label)}</span>`;
}

function buildColumns() {
  const isOwner = AdminAuth.isOwner();
  const cols = [
    {
      key: 'sku', label: 'SKU',
      render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>`,
    },
    {
      key: 'name', label: 'Name', sortable: true,
      render: (r) => `<span class="cell-truncate">${esc(r.name || MISSING)}</span>`,
    },
    {
      key: 'brand', label: 'Brand', sortable: true,
      render: (r) => r.brand ? `<span class="admin-badge admin-badge--processing">${esc(r.brand)}</span>` : MISSING,
    },
    {
      key: 'ribbon_type', label: 'Type',
      render: (r) => typeBadge(r.ribbon_type),
    },
    {
      key: 'color', label: 'Color',
      render: (r) => esc(r.color || MISSING),
    },
    {
      key: 'sale_price', label: 'Price', sortable: true,
      render: (r) => `<span class="cell-mono cell-right">${r.sale_price != null ? formatPrice(r.sale_price) : MISSING}</span>`,
      align: 'right',
    },
  ];

  if (isOwner) {
    cols.push({
      key: 'cost_price', label: 'Cost', sortable: true,
      render: (r) => `<span class="cell-mono cell-right admin-text-muted">${r.cost_price != null ? formatPrice(r.cost_price) : MISSING}</span>`,
      align: 'right',
    });
    cols.push({
      key: 'margin_percent', label: 'Margin',
      render: (r) => r.margin_percent != null ? `${Number(r.margin_percent).toFixed(1)}%` : MISSING,
      align: 'right',
    });
  }

  cols.push(
    {
      key: 'stock_quantity', label: 'Stock', sortable: true,
      render: (r) => {
        const qty = r.stock_quantity;
        const color = qty == null ? '' : qty <= 0 ? 'var(--danger)' : qty <= 10 ? 'var(--yellow)' : 'var(--text)';
        return `<span class="cell-mono cell-center"${color ? ` style="color:${color}"` : ''}>${qty != null ? qty : MISSING}</span>`;
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
  );

  return cols;
}

// ---- Data loading ----

async function loadRibbons() {
  if (!_table) return;
  _table.setLoading(true);

  const filters = {};
  if (_search) filters.search = _search;
  if (_brandFilter) filters.brand = _brandFilter;
  if (_typeFilter) filters.type = _typeFilter;
  if (_activeFilter !== '') filters.is_active = _activeFilter;
  if (_sort) filters.sort = _sort;

  const data = await AdminAPI.getAdminRibbons(filters, _page, 200);
  if (!_table) return; // destroyed during await
  if (!data) { _table.setData([], null); return; }

  const ribbons = data?.ribbons || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || { total: ribbons.length, page: _page, limit: 200 };

  _lastRibbons = ribbons;
  _table.setData(ribbons, pagination);
}

// ---- Detail Drawer (matches Products pattern) ----

async function openRibbonDrawer(ribbon) {
  const drawer = Drawer.open({
    title: esc(ribbon.name || ribbon.sku || 'Ribbon'),
    width: '560px',
  });
  if (!drawer) return;
  drawer.setLoading(true);

  // Fetch full ribbon detail
  const full = await AdminAPI.getAdminRibbon(ribbon.id) || ribbon;
  const isOwner = AdminAuth.isOwner();

  let html = '';

  // Basic Info
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Basic Info</div>`;
  html += formGroup('SKU', `<input class="admin-input" id="edit-sku" value="${esc(full.sku || '')}" disabled>`);
  html += formGroup('Name', `<input class="admin-input" id="edit-name" value="${esc(full.name || '')}">`);
  html += `<div class="admin-form-row">`;
  html += formGroup('Brand', `<input class="admin-input" id="edit-brand" value="${esc(full.brand || '')}">`);
  html += formGroup('Ribbon Type', buildTypeSelect(full.ribbon_type));
  html += `</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Model', `<input class="admin-input" id="edit-model" value="${esc(full.model || '')}" placeholder="e.g. ERC-30/34/38">`);
  html += formGroup('Color', `<input class="admin-input" id="edit-color" value="${esc(full.color || '')}" placeholder="e.g. Black/Red">`);
  html += `</div>`;
  html += formGroup('Compatibility', `<textarea class="admin-textarea" id="edit-compatibility" rows="2" placeholder="Compatible devices">${esc(full.compatibility || '')}</textarea>`);
  html += `</div>`;

  // Pricing
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Pricing</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Sale Price (inc GST)', `<input class="admin-input" id="edit-sale-price" type="number" step="0.01" min="0" value="${full.sale_price ?? ''}">`);
  if (isOwner) {
    html += formGroup('Cost Price (ex GST)', `<input class="admin-input" id="edit-cost-price" type="number" step="0.01" min="0" value="${full.cost_price ?? ''}">`);
  }
  html += `</div>`;
  if (isOwner && full.margin_percent != null) {
    html += `<div class="admin-form-row"><div class="admin-form-group"><label>Margin</label><div class="admin-input" style="background:var(--steel-100,#f1f5f9);border:none">${Number(full.margin_percent).toFixed(1)}%</div></div></div>`;
  }
  html += `</div>`;

  // Inventory
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Inventory</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Stock Quantity', `<input class="admin-input" id="edit-stock" type="number" min="0" value="${full.stock_quantity ?? 0}">`);
  html += formGroup('Active', toggleHtml('edit-active', full.is_active !== false));
  html += `</div>`;
  html += `</div>`;

  // Image
  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Image</div>`;
  html += formGroup('Image Path', `<input class="admin-input" id="edit-image-path" value="${esc(full.image_path || '')}" placeholder="e.g. images/ribbons/655.02.jpg">`);
  html += `</div>`;

  // Actions
  html += `<div style="display:flex;gap:8px;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border)">`;
  html += `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`;
  html += `<button class="admin-btn admin-btn--danger admin-btn--ghost" data-action="deactivate">Deactivate</button>`;
  html += `<button class="admin-btn admin-btn--primary" data-action="save">${icon('orders', 14, 14)} Save Changes</button>`;
  html += `</div>`;

  drawer.setBody(html);
  bindDrawerActions(drawer, full);
}

function formGroup(label, inputHtml) {
  return `<div class="admin-form-group"><label>${esc(label)}</label>${inputHtml}</div>`;
}

function buildTypeSelect(selected) {
  let html = '<select class="admin-select" id="edit-ribbon-type">';
  for (const t of RIBBON_TYPES) {
    const sel = selected === t ? ' selected' : '';
    html += `<option value="${t}"${sel}>${esc(RIBBON_TYPE_LABELS[t])}</option>`;
  }
  html += '</select>';
  return html;
}

function toggleHtml(id, checked) {
  return `<label class="admin-toggle"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="admin-toggle__slider"></span></label>`;
}

function bindDrawerActions(drawer, ribbon) {
  const body = drawer.body;

  // Cancel
  body.querySelector('[data-action="cancel"]')?.addEventListener('click', () => Drawer.close());

  // Deactivate
  body.querySelector('[data-action="deactivate"]')?.addEventListener('click', async () => {
    const confirmed = await Modal.confirm({
      title: 'Deactivate Ribbon',
      message: `Deactivate "${ribbon.name}"? This is a soft delete (sets is_active to false).`,
    });
    if (!confirmed) return;

    try {
      await AdminAPI.deleteAdminRibbon(ribbon.id);
      Toast.success('Ribbon deactivated');
      Drawer.close();
      loadRibbons();
    } catch (err) {
      Toast.error(err.message || 'Failed to deactivate ribbon');
    }
  });

  // Save
  body.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
    const val = (id) => body.querySelector(`#${id}`)?.value?.trim();
    const numVal = (id) => { const v = val(id); return v !== '' && v != null ? Number(v) : undefined; };
    const chk = (id) => body.querySelector(`#${id}`)?.checked;

    const payload = {};
    if (val('edit-name') !== (ribbon.name || '')) payload.name = val('edit-name');
    if (val('edit-brand') !== (ribbon.brand || '')) payload.brand = val('edit-brand');
    if (val('edit-ribbon-type') !== (ribbon.ribbon_type || '')) payload.ribbon_type = val('edit-ribbon-type');
    if (val('edit-model') !== (ribbon.model || '')) payload.model = val('edit-model');
    if (val('edit-color') !== (ribbon.color || '')) payload.color = val('edit-color');
    if (val('edit-compatibility') !== (ribbon.compatibility || '')) payload.compatibility = val('edit-compatibility');

    const sp = numVal('edit-sale-price');
    if (sp !== undefined && sp !== ribbon.sale_price) payload.sale_price = sp;
    if (AdminAuth.isOwner()) {
      const cp = numVal('edit-cost-price');
      if (cp !== undefined && cp !== ribbon.cost_price) payload.cost_price = cp;
    }

    const stock = numVal('edit-stock');
    if (stock !== undefined && stock !== ribbon.stock_quantity) payload.stock_quantity = stock;
    payload.is_active = chk('edit-active');

    const imgPath = val('edit-image-path');
    if (imgPath !== (ribbon.image_path || '')) payload.image_path = imgPath || null;

    if (Object.keys(payload).length === 0) {
      Toast.info('No changes to save');
      return;
    }

    try {
      await AdminAPI.updateAdminRibbon(ribbon.id, payload);
      Toast.success('Ribbon updated');
      Drawer.close();
      loadRibbons();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
    }
  });
}

// ---- Create Ribbon (new ribbon form in drawer) ----

function openCreateDrawer() {
  const drawer = Drawer.open({
    title: 'New Ribbon',
    width: '560px',
  });
  if (!drawer) return;

  let html = `<form id="ribbon-create-form">`;

  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Basic Info</div>`;
  html += formGroup('SKU *', `<input class="admin-input" id="create-sku" placeholder="e.g. 655.02" required>`);
  html += formGroup('Name *', `<input class="admin-input" id="create-name" required>`);
  html += `<div class="admin-form-row">`;
  html += formGroup('Brand *', `<input class="admin-input" id="create-brand">`);
  html += formGroup('Ribbon Type *', `<select class="admin-select" id="create-ribbon-type">${RIBBON_TYPES.map(t => `<option value="${t}">${esc(RIBBON_TYPE_LABELS[t])}</option>`).join('')}</select>`);
  html += `</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Model', `<input class="admin-input" id="create-model" placeholder="e.g. ERC-30/34/38">`);
  html += formGroup('Color', `<input class="admin-input" id="create-color" placeholder="e.g. Black/Red">`);
  html += `</div>`;
  html += formGroup('Compatibility', `<textarea class="admin-textarea" id="create-compatibility" rows="2" placeholder="Compatible devices"></textarea>`);
  html += `</div>`;

  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Pricing</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Sale Price (inc GST) *', `<input class="admin-input" id="create-sale-price" type="number" step="0.01" min="0" required>`);
  html += formGroup('Cost Price (ex GST) *', `<input class="admin-input" id="create-cost-price" type="number" step="0.01" min="0" required>`);
  html += `</div>`;
  html += `</div>`;

  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Inventory</div>`;
  html += `<div class="admin-form-row">`;
  html += formGroup('Stock Quantity', `<input class="admin-input" id="create-stock" type="number" min="0" value="0">`);
  html += formGroup('Active', toggleHtml('create-active', true));
  html += `</div>`;
  html += `</div>`;

  html += `<div class="admin-detail-block">`;
  html += `<div class="admin-detail-block__title">Image</div>`;
  html += formGroup('Image Path', `<input class="admin-input" id="create-image-path" placeholder="e.g. images/ribbons/655.02.jpg">`);
  html += `</div>`;

  html += `<div style="display:flex;gap:8px;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border)">`;
  html += `<button type="button" class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`;
  html += `<button type="submit" class="admin-btn admin-btn--primary">${icon('products', 14, 14)} Create Ribbon</button>`;
  html += `</div>`;

  html += `</form>`;

  drawer.setBody(html);

  const body = drawer.body;
  body.querySelector('[data-action="cancel"]')?.addEventListener('click', () => Drawer.close());

  body.querySelector('#ribbon-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (id) => body.querySelector(`#${id}`)?.value?.trim();
    const numVal = (id) => { const v = val(id); return v ? Number(v) : undefined; };

    const payload = {
      sku: val('create-sku'),
      name: val('create-name'),
      brand: val('create-brand'),
      ribbon_type: val('create-ribbon-type'),
      sale_price: parseFloat(val('create-sale-price')),
      cost_price: parseFloat(val('create-cost-price')),
      is_active: body.querySelector('#create-active')?.checked ?? true,
    };

    const model = val('create-model');
    const color = val('create-color');
    const compatibility = val('create-compatibility');
    const stock = numVal('create-stock');
    const imagePath = val('create-image-path');

    if (model) payload.model = model;
    if (color) payload.color = color;
    if (compatibility) payload.compatibility = compatibility;
    if (stock != null) payload.stock_quantity = stock;
    if (imagePath) payload.image_path = imagePath;

    try {
      await AdminAPI.createAdminRibbon(payload);
      Toast.success('Ribbon created');
      Drawer.close();
      loadRibbons();
    } catch (err) {
      Toast.error(err.message || 'Failed to create ribbon');
    }
  });
}

// ---- CSV Export ----

async function handleExport() {
  try {
    Toast.info('Preparing export\u2026');
    const filters = {};
    if (_brandFilter) filters.brand = _brandFilter;
    if (_typeFilter) filters.type = _typeFilter;
    if (_activeFilter !== '') filters.is_active = _activeFilter;
    await AdminAPI.exportCSV('ribbons', filters);
    Toast.success('Ribbons exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

// ---- Extract unique brands from loaded ribbons ----

async function loadBrands() {
  // Try to pull unique brands from a full scan
  try {
    const data = await AdminAPI.getAdminRibbons({}, 1, 200);
    const ribbons = data?.ribbons || (Array.isArray(data) ? data : []);
    const brandSet = new Set();
    for (const r of ribbons) {
      if (r.brand) brandSet.add(r.brand);
    }
    _brands = [...brandSet].sort();
  } catch {
    _brands = [];
  }
}

// ---- Page lifecycle ----

export default {
  title: 'Ribbons',

  async init(container) {
    _container = container;
    _page = 1;
    _search = '';
    _sort = 'name';
    _sortDir = 'asc';
    _brandFilter = '';
    _typeFilter = '';
    _activeFilter = '';

    FilterState.showBar(false);

    // Load brands for filter
    await loadBrands();

    // Header with two-row layout
    const header = document.createElement('div');

    let brandOpts = '<option value="">All Brands</option>';
    for (const b of _brands) {
      brandOpts += `<option value="${esc(b)}">${esc(b)}</option>`;
    }

    let typeOpts = '<option value="">All Types</option>';
    for (const t of RIBBON_TYPES) {
      typeOpts += `<option value="${esc(t)}">${esc(RIBBON_TYPE_LABELS[t])}</option>`;
    }

    header.className = 'admin-page-header admin-page-header--with-toolbar';
    header.innerHTML = `
      <div class="admin-page-header__top">
        <h1>Ribbons</h1>
        <div class="admin-page-header__actions">
          <button class="admin-btn admin-btn--ghost" id="export-ribbons-btn">
            ${icon('download', 14, 14)} Export
          </button>
          <button class="admin-btn admin-btn--primary" id="add-ribbon-btn">
            ${icon('products', 14, 14)} Add Ribbon
          </button>
        </div>
      </div>
      <div class="admin-toolbar">
        <div class="admin-search">
          <span class="admin-search__icon">${icon('search', 14, 14)}</span>
          <input type="search" placeholder="Search ribbons\u2026" id="ribbon-search">
        </div>
        <select class="admin-select" id="brand-filter">${brandOpts}</select>
        <select class="admin-select" id="type-filter">${typeOpts}</select>
        <select class="admin-select" id="active-filter">
          <option value="">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
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
      onRowClick: (row) => openRibbonDrawer(row),
      onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadRibbons(); },
      onPageChange: (page) => { _page = page; loadRibbons(); },
      emptyMessage: 'No ribbons found',
      emptyIcon: icon('products', 40, 40),
    });

    // Search
    const searchInput = header.querySelector('#ribbon-search');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { _search = searchInput.value.trim(); _page = 1; loadRibbons(); }, 300);
    });

    // Brand filter
    header.querySelector('#brand-filter').addEventListener('change', (e) => {
      _brandFilter = e.target.value; _page = 1; loadRibbons();
    });

    // Type filter
    header.querySelector('#type-filter').addEventListener('change', (e) => {
      _typeFilter = e.target.value; _page = 1; loadRibbons();
    });

    // Active filter
    header.querySelector('#active-filter').addEventListener('change', (e) => {
      _activeFilter = e.target.value; _page = 1; loadRibbons();
    });

    // Export
    header.querySelector('#export-ribbons-btn').addEventListener('click', handleExport);

    // Add ribbon
    header.querySelector('#add-ribbon-btn').addEventListener('click', () => openCreateDrawer());

    // Load data
    await loadRibbons();
  },

  destroy() {
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _search = '';
    _page = 1;
    _brandFilter = '';
    _typeFilter = '';
    _activeFilter = '';
    _brands = [];
    _lastRibbons = [];
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    // Sync the page-level search input
    const input = document.getElementById('ribbon-search');
    if (input && input.value !== query) input.value = query;
    if (_table) loadRibbons();
  },
};
