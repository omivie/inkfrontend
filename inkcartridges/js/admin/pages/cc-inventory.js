/**
 * Control Center — Tab 3: Inventory & Supplier Health
 * Import status cards, price discrepancies, reconciliation trigger
 */
import { AdminAPI, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { importFeedsHtml } from '../utils/importStatus.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;

let _el = null;
let _table = null;
let _page = 1;
let _minChangePct = 20;
let _days = 30;

// One renderer for supplier feed health, shared with Site Health → Infra
// (which is where it is reachable from the navigation). It reads the last 5
// runs, not `latest` alone — see utils/importStatus.js (BF-070 h).
function renderImportCards(data) {
  const wrap = _el.querySelector('#cc-import-cards');
  wrap.innerHTML = importFeedsHtml(data, esc);
}

const COLUMNS = [
  { key: 'sku', label: 'SKU', render: (r) => `<span class="cell-mono">${esc(r.sku)}</span>` },
  { key: 'name', label: 'Product', sortable: true, render: (r) => `<span class="cell-truncate" style="max-width:200px">${esc(r.name)}</span>` },
  { key: 'old_price', label: 'Old Price', align: 'right', render: (r) => `<span class="cell-mono">${formatPrice(r.old_price)}</span>` },
  { key: 'new_price', label: 'New Price', align: 'right', render: (r) => `<span class="cell-mono">${formatPrice(r.new_price)}</span>` },
  { key: 'change_pct', label: 'Change %', align: 'right', sortable: true, render: (r) => {
    const abs = Math.abs(r.change_pct).toFixed(1);
    const color = Math.abs(r.change_pct) > 50 ? 'var(--danger)' : Math.abs(r.change_pct) > 20 ? 'var(--yellow)' : 'var(--text)';
    const arrow = r.change_pct > 0 ? '\u2191' : '\u2193';
    return `<span class="cell-mono" style="color:${color};font-weight:600">${arrow} ${abs}%</span>`;
  }},
  { key: 'detected_at', label: 'Detected', render: (r) => r.detected_at
    ? `<span class="cell-muted">${new Date(r.detected_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}</span>`
    : '\u2014'
  },
];

async function loadDiscrepancies() {
  if (_table) _table.setLoading(true);
  const resp = await AdminAPI.getPriceDiscrepancies({
    min_change_pct: _minChangePct,
    days: _days,
    page: _page,
    limit: 50,
  });
  if (!resp) { if (_table) _table.setData([], null); return; }
  const rows = resp.data || [];
  const meta = resp.metadata || {};
  if (_table) _table.setData(rows, { total: meta.total || rows.length, page: _page, limit: 50 });
}

async function handleReconcile(btn) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.innerHTML = '<div class="admin-loading__spinner" style="width:16px;height:16px;display:inline-block;vertical-align:middle;margin-right:6px"></div>Running...';
  try {
    const data = await AdminAPI.triggerReconcile();
    if (data?.summary) {
      Toast.success(`Reconciliation complete: ${data.summary.overpriced || 0} overpriced, ${data.summary.underpriced || 0} underpriced, ${data.summary.matched || 0} matched`);
    } else {
      Toast.success('Reconciliation triggered');
    }
    btn.textContent = origText;
    btn.disabled = false;
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('409') || e.status === 409) {
      Toast.warning('Reconciliation already in progress');
    } else {
      Toast.error('Failed to start reconciliation');
    }
    btn.textContent = origText;
    btn.disabled = false;
  }
}

export default {
  async init(el) {
    _el = el;
    _page = 1;
    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title">Import Status</div>
        <div class="cc-import-cards" id="cc-import-cards">
          <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
        </div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Price Discrepancies</div>
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--text-muted)">Min change:</label>
          <select class="admin-select" id="cc-discrep-pct" style="width:90px">
            <option value="10">10%</option>
            <option value="20" selected>20%</option>
            <option value="30">30%</option>
            <option value="50">50%</option>
          </select>
          <label style="font-size:12px;color:var(--text-muted)">Days:</label>
          <select class="admin-select" id="cc-discrep-days" style="width:80px">
            <option value="7">7</option>
            <option value="14">14</option>
            <option value="30" selected>30</option>
            <option value="90">90</option>
          </select>
        </div>
        <div id="cc-discrep-table"></div>
      </div>
      <div class="cc-section cc-reconcile-wrap">
        <div class="cc-section__title">Trigger Reconciliation</div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:0.75rem">
          Compare supplier prices against current retail prices. This may take up to 30 minutes.
        </p>
        <button class="admin-btn admin-btn--primary" id="cc-reconcile-btn">Run Price Reconciliation</button>
      </div>
    `;

    // Filter change handlers
    el.querySelector('#cc-discrep-pct').addEventListener('change', (e) => {
      _minChangePct = parseInt(e.target.value);
      _page = 1;
      loadDiscrepancies();
    });
    el.querySelector('#cc-discrep-days').addEventListener('change', (e) => {
      _days = parseInt(e.target.value);
      _page = 1;
      loadDiscrepancies();
    });

    // Reconcile button
    el.querySelector('#cc-reconcile-btn').addEventListener('click', function() {
      handleReconcile(this);
    });

    // DataTable
    _table = new DataTable(el.querySelector('#cc-discrep-table'), {
      columns: COLUMNS,
      rowKey: 'sku',
      emptyMessage: 'No price discrepancies found',
      onPageChange: (page) => { _page = page; loadDiscrepancies(); },
    });

    // Load data
    const [importData] = await Promise.allSettled([
      AdminAPI.getSupplierImportStatus(),
      loadDiscrepancies(),
    ]);
    renderImportCards(importData.status === 'fulfilled' ? importData.value : null);
  },

  destroy() {
    if (_table) { _table.destroy(); _table = null; }
    _el = null;
  },
};
