/**
 * Catalogue Engagement — what the catalogue is actually getting looked at.
 * =======================================================================
 * Two leaderboards behind one segmented control:
 *   Products — GET /api/admin/analytics/catalog/products
 *   Brands   — GET /api/admin/analytics/catalog/brands
 *
 * Everything this page is careful about lives in utils/catalog-engagement.js,
 * which is where the reasoning (and the live measurements behind it) is written
 * down. The three that shape the UI:
 *
 *   • `view_to_sale_rate: null` is 20% of live rows and is NOT 0%. It renders
 *     as an em-dash with a tooltip saying why. A genuine 0 (155 rows) still
 *     renders "0.0%", so the two remain visibly different.
 *   • The scraper filter is on by default and removes ~8.7% of views. A filter
 *     the operator cannot see is one they will eventually be misled by, so the
 *     disclosure line under the table always says which of the three states it
 *     is in — including "the backend does not report this here".
 *   • `engagement` is the SORT KEY. It is shown as a small muted number with
 *     its components in the tooltip, never as a headline metric: Canon draws
 *     nearly as many hub visits as Epson but under half the product views, and
 *     one summed figure hides exactly that.
 *
 * THERE IS A PAGER NOW (ERR-251). Until 2026-09-10 `?offset=` was accepted by
 * both endpoints and completely ignored, so a Next button would have silently
 * re-served page one — the limit control was the honest equivalent, and this
 * comment said so. The backend's migration 170 made offset/sort/search/
 * product_type reach SQL; re-measured here 2026-09-12 before a single control
 * was drawn (see utils/catalog-engagement.js §7 for the numbers).
 *
 * Two things the pager depends on, both measured rather than assumed:
 *   • `meta.has_more` is the BACKEND's answer. It is never recomputed from
 *     `rows.length === limit`, which is wrong on the last full page and would
 *     offer a Next that lands on nothing.
 *   • filters apply BEFORE ranking, so `total_products_engaged` is the count of
 *     the FILTERED set (518 → 34 for `search=TN2`) and the pager divides by the
 *     right number. The row count is still read from that pre-limit total,
 *     never from data.length.
 *
 * The BRANDS panel has no pager: its own endpoint echoes no offset, and a
 * control that is drawn for one panel and not the other is less confusing than
 * one that silently does nothing on the second.
 *
 * Follows the demand-ranking.js / website-traffic.js shape: page owns its
 * filters (global bar hidden), _renderSeq race guard, skeleton on first paint
 * and a dimmed reload after, delegated listeners bound once.
 *
 * Spec: readfirst/analytics-dashboards-FE-handoff-sep2026.md (job 2) — ERR-204
 */
import { AdminAPI, FilterState, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import {
    MISSING,
    readViewToSaleRate, viewToSaleTooltip, formatRate,
    readOffshoreExcluded, offshoreDisclosure, OFFSHORE_STATE,
    engagementParts, rowCountLabel, readUnmatchedBrandSlugs, readCoverage,
    overUnityTooltip, RATE_DEFINITION,
    PRODUCT_SORTS, CATALOG_TYPES_ACCEPTED, readPager,
} from '../utils/catalog-engagement.js';
// The type menu is the INTERSECTION of our vocabulary and the endpoint's, never
// a fresh hand-kept enum — six type vocabularies already exist in this repo and
// `npm run audit:types` counts them (ERR-162→166).
import { PRODUCT_TYPE_LABELS } from '../utils/product-types.js';

const PANELS = [
    { id: 'products', label: 'Products' },
    { id: 'brands', label: 'Brands' },
];

/** Ranges the endpoints accept. Omitting from/to gives the backend's own
 *  last-30-days default, so "Last 30 days" sends nothing and lets meta.range
 *  tell us what we got. */
const RANGES = [
    { id: '30', label: 'Last 30 days', days: 30, omit: true },
    { id: '7', label: 'Last 7 days', days: 7 },
    { id: '90', label: 'Last 90 days', days: 90 },
    { id: '365', label: 'Last 12 months', days: 365 },
];

const SOURCES = [['all', 'All'], ['genuine', 'Genuine'], ['compatible', 'Compatible']];
/** The endpoints cap limit at 500 (products) / 200 (brands) — 400 above that. */
const PRODUCT_LIMITS = [25, 50, 100, 250, 500];
const BRAND_LIMITS = [25, 50, 100, 200];

let _container = null;
let _panel = 'products';
let _range = '30';
let _source = 'all';
let _brandId = '';
let _limit = 50;
let _includeBounces = false;
let _sort = 'engagement';
let _search = '';
let _productType = '';
let _offset = 0;
let _searchTimer = null;

/**
 * The type options actually offered: our label vocabulary ∩ the endpoint's
 * accepted list. `universal_ribbon` is accepted by the endpoint and has ZERO
 * rows in the live catalogue (measured 2026-09-12), and our own vocabulary does
 * not carry it — so it falls out here rather than becoming a menu entry that can
 * only ever return an empty leaderboard. That is ERR-163 exactly, and it is the
 * reason this is an intersection and not a copy of either side.
 */
const TYPE_OPTIONS = CATALOG_TYPES_ACCEPTED
    .filter((t) => Object.prototype.hasOwnProperty.call(PRODUCT_TYPE_LABELS, t))
    .map((t) => [t, PRODUCT_TYPE_LABELS[t]])
    .sort((a, b) => a[1].localeCompare(b[1]));

/** Any change to WHAT is being asked must return to page one — otherwise a
 *  narrower filter can leave the operator on an offset past the end of its own
 *  result set, looking at an empty table that is not empty. */
function resetPaging() { _offset = 0; }

let _dt = null;
let _abort = null;
let _renderSeq = 0;
let _hasRenderedSuccessfully = false;
let _brandOptions = [];
let _rateTimer = null;

/* ── formatters ─────────────────────────────────────────────────────────── */

const nf = (n) => (typeof n === 'number' && Number.isFinite(n))
    ? n.toLocaleString('en-NZ') : MISSING;

function money(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return MISSING;
    return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(n);
}

function rangeParams() {
    const r = RANGES.find((x) => x.id === _range) || RANGES[0];
    if (r.omit) return {};
    const to = new Date();
    const from = new Date(to.getTime() - (r.days - 1) * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(from), to: iso(to) };
}

/* ── cells ──────────────────────────────────────────────────────────────── */

function productCell(row) {
    const sku = esc(String(row.sku || ''));
    const name = esc(String(row.name || ''));
    const src = String(row.source || '').toLowerCase();
    // BrandSource vocabulary: unknown gets NO badge, never a default of
    // "GENUINE" (ERR-157). Only the two values the endpoint documents.
    const badge = (src === 'genuine' || src === 'compatible')
        ? `<span class="admin-badge ce-src ce-src--${src}">${src === 'genuine' ? 'Genuine' : 'Compatible'}</span>`
        : '';
    return `<div class="ce-product">
        <div class="ce-product__sku">${sku}${badge}</div>
        <div class="ce-product__name" title="${name}">${name}</div>
    </div>`;
}

function engagementCell(row, kind) {
    const info = engagementParts(row, kind);
    if (info.total === null) return `<span class="cell-muted">${MISSING}</span>`;
    const tip = info.parts.map((p) => `${p.label} ${p.value.toLocaleString('en-NZ')}`).join(' + ');
    const warn = info.reconciles ? '' : ' ce-engagement--diverged';
    const title = info.reconciles
        ? `Sort key only: ${tip}`
        : `Sort key only: ${tip} — these no longer add up to the backend's own total (${info.total}). The ranking formula may have changed.`;
    return `<span class="ce-engagement${warn}" title="${esc(title)}">${nf(info.total)}${info.reconciles ? '' : ' ⚠'}</span>`;
}

function rateCell(row) {
    const info = readViewToSaleRate(row);
    if (!info.known) {
        return `<span class="cell-muted ce-missing" title="${esc(viewToSaleTooltip(info))}">${MISSING}</span>`;
    }
    const over = overUnityTooltip(info);
    if (over) {
        // Faithful, never capped — but a bare "300%" reads as a bug, and an
        // operator who distrusts one column distrusts the table.
        return `<span class="cell-mono ce-rate--over" title="${esc(over)}">${esc(formatRate(info))}</span>`;
    }
    return `<span class="cell-mono">${esc(formatRate(info))}</span>`;
}

function productColumns() {
    return [
        { key: 'product', label: 'Product', className: 'ce-col-product', render: productCell },
        { key: 'brand', label: 'Brand', render: (r) => esc(String(r.brand || MISSING)) },
        { key: 'retail_price', label: 'Price', align: 'right', className: 'cell-mono', render: (r) => esc(money(r.retail_price)) },
        { key: 'views', label: 'Views', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.views)) },
        { key: 'unique_viewers', label: 'Viewers', align: 'right', className: 'cell-mono cell-muted', render: (r) => esc(nf(r.unique_viewers)) },
        { key: 'clicks', label: 'Clicks', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.clicks)) },
        { key: 'unique_clickers', label: 'Clickers', align: 'right', className: 'cell-mono cell-muted', render: (r) => esc(nf(r.unique_clickers)) },
        { key: 'engagement', label: 'Engagement', align: 'right', className: 'cell-mono', render: (r) => engagementCell(r, 'product') },
        { key: 'units_sold', label: 'Sold', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.units_sold)) },
        { key: 'revenue', label: 'Revenue', align: 'right', className: 'cell-mono', render: (r) => esc(money(r.revenue)) },
        { key: 'view_to_sale_rate', label: 'View → sale', align: 'right', render: rateCell },
    ];
}

function brandColumns() {
    return [
        { key: 'brand', label: 'Brand', render: (r) => `<strong>${esc(String(r.brand || MISSING))}</strong>` },
        // Kept SEPARATE deliberately — browsing a brand hub and examining that
        // brand's cartridges are different behaviours, and the hand-off asks
        // for both. Merging them would hide the Canon/OKI inversion entirely.
        { key: 'brand_page_views', label: 'Hub views', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.brand_page_views)) },
        { key: 'hub_visitors', label: 'Hub visitors', align: 'right', className: 'cell-mono cell-muted', render: (r) => esc(nf(r.hub_visitors)) },
        { key: 'product_views', label: 'Product views', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.product_views)) },
        { key: 'product_viewers', label: 'Product viewers', align: 'right', className: 'cell-mono cell-muted', render: (r) => esc(nf(r.product_viewers)) },
        { key: 'product_clicks', label: 'Product clicks', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.product_clicks)) },
        { key: 'engagement', label: 'Engagement', align: 'right', className: 'cell-mono', render: (r) => engagementCell(r, 'brand') },
        { key: 'units_sold', label: 'Sold', align: 'right', className: 'cell-mono', render: (r) => esc(nf(r.units_sold)) },
        { key: 'revenue', label: 'Revenue', align: 'right', className: 'cell-mono', render: (r) => esc(money(r.revenue)) },
    ];
}

/* ── chrome ─────────────────────────────────────────────────────────────── */

function skeleton() {
    return `<div class="admin-loader" role="status" aria-label="Loading catalogue engagement">
        <span class="admin-sr-only">Loading catalogue engagement…</span>
        <div class="admin-loading__spinner" aria-hidden="true"></div>
    </div>`;
}

function controlsHtml() {
    const panelBtns = PANELS.map((p) =>
        `<button type="button" class="admin-segmented__btn${p.id === _panel ? ' admin-segmented__btn--active' : ''}" data-panel="${esc(p.id)}">${esc(p.label)}</button>`
    ).join('');

    const rangeOpts = RANGES.map((r) =>
        `<option value="${esc(r.id)}"${r.id === _range ? ' selected' : ''}>${esc(r.label)}</option>`).join('');

    const sourceCtl = _panel === 'products' ? `<div class="ce-filter">
        <span class="ce-filter__label">Source</span>
        <div class="admin-pills" data-filter="source">${SOURCES.map(([v, l]) =>
            `<button type="button" class="admin-pill${v === _source ? ' active' : ''}" data-value="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    </div>` : '';

    const brandCtl = (_panel === 'products' && _brandOptions.length) ? `<div class="ce-filter">
        <span class="ce-filter__label">Brand</span>
        <select class="admin-select" data-filter="brand_id">
            <option value="">All brands</option>
            ${_brandOptions.map((b) => `<option value="${esc(b.brand_id)}"${b.brand_id === _brandId ? ' selected' : ''}>${esc(b.brand)}</option>`).join('')}
        </select>
    </div>` : '';

    const limits = _panel === 'products' ? PRODUCT_LIMITS : BRAND_LIMITS;
    const limitCtl = `<div class="ce-filter">
        <span class="ce-filter__label">Show</span>
        <select class="admin-select" data-filter="limit">${limits.map((n) =>
            `<option value="${n}"${Number(_limit) === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
    </div>`;

    const bounceCtl = `<label class="ce-toggle" title="The scraper filter removes offshore sessions that viewed exactly one page. It keeps 100% of New Zealand traffic. Turn it off to audit the raw numbers.">
        <input type="checkbox" data-filter="include_offshore_bounces"${_includeBounces ? ' checked' : ''}>
        <span>Include offshore bounces</span>
    </label>`;

    // Products-only. The brands endpoint honours none of these (it echoes no
    // offset either), and a control that silently does nothing on one panel is
    // the decoy problem this whole change is about — just moved into our own UI.
    const sortCtl = _panel === 'products' ? `<div class="ce-filter">
        <span class="ce-filter__label">Sort</span>
        <select class="admin-select" data-filter="sort">${PRODUCT_SORTS.map(([v, l]) =>
            `<option value="${esc(v)}"${_sort === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>` : '';

    const typeCtl = _panel === 'products' ? `<div class="ce-filter">
        <span class="ce-filter__label">Type</span>
        <select class="admin-select" data-filter="product_type">
            <option value="">All types</option>
            ${TYPE_OPTIONS.map(([v, l]) =>
                `<option value="${esc(v)}"${_productType === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
    </div>` : '';

    const searchCtl = _panel === 'products' ? `<div class="ce-filter ce-filter--search">
        <span class="ce-filter__label">Find</span>
        <input type="search" class="admin-input" data-filter="search" value="${esc(_search)}"
               placeholder="SKU or name\u2026" autocomplete="off" aria-label="Filter products by SKU or name">
    </div>` : '';

    return `<div class="ce-controls">
        <div class="admin-segmented" role="tablist">${panelBtns}</div>
        <div class="ce-filter">
            <span class="ce-filter__label">Range</span>
            <select class="admin-select" data-filter="range">${rangeOpts}</select>
        </div>
        ${sourceCtl}${brandCtl}${typeCtl}${sortCtl}${limitCtl}${searchCtl}
        <div class="ce-controls__spacer"></div>
        ${bounceCtl}
    </div>`;
}

/**
 * The failure states, each NAMED. A rate limit, an outage and a refusal look
 * identical if they all render as an empty table, and only one of them is the
 * operator's problem to solve (ERR-188: a non-answer must never redirect).
 */
function failureHtml(res) {
    if (res && res.rateLimited) {
        const secs = Math.max(1, Math.round(res.retryAfter));
        return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
            <div class="admin-empty__title">Analytics is rate-limited</div>
            <div class="admin-empty__text">The analytics API allows 20 requests a minute and this session has used them.
                No data was returned — this is <strong>not</strong> an empty catalogue.
                Retrying in <span class="ce-countdown" data-until="${Date.now() + secs * 1000}">${secs}</span>s.</div>
        </div></div>`;
    }
    if (res && res.aborted) return '';
    const status = res && res.status;
    if (status === 403) {
        return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
            <div class="admin-empty__title">Access restricted</div>
            <div class="admin-empty__text">Your account is not permitted to read catalogue analytics.</div>
        </div></div>`;
    }
    const detail = status
        ? `The server answered ${esc(String(status))}.`
        : 'The request did not reach the server.';
    return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
        <div class="admin-empty__title">Couldn't load catalogue engagement</div>
        <div class="admin-empty__text">${detail} This is a problem reaching the analytics service, not a report that nothing was viewed.</div>
        <div class="admin-empty__cta"><button class="admin-btn admin-btn--primary" data-action="ce-retry">Try again</button></div>
    </div></div>`;
}

/** The disclosure block: what was filtered out, and how far to trust each column. */
function notesHtml(meta) {
    const off = readOffshoreExcluded(meta, { includeBounces: _includeBounces });
    const cls = off.state === OFFSHORE_STATE.MEASURED ? '' : ' ce-note--warn';
    const coverage = readCoverage(meta);
    const covHtml = coverage.length
        ? `<ul class="ce-coverage">${coverage.map((c) =>
            `<li><strong>${esc(c.label)}:</strong> ${esc(c.text)}</li>`).join('')}</ul>`
        : '';
    // The rate definition only belongs on the panel that has the column.
    const rateNote = _panel === 'products'
        ? `<div class="ce-note">${esc(RATE_DEFINITION)}</div>` : '';
    return `<div class="admin-card ce-notes">
        <div class="ce-note${cls}">${esc(offshoreDisclosure(off))}</div>
        ${rateNote}
        ${covHtml}
    </div>`;
}

/** A brand slug the storefront links to with no brand record behind it is a
 *  dead link a customer can reach. Surfaced, never swallowed. */
function unmatchedHtml(meta) {
    const info = readUnmatchedBrandSlugs(meta);
    if (!info.reported || !info.slugs.length) return '';
    return `<div class="admin-card ce-warning">
        <strong>${info.slugs.length} brand link${info.slugs.length === 1 ? '' : 's'} with no brand record.</strong>
        The storefront links to ${info.slugs.length === 1 ? 'this slug' : 'these slugs'} but nothing in the catalogue matches, so
        ${info.slugs.length === 1 ? 'it is a dead link' : 'they are dead links'}:
        ${info.slugs.map((s) => `<code>${esc(s)}</code>`).join(' ')}
    </div>`;
}

function shell(inner) {
    return `<div class="admin-page-header">
        <h1>Catalogue Engagement</h1>
        <p class="ce-subtitle">What customers are looking at, and whether looking turns into buying.</p>
    </div>
    <div id="ce-body">${inner}</div>`;
}

/* ── paint ──────────────────────────────────────────────────────────────── */

function paint(res) {
    const body = _container && _container.querySelector('#ce-body');
    if (!body) return;

    if (!res || !res.ok) {
        _dt?.destroy?.();
        _dt = null;
        body.innerHTML = controlsHtml() + failureHtml(res);
        startCountdown();
        return;
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    const meta = res.meta || {};
    const kind = _panel === 'brands' ? 'brand' : 'product';
    const count = rowCountLabel(rows, meta, kind);
    // Brands never gets a pager: its endpoint echoes no limit/offset, so
    // readPager reports `supported: false` and the old honest caption stands.
    const pager = _panel === 'products' ? readPager(meta, rows.length) : readPager(null, rows.length);
    const range = meta.range || {};
    const rangeText = (range.from && range.to) ? `${range.from} → ${range.to}` : '';

    body.innerHTML = `${controlsHtml()}
        ${_panel === 'brands' ? unmatchedHtml(meta) : ''}
        <div class="ce-caption">
            <span>${esc(count.label)}</span>
            ${rangeText ? `<span class="ce-caption__sep">·</span><span>${esc(rangeText)}</span>` : ''}
            ${meta.ranked_by ? `<span class="ce-caption__sep">·</span><span>ranked by ${esc(String(meta.ranked_by))}</span>` : ''}
            ${pager.supported && pager.label ? `<span class="ce-caption__sep">·</span><span>showing ${esc(pager.label)}</span>` : ''}
            ${(!pager.supported && count.truncated) ? `<span class="ce-caption__sep">·</span><span class="ce-caption__more">raise “Show” to see more — this panel has no next page</span>` : ''}
        </div>
        <div class="admin-card admin-mb-lg"><div id="ce-table"></div></div>
        ${pagerHtml(pager)}
        ${notesHtml(meta)}`;

    const mount = body.querySelector('#ce-table');
    _dt?.destroy?.();
    _dt = new DataTable(mount, {
        columns: kind === 'brand' ? brandColumns() : productColumns(),
        emptyMessage: 'No engagement recorded in this range.',
        emptyIcon: 'analytics',
        rowKey: kind === 'brand' ? 'brand_id' : 'product_id',
        tableClass: 'ce-table',
    });
    _dt.setData(rows);
}

/**
 * The pager. Drawn ONLY when the server echoed limit and offset back (ERR-251).
 *
 * `Next` is gated on the backend's own `meta.has_more`, never on
 * `rows.length === limit` — that inference is wrong on the last full page and
 * hands the operator a button that lands on an empty table. When the server
 * does not echo a pager, none is drawn at all: an inferred pager over an
 * endpoint that ignores `offset` is precisely the silent-decoy failure this
 * page spent six weeks documenting.
 */
function pagerHtml(pager) {
    if (!pager.supported) return '';
    if (!pager.hasPrev && !pager.hasMore) return '';
    const btn = (action, label, enabled) =>
        `<button type="button" class="admin-btn admin-btn--sm" data-page="${action}"${enabled ? '' : ' disabled'}>${label}</button>`;
    return `<div class="ce-pager">
        ${btn('prev', '\u2190 Previous', pager.hasPrev)}
        <span class="ce-pager__page">Page ${pager.page.toLocaleString('en-NZ')}</span>
        ${btn('next', 'Next \u2192', pager.hasMore)}
    </div>`;
}

/** The rate-limit countdown, so the operator watches a number rather than a
 *  spinner that never resolves. Refetches itself when it reaches zero. */
function startCountdown() {
    clearInterval(_rateTimer);
    const el = _container && _container.querySelector('.ce-countdown');
    if (!el) return;
    const until = Number(el.dataset.until);
    _rateTimer = setInterval(() => {
        const live = _container && _container.querySelector('.ce-countdown');
        if (!live) { clearInterval(_rateTimer); return; }
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) { clearInterval(_rateTimer); render(); return; }
        live.textContent = String(left);
    }, 1000);
}

async function render() {
    if (!_container) return;
    const mySeq = ++_renderSeq;

    if (!_hasRenderedSuccessfully) _container.innerHTML = shell(skeleton());
    else _container.classList.add('admin-page--reloading');

    _abort?.abort();
    _abort = new AbortController();

    const opts = Object.assign({ limit: _limit }, rangeParams());
    // offset is sent ONLY when paging. Page one keeps the same URL it has always
    // had, so the default view still shares one edge/TTL cache key with itself
    // (the same reason include_offshore_bounces is omitted when off).
    if (_panel === 'products' && _offset > 0) opts.offset = _offset;
    // include_offshore_bounces defaults to false server-side; only send it when
    // it is actually on, so the URL (and therefore the shared cache key) stays
    // stable for the default view.
    if (_includeBounces) opts.include_offshore_bounces = 'true';

    let res;
    if (_panel === 'brands') {
        res = await AdminAPI.getCatalogBrandEngagement(opts, _abort.signal);
    } else {
        if (_source !== 'all') opts.source = _source;
        if (_brandId) opts.brand_id = _brandId;
        if (_productType) opts.product_type = _productType;
        if (_search.trim()) opts.search = _search.trim();
        // `engagement` is the server's own default; omitting it keeps the URL
        // stable for the view the operator has not changed.
        if (_sort && _sort !== 'engagement') opts.sort = _sort;
        res = await AdminAPI.getCatalogProductEngagement(opts, _abort.signal);
    }

    if (mySeq !== _renderSeq || !_container) return;

    _container.classList.remove('admin-page--reloading');
    if (!_container.querySelector('#ce-body')) _container.innerHTML = shell('');
    paint(res);
    if (res && res.ok) _hasRenderedSuccessfully = true;
}

/** The brand dropdown is populated from the brands endpoint's own rows, so it
 *  can only ever offer brands that actually have engagement — and it costs one
 *  request, once, rather than a second catalogue fetch. */
async function loadBrandOptions() {
    const res = await AdminAPI.getCatalogBrandEngagement({ limit: 200 }, null);
    if (!res || !res.ok || !Array.isArray(res.data)) return;
    _brandOptions = res.data
        .filter((b) => b && b.brand_id && b.brand)
        .map((b) => ({ brand_id: String(b.brand_id), brand: String(b.brand) }))
        .sort((a, b) => a.brand.localeCompare(b.brand));
}

/* ── events ─────────────────────────────────────────────────────────────── */

function onContainerClick(e) {
    const panelBtn = e.target.closest('[data-panel]');
    if (panelBtn) {
        const id = panelBtn.dataset.panel;
        if (id && id !== _panel) {
            _panel = id;
            resetPaging();
            const limits = _panel === 'products' ? PRODUCT_LIMITS : BRAND_LIMITS;
            if (!limits.includes(Number(_limit))) _limit = limits[1] || limits[0];
            _hasRenderedSuccessfully = false;
            render();
        }
        return;
    }
    const pill = e.target.closest('.admin-pills [data-value]');
    if (pill) {
        const group = pill.closest('[data-filter]');
        if (group && group.dataset.filter === 'source') {
            _source = pill.dataset.value;
            resetPaging();
            render();
        }
        return;
    }
    const pageBtn = e.target.closest('[data-page]');
    if (pageBtn) {
        if (pageBtn.disabled) return;
        const step = pageBtn.dataset.page === 'next' ? 1 : -1;
        _offset = Math.max(0, _offset + step * Number(_limit || 0));
        render();
        return;
    }
    if (e.target.closest('[data-action="ce-retry"]')) render();
}

function onContainerChange(e) {
    const el = e.target.closest('[data-filter]');
    if (!el || el.tagName === 'DIV') return;
    const key = el.dataset.filter;
    if (key === 'range') _range = el.value;
    else if (key === 'limit') _limit = Number(el.value);
    else if (key === 'brand_id') _brandId = el.value;
    else if (key === 'include_offshore_bounces') _includeBounces = !!el.checked;
    else if (key === 'sort') _sort = el.value;
    else if (key === 'product_type') _productType = el.value;
    else if (key === 'search') { _search = el.value; }
    else return;
    // EVERY filter change returns to page one. Narrowing a result set while
    // holding an offset leaves the operator past the end of it, looking at an
    // empty table that is not empty — and `has_more: false` would make the Next
    // button that could rescue them disabled too.
    resetPaging();
    render();
}

/**
 * Typing is debounced; every other control fires on change.
 *
 * 300ms, and it matters more here than on a storefront box: this whole section
 * shares a 20-requests-per-minute budget (measured — the headers advertise 30
 * and a second limiter refuses the 21st), so an undebounced search field would
 * spend it in about two seconds of typing and then show a rate-limit countdown
 * instead of results.
 */
function onContainerInput(e) {
    const el = e.target.closest('input[data-filter="search"]');
    if (!el) return;
    _search = el.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
        resetPaging();
        render();
        // Re-focus and restore the caret: paint() replaces the controls wholesale,
        // so without this the field loses focus mid-word on every keystroke batch.
        const live = _container && _container.querySelector('input[data-filter="search"]');
        if (live) { live.focus(); live.setSelectionRange(live.value.length, live.value.length); }
    }, 300);
}

export default {
    title: 'Catalogue Engagement',

    async init(container) {
        _container = container;
        container.addEventListener('click', onContainerClick);
        container.addEventListener('change', onContainerChange);
        container.addEventListener('input', onContainerInput);
        FilterState.showBar(false); // this page owns its own controls
        await render();
        // After the table is up, so the first paint is never waiting on it.
        await loadBrandOptions();
        if (_container && _brandOptions.length) {
            const ctl = _container.querySelector('.ce-controls');
            if (ctl) ctl.outerHTML = controlsHtml();
        }
    },

    destroy() {
        _abort?.abort();
        _dt?.destroy?.();
        clearInterval(_rateTimer);
        _rateTimer = null;
        if (_container) {
            _container.removeEventListener('click', onContainerClick);
            _container.removeEventListener('change', onContainerChange);
            _container.removeEventListener('input', onContainerInput);
            clearTimeout(_searchTimer);
        }
        FilterState.showBar(true);
        _container = null;
        _dt = null;
        _brandOptions = [];
        _hasRenderedSuccessfully = false;
        _renderSeq++; // invalidate any in-flight render()
    },
};
