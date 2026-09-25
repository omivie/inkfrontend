/**
 * Supplier Prices — which supplier is cheapest, and by how much (ERR-190).
 *
 * The owner compares supplier price lists by hand. This page answers the question
 * once, for every compatible product, and — the part that matters — refuses to let
 * a stale answer look like a current one.
 *
 * ── THE NUMBER THIS PAGE EXISTS TO QUALIFY ──────────────────────────────────
 *
 * Measured live 2026-08-31, across all 172 comparable products:
 *
 *     131 rows say "switch supplier and save"
 *     130 of those rest on a price list 193 days old
 *       1 is backed by a price from this month
 *
 * So the naive build of this page — one headline saving, sorted biggest-first —
 * would point the owner at a February price 130 times out of 131, and every one of
 * those would look identical to the one real opportunity. That is why:
 *
 *   • the headline is SPLIT into a fresh figure and a stale figure, never blended;
 *   • every supplier price carries its age in the cell, not in a tooltip;
 *   • a row whose cheapest price is stale is marked in the row itself;
 *   • and no stale row is ever hidden — a stale cheap price is still a reason to
 *     go ask that supplier for a current list (handoff §4).
 *
 * ── WHY THE WHOLE SET IS FETCHED ────────────────────────────────────────────
 *
 * Five query params a reasonable person would assume exist are DECOYS (measured;
 * see DECOY_PARAMS in utils/supplier-offers.js and `npm run probe:supplier-prices`).
 * There is no server-side staleness filter and no `reason=` on /unmatched, so the
 * two filters this page is FOR can only run client-side — and they must run over
 * the WHOLE set, not one server page. Both `ambiguous` rows sit past the first
 * page of 50, so a per-page filter would render an empty review tab.
 *
 * Volume makes it cheap: 1 request for Compare (172 rows), 3 for Single source
 * (438), 2 for the review queue (345). A short set is reported as short — see
 * `renderIncompleteNote`, and `complete:false` from AdminAPI.supplierOffers.
 *
 * ── LOADING A NEW PRICE LIST (Ask 5, live 2026-09-21 — ERR-286) ──────────────
 *
 * Until 2026-09-21 both steps answered 403 `Cron endpoints require CRON_SECRET
 * in production` to a live owner token (measured 2026-08-31), so the panel said
 * so and had no buttons. The backend then opened a narrower gate: super_admin
 * may list the feed slots, upload to the `product-list` slot, and run the
 * supplier-price-list importer — which writes supplier_offers and nothing else.
 * The genuine/compatible catalogue importers stay secret-gated.
 *
 * Measured 2026-09-25: GET /api/admin/feed-files is 200 to an owner token (it
 * was 403). The two POSTs were NOT exercised from here — one overwrites the
 * stored price list, the other rewrites the offer table — so the panel reports
 * whatever the server answers, by status, the first time the owner uses it.
 *
 * ── MANUAL MAPPINGS (Ask 4, live 2026-09-21) ───────────────────────────────
 *
 * `GET /api/admin/supplier-offers/mappings` lists every pin, so the Undo on the
 * success toast is no longer the only chance: the Mappings panel can unpin any
 * of them later.
 *
 * Pinned by tests/admin-supplier-prices-aug2026.test.js.
 */

import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { Drawer } from '../components/drawer.js';
import { attachProductAutocomplete } from '../components/product-search.js';
import {
  MISSING, COVERAGE, SORTS,
  ageLabel, shortDate, staleAfterDays,
  supplierEntry, supplierColumns,
  savingState, switchOpportunity, savingSplit, perUnitCaption,
  applyClientFilters, cheapestIsCurrent,
  partitionUnmatched, reasonMeta, countByReason,
  mapPayload, colourTailConflict,
} from '../utils/supplier-offers.js';

const formatPrice = (v) => (window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`);
/** Money, or an explicit em-dash. formatPrice(null) returns '' — an invisible field. */
const money = (v) => (v == null || !Number.isFinite(Number(v)) ? MISSING : formatPrice(Number(v)));

const TABS = [
  { id: 'multi', label: COVERAGE.multi.label },
  { id: 'single', label: COVERAGE.single.label },
  { id: 'review', label: 'Needs review' },
];

// ── Module state. Pages are singletons — init() resets every one of these. ──
let _container = null;
let _table = null;
let _tab = 'multi';
/** Monotonic load token. A fetch that resolves after the user moved on must not paint. */
let _gen = 0;
let _alive = false;

// Compare-tab filters. Every one of these is a param the server MEASURABLY honours.
let _search = '';
let _brand = '';
let _type = '';
let _minSaving = '';
let _sort = 'saving_desc';
// Client-side only — the server has no equivalent (DECOY_PARAMS).
let _freshOnly = false;
let _switchOnly = false;

let _page = 1;
let _limit = 50;
let _rows = [];
let _filtered = [];
let _suppliers = [];
let _meta = null;
let _complete = true;
let _staleDays = 30;
let _brandOptions = [];
let _typeOptions = [];
let _loading = false;

// Review tab
let _reviewRows = [];
let _reviewMeta = null;
let _reviewComplete = true;
let _reviewShowAll = false;
let _reviewSearch = '';
let _reviewSupplier = '';
let _reviewPage = 1;

let _searchDebounce = null;
/** Portalled autocomplete menus are <body> children — they outlive their modal. */
let _acHandles = [];
let _delegated = null;

function resetState() {
  _table = null;
  _tab = 'multi';
  _gen = 0;
  _search = ''; _brand = ''; _type = ''; _minSaving = ''; _sort = 'saving_desc';
  _freshOnly = false; _switchOnly = false;
  _page = 1; _limit = 50;
  _rows = []; _filtered = []; _suppliers = []; _meta = null; _complete = true;
  _staleDays = 30; _brandOptions = []; _typeOptions = []; _loading = false;
  _reviewRows = []; _reviewMeta = null; _reviewComplete = true;
  _reviewShowAll = false; _reviewSearch = ''; _reviewSupplier = ''; _reviewPage = 1;
  if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
  destroyAutocompletes();
}

function destroyAutocompletes() {
  for (const handle of _acHandles) {
    try { handle && handle.destroy && handle.destroy(); } catch { /* already gone */ }
  }
  _acHandles = [];
}

// ── Hash state, so a filtered view is shareable and survives a reload ───────

function getHashParam(key) {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const q = hash.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(hash.slice(q + 1)).get(key);
}

function writeHashParams(patch) {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const [base, query] = hash.split('?');
  // Merge, never rebuild: the global filter bar owns period=/statuses= on the
  // same hash and rebuilding from scratch would silently drop them.
  const params = new URLSearchParams(query || '');
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v == null || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  const next = `#${base || 'supplier-prices'}${qs ? `?${qs}` : ''}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

// ── Rendering: the pieces above the table ──────────────────────────────────

/**
 * Feed-level freshness, one pill per supplier, built from `data.suppliers[]`.
 *
 * Never from a hardcoded pair. Only two suppliers exist today and the handoff is
 * explicit that a third is expected (§5) — a two-element assumption anywhere here
 * would drop the third supplier's feed silently rather than break loudly.
 */
function renderFreshness() {
  const host = _container.querySelector('#sp-freshness');
  if (!host) return;
  if (!_suppliers.length) {
    host.innerHTML = `<div class="admin-sp-feeds__empty">${esc(
      'No supplier feed has been read yet — there are no matched offers to compare.')}</div>`;
    return;
  }
  const pills = _suppliers.map((s) => {
    const stale = !!s.is_stale;
    const count = Number(s.offer_count);
    const offers = Number.isFinite(count) ? `${count.toLocaleString('en-NZ')} offers` : 'offer count unknown';
    return `<div class="admin-sp-feed${stale ? ' admin-sp-feed--stale' : ''}">
      <span class="admin-sp-feed__name">${esc(s.supplier_name || 'Unnamed supplier')}</span>
      <span class="admin-sp-feed__age">${esc(ageLabel(s.age_days, s.last_seen_at))}</span>
      <span class="admin-sp-feed__count">${esc(offers)}</span>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="admin-sp-feeds">${pills}
    <div class="admin-sp-feeds__note">${esc(
      `A price is called stale after ${_staleDays} days. These dates are also the best record `
      + 'of when each supplier last sent a list — there is no import-history endpoint.')}</div>
  </div>`;
}

/**
 * The split headline.
 *
 * `meta.totals.sum_per_unit_saving` is one number covering both the rows priced
 * this month and the rows priced in February. Printing it alone is the single
 * most misleading thing this page could do, so it is never printed alone.
 */
function renderHonesty() {
  const host = _container.querySelector('#sp-honesty');
  if (!host) return;
  if (_tab === 'review') { host.innerHTML = ''; return; }

  const split = savingSplit(_filtered);

  if (!_filtered.length) { host.innerHTML = ''; return; }

  // Single-source tab: there is no saving to split. Say what the tab IS for
  // rather than printing three zeroes.
  if (_tab === 'single') {
    const fresh = _filtered.filter(cheapestIsCurrent).length;
    const stale = _filtered.length - fresh;
    host.innerHTML = `<div class="admin-sp-honesty">
      <div class="admin-sp-honesty__line">${esc(
        `${_filtered.length} products have exactly one supplier. There is nothing to compare them `
        + 'against — this is the shopping list, not a saving.')}</div>
      ${stale ? `<div class="admin-sp-honesty__line admin-sp-honesty__line--stale">${esc(
        `${stale} of them are priced from a list older than ${_staleDays} days; ${fresh} are current.`)}</div>` : ''}
    </div>`;
    return;
  }

  // Both captions come out of perUnitCaption so the words "per unit" cannot be
  // dropped from one of them in a later edit — that qualifier is the whole reason
  // these figures are honest.
  const bits = [];
  bits.push(`<div class="admin-sp-honesty__figure admin-sp-honesty__figure--fresh">
      <span class="admin-sp-honesty__amount">${esc(money(split.freshTotal))}</span>
      <span class="admin-sp-honesty__caption">${esc(
        perUnitCaption(split.freshCount, 'whose cheapest price is current'))}</span>
    </div>`);
  if (split.staleCount) {
    bits.push(`<div class="admin-sp-honesty__figure admin-sp-honesty__figure--stale">
      <span class="admin-sp-honesty__amount">${esc(money(split.staleTotal))}</span>
      <span class="admin-sp-honesty__caption">${esc(perUnitCaption(split.staleCount,
        `whose cheapest price is older than ${_staleDays} days — confirm before ordering`))}</span>
    </div>`);
  }

  const notes = [];
  if (split.switchCount) {
    notes.push(`${split.switchCount} of ${split.comparedCount} rows would change who we buy from`
      + (split.staleSwitchCount
        ? `, and ${split.staleSwitchCount} of those rest on a stale price`
        : '') + '.');
  }
  if (split.tieCount) {
    notes.push(`${split.tieCount} row${split.tieCount === 1 ? ' is' : 's are'} quoted at the same price by `
      + 'every supplier.');
  }
  if (split.unknownCostCount) {
    notes.push(`${split.unknownCostCount} row${split.unknownCostCount === 1 ? '' : 's'} could not be checked `
      + 'against what we pay today — the catalogue holds no cost for them.');
  }

  host.innerHTML = `<div class="admin-sp-honesty">
    <div class="admin-sp-honesty__figures">${bits.join('')}</div>
    ${notes.length ? `<div class="admin-sp-honesty__notes">${notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : ''}
    <div class="admin-sp-honesty__basis">${esc(
      'Both figures are per-unit sums. They ignore how many of each we buy, so they are a ranking of '
      + 'where to look, not money in hand.')}</div>
  </div>`;
}

/**
 * A short set must never look like a whole set.
 *
 * `complete:false` means a page of the walk did not come back, so every count and
 * every total on screen is a floor. Saying nothing here would turn an outage into
 * a quietly smaller — and entirely plausible — number.
 */
function renderIncompleteNote() {
  const host = _container.querySelector('#sp-incomplete');
  if (!host) return;
  const bad = (_tab === 'review') ? !_reviewComplete : !_complete;
  if (!bad) { host.innerHTML = ''; return; }
  const held = (_tab === 'review') ? _reviewRows.length : _rows.length;
  host.innerHTML = `<div class="admin-sp-partial">
    ${icon('close', 16, 16)}
    <div>
      <strong>${esc('This list is incomplete.')}</strong>
      ${esc(`Only ${held} row${held === 1 ? '' : 's'} could be read, so every count and total below is a `
        + 'floor, not a figure. Reload to try again.')}
    </div>
  </div>`;
}

// ── The comparison table ───────────────────────────────────────────────────

/** One supplier's price cell: the money, then how old it is. Never `$0.00` for absent. */
function renderSupplierCell(row, supplierName) {
  const entry = supplierEntry(row, supplierName);
  if (!entry) {
    // Absent from suppliers[] means "does not quote this product". A zero here
    // would read as free, and sort to the top of a cheapest-first page.
    return `<span class="admin-sp-cell admin-sp-cell--absent" data-tooltip="${esc(
      `${supplierName} does not quote this product`)}">${MISSING}</span>`;
  }
  const isCheapest = entry.supplier_name === row.cheapest_supplier;
  const cls = `admin-sp-cell${isCheapest ? ' admin-sp-cell--cheapest' : ''}`
    + `${entry.is_stale ? ' admin-sp-cell--stale' : ''}`;
  return `<span class="${cls}">
    <span class="admin-sp-cell__money cell-mono">${esc(money(entry.cost_nzd))}</span>
    <span class="admin-sp-cell__age">${esc(ageLabel(entry.age_days, entry.last_seen_at))}</span>
  </span>`;
}

function renderSavingCell(row) {
  const state = savingState(row);
  if (state === 'single') {
    return `<span class="cell-right admin-text-muted" data-tooltip="${esc(
      'Only one supplier quotes this — there is nothing to compare against')}">${MISSING}</span>`;
  }
  if (state === 'tie') {
    return `<span class="cell-right admin-text-muted">${esc('same price')}</span>`;
  }
  const pct = Number(row.saving_vs_next_percent);
  const pctText = Number.isFinite(pct) && pct > 0 ? `${pct.toFixed(1)}%` : '';
  const stale = state === 'stale';
  return `<span class="admin-sp-saving${stale ? ' admin-sp-saving--stale' : ''}">
    <span class="admin-sp-saving__amount cell-mono">${esc(money(row.saving_vs_next))}</span>
    ${pctText ? `<span class="admin-sp-saving__pct">${esc(pctText)}</span>` : ''}
    ${stale ? `<span class="admin-sp-saving__warn" data-tooltip="${esc(
      `The cheapest price is ${ageLabel(cheapestAge(row))} — confirm it before ordering`)}">${esc(
      'stale price')}</span>` : ''}
  </span>`;
}

function cheapestAge(row) {
  const entry = supplierEntry(row, row && row.cheapest_supplier);
  return entry ? entry.age_days : null;
}

function renderWePayCell(row) {
  const current = row.current_cost_price;
  if (current == null) {
    return `<span class="cell-right admin-text-muted" data-tooltip="${esc(
      'The catalogue holds no cost for this product, so we cannot say whether the cheapest offer beats it'
    )}">${MISSING}</span>`;
  }
  const swap = switchOpportunity(row);
  return `<span class="cell-right cell-mono${swap ? ' admin-sp-wepay--beatable' : ''}">${esc(money(current))}</span>`;
}

function buildColumns() {
  const cols = [
    {
      key: 'sku', label: 'SKU', className: 'col-w-sku',
      render: (r) => `<span class="cell-mono">${esc(r.sku || MISSING)}</span>`,
    },
    {
      key: 'name', label: 'Product',
      render: (r) => {
        const colour = r.color ? `<span class="admin-sp-colour">${esc(r.color)}</span>` : '';
        return `<div><div class="cell-truncate">${esc(r.name || MISSING)}</div>
          <div class="admin-sp-sub">${esc(r.product_type || '')}${colour ? ' · ' : ''}${colour}</div></div>`;
      },
    },
    {
      key: 'brand', label: 'Brand', className: 'col-w-brand',
      render: (r) => esc(r.brand || MISSING),
    },
  ];

  // One column per supplier in the feed list — never a fixed pair. `suppliers[]`
  // on a row is cheapest-first and its names vary per row, so each cell looks its
  // own supplier up by name (handoff §3).
  for (const name of supplierColumns(_suppliers)) {
    cols.push({
      key: `supplier:${name}`, label: name, align: 'right',
      render: (r) => renderSupplierCell(r, name),
    });
  }

  cols.push(
    {
      key: 'current_cost_price', label: 'We pay now', align: 'right',
      render: renderWePayCell,
    },
    {
      key: 'saving_vs_next', label: 'Saving', align: 'right',
      render: renderSavingCell,
    },
    {
      key: 'retail_price', label: 'Retail', align: 'right',
      render: (r) => `<span class="cell-right cell-mono admin-text-muted">${esc(money(r.retail_price))}</span>`,
    },
  );
  return cols;
}

/** Hand DataTable one client-side slice plus a matching pagination object. */
function paintTable() {
  if (!_table) return;
  const total = _filtered.length;
  const pages = Math.max(1, Math.ceil(total / _limit));
  if (_page > pages) _page = pages;
  const start = (_page - 1) * _limit;
  const slice = _filtered.slice(start, start + _limit);
  _table.config.columns = buildColumns();
  _table.config.emptyMessage = emptyMessage();
  _table.setData(slice, { page: _page, limit: _limit, total });
}

function emptyMessage() {
  if (_loading) return 'Loading…';
  const base = COVERAGE[_tab] ? COVERAGE[_tab].empty : 'Nothing matches these filters.';
  const extra = [];
  if (_freshOnly) extra.push('"Cheapest price is current" is on');
  if (_switchOnly) extra.push('"Would change supplier" is on');
  if (!extra.length) return base;
  // Naming the client-side chip matters: it is the one filter that is not in the
  // URL the server saw, so "no results" is otherwise unattributable.
  return `${base} ${extra.join(' and ')} — turn ${extra.length === 1 ? 'it' : 'them'} off to see the rest.`;
}

// ── Loading ────────────────────────────────────────────────────────────────

function serverParams() {
  const p = { coverage: _tab === 'review' ? 'multi' : _tab, sort: _sort };
  if (_search) p.search = _search;
  if (_brand) p.brand = _brand;
  if (_type) p.product_type = _type;
  // min_saving is meaningless on the single-source tab: every row there has a
  // saving of 0, so any positive threshold empties the tab. The control is
  // hidden there (see renderFilters) and the param is not sent either way.
  if (_minSaving && _tab === 'multi') p.min_saving = _minSaving;
  return p;
}

async function loadCompare() {
  const myGen = ++_gen;
  _loading = true;
  if (_table) _table.setLoading(true);
  const result = await AdminAPI.supplierOffers.compareAll(serverParams(), {
    isStale: () => myGen !== _gen || !_alive,
  });
  if (myGen !== _gen || !_alive) return; // superseded — do not paint over the newer load
  _loading = false;

  _rows = result.rows;
  _suppliers = result.suppliers;
  _meta = result.meta;
  _complete = result.complete;
  _staleDays = staleAfterDays(result.meta);

  // Refresh the option lists only from an UNFILTERED read, or a brand filter
  // would shrink the brand dropdown to the one brand already chosen.
  if (!_brand && !_type && !_search && !_minSaving) {
    _brandOptions = uniqueSorted(_rows.map((r) => r.brand));
    _typeOptions = uniqueSorted(_rows.map((r) => r.product_type));
  }

  applyFiltersAndPaint();
}

function uniqueSorted(values) {
  return [...new Set(values.filter((v) => typeof v === 'string' && v))].sort((a, b) =>
    a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
}

function applyFiltersAndPaint() {
  _filtered = applyClientFilters(_rows, { freshOnly: _freshOnly, switchOnly: _switchOnly });
  refreshFilterOptions();
  renderFreshness();
  renderHonesty();
  renderIncompleteNote();
  renderTabCounts();
  paintTable();
}

async function loadReview() {
  const myGen = ++_gen;
  // The Compare tab loads this in the background purely to fill the review tab's
  // count badge, and BOTH views render into #sp-table. Painting from here while
  // another tab owns that element replaced the whole comparison table with the
  // review queue — so every write below is gated on actually being the visible tab.
  if (_tab === 'review') {
    const host = _container.querySelector('#sp-table');
    if (host) host.innerHTML = '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>';
  }
  const params = {};
  if (_reviewSearch) params.search = _reviewSearch;
  if (_reviewSupplier) params.supplier = _reviewSupplier;
  const result = await AdminAPI.supplierOffers.unmatchedAll(params, {
    isStale: () => myGen !== _gen || !_alive,
  });
  if (myGen !== _gen || !_alive) return;
  _reviewRows = result.rows;
  _reviewMeta = result.meta;
  _reviewComplete = result.complete;
  // The count badge is the whole point of the background load, so it updates
  // either way; the table paint is what has to stay behind the tab check.
  renderTabCounts();
  if (_tab === 'review') {
    renderIncompleteNote();
    renderReview();
  }
}

// ── The review queue ───────────────────────────────────────────────────────

function reviewSets() {
  const { actionable, noise } = partitionUnmatched(_reviewRows);
  return { actionable, noise, shown: _reviewShowAll ? _reviewRows : actionable };
}

function renderReview() {
  // Never paint into #sp-table unless the review tab actually owns it. See loadReview().
  if (_tab !== 'review') return;
  const host = _container.querySelector('#sp-table');
  if (!host) return;
  const { actionable, noise, shown } = reviewSets();
  // by_reason is server-computed and DOES respect supplier=/search= (measured),
  // so it is the trustworthy count. What it cannot do is return only those rows.
  const counts = (_reviewMeta && _reviewMeta.by_reason) || countByReason(_reviewRows);

  const chips = Object.keys(counts).sort().map((reason) => {
    const meta = reasonMeta(reason);
    return `<span class="admin-sp-reason${meta.actionable ? ' admin-sp-reason--actionable' : ''}"
      data-tooltip="${esc(`${meta.meaning} ${meta.action}`)}">
      <span class="admin-sp-reason__label">${esc(meta.label)}</span>
      <span class="admin-sp-reason__count">${esc(String(counts[reason]))}</span>
    </span>`;
  }).join('');

  const pages = Math.max(1, Math.ceil(shown.length / _limit));
  if (_reviewPage > pages) _reviewPage = pages;
  const start = (_reviewPage - 1) * _limit;
  const slice = shown.slice(start, start + _limit);

  const rowsHtml = slice.length ? slice.map(renderReviewRow).join('') : '';

  host.innerHTML = `
    <div class="admin-sp-review">
      <div class="admin-sp-review__head">
        <div class="admin-sp-review__chips">${chips}</div>
        <label class="admin-sp-review__toggle">
          <input type="checkbox" id="sp-review-all" ${_reviewShowAll ? 'checked' : ''}>
          <span>${esc(`Show all ${_reviewRows.length} lines (adds ${noise.length} we probably do not stock)`)}</span>
        </label>
      </div>
      <div class="admin-sp-review__intro">${esc(
        _reviewShowAll
          ? `Showing every unmatched supplier line. ${actionable.length} of them need a decision; the rest `
            + 'are lines with no catalogue match, which is usually nothing to act on.'
          : `${actionable.length} supplier line${actionable.length === 1 ? '' : 's'} need${actionable.length === 1 ? 's' : ''} `
            + `a decision. ${noise.length} more had no catalogue match at all and are hidden — those are `
            + 'usually products we do not stock.')}</div>
      ${rowsHtml ? `<div class="admin-sp-review__list">${rowsHtml}</div>` : `
        <div class="admin-empty">
          <div class="admin-empty__title">${esc('Nothing needs a decision')}</div>
          <div class="admin-empty__text">${esc(
            _reviewRows.length
              ? 'Every unmatched line here is a "no catalogue match" — tick "Show all" to see them.'
              : 'No unmatched supplier lines for these filters.')}</div>
        </div>`}
      ${shown.length > _limit ? renderReviewPager(shown.length, pages) : ''}
    </div>`;
}

function renderReviewPager(total, pages) {
  const from = (_reviewPage - 1) * _limit + 1;
  const to = Math.min(total, _reviewPage * _limit);
  return `<div class="admin-pagination">
    <div class="admin-pagination__info">${esc(`${from}–${to} of ${total}`)}</div>
    <div class="admin-pagination__btns">
      <button class="admin-pagination__btn" data-sp-review-page="${_reviewPage - 1}" ${_reviewPage <= 1 ? 'disabled' : ''}>Prev</button>
      <button class="admin-pagination__btn" data-sp-review-page="${_reviewPage + 1}" ${_reviewPage >= pages ? 'disabled' : ''}>Next</button>
    </div>
  </div>`;
}

function renderReviewRow(offer) {
  const meta = reasonMeta(offer.reason);
  const conflict = colourTailConflict(offer);
  const bits = [
    offer.brand ? `Brand ${offer.brand}` : '',
    offer.model_number ? `Model ${offer.model_number}` : 'No model number',
    offer.color ? `Colour ${offer.color}` : '',
    offer.product_type || '',
  ].filter(Boolean).join(' · ');

  return `<div class="admin-sp-offer${meta.actionable ? ' admin-sp-offer--actionable' : ''}">
    <div class="admin-sp-offer__main">
      <div class="admin-sp-offer__sku cell-mono">${esc(offer.supplier_sku || MISSING)}</div>
      <div class="admin-sp-offer__meta">${esc(bits)}</div>
      ${conflict ? `<div class="admin-sp-offer__conflict">${esc(
        `The feed says ${conflict.stated}, but this code ends in ${String(offer.supplier_sku).slice(-1).toUpperCase()} `
        + `which usually means ${conflict.implied}. That disagreement is why it could not be matched.`)}</div>` : ''}
    </div>
    <div class="admin-sp-offer__facts">
      <div>${esc(offer.supplier_name || MISSING)}</div>
      <div class="cell-mono">${esc(money(offer.cost_nzd))}</div>
      <div class="admin-sp-offer__age">${esc(offer.last_seen_at ? shortDate(offer.last_seen_at) : 'date unknown')}</div>
    </div>
    <div class="admin-sp-offer__reason">
      <span class="admin-sp-reason${meta.actionable ? ' admin-sp-reason--actionable' : ''}">${esc(meta.label)}</span>
      <div class="admin-sp-offer__action">${esc(meta.action)}</div>
    </div>
    <div class="admin-sp-offer__cta">
      ${meta.actionable ? `<button class="admin-btn admin-btn--ghost admin-btn--sm"
        data-sp-map="${esc(offer.offer_id || '')}">Map to product…</button>` : ''}
    </div>
  </div>`;
}

// ── Mapping a line by hand ─────────────────────────────────────────────────

function openMapModal(offerId) {
  const offer = _reviewRows.find((o) => o.offer_id === offerId);
  if (!offer) { Toast.error('That supplier line is no longer in the queue — reload to refresh it.'); return; }
  const conflict = colourTailConflict(offer);

  const modal = Modal.open({
    title: 'Map a supplier line to a product',
    className: 'admin-sp-modal',
    onClose: destroyAutocompletes,
    body: `
      <div class="admin-sp-map">
        <div class="admin-sp-map__offer">
          <div class="cell-mono admin-sp-map__sku">${esc(offer.supplier_sku || MISSING)}</div>
          <div class="admin-sp-map__meta">${esc([
            offer.supplier_name, offer.brand, offer.model_number, offer.color, money(offer.cost_nzd),
          ].filter(Boolean).join(' · '))}</div>
          ${conflict ? `<div class="admin-sp-offer__conflict">${esc(
            `The feed calls this ${conflict.stated}; the code ends in a letter that usually means `
            + `${conflict.implied}. Check which one the product actually is before mapping.`)}</div>` : ''}
        </div>

        <div class="admin-form-group">
          <label for="sp-map-product">Product</label>
          <input class="admin-input" id="sp-map-product" type="text" autocomplete="off"
                 placeholder="Search our catalogue by SKU or name…">
          <div class="admin-form-help" id="sp-map-chosen">${esc('No product chosen yet.')}</div>
        </div>

        <div class="admin-form-group">
          <label for="sp-map-note">Note (optional)</label>
          <input class="admin-input" id="sp-map-note" type="text" autocomplete="off"
                 placeholder="e.g. feed colour says Black; the M tail means Magenta">
          <div class="admin-form-help">${esc(
            'Why this pairing is right. Worth writing — nobody else can see what you saw.')}</div>
        </div>

        <div class="admin-sp-map__permanence">
          <strong>${esc('This is permanent until you unpin it.')}</strong>
          ${esc('The mapping applies straight away and is re-applied on every future import, so this line '
            + 'never comes back to this queue. Mapped once, remembered forever. To undo it later, use '
            + 'Manual mappings below the table.')}
        </div>
      </div>`,
    footer: `
      <button class="admin-btn admin-btn--ghost" id="sp-map-cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" id="sp-map-save" disabled>Map it</button>`,
  });
  if (!modal) return;

  let chosen = null;
  const input = modal.el.querySelector('#sp-map-product');
  const chosenLabel = modal.el.querySelector('#sp-map-chosen');
  const saveBtn = modal.el.querySelector('#sp-map-save');

  const handle = attachProductAutocomplete(input, {
    onPick: (product) => {
      chosen = product;
      input.value = product.sku || product.name || '';
      chosenLabel.textContent = `${product.sku || '(no SKU)'} — ${product.name || 'unnamed product'}`;
      saveBtn.disabled = !product.sku && !product.id;
    },
  });
  // The menu is portalled to <body>; without this it survives the modal (ERR-107).
  _acHandles.push(handle);

  input.addEventListener('input', () => {
    if (!chosen) return;
    // Typing after a pick invalidates it — otherwise the label keeps naming a
    // product the box no longer shows, and the wrong SKU gets pinned.
    chosen = null;
    chosenLabel.textContent = 'No product chosen yet.';
    saveBtn.disabled = true;
  });

  modal.el.querySelector('#sp-map-cancel').addEventListener('click', () => Modal.close());

  saveBtn.addEventListener('click', async () => {
    if (!chosen) return;
    let payload;
    try {
      payload = mapPayload({
        supplierName: offer.supplier_name,
        supplierSku: offer.supplier_sku,
        productSku: chosen.sku || '',
        productId: chosen.sku ? '' : (chosen.id || ''),
        note: modal.el.querySelector('#sp-map-note').value,
      });
    } catch (e) {
      Toast.error(e.message);
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Mapping…';
    try {
      const result = await AdminAPI.supplierOffers.map(payload);
      Modal.close();
      const updated = Number(result && result.offers_updated);
      const mappingId = result && result.mapping && result.mapping.id;
      toastWithUndo(
        `Mapped ${offer.supplier_sku} → ${payload.product_sku || payload.product_id}`
        + (Number.isFinite(updated) ? ` (${updated} offer${updated === 1 ? '' : 's'} updated)` : ''),
        mappingId,
      );
      await refreshAll();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Map it';
      Toast.error(e.message || 'Could not map that supplier line.');
    }
  });
}

/**
 * Success toast with an Undo — the quick path. Since 2026-09-21 it is not the
 * only one: the Mappings panel lists every pin and can remove any of them.
 */
function toastWithUndo(message, mappingId) {
  const el = Toast.success(message, 12000);
  if (!el || !mappingId) return;
  const btn = document.createElement('button');
  btn.className = 'admin-toast__undo';
  btn.type = 'button';
  btn.textContent = 'Undo';
  btn.title = 'Remove the pin and let automatic matching decide again. '
    + 'You can also remove it later from the Manual mappings panel below the table.';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    try {
      await AdminAPI.supplierOffers.unmap(mappingId);
      Toast.info('Mapping removed. Automatic matching decides this line again.');
      await refreshAll();
      if (_mapLoaded) loadMappings();
    } catch (e) {
      Toast.error(e.message || 'Could not undo that mapping.');
    }
  });
  el.querySelector('.admin-toast__message')?.after(btn);
}

async function refreshAll() {
  // A successful map changes BOTH tabs: the line leaves the review queue and the
  // product gains a supplier. Refetching one would leave the other lying.
  await loadReview();
  if (_tab !== 'review') await loadCompare();
  if (_mapLoaded) loadMappings();
}

// ── Manual mappings (Ask 4) ────────────────────────────────────────────────

let _mapPage = 1;
let _mapSearch = '';
let _mapLoaded = false;
let _mapGen = 0;
const MAP_LIMIT = 50;

async function loadMappings() {
  const host = _container && _container.querySelector('#sp-mappings-body');
  if (!host) return;
  _mapLoaded = true;
  const gen = ++_mapGen;
  host.innerHTML = '<div class="admin-sp-mappings__status">Loading mappings…</div>';
  let res;
  try {
    res = await AdminAPI.supplierOffers.mappings({ page: _mapPage, limit: MAP_LIMIT, search: _mapSearch });
  } catch (e) {
    if (gen !== _mapGen || !_container) return;
    // A failed read must not look like "no mappings".
    host.innerHTML = `<div class="admin-sp-mappings__status admin-sp-mappings__status--error">
      Could not load the mappings — ${esc(e.message || 'request failed')}. This is a failed read, not an empty list.</div>`;
    return;
  }
  if (gen !== _mapGen || !_container) return;
  const { rows, meta } = res;
  const total = meta && Number.isFinite(Number(meta.total)) ? Number(meta.total) : null;
  const count = _container.querySelector('#sp-mappings-count');
  if (count) count.textContent = total === null ? '' : `(${total})`;
  if (!rows.length) {
    host.innerHTML = `<div class="admin-sp-mappings__status">${_mapSearch
      ? `No mappings match “${esc(_mapSearch)}”.`
      : 'No manual mappings. Automatic matching decides every supplier line.'}</div>`;
    return;
  }
  host.innerHTML = `
    <table class="admin-table admin-sp-mappings__table">
      <thead><tr><th>Supplier line</th><th>Pinned to</th><th>Note</th><th>Pinned</th><th></th></tr></thead>
      <tbody>${rows.map((m) => `
        <tr>
          <td><div>${esc(m.supplier_name || MISSING)}</div><div class="cell-mono">${esc(m.supplier_sku || MISSING)}</div></td>
          <td>${m.product_resolved === false
            ? `<span class="admin-badge admin-badge--failed" title="The pinned product no longer resolves — it was deleted or its SKU changed">product gone</span> <span class="cell-mono">${esc(m.product_sku || m.product_id || MISSING)}</span>`
            : `<div class="cell-mono">${esc(m.product_sku || MISSING)}</div><div class="admin-text-muted">${esc(m.product_name || '')}</div>`}</td>
          <td>${esc(m.note || '')}</td>
          <td>${esc(m.created_at ? new Date(m.created_at).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : MISSING)}</td>
          <td><button class="admin-btn admin-btn--ghost admin-btn--sm" data-sp-unmap="${esc(m.id)}"
            data-sp-unmap-label="${esc(`${m.supplier_sku || ''} → ${m.product_sku || ''}`)}">Unpin</button></td>
        </tr>`).join('')}</tbody>
    </table>
    ${total !== null && total > MAP_LIMIT ? `<div class="admin-sp-mappings__pager">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-sp-map-page="prev" ${_mapPage <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${_mapPage} of ${Math.ceil(total / MAP_LIMIT)}</span>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-sp-map-page="next" ${_mapPage * MAP_LIMIT >= total ? 'disabled' : ''}>Next</button>
    </div>` : ''}`;
}

function bindMappingsPanel() {
  const panel = _container.querySelector('#sp-mappings');
  if (!panel) return;
  panel.addEventListener('toggle', () => { if (panel.open && !_mapLoaded) loadMappings(); });
  let t = null;
  panel.querySelector('#sp-mappings-search')?.addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { _mapSearch = e.target.value.trim(); _mapPage = 1; loadMappings(); }, 300);
  });
  panel.addEventListener('click', (e) => {
    const pager = e.target.closest('[data-sp-map-page]');
    if (pager && !pager.disabled) {
      _mapPage += pager.dataset.spMapPage === 'next' ? 1 : -1;
      loadMappings();
      return;
    }
    const btn = e.target.closest('[data-sp-unmap]');
    if (!btn) return;
    Modal.confirm({
      title: 'Unpin this mapping?',
      message: `${btn.dataset.spUnmapLabel}. Automatic matching decides this supplier line again on the next import — it may match a different product, or none.`,
      confirmLabel: 'Unpin',
      onConfirm: async () => {
        try {
          await AdminAPI.supplierOffers.unmap(btn.dataset.spUnmap);
          Toast.info('Mapping removed. Automatic matching decides this line again.');
          await refreshAll();
        } catch (e2) {
          Toast.error(e2.message || 'Could not remove that mapping.');
        }
      },
    });
  });
}

// ── Loading a new price list (Ask 5) ───────────────────────────────────────

const PRICE_LIST_MAX_BYTES = 20 * 1024 * 1024;
const PRICE_LIST_TYPES = /\.(xlsx|ods|csv|txt)$/i;

function bytesLabel(n) {
  if (!Number.isFinite(n)) return MISSING;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function loadFeedSlot() {
  const host = _container && _container.querySelector('#sp-import-slot');
  if (!host) return;
  host.textContent = 'Reading the stored file…';
  try {
    const files = await AdminAPI.supplierOffers.feedFiles();
    if (!_container) return;
    const slot = files.find((f) => f && f.feedType === 'product-list');
    host.innerHTML = !slot
      ? 'The server lists no <code>product-list</code> slot.'
      : slot.exists
        ? `Stored now: <strong>${esc(slot.filename || MISSING)}</strong> · ${esc(bytesLabel(Number(slot.size)))} · uploaded ${esc(slot.updated_at ? new Date(slot.updated_at).toLocaleString('en-NZ') : MISSING)}`
        : 'No price list is stored yet.';
  } catch (e) {
    if (_container) host.textContent = `Could not read the stored file — ${e.message || 'request failed'}.`;
  }
}

function bindImportPanel() {
  const panel = _container.querySelector('#sp-import');
  if (!panel) return;
  const input = panel.querySelector('#sp-import-file');
  const uploadBtn = panel.querySelector('#sp-import-upload');
  const runBtn = panel.querySelector('#sp-import-run');
  const status = panel.querySelector('#sp-import-status');
  const say = (html, tone = '') => { status.className = `admin-sp-import__status${tone ? ` admin-sp-import__status--${tone}` : ''}`; status.innerHTML = html; };
  let slotLoaded = false;
  panel.addEventListener('toggle', () => { if (panel.open && !slotLoaded) { slotLoaded = true; loadFeedSlot(); } });

  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    uploadBtn.disabled = true;
    if (!f) { say(''); return; }
    if (!PRICE_LIST_TYPES.test(f.name)) { say(`${esc(f.name)} is not a .xlsx, .ods, .csv or .txt file.`, 'error'); return; }
    if (f.size > PRICE_LIST_MAX_BYTES) { say(`${esc(f.name)} is ${esc(bytesLabel(f.size))} — the limit is 20 MB.`, 'error'); return; }
    uploadBtn.disabled = false;
    say(`Ready to upload ${esc(f.name)} (${esc(bytesLabel(f.size))}). It replaces the stored file.`);
  });

  uploadBtn.addEventListener('click', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    uploadBtn.disabled = true;
    say(`Uploading ${esc(f.name)}…`);
    try {
      await AdminAPI.supplierOffers.uploadPriceList(f);
      say(`<strong>${esc(f.name)} is stored.</strong> Nothing on this page changes until you run the import.`, 'ok');
      input.value = '';
      loadFeedSlot();
    } catch (e) {
      uploadBtn.disabled = false;
      say(`Upload failed${e.status ? ` (HTTP ${e.status})` : ''}: ${esc(e.message || 'request failed')}`, 'error');
    }
  });

  runBtn.addEventListener('click', () => {
    Modal.confirm({
      title: 'Run the price-list import?',
      message: 'This parses the stored price list and rewrites every supplier offer from it. It can take a minute. Manual mappings are re-applied.',
      confirmLabel: 'Run import',
      confirmClass: 'admin-btn--primary',
      onConfirm: async () => {
        runBtn.disabled = true;
        say('<span class="admin-loading__spinner admin-loading__spinner--inline"></span> Importing — this can take a minute. Keep this page open.');
        try {
          const r = await AdminAPI.supplierOffers.importPriceList();
          const matched = Number(r && r.offers_matched);
          const total = Number(r && r.offers_total);
          const secs = Number(r && r.duration_ms) / 1000;
          say(Number.isFinite(matched) && Number.isFinite(total)
            ? `<strong>Import finished:</strong> ${matched.toLocaleString('en-NZ')} of ${total.toLocaleString('en-NZ')} lines matched a product${Number.isFinite(secs) ? ` in ${secs.toFixed(0)}s` : ''}. The rest are in the review tab.`
            // Success without the counts is still success — but say the counts are missing.
            : '<strong>Import finished.</strong> The server did not report how many lines matched.', 'ok');
          await refreshAll();
        } catch (e) {
          const why = e.status === 409 ? 'an import is already running — wait for it to finish, then reload'
            : e.status === 404 ? 'no price list is stored — upload one first'
            : e.status === 403 ? 'the server refused this account (the gate may be cron-only again)'
            : (e.message || 'request failed');
          say(`Import did not run${e.status ? ` (HTTP ${e.status})` : ''}: ${esc(why)}.`, 'error');
        } finally {
          runBtn.disabled = false;
        }
      },
    });
  });
}

// ── The per-product drawer ─────────────────────────────────────────────────

function openRowDrawer(row) {
  if (!row) return;
  const entries = Array.isArray(row.suppliers) ? row.suppliers : [];
  const current = row.current_cost_price;

  const supplierRows = entries.map((e) => {
    const cheapest = e.supplier_name === row.cheapest_supplier;
    const vsCurrent = (current != null && Number.isFinite(Number(e.cost_nzd)))
      ? Number(e.cost_nzd) - Number(current) : null;
    return `<tr class="${cheapest ? 'admin-sp-drawer__cheapest' : ''}">
      <td>${esc(e.supplier_name || MISSING)}${cheapest ? ` <span class="admin-badge admin-badge--paid">cheapest</span>` : ''}</td>
      <td class="cell-mono">${esc(e.supplier_sku || MISSING)}</td>
      <td class="cell-mono cell-right">${esc(money(e.cost_nzd))}</td>
      <td>${esc(ageLabel(e.age_days, e.last_seen_at))}</td>
      <td class="cell-right">${esc(vsCurrentLabel(vsCurrent))}</td>
      <td>${esc(matchMethodLabel(e.match_method))}</td>
    </tr>`;
  }).join('');

  const state = savingState(row);
  const swap = switchOpportunity(row);
  const verdict = verdictFor(row, state, swap);

  Drawer.open({
    title: row.sku ? `${row.sku} — supplier prices` : 'Supplier prices',
    body: `
      <div class="admin-sp-drawer">
        <div class="admin-sp-drawer__name">${esc(row.name || '')}</div>
        <div class="admin-sp-drawer__facts">
          <span>${esc(row.brand || MISSING)}</span>
          <span>${esc(row.product_type || MISSING)}</span>
          <span>${esc(row.color || MISSING)}</span>
          <span>${esc(row.is_active ? 'Active' : 'Inactive')}</span>
        </div>

        <div class="admin-sp-drawer__verdict admin-sp-drawer__verdict--${esc(verdict.tone)}">
          ${esc(verdict.text)}
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr>
              <th>Supplier</th><th>Their code</th><th class="cell-right">Cost</th>
              <th>Price age</th><th class="cell-right">vs what we pay</th><th>How it matched</th>
            </tr></thead>
            <tbody>${supplierRows || `<tr><td colspan="6">${esc('No supplier offers on this product.')}</td></tr>`}</tbody>
          </table>
        </div>

        <div class="admin-sp-drawer__money">
          <div><span>We pay now</span><strong>${esc(money(current))}</strong></div>
          <div><span>Retail</span><strong>${esc(money(row.retail_price))}</strong></div>
          <div><span>Suppliers</span><strong>${esc(String(row.supplier_count ?? entries.length))}</strong></div>
        </div>

        <div class="admin-sp-drawer__note">${esc(
          'Costs are what the supplier charges us. "vs what we pay" compares each offer with the cost '
          + 'currently held on the product in the catalogue; a blank means the catalogue holds no cost, '
          + 'which is not the same as a cost of zero.')}</div>
      </div>`,
    footer: `<button class="admin-btn admin-btn--ghost" id="sp-drawer-close">Close</button>`,
  });
  document.getElementById('sp-drawer-close')?.addEventListener('click', () => Drawer.close());
}

/**
 * A supplier's cost against what the catalogue says we pay today.
 *
 * An exact match renders "same", not "$0.00". This is the one place on the page a
 * legitimate zero occurs, and printing it as money puts a "$0.00" on screen that
 * is indistinguishable at a glance from the absent and unknown cases the rest of
 * the page is careful to render as an em-dash. Saying "same" states the fact
 * instead of leaving the reader to work out which kind of zero it is.
 */
function vsCurrentLabel(delta) {
  if (delta == null) return MISSING;
  if (Math.abs(delta) < 0.005) return 'same';
  return (delta > 0 ? '+' : '') + money(delta);
}

const MATCH_METHOD_LABELS = {
  exact_sku: 'Their code matched our SKU exactly',
  constructed_sku: 'Matched by rebuilding our SKU from their code',
  sku_redirect: 'Matched through a known code redirect',
  manual: 'Pinned by hand from the review queue',
};
function matchMethodLabel(method) {
  if (!method) return MISSING;
  // An unrecognised method is shown raw rather than dropped — a new matcher
  // strategy should be visible the day it ships, not silently rendered as blank.
  return MATCH_METHOD_LABELS[method] || `${method} (unrecognised by this build)`;
}

function verdictFor(row, state, swap) {
  if (state === 'single') {
    return { tone: 'neutral', text: 'Only one supplier quotes this product, so there is nothing to compare. '
      + 'Worth asking a second supplier for a price.' };
  }
  if (state === 'tie') {
    return { tone: 'neutral', text: 'Every supplier quotes the same price. Nothing to gain by switching.' };
  }
  const age = ageLabel(cheapestAge(row));
  if (state === 'stale') {
    return {
      tone: 'warn',
      text: `${row.cheapest_supplier} is cheapest by ${money(row.saving_vs_next)} per unit — but that price was `
        + `${age}. Confirm it with them before ordering; a saving this old is a reason to ask for a current `
        + 'list, not a reason to buy.',
    };
  }
  return {
    tone: 'good',
    text: `${row.cheapest_supplier} is cheapest by ${money(row.saving_vs_next)} per unit, on a price `
      + `${age}.${swap === true ? ' That beats what the catalogue says we pay today.'
        : swap === false ? ' We already buy at that price or better.'
        : ' The catalogue holds no cost for this product, so we cannot say whether it beats what we pay.'}`,
  };
}

// ── Export ─────────────────────────────────────────────────────────────────

/** The FULL filtered set, never the visible page — an export of page 1 of 4 is a lie. */
function exportCsv() {
  const rows = _tab === 'review' ? reviewSets().shown : _filtered;
  if (!rows.length) { Toast.info('Nothing to export for the current filters.'); return; }
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let headers; let lines;
  if (_tab === 'review') {
    headers = ['Supplier', 'Supplier SKU', 'Brand', 'Model', 'Colour', 'Type', 'Cost NZD', 'Last seen', 'Reason'];
    lines = rows.map((o) => [o.supplier_name, o.supplier_sku, o.brand, o.model_number, o.color,
      o.product_type, o.cost_nzd, o.last_seen_at, o.reason].map(q).join(','));
  } else {
    const names = supplierColumns(_suppliers);
    headers = ['SKU', 'Product', 'Brand', 'Type', 'Colour',
      ...names.flatMap((n) => [`${n} cost`, `${n} price age (days)`]),
      'We pay now', 'Cheapest supplier', 'Saving per unit', 'Saving %',
      'Cheapest price is stale', 'Retail'];
    lines = rows.map((r) => {
      const cells = [r.sku, r.name, r.brand, r.product_type, r.color];
      for (const n of names) {
        const e = supplierEntry(r, n);
        // Blank, not 0 — a spreadsheet will happily average a fabricated zero.
        cells.push(e ? e.cost_nzd : '', e ? e.age_days : '');
      }
      cells.push(r.current_cost_price ?? '', r.cheapest_supplier,
        savingState(r) === 'single' ? '' : r.saving_vs_next,
        savingState(r) === 'single' ? '' : r.saving_vs_next_percent,
        r.cheapest_is_stale ? 'yes' : 'no', r.retail_price ?? '');
      return cells.map(q).join(',');
    });
  }
  const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `supplier-prices-${_tab}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  Toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
}

// ── Shell ──────────────────────────────────────────────────────────────────

function renderTabCounts() {
  for (const tab of TABS) {
    const el = _container.querySelector(`[data-sp-tab="${tab.id}"] .admin-sp-tabcount`);
    if (!el) continue;
    if (tab.id === _tab && tab.id !== 'review') el.textContent = String(_filtered.length);
    else if (tab.id === 'review') {
      const { actionable } = partitionUnmatched(_reviewRows);
      el.textContent = _reviewRows.length ? String(actionable.length) : '';
    } else el.textContent = '';
  }
}

function refreshFilterOptions() {
  const brand = _container.querySelector('#sp-brand');
  if (brand && brand.dataset.filled !== String(_brandOptions.length)) {
    brand.innerHTML = `<option value="">All brands</option>`
      + _brandOptions.map((b) => `<option value="${esc(b)}"${b === _brand ? ' selected' : ''}>${esc(b)}</option>`).join('');
    brand.dataset.filled = String(_brandOptions.length);
  }
  const type = _container.querySelector('#sp-type');
  if (type && type.dataset.filled !== String(_typeOptions.length)) {
    type.innerHTML = `<option value="">All types</option>`
      + _typeOptions.map((t) => `<option value="${esc(t)}"${t === _type ? ' selected' : ''}>${esc(t)}</option>`).join('');
    type.dataset.filled = String(_typeOptions.length);
  }
}

function renderFilters() {
  const host = _container.querySelector('#sp-filters');
  if (!host) return;
  if (_tab === 'review') {
    const suppliers = uniqueSorted(_suppliers.map((s) => s.supplier_name));
    host.innerHTML = `
      <div class="admin-search">
        <span class="admin-search__icon">${icon('search', 14, 14)}</span>
        <input type="search" id="sp-review-search" placeholder="Search supplier code or brand…"
               autocomplete="off" value="${esc(_reviewSearch)}">
      </div>
      <select class="admin-select" id="sp-review-supplier">
        <option value="">All suppliers</option>
        ${suppliers.map((s) => `<option value="${esc(s)}"${s === _reviewSupplier ? ' selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="sp-export">${icon('download', 14, 14)} Export CSV</button>`;
    return;
  }
  host.innerHTML = `
    <div class="admin-search admin-search--wide">
      <span class="admin-search__icon">${icon('search', 14, 14)}</span>
      <input type="search" id="sp-search" placeholder="Search SKU or product name…"
             autocomplete="off" value="${esc(_search)}">
    </div>
    <select class="admin-select" id="sp-brand" data-filled=""><option value="">All brands</option></select>
    <select class="admin-select" id="sp-type" data-filled=""><option value="">All types</option></select>
    ${_tab === 'multi' ? `<input class="admin-input admin-sp-minsaving" id="sp-min-saving" type="number"
       min="0" step="0.5" placeholder="Min saving $" value="${esc(_minSaving)}">` : ''}
    <select class="admin-select" id="sp-sort">
      ${SORTS.map((s) => `<option value="${esc(s.value)}"${s.value === _sort ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
    </select>
    <button class="filter-chip${_freshOnly ? ' active' : ''}" id="sp-chip-fresh" type="button"
      data-tooltip="${esc('The API has no staleness filter — this one runs over every row already loaded.')}"
      >Cheapest price is current</button>
    <button class="filter-chip${_switchOnly ? ' active' : ''}" id="sp-chip-switch" type="button"
      data-tooltip="${esc('Only rows where the cheapest offer beats the cost held on the product today.')}"
      >Would change supplier</button>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" id="sp-export">${icon('download', 14, 14)} Export CSV</button>`;
  refreshFilterOptions();
}

function renderShell() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <div>
        <h1 class="admin-page-title">Supplier Prices</h1>
        <p class="admin-page-subtitle">${esc(
          'Which supplier is cheapest for each product, and how old that price is.')}</p>
      </div>
      <div class="admin-page-header__actions">
        <button class="admin-btn admin-btn--ghost admin-btn--sm" id="sp-reload">${icon('refresh', 14, 14)} Reload</button>
      </div>
    </div>

    <div class="admin-sp-scope">${esc(
      'Compatible products only. Around three quarters of the active catalogue is genuine stock bought '
      + 'from a single supplier (DSNZ), so there is nothing to compare on those and they never appear here.')}</div>

    <div id="sp-freshness"></div>
    <div id="sp-incomplete"></div>
    <div id="sp-honesty"></div>

    <div class="admin-tabs" id="sp-tabs" role="tablist" aria-label="Supplier price views">
      ${TABS.map((t) => `<button class="admin-tab${t.id === _tab ? ' active' : ''}" role="tab"
        aria-selected="${t.id === _tab}" data-sp-tab="${t.id}">${esc(t.label)}
        <span class="admin-sp-tabcount"></span></button>`).join('')}
    </div>
    <div class="admin-sp-blurb" id="sp-blurb"></div>

    <div class="admin-toolbar admin-sp-filters" id="sp-filters"></div>

    <div id="sp-table"></div>

    <details class="admin-card admin-sp-mappings" id="sp-mappings">
      <summary>Manual mappings <span id="sp-mappings-count" class="admin-text-muted"></span></summary>
      <div class="admin-sp-mappings__intro">${esc('Supplier lines pinned to a product by hand. A pin is re-applied on '
        + 'every import. Unpin one to let automatic matching decide that line again.')}</div>
      <div class="admin-search admin-sp-mappings__search">
        <input type="search" id="sp-mappings-search" placeholder="Search supplier SKU or product…">
      </div>
      <div id="sp-mappings-body"></div>
    </details>

    <details class="admin-card admin-sp-import" id="sp-import">
      <summary>Loading a new price list</summary>
      <div class="admin-sp-import__body">
        <p>${esc('Two steps put a new supplier price list into this page: the file is stored, then an '
          + 'import parses it and matches every line to a product. Until the second step runs, an uploaded '
          + 'file changes nothing here.')}</p>
        <p class="admin-sp-import__slot" id="sp-import-slot"></p>
        <div class="admin-sp-import__steps">
          <label class="admin-sp-import__step"><span>1. Choose the file (.xlsx, .ods, .csv or .txt, up to 20 MB)</span>
            <input type="file" id="sp-import-file" accept=".xlsx,.ods,.csv,.txt"></label>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="sp-import-upload" disabled>Upload</button>
          <button class="admin-btn admin-btn--primary admin-btn--sm" id="sp-import-run">2. Run import</button>
        </div>
        <div class="admin-sp-import__status" id="sp-import-status" role="status" aria-live="polite"></div>
        <p class="admin-text-muted">${esc('There is no import-history endpoint yet, so the supplier dates at the '
          + 'top of this page are the record of when a list last landed.')}</p>
      </div>
    </details>`;

  _table = new DataTable(_container.querySelector('#sp-table'), {
    columns: buildColumns(),
    rowKey: 'product_id',
    emptyMessage: COVERAGE.multi.empty,
    tableClass: 'admin-sp-table',
    onRowClick: (row) => openRowDrawer(row),
    onPageChange: (p) => { _page = p; paintTable(); },
    onLimitChange: (l) => { _limit = l; _page = 1; paintTable(); },
  });

  renderFilters();
  renderBlurb();
  bindMappingsPanel();
  bindImportPanel();
}

function renderBlurb() {
  const host = _container.querySelector('#sp-blurb');
  if (!host) return;
  const text = _tab === 'review'
    ? 'Supplier lines we could not match to a product. Matching never guesses — a code that could mean '
      + 'two different cartridges is reported here rather than picked.'
    : (COVERAGE[_tab] ? COVERAGE[_tab].blurb : '');
  host.textContent = text;
}

// ── Events ─────────────────────────────────────────────────────────────────

function bindDelegated() {
  _delegated = async (e) => {
    const tabBtn = e.target.closest('[data-sp-tab]');
    if (tabBtn && _container.contains(tabBtn)) { switchTab(tabBtn.dataset.spTab); return; }

    const mapBtn = e.target.closest('[data-sp-map]');
    if (mapBtn && _container.contains(mapBtn)) { e.stopPropagation(); openMapModal(mapBtn.dataset.spMap); return; }

    const pageBtn = e.target.closest('[data-sp-review-page]');
    if (pageBtn && _container.contains(pageBtn) && !pageBtn.disabled) {
      _reviewPage = Math.max(1, Number(pageBtn.dataset.spReviewPage) || 1);
      renderReview();
      return;
    }

    if (e.target.closest('#sp-export') && _container.contains(e.target)) { exportCsv(); return; }
    if (e.target.closest('#sp-reload') && _container.contains(e.target)) { await reload(); }
  };
  _container.addEventListener('click', _delegated);

  _container.addEventListener('change', (e) => {
    if (e.target.id === 'sp-brand') { _brand = e.target.value; _page = 1; writeHashParams({ brand: _brand }); loadCompare(); }
    else if (e.target.id === 'sp-type') { _type = e.target.value; _page = 1; writeHashParams({ type: _type }); loadCompare(); }
    else if (e.target.id === 'sp-sort') { _sort = e.target.value; _page = 1; writeHashParams({ sort: _sort }); loadCompare(); }
    else if (e.target.id === 'sp-review-supplier') { _reviewSupplier = e.target.value; _reviewPage = 1; loadReview(); }
    else if (e.target.id === 'sp-review-all') { _reviewShowAll = e.target.checked; _reviewPage = 1; renderReview(); }
  });

  _container.addEventListener('input', (e) => {
    const debounced = (fn) => {
      if (_searchDebounce) clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(fn, 300);
    };
    if (e.target.id === 'sp-search') {
      debounced(() => { _search = e.target.value.trim(); _page = 1; writeHashParams({ q: _search }); loadCompare(); });
    } else if (e.target.id === 'sp-min-saving') {
      debounced(() => { _minSaving = e.target.value.trim(); _page = 1; writeHashParams({ min: _minSaving }); loadCompare(); });
    } else if (e.target.id === 'sp-review-search') {
      debounced(() => { _reviewSearch = e.target.value.trim(); _reviewPage = 1; loadReview(); });
    }
  });

  // The two client-side chips. They re-filter what is already loaded — no refetch,
  // because there is no server param behind either of them.
  _container.addEventListener('click', (e) => {
    if (e.target.closest('#sp-chip-fresh')) {
      _freshOnly = !_freshOnly; _page = 1;
      _container.querySelector('#sp-chip-fresh')?.classList.toggle('active', _freshOnly);
      writeHashParams({ fresh: _freshOnly ? '1' : '' });
      applyFiltersAndPaint();
    } else if (e.target.closest('#sp-chip-switch')) {
      _switchOnly = !_switchOnly; _page = 1;
      _container.querySelector('#sp-chip-switch')?.classList.toggle('active', _switchOnly);
      writeHashParams({ swap: _switchOnly ? '1' : '' });
      applyFiltersAndPaint();
    }
  });
}

function switchTab(tab) {
  if (!TABS.some((t) => t.id === tab) || tab === _tab) return;
  _tab = tab;
  _page = 1;
  _reviewPage = 1;
  _container.querySelectorAll('[data-sp-tab]').forEach((btn) => {
    const on = btn.dataset.spTab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  });
  writeHashParams({ tab });
  renderFilters();
  renderBlurb();
  reload();
}

async function reload() {
  if (_tab === 'review') {
    // The review tab needs the supplier list for its dropdown, and that only
    // comes off the compare endpoint. Load it once, quietly, if we have none.
    if (!_suppliers.length) await loadCompare();
    renderFilters();
    await loadReview();
  } else {
    await loadCompare();
    if (!_reviewRows.length) loadReview(); // fill the tab count without blocking the table
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

export default {
  title: 'Supplier Prices',

  async init(container) {
    resetState();
    _mapPage = 1; _mapSearch = ''; _mapLoaded = false; _mapGen++;
    _container = container;
    _alive = true;

    // Belt and braces. The router already gates this route from NAV_ITEMS
    // (ownerOnly), but every owner page repeats the check so a direct call or a
    // future routing change cannot expose supplier costs to a plain admin.
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">Supplier prices are available to account owners only.</div>
      </div>`;
      return;
    }

    const hashTab = getHashParam('tab');
    if (TABS.some((t) => t.id === hashTab)) _tab = hashTab;
    _search = getHashParam('q') || '';
    _brand = getHashParam('brand') || '';
    _type = getHashParam('type') || '';
    _minSaving = getHashParam('min') || '';
    const hashSort = getHashParam('sort');
    if (SORTS.some((s) => s.value === hashSort)) _sort = hashSort;
    _freshOnly = getHashParam('fresh') === '1';
    _switchOnly = getHashParam('swap') === '1';

    renderShell();
    bindDelegated();
    await reload();
  },

  destroy() {
    _alive = false;
    _gen++;
    if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
    destroyAutocompletes();
    if (_delegated && _container) _container.removeEventListener('click', _delegated);
    _delegated = null;
    if (_table && _table.destroy) _table.destroy();
    _table = null;
    if (Drawer.isOpen && Drawer.isOpen()) Drawer.close();
    Modal.close();
    _container = null;
  },
};
