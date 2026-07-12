/**
 * Quick Order — phone / walk-in order register.
 *
 * When a customer calls to order (rather than checking out on the website), the
 * operator logs it here: pull up an existing customer or contact to auto-fill
 * their details, OR type a brand-new caller's details from scratch (optionally
 * saving them as a reusable Contact), then add the products they want as
 * searchable line items. Each save is one dated order line — the same caller
 * ringing today and again tomorrow makes two separate, searchable rows.
 *
 * Deliberately separate from website Orders (keeps sales analytics clean) and
 * from Invoices (a quick order MAY become an invoice via the row "Create
 * invoice" bridge, but needn't). Reuses the Invoices editor patterns: the
 * sectioned Contacts+Customers party picker and the product-search line items.
 *
 * Persistence is fail-soft: AdminAPI.{list,get,create,update,delete}QuickOrder
 * hit /api/admin/quick-orders which 404s until the backend ships — reads degrade
 * to an empty list, writes surface a clean toast (mirrors invoices / contacts).
 * Backend contract: readfirst/quick-orders-backend-jul2026.md.
 */
import { AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { attachProductAutocomplete, productCostExGst } from '../components/product-search.js';
import { costOrNull } from '../utils/invoice-math.js';

const GST_RATE = 0.15;
const MISSING = '—';

// Supplier cost is owner-only (the route already is; gate the field too).
const canSeeCost = () => (typeof AdminAuth !== 'undefined' && AdminAuth?.isOwner) ? AdminAuth.isOwner() : false;

// ---- small helpers (self-contained copies of the invoice-page primitives) ----
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const money = (n) => (typeof window.formatPrice === 'function' ? window.formatPrice(Number(n) || 0) : '$' + (Number(n) || 0).toFixed(2));
const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const warn = (m, e) => window.DebugLog?.warn?.(`[QuickOrder] ${m}`, e?.message || e);
const toLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const joinLines = (a) => (Array.isArray(a) ? a.filter(Boolean).join('\n') : (a || ''));

function todayInputValue() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-07-03" -> "3 Jul 2026" (matches the Customers list style). Falls back to raw.
function formatDate(iso) {
  const parts = String(iso || '').slice(0, 10).split('-');
  if (parts.length !== 3) return iso || '';
  const y = +parts[0], m = +parts[1] - 1, d = +parts[2];
  if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return iso;
  return `${d} ${MONTHS[m]} ${y}`;
}

// ---- module state -------------------------------------------------------
let _container = null;
let _table = null;
let _page = 1;
let _limit = 20;
let _filters = { search: '', sort: 'order_date', order: 'desc' };
let _searchDebounce = null;
let _alive = false;

let _draft = null;
let _editorRefs = null;      // { drawer }
let _editorToken = 0;
let _fillSource = null;      // { type, label }
let _acHandles = [];         // attachAutocomplete handles to destroy on rebuild/teardown
const editorAlive = (token) => token === _editorToken && _editorRefs != null;

// =========================================================================
//  Draft model
// =========================================================================
// unitPrice     — ex-GST SELL price (what the customer is charged).
// supplierCost  — ex-GST price WE paid. INTERNAL. null = unknown, NOT 0.
// costSource    — 'auto' (from products.cost_price) | 'manual' (typed over).
// Kept in lockstep with the Invoices editor: the two share the .inv-line grid AND
// the sessionStorage bridge in createInvoiceFrom().
const blankLine = () => ({ code: '', description: '', qty: 1, unitPrice: 0, supplierCost: null, costSource: 'auto' });

function freshDraft() {
  return {
    id: null,
    order_date: todayInputValue(),   // date the order was taken — searchable in the list
    contact_id: null,
    customer_id: null,
    customer: { name: '', company: '', phone: '', email: '', address: '' },
    save_contact: false,
    lines: [blankLine()],
    notes: '',
  };
}

// Map a saved backend record back into the editor draft (tolerant of field variants).
function draftFromRecord(rec) {
  const d = freshDraft();
  d.id = rec.id ?? null;
  d.order_date = (rec.order_date || rec.created_at || '').slice(0, 10) || d.order_date;
  d.contact_id = rec.contact_id ?? null;
  d.customer_id = rec.customer_id ?? null;
  const b = rec.bill_to || {};
  d.customer = {
    name: b.name || rec.customer_name || '',
    company: b.company || rec.customer_company || '',
    phone: b.phone || rec.customer_phone || '',
    email: b.email || rec.customer_email || '',
    address: joinLines(b.address),
  };
  const items = rec.line_items || rec.lines || [];
  d.lines = items.length ? items.map((l) => ({
    code: l.product_code ?? l.code ?? '',
    description: l.description ?? '',
    qty: num(l.quantity ?? l.qty ?? 1),
    unitPrice: num(l.unit_price_excl_gst ?? l.unitPrice ?? 0),
    supplierCost: costOrNull(l.supplier_cost_excl_gst ?? l.supplierCost),
    costSource: l.cost_source || l.costSource || 'auto',
  })) : [blankLine()];
  d.notes = rec.notes ?? '';
  return d;
}

// A line counts only if it has a product code or description (drop phantom rows).
const realLines = (d) => (d.lines || []).filter((l) => (l.code || '').trim() || (l.description || '').trim());

function computeTotals(d) {
  const subtotal = round2(realLines(d).reduce((s, l) => s + num(l.qty) * num(l.unitPrice), 0));
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);
  return { subtotal, gst, total };
}

function buildPayload(d) {
  const c = d.customer;
  return {
    order_date: d.order_date || null,
    contact_id: d.contact_id || null,
    customer_id: d.customer_id || null,
    customer_name: c.name || null,
    customer_company: c.company || null,
    customer_phone: c.phone || null,
    customer_email: c.email || null,
    bill_to: { name: c.name, company: c.company, phone: c.phone, email: c.email, address: toLines(c.address) },
    line_items: realLines(d).map((l) => ({
      product_code: l.code, description: l.description, quantity: num(l.qty), unit_price_excl_gst: round2(num(l.unitPrice)),
      // OUR cost — internal. null tells the backend to snapshot products.cost_price itself.
      supplier_cost_excl_gst: costOrNull(l.supplierCost),
      cost_source: l.costSource || 'auto',
    })),
    notes: d.notes,
    // Client preview only — backend recomputes authoritatively and ignores these.
    preview_totals: computeTotals(d),
  };
}

// =========================================================================
//  List
// =========================================================================
function itemsSummary(r) {
  const items = r.line_items || r.lines || [];
  const count = r.item_count != null ? r.item_count : items.length;
  if (!count) return `<span class="cell-muted">${MISSING}</span>`;
  const first = items[0]?.product_code || items[0]?.code || items[0]?.description || '';
  const extra = count > 1 ? ` <span class="cell-muted">+${count - 1}</span>` : '';
  return first ? `<span class="cell-mono">${esc(first)}</span>${extra}` : `${count} item${count === 1 ? '' : 's'}`;
}

const COLUMNS = [
  { key: 'order_date', label: 'Date', sortable: true, render: (r) => esc(formatDate(r.order_date || r.created_at)) },
  { key: 'customer_name', label: 'Customer', render: (r) => esc(r.customer_name || r.bill_to?.name || MISSING) },
  {
    key: 'contact', label: 'Contact',
    render: (r) => `<span class="cell-truncate cell-muted">${esc(r.customer_email || r.customer_phone || r.bill_to?.email || r.bill_to?.phone || MISSING)}</span>`,
  },
  { key: 'items', label: 'Items', render: (r) => itemsSummary(r) },
  { key: 'total', label: 'Total (incl GST)', align: 'right', sortable: true, render: (r) => money(r.total_incl_gst ?? r.total ?? 0) },
  {
    key: 'actions', label: '', align: 'right',
    render: (r) => `
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="invoice" data-id="${escA(r.id)}" title="Create invoice from this order">${icon('invoice', 13, 13)}</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${escA(r.id)}" title="Delete">${icon('trash', 13, 13)}</button>`,
  },
];

async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  const data = await AdminAPI.listQuickOrders(_filters, _page, _limit);
  if (!_alive || !_table) return; // destroyed/navigated during await
  const rows = data?.quick_orders || data?.items || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || (data?.total != null ? { total: data.total, page: _page, limit: _limit } : null);
  _table.setData(rows, pagination);
}

async function onRowAction(e) {
  const btn = e.target.closest('[data-row-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  const action = btn.dataset.rowAction;
  if (action === 'invoice') {
    const rec = await AdminAPI.getQuickOrder(id);
    if (!_alive) return;
    createInvoiceFrom(rec || { id });
  } else if (action === 'delete') {
    Modal.confirm({
      title: 'Delete this quick order?',
      message: 'This phone-order record will be permanently removed. This cannot be undone.',
      confirmLabel: 'Delete',
      confirmClass: 'admin-btn--danger',
      onConfirm: async () => {
        try { await AdminAPI.deleteQuickOrder(id); Toast.success('Quick order deleted.'); loadData(); }
        catch (err) {
          Toast.error(err.code === 'NOT_FOUND'
            ? 'Delete isn’t available yet (backend endpoint pending).'
            : (err.message || 'Delete failed.'));
        }
      },
    });
  }
}

async function openExisting(row) {
  const rec = await AdminAPI.getQuickOrder(row.id) || row;
  if (!_alive) return;
  openEditor(draftFromRecord(rec));
}

// Hand the order off to the Invoices editor, pre-filled. The Invoices page reads
// this key once on init (see invoices.js), opens its editor and clears it.
function createInvoiceFrom(rec) {
  const d = rec.id && rec.bill_to !== undefined ? draftFromRecord(rec) : (rec.customer ? rec : draftFromRecord(rec));
  const c = d.customer || {};
  const prefill = {
    order_date: d.order_date || '',
    customer: { attn: c.name || '', name: c.name || '', company: c.company || '', address: c.address || '', phone: c.phone || '', email: c.email || '' },
    // unitPrice (sell) maps to the invoice's unitCost (also sell — see the naming
    // note in utils/invoice-math.js). supplierCost keeps its name across the bridge
    // because it means the same thing on both sides: what WE paid.
    lines: (d.lines || []).map((l) => ({
      code: l.code || '', description: l.description || '', qty: num(l.qty) || 1,
      unitCost: round2(num(l.unitPrice)),
      supplierCost: costOrNull(l.supplierCost),
      costSource: l.costSource || 'auto',
    })),
  };
  try { sessionStorage.setItem('qo_invoice_prefill', JSON.stringify(prefill)); }
  catch (err) { warn('could not stage invoice prefill', err); }
  window.location.hash = 'invoices';
}

// =========================================================================
//  Editor (Drawer)
// =========================================================================
function openEditor(draft) {
  _draft = draft;
  _fillSource = null;
  const token = ++_editorToken;
  const footer = `
    <button class="admin-btn admin-btn--ghost" data-ed-action="cancel">Cancel</button>
    ${draft.id ? `<button class="admin-btn admin-btn--ghost" data-ed-action="invoice">${icon('invoice', 14, 14)} Create invoice</button>` : ''}
    <button class="admin-btn admin-btn--primary" data-ed-action="save">${draft.id ? 'Save changes' : 'Save quick order'}</button>`;

  const drawer = Drawer.open({
    title: draft.id ? 'Edit quick order' : 'New quick order',
    width: 'min(860px, 96vw)',
    body: editorBodyHtml(draft),
    footer,
    onClose: () => { if (token === _editorToken) { _editorToken++; teardownAutocompletes(); _draft = null; _editorRefs = null; } },
  });
  if (!drawer) return;
  _editorRefs = { drawer };

  drawer.footer.addEventListener('click', onEditorFooterClick);
  bindEditorBody(drawer);
}

function teardownAutocompletes() {
  _acHandles.forEach((h) => { try { h.destroy(); } catch (_) { /* noop */ } });
  _acHandles = [];
}

function bindEditorBody(drawer) {
  const form = drawer.body.querySelector('.invoice-editor__form');
  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('click', onFormClick);
  renderLines();
  attachPartyPicker();
  refreshTotals();
}

// Replace the body in-place (used after an auto-fill that touches many fields).
function rebuildEditor() {
  if (!_editorRefs) return;
  teardownAutocompletes();
  _editorRefs.drawer.setBody(editorBodyHtml(_draft));
  bindEditorBody(_editorRefs.drawer);
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] = o[parts[i]] || {});
  o[parts[parts.length - 1]] = val;
}

function onFormInput(e) {
  const t = e.target;
  if (t.dataset.field === 'save_contact') {
    _draft.save_contact = !!t.checked;
    return;
  }
  if (t.dataset.field) {
    setPath(_draft, t.dataset.field, t.value);
  } else if (t.dataset.line != null && t.dataset.lfield) {
    const i = +t.dataset.line;
    const f = t.dataset.lfield;
    if (_draft.lines[i]) {
      _draft.lines[i][f] = t.value;
      // Typing a cost promotes the line to a manual override; clearing it reverts
      // to auto (and to "unknown" — '' is not 0).
      if (f === 'supplierCost') _draft.lines[i].costSource = t.value === '' ? 'auto' : 'manual';
    }
    refreshTotals();
  } else { return; }
  t.classList.remove('admin-input--error', 'admin-select--error');
  t.closest('.inv-field')?.classList.remove('inv-field--error');
}

function onFormClick(e) {
  const act = e.target.closest('[data-form-action]')?.dataset.formAction;
  if (!act) return;
  if (act === 'add-line') { _draft.lines.push(blankLine()); renderLines(); refreshTotals(); }
  else if (act === 'remove-line') {
    const i = +e.target.closest('[data-line]').dataset.line;
    _draft.lines.splice(i, 1);
    if (!_draft.lines.length) _draft.lines.push(blankLine());
    renderLines(); refreshTotals();
  } else if (act === 'clear-fill') {
    _draft.customer = { name: '', company: '', phone: '', email: '', address: '' };
    _draft.contact_id = null;
    _draft.customer_id = null;
    _fillSource = null;
    rebuildEditor();
  }
}

async function onEditorFooterClick(e) {
  const act = e.target.closest('[data-ed-action]')?.dataset.edAction;
  if (!act) return;
  if (act === 'cancel') { Drawer.close(); return; }
  if (act === 'invoice') { createInvoiceFrom(_draft); return; }
  if (act === 'save') { await saveQuickOrder(); return; }
}

// =========================================================================
//  Editor markup
// =========================================================================
function field(label, path, value, opts = {}) {
  const type = opts.type || 'text';
  const ph = opts.placeholder ? ` placeholder="${escA(opts.placeholder)}"` : '';
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <input class="admin-input" type="${type}" data-field="${path}" value="${escA(value)}"${ph}${opts.attrs || ''}></label>`;
}
function areaField(label, path, value) {
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>
    <textarea class="admin-input inv-textarea" data-field="${path}" rows="3">${esc(value)}</textarea></label>`;
}

// "Filled from contact/customer X — clear" chip, shown after an auto-fill.
function fillChipHtml() {
  if (!_fillSource) return '<div id="qo-fill-chip"></div>';
  return `<div id="qo-fill-chip"><span class="inv-fill-chip">Filled from ${esc(_fillSource.type)}: <strong>${esc(_fillSource.label)}</strong>
    <button type="button" class="inv-fill-chip__clear" data-form-action="clear-fill" title="Clear the filled details" aria-label="Clear filled details">✕</button></span></div>`;
}

function editorBodyHtml(d) {
  const c = d.customer;
  return `
  <div class="invoice-editor invoice-editor--single">
    <div class="invoice-editor__form">

      <section class="inv-section inv-section--source">
        <div class="inv-section__title">Customer</div>
        <label class="inv-field"><span class="inv-field__label">Look up a customer or contact</span>
          <div class="admin-ac"><input class="admin-input" id="qo-party-search" type="search" placeholder="Search an existing customer or contact…" autocomplete="off"></div>
        </label>
        ${fillChipHtml()}
        <div class="inv-grid-2">
          ${field('Name', 'customer.name', c.name, { placeholder: 'Caller / company contact' })}
          ${field('Company / line', 'customer.company', c.company)}
          ${field('Phone', 'customer.phone', c.phone)}
          ${field('Email', 'customer.email', c.email, { type: 'email' })}
        </div>
        ${areaField('Address (one line per row) — optional', 'customer.address', c.address)}
        ${d.contact_id ? '' : `<label class="qo-check"><input type="checkbox" data-field="save_contact"${d.save_contact ? ' checked' : ''}> <span>Also save as a reusable contact (so they autocomplete next time)</span></label>`}
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Order</div>
        <div class="inv-grid-2">
          <label class="inv-field"><span class="inv-field__label">Order date <span class="inv-field__hint">(when the order was taken)</span></span>
            <input class="admin-input" type="date" data-field="order_date" value="${escA(d.order_date)}"></label>
        </div>
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Products</div>
        <div class="inv-lines-head qo-lines-head${canSeeCost() ? '' : ' inv-line--nocost'}">
          <span>Product Code</span><span>Description</span><span>Qty</span><span>Unit Price (excl. GST)</span>${canSeeCost() ? '<span>Our Cost (excl. GST)</span>' : ''}<span></span>
        </div>
        <div id="qo-lines"></div>
        ${canSeeCost() ? `<p class="inv-section__hint">“Our Cost” is internal — it auto-fills from the product’s cost price and can be typed over. It never appears on the invoice this order becomes.</p>` : ''}
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="add-line">${icon('plus', 13, 13)} Add line</button>
        <div id="qo-totals" class="qo-totals"></div>
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Notes</div>
        ${areaField('Internal note (optional)', 'notes', d.notes)}
      </section>
    </div>
  </div>`;
}

function renderLines() {
  const host = _editorRefs?.drawer.body.querySelector('#qo-lines');
  if (!host) return;
  const showCost = canSeeCost();
  host.innerHTML = (_draft.lines || []).map((l, i) => {
    const manual = l.costSource === 'manual';
    const costCell = showCost ? `
      <input class="admin-input inv-line__cost${manual ? ' inv-line__cost--manual' : ''}"
             type="number" step="0.01" min="0" data-line="${i}" data-lfield="supplierCost"
             value="${escA(l.supplierCost ?? '')}" placeholder="auto"
             title="${manual ? 'Manual override' : 'Auto-filled from the product’s cost'} — internal only, never shown to the customer">` : '';
    return `
    <div class="inv-line${showCost ? '' : ' inv-line--nocost'}" data-line="${i}">
      <div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="code" value="${escA(l.code)}" placeholder="SKU / code" autocomplete="off"></div>
      <div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="description" value="${escA(l.description)}" placeholder="Product description" autocomplete="off"></div>
      <input class="admin-input" type="number" step="1" min="0" data-line="${i}" data-lfield="qty" value="${escA(l.qty)}">
      <input class="admin-input" type="number" step="0.01" min="0" data-line="${i}" data-lfield="unitPrice" value="${escA(l.unitPrice)}">
      ${costCell}
      <button class="admin-btn admin-btn--ghost admin-btn--sm inv-line__rm" data-form-action="remove-line" title="Remove line">${icon('trash', 12, 12)}</button>
    </div>`;
  }).join('');
  // Product autocomplete on both code + description inputs of every line.
  host.querySelectorAll('.inv-line').forEach((row) => {
    const i = +row.dataset.line;
    row.querySelectorAll('.inv-ac > input').forEach((input) => {
      const h = attachProductAutocomplete(input, {
        onPick: (p) => {
          const prev = _draft.lines[i] || {};
          const sku = p.sku || '';
          const ex = p.retail_price != null ? round2(num(p.retail_price) / (1 + GST_RATE)) : num(p.sell_price ?? p.price ?? 0);
          // Same anti-clobber rule as the Invoices editor: a manual override
          // survives a re-pick of the SAME product, but a different product
          // resets to that product's own cost.
          const keepManual = prev.costSource === 'manual'
            && costOrNull(prev.supplierCost) != null
            && prev.code === sku;
          _draft.lines[i] = {
            code: sku,
            description: p.name || p.product_name || '',
            qty: prev.qty || 1,
            unitPrice: ex,
            supplierCost: keepManual ? prev.supplierCost : productCostExGst(p),
            costSource: keepManual ? 'manual' : 'auto',
          };
          renderLines(); refreshTotals();
        },
      });
      _acHandles.push(h);
    });
  });
}

function refreshTotals() {
  const host = _editorRefs?.drawer.body.querySelector('#qo-totals');
  if (!host) return;
  const t = computeTotals(_draft);
  host.innerHTML = `
    <div class="qo-totals__row"><span>Subtotal (excl. GST)</span><span>${money(t.subtotal)}</span></div>
    <div class="qo-totals__row"><span>GST (15%)</span><span>${money(t.gst)}</span></div>
    <div class="qo-totals__row qo-totals__row--total"><span>Total (incl. GST)</span><span>${money(t.total)}</span></div>`;
}

// Unified "look up" picker — Contacts first, then Customers, in one sectioned
// dropdown (mirrors the Invoices editor's "Fill details from…" picker).
function attachPartyPicker() {
  const body = _editorRefs?.drawer.body;
  if (!body) return;
  const input = body.querySelector('#qo-party-search');
  if (!input) return;
  const h = attachAutocomplete(input, {
    fetch: async (q) => {
      const [cts, cus] = await Promise.all([
        AdminAPI.listContacts({ search: q }, 1, 6),
        AdminAPI.getCustomers({ search: q }, 1, 6),
      ]);
      const contacts = (Array.isArray(cts) ? cts : (cts?.contacts || cts?.items || []))
        .map((x) => ({ ...x, __type: 'contact' }));
      const customers = (cus?.customers || cus?.items || [])
        .map((x) => ({ ...x, __type: 'customer' }));
      const sections = [];
      if (contacts.length) sections.push({ title: 'Contacts', items: contacts });
      if (customers.length) sections.push({ title: 'Customers', items: customers });
      return sections;
    },
    render: (it) => it.__type === 'contact'
      ? `<span class="admin-ac__code">${esc(it.label || it.bill_to?.name || 'Contact')}</span> <span class="admin-ac__meta">${esc(it.bill_to?.company || it.bill_to?.email || '')}</span>`
      : `${esc(it.full_name || `${it.first_name || ''} ${it.last_name || ''}`.trim() || '—')} <span class="admin-ac__meta">· ${esc(it.email || '')}</span>`,
    onPick: (it) => { if (it.__type === 'contact') fillFromContact(it); else fillFromCustomer(it); },
  });
  _acHandles.push(h);
}

function fillFromContact(c) {
  if (!c) return;
  const b = c.bill_to || {};
  _draft.contact_id = c.id || null;
  _draft.customer_id = null;
  _draft.customer = {
    name: b.name || b.company || '',
    company: b.company || '',
    phone: b.phone || '',
    email: b.email || '',
    address: joinLines(b.address),
  };
  _draft.save_contact = false;
  _fillSource = { type: 'contact', label: c.label || b.name || b.company || 'contact' };
  rebuildEditor();
  Toast.success(`Filled from contact ${_fillSource.label}`.trim());
}

function fillFromCustomer(c) {
  if (!c) return;
  const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
  _draft.customer_id = c.id || null;
  _draft.contact_id = null;
  // Prefer the customer's saved invoicing profile over bare account fields.
  const inv = c.invoicing;
  const b = (inv && inv.bill_to) ? inv.bill_to : {};
  _draft.customer = {
    name: b.name || name,
    company: b.company || '',
    phone: b.phone || c.phone || '',
    email: b.email || c.email || '',
    address: joinLines(b.address),
  };
  _draft.save_contact = false;
  _fillSource = { type: 'customer', label: name };
  rebuildEditor();
  Toast.success(`Filled from customer ${name}`.trim());
}

// ---- validation + save --------------------------------------------------
function validate(d) {
  const errs = [];
  if (!(d.customer.name || '').trim() && !(d.customer.company || '').trim())
    errs.push({ field: 'customer.name', msg: 'Customer name or company is required' });
  if (!realLines(d).length)
    errs.push({ line: 0, lfield: 'code', msg: 'Add at least one product' });
  return errs;
}

function markErrors(errs) {
  const body = _editorRefs?.drawer.body;
  if (!body) return null;
  let first = null;
  errs.forEach((e) => {
    const sel = e.field ? `[data-field="${e.field}"]` : `[data-line="${e.line}"][data-lfield="${e.lfield}"]`;
    const el = body.querySelector(sel);
    if (!el) return;
    el.classList.add(el.tagName === 'SELECT' ? 'admin-select--error' : 'admin-input--error');
    el.closest('.inv-field')?.classList.add('inv-field--error');
    if (!first) first = el;
  });
  return first;
}

function ensureValid() {
  const body = _editorRefs?.drawer.body;
  body?.querySelectorAll('.admin-input--error, .admin-select--error, .inv-field--error')
    .forEach((el) => el.classList.remove('admin-input--error', 'admin-select--error', 'inv-field--error'));
  const errs = validate(_draft);
  if (!errs.length) return true;
  const first = markErrors(errs);
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus({ preventScroll: true }); }
  Toast.warning(errs.length === 1 ? errs[0].msg : `Please complete the highlighted fields (${errs.length}).`);
  return false;
}

async function saveQuickOrder() {
  if (!ensureValid()) return;
  const token = _editorToken;
  const btn = _editorRefs?.drawer.footer.querySelector('[data-ed-action="save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // Optionally mint a reusable contact from a brand-new caller's details.
    if (_draft.save_contact && !_draft.contact_id) {
      const c = _draft.customer;
      try {
        const created = await AdminAPI.createContact({
          label: c.name || c.company || '',
          bill_to: { name: c.name, company: c.company, phone: c.phone, email: c.email, address: toLines(c.address) },
        });
        if (editorAlive(token) && created?.id) _draft.contact_id = created.id;
      } catch (err) {
        warn('save-as-contact skipped', err);
        Toast.warning('Saved the order, but couldn’t save the contact (backend pending).');
      }
    }
    const payload = buildPayload(_draft);
    const saved = _draft.id
      ? await AdminAPI.updateQuickOrder(_draft.id, payload)
      : await AdminAPI.createQuickOrder(payload);
    if (saved) {
      Toast.success(_draft.id ? 'Quick order updated.' : 'Quick order saved.');
      Drawer.close();
      loadData();
    } else {
      Toast.error('Save returned no data.');
    }
  } catch (err) {
    warn('save failed', err);
    Toast.error(err.message || 'Could not save — the quick-order backend may not be live yet.');
  } finally {
    if (btn && editorAlive(token)) { btn.disabled = false; btn.textContent = _draft?.id ? 'Save changes' : 'Save quick order'; }
  }
}

// =========================================================================
//  Page lifecycle
// =========================================================================
export default {
  title: 'Quick Order',

  async init(container) {
    _container = container;
    _alive = true;
    _page = 1;
    _filters = { search: '', sort: 'order_date', order: 'desc' };

    container.innerHTML = `
      <div class="admin-page-content">
        <div class="admin-page-header">
          <div>
            <h1>Quick Order</h1>
            <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">Log phone &amp; walk-in orders. Look up an existing customer or capture a new caller, then add their products.</p>
          </div>
          <div class="admin-page-header__actions">
            <button class="admin-btn admin-btn--primary" id="qo-new">${icon('plus', 14, 14)} New quick order</button>
          </div>
        </div>
        <div class="admin-filters" style="display:flex;gap:var(--spacing-2);margin-bottom:var(--spacing-3);flex-wrap:wrap">
          <div class="admin-search" style="flex:1;min-width:240px">
            <span class="admin-search__icon">${icon('search', 14, 14)}</span>
            <input class="admin-input" id="qo-search" type="search" placeholder="Search customer, email, phone or date…" autocomplete="off" style="width:100%;padding-left:32px">
          </div>
        </div>
        <div id="qo-table"></div>
      </div>
    `;

    _table = new DataTable(container.querySelector('#qo-table'), {
      columns: COLUMNS,
      rowKey: 'id',
      emptyMessage: 'No quick orders yet — click “New quick order” to log a phone order.',
      emptyIcon: icon('orders', 28, 28),
      onRowClick: (row) => openExisting(row),
      onSort: (key, dir) => { _filters.sort = key; _filters.order = dir; loadData(); },
      onPageChange: (p) => { _page = p; loadData(); },
      onLimitChange: (l) => { _limit = l; _page = 1; loadData(); },
    });

    container.querySelector('#qo-new').addEventListener('click', () => openEditor(freshDraft()));
    container.querySelector('#qo-search').addEventListener('input', (e) => {
      clearTimeout(_searchDebounce);
      const v = e.target.value;
      _searchDebounce = setTimeout(() => { _filters.search = v.trim(); _page = 1; loadData(); }, 300);
    });
    container.querySelector('#qo-table').addEventListener('click', onRowAction);

    await loadData();
  },

  destroy() {
    _alive = false;
    clearTimeout(_searchDebounce);
    _editorToken++;
    teardownAutocompletes();
    if (Drawer.isOpen()) Drawer.close();
    _table?.destroy?.();
    _table = null;
    _container = null;
    _draft = null;
    _editorRefs = null;
    _fillSource = null;
  },
};
