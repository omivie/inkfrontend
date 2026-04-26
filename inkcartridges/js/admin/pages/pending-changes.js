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

const PAGE_SIZE = 50;
const MISSING = '—';

// ---- Module state ----
let _container = null;
let _summary = null;
let _items = [];
let _pagination = { total: 0, page: 1, limit: PAGE_SIZE };
let _selected = new Set();
let _expanded = new Set();
let _filters = { status: 'pending', change_type: '', field: '', search: '' };
let _page = 1;
let _loadToken = 0;
// Product info cache (id -> { name, image_url }) — pending_product_changes.old_data/new_data
// only stores the changed fields, so name/current image must be looked up from products.
const _productCache = new Map();

/** Resolve a storage path or URL to a usable <img src>. */
function resolveImageSrc(value) {
  if (!value || typeof value !== 'string') return null;
  if (typeof window.storageUrl === 'function') return window.storageUrl(value);
  if (/^https?:\/\//.test(value) || value.startsWith('/')) return value;
  return null;
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
      return `<a href="${esc(src)}" target="_blank" rel="noopener" class="pc-row__field-thumb" title="${esc(value)}"><img src="${esc(src)}" alt="" loading="lazy"></a>`;
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
    .pc-row__thumb { width: 200px; height: 200px; border-radius: 10px; object-fit: cover; background: var(--surface-hover); border: 1px solid var(--border); flex-shrink: 0; }
    .pc-row__thumb--empty { display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); }
    .pc-row__text { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .pc-row__name { color: var(--text); font-weight: 500; font-size: 14px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; }
    .pc-row__sku { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-muted); font-weight: 400; line-height: 1.2; }
    .pc-row__fields { display: flex; flex-wrap: wrap; gap: 6px; max-width: 360px; align-items: center; }
    .pc-row__field-chip { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--cyan-dim); color: var(--cyan-text); font-family: var(--font-mono, monospace); }
    .pc-row__field-thumb { display: inline-block; width: 160px; height: 160px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); background: var(--surface-hover); }
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
  const status = c.querySelector('#pc-status');
  const type = c.querySelector('#pc-type');
  const field = c.querySelector('#pc-field');
  if (search && search.value !== _filters.search) search.value = _filters.search;
  if (status) status.value = _filters.status;
  if (type) type.value = _filters.change_type;
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

function renderToolbar() {
  const wrap = document.getElementById('pc-toolbar');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="admin-search">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" id="pc-search" placeholder="Search SKU or name…" value="${esc(_filters.search)}">
    </div>
    <select class="admin-select" id="pc-status">
      <option value="pending"${_filters.status === 'pending' ? ' selected' : ''}>Pending</option>
      <option value="partial"${_filters.status === 'partial' ? ' selected' : ''}>Partial</option>
      <option value="approved"${_filters.status === 'approved' ? ' selected' : ''}>Approved</option>
      <option value="rejected"${_filters.status === 'rejected' ? ' selected' : ''}>Rejected</option>
      <option value="superseded"${_filters.status === 'superseded' ? ' selected' : ''}>Superseded</option>
      <option value=""${_filters.status === '' ? ' selected' : ''}>All</option>
    </select>
    <select class="admin-select" id="pc-type">
      <option value=""${_filters.change_type === '' ? ' selected' : ''}>All types</option>
      <option value="ADD"${_filters.change_type === 'ADD' ? ' selected' : ''}>ADD</option>
      <option value="UPDATE"${_filters.change_type === 'UPDATE' ? ' selected' : ''}>UPDATE</option>
      <option value="DEACTIVATE"${_filters.change_type === 'DEACTIVATE' ? ' selected' : ''}>DEACTIVATE</option>
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
  wrap.querySelector('#pc-status').addEventListener('change', (e) => { _filters.status = e.target.value; _page = 1; load(); });
  wrap.querySelector('#pc-type').addEventListener('change', (e) => { _filters.change_type = e.target.value; _page = 1; renderSummary(); load(); });
  wrap.querySelector('#pc-field').addEventListener('change', (e) => { _filters.field = e.target.value; _page = 1; renderSummary(); load(); });
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
  const oldImageSrc = resolveImageSrc(item.old_data?.image_url) || resolveImageSrc(cached?.image_url);
  const fieldChips = fields.slice(0, 6).map(f => {
    if (f === 'image_url' && newImageSrc) {
      return `<a href="${esc(newImageSrc)}" target="_blank" rel="noopener" class="pc-row__field-thumb" title="New image_url — click to open"><img src="${esc(newImageSrc)}" alt="new image" loading="lazy"></a>`;
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
  const thumb = thumbSrc
    ? `<img class="pc-row__thumb" src="${esc(thumbSrc)}" alt="" loading="lazy">`
    : `<div class="pc-row__thumb pc-row__thumb--empty">${icon('products', 18, 18)}</div>`;

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
      <td>${changeTypeBadge(item.change_type)}</td>
      <td>${statusBadge(item.status)}</td>
      <td><div class="pc-row__fields">${fieldChips}${more}</div></td>
      <td>${fmtRelative(item.created_at || item.detected_at)}</td>
      <td style="text-align:right">
        <button class="pc-row__expand" aria-expanded="${isExpanded ? 'true' : 'false'}" data-toggle="${esc(item.id)}" title="${isExpanded ? 'Collapse' : 'Expand'}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </td>
    </tr>
    ${isExpanded ? renderDetailRow(item) : ''}
  `;
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
      <td colspan="7">
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
            <th>Type</th>
            <th>Status</th>
            <th>Changed Fields</th>
            <th>Age</th>
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
      load();
    });
  });
}

// ---- Event binding ----
function bindTableEvents() {
  const wrap = document.getElementById('pc-table');
  if (!wrap) return;

  wrap.addEventListener('click', (e) => {
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
      reviewWholeRow(id, action === 'approve-all' ? 'approved' : 'rejected', note, rowBtn);
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
  const item = _items.find(i => i.id === id);
  if (!item) return;
  const decisions = { [field]: decision };
  btn.disabled = true;
  btn.textContent = decision === 'approved' ? 'Approving…' : 'Rejecting…';
  try {
    const result = await AdminAPI.reviewPendingChange(id, decisions, note);
    // Merge updated state back
    if (result) Object.assign(item, result);
    Toast.success(`${field}: ${decision}`);
    renderTable();
    // If row is now fully resolved, refresh summary so counts stay in sync
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
  const item = _items.find(i => i.id === id);
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
    Toast.success(`Row ${decision}`);
    _expanded.delete(id);
    renderTable();
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
  if (_filters.change_type) filters.change_type = _filters.change_type;
  if (_filters.field) filters.field = _filters.field;
  if (_filters.search) filters.search = _filters.search;

  const data = await AdminAPI.getPendingChanges(filters, _page, PAGE_SIZE);
  if (!_container || token !== _loadToken) return;

  const items = data?.items || data?.changes || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || { total: data?.total ?? items.length, page: _page, limit: PAGE_SIZE };

  _items = items;
  _pagination = pagination;
  // Drop selections that are no longer visible
  _selected.forEach(id => { if (!_items.find(i => i.id === id)) _selected.delete(id); });

  renderTable();
  renderPagination();
  renderBulkBar();

  // Hydrate product names + current images, then re-render rows once available.
  hydrateProductInfo(token);
}

/** Fetch name + current image_url for products referenced by the visible rows. */
async function hydrateProductInfo(token) {
  const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
  if (!sb) return;
  const ids = [...new Set(_items.map(i => i.product_id).filter(id => id && !_productCache.has(id)))];
  if (!ids.length) return;
  try {
    const { data, error } = await sb.from('products').select('id, name, image_url').in('id', ids);
    if (error || !data) return;
    if (token !== _loadToken) return;
    for (const p of data) _productCache.set(p.id, { name: p.name, image_url: p.image_url });
    renderTable();
  } catch {
    // Silent — row will just show MISSING name and a placeholder thumbnail.
  }
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
        <p style="font-size:13px;color:var(--text-muted);margin:4px 0 0">Review proposed product changes from the latest import. Approve or reject per field, or in bulk.</p>
      </div>
    </div>
    <div id="pc-summary" class="pc-summary"></div>
    <div id="pc-toolbar" class="pc-toolbar"></div>
    <div id="pc-bulk" class="pc-bulk-bar"></div>
    <div id="pc-table"></div>
    <div id="pc-pagination" class="pc-pagination"></div>
  `;
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
    _items = [];
    _selected = new Set();
    _expanded = new Set();
    _filters = { status: 'pending', change_type: '', field: '', search: '' };
    _page = 1;
    await render();
  },

  destroy() {
    _loadToken++;
    _container = null;
    _items = [];
    _selected.clear();
    _expanded.clear();
  },

  onSearch(query) {
    _filters.search = query;
    _page = 1;
    syncFilterControls();
    load();
  },
};
