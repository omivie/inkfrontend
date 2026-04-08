/**
 * Control Center — Tab: Tech & Monitoring
 * System health, cron job history/summary, RLS policy status
 */
import { AdminAPI, AdminAuth, esc, icon } from '../app.js';
import { DataTable } from '../components/table.js';
import { Toast } from '../components/toast.js';

let _el = null;
let _cronTable = null;
let _cronPage = 1;
let _cronJobFilter = '';
let _cronStatusFilter = '';

function statusDot(ok) {
  const color = ok ? 'var(--success)' : 'var(--danger)';
  return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`;
}

// ---- System Health ----
async function loadHealth() {
  const grid = _el.querySelector('#mon-health-grid');
  grid.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:70px"></div>'.repeat(4);
  const data = await AdminAPI.getHealthCheck();
  if (!data) {
    grid.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not reach health endpoint</div></div>';
    return;
  }

  // Flexible: health may be flat object or nested { services: {...} }
  const services = data.services || data;
  const card = (label, val) => {
    const ok = val === true || val === 'ok' || val === 'healthy' || val === 'up';
    return `<div class="admin-kpi">
      <div class="admin-kpi__label">${statusDot(ok)}${esc(label)}</div>
      <div class="admin-kpi__value" style="font-size:16px;color:${ok ? 'var(--success)' : 'var(--danger)'}">${ok ? 'Healthy' : esc(String(val))}</div>
    </div>`;
  };

  // Try common keys, fall back to iterating all
  const knownKeys = ['api', 'database', 'cache', 'queue', 'redis', 'supabase'];
  const entries = [];
  for (const key of knownKeys) {
    if (services[key] !== undefined) entries.push([key, services[key]]);
  }
  // Add any remaining keys
  for (const [key, val] of Object.entries(services)) {
    if (!knownKeys.includes(key) && typeof val !== 'object') entries.push([key, val]);
  }
  if (!entries.length) entries.push(['Status', data.status || 'unknown']);

  grid.innerHTML = entries.map(([k, v]) => card(k.charAt(0).toUpperCase() + k.slice(1), v)).join('');
}

// ---- Cron Summary ----
async function loadCronSummary() {
  const grid = _el.querySelector('#mon-cron-summary');
  grid.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:60px"></div>'.repeat(3);
  const data = await AdminAPI.getCronSummary();
  if (!data) {
    grid.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No cron summary available</div></div>';
    return;
  }

  const jobs = Array.isArray(data) ? data : (data.jobs || data.summary || []);
  if (!jobs.length) {
    grid.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No cron jobs configured</div></div>';
    return;
  }

  // Populate job filter dropdown
  const jobSelect = _el.querySelector('#mon-job-filter');
  if (jobSelect && jobSelect.options.length <= 1) {
    for (const job of jobs) {
      const name = job.job_name || job.name || '';
      if (name) jobSelect.insertAdjacentHTML('beforeend', `<option value="${Security.escapeAttr(name)}">${esc(name)}</option>`);
    }
  }

  let html = '';
  for (const job of jobs) {
    const name = job.job_name || job.name || 'Unknown';
    const successRate = job.success_rate != null ? `${Number(job.success_rate).toFixed(0)}%` : '—';
    const lastRun = job.last_run_at || job.last_run ? new Date(job.last_run_at || job.last_run).toLocaleString('en-NZ') : '—';
    const avgDuration = job.avg_duration_ms != null ? `${(job.avg_duration_ms / 1000).toFixed(1)}s` : (job.avg_duration || '—');
    const ok = (job.success_rate ?? 100) >= 80;
    html += `<div class="admin-kpi">
      <div class="admin-kpi__label">${statusDot(ok)}${esc(name)}</div>
      <div style="display:flex;gap:16px;margin-top:4px;font-size:13px;color:var(--text-secondary)">
        <span>Success: <strong>${successRate}</strong></span>
        <span>Avg: <strong>${avgDuration}</strong></span>
        <span>Last: <strong>${lastRun}</strong></span>
      </div>
    </div>`;
  }
  grid.innerHTML = html;
}

// ---- Cron History Table ----
const CRON_COLS = [
  { key: 'started_at', label: 'Time', sortable: true, render: (r) => {
    const t = r.started_at || r.created_at || r.timestamp;
    return t ? `<span class="cell-mono" style="font-size:12px">${new Date(t).toLocaleString('en-NZ')}</span>` : '—';
  }},
  { key: 'job_name', label: 'Job', sortable: true, render: (r) => esc(r.job_name || r.name || '') },
  { key: 'status', label: 'Status', render: (r) => {
    const s = (r.status || '').toLowerCase();
    const cls = s === 'success' || s === 'completed' ? 'delivered' : s === 'failed' || s === 'error' ? 'refunded' : 'pending';
    return `<span class="admin-badge admin-badge--${cls}">${esc(r.status || 'unknown')}</span>`;
  }},
  { key: 'duration_ms', label: 'Duration', align: 'right', render: (r) => {
    if (r.duration_ms != null) return `<span class="cell-mono">${(r.duration_ms / 1000).toFixed(2)}s</span>`;
    if (r.duration) return `<span class="cell-mono">${esc(String(r.duration))}</span>`;
    return '—';
  }},
  { key: 'error', label: 'Error', render: (r) => {
    const err = r.error || r.error_message || '';
    return err ? `<span class="cell-truncate" style="max-width:200px;color:var(--danger)" title="${Security.escapeAttr(err)}">${esc(err)}</span>` : '';
  }},
];

async function loadCronHistory() {
  if (_cronTable) _cronTable.setLoading(true);
  const data = await AdminAPI.getCronHistory({
    job_name: _cronJobFilter,
    status: _cronStatusFilter,
    page: _cronPage,
    limit: 50,
  });
  if (!data) { if (_cronTable) _cronTable.setData([], null); return; }
  const rows = data.history || data.items || data.data || (Array.isArray(data) ? data : []);
  const meta = data.pagination || data.meta || {};
  if (_cronTable) _cronTable.setData(rows, { total: meta.total || rows.length, page: meta.page || _cronPage, limit: 50 });
}

// ---- RLS Status ----
async function loadRlsStatus() {
  const wrap = _el.querySelector('#mon-rls-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="admin-skeleton admin-skeleton--kpi" style="height:80px"></div>';
  const data = await AdminAPI.getRlsStatus();
  if (!data) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">Could not load RLS status</div></div>';
    return;
  }

  const tables = Array.isArray(data) ? data : (data.tables || data.policies || []);
  if (!tables.length) {
    wrap.innerHTML = '<div class="admin-empty"><div class="admin-empty__text">No RLS data returned</div></div>';
    return;
  }

  let html = `<table class="admin-table" style="margin:0">
    <thead><tr><th>Table</th><th>RLS Enabled</th><th>Policies</th></tr></thead><tbody>`;
  for (const t of tables) {
    const name = t.table_name || t.table || t.name || '';
    const enabled = t.rls_enabled ?? t.enabled ?? false;
    const policies = t.policies || t.policy_names || [];
    const policyList = Array.isArray(policies) ? policies.map(p => typeof p === 'string' ? p : (p.name || '')).join(', ') : String(policies);
    html += `<tr>
      <td class="cell-mono">${esc(name)}</td>
      <td>${statusDot(enabled)}${enabled ? 'Enabled' : '<span style="color:var(--danger);font-weight:600">Disabled</span>'}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${esc(policyList) || '—'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

export default {
  async init(el) {
    _el = el;
    _cronPage = 1;
    _cronJobFilter = '';
    _cronStatusFilter = '';

    const isOwner = AdminAuth.isOwner();

    el.innerHTML = `
      <div class="cc-section">
        <div class="cc-section__title" style="display:flex;align-items:center;gap:8px">
          System Health
          <button class="admin-btn admin-btn--ghost admin-btn--xs" id="mon-health-refresh" title="Refresh">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          </button>
        </div>
        <div class="admin-kpi-grid admin-kpi-grid--4" id="mon-health-grid"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Cron Job Summary (7 days)</div>
        <div id="mon-cron-summary" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>
      <div class="cc-section">
        <div class="cc-section__title">Cron Execution History</div>
        <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center">
          <select class="admin-select" id="mon-job-filter" style="min-width:140px;padding:5px 10px;font-size:13px">
            <option value="">All Jobs</option>
          </select>
          <select class="admin-select" id="mon-status-filter" style="min-width:120px;padding:5px 10px;font-size:13px">
            <option value="">All Statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div id="mon-cron-table"></div>
      </div>
      ${isOwner ? `
      <div class="cc-section">
        <div class="cc-section__title">RLS Policy Status</div>
        <div class="admin-card" id="mon-rls-wrap">
          <div class="admin-skeleton admin-skeleton--kpi" style="height:80px"></div>
        </div>
      </div>` : ''}
    `;

    // Health refresh
    el.querySelector('#mon-health-refresh').addEventListener('click', () => {
      Toast.info('Refreshing health check...');
      loadHealth();
    });

    // Cron filters
    el.querySelector('#mon-job-filter').addEventListener('change', (e) => {
      _cronJobFilter = e.target.value;
      _cronPage = 1;
      loadCronHistory();
    });
    el.querySelector('#mon-status-filter').addEventListener('change', (e) => {
      _cronStatusFilter = e.target.value;
      _cronPage = 1;
      loadCronHistory();
    });

    // Cron history table
    _cronTable = new DataTable(el.querySelector('#mon-cron-table'), {
      columns: CRON_COLS,
      rowKey: 'id',
      emptyMessage: 'No cron executions found',
      onPageChange: (page) => { _cronPage = page; loadCronHistory(); },
    });

    // Load all sections
    const loads = [loadHealth(), loadCronSummary(), loadCronHistory()];
    if (isOwner) loads.push(loadRlsStatus());
    await Promise.allSettled(loads);
  },

  destroy() {
    if (_cronTable) { _cronTable.destroy(); _cronTable = null; }
    _el = null;
  },

  onSearch(query) {
    // Could filter cron history — for now, no-op
  },
};
