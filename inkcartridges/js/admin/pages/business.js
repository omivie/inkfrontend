/**
 * Business — B2B accounts and the applications queue.
 *
 * Owner-only (super_admin server-side). Three sections:
 *
 *   1. Upgrade a customer — the in-person flow, from a customer picker. Same
 *      modal the Customers drawer uses (../components/business-upgrade.js), so
 *      the two doors cannot drift.
 *   2. Applications — the queue, READ-ONLY. It is the first surface in this repo
 *      to show it.
 *   3. Accounts recorded on this device — the local id registry.
 *
 * ── Why the queue is read-only ─────────────────────────────────────────────
 *
 * There is no documented approve/decline endpoint. A queue with buttons that
 * 404 is worse than a queue without them, and inventing an endpoint name to
 * "light it up later" is exactly the mistake ERR-152 records. Applications are
 * shown because they are the only readable evidence of who is a business
 * account; acting on them stays with the backend until a contract exists.
 *
 * ── Why section 3 is not "business accounts" ───────────────────────────────
 *
 * `GET /api/admin/business/accounts` is a 404, so this frontend cannot list
 * business accounts and does not claim to. Section 3 is what THIS BROWSER wrote
 * down at creation time, is labelled as such in the heading, the caption and
 * every row, and states plainly what is missing. Calling it "Business accounts"
 * would be a fabricated collection — the ERR-063/068/073 shape.
 */

import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import {
  loadApplications, resetApplicationsCache, openUpgradeModal, openManageModal,
  prefillFor, customerLabel,
} from '../components/business-upgrade.js';
import {
  BusinessAccountRegistry, matchApplications, APPLICATION_STATUSES,
} from '../utils/business-accounts.js';

const MISSING = '—';
const formatPrice = (v) => (window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`);
const escA = (s) => Security.escapeAttr(String(s ?? ''));

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

let _container = null;
let _table = null;
let _statusFilter = '';
let _picker = null;
// Bumped on every navigation; every async paint checks it before touching the
// DOM, so a slow response cannot repaint a page the operator has left.
let _token = 0;

const APP_COLUMNS = [
  {
    key: 'company_name', label: 'Company',
    render: (r) => `<span class="cell-truncate">${esc(r.company_name || MISSING)}</span>`,
  },
  {
    key: 'contact_name', label: 'Contact',
    render: (r) => `<span class="cell-truncate">${esc(r.contact_name || MISSING)}</span>`
      + `<br><span class="cell-truncate cell-muted">${esc(r.contact_email || '')}</span>`,
  },
  {
    key: 'status', label: 'Status',
    render: (r) => {
      const s = String(r.status || '').toLowerCase();
      return `<span class="admin-badge admin-badge--${esc(s || 'pending')}">${esc(r.status || 'Unknown')}</span>`;
    },
  },
  {
    key: 'credit_limit', label: 'Credit limit', align: 'right',
    render: (r) => `<span class="cell-mono cell-right">${r.credit_limit != null ? formatPrice(r.credit_limit) : MISSING}</span>`,
  },
  {
    key: 'apply_net30', label: 'Net 30', align: 'center',
    render: (r) => `<span class="cell-center">${r.apply_net30 || r.net30_approved ? 'Requested' : MISSING}</span>`,
  },
  {
    key: 'submitted_at', label: 'Submitted',
    render: (r) => `<span class="cell-nowrap">${formatDate(r.submitted_at || r.created_at)}</span>`,
  },
  {
    key: 'reviewed_at', label: 'Reviewed',
    render: (r) => `<span class="cell-nowrap">${formatDate(r.reviewed_at)}</span>`,
  },
];

// ── Applications ────────────────────────────────────────────────────────────

async function loadApplicationsTable() {
  if (!_table) return;
  const mine = _token;
  _table.setLoading(true);
  // The cache holds the UNFILTERED table, which is also what the local-account
  // matching needs. A status filter is applied here rather than re-fetching,
  // because `status` is the only parameter the endpoint honours and one full
  // read answers every question this page asks.
  const res = await loadApplications();
  if (mine !== _token || !_table) return;
  if (!res) {
    _table.setData([], null);
    setQueueNote('The applications queue could not be read. This is a connection problem, not an empty queue.', true);
    return;
  }
  const all = res.applications;
  const rows = _statusFilter
    ? all.filter((r) => String(r.status || '').toLowerCase() === _statusFilter)
    : all;
  const total = res.pagination && Number.isFinite(Number(res.pagination.total)) ? Number(res.pagination.total) : null;
  _table.setData(rows, { total: rows.length, page: 1, limit: rows.length || 1 });

  // A page of rows is not necessarily the table. Saying so is the difference
  // between "there are 3 applications" and "we read 3 of 47".
  if (total != null && all.length < total) {
    setQueueNote(`Showing the first ${all.length} of ${total} applications. The rest are not loaded, so counts on this page are a lower bound.`, true);
  } else {
    setQueueNote(`${all.length} application${all.length === 1 ? '' : 's'} on file.`, false);
  }
}

function setQueueNote(text, warn) {
  const el = _container && _container.querySelector('#biz-queue-note');
  if (!el) return;
  el.textContent = text;
  el.className = warn ? 'biz-note biz-note--warn' : 'admin-text-muted';
}

// ── Locally-recorded accounts ───────────────────────────────────────────────

function localAccountsHtml() {
  const { accounts, readable } = BusinessAccountRegistry.all();

  if (!readable) {
    return `<p class="biz-note biz-note--warn">This browser's record of business-account ids can't be read (storage blocked, or the saved record is corrupt). That is not the same as there being none — nothing has been lost on the backend.</p>`;
  }
  if (!accounts.length) {
    return `<p class="admin-text-muted">No business accounts have been created from this browser yet.</p>`;
  }

  let h = `<table class="admin-table"><thead><tr>
    <th>Company</th><th>Status</th><th class="cell-right">Credit limit</th><th>Net 30</th><th>Recorded</th><th>Account id</th><th></th>
  </tr></thead><tbody>`;
  for (const a of accounts.slice().sort((x, y) => Date.parse(y.recorded_at || 0) - Date.parse(x.recorded_at || 0))) {
    h += `<tr>`;
    h += `<td><span class="cell-truncate">${esc(a.company_name || MISSING)}</span></td>`;
    h += `<td><span class="admin-badge admin-badge--${esc(a.status || 'active')}">${esc(a.status || 'active')}</span></td>`;
    h += `<td class="cell-right cell-mono">${a.credit_limit != null ? formatPrice(a.credit_limit) : MISSING}</td>`;
    h += `<td>${a.net30_approved ? 'Approved' : MISSING}</td>`;
    h += `<td class="cell-nowrap">${formatDate(a.recorded_at)}</td>`;
    h += `<td><code class="biz-id">${esc(a.business_account_id)}</code></td>`;
    h += `<td class="cell-right"><button class="admin-btn admin-btn--ghost admin-btn--xs" data-manage="${escA(a.business_account_id)}" type="button">Edit</button></td>`;
    h += `</tr>`;
  }
  h += `</tbody></table>`;
  return h;
}

function paintLocalAccounts() {
  const host = _container && _container.querySelector('#biz-local-accounts');
  if (!host) return;
  host.innerHTML = localAccountsHtml();
  host.querySelectorAll('[data-manage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { account } = BusinessAccountRegistry.get(btn.dataset.manage);
      if (!account) { Toast.error('That account is no longer recorded on this device.'); return; }
      openManageModal({ account, onUpdated: () => paintLocalAccounts() });
    });
  });
}

// ── Upgrade a customer ──────────────────────────────────────────────────────

/**
 * Pick a customer, then upgrade them.
 *
 * The picker searches `/api/admin/customers?search=`, which DOES filter (unlike
 * the applications endpoint). Standing is resolved from the cached applications
 * table after the pick, so an already-upgraded customer is caught before the
 * form is filled in rather than by a 409 after it.
 */
function openPickerModal() {
  const modal = Modal.open({
    title: 'Upgrade a customer to Business',
    body: `
      <div class="admin-form-group">
        <label for="biz-pick">Customer</label>
        <input class="admin-input" id="biz-pick" type="search" placeholder="Search by name or email…" autocomplete="off">
        <div class="admin-form-help">Searches existing customer accounts. The customer must already have an account — this upgrades one, it does not create one.</div>
      </div>
      <div id="biz-pick-result"></div>
    `,
    footer: `<button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>`,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  const input = modal.body.querySelector('#biz-pick');
  const result = modal.body.querySelector('#biz-pick-result');

  _picker = attachAutocomplete(input, {
    minChars: 2,
    emptyText: 'No customers match that',
    fetch: async (q) => {
      const data = await AdminAPI.getCustomers({ search: q }, 1, 10);
      if (!data) return [];
      return Array.isArray(data) ? data : (data.customers || data.data || []);
    },
    render: (c) => `${esc(customerLabel(c))} <span class="admin-ac__meta">· ${esc(c.email || '')}</span>`,
    onPick: async (customer) => {
      input.value = customerLabel(customer);
      result.innerHTML = `<p class="admin-text-muted">Checking that customer’s business standing…</p>`;
      const res = await loadApplications();
      const state = matchApplications(res && res.applications, customer.id, res && res.pagination);

      if (state.verdict === 'business_account') {
        result.innerHTML = `<p class="biz-note biz-note--warn">${esc(customerLabel(customer))} is already a business account (${esc((state.approved && state.approved.company_name) || 'company unknown')}, approved ${esc(formatDate(state.approved && (state.approved.reviewed_at || state.approved.submitted_at)))}). Upgrading again would be refused with a 409.</p>`;
        return;
      }
      let warn = '';
      if (state.verdict === 'pending_application') {
        warn = `<p class="biz-note biz-note--warn">This customer has a pending application. Upgrading closes it as superseded — no decline email is sent.</p>`;
      } else if (state.verdict === 'unknown') {
        warn = `<p class="biz-note biz-note--warn">Couldn’t confirm this customer’s business standing from the applications queue. The backend still decides — an existing account is refused with a 409 and nothing is changed.</p>`;
      }
      result.innerHTML = `${warn}<button class="admin-btn admin-btn--primary" data-action="go" type="button">Upgrade ${esc(customerLabel(customer))}…</button>`;
      result.querySelector('[data-action="go"]').addEventListener('click', () => {
        Modal.close();
        openUpgradeModal({
          customer,
          prefill: prefillFor(customer, state),
          onUpgraded: async () => {
            resetApplicationsCache();
            await loadApplicationsTable();
            paintLocalAccounts();
          },
        });
      });
    },
  });
}

// ── Page module ─────────────────────────────────────────────────────────────

export default {
  title: 'Business',

  async init(container) {
    // Belt-and-braces beside the router's NAV_ITEMS-derived gate: every write on
    // this page is super_admin server-side.
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">Business accounts are managed by super-admins only.</div>
      </div>`;
      return;
    }

    _container = container;
    _token++;
    _statusFilter = '';

    const header = document.createElement('div');
    header.className = 'admin-page-header';
    header.innerHTML = `
      <h1>Business</h1>
      <div class="admin-page-header__actions">
        <button class="admin-btn admin-btn--primary" id="biz-upgrade-cta" type="button">${icon('customers', 14, 14)} Upgrade a customer</button>
      </div>
    `;
    container.appendChild(header);
    header.querySelector('#biz-upgrade-cta').addEventListener('click', openPickerModal);

    const intro = document.createElement('div');
    intro.className = 'admin-section admin-mb-lg';
    intro.innerHTML = `
      <div class="admin-section__header"><h2 class="admin-section__title">Applications</h2></div>
      <p class="admin-text-muted" style="margin-top:0">
        The self-service queue, read-only. Approving and declining stay on the backend — no endpoint for either is published, so nothing here pretends to act.
        In-person upgrades bypass this queue by design and leave an approved application behind as the audit record.
      </p>
      <div class="admin-tabs" id="biz-status-tabs">
        <button class="admin-tab active" data-status="">All</button>
        ${APPLICATION_STATUSES.map((s) => `<button class="admin-tab" data-status="${escA(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</button>`).join('')}
      </div>
      <p id="biz-queue-note" class="admin-text-muted"></p>
      <div id="biz-apps-table"></div>
    `;
    container.appendChild(intro);

    intro.querySelector('#biz-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      intro.querySelectorAll('#biz-status-tabs .admin-tab').forEach((b) => b.classList.toggle('active', b === btn));
      _statusFilter = btn.dataset.status;
      loadApplicationsTable();
    });

    _table = new DataTable(intro.querySelector('#biz-apps-table'), {
      columns: APP_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No applications',
      emptyIcon: icon('customers', 40, 40),
    });

    const local = document.createElement('div');
    local.className = 'admin-section admin-mb-lg';
    local.innerHTML = `
      <div class="admin-section__header"><h2 class="admin-section__title">Accounts created on this device</h2></div>
      <p class="admin-text-muted" style="margin-top:0">
        <strong>This is not the list of business accounts.</strong> The backend publishes no way to read them
        (<code>GET /api/admin/business/accounts</code> → 404) and the 409 on a duplicate carries no id, so the
        id needed to change a credit limit or suspend an account appears exactly once — in the response that
        creates it. These are the ones this browser wrote down. Accounts created elsewhere, or before this page
        existed, can only be managed once that endpoint ships.
      </p>
      <div id="biz-local-accounts"></div>
    `;
    container.appendChild(local);

    paintLocalAccounts();
    await loadApplicationsTable();
  },

  destroy() {
    _token++;
    if (_picker && _picker.destroy) _picker.destroy();
    _picker = null;
    _table = null;
    _container = null;
    _statusFilter = '';
    resetApplicationsCache();
  },

  async onFilterChange() {
    await loadApplicationsTable();
  },
};
