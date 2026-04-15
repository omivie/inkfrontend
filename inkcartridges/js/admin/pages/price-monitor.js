/**
 * Price Monitor Page — Competitor prices, margin floor alerts, bulk repricing
 */
import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';
const MAX_BULK = 200;

const SORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'price_asc', label: 'Price \u2191' },
  { value: 'price_desc', label: 'Price \u2193' },
  { value: 'margin_gap_asc', label: 'Margin gap \u2191' },
  { value: 'margin_gap_desc', label: 'Margin gap \u2193' },
  { value: 'name_asc', label: 'Name A\u2013Z' },
];

let _container = null;
let _table = null;
let _summary = null;
let _competitors = []; // inferred from first page of products
let _page = 1;
let _limit = 25;
let _search = '';
let _brand = '';
let _source = '';
let _sort = '';
let _marginAlertOnly = false;
let _oosOnly = false;
let _brandOptions = [];
let _sourceOptions = [];
let _selected = new Set();
let _searchDebounce = null;

function inferCompetitors(rows) {
  // Collect competitor keys from rows. Each row expected to have `competitors`
  // as either object keyed by competitor name, or an array of {name, price, available, is_stale}.
  const seen = new Map();
  for (const r of rows) {
    const c = r.competitors;
    if (!c) continue;
    if (Array.isArray(c)) {
      for (const x of c) if (x?.name && !seen.has(x.name)) seen.set(x.name, x.name);
    } else if (typeof c === 'object') {
      for (const k of Object.keys(c)) if (!seen.has(k)) seen.set(k, k);
    }
  }
  return Array.from(seen.keys());
}

function getCompetitor(row, name) {
  const c = row.competitors;
  if (!c) return null;
  if (Array.isArray(c)) return c.find(x => x?.name === name) || null;
  return c[name] || null;
}

function renderCompetitorCell(cell) {
  if (!cell || cell.price == null) return `<span class="pm-competitor--unavailable">${MISSING}</span>`;
  const staleCls = cell.is_stale ? ' pm-competitor--stale' : '';
  let availCls = '';
  let availTip = '';
  if (cell.available === false) { availCls = ' pm-competitor--oos'; availTip = 'Out of stock'; }
  else if (cell.available == null) { availCls = ' pm-competitor--unknown'; availTip = 'Stock unknown'; }
  const tips = [];
  if (cell.is_stale) tips.push('Stale data');
  if (availTip) tips.push(availTip);
  const tip = tips.length ? `data-tooltip="${esc(tips.join(' \u00b7 '))}"` : '';
  return `<span class="cell-mono${staleCls}${availCls}" ${tip}>${formatPrice(cell.price)}</span>`;
}

function buildColumns(isOwner) {
  const cols = [
    {
      key: 'name', label: 'Product',
      render: (r) => {
        const name = esc(r.name || r.product_name || MISSING);
        const sku = esc(r.sku || '');
        return `<div><div class="cell-truncate">${name}</div><div class="cell-mono admin-text-muted" style="font-size:0.72rem;">${sku}</div></div>`;
      },
    },
    {
      key: 'our_price', label: 'Our price', sortable: true, align: 'right',
      render: (r) => {
        const price = r.our_price ?? r.retail_price;
        const txt = price != null ? formatPrice(price) : MISSING;
        if (!isOwner) return `<span class="cell-mono cell-right">${txt}</span>`;
        return `<span class="cell-mono cell-right">${txt}</span> <button class="pm-edit-price admin-btn--ghost admin-btn--sm" data-sku="${esc(r.sku || '')}" data-price="${price ?? ''}" title="Edit price">${icon('copy', 12, 12)}</button>`;
      },
    },
  ];

  for (const comp of _competitors) {
    cols.push({
      key: `comp_${comp}`, label: comp, align: 'right',
      render: (r) => `<span class="cell-right">${renderCompetitorCell(getCompetitor(r, comp))}</span>`,
    });
  }

  cols.push(
    {
      key: 'market_lowest', label: 'Lowest', align: 'right',
      render: (r) => {
        if (r.market_lowest == null) return MISSING;
        const src = r.market_lowest_source ? `<div class="admin-text-muted" style="font-size:0.7rem;">${esc(r.market_lowest_source)}</div>` : '';
        const oosWarn = r.market_lowest_available === false ? ' <span class="admin-badge admin-badge--failed" style="font-size:0.65rem;">OOS</span>' : '';
        return `<div class="cell-right"><span class="cell-mono" style="font-weight:600;">${formatPrice(r.market_lowest)}</span>${oosWarn}${src}</div>`;
      },
    },
    {
      key: 'margin_floor_price', label: 'Floor', align: 'right',
      render: (r) => r.margin_floor_price != null
        ? `<span class="cell-mono cell-right admin-text-muted">${formatPrice(r.margin_floor_price)}</span>`
        : MISSING,
    },
    {
      key: 'gap', label: 'Gap', sortable: true, align: 'right',
      render: (r) => {
        const our = r.our_price ?? r.retail_price;
        const gap = r.gap != null ? r.gap
          : (our != null && r.market_lowest != null) ? (r.market_lowest - our) : null;
        if (gap == null) return MISSING;
        const cls = gap < 0 ? 'pm-gap--negative' : 'pm-gap--positive';
        const sign = gap > 0 ? '+' : '';
        return `<span class="cell-mono cell-right ${cls}">${sign}${formatPrice(gap)}</span>`;
      },
    },
    {
      key: 'estimated_margin_pct', label: 'Margin %', sortable: true, align: 'right',
      render: (r) => {
        const m = r.estimated_margin_pct ?? r.margin_pct;
        if (m == null) return MISSING;
        const cls = r.margin_alert ? 'pm-margin pm-margin--below' : 'pm-margin';
        return `<span class="cell-mono cell-right ${cls}">${Number(m).toFixed(1)}%</span>`;
      },
    },
  );

  return cols;
}

async function loadProducts() {
  if (!_table) return;
  _table.setLoading(true);
  const resp = await AdminAPI.priceMonitor.getProducts({
    page: _page, limit: _limit,
    search: _search, brand: _brand, source: _source, sort: _sort,
    margin_alert: _marginAlertOnly || undefined,
    out_of_stock_cheapest: _oosOnly || undefined,
  });
  if (!resp) { _table.setData([], null); return; }

  const rows = resp.data || [];
  const meta = resp.meta || {};

  // Infer competitor columns once (first load with rows)
  if (!_competitors.length && rows.length) {
    _competitors = inferCompetitors(rows);
    _table.config.columns = buildColumns(AdminAuth.isOwner());
  }

  // Populate filter dropdown options opportunistically
  if (meta.brands && !_brandOptions.length) _brandOptions = meta.brands;
  if (meta.sources && !_sourceOptions.length) _sourceOptions = meta.sources;
  refreshFilterOptions();

  _table.setData(rows, { page: meta.page || _page, limit: meta.limit || _limit, total: meta.total || rows.length });

  // Paint below-floor row backgrounds
  _container.querySelectorAll('tbody tr').forEach((tr, i) => {
    if (rows[i]?.margin_alert) tr.classList.add('pm-row--below-floor');
  });

  // Bind inline price edit
  _container.querySelectorAll('.pm-edit-price').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleInlinePriceEdit(btn.dataset.sku, btn.dataset.price);
    });
  });
}

async function handleInlinePriceEdit(sku, currentPrice) {
  if (!AdminAuth.isOwner() || !sku) return;
  const input = window.prompt(`New price for ${sku} (NZD):`, currentPrice || '');
  if (input == null) return;
  const target = parseFloat(input);
  if (!Number.isFinite(target) || target <= 0) {
    Toast.error('Invalid price');
    return;
  }
  try {
    await AdminAPI.priceMonitor.updatePrice(sku, target);
    Toast.success(`Price updated: ${sku} \u2192 ${formatPrice(target)}`);
    loadProducts();
  } catch (e) {
    Toast.error(e.message || 'Update failed');
  }
}

async function runBulkAction(action, undercutAmount) {
  const ids = Array.from(_selected);
  if (!ids.length) { Toast.error('Select at least one product'); return; }
  if (ids.length > MAX_BULK) { Toast.error(`Max ${MAX_BULK} products per bulk action`); return; }

  const verb = action === 'match_cheapest' ? 'match the cheapest competitor' : `undercut by ${formatPrice(undercutAmount)}`;
  const ok = await Modal.confirm({
    title: 'Confirm bulk action',
    message: `Apply "${verb}" to ${ids.length} product${ids.length !== 1 ? 's' : ''}?`,
    confirmLabel: 'Apply',
    danger: true,
  }).catch(() => false);
  if (!ok) return;

  try {
    const payload = { action, product_ids: ids };
    if (action === 'undercut') payload.undercut_amount = undercutAmount;
    const result = await AdminAPI.priceMonitor.bulkAction(payload);
    const updated = result?.updated ?? ids.length;
    Toast.success(`Updated ${updated} product${updated !== 1 ? 's' : ''}`);
    _selected.clear();
    _table.clearSelection();
    updateBulkBar();
    loadProducts();
  } catch (e) {
    Toast.error(e.message || 'Bulk action failed');
  }
}

function updateBulkBar() {
  const bar = _container.querySelector('#pm-bulk-bar');
  if (!bar) return;
  const count = _selected.size;
  bar.classList.toggle('pm-bulk-bar--visible', count > 0);
  const countEl = bar.querySelector('.pm-bulk-count');
  if (countEl) countEl.textContent = String(count);
  const over = count > MAX_BULK;
  bar.querySelectorAll('button[data-bulk-action]').forEach(b => { b.disabled = over; });
  const warn = bar.querySelector('.pm-bulk-warn');
  if (warn) warn.textContent = over ? `Max ${MAX_BULK} per action` : '';
}

function refreshFilterOptions() {
  const brandSel = _container.querySelector('#pm-brand');
  const sourceSel = _container.querySelector('#pm-source');
  if (brandSel && _brandOptions.length && brandSel.options.length <= 1) {
    for (const b of _brandOptions) {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      brandSel.appendChild(opt);
    }
    brandSel.value = _brand;
  }
  if (sourceSel && _sourceOptions.length && sourceSel.options.length <= 1) {
    for (const s of _sourceOptions) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sourceSel.appendChild(opt);
    }
    sourceSel.value = _source;
  }
}

async function renderSummaryStrip() {
  const strip = _container.querySelector('#pm-summary');
  if (!strip) return;
  _summary = await AdminAPI.priceMonitor.getScrapeStatus();
  if (!_summary) {
    strip.innerHTML = '<div class="admin-text-muted">Scrape status unavailable</div>';
    return;
  }

  const competitors = _summary.scrapers || _summary.competitors || [];
  const alertCount = _summary.margin_alert_count ?? _summary.below_floor_count ?? _summary.margin_alerts ?? 0;

  let html = '<div class="pm-summary__chips">';
  for (const c of competitors) {
    const ok = c.status === 'ok' || c.healthy === true || c.green === true;
    const cls = ok ? 'pm-health-dot--green' : 'pm-health-dot--red';
    const lastRun = c.last_run || c.last_scraped_at;
    const tip = lastRun ? `data-tooltip="Last: ${esc(lastRun)}"` : '';
    html += `<span class="pm-health-chip" ${tip}><span class="pm-health-dot ${cls}"></span>${esc(c.name || '?')}</span>`;
  }
  html += '</div>';

  html += `<button class="pm-alert-card${alertCount > 0 ? ' pm-alert-card--warn' : ''}" id="pm-floor-toggle">
    <div class="pm-alert-card__count">${alertCount}</div>
    <div class="pm-alert-card__label">margin alerts</div>
  </button>`;

  strip.innerHTML = html;

  strip.querySelector('#pm-floor-toggle')?.addEventListener('click', () => {
    _marginAlertOnly = !_marginAlertOnly;
    _container.querySelector('#pm-alert-chip')?.classList.toggle('filter-chip--active', _marginAlertOnly);
    _page = 1;
    loadProducts();
  });
}

async function renderExportsPanel() {
  const panel = _container.querySelector('#pm-exports-list');
  if (!panel) return;
  panel.innerHTML = '<div class="admin-text-muted">Loading exports\u2026</div>';
  const files = await AdminAPI.priceMonitor.listExports();
  if (!files.length) {
    panel.innerHTML = '<div class="admin-text-muted">No exports available</div>';
    return;
  }
  let html = '<ul class="pm-exports">';
  for (const f of files) {
    const name = esc(f.filename || f.name || '');
    const size = f.size ? `${(f.size / 1024).toFixed(1)} KB` : '';
    const when = esc(f.generated_at || f.modified_at || '');
    html += `<li class="pm-exports__item">
      <div class="pm-exports__meta">
        <span class="cell-mono">${name}</span>
        <span class="admin-text-muted" style="font-size:0.75rem;">${when} ${size}</span>
      </div>
      <button class="admin-btn admin-btn--sm pm-download-btn" data-filename="${name}">${icon('download', 14, 14)} Download</button>
    </li>`;
  }
  html += '</ul>';
  panel.innerHTML = html;

  panel.querySelectorAll('.pm-download-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await AdminAPI.priceMonitor.downloadExport(btn.dataset.filename);
      } catch (e) {
        Toast.error(e.message || 'Download failed');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderShell() {
  const isOwner = AdminAuth.isOwner();
  const sortOpts = SORT_OPTIONS.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');

  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1 class="admin-page-title">Price Monitor</h1>
        <p class="admin-page-subtitle">Competitor prices, margin floor alerts, bulk repricing.</p>
      </div>
    </div>

    <div class="admin-card pm-summary" id="pm-summary">
      <div class="admin-text-muted">Loading summary\u2026</div>
    </div>

    <div class="admin-filter-bar pm-filter-bar">
      <input type="search" class="admin-input" id="pm-search" placeholder="Search SKU or name\u2026" autocomplete="off">
      <select class="admin-input" id="pm-brand"><option value="">All brands</option></select>
      <select class="admin-input" id="pm-source">
        <option value="">All sources</option>
        <option value="genuine">Genuine</option>
        <option value="compatible">Compatible</option>
      </select>
      <select class="admin-input" id="pm-sort">${sortOpts}</select>
      <button class="filter-chip" id="pm-alert-chip" type="button">Margin alert only</button>
      <button class="filter-chip" id="pm-oos-chip" type="button">Cheapest is OOS</button>
    </div>

    ${isOwner ? `
    <div class="pm-bulk-bar" id="pm-bulk-bar">
      <span><strong class="pm-bulk-count">0</strong> selected <span class="pm-bulk-warn admin-text-danger"></span></span>
      <button class="admin-btn admin-btn--sm" data-bulk-action="match_cheapest" type="button">Match cheapest</button>
      <div class="pm-undercut">
        <label for="pm-undercut-amt" class="admin-text-muted">Undercut by $</label>
        <input type="number" step="0.01" min="0" value="0.50" id="pm-undercut-amt" class="admin-input admin-input--sm">
        <button class="admin-btn admin-btn--sm admin-btn--primary" data-bulk-action="undercut" type="button">Apply undercut</button>
      </div>
    </div>` : ''}

    <div id="pm-table"></div>

    <details class="admin-card pm-exports-panel">
      <summary>CSV Exports</summary>
      <div style="display:flex;justify-content:flex-end;padding:0.5rem 0;">
        ${isOwner ? '<button class="admin-btn admin-btn--sm admin-btn--primary" id="pm-generate-export" type="button">Generate CSV now</button>' : ''}
      </div>
      <div id="pm-exports-list" style="padding:0.5rem 0;"></div>
    </details>
  `;

  _table = new DataTable(_container.querySelector('#pm-table'), {
    columns: buildColumns(isOwner),
    rowKey: 'id',
    selectable: isOwner,
    emptyMessage: 'No products match your filters',
    onSelectionChange: (sel) => {
      _selected = new Set(sel);
      updateBulkBar();
    },
    onPageChange: (p) => { _page = p; loadProducts(); },
    onLimitChange: (l) => { _limit = l; _page = 1; loadProducts(); },
  });

  bindFilterEvents();
  bindBulkEvents();

  _container.querySelector('#pm-generate-export')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await AdminAPI.priceMonitor.generateExport();
      Toast.success('CSV generated');
      renderExportsPanel();
    } catch (err) {
      Toast.error(err.message || 'Generate failed');
    } finally {
      btn.disabled = false;
    }
  });
}

function bindFilterEvents() {
  const search = _container.querySelector('#pm-search');
  search.addEventListener('input', () => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _search = search.value.trim();
      _page = 1;
      loadProducts();
    }, 300);
  });
  _container.querySelector('#pm-brand').addEventListener('change', (e) => {
    _brand = e.target.value; _page = 1; loadProducts();
  });
  _container.querySelector('#pm-source').addEventListener('change', (e) => {
    _source = e.target.value; _page = 1; loadProducts();
  });
  _container.querySelector('#pm-sort').addEventListener('change', (e) => {
    _sort = e.target.value; _page = 1; loadProducts();
  });
  _container.querySelector('#pm-alert-chip').addEventListener('click', (e) => {
    _marginAlertOnly = !_marginAlertOnly;
    e.currentTarget.classList.toggle('filter-chip--active', _marginAlertOnly);
    _page = 1;
    loadProducts();
  });
  _container.querySelector('#pm-oos-chip').addEventListener('click', (e) => {
    _oosOnly = !_oosOnly;
    e.currentTarget.classList.toggle('filter-chip--active', _oosOnly);
    _page = 1;
    loadProducts();
  });
}

function bindBulkEvents() {
  const bar = _container.querySelector('#pm-bulk-bar');
  if (!bar) return;
  bar.querySelector('[data-bulk-action="match_cheapest"]')?.addEventListener('click', () => runBulkAction('match_cheapest'));
  bar.querySelector('[data-bulk-action="undercut"]')?.addEventListener('click', () => {
    const amt = parseFloat(_container.querySelector('#pm-undercut-amt')?.value || '0');
    if (!Number.isFinite(amt) || amt < 0) { Toast.error('Invalid undercut amount'); return; }
    runBulkAction('undercut', amt);
  });
}

export default {
  title: 'Price Monitor',
  async init(container) {
    _container = container;
    _page = 1;
    _search = _brand = _source = _sort = '';
    _marginAlertOnly = false;
    _oosOnly = false;
    _selected = new Set();
    _competitors = [];
    _brandOptions = [];
    _sourceOptions = [];

    renderShell();
    updateBulkBar();
    renderSummaryStrip();
    renderExportsPanel();
    await loadProducts();
  },
};
