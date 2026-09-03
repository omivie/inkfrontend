/**
 * Orders Page — Full-page modal detail + bulk selection/delete
 */
import {
  AdminAuth, FilterState, AdminAPI, icon, esc, exportDropdown, bindExportDropdown,
  // The sidebar's pending-tracking-request count. Imported here because this
  // page is now one of the places that CLEARS a request, and a badge that keeps
  // counting a request the operator just answered is the same fact rendered two
  // ways on one screen.
  refreshTrackingRequestsBadge,
} from '../app.js';
import { DataTable } from '../components/table.js';
import { Drawer } from '../components/drawer.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { marginBadge } from '../utils/profitability.js';
import {
  orderProfitFromDetail, isInvoiceOrder, orderChannel, ORDER_CHANNEL, PROFIT_STATE,
} from '../utils/order-profit.js';
import { GST_INCL, GST_EXCL, GST_NET, gstSub } from '../utils/gst-basis.js';
// Supplier/Origin rendering is shared with the Products page — see utils/sourcing.js.
// A second copy of the origin vocabulary is how the two surfaces would drift apart.
import { originBadge, supplierCell } from '../utils/sourcing.js';
// Invoice-send vocabulary — the same module AdminAPI writes through, so the
// reader and the writer cannot disagree about what a send record looks like.
import { recordedSendsPhrase } from '../utils/send-history.js';
// Shipping Information — the carrier vocabulary, the merge rule and the one
// honest sentence about whether the customer has been emailed. Nothing in this
// page may branch on a carrier NAME; every per-carrier behaviour reads a flag the
// server sent (utils/shipping-info.js, ERR-200).
import {
  SHIPPING_REGIME, EMAIL_STATE,
  readShipping, carrierByCode, carrierOf, numberLabel,
  requiresProductCode, buildsTrackingUrl, supportsLiveTracking,
  validateShipping, formFromShipping, buildPayload, hasChanges, changedFieldCount,
  emailState, sendability, shippingErrorMessage, isConcurrencyConflict,
  isNotShippedRefusal, describeEmailOutcome, fieldIssuesFromError,
  reconcileCarrier, carrierWasDefaulted,
} from '../utils/shipping-info.js';
import {
  SENT_STATE, SEND_REGIME, resolveSentInfo, INVOICE_SENT_KIND,
  readServerInvoiceSent, orderSendRegime,
  isInvoiceSendEvent, invoiceSendNoteText,
} from '../utils/order-invoice-sent.js';
// "Has this customer asked us where their parcel is?" — the whole vocabulary,
// including the two facts the backend deliberately does NOT fold into `state`:
// whether a cancelled order's request can still be cleared, and how long the
// customer has been waiting. Nothing in this page may read `tracking_request`
// directly; a second copy of these rules is how the cell and the modal would
// start disagreeing about one customer (ERR-201).
import {
  TRACK_STATE, TRACK_REGIME,
  readTrackingRequestFrom, trackingRequestRegime,
  resolveTrackingInfo, trackingChipCopy,
} from '../utils/order-tracking-request.js';
// Deletability is a SERVER answer, per order, per caller — never a status rule
// re-implemented here. utils/order-deletability.js owns the whole vocabulary:
// which door, why not, what the confirm dialog says, how a purge response reads.
import {
  DELETE_METHOD, UNACCOUNTED_COPY,
  orderDeleteRight, resolveDeleteRight, deleteContractOf, hasDeleteContract,
  groupSelectionForDelete, blockedSummary, deletePlanCopy, deleteActionLabel,
  methodVerb, purgeFailureCopy,
} from '../utils/order-deletability.js';

// Re-exported so existing importers of orders.js keep working; the definition now
// lives in utils/order-profit.js (utils must never import a page — that would be
// circular). pages/dashboard.js keeps its own documented mirror.
export { isInvoiceOrder };
// The channel vocabulary itself, for callers that need all three values rather
// than the one boolean. Its own statement so the pin on the line above stays exact.
export { orderChannel };

const formatPrice = (v) => window.formatPrice ? window.formatPrice(v) : `$${Number(v).toFixed(2)}`;
const MISSING = '\u2014';

/**
 * Delete gating. THE RULE IS NOT HERE.
 *
 * `GET /api/admin/orders` returns `deletable` / `delete_method` /
 * `delete_blocked_reason` on every row, computed server-side from the caller's
 * role AND the order. This page reads that answer and routes on it; it never
 * derives deletability from `status` and never infers it from the admin's role.
 * The whole vocabulary \u2014 the two doors, the block reasons, the copy, the confirm
 * wording, the purge-response shape \u2014 lives in utils/order-deletability.js so the
 * bulk bar and the single-order button cannot drift apart again (ERR-120).
 *
 * The old `DELETABLE_STATUSES = ['cancelled']` is gone. It survives only as
 * `LEGACY_DELETABLE_STATUSES` inside that util, as the fallback for rows that
 * carry no contract fields \u2014 and that fallback can never yield a purge.
 *
 * Selection survives pagination (DataTable.setData does not clear it), so the
 * bulk bar can hold ids whose rows have left `_table.data`. `_seenOrders` keeps
 * every row we have seen this session \u2014 including its delete contract, VERBATIM
 * via deleteContractOf(), so absence stays absence and a cached pre-deploy row
 * still resolves through the legacy path instead of reading as "server says no".
 */
const _seenOrders = new Map();

function rememberOrders(rows) {
  for (const r of rows || []) {
    if (r && r.id) {
      _seenOrders.set(r.id, {
        order_number: r.order_number,
        status: r.status,
        ...deleteContractOf(r),
      });
    }
  }
}

function lookupOrder(id) {
  return (_table?.data || []).find(r => r.id === id) || _seenOrders.get(id) || null;
}

/**
 * Drop everything we remember about an order.
 *
 * Called for EVERY id we attempted \u2014 deleted, refused, and unknown-outcome
 * alike. A refusal is newer information than our cache: if the row said
 * `delete_method: 'purge'` and the server came back ORDER_HAS_INVOICE_LINK, the
 * cached contract is provably wrong and must not gate the next click. Also
 * called after a status change, which flips deletability under a selection the
 * admin may still be holding.
 */
function forgetOrderCache(id) {
  if (!id) return;
  _seenOrders.delete(id);
  forgetProfit(id);
  forgetInvoiceSent(id);
}

/**
 * Profit column state.
 *
 * The orders LIST endpoint does not return `supplier_cost_snapshot` or
 * `shipping_absorbed` — those exist only on GET /api/admin/orders/:id (ERR-039).
 * So the column can't be rendered from the list payload; it fans out one cheap
 * detail GET per visible row AFTER the table has painted, and patches the cells
 * in as they land. Results are cached by order id, so paging back and forth
 * costs nothing.
 *
 * 20 rows/page minus the cancelled ones (which need no fetch at all), in batches
 * of 6 against the backend's 60/min limiter — the same budget reasoning as the
 * dashboard's missing-cost scan. Orders has no per-page selector wired, so the
 * 20 is fixed; if that ever changes this fan-out needs a cap.
 */
const _profitCache = new Map();   // orderId -> orderProfitFromDetail(...) result
let _profitAbort = null;
const PROFIT_BATCH = 6;

function forgetProfit(id) {
  if (id) _profitCache.delete(id);
}

/**
 * One renderer for both the initial paint and the async patch, so a cell can
 * never look different depending on which path produced it.
 *
 * The five non-numeric states are deliberately distinguishable. "We haven't
 * asked yet", "we asked and the call failed", "there is no cost on record",
 * "this order was cancelled" and "this order has no lines" are four different
 * facts about the business, and collapsing any of them into $0 — or into each
 * other — is exactly how the dashboard once reported a clean bill of health off
 * a scan that never ran (ERR-074).
 */
/**
 * Muted "−$12.90" under a list row's Total, when the order carries one.
 *
 * Reads the LIST row directly — `discount_amount` and `coupon_code` ride every
 * row since backend 52abc83, so this costs no request. Deliberately NOT owner-
 * gated: a discount is customer money, not cost.
 *
 * Absent / null / 0 renders nothing at all. An order with no discount must look
 * like an order with no discount, not like one discounted by $0.00.
 */
function orderDiscountSubline(r) {
  const amount = Number(r?.discount_amount);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  const code = r?.coupon_code ? String(r.coupon_code) : null;
  const tip = `Volume pricing, coupon and loyalty combined — already deducted from this total.`
    + (code ? ` Includes promo code ${code}.` : '');
  return `<span class="order-discount-sub" title="${esc(tip)}">−${formatPrice(amount)}</span>`;
}

function profitCellHtml(row, info) {
  const id = esc(row.id);
  const open = (cls, title) =>
    `<span class="order-profit${cls ? ' ' + cls : ''}" data-order-profit="${id}" title="${esc(title)}">`;

  if (!info || info.state === PROFIT_STATE.PENDING) {
    return `${open('order-profit--pending', 'Loading cost data…')}·</span>`;
  }
  switch (info.state) {
    case PROFIT_STATE.CANCELLED:
      return `${open('order-profit--none', 'Cancelled — no profit realised.')}${MISSING}</span>`;
    case PROFIT_STATE.NO_ITEMS:
      return `${open('order-profit--none', 'No line items recorded on this order, so there is nothing to cost.')}${MISSING}</span>`;
    case PROFIT_STATE.UNKNOWN: {
      const n = info.missingCostCount;
      // Two causes, two sentences — see the modal's unknownFootTip for why this
      // must not always blame a missing supplier cost.
      const tip = n > 0
        ? `${n} of ${info.itemCount} item${info.itemCount === 1 ? '' : 's'} `
          + `${n === 1 ? 'has' : 'have'} no recorded supplier cost — profit can't be computed. `
          + `It is UNKNOWN, not $0.`
        : info.discountExceedsRevenue
          ? `The recorded order discount is at or above this order's entire line total, so revenue `
            + `and profit can't be stated. UNKNOWN, not $0 — check the order's discount_amount.`
          : `This order's revenue can't be stated, so profit can't be computed. UNKNOWN, not $0.`;
      return `${open('order-profit--none', tip)}${MISSING}</span>`;
    }
    case PROFIT_STATE.FAILED:
      return `${open('order-profit--failed', 'Cost lookup failed — reload to retry. This is NOT $0.')}${MISSING}</span>`;
    default:
      break;
  }

  const tip = (info.isInvoice
    ? 'Take-home profit (GST-neutral): ex-GST revenue minus ex-GST supplier cost. Invoiced sale paid by bank transfer, so no card fee.'
    : 'Take-home profit (GST-neutral): ex-GST revenue minus ex-GST supplier cost minus Stripe fee (2.65% + $0.30) on the full charged amount.')
    + (info.absorbedApplies ? ' Absorbed courier cost (free shipping) is subtracted.' : '')
    // Revenue here is REALISED revenue — the line sum less the order discount
    // (ERR-168). Naming the amount stops this figure looking wrong beside a Total
    // the operator can see is lower than the line prices.
    + (info.discountApplies
      ? ` Revenue is net of the ${formatPrice(info.orderDiscountInclGst)} order discount`
        + ` (${formatPrice(info.orderDiscountExGst)} ex-GST).`
      : '')
    + ' Open the order for the full breakdown.';
  const lossCls = info.netProfit < 0 ? ' order-profit__amt--loss' : '';
  return `${open('', tip)}`
    + `<span class="order-profit__amt${lossCls}">${formatPrice(info.netProfit)}</span>`
    + marginBadge(info.netMarginPct)
    + `</span>`;
}

// Swap a single cell in place. Deliberately NOT _table.setData/setColumns: those
// re-render the whole table, which would drop keyboard row focus and re-bind
// every handler each time one of ~20 in-flight fetches lands.
function patchProfitCell(row) {
  if (!_table?.container || !row?.id) return;
  const cell = _table.container.querySelector(`[data-order-profit="${CSS.escape(String(row.id))}"]`);
  if (cell) cell.outerHTML = profitCellHtml(row, _profitCache.get(row.id));
}

/**
 * Fill in the Profit column for the rows now on screen.
 *
 * Called AFTER _table.setData — never awaited before it, so the table paints
 * immediately and profit arrives progressively (the dashboard first-paint rule,
 * ERR-121). Superseded loads abort their predecessor so leaving the page or
 * paging fast doesn't burn the rate limiter on rows nobody is looking at.
 */
async function hydrateProfits(rows) {
  _profitAbort?.abort();
  _profitAbort = null;
  if (!AdminAuth.isOwner() || !Array.isArray(rows) || !rows.length) return;

  const ctrl = new AbortController();
  _profitAbort = ctrl;

  const todo = [];
  for (const row of rows) {
    if (_profitCache.has(row.id)) { patchProfitCell(row); continue; }
    // Cancelled orders are resolvable from the list row alone — no revenue was
    // realised, so there is nothing to fetch. On a page like the current one
    // that's a third of the requests saved.
    const fromListRow = orderProfitFromDetail(row);
    if (fromListRow.state === PROFIT_STATE.CANCELLED) {
      _profitCache.set(row.id, fromListRow);
      patchProfitCell(row);
      continue;
    }
    todo.push(row);
  }

  for (let i = 0; i < todo.length; i += PROFIT_BATCH) {
    if (ctrl.signal.aborted || !_table) return;
    const batch = todo.slice(i, i + PROFIT_BATCH);
    const results = await Promise.allSettled(batch.map(r => AdminAPI.getOrder(r.id, ctrl.signal)));
    if (ctrl.signal.aborted || !_table) return;
    results.forEach((res, j) => {
      const row = batch[j];
      // A detail call we couldn't make is not $0 and not "no cost recorded" — it
      // is a question we failed to ask. Cache it as FAILED so the cell says so.
      const info = (res.status === 'fulfilled' && res.value)
        ? orderProfitFromDetail(res.value)
        : { state: PROFIT_STATE.FAILED };
      _profitCache.set(row.id, info);
      patchProfitCell(row);
    });
  }
}

function orderLabel(id) {
  const o = lookupOrder(id);
  return window.OrderNumber.forDisplay(o?.order_number) || String(id || '').slice(0, 8) || 'order';
}

/**
 * Split a bulk selection into its two doors plus the blocked remainder.
 *
 * Fail-CLOSED: an id we cannot resolve at all is blocked, and now says so in its
 * own words (`fe_unresolved`) instead of borrowing the cancelled-only sentence.
 * Firing a request we cannot vouch for is worse than admitting we cannot vouch
 * for it — and under the purge door it would be irreversible.
 */
function groupSelection(selected) {
  return groupSelectionForDelete([...selected], lookupOrder);
}

/**
 * Which channel the order arrived through, as a badge.
 *
 * Reads utils/order-profit.js `orderChannel()` \u2014 the SAME derivation the
 * no-card-fee profit rule uses, and the same one the Invoice sent column gates
 * on while the backend's `channel` field is missing. Three surfaces, one answer.
 * A second copy here is how the badge and the money would come to disagree about
 * what an invoiced sale is.
 */
const CHANNEL_BADGE = Object.freeze({
  [ORDER_CHANNEL.INVOICE]: {
    cls: 'admin-badge--invoice', label: 'Invoice',
    tip: 'Invoiced sale \u2014 phone, walk-in or B2B. Paid by bank transfer, so no card fee.',
  },
  [ORDER_CHANNEL.QUICK_ORDER]: {
    cls: 'admin-badge--quick', label: 'Quick order',
    tip: 'Raised from the admin Quick Order page rather than the website checkout.',
  },
  [ORDER_CHANNEL.WEB]: {
    cls: 'admin-badge--web', label: 'Website',
    tip: 'Placed through the website checkout.',
  },
});

function channelBadge(o) {
  // An unrecognised channel falls to WEB inside orderChannel() (handoff Rule 3),
  // so this lookup cannot miss \u2014 but default anyway rather than render
  // `undefined` if the vocabulary and the badge map ever drift.
  const spec = CHANNEL_BADGE[orderChannel(o)] || CHANNEL_BADGE[ORDER_CHANNEL.WEB];
  return `<span class="admin-badge ${spec.cls}" title="${esc(spec.tip)}">${esc(spec.label)}</span>`;
}

/**
 * Turn a backend shipping-zone slug ("north-island") into a display label
 * ("North Island") for the absorbed-courier tooltip. Blank/absent → '' so the
 * caller drops the "for {zone}" clause entirely rather than printing junk.
 */
function titleCaseZone(zone) {
  if (!zone || typeof zone !== 'string') return '';
  return zone.trim().split(/[-_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// originBadge() and supplierCell() moved to utils/sourcing.js (imported above) when
// the Products page gained the same two columns. Both render exactly as before \u2014
// the util owns the origin vocabulary now so the two pages cannot drift.

let _container = null;
let _table = null;
let _page = 1;
let _search = '';
// Module-scoped, not a closure inside renderOrdersTab(), so destroyOrdersTab() can
// actually cancel it. A pending keystroke that fires after a tab switch would call
// loadOrders() against a torn-down _table (ERR-045 family).
let _searchDebounce = null;
let _sort = 'created_at';
let _sortDir = 'desc';
let _activeModal = null;
let _bulkBar = null;
let _activeTab = 'orders'; // orders | refunds | compliance
let _subTabModule = null;

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  return `<span class="admin-badge admin-badge--${esc(s)}">${esc(status || 'Unknown')}</span>`;
}

function formatDate(d) {
  if (!d) return MISSING;
  try {
    return new Date(d).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return MISSING; }
}

function formatDateTime(d) {
  if (!d) return MISSING;
  try {
    return new Date(d).toLocaleString('en-NZ', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return MISSING; }
}

/**
 * ============================================================================
 * "Last invoice sent" — when this order's invoice email last went out
 * ============================================================================
 *
 * WHAT WE ACTUALLY KNOW, and what we deliberately do not:
 *
 *   public.invoices.emailed_at   the server's own record. Wins whenever present.
 *                                Today it is NULL on every row — the column
 *                                exists but the backend never stamps it, including
 *                                for the automatic email sent at checkout. See
 *                                readfirst/order-invoice-emailed-at-backend-brief-aug2026.md
 *                                (BF-046). The moment that lands, every row here
 *                                fills in with NO frontend change.
 *   order_events note + sentinel every resend fired from this page. All we can
 *                                observe ourselves.
 *
 * THE ORDER DATE IS NOT A SEND DATE. `created_at` / `paid_at` / `invoice_date`
 * are all within seconds of purchase and it is tempting to show one of them as
 * "sent". They are not evidence that any email left the building. An order with
 * no send on record reads "Not recorded", which is the truth, and is NOT the
 * same cell as one whose lookup failed — see SENT_STATE.FAILED. Collapsing those
 * two is the absence-as-zero family this repo keeps re-learning
 * (ERR-063/068/073/075/076/149/150).
 *
 * AND THE QUESTION DOES NOT APPLY TO EVERY ROW (ERR-199). A storefront order is
 * never "invoiced" by an operator — the customer is emailed their receipt by the
 * payment webhook. Printing "Not recorded" on 13 of 15 rows read as 13 outstanding
 * tasks that did not exist. Those rows are now NOT_APPLICABLE and render an
 * em-dash, which is a THIRD answer: not "no record", not "could not check", but
 * "this question is not asked of this row".
 *
 * Which rows those are is decided by utils/order-invoice-sent.js under one of two
 * regimes — the backend's `invoice_sent` field when it is on the payload, and
 * `orderChannel()` off `payment_method` until then. Read that module's header for
 * why the two are not one code path, and why an ABSENT field is not a null one.
 */
const _sentCache = new Map();   // orderId -> resolveSentInfo(...) result
let _sentAbort = null;

function forgetInvoiceSent(id) {
  if (id) _sentCache.delete(id);
}

/**
 * Tell the sidebar its tracking count may have moved.
 *
 * The backend clears an open tracking request when a shipping-information email
 * actually goes out — across five admin send paths, three of which live on this
 * page. Before this column existed nobody could see the staleness: the count sat
 * in the sidebar and the request lived on a different screen. Now the operator
 * watches the chip disappear from the row in front of them while the badge two
 * inches to the left still counts it, which is one fact rendered two ways on one
 * screen — the thing utils/order-invoice-sent.js opens by warning about.
 *
 * Deliberately fire-and-forget and deliberately unconditional on the email's
 * outcome: the backend gates fulfilment on the send returning true, and asking
 * it for the number is cheaper and more honest than deciding here whether the
 * number changed. A failed refresh leaves the old count standing, which is the
 * behaviour it already had.
 */
function refreshTrackingCount() {
  try { refreshTrackingRequestsBadge(); } catch { /* the badge is never worth an exception */ }
}

/**
 * Short cell date — "27 Aug". Full timestamp lives in the tooltip.
 *
 * THE try/catch BELOW CANNOT CATCH THE FAILURE IT WAS WRITTEN FOR.
 * `new Date('nonsense')` does not throw; it returns an Invalid Date, and
 * `Invalid Date.toLocaleDateString()` is the literal string "Invalid Date" —
 * which this function would then have printed into the cell. Nothing observed
 * live has ever hit it (every `sent_at` the backend sends is a real timestamp),
 * so this is a latent hole rather than a live bug, but it is one line and it
 * sits in the middle of the cell being rebuilt (ERR-201). shortStamp() applies
 * the same guard for the tracking chip beside it; the two are kept separate only
 * because this one answers in MISSING and the util answers in null.
 */
function formatSentShort(d) {
  if (!d) return MISSING;
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return MISSING;
    return dt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
  } catch { return MISSING; }
}

/**
 * One sentence per state, plus the pair whose MEANING changes with the regime.
 *
 * Under SERVER the backend has looked in the place invoices are actually emailed
 * from, so "no send" is a real outstanding task. Under LOCAL it is only "we have
 * no record" — and the cell uses a different word for it ("Not recorded" vs
 * "Not sent") precisely so an operator can tell which of the two answers they are
 * being given. Same discipline as ERR-175's "Not recorded" vs "Can't check".
 */
const SENT_TIP = Object.freeze({
  [SENT_STATE.NOT_RECORDED]:
    'No invoice send recorded for this order. That does NOT mean none was sent \u2014 '
    + 'the invoice email sent automatically at checkout is not recorded by the backend, and a '
    + 'send made from the Invoices page is not visible here either, so only resends fired from '
    + 'this page appear. The backend link that would close that gap (invoice_id) has not shipped.',
  [SENT_STATE.NO_INVOICE]:
    'No invoice record exists for this order, so there is nothing that could have been emailed.',
  [SENT_STATE.FAILED]:
    'Invoice-send lookup failed \u2014 reload to retry. This is NOT "never sent": we could not check.',
  [SENT_STATE.NOT_APPLICABLE]:
    'Not applicable \u2014 this is not an invoiced sale. The customer was emailed their receipt '
    + 'automatically at checkout; an operator never issues an invoice for it, so there is no send '
    + 'for this column to report. Blank here means "no such task", not "nothing was sent".',
});

/**
 * The NOT_RECORDED label and tooltip, which differ by regime. See SENT_TIP.
 * Keyed by regime so a new regime cannot be added without answering this too.
 */
const NOT_RECORDED_COPY = Object.freeze({
  [SEND_REGIME.SERVER]: {
    label: 'Not sent',
    tip: 'This invoice has never been emailed. The backend checked the send log AND the pre-log '
      + 'stamp and found neither, so this is a real outstanding send \u2014 not a gap in our records.',
  },
  [SEND_REGIME.LOCAL]: {
    label: 'Not recorded',
    tip: SENT_TIP[SENT_STATE.NOT_RECORDED],
  },
});

/**
 * "Tracking requested" — the chip that shares this cell with the invoice answer.
 *
 * A SIBLING ELEMENT, NOT PART OF sentCellHtml, AND THAT IS LOAD-BEARING.
 * patchSentCell() replaces `[data-order-sent]` wholesale via outerHTML, so every
 * branch of sentCellHtml has to keep returning exactly ONE root. Rendering the
 * chip inside it would mean either moving that hook (breaking the history
 * button's dataset.orderSent) or letting the next patch silently eat the chip —
 * and the patch fires on every modal open, every modal close and every
 * hydration landing, so it would vanish at exactly the moments an operator was
 * looking at the row. The chip gets its own hook, `[data-order-track]`, and the
 * two halves of this cell can never clobber one another.
 *
 * IT ALSO NEEDS NO CACHE, NO FETCH AND NO HYDRATION, which is the whole
 * difference between it and the Invoice sent renderer next door. The answer is
 * already on the list payload; there is nothing to look up. The symmetry with
 * hydrateInvoiceSent() is inviting and wrong — copying that fan-out here would
 * issue one pointless request per row for a field we are already holding.
 *
 * BOTH FACTS RENDER. The hand-off suggests precedence (tracking outranks the
 * invoice answer and hides it), and the owner chose stacking instead: on an
 * invoice-claimed order whose customer ALSO asked for tracking, suppressing the
 * send date would be the frontend deciding one true thing cancels out another.
 * Rows carrying only one of the two look exactly as they did before this change.
 *
 * The hook element is emitted even when there is nothing to say, so a future
 * patch has a target and so the cell's structure does not change shape between
 * rows.
 *
 * `now` is injectable purely so "N days waiting" can be asserted against a fixed
 * clock. Without it the age tests would pass or fail depending on the hour the
 * suite ran — which is not a test, it is a coin toss that occasionally reports a
 * bug.
 */
function trackingChipHtml(row, now = null) {
  const id = esc(String(row?.id ?? ''));
  const copy = trackingChipCopy(resolveTrackingInfo({ order: row, now }));
  if (!copy) return `<span class="order-track order-track--empty" data-order-track="${id}"></span>`;
  const sub = copy.sub ? `<span class="order-track__when">${esc(copy.sub)}</span>` : '';
  return `<span class="order-track" data-order-track="${id}" title="${esc(copy.tip)}">`
    + `<span class="order-track__pill ${esc(copy.cls)}">${esc(copy.label)}</span>${sub}</span>`;
}

/**
 * Say so, by name, when the backend has not shipped the field.
 *
 * Without this the degradation is completely invisible: an order list with no
 * `tracking_request` key renders precisely the same cells as one where nobody
 * has asked for tracking. That is the fallback-shaped failure this repo keeps
 * re-learning — the answer looks fine, so nothing gets reported, so a dead
 * column survives for weeks (ERR-063/068/073/075/076/149/150, and ERR-193's
 * 44 hours of empty shelves).
 *
 * Warned once per load rather than per row, and from the page as a whole, for
 * the same reason orderSendRegime() is read once: a page answering under two
 * regimes at once would put two meanings of "no chip" in one column.
 */
function noteTrackingRegime(rows) {
  if (trackingRequestRegime(rows) === TRACK_REGIME.SERVER) return;
  window.DebugLog?.warn?.('[orders] GET /api/admin/orders carries no `tracking_request` field — '
    + 'the "Tracking requested" chip cannot render, and a customer waiting on tracking is '
    + 'indistinguishable here from one who never asked. This is NOT "nobody asked". The standalone '
    + 'Tracking Requests page still has the queue. Run: npm run probe:tracking-requested');
}

/**
 * One renderer for the first paint and the async patch, so a cell cannot look
 * different depending on which path produced it (same rule as profitCellHtml).
 */
function sentCellHtml(row, info) {
  const id = esc(row.id);
  const open = (cls, title) =>
    `<span class="order-sent${cls ? ' ' + cls : ''}" data-order-sent="${id}" title="${esc(title)}">`;

  if (!info || info.state === SENT_STATE.PENDING) {
    return `${open('order-sent--pending', 'Checking when this invoice was last sent\u2026')}\u00b7</span>`;
  }

  // NOT APPLICABLE is checked FIRST of the settled states, and deliberately so:
  // it is the one answer that means the column had no business asking, and it
  // must never be reachable by falling through the states that mean "we asked
  // and got nothing". An inert span \u2014 there is no history behind an em-dash.
  if (info.state === SENT_STATE.NOT_APPLICABLE) {
    return `${open('order-sent--na', SENT_TIP[SENT_STATE.NOT_APPLICABLE])}${MISSING}</span>`;
  }

  if (info.state === SENT_STATE.SENT) {
    const n = info.count || 1;
    // "recorded sends", never "sent N times". Neither regime sees every send:
    // under LOCAL the checkout email is recorded nowhere (BF-046) and a send made
    // from the Invoices page is invisible here; under SERVER a legacy stamp
    // predates the send log. So the number is a FLOOR, and it says so.
    const floor = info.floor || info.truncated;
    // recordedSendsPhrase() rather than the same sentence spelled a third time.
    // utils/send-history.js exists so the Orders column and the Invoices column
    // cannot describe one fact in two vocabularies (ERR-120/129/143/180), and a
    // page that keeps its own copy is a page that will drift from it.
    const tip = `Invoice last sent ${formatDateTime(info.at)}.`
      + (info.countKnown
        ? ` ${recordedSendsPhrase(n, { floor })}.`
        : ' At least one recorded send \u2014 the exact count was never logged.')
      + (info.invoiceNumber ? ` Invoice ${info.invoiceNumber}.` : '')
      + ' Click for the full history.';
    // \u00d7N past one send only, AND only when the count is a real tally. A zero
    // count beside a real date is UNKNOWN, not zero \u2014 the handoff's
    // legacy_stamp case, and the exact bug ERR-180 shipped on the Invoices page.
    // So `countKnown` gates this every bit as hard as `n > 1` does; printing
    // "\u00d71" over a single send would state a fact we would be inventing.
    const times = info.countKnown && n > 1 ? `<span class="order-sent__times">\u00d7${esc(n)}</span>` : '';
    // A <button>, not a <span>: it opens the history, it is keyboard-reachable,
    // and DataTable's row-click guard skips `closest('button, a, input')` \u2014 so
    // this click cannot also open the order behind it (components/table.js).
    return `<button type="button" class="order-sent order-sent--yes" data-order-sent="${id}"`
      + ` data-action="sent-history" title="${esc(tip)}">`
      + `${formatSentShort(info.at)}${times}</button>`;
  }

  // "We looked and found nothing" \u2014 and WHICH nothing depends on who looked.
  // Under SERVER this is a real outstanding send; under LOCAL it is only the
  // absence of a record. Two words for two claims (ERR-175).
  if (info.state === SENT_STATE.NOT_RECORDED) {
    const copy = NOT_RECORDED_COPY[info.regime] || NOT_RECORDED_COPY[SEND_REGIME.LOCAL];
    return `${open('order-sent--none', copy.tip)}${copy.label}</span>`;
  }

  // FAILED is styled apart from every "we looked" state on purpose \u2014 an
  // operator must never read a broken lookup as "never invoiced".
  const cls = info.state === SENT_STATE.FAILED ? 'order-sent--failed' : 'order-sent--none';
  return `${open(cls, SENT_TIP[info.state] || '')}${MISSING}</span>`;
}

/**
 * The send history panel — every send we have a record of, newest first.
 *
 * Pure, so the three branches can be exercised directly in tests (the same
 * reason renderSentHistory on the Invoices page is pure). It needs no fetch:
 * `info.sends` is already in hand from the page's batched read, which is also
 * why this carries none of the Invoices version's _historyToken machinery —
 * there is no async response that could land in a stale modal.
 */
function renderOrderSendHistory(info, orderNumber) {
  // ALWAYS shown on an invoice row, and WHAT it admits depends on who answered.
  //
  // Under SERVER the limit is the SHAPE of the field, not a gap in the record:
  // `invoice_sent` carries ONE timestamp (the most recent) and a total, so a
  // fully-logged invoice sent three times still lists one row. Saying those
  // unlisted sends "predate the send log" would be inventing a reason \u2014 that
  // is only true when `floor` is set, which is the legacy_stamp case, and it
  // gets its own sentence.
  //
  // Under LOCAL two whole sources are invisible, and the second one is the
  // reason this feature was reported broken in the first place.
  const caveat = info?.regime === SEND_REGIME.SERVER
    ? `<p class="inv-hist__note">The backend reports the most recent send and a total, so only the
       latest is listed individually.${info?.floor ? ' At least one send predates the send log and'
      + ' was never recorded on its own, so the total is a lower bound.' : ''}</p>`
    : `<p class="inv-hist__note">Only sends recorded here are listed. The invoice emailed
       automatically at checkout isn\u2019t recorded yet, and a send made from the Invoices page
       isn\u2019t visible on this page at all \u2014 the backend link that would join them
       (invoice_id) hasn\u2019t shipped \u2014 so there may have been earlier sends we can\u2019t
       see.</p>`;

  if (info?.state === SENT_STATE.FAILED) {
    return `<div class="inv-hist__error">
        <p><strong>Couldn\u2019t load this order\u2019s send history.</strong></p>
        <p>This is a read error, not proof that nothing went out \u2014 don\u2019t read it as a clean
           history. Close this and reload to retry.</p>
      </div>`;
  }

  // The question does not apply to this row at all. Below FAILED on purpose:
  // the two states are mutually exclusive (a row nobody looked up cannot have a
  // failed lookup), and a read error must be answered before ANY branch that
  // renders "nothing to show" \u2014 that ordering is pinned by
  // tests/admin-order-invoice-sent-aug2026.test.js and is worth keeping exact.
  if (info?.state === SENT_STATE.NOT_APPLICABLE) {
    return `<div class="inv-hist__empty">
        <p><strong>This order was not invoiced.</strong></p>
        <p>It came through the website checkout, so the customer was emailed their receipt
           automatically and no operator invoice was ever issued. There is no send history to
           show \u2014 which is not the same as nothing having been sent.</p>
      </div>`;
  }

  const sends = info?.sends || [];
  if (!sends.length) {
    return `<div class="inv-hist__empty">
        <p><strong>No invoice send recorded for this order.</strong></p>
      </div>${caveat}`;
  }

  const items = sends.map((s) => {
    const who = s.source === 'server'
      ? 'recorded by the backend when the email was sent'
      : 'resent from the admin Orders page';
    return `<li class="inv-hist__row">
        <div class="inv-hist__when">${esc(formatDateTime(s.at))}</div>
        <div class="inv-hist__subject">${esc(who)}</div>
      </li>`;
  }).join('');

  // A list that is SHORT of the count, said out loud. A count above the rows
  // shown is the whole reason this panel exists (ERR-177) \u2014 but the sentence has
  // to be true: `truncated` is our own 500-row scan filling up, and a SERVER count
  // above one is the field's shape, not a missing record.
  //
  // The condition is `count > sends.length` ALONE. Adding `|| info.floor` printed
  // "1 recorded send or more \u2014 more than the one listed" over a single listed
  // send, which is not more than one. The floor is stated in the caveat instead,
  // where it belongs.
  const cut = info.truncated
    ? `<p class="inv-hist__note">There were more events than this page reads in one go, so this
       list may be incomplete.</p>`
    : (info.count > sends.length
      ? `<p class="inv-hist__note">${esc(recordedSendsPhrase(info.count, { floor: info.floor }))} in
         total \u2014 more than the ${sends.length === 1 ? 'one' : sends.length} listed above.</p>`
      : '');
  return `<ul class="inv-hist">${items}</ul>${caveat}${cut}`;
}

/** Open the send history for one order. Renders from cache — no fetch. */
function openOrderSendHistory(order, info) {
  const modal = Modal.open({
    title: `Invoice send history \u2014 ${window.OrderNumber.forDisplay(order?.order_number) || order?.id?.slice(0, 8) || 'order'}`,
    className: 'admin-modal--invoice-history',
    body: renderOrderSendHistory(info, order?.order_number),
    footer: `<button class="admin-btn admin-btn--ghost" data-action="close">Close</button>`,
  });
  if (!modal) return;
  modal.footer.querySelector('[data-action="close"]')?.addEventListener('click', () => Modal.close());
}

/**
 * The modal's "Invoice sent" value — the same four states as the column, spelled
 * out at full length because there is room for a sentence here.
 */
function modalSentValue(info) {
  if (!info || info.state === SENT_STATE.PENDING) {
    return `<span class="admin-text-muted">Checking\u2026</span>`;
  }
  // There is room for a sentence here, so the em-dash gets one. A bare dash in
  // the detail modal would read as missing data rather than as "not asked".
  if (info.state === SENT_STATE.NOT_APPLICABLE) {
    return `<span class="admin-text-muted">${MISSING} not an invoiced sale</span>`
      + `<span class="admin-text-muted" style="font-weight:400"> \u00b7 the receipt was emailed `
      + `automatically at checkout, so there is no operator invoice to send</span>`;
  }
  if (info.state === SENT_STATE.SENT) {
    const n = info.count || 1;
    const who = info.source === 'server'
      ? 'recorded by the backend'
      : 'recorded when resent from this page';
    // "recorded sends", not "sent N times" \u2014 a floor under both regimes. The
    // button opens the same history panel the list column does, so the two
    // surfaces cannot tell different stories.
    const floor = info.floor || info.truncated;
    return `${esc(formatDateTime(info.at))}`
      + `<span class="admin-text-muted" style="font-weight:400"> \u00b7 ${esc(who)}</span>`
      + ` <button type="button" class="om-sent-more" data-action="om-sent-history">`
      + `${esc(info.countKnown
        ? recordedSendsPhrase(n, { floor, compact: true })
        : 'send history')}</button>`;
  }
  if (info.state === SENT_STATE.FAILED) {
    return `<span class="order-sent--failed" title="${esc(SENT_TIP[SENT_STATE.FAILED])}">Can\u2019t check</span>`
      + `<span class="admin-text-muted" style="font-weight:400"> \u00b7 reload to retry \u2014 this is not \u201cnever sent\u201d</span>`;
  }
  if (info.state === SENT_STATE.NO_INVOICE) {
    return `<span class="admin-text-muted">${MISSING} no invoice record for this order</span>`;
  }
  if (info.regime === SEND_REGIME.SERVER) {
    return `<span class="admin-text-muted">Not sent</span>`
      + `<span class="admin-text-muted" style="font-weight:400"> \u00b7 this invoice has never been `
      + `emailed \u2014 an outstanding send, not a gap in our records</span>`;
  }
  return `<span class="admin-text-muted">Not recorded</span>`
    + `<span class="admin-text-muted" style="font-weight:400"> \u00b7 the checkout email isn\u2019t `
    + `stamped and a send from the Invoices page isn\u2019t visible here, so this means no record `
    + `\u2014 not that nothing was sent</span>`;
}

/**
 * The modal's "Tracking request" value.
 *
 * ONE VOCABULARY WITH THE CHIP, and it is the same sentence, not a paraphrase.
 * trackingChipCopy() already writes the full explanation — the list cell hides
 * it in a tooltip only because a table cell has no room for it. The modal has
 * room, so it prints the very same string inline. A second set of words here is
 * how the cell and the modal would end up telling one operator two different
 * stories about one customer (ERR-120/129/143/180).
 *
 * ALWAYS RENDERED, including when nobody asked. An absent row would read as
 * "this order has no tracking request", which is a claim we can only make when
 * we actually looked — and the two cases where we did NOT look (the field is
 * absent, or unreadable) get their own words rather than a blank.
 */
function modalTrackingValue(info) {
  const muted = (txt) => `<span class="admin-text-muted" style="font-weight:400"> · ${esc(txt)}</span>`;

  if (!info || info.state === TRACK_STATE.UNKNOWN) {
    // Not "nobody asked" — this backend does not report the field at all, so the
    // question is unanswered rather than answered no.
    return `<span class="order-sent--failed">Can\u2019t check</span>`
      + muted('this backend does not report tracking requests on the order payload \u2014 '
        + 'the Tracking Requests page still has the queue');
  }
  if (info.state === TRACK_STATE.NONE) {
    return `<span class="admin-text-muted">${MISSING} no tracking request</span>`
      + muted('this customer has not asked where their parcel is');
  }

  const copy = trackingChipCopy(info);
  if (!copy) return `<span class="admin-text-muted">${MISSING}</span>`;

  // The very same pill the list cell renders, so the two surfaces are not just
  // saying the same words but wearing the same colour for the same state.
  return `<span class="order-track__pill ${esc(copy.cls)}">${esc(copy.label)}</span>${muted(copy.tip)}`;
}

/**
 * Swap one cell in place — never setData, which would drop row focus.
 *
 * `info` is passed EXPLICITLY rather than always re-read from the cache, because
 * the FAILED state is deliberately not cached (so a reload retries, as its
 * tooltip promises). Reading the cache here would find nothing for exactly those
 * rows and repaint them as "Checking…" — a spinner that never resolves, which
 * hides a failed lookup even better than "Not recorded" would.
 */
function patchSentCell(row, info = _sentCache.get(row?.id)) {
  if (!_table?.container || !row?.id) return;
  const cell = _table.container.querySelector(`[data-order-sent="${CSS.escape(String(row.id))}"]`);
  if (cell) cell.outerHTML = sentCellHtml(row, info);
}

/**
 * Fill in the Invoice-sent column for the rows now on screen.
 *
 * TWO requests for the whole page, not two per row: both reads are batched
 * `in.(...)` queries. Called AFTER _table.setData and never awaited before it,
 * so the table paints immediately (first-paint rule, ERR-121).
 */
/**
 * Resolve one row's send state without touching the network.
 *
 * Under SERVER this is the WHOLE answer \u2014 the backend has already applied the
 * channel rule and already merged its own two send sources, so re-deriving any
 * part of it here would be the second place to get it wrong (handoff Rule 1).
 * Under LOCAL it answers only for rows the question does not apply to, and those
 * rows are then skipped by the fan-out below rather than fetched and discarded.
 *
 * Returns null when the row genuinely needs a lookup.
 */
function sentInfoWithoutLookup(row, regime) {
  if (regime === SEND_REGIME.SERVER) {
    return resolveSentInfo({ serverSent: readServerInvoiceSent(row) });
  }
  // LOCAL: `payment_method` answers the channel question. `orderChannel()` is the
  // SAME derivation the Channel badge and the no-card-fee profit rule use, so a
  // row cannot be badged Website in one column and looked up as an invoice in the
  // next. Measured 146/146 against live data \u2014 npm run probe:orders-invoice-sent.
  if (orderChannel(row) !== ORDER_CHANNEL.INVOICE) {
    return resolveSentInfo({ applicable: false });
  }
  return null;
}

async function hydrateInvoiceSent(rows) {
  _sentAbort?.abort();
  _sentAbort = null;
  if (!Array.isArray(rows) || !rows.length) return;

  // WHICH REGIME IS LIVE is decided once, from the page as a whole, and never
  // per row: a page that answered under two regimes at once would put two
  // different meanings of "Not sent"/"Not recorded" in one column.
  const regime = orderSendRegime(rows);
  if (regime === SEND_REGIME.LOCAL) {
    // Loud, and by name. This is a real degradation \u2014 the column cannot see a
    // send made from the Invoices page \u2014 and it is invisible from the screen
    // alone, because the fallback renders a perfectly plausible cell.
    window.DebugLog?.warn?.('[orders] GET /api/admin/orders carries no `invoice_sent` field \u2014 '
      + 'falling back to payment_method for the channel rule and to order_events for the send '
      + 'record. Sends made from the Invoices page are NOT visible in this column until the '
      + 'backend ships invoice_sent/invoice_id. Run: npm run probe:orders-invoice-sent');
  }

  const todo = [];
  for (const row of rows) {
    if (_sentCache.has(row.id)) { patchSentCell(row); continue; }
    // Answered from the payload alone \u2014 cache it and paint it. Under SERVER this
    // is every row on the page, so the two batched lookups below never run at all.
    const direct = sentInfoWithoutLookup(row, regime);
    if (direct) {
      _sentCache.set(row.id, direct);
      patchSentCell(row, direct);
      continue;
    }
    todo.push(row);
  }
  if (!todo.length) return;

  const ctrl = new AbortController();
  _sentAbort = ctrl;

  const ids = todo.map(r => r.id);
  let invoices, events;
  try {
    [invoices, events] = await Promise.all([
      AdminAPI.getOrderInvoicesByOrderIds(ids, ctrl.signal),
      AdminAPI.getInvoiceSendEventsByOrderIds(ids, ctrl.signal),
    ]);
  } catch (e) {
    if (ctrl.signal.aborted || e?.name === 'AbortError') return;
    // A whole-batch failure is still a FAILED cell, never a silent blank.
    invoices = { byOrderId: new Map(), failed: true };
    events = { byOrderId: new Map(), failed: true, truncated: false };
  }
  if (ctrl.signal.aborted || !_table) return;

  for (const row of todo) {
    const key = String(row.id);
    const info = resolveSentInfo({
      invoice: invoices.byOrderId.get(key) || null,
      events: events.byOrderId.get(key) || [],
      invoiceFailed: invoices.failed,
      eventFailed: events.failed,
      truncated: !!events.truncated,
      // We only reach here for a row the channel rule said DOES apply, so say so
      // explicitly rather than leaving the default to imply it.
      applicable: true,
    });
    // A failed lookup is NOT cached \u2014 otherwise a single blip would pin every
    // row to "lookup failed" until the tab is destroyed, and reloading would
    // not retry as the tooltip promises.
    if (info.state !== SENT_STATE.FAILED) _sentCache.set(row.id, info);
    patchSentCell(row, info);
  }
}

const COLUMNS = [
  {
    key: 'created_at', label: 'Date', sortable: true,
    render: (r) => `<span class="cell-nowrap">${formatDate(r.created_at)}</span>`,
  },
  {
    // SORTABLE, AND IT SORTS BY DATE ON PURPOSE (ERR-198).
    //
    // admin/api.js maps this key to the backend's `newest`/`oldest`, i.e.
    // `created_at`. That used to be a distinction without a difference: while
    // every order number was `YYYYMMDD` + a zero-padded counter, sorting them
    // as strings gave exactly the chronological order. Migration 157 ended the
    // padding, so the two orderings have come apart —
    //
    //     '2026090199' > '20260901100'   // true, but order 99 came FIRST
    //
    // — and the 128 legacy `ORD-…` rows never sorted chronologically as strings
    // at all. Date is the ordering an operator actually wants from this column,
    // so the mapping stays; what changes is that it is now written down. Do not
    // "fix" api.js to sort on the order-number string: that is the bug.
    key: 'order_number', label: 'Order #', sortable: true,
    // Printed WHOLE — see dashboard.js orderRef() for why truncating one is not
    // safe any more. `cell-mono` carries no width and the Orders table is not
    // `--colsized`, so mixed 10/11/14/29-char values ragged-edge but never clip.
    render: (r) => `<span class="cell-mono">${esc(window.OrderNumber.forDisplay(r.order_number) || r.id?.slice(0, 8) || MISSING)}</span>`,
  },
  {
    key: 'customer', label: 'Customer',
    render: (r) => {
      const profile = r.user_profile || r.user_profiles || r.customer || {};
      const name = r.customer_name || profile.full_name
        || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
        || r.customer_email || profile.email || MISSING;
      return `<span class="cell-truncate">${esc(name)}</span>`;
    },
  },
  {
    key: 'status', label: 'Status', sortable: true,
    render: (r) => statusBadge(r.status),
  },
  {
    // Invoiced sales now sit in this list alongside website orders. Without this
    // column they're indistinguishable, and they behave differently (no card fee).
    key: 'channel', label: 'Channel',
    render: (r) => channelBadge(r),
  },
  {
    key: 'items', label: 'Items',
    render: (r) => {
      const count = r.item_count || r.items?.length || MISSING;
      return `<span class="cell-center">${count}</span>`;
    },
    align: 'center',
  },
  {
    key: 'total', label: 'Total', sortable: true, gst: GST_INCL,
    // The list endpoint carries discount_amount / coupon_code since backend
    // 52abc83, so the discount is scannable with NO detail fetch — unlike the
    // Profit column beside it, which has to fan out for costs (ERR-039).
    render: (r) => `<span class="cell-mono cell-right">`
      + `${(r.total_amount ?? r.total) != null ? formatPrice(r.total_amount ?? r.total) : MISSING}`
      + orderDiscountSubline(r)
      + `</span>`,
    align: 'right',
  },
  {
    // NOT sortable: the send date is not on the list payload at all (it is
    // hydrated after paint from two batched lookups), so a header click could
    // only sort the 20 rows already fetched while looking like a full sort.
    //
    // NO `gst:` SLOT. Blank there means "GST basis undocumented" for a money
    // column (utils/gst-basis.js) — this is a date, and borrowing that slot
    // would put it in the money vocabulary it has nothing to do with.
    // RENAMED from "Invoice sent" (ERR-201). The cell now answers two questions
    // — has this invoice been emailed, and is a customer waiting on tracking —
    // and a header naming only one of them would make the other look like a bug.
    // The backend's hand-off suggested the rename in as many words: "Consider
    // renaming the column header to Invoice / tracking so it reads honestly".
    key: '_invoice_sent', label: 'Invoice / tracking', className: 'cell-invoice-track',
    // TWO ROOTS, ONE CELL, and they are patched independently — see
    // trackingChipHtml() for why the chip is not folded into sentCellHtml().
    // Order matters: the outstanding request is the actionable half and reads
    // first, with the invoice answer beneath it.
    render: (r) => trackingChipHtml(r) + sentCellHtml(r, _sentCache.get(r.id)),
  },
  {
    // Owner-only — filtered out of the column list for everyone else, exactly
    // like the modal's Cost/Profit columns. NOT sortable: the backend's sort enum
    // is only newest|oldest|total-high|total-low (api.js) and silently falls back
    // to newest for anything else, and sorting client-side would order 20 of N
    // rows while looking like a full sort. Both are lies, so the header is inert.
    key: '_profit', label: 'Profit', gst: GST_NET,
    render: (r) => profitCellHtml(r, _profitCache.get(r.id)),
    align: 'right',
  },
  {
    key: '_actions', label: '',
    render: (r) => {
      const st = (r.status || '').toLowerCase();
      if (st === 'completed') return '';
      return `<button class="admin-btn admin-btn--ghost admin-btn--xs order-track-btn"
        data-order-id="${esc(r.id)}" data-action="quick-status"
        title="Update status">${icon('orders', 12, 12)} Status</button>`;
    },
    align: 'right',
  },
];

/**
 * Does this query look like an email address? Mirrors the branch in
 * AdminAPI.getOrders that routes an '@' query to `customer_email=` — a param the
 * backend answers with zero rows for every real address (probe:orders-search).
 * Used only to explain the empty result, never to block the request: if the
 * backend gains email search the query still goes out and still works, and the
 * message simply stops being reached.
 */
function looksLikeEmail(q) {
  return String(q || '').includes('@');
}

// Read a query param from the SPA hash, e.g. "#orders?focus=2026..." → "2026...".
function getHashParam(key) {
  const hash = window.location.hash || '';
  const qIndex = hash.indexOf('?');
  if (qIndex === -1) return null;
  return new URLSearchParams(hash.slice(qIndex + 1)).get(key);
}

/**
 * Merge a patch into the SPA hash query, leaving every key we don't own alone —
 * the same carry-through contract FilterState._writeToURL honours for keys outside
 * its _OWN_KEYS (period/granularity/from/to/brands/suppliers/statuses/categories).
 * `q` is not one of those, so the two writers coexist: changing a date chip keeps
 * the search, and typing a search keeps the date chip.
 *
 * Empty deletes the key so a cleared box leaves a clean "#orders" behind, and
 * replaceState keeps every keystroke out of the browser's back history.
 */
function writeHashParams(patch) {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const qIndex = hash.indexOf('?');
  const base = qIndex === -1 ? hash : hash.slice(0, qIndex);
  const params = new URLSearchParams(qIndex === -1 ? '' : hash.slice(qIndex + 1));
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  const next = `#${base || 'orders'}${qs ? '?' + qs : ''}`;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

// Open the order drawer for a specific order number once the list has loaded.
// Falls back gracefully to the filtered list if the order isn't in the results.
async function focusOnOrder(orderNumber) {
  if (!orderNumber || !_table) return;
  const rows = _table.data || [];
  const match = window.OrderNumber.pickExact(rows, orderNumber);
  if (match) {
    openOrderModal(match);
  }
  // else: leave the search applied so the admin can pick from the filtered list.
  //
  // There used to be an `else if (rows.length === 1) openOrderModal(rows[0])`
  // here — open the only row, on the assumption that a search for a whole order
  // number returning exactly one row must have returned THAT order. Fixed-width
  // numbers made that true; since ERR-198 they do not. `?search=` is a substring
  // ILIKE, so a deep link to `2026090110` can land on a page holding only
  // `20260901100` — one row, the wrong order, opened silently. Opening an order
  // the operator did not ask for is worse than opening none, so a near-miss now
  // leaves the filtered list on screen and lets them choose.
}

async function loadOrders() {
  _table.setLoading(true);
  const { from, to } = FilterState.getDateRange();
  const filters = {
    from, to,
    statuses: FilterState.get('statuses'),
    brands: FilterState.get('brands'),
    search: _search,
    sort: _sort,
    order: _sortDir,
  };
  const data = await AdminAPI.getOrders(filters, _page, 20);
  if (!_table) return;
  if (!data) {
    _table.setData([], null);
    return;
  }
  const rows = Array.isArray(data) ? data : (data.orders || data.data || []);
  const pagination = data.pagination || {
    total: data.total || rows.length,
    page: _page,
    limit: 20,
  };
  rememberOrders(rows);
  // A backend that stops sending the delete contract would silently revert this
  // whole surface to cancelled-only gating and nobody would find out — the UI
  // would just quietly refuse to delete paid orders again, which is exactly the
  // bug this replaced. Say it out loud, once per load.
  if (rows.length > 0 && !rows.some(hasDeleteContract)) {
    window.DebugLog?.warn?.('[orders] GET /api/admin/orders returned no deletable/delete_method fields — '
      + 'falling back to the legacy cancelled-only rule. The hard purge is unreachable until the backend sends them.');
  }
  // "No orders found" is true but unhelpful when a search is active, and actively
  // misleading for an email query: email is NOT searchable on this endpoint
  // (measured — see npm run probe:orders-search), so an address always returns
  // zero and a bare "no orders found" would read as "this customer has no orders".
  // Name the query, and name the reason when we know it.
  _table.config.emptyMessage = _search
    ? (looksLikeEmail(_search)
      ? `No match for "${_search}" — orders can't be searched by email address`
      : `No orders match "${_search}"`)
    : 'No orders found';
  _table.setData(rows, pagination);
  // Deliberately NOT awaited: the table must paint from the list payload alone,
  // and the per-row cost fetches fill the Profit column in behind it (ERR-121).
  hydrateProfits(rows);
  // Same rule, and two batched lookups for the whole page rather than per row.
  hydrateInvoiceSent(rows);
  // No hydration twin — the tracking answer is already on these rows. All this
  // does is complain, loudly and by name, if the field is not there at all.
  noteTrackingRegime(rows);
}

// ---- Bulk bar ----

function updateBulkBar(selected) {
  const count = selected.size;
  if (count === 0) {
    if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
    return;
  }
  if (!_bulkBar) {
    _bulkBar = document.createElement('div');
    _bulkBar.className = 'admin-bulk-bar';
    document.body.appendChild(_bulkBar);
  }
  // Every row stays selectable — a checkbox that silently refuses to tick is a
  // worse answer than a bar that says why. The loudness lives here instead: the
  // counts are broken out by DOOR, the button names the door it will open, and
  // the tooltip rolls the blocked orders up by reason. Blocked ids are still
  // never sent (ERR-120).
  const groups = groupSelection(selected);
  const nothingDeletable = groups.actionable === 0;
  const summary = blockedSummary(groups.blocked);

  // The method must be visible BEFORE the click. A button that just says
  // "Delete" and fires an irreversible hard purge is the UX version of the very
  // bug this surface exists to fix.
  const actionLabel = deleteActionLabel(groups);
  const isPurging = groups.purge.length > 0;

  const parts = [`${count} selected`];
  if (groups.purge.length) parts.push(`${groups.purge.length} purge`);
  if (groups.delete.length) parts.push(`${groups.delete.length} delete`);

  const blockedTitle = summary
    .map(s => `${s.count} × ${s.copy}${s.hint ? ` ${s.hint}` : ''}`)
    .join('\n');
  const skipNote = blockedTitle ? `\n\nSkipped:\n${blockedTitle}` : '';
  const actionTitle = nothingDeletable
    ? (blockedTitle || 'Nothing in this selection can be deleted.')
    : (isPurging
      ? `Hard purge — permanent, cascades to line items / invoice links / loyalty / tracking, audit-logged first.${skipNote}`
      : `Delete ${groups.delete.length} cancelled order${groups.delete.length === 1 ? '' : 's'}.${skipNote}`);

  _bulkBar.innerHTML = `
    <span class="admin-bulk-bar__count">${esc(parts.join(' · '))}${
      groups.blocked.length > 0
        ? ` · <span style="color:var(--warning,#b45309)" title="${esc(blockedTitle)}">${groups.blocked.length} blocked</span>`
        : ''
    }</span>
    <div class="admin-bulk-bar__actions">
      <button class="admin-btn admin-btn--sm admin-btn--danger" data-bulk="delete"${
        nothingDeletable || _deleteInFlight ? ' disabled' : ''
      } title="${esc(actionTitle)}">${esc(actionLabel)}</button>
      <button class="admin-btn admin-btn--sm admin-btn--ghost" data-bulk="clear">Clear</button>
    </div>
  `;
  _bulkBar.querySelector('[data-bulk="delete"]').addEventListener('click', bulkDelete);
  _bulkBar.querySelector('[data-bulk="clear"]').addEventListener('click', () => {
    if (_table) _table.clearSelection();
    updateBulkBar(new Set());
  });

  // We do NOT gate on role here — the server owns that rule, and a second copy
  // of it in the frontend is how the two would start disagreeing. But if they
  // ever DO disagree, that is worth seeing here rather than discovering as a 403.
  if (isPurging && typeof AdminAuth?.isOwner === 'function' && !AdminAuth.isOwner()) {
    window.DebugLog?.warn?.('[orders] backend offered delete_method:"purge" to a non-owner session '
      + '— the role gate and the delete contract disagree.');
  }
}

/**
 * The delete confirm dialog.
 *
 * Deliberately NOT Modal.confirm, for three independent reasons:
 *   1. its `message` is escaped TEXT in a single <p> — no list, no per-door
 *      counts, nowhere to put the purge warnings honestly;
 *   2. it calls Modal.close() *after* onConfirm resolves, which is what forced
 *      showDeleteResults behind a timeout in the first place;
 *   3. it SWALLOWS exceptions thrown by onConfirm into a DebugLog line and then
 *      closes — so a 403 from the purge endpoint would shut the dialog with no
 *      message at all.
 *
 * Resolving a boolean and running the work OUTSIDE the callback fixes all three.
 */
function confirmDeletePlan(copy) {
  return new Promise((resolve) => {
    // Confirm-then-close fires onClose immediately after the click handler, so
    // without this the promise would try to settle twice with opposite answers.
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const lines = copy.lines.map(l => `<li>${esc(l)}</li>`).join('');
    const warnings = copy.warnings.map(w => `<li>${esc(w)}</li>`).join('');
    const skips = copy.skips.map(s => `<li>${esc(s)}</li>`).join('');

    const modal = Modal.open({
      title: copy.title,
      body: `
        <ul style="margin:0 0 14px;padding-left:18px;line-height:1.7;font-weight:600">${lines}</ul>
        ${warnings ? `<ul style="margin:0 0 14px;padding-left:18px;color:var(--text-secondary);line-height:1.7">${warnings}</ul>` : ''}
        ${skips ? `<div style="padding:10px 12px;border-radius:6px;background:rgba(180,83,9,.08)">
          <div style="font-weight:600;margin-bottom:6px;color:var(--warning,#b45309)">Skipped</div>
          <ul style="margin:0;padding-left:18px;color:var(--text-secondary);line-height:1.7">${skips}</ul>
        </div>` : ''}
      `,
      footer: `
        <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
        <button class="admin-btn admin-btn--danger" data-action="confirm">${esc(copy.confirmLabel)}</button>
      `,
      // Backdrop click, the close button and Escape all land here. Every one of
      // them means "no" — an unanswered destructive dialog is never a yes.
      onClose: () => finish(false),
    });

    if (!modal) { finish(false); return; }
    modal.footer.querySelector('[data-action="cancel"]')?.addEventListener('click', () => { finish(false); Modal.close(); });
    modal.footer.querySelector('[data-action="confirm"]')?.addEventListener('click', () => { finish(true); Modal.close(); });
  });
}

/**
 * Report the outcome of a delete LOUDLY and per order.
 *
 * Five buckets, five headings, deliberately not collapsible into each other:
 *
 *   deleted       gone, confirmed by the server
 *   failed        the server refused, and told us which code
 *   unknown       we asked and the server never said. NOT a failure and NOT a
 *                 success — folding it into either is the ERR-074 shape (absence
 *                 rendered as a definite answer), and after an irreversible
 *                 purge it is the most dangerous lie on offer
 *   skipped       never sent, because we could not vouch for them
 *   notAttempted  an earlier step failed hard enough that continuing would have
 *                 meant acting on a permission model we had just disproved
 *
 * Every record carries its own `label`, captured BEFORE the list reloaded. The
 * previous version called orderLabel() inside this timeout — i.e. after
 * loadOrders() may already have swapped _table.data out from under it — so a
 * successfully purged order would have printed as a truncated UUID.
 *
 * Still deferred behind a timeout (ERR-120): Modal.close() may be running from
 * the confirm dialog's own click handler, and this stays defence-in-depth for
 * any future caller that opens it from inside a Modal-owned callback.
 */
function showDeleteResults(outcome) {
  const { deleted = [], failed = [], unknown = [], skipped = [], notAttempted = [] } = outcome;

  const section = (heading, colour, items) => {
    if (!items.length) return '';
    const rows = items
      .map(i => `<li><strong>${esc(i.label)}</strong>${i.message ? ` — ${esc(i.message)}` : ''}</li>`)
      .join('');
    return `<div style="margin:0 0 14px">
      <div style="font-weight:600;margin-bottom:6px;color:${colour}">${esc(heading)} (${items.length})</div>
      <ul style="margin:0;padding-left:18px;color:var(--text-secondary);line-height:1.7">${rows}</ul>
    </div>`;
  };

  const problems = failed.length + unknown.length + skipped.length + notAttempted.length;
  const body = [
    section('Deleted', 'var(--success,#15803d)', deleted),
    section('Refused by the server', 'var(--danger,#b91c1c)', failed),
    section('Outcome unknown', 'var(--warning,#b45309)', unknown),
    section('Skipped — never sent', 'var(--warning,#b45309)', skipped),
    section('Not attempted', 'var(--text-muted)', notAttempted),
  ].join('') || '<p style="margin:0;color:var(--text-secondary)">Nothing to report.</p>';

  setTimeout(() => {
    Modal.open({
      title: problems === 0 ? 'Delete finished' : 'Delete finished with problems',
      body,
      footer: `<button class="admin-btn admin-btn--ghost" data-action="dismiss">Close</button>`,
    })?.footer.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => Modal.close());
  }, 320);
}

/**
 * Guards a second click landing while the first delete is still in flight.
 *
 * Under the old cancelled-only door a double-submit was merely noisy. Under the
 * purge door the second pass gets ORDER_NOT_FOUND for ids the first pass already
 * destroyed, and the results modal would then report "3 not deleted" about three
 * orders that were deleted perfectly.
 */
let _deleteInFlight = false;

async function bulkDelete() {
  if (!_table || _deleteInFlight) return;
  const selected = _table.getSelected();
  if (selected.size === 0) return;

  // Blocked ids are never sent — they are reported, by reason (ERR-120).
  const groups = groupSelection(selected);

  // Capture every label UP FRONT. Once loadOrders() has run and the cache is
  // evicted, orderLabel() can no longer resolve an order number for a row that
  // has just been purged out of existence.
  const attempted = [...groups.purge, ...groups.delete];
  const labels = new Map(
    [...attempted, ...groups.blocked.map(b => b.id)].map(id => [id, orderLabel(id)]),
  );
  const label = (id) => labels.get(id) || String(id || '').slice(0, 8) || 'order';
  const skipped = groups.blocked.map(b => ({
    id: b.id,
    label: label(b.id),
    message: b.hint ? `${b.copy} ${b.hint}` : b.copy,
  }));

  if (groups.actionable === 0) {
    // Not a single toast: once the block reasons are mixed, one sentence is
    // wrong for most of the selection. Name every order and every reason.
    Toast.error(`${skipped.length} selected order${skipped.length === 1 ? '' : 's'} cannot be deleted`);
    showDeleteResults({ skipped });
    return;
  }

  const plan = deletePlanCopy(groups);
  if (!(await confirmDeletePlan(plan))) return;

  _deleteInFlight = true;
  updateBulkBar(selected);

  const deleted = [];
  const failed = [];
  const unknown = [];
  const notAttempted = [];

  try {
    Toast.info(`${groups.purge.length ? 'Purging' : 'Deleting'} ${groups.actionable} order${groups.actionable === 1 ? '' : 's'}…`);

    // ---- The purge door first ----
    // The destructive, expensive call goes while the admin is still watching,
    // and a hard refusal here stops us doing the cheap work on a false premise.
    let authRevoked = false;
    if (groups.purge.length > 0) {
      try {
        const res = await AdminAPI.purgeOrders(groups.purge);
        for (const id of res.deleted) {
          deleted.push({ id, label: label(id), method: DELETE_METHOD.PURGE });
        }
        for (const f of res.failed) {
          failed.push({ id: f.id, label: label(f.id), code: f.code, message: purgeFailureCopy(f.code, f.message) });
        }
        for (const id of res.unaccounted) {
          unknown.push({ id, label: label(id), message: UNACCOUNTED_COPY });
        }
      } catch (e) {
        if (e?.code === 'FORBIDDEN' || e?.code === 'UNAUTHORIZED') {
          // Our authority is in doubt. Running the per-id deletes now would mean
          // acting on a permission model the server has just disproved.
          authRevoked = true;
          for (const id of groups.purge) {
            failed.push({ id, label: label(id), code: e.code, message: purgeFailureCopy(e.code, e.message) });
          }
        } else {
          // A timeout does NOT tell us the purge did not happen.
          for (const id of groups.purge) {
            unknown.push({ id, label: label(id), message: `${UNACCOUNTED_COPY} (${e?.message || 'request failed'})` });
          }
        }
      }
    }

    // ---- Then the cancelled-only door, per id ----
    if (groups.delete.length > 0 && authRevoked) {
      for (const id of groups.delete) {
        notAttempted.push({ id, label: label(id), message: 'Skipped after the purge call was refused — sign in again, then retry.' });
      }
    } else {
      for (let i = 0; i < groups.delete.length; i += 5) {
        const batch = groups.delete.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map(id => AdminAPI.deleteOrder(id)));
        results.forEach((r, j) => {
          const id = batch[j];
          if (r.status === 'fulfilled') {
            deleted.push({ id, label: label(id), method: DELETE_METHOD.DELETE });
          } else {
            // Branch on the CODE, never on the prose (ERR-077 / ERR-130).
            failed.push({ id, label: label(id), code: r.reason?.code || null, message: purgeFailureCopy(r.reason?.code, r.reason?.message) });
          }
        });
      }
    }
  } finally {
    _deleteInFlight = false;
  }

  // Everything we touched is evicted, not just the successes: a refusal is newer
  // information than the contract we had cached for that row.
  for (const rec of [...deleted, ...failed, ...unknown]) forgetOrderCache(rec.id);

  if (_table) _table.clearSelection();
  updateBulkBar(new Set());

  const problems = failed.length + unknown.length + skipped.length + notAttempted.length;
  if (problems === 0) {
    const purged = deleted.filter(d => d.method === DELETE_METHOD.PURGE).length;
    const plain = deleted.length - purged;
    const bits = [];
    if (purged) bits.push(`${purged} purged`);
    if (plain) bits.push(`${plain} deleted`);
    Toast.success(bits.join(', ') || 'Nothing deleted');
  } else {
    // An unknown outcome never counts toward the success tally, and it is a
    // warning rather than an error — nothing has been proven to have failed.
    const msg = `${deleted.length} deleted, ${problems} not`;
    if (unknown.length > 0 && failed.length + skipped.length + notAttempted.length === 0) Toast.warning(msg);
    else Toast.error(msg);
    showDeleteResults({ deleted, failed, unknown, skipped, notAttempted });
  }

  loadOrders();
}

// ---- Full-page order modal ----

function closeOrderModal() {
  if (!_activeModal) return;
  const modal = _activeModal;
  _activeModal = null;
  // Drop the shipping panel's state with the DOM it describes. Bumping the token
  // is what makes an in-flight registry or send-history read a no-op instead of a
  // write into a detached node — or, worse, into the next order's panel.
  _shipToken++;
  _shipState = null;
  if (modal._removeKeyHandler) modal._removeKeyHandler();
  modal.classList.remove('open');
  setTimeout(() => modal.remove(), 220);
}

/* ════════════ Shipping Information section (Sep 2026, ERR-200) ════════════
 *
 * Its own section, its own Save, its own "Send to customer" — because shipping
 * details are a fact about the PARCEL, not a status change, and until now the
 * only way to record them was the Update Status modal while flipping an order to
 * `shipped`. That made a typo permanent unless you re-opened a status modal you
 * had no intention of using, and it could not express NZ Couriers at all.
 *
 * All the rules live in utils/shipping-info.js. What lives here is the DOM, and
 * one discipline it must not break: THE PANEL PATCHES, IT NEVER RE-RENDERS. Two
 * async reads land after first paint (the carrier registry, then the send
 * history) and the operator may be mid-keystroke in an input when they do. A
 * field the operator has touched is marked dirty and is never written to again;
 * a pristine field may be corrected in place. Re-rendering the block would
 * destroy the input under the caret (ERR-179).
 */

/**
 * Everything the open modal's shipping panel needs to remember between paints.
 *
 * `_shipState.token` guards the async work: openOrderModal can be called again
 * before a registry fetch resolves, and a late response must not populate a panel
 * belonging to a different order.
 */
let _shipState = null;
let _shipToken = 0;

const SHIP_IDS = {
  root: 'om-shipping',
  // The heading is a SIBLING of the section body, not a child — it is its own
  // flex item in #om-content. Jumping to `root` would scroll straight past the
  // words "Shipping Information", so the jump targets the title.
  title: 'om-ship-title',
  carrier: 'om-ship-carrier',
  number: 'om-ship-number',
  numberLabel: 'om-ship-number-label',
  pcodeGroup: 'om-ship-pcode-group',
  pcode: 'om-ship-pcode',
  url: 'om-ship-url',
  urlHelp: 'om-ship-url-help',
  link: 'om-ship-link',
  issues: 'om-ship-issues',
  markGroup: 'om-ship-mark-group',
  mark: 'om-ship-mark',
  save: 'om-ship-save',
  send: 'om-ship-send',
  sendState: 'om-ship-sendstate',
  registryError: 'om-ship-registry-error',
  live: 'om-ship-live',
};

const shipNode = (id) => document.getElementById(id);

/** Read the four inputs as the shape utils/shipping-info.js expects. */
function shipReadForm() {
  return {
    carrierCode: shipNode(SHIP_IDS.carrier)?.value || '',
    number: shipNode(SHIP_IDS.number)?.value || '',
    productCode: shipNode(SHIP_IDS.pcode)?.value || '',
    url: shipNode(SHIP_IDS.url)?.value || '',
  };
}

/** The registry entry for whatever the dropdown currently shows. */
function shipCurrentCarrier() {
  if (!_shipState?.registry) return null;
  return carrierByCode(shipNode(SHIP_IDS.carrier)?.value, _shipState.registry);
}

/**
 * Write a value into a field the operator has not touched.
 *
 * The `data-dirty` marker is set on the first `input` event and never cleared
 * until a successful save re-baselines the panel. Without it, the send-history
 * fetch resolving 300ms after the modal opens would overwrite a number the
 * operator had already started correcting — which is the failure ERR-179 is
 * about, in a place where the value is a customer's parcel.
 */
function shipPatchPristine(id, value) {
  const el = shipNode(id);
  if (!el || el.dataset.dirty === '1') return;
  const next = value == null ? '' : String(value);
  if (el.value !== next) el.value = next;
}

/** Render inline field problems. Errors block the save; warnings do not. */
function shipRenderIssues(errors = [], warnings = []) {
  const box = shipNode(SHIP_IDS.issues);
  if (!box) return;
  const row = (item, kind) => `<div class="om-ship-issue om-ship-issue--${kind}">${esc(item.message)}</div>`;
  box.innerHTML = [
    ...errors.map(e => row(e, 'error')),
    ...warnings.map(w => row(w, 'warn')),
  ].join('');
  box.hidden = errors.length === 0 && warnings.length === 0;
  for (const id of [SHIP_IDS.carrier, SHIP_IDS.number, SHIP_IDS.pcode, SHIP_IDS.url]) {
    shipNode(id)?.classList.remove('om-ship-input--bad');
  }
  const FIELD_TO_ID = {
    carrier: SHIP_IDS.carrier, number: SHIP_IDS.number,
    productCode: SHIP_IDS.pcode, url: SHIP_IDS.url,
  };
  for (const e of errors) shipNode(FIELD_TO_ID[e.field])?.classList.add('om-ship-input--bad');
}

/**
 * Apply everything that depends on WHICH carrier is selected.
 *
 * Every one of these reads a server-supplied flag. There is no carrier-name
 * branch here and a test greps this file to keep it that way — adding a carrier
 * has to stay a one-file change on the backend.
 */
function shipApplyCarrier() {
  const carrier = shipCurrentCarrier();
  const shipping = _shipState?.shipping || null;

  // "Ticket number" for NZ Couriers, "Tracking number" for everyone else — the
  // word comes off the response, or off the registry when the operator has just
  // changed the dropdown and not saved yet.
  const label = numberLabel(
    // Once the dropdown moves off the stored carrier, the stored label is about a
    // different carrier and must not be reused.
    carrier && shipping && carrier.code === shipping.carrier_code ? shipping : null,
    carrier,
  );
  const labelEl = shipNode(SHIP_IDS.numberLabel);
  if (labelEl) labelEl.textContent = label;
  const numberEl = shipNode(SHIP_IDS.number);
  if (numberEl) numberEl.setAttribute('aria-label', label);

  const needsCode = requiresProductCode(carrier);
  const group = shipNode(SHIP_IDS.pcodeGroup);
  if (group) group.hidden = !needsCode;
  const pcode = shipNode(SHIP_IDS.pcode);
  if (pcode) pcode.required = needsCode;

  // DHL and Other publish no tracking deep link, so the URL box stops being an
  // optional override and becomes the ONLY way this customer gets a link. Say so
  // rather than leaving an operator to discover it from a customer email.
  const help = shipNode(SHIP_IDS.urlHelp);
  const urlEl = shipNode(SHIP_IDS.url);
  if (help) {
    if (carrier && !buildsTrackingUrl(carrier)) {
      help.textContent = `${carrier.name} publishes no tracking link we can build, so this is the only way the customer gets one — paste the link ${carrier.name} gave you.`;
      help.classList.add('om-ship-help--loud');
      urlEl?.classList.add('om-ship-input--wanted');
    } else {
      help.textContent = 'Optional. Overrides the link built from the carrier and number.';
      help.classList.remove('om-ship-help--loud');
      urlEl?.classList.remove('om-ship-input--wanted');
    }
  }

  const live = shipNode(SHIP_IDS.live);
  if (live) {
    // A carrier we cannot poll is a fact worth stating; hiding it silently is how
    // someone waits for scan events that are never coming.
    if (carrier && !supportsLiveTracking(carrier)) {
      live.hidden = false;
      live.textContent = `Live tracking events are not available for ${carrier.name} — only NZ Post-family numbers can be polled. The customer still gets a working track-and-trace link.`;
    } else {
      live.hidden = true;
    }
  }
}

/** The derived link, captioned with where it came from. */
function shipRenderLink() {
  const el = shipNode(SHIP_IDS.link);
  if (!el) return;
  const s = _shipState?.shipping;
  const url = s?.tracking_url ? Security.sanitizeUrl(s.tracking_url) : '';
  if (!url || url === '#') {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const source = s.tracking_url_source;
  const caption = source === 'operator'
    ? 'the link you saved'
    : source === 'carrier_template'
      ? 'built automatically from the carrier and number'
      : 'source not stated';
  el.hidden = false;
  el.innerHTML = `<a href="${Security.escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open the customer's tracking page</a>
    <span class="om-ship-link__src">${esc(caption)}</span>`;
}

/**
 * The send-history line and the state of the Send button.
 *
 * Four different sentences for four different claims — see emailState(). The one
 * that matters is UNLOGGED: `send_count: 0` on a shipped order is NOT zero, it is
 * a log that does not reach back that far, and 4 of the 13 shipped orders live
 * today are exactly that case.
 */
function shipRenderSendState() {
  const line = shipNode(SHIP_IDS.sendState);
  const btn = shipNode(SHIP_IDS.send);
  const s = _shipState?.shipping || null;
  if (!line || !btn) return;

  const state = emailState(s);
  const when = state.lastSentAt ? ` · last sent ${formatDateTime(state.lastSentAt)}` : '';
  line.className = `om-ship-sendstate om-ship-sendstate--${state.state}`;
  line.innerHTML = `<strong>${esc(state.phrase)}</strong>${esc(when)}<span class="om-ship-sendstate__detail">${esc(state.detail)}</span>`;

  const { canSend, reason } = sendability(s);
  btn.disabled = !canSend || !!_shipState?.busy;
  btn.title = canSend ? 'Email the customer their shipping details' : reason;
}

/**
 * The section's HTML. Values are painted immediately from the order-detail
 * payload; the dropdown and the send history arrive afterwards.
 *
 * Note what is NOT prefilled into the URL box: the derived `tracking_url`. Only
 * `tracking_url_override` goes there. Prefilling the derived link would mean the
 * first save of an untouched form freezes today's generated URL into a stored
 * override, and the carrier's template could never correct it again.
 */
function buildShippingSection(o) {
  const { regime, shipping: raw } = readShipping(o);
  // The backend invents a carrier on orders that have none (BF-049) — correct it
  // against the order's own column before anything reads it, so the dropdown and
  // the save baseline agree with the database rather than with the block.
  const shipping = reconcileCarrier(raw, o);
  const form = formFromShipping(shipping);
  const label = numberLabel(shipping, null);
  const isShipped = shipping?.is_shipped === true;

  // No shipping_information key at all — an older payload or a failed detail
  // read. Say which is unknown rather than rendering an empty form that looks
  // like an order with no details (ERR-063/068/073 family).
  const absentNote = regime === SHIPPING_REGIME.ABSENT
    ? `<div class="om-ship-note om-ship-note--warn">This order's payload carried no shipping block, so the fields below start blank. That is not proof the order has no tracking — reload before assuming it.</div>`
    : '';

  return `
    <div class="om-section-title" id="${SHIP_IDS.title}">Shipping Information</div>
    <div class="om-shipping" id="${SHIP_IDS.root}">
      ${absentNote}
      <div class="om-ship-registry-error" id="${SHIP_IDS.registryError}" hidden></div>
      <div class="om-ship-grid">
        <div class="admin-form-group">
          <label for="${SHIP_IDS.carrier}">Carrier</label>
          <select class="admin-select" id="${SHIP_IDS.carrier}" disabled>
            <option value="${Security.escapeAttr(form.carrierCode)}">${esc(shipping?.carrier || 'Loading carriers…')}</option>
          </select>
        </div>
        <div class="admin-form-group">
          <label for="${SHIP_IDS.number}"><span id="${SHIP_IDS.numberLabel}">${esc(label)}</span></label>
          <input class="admin-input" id="${SHIP_IDS.number}" value="${Security.escapeAttr(form.number)}"
                 autocomplete="off" spellcheck="false" placeholder="As printed on the label">
        </div>
        <div class="admin-form-group" id="${SHIP_IDS.pcodeGroup}" hidden>
          <label for="${SHIP_IDS.pcode}">Ticket product code</label>
          <input class="admin-input" id="${SHIP_IDS.pcode}" value="${Security.escapeAttr(form.productCode)}"
                 autocomplete="off" spellcheck="false" maxlength="8" placeholder="e.g. LH">
          <div class="admin-form-help">The 2–4 character code beside the ticket number. Without it the track-and-trace link 404s.</div>
        </div>
        <div class="admin-form-group om-ship-grid__wide">
          <label for="${SHIP_IDS.url}">Tracking URL</label>
          <input class="admin-input" id="${SHIP_IDS.url}" value="${Security.escapeAttr(form.url)}"
                 autocomplete="off" spellcheck="false" placeholder="https://…">
          <div class="admin-form-help" id="${SHIP_IDS.urlHelp}">Optional. Overrides the link built from the carrier and number.</div>
        </div>
      </div>

      <div class="om-ship-issues" id="${SHIP_IDS.issues}" hidden></div>
      <div class="om-ship-link" id="${SHIP_IDS.link}" hidden></div>
      <div class="om-ship-note om-ship-note--muted" id="${SHIP_IDS.live}" hidden></div>

      <div class="om-ship-actions">
        <div class="om-ship-actions__left">
          <label class="om-ship-check" id="${SHIP_IDS.markGroup}"${isShipped ? ' hidden' : ''}>
            <input type="checkbox" id="${SHIP_IDS.mark}">
            <span>Mark the order shipped — <strong>this emails the customer these details</strong>.</span>
          </label>
        </div>
        <div class="om-ship-actions__right">
          <button class="admin-btn admin-btn--ghost admin-btn--sm" id="${SHIP_IDS.send}" disabled
                  title="Loading send history…">${icon('mail', 13, 13)} Send to customer</button>
          <button class="admin-btn admin-btn--primary admin-btn--sm" id="${SHIP_IDS.save}">Save shipping details</button>
        </div>
      </div>
      <div class="om-ship-sendstate" id="${SHIP_IDS.sendState}"></div>
    </div>
  `;
}

/** A deliberate yes/no. Same promise shape as confirmDeletePlan — an unanswered dialog is a no. */
function confirmShipping({ title, lines, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const modal = Modal.open({
      title,
      body: `<ul style="margin:0;padding-left:18px;line-height:1.7">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`,
      footer: `
        <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
        <button class="admin-btn ${danger ? 'admin-btn--danger' : 'admin-btn--primary'}" data-action="confirm">${esc(confirmLabel)}</button>
      `,
      onClose: () => finish(false),
    });
    if (!modal) { finish(false); return; }
    modal.footer.querySelector('[data-action="cancel"]')?.addEventListener('click', () => { finish(false); Modal.close(); });
    modal.footer.querySelector('[data-action="confirm"]')?.addEventListener('click', () => { finish(true); Modal.close(); });
  });
}

/** Fill the carrier dropdown from the registry and select the stored carrier. */
function shipPopulateCarriers() {
  const sel = shipNode(SHIP_IDS.carrier);
  const registry = _shipState?.registry;
  if (!sel || !Array.isArray(registry)) return;
  const stored = carrierOf(_shipState.shipping, registry);
  const wasDirty = sel.dataset.dirty === '1';
  const chosen = wasDirty ? sel.value : (stored?.code || '');
  sel.innerHTML = [
    `<option value="">No carrier recorded</option>`,
    ...registry.map(c => `<option value="${Security.escapeAttr(c.code)}">${esc(c.name)}</option>`),
  ].join('');
  sel.value = chosen;
  // A stored carrier the registry has never heard of must not silently become
  // "No carrier recorded" — that would look like a cleared field and save as one.
  if (!sel.value && _shipState.shipping?.carrier) {
    const raw = _shipState.shipping.carrier;
    sel.insertAdjacentHTML('afterbegin', `<option value="">${esc(raw)} (not in the carrier list)</option>`);
    sel.value = '';
  }
  sel.disabled = false;
  shipApplyCarrier();
}

/** Re-baseline the panel from a fresh server block, and clear the dirty marks. */
function shipAdoptShipping(rawShipping, { rebaseline = false } = {}) {
  if (!rawShipping || !_shipState) return;
  // /shipping responses and PUT echoes carry no order row, so the correction is
  // re-applied from the column we captured when the modal opened.
  const shipping = _shipState.rowCarrier === undefined
    ? rawShipping
    : reconcileCarrier(rawShipping, { carrier: _shipState.rowCarrier });
  _shipState.shipping = shipping;
  if (rebaseline) {
    for (const id of [SHIP_IDS.carrier, SHIP_IDS.number, SHIP_IDS.pcode, SHIP_IDS.url]) {
      const el = shipNode(id);
      if (el) delete el.dataset.dirty;
    }
    const form = formFromShipping(shipping);
    shipPatchPristine(SHIP_IDS.number, form.number);
    shipPatchPristine(SHIP_IDS.pcode, form.productCode);
    shipPatchPristine(SHIP_IDS.url, form.url);
    const sel = shipNode(SHIP_IDS.carrier);
    if (sel && _shipState.registry) sel.value = carrierOf(shipping, _shipState.registry)?.code || '';
  }
  const markGroup = shipNode(SHIP_IDS.markGroup);
  if (markGroup) markGroup.hidden = shipping.is_shipped === true;
  const mark = shipNode(SHIP_IDS.mark);
  if (mark && shipping.is_shipped === true) mark.checked = false;
  shipApplyCarrier();
  shipRenderLink();
  shipRenderSendState();
}

function shipSetBusy(busy) {
  if (_shipState) _shipState.busy = busy;
  const save = shipNode(SHIP_IDS.save);
  const send = shipNode(SHIP_IDS.send);
  if (save) save.disabled = busy;
  if (send) send.disabled = busy || !sendability(_shipState?.shipping).canSend;
}

/**
 * After a save that sent a carrier, the order's own column now holds it — so the
 * BF-049 correction must stop firing, or we would blank the carrier the operator
 * just chose on the very next read.
 */
function shipRememberSavedCarrier(payload, shipping) {
  if (!_shipState) return;
  if (!Object.prototype.hasOwnProperty.call(payload || {}, 'carrier')) return;
  _shipState.rowCarrier = payload.carrier === '' ? null : (shipping?.carrier ?? payload.carrier);
}

/**
 * Save. Everything the backend would refuse is refused here first, so the
 * operator meets the problem on the field rather than as a toast after a trip.
 */
async function shipSave() {
  if (!_shipState || _shipState.busy) return;
  const save = shipNode(SHIP_IDS.save);
  const form = shipReadForm();
  const carrier = shipCurrentCarrier();
  const markShipped = !!shipNode(SHIP_IDS.mark)?.checked;

  const { ok, errors, warnings } = validateShipping(form, carrier, { markShipped });
  shipRenderIssues(errors, warnings);
  if (!ok) {
    const FIELD_TO_ID = { carrier: SHIP_IDS.carrier, number: SHIP_IDS.number, productCode: SHIP_IDS.pcode, url: SHIP_IDS.url };
    shipNode(FIELD_TO_ID[errors[0].field])?.focus();
    return;
  }

  const payload = buildPayload(_shipState.shipping, form, { markShipped });
  if (!hasChanges(payload)) {
    Toast.info('Nothing changed — the shipping details are already saved as shown.');
    return;
  }

  // mark_shipped emails the customer even without send_email (`auto_on_ship`).
  // An operator who ticked a box labelled "mark shipped" has to be told that the
  // customer is about to receive an email, before it goes.
  if (markShipped) {
    const state = emailState(_shipState.shipping);
    const lines = [
      'This flips the order to shipped and emails the customer their tracking details straight away.',
      changedFieldCount(payload)
        ? 'Your edits to the shipping details are saved in the same step.'
        : 'No shipping details were changed — only the status.',
    ];
    if (state.state === EMAIL_STATE.RECORDED) lines.push(`They have had ${state.phrase} already; this would be another.`);
    if (state.state === EMAIL_STATE.UNLOGGED) lines.push('This order shipped before sends were logged, so they may already have had these details.');
    if (!(await confirmShipping({ title: 'Mark shipped and email the customer?', lines, confirmLabel: 'Mark shipped & email' }))) return;
  }

  const original = save ? save.textContent : '';
  shipSetBusy(true);
  if (save) save.textContent = 'Saving…';
  try {
    const data = await AdminAPI.updateOrderShipping(_shipState.orderId, payload);
    const { shipping } = readShipping(data);
    shipRememberSavedCarrier(payload, shipping);
    if (shipping) shipAdoptShipping(shipping, { rebaseline: true });
    shipRenderIssues([], []);
    forgetOrderCache(_shipState.orderId);

    const emailNote = describeEmailOutcome(data?.email);
    Toast.success(`Shipping details saved.${data?.status_changed ? ' The order is now shipped.' : ''}`);
    if (emailNote) Toast.info(emailNote);

    // The send history is not on the PUT echo; refetch so the panel does not go
    // on claiming a stale count after a save that emailed someone.
    shipRefreshHistory();
    loadOrders();
    refreshTrackingCount();
  } catch (e) {
    await shipHandleWriteFailure(e, { markShipped, form });
  } finally {
    shipSetBusy(false);
    if (save) save.textContent = original || 'Save shipping details';
  }
}

/**
 * One place for the failures both writes share.
 *
 * A 409 is NOT a bad request — someone else moved the order while this operator
 * was typing. The typed values are kept and only the server's view is refreshed;
 * throwing the form away would lose the correction that prompted the edit.
 */
async function shipHandleWriteFailure(e, { markShipped = false } = {}) {
  if (isConcurrencyConflict(e)) {
    Toast.warning(shippingErrorMessage({ code: 'CONFLICT' }));
    await shipRefreshHistory({ rebaseline: false });
    return;
  }

  // Not really an error: the backend is asking a question this panel can answer.
  if (isNotShippedRefusal(e) && !markShipped) {
    const yes = await confirmShipping({
      title: 'Mark the order shipped and send?',
      lines: [
        'The shipping email says "your order has shipped", and the customer’s own order page hides tracking until the status flips — sending now would point them at a blank page.',
        'Marking it shipped first fixes that, and emails them these details.',
      ],
      confirmLabel: 'Mark shipped & send',
    });
    if (!yes) return;
    try {
      const form = shipReadForm();
      const payload = buildPayload(_shipState.shipping, form, { markShipped: true, sendEmail: true });
      const data = await AdminAPI.updateOrderShipping(_shipState.orderId, payload);
      const { shipping } = readShipping(data);
      shipRememberSavedCarrier(payload, shipping);
      if (shipping) shipAdoptShipping(shipping, { rebaseline: true });
      forgetOrderCache(_shipState.orderId);
      Toast.success('The order is marked shipped and the customer has been emailed.');
      shipRefreshHistory();
      loadOrders();
      refreshTrackingCount();
    } catch (e2) {
      Toast.error(shippingErrorMessage(e2));
    }
    return;
  }

  const message = shippingErrorMessage(e);
  // A field-level refusal belongs ON the field, not only in a toast that vanishes.
  // fieldIssuesFromError reads details[] as well as the documented codes, because
  // a bad tracking_url really comes back as VALIDATION_FAILED with
  // details[0].field — see the note on that function.
  const issues = fieldIssuesFromError(e);
  if (issues.length) {
    shipRenderIssues(issues, []);
    const FIELD_TO_ID = { carrier: SHIP_IDS.carrier, number: SHIP_IDS.number, productCode: SHIP_IDS.pcode, url: SHIP_IDS.url };
    shipNode(FIELD_TO_ID[issues[0].field])?.focus();
  }
  Toast.error(message);
}

/** Send the shipping email on demand. Always a deliberate act when one may already have gone. */
async function shipSend() {
  if (!_shipState || _shipState.busy) return;
  const { canSend, reason } = sendability(_shipState.shipping);
  if (!canSend) { Toast.warning(reason); return; }

  const state = emailState(_shipState.shipping);
  if (state.warnBeforeSend) {
    const lines = [`${state.phrase}${state.lastSentAt ? ` — last sent ${formatDateTime(state.lastSentAt)}` : ''}.`, state.detail];
    if (changedFieldCount(buildPayload(_shipState.shipping, shipReadForm())) > 0) {
      lines.push('You have unsaved edits above. This sends what is SAVED on the order, not what is typed — save first if the customer should get the new details.');
    }
    if (!(await confirmShipping({ title: 'Email the customer their shipping details?', lines, confirmLabel: 'Send email' }))) return;
  }

  const send = shipNode(SHIP_IDS.send);
  const original = send ? send.innerHTML : '';
  shipSetBusy(true);
  if (send) send.textContent = 'Sending…';
  try {
    const data = await AdminAPI.sendShippingEmail(_shipState.orderId);
    const { shipping } = readShipping(data);
    if (shipping) shipAdoptShipping(shipping);
    const note = describeEmailOutcome(data?.email);
    if (data?.email?.sent === false) {
      Toast.warning(note || 'The email was not sent.');
    } else {
      Toast.success(note || 'The customer has been emailed their shipping details.');
      // A SEND CAN CLEAR A TRACKING REQUEST, so this path now has to refresh the
      // list — it never did before, because nothing on the row used to change.
      // The row is re-read from the backend rather than patched from here: the
      // backend decides whether the request was fulfilled (it gates that on the
      // send returning true), and a frontend that assumed the transition would be
      // asserting an outcome it did not witness.
      forgetOrderCache(_shipState.orderId);
      loadOrders();
      refreshTrackingCount();
    }
    shipRefreshHistory();
  } catch (e) {
    await shipHandleWriteFailure(e);
  } finally {
    shipSetBusy(false);
    if (send) send.innerHTML = original;
  }
}

/**
 * Fetch the block that knows about sends.
 *
 * The order-detail payload carries `shipping_information` with `email: null` — it
 * skips the extra query, which is NOT the same as "never emailed". Verified live:
 * order 20260829000001 reads `email: null` here and `send_count: 1` there. So the
 * panel opens honest ("Send history not loaded") and upgrades.
 */
async function shipRefreshHistory({ rebaseline = false } = {}) {
  if (!_shipState) return;
  const token = _shipState.token;
  try {
    const data = await AdminAPI.getOrderShipping(_shipState.orderId);
    if (!_shipState || _shipState.token !== token) return;   // a different order is open now
    const { shipping } = readShipping(data);
    if (shipping) shipAdoptShipping(shipping, { rebaseline });
  } catch (e) {
    if (!_shipState || _shipState.token !== token) return;
    // Leave the UNKNOWN wording standing — it is already the honest one — but say
    // out loud that we tried and failed, rather than letting it read as a slow load.
    const line = shipNode(SHIP_IDS.sendState);
    if (line) {
      line.className = 'om-ship-sendstate om-ship-sendstate--unknown';
      line.innerHTML = `<strong>Couldn’t read the send history</strong><span class="om-ship-sendstate__detail">${esc(shippingErrorMessage(e))} This is a read error, not proof the customer was never emailed.</span>`;
    }
  }
}

/**
 * Jump the operator to the Shipping Information section.
 *
 * The section renders after the Dates block, which on a tall order puts it below
 * the fold — so it was invisible unless you knew to scroll. Every other primary
 * action on this modal has a header button; this is shipping's.
 *
 * Three details that are not obvious:
 *   - The scroll target is the section's TITLE. `.om-section-title` is a sibling
 *     of `.om-shipping`, so scrolling to the body lands below the heading.
 *   - Focus is applied with `preventScroll` so it does not fight the smooth
 *     scroll it was just given (the same pairing pages/invoices.js uses).
 *   - Focusing a field must NOT mark it dirty. `data-dirty` is set on `input` and
 *     `change` only, so pressing this button still lets a late send-history read
 *     correct a field the operator has not actually typed in (ERR-179 family).
 */
function focusShippingSection() {
  const title = shipNode(SHIP_IDS.title);
  const body = shipNode(SHIP_IDS.root);
  (title || body)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (body) {
    // Restart the animation on a second press: without removing the class first
    // the browser sees no change and nothing happens.
    body.classList.remove('om-shipping--flash');
    void body.offsetWidth;
    body.classList.add('om-shipping--flash');
    const clear = () => body.classList.remove('om-shipping--flash');
    body.addEventListener('animationend', clear, { once: true });
    // Fallback: under prefers-reduced-motion there is no animation, so
    // `animationend` never fires and the cue would stay on screen for good.
    setTimeout(clear, 2000);
  }

  // The field worth typing in first: the carrier when none is recorded yet,
  // otherwise the number.
  const carrier = shipNode(SHIP_IDS.carrier);
  const target = carrier && !carrier.value ? carrier : shipNode(SHIP_IDS.number);
  target?.focus({ preventScroll: true });
}

/** Wire the section. Called once per modal open, after the HTML is in the DOM. */
function bindShippingSection(o) {
  const root = shipNode(SHIP_IDS.root);
  if (!root) return;

  const { shipping: raw } = readShipping(o);
  _shipState = {
    orderId: o.id,
    // `orders.carrier` is the column that actually records a carrier; the shipping
    // block defaults it (BF-049). Kept so the /shipping read and every PUT echo —
    // none of which carry the row — can be corrected the same way. `undefined`
    // means the payload had no such key and we must not correct anything.
    rowCarrier: Object.prototype.hasOwnProperty.call(o, 'carrier') ? o.carrier : undefined,
    shipping: reconcileCarrier(raw, o) || null,
    registry: null,
    busy: false,
    token: ++_shipToken,
  };
  if (carrierWasDefaulted(_shipState.shipping)) {
    DebugLog.warn('[shipping] the backend reported a carrier for an order whose carrier column is null; ' +
      'showing "No carrier recorded" instead (BF-049). Order:', o.order_number || o.id);
  }

  for (const id of [SHIP_IDS.number, SHIP_IDS.pcode, SHIP_IDS.url, SHIP_IDS.carrier]) {
    const el = shipNode(id);
    if (!el) continue;
    // One marker, set on the first keystroke: from here on the async reads leave
    // this field alone. See shipPatchPristine().
    el.addEventListener('input', () => { el.dataset.dirty = '1'; });
    el.addEventListener('change', () => { el.dataset.dirty = '1'; });
  }
  shipNode(SHIP_IDS.carrier)?.addEventListener('change', () => {
    shipApplyCarrier();
    // Re-validate as they go, so a required product code appears as a prompt
    // rather than as a refusal after they press Save.
    const { errors, warnings } = validateShipping(shipReadForm(), shipCurrentCarrier(), {});
    shipRenderIssues(errors.filter(e => e.code !== 'UNKNOWN_CARRIER'), warnings);
  });
  shipNode(SHIP_IDS.number)?.addEventListener('blur', () => {
    const { warnings } = validateShipping(shipReadForm(), shipCurrentCarrier(), {});
    shipRenderIssues([], warnings);
  });
  shipNode(SHIP_IDS.save)?.addEventListener('click', shipSave);
  shipNode(SHIP_IDS.send)?.addEventListener('click', shipSend);

  shipRenderLink();
  shipRenderSendState();

  const token = _shipState.token;
  AdminAPI.getShippingCarriers()
    .then((registry) => {
      if (!_shipState || _shipState.token !== token) return;
      _shipState.registry = registry;
      shipPopulateCarriers();
    })
    .catch((e) => {
      if (!_shipState || _shipState.token !== token) return;
      // No guessed list. A carrier dropdown built from memory would be missing the
      // one carrier this whole section exists for, and an operator cannot tell a
      // guess from the truth.
      const box = shipNode(SHIP_IDS.registryError);
      if (box) {
        box.hidden = false;
        box.innerHTML = `<strong>Couldn’t load the carrier list.</strong> ${esc(shippingErrorMessage(e))}
          The dropdown is left as it is rather than guessing — the stored carrier is still shown above.
          <button class="admin-btn admin-btn--text admin-btn--xs" data-action="ship-retry-registry">Try again</button>`;
        box.querySelector('[data-action="ship-retry-registry"]')?.addEventListener('click', () => {
          box.hidden = true;
          bindShippingSection(o);
        });
      }
    });

  shipRefreshHistory();
}

async function openOrderModal(order) {
  if (_activeModal) closeOrderModal();

  const modal = document.createElement('div');
  modal.className = 'admin-product-modal';
  modal.innerHTML = `
    <div class="admin-product-modal__inner">
      <div class="admin-product-modal__header">
        <button class="admin-product-modal__close" data-action="close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <div class="admin-product-modal__title">${esc(window.OrderNumber.forDisplay(order.order_number) || order.id?.slice(0, 8) || 'Order')}</div>
        <div class="admin-product-modal__actions" id="om-header-actions">
          ${statusBadge(order.status)}
        </div>
      </div>
      <div class="admin-product-modal__scroll" id="om-content">
        <div style="padding:40px;text-align:center;color:var(--text-muted)">Loading order&hellip;</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  _activeModal = modal;

  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));

  modal.querySelector('[data-action="close"]').addEventListener('click', closeOrderModal);

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && _activeModal === modal) {
      closeOrderModal();
      document.removeEventListener('keydown', onKeyDown);
    }
  };
  document.addEventListener('keydown', onKeyDown);
  modal._removeKeyHandler = () => document.removeEventListener('keydown', onKeyDown);

  // Can this order's send state be answered from the row we already have?
  //
  // Decided BEFORE the fetch, and from the LIST row, because the list row is the
  // one the backend ships `invoice_sent` on — the detail endpoint does not
  // carry it (measured against live production, 2026-09-01). When the row answers
  // for itself the invoice lookup below is not issued at all: a request whose
  // answer we would discard can only fail in ways that mislead.
  const directSent = sentInfoWithoutLookup(order, orderSendRegime([order]));

  // Fetch full data
  const [fullOrder, events, breakdown, invoiceLookup] = await Promise.all([
    AdminAPI.getOrder(order.id),
    AdminAPI.getOrderEvents(order.id),
    AdminAPI.getOrderBreakdown(order.id),
    // The order payload carries no send date of its own — it lives on the
    // order-derived invoice row (public.invoices.emailed_at). Skipped entirely
    // when the row already answered.
    directSent ? Promise.resolve(null) : AdminAPI.getOrderInvoicesByOrderIds([order.id]),
  ]);
  if (_activeModal !== modal) return; // closed during fetch

  const o = fullOrder || order;
  // getOrder returned null (fetch failed / backend hiccup) — we fell back to the
  // thinner list row. Flag it so the items section can be LOUD about the degraded
  // load rather than rendering a clean-looking empty state (fail-soft must be loud).
  const detailLoadFailed = !fullOrder;
  if (detailLoadFailed) Toast.error('Order detail failed to load — showing summary only');

  // Deletability is resolved across BOTH payloads, not off `o`.
  //
  // The backend only promises `deletable` / `delete_method` /
  // `delete_blocked_reason` on the LIST endpoint. `GET /api/admin/orders/:id`
  // may not echo them — and gating on the detail payload alone would then take
  // the legacy cancelled-only path, so an owner opening a paid order would find
  // NO delete button at all: the whole feature gone, with no error anywhere.
  // resolveDeleteRight picks whichever candidate actually carries the contract.
  const deleteRight = resolveDeleteRight(fullOrder, lookupOrder(order.id), order);

  // Update header title (actions + badge will be set by buildOrderModalContent)
  modal.querySelector('.admin-product-modal__title').textContent = window.OrderNumber.forDisplay(o.order_number) || o.id?.slice(0, 8) || 'Order';

  // Build single-page content
  // Resolved once, here, and handed down — so the Dates row, the button hint and
  // the list cell behind the modal cannot disagree about the same order.
  const sentInfo = directSent || resolveSentInfo({
    invoice: invoiceLookup?.byOrderId?.get(String(order.id)) || null,
    // The whole list, not newestSendEvent(): the Dates row shows a count and
    // opens the same history panel the list column does.
    events: Array.isArray(events) ? events : [],
    invoiceFailed: !!invoiceLookup?.failed,
    // getOrderEvents returns null on failure. Without this, a failed history load
    // would render "Not recorded" — asserting an absence we never established.
    eventFailed: events === null,
    // We only reach here for a row the channel rule said DOES apply.
    applicable: true,
  });
  if (sentInfo.state !== SENT_STATE.FAILED) _sentCache.set(order.id, sentInfo);
  patchSentCell(order, sentInfo);

  // The tracking answer, read from whichever payload actually carries the field.
  //
  // The two endpoints do not agree about their own contract: measured live on
  // 2026-09-03, `GET /orders/:id` carries `tracking_request` and does NOT carry
  // `invoice_sent`, which is the exact reverse of the assumption the block above
  // is built on. So this takes candidates in preference order — freshest first,
  // the list row last — the same ladder resolveDeleteRight() walks a few lines
  // up, and for the same reason: an absent contract is a reason to look at the
  // next payload, never a reason to answer from one that never had it.
  const trackInfo = resolveTrackingInfo({
    tr: readTrackingRequestFrom(fullOrder, lookupOrder(order.id), order),
    orderStatus: o.status,
  });

  // `events` is passed THROUGH, null and all — see the timeline's null branch.
  // `events || []` here is what made a failed history look like an empty one.
  buildOrderModalContent(modal, o, events, breakdown, { detailLoadFailed, deleteRight, sentInfo, trackInfo });
}

function buildOrderModalContent(modal, o, events, breakdown, { detailLoadFailed = false, deleteRight = null, sentInfo = null, trackInfo = null } = {}) {
  // Never fall back to a status rule here. An absent right is an UNRESOLVED
  // right, and unresolved fails closed with a reason of its own.
  const right = deleteRight || orderDeleteRight(o);
  const showCost = AdminAuth.isOwner();
  const omRow = (label, value) =>
    `<div class="om-meta-row"><span>${label}</span><span>${value}</span></div>`;

  const profile = o.user_profile || o.user_profiles || o.customer || {};
  const custName = o.customer_name || profile.full_name
    || [profile.first_name, profile.last_name].filter(Boolean).join(' ')
    || MISSING;
  const custEmail = o.customer_email || profile.email || o.guest_email || MISSING;
  const orderTotal = o.total_amount ?? o.total;

  // Meta grid
  let metaLeft = omRow('Customer', esc(custName));
  metaLeft += omRow('Email', esc(custEmail));
  if (orderTotal != null) metaLeft += omRow(`Total${gstSub(GST_INCL)}`, `<strong>${formatPrice(orderTotal)}</strong>`);
  // shipping_rates stores fees GST-INCLUSIVE (GST inside = fee × 3/23), so this
  // row is incl. GST like the Total above it — it was the one unlabelled money
  // row in this block.
  if (o.shipping_fee != null) metaLeft += omRow(`Shipping${gstSub(GST_INCL)}`, formatPrice(o.shipping_fee));
  if (o.shipping_tier) metaLeft += omRow('Tier', esc(o.shipping_tier));
  if (o.delivery_zone) metaLeft += omRow('Zone', esc(o.delivery_zone));
  if (o.source) metaLeft += omRow('Source', esc(o.source));

  // Order dates. For owners these drop to their own section lower down and the
  // Profit Breakdown takes this top-right meta slot; non-owners keep dates here.
  let datesRows = omRow('Created', formatDate(o.created_at));
  if (o.paid_at) datesRows += omRow('Paid', formatDate(o.paid_at));
  if (o.shipped_at) datesRows += omRow('Shipped', formatDate(o.shipped_at));
  if (o.delivered_at) datesRows += omRow('Delivered', formatDate(o.delivered_at));
  if (o.completed_at) datesRows += omRow('Completed', formatDate(o.completed_at));
  if (o.cancelled_at) datesRows += omRow('Cancelled', formatDate(o.cancelled_at));
  // Always rendered, including when nothing is on record — an absent row would
  // read as "this order has no invoice", which is a different claim entirely.
  datesRows += `<div class="om-meta-row"><span>Invoice sent</span>`
    + `<span data-om-sent>${modalSentValue(sentInfo)}</span></div>`;
  // Same rule as the row above: always rendered. This is also the row an
  // operator arriving from the Tracking Requests page came here to read, so it
  // must be present on the order they were sent to even when the answer is no.
  datesRows += `<div class="om-meta-row"><span>Tracking request</span>`
    + `<span data-om-track>${modalTrackingValue(trackInfo)}</span></div>`;

  // Shipping address — shown inline as middle meta column
  const addr = o.shipping_address || {};
  const hasAddr = addr.address_line1 || o.shipping_address_line1;
  let metaMiddle = '';
  if (hasAddr) {
    const name = addr.recipient_name || o.shipping_recipient_name || '';
    const phone = addr.phone || o.shipping_phone || '';
    const line1 = addr.address_line1 || o.shipping_address_line1 || '';
    const line2 = addr.address_line2 || o.shipping_address_line2 || '';
    const city = addr.city || o.shipping_city || '';
    const region = addr.region || o.shipping_region || '';
    const postal = addr.postal_code || o.shipping_postal_code || '';
    const country = addr.country || o.shipping_country || 'New Zealand';
    const parts = [name, phone, line1, line2,
      city && region ? `${city}, ${region} ${postal}`.trim() : (city || region),
      country,
    ].filter(Boolean).map(p => esc(p)).join('<br>');
    metaMiddle = `<div class="om-meta-addr-label">Ship to</div><address style="font-style:normal;line-height:1.7;font-size:0.9rem">${parts}</address>`;
  }

  // metaSection is assembled after the items section (below) — the top-right
  // column shows the owner-only Profit Breakdown, which needs the order totals.

  // Every profit figure in this modal comes from ONE call, shared with the Orders
  // list's Profit column, so the two can never quote different numbers (ERR-113).
  // The breakdown endpoint's total is the more precise card-fee base, so pass it;
  // the helper falls back to the order's own total when it's absent.
  const profitInfo = orderProfitFromDetail(o, { customerPaidInclGst: breakdown?.total_incl_gst });

  // Items section
  let itemsHtml = '';
  let orderProfitBreakdown = null;  // populated below; consumed by the Profit Breakdown section
  let profitFootTip = '';           // fee wording differs for an invoiced (bank-transfer) sale
  if (o.items?.length) {
    itemsHtml += `<div class="admin-order-items-scroll"><table class="admin-order-items"><thead><tr>`;
    itemsHtml += `<th>Product</th><th>SKU</th><th>Qty</th><th>Supplier</th><th>Origin</th><th>Price${gstSub(GST_EXCL)}</th>`;
    if (showCost) itemsHtml += `<th>Cost${gstSub(GST_EXCL)}</th><th>Profit${gstSub(GST_NET)}</th>`;
    itemsHtml += `</tr></thead><tbody>`;
    const { lineProfits, missingCostCount, itemCount } = profitInfo;
    const itemRows = [];
    for (const item of o.items) {
      const itemPrice = item.sell_price ?? item.unit_price ?? item.price;
      // Prefer backend-supplied canonical_url; fall back to slug/sku reconstruction.
      let itemHref = '';
      if (item.canonical_url) {
        try { itemHref = new URL(item.canonical_url).pathname; }
        catch (_) { itemHref = item.canonical_url; }
      } else if (item.slug && item.sku) {
        itemHref = `/products/${encodeURIComponent(item.slug)}/${encodeURIComponent(item.sku)}`;
      } else if (item.sku) {
        itemHref = `/p/${encodeURIComponent(item.sku)}`;
      }
      itemRows.push({ item, itemPrice, itemHref });
    }
    // Itemised order-level waterfall (revenue → every deduction → net profit). Null
    // unless every line carries a cost — see the foot-total note below.
    if (showCost) orderProfitBreakdown = profitInfo.breakdown;
    profitFootTip = profitInfo.isInvoice
      ? 'Net profit (GST-neutral): ex-GST revenue minus ex-GST supplier cost. This is an invoiced sale paid by bank transfer, so there is no card fee. GST is a pass-through — see the Profit Breakdown section.'
      : 'Net profit (GST-neutral): ex-GST revenue minus ex-GST supplier cost minus Stripe fee (2.65% + $0.30) on the full charged amount. GST is a pass-through — see the Profit Breakdown section.';
    // Free-shipping order where we absorbed the courier: that cost is allocated
    // across the lines (by revenue share) too, so say so in the foot tooltip.
    if (profitInfo.absorbedApplies) {
      profitFootTip += ' Absorbed courier cost (free shipping) is subtracted — see the Profit Breakdown.';
    }
    // The per-line Profit figures carry their revenue share of the order discount,
    // so a line's profit is lower than (its price − its cost − its fee share) would
    // suggest. Say so, or the column looks wrong against the Price column beside it.
    if (profitInfo.discountApplies) {
      profitFootTip += ` The ${formatPrice(profitInfo.orderDiscountExGst)} order discount (ex-GST) is`
        + ' apportioned across the lines by revenue share, so each line carries its part of it.';
    }
    // A line with no recorded supplier cost makes the ORDER total unknowable — its
    // cost would otherwise count as $0 and the foot would print a confident,
    // over-stated profit (ERR-122; the ERR-028/068 class). The per-line figures
    // above stay valid: each is its own revenue minus its own cost minus its
    // revenue share of the order fee, which doesn't depend on the missing line.
    // UNKNOWN has TWO causes and they must not share one sentence. The missing-cost
    // case is the common one; the other is a revenue figure the math refuses (zero,
    // or an order discount at/above the whole line sum). Printing "0 of 2 items have
    // no recorded supplier cost" for the second is a straight falsehood, and it was
    // reachable before the discount work too — see order-profit.js's !breakdown branch.
    const unknownFootTip = missingCostCount > 0
      ? `${missingCostCount} of ${itemCount} item${itemCount === 1 ? '' : 's'} `
        + `${missingCostCount === 1 ? 'has' : 'have'} no recorded supplier cost — this order's total profit can't be computed. `
        + `It is UNKNOWN, not $0.`
      : profitInfo.discountExceedsRevenue
        ? `The recorded order discount (${formatPrice(profitInfo.orderDiscountInclGst)} incl-GST) is at or above `
          + `this order's entire line total, so realised revenue can't be stated and neither can profit. `
          + `It is UNKNOWN, not $0 — check the discount on the order row.`
        : `This order's revenue can't be stated, so profit can't be computed. It is UNKNOWN, not $0.`;
    itemRows.forEach(({ item, itemPrice, itemHref }, idx) => {
      const profitCell = showCost
        ? `<td class="mono" style="color:var(--success-text,#15803d)">${lineProfits[idx] != null ? formatPrice(lineProfits[idx]) : MISSING}</td>`
        : '';
      itemsHtml += `<tr>
        <td class="cell-truncate">${item.sku && itemHref ? `<a href="${esc(itemHref)}" target="_blank" style="color:var(--text);text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px">${esc(item.product_name || item.name || item.description || MISSING)}</a>` : esc(item.product_name || item.name || item.description || MISSING)}</td>
        <td class="mono">${esc(item.sku || MISSING)}</td>
        <td>${item.qty ?? item.quantity ?? MISSING}</td>
        <td class="admin-order-items__supplier">${supplierCell(item)}</td>
        <td>${originBadge(item.origin)}</td>
        <td class="mono">${itemPrice != null ? formatPrice(itemPrice) : MISSING}</td>
        ${showCost ? `<td class="mono">${item.supplier_cost_snapshot != null ? formatPrice(item.supplier_cost_snapshot) : MISSING}</td>${profitCell}` : ''}
      </tr>`;
    });
    const costFoot = missingCostCount > 0
      ? `<td class="mono admin-text-muted" title="${esc(unknownFootTip)}"><strong>${MISSING}</strong></td>`
      : `<td class="mono"><strong>${formatPrice(profitInfo.totalCostExGst)}</strong></td>`;
    const profitFoot = profitInfo.netProfit != null
      ? `<td class="mono" style="color:var(--success-text,#15803d)" title="${esc(profitFootTip)}"><strong>${formatPrice(profitInfo.netProfit)}</strong></td>`
      : `<td class="mono admin-text-muted" title="${esc(unknownFootTip)}"><strong>${MISSING}</strong></td>`;
    // The Price foot is REALISED revenue — net of the order discount (ERR-168).
    // Without these two rows it no longer relates to the unit prices above it and
    // reads like an arithmetic error. Shown to every admin, not just owners: a
    // discount is customer money, not cost, so it is not behind showCost.
    let discountFootRows = '';
    if (profitInfo.discountApplies) {
      const blankCostCells = showCost ? '<td></td><td></td>' : '';
      const discountLabel = profitInfo.couponCode
        ? `Order discount <span class="admin-text-muted">(incl. code ${esc(profitInfo.couponCode)})</span>`
        : 'Order discount <span class="admin-text-muted">(volume / coupon / loyalty)</span>';
      const discountTip = `${formatPrice(profitInfo.orderDiscountInclGst)} incl-GST on the order row, `
        + `shown here ex-GST because revenue is. It is the aggregate of volume pricing, any coupon and any `
        + `loyalty redemption — the backend keeps no per-component column. `
        + `The customer's total was already net of it; this is the matching reduction on the revenue side.`;
      discountFootRows = `
      <tr class="admin-order-items__gross">
        <td colspan="5" class="admin-order-items__footlabel admin-text-muted">Line items${gstSub(GST_EXCL)}</td>
        <td class="mono admin-text-muted">${formatPrice(profitInfo.grossRevenueExGst)}</td>
        ${blankCostCells}
      </tr>
      <tr class="admin-order-items__discount">
        <td colspan="5" class="admin-order-items__footlabel"><span title="${esc(discountTip)}">${discountLabel} ⓘ</span></td>
        <td class="mono">−${formatPrice(profitInfo.orderDiscountExGst)}</td>
        ${blankCostCells}
      </tr>`;
    }
    itemsHtml += `</tbody><tfoot>${discountFootRows}<tr class="admin-order-items__total">
      <td colspan="5"${profitInfo.discountApplies ? ' class="admin-order-items__footlabel"' : ''}>${profitInfo.discountApplies ? `Revenue${gstSub(GST_EXCL)}` : ''}</td>
      <td class="mono"><strong>${formatPrice(profitInfo.totalRevenueExGst)}</strong></td>
      ${showCost ? `${costFoot}${profitFoot}` : ''}
    </tr></tfoot></table></div>`;
  } else {
    // No line items to render. Two very different reasons live here and must NOT look
    // alike (fail-soft must be LOUD): a genuinely item-less order vs. a detail fetch that
    // failed or returned empty while the order clearly HAS items. Use the count hints the
    // API carries on the list/detail row to tell them apart.
    const expectedCount = o.items_count ?? o.item_count ?? o.order_items?.length ?? null;
    if (detailLoadFailed || (expectedCount != null && expectedCount > 0)) {
      const n = expectedCount != null && expectedCount > 0 ? expectedCount : null;
      itemsHtml += `<div class="admin-empty" style="border:1px solid var(--danger-dim,#fecaca);background:var(--danger-dim,rgba(248,113,113,0.08));border-radius:8px;padding:16px;margin:12px 0">
        <div class="admin-empty__title" style="color:var(--danger,#dc2626)">Couldn't load this order's line items</div>
        <div class="admin-empty__text">${n != null ? `This order has ${n} item${n === 1 ? '' : 's'}, but none were returned` : 'The order detail didn’t load fully'} — the detail may have failed to load. Close and reopen the order, or check the backend if it persists.</div>
      </div>`;
    } else {
      itemsHtml += `<p class="admin-text-muted">${MISSING} No items</p>`;
    }
  }

  // Profit Breakdown rows (owner-only) — cash waterfall: the full incl-GST
  // amount the customer paid, every real payment out, take-home at the bottom.
  // Rendered into the top-right meta column (swapped with the order dates).
  const muted = (t) => `<span class="admin-text-muted" style="font-weight:400">${t}</span>`;
  let profitBreakdownInner = '';
  if (orderProfitBreakdown) {
    const b = orderProfitBreakdown;
    const neg = (v) => `−${formatPrice(Math.abs(v))}`;
    const pbRow = (label, value, valStyle = '') =>
      `<div class="om-meta-row"><span>${label}</span><span class="mono"${valStyle ? ` style="${valStyle}"` : ''}>${value}</span></div>`;
    profitBreakdownInner += `<div class="om-meta-addr-label">Profit breakdown</div>`;
    // THE ORDER DISCOUNT DOES NOT GET ITS OWN ROW HERE, AND MUST NOT (ERR-168).
    // This is a CASH waterfall: it starts from what the customer actually paid,
    // which the backend already computed net of the discount. Subtracting the
    // discount again would double-count it and stop Take-home footing. The
    // discount's real effect is on the REVENUE side — see the items-table foot,
    // where it is shown in full. Here it is a qualifier on the opening figure,
    // so an owner can see why the charge is below the line prices.
    const discountQualifier = profitInfo.discountApplies
      ? `<span title="${esc(`Volume pricing, coupon and loyalty combined. Already deducted from what the customer paid — `
          + `it is not subtracted again below. ${profitInfo.couponCode ? `Includes promo code ${profitInfo.couponCode}. ` : ''}`
          + `${profitInfo.loyaltyDiscountInclGst > 0 ? `Includes ${formatPrice(profitInfo.loyaltyDiscountInclGst)} of loyalty credit. ` : ''}`
          + `The matching revenue reduction is ${formatPrice(profitInfo.orderDiscountExGst)} ex-GST.`)}">`
        + muted(` after −${formatPrice(profitInfo.orderDiscountInclGst)} discount ⓘ`) + `</span>`
      : '';
    profitBreakdownInner += pbRow(`Customer paid ${muted('(incl. GST)')}${discountQualifier}`, formatPrice(b.customerPaidInclGst));
    profitBreakdownInner += pbRow(`Paid to supplier ${muted(`(incl. ${formatPrice(b.supplierCostGst)} GST)`)}`, neg(b.supplierCostInclGst));
    // An invoiced sale never touched a card processor. Rendering a "Paid to Stripe −$0.00"
    // row would imply a fee was charged and rounded away; the honest thing is to say
    // there wasn't one. (b.stripeFeeInclGst is exactly 0 here — see NO_PAYMENT_FEES.)
    if (isInvoiceOrder(o)) {
      profitBreakdownInner += pbRow(`Card fee ${muted('(bank transfer — none)')}`, formatPrice(0));
    } else {
      profitBreakdownInner += pbRow(`Paid to Stripe ${muted(`(2.65% + $0.30, incl. ${formatPrice(b.stripeFeeGst)} GST)`)}`, neg(b.stripeFeeInclGst));
    }
    // Absorbed courier (free-shipping order): a real cost we paid, shown incl-GST
    // like the lines above; its GST is netted at the IRD line below. Only when it applies.
    if (b.absorbedShippingApplies) {
      const zoneLabel = titleCaseZone(b.absorbedShippingZone);
      const delivery = b.absorbedShippingDeliveryType ? String(b.absorbedShippingDeliveryType) : 'urban';
      const courierTip = `Actual courier rate${zoneLabel ? ` for ${zoneLabel}` : ''} (${delivery} assumed). Free shipping — the customer paid $0, we absorbed this; its GST (${formatPrice(b.absorbedShippingGst)}) is reclaimed at the IRD line below.`;
      profitBreakdownInner += pbRow(
        `<span title="${esc(courierTip)}">Courier absorbed ${muted('(free shipping) ⓘ')}</span>`,
        neg(b.absorbedShippingInclGst));
    }
    const irdCreditSources = b.absorbedShippingApplies ? 'supplier, Stripe and courier' : 'supplier and Stripe';
    profitBreakdownInner += pbRow(
      `<span title="GST you collected from the customer (${formatPrice(b.gstCollected)}) minus the GST you already paid out to your ${irdCreditSources} — those are reclaimable, so only the remainder goes to IRD.">GST remitted to IRD ${muted('(after credits) ⓘ')}</span>`,
      neg(b.gstRemittedToIrd));
    profitBreakdownInner += `<div style="border-top:1px solid var(--border,#e5e7eb);margin:8px 0 6px"></div>`;
    profitBreakdownInner += pbRow('<strong>Take-home profit</strong>',
      `<strong>${formatPrice(b.netProfit)}</strong>`,
      'color:var(--success-text,#15803d)');
    profitBreakdownInner += pbRow(`Net margin ${muted('(take-home ÷ ex-GST revenue)')}`, `${b.netMarginPct.toFixed(1)}%`);
  }
  // An owner opened an order we cannot price. Saying nothing here would read as
  // "no profit data for this order type"; printing a partial waterfall would read
  // as the truth. Name the gap and what to do about it (ERR-122).
  let profitUnknownInner = '';
  if (showCost && !profitBreakdownInner && profitInfo.state === PROFIT_STATE.UNKNOWN) {
    const uncostedSkus = (o.items || [])
      .filter(it => it.supplier_cost_snapshot == null)
      .map(it => it.sku || it.product_sku)
      .filter(Boolean);
    const n = profitInfo.missingCostCount;
    // Same two-cause split as unknownFootTip above — never explain a refused
    // revenue figure as a missing supplier cost.
    const unknownBody = n > 0
      ? `${n} of ${profitInfo.itemCount} item${profitInfo.itemCount === 1 ? '' : 's'}
          ${n === 1 ? 'has' : 'have'} no recorded supplier cost, so take-home is
          <strong>unknown</strong> — not $0.
          ${uncostedSkus.length ? `Missing: <span class="mono">${esc(uncostedSkus.slice(0, 4).join(', '))}</span>${uncostedSkus.length > 4 ? ` +${uncostedSkus.length - 4} more` : ''}.` : ''}
          ${isInvoiceOrder(o)
            ? 'Set "Our Cost" on the invoice to fix it.'
            : 'Set the product’s cost price to fix it for future orders.'}`
      : profitInfo.discountExceedsRevenue
        ? `The order discount recorded on this order
          (<strong>${formatPrice(profitInfo.orderDiscountInclGst)}</strong> incl-GST) is at or above its entire
          line total${profitInfo.grossRevenueExGst ? ` (${formatPrice(profitInfo.grossRevenueExGst)} ex-GST)` : ''},
          so realised revenue can't be stated and take-home is <strong>unknown</strong> — not $0.
          Check <span class="mono">discount_amount</span> on the order row.`
        : `This order's revenue can't be stated, so take-home is <strong>unknown</strong> — not $0.`;
    profitUnknownInner = `
      <div class="om-meta-addr-label">Profit breakdown</div>
      <div class="om-profit-unknown">
        <div class="om-profit-unknown__title">Profit can't be computed</div>
        <div class="om-profit-unknown__text">
          ${unknownBody}
        </div>
      </div>`;
  }

  // Top-right meta column: Profit Breakdown for owners, order dates otherwise.
  const metaRight = profitBreakdownInner || profitUnknownInner || datesRows;
  const metaSection = `<div class="om-meta-grid${metaMiddle ? ' om-meta-grid--3col' : ''}"><div>${metaLeft}</div>${metaMiddle ? `<div>${metaMiddle}</div>` : ''}<div>${metaRight}</div></div>`;

  // Financial breakdown section (from order-breakdown endpoint)
  let breakdownHtml = '';
  if (breakdown) {
    breakdownHtml += `<div class="om-section-title">Financial Breakdown</div>`;
    breakdownHtml += `<div class="om-meta-grid">`;
    let bLeft = '';
    if (breakdown.subtotal_excl_gst != null) bLeft += omRow(`Subtotal${gstSub(GST_EXCL)}`, formatPrice(breakdown.subtotal_excl_gst));
    // Customer-money view of the same discount the profit math nets out (ERR-168).
    // Stated incl-GST here because every other row in this section is, and because
    // that is the figure on the order row. Sourced from the order, not the
    // breakdown endpoint, which carries no discount field.
    if (profitInfo.discountApplies) {
      const dLabel = profitInfo.couponCode
        ? `Discount <span class="admin-text-muted">(code ${esc(profitInfo.couponCode)})</span>`
        : 'Discount <span class="admin-text-muted">(volume / coupon / loyalty)</span>';
      bLeft += omRow(`${dLabel}${gstSub(GST_INCL)}`, `−${formatPrice(profitInfo.orderDiscountInclGst)}`);
    }
    if (breakdown.gst_amount != null) bLeft += omRow('GST (15%)', formatPrice(breakdown.gst_amount));
    if (breakdown.total_incl_gst != null) bLeft += omRow(`Total${gstSub(GST_INCL)}`, `<strong>${formatPrice(breakdown.total_incl_gst)}</strong>`);
    if (breakdown.shipping_fee != null) bLeft += omRow(`Shipping${gstSub(GST_INCL)}`, formatPrice(breakdown.shipping_fee));
    let bRight = '';
    if (breakdown.payment_method) {
      const pm = breakdown.payment_method;
      if (pm.type === 'card' || pm.card_brand) {
        bRight += omRow('Payment', `${esc(pm.card_brand || 'Card')} ****${esc(pm.last4 || '????')}`);
      } else if (pm.type === 'paypal' || pm.paypal_email) {
        bRight += omRow('Payment', `PayPal${pm.paypal_email ? ' — ' + esc(pm.paypal_email) : ''}`);
      } else {
        bRight += omRow('Payment', esc(pm.type || pm.method || 'Unknown'));
      }
    }
    if (breakdown.invoice_number) bRight += omRow('Invoice #', esc(breakdown.invoice_number));
    if (breakdown.receipt_url) bRight += omRow('Receipt', `<a href="${Security.escapeAttr(breakdown.receipt_url)}" target="_blank" rel="noopener" style="color:var(--cyan);text-decoration:underline">View Receipt</a>`);
    breakdownHtml += `<div>${bLeft}</div><div>${bRight}</div></div>`;
  }

  // Dates section — swapped with the Profit Breakdown. Owner-only here: when the
  // Profit Breakdown occupies the top-right meta column, the order dates move
  // down to their own section. Non-owners keep the dates in the meta grid.
  let datesHtml = '';
  if (metaRight !== datesRows) {
    datesHtml += `<div class="om-section-title">Dates</div>`;
    datesHtml += `<div style="max-width:440px">${datesRows}</div>`;
  }

  // Shipping Information — replaces the old read-only "Tracking" block, which
  // showed two of these four fields and offered no way to correct any of them.
  // It is rendered UNCONDITIONALLY: the section is where shipping details are
  // ENTERED, so hiding it until an order already had them meant the one order
  // that needed it was the one order without it.
  const shippingInfoHtml = buildShippingSection(o);

  // Timeline section (conditional)
  let timelineHtml = '';
  if (events === null) {
    // A HISTORY WE COULDN'T LOAD IS NOT AN EMPTY HISTORY.
    // AdminAPI.getOrderEvents returns null on failure and [] when the order
    // genuinely has no events; the old `events || []` at the call site collapsed
    // the two, so a failed load rendered as "this order has nothing recorded" —
    // indistinguishable from a clean one, and now load-bearing because the
    // invoice-send record lives in this list (ERR-063/068/073 family).
    timelineHtml += `<div class="om-section-title">Timeline</div>`;
    timelineHtml += `<div class="om-profit-unknown">
      <div class="om-profit-unknown__title">Couldn\u2019t load this order\u2019s history</div>
      <div class="om-profit-unknown__text">This is a read error, not proof that nothing
        happened \u2014 don\u2019t read it as an empty history. Reload to retry.</div>
    </div>`;
  } else if (events.length) {
    timelineHtml += `<div class="om-section-title">Timeline</div>`;
    timelineHtml += `<div class="admin-timeline">`;
    for (const ev of events) {
      const isSend = isInvoiceSendEvent(ev);
      const dotClass = isSend ? 'success'
        : ev.type === 'status_change' ? 'cyan'
        : (ev.type === 'refund_created' || ev.type === 'refund') ? 'magenta' : 'yellow';
      // An invoice send is stored as a `note` (the backend validates type against
      // exactly [note]), so the raw type would read "note" for the one entry an
      // owner is most likely to be looking for. Label it by what it IS.
      const label = isSend ? 'Invoice email sent' : (ev.type || 'Event');
      timelineHtml += `<div class="admin-timeline__item">
        <div class="admin-timeline__dot admin-timeline__dot--${dotClass}"></div>
        <div class="admin-timeline__time">${formatDateTime(ev.created_at)}</div>
        <div class="admin-timeline__text"><strong>${esc(label)}</strong>`;
      // The sentinel prefix is machine punctuation, not something to show a human.
      const noteText = isSend ? invoiceSendNoteText(ev) : (ev.payload?.note || '');
      if (noteText) timelineHtml += ` \u2014 ${esc(noteText)}`;
      if (ev.payload?.status) timelineHtml += ` \u2192 ${statusBadge(ev.payload.status)}`;
      timelineHtml += `</div></div>`;
    }
    timelineHtml += `</div>`;
  }

  // Actions — moved into header
  const btns = [
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="update-status">${icon('orders', 13, 13)} Update Status</button>`,
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="shipping-info" title="Jump to the carrier, tracking number and tracking link for this order">${icon('fulfillment', 13, 13)} Shipping</button>`,
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="add-note">${icon('dashboard', 13, 13)} Add Note</button>`,
    `<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="resend-invoice">${icon('mail', 13, 13)} Resend Invoice</button>`,
    `<button class="admin-btn admin-btn--danger admin-btn--sm" data-action="create-refund">${icon('refunds', 13, 13)} Refund</button>`,
  ];
  // Blocked orders keep a DISABLED button carrying the reason, rather than no
  // button at all. "Linked to an invoice / quick order" is the one refusal an
  // owner will actually meet, and hiding the control leaves that fact nowhere to
  // be stated on the very surface showing that order.
  if (right.deletable) {
    btns.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" style="color:var(--danger);border-color:var(--danger)" data-action="delete" title="${
      esc(right.method === DELETE_METHOD.PURGE
        ? 'Hard purge — permanent, cascades to line items / invoice links / loyalty / tracking, audit-logged first.'
        : 'Permanently delete this cancelled order.')
    }">${icon('trash', 13, 13)} ${esc(methodVerb(right.method))}</button>`);
  } else {
    btns.push(`<button class="admin-btn admin-btn--ghost admin-btn--sm" data-action="delete-blocked" disabled title="${
      esc(right.hint ? `${right.copy}\n${right.hint}` : right.copy)
    }">${icon('trash', 13, 13)} Delete</button>`);
  }
  modal.querySelector('#om-header-actions').innerHTML =
    `<div class="om-header-btns">${btns.join('')}</div>${statusBadge(o.status)}`;

  modal.querySelector('#om-content').innerHTML = [metaSection, itemsHtml, breakdownHtml, datesHtml, shippingInfoHtml, timelineHtml]
    .filter(Boolean).join('');

  bindModalActions(modal, o, right);
  // After the HTML is in the DOM: the section paints from the detail payload, then
  // upgrades itself with the carrier registry and the send history.
  bindShippingSection(o);
}

function bindModalActions(modal, order, deleteRight = null) {
  // Delegated, not bound to the button itself: a successful resend replaces the
  // [data-om-sent] cell's innerHTML, which would discard a direct listener.
  modal.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="om-sent-history"]')) return;
    openOrderSendHistory(order, _sentCache.get(order.id));
  });

  modal.querySelector('[data-action="update-status"]')?.addEventListener('click', () => showStatusModal(order));
  modal.querySelector('[data-action="shipping-info"]')?.addEventListener('click', () => focusShippingSection());
  modal.querySelector('[data-action="add-note"]')?.addEventListener('click', () => showNoteModal(order));
  modal.querySelector('[data-action="create-refund"]')?.addEventListener('click', () => showRefundModal(order));
  modal.querySelector('[data-action="resend-invoice"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!confirm(`Resend invoice email for ${order.order_number || order.id}?`)) return;
    btn.disabled = true;
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Sending\u2026';
    // ORDERING IS THE CONTRACT. The send happens first and alone; the record is
    // written only once it has RESOLVED. A stamp written next to the attempt
    // (or optimistically before it) would date an email that never left
    // — the same rule tests/admin-invoice-sent-indicator.test.js pins for the
    // Invoices page, and the reason this write sits outside the try below.
    let sent = false;
    try {
      await AdminAPI.resendInvoice(order.id);
      sent = true;
    } catch (err) {
      Toast.error(`Failed: ${err.message}`);
    }

    if (sent) {
      let recordedAt = null;
      try {
        recordedAt = await AdminAPI.recordInvoiceSend(order.id);
      } catch (err) {
        DebugLog.warn('[orders] invoice send recorded failed:', err?.message);
      }

      // Does the Invoice sent column even ask about this row? The Resend
      // button is deliberately NOT gated — resending a website customer their
      // receipt is a real thing an operator does, and it is what this endpoint
      // has always done. But that resend is a RECEIPT, not an operator invoice,
      // and writing it into this column is precisely the noise ERR-199 removed:
      // the handoff's own worked example has 20260827000003 correctly LOSING its
      // "28 Aug \u00d72", because those two sends were receipts. So the note is still
      // written (the timeline keeps the audit trail) and the column is left alone.
      const stillNotApplicable = (sentInfoWithoutLookup(
        lookupOrder(order.id) || order, orderSendRegime([lookupOrder(order.id) || order]),
      ) || {}).state === SENT_STATE.NOT_APPLICABLE;

      if (recordedAt && stillNotApplicable) {
        // Both facts, and neither dressed up: the email went out, and this column
        // is not where it shows up.
        Toast.success('Receipt email resent — recorded on this order\u2019s timeline. '
          + 'The Invoice sent column tracks operator invoices only, so it stays blank.');
      } else if (recordedAt) {
        Toast.success('Invoice email resent — recorded on this order.');
        // APPEND, NEVER REPLACE. Rebuilding the state from this one send alone
        // would reset the count to 1 on every resend — the column would say
        // "1 recorded send" immediately after the second one, and only a reload
        // would put it right. That is the one way this feature silently breaks
        // the number it exists to show.
        const prior = _sentCache.get(order.id);
        const info = resolveSentInfo({
          invoice: null,
          events: [
            { created_at: recordedAt, payload: { kind: INVOICE_SENT_KIND } },
            // The cache holds resolved {at, source} entries, not raw rows — map
            // them back to the event shape resolveSentInfo reads.
            ...(prior?.sends || []).map(sn => ({
              created_at: sn.at, payload: { kind: INVOICE_SENT_KIND },
            })),
          ],
          truncated: !!prior?.truncated,
          // A resend only ever happens on a row the question applies to.
          applicable: true,
        });
        // Carry the invoice number across: this rebuild has no invoice row of
        // its own, and dropping it would blank the tooltip until the next load.
        if (prior?.invoiceNumber) info.invoiceNumber = prior.invoiceNumber;
        _sentCache.set(order.id, info);
        const listRow = lookupOrder(order.id);
        if (listRow) patchSentCell(listRow, info);
        const dateCell = modal.querySelector('[data-om-sent]');
        if (dateCell) dateCell.innerHTML = modalSentValue(info);
      } else {
        // The email DID go out. Saying only "sent" while the column still reads
        // "Not recorded" would teach the owner to distrust the column; saying
        // "failed" would be a lie about the email. Both facts, one message.
        Toast.warning('Invoice email resent, but the send date could not be recorded '
          + '— this order may still read “Not recorded”.');
      }
    }

    btn.disabled = false;
    btn.innerHTML = originalText;
  });

  // Same vocabulary as the button that rendered it, so the two cannot disagree.
  const right = deleteRight || orderDeleteRight(order);
  if (right.deletable) {
    modal.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      // One-element plan through the shared copy, so a single purge carries the
      // very same irreversible / cascade / audit-log warnings as a bulk one.
      const groups = right.method === DELETE_METHOD.PURGE
        ? { purge: [order.id], delete: [], blocked: [] }
        : { purge: [], delete: [order.id], blocked: [] };
      if (!(await confirmDeletePlan(deletePlanCopy(groups)))) return;

      if (right.method === DELETE_METHOD.PURGE) {
        let res;
        try {
          res = await AdminAPI.purgeOrders([order.id]);
        } catch (e) {
          Toast.error(`Purge failed: ${purgeFailureCopy(e?.code, e?.message)}`);
          return;
        }
        forgetOrderCache(order.id);
        // A refusal arrives as a RESOLVED response (200 + failed[]). Treating
        // that as success is the easiest way to tell the owner an order is gone
        // when it is still there.
        if (res.failed.length > 0) {
          const f = res.failed[0];
          Toast.error(`Not purged: ${purgeFailureCopy(f.code, f.message)}`);
          loadOrders();
          return;   // modal stays open — the order still exists
        }
        if (res.unaccounted.length > 0) {
          Toast.warning(UNACCOUNTED_COPY);
          closeOrderModal();
          loadOrders();
          return;
        }
        Toast.success('Order purged');
        closeOrderModal();
        loadOrders();
        return;
      }

      try {
        await AdminAPI.deleteOrder(order.id);
        forgetOrderCache(order.id);
        Toast.success('Order deleted');
        closeOrderModal();
        loadOrders();
      } catch (e) {
        Toast.error(`Delete failed: ${purgeFailureCopy(e?.code, e?.message)}`);
      }
    });
  }
}

const ALL_STATUSES = ['pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled', 'refunded'];

function showStatusModal(order) {
  const current = (order.status || '').toLowerCase();
  const allowed = ALL_STATUSES.filter(s => s !== current);

  const canShip = allowed.includes('shipped');

  let bodyHtml = `
    <div class="admin-form-group">
      <label>New Status</label>
      <select class="admin-select" id="modal-status">
        ${allowed.map(s => `<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>
  `;

  if (canShip) {
    // The carrier list is SERVER-DRIVEN, exactly as it is in the Shipping
    // Information section. It used to be five hand-written <option>s here, which
    // meant this modal could not express NZ Couriers or Post Haste at all — and
    // that a carrier added to the backend registry appeared on one surface and
    // not the other. The <select> starts with the stored value only and is filled
    // once AdminAPI.getShippingCarriers() resolves.
    bodyHtml += `
      <div id="tracking-fields" style="display:none">
        <div class="admin-form-group">
          <label>Carrier *</label>
          <select class="admin-select" id="modal-carrier" disabled>
            <option value="">Loading carriers\u2026</option>
          </select>
          <div class="admin-form-error" id="modal-carrier-error" hidden></div>
        </div>
        <div class="admin-form-group">
          <label><span id="modal-tracking-label">Tracking Number</span> *</label>
          <input class="admin-input" id="modal-tracking" placeholder="Required for shipped status">
        </div>
        <div class="admin-form-group" id="modal-pcode-group" hidden>
          <label>Ticket product code *</label>
          <input class="admin-input" id="modal-pcode" maxlength="8" placeholder="e.g. LH">
          <div class="admin-form-help">The 2\u20134 character code beside the ticket number. Without it the track-and-trace link 404s.</div>
        </div>
        <div class="admin-form-group">
          <label>Tracking URL</label>
          <input class="admin-input" id="modal-url" placeholder="https://\u2026">
          <div class="admin-form-help" id="modal-url-help">Optional. Overrides the link built from the carrier and number.</div>
        </div>
        <div class="om-ship-issues" id="modal-ship-issues" hidden></div>
      </div>
    `;
  }

  const modal = Modal.open({
    title: 'Update Status',
    body: bodyHtml,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Update</button>
    `,
  });
  if (!modal) return;

  const statusSelect = modal.body.querySelector('#modal-status');
  const trackingFields = modal.body.querySelector('#tracking-fields');

  statusSelect.addEventListener('change', () => {
    if (trackingFields) trackingFields.style.display = statusSelect.value === 'shipped' ? '' : 'none';
  });
  statusSelect.dispatchEvent(new Event('change'));

  // Same registry, same flags, same "relabel don't branch" rule as the Shipping
  // Information section. `_statusCarriers` is only what this modal needs to send.
  const carrierSel = modal.body.querySelector('#modal-carrier');
  const pcodeGroup = modal.body.querySelector('#modal-pcode-group');
  const trackingLabel = modal.body.querySelector('#modal-tracking-label');
  const urlInput = modal.body.querySelector('#modal-url');
  const urlHelp = modal.body.querySelector('#modal-url-help');
  const issuesBox = modal.body.querySelector('#modal-ship-issues');
  let _statusCarriers = null;
  const applyStatusCarrier = () => {
    const c = carrierByCode(carrierSel?.value, _statusCarriers);
    if (trackingLabel) trackingLabel.textContent = numberLabel(null, c);
    if (pcodeGroup) pcodeGroup.hidden = !requiresProductCode(c);
    // DHL and Other publish no tracking link we can build, so the operator's
    // pasted URL is the ONLY thing that gives this customer a link. Marking an
    // order shipped for one of them without it emails a working-looking message
    // with nowhere to go — the exact failure this feature exists to prevent.
    if (urlHelp) {
      if (c && !buildsTrackingUrl(c)) {
        urlHelp.textContent = `${c.name} publishes no tracking link we can build, so this is the only way the customer gets one \u2014 paste the link ${c.name} gave you.`;
        urlHelp.classList.add('om-ship-help--loud');
        urlInput?.classList.add('om-ship-input--wanted');
      } else {
        urlHelp.textContent = 'Optional. Overrides the link built from the carrier and number.';
        urlHelp.classList.remove('om-ship-help--loud');
        urlInput?.classList.remove('om-ship-input--wanted');
      }
    }
  };

  /** The four inputs, in the shape utils/shipping-info.js expects. */
  const readStatusForm = () => ({
    carrierCode: carrierSel?.value || '',
    number: modal.body.querySelector('#modal-tracking')?.value || '',
    productCode: modal.body.querySelector('#modal-pcode')?.value || '',
    url: urlInput?.value || '',
  });

  const STATUS_FIELD_TO_ID = {
    carrier: '#modal-carrier', number: '#modal-tracking',
    productCode: '#modal-pcode', url: '#modal-url',
  };

  /**
   * Show what is wrong ON the fields, the same way the Shipping Information
   * section does — same module, same classes, same words. A `Toast.warning` that
   * vanishes and points at nothing was what stood here before.
   */
  const renderStatusIssues = (errors = [], warnings = []) => {
    if (!issuesBox) return;
    issuesBox.innerHTML = [...errors, ...warnings]
      .map((i, n) => `<div class="om-ship-issue om-ship-issue--${n < errors.length ? 'error' : 'warn'}">${esc(i.message)}</div>`)
      .join('');
    issuesBox.hidden = errors.length === 0 && warnings.length === 0;
    for (const sel of Object.values(STATUS_FIELD_TO_ID)) {
      modal.body.querySelector(sel)?.classList.remove('om-ship-input--bad');
    }
    for (const e of errors) modal.body.querySelector(STATUS_FIELD_TO_ID[e.field])?.classList.add('om-ship-input--bad');
  };
  if (canShip && carrierSel) {
    carrierSel.addEventListener('change', () => {
      applyStatusCarrier();
      // Prompt for a newly-required ticket code rather than refusing after Update.
      const { errors, warnings } = validateShipping(readStatusForm(), carrierByCode(carrierSel.value, _statusCarriers), {});
      renderStatusIssues(errors.filter(e => e.code !== 'UNKNOWN_CARRIER'), warnings);
    });
    modal.body.querySelector('#modal-tracking')?.addEventListener('blur', () => {
      const { warnings } = validateShipping(readStatusForm(), carrierByCode(carrierSel.value, _statusCarriers), {});
      renderStatusIssues([], warnings);
    });
    AdminAPI.getShippingCarriers().then((registry) => {
      _statusCarriers = registry;
      carrierSel.innerHTML = ['<option value="">Select carrier</option>']
        .concat(registry.map(c => `<option value="${Security.escapeAttr(c.code)}">${esc(c.name)}</option>`))
        .join('');
      carrierSel.disabled = false;
      applyStatusCarrier();
    }).catch((e) => {
      // No guessed list, and no silently-empty dropdown either: say why it is
      // empty and point at the section that can still do the job.
      const err = modal.body.querySelector('#modal-carrier-error');
      if (err) {
        err.hidden = false;
        err.textContent = `Couldn\u2019t load the carrier list \u2014 ${shippingErrorMessage(e)} You can still record the carrier in the Shipping Information section.`;
      }
      carrierSel.innerHTML = '<option value="">Carrier list unavailable</option>';
    });
  }

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const newStatus = statusSelect.value;
    const body = { status: newStatus };
    let shippingBody = null;

    if (newStatus === 'shipped') {
      const form = readStatusForm();
      const carrier = carrierByCode(form.carrierCode, _statusCarriers);

      // ONE REFUSAL VOCABULARY, NOT TWO.
      //
      // This used to hand-write its own checks — "tracking number required" and
      // "NZ Couriers needs a product code" — while the Shipping Information
      // section asked utils/shipping-info.js the same questions. Two copies of a
      // rule drift, and then one surface refuses what the other accepts. Going
      // through validateShipping() also brings the checks the new Tracking URL
      // field needs (an `http://` link is a backend 400) without writing a third
      // copy. `markShipped: true` is the intent: this save WILL flip the status,
      // so "nothing to track by" is an error here even though it is not on a
      // plain edit.
      const { ok, errors, warnings } = validateShipping(form, carrier, { markShipped: true });
      renderStatusIssues(errors, warnings);
      if (!ok) {
        const first = modal.body.querySelector(STATUS_FIELD_TO_ID[errors[0].field]);
        if (first) {
          first.scrollIntoView({ behavior: 'smooth', block: 'center' });
          first.focus({ preventScroll: true });
        }
        return;
      }
      // SHIP THROUGH THE SHIPPING ENDPOINT, not through `status`.
      //
      // The dropdown now holds registry CODES (`nz_couriers`), and only
      // PUT /orders/:id/shipping documents accepting either a code or a display
      // name and storing it canonically \u2014 the legacy status endpoint makes no
      // such promise, and would most likely store the slug itself as the carrier
      // name. It is also the only endpoint that knows `ticket_product_code` at
      // all. `mark_shipped` runs the SAME state machine (an invalid source status
      // is still a 400, a concurrent change still a 409) and still emails the
      // customer once on dispatch, so nothing about this modal's behaviour
      // changes except that NZ Couriers can now be expressed.
      // Built by the one encoder, not by hand. With a null baseline buildPayload
      // emits exactly the non-empty typed fields and omits the rest — which is
      // what the hand-built object was reaching for, and it cannot forget a field
      // the way that object forgot the tracking URL.
      shippingBody = buildPayload(null, form, { markShipped: true });
    }

    try {
      // Backend requires paid → processing → shipped; bridge automatically when needed
      if (newStatus === 'shipped' && current === 'paid') {
        await AdminAPI.updateOrderStatus(order.id, 'processing', { status: 'processing' });
      }
      if (shippingBody) {
        const data = await AdminAPI.updateOrderShipping(order.id, shippingBody);
        const note = describeEmailOutcome(data?.email);
        if (note) Toast.info(note);
      } else {
        await AdminAPI.updateOrderStatus(order.id, newStatus, body);
      }
      // Cancelling an order changes its Profit cell from a figure to "no profit
      // realised", so the cached answer is stale the moment the status moves.
      // It also flips DELETABILITY — a cancelled order becomes deletable for
      // every admin role — and the bulk bar may still be holding this id.
      forgetOrderCache(order.id);
      Toast.success(`Order updated to ${newStatus}`);
      Modal.close();
      closeOrderModal();
      loadOrders();
      // The transition to `shipped` is one of the five paths that clears an open
      // tracking request — and, per the backend hand-off, one of the two that
      // used not to. Ask the sidebar for a fresh count.
      refreshTrackingCount();
    } catch (e) {
      // The shipping endpoint answers with documented codes; `e.message` alone
      // would surface raw backend prose for a 409 or a missing product code.
      Toast.error(shippingBody ? shippingErrorMessage(e) : `Failed: ${e.message}`);
    }
  });
}

function showNoteModal(order) {
  const modal = Modal.open({
    title: 'Add Note',
    body: `
      <div class="admin-form-group">
        <label>Internal Note</label>
        <textarea class="admin-textarea" id="modal-note" placeholder="Type a note\u2026" rows="4"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--primary" data-action="save">Add Note</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const note = modal.body.querySelector('#modal-note').value.trim();
    if (!note) { Toast.warning('Note cannot be empty'); return; }
    try {
      await AdminAPI.addOrderNote(order.id, note);
      Toast.success('Note added');
      Modal.close();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
    }
  });
}

function showRefundModal(order) {
  const createdAt = new Date(order.created_at);
  const now = new Date();
  const minutesSinceCreation = (now - createdAt) / 60000;
  const canFullRefund = minutesSinceCreation <= 10;
  const total = order.total_amount ?? order.total ?? null;

  if (total == null || isNaN(total) || total <= 0) {
    Toast.error('Cannot create refund: order total is unavailable. Please reload the order.');
    return;
  }

  const modal = Modal.open({
    title: 'Create Refund',
    body: `
      <div class="admin-form-group">
        <label>Type</label>
        <select class="admin-select" id="refund-type">
          <option value="refund">Refund</option>
          <option value="chargeback">Chargeback</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Amount (NZD)</label>
        <input class="admin-input" type="number" step="0.01" min="0.01" id="refund-amount"
          max="${total}" value="${canFullRefund ? total : ''}"
          placeholder="${canFullRefund ? 'Full refund allowed' : 'Partial refund only'}">
        ${!canFullRefund ? '<div class="admin-form-help">Order is older than 10 minutes \u2014 partial refund only.</div>' : '<div class="admin-form-help">Full refund allowed (order within 10 min).</div>'}
      </div>
      <div class="admin-form-group">
        <label>Reason Code *</label>
        <select class="admin-select" id="refund-reason">
          <option value="">Select reason</option>
          <option value="damaged">Damaged in transit</option>
          <option value="wrong_item">Wrong item sent</option>
          <option value="not_received">Not received</option>
          <option value="defective">Defective product</option>
          <option value="customer_request">Customer request</option>
          <option value="duplicate">Duplicate order</option>
          <option value="fraud">Fraud / Unauthorized</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div class="admin-form-group">
        <label>Notes (optional)</label>
        <textarea class="admin-textarea" id="refund-note" rows="2" placeholder="Additional details\u2026"></textarea>
      </div>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" data-action="cancel">Cancel</button>
      <button class="admin-btn admin-btn--danger" data-action="submit">Create Refund</button>
    `,
  });
  if (!modal) return;

  modal.footer.querySelector('[data-action="cancel"]').addEventListener('click', () => Modal.close());
  modal.footer.querySelector('[data-action="submit"]').addEventListener('click', async () => {
    const type = modal.body.querySelector('#refund-type').value;
    const amount = parseFloat(modal.body.querySelector('#refund-amount').value);
    const reasonCode = modal.body.querySelector('#refund-reason').value;
    const reasonNote = modal.body.querySelector('#refund-note').value.trim();

    if (!amount || amount <= 0) { Toast.warning('Enter a valid amount'); return; }
    if (amount > total) { Toast.warning('Amount cannot exceed order total.'); return; }
    if (!canFullRefund && amount >= total) {
      Toast.warning('Full refund not allowed after 10 minutes. Use partial refund.');
      return;
    }
    if (!reasonCode) { Toast.warning('Reason code is required'); return; }

    const btn = modal.footer.querySelector('[data-action="submit"]');
    btn.disabled = true;
    btn.textContent = 'Processing\u2026';
    try {
      await AdminAPI.createRefund(order.id, { type, amount, reasonCode, reasonNote });
      Toast.success(`${type === 'chargeback' ? 'Chargeback' : 'Refund'} created for ${formatPrice(amount)}`);
      Modal.close();
      closeOrderModal();
      loadOrders();
    } catch (e) {
      Toast.error(`Failed: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Create Refund';
    }
  });
}

// ---- Create Order Drawer ----

function openCreateOrderDrawer() {
  const drawer = Drawer.open({ title: 'New Order', width: '600px' });
  if (!drawer) return;

  const formHtml = `
    <form id="create-order-form" novalidate>
      <div class="admin-form-group">
        <label>Customer Name *</label>
        <input class="admin-input" type="text" name="customer_name" placeholder="Full name" required>
      </div>
      <div class="admin-form-group">
        <label>Customer Email *</label>
        <input class="admin-input" type="email" name="customer_email" placeholder="email@example.com" required>
      </div>
      <div class="admin-form-group">
        <label>Status</label>
        <select class="admin-select" name="status">
          <option value="pending">Pending (Invoice sent)</option>
          <option value="paid">Paid (Already paid)</option>
        </select>
      </div>

      <div class="admin-detail-block__title" style="margin:16px 0 8px">Line Items</div>
      <div id="line-items">
        <div class="create-order-item" style="display:grid;grid-template-columns:1fr 64px 96px 32px;gap:8px;align-items:start;margin-bottom:8px">
          <input class="admin-input" type="text" name="description" placeholder="Description *" required>
          <input class="admin-input" type="number" name="qty" placeholder="Qty" min="1" value="1" style="text-align:center">
          <input class="admin-input" type="number" name="unit_price" placeholder="Price" min="0" step="0.01">
          <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm remove-item-btn" style="display:none;padding:6px" title="Remove">${icon('close', 12, 12)}</button>
        </div>
      </div>
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm" id="add-item-btn" style="margin-bottom:16px">+ Add Item</button>

      <div class="admin-form-group">
        <label>Notes <span style="color:var(--text-muted);font-weight:400">(optional)</span></label>
        <textarea class="admin-textarea" name="notes" rows="3" placeholder="Internal notes\u2026"></textarea>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px">
        <button type="button" class="admin-btn admin-btn--ghost" id="cancel-order-btn">Cancel</button>
        <button type="submit" class="admin-btn admin-btn--primary" id="submit-order-btn">Create Order</button>
      </div>
    </form>
  `;
  drawer.setBody(formHtml);

  const body = drawer.body;

  function updateRemoveButtons() {
    const rows = body.querySelectorAll('.create-order-item');
    rows.forEach(row => {
      const btn = row.querySelector('.remove-item-btn');
      if (btn) btn.style.display = rows.length > 1 ? '' : 'none';
    });
  }

  function addItemRow() {
    const row = document.createElement('div');
    row.className = 'create-order-item';
    row.style.cssText = 'display:grid;grid-template-columns:1fr 64px 96px 32px;gap:8px;align-items:start;margin-bottom:8px';
    row.innerHTML = `
      <input class="admin-input" type="text" name="description" placeholder="Description *" required>
      <input class="admin-input" type="number" name="qty" placeholder="Qty" min="1" value="1" style="text-align:center">
      <input class="admin-input" type="number" name="unit_price" placeholder="Price" min="0" step="0.01">
      <button type="button" class="admin-btn admin-btn--ghost admin-btn--sm remove-item-btn" style="padding:6px" title="Remove">${icon('close', 12, 12)}</button>
    `;
    row.querySelector('.remove-item-btn').addEventListener('click', () => {
      row.remove();
      updateRemoveButtons();
    });
    body.querySelector('#line-items').appendChild(row);
    updateRemoveButtons();
  }

  body.querySelector('.remove-item-btn').addEventListener('click', function () {
    this.closest('.create-order-item').remove();
    updateRemoveButtons();
  });

  body.querySelector('#add-item-btn').addEventListener('click', addItemRow);
  body.querySelector('#cancel-order-btn').addEventListener('click', () => Drawer.close());

  body.querySelector('#create-order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const customerName = form.querySelector('[name="customer_name"]').value.trim();
    const customerEmail = form.querySelector('[name="customer_email"]').value.trim();
    const status = form.querySelector('[name="status"]').value;
    const notes = form.querySelector('[name="notes"]').value.trim();

    const itemRows = body.querySelectorAll('.create-order-item');
    const items = [];
    for (const row of itemRows) {
      const description = row.querySelector('[name="description"]').value.trim();
      const qty = parseInt(row.querySelector('[name="qty"]').value, 10) || 1;
      const unit_price = parseFloat(row.querySelector('[name="unit_price"]').value);
      if (!description || isNaN(unit_price) || unit_price <= 0) continue;
      items.push({ description, qty, unit_price });
    }

    if (!customerName) { Toast.warning('Customer name is required'); return; }
    if (!customerEmail) { Toast.warning('Customer email is required'); return; }
    if (!items.length) { Toast.warning('Add at least one item with a description and price'); return; }

    const submitBtn = body.querySelector('#submit-order-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating\u2026';

    try {
      await AdminAPI.createOrder({
        customer_name: customerName,
        customer_email: customerEmail,
        status,
        source: 'manual',
        items,
        notes: notes || undefined,
      });
      Toast.success('Order created');
      Drawer.close();
      loadOrders();
    } catch (e) {
      Toast.error(e.message || 'Failed to create order');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Order';
    }
  });
}

async function handleExport(format = 'csv') {
  try {
    Toast.info(`Preparing ${format.toUpperCase()} export\u2026`);
    await AdminAPI.exportData('orders', format, FilterState.getParams());
    Toast.success('Orders exported');
  } catch (e) {
    Toast.error(`Export failed: ${e.message}`);
  }
}

// ---- Tab: Orders (renders the orders table) ----
async function renderOrdersTab(container) {
  // Header
  const header = document.createElement('div');
  header.className = 'admin-page-header';
  // The placeholder promises exactly what the backend delivers: customer name and
  // order number, both verified case-insensitive substring matches that compose with
  // the Status chip (npm run probe:orders-search). It deliberately does NOT say
  // "email" — that returns zero rows for every address on this endpoint.
  header.innerHTML = `
    <h1>Orders</h1>
    <div class="admin-page-header__actions">
      <div class="admin-search">
        <span class="admin-search__icon">${icon('search', 14, 14)}</span>
        <input class="admin-input" type="search" id="order-search"
               placeholder="Search customer name or order #…"
               autocomplete="off" aria-label="Search orders by customer name or order number"
               value="${Security.escapeAttr(_search)}">
      </div>
      <button class="admin-btn admin-btn--primary" id="create-order-btn">${icon('plus', 14, 14)} New Order</button>
      ${exportDropdown('export-orders')}
    </div>
  `;
  container.appendChild(header);

  const tableContainer = document.createElement('div');
  container.appendChild(tableContainer);

  _table = new DataTable(tableContainer, {
    // Profit is owner-only, same gate as the modal's Cost/Profit columns. A
    // non-owner never sees the column AND never triggers the detail fan-out.
    columns: AdminAuth.isOwner() ? COLUMNS : COLUMNS.filter(c => c.key !== '_profit'),
    rowKey: 'id',
    selectable: true,
    onSelectionChange: (sel) => updateBulkBar(sel),
    onRowClick: (row) => openOrderModal(row),
    onSort: (key, dir) => { _sort = key; _sortDir = dir; _page = 1; loadOrders(); },
    onPageChange: (page) => { _page = page; loadOrders(); },
    emptyMessage: 'No orders found',
    emptyIcon: icon('orders', 40, 40),
  });

  tableContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="quick-status"]');
    if (!btn) return;
    e.stopPropagation();
    const orderId = btn.dataset.orderId;
    const order = (_table.data || []).find(r => r.id === orderId);
    if (order) showStatusModal(order);
  });

  // The Invoice sent cell opens its send history. DataTable's row-click guard
  // already skips `closest('button, a, input')` (components/table.js:235), so
  // this cannot also open the order behind it — but stopPropagation keeps that
  // true even if the guard ever changes.
  tableContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="sent-history"]');
    if (!btn) return;
    e.stopPropagation();
    const orderId = btn.dataset.orderSent;
    const order = (_table.data || []).find(r => String(r.id) === String(orderId));
    if (order) openOrderSendHistory(order, _sentCache.get(order.id));
  });

  // 300ms matches every other server-side admin search (Customers, Products,
  // Invoices, Quick Order). Each settled keystroke is a fresh server query — the
  // table is paged 20-at-a-time, so filtering _table.data in memory would search
  // 20-of-N rows while looking like it searched all of them.
  const searchInput = header.querySelector('#order-search');
  searchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    const value = searchInput.value;
    _searchDebounce = setTimeout(() => {
      _searchDebounce = null;
      const next = value.trim();
      if (next === _search) return;
      _search = next;
      _page = 1;
      writeHashParams({ q: _search });
      loadOrders();
    }, 300);
  });

  header.querySelector('#create-order-btn').addEventListener('click', openCreateOrderDrawer);
  bindExportDropdown(header, 'export-orders', handleExport);

  await loadOrders();
}

function destroyOrdersTab() {
  // A keystroke still sitting in the debounce would fire loadOrders() after the
  // table is gone — cancel it here, not just in destroy(), because switching to
  // the Refunds tab tears the table down while the page itself stays mounted.
  clearTimeout(_searchDebounce);
  _searchDebounce = null;
  // Cancel any in-flight profit fetches — that is precisely what AdminAPI.getOrder
  // takes a signal for. Leaving them running would spend the 60/min limiter on a
  // page the admin has already left.
  _profitAbort?.abort();
  _profitAbort = null;
  _profitCache.clear();
  _sentAbort?.abort();
  _sentAbort = null;
  _sentCache.clear();
  // _seenOrders now caches a PERMISSION answer, computed for this admin's role.
  // Keeping it for the lifetime of the session is both a leak and a staleness
  // hazard; _table.destroy() has already discarded the selection it served.
  _seenOrders.clear();
  _deleteInFlight = false;
  if (_table) _table.destroy();
  _table = null;
  if (_activeModal) closeOrderModal();
  if (_bulkBar) { _bulkBar.remove(); _bulkBar = null; }
}

// ---- Tab switching ----
async function switchTab(tab) {
  if (tab === _activeTab) return;

  // Destroy current sub-tab
  if (_activeTab === 'orders') destroyOrdersTab();
  if (_subTabModule?.destroy) _subTabModule.destroy();
  _subTabModule = null;

  _activeTab = tab;

  // Update tab bar UI
  _container.querySelectorAll('.admin-tab[data-order-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.orderTab === tab);
  });

  const content = _container.querySelector('#orders-tab-content');
  content.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:20vh">
    <div class="admin-loading__spinner"></div>
  </div>`;

  if (tab === 'orders') {
    content.innerHTML = '';
    await renderOrdersTab(content);
  } else if (tab === 'refunds') {
    try {
      const mod = await import('./refunds.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Refunds</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  } else if (tab === 'compliance') {
    try {
      const mod = await import('./cc-compliance.js');
      _subTabModule = mod.default;
      content.innerHTML = '';
      await _subTabModule.init(content);
    } catch (e) {
      content.innerHTML = `<div class="admin-empty"><div class="admin-empty__title">Failed to load Compliance</div><div class="admin-empty__text">${esc(e.message)}</div></div>`;
    }
  }
}

export default {
  title: 'Orders',

  async init(container) {
    _container = container;
    _page = 1;
    _activeTab = 'orders';
    _subTabModule = null;

    // Deep-link: #orders?focus=<order_number> seeds the search and auto-opens
    // the order drawer. The Tracking Requests page routes here so an admin can
    // add a tracking number (which auto-fulfils the request + emails the customer).
    // `focus` wins over `q`: it is a one-shot deep-link that also auto-opens the
    // drawer. Either way _search now reaches the visible input below — before this
    // page had a search box, a focus= arrival silently showed a one-row list with
    // nothing on screen explaining why it was filtered.
    const focusOrder = getHashParam('focus');
    if (focusOrder) _search = focusOrder;
    else _search = getHashParam('q') || '';

    FilterState.setVisibleFilters(['statuses']);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'admin-tabs';
    tabBar.innerHTML = `
      <button class="admin-tab active" data-order-tab="orders">Orders</button>
      <button class="admin-tab" data-order-tab="refunds">Refunds</button>
      ${AdminAuth.isOwner() ? '<button class="admin-tab" data-order-tab="compliance">Compliance</button>' : ''}
    `;
    container.appendChild(tabBar);

    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-order-tab]');
      if (btn) switchTab(btn.dataset.orderTab);
    });

    // Tab content area
    const content = document.createElement('div');
    content.id = 'orders-tab-content';
    container.appendChild(content);

    await renderOrdersTab(content);

    // After the (search-seeded) list loads, auto-open the focused order so the
    // admin lands directly on the tracking field.
    if (focusOrder) await focusOnOrder(focusOrder);
  },

  destroy() {
    FilterState.setVisibleFilters(null);
    if (_activeTab === 'orders') destroyOrdersTab();
    if (_subTabModule?.destroy) _subTabModule.destroy();
    _subTabModule = null;
    _container = null;
    clearTimeout(_searchDebounce);
    _searchDebounce = null;
    _search = '';
    _page = 1;
    _activeTab = 'orders';
  },

  async onFilterChange() {
    _page = 1;
    if (_activeTab === 'orders' && _table) {
      await loadOrders();
    } else if (_subTabModule?.onFilterChange) {
      _subTabModule.onFilterChange();
    }
  },

  onSearch(query) {
    // Drop any keystroke still in flight — otherwise it lands 300ms later and
    // silently replaces the query we were just asked to run.
    clearTimeout(_searchDebounce);
    _searchDebounce = null;
    _search = query;
    _page = 1;
    if (_activeTab === 'orders') {
      const input = document.getElementById('order-search');
      if (input && input.value !== query) input.value = query;
      if (_table) loadOrders();
    } else if (_subTabModule?.onSearch) {
      _subTabModule.onSearch(query);
    }
  },
};
