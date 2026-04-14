/**
 * Control Center — Tab 1: Profit & Pricing
 * Margin heatmap, under-margin products, global offset slider
 */
import { AdminAPI, AdminAuth, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

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
let _savedOffset = null;
let _sliderTimer = null;

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
  grid.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:120px"></div>';
  const data = await AdminAPI.getPricingHeatmap(_heatmapSource);
  renderHeatmap(data);
}

async function loadUnderMargin() {
  if (_table) _table.setLoading(true);
  const limit = _tableMode === 'all' ? 100 : 50;
  const resp = await AdminAPI.getUnderMarginProducts(_tableSource, _tablePage, limit, _tableMode, _tableSortBy, _tableSortOrder);
  if (!resp) { if (_table) _table.setData([], null); return; }
  const rows = resp.data || [];
  const meta = resp.metadata || {};
  if (_table) _table.setData(rows, { total: meta.total || rows.length, page: meta.page || _tablePage, limit });
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
  wrap.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:80px"></div>';
  const data = await AdminAPI.getTierMultipliers();
  _tierData = data;
  renderTierMultipliers(data);
}

function renderTierMultipliers(data) {
  const wrap = _el.querySelector('#cc-tier-wrap');
  if (!data || !Array.isArray(data) || !data.length) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No tier multiplier data available</div></div>';
    return;
  }
  const isOwner = AdminAuth.isOwner();
  let html = `<table class="admin-table" style="margin:0">
    <thead><tr>
      <th>Tier</th>
      <th style="text-align:right">Multiplier</th>
      <th style="text-align:right" title="Tier price uplift: (multiplier - 1) × 100. Not the same as product-level Markup % on the Products page.">Tier Multiplier Markup</th>
    </tr></thead><tbody>`;
  for (const tier of data) {
    const name = tier.tier_name || tier.tier || tier.name || '—';
    const mult = tier.multiplier ?? 1;
    const markup = ((mult - 1) * 100).toFixed(1);
    html += `<tr>
      <td>${esc(name)}</td>
      <td style="text-align:right">${isOwner
        ? `<input type="number" class="admin-input cc-tier-input" data-tier="${Security.escapeAttr(name)}" value="${mult}" step="0.01" min="0.5" max="5" style="width:80px;text-align:right;padding:4px 8px;font-size:13px">`
        : `<span class="cell-mono">${mult.toFixed(2)}</span>`}</td>
      <td style="text-align:right"><span class="cell-mono cc-tier-markup" data-tier="${Security.escapeAttr(name)}">${markup}%</span></td>
    </tr>`;
  }
  html += '</tbody></table>';
  if (isOwner) {
    html += `<div style="margin-top:12px;text-align:right">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="cc-tier-save" disabled>Save Multipliers</button>
    </div>`;
  }
  wrap.innerHTML = html;

  if (isOwner) {
    // Live markup preview + enable save on change
    wrap.querySelectorAll('.cc-tier-input').forEach(input => {
      input.addEventListener('input', () => {
        const val = parseFloat(input.value) || 1;
        const markupEl = wrap.querySelector(`.cc-tier-markup[data-tier="${input.dataset.tier}"]`);
        if (markupEl) markupEl.textContent = ((val - 1) * 100).toFixed(1) + '%';
        wrap.querySelector('#cc-tier-save').disabled = false;
      });
    });
    wrap.querySelector('#cc-tier-save').addEventListener('click', saveTierMultipliers);
  }
}

function saveTierMultipliers() {
  const inputs = _el.querySelectorAll('.cc-tier-input');
  const multipliers = {};
  inputs.forEach(input => { multipliers[input.dataset.tier] = parseFloat(input.value) || 1; });

  const summary = Object.entries(multipliers).map(([t, m]) => `${t}: ${m.toFixed(2)}`).join(', ');
  const m = Modal.open({
    title: 'Update Tier Multipliers',
    body: `<p>Set the following tier multipliers?</p>
      <p style="font-size:13px;color:var(--text-muted);margin:8px 0">${esc(summary)}</p>
      <p style="font-size:13px;color:var(--text-muted)">Changes take effect on the next price recalculation.</p>`,
    footer: `
      <button class="admin-btn admin-btn--ghost" id="cc-tier-cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" id="cc-tier-confirm">Save</button>
    `,
  });
  m.footer.querySelector('#cc-tier-cancel').addEventListener('click', () => m.close());
  m.footer.querySelector('#cc-tier-confirm').addEventListener('click', async () => {
    const btn = m.footer.querySelector('#cc-tier-confirm');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      await AdminAPI.updateTierMultipliers(multipliers);
      Toast.success('Tier multipliers updated');
      m.close();
      await loadTierMultipliers();
    } catch (e) {
      Toast.error('Failed to update multipliers');
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
}

function showOffsetConfirm(offset) {
  if (_savedOffset && offset === _savedOffset.offset) return;
  const pct = (offset * 100).toFixed(1);
  const bodyHtml = `
    <p>Set global price offset to <strong>${pct > 0 ? '+' : ''}${pct}%</strong>?</p>
    <p style="font-size:13px;color:var(--text-muted);margin:8px 0">This affects all product prices on the next import run.</p>
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
      await AdminAPI.updateGlobalOffset(offset, notes);
      Toast.success('Global offset updated');
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
        <div class="cc-section__title" id="cc-margin-title">Under-Margin Products</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
          <div class="cc-source-toggle" id="cc-table-toggle">
            <button class="cc-source-toggle__btn active" data-source="genuine">Genuine</button>
            <button class="cc-source-toggle__btn" data-source="compatible">Compatible</button>
          </div>
          <div class="cc-source-toggle" id="cc-mode-toggle">
            <button class="cc-source-toggle__btn active" data-mode="under-margin">Under Margin</button>
            <button class="cc-source-toggle__btn" data-mode="all">All Products</button>
          </div>
        </div>
        <div id="cc-under-margin-table"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Global Price Offset</div>
        <div class="admin-card cc-offset-card" id="cc-offset-wrap">
          <div class="admin-skeleton admin-skeleton--kpi"></div>
        </div>
      </div>
      <div class="cc-section" id="cc-tier-section">
        <div class="cc-section__title">Tier Price Multipliers</div>
        <div class="admin-card" id="cc-tier-wrap">
          <div class="admin-skeleton admin-skeleton--kpi" style="height:80px"></div>
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
    if (_table) { _table.destroy(); _table = null; }
    _tierData = null;
    _el = null;
  },
};
