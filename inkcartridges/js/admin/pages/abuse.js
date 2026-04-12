/**
 * Abuse Management Page — flags, coupon signals, blocked domains.
 * Backend: /api/admin/abuse/*
 * Three tabs: Flags | Coupon Signals | Blocked Domains
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _tab = 'flags';
let _table = null;

const FLAG_COLUMNS = [
  { key: 'flag_type', label: 'Type', render: (r) => esc(r.flag_type || r.type || '') },
  { key: 'email', label: 'Email / Account', render: (r) => esc(r.email || r.user_email || r.user_id || '—') },
  { key: 'ip_address', label: 'IP', render: (r) => `<span class="cell-mono">${esc(r.ip_address || '—')}</span>` },
  { key: 'reason', label: 'Reason', render: (r) => esc(r.reason || r.description || '') },
  {
    key: 'severity', label: 'Severity', align: 'center', render: (r) => {
      const s = r.severity || 'low';
      const cls = s === 'high' ? 'admin-badge--refunded' : s === 'medium' ? 'admin-badge--pending' : 'admin-badge--processing';
      return `<span class="admin-badge ${cls}">${esc(s)}</span>`;
    }
  },
  { key: 'created_at', label: 'Detected', render: (r) => r.created_at ? new Date(r.created_at).toLocaleString('en-NZ') : '—' },
  {
    key: 'status', label: 'Status', align: 'center', render: (r) => {
      const resolved = !!r.resolved_at || r.status === 'resolved';
      return `<span class="admin-badge ${resolved ? 'admin-badge--delivered' : 'admin-badge--pending'}">${resolved ? 'Resolved' : 'Open'}</span>`;
    }
  },
];

const SIGNAL_COLUMNS = [
  { key: 'code', label: 'Code', render: (r) => `<span class="cell-mono">${esc(r.code || r.coupon_code || '')}</span>` },
  { key: 'attempts', label: 'Attempts', align: 'right', render: (r) => r.attempts ?? r.attempt_count ?? 0 },
  { key: 'distinct_ips', label: 'IPs', align: 'right', render: (r) => r.distinct_ips ?? r.ip_count ?? 0 },
  { key: 'distinct_accounts', label: 'Accounts', align: 'right', render: (r) => r.distinct_accounts ?? r.account_count ?? 0 },
  { key: 'last_attempt_at', label: 'Last Attempt', render: (r) => r.last_attempt_at ? new Date(r.last_attempt_at).toLocaleString('en-NZ') : '—' },
];

const DOMAIN_COLUMNS = [
  { key: 'domain', label: 'Domain', render: (r) => `<span class="cell-mono">${esc(r.domain || '')}</span>` },
  { key: 'reason', label: 'Reason', render: (r) => esc(r.reason || '') },
  { key: 'blocked_at', label: 'Blocked', render: (r) => (r.blocked_at || r.created_at) ? new Date(r.blocked_at || r.created_at).toLocaleString('en-NZ') : '—' },
  {
    key: 'actions', label: '', align: 'right', render: (r) =>
      `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-unblock="${esc(r.id)}">Unblock</button>`
  },
];

async function loadFlags() {
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getAbuseFlags();
    const rows = Array.isArray(data) ? data : (data?.flags || data?.rows || []);
    _table.setData(rows);
  } catch (e) { Toast.error(e.message); _table.setData([]); }
}
async function loadSignals() {
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getCouponSignals();
    const rows = Array.isArray(data) ? data : (data?.signals || data?.rows || []);
    _table.setData(rows);
  } catch (e) { Toast.error(e.message); _table.setData([]); }
}
async function loadDomains() {
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getBlockedDomains();
    const rows = Array.isArray(data) ? data : (data?.domains || data?.rows || []);
    _table.setData(rows);
    // Wire unblock buttons (delegated via click)
    _table.container.querySelectorAll('[data-unblock]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-unblock');
        if (!confirm('Unblock this domain?')) return;
        try {
          await AdminAPI.removeBlockedDomain(id);
          Toast.success('Domain unblocked');
          await loadDomains();
        } catch (err) { Toast.error(err.message); }
      });
    });
  } catch (e) { Toast.error(e.message); _table.setData([]); }
}

function openFlagResolve(row) {
  if (row.resolved_at) { Toast.info('Already resolved'); return; }
  const modal = Modal.open({
    title: 'Resolve Flag',
    body: `
      <div class="admin-detail-block">
        <div class="admin-detail-row"><span>Type</span><span>${esc(row.flag_type || row.type)}</span></div>
        <div class="admin-detail-row"><span>Reason</span><span>${esc(row.reason || '')}</span></div>
      </div>
      <div class="admin-form-group">
        <label>Resolution notes</label>
        <textarea class="admin-textarea" id="resolve-notes" rows="3" placeholder="Investigated; false positive / account suspended / ..."></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Mark resolved</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const notes = modal.body.querySelector('#resolve-notes').value.trim();
    try {
      await AdminAPI.resolveAbuseFlag(row.id, notes);
      Toast.success('Flag resolved');
      Modal.close();
      await loadFlags();
    } catch (e) { Toast.error(e.message); }
  });
}

function openAddDomain() {
  const modal = Modal.open({
    title: 'Block Domain',
    body: `
      <div class="admin-form-group">
        <label>Domain *</label>
        <input class="admin-input" id="bd-domain" placeholder="tempmail.com">
      </div>
      <div class="admin-form-group">
        <label>Reason</label>
        <input class="admin-input" id="bd-reason" placeholder="Disposable email service">
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Block</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const domain = modal.body.querySelector('#bd-domain').value.trim().toLowerCase();
    const reason = modal.body.querySelector('#bd-reason').value.trim();
    if (!domain) { Toast.warning('Domain required'); return; }
    try {
      await AdminAPI.addBlockedDomain(domain, reason);
      Toast.success('Domain blocked');
      Modal.close();
      await loadDomains();
    } catch (e) { Toast.error(e.message); }
  });
}

function rebuildTable() {
  const host = _container.querySelector('#abuse-table');
  host.innerHTML = '';
  if (_tab === 'flags') {
    _table = new DataTable(host, { columns: FLAG_COLUMNS, rowKey: 'id', onRowClick: openFlagResolve });
    loadFlags();
  } else if (_tab === 'signals') {
    _table = new DataTable(host, { columns: SIGNAL_COLUMNS, rowKey: 'code', emptyMessage: 'No coupon abuse signals detected.' });
    loadSignals();
  } else {
    _table = new DataTable(host, { columns: DOMAIN_COLUMNS, rowKey: 'id', emptyMessage: 'No blocked domains.' });
    loadDomains();
  }
  _container.querySelectorAll('[data-tab]').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-tab') === _tab);
  });
  const addBtn = _container.querySelector('#add-domain-btn');
  if (addBtn) addBtn.style.display = _tab === 'domains' ? '' : 'none';
}

export default {
  title: 'Abuse',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--spacing-4)">
          <div>
            <h1 style="margin:0">Abuse Detection</h1>
            <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">Flagged accounts, coupon abuse signals, blocked email domains</p>
          </div>
          <button class="admin-btn admin-btn--primary" id="add-domain-btn" style="display:none">${icon('plus', 14, 14)} Block Domain</button>
        </div>
        <div class="admin-tabs" style="display:flex;gap:var(--spacing-2);margin-bottom:var(--spacing-4);border-bottom:1px solid var(--surface-border)">
          <button class="admin-tab active" data-tab="flags">Flags</button>
          <button class="admin-tab" data-tab="signals">Coupon Signals</button>
          <button class="admin-tab" data-tab="domains">Blocked Domains</button>
        </div>
        <div id="abuse-table"></div>
      </div>
    `;
    container.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', () => {
        _tab = el.getAttribute('data-tab');
        rebuildTable();
      });
    });
    container.querySelector('#add-domain-btn').addEventListener('click', openAddDomain);
    rebuildTable();
  },

  destroy() {
    if (_table) _table.destroy?.();
    _table = null;
    _container = null;
  },
};
