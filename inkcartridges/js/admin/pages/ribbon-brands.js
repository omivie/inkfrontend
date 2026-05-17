/**
 * Ribbon Brands — admin management page
 * =====================================
 * Add / edit / delete the `ribbon_brands` catalogue: the device brands
 * (Brother, Olympia, IBM, Olivetti, …) that typewriter & printer ribbons
 * are filed under. Customers filter the customer-facing /ribbons browse
 * page by these brands, and the product editor's "Ribbon Brands"
 * chip-picker (wireRibbonBrandsSection in pages/products.js) assigns
 * individual ribbon products to them via the product_ribbon_brands
 * junction.
 *
 * History — this is restored ghost code. Brand management used to live in
 * a 1366-line two-tab pages/ribbons.js (Brands | Products). Commit c8fcf9e
 * (10 May 2026) deleted the whole module because the *Products* tab was a
 * redundant copy of All Products — but the *Brands* tab was the only
 * ribbon-brand management surface and went down with it. This page brings
 * back just the brand management, standalone (no redundant Products tab).
 *
 * API surface (all already present in js/admin/api.js):
 *   AdminAPI.getAdminRibbonBrands()        — list incl. inactive
 *   AdminAPI.createRibbonBrand(data)
 *   AdminAPI.updateRibbonBrand(id, data)
 *   AdminAPI.deleteRibbonBrand(id)
 *   AdminAPI.uploadRibbonBrandImage(id, file)
 *
 * Routed at #ribbon-brands (NAV_ITEMS in app.js). NOT named ribbons.js —
 * tests/no-admin-ribbons-tab.test.js pins that the deleted module stays
 * deleted; a ribbon-brand management page is a different surface.
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const MISSING = '—';

// ── Module state ───────────────────────────────────────────────────────────
let _container = null;
let _table = null;
let _brands = [];
let _search = '';

// ── Helpers ────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function toggleHtml(id, checked) {
  return `<label class="admin-toggle"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="admin-toggle__slider"></span></label>`;
}

function formGroup(label, inputHtml) {
  return `<div class="admin-form-group"><label>${label}</label>${inputHtml}</div>`;
}

/** Brands matching the current search box (client-side — the catalogue is small). */
function filteredBrands() {
  const q = _search.trim().toLowerCase();
  if (!q) return _brands;
  return _brands.filter(b =>
    String(b.name || '').toLowerCase().includes(q) ||
    String(b.slug || '').toLowerCase().includes(q));
}

function buildColumns() {
  return [
    {
      key: 'image', label: '', className: 'cell-center cell-image',
      render: (r) => r.image_url
        ? `<img class="admin-product-thumb" src="${esc(r.image_url)}" alt="" loading="lazy">`
        : `<div class="admin-product-thumb admin-product-thumb--empty">${icon('image', 16, 16)}</div>`,
    },
    { key: 'name', label: 'Name', sortable: true, render: (r) => esc(r.name || MISSING) },
    { key: 'slug', label: 'Slug', render: (r) => `<span class="cell-mono">${esc(r.slug || MISSING)}</span>` },
    { key: 'sort_order', label: 'Order', align: 'center', sortable: true, render: (r) => String(r.sort_order ?? 0) },
    {
      key: 'is_active', label: 'Active', align: 'center',
      render: (r) => {
        const active = r.is_active !== false;
        return `<span class="admin-active-dot admin-active-dot--${active ? 'on' : 'off'}" title="${active ? 'Active' : 'Inactive'}"></span>`;
      },
    },
  ];
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderContent(container) {
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'admin-page-header';
  header.innerHTML = `<h1>Ribbon Brands</h1>`;
  container.appendChild(header);

  const blurb = document.createElement('p');
  blurb.style.cssText = 'margin:-8px 0 16px;font-size:13px;color:var(--text-muted);max-width:680px';
  blurb.textContent = 'Device brands that typewriter & printer ribbons are filed under. '
    + 'Customers filter the Ribbons page by these, and the product editor assigns each ribbon to one or more of them.';
  container.appendChild(blurb);

  const toolbar = document.createElement('div');
  toolbar.className = 'admin-toolbar';
  toolbar.style.marginBottom = '12px';
  toolbar.innerHTML = `
    <div class="admin-search" style="flex:1;max-width:280px">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" class="admin-input" placeholder="Search brands…" id="ribbon-brand-search" value="${esc(_search)}" style="padding-left:30px">
    </div>
    <div style="flex:1"></div>
    <button class="admin-btn admin-btn--primary admin-btn--sm" id="add-brand-btn">${icon('plus', 14, 14)} Add Brand</button>
  `;
  container.appendChild(toolbar);

  toolbar.querySelector('#add-brand-btn').addEventListener('click', () => openBrandModal(null));
  const searchInput = toolbar.querySelector('#ribbon-brand-search');
  searchInput.addEventListener('input', () => {
    _search = searchInput.value;
    if (_table) _table.setData(filteredBrands());
  });

  const tableWrap = document.createElement('div');
  container.appendChild(tableWrap);

  _table = new DataTable(tableWrap, {
    columns: buildColumns(),
    rowKey: 'id',
    onRowClick: (row) => openBrandModal(row),
    emptyMessage: 'No ribbon brands yet — click “Add Brand” to create one.',
  });

  loadBrands();
}

async function loadBrands() {
  if (_table) _table.setLoading(true);
  try {
    const data = await AdminAPI.getAdminRibbonBrands();
    _brands = Array.isArray(data) ? data : [];
  } catch (e) {
    _brands = [];
    Toast.error(`Failed to load ribbon brands: ${e.message}`);
  }
  if (_container && _table) _table.setData(filteredBrands());
}

// ── Create / Edit / Delete modal ───────────────────────────────────────────
function openBrandModal(brand) {
  const isEdit = !!brand;
  const title = isEdit ? `Edit Brand: ${brand.name}` : 'New Ribbon Brand';

  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:14px">
      ${formGroup('Name <span class="required-star">*</span>', `<input class="admin-input" id="edit-brand-name" value="${esc(brand?.name || '')}" placeholder="e.g. Olympia">`)}
      ${formGroup('Slug', `<input class="admin-input" id="edit-brand-slug" value="${esc(brand?.slug || '')}" placeholder="auto-generated from name">`)}
      ${formGroup('Sort Order', `<input class="admin-input" id="edit-brand-order" type="number" value="${brand?.sort_order ?? 0}">`)}
      ${formGroup('Active', toggleHtml('edit-brand-active', brand?.is_active !== false))}
      ${isEdit ? `
        <div class="admin-form-group">
          <label>Brand Image</label>
          <div id="brand-image-preview" style="margin-bottom:8px">
            ${brand.image_url
              ? `<img src="${esc(brand.image_url)}" style="max-width:120px;max-height:80px;border-radius:var(--radius);border:1px solid var(--border)">`
              : '<span class="admin-text-muted" style="font-size:13px">No image</span>'}
          </div>
          <input type="file" id="brand-image-upload" accept="image/png,image/jpeg,image/webp,image/gif">
        </div>
      ` : `<p style="margin:0;font-size:12px;color:var(--text-muted)">Save the brand first, then reopen it to upload a logo image.</p>`}
    </div>
  `;

  let footerHtml = `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`;
  if (isEdit) footerHtml += `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="delete" style="margin-right:auto">Delete</button>`;
  footerHtml += `<button class="admin-btn admin-btn--primary" data-action="save">${isEdit ? 'Save Changes' : 'Create Brand'}</button>`;

  const modal = Modal.open({ title, body: bodyHtml, footer: footerHtml });
  if (!modal) return;

  const nameInput = modal.body.querySelector('#edit-brand-name');
  const slugInput = modal.body.querySelector('#edit-brand-slug');

  // Auto-fill slug from name until the user hand-edits the slug.
  let slugTouched = isEdit && !!brand.slug;
  slugInput.addEventListener('input', () => { slugTouched = true; });
  nameInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = slugify(nameInput.value);
  });

  // Image upload (edit only — needs an existing brand id).
  if (isEdit) {
    const fileInput = modal.body.querySelector('#brand-image-upload');
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.disabled = true;
      Toast.info('Uploading image…');
      try {
        const result = await AdminAPI.uploadRibbonBrandImage(brand.id, file);
        if (result?.image_url) {
          brand.image_url = result.image_url;
          modal.body.querySelector('#brand-image-preview').innerHTML =
            `<img src="${esc(result.image_url)}" style="max-width:120px;max-height:80px;border-radius:var(--radius);border:1px solid var(--border)">`;
          // Reflect the new thumbnail in the table without a full refetch.
          const row = _brands.find(b => String(b.id) === String(brand.id));
          if (row) { row.image_url = result.image_url; if (_table) _table.setData(filteredBrands()); }
          Toast.success('Image uploaded');
        }
      } catch (e) {
        Toast.error(`Image upload failed: ${e.message}`);
      } finally {
        fileInput.disabled = false;
      }
    });
  }

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  // Delete — with confirmation.
  if (isEdit) {
    modal.footer.querySelector('[data-action="delete"]').addEventListener('click', () => {
      Modal.close();
      Modal.confirm({
        title: 'Delete Ribbon Brand',
        message: `Delete “${brand.name}”? Ribbons currently filed under it will lose that brand assignment. This cannot be undone.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deleteRibbonBrand(brand.id);
            Toast.success('Brand deleted');
            await loadBrands();
          } catch (e) {
            Toast.error(`Delete failed: ${e.message}`);
          }
        },
      });
    });
  }

  // Save — create or update.
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { Toast.error('Name is required'); nameInput.focus(); return; }

    // Block a duplicate name (case-insensitive) against a *different* brand.
    const dupe = _brands.find(b =>
      String(b.name || '').toLowerCase() === name.toLowerCase() &&
      (!isEdit || String(b.id) !== String(brand.id)));
    if (dupe) { Toast.error(`A brand named “${dupe.name}” already exists`); nameInput.focus(); return; }

    const payload = {
      name,
      slug: slugInput.value.trim() || slugify(name),
      sort_order: parseInt(modal.body.querySelector('#edit-brand-order').value, 10) || 0,
      is_active: !!modal.body.querySelector('#edit-brand-active').checked,
    };

    const saveBtn = modal.footer.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (isEdit) {
        await AdminAPI.updateRibbonBrand(brand.id, payload);
        Toast.success('Brand updated');
      } else {
        await AdminAPI.createRibbonBrand(payload);
        Toast.success('Brand created');
      }
      Modal.close();
      await loadBrands();
    } catch (e) {
      Toast.error(`Save failed: ${e.message}`);
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Brand';
    }
  });
}

// ── Module export ──────────────────────────────────────────────────────────
export default {
  async init(container) {
    _container = container;
    _table = null;
    _brands = [];
    _search = '';
    FilterState.showBar(false); // page ships its own search box
    renderContent(container);
  },

  destroy() {
    if (_table) { _table.destroy(); _table = null; }
    _container = null;
    _brands = [];
    _search = '';
  },
};
