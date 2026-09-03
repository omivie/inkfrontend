/**
 * ACQUISITION ANALYTICS — the vocabulary (ERR-204)
 * ================================================
 * DOM-free readers for the four `GET /api/admin/analytics/acquisition/*`
 * endpoints. Search Console was connected on 2026-09-03, so these returned real
 * SEO numbers for the first time; Google Ads is still unconnected.
 *
 * TWO TRAPS, BOTH MEASURED AGAINST PRODUCTION BEFORE THE UI WAS WRITTEN.
 *
 * ── TRAP 1: the hand-off's null-vs-zero rule is FALSE on /search-terms ──────
 *
 * The hand-off says: "`null` = that source isn't connected. `0` = connected and
 * genuinely zero." That holds on /landing-pages, where `ads_clicks`,
 * `ads_impressions`, `ads_cost` and `ads_conversions` are all null on all 174
 * rows. It is exactly backwards on /search-terms, where — with
 * `meta.sources.google_ads.connected === false`, the very same unconnected
 * integration —
 *
 *      500 of 500 rows report  paid_clicks: 0,  paid_cost: 0
 *      0   of 500 rows report  null
 *
 * Follow the stated rule and the Search Terms table tells the owner they spent
 * $0.00 across 500 queries: a factual claim about money, sourced from an
 * integration that has never existed. The cell cannot answer this question
 * because the cell does not know. So:
 *
 *      CONNECTEDNESS IS READ FROM `meta.sources`, NEVER FROM A CELL VALUE.
 *
 * The value is only consulted AFTER the source says it is worth consulting.
 * Same family as ERR-199 (absent ≠ null ≠ present-and-null) and ERR-180
 * (`email_count: 0` beside a real `emailed_at` = UNKNOWN, not zero).
 *
 * ── TRAP 2: summing SEO down /landing-pages inflates it 6.41× ───────────────
 *
 * First-party rows are split by channel; Google's figures are per-URL, and
 * Google has no idea which channel we classified a session into. So the same
 * path repeats the SAME `seo_impressions` on every one of its channel rows.
 * Measured across the full 174-row table:
 *
 *      naive column sum ........... 84,935 impressions
 *      collapsed by path ..........  13,259 impressions   ← the truth
 *      inflation .................. 6.41×
 *
 *      "/" alone:  4,088 impressions repeated on all 8 of its channel rows,
 *                  byte-identical — a naive sum reports 32,704 (8×).
 *
 * 16 of 138 paths are multi-channel, and in all 16 the repeated figure is
 * identical (verified, not assumed — collapseByPath sets `seoDiverged` on any
 * path whose channel rows disagree, because the day they stop being identical,
 * collapsing would start LOSING data instead of de-duplicating it).
 *
 * collapseByPath() is the fix: one row per path, first-party columns summed,
 * the SEO block taken once, channels nested underneath carrying NO SEO figures
 * at all. A column total is then correct by construction rather than by the
 * reader remembering a footnote.
 *
 * Spec: readfirst/analytics-dashboards-FE-handoff-sep2026.md (job 3)
 */

/** The one em-dash. */
export const MISSING = '—';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. which integrations are actually connected
 * ──────────────────────────────────────────────────────────────────────────── */

export const SOURCE_STATE = {
    /** The integration is connected. A `0` from it is a real zero. */
    CONNECTED: 'connected',
    /** Not connected. EVERY figure attributed to it is unknown — including a 0. */
    NOT_CONNECTED: 'not-connected',
    /** `meta.sources` did not mention it. We cannot say either way. */
    UNKNOWN: 'unknown',
};

/** Human names for the source keys the backend ships. */
export const SOURCE_LABELS = {
    first_party: 'First-party tracking',
    search_console: 'Google Search Console',
    google_ads: 'Google Ads',
};

/**
 * The single authority on whether a source's numbers mean anything.
 *
 * Reads `meta.sources[key].connected` and NOTHING ELSE. In particular it does
 * not fall back to `rows`: measured, `first_party.rows` is null while
 * `connected: true`, and `google_ads.rows` is 0 while `connected: false`, so
 * `rows` answers a different question and answers it misleadingly in both
 * directions.
 */
export function readSourceStatus(meta, key) {
    const sources = meta && meta.sources;
    if (!sources || typeof sources !== 'object' || !has(sources, key)) {
        return SOURCE_STATE.UNKNOWN;
    }
    const src = sources[key];
    if (!src || typeof src !== 'object' || !has(src, 'connected')) {
        return SOURCE_STATE.UNKNOWN;
    }
    return src.connected === true ? SOURCE_STATE.CONNECTED : SOURCE_STATE.NOT_CONNECTED;
}

/**
 * Everything worth showing about one integration, for the status strip.
 * `message` is the backend's own wording, rendered verbatim — it names the
 * exact env vars and endpoint the owner's developer needs.
 */
export function readSourceCard(meta, key) {
    const state = readSourceStatus(meta, key);
    const src = (meta && meta.sources && meta.sources[key]) || null;
    return {
        key,
        label: SOURCE_LABELS[key] || key,
        state,
        configured: src && has(src, 'configured') ? !!src.configured : null,
        rows: src ? finiteOrNull(src.rows) : null,
        message: src && typeof src.message === 'string' ? src.message : '',
    };
}

/** Every source in `meta.sources`, in a stable order, unknown ones included. */
export function readAllSources(meta) {
    const known = ['first_party', 'search_console', 'google_ads'];
    const present = meta && meta.sources && typeof meta.sources === 'object'
        ? Object.keys(meta.sources) : [];
    const order = known.filter((k) => present.includes(k))
        .concat(present.filter((k) => !known.includes(k)));
    return order.map((k) => readSourceCard(meta, k));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. rendering ONE metric honestly
 * ──────────────────────────────────────────────────────────────────────────── */

export const METRIC_STATE = {
    /** A real, measured figure. `0` here means zero. */
    VALUE: 'value',
    /** The source is not connected — the figure is meaningless, whatever it says. */
    NOT_CONNECTED: 'not-connected',
    /** Source is connected but has nothing for this row. */
    NO_DATA: 'no-data',
    /** We do not know whether the source is connected. */
    UNKNOWN: 'unknown',
};

/**
 * Decide what one SEO/Ads cell may claim.
 *
 * ORDER MATTERS AND IS THE WHOLE POINT: the source is consulted BEFORE the
 * value. A `0` from an unconnected source is NOT_CONNECTED, not a zero — that
 * is trap 1, and every `paid_*` cell on /search-terms lands here.
 *
 * @param {*} value        the raw cell value
 * @param {string} status  a SOURCE_STATE, from readSourceStatus()
 */
export function classifyMetric(value, status) {
    if (status === SOURCE_STATE.NOT_CONNECTED) {
        return { state: METRIC_STATE.NOT_CONNECTED, value: null };
    }
    if (status === SOURCE_STATE.UNKNOWN) {
        return { state: METRIC_STATE.UNKNOWN, value: null };
    }
    // Connected. Now — and only now — the value is allowed to speak.
    // An absent key arrives here as `undefined`; null is the backend saying
    // "connected, nothing for this row". Both are NO_DATA, neither is a zero.
    if (value === null || value === undefined) {
        return { state: METRIC_STATE.NO_DATA, value: null };
    }
    const n = finiteOrNull(value);
    if (n === null) return { state: METRIC_STATE.NO_DATA, value: null };
    return { state: METRIC_STATE.VALUE, value: n };
}

/**
 * The text for a cell, plus the tooltip that explains an em-dash. `format` turns
 * a real number into its display form (money, percent, integer).
 */
export function renderMetric(value, status, format) {
    const info = classifyMetric(value, status);
    if (info.state === METRIC_STATE.VALUE) {
        return { text: format ? format(info.value) : String(info.value), tooltip: '', missing: false, state: info.state };
    }
    return {
        text: MISSING,
        tooltip: metricTooltip(info.state),
        missing: true,
        state: info.state,
    };
}

export function metricTooltip(state) {
    if (state === METRIC_STATE.NOT_CONNECTED) {
        return 'Not connected — this integration has never been linked, so there is no figure. The backend sends 0 here; that 0 is not a measurement.';
    }
    if (state === METRIC_STATE.NO_DATA) {
        return 'No data — the source is connected but reported nothing for this row.';
    }
    if (state === METRIC_STATE.UNKNOWN) {
        return 'Unknown — the response did not say whether this source is connected.';
    }
    return '';
}

/**
 * A whole column is worth a header note when its source is dead. Returns null
 * when the column is fine.
 */
export function columnNote(status, label) {
    if (status === SOURCE_STATE.NOT_CONNECTED) return `${label} is not connected — every value in this column is unknown, including the zeros the API sends.`;
    if (status === SOURCE_STATE.UNKNOWN) return `${label} connection status was not reported.`;
    return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. the double-count
 * ──────────────────────────────────────────────────────────────────────────── */

/** The per-URL fields Google supplies. Repeated identically on every channel row. */
export const SEO_FIELDS = ['seo_clicks', 'seo_impressions', 'seo_avg_position'];
export const ADS_FIELDS = ['ads_clicks', 'ads_impressions', 'ads_cost', 'ads_conversions'];
/** The first-party fields. These ARE per channel, and DO sum. */
export const FIRST_PARTY_SUM_FIELDS = ['entry_sessions', 'unique_visitors', 'bounced_sessions', 'pageviews'];

/**
 * Collapse `/landing-pages` rows to one row per path.
 *
 *   - first-party columns are SUMMED across the path's channel rows
 *   - the SEO/Ads block is taken ONCE (they are per-URL, not per-channel)
 *   - bounce_rate is RECOMPUTED from the summed numerator/denominator, never
 *     averaged — averaging rates across unequal denominators is its own bug
 *   - the channel rows are kept as `channels[]`, each stripped of SEO/Ads so a
 *     sub-row physically cannot be summed into a wrong total
 *
 * `seoDiverged` flags a path whose channel rows disagreed about a per-URL
 * figure. Today that never happens (16/16 identical). If it ever does, the
 * assumption behind collapsing has broken and the UI says so instead of
 * silently keeping the first value.
 */
export function collapseByPath(rows) {
    if (!Array.isArray(rows)) return [];
    const order = [];
    const byPath = new Map();

    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const path = typeof row.landing_path === 'string' ? row.landing_path : '(unknown)';
        if (!byPath.has(path)) {
            byPath.set(path, {
                landing_path: path,
                channels: [],
                seoDiverged: false,
                _seoSeen: {},
            });
            order.push(path);
        }
        const entry = byPath.get(path);

        // First-party: sum, preserving null as "not reported" rather than 0.
        for (const f of FIRST_PARTY_SUM_FIELDS) {
            const n = finiteOrNull(row[f]);
            if (n === null) continue;
            entry[f] = (finiteOrNull(entry[f]) ?? 0) + n;
        }

        // Per-URL: take once, and check every repeat agrees.
        for (const f of SEO_FIELDS.concat(ADS_FIELDS)) {
            if (!has(row, f)) continue;
            const v = row[f];
            if (!has(entry._seoSeen, f)) {
                entry._seoSeen[f] = v;
                entry[f] = v;
            } else if (entry._seoSeen[f] !== v) {
                entry.seoDiverged = true;
            }
        }

        const chan = { channel: row.channel };
        for (const f of FIRST_PARTY_SUM_FIELDS) {
            if (has(row, f)) chan[f] = row[f];
        }
        if (has(row, 'bounce_rate')) chan.bounce_rate = row.bounce_rate;
        entry.channels.push(chan);
    }

    return order.map((p) => {
        const e = byPath.get(p);
        delete e._seoSeen;
        // Recompute, never average. bounced/entry are both summed counts.
        const bounced = finiteOrNull(e.bounced_sessions);
        const sessions = finiteOrNull(e.entry_sessions);
        e.bounce_rate = (bounced !== null && sessions !== null && sessions > 0)
            ? Math.round((bounced / sessions) * 1000) / 10
            : null;
        e.channel_count = e.channels.length;
        e.channels.sort((a, b) => (finiteOrNull(b.entry_sessions) ?? 0) - (finiteOrNull(a.entry_sessions) ?? 0));
        return e;
    }).sort((a, b) => (finiteOrNull(b.entry_sessions) ?? 0) - (finiteOrNull(a.entry_sessions) ?? 0));
}

/**
 * Column totals for the collapsed table. Nulls are SKIPPED, not coerced to 0
 * (`|| 0` would launder "not reported" into "zero" — the ERR-068 family), and
 * `known`/`missing` report how many rows actually contributed so a total can
 * never quietly stand for fewer rows than the reader thinks.
 */
export function totalsFor(collapsedRows, fields) {
    const out = {};
    for (const f of fields) {
        let sum = 0, known = 0, missing = 0;
        for (const r of collapsedRows || []) {
            const n = finiteOrNull(r[f]);
            if (n === null) { missing++; continue; }
            sum += n; known++;
        }
        out[f] = { sum: known ? sum : null, known, missing, complete: missing === 0 };
    }
    return out;
}

/**
 * The number a naive implementation would have printed, beside the true one.
 * Used by the probe and the test to prove the fix is load-bearing rather than
 * decorative — if these two ever agree on live data, the guard has stopped
 * guarding anything and the test says so.
 */
export function seoInflationCheck(rawRows, field) {
    const f = field || 'seo_impressions';
    const naive = (rawRows || []).reduce((s, r) => s + (finiteOrNull(r && r[f]) ?? 0), 0);
    const collapsed = collapseByPath(rawRows).reduce((s, r) => s + (finiteOrNull(r[f]) ?? 0), 0);
    return {
        naive,
        collapsed,
        inflation: collapsed > 0 ? Math.round((naive / collapsed) * 100) / 100 : null,
        inflated: naive > collapsed,
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. channels
 * ──────────────────────────────────────────────────────────────────────────── */

/** The channel vocabulary the backend validates against (400s on anything else). */
export const CHANNELS = ['Direct', 'Paid', 'Organic', 'Shopping (Free)', 'Referral', 'Email', 'Social', 'AI Assistant'];

/**
 * `internal_sessions` is EXCLUDED from the channel breakdown. An exclusion the
 * operator cannot see is the ERR-063 family, so it is surfaced as its own line
 * rather than quietly dropped or, worse, added into the total.
 */
export function readSummary(data) {
    if (!data || typeof data !== 'object') return null;
    const channels = Array.isArray(data.channels) ? data.channels : [];
    const total = finiteOrNull(data.total_sessions);
    const channelSum = channels.reduce((s, c) => s + (finiteOrNull(c.sessions) ?? 0), 0);
    return {
        range: data.range || null,
        totalSessions: total,
        channels,
        internalSessions: has(data, 'internal_sessions') ? finiteOrNull(data.internal_sessions) : null,
        // If the parts stop adding up to the backend's own total, say so rather
        // than showing a breakdown that silently fails to explain the headline.
        reconciles: total === null || total === channelSum,
        channelSum,
    };
}

/** The timeseries envelope is `{buckets, channels, series:[{channel, points:[…]}]}`. */
export function readTimeseries(data) {
    if (!data || typeof data !== 'object') return { series: [], buckets: [], channels: [] };
    const series = Array.isArray(data.series) ? data.series : [];
    return {
        buckets: Array.isArray(data.buckets) ? data.buckets : [],
        channels: Array.isArray(data.channels) ? data.channels : [],
        series: series.map((s) => ({
            channel: s && s.channel,
            points: Array.isArray(s && s.points) ? s.points : [],
        })).filter((s) => s.channel),
    };
}
