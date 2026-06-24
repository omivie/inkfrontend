/**
 * Feed Sync — admin review & bulk-publish of daily feed-import changes.
 *
 * June 2026: migrated from the legacy standalone /admin/sync-report page (its
 * own pre-SPA shell rendered broken inside the new admin) into a first-class
 * SPA page so it shares the sidebar, theming and lifecycle like every other
 * section. Logic ported from the old js/admin/sync-report-page.js; data via
 * AdminAPI.getSyncReport() / AdminAPI.bulkPublish().
 */
import { AdminAPI, FilterState, esc } from '../app.js';
import { Toast } from '../components/toast.js';

const STYLE_ID = 'sync-report-styles';
const STYLE = `
  .sync-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--spacing-4); margin-bottom: var(--spacing-6); }
  .sync-summary__card { background: var(--color-background); border-radius: var(--radius-lg); border: 1px solid var(--color-border); padding: var(--spacing-5); text-align: center; }
  .sync-summary__value { font-size: var(--font-size-2xl); font-weight: var(--font-weight-bold); margin-bottom: var(--spacing-1); }
  .sync-summary__label { font-size: var(--font-size-sm); color: var(--color-text-muted); }
  .sync-summary__card--added .sync-summary__value { color: #059669; }
  .sync-summary__card--updated .sync-summary__value { color: #2563EB; }
  .sync-summary__card--removed .sync-summary__value { color: var(--magenta-primary, #dc2626); }
  .sync-summary__card--high { border-color: var(--yellow-primary, #f59e0b); }
  .sync-summary__card--high .sync-summary__value { color: var(--yellow-dark, #b45309); }
  .sync-summary__card--auto .sync-summary__value { color: #6b7280; }

  .sync-filters { display: flex; gap: var(--spacing-3); margin-bottom: var(--spacing-5); flex-wrap: wrap; align-items: center; }
  .sync-filters select { padding: var(--spacing-2) var(--spacing-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-background); font-size: var(--font-size-sm); cursor: pointer; color: var(--text-primary, inherit); }

  .sync-actions { display: flex; gap: var(--spacing-3); margin-bottom: var(--spacing-5); align-items: center; }
  .sync-actions__count { font-size: var(--font-size-sm); color: var(--color-text-muted); margin-left: auto; }

  .sync-table { width: 100%; border-collapse: collapse; background: var(--color-background); border-radius: var(--radius-lg); border: 1px solid var(--color-border); overflow: hidden; }
  .sync-table th, .sync-table td { padding: var(--spacing-3) var(--spacing-4); text-align: left; border-bottom: 1px solid var(--color-border-light); }
  .sync-table th { font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: var(--letter-spacing-wide); background: var(--color-background-alt); }
  .sync-table tbody tr:hover { background: var(--color-background-alt); }
  .sync-table th:first-child { width: 40px; }

  .priority-badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: var(--radius-full); font-size: var(--font-size-xs); font-weight: var(--font-weight-medium); }
  .priority-badge--red { background: #FEE2E2; color: #DC2626; }
  .priority-badge--orange { background: #FFF7ED; color: #EA580C; }
  .priority-badge--yellow { background: #FFFBEB; color: #B45309; }
  .priority-badge--gray { background: var(--color-background-alt); color: var(--color-text-muted); }
  .priority-badge--green { background: #D1FAE5; color: #059669; }

  .action-badge { display: inline-flex; padding: 2px 8px; border-radius: var(--radius-sm); font-size: var(--font-size-xs); font-weight: var(--font-weight-semibold); }
  .action-badge--add { background: #D1FAE5; color: #059669; }
  .action-badge--update { background: #DBEAFE; color: #2563EB; }
  .action-badge--remove { background: #FEE2E2; color: #DC2626; }

  .sync-diff { font-size: var(--font-size-xs); max-width: 300px; }
  .sync-diff__old { color: #DC2626; text-decoration: line-through; }
  .sync-diff__new { color: #059669; }

  .import-info { background: var(--color-background-alt); border-radius: var(--radius-md); padding: var(--spacing-3) var(--spacing-4); margin-bottom: var(--spacing-5); font-size: var(--font-size-sm); display: flex; gap: var(--spacing-4); align-items: center; flex-wrap: wrap; }
  .import-info__item { display: flex; align-items: center; gap: var(--spacing-2); }
  .import-info__label { color: var(--color-text-muted); }

  .sync-empty { text-align: center; padding: var(--spacing-12); color: var(--color-text-muted); }
  .sync-empty__icon { margin-bottom: var(--spacing-4); opacity: 0.4; }
  .sync-empty__title { font-size: var(--font-size-lg); font-weight: var(--font-weight-semibold); margin-bottom: var(--spacing-2); }

  .sync-pagination { display: flex; justify-content: center; gap: var(--spacing-2); margin-top: var(--spacing-5); }
  .sync-pagination button { padding: var(--spacing-2) var(--spacing-3); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-background); font-size: var(--font-size-sm); cursor: pointer; color: var(--text-primary, inherit); }
  .sync-pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
  .sync-pagination button.active { background: var(--cyan-primary); color: white; border-color: var(--cyan-primary); }

  @media (max-width: 1200px) { .sync-summary { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 768px) {
    .sync-summary { grid-template-columns: repeat(2, 1fr); }
    .sync-filters { flex-direction: column; }
  }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = STYLE;
  document.head.appendChild(s);
}

let _container = null;
let _seq = 0; // bumped on destroy + each load; a late fetch bails if superseded
const state = {
  items: [],
  summary: {},
  importRun: null,
  selectedSkus: new Set(),
  currentPage: 1,
  totalPages: 1,
  filters: { action: '', priority: '', source: '' },
};

const $ = (sel) => _container?.querySelector(sel);

function renderShell() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1>Feed Sync</h1>
        <p class="admin-page-header__sub">Review product changes from daily feed imports.</p>
      </div>
      <div class="admin-page-header__actions">
        <button class="admin-btn admin-btn--ghost" id="sync-refresh-btn" title="Reload report">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Refresh
        </button>
      </div>
    </div>

    <div class="import-info" id="import-info" style="display:none">
      <div class="import-info__item"><span class="import-info__label">Last import:</span> <strong id="import-script"></strong></div>
      <div class="import-info__item"><span class="import-info__label">Status:</span> <span id="import-status"></span></div>
      <div class="import-info__item"><span class="import-info__label">Finished:</span> <span id="import-time"></span></div>
      <div class="import-info__item"><span class="import-info__label">Products processed:</span> <span id="import-counts"></span></div>
    </div>

    <div class="sync-summary">
      <div class="sync-summary__card sync-summary__card--added"><div class="sync-summary__value" id="summary-added">-</div><div class="sync-summary__label">Added</div></div>
      <div class="sync-summary__card sync-summary__card--updated"><div class="sync-summary__value" id="summary-updated">-</div><div class="sync-summary__label">Updated</div></div>
      <div class="sync-summary__card sync-summary__card--removed"><div class="sync-summary__value" id="summary-removed">-</div><div class="sync-summary__label">Removed</div></div>
      <div class="sync-summary__card sync-summary__card--high"><div class="sync-summary__value" id="summary-high">-</div><div class="sync-summary__label">High Priority</div></div>
      <div class="sync-summary__card sync-summary__card--auto"><div class="sync-summary__value" id="summary-auto">-</div><div class="sync-summary__label">Auto-Approved</div></div>
    </div>

    <div class="sync-filters">
      <select id="filter-action">
        <option value="">All Actions</option><option value="ADD">Added</option><option value="UPDATE">Updated</option><option value="REMOVE">Removed</option>
      </select>
      <select id="filter-priority">
        <option value="">All Priority</option><option value="high">High Priority</option><option value="normal">Normal</option>
      </select>
      <select id="filter-source">
        <option value="">All Sources</option><option value="genuine">Genuine</option><option value="compatible">Compatible</option>
      </select>
    </div>

    <div class="sync-actions">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="publish-selected-btn" disabled>Publish Selected (<span id="selected-count">0</span>)</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="select-all-normal-btn">Select All Normal</button>
      <div class="sync-actions__count" id="items-count"></div>
    </div>

    <table class="sync-table" id="sync-table">
      <thead><tr>
        <th><input type="checkbox" id="select-all-checkbox" title="Select all"></th>
        <th>SKU</th><th>Source</th><th>Action</th><th>Priority</th><th>Details</th><th>Status</th>
      </tr></thead>
      <tbody id="sync-tbody"></tbody>
    </table>

    <div class="sync-empty" id="sync-empty" style="display:none">
      <div class="sync-empty__icon"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H2v7l6.29 6.29c.94.94 2.48.94 3.42 0l3.58-3.58c.94-.94.94-2.48 0-3.42L9 5Z"/><path d="M6 9.01V9"/></svg></div>
      <div class="sync-empty__title">No sync items</div>
      <p>No product changes match the current filters.</p>
    </div>

    <div class="sync-pagination" id="sync-pagination" style="display:none"></div>
  `;
  bindEvents();
}

function bindEvents() {
  $('#filter-action')?.addEventListener('change', (e) => { state.filters.action = e.target.value; state.currentPage = 1; loadReport(); });
  $('#filter-priority')?.addEventListener('change', (e) => { state.filters.priority = e.target.value; state.currentPage = 1; loadReport(); });
  $('#filter-source')?.addEventListener('change', (e) => { state.filters.source = e.target.value; state.currentPage = 1; loadReport(); });
  $('#sync-refresh-btn')?.addEventListener('click', () => loadReport());

  $('#select-all-checkbox')?.addEventListener('change', (e) => {
    const checked = e.target.checked;
    state.items.forEach(item => {
      if (!item.published_at) { if (checked) state.selectedSkus.add(item.sku); else state.selectedSkus.delete(item.sku); }
    });
    updateCheckboxes();
    updatePublishButton();
  });

  $('#select-all-normal-btn')?.addEventListener('click', () => {
    state.items.forEach(item => { if (!item.published_at && item.priority === 'normal') state.selectedSkus.add(item.sku); });
    updateCheckboxes();
    updatePublishButton();
  });

  $('#publish-selected-btn')?.addEventListener('click', () => publishSelected());
}

async function loadReport() {
  const seq = ++_seq;
  const resp = await AdminAPI.getSyncReport({
    page: state.currentPage,
    limit: 50,
    action: state.filters.action || undefined,
    priority: state.filters.priority || undefined,
    source: state.filters.source || undefined,
  });
  if (seq !== _seq || !_container) return; // superseded / navigated away

  if (!resp || !resp.ok) { showEmpty(); return; }
  const data = resp.data || {};
  state.items = data.items || [];
  state.summary = data.summary || {};
  state.importRun = data.import_run || null;
  state.totalPages = resp.meta?.total_pages || 1;
  state.currentPage = resp.meta?.page || 1;

  renderImportInfo();
  renderSummary();
  renderTable();
  renderPagination();
}

function renderImportInfo() {
  const el = $('#import-info');
  if (!el || !state.importRun) { if (el) el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const r = state.importRun;
  $('#import-script').textContent = r.script_name || 'Unknown';
  $('#import-status').textContent = r.status || '-';
  if (r.finished_at) $('#import-time').textContent = new Date(r.finished_at).toLocaleString('en-NZ', { dateStyle: 'medium', timeStyle: 'short' });
  $('#import-counts').textContent = `${r.products_upserted || 0} upserted, ${r.products_deactivated || 0} deactivated, ${r.products_skipped || 0} skipped`;
}

function renderSummary() {
  const set = (id, val) => { const el = $('#' + id); if (el) el.textContent = val ?? '-'; };
  const s = state.summary;
  set('summary-added', s.added);
  set('summary-updated', s.updated);
  set('summary-removed', s.removed);
  set('summary-high', s.high_priority);
  set('summary-auto', s.auto_approved);
}

function renderTable() {
  const tbody = $('#sync-tbody');
  if (!tbody) return;
  if (!state.items.length) { showEmpty(); return; }

  const table = $('#sync-table');
  const empty = $('#sync-empty');
  const countEl = $('#items-count');
  if (table) table.style.display = '';
  if (empty) empty.style.display = 'none';
  if (countEl) countEl.textContent = `${state.items.length} items`;

  tbody.innerHTML = state.items.map(item => {
    const checked = state.selectedSkus.has(item.sku) ? 'checked' : '';
    const disabled = item.published_at ? 'disabled' : '';
    const status = item.published_at
      ? `<span class="priority-badge priority-badge--green">Published</span>`
      : `<span class="priority-badge priority-badge--gray">Pending</span>`;
    return `<tr>
      <td><input type="checkbox" data-sku="${esc(item.sku)}" ${checked} ${disabled}></td>
      <td><strong>${esc(item.sku)}</strong></td>
      <td>${esc(item.source || '-')}</td>
      <td>${getActionBadge(item.action)}</td>
      <td>${getPriorityBadge(item)}</td>
      <td>${getDetailsHtml(item)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const sku = cb.dataset.sku;
      if (cb.checked) state.selectedSkus.add(sku); else state.selectedSkus.delete(sku);
      updatePublishButton();
    });
  });
}

function getActionBadge(action) {
  const map = {
    ADD: '<span class="action-badge action-badge--add">ADD</span>',
    UPDATE: '<span class="action-badge action-badge--update">UPDATE</span>',
    REMOVE: '<span class="action-badge action-badge--remove">REMOVE</span>',
  };
  return map[action] || `<span class="action-badge">${esc(action)}</span>`;
}

function getPriorityBadge(item) {
  if (item.priority !== 'high') return '<span class="priority-badge priority-badge--gray">Normal</span>';
  const reasons = item.priority_reasons || [];
  if (reasons.includes('price_anomaly')) return '<span class="priority-badge priority-badge--orange">Price Spike</span>';
  if (reasons.includes('missing_image')) return '<span class="priority-badge priority-badge--red">No Image</span>';
  if (reasons.includes('missing_compatibility')) return '<span class="priority-badge priority-badge--yellow">No Printers</span>';
  if (reasons.includes('duplicate_suspect')) return '<span class="priority-badge priority-badge--orange">Duplicate?</span>';
  return '<span class="priority-badge priority-badge--yellow">Review</span>';
}

function getDetailsHtml(item) {
  if (item.action === 'ADD' && item.new_data) {
    const name = item.new_data.name || '';
    const price = item.new_data.retail_price != null ? `$${Number(item.new_data.retail_price).toFixed(2)}` : '';
    return `<div class="sync-diff"><div>${esc(name)}</div>${price ? `<div>${esc(price)}</div>` : ''}</div>`;
  }
  if (item.action === 'UPDATE' && item.changed_fields?.length) {
    const diffs = item.changed_fields.slice(0, 3).map(field => {
      const oldVal = item.old_data?.[field];
      const newVal = item.new_data?.[field];
      return `<div><strong>${esc(field)}:</strong> <span class="sync-diff__old">${esc(String(oldVal ?? ''))}</span> &rarr; <span class="sync-diff__new">${esc(String(newVal ?? ''))}</span></div>`;
    });
    if (item.changed_fields.length > 3) diffs.push(`<div style="color:var(--color-text-muted)">+${item.changed_fields.length - 3} more</div>`);
    return `<div class="sync-diff">${diffs.join('')}</div>`;
  }
  if (item.action === 'REMOVE') {
    const name = item.old_data?.name || item.new_data?.name || '';
    return `<div class="sync-diff" style="color:var(--color-text-muted)">${esc(name)}</div>`;
  }
  return '-';
}

function showEmpty() {
  const table = $('#sync-table');
  const empty = $('#sync-empty');
  if (table) table.style.display = 'none';
  if (empty) empty.style.display = '';
  const countEl = $('#items-count');
  if (countEl) countEl.textContent = '0 items';
}

function renderPagination() {
  const container = $('#sync-pagination');
  if (!container || state.totalPages <= 1) { if (container) container.style.display = 'none'; return; }
  container.style.display = 'flex';
  container.innerHTML = '';

  const mkBtn = (label, disabled, onClick, active = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    if (active) b.classList.add('active');
    b.addEventListener('click', onClick);
    return b;
  };

  container.appendChild(mkBtn('Prev', state.currentPage <= 1, () => { state.currentPage--; loadReport(); }));
  for (let i = 1; i <= state.totalPages; i++) {
    container.appendChild(mkBtn(String(i), false, () => { state.currentPage = i; loadReport(); }, i === state.currentPage));
  }
  container.appendChild(mkBtn('Next', state.currentPage >= state.totalPages, () => { state.currentPage++; loadReport(); }));
}

function updateCheckboxes() {
  _container?.querySelectorAll('#sync-tbody input[type="checkbox"]').forEach(cb => {
    cb.checked = state.selectedSkus.has(cb.dataset.sku);
  });
}

function updatePublishButton() {
  const btn = $('#publish-selected-btn');
  const count = $('#selected-count');
  if (btn) btn.disabled = state.selectedSkus.size === 0;
  if (count) count.textContent = state.selectedSkus.size;
}

async function publishSelected() {
  if (state.selectedSkus.size === 0) return;
  const skus = [...state.selectedSkus];
  const btn = $('#publish-selected-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }

  try {
    const result = await AdminAPI.bulkPublish(skus);
    const published = result?.published || 0;
    const invalid = result?.invalid_skus || [];
    Toast.success(`Published ${published} product${published !== 1 ? 's' : ''}`);
    if (invalid.length) Toast.warning(`${invalid.length} SKU${invalid.length !== 1 ? 's' : ''} could not be published: ${invalid.join(', ')}`);
    state.selectedSkus.clear();
    updatePublishButton();
    await loadReport();
  } catch (e) {
    Toast.error(`Publish failed: ${e.message}`);
  } finally {
    const b = $('#publish-selected-btn');
    if (b) {
      b.disabled = state.selectedSkus.size === 0;
      b.innerHTML = `Publish Selected (<span id="selected-count">${state.selectedSkus.size}</span>)`;
    }
  }
}

export default {
  title: 'Feed Sync',

  async init(container) {
    injectStyles();
    FilterState.showBar(false);
    _container = container;
    state.items = [];
    state.summary = {};
    state.importRun = null;
    state.selectedSkus = new Set();
    state.currentPage = 1;
    state.totalPages = 1;
    state.filters = { action: '', priority: '', source: '' };
    renderShell();
    await loadReport();
  },

  destroy() {
    _seq++; // invalidate any in-flight loadReport()
    _container = null;
  },
};
