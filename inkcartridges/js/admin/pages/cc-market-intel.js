/**
 * Control Center — Tab: Market Intel
 * Competitive summary, overpriced products, price discrepancies, price-match
 */
import { AdminAPI, AdminAuth, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;

let _el = null;
let _overpricedTable = null;
let _discrepancyTable = null;
let _overpricedPage = 1;
let _overpricedBrand = '';
let _minVariance = 15;

// ---- Competitive Summary (KPI cards) ----
async function loadReport() {
  const grid = _el.querySelector('#mi-report-grid');
  grid.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:80px"></div>'.repeat(4);
  const data = await AdminAPI.getMarketIntelReport();
  if (!data) {
    grid.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not load market report</div></div>';
    return;
  }
  if (data._empty) {
    grid.innerHTML = `<div class="admin-empty"><div class="admin-empty__text">${esc(data._hint)}</div></div>`;
    return;
  }
  const kpi = (label, value, color) =>
    `<div class="admin-kpi"><div class="admin-kpi__label">${esc(label)}</div><div class="admin-kpi__value" style="${color ? `color:${color}` : ''}">${value}</div></div>`;

  grid.innerHTML = [
    kpi('Avg Price Gap', data.avg_price_gap != null ? `${Number(data.avg_price_gap).toFixed(1)}%` : '—'),
    kpi('Overpriced Products', data.overpriced_count ?? data.total_overpriced ?? '—', 'var(--danger)'),
    kpi('Underpriced Products', data.underpriced_count ?? data.total_underpriced ?? '—', 'var(--success)'),
    kpi('Market Coverage', data.coverage != null ? `${Number(data.coverage).toFixed(0)}%` : (data.products_tracked ?? '—')),
  ].join('');
}

// ---- Overpriced Products Table ----
const OVERPRICED_COLS = [
  { key: 'sku', label: 'SKU', render: (r) => `<span class="cell-mono">${esc(r.sku)}</span>` },
  { key: 'name', label: 'Product', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:200px">${esc(r.name || r.product_name || '')}</span>` },
  { key: 'brand', label: 'Brand', sortable: true },
  { key: 'our_price', label: 'Our Price', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${formatPrice(r.our_price ?? r.retail_price)}</span>` },
  { key: 'market_price', label: 'Market Price', align: 'right', sortable: true, render: (r) => `<span class="cell-mono">${formatPrice(r.market_price ?? r.competitor_price)}</span>` },
  { key: 'variance', label: 'Variance', align: 'right', sortable: true, render: (r) => {
    const v = r.variance ?? r.variance_pct ?? r.price_gap;
    return `<span class="cell-mono" style="color:var(--danger);font-weight:600">${v != null ? `+${Number(v).toFixed(1)}%` : '—'}</span>`;
  }},
];

async function loadOverpriced() {
  if (_overpricedTable) _overpricedTable.setLoading(true);
  const data = await AdminAPI.getOverpricedProducts(_overpricedPage, 50, _overpricedBrand);
  if (!data) { if (_overpricedTable) _overpricedTable.setData([], null); return; }
  const rows = data.products || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_overpricedTable) _overpricedTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _overpricedPage, limit: 50 });
}

function showMatchPriceModal(row) {
  const sku = row.sku;
  const marketPrice = row.market_price ?? row.competitor_price ?? 0;
  const m = Modal.open({
    title: 'Match Competitor Price',
    body: `
      <p>Match price for <strong>${esc(row.name || row.product_name || sku)}</strong></p>
      <p style="font-size:13px;color:var(--text-muted);margin:8px 0">Current: ${formatPrice(row.our_price ?? row.retail_price)} &middot; Market: ${formatPrice(marketPrice)}</p>
      <div class="admin-form-group">
        <label>Target Price (NZD)</label>
        <input type="number" class="admin-input" id="mi-match-price" value="${marketPrice}" step="0.01" min="0" style="width:100%">
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" id="mi-match-cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" id="mi-match-save">Match Price</button>
    `,
  });
  m.footer.querySelector('#mi-match-cancel').addEventListener('click', () => m.close());
  m.footer.querySelector('#mi-match-save').addEventListener('click', async () => {
    const price = parseFloat(m.body.querySelector('#mi-match-price').value);
    if (!price || price <= 0) { Toast.warning('Enter a valid price'); return; }
    const btn = m.footer.querySelector('#mi-match-save');
    btn.disabled = true;
    btn.textContent = 'Matching...';
    try {
      await AdminAPI.matchPrice(sku, price);
      Toast.success(`Price matched for ${sku}`);
      m.close();
      loadOverpriced();
    } catch (e) {
      Toast.error(`Price match failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Match Price';
    }
  });
}

// ---- Price Discrepancies Table ----
const DISCREPANCY_COLS = [
  { key: 'sku', label: 'SKU', render: (r) => `<span class="cell-mono">${esc(r.sku)}</span>` },
  { key: 'name', label: 'Product', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:200px">${esc(r.name || r.product_name || '')}</span>` },
  { key: 'our_price', label: 'Our Price', align: 'right', render: (r) => `<span class="cell-mono">${formatPrice(r.our_price ?? r.retail_price)}</span>` },
  { key: 'competitor_price', label: 'Competitor', align: 'right', render: (r) => `<span class="cell-mono">${formatPrice(r.competitor_price ?? r.market_price)}</span>` },
  { key: 'variance', label: 'Variance', align: 'right', sortable: true, render: (r) => {
    const v = r.variance ?? r.variance_pct ?? r.price_gap;
    const color = v > 0 ? 'var(--danger)' : 'var(--success)';
    return `<span class="cell-mono" style="color:${color};font-weight:600">${v != null ? `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—'}</span>`;
  }},
];

async function loadDiscrepancies() {
  if (_discrepancyTable) _discrepancyTable.setLoading(true);
  const data = await AdminAPI.getMarketDiscrepancies(_minVariance);
  if (!data) { if (_discrepancyTable) _discrepancyTable.setData([], null); return; }
  const rows = data.products || data.items || data.data || (Array.isArray(data) ? data : []);
  if (_discrepancyTable) _discrepancyTable.setData(rows, null);
}

export default {
  async init(el) {
    _el = el;
    _overpricedPage = 1;
    _overpricedBrand = '';
    _minVariance = 15;

    const isOwner = AdminAuth.isOwner();

    // Add action column for price-match (owner only)
    const overpricedCols = [...OVERPRICED_COLS];
    if (isOwner) {
      overpricedCols.push({
        key: '_actions', label: '', align: 'right',
        render: (r) => `<button class="admin-btn admin-btn--xs admin-btn--primary mi-match-btn" data-sku="${Security.escapeAttr(r.sku)}">Match</button>`,
      });
    }

    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title">Competitive Summary</div>
        <div class="admin-kpi-grid admin-kpi-grid--4" id="mi-report-grid"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Overpriced Products</div>
        <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center">
          <select class="admin-select" id="mi-brand-filter" style="min-width:140px;padding:5px 10px;font-size:13px">
            <option value="">All Brands</option>
          </select>
        </div>
        <div id="mi-overpriced-table"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Price Discrepancies</div>
        <div style="margin-bottom:10px;display:flex;gap:10px;align-items:center">
          <label style="font-size:13px;color:var(--text-muted)">Min variance:</label>
          <input type="number" class="admin-input" id="mi-variance-input" value="${_minVariance}" min="1" max="100" step="1" style="width:70px;padding:4px 8px;font-size:13px">
          <span style="font-size:13px;color:var(--text-muted)">%</span>
        </div>
        <div id="mi-discrepancy-table"></div>
      </div>
    `;

    // Brand filter
    const brandSelect = el.querySelector('#mi-brand-filter');
    try {
      const brands = await AdminAPI.getBrands();
      if (brands && Array.isArray(brands)) {
        for (const b of brands) {
          const name = typeof b === 'string' ? b : b.name || b.brand || String(b);
          brandSelect.insertAdjacentHTML('beforeend', `<option value="${Security.escapeAttr(name)}">${esc(name)}</option>`);
        }
      }
    } catch (_) { /* brands optional */ }

    brandSelect.addEventListener('change', () => {
      _overpricedBrand = brandSelect.value;
      _overpricedPage = 1;
      loadOverpriced();
    });

    // Variance threshold
    let varianceTimer;
    el.querySelector('#mi-variance-input').addEventListener('input', (e) => {
      clearTimeout(varianceTimer);
      varianceTimer = setTimeout(() => {
        _minVariance = parseInt(e.target.value, 10) || 15;
        loadDiscrepancies();
      }, 400);
    });

    // Tables
    _overpricedTable = new DataTable(el.querySelector('#mi-overpriced-table'), {
      columns: overpricedCols,
      rowKey: 'sku',
      emptyMessage: 'No overpriced products found',
      onPageChange: (page) => { _overpricedPage = page; loadOverpriced(); },
    });

    _discrepancyTable = new DataTable(el.querySelector('#mi-discrepancy-table'), {
      columns: DISCREPANCY_COLS,
      rowKey: 'sku',
      emptyMessage: 'No discrepancies above threshold',
    });

    // Match button delegation
    if (isOwner) {
      el.querySelector('#mi-overpriced-table').addEventListener('click', (e) => {
        const btn = e.target.closest('.mi-match-btn');
        if (!btn) return;
        const sku = btn.dataset.sku;
        const rows = _overpricedTable?.data || [];
        const row = rows.find(r => r.sku === sku);
        if (row) showMatchPriceModal(row);
      });
    }

    // Load all sections
    await Promise.allSettled([loadReport(), loadOverpriced(), loadDiscrepancies()]);
  },

  destroy() {
    if (_overpricedTable) { _overpricedTable.destroy(); _overpricedTable = null; }
    if (_discrepancyTable) { _discrepancyTable.destroy(); _discrepancyTable = null; }
    _el = null;
  },

  onSearch(query) {
    // Could filter overpriced table by product name — for now, no-op
  },
};
