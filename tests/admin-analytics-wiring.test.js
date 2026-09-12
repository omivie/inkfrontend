/**
 * admin-analytics-wiring.test.js — resilient analytics fetch layer
 * ================================================================
 *
 * Pins the Jun-2026 ERR-010 permanent fix: the admin dashboard's headline
 * analytics route through the backend's service-role HTTP wrappers
 * (/api/admin/analytics/*).
 *
 * Why this exists: the direct RPCs (analytics_kpi_summary, …) depended on a
 * `GRANT EXECUTE TO authenticated` that backend redeploys kept dropping, so
 * they intermittently 403'd ("permission denied for function") and the
 * dashboard silently blanked. Verified live 2026-06-04: analytics_customer_stats
 * was 403 while the HTTP /kpi-summary returned a healthy { current, previous }.
 *
 * ── THE RPC FALLBACK IS GONE (ERR-247, 2026-09-12) ─────────────────────────
 *
 * Two tests here used to assert that each method DROPS TO THE DIRECT RPC when
 * HTTP comes back empty. They were right for fifteen months and they are wrong
 * now, because the arm they pinned can no longer return anything: the grant was
 * revoked ON PURPOSE on 2026-09-07 after a plain customer account read the live
 * P&L out of PostgREST, and the backend has asked us never to restore it.
 * Measured 2026-09-12 with an owner JWT and each function's REAL named params
 * (an empty `{}` answers 404 PGRST202 and proves nothing):
 *
 *     POST /rest/v1/rpc/analytics_kpi_summary      403  42501
 *     POST /rest/v1/rpc/analytics_brand_breakdown  403  42501
 *     POST /rest/v1/rpc/get_suppliers              403  42501
 *     GET  /api/admin/analytics/<all seven>        200  with data
 *
 * So the two tests are INVERTED rather than deleted, and they now pin the
 * stronger property: the RPC transport is not merely unused, it is unreachable
 * from these methods. Deleting them would have left nothing standing guard over
 * a `return rpc(...)` line creeping back in the next time someone sees a blank
 * chart — which is exactly how ERR-010/029/035/232 kept recurring.
 *
 * Removing a fallback is a behaviour change, not cleanup (ERR-158). What the
 * dead arm still contributed was the FACT of a failure, and `rpc()` was
 * swallowing even that into `null`. §9 below pins the replacement: the reason
 * is recorded by name, so a blank panel can say why.
 *
 * These tests assert:
 *   1. analyticsQuery maps FilterState params → date_from/brand_filter/…
 *   2. normalizeKpiSummary handles BOTH the live { current, previous } shape
 *      and the spec-doc metric-keyed shape, and preserves `fallback`.
 *   3. adaptCustomerSummary folds /summary/customers → { current, previous }.
 *   4. getDashboardKPIs uses HTTP and has NO RPC arm left (ERR-247).
 *   5. getCustomerStats fills New Customers from /summary/customers when the
 *      RPC's grant is dropped (returning % honestly stays absent).
 *   6. getTopProducts always returns an array (tolerating { products: [...] }).
 *   9. every failure is named, not swallowed into a bare null.
 *
 * Run with: node --test tests/admin-analytics-wiring.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyticsQuery,
  normalizeKpiSummary,
  adaptCustomerSummary,
  AdminAPI,
} from '../inkcartridges/js/admin/api.js';
import { refundAmount } from '../inkcartridges/js/admin/utils/trend-math.js';

// ---- global stubs (admin/api.js reads these at call-time only) ----
function installGlobals({ apiGet, fetchImpl } = {}) {
  globalThis.window = {
    API: { get: apiGet || (async () => null) },
    Auth: { session: { access_token: 'test-jwt' } },
  };
  globalThis.Config = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_ANON_KEY: 'anon-key',
  };
  globalThis.DebugLog = { warn() {}, log() {}, error() {} };
  if (fetchImpl) globalThis.fetch = fetchImpl;
}

// A fake fetch Response good enough for the rpc() helper in admin/api.js.
function fakeResponse({ ok = true, status = 200, body = '' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    async text() { return text; },
    async json() { return text ? JSON.parse(text) : {}; },
  };
}

const params = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.set(k, v);
  return p;
};

// =====================================================================
// 1. analyticsQuery
// =====================================================================
test('analyticsQuery maps from/to → date_from/date_to', () => {
  const qs = analyticsQuery(params({ from: '2026-05-05', to: '2026-06-04' }));
  const out = new URLSearchParams(qs);
  assert.equal(out.get('date_from'), '2026-05-05');
  assert.equal(out.get('date_to'), '2026-06-04');
});

test('analyticsQuery maps brands/suppliers/statuses → *_filter', () => {
  const qs = analyticsQuery(params({
    from: '2026-05-05', to: '2026-06-04',
    brands: 'HP,Canon', suppliers: 'acme', statuses: 'paid',
  }));
  const out = new URLSearchParams(qs);
  assert.equal(out.get('brand_filter'), 'HP,Canon');
  assert.equal(out.get('supplier_filter'), 'acme');
  assert.equal(out.get('status_filter'), 'paid');
});

test('analyticsQuery appends extra params (e.g. result_limit)', () => {
  const qs = analyticsQuery(params({ from: '2026-05-05', to: '2026-06-04' }), { result_limit: 10 });
  assert.equal(new URLSearchParams(qs).get('result_limit'), '10');
});

test('analyticsQuery omits absent optional filters', () => {
  const qs = analyticsQuery(params({ from: '2026-05-05', to: '2026-06-04' }));
  const out = new URLSearchParams(qs);
  assert.equal(out.has('brand_filter'), false);
  assert.equal(out.has('supplier_filter'), false);
});

test('analyticsQuery accepts a plain object too', () => {
  const qs = analyticsQuery({ from: '2026-01-01', to: '2026-01-31' });
  assert.equal(new URLSearchParams(qs).get('date_from'), '2026-01-01');
});

// =====================================================================
// 2. normalizeKpiSummary
// =====================================================================
test('normalizeKpiSummary passes through the live { current, previous } shape', () => {
  const live = { current: { revenue: 933.81, orders: 9, gross_profit: 332.78 }, previous: { revenue: 1216.99 } };
  const out = normalizeKpiSummary(live);
  assert.equal(out, live); // identity — no copy needed
  assert.equal(out.current.revenue, 933.81);
});

test('normalizeKpiSummary preserves a fallback flag on the live shape', () => {
  const out = normalizeKpiSummary({ current: { revenue: 1 }, previous: {}, fallback: true });
  assert.equal(out.fallback, true);
});

test('normalizeKpiSummary folds the spec-doc metric-keyed shape', () => {
  const doc = {
    revenue: { current: 100, previous: 80, change_percent: 25 },
    gross_profit: { current: 40, previous: 30 },
    new_customers: 7,
    returning_rate: 33,
    fallback: true,
  };
  const out = normalizeKpiSummary(doc);
  assert.equal(out.current.revenue, 100);
  assert.equal(out.previous.revenue, 80);
  assert.equal(out.current.gross_profit, 40);
  assert.equal(out.current.new_customers, 7);
  assert.equal(out.current.returning_rate, 33);
  assert.equal(out.fallback, true);
});

test('🚨 normalizeKpiSummary carries supplier_freight through the metric-keyed branch', () => {
  // THE PATH THAT DROPS A KEY IS THE PATH TAKEN WHEN THE BACKEND IS DEGRADED.
  //
  // This branch only runs on the metric-keyed shape, and per the backend's
  // response §2 that is exactly what their kpi-summary RPC-error FALLBACK
  // returns. Its `net_profit` already has freight deducted server-side, so
  // losing the freight key here renders a net profit with nothing to explain it
  // and makes dashboard.js's rebuild over-state net by the whole freight bill —
  // $502.64 over the last 30 live days (ERR-255).
  //
  // The live payload uses {current, previous} and returns before this branch,
  // so this cannot be exercised against production. That is why it is pinned
  // here rather than in the probe.
  const fallbackShape = {
    revenue: { current: 10278.23, previous: 7967.75 },
    gross_profit: { current: 2210.76, previous: 2013.85 },
    net_profit: { current: -56.06, previous: 308.24 },
    stripe_fees: { current: 170.68, previous: 172.76 },
    supplier_freight: { current: 502.64, previous: 381.77 },
    supplier_freight_incl_gst: { current: 578, previous: 439 },
    supplier_freight_unpriced_orders: { current: 0, previous: 0 },
    fallback: true,
  };
  const out = normalizeKpiSummary(fallbackShape);
  assert.equal(out.current.supplier_freight, 502.64, 'freight must survive the allow-list');
  assert.equal(out.previous.supplier_freight, 381.77);
  assert.equal(out.current.supplier_freight_incl_gst, 578);
  assert.equal(out.current.supplier_freight_unpriced_orders, 0);

  // The identity the tiles rest on must reconcile on the normalised output, or
  // the Net Profit tile and its own inputs disagree.
  const c = out.current;
  assert.ok(Math.abs((c.gross_profit - c.net_profit) - (c.stripe_fees + c.supplier_freight + 1593.50)) < 0.01,
    'gross − net = stripe + freight + opex');
});

test('normalizeKpiSummary returns null for junk / empty', () => {
  assert.equal(normalizeKpiSummary(null), null);
  assert.equal(normalizeKpiSummary({}), null);
  assert.equal(normalizeKpiSummary([]), null);
  assert.equal(normalizeKpiSummary({ rows: [], fallback: true }), null); // the empty customer-stats shape
});

// =====================================================================
// 3. adaptCustomerSummary
// =====================================================================
test('adaptCustomerSummary folds /summary/customers into current/previous', () => {
  const out = adaptCustomerSummary({
    total_customers: 13, new_customers_30d: 2, avg_ltv: 552.79, churn_rate: 61.5, nps_score: 0,
  });
  assert.equal(out.current.new_customers, 2);
  assert.equal(out.current.total_customers, 13);
  assert.equal(out._summaryFallback, true);
  // returning_pct must be absent — there is no source for it here.
  assert.equal('returning_pct' in out.current, false);
});

test('adaptCustomerSummary returns null when there is nothing to adapt', () => {
  assert.equal(adaptCustomerSummary(null), null);
  assert.equal(adaptCustomerSummary({}), null);
});

// =====================================================================
// 4. getDashboardKPIs — HTTP primary, RPC fallback
// =====================================================================
test('getDashboardKPIs uses the HTTP wrapper when it is healthy', async () => {
  const calls = [];
  installGlobals({
    apiGet: async (path) => {
      calls.push(path);
      return { ok: true, data: { current: { revenue: 933.81, orders: 9 }, previous: { revenue: 1216.99 } } };
    },
    fetchImpl: async () => { throw new Error('RPC should not be called'); },
  });
  const out = await AdminAPI.getDashboardKPIs(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(out.current.revenue, 933.81);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/admin\/analytics\/kpi-summary\?/);
  assert.match(calls[0], /date_from=2026-05-05/);
});

test('getDashboardKPIs NEVER reaches for the RPC — the arm is gone (ERR-247)', async () => {
  // Inverted from "falls back to the direct RPC when HTTP is empty". The stub
  // below would serve a healthy { current: { revenue: 42 } } over raw fetch —
  // i.e. it is a POSITIVE CONTROL for the old behaviour. If any RPC arm ever
  // comes back, this test fails with 42 instead of null, which names the
  // regression precisely rather than just going red.
  let rpcHits = 0;
  installGlobals({
    apiGet: async () => ({ ok: true, data: { rows: [], fallback: true } }), // no current → unusable
    fetchImpl: async () => { rpcHits += 1; return fakeResponse({ body: { current: { revenue: 42 }, previous: {} } }); },
  });
  const out = await AdminAPI.getDashboardKPIs(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(rpcHits, 0, 'no raw fetch may be made — the browser does not call these RPCs any more');
  assert.notEqual(out?.current?.revenue, 42, 'a 42 here means the RPC fallback is back');
  assert.equal(out, null, 'an unusable HTTP payload is null, and the reason is in analyticsHealthSnapshot()');
});

test('getDashboardKPIs returns null when both sources are down', async () => {
  installGlobals({
    apiGet: async () => { throw new Error('backend down'); },
    fetchImpl: async () => fakeResponse({ ok: false, status: 403, body: { message: 'permission denied' } }),
  });
  const out = await AdminAPI.getDashboardKPIs(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(out, null);
});

// =====================================================================
// 5. getCustomerStats — RPC down → /summary/customers fallback
// =====================================================================
test('getCustomerStats reconstructs New Customers from /summary/customers when the RPC 403s', async () => {
  const httpCalls = [];
  installGlobals({
    apiGet: async (path) => {
      httpCalls.push(path);
      if (path.includes('/summary/customers')) {
        return { ok: true, data: { total_customers: 13, new_customers_30d: 2, avg_ltv: 552.79, churn_rate: 61.5, nps_score: 0 } };
      }
      return null;
    },
    // RPC denied — the live ERR-010 symptom.
    fetchImpl: async () => fakeResponse({ ok: false, status: 403, body: { message: 'permission denied for function analytics_customer_stats' } }),
  });
  const out = await AdminAPI.getCustomerStats(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(out.current.new_customers, 2);
  assert.equal(out._summaryFallback, true);
  assert.ok(httpCalls.some(p => p.includes('/summary/customers')));
});

test('getCustomerStats reads the ROUTE, never the RPC, even for returning_pct', async () => {
  // Inverted from "prefers the RPC when its grant is intact". Its grant is not
  // intact and will not be: analytics_customer_stats was locked to the service
  // role long before its five siblings. `returning_pct` is the field that only
  // this endpoint carries, so asserting it comes back over HTTP is what proves
  // the route is a full replacement rather than a partial one — the tile stays
  // honest ("—") only when the data genuinely is not there.
  let rpcHits = 0;
  installGlobals({
    apiGet: async (path) => {
      assert.match(path, /\/customer-stats\?/);
      return { ok: true, data: { current: { new_customers: 5, returning_pct: 40 }, previous: {} } };
    },
    fetchImpl: async () => { rpcHits += 1; throw new Error('no RPC may be attempted'); },
  });
  const out = await AdminAPI.getCustomerStats(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(rpcHits, 0, 'the RPC transport must not be touched');
  assert.equal(out.current.new_customers, 5);
  assert.equal(out.current.returning_pct, 40);
  assert.equal(out._summaryFallback, undefined, '/summary/customers is only for when the route cannot answer');
});

// =====================================================================
// 6. getTopProducts — always an array
// =====================================================================
test('getTopProducts returns the bare array shape verbatim', async () => {
  installGlobals({
    apiGet: async () => ({ ok: true, data: [{ product_name: 'X', product_sku: 'GX', revenue: 10, units_sold: 1 }] }),
  });
  const out = await AdminAPI.getTopProducts(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.ok(Array.isArray(out));
  assert.equal(out[0].product_sku, 'GX');
});

test('getTopProducts unwraps a { products: [...] } envelope to the array', async () => {
  installGlobals({
    apiGet: async () => ({ ok: true, data: { products: [{ product_name: 'Y' }] } }),
  });
  const out = await AdminAPI.getTopProducts(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.ok(Array.isArray(out));
  assert.equal(out[0].product_name, 'Y');
});

// =====================================================================
// 7. getRevenueSeries / getRefundAnalytics — HTTP primary
// =====================================================================
test('getRevenueSeries returns the HTTP { series } payload', async () => {
  installGlobals({
    apiGet: async (path) => {
      assert.match(path, /\/revenue-series\?/);
      return { ok: true, data: { series: [{ date: '2026-05-08', revenue: 22.95, orders: 1 }] } };
    },
    fetchImpl: async () => { throw new Error('RPC should not be called'); },
  });
  const out = await AdminAPI.getRevenueSeries(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.equal(out.series[0].revenue, 22.95);
});

test('getRefundAnalytics returns the HTTP { series } payload', async () => {
  installGlobals({
    apiGet: async (path) => {
      assert.match(path, /\/refunds-series\?/);
      return { ok: true, data: { series: [{ date: '2026-05-08', refund_count: 0, total_amount: 0 }] } };
    },
    fetchImpl: async () => { throw new Error('RPC should not be called'); },
  });
  const out = await AdminAPI.getRefundAnalytics(params({ from: '2026-05-05', to: '2026-06-04' }));
  assert.ok(Array.isArray(out.series));
});

// =====================================================================
// 8. refundAmount — reads the refunds-series `total_amount` field
// =====================================================================
test('refundAmount reads total_amount (the refunds-series field)', () => {
  assert.equal(refundAmount({ date: '2026-05-08', refund_count: 1, total_orders: 1, total_amount: 12.5 }), 12.5);
});

test('refundAmount falls back to legacy amount/total/value keys', () => {
  assert.equal(refundAmount({ amount: 5 }), 5);
  assert.equal(refundAmount({ total: 7 }), 7);
  assert.equal(refundAmount({ value: 9 }), 9);
  assert.equal(refundAmount({ refund_amount: 3 }), 3);
});

test('refundAmount prefers total_amount over legacy keys and is 0-safe', () => {
  assert.equal(refundAmount({ total_amount: 4, amount: 99 }), 4);
  assert.equal(refundAmount({ total_amount: 0 }), 0); // explicit zero, not "missing"
  assert.equal(refundAmount({}), 0);
  assert.equal(refundAmount({ total_amount: 'oops' }), 0);
});
