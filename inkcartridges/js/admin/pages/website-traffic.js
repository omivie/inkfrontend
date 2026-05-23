/**
 * Website Traffic — first-party traffic analytics (pageviews + clicks)
 * Reads aggregates and recent events from backend RPCs powered by the
 * `traffic_events` Supabase table. See BACKEND_TRAFFIC_ANALYTICS_HANDOFF.md.
 */
import { FilterState, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import {
    normalizeSeries, seriesTotals, trendDirection,
    previousRange, computeDeltas, generateInsights, bucketSeries,
} from '../utils/traffic-analytics.js';

const MISSING = '\u2014';
const fmt = (n) => (n == null ? MISSING : Number(n).toLocaleString('en-NZ'));
const pct = (n) => (n == null ? MISSING : `${Number(n).toFixed(1)}%`);

const TRAFFIC_CHART_ID = 'chart-traffic-trend';

// Chart granularity \u2014 bar width. User-chosen, persisted across sessions so the
// next admin landing on the page lands on the same view they last left.
const GRANULARITY_KEY = 'admin:website-traffic:granularity';
const GRANULARITY_OPTIONS = [
    { value: 'day',   label: 'Day',   axisOpts: { day: 'numeric', month: 'short' } },
    { value: 'week',  label: 'Week',  axisOpts: { day: 'numeric', month: 'short' } },
    { value: 'month', label: 'Month', axisOpts: { month: 'short', year: '2-digit' } },
];
function readGranularity() {
    try {
        const v = localStorage.getItem(GRANULARITY_KEY);
        if (GRANULARITY_OPTIONS.some(o => o.value === v)) return v;
    } catch (_) {}
    return 'day';
}
function writeGranularity(v) {
    try { localStorage.setItem(GRANULARITY_KEY, v); } catch (_) {}
}
let _granularity = readGranularity();
let _lastSeries = []; // cached normalised daily series so the toggle redraws without refetching

// Monotonic render sequence — every render() captures its own value, and after
// each await checks that no NEWER render has been kicked off in the meantime.
// Without this guard a stale render whose fetches all aborted to null would
// paint the "Backend endpoint not available yet" empty-hero on top of a fresh
// render's spinner mid-load, causing a visible flash (reported 2026-05-23).
let _renderSeq = 0;
let _hasRenderedSuccessfully = false; // first-load skeleton vs re-load dim

function duration(sec) {
    if (sec == null) return MISSING;
    const s = Math.round(Number(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

function hexToRgba(hex, alpha) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Period-over-period delta badge. `d` is a pctChange() result (or null).
function deltaHtml(d) {
    if (!d || !Number.isFinite(d.pct)) return '';
    const cls = `admin-kpi__delta--${d.dir}`;
    const sign = d.pct > 0 ? '+' : '';
    return `<div class="admin-kpi__delta ${cls}" data-tooltip="vs previous period">${d.arrow} ${sign}${d.pct.toFixed(1)}%</div>`;
}

function kpi({ label, value, sub, delta }) {
    let html = `<div class="admin-kpi">`;
    html += `<div class="admin-kpi__label">${esc(label)}</div>`;
    html += value != null
        ? `<div class="admin-kpi__value">${esc(String(value))}</div>`
        : `<span class="admin-kpi__value admin-kpi__value--missing" data-tooltip="No data in range">${MISSING}</span>`;
    html += deltaHtml(delta);
    if (sub) html += `<div class="admin-kpi__sub">${esc(sub)}</div>`;
    html += '</div>';
    return html;
}

const DEVICE_ICON = {
    mobile: '\uD83D\uDCF1',
    tablet: '\uD83D\uDCF1',
    desktop: '\uD83D\uDCBB',
    bot: '\uD83E\uDD16',
};

function deviceLabel(d) {
    if (!d) return 'Unknown';
    return d.charAt(0).toUpperCase() + d.slice(1);
}

function barRow(label, value, total) {
    const p = total > 0 ? (value / total) * 100 : 0;
    return `
        <div class="admin-traffic-row">
            <div class="admin-traffic-row__label">${esc(label)}</div>
            <div class="admin-traffic-row__bar"><div style="width:${p.toFixed(1)}%"></div></div>
            <div class="admin-traffic-row__value">${fmt(value)} <span class="admin-traffic-row__pct">${p.toFixed(1)}%</span></div>
        </div>
    `;
}

function renderBreakdown(title, items) {
    if (!items || !items.length) {
        return `<div class="admin-card admin-mb-lg">
            <div class="admin-card__title">${esc(title)}</div>
            <div class="admin-empty"><div class="admin-empty__text">No data in the selected range</div></div>
        </div>`;
    }
    const total = items.reduce((s, i) => s + (i.count || 0), 0);
    let rows = '';
    for (const it of items) rows += barRow(it.label, it.count, total);
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">${esc(title)}</div>
        <div class="admin-traffic-bars">${rows}</div>
    </div>`;
}

// Email Campaigns breakdown — campaign-visitor-tracking-may2026.md §1.
// Backend guarantees: `campaign_breakdown` is always an array (possibly empty),
// sorted by unique_visitors desc, capped at 10 rows. `campaign_id === "unattributed"`
// renders as plain text (the recipient was matched by auth but the campaign was
// unknown). We render via barRow() so the visual language matches Device/Channel/etc.
function renderCampaignBreakdown(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
        return `<div class="admin-card admin-mb-lg">
            <div class="admin-card__title">Email Campaigns</div>
            <div class="admin-empty"><div class="admin-empty__text">No campaign traffic yet.</div></div>
        </div>`;
    }
    const total = list.reduce((s, r) => s + (Number(r.unique_visitors) || 0), 0);
    let bars = '';
    for (const r of list) {
        const label = (r && r.campaign_id) ? String(r.campaign_id) : 'unattributed';
        bars += barRow(label, Number(r.unique_visitors) || 0, total);
    }
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Email Campaigns <small style="color:var(--text-muted);font-weight:400">— unique visitors per campaign</small></div>
        <div class="admin-traffic-bars">${bars}</div>
    </div>`;
}

function renderTable(title, headers, rows, renderCell) {
    if (!rows || !rows.length) {
        return `<div class="admin-card admin-mb-lg">
            <div class="admin-card__title">${esc(title)}</div>
            <div class="admin-empty"><div class="admin-empty__text">No data in the selected range</div></div>
        </div>`;
    }
    const head = headers.map(h => `<th>${esc(h)}</th>`).join('');
    const body = rows.map(r => `<tr>${renderCell(r)}</tr>`).join('');
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">${esc(title)}</div>
        <div class="admin-table-wrap">
            <table class="admin-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
        </div>
    </div>`;
}

function renderRecentEvents(events) {
    if (!events || !events.length) {
        return `<div class="admin-card admin-mb-lg">
            <div class="admin-card__title">Recent Events</div>
            <div class="admin-empty"><div class="admin-empty__text">No events yet \u2014 tracker may still be rolling out. Hit a public page to generate one.</div></div>
        </div>`;
    }
    const rows = events.map(e => {
        const when = e.created_at ? new Date(e.created_at).toLocaleString('en-NZ') : MISSING;
        const dev = (e.device || 'unknown').toLowerCase();
        const icon = DEVICE_ICON[dev] || '';
        const refHost = e.referrer_host || (e.referrer ? '(raw)' : 'direct');
        return `<tr>
            <td class="admin-mono">${esc(when)}</td>
            <td>${icon} ${esc(deviceLabel(e.device))}</td>
            <td>${esc(e.os || '')}</td>
            <td>${esc(e.browser || '')}</td>
            <td><span class="admin-chip admin-chip--${e.event_type === 'click' ? 'info' : 'success'}">${esc(e.event_type || '')}</span></td>
            <td class="admin-mono">${esc(e.path || '')}</td>
            <td>${esc(e.element || '')}</td>
            <td>${esc(refHost)}</td>
        </tr>`;
    }).join('');
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Recent Events <small style="color:var(--text-muted);font-weight:400">\u2014 last ${events.length} clicks & pageviews</small></div>
        <div class="admin-table-wrap">
            <table class="admin-table">
                <thead><tr>
                    <th>Time</th><th>Device</th><th>OS</th><th>Browser</th><th>Type</th><th>Path</th><th>Element</th><th>Referrer</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    </div>`;
}

// ---- Traffic over time ----

const SEV_META = {
    opportunity: { label: 'Opportunity', icon: '🚀' }, // 🚀
    watch:       { label: 'Watch',       icon: '⚠️' },  // ⚠️
    win:         { label: 'Working',     icon: '✅' },        // ✅
    info:        { label: 'Note',        icon: 'ℹ️' },  // ℹ️
};

function trendChip(trend) {
    if (!trend) return '';
    const arrow = trend.dir === 'up' ? '↗' : trend.dir === 'down' ? '↘' : '→';
    const cls = trend.dir === 'up' ? 'admin-kpi__delta--up' : trend.dir === 'down' ? 'admin-kpi__delta--down' : 'admin-kpi__delta--flat';
    const word = trend.dir === 'up' ? 'rising' : trend.dir === 'down' ? 'falling' : 'flat';
    return `<span class="admin-traffic-trend ${cls}">${arrow} ${esc(word)} ${Math.abs(trend.pct).toFixed(0)}%</span>`;
}

// Granularity → human noun for body copy ("avg / day" etc.).
function granularityNoun(g) {
    return g === 'week' ? 'week' : g === 'month' ? 'month' : 'day';
}

// Long-form tooltip header for a bucket. This is the headline UX of the chart:
// daily granularity says "Saturday 23 May 2026" (full weekday), weekly says
// "Mon 18 – Sun 24 May 2026", monthly says "May 2026". Locale en-NZ so the
// day order matches the rest of the admin and DST never sneaks an off-by-one in.
function tooltipTitleForBucket(bucket, granularity) {
    if (!bucket) return '';
    if (granularity === 'day') {
        return new Date(bucket.start + 'T00:00:00Z').toLocaleDateString('en-NZ', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        });
    }
    if (granularity === 'week') {
        const start = new Date(bucket.start + 'T00:00:00Z');
        const end = new Date(bucket.end + 'T00:00:00Z');
        const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
        const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
        const fmtStart = sameMonth
            ? start.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
            : start.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
        const fmtEnd = end.toLocaleDateString('en-NZ', {
            weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        });
        return `${fmtStart} – ${fmtEnd}`;
    }
    // month
    const d = new Date(bucket.start + 'T00:00:00Z');
    return d.toLocaleDateString('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Short axis-tick label for a bucket — keeps the x-axis readable when the
// window is long. Weekday omitted here; the rich form is reserved for the
// tooltip so the axis doesn't visually clutter at high bucket counts.
function axisLabelForBucket(bucket, granularity) {
    const opts = (GRANULARITY_OPTIONS.find(o => o.value === granularity) || GRANULARITY_OPTIONS[0]).axisOpts;
    return new Date(bucket.start + 'T00:00:00Z').toLocaleDateString('en-NZ', { ...opts, timeZone: 'UTC' });
}

function granularityToggleHtml(active) {
    const buttons = GRANULARITY_OPTIONS.map((o) => {
        const isActive = o.value === active;
        const aria = isActive ? 'true' : 'false';
        const cls = `admin-segmented__btn${isActive ? ' admin-segmented__btn--active' : ''}`;
        return `<button type="button" class="${cls}" role="tab" aria-selected="${aria}" data-granularity="${o.value}">${o.label}</button>`;
    }).join('');
    return `<div class="admin-segmented" role="tablist" aria-label="Bar width">${buttons}</div>`;
}

// Headline traffic-over-time card. Renders the chart shell + a summary stats
// line; the canvas is drawn by drawTrafficChart() once it's in the DOM.
function renderTrafficChartCard(series) {
    if (!series.length) {
        return `<div class="admin-card admin-mb-lg">
            <div class="admin-card__title">Traffic Over Time</div>
            <div class="admin-empty">
                <div class="admin-empty__text">No daily traffic in the selected range — widen the window or wait for the tracker to collect more data.</div>
            </div>
        </div>`;
    }
    const t = seriesTotals(series);
    const trend = trendDirection(series);
    const buckets = bucketSeries(series, _granularity);
    const noun = granularityNoun(_granularity);

    // "Busiest <bucket>" + "Avg / <bucket>" both reflect the active granularity
    // — when the bars span a week each, "busiest day" would be a lie.
    let peakBucket = null;
    for (const b of buckets) if (!peakBucket || b.sessions > peakBucket.sessions) peakBucket = b;
    const peakStr = peakBucket
        ? `${axisLabelForBucket(peakBucket, _granularity)} (${fmt(peakBucket.sessions)})`
        : MISSING;
    const avgPerBucket = buckets.length ? Math.round(t.sessions / buckets.length) : 0;

    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title admin-traffic-card__title">
            <span>
                Traffic Over Time
                <small style="color:var(--text-muted);font-weight:400">— sessions &amp; pageviews per ${esc(noun)} ${trendChip(trend)}</small>
            </span>
            ${granularityToggleHtml(_granularity)}
        </div>
        <div class="admin-traffic-summary">
            <div class="admin-traffic-summary__stat"><span>Sessions</span><strong>${fmt(t.sessions)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Pageviews</span><strong>${fmt(t.pageviews)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Avg / ${esc(noun)}</span><strong>${fmt(avgPerBucket)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Pages / session</span><strong>${t.pagesPerSession.toFixed(1)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Busiest ${esc(noun)}</span><strong>${esc(peakStr)}</strong></div>
        </div>
        <div class="admin-chart-box admin-chart-box--tall"><canvas id="${TRAFFIC_CHART_ID}"></canvas></div>
    </div>`;
}

// Paint the bar chart. Sessions (cyan) and Pageviews (magenta) render as two
// grouped bars per bucket; bar widths derive from the active granularity
// (1 day / 1 week / 1 month) by re-bucketing the daily series client-side.
// Tooltip header is the bucket's long-form date — the headline UX of the card.
// Fire-and-forget; Charts.bar is async (lazy-loads Chart.js) and no-ops if the
// canvas has already been replaced by a later render.
function drawTrafficChart(series) {
    if (!series.length) return;
    const colors = Charts.getThemeColors();
    const buckets = bucketSeries(series, _granularity);
    if (!buckets.length) return;

    const labels = buckets.map((b) => axisLabelForBucket(b, _granularity));
    const sessions = buckets.map((b) => b.sessions);
    const pageviews = buckets.map((b) => b.pageviews);

    // Bar styling — chunky for month buckets (few, wide), thinner for day.
    const datasets = [
        {
            label: 'Sessions',
            data: sessions,
            backgroundColor: hexToRgba(colors.cyan, 0.85),
            hoverBackgroundColor: colors.cyan,
            borderColor: colors.cyan,
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            categoryPercentage: 0.78,
            barPercentage: 0.92,
        },
        {
            label: 'Pageviews',
            data: pageviews,
            backgroundColor: hexToRgba(colors.magenta, 0.85),
            hoverBackgroundColor: colors.magenta,
            borderColor: colors.magenta,
            borderWidth: 0,
            borderRadius: 4,
            borderSkipped: false,
            categoryPercentage: 0.78,
            barPercentage: 0.92,
        },
    ];

    const noun = granularityNoun(_granularity);

    Charts.bar(TRAFFIC_CHART_ID, {
        labels,
        datasets,
        options: {
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: colors.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, usePointStyle: true },
                },
                tooltip: {
                    // Long-form weekday + date headline — the headline UX of this card.
                    callbacks: {
                        title: (items) => {
                            if (!items || !items.length) return '';
                            const idx = items[0].dataIndex;
                            return tooltipTitleForBucket(buckets[idx], _granularity);
                        },
                        label: (ctx) => {
                            const v = Number(ctx.parsed?.y);
                            const n = Number.isFinite(v) ? v.toLocaleString('en-NZ') : ctx.formattedValue;
                            return `${ctx.dataset.label}: ${n}`;
                        },
                        // Pageviews / session footer — a small but useful sanity number.
                        footer: (items) => {
                            if (!items || !items.length) return '';
                            const idx = items[0].dataIndex;
                            const b = buckets[idx];
                            if (!b || !b.sessions) return '';
                            const pps = b.pageviews / b.sessions;
                            const dayCount = b.days || 1;
                            const dayBit = _granularity === 'day' ? '' : ` · ${dayCount} day${dayCount === 1 ? '' : 's'} of data`;
                            return `${pps.toFixed(1)} pages / session${dayBit}`;
                        },
                    },
                },
            },
            scales: {
                x: { stacked: false, grid: { display: false } },
                y: { beginAtZero: true, ticks: { precision: 0 } },
            },
        },
    });
    // For one-bucket views (e.g. month-granularity over a 10-day window) the
    // tooltip still works but the lonely bar looks sad — Chart.js handles the
    // single-category layout for us; no extra work needed.
    void noun;
}

// Wire the segmented Day/Week/Month control to re-bucket + re-draw. Delegated
// on the persistent _container (NOT on the card itself, which is swapped out
// on every toggle — binding on the card would lose the handler after one click).
function bindGranularityToggle() {
    if (!_container || _container._granularityBound) return;
    _container._granularityBound = true;
    _container.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-granularity]');
        if (!btn || !_container.contains(btn)) return;
        const v = btn.getAttribute('data-granularity');
        if (!v || v === _granularity) return;
        const card = btn.closest('.admin-card');
        if (!card) return;
        _granularity = v;
        writeGranularity(v);
        // Repaint just the chart card so the surrounding KPIs don't flicker.
        const fresh = document.createElement('div');
        fresh.innerHTML = renderTrafficChartCard(_lastSeries);
        const newCard = fresh.firstElementChild;
        if (newCard) {
            card.replaceWith(newCard);
            drawTrafficChart(_lastSeries);
        }
    });
}

// Prioritised marketing recommendations.
function renderInsights(insights) {
    if (!insights || !insights.length) return '';
    const cards = insights.map((ins) => {
        const meta = SEV_META[ins.severity] || SEV_META.info;
        return `<div class="admin-insight admin-insight--${esc(ins.severity)}">
            <div class="admin-insight__head">
                <span class="admin-insight__icon" aria-hidden="true">${meta.icon}</span>
                <span class="admin-insight__tag">${esc(meta.label)}</span>
                <span class="admin-insight__title">${esc(ins.title)}</span>
            </div>
            <div class="admin-insight__detail">${esc(ins.detail)}</div>
        </div>`;
    }).join('');
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">
            Marketing Insights
            <small style="color:var(--text-muted);font-weight:400">— where to pull in more traffic, ranked</small>
        </div>
        <div class="admin-insights">${cards}</div>
    </div>`;
}

// ---- Backend calls ----

// Every traffic fetch returns the same envelope so the renderer can tell
// "aborted-during-filter-change" apart from "401 auth expired" apart from
// "500/network — Render backend cold-starting". The old shape (plain `null` on
// any failure) made every cause look identical, which is why the page used to
// flash "Backend endpoint not available yet" when the backend was just slow.
//
//   { ok: true,  data }                       — success (data may still be null/empty)
//   { ok: false, status: 401 | 404 | 500 ...} — server responded with non-2xx
//   { ok: false, aborted: true }              — AbortController fired (filter change)
//   { ok: false, network: true, message }     — fetch threw (offline, CORS, timeout)
async function apiGet(path, signal) {
    try {
        const url = `${Config.API_URL}${path}`;
        const token = window.Auth?.session?.access_token;
        const resp = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            credentials: 'include',
            signal,
        });
        if (!resp.ok) return { ok: false, status: resp.status };
        const json = await resp.json();
        return { ok: true, data: json?.data ?? json ?? null };
    } catch (e) {
        if (e.name === 'AbortError') return { ok: false, aborted: true };
        DebugLog.warn('[website-traffic] fetch failed:', e.message);
        return { ok: false, network: true, message: e.message };
    }
}

async function loadAll() {
    const params = FilterState.getParams();
    const signal = FilterState.getAbortSignal();
    const qs = params.toString();
    const from = params.get('from');
    const to = params.get('to');

    // Previous equal-length window powers the period-over-period KPI deltas.
    const prev = (from && to) ? previousRange(from, to) : null;
    const prevQs = prev ? `from=${prev.from}&to=${prev.to}` : null;

    // "Not requested" is success-with-null-data, not failure. Otherwise the
    // no-prev-range case would trip the all-failed empty-state.
    const okNull = { ok: true, data: null };

    const [summary, recent, timeseries, prevSummary] = await Promise.allSettled([
        apiGet(`/api/admin/analytics/traffic/summary?${qs}`, signal),
        apiGet(`/api/admin/analytics/traffic/recent?limit=50`, signal),
        (from && to)
            ? apiGet(`/api/admin/analytics/traffic/timeseries?from=${from}&to=${to}`, signal)
            : Promise.resolve(okNull),
        prevQs
            ? apiGet(`/api/admin/analytics/traffic/summary?${prevQs}`, signal)
            : Promise.resolve(okNull),
    ]);

    const flat = (r) => r.status === 'fulfilled' ? r.value : { ok: false, network: true };
    return {
        summary: flat(summary),
        recent: flat(recent),
        timeseries: flat(timeseries),
        prevSummary: flat(prevSummary),
    };
}

// ---- Render ----

let _container = null;

// Categorised empty-state when EVERY traffic fetch failed (i.e. the page has
// no data at all to render). Different reason → different copy and CTA:
//
//   reason === 'auth'      → 401 from the backend. Session expired; nudge to sign in.
//   reason === 'missing'   → 404 specifically on /summary. The endpoint really is
//                            not deployed (used to be the default; very rare now).
//   reason === 'transient' → 500 / network / timeout. The far more common case —
//                            Render free-tier cold-starts can stall the first fetch.
//                            Show a friendly retry button.
//
// The old default of "Backend endpoint not available yet" was wrong for the
// cold-start case (the endpoint IS deployed) and gave users no recovery path.
function loadFailedHero(reason = 'transient') {
    const isAuth = reason === 'auth';
    const isMissing = reason === 'missing';

    const title = isAuth
        ? 'Sign-in expired'
        : isMissing
            ? 'Traffic endpoints not deployed yet'
            : "Couldn't load website traffic";

    const detail = isAuth
        ? 'Your admin session has expired. Sign in again to continue viewing traffic data.'
        : isMissing
            ? 'The first-party tracker is live on the site, but the admin read endpoints '
              + '(/api/admin/analytics/traffic/summary, /recent, /timeseries) returned 404. '
              + 'Wait for the backend deploy to finish, then retry.'
            : "This is usually a brief network hiccup or a cold-start on the backend. "
              + "Try again in a moment — the data is still there.";

    const cta = isAuth
        ? `<a class="admin-btn admin-btn--primary" href="/login.html?return=${encodeURIComponent('/admin#website-traffic')}">Sign in</a>`
        : `<button type="button" class="admin-btn admin-btn--primary" data-action="retry-traffic">Retry</button>`;

    return `<div class="admin-card admin-mb-lg admin-traffic-error" data-reason="${esc(reason)}">
        <div class="admin-empty">
            <div class="admin-empty__title">${esc(title)}</div>
            <div class="admin-empty__text">${esc(detail)}</div>
            <div class="admin-empty__cta" style="margin-top:14px;">${cta}</div>
        </div>
    </div>`;
}

// Decide which load-failure flavour to show based on the per-fetch envelopes.
// Auth wins (any single 401 means the user must re-sign-in). Otherwise if the
// summary endpoint specifically 404'd we surface "not deployed". Default is
// the friendly transient retry — Render free-tier cold-starts land here.
function categoriseFailure({ summary, recent, timeseries }) {
    const results = [summary, recent, timeseries];
    if (results.some(r => r && r.status === 401)) return 'auth';
    if (summary && summary.status === 404) return 'missing';
    return 'transient';
}

// Skeleton matching the eventual layout — 6 KPI tiles, chart card with summary
// strip + tall chart area, marketing-insights row, two-up breakdown row, a wide
// table card. Renders to the same grid classes the live layout uses so the page
// does not "jump" when real content arrives.
function skeleton() {
    const tile = '<div class="admin-skel admin-skel__tile" aria-hidden="true"></div>';
    const stat = '<div class="admin-skel admin-skel__stat" aria-hidden="true"></div>';
    return `
        <div class="admin-skeleton" role="status" aria-label="Loading website traffic">
            <span class="admin-sr-only">Loading website traffic…</span>
            <div class="admin-kpi-grid admin-kpi-grid--6 admin-mb-lg">
                ${tile}${tile}${tile}${tile}${tile}${tile}
            </div>
            <div class="admin-card admin-mb-lg">
                <div class="admin-skel admin-skel__line admin-skel__line--title"></div>
                <div class="admin-traffic-summary">
                    ${stat}${stat}${stat}${stat}${stat}
                </div>
                <div class="admin-chart-box admin-chart-box--tall">
                    <div class="admin-skel admin-skel__chart"></div>
                </div>
            </div>
            <div class="admin-grid-2 admin-mb-lg">
                <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div>
                    <div class="admin-skel admin-skel__row"></div>
                    <div class="admin-skel admin-skel__row"></div>
                    <div class="admin-skel admin-skel__row"></div>
                </div>
                <div class="admin-card"><div class="admin-skel admin-skel__line admin-skel__line--title"></div>
                    <div class="admin-skel admin-skel__row"></div>
                    <div class="admin-skel admin-skel__row"></div>
                    <div class="admin-skel admin-skel__row"></div>
                </div>
            </div>
        </div>
    `;
}

async function render() {
    if (!_container) return;
    const mySeq = ++_renderSeq;

    // First load → matched-layout skeleton. Re-load → keep the previous content
    // visible and add a `--reloading` dim so users can tell something is happening,
    // but DON'T blow away the page (that's what made the empty-hero flash visible).
    if (!_hasRenderedSuccessfully) {
        _container.innerHTML = `<div class="admin-page-header"><h1>Website Traffic</h1></div>
            <div id="traffic-body">${skeleton()}</div>`;
    } else {
        _container.classList.add('admin-page--reloading');
    }

    const envelope = await loadAll();

    // RACE GUARD: bail if we've been superseded by a newer render. Without this,
    // a previous render whose fetches all aborted (because FilterState got a new
    // AbortController) would paint a stale state on top of the live #traffic-body.
    if (mySeq !== _renderSeq || !_container) return;

    _container.classList.remove('admin-page--reloading');

    // Ensure the page shell exists — on filter-change re-loads we didn't reset it.
    let body = _container.querySelector('#traffic-body');
    if (!body) {
        _container.innerHTML = `<div class="admin-page-header"><h1>Website Traffic</h1></div>
            <div id="traffic-body"></div>`;
        body = _container.querySelector('#traffic-body');
    }

    const { summary, recent, timeseries, prevSummary } = envelope;

    // Unwrap envelopes — `ok:false` means no data; `ok:true` means use `data`.
    // A user-visible "everything failed" only fires when none of the three core
    // endpoints (summary / recent / timeseries) returned data — and only when
    // the failure was a real failure (not the AbortError that a stale render
    // would produce). The seq guard above already caught the stale-abort case,
    // but we double-check here so a `{ok:false, aborted:true}` from a non-stale
    // path doesn't trigger a misleading "couldn't load" card.
    const summaryData    = summary.ok    ? (summary.data    || {}) : null;
    const recentData     = recent.ok     ? (recent.data     || []) : null;
    const timeseriesData = timeseries.ok ? timeseries.data         : null;
    const prevSummaryData = prevSummary.ok ? (prevSummary.data || null) : null;

    const everythingFailed = !summary.ok && !recent.ok && !timeseries.ok;
    const everythingAborted = summary.aborted && recent.aborted && timeseries.aborted;
    if (everythingFailed && !everythingAborted) {
        body.innerHTML = loadFailedHero(categoriseFailure(envelope));
        const retry = body.querySelector('[data-action="retry-traffic"]');
        if (retry) retry.addEventListener('click', () => { render(); });
        return;
    }

    // Partial failure → render what we have; the missing pieces will just be
    // empty rows / breakdown placeholders. Surface a narrow inline banner so the
    // user knows the page is incomplete, not lying.
    const partialFailure = (summary.ok || recent.ok || timeseries.ok)
        && (!summary.ok || !recent.ok || !timeseries.ok);

    const s = summaryData || {};
    const series = normalizeSeries(timeseriesData);
    _lastSeries = series; // stash so the granularity toggle can redraw without refetching
    const deltas = computeDeltas(s, prevSummaryData);
    const insights = summary.ok && summaryData ? generateInsights({ summary: s, series, deltas }) : [];
    const devices = (s.device_breakdown || []).map(r => ({ label: deviceLabel(r.device), count: r.count }));
    const browsers = (s.browser_breakdown || []).map(r => ({ label: r.browser || 'Unknown', count: r.count }));
    const os = (s.os_breakdown || []).map(r => ({ label: r.os || 'Unknown', count: r.count }));
    const channels = (s.channel_breakdown || []).map(r => ({ label: r.channel || 'Unknown', count: r.count }));

    // Campaign attribution — campaign-visitor-tracking-may2026.md §1.
    // Backend guarantees 0 (never null) when nothing matches; coerce defensively
    // anyway so a malformed envelope doesn't paint "NaN% of unique visitors".
    const campaignVisitors = Number.isFinite(s.campaign_visitors) ? s.campaign_visitors : 0;
    const campaignPercent = Number.isFinite(s.campaign_visitor_percent) ? s.campaign_visitor_percent : 0;

    // Narrow inline banner when SOME data loaded but not all. Lists which
    // bucket dropped so the user knows what to retry.
    const partialBanner = partialFailure
        ? `<div class="admin-traffic-partial-banner" role="status">
              <span>⚠️ Some traffic data didn't load (${[
                  !summary.ok    ? 'summary' : null,
                  !recent.ok     ? 'recent events' : null,
                  !timeseries.ok ? 'time series' : null,
              ].filter(Boolean).join(', ')}) — showing what we have.</span>
              <button type="button" class="admin-btn admin-btn--small" data-action="retry-traffic">Retry</button>
           </div>`
        : '';

    body.innerHTML = `
        ${partialBanner}
        <div class="admin-kpi-grid admin-kpi-grid--6 admin-mb-lg">
            ${kpi({ label: 'Sessions', value: fmt(s.sessions), delta: deltas.sessions })}
            ${kpi({ label: 'Pageviews', value: fmt(s.pageviews), delta: deltas.pageviews })}
            ${kpi({ label: 'Unique Visitors', value: fmt(s.unique_visitors), delta: deltas.unique_visitors })}
            ${kpi({ label: 'Campaign Visitors', value: fmt(campaignVisitors), sub: `${campaignPercent.toFixed(1)}% of unique visitors` })}
            ${kpi({ label: 'Avg Session', value: duration(s.avg_session_duration), delta: deltas.avg_session_duration })}
            ${kpi({ label: 'Bounce Rate', value: s.bounce_rate != null ? pct(s.bounce_rate) : MISSING, delta: deltas.bounce_rate })}
        </div>

        ${renderTrafficChartCard(series)}

        ${renderInsights(insights)}

        <div class="admin-grid-2 admin-mb-lg">
            ${renderBreakdown('Device', devices)}
            ${renderBreakdown('Channel', channels)}
        </div>

        <div class="admin-grid-2 admin-mb-lg">
            ${renderBreakdown('Browser', browsers)}
            ${renderBreakdown('Operating System', os)}
        </div>

        ${renderCampaignBreakdown(s.campaign_breakdown)}

        ${renderTable('Top Pages', ['Path', 'Pageviews', 'Uniques'], s.top_pages || [], (r) => `
            <td class="admin-mono">${esc(r.path || '')}</td>
            <td>${fmt(r.pageviews)}</td>
            <td>${fmt(r.unique_visitors)}</td>
        `)}

        ${renderTable('Top Referrers', ['Source', 'Sessions'], s.top_referrers || [], (r) => `
            <td>${esc(r.referrer_host || 'direct')}</td>
            <td>${fmt(r.sessions)}</td>
        `)}

        ${renderRecentEvents(Array.isArray(recentData) ? recentData : (recentData?.events || []))}
    `;

    // Wire the partial-failure banner's Retry button.
    const partialRetry = body.querySelector('.admin-traffic-partial-banner [data-action="retry-traffic"]');
    if (partialRetry) partialRetry.addEventListener('click', () => { render(); });

    // Canvas now exists in the DOM — paint the bar chart. Fire-and-forget:
    // Charts.bar is async (lazy-loads Chart.js) and no-ops if the node is gone.
    drawTrafficChart(series);
    bindGranularityToggle();

    // Mark first-load as done so subsequent renders use the dim-and-replace
    // path instead of the skeleton (the skeleton flashing on every filter
    // change is exactly the bug we just fixed).
    _hasRenderedSuccessfully = true;
}

export default {
    title: 'Website Traffic',

    async init(container) {
        _container = container;
        FilterState.setVisibleFilters([]); // only the date-range presets
        await render();
    },

    destroy() {
        Charts.destroy(TRAFFIC_CHART_ID);
        _container = null;
        _hasRenderedSuccessfully = false; // next mount shows the skeleton again
        _lastSeries = [];
        // Bump the seq so any in-flight render() resolves to a stale check and bails.
        _renderSeq++;
    },

    async onFilterChange() {
        if (_container) await render();
    },
};
