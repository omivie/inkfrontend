/**
 * Pending Changes Page — Review queue for product imports
 * Surfaces feed-driven proposals (ADD / UPDATE / DEACTIVATE) so an admin can
 * approve or reject them at the per-field level or in bulk.
 *
 * Backend endpoints (all admin-only, 30/min/user):
 *   GET  /api/admin/pending-changes/summary
 *   GET  /api/admin/pending-changes
 *   POST /api/admin/pending-changes/:id/review
 *   POST /api/admin/pending-changes/bulk-review
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

// We page client-side to allow product-attribute filters to apply across
// the full result set. The backend caps `limit` per request (~100), so we
// fetch in chunks up to FETCH_TARGET total items.
const BACKEND_CHUNK = 100;
const FETCH_TARGET = 500;
const PAGE_SIZE = 50;
const MISSING = '—';
const CLEARED_KEY = 'admin_pending_changes_cleared_ids';

// ---- Module state ----
let _container = null;
let _summary = null;
// `_rawItems` is the unfiltered set fetched from the backend; `_items` is what
// we render (after client-side product filters and the cleared-id hide list).
let _rawItems = [];
let _items = [];
let _pagination = { total: 0, page: 1, limit: PAGE_SIZE };
let _selected = new Set();
let _expanded = new Set();
let _filters = { status: 'pending', change_type: '', field: '', search: '' };
// Product-level filters (mirror the Image Audit / Products page set).
let _productFilters = { brand: '', active: '', images: '', source: '', product_type: '', stock: '' };
let _brands = [];
let _page = 1;
let _loadToken = 0;
// Product info cache (id -> { name, image_url, is_active, source, product_type, brand_id })
// — pending_product_changes.old_data/new_data only stores the changed fields,
// so name/current image and the attributes we filter on must come from products.
const _productCache = new Map();
// Set of pending_product_changes.id that the user has "cleared" from the
// Denied view. Persists locally so the choice survives reloads — the backend
// has no clear/delete endpoint at the moment.
let _clearedIds = new Set();

function loadClearedIds() {
  try {
    const raw = localStorage.getItem(CLEARED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function persistClearedIds() {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify([..._clearedIds])); } catch {}
}

/** Resolve a storage path or URL to a thumbnail-sized <img src>. */
function resolveImageSrc(value) {
  if (!value || typeof value !== 'string') return null;
  if (typeof window.storageUrl === 'function') return window.storageUrl(value);
  if (/^https?:\/\//.test(value) || value.startsWith('/')) return value;
  return null;
}

/** Resolve a storage path or URL to the raw original (used for the lightbox). */
function resolveRawImageSrc(value) {
  if (!value || typeof value !== 'string') return null;
  if (/^https?:\/\//.test(value) || value.startsWith('/')) return value;
  if (typeof window.storageUrlRaw === 'function') return window.storageUrlRaw(value);
  return resolveImageSrc(value);
}

/** Full-screen image preview — same UX as the Image Audit page. */
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

// ---- Helpers ----
function fmtDate(iso) {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  return d.toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(iso) {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(1, Math.floor(diff / 60000));
  return `${mins}m ago`;
}

function fmtFieldValue(field, value) {
  if (value == null || value === '') return `<span class="pc-empty">${MISSING}</span>`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return esc(value.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(', '));
  if (typeof value === 'object') return `<code style="font-size:11px">${esc(JSON.stringify(value))}</code>`;
  if (/_(price|cost)$|^price$|^cost$/.test(field) && !Number.isNaN(Number(value))) {
    return `$${Number(value).toFixed(2)}`;
  }
  if (field === 'image_url' && typeof value === 'string') {
    const src = resolveImageSrc(value);
    if (src) {
      const raw = resolveRawImageSrc(value) || src;
      return `<button type="button" class="pc-row__field-thumb" data-zoom="${esc(raw)}" data-zoom-alt="${esc(value)}" title="${esc(value)} — click to enlarge"><img src="${esc(src)}" alt="" loading="lazy"></button>`;
    }
  }
  return esc(String(value));
}

function changeTypeBadge(type) {
  const cls = {
    ADD: 'pc-badge pc-badge--add',
    UPDATE: 'pc-badge pc-badge--update',
    DEACTIVATE: 'pc-badge pc-badge--deactivate',
  }[type] || 'pc-badge';
  return `<span class="${cls}">${esc(type || '?')}</span>`;
}

function statusBadge(status) {
  const cls = {
    pending: 'pc-status pc-status--pending',
    partial: 'pc-status pc-status--partial',
    approved: 'pc-status pc-status--approved',
    rejected: 'pc-status pc-status--rejected',
    superseded: 'pc-status pc-status--superseded',
  }[status] || 'pc-status';
  return `<span class="${cls}">${esc(status || '?')}</span>`;
}

function decisionPill(decision) {
  if (decision === 'approved') return '<span class="pc-pill pc-pill--approved">approved</span>';
  if (decision === 'rejected') return '<span class="pc-pill pc-pill--rejected">rejected</span>';
  return '<span class="pc-pill pc-pill--pending">pending</span>';
}

function getChangedFields(item) {
  if (Array.isArray(item.changed_fields) && item.changed_fields.length) return item.changed_fields;
  // Fall back to keys present in new_data when changed_fields isn't provided
  const keys = new Set([
    ...Object.keys(item.new_data || {}),
    ...Object.keys(item.old_data || {}),
  ]);
  return [...keys];
}

// ---- Inject scoped styles ----
function ensureStyles() {
  if (document.getElementById('pc-styles')) return;
  const style = document.createElement('style');
  style.id = 'pc-styles';
  style.textContent = `
    .pc-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    @media (max-width: 1100px) { .pc-summary { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 600px) { .pc-summary { grid-template-columns: 1fr; } }
    .pc-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
    .pc-card__label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 600; }
    .pc-card__value { font-size: 24px; font-weight: 700; color: var(--text); margin-top: 4px; }
    .pc-card__sub { font-size: 12px; color: var(--text-muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
    .pc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; background: var(--surface-hover); color: var(--text-secondary); font-size: 11px; cursor: pointer; border: 1px solid transparent; }
    .pc-chip:hover { background: var(--cyan-dim); color: var(--cyan-text); }
    .pc-chip--active { background: var(--cyan); color: #fff; }
    .pc-chip__count { font-weight: 700; }

    .pc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
    .pc-toolbar .admin-search input { width: 240px; }
    .pc-toolbar .admin-select { width: auto; min-width: 140px; }

    .pc-tabs { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
    .pc-tab { background: none; border: none; padding: 10px 18px; font-size: 14px; font-weight: 600; color: var(--text-muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 8px; }
    .pc-tab:hover { color: var(--text); }
    .pc-tab--active { color: var(--text); border-bottom-color: var(--cyan); }
    .pc-tab__count { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px; background: var(--surface-hover); color: var(--text-secondary); font-size: 11px; font-weight: 700; min-width: 18px; justify-content: center; }
    .pc-tab--active .pc-tab__count { background: var(--cyan-dim); color: var(--cyan-text); }

    .pc-row__actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
    .pc-row__action { padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
    .pc-row__action--approve { background: var(--success-dim); color: var(--success); border-color: transparent; }
    .pc-row__action--approve:hover { background: var(--success); color: #fff; }
    .pc-row__action--deny { background: var(--danger-dim); color: #f87171; }
    .pc-row__action--deny:hover { background: #ef4444; color: #fff; }
    .pc-row__action--clear { background: var(--surface-hover); color: var(--text-secondary); border-color: var(--border); }
    .pc-row__action--clear:hover { background: var(--text-muted); color: #fff; }
    .pc-row__action[disabled] { opacity: 0.5; cursor: not-allowed; }

    .pc-bulk-bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; flex-wrap: wrap; }
    .pc-bulk-bar__count { font-size: 13px; color: var(--text-secondary); }
    .pc-bulk-bar__count strong { color: var(--text); }

    .pc-table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .pc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .pc-table th { text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); background: var(--surface-hover); border-bottom: 1px solid var(--border); white-space: nowrap; }
    .pc-table td { padding: 10px 12px; border-bottom: 1px solid var(--border-light, var(--border)); vertical-align: middle; }
    .pc-table tbody tr.pc-row:hover { background: var(--surface-hover); }
    .pc-table tbody tr.pc-row--superseded { opacity: 0.55; }
    .pc-table tbody tr.pc-detail td { padding: 0; background: var(--bg, var(--surface)); }
    .pc-row__primary { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .pc-row__thumb-btn { display: inline-flex; padding: 0; border: none; background: none; cursor: zoom-in; flex-shrink: 0; }
    .pc-row__thumb { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; background: var(--surface-hover); border: 1px solid var(--border); flex-shrink: 0; }
    .pc-row__thumb--empty { display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); }
    .pc-row__text { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .pc-row__name { color: var(--text); font-weight: 500; font-size: 14px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; }
    .pc-row__sku { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-muted); font-weight: 400; line-height: 1.2; }
    .pc-row__fields { display: flex; flex-wrap: wrap; gap: 6px; max-width: 360px; align-items: center; }
    .pc-row__fields:has(.pc-row__field-thumb) { max-width: none; }
    .pc-row__field-chip { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--cyan-dim); color: var(--cyan-text); font-family: var(--font-mono, monospace); }
    .pc-row__field-thumb { display: inline-block; width: 320px; height: 320px; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); background: var(--surface-hover); padding: 0; cursor: zoom-in; }
    button.pc-row__field-thumb { font: inherit; color: inherit; }
    .pc-row__field-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .pc-row__expand { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; border-radius: 4px; transition: transform 0.15s; }
    .pc-row__expand:hover { background: var(--surface-hover); color: var(--text); }
    .pc-row__expand[aria-expanded="true"] { transform: rotate(90deg); }

    .pc-detail__inner { padding: 16px 20px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface-hover); }
    .pc-detail__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px; flex-wrap: wrap; }
    .pc-detail__meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 14px; flex-wrap: wrap; }
    .pc-detail__meta strong { color: var(--text-secondary); font-weight: 600; }
    .pc-fields { display: flex; flex-direction: column; gap: 8px; }
    .pc-field { display: grid; grid-template-columns: 160px 1fr 1fr auto; gap: 12px; align-items: center; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
    @media (max-width: 800px) { .pc-field { grid-template-columns: 1fr; gap: 6px; } }
    .pc-field__name { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
    .pc-field__values { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
    .pc-field__old { color: var(--text-muted); text-decoration: line-through; word-break: break-word; }
    .pc-field__new { color: var(--text); font-weight: 500; word-break: break-word; }
    .pc-field__arrow { color: var(--text-muted); }
    .pc-field__actions { display: flex; gap: 6px; }
    .pc-empty { color: var(--text-muted); font-style: italic; }
    .pc-link { color: var(--cyan-text); text-decoration: none; }
    .pc-link:hover { text-decoration: underline; }

    .pc-pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .pc-pill--pending { background: var(--yellow-dim); color: var(--yellow-text); }
    .pc-pill--approved { background: var(--success-dim); color: var(--success); }
    .pc-pill--rejected { background: var(--danger-dim); color: #f87171; }

    .pc-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
    .pc-badge--add { background: var(--success-dim); color: var(--success); }
    .pc-badge--update { background: var(--cyan-dim); color: var(--cyan-text); }
    .pc-badge--deactivate { background: var(--danger-dim); color: #f87171; }

    .pc-status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .pc-status--pending { background: var(--yellow-dim); color: var(--yellow-text); }
    .pc-status--partial { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
    .pc-status--approved { background: var(--success-dim); color: var(--success); }
    .pc-status--rejected { background: var(--danger-dim); color: #f87171; }
    .pc-status--superseded { background: var(--surface-hover); color: var(--text-muted); }

    .pc-pagination { display: flex; align-items: center; gap: 8px; padding: 12px; justify-content: center; }
    .pc-empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); }
    .pc-empty-state__title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 6px; }

    .pc-checkbox { width: 16px; height: 16px; cursor: pointer; }
    .pc-detail__close { background: none; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 10px; border-radius: var(--radius); cursor: pointer; font-size: 12px; }
    .pc-detail__close:hover { background: var(--surface); color: var(--text); }
  `;
  document.head.appendChild(style);
}

// ---- Renderers ----
function renderSummary() {
  const wrap = document.getElementById('pc-summary');
  if (!wrap) return;
  const s = _summary || { pending_total: 0, by_type: {}, by_field: {}, oldest_pending: null, import_runs_with_pending: 0 };

  const typeChips = ['ADD', 'UPDATE', 'DEACTIVATE'].map(t => {
    const count = s.by_type?.[t] || 0;
    if (!count) return '';
    const active = _filters.change_type === t ? ' pc-chip--active' : '';
    return `<button class="pc-chip${active}" data-type-filter="${esc(t)}">${esc(t)} <span class="pc-chip__count">${count}</span></button>`;
  }).join('');

  const fieldEntries = Object.entries(s.by_field || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const fieldChips = fieldEntries.map(([f, count]) => {
    const active = _filters.field === f ? ' pc-chip--active' : '';
    return `<button class="pc-chip${active}" data-field-filter="${esc(f)}">${esc(f)} <span class="pc-chip__count">${count}</span></button>`;
  }).join('');

  wrap.innerHTML = `
    <div class="pc-card">
      <div class="pc-card__label">Pending Total</div>
      <div class="pc-card__value">${(s.pending_total || 0).toLocaleString('en-NZ')}</div>
      <div class="pc-card__sub">Across all change types</div>
    </div>
    <div class="pc-card">
      <div class="pc-card__label">By Change Type</div>
      <div class="pc-card__value" style="font-size:14px;font-weight:500;color:var(--text-muted);margin-top:8px">Click to filter</div>
      <div class="pc-card__sub" style="margin-top:8px">${typeChips || '<span class="pc-empty">None pending</span>'}</div>
    </div>
    <div class="pc-card">
      <div class="pc-card__label">Top Fields</div>
      <div class="pc-card__value" style="font-size:14px;font-weight:500;color:var(--text-muted);margin-top:8px">Click to filter</div>
      <div class="pc-card__sub" style="margin-top:8px">${fieldChips || '<span class="pc-empty">None pending</span>'}</div>
    </div>
    <div class="pc-card">
      <div class="pc-card__label">Oldest Pending</div>
      <div class="pc-card__value" style="font-size:18px">${s.oldest_pending ? fmtRelative(s.oldest_pending) : MISSING}</div>
      <div class="pc-card__sub">${s.import_runs_with_pending || 0} import run${s.import_runs_with_pending === 1 ? '' : 's'} with pending</div>
    </div>
  `;

  // Bind chip filters
  wrap.querySelectorAll('[data-type-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.typeFilter;
      _filters.change_type = _filters.change_type === v ? '' : v;
      _page = 1;
      syncFilterControls();
      load();
    });
  });
  wrap.querySelectorAll('[data-field-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.fieldFilter;
      _filters.field = _filters.field === v ? '' : v;
      _page = 1;
      syncFilterControls();
      load();
    });
  });
}

function syncFilterControls() {
  const c = _container;
  if (!c) return;
  const search = c.querySelector('#pc-search');
  const field = c.querySelector('#pc-field');
  if (search && search.value !== _filters.search) search.value = _filters.search;
  if (field) field.value = _filters.field;
}

function buildFieldOptions() {
  const fields = new Set(Object.keys(_summary?.by_field || {}));
  // Common fields that may not appear in summary but are useful
  ['name', 'retail_price', 'cost_price', 'image_url', 'description', 'is_active'].forEach(f => fields.add(f));
  if (_filters.field) fields.add(_filters.field);
  const sorted = [...fields].sort();
  return ['<option value="">All fields</option>']
    .concat(sorted.map(f => `<option value="${esc(f)}"${_filters.field === f ? ' selected' : ''}>${esc(f)}</option>`))
    .join('');
}

function renderTabs() {
  const wrap = document.getElementById('pc-tabs');
  if (!wrap) return;
  const pendingActive = _filters.status === 'pending' ? ' pc-tab--active' : '';
  const deniedActive = _filters.status === 'rejected' ? ' pc-tab--active' : '';
  const pendingCount = _summary?.by_status?.pending ?? _summary?.pending_total ?? null;
  const deniedCount = _summary?.by_status?.rejected ?? null;
  const fmtCount = (c) => c == null ? '' : `<span class="pc-tab__count">${Number(c).toLocaleString('en-NZ')}</span>`;
  wrap.innerHTML = `
    <button class="pc-tab${pendingActive}" data-pc-tab="pending">Pending ${fmtCount(pendingCount)}</button>
    <button class="pc-tab${deniedActive}" data-pc-tab="rejected">Denied ${fmtCount(deniedCount)}</button>
  `;
  wrap.querySelectorAll('[data-pc-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.pcTab;
      if (_filters.status === next) return;
      _filters.status = next;
      _page = 1;
      _selected.clear();
      _expanded.clear();
      renderTabs();
      load();
    });
  });
}

function buildBrandOptions() {
  let html = '<option value="">All Brands</option>';
  for (const b of _brands) {
    const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
    const val = (typeof b === 'object' && b.id) ? b.id : name;
    const sel = String(val) === String(_productFilters.brand) ? ' selected' : '';
    html += `<option value="${esc(val)}"${sel}>${esc(name)}</option>`;
  }
  return html;
}

function renderToolbar() {
  const wrap = document.getElementById('pc-toolbar');
  if (!wrap) return;
  const sel = (cur, val) => cur === val ? ' selected' : '';
  const pf = _productFilters;
  wrap.innerHTML = `
    <div class="admin-search">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" id="pc-search" placeholder="Search SKU or name…" value="${esc(_filters.search)}">
    </div>
    <select class="admin-select" id="pc-brand">${buildBrandOptions()}</select>
    <select class="admin-select" id="pc-active">
      <option value="">All Status</option>
      <option value="true"${sel(pf.active, 'true')}>Active</option>
      <option value="false"${sel(pf.active, 'false')}>Inactive</option>
    </select>
    <select class="admin-select" id="pc-images">
      <option value="">All Images</option>
      <option value="has-images"${sel(pf.images, 'has-images')}>Has Images</option>
      <option value="no-images"${sel(pf.images, 'no-images')}>No Images</option>
    </select>
    <select class="admin-select" id="pc-source">
      <option value="">All Sources</option>
      <option value="genuine"${sel(pf.source, 'genuine')}>Genuine</option>
      <option value="compatible"${sel(pf.source, 'compatible')}>Compatible</option>
      <option value="remanufactured"${sel(pf.source, 'remanufactured')}>Remanufactured</option>
      <option value="ribbon"${sel(pf.source, 'ribbon')}>Ribbon</option>
    </select>
    <select class="admin-select" id="pc-product-type">
      <option value="">All Types</option>
      <option value="ink_cartridge"${sel(pf.product_type, 'ink_cartridge')}>Ink Cartridge</option>
      <option value="toner_cartridge"${sel(pf.product_type, 'toner_cartridge')}>Toner</option>
      <option value="printer_ribbon"${sel(pf.product_type, 'printer_ribbon')}>Printer Ribbon</option>
      <option value="typewriter_ribbon"${sel(pf.product_type, 'typewriter_ribbon')}>Typewriter Ribbon</option>
      <option value="correction_tape"${sel(pf.product_type, 'correction_tape')}>Correction Tape</option>
      <option value="drum"${sel(pf.product_type, 'drum')}>Drum</option>
      <option value="maintenance_kit"${sel(pf.product_type, 'maintenance_kit')}>Maintenance Kit</option>
      <option value="paper"${sel(pf.product_type, 'paper')}>Paper</option>
    </select>
    <select class="admin-select" id="pc-stock">
      <option value="">All Stock</option>
      <option value="in_stock"${sel(pf.stock, 'in_stock')}>In Stock</option>
      <option value="low_stock"${sel(pf.stock, 'low_stock')}>Low Stock</option>
      <option value="out_of_stock"${sel(pf.stock, 'out_of_stock')}>Out of Stock</option>
    </select>
    <select class="admin-select" id="pc-field">${buildFieldOptions()}</select>
    <span style="flex:1"></span>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" id="pc-refresh">Refresh</button>
  `;

  let searchTimer;
  wrap.querySelector('#pc-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { _filters.search = v; _page = 1; load(); }, 300);
  });
  wrap.querySelector('#pc-field').addEventListener('change', (e) => { _filters.field = e.target.value; _page = 1; renderSummary(); load(); });
  wrap.querySelector('#pc-brand').addEventListener('change', (e) => { _productFilters.brand = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-active').addEventListener('change', (e) => { _productFilters.active = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-images').addEventListener('change', (e) => { _productFilters.images = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-source').addEventListener('change', (e) => { _productFilters.source = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-product-type').addEventListener('change', (e) => { _productFilters.product_type = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-stock').addEventListener('change', (e) => { _productFilters.stock = e.target.value; _page = 1; applyClientFilters(); });
  wrap.querySelector('#pc-refresh').addEventListener('click', refreshAll);
}

function renderBulkBar() {
  const wrap = document.getElementById('pc-bulk');
  if (!wrap) return;
  const count = _selected.size;
  const visibleReviewable = _items.filter(i => i.status === 'pending' || i.status === 'partial').length;
  const allChecked = visibleReviewable > 0 && _items.every(i => (i.status !== 'pending' && i.status !== 'partial') || _selected.has(i.id));
  wrap.innerHTML = `
    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
      <input type="checkbox" class="pc-checkbox" id="pc-select-all" ${allChecked ? 'checked' : ''} ${visibleReviewable === 0 ? 'disabled' : ''}>
      Select all on page
    </label>
    <span class="pc-bulk-bar__count"><strong>${count}</strong> selected</span>
    <span style="flex:1"></span>
    <button class="admin-btn admin-btn--primary admin-btn--sm" id="pc-bulk-approve" ${count === 0 ? 'disabled' : ''}>Approve Selected</button>
    <button class="admin-btn admin-btn--danger admin-btn--sm" id="pc-bulk-reject" ${count === 0 ? 'disabled' : ''}>Reject Selected</button>
  `;

  wrap.querySelector('#pc-select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
      _items.forEach(i => { if (i.status === 'pending' || i.status === 'partial') _selected.add(i.id); });
    } else {
      _items.forEach(i => _selected.delete(i.id));
    }
    renderTable();
    renderBulkBar();
  });
  wrap.querySelector('#pc-bulk-approve').addEventListener('click', () => bulkAction('approve'));
  wrap.querySelector('#pc-bulk-reject').addEventListener('click', () => bulkAction('reject'));
}

function renderRow(item) {
  const fields = getChangedFields(item);
  const cached = item.product_id ? _productCache.get(item.product_id) : null;
  const newImageSrc = resolveImageSrc(item.new_data?.image_url);
  const newImageRaw = resolveRawImageSrc(item.new_data?.image_url);
  const oldImageSrc = resolveImageSrc(item.old_data?.image_url) || resolveImageSrc(cached?.image_url);
  const oldImageRaw = resolveRawImageSrc(item.old_data?.image_url) || resolveRawImageSrc(cached?.image_url);
  const fieldChips = fields.slice(0, 6).map(f => {
    if (f === 'image_url' && newImageSrc) {
      return `<button type="button" class="pc-row__field-thumb" data-zoom="${esc(newImageRaw || newImageSrc)}" data-zoom-alt="new image" title="Click to enlarge"><img src="${esc(newImageSrc)}" alt="new image" loading="lazy"></button>`;
    }
    return `<span class="pc-row__field-chip">${esc(f)}</span>`;
  }).join('');
  const more = fields.length > 6 ? `<span class="pc-row__field-chip" style="background:transparent;color:var(--text-muted)">+${fields.length - 6}</span>` : '';
  const reviewable = item.status === 'pending' || item.status === 'partial';
  const isExpanded = _expanded.has(item.id);
  const superseded = item.status === 'superseded' ? ' pc-row--superseded' : '';
  const sku = item.sku || item.new_data?.sku || item.old_data?.sku || MISSING;
  const name = item.new_data?.name || item.old_data?.name || cached?.name || item.product_name || '';
  const thumbSrc = oldImageSrc || newImageSrc;
  const thumbRaw = oldImageRaw || newImageRaw || thumbSrc;
  const thumb = thumbSrc
    ? `<button type="button" class="pc-row__thumb-btn" data-zoom="${esc(thumbRaw)}" data-zoom-alt="${esc(name || sku)}" title="Click to enlarge"><img class="pc-row__thumb" src="${esc(thumbSrc)}" alt="" loading="lazy"></button>`
    : `<div class="pc-row__thumb pc-row__thumb--empty">${icon('products', 18, 18)}</div>`;

  const actions = renderRowActions(item);

  return `
    <tr class="pc-row${superseded}" data-id="${esc(item.id)}">
      <td><input type="checkbox" class="pc-checkbox pc-row-check" data-id="${esc(item.id)}" ${_selected.has(item.id) ? 'checked' : ''} ${reviewable ? '' : 'disabled'}></td>
      <td>
        <div class="pc-row__primary">
          ${thumb}
          <div class="pc-row__text">
            <div class="pc-row__name">${esc(name ? (name.length > 60 ? name.slice(0, 57) + '…' : name) : MISSING)}</div>
            <div class="pc-row__sku">${esc(sku)}</div>
          </div>
        </div>
      </td>
      <td><div class="pc-row__fields">${fieldChips}${more}</div></td>
      <td>${actions}</td>
      <td style="text-align:right">
        <button class="pc-row__expand" aria-expanded="${isExpanded ? 'true' : 'false'}" data-toggle="${esc(item.id)}" title="${isExpanded ? 'Collapse' : 'Expand'}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </td>
    </tr>
    ${isExpanded ? renderDetailRow(item) : ''}
  `;
}

function renderRowActions(item) {
  const reviewable = item.status === 'pending' || item.status === 'partial';
  if (reviewable) {
    return `
      <div class="pc-row__actions">
        <button class="pc-row__action pc-row__action--approve" data-row-action="approve" data-id="${esc(item.id)}" title="Approve all pending fields on this row">Approve</button>
        <button class="pc-row__action pc-row__action--deny" data-row-action="deny" data-id="${esc(item.id)}" title="Deny all pending fields on this row">Deny</button>
      </div>
    `;
  }
  if (item.status === 'rejected') {
    return `
      <div class="pc-row__actions">
        <button class="pc-row__action pc-row__action--clear" data-row-action="clear" data-id="${esc(item.id)}" title="Remove from the Denied list">Clear</button>
      </div>
    `;
  }
  return `<div class="pc-row__actions"><span class="admin-text-muted" style="font-size:12px">${esc(item.status)}</span></div>`;
}

function renderDetailRow(item) {
  const decisions = item.field_decisions || {};
  const fields = getChangedFields(item);
  const old = item.old_data || {};
  const next = item.new_data || {};

  const detectedAt = item.detected_at ? `<span><strong>Detected:</strong> ${fmtDate(item.detected_at)}</span>` : '';
  const createdAt = item.created_at ? `<span><strong>Created:</strong> ${fmtDate(item.created_at)}</span>` : '';
  const importRun = item.import_run_id ? `<span><strong>Import run:</strong> <code>${esc(String(item.import_run_id).slice(0, 8))}</code></span>` : '';
  const productId = item.product_id ? `<span><strong>Product:</strong> <code>${esc(String(item.product_id).slice(0, 8))}</code></span>` : '';
  const reviewable = item.status === 'pending' || item.status === 'partial';

  const fieldRows = fields.map(f => {
    const decision = decisions[f] || 'pending';
    const reviewableField = reviewable && decision === 'pending';
    return `
      <div class="pc-field" data-field="${esc(f)}">
        <div class="pc-field__name">
          <code>${esc(f)}</code>
          ${decisionPill(decision)}
        </div>
        <div class="pc-field__values">
          <span class="pc-field__old">${fmtFieldValue(f, old[f])}</span>
        </div>
        <div class="pc-field__values">
          <span class="pc-field__arrow">→</span>
          <span class="pc-field__new">${fmtFieldValue(f, next[f])}</span>
        </div>
        <div class="pc-field__actions">
          ${reviewableField ? `
            <button class="admin-btn admin-btn--ghost admin-btn--xs" data-field-action="approved" data-id="${esc(item.id)}" data-field="${esc(f)}" title="Approve this field">Approve</button>
            <button class="admin-btn admin-btn--ghost admin-btn--xs" data-field-action="rejected" data-id="${esc(item.id)}" data-field="${esc(f)}" title="Reject this field">Reject</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  const noteHtml = reviewable ? `
    <div style="display:flex;gap:8px;margin-top:12px;align-items:flex-start">
      <input type="text" class="admin-input" id="pc-note-${esc(item.id)}" placeholder="Optional note (applied to all decisions on this row)" style="flex:1">
      <button class="admin-btn admin-btn--primary admin-btn--sm" data-row-action="approve-all" data-id="${esc(item.id)}">Approve All</button>
      <button class="admin-btn admin-btn--danger admin-btn--sm" data-row-action="reject-all" data-id="${esc(item.id)}">Reject All</button>
    </div>
  ` : '';

  return `
    <tr class="pc-detail" data-detail-id="${esc(item.id)}">
      <td colspan="5">
        <div class="pc-detail__inner">
          <div class="pc-detail__header">
            <div class="pc-detail__meta">
              ${detectedAt}
              ${createdAt}
              ${importRun}
              ${productId}
              ${item.review_note ? `<span><strong>Note:</strong> ${esc(item.review_note)}</span>` : ''}
            </div>
            <button class="pc-detail__close" data-toggle="${esc(item.id)}">Collapse</button>
          </div>
          <div class="pc-fields">${fieldRows || '<span class="pc-empty">No field changes</span>'}</div>
          ${noteHtml}
        </div>
      </td>
    </tr>
  `;
}

function renderTable() {
  const wrap = document.getElementById('pc-table');
  if (!wrap) return;

  if (!_items.length) {
    wrap.innerHTML = `
      <div class="pc-empty-state">
        <div class="pc-empty-state__title">No pending changes</div>
        <div>Try adjusting your filters or wait for the next import run.</div>
      </div>
    `;
    return;
  }

  wrap.innerHTML = `
    <div class="pc-table-wrap">
      <table class="pc-table">
        <thead>
          <tr>
            <th style="width:40px"></th>
            <th>Name / SKU</th>
            <th>Changed Fields</th>
            <th style="width:200px;text-align:right">Actions</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>
          ${_items.map(renderRow).join('')}
        </tbody>
      </table>
    </div>
  `;
  bindTableEvents();
}

function renderPagination() {
  const wrap = document.getElementById('pc-pagination');
  if (!wrap) return;
  const total = _pagination?.total || 0;
  const limit = _pagination?.limit || PAGE_SIZE;
  const page = _pagination?.page || _page;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="prev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span style="font-size:13px;color:var(--text-secondary)">Page ${page} of ${totalPages} · ${total.toLocaleString('en-NZ')} total</span>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
  `;
  wrap.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      if (btn.dataset.action === 'prev') _page = Math.max(1, _page - 1);
      if (btn.dataset.action === 'next') _page = Math.min(totalPages, _page + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      applyClientFilters();
    });
  });
}

// ---- Event binding ----
let _tableEventsBound = false;
function bindTableEvents() {
  // The #pc-table container persists across renders; only its innerHTML changes.
  // Attaching listeners to it inside renderTable() would stack a new pair of
  // listeners on every re-render, causing every click to fire 2×, 3×, … times.
  // Bind exactly once per page lifetime instead.
  if (_tableEventsBound) return;
  const wrap = document.getElementById('pc-table');
  if (!wrap) return;
  _tableEventsBound = true;

  wrap.addEventListener('click', (e) => {
    const zoomEl = e.target.closest('[data-zoom]');
    if (zoomEl) {
      e.stopPropagation();
      e.preventDefault();
      openImageLightbox(zoomEl.dataset.zoom, zoomEl.dataset.zoomAlt || '');
      return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle;
      if (_expanded.has(id)) _expanded.delete(id); else _expanded.add(id);
      renderTable();
      return;
    }
    const fieldBtn = e.target.closest('[data-field-action]');
    if (fieldBtn) {
      const id = fieldBtn.dataset.id;
      const field = fieldBtn.dataset.field;
      const decision = fieldBtn.dataset.fieldAction;
      const noteEl = document.getElementById(`pc-note-${id}`);
      const note = noteEl ? noteEl.value.trim() : '';
      reviewField(id, field, decision, note, fieldBtn);
      return;
    }
    const rowBtn = e.target.closest('[data-row-action]');
    if (rowBtn) {
      const id = rowBtn.dataset.id;
      const action = rowBtn.dataset.rowAction;
      const noteEl = document.getElementById(`pc-note-${id}`);
      const note = noteEl ? noteEl.value.trim() : '';
      if (action === 'clear') {
        clearItem(id, rowBtn);
        return;
      }
      // approve / deny / approve-all / reject-all all funnel through reviewWholeRow
      const decision = (action === 'approve' || action === 'approve-all') ? 'approved' : 'rejected';
      reviewWholeRow(id, decision, note, rowBtn);
      return;
    }
  });

  wrap.addEventListener('change', (e) => {
    const cb = e.target.closest('.pc-row-check');
    if (!cb) return;
    const id = cb.dataset.id;
    if (cb.checked) _selected.add(id); else _selected.delete(id);
    renderBulkBar();
  });
}

// ---- Actions ----
async function reviewField(id, field, decision, note, btn) {
  const item = _rawItems.find(i => i.id === id);
  if (!item) return;
  const decisions = { [field]: decision };
  btn.disabled = true;
  btn.textContent = decision === 'approved' ? 'Approving…' : 'Rejecting…';
  try {
    const result = await AdminAPI.reviewPendingChange(id, decisions, note);
    if (result) Object.assign(item, result);
    Toast.success(`${field}: ${decision}`);
    if (item.status !== _filters.status) {
      _rawItems = _rawItems.filter(i => i.id !== id);
    }
    applyClientFilters();
    if (item.status === 'approved' || item.status === 'rejected') {
      loadSummary();
    }
  } catch (e) {
    Toast.error(`Failed: ${e.message}`);
    btn.disabled = false;
    btn.textContent = decision === 'approved' ? 'Approve' : 'Reject';
  }
}

async function reviewWholeRow(id, decision, note, btn) {
  const item = _rawItems.find(i => i.id === id);
  if (!item) return;
  const fields = getChangedFields(item).filter(f => {
    const d = item.field_decisions?.[f] || 'pending';
    return d === 'pending';
  });
  if (!fields.length) {
    Toast.info('No pending fields on this row');
    return;
  }
  const decisions = {};
  fields.forEach(f => { decisions[f] = decision; });
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = decision === 'approved' ? 'Approving…' : 'Rejecting…';
  try {
    const result = await AdminAPI.reviewPendingChange(id, decisions, note);
    if (result) Object.assign(item, result);
    Toast.success(decision === 'approved' ? 'Approved' : 'Denied');
    _expanded.delete(id);
    if (item.status !== _filters.status) {
      _rawItems = _rawItems.filter(i => i.id !== id);
    }
    applyClientFilters();
    loadSummary();
  } catch (e) {
    Toast.error(`Failed: ${e.message}`);
    btn.disabled = false;
    btn.textContent = original;
  }
}

function bulkAction(action) {
  const ids = [..._selected];
  if (!ids.length) return;
  if (ids.length > 500) {
    Toast.error('Max 500 records per bulk action');
    return;
  }
  Modal.confirm({
    title: `${action === 'approve' ? 'Approve' : 'Reject'} ${ids.length} change${ids.length === 1 ? '' : 's'}?`,
    message: action === 'approve'
      ? 'All fields on the selected records will be approved and applied to the products.'
      : 'All fields on the selected records will be rejected. Products will not be modified.',
    confirmLabel: action === 'approve' ? 'Approve All' : 'Reject All',
    confirmClass: action === 'approve' ? 'admin-btn--primary' : 'admin-btn--danger',
    onConfirm: async () => {
      try {
        const result = await AdminAPI.bulkReviewPendingChanges(ids, action);
        const reviewed = result?.reviewed ?? result?.count ?? ids.length;
        const skipped = result?.skipped ?? 0;
        Toast.success(`${action === 'approve' ? 'Approved' : 'Rejected'} ${reviewed}${skipped ? ` · skipped ${skipped}` : ''}`);
        _selected.clear();
        await refreshAll();
      } catch (e) {
        Toast.error(`Bulk ${action} failed: ${e.message}`);
      }
    },
  });
}

// ---- Data loading ----
async function loadSummary() {
  const summary = await AdminAPI.getPendingChangesSummary();
  if (!_container) return;
  _summary = summary || { pending_total: 0, by_type: {}, by_field: {}, oldest_pending: null, import_runs_with_pending: 0 };
  renderSummary();
  renderTabs();
  // Refresh field options in case new fields appeared
  const fieldSel = document.getElementById('pc-field');
  if (fieldSel) fieldSel.innerHTML = buildFieldOptions();
}

async function load() {
  const wrap = document.getElementById('pc-table');
  if (!wrap) return;
  const token = ++_loadToken;
  wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;padding:60px"><div class="admin-loading__spinner"></div></div>`;

  const filters = {};
  if (_filters.status) filters.status = _filters.status;
  if (_filters.field) filters.field = _filters.field;
  if (_filters.search) filters.search = _filters.search;

  // Fetch up to FETCH_TARGET items in chunks of BACKEND_CHUNK (the backend
  // caps per-request limit at ~100). Stops early if a chunk comes back
  // short or empty.
  const collected = [];
  const maxPages = Math.ceil(FETCH_TARGET / BACKEND_CHUNK);
  for (let page = 1; page <= maxPages; page++) {
    const data = await AdminAPI.getPendingChanges(filters, page, BACKEND_CHUNK);
    if (!_container || token !== _loadToken) return;
    const items = data?.items || data?.changes || (Array.isArray(data) ? data : []);
    if (!items.length) break;
    collected.push(...items);
    if (items.length < BACKEND_CHUNK) break;
  }
  _rawItems = collected;

  // Hydrate product attributes BEFORE applying filters so brand/source/etc
  // can actually match on first render — _productCache is empty on cold load.
  await hydrateProductInfo(token);
  if (!_container || token !== _loadToken) return;

  applyClientFilters();
}

/** Filter `_rawItems` by `_productFilters` + cleared-id hide list, then paginate. */
function applyClientFilters() {
  const pf = _productFilters;
  const filtered = _rawItems.filter(item => {
    if (_filters.status === 'rejected' && _clearedIds.has(item.id)) return false;
    const cached = item.product_id ? _productCache.get(item.product_id) : null;
    if (pf.brand && (!cached || String(cached.brand_id) !== String(pf.brand))) return false;
    if (pf.active !== '') {
      const want = pf.active === 'true';
      if (!cached || !!cached.is_active !== want) return false;
    }
    if (pf.source && (!cached || cached.source !== pf.source)) return false;
    if (pf.product_type && (!cached || cached.product_type !== pf.product_type)) return false;
    if (pf.images === 'has-images' && (!cached || !cached.image_url)) return false;
    if (pf.images === 'no-images' && cached && cached.image_url) return false;
    if (pf.stock) {
      if (!cached) return false;
      if (pf.stock === 'in_stock' && !(cached.stock_quantity > 5)) return false;
      if (pf.stock === 'low_stock' && !(cached.stock_quantity > 0 && cached.stock_quantity <= 5)) return false;
      if (pf.stock === 'out_of_stock' && !(cached.stock_quantity === 0 || cached.stock_quantity == null)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const start = (_page - 1) * PAGE_SIZE;
  _items = filtered.slice(start, start + PAGE_SIZE);
  _pagination = { total, page: _page, limit: PAGE_SIZE };
  // Drop selections that are no longer visible
  _selected.forEach(id => { if (!_items.find(i => i.id === id)) _selected.delete(id); });

  renderTable();
  renderPagination();
  renderBulkBar();
}

/** Fetch product attributes used for display + filtering for the current batch. */
async function hydrateProductInfo(token) {
  const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
  if (!sb) return;
  const ids = [...new Set(_rawItems.map(i => i.product_id).filter(id => id && !_productCache.has(id)))];
  if (!ids.length) return;
  try {
    const { data, error } = await sb.from('products')
      .select('id, name, image_url, is_active, source, product_type, brand_id, stock_quantity')
      .in('id', ids);
    if (error || !data) return;
    if (token !== _loadToken) return;
    for (const p of data) _productCache.set(p.id, p);
  } catch {
    // Silent — row will just show MISSING name and a placeholder thumbnail.
  }
}

/** Hide a denied row from the Denied list. Persists in localStorage. */
function clearItem(id, btn) {
  if (btn) btn.disabled = true;
  _clearedIds.add(id);
  persistClearedIds();
  // Drop from raw list and re-apply filters so the row disappears.
  _rawItems = _rawItems.filter(i => i.id !== id);
  _selected.delete(id);
  _expanded.delete(id);
  applyClientFilters();
  Toast.success('Cleared from Denied');
}

async function refreshAll() {
  await Promise.all([loadSummary(), load()]);
}

// ---- Page lifecycle ----
async function render() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1>${icon('products', 20, 20)} Pending Changes</h1>
        <p style="font-size:13px;color:var(--text-muted);margin:4px 0 0">Review proposed product changes from the latest import. Approve or deny per row, or in bulk.</p>
      </div>
    </div>
    <div id="pc-summary" class="pc-summary"></div>
    <div id="pc-tabs" class="pc-tabs"></div>
    <div id="pc-toolbar" class="pc-toolbar"></div>
    <div id="pc-bulk" class="pc-bulk-bar"></div>
    <div id="pc-table"></div>
    <div id="pc-pagination" class="pc-pagination"></div>
  `;

  // Load brands once for the filter dropdown.
  if (!_brands.length) {
    try {
      const brandsData = await AdminAPI.getBrands();
      if (!_container) return;
      _brands = (brandsData && Array.isArray(brandsData)) ? brandsData : [];
    } catch { _brands = []; }
  }

  renderTabs();
  renderToolbar();
  renderBulkBar();
  await Promise.all([loadSummary(), load()]);
}

export default {
  title: 'Pending Changes',

  async init(container) {
    ensureStyles();
    FilterState.showBar(false);
    _container = container;
    _summary = null;
    _rawItems = [];
    _items = [];
    _selected = new Set();
    _expanded = new Set();
    _filters = { status: 'pending', change_type: '', field: '', search: '' };
    _productFilters = { brand: '', active: '', images: '', source: '', product_type: '', stock: '' };
    _clearedIds = loadClearedIds();
    _page = 1;
    _tableEventsBound = false;
    await render();
  },

  destroy() {
    _loadToken++;
    _container = null;
    _rawItems = [];
    _items = [];
    _selected.clear();
    _expanded.clear();
    _tableEventsBound = false;
  },

  onSearch(query) {
    _filters.search = query;
    _page = 1;
    syncFilterControls();
    load();
  },
};
