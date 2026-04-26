/**
 * Image Audit Page — Temporary tool for reviewing/cleaning product images.
 * Lets the user page through products with all images displayed at large size,
 * click any image for a full-screen lightbox, and delete duplicate or wrong
 * images inline. Mirrors the filter set on the Products page.
 */
import { AdminAuth, FilterState, AdminAPI, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const PAGE_SIZE = 60;

let _container = null;
let _page = 1;
let _search = '';
let _brandFilter = '';
let _activeFilter = '';
let _imageFilter = '';
let _sourceFilter = '';
let _typeFilter = '';
let _stockFilter = '';
let _brands = [];
let _products = [];
let _pagination = { total: 0, page: 1, limit: PAGE_SIZE };
let _loadToken = 0;

function openImageLightbox(url, alt = '') {
  if (!url) return;
  document.querySelector('.admin-image-lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'admin-image-lightbox';
  overlay.innerHTML = `
    <button class="admin-image-lightbox__close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
    <img class="admin-image-lightbox__img" src="${esc(url)}" alt="${esc(alt)}">
  `;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.admin-image-lightbox__close')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

async function fetchProductImages(productIds) {
  if (!productIds.length) return {};
  const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
  if (!sb) return {};
  try {
    const { data, error } = await sb.from('product_images')
      .select('id, product_id, path, alt_text, is_primary, sort_order')
      .in('product_id', productIds)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    const map = {};
    for (const img of (data || [])) {
      if (!map[img.product_id]) map[img.product_id] = [];
      map[img.product_id].push(img);
    }
    return map;
  } catch (e) {
    return {};
  }
}

/** Resolve a product_images row (or legacy path) into a thumbnail + raw URL pair. */
function resolveImage(img) {
  const path = (typeof img === 'string' ? img : (img?.path || img?.image_url || img?.url || ''));
  if (!path) return { thumb: '', raw: '' };
  if (path.startsWith('http') || path.startsWith('/')) {
    return { thumb: path, raw: path };
  }
  const thumb = (typeof optimizedImageUrl === 'function')
    ? optimizedImageUrl(path, 800)
    : (typeof storageUrl === 'function' ? storageUrl(path) : path);
  const raw = (typeof storageUrlRaw === 'function') ? storageUrlRaw(path) : thumb;
  return { thumb, raw };
}

function buildToolbar() {
  let brandOpts = '<option value="">All Brands</option>';
  for (const b of _brands) {
    const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
    const val = (typeof b === 'object' && b.id) ? b.id : name;
    const sel = String(val) === String(_brandFilter) ? ' selected' : '';
    brandOpts += `<option value="${esc(val)}"${sel}>${esc(name)}</option>`;
  }
  const sel = (cur, val) => cur === val ? ' selected' : '';
  return `
    <div class="admin-toolbar">
      <div class="admin-search" id="audit-search-wrap">
        <span class="admin-search__icon">${icon('search', 14, 14)}</span>
        <input type="search" placeholder="Search…" id="audit-search" value="${esc(_search)}">
      </div>
      <select class="admin-select" id="audit-brand">${brandOpts}</select>
      <select class="admin-select" id="audit-active">
        <option value="">All Status</option>
        <option value="true"${sel(_activeFilter, 'true')}>Active</option>
        <option value="false"${sel(_activeFilter, 'false')}>Inactive</option>
      </select>
      <select class="admin-select" id="audit-images">
        <option value="">All Images</option>
        <option value="has-images"${sel(_imageFilter, 'has-images')}>Has Images</option>
        <option value="no-images"${sel(_imageFilter, 'no-images')}>No Images</option>
      </select>
      <select class="admin-select" id="audit-source">
        <option value="">All Sources</option>
        <option value="genuine"${sel(_sourceFilter, 'genuine')}>Genuine</option>
        <option value="compatible"${sel(_sourceFilter, 'compatible')}>Compatible</option>
        <option value="remanufactured"${sel(_sourceFilter, 'remanufactured')}>Remanufactured</option>
        <option value="ribbon"${sel(_sourceFilter, 'ribbon')}>Ribbon</option>
      </select>
      <select class="admin-select" id="audit-type">
        <option value="">All Types</option>
        <option value="ink_cartridge"${sel(_typeFilter, 'ink_cartridge')}>Ink Cartridge</option>
        <option value="toner_cartridge"${sel(_typeFilter, 'toner_cartridge')}>Toner</option>
        <option value="printer_ribbon"${sel(_typeFilter, 'printer_ribbon')}>Printer Ribbon</option>
        <option value="typewriter_ribbon"${sel(_typeFilter, 'typewriter_ribbon')}>Typewriter Ribbon</option>
        <option value="correction_tape"${sel(_typeFilter, 'correction_tape')}>Correction Tape</option>
        <option value="drum"${sel(_typeFilter, 'drum')}>Drum</option>
        <option value="maintenance_kit"${sel(_typeFilter, 'maintenance_kit')}>Maintenance Kit</option>
        <option value="paper"${sel(_typeFilter, 'paper')}>Paper</option>
      </select>
      <select class="admin-select" id="audit-stock">
        <option value="">All Stock</option>
        <option value="in_stock"${sel(_stockFilter, 'in_stock')}>In Stock</option>
        <option value="low_stock"${sel(_stockFilter, 'low_stock')}>Low Stock</option>
        <option value="out_of_stock"${sel(_stockFilter, 'out_of_stock')}>Out of Stock</option>
      </select>
      <span style="flex:1 1 auto"></span>
      <span class="admin-text-muted" id="audit-count" style="font-size:13px;white-space:nowrap"></span>
    </div>
  `;
}

function extractBrand(p) {
  const raw = p.brand_name || p.brand || '';
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return raw.name || raw.brand || raw.brand_name || '';
  return String(raw);
}

function renderCardBody(p) {
  const brand = extractBrand(p);
  const imgs = (p._images && p._images.length)
    ? p._images
    : (p.image_url ? [{ id: '_legacy', path: p.image_url, is_primary: true, _legacy: true }] : []);

  let imgsHtml = '';
  if (!imgs.length) {
    imgsHtml = `
      <div class="audit-card__img audit-card__img--empty">
        ${icon('products', 48, 48)}
        <span>No images</span>
      </div>`;
  } else {
    for (const img of imgs) {
      const { thumb, raw } = resolveImage(img);
      const alt = (img.alt_text || p.name || '');
      const isLegacy = !!img._legacy;
      const id = isLegacy ? '_legacy' : (img.id || '');
      imgsHtml += `
        <div class="audit-card__img${img.is_primary ? ' audit-card__img--primary' : ''}" data-image-id="${esc(String(id))}">
          <img src="${esc(thumb)}" alt="${esc(alt)}" data-big="${esc(raw)}" data-alt="${esc(alt)}" loading="lazy">
          <div class="audit-card__img-overlay">
            ${img.is_primary ? '<span class="audit-card__badge">PRIMARY</span>' : ''}
            ${isLegacy ? '<span class="audit-card__badge audit-card__badge--legacy">LEGACY</span>' : ''}
          </div>
          <button class="audit-card__delete" data-action="delete-image" title="Delete this image" aria-label="Delete image">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>`;
    }
  }

  const sourceClass = ['genuine', 'compatible', 'remanufactured', 'ribbon'].includes(p.source) ? p.source : 'compatible';
  const reviewed = !!p.is_reviewed;

  return `
    <div class="audit-card__images">${imgsHtml}</div>
    <div class="audit-card__meta">
      <div class="audit-card__meta-top">
        <div class="audit-card__name" title="${esc(p.name || '')}">${esc(p.name || '—')}</div>
        <div class="audit-card__sku">${esc(p.sku || '')}</div>
        <div class="audit-card__row">
          ${brand ? `<span class="admin-badge admin-badge--processing">${esc(brand)}</span>` : ''}
          ${p.source ? `<span class="source-badge source-badge--${esc(sourceClass)}">${esc(p.source)}</span>` : ''}
          <span class="audit-card__count">${imgs.length} image${imgs.length === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div class="audit-card__actions">
        <label class="review-check${reviewed ? ' review-check--on' : ''}" title="Mark as reviewed">
          <input type="checkbox" class="review-check__input" data-action="toggle-reviewed" ${reviewed ? 'checked' : ''}>
          <span class="review-check__box" aria-hidden="true"></span>
          <span style="font-size:12px;color:var(--text-secondary)">Reviewed</span>
        </label>
        <a class="admin-btn admin-btn--ghost admin-btn--sm" href="#products?search=${encodeURIComponent(p.sku || p.name || '')}" target="_blank" rel="noopener">Open in Products</a>
      </div>
    </div>
  `;
}

function renderGrid() {
  const grid = document.getElementById('audit-grid');
  if (!grid) return;
  if (!_products.length) {
    grid.innerHTML = `
      <div class="admin-empty" style="padding:60px 20px">
        <div class="admin-empty__title">No products found</div>
        <div class="admin-empty__text">Try adjusting your filters.</div>
      </div>`;
    return;
  }
  let html = '';
  for (const p of _products) {
    html += `<article class="audit-card" data-product-id="${esc(p.id)}">${renderCardBody(p)}</article>`;
  }
  grid.innerHTML = html;
}

function renderCount() {
  const el = document.getElementById('audit-count');
  if (!el) return;
  const total = _pagination?.total ?? 0;
  el.textContent = total ? `${total.toLocaleString('en-NZ')} product${total === 1 ? '' : 's'}` : '';
}

function renderPagination() {
  const wrap = document.getElementById('audit-pagination');
  if (!wrap) return;
  const total = _pagination?.total || 0;
  const limit = _pagination?.limit || PAGE_SIZE;
  const page = _pagination?.page || _page;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="prev5"${page <= 1 ? ' disabled' : ''} title="Jump back 5 pages">«&nbsp;-5</button>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="prev"${page <= 1 ? ' disabled' : ''}>← Prev</button>
    <span style="font-size:13px;color:var(--text-secondary)">Page ${page} of ${totalPages}</span>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="next"${page >= totalPages ? ' disabled' : ''}>Next →</button>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="next5"${page >= totalPages ? ' disabled' : ''} title="Jump forward 5 pages">+5&nbsp;»</button>
  `;
}

async function load() {
  const grid = document.getElementById('audit-grid');
  if (!grid) return;
  const token = ++_loadToken;
  grid.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:80px"><div class="admin-loading__spinner"></div></div>`;

  const filters = { is_reviewed: 'false' };
  if (_search) filters.search = _search;
  if (_brandFilter) filters.brand = _brandFilter;
  if (_activeFilter !== '') filters.active = _activeFilter;
  if (_imageFilter === 'has-images') filters.has_images = 'true';
  else if (_imageFilter === 'no-images') filters.has_images = 'false';
  if (_sourceFilter) filters.source = _sourceFilter;
  if (_typeFilter) filters.product_type = _typeFilter;
  if (_stockFilter) filters.stock_status = _stockFilter;

  const data = await AdminAPI.getProducts(filters, _page, PAGE_SIZE);
  if (!_container || token !== _loadToken) return;

  const rows = Array.isArray(data) ? data : (data?.products || data?.data || []);
  const pagination = data?.pagination || { total: data?.total ?? rows.length, page: _page, limit: PAGE_SIZE };

  // Fetch images for these products in one batch
  const ids = rows.map(p => p.id).filter(Boolean);
  const imageMap = await fetchProductImages(ids);
  if (!_container || token !== _loadToken) return;

  for (const p of rows) p._images = imageMap[p.id] || [];

  _products = rows;
  _pagination = pagination;
  renderGrid();
  renderPagination();
  renderCount();
}

async function deleteImage(productId, imageId, isLegacy, cardEl) {
  const wrap = cardEl?.querySelector(`[data-image-id="${CSS.escape(imageId || '_legacy')}"]`);
  if (!wrap) return;
  // Optimistic: fade out
  wrap.style.transition = 'opacity .15s, transform .15s';
  wrap.style.opacity = '0.4';
  wrap.style.pointerEvents = 'none';
  try {
    if (isLegacy) {
      await AdminAPI.deleteProductImageUrl(productId);
    } else {
      await AdminAPI.deleteProductImage(productId, imageId);
    }
    wrap.style.transform = 'scale(0.92)';
    wrap.style.opacity = '0';
    setTimeout(() => {
      wrap.remove();
      // Update product entry + count badge
      const product = _products.find(p => String(p.id) === String(productId));
      if (product) {
        if (isLegacy) {
          product.image_url = null;
        } else {
          product._images = (product._images || []).filter(i => String(i.id) !== String(imageId));
        }
        const remaining = (product._images?.length || 0) + (product.image_url ? 1 : 0);
        const countEl = cardEl.querySelector('.audit-card__count');
        if (countEl) countEl.textContent = `${remaining} image${remaining === 1 ? '' : 's'}`;
        // If card is now empty, show placeholder
        if (remaining === 0) {
          const imagesWrap = cardEl.querySelector('.audit-card__images');
          if (imagesWrap) {
            imagesWrap.innerHTML = `
              <div class="audit-card__img audit-card__img--empty">
                ${icon('products', 48, 48)}
                <span>No images</span>
              </div>`;
          }
        }
      }
    }, 160);
    Toast.success('Image deleted');
  } catch (err) {
    wrap.style.opacity = '1';
    wrap.style.pointerEvents = '';
    Toast.error(`Delete failed: ${err.message}`);
  }
}

async function toggleReviewed(productId, cb) {
  const card = cb.closest('.audit-card');
  if (!card) return;
  const optimistic = cb.checked;
  cb.disabled = true;

  // Reviewed → remove card from list, auto-advance once list is empty.
  // Unreviewed (toggling off) shouldn't normally happen here since the page
  // filters to unreviewed-only, but handle it as a no-op visual revert.
  if (!optimistic) {
    cb.disabled = false;
    return;
  }

  // Optimistic fade-out
  card.style.transition = 'opacity .2s, transform .2s, max-height .25s, margin .25s, padding .25s';
  card.style.opacity = '0.4';
  card.style.pointerEvents = 'none';

  let result;
  try {
    result = await AdminAPI.toggleProductReviewed(productId);
  } catch (err) {
    card.style.opacity = '1';
    card.style.pointerEvents = '';
    cb.checked = false;
    cb.disabled = false;
    Toast.error(`Could not save: ${err.message}`);
    return;
  }

  const reviewed = !!result?.is_reviewed;
  if (!reviewed) {
    // Backend disagreed — revert
    card.style.opacity = '1';
    card.style.pointerEvents = '';
    cb.checked = false;
    cb.disabled = false;
    return;
  }

  // Animate out
  const h = card.offsetHeight;
  card.style.maxHeight = h + 'px';
  card.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    card.style.transform = 'scale(0.97)';
    card.style.maxHeight = '0px';
    card.style.marginTop = '0px';
    card.style.marginBottom = '0px';
    card.style.paddingTop = '0px';
    card.style.paddingBottom = '0px';
    card.style.borderWidth = '0px';
    card.style.opacity = '0';
  });

  setTimeout(() => {
    card.remove();
    // Drop from local state
    _products = _products.filter(p => String(p.id) !== String(productId));
    // Decrement total count optimistically so the badge stays accurate
    if (_pagination && typeof _pagination.total === 'number') {
      _pagination.total = Math.max(0, _pagination.total - 1);
      renderCount();
      renderPagination();
    }
    // If the visible list is exhausted, fetch the next batch from page 1
    // (the unreviewed filter naturally rolls in the next 60 items).
    if (!_products.length) {
      _page = 1;
      load();
    }
  }, 260);

  // Toast with undo
  const toastEl = Toast.success('Marked reviewed', 5000);
  if (toastEl) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'admin-toast__undo';
    undoBtn.textContent = 'Undo';
    toastEl.querySelector('.admin-toast__message')?.after(undoBtn);
    let undone = false;
    undoBtn.addEventListener('click', async () => {
      if (undone) return;
      undone = true;
      try {
        await AdminAPI.toggleProductReviewed(productId);
        Toast.info('Undone');
      } catch (e) {
        Toast.error(`Undo failed: ${e.message}`);
      }
      toastEl.remove();
      load();
    });
  }
}

function bindGridEvents() {
  const grid = document.getElementById('audit-grid');
  if (!grid) return;

  // Click image → lightbox (but not delete button)
  grid.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('[data-action="delete-image"]');
    if (deleteBtn) {
      e.stopPropagation();
      const card = deleteBtn.closest('.audit-card');
      const imgWrap = deleteBtn.closest('[data-image-id]');
      if (!card || !imgWrap) return;
      const productId = card.dataset.productId;
      const imageId = imgWrap.dataset.imageId;
      const isLegacy = imageId === '_legacy';
      deleteImage(productId, isLegacy ? null : imageId, isLegacy, card);
      return;
    }
    const img = e.target.closest('.audit-card__img img[data-big]');
    if (img) {
      e.stopPropagation();
      openImageLightbox(img.dataset.big || img.src, img.dataset.alt || '');
    }
  });

  // Reviewed toggle
  grid.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-action="toggle-reviewed"]');
    if (!cb) return;
    e.stopPropagation();
    const card = cb.closest('.audit-card');
    if (!card) return;
    toggleReviewed(card.dataset.productId, cb);
  });
}

function bindToolbarEvents() {
  const c = _container;
  if (!c) return;

  let searchTimer;
  c.querySelector('#audit-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { _search = v; _page = 1; load(); }, 300);
  });
  c.querySelector('#audit-brand')?.addEventListener('change', (e) => { _brandFilter = e.target.value; _page = 1; load(); });
  c.querySelector('#audit-active')?.addEventListener('change', (e) => { _activeFilter = e.target.value; _page = 1; load(); });
  c.querySelector('#audit-images')?.addEventListener('change', (e) => { _imageFilter = e.target.value; _page = 1; load(); });
  c.querySelector('#audit-source')?.addEventListener('change', (e) => { _sourceFilter = e.target.value; _page = 1; load(); });
  c.querySelector('#audit-type')?.addEventListener('change', (e) => { _typeFilter = e.target.value; _page = 1; load(); });
  c.querySelector('#audit-stock')?.addEventListener('change', (e) => { _stockFilter = e.target.value; _page = 1; load(); });

  c.querySelector('#audit-pagination')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const total = _pagination?.total || 0;
    const limit = _pagination?.limit || PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    if (btn.dataset.action === 'prev') _page = Math.max(1, _page - 1);
    if (btn.dataset.action === 'next') _page = Math.min(totalPages, _page + 1);
    if (btn.dataset.action === 'prev5') _page = Math.max(1, _page - 5);
    if (btn.dataset.action === 'next5') _page = Math.min(totalPages, _page + 5);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    load();
  });
}

async function render() {
  if (!_brands.length) {
    const brandsData = await AdminAPI.getBrands();
    if (!_container) return;
    _brands = (brandsData && Array.isArray(brandsData)) ? brandsData : [];
  }

  _container.innerHTML = `
    <div class="admin-page-header admin-page-header--with-toolbar">
      ${buildToolbar()}
    </div>
    <div class="audit-banner">
      <strong>Image Audit</strong> &middot; review duplicate or wrong product images. Click any image to enlarge, click <strong>×</strong> to delete it.
    </div>
    <div id="audit-grid" class="audit-grid"></div>
    <div id="audit-pagination" class="audit-pagination"></div>
  `;

  bindToolbarEvents();
  bindGridEvents();
  await load();
}

export default {
  title: 'Image Audit',

  async init(container) {
    FilterState.showBar(false);
    _container = container;
    _page = 1;
    _search = '';
    _brandFilter = '';
    _activeFilter = '';
    _imageFilter = '';
    _sourceFilter = '';
    _typeFilter = '';
    _stockFilter = '';
    _products = [];
    await render();
  },

  destroy() {
    _loadToken++;
    _container = null;
    _products = [];
    _brands = [];
  },

  onSearch(query) {
    _search = query;
    _page = 1;
    const input = document.getElementById('audit-search');
    if (input && input.value !== query) input.value = query;
    load();
  },
};
