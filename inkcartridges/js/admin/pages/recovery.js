/**
 * Recovery / Data-Integrity Page
 * Backend: /api/admin/recovery/health-check (GET), /api/admin/recovery/data-integrity-audit (POST)
 */
import { AdminAPI, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';

let _container = null;

function renderHealth(health) {
  if (!health) return '<div class="admin-card"><em>No data</em></div>';

  const checks = health.checks || health.results || [];
  let rowsHtml = '';
  if (Array.isArray(checks) && checks.length > 0) {
    rowsHtml = checks.map(c => {
      const ok = c.ok === true || c.status === 'ok' || c.status === 'healthy';
      const badge = `<span class="admin-badge ${ok ? 'admin-badge--delivered' : 'admin-badge--refunded'}">${ok ? 'OK' : 'FAIL'}</span>`;
      return `<tr>
        <td>${esc(c.name || c.check || '')}</td>
        <td>${badge}</td>
        <td>${esc(c.message || c.detail || '')}</td>
        <td class="cell-right">${c.count != null ? c.count : ''}</td>
      </tr>`;
    }).join('');
  } else {
    // Fallback: render each top-level key as a check
    rowsHtml = Object.entries(health).map(([k, v]) => {
      const ok = v && (v === true || v.ok === true || v.healthy === true);
      const detail = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `<tr>
        <td>${esc(k)}</td>
        <td><span class="admin-badge ${ok ? 'admin-badge--delivered' : 'admin-badge--pending'}">${ok ? 'OK' : 'CHECK'}</span></td>
        <td class="cell-mono" style="font-size:11px">${esc(detail)}</td>
        <td></td>
      </tr>`;
    }).join('');
  }

  return `
    <div class="admin-card">
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Check</th><th>Status</th><th>Detail</th><th class="cell-right">Count</th></tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="4"><em>No checks reported</em></td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

async function runHealth() {
  const host = _container.querySelector('#health-output');
  host.innerHTML = '<div class="admin-card"><em>Running health check…</em></div>';
  try {
    const data = await AdminAPI.getRecoveryHealth();
    host.innerHTML = renderHealth(data);
  } catch (e) {
    host.innerHTML = `<div class="admin-card" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  }
}

async function runAudit() {
  if (!confirm('Run full data-integrity audit? This may take a while.')) return;
  const host = _container.querySelector('#audit-output');
  const btn = _container.querySelector('#run-audit-btn');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = 'Running…';
  host.innerHTML = '<div class="admin-card"><em>Auditing… (this can take several minutes)</em></div>';
  try {
    const data = await AdminAPI.runDataIntegrityAudit();
    Toast.success('Audit complete');
    host.innerHTML = `<div class="admin-card"><pre style="white-space:pre-wrap;font-size:12px;margin:0">${esc(JSON.stringify(data, null, 2))}</pre></div>`;
  } catch (e) {
    Toast.error(e.message);
    host.innerHTML = `<div class="admin-card" style="color:var(--danger)">Error: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

export default {
  title: 'Recovery',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="margin-bottom:var(--spacing-4)">
          <h1 style="margin:0">Recovery &amp; Data Integrity</h1>
          <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">
            System health checks and deep data-integrity audit. Run these if you suspect
            orphaned records, inventory drift, or stuck orders.
          </p>
        </div>

        <div class="admin-detail-block__title" style="margin-top:var(--spacing-4)">Health Check</div>
        <div style="display:flex;align-items:center;gap:var(--spacing-2);margin-bottom:var(--spacing-3)">
          <button class="admin-btn admin-btn--primary" id="run-health-btn">${icon('refunds', 14, 14)} Run Health Check</button>
          <span style="color:var(--text-muted);font-size:12px">Fast (~seconds). Safe to run anytime.</span>
        </div>
        <div id="health-output"></div>

        <div class="admin-detail-block__title" style="margin-top:var(--spacing-6)">Data Integrity Audit</div>
        <div style="display:flex;align-items:center;gap:var(--spacing-2);margin-bottom:var(--spacing-3)">
          <button class="admin-btn admin-btn--danger" id="run-audit-btn">${icon('lab', 14, 14)} Run Full Audit</button>
          <span style="color:var(--text-muted);font-size:12px">Slow (minutes). Scans all tables for inconsistencies.</span>
        </div>
        <div id="audit-output"></div>
      </div>
    `;

    container.querySelector('#run-health-btn').addEventListener('click', runHealth);
    container.querySelector('#run-audit-btn').addEventListener('click', runAudit);

    // Auto-run health on open
    runHealth();
  },

  destroy() {
    _container = null;
  },
};
