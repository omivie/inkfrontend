/**
 * Business upgrade — the shared "Upgrade to Business" panel, modal and manage
 * dialog, used by BOTH the Customers drawer and the Business page.
 *
 * The rules, payload shaping, error copy and the device-local id registry all
 * live in `../utils/business-accounts.js`; this file is the UI over them and
 * owns no vocabulary of its own. Backend contract:
 * `readfirst/business-one-click-upgrade-FE-handoff-aug2026.md`.
 *
 * ── Why one component and not two copies ───────────────────────────────────
 *
 * The sales flow has two doors — open a customer and upgrade them, or open the
 * Business page and pick a customer — and they must ask for the same fields,
 * validate identically and record the returned id identically. The id is the
 * part that cannot be re-derived (there is no GET for business accounts), so a
 * second copy that forgot to call `record()` would silently strand every account
 * created through that door. One implementation makes that unrepresentable.
 *
 * ── The applications cache ─────────────────────────────────────────────────
 *
 * "Is this customer already a business account?" is answered from the
 * applications queue, fetched ONCE per page session and matched client-side —
 * the endpoint ignores `user_id=` (ERR-151). `resetApplicationsCache()` is
 * called by each page's `destroy()` so a stale table can't outlive a navigation.
 */

import { AdminAPI } from '../api.js';
import { Modal } from './modal.js';
import { Toast } from './toast.js';
import {
  buildUpgradePayload,
  buildAccountPatch,
  describeCreateError,
  describeUpdateError,
  matchApplications,
  BusinessAccountRegistry,
  ACCOUNT_STATUSES,
  CREDIT_LIMIT_MAX,
} from '../utils/business-accounts.js';

const esc = (s) => (typeof Security !== 'undefined' ? Security.escapeHtml(String(s ?? '')) : String(s ?? ''));
const escA = (s) => (typeof Security !== 'undefined' ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const MISSING = '—';
const money = (v) => (window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`);

function fmtDate(d) {
  if (!d) return MISSING;
  try { return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return MISSING; }
}

// ── Applications cache ──────────────────────────────────────────────────────

let _appsPromise = null;

/** One fetch per page session; every caller matches over the same rows. */
export function loadApplications() {
  // No limit passed: AdminAPI owns the page size, because the endpoint 400s
  // above 100 rather than clamping, and it pages until the table is covered.
  if (!_appsPromise) _appsPromise = AdminAPI.listBusinessApplications();
  return _appsPromise;
}

export function resetApplicationsCache() {
  _appsPromise = null;
}

/**
 * Everything a surface needs to describe one customer's business standing.
 * @returns {Promise<object>} see matchApplications() plus `local`
 */
export async function readBusinessState(customer) {
  const res = await loadApplications();
  const state = matchApplications(res && res.applications, customer && customer.id, res && res.pagination);
  return { ...state, local: BusinessAccountRegistry.forUser(customer && customer.id) };
}

// ── The panel ───────────────────────────────────────────────────────────────

/**
 * Render the business-standing panel.
 *
 * Five states, and the two "we don't actually know" ones are the reason this is
 * not a boolean:
 *   business_account    — an approved application exists
 *   pending_application — upgrading supersedes it (documented side effect)
 *   no_application      — PROVEN: the read covered the whole table
 *   unknown             — read failed or was partial; the button still shows,
 *                         because the server is the authority and 409 is a safe
 *                         landing. Guessing "not a business account" here is the
 *                         ERR-139 shape: an outage rendered as a verdict.
 */
export function businessPanelHtml(state) {
  if (!state) {
    return `<p class="admin-text-muted">Checking business account…</p>`;
  }

  const local = state.local || { account: null, readable: true };
  let h = '';

  if (state.verdict === 'business_account') {
    const app = state.approved || {};
    h += `<div class="biz-standing">
      <span class="admin-badge admin-badge--business">Business account</span>
      <span class="biz-standing__name">${esc(app.company_name || MISSING)}</span>
    </div>`;
    h += row('Approved', fmtDate(app.reviewed_at || app.submitted_at || app.created_at));
    if (app.credit_limit != null) h += row('Credit limit (at approval)', money(app.credit_limit));
    h += localAccountHtml(local);
  } else if (state.verdict === 'pending_application') {
    const app = state.pending || {};
    h += `<div class="biz-standing">
      <span class="admin-badge admin-badge--pending">Application pending</span>
      <span class="biz-standing__name">${esc(app.company_name || MISSING)}</span>
    </div>`;
    h += row('Submitted', fmtDate(app.submitted_at || app.created_at));
    h += `<p class="biz-note biz-note--warn">Upgrading now closes this pending application as <strong>superseded</strong>. No decline email is sent.</p>`;
    h += upgradeButton('Upgrade to Business');
  } else if (state.verdict === 'no_application') {
    h += `<p class="admin-text-muted" style="margin-top:0">Not a business account. No application on file.</p>`;
    h += upgradeButton('Upgrade to Business');
  } else {
    // unknown
    h += `<p class="biz-note biz-note--warn">Couldn't confirm this customer's business standing${
      state.readable && !state.complete
        ? ` — only ${state.seen} of ${state.total} applications were read`
        : ' — the applications queue did not answer'
    }. This is a read problem on our side, not a statement about their account.</p>`;
    h += upgradeButton('Upgrade to Business…');
  }

  return h;
}

function upgradeButton(label) {
  return `<button class="admin-btn admin-btn--primary admin-btn--sm" data-action="biz-upgrade" type="button" style="margin-top:10px">${esc(label)}</button>`;
}

/**
 * The device-local id card.
 *
 * `readable:false` (storage blocked or the record is corrupt) is rendered
 * DIFFERENTLY from "no record" — they look identical to a naive caller and mean
 * opposite things, and only one of them justifies "manage it elsewhere".
 */
function localAccountHtml(local) {
  if (!local.readable) {
    return `<p class="biz-note">This browser's local record of business-account ids can't be read, so the manage controls are hidden. Nothing is wrong with the account itself.</p>`;
  }
  const a = local.account;
  if (!a) {
    return `<p class="biz-note">Account id unknown on this device, so credit limit and status can't be changed here. The backend has no lookup endpoint for business accounts yet (<code>GET /api/admin/business/accounts</code> → 404), so only accounts created on this browser can be managed.</p>`;
  }
  let h = `<div class="biz-local">`;
  h += row('Status', `<span class="admin-badge admin-badge--${esc(a.status || 'active')}">${esc(a.status || 'active')}</span>`, true);
  h += row('Credit limit', a.credit_limit != null ? money(a.credit_limit) : MISSING);
  h += row('Net 30', a.net30_approved ? 'Approved' : 'Not approved');
  h += row('Account id', `<code class="biz-id">${esc(a.business_account_id)}</code>`, true);
  h += `<p class="biz-note">Recorded on this device ${esc(fmtDate(a.recorded_at))}${a.recorded_by ? ` by ${esc(a.recorded_by)}` : ''}. It is not read back from the backend.</p>`;
  h += `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="biz-manage" data-id="${escA(a.business_account_id)}" type="button">Edit credit / status</button>`;
  h += `</div>`;
  return h;
}

function row(label, value, raw = false) {
  return `<div class="admin-detail-row"><span class="admin-detail-row__label">${esc(label)}</span><span class="admin-detail-row__value">${raw ? value : esc(value)}</span></div>`;
}

/**
 * Wire the panel's buttons. Call after every render — the panel is re-rendered
 * in place on success, so the handlers must be re-attached, not attached once.
 */
export function bindBusinessPanel(scope, { customer, prefill, onChanged }) {
  const up = scope.querySelector('[data-action="biz-upgrade"]');
  if (up) up.addEventListener('click', () => openUpgradeModal({ customer, prefill, onUpgraded: onChanged }));
  const manage = scope.querySelector('[data-action="biz-manage"]');
  if (manage) {
    manage.addEventListener('click', () => {
      const { account } = BusinessAccountRegistry.get(manage.dataset.id);
      if (!account) { Toast.error('That account is no longer recorded on this device.'); return; }
      openManageModal({ account, onUpdated: onChanged });
    });
  }
}

// ── The upgrade modal ───────────────────────────────────────────────────────

function field(label, name, value, { type = 'text', placeholder = '', help = '', required = false, attrs = '' } = {}) {
  return `<div class="admin-form-group">
    <label for="biz-${escA(name)}">${esc(label)}${required ? ' <span class="required-star">*</span>' : ''}</label>
    <input class="admin-input" id="biz-${escA(name)}" data-biz="${escA(name)}" type="${escA(type)}"
      value="${escA(value)}" placeholder="${escA(placeholder)}" ${attrs}>
    ${help ? `<div class="admin-form-help">${esc(help)}</div>` : ''}
    <div class="admin-form-error" data-error-for="${escA(name)}" hidden></div>
  </div>`;
}

function addressFieldset(prefix, legend, values, extra = '') {
  const v = (k) => (values && values[k]) || '';
  return `<div class="biz-fieldset">
    <div class="inv-section__title">${esc(legend)}${extra}</div>
    ${field('Street address', `${prefix}.address1`, v('address1'), { placeholder: '37A Archibald Rd' })}
    ${field('Suburb / line 2', `${prefix}.address2`, v('address2'))}
    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--spacing-3)">
      ${field('City', `${prefix}.city`, v('city'), { placeholder: 'Auckland' })}
      ${field('Region', `${prefix}.region`, v('region'))}
      ${field('Postcode', `${prefix}.postcode`, v('postcode'), { placeholder: '0602' })}
    </div>
  </div>`;
}

export function upgradeFormHtml(prefill = {}) {
  const p = prefill;
  return `
    <p class="admin-text-muted" style="margin-top:0">Upgrading takes effect immediately: volume pricing, Business Centre access, promo-coupon exclusion, and a B2B welcome email to the contact address.</p>

    ${field('Company name', 'company_name', p.company_name || '', { required: true, attrs: 'maxlength="255"' })}

    <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
      ${field('Credit limit (NZD)', 'credit_limit', p.credit_limit != null ? p.credit_limit : '0', {
        type: 'number', required: true,
        attrs: `min="0" max="${CREDIT_LIMIT_MAX}" step="0.01"`,
        help: 'Net 30 exposure only. Volume pricing does not depend on it — use 0 for a cash/card business.',
      })}
      <div class="admin-form-group">
        <label>Net 30</label>
        <label class="biz-check"><input type="checkbox" data-biz="net30_approved" ${p.net30_approved ? 'checked' : ''}> Approved for Net 30 invoicing</label>
        <div class="admin-form-help">Off unless credit has actually been granted.</div>
      </div>
    </div>

    <details class="biz-details"${p._hasOptional ? ' open' : ''}>
      <summary>Contact &amp; business details (optional)</summary>
      ${field('NZBN', 'nzbn', p.nzbn || '', { placeholder: '9429012345678', help: '13 digits. Spaces and dashes are stripped before sending.' })}
      ${field('Contact name', 'contact_name', p.contact_name || '', { help: 'Defaults to the customer’s profile name.' })}
      ${field('Contact email', 'contact_email', p.contact_email || '', { type: 'email', help: 'Defaults to the customer’s sign-in email. The welcome email goes here.' })}
      ${field('Accounts-payable email', 'ap_email', p.ap_email || '', { type: 'email', help: 'Defaults to the contact email.' })}
      ${addressFieldset('billing_address', 'Billing address', p.billing_address)}
      ${addressFieldset('shipping_address', 'Shipping address', p.shipping_address,
        ` <label class="biz-check biz-check--inline"><input type="checkbox" data-biz-copy="1"> same as billing</label>`)}
      <p class="admin-form-help">An address is all-or-nothing: street, city and postcode are all required once any of them is filled in, so a part-filled address is left off rather than rejected.</p>
    </details>

    <div class="admin-form-error biz-form-error" data-error-for="" hidden></div>
  `;
}

/** Read every `[data-biz]` in the modal into a flat field bag. */
export function collectFields(scope) {
  const out = {};
  scope.querySelectorAll('[data-biz]').forEach((el) => {
    out[el.dataset.biz] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

function clearErrors(scope) {
  scope.querySelectorAll('.admin-form-error').forEach((el) => { el.hidden = true; el.textContent = ''; });
  scope.querySelectorAll('.admin-input--error').forEach((el) => el.classList.remove('admin-input--error'));
}

/**
 * Paint field-level errors. A message whose field is blank or unknown still has
 * to land somewhere — it goes to the form-level slot rather than being dropped,
 * because PATCH's empty-body 400 arrives with `field: ""` and would otherwise
 * vanish entirely.
 */
function showErrors(scope, errors) {
  clearErrors(scope);
  const orphans = [];
  let firstBad = null;
  for (const e of errors) {
    const slot = e.field ? scope.querySelector(`[data-error-for="${CSS.escape(e.field)}"]`) : null;
    const input = e.field ? scope.querySelector(`[data-biz="${CSS.escape(e.field)}"]`) : null;
    if (slot) {
      slot.textContent = e.message;
      slot.hidden = false;
      if (input) { input.classList.add('admin-input--error'); if (!firstBad) firstBad = input; }
      // A dropped-in address error means the optional section is collapsed —
      // open it, or the operator sees a rejection pointing at nothing.
      const details = slot.closest('details');
      if (details) details.open = true;
    } else {
      orphans.push(e.message);
    }
  }
  if (orphans.length) {
    const formSlot = scope.querySelector('.biz-form-error');
    if (formSlot) { formSlot.textContent = orphans.join(' '); formSlot.hidden = false; }
  }
  if (firstBad) firstBad.focus();
}

function showNotes(scope, notes) {
  const slot = scope.querySelector('.biz-form-error');
  if (!slot || !notes.length) return;
  slot.textContent = notes.join(' ');
  slot.hidden = false;
}

/**
 * The one-click upgrade.
 *
 * On 201 the returned id is recorded BEFORE anything else happens — no toast, no
 * close, no callback first. There is no GET for business accounts, so an
 * exception thrown between the response and the write would lose the only copy
 * of that id permanently.
 */
export function openUpgradeModal({ customer, prefill = {}, onUpgraded }) {
  const who = customerLabel(customer);
  const modal = Modal.open({
    title: `Upgrade to Business — ${who}`,
    className: 'admin-modal--wide',
    body: upgradeFormHtml(prefill),
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="upgrade">Upgrade to Business</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());

  const copy = modal.body.querySelector('[data-biz-copy]');
  if (copy) {
    copy.addEventListener('change', () => {
      if (!copy.checked) return;
      ['address1', 'address2', 'city', 'region', 'postcode'].forEach((k) => {
        const from = modal.body.querySelector(`[data-biz="billing_address.${k}"]`);
        const to = modal.body.querySelector(`[data-biz="shipping_address.${k}"]`);
        if (from && to) to.value = from.value;
      });
    });
  }

  const btn = modal.footer.querySelector('[data-action="upgrade"]');
  btn.addEventListener('click', async () => {
    const fields = collectFields(modal.body);
    fields.user_id = customer && customer.id;
    const { payload, errors, notes } = buildUpgradePayload(fields);
    if (errors.length) { showErrors(modal.body, errors); return; }
    clearErrors(modal.body);
    showNotes(modal.body, notes);

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Upgrading…';
    try {
      const data = await AdminAPI.createBusinessAccount(payload);
      const id = data && data.id;

      // FIRST. See the docblock — this id has no other source.
      const recorded = id
        ? BusinessAccountRegistry.record({
          business_account_id: id,
          application_id: data && data.application_id,
          user_id: payload.user_id,
          company_name: payload.company_name,
          contact_email: payload.contact_email || (customer && customer.email) || null,
          credit_limit: payload.credit_limit,
          net30_approved: payload.net30_approved,
          status: 'active',
          recorded_by: (window.Auth && window.Auth.getUser && window.Auth.getUser()?.email) || null,
        })
        : { ok: false };

      Modal.close();
      Toast.success(`${payload.company_name} is now a business account`);
      if (!id) {
        Toast.warning('The upgrade succeeded but the response carried no account id, so credit limit and status can’t be changed from here.');
      } else if (!recorded.ok) {
        Toast.warning(`Account id ${id} could not be saved in this browser — copy it now if you need to change credit or status later.`);
      }
      if (onUpgraded) await onUpgraded({ id, application_id: data && data.application_id });
    } catch (e) {
      const d = describeCreateError(e);
      if (d.fields.length) showErrors(modal.body, d.fields);
      else showErrors(modal.body, [{ field: '', message: d.message }]);
      Toast.error(`${d.title}: ${d.message}`);
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}

// ── The manage modal (PATCH) ────────────────────────────────────────────────

export function openManageModal({ account, onUpdated }) {
  const modal = Modal.open({
    title: `Business account — ${account.company_name || account.business_account_id}`,
    body: `
      <p class="admin-text-muted" style="margin-top:0">Changes take effect immediately. Suspending or closing blocks the Business Centre and Net 30 at checkout straight away.</p>
      <div class="admin-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--spacing-3)">
        ${field('Credit limit (NZD)', 'credit_limit', account.credit_limit != null ? account.credit_limit : '', {
          type: 'number', attrs: `min="0" max="${CREDIT_LIMIT_MAX}" step="0.01"`,
        })}
        <div class="admin-form-group">
          <label for="biz-status">Status</label>
          <select class="admin-select" id="biz-status" data-biz="status">
            ${ACCOUNT_STATUSES.map((s) => `<option value="${escA(s)}"${(account.status || 'active') === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
          <div class="admin-form-error" data-error-for="status" hidden></div>
        </div>
      </div>
      <label class="biz-check"><input type="checkbox" data-biz="net30_approved" ${account.net30_approved ? 'checked' : ''}> Approved for Net 30 invoicing</label>
      <p class="admin-form-help">Account id <code class="biz-id">${esc(account.business_account_id)}</code> — recorded on this device, not read back from the backend.</p>
      <div class="admin-form-error biz-form-error" data-error-for="" hidden></div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Save changes</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  const btn = modal.footer.querySelector('[data-action="save"]');
  btn.addEventListener('click', async () => {
    const fields = collectFields(modal.body);
    const { patch, errors } = buildAccountPatch(fields);
    if (errors.length) { showErrors(modal.body, errors); return; }
    clearErrors(modal.body);

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      await AdminAPI.updateBusinessAccount(account.business_account_id, patch);
      // Mirror it locally so the card stops disagreeing with the server. A
      // failed mirror is cosmetic — the change IS made — so it warns, never errors.
      const mirrored = BusinessAccountRegistry.update(account.business_account_id, patch);
      Modal.close();
      Toast.success('Business account updated');
      if (!mirrored.ok) Toast.warning('Saved on the backend, but this browser’s local copy could not be updated.');
      if (onUpdated) await onUpdated(patch);
    } catch (e) {
      const d = describeUpdateError(e);
      if (d.fields.length) showErrors(modal.body, d.fields);
      else showErrors(modal.body, [{ field: '', message: d.message }]);
      Toast.error(`${d.title}: ${d.message}`);
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}

// ── Prefill ─────────────────────────────────────────────────────────────────

export function customerLabel(customer) {
  if (!customer) return 'Customer';
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ')
    || customer.full_name || customer.email || 'Customer';
}

/**
 * Seed the form from what we actually know.
 *
 * Addresses come ONLY from a pending application, which stores them structured.
 * The saved invoicing profile keeps its address as a free-text `string[]`, and
 * splitting that into street/city/postcode is a guess — a wrong postcode on a
 * B2B billing address is worse than a blank one the operator fills in.
 */
export function prefillFor(customer, state) {
  const app = (state && (state.pending || state.rejected)) || null;
  const inv = (customer && customer.invoicing) || {};
  const billTo = inv.bill_to || {};
  const p = {
    company_name: (app && app.company_name) || billTo.company || '',
    credit_limit: 0,
    net30_approved: false,
    nzbn: (app && app.nzbn) || '',
    contact_name: (app && app.contact_name) || customerLabel(customer),
    contact_email: (app && app.contact_email) || (customer && customer.email) || '',
    ap_email: (app && app.ap_email) || billTo.email || '',
    billing_address: (app && app.billing_address) || null,
    shipping_address: (app && app.shipping_address) || null,
  };
  p._hasOptional = !!(p.nzbn || p.billing_address || p.shipping_address);
  return p;
}
