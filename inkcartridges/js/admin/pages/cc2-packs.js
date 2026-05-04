/**
 * Control Center — Packs tab
 *
 * Lists unhealthy packs (broken / drifted / both) with filters and a
 * Bundle Tree drawer that shows constituents, drift banner, and a
 * Recommended Action chip backed by bundleLogic.recommendAction.
 *
 * Bulk actions (deactivate / reprice / regenerate) flow through a
 * confirmation modal that is dry-run by default — explicit "Apply"
 * is required to commit, and `regenerate` returns per-row failures
 * with a CLI hint (spec §5.5).
 */
import { AdminAPI, esc, icon } from '../app.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { DataTable } from '../components/table.js';
import { driftSeverity, actionLabel, actionTone } from '../utils/bundleLogic.js';

const COPY = {
  drift_green:  'No drift',
  drift_yellow: 'Minor drift (< $0.50)',
  drift_red:    'Significant drift',
  bulk_dry_run_label: 'Dry run (preview only)',
  bulk_apply_warning: 'This will write to products. Confirm by typing the action name.',
};

let _host = null;
let _table = null;
let _state = {
  source: '',
  filter: 'both',
  page: 1,
  limit: 50,
  selected: new Set(),
};

const COLOR_DOT = {
  Cyan: '#22d3ee',
  Magenta: '#ec4899',
  Yellow: '#facc15',
  Black: '#18181b',
};

function fmtMoney(n, fallback = '—') {
  if (n == null || !Number.isFinite(Number(n))) return fallback;
  return `$${Number(n).toFixed(2)}`;
}

function driftPill(delta) {
  const sev = driftSeverity(delta);
  const sym = sev === 'green' ? '✓' : sev === 'yellow' ? '▲' : '✕';
  const labelMap = { green: COPY.drift_green, yellow: COPY.drift_yellow, red: COPY.drift_red };
  const sign = delta > 0 ? '+' : '';
  const display = `${sym} ${sign}$${(Number(delta) || 0).toFixed(2)}`;
  return `<span class="cc2-pack-drift cc2-pack-drift--${sev}" aria-label="${esc(labelMap[sev])}">${esc(display)}</span>`;
}

function actionChip(action) {
  return `<span class="cc2-action-chip cc2-action-chip--${actionTone(action)}">${esc(actionLabel(action))}</span>`;
}

const COLUMNS = [
  {
    key: 'sku', label: 'SKU', sortable: false,
    render: (r) => `<span class="cell-mono">${esc(r.sku || r.pack_sku || '—')}</span>`,
  },
  {
    key: 'name', label: 'Pack',
    render: (r) => `<span class="cell-truncate" style="max-width:280px" title="${esc(r.name || '')}">${esc(r.name || '—')}</span>`,
  },
  {
    key: 'source', label: 'Source',
    render: (r) => `<span class="admin-badge admin-badge--${r.source === 'genuine' ? 'delivered' : 'pending'}">${esc(r.source || '—')}</span>`,
  },
  {
    key: 'retail_price', label: 'Retail', align: 'right',
    render: (r) => `<span class="cell-mono">${fmtMoney(r.retail_price)}</span>`,
  },
  {
    key: 'drift', label: 'Drift', align: 'right',
    render: (r) => {
      const delta = (r.drift && r.drift.delta != null) ? r.drift.delta : (r.delta != null ? r.delta : 0);
      return driftPill(delta);
    },
  },
  {
    key: 'is_broken', label: 'Status',
    render: (r) => r.is_broken
      ? '<span class="admin-badge admin-badge--failed">broken</span>'
      : (r.is_active === false ? '<span class="admin-badge admin-badge--pending">inactive</span>' : '<span class="admin-badge admin-badge--delivered">healthy</span>'),
  },
  {
    key: 'recommended_action', label: 'Action',
    render: (r) => actionChip(r.recommended_action || 'none'),
  },
];

function renderShell() {
  _host.innerHTML = `
    <div class="cc2-section-header">
      <h2>Pack health</h2>
      <span class="cc2-meta">Sorted: structural issues first, then drift magnitude</span>
    </div>
    <div class="cc2-pack-controls admin-card">
      <label class="cc2-field">
        <span>Source</span>
        <select class="admin-select" data-field="source">
          <option value="">All</option>
          <option value="genuine">Genuine</option>
          <option value="compatible">Compatible</option>
        </select>
      </label>
      <label class="cc2-field">
        <span>Filter</span>
        <select class="admin-select" data-field="filter">
          <option value="both">Broken or drifted</option>
          <option value="broken">Broken only</option>
          <option value="drifted">Drifted only</option>
        </select>
      </label>
      <div class="cc2-pack-controls__actions">
        <span class="cc2-pack-controls__count" data-selected-count>0 selected</span>
        <button class="admin-btn admin-btn--ghost" data-action="bulk-deactivate" disabled>Deactivate</button>
        <button class="admin-btn admin-btn--ghost" data-action="bulk-reprice" disabled>Reprice</button>
        <button class="admin-btn admin-btn--ghost" data-action="bulk-regenerate" disabled>Regenerate</button>
      </div>
    </div>
    <div id="cc2-pack-table"></div>
  `;
  _host.querySelector('[data-field="source"]').addEventListener('change', (e) => {
    _state.source = e.target.value; _state.page = 1; load();
  });
  _host.querySelector('[data-field="filter"]').addEventListener('change', (e) => {
    _state.filter = e.target.value; _state.page = 1; load();
  });
  _host.querySelectorAll('[data-action^="bulk-"]').forEach(btn => {
    btn.addEventListener('click', () => openBulkActionDialog(btn.dataset.action.replace('bulk-', '')));
  });

  _table = new DataTable(_host.querySelector('#cc2-pack-table'), {
    columns: COLUMNS,
    rowKey: 'id',
    selectable: true,
    onRowClick: (row) => openPackTree(row.sku || row.pack_sku || row.id),
    onSelectionChange: (set) => {
      _state.selected = set;
      _host.querySelector('[data-selected-count]').textContent = `${set.size} selected`;
      _host.querySelectorAll('[data-action^="bulk-"]').forEach(b => b.disabled = set.size === 0);
    },
    onPageChange: (p) => { _state.page = p; load(); },
    emptyMessage: 'No unhealthy packs in this slice.',
  });
}

async function load() {
  if (_table) _table.setLoading(true);
  const resp = await AdminAPI.controlCenter.getPackHealthList({
    source: _state.source || undefined,
    filter: _state.filter,
    page: _state.page,
    limit: _state.limit,
  });
  if (!resp) { _table.setData([], null); return; }
  // Backend returns { ok, data, meta? } per the envelope; keep both shapes.
  const rows = Array.isArray(resp.data) ? resp.data : (resp.data?.items || resp.data || []);
  const meta = resp.meta || resp.data?.meta || {};
  _table.setData(rows, { total: meta.total ?? rows.length, page: _state.page, limit: _state.limit });
}

function packTreeBody(p) {
  if (!p) return '<p>Loading…</p>';
  if (!p.found) return '<p class="cc2-pack-tree__empty">Pack not found.</p>';
  if (p.is_pack === false) return `<p class="cc2-pack-tree__empty">${esc(p.pack?.sku || 'This product')} is not a pack.</p>`;
  const sev = driftSeverity(p.drift?.delta || 0);
  const driftClass = `cc2-drift-banner cc2-drift-banner--${sev}`;
  const constituentsHtml = (p.constituents || []).map(c => `
    <li class="cc2-constituent">
      <span class="cc2-color-dot" style="background:${COLOR_DOT[c.color] || '#999'}" aria-hidden="true"></span>
      <span class="cc2-constituent__body">
        <span class="cc2-constituent__name">${esc(c.name || `(${c.color} — missing)`)}</span>
        <span class="cc2-constituent__sku cell-mono">${esc(c.sku || '—')}</span>
      </span>
      ${c.in_products_table
        ? `<span class="admin-badge admin-badge--${c.is_active ? 'delivered' : 'pending'}">${c.is_active ? 'active' : 'inactive'}</span>`
        : '<span class="admin-badge admin-badge--failed">missing</span>'}
      <span class="cc2-constituent__price">${fmtMoney(c.retail_price)}</span>
      <span class="cc2-constituent__stock">${c.stock_quantity != null ? `${c.stock_quantity}u` : '—'}</span>
    </li>
  `).join('');
  return `
    <section class="cc2-pack-tree">
      <header class="cc2-pack-tree__header">
        <div>
          <div class="cc2-pack-tree__title">${esc(p.pack?.name || '')}</div>
          <div class="cc2-pack-tree__sku cell-mono">${esc(p.pack?.sku || '')}</div>
        </div>
        ${actionChip(p.recommended_action || 'none')}
      </header>

      <div class="${driftClass}">
        <div class="cc2-drift-banner__label">Price drift</div>
        <div class="cc2-drift-banner__values">
          expected ${fmtMoney(p.drift?.expected_retail)} ·
          actual ${fmtMoney(p.drift?.actual_retail)} ·
          <strong>Δ ${(p.drift?.delta ?? 0) >= 0 ? '+' : ''}$${Math.abs(Number(p.drift?.delta) || 0).toFixed(2)}</strong>
        </div>
      </div>

      <h4>Constituents</h4>
      <ul class="cc2-constituent-list">${constituentsHtml}</ul>

      ${p.missing_color_suffixes?.length ? `<p class="cc2-pack-tree__warn">Missing colour suffixes: <strong>${esc(p.missing_color_suffixes.join(', '))}</strong></p>` : ''}
      ${p.inactive_constituent_skus?.length ? `<p class="cc2-pack-tree__warn">Inactive SKUs: <strong class="cell-mono">${esc(p.inactive_constituent_skus.join(', '))}</strong></p>` : ''}
    </section>
  `;
}

async function openPackTree(skuOrId) {
  if (!skuOrId) return;
  const drawer = Drawer.open({
    title: `Pack: ${skuOrId}`,
    body: '<div class="cc2-loading"><div class="admin-loading__spinner"></div></div>',
    width: '560px',
  });
  const data = await AdminAPI.controlCenter.getPackHealth(skuOrId);
  if (drawer) drawer.setBody(packTreeBody(data));
}

function openBulkActionDialog(action) {
  const ids = [..._state.selected];
  if (!ids.length) return;
  const actionTitle = action.charAt(0).toUpperCase() + action.slice(1);
  Modal.open({
    title: `${actionTitle} ${ids.length} pack${ids.length !== 1 ? 's' : ''}`,
    body: `
      <p style="margin:0 0 12px 0;color:var(--text-secondary)">${esc(COPY.bulk_apply_warning)}</p>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px">
        <input type="checkbox" data-bulk-dry-run checked>
        ${esc(COPY.bulk_dry_run_label)}
      </label>
      <label style="display:block;margin-top:12px;font-size:13px">
        <span style="display:block;margin-bottom:4px">Reason (optional, for audit log)</span>
        <input class="admin-input" data-bulk-reason style="width:100%" placeholder="e.g. constituent SKU deactivated upstream">
      </label>
      <label style="display:block;margin-top:12px;font-size:13px">
        <span style="display:block;margin-bottom:4px">Type "${esc(action)}" to confirm apply</span>
        <input class="admin-input" data-bulk-confirm style="width:100%" placeholder="${esc(action)}">
      </label>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="apply">Run</button>
    `,
  });
  const root = document.getElementById('modal-root');
  root.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  root.querySelector('[data-action="apply"]').addEventListener('click', async () => {
    const dryRun = root.querySelector('[data-bulk-dry-run]').checked;
    const reason = root.querySelector('[data-bulk-reason]').value.trim() || undefined;
    const confirmText = root.querySelector('[data-bulk-confirm]').value.trim().toLowerCase();
    if (!dryRun && confirmText !== action) {
      Toast.warning(`Type "${action}" to confirm a non-dry-run apply`);
      return;
    }
    const btn = root.querySelector('[data-action="apply"]');
    btn.disabled = true; btn.textContent = dryRun ? 'Previewing…' : 'Applying…';
    try {
      const result = await AdminAPI.controlCenter.bulkPackAction({
        pack_ids: ids, action, dry_run: dryRun, reason,
      });
      Modal.close();
      const okCount = (result?.results || []).filter(r => r.ok).length;
      const failCount = (result?.results || []).length - okCount;
      Toast.success(`${dryRun ? 'Dry run' : 'Applied'}: ${okCount} ok / ${failCount} failed`);
      if (failCount && action === 'regenerate') {
        Toast.info('Regenerate requires the CLI: scripts/genuine.js or scripts/compatible.js', 8000);
      }
      if (!dryRun) {
        _state.selected.clear();
        if (_table) _table.clearSelection();
        load();
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Run';
      if (e.code === 'RATE_LIMITED') Toast.warning('Slow down — try again in a few seconds.');
      else Toast.error(e.message || 'Bulk action failed');
    }
  });
}

export default {
  async init(host) {
    _host = host;
    _state = { source: '', filter: 'both', page: 1, limit: 50, selected: new Set() };
    renderShell();
    load();
  },
  destroy() {
    if (_table) { _table.destroy?.(); _table = null; }
    _host = null;
  },
};
