/**
 * Pricing — one place to see and change every product's price (ERR-336).
 *
 * Three parts:
 *   1. Every product's current price (GET /api/admin/products — the backend is
 *      the source of truth; this page computes no price).
 *   2. Bulk actions on a selection, or on everything a filter matches:
 *        - Set exact price  → writes manual_retail_price (LOCKED: rules skip it)
 *        - Clear manual price → product follows the rules again
 *        - Adjust by % / $, and "margin for this filter" rules → need backend
 *          (backend-docs/outbox/backend-asks-2026-10-15.md). Shown DISABLED
 *          with that reason, never hidden.
 *   3. The margin rules: the source × cost-band × brand ladder from the
 *      approval-gated engine (pages/cc2-pricing.js, mounted as-is; it used to
 *      be the Site Health → Pricing tab).
 *
 * What this page cannot see yet, and says so on screen: which products carry a
 * manual price. The admin API strips manual_retail_price from every read
 * (security hardening round 2), so the "Price set by" column reads "unknown"
 * until the backend returns a has_manual_price flag.
 */
import { AdminAPI, FilterState, esc, icon } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { marginBadge } from '../utils/profitability.js';
import { GST_INCL, GST_EXCL, GST_BASE } from '../utils/gst-basis.js';
import { typeFilterOptions, productTypeLabel } from '../utils/product-types.js';
import { BULK_CAP, filtersToParams, runSequential } from '../utils/pricing-page.js';

const LIMIT = 100;
const SPEC = 'backend-docs/outbox/backend-asks-2026-10-15.md';
const NEEDS_BACKEND = `Needs backend — asked in ${SPEC}`;
const MISSING = '—';
const SORTABLE = ['name', 'sku', 'retail_price', 'cost_price', 'margin_pct', 'source', 'product_type'];

const money = (v) => (v == null || !Number.isFinite(Number(v)) ? MISSING : `$${Number(v).toFixed(2)}`);

let _container = null;
let _table = null;
let _rules = null;
let _filters = null;
let _page = 1;
let _total = null;
let _pageFull = false;
let _stop = false;
let _searchTimer = null;

function renderShell(brands) {
  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1 class="admin-page-title">${icon('finance', 22, 22)} Pricing</h1>
        <div class="cc2-subtitle">Every product's price, the margin rules behind it, and bulk changes.</div>
      </div>
    </div>
    <div class="cc2-tiers__banner cc2-tiers__banner--warn pricing-gaps" role="note"><div>
      <strong>Not everything works yet.</strong> This page cannot yet show which products have a manual (locked) price,
      adjust prices by % or $, set a margin for a brand + type filter, or lower prices through a rule.
      Those need the backend changes in <code>${esc(SPEC)}</code>. Their controls are visible but disabled.
    </div></div>

    <section class="admin-card pricing-section" aria-labelledby="pricing-grid-title">
      <h2 id="pricing-grid-title" class="pricing-h2">All product prices</h2>
      <div class="pricing-filters">
        <input class="admin-input" type="search" data-f="search" placeholder="Search name or SKU" aria-label="Search">
        <select class="admin-select" data-f="brand" aria-label="Brand"><option value="">All brands</option>
          ${brands.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
        <select class="admin-select" data-f="source" aria-label="Genuine or compatible">
          <option value="">Genuine + compatible</option><option value="genuine">Genuine</option><option value="compatible">Compatible</option></select>
        <select class="admin-select" data-f="type" aria-label="Product type">${typeFilterOptions('')}</select>
        <select class="admin-select" data-f="active" aria-label="Active">
          <option value="true">Active only</option><option value="">Active + inactive</option><option value="false">Inactive only</option></select>
        <span class="pricing-gated" title="${esc(NEEDS_BACKEND)}">
          <input class="admin-input pricing-range" type="number" placeholder="Cost from" disabled aria-label="Cost from (needs backend)">
          <input class="admin-input pricing-range" type="number" placeholder="Price to" disabled aria-label="Price to (needs backend)">
          <span class="pricing-chip">needs backend</span>
        </span>
      </div>
      <div class="pricing-selection" id="pricing-selection"></div>
      <div id="pricing-table"></div>
    </section>

    <section class="admin-card pricing-section" aria-labelledby="pricing-rules-title">
      <h2 id="pricing-rules-title" class="pricing-h2">Margin rules</h2>
      <p class="cc2-tiers__muted pricing-lede">Rules price every product that has no manual price.
        Today a rule is set per genuine/compatible × supplier-cost band, optionally per brand. Type a margin %
        or a multiplier — margin here is gross on the price ex GST, before price endings and floors; the preview
        shows the real shelf price. Rules by product type or category, and rules that lower prices, need backend.</p>
      <div id="pricing-rules"></div>
    </section>`;
}

function columns() {
  return [
    { key: 'sku', label: 'SKU', sortable: true, render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>` },
    { key: 'name', label: 'Name', sortable: true, render: (r) => `<span class="cell-truncate" style="display:block;max-width:300px">${esc(r.name || MISSING)}</span>` },
    { key: 'brand', label: 'Brand', render: (r) => esc((r.brand && r.brand.name) || r.brand_name || (r.brands && r.brands.name) || MISSING) },
    { key: 'source', label: 'Source', sortable: true, render: (r) => esc(r.source || MISSING) },
    { key: 'product_type', label: 'Type', sortable: true, render: (r) => esc(r.product_type ? productTypeLabel(r.product_type) : MISSING) },
    { key: 'cost_price', label: 'Cost', sortable: true, gst: GST_EXCL, align: 'right', render: (r) => `<span class="cell-mono">${esc(money(r.cost_price))}</span>` },
    { key: 'retail_price', label: 'Price', sortable: true, gst: GST_INCL, align: 'right', render: (r) => `<span class="cell-mono"><strong>${esc(money(r.retail_price))}</strong></span>` },
    {
      key: 'margin_pct', label: 'Gross margin', sortable: true, gst: GST_BASE, align: 'right',
      title: 'Backend margin_pct, before card fees. On some rows it differs from (price ex GST − cost) ÷ price ex GST, the margin the rules use; asked in the backend spec.',
      render: (r) => (r.margin_pct == null ? MISSING : `<span class="cell-mono">${esc(Number(r.margin_pct).toFixed(1))}%</span>`),
    },
    {
      key: 'net_margin_incl_fixed_pct', label: 'Net margin', align: 'right',
      title: 'After card fees and the $0.30 per-order fee (backend figure).',
      render: (r) => marginBadge(r.net_margin_incl_fixed_pct),
    },
    {
      key: 'price_source', label: 'Price set by',
      render: (r) => (r.has_manual_price === true ? '<span class="pricing-chip pricing-chip--lock">Manual (locked)</span>'
        : r.has_manual_price === false ? '<span class="pricing-chip">Rule</span>'
          : `<span class="pricing-chip" title="${esc(NEEDS_BACKEND)}">unknown</span>`),
    },
  ];
}

async function load() {
  _table.setLoading(true);
  try {
    const data = await AdminAPI.listProductsStrict(filtersToParams(_filters), _page, LIMIT);
    if (!_table) return;
    const rows = Array.isArray(data) ? data : (data && (data.products || data.data)) || [];
    // /api/admin/products may send no pagination block. An unknown total is
    // unknown — never rows.length (ERR-220) — so Next is decided by hasMore.
    const p = (data && data.pagination) || {};
    const t = p.total ?? (data && data.total);
    _total = t != null && Number.isFinite(Number(t)) ? Number(t) : null;
    _table.setData(rows, _total != null
      ? { page: _page, limit: LIMIT, total: _total }
      : { page: _page, limit: LIMIT, totalUnknown: true, hasMore: rows.length >= LIMIT });
    _pageFull = rows.length >= LIMIT;
  } catch (e) {
    if (!_table) return;
    _total = null;
    _pageFull = false;
    _table.setData([], null);
    _container.querySelector('#pricing-table').insertAdjacentHTML('afterbegin',
      `<div class="cc2-tiers__banner cc2-tiers__banner--danger" role="alert"><div>Could not load prices: ${esc(e.message)}. Nothing on this page is current.</div></div>`);
  }
  renderSelection();
}

function selectedIds() { return _table ? [..._table.getSelected()] : []; }

function renderSelection() {
  const el = _container && _container.querySelector('#pricing-selection');
  if (!el) return;
  const n = selectedIds().length;
  const more = _total != null ? n < _total : _pageFull || _page > 1;
  const all = n > 0 && more
    ? ` · <button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="select-all">Select all${_total != null ? ` ${esc(_total.toLocaleString('en-NZ'))}` : ''} matching</button>` : '';
  el.innerHTML = `
    <span class="pricing-selection__count">${n ? `<strong>${esc(n.toLocaleString('en-NZ'))}</strong> selected` : 'Tick products to change their price'}${all}
      ${n ? '<button class="admin-btn admin-btn--sm admin-btn--ghost" data-act="clear-sel">Clear</button>' : ''}</span>
    <span class="pricing-selection__actions">
      <button class="admin-btn admin-btn--sm admin-btn--primary" data-act="set-exact" ${n ? '' : 'disabled'}>Set exact price (locks)</button>
      <button class="admin-btn admin-btn--sm" data-act="clear-manual" ${n ? '' : 'disabled'}>Clear manual price</button>
      <button class="admin-btn admin-btn--sm" disabled title="${esc(NEEDS_BACKEND)}">Adjust by % / $ <span class="pricing-chip">needs backend</span></button>
      <button class="admin-btn admin-btn--sm" disabled title="${esc(NEEDS_BACKEND)}">Set margin for this filter <span class="pricing-chip">needs backend</span></button>
    </span>`;
}

// "Select all N matching": page through the SAME filter for ids only. Stops
// loudly on a refusal — a half-built selection must not look complete.
async function selectAllMatching(btn) {
  btn.disabled = true;
  const ids = [];
  try {
    for (let page = 1; ; page++) {
      // 60 × 200 = 12,000, about 3× the catalogue: past that the endpoint is
      // ignoring `page` and this loop would never end.
      if (page > 60) throw new Error('the list kept returning rows past 12,000');
      btn.textContent = `Selecting… ${ids.length}`;
      const data = await AdminAPI.listProductsStrict(filtersToParams(_filters), page, 200);
      const rows = Array.isArray(data) ? data : (data && (data.products || data.data)) || [];
      rows.forEach((r) => r && r.id && ids.push(String(r.id)));
      if (rows.length < 200 || (_total != null && ids.length >= _total)) break;
    }
  } catch (e) {
    Toast.error(`Select all stopped after ${ids.length}: ${e.message}. Nothing was added to the selection.`);
    renderSelection();
    return;
  }
  if (!_table) return;
  ids.forEach((id) => _table.selected.add(id));
  _table.setData(_table.data, _table.pagination);
  _total = ids.length;
  Toast.info(`Selected all ${ids.length} matching products.`);
  renderSelection();
}

function openSetExact() {
  const ids = selectedIds();
  if (ids.length > BULK_CAP) { Toast.warning(`${ids.length} selected — a run is capped at ${BULK_CAP} until the backend bulk endpoint exists. Narrow the filter.`); return; }
  const m = Modal.open({
    title: `Set an exact price on ${ids.length} product${ids.length === 1 ? '' : 's'}?`,
    body: `<div class="admin-form-group"><label for="pricing-exact">Price (${esc(GST_INCL)})</label>
        <input id="pricing-exact" class="admin-input" type="number" step="0.01" min="0.01" placeholder="e.g. 29.99" autocomplete="off"></div>
      <ul class="cc2-tiers__facts">
        <li>Every selected product gets <strong>this exact price</strong>, sent as typed (no rounding).</li>
        <li>The price is <strong>locked</strong>: margin rule changes will not move it until you clear it.</li>
        <li class="cc2-tiers__warntext">Existing manual prices on these products are replaced — this page cannot yet see which ones have one.</li>
      </ul>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm">Set price</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    const v = Number(m.body.querySelector('#pricing-exact').value);
    if (!Number.isFinite(v) || v <= 0) { Toast.warning('Enter a price above $0.'); return; }
    m.close();
    runBulk(ids, (id) => AdminAPI.updateProduct(id, { manual_retail_price: v }), { expect: v, label: `Set ${money(v)}` });
  });
}

function openClearManual() {
  const ids = selectedIds();
  if (ids.length > BULK_CAP) { Toast.warning(`${ids.length} selected — a run is capped at ${BULK_CAP} until the backend bulk endpoint exists. Narrow the filter.`); return; }
  const m = Modal.open({
    title: `Clear the manual price on ${ids.length} product${ids.length === 1 ? '' : 's'}?`,
    body: `<ul class="cc2-tiers__facts">
        <li>These products go back to following the margin rules.</li>
        <li class="cc2-tiers__warntext">The shelf price does <strong>not</strong> change until a reprice runs.</li>
        <li class="cc2-tiers__warntext">A reprice never lowers a price today: a cleared manual price that is above the rule price stays where it is.</li>
      </ul>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="confirm">Clear manual price</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="confirm"]').addEventListener('click', () => {
    m.close();
    runBulk(ids, (id) => AdminAPI.updateProduct(id, { manual_retail_price: null }), { label: 'Clear manual price', offerReprice: true });
  });
}

async function runBulk(ids, put, { expect = null, label, offerReprice = false }) {
  _stop = false;
  const m = Modal.open({
    title: `${label} — running`,
    body: '<p id="pricing-progress" aria-live="polite">Starting…</p>',
    footer: '<button class="admin-btn admin-btn--ghost" data-action="stop">Stop</button>',
  });
  m?.footer.querySelector('[data-action="stop"]').addEventListener('click', (e) => { _stop = true; e.target.disabled = true; e.target.textContent = 'Stopping…'; });
  const res = await runSequential(ids, put, {
    expect,
    shouldStop: () => _stop,
    onProgress: (done, total) => { const p = m && m.body.querySelector('#pricing-progress'); if (p) p.textContent = `${done} / ${total}`; },
  });
  m?.close();
  showResult(res, label, put, expect, offerReprice);
  if (_table) { _table.clearSelection(); load(); }
}

// The result stays on screen (not a toast): every failure with its message, the
// rows never tried, and the rows whose shelf price did not come back as asked.
function showResult(res, label, put, expect, offerReprice) {
  const unapplied = res.ok.filter((r) => r.unapplied);
  const row = (id) => {
    const r = (_table && _table.data.find((x) => String(x.id) === id)) || {};
    return esc(r.sku || id);
  };
  const m = Modal.open({
    title: `${label}: ${res.ok.length} done, ${res.failed.length} failed${res.notAttempted.length ? `, ${res.notAttempted.length} not attempted` : ''}`,
    body: `${res.refused ? `<p class="cc2-tiers__warntext">${esc(res.reason)}</p>` : ''}
      ${unapplied.length ? `<p class="cc2-tiers__warntext">${unapplied.length} saved, but the price the server returned is not ${esc(money(expect))} (shelf price not updated yet, or a floor applied): ${unapplied.map((r) => row(r.id)).join(', ')}</p>` : ''}
      ${res.failed.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Why it failed</th></tr></thead><tbody>
        ${res.failed.map((f) => `<tr><td class="cell-mono">${row(f.id)}</td><td>${esc(f.message)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${res.notAttempted.length && !res.refused ? `<p>Stopped: ${res.notAttempted.length} products were not attempted.</p>` : ''}
      ${offerReprice && res.ok.length ? '<p>To apply the rules to the cleared products now, run a full reprice (raises only; it never lowers a price).</p>' : ''}`,
    footer: `${res.failed.length ? '<button class="admin-btn" data-action="retry">Retry failed</button>' : ''}
      ${offerReprice && res.ok.length ? '<button class="admin-btn" data-action="reprice">Run reprice now</button>' : ''}
      <button class="admin-btn admin-btn--primary" data-action="close">Close</button>`,
  });
  if (!m) return;
  m.footer.querySelector('[data-action="close"]').addEventListener('click', () => m.close());
  m.footer.querySelector('[data-action="retry"]')?.addEventListener('click', () => { m.close(); runBulk(res.failed.map((f) => f.id), put, { expect, label, offerReprice }); });
  m.footer.querySelector('[data-action="reprice"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const job = await AdminAPI.controlCenter.retryReprice();
      Toast.success(`Reprice queued${job.job_id ? ` (job ${job.job_id})` : ''}. Progress shows under Margin rules.`);
      m.close();
    } catch (err) { Toast.error(err.message); e.target.disabled = false; }
  });
}

function onFilter(e) {
  const f = e.target.dataset.f;
  if (!f) return;
  _filters[f] = e.target.value;
  _page = 1;
  if (_table) _table.clearSelection();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(load, f === 'search' ? 300 : 0);
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'select-all') selectAllMatching(b);
  else if (b.dataset.act === 'clear-sel') { _table.clearSelection(); renderSelection(); }
  else if (b.dataset.act === 'set-exact') openSetExact();
  else if (b.dataset.act === 'clear-manual') openClearManual();
}

export default {
  title: 'Pricing',
  async init(container) {
    _container = container;
    FilterState.showBar(false); // the global date/brand bar does not drive this page
    _filters = { search: '', brand: '', source: '', type: '', active: 'true', sort: '', order: 'asc' };
    _page = 1;
    const brands = (await AdminAPI.getBrands() || []).filter((b) => b && b.id && b.name).sort((a, b) => a.name.localeCompare(b.name));
    if (_container !== container) return;
    renderShell(brands);
    _container.querySelector('.pricing-filters').addEventListener('input', onFilter);
    _container.querySelector('.pricing-filters').addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') onFilter(e); });
    _container.querySelector('#pricing-selection').addEventListener('click', onClick);
    _table = new DataTable(_container.querySelector('#pricing-table'), {
      columns: columns(),
      rowKey: 'id',
      selectable: true,
      emptyMessage: 'No products match these filters',
      onSelectionChange: renderSelection,
      onPageChange: (p) => { _page = p; load(); },
      onSort: (key, dir) => {
        if (!SORTABLE.includes(key)) return;
        _filters.sort = key; _filters.order = dir; _page = 1; load();
      },
    });
    renderSelection();
    load();
    const rules = (await import('./cc2-pricing.js')).default;
    const host = _container && _container.querySelector('#pricing-rules');
    if (!host) return;
    _rules = rules;
    rules.init(host);
  },
  destroy() {
    clearTimeout(_searchTimer);
    if (_rules) { try { _rules.destroy(); } catch (e) { /* tab may have failed to init */ } }
    _rules = null;
    _table = null;
    _container = null;
  },
};
