/**
 * Invoices Page — create / save / download standalone invoices.
 *
 * Two surfaces:
 *   A. List  — searchable, paginated table of saved invoices (DataTable).
 *   B. Editor — slide-in Drawer with a form on the left and a live invoice
 *      preview on the right (mirrors the operator's exemplar). Invoices can be
 *      built from scratch or auto-filled from an existing order / customer /
 *      catalogue product.
 *
 * Money model (matches the exemplar): line "Unit Cost" and "Sub Total" are
 * GST-EXCLUSIVE; GST (15%) is added on top of (subtotal + freight); Total is
 * the GST-inclusive sum. Freight of 0 renders as "Free".
 *
 * SOURCE OF TRUTH: the frontend computes a LIVE PREVIEW only. On Save the
 * backend assigns the invoice number (continuing the series) and returns the
 * authoritative subtotal/GST/total. PDF is backend-generated when available;
 * until then we fall back to client-side jsPDF (already loaded in the shell).
 */
import { AdminAuth, AdminAPI, icon, esc } from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { attachProductAutocomplete, productCostExGst, fetchProductCosts } from '../components/product-search.js';
import {
  costOrNull, computeInvoiceTotals, computeInvoiceCogs, computeInvoiceProfit,
  normalizeInvoice, invoiceDocRows,
} from '../utils/invoice-math.js';
import { marginBadge, formatProfitDollars } from '../utils/profitability.js';

const GST_RATE = 0.15;

// Supplier cost is an owner-only figure. The route itself is already owner-gated
// (app.js ownerPages), but gate the field too — cheap, and it keeps the intent
// legible next to the input that must never be printed.
//
// NB AdminAuth is an ES-module export, NOT a global. This used to be written as
// `typeof AdminAuth !== 'undefined' ? … : false` without importing it — so it
// silently evaluated to false and the entire "Our Cost" column never rendered for
// anyone. A defensive typeof guard around a missing import doesn't harden the
// feature, it deletes it. Import the thing and let it throw if it's absent.
const canSeeCost = () => AdminAuth.isOwner();

// ---- small helpers ------------------------------------------------------
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const money = (n) => (typeof window.formatPrice === 'function' ? window.formatPrice(Number(n) || 0) : '$' + (Number(n) || 0).toFixed(2));
const num = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const warn = (m, e) => window.DebugLog?.warn?.(`[Invoices] ${m}`, e?.message || e);

function todayInputValue() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function ordinal(d) {
  const v = d % 100;
  if (v >= 11 && v <= 13) return d + 'th';
  switch (d % 10) { case 1: return d + 'st'; case 2: return d + 'nd'; case 3: return d + 'rd'; default: return d + 'th'; }
}
// "2026-06-25" -> "25th June 2026" (matches the exemplar). Falls back to the
// raw string if it isn't a parseable Y-M-D.
function formatInvoiceDate(iso) {
  const parts = String(iso || '').split('-');
  if (parts.length !== 3) return iso || '';
  const y = +parts[0], m = +parts[1] - 1, d = +parts[2];
  if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return iso;
  return `${ordinal(d)} ${MONTHS[m]} ${y}`;
}
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const joinLines = (a) => (Array.isArray(a) ? a.filter(Boolean).join('\n') : (a || ''));

// "2026-03-23" -> "23rd March" (no year) for the email sentence. '' if unparseable.
function orderDateShort(iso) {
  const parts = String(iso || '').split('-');
  if (parts.length !== 3) return '';
  const m = +parts[1] - 1, d = +parts[2];
  if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return '';
  return `${ordinal(d)} ${MONTHS[m]}`;
}

// ---- "emailed" record ---------------------------------------------------
// The backend owns last_emailed_at / last_emailed_to / email_count. Until those
// fields ship, a successful send is recorded here so the list can still show a
// Sent marker. A local record is per-browser: it says a send was recorded on
// THIS machine, not that no send happened on another one.
const SENT_KEY = 'inv_emailed_v1';
const SENT_CAP = 200;

function readSentMap() {
  try {
    const m = JSON.parse(localStorage.getItem(SENT_KEY));
    return (m && typeof m === 'object') ? m : {};
  } catch { return {}; }
}

function writeSent(id, to) {
  if (!id) return;
  try {
    const map = readSentMap();
    map[id] = { at: new Date().toISOString(), to: to || '', count: (map[id]?.count || 0) + 1 };
    const keys = Object.keys(map);
    if (keys.length > SENT_CAP) {
      keys.sort((a, b) => String(map[a].at).localeCompare(String(map[b].at)))
        .slice(0, keys.length - SENT_CAP)
        .forEach((k) => { delete map[k]; });
    }
    localStorage.setItem(SENT_KEY, JSON.stringify(map));
  } catch (err) { warn('could not record the send locally', err); }
}

// Server wins when present, so the local cache retires itself the moment the
// backend starts returning last_emailed_at. null = never emailed, as far as we know.
function sentInfo(rec) {
  if (!rec) return null;
  if (rec.last_emailed_at) {
    return { at: rec.last_emailed_at, to: rec.last_emailed_to || '', count: num(rec.email_count) || 1 };
  }
  const local = readSentMap()[rec.id];
  return local?.at ? local : null;
}

const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
// ISO timestamp -> "8 Jul" for the Sent cell. '' if unparseable.
function sentShort(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
function sentTitle(info) {
  const who = info.to ? ` to ${info.to}` : '';
  const times = info.count > 1 ? ` · sent ${info.count} times` : '';
  return `Emailed${who} on ${formatInvoiceDate(String(info.at).slice(0, 10))}${times}`;
}

// The "Date order placed" line always shows on the invoice. Until the operator
// enters a date it displays a dashed placeholder with the current year pre-filled
// (the real date — including a different year — is set via the Order date field,
// which is required before the invoice can be saved/downloaded/emailed).
function orderPlacedDisplay(d) {
  if (d && d.order_date) return formatInvoiceDate(d.order_date);
  return `—/—/${new Date().getFullYear()}`;
}

// Number of days in month `m` (1-based) of year `y` — new Date(y, m, 0) is the
// last day of month m (day 0 of the next month). Used to clamp the term day.
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

// Payment terms: due a chosen day of the month AFTER the order was placed.
//   pref '10'|'20'|'30' -> that day (clamped to the month's length),
//   pref 'eom'          -> the last day of that month.
// Default term is the 20th. Any June date -> "2026-07-<day>". '' if unparseable.
function paymentDueDate(iso, pref = '20') {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return '';
  let y = +p[0], m = +p[1];               // m is 1..12
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return '';
  m += 1; if (m > 12) { m = 1; y += 1; }  // roll Dec -> Jan next year
  const last = daysInMonth(y, m);
  let day;
  if (pref === 'eom') day = last;
  else { day = parseInt(pref, 10); if (!day || day < 1) day = 20; day = Math.min(day, last); }
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// The due date shown/printed/saved: an explicit manual override wins, otherwise
// it is derived from the order date + the saved payment term.
function effectiveDueDate(d) {
  return d.payment_due || paymentDueDate(d.order_date, d.payment_due_pref);
}

// The due date to DISPLAY on the invoice — honours the "show payment due date"
// toggle. effectiveDueDate() still drives the resolved value saved to the backend.
// When off, both renderers fall through to the bare "Please make payment to:" line.
function displayDueDate(d) {
  return d.show_due_date === false ? '' : effectiveDueDate(d);
}

// Greeting name for the email — the person we address ("Hi Felix,"). Prefer the
// contact (Attn), fall back to the invoice-to name, then a neutral "there".
function firstName(d) {
  const src = (d.customer?.attn || '').trim() || (d.customer?.name || '').trim();
  const first = src.split(/\s+/)[0];
  return first || 'there';
}

// Default subject + message for the invoice email (operator can edit before send).
function emailDefaults(d) {
  const when = orderDateShort(d.order_date || d.date);
  const contact = (d.seller?.contact || '').trim() || 'Trevor Walker';
  const subject = `Your InkCartridges.co.nz invoice${d.invoice_number ? ' #' + d.invoice_number : ''}`;
  const body = [
    `Hi ${firstName(d)},`,
    `Thank you for your order${when ? ' on the ' + when : ''}. Please find your invoice attached.`,
    'Regards,',
    contact,
    'InkCartridges.co.nz',
  ].join('\n');
  return { subject, body };
}

// Internal-only states. Status is NEVER shown on the customer-facing invoice
// (preview/PDF) — operators track paid/unpaid here; void is a records-keeping
// state set by the Void row-action.
const STATUS_META = {
  unpaid: { label: 'Unpaid', cls: 'admin-badge--processing' },
  paid:   { label: 'Paid',   cls: 'admin-badge--delivered' },
  void:   { label: 'Void',   cls: 'admin-badge--cancelled' },
};

// ---- module state -------------------------------------------------------
let _container = null;
let _table = null;
let _filters = { search: '', status: '' };
let _page = 1;
let _limit = 20;
let _searchDebounce = null;

let _draft = null;        // the invoice currently in the editor
let _editorRefs = null;   // { drawer }
let _editorToken = 0;     // bumped each editor open/close — async destroy guard
let _fillSource = null;   // { type:'contact'|'customer'|'order', label } — drives the "filled from" chip
const editorAlive = (token) => token === _editorToken && _editorRefs != null;

// =========================================================================
//  Draft model
// =========================================================================
// unitCost      — ex-GST SELL price. PRINTED on the invoice (the "Cost (excl.
//                 GST)" column). Named from the customer's point of view.
// supplierCost  — ex-GST price WE paid. INTERNAL ONLY: never printed, never
//                 emailed. null = unknown (NOT 0 — a $0 cost would report a 100%
//                 margin). See costOrNull in utils/invoice-math.js.
// costSource    — 'auto'   = mirrored from products.cost_price by the picker
//                 'manual' = the operator typed over it; survives a re-pick of
//                            the same SKU.
const blankLine = () => ({ code: '', description: '', qty: 1, unitCost: 0, supplierCost: null, costSource: 'auto' });

function freshDraft() {
  const L = window.LegalConfig || {};
  const inv = L.invoice || {};
  const addr = (typeof L.formatAddressMultiLine === 'function') ? L.formatAddressMultiLine() : [];
  return {
    id: null,
    invoice_number: '',
    status: 'unpaid',
    date: todayInputValue(),
    order_date: '',           // blank + compulsory — operator must enter the real order date
    payment_due: '',          // blank = derive from order_date + term; set = manual override
    payment_due_pref: '20',   // '10'|'20'|'30'|'eom' — carried from the contact when filled
    show_due_date: true,      // false = hide the "Payment due by …" line on the invoice
    source_order_id: null,
    seller: {
      name: L.legalEntity || 'Office Consumables Ltd',
      gst: L.gstNumber || '',
      address: Array.isArray(addr) ? addr.join('\n') : '',
      phone: inv.phone || L.phoneDisplay || '',
      contact: inv.contactName || '',
    },
    customer: { attn: '', name: '', company: '', address: '', phone: '', email: '' },
    // Optional second address — where the physical goods are shipped when that
    // differs from the billing ("Invoice To") address. Rendered only when filled.
    delivery: { attn: '', company: '', address: '', phone: '' },
    lines: [blankLine()],
    freight: 0,
    footer: {
      bankName: inv.bankAcctName || L.legalEntity || '',
      bankAcct: inv.bankAcctNumber || '',
      thankYou: inv.thankYou || '',
    },
    notes: '',
  };
}

// Map a saved-invoice record (backend contract) back into the editor draft.
function draftFromInvoice(rec) {
  const d = freshDraft();
  d.id = rec.id ?? null;
  d.invoice_number = rec.invoice_number ?? '';
  d.status = rec.status ?? 'unpaid';
  d.date = (rec.issue_date || rec.date || '').slice(0, 10) || d.date;
  d.order_date = (rec.order_date || '').slice(0, 10) || d.order_date;
  d.payment_due = (rec.payment_due || '').slice(0, 10) || '';
  d.payment_due_pref = rec.payment_due_pref || '20';
  d.show_due_date = rec.show_due_date !== false;   // absent/true => keep showing the due date
  d.source_order_id = rec.source_order_id ?? null;
  // Server-owned send history — read-only, deliberately absent from buildPayload().
  d.last_emailed_at = rec.last_emailed_at ?? null;
  d.last_emailed_to = rec.last_emailed_to ?? null;
  d.email_count = rec.email_count ?? 0;
  if (rec.seller) d.seller = { ...d.seller, ...rec.seller, address: Array.isArray(rec.seller.address) ? rec.seller.address.join('\n') : (rec.seller.address ?? d.seller.address) };
  if (rec.customer) d.customer = { ...d.customer, ...rec.customer, address: Array.isArray(rec.customer.address) ? rec.customer.address.join('\n') : (rec.customer.address ?? '') };
  if (rec.delivery) d.delivery = { ...d.delivery, ...rec.delivery, address: Array.isArray(rec.delivery.address) ? rec.delivery.address.join('\n') : (rec.delivery.address ?? '') };
  const items = rec.line_items || rec.lines || [];
  d.lines = items.length ? items.map((l) => ({
    code: l.product_code ?? l.code ?? '',
    description: l.description ?? '',
    qty: num(l.quantity ?? l.qty ?? 1),
    unitCost: num(l.unit_cost_excl_gst ?? l.unitCost ?? 0),
    // Absent (backend hasn't shipped the column yet) => unknown, not 0.
    supplierCost: costOrNull(l.supplier_cost_excl_gst ?? l.supplierCost),
    costSource: l.cost_source || l.costSource || 'auto',
  })) : [blankLine()];
  d.freight = num(rec.freight_excl_gst ?? rec.freight ?? 0);
  if (rec.footer) d.footer = { ...d.footer, ...rec.footer };
  d.notes = rec.notes ?? '';
  return d;
}

// Delegates to utils/invoice-math.js so the editor, the analytics overlay and
// the tests can never disagree about what an invoice is worth.
const computeTotals = (d) => computeInvoiceTotals(d);

// A line counts only if it has a product code or description. A content-less
// default row (just qty=1) is dropped so we never POST a phantom blank line —
// the backend would otherwise accept it and create a $0 line.
const realLines = (d) => (d.lines || []).filter((l) => (l.code || '').trim() || (l.description || '').trim());

// The optional "Deliver to" block is only surfaced (preview/PDF) when the operator
// actually entered something in it.
const hasDelivery = (d) => !!(d.delivery
  && ((d.delivery.attn || '').trim() || (d.delivery.company || '').trim()
    || (d.delivery.phone || '').trim() || lines(d.delivery.address).length));

// Shared layout data so the live preview and the client PDF render identically.
// The header meta (right side of the title band): label/value pairs.
function invoiceMeta(d) {
  const rows = [['Invoice No', d.invoice_number || '—'], ['Date', formatInvoiceDate(d.date)]];
  rows.push(['Date order placed', orderPlacedDisplay(d)]);
  if (d.seller.gst) rows.push(['GST No', d.seller.gst]);
  // NB: paid/unpaid status is deliberately NOT rendered on the customer-facing
  // invoice — it's an internal field only (see the list's Paid toggle).
  return rows;
}

// The aligned party columns: From (seller), Bill To (customer), Deliver To (optional).
function invoiceParties(d) {
  const out = [];

  const fromLines = [...lines(d.seller.address)];
  if (d.seller.phone) fromLines.push(`Ph: ${d.seller.phone}`);
  if (d.seller.contact) fromLines.push(`Contact: ${d.seller.contact}`);
  out.push({ label: 'From', name: d.seller.name || '', lines: fromLines });

  const billLines = [];
  if (d.customer.company) billLines.push(d.customer.company);
  if (d.customer.attn) billLines.push(`Attn: ${d.customer.attn}`);
  billLines.push(...lines(d.customer.address));
  if (d.customer.phone) billLines.push(d.customer.phone);
  if (d.customer.email) billLines.push(d.customer.email);
  out.push({ label: 'Bill To', name: d.customer.name || '', lines: billLines });

  if (hasDelivery(d)) {
    const addr = lines(d.delivery.address);
    const useAddrAsName = !d.delivery.company && !d.delivery.attn;
    const name = d.delivery.company || d.delivery.attn || addr[0] || '';
    const dl = [];
    if (d.delivery.company && d.delivery.attn) dl.push(`Attn: ${d.delivery.attn}`);
    dl.push(...(useAddrAsName ? addr.slice(1) : addr));
    if (d.delivery.phone) dl.push(`Ph: ${d.delivery.phone}`);
    out.push({ label: 'Deliver To', name, lines: dl });
  }
  return out;
}

function buildPayload(d) {
  return {
    invoice_number: d.invoice_number || null,   // null => backend assigns next in series
    status: d.status,
    issue_date: d.date,
    order_date: d.order_date || null,
    // Resolved due date (override or derived). Sent as null when the operator has
    // hidden the due-date line so a server-rendered PDF omits it too.
    payment_due: d.show_due_date === false ? null : (effectiveDueDate(d) || null),
    payment_due_pref: d.payment_due_pref || null,
    show_due_date: d.show_due_date !== false,
    source_order_id: d.source_order_id || null,
    seller: { ...d.seller, address: lines(d.seller.address) },
    customer: { ...d.customer, address: lines(d.customer.address) },
    // Sent only when filled; backend ignores unknown keys (cf. preview_totals) until
    // it persists/renders this on the server-side PDF.
    delivery: hasDelivery(d) ? { ...d.delivery, address: lines(d.delivery.address) } : null,
    line_items: realLines(d).map((l) => ({
      product_code: l.code,
      description: l.description,
      quantity: num(l.qty),
      unit_cost_excl_gst: round2(num(l.unitCost)),          // SELL price — printed on the invoice
      // OUR cost — internal, never printed. null tells the backend to snapshot
      // products.cost_price itself at save time, so COGS stays right even when
      // the client never saw a cost.
      supplier_cost_excl_gst: costOrNull(l.supplierCost),
      cost_source: l.costSource || 'auto',
    })),
    freight_excl_gst: round2(num(d.freight)),
    footer: d.footer,
    notes: d.notes,
    // Client preview only — backend recomputes authoritatively and ignores these.
    preview_totals: computeTotals(d),
  };
}

// =========================================================================
//  Page lifecycle
// =========================================================================
export default {
  title: 'Invoices',

  async init(container) {
    _container = container;
    _page = 1;
    container.innerHTML = `
      <div class="admin-page-content">
        <div class="admin-page-header">
          <div>
            <h1>Invoices</h1>
            <p style="margin:4px 0 0;color:var(--text-muted);font-size:13px">Create, save and download invoices. Build from scratch or auto-fill from an existing order.</p>
          </div>
          <div class="admin-page-header__actions">
            <button class="admin-btn admin-btn--primary" id="inv-new">${icon('plus', 14, 14)} New Invoice</button>
          </div>
        </div>
        <div class="admin-filters" style="display:flex;gap:var(--spacing-2);margin-bottom:var(--spacing-3);flex-wrap:wrap">
          <div class="admin-search" style="flex:1;min-width:240px">
            <span class="admin-search__icon">${icon('search', 14, 14)}</span>
            <input class="admin-input" id="inv-search" type="search" placeholder="Search invoice #, customer, email…" autocomplete="off" style="width:100%;padding-left:32px">
          </div>
          <select class="admin-select" id="inv-status" style="min-width:150px">
            <option value="">All invoices</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Unpaid</option>
            <option value="void">Void</option>
          </select>
        </div>
        <div id="inv-table"></div>
      </div>
    `;

    _table = new DataTable(container.querySelector('#inv-table'), {
      columns: COLUMNS.filter((c) => !c.ownerOnly || canSeeCost()),
      rowKey: 'id',
      emptyMessage: 'No invoices yet',
      emptyIcon: icon('invoice', 28, 28),
      onRowClick: (row) => openExisting(row),
      onSort: (key, dir) => { _filters.sort = key; _filters.order = dir; loadData(); },
      onPageChange: (p) => { _page = p; loadData(); },
      onLimitChange: (l) => { _limit = l; _page = 1; loadData(); },
    });

    container.querySelector('#inv-new').addEventListener('click', () => openEditor(freshDraft()));
    container.querySelector('#inv-search').addEventListener('input', (e) => {
      clearTimeout(_searchDebounce);
      const v = e.target.value;
      _searchDebounce = setTimeout(() => { _filters.search = v.trim(); _page = 1; loadData(); }, 300);
    });
    container.querySelector('#inv-status').addEventListener('change', (e) => {
      _filters.status = e.target.value; _page = 1; loadData();
    });
    // Row action buttons are delegated (they live inside DataTable cells).
    container.querySelector('#inv-table').addEventListener('click', onRowAction);

    await loadData();

    // Quick Order → Invoice bridge: if a quick order staged a prefill, open a new
    // invoice editor pre-filled with its caller + product lines, then clear it so
    // a manual revisit to #invoices starts blank.
    maybeOpenFromQuickOrder();
  },

  destroy() {
    clearTimeout(_searchDebounce);
    _editorToken++;            // invalidate any in-flight editor async work
    if (Drawer.isOpen()) Drawer.close();
    _table?.destroy?.();
    _table = null;
    _container = null;
    _draft = null;
    _editorRefs = null;
    _fillSource = null;
  },
};

const COLUMNS = [
  { key: 'invoice_number', label: 'Invoice #', sortable: true, render: (r) => `<span class="cell-mono"><strong>${esc(r.invoice_number || '—')}</strong></span>` },
  { key: 'issue_date', label: 'Date', sortable: true, render: (r) => esc(formatInvoiceDate((r.issue_date || r.date || '').slice(0, 10))) },
  { key: 'customer', label: 'Customer', render: (r) => esc(r.customer_name || r.customer?.name || '—') },
  { key: 'total', label: 'Total (incl GST)', align: 'right', sortable: true, render: (r) => money(r.total_incl_gst ?? r.total ?? 0) },
  {
    key: 'profit', label: 'Profit', align: 'right', ownerOnly: true,
    // Internal. Renders "—" whenever any line's cost is unknown — including the
    // whole period before the backend persists supplier_cost_excl_gst at all, when
    // every saved invoice will read as unknown. That is the honest answer, not a bug.
    render: (r) => {
      const n = normalizeInvoice(r);
      if (r.status === 'void' || !n.allCostsKnown || n.profit == null) {
        return `<span class="inv-profit__none" title="Cost of goods not recorded on this invoice">—</span>`;
      }
      const pct = n.revenueExGst > 0 ? (n.profit / n.revenueExGst) * 100 : null;
      return `<span class="inv-profit" title="Ex-GST revenue minus ex-GST cost. Bank transfer, so no card fee.">${esc(formatProfitDollars(n.profit))} ${marginBadge(pct)}</span>`;
    },
  },
  {
    key: 'paid', label: 'Paid', align: 'center',
    // Voided invoices are kept for records — show a muted label, no toggle.
    // Otherwise an inline switch. The <input> is the full-size top layer of
    // .inv-paid, so the click target is always an <input> — DataTable's
    // row-click guard (button,a,input) ignores it and the editor never opens.
    render: (r) => r.status === 'void'
      ? `<span class="inv-paid__void">Void</span>`
      : `<span class="inv-paid" title="${r.status === 'paid' ? 'Paid — click to mark unpaid' : 'Unpaid — click to mark paid'}">
           <input type="checkbox" data-row-action="toggle-paid" data-id="${escA(r.id)}"${r.status === 'paid' ? ' checked' : ''} aria-label="Mark paid">
           <span class="inv-paid__slider"></span>
         </span>`,
  },
  {
    key: 'sent', label: 'Sent', align: 'center',
    // Has the PDF been emailed to the customer? Voided invoices are not special-cased —
    // a void invoice may well have gone out before it was voided.
    render: (r) => {
      const info = sentInfo(r);
      return info
        ? `<span class="inv-sent" title="${escA(sentTitle(info))}">${icon('check', 13, 13)}${esc(sentShort(info.at))}</span>`
        : `<span class="inv-sent__none" title="Not emailed yet">—</span>`;
    },
  },
  {
    key: 'actions', label: '', align: 'right',
    render: (r) => `
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="download" data-id="${escA(r.id)}" title="Download PDF">${icon('download', 13, 13)}</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="email" data-id="${escA(r.id)}" title="Email to customer">${icon('mail', 13, 13)}</button>
      ${r.status === 'void' ? '' : `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="void" data-id="${escA(r.id)}" title="Void">${icon('ban', 13, 13)}</button>`}
      <button class="admin-btn admin-btn--ghost admin-btn--sm" data-row-action="delete" data-id="${escA(r.id)}" data-num="${escA(r.invoice_number)}" title="Delete permanently">${icon('trash', 13, 13)}</button>`,
  },
];

async function loadData() {
  if (!_table) return;
  _table.setLoading(true);
  const data = await AdminAPI.listInvoices(_filters, _page, _limit);
  if (!_table) return; // destroyed mid-fetch
  const rows = data?.invoices || data?.items || (Array.isArray(data) ? data : []);
  const pagination = data?.pagination || (data?.total != null ? { total: data.total, page: _page, limit: _limit } : null);
  _table.setData(rows, pagination);
}

async function onRowAction(e) {
  const btn = e.target.closest('[data-row-action]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.id;
  const action = btn.dataset.rowAction;
  if (action === 'toggle-paid') {
    // The checkbox has already flipped by click time — read its new state.
    const paid = btn.checked;
    btn.disabled = true;
    try {
      await AdminAPI.markInvoicePaid(id, paid);
      Toast.success(paid ? 'Marked paid.' : 'Marked unpaid.');
      // Optimistic: the toggle already reflects the new state, no reload needed.
    } catch (err) {
      btn.checked = !paid;   // revert the optimistic flip
      Toast.error(err.code === 'NOT_FOUND'
        ? 'Mark-paid isn’t available yet (backend endpoint pending).'
        : (err.message || 'Could not update.'));
    } finally {
      btn.disabled = false;
    }
  } else if (action === 'download') {
    const rec = await AdminAPI.getInvoice(id);
    if (rec) downloadPdf(draftFromInvoice(rec));
    else Toast.error('Could not load invoice to download.');
  } else if (action === 'email') {
    // Pull the full record so the composer can prefill the customer name + order date.
    const rec = await AdminAPI.getInvoice(id);
    if (rec) openEmailDialog(draftFromInvoice(rec));
    else Toast.error('Could not load invoice to email.');
  } else if (action === 'void') {
    Modal.confirm({
      title: 'Void this invoice?',
      message: 'The invoice is kept for records but marked void.',
      confirmLabel: 'Void',
      confirmClass: 'admin-btn--danger',
      onConfirm: async () => {
        try { await AdminAPI.voidInvoice(id); Toast.success('Invoice voided.'); loadData(); }
        catch (err) { Toast.error(err.message || 'Void failed (backend pending).'); }
      },
    });
  } else if (action === 'delete') {
    const num = btn.dataset.num;
    Modal.confirm({
      title: 'Delete this invoice?',
      message: `Invoice #${num || ''} will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      confirmClass: 'admin-btn--danger',
      onConfirm: async () => {
        try { await AdminAPI.deleteInvoice(id); Toast.success('Invoice deleted.'); loadData(); }
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
  const rec = await AdminAPI.getInvoice(row.id) || row;
  const draft = draftFromInvoice(rec);
  await backfillCostsFromCatalogue(draft);
  openEditor(draft);
}

/**
 * Fill in any line cost the backend didn't give us, from the product catalogue.
 *
 * The backend accepts supplier_cost_excl_gst but does NOT echo it back on
 * GET /invoices/:id — it snapshots the cost onto the shadow order and leaves the
 * invoice line null. So without this, reopening a saved invoice shows an empty
 * "Our Cost" box even for a product whose cost we know, and the invoice's Profit
 * column is stuck on "—" forever.
 *
 * Rules:
 *   - Only fills lines that have NO cost. A manual override is never touched.
 *   - Only fills from a resolvable product_code. An unresolvable / free-text line
 *     stays UNKNOWN (null) — the operator types it, or it stays honest.
 *   - Marks what it fills as 'auto', because that's exactly what it is.
 *
 * Fail-soft: no Supabase, no catalogue hit, any error → costs simply stay unknown.
 */
async function backfillCostsFromCatalogue(d) {
  const need = (d.lines || []).filter(l => costOrNull(l.supplierCost) == null && (l.code || '').trim());
  if (!need.length) return;
  try {
    const costs = await fetchProductCosts(need.map(l => l.code));
    if (!costs.size) return;
    for (const l of need) {
      const c = costs.get((l.code || '').trim());
      if (c != null) { l.supplierCost = c; l.costSource = 'auto'; }
    }
  } catch (err) {
    warn('cost back-fill from catalogue failed', err);
  }
}

// Quick Order hands off a staged prefill via sessionStorage['qo_invoice_prefill']
// ({ order_date, customer{attn,name,company,address,phone,email}, lines[{code,
// description,qty,unitCost,supplierCost,costSource}] }). Consume it once and open
// a new invoice editor.
//
// Reads defensively: a prefill staged by the PREVIOUS build can still be sitting
// in a user's sessionStorage across a deploy, and it has no cost fields. Absent
// cost => unknown (null), never 0.
function maybeOpenFromQuickOrder() {
  let raw;
  try { raw = sessionStorage.getItem('qo_invoice_prefill'); } catch (_) { return; }
  if (!raw) return;
  try { sessionStorage.removeItem('qo_invoice_prefill'); } catch (_) { /* noop */ }
  let pre;
  try { pre = JSON.parse(raw); } catch (e) { warn('bad quick-order prefill', e); return; }
  if (!pre || typeof pre !== 'object') return;
  const d = freshDraft();
  if (pre.order_date) d.order_date = String(pre.order_date).slice(0, 10);
  if (pre.customer) d.customer = { ...d.customer, ...pre.customer };
  if (Array.isArray(pre.lines) && pre.lines.length) {
    d.lines = pre.lines.map((l) => ({
      code: l.code || '', description: l.description || '', qty: num(l.qty ?? 1), unitCost: round2(num(l.unitCost ?? 0)),
      supplierCost: costOrNull(l.supplierCost),
      costSource: l.costSource || 'auto',
    }));
  }
  openEditor(d);
}

// =========================================================================
//  Editor (Drawer)
// =========================================================================
function openEditor(draft) {
  _draft = draft;
  _fillSource = null;
  const token = ++_editorToken;
  const footer = `
    <span class="inv-sent-hint" id="inv-sent-hint">${sentHintHtml(draft)}</span>
    <button class="admin-btn admin-btn--ghost" data-ed-action="cancel">Cancel</button>
    <button class="admin-btn admin-btn--ghost" data-ed-action="download">${icon('download', 14, 14)} Download PDF</button>
    <button class="admin-btn admin-btn--ghost" data-ed-action="email">${icon('mail', 14, 14)} Email</button>
    <button class="admin-btn admin-btn--primary" data-ed-action="save">Save invoice</button>`;

  const drawer = Drawer.open({
    title: draft.id ? `Invoice ${draft.invoice_number || ''}`.trim() : 'New Invoice',
    width: 'min(1180px, 96vw)',
    body: editorBodyHtml(draft),
    footer,
    onClose: () => { if (token === _editorToken) { _editorToken++; _draft = null; _editorRefs = null; } },
  });
  if (!drawer) return;
  _editorRefs = { drawer };

  drawer.footer.addEventListener('click', onEditorFooterClick);
  bindEditorBody(drawer);

  // Suggest the next number for a brand-new invoice — auto-filled but editable.
  // Best-effort: if the lookup fails or the operator already typed one, leave it.
  if (!draft.id && !draft.invoice_number) prefillNextNumber(token);
}

// "Last emailed 8th July 2026 to itc@mcgrath.co.nz" — '' for a draft that has
// never been sent (or has never been saved, so it has no id to look up).
function sentHintHtml(d) {
  const info = (d && d.id) ? sentInfo(d) : null;
  if (!info) return '';
  const who = info.to ? ` to ${info.to}` : '';
  return esc(`Last emailed ${formatInvoiceDate(String(info.at).slice(0, 10))}${who}`);
}

// The drawer footer is built once in openEditor() and survives rebuildEditor(),
// so the hint is patched in place after a send.
function refreshSentHint() {
  const el = _editorRefs?.drawer.footer.querySelector('#inv-sent-hint');
  if (el) el.innerHTML = sentHintHtml(_draft);
}

async function prefillNextNumber(token) {
  const next = await AdminAPI.nextInvoiceNumber();
  if (next == null || !editorAlive(token)) return;
  if (_draft.invoice_number) return;   // operator typed one while we were fetching
  _draft.invoice_number = String(next);
  const input = _editorRefs?.drawer.body.querySelector('[data-field="invoice_number"]');
  if (input) input.value = _draft.invoice_number;
  refreshPreview();   // preview header shows the suggested number
}

function bindEditorBody(drawer) {
  const form = drawer.body.querySelector('.invoice-editor__form');
  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('click', onFormClick);
  renderLines();
  attachTopAutocompletes();
  refreshPreview();
}

// Replace the body in-place (used after an auto-fill that touches many fields).
function rebuildEditor() {
  if (!_editorRefs) return;
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
  if (t.dataset.field) {
    setPath(_draft, t.dataset.field, t.type === 'checkbox' ? t.checked : t.value);
    // Keep the (non-overridden) due date live as the order date changes.
    if (t.dataset.field === 'order_date' && !_draft.payment_due) {
      const due = _editorRefs.drawer?.body?.querySelector('#inv-due-date');
      if (due) due.value = paymentDueDate(_draft.order_date, _draft.payment_due_pref) || '';
    }
  } else if (t.dataset.line != null && t.dataset.lfield) {
    const i = +t.dataset.line;
    const f = t.dataset.lfield;
    if (_draft.lines[i]) {
      _draft.lines[i][f] = t.value;
      // Typing a cost promotes the line to a manual override; clearing the box
      // hands it back to auto (and back to "unknown" until a product is picked).
      // NB t.value is the raw string — costOrNull downstream is what turns '' into
      // null rather than the 0 that Number('') would give us.
      if (f === 'supplierCost') _draft.lines[i].costSource = t.value === '' ? 'auto' : 'manual';
    }
  } else { return; }
  // Clear the error highlight on the field as soon as the user edits it.
  t.classList.remove('admin-input--error', 'admin-select--error');
  t.closest('.inv-field')?.classList.remove('inv-field--error');
  refreshPreview();
}

function onFormClick(e) {
  const act = e.target.closest('[data-form-action]')?.dataset.formAction;
  if (!act) return;
  if (act === 'add-line') { _draft.lines.push(blankLine()); renderLines(); refreshPreview(); }
  else if (act === 'remove-line') {
    const i = +e.target.closest('[data-line]').dataset.line;
    _draft.lines.splice(i, 1);
    if (!_draft.lines.length) _draft.lines.push(blankLine());
    renderLines(); refreshPreview();
  } else if (act === 'clear-fill') {
    // Undo an auto-fill: blank the billing + delivery parties and drop the source link.
    _draft.customer = { attn: '', name: '', company: '', address: '', phone: '', email: '' };
    _draft.delivery = { attn: '', company: '', address: '', phone: '' };
    _draft.source_order_id = null;
    _fillSource = null;
    rebuildEditor();
  }
}

async function onEditorFooterClick(e) {
  const act = e.target.closest('[data-ed-action]')?.dataset.edAction;
  if (!act) return;
  if (act === 'cancel') { Drawer.close(); return; }
  if (act === 'download') { downloadPdf(_draft); return; }
  if (act === 'save') { await saveInvoice(); return; }
  if (act === 'email') {
    // Need a saved invoice (id + assigned number) before we can email its PDF.
    if (!_draft.id) {
      if (!ensureInvoiceValid()) return;
      const btn = e.target.closest('[data-ed-action="email"]');
      if (btn) btn.disabled = true;
      try { await persistDraft(); rebuildEditor(); loadData(); }
      catch (err) { Toast.error(err.message || 'Save the invoice before emailing it.'); return; }
      finally { if (btn) btn.disabled = false; }
      if (!_draft.id) return;   // save didn't produce an id
    }
    openEmailDialog(_draft);
  }
}

// Editable email composer — prefilled to match the exemplar; the operator can
// tweak the subject/message before it goes out. Sends { subject, body } to the
// backend, which attaches the stored invoice PDF.
function openEmailDialog(d) {
  const { subject, body } = emailDefaults(d);
  const modal = Modal.open({
    title: `Email invoice ${d.invoice_number || ''}`.trim(),
    className: 'admin-modal--invoice-email',
    body: `
      <label class="inv-field"><span class="inv-field__label">To</span>
        <input class="admin-input" id="inv-email-to" type="email" value="${escA(d.customer?.email || '')}" placeholder="customer@example.com"></label>
      <label class="inv-field" style="margin-top:12px"><span class="inv-field__label">Subject</span>
        <input class="admin-input" id="inv-email-subject" type="text" value="${escA(subject)}"></label>
      <label class="inv-field" style="margin-top:12px"><span class="inv-field__label">Message</span>
        <textarea class="admin-input inv-textarea" id="inv-email-body" rows="7">${esc(body)}</textarea></label>
      <p class="inv-field__hint" style="margin:8px 0 0">The invoice PDF is attached automatically.</p>`,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="send">${icon('mail', 14, 14)} Send email</button>`,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="send"]').addEventListener('click', async () => {
    const to = modal.body.querySelector('#inv-email-to').value.trim();
    const subj = modal.body.querySelector('#inv-email-subject').value.trim();
    const msg = modal.body.querySelector('#inv-email-body').value;
    if (!to) { Toast.warning('Enter a recipient email address.'); return; }
    const sendBtn = modal.footer.querySelector('[data-action="send"]');
    sendBtn.disabled = true;
    try {
      await AdminAPI.emailInvoice(d.id, { to, subject: subj, body: msg });
      writeSent(d.id, to);          // only on success — a failed send leaves the row unmarked
      Toast.success('Invoice emailed to customer.');
      Modal.close();
      refreshSentHint();            // editor footer, when the drawer is open behind the modal
      if (_table) loadData();       // repaint the Sent cell (picks up the server value once it ships)
    } catch (err) {
      Toast.error(err.message || 'Email failed (backend pending).');
      sendBtn.disabled = false;
    }
  });
}

// Required-field validation. Returns an array of error targets (empty = valid):
//   { field: 'customer.name', msg }        — a top-level/nested data-field input
//   { line: i, lfield: 'qty', msg }         — a line-item input
// Essentials only: a customer name + at least one *complete* line item (code or
// description, AND qty > 0, AND unit cost > 0). Fully-blank phantom rows are ignored.
function validateInvoice(d) {
  const errs = [];
  if (!d) return errs;
  if (!(d.customer.name || '').trim())
    errs.push({ field: 'customer.name', msg: 'Customer name is required' });
  if (!lines(d.customer.address).length)
    errs.push({ field: 'customer.address', msg: 'Bill To address is required' });
  if (!(d.order_date || '').trim())
    errs.push({ field: 'order_date', msg: 'Date order placed is required' });

  const started = (d.lines || [])
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (l.code || '').trim() || (l.description || '').trim()
      || num(l.qty) > 0 || num(l.unitCost) > 0);   // ignore fully-blank phantom rows

  if (!started.length) {
    errs.push({ line: 0, lfield: 'code', msg: 'Add at least one line item' });
  } else {
    started.forEach(({ l, i }) => {
      if (!((l.code || '').trim() || (l.description || '').trim()))
        errs.push({ line: i, lfield: 'code', msg: `Line ${i + 1}: code or description required` });
      if (!(num(l.qty) > 0))      errs.push({ line: i, lfield: 'qty',      msg: `Line ${i + 1}: quantity required` });
      if (!(num(l.unitCost) > 0)) errs.push({ line: i, lfield: 'unitCost', msg: `Line ${i + 1}: unit cost required` });
    });
  }
  return errs;
}

function clearInvoiceErrors() {
  const body = _editorRefs?.drawer.body;
  if (!body) return;
  body.querySelectorAll('.admin-input--error, .admin-select--error')
    .forEach((el) => el.classList.remove('admin-input--error', 'admin-select--error'));
  body.querySelectorAll('.inv-field--error')
    .forEach((el) => el.classList.remove('inv-field--error'));
}

function markInvoiceErrors(errs) {
  const body = _editorRefs?.drawer.body;
  if (!body) return null;
  let first = null;
  errs.forEach((e) => {
    const sel = e.field
      ? `[data-field="${e.field}"]`
      : `[data-line="${e.line}"][data-lfield="${e.lfield}"]`;
    const el = body.querySelector(sel);
    if (!el) return;
    el.classList.add(el.tagName === 'SELECT' ? 'admin-select--error' : 'admin-input--error');
    el.closest('.inv-field')?.classList.add('inv-field--error');   // line inputs have no .inv-field — no-op
    if (!first) first = el;
  });
  return first;
}

// Validate, paint the offending fields, scroll/focus the first. Returns true when OK.
function ensureInvoiceValid() {
  clearInvoiceErrors();
  const errs = validateInvoice(_draft);
  if (!errs.length) return true;
  const first = markInvoiceErrors(errs);
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.focus({ preventScroll: true });
  }
  Toast.warning(errs.length === 1 ? errs[0].msg
    : `Please complete the highlighted fields (${errs.length}).`);
  return false;
}

// Persist the current draft to the backend (create or update). Updates _draft with
// the server-assigned id + invoice_number. Returns the saved record (or null).
// Does NOT close the drawer — callers decide. Throws on API error.
// Map the backend's authoritative totals (whatever field names it returns) onto the
// {subtotal, freight, gst, total} shape; null if none recognised — in which case the
// PDF falls back to the client computeTotals (same GST math, so they agree).
function serverTotals(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const pick = (...keys) => { for (const k of keys) { if (rec[k] != null) return num(rec[k]); } return null; };
  const subtotal = pick('subtotal_excl_gst', 'subtotal', 'sub_total');
  const gst = pick('gst_amount', 'gst', 'tax_amount');
  const total = pick('total_incl_gst', 'total', 'grand_total');
  const freight = pick('freight_excl_gst', 'freight', 'shipping_excl_gst');
  if (subtotal == null && total == null) return null;
  return { subtotal: subtotal ?? 0, freight: freight ?? 0, gst: gst ?? 0, total: total ?? 0 };
}

// Upload the freshly-rendered PDF so the backend's stored copy (served by GET /:id/pdf
// and attached to customer emails) matches the frontend layout 1:1. Best-effort: a
// missing endpoint (404) or any error is logged, never surfaced — the save succeeded.
async function syncStoredPdf() {
  if (!_draft?.id) return;
  const doc = buildInvoiceDoc(_draft);
  if (!doc) return;   // jsPDF not loaded
  const base64 = (doc.output('datauristring').split(',')[1]) || '';
  await AdminAPI.uploadInvoicePdf(_draft.id, base64, `Invoice-${_draft.invoice_number || _draft.id}.pdf`);
}

async function persistDraft() {
  const payload = buildPayload(_draft);
  const saved = _draft.id
    ? await AdminAPI.updateInvoice(_draft.id, payload)
    : await AdminAPI.createInvoice(payload);
  if (saved) {
    _draft.id = saved.id ?? _draft.id;
    if (saved.invoice_number) _draft.invoice_number = saved.invoice_number;
    const st = serverTotals(saved);
    if (st) _draft._serverTotals = st;
    // Push the rendered PDF up so the backend serves/emails the same document.
    try { await syncStoredPdf(); }
    catch (err) { warn('stored-PDF sync skipped (backend endpoint pending?)', err); }
  }
  return saved;
}

async function saveInvoice() {
  // Block the save until all essentials are filled; highlight what's missing.
  if (!ensureInvoiceValid()) return;
  const btn = _editorRefs?.drawer.footer.querySelector('[data-ed-action="save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const saved = await persistDraft();
    if (saved) {
      Toast.success(`Invoice ${_draft.invoice_number || ''} saved.`.replace('  ', ' '));
      Drawer.close();
      loadData();
    } else {
      Toast.error('Save returned no data.');
    }
  } catch (err) {
    warn('save failed', err);
    Toast.error(err.message || 'Could not save invoice — the invoicing backend may not be live yet.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save invoice'; }
  }
}

// =========================================================================
//  Editor markup
// =========================================================================
function field(label, path, value, opts = {}) {
  const type = opts.type || 'text';
  const ph = opts.placeholder ? ` placeholder="${escA(opts.placeholder)}"` : '';
  const cls = opts.acClass ? ` class="inv-ac"` : '';
  const inner = `<input class="admin-input" type="${type}" data-field="${path}" value="${escA(value)}"${ph}${opts.attrs || ''}>`;
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span>${opts.acClass ? `<div class="inv-ac">${inner}</div>` : inner}</label>`;
}
function areaField(label, path, value) {
  return `<label class="inv-field"><span class="inv-field__label">${esc(label)}</span><textarea class="admin-input inv-textarea" data-field="${path}" rows="3">${esc(value)}</textarea></label>`;
}

// "Filled from contact/customer/order X — clear" chip, shown after an auto-fill.
function fillChipHtml() {
  if (!_fillSource) return '<div id="inv-fill-chip"></div>';
  return `<div id="inv-fill-chip"><span class="inv-fill-chip">Filled from ${esc(_fillSource.type)}: <strong>${esc(_fillSource.label)}</strong>
    <button type="button" class="inv-fill-chip__clear" data-form-action="clear-fill" title="Clear the filled details" aria-label="Clear filled details">✕</button></span></div>`;
}

function editorBodyHtml(d) {
  const numberLine = `<label class="inv-field"><span class="inv-field__label">Invoice No <span class="inv-field__hint">(auto-filled — edit to override)</span></span>`
    + `<input class="admin-input" type="text" inputmode="numeric" data-field="invoice_number" value="${escA(d.invoice_number)}" placeholder="Auto"></label>`;

  return `
  <div class="invoice-editor">
    <div class="invoice-editor__form">

      <section class="inv-section inv-section--source">
        <div class="inv-section__title">Start from</div>
        <div class="inv-grid-2">
          <label class="inv-field"><span class="inv-field__label">Existing order</span>
            <div class="admin-ac"><input class="admin-input" id="inv-order-search" type="search" placeholder="Search order # / email to auto-fill…" autocomplete="off"></div>
          </label>
          <label class="inv-field"><span class="inv-field__label">Fill details from</span>
            <div class="admin-ac"><input class="admin-input" id="inv-party-search" type="search" placeholder="Search a contact or customer…" autocomplete="off"></div>
          </label>
        </div>
        ${fillChipHtml()}
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Invoice details</div>
        <div class="inv-grid-2">
          ${numberLine}
          ${field('Date', 'date', d.date, { type: 'date' })}
          <label class="inv-field"><span class="inv-field__label">Date order placed * <span class="inv-field__hint">(required — sets the payment due date)</span></span>
            <input class="admin-input" type="date" data-field="order_date" value="${escA(d.order_date)}" required></label>
          <label class="inv-field"><span class="inv-field__label">Payment due date <span class="inv-field__hint">(auto-filled from order date + terms — edit to override)</span></span>
            <input class="admin-input" type="date" id="inv-due-date" data-field="payment_due" value="${escA(effectiveDueDate(d))}"></label>
          <label class="inv-field"><span class="inv-field__label">Paid status <span class="inv-field__hint">(internal — not shown to the customer)</span></span>
            <select class="admin-select" data-field="status">
              ${['unpaid', 'paid'].map((s) => `<option value="${s}"${d.status === s ? ' selected' : ''}>${STATUS_META[s].label}</option>`).join('')}
            </select>
          </label>
          <label class="inv-field inv-field--check">
            <input type="checkbox" data-field="show_due_date"${d.show_due_date === false ? '' : ' checked'}>
            <span class="inv-field__label">Show payment due date <span class="inv-field__hint">(on the invoice — off leaves just “Please make payment to:”)</span></span>
          </label>
        </div>
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Invoice from (seller)</div>
        <div class="inv-grid-2">
          ${field('Business name', 'seller.name', d.seller.name)}
          ${field('GST number', 'seller.gst', d.seller.gst)}
          ${field('Phone', 'seller.phone', d.seller.phone)}
          ${field('Contact', 'seller.contact', d.seller.contact)}
        </div>
        ${areaField('Address (one line per row)', 'seller.address', d.seller.address)}
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Invoice to (customer)</div>
        <div class="inv-grid-2">
          ${field('Attn', 'customer.attn', d.customer.attn)}
          ${field('Invoice to (name)', 'customer.name', d.customer.name)}
          ${field('Company / line', 'customer.company', d.customer.company)}
          ${field('Phone', 'customer.phone', d.customer.phone)}
          ${field('Email', 'customer.email', d.customer.email, { type: 'email' })}
        </div>
        ${areaField('Address (one line per row)', 'customer.address', d.customer.address)}
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Deliver to (goods) — optional</div>
        <div class="inv-grid-2">
          ${field('Attn', 'delivery.attn', d.delivery.attn)}
          ${field('Company / line', 'delivery.company', d.delivery.company)}
        </div>
        ${areaField('Delivery address (leave blank to ship to the invoice address)', 'delivery.address', d.delivery.address)}
        ${field('Phone (delivery contact)', 'delivery.phone', d.delivery.phone, { placeholder: 'For the person receiving the goods' })}
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Line items</div>
        <div class="inv-lines-head${canSeeCost() ? '' : ' inv-line--nocost'}">
          <span>Product Code</span><span>Description</span><span>Number</span><span>Unit Price (excl. GST)</span>${canSeeCost() ? '<span>Our Cost (excl. GST)</span>' : ''}<span></span>
        </div>
        <div id="inv-lines"></div>
        ${canSeeCost() ? `<p class="inv-section__hint">“Our Cost” is internal — it auto-fills from the product’s cost price, can be typed over, and <strong>never appears on the invoice, the preview, the PDF or the customer’s email</strong>. It exists so invoiced sales carry a real COGS into your profit figures.</p>` : ''}
        <div id="inv-cogs"></div>
        <button class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="add-line">${icon('plus', 13, 13)} Add line</button>
        <label class="inv-field inv-field--freight"><span class="inv-field__label">Freight (excl. GST — 0 shows as “Free”)</span>
          <input class="admin-input" type="number" step="0.01" min="0" data-field="freight" value="${escA(d.freight)}">
        </label>
      </section>

      <section class="inv-section">
        <div class="inv-section__title">Payment footer</div>
        <div class="inv-grid-2">
          ${field('a/c Name', 'footer.bankName', d.footer.bankName)}
          ${field('a/c Number', 'footer.bankAcct', d.footer.bankAcct)}
        </div>
        ${areaField('Thank-you note', 'footer.thankYou', d.footer.thankYou)}
      </section>
    </div>

    <div class="invoice-editor__preview">
      <div class="inv-preview-note">Live preview — subtotal, GST &amp; total are confirmed by the server on save.</div>
      <div id="inv-preview"></div>
    </div>
  </div>`;
}

function renderLines() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-lines');
  if (!host) return;
  const showCost = canSeeCost();
  host.innerHTML = (_draft.lines || []).map((l, i) => {
    const manual = l.costSource === 'manual';
    // Empty value + "auto" placeholder is how "we don't know this cost" reads.
    const costCell = showCost ? `
      <input class="admin-input inv-line__cost${manual ? ' inv-line__cost--manual' : ''}"
             type="number" step="0.01" min="0" data-line="${i}" data-lfield="supplierCost"
             value="${escA(l.supplierCost ?? '')}" placeholder="auto"
             title="${manual ? 'Manual override' : 'Auto-filled from the product’s cost'} — internal only, never printed on the invoice">` : '';
    return `
    <div class="inv-line${showCost ? '' : ' inv-line--nocost'}" data-line="${i}">
      <div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="code" value="${escA(l.code)}" placeholder="SKU / code" autocomplete="off"></div>
      <div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="description" value="${escA(l.description)}" placeholder="Product description" autocomplete="off"></div>
      <input class="admin-input" type="number" step="1" min="0" data-line="${i}" data-lfield="qty" value="${escA(l.qty)}">
      <input class="admin-input" type="number" step="0.01" min="0" data-line="${i}" data-lfield="unitCost" value="${escA(l.unitCost)}">
      ${costCell}
      <button class="admin-btn admin-btn--ghost admin-btn--sm inv-line__rm" data-form-action="remove-line" title="Remove line">${icon('trash', 12, 12)}</button>
    </div>`;
  }).join('');
  // Product autocomplete (storefront-style, image dropdown) on both the code +
  // description inputs of every line.
  host.querySelectorAll('.inv-line').forEach((row) => {
    const i = +row.dataset.line;
    row.querySelectorAll('.inv-ac > input').forEach((input) => attachProductAutocomplete(input, {
      onPick: (p) => {
        // Blur the field FIRST so its pending `change` (carrying the typed query,
        // e.g. "lc") flushes now and can't clobber the picked product afterwards:
        // renderLines() below destroys the focused input, which would otherwise fire
        // that stale change and overwrite _draft.lines[i].code back to the query.
        input.blur();
        const prev = _draft.lines[i] || {};
        const sku = p.sku || '';
        const ex = p.retail_price != null ? round2(num(p.retail_price) / (1 + GST_RATE)) : num(p.sell_price ?? p.price ?? 0);
        // A manual cost override survives a re-pick of the SAME product (the
        // operator meant it). Picking a DIFFERENT product resets to that
        // product's own cost — the override was scoped to the old SKU, and
        // silently carrying it across would quietly misprice the new line.
        const keepManual = prev.costSource === 'manual'
          && costOrNull(prev.supplierCost) != null
          && prev.code === sku;
        _draft.lines[i] = {
          code: sku,
          description: p.name || p.product_name || '',
          qty: prev.qty || 1,
          unitCost: ex,
          supplierCost: keepManual ? prev.supplierCost : productCostExGst(p),
          costSource: keepManual ? 'manual' : 'auto',
        };
        renderLines(); refreshPreview();
      },
    }));
  });
  renderCogsPanel();
}

/**
 * Internal margin readout under the line items. Owner-only, on the FORM side of
 * the editor — deliberately not in the preview, which is what the customer sees.
 *
 * When any line's cost is unknown the figures would be a floor, not a fact, so
 * we print "—" and say how many lines are missing a cost rather than quietly
 * reporting an inflated margin.
 */
function renderCogsPanel() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-cogs');
  if (!host) return;
  if (!canSeeCost()) { host.innerHTML = ''; return; }
  const { costExGst, unknownLines, allKnown } = computeInvoiceCogs(_draft);
  const profit = computeInvoiceProfit(_draft);
  const t = computeTotals(_draft);
  const marginPct = (profit != null && t.subtotal > 0) ? (profit / t.subtotal) * 100 : null;
  if (!allKnown) {
    const n = unknownLines;
    host.innerHTML = `<div class="inv-cogs inv-cogs--unknown">
      <span class="inv-cogs__label">Internal margin</span>
      <span class="inv-cogs__val">—</span>
      <span class="inv-cogs__note">${n ? `${n} line${n === 1 ? '' : 's'} missing a cost` : 'add a line item'}</span>
    </div>`;
    return;
  }
  host.innerHTML = `<div class="inv-cogs">
    <span class="inv-cogs__label">Internal margin</span>
    <span class="inv-cogs__val">Cost of goods ${esc(money(costExGst))} · Gross profit ${esc(formatProfitDollars(profit))}</span>
    ${marginBadge(marginPct)}
    <span class="inv-cogs__note">Bank transfer — no card fee. Never shown to the customer.</span>
  </div>`;
}

function attachTopAutocompletes() {
  const body = _editorRefs?.drawer.body;
  if (!body) return;
  const orderInput = body.querySelector('#inv-order-search');
  if (orderInput) attachAutocomplete(orderInput, {
    fetch: async (q) => {
      const data = await AdminAPI.getOrders({ search: q }, 1, 8);
      return data?.orders || data?.items || [];
    },
    render: (o) => `<span class="admin-ac__code">${esc(o.order_number || o.id || '')}</span> ${esc(o.customer_name || o.customer_email || '')} <span class="admin-ac__meta">· ${money(o.total_amount ?? o.total ?? 0)}</span>`,
    onPick: (o) => loadFromOrder(o.id || o.order_id),
  });
  // Unified "Fill details from…" picker — Contacts first, then Customers, in one
  // sectioned dropdown (mirrors the storefront Compatible/Genuine split).
  const partyInput = body.querySelector('#inv-party-search');
  if (partyInput) attachAutocomplete(partyInput, {
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
    onPick: (it) => { if (it.__type === 'contact') loadFromContact(it); else loadFromCustomer(it); },
  });
}

// ---- auto-fill sources --------------------------------------------------
async function loadFromOrder(orderId) {
  if (!orderId) return;
  const token = _editorToken;
  const [order, breakdown] = await Promise.all([AdminAPI.getOrder(orderId), AdminAPI.getOrderBreakdown(orderId)]);
  if (!editorAlive(token)) return;
  if (!order) { Toast.error('Could not load that order.'); return; }

  const addr = order.shipping_address || {};
  _draft.source_order_id = order.id || orderId;
  // Order date reflects when the order was actually placed (used in the email line).
  _draft.order_date = (order.created_at || order.placed_at || '').slice(0, 10) || _draft.order_date;
  _draft.customer = {
    attn: order.customer_name || addr.recipient_name || '',
    name: order.customer_name || addr.recipient_name || '',
    company: '',
    address: [addr.address_line1 || order.shipping_address_line1, addr.address_line2 || order.shipping_address_line2,
      [(addr.city || order.shipping_city || ''), (addr.region || order.shipping_region || ''), (addr.postal_code || order.shipping_postal_code || '')].filter(Boolean).join(', '),
      addr.country || order.shipping_country || ''].filter(Boolean).join('\n'),
    phone: addr.phone || order.shipping_phone || '',
    email: order.customer_email || order.guest_email || '',
  };
  _draft.lines = (order.items || []).map((it) => ({
    code: it.sku || '',
    description: it.product_name || it.name || it.description || '',
    qty: num(it.qty ?? it.quantity ?? 1),
    unitCost: round2(num(it.sell_price ?? it.unit_price ?? it.price ?? 0)),
    // The order already carries the cost we actually paid at the time it shipped.
    // Reuse that snapshot rather than re-deriving from today's products.cost_price
    // — the supplier's price may have moved since.
    supplierCost: costOrNull(it.supplier_cost_snapshot ?? it.cost_price),
    costSource: 'auto',
  }));
  if (!_draft.lines.length) _draft.lines = [blankLine()];
  // Order shipping_fee is GST-INCLUSIVE — convert to ex-GST for the freight field.
  const shipIncl = num(breakdown?.shipping_fee ?? order.shipping_fee ?? 0);
  _draft.freight = shipIncl > 0 ? round2(shipIncl / (1 + GST_RATE)) : 0;

  _fillSource = { type: 'order', label: order.order_number || String(orderId) };
  rebuildEditor();
  Toast.success(`Filled from order ${order.order_number || ''}`.trim());
}

// Fill the non-goods fields from a saved Contact (bill-to + deliver-to + note).
function loadFromContact(c) {
  if (!c) return;
  const b = c.bill_to || {};
  const d = c.deliver_to || {};
  _draft.source_order_id = null;
  _draft.customer = {
    attn: b.attn || b.name || '',
    name: b.name || b.company || '',
    company: b.company || '',
    address: joinLines(b.address),
    phone: b.phone || '',
    email: b.email || '',
  };
  _draft.delivery = {
    attn: d.attn || '',
    company: d.company || '',
    address: joinLines(d.address),
    phone: d.phone || '',
  };
  if (c.notes) _draft.notes = c.notes;
  // Adopt the contact's saved payment term and re-derive the due date from it
  // (drop any prior manual override so the new term takes effect).
  _draft.payment_due_pref = c.payment_due_pref || '20';
  _draft.payment_due = '';
  _fillSource = { type: 'contact', label: c.label || b.name || b.company || 'contact' };
  rebuildEditor();
  Toast.success(`Filled from contact ${_fillSource.label}`.trim());
}

async function loadFromCustomer(c) {
  if (!c) return;
  const token = _editorToken;
  const name = c.full_name || `${c.first_name || ''} ${c.last_name || ''}`.trim();

  // Prefer the customer's saved invoicing profile (Customers drawer → Invoicing
  // details) over scraping their latest order.
  const inv = c.invoicing;
  if (inv && (inv.bill_to || inv.deliver_to)) {
    const b = inv.bill_to || {};
    const d = inv.deliver_to || {};
    _draft.customer = {
      attn: b.attn || name,
      name: b.name || name,
      company: b.company || '',
      address: joinLines(b.address),
      phone: b.phone || c.phone || '',
      email: b.email || c.email || '',
    };
    _draft.delivery = { attn: d.attn || '', company: d.company || '', address: joinLines(d.address), phone: d.phone || '' };
    _fillSource = { type: 'customer', label: name };
    rebuildEditor();
    Toast.success(`Filled customer ${name}`.trim());
    return;
  }

  // No saved profile — fall back to the legacy "scrape latest order address" path.
  _draft.customer.name = name;
  _draft.customer.attn = _draft.customer.attn || name;
  _draft.customer.email = c.email || _draft.customer.email;
  _draft.customer.phone = c.phone || _draft.customer.phone;
  const od = await AdminAPI.getOrders({ user_id: c.id }, 1, 1);
  if (!editorAlive(token)) return;
  const order = od?.orders?.[0];
  const addr = order?.shipping_address;
  if (addr) {
    _draft.customer.address = [addr.address_line1, addr.address_line2,
      [addr.city, addr.region, addr.postal_code].filter(Boolean).join(', '), addr.country].filter(Boolean).join('\n');
    if (!_draft.customer.phone) _draft.customer.phone = addr.phone || '';
  }
  _fillSource = { type: 'customer', label: name };
  rebuildEditor();
  Toast.success(`Filled customer ${name}`.trim());
}

// =========================================================================
//  Live preview
// =========================================================================
function refreshPreview() {
  // The internal margin readout depends on qty, price, cost AND freight, so it
  // refreshes wherever the preview does rather than enumerating fields.
  renderCogsPanel();
  const host = _editorRefs?.drawer.body.querySelector('#inv-preview');
  if (!host) return;
  host.innerHTML = renderPreview(_draft);
}

function renderPreview(d) {
  const t = computeTotals(d);
  const meta = invoiceMeta(d);
  const parties = invoiceParties(d);
  // invoiceDocRows yields exactly [code, description, qty, lineTotal] — the ONLY
  // projection the customer-facing document may use. The supplier cost cannot
  // leak here because this renderer no longer touches the line objects at all.
  const rows = invoiceDocRows(d, { money })
    .map(([code, description, qty, lineTotal]) => `<tr>
      <td class="inv-doc__code">${esc(code)}</td>
      <td>${esc(description)}</td>
      <td class="inv-doc__num">${esc(qty)}</td>
      <td class="inv-doc__cost">${esc(lineTotal)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="inv-doc__empty">Add a line item…</td></tr>`;

  const freightCell = t.freight > 0 ? money(t.freight) : 'Free';

  // From sits left; Bill To sits right with Deliver To stacked beneath it.
  const partyBlock = (p) => p ? `<div class="inv-doc__party">
        <div class="inv-doc__party-label">${esc(p.label)}</div>
        <div class="inv-doc__party-name">${esc(p.name) || '&nbsp;'}</div>
        <div class="inv-doc__party-lines">${p.lines.map((l) => esc(l)).join('<br>') || '&nbsp;'}</div>
      </div>` : '';
  const [fromParty, billParty, deliverParty] = parties;

  return `
  <div class="inv-doc">
    <div class="inv-doc__head">
      <div class="inv-doc__title">Tax Invoice</div>
      <table class="inv-doc__meta"><tbody>
        ${meta.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
      </tbody></table>
    </div>

    <div class="inv-doc__parties">
      ${partyBlock(fromParty)}
      <div class="inv-doc__party-stack">
        ${partyBlock(billParty)}
        ${partyBlock(deliverParty)}
      </div>
    </div>

    <table class="inv-doc__items">
      <thead><tr><th>Product Code</th><th>Description</th><th class="inv-doc__num">Number</th><th class="inv-doc__cost">Cost<span class="inv-doc__cost-note">(excl. GST)</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="inv-doc__totals">
      <tr><td>Sub Total</td><td>${money(t.subtotal)}</td></tr>
      <tr><td>Freight</td><td>${freightCell}</td></tr>
      <tr><td>GST</td><td>${money(t.gst)}</td></tr>
      <tr class="inv-doc__grand"><td>Total</td><td>${money(t.total)}</td></tr>
    </table>

    <div class="inv-doc__pay">
      <div class="inv-doc__pay-title">${displayDueDate(d) ? `<div>Payment due by <strong>${esc(formatInvoiceDate(displayDueDate(d)))}</strong></div>` : ''}<div>Please make payment to.</div></div>
      <table>
        <tr><td>a/c Name:</td><td><strong>${esc(d.footer.bankName)}</strong></td></tr>
        <tr><td>a/c Number:</td><td><strong>${esc(d.footer.bankAcct)}</strong></td></tr>
      </table>
    </div>
    ${d.footer.thankYou ? `<div class="inv-doc__thanks">${esc(d.footer.thankYou)}</div>` : ''}
  </div>`;
}

// =========================================================================
//  PDF — backend first, client-side jsPDF fallback
// =========================================================================
async function downloadPdf(d) {
  // Two entry points: the open editor (d === _draft) and a list-row button
  // (d is a freshly-mapped saved record, _draft is null). Only the editor draft
  // needs the required-field gate + in-form highlighting.
  const isEditorDraft = !!_editorRefs && d === _draft;
  if (isEditorDraft) {
    if (!ensureInvoiceValid()) return;
    // The invoice number is assigned by the backend on save. An unsaved draft has
    // none — so save it first (keeping the editor open) before producing the PDF,
    // otherwise the document would print with no invoice number.
    if (!d.id) {
      const btn = _editorRefs.drawer.footer.querySelector('[data-ed-action="download"]');
      if (btn) btn.disabled = true;
      try {
        const saved = await persistDraft();
        if (!saved) { Toast.error('Could not save the invoice to assign a number.'); return; }
        Toast.success(`Invoice ${d.invoice_number || ''} saved — assigning number to the PDF.`.replace('  ', ' '));
        rebuildEditor();   // reflect the new Invoice No in the header + preview
        loadData();        // refresh the list behind the drawer
      } catch (err) {
        warn('auto-save before download failed', err);
        Toast.error(err.message || 'Could not save the invoice to assign a number.');
        return;
      } finally {
        if (btn) btn.disabled = false;
      }
    }
  }
  // Render the PDF client-side so the download matches the professional on-screen
  // layout (and carries the now-assigned invoice number). The backend still renders
  // its own PDF for customer emails until that template is aligned.
  generateClientPdf(d);
}

// Builds the jsPDF document (the single source of the invoice layout) and returns
// it — callers either .save() it (download) or .output() it (upload to backend).
// Returns null if the jsPDF library hasn't loaded. Prefers server-confirmed totals
// (set on the draft after save) so the document never disagrees with the backend.
function buildInvoiceDoc(d) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) return null;
  const t = d._serverTotals || computeTotals(d);
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const M = 48;

  const text = (s, x, y) => doc.text(String(s ?? ''), x, y);

  // --- Header band: title (left) + meta key/values (right) ---
  doc.setFont('times', 'bold'); doc.setFontSize(24); doc.setTextColor(25);
  doc.text('TAX INVOICE', M, 72);
  let my = 56;
  invoiceMeta(d).forEach(([k, v]) => {
    doc.setFont('times', 'normal'); doc.setFontSize(9); doc.setTextColor(140);
    doc.text(k.toUpperCase(), pageW - M - 100, my, { align: 'right' });
    doc.setFont('times', 'bold'); doc.setFontSize(11); doc.setTextColor(25);
    doc.text(String(v ?? ''), pageW - M, my, { align: 'right' });
    my += 16;
  });
  const headBottom = Math.max(86, my + 2);
  doc.setDrawColor(25); doc.setLineWidth(1.2);
  doc.line(M, headBottom, pageW - M, headBottom);

  // --- Party columns: From (left) | Bill To (right), with Deliver To stacked
  //     beneath Bill To in the right column. ---
  const parties = invoiceParties(d);
  const [fromParty, billParty, deliverParty] = parties;
  const colTop = headBottom + 28;
  const gap = 20;
  const colW = (pageW - 2 * M - gap) / 2;   // two equal columns
  // Draw one party block at (x, top); returns the y just below it.
  const drawParty = (p, x, top) => {
    if (!p) return top;
    doc.setFont('times', 'bold'); doc.setFontSize(9); doc.setTextColor(140);
    doc.text(p.label.toUpperCase(), x, top);
    doc.setFont('times', 'bold'); doc.setFontSize(13); doc.setTextColor(25);
    let yy = top + 17;
    doc.splitTextToSize(p.name || '', colW).forEach((w) => { doc.text(w, x, yy); yy += 15; });
    doc.setFont('times', 'normal'); doc.setFontSize(11); doc.setTextColor(45);
    yy += 2;
    p.lines.forEach((l) => {
      doc.splitTextToSize(String(l), colW).forEach((w) => { doc.text(w, x, yy); yy += 13.5; });
    });
    return yy;
  };
  const rightX = M + colW + gap;
  const leftBottom = drawParty(fromParty, M, colTop);
  let rightBottom = drawParty(billParty, rightX, colTop);
  if (deliverParty) rightBottom = drawParty(deliverParty, rightX, rightBottom + 16);
  const partyBottom = Math.max(leftBottom, rightBottom);
  doc.setTextColor(20);

  // --- Items table ---
  const startY = Math.max(partyBottom + 18, 250);
  // Same four-column projection as the live preview — see renderPreview. The
  // supplier cost is structurally unable to reach the PDF: it is not in the tuple.
  const rows = invoiceDocRows(d, { money });
  // Fixed column widths keep the layout stable regardless of content length: a
  // long product code or description wraps inside its own column instead of
  // stealing width from the others (which used to squeeze "Description" so hard
  // the header itself broke onto two lines). Left/right padding is zeroed on the
  // edge columns so the code aligns under "FROM" and Cost aligns with the totals.
  const padY = { top: 5, bottom: 5 };
  doc.autoTable({
    startY,
    head: [['Product Code', 'Description', 'Number', 'Cost\n(excl. GST)']],
    body: rows.length ? rows : [['', '', '', '']],
    theme: 'plain',
    styles: { font: 'times', fontSize: 11, cellPadding: { ...padY, left: 0, right: 8 }, overflow: 'linebreak', valign: 'top', textColor: 35 },
    headStyles: { font: 'times', fontStyle: 'bold', textColor: 90, fontSize: 10 },
    columnStyles: {
      0: { cellWidth: 116 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 52, halign: 'center', cellPadding: { ...padY, left: 6, right: 6 } },
      3: { cellWidth: 72, halign: 'right', cellPadding: { ...padY, left: 6, right: 0 } },
    },
    margin: { left: M, right: M },
    // A single hairline rule under the header row (drawn per head cell so it spans
    // the full table width) — cleaner than a boxed grid.
    didDrawCell: (data) => {
      if (data.section !== 'head') return;
      doc.setDrawColor(30); doc.setLineWidth(0.8);
      doc.line(data.cell.x, data.cell.y + data.cell.height, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
    },
  });

  // --- Totals (right aligned) ---
  let ty = (doc.lastAutoTable?.finalY || startY) + 28;
  const labelX = pageW - M - 170;
  const valX = pageW - M;
  doc.setTextColor(20);
  const totRow = (label, val, opts = {}) => {
    doc.setFont('times', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size || 11);
    doc.text(label, labelX, ty);
    doc.text(String(val), valX, ty, { align: 'right' });
    ty += opts.gap || 16;
  };
  totRow('Sub Total', money(t.subtotal));
  totRow('Freight', t.freight > 0 ? money(t.freight) : 'Free');
  totRow('GST', money(t.gst));
  ty += 6;
  doc.setDrawColor(20); doc.setLineWidth(1); doc.line(labelX, ty - 11, valX, ty - 11);
  totRow('Total', money(t.total), { bold: true, size: 14, gap: 16 });

  // --- Payment block ---
  let py = ty + 24;
  const due = displayDueDate(d);
  doc.setFont('times', 'bold'); doc.setFontSize(12.5);
  if (due) { text(`Payment due by ${formatInvoiceDate(due)}`, M, py); py += 16; }
  text('Please make payment to.', M, py);
  py += 20;
  doc.setFont('times', 'normal');
  text(`a/c Name:`, M, py); doc.setFont('times', 'bold'); text(d.footer.bankName || '', M + 76, py); py += 15;
  doc.setFont('times', 'normal'); text('a/c Number:', M, py); doc.setFont('times', 'bold'); text(d.footer.bankAcct || '', M + 76, py);
  if (d.footer.thankYou) { py += 30; doc.setFont('times', 'bold'); doc.setFontSize(10); doc.text(doc.splitTextToSize(d.footer.thankYou, pageW - 2 * M), M, py); }

  return doc;
}

// Render + trigger a browser download of the invoice PDF.
function generateClientPdf(d) {
  const doc = buildInvoiceDoc(d);
  if (!doc) { Toast.error('PDF library not loaded.'); return; }
  doc.save(`Invoice-${d.invoice_number || 'draft'}.pdf`);
}
