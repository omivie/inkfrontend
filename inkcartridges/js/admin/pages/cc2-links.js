/**
 * Control Center — Links tab (broken-link audit)
 *
 * Whole-site broken-link report. A backend crawler
 * (readfirst/link-audit-backend-handoff-jul2026.md) walks the site's own
 * pages + outbound links, classifies each broken finding into buckets, and
 * records every source location it appears on. This tab surfaces:
 *   - three count cards (dead internal / dead external / redirect issues)
 *   - a drill-down table with per-link actions (Investigate / Re-check /
 *     Dismiss)
 *
 * The crawler is pending, so every AdminAPI call fails soft (returns null /
 * throws a caught error). Until it ships this tab renders a clean
 * "hasn't run yet" state rather than a broken panel.
 */
import { AdminAPI, esc, icon } from '../app.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const BUCKETS = [
  {
    key: 'dead_internal',
    title: 'Dead internal links',
    badgeTone: 'failed',
    description: 'Links to our own pages that resolve to 404 / 410 / 5xx — dead product pages, stale nav/footer/content links, missing category URLs. These hurt customers and SEO; fix or remove them.',
  },
  {
    key: 'dead_external',
    title: 'Dead external links',
    badgeTone: 'pending',
    description: 'Outbound links (brand, supplier, social) that time out or return an error. Update, remove, or dismiss if the block is expected (e.g. login-gated).',
  },
  {
    key: 'redirect_issues',
    title: 'Redirect issues',
    badgeTone: 'pending',
    description: 'Redirect loops/chains, and links that only survive via a redirect. Point them at the canonical target so nothing depends on the redirect.',
  },
];
const BUCKET_LABEL = Object.fromEntries(BUCKETS.map(b => [b.key, b.title]));

const TYPE_FILTERS = [
  { key: '', label: 'All' },
  { key: 'internal', label: 'Internal' },
  { key: 'external', label: 'External' },
];

let _host = null;
let _summary = null;
let _rows = [];
let _pagination = { total: 0, page: 1, limit: 50 };
let _filter = { bucket: '', type: '', search: '', page: 1 };
let _loadToken = 0;

// ---- Utilities ----

function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusBadge(row) {
  const code = row?.status;
  const label = code ? String(code) : (row?.reason || 'error');
  // 3xx = redirect issue tone, 5xx/timeout = failed, otherwise failed.
  const tone = (typeof code === 'number' && code >= 300 && code < 400) ? 'pending' : 'failed';
  return `<span class="admin-badge admin-badge--${tone}">${esc(label)}</span>`;
}

function typePill(type) {
  const t = type === 'external' ? 'external' : 'internal';
  return `<span class="cc2-links-type cc2-links-type--${t}">${t}</span>`;
}

// ---- Rendering ----

function renderCard(bucket) {
  const count = _summary?.[bucket.key]?.count ?? 0;
  const tone = count === 0 ? 'cc2-slug-card--ok' : 'cc2-slug-card--warn';
  const active = _filter.bucket === bucket.key ? ' cc2-links-card--active' : '';
  return `
    <button type="button" class="admin-card cc2-slug-card cc2-links-card ${tone}${active}"
            data-bucket="${esc(bucket.key)}" aria-pressed="${_filter.bucket === bucket.key}">
      <header class="cc2-slug-card__header">
        <div>
          <h3>${esc(bucket.title)}</h3>
          <p class="cc2-slug-card__desc">${esc(bucket.description)}</p>
        </div>
        <span class="cc2-slug-card__count admin-badge admin-badge--${count === 0 ? 'delivered' : bucket.badgeTone}">${count.toLocaleString()}</span>
      </header>
    </button>
  `;
}

function renderCards() {
  const grid = _host?.querySelector('#cc2-links-grid');
  if (!grid) return;
  grid.innerHTML = BUCKETS.map(renderCard).join('');
}

function renderFilters() {
  const bar = _host?.querySelector('#cc2-links-filters');
  if (!bar) return;
  bar.innerHTML = `
    <div class="cc2-links-typefilter" role="group" aria-label="Filter by link type">
      ${TYPE_FILTERS.map(t => `
        <button type="button" class="admin-btn admin-btn--sm ${_filter.type === t.key ? 'admin-btn--primary' : 'admin-btn--ghost'}"
                data-type="${esc(t.key)}">${esc(t.label)}</button>
      `).join('')}
    </div>
    <input class="admin-input cc2-links-search" data-search type="search"
           placeholder="Search URL…" value="${esc(_filter.search)}" autocomplete="off">
  `;
}

function renderTableRows() {
  if (!_rows.length) {
    const scope = _filter.bucket ? BUCKET_LABEL[_filter.bucket] : 'broken links';
    return `<tr><td colspan="6" class="cc2-slug-card__empty">No ${esc(scope.toLowerCase())} to show.</td></tr>`;
  }
  return _rows.map(r => `
    <tr data-id="${esc(r.id)}">
      <td><a class="cell-mono cc2-links-url" href="${esc(r.url || '#')}" target="_blank" rel="noopener nofollow">${esc(r.url || '—')}</a></td>
      <td>${statusBadge(r)}</td>
      <td>${typePill(r.type)}</td>
      <td><button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-investigate>${(r.sources?.length ?? 0).toLocaleString()}</button></td>
      <td class="cc2-links-when">${esc(timeAgo(r.last_checked))}</td>
      <td class="cc2-links-actions">
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-investigate title="Investigate">${icon('search', 14, 14)}</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-recheck title="Re-check">${icon('refresh', 14, 14)}</button>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-dismiss title="Dismiss / ignore">${icon('lock', 14, 14)}</button>
      </td>
    </tr>
  `).join('');
}

function renderTable() {
  const wrap = _host?.querySelector('#cc2-links-table');
  if (!wrap) return;
  const total = _pagination.total ?? _rows.length;
  wrap.innerHTML = `
    <div class="admin-table-wrap">
      <table class="admin-table cc2-links-tbl">
        <thead><tr>
          <th>URL</th><th>Status</th><th>Type</th><th>Appears on</th><th>Last checked</th><th></th>
        </tr></thead>
        <tbody>${renderTableRows()}</tbody>
      </table>
    </div>
    ${total > _rows.length ? `<p class="cc2-slug-card__truncated">Showing ${_rows.length.toLocaleString()} of ${total.toLocaleString()}.</p>` : ''}
  `;
}

function renderNotReady() {
  const body = _host?.querySelector('#cc2-links-body');
  if (!body) return;
  body.innerHTML = `
    <div class="admin-empty cc2-links-empty">
      <div class="admin-empty__title">Link scanning hasn't run yet</div>
      <div class="admin-empty__text">Once the site crawler has run, broken internal and external links show up here with the pages they appear on. Trigger the first scan to get started.</div>
      <button type="button" class="admin-btn admin-btn--primary" id="cc2-links-firstscan">${icon('refresh', 14, 14)} Run first scan</button>
    </div>
  `;
  body.querySelector('#cc2-links-firstscan')?.addEventListener('click', () => runScan());
}

function renderReport() {
  const body = _host?.querySelector('#cc2-links-body');
  if (!body) return;
  body.innerHTML = `
    <div class="cc2-slug-grid cc2-links-grid" id="cc2-links-grid"></div>
    <div class="cc2-links-toolbar" id="cc2-links-filters"></div>
    <div id="cc2-links-table"></div>
  `;
  renderCards();
  renderFilters();
  renderTable();
  bindReport();
}

// ---- Data ----

async function loadSummary() {
  _summary = await AdminAPI.controlCenter.getLinkAuditSummary();
  if (!_host) return; // ERR-045: destroyed mid-await
  const meta = _host.querySelector('#cc2-links-meta');
  if (meta) {
    meta.textContent = _summary?.last_scanned
      ? `Last scanned ${timeAgo(_summary.last_scanned)}`
      : 'Never scanned';
  }
}

async function loadList() {
  const token = ++_loadToken;
  const resp = await AdminAPI.controlCenter.getLinkAudit({
    bucket: _filter.bucket || undefined,
    type: _filter.type || undefined,
    search: _filter.search || undefined,
    page: _filter.page,
    limit: _pagination.limit,
  });
  if (!_host || token !== _loadToken) return; // superseded or destroyed
  _rows = resp?.data ?? resp?.rows ?? (Array.isArray(resp) ? resp : []);
  _pagination = {
    total: resp?.meta?.total ?? resp?.total ?? _rows.length,
    page: resp?.meta?.page ?? _filter.page,
    limit: resp?.meta?.limit ?? _pagination.limit,
  };
  renderTable();
}

async function load() {
  await loadSummary();
  if (!_host) return;
  if (!_summary) { renderNotReady(); return; }
  renderReport();
  await loadList();
}

// ---- Actions ----

function findRow(id) {
  return _rows.find(r => String(r.id) === String(id)) || null;
}

async function runScan(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  try {
    await AdminAPI.controlCenter.triggerLinkScan();
    if (!_host) return;
    Toast.success('Scan queued. Results refresh as the crawler works.');
    await load();
  } catch (e) {
    if (e.code === 'RATE_LIMITED') Toast.warning('A scan is already running — try again shortly.');
    else Toast.error(e.message || 'Could not start a scan.');
  } finally {
    if (btn && _host) { btn.disabled = false; btn.innerHTML = `${icon('refresh', 14, 14)} Re-scan now`; }
  }
}

async function recheck(id, tr) {
  const btn = tr?.querySelector('[data-recheck]');
  if (btn) btn.disabled = true;
  try {
    const updated = await AdminAPI.controlCenter.recheckLink(id);
    if (!_host) return;
    if (updated?.resolved) {
      Toast.success('Link now resolves — removed from the list.');
      _rows = _rows.filter(r => String(r.id) !== String(id));
      renderTable();
    } else {
      // Merge the refreshed status back into the row.
      const row = findRow(id);
      if (row && updated) Object.assign(row, updated);
      renderTable();
      Toast.info('Re-checked — still broken.');
    }
  } catch (e) {
    if (_host) Toast.error(e.message || 'Re-check failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function dismiss(id) {
  const row = findRow(id);
  Modal.confirm({
    title: 'Dismiss this link?',
    message: `<p>Stop flagging <code>${esc(row?.url || 'this link')}</code>. Use this for links that are broken on purpose or safe to ignore (e.g. login-gated pages). You can re-scan to bring it back.</p>`,
    confirmLabel: 'Dismiss',
    confirmClass: 'admin-btn--primary',
    onConfirm: async () => {
      try {
        await AdminAPI.controlCenter.dismissLink(id);
        if (!_host) return;
        _rows = _rows.filter(r => String(r.id) !== String(id));
        renderTable();
        Toast.success('Dismissed.');
        loadSummary();
      } catch (e) {
        if (_host) Toast.error(e.message || 'Dismiss failed.');
      }
    },
  });
}

function investigate(id) {
  const row = findRow(id);
  if (!row) return;
  const sources = row.sources || [];
  const sourcesHtml = sources.length === 0
    ? '<p class="cc2-slug-card__empty">Source pages weren\'t recorded for this link.</p>'
    : `<ul class="cc2-links-sources">
        ${sources.map(s => `
          <li>
            <div class="cc2-links-source__page">${esc(s.label || s.page || s.url || '—')}</div>
            ${s.page_url ? `<a class="cell-mono cc2-links-source__url" href="${esc(s.page_url)}" target="_blank" rel="noopener">${esc(s.page_url)}</a>` : ''}
            ${s.admin_hash ? `<a class="admin-btn admin-btn--ghost admin-btn--sm" href="#${esc(s.admin_hash.replace(/^#/, ''))}">${icon('settings', 13, 13)} Fix in ${esc(s.owner || 'editor')}</a>` : ''}
          </li>
        `).join('')}
      </ul>`;
  Drawer.open({
    title: 'Investigate broken link',
    body: `
      <div class="cc2-links-detail">
        <div class="cc2-links-detail__head">
          ${statusBadge(row)} ${typePill(row.type)}
          <span class="cc2-links-when">checked ${esc(timeAgo(row.last_checked))}</span>
        </div>
        <a class="cell-mono cc2-links-detail__url" href="${esc(row.url || '#')}" target="_blank" rel="noopener nofollow">${esc(row.url || '—')}</a>
        ${row.reason ? `<p class="cc2-links-detail__reason">${esc(row.reason)}</p>` : ''}
        ${row.suggested_canonical ? `<p class="cc2-links-detail__hint">Suggested target: <code>${esc(row.suggested_canonical)}</code></p>` : ''}
        <h4 class="cc2-links-detail__subhead">Appears on ${sources.length.toLocaleString()} page${sources.length === 1 ? '' : 's'}</h4>
        ${sourcesHtml}
        <div class="cc2-links-detail__actions">
          <a class="admin-btn admin-btn--ghost admin-btn--sm" href="${esc(row.url || '#')}" target="_blank" rel="noopener nofollow">Open URL ↗</a>
        </div>
      </div>
    `,
  });
}

// ---- Binding ----

function bindReport() {
  const grid = _host?.querySelector('#cc2-links-grid');
  grid?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-bucket]');
    if (!card) return;
    const b = card.dataset.bucket;
    _filter.bucket = _filter.bucket === b ? '' : b; // toggle
    _filter.page = 1;
    renderCards();
    loadList();
  });

  const filters = _host?.querySelector('#cc2-links-filters');
  filters?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    _filter.type = btn.dataset.type;
    _filter.page = 1;
    renderFilters();
    loadList();
  });
  let searchTimer = null;
  filters?.addEventListener('input', (e) => {
    const input = e.target.closest('[data-search]');
    if (!input) return;
    clearTimeout(searchTimer);
    const val = input.value.trim();
    searchTimer = setTimeout(() => {
      _filter.search = val;
      _filter.page = 1;
      loadList();
    }, 300);
  });

  const table = _host?.querySelector('#cc2-links-table');
  table?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.closest('[data-investigate]')) { e.preventDefault(); investigate(id); }
    else if (e.target.closest('[data-recheck]')) { recheck(id, tr); }
    else if (e.target.closest('[data-dismiss]')) { dismiss(id); }
  });
}

// ---- Lifecycle ----

export default {
  async init(host) {
    _host = host;
    _summary = null;
    _rows = [];
    _filter = { bucket: '', type: '', search: '', page: 1 };
    _pagination = { total: 0, page: 1, limit: 50 };
    _host.innerHTML = `
      <div class="cc2-section-header">
        <div>
          <h2>Broken links</h2>
          <span class="cc2-meta" id="cc2-links-meta">Loading…</span>
        </div>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="cc2-links-rescan">${icon('refresh', 14, 14)} Re-scan now</button>
      </div>
      <div id="cc2-links-body">
        <div class="admin-loader"><div class="admin-loading__spinner"></div></div>
      </div>
    `;
    _host.querySelector('#cc2-links-rescan')?.addEventListener('click', (e) => {
      runScan(e.currentTarget);
    });
    load();
  },
  destroy() {
    _host = null;
    _summary = null;
    _rows = [];
  },
};
