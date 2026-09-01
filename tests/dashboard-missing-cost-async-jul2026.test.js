/**
 * ERR-121 — dashboard first paint was gated behind the missing-cost scan
 * ======================================================================
 *
 * `computeMissingCostAlert` fans out up to 1 order-list page + 120 `GET /orders/{id}`
 * detail calls, in serialized batches of 6 — roughly 20+ sequential round-trips. It was
 * `await`ed between "all 13 parallel chart calls have settled" and "anything is on screen",
 * so the ENTIRE dashboard (the full-width Performance overview most visibly) waited seconds
 * for one alert card's data.
 *
 * The scan now runs off the critical path and patches only its own card. That trades a
 * latency bug for an honesty hazard, because the card gains two states that are NOT results:
 * still-running, and failed. Both must read as UNKNOWN. Rendering either as `0` reproduces
 * ERR-074 — the card printing "all sales are costed" off the back of a scan that never ran,
 * sending the owner hunting for a problem the dashboard just told them does not exist.
 *
 * Contracts pinned here:
 *
 *   1. ASYNC — `render(payload)` is not awaited on the scan; the scan is kicked off after it.
 *   2. PENDING — a pending scan renders the fourth card in an explicit not-yet-known state,
 *      never a zero and never "all clear" copy.
 *   3. FAILED — likewise for a failed scan, and it must say UNKNOWN out loud.
 *   4. NO REGRESSION — settled scans (culprits / clean / degraded) render exactly as before.
 *   5. ABORT ≠ CLEAN — an aborted scan returns a failure marker, not `count: 0`. An aborted
 *      fetch yields an empty order list, which is indistinguishable from "no orders here".
 *   6. SCANNED IS HONEST — `scanned` counts what was actually inspected, not the budget size.
 *
 * Run with: node --test tests/dashboard-missing-cost-async-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD = path.resolve(
  __dirname, '..', 'inkcartridges', 'js', 'admin', 'pages', 'dashboard.js'
);
const src = fs.readFileSync(DASHBOARD, 'utf8');

/** Same brace-matching lifter used by tests/dashboard-profit-recovery.test.js. */
function lift(name) {
  const re = new RegExp(`(?:^|\\n)(?:const\\s+${name}\\s*=|(?:async\\s+)?function\\s+${name}\\s*\\()`);
  const m = src.match(re);
  assert.ok(m, `${name} not found in dashboard.js — renamed?`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = src.indexOf('{', src.indexOf(name, start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const end = src.indexOf(';', i) === i + 1 ? i + 2 : i + 1;
        return src.slice(start, end);
      }
    }
  }
  throw new Error(`unbalanced braces lifting ${name}`);
}

// ─── 1. ASYNC: the scan is off the critical path ────────────────────────────

test('render() is never awaited on the missing-cost scan', () => {
  assert.equal(
    /await\s+computeMissingCostAlert\s*\(/.test(src), false,
    'computeMissingCostAlert is awaited again — first paint is back behind ~20 serial round-trips',
  );
});

test('the scan is kicked off AFTER the payload is rendered', () => {
  const render = src.indexOf('\n  render(payload);');
  const scan = src.indexOf('startMissingCostScan(');
  assert.ok(render > 0, 'render(payload) call not found');
  assert.ok(scan > render, 'startMissingCostScan must be called after render(payload)');
});

test('the scan result is patched into the alerts mount, not the whole page', () => {
  // Re-rendering everything would tear down and rebuild all 18 Chart.js instances for one card.
  assert.ok(/ALERTS_MOUNT_ID/.test(src), 'ALERTS_MOUNT_ID missing');
  assert.ok(
    /mount\.innerHTML\s*=\s*renderAlertsSection\(/.test(src),
    'applyMissingCost must repaint only the alerts mount',
  );
});

// ─── The alerts panel, with its collaborators stubbed ───────────────────────

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

vm.runInContext(`
  const ALERT_PREVIEW = 5;
  const LOW_MARGIN_PCT = 10;
  const ZERO_SEARCH_MIN = 5;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rangeLabel = () => 'all time';
  const rowN = (label, accent, cards) => cards.join('');
  const computeTrackingAlert  = () => ({ count: 0, items: [] });
  const computeZeroSearchAlert = () => ({ count: 0, items: [] });
  const computeLowMarginAlert  = () => ({ count: 0, items: [], grain: 'sku', capped: false });
  let recoverProfitFromSeries = () => null;
  globalThis.setRecovered = (fn) => { recoverProfitFromSeries = fn; };
`, ctx, { filename: 'stubs.js' });

vm.runInContext(
  [lift('alertCard'), lift('renderAlertsSection')].join('\n\n')
  + '\n;globalThis.renderAlertsSection = renderAlertsSection;',
  ctx,
  { filename: 'dashboard-lifted.js' },
);
const { renderAlertsSection } = sandbox;

/** Count the alert cards in the rendered fragment. */
const cardCount = (html) => (html.match(/admin-alert-card__count/g) || []).length;
/** Text of the 4th card (the missing-cost slot), or '' when it isn't rendered. */
const fourthCard = (html) => {
  const parts = html.split('admin-dash__cell--');
  return parts.length >= 5 ? parts[4] : '';
};

// Profit IS present, so the "degraded" branch can never fire — this isolates the scan state.
const HEALTHY_KPIS = { current: { gross_profit: 512.40, net_profit: 300.10 } };

// ─── 2. PENDING ─────────────────────────────────────────────────────────────

test('a pending scan renders a fourth card in an explicit unknown state', () => {
  const html = renderAlertsSection({ kpis: HEALTHY_KPIS, missingCost: { pending: true } });
  assert.equal(cardCount(html), 4, 'the missing-cost slot must still render while pending');
  const card = fourthCard(html);
  assert.match(card, /Sales missing a cost/);
  assert.match(card, /—/, 'pending count must be an em-dash, not a number');
  assert.match(card, /checking/i, 'pending card must say it is still checking');
});

test('a pending scan NEVER renders as zero or as an all-clear', () => {
  const card = fourthCard(renderAlertsSection({ kpis: HEALTHY_KPIS, missingCost: { pending: true } }));
  assert.equal(/admin-alert-card__count">0</.test(card), false, 'pending rendered as a hard 0');
  assert.equal(/All sales are costed/i.test(card), false, 'pending rendered as an all-clear');
  assert.equal(/are costed/i.test(card), false, 'pending rendered as an all-clear');
});

// ─── 3. FAILED ──────────────────────────────────────────────────────────────

test('a failed scan says UNKNOWN out loud and is not a zero', () => {
  const card = fourthCard(renderAlertsSection({ kpis: HEALTHY_KPIS, missingCost: { failed: true } }));
  assert.match(card, /Sales missing a cost/);
  assert.match(card, /UNKNOWN/, 'a failed scan must name the unknown explicitly');
  assert.match(card, /not a zero/i, 'a failed scan must disclaim the zero reading');
  assert.equal(/admin-alert-card__count">0</.test(card), false);
  assert.equal(/are costed/i.test(card), false);
});

test('a null/absent scan result is treated as unknown, never as clean', () => {
  // applyMissingCost maps a null resolution to { failed: true }; belt-and-braces at render too.
  for (const missingCost of [null, undefined]) {
    const html = renderAlertsSection({ kpis: HEALTHY_KPIS, missingCost });
    assert.equal(/All sales are costed/i.test(html), false, `missingCost=${missingCost} read as all-clear`);
  }
});

// ─── 4. NO REGRESSION on settled scans ──────────────────────────────────────

test('a settled scan with culprits renders the actionable card unchanged', () => {
  const html = renderAlertsSection({
    kpis: HEALTHY_KPIS,
    missingCost: {
      count: 2, scanned: 59, incomplete: false,
      items: [
        { label: 'INV-1042 · $289.50', badge: 'no cost: G-HP-963XL-INK', badgeCls: 'admin-badge--failed', href: 'invoices' },
        { label: 'ORD-2213 · $74.90', badge: 'no items recorded', badgeCls: 'admin-badge--failed', href: 'orders' },
      ],
    },
  });
  assert.equal(cardCount(html), 4);
  const card = fourthCard(html);
  assert.match(card, /admin-alert-card__count">2</);
  assert.match(card, /no cost: G-HP-963XL-INK/);
  assert.match(card, /admin-alert-card--danger/);
});

test('a settled clean scan with healthy profit renders only three cards', () => {
  const html = renderAlertsSection({
    kpis: HEALTHY_KPIS,
    missingCost: { count: 0, items: [], scanned: 59, incomplete: false },
  });
  assert.equal(cardCount(html), 3, 'nothing to action → the fourth card stays away');
});

test('a settled clean scan with blank profit still names the backend defect (ERR-074)', () => {
  sandbox.setRecovered(() => null);
  const html = renderAlertsSection({
    kpis: { current: { gross_profit: null } },
    missingCost: { count: 0, items: [], scanned: 59, incomplete: false },
  });
  const card = fourthCard(html);
  assert.match(card, /Profit unavailable/);
  assert.match(card, /kpi-summary defect/, 'must blame the backend, not invent a data problem');
  assert.match(card, /all 59 sales/, 'must report how far the scan actually got');
});

test('a truncated settled scan is never reported as a clean bill of health', () => {
  sandbox.setRecovered(() => null);
  const card = fourthCard(renderAlertsSection({
    kpis: { current: { gross_profit: null } },
    missingCost: { count: 0, items: [], scanned: 120, incomplete: true },
  }));
  assert.match(card, /couldn’t check every sale/);
  assert.match(card, /120 scanned/);
});

test('a PENDING scan never reaches the "Profit unavailable" branch', () => {
  // The degraded branch means "we looked and found nothing" — it requires a settled scan.
  sandbox.setRecovered(() => null);
  const card = fourthCard(renderAlertsSection({
    kpis: { current: { gross_profit: null } },
    missingCost: { pending: true },
  }));
  assert.equal(/Profit unavailable/.test(card), false, 'claimed a clean scan before the scan finished');
  assert.match(card, /checking/i);
});

// ─── 5 & 6. computeMissingCostAlert: abort and scanned-count honesty ────────

function makeScanCtx({ orders, detail, abortAfter = Infinity }) {
  const box = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, Promise, isNaN };
  // The alert label routes through orderRef() → OrderNumber (ERR-198), so the
  // sandbox needs the real vocabulary. Required, not stubbed: a hand-written
  // stand-in here would let the label drift from what the dashboard prints.
  box.window = { OrderNumber: require(path.join(__dirname, '..', 'inkcartridges', 'js', 'utils.js')).OrderNumber };
  box.globalThis = box;
  const c = vm.createContext(box);
  let detailCalls = 0;
  const signal = { aborted: false };
  vm.runInContext(`
    const MISSING_COST_DETAIL_CAP = 120;
    const MISSING_COST_PAGE = 100;
    const MISSING_COST_MAX_PAGES = 3;
    const MISSING_COST_BATCH = 6;
    const formatPrice = (n) => '$' + Number(n).toFixed(2);
    const isInvoiceOrder = (o) => /^INV-/i.test(String(o.order_number || ''));
    const firstArray = (o, keys) => {
      for (const k of keys) if (Array.isArray(o && o[k])) return o[k];
      return [];
    };
  `, c, { filename: 'scan-stubs.js' });
  box.AdminAPI = {
    getOrders: async (_f, page) => (page === 1 ? { orders, pagination: { total: orders.length, total_pages: 1 } } : { orders: [] }),
    getOrder: async () => {
      detailCalls++;
      if (detailCalls >= abortAfter) signal.aborted = true;   // aborted DURING the Nth call
      return detail;
    },
  };
  // orderRef is lifted from the real source too — one source of truth, so the
  // label the test judges is byte-for-byte the one the dashboard renders.
  vm.runInContext(lift('orderRef') + '\n' + lift('computeMissingCostAlert') + '\n;globalThis.computeMissingCostAlert = computeMissingCostAlert;', c, { filename: 'scan.js' });
  return { run: box.computeMissingCostAlert, signal, calls: () => detailCalls };
}

test('an aborted scan returns a failure marker, not count:0', async () => {
  // An aborted getOrders resolves to null → an empty list, which is indistinguishable from
  // "this range has no orders". Reporting that as 0 is the ERR-074 conflation.
  const { run, signal } = makeScanCtx({ orders: [], detail: null });
  signal.aborted = true;
  const out = await run({ from: null, to: null }, null, signal);
  assert.equal(out.failed, true, 'aborted scan must be marked failed');
  assert.equal(out.count, undefined, 'aborted scan must not report a count');
});

test('an empty range that was genuinely scanned still reports a clean zero', async () => {
  const { run, signal } = makeScanCtx({ orders: [], detail: null });
  const out = await run({ from: null, to: null }, null, signal);
  assert.equal(out.count, 0);
  assert.equal(out.incomplete, false);
  assert.equal(out.failed, undefined);
});

test('scanned counts what was inspected, not the budget size', async () => {
  const orders = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, order_number: `ORD-${i}`, status: 'paid', total_amount: 10 }));
  // Abort after the first batch of 6 → the loop breaks before the remaining 14.
  const { run, signal } = makeScanCtx({ orders, detail: { items: [{ sku: 'X', supplier_cost_snapshot: 1 }] }, abortAfter: 6 });
  const out = await run({ from: null, to: null }, null, signal);
  assert.equal(out.scanned, 6, 'scanned must reflect the batches actually completed');
  assert.equal(out.incomplete, true, 'a broken-off scan must flag itself incomplete');
  assert.ok(out.scanned < orders.length);
});

test('a complete scan reports the full scanned count and finds real culprits', async () => {
  const orders = Array.from({ length: 3 }, (_, i) => ({ id: `o${i}`, order_number: `INV-${i}`, status: 'invoiced', total_amount: 10 }));
  const { run, signal } = makeScanCtx({ orders, detail: { items: [{ sku: 'G-HP-963XL-INK', supplier_cost_snapshot: null }] } });
  const out = await run({ from: null, to: null }, null, signal);
  assert.equal(out.scanned, 3);
  assert.equal(out.count, 3);
  assert.equal(out.incomplete, false);
  assert.match(out.items[0].badge, /no cost: G-HP-963XL-INK/);
  assert.equal(out.items[0].href, 'invoices', 'invoiced sales route to the invoice editor');
});

test('cancelled orders stay excluded from the scan', async () => {
  const orders = [
    { id: 'a', order_number: 'ORD-1', status: 'cancelled', total_amount: 99 },
    { id: 'b', order_number: 'ORD-2', status: 'shipped', total_amount: 99 },
  ];
  const { run, signal, calls } = makeScanCtx({ orders, detail: { items: [{ sku: 'X', supplier_cost_snapshot: 1 }] } });
  const out = await run({ from: null, to: null }, null, signal);
  assert.equal(calls(), 1, 'only the non-cancelled order should be detail-checked');
  assert.equal(out.scanned, 1);
});
