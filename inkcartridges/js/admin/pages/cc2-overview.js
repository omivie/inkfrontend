/**
 * Control Center — Overview tab
 *
 * Lays out a HealthGrid (5 detailed cards, one per spec subsection) on top
 * of a "What does each card mean?" legend. Reuses the in-memory cache from
 * cc2-topbar so we don't double-fetch /health/summary on tab switch.
 *
 * Each card surfaces the *complete* set of counters for its subsection,
 * not just the single number the topbar shows — Overview is the place
 * to scan everything at a glance before drilling in.
 */
import { esc } from '../app.js';
import { getHealthSummary } from './cc2-topbar.js';

const SECTIONS = [
  {
    key: 'pricing', tab: 'pricing', title: 'Pricing',
    summary: (d) => d?.pricing,
    metrics: [
      { label: 'Anomalies (cost > retail)', read: (s) => s?.anomalies_count },
      { label: 'Zero-margin SKUs',          read: (s) => s?.zero_margin_count },
      { label: 'Tier drift (24h)',          read: (s) => s?.drift_count_24h },
    ],
    deepLink: 'Open Pricing →',
  },
  {
    key: 'packs', tab: 'packs', title: 'Packs',
    summary: (d) => d?.packs,
    metrics: [
      { label: 'Active packs',         read: (s) => s?.active_count },
      { label: 'Inactive packs',       read: (s) => s?.inactive_count },
      { label: 'Broken (constituents)', read: (s) => s?.broken_count },
      { label: 'Drifted retail',       read: (s) => s?.drifted_count },
    ],
    deepLink: 'Open Packs →',
  },
  {
    key: 'compat', tab: 'integrity', title: 'Compatibility',
    summary: (d) => d?.compat,
    metrics: [
      { label: 'Orphan printers',     read: (s) => s?.orphan_printers },
      { label: 'Type mismatches',     read: (s) => s?.type_mismatch_rows },
      { label: 'Series outliers',     read: (s) => s?.series_outliers },
    ],
    deepLink: 'Open Integrity →',
  },
  {
    key: 'seo', tab: 'seo', title: 'SEO',
    summary: (d) => d?.seo,
    metrics: [
      { label: 'Products without slug',   read: (s) => s?.null_slug_products },
      { label: 'Duplicate slugs',         read: (s) => s?.duplicate_slug_products },
      { label: 'Redirect chain loops',    read: (s) => s?.redirect_chain_loops },
    ],
    deepLink: 'Open SEO →',
  },
  {
    key: 'infra', tab: 'infra', title: 'Infra',
    summary: (d) => d?.infra,
    metrics: [
      { label: 'Image audit pending',     read: (s) => s?.image_audit_pending },
      { label: 'WebP failures (24h)',     read: (s) => s?.image_webp_failed_24h },
      { label: 'Prerender hit rate (24h)', read: (s) => s?.prerender_cache_hit_rate_24h, fmt: (n) => `${Number(n).toFixed(1)}%` },
      { label: 'Storage egress (24h)',    read: (s) => s?.storage_egress_bytes_24h, fmt: bytesToHuman },
    ],
    deepLink: 'Open Infra →',
  },
];

function bytesToHuman(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(1)} ${units[u]}`;
}

function renderMetric(m, section) {
  const raw = m.read(section);
  if (raw == null) return `<dt>${esc(m.label)}</dt><dd class="cc2-metric--null" title="Not measurable in this deployment">—</dd>`;
  const display = m.fmt ? m.fmt(raw) : Number(raw).toLocaleString();
  const tone = (typeof raw === 'number' && raw > 0 && /(anomal|broken|orphan|null|duplicate|loops|failed|drift|inactive|mismatch|outlier|pending)/i.test(m.label))
    ? 'cc2-metric--warn' : 'cc2-metric--ok';
  return `<dt>${esc(m.label)}</dt><dd class="${tone}">${esc(display)}</dd>`;
}

function render(host, data, switchTab) {
  if (!data) {
    host.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">No data</div>
      <div class="admin-empty__text">Health summary unavailable. Try refreshing.</div></div>`;
    return;
  }
  host.innerHTML = `
    <div class="cc2-section-header">
      <h2>System health</h2>
      <span class="cc2-meta">Refreshed ${esc(new Date(data.fetched_at || Date.now()).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' }))}${data.fallback ? ' · degraded' : ''}</span>
    </div>
    <div class="cc2-overview-grid" role="list">
      ${SECTIONS.map(s => {
        const sec = s.summary(data) || {};
        return `
          <article class="cc2-overview-card admin-card" role="listitem" aria-labelledby="cc2-overview-${s.key}">
            <header class="cc2-overview-card__header">
              <h3 id="cc2-overview-${s.key}">${esc(s.title)}</h3>
              <button class="cc2-overview-card__link" data-tab="${esc(s.tab)}">${esc(s.deepLink)}</button>
            </header>
            <dl class="cc2-overview-card__metrics">
              ${s.metrics.map(m => renderMetric(m, sec)).join('')}
            </dl>
          </article>
        `;
      }).join('')}
    </div>
    <p class="cc2-overview-help">
      Em-dash (—) means "not measurable in this deployment" — never zero. Counts are derived from
      <code>admin_health_summary()</code> in migration 057, in-memory infra counters, and on-demand
      compat queries.
    </p>
  `;
  host.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab?.(btn.dataset.tab));
  });
}

let _host = null;

export default {
  async init(host, ctx = {}) {
    _host = host;
    _host.innerHTML = `<div class="cc2-overview-grid">
      ${SECTIONS.map(() => `<div class="cc2-overview-card admin-card">
        <div class="admin-skeleton admin-skeleton--text" style="width:50%"></div>
        <div class="admin-skeleton admin-skeleton--text" style="width:80%;margin-top:12px"></div>
        <div class="admin-skeleton admin-skeleton--text" style="width:70%;margin-top:8px"></div>
        <div class="admin-skeleton admin-skeleton--text" style="width:65%;margin-top:8px"></div>
      </div>`).join('')}
    </div>`;
    const data = await getHealthSummary();
    if (_host) render(_host, data, ctx.switchTab);
  },
  destroy() { _host = null; },
};
