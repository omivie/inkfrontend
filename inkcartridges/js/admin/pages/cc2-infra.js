/**
 * Control Center — Infra tab (prerender cache + image pipeline + supplier feeds)
 *
 * Cards from /infra/prerender-health and /infra/image-pipeline plus
 * a deep link out to the existing /admin/image-audit page where humans
 * approve/replace pending images. Spec §5.10 / §5.11.
 *
 * Supplier feeds (2026-09-28): /supplier/import-status returns the last 5 runs
 * per feed since the backend fixed it (BF-070 h). The only page that rendered
 * it (cc-inventory) is not in the navigation, and it showed `latest` alone —
 * which read "completed" while the genuine feed had failed 2 of its last 5
 * nights. The card lives here, where Site Health is read; cc-inventory renders
 * the same importFeedsHtml() from utils/importStatus.js.
 */
import { AdminAPI, esc, icon } from '../app.js';
import { importFeedsHtml } from '../utils/importStatus.js';

function fmtPct(n) {
  return n == null ? '—' : `${Number(n).toFixed(1)}%`;
}

function bytesToHuman(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0; let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(1)} ${units[u]}`;
}

function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString();
}

function renderPrerender(p) {
  const c = p?.cache || {};
  const total = Number(c.total) || 0;
  const hits = Number(c.hits) || 0;
  const rate = c.hit_rate_24h ?? (total > 0 ? (hits / total) * 100 : null);
  const tone = rate == null ? 'unmeasured' : rate >= 80 ? 'ok' : rate >= 50 ? 'warn' : 'bad';
  return `
    <article class="admin-card cc2-infra-card cc2-infra-card--${tone}" aria-labelledby="cc2-infra-prerender">
      <header class="cc2-section-header">
        <h3 id="cc2-infra-prerender">Prerender cache</h3>
        <span class="admin-badge admin-badge--${p?.service_role_client_ok ? 'delivered' : 'failed'}">
          service role ${p?.service_role_client_ok ? 'OK' : 'down'}
        </span>
      </header>
      <div class="admin-kpi-grid admin-kpi-grid--3">
        <div class="admin-kpi"><div class="admin-kpi__label">Hits</div><div class="admin-kpi__value">${fmtNum(c.hits)}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Misses</div><div class="admin-kpi__value">${fmtNum(c.misses)}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Hit rate (24h)</div><div class="admin-kpi__value">${fmtPct(rate)}</div></div>
      </div>
      ${p?.note ? `<p class="cc2-infra-card__note">${esc(p.note)}</p>` : ''}
    </article>
  `;
}

function renderImagePipeline(p) {
  const w = p?.webp || {};
  const opt = p?.optimize_endpoint || {};
  const st = p?.storage || {};
  const savings = w.savings_pct;
  const tone = w.webp_failures > 0 ? 'warn' : (savings != null && savings >= 30 ? 'ok' : 'unmeasured');
  return `
    <article class="admin-card cc2-infra-card cc2-infra-card--${tone}" aria-labelledby="cc2-infra-image">
      <header class="cc2-section-header">
        <h3 id="cc2-infra-image">Image pipeline</h3>
        <a class="admin-btn admin-btn--ghost admin-btn--sm" href="#genuine-image-audit">${icon('image', 14, 14)} Open image audit</a>
      </header>
      <div class="admin-kpi-grid admin-kpi-grid--4">
        <div class="admin-kpi"><div class="admin-kpi__label">WebP conversions</div><div class="admin-kpi__value">${fmtNum(w.webp_conversions)}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">WebP failures</div><div class="admin-kpi__value ${w.webp_failures > 0 ? 'cc2-infra__warn' : ''}">${fmtNum(w.webp_failures)}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Avg in / out</div><div class="admin-kpi__value">${bytesToHuman(w.avg_bytes_in)} → ${bytesToHuman(w.avg_bytes_out)}</div></div>
        <div class="admin-kpi"><div class="admin-kpi__label">Savings</div><div class="admin-kpi__value">${savings == null ? '—' : `${Number(savings).toFixed(1)}%`}</div></div>
      </div>
      <dl class="cc2-infra-card__meta">
        <dt>Optimize endpoint hit rate (24h)</dt><dd>${fmtPct(opt.hit_rate_24h)}</dd>
        ${opt.note ? `<dt>Note</dt><dd>${esc(opt.note)}</dd>` : ''}
        <dt>Storage bucket</dt><dd>${esc(st.bucket || '—')}</dd>
        <dt>CDN host</dt><dd>${esc(st.host || '—')}</dd>
        <dt>Total objects</dt><dd>${fmtNum(st.total_objects)}</dd>
        <dt>Egress (24h)</dt><dd>${bytesToHuman(st.last_egress_bytes_24h)}</dd>
      </dl>
    </article>
  `;
}

let _host = null;

export default {
  async init(host) {
    _host = host;
    _host.innerHTML = `
      <div class="cc2-section-header">
        <h2>Infrastructure</h2>
        <span class="cc2-meta">Prerender cache, image pipeline and supplier feed counters</span>
      </div>
      <div class="cc2-infra-grid" id="cc2-infra-grid">
        <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
      </div>
    `;
    const [prerender, image, feeds] = await Promise.all([
      AdminAPI.controlCenter.getPrerenderHealth(),
      AdminAPI.controlCenter.getImagePipeline(),
      AdminAPI.getSupplierImportStatus(),
    ]);
    if (!_host) return;
    const grid = _host.querySelector('#cc2-infra-grid');
    grid.innerHTML = `${importFeedsHtml(feeds, esc)}${renderPrerender(prerender)}${renderImagePipeline(image)}`;
  },
  destroy() { _host = null; },
};
