/**
 * Customer Segments + Campaign Email Page
 * Backend: /api/admin/segments (GET/POST), /api/admin/segments/:id/users (POST),
 *          /api/admin/email/send-announcement (POST)
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

let _container = null;
let _table = null;

const COLUMNS = [
  { key: 'name', label: 'Segment', render: (r) => esc(r.name || '') },
  { key: 'description', label: 'Description', render: (r) => esc(r.description || '') },
  { key: 'member_count', label: 'Members', align: 'right', render: (r) => r.member_count ?? r.user_count ?? '—' },
  { key: 'pricing_tier', label: 'Pricing Tier', render: (r) => esc(r.pricing_tier || '—') },
  { key: 'created_at', label: 'Created', render: (r) => r.created_at ? new Date(r.created_at).toLocaleDateString('en-NZ') : '—' },
];

async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  try {
    const data = await AdminAPI.getSegments();
    const rows = Array.isArray(data) ? data : (data?.segments || data?.rows || []);
    _table.setData(rows);
  } catch (e) {
    Toast.error(`Failed to load segments: ${e.message}`);
    _table.setData([]);
  }
}

function openCreateSegment() {
  const modal = Modal.open({
    title: 'New Segment',
    body: `
      <div class="admin-form-group">
        <label>Name *</label>
        <input class="admin-input" id="sg-name" placeholder="VIP customers">
      </div>
      <div class="admin-form-group">
        <label>Description</label>
        <input class="admin-input" id="sg-description" placeholder="Top 10% by lifetime spend">
      </div>
      <div class="admin-form-group">
        <label>Pricing Tier</label>
        <select class="admin-select" id="sg-tier">
          <option value="">None</option>
          <option value="bronze">Bronze</option>
          <option value="silver">Silver</option>
          <option value="gold">Gold</option>
        </select>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Create</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const name = modal.body.querySelector('#sg-name').value.trim();
    const description = modal.body.querySelector('#sg-description').value.trim();
    const pricing_tier = modal.body.querySelector('#sg-tier').value || null;
    if (!name) { Toast.warning('Name required'); return; }
    try {
      await AdminAPI.createSegment({ name, description: description || null, pricing_tier });
      Toast.success('Segment created');
      Modal.close();
      await loadData();
    } catch (e) { Toast.error(e.message); }
  });
}

function openAssignUsers(segment) {
  const modal = Modal.open({
    title: `Assign users to ${segment.name}`,
    body: `
      <p style="color:var(--text-muted);font-size:13px;margin:0 0 var(--spacing-3) 0">
        Paste user IDs (one per line or comma-separated).
      </p>
      <div class="admin-form-group">
        <textarea class="admin-textarea" id="au-ids" rows="6" placeholder="uuid-1\nuuid-2"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Assign</button>
    `,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const raw = modal.body.querySelector('#au-ids').value;
    const ids = raw.split(/[,\n\s]+/).map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) { Toast.warning('Enter at least one user ID'); return; }
    try {
      await AdminAPI.assignSegmentUsers(segment.id, ids);
      Toast.success(`Assigned ${ids.length} user(s)`);
      Modal.close();
      await loadData();
    } catch (e) { Toast.error(e.message); }
  });
}

function openCampaign() {
  const modal = Modal.open({
    title: 'Send Email Campaign',
    className: 'admin-modal--wide',
    body: `
      <div class="admin-form-group">
        <label>Segment</label>
        <select class="admin-select" id="em-segment">
          <option value="">All subscribers</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Subject *</label>
        <input class="admin-input" id="em-subject" placeholder="Spring sale — 20% off">
      </div>
      <div class="admin-form-group">
        <label>Preheader</label>
        <input class="admin-input" id="em-preheader" placeholder="Short preview text">
      </div>
      <div class="admin-form-group">
        <label>Body (HTML or plain text) *</label>
        <textarea class="admin-textarea" id="em-body" rows="10" placeholder="Hi {first_name}, ..."></textarea>
      </div>
      <p style="color:var(--text-muted);font-size:12px;margin:0">
        Unsubscribed users are automatically excluded. Send is rate-limited by the backend.
      </p>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="send">Send</button>
    `,
  });
  if (!modal) return;

  // Populate segment dropdown
  (async () => {
    try {
      const data = await AdminAPI.getSegments();
      const rows = Array.isArray(data) ? data : (data?.segments || []);
      const sel = modal.body.querySelector('#em-segment');
      for (const r of rows) {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name;
        sel.appendChild(opt);
      }
    } catch { /* non-fatal */ }
  })();

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="send"]').addEventListener('click', async () => {
    const segment_id = modal.body.querySelector('#em-segment').value || null;
    const subject = modal.body.querySelector('#em-subject').value.trim();
    const preheader = modal.body.querySelector('#em-preheader').value.trim();
    const body = modal.body.querySelector('#em-body').value.trim();
    if (!subject || !body) { Toast.warning('Subject and body required'); return; }
    if (!confirm(`Send "${subject}" to ${segment_id ? 'this segment' : 'ALL subscribers'}?`)) return;
    try {
      await AdminAPI.sendAnnouncement({ segment_id, subject, preheader: preheader || null, body });
      Toast.success('Campaign queued');
      Modal.close();
    } catch (e) { Toast.error(`Send failed: ${e.message}`); }
  });
}

export default {
  title: 'Segments',

  async init(container) {
    _container = container;
    container.innerHTML = `
      <div class="admin-page-content">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--spacing-4)">
          <div>
            <h1 style="margin:0">Segments &amp; Campaigns</h1>
            <p style="margin:4px 0 0 0;color:var(--text-muted);font-size:13px">Customer segments for pricing tiers and email campaigns</p>
          </div>
          <div style="display:flex;gap:var(--spacing-2)">
            <button class="admin-btn admin-btn--ghost" id="send-campaign-btn">${icon('mail', 14, 14)} Send Campaign</button>
            <button class="admin-btn admin-btn--primary" id="new-segment-btn">${icon('plus', 14, 14)} New Segment</button>
          </div>
        </div>
        <div id="seg-table"></div>
      </div>
    `;
    _table = new DataTable(container.querySelector('#seg-table'), {
      columns: COLUMNS, rowKey: 'id',
      onRowClick: (row) => openAssignUsers(row),
      emptyMessage: 'No segments defined.',
    });
    container.querySelector('#new-segment-btn').addEventListener('click', openCreateSegment);
    container.querySelector('#send-campaign-btn').addEventListener('click', openCampaign);
    await loadData();
  },

  destroy() {
    if (_table) _table.destroy?.();
    _table = null;
    _container = null;
  },
};
