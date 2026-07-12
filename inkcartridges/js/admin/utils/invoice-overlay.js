/**
 * Invoiced sales overlay — TEMPORARY, self-retiring.
 * =================================================
 *
 * WHY THIS EXISTS
 * Invoices are real sales: phone, walk-in and B2B customers who never touched
 * the website. But analytics is computed entirely server-side, and the backend
 * does not yet know invoices exist — so the Dashboard's revenue is website-only
 * and understates the business. The durable fix is backend-side (a saved invoice
 * materialises an orders row; see ~/Desktop/invoice-sales-integration-backend-
 * spec.md). Until that ships, this adds invoiced sales to the SCALAR KPIs client
 * side so the headline numbers are true today.
 *
 * WHY THIS IS NOT THE THING WE DELETED
 * Commit a4de671 removed all frontend aggregation because a parallel client-side
 * truth drifted from the backend's. The rails that keep this different:
 *
 *   1. ONE FILE. Aggregation lives here; the pages call it and label a tile.
 *   2. SCALAR KPIs ONLY. No time series, no charts, no top-SKU lists, no
 *      forecast — those stay 100% backend. Client-side series merging is exactly
 *      the sprawl that was killed, and it is not worth re-creating.
 *   3. SELF-RETIRING. backendCountsInvoices() below. The day the backend starts
 *      including invoices it returns includes_invoices:true, this refuses to run,
 *      and double-counting becomes structurally impossible — no coordinated
 *      deploy, no flag to remember to flip.
 *   4. ALL-OR-NOTHING. If we can't see every invoice, we overlay nothing. A
 *      partial number is worse than no number.
 *   5. NEVER SILENT. Overlaid tiles say so.
 *
 * HOW TO DELETE IT (please do)
 * Once the backend ships: remove this file, its three call sites (dashboard.js,
 * financial-health.js, expenses.js) and tests/admin-invoice-overlay.test.js. It
 * was built to be a deletion, not a migration.
 */
import { AdminAPI } from '../app.js';
import { normalizeInvoice, countsForAnalytics } from './invoice-math.js';

// Kill switch. Set false to fall straight back to backend-only numbers.
export const INVOICE_OVERLAY_ENABLED = true;

// If we'd have to page past this many invoices, we're not confident we've seen
// them all — bail rather than overlay a partial total.
const MAX_INVOICES = 1000;
const PAGE_SIZE = 100;
// The list endpoint is unlikely to carry line items, so COGS needs a per-invoice
// fetch. Keep the fan-out gentle: the admin API rate-limits at 60/min.
const DETAIL_CONCURRENCY = 3;

const warn = (m, e) => window.DebugLog?.warn?.(`[InvoiceOverlay] ${m}`, e?.message || e);

/**
 * Has the backend started counting invoices itself?
 *
 * THE SAFETY INTERLOCK. The backend spec REQUIRES kpi-summary / pnl /
 * dashboard-bundle to return includes_invoices:true once they fold invoices in.
 * The moment they do, every overlay switches itself off. If the backend ships
 * without that flag, this overlay keeps adding on top of numbers that already
 * include invoices and the revenue doubles — which is why the flag is stated as
 * non-negotiable in the spec.
 */
export function backendCountsInvoices(resp) {
  if (!resp || typeof resp !== 'object') return false;
  const probes = [resp, resp.current, resp.totals, resp.meta];
  return probes.some((o) => o && (
    o.includes_invoices === true
    || o.invoice_revenue != null
    || o.invoice_orders != null
  ));
}

const inRange = (isoDate, from, to) => {
  if (!isoDate) return false;
  if (from && isoDate < from) return false;
  if (to && isoDate > to) return false;
  return true;
};

const listRows = (resp) => {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp;
  return resp.invoices || resp.data || resp.items || resp.rows || [];
};

/** Page the whole invoice list. Returns null if there are more than we'll trust. */
async function fetchAllInvoices() {
  const out = [];
  for (let page = 1; ; page++) {
    const resp = await AdminAPI.listInvoices({}, page, PAGE_SIZE);
    if (resp == null) return null;              // read failed → fail soft, no overlay
    const rows = listRows(resp);
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;         // last page
    if (out.length >= MAX_INVOICES) {
      warn(`more than ${MAX_INVOICES} invoices — refusing to overlay a partial total`);
      return null;
    }
  }
  return out;
}

/**
 * Fill in line items for invoices whose list row doesn't carry them (COGS needs
 * them). Best-effort with a small concurrency cap: an invoice we can't detail
 * simply keeps its unknown cost, which poisons the profit overlay to null — the
 * honest outcome, not a silent zero.
 */
async function withLineItems(rows) {
  const needs = rows.filter((r) => !(r.line_items || r.lines));
  let i = 0;
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, needs.length) }, async () => {
    while (i < needs.length) {
      const r = needs[i++];
      try {
        const full = await AdminAPI.getInvoice(r.id);
        if (full) Object.assign(r, full);
      } catch (err) {
        warn(`could not detail invoice ${r.id}`, err);
      }
    }
  });
  await Promise.all(workers);
  return rows;
}

/**
 * Every invoice that should count as a sale, normalized and detailed, or null if
 * we can't be sure we've seen them all.
 *
 * Fetch ONCE, aggregate many times — the P&L needs a current AND a previous
 * window, and re-listing the whole invoice table per window would be silly.
 */
export async function fetchCountableInvoices() {
  if (!INVOICE_OVERLAY_ENABLED) return null;
  try {
    const raw = await fetchAllInvoices();
    if (raw == null) return null;
    // void → never; built-from-an-order → never (that order is ALREADY counted;
    // this is the double-count guard). Unpaid DOES count: accrual basis.
    const counted = raw.filter((r) => countsForAnalytics(r));
    if (!counted.length) return [];
    await withLineItems(counted);      // COGS needs line items the list omits
    return counted.map((r) => normalizeInvoice(r));
  } catch (err) {
    warn('could not read invoices — showing backend numbers untouched', err);
    return null;
  }
}

/**
 * Aggregate pre-fetched invoices over a date window.
 *
 *   revenueInclGst  — add to kpi-summary.revenue, which is INCL-GST
 *                     ("Total sales (incl. GST)" per its own tooltip; and
 *                     revenue ÷ orders reconciles with the AOV tile).
 *   revenueExGst    — add to pnl.revenue, which is EX-GST (it feeds a gross-profit
 *                     row). Two fields on purpose: adding the wrong one to the
 *                     wrong surface is a silent 15% error that looks plausible.
 *   cogsExGst / grossProfit / netProfit
 *                   — NULL unless EVERY counted invoice in the window has a known
 *                     cost on every line. A partial COGS overstates profit, and an
 *                     overstated profit is worse than an absent one. Today, before
 *                     any operator has typed a cost, this is null by design:
 *                     revenue and order count overlay; profit honestly does not.
 *   costsKnown      — false ⇒ the caller must leave the profit figures alone.
 */
export function aggregateInvoices(rows, { from = null, to = null } = {}) {
  if (!rows) return null;
  const inWindow = rows.filter((n) => inRange(n.date, from, to));
  const sum = (f) => inWindow.reduce((s, n) => s + (Number(f(n)) || 0), 0);
  const costsKnown = inWindow.every((n) => n.allCostsKnown);
  // Bank transfer: no card fee, so gross and net profit are the same figure here.
  // The gap between them on a website order IS the Stripe fee.
  const profit = costsKnown ? sum((n) => n.profit) : null;
  return {
    revenueInclGst: sum((n) => n.totalInclGst),
    revenueExGst: sum((n) => n.revenueExGst + n.freightExGst),
    cogsExGst: costsKnown ? sum((n) => n.costExGst) : null,
    grossProfit: profit,
    netProfit: profit,
    orders: inWindow.length,
    units: sum((n) => n.units),
    count: inWindow.length,
    costsKnown,
  };
}

/** One-shot convenience for a single window (the Dashboard's case). */
export async function fetchInvoiceDelta({ from = null, to = null } = {}) {
  const rows = await fetchCountableInvoices();
  return rows == null ? null : aggregateInvoices(rows, { from, to });
}

/** "+ 3 invoiced sales (client-side, pending backend)" — for a tile tooltip. */
export function overlayNote(delta) {
  if (!delta || !delta.count) return '';
  return ` Includes ${delta.count} invoiced sale${delta.count === 1 ? '' : 's'} added client-side, pending backend support.`;
}
