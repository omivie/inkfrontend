/**
 * Printers Page — Manage printer models (printer_models table)
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const MISSING = '\u2014';
const LIMIT = 200;

// ── State ────────────────────────────────────────────────────────────────
let _container = null;
let _table = null;
let _brands = [];
let _search = '';
let _brandFilter = '';
let _sort = 'full_name';
let _sortDir = 'asc';
let _page = 1;

// ── Helpers ──────────────────────────────────────────────────────────────
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formGroup(label, inputHtml) {
  return `<div class="admin-form-group"><label>${label}</label>${inputHtml}</div>`;
}

function buildBrandOpts(selectedId = '') {
  let html = '<option value="">No brand</option>';
  for (const b of _brands) {
    const sel = String(b.id) === String(selectedId) ? ' selected' : '';
    html += `<option value="${esc(String(b.id))}"${sel}>${esc(b.name)}</option>`;
  }
  return html;
}

// ── Columns ──────────────────────────────────────────────────────────────
function buildColumns() {
  return [
    {
      key: 'full_name', label: 'Full Name', sortable: true,
      render: (r) => `<span style="font-weight:500">${esc(r.full_name || MISSING)}</span>`,
    },
    {
      key: 'model_name', label: 'Model', sortable: true,
      render: (r) => r.model_name
        ? `<span class="cell-mono">${esc(r.model_name)}</span>`
        : `<span style="color:var(--text-muted)">${MISSING}</span>`,
    },
    {
      key: 'brand', label: 'Brand',
      render: (r) => {
        const name = r.brands?.name || '';
        return name ? `<span class="admin-badge admin-badge--processing">${esc(name)}</span>` : `<span style="color:var(--text-muted)">${MISSING}</span>`;
      },
    },
    {
      key: 'slug', label: 'Slug',
      render: (r) => `<span class="cell-mono" style="font-size:0.8em;color:var(--text-muted)">${esc(r.slug || MISSING)}</span>`,
    },
    {
      key: 'actions', label: '', align: 'right',
      render: (r) => `
        <button class="admin-btn admin-btn--ghost admin-btn--sm printer-edit-btn" data-id="${esc(String(r.id))}" title="Edit">
          ${icon('edit', 14, 14)}
        </button>
        <button class="admin-btn admin-btn--ghost admin-btn--sm printer-delete-btn" data-id="${esc(String(r.id))}" data-name="${esc(r.full_name || '')}" title="Delete" style="color:var(--danger)">
          ${icon('trash', 14, 14)}
        </button>
      `,
    },
  ];
}

// ── Data Loading ─────────────────────────────────────────────────────────
async function loadPrinters() {
  if (!_table) return;
  _table.setLoading(true);
  const { printers, total } = await AdminAPI.getPrinters({
    search: _search,
    brandId: _brandFilter,
    sort: _sort,
    order: _sortDir,
    page: _page,
    limit: LIMIT,
  });
  if (!_table) return;
  _table.setData(printers, { total, page: _page, limit: LIMIT });
}

// ── Modal ─────────────────────────────────────────────────────────────────
function openPrinterModal(printer) {
  const isEdit = !!printer;
  const title = isEdit ? `Edit: ${printer.full_name || printer.model_name}` : 'New Printer Model';

  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:14px">
      ${formGroup('Full Name <span class="required-star">*</span>', `<input class="admin-input" id="pm-full-name" value="${esc(printer?.full_name || '')}" placeholder="e.g. Brother DCP-J140W">`)}
      ${formGroup('Model Name', `<input class="admin-input" id="pm-model-name" value="${esc(printer?.model_name || '')}" placeholder="e.g. DCP-J140W">`)}
      ${formGroup('Brand', `<select class="admin-select" id="pm-brand">${buildBrandOpts(printer?.brand_id || '')}</select>`)}
      ${formGroup('Slug', `<input class="admin-input" id="pm-slug" value="${esc(printer?.slug || '')}" placeholder="auto-generated">`)}
    </div>
  `;

  let footerHtml = `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`;
  if (isEdit) footerHtml += `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="delete" style="margin-right:auto">Delete</button>`;
  footerHtml += `<button class="admin-btn admin-btn--primary" data-action="save">${isEdit ? 'Save Changes' : 'Create Printer'}</button>`;

  const modal = Modal.open({ title, body: bodyHtml, footer: footerHtml });
  if (!modal) return;

  const fullNameInput = modal.body.querySelector('#pm-full-name');
  const slugInput = modal.body.querySelector('#pm-slug');

  fullNameInput.addEventListener('input', () => {
    if (!isEdit || !printer?.slug) slugInput.value = slugify(fullNameInput.value);
  });

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  if (isEdit) {
    modal.footer.querySelector('[data-action="delete"]').addEventListener('click', () => {
      Modal.close();
      Modal.confirm({
        title: 'Delete Printer Model',
        message: `Delete "${printer.full_name}"? This will also remove it from all compatible product links.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deletePrinter(printer.id);
            Toast.success('Printer deleted');
            loadPrinters();
          } catch (e) {
            Toast.error(`Delete failed: ${e.message}`);
          }
        },
      });
    });
  }

  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const fullName = fullNameInput.value.trim();
    if (!fullName) { Toast.error('Full Name is required'); fullNameInput.focus(); return; }
    const modelName = modal.body.querySelector('#pm-model-name').value.trim();
    const brandId = modal.body.querySelector('#pm-brand').value || null;
    const slug = slugInput.value.trim() || slugify(fullName);

    const saveBtn = modal.footer.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';

    try {
      if (isEdit) {
        await AdminAPI.updatePrinter(printer.id, { full_name: fullName, model_name: modelName || null, slug, brand_id: brandId });
        Toast.success('Printer updated');
      } else {
        // Create via backend (handles slug/name normalisation), then patch extra fields
        const created = await AdminAPI.createPrinter(fullName);
        const newId = created?.id || created?.printer_id;
        if (newId) {
          await AdminAPI.updatePrinter(newId, { full_name: fullName, model_name: modelName || null, slug, brand_id: brandId });
        }
        Toast.success('Printer created');
      }
      Modal.close();
      loadPrinters();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Printer';
    }
  });
}

// ── Page Render ───────────────────────────────────────────────────────────
async function renderPrintersContent(container) {
  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'admin-toolbar';

  let brandOpts = '<option value="">All Brands</option>';
  for (const b of _brands) {
    brandOpts += `<option value="${esc(String(b.id))}">${esc(b.name)}</option>`;
  }

  toolbar.innerHTML = `
    <div class="admin-search">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" placeholder="Search printers\u2026" id="printer-search" value="${esc(_search)}">
    </div>
    <select class="admin-select" id="printer-brand-filter">${brandOpts}</select>
    <div style="flex:1"></div>
    <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-printer-btn">${icon('plus', 14, 14)} Add Printer</button>
  `;
  container.appendChild(toolbar);

  // Bind toolbar events
  toolbar.querySelector('#printer-search').addEventListener('input', (e) => {
    _search = e.target.value;
    _page = 1;
    loadPrinters();
  });

  toolbar.querySelector('#printer-brand-filter').addEventListener('change', (e) => {
    _brandFilter = e.target.value;
    _page = 1;
    loadPrinters();
  });

  toolbar.querySelector('#add-printer-btn').addEventListener('click', () => openPrinterModal(null));

  // Table
  const tableWrap = document.createElement('div');
  container.appendChild(tableWrap);

  _table = new DataTable(tableWrap, {
    columns: buildColumns(),
    rowKey: 'id',
    onRowClick: (row) => openPrinterModal(row),
    emptyMessage: 'No printer models found',
    onSort: (col, dir) => {
      _sort = col;
      _sortDir = dir;
      _page = 1;
      loadPrinters();
    },
    onPageChange: (page) => {
      _page = page;
      loadPrinters();
    },
  });

  // Row action buttons (edit / delete) via delegation
  tableWrap.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.printer-edit-btn');
    const deleteBtn = e.target.closest('.printer-delete-btn');
    if (!editBtn && !deleteBtn) return;
    e.stopPropagation();
    const id = (editBtn || deleteBtn).dataset.id;
    const row = _table?.data?.find(r => String(r.id) === id);
    if (!row) return;
    if (deleteBtn) {
      Modal.confirm({
        title: 'Delete Printer Model',
        message: `Delete "${row.full_name}"? This will also remove it from all compatible product links.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deletePrinter(row.id);
            Toast.success('Printer deleted');
            loadPrinters();
          } catch (err) {
            Toast.error(`Delete failed: ${err.message}`);
          }
        },
      });
    } else {
      openPrinterModal(row);
    }
  });

  await loadPrinters();
}

// ── Module Export ─────────────────────────────────────────────────────────
export default {
  async init(container) {
    _container = container;
    _search = '';
    _brandFilter = '';
    _sort = 'full_name';
    _sortDir = 'asc';
    _page = 1;
    _table = null;

    // Load brands for filter + modal dropdown
    const brandsData = await AdminAPI.getBrands();
    _brands = Array.isArray(brandsData) ? brandsData : [];

    await renderPrintersContent(container);
  },

  destroy() {
    if (_table) { _table.destroy(); _table = null; }
    _container = null;
    _brands = [];
    _search = '';
    _brandFilter = '';
    _page = 1;
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    const input = _container?.querySelector('#printer-search');
    if (input && input.value !== query) input.value = query;
    loadPrinters();
  },
};
