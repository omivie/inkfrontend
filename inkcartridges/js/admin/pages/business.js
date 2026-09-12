/**
 * Business — B2B accounts, contract pricing, and the applications queue.
 *
 * Owner-only (super_admin server-side). Two tabs, and a per-account drawer:
 *
 *   1. Accounts — the real list, from GET /api/admin/business/accounts.
 *      Clicking one opens its drawer: Details / Contract pricing / History.
 *   2. Applications — the self-service queue, READ-ONLY.
 *
 * ── WHAT CHANGED, AND WHY THIS FILE LOOKED LIKE IT DID ─────────────────────
 *
 * Until the backend shipped migration 165 (2026-09-06) there was NO way to
 * list business accounts. `GET /api/admin/business/accounts` was a 404, the
 * 409 on a duplicate create carried no id, and `business_applications` exposes
 * the application's id rather than the account's. So the id needed to change a
 * credit limit, suspend an account or link an invoice to a customer's portal
 * appeared exactly once — in the response that created it.
 *
 * This page therefore used to render `BusinessAccountRegistry`: what THIS
 * BROWSER wrote down at creation time, labelled as such in the heading, the
 * caption and every row, because calling it "Business accounts" would have
 * been a fabricated collection.
 *
 * That is over. The list is real, and the device registry is no longer a
 * surface — see the reconciliation strip below for why it is not simply
 * deleted either.
 *
 * ── ADDRESSABILITY (ERR-208) ───────────────────────────────────────────────
 *
 * Everything on screen is described by the address:
 *
 *   #business                        → Accounts
 *   #business?tab=applications       → the queue
 *   #business?account=<uuid>         → that account's drawer, Contract pricing
 *   #business?account=<uuid>&tab=history
 *
 * Two rules make that true rather than aspirational:
 *
 *   - `onRouteChange()` RE-READS `window.location.hash`. It does not read its
 *     argument, because app.js passes `getRouteDetailFromHash()`, which
 *     extracts `?tab=` and nothing else — an `{ account }` parameter would be
 *     `undefined` forever and the symptom would look like a caching bug.
 *
 *   - A row click sets `location.hash` and RETURNS. It never calls the drawer
 *     opener directly. So there is no second path into the detail view that
 *     could work while the URL did not, which is exactly how "launchable but
 *     not addressable" happens.
 *
 * ── WHY THE APPLICATIONS QUEUE IS STILL READ-ONLY ──────────────────────────
 *
 * There is still no documented approve/decline endpoint. A queue with buttons
 * that 404 is worse than a queue without them, and inventing an endpoint name
 * to "light it up later" is the mistake ERR-152 records.
 */

import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Modal } from '../components/modal.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import {
  loadApplications, resetApplicationsCache, openUpgradeModal, openManageModal,
  prefillFor, customerLabel,
} from '../components/business-upgrade.js';
import {
  mountContractPanel, destroyContractPanel, openHistoryModal,
} from '../components/contract-pricing-panel.js';
import {
  BusinessAccountRegistry, matchApplications, APPLICATION_STATUSES,
} from '../utils/business-accounts.js';
import { ACCOUNT_STATUSES } from '../utils/contract-pricing.js';

const MISSING = '—';
const formatPrice = (v) => (window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`);
const escA = (s) => Security.escapeAttr(String(s ?? ''));

const TAB_ACCOUNTS = 'accounts';
const TAB_APPLICATIONS = 'applications';
const LIST_TABS = [TAB_ACCOUNTS, TAB_APPLICATIONS];

const PANEL_DETAILS = 'details';
const PANEL_PRICING = 'pricing';
const PANEL_HISTORY = 'history';
const DRAWER_PANELS = [PANEL_DETAILS, PANEL_PRICING, PANEL_HISTORY];

function formatDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

let _container = null;
let _appsTable = null;
let _picker = null;
// Bumped on every navigation; every async paint checks it before touching the
// DOM, so a slow response cannot repaint a page the operator has left.
let _token = 0;

let _listTab = TAB_ACCOUNTS;
let _statusFilter = '';
let _accountSearch = '';
let _accountStatus = '';
let _accountPage = 1;
let _accounts = null;      // null = could not read. [] = there are none. Different.
let _accountsPagination = null;
let _openAccountId = null;
let _drawer = null;

// ── The address ─────────────────────────────────────────────────────────────

/**
 * Read what should be on screen out of the hash.
 *
 * Always from `window.location.hash` — never from a caller's argument. See the
 * addressability note at the top of this file.
 */
function readRouteFromHash() {
  const hash = String(window.location.hash || '').replace('#', '');
  const q = hash.indexOf('?');
  const params = new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
  const account = params.get('account');
  const tab = params.get('tab');
  if (account) {
    return {
      accountId: account,
      // Contract pricing is why you opened an account. It is the default.
      panel: DRAWER_PANELS.includes(tab) ? tab : PANEL_PRICING,
      listTab: TAB_ACCOUNTS,
    };
  }
  return {
    accountId: null,
    panel: null,
    listTab: LIST_TABS.includes(tab) ? tab : TAB_ACCOUNTS,
  };
}

/** Navigate (Back returns to where you were) — used for entering/leaving an account. */
function goTo({ accountId, tab }) {
  const params = new URLSearchParams();
  if (accountId) params.set('account', accountId);
  if (tab) params.set('tab', tab);
  const qs = params.toString();
  window.location.hash = qs ? `#business?${qs}` : '#business';
}

/** Replace (no history entry) — used for switching a tab in place. */
function replaceTo({ accountId, tab }) {
  const params = new URLSearchParams();
  if (accountId) params.set('account', accountId);
  if (tab) params.set('tab', tab);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `#business?${qs}` : '#business');
  // app.js listens for this to keep the sidebar's sense of "you are here".
  window.dispatchEvent(new CustomEvent('admin:tab-change', { detail: { route: 'business', tab } }));
}

// ── Accounts ────────────────────────────────────────────────────────────────

async function loadAccounts() {
  const mine = _token;
  const host = _container && _container.querySelector('#biz-accounts');
  if (!host) return;
  host.innerHTML = `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`;

  const res = await AdminAPI.listBusinessAccountsPage({
    search: _accountSearch || undefined,
    status: _accountStatus || undefined,
    page: _accountPage,
    limit: 25,
  });
  if (mine !== _token || !_container) return;

  if (!res) {
    _accounts = null;
    _accountsPagination = null;
  } else {
    _accounts = res.accounts;
    _accountsPagination = res.pagination;
  }
  paintAccounts();
}

function paintAccounts() {
  const host = _container && _container.querySelector('#biz-accounts');
  if (!host) return;

  if (_accounts === null) {
    host.innerHTML = `<p class="biz-note biz-note--warn">The business accounts could not be read. That is a connection problem, not an empty list — no account has been closed or removed.</p>`;
    return;
  }

  if (!_accounts.length) {
    host.innerHTML = (_accountSearch || _accountStatus)
      ? `<p class="admin-text-muted">No business account matches that.</p>`
      : `<div class="admin-empty"><div class="admin-empty__title">No business accounts yet</div><div class="admin-empty__text">Upgrade a customer to give them Net 30, credit and their own contract pricing.</div></div>`;
    return;
  }

  let h = `<div class="admin-table-wrap"><table class="admin-table"><thead><tr>
    <th>Company</th><th>Contact</th><th>Status</th><th>Net 30</th>
    <th class="cell-right">Credit</th><th>Contract pricing</th><th></th>
  </tr></thead><tbody>`;

  for (const a of _accounts) {
    const id = escA(a.id);
    h += `<tr class="clickable" data-account="${id}">`;
    h += `<td><span class="cell-truncate"><strong>${esc(a.company_name || MISSING)}</strong></span></td>`;
    h += `<td><span class="cell-truncate">${esc(a.contact_name || MISSING)}</span>`
      + `<br><span class="cell-truncate cell-muted">${esc(a.contact_email || a.ap_email || '')}</span></td>`;
    h += `<td><span class="admin-badge admin-badge--${esc(a.status || 'active')}">${esc(a.status || 'unknown')}</span></td>`;
    h += `<td>${a.net30_approved ? 'Approved' : MISSING}</td>`;
    h += `<td class="cell-right cell-mono">${a.credit_limit != null ? formatPrice(a.credit_limit) : MISSING}</td>`;
    h += `<td data-count-for="${id}">${countCell(a)}</td>`;
    h += `<td class="cell-right"><button class="admin-btn admin-btn--ghost admin-btn--xs" data-open="${id}" type="button">Open</button></td>`;
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;

  const total = Number(_accountsPagination?.total);
  const totalPages = Number(_accountsPagination?.total_pages) || 1;
  if (totalPages > 1) {
    h += `<div class="cp-pager">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-acct-page="prev" ${_accountPage <= 1 ? 'disabled' : ''} type="button">Previous</button>
      <span class="admin-text-muted">Page ${_accountPage} of ${totalPages}${Number.isFinite(total) ? ` · ${total} accounts` : ''}</span>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-acct-page="next" ${_accountPage >= totalPages ? 'disabled' : ''} type="button">Next</button>
    </div>`;
  }
  host.innerHTML = h;

  // Entering an account is a NAVIGATION, not a render. See the top of the file.
  host.querySelectorAll('[data-account]').forEach((tr) => {
    tr.addEventListener('click', () => goTo({ accountId: tr.dataset.account, tab: PANEL_PRICING }));
  });
  host.querySelectorAll('[data-acct-page]').forEach((b) => b.addEventListener('click', () => {
    _accountPage += b.dataset.acctPage === 'next' ? 1 : -1;
    loadAccounts();
  }));

  paintReconciliation();
}

/**
 * The "3 custom prices" badge.
 *
 * An ABSENT `custom_price_count` renders as an em dash, never as "0 custom
 * prices". Zero is a measurement; absence is the server not telling us, and the
 * two look identical on screen unless you make them different.
 */
function countCell(a) {
  const n = a.custom_price_count;
  if (n == null || !Number.isFinite(Number(n))) {
    return `<span class="cell-muted">${MISSING}</span>`;
  }
  const count = Number(n);
  return count > 0
    ? `<span class="admin-chip admin-chip--info">${count} custom price${count === 1 ? '' : 's'}</span>`
    : `<span class="cell-muted">List price</span>`;
}

/**
 * Reconcile the device registry against the real list.
 *
 * The registry is no longer a surface — a second list that can disagree with
 * the real one is worse than no second list. But it is not deleted either, for
 * one specific reason: it may hold the id of an account the server list has not
 * returned (a partial read, a filter, a page we did not walk), and that id is
 * still the only copy anyone has.
 *
 * So: confirmed ids are reported as confirmed and can be forgotten ON A CLICK.
 * They are never auto-forgotten — deleting local data on the strength of a
 * paginated read is absence-proves-absence, the exact mistake
 * `matchApplications()` exists to prevent.
 */
function paintReconciliation() {
  const host = _container && _container.querySelector('#biz-reconcile');
  if (!host) return;
  const { accounts: local, readable } = BusinessAccountRegistry.all();

  if (!readable) {
    host.innerHTML = `<p class="biz-note biz-note--warn">This browser’s old record of business-account ids can’t be read. Nothing is lost — the list above comes from the server.</p>`;
    return;
  }
  if (!local.length) { host.innerHTML = ''; return; }

  // Only a COMPLETE, unfiltered read can say an id is missing from the server.
  const complete = !_accountSearch && !_accountStatus
    && Array.isArray(_accounts)
    && (Number(_accountsPagination?.total_pages) || 1) === 1;

  const serverIds = new Set((_accounts || []).map((a) => String(a.id)));
  const confirmed = local.filter((a) => serverIds.has(String(a.business_account_id)));
  const unconfirmed = local.filter((a) => !serverIds.has(String(a.business_account_id)));

  if (!complete) {
    host.innerHTML = `<p class="admin-text-muted">${local.length} account id${local.length === 1 ? '' : 's'} recorded on this browser from before the server could list accounts. They can’t be checked against a filtered or partial list — clear the search to reconcile them.</p>`;
    return;
  }

  let h = `<p class="admin-text-muted"><strong>${confirmed.length} of ${local.length}</strong> account id${local.length === 1 ? '' : 's'} recorded on this browser ${confirmed.length === 1 ? 'is' : 'are'} confirmed by the server and no longer needed here.`;
  if (unconfirmed.length) {
    h += ` ${unconfirmed.length} ${unconfirmed.length === 1 ? 'is' : 'are'} not in the server’s list — <strong>keep ${unconfirmed.length === 1 ? 'it' : 'them'}</strong>: ${unconfirmed.map((a) => `<code class="biz-id">${esc(a.business_account_id)}</code>`).join(' ')}`;
  }
  h += `</p>`;
  if (confirmed.length) {
    h += `<button class="admin-btn admin-btn--ghost admin-btn--sm" id="biz-forget" type="button">Forget the ${confirmed.length} confirmed record${confirmed.length === 1 ? '' : 's'}</button>`;
  }
  host.innerHTML = h;

  const forget = host.querySelector('#biz-forget');
  if (forget) forget.addEventListener('click', () => {
    for (const a of confirmed) BusinessAccountRegistry.forget(a.business_account_id);
    Toast.success(`Forgot ${confirmed.length} device record${confirmed.length === 1 ? '' : 's'} — the server has them.`);
    paintReconciliation();
  });
}

// ── The account drawer ──────────────────────────────────────────────────────

async function openAccountDrawer(accountId, panel) {
  // Already open on the same account: just move the panel.
  if (_openAccountId === accountId && Drawer.isOpen()) { showPanel(panel); return; }

  const mine = _token;
  _openAccountId = accountId;

  const drawer = Drawer.open({
    title: 'Business account',
    body: `<div class="admin-loader"><div class="admin-loading__spinner"></div></div>`,
    onClose: () => {
      // ── ONLY THE CURRENT DRAWER MAY NAVIGATE ──────────────────────────────
      //
      // Drawer.open() closes any existing drawer first, which fires THIS
      // handler for the outgoing account. Without the guard, opening account B
      // straight from account A would run A's onClose, push `#business` into
      // the address, and the resulting hashchange would immediately close the
      // drawer we just opened. `_openAccountId` is set to the incoming id
      // before Drawer.open(), so a superseded handler sees a different id and
      // stands down.
      if (_openAccountId !== accountId) return;
      destroyContractPanel();
      _openAccountId = null;
      _drawer = null;
      // Closing must change the address too, or Back would reopen a drawer the
      // operator just dismissed and the URL would describe a screen that is not
      // on screen.
      if (readRouteFromHash().accountId) goTo({ accountId: null, tab: TAB_ACCOUNTS });
    },
  });
  if (!drawer) return;
  _drawer = drawer;

  const account = await AdminAPI.getBusinessAccount(accountId);
  if (mine !== _token || !Drawer.isOpen()) return;

  if (!account) {
    drawer.setBody(`<div class="admin-stub">
      <div class="admin-stub__title">Account not available</div>
      <div class="admin-stub__text">This business account could not be read. It may have been removed, or the connection failed — those are different things and we can’t tell them apart from here.</div>
    </div>`);
    return;
  }

  drawer.el.querySelector('.admin-drawer__title').textContent =
    `${account.company_name || 'Business account'} · ${account.status || 'unknown'}`;

  drawer.setBody(`
    <div class="biz-drawer">
      ${accountHeaderHtml(account)}
      <div class="admin-tabs" id="biz-panel-tabs">
        <button class="admin-tab" data-panel="${PANEL_PRICING}">Contract pricing</button>
        <button class="admin-tab" data-panel="${PANEL_DETAILS}">Details</button>
        <button class="admin-tab" data-panel="${PANEL_HISTORY}">Price history</button>
      </div>
      <div id="biz-panel-pricing" class="biz-panel" hidden></div>
      <div id="biz-panel-details" class="biz-panel" hidden>${accountDetailsHtml(account)}</div>
      <div id="biz-panel-history" class="biz-panel" hidden></div>
    </div>
  `);

  const body = drawer.body;
  body.querySelector('#biz-panel-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-panel]');
    if (!btn) return;
    // Switching a panel is not a navigation — replace, don't push.
    replaceTo({ accountId, tab: btn.dataset.panel });
    showPanel(btn.dataset.panel);
  });

  body.querySelector('#biz-manage')?.addEventListener('click', () => {
    openManageModal({
      // openManageModal expects the registry's key name. The server calls it
      // `id`; map rather than teach two shapes to a shared component.
      account: { ...account, business_account_id: account.id },
      onUpdated: () => { loadAccounts(); openAccountDrawer(accountId, PANEL_DETAILS); },
    });
  });

  await mountContractPanel(body.querySelector('#biz-panel-pricing'), account, {
    onCountChange: (n) => updateCountBadge(accountId, n),
  });
  showPanel(panel);
}

function accountHeaderHtml(a) {
  const bits = [];
  if (a.status && a.status !== 'active') {
    // The single most useful sentence on this screen for a suspended account:
    // its contract prices still EXIST but are not being charged, and the two
    // are easy to confuse when the prices are right there in a table below.
    bits.push(`<p class="biz-note biz-note--warn">This account is <strong>${esc(a.status)}</strong>. Its contract prices are still recorded, but they are <strong>not being charged</strong> — the account pays list price plus the ordinary volume discounts until it is active again.</p>`);
  }
  return `
    <div class="biz-standing">
      <div class="biz-standing__name">${esc(a.company_name || 'Business account')}</div>
      <div class="admin-text-muted">${esc(a.contact_name || '')}${a.contact_email ? ` · ${esc(a.contact_email)}` : ''}</div>
    </div>
    ${bits.join('')}
  `;
}

function accountDetailsHtml(a) {
  const row = (label, value) =>
    `<div class="admin-detail-row"><span class="admin-detail-row__label">${esc(label)}</span><span class="admin-detail-row__value">${value}</span></div>`;
  return `
    ${row('Company', esc(a.company_name || MISSING))}
    ${row('Status', `<span class="admin-badge admin-badge--${esc(a.status || 'active')}">${esc(a.status || 'unknown')}</span>`)}
    ${row('Contact', esc(a.contact_name || MISSING))}
    ${row('Contact email', esc(a.contact_email || MISSING))}
    ${row('Accounts-payable email', esc(a.ap_email || MISSING))}
    ${row('Phone', esc(a.contact_phone || MISSING))}
    ${row('Net 30', a.net30_approved ? 'Approved' : 'Not approved')}
    ${row('Credit limit', a.credit_limit != null ? esc(formatPrice(a.credit_limit)) : MISSING)}
    ${row('Credit used', a.credit_used != null ? esc(formatPrice(a.credit_used)) : MISSING)}
    ${row('Contract prices', a.custom_price_count != null ? esc(String(a.custom_price_count)) : MISSING)}
    ${row('Created', esc(formatDate(a.created_at)))}
    ${row('Account id', `<code class="biz-id">${esc(a.id)}</code>`)}
    <div class="biz-drawer__actions">
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="biz-manage" type="button">Edit credit / status</button>
    </div>
  `;
}

function showPanel(panel) {
  const body = _drawer && Drawer.isOpen() ? _drawer.body : null;
  if (!body) return;
  const want = DRAWER_PANELS.includes(panel) ? panel : PANEL_PRICING;
  body.querySelectorAll('.admin-tab[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === want));
  for (const p of DRAWER_PANELS) {
    const el = body.querySelector(`#biz-panel-${p}`);
    if (el) el.hidden = p !== want;
  }
  if (want === PANEL_HISTORY) renderAccountHistory();
}

/**
 * The account-wide trail, rendered inline rather than in the per-product modal.
 *
 * Reuses the panel's own modal for a single product; this is the "everything
 * that ever changed for this account" view.
 */
function renderAccountHistory() {
  const body = _drawer && Drawer.isOpen() ? _drawer.body : null;
  const host = body && body.querySelector('#biz-panel-history');
  if (!host || host.dataset.loaded === '1') return;
  host.dataset.loaded = '1';
  host.innerHTML = `<p class="admin-text-muted">The full change history for this account.</p>
    <button class="admin-btn admin-btn--ghost admin-btn--sm" id="biz-history-open" type="button">Open price history</button>`;
  host.querySelector('#biz-history-open').addEventListener('click', () => openHistoryModal(null));
}

/** Move the badge behind the drawer without refetching the list. */
function updateCountBadge(accountId, n) {
  const cell = _container && _container.querySelector(`[data-count-for="${CSS.escape(String(accountId))}"]`);
  const row = Array.isArray(_accounts) ? _accounts.find((a) => String(a.id) === String(accountId)) : null;
  if (row) row.custom_price_count = n;
  if (cell && row) cell.innerHTML = countCell(row);
}

// ── Applications ────────────────────────────────────────────────────────────

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

async function loadApplicationsTable() {
  if (!_appsTable) return;
  const mine = _token;
  _appsTable.setLoading(true);
  // The cache holds the UNFILTERED table, which is also what the customer
  // standing check needs. A status filter is applied here rather than
  // re-fetching, because `status` is the only parameter the endpoint honours
  // and one full read answers every question this page asks.
  const res = await loadApplications();
  if (mine !== _token || !_appsTable) return;
  if (!res) {
    _appsTable.setData([], null);
    setQueueNote('The applications queue could not be read. This is a connection problem, not an empty queue.', true);
    return;
  }
  const all = res.applications;
  const rows = _statusFilter
    ? all.filter((r) => String(r.status || '').toLowerCase() === _statusFilter)
    : all;
  const total = res.pagination && Number.isFinite(Number(res.pagination.total)) ? Number(res.pagination.total) : null;
  _appsTable.setData(rows, { total: rows.length, page: 1, limit: rows.length || 1 });

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
            await Promise.all([loadApplicationsTable(), loadAccounts()]);
          },
        });
      });
    },
  });
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function showListTab(tab) {
  _listTab = LIST_TABS.includes(tab) ? tab : TAB_ACCOUNTS;
  if (!_container) return;
  _container.querySelectorAll('#biz-list-tabs .admin-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.listTab === _listTab));
  const acc = _container.querySelector('#biz-accounts-section');
  const apps = _container.querySelector('#biz-apps-section');
  if (acc) acc.hidden = _listTab !== TAB_ACCOUNTS;
  if (apps) apps.hidden = _listTab !== TAB_APPLICATIONS;
  if (_listTab === TAB_APPLICATIONS && _appsTable && !_appsTable._loadedOnce) {
    _appsTable._loadedOnce = true;
    loadApplicationsTable();
  }
}

/** Bring the screen into line with the address. The ONE renderer. */
function syncToRoute() {
  const route = readRouteFromHash();
  showListTab(route.listTab);
  if (route.accountId) {
    openAccountDrawer(route.accountId, route.panel);
  } else if (Drawer.isOpen() && _openAccountId) {
    Drawer.close();
  }
}

// ── Page module ─────────────────────────────────────────────────────────────

export default {
  title: 'Business',

  async init(container) {
    // Belt-and-braces beside the router's NAV_ITEMS-derived gate. Every write
    // here is super_admin server-side, and the contract-pricing responses carry
    // cost_price and margin.
    if (!AdminAuth.isOwner()) {
      container.innerHTML = `<div class="admin-stub">
        <div class="admin-stub__title">Access Restricted</div>
        <div class="admin-stub__text">Business accounts and contract pricing are managed by super-admins only.</div>
      </div>`;
      return;
    }

    _container = container;
    _token++;
    _statusFilter = '';
    _accountSearch = '';
    _accountStatus = '';
    _accountPage = 1;
    _accounts = null;
    _openAccountId = null;

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

    const tabs = document.createElement('div');
    tabs.className = 'admin-tabs admin-mb-lg';
    tabs.id = 'biz-list-tabs';
    tabs.innerHTML = `
      <button class="admin-tab" data-list-tab="${TAB_ACCOUNTS}">Accounts</button>
      <button class="admin-tab" data-list-tab="${TAB_APPLICATIONS}">Applications</button>
    `;
    container.appendChild(tabs);
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-list-tab]');
      if (!btn) return;
      replaceTo({ accountId: null, tab: btn.dataset.listTab });
      showListTab(btn.dataset.listTab);
    });

    const accounts = document.createElement('div');
    accounts.className = 'admin-section admin-mb-lg';
    accounts.id = 'biz-accounts-section';
    accounts.innerHTML = `
      <p class="admin-text-muted" style="margin-top:0">
        Every business account, from the server. Open one to set its own contract prices —
        those apply to that account and to nothing else; no catalogue row is ever changed.
      </p>
      <div class="cp-toolbar">
        <div class="admin-ac cp-toolbar__search">
          <input class="admin-input" id="biz-acct-search" type="search" placeholder="Search company name…" autocomplete="off">
        </div>
        <select class="admin-select" id="biz-acct-status">
          <option value="">All statuses</option>
          ${ACCOUNT_STATUSES.map((s) => `<option value="${escA(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</option>`).join('')}
        </select>
      </div>
      <div id="biz-accounts"></div>
      <div id="biz-reconcile" class="biz-reconcile"></div>
    `;
    container.appendChild(accounts);

    let searchDebounce = null;
    accounts.querySelector('#biz-acct-search').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const v = e.target.value.trim();
      searchDebounce = setTimeout(() => { _accountSearch = v; _accountPage = 1; loadAccounts(); }, 300);
    });
    accounts.querySelector('#biz-acct-status').addEventListener('change', (e) => {
      _accountStatus = e.target.value;
      _accountPage = 1;
      loadAccounts();
    });

    const apps = document.createElement('div');
    apps.className = 'admin-section admin-mb-lg';
    apps.id = 'biz-apps-section';
    apps.hidden = true;
    apps.innerHTML = `
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
    container.appendChild(apps);

    apps.querySelector('#biz-status-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]');
      if (!btn) return;
      apps.querySelectorAll('#biz-status-tabs .admin-tab').forEach((b) => b.classList.toggle('active', b === btn));
      _statusFilter = btn.dataset.status;
      loadApplicationsTable();
    });

    _appsTable = new DataTable(apps.querySelector('#biz-apps-table'), {
      columns: APP_COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No applications',
      emptyIcon: icon('customers', 40, 40),
    });

    await loadAccounts();
    syncToRoute();
  },

  /**
   * The hash changed but the route did not.
   *
   * The argument is deliberately IGNORED: app.js passes
   * `getRouteDetailFromHash()`, which carries `{tab}` and nothing else, so
   * `account` would be undefined forever and the drawer would never change.
   * Re-read the address instead. (ERR-208, in a new shape.)
   */
  onRouteChange() {
    syncToRoute();
  },

  destroy() {
    _token++;
    if (_picker && _picker.destroy) _picker.destroy();
    _picker = null;
    destroyContractPanel();
    if (Drawer.isOpen()) Drawer.close();
    _openAccountId = null;
    _drawer = null;
    _appsTable = null;
    _container = null;
    _statusFilter = '';
    _accounts = null;
    _accountsPagination = null;
    resetApplicationsCache();
  },

  async onFilterChange() {
    if (_listTab === TAB_APPLICATIONS) await loadApplicationsTable();
    else await loadAccounts();
  },
};
