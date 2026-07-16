/**
 * Control Center — Tab 1: Profit & Pricing
 * Margin heatmap, under-margin products, global offset slider
 */
import { AdminAPI, AdminAuth, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { normalizeTierResponse, sortTierKeys } from '../utils/pricingCalculator.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const TIERS = ['<$10', '$10-30', '$30-60', '$60-100', '$100+'];

let _el = null;
let _table = null;
let _heatmapSource = 'genuine';
let _tableSource = 'genuine';
let _tablePage = 1;
let _tableMode = 'under-margin';
let _tableSortBy = 'net_margin';
let _tableSortOrder = 'asc';
let _tableMinGap = 0;
let _savedOffset = null;
let _sliderTimer = null;
let _repricePollTimer = null;

/**
 * Surface the background reprice kicked off by a tier-multiplier / global-offset
 * save. Both PUTs now return 202 with a `reprice` block:
 *   { status: 'queued'|'enqueue_failed', job_id, message }
 * Show the backend's own wording, then (when queued) poll the job to completion
 * for a "repricing complete — N updated" follow-up. Only one poll runs at a time.
 */
function handleRepriceResponse(data) {
  const reprice = data && data.reprice;
  if (!reprice) { Toast.success('Saved'); return; }
  if (reprice.status === 'queued') {
    Toast.success(reprice.message || 'Settings saved. Repricing in the background.');
    if (reprice.job_id) pollRepriceJob(reprice.job_id);
  } else {
    // enqueue_failed (or anything non-queued): config saved, reprice did not start.
    Toast.warning(reprice.message || 'Saved, but background repricing did not start.');
  }
}

function pollRepriceJob(jobId) {
  clearInterval(_repricePollTimer);
  const startedAt = Date.now();
  const MAX_MS = 3 * 60_000; // give up after ~3 min; the queued toast already informed the operator
  _repricePollTimer = setInterval(async () => {
    if (Date.now() - startedAt > MAX_MS) { clearInterval(_repricePollTimer); return; }
    const job = await AdminAPI.getRepriceJob(jobId);
    if (!job) return; // transient read miss — try again next tick
    if (job.status === 'completed') {
      clearInterval(_repricePollTimer);
      const n = job.counts && job.counts.updated;
      Toast.success(typeof n === 'number' ? `Repricing complete — ${n} price${n !== 1 ? 's' : ''} updated` : 'Repricing complete');
    } else if (job.status === 'failed') {
      clearInterval(_repricePollTimer);
      Toast.error(job.error || 'Background repricing failed — prices may be unchanged.');
    }
  }, 4000);
}

function heatColor(margin) {
  if (margin < 5) return 'rgba(220,53,69,0.85)';
  if (margin < 15) return 'rgba(255,193,7,0.8)';
  return 'rgba(40,167,69,0.85)';
}

function renderHeatmap(data) {
  const grid = _el.querySelector('#cc-heatmap-grid');
  if (!data || !data.length) {
    grid.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No heatmap data available</div></div>';
    return;
  }
  // Group by brand → tier
  const brands = {};
  for (const row of data) {
    if (!brands[row.brand]) brands[row.brand] = {};
    brands[row.brand][row.tier] = row;
  }
  let html = '<div class="cc-heatmap__header"></div>';
  for (const t of TIERS) html += `<div class="cc-heatmap__header">${esc(t)}</div>`;
  for (const [brand, tiers] of Object.entries(brands)) {
    html += `<div class="cc-heatmap__brand">${esc(brand)}</div>`;
    for (const t of TIERS) {
      const d = tiers[t];
      if (d) {
        html += `<div class="cc-heatmap__cell" style="background:${heatColor(d.avg_margin)}">
          ${d.avg_margin.toFixed(1)}%
          <div class="cc-heatmap__cell-tip">
            ${esc(brand)} &middot; ${esc(t)}<br>
            Avg: ${d.avg_margin.toFixed(1)}% &middot; Min: ${d.min_margin.toFixed(1)}% &middot; Max: ${d.max_margin.toFixed(1)}%<br>
            ${d.count} product${d.count !== 1 ? 's' : ''}
          </div>
        </div>`;
      } else {
        html += '<div class="cc-heatmap__cell cc-heatmap__cell--empty">&mdash;</div>';
      }
    }
  }
  grid.innerHTML = html;
}

async function loadHeatmap() {
  const grid = _el.querySelector('#cc-heatmap-grid');
  grid.innerHTML = '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>';
  const data = await AdminAPI.getPricingHeatmap(_heatmapSource);
  renderHeatmap(data);
}

async function loadUnderMargin() {
  if (_table) _table.setLoading(true);
  const limit = _tableMode === 'all' ? 100 : 50;
  const resp = await AdminAPI.getUnderMarginProducts(_tableSource, _tablePage, limit, _tableMode, _tableSortBy, _tableSortOrder);
  if (!resp) { if (_table) _table.setData([], null); updateMarginCountChip(0); return; }
  const allRows = resp.data || [];
  const meta = resp.metadata || {};
  const rows = _tableMinGap > 0
    ? allRows.filter(r => Math.abs(Number(r.gap) || 0) >= _tableMinGap)
    : allRows;
  const total = meta.total != null ? meta.total : allRows.length;
  if (_table) _table.setData(rows, { total, page: meta.page || _tablePage, limit });
  updateMarginCountChip(total);
}

function updateMarginCountChip(total) {
  const chip = _el?.querySelector('#cc-margin-count');
  if (!chip) return;
  const n = Number(total) || 0;
  chip.textContent = n.toLocaleString('en-NZ');
  chip.dataset.count = String(n);
  // Severity colour: red when many under-margin SKUs in under-margin mode, neutral otherwise.
  if (_tableMode === 'under-margin' && n > 0) {
    chip.classList.add('cc-count-chip--alert');
  } else {
    chip.classList.remove('cc-count-chip--alert');
  }
}

async function loadOffset() {
  const data = await AdminAPI.getGlobalOffset();
  _savedOffset = data;
  renderOffset(data);
}

function renderOffset(data) {
  const wrap = _el.querySelector('#cc-offset-wrap');
  if (!data) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not load offset data</div></div>';
    return;
  }
  const pct = (data.offset * 100).toFixed(1);
  const cls = data.offset > 0 ? 'positive' : data.offset < 0 ? 'negative' : 'zero';
  wrap.innerHTML = `
    <div class="cc-offset-slider">
      <span style="font-size:12px;color:var(--text-muted)">-5%</span>
      <input type="range" id="cc-offset-range" min="-0.05" max="0.05" step="0.005" value="${data.offset}">
      <span style="font-size:12px;color:var(--text-muted)">+5%</span>
      <span class="cc-offset-value cc-offset-value--${cls}" id="cc-offset-display">${pct > 0 ? '+' : ''}${pct}%</span>
    </div>
    <div class="cc-offset-meta">
      ${data.updated_at ? 'Last updated: ' + new Date(data.updated_at).toLocaleString('en-NZ') : ''}
      ${data.notes ? ' &middot; ' + esc(data.notes) : ''}
      ${data.updated_by ? ' &middot; by ' + esc(data.updated_by) : ''}
    </div>
  `;
  const range = wrap.querySelector('#cc-offset-range');
  const display = wrap.querySelector('#cc-offset-display');
  range.addEventListener('input', () => {
    const val = parseFloat(range.value);
    const p = (val * 100).toFixed(1);
    display.textContent = `${p > 0 ? '+' : ''}${p}%`;
    display.className = `cc-offset-value cc-offset-value--${val > 0 ? 'positive' : val < 0 ? 'negative' : 'zero'}`;
    clearTimeout(_sliderTimer);
    _sliderTimer = setTimeout(() => showOffsetConfirm(val), 500);
  });
}

// ---- Tier Multipliers ----
let _tierData = null;

async function loadTierMultipliers() {
  const wrap = _el.querySelector('#cc-tier-wrap');
  wrap.innerHTML = '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>';
  const data = await AdminAPI.getTierMultipliers();
  _tierData = data;
  renderTierMultipliers(data);
}

// Read-only display of the live effective tier multipliers, grouped by source.
// Editing lives in Control Center → Pricing (the Margin simulator), which
// previews impact + validates against the live bands before committing. This
// table used to expect a flat array, but the endpoint returns
// { defaults, overrides, effective } keyed by source — normalizeTierResponse
// handles every shape and fails loud on an unrecognised one.
function renderTierMultipliers(data) {
  const wrap = _el.querySelector('#cc-tier-wrap');
  const norm = normalizeTierResponse(data);
  const eff = norm.effective;
  if (!eff || !Object.keys(eff).length) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No tier multiplier data available</div></div>';
    return;
  }
  const SOURCE_LABEL = { genuine: 'Genuine', compatible: 'Compatible', ribbon: 'Ribbon' };
  const order = ['genuine', 'compatible', 'ribbon'].filter(s => eff[s]);
  for (const s of Object.keys(eff)) if (!order.includes(s)) order.push(s);

  let html = '';
  for (const src of order) {
    const map = eff[src] || {};
    const keys = sortTierKeys(Object.keys(map));
    if (!keys.length) continue;
    html += `<h4 class="cc-tier-source-heading">${esc(SOURCE_LABEL[src] || src)}</h4>
      <table class="admin-table" style="margin:0 0 12px">
        <thead><tr>
          <th>Tier (cost band)</th>
          <th style="text-align:right">Multiplier</th>
          <th style="text-align:right" title="Tier price uplift: (multiplier - 1) × 100. Not the same as product-level Markup % on the Products page.">Tier Multiplier Markup</th>
        </tr></thead><tbody>`;
    for (const name of keys) {
      const mult = Number(map[name]) || 1;
      const markup = ((mult - 1) * 100).toFixed(1);
      html += `<tr>
        <td class="cell-mono">${esc(name)}</td>
        <td style="text-align:right" class="cell-mono">${mult.toFixed(3)}</td>
        <td style="text-align:right" class="cell-mono">${markup}%</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  html += `<p class="admin-text-muted" style="font-size:13px;margin:4px 0 0">
    Edit these in <strong>Control Center → Pricing</strong> — the Margin simulator previews impact and validates against the live bands before saving.</p>`;
  wrap.innerHTML = html;
}

function showOffsetConfirm(offset) {
  if (_savedOffset && offset === _savedOffset.offset) return;
  const pct = (offset * 100).toFixed(1);
  const bodyHtml = `
    <p>Set global price offset to <strong>${pct > 0 ? '+' : ''}${pct}%</strong>?</p>
    <p style="font-size:13px;color:var(--text-muted);margin:8px 0">All product prices update automatically in the background (about a minute).</p>
    <div class="admin-form-group">
      <label>Notes (optional)</label>
      <input type="text" class="admin-input" id="cc-offset-notes" placeholder="e.g. Q2 margin boost" style="width:100%">
    </div>
  `;
  const m = Modal.open({
    title: 'Update Global Offset',
    body: bodyHtml,
    footer: `
      <button class="admin-btn admin-btn--ghost" id="cc-offset-cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" id="cc-offset-save">Save Offset</button>
    `,
  });
  m.footer.querySelector('#cc-offset-cancel').addEventListener('click', () => {
    m.close();
    renderOffset(_savedOffset);
  });
  m.footer.querySelector('#cc-offset-save').addEventListener('click', async () => {
    const notes = m.body.querySelector('#cc-offset-notes').value.trim();
    const saveBtn = m.footer.querySelector('#cc-offset-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      const data = await AdminAPI.updateGlobalOffset(offset, notes);
      handleRepriceResponse(data);
      m.close();
      await loadOffset();
    } catch (e) {
      Toast.error('Failed to update offset');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Offset';
    }
  });
  m.el.querySelector('.admin-modal').addEventListener('close', () => renderOffset(_savedOffset));
}

const COLUMNS = [
  { key: 'sku', label: 'SKU', render: (r) => `<span class="cell-mono">${esc(r.sku)}</span>` },
  { key: 'name', label: 'Product', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:220px">${esc(r.name)}</span>` },
  { key: 'brand', label: 'Brand', sortable: true },
  { key: 'cost_price', label: 'Cost', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${formatPrice(r.cost_price)}</span>` },
  { key: 'retail_price', label: 'Retail', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${formatPrice(r.retail_price)}</span>` },
  { key: 'net_margin', label: 'Margin%', align: 'right', sortable: true, render: (r) => {
    const color = r.net_margin < 5 ? 'var(--danger)' : r.net_margin < 15 ? 'var(--yellow)' : 'var(--success)';
    return `<span class="cell-mono" style="color:${color}">${r.net_margin.toFixed(1)}%</span>`;
  }},
  { key: 'gap', label: 'Gap', align: 'right', sortable: true, render: (r) => {
    return `<span class="cell-mono" style="color:var(--danger);font-weight:600">${r.gap.toFixed(1)}%</span>`;
  }},
];

export default {
  async init(el) {
    _el = el;
    _tablePage = 1;
    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title">Margin Heatmap</div>
        <div class="cc-source-toggle" id="cc-heatmap-toggle">
          <button class="cc-source-toggle__btn active" data-source="genuine">Genuine</button>
          <button class="cc-source-toggle__btn" data-source="compatible">Compatible</button>
        </div>
        <div class="cc-heatmap" id="cc-heatmap-grid"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title" style="display:flex;align-items:center;gap:8px">
          <span id="cc-margin-title">Under-Margin Products</span>
          <span class="cc-count-chip" id="cc-margin-count" title="Total products matching the current filter">—</span>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
          <div class="cc-source-toggle" id="cc-table-toggle">
            <button class="cc-source-toggle__btn active" data-source="genuine">Genuine</button>
            <button class="cc-source-toggle__btn" data-source="compatible">Compatible</button>
          </div>
          <div class="cc-source-toggle" id="cc-mode-toggle">
            <button class="cc-source-toggle__btn active" data-mode="under-margin">Under Margin</button>
            <button class="cc-source-toggle__btn" data-mode="all">All Products</button>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)">
            Min gap
            <select class="admin-input" id="cc-margin-min-gap" style="padding:4px 8px;font-size:13px;width:auto">
              <option value="0">All</option>
              <option value="1">≥ 1pp</option>
              <option value="3">≥ 3pp</option>
              <option value="5">≥ 5pp</option>
              <option value="10">≥ 10pp</option>
            </select>
          </label>
        </div>
        <div id="cc-under-margin-table"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Global Price Offset</div>
        <div class="admin-card cc-offset-card" id="cc-offset-wrap">
          <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
        </div>
      </div>
      <div class="cc-section" id="cc-tier-section">
        <div class="cc-section__title">Tier Price Multipliers</div>
        <div class="admin-card" id="cc-tier-wrap">
          <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
        </div>
      </div>
    `;

    // Heatmap source toggle
    el.querySelector('#cc-heatmap-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-source]');
      if (!btn || btn.dataset.source === _heatmapSource) return;
      _heatmapSource = btn.dataset.source;
      el.querySelectorAll('#cc-heatmap-toggle .cc-source-toggle__btn').forEach(b =>
        b.classList.toggle('active', b.dataset.source === _heatmapSource));
      loadHeatmap();
    });

    // Table source toggle
    el.querySelector('#cc-table-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-source]');
      if (!btn || btn.dataset.source === _tableSource) return;
      _tableSource = btn.dataset.source;
      _tablePage = 1;
      el.querySelectorAll('#cc-table-toggle .cc-source-toggle__btn').forEach(b =>
        b.classList.toggle('active', b.dataset.source === _tableSource));
      loadUnderMargin();
    });

    // Mode toggle (under-margin / all)
    el.querySelector('#cc-mode-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn || btn.dataset.mode === _tableMode) return;
      _tableMode = btn.dataset.mode;
      _tablePage = 1;
      el.querySelectorAll('#cc-mode-toggle .cc-source-toggle__btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === _tableMode));
      el.querySelector('#cc-margin-title').textContent =
        _tableMode === 'all' ? 'All Products \u2014 Margin View' : 'Under-Margin Products';
      loadUnderMargin();
    });

    // Min-gap filter (client-side narrowing of the current page)
    el.querySelector('#cc-margin-min-gap').addEventListener('change', (e) => {
      _tableMinGap = Number(e.target.value) || 0;
      loadUnderMargin();
    });

    // DataTable
    _table = new DataTable(el.querySelector('#cc-under-margin-table'), {
      columns: COLUMNS,
      rowKey: 'sku',
      emptyMessage: 'No under-margin products found',
      onPageChange: (page) => { _tablePage = page; loadUnderMargin(); },
      onSort: (key, dir) => { _tableSortBy = key; _tableSortOrder = dir; _tablePage = 1; loadUnderMargin(); },
    });

    // Load all sections in parallel
    await Promise.allSettled([loadHeatmap(), loadUnderMargin(), loadOffset(), loadTierMultipliers()]);
  },

  destroy() {
    clearTimeout(_sliderTimer);
    clearInterval(_repricePollTimer);
    if (_table) { _table.destroy(); _table = null; }
    _tierData = null;
    _el = null;
  },
};
