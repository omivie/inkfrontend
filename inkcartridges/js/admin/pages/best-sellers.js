/**
 * Best Sellers — Performance hub tab. Top 50 products in the selected range,
 * ranked by revenue, units, or orders (the number of orders a product was in).
 *
 * Data and every measured caveat: utils/best-sellers.js. The dashboard "Most Bought"
 * card is the top-10 preview of this tab and uses the same loader and ranking.
 *
 * Filters: the global bar shows PERIOD and BRAND only — the endpoint ignores
 * status/category filters (probe:best-sellers §5), and cancelled orders are already
 * excluded server-side. Type and pack are applied here from catalogue facts; a sold
 * SKU the catalogue no longer holds cannot be placed and is COUNTED on screen.
 */
import { AdminAPI, FilterState, esc } from '../app.js';
import { METRICS, TYPE_GROUPS, rankBy, metricIncomplete, filterItems } from '../utils/best-sellers.js';
import { downloadCsv } from '../utils/csv.js';

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '—';
const LIMIT = 50;
const PACKS = [{ id: 'all', label: 'All' }, { id: 'singles', label: 'Singles' }, { id: 'packs', label: 'Packs' }];

let _container = null;
let _data = null;       // getBestSellers() result, or null when the fetch failed
let _loadSeq = 0;
const _view = { metric: 'revenue', type: 'all', pack: 'all' };

function current() {
  const { items, unplaced } = filterItems(_data?.items || [], _view);
  return { ranked: rankBy(items, _view.metric).slice(0, LIMIT), unplaced, pool: items };
}

function seg(name, options, active) {
  return `<div class="admin-segmented" role="group" aria-label="${esc(name)}">${options.map(o =>
    `<button type="button" class="admin-segmented__btn${o.id === active ? ' admin-segmented__btn--active' : ''}" data-${esc(name)}="${esc(o.id)}" aria-pressed="${o.id === active}">${esc(o.label)}</button>`).join('')}</div>`;
}

function render() {
  if (!_container) return;
  if (!_data) {
    _container.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Best seller data unavailable</div><div class="admin-empty__text">The sales ranking could not be loaded. Change the period or reload to retry.</div></div>`;
    return;
  }
  const { ranked, unplaced, pool } = current();
  const notes = [];
  if (_data.truncated) notes.push('The server row cap was reached, so rankings cover a partial set of products. Narrow the period for a complete ranking.');
  if (_data.catalogFailed) notes.push('Catalogue lookup failed: brand, type and pack are unknown, so type and pack filters exclude every product.');
  if (unplaced) notes.push(`${unplaced} sold product${unplaced === 1 ? ' is' : 's are'} no longer in the catalogue, so type/pack is unknown and ${unplaced === 1 ? 'it is' : 'they are'} left out of this filter.`);
  if (metricIncomplete(pool, _view.metric)) notes.push(`Some products have no ${_view.metric} figure and rank last.`);

  const cell = (v, fmt = String) => (v == null ? MISSING : esc(fmt(v)));
  const rows = ranked.map((p, i) => `
    <tr>
      <td class="cell-mono">${i + 1}</td>
      <td>${esc(p.name)}</td>
      <td class="cell-mono cell-muted">${esc(p.sku || '')}</td>
      <td class="cell-muted">${p.brand ? esc(p.brand) : MISSING}</td>
      <td class="cell-mono cell-right">${cell(p.units)}</td>
      <td class="cell-mono cell-right">${cell(p.orders)}</td>
      <td class="cell-mono cell-right">${cell(p.revenue, formatPrice)}</td>
    </tr>`).join('');

  _container.innerHTML = `
    <div class="admin-card">
      <div class="admin-card__title" style="flex-wrap:wrap;gap:12px">
        <span>Best Sellers <small>top ${Math.min(ranked.length, LIMIT)} by ${esc(_view.metric)} · cancelled orders excluded</small></span>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-export ${ranked.length ? '' : 'disabled'}>Export CSV</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:12px">
        ${seg('metric', METRICS, _view.metric)}
        ${seg('pack', PACKS, _view.pack)}
        <select class="admin-select" style="width:auto" data-type aria-label="Product type">
          ${TYPE_GROUPS.map(g => `<option value="${esc(g.id)}"${g.id === _view.type ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}
        </select>
      </div>
      ${notes.map(n => `<div class="admin-dash-inline-empty" role="status">${esc(n)}</div>`).join('')}
      ${ranked.length ? `
      <table class="admin-dash-table">
        <thead><tr>
          <th>#</th><th>Product</th><th>SKU</th><th>Brand</th>
          <th class="cell-right">Units</th><th class="cell-right">Orders</th><th class="cell-right">Revenue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="admin-dash-inline-empty">No sales match this range and filter.</div>'}
    </div>`;
}

function exportCsv() {
  const { ranked } = current();
  // Blank, never 0, for an absent figure (ERR-063 family).
  downloadCsv(`best-sellers-${_view.metric}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Rank', 'Product', 'SKU', 'Brand', 'Units', 'Orders', 'Revenue'],
    ranked.map((p, i) => [i + 1, p.name, p.sku, p.brand, p.units, p.orders, p.revenue]));
}

function onClick(e) {
  const t = e.target.closest('[data-metric],[data-pack],[data-export]');
  if (!t) return;
  if (t.hasAttribute('data-export')) return exportCsv();
  if (t.dataset.metric) _view.metric = t.dataset.metric;
  if (t.dataset.pack) _view.pack = t.dataset.pack;
  render();
}

function onChange(e) {
  if (!e.target.matches('[data-type]')) return;
  _view.type = e.target.value;
  render();
}

async function load() {
  const seq = ++_loadSeq;
  const data = await AdminAPI.getBestSellers(FilterState.getParams(), FilterState.getAbortSignal());
  if (seq !== _loadSeq || !_container) return;   // a newer filter change won
  _data = data;
  render();
}

export default {
  title: 'Best Sellers',

  async init(container) {
    _container = container;
    FilterState.setVisibleFilters(['period', 'brands']);
    container.addEventListener('click', onClick);
    container.addEventListener('change', onChange);
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh"><div class="admin-loading__spinner"></div></div>`;
    await load();
  },

  async onFilterChange() {
    if (_container) await load();
  },

  destroy() {
    _container?.removeEventListener('click', onClick);
    _container?.removeEventListener('change', onChange);
    FilterState.setVisibleFilters(null);
    _container = null;
    _data = null;
  },
};
