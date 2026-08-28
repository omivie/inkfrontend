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
import { mergeSends, recordedSendsPhrase } from '../utils/send-history.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Modal } from '../components/modal.js';
import { Toast } from '../components/toast.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { attachProductAutocomplete, productCostExGst, resolveSkus } from '../components/product-search.js';
import { codesToVerify, applyResolvedCodes, unresolvedLineErrors } from '../utils/line-codes.js';
import { parseQuickOrderPrefill, flipTargetFrom } from '../utils/quick-order-bridge.js';
import {
  costOrNull, lineSupplierCost, computeInvoiceTotals, computeInvoiceCogs, computeInvoiceProfit,
  normalizeInvoice, invoiceDocRows, computeInvoiceVolumeSavings,
} from '../utils/invoice-math.js';
import {
  PRICE_AUTO, PRICE_MANUAL, FREIGHT_CUSTOM, MAX_QUOTE_LINES,
  quoteRequestBody, normalizeQuote, applyQuoteToLines, clearVolume, lineDocNote,
  hasManualDiscount, clearDiscount,
  volumeBadge, formatVolumePercent, resolveShippingSelection, freeShippingLost,
  freeShippingAvailable, parcelWeightNote, planFreightAutofill, freeShippingGapNote,
  hasCreditLine,
  FREIGHT_OWNER_NONE, FREIGHT_OWNER_AUTO, FREIGHT_OWNER_OPERATOR,
} from '../utils/invoice-quote.js';
import { patchQuotedLineRows } from '../utils/line-row-patch.js';
import { marginBadge, formatProfitDollars } from '../utils/profitability.js';
import {
  ordersFrom, searchParties, orderToParty, partyEmptyText, orderEmptyText,
} from '../utils/party-search.js';
import { GST_INCL, GST_EXCL, GST_NET, gstSub } from '../utils/gst-basis.js';

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
const escA = (s) => Security.escapeAttr(String(s ?? ''));
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
// The backend owns the send history and returns `emailed_at` + `email_count` on
// every list row, with the per-send detail behind GET /invoices/:id/emails. This
// localStorage map stays as a BACKSTOP only: it records a send made from this
// browser so the marker is right the instant the send resolves, and so a row
// never reads "never emailed" just because one list response came back without
// the fields. A local record is per-browser: it says a send was recorded on THIS
// machine, not that no send happened on another one.
//
// v2 (Aug 2026) stores a LIST of sends plus a monotonic tally, where v1 stored
// one timestamp and a count. Two reasons:
//   - the list lets the history panel show a send the server log has not caught
//     up on yet, deduped against the logged rows;
//   - the tally is what makes ×N right on a LEGACY row. An invoice emailed
//     before the log table existed comes back `emailed_at: <a real date>` with
//     `email_count: 0`, so after one resend the server says 1 — understating a
//     send we can prove happened. `recorded` is seeded from what the cell knew
//     BEFORE the send and only ever grows (see writeSent's `priorCount`).
// v1 is migrated on read and never written back; its `count` seeds `recorded`.
const SENT_KEY = 'inv_emailed_v2';
const SENT_KEY_V1 = 'inv_emailed_v1';
const SENT_CAP = 200;
// Per invoice. The tally survives the trim, so capping the list loses detail in
// the history panel, never the count.
const SENT_SENDS_CAP = 20;

function parseStored(key) {
  try {
    const m = JSON.parse(localStorage.getItem(key));
    return (m && typeof m === 'object') ? m : {};
  } catch { return {}; }
}

/** v1 `{at, to, count}` -> v2 `{sends:[{at,to}], recorded}`. */
function upgradeV1(entry) {
  if (!entry?.at) return null;
  return { sends: [{ at: entry.at, to: entry.to || '' }], recorded: Math.max(1, num(entry.count) || 0) };
}

// Every access is try/caught inside parseStored: a browser with storage blocked
// must degrade to "no local record", never throw through the table renderer.
function readSentMap() {
  const v2 = parseStored(SENT_KEY);
  const out = {};
  for (const [id, e] of Object.entries(parseStored(SENT_KEY_V1))) {
    const up = upgradeV1(e);
    if (up) out[id] = up;
  }
  for (const [id, e] of Object.entries(v2)) {
    if (!e || typeof e !== 'object') continue;
    out[id] = {
      sends: Array.isArray(e.sends) ? e.sends.filter(s => s?.at) : [],
      // A v2 entry wins outright, but never below what v1 already claimed —
      // the tally is a floor and a migration must not lower it.
      recorded: Math.max(num(e.recorded) || 0, out[id]?.recorded || 0),
    };
  }
  return out;
}

/** Newest `at` on a local entry, for the map-level trim. '' when it has none. */
function newestLocalAt(entry) {
  return (entry?.sends || []).reduce((a, s) => (String(s.at) > a ? String(s.at) : a), '');
}

/**
 * Record a send made from this browser. APPENDS — it must never rebuild the
 * entry from the one send it just wrote, or the tally it exists to protect
 * resets to 1 on every resend (that is exactly how ERR-177 broke on Orders).
 *
 * `priorCount` is what the cell claimed BEFORE this send — including the "1"
 * a legacy row gets from a bare `emailed_at`. Passing it is what carries an
 * unlogged send across the resend that would otherwise erase it.
 */
function writeSent(id, to, priorCount = 0) {
  if (!id) return;
  try {
    const map = readSentMap();
    const prev = map[id] || { sends: [], recorded: 0 };
    const sends = [...prev.sends, { at: new Date().toISOString(), to: to || '' }]
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, SENT_SENDS_CAP);
    map[id] = {
      sends,
      recorded: Math.max(prev.recorded + 1, (num(priorCount) || 0) + 1, sends.length),
    };
    const keys = Object.keys(map);
    if (keys.length > SENT_CAP) {
      keys.sort((a, b) => newestLocalAt(map[a]).localeCompare(newestLocalAt(map[b])))
        .slice(0, keys.length - SENT_CAP)
        .forEach((k) => { delete map[k]; });
    }
    localStorage.setItem(SENT_KEY, JSON.stringify(map));
  } catch (err) { warn('could not record the send locally', err); }
}

// BOTH sources are read, ALWAYS. The old shape returned the server record and
// stopped, leaving the local branch unreachable for any row the server had
// stamped — so a resend this browser had just made could not raise the number,
// and writeSent incremented a count nothing read. That is the ERR-177 finding
// applied here: collapse at the point of DISPLAY, not at the point of READ.
//
// ERR-131: the field is `emailed_at`. `last_emailed_at`/`last_emailed_to` were the
// names agreed in the Jul-10 handoff and the backend shipped different ones, so
// this read matched nothing for three weeks and every row fell through to the
// per-browser cache. Both spellings are read now — the alias costs one `||`.
//
// `count` IS A FLOOR, NEVER A TOTAL, and `email_count: 0` is why. An invoice
// emailed before the send log existed comes back with a real `emailed_at` and
// `email_count: 0`, and "0" there means "we don't know how many", not "zero
// sends" — so it is never coerced to 1 as a total; it sets `floor` instead, and
// every surface says "recorded sends", never "sent N times".
//
// The count is a `max()` over every tally we hold, not `sends.length` alone.
// `emailed_at` reports only the LATEST send, so the timestamps we can list are
// always fewer than the sends that happened, and `email_count` / `recorded` are
// the only things that know about the rest.
//
// `sends.length` is safe in that max only because writeSent is always handed the
// count the cell claimed BEFORE the send: `recorded` therefore already covers
// every send a server stamp could be a duplicate of, so a local record skewed
// more than SAME_SEND_MS from its server twin cannot push the number past it.
function sentInfo(rec) {
  if (!rec) return null;
  const serverAt = rec.emailed_at || rec.last_emailed_at || null;
  const serverTo = rec.emailed_to || rec.last_emailed_to || '';
  const serverCount = num(rec.email_count) || 0;
  const local = readSentMap()[rec.id] || null;

  const sends = mergeSends([
    ...(serverAt ? [{ at: serverAt, to: serverTo, source: 'server' }] : []),
    ...(local?.sends || []).map(s => ({ at: s.at, to: s.to || '', source: 'local' })),
  ]);
  if (!sends.length) return null;

  const recorded = num(local?.recorded) || 0;
  const count = Math.max(serverCount, recorded, sends.length);
  // We know of sends we cannot enumerate when the server has a date but no
  // count (pre-log), or when either tally outruns the timestamps we hold.
  const floor = (!!serverAt && serverCount === 0) || count > sends.length;
  return { at: sends[0].at, to: sends[0].to || serverTo, source: sends[0].source, sends, count, floor };
}

const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
// ISO timestamp -> "8 Jul" for the Sent cell. '' if unparseable.
function sentShort(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
// ISO timestamp -> "8th July 2026 · 4:23 pm" for a send-history row. '' if unparseable.
// The empty/null guard is NOT redundant with the isNaN check below: `new Date(null)`
// is the epoch and `new Date('')` is Invalid, so without it a send row with no
// timestamp would confidently print "1st January 1970" instead of "Date unknown".
function sentDateTime(iso) {
  if (iso == null || iso === '') return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatInvoiceDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)} · ${h}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}
// "recorded sends", never "sent N times" — the number is a floor (see sentInfo),
// and the phrasing is the one utils/send-history.js defines for both admin pages.
function sentTitle(info) {
  const who = info.to ? ` to ${info.to}` : '';
  const times = ` · ${recordedSendsPhrase(info.count, { floor: info.floor })}`;
  return `Last emailed${who} on ${formatInvoiceDate(String(info.at).slice(0, 10))}${times} · click for the send log`;
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

// ── Quote state (POST /api/admin/invoices/quote) ─────────────────────────────
// Advisory only. None of this is saved; it decides what to autofill and what the
// shipping row says. It lives outside _draft on purpose — see _freightChoice.
let _quote = null;            // last GOOD normalizeQuote() result, or null
let _quoteStatus = 'idle';    // 'idle'|'loading'|'ready'|'limited'|'unavailable'
let _quoteSeq = 0;            // out-of-order guard: only the newest reply is used
let _quoteDebounce = null;
let _volumeOffers = [];       // [{position, badge}] — hand-edited lines with a better price
// The operator's explicit shipping pick for this editor session, or null to let
// it be derived from the freight value. NOT stored on the invoice: buildPayload's
// key set is walked by setStatusViaFullUpdate() and diffed by documentDrift(),
// so a new key there would change the paid-toggle's full-record PUT. The freight
// NUMBER is the durable record; the option is a label for it.
let _freightChoice = null;
// WHO wrote the number in the freight box — see the FREIGHT_OWNER_* block in
// invoice-quote.js for why presence was never enough (ERR-178). Session-only for
// exactly the same reason as _freightChoice: it must not reach buildPayload.
let _freightOwner = FREIGHT_OWNER_NONE;

// ── Autocomplete handles ────────────────────────────────────────────────────
// The dropdown menus are portalled to <body> (ERR-107), so they do NOT go away
// with the drawer or with the row that owned the input — only destroy() removes
// them. Nothing here tracked them, so every renderLines() stranded two menus per
// product line in <body> permanently, and one that happened to be OPEN when its
// row was rebuilt stayed on screen with no way to close: `blur` never fires for
// a node removed from the DOM, so the component's own hide-on-blur never ran.
//
// Two registers, because they have different lifetimes. Line handles die with
// every re-render of the grid; the top-level pickers live as long as the drawer.
// Draining the wrong one is how you destroy the "Fill details from…" picker on
// the operator's first keystroke in a line.
// A renderShippingRow() that was postponed because the courier <select> had
// focus. Cleared by resetQuoteState() so it cannot survive into the next editor.
let _shippingRowDirty = false;

let _acLineHandles = [];   // per-line product autocompletes — drained by renderLines()
let _acTopHandles = [];    // #inv-order-search / #inv-party-search — drained on close

function destroyHandles(list) {
  list.forEach((h) => { try { h?.destroy?.(); } catch (_) { /* already gone */ } });
  list.length = 0;
}

function teardownAutocompletes() {
  destroyHandles(_acLineHandles);
  destroyHandles(_acTopHandles);
}

const QUOTE_DEBOUNCE_MS = 400;   // brief suggests 300–500ms; budget is 60/min

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
// priceSource   — the same distinction for the SELL price, and the whole reason
//                 volume autofill is safe. 'auto' = we put the number there and
//                 may replace it; 'manual' = the operator authored it and we
//                 must not. NB "authored" includes a price loaded off a SAVED
//                 invoice or a real ORDER — both are history, not suggestions.
// volumePercent / volumeSaving / volumeQuantity
//               — the discount the BACKEND said applied at the moment we filled
//                 the price. Printed on the customer's invoice, so they are
//                 cleared the instant the price stops being ours (see
//                 applyQuoteToLines): we never claim a discount we did not give.
const blankLine = () => ({
  code: '', description: '', qty: 1, unitCost: 0, supplierCost: null, costSource: 'auto',
  // `ref` is the operator's OWN reference — what prints in the Product Code
  // column. Always present so every line has the same shape; only a custom line
  // ever fills it. See customLine() below for why it is not `code`.
  ref: '',
  priceSource: PRICE_AUTO, volumePercent: null, volumeSaving: null, volumeQuantity: null,
  // A discount the OPERATOR gave, as opposed to the volume trio above, which is
  // one the ladder gave. Both are display-only — `unitCost` is already the net
  // price either way — but they must be SEPARATE fields, because typing in the
  // price box clears the volume trio (onFormInput) and so does the next quote
  // reply (applyQuoteToLines' MANUAL branch). A discount kept there would be
  // erased by the very keystroke that created it.
  discountSaving: null, discountNote: '',
});

// A freight / labour / one-off line: description-only BY DESIGN. An empty
// product_code is legal on an invoice line and always has been — it is how the
// backend and this editor have modelled non-catalogue charges since ERR-071 —
// so a shipping charge needs no new field, no new endpoint and no payload key.
//
// `kind` is SESSION-ONLY editor state, deliberately absent from buildPayload:
// that key set is walked by setStatusViaFullUpdate() and diffed by
// documentDrift(), so a new key there would change what the Paid toggle's
// full-record PUT writes. Same reasoning that keeps _freightChoice out. The
// consequence is that reopening a saved invoice renders this as an ordinary
// description-only line; the amount, the description and the customer's PDF are
// all intact. Do NOT re-derive `kind` from the description text — an operator
// who rewrote it to "Air freight — Sydney" would stop matching, and guessing
// the marker back is the re-derivation trap BF-043 warns about.
//
// priceSource is MANUAL from birth: freight is an authored figure, and the
// volume ladder must never re-price it (applyQuoteToLines).
const SHIPPING_DESCRIPTION = 'Freight & delivery';

const shippingLine = () => ({
  ...blankLine(),
  kind: 'shipping',
  description: SHIPPING_DESCRIPTION,
  priceSource: PRICE_MANUAL,
});

/**
 * A CUSTOM ITEM: something real that isn't in the catalogue — a refurbished
 * unit, a machine sourced in for one customer, a service.
 *
 * The whole design is one separation. That single box on a product row is doing
 * two unrelated jobs, and conflating them is why "type your own code" looked
 * impossible:
 *
 *   code (→ product_code)  WHICH CATALOGUE PRODUCT THIS IS. A real products.sku
 *                          or empty, never anything else. The backend matches
 *                          line items by SKU when it materialises the shadow
 *                          order, and a code that matches nothing DROPS THE LINE
 *                          — ERR-071, invoices #3263/#3264, paid orders with no
 *                          line items. It also 400s the save outright now.
 *   ref  (→ product_ref)   WHAT THE CUSTOMER SEES in the Product Code column.
 *                          Free text, ours, never resolved against anything.
 *
 * So a custom line carries `code: ''` — the same empty product_code freight
 * lines have used since ERR-071 — and prints its `ref` instead
 * (invoiceDocRows). Nothing new can reach the SKU matcher.
 *
 * Like `kind:'shipping'`, `kind` itself is SESSION-ONLY and never in
 * buildPayload. Unlike shipping, this one is recoverable on reopen WITHOUT
 * guessing: `ref` is a real stored field, so a line that comes back carrying a
 * product_ref IS a custom item. That is reading a value, not re-deriving a
 * marker from prose the operator might rewrite (the BF-043 trap).
 *
 * priceSource MANUAL from birth: a custom item's price is authored, and the
 * volume ladder must never re-price it.
 */
const customLine = () => ({
  ...blankLine(),
  kind: 'custom',
  ref: '',
  priceSource: PRICE_MANUAL,
});

/** Is this line a custom (non-catalogue) item? */
const isCustomLine = (l) => l?.kind === 'custom';

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
    // The customer's OWN purchase-order reference. Printed on the invoice and
    // shown on their /business portal so they can match it to their paperwork.
    po_number: '',
    // FK to business_accounts. This is the ONLY thing that puts an invoice on a
    // customer's /business portal — GET /api/business/invoices filters on it and
    // never on email, because a shared or mistyped address would expose another
    // company's invoices. null = not linked = invisible to every portal.
    business_account_id: null,
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
  d.po_number = rec.po_number ?? '';
  d.business_account_id = rec.business_account_id ?? null;
  // Server-owned send history — read-only, deliberately absent from buildPayload()
  // (a full-payload PUT would otherwise wipe it on every edit). `emailed_at` is
  // the name the backend actually returns; the last_emailed_* pair is the older
  // alias sentInfo() still tolerates. See ERR-131.
  d.emailed_at = rec.emailed_at ?? null;
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
    // `kind` is session-only, but a custom item is RECOVERABLE without guessing:
    // product_ref is a real stored field, so a line that comes back carrying one
    // IS a custom item. Reading a value is not the re-derive-a-marker-from-prose
    // trap BF-043 warns about — that would be sniffing the description text.
    ref: l.product_ref ?? l.ref ?? '',
    ...((l.product_ref ?? l.ref) ? { kind: 'custom' } : {}),
    costSource: l.cost_source || l.costSource || 'auto',
    // A SAVED price is operator-authored, full stop. Re-pricing it from today's
    // ladder would silently rewrite what a customer was already invoiced — so
    // every loaded line is 'manual' and volume autofill can only ever OFFER.
    priceSource: PRICE_MANUAL,
    // The discount that was actually given, if the backend ever echoes it back.
    // It does not today (BF-043) — and when it is absent the invoice simply
    // prints no bulk note, because absence here means "we don't know what
    // discount this invoice gave", NOT "it gave none". Guessing from today's
    // ladder is the one thing that would be wrong.
    volumePercent: l.volume_discount_percent ?? l.volumePercent ?? null,
    volumeSaving: l.volume_saving_excl_gst ?? l.volumeSaving ?? null,
    volumeQuantity: l.volume_quantity ?? l.volumeQuantity ?? null,
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
// A line the operator has actually put something in. `ref` counts: a custom item
// identified only by the operator's own reference is a real line, and leaving it
// out here would drop it from line_items while invoiceDocRows still PRINTED it —
// the document and the stored invoice disagreeing, which is the ERR-181 shape.
const realLines = (d) => (d.lines || []).filter((l) => (l.code || '').trim() || (l.description || '').trim() || (l.ref || '').trim());

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
    po_number: d.po_number || null,
    // MUST be in this payload even when null, and not only so linking works.
    // setStatusViaFullUpdate() rehydrates a record by walking Object.keys of
    // THIS object, and documentDrift() diffs the same key set — so a field
    // absent here is invisible to both. While `business_account_id` was missing,
    // the Paid toggle's full-record PUT would have silently dropped an existing
    // link and taken the invoice off the customer's portal, with no symptom.
    business_account_id: d.business_account_id || null,
    seller: { ...d.seller, address: lines(d.seller.address) },
    customer: { ...d.customer, address: lines(d.customer.address) },
    // Sent only when filled; backend ignores unknown keys (cf. preview_totals) until
    // it persists/renders this on the server-side PDF.
    delivery: hasDelivery(d) ? { ...d.delivery, address: lines(d.delivery.address) } : null,
    line_items: realLines(d).map((l) => ({
      // WHICH CATALOGUE PRODUCT THIS IS — a real products.sku or ''. Never the
      // operator's own reference: the backend matches line items by SKU when it
      // materialises the shadow order, and a code that matches nothing drops the
      // line (ERR-071). `ref` below is the free-text half, and keeping them in
      // separate fields is the whole safety argument for custom items.
      product_code: l.code,
      // WHAT THE CUSTOMER SEES in the Product Code column. Opaque to the
      // backend — never resolved, never validated. No column for it yet, so it
      // is dropped on save until BF-051 lands; refEchoMissing() below detects
      // exactly that and says so rather than letting it vanish quietly.
      product_ref: (l.ref || '').trim() || null,
      description: l.description,
      quantity: num(l.qty),
      unit_cost_excl_gst: round2(num(l.unitCost)),          // SELL price — printed on the invoice
      // OUR cost — internal, never printed. null tells the backend to snapshot
      // products.cost_price itself at save time, so COGS stays right even when
      // the client never saw a cost.
      supplier_cost_excl_gst: lineSupplierCost(l),
      cost_source: l.costSource || 'auto',
      // The volume discount we actually applied, as the backend told us it. The
      // invoice PRINTS this, so it has to survive a reload — but there are no
      // columns for it yet (BF-043) and unknown keys are ignored, exactly like
      // `delivery` and `preview_totals` were before their columns existed. The
      // customer's copy is safe meanwhile: syncStoredPdf() uploads the rendered
      // PDF at save, so the document they receive always carries the note.
      volume_discount_percent: l.volumePercent ?? null,
      volume_saving_excl_gst: l.volumeSaving ?? null,
      volume_quantity: l.volumeQuantity ?? null,
      // The discount the OPERATOR gave, and why. Display-only in exactly the
      // same sense as the three above — `unit_cost_excl_gst` already carries the
      // money — and dropped for the same reason: no column yet. What is lost on
      // a reload is the EXPLANATION, never the price. refEchoMissing() below
      // measures whether that happened rather than assuming it.
      discount_saving_excl_gst: l.discountSaving ?? null,
      discount_note: (l.discountNote || '').trim() || null,
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
    resetQuoteState();         // also cancels the pending debounced quote
  },
};

const COLUMNS = [
  { key: 'invoice_number', label: 'Invoice #', sortable: true, render: (r) => `<span class="cell-mono"><strong>${esc(r.invoice_number || '—')}</strong></span>` },
  { key: 'issue_date', label: 'Date', sortable: true, render: (r) => esc(formatInvoiceDate((r.issue_date || r.date || '').slice(0, 10))) },
  { key: 'customer', label: 'Customer', render: (r) => esc(r.customer_name || r.customer?.name || '—') },
  { key: 'total', label: 'Total', align: 'right', sortable: true, gst: GST_INCL, render: (r) => money(r.total_incl_gst ?? r.total ?? 0) },
  {
    key: 'profit', label: 'Profit', align: 'right', ownerOnly: true, gst: GST_NET,
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
    //
    // Both states are <button>s so the cell opens the per-send history. That also
    // keeps the editor shut on click for free: DataTable's row-click guard skips
    // `closest('button, a, input')` (components/table.js).
    render: (r) => {
      const info = sentInfo(r);
      const attrs = `data-row-action="sent-history" data-id="${escA(r.id)}" data-num="${escA(r.invoice_number)}"`;
      if (!info) {
        // "No send on record", not "not emailed": the list row and this browser
        // are the only things we asked. Same distinction the Orders column draws
        // between NOT_RECORDED and "never sent".
        return `<button type="button" class="inv-sent__none" ${attrs} title="No send on record for this invoice — click for the send log">—</button>`;
      }
      // ×N only past one send: printing "×1" over a single send states a fact we
      // would be inventing. `info.count` now also rises on a LEGACY row (a real
      // `emailed_at` with `email_count: 0`) the moment this browser resends it —
      // the case where the old server-only count left the cell unchanged by a
      // resend, which is the whole point of this column.
      const times = info.count > 1 ? `<span class="inv-sent__times">×${esc(info.count)}</span>` : '';
      return `<button type="button" class="inv-sent" ${attrs} title="${escA(sentTitle(info))}">${icon('check', 13, 13)}${esc(sentShort(info.at))}${times}</button>`;
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
    const wanted = btn.checked ? 'paid' : 'unpaid';
    btn.disabled = true;
    try {
      const { invoice: inv, via } = await setStatusWithFallback(id, wanted);
      Toast.success(wanted === 'paid' ? 'Marked paid.' : 'Marked unpaid.');
      if (via === 'put-fallback') announceFallbackOnce();
      // Not optimistic-only: repaint from what the server says the status IS.
      applyRowStatus(id, inv, wanted);
    } catch (err) {
      btn.checked = wanted === 'unpaid';   // revert to the last known-good value
      Toast.error(statusErrorMessage(err));
    } finally {
      btn.disabled = false;   // no-op if applyRowStatus already replaced the node
    }
  } else if (action === 'sent-history') {
    openSentHistory(id, btn.dataset.num, _table?.data?.find((r) => String(r.id) === String(id)) || null);
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
        // POST /:id/void is live (probed 401, not 404, 2026-07-31) — so a failure
        // here is a real failure. Never dress it as an unbuilt feature (ERR-131).
        try { await AdminAPI.voidInvoice(id); Toast.success('Invoice voided.'); loadData(); }
        catch (err) { Toast.error(err.message || 'Could not void that invoice. Try again.'); }
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
          // DELETE /api/admin/invoices/:id is live (probed 401, not 404,
          // 2026-07-31). A 404 therefore means THIS INVOICE is gone, not that the
          // route is unbuilt — the old "backend pending" copy was the same
          // reassuring-but-wrong excuse that hid the paid bug for a month (ERR-131).
          Toast.error(err.code === 'NOT_FOUND'
            ? 'That invoice no longer exists — someone may have deleted it already. Refresh the list.'
            : (err.message || 'Could not delete that invoice. Try again.'));
        }
      },
    });
  }
}

// =========================================================================
//  Setting a paid status — and the BF-021 compatibility path
// =========================================================================
//
// The route the toggle WANTS is PATCH /api/admin/invoices/:id/status: one
// request, no read-modify-write, and the backend answers with the re-serialised
// invoice. That route is live — curl gets a 401, not a 404 (ERR-131).
//
// It is also unreachable from a browser. The API answers a PATCH preflight with
//   Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
// — no PATCH — from the production origin and from localhost alike. Chrome kills
// the request before it is sent, so fetch() rejects with a bare TypeError. That
// is BF-021, re-measured warm ×3 on 2026-07-31 and STILL OPEN, after a handoff
// doc declared the backend "shipped & live — no further backend change needed".
// A route that answers curl can still be unreachable from the page (ERR-138).
//
// PUT /api/admin/invoices/:id IS on that allow-list, and it already carries
// `status` — it is the exact request the editor drawer's Save makes. So when the
// preflight is blocked, do by code what the operator can already do by hand:
// read the invoice, flip one field, write it back.
//
// This path is deliberately SECOND. PATCH stays the preferred call, so the day
// BF-021 lands the fallback stops running on its own, with no code change.
async function setStatusWithFallback(id, wanted) {
  try {
    return { invoice: await AdminAPI.setInvoiceStatus(id, wanted), via: 'patch' };
  } catch (err) {
    // ONLY an opaque transport failure earns a second attempt. A coded rejection
    // (CONFLICT / NOT_FOUND / RATE_LIMITED / VALIDATION_FAILED) is the server
    // saying no — replaying that through a different, heavier write route would
    // be trying to talk the backend out of an answer it already gave.
    if (!isNetworkFailure(err)) throw err;
    warn('PATCH /:id/status blocked (BF-021) — falling back to a full PUT', err);
    return { invoice: await setStatusViaFullUpdate(id, wanted), via: 'put-fallback' };
  }
}

// Flip `status` through the full-update route, reusing the editor's own
// record → draft → payload round-trip so this can never drift from what Save does.
//
// An invoice is a legal document. Every guard below ABORTS the flip rather than
// risk writing back a rewritten record: a toggle that refuses is an inconvenience,
// a silently renumbered or emptied invoice is not recoverable.
async function setStatusViaFullUpdate(id, wanted) {
  // getInvoice() fails soft to null. Absence is NOT an empty invoice — PUTting a
  // fresh draft here would blank the record (ERR-063/068/073/075/076/127).
  const rec = await AdminAPI.getInvoice(id);
  if (!rec) throw new Error('Couldn’t read that invoice back to update it. Check your connection and try again.');

  // The PATCH route 409s on a void invoice, because voiding also cancelled its
  // shadow order. PUT holds no such opinion and would happily un-void it. Check
  // the SERVER's copy, not the row that was clicked.
  if (rec.status === 'void') throw Object.assign(new Error('Invoice is void'), { code: 'CONFLICT' });

  const draft = draftFromInvoice(rec);

  // buildPayload sends `invoice_number: d.invoice_number || null`, and null tells
  // the backend to ASSIGN THE NEXT NUMBER IN SERIES. A status flip that renumbered
  // an invoice the customer already holds is silent corruption of a document.
  if (!draft.invoice_number) {
    throw new Error('That invoice has no number on the server, so re-saving it could renumber it — refusing to change its status. Open the invoice, give it a number and save it first.');
  }

  // A lossy record → draft mapping must never blank an invoice's contents.
  if ((rec.line_items || rec.lines || []).length && !realLines(draft).length) {
    throw new Error('That invoice’s line items couldn’t be read back, so re-saving it could empty it — refusing to change its status.');
  }

  draft.status = wanted;
  const payload = buildPayload(draft);

  // buildPayload is an EDITOR payload: it fills gaps the way an operator editing
  // the form would want them filled. That is wrong here. Caught live on the first
  // real flip — invoice #3267 stored `payment_due: null`, and `effectiveDueDate()`
  // helpfully DERIVED 2026-08-20 from `payment_due_pref`, so flicking a switch
  // silently gave a sent invoice a due date it never had. `order_date` and
  // `issue_date` have the same shape of default.
  //
  // So: the server's record wins for every field it stores. Only `status` comes
  // from the draft. buildPayload is kept for the SHAPE (key names, line mapping,
  // the deliberate omission of server-owned send history) — not for its values.
  for (const key of Object.keys(payload)) {
    if (key === 'status' || key === 'line_items') continue;
    if (key in rec) payload[key] = rec[key];
  }

  // Belt and braces: prove it. `drift` re-derives the comparison from the payload's
  // own keys, so a future field added to buildPayload is checked even though the
  // loop above knows nothing about it. Refuse rather than write a rewritten record.
  const drift = documentDrift(rec, payload);
  if (drift.length) {
    throw new Error(`Refusing to change the status — re-saving this invoice would also change ${drift.join(', ')}. `
      + 'Open the invoice and save it yourself if that is what you want.');
  }

  return AdminAPI.updateInvoice(id, payload);
}

/**
 * Which document fields the PUT would change, other than `status`.
 *
 * The rule is: **you can only contradict a value you were given.** The comparison
 * walks the SERVER's record and checks each field the payload also carries. That
 * makes it immune to the two harmless differences measured on real invoices —
 * key ORDER (which plain JSON.stringify treats as significant, and which differs
 * on every nested object the backend returns) and server-computed extras like a
 * line's `line_total_excl_gst`, which the payload deliberately omits — while
 * still catching any stored value the round-trip would actually overwrite.
 */
function documentDrift(rec, payload) {
  // `status` is the point of the write. `show_due_date` and `preview_totals` are
  // client-side presentation the backend does not store, so there is no stored
  // value for them to contradict.
  const NOT_DOCUMENT = new Set(['status', 'show_due_date', 'preview_totals']);
  return Object.keys(payload)
    .filter((k) => !NOT_DOCUMENT.has(k) && k in rec && differs(rec[k], payload[k]));
}

/** Deep compare, walking only what the record actually contains. */
function differs(stored, outgoing) {
  if (Array.isArray(stored)) {
    if (!Array.isArray(outgoing) || stored.length !== outgoing.length) return true;
    return stored.some((v, i) => differs(v, outgoing[i]));
  }
  if (stored && typeof stored === 'object') {
    if (!outgoing || typeof outgoing !== 'object') return true;
    // A key the payload doesn't send can't be overwritten by it; a key the record
    // doesn't have has no stored value to lose.
    return Object.keys(stored).some((k) => k in outgoing && differs(stored[k], outgoing[k]));
  }
  return JSON.stringify(stored ?? null) !== JSON.stringify(outgoing ?? null);
}

// The fallback is a DEGRADED path, and a degraded path nobody can see stays
// degraded forever — no one chases a backend fix they don't know is needed
// (feedback_fail_soft_must_be_loud). The success toast is unchanged, because the
// flip genuinely worked; this says the rest of the truth, once per session.
let _fallbackAnnounced = false;
function announceFallbackOnce() {
  if (_fallbackAnnounced) return;
  _fallbackAnnounced = true;
  Toast.info('Heads up: the Paid switch is running on a compatibility path — it re-saves the whole '
    + 'invoice because the API still blocks the PATCH method (BF-021). Your change saved fine; the '
    + 'backend fix is one line.', 9000);
}

// Repaint one row from the status the SERVER reports, not from the checkbox the
// operator just clicked. `inv` is the re-serialised invoice from PATCH /:id/status;
// `wanted` is the fallback for a backend that answers 200 with no body.
//
// When a status filter is active and the row no longer belongs in it, reload
// instead — otherwise "Unpaid" keeps listing an invoice you just marked paid.
function applyRowStatus(id, inv, wanted) {
  if (!_table) return;                       // destroyed mid-flight
  const status = inv?.status || wanted;
  const row = _table.data.find((r) => String(r.id) === String(id));
  if (!row) { loadData(); return; }
  Object.assign(row, inv || {}, { status });
  if (_filters.status && _filters.status !== status) { loadData(); return; }
  _table.setData(_table.data, _table.pagination);
}

// One place to turn a PATCH /:id/status failure into something an operator can act
// on. invoiceError() attaches `code` from the envelope; js/api.js attaches
// 'RATE_LIMITED' on a 429 (the route shares the 10/min/operator invoice write limiter).
function statusErrorMessage(err) {
  switch (err?.code) {
    case 'CONFLICT': return 'This invoice is void — a void invoice can’t be marked paid or unpaid.';
    case 'NOT_FOUND': return 'That invoice no longer exists. Refresh the list.';
    case 'RATE_LIMITED': return 'Too many status changes at once. Give it a few seconds and try again.';
    default: break;
  }
  // A blocked CORS preflight and a dead connection both surface as an opaque
  // "Failed to fetch" with no status and no code — the browser deliberately hides
  // which. Since setStatusWithFallback() now absorbs the blocked-PATCH case
  // (BF-021) by re-routing through PUT, reaching here means the CORS-allowed PUT
  // failed to connect TOO — i.e. genuine connectivity loss, not the method gap.
  // Don't blame PATCH for it; say what happened and that nothing was saved.
  if (isNetworkFailure(err)) {
    return 'Couldn’t reach the server, so that change wasn’t saved. Both the status update and the '
      + 'full-invoice fallback failed to connect — check your connection, then reload the page.';
  }
  return err?.message || 'Could not update the invoice status.';
}

// fetch() rejects with a bare TypeError for DNS/offline/CORS-preflight failures.
// There is no status and no code to branch on, so the message is all we have.
function isNetworkFailure(err) {
  return !err?.code && /failed to fetch|networkerror|load failed|network request failed/i.test(err?.message || '');
}

// =========================================================================
//  Send history ("what we sent", GET /api/admin/invoices/:id/emails)
// =========================================================================
// Bumped on every open/close so a slow response can't paint into a modal that
// has since been closed or replaced (Modal is a singleton). Same idiom as
// _editorToken — see project_admin_async_after_destroy_guard_jun2026.
let _historyToken = 0;

function openSentHistory(id, invoiceNumber, row) {
  if (!id) { Toast.warning('Save the invoice before checking its send history.'); return; }
  const token = ++_historyToken;
  const modal = Modal.open({
    title: `Send history — invoice ${invoiceNumber || ''}`.trim(),
    className: 'admin-modal--invoice-history',
    body: '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>',
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="close">Close</button>
      <button class="admin-btn admin-btn--primary" data-action="resend">${icon('mail', 14, 14)} Send again</button>`,
    onClose: () => { _historyToken++; },
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="close"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="resend"]').addEventListener('click', async () => {
    // Reuse the one composer rather than growing a second one here.
    Modal.close();
    const rec = await AdminAPI.getInvoice(id);
    if (rec) openEmailDialog(draftFromInvoice(rec));
    else Toast.error('Could not load invoice to email.');
  });

  const fill = async () => {
    const payload = await AdminAPI.listInvoiceEmails(id);
    if (token !== _historyToken) return;             // closed or superseded
    modal.body.innerHTML = renderSentHistory(payload, sentInfo(row));
    const retry = modal.body.querySelector('[data-action="retry-history"]');
    if (retry) {
      retry.addEventListener('click', () => {
        modal.body.innerHTML = '<div class="admin-loader"><div class="admin-loading__spinner"></div></div>';
        fill();
      });
    }
  };
  fill();
}

// Pure: (payload, fallbackInfo) -> HTML. Kept free of DOM access so the three
// branches can be exercised directly in tests.
//
// `payload === null` means the READ FAILED and is never allowed to render as
// "no sends" — that mistake is how an operator double-sends an invoice. An empty
// list with a known emailed_at is the third, distinct case: the send predates the
// log table, so the date is real but the per-send detail was never captured.
//
// `fallbackInfo` is a sentInfo() record, so it carries this browser's own send
// records in `sends`. Those are shown only where they ADD something the server
// log does not already have — a send made seconds ago that the log has not
// caught up on, or any send at all when the log could not be read. Showing them
// alongside a complete log would list one send twice.

/** Local records the server log has not accounted for, newest first. */
function unloggedLocalSends(payload, fallbackInfo) {
  const localOnly = (fallbackInfo?.sends || []).filter(s => s.source === 'local');
  if (!localOnly.length) return [];
  const rows = payload?.emails || [];
  // The log is complete when it accounts for at least as many sends as we do;
  // then our copies are duplicates and add nothing.
  if (payload && (payload.count || rows.length) >= (fallbackInfo?.count || 0)) return [];
  // Belt and braces: never list one within SAME_SEND_MS of a logged row.
  return mergeSends([...rows.map(e => ({ at: e.sent_at, source: 'server' })), ...localOnly])
    .filter(x => x.source === 'local');
}

/** A send this browser recorded — no recipient/subject/status, we never logged them. */
function localSendRow(s) {
  return `<li class="inv-hist__row">
      <div class="inv-hist__when">${esc(sentDateTime(s.at) || 'Date unknown')}</div>
      <div class="inv-hist__to">${esc(s.to || 'Recipient not recorded')}</div>
      <div class="inv-hist__subject">recorded on this browser — not yet in the server log</div>
    </li>`;
}

// Counts are a FLOOR: sends before July 2026 predate the log table entirely, so
// "no more rows" is never "no more sends". Same caveat, same words, as the
// Orders send-history panel.
const HIST_CAVEAT = `<p class="inv-hist__note">Only sends we have a record of are listed.
  Sends made before July 2026 weren’t logged individually, so there may have been earlier
  ones we can’t see.</p>`;

function renderSentHistory(payload, fallbackInfo) {
  if (payload === null) {
    // A read error may still have local records behind it. They are shown as a
    // FLOOR inside the error, never promoted into a clean history.
    const local = (fallbackInfo?.sends || []).filter(s => s.source === 'local');
    const mine = local.length
      ? `<ul class="inv-hist">${local.map(localSendRow).join('')}</ul>
         <p class="inv-hist__note">The ${esc(local.length)} above ${local.length === 1 ? 'is a send' : 'are sends'}
         recorded on this browser. There may be others.</p>`
      : '';
    return `<div class="inv-hist__error">
        <p><strong>Couldn’t load the send history.</strong></p>
        <p>This is a read error, not proof that nothing went out — don’t read it as a clean history.</p>
        <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-action="retry-history">Try again</button>
      </div>${mine}`;
  }

  const rows = payload.emails || [];
  const extraLocal = unloggedLocalSends(payload, fallbackInfo);

  if (!rows.length && !extraLocal.length) {
    if (fallbackInfo?.at) {
      return `<div class="inv-hist__empty">
          <p><strong>Emailed ${esc(formatInvoiceDate(String(fallbackInfo.at).slice(0, 10)))}.</strong></p>
          <p>Sends made before July 2026 weren’t logged individually, so there’s no per-send detail for this one.</p>
        </div>`;
    }
    return `<div class="inv-hist__empty"><p><strong>No send on record for this invoice.</strong></p>
        <p>Use “Send again” below to email the PDF to the customer.</p></div>`;
  }

  const items = rows.map((e) => {
    const when = sentDateTime(e.sent_at);
    const status = String(e.status || 'sent').toLowerCase();
    // A delivery status other than "sent" is the whole reason to open this panel,
    // so it gets a chip; a plain successful send stays quiet.
    const chip = status === 'sent' ? '' : `<span class="inv-hist__status inv-hist__status--${esc(status.replace(/[^a-z]/g, '')) || 'unknown'}">${esc(status)}</span>`;
    return `<li class="inv-hist__row">
        <div class="inv-hist__when">${esc(when || 'Date unknown')}${chip}</div>
        <div class="inv-hist__to">${esc(e.recipient_email || 'Recipient not recorded')}</div>
        ${e.subject ? `<div class="inv-hist__subject">“${esc(e.subject)}”</div>` : ''}
      </li>`;
  });

  // Local-only rows go on top: they are the most recent by construction (the
  // log has not caught up on them yet).
  const list = [...extraLocal.map(localSendRow), ...items].join('');
  const total = Math.max(fallbackInfo?.count || 0, payload.count || 0, rows.length + extraLocal.length);
  const shown = rows.length + extraLocal.length;
  const gap = total > shown
    ? `<p class="inv-hist__note">${esc(recordedSendsPhrase(total, { floor: !!fallbackInfo?.floor }))} in total —
       only the ${esc(shown)} above ${shown === 1 ? 'has' : 'have'} per-send detail.</p>`
    : '';
  return `<ul class="inv-hist">${list}</ul>${gap}${HIST_CAVEAT}`;
}

// The backend echoes supplier_cost_excl_gst on GET /invoices/:id (verified live,
// ERR-071 Jul 2026), so "Our Cost" is read straight from the record in
// draftFromInvoice — no catalogue back-fill needed. The old
// backfillCostsFromCatalogue()/fetchProductCosts workaround (which existed because
// the line was believed to come back null) has been removed.
async function openExisting(row) {
  const rec = await AdminAPI.getInvoice(row.id) || row;
  openEditor(draftFromInvoice(rec));
}

// Quick Order hands off a staged prefill via sessionStorage['qo_invoice_prefill']
// ({ qo_id, order_date, customer{attn,name,company,address,phone,email},
// lines[{code,description,qty,unitCost,supplierCost,costSource}] }). Consume it
// once and open a new invoice editor.
//
// Reads defensively via parseQuickOrderPrefill (utils/quick-order-bridge.js): a
// prefill staged by a PREVIOUS build can still be sitting in a user's sessionStorage
// across a deploy — an old one has no `qo_id` (source_quick_order_id => null, no
// flip) and no cost fields (absent cost => unknown/null, never 0).
//
// `source_quick_order_id` is the link back to the originating quick order. It rides
// ONLY on the live draft (not freshDraft/buildPayload) so it never leaks into the
// invoice payload; persistDraft reads it to flip that quick order to
// status='invoiced' after this invoice saves — the sole double-count guard.
function maybeOpenFromQuickOrder() {
  let raw;
  try { raw = sessionStorage.getItem('qo_invoice_prefill'); } catch (_) { return; }
  if (!raw) return;
  try { sessionStorage.removeItem('qo_invoice_prefill'); } catch (_) { /* noop */ }
  const pre = parseQuickOrderPrefill(raw);
  if (!pre) { warn('bad quick-order prefill', raw); return; }
  const d = freshDraft();
  if (pre.order_date) d.order_date = String(pre.order_date).slice(0, 10);
  if (pre.customer) d.customer = { ...d.customer, ...pre.customer };
  if (pre.lines && pre.lines.length) {
    // The RECEIVING half of the same whitelist — see buildQuickOrderPrefill.
    // Both ends must name a field or it is dropped in transit.
    d.lines = pre.lines.map((l) => ({
      code: l.code || '', description: l.description || '', qty: num(l.qty ?? 1), unitCost: round2(num(l.unitCost ?? 0)),
      supplierCost: costOrNull(l.supplierCost),
      costSource: l.costSource || 'auto',
      // The counter already agreed this price with the customer standing there.
      // It is authored, not a suggestion — the ladder may offer a different
      // number here but must never quietly substitute one.
      priceSource: PRICE_MANUAL,
      volumePercent: l.volumePercent ?? null,
      volumeSaving: l.volumeSaving ?? null,
      volumeQuantity: l.volumeQuantity ?? null,
    }));
  }
  d.source_quick_order_id = pre.source_quick_order_id;
  openEditor(d);
}

// =========================================================================
//  Editor (Drawer)
// =========================================================================
function openEditor(draft) {
  _draft = draft;
  _fillSource = null;
  // The quote describes ONE draft. Carrying any of it into the next editor would
  // put the previous invoice's badges and courier selection on this one.
  resetQuoteState();
  // A SAVED invoice's freight is authored data, so it is the operator's and the
  // quote may not revise it. The value that makes this load-bearing is ZERO: an
  // invoice that shipped free reopens as freight 0 with no courier choice, which
  // is byte-identical to a blank draft — and a blank draft is exactly what the
  // autofill exists to fill in (ERR-178). draft.id is the only thing that tells
  // the two apart. Quick Order and "Fill details from…" open genuinely new drafts
  // and are deliberately left unowned.
  if (draft.id) _freightOwner = FREIGHT_OWNER_OPERATOR;
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
    onClose: () => { if (token === _editorToken) { _editorToken++; teardownAutocompletes(); cancelPreviewFrame(); _draft = null; _editorRefs = null; resetQuoteState(); } },
  });
  if (!drawer) return;
  _editorRefs = { drawer };

  drawer.footer.addEventListener('click', onEditorFooterClick);
  bindEditorBody(drawer);

  // Suggest the next number for a brand-new invoice — auto-filled but editable.
  // Best-effort: if the lookup fails or the operator already typed one, leave it.
  if (!draft.id && !draft.invoice_number) prefillNextNumber(token);

  // Best-effort too: the block renders its own "checking / unavailable" states,
  // so a slow or missing endpoint never blocks the editor from opening.
  ensureBusinessAccounts();
}

// "Last emailed 8th July 2026 to itc@mcgrath.co.nz" — '' for a draft that has
// never been sent (or has never been saved, so it has no id to look up).
// Rendered as a button so it opens the same send-history modal as the list cell;
// returning '' (not an empty button) keeps the `.inv-sent-hint:empty` collapse working.
function sentHintHtml(d) {
  const info = (d && d.id) ? sentInfo(d) : null;
  if (!info) return '';
  const who = info.to ? ` to ${info.to}` : '';
  const label = `Last emailed ${formatInvoiceDate(String(info.at).slice(0, 10))}${who}`;
  return `<button type="button" class="inv-sent-hint__btn" data-ed-action="sent-history" data-id="${escA(d.id)}" data-num="${escA(d.invoice_number)}" title="See every send of this invoice">${esc(label)}</button>`;
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

// =========================================================================
//  Quote — courier options + the per-line volume ladder
// =========================================================================
//
// One read-only call answers both. It is advisory in every direction: it may
// fill a price the operator has not touched and it may offer one they have, but
// it can never overwrite their work, and a quote that fails leaves the draft
// exactly as they left it. Decision logic lives in utils/invoice-quote.js so it
// is testable without a DOM; this half is just plumbing and paint.

/**
 * Drop every trace of the previous draft's quote.
 *
 * `_quoteSeq` is bumped rather than zeroed so a reply still in flight for the
 * OLD draft can never be mistaken for the new one's.
 */
function resetQuoteState() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = null;
  _quoteSeq++;
  _quote = null;
  _quoteStatus = 'idle';
  _volumeOffers = [];
  _freightChoice = null;
  _freightOwner = FREIGHT_OWNER_NONE;
  _shippingRowDirty = false;
  // A statement about the LAST invoice's save, so it must not survive onto the
  // next one. (`_codeChecks` deliberately DOES survive — "is this string a SKU"
  // is a fact about the catalogue, not about a draft, so the answer is still
  // true on the next invoice and re-asking would be wasted.)
  _refNotStored = false;
  clearTimeout(_codeCheckTimer);
  _codeCheckQueue.clear();
}

/** Debounced re-quote. Safe to call from any edit handler. */
function scheduleQuote() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = setTimeout(() => { requestQuote(); }, QUOTE_DEBOUNCE_MS);
}

/**
 * Fetch a quote and fold it into the draft.
 *
 * TWO guards, both load-bearing:
 *   • `_editorToken` — the drawer can close mid-flight (ERR-045). Nothing may be
 *     written to a draft that is no longer on screen.
 *   • `_quoteSeq` — replies can land out of order, and an older one carries an
 *     older quantity. Only the newest is allowed to touch anything. (The
 *     autocomplete component guards the same way; API.request() cannot be
 *     aborted, because it overwrites any signal a caller passes.)
 */
async function requestQuote() {
  const token = _editorToken;
  const seq = ++_quoteSeq;
  const req = quoteRequestBody(_draft);
  if (!req) return;   // nothing typed yet — a quote would say nothing

  if (req.truncated > 0) {
    // Never silently. 200 lines on one invoice is not a real scenario, but a
    // truncated quote that says nothing looks exactly like a correct one.
    warn(`quote covers the first ${MAX_QUOTE_LINES} lines; ${req.truncated} were not priced`);
  }

  if (_quoteStatus !== 'ready') { _quoteStatus = 'loading'; renderShippingRow(); }

  const res = await AdminAPI.quoteInvoice(req.body);
  if (!editorAlive(token) || seq !== _quoteSeq) return;

  if (!res.ok) {
    // Keep the last good quote — a rate limit or a blip must not blank the
    // dropdown, and it must not clear a price we already filled.
    _quoteStatus = res.code === 'RATE_LIMITED' ? 'limited' : 'unavailable';
    renderShippingRow();
    return;
  }

  const quote = normalizeQuote(res.data);
  if (!quote) { _quoteStatus = 'unavailable'; renderShippingRow(); return; }

  _quote = quote;
  _quoteStatus = 'ready';
  applyQuote(quote);
}

/**
 * Fold a fresh quote into the lines and the shipping row.
 *
 * PATCHES, never re-renders (ERR-179). This is the one path into the line grid
 * that the operator did not ask for: it is armed by a keystroke and lands 400ms
 * plus a round-trip later, which is squarely in the middle of the next word they
 * are typing. `renderLines()` here replaced every <input> in the grid, so the box
 * under the caret was destroyed and the product dropdown anchored to it orphaned
 * — the "screen keeps refreshing" that made the Product Code field unusable.
 *
 * A quote is safe to fold in this way because of how narrow it is: see
 * applyQuoteToLines(), which never adds, removes or reorders a row and never
 * touches code, description, qty, supplierCost, costSource or kind. Price and
 * badge are the whole surface, and both are cells.
 *
 * The `changed` distinction survives because it still decides whether the
 * customer-facing preview and the margin readout need repainting — an offer
 * badge appearing changes what the OPERATOR is offered, not what the invoice
 * says. patchQuotedLineRows() returning false means the DOM and the draft
 * disagree about how many rows exist, which no cell-write can repair: fall back
 * to the full render rather than leave half a grid describing the wrong lines.
 */
function applyQuote(quote) {
  const { lines, offers, changed } = applyQuoteToLines(_draft.lines, quote);
  _volumeOffers = offers;
  if (changed) _draft.lines = lines;

  const host = _editorRefs?.drawer.body.querySelector('#inv-lines');
  const patched = patchQuotedLineRows(host, _draft.lines, { noteHtml: lineQuoteNote });
  if (!patched) renderLines();

  // The margin readout reads every line's price, so it moves whenever one does —
  // renderLines() used to carry it in for free, and a patch has to say so.
  if (changed) refreshPreview();
  else renderCogsPanel();

  reconcileShipping(quote);
}

/**
 * Keep the freight field honest as the goods total moves.
 *
 * The one case that must be LOUD in BOTH directions: freight and the threshold
 * disagree. Free was selected and the order has since fallen below it — doing
 * nothing leaves $0 in the box and a courier parcel is invoiced at nothing. Or
 * the order has just crossed it and the freight showing is a rate WE guessed
 * before the price existed — doing nothing bills a customer for shipping they
 * qualified out of (ERR-178). Both write the real figure and say so.
 *
 * What is never touched is a freight figure the OPERATOR authored — picked,
 * typed, loaded from an order or invoice, or billed as a shipping line. For them
 * free shipping becoming available is still only ever OFFERED
 * (freeShippingAvailable → the "apply" button): they may be charging freight
 * deliberately, and overwriting their number to be helpful is how you lose their
 * trust in every other autofill on the page. Ownership is the whole distinction;
 * see the FREIGHT_OWNER_* block in invoice-quote.js.
 */
function reconcileShipping(quote) {
  const lost = freeShippingLost(_freightChoice, quote.shipping);
  if (lost.lost && lost.fallbackOption) {
    // Deliberately ahead of ownership: an operator who chose free shipping on an
    // order that no longer qualifies still must not ship a parcel billed at $0.
    // Ownership is left exactly as it was — ours stays revisable, theirs keeps
    // the offer-only path if the order climbs back over the threshold.
    _freightChoice = lost.fallbackKey;
    setFreightValue(lost.fallbackOption.freightExclGst);
    Toast.warning(`Free shipping no longer applies — this order is under $${num(quote.shipping.freeShippingThreshold) || 100}. Freight set to ${lost.fallbackOption.label}.`);
    refreshPreview();
    renderShippingRow();
    return;
  }

  const plan = planFreightAutofill(quote.shipping, {
    owner: _freightOwner,
    choice: _freightChoice,
    freight: _draft.freight,
  });
  if (plan.apply) {
    _freightChoice = plan.key;
    _freightOwner = plan.owner;
    setFreightValue(plan.option.freightExclGst);
    if (plan.announce === 'free') {
      // The figure is named because the threshold is judged on the GST-INCLUSIVE
      // goods total while the freight box beside it is ex-GST. "$113.85 incl GST"
      // is the answer to the question this behaviour otherwise provokes.
      const goods = num(quote.shipping.goodsTotalInclGst);
      const threshold = num(quote.shipping.freeShippingThreshold) || 100;
      Toast.success(goods > 0
        ? `Free shipping now applies — $${goods.toFixed(2)} incl GST is over the $${threshold} threshold. Freight set to $0.00.`
        : `Free shipping now applies. Freight set to $0.00.`);
    } else if (plan.announce === 'courier') {
      Toast.warning(`Free shipping no longer applies — freight set to ${plan.option.label}.`);
    }
    refreshPreview();
  }
  renderShippingRow();
}

/**
 * The operator picked a courier option. Writing its `freight_excl_gst` into the
 * existing freight field is the entire integration — nothing else changes, and
 * the save path never learns this dropdown exists.
 */
function onFreightOptionPick(key) {
  _freightChoice = key || null;
  _freightOwner = FREIGHT_OWNER_OPERATOR;   // they chose; we never revise it again
  if (key === FREIGHT_CUSTOM) { renderShippingRow(); return; }
  const opt = (_quote?.shipping.options || []).find((o) => o.key === key);
  if (!opt) { renderShippingRow(); return; }
  setFreightValue(opt.freightExclGst);
  renderShippingRow();
  refreshPreview();
}

/**
 * Write a freight figure into the draft AND the input the operator can see.
 *
 * The draft is written unconditionally — that figure is the durable record and a
 * quote reply is entitled to it. The BOX is not written while the caret is in it
 * (ERR-179): reconcileShipping() runs off an async reply, so without this it
 * rewrites the number mid-keystroke, and typing `12.50` over an adopted `7.00`
 * fights the autofill character by character. Same rule the storefront cart
 * applies to its quantity field (js/cart.js:2312, js/cart-page.js:600).
 *
 * Nothing is lost by skipping the paint: the operator is looking at the box, and
 * their next keystroke sets `_freightOwner` to OPERATOR, which stops the autofill
 * revising it again anyway.
 */
function setFreightValue(exGst) {
  _draft.freight = round2(num(exGst));
  const input = _editorRefs?.drawer.body.querySelector('[data-field="freight"]');
  if (input && input !== document.activeElement) input.value = String(_draft.freight);
}

/**
 * Stop reconcileShipping() auto-adopting a courier rate on top of a freight LINE.
 *
 * That branch exists for the common case — a brand-new draft whose $0 freight box
 * nobody has touched adopts the backend's suggested rate so the operator needs no
 * clicks. On an invoice that bills freight AS A LINE ITEM it is a double charge:
 * the quote returns a moment after the row is added and silently drops e.g. $7.00
 * into the freight box beside the $150 already typed, and the only place it shows
 * is the totals block (ERR-174).
 *
 * Adding a shipping line IS the operator stating their freight intent, so the
 * choice stops being null. FREIGHT_CUSTOM is the same value a hand-typed freight
 * figure sets (onFormInput) and renderShippingRow already reads it as
 * "Custom — typed above". An operator who had already picked a courier option
 * keeps it — they asked for that one.
 */
function suppressFreightAutofill() {
  if (_freightChoice == null) _freightChoice = FREIGHT_CUSTOM;
  // Billing freight as a LINE is the operator stating their freight intent just
  // as firmly as typing in the box, so the figure stops being ours to revise.
  // Without this, ERR-178's re-adoption would reintroduce ERR-174's double charge
  // the moment the order crossed the threshold in either direction.
  _freightOwner = FREIGHT_OWNER_OPERATOR;
}

function bindEditorBody(drawer) {
  const form = drawer.body.querySelector('.invoice-editor__form');
  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('click', onFormClick);
  form.addEventListener('focusout', onFormFocusOut);
  renderLines();
  attachTopAutocompletes();
  refreshPreview();
  renderShippingRow();
  renderRefWarning();   // survives a rebuildEditor() — the fact is about the save, not the DOM
  // First quote on open: populates the courier dropdown, and prices any line the
  // draft arrived with (fill-from-order, fill-from-quick-order) — those are all
  // 'manual', so it can only ever offer, never rewrite.
  scheduleQuote();
}

// Replace the body in-place (used after an auto-fill that touches many fields).
function rebuildEditor() {
  if (!_editorRefs) return;
  // setBody() drops the whole form, inputs and all. Their portalled menus would
  // outlive it (ERR-179) — attachTopAutocompletes() drains its own register, so
  // only the line handles need doing here.
  destroyHandles(_acLineHandles);
  _editorRefs.drawer.setBody(editorBodyHtml(_draft));
  bindEditorBody(_editorRefs.drawer);
}

function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] = o[parts[i]] || {});
  o[parts[parts.length - 1]] = val;
}

/**
 * Keep a row's credit-line signals true while the operator types.
 *
 * Two of them: the price box goes red-ish so a stray minus reads as deliberate,
 * and the Our Cost placeholder switches to "0.00 — credit", which is the visible
 * half of lineSupplierCost()'s rule that a credit line has no goods behind it.
 * Both are set from renderLines() on a full paint; this is the live path. The
 * margin bar needs no nudge here — onFormInput ends in refreshPreview(), and
 * paintPreview() repaints it for exactly this reason.
 */
function markCreditRow(priceEl, i) {
  const credit = num(_draft.lines[i]?.unitCost) < 0;
  priceEl.classList.toggle('inv-line__price--credit', credit);
  // Through costPlaceholder(), never a second copy of its rules. This line used
  // to carry its own two-case version, and the moment a third case existed
  // (a custom item) it started overwriting the right answer with a stale one:
  // typing a price on a custom line reset its cost box from "needs a cost" back
  // to "auto". One question, one function.
  const cost = priceEl.closest('.inv-line')?.querySelector('[data-lfield="supplierCost"]');
  if (cost) cost.placeholder = costPlaceholder(_draft.lines[i]);
}

function onFormInput(e) {
  const t = e.target;
  if (t.dataset.field) {
    setPath(_draft, t.dataset.field, t.type === 'checkbox' ? t.checked : t.value);
    // Picking an account changes what the block SAYS ("Linked to Acme" vs "Not
    // linked"), and that sentence is the only feedback that the invoice will
    // now be visible to a customer. Re-render it rather than leaving the old
    // state on screen next to the new selection.
    if (t.dataset.field === 'business_account_id') {
      const host = _editorRefs?.drawer?.body?.querySelector('#inv-biz-link');
      if (host) host.outerHTML = businessLinkHtml(_draft);
    }
    // A hand-typed freight figure wins over any courier option. Don't fight the
    // operator — just relabel the dropdown "Custom" so it stops claiming to
    // describe a number it no longer set.
    if (t.dataset.field === 'freight') {
      _freightChoice = FREIGHT_CUSTOM;
      _freightOwner = FREIGHT_OWNER_OPERATOR;
      renderShippingRow();
    }
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
      // Typing a PRICE does the same for the sell side, and additionally drops
      // any volume claim: the number is now theirs, so "−6% off" beside it would
      // describe a discount we did not give. The ladder becomes an offer.
      if (f === 'unitCost') {
        _draft.lines[i].priceSource = PRICE_MANUAL;
        // Both claims describe a price we are no longer the author of. The
        // volume badge goes for the reason it always has; the manual discount
        // goes because "$40.00 off" is a statement about a number the operator
        // has just replaced, and re-deriving it from the new one would be
        // inventing a discount nobody gave.
        _draft.lines[i] = clearDiscount(clearVolume(_draft.lines[i]));
        // Repaint the two things the row says about a credit line. Deliberately
        // by TOUCHING the existing nodes rather than calling renderLines(): the
        // operator is typing in one of them, and re-rendering the grid under the
        // caret is precisely ERR-179. Nothing here writes a .value.
        markCreditRow(t, i);
      }
      // Code and quantity both change what the ladder says; price changes what
      // the free-shipping goods total is. All three are worth a re-quote.
      if (f === 'code' || f === 'qty' || f === 'unitCost') scheduleQuote();
    }
  } else if (t.matches('[data-freight-option]')) {
    onFreightOptionPick(t.value);
    return;
  } else { return; }
  // Clear the error highlight on the field as soon as the user edits it.
  t.classList.remove('admin-input--error', 'admin-select--error');
  t.closest('.inv-field')?.classList.remove('inv-field--error');
  refreshPreview();
}

/**
 * "Add custom item" — invoice something that isn't in the catalogue.
 *
 * Mirrors addShippingLine() deliberately, including replacing a pristine default
 * row rather than appending to it: one click on a fresh draft is a complete
 * custom-item invoice, needing only the words and the figure.
 *
 * Focus lands on the DESCRIPTION, not the reference: the description is what
 * identifies the item to the customer and is the only part that must be filled.
 * The reference is optional — a custom line with no ref simply prints a blank
 * code column, exactly like a freight line always has.
 */
function addCustomLine() {
  const only = _draft.lines.length === 1 ? _draft.lines[0] : null;
  const pristine = !!only && !(only.code || '').trim() && !(only.description || '').trim()
    && !(only.ref || '').trim() && !num(only.unitCost);

  if (pristine) _draft.lines[0] = customLine();
  else _draft.lines.push(customLine());
  const i = _draft.lines.length - 1;

  renderLines();
  refreshPreview();
  focusLineField(i, 'description');
}

/**
 * "Keep as a custom item" — the way out of a code that isn't a SKU.
 *
 * Before this existed the only exit was the last clause of skuLineMsg ("or clear
 * the code to keep it as a free-text line"), which the operator met at SAVE,
 * after filling in the whole invoice, as an error. The text they typed was
 * something they meant; the only thing wrong with it was WHICH FIELD it was in.
 * So move it rather than ask them to delete it: the typed code becomes the
 * line's `ref`, `code` is cleared, and the row is a custom item.
 *
 * The price becomes MANUAL because nothing can quote a non-catalogue item, and
 * any volume claim goes with it — a badge here would describe a ladder that was
 * never consulted.
 */
function makeLineCustom(i) {
  const l = _draft.lines[i];
  if (!l) return;
  const typed = (l.code || '').trim();
  _draft.lines[i] = clearVolume({
    ...l,
    kind: 'custom',
    ref: (l.ref || '').trim() || typed,
    code: '',
    priceSource: PRICE_MANUAL,
  });
  if (typed) _codeChecks.delete(typed.toLowerCase());
  renderLines();
  refreshPreview();
  scheduleQuote();
  focusLineField(i, (l.description || '').trim() ? 'ref' : 'description');
}

/**
 * The discount actions. Every one of them ends with the price box holding the
 * NET figure and `discountSaving` describing what came off — the same shape the
 * volume ladder leaves behind, so the document, the payload and the totals need
 * no special case anywhere.
 */
function setDiscountOpen(i, open) {
  const l = _draft.lines[i];
  if (!l) return;
  l.discountOpen = open;
  renderLines();
  if (open) {
    const amt = _editorRefs?.drawer.body.querySelector(`[data-disc-amt="${i}"]`);
    if (amt) { amt.focus(); amt.select?.(); }
  }
}

function applyLineDiscount(i) {
  const body = _editorRefs?.drawer.body;
  const l = _draft.lines[i];
  if (!l || !body) return;
  const amount = round2(num(body.querySelector(`[data-disc-amt="${i}"]`)?.value));
  const why = String(body.querySelector(`[data-disc-why="${i}"]`)?.value || '').trim();
  const qty = num(l.qty) || 1;
  const gross = round2(num(l.unitCost) * qty);

  if (!(amount > 0)) { Toast.warning('Enter how much to take off this line.'); return; }
  // A DISCOUNT MAY NOT EXCEED THE LINE. Past that it stops being a discount and
  // becomes a credit — which is the thing the invoice service will not store at
  // all (BF-050), so letting it through here would only move the failure to Save.
  if (amount > gross) {
    Toast.warning(`That is more than this line is worth (${money(gross)} excl. GST). Reduce it, or split the credit across lines.`);
    return;
  }

  // round2 ONCE, here, into the price the backend will be given. The saving is
  // then re-derived from what the price actually became, so what prints is the
  // money that was really taken off — never the typed figure that a rounded
  // unit price could not quite deliver.
  const netUnit = round2(num(l.unitCost) - amount / qty);
  const effective = round2((num(l.unitCost) - netUnit) * qty);

  _draft.lines[i] = clearVolume({
    ...l,
    unitCost: netUnit,
    priceSource: PRICE_MANUAL,   // ours now; the ladder must never re-price it
    discountSaving: effective,
    discountNote: why,
    discountOpen: false,
  });
  renderLines();
  refreshPreview();
  scheduleQuote();
}

/** Put the price back. The saving says exactly how much to add. */
function undoLineDiscount(i) {
  const l = _draft.lines[i];
  if (!l) return;
  const qty = num(l.qty) || 1;
  _draft.lines[i] = clearDiscount({
    ...l,
    unitCost: round2(num(l.unitCost) + num(l.discountSaving) / qty),
    discountOpen: false,
  });
  renderLines();
  refreshPreview();
  scheduleQuote();
}

/**
 * "Apply to the line above" — the way out of a credit row that cannot be saved.
 *
 * A standalone negative line is refused by the invoice service outright (both
 * the price and the quantity are floored at zero, and a `line_total` or
 * `discount` key is ignored — measured, BF-050). Rather than leave the operator
 * at a dead end, fold it: the line above drops by the credit's value, inherits
 * its description as the reason, and the credit row goes.
 *
 * The recorded saving is what the price ACTUALLY moved by, not the credit's face
 * value — a rounded unit price on a multi-quantity line can differ by a cent, and
 * the note has to state the money that really came off.
 */
function foldCreditIntoPrevious(i) {
  const credit = _draft.lines[i];
  const target = _draft.lines[i - 1];
  if (!credit || !target) return;
  const creditValue = round2(Math.abs(num(credit.unitCost) * (num(credit.qty) || 1)));
  const tQty = num(target.qty) || 1;
  const gross = round2(num(target.unitCost) * tQty);
  if (creditValue > gross) {
    Toast.warning(`That credit (${money(creditValue)}) is bigger than the line above (${money(gross)} excl. GST). Reduce it, or split it across lines.`);
    return;
  }
  const netUnit = round2(num(target.unitCost) - creditValue / tQty);
  const effective = round2((num(target.unitCost) - netUnit) * tQty);

  _draft.lines[i - 1] = clearVolume({
    ...target,
    unitCost: netUnit,
    priceSource: PRICE_MANUAL,
    discountSaving: round2(num(target.discountSaving) + effective),
    discountNote: (credit.description || '').trim() || target.discountNote || '',
    discountOpen: false,
  });
  _draft.lines.splice(i, 1);
  if (!_draft.lines.length) _draft.lines.push(blankLine());
  // Positions shifted, so every cached answer is about the wrong row now.
  _quote = null; _volumeOffers = [];
  renderLines();
  refreshPreview();
  scheduleQuote();
}

/** Put the caret in one line's field after a re-render. */
function focusLineField(i, lfield) {
  const el = _editorRefs?.drawer.body.querySelector(`[data-line="${i}"][data-lfield="${lfield}"]`);
  if (el) { el.focus(); el.select?.(); }
}

/**
 * "Add shipping charge" — bill freight with no product behind it.
 *
 * A pristine default row is a placeholder, not content, so a brand-new invoice
 * gets its single blank line REPLACED rather than appended to: one click on a
 * fresh draft is a complete shipping-only invoice, needing only the amount.
 *
 * Focus lands on the amount, not the description: the description is already
 * filled and the figure is the one thing that must be typed.
 */
function addShippingLine() {
  const only = _draft.lines.length === 1 ? _draft.lines[0] : null;
  const pristine = !!only && !(only.code || '').trim() && !(only.description || '').trim()
    && !num(only.unitCost);

  if (pristine) _draft.lines[0] = shippingLine();
  else _draft.lines.push(shippingLine());
  const i = _draft.lines.length - 1;

  suppressFreightAutofill();
  renderLines();
  refreshPreview();
  scheduleQuote();

  const amount = _editorRefs?.drawer.body
    .querySelector(`[data-line="${i}"][data-lfield="unitCost"]`);
  if (amount) { amount.focus(); amount.select?.(); }
}

/**
 * Pay off a render that was postponed to keep focus (ERR-179).
 *
 * renderShippingRow() declines to rebuild the courier <select> while that select
 * has focus. This is the other half of that bargain: the moment focus leaves,
 * the row is painted with whatever the last quote decided. Without it the flag
 * would be a silent skip, and the row could sit indefinitely showing a rate the
 * quote had already withdrawn.
 */
function onFormFocusOut(e) {
  // A finished code is a code worth checking. focusout, not input: mid-typing,
  // "CTN2" is not a wrong SKU, it is an unfinished one.
  if (e.target?.dataset?.lfield === 'code') scheduleCodeCheck(e.target.value);
  if (!_shippingRowDirty) return;
  if (!e.target?.matches?.('[data-freight-option]')) return;
  // Focus has not landed yet at focusout time; renderShippingRow reads
  // document.activeElement and would defer all over again.
  setTimeout(() => { if (_editorRefs && _shippingRowDirty) renderShippingRow(); }, 0);
}

function onFormClick(e) {
  const act = e.target.closest('[data-form-action]')?.dataset.formAction;
  if (!act) return;
  if (act === 'add-line') { _draft.lines.push(blankLine()); renderLines(); refreshPreview(); scheduleQuote(); }
  else if (act === 'add-shipping') { addShippingLine(); }
  else if (act === 'add-custom') { addCustomLine(); }
  else if (act === 'make-custom') { makeLineCustom(+e.target.closest('[data-line]').dataset.line); }
  else if (act === 'open-discount') { setDiscountOpen(+e.target.closest('[data-line]').dataset.line, true); }
  else if (act === 'close-discount') { setDiscountOpen(+e.target.closest('[data-line]').dataset.line, false); }
  else if (act === 'apply-discount') { applyLineDiscount(+e.target.closest('[data-line]').dataset.line); }
  else if (act === 'undo-discount') { undoLineDiscount(+e.target.closest('[data-line]').dataset.line); }
  else if (act === 'fold-credit') { foldCreditIntoPrevious(+e.target.closest('[data-line]').dataset.line); }
  else if (act === 'remove-line') {
    const i = +e.target.closest('[data-line]').dataset.line;
    _draft.lines.splice(i, 1);
    if (!_draft.lines.length) _draft.lines.push(blankLine());
    // Positions shift, so every cached answer is now about the wrong row. Drop
    // them rather than re-index — a badge on the wrong line is worse than none.
    _quote = null; _volumeOffers = [];
    renderLines(); refreshPreview(); scheduleQuote();
  } else if (act === 'apply-volume') {
    // The ONE path by which a hand-edited price is replaced: the operator asked.
    const i = +e.target.closest('[data-line]').dataset.line;
    const offer = _volumeOffers.find((o) => o.position === i);
    if (!offer || !_draft.lines[i]) return;
    _draft.lines[i] = {
      ..._draft.lines[i],
      unitCost: offer.badge.unitPrice,
      priceSource: PRICE_AUTO,
      volumePercent: offer.badge.percent,
      volumeSaving: offer.badge.lineSaving,
      volumeQuantity: num(_draft.lines[i].qty),
    };
    _volumeOffers = _volumeOffers.filter((o) => o.position !== i);
    renderLines(); refreshPreview();
  } else if (act === 'apply-free-shipping') {
    const free = (_quote?.shipping.options || []).find((o) => o.key === 'free');
    if (!free) return;
    _freightChoice = 'free';
    _freightOwner = FREIGHT_OWNER_OPERATOR;
    setFreightValue(free.freightExclGst);
    renderShippingRow(); refreshPreview();
  } else if (act === 'link-business') {
    // Only ever reached by an explicit click on the suggestion. Nothing in
    // suggestedBusinessAccount() assigns — see businessLinkHtml().
    const id = e.target.closest('[data-account-id]')?.dataset.accountId || null;
    if (!id) return;
    _draft.business_account_id = id;
    const host = _editorRefs?.drawer?.body?.querySelector('#inv-biz-link');
    if (host) host.outerHTML = businessLinkHtml(_draft);
    Toast.success('Linked — save the invoice to publish it to their portal.');
  } else if (act === 'unlink-business') {
    _draft.business_account_id = null;
    const host = _editorRefs?.drawer?.body?.querySelector('#inv-biz-link');
    if (host) host.outerHTML = businessLinkHtml(_draft);
    Toast.success('Unlinked — save to remove it from their portal.');
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
  const el = e.target.closest('[data-ed-action]');
  const act = el?.dataset.edAction;
  if (!act) return;
  if (act === 'cancel') { Drawer.close(); return; }
  if (act === 'sent-history') { openSentHistory(el.dataset.id, el.dataset.num, _draft); return; }
  if (act === 'download') { downloadPdf(_draft); return; }
  if (act === 'save') { await saveInvoice(); return; }
  if (act === 'email') {
    // Need a saved invoice (id + assigned number) before we can email its PDF.
    if (!_draft.id) {
      if (!ensureInvoiceValid()) return;
      const btn = e.target.closest('[data-ed-action="email"]');
      if (btn) btn.disabled = true;
      try { await persistDraft(); rebuildEditor(); loadData(); }
      catch (err) {
        if (surfaceUnresolvedCodes(err, _editorToken)) return;
        Toast.error(err.message || 'Save the invoice before emailing it.'); return;
      }
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
      // What the cell claimed BEFORE this send. Read now, not after, and passed
      // in so writeSent APPENDS to it: rebuilding the record from the one send
      // just made resets the tally to 1 on every resend (ERR-177), and on a
      // legacy row — a real `emailed_at` with `email_count: 0` — it would erase
      // the earlier send the server cannot count for us.
      const priorCount = sentInfo(d)?.count || 0;
      await AdminAPI.emailInvoice(d.id, { to, subject: subj, body: msg });
      writeSent(d.id, to, priorCount);  // only on success — a failed send leaves the row unmarked
      Toast.success('Invoice emailed to customer.');
      Modal.close();
      refreshSentHint();            // editor footer, when the drawer is open behind the modal
      if (_table) loadData();       // repaint the Sent cell (picks up the server value once it ships)
    } catch (err) {
      // POST /:id/email is live (probed 401, 2026-07-31) — a failure is a failure.
      Toast.error(err.message || 'Could not email that invoice. Try again.');
      sendBtn.disabled = false;
    }
  });
}

// Required-field validation. Returns an array of error targets (empty = valid):
//   { field: 'customer.name', msg }        — a top-level/nested data-field input
//   { line: i, lfield: 'qty', msg }         — a line-item input
// Essentials only: a customer name + at least one *complete* line item (code or
// description, AND qty > 0, AND a unit price that is a NUMBER — of either sign,
// see isPricedAmount). Fully-blank phantom rows are ignored.
function validateInvoice(d) {
  const errs = [];
  if (!d) return errs;
  if (!(d.customer.name || '').trim())
    errs.push({ field: 'customer.name', msg: 'Customer name is required' });
  if (!lines(d.customer.address).length)
    errs.push({ field: 'customer.address', msg: 'Bill To address is required' });
  if (!(d.order_date || '').trim())
    errs.push({ field: 'order_date', msg: 'Date order placed is required' });

  // A ROW WITH SOMETHING IN IT. The price clause is `!== 0`, never `> 0`: a
  // credit line's whole content may be its negative amount, and this predicate
  // has to agree with invoiceDocRows()' filter (utils/invoice-math.js), which
  // tests plain truthiness and therefore already PRINTS such a row. `ref` is in
  // the set for the same reason: a custom item carries no code, so its reference
  // is the thing that makes the row real. All three predicates — this one,
  // realLines() and invoiceDocRows() — must answer the same question. While the
  // two disagreed, a negative-only row went on the customer's document and into
  // preview_totals while being skipped here and dropped from line_items by
  // realLines() — unreachable only because the price could not be typed.
  // tests/admin-invoice-negative-line-aug2026.test.js pins them equal.
  const started = (d.lines || [])
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => (l.code || '').trim() || (l.description || '').trim() || (l.ref || '').trim()
      || num(l.qty) > 0 || num(l.unitCost) !== 0);   // ignore fully-blank phantom rows

  if (!started.length) {
    errs.push({ line: 0, lfield: 'code', msg: 'Add at least one line item' });
  } else {
    started.forEach(({ l, i }) => {
      if (!((l.code || '').trim() || (l.description || '').trim()))
        errs.push({ line: i, lfield: 'code', msg: `Line ${i + 1}: code or description required` });
      if (!(num(l.qty) > 0))  errs.push({ line: i, lfield: 'qty', msg: `Line ${i + 1}: quantity required` });
      // A PRICE IS A NUMBER, OF EITHER SIGN. This used to demand `> 0`, which
      // made a credit line impossible and reported it as "required" — the same
      // message an empty box gets, so the operator could not tell the figure had
      // been refused rather than missed. Blank and non-numeric are what is
      // actually wrong; 0 and negatives are both legitimate amounts.
      if (!isPricedAmount(l.unitCost))
        errs.push({ line: i, lfield: 'unitCost', msg: `Line ${i + 1}: unit price required` });
    });
  }

  // Freight has no sign either, and `min="0"` on its box does not enforce one —
  // the editor is a <div>, not a <form>, so nothing ever calls checkValidity().
  // A negative freight prints on the customer's invoice as "Free" (both
  // renderPreview and buildInvoiceDoc test `t.freight > 0`) while still pulling
  // that money out of the total. Catch it here, where the sign is the subject.
  if (num(d.freight) < 0)
    errs.push({ field: 'freight', msg: 'Freight cannot be negative — use a line discount for money off' });

  // A CREDIT ROW NEVER REACHES THE SERVER. Measured, not assumed: POST
  // /api/admin/invoices floors unit_cost_excl_gst AND quantity at zero, and
  // ignores line_total_excl_gst and any discount key — the totals are recomputed
  // from qty × price, so nothing can pull one down (BF-050). Blocking it HERE,
  // naming the one-click fix, is the difference between a dead end and a
  // next step; saveErrorMessage's translation of the raw 400 stays only as a
  // backstop for the paths this cannot see.
  (d.lines || []).forEach((l, i) => {
    if (num(l.unitCost) >= 0) return;
    errs.push({
      line: i,
      lfield: 'unitCost',
      msg: i > 0
        ? `Line ${i + 1} is a credit of ${money(Math.abs(num(l.unitCost) * (num(l.qty) || 1)))} — use “Apply to the line above” on that row, or make the price positive`
        : `Line ${i + 1} is a credit, and there is no line above it to take it off. Move it below the line it discounts.`,
    });
  });

  // AN INVOICE THAT OWES THE CUSTOMER MONEY IS A CREDIT NOTE, NOT AN INVOICE.
  // Credit lines are meant to bring a total DOWN, not through the floor. $0 is
  // deliberately still legal — "you already paid for all of it" is the whole
  // point of the feature — so this fires only below zero, and it points at the
  // first credit line, which is the box that has to change.
  const total = computeTotals(d).total;
  if (total < 0) {
    const firstCredit = (d.lines || []).findIndex((l) => num(l.unitCost) < 0);
    errs.push({
      line: firstCredit === -1 ? 0 : firstCredit,
      lfield: 'unitCost',
      msg: `The credit lines exceed the charges — this invoice totals ${money(total)}`,
    });
  }
  return errs;
}

/**
 * Has a price actually been entered? Blank and non-numeric are the only answers
 * that are "no". NB the shape matters: blankLine() seeds `unitCost: 0` as a
 * NUMBER, so a falsiness test here would flag every fresh row.
 */
function isPricedAmount(v) {
  const raw = String(v ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw));
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

/**
 * Every line code must be a real products.sku before anything is written.
 *
 * The backend matches an invoice's line items to the catalogue BY SKU when it
 * materialises the shadow order, so a series/base code typed off the box (`CTN258`
 * instead of `CTN258XLKCMY`) drops the line and leaves a paid order with nothing in
 * it — ERR-071, invoices #3263/#3264. The picker never causes this (it stores
 * product.sku verbatim); a code TYPED into the free-text box does.
 *
 * Resolvable codes are canonicalised in place, so this also fixes casing before the
 * payload is built. Unresolvable ones are highlighted and the save is aborted —
 * throwing is what stops it, because all three persisting paths (save, email,
 * download) funnel through here and each already surfaces err.message as a toast.
 *
 * Fail-soft: resolveSkus returns null when the catalogue is unreachable, and an
 * outage of OURS must never be the reason an operator can't invoice a customer.
 */
async function verifyLineCodes() {
  const token = _editorToken;
  const lines = _draft?.lines || [];
  const resolved = await resolveSkus(codesToVerify(lines));
  if (!resolved) { warn('SKU verification skipped — catalogue unreachable'); return; }
  const errs = applyResolvedCodes(lines, resolved);
  if (!errs.length) return;
  // The editor can be closed while the lookup is in flight (ERR-045). Still abort
  // the write — an unresolvable code must never be persisted — but only paint the
  // form when it's still the form we validated.
  const first = editorAlive(token) ? markInvoiceErrors(errs) : null;
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus({ preventScroll: true }); }
  throw new Error(errs.length === 1 ? errs[0].msg : `${errs.length} lines have a code that isn’t a product SKU — pick each product from the list.`);
}

async function persistDraft() {
  await verifyLineCodes();
  const payload = buildPayload(_draft);
  const saved = _draft.id
    ? await AdminAPI.updateInvoice(_draft.id, payload)
    : await AdminAPI.createInvoice(payload);
  if (saved) {
    _draft.id = saved.id ?? _draft.id;
    if (saved.invoice_number) _draft.invoice_number = saved.invoice_number;
    const st = serverTotals(saved);
    if (st) _draft._serverTotals = st;
    noteRefEcho(payload, saved);
    // Push the rendered PDF up so the backend serves/emails the same document.
    try { await syncStoredPdf(); }
    // POST /:id/pdf is live (probed 401, 2026-07-31); this stays non-fatal because
    // the invoice itself saved, but don't log it as an unbuilt endpoint.
    catch (err) { warn('stored-PDF sync failed (invoice itself saved)', err); }
    // Only now that the invoice truly exists: flip its source quick order (if any)
    // to status='invoiced' so the sale isn't counted twice.
    await flipSourceQuickOrder();
  }
  return saved;
}

/**
 * Did the invoice service keep the operator's own references?
 *
 * `product_ref` has no column yet (live read of saved invoices, 2026-08-28: line
 * items carry exactly product_code, description, quantity, unit_cost_excl_gst,
 * line_total_excl_gst, supplier_cost_excl_gst, cost_source). Unknown keys are
 * dropped silently, which is the precedent `delivery` and the volume fields
 * already live with — but those are figures we can re-derive, and this is text
 * the operator TYPED. Losing it without saying so would mean reopening the
 * invoice next month and finding the code column blank, with no clue why.
 *
 * So: MEASURE, don't assume. Compare what we sent against what came back. This
 * is the same UNKNOWN-≠-absent discipline used everywhere else here, and it
 * SELF-HEALS — the day the column ships, the echo carries the key, this returns
 * false and the warning stops appearing with no code change. Nothing to
 * remember to remove. BF-051.
 */
const DISPLAY_ONLY_KEYS = ['product_ref', 'discount_note'];

function refEchoMissing(payload, saved) {
  const back = saved?.line_items ?? saved?.invoice?.line_items;
  if (!Array.isArray(back) || !back.length) return false;   // nothing echoed — can't tell
  return DISPLAY_ONLY_KEYS.some((key) => {
    const sent = (payload?.line_items || []).some((li) => li[key]);
    if (!sent) return false;
    return !back.some((li) => li && Object.prototype.hasOwnProperty.call(li, key));
  });
}

function noteRefEcho(payload, saved) {
  _refNotStored = refEchoMissing(payload, saved);
  renderRefWarning();
}

/**
 * The warning lives on the FORM side, beside the line items it is about — not as
 * a toast. A toast is gone in four seconds; this is a standing fact about the
 * invoice the operator is looking at.
 */
function renderRefWarning() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-ref-warn');
  if (!host) return;
  host.innerHTML = _refNotStored
    ? `<div class="inv-refwarn">${esc(REF_NOT_STORED)}</div>`
    : '';
}

/**
 * Mark the originating quick order invoiced — the sole guard against a converted
 * sale double-counting.
 *
 * Since backend migration 108 a saved quick order materialises its OWN shadow
 * `orders` row, and this invoice materialises another. The backend keeps no
 * invoice→quick-order link, so unless the FE flips the quick order to
 * status='invoiced' (which cancels its shadow) the sale lands in analytics TWICE.
 *
 * Runs from persistDraft AFTER a successful save — never at "Create invoice" click
 * time, because an invoice the operator then cancels would leave the quick order
 * invoiced-but-uninvoiced and the sale would vanish from analytics entirely.
 *
 * Idempotent: on success it clears `source_quick_order_id`, so the email/download
 * re-saves (which also call persistDraft) see flipTargetFrom() → null and skip.
 *
 * LOUD on failure (feedback_fail_soft_must_be_loud): the invoice is already saved,
 * so a silent failure here means the sale quietly double-counts. We keep the link
 * (so a later save retries) and tell the operator exactly what's wrong and how to
 * fix it, rather than swallow it behind a healthy-looking "Invoice saved".
 */
async function flipSourceQuickOrder() {
  const qoId = flipTargetFrom(_draft);
  if (!qoId) return;
  try {
    await AdminAPI.updateQuickOrder(qoId, { status: 'invoiced' });
    _draft.source_quick_order_id = null;   // flipped — don't re-PUT on email/download re-save
  } catch (err) {
    warn('quick-order status flip failed', err);
    Toast.warning('Invoice saved, but the source quick order couldn’t be marked invoiced — '
      + 'it may double-count in your sales until you delete that quick order.'
      + (err.message ? ' (' + err.message + ')' : ''));
  }
}

/**
 * The backend's fail-soft net, rendered LOUD.
 *
 * verifyLineCodes lets a save through when the catalogue is unreachable (resolveSkus
 * → null), so the backend is the backstop: it rejects any non-SKU product_code with
 * 400 VALIDATION_FAILED + `error.details.unresolved` (ERR-071). Pin each offending
 * line's code box exactly the way the client guard does, rather than a vague toast.
 * Returns true when it handled the error (caller should stop).
 */
function surfaceUnresolvedCodes(err, token) {
  if (err?.code !== 'VALIDATION_FAILED') return false;
  if (!(err.details?.unresolved || Array.isArray(err.details))) return false;
  const errs = unresolvedLineErrors(_draft?.lines, err.details?.unresolved ?? err.details);
  if (!errs.length) return false;
  const first = editorAlive(token) ? markInvoiceErrors(errs) : null;
  if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus({ preventScroll: true }); }
  Toast.error(errs.length === 1 ? errs[0].msg
    : `${errs.length} lines have a code that isn’t a product SKU — pick each product from the list.`);
  return true;
}

/**
 * What the operator is told when a save is rejected.
 *
 * The backend's own words come first — `error.message`, plus `error.details.reason`
 * and any per-field `details` entries. That text is the only thing that can tell an
 * operator what to FIX (an unresolvable product code, a blank customer name), and
 * it was previously dropped for everything except the `details.unresolved` shape.
 *
 * The old fallback read "the invoicing backend may not be live yet". It IS live —
 * POST and PUT /api/admin/invoices both answer 401, not 404 (probed 2026-07-31) —
 * so that line invented an innocent explanation for a real rejection and stopped
 * anyone from looking further. Exactly how ERR-131 stayed hidden for a month.
 * When the server says nothing, say THAT; never guess at a cause.
 */
function saveErrorMessage(err) {
  const parts = [];
  const add = (t) => {
    const s = String(t ?? '').trim();
    if (s && !parts.some((p) => p.includes(s))) parts.push(s);
  };
  add(err?.message);
  add(err?.details?.reason);
  // `details` also arrives as a bare array (or `details.errors`) for multi-field
  // validation failures — surface those instead of dropping them on the floor.
  const list = Array.isArray(err?.details) ? err.details
    : (Array.isArray(err?.details?.errors) ? err.details.errors : []);
  for (const d of list) add(typeof d === 'string' ? d : (d?.message || d?.reason || ''));

  // A CREDIT LINE THE SERVER WON'T TAKE. CONFIRMED BY A WRITE, not inferred
  // (2026-08-28): POST /api/admin/invoices returns 400 VALIDATION_FAILED on
  // `line_items[N].unit_cost_excl_gst must be greater than or equal to 0`, the
  // same rule /quote enforces (probe §6d). A control run proved it is the SIGN
  // and nothing else — the identical payload with +40 in place of -40 created
  // invoice #3276, which was then deleted. That raw Joi string is not something
  // an operator can act on, so say what happened and what to do instead. Delete
  // this branch when BF-050 lands, not before.
  const joined = parts.join(' — ');
  if (/unit_cost_excl_gst[\s\S]{0,80}greater than or equal to 0/i.test(joined)) {
    return 'The invoice service will not accept a credit line yet — it rejects any price below $0 (BF-050). '
      + 'The rest of the invoice is fine: take the discount off the product line instead, or leave this open '
      + 'until the backend lifts that rule.';
  }

  return parts.length ? joined
    : 'Could not save this invoice, and the server didn’t say why. Try again — if it keeps failing, check the customer name and every line’s product code.';
}

async function saveInvoice() {
  // Block the save until all essentials are filled; highlight what's missing.
  if (!ensureInvoiceValid()) return;
  const token = _editorToken;
  const btn = _editorRefs?.drawer.footer.querySelector('[data-ed-action="save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const saved = await persistDraft();
    if (saved) {
      const num = _draft.invoice_number || '';
      // The standing #inv-ref-warn note is the right surface for the paths that
      // KEEP the drawer open (Download PDF and Email both auto-save through
      // persistDraft without closing). This path closes it, so the note would be
      // rendered into a body that is about to be thrown away — the operator
      // would never see it. Read the flag BEFORE Drawer.close(), whose onClose
      // runs resetQuoteState() and clears it, and say it in the toast instead.
      const refsLost = _refNotStored;
      if (refsLost) Toast.warning(`Invoice ${num} saved. ${REF_NOT_STORED}`.replace('  ', ' '));
      else Toast.success(`Invoice ${num} saved.`.replace('  ', ' '));
      Drawer.close();
      loadData();
    } else {
      Toast.error('Save returned no data.');
    }
  } catch (err) {
    warn('save failed', err);
    if (surfaceUnresolvedCodes(err, token)) return;
    Toast.error(saveErrorMessage(err));
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

// =========================================================================
//  Business account link — what puts an invoice on a customer's portal
// =========================================================================
// undefined = not looked up yet · null = the endpoint is unavailable ·
// Array = the approved accounts. null and [] are deliberately different: one
// means "we couldn't ask", the other "there are none".
let _bizAccounts;

async function ensureBusinessAccounts() {
  if (_bizAccounts !== undefined) return _bizAccounts;
  const token = _editorToken;
  _bizAccounts = await AdminAPI.listBusinessAccounts();
  if (!editorAlive(token)) return _bizAccounts;
  const host = _editorRefs?.drawer?.body?.querySelector('#inv-biz-link');
  if (host) host.outerHTML = businessLinkHtml(_draft);
  return _bizAccounts;
}

/** The account this invoice's customer probably belongs to — a SUGGESTION. */
function suggestedBusinessAccount() {
  if (!Array.isArray(_bizAccounts) || !_bizAccounts.length) return null;
  const uid = _fillSource?.userId || null;
  const email = String(_fillSource?.email || _draft?.customer?.email || '').trim().toLowerCase();
  return _bizAccounts.find((a) => {
    if (uid && a.user_id && a.user_id === uid) return true;
    return email && String(a.contact_email || a.email || '').trim().toLowerCase() === email;
  }) || null;
}

const bizAccountLabel = (a) => a?.company_name || a?.name || 'Business account';

/**
 * Three states, and the middle one is why this block exists.
 *
 * LINKED    — names the company, offers Unlink.
 * NOT LINKED— says so IN WORDS. "Not linked" has to be visible, because the
 *             failure it prevents is invisible: an unlinked invoice is simply
 *             absent from the customer's Business Centre, and an operator with
 *             no indicator here cannot answer "why isn't my invoice showing?".
 * SUGGESTED — when the filled-from party matches an approved account we offer
 *             the link and NEVER apply it. Linking publishes this document to
 *             that account's portal, so an email match is a prompt for a human
 *             decision, not authority to grant access.
 */
function businessLinkHtml(d) {
  const linkedId = d.business_account_id || null;
  const known = Array.isArray(_bizAccounts) ? _bizAccounts : [];
  const linkedAcct = linkedId ? known.find((a) => a.id === linkedId) : null;

  let body;
  if (linkedId) {
    const who = linkedAcct ? esc(bizAccountLabel(linkedAcct)) : 'a business account';
    body = `<p class="inv-biz__state inv-biz__state--on">Linked to <strong>${who}</strong> — this invoice appears in their Business Centre.</p>
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="unlink-business">Unlink</button>`;
  } else if (_bizAccounts === undefined) {
    body = `<p class="inv-biz__state">Checking business accounts&hellip;</p>`;
  } else if (_bizAccounts === null) {
    // Loud, not silent. The operator needs to know the control is missing
    // rather than conclude this customer simply has no account.
    body = `<p class="inv-biz__state inv-biz__state--off">Not linked — this invoice will not appear on any customer's Business Centre.</p>
      <p class="inv-field__hint">Linking is unavailable: the backend has no endpoint that exposes business-account ids yet. See <code>business-centre-FE-response-aug2026.md</code>.</p>`;
  } else {
    const suggestion = suggestedBusinessAccount();
    const options = ['<option value="">— not linked —</option>']
      .concat(known.map((a) => `<option value="${escA(a.id)}">${esc(bizAccountLabel(a))}${a.contact_email ? ` (${esc(a.contact_email)})` : ''}</option>`))
      .join('');
    // Every option came from this browser's own record of accounts it created
    // (AdminAPI.listBusinessAccounts merges them in, tagged `_source:'device'`),
    // which means the server list is STILL unavailable. A picker that just works
    // would imply the endpoint shipped and that this is every business account —
    // it is neither. Say which list this is.
    const deviceOnly = known.length > 0 && known.every((a) => a._source === 'device');
    body = `<p class="inv-biz__state inv-biz__state--off">Not linked — this invoice will not appear on any customer's Business Centre.</p>`
      + (deviceOnly
        ? `<p class="inv-field__hint">The backend still has no endpoint listing business accounts, so these are only the accounts upgraded from this browser. Others cannot be linked yet — see <code>business-one-click-upgrade-FE-response-aug2026.md</code>.</p>`
        : '')
      + (suggestion
        ? `<p class="inv-biz__suggest">${esc(_fillSource?.label || 'This customer')} has an approved account:
             <strong>${esc(bizAccountLabel(suggestion))}</strong>
             <button type="button" class="admin-btn admin-btn--sm" data-form-action="link-business" data-account-id="${escA(suggestion.id)}">Link to their portal</button></p>`
        : '')
      + `<label class="inv-field"><span class="inv-field__label">Business account <span class="inv-field__hint">(sets portal visibility)</span></span>
           <select class="admin-select" id="inv-biz-select" data-field="business_account_id">${options}</select></label>`;
  }

  return `<section class="inv-section" id="inv-biz-link">
      <div class="inv-section__title">Business account (portal access)</div>
      ${body}
    </section>`;
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
            <div class="admin-ac"><input class="admin-input" id="inv-order-search" type="search" placeholder="Search order # or customer name…" autocomplete="off"></div>
          </label>
          <label class="inv-field"><span class="inv-field__label">Fill details from</span>
            <div class="admin-ac"><input class="admin-input" id="inv-party-search" type="search" placeholder="Search a contact or customer…" autocomplete="off"></div>
          </label>
        </div>
        ${fillChipHtml()}
      </section>

      ${businessLinkHtml(d)}

      <section class="inv-section">
        <div class="inv-section__title">Invoice details</div>
        <div class="inv-grid-2">
          ${numberLine}
          ${field('Date', 'date', d.date, { type: 'date' })}
          <label class="inv-field"><span class="inv-field__label">Date order placed * <span class="inv-field__hint">(required — sets the payment due date)</span></span>
            <input class="admin-input" type="date" data-field="order_date" value="${escA(d.order_date)}" required></label>
          <label class="inv-field"><span class="inv-field__label">Payment due date <span class="inv-field__hint">(auto-filled from order date + terms — edit to override)</span></span>
            <input class="admin-input" type="date" id="inv-due-date" data-field="payment_due" value="${escA(effectiveDueDate(d))}"></label>
          <label class="inv-field"><span class="inv-field__label">PO number <span class="inv-field__hint">(the customer's own reference — printed, and shown on their portal)</span></span>
            <input class="admin-input" type="text" data-field="po_number" value="${escA(d.po_number)}" placeholder="e.g. PO-9921"></label>
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
          <span>Product Code</span><span>Description</span><span>Number</span><span>Unit Price${gstSub(GST_EXCL)}</span>${canSeeCost() ? `<span>Our Cost${gstSub(GST_EXCL)}</span>` : ''}<span></span>
        </div>
        <div id="inv-lines"></div>
        ${canSeeCost() ? `<p class="inv-section__hint">“Our Cost” is internal — it auto-fills from the product’s cost price, can be typed over, and <strong>never appears on the invoice, the preview, the PDF or the customer’s email</strong>. It exists so invoiced sales carry a real COGS into your profit figures.</p>` : ''}
        <div id="inv-cogs"></div>
        <div id="inv-ref-warn"></div>
        <div class="inv-lines-actions">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="add-line">${icon('plus', 13, 13)} Add line</button>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="add-custom" title="Invoice something that isn't in the catalogue \u2014 a refurbished unit, a one-off machine, a service. You give it your own reference.">${icon('plus', 13, 13)} Add custom item</button>
          <button class="admin-btn admin-btn--ghost admin-btn--sm" data-form-action="add-shipping" title="Bill for freight without a product \u2014 NZ or international">${icon('plus', 13, 13)} Add shipping charge</button>
        </div>
        <div class="inv-freight" id="inv-freight">
          <label class="inv-field inv-field--freight"><span class="inv-field__label">Freight — 0 shows as “Free”${gstSub(GST_EXCL)}</span>
            <input class="admin-input" type="number" step="0.01" min="0" data-field="freight" value="${escA(d.freight)}">
          </label>
          <div class="inv-freight__pick" id="inv-freight-pick"></div>
        </div>
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

/**
 * What the "Our Cost" box says when it is empty.
 *
 * An empty box plus an "auto" placeholder is how "we don't know this cost yet"
 * reads on a catalogue line — something WILL fill it. On a line with no product
 * behind it, "auto" is a lie: nothing auto-fills, the backend's cost snapshot
 * finds nothing, and the cost stays UNKNOWN. It matters beyond tidiness — the
 * invoice LIST reports an unknown cost as $0, which prints the invoice at 100%
 * margin (BF-047), and the operator typing the real figure here is the one
 * thing that makes that number true. So each kind of line asks for what it
 * actually needs.
 */
function costPlaceholder(l) {
  if (num(l?.unitCost) < 0) return '0.00 \u2014 credit';   // a credit has no goods behind it
  if (l?.kind === 'shipping') return 'courier cost';
  if (isCustomLine(l)) return 'needs a cost';
  return 'auto';
}

/**
 * Codes we have already asked the catalogue about.
 *
 * Map<lowercased code, boolean> — true = a real products.sku, false = not one.
 * Keyed by the CODE, never by the row index: rows are added, removed and
 * reordered, and an answer pinned to position 2 would end up describing whatever
 * moved into position 2. Keying by the string also means the same code typed on
 * two lines costs one lookup, and re-typing a code we have seen costs none.
 *
 * A code the catalogue could not be ASKED about (resolveSkus → null, our own
 * outage) is deliberately never recorded — see checkLineCode.
 */
const _codeChecks = new Map();
// Set by noteRefEcho() when a save proves the backend dropped product_ref.
let _refNotStored = false;
const REF_NOT_STORED = 'Your own text on these lines — the refs and the discount reasons — prints '
  + 'on this invoice and on the PDF the customer receives, but the invoice service isn’t storing it '
  + 'yet (BF-051). The prices are saved correctly; only the wording is lost if you reopen this invoice.';
let _codeCheckTimer = null;
const _codeCheckQueue = new Set();

/**
 * Has this line's typed code been shown NOT to be a SKU?
 *
 * Three-state on purpose, and the third state is the important one: `undefined`
 * means "not asked yet, or we could not ask", and must render nothing. Only a
 * recorded `false` is a real no. Collapsing unknown into false would flag every
 * code the instant it was typed, and flag all of them during an outage of ours.
 */
function codeIsKnownBad(l) {
  const code = (l?.code || '').trim();
  if (!code || isCustomLine(l)) return false;
  return _codeChecks.get(code.toLowerCase()) === false;
}

/**
 * Ask the catalogue about the codes the operator has finished typing.
 *
 * Batched through one animation-frame-ish debounce so tabbing down a freshly
 * filled-in invoice is one request, not one per row. Uses the SAME resolveSkus()
 * the save gate uses, so the answer here and the answer at save can never
 * disagree — this is the same question, asked earlier.
 *
 * FAIL-SOFT, EXACTLY AS AT SAVE: resolveSkus returns null when the catalogue is
 * unreachable, which is "we could not ask" and NOT "not a SKU". Nothing is
 * recorded and nothing is shown; an outage of ours must never accuse the
 * operator's perfectly good code of being wrong.
 */
function scheduleCodeCheck(code) {
  const c = (code || '').trim();
  if (!c || _codeChecks.has(c.toLowerCase())) return;
  _codeCheckQueue.add(c);
  clearTimeout(_codeCheckTimer);
  _codeCheckTimer = setTimeout(runCodeChecks, 250);
}

async function runCodeChecks() {
  const token = _editorToken;
  const want = [..._codeCheckQueue];
  _codeCheckQueue.clear();
  if (!want.length) return;
  const resolved = await resolveSkus(want);
  if (!editorAlive(token)) return;              // drawer closed mid-lookup (ERR-045)
  if (!resolved) return;                        // could not ask — record nothing
  for (const c of want) {
    const hit = resolved.get(c.toLowerCase());
    _codeChecks.set(c.toLowerCase(), !!hit);
    // Snap to the catalogue's spelling now rather than at save, so what the
    // operator sees is what ships. Never touches the box they are typing in.
    if (hit) {
      _draft?.lines?.forEach((l) => {
        if ((l.code || '').trim().toLowerCase() === c.toLowerCase()) l.code = hit;
      });
    }
  }
  repaintLineNotes();
}

/**
 * Repaint every row's note strip in place.
 *
 * NOT renderLines(): the operator has just tabbed out of a code box and is
 * almost certainly typing in the next one. Rebuilding the grid would destroy the
 * input under their caret — ERR-179, the exact fault this editor already paid
 * for once. Only the note element is replaced, and it holds no focusable state
 * worth preserving.
 */
function repaintLineNotes() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-lines');
  if (!host) return;
  host.querySelectorAll('.inv-line').forEach((row) => {
    const i = +row.dataset.line;
    const l = _draft?.lines?.[i];
    if (!l) return;
    const html = lineQuoteNote(l, i);
    const existing = row.querySelector('.inv-line__note');
    if (!html) { existing?.remove(); return; }
    if (existing) existing.outerHTML = html;
    else row.insertAdjacentHTML('beforeend', html);
  });
}

/**
 * The DISCOUNT sub-row: money the operator takes off this line by hand.
 *
 * WHY IT IS ITS OWN ELEMENT, ABOVE THE NOTE STRIP. patchQuotedLineRows replaces
 * `.inv-line__note` wholesale on every quote reply, so an input living inside it
 * would be destroyed under the operator's caret — ERR-179, again. It also
 * APPENDS a note that did not exist before, so this row has to come FIRST or the
 * two would swap places between a full render and a patch.
 *
 * The discount is APPLIED, never held as a second source of truth: pressing
 * Apply writes the net figure into `unitCost` (exactly what the volume ladder's
 * own "Apply volume price" button does) and records what it did for display.
 * That is what keeps the customer's document and the stored invoice identical —
 * there is only ever one price, and `unit_cost_excl_gst` is already it.
 */
function lineDiscountRow(l, i) {
  const applied = hasManualDiscount(l);
  if (!applied && !l.discountOpen) {
    return `<div class="inv-line__disc">
      <button type="button" class="inv-disc__add" data-form-action="open-discount" data-line="${i}">+ Discount</button>
    </div>`;
  }
  if (applied) {
    // Reconstruct what it was, the way lineQuoteNote does for a volume badge.
    const was = num(l.qty) > 0 ? round2(num(l.unitCost) + num(l.discountSaving) / num(l.qty)) : null;
    return `<div class="inv-line__disc inv-line__disc--applied">
      <span class="inv-vol inv-vol--applied">Discount &minus;${esc(money(l.discountSaving))}${was ? ` (was ${esc(money(was))} each)` : ''}</span>
      ${l.discountNote ? `<span class="inv-disc__why">${esc(l.discountNote)}</span>` : ''}
      <button type="button" class="inv-disc__undo" data-form-action="undo-discount" data-line="${i}" title="Put the price back">Remove</button>
    </div>`;
  }
  return `<div class="inv-line__disc inv-line__disc--editing">
    <label class="inv-disc__f"><span>Discount (excl. GST)</span>
      <input class="admin-input inv-disc__amt" type="number" step="0.01" min="0" data-disc-amt="${i}" placeholder="0.00"></label>
    <label class="inv-disc__f inv-disc__f--why"><span>Reason — prints on the invoice</span>
      <input class="admin-input" data-disc-why="${i}" placeholder="e.g. already paid on invoice 3271" autocomplete="off"></label>
    <button type="button" class="admin-btn admin-btn--sm" data-form-action="apply-discount" data-line="${i}">Apply</button>
    <button type="button" class="inv-disc__undo" data-form-action="close-discount" data-line="${i}">Cancel</button>
  </div>`;
}

/**
 * The strip under one line row: what the volume ladder did, or is offering.
 *
 * It is a full-width child of the `.inv-line` grid (`grid-column: 1/-1`), NOT a
 * seventh cell — that grid is shared verbatim with the Quick Order editor and a
 * seventh column would misalign every one of its rows.
 *
 * Three things it can say, in priority order:
 *   1. we applied a volume price (and what it was before);
 *   2. a volume price exists but the operator authored this one, so it is
 *      offered as a button and never taken;
 *   3. the product is inactive — worth a quiet flag when invoicing it;
 *   4. the typed code is NOT a SKU, with the way out attached;
 *   5. this is a custom item, so the ladder was never consulted.
 *
 * (4) is answered from `_codeChecks`, which is only ever populated once the
 * operator LEAVES the box. Mid-typing it says nothing — an operator three
 * characters into a SKU does not need to be told it isn't one yet. What changed
 * is that they no longer find out at SAVE, after filling in the whole invoice.
 *
 * (5) matters because silence is ambiguous. A custom line gets no volume price
 * and contributes no weight to the courier quote, and "no badge" reads exactly
 * like "no discount was available" unless you say which it is.
 */
function lineQuoteNote(l, i) {
  const bits = [];

  const pct = Number(l.volumePercent);
  if (Number.isFinite(pct) && pct > 0) {
    const was = num(l.volumeSaving) > 0 && num(l.qty) > 0
      ? round2(num(l.unitCost) + num(l.volumeSaving) / num(l.qty))
      : null;
    const saving = num(l.volumeSaving) > 0 ? ` · customer saves ${money(l.volumeSaving)}` : '';
    bits.push(`<span class="inv-vol inv-vol--applied">Volume &minus;${esc(formatVolumePercent(pct))}${was ? ` (was ${esc(money(was))})` : ''}${esc(saving)}</span>`);
  } else {
    const offer = _volumeOffers.find((o) => o.position === i);
    if (offer) {
      bits.push(`<button type="button" class="inv-vol inv-vol--offer" data-form-action="apply-volume" data-line="${i}">Apply volume price ${esc(money(offer.badge.unitPrice))} (&minus;${esc(offer.badge.percentText)})</button>`);
    }
  }

  const ql = quoteLineAt(i);
  if (ql && ql.resolved && !ql.isActive) {
    bits.push(`<span class="inv-vol inv-vol--warn">Inactive product</span>`);
  }

  // The code was typed, we asked the catalogue, and the answer was no. Offer the
  // fix rather than only the complaint: the text is something the operator
  // meant, and the only thing wrong with it is which FIELD it is in.
  if (codeIsKnownBad(l)) {
    bits.push(`<span class="inv-vol inv-vol--warn">“${esc((l.code || '').trim())}” isn’t a catalogue SKU</span>`);
    bits.push(`<button type="button" class="inv-vol inv-vol--offer" data-form-action="make-custom" data-line="${i}">Keep as a custom item</button>`);
  }

  if (isCustomLine(l)) {
    bits.push(`<span class="inv-vol inv-vol--muted">Custom item — no volume price, and not counted in the parcel weight</span>`);
  }

  // A CREDIT ROW CANNOT BE SAVED, so say so here rather than at Save, and give
  // it somewhere to go. The invoice service floors both the price and the
  // quantity at zero and ignores any discount key, so there is no arrangement of
  // this row that survives a POST (BF-050) — folding it into the line above is
  // the same money expressed as a discount, which does.
  if (num(l.unitCost) < 0) {
    bits.push(`<span class="inv-vol inv-vol--warn">A credit row can’t be saved on its own</span>`);
    if (i > 0) {
      bits.push(`<button type="button" class="inv-vol inv-vol--offer" data-form-action="fold-credit" data-line="${i}">Apply ${esc(money(Math.abs(num(l.unitCost) * (num(l.qty) || 1))))} to the line above</button>`);
    } else {
      bits.push(`<span class="inv-vol inv-vol--muted">Move it below the line it discounts, then apply it</span>`);
    }
  }

  if (!bits.length) return '';
  return `<div class="inv-line__note">${bits.join('')}</div>`;
}

/** The quote's answer for one draft-line index, if we have one. */
function quoteLineAt(i) {
  return (_quote?.lines || []).find((l) => l.position === i) || null;
}

/**
 * The courier picker beside the freight box.
 *
 * The freight INPUT stays exactly as it was — same `data-field="freight"`, same
 * save path, still typeable. This dropdown only writes into it. That is the
 * whole integration, and it is why no schema changed.
 *
 * Every state says what it is. An empty or missing dropdown would read as "there
 * are no shipping options", so when the rates cannot be read the row says so and
 * points at the input the operator can always fall back to.
 */
const CREDIT_NOT_IN_THRESHOLD = 'Credit lines are not counted in the goods total above \u2014 check the free-shipping call yourself.';

function renderShippingRow() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-freight-pick');
  if (!host) return;

  // A quote can land while the operator is inside the courier dropdown — arrowing
  // through options with the keyboard, or having just picked one. Replacing the
  // <select> under them closes it and drops focus, the same ERR-179 fault as the
  // line grid. Defer, and paint on their next focusout: this is a POSTPONED
  // render, not a skipped one — onFormFocusOut below runs exactly this function.
  // Guarded on the select alone, never the whole row: the "apply free shipping"
  // button lives here too and must repaint the instant it is clicked.
  const active = document.activeElement;
  if (active && active.matches?.('[data-freight-option]')) { _shippingRowDirty = true; return; }
  _shippingRowDirty = false;

  if (_quoteStatus === 'loading' && !_quote) {
    host.innerHTML = `<span class="inv-freight__note">Checking courier rates…</span>`;
    return;
  }
  if (!_quote || !_quote.shipping.hasOptions) {
    const why = _quoteStatus === 'limited'
      ? 'Rate limit reached — courier rates will refresh shortly.'
      : 'Courier rates unavailable — type the freight manually.';
    host.innerHTML = `<span class="inv-freight__note inv-freight__note--warn">${esc(why)}</span>`;
    return;
  }

  const shipping = _quote.shipping;
  const sel = resolveShippingSelection(shipping, { choice: _freightChoice, freight: _draft.freight });
  const opts = shipping.options.map((o) => {
    const fee = o.freightExclGst > 0 ? ` — ${money(o.freightExclGst)}` : '';
    return `<option value="${escA(o.key)}"${o.key === sel.key ? ' selected' : ''}>${esc(o.label + fee)}</option>`;
  }).join('');
  // "Custom" is only ever offered, never a real rate — it exists so a typed
  // number has an honest label instead of silently showing someone else's.
  const custom = `<option value="${FREIGHT_CUSTOM}"${sel.isCustom ? ' selected' : ''}>Custom — typed above</option>`;

  const weight = parcelWeightNote(_quote);
  const offerFree = freeShippingAvailable(_freightChoice, shipping);
  // Name the basis, both ways. The threshold is judged on the GST-INCLUSIVE goods
  // total; the freight box and the dropdown immediately beside these strings are
  // labelled ex-GST. A row that mixes two bases without naming either is what made
  // correct behaviour read as a GST bug (ERR-178), so the figure is printed.
  const goodsIncl = shipping.goodsTotalInclGst;
  const qualifyLabel = goodsIncl != null
    ? `This order qualifies for free shipping (${money(goodsIncl)} incl GST) — apply`
    : 'This order qualifies for free shipping — apply';
  const gap = freeShippingGapNote(shipping);
  // The goods total quoted beside these controls DOES NOT include credit lines:
  // the endpoint validates unit_cost_excl_gst as >= 0 and 400s the whole request
  // over one negative figure, so quoteRequestBody leaves them out (probe §6d).
  // An omission that changes a free-shipping decision has to be said out loud,
  // not discovered — this is the same rule that ERR-063/149 were about.
  const credited = hasCreditLine(_draft?.lines);

  host.innerHTML = `
    <label class="inv-field inv-field--freightpick">
      <span class="inv-field__label">Courier rate${gstSub(GST_EXCL)}</span>
      <select class="admin-select" data-freight-option>${opts}${custom}</select>
    </label>
    ${weight ? `<span class="inv-freight__note">${esc(weight)}</span>` : ''}
    ${credited ? `<span class="inv-freight__note inv-freight__note--warn">${esc(CREDIT_NOT_IN_THRESHOLD)}</span>` : ''}
    ${!offerFree && gap ? `<span class="inv-freight__note">${esc(gap)}</span>` : ''}
    ${offerFree ? `<button type="button" class="inv-freight__free" data-form-action="apply-free-shipping">${esc(qualifyLabel)}</button>` : ''}
    ${_quoteStatus === 'limited' ? `<span class="inv-freight__note inv-freight__note--warn">Rates may be a moment out of date (rate limit).</span>` : ''}`;
}

function renderLines() {
  const host = _editorRefs?.drawer.body.querySelector('#inv-lines');
  if (!host) return;
  // Destroy the outgoing rows' autocompletes BEFORE their inputs are wiped. Their
  // menus are <body> children (ERR-107), so nothing else removes them — this is
  // what stops a rebuild stranding two orphaned dropdowns per line, one of which
  // may still be open and unclosable (ERR-179).
  destroyHandles(_acLineHandles);
  const showCost = canSeeCost();
  host.innerHTML = (_draft.lines || []).map((l, i) => {
    const manual = l.costSource === 'manual';
    // Empty value + "auto" placeholder is how "we don't know this cost" reads.
    //
    // On a shipping line "auto" would be a lie: there is no product behind it, so
    // the backend's cost snapshot finds nothing and the cost stays UNKNOWN. Say
    // what actually belongs there instead. It matters — the invoice LIST reports
    // an unknown cost as $0, which prints a freight invoice at 100% margin
    // (BF-046), and the operator typing the courier's charge here is the one
    // thing that makes that number true.
    const shipCost = l.kind === 'shipping';
    const costCell = showCost ? `
      <input class="admin-input inv-line__cost${manual ? ' inv-line__cost--manual' : ''}"
             type="number" step="0.01" min="0" data-line="${i}" data-lfield="supplierCost"
             value="${escA(l.supplierCost ?? '')}" placeholder="${costPlaceholder(l)}"
             title="${manual ? 'Manual override' : shipCost ? 'What the courier charged US for this freight — nothing auto-fills it, and leaving it blank reports this invoice at 100% margin' : isCustomLine(l) ? 'What this item cost US — there is no catalogue product behind it, so nothing auto-fills, and leaving it blank reports this invoice at 100% margin' : 'Auto-filled from the product’s cost'} — internal only, never printed on the invoice">` : '';
    // A shipping line has no product behind it, so its code box is READ-ONLY.
    // That is protective, not cosmetic: a typed `FREIGHT` is not a real
    // products.sku, so verifyLineCodes() would refuse the save. It stays in the
    // DOM either way — markInvoiceErrors and unresolvedLineErrors select on it.
    const ship = l.kind === 'shipping';
    const custom = isCustomLine(l);
    // THREE shapes for one cell, because the box means three different things:
    //   shipping — no product and no reference. READ-ONLY, protective not
    //     cosmetic: a typed `FREIGHT` is not a products.sku and would be refused.
    //   custom   — the operator's OWN reference (data-lfield="ref"). Free text,
    //     never resolved, never sent as product_code. This is the box that makes
    //     "type anything" true, and it is a DIFFERENT FIELD, which is the entire
    //     reason it is safe.
    //   product  — a real SKU, with the catalogue picker attached (.inv-ac).
    // All three keep data-line/data-lfield: markInvoiceErrors and
    // unresolvedLineErrors select on them.
    const codeCell = ship
      ? `<input class="admin-input inv-line__code--none" data-line="${i}" data-lfield="code" value="${escA(l.code)}" placeholder="— no product —" readonly tabindex="-1" title="A shipping charge carries no product code — the description is what prints." autocomplete="off">`
      : custom
        ? `<input class="admin-input inv-line__ref" data-line="${i}" data-lfield="ref" value="${escA(l.ref || '')}" placeholder="Your ref" title="Your own reference — anything you like. It prints in the Product Code column of the customer's invoice and is never matched against the catalogue." autocomplete="off">`
        : `<div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="code" value="${escA(l.code)}" placeholder="SKU / code" autocomplete="off"></div>`;
    const descCell = (ship || custom)
      ? `<input class="admin-input" data-line="${i}" data-lfield="description" value="${escA(l.description)}" placeholder="${ship ? 'What the freight is for' : 'What you are selling'}" title="${ship ? 'Free text — name any destination, NZ or international' : 'Free text — this is what identifies the item on the invoice'}" autocomplete="off">`
      : `<div class="inv-ac"><input class="admin-input" data-line="${i}" data-lfield="description" value="${escA(l.description)}" placeholder="Product description" autocomplete="off"></div>`;
    return `
    <div class="inv-line${showCost ? '' : ' inv-line--nocost'}${ship ? ' inv-line--shipping' : ''}${custom ? ' inv-line--custom' : ''}" data-line="${i}">
      ${codeCell}
      ${descCell}
      <input class="admin-input" type="number" step="1" min="0" data-line="${i}" data-lfield="qty" value="${escA(l.qty)}">
      <input class="admin-input${l.priceSource === PRICE_MANUAL ? ' inv-line__price--manual' : ''}${num(l.unitCost) < 0 ? ' inv-line__price--credit' : ''}" type="number" step="0.01" data-line="${i}" data-lfield="unitCost" value="${escA(l.unitCost)}" title="A NEGATIVE price is a credit line — money off, printed as its own row on the customer&#39;s invoice.">
      ${costCell}
      <button class="admin-btn admin-btn--ghost admin-btn--sm inv-line__rm" data-form-action="remove-line" title="Remove line">${icon('trash', 12, 12)}</button>
      ${lineDiscountRow(l, i)}
      ${lineQuoteNote(l, i)}
    </div>`;
  }).join('');
  // Product autocomplete (storefront-style, image dropdown) on both the code +
  // description inputs of every PRODUCT line. Shipping and CUSTOM rows are
  // deliberately excluded — neither renders its inputs inside `.inv-ac`, so
  // typing "International freight — Australia" or "Refurbished drum unit" never
  // opens a product dropdown offering to turn it into a catalogue line.
  host.querySelectorAll('.inv-line').forEach((row) => {
    const i = +row.dataset.line;
    row.querySelectorAll('.inv-ac > input').forEach((input) => _acLineHandles.push(attachProductAutocomplete(input, {
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
          // A freshly picked product is ours to price, so the quote may replace
          // this figure. `ex` (retail ÷ 1.15) stays as the value shown until the
          // quote lands — it is the correct qty-1 price and it means the row is
          // never blank or stale while a request is in flight. Deleting it in
          // favour of "wait for the server" would be removing a working fallback,
          // which is a behaviour change and not a cleanup (ERR-158).
          priceSource: PRICE_AUTO,
          volumePercent: null, volumeSaving: null, volumeQuantity: null,
        };
        renderLines(); refreshPreview(); scheduleQuote();
      },
    })));
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
  // Costs ARE known, but computeOrderProfit refuses a revenue of zero or less
  // (profitability.js), so `profit` is null and the ordinary bar would render
  // "Cost of goods $X · Gross profit —" — which reads as "we don't know the
  // cost" when the real answer is that there is no sale value to take a margin
  // on. Credit lines are how an invoice reaches that state, so say it plainly.
  if (profit == null) {
    host.innerHTML = `<div class="inv-cogs inv-cogs--unknown">
      <span class="inv-cogs__label">Internal margin</span>
      <span class="inv-cogs__val">&mdash;</span>
      <span class="inv-cogs__note">Cost of goods ${esc(money(costExGst))} &middot; nothing to measure a margin on &mdash; the credits cancel the charges</span>
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
  // rebuildEditor() calls this again on the same open drawer, so the previous
  // pair must go or their <body> menus are stranded.
  destroyHandles(_acTopHandles);
  const orderInput = body.querySelector('#inv-order-search');
  // `getOrders` hands back the endpoint's `data`, and /api/admin/orders sends a
  // BARE ARRAY — reading `.orders` off it returned [] for every query ever typed,
  // valid order numbers included (ERR-176). Normalise, like every other caller.
  let orderFetchFailed = false;
  if (orderInput) _acTopHandles.push(attachAutocomplete(orderInput, {
    fetch: async (q) => {
      const data = await AdminAPI.getOrders({ search: q }, 1, 8);
      orderFetchFailed = data == null;
      return ordersFrom(data);
    },
    emptyText: (q) => orderEmptyText(q, orderFetchFailed),
    render: (o) => `<span class="admin-ac__code">${esc(o.order_number || o.id || '')}</span> ${esc(o.customer_name || o.customer_email || o.guest_email || '')} <span class="admin-ac__meta">· ${money(o.total_amount ?? o.total ?? 0)}</span>`,
    onPick: (o) => loadFromOrder(o.id || o.order_id),
  }));
  // Unified "Fill details from…" picker — Contacts, then Customers, then Orders,
  // in one sectioned dropdown (mirrors the storefront Compatible/Genuine split).
  // Orders are in there because a GUEST checkout has no contact and no account
  // row: searching the other two for them is "not looked", not "not found".
  const partyInput = body.querySelector('#inv-party-search');
  let partyFailed = [];
  if (partyInput) _acTopHandles.push(attachAutocomplete(partyInput, {
    fetch: async (q) => {
      const { sections, failed } = await searchParties(q, AdminAPI);
      partyFailed = failed;
      return sections;
    },
    emptyText: (q) => partyEmptyText(q, partyFailed),
    render: (it) => partyRowHtml(it),
    onPick: (it) => {
      if (it.__type === 'contact') loadFromContact(it);
      else if (it.__type === 'order') loadFromOrderDetails(it);
      else loadFromCustomer(it);
    },
  }));
}

/** One row of the "Fill details from…" dropdown, per source. */
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

// ---- auto-fill sources --------------------------------------------------
async function loadFromOrder(orderId) {
  if (!orderId) return;
  const token = _editorToken;
  const [order, breakdown] = await Promise.all([AdminAPI.getOrder(orderId), AdminAPI.getOrderBreakdown(orderId)]);
  if (!editorAlive(token)) return;
  if (!order) { Toast.error('Could not load that order.'); return; }

  // ONE order→party mapper, shared with the "Fill details from…" Orders section
  // and Quick Order (utils/party-search.js) — a guest row carries the address as
  // flat shipping_* columns and the contact details in guest_email/guest_phone.
  const party = orderToParty(order);
  _draft.source_order_id = order.id || orderId;
  // Order date reflects when the order was actually placed (used in the email line).
  _draft.order_date = party.orderDate || _draft.order_date;
  _draft.customer = {
    attn: party.attn, name: party.name, company: party.company,
    address: party.address, phone: party.phone, email: party.email,
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
    // Same reasoning on the SELL side, and it matters more: this is what the
    // customer was actually charged. Re-pricing it from today's volume ladder
    // would produce an invoice that disagrees with the order it came from.
    // 'manual' means the quote may offer a volume price but can never take it.
    priceSource: PRICE_MANUAL,
    volumePercent: null, volumeSaving: null, volumeQuantity: null,
  }));
  if (!_draft.lines.length) _draft.lines = [blankLine()];
  // Order shipping_fee is GST-INCLUSIVE — convert to ex-GST for the freight field.
  const shipIncl = num(breakdown?.shipping_fee ?? order.shipping_fee ?? 0);
  _draft.freight = shipIncl > 0 ? round2(shipIncl / (1 + GST_RATE)) : 0;
  // What the customer was actually charged for freight is authored data, and an
  // authored ZERO is the case that bites: an order that SHIPPED FREE arrives here
  // as freight 0 with no choice recorded, which is indistinguishable from a blank
  // draft — so the first quote used to drop a courier rate onto it. _freightChoice
  // stays null so resolveShippingSelection can still label a $0 box "Free".
  _freightOwner = FREIGHT_OWNER_OPERATOR;

  _fillSource = { type: 'order', label: order.order_number || String(orderId) };
  rebuildEditor();
  Toast.success(`Filled from order ${order.order_number || ''}`.trim());
}

/**
 * Fill the bill-to block from an order and NOTHING else — no line items, no
 * freight, no `source_order_id`. This is the "Fill details from…" path: it
 * answers "invoice this person again", where importing the old order's goods
 * would be wrong. Importing the goods is what the "Existing order" picker does,
 * and the toast says which one just happened so the two can never be confused.
 */
function loadFromOrderDetails(order) {
  if (!order) return;
  const party = orderToParty(order);
  _draft.source_order_id = null;
  _draft.customer = {
    attn: party.attn, name: party.name, company: party.company,
    address: party.address, phone: party.phone, email: party.email,
  };
  _fillSource = { type: 'order details', label: party.orderNumber, email: party.email };
  rebuildEditor();
  Toast.success(`Filled customer details from order ${party.orderNumber} — line items not imported`.trim());
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
  // The email is carried so the business-account block can SUGGEST a link.
  // It is a suggestion only — see businessLinkHtml(): a loose email match must
  // never grant a customer access to an invoice on its own.
  _fillSource = { type: 'contact', label: c.label || b.name || b.company || 'contact', email: b.email || '' };
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
    _fillSource = { type: 'customer', label: name, userId: c.id || null, email: c.email || '' };
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
  const order = ordersFrom(od)[0];   // bare-array envelope — ERR-176
  const addr = order?.shipping_address;
  if (addr) {
    _draft.customer.address = [addr.address_line1, addr.address_line2,
      [addr.city, addr.region, addr.postal_code].filter(Boolean).join(', '), addr.country].filter(Boolean).join('\n');
    if (!_draft.customer.phone) _draft.customer.phone = addr.phone || '';
  }
  _fillSource = { type: 'customer', label: name, userId: c.id || null, email: c.email || '' };
  rebuildEditor();
  Toast.success(`Filled customer ${name}`.trim());
}

// =========================================================================
//  Live preview
// =========================================================================
/**
 * Repaint the customer-facing preview and the margin readout — at most once per
 * frame (ERR-179).
 *
 * This runs from onFormInput, so it fired on EVERY keystroke in every field and
 * rebuilt the entire invoice document plus the COGS panel each time. It never
 * stole focus — neither host holds an input — but it is the visible flicker that
 * made the editor feel like it was reloading under the operator.
 *
 * Coalescing is safe because nothing reads these two nodes back: they are paint,
 * and the figures printed on the saved invoice come from the server. A caller
 * that needs the DOM synchronously does not exist, and if one ever does it should
 * call paintPreview() rather than take the coalescer out.
 */
let _previewFrame = null;

function refreshPreview() {
  if (_previewFrame != null) return;
  _previewFrame = requestAnimationFrame(() => { _previewFrame = null; paintPreview(); });
}

function cancelPreviewFrame() {
  if (_previewFrame == null) return;
  cancelAnimationFrame(_previewFrame);
  _previewFrame = null;
}

function paintPreview() {
  // The drawer can close between the frame being asked for and it running
  // (ERR-045) — _draft is null by then and renderPreview would throw on it.
  if (!_editorRefs || !_draft) return;
  // The internal margin readout depends on qty, price, cost AND freight, so it
  // refreshes wherever the preview does rather than enumerating fields.
  renderCogsPanel();
  const host = _editorRefs.drawer.body.querySelector('#inv-preview');
  if (!host) return;
  host.innerHTML = renderPreview(_draft);
}

function renderPreview(d) {
  const t = computeTotals(d);
  const meta = invoiceMeta(d);
  const parties = invoiceParties(d);
  // invoiceDocRows yields [code, description, qty, lineTotal, bulkNote] — the
  // ONLY projection the customer-facing document may use. The supplier cost
  // cannot leak here because this renderer no longer touches the line objects at
  // all. `bulkNote` is a SUB-LINE inside the description cell, deliberately not a
  // fifth column: a fifth column is how our margin would reach a customer.
  const rows = invoiceDocRows(d, { money, note: lineDocNote })
    .map(([code, description, qty, lineTotal, bulkNote]) => `<tr>
      <td class="inv-doc__code">${esc(code)}</td>
      <td>${esc(description)}${bulkNote ? `<span class="inv-doc__line-note">${esc(bulkNote)}</span>` : ''}</td>
      <td class="inv-doc__num">${esc(qty)}</td>
      <td class="inv-doc__cost">${esc(lineTotal)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="inv-doc__empty">Add a line item…</td></tr>`;

  const freightCell = t.freight > 0 ? money(t.freight) : 'Free';
  // Presentational ONLY — never a totals row. The unit prices already carry the
  // discount, so a "less bulk discount" line would subtract it a second time.
  const bulkSaved = computeInvoiceVolumeSavings(d);

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
    ${bulkSaved > 0 ? `<div class="inv-doc__savings">You saved ${esc(money(bulkSaved))} on this order by buying in bulk.</div>` : ''}

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
        if (surfaceUnresolvedCodes(err, _editorToken)) return;
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
  // Same projection as the live preview — see renderPreview. The supplier cost is
  // structurally unable to reach the PDF: it is not in the tuple.
  //
  // The bulk note is the tuple's 5th slot and is folded onto a second LINE of the
  // description cell, not into a fifth cell. autoTable derives its column count
  // from the body rows, so a 5-cell row would silently grow the table to five
  // columns — which is exactly the shape that would one day print our margin.
  const rows = invoiceDocRows(d, { money, note: lineDocNote })
    .map(([code, description, qty, lineTotal, bulkNote]) => [
      code, bulkNote ? `${description}\n${bulkNote}` : description, qty, lineTotal,
    ]);
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

  // --- Bulk savings (presentational; never a totals row) ---
  // The line prices already carry the discount, so this states what the customer
  // saved rather than subtracting anything. Right-aligned under the total.
  const bulkSaved = computeInvoiceVolumeSavings(d);
  if (bulkSaved > 0) {
    doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(70);
    doc.text(`You saved ${money(bulkSaved)} on this order by buying in bulk.`, valX, ty, { align: 'right' });
    doc.setTextColor(20);
    ty += 18;
  }

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
