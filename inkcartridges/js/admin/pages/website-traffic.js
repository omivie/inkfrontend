/**
 * Website Traffic — first-party traffic analytics (pageviews + clicks)
 * Reads aggregates and recent events from backend RPCs powered by the
 * `traffic_events` Supabase table. See BACKEND_TRAFFIC_ANALYTICS_HANDOFF.md.
 */
import { FilterState, esc } from '../app.js';
import { Charts } from '../components/charts.js';
import {
    normalizeSeries, movingAverage, seriesTotals, trendDirection,
    previousRange, computeDeltas, generateInsights,
} from '../utils/traffic-analytics.js';

const MISSING = '\u2014';
const fmt = (n) => (n == null ? MISSING : Number(n).toLocaleString('en-NZ'));
const pct = (n) => (n == null ? MISSING : `${Number(n).toFixed(1)}%`);

const TRAFFIC_CHART_ID = 'chart-traffic-trend';

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
    const peakStr = t.peak
        ? `${new Date(t.peak.date + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })} (${fmt(t.peak.sessions)})`
        : MISSING;
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">
            Traffic Over Time
            <small style="color:var(--text-muted);font-weight:400">— daily sessions &amp; pageviews ${trendChip(trend)}</small>
        </div>
        <div class="admin-traffic-summary">
            <div class="admin-traffic-summary__stat"><span>Sessions</span><strong>${fmt(t.sessions)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Pageviews</span><strong>${fmt(t.pageviews)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Avg / day</span><strong>${fmt(Math.round(t.avgSessionsPerDay))}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Pages / session</span><strong>${t.pagesPerSession.toFixed(1)}</strong></div>
            <div class="admin-traffic-summary__stat"><span>Busiest day</span><strong>${esc(peakStr)}</strong></div>
        </div>
        <div class="admin-chart-box admin-chart-box--tall"><canvas id="${TRAFFIC_CHART_ID}"></canvas></div>
    </div>`;
}

// Paint the line chart. Sessions = filled cyan area, Pageviews = magenta line,
// plus a dashed 7-day moving-average of sessions once the window is long enough
// to make the smoothing meaningful. Fire-and-forget; safe if the canvas is gone.
function drawTrafficChart(series) {
    if (!series.length) return;
    const colors = Charts.getThemeColors();
    const labels = series.map((d) =>
        new Date(d.date + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' }));
    const sessions = series.map((d) => d.sessions);
    const pageviews = series.map((d) => d.pageviews);

    const datasets = [
        {
            label: 'Sessions',
            data: sessions,
            borderColor: colors.cyan,
            backgroundColor: hexToRgba(colors.cyan, 0.18),
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
        },
        {
            label: 'Pageviews',
            data: pageviews,
            borderColor: colors.magenta,
            backgroundColor: 'transparent',
            borderWidth: 2,
            fill: false,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
        },
    ];

    if (series.length >= 8) {
        datasets.push({
            label: '7-day avg (sessions)',
            data: movingAverage(sessions, 7),
            borderColor: colors.textMuted,
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 4],
            fill: false,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true,
        });
    }

    Charts.line(TRAFFIC_CHART_ID, {
        labels,
        datasets,
        options: {
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: colors.textMuted, font: { size: 11 }, boxWidth: 10, boxHeight: 10, usePointStyle: true },
                },
            },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
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

async function apiGet(path, signal) {
    try {
        const url = `${Config.API_URL}${path}`;
        const token = window.Auth?.session?.access_token;
        const resp = await fetch(url, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            credentials: 'include',
            signal,
        });
        if (!resp.ok) return null;
        const json = await resp.json();
        return json?.data ?? json ?? null;
    } catch (e) {
        if (e.name === 'AbortError') return null;
        DebugLog.warn('[website-traffic] fetch failed:', e.message);
        return null;
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

    const [summary, recent, timeseries, prevSummary] = await Promise.allSettled([
        apiGet(`/api/admin/analytics/traffic/summary?${qs}`, signal),
        apiGet(`/api/admin/analytics/traffic/recent?limit=50`, signal),
        (from && to)
            ? apiGet(`/api/admin/analytics/traffic/timeseries?from=${from}&to=${to}`, signal)
            : Promise.resolve(null),
        prevQs
            ? apiGet(`/api/admin/analytics/traffic/summary?${prevQs}`, signal)
            : Promise.resolve(null),
    ]);

    return {
        summary: summary.status === 'fulfilled' ? summary.value : null,
        recent: recent.status === 'fulfilled' ? recent.value : null,
        timeseries: timeseries.status === 'fulfilled' ? timeseries.value : null,
        prevSummary: prevSummary.status === 'fulfilled' ? prevSummary.value : null,
    };
}

// ---- Render ----

let _container = null;

function emptyHero() {
    return `<div class="admin-card admin-mb-lg">
        <div class="admin-card__title">Website Traffic</div>
        <div class="admin-empty">
            <div class="admin-empty__title">Backend endpoint not available yet</div>
            <div class="admin-empty__text">
                The first-party tracker is live on the site, but the admin read endpoints
                (<code>/api/admin/analytics/traffic/summary</code> and <code>/recent</code>)
                aren't deployed yet. See <code>BACKEND_TRAFFIC_ANALYTICS_HANDOFF.md</code>.
            </div>
        </div>
    </div>`;
}

async function render() {
    if (!_container) return;
    _container.innerHTML = `<div class="admin-page-header"><h1>Website Traffic</h1></div>
        <div id="traffic-body"><div class="admin-loading__spinner" style="margin:2rem auto"></div></div>`;

    const { summary, recent, timeseries, prevSummary } = await loadAll();
    const body = _container.querySelector('#traffic-body');
    if (!body) return;

    if (!summary && !recent && !timeseries) {
        body.innerHTML = emptyHero();
        return;
    }

    const s = summary || {};
    const series = normalizeSeries(timeseries);
    const deltas = computeDeltas(s, prevSummary);
    const insights = summary ? generateInsights({ summary: s, series, deltas }) : [];
    const devices = (s.device_breakdown || []).map(r => ({ label: deviceLabel(r.device), count: r.count }));
    const browsers = (s.browser_breakdown || []).map(r => ({ label: r.browser || 'Unknown', count: r.count }));
    const os = (s.os_breakdown || []).map(r => ({ label: r.os || 'Unknown', count: r.count }));
    const channels = (s.channel_breakdown || []).map(r => ({ label: r.channel || 'Unknown', count: r.count }));

    // Campaign attribution — campaign-visitor-tracking-may2026.md §1.
    // Backend guarantees 0 (never null) when nothing matches; coerce defensively
    // anyway so a malformed envelope doesn't paint "NaN% of unique visitors".
    const campaignVisitors = Number.isFinite(s.campaign_visitors) ? s.campaign_visitors : 0;
    const campaignPercent = Number.isFinite(s.campaign_visitor_percent) ? s.campaign_visitor_percent : 0;

    body.innerHTML = `
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

        ${renderRecentEvents(Array.isArray(recent) ? recent : (recent?.events || []))}
    `;

    // Canvas now exists in the DOM — paint the line chart. Fire-and-forget:
    // Charts.line is async (lazy-loads Chart.js) and no-ops if the node is gone.
    drawTrafficChart(series);
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
    },

    async onFilterChange() {
        if (_container) await render();
    },
};
