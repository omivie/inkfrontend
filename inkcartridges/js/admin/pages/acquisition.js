/**
 * Acquisition — where the traffic comes from, and what Google sees.
 * =================================================================
 * The Acquisition tab of the Finance hub (#analytics?tab=acquisition). Four
 * endpoints:
 *   /acquisition/summary        channel totals + which integrations are live
 *   /acquisition/timeseries     sessions per channel per day
 *   /acquisition/landing-pages  entry URLs, first-party + Search Console
 *   /acquisition/search-terms   organic (and eventually paid) queries
 *
 * Search Console was connected 2026-09-03, so these carry real SEO numbers for
 * the first time. Google Ads is NOT connected and, per the backend, is waiting
 * on API access from Google.
 *
 * THE TWO THINGS THIS PAGE EXISTS TO GET RIGHT — both measured, both written up
 * in utils/acquisition.js:
 *
 *  1. Every SEO/Ads cell asks `meta.sources` whether its integration is
 *     connected BEFORE it looks at the value. On /search-terms all 500 rows
 *     report `paid_clicks: 0` and `paid_cost: 0` while Google Ads has never
 *     been connected — so the naive rendering would tell the owner they spent
 *     $0.00 on 500 queries. Those cells render an em-dash and say "Not
 *     connected". A connected zero still renders "0".
 *
 *  2. The entry-pages table is COLLAPSED BY PATH. Google's figures are
 *     per-URL and repeat identically on every channel row for that URL, so
 *     summing the raw table inflates impressions 6.41× (84,935 against a true
 *     13,259). Collapsing states each SEO figure once and nests the channel
 *     split underneath, with the sub-rows carrying no SEO figures at all — so
 *     a column total is right by construction rather than by footnote.
 *
 * Mounted as a lazy tab, so it gets a plain container and manages its own
 * fetches; it does not touch FilterState (the hub owns the bar).
 *
 * Spec: readfirst/analytics-dashboards-FE-handoff-sep2026.md (job 3) — ERR-204
 */
import { AdminAPI, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import {
    MISSING, SOURCE_STATE,
    readSourceStatus, readAllSources,
    renderMetric, columnNote,
    collapseByPath, totalsFor, seoInflationCheck,
    readSummary, readTimeseries,
} from '../utils/acquisition.js';

const CHART_ID = 'acq-channel-chart';

const RANGES = [
    { id: '30', label: 'Last 30 days', days: 30, omit: true },
    { id: '7', label: 'Last 7 days', days: 7 },
    { id: '90', label: 'Last 90 days', days: 90 },
    { id: '365', label: 'Last 12 months', days: 365 },
];

/** Chart.js palette — reuses the admin chart vocabulary rather than inventing one. */
const CHANNEL_COLORS = {
    Direct: '#22D3EE', Paid: '#F472B6', Organic: '#4ADE80', 'Shopping (Free)': '#FBBF24',
    Referral: '#A78BFA', Email: '#60A5FA', Social: '#FB923C', 'AI Assistant': '#94A3B8',
};

let _container = null;
let _range = '30';
let _expanded = new Set();
let _data = null;
let _abort = null;
let _renderSeq = 0;
let _hasRenderedSuccessfully = false;
let _rateTimer = null;

/* ── formatters ─────────────────────────────────────────────────────────── */

const int = (n) => (typeof n === 'number' && Number.isFinite(n)) ? n.toLocaleString('en-NZ') : MISSING;
const money = (n) => new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(n);
const pct1 = (n) => `${n.toFixed(1)}%`;
const pos1 = (n) => n.toFixed(1);

function rangeParams() {
    const r = RANGES.find((x) => x.id === _range) || RANGES[0];
    if (r.omit) return {};
    const to = new Date();
    const from = new Date(to.getTime() - (r.days - 1) * 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(from), to: iso(to) };
}

/** A cell for a figure owned by an external integration. */
function metricCell(value, status, format) {
    const m = renderMetric(value, status, format);
    if (!m.missing) return `<span class="cell-mono">${esc(m.text)}</span>`;
    return `<span class="cell-mono cell-muted acq-missing" title="${esc(m.tooltip)}">${esc(m.text)}</span>`;
}

/* ── 1. source status strip ─────────────────────────────────────────────── */

function sourcesHtml(meta) {
    const cards = readAllSources(meta);
    if (!cards.length) return '';
    const chips = cards.map((c) => {
        const cls = c.state === SOURCE_STATE.CONNECTED ? 'acq-source--on'
            : c.state === SOURCE_STATE.NOT_CONNECTED ? 'acq-source--off' : 'acq-source--unknown';
        const mark = c.state === SOURCE_STATE.CONNECTED ? '✓'
            : c.state === SOURCE_STATE.NOT_CONNECTED ? '✕' : '?';
        const detail = c.state === SOURCE_STATE.CONNECTED
            ? (c.rows !== null ? `${int(c.rows)} rows` : 'connected')
            : c.state === SOURCE_STATE.NOT_CONNECTED ? 'not connected' : 'status not reported';
        return `<div class="acq-source ${cls}">
            <span class="acq-source__mark" aria-hidden="true">${mark}</span>
            <div>
                <div class="acq-source__label">${esc(c.label)}</div>
                <div class="acq-source__detail">${esc(detail)}</div>
                ${c.message ? `<div class="acq-source__msg">${esc(c.message)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Data sources</div>
        <div class="acq-sources">${chips}</div>
        <div class="acq-note">A column whose source is not connected shows ${MISSING}, not zero. The API sends 0 for some of those columns; that 0 is not a measurement.</div>
    </div>`;
}

/* ── 2. channel mix ─────────────────────────────────────────────────────── */

function summaryHtml(res) {
    if (!res || !res.ok) return sectionFailure('Channel mix', res);
    const s = readSummary(res.data);
    if (!s) return '';

    const rows = s.channels.map((c) => {
        const share = typeof c.share_pct === 'number' ? c.share_pct : null;
        const width = share !== null ? Math.max(0, Math.min(100, share)) : 0;
        return `<div class="admin-traffic-row">
            <div class="admin-traffic-row__label">${esc(String(c.channel || MISSING))}</div>
            <div class="admin-traffic-row__bar"><span style="width:${width}%;background:${esc(CHANNEL_COLORS[c.channel] || '#94A3B8')}"></span></div>
            <div class="admin-traffic-row__value">${esc(int(c.sessions))}</div>
            <div class="admin-traffic-row__pct">${share !== null ? esc(pct1(share)) : MISSING}</div>
        </div>`;
    }).join('');

    // internal_sessions is EXCLUDED from the breakdown. An exclusion the
    // operator cannot see is the ERR-063 family, so it gets its own line rather
    // than being dropped or folded into the total.
    const internal = s.internalSessions !== null
        ? `<div class="acq-note">${esc(int(s.internalSessions))} internal session${s.internalSessions === 1 ? '' : 's'} excluded from every figure on this page (your own visits).</div>`
        : '';

    const mismatch = s.reconciles ? '' : `<div class="acq-note acq-note--warn">
        The channel rows add to ${esc(int(s.channelSum))} but the backend reports ${esc(int(s.totalSessions))} total sessions.
        One of the two is wrong — the breakdown below does not fully explain the headline.</div>`;

    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Sessions by channel <small>${esc(int(s.totalSessions))} total</small></div>
        <div class="admin-traffic-bars">${rows}</div>
        ${mismatch}${internal}
    </div>`;
}

/* ── 3. timeseries ──────────────────────────────────────────────────────── */

function timeseriesHtml(res) {
    if (!res || !res.ok) return sectionFailure('Sessions over time', res);
    const ts = readTimeseries(res.data);
    if (!ts.series.length) return '';
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Sessions over time</div>
        <div class="admin-chart-box admin-chart-box--tall"><canvas id="${CHART_ID}"></canvas></div>
    </div>`;
}

function drawChart(res) {
    if (!res || !res.ok) return;
    const ts = readTimeseries(res.data);
    if (!ts.series.length) return;
    if (!document.getElementById(CHART_ID)) return;

    // Bucket labels come from the FIRST series' points — every series shares the
    // same bucket grid (verified: the backend emits a zero point per channel per
    // bucket rather than omitting empty ones), so they line up by index.
    const base = ts.series[0].points || [];
    const labels = base.map((p) => {
        const d = new Date(p.bucket_start);
        return Number.isNaN(d.getTime()) ? String(p.bucket_start)
            : d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
    });

    const datasets = ts.series
        // A channel with no sessions at all in the range is a flat zero line and
        // pure noise on an eight-series chart.
        .filter((s) => (s.points || []).some((p) => Number(p.sessions) > 0))
        .map((s) => ({
            label: s.channel,
            data: (s.points || []).map((p) => Number(p.sessions) || 0),
            backgroundColor: CHANNEL_COLORS[s.channel] || '#94A3B8',
            borderColor: CHANNEL_COLORS[s.channel] || '#94A3B8',
            borderWidth: 0,
        }));
    if (!datasets.length) return;

    Charts.bar(CHART_ID, {
        labels,
        datasets,
        options: {
            plugins: { legend: { display: true, position: 'bottom' } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
        },
    });
}

/* ── 4. entry pages, collapsed by path ──────────────────────────────────── */

function landingHtml(res) {
    if (!res || !res.ok) return sectionFailure('Entry pages', res);
    const raw = Array.isArray(res.data) ? res.data : [];
    const meta = res.meta || {};
    const seoStatus = readSourceStatus(meta, 'search_console');
    const rows = collapseByPath(raw);
    const check = seoInflationCheck(raw);

    const totals = totalsFor(rows, ['entry_sessions', 'unique_visitors', 'pageviews', 'seo_impressions', 'seo_clicks']);

    const body = rows.map((r, i) => {
        const key = `p${i}`;
        const open = _expanded.has(r.landing_path);
        const multi = r.channel_count > 1;
        const caret = multi
            ? `<button type="button" class="acq-caret${open ? ' acq-caret--open' : ''}" data-path="${esc(r.landing_path)}" aria-expanded="${open}" aria-label="Show channel split for ${esc(r.landing_path)}">▸</button>`
            : '<span class="acq-caret acq-caret--none" aria-hidden="true"></span>';

        const diverged = r.seoDiverged
            ? ` <span class="acq-flag" title="This path's channel rows reported DIFFERENT Search Console figures. They are normally identical, which is what makes collapsing safe — so this figure may be understated.">⚠</span>`
            : '';

        const main = `<tr class="acq-row${multi ? ' acq-row--group' : ''}">
            <td class="acq-cell-path">${caret}<code>${esc(r.landing_path)}</code>${multi ? `<span class="acq-chancount">${r.channel_count} channels</span>` : ''}</td>
            <td class="cell-right cell-mono">${esc(int(r.entry_sessions))}</td>
            <td class="cell-right cell-mono cell-muted">${esc(int(r.unique_visitors))}</td>
            <td class="cell-right cell-mono">${r.bounce_rate === null ? MISSING : esc(pct1(r.bounce_rate))}</td>
            <td class="cell-right">${metricCell(r.seo_impressions, seoStatus, int)}${diverged}</td>
            <td class="cell-right">${metricCell(r.seo_clicks, seoStatus, int)}</td>
            <td class="cell-right">${metricCell(r.seo_avg_position, seoStatus, pos1)}</td>
        </tr>`;

        if (!open || !multi) return main;
        // Sub-rows deliberately carry NO SEO columns. Not "blanked" — absent, so
        // there is physically nothing to sum into a wrong total.
        const subs = r.channels.map((c) => `<tr class="acq-row acq-row--sub">
            <td class="acq-cell-path"><span class="acq-sub-label">${esc(String(c.channel || MISSING))}</span></td>
            <td class="cell-right cell-mono">${esc(int(c.entry_sessions))}</td>
            <td class="cell-right cell-mono cell-muted">${esc(int(c.unique_visitors))}</td>
            <td class="cell-right cell-mono">${typeof c.bounce_rate === 'number' ? esc(pct1(c.bounce_rate)) : MISSING}</td>
            <td class="cell-right cell-muted acq-sub-na" colspan="3">Search Console figures are per URL, not per channel — shown once on the row above</td>
        </tr>`).join('');
        return main + subs;
    }).join('');

    const t = (k, fmt) => {
        const v = totals[k];
        if (!v || v.sum === null) return MISSING;
        return `${fmt(v.sum)}${v.complete ? '' : `<span class="acq-partial" title="${v.missing} of ${v.known + v.missing} rows did not report this — the total is a floor.">*</span>`}`;
    };
    const seoTotalCell = seoStatus === SOURCE_STATE.CONNECTED ? t('seo_impressions', int) : MISSING;
    const seoClickTotal = seoStatus === SOURCE_STATE.CONNECTED ? t('seo_clicks', int) : MISSING;

    const note = columnNote(seoStatus, 'Google Search Console');

    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Entry pages <small>${rows.length} path${rows.length === 1 ? '' : 's'} from ${raw.length} channel row${raw.length === 1 ? '' : 's'}</small></div>
        <div class="admin-table-wrap"><table class="admin-table acq-table">
            <thead><tr>
                <th>Landing path</th>
                <th class="cell-right">Sessions</th>
                <th class="cell-right">Visitors</th>
                <th class="cell-right">Bounce</th>
                <th class="cell-right">SEO impr.</th>
                <th class="cell-right">SEO clicks</th>
                <th class="cell-right">Avg. pos.</th>
            </tr></thead>
            <tbody>${body || '<tr><td colspan="7" class="cell-muted">No entry pages in this range.</td></tr>'}</tbody>
            <tfoot><tr>
                <td><strong>Total</strong></td>
                <td class="cell-right cell-mono"><strong>${t('entry_sessions', int)}</strong></td>
                <td class="cell-right cell-mono">${t('unique_visitors', int)}</td>
                <td class="cell-right">${MISSING}</td>
                <td class="cell-right cell-mono"><strong>${seoTotalCell}</strong></td>
                <td class="cell-right cell-mono">${seoClickTotal}</td>
                <td class="cell-right">${MISSING}</td>
            </tr></tfoot>
        </table></div>
        ${note ? `<div class="acq-note acq-note--warn">${esc(note)}</div>` : ''}
        <div class="acq-note">
            One row per URL. Search Console reports per URL, not per channel, so its figures are stated
            once here — the API repeats them on every channel row, and adding those up would have
            reported <strong>${esc(int(check.naive))}</strong> impressions against a true
            <strong>${esc(int(check.collapsed))}</strong>${check.inflation ? ` (${esc(String(check.inflation))}× too high)` : ''}.
            Expand a path to see its channel split; sessions and visitors do add up, so those are summed.
        </div>
    </div>`;
}

/* ── 5. search terms ────────────────────────────────────────────────────── */

function searchTermsHtml(res) {
    if (!res || !res.ok) return sectionFailure('Search terms', res);
    const rows = Array.isArray(res.data) ? res.data : [];
    const meta = res.meta || {};
    const organic = readSourceStatus(meta, 'search_console');
    const paid = readSourceStatus(meta, 'google_ads');
    const paidNote = columnNote(paid, 'Google Ads');

    const body = rows.map((r) => `<tr>
        <td class="acq-cell-term">${esc(String(r.term || MISSING))}</td>
        <td class="cell-right">${metricCell(r.organic_clicks, organic, int)}</td>
        <td class="cell-right">${metricCell(r.organic_impressions, organic, int)}</td>
        <td class="cell-right">${metricCell(r.organic_ctr, organic, pct1)}</td>
        <td class="cell-right">${metricCell(r.organic_position, organic, pos1)}</td>
        <td class="cell-right">${metricCell(r.paid_clicks, paid, int)}</td>
        <td class="cell-right">${metricCell(r.paid_cost, paid, money)}</td>
    </tr>`).join('');

    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Search terms <small>${rows.length} shown</small></div>
        <div class="admin-table-wrap"><table class="admin-table acq-table">
            <thead><tr>
                <th>Query</th>
                <th class="cell-right">Clicks</th>
                <th class="cell-right">Impressions</th>
                <th class="cell-right">CTR</th>
                <th class="cell-right">Position</th>
                <th class="cell-right acq-th-paid">Paid clicks</th>
                <th class="cell-right acq-th-paid">Paid cost</th>
            </tr></thead>
            <tbody>${body || '<tr><td colspan="7" class="cell-muted">No search terms in this range.</td></tr>'}</tbody>
        </table></div>
        ${paidNote ? `<div class="acq-note acq-note--warn">${esc(paidNote)}</div>` : ''}
    </div>`;
}

/* ── failure states, each named ─────────────────────────────────────────── */

function sectionFailure(title, res) {
    if (res && res.aborted) return '';
    if (res && res.rateLimited) {
        const secs = Math.max(1, Math.round(res.retryAfter));
        return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
            <div class="admin-empty__title">${esc(title)} — rate-limited</div>
            <div class="admin-empty__text">The analytics API allows 20 requests a minute and this session has used them.
                Nothing was returned; this is <strong>not</strong> a report of zero traffic.
                Retrying in <span class="acq-countdown" data-until="${Date.now() + secs * 1000}">${secs}</span>s.</div>
        </div></div>`;
    }
    if (res && res.status === 403) {
        return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
            <div class="admin-empty__title">${esc(title)} — access restricted</div>
            <div class="admin-empty__text">Your account is not permitted to read acquisition analytics.</div>
        </div></div>`;
    }
    const detail = res && res.status
        ? `The server answered ${esc(String(res.status))}.`
        : 'The request did not reach the server.';
    return `<div class="admin-card admin-mb-lg"><div class="admin-empty">
        <div class="admin-empty__title">Couldn't load ${esc(title.toLowerCase())}</div>
        <div class="admin-empty__text">${detail} This is a problem reaching the analytics service, not a measurement of zero.</div>
        <div class="admin-empty__cta"><button class="admin-btn admin-btn--primary" data-action="acq-retry">Try again</button></div>
    </div></div>`;
}

/* ── shell + render ─────────────────────────────────────────────────────── */

function controlsHtml() {
    return `<div class="acq-controls">
        <div class="ce-filter">
            <span class="ce-filter__label">Range</span>
            <select class="admin-select" data-filter="range">${RANGES.map((r) =>
                `<option value="${esc(r.id)}"${r.id === _range ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select>
        </div>
    </div>`;
}

function skeleton() {
    return `<div class="admin-loader" role="status" aria-label="Loading acquisition">
        <span class="admin-sr-only">Loading acquisition analytics…</span>
        <div class="admin-loading__spinner" aria-hidden="true"></div>
    </div>`;
}

function paint(d) {
    const body = _container && _container.querySelector('#acq-body');
    if (!body) return;
    // The sources strip needs a meta that HAS a sources block — summary puts it
    // on data, the table endpoints on meta. Take the first one that has it
    // rather than assuming a single shape.
    const metaWithSources = [d.landing?.meta, d.terms?.meta, d.summary?.data].find(
        (m) => m && m.sources) || null;

    body.innerHTML = controlsHtml()
        + sourcesHtml(metaWithSources)
        + summaryHtml(d.summary)
        + timeseriesHtml(d.timeseries)
        + landingHtml(d.landing)
        + searchTermsHtml(d.terms);

    drawChart(d.timeseries);
    startCountdown();
}

async function render() {
    if (!_container) return;
    const mySeq = ++_renderSeq;

    if (!_hasRenderedSuccessfully) _container.innerHTML = `<div id="acq-body">${skeleton()}</div>`;
    else _container.classList.add('admin-page--reloading');

    _abort?.abort();
    _abort = new AbortController();
    const signal = _abort.signal;
    const range = rangeParams();

    // Four requests against a 20/minute budget. Sequential rather than parallel
    // so a burst cannot spend a quarter of the minute's allowance at once, and
    // so a rate limit hit partway through still leaves the earlier sections
    // rendered rather than blanking the page.
    const summary = await AdminAPI.getAcquisitionSummary(range, signal);
    if (mySeq !== _renderSeq) return;
    const timeseries = await AdminAPI.getAcquisitionTimeseries(range, signal);
    if (mySeq !== _renderSeq) return;
    const landing = await AdminAPI.getAcquisitionLandingPages(Object.assign({ limit: 200 }, range), signal);
    if (mySeq !== _renderSeq) return;
    const terms = await AdminAPI.getAcquisitionSearchTerms(Object.assign({ limit: 100 }, range), signal);

    if (mySeq !== _renderSeq || !_container) return;

    _container.classList.remove('admin-page--reloading');
    if (!_container.querySelector('#acq-body')) _container.innerHTML = '<div id="acq-body"></div>';
    _data = { summary, timeseries, landing, terms };
    paint(_data);
    if (summary?.ok || landing?.ok) _hasRenderedSuccessfully = true;
}

function startCountdown() {
    clearInterval(_rateTimer);
    const el = _container && _container.querySelector('.acq-countdown');
    if (!el) return;
    const until = Number(el.dataset.until);
    _rateTimer = setInterval(() => {
        const live = _container && _container.querySelector('.acq-countdown');
        if (!live) { clearInterval(_rateTimer); return; }
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) { clearInterval(_rateTimer); render(); return; }
        live.textContent = String(left);
    }, 1000);
}

/* ── events ─────────────────────────────────────────────────────────────── */

function onContainerClick(e) {
    const caret = e.target.closest('.acq-caret[data-path]');
    if (caret) {
        const p = caret.dataset.path;
        if (_expanded.has(p)) _expanded.delete(p); else _expanded.add(p);
        if (_data) paint(_data);
        return;
    }
    if (e.target.closest('[data-action="acq-retry"]')) render();
}

function onContainerChange(e) {
    const el = e.target.closest('[data-filter="range"]');
    if (!el) return;
    _range = el.value;
    _expanded = new Set();
    render();
}

export default {
    title: 'Acquisition',

    async init(container) {
        _container = container;
        container.addEventListener('click', onContainerClick);
        container.addEventListener('change', onContainerChange);
        await render();
    },

    destroy() {
        _abort?.abort();
        clearInterval(_rateTimer);
        _rateTimer = null;
        Charts.destroy?.(CHART_ID);
        if (_container) {
            _container.removeEventListener('click', onContainerClick);
            _container.removeEventListener('change', onContainerChange);
        }
        _container = null;
        _data = null;
        _expanded = new Set();
        _hasRenderedSuccessfully = false;
        _renderSeq++; // invalidate any in-flight render()
    },
};
