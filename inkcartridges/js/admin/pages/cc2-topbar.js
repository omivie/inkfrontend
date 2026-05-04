/**
 * Control Center — top-bar health row (5 tiles + clock)
 * Feeds from /api/admin/health/summary. Shared with Overview tab so both
 * paint at once and the Overview tab can reuse the same fetch result via
 * a shared in-memory cache (refreshed every 60s by control-center.js).
 *
 * `null` from the spec means "not measurable" — render an em-dash, never
 * a 0, so on-call doesn't think pricing has 0 anomalies when it's actually
 * "we couldn't tell."
 */
import { AdminAPI, esc, icon } from '../app.js';

const TILES = [
  { key: 'pricing', tab: 'pricing',   label: 'Pricing anomalies',          read: (d) => d?.pricing?.anomalies_count ?? null },
  { key: 'packs',   tab: 'packs',     label: 'Broken or inactive packs',   read: (d) => sumNullable(d?.packs?.broken_count, d?.packs?.inactive_count) },
  { key: 'compat',  tab: 'integrity', label: 'Orphan printers',            read: (d) => d?.compat?.orphan_printers ?? null },
  { key: 'seo',     tab: 'seo',       label: 'Products without slug',      read: (d) => d?.seo?.null_slug_products ?? null },
  { key: 'infra',   tab: 'infra',     label: 'Image audit pending',        read: (d) => d?.infra?.image_audit_pending ?? null },
];

function sumNullable(a, b) {
  if (a == null && b == null) return null;
  return (Number(a) || 0) + (Number(b) || 0);
}

let _host = null;
let _onTileClick = null;
let _lastFetched = null;

// Lightweight cross-tab cache so Overview reuses a fresh response without
// burning rate budget. Stale-after = 30s; both topbar refresh + Overview
// rerenders read from this rather than re-fetching.
const cache = {
  data: null,
  fetchedAt: 0,
  promise: null,
};

export async function getHealthSummary({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.fetchedAt < 30_000) return cache.data;
  if (cache.promise) return cache.promise;
  cache.promise = (async () => {
    const data = await AdminAPI.controlCenter.healthSummary();
    if (data) {
      cache.data = data;
      cache.fetchedAt = Date.now();
    }
    cache.promise = null;
    return data;
  })();
  return cache.promise;
}

function renderTiles(data) {
  if (!_host) return;
  const fetchedAt = data?.fetched_at
    ? new Date(data.fetched_at).toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' })
    : '—';
  _lastFetched = fetchedAt;

  _host.innerHTML = `
    <div class="cc2-topbar__row" role="list">
      ${TILES.map(t => {
        const n = data ? t.read(data) : null;
        const display = n == null ? '—' : Number(n).toLocaleString();
        const tone = n == null ? 'unmeasured' : n > 0 ? 'attention' : 'ok';
        const pillClass = n == null ? 'cc2-tile__pill--muted' : n > 0 ? 'cc2-tile__pill--warn' : 'cc2-tile__pill--ok';
        return `
          <button class="cc2-tile cc2-tile--${tone}" data-tab="${esc(t.tab)}" role="listitem"
                  aria-label="${esc(t.label)}: ${display}">
            <span class="cc2-tile__value">${esc(display)}</span>
            <span class="cc2-tile__label">${esc(t.label)}</span>
            <span class="cc2-tile__pill ${pillClass}">${n == null ? 'unmeasured' : n > 0 ? 'needs attention' : 'all clear'}</span>
          </button>
        `;
      }).join('')}
    </div>
    <div class="cc2-topbar__meta">
      <span>Last refreshed ${esc(fetchedAt)}</span>
      ${data?.fallback ? '<span class="cc2-topbar__warn">⚠ degraded data — RPC unavailable</span>' : ''}
      <button class="cc2-topbar__refresh admin-btn admin-btn--ghost admin-btn--sm" data-action="refresh">
        ${icon('search', 14, 14)} Refresh
      </button>
    </div>
  `;
  _host.querySelector('[data-action="refresh"]').addEventListener('click', () => refresh());
  _host.querySelectorAll('.cc2-tile').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab && _onTileClick) _onTileClick(tab);
    });
  });
}

async function refresh() {
  if (!_host) return;
  const data = await getHealthSummary({ force: true });
  renderTiles(data);
}

export default {
  async init(host, opts = {}) {
    _host = host;
    _onTileClick = opts.onTileClick || null;
    _host.innerHTML = `<div class="cc2-topbar__row">
      ${TILES.map(() => '<div class="cc2-tile cc2-tile--loading"><div class="admin-skeleton admin-skeleton--text" style="width:60%"></div></div>').join('')}
    </div>`;
    const data = await getHealthSummary();
    renderTiles(data);
  },

  refresh,

  destroy() {
    _host = null;
    _onTileClick = null;
    _lastFetched = null;
  },
};
