/**
 * CATALOGUE ENGAGEMENT — the vocabulary (ERR-204)
 * ===============================================
 * DOM-free readers for `GET /api/admin/analytics/catalog/products` and
 * `.../catalog/brands`. The page renders; this file decides what the payload
 * MEANS. The tests and `npm run probe:analytics-dashboards` load this exact
 * module rather than re-implementing it, so the thing certified green is the
 * thing that ships.
 *
 * Three questions this file exists to answer correctly, each measured against
 * production on 2026-09-03 before a line of UI was written:
 *
 * 0. `view_to_sale_rate` IS NOT A CONVERSION RATE. Measured 2026-09-03, it is
 *    `units_sold / views` on all 208 rows that have views — a UNITS-PER-VIEW
 *    ratio. One view can buy a 4-pack, and units can be sold to somebody who
 *    never opened the product page inside the window, so the value legitimately
 *    exceeds 1: 7 of 259 live rows do, up to 3.0 (C564BK — 1 view, 3 sold).
 *
 *    Rendered as a percentage under a "View → sale" heading, "300%" reads as a
 *    broken number, and the operator's next move is to distrust the column. So
 *    the value is NEVER capped — capping would be inventing a measurement — and
 *    anything over 1 is flagged with `overUnity` so the cell can explain itself.
 *
 * 1. `view_to_sale_rate: null` IS NOT ZERO, and it is not rare.
 *    51 of 257 live rows (20%) carry null — every one of them a product with
 *    `views: 0` and `clicks > 0`. A further 155 rows carry a genuine `0`
 *    (viewed, never bought). Rendering null as "0%" would tell the operator a
 *    fifth of the catalogue is failing to convert when nothing at all is known
 *    about it. The two states have to survive as two states, so this is
 *    resolved with hasOwnProperty — `undefined !== null` and `undefined == null`
 *    are BOTH true, so either obvious gate is wrong in one direction (ERR-199).
 *
 * 2. `offshore_bounce_views_excluded` DOES NOT SHIP ON BOTH ENDPOINTS, and its
 *    zero is not always a count. The hand-off says it "reports the count either
 *    way". Measured:
 *      /catalog/products                             → 8   (257 products)
 *      /catalog/products?include_offshore_bounces=1  → 0   (265 products)
 *      /catalog/brands                               → KEY ABSENT
 *    So there are three answers, not one number: a measured count, a zero that
 *    only means "the filter was off" (the 8 were included, not absent), and an
 *    endpoint that never reported it at all. A UI that prints "0 excluded" for
 *    the last two is inventing a measurement.
 *
 * 3. `engagement` IS A SORT KEY, NOT A METRIC. It is views + clicks (products)
 *    or brand page views + product views + product clicks (brands). The
 *    hand-off is explicit that it "exists to sort by, not to display on its
 *    own" — Canon draws nearly as many hub visits as Epson but under half the
 *    product views, and one summed number hides exactly that. engagementParts()
 *    keeps the components addressable so the cell can name them.
 *
 * Spec: readfirst/analytics-dashboards-FE-handoff-sep2026.md (job 2)
 */

/** The one em-dash. Never render `0` where the answer is unknown. */
export const MISSING = '—';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/** A finite number, or null. `Number.isFinite` is NOT an absence check on its
 *  own — it says "this is a number", not "this was measured" (ERR-190). */
function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. view → sale rate
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Read a row's view-to-sale rate as THREE outcomes, never two.
 *
 *   { known: true,  rate: 0.0769 }  a measured rate
 *   { known: true,  rate: 0 }       measured, and genuinely zero (155 live rows)
 *   { known: false, rate: null }    nothing was viewed, so the rate is unknown
 *                                   (51 live rows) — or the key is absent
 *                                   entirely, which is a contract regression and
 *                                   equally not a zero.
 *
 * `reason` names WHY it is unknown so the UI can say the true thing rather than
 * a generic "no data": an absent key is a different problem from zero views.
 */
export function readViewToSaleRate(row) {
    if (!row || typeof row !== 'object') {
        return { known: false, rate: null, reason: 'absent' };
    }
    if (!has(row, 'view_to_sale_rate')) {
        // The backend stopped sending the field. Not zero, and worth naming
        // separately — this is the failure that looks identical on screen.
        return { known: false, rate: null, reason: 'absent' };
    }
    const raw = row.view_to_sale_rate;
    if (raw === null || raw === undefined) {
        return { known: false, rate: null, reason: 'no-views' };
    }
    const n = finiteOrNull(raw);
    if (n === null) return { known: false, rate: null, reason: 'unreadable' };
    // > 1 is legitimate, not a glitch: the value is units_sold / views.
    return { known: true, rate: n, reason: null, overUnity: n > 1 };
}

/**
 * Why a value over 100% is real. Returns '' for everything else, so a cell can
 * attach it unconditionally.
 */
export function overUnityTooltip(info) {
    if (!info || !info.known || !info.overUnity) return '';
    return 'Over 100% is expected here, not an error: this is units sold \u00f7 views, so one view that buys a '
        + '4-pack counts four, and units bought by someone who never opened the product page in this range '
        + 'still count. It is not a per-visitor conversion rate.';
}

/** What the View \u2192 sale column actually measures, for the notes block. */
export const RATE_DEFINITION =
    'View \u2192 sale is units sold \u00f7 product-page views for the range. It can exceed 100% '
    + '(multi-unit orders, or buyers who did not open the page in this window), and it is blank rather '
    + 'than 0% when there were no views at all.';

/** Why a rate is unknown, in words an operator can act on. */
export function viewToSaleTooltip(info) {
    if (!info || info.known) return '';
    if (info.reason === 'no-views') {
        return 'Not known — this product had no views in this range, so there is no rate to compute. It is not a 0% conversion.';
    }
    if (info.reason === 'unreadable') {
        return 'Not known — the backend sent a value that could not be read as a rate.';
    }
    return 'Not known — the backend did not send view_to_sale_rate for this row. This is not a 0% conversion.';
}

/**
 * Format a rate for display. Takes the RESULT of readViewToSaleRate, not a raw
 * value, so there is no path from a bare `null` to a printed percentage.
 * The API sends a fraction (0.0769 = 7.69%).
 */
export function formatRate(info) {
    if (!info || !info.known) return MISSING;
    const pct = info.rate * 100;
    // Sub-1% rates are common here and "0%" would read as none at all.
    if (pct > 0 && pct < 1) return pct.toFixed(2) + '%';
    if (pct < 10) return pct.toFixed(1) + '%';
    return Math.round(pct) + '%';
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. the scraper filter, and what it is honest to say about it
 * ──────────────────────────────────────────────────────────────────────────── */

export const OFFSHORE_STATE = {
    /** The filter ran and the backend told us how many views it removed. */
    MEASURED: 'measured',
    /** The operator turned the filter OFF. The `0` means "nothing was removed",
     *  which is true but is NOT the size of what the filter normally removes. */
    SUPPRESSED: 'suppressed',
    /** The endpoint never sends this key (brands). Silence, not zero. */
    UNKNOWN: 'unknown',
};

/**
 * What may honestly be said about the offshore-bounce filter for this response.
 *
 * @param {object} meta                 the response `meta`
 * @param {object} opts
 * @param {boolean} opts.includeBounces did WE ask for the unfiltered view?
 */
export function readOffshoreExcluded(meta, opts) {
    const includeBounces = !!(opts && opts.includeBounces);
    if (!meta || !has(meta, 'offshore_bounce_views_excluded')) {
        return { state: OFFSHORE_STATE.UNKNOWN, count: null };
    }
    const count = finiteOrNull(meta.offshore_bounce_views_excluded);
    if (count === null) return { state: OFFSHORE_STATE.UNKNOWN, count: null };
    if (includeBounces) {
        // Measured: with include_offshore_bounces=true the field is 0 while the
        // row count RISES (257 → 265). The zero describes this response, not the
        // filter. Reporting it as "0 excluded" beside an unfiltered table would
        // tell the operator the filter finds nothing.
        return { state: OFFSHORE_STATE.SUPPRESSED, count };
    }
    return { state: OFFSHORE_STATE.MEASURED, count };
}

/**
 * The sentence that goes under the table. A filter the operator cannot see is
 * one they will eventually be misled by — the hand-off asks for this, and the
 * three states have to read differently or the ask is not met.
 */
export function offshoreDisclosure(info) {
    if (!info) return '';
    if (info.state === OFFSHORE_STATE.MEASURED) {
        const n = info.count;
        return n === 0
            ? 'Scraper filter on: no offshore single-page views were removed from this range.'
            : `Scraper filter on: ${n.toLocaleString('en-NZ')} offshore single-page view${n === 1 ? '' : 's'} removed. All New Zealand traffic is kept.`;
    }
    if (info.state === OFFSHORE_STATE.SUPPRESSED) {
        return 'Scraper filter OFF — these are unfiltered totals, including offshore single-page sessions. The backend does not report how many that adds while the filter is off, so the difference is not shown.';
    }
    return 'Scraper filter status not reported on this endpoint — the count of excluded offshore views is unknown, not zero.';
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. engagement is a sort key
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Break `engagement` back into the components it summed, so a cell can name
 * them instead of presenting one number as if it meant something on its own.
 * Returns `{ total, parts: [{label, value}], reconciles }`.
 *
 * `reconciles` is false when the parts do not add up to the backend's own
 * total — which would mean the formula changed under us. Surfaced rather than
 * silently trusted.
 */
export function engagementParts(row, kind) {
    if (!row || typeof row !== 'object') return { total: null, parts: [], reconciles: true };
    const num = (k) => finiteOrNull(row[k]) ?? 0;
    const parts = kind === 'brand'
        ? [
            { label: 'Brand page views', value: num('brand_page_views') },
            { label: 'Product views', value: num('product_views') },
            { label: 'Product clicks', value: num('product_clicks') },
        ]
        : [
            { label: 'Views', value: num('views') },
            { label: 'Clicks', value: num('clicks') },
        ];
    const total = finiteOrNull(row.engagement);
    const sum = parts.reduce((s, p) => s + p.value, 0);
    return { total, parts, reconciles: total === null || total === sum };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. how many rows are we actually looking at
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * "Showing 50 of 509". The pre-limit count comes from meta and NEVER from
 * data.length — and `?offset=` is a DECOY on both endpoints (measured: it is
 * accepted and returns the identical first page), so there is no pagination to
 * offer. The honest control is the limit itself.
 *
 * Returns `{ shown, total, truncated, label }`; `total: null` when meta did not
 * say, in which case the label refuses to claim one.
 */
export function rowCountLabel(rows, meta, kind) {
    const shown = Array.isArray(rows) ? rows.length : 0;
    const key = kind === 'brand' ? 'total_brands_engaged' : 'total_products_engaged';
    const total = meta && has(meta, key) ? finiteOrNull(meta[key]) : null;
    const noun = kind === 'brand' ? 'brand' : 'product';
    if (total === null) {
        return {
            shown, total: null, truncated: false,
            label: `Showing ${shown.toLocaleString('en-NZ')} ${noun}${shown === 1 ? '' : 's'} (total not reported)`,
        };
    }
    return {
        shown, total, truncated: shown < total,
        label: `Showing ${shown.toLocaleString('en-NZ')} of ${total.toLocaleString('en-NZ')} engaged ${noun}${total === 1 ? '' : 's'}`,
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. dead brand links
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `unmatched_brand_slugs` should normally be empty. Anything in it is a brand
 * slug the storefront links to that has no brand record behind it — a dead
 * link customers can reach. Surfaced as a warning, never swallowed.
 * Distinguishes "reported, empty" from "not reported at all".
 */
export function readUnmatchedBrandSlugs(meta) {
    if (!meta || !has(meta, 'unmatched_brand_slugs')) {
        return { reported: false, slugs: [] };
    }
    const raw = meta.unmatched_brand_slugs;
    if (!Array.isArray(raw)) return { reported: false, slugs: [] };
    return { reported: true, slugs: raw.filter((s) => typeof s === 'string' && s.length) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. coverage
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `meta.coverage` is prose written by the backend about how trustworthy each
 * signal is. It is rendered VERBATIM — paraphrasing it would put our words on
 * their measurement. Returns the entries that are actually present.
 */
export function readCoverage(meta) {
    const out = [];
    const cov = meta && meta.coverage;
    if (!cov || typeof cov !== 'object') return out;
    const LABELS = { views: 'Views', clicks: 'Clicks', bots: 'Bots' };
    for (const key of ['views', 'clicks', 'bots']) {
        if (has(cov, key) && typeof cov[key] === 'string' && cov[key].trim()) {
            out.push({ key, label: LABELS[key], text: cov[key].trim() });
        }
    }
    return out;
}

/** The filters the products endpoint really honours. Everything else is a decoy. */
export const REAL_PRODUCT_FILTERS = ['from', 'to', 'source', 'brand_id', 'limit', 'include_offshore_bounces'];
/** Measured 2026-09-03: accepted, echoed nowhere, and completely ignored. */
export const DECOY_PRODUCT_FILTERS = ['product_type', 'sort', 'offset', 'search'];
