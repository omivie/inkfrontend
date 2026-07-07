/**
 * Product Demand Ranking — "Top Sellers to Stock for Same-Day".
 *
 * Consumes GET /api/admin/analytics/demand-ranking — a composite demand score
 * per product blending units sold, cart adds, search interest, waitlist,
 * favourites and replenishment. The store is young (~50 orders) so this is
 * explicitly INTEREST-WEIGHTED / directional: we surface *why* each product
 * ranks (per-signal chips), flag low confidence, and NEVER present it as hard
 * best-seller data. The external `market_signal` overlay is directional NZ
 * market context only — rendered as a badge, never folded into the score bar.
 *
 * This page has its own filter controls (product_type/source/packs/window/limit)
 * that map 1:1 to the endpoint's query params, so it hides the global date/brand
 * filter bar. Follows the website-traffic.js render-sequence race-guard pattern.
 */
import { AdminAPI, FilterState, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';

const MISSING = '—';

// Page-local filter state — maps 1:1 to the endpoint query params.
const DEFAULT_FILTERS = { product_type: 'ink', source: 'all', packs: 'exclude', window_days: '90', limit: 50 };
let _filters = { ...DEFAULT_FILTERS };
let _sameDayOnly = false; // client-side "stock for same-day" quick view

let _container = null;
let _data = null;
let _dt = null;
let _abort = null;

// Monotonic render sequence (see website-traffic.js) — every render() captures
// its own value and, after each await, bails if a newer render superseded it.
// Without this a stale fetch could paint over a fresh load.
let _renderSeq = 0;
let _hasRenderedSuccessfully = false;

// ---- filter control definitions ------------------------------------------
const FILTER_GROUPS = [
    { key: 'product_type', label: 'Type',   options: [['ink', 'Ink'], ['toner', 'Toner'], ['ribbon', 'Ribbon'], ['all', 'All']] },
    { key: 'source',       label: 'Source', options: [['all', 'All'], ['genuine', 'Genuine'], ['compatible', 'Compatible']] },
    { key: 'packs',        label: 'Packs',  options: [['exclude', 'Exclude'], ['include', 'Include'], ['only', 'Only']] },
    { key: 'window_days',  label: 'Window', options: [['30', '30d'], ['90', '90d'], ['365', '365d'], ['all', 'All']] },
];
const LIMIT_OPTIONS = [25, 50, 100, 200];

const WEIGHT_LABELS = {
    units_sold: 'units sold', cart_adds: 'cart adds', search_interest: 'search',
    waitlist: 'waitlist', favourites: 'favourites', replenishment_due: 'replenishment',
};

// ---- small formatters -----------------------------------------------------
function nfmt(n) {
    if (n == null) return '0';
    const num = Number(n);
    if (!Number.isFinite(num)) return '0';
    return Number.isInteger(num) ? String(num) : num.toFixed(1);
}
function humanTier(tier) {
    return String(tier || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function fmtDate(iso) {
    if (!iso) return MISSING;
    try {
        return new Date(iso).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return MISSING; }
}
function cleanName(product) {
    if (typeof ProductName !== 'undefined' && ProductName.clean) {
        try { return ProductName.clean(product); } catch (_) { /* fall through */ }
    }
    return product?.name || '';
}

// ---- cell renderers -------------------------------------------------------
function thumbHtml(product) {
    const img = product?.image_url;
    // Genuine rows arrive with image_url:null after sanitising — render the
    // empty-tile fallback (never a colour block) per the genuine-tile invariant.
    if (img) return `<img class="admin-product-thumb" src="${esc(img)}" alt="" loading="lazy">`;
    return `<div class="admin-product-thumb admin-product-thumb--empty">${icon('products', 16, 16)}</div>`;
}

function productCell(row) {
    const p = row.product || {};
    return `<div class="dr-product">
        ${thumbHtml(p)}
        <div class="dr-product__meta">
            <span class="dr-product__name cell-truncate">${esc(cleanName(p) || MISSING)}</span>
            <span class="dr-product__sku cell-mono">${esc(p.sku || MISSING)}</span>
        </div>
    </div>`;
}

function demandCell(row) {
    const score = Number(row.demand_score) || 0;
    const pct = Math.max(0, Math.min(100, score * 100));
    const conf = String(row.confidence || 'low');
    const chipMod = conf === 'high' ? 'success' : 'info';
    return `<div class="dr-demand">
        <div class="admin-traffic-row__bar dr-demand__track"><div style="width:${pct.toFixed(1)}%"></div></div>
        <span class="dr-demand__score cell-mono">${score.toFixed(2)}</span>
        <span class="admin-chip admin-chip--${chipMod}" title="Confidence: ${esc(conf)} (from hard, non-search order volume)">${esc(conf)}</span>
    </div>`;
}

function whyCell(row) {
    const s = row.signals || {};
    const chips = [];
    const add = (raw, emoji, label, title) => {
        if (Number(raw) > 0) chips.push(`<span class="dr-why-chip" title="${esc(title)}">${emoji} ${esc(nfmt(raw))}${label ? ' ' + label : ''}</span>`);
    };
    add(s.units_sold?.raw, '\u{1F4E6}', 'sold', 'Units sold in window');
    add(s.cart_adds?.raw, '\u{1F6D2}', '', 'Distinct shoppers who added to cart');
    if (Number(s.search_interest?.raw) > 0) {
        const approx = s.search_interest?.approximate ? ' (approximate — attributed by model/series code)' : '';
        chips.push(`<span class="dr-why-chip" title="Search interest${approx}">\u{1F50E} ${esc(nfmt(s.search_interest.raw))}${s.search_interest?.approximate ? '~' : ''}</span>`);
    }
    add(s.waitlist?.raw, '\u{23F3}', 'waitlist', 'Out-of-stock waitlist signups');
    add(s.favourites?.raw, '\u{2B50}', '', 'Favourites');
    add(s.replenishment_due?.raw, '\u{1F501}', 'due', 'Replenishment due (consumption profiles)');
    return chips.length ? `<div class="dr-why">${chips.join('')}</div>` : `<span class="cell-muted">${MISSING}</span>`;
}

function stockCell(row) {
    const p = row.product || {};
    const qty = p.stock_quantity != null ? Number(p.stock_quantity).toLocaleString('en-NZ') : MISSING;
    const ready = !!row.same_day_ready;
    const dot = `<span class="dr-dot dr-dot--${ready ? 'ok' : 'no'}" title="${ready ? 'In stock — same-day ready' : 'Not same-day ready'}"></span>`;
    return `<span class="dr-stock">${dot}<span class="cell-mono">${qty}</span></span>`;
}

function actionCell(row) {
    const rec = String(row.stocking_recommendation || 'ok');
    const map = {
        stock_now:    ['admin-badge--failed', 'Stock now'],
        restock_soon: ['admin-badge--pending', 'Restock soon'],
        ok:           ['', 'OK'],
    };
    const [cls, label] = map[rec] || ['', rec];
    return `<span class="admin-badge ${cls}">${esc(label)}</span>`;
}

function marketCell(row) {
    const m = row.market_signal;
    if (!m) return `<span class="cell-muted">${MISSING}</span>`;
    const tip = `${m.reason || ''} — directional NZ market context (external research), not this store's sales. Reviewed ${m.last_reviewed || 'n/a'}.`;
    return `<span class="source-badge source-badge--genuine dr-market" title="${esc(tip)}">${esc(humanTier(m.tier))} ↗</span>`;
}

function columns() {
    return [
        { key: 'rank', label: '#', className: 'cell-mono dr-col-rank', render: (r) => esc(String(r.rank ?? '')) },
        { key: 'product', label: 'Product', className: 'dr-col-product', render: productCell },
        { key: 'demand', label: 'Demand', className: 'dr-col-demand', render: demandCell },
        { key: 'why', label: 'Why', className: 'dr-col-why', render: whyCell },
        { key: 'stock', label: 'Stock', className: 'dr-col-stock', render: stockCell },
        { key: 'action', label: 'Action', className: 'dr-col-action', render: actionCell },
        { key: 'market', label: 'Market', className: 'dr-col-market', render: marketCell },
    ];
}

// ---- section renderers ----------------------------------------------------
function skeleton() {
    return `<div class="admin-loader" role="status" aria-label="Loading demand ranking">
        <span class="admin-sr-only">Loading demand ranking…</span>
        <div class="admin-loading__spinner" aria-hidden="true"></div>
    </div>`;
}

function bannerHtml(data) {
    // Low-data honesty banner. Default to showing it unless the backend
    // explicitly says the ranking is NOT approximate.
    if (data && data.meta && data.meta.approximate === false) return '';
    const note = data?.meta?.note
        || 'Order history is still small, so cart and search demand carry the ranking.';
    return `<div class="dr-banner" role="status">
        <strong>Interest-weighted ranking.</strong> ${esc(note)} Treat as directional, not hard best-seller data.
    </div>`;
}

function captionHtml(data) {
    const sc = data.signal_coverage || {};
    const parts = [
        `${Number(data.ranked_count || 0).toLocaleString('en-NZ')} of ${Number(data.candidate_count || 0).toLocaleString('en-NZ')} products have demand signal`,
        `${Number(data.total_units_sold || 0).toLocaleString('en-NZ')} units sold in window`,
        `signals — sales ${nfmt(sc.units_sold)} · cart ${nfmt(sc.cart_adds)} · search ${nfmt(sc.search_interest)} · waitlist ${nfmt(sc.waitlist)} · favourites ${nfmt(sc.favourites)} · replen ${nfmt(sc.replenishment_due)}`,
        `generated ${fmtDate(data.generated_at)}`,
    ];
    return `<div class="dr-caption">${parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="dr-caption__sep">·</span>')}</div>`;
}

function controlsHtml() {
    const groups = FILTER_GROUPS.map((g) => {
        const cur = String(_filters[g.key]);
        const pills = g.options.map(([val, lbl]) =>
            `<button type="button" class="admin-pill${String(val) === cur ? ' active' : ''}" data-value="${esc(val)}">${esc(lbl)}</button>`
        ).join('');
        return `<div class="dr-filter">
            <span class="dr-filter__label">${esc(g.label)}</span>
            <div class="admin-pills" data-filter="${esc(g.key)}">${pills}</div>
        </div>`;
    }).join('');

    const limitOpts = LIMIT_OPTIONS.map((n) =>
        `<option value="${n}"${Number(_filters.limit) === n ? ' selected' : ''}>${n}</option>`
    ).join('');
    const limitSel = `<div class="dr-filter">
        <span class="dr-filter__label">Show</span>
        <select class="admin-select dr-limit" data-filter="limit">${limitOpts}</select>
    </div>`;

    const toggle = `<label class="dr-toggle">
        <input type="checkbox" id="dr-samedaytoggle"${_sameDayOnly ? ' checked' : ''}>
        <span>Stock for same-day only</span>
    </label>`;

    return `<div class="dr-controls">${groups}${limitSel}<div class="dr-controls__spacer"></div>${toggle}</div>`;
}

function weightsHtml(data) {
    const w = data.weights || {};
    const parts = Object.keys(WEIGHT_LABELS)
        .filter((k) => w[k] != null)
        .map((k) => `${WEIGHT_LABELS[k]} ${Math.round(Number(w[k]) * 100)}%`);
    if (!parts.length) return '';
    return `<div class="dr-weights">Demand score blends: ${esc(parts.join(' · '))}. Market badge is external context, excluded from the score.</div>`;
}

function errorBoxHtml() {
    return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
        <div class="admin-empty__title">Couldn't load demand ranking</div>
        <div class="admin-empty__text">The analytics service didn't respond. It may be waking up — try again.</div>
        <div class="admin-empty__cta" style="margin-top:14px;">
            <button type="button" class="admin-btn admin-btn--primary" data-action="dr-retry">Retry</button>
        </div>
    </div></div>`;
}

// ---- data flow ------------------------------------------------------------
function visibleRows() {
    const rows = _data?.ranking || [];
    if (!_sameDayOnly) return rows;
    // "Stock for same-day" quick view: high demand that is out/low on stock.
    return rows.filter((r) => r.stocking_recommendation && r.stocking_recommendation !== 'ok');
}

function applyRows() {
    if (_dt) _dt.setData(visibleRows());
}

// Delegated handlers — bound ONCE on the container in init() and removed in
// destroy(). Binding per-paint would leak listeners on the persistent #dr-body
// (its innerHTML is replaced, but the element survives), firing render() N times
// after N filter changes.
function onContainerClick(e) {
    const pill = e.target.closest('.admin-pill[data-value]');
    if (pill && _container && _container.contains(pill)) {
        const group = pill.closest('[data-filter]');
        const key = group?.dataset.filter;
        const val = pill.dataset.value;
        if (key && val != null && String(_filters[key]) !== String(val)) {
            _filters[key] = val;
            render();
        }
        return;
    }
    if (e.target.closest('[data-action="dr-retry"]')) { render(); }
}
function onContainerChange(e) {
    const sel = e.target.closest('select[data-filter="limit"]');
    if (sel) { _filters.limit = parseInt(sel.value, 10) || DEFAULT_FILTERS.limit; render(); return; }
    if (e.target.id === 'dr-samedaytoggle') { _sameDayOnly = e.target.checked; applyRows(); }
}

function paint(data) {
    let body = _container.querySelector('#dr-body');
    if (!body) {
        _container.innerHTML = shell('');
        body = _container.querySelector('#dr-body');
    }

    if (!data) {
        body.innerHTML = controlsHtml() + errorBoxHtml();
        return;
    }

    body.innerHTML = bannerHtml(data)
        + captionHtml(data)
        + controlsHtml()
        + `<div id="dr-table"></div>`
        + weightsHtml(data);

    _dt = new DataTable(body.querySelector('#dr-table'), {
        columns: columns(),
        rowKey: 'rank',
        emptyMessage: 'No demand signal yet for these filters',
        emptyIcon: icon('analytics', 28, 28),
    });
    applyRows();
}

function shell(inner) {
    return `<div class="admin-page-header">
        <h1>Demand Ranking</h1>
        <p class="dr-subtitle">Top consumables to stock for same-day shipping.</p>
    </div>
    <div id="dr-body">${inner}</div>`;
}

async function render() {
    if (!_container) return;
    const mySeq = ++_renderSeq;

    if (!_hasRenderedSuccessfully) {
        _container.innerHTML = shell(skeleton());
    } else {
        _container.classList.add('admin-page--reloading');
    }

    _abort?.abort();
    _abort = new AbortController();
    const data = await AdminAPI.getDemandRanking(_filters, _abort.signal);

    // RACE GUARD: bail if a newer render (or destroy) superseded us.
    if (mySeq !== _renderSeq || !_container) return;

    _container.classList.remove('admin-page--reloading');
    _data = data;
    paint(data);
    _hasRenderedSuccessfully = true;
}

export default {
    title: 'Demand Ranking',

    async init(container) {
        _container = container;
        // Delegated listeners live on the container for the page's lifetime —
        // bound once here, removed in destroy() (main-content is reused across
        // routes, so leaving them attached would leak across navigations).
        container.addEventListener('click', onContainerClick);
        container.addEventListener('change', onContainerChange);
        FilterState.showBar(false); // page has its own filter controls
        await render();
    },

    destroy() {
        _abort?.abort();
        if (_container) {
            _container.removeEventListener('click', onContainerClick);
            _container.removeEventListener('change', onContainerChange);
        }
        FilterState.showBar(true);
        _container = null;
        _data = null;
        _dt = null;
        _hasRenderedSuccessfully = false;
        _renderSeq++; // invalidate any in-flight render()
    },
};
