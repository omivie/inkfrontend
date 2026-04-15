/**
 * Website Traffic — first-party traffic analytics (pageviews + clicks)
 * Reads aggregates and recent events from backend RPCs powered by the
 * `traffic_events` Supabase table. See BACKEND_TRAFFIC_ANALYTICS_HANDOFF.md.
 */
import { FilterState, esc } from '../app.js';

const MISSING = '\u2014';
const fmt = (n) => (n == null ? MISSING : Number(n).toLocaleString('en-NZ'));
const pct = (n) => (n == null ? MISSING : `${Number(n).toFixed(1)}%`);

function duration(sec) {
    if (sec == null) return MISSING;
    const s = Math.round(Number(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

function kpi({ label, value, sub }) {
    let html = `<div class="admin-kpi">`;
    html += `<div class="admin-kpi__label">${esc(label)}</div>`;
    html += value != null
        ? `<div class="admin-kpi__value">${esc(String(value))}</div>`
        : `<span class="admin-kpi__value admin-kpi__value--missing" data-tooltip="No data in range">${MISSING}</span>`;
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

    const [summary, recent] = await Promise.allSettled([
        apiGet(`/api/admin/analytics/traffic/summary?${qs}`, signal),
        apiGet(`/api/admin/analytics/traffic/recent?limit=50`, signal),
    ]);

    return {
        summary: summary.status === 'fulfilled' ? summary.value : null,
        recent: recent.status === 'fulfilled' ? recent.value : null,
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

    const { summary, recent } = await loadAll();
    const body = _container.querySelector('#traffic-body');
    if (!body) return;

    if (!summary && !recent) {
        body.innerHTML = emptyHero();
        return;
    }

    const s = summary || {};
    const devices = (s.device_breakdown || []).map(r => ({ label: deviceLabel(r.device), count: r.count }));
    const browsers = (s.browser_breakdown || []).map(r => ({ label: r.browser || 'Unknown', count: r.count }));
    const os = (s.os_breakdown || []).map(r => ({ label: r.os || 'Unknown', count: r.count }));
    const channels = (s.channel_breakdown || []).map(r => ({ label: r.channel || 'Unknown', count: r.count }));

    body.innerHTML = `
        <div class="admin-kpi-grid admin-kpi-grid--5 admin-mb-lg">
            ${kpi({ label: 'Sessions', value: fmt(s.sessions) })}
            ${kpi({ label: 'Pageviews', value: fmt(s.pageviews) })}
            ${kpi({ label: 'Unique Visitors', value: fmt(s.unique_visitors) })}
            ${kpi({ label: 'Avg Session', value: duration(s.avg_session_duration) })}
            ${kpi({ label: 'Bounce Rate', value: s.bounce_rate != null ? pct(s.bounce_rate) : MISSING })}
        </div>

        <div class="admin-grid-2 admin-mb-lg">
            ${renderBreakdown('Device', devices)}
            ${renderBreakdown('Channel', channels)}
        </div>

        <div class="admin-grid-2 admin-mb-lg">
            ${renderBreakdown('Browser', browsers)}
            ${renderBreakdown('Operating System', os)}
        </div>

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
}

export default {
    title: 'Website Traffic',

    async init(container) {
        _container = container;
        FilterState.setVisibleFilters([]); // only the date-range presets
        await render();
    },

    destroy() {
        _container = null;
    },

    async onFilterChange() {
        if (_container) await render();
    },
};
