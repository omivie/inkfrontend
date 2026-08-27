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
import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { attachProductAutocomplete, productCostExGst, resolveSkus } from '../components/product-search.js';
import {
  PRICE_AUTO, PRICE_MANUAL, MAX_QUOTE_LINES,
  quoteRequestBody, normalizeQuote, applyQuoteToLines, clearVolume,
  formatVolumePercent,
} from '../utils/invoice-quote.js';
import { costOrNull } from '../utils/invoice-math.js';
import { GST_INCL, GST_EXCL, gstSub } from '../utils/gst-basis.js';
import { codesToVerify, applyResolvedCodes, unresolvedLineErrors } from '../utils/line-codes.js';
import { buildQuickOrderPrefill } from '../utils/quick-order-bridge.js';
import { searchParties, orderToParty, partyEmptyText } from '../utils/party-search.js';

const GST_RATE = 0.15;
const MISSING = '—';

// Supplier cost is owner-only (the route already is; gate the field too).
// AdminAuth is a module export, not a global — see the note in pages/invoices.js.
// A `typeof AdminAuth !== 'undefined'` guard here silently hid the column entirely.
const canSeeCost = () => AdminAuth.isOwner();

// ---- small helpers (self-contained copies of the invoice-page primitives) ----
const escA = (s) => Security.escapeAttr(String(s ?? ''));
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

// ── Volume-ladder quote (POST /api/admin/invoices/quote) ─────────────────────
// The same endpoint the Invoices editor uses, for the same reason: a walk-in
// buying seven of something must get the price the website would have given
// them. Only the per-line half is used here — a quick order has no freight
// field, so the shipping half of the response is simply not read.
let _quote = null;
let _quoteSeq = 0;
let _quoteDebounce = null;
let _volumeOffers = [];
const QUOTE_DEBOUNCE_MS = 400;

// =========================================================================
//  Draft model
// =========================================================================
// unitPrice     — ex-GST SELL price (what the customer is charged).
// supplierCost  — ex-GST price WE paid. INTERNAL. null = unknown, NOT 0.
// costSource    — 'auto' (from products.cost_price) | 'manual' (typed over).
// priceSource   — the same distinction for the SELL price. 'auto' = we filled it
//                 and the volume ladder may replace it; 'manual' = the operator
//                 authored it and nothing may overwrite it.
// volumePercent / volumeSaving / volumeQuantity
//               — the discount the backend said applied when we filled the price.
//                 Carried across the sessionStorage bridge so a quick order that
//                 becomes an invoice keeps the bulk note it was priced with.
// Kept in lockstep with the Invoices editor: the two share the .inv-line grid AND
// the sessionStorage bridge in createInvoiceFrom().
const blankLine = () => ({
  code: '', description: '', qty: 1, unitPrice: 0, supplierCost: null, costSource: 'auto',
  priceSource: PRICE_AUTO, volumePercent: null, volumeSaving: null, volumeQuantity: null,
});

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
    // A saved price is operator-authored history — the ladder may offer, never take.
    priceSource: PRICE_MANUAL,
    volumePercent: l.volume_discount_percent ?? l.volumePercent ?? null,
    volumeSaving: l.volume_saving_excl_gst ?? l.volumeSaving ?? null,
    volumeQuantity: l.volume_quantity ?? l.volumeQuantity ?? null,
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
      // The volume discount actually applied. No columns for these yet (BF-043);
      // unknown keys are ignored, and they matter most on the invoice this quick
      // order becomes — which carries them across via the sessionStorage bridge.
      volume_discount_percent: l.volumePercent ?? null,
      volume_saving_excl_gst: l.volumeSaving ?? null,
      volume_quantity: l.volumeQuantity ?? null,
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
  { key: 'total', label: 'Total', align: 'right', sortable: true, gst: GST_INCL, render: (r) => money(r.total_incl_gst ?? r.total ?? 0) },
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
          // DELETE /api/admin/quick-orders/:id is live (probed 401, 2026-07-31),
          // so a 404 means THIS quick order is gone — not that the route is
          // unbuilt. The old copy was the excuse that hid ERR-131 for a month.
          Toast.error(err.code === 'NOT_FOUND'
            ? 'That quick order no longer exists — it may already have been deleted. Refresh the list.'
            : (err.message || 'Could not delete that quick order. Try again.'));
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
//
// The prefill carries the quick-order `id` (buildQuickOrderPrefill → qo_id) so the
// invoice save can flip this order to status='invoiced' and stop the sale being
// counted twice. A SAVED order carries its id; converting a brand-new unsaved draft
// (id == null) carries qo_id: null — nothing was persisted, so there is no shadow
// order to double-count and nothing to flip. See utils/quick-order-bridge.js.
function createInvoiceFrom(rec) {
  const d = rec.id && rec.bill_to !== undefined ? draftFromRecord(rec) : (rec.customer ? rec : draftFromRecord(rec));
  const prefill = buildQuickOrderPrefill(d);
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
  // A quote describes ONE draft; carrying it over would badge this one with the
  // previous order's discounts.
  resetQuoteState();
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
    onClose: () => { if (token === _editorToken) { _editorToken++; teardownAutocompletes(); _draft = null; _editorRefs = null; resetQuoteState(); } },
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

// =========================================================================
//  Volume-ladder quote
// =========================================================================
// Deliberately the same shape as the Invoices editor's copy, minus the shipping
// half. Both call the SAME decision functions in utils/invoice-quote.js, so the
// counter and the invoice cannot disagree about what a bulk price is.

function resetQuoteState() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = null;
  _quoteSeq++;              // bumped, not zeroed — an in-flight reply for the old
  _quote = null;            // draft can then never be mistaken for this one's
  _volumeOffers = [];
}

function scheduleQuote() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = setTimeout(() => { requestQuote(); }, QUOTE_DEBOUNCE_MS);
}

async function requestQuote() {
  const token = _editorToken;
  const seq = ++_quoteSeq;
  const req = quoteRequestBody(_draft);
  if (!req) return;
  if (req.truncated > 0) warn(`quote covers the first ${MAX_QUOTE_LINES} lines; ${req.truncated} were not priced`);

  const res = await AdminAPI.quoteInvoice(req.body);
  // The drawer can close mid-flight (ERR-045), and replies can land out of order
  // — an older one carries an older quantity. Only the newest may write.
  if (!editorAlive(token) || seq !== _quoteSeq) return;
  if (!res.ok) return;      // keep whatever we had; never blank a filled price

  const quote = normalizeQuote(res.data);
  if (!quote) return;
  _quote = quote;

  const { lines, offers, changed } = applyQuoteToLines(_draft.lines, quote);
  _volumeOffers = offers;
  if (changed) _draft.lines = lines;
  renderLines();
  if (changed) refreshTotals();
}

/** The quote's answer for one draft-line index, if we have one. */
function quoteLineAt(i) {
  return (_quote?.lines || []).find((l) => l.position === i) || null;
}

/**
 * The strip under one line row. Full-width child of the `.inv-line` grid
 * (`grid-column: 1/-1`) — NOT a seventh cell, which would misalign the six-column
 * grid this editor shares verbatim with the Invoices editor.
 */
function lineQuoteNote(l, i) {
  const bits = [];
  const pct = Number(l.volumePercent);
  if (Number.isFinite(pct) && pct > 0) {
    const saving = num(l.volumeSaving) > 0 ? ` · customer saves ${money(l.volumeSaving)}` : '';
    bits.push(`<span class="inv-vol inv-vol--applied">Volume &minus;${esc(formatVolumePercent(pct))}${esc(saving)}</span>`);
  } else {
    const offer = _volumeOffers.find((o) => o.position === i);
    if (offer) {
      bits.push(`<button type="button" class="inv-vol inv-vol--offer" data-form-action="apply-volume" data-line="${i}">Apply volume price ${esc(money(offer.badge.unitPrice))} (&minus;${esc(offer.badge.percentText)})</button>`);
    }
  }
  const ql = quoteLineAt(i);
  if (ql && ql.resolved && !ql.isActive) bits.push(`<span class="inv-vol inv-vol--warn">Inactive product</span>`);
  if (!bits.length) return '';
  return `<div class="inv-line__note">${bits.join('')}</div>`;
}

function bindEditorBody(drawer) {
  const form = drawer.body.querySelector('.invoice-editor__form');
  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('click', onFormClick);
  renderLines();
  attachPartyPicker();
  refreshTotals();
  scheduleQuote();
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
      // Typing a PRICE does the same on the sell side and drops any volume claim:
      // the number is theirs now, so a "−6%" beside it would describe a discount
      // we did not give. The ladder becomes an offer instead.
      if (f === 'unitPrice') {
        _draft.lines[i].priceSource = PRICE_MANUAL;
        _draft.lines[i] = clearVolume(_draft.lines[i]);
      }
      if (f === 'code' || f === 'qty' || f === 'unitPrice') scheduleQuote();
    }
    refreshTotals();
  } else { return; }
  t.classList.remove('admin-input--error', 'admin-select--error');
  t.closest('.inv-field')?.classList.remove('inv-field--error');
}

function onFormClick(e) {
  const act = e.target.closest('[data-form-action]')?.dataset.formAction;
  if (!act) return;
  if (act === 'add-line') { _draft.lines.push(blankLine()); renderLines(); refreshTotals(); scheduleQuote(); }
  else if (act === 'remove-line') {
    const i = +e.target.closest('[data-line]').dataset.line;
    _draft.lines.splice(i, 1);
    if (!_draft.lines.length) _draft.lines.push(blankLine());
    // Positions shift, so every cached answer now describes the wrong row.
    _quote = null; _volumeOffers = [];
    renderLines(); refreshTotals(); scheduleQuote();
  } else if (act === 'apply-volume') {
    // The ONE path by which a hand-edited price is replaced: the operator asked.
    const i = +e.target.closest('[data-line]').dataset.line;
    const offer = _volumeOffers.find((o) => o.position === i);
    if (!offer || !_draft.lines[i]) return;
    _draft.lines[i] = {
      ..._draft.lines[i],
      unitPrice: offer.badge.unitPrice,
      priceSource: PRICE_AUTO,
      volumePercent: offer.badge.percent,
      volumeSaving: offer.badge.lineSaving,
      volumeQuantity: num(_draft.lines[i].qty),
    };
    _volumeOffers = _volumeOffers.filter((o) => o.position !== i);
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
          <span>Product Code</span><span>Description</span><span>Qty</span><span>Unit Price${gstSub(GST_EXCL)}</span>${canSeeCost() ? `<span>Our Cost${gstSub(GST_EXCL)}</span>` : ''}<span></span>
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
      <input class="admin-input${l.priceSource === PRICE_MANUAL ? ' inv-line__price--manual' : ''}" type="number" step="0.01" min="0" data-line="${i}" data-lfield="unitPrice" value="${escA(l.unitPrice)}">
      ${costCell}
      <button class="admin-btn admin-btn--ghost admin-btn--sm inv-line__rm" data-form-action="remove-line" title="Remove line">${icon('trash', 12, 12)}</button>
      ${lineQuoteNote(l, i)}
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
            // Qty-1 retail ex-GST, shown until the quote answers. Kept as the
            // fallback on purpose: dropping it would leave the row blank whenever
            // the quote is slow or unavailable (ERR-158 — removing a fallback is
            // a behaviour change, not a cleanup).
            unitPrice: ex,
            supplierCost: keepManual ? prev.supplierCost : productCostExGst(p),
            costSource: keepManual ? 'manual' : 'auto',
            priceSource: PRICE_AUTO,
            volumePercent: null, volumeSaving: null, volumeQuantity: null,
          };
          renderLines(); refreshTotals(); scheduleQuote();
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

// Unified "look up" picker — Contacts, then Customers, then Orders, in one
// sectioned dropdown. Shares ONE search with the Invoices editor's "Fill details
// from…" picker (utils/party-search.js): these two were byte-identical copies,
// which is how they came to share a four-month blind spot for guest checkouts
// (ERR-176). A guest has no contact row and no account row — only an order.
function attachPartyPicker() {
  const body = _editorRefs?.drawer.body;
  if (!body) return;
  const input = body.querySelector('#qo-party-search');
  if (!input) return;
  let partyFailed = [];
  const h = attachAutocomplete(input, {
    fetch: async (q) => {
      const { sections, failed } = await searchParties(q, AdminAPI);
      partyFailed = failed;
      return sections;
    },
    emptyText: (q) => partyEmptyText(q, partyFailed),
    render: (it) => partyRowHtml(it),
    onPick: (it) => {
      if (it.__type === 'contact') fillFromContact(it);
      else if (it.__type === 'order') fillFromOrderDetails(it);
      else fillFromCustomer(it);
    },
  });
  _acHandles.push(h);
}

/** One row of the party dropdown, per source. */
function partyRowHtml(it) {
  if (it.__type === 'contact') {
    return `<span class="admin-ac__code">${esc(it.label || it.bill_to?.name || 'Contact')}</span> <span class="admin-ac__meta">${esc(it.bill_to?.company || it.bill_to?.email || '')}</span>`;
  }
  if (it.__type === 'order') {
    const p = orderToParty(it);
    return `<span class="admin-ac__code">${esc(p.orderNumber)}</span> ${esc(p.name || p.email || '—')} <span class="admin-ac__meta">· details only</span>`;
  }
  return `${esc(it.full_name || `${it.first_name || ''} ${it.last_name || ''}`.trim() || '—')} <span class="admin-ac__meta">· ${esc(it.email || '')}</span>`;
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

/**
 * Fill the customer block from a past order and nothing else — no line items.
 * The order is a source of NAME AND ADDRESS here, not of goods; neither
 * `customer_id` nor `contact_id` is set, because a guest order proves neither.
 */
function fillFromOrderDetails(order) {
  if (!order) return;
  const p = orderToParty(order);
  _draft.customer_id = null;
  _draft.contact_id = null;
  _draft.customer = {
    name: p.name,
    company: p.company,
    phone: p.phone,
    email: p.email,
    address: p.address,
  };
  _draft.save_contact = false;
  _fillSource = { type: 'order details', label: p.orderNumber };
  rebuildEditor();
  Toast.success(`Filled customer details from order ${p.orderNumber} — line items not imported`.trim());
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

/**
 * Every line code must be a real products.sku before the order is written.
 *
 * Same gate as the Invoices editor (ERR-071), and if anything the more urgent of
 * the two: a quick order becomes a REAL order, not a shadow one, and it also seeds
 * the invoice editor through the qo_invoice_prefill bridge — so a series/base code
 * typed here (`CTN258` for `CTN258XLKCMY`) reaches an invoice anyway.
 *
 * Resolvable codes are canonicalised in place; unresolvable ones are highlighted
 * and the save is refused. A catalogue we can't reach (null) never blocks a save.
 * Returns true when it's safe to write.
 */
async function verifyLineCodes(token) {
  const resolved = await resolveSkus(codesToVerify(_draft?.lines || []));
  if (!editorAlive(token)) return false;              // closed mid-lookup (ERR-045)
  if (!resolved) { warn('SKU verification skipped — catalogue unreachable'); return true; }
  const errs = applyResolvedCodes(_draft.lines, resolved);
  if (!errs.length) return true;
  const first = markErrors(errs);
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus({ preventScroll: true }); }
  Toast.warning(errs.length === 1 ? errs[0].msg : `${errs.length} lines have a code that isn’t a product SKU — pick each product from the list.`);
  return false;
}

/**
 * The backend's fail-soft net, rendered LOUD.
 *
 * When the catalogue is unreachable our client guard lets the save through
 * (verifyLineCodes returns true on a null resolve), and the backend rejects any
 * non-SKU code with 400 VALIDATION_FAILED + `error.details.unresolved` (ERR-071).
 * Rather than a vague toast, pin each offending line's code box exactly the way the
 * client guard does. Returns true when it handled the error (caller should stop).
 */
function surfaceUnresolvedCodes(err, token) {
  if (err?.code !== 'VALIDATION_FAILED') return false;
  if (!(err.details?.unresolved || Array.isArray(err.details))) return false;
  const errs = unresolvedLineErrors(_draft?.lines, err.details?.unresolved ?? err.details);
  if (!errs.length) return false;
  const first = editorAlive(token) ? markErrors(errs) : null;
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus({ preventScroll: true }); }
  Toast.error(errs.length === 1 ? errs[0].msg
    : `${errs.length} lines have a code that isn’t a product SKU — pick each product from the list.`);
  return true;
}

async function saveQuickOrder() {
  if (!ensureValid()) return;
  const token = _editorToken;
  const btn = _editorRefs?.drawer.footer.querySelector('[data-ed-action="save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    if (!(await verifyLineCodes(token))) return;
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
        Toast.warning('Saved the order, but the contact couldn’t be saved'
          + (err?.message ? ` — ${err.message}` : '.'));
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
    if (surfaceUnresolvedCodes(err, token)) return;
    // POST/PUT /api/admin/quick-orders are live (probed 401, 2026-07-31).
    Toast.error(err.message || 'Could not save this quick order. Try again.');
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
        <!-- As of 2026-07-14 (backend migration 108) each SAVED quick order
             materialises a shadow order, so quick-order sales are now counted in
             analytics just like invoices. Say so plainly — the owner was previously
             told these were a register only, and would otherwise keep hand-counting
             sales that are already in the totals. "Create invoice" moves the sale
             onto the invoice WITHOUT double-counting: the invoice save flips this
             quick order to status='invoiced', which cancels its own shadow (see the
             status flip in pages/invoices.js persistDraft). -->
        <div class="qo-notice qo-notice--info">
          <span><strong>Quick orders now count in your sales figures.</strong>
          Every saved quick order is included in the Dashboard, Finance and Demand Ranking
          (cost of goods and all). Hit <strong>Create invoice</strong> to turn one into an
          invoice — the sale moves onto that invoice and <em>won’t</em> be counted twice.</span>
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
    resetQuoteState();         // also cancels the pending debounced quote
  },
};
