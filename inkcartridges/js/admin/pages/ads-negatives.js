/**
 * Negative Keywords — review the Google Ads negative-keyword suggestions that
 * automated jobs FILE (FE master checklist item 18, owner 7 Oct 2026, ERR-313).
 *
 * Owner's rule: nothing adds a negative keyword to Google Ads without the
 * owner approving it first. Approve is the ONE action that writes to Ads;
 * Reject writes nothing. One row at a time — no bulk approve (owner).
 *
 * Backend (super_admin only):
 *   GET  /api/admin/ads/negative-suggestions?status=pending|approved|rejected|applied|failed|all
 *        → { suggestions:[…], count, status }
 *   POST /api/admin/ads/negative-suggestions/:id/approve → { status:'applied' }
 *        409 NOT_PENDING (already decided) · 502 ADS_WRITE_FAILED (Ads refused; row now 'failed')
 *   POST /api/admin/ads/negative-suggestions/:id/reject  → { status:'rejected' }
 *
 * A failed read renders a loud error card, never "No suggestions" — an empty
 * queue and an unreachable one must not look the same.
 */
import { AdminAPI, FilterState, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const MISSING = '—';

export const STATUS_TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'applied', label: 'Applied' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'failed', label: 'Failed' },
  { key: 'approved', label: 'Approved' },
  { key: 'all', label: 'History (all)' },
];

// Badge colours reuse the existing admin palette.
const STATUS_BADGE = { pending: 'pending', approved: 'processing', applied: 'completed', rejected: 'dismissed', failed: 'failed' };

const SCOPE_LABEL = { ad_group: 'Ad group', campaign: 'Campaign', shared_set: 'Shared list' };

let _container = null;
let _table = null;
let _status = 'pending';
let _loadSeq = 0;
const _busy = new Set();

function formatDate(d) {
  if (!d) return MISSING;
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return esc(String(d));
  return esc(t.toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
}

function humanKey(k) {
  return String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The evidence object, printed AS THE SERVER SENT IT: key and value, no unit
 * guessed (a spend field may be dollars or micros — ERR-310 is what guessing
 * units costs). Absent ⇒ an em dash, never "0".
 */
export function evidenceHtml(evidence) {
  if (evidence == null || typeof evidence !== 'object' || !Object.keys(evidence).length) return MISSING;
  const fmt = (v) => {
    if (v == null) return MISSING;
    if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : 'none';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return '<dl class="adn-evidence" style="margin:0;font-size:12px">' + Object.entries(evidence)
    .map(([k, v]) => `<div style="display:flex;gap:6px"><dt class="admin-text-muted" style="margin:0;white-space:nowrap">${esc(humanKey(k))}:</dt><dd style="margin:0">${esc(fmt(v))}</dd></div>`).join('') + '</dl>';
}

export const COLUMNS = [
  { key: 'created_at', label: 'Filed', render: (r) => `<span style="font-size:12px;white-space:nowrap">${formatDate(r.created_at)}</span>` },
  { key: 'keyword_text', label: 'Keyword', render: (r) => `<strong>${esc(r.keyword_text || MISSING)}</strong>` },
  { key: 'match_type', label: 'Match', render: (r) => esc(r.match_type || MISSING) },
  { key: 'target_label', label: 'Where it applies', render: (r) => {
    const scope = SCOPE_LABEL[r.scope] || r.scope || '';
    return `${esc(r.target_label || MISSING)}${scope ? `<div class="admin-text-muted" style="font-size:12px">${esc(scope)}</div>` : ''}`;
  }},
  { key: 'reason', label: 'Reason', render: (r) => `<span style="font-size:13px">${esc(r.reason || MISSING)}</span>${r.source ? `<div class="admin-text-muted" style="font-size:12px">Filed by ${esc(r.source)}</div>` : ''}` },
  { key: 'evidence', label: 'Evidence', render: (r) => evidenceHtml(r.evidence) },
  { key: 'status', label: 'Status', render: (r) => {
    const s = String(r.status || '').toLowerCase();
    const badge = `<span class="admin-badge admin-badge--${STATUS_BADGE[s] || 'pending'}">${esc(s || 'unknown')}</span>`;
    const when = r.applied_at ? `Applied ${formatDate(r.applied_at)}` : r.decided_at ? `Decided ${formatDate(r.decided_at)}` : '';
    const err = r.error ? `<div style="color:var(--danger);font-size:12px">${esc(r.error)}</div>` : '';
    return `${badge}${when ? `<div class="admin-text-muted" style="font-size:12px;white-space:nowrap">${when}</div>` : ''}${err}`;
  }},
  { key: '_actions', label: '', align: 'right', render: (r) => {
    // Only a PENDING row can be decided; anything else is history.
    if (String(r.status || '').toLowerCase() !== 'pending') return '';
    const id = Security.escapeAttr(r.id);
    return `<span style="display:inline-flex;gap:6px">`
      + `<button type="button" class="admin-btn admin-btn--xs admin-btn--primary adn-action" data-id="${id}" data-action="approve">Approve</button>`
      + `<button type="button" class="admin-btn admin-btn--xs admin-btn--ghost adn-action" data-id="${id}" data-action="reject" style="color:var(--danger);border-color:var(--danger)">Reject</button>`
      + `</span>`;
  }},
];

/** The message for a refused decision. 409/502 carry the backend's own words. */
export function decisionErrorMessage(e, action) {
  if (e && e.code === 'NOT_PENDING') return 'Already decided — this suggestion is no longer pending. The list has been refreshed.';
  if (e && e.code === 'ADS_WRITE_FAILED') return `Google Ads refused the negative keyword: ${e.message || 'no reason given'}. The suggestion is now marked failed.`;
  return `Could not ${action} the suggestion: ${(e && e.message) || 'unknown error'}`;
}

function render() {
  _container.innerHTML = `
    <div class="admin-page-header">
      <h1>Negative Keyword Suggestions</h1>
      <p class="admin-page-header__sub">Automated jobs suggest negative keywords for Google Ads. Nothing is added to Google Ads until you approve it here. Approve writes the negative keyword to Google Ads; Reject writes nothing.</p>
    </div>
    <div class="admin-tabs" id="adn-status-tabs" style="margin-bottom:16px">
      ${STATUS_TABS.map((t) => `<button type="button" class="admin-tab${t.key === _status ? ' active' : ''}" data-status="${t.key}">${esc(t.label)}</button>`).join('')}
    </div>
    <div id="adn-error" hidden></div>
    <div id="adn-table"></div>
  `;
}

async function load() {
  const seq = ++_loadSeq;
  const errEl = _container.querySelector('#adn-error');
  const tableEl = _container.querySelector('#adn-table');
  errEl.hidden = true;
  tableEl.hidden = false;
  _table.setLoading(true);
  let rows;
  try {
    rows = await AdminAPI.ads.listNegativeSuggestions(_status);
  } catch (e) {
    if (seq !== _loadSeq || !_container) return;
    tableEl.hidden = true;
    errEl.hidden = false;
    errEl.innerHTML = `<div class="admin-card" style="padding:16px;border-left:3px solid var(--danger)">
        <p style="margin:0 0 8px"><strong>Couldn't load the suggestions.</strong> This is not an empty list — the server did not answer with one.</p>
        <p class="admin-text-muted" style="margin:0 0 12px">${esc(e.message || 'Unknown error')}</p>
        <button type="button" class="admin-btn admin-btn--sm" id="adn-retry">Retry</button>
      </div>`;
    errEl.querySelector('#adn-retry').addEventListener('click', load);
    return;
  }
  if (seq !== _loadSeq || !_container) return;
  _table.setData(rows, null);
}

async function decide(id, action) {
  if (_busy.has(id)) return;
  _busy.add(id);
  try {
    if (action === 'approve') {
      const res = await AdminAPI.ads.approveNegativeSuggestion(id);
      Toast.success(`Added to Google Ads${res && res.status ? ` (${res.status})` : ''}`);
    } else {
      await AdminAPI.ads.rejectNegativeSuggestion(id);
      Toast.success('Rejected — nothing was written to Google Ads');
    }
  } catch (e) {
    Toast.error(decisionErrorMessage(e, action), 10000);
  } finally {
    _busy.delete(id);
  }
  // Every outcome changes the row (applied / rejected / failed / already
  // decided elsewhere), so the list is always re-read from the server.
  if (_container) await load();
}

export default {
  title: 'Negative Keywords',

  async init(container) {
    _container = container;
    _status = 'pending';
    FilterState.showBar(false);
    render();

    _container.querySelector('#adn-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      _status = btn.dataset.status;
      _container.querySelectorAll('#adn-status-tabs .admin-tab').forEach((b) =>
        b.classList.toggle('active', b.dataset.status === _status));
      load();
    });

    _table = new DataTable(_container.querySelector('#adn-table'), {
      columns: COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No suggestions with this status',
    });

    _container.querySelector('#adn-table').addEventListener('click', (e) => {
      const btn = e.target.closest('.adn-action');
      if (!btn) return;
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.action === 'approve') {
        const row = (_table.data || []).find((r) => String(r.id) === id) || {};
        Modal.confirm({
          title: 'Add this negative keyword to Google Ads?',
          message: `"${row.keyword_text || id}" (${row.match_type || 'match type unknown'}) will be written to Google Ads on ${row.target_label || 'its target'}. Ads stop showing for searches that match it.`,
          confirmLabel: 'Approve and add to Google Ads',
          confirmClass: 'admin-btn--primary',
          onConfirm: () => decide(id, 'approve'),
        });
      } else {
        decide(id, 'reject');
      }
    });

    await load();
  },

  destroy() {
    _loadSeq++;
    if (_table) { _table.destroy(); _table = null; }
    _container = null;
    _busy.clear();
  },
};
