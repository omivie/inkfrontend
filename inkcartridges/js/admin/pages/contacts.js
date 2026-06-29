/**
 * Contacts — manually-entered billing/delivery parties for fast invoicing.
 *
 * Lives as a tab inside the Customers page (customers.js wires it like reviews.js).
 * A contact holds every NON-GOODS invoice field (bill-to + deliver-to + a default
 * note) so an operator can drop a reusable party (accountant, reseller, "head
 * office") straight into an invoice from the Invoices editor's "Fill details
 * from…" picker.
 *
 * Persistence is fail-soft: AdminAPI.{list,get,create,update,delete}Contact hit
 * /api/admin/contacts which 404s until the backend ships — reads degrade to an
 * empty list, writes surface a clean toast (mirrors loyalty / invoices).
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';

const MISSING = '—';
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
// Address is stored as string[] on the wire; edited as a \n-joined textarea.
const linesToText = (a) => (Array.isArray(a) ? a.join('\n') : (a || ''));
const textToLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
let _alive = false;        // module-level destroy guard (ERR-045)

const COLUMNS = [
  {
    key: 'label', label: 'Label', sortable: true,
    render: (r) => `<span class="cell-truncate">${esc(r.label || r.bill_to?.name || r.bill_to?.company || MISSING)}</span>`,
  },
  {
    key: 'company', label: 'Company',
    render: (r) => `<span class="cell-truncate cell-muted">${esc(r.bill_to?.company || MISSING)}</span>`,
  },
  {
    key: 'email', label: 'Email',
    render: (r) => `<span class="cell-truncate cell-muted">${esc(r.bill_to?.email || MISSING)}</span>`,
  },
  {
    key: 'phone', label: 'Phone',
    render: (r) => `<span class="cell-nowrap cell-muted">${esc(r.bill_to?.phone || MISSING)}</span>`,
  },
  {
    key: 'location', label: 'Location',
    render: (r) => `<span class="cell-truncate cell-muted">${esc((r.bill_to?.address || [])[0] || MISSING)}</span>`,
  },
];

async function loadContacts() {
  if (_table) _table.setLoading(true);
  const data = await AdminAPI.listContacts({ search: _search }, _page, 20);
  if (!_alive || !_table) return; // destroyed/navigated during await
  if (!data) { _table.setData([], null); return; }
  const rows = Array.isArray(data) ? data : (data.contacts || data.data || []);
  const pagination = data.pagination || { total: data.total || rows.length, page: _page, limit: 20 };
  _table.setData(rows, pagination);
}

// ---- Editor drawer (create / edit) -------------------------------------
function field(label, name, value, opts = {}) {
  const type = opts.type || 'text';
  const ph = opts.placeholder ? ` placeholder="${escA(opts.placeholder)}"` : '';
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <input class="admin-input" type="${type}" data-cf="${name}" value="${escA(value)}"${ph}></label>`;
}
function area(label, name, value, ph) {
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <textarea class="admin-input inv-textarea" data-cf="${name}" rows="3"${ph ? ` placeholder="${escA(ph)}"` : ''}>${esc(value)}</textarea></label>`;
}

function editorBody(c) {
  const b = c.bill_to || {};
  const d = c.deliver_to || {};
  return `<div class="invoice-editor__form">
    <section class="inv-section">
      <div class="inv-section__title">Contact</div>
      ${field('Label (how it shows in lists)', 'label', c.label || '', { placeholder: 'e.g. Acme Ltd – Accounts' })}
    </section>
    <section class="inv-section">
      <div class="inv-section__title">Bill to</div>
      <div class="inv-grid-2">
        ${field('Attn', 'bill_to.attn', b.attn || '')}
        ${field('Name', 'bill_to.name', b.name || '')}
        ${field('Company / line', 'bill_to.company', b.company || '')}
        ${field('Phone', 'bill_to.phone', b.phone || '')}
        ${field('Email', 'bill_to.email', b.email || '', { type: 'email' })}
      </div>
      ${area('Address (one line per row)', 'bill_to.address', linesToText(b.address))}
    </section>
    <section class="inv-section">
      <div class="inv-section__title">Deliver to (goods) — optional</div>
      <div class="inv-grid-2">
        ${field('Attn', 'deliver_to.attn', d.attn || '')}
        ${field('Company / line', 'deliver_to.company', d.company || '')}
      </div>
      ${area('Delivery address (leave blank to ship to the bill-to address)', 'deliver_to.address', linesToText(d.address))}
      ${field('Phone (delivery contact)', 'deliver_to.phone', d.phone || '')}
    </section>
    <section class="inv-section">
      <div class="inv-section__title">Default note</div>
      ${area('Note pre-filled onto invoices from this contact', 'notes', c.notes || '')}
    </section>
  </div>`;
}

// Read the form back into a contact payload (address fields → string[]).
function collect(body) {
  const out = { bill_to: {}, deliver_to: {} };
  body.querySelectorAll('[data-cf]').forEach((el) => {
    const path = el.dataset.cf;
    const isAddr = path.endsWith('.address');
    const val = isAddr ? textToLines(el.value) : el.value.trim();
    const parts = path.split('.');
    if (parts.length === 1) out[parts[0]] = val;
    else { out[parts[0]] = out[parts[0]] || {}; out[parts[0]][parts[1]] = val; }
  });
  if (!out.label) out.label = out.bill_to.name || out.bill_to.company || '';
  return out;
}

function openContactDrawer(contact) {
  const editing = !!(contact && contact.id);
  const c = contact || { bill_to: {}, deliver_to: {} };
  const footer = `
    <button class="admin-btn admin-btn--ghost" data-cact="cancel">Cancel</button>
    ${editing ? `<button class="admin-btn admin-btn--ghost" data-cact="delete">${icon('trash', 14, 14)} Delete</button>` : ''}
    <button class="admin-btn admin-btn--primary" data-cact="save">${editing ? 'Save changes' : 'Create contact'}</button>`;

  const drawer = Drawer.open({
    title: editing ? `Edit ${c.label || c.bill_to?.name || 'contact'}` : 'New contact',
    width: 'min(720px, 96vw)',
    body: editorBody(c),
    footer,
  });
  if (!drawer) return;

  drawer.footer.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-cact]')?.dataset.cact;
    if (!act) return;
    if (act === 'cancel') { Drawer.close(); return; }
    if (act === 'delete') {
      Modal.confirm({
        title: 'Delete contact',
        message: `Delete "${c.label || c.bill_to?.name || 'this contact'}"? This can't be undone.`,
        confirmLabel: 'Delete',
        onConfirm: async () => {
          try {
            await AdminAPI.deleteContact(c.id);
            Toast.success('Contact deleted.');
            Drawer.close();
            loadContacts();
          } catch (err) {
            Toast.error(err.message || 'Could not delete — the contacts backend may not be live yet.');
          }
        },
      });
      return;
    }
    if (act === 'save') {
      const payload = collect(drawer.body);
      if (!payload.label && !payload.bill_to.name && !payload.bill_to.company) {
        Toast.warning('Give the contact a label, name or company.');
        return;
      }
      const btn = drawer.footer.querySelector('[data-cact="save"]');
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
      try {
        if (editing) await AdminAPI.updateContact(c.id, payload);
        else await AdminAPI.createContact(payload);
        Toast.success('Contact saved.');
        Drawer.close();
        loadContacts();
      } catch (err) {
        Toast.error(err.message || 'Could not save — the contacts backend may not be live yet.');
        btn.disabled = false; btn.textContent = orig;
      }
    }
  });
}

// ---- Page lifecycle -----------------------------------------------------
export default {
  title: 'Contacts',

  async init(container) {
    _container = container;
    _alive = true;
    _page = 1;
    _search = '';

    const header = document.createElement('div');
    header.className = 'admin-page-header';
    header.innerHTML = `
      <h1>Contacts</h1>
      <div class="admin-page-header__actions">
        <div class="admin-search">
          <span class="admin-search__icon">${icon('search', 14, 14)}</span>
          <input class="admin-input" type="search" id="contact-search" placeholder="Search contacts…" autocomplete="off">
        </div>
        <button class="admin-btn admin-btn--primary" id="contact-add">${icon('plus', 14, 14)} Add contact</button>
      </div>`;
    container.appendChild(header);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'admin-mb-lg';
    container.appendChild(tableContainer);

    _table = new DataTable(tableContainer, {
      columns: COLUMNS,
      rowKey: 'id',
      onRowClick: (row) => openContactDrawer(row),
      onPageChange: (page) => { _page = page; loadContacts(); },
      emptyMessage: 'No contacts yet — add one to speed up invoicing.',
      emptyIcon: icon('customers', 40, 40),
    });

    let searchTimer;
    header.querySelector('#contact-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { _search = e.target.value.trim(); _page = 1; loadContacts(); }, 300);
    });
    header.querySelector('#contact-add').addEventListener('click', () => openContactDrawer(null));

    await loadContacts();
  },

  destroy() {
    _alive = false;
    if (_table) _table.destroy();
    _table = null;
    _container = null;
    _search = '';
    _page = 1;
  },
};
